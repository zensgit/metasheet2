/**
 * 备料「成员与权限」— THE HOST'S NARROW PORT for the stock-prep application's own roles (ADR
 * adr-stock-prep-project-sheets-20261008 §11.4–§11.6, slice S5b, register R-39).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE CAN WRITE, AND NOTHING ELSE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * The platform's role editor (`routes/roles.ts`) needs `roles:write`, which a `stock-prep` delegated
 * admin does not hold (§11.1). This port is the ONE place such an admin may author a role, and it is
 * narrow by construction, after the `services/stock-preparation-field-permissions.ts` precedent:
 *
 *   * ROLE IDS ARE SERVER-GENERATED: `stock-prep_c_<8 hex>`. A request never names the id of a role
 *     it creates; an update names an id that must pass, in this order and each with its own code,
 *     (a) the `stock-prep` namespace, (b) NOT ending in `_admin` (§11.2 trap 3: a `_admin` suffix
 *     makes the holder a delegated admin of a derived namespace), (c) NOT one of the four built-in
 *     ids (they are read-only here — S5a seeds them), (d) the custom-role shape. The generated id is
 *     run through the same four checks before it is written.
 *   * THREE INVARIANTS (ADR §11.4), each with a "remove it and a test goes red" witness in
 *     tests/unit/stock-preparation-members.test.ts:
 *       1. GRANTED ⊆ GRANTOR. The codes are a subset of the selectable `stock-prep:*` codes AND of
 *          the grantor's CURRENT effective codes (the ladder, read fresh); the project sheets are a
 *          subset of the sheets the grantor can READ (the grid's own `resolveReadableSheetIds`).
 *       2. NO PLATFORM CODE, EVER. Any code outside `stock-prep:*` in the request is a 400 before any
 *          IO — `multitable:*`, `workflow:*`, `roles:*`, `integration:*`, `*:*` included. The
 *          selectable list is written here, not read from anywhere.
 *       3. EVERY CHANGE IS AUDITED in the admin-users.ts delegation shape (`actorId`, `actorType:
 *          'user'`, `action`, `resourceType`, `resourceId`, `meta.{adminUserId, delegated,
 *          delegableNamespaces}`) — create, update and each project-sheet grant here; appoint,
 *          revoke and admission stay on the EXISTING delegation routes, which already audit.
 *   * `stock-prep:admin` IS NOT SELECTABLE for a custom role. A custom role carrying it would hand
 *     its members the workbench-admin tier — a second 主管理员 by code, which §11.7's last bullet
 *     keeps off the page. This is a TIGHTENING of the ADR's "the four codes" (owner may relax it).
 *   * NO CROSS-SCOPE EFFECT (tightening): a delegated admin may change a custom role's codes or add
 *     project sheets to it only while EVERY current member is inside their delegated scope — a role's
 *     grants reach all of its members, and the delegation routes would not let this admin appoint the
 *     others. A platform admin is unbounded, as on the delegation routes. A rename is not refused.
 *   * AT MOST 100 CUSTOM ROLES (tightening), counted before any write.
 *   * PROJECT SHEETS: ADD-ONLY, WRITE LEVEL, THROUGH G1. This port never writes a sheet grant
 *     itself; the plugin hands it the G1 port call (`grantSheetRoleWrite` via the plugin-scope
 *     wrapper: plugin-owned project sheets only, role subjects only, `spreadsheet:write` literal,
 *     `ON CONFLICT DO NOTHING`). There is no remove path (ADR §11.7).
 *
 * WHO MAY CALL: a platform admin (the DB `admin` role — the legacy token claim is NOT honoured here,
 * the port sees an actor id only), or the `stock-prep` DELEGATED ADMIN — a holder of the role
 * `stock-prep_admin` whose `stock-prep` admission is effective. Everyone else is 403. A delegated
 * admin with no department / member-group scope configured FOR `stock-prep` is 403
 * ROLE_DELEGATION_SCOPE_REQUIRED, the existing delegation routes' code (admin-users.ts).
 *
 * THE SWITCH: `STOCK_PREP_MEMBERS_PAGE_ENABLED`, exact literal 'true', read per call. Off, every
 * method answers 404 STOCK_PREP_MEMBERS_PAGE_DISABLED before any IO. The plugin route checks the same
 * switch first; this is the second layer, so a future caller of the port cannot skip it.
 */

import { randomBytes } from 'node:crypto'

import type { AuditLogOptions } from '../audit/audit'
import { classifyRecoveryConflict, RECOVERY_CONFLICT_HTTP_CODE, RECOVERY_CONFLICT_HTTP_MESSAGE } from '../db/recovery-conflict'
import { deriveDelegatedAdminNamespace, roleIdMatchesNamespace } from '../rbac/namespace-admission'

// ── vocabulary ─────────────────────────────────────────────────────────────────────────────────

export const STOCK_PREP_MEMBERS_PAGE_ENABLED_ENV = 'STOCK_PREP_MEMBERS_PAGE_ENABLED'
export const STOCK_PREP_MEMBERS_PAGE_DISABLED_CODE = 'STOCK_PREP_MEMBERS_PAGE_DISABLED'

export const STOCK_PREP_MEMBERS_NAMESPACE = 'stock-prep'
export const STOCK_PREP_DELEGATED_ADMIN_ROLE_ID = 'stock-prep_admin'
/** Seeded by S5a (R-39). A missing one is reported as "not installed", never created here. */
export const STOCK_PREP_BUILTIN_ROLE_IDS = Object.freeze([
  'stock-prep_admin',
  'stock-prep_puller',
  'stock-prep_developer',
  'stock-prep_frontline',
] as const)
export const STOCK_PREP_CUSTOM_ROLE_ID_PREFIX = 'stock-prep_c_'
export const STOCK_PREP_CUSTOM_ROLE_ID_PATTERN = /^stock-prep_c_[0-9a-f]{8}$/

export const STOCK_PREP_READ_CODE = 'stock-prep:read'
export const STOCK_PREP_OPERATE_CODE = 'stock-prep:operate'
export const STOCK_PREP_ADMIN_CODE = 'stock-prep:admin'
export const STOCK_PREP_PULL_CODE = 'stock-prep:pull'
/** The four `stock-prep:*` codes (byte-equal to the plugin's STOCK_PREP_PERMISSION_CODES; pinned). */
export const STOCK_PREP_MEMBERS_PERMISSION_CODES = Object.freeze([
  STOCK_PREP_READ_CODE,
  STOCK_PREP_OPERATE_CODE,
  STOCK_PREP_ADMIN_CODE,
  STOCK_PREP_PULL_CODE,
] as const)
/** What a custom role may carry. Written here, never read from the request or the DB. */
export const STOCK_PREP_CUSTOM_ROLE_SELECTABLE_CODES = Object.freeze([
  STOCK_PREP_READ_CODE,
  STOCK_PREP_OPERATE_CODE,
  STOCK_PREP_PULL_CODE,
] as const)

export const STOCK_PREP_CUSTOM_ROLE_NAME_MAX = 64
export const STOCK_PREP_CUSTOM_ROLE_MAX_SHEETS_PER_CALL = 50
/** At most this many custom roles per deployment — a delegated admin cannot grow the role table without bound. */
export const STOCK_PREP_CUSTOM_ROLE_MAX = 100
export const STOCK_PREP_MEMBERS_AUDIT_LIMIT = 50
const CUSTOM_ROLE_ID_ATTEMPTS = 5
const AUDIT_SOURCE = 'stock-prep-members'
const SHEET_ID_PATTERN = /^[A-Za-z0-9_:.-]{1,128}$/

export function stockPrepMembersPageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[STOCK_PREP_MEMBERS_PAGE_ENABLED_ENV] === 'true'
}

export class StockPrepMembersError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'StockPrepMembersError'
    this.status = status
    this.code = code
    this.details = details
  }
}

// ── the ladder, transcribed (pinned against the plugin's satisfiesStockPrepAccess) ───────────────

/**
 * Is `code` effective for a principal holding `held` (real codes, namespace-admission filtered)?
 * The plugin's ladder, restricted to the four codes: platform admin and `stock-prep:admin` satisfy
 * read / operate / pull; operate needs read; pull needs operate and read. Unknown codes: false.
 */
export function stockPrepCodeEffective(held: readonly string[], isPlatformAdmin: boolean, code: string): boolean {
  if (!(STOCK_PREP_MEMBERS_PERMISSION_CODES as readonly string[]).includes(code)) return false
  if (isPlatformAdmin) return true
  if (held.includes(STOCK_PREP_ADMIN_CODE)) return true
  if (code === STOCK_PREP_ADMIN_CODE) return false
  if (code === STOCK_PREP_READ_CODE) return held.includes(STOCK_PREP_READ_CODE)
  const operate = held.includes(STOCK_PREP_OPERATE_CODE) && held.includes(STOCK_PREP_READ_CODE)
  if (code === STOCK_PREP_OPERATE_CODE) return operate
  return operate && held.includes(STOCK_PREP_PULL_CODE)
}

// ── pure request checks (no IO) ──────────────────────────────────────────────────────────────────

/**
 * INVARIANT 2 (and the code half of invariant 1's outer bound). Pure; runs before any IO.
 * Order, each with its own code so each check is individually observable:
 *   not an array / not a string  → 400 STOCK_PREP_CUSTOM_ROLE_CODES_INVALID
 *   outside `stock-prep:*`       → 400 STOCK_PREP_CUSTOM_ROLE_PLATFORM_CODE_FORBIDDEN
 *   not one of the four codes    → 400 STOCK_PREP_CUSTOM_ROLE_CODE_UNKNOWN
 *   not selectable (admin)       → 400 STOCK_PREP_CUSTOM_ROLE_CODE_NOT_SELECTABLE
 */
export function normalizeStockPrepCustomRoleCodes(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new StockPrepMembersError(400, 'STOCK_PREP_CUSTOM_ROLE_CODES_INVALID', 'permissionCodes must be an array of permission codes', { field: 'permissionCodes' })
  }
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new StockPrepMembersError(400, 'STOCK_PREP_CUSTOM_ROLE_CODES_INVALID', 'every permission code must be a non-empty string', { field: 'permissionCodes' })
    }
    const code = entry.trim()
    if (!code.startsWith(`${STOCK_PREP_MEMBERS_NAMESPACE}:`)) {
      // Values-free: the refused code is not echoed.
      throw new StockPrepMembersError(400, 'STOCK_PREP_CUSTOM_ROLE_PLATFORM_CODE_FORBIDDEN', 'a stock-prep custom role may carry stock-prep:* codes only', { field: 'permissionCodes' })
    }
    if (!(STOCK_PREP_MEMBERS_PERMISSION_CODES as readonly string[]).includes(code)) {
      throw new StockPrepMembersError(400, 'STOCK_PREP_CUSTOM_ROLE_CODE_UNKNOWN', 'not one of the four stock-prep permission codes', { field: 'permissionCodes' })
    }
    if (!(STOCK_PREP_CUSTOM_ROLE_SELECTABLE_CODES as readonly string[]).includes(code)) {
      throw new StockPrepMembersError(400, 'STOCK_PREP_CUSTOM_ROLE_CODE_NOT_SELECTABLE', 'stock-prep:admin is not selectable for a custom role', { field: 'permissionCodes' })
    }
    if (!out.includes(code)) out.push(code)
  }
  return out
}

export function normalizeStockPrepCustomRoleName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new StockPrepMembersError(400, 'STOCK_PREP_CUSTOM_ROLE_NAME_INVALID', 'name must be a string', { field: 'name' })
  }
  const name = raw.trim()
  // eslint-disable-next-line no-control-regex
  if (name.length === 0 || name.length > STOCK_PREP_CUSTOM_ROLE_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new StockPrepMembersError(400, 'STOCK_PREP_CUSTOM_ROLE_NAME_INVALID', `name must be 1-${STOCK_PREP_CUSTOM_ROLE_NAME_MAX} printable characters`, { field: 'name' })
  }
  return name
}

/**
 * THE ROLE-ID FENCE for every write this port makes (create's generated id and update / grant's
 * named id). Pure. Four checks, in order, each with its own code:
 *   (a) inside the `stock-prep` namespace          → 403 STOCK_PREP_ROLE_OUTSIDE_NAMESPACE
 *   (b) not a delegated-admin id (`_admin` suffix) → 403 STOCK_PREP_ROLE_ADMIN_SUFFIX_FORBIDDEN
 *   (c) not one of the four built-in ids           → 403 STOCK_PREP_BUILTIN_ROLE_READ_ONLY
 *   (d) the server-generated custom-role shape     → 403 STOCK_PREP_ROLE_NOT_CUSTOM
 */
export function assertStockPrepCustomRoleIdWritable(raw: unknown): string {
  const roleId = typeof raw === 'string' ? raw.trim() : ''
  if (!roleId || !roleIdMatchesNamespace(roleId, STOCK_PREP_MEMBERS_NAMESPACE)) {
    throw new StockPrepMembersError(403, 'STOCK_PREP_ROLE_OUTSIDE_NAMESPACE', 'this page writes roles of the stock-prep namespace only', { field: 'roleId' })
  }
  if (deriveDelegatedAdminNamespace(roleId) !== null) {
    throw new StockPrepMembersError(403, 'STOCK_PREP_ROLE_ADMIN_SUFFIX_FORBIDDEN', 'a role whose id ends in _admin is a delegated-admin role and is never written here', { field: 'roleId' })
  }
  if ((STOCK_PREP_BUILTIN_ROLE_IDS as readonly string[]).includes(roleId)) {
    throw new StockPrepMembersError(403, 'STOCK_PREP_BUILTIN_ROLE_READ_ONLY', 'the built-in stock-prep roles are read-only here', { field: 'roleId' })
  }
  if (!STOCK_PREP_CUSTOM_ROLE_ID_PATTERN.test(roleId)) {
    throw new StockPrepMembersError(403, 'STOCK_PREP_ROLE_NOT_CUSTOM', 'only server-generated custom roles (stock-prep_c_…) are written here', { field: 'roleId' })
  }
  return roleId
}

function normalizeActorId(raw: unknown): string {
  const actorId = typeof raw === 'string' ? raw.trim() : (typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : '')
  if (!actorId) throw new StockPrepMembersError(401, 'STOCK_PREP_MEMBERS_UNAUTHENTICATED', 'authentication required')
  return actorId
}

// ── the port ─────────────────────────────────────────────────────────────────────────────────────

export type StockPrepMembersQueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export interface StockPrepMembersDeps {
  query: StockPrepMembersQueryFn
  transaction: <T>(fn: (query: StockPrepMembersQueryFn) => Promise<T>) => Promise<T>
  /** DB `admin` role membership (rbac/service.ts `isAdmin`). */
  isPlatformAdmin: (userId: string) => Promise<boolean>
  /** The actor's CURRENT effective codes (fresh, admission-filtered — rbac/service.ts). */
  listEffectivePermissions: (userId: string) => Promise<string[]>
  /** namespace-admission.ts `userHasEffectiveNamespaceAccess`. */
  hasEffectiveNamespaceAdmission: (userId: string, namespace: string) => Promise<boolean>
  /** The grid's own readability decision (permission-service.ts `resolveReadableSheetIds`). */
  resolveReadableSheetIds: (userId: string, sheetIds: string[]) => Promise<Set<string>>
  auditLog: (entry: AuditLogOptions) => Promise<void>
  invalidateUserPerms: (userId: string) => void
  env?: () => NodeJS.ProcessEnv
  randomSuffix?: () => string
}

export interface StockPrepMembersCaller {
  actorId: string
  isPlatformAdmin: boolean
  delegated: boolean
}

export interface StockPrepMembersGrantTarget {
  sheetId: string
  /** The plugin's G1 call for THIS sheet and THIS role (grantSheetRoleWrite through plugin-scope). */
  grant: () => Promise<{ granted: boolean }>
}

export interface StockPrepMembersPort {
  describe(input: { actorId: unknown }): Promise<Record<string, unknown>>
  createCustomRole(input: { actorId: unknown; name: unknown; permissionCodes: unknown }): Promise<Record<string, unknown>>
  updateCustomRole(input: { actorId: unknown; roleId: unknown; name?: unknown; permissionCodes?: unknown }): Promise<Record<string, unknown>>
  grantCustomRoleProjectSheets(input: {
    actorId: unknown
    roleId: unknown
    resolveTargets: () => Promise<StockPrepMembersGrantTarget[]>
  }): Promise<Record<string, unknown>>
}

type RoleRow = { id: string; name: string; permissions: string[] }
type MemberRow = { role_id: string; user_id: string; name: string | null; email: string | null; username: string | null; admission_enabled: boolean | null }

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : []
}

/**
 * The delegated scope, batched: of `userIds`, the ones inside the actor's department tree or member
 * groups FOR `stock-prep`. The SAME recursive shape as admin-users.ts `isUserWithinDelegatedScope`
 * (seed departments → active descendants → linked active accounts; plus member groups), asked for a
 * set instead of one user. The unit suite pins the load-bearing clauses.
 */
export const STOCK_PREP_MEMBERS_SCOPED_USERS_SQL = `WITH RECURSIVE seed_departments AS (
    SELECT DISTINCT d.id, d.integration_id, d.external_department_id
    FROM delegated_role_admin_scopes s
    JOIN directory_departments d ON d.id = s.directory_department_id
    WHERE s.admin_user_id = $1
      AND s.namespace = $2
      AND d.is_active = true
  ),
  allowed_departments AS (
    SELECT id, integration_id, external_department_id
    FROM seed_departments
    UNION
    SELECT child.id, child.integration_id, child.external_department_id
    FROM directory_departments child
    JOIN allowed_departments parent
      ON child.integration_id = parent.integration_id
     AND child.external_parent_department_id = parent.external_department_id
    WHERE child.is_active = true
  ),
  allowed_groups AS (
    SELECT DISTINCT gscope.group_id
    FROM delegated_role_admin_member_groups gscope
    WHERE gscope.admin_user_id = $1
      AND gscope.namespace = $2
  )
  SELECT DISTINCT l.local_user_id AS user_id
  FROM directory_account_links l
  JOIN directory_accounts a
    ON a.id = l.directory_account_id
   AND a.is_active = true
  JOIN directory_account_departments ad
    ON ad.directory_account_id = a.id
  JOIN allowed_departments scoped
    ON scoped.id = ad.directory_department_id
  WHERE l.link_status = 'linked'
    AND l.local_user_id = ANY($3::text[])
  UNION
  SELECT DISTINCT gm.user_id
  FROM platform_member_group_members gm
  JOIN allowed_groups scoped_groups
    ON scoped_groups.group_id = gm.group_id
  WHERE gm.user_id = ANY($3::text[])`

/** Scope REQUIRED: at least one department or member-group scope for `stock-prep` (admin-users.ts joins). */
export const STOCK_PREP_MEMBERS_SCOPE_CONFIGURED_SQL = `SELECT (
    EXISTS (
      SELECT 1
      FROM delegated_role_admin_scopes s
      JOIN directory_departments d ON d.id = s.directory_department_id
      JOIN directory_integrations i ON i.id = d.integration_id
      WHERE s.admin_user_id = $1 AND s.namespace = $2
    )
    OR EXISTS (
      SELECT 1
      FROM delegated_role_admin_member_groups gscope
      JOIN platform_member_groups g ON g.id = gscope.group_id
      WHERE gscope.admin_user_id = $1 AND gscope.namespace = $2
    )
  ) AS configured`

export function createStockPrepMembersPort(deps: StockPrepMembersDeps): StockPrepMembersPort {
  const readEnv = deps.env ?? (() => process.env)
  const randomSuffix = deps.randomSuffix ?? (() => randomBytes(4).toString('hex'))

  /** THE SWITCH — first, pure, before any IO. */
  function assertEnabled(): void {
    if (!stockPrepMembersPageEnabled(readEnv())) {
      throw new StockPrepMembersError(404, STOCK_PREP_MEMBERS_PAGE_DISABLED_CODE, `the stock-prep members page is disabled on this deployment (${STOCK_PREP_MEMBERS_PAGE_ENABLED_ENV} is not 'true')`)
    }
  }

  /**
   * THE CALLER TIER. Platform admin (DB) → admitted. Otherwise the actor must hold the role
   * `stock-prep_admin` AND have an effective `stock-prep` admission, else 403; and a delegated admin
   * must have a department / member-group scope for `stock-prep`, else 403
   * ROLE_DELEGATION_SCOPE_REQUIRED.
   */
  async function resolveCaller(rawActorId: unknown): Promise<StockPrepMembersCaller> {
    const actorId = normalizeActorId(rawActorId)
    if (await deps.isPlatformAdmin(actorId)) return { actorId, isPlatformAdmin: true, delegated: false }
    const held = await deps.query(
      'SELECT 1 AS held FROM user_roles WHERE user_id = $1 AND role_id = $2 LIMIT 1',
      [actorId, STOCK_PREP_DELEGATED_ADMIN_ROLE_ID],
    )
    if ((held.rows as unknown[]).length === 0) {
      throw new StockPrepMembersError(403, 'STOCK_PREP_MEMBERS_FORBIDDEN', 'only a platform administrator or the stock-prep main administrator may manage stock-prep members')
    }
    if (!(await deps.hasEffectiveNamespaceAdmission(actorId, STOCK_PREP_MEMBERS_NAMESPACE))) {
      throw new StockPrepMembersError(403, 'STOCK_PREP_MEMBERS_FORBIDDEN', 'the stock-prep main administrator role is held but its plugin admission is not enabled', { reason: 'admission' })
    }
    const scope = await deps.query(STOCK_PREP_MEMBERS_SCOPE_CONFIGURED_SQL, [actorId, STOCK_PREP_MEMBERS_NAMESPACE])
    const configured = (scope.rows as Array<{ configured?: unknown }>)[0]?.configured === true
    if (!configured) {
      throw new StockPrepMembersError(403, 'ROLE_DELEGATION_SCOPE_REQUIRED', 'No delegated department or member-group scope is configured for your plugin admin role')
    }
    return { actorId, isPlatformAdmin: false, delegated: true }
  }

  /** INVARIANT 1, code half: what this grantor may hand out, read fresh. */
  async function grantorSelectableCodes(caller: StockPrepMembersCaller): Promise<string[]> {
    const held = caller.isPlatformAdmin ? [] : await deps.listEffectivePermissions(caller.actorId)
    return (STOCK_PREP_CUSTOM_ROLE_SELECTABLE_CODES as readonly string[])
      .filter((code) => stockPrepCodeEffective(held, caller.isPlatformAdmin, code))
  }

  async function assertCodesWithinGrantor(caller: StockPrepMembersCaller, codes: readonly string[]): Promise<void> {
    if (codes.length === 0) return
    const allowed = await grantorSelectableCodes(caller)
    const exceeding = codes.filter((code) => !allowed.includes(code))
    if (exceeding.length > 0) {
      throw new StockPrepMembersError(403, 'STOCK_PREP_CUSTOM_ROLE_EXCEEDS_GRANTOR', 'a custom role may not carry a code the grantor does not currently hold', { exceedingCount: exceeding.length })
    }
  }

  /**
   * NO CROSS-SCOPE EFFECT. A role's codes and project sheets reach EVERY member of it, so a delegated
   * admin may change them only while every current member is inside their own delegated scope — the
   * same audience the delegation routes let them appoint. Otherwise a delegated admin could raise the
   * access of people they may not manage (members a platform admin or another delegated admin
   * appointed). A platform admin is unbounded here, as on the delegation routes. A rename alone
   * changes nobody's access and is not refused.
   */
  async function assertRoleMembersWithinScope(caller: StockPrepMembersCaller, roleId: string): Promise<void> {
    if (!caller.delegated) return
    const members = await deps.query('SELECT user_id FROM user_roles WHERE role_id = $1', [roleId])
    const memberIds = Array.from(new Set((members.rows as Array<{ user_id?: unknown }>).map((row) => String(row.user_id ?? '')).filter(Boolean)))
    if (memberIds.length === 0) return
    const inScope = await loadScopedUserIds(caller, memberIds)
    const outside = memberIds.filter((userId) => !inScope.has(userId))
    if (outside.length > 0) {
      throw new StockPrepMembersError(403, 'STOCK_PREP_CUSTOM_ROLE_MEMBERS_OUT_OF_SCOPE', 'this role has members outside your delegated scope; only a platform administrator may change what it grants', { outOfScopeCount: outside.length })
    }
  }

  async function assertCodesInCatalog(query: StockPrepMembersQueryFn, codes: readonly string[]): Promise<void> {
    if (codes.length === 0) return
    const known = await query('SELECT code FROM permissions WHERE code = ANY($1::text[])', [codes])
    const knownCodes = new Set((known.rows as Array<{ code?: unknown }>).map((row) => String(row.code ?? '')))
    const unknown = codes.filter((code) => !knownCodes.has(code))
    if (unknown.length > 0) {
      throw new StockPrepMembersError(400, 'UNKNOWN_PERMISSION_CODE', `${unknown.length} permission code(s) are not in the permissions catalog`, { unknownCount: unknown.length })
    }
  }

  function delegationMeta(caller: StockPrepMembersCaller): Record<string, unknown> {
    return {
      adminUserId: caller.actorId,
      delegated: caller.delegated,
      delegableNamespaces: caller.delegated ? [STOCK_PREP_MEMBERS_NAMESPACE] : [],
      source: AUDIT_SOURCE,
    }
  }

  async function runWrite<T>(fn: (query: StockPrepMembersQueryFn) => Promise<T>): Promise<T> {
    try {
      return await deps.transaction(fn)
    } catch (error) {
      if (error instanceof StockPrepMembersError) throw error
      // role_permissions is a recovery-authority table: a held recovery lease answers the uniform
      // retryable 409 (routes/roles.ts does the same).
      if (classifyRecoveryConflict(error) === 'recovery_conflict') {
        throw new StockPrepMembersError(409, RECOVERY_CONFLICT_HTTP_CODE, RECOVERY_CONFLICT_HTTP_MESSAGE, { retryable: true })
      }
      throw error
    }
  }

  async function invalidateRoleMembers(roleId: string): Promise<void> {
    try {
      const members = await deps.query('SELECT user_id FROM user_roles WHERE role_id = $1', [roleId])
      for (const row of members.rows as Array<{ user_id?: unknown }>) {
        const userId = typeof row.user_id === 'string' ? row.user_id : ''
        if (userId) deps.invalidateUserPerms(userId)
      }
    } catch {
      // Post-commit and best-effort (routes/roles.ts settlePostCommitEffect): the write landed; the
      // permission memo expires on its own TTL.
    }
  }

  async function loadNamespaceRoles(): Promise<RoleRow[]> {
    const result = await deps.query(
      `SELECT r.id, r.name,
              COALESCE(array_remove(array_agg(DISTINCT rp.permission_code), NULL), ARRAY[]::text[]) AS permissions
         FROM roles r
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
        WHERE r.id = $1 OR r.id LIKE $2 ESCAPE '\\'
        GROUP BY r.id, r.name
        ORDER BY r.id ASC`,
      [STOCK_PREP_MEMBERS_NAMESPACE, `${STOCK_PREP_MEMBERS_NAMESPACE}\\_%`],
    )
    return (result.rows as Array<{ id?: unknown; name?: unknown; permissions?: unknown }>)
      .filter((row) => typeof row.id === 'string' && roleIdMatchesNamespace(row.id, STOCK_PREP_MEMBERS_NAMESPACE))
      .map((row) => ({ id: row.id as string, name: typeof row.name === 'string' ? row.name : '', permissions: stringList(row.permissions) }))
  }

  async function loadScopedUserIds(caller: StockPrepMembersCaller, userIds: string[]): Promise<Set<string>> {
    if (caller.isPlatformAdmin) return new Set(userIds)
    if (userIds.length === 0) return new Set()
    const result = await deps.query(STOCK_PREP_MEMBERS_SCOPED_USERS_SQL, [caller.actorId, STOCK_PREP_MEMBERS_NAMESPACE, userIds])
    return new Set((result.rows as Array<{ user_id?: unknown }>).map((row) => String(row.user_id ?? '')).filter(Boolean))
  }

  function auditEntryProjection(row: Record<string, unknown>): Record<string, unknown> {
    let meta: Record<string, unknown> = {}
    const raw = row.action_details
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) meta = raw as Record<string, unknown>
    else if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>
      } catch {
        meta = {}
      }
    }
    const pick = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null)
    const resourceType = pick(row.resource_type)
    const resourceId = pick(row.resource_id) ?? ''
    const sep = resourceId.lastIndexOf(':')
    return {
      at: row.created_at instanceof Date ? row.created_at.toISOString() : pick(row.created_at),
      action: pick(row.action),
      resourceType,
      actorId: pick(meta.adminUserId),
      userId: pick(meta.userId) ?? (resourceType === 'user-role' || resourceType === 'user-namespace-admission' ? (sep > 0 ? resourceId.slice(0, sep) : null) : null),
      roleId: pick(meta.roleId) ?? (resourceType === 'role' ? resourceId || null : null),
      namespace: pick(meta.namespace),
      sheetId: pick(meta.sheetId),
      enabled: typeof meta.enabled === 'boolean' ? meta.enabled : null,
      delegated: typeof meta.delegated === 'boolean' ? meta.delegated : null,
    }
  }

  async function loadAudit(): Promise<{ available: boolean; entries: Array<Record<string, unknown>> }> {
    try {
      const result = await deps.query(
        `SELECT id, created_at, action, resource_type, resource_id, action_details
           FROM audit_logs
          WHERE (resource_type = 'role' AND (resource_id = $1 OR resource_id LIKE $2 ESCAPE '\\'))
             OR (resource_type = 'user-role' AND (resource_id LIKE $3 ESCAPE '\\' OR resource_id LIKE $4))
             OR (resource_type = 'user-namespace-admission' AND resource_id LIKE $4)
          ORDER BY created_at DESC
          LIMIT $5`,
        [
          STOCK_PREP_MEMBERS_NAMESPACE,
          `${STOCK_PREP_MEMBERS_NAMESPACE}\\_%`,
          `%:${STOCK_PREP_MEMBERS_NAMESPACE}\\_%`,
          `%:${STOCK_PREP_MEMBERS_NAMESPACE}`,
          STOCK_PREP_MEMBERS_AUDIT_LIMIT,
        ],
      )
      return { available: true, entries: (result.rows as Array<Record<string, unknown>>).map(auditEntryProjection) }
    } catch {
      // A read-only section of the page: an unreadable audit table degrades to "unavailable" rather
      // than taking the member list down with it. Nothing is written on this path.
      return { available: false, entries: [] }
    }
  }

  return {
    async describe({ actorId }) {
      assertEnabled()
      const caller = await resolveCaller(actorId)
      const grantableCodes = await grantorSelectableCodes(caller)
      const roles = await loadNamespaceRoles()
      const roleIds = roles.map((role) => role.id)
      const membersResult = roleIds.length === 0
        ? { rows: [] as unknown[] }
        : await deps.query(
          `SELECT ur.role_id, u.id AS user_id, u.name, u.email, u.username,
                  una.enabled AS admission_enabled
             FROM user_roles ur
             JOIN users u ON u.id = ur.user_id
             LEFT JOIN user_namespace_admissions una
               ON una.user_id = ur.user_id AND una.namespace = $1
            WHERE ur.role_id = ANY($2::text[])
            ORDER BY ur.role_id ASC, u.name ASC NULLS LAST, u.id ASC`,
          [STOCK_PREP_MEMBERS_NAMESPACE, roleIds],
        )
      const memberRows = membersResult.rows as MemberRow[]
      const audit = await loadAudit()
      const auditUserIds = audit.entries.map((entry) => entry.userId).filter((id): id is string => typeof id === 'string')
      const inScope = await loadScopedUserIds(caller, Array.from(new Set([...memberRows.map((row) => row.user_id), ...auditUserIds])))

      const customRoleIds = roles.filter((role) => STOCK_PREP_CUSTOM_ROLE_ID_PATTERN.test(role.id)).map((role) => role.id)
      const sheetsByRole = new Map<string, string[]>()
      if (customRoleIds.length > 0) {
        const sheetRows = await deps.query(
          `SELECT subject_id AS role_id, sheet_id
             FROM spreadsheet_permissions
            WHERE subject_type = 'role' AND subject_id = ANY($1::text[]) AND perm_code = 'spreadsheet:write'
            ORDER BY sheet_id ASC`,
          [customRoleIds],
        )
        for (const row of sheetRows.rows as Array<{ role_id?: unknown; sheet_id?: unknown }>) {
          const roleId = String(row.role_id ?? '')
          const sheetId = String(row.sheet_id ?? '')
          if (!roleId || !sheetId) continue
          const list = sheetsByRole.get(roleId) ?? []
          list.push(sheetId)
          sheetsByRole.set(roleId, list)
        }
      }
      const allSheetIds = Array.from(new Set(Array.from(sheetsByRole.values()).flat()))
      const readableSheets = allSheetIds.length > 0 ? await deps.resolveReadableSheetIds(caller.actorId, allSheetIds) : new Set<string>()

      const roleView = (role: RoleRow | null, id: string, kind: 'builtin' | 'custom' | 'other') => {
        const members = memberRows.filter((row) => row.role_id === id)
        const visible = members.filter((row) => inScope.has(row.user_id))
        const stockPrepCodes = role ? role.permissions.filter((code) => code.startsWith(`${STOCK_PREP_MEMBERS_NAMESPACE}:`)).sort() : []
        const sheetIds = sheetsByRole.get(id) ?? []
        return {
          id,
          kind,
          installed: role !== null,
          name: role ? role.name : null,
          permissionCodes: stockPrepCodes,
          otherCodeCount: role ? role.permissions.length - stockPrepCodes.length : 0,
          editable: kind === 'custom',
          // The page never offers appointing the main administrator (ADR §11.7, last bullet).
          appointable: role !== null && kind !== 'other' && id !== STOCK_PREP_DELEGATED_ADMIN_ROLE_ID,
          members: visible.map((row) => ({
            userId: row.user_id,
            name: row.name ?? null,
            email: row.email ?? null,
            username: row.username ?? null,
            admitted: row.admission_enabled === true,
          })),
          outOfScopeMemberCount: members.length - visible.length,
          ...(kind === 'custom'
            ? {
                sheetIds: sheetIds.filter((sheetId) => readableSheets.has(sheetId)),
                otherSheetCount: sheetIds.filter((sheetId) => !readableSheets.has(sheetId)).length,
              }
            : {}),
        }
      }

      const byId = new Map(roles.map((role) => [role.id, role]))
      return {
        enabled: true,
        actor: {
          isPlatformAdmin: caller.isPlatformAdmin,
          delegated: caller.delegated,
          scopeConfigured: true,
        },
        grantableCodes,
        selectableCodes: [...STOCK_PREP_CUSTOM_ROLE_SELECTABLE_CODES],
        builtInRoles: (STOCK_PREP_BUILTIN_ROLE_IDS as readonly string[]).map((id) => roleView(byId.get(id) ?? null, id, 'builtin')),
        customRoles: customRoleIds.map((id) => roleView(byId.get(id) ?? null, id, 'custom')),
        otherRoles: roles
          .filter((role) => !(STOCK_PREP_BUILTIN_ROLE_IDS as readonly string[]).includes(role.id) && !STOCK_PREP_CUSTOM_ROLE_ID_PATTERN.test(role.id))
          .map((role) => roleView(role, role.id, 'other')),
        audit: {
          available: audit.available,
          entries: audit.entries.filter((entry) => typeof entry.userId !== 'string' || inScope.has(entry.userId)),
        },
      }
    },

    async createCustomRole({ actorId, name, permissionCodes }) {
      assertEnabled()
      const roleName = normalizeStockPrepCustomRoleName(name)
      const codes = normalizeStockPrepCustomRoleCodes(permissionCodes)
      const caller = await resolveCaller(actorId)
      await assertCodesWithinGrantor(caller, codes)
      const existing = await deps.query(
        `SELECT COUNT(*)::int AS c FROM roles WHERE id LIKE $1 ESCAPE '\\'`,
        [`${STOCK_PREP_CUSTOM_ROLE_ID_PREFIX.replace(/_/g, '\\_')}%`],
      )
      const existingCount = Number((existing.rows as Array<{ c?: unknown }>)[0]?.c ?? 0)
      if (!Number.isFinite(existingCount) || existingCount >= STOCK_PREP_CUSTOM_ROLE_MAX) {
        throw new StockPrepMembersError(409, 'STOCK_PREP_CUSTOM_ROLE_LIMIT', `at most ${STOCK_PREP_CUSTOM_ROLE_MAX} custom roles`, { limit: STOCK_PREP_CUSTOM_ROLE_MAX })
      }
      let roleId: string | null = null
      for (let attempt = 0; attempt < CUSTOM_ROLE_ID_ATTEMPTS && roleId === null; attempt += 1) {
        const candidate = assertStockPrepCustomRoleIdWritable(`${STOCK_PREP_CUSTOM_ROLE_ID_PREFIX}${randomSuffix()}`)
        const inserted = await runWrite(async (query) => {
          await assertCodesInCatalog(query, codes)
          const row = await query('INSERT INTO roles (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id', [candidate, roleName])
          if ((row.rows as unknown[]).length === 0) return false
          for (const code of codes) {
            await query('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING', [candidate, code])
          }
          return true
        })
        if (inserted) roleId = candidate
      }
      if (roleId === null) {
        throw new StockPrepMembersError(503, 'STOCK_PREP_CUSTOM_ROLE_ID_EXHAUSTED', 'could not allocate a custom role id; retry')
      }
      await deps.auditLog({
        actorId: caller.actorId,
        actorType: 'user',
        action: 'create',
        resourceType: 'role',
        resourceId: roleId,
        meta: { ...delegationMeta(caller), roleId, name: roleName, permissions: codes },
      })
      return { roleId, name: roleName, permissionCodes: codes }
    },

    async updateCustomRole({ actorId, roleId, name, permissionCodes }) {
      assertEnabled()
      const id = assertStockPrepCustomRoleIdWritable(roleId)
      const nextName = name === undefined ? undefined : normalizeStockPrepCustomRoleName(name)
      const nextCodes = permissionCodes === undefined ? undefined : normalizeStockPrepCustomRoleCodes(permissionCodes)
      if (nextName === undefined && nextCodes === undefined) {
        throw new StockPrepMembersError(400, 'STOCK_PREP_CUSTOM_ROLE_PATCH_EMPTY', 'name or permissionCodes is required')
      }
      const caller = await resolveCaller(actorId)
      if (nextCodes !== undefined) {
        await assertCodesWithinGrantor(caller, nextCodes)
        await assertRoleMembersWithinScope(caller, id)
      }
      const outcome = await runWrite(async (query) => {
        const locked = await query('SELECT id, name FROM roles WHERE id = $1 FOR UPDATE', [id])
        const lockedRow = (locked.rows as Array<{ id?: unknown; name?: unknown }>)[0]
        if (!lockedRow) {
          throw new StockPrepMembersError(404, 'STOCK_PREP_CUSTOM_ROLE_NOT_FOUND', 'custom role not found', { field: 'roleId' })
        }
        let added: string[] = []
        let removed: string[] = []
        let after: string[] = []
        if (nextCodes !== undefined) {
          await assertCodesInCatalog(query, nextCodes)
          const current = await query('SELECT permission_code FROM role_permissions WHERE role_id = $1', [id])
          // ONLY `stock-prep:*` rows are this port's to change; any other row on the role is left
          // exactly as it is (and is never added by this port).
          const currentStockPrep = (current.rows as Array<{ permission_code?: unknown }>)
            .map((row) => String(row.permission_code ?? ''))
            .filter((code) => code.startsWith(`${STOCK_PREP_MEMBERS_NAMESPACE}:`))
          added = nextCodes.filter((code) => !currentStockPrep.includes(code))
          removed = currentStockPrep.filter((code) => !nextCodes.includes(code))
          if (removed.length > 0) {
            await query('DELETE FROM role_permissions WHERE role_id = $1 AND permission_code = ANY($2::text[])', [id, removed])
          }
          for (const code of added) {
            await query('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, code])
          }
          after = [...nextCodes]
        }
        const finalName = nextName ?? (typeof lockedRow.name === 'string' ? lockedRow.name : '')
        await query('UPDATE roles SET name = $1, updated_at = now() WHERE id = $2', [finalName, id])
        return { name: finalName, added, removed, after }
      })
      if (outcome.added.length > 0 || outcome.removed.length > 0) await invalidateRoleMembers(id)
      await deps.auditLog({
        actorId: caller.actorId,
        actorType: 'user',
        action: 'update',
        resourceType: 'role',
        resourceId: id,
        meta: {
          ...delegationMeta(caller),
          roleId: id,
          name: outcome.name,
          ...(nextCodes !== undefined ? { permissions: outcome.after, permissionsAdded: outcome.added, permissionsRemoved: outcome.removed } : {}),
        },
      })
      return {
        roleId: id,
        name: outcome.name,
        ...(nextCodes !== undefined ? { permissionCodes: outcome.after, added: outcome.added, removed: outcome.removed } : {}),
      }
    },

    async grantCustomRoleProjectSheets({ actorId, roleId, resolveTargets }) {
      assertEnabled()
      const id = assertStockPrepCustomRoleIdWritable(roleId)
      if (typeof resolveTargets !== 'function') {
        throw new StockPrepMembersError(500, 'STOCK_PREP_MEMBERS_INTERNAL', 'grant targets resolver is required')
      }
      const caller = await resolveCaller(actorId)
      const exists = await deps.query('SELECT id FROM roles WHERE id = $1', [id])
      if ((exists.rows as unknown[]).length === 0) {
        throw new StockPrepMembersError(404, 'STOCK_PREP_CUSTOM_ROLE_NOT_FOUND', 'custom role not found', { field: 'roleId' })
      }
      await assertRoleMembersWithinScope(caller, id)
      const targets = await resolveTargets()
      if (!Array.isArray(targets) || targets.length === 0 || targets.length > STOCK_PREP_CUSTOM_ROLE_MAX_SHEETS_PER_CALL) {
        throw new StockPrepMembersError(400, 'STOCK_PREP_CUSTOM_ROLE_SHEETS_INVALID', `1-${STOCK_PREP_CUSTOM_ROLE_MAX_SHEETS_PER_CALL} project sheets per call`, { field: 'projectNos' })
      }
      const seen = new Set<string>()
      for (const target of targets) {
        const sheetId = target && typeof target.sheetId === 'string' ? target.sheetId : ''
        if (!SHEET_ID_PATTERN.test(sheetId) || typeof target.grant !== 'function' || seen.has(sheetId)) {
          throw new StockPrepMembersError(400, 'STOCK_PREP_CUSTOM_ROLE_SHEETS_INVALID', 'every project sheet must be a distinct sheet handle', { field: 'projectNos' })
        }
        seen.add(sheetId)
      }
      // INVARIANT 1, table half: every sheet must be one the GRANTOR can read, decided by the grid's
      // own readability resolver. Refused as a whole, before any grant.
      const sheetIds = Array.from(seen)
      const readable = await deps.resolveReadableSheetIds(caller.actorId, sheetIds)
      const unreadable = sheetIds.filter((sheetId) => !readable.has(sheetId))
      if (unreadable.length > 0) {
        throw new StockPrepMembersError(403, 'STOCK_PREP_CUSTOM_ROLE_SHEET_NOT_READABLE', 'a custom role may be given only project sheets the grantor can read', { unreadableCount: unreadable.length })
      }
      const results: Array<{ sheetId: string; granted: boolean }> = []
      for (const target of targets) {
        const outcome = await target.grant()
        const granted = Boolean(outcome && outcome.granted === true)
        // Audited per landed call, immediately — a later sheet's failure cannot leave an earlier
        // grant unrecorded.
        await deps.auditLog({
          actorId: caller.actorId,
          actorType: 'user',
          action: 'grant',
          resourceType: 'role',
          resourceId: id,
          meta: { ...delegationMeta(caller), roleId: id, sheetId: target.sheetId, permission: 'spreadsheet:write', granted },
        })
        results.push({ sheetId: target.sheetId, granted })
      }
      return { roleId: id, sheets: results }
    },
  }
}
