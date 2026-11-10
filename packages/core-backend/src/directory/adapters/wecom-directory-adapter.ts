/**
 * WeCom directory adapter (the app's own Secret; read-only; one `department/list` call plus one
 * `user/list` call per real department).
 *
 * Contract: a fetch method returns only a complete snapshot and throws a typed error before the
 * caller writes anything — a missing page, an invalid shape, a scope that differs from the confirmed
 * one, an oversized organization or too many malformed member identifiers all reject the round. The
 * adapter keeps no per-run state, so one instance serves concurrent runs.
 *
 * A member's canonical id is `lower(userid)` after the member-creation character rule; a member that
 * fails the rule is isolated (not returned, counted) and the round is refused above a threshold.
 * Members whose status is disabled (2) or left the company (5) are not returned. Contact values are
 * adopted only when the response carries them; when no member of the round carries a value for a
 * field, every member of the round is flagged so the caller retains the previously stored value.
 * Nothing is derived from names, ids or other fields, and no DingTalk-shaped approval key is written.
 */
import { createHash } from 'node:crypto'
import {
  getWeComAgent,
  isValidWeComDepartmentId,
  isValidWeComUserId,
  listWeComDepartmentMembers,
  listWeComDepartments,
  classifyWeComErrcode,
  observeWeComTransportRetries,
  readWeComBaseUrlFromEnv,
  WeComBusinessError,
  WeComIncompleteResponseError,
  WeComInvalidInputError,
  type WeComAgentDetail,
  type WeComDepartmentEntry,
  type WeComDirectoryMemberEntry,
  type WeComRequestOptions,
  type WeComTokenConfig,
} from '../../integrations/wecom/client'
import type {
  DirectoryAdapter,
  DirectoryAdapterCapabilities,
  DirectoryDepartmentRecord,
  DirectoryMemberRecord,
  DirectoryPullTelemetry,
} from '../directory-adapter'
import { hasDirectoryDepartmentCycle } from '../directory-department-cycle'
import {
  WeComAppClosedError,
  WeComAppTypeUnsupportedError,
  WeComMemberShapeViolationError,
  WeComPullTooLargeError,
  WeComRootDepartmentNotVisibleError,
  WeComScopeChangedError,
  WeComScopeKindUnsupportedError,
  WeComScopeUnacknowledgedError,
  weComDirectoryFailureText,
  type WeComDirectoryFailureText,
} from './wecom-directory-errors'

export interface WeComDirectoryConfig {
  corpId: string
  /** Decrypted application secret. */
  corpSecret: string
  /** Decimal string, `^[1-9]\d{0,14}$`. */
  wecomAgentId: string
  /** Decimal string, `^\d{1,10}$`; `'1'` is the organization root. */
  rootDepartmentId: string
  /** The confirmed scope digest (64 hex); missing or empty means the scope was never confirmed. */
  scopeDigestAcknowledged?: string
}

/** A member record that may ask the caller to keep stored contact values for fields the round did not observe. */
export type WeComDirectoryMemberRecord = DirectoryMemberRecord & {
  preserveContact?: { email?: true; mobile?: true }
}

export interface WeComDirectoryAdapter extends DirectoryAdapter<WeComDirectoryConfig> {
  fetchMembers(
    config: WeComDirectoryConfig,
    departments: Map<string, DirectoryDepartmentRecord>,
    telemetry?: DirectoryPullTelemetry,
  ): Promise<Map<string, WeComDirectoryMemberRecord>>
  /** Adapter-level failure text for a caught value; `null` when the value is not one of the adapter's own. */
  failureText(error: unknown): WeComDirectoryFailureText | null
}

export const WECOM_DIRECTORY_ADAPTER_CAPABILITIES: DirectoryAdapterCapabilities = {
  contactFields: { email: 'needs_field_permission', mobile: 'needs_field_permission' },
  memberOpenId: 'unavailable',
  memberUnionId: 'unavailable',
  managerIds: false,
  primaryDepartmentSignal: false,
  diagnostics: false,
}

/** Per-round size limits. */
export const WECOM_DIRECTORY_MAX_DEPARTMENTS = 5_000
export const WECOM_DIRECTORY_MAX_MEMBERS = 50_000
/** Isolated members tolerated per round: at most the larger of this floor and the ratio below. */
export const WECOM_DIRECTORY_ISOLATION_FLOOR = 10
export const WECOM_DIRECTORY_ISOLATION_RATIO = 0.02

const DEFAULT_ROOT_DEPARTMENT_ID = '1'

function ascendingNumeric(a: string, b: string): number {
  return Number(a) - Number(b)
}

function sortedUniqueNumbers(values: readonly number[]): number[] {
  return Array.from(new Set(values)).sort((a, b) => a - b)
}

/**
 * The scope digest: SHA-256 over the canonical serialization of
 * `[ascending distinct party ids, ascending distinct lower-case userids, ascending distinct tag ids]`.
 * Order of the input arrays does not matter.
 */
export function computeWeComScopeDigest(scope: {
  allowPartyIds: readonly number[]
  allowUserIds: readonly string[]
  allowTagIds: readonly number[]
}): string {
  const users = Array.from(new Set(scope.allowUserIds.map((userId) => userId.toLowerCase()))).sort()
  const canonical = JSON.stringify([sortedUniqueNumbers(scope.allowPartyIds), users, sortedUniqueNumbers(scope.allowTagIds)])
  return createHash('sha256').update(canonical).digest('hex')
}

function resolveRootDepartmentId(config: WeComDirectoryConfig): string {
  const root = config.rootDepartmentId ?? DEFAULT_ROOT_DEPARTMENT_ID
  if (!isValidWeComDepartmentId(root)) throw new WeComInvalidInputError('departmentId')
  return root
}

function tokenConfigOf(config: WeComDirectoryConfig): WeComTokenConfig {
  return { corpId: config.corpId, corpSecret: config.corpSecret, baseUrl: readWeComBaseUrlFromEnv() }
}

/** App faults and the scope witness; runs before any list call of both fetch methods. */
async function verifyAppScope(
  config: WeComDirectoryConfig,
  requestOptions: WeComRequestOptions | undefined,
): Promise<WeComAgentDetail> {
  const agent = await getWeComAgent(tokenConfigOf(config), config.wecomAgentId, requestOptions)
  if (agent.agentId !== config.wecomAgentId) throw new WeComIncompleteResponseError('agent')
  if (agent.closed) throw new WeComAppClosedError()
  if (agent.hasCustomizedPublishStatus) throw new WeComAppTypeUnsupportedError()
  if (agent.allowUserIds.length > 0 || agent.allowTagIds.length > 0) throw new WeComScopeKindUnsupportedError()
  const digest = computeWeComScopeDigest(agent)
  const acknowledged = config.scopeDigestAcknowledged
  if (typeof acknowledged !== 'string' || acknowledged.length === 0) throw new WeComScopeUnacknowledgedError()
  if (digest !== acknowledged) throw new WeComScopeChangedError()
  return agent
}

function buildDepartments(
  entries: readonly WeComDepartmentEntry[],
  rootId: string,
  integrationName: string,
): Map<string, DirectoryDepartmentRecord> {
  if (entries.length === 0) throw new WeComIncompleteResponseError('department_list')
  if (entries.length > WECOM_DIRECTORY_MAX_DEPARTMENTS) throw new WeComPullTooLargeError()

  const byId = new Map<string, WeComDepartmentEntry>()
  for (const entry of entries) {
    const id = String(entry.id)
    if (byId.has(id)) throw new WeComIncompleteResponseError('department_graph')
    byId.set(id, entry)
  }
  const rawParents = new Map<string, { parentId: string | null }>()
  for (const [id, entry] of byId) rawParents.set(id, { parentId: String(entry.parentId) })
  if (hasDirectoryDepartmentCycle(rawParents)) throw new WeComIncompleteResponseError('department_graph')

  const realRoot = byId.has(rootId)
  let kept: string[]
  if (rootId === DEFAULT_ROOT_DEPARTMENT_ID) {
    kept = Array.from(byId.keys())
  } else {
    if (!realRoot) throw new WeComRootDepartmentNotVisibleError()
    const children = new Map<string, string[]>()
    for (const [id, entry] of byId) {
      const parentKey = String(entry.parentId)
      children.set(parentKey, [...(children.get(parentKey) ?? []), id])
    }
    kept = []
    const queue = [rootId]
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      kept.push(next)
      queue.push(...(children.get(next) ?? []))
    }
  }

  const departments = new Map<string, DirectoryDepartmentRecord>()
  departments.set(rootId, {
    id: rootId,
    parentId: null,
    name: integrationName,
    order: 0,
    source: { syntheticRoot: true, realRoot },
  })
  for (const id of kept.filter((candidate) => candidate !== rootId).sort(ascendingNumeric)) {
    const entry = byId.get(id) as WeComDepartmentEntry
    const parentKey = String(entry.parentId)
    const parentId = entry.parentId === 0 || parentKey === rootId || !byId.has(parentKey) ? rootId : parentKey
    const source: Record<string, unknown> = { parentid: entry.parentId }
    if (entry.order !== undefined) source.order = entry.order
    if (entry.nameEn !== undefined) source.name_en = entry.nameEn
    if (entry.departmentLeader !== undefined) source.department_leader = entry.departmentLeader
    departments.set(id, { id, parentId, name: entry.name, order: entry.order ?? 0, source })
  }
  return departments
}

/** Real (non-synthetic) department ids to list members of, ascending numeric; the root counts when it exists. */
function realDepartmentIds(departments: Map<string, DirectoryDepartmentRecord>, rootId: string): string[] {
  const ids: string[] = []
  for (const [id, record] of departments) {
    if (record.source.syntheticRoot === true) {
      if (id === rootId && record.source.realRoot === true) ids.push(id)
      continue
    }
    ids.push(id)
  }
  return ids.sort(ascendingNumeric)
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value === undefined ? '' : value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

interface MemberDraft {
  userId: string
  useridRaw: string
  name?: string
  title?: string
  avatarUrl?: string
  mobile?: string
  email?: string
  mainDepartment?: number
  departments: Set<string>
  passThrough: Record<string, unknown>
}

function orderedDepartmentIds(draft: MemberDraft): string[] {
  const rest = Array.from(draft.departments).sort(ascendingNumeric)
  const main = draft.mainDepartment === undefined ? undefined : String(draft.mainDepartment)
  if (main === undefined || !draft.departments.has(main)) return rest
  return [main, ...rest.filter((id) => id !== main)]
}

function isScopeFault(error: unknown): boolean {
  return error instanceof WeComBusinessError && classifyWeComErrcode(error.errcode) === 'scope_fault'
}

async function pullMembers(
  config: WeComDirectoryConfig,
  departments: Map<string, DirectoryDepartmentRecord>,
  telemetry: DirectoryPullTelemetry | undefined,
  requestOptions: WeComRequestOptions | undefined,
): Promise<Map<string, WeComDirectoryMemberRecord>> {
  const rootId = resolveRootDepartmentId(config)
  await verifyAppScope(config, requestOptions)

  const drafts = new Map<string, MemberDraft>()
  const isolated = new Set<string>()
  let emailObserved = false
  let mobileObserved = false

  for (const departmentId of realDepartmentIds(departments, rootId)) {
    let entries: WeComDirectoryMemberEntry[]
    try {
      if (telemetry?.apiCalls) telemetry.apiCalls.userListPageCalls += 1
      entries = await listWeComDepartmentMembers(tokenConfigOf(config), departmentId, requestOptions)
    } catch (error) {
      if (isScopeFault(error)) throw new WeComScopeChangedError()
      throw error
    }

    for (const entry of entries) {
      if (nonEmpty(entry.email) !== undefined) emailObserved = true
      if (nonEmpty(entry.mobile) !== undefined) mobileObserved = true
      if (entry.status === 2 || entry.status === 5) continue
      if (!isValidWeComUserId(entry.userid)) {
        isolated.add(entry.userid.toLowerCase())
        continue
      }
      const userId = entry.userid.toLowerCase()
      let draft = drafts.get(userId)
      if (!draft) {
        draft = { userId, useridRaw: entry.userid, departments: new Set<string>(), passThrough: {} }
        drafts.set(userId, draft)
        if (drafts.size > WECOM_DIRECTORY_MAX_MEMBERS) throw new WeComPullTooLargeError()
      }
      draft.name ??= nonEmpty(entry.name)
      draft.title ??= nonEmpty(entry.position)
      draft.avatarUrl ??= nonEmpty(entry.avatar)
      draft.mobile ??= nonEmpty(entry.mobile)
      draft.email ??= nonEmpty(entry.email)
      if (entry.mainDepartment !== undefined) draft.mainDepartment ??= entry.mainDepartment
      draft.departments.add(departmentId)
      for (const memberDepartment of entry.department ?? []) draft.departments.add(String(memberDepartment))
      if (entry.position !== undefined && !('position' in draft.passThrough)) draft.passThrough.position = entry.position
      if (entry.order !== undefined && !('order' in draft.passThrough)) draft.passThrough.order = entry.order
      if (entry.isLeaderInDept !== undefined && !('is_leader_in_dept' in draft.passThrough)) {
        draft.passThrough.is_leader_in_dept = entry.isLeaderInDept
      }
      if (entry.directLeader !== undefined && !('direct_leader' in draft.passThrough)) {
        draft.passThrough.direct_leader = entry.directLeader
      }
    }
  }

  // `total` counts the distinct valid members plus the distinct isolated identifiers; the comparison is
  // exact (no rounding).
  const total = drafts.size + isolated.size
  if (isolated.size > Math.max(WECOM_DIRECTORY_ISOLATION_FLOOR, total * WECOM_DIRECTORY_ISOLATION_RATIO)) {
    throw new WeComMemberShapeViolationError(isolated.size)
  }

  const preserveContact: { email?: true; mobile?: true } = {}
  if (!emailObserved) preserveContact.email = true
  if (!mobileObserved) preserveContact.mobile = true
  const preserves = Object.keys(preserveContact).length > 0

  const members = new Map<string, WeComDirectoryMemberRecord>()
  for (const draft of drafts.values()) {
    const source: Record<string, unknown> = { useridRaw: draft.useridRaw, ...draft.passThrough }
    if (draft.mainDepartment !== undefined) source.main_department = draft.mainDepartment
    const record: WeComDirectoryMemberRecord = {
      userId: draft.userId,
      name: draft.name ?? draft.userId,
      departmentIds: orderedDepartmentIds(draft),
      source,
    }
    if (draft.name === undefined) source.nameUnavailable = true
    if (draft.title !== undefined) record.title = draft.title
    if (draft.avatarUrl !== undefined) record.avatarUrl = draft.avatarUrl
    if (draft.mobile !== undefined) record.mobile = draft.mobile
    if (draft.email !== undefined) record.email = draft.email
    if (preserves) record.preserveContact = { ...preserveContact }
    members.set(draft.userId, record)
  }
  return members
}

export function createWeComDirectoryAdapter(deps?: { requestOptions?: WeComRequestOptions }): WeComDirectoryAdapter {
  const requestOptions = deps?.requestOptions
  return {
    provider: 'wecom',
    capabilities: WECOM_DIRECTORY_ADAPTER_CAPABILITIES,
    async fetchDepartments(config, integrationName, telemetry) {
      const rootId = resolveRootDepartmentId(config)
      await verifyAppScope(config, requestOptions)
      if (telemetry?.apiCalls) telemetry.apiCalls.departmentListCalls += 1
      const entries = await listWeComDepartments(tokenConfigOf(config), requestOptions)
      return buildDepartments(entries, rootId, integrationName)
    },
    fetchMembers: (config, departments, telemetry) => pullMembers(config, departments, telemetry, requestOptions),
    observeRetries: observeWeComTransportRetries,
    failureText: weComDirectoryFailureText,
  }
}

/** The process-wide instance registered with the directory adapter registry. */
export const wecomDirectoryAdapter: WeComDirectoryAdapter = createWeComDirectoryAdapter()
