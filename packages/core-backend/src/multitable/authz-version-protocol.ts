/**
 * D21 authorization version protocol — the application half (slice Y5a, design baseline v2.3 §7.2
 * 「分界是准入提交」). INFRASTRUCTURE ONLY: nothing here decides an authorization. Slice Y5 wires the
 * lock helper into the YiDa approval and admission transactions and reads the four checks from the
 * rows this helper locked, never from `req.user` or the 60 s RBAC cache.
 *
 * The two version rows live in `sheet_permission_versions` (key: sheet id) and
 * `subject_authorization_versions` (key: user id); the migration
 * `zzzz20261106110500_add_authorization_version_rows.ts` installs them together with the BEFORE ROW
 * triggers that bump them inside every writer's transaction (raw SQL, migrations, FK cascades and
 * plugin raw queries included). The explicit bump helpers below are what TypeScript writers call as
 * their FIRST protocol statement, in CANONICAL ORDER (sheet ids ascending, then user ids ascending),
 * so that writer and admission acquire the same rows in the same order; the triggers stay the
 * completeness safety net.
 *
 * LOCK ORDER of the admission helper (fixed, documented, the same every time):
 *   1. `sheet_permission_versions`     — one row per bound sheet, ascending, upsert then FOR SHARE
 *   2. `subject_authorization_versions` — the actor's row, upsert then FOR SHARE
 *   3. the live-authority order of `src/integration/automation-live-authority.ts:58-59`, FOR SHARE:
 *      `user_roles` → `role_permissions` → `user_permissions` → `users` → `user_orgs`
 *      → `user_namespace_admissions`
 *   4. optionally the ONE bound `meta_records` row, FOR SHARE (conditional-read rules are evaluated
 *      on the value read after the lock; ordinary record writes never bump a table-wide version)
 *
 * Compatibility with the pre-existing in-transaction protocols (all documented, none changed):
 *   - record-link phases (`services/approval-record-link-txn-auth.ts`): phases 1–4 take FOR SHARE
 *     (compatible with the holder); phase 5 takes `meta_records` FOR UPDATE, so the record-permission
 *     PUT / DELETE routes bump their sheet row as the FIRST statement, ahead of the phases — writer
 *     order = sheet row → … → record, the holder's order;
 *   - `services/stock-preparation-members.ts` locks (`roles` FOR UPDATE / advisory, grantor rows FOR
 *     SHARE, `spreadsheet_permissions` FOR SHARE): none of them is in the holder's lock set, and its
 *     writes bump through the triggers after those locks; it never waits on a holder for anything the
 *     holder waits on it for;
 *   - `rbac/namespace-admission.ts` advisory `lockNamespaceAdmissionWrites`: outside the holder's set;
 *   - `LOCK TABLE … IN SHARE / SHARE ROW EXCLUSIVE MODE` sites (automation-executor.ts,
 *     dingtalk-identity-repair.ts, controlled-handover.ts): compatible with FOR SHARE (ROW SHARE);
 *     the version tables are new tables those statements do not name;
 *   - attendance guard triggers that take `users` / `user_orgs` rows FOR UPDATE from attendance
 *     tables (zzzz20260723140000, zzzz20261012100000): they write no covered table, so they bump
 *     nothing; they wait on a holder's FOR SHARE until commit (bounded) and can never form a cycle;
 *   - `directory/access-graph-mutex.ts lockUsersForAccessGraphWrite` (14 writer files): bumps the
 *     subject rows FIRST, sorted, before `users … FOR UPDATE`, so writer order = subject → users,
 *     the holder's order (judge delta B).
 *
 * DEADLOCKS. Holder-vs-writer pairs that follow the canonical order cannot deadlock. A writer that
 * acquires an exclusive lock in another order (the legacy operator-role script, a multi-row cascade,
 * a long directory sync) can form a cycle with a holder; PostgreSQL raises 40P01 in the backend that
 * detects it. The helper maps 40P01 / 40001 / 55P03 to a typed CONFLICT, never to success — the
 * caller rolls back and retries. Writer-side error mapping is unchanged.
 *
 * No heavy imports: callers include the route layer, the access-graph mutex and the RBAC helpers.
 */
import { assertInTransaction } from './pg-transaction-guard'
import {
  AUTHORIZATION_VERSION_TRIGGERS,
  SHEET_PERMISSION_VERSIONS_TABLE,
  SUBJECT_AUTHORIZATION_VERSIONS_TABLE,
} from '../db/migrations/zzzz20261106110500_add_authorization_version_rows'

export {
  AUTHORIZATION_VERSION_COVERED_TABLES,
  AUTHORIZATION_VERSION_TRIGGERS,
  META_SHEETS_AUTHORITY_COLUMNS,
  SHEET_PERMISSION_VERSIONS_TABLE,
  SUBJECT_AUTHORIZATION_VERSIONS_TABLE,
  USERS_AUTHORITY_COLUMNS,
} from '../db/migrations/zzzz20261106110500_add_authorization_version_rows'

type QueryResultLike = { rows?: unknown[]; rowCount?: number | null } | unknown

export type AuthorizationVersionQueryFn = (sql: string, params?: unknown[]) => Promise<QueryResultLike>

/** A transaction client (`{ query }`) or the bare `query` function the pool transaction hands out. */
export type AuthorizationVersionQueryable =
  | AuthorizationVersionQueryFn
  | { query: AuthorizationVersionQueryFn }

export const LIVE_AUTHORITY_LOCK_ORDER = Object.freeze([
  'user_roles',
  'role_permissions',
  'user_permissions',
  'users',
  'user_orgs',
  'user_namespace_admissions',
] as const)

export const ADMISSION_LOCK_ORDER = Object.freeze([
  SHEET_PERMISSION_VERSIONS_TABLE,
  SUBJECT_AUTHORIZATION_VERSIONS_TABLE,
  ...LIVE_AUTHORITY_LOCK_ORDER,
  'meta_records',
] as const)

/**
 * The explicit multi-row bump. `unnest … WITH ORDINALITY … ORDER BY ord` inserts (and therefore locks)
 * the rows in the caller-sorted order; the statement is the same upsert the triggers run, so a
 * version is monotonic but not a count (a writer that bumps explicitly and then fires a trigger
 * advances it twice).
 */
export const SHEET_PERMISSION_VERSIONS_BUMP_SQL = `INSERT INTO ${SHEET_PERMISSION_VERSIONS_TABLE} AS v (sheet_id, version, updated_at)
SELECT s.sheet_id, 1, now()
  FROM unnest($1::text[]) WITH ORDINALITY AS s(sheet_id, ord)
 ORDER BY s.ord
ON CONFLICT (sheet_id) DO UPDATE
  SET version = v.version + 1,
      updated_at = now()`

export const SUBJECT_AUTHORIZATION_VERSIONS_BUMP_SQL = `INSERT INTO ${SUBJECT_AUTHORIZATION_VERSIONS_TABLE} AS v (subject_id, version, updated_at)
SELECT s.subject_id, 1, now()
  FROM unnest($1::text[]) WITH ORDINALITY AS s(subject_id, ord)
 ORDER BY s.ord
ON CONFLICT (subject_id) DO UPDATE
  SET version = v.version + 1,
      updated_at = now()`

const SHEET_VERSION_ENSURE_SQL = `INSERT INTO ${SHEET_PERMISSION_VERSIONS_TABLE} (sheet_id) VALUES ($1) ON CONFLICT (sheet_id) DO NOTHING`
const SHEET_VERSION_SHARE_SQL = `SELECT sheet_id, version::text AS version FROM ${SHEET_PERMISSION_VERSIONS_TABLE} WHERE sheet_id = $1 FOR SHARE`
const SUBJECT_VERSION_ENSURE_SQL = `INSERT INTO ${SUBJECT_AUTHORIZATION_VERSIONS_TABLE} (subject_id) VALUES ($1) ON CONFLICT (subject_id) DO NOTHING`
const SUBJECT_VERSION_SHARE_SQL = `SELECT subject_id, version::text AS version FROM ${SUBJECT_AUTHORIZATION_VERSIONS_TABLE} WHERE subject_id = $1 FOR SHARE`

/** One catalog read: every expected (table, trigger, function) row and whether it fires (`O` or `A`). */
export const AUTHORIZATION_VERSION_TRIGGER_POSTURE_SQL = `SELECT rel.relname AS table_name,
       trg.tgname AS trigger_name,
       fn.proname AS function_name,
       trg.tgenabled::text AS enabled
  FROM pg_catalog.pg_trigger trg
  JOIN pg_catalog.pg_class rel ON rel.oid = trg.tgrelid
  JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
  JOIN pg_catalog.pg_proc fn ON fn.oid = trg.tgfoid
 WHERE NOT trg.tgisinternal
   AND ns.nspname = 'public'
   AND trg.tgname = ANY($1::text[])
 ORDER BY rel.relname, trg.tgname`

export type AuthorizationVersionProtocolErrorCode =
  | 'AUTHZ_VERSION_INPUT_INVALID'
  | 'AUTHZ_VERSION_TRANSACTION_REQUIRED'
  | 'AUTHZ_VERSION_PROTOCOL_UNAVAILABLE'
  | 'AUTHZ_VERSION_CONFLICT'
  | 'AUTHZ_VERSION_UNAVAILABLE'

const ERROR_MESSAGES: Record<AuthorizationVersionProtocolErrorCode, string> = {
  AUTHZ_VERSION_INPUT_INVALID: 'Authorization version lock input is invalid',
  AUTHZ_VERSION_TRANSACTION_REQUIRED: 'Authorization version locks require a read-committed transaction',
  AUTHZ_VERSION_PROTOCOL_UNAVAILABLE: 'Authorization version protocol is not installed or not enabled; admission must refuse',
  AUTHZ_VERSION_CONFLICT: 'Authorization version lock conflict; the transaction is aborted, roll back and retry',
  AUTHZ_VERSION_UNAVAILABLE: 'Authorization version locks are unavailable',
}

/** SQLSTATEs that mean "another transaction got in the way": never success, always retry after ROLLBACK. */
export const AUTHORIZATION_VERSION_CONFLICT_SQLSTATES = Object.freeze(['40P01', '40001', '55P03'] as const)
export type AuthorizationVersionConflictSqlState = (typeof AUTHORIZATION_VERSION_CONFLICT_SQLSTATES)[number]

export class AuthorizationVersionProtocolError extends Error {
  readonly retryable: boolean
  readonly sqlState: AuthorizationVersionConflictSqlState | null
  readonly missingTriggers: readonly string[]

  constructor(
    readonly code: AuthorizationVersionProtocolErrorCode,
    options: { sqlState?: AuthorizationVersionConflictSqlState; missingTriggers?: readonly string[] } = {},
  ) {
    super(ERROR_MESSAGES[code])
    this.name = 'AuthorizationVersionProtocolError'
    this.retryable = code === 'AUTHZ_VERSION_CONFLICT'
    this.sqlState = options.sqlState ?? null
    this.missingTriggers = Object.freeze([...(options.missingTriggers ?? [])])
  }
}

export function isAuthorizationVersionConflict(error: unknown): error is AuthorizationVersionProtocolError {
  return error instanceof AuthorizationVersionProtocolError && error.code === 'AUTHZ_VERSION_CONFLICT'
}

function conflictSqlState(error: unknown): AuthorizationVersionConflictSqlState | null {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && (AUTHORIZATION_VERSION_CONFLICT_SQLSTATES as readonly string[]).includes(code)
    ? (code as AuthorizationVersionConflictSqlState)
    : null
}

/** Maps a database failure to the protocol's typed errors; never projects SQL text, identifiers or causes. */
function toProtocolError(error: unknown): AuthorizationVersionProtocolError {
  if (error instanceof AuthorizationVersionProtocolError) return error
  const sqlState = conflictSqlState(error)
  if (sqlState) return new AuthorizationVersionProtocolError('AUTHZ_VERSION_CONFLICT', { sqlState })
  return new AuthorizationVersionProtocolError('AUTHZ_VERSION_UNAVAILABLE')
}

function queryFnOf(queryable: AuthorizationVersionQueryable): AuthorizationVersionQueryFn {
  if (typeof queryable === 'function') return queryable
  if (queryable && typeof queryable.query === 'function') return queryable.query.bind(queryable)
  throw new AuthorizationVersionProtocolError('AUTHZ_VERSION_INPUT_INVALID')
}

function rowsOf(result: QueryResultLike): Array<Record<string, unknown>> {
  const rows = (result as { rows?: unknown } | null)?.rows
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : []
}

function isCanonicalId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 255
    && value.trim() === value
    // eslint-disable-next-line no-control-regex -- identifiers must reject embedded ASCII controls
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** Trim, drop blanks, de-duplicate, sort ascending (byte order): the canonical bump order. */
export function canonicalAuthorizationIds(ids: readonly unknown[]): string[] {
  const seen = new Set<string>()
  for (const raw of ids) {
    if (typeof raw !== 'string') continue
    const id = raw.trim()
    if (id) seen.add(id)
  }
  return Array.from(seen).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * Explicit Layer-1 bump: takes the write lock of every listed sheet's version row, ascending, in ONE
 * statement. Call it as the first protocol statement of a sheet-permission writer, inside its
 * transaction. Returns the ids actually bumped (sorted, de-duplicated); no statement for an empty list.
 */
export async function bumpSheetPermissionVersions(
  queryable: AuthorizationVersionQueryable,
  sheetIds: readonly string[],
): Promise<string[]> {
  const ids = canonicalAuthorizationIds(sheetIds)
  if (ids.length === 0) return ids
  await queryFnOf(queryable)(SHEET_PERMISSION_VERSIONS_BUMP_SQL, [ids])
  return ids
}

/**
 * Explicit Layer-2 bump: takes the write lock of every listed user's version row, ascending, in ONE
 * statement. Multi-user membership writers (role un/assignment, member-group projection, directory
 * admissions) call it before their DML so concurrent writers acquire the rows in one global order.
 */
export async function bumpSubjectAuthorizationVersions(
  queryable: AuthorizationVersionQueryable,
  userIds: readonly string[],
): Promise<string[]> {
  const ids = canonicalAuthorizationIds(userIds)
  if (ids.length === 0) return ids
  await queryFnOf(queryable)(SUBJECT_AUTHORIZATION_VERSIONS_BUMP_SQL, [ids])
  return ids
}

/** Canonical combined bump: sheets ascending first, then subjects ascending. */
export async function bumpAuthorizationVersions(
  queryable: AuthorizationVersionQueryable,
  input: { sheetIds?: readonly string[]; userIds?: readonly string[] },
): Promise<{ sheetIds: string[]; userIds: string[] }> {
  const sheetIds = await bumpSheetPermissionVersions(queryable, input.sheetIds ?? [])
  const userIds = await bumpSubjectAuthorizationVersions(queryable, input.userIds ?? [])
  return { sheetIds, userIds }
}

export type AuthorizationVersionTriggerPosture =
  | { ok: true; triggers: number }
  | { ok: false; missing: string[] }

/**
 * The executable half of the hard condition: every trigger of the protocol exists on its table, points
 * at its function and fires (`tgenabled` O or A). `D` (disabled), a missing trigger or a different
 * function is a gap. A session running with `session_replication_role = replica` elsewhere is
 * invisible to this check and is listed in {@link AUTHORIZATION_PROTOCOL_GAPS}.
 */
export async function verifyAuthorizationVersionTriggerPosture(
  queryable: AuthorizationVersionQueryable,
): Promise<AuthorizationVersionTriggerPosture> {
  const expected = AUTHORIZATION_VERSION_TRIGGERS
  const result = await queryFnOf(queryable)(
    AUTHORIZATION_VERSION_TRIGGER_POSTURE_SQL,
    [expected.map((entry) => entry.trigger)],
  )
  const present = new Set<string>()
  for (const row of rowsOf(result)) {
    const enabled = String(row.enabled ?? '')
    if (enabled !== 'O' && enabled !== 'A') continue
    present.add(`${String(row.table_name)}|${String(row.trigger_name)}|${String(row.function_name)}`)
  }
  const missing = expected
    .filter((entry) => !present.has(`${entry.table}|${entry.trigger}|${entry.fn}`))
    .map((entry) => `${entry.table}.${entry.trigger}`)
  return missing.length === 0 ? { ok: true, triggers: expected.length } : { ok: false, missing }
}

export type AuthorizationVersionLockInput = {
  /** The bound sheet(s) the four checks read; locked ascending. At least one. */
  sheetIds: readonly string[]
  /** The acting user (approver / owner) whose authority is re-checked. */
  actorId: string
  /** The tenant whose `user_orgs` membership is part of the actor's positive authority. */
  tenantId: string
  /** The bound record, when the source binds one; locked FOR SHARE as the last step. */
  recordId?: string | null
}

export type LockedAuthorityRows = {
  /** Locked `user_roles.role_id` values, ascending. */
  roleIds: string[]
  /** Locked `role_permissions` rows for those roles. */
  rolePermissions: Array<{ roleId: string; permissionCode: string }>
  /** Locked `user_permissions.permission_code` values. */
  directPermissionCodes: string[]
  /** The locked `users` row, or null when the actor row does not exist. */
  user: {
    id: string
    role: string | null
    isActive: boolean
    activationStatus: string | null
    permissions: string[]
  } | null
  /** The locked (actor, tenant) `user_orgs` row, or null. */
  membership: { orgId: string; isActive: boolean } | null
  /** The locked (actor, 'integration') namespace admission row, or null. */
  integrationAdmission: { enabled: boolean } | null
  /** Every permission code the locked rows grant (role + direct + legacy `users.permissions`). */
  permissionCodes: string[]
  /**
   * Admin-ness from LOCKED ROWS ONLY, the live-authority contract
   * (`automation-live-authority.ts:131-132, :151`): the `admin` role, `users.role = 'admin'`, or the
   * `role:admin` code. Never `req.user`, never `users.is_admin`, never the RBAC cache.
   */
  isAdmin: boolean
}

export type AuthorizationVersionLockResult = {
  sheetVersions: Array<{ sheetId: string; version: number }>
  subjectVersion: { subjectId: string; version: number }
  authority: LockedAuthorityRows
  /** The locked bound record, `null` when no record was requested or the row is absent. */
  record: { recordId: string; sheetId: string; data: unknown; deletedAt: string | null } | null
  lockOrder: readonly string[]
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function permissionCodeList(values: unknown[]): string[] {
  return values.flatMap((value) => (typeof value === 'string' && value.trim() ? [value.trim()] : []))
}

async function lockVersionRow(
  query: AuthorizationVersionQueryFn,
  ensureSql: string,
  shareSql: string,
  key: string,
): Promise<number> {
  await query(ensureSql, [key])
  const rows = rowsOf(await query(shareSql, [key]))
  const version = Number(rows[0]?.version)
  if (rows.length !== 1 || !Number.isSafeInteger(version) || version < 1) {
    throw new AuthorizationVersionProtocolError('AUTHZ_VERSION_UNAVAILABLE')
  }
  return version
}

/**
 * Takes the admission's locks in the fixed order documented at the top of this module and returns
 * the versions plus the FACTS read from the locked rows. Requires an open READ COMMITTED transaction
 * (probed, as the live-authority prerequisite does) and the trigger posture (fail closed).
 *
 * The caller holds the transaction open through its checks and its commit. After a thrown
 * AUTHZ_VERSION_CONFLICT the transaction is aborted: roll back and retry; never treat it as a pass.
 */
export async function lockAuthorizationVersionsForAdmission(
  trx: AuthorizationVersionQueryable,
  input: AuthorizationVersionLockInput,
): Promise<AuthorizationVersionLockResult> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !Array.isArray(input.sheetIds) || input.sheetIds.length === 0 || !input.sheetIds.every(isCanonicalId)
    || !isCanonicalId(input.actorId) || !isCanonicalId(input.tenantId)
    || !(input.recordId === undefined || input.recordId === null || isCanonicalId(input.recordId))) {
    throw new AuthorizationVersionProtocolError('AUTHZ_VERSION_INPUT_INVALID')
  }
  const query = queryFnOf(trx)
  const sheetIds = canonicalAuthorizationIds(input.sheetIds)

  try {
    const isolation = rowsOf(await query("SELECT current_setting('transaction_isolation') AS isolation"))
    if (isolation.length !== 1 || isolation[0]?.isolation !== 'read committed') throw new Error('Wrong isolation')
    await assertInTransaction({
      query: async (sql: string, params?: unknown[]) => {
        const result = await query(sql, params)
        return { rows: rowsOf(result), rowCount: rowsOf(result).length }
      },
    }, 'Authorization version protocol')
  } catch {
    throw new AuthorizationVersionProtocolError('AUTHZ_VERSION_TRANSACTION_REQUIRED')
  }

  const posture = await verifyAuthorizationVersionTriggerPosture(query).catch((error: unknown) => {
    throw toProtocolError(error)
  })
  if (posture.ok === false) {
    throw new AuthorizationVersionProtocolError('AUTHZ_VERSION_PROTOCOL_UNAVAILABLE', { missingTriggers: posture.missing })
  }

  try {
    const sheetVersions: Array<{ sheetId: string; version: number }> = []
    for (const sheetId of sheetIds) {
      sheetVersions.push({ sheetId, version: await lockVersionRow(query, SHEET_VERSION_ENSURE_SQL, SHEET_VERSION_SHARE_SQL, sheetId) })
    }
    const subjectVersion = {
      subjectId: input.actorId,
      version: await lockVersionRow(query, SUBJECT_VERSION_ENSURE_SQL, SUBJECT_VERSION_SHARE_SQL, input.actorId),
    }

    // The live-authority order, statement for statement (automation-live-authority.ts:90-124).
    const roles = rowsOf(await query(
      `SELECT role_id FROM user_roles
       WHERE user_id = $1 ORDER BY role_id FOR SHARE`,
      [input.actorId],
    ))
    const roleIds = [...new Set(roles.map((row) => row.role_id))]
    if (roleIds.some((roleId) => typeof roleId !== 'string' || !roleId)) throw new Error('Invalid role row')
    const sortedRoleIds = (roleIds as string[]).sort()
    const rolePermissions = rowsOf(await query(
      `SELECT role_id, permission_code FROM role_permissions
       WHERE role_id = ANY($1::text[]) ORDER BY role_id, permission_code FOR SHARE`,
      [sortedRoleIds],
    ))
    const directPermissions = rowsOf(await query(
      `SELECT permission_code FROM user_permissions
       WHERE user_id = $1 ORDER BY permission_code FOR SHARE`,
      [input.actorId],
    ))
    const users = rowsOf(await query(
      `SELECT id, role, is_active, activation_status, permissions FROM users
       WHERE id = $1 FOR SHARE`,
      [input.actorId],
    ))
    const memberships = rowsOf(await query(
      `SELECT user_id, org_id, is_active FROM user_orgs
       WHERE user_id = $1 AND org_id = $2 ORDER BY org_id FOR SHARE`,
      [input.actorId, input.tenantId],
    ))
    const admissions = rowsOf(await query(
      `SELECT namespace, enabled FROM user_namespace_admissions
       WHERE user_id = $1 AND namespace = $2 ORDER BY namespace FOR SHARE`,
      [input.actorId, 'integration'],
    ))

    let record: AuthorizationVersionLockResult['record'] = null
    if (input.recordId) {
      const records = rowsOf(await query(
        `SELECT id, sheet_id, data, (to_jsonb(meta_records) ->> 'deleted_at') AS deleted_at FROM meta_records
         WHERE id = $1 AND sheet_id = ANY($2::text[]) FOR SHARE`,
        [input.recordId, sheetIds],
      ))
      if (records.length > 1) throw new Error('Ambiguous record row')
      const row = records[0]
      record = row
        ? { recordId: String(row.id), sheetId: String(row.sheet_id), data: row.data, deletedAt: textOrNull(row.deleted_at) }
        : null
    }

    const userRow = users.length === 1 && users[0]?.id === input.actorId ? users[0] : null
    const legacyPermissions = Array.isArray(userRow?.permissions) ? (userRow.permissions as unknown[]) : []
    const permissionCodes = Array.from(new Set(permissionCodeList([
      ...rolePermissions.map((row) => row.permission_code),
      ...directPermissions.map((row) => row.permission_code),
      ...legacyPermissions,
    ]))).sort()
    const userRole = typeof userRow?.role === 'string' ? userRow.role : null
    const isAdmin = sortedRoleIds.includes('admin') || userRole === 'admin' || permissionCodes.includes('role:admin')

    return {
      sheetVersions,
      subjectVersion,
      authority: {
        roleIds: sortedRoleIds,
        rolePermissions: rolePermissions.map((row) => ({ roleId: String(row.role_id), permissionCode: String(row.permission_code) })),
        directPermissionCodes: permissionCodeList(directPermissions.map((row) => row.permission_code)),
        user: userRow
          ? {
            id: String(userRow.id),
            role: userRole,
            isActive: userRow.is_active === true,
            activationStatus: textOrNull(userRow.activation_status),
            permissions: permissionCodeList(legacyPermissions),
          }
          : null,
        membership: memberships.length === 1 && memberships[0]?.user_id === input.actorId
          ? { orgId: String(memberships[0].org_id), isActive: memberships[0].is_active === true }
          : null,
        integrationAdmission: admissions.length === 1 && admissions[0]?.namespace === 'integration'
          ? { enabled: admissions[0].enabled === true }
          : null,
        permissionCodes,
        isAdmin,
      },
      record,
      lockOrder: ADMISSION_LOCK_ORDER,
    }
  } catch (error) {
    throw toProtocolError(error)
  }
}

/**
 * HARD-CONDITION REGISTRY (baseline §7.2: every input of the four checks belongs to a layer and a
 * writer; a source affected by an input outside the protocol is refused, or the feature stays off).
 * With the triggers installed, every writer of the covered tables is inside the protocol — raw SQL,
 * migrations, FK cascades and plugin raw queries fire them too. What remains outside is listed here,
 * as data Y5 reads to refuse or to take the named handling.
 */
export type AuthorizationProtocolCheck = 1 | 2 | 3 | 4

export type AuthorizationProtocolGap = {
  readonly id: string
  readonly checks: readonly AuthorizationProtocolCheck[]
  readonly kind: 'input-outside-protocol' | 'forbidden-input' | 'bypass-window'
  readonly input: string
  readonly handling: string
}

export const AUTHORIZATION_PROTOCOL_GAPS: readonly AuthorizationProtocolGap[] = Object.freeze([
  Object.freeze({
    id: 'stock-prep-project-registry',
    checks: Object.freeze([1] as const),
    kind: 'input-outside-protocol' as const,
    input: 'The stock-preparation project registry (exists, not archived, registered sheet = bound sheetId) is plugin-owned state with its own project write lock; no version row covers it.',
    handling: 'Y5 reads the registry inside the admission transaction under the project write lock, or refuses the source.',
  }),
  Object.freeze({
    id: 'request-cache-admin-and-codes',
    checks: Object.freeze([2, 3, 4] as const),
    kind: 'forbidden-input' as const,
    input: 'resolveRequestAccess (multitable/access.ts) derives isAdminRole and permission codes from the token or the 60 s RBAC cache (rbac/service.ts); neither is serialized by any lock.',
    handling: 'Admission and approval read admin-ness and codes ONLY from lockAuthorizationVersionsForAdmission().authority; a source whose check still consumes req.user is refused.',
  }),
  Object.freeze({
    id: 'session-replication-role-replica',
    checks: Object.freeze([2, 3, 4] as const),
    kind: 'bypass-window' as const,
    input: 'Ordinary (O) triggers do not fire for a session with session_replication_role = replica (restore rehearsals: scripts/ops/attendance-staging-window-runner-remote.sh); TRUNCATE fires no row trigger (no writer uses it on the covered tables).',
    handling: 'The YiDa send switch stays off during such a window; the posture check cannot observe another session, so the window is operational, not detectable.',
  }),
  Object.freeze({
    id: 'triggers-not-installed',
    checks: Object.freeze([2, 3, 4] as const),
    kind: 'bypass-window' as const,
    input: 'A database where zzzz20261106110500 has not run, or where a trigger was disabled, has writers outside the protocol (autocommit routes, ops scripts, migrations, cascades, plugin raw queries).',
    handling: 'lockAuthorizationVersionsForAdmission() verifies the posture first and throws AUTHZ_VERSION_PROTOCOL_UNAVAILABLE: admission refuses.',
  }),
])

/** The registry entries that touch any of the given checks (1 = project registry, 2 = table, 3 = field, 4 = record). */
export function authorizationProtocolGapsFor(checks: readonly AuthorizationProtocolCheck[]): AuthorizationProtocolGap[] {
  const wanted = new Set(checks)
  return AUTHORIZATION_PROTOCOL_GAPS.filter((gap) => gap.checks.some((check) => wanted.has(check)))
}
