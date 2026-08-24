import https from "node:https"
import { createLinearReadAdapter } from "./linear-read-adapter.mjs"
import { createProxyAgent, resolveProxyUrl } from "./proxy.mjs"

const API_URL = new URL("https://api.linear.app/graphql")

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

  let readAdapter = null

  function getReadAdapter() {
    readAdapter ||= createLinearReadAdapter({ graphql })
    return readAdapter
  }

  function listProjectIssues(projectId) {
    return getReadAdapter().listProjectIssues(projectId)
  }

  function readProject(projectId) {
    return getReadAdapter().readProject(projectId)
  }

  function listProjectWorkflowStates(projectId) {
    return getReadAdapter().listProjectWorkflowStates(projectId)
  }

  function listProjectsWorkflowStates(projectIds) {
    return getReadAdapter().listProjectsWorkflowStates(projectIds)
  }

  function listTeamWorkflowStates(teamId) {
    return getReadAdapter().listTeamWorkflowStates(teamId)
  }

  function readIssue(issueId) {
    return getReadAdapter().readIssue(issueId)
  }

  function getIssue(issueId) {
    return readIssue(issueId)
  }

  return {
    graphql,
    listProjects,
    listProjectIssues,
    readProject,
    listProjectWorkflowStates,
    listProjectsWorkflowStates,
    listTeamWorkflowStates,
    readIssue,
    getIssue,
  }
}

function postGraphql({ apiKey, body }) {
  const payload = JSON.stringify(body)
  const agent = createProxyAgent(API_URL)

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

function explainLinearFetchError(error) {
  const message = error instanceof Error ? error.message : String(error)
  const code = error?.cause?.code
  if (code === "ENOTFOUND") {
    if (resolveProxyUrl(API_URL)) {
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
