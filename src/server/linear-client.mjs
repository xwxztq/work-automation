import https from "node:https"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const API_URL = new URL("https://api.linear.app/graphql")
const require = createRequire(import.meta.url)
const { HttpsProxyAgent } = require(
  fileURLToPath(
    new URL("../../node_modules/.pnpm/node_modules/https-proxy-agent/dist/index.js", import.meta.url),
  ),
)

export function createLinearClient(apiKey) {
  async function graphql(query, variables = {}) {
    const text = await postGraphql({
      apiKey,
      body: { query, variables },
    })
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error(`Linear 返回了非 JSON 响应: ${text}`)
    }
    if (payload.errors?.some((error) => error.extensions?.http?.status >= 400)) {
      const status = payload.errors[0]?.extensions?.http?.status || 500
      throw new Error(`Linear HTTP ${status}: ${JSON.stringify(payload)}`)
    }
    if (payload.errors?.length) {
      const messages = payload.errors.map((error) => {
        const path = error.path ? ` 位置 ${error.path.join(".")}` : ""
        return `${error.message}${path}`
      })
      throw new Error(`Linear GraphQL 错误: ${messages.join("; ")}`)
    }
    return payload.data
  }

  async function listProjects(first = 100) {
    const query = `
      query Projects($first: Int!, $after: String) {
        projects(first: $first, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            name
            url
            teams {
              nodes {
                id
                key
                name
              }
            }
          }
        }
      }
    `
    const nodes = []
    let after = null

    do {
      const data = await graphql(query, { first, after })
      nodes.push(...(data.projects?.nodes || []))
      after = data.projects?.pageInfo?.hasNextPage
        ? data.projects.pageInfo.endCursor
        : null
    } while (after)

    const projects = nodes.map((project) => {
      const teamNames = (project.teams?.nodes || [])
        .map((team) => team.name)
        .filter(Boolean)
      return {
        id: project.id,
        name: project.name,
        displayName: teamNames.length
          ? `${project.name} · ${teamNames.join(", ")}`
          : project.name,
        url: project.url || null,
        teamNames,
      }
    })
    projects.sort((a, b) =>
      `${a.displayName} ${a.id}`.localeCompare(`${b.displayName} ${b.id}`),
    )
    return projects
  }

  async function listProjectIssues(projectId, first = 100) {
    const query = `
      query ProjectIssues($projectId: String!, $first: Int!) {
        project(id: $projectId) {
          id
          name
          url
          issues(first: $first, includeArchived: false) {
            nodes {
              id
              identifier
              title
              description
              url
              priority
              priorityLabel
              createdAt
              updatedAt
              state { id name type }
              team { id key name }
              project { id name }
              assignee { name email }
              labels { nodes { id name } }
              comments(first: 50) {
                nodes {
                  id
                  body
                  createdAt
                  updatedAt
                  user { name email }
                }
              }
            }
          }
        }
      }
    `
    const data = await graphql(query, { projectId, first })
    if (!data.project) {
      throw new Error(`未找到 Linear 项目: ${projectId}`)
    }
    return {
      project: data.project,
      issues: data.project.issues.nodes.map(normalizeIssue),
    }
  }

  async function getIssue(issueId) {
    const query = `
      query Issue($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          url
          priority
          priorityLabel
          createdAt
          updatedAt
          state { id name type }
          team { id key name }
          project { id name }
          assignee { name email }
          labels { nodes { id name } }
          comments(first: 80) {
            nodes {
              id
              body
              createdAt
              updatedAt
              user { name email }
            }
          }
        }
      }
    `
    const data = await graphql(query, { id: issueId })
    if (!data.issue) {
      throw new Error(`未找到 Linear 事项: ${issueId}`)
    }
    return normalizeIssue(data.issue)
  }

  async function getWorkflowStateId(teamId, name) {
    const query = `
      query WorkflowStates($teamId: ID!) {
        workflowStates(first: 100, filter: { team: { id: { eq: $teamId } } }) {
          nodes { id name type }
        }
      }
    `
    const data = await graphql(query, { teamId })
    const match = data.workflowStates.nodes.find((state) => state.name === name)
    if (!match) {
      throw new Error(`未找到团队 ${teamId} 的工作流状态: ${name}`)
    }
    return match.id
  }

  async function updateIssueState(issue, stateName) {
    const stateId = await getWorkflowStateId(issue.team.id, stateName)
    const mutation = `
      mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue { id identifier state { id name } }
        }
      }
    `
    const data = await graphql(mutation, { id: issue.id, input: { stateId } })
    if (!data.issueUpdate.success) {
      throw new Error(`无法将 ${issue.identifier} 移动到 ${stateName}`)
    }
    return data.issueUpdate.issue
  }

  async function createComment(issue, body) {
    const mutation = `
      mutation CommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
          comment { id createdAt }
        }
      }
    `
    const data = await graphql(mutation, { input: { issueId: issue.id, body } })
    if (!data.commentCreate.success) {
      throw new Error(`无法评论 ${issue.identifier}`)
    }
    return data.commentCreate.comment
  }

  return {
    graphql,
    listProjects,
    listProjectIssues,
    getIssue,
    updateIssueState,
    createComment,
  }
}

function postGraphql({ apiKey, body }) {
  const payload = JSON.stringify(body)
  const proxy = getProxyUrl()
  const agent = proxy ? new HttpsProxyAgent(proxy) : undefined

  return new Promise((resolve, reject) => {
    const request = https.request(
      API_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: apiKey,
        },
        agent,
      },
      (response) => {
        const chunks = []
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        response.on("end", () => {
          resolve(Buffer.concat(chunks).toString("utf8"))
        })
      },
    )
    request.setTimeout(30000, () => {
      request.destroy(new Error("请求超时"))
    })
    request.on("error", (error) => reject(explainLinearFetchError(error)))
    request.write(payload)
    request.end()
  })
}

function getProxyUrl() {
  return [
    process.env.HTTPS_PROXY,
    process.env.HTTP_PROXY,
    process.env.ALL_PROXY,
    process.env.https_proxy,
    process.env.http_proxy,
    process.env.all_proxy,
  ].find((value) => value?.trim())
}

function explainLinearFetchError(error) {
  const message = error instanceof Error ? error.message : String(error)
  const code = error?.cause?.code
  if (code === "ENOTFOUND") {
    if (getProxyUrl()) {
      return new Error(
        `Linear 请求失败：无法解析 api.linear.app。当前环境检测到代理变量，请检查代理是否可用。原始错误: ${message}`,
      )
    }
    return new Error(`Linear 请求失败：无法解析 api.linear.app。原始错误: ${message}`)
  }
  return error instanceof Error
    ? new Error(`Linear 请求失败: ${message}`)
    : new Error(`Linear 请求失败: ${String(error)}`)
}

function normalizeIssue(issue) {
  return {
    ...issue,
    labels: issue.labels?.nodes || [],
    comments: (issue.comments?.nodes || []).sort((a, b) =>
      String(a.createdAt).localeCompare(String(b.createdAt)),
    ),
  }
}
