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
 *     fields this module bakes (`managerId` / `deptHeadId`); the `managerChainIds`
 *     chain is consumed by the LIVE `continuous_managers` and `manager_at_level`
 *     kinds. Either way this module's sole job is unchanged:
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
  /** RA-1a: the requester's directory-resolved primary department NAME (directory_departments.name) —
   *  the tamper-resistant source for `requester.department`. Omitted when unresolvable. */
  primaryDepartmentName?: string
  /** The requester's directory-resolved job TITLE (directory_accounts.title) — the tamper-resistant
   *  source for `requester.title`. Omitted when unresolvable (unset/blank for this requester). */
  primaryTitle?: string
  /** Local user id of the requester's direct manager, if resolvable. */
  managerId?: string
  /** Local user id of the head of the requester's primary department, if resolvable. */
  deptHeadId?: string
  /**
   * Ordered local user ids of the requester's management chain, level 1 first
   * (`[0]` is the direct manager **when that manager is distinct from the
   * requester**). It usually equals `managerId`, but can differ in one edge case:
   * this chain self-excludes on the requester's LOCAL id, whereas `managerId`
   * (step 2) excludes only the requester's external id — so if an alt-account of
   * the requester is flagged leader of their own dept, `managerId` may be the
   * requester (harmless; the resolver drops it) while this chain skips past it.
   * Only populated when the caller opts in via `includeManagerChain` (i.e. a
   * published graph uses a management-chain source — `continuous_managers` or
   * `manager_at_level`). Cycle-guarded and capped at `MAX_MANAGER_CHAIN_LEVELS`;
   * unlinked hops are walked through but not included (so the array is DENSE).
   * Read by `continuous_managers` (slices it to its own `levels`) and
   * `manager_at_level` (picks the single id at `level - 1`). Omitted when empty.
   */
  managerChainIds?: string[]
}

/** Default cap on how far up the org tree the bake-time walk climbs when unconfigured. */
export const DEFAULT_MAX_MANAGER_CHAIN_LEVELS = 10
/** Hard upper bound on the *configurable* cap — even a misconfigured env can't make the
 * walk unbounded (each level is a sequential pair of directory queries). */
export const MANAGER_CHAIN_LEVELS_HARD_CEILING = 50

/**
 * Resolve the configurable chain cap from a raw env value (pure, so it is unit-testable).
 * `undefined`/missing or any invalid value (non-integer, < 1) → the safe default; a valid
 * value is clamped to `[1, MANAGER_CHAIN_LEVELS_HARD_CEILING]`. Fail-safe, never throws —
 * a bad env must not break approval creation.
 */
export function resolveMaxManagerChainLevels(raw: string | undefined): number {
  const trimmed = raw?.trim()
  // Accept ONLY a plain positive decimal integer — reject scientific (`1e3`), hex
  // (`0x10`), signed, and fractional forms rather than silently coercing them.
  if (!trimmed || !/^[0-9]+$/.test(trimmed)) return DEFAULT_MAX_MANAGER_CHAIN_LEVELS
  const parsed = Number(trimmed)
  if (parsed < 1) return DEFAULT_MAX_MANAGER_CHAIN_LEVELS
  return Math.min(parsed, MANAGER_CHAIN_LEVELS_HARD_CEILING)
}

/** Cap on how far up the org tree the bake-time walk climbs — env-configurable via
 * `APPROVAL_MANAGER_CHAIN_MAX_LEVELS` (default 10, hard-ceiling 50). The per-source
 * `levels` slices this; the cap only bounds the walk cost + a pathological deep tree.
 * Resolved at module load (a deploy-time setting, like the other `APPROVAL_*` tunables). */
export const MAX_MANAGER_CHAIN_LEVELS = resolveMaxManagerChainLevels(process.env.APPROVAL_MANAGER_CHAIN_MAX_LEVELS)

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
  title: string | null
  primary_external_department_id: string | null
  primary_department_raw: unknown
  primary_department_name: string | null
}

interface RoutingPolicyProbeRow {
  org_id: string
  canonical_integration_id: string
  canonical_status: string | null
}

/**
 * B5-b fail-closed CONFIG error (design lock Lock 2): thrown when an `approval_routing` policy
 * exists but cannot be honored — its canonical integration is missing/not-active, or the requester
 * is linked in MORE THAN ONE policy-governed org. Deliberately a distinct type so the create-time
 * caller can surface "routing policy misconfigured — contact an administrator" instead of the
 * generic transient "please retry": retrying never fixes a broken policy. NOT thrown for data
 * absence (a requester simply missing from the canonical directory resolves to `{}`).
 */
export class ApprovalRoutingPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApprovalRoutingPolicyError'
  }
}

/**
 * Read-only resolution of the requester's direct manager + department head as
 * LOCAL user ids. Returns `{}` when the requester has no linked directory account
 * (e.g. a purely-local user) so callers can bake an unchanged snapshot.
 *
 * `query` is injected (defaults to the shared pool) so the unit path can drive it
 * against an in-memory fixture without a database.
 *
 * `options.orgId` (S7 §3.3, optional / backward compatible) is a TENANT BOUNDARY:
 * when supplied, every step of resolution is confined to that org — including the
 * B5-b `approval_routing` policy probe (foreign-org policies must neither steer the
 * pick nor trigger multi-org ambiguity). Within that org:
 *   - a same-org policy is AUTHORITATIVE (canonical-integration pick);
 *   - no same-org policy → org-anchored requester SELECT (`directory_integrations.org_id`
 *     before ORDER BY/LIMIT 1) so a local user linked into two orgs cannot have the
 *     wrong org's account selected.
 * Callers that omit `orgId` retain the unscoped kernel path (B5-b Q4 across all
 * linked orgs) — kernel `ApprovalProductService` callers included. Attendance-facing
 * paths MUST pass `orgId`.
 */
export async function resolveApprovalRequesterOrgRelations(
  localUserId: string,
  query: QueryFn,
  options: { includeManagerChain?: boolean; maxLevels?: number; orgId?: string } = {},
): Promise<ApprovalRequesterOrgRelations> {
  const userId = localUserId.trim()
  if (!userId) return {}

  // Optional org anchor (S7 §3.3). Trim + non-empty only — an empty string must NOT
  // accidentally join against `org_id = ''` and force every row out of scope.
  // When present this is a tenant boundary: it SCOPES the B5-b policy probe first,
  // then (if no same-org policy) the requester-account pick.
  const orgId =
    typeof options.orgId === 'string' && options.orgId.trim().length > 0
      ? options.orgId.trim()
      : null

  // 0) B5-b (design lock Lock 2 + Q4): explicit `(org, purpose='approval_routing')` routing policy.
  //    Since B1 an org can hold MULTIPLE directory integrations (DingTalk + local), and the legacy
  //    requester pick below guesses among them by `ORDER BY a.updated_at DESC` — the exact
  //    "latest integration wins" behavior the §6 owner ruling forbids.
  //
  //    TENANT BOUNDARY: when `orgId` is set, the probe is restricted to
  //    `p.org_id = $2` for that exact org. A foreign-org policy is invisible here —
  //    it must neither select a canonical integration nor inflate multi-org ambiguity.
  //
  //    When `orgId` is OMITTED (kernel path), the probe considers every org the user
  //    is linked in (B5-b Q4, unchanged):
  //      - NO policy row  → LEGACY unscoped pick below (Q1: zero behavior change until a
  //        policy is explicitly set — staged opt-in).
  //      - ONE policy     → the policy is AUTHORITATIVE: the requester pick is restricted to the
  //        canonical integration. A policy whose canonical target is missing or not 'active' is a
  //        CONFIG error → fail-closed typed throw (operator must fix the policy; silently falling
  //        back to guessing would defeat the policy's purpose). A requester with no active account
  //        in the canonical integration is DATA absence, not a config error → `{}` (same semantics
  //        as "no linked directory account", e.g. a not-yet-synced employee).
  //      - POLICIES IN >1 ORG the user is linked in → ambiguity is real and policy-managed →
  //        fail-closed typed throw (multi-org users need explicit resolution, Q4). A user linked in
  //        one policy-governed org AND one policy-less org follows the single governed policy —
  //        deterministic, never a guess.
  //
  //    When `orgId` IS set:
  //      - NO same-org policy → fall through to the S7 org-anchored requester SELECT.
  //      - ONE same-org policy → AUTHORITATIVE canonical-integration pick (within the tenant).
  //      - (multi-org ambiguity cannot fire: foreign policies are filtered out by p.org_id = $2.)
  const policyRows = await query<RoutingPolicyProbeRow>(
    orgId
      ? `SELECT DISTINCT p.org_id                            AS org_id,
            p.canonical_integration_id::text             AS canonical_integration_id,
            ci.status                                    AS canonical_status
       FROM directory_account_links l
       JOIN directory_accounts a
         ON a.id = l.directory_account_id
        AND a.is_active = true
       JOIN directory_integrations ai
         ON ai.id = a.integration_id
       JOIN org_directory_routing_policy p
         ON p.org_id = ai.org_id
        AND p.purpose = 'approval_routing'
       LEFT JOIN directory_integrations ci
         ON ci.id = p.canonical_integration_id
      WHERE l.local_user_id = $1
        AND l.link_status = 'linked'
        AND p.org_id = $2`
      : `SELECT DISTINCT p.org_id                            AS org_id,
            p.canonical_integration_id::text             AS canonical_integration_id,
            ci.status                                    AS canonical_status
       FROM directory_account_links l
       JOIN directory_accounts a
         ON a.id = l.directory_account_id
        AND a.is_active = true
       JOIN directory_integrations ai
         ON ai.id = a.integration_id
       JOIN org_directory_routing_policy p
         ON p.org_id = ai.org_id
        AND p.purpose = 'approval_routing'
       LEFT JOIN directory_integrations ci
         ON ci.id = p.canonical_integration_id
      WHERE l.local_user_id = $1
        AND l.link_status = 'linked'`,
    orgId ? [userId, orgId] : [userId],
  )
  let canonicalIntegrationId: string | null = null
  if (policyRows.rows.length > 0) {
    const orgs = new Set(policyRows.rows.map((r) => r.org_id))
    if (orgs.size > 1) {
      // Only reachable on the no-orgId (kernel) path: org-scoped probe binds p.org_id = $2.
      throw new ApprovalRoutingPolicyError(
        `approval routing is policy-managed in ${orgs.size} orgs this user is linked in; multi-org routing requires explicit resolution`,
      )
    }
    const policy = policyRows.rows[0]
    if (policy.canonical_status !== 'active') {
      throw new ApprovalRoutingPolicyError(
        `the approval_routing policy for org "${policy.org_id}" points at a ${policy.canonical_status === null ? 'missing' : `'${policy.canonical_status}'`} integration; fix the routing policy`,
      )
    }
    canonicalIntegrationId = policy.canonical_integration_id
  }

  // 1) Requester's linked directory account + its primary department's raw.
  //    Precedence (tenant-scoped policy first, then S7 org anchor, then legacy):
  //      a) POLICY-SCOPED when a (tenant-visible) policy governs — restricted to the
  //         canonical integration (identical projection; consumers below are source-agnostic).
  //      b) ORG-ANCHORED when no same-org/no-orgId policy and `orgId` is set — join
  //         directory_integrations so ORDER BY/LIMIT 1 only competes inside the calling org (S7).
  //      c) LEGACY unscoped otherwise — byte-identical pre-B5/pre-S7 pick (no-orgId + no policy).
  const requesterRows = canonicalIntegrationId
    ? await query<RequesterDirectoryRow>(
        `SELECT a.integration_id::text       AS integration_id,
            a.id::text                   AS account_id,
            a.external_user_id           AS external_user_id,
            a.raw                        AS raw,
            a.title                      AS title,
            d.external_department_id     AS primary_external_department_id,
            d.raw                        AS primary_department_raw,
            d.name                       AS primary_department_name
       FROM directory_account_links l
       JOIN directory_accounts a
         ON a.id = l.directory_account_id
        AND a.is_active = true
        AND a.integration_id = $2::uuid
       LEFT JOIN directory_account_departments ad
         ON ad.directory_account_id = a.id
        AND ad.is_primary = true
       LEFT JOIN directory_departments d
         ON d.id = ad.directory_department_id
      WHERE l.local_user_id = $1
        AND l.link_status = 'linked'
      ORDER BY a.updated_at DESC, a.id ASC
      LIMIT 1`,
        [userId, canonicalIntegrationId],
      )
    : orgId
      ? await query<RequesterDirectoryRow>(
          `SELECT a.integration_id::text       AS integration_id,
                a.id::text                   AS account_id,
                a.external_user_id           AS external_user_id,
                a.raw                        AS raw,
                a.title                      AS title,
                d.external_department_id     AS primary_external_department_id,
                d.raw                        AS primary_department_raw,
                d.name                       AS primary_department_name
           FROM directory_account_links l
           JOIN directory_accounts a
             ON a.id = l.directory_account_id
            AND a.is_active = true
           JOIN directory_integrations di
             ON di.id = a.integration_id
            AND di.org_id = $2
           LEFT JOIN directory_account_departments ad
             ON ad.directory_account_id = a.id
            AND ad.is_primary = true
           LEFT JOIN directory_departments d
             ON d.id = ad.directory_department_id
          WHERE l.local_user_id = $1
            AND l.link_status = 'linked'
          ORDER BY a.updated_at DESC, a.id ASC
          LIMIT 1`,
          [userId, orgId],
        )
      : await query<RequesterDirectoryRow>(
          `SELECT a.integration_id::text       AS integration_id,
            a.id::text                   AS account_id,
            a.external_user_id           AS external_user_id,
            a.raw                        AS raw,
            a.title                      AS title,
            d.external_department_id     AS primary_external_department_id,
            d.raw                        AS primary_department_raw,
            d.name                       AS primary_department_name
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

  // 2) Direct manager — DUAL-SOURCE with precedence (B3, design-lock §5.4).
  //    The manager relationship is now a first-class, provider-neutral flag on the
  //    membership row (`directory_account_departments.is_manager`) — product truth an
  //    admin sets on a LOCAL org — NOT parsed from a provider's raw JSON. Precedence:
  //      - if the requester's primary department has ANY membership marked
  //        `is_manager = true`, resolve the manager from that normalized relation;
  //      - OTHERWISE fall back to the legacy DingTalk `raw.leader_in_dept` parse below,
  //        which stays byte-for-byte unchanged.
  //    DingTalk-synced rows never set `is_manager` (the sync writer leaves it default-false —
  //    see `setLocalMembershipManager`'s local-only writer boundary), so the normalized gate is
  //    always 0 rows for a DingTalk integration and its approval routing stays bit-identical.
  //    B6 proves local/DingTalk manager parity end-to-end; B3 only opens the normalized read
  //    seam for the DIRECT manager here. The manager CHAIN (step 4) and the department HEAD
  //    (step 3, a distinct `dept_manager_userid_list` source) are intentionally left on their
  //    legacy sources in this increment.
  let managerId: string | undefined
  if (requesterDeptId) {
    const normalized = await resolveNormalizedDeptManager(
      integrationId,
      requesterDeptId,
      requester.external_user_id,
      query,
    )
    if (normalized.present) {
      // The dept is normalized-managed: the normalized relation is authoritative even when it
      // resolves to no LINKED local user (e.g. the flagged manager is unlinked) — we never blend
      // back into the provider raw for a dept an admin explicitly manages.
      managerId = normalized.managerId
    } else {
      // LEGACY (unchanged): the account flagged leader for the requester's primary
      // department in its own `leader_in_dept`. Exclude the requester themselves.
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
  const primaryDepartmentName = requester.primary_department_name?.trim()
  if (primaryDepartmentName) relations.primaryDepartmentName = primaryDepartmentName
  const primaryTitle = requester.title?.trim()
  if (primaryTitle) relations.primaryTitle = primaryTitle

  // 4) Manager chain (opt-in): walk leader_in_dept hop-by-hop up the org tree,
  //    starting from the requester. Only runs when the caller opts in — i.e. a
  //    published graph uses a management-chain source (`continuous_managers` or
  //    `manager_at_level`) — so the per-hop queries are NOT added to every approval.
  //    Same point-in-time + self-exclusion posture as the direct manager above.
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

/**
 * B3 (design-lock §5.4) — resolve the requester's direct manager from the NORMALIZED relation:
 * the `directory_account_departments.is_manager` flag on a membership of the requester's primary
 * department. Returns a discriminated result so the caller can honour the precedence rule:
 *   - `present = false` — the department has NO `is_manager = true` membership, so the caller
 *     falls back to the legacy `raw.leader_in_dept` source (this is always the case for a
 *     DingTalk integration, whose rows never set the flag → its routing is bit-identical);
 *   - `present = true` — the department IS normalized-managed, so this result is authoritative,
 *     including `managerId = undefined` when the flagged manager is not linked to a local user
 *     (we do not blend back into the provider raw for an explicitly-managed dept).
 *
 * The existence gate is requester-INCLUSIVE (any `is_manager` row for the dept flips to
 * normalized), while the pick is requester-EXCLUSIVE (a person is never their own manager). The
 * pick is deterministic — ordered by `external_user_id` then account id — since, unlike the
 * legacy `.find` over arbitrary heap order, this is a fresh read path.
 *
 * The department is bound to the SAME integration as the account (`d.integration_id = $1` alongside
 * the account's `a.integration_id = $1`): `external_department_id` is unique only WITHIN an
 * integration, so without this a repeated external id in another integration — or a malformed
 * cross-integration membership — could leak a foreign dept's manager into this integration's
 * routing. Both sides bind the one requester integration scope.
 */
async function resolveNormalizedDeptManager(
  integrationId: string,
  deptExternalId: string,
  requesterExternalId: string,
  query: QueryFn,
): Promise<{ present: boolean; managerId?: string }> {
  const rows = await query<{ account_id: string; external_user_id: string }>(
    `SELECT a.id::text        AS account_id,
            a.external_user_id AS external_user_id
       FROM directory_account_departments ad
       JOIN directory_accounts a
         ON a.id = ad.directory_account_id
        AND a.is_active = true
       JOIN directory_departments d
         ON d.id = ad.directory_department_id
      WHERE a.integration_id = $1::uuid
        AND d.integration_id = $1::uuid
        AND d.external_department_id = $2
        AND ad.is_manager = true
      ORDER BY a.external_user_id ASC, a.id ASC`,
    [integrationId, deptExternalId],
  )
  if (rows.rows.length === 0) return { present: false }
  const manager = rows.rows.find((row) => row.external_user_id !== requesterExternalId)
  if (!manager) return { present: true }
  return { present: true, managerId: await resolveLinkedLocalUserId(manager.account_id, query) }
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
