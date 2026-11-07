/**
 * DingTalk implementation of the directory adapter contract: the department tree walk, the member
 * pull, the root-department diagnostic sample and the connection probe, over the DingTalk client.
 */
import { Logger } from '../../core/logger'
import {
  fetchDingTalkAppAccessToken,
  getDingTalkDepartmentDetail,
  getDingTalkUserDetail,
  listDingTalkDepartments,
  listDingTalkDepartmentUsers,
  type DingTalkDepartment,
  type DingTalkDirectoryUser,
} from '../../integrations/dingtalk/client'
import {
  DingTalkIncompleteResponseError,
  observeDingTalkTransportRetries,
} from '../../integrations/dingtalk/transport'
import { enrichDepartmentsWithManagers } from '../department-manager-enrichment'
import { hasDirectoryDepartmentCycle } from '../directory-department-cycle'
import {
  DIRECTORY_DEFAULT_PAGE_SIZE,
  type DirectoryAdapter,
  type DirectoryAdapterCapabilities,
  type DirectoryIntegrationDiagnosticSummary,
  type DirectoryIntegrationProbeResult,
  type DirectoryRootDepartmentDiagnosticSample,
} from '../directory-adapter'
import type { DirectorySyncApiCallCounters } from '../directory-sync-api-telemetry'
import type { DirectoryIntegrationConfig, NormalizedDirectoryIntegrationInput } from '../directory-sync'
import { getNextDirectoryUserCursor } from '../directory-user-pagination'

const logger = new Logger('DingTalkDirectoryAdapter')

export function buildDirectoryIntegrationTestWarnings(result: {
  rootDepartmentId: string
  departmentSampleCount: number
  rootDepartmentDirectUserCount: number
  rootDepartmentDirectUserHasMore: boolean
  rootDepartmentDirectUserCountWithAccessLimit: number
  rootDepartmentDirectUserHasMoreWithAccessLimit: boolean
}): string[] {
  const warnings: string[] = []
  const hasNoChildDepartments = result.departmentSampleCount === 0
  const hasSuspiciouslySparseRootMembers =
    result.rootDepartmentDirectUserCount <= 1 && !result.rootDepartmentDirectUserHasMore

  if (hasNoChildDepartments) {
    warnings.push(`根部门 ${result.rootDepartmentId} 未返回任何子部门。`)
  }

  if (hasNoChildDepartments && hasSuspiciouslySparseRootMembers) {
    warnings.push(
      `根部门 ${result.rootDepartmentId} 当前仅返回 ${result.rootDepartmentDirectUserCount} 个直属成员；如果钉钉企业通讯录里实际成员更多，通常是应用通讯录接口范围未覆盖，或根部门 ID 配置不正确。`,
    )
  }

  if (
    hasNoChildDepartments
    && hasSuspiciouslySparseRootMembers
    && result.rootDepartmentDirectUserCountWithAccessLimit === result.rootDepartmentDirectUserCount
    && result.rootDepartmentDirectUserHasMoreWithAccessLimit === result.rootDepartmentDirectUserHasMore
  ) {
    warnings.push('开启“包含访问受限成员”后返回结果没有变化，说明当前问题不是受限成员过滤导致的。')
  }

  return warnings
}

export function buildDirectoryIntegrationDiagnosticSummary(result: {
  departmentSampleCount: number
  rootDepartmentDirectUserCount: number
  rootDepartmentDirectUserHasMore: boolean
}): DirectoryIntegrationDiagnosticSummary {
  const hasNoChildDepartments = result.departmentSampleCount === 0
  const hasSuspiciouslySparseRootMembers =
    result.rootDepartmentDirectUserCount <= 1 && !result.rootDepartmentDirectUserHasMore

  if (hasNoChildDepartments && hasSuspiciouslySparseRootMembers) {
    return {
      code: 'scope_or_root_misconfigured',
      title: '通讯录范围或根部门疑似配置不当',
      nextAction: '请检查应用「通讯录管理」权限范围是否覆盖全员，并确认根部门 ID 是否正确。',
    }
  }

  if (hasNoChildDepartments) {
    return {
      code: 'no_child_departments',
      title: '根部门未返回子部门',
      nextAction: '如企业通讯录确有部门层级，请检查应用通讯录可见范围配置。',
    }
  }

  return {
    code: 'healthy',
    title: '通讯录连通正常',
    nextAction: '通讯录范围正常，可执行目录同步。',
  }
}

export async function sampleRootDepartmentDiagnostics(
  config: DirectoryIntegrationConfig,
): Promise<DirectoryRootDepartmentDiagnosticSample> {
  const accessToken = await fetchDingTalkAppAccessToken({
    appKey: config.appKey,
    appSecret: config.appSecret,
    baseUrl: config.baseUrl,
  })
  const departments = await listDingTalkDepartments(accessToken, config.rootDepartmentId, {
    baseUrl: config.baseUrl,
  })
  const rootUsers = await listDingTalkDepartmentUsers(
    accessToken,
    config.rootDepartmentId,
    0,
    Math.min(config.pageSize ?? DIRECTORY_DEFAULT_PAGE_SIZE, 100),
    { baseUrl: config.baseUrl },
  )
  const rootUsersWithAccessLimit = await listDingTalkDepartmentUsers(
    accessToken,
    config.rootDepartmentId,
    0,
    Math.min(config.pageSize ?? DIRECTORY_DEFAULT_PAGE_SIZE, 100),
    { baseUrl: config.baseUrl, containAccessLimit: true },
  )

  const rootDepartmentChildCount = departments.length
  const rootDepartmentDirectUserCount = rootUsers.users.length
  const rootDepartmentDirectUserHasMore = rootUsers.hasMore
  const rootDepartmentDirectUserCountWithAccessLimit = rootUsersWithAccessLimit.users.length
  const rootDepartmentDirectUserHasMoreWithAccessLimit = rootUsersWithAccessLimit.hasMore

  const warnings = buildDirectoryIntegrationTestWarnings({
    rootDepartmentId: config.rootDepartmentId,
    departmentSampleCount: rootDepartmentChildCount,
    rootDepartmentDirectUserCount,
    rootDepartmentDirectUserHasMore,
    rootDepartmentDirectUserCountWithAccessLimit,
    rootDepartmentDirectUserHasMoreWithAccessLimit,
  })
  const summary = buildDirectoryIntegrationDiagnosticSummary({
    departmentSampleCount: rootDepartmentChildCount,
    rootDepartmentDirectUserCount,
    rootDepartmentDirectUserHasMore,
  })

  return {
    rootDepartmentChildCount,
    rootDepartmentDirectUserCount,
    rootDepartmentDirectUserHasMore,
    rootDepartmentDirectUserCountWithAccessLimit,
    rootDepartmentDirectUserHasMoreWithAccessLimit,
    sampledRootDepartmentUsers: rootUsers.users.slice(0, 10).map((user) => ({ userId: user.userId, name: user.name })),
    sampledRootDepartmentUsersWithAccessLimit: rootUsersWithAccessLimit.users
      .slice(0, 10)
      .map((user) => ({ userId: user.userId, name: user.name })),
    summary,
    warnings,
  }
}

/** The provider part of a connection test: five client calls, then the diagnostics, summary and warnings. */
export async function probeDingTalkDirectory(
  normalized: NormalizedDirectoryIntegrationInput,
): Promise<DirectoryIntegrationProbeResult> {
  const accessToken = await fetchDingTalkAppAccessToken({
    appKey: normalized.appKey,
    appSecret: normalized.appSecret,
    baseUrl: normalized.baseUrl ?? undefined,
  })

  const departments = await listDingTalkDepartments(
    accessToken,
    normalized.rootDepartmentId,
    { baseUrl: normalized.baseUrl ?? undefined },
  )
  const firstDepartmentId = departments[0]?.id ?? normalized.rootDepartmentId
  const { users } = await listDingTalkDepartmentUsers(
    accessToken,
    firstDepartmentId,
    0,
    Math.min(normalized.pageSize ?? DIRECTORY_DEFAULT_PAGE_SIZE, 5),
    { baseUrl: normalized.baseUrl ?? undefined },
  )
  const rootUsers = await listDingTalkDepartmentUsers(
    accessToken,
    normalized.rootDepartmentId,
    0,
    Math.min(normalized.pageSize ?? DIRECTORY_DEFAULT_PAGE_SIZE, 100),
    { baseUrl: normalized.baseUrl ?? undefined },
  )
  const rootUsersWithAccessLimit = await listDingTalkDepartmentUsers(
    accessToken,
    normalized.rootDepartmentId,
    0,
    Math.min(normalized.pageSize ?? DIRECTORY_DEFAULT_PAGE_SIZE, 100),
    {
      baseUrl: normalized.baseUrl ?? undefined,
      containAccessLimit: true,
    },
  )

  const diagnostics = {
    rootDepartmentChildCount: departments.length,
    rootDepartmentDirectUserCount: rootUsers.users.length,
    rootDepartmentDirectUserHasMore: rootUsers.hasMore,
    rootDepartmentDirectUserCountWithAccessLimit: rootUsersWithAccessLimit.users.length,
    rootDepartmentDirectUserHasMoreWithAccessLimit: rootUsersWithAccessLimit.hasMore,
    sampledRootDepartmentUsers: rootUsers.users.slice(0, 10).map((user) => ({ userId: user.userId, name: user.name })),
    sampledRootDepartmentUsersWithAccessLimit: rootUsersWithAccessLimit.users.slice(0, 10).map((user) => ({ userId: user.userId, name: user.name })),
  }

  return {
    departmentSampleCount: departments.length,
    sampledDepartments: departments.slice(0, 5).map((department) => ({ id: department.id, name: department.name })),
    userSampleCount: users.length,
    sampledUsers: users.slice(0, 5).map((user) => ({ userId: user.userId, name: user.name })),
    diagnostics,
    summary: buildDirectoryIntegrationDiagnosticSummary({
      departmentSampleCount: departments.length,
      rootDepartmentDirectUserCount: diagnostics.rootDepartmentDirectUserCount,
      rootDepartmentDirectUserHasMore: diagnostics.rootDepartmentDirectUserHasMore,
    }),
    warnings: buildDirectoryIntegrationTestWarnings({
      rootDepartmentId: normalized.rootDepartmentId,
      departmentSampleCount: departments.length,
      rootDepartmentDirectUserCount: diagnostics.rootDepartmentDirectUserCount,
      rootDepartmentDirectUserHasMore: diagnostics.rootDepartmentDirectUserHasMore,
      rootDepartmentDirectUserCountWithAccessLimit: diagnostics.rootDepartmentDirectUserCountWithAccessLimit,
      rootDepartmentDirectUserHasMoreWithAccessLimit: diagnostics.rootDepartmentDirectUserHasMoreWithAccessLimit,
    }),
  }
}

export async function fetchAllDepartments(
  config: DirectoryIntegrationConfig,
  integrationName: string,
  // §7.7 telemetry: increment per external directory-pull call so the N+1 is ops-visible on
  // the run record. Optional — the preview path (no run row) omits it.
  apiCalls?: DirectorySyncApiCallCounters,
): Promise<Map<string, DingTalkDepartment>> {
  const accessToken = await fetchDingTalkAppAccessToken({
    appKey: config.appKey,
    appSecret: config.appSecret,
    baseUrl: config.baseUrl,
  })
  const departments = new Map<string, DingTalkDepartment>()
  // The seeded synthetic root is not a returned wire id until a list row replaces it.
  const returnedWireDepartmentIds = new Set<string>()
  departments.set(config.rootDepartmentId, {
    id: config.rootDepartmentId,
    parentId: null,
    name: integrationName,
    order: 0,
    source: { syntheticRoot: true },
  })

  const queue = [config.rootDepartmentId]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue
    if (apiCalls) apiCalls.departmentListCalls += 1
    const children = await listDingTalkDepartments(accessToken, current, { baseUrl: config.baseUrl })
    for (const child of children) {
      const existing = departments.get(child.id)
      if (
        existing
        && returnedWireDepartmentIds.has(child.id)
        && existing.parentId !== child.parentId
      ) {
        throw new DingTalkIncompleteResponseError('Failed to read complete DingTalk departments', {})
      }
      departments.set(child.id, existing ? { ...existing, ...child } : child)
      returnedWireDepartmentIds.add(child.id)
      if (!existing) queue.push(child.id)
    }
  }

  if (hasDirectoryDepartmentCycle(departments)) {
    throw new DingTalkIncompleteResponseError('Failed to read complete DingTalk departments', {})
  }

  // dept-head plumbing: enrich each department with its manager user ids from the
  // department-detail API (listsub does not return them). Best-effort + sequential
  // (concurrency=1; explicit min-interval throttle deferred — no real rate limiter
  // yet): a per-dept failure leaves managerUserIds undefined so the upsert carries
  // the prior dept_manager_userid_list forward instead of wiping it.
  await enrichDepartmentsWithManagers(
    departments.values(),
    (deptId) => {
      if (apiCalls) apiCalls.departmentDetailCalls += 1
      return getDingTalkDepartmentDetail(accessToken, deptId, { baseUrl: config.baseUrl })
    },
    () => logger.warn('DingTalk department detail unavailable; carrying prior manager list forward'),
  )

  return departments
}

function mergeDepartmentIds(primary: string[], secondary: string[]): string[] {
  return Array.from(new Set([...primary, ...secondary].filter(Boolean)))
}

export async function fetchAllUsers(
  config: DirectoryIntegrationConfig,
  departmentMap: Map<string, DingTalkDepartment>,
  // §7.7 telemetry: `userDetailCalls` is THE N+1 metric — one `user/get` per unique user.
  // Optional — the preview path (no run row) omits it.
  apiCalls?: DirectorySyncApiCallCounters,
): Promise<Map<string, DingTalkDirectoryUser>> {
  const accessToken = await fetchDingTalkAppAccessToken({
    appKey: config.appKey,
    appSecret: config.appSecret,
    baseUrl: config.baseUrl,
  })
  const users = new Map<string, DingTalkDirectoryUser>()
  const pageSize = config.pageSize ?? DIRECTORY_DEFAULT_PAGE_SIZE

  for (const departmentId of departmentMap.keys()) {
    let cursor = 0
    const seenCursors = new Set<number>([cursor])
    let hasMore = true
    while (hasMore) {
      if (apiCalls) apiCalls.userListPageCalls += 1
      const response = await listDingTalkDepartmentUsers(
        accessToken,
        departmentId,
        cursor,
        pageSize,
        { baseUrl: config.baseUrl },
      )
      const nextCursor = getNextDirectoryUserCursor(response, seenCursors)
      for (const summary of response.users) {
        const existing = users.get(summary.userId)
        if (!existing) {
          // The N+1: a per-user detail fetch, issued once per UNIQUE user (this branch only
          // runs on first sight — a user in two departments is fetched once).
          if (apiCalls) apiCalls.userDetailCalls += 1
          const detail = await getDingTalkUserDetail(accessToken, summary.userId, { baseUrl: config.baseUrl })
          users.set(summary.userId, {
            ...detail,
            departmentIds: mergeDepartmentIds(detail.departmentIds, summary.departmentIds),
          })
          continue
        }
        users.set(summary.userId, {
          ...existing,
          departmentIds: mergeDepartmentIds(existing.departmentIds, summary.departmentIds),
        })
      }
      if (nextCursor === null) {
        hasMore = false
      } else {
        cursor = nextCursor
        seenCursors.add(cursor)
      }
    }
  }

  return users
}

export const DINGTALK_DIRECTORY_ADAPTER_CAPABILITIES: DirectoryAdapterCapabilities = {
  contactFields: { email: 'available', mobile: 'available' },
  memberOpenId: 'login_backfill_only',
  memberUnionId: 'available',
  managerIds: true,
  primaryDepartmentSignal: true,
  diagnostics: true,
}

export const dingtalkDirectoryAdapter: DirectoryAdapter<DirectoryIntegrationConfig> = {
  provider: 'dingtalk',
  capabilities: DINGTALK_DIRECTORY_ADAPTER_CAPABILITIES,
  fetchDepartments: (config, integrationName, telemetry) =>
    fetchAllDepartments(config, integrationName, telemetry?.apiCalls),
  fetchMembers: (config, departments, telemetry) => fetchAllUsers(config, departments, telemetry?.apiCalls),
  observeRetries: observeDingTalkTransportRetries,
  sampleDiagnostics: sampleRootDepartmentDiagnostics,
  probeConnection: probeDingTalkDirectory,
}
