/**
 * Approval ↔ Directory org-relation plumbing (READ-ONLY).
 *
 * Lane G (P1-A) prerequisite slice. The directory-sync subsystem already stores
 * the full provider payload for every synced account/department in the `raw`
 * JSONB column (`directory_accounts.raw`, `directory_departments.raw`), but the
 * org-hierarchy signals inside it — the requester's direct manager and their
 * department head — are NOT extracted into queryable columns. This module is the
 * single read-only seam that lifts those two relations out of `raw` and maps
 * them back to LOCAL user ids, so the approval bake step
 * (`ApprovalProductService.createApproval`) can freeze `managerId` / `deptHeadId`
 * into the requester snapshot.
 *
 * BOUNDARY / DOCTRINE (#2738/#2740, CI-enforced by #2742):
 *   - This module ONLY issues SELECTs against `directory_*` + `directory_account_links`.
 *     It writes nothing, and it touches no `approval_*` / `automation_*` table —
 *     so it is outside the convergence guard's write-boundary entirely and never
 *     crosses an automation boundary.
 *   - It is NOT a resolver kind. The `direct_manager` / `dept_head` assignee-source
 *     kinds are now LIVE in `ApprovalAssigneeResolver` and consume the snapshot
 *     fields this module bakes (`managerId` / `deptHeadId`); `continuous_managers`
 *     remains future/DESIGN-ONLY. Either way this module's sole job is unchanged:
 *     snapshot plumbing — it populates those fields and does not resolve assignees
 *     itself.
 *
 * Provider shape (DingTalk, the only synced provider today):
 *   - `directory_accounts.raw.leader_in_dept`: `Array<{ dept_id, leader: boolean }>`
 *     — the account's manager flag *per department*. The manager USER is not on
 *     this row; DingTalk models "leader of dept D" as a flag on the leader's own
 *     account. So the direct manager of user U is the account in U's primary
 *     department whose `leader_in_dept` marks it leader for that department.
 *   - `directory_departments.raw.dept_manager_userid_list`: `string[]` of the
 *     department's manager external user ids (dept head).
 *
 * Both lookups resolve a directory account → LOCAL user id via
 * `directory_account_links` (link_status = 'linked'), mirroring the join already
 * used by `AttendanceNotificationDeliveryWorker.resolveRecipient`. When a relation
 * is absent (no manager, top-of-tree, unlinked, or pre-extraction legacy rows),
 * the field is simply omitted — never throws — so the empty-assignee policy
 * downstream stays in control.
 */

type QueryFn = <Row>(text: string, params?: unknown[]) => Promise<{ rows: Row[] }>

export interface ApprovalRequesterOrgRelations {
  /** Local user id of the requester's direct manager, if resolvable. */
  managerId?: string
  /** Local user id of the head of the requester's primary department, if resolvable. */
  deptHeadId?: string
  /**
   * Ordered local user ids of the requester's management chain, level 1 first
   * (`[0]` is the direct manager, equal to `managerId`). Only populated when the
   * caller opts in via `includeManagerChain` (i.e. a published graph actually uses
   * the `continuous_managers` source). Cycle-guarded and capped at
   * `MAX_MANAGER_CHAIN_LEVELS`; unlinked hops are walked through but not included.
   * Read by the `continuous_managers` assignee-source kind (which slices it to its
   * own `levels`). Omitted when the chain resolves empty.
   */
  managerChainIds?: string[]
}

/** Hard ceiling on how far up the org tree the bake-time walk climbs. The per-source
 * `levels` slices this; the cap only bounds the walk cost + a pathological deep tree. */
export const MAX_MANAGER_CHAIN_LEVELS = 10

interface LeaderInDeptEntry {
  dept_id?: unknown
  deptId?: unknown
  leader?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function normalizeExternalId(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function parseLeaderDeptIds(raw: Record<string, unknown> | null): string[] {
  if (!raw) return []
  const entries = raw.leader_in_dept ?? raw.leaderInDept
  if (!Array.isArray(entries)) return []
  const deptIds: string[] = []
  for (const entry of entries as LeaderInDeptEntry[]) {
    if (entry?.leader !== true) continue
    const deptId = normalizeExternalId(entry.dept_id ?? entry.deptId)
    if (deptId) deptIds.push(deptId)
  }
  return deptIds
}

function parseDeptManagerExternalIds(raw: Record<string, unknown> | null): string[] {
  if (!raw) return []
  const list = raw.dept_manager_userid_list ?? raw.deptManagerUseridList
  if (!Array.isArray(list)) return []
  const ids: string[] = []
  for (const item of list) {
    const id = normalizeExternalId(item)
    if (id) ids.push(id)
  }
  return ids
}

interface RequesterDirectoryRow {
  integration_id: string
  account_id: string
  external_user_id: string
  raw: unknown
  primary_external_department_id: string | null
  primary_department_raw: unknown
}

/**
 * Read-only resolution of the requester's direct manager + department head as
 * LOCAL user ids. Returns `{}` when the requester has no linked directory account
 * (e.g. a purely-local user) so callers can bake an unchanged snapshot.
 *
 * `query` is injected (defaults to the shared pool) so the unit path can drive it
 * against an in-memory fixture without a database.
 */
export async function resolveApprovalRequesterOrgRelations(
  localUserId: string,
  query: QueryFn,
  options: { includeManagerChain?: boolean; maxLevels?: number } = {},
): Promise<ApprovalRequesterOrgRelations> {
  const userId = localUserId.trim()
  if (!userId) return {}

  // 1) Requester's linked directory account + its primary department's raw.
  const requesterRows = await query<RequesterDirectoryRow>(
    `SELECT a.integration_id::text       AS integration_id,
            a.id::text                   AS account_id,
            a.external_user_id           AS external_user_id,
            a.raw                        AS raw,
            d.external_department_id     AS primary_external_department_id,
            d.raw                        AS primary_department_raw
       FROM directory_account_links l
       JOIN directory_accounts a
         ON a.id = l.directory_account_id
        AND a.is_active = true
       LEFT JOIN directory_account_departments ad
         ON ad.directory_account_id = a.id
        AND ad.is_primary = true
       LEFT JOIN directory_departments d
         ON d.id = ad.directory_department_id
      WHERE l.local_user_id = $1
        AND l.link_status = 'linked'
      ORDER BY a.updated_at DESC, a.id ASC
      LIMIT 1`,
    [userId],
  )
  const requester = requesterRows.rows[0]
  if (!requester) return {}

  const integrationId = requester.integration_id
  const requesterDeptId = normalizeExternalId(requester.primary_external_department_id)

  // 2) Direct manager: the account flagged leader for the requester's primary
  //    department in its own `leader_in_dept`. Exclude the requester themselves.
  let managerId: string | undefined
  if (requesterDeptId) {
    const candidateRows = await query<{ account_id: string; raw: unknown }>(
      `SELECT a.id::text AS account_id, a.raw AS raw
         FROM directory_accounts a
         JOIN directory_account_departments ad
           ON ad.directory_account_id = a.id
         JOIN directory_departments d
           ON d.id = ad.directory_department_id
        WHERE a.integration_id = $1::uuid
          AND a.is_active = true
          AND d.external_department_id = $2
          AND a.external_user_id <> $3`,
      [integrationId, requesterDeptId, requester.external_user_id],
    )
    const managerAccountId = candidateRows.rows.find((row) =>
      parseLeaderDeptIds(asRecord(row.raw)).includes(requesterDeptId))?.account_id
    if (managerAccountId) {
      managerId = await resolveLinkedLocalUserId(managerAccountId, query)
    }
  }

  // 3) Department head: first manager external id on the primary department's raw
  //    that resolves to a linked local user (and is not the requester).
  let deptHeadId: string | undefined
  const deptManagerExternalIds = parseDeptManagerExternalIds(asRecord(requester.primary_department_raw))
    .filter((external) => external !== requester.external_user_id)
  for (const external of deptManagerExternalIds) {
    const localId = await resolveLinkedLocalUserIdByExternal(integrationId, external, query)
    if (localId) {
      deptHeadId = localId
      break
    }
  }

  const relations: ApprovalRequesterOrgRelations = {}
  if (managerId) relations.managerId = managerId
  if (deptHeadId) relations.deptHeadId = deptHeadId

  // 4) Manager chain (opt-in): walk leader_in_dept hop-by-hop up the org tree,
  //    starting from the requester. Only runs when the caller opts in — i.e. a
  //    published graph actually uses `continuous_managers` — so the per-hop
  //    queries are NOT added to every approval. Same point-in-time + self-exclusion
  //    posture as the direct manager above.
  if (options.includeManagerChain) {
    const chain = await resolveManagerChain(
      integrationId,
      requester.external_user_id,
      userId,
      requesterDeptId,
      clampChainLevels(options.maxLevels),
      query,
    )
    if (chain.length > 0) relations.managerChainIds = chain
  }

  return relations
}

function clampChainLevels(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return MAX_MANAGER_CHAIN_LEVELS
  return Math.min(value, MAX_MANAGER_CHAIN_LEVELS)
}

interface DeptLeaderHop {
  accountId: string
  externalUserId: string
  primaryDeptExternalId: string | null
}

/**
 * One hop up the tree: the active account flagged leader for `deptExternalId` in
 * its own `leader_in_dept` (excluding `excludeExternalId` so a node is never its
 * own manager), returned with the identity needed to continue the walk — the
 * leader's external id and *their* primary department.
 */
async function findDeptLeaderHop(
  integrationId: string,
  deptExternalId: string,
  excludeExternalId: string,
  query: QueryFn,
): Promise<DeptLeaderHop | undefined> {
  const rows = await query<{
    account_id: string
    external_user_id: string
    raw: unknown
    primary_dept_external_id: string | null
  }>(
    `SELECT a.id::text                  AS account_id,
            a.external_user_id          AS external_user_id,
            a.raw                       AS raw,
            pd.external_department_id   AS primary_dept_external_id
       FROM directory_accounts a
       JOIN directory_account_departments ad
         ON ad.directory_account_id = a.id
       JOIN directory_departments d
         ON d.id = ad.directory_department_id
       LEFT JOIN directory_account_departments pad
         ON pad.directory_account_id = a.id
        AND pad.is_primary = true
       LEFT JOIN directory_departments pd
         ON pd.id = pad.directory_department_id
      WHERE a.integration_id = $1::uuid
        AND a.is_active = true
        AND d.external_department_id = $2
        AND a.external_user_id <> $3`,
    [integrationId, deptExternalId, excludeExternalId],
  )
  const leader = rows.rows.find((row) => parseLeaderDeptIds(asRecord(row.raw)).includes(deptExternalId))
  if (!leader) return undefined
  return {
    accountId: leader.account_id,
    externalUserId: leader.external_user_id,
    primaryDeptExternalId: normalizeExternalId(leader.primary_dept_external_id),
  }
}

/**
 * Walk the management chain up from the requester, collecting linked LOCAL user
 * ids in order (level 1 = direct manager). Termination is bounded three ways so a
 * malformed org graph can never loop or run away:
 *   - a visited-set of external ids stops cycles (A leads B's dept, B leads A's);
 *   - a hop with no leader stops the walk (top of tree reached);
 *   - at most `maxLevels` hops are taken.
 * Unlinked managers are walked *through* (their own manager can still resolve) but
 * not added to the chain; duplicates are collapsed.
 *
 * Self-exclusion is enforced on the requester's LOCAL id, not just their starting
 * external id: a person can own multiple directory accounts (distinct external ids)
 * that all link back to the same local user, and any of those alt-accounts could be
 * flagged leader of the requester's department. Excluding only the starting external
 * id would let such an alt-account resolve to the requester's own local id and land
 * the requester in their own management chain. So a hop that resolves to
 * `requesterLocalId` is walked *through* (we still climb past it to find the real
 * next manager) but never added to the chain.
 */
async function resolveManagerChain(
  integrationId: string,
  requesterExternalId: string,
  requesterLocalId: string,
  requesterDeptExternalId: string | null,
  maxLevels: number,
  query: QueryFn,
): Promise<string[]> {
  const chain: string[] = []
  const visited = new Set<string>([requesterExternalId])
  let currentExternalId = requesterExternalId
  let currentDeptExternalId = requesterDeptExternalId

  for (let level = 0; level < maxLevels; level += 1) {
    if (!currentDeptExternalId) break
    const hop = await findDeptLeaderHop(integrationId, currentDeptExternalId, currentExternalId, query)
    if (!hop) break
    if (visited.has(hop.externalUserId)) break
    visited.add(hop.externalUserId)

    const localId = await resolveLinkedLocalUserId(hop.accountId, query)
    // Self-exclusion on the LOCAL id: an alt-account of the requester (different
    // external id, same local user) must not enter the chain. Walk through it.
    if (localId && localId !== requesterLocalId && !chain.includes(localId)) chain.push(localId)

    currentExternalId = hop.externalUserId
    currentDeptExternalId = hop.primaryDeptExternalId
  }

  return chain
}

async function resolveLinkedLocalUserId(accountId: string, query: QueryFn): Promise<string | undefined> {
  const rows = await query<{ local_user_id: string | null }>(
    `SELECT local_user_id
       FROM directory_account_links
      WHERE directory_account_id = $1::uuid
        AND link_status = 'linked'
        AND local_user_id IS NOT NULL
      LIMIT 1`,
    [accountId],
  )
  const localId = rows.rows[0]?.local_user_id
  return localId ? localId : undefined
}

async function resolveLinkedLocalUserIdByExternal(
  integrationId: string,
  externalUserId: string,
  query: QueryFn,
): Promise<string | undefined> {
  const rows = await query<{ local_user_id: string | null }>(
    `SELECT l.local_user_id AS local_user_id
       FROM directory_accounts a
       JOIN directory_account_links l
         ON l.directory_account_id = a.id
        AND l.link_status = 'linked'
        AND l.local_user_id IS NOT NULL
      WHERE a.integration_id = $1::uuid
        AND a.external_user_id = $2
        AND a.is_active = true
      LIMIT 1`,
    [integrationId, externalUserId],
  )
  const localId = rows.rows[0]?.local_user_id
  return localId ? localId : undefined
}
