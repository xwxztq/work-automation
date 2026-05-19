const API_URL = "https://api.linear.app/graphql"

export function createLinearClient(apiKey) {
  async function graphql(query, variables = {}) {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({ query, variables }),
    })
    const text = await response.text()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error(`Linear 返回了非 JSON 响应 (${response.status}): ${text}`)
    }
    if (!response.ok) {
      throw new Error(`Linear HTTP ${response.status}: ${JSON.stringify(payload)}`)
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
    listProjectIssues,
    getIssue,
    updateIssueState,
    createComment,
  }
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
