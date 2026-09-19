import {
  ISSUE_PLATFORM_ERROR_CODE,
  ISSUE_PLATFORM_OPERATION,
  IssuePlatformError,
  defineIssueReadAdapter,
} from "./issue-platform.mjs"

export const LINEAR_ISSUE_PLATFORM = "primary-issues"
export const DEFAULT_LINEAR_READ_PAGE_SIZE = 100

const PROJECT_ISSUES_QUERY = `
  query LinearReadProjectIssues($projectId: String!, $first: Int!, $after: String) {
    project(id: $projectId) {
      id
      name
      url
      archivedAt
      issues(first: $first, after: $after, includeArchived: false) {
        pageInfo {
          hasNextPage
          endCursor
        }
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
          archivedAt
          state { id name type archivedAt }
          team { id key name archivedAt }
          project { id name url archivedAt }
          parent { id identifier }
          assignee { id name email }
          labels(first: 250, includeArchived: false) { nodes { id name } }
          comments(first: $first, includeArchived: false) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              body
              createdAt
              updatedAt
              archivedAt
              user { id name email }
            }
          }
        }
      }
    }
  }
`

const ISSUE_COMMENTS_QUERY = `
  query LinearReadIssueComments($issueId: String!, $first: Int!, $after: String) {
    issue(id: $issueId) {
      id
      archivedAt
      comments(first: $first, after: $after, includeArchived: false) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          body
          createdAt
          updatedAt
          archivedAt
          user { id name email }
        }
      }
    }
  }
`

const ISSUE_QUERY = `
  query LinearReadIssue($issueId: String!, $first: Int!) {
    issue(id: $issueId) {
      id
      identifier
      title
      description
      url
      priority
      priorityLabel
      createdAt
      updatedAt
      archivedAt
      state { id name type archivedAt }
      team { id key name archivedAt }
      project { id name url archivedAt }
      parent { id identifier }
      assignee { id name email }
      labels(first: 250, includeArchived: false) { nodes { id name } }
      comments(first: $first, includeArchived: false) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          body
          createdAt
          updatedAt
          archivedAt
          user { id name email }
        }
      }
      relations(first: $first, includeArchived: false) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          type
          createdAt
          updatedAt
          archivedAt
          relatedIssue { id identifier title url }
        }
      }
      inverseRelations(first: $first, includeArchived: false) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          type
          createdAt
          updatedAt
          archivedAt
          issue { id identifier title url }
        }
      }
      attachments(first: $first, includeArchived: false) {
        pageInfo { hasNextPage endCursor }
        nodes { id title subtitle url sourceType createdAt archivedAt }
      }
    }
  }
`

const ISSUE_OUTGOING_RELATIONS_QUERY = `
  query LinearReadIssueOutgoingRelations($issueId: String!, $first: Int!, $after: String) {
    issue(id: $issueId) {
      id
      archivedAt
      relations(first: $first, after: $after, includeArchived: false) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          type
          createdAt
          updatedAt
          archivedAt
          relatedIssue { id identifier title url }
        }
      }
    }
  }
`

const ISSUE_INCOMING_RELATIONS_QUERY = `
  query LinearReadIssueIncomingRelations($issueId: String!, $first: Int!, $after: String) {
    issue(id: $issueId) {
      id
      archivedAt
      inverseRelations(first: $first, after: $after, includeArchived: false) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          type
          createdAt
          updatedAt
          archivedAt
          issue { id identifier title url }
        }
      }
    }
  }
`

const ISSUE_ATTACHMENTS_QUERY = `
  query LinearReadIssueAttachments($issueId: String!, $first: Int!, $after: String) {
    issue(id: $issueId) {
      id
      archivedAt
      attachments(first: $first, after: $after, includeArchived: false) {
        pageInfo { hasNextPage endCursor }
        nodes { id title subtitle url sourceType createdAt archivedAt }
      }
    }
  }
`

const PROJECT_TEAMS_QUERY = `
  query LinearReadProjectTeams($projectId: String!, $first: Int!, $after: String) {
    project(id: $projectId) {
      id
      name
      url
      archivedAt
      teams(first: $first, after: $after, includeArchived: false) {
        pageInfo { hasNextPage endCursor }
        nodes { id key name archivedAt }
      }
    }
  }
`

const TEAM_WORKFLOW_STATES_QUERY = `
  query LinearReadTeamWorkflowStates($teamId: ID!, $first: Int!, $after: String) {
    workflowStates(
      first: $first
      after: $after
      includeArchived: false
      filter: { team: { id: { eq: $teamId } } }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes { id name type archivedAt }
    }
  }
`

export function createLinearReadAdapter(linearClient, options = {}) {
  if (!linearClient || typeof linearClient.graphql !== "function") {
    throw new TypeError("Linear 读取适配器需要 graphql 客户端。")
  }
  const pageSize = normalizePageSize(options.pageSize)
  const maxConcurrency = normalizeConcurrency(options.maxConcurrency)
  const projectIssueReads = new Map()

  function listProjectIssues(projectId) {
    const normalizedProjectId = requireIdentifier(projectId)
    const inflight = projectIssueReads.get(normalizedProjectId)
    if (inflight) {
      return inflight
    }
    const promise = loadProjectIssues(normalizedProjectId).finally(() => {
      if (projectIssueReads.get(normalizedProjectId) === promise) {
        projectIssueReads.delete(normalizedProjectId)
      }
    })
    projectIssueReads.set(normalizedProjectId, promise)
    return promise
  }

  async function loadProjectIssues(normalizedProjectId) {
    let project = null
    const issues = await readAllPages(async (after) => {
      const data = await graphql(PROJECT_ISSUES_QUERY, {
        projectId: normalizedProjectId,
        first: pageSize,
        after,
      }, { pagination: after !== null })
      if (!data?.project) {
        throw platformError(ISSUE_PLATFORM_ERROR_CODE.NOT_FOUND)
      }
      if (data.project.archivedAt) {
        throw platformError(ISSUE_PLATFORM_ERROR_CODE.ARCHIVED)
      }
      project ||= normalizeProject(data.project)
      return data.project.issues
    })

    const completeIssues = await mapWithConcurrency(
      issues,
      maxConcurrency,
      readCompleteIssueComments,
    )
    return {
      project,
      issues: completeIssues.map(normalizeIssue),
      complete: true,
    }
  }

  async function readCompleteIssueComments(issue) {
    const comments = await readAllPages(async (after) => {
      const data = await graphql(ISSUE_COMMENTS_QUERY, {
        issueId: issue.id,
        first: pageSize,
        after,
      }, { pagination: true })
      if (!data?.issue) {
        throw platformError(ISSUE_PLATFORM_ERROR_CODE.NOT_FOUND)
      }
      if (data.issue.archivedAt) {
        throw platformError(ISSUE_PLATFORM_ERROR_CODE.ARCHIVED)
      }
      return data.issue.comments
    }, issue.comments)
    return {
      ...issue,
      comments: {
        nodes: comments,
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }
  }

  async function readIssue(issueId) {
    const normalizedIssueId = requireIdentifier(issueId)
    const data = await graphql(ISSUE_QUERY, {
      issueId: normalizedIssueId,
      first: pageSize,
    })
    if (!data?.issue) {
      throw platformError(ISSUE_PLATFORM_ERROR_CODE.NOT_FOUND)
    }
    if (data.issue.archivedAt) {
      throw platformError(ISSUE_PLATFORM_ERROR_CODE.ARCHIVED)
    }

    const issue = data.issue
    const [comments, outgoingRelations, incomingRelations, attachments] = await Promise.all([
      readAllPages(
        (after) => readIssueConnection(ISSUE_COMMENTS_QUERY, normalizedIssueId, after, "comments"),
        issue.comments,
      ),
      readAllPages(
        (after) => readIssueConnection(
          ISSUE_OUTGOING_RELATIONS_QUERY,
          normalizedIssueId,
          after,
          "relations",
        ),
        issue.relations,
      ),
      readAllPages(
        (after) => readIssueConnection(
          ISSUE_INCOMING_RELATIONS_QUERY,
          normalizedIssueId,
          after,
          "inverseRelations",
        ),
        issue.inverseRelations,
      ),
      readAllPages(
        (after) => readIssueConnection(
          ISSUE_ATTACHMENTS_QUERY,
          normalizedIssueId,
          after,
          "attachments",
        ),
        issue.attachments,
      ),
    ])

    return normalizeIssue({
      ...issue,
      comments: completeConnection(comments),
      attachments: completeConnection(attachments),
      normalizedRelations: [
        ...outgoingRelations.map((relation) => ({
          ...relation,
          direction: "outgoing",
          targetIssue: relation.relatedIssue,
        })),
        ...incomingRelations.map((relation) => ({
          ...relation,
          direction: "incoming",
          targetIssue: relation.issue,
        })),
      ],
    })
  }

  async function readIssueConnection(query, issueId, after, field) {
    const data = await graphql(query, {
      issueId,
      first: pageSize,
      after,
    }, { pagination: true })
    if (!data?.issue) {
      throw platformError(ISSUE_PLATFORM_ERROR_CODE.NOT_FOUND)
    }
    if (data.issue.archivedAt) {
      throw platformError(ISSUE_PLATFORM_ERROR_CODE.ARCHIVED)
    }
    return data.issue[field]
  }

  async function readProject(projectId) {
    const normalizedProjectId = requireIdentifier(projectId)
    let project = null
    const teams = await readAllPages(async (after) => {
      const data = await graphql(PROJECT_TEAMS_QUERY, {
        projectId: normalizedProjectId,
        first: pageSize,
        after,
      }, { pagination: after !== null })
      if (!data?.project) {
        throw platformError(ISSUE_PLATFORM_ERROR_CODE.NOT_FOUND)
      }
      if (data.project.archivedAt) {
        throw platformError(ISSUE_PLATFORM_ERROR_CODE.ARCHIVED)
      }
      project ||= normalizeProject(data.project)
      return data.project.teams
    })

    return {
      ...project,
      teams: teams.map(normalizeTeam),
      complete: true,
    }
  }

  async function listProjectWorkflowStates(projectId) {
    const normalizedProjectId = requireIdentifier(projectId)
    const project = await readProject(normalizedProjectId)
    const teams = await mapWithConcurrency(
      project.teams,
      maxConcurrency,
      async (team) => ({
        ...team,
        workflowStates: await listTeamWorkflowStates(team.id),
      }),
    )
    return {
      requestedProjectId: normalizedProjectId,
      project: {
        id: project.id,
        name: project.name,
        url: project.url,
        archivedAt: project.archivedAt,
      },
      teams,
      complete: true,
    }
  }

  async function listProjectsWorkflowStates(projectIds) {
    const uniqueProjectIds = [...new Set(
      (projectIds || []).map((projectId) => requireIdentifier(projectId)),
    )]
    return mapWithConcurrency(
      uniqueProjectIds,
      maxConcurrency,
      async (projectId) => {
        try {
          return await listProjectWorkflowStates(projectId)
        } catch (error) {
          if (
            error instanceof IssuePlatformError &&
            [
              ISSUE_PLATFORM_ERROR_CODE.NOT_FOUND,
              ISSUE_PLATFORM_ERROR_CODE.ARCHIVED,
            ].includes(error.code)
          ) {
            return {
              requestedProjectId: projectId,
              project: {
                id: projectId,
                name: "",
                url: null,
                archivedAt: null,
              },
              teams: [],
              complete: false,
              error: error.toJSON(),
            }
          }
          throw error
        }
      },
    )
  }

  async function listTeamWorkflowStates(teamId) {
    const normalizedTeamId = requireIdentifier(teamId)
    const states = await readAllPages(async (after) => {
      const data = await graphql(TEAM_WORKFLOW_STATES_QUERY, {
        teamId: normalizedTeamId,
        first: pageSize,
        after,
      }, { pagination: after !== null })
      return data?.workflowStates
    })
    return states.map(normalizeState)
  }

  async function graphql(query, variables, { pagination = false } = {}) {
    try {
      return await linearClient.graphql(query, variables)
    } catch (error) {
      throw classifyLinearReadError(error, {
        fallbackCode: pagination
          ? ISSUE_PLATFORM_ERROR_CODE.PAGINATION_INTERRUPTED
          : ISSUE_PLATFORM_ERROR_CODE.OPERATION_FAILED,
      })
    }
  }

  return defineIssueReadAdapter({
    platform: LINEAR_ISSUE_PLATFORM,
    listProjectIssues,
    readIssue,
    readProject,
    listProjectWorkflowStates,
    listProjectsWorkflowStates,
    listTeamWorkflowStates,
  })
}

async function readAllPages(readPage, initialConnection = null) {
  const nodes = []
  const seenCursors = new Set()
  let after = null
  let connection = initialConnection

  while (true) {
    connection ||= await readPage(after)
    if (
      !connection ||
      !Array.isArray(connection.nodes) ||
      !connection.pageInfo ||
      typeof connection.pageInfo.hasNextPage !== "boolean"
    ) {
      throw platformError(ISSUE_PLATFORM_ERROR_CODE.PAGINATION_INTERRUPTED, {
        retryable: true,
      })
    }
    nodes.push(...connection.nodes)
    if (connection.pageInfo.hasNextPage !== true) {
      return nodes
    }
    const nextCursor = String(connection.pageInfo.endCursor || "").trim()
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw platformError(ISSUE_PLATFORM_ERROR_CODE.PAGINATION_INTERRUPTED, {
        retryable: true,
      })
    }
    seenCursors.add(nextCursor)
    after = nextCursor
    connection = null
  }
}

function normalizeIssue(issue) {
  return {
    id: issue.id,
    identifier: issue.identifier || "",
    target: {
      platform: LINEAR_ISSUE_PLATFORM,
      issueId: issue.id,
    },
    title: issue.title || "",
    description: issue.description ?? null,
    url: issue.url || null,
    priority: issue.priority ?? null,
    priorityLabel: issue.priorityLabel || "",
    createdAt: issue.createdAt || null,
    updatedAt: issue.updatedAt || null,
    archivedAt: issue.archivedAt || null,
    state: normalizeState(issue.state),
    team: normalizeTeam(issue.team),
    project: normalizeProject(issue.project),
    parent: issue.parent
      ? { id: issue.parent.id, identifier: issue.parent.identifier || "" }
      : null,
    parentIssueId: issue.parent?.id || null,
    assignee: issue.assignee
      ? { id: issue.assignee.id, name: issue.assignee.name || "", email: issue.assignee.email || "" }
      : null,
    labels: (issue.labels?.nodes || []).map((label) => ({
      id: label.id,
      name: label.name || "",
    })),
    comments: (issue.comments?.nodes || [])
      .map(normalizeComment)
      .sort(compareCreatedResource),
    relations: (issue.normalizedRelations || [])
      .map(normalizeRelation)
      .sort(compareCreatedResource),
    attachments: (issue.attachments?.nodes || [])
      .map(normalizeAttachment)
      .sort(compareCreatedResource),
    complete:
      issue.comments?.pageInfo?.hasNextPage !== true &&
      issue.attachments?.pageInfo?.hasNextPage !== true,
  }
}

function normalizeProject(project) {
  if (!project) return null
  return {
    id: project.id,
    name: project.name || "",
    url: project.url || null,
    archivedAt: project.archivedAt || null,
  }
}

function normalizeTeam(team) {
  if (!team) return null
  return {
    id: team.id,
    key: team.key || "",
    name: team.name || "",
    archivedAt: team.archivedAt || null,
  }
}

function normalizeState(state) {
  if (!state) return null
  return {
    id: state.id,
    name: state.name || "",
    type: state.type || "",
    archivedAt: state.archivedAt || null,
  }
}

function normalizeComment(comment) {
  return {
    id: comment.id,
    body: comment.body || "",
    createdAt: comment.createdAt || null,
    updatedAt: comment.updatedAt || null,
    archivedAt: comment.archivedAt || null,
    user: comment.user
      ? { id: comment.user.id, name: comment.user.name || "", email: comment.user.email || "" }
      : null,
  }
}

function normalizeRelation(relation) {
  const targetIssue = relation.targetIssue
  return {
    id: relation.id,
    type: relation.type || "related",
    direction: relation.direction,
    createdAt: relation.createdAt || null,
    updatedAt: relation.updatedAt || null,
    archivedAt: relation.archivedAt || null,
    issue: {
      id: targetIssue.id,
      identifier: targetIssue.identifier || "",
      title: targetIssue.title || "",
      url: targetIssue.url || null,
      target: {
        platform: LINEAR_ISSUE_PLATFORM,
        issueId: targetIssue.id,
      },
    },
  }
}

function normalizeAttachment(attachment) {
  return {
    id: attachment.id,
    filename: attachment.title || "",
    title: attachment.title || "",
    subtitle: attachment.subtitle || null,
    url: attachment.url || null,
    sourceType: attachment.sourceType || null,
    createdAt: attachment.createdAt || null,
    archivedAt: attachment.archivedAt || null,
  }
}

function completeConnection(nodes) {
  return {
    nodes,
    pageInfo: { hasNextPage: false, endCursor: null },
  }
}

function compareCreatedResource(a, b) {
  return `${a.createdAt || ""}:${a.id || ""}`.localeCompare(
    `${b.createdAt || ""}:${b.id || ""}`,
  )
}

function normalizePageSize(value) {
  const numeric = Number(value ?? DEFAULT_LINEAR_READ_PAGE_SIZE)
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 250) {
    throw new TypeError("Linear 读取分页大小必须是 1 至 250 的整数。")
  }
  return numeric
}

function normalizeConcurrency(value) {
  const numeric = Number(value ?? 4)
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 16) {
    throw new TypeError("Linear 读取并发数必须是 1 至 16 的整数。")
  }
  return numeric
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(items[index], index)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  )
  return results
}

function requireIdentifier(value) {
  const normalized = String(value || "").trim()
  if (!normalized) {
    throw platformError(ISSUE_PLATFORM_ERROR_CODE.INVALID_REQUEST)
  }
  return normalized
}

function platformError(code, options = {}) {
  return new IssuePlatformError({
    code,
    operation: ISSUE_PLATFORM_OPERATION.READ_ISSUE,
    retryable: options.retryable,
  })
}

function classifyLinearReadError(error, { fallbackCode } = {}) {
  if (error instanceof IssuePlatformError) {
    return error
  }

  const message = String(error?.message || "").toLowerCase()
  const messageStatus = Number(/linear http (\d{3})/u.exec(message)?.[1] || 0)
  const status = Number(
    error?.status ||
    error?.statusCode ||
    error?.extensions?.http?.status ||
    error?.cause?.status ||
    messageStatus,
  )
  const providerCode = String(error?.code || error?.cause?.code || "").toUpperCase()

  if (status === 401 || status === 403 || /unauth|forbidden|permission denied|access denied/u.test(message)) {
    return platformError(ISSUE_PLATFORM_ERROR_CODE.PERMISSION_DENIED)
  }
  if (status === 404 || /(?:entity |resource )?not found|未找到/u.test(message)) {
    return platformError(ISSUE_PLATFORM_ERROR_CODE.NOT_FOUND)
  }
  if (status === 429 || /rate.?limit|too many requests/u.test(message)) {
    return platformError(ISSUE_PLATFORM_ERROR_CODE.RATE_LIMITED, { retryable: true })
  }
  if (
    status >= 500 ||
    ["ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "ENOTFOUND", "ETIMEDOUT"].includes(providerCode) ||
    /network|socket|timed? ?out|请求超时|请求失败/u.test(message)
  ) {
    return platformError(ISSUE_PLATFORM_ERROR_CODE.UNAVAILABLE, { retryable: true })
  }
  return platformError(fallbackCode || ISSUE_PLATFORM_ERROR_CODE.OPERATION_FAILED, {
    retryable: fallbackCode === ISSUE_PLATFORM_ERROR_CODE.PAGINATION_INTERRUPTED,
  })
}
