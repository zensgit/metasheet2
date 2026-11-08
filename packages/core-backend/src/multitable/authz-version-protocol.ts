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
 *   The YiDa approval / admission holder (slice Y5) takes the actor's `subject_authorization_versions`
 *   row FOR SHARE FIRST — phase 1, `lockSubjectAuthorizationVersionForAdmission`, before its live-actor
 *   prerequisite locks `users` — because its transaction prelude runs before the binding (and so the
 *   sheet) is known; the helper then re-takes that row as a no-op. See that function's docblock.
 *
 * WRITER ORDER — the rule every TypeScript writer follows (the triggers stay the completeness net):
 *   - sheet layer: the `meta_sheets` row lock(s) FIRST (the liveness `FOR UPDATE` fence of the
 *     grant / configuration routes, the record-link phase-2 `FOR SHARE`, the plugin-port fences) →
 *     the sheet version row (explicit bump) → any exclusive `record_permissions` / `meta_records`
 *     lock → the DML. The holder never locks `meta_sheets`, so writers agree among themselves
 *     (meta_sheets → version row) and with the holder (version row → record);
 *   - subject layer: the subject version row (explicit bump) BEFORE any exclusive lock on a row the
 *     holder shares — `users … FOR UPDATE` (the access-graph mutex, the deprovision ledger, the
 *     evidence-API restore, the controlled handover), `user_orgs … FOR UPDATE`, the
 *     `user_namespace_admissions` upsert, the `user_roles` / `user_permissions` / member-group DML —
 *     and AFTER locks outside the holder's set (`roles`, the namespace-admission advisory).
 *   - field rows (FIELD-ROW WRITER RULE, the #6792 follow-up): a writer that locks a `meta_fields`
 *     row — an explicit `FOR UPDATE` / `FOR NO KEY UPDATE` read, a sibling `"order"` shift, or the
 *     UPDATE itself, whose BEFORE ROW trigger locks the row before it runs — and whose write can trip
 *     the `field-visibility` trigger takes the sheet version row FIRST (explicit bump, after its
 *     advisory fence), then the field row(s): fence → sheet version row → field rows → records → DML.
 *     "Can trip" is decided BEFORE the first field-row lock with the trigger's own test
 *     ({@link fieldVisibilityTriggerWouldFire}, PATCH /fields: the unlocked read it validated against vs
 *     the property it will write), or unconditionally where that test would itself need the locked row
 *     (a config revert that writes `property`, the plugin property port's merge patch, an `ensureFields`
 *     overwrite, the field retype convert and its undo — a legacy jsonb-STRING property is parsed into
 *     an object by the convert and written back raw by the undo, so either write can flip the trigger's
 *     flags). Writes that cannot trip it (a PATCH of order, name, type or options only, a name /
 *     order revert) never take the version row, so a shared column drag never queues on it.
 *     The sheet row comes BEFORE the version row here too (the sheet-layer order above): a field-row
 *     writer that holds no `meta_sheets` lock of its own and can take one after its bump — an FK child
 *     insert takes `FOR KEY SHARE` on the sheet row: the new field of an `ensureFields` overwrite, the
 *     auto-number sequence row of a PATCH /fields that converts to autoNumber — takes that KEY SHARE
 *     BEFORE the bump ({@link bumpSheetPermissionVersionBehindSheetRow}); taken after it, it waits on a
 *     grant / configuration route that holds `meta_sheets … FOR UPDATE` and wants the version row next
 *     (a 40P01 cycle between two writers). The port, both config-revert branches and the retype convert
 *     and undo insert no FK child of `meta_sheets` and update no `meta_sheets` row after their bump, so
 *     they keep the plain bump: fence → [meta_sheets KEY SHARE] → sheet version row → field rows.
 *   A writer that skips the explicit bump (raw SQL, a data migration, an FK cascade, a plugin raw
 *   query) is still covered by the triggers but acquires the version row LAST: against an in-flight
 *   holder, or against another raw writer that touches the same rows in another order, PostgreSQL
 *   detects the cycle (40P01) and aborts one side — never a silent pass.
 *
 * Compatibility with the pre-existing in-transaction protocols (all documented, none changed):
 *   - record-link phases (`services/approval-record-link-txn-auth.ts`): phases 1–4 take FOR SHARE
 *     (compatible with the holder); phase 5 takes `record_permissions` / `meta_records` FOR UPDATE,
 *     so the record-permission PUT / DELETE routes bump their sheet row AFTER phases 1–4 and BEFORE
 *     phase 5 — writer order = meta_sheets → sheet row → record, the holder's order for the rows they
 *     share, and the grant routes' order (meta_sheets → sheet row) for the rows they share;
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
 *     the holder's order (judge delta B). The three writers that lock `users` rows on their own
 *     before (or without) the mutex bump first as well: `deprovision-ledger.ts lockCandidateUser`,
 *     the `deprovision-evidence-api.ts` restore transaction and `controlled-handover.ts` (whose
 *     `FOR UPDATE NOWAIT` probe now runs after the bump — the handover waits on an in-flight holder
 *     instead of failing fast on it, and keeps its fail-fast meaning for every other users-row holder).
 *
 * DEADLOCKS. Holder-vs-writer pairs that follow the canonical order cannot deadlock. A writer that
 * acquires an exclusive lock in another order (the legacy operator-role script, a multi-row cascade,
 * a raw UPDATE / DELETE of a holder-shared row) can form a cycle with a holder; PostgreSQL raises
 * 40P01 in the backend that detects it. The helper maps 40P01 / 40001 / 55P03 to a typed CONFLICT,
 * never to success — the caller rolls back and retries. Writer-side error mapping is unchanged.
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
 * The sheet-row lock of {@link bumpSheetPermissionVersionBehindSheetRow}. `FOR KEY SHARE` is exactly the lock an FK child
 * insert takes on the parent row by itself (`meta_fields.sheet_id`, `meta_field_auto_number_sequences.sheet_id`, …), so
 * it adds no conflict that writer did not already have: it conflicts with `FOR UPDATE` (the grant / configuration
 * routes' `assertSheetLiveForUpdate`), a sheet DELETE and a key UPDATE, never with an ordinary `meta_sheets` UPDATE
 * (`FOR NO KEY UPDATE`) or a `FOR SHARE` reader; the admission holder never locks `meta_sheets`. Exported so real-DB
 * probes can match a writer parked on it by text.
 */
export const SHEET_ROW_KEY_SHARE_SQL = 'SELECT id FROM meta_sheets WHERE id = $1 FOR KEY SHARE'

/**
 * Explicit Layer-1 bump for a FIELD-ROW writer that holds no `meta_sheets` row lock of its own and can take one after
 * the bump (the field-row writer rule above): the sheet row `FOR KEY SHARE` first, then the version row — two
 * statements, same order every time, so the writer acquires the two rows in the sheet-layer order meta_sheets →
 * version row that the grant / configuration routes use (`meta_sheets … FOR UPDATE` → bump). Without it the writer's
 * FK child insert takes the KEY SHARE AFTER the version row and closes a 40P01 cycle with such a route (verifier r1 F1:
 * an `ensureFields` overwrite that adds a field vs PUT field-permissions). One sheet; no statement for a blank id.
 */
export async function bumpSheetPermissionVersionBehindSheetRow(
  queryable: AuthorizationVersionQueryable,
  sheetId: string,
): Promise<string[]> {
  const ids = canonicalAuthorizationIds([sheetId])
  if (ids.length === 0) return ids
  const query = queryFnOf(queryable)
  await query(SHEET_ROW_KEY_SHARE_SQL, [ids[0]])
  await query(SHEET_PERMISSION_VERSIONS_BUMP_SQL, [ids])
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

/**
 * The two flags the `meta_fields` trigger watches (migration zzzz20261106110500, `TG_ARGV[1] = 'field-visibility'`):
 * `property.hidden = true` and `property.visible = false`.
 */
function visibilityFlagsOf(property: unknown): { hidden: boolean; visibleFalse: boolean } {
  // `property -> 'hidden'` is NULL for a non-object jsonb value (array, string, number, null): neither flag. The readers
  // parse a jsonb STRING (normalizeJson); the trigger does not — registry entry `field-property-jsonb-string-encoding`.
  if (!property || typeof property !== 'object' || Array.isArray(property)) return { hidden: false, visibleFalse: false }
  const record = property as Record<string, unknown>
  return { hidden: record.hidden === true, visibleFalse: record.visible === false }
}

/**
 * The `meta_fields` trigger's own test, in TypeScript: would writing `next` over the stored `stored` property bump
 * the sheet version row? Exactly the SQL of the trigger function (`COALESCE((old -> 'property' -> 'hidden') =
 * 'true'::jsonb, FALSE) IS DISTINCT FROM …` for `hidden`, the same with `'false'` for `visible`), on the same two
 * values — the raw stored jsonb as node-pg parses it and the object about to be written. A field writer evaluates it
 * BEFORE its first field-row lock and, when true, bumps the sheet version row first (the field-row writer rule above),
 * so the trigger never takes that row after the field-row lock. Note it is not the visibility DERIVATION: adding
 * `visible: false` to an already `hidden: true` field changes no derivation and still fires the trigger.
 */
export function fieldVisibilityTriggerWouldFire(stored: unknown, next: unknown): boolean {
  const before = visibilityFlagsOf(stored)
  const after = visibilityFlagsOf(next)
  return before.hidden !== after.hidden || before.visibleFalse !== after.visibleFalse
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
 * Phase-1 lock of a holder whose transaction PRELUDE already locks the live-authority rows (`users`
 * FOR SHARE and the rest of `automation-live-authority.ts`) before it knows which sheet it will
 * re-authorize: the YiDa approval and admission transactions (slice Y5,
 * `integration/yida-send-approval-service.ts`). Taken as the FIRST protocol statement, before the
 * live-actor prerequisite, it keeps the holder's order on the subject layer equal to the writer rule
 * (subject version row → `users`): an access-graph writer that bumped the subject row first waits
 * here until the holder commits, instead of forming the users-vs-subject cycle (B-05 at the service
 * level). The sheet version rows and the bound record follow later through
 * {@link lockAuthorizationVersionsForAdmission}, which re-takes this row as a no-op. No runtime src
 * transaction writes both a sheet-layer and a subject-layer table (census in the Y5 PR body; at file
 * level the only src matches are this module, whose statements are the version-row helpers that
 * writers call, and the historical data migration `zzzz20260318110000`, whose `meta_sheets` UPDATE
 * sets only `base_id`, not a watched column), so subject-before-sheet cannot cycle with a
 * protocol-following writer either. A writer that breaks the rule (ops scripts, migrations, raw SQL)
 * can deadlock with this holder; the holder's answer is then CONFLICT, or UNAVAILABLE when the cycle
 * closes inside its live-actor prelude, never a pass (the Y5 real-DB deadlock cases pin both victims
 * of both cycles).
 *
 * 40P01 / 40001 / 55P03 → the typed CONFLICT (the caller refuses, never passes); any other failure →
 * UNAVAILABLE. The caller holds an open transaction (the live-actor prerequisite that follows probes it).
 */
export async function lockSubjectAuthorizationVersionForAdmission(
  trx: AuthorizationVersionQueryable,
  actorId: string,
): Promise<{ subjectId: string; version: number }> {
  if (!isCanonicalId(actorId)) throw new AuthorizationVersionProtocolError('AUTHZ_VERSION_INPUT_INVALID')
  const query = queryFnOf(trx)
  try {
    return { subjectId: actorId, version: await lockVersionRow(query, SUBJECT_VERSION_ENSURE_SQL, SUBJECT_VERSION_SHARE_SQL, actorId) }
  } catch (error) {
    throw toProtocolError(error)
  }
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
  Object.freeze({
    id: 'field-property-jsonb-string-encoding',
    checks: Object.freeze([3] as const),
    kind: 'bypass-window' as const,
    input: 'A meta_fields.property stored as a jsonb STRING (the legacy encoding record-duplicate-guard.ts and field-retype-convert-preview.ts still read) is parsed by the readers (normalizeJson: check 3 sees its hidden / visible keys) but not by the field-visibility trigger (property -> \'hidden\' is NULL for a string). A raw-SQL write that stores such a string carrying hidden: true over a visible field hides it with no version bump and commits without waiting for an in-flight holder. Every TypeScript writer that rewrites an existing field writes an object, or bumps explicitly first where it can write a stored string back (the property config revert, the retype undo).',
    handling: 'Operational, like the replica window: raw SQL writes meta_fields.property as a JSON object, never as a JSON string. A one-time normalization of the legacy string properties to objects (not in this slice) closes the gap; until it has run, the entry stays listed.',
  }),
])

/** The registry entries that touch any of the given checks (1 = project registry, 2 = table, 3 = field, 4 = record). */
export function authorizationProtocolGapsFor(checks: readonly AuthorizationProtocolCheck[]): AuthorizationProtocolGap[] {
  const wanted = new Set(checks)
  return AUTHORIZATION_PROTOCOL_GAPS.filter((gap) => gap.checks.some((check) => wanted.has(check)))
}
