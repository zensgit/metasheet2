#!/usr/bin/env node

/**
 * Time Machine O-2 — the **L1 exercise battery**.
 *
 * WHY THIS EXISTS
 * ---------------
 * At ladder L1 (`docs/development/multitable-timemachine-o2-enablement-ladder-20260819.md` §2)
 * the nine recovery-authority triggers are ENABLED on staging while all four recovery flags stay
 * OFF. With no recovery process holding a lease, organic traffic sees **zero** 40001 — so the
 * ladder's "zero unmapped 500" criterion is, under passive observation, satisfied by a system in
 * which the triggers never fire at all. Passive observation therefore cannot distinguish
 *   (a) "platform writers classify the recovery conflict correctly" from
 *   (b) "the recovery conflict never happened".
 *
 * This battery removes that ambiguity by CONSTRUCTING the contention: it holds an EXCLUSIVE
 * recovery-authority lease directly in the database — exactly the lease an exact-anchor recovery
 * would hold — and then drives real platform writes through the real application's HTTP API
 * against the leased subject. Every driven surface must answer with the NAMED retryable 409
 * (`RECOVERY_AUTHORITY_BUSY`). Two failures are fatal and mean opposite things:
 *   - a 5xx  ⇒ the write surface does NOT route through the single classifier (the O2-S2 defect);
 *   - a 2xx  ⇒ the TRIGGER DID NOT FIRE. This is the worse outcome: it would mean L1 observed
 *              nothing at all, and every "zero unmapped 500" day of the observation window was
 *              vacuous.
 *
 * WHAT MAKES THE VERDICT LOAD-BEARING (three controls, not one assertion)
 * ----------------------------------------------------------------------
 *  1. **Positive control (phase 4)** — after ROLLBACK releases the lease, every surface is
 *     re-driven and must answer 2xx *and* the expected row must be observable in the database.
 *     Without this a 409 could come from anything (a broken fixture, a 409 the route already
 *     published for another reason); with it, the 409 is proven lease-caused.
 *  2. **Wrong-kind control (phase 3b)** — the migration maps each table to ONE lease kind
 *     (user / role / member-group). Holding the *other* kind over the same subject must NOT
 *     block. Without this, "a 409 happened" does not establish that the named
 *     trigger→lease-function→key mapping is the mechanism; with it, it does. This control is
 *     not decorative: `user_roles.role_id REFERENCES roles(id) ON DELETE CASCADE` means a
 *     `roles:delete` cascade fires the *user* trigger as well, so holding every lease at once
 *     would let a user-lease 409 masquerade as a role-lease 409. The battery therefore holds
 *     exactly one lease at a time — the kind that surface's mapping names.
 *  3. **Fail-not-skip preflight (phase 0)** — a run against a DB whose nine triggers are not 9/9
 *     CANONICAL and ENABLED exits NON-ZERO with `VERDICT: NOT_ARMED`. A battery that "passed" on a
 *     disarmed database would be the purest form of green-against-nothing. "Canonical" is the
 *     operative word (P2, owner-constructed escape): the preflight once keyed on `trigger_name`
 *     and read only `tgenabled`, so a trigger of the RIGHT NAME on the WRONG TABLE certified
 *     `ARMED - 9/9` while an authority table carried no trigger at all. The preflight now compares
 *     every field `multitable-recovery-schema-containment.mjs` canonicalizes — schema, table,
 *     name, function schema+name, event type, argument bytes, UPDATE-OF columns — plus the six
 *     authority FUNCTION body fingerprints, against that module's single expected census, with the
 *     one deliberate difference that at L1 the expectation on `tgenabled` is "fires" (O/A) rather
 *     than the factory-inert 'D'. Both catalogue queries are IMPORTED from that module, so the
 *     battery cannot observe a narrower schema surface than the census pins.
 *
 * LEASE MECHANICS (derived from the migration, not re-invented)
 * ------------------------------------------------------------
 * `packages/core-backend/src/db/migrations/zzzz20260721121000_add_recovery_authority_locks.ts`
 * builds the leases on `pg_try_advisory_xact_lock(_shared)` over `hashtextextended(prefix||key)`.
 * They are **transaction-scoped**: the holder must BEGIN, call the lease function with
 * `exclusive => true` (which must return TRUE), and keep the transaction open for the duration of
 * the HTTP write; ROLLBACK releases. The triggers take the *shared* form (`FALSE`), so an
 * exclusive holder makes every platform write on that subject fail fast with SQLSTATE 40001 and
 * the `METASHEET_RECOVERY_AUTHORITY_BUSY` marker — which
 * `packages/core-backend/src/db/recovery-conflict.ts` maps to 409 / `RECOVERY_AUTHORITY_BUSY`.
 *
 * The trigger→lease-kind mapping the ledger below encodes (read off the migration):
 *   users, user_roles, user_permissions, platform_member_group_members  → `..._user(id|user_id)`
 *   role_permissions                                                    → `..._role(role_id)`
 *   spreadsheet/field/record_permissions                                → by `subject_type`:
 *                                                                         user|role|member-group
 * `scripts/ops/multitable-l1-battery.test.mjs` re-derives this mapping FROM the migration source
 * and asserts every driven surface agrees with it, so a wrong-kind lease cannot be shipped
 * silently (it would produce a false "trigger not firing" verdict).
 *
 * DISCRETION
 * ----------
 * Mirrors the containment/rollback helpers: DATABASE_URL, the login password, and the bearer
 * token are never printed. Response bodies appear only as short, redaction-filtered excerpts.
 *
 * Usage:
 *   DATABASE_URL=... APP_URL=http://127.0.0.1:7778 \
 *   BATTERY_ADMIN_EMAIL=... BATTERY_ADMIN_PASSWORD=... \
 *   node scripts/ops/multitable-l1-battery.mjs [--out PATH] [--timeout-ms N]
 *
 * Exit codes:
 *   0  VERDICT: PASS       — every driven surface blocked-then-cleared, controls green
 *   1  VERDICT: FAIL       — at least one surface/control failed (evidence file still written)
 *   2  VERDICT: NOT_ARMED  — posture/usage/precondition refusal; the battery did not run
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'

import {
  AUTHORITY_FUNCTION_NAMES,
  AUTHORITY_FUNCTION_SHADOW_QUERY,
  AUTHORITY_FUNCTION_SNAPSHOT_QUERY,
  AUTHORITY_TRIGGER_FUNCTIONS,
  AUTHORITY_TRIGGER_SNAPSHOT_QUERY,
  EXPECTED_AUTHORITY_FUNCTIONS,
  EXPECTED_AUTHORITY_TRIGGERS,
  canonicalFunction,
  canonicalTrigger,
  EXPECTED_AUTHORITY_SCHEMA,
  assertBindableSchemaName,
} from './multitable-recovery-schema-containment.mjs'

const requireFromBackend = createRequire(
  new URL('../../packages/core-backend/package.json', import.meta.url),
)

// ---------------------------------------------------------------------------
// Published contract constants — mirrored from packages/core-backend/src/db/recovery-conflict.ts.
// Not re-derived and not re-named: the battery asserts the code the platform PUBLISHES.
// ---------------------------------------------------------------------------

export const RECOVERY_CONFLICT_HTTP_STATUS = 409
export const RECOVERY_CONFLICT_HTTP_CODE = 'RECOVERY_AUTHORITY_BUSY'
/**
 * `AuthService.assignUserRoles` / `register` convert an EXHAUSTED 40001 retry loop into their own
 * named error. `sendIfRecoveryConflict` maps it to the same 409 body, so the wire shape is
 * identical; this constant is kept so a surface can declare the distinct expectation if one is
 * ever driven (today registration is NOT-DRIVEN — see NOT_DRIVEN_SITES).
 */
export const REGISTRATION_RECOVERY_BUSY_CODE = 'USER_ROLE_ASSIGNMENT_RECOVERY_BUSY'

/**
 * tgenabled letters that mean "this trigger FIRES for an ordinary application write".
 * 'O' = enabled (origin+replica), 'A' = always. Deliberately EXCLUDES 'R' (replica-only):
 * under the normal `session_replication_role = origin` a replica-only trigger does NOT fire,
 * so a database with a trigger at 'R' is NOT at L1 posture even though the trigger "exists".
 * The gate (P2-1) constructed exactly this: three exempted triggers set to 'R' would otherwise
 * certify 9/9 ARMED on a database where they never fire — and those three are the ones with
 * zero behavioural coverage, i.e. the ones for which preflight is the only evidence.
 */
export const ENABLED_TRIGGER_STATES = new Set(['O', 'A'])
export const EXPECTED_TRIGGER_COUNT = 9

/** Lease functions, by kind — the exact names created by the migration. */
export const LEASE_FUNCTION_BY_KIND = Object.freeze({
  user: 'metasheet_try_recovery_authority_user',
  role: 'metasheet_try_recovery_authority_role',
  group: 'metasheet_try_recovery_authority_group',
})

/** Residue stamp prefix: every synthetic object the battery creates carries it. */
export const STAMP_PREFIX = 'o2bat_'

const DEFAULT_OUT = './l1-battery-evidence.json'
const DEFAULT_TIMEOUT_MS = 20_000

// ---------------------------------------------------------------------------
// THE SURFACE LEDGER
//
// Every one of the 55 census sites in
// packages/core-backend/tests/unit/lib/recovery-census-table.ts appears EXACTLY ONCE below —
// either attached to a driven surface, or in NOT_DRIVEN_SITES with a concrete reason. The
// hermetic guard re-parses that census file and asserts set-equality, so a newly-registered
// census site cannot be silently absent from this battery's scope.
//
// `table` is the recovery-authority table the surface actually writes; `lease` is the lease kind
// that table's trigger takes. The hermetic guard re-derives the table→lease-kind mapping from the
// migration and cross-checks both fields.
// ---------------------------------------------------------------------------

export const DRIVEN_SURFACES = Object.freeze([
  {
    id: 'permissions-grant',
    censusSites: ['permissions:grant'],
    method: 'POST',
    path: '/api/permissions/grant',
    table: 'user_permissions',
    lease: 'user',
    trigger: 'trg_user_permissions_recovery_authority_lock',
    note: 'INSERT INTO user_permissions — user trigger keyed on user_id.',
    body: (ctx) => ({ userId: ctx.userId, permission: ctx.codes.grant }),
    // ON CONFLICT DO NOTHING: Postgres fires BEFORE INSERT row triggers before conflict
    // detection, so a repeat still exercises the trigger.
    verify: (ctx) => ({
      sql: 'SELECT 1 FROM user_permissions WHERE user_id = $1 AND permission_code = $2',
      params: [ctx.userId, ctx.codes.grant],
      expectRows: 1,
    }),
  },
  {
    id: 'permissions-revoke',
    censusSites: ['permissions:revoke'],
    method: 'POST',
    path: '/api/permissions/revoke',
    table: 'user_permissions',
    lease: 'user',
    trigger: 'trg_user_permissions_recovery_authority_lock',
    note: 'DELETE FROM user_permissions — seeded row required, else the route answers 404.',
    body: (ctx) => ({ userId: ctx.userId, permission: ctx.codes.revoke }),
    verify: (ctx) => ({
      sql: 'SELECT 1 FROM user_permissions WHERE user_id = $1 AND permission_code = $2',
      params: [ctx.userId, ctx.codes.revoke],
      expectRows: 0,
    }),
  },
  {
    id: 'permissions-template-apply',
    censusSites: ['permissions:template-apply'],
    method: 'POST',
    path: '/api/admin/permission-templates/apply',
    table: 'user_permissions',
    lease: 'user',
    trigger: 'trg_user_permissions_recovery_authority_lock',
    note: 'Bulk INSERT INTO user_permissions from a permission template.',
    body: (ctx) => ({ userId: ctx.userId, templateId: ctx.templateId }),
    verify: (ctx) => ({
      sql: 'SELECT 1 FROM user_permissions WHERE user_id = $1 AND permission_code = ANY($2::text[])',
      params: [ctx.userId, ctx.templatePermissions],
      expectAtLeast: 1,
    }),
  },
  {
    id: 'spreadsheet-permissions-grant',
    censusSites: ['spreadsheet-permissions:grant'],
    method: 'POST',
    path: (ctx) => `/api/spreadsheets/${encodeURIComponent(ctx.sheetId)}/permissions/grant`,
    table: 'spreadsheet_permissions',
    lease: 'user',
    trigger: 'trg_spreadsheet_permissions_recovery_authority_lock',
    subjectType: 'user',
    note: "INSERT with subject_type='user' — the subject trigger dispatches to the USER lease.",
    body: (ctx) => ({ userId: ctx.userId, permission: 'read' }),
    verify: (ctx) => ({
      sql: "SELECT 1 FROM spreadsheet_permissions WHERE sheet_id = $1 AND subject_type = 'user' AND subject_id = $2 AND perm_code = 'read'",
      params: [ctx.sheetId, ctx.userId],
      expectRows: 1,
    }),
  },
  {
    id: 'spreadsheet-permissions-revoke',
    censusSites: ['spreadsheet-permissions:revoke'],
    method: 'POST',
    path: (ctx) => `/api/spreadsheets/${encodeURIComponent(ctx.sheetId)}/permissions/revoke`,
    table: 'spreadsheet_permissions',
    lease: 'user',
    trigger: 'trg_spreadsheet_permissions_recovery_authority_lock',
    subjectType: 'user',
    note: 'DELETE of a seeded subject row — subject trigger → USER lease.',
    body: (ctx) => ({ userId: ctx.userId, permission: 'comment' }),
    verify: (ctx) => ({
      sql: "SELECT 1 FROM spreadsheet_permissions WHERE sheet_id = $1 AND subject_type = 'user' AND subject_id = $2 AND perm_code = 'comment'",
      params: [ctx.sheetId, ctx.userId],
      expectRows: 0,
    }),
  },
  {
    id: 'admin-users-role-assign',
    // The 409 for every admin-users writer is published by the file's ONE delegating helper
    // `sendIfRecoveryAuthorityBusy` (routes/admin-users.ts), which is the census's
    // `admin-users:busy-delegation` site; driving any of them exercises it end-to-end.
    censusSites: ['admin-users:role-assign', 'admin-users:busy-delegation'],
    method: 'POST',
    path: (ctx) => `/api/admin/users/${encodeURIComponent(ctx.userId)}/roles/assign`,
    table: 'user_roles',
    lease: 'user',
    trigger: 'trg_user_roles_recovery_authority_lock',
    note: 'INSERT INTO user_roles — user trigger keyed on user_id (NOT role_id).',
    body: (ctx) => ({ roleId: ctx.roles.assign }),
    verify: (ctx) => ({
      sql: 'SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2',
      params: [ctx.userId, ctx.roles.assign],
      expectRows: 1,
    }),
  },
  {
    id: 'admin-users-role-unassign',
    censusSites: ['admin-users:role-unassign'],
    method: 'POST',
    path: (ctx) => `/api/admin/users/${encodeURIComponent(ctx.userId)}/roles/unassign`,
    table: 'user_roles',
    lease: 'user',
    trigger: 'trg_user_roles_recovery_authority_lock',
    note: 'DELETE FROM user_roles of a seeded assignment — user trigger.',
    body: (ctx) => ({ roleId: ctx.roles.unassign }),
    verify: (ctx) => ({
      sql: 'SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2',
      params: [ctx.userId, ctx.roles.unassign],
      expectRows: 0,
    }),
  },
  {
    id: 'admin-users-status',
    censusSites: ['admin-users:status'],
    method: 'PATCH',
    path: (ctx) => `/api/admin/users/${encodeURIComponent(ctx.userId)}/status`,
    table: 'users',
    lease: 'user',
    trigger: 'trg_users_recovery_authority_lock_update',
    // trg_users_recovery_authority_lock_update fires BEFORE UPDATE OF role, permissions, is_active.
    // The handler only issues the UPDATE when the value actually CHANGES, so the battery always
    // targets the negation of the observed value (and uses the same target in phases 3 and 4 —
    // phase 3 is blocked, so the row is unchanged and the phase-4 flip is still a real write).
    note: 'UPDATE users SET is_active — trg_users_..._lock_update, keyed on users.id.',
    body: (ctx) => ({ isActive: ctx.statusTarget }),
    verify: (ctx) => ({
      sql: 'SELECT 1 FROM users WHERE id = $1 AND is_active = $2',
      params: [ctx.userId, ctx.statusTarget],
      expectRows: 1,
    }),
  },
  {
    id: 'admin-users-member-group-assign',
    censusSites: ['admin-users:member-group-action'],
    method: 'POST',
    path: (ctx) => `/api/admin/role-delegation/users/${encodeURIComponent(ctx.userId)}/member-groups/assign`,
    table: 'platform_member_group_members',
    lease: 'user',
    trigger: 'trg_member_group_members_recovery_authority_lock',
    note: 'INSERT INTO platform_member_group_members — user trigger keyed on user_id.',
    body: (ctx) => ({ groupId: ctx.groupId }),
    verify: (ctx) => ({
      sql: 'SELECT 1 FROM platform_member_group_members WHERE group_id = $1 AND user_id = $2',
      params: [ctx.groupId, ctx.userId],
      expectRows: 1,
    }),
  },
  {
    id: 'admin-users-delegated-role-assign',
    censusSites: ['admin-users:delegated-role-action'],
    method: 'POST',
    path: (ctx) => `/api/admin/role-delegation/users/${encodeURIComponent(ctx.userId)}/roles/assign`,
    table: 'user_roles',
    lease: 'user',
    trigger: 'trg_user_roles_recovery_authority_lock',
    note: 'Delegated role-admin INSERT INTO user_roles (platform admin bypasses scope checks).',
    body: (ctx) => ({ roleId: ctx.roles.delegated }),
    verify: (ctx) => ({
      sql: 'SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2',
      params: [ctx.userId, ctx.roles.delegated],
      expectRows: 1,
    }),
  },
  {
    id: 'roles-create',
    censusSites: ['roles:create'],
    method: 'POST',
    path: '/api/roles',
    table: 'role_permissions',
    lease: 'role',
    trigger: 'trg_role_permissions_recovery_authority_lock',
    // The `roles` row itself carries NO recovery-authority trigger; the blocking write is the
    // role_permissions INSERT that follows it. The role row is pre-seeded so the handler's
    // ON CONFLICT DO NOTHING makes this call a pure role_permissions write.
    note: 'INSERT INTO role_permissions — role trigger keyed on role_id.',
    leaseKeyRef: 'roles.create',
    body: (ctx) => ({
      id: ctx.roles.create,
      name: ctx.roles.create,
      permissions: [ctx.codes.rolePerm],
    }),
    verify: (ctx) => ({
      sql: 'SELECT 1 FROM role_permissions WHERE role_id = $1 AND permission_code = $2',
      params: [ctx.roles.create, ctx.codes.rolePerm],
      expectRows: 1,
    }),
  },
])

/**
 * The canonical recovery-authority trigger functions, rendered as a SQL literal list.
 *
 * DERIVED, NOT RE-TYPED. `AUTHORITY_TRIGGER_FUNCTIONS` is the containment census's own list (see
 * `multitable-recovery-schema-containment.mjs`), which this module already imports for the phase-0
 * canonical-trigger preflight, and which is itself drift-guarded against
 * `packages/core-backend/src/db/migrations/zzzz20260721121000_add_recovery_authority_locks.ts`.
 * A hand-typed table list here would be the enumeration trap (枚举陷阱不收敛): it would go stale the
 * first time the migration covers one more table, and nothing would say so.
 */
const RECOVERY_AUTHORITY_TRIGGER_FUNCTION_SQL_LIST = AUTHORITY_TRIGGER_FUNCTIONS
  .map((name) => `'${name}'`)
  .join(', ')

/**
 * The child write `roles:delete` would need in order to be blockable, expressed as a query the
 * battery RUNS — not as an assumption it states.
 *
 * `routes/roles.ts` documents the mechanism as "The FK cascade from roles → role_permissions
 * deletes recovery-authority rows, so this DELETE can also surface the marker 40001". On the
 * local/test schema no such foreign key exists: `role_permissions` is created by
 * `20250924190000_create_rbac_tables.ts` with `varchar(255)` columns and only a
 * `permission_code → permissions(code)` foreign key, and `033_create_rbac_core.sql`'s cascading
 * version (`role_id … REFERENCES roles(id) ON DELETE CASCADE`, :17) is a `CREATE TABLE IF NOT
 * EXISTS` and therefore a no-op by the time it runs. The battery discovered this by DRIVING it (a
 * 2xx where a 409 was expected); it is recorded as NOT-DRIVEN rather than papered over.
 *
 * A different deployment can still have the 033 shape. So the reason is not merely asserted: it is
 * RE-VERIFIED on every run (判据本身也要被攻击). If the premise has stopped holding on the target
 * database, the excuse has stopped being true and the battery FAILS demanding the surface be
 * driven — the NOT-DRIVEN entry can never quietly outlive its justification.
 *
 * WHAT COUNTS — THE CONJUNCTION, AND WHY IT IS NEITHER NARROWER NOR WIDER
 * ----------------------------------------------------------------------
 * The question is not "is there a cascade into role_permissions". It is: **does deleting a role row
 * write into a table that carries a recovery-authority trigger?** Three conjuncts, each of which
 * has to be there:
 *
 *  1. **The FK targets the session-resolved `roles` relation** (`con.confrelid = to_regclass(...)`).
 *  2. **The child table carries a canonical recovery-authority trigger.** Derived from the catalog
 *     via the census's function list, never from a hand-typed table list. This conjunct is what
 *     keeps the predicate from over-widening: `20250925_create_view_tables.sql:261` conditionally
 *     adds `view_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles(id)` and
 *     `view_permissions` carries NO recovery-authority trigger, so a cascade there fires nothing.
 *     Counting it would produce a FALSE PRESENT — and a false PRESENT is not noise: it makes this
 *     battery exit 1 `not_driven_reason_expired` and refuse to produce ANY evidence, blocking the
 *     L1 evidence path on a premise that was never refuted.
 *  3. **The FK's ON-parent-delete action performs child DML** — see `roleDeleteCascadeExists`.
 *
 * `033_create_rbac_core.sql` creates BOTH `role_permissions.role_id` (:17) and `user_roles.role_id`
 * (:36) as `REFERENCES roles(id) ON DELETE CASCADE`, each under its own `CREATE TABLE IF NOT
 * EXISTS`, so the two outcomes are INDEPENDENT: a database can have one without the other. Both
 * tables carry a canonical trigger (`trg_role_permissions_recovery_authority_lock` and
 * `trg_user_roles_recovery_authority_lock`; the latter is installed by the migration's
 * `USER_TRIGGERS` loop), so both expire the excuse. An earlier version of this query inspected only
 * `role_permissions` and would have answered ABSENT on a database whose `user_roles` cascade was
 * live.
 *
 * DELIBERATELY NOT NARROWED TO `roles.id`. Postgres fires the referential action when the
 * REFERENCED ROW is deleted, whichever unique column the FK points at, so an `AND … attname = 'id'`
 * conjunct could only ever manufacture a false ABSENT. It is also moot in practice:
 * `033_create_rbac_core.sql:5` makes `id` the primary key of `roles`.
 *
 * SCHEMA/OID BINDING — CANONICAL, NOT SESSION-RESOLVED. This query binds `roles` to
 * `<canonicalSchema>.roles`. It used to bind the bare name `to_regclass('roles')`, which resolves
 * through the SESSION's `search_path`; the docblock here defended that as safe because "a decoy
 * `roles` in a schema that is not on the path can neither be mistaken for the real one nor hide
 * it". That sentence was true and covered only the case it named. A decoy that IS on the path —
 * reached via a `"$user"` schema the connecting role owns, a `SET search_path`, a DSN `options=`,
 * an `ALTER ROLE … SET`, or a `CREATE TEMP TABLE roles` — silently retargeted the query, which then
 * returned zero rows and was reported as `CASCADE ABSENT (premise CONFIRMED)`, exit 0, on a
 * database whose cascade was live. Reproduced end to end on PG 15 with the shipped probe and
 * classifier; see `docs/development/role-cascade-witness-shadow-resolution-repro-20260824.md`.
 *
 * The coupled presence control could not catch it BECAUSE it was coupled: it resolved `roles` the
 * same way, so it failed for the same reason — satisfied by the decoy — while the other half of the
 * control (a relation carrying a canonical trigger) was satisfied by the REAL child in the real
 * schema. Two counters, two different relations, both green.
 *
 * PARAMETERISED, NOT HARD-CODED. Hard-coding `public.` would blind every real-DB golden this repo
 * runs in a per-run random schema — which is why the bare name was chosen originally. So the schema
 * is a parameter: production passes `EXPECTED_AUTHORITY_SCHEMA`, DERIVED from the containment
 * census's own `EXPECTED_AUTHORITY_TRIGGERS` (all nine of which are `public`) rather than retyped;
 * the goldens pass the random schema they just created.
 */
/**
 * The relation-binding SQL fragments every consumer of the witness query must pair with it.
 *
 * ONE DEFINITION, and the two halves are no longer coupled through the same resolution — that
 * coupling is precisely what made the old positive control unable to fail:
 *
 *   • `canonicalRolesOid` — `to_regclass('<canonicalSchema>.roles')`, the relation the witness query
 *     itself binds to. This is the PRIMARY correctness mechanism: the query looks at the canonical
 *     relation whatever the session's `search_path` happens to say.
 *   • `sessionRolesOid` — `to_regclass('roles')`, what the session WOULD have resolved. Compared
 *     against the canonical OID purely as a tamper/drift detector: a mismatch means the observed
 *     environment is not the one we think we are observing, so the observation is refused rather
 *     than certified. Defence in depth, not the thing that makes the verdict right.
 *   • `visibleRolesRelations` — how many ordinary/partitioned `roles` relations sit on the session's
 *     `search_path` at all. A DIAGNOSTIC second door: it converges on nothing by itself (a single
 *     WRONG schema on the path counts exactly one), which is why it must never be traded off
 *     against the OID equality above. If these two ever conflict, weaken THIS one.
 *
 * `relkind IN ('r','p')` because `con.confrelid` can only ever be an ordinary or partitioned table;
 * a VIEW named `roles` would otherwise report presence for a query guaranteed to return nothing.
 */
export function buildRoleCascadeBindingSql(canonicalSchema) {
  const schema = assertBindableSchemaName(canonicalSchema)
  const canonicalOid = `to_regclass('${schema}.roles')`
  return {
    schema,
    canonicalRolesOidSql: canonicalOid,
    /** The canonical relation exists AND is a table — not a view, not absent. */
    canonicalRolesPresentSql: `EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class rel
      WHERE rel.oid = ${canonicalOid}
        AND rel.relkind IN ('r', 'p')
    )`,
    /** What the session's own search_path resolves the bare name to, as a schema name or NULL. */
    sessionRolesSchemaSql: `(
      SELECT ns.nspname
      FROM pg_catalog.pg_class rel
      JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE rel.oid = to_regclass('roles')
        AND rel.relkind IN ('r', 'p')
    )`,
    /** The session's resolution agrees with the canonical binding. */
    sessionBindsCanonicalSql: `(
      to_regclass('roles') IS NOT NULL
      AND to_regclass('roles') = ${canonicalOid}
    )`,
    /** How many `roles` tables are visible anywhere on the session's search_path (incl. pg_temp). */
    visibleRolesRelationsSql: `(
      SELECT count(*)
      FROM pg_catalog.pg_class rel
      JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE rel.relname = 'roles'
        AND rel.relkind IN ('r', 'p')
        AND ns.nspname = ANY (current_schemas(true))
    )`,
    /**
     * Relations carrying a canonical recovery-authority trigger, SCOPED TO THE CANONICAL SCHEMA.
     *
     * Globally-counted carriers are what let the old control pass while the resolved `roles` sat in
     * a different schema entirely. All nine `EXPECTED_AUTHORITY_TRIGGERS` are canonical-schema
     * relations, so scoping loses no legitimate carrier.
     */
    canonicalTriggerCarriersSql: `(
      SELECT count(DISTINCT trg.tgrelid)
      FROM pg_catalog.pg_trigger trg
      JOIN pg_catalog.pg_proc prc ON prc.oid = trg.tgfoid
      JOIN pg_catalog.pg_class rel ON rel.oid = trg.tgrelid
      JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE NOT trg.tgisinternal
        AND ns.nspname = '${schema}'
        AND prc.proname IN (${RECOVERY_AUTHORITY_TRIGGER_FUNCTION_SQL_LIST})
    )`,
    /** AUDIT-ONLY, decides nothing — see the witness runner's docblock. */
    rolesReferencingFksSql: `(
      SELECT count(*)
      FROM pg_catalog.pg_constraint fk
      WHERE fk.contype = 'f'
        AND fk.confrelid = ${canonicalOid}
    )`,
  }
}

/** The canonical schema production binds to. Derived from the containment census, never retyped. */
export const CANONICAL_ROLES_SCHEMA = EXPECTED_AUTHORITY_SCHEMA

export function buildRoleCascadeWitnessQuery(canonicalSchema) {
  const { canonicalRolesOidSql } = buildRoleCascadeBindingSql(canonicalSchema)
  return `
  SELECT
    child_ns.nspname AS child_schema,
    child.relname AS child_table,
    con.conname AS conname,
    con.confdeltype AS confdeltype
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class child ON child.oid = con.conrelid
  JOIN pg_catalog.pg_namespace child_ns ON child_ns.oid = child.relnamespace
  WHERE con.contype = 'f'
    AND con.confrelid = ${canonicalRolesOidSql}
    AND EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger tg
      JOIN pg_catalog.pg_proc fn ON fn.oid = tg.tgfoid
      WHERE tg.tgrelid = con.conrelid
        AND NOT tg.tgisinternal
        AND fn.proname IN (${RECOVERY_AUTHORITY_TRIGGER_FUNCTION_SQL_LIST})
    )
  ORDER BY child_ns.nspname, child.relname, con.conname
`
}

/**
 * The `confdeltype` letters that make a parent delete WRITE INTO THE CHILD ROW.
 *
 * The nine recovery-authority triggers are `BEFORE INSERT OR UPDATE OR DELETE` (see
 * `zzzz20260721121000_add_recovery_authority_locks.ts` — the `USER_TRIGGERS` loop, the
 * `role_permissions` trigger, and the three subject-keyed ones). So the question is not "is it
 * CASCADE" but "does the child row get touched at all":
 *
 *   'c' CASCADE     → the child row is DELETEd      → trigger fires
 *   'n' SET NULL    → the child row is UPDATEd      → trigger fires
 *   'd' SET DEFAULT → the child row is UPDATEd      → trigger fires
 *   'a' NO ACTION   → no child DML (the parent delete is refused instead) → nothing fires
 *   'r' RESTRICT    → no child DML (the parent delete is refused instead) → nothing fires
 *
 * Accepting only 'c' — as this predicate originally did — leaves 'n' and 'd' classified as "no
 * cascade" on a database where deleting a role demonstrably fires a recovery-authority trigger.
 */
export const ROLE_DELETE_CHILD_WRITE_ACTIONS = Object.freeze(['c', 'n', 'd'])

/**
 * @returns true when the observed rows show a foreign key whose parent-delete action writes into a
 * recovery-authority-triggered child of `roles` — i.e. when the `roles:delete` NOT-DRIVEN excuse has
 * expired on the observed database.
 *
 * The rows are already conjunct-1 and conjunct-2 filtered by `buildRoleCascadeWitnessQuery` (FK →
 * `roles`, child carries a canonical trigger); this decides conjunct 3. The delete-action letters
 * live HERE and not in the SQL on purpose: the witness ships the SQL verbatim to the target host,
 * and the host program must observe without classifying.
 *
 * Kept under its original name because it is pinned by the witness runner, the witness workflow and
 * three test files; "cascade" now reads as "any parent-delete action that writes the child row".
 */
export function roleDeleteCascadeExists(rows = []) {
  return roleDeleteChildWrites(rows).length > 0
}

/**
 * The SAME predicate, returning the offending rows instead of a boolean, so a REFUTED verdict can
 * name what refuted it. Not a second definition: `roleDeleteCascadeExists` is defined in terms of
 * this, so the two can never disagree.
 */
export function roleDeleteChildWrites(rows = []) {
  return (rows ?? []).filter((row) => ROLE_DELETE_CHILD_WRITE_ACTIONS.includes(String(row?.confdeltype ?? '')))
}

/** Human-readable `schema.table (conname, action)` for a witness row — evidence, not a decision. */
export function describeRoleCascadeRow(row) {
  const schema = String(row?.child_schema ?? '?')
  const table = String(row?.child_table ?? '?')
  const conname = String(row?.conname ?? '?')
  const action = String(row?.confdeltype ?? '?')
  return `${schema}.${table} (${conname}, confdeltype=${action})`
}

/**
 * Census sites the battery deliberately does NOT drive, each with the concrete reason. No silent
 * caps: every entry here is printed in the run output and recorded in the evidence file.
 *
 * The recurring reasons, stated once:
 *  - **unknowable-lease-key**: the write's subject id is generated INSIDE the request
 *    (`crypto.randomUUID()`), so no lease can be pre-held on it. Actively constructing contention
 *    is impossible by construction, not merely inconvenient.
 *  - **no-trigger-on-target-table**: the call site is defensive; its target table carries none of
 *    the nine triggers, so no 40001 — and therefore no 409 — can be constructed for it at all.
 *  - **external-provider-required**: the surface's entry point is an external identity provider
 *    (DingTalk OAuth / a configured directory integration). Not drivable from a scratch database.
 *
 * For every site here, the CODE-LEVEL classification is already proven by the mechanical census
 * (`packages/core-backend/tests/unit/recovery-conflict-census.test.ts` + the runtime leg recorder
 * over `tests/unit/lib/recovery-census-table.ts`): each site is asserted to route through the one
 * classifier and to carry a discriminating behaviour leg. What this battery adds — and what it
 * cannot add for these — is the END-TO-END proof over real HTTP against a real held lease.
 */
export const NOT_DRIVEN_SITES = Object.freeze([
  {
    site: 'roles:update',
    reason: 'no-trigger-on-target-table',
    detail:
      "PUT /api/roles/:id writes only the `roles` table, which carries none of the nine recovery-authority triggers (they sit on role_permissions, not roles). No 40001 is constructible here; the sendIfRecoveryConflict call is defensive-only.",
  },
  {
    site: 'roles:delete',
    reason: 'no-trigger-on-target-table',
    detail:
      "DELETE /api/roles/:id deletes only from `roles`, which carries none of the nine triggers. Its documented blocking path is a foreign-key cascade into a triggered child — and no such FK EXISTS on a schema built by this repo's migration chain (role_permissions is created by 20250924190000_create_rbac_tables.ts with only a permission_code FK; 033_create_rbac_core.sql's cascading role_permissions (:17) and user_roles (:36) versions are both no-op CREATE TABLE IF NOT EXISTS). Verified empirically: driving it under a held role lease returned 200, and pg_constraint shows no roles-referencing FK. Re-checked at runtime by buildRoleCascadeWitnessQuery over EVERY recovery-authority-triggered child of roles, for every parent-delete action that writes the child row (CASCADE / SET NULL / SET DEFAULT) — if any of them exists on the target database, the battery FAILS rather than keep this excuse.",
  },
  {
    site: 'auth:register',
    reason: 'unknowable-lease-key',
    detail:
      'AuthService.register mints the new user id with crypto.randomUUID() inside the transaction, so the battery cannot hold a lease on the subject the users/user_roles triggers will key on.',
  },
  {
    site: 'admin-users:create-user',
    reason: 'unknowable-lease-key',
    detail:
      'POST /api/admin/users likewise mints `const userId = crypto.randomUUID()` server-side; the client cannot supply an id.',
  },
  {
    site: 'auth:invite-accept',
    reason: 'unknowable-lease-key',
    detail:
      'Invite acceptance provisions the accepting user inside the accept transaction; the id the users/user_roles triggers key on is not knowable before the call.',
  },
  {
    site: 'invite-accept-writes:apply',
    reason: 'unknowable-lease-key',
    detail: 'Service half of auth:invite-accept — same unknowable subject id.',
  },
  {
    site: 'user-activate:activate',
    reason: 'external-provider-required',
    detail:
      "activatePendingUser only acts on users whose activation_status is 'pending_activation'; that status is written exclusively by directory-sync / DingTalk provisioning, which need an external provider. A scratch database has no pending user to activate.",
  },
  {
    site: 'admin-users:activate-mapping',
    reason: 'external-provider-required',
    detail:
      'HTTP half of user-activate:activate (mapActivateError). Unreachable for the same reason — no pending user exists without an external provider.',
  },
  {
    site: 'attendance-admin:assign',
    reason: 'orthogonal-fixture-cost',
    detail:
      'Requires attendance org onboarding + attendance-admin scoping fixtures. The write it performs is INSERT INTO user_roles keyed on user_id — the SAME table and the SAME lease key as admin-users:role-assign, which IS driven.',
  },
  {
    site: 'attendance-admin:unassign',
    reason: 'orthogonal-fixture-cost',
    detail: 'As attendance-admin:assign; DELETE FROM user_roles, same table and lease key as the driven admin-users:role-unassign.',
  },
  {
    site: 'attendance-admin:batch-assign',
    reason: 'orthogonal-fixture-cost',
    detail: 'Batch form of attendance-admin:assign; same table and lease key.',
  },
  {
    site: 'attendance-admin:batch-unassign',
    reason: 'orthogonal-fixture-cost',
    detail: 'Batch form of attendance-admin:unassign; same table and lease key.',
  },
  { site: 'auth:dingtalk-unbind', reason: 'external-provider-required', detail: 'Requires a user with a bound DingTalk identity, which only the DingTalk OAuth provisioning path can create.' },
  { site: 'auth:dingtalk-callback', reason: 'external-provider-required', detail: 'Requires a real DingTalk OAuth callback carrying an auth code the DingTalk platform issued; not constructible locally.' },
  {
    site: 'auth:dingtalk-callback-activate-passthrough',
    reason: 'external-provider-required',
    detail: 'Sub-branch of auth:dingtalk-callback — same entry point.',
  },
  { site: 'auth:container-login', reason: 'external-provider-required', detail: 'Requires the DingTalk container login handshake, i.e. a request originating inside the DingTalk client.' },
  { site: 'dingtalk-oauth:provision', reason: 'external-provider-required', detail: 'Service half of the DingTalk OAuth path; only reachable through a real DingTalk callback.' },
  { site: 'dingtalk-oauth:bind-identity', reason: 'external-provider-required', detail: 'Service half of the DingTalk OAuth path; only reachable through a real DingTalk callback.' },
  { site: 'dingtalk-oauth:self-unbind', reason: 'external-provider-required', detail: 'Service half of the DingTalk self-unbind path; requires an existing bound DingTalk identity.' },
  { site: 'directory-sync:sync-local-apply', reason: 'external-provider-required', detail: 'Needs a configured directory integration to sync from; a scratch database has no provider rows at all.' },
  { site: 'directory-sync:bind', reason: 'external-provider-required', detail: 'Needs a configured directory integration plus a remote identity to bind the local user to.' },
  { site: 'directory-sync:admit', reason: 'external-provider-required', detail: 'Needs a configured directory integration plus a pending remote member to admit.' },
  { site: 'directory-sync:unbind', reason: 'external-provider-required', detail: 'Needs a configured directory integration plus an existing binding to remove.' },
  { site: 'deprovision-evidence:compensate', reason: 'external-provider-required', detail: 'Needs a directory-provisioned binding plus deprovision evidence rows; both originate from a configured directory integration.' },
  { site: 'deprovision-evidence:restore', reason: 'external-provider-required', detail: 'Needs a directory-provisioned binding plus deprovision evidence rows; both originate from a configured directory integration.' },
  { site: 'deprovision-ledger:apply', reason: 'external-provider-required', detail: 'Needs a directory-provisioned binding to deprovision; no such binding exists without an external directory integration.' },
  { site: 'admin-directory:sync-async', reason: 'external-provider-required', detail: 'Directory admin HTTP endpoint; refuses before any recovery-authority write unless a directory integration is configured.' },
  { site: 'admin-directory:sync', reason: 'external-provider-required', detail: 'Directory admin HTTP endpoint; refuses before any recovery-authority write unless a directory integration is configured.' },
  { site: 'admin-directory:bind', reason: 'external-provider-required', detail: 'Directory admin HTTP endpoint; refuses before any recovery-authority write unless a directory integration is configured.' },
  { site: 'admin-directory:admit-user', reason: 'external-provider-required', detail: 'Directory admin HTTP endpoint; refuses before any recovery-authority write unless a directory integration is configured.' },
  { site: 'admin-directory:batch-bind', reason: 'external-provider-required', detail: 'Directory admin HTTP endpoint; refuses before any recovery-authority write unless a directory integration is configured.' },
  { site: 'admin-directory:batch-admit', reason: 'external-provider-required', detail: 'Directory admin HTTP endpoint; refuses before any recovery-authority write unless a directory integration is configured.' },
  { site: 'admin-directory:unbind', reason: 'external-provider-required', detail: 'Directory admin HTTP endpoint; refuses before any recovery-authority write unless a directory integration is configured.' },
  { site: 'admin-directory:batch-unbind', reason: 'external-provider-required', detail: 'Directory admin HTTP endpoint; refuses before any recovery-authority write unless a directory integration is configured.' },
  { site: 'admin-directory:deprovision-restore', reason: 'external-provider-required', detail: 'Directory admin HTTP endpoint; needs deprovision evidence rows, which only directory deprovisioning creates.' },
  { site: 'admin-directory:compensate-deny', reason: 'external-provider-required', detail: 'Directory admin HTTP endpoint; needs deprovision evidence rows, which only directory deprovisioning creates.' },
  // --- O2-D1 denominator slice (2026-08-23): the seven sites added when
  // routes/univer-meta.ts and auth/AuthService.ts entered the census denominator.
  //
  // The five univer-meta sites are NOT excused as unreachable: all three tables they write
  // (spreadsheet_permissions / field_permissions / record_permissions) DO carry
  // recovery-authority triggers, so a 40001 is constructible at every one of them and each
  // already answers the exact uniform 409. They are excused on FIXTURE COST alone — the
  // battery builds users/roles/permissions fixtures, not a univer spreadsheet with sheets,
  // fields and records.
  //
  // Whether the battery SHOULD grow to drive them is deliberately NOT decided here: the
  // driven-surface set is what an L1 battery PASS attests, and that set is cited by the
  // RATIFIED enablement-ladder doc. Widening it changes the meaning of the L1 gate, which
  // is an owner amendment, not a mechanical ledger edit. Raised on the owner sheet instead.
  {
    site: 'univer-meta:sheet-permissions-put',
    reason: 'orthogonal-fixture-cost',
    detail:
      'PUT sheet permissions writes spreadsheet_permissions, guarded by trg_spreadsheet_permissions_recovery_authority_lock — a 40001 IS constructible here and the route already answers the uniform 409. Excused only because driving it needs a univer spreadsheet + sheet fixture this battery does not build.',
  },
  {
    site: 'univer-meta:field-permissions-put',
    reason: 'orthogonal-fixture-cost',
    detail:
      'PUT field permissions writes field_permissions, guarded by trg_field_permissions_recovery_authority_lock. Constructible and already mapped; excused only on the univer sheet + field fixture cost.',
  },
  {
    site: 'univer-meta:config-restore-execute',
    reason: 'orthogonal-fixture-cost',
    detail:
      'POST config-restore-execute reaches field_permissions / spreadsheet_permissions through applyPermissionDeEscalation, both trigger-guarded. This is the site whose outer catch did NOT classify until #5114 — its 40001 landed as an unmapped 500. Excused only on fixture cost: driving it needs a spreadsheet with a restorable config snapshot. Its behaviour leg asserts the 409 directly.',
  },
  {
    site: 'univer-meta:record-permissions-put',
    reason: 'orthogonal-fixture-cost',
    detail:
      'PUT record permissions writes record_permissions, guarded by trg_record_permissions_recovery_authority_lock. Constructible and already mapped; excused only on the univer sheet + record fixture cost.',
  },
  {
    site: 'univer-meta:record-permissions-delete',
    reason: 'orthogonal-fixture-cost',
    detail:
      'DELETE record permission deletes from record_permissions, same trigger and same lease key as univer-meta:record-permissions-put. Excused only on the same univer sheet + record fixture cost.',
  },
  {
    site: 'auth-service:register-user-roles',
    reason: 'unknowable-lease-key',
    detail:
      'Service half of the already-excused auth:register — AuthService.register mints the new user id with crypto.randomUUID() inside the transaction, so the battery cannot hold a lease on the subject the users/user_roles triggers key on. This site is the bounded in-transaction retry, which surfaces a typed UserRoleAssignmentRecoveryBusyError rather than a 409.',
  },
  {
    site: 'auth-service:self-service-backfill',
    reason: 'orthogonal-fixture-cost',
    detail:
      'The read-path RBAC backfill in resolveRbacProfile writes user_roles — the SAME table and the SAME lease key as admin-users:role-assign, which IS driven. Excused because reaching it needs a user that is MISSING the self-service role while attendance self-service is enabled, a state the battery does not construct. Like the register site, it surfaces a typed throw, not a 409.',
  },
])

/**
 * THE SECOND ANTI-DRIFT AXIS — trigger coverage.
 *
 * The census-site ledger above is anchored on `recovery-census-table.ts`, which registers WRITE
 * SURFACES, and its set-equality only proves each site is ACCOUNTED FOR — driven or excused. It
 * says nothing about whether a given TRIGGER ever fired: a table whose every census site sits in
 * NOT_DRIVEN_SITES passes the census axis untouched, and that is exactly the state
 * `field_permissions` and `record_permissions` are in today. L1 is a statement about the NINE
 * TRIGGERS, so the nine triggers get their own explicit accounting.
 *
 * Every trigger in `EXPECTED_AUTHORITY_TRIGGERS` must be either exercised by a driven surface or
 * named here with a reason; the hermetic guard asserts that partition is exact and disjoint. The
 * battery therefore cannot silently claim trigger-level coverage it does not have — and the
 * verdict line prints the ratio rather than letting "11/11 surfaces" be misread as "9/9 triggers".
 *
 * ENTRY SHAPE — a machine-checkable claim, not just prose (the reason this shape exists):
 * the first two entries below used to justify themselves with "the table has no row in
 * recovery-census-table.ts, so there is no census-anchored HTTP surface to drive". That was true
 * when written and became FALSE the moment `routes/univer-meta.ts` entered the census — and
 * NOTHING failed, because nothing checked an exemption's justification. The excuse would have
 * shipped verbatim into `trigger_coverage.not_exercised` of every future evidence artefact.
 *
 * So the census-anchoring half of each justification is no longer prose. `censusAnchoredSites`
 * states, as data, exactly which registered census sites target this trigger's table; the hermetic
 * guard checks that claim against the parsed census (and against NOT_DRIVEN_SITES) on every run,
 * so an entry that stops being true reds instead of rotting. Prose stays in `detail`, where it can
 * only ever ADD colour to a claim the machine already verified — mirroring the `reason` (enum) +
 * `detail` (prose) shape NOT_DRIVEN_SITES already uses.
 */
export const TRIGGER_COVERAGE_EXEMPTIONS = Object.freeze([
  {
    trigger: 'trg_field_permissions_recovery_authority_lock',
    table: 'field_permissions',
    reason: 'orthogonal-fixture-cost',
    censusAnchoredSites: ['univer-meta:field-permissions-put', 'univer-meta:config-restore-execute'],
    detail:
      'REACHABLE, not inert — do not read this entry as "no surface exists". Two registered census sites write field_permissions: PUT field-permissions directly, and config-restore-execute through applyPermissionDeEscalation. Both go through the subject-dispatch trigger function (metasheet_recovery_authority_subject_trigger), so a 40001 is constructible at either and both routes already answer the uniform 409. Excused only on fixture cost: this battery builds users/roles/permissions fixtures, not a univer spreadsheet with sheets and fields — which is why both sites are ALSO carried in NOT_DRIVEN_SITES on the same orthogonal-fixture-cost reason. Note what is and is not missing: the trigger FUNCTION is exercised end-to-end by the driven spreadsheet_permissions surfaces, which fire the same function — though only down its subject_type "user" branch, so the role and member-group dispatch arms go unfired too. What is untested here is the installation of this trigger on this table.',
  },
  {
    trigger: 'trg_record_permissions_recovery_authority_lock',
    table: 'record_permissions',
    reason: 'orthogonal-fixture-cost',
    censusAnchoredSites: ['univer-meta:record-permissions-put', 'univer-meta:record-permissions-delete'],
    detail:
      'REACHABLE, not inert — same posture as the field_permissions twin. Two registered census sites write record_permissions (PUT and DELETE record permissions), both dispatching through metasheet_recovery_authority_subject_trigger, both constructible, both already answering the uniform 409. Excused only on fixture cost: driving them needs a univer spreadsheet with sheets and records, which this battery does not build — so both sites are carried in NOT_DRIVEN_SITES on the same orthogonal-fixture-cost reason. As above, the trigger FUNCTION is exercised by the driven spreadsheet_permissions surfaces (subject_type "user" branch only); the installation of this trigger on this table is what goes untested.',
  },
  {
    trigger: 'trg_users_recovery_authority_lock_lifecycle',
    table: 'users',
    reason: 'unknowable-lease-key',
    censusAnchoredSites: ['auth:register', 'admin-users:create-user'],
    detail:
      'Fires on INSERT and DELETE of users. Every HTTP path that inserts a user mints its id server-side (crypto.randomUUID in AuthService.register and in POST /api/admin/users), so no lease can be pre-held on the subject the trigger keys on; and no admin HTTP endpoint DELETEs a user at all. Unlike the UPDATE-side twin (trg_users_..._lock_update, which IS driven), this one is not reachable with a knowable lease key. Census-anchored surfaces DO exist — the two INSERT sites named above — which is precisely why the cap is the lease key and not the absence of a surface.',
  },
])

/** The exact triggers the driven surfaces exercise, deduplicated, in ledger order. */
export function exercisedTriggers() {
  const seen = []
  for (const surface of DRIVEN_SURFACES) {
    if (!seen.includes(surface.trigger)) seen.push(surface.trigger)
  }
  return seen
}

/** Trigger-coverage accounting for the evidence file. */
export function triggerCoverage(expected = EXPECTED_AUTHORITY_TRIGGERS) {
  const exercised = exercisedTriggers()
  return {
    exercised_count: exercised.length,
    total_count: expected.length,
    exercised,
    not_exercised: TRIGGER_COVERAGE_EXEMPTIONS.map((entry) => ({
      ...entry,
      // Deep-copy the claim array: the module-level freeze is shallow, so a spread alone would
      // hand every evidence consumer a live reference to the ledger's own array.
      censusAnchoredSites: [...entry.censusAnchoredSites],
    })),
  }
}

/** Every census site this battery accounts for, driven first then not-driven, in ledger order. */
export function ledgerSites() {
  const sites = []
  for (const surface of DRIVEN_SURFACES) sites.push(...surface.censusSites)
  for (const entry of NOT_DRIVEN_SITES) sites.push(entry.site)
  return sites
}

/** Driven surfaces in execution order (destructive surfaces last). */
export function orderedSurfaces() {
  return [...DRIVEN_SURFACES].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested hermetically)
// ---------------------------------------------------------------------------

export const USAGE = [
  'usage: DATABASE_URL=... APP_URL=... BATTERY_ADMIN_EMAIL=... BATTERY_ADMIN_PASSWORD=... \\',
  '         node scripts/ops/multitable-l1-battery.mjs [--out PATH] [--timeout-ms N]',
  '',
  '  --out PATH        evidence JSON destination (default ./l1-battery-evidence.json)',
  '  --timeout-ms N    per-HTTP-call timeout in milliseconds (default 20000)',
  '',
  '  BATTERY_STAMP     optional run stamp; synthetic objects are named o2bat_<stamp>_*',
].join('\n')

/**
 * Strict CLI parsing: an unknown flag is a refusal, never a silently-ignored argument.
 * @returns {{ ok: true, options: { out: string, timeoutMs: number } } | { ok: false, output: string }}
 */
export function parseCliArgs(argv = []) {
  const options = { out: DEFAULT_OUT, timeoutMs: DEFAULT_TIMEOUT_MS }
  const args = argv.filter((arg) => arg !== '')
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--out' || arg === '--timeout-ms') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, output: `VERDICT: NOT_ARMED - ${arg} requires a value\n\n${USAGE}` }
      }
      index += 1
      if (arg === '--out') {
        options.out = value
      } else {
        const parsed = Number(value)
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return { ok: false, output: `VERDICT: NOT_ARMED - --timeout-ms must be a positive number\n\n${USAGE}` }
        }
        options.timeoutMs = parsed
      }
      continue
    }
    return { ok: false, output: `VERDICT: NOT_ARMED - unrecognised argument\n\n${USAGE}` }
  }
  return { ok: true, options }
}

/**
 * A canonical row with `enabled` neutralised — the trigger's IDENTITY, i.e. everything the
 * containment census pins about it except the fire/inert state. Both sides of the posture
 * comparison go through this, so the compared field set is exactly whatever
 * `canonicalTrigger` publishes: the battery can never carry a narrower list than the census
 * (a field added to the containment canonicalizer is compared here for free).
 */
function triggerIdentity(row) {
  return { ...canonicalTrigger(row), enabled: null }
}

/** A value guaranteed to render differently from `expected` in a diagnostic. */
function describeField(value) {
  return JSON.stringify(value)
}

/**
 * Posture judgement over the SHARED authority-trigger/function catalogue rows
 * (`AUTHORITY_TRIGGER_SNAPSHOT_QUERY` / `AUTHORITY_FUNCTION_SNAPSHOT_QUERY`).
 *
 * WHAT "ARMED" MEANS — CANONICAL IDENTITY, NOT A NAME (P2, owner-constructed escape):
 * this check once keyed on `trigger_name` alone and read only `tgenabled`, so a trigger of the
 * RIGHT NAME on the WRONG TABLE certified `ARMED - 9/9` while an authority table (e.g. `user_roles`)
 * carried no trigger at all — a false-ARMED that silently voids every downstream 409 claim. Each
 * expected trigger must now match its census row on EVERY canonical field — schema, table, name,
 * function schema+name, event type (`tgtype`), argument bytes, and UPDATE-OF columns — with the
 * ONE deliberate difference from the containment module: at L1 the expectation on `tgenabled` is
 * "fires" (∈ {O,A}), not the factory-inert 'D'. Every other field is compared against the very
 * same expected census `multitable-recovery-schema-containment.mjs` publishes.
 *
 * The six authority FUNCTION bodies are checked too: a trigger that is canonically perfect but
 * fires a `CREATE OR REPLACE`d, neutered function body is the same false-ARMED wearing a different
 * hat. Function fingerprints are enabled-state-independent, so this borrows the containment
 * expectations verbatim. Function rows are REQUIRED: `functionRows: null` is NOT_ARMED
 * (fail-closed — an unobserved function set must never read as a verified one).
 *
 * FAIL-NOT-SKIP: anything short of the above is NOT_ARMED with a NON-ZERO exit. A battery that
 * skipped (exit 0) on a disarmed database would report the strongest possible evidence — a clean
 * run — for the weakest possible posture.
 *
 * @param {Array<object>} rows                     pg_trigger catalogue rows (shared query)
 * @param {Array<object>} expected                 expected canonical triggers (census of record)
 * @param {{ functionRows?: Array<object>|null, expectedFunctions?: Array<object> }} options
 */
export function evaluatePosture(rows = [], expected = EXPECTED_AUTHORITY_TRIGGERS, options = {}) {
  const {
    functionRows = null,
    expectedFunctions = EXPECTED_AUTHORITY_FUNCTIONS,
    shadowFunctionRows = null,
  } = options
  const observed = rows.map((row) => canonicalTrigger(row))
  const expectedNames = new Set(expected.map((trigger) => String(trigger.triggerName)))
  const claimed = new Set()
  const fingerprint = {}
  const offenders = []
  const unexpectedTriggers = []
  let armedCount = 0

  for (const expectation of expected) {
    const want = triggerIdentity(expectation)
    const site = `${want.schemaName}.${want.tableName}.${want.triggerName}`
    const index = observed.findIndex(
      (row, position) =>
        !claimed.has(position) &&
        row.schemaName === want.schemaName &&
        row.tableName === want.tableName &&
        row.triggerName === want.triggerName,
    )

    if (index === -1) {
      // The owner's escape: the expected (schema, table, name) site is empty, but a trigger of
      // that NAME sits somewhere else. Name it as a TABLE divergence, not a bare "absent" —
      // "absent" would understate a planted impostor.
      const impostorIndex = observed.findIndex(
        (row, position) => !claimed.has(position) && row.triggerName === want.triggerName,
      )
      if (impostorIndex === -1) {
        fingerprint[want.triggerName] = null
        offenders.push(`${site} (absent)`)
      } else {
        claimed.add(impostorIndex)
        const impostor = observed[impostorIndex]
        fingerprint[want.triggerName] = {
          observed_on: `${impostor.schemaName}.${impostor.tableName}`,
          enabled: impostor.enabled,
        }
        offenders.push(
          `${site} (WRONG TABLE: ${want.schemaName}.${want.tableName} carries no trigger of this name; ` +
            `a trigger named ${want.triggerName} exists on ${impostor.schemaName}.${impostor.tableName} instead — ` +
            'the authority table is UNPROTECTED)',
        )
      }
      continue
    }

    claimed.add(index)
    const got = observed[index]
    fingerprint[want.triggerName] = {
      observed_on: `${got.schemaName}.${got.tableName}`,
      enabled: got.enabled,
    }
    const gotIdentity = { ...got, enabled: null }
    // Field set derived from the canonical row itself — never a second hand-written list.
    const divergent = Object.keys(want).filter(
      (field) => JSON.stringify(gotIdentity[field]) !== JSON.stringify(want[field]),
    )
    if (divergent.length > 0) {
      offenders.push(
        `${site} (canonical identity diverges — ${divergent
          .map((field) => `${field}=${describeField(gotIdentity[field])} expected ${describeField(want[field])}`)
          .join('; ')})`,
      )
      continue
    }
    if (!ENABLED_TRIGGER_STATES.has(got.enabled)) {
      offenders.push(`${site} (tgenabled='${got.enabled}')`)
      continue
    }
    armedCount += 1
  }

  // Leftovers. A leftover that COLLIDES with an expected trigger name is the escape signature and
  // is fatal; any other authority-function-bearing trigger the shared query surfaced is recorded
  // as drift for the evidence file but is NOT a posture refusal — set-equality drift is
  // multitable-recovery-schema-containment.mjs's job, and widening the battery into a second
  // containment check would fail-closed a genuinely armed staging host over an unrelated artefact.
  for (const [position, row] of observed.entries()) {
    if (claimed.has(position)) continue
    const site = `${row.schemaName}.${row.tableName}.${row.triggerName}`
    if (expectedNames.has(row.triggerName)) {
      offenders.push(
        `${site} (NAME COLLISION: an extra trigger carries the authority name ${row.triggerName} on a table the census does not name)`,
      )
    } else {
      unexpectedTriggers.push(site)
    }
  }

  // Function bodies. Same canonicalization, same expectations, no enabled-state dependence.
  const functionOffenders = []
  const unexpectedFunctions = []
  if (functionRows === null || functionRows === undefined) {
    functionOffenders.push(
      'authority function bodies were NOT observed — the preflight is fail-closed and cannot certify ARMED without them',
    )
  } else {
    const observedFunctions = functionRows.map((row) => canonicalFunction(row))
    const claimedFunctions = new Set()
    for (const expectation of expectedFunctions) {
      const want = canonicalFunction(expectation)
      const site = `${want.schemaName}.${want.functionName}(${want.identityArguments})`
      const index = observedFunctions.findIndex(
        (row, position) =>
          !claimedFunctions.has(position) &&
          row.schemaName === want.schemaName &&
          row.functionName === want.functionName &&
          row.identityArguments === want.identityArguments,
      )
      if (index === -1) {
        functionOffenders.push(`${site} (absent)`)
        continue
      }
      claimedFunctions.add(index)
      const got = observedFunctions[index]
      const divergent = Object.keys(want).filter(
        (field) => JSON.stringify(got[field]) !== JSON.stringify(want[field]),
      )
      if (divergent.length > 0) {
        // The body itself is never echoed (discretion): the diverging FIELD NAMES are the evidence.
        functionOffenders.push(
          `${site} (fingerprint diverges — field(s) [${divergent.join(', ')}] do not match the expected authority definition)`,
        )
      }
    }
    for (const [position, row] of observedFunctions.entries()) {
      if (claimedFunctions.has(position)) continue
      unexpectedFunctions.push(`${row.schemaName}.${row.functionName}(${row.identityArguments})`)
    }
  }

  // SHADOW FUNCTIONS (AUTHORITY_FUNCTION_SHADOW_QUERY). Historically the trigger functions called the
  // lease helpers by bare name with no `SET search_path`, so a same-named function in ANOTHER schema
  // (earlier on the default `"$user", public` path) could run INSTEAD of the real one and make an
  // EXCLUSIVE lease stop refusing the write. That root cause is now fixed at the source by
  // zzzz20260821120000 (schema-qualified `public.metasheet_try_recovery_authority_*` calls + a fixed
  // `SET search_path = pg_catalog, public`), so a shadow can no longer win the resolution. This census
  // is kept as DEFENSE-IN-DEPTH: an authority-named function outside `public` is still anomalous
  // (it should not exist; its presence signals tampering), so we still fail-closed on it — and
  // unobserved is not verified.
  const shadowOffenders = []
  if (shadowFunctionRows === null || shadowFunctionRows === undefined) {
    shadowOffenders.push(
      'schemas outside public were NOT searched for authority-named functions — the preflight is fail-closed and cannot certify ARMED without that observation',
    )
  } else {
    for (const row of shadowFunctionRows) {
      const canonical = canonicalFunction(row)
      shadowOffenders.push(
        `${canonical.schemaName}.${canonical.functionName}(${canonical.identityArguments}) is an authority-named function outside public; ` +
          'the shipped trigger functions resolve the helpers via schema-qualified public.* with a fixed SET search_path so it cannot win resolution, but its presence is anomalous (it should not exist) and is refused as a tampering signal',
      )
    }
  }

  return {
    armed:
      offenders.length === 0 &&
      functionOffenders.length === 0 &&
      shadowOffenders.length === 0 &&
      armedCount === expected.length,
    armedCount,
    expectedCount: expected.length,
    offenders,
    functionOffenders,
    shadowOffenders,
    unexpectedTriggers,
    unexpectedFunctions,
    fingerprint,
  }
}

/** The NOT_ARMED report (exit 2) for a posture that is not canonically 9/9 armed. */
export function notArmedReport(posture) {
  const functionOffenders = posture.functionOffenders ?? []
  const shadowOffenders = posture.shadowOffenders ?? []
  // A canonically perfect 9/9 trigger set whose FUNCTION definitions are unverified (drifted body,
  // or shadowed from another schema) is still NOT_ARMED, and the headline must say why — "only 9/9
  // triggers are installed AND ENABLED" would read as a contradiction and invite the reader to
  // dismiss it.
  const functionProblems = functionOffenders.length + shadowOffenders.length
  const headline =
    posture.armedCount === posture.expectedCount &&
    posture.offenders.length === 0 &&
    functionProblems > 0
      ? `VERDICT: NOT_ARMED - ${posture.armedCount}/${posture.expectedCount} recovery-authority triggers are canonical and ENABLED, but ${functionProblems} authority FUNCTION problem(s) mean the definition that would actually run is unverified; contention cannot be constructed and a pass must not be reported`
      : `VERDICT: NOT_ARMED - only ${posture.armedCount}/${posture.expectedCount} recovery-authority triggers are CANONICALLY installed AND ENABLED; the battery cannot construct contention and must not report a pass`
  return {
    exitCode: 2,
    output: [
      headline,
      ...posture.offenders.map((offender) => `  not armed: ${offender}`),
      ...functionOffenders.map((offender) => `  not armed: authority function ${offender}`),
      ...shadowOffenders.map((offender) => `  not armed: SHADOWED authority function — ${offender}`),
      '  remedy: this database is not at ladder L1 posture. A trigger/function whose canonical identity',
      '          diverges is a SCHEMA defect, not a switch: re-run the recovery-authority migration, then arm with',
      '          `node scripts/ops/multitable-recovery-authority-triggers.mjs enable` (owner-gated on real hosts).',
    ].join('\n'),
  }
}

/**
 * Redaction-filtered response excerpt. The excerpt is the REAL body text (never a fabricated
 * summary — 审计面禁止编造值), truncated, with every known secret replaced by a fixed token.
 */
export function sanitizeExcerpt(text, secrets = [], limit = 240) {
  let value = typeof text === 'string' ? text : ''
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue
    value = value.split(secret).join('[REDACTED]')
  }
  // Defence in depth for shapes we did not enumerate: bearer tokens and connection URIs.
  value = value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
  value = value.replace(/\b[a-z]+:\/\/[^\s"']*:[^\s"'@]*@[^\s"']*/gi, '[REDACTED-URI]')
  value = value.replace(/\beyJ[A-Za-z0-9._-]{16,}/g, '[REDACTED-JWT]')
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/** Read the published error code out of a response body of either supported shape. */
export function extractErrorCode(body) {
  if (!body || typeof body !== 'object') return null
  const nested = body.error
  if (nested && typeof nested === 'object' && typeof nested.code === 'string') return nested.code
  if (typeof body.code === 'string') return body.code
  return null
}

/**
 * Phase-3 judgement for one surface. Named, distinct failure classes — a 2xx and a 5xx are
 * opposite defects and must never collapse into a single "unexpected" bucket.
 */
export function classifyBlockedOutcome(surface, status, body) {
  const expectedCode = surface.expectedBlockedCode ?? RECOVERY_CONFLICT_HTTP_CODE
  const code = extractErrorCode(body)
  if (status >= 200 && status < 300) {
    return {
      ok: false,
      failure: 'trigger_did_not_fire',
      reason: `${surface.id}: write SUCCEEDED (${status}) while an EXCLUSIVE ${surface.lease} lease was held — the recovery-authority trigger did not fire. L1 would be observing nothing.`,
    }
  }
  if (status >= 500) {
    return {
      ok: false,
      failure: 'unmapped_5xx',
      reason: `${surface.id}: unmapped ${status} under a held lease — this write surface does not route the 40001 through the single classifier.`,
    }
  }
  if (status !== RECOVERY_CONFLICT_HTTP_STATUS) {
    return {
      ok: false,
      failure: 'unexpected_status',
      reason: `${surface.id}: expected ${RECOVERY_CONFLICT_HTTP_STATUS} under a held lease, got ${status}.`,
    }
  }
  if (code !== expectedCode) {
    return {
      ok: false,
      failure: 'unexpected_code',
      reason: `${surface.id}: 409 carried code ${code === null ? '<none>' : `'${code}'`}, expected '${expectedCode}'.`,
    }
  }
  return { ok: true, failure: null, reason: null }
}

/** Phase-4 (positive control) judgement for one surface. */
export function classifyClearedOutcome(surface, status) {
  if (status >= 200 && status < 300) return { ok: true, failure: null, reason: null }
  return {
    ok: false,
    failure: 'positive_control_failed',
    reason: `${surface.id}: after the lease was released the write still failed (${status}) — the phase-3 409 is NOT proven lease-caused.`,
  }
}

/** Wrong-kind control judgement: the other lease kind must NOT block. */
export function classifyWrongKindOutcome(control, status) {
  if (status >= 200 && status < 300) return { ok: true, failure: null, reason: null }
  return {
    ok: false,
    failure: 'wrong_kind_control_failed',
    reason: `${control.id}: holding a ${control.heldLease} lease blocked a ${control.targetLease}-keyed write (${status}). The trigger→lease-kind mapping is not what the ledger claims, so the phase-3 409s do not identify a mechanism.`,
  }
}

/** Deterministic, collision-resistant run stamp (lowercase alnum only — safe in emails and ids). */
export function buildStamp(explicit, now = Date.now(), random = Math.random) {
  const raw = String(explicit ?? '').trim()
  if (raw) {
    const cleaned = raw.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (cleaned) return cleaned.slice(0, 24)
  }
  const suffix = Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0')
  return `${now.toString(36)}${suffix}`
}

/** The synthetic object names for a run — all stamped, hence greppable as residue. */
export function buildNames(stamp) {
  const base = `${STAMP_PREFIX}${stamp}`
  return {
    base,
    email: `${base}_u1@battery.invalid`,
    userName: `${base}_user`,
    groupName: `${base}_grp`,
    sheetId: `${base}_sheet`,
    roles: {
      assign: `${base}_ra`,
      unassign: `${base}_ru`,
      delegated: `${base}_dr`,
      create: `${base}_rc`,
    },
  }
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

// The posture preflight reads the SAME catalogue queries the containment census reads — there is
// no second, narrower field list anywhere in this battery. The battery's only divergence from
// containment is the EXPECTATION on tgenabled (see evaluatePosture), never the observation.
const POSTURE_TRIGGER_QUERY = AUTHORITY_TRIGGER_SNAPSHOT_QUERY
const POSTURE_FUNCTION_QUERY = AUTHORITY_FUNCTION_SNAPSHOT_QUERY
const POSTURE_FUNCTION_SHADOW_QUERY = AUTHORITY_FUNCTION_SHADOW_QUERY

function resolvePath(surface, ctx) {
  return typeof surface.path === 'function' ? surface.path(ctx) : surface.path
}

function resolveLeaseKey(surface, ctx) {
  if (surface.lease === 'role') {
    const ref = String(surface.leaseKeyRef ?? '').split('.')[1]
    return ctx.roles[ref]
  }
  return ctx.userId
}

class HttpClient {
  constructor({ appUrl, timeoutMs, secrets }) {
    this.appUrl = appUrl.replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
    this.secrets = secrets
    this.token = null
  }

  async call(method, path, body) {
    const headers = { accept: 'application/json' }
    if (this.token) headers.authorization = `Bearer ${this.token}`
    if (body !== null && body !== undefined) headers['content-type'] = 'application/json'
    const started = process.hrtime.bigint()
    let response
    let text = ''
    try {
      response = await fetch(`${this.appUrl}${path}`, {
        method,
        headers,
        body: body === null || body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      text = await response.text()
    } catch (error) {
      const latencyMs = Number(process.hrtime.bigint() - started) / 1e6
      return {
        status: 0,
        body: null,
        excerpt: sanitizeExcerpt(`transport failure: ${error?.name ?? 'Error'}`, this.secrets),
        latencyMs,
      }
    }
    const latencyMs = Number(process.hrtime.bigint() - started) / 1e6
    let parsed = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    return {
      status: response.status,
      body: parsed,
      excerpt: sanitizeExcerpt(text, this.secrets),
      latencyMs: Math.round(latencyMs * 100) / 100,
    }
  }
}

async function openClient(pg, databaseUrl, applicationName) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 10_000,
    application_name: applicationName,
  })
  const client = await pool.connect()
  return {
    client,
    close: async () => {
      client.release()
      await pool.end()
    },
  }
}

/** Acquire an EXCLUSIVE lease of `kind` on `key` inside a fresh transaction. */
async function holdLease(leaseClient, kind, key) {
  const fn = LEASE_FUNCTION_BY_KIND[kind]
  if (!fn) throw new Error(`unknown lease kind: ${kind}`)
  await leaseClient.query('BEGIN')
  const result = await leaseClient.query(`SELECT ${fn}($1, true) AS acquired`, [key])
  const acquired = result.rows[0]?.acquired === true
  if (!acquired) {
    await leaseClient.query('ROLLBACK')
  }
  return acquired
}

async function releaseLease(leaseClient) {
  await leaseClient.query('ROLLBACK')
}

function log(lines, line) {
  lines.push(line)
  process.stdout.write(`${line}\n`)
}

/**
 * The battery.
 * @returns {Promise<{ exitCode: number, evidence: object, lines: string[] }>}
 */
export async function runBattery({ env = process.env, options } = {}) {
  const lines = []
  const startedAt = new Date().toISOString()
  const databaseUrl = String(env.DATABASE_URL ?? '').trim()
  const appUrl = String(env.APP_URL ?? '').trim()
  const adminEmail = String(env.BATTERY_ADMIN_EMAIL ?? '').trim()
  const adminPassword = String(env.BATTERY_ADMIN_PASSWORD ?? '')
  const stamp = buildStamp(env.BATTERY_STAMP)
  const names = buildNames(stamp)
  // P3-2 (gate): the synthetic user's password must NOT be derivable from the published run
  // stamp. Random per run; never written to evidence (it is in the `secrets` redaction list).
  const batteryPassword = `Bat!${randomBytes(18).toString('base64url')}A9`
  const secrets = [databaseUrl, adminPassword, batteryPassword].filter((value) => typeof value === 'string' && value.length >= 4)

  // A1.3 (deep review B4): the amendment requires the exit evidence to carry the head/image SHA the
  // run was verified against. Nothing captured it, so every PASS was unbindable and the window would
  // self-void by A1.3's own terms. Capture it HERE, in the evidence the battery itself writes, so the
  // binding is produced by the tool rather than transcribed by hand:
  //   * script_sha256 — self-hash of THIS file, so the evidence names the exact battery that ran
  //     (the containment lane has an equivalent pin; this lane had none).
  //   * image_digest / build_commit — supplied by the caller (the workflow reads them from the
  //     running container); recorded as null when absent so a missing binding is VISIBLE in the
  //     evidence rather than silently absent.
  const provenance = (() => {
    let scriptSha = null
    try {
      scriptSha = createHash('sha256')
        .update(readFileSync(new URL(import.meta.url), 'utf8'))
        .digest('hex')
    } catch {
      scriptSha = null
    }
    return {
      script_sha256: scriptSha,
      image_digest: String(env.BATTERY_IMAGE_DIGEST ?? '').trim() || null,
      build_commit: String(env.BATTERY_BUILD_COMMIT ?? '').trim() || null,
    }
  })()

  const evidence = {
    tool: 'multitable-l1-battery',
    ladder_step: 'L1',
    run_stamp: stamp,
    provenance,
    started_at: startedAt,
    finished_at: null,
    verdict: 'NOT_ARMED',
    posture: null,
    surfaces: [],
    trigger_coverage: triggerCoverage(),
    wrong_kind_controls: [],
    not_driven: NOT_DRIVEN_SITES.map((entry) => ({ site: entry.site, reason: entry.reason, detail: entry.detail })),
    residue: null,
    failures: [],
    notes: [],
  }

  const missing = []
  if (!databaseUrl) missing.push('DATABASE_URL')
  if (!appUrl) missing.push('APP_URL')
  if (!adminEmail) missing.push('BATTERY_ADMIN_EMAIL')
  if (!adminPassword) missing.push('BATTERY_ADMIN_PASSWORD')
  if (missing.length > 0) {
    log(lines, `VERDICT: NOT_ARMED - required environment missing: ${missing.join(', ')}`)
    log(lines, USAGE)
    evidence.failures.push({ phase: 'preflight', failure: 'env_missing', reason: `missing: ${missing.join(', ')}` })
    evidence.finished_at = new Date().toISOString()
    return { exitCode: 2, evidence, lines }
  }

  const pg = requireFromBackend('pg')
  const http = new HttpClient({ appUrl, timeoutMs: options.timeoutMs, secrets })

  let admin
  let lease
  try {
    admin = await openClient(pg, databaseUrl, 'metasheet-l1-battery-verify')
    lease = await openClient(pg, databaseUrl, 'metasheet-l1-battery-lease')
  } catch {
    log(lines, 'VERDICT: NOT_ARMED - database unreachable (connection details withheld)')
    evidence.failures.push({ phase: 'preflight', failure: 'db_unreachable', reason: 'could not open a connection' })
    evidence.finished_at = new Date().toISOString()
    await admin?.close().catch(() => {})
    return { exitCode: 2, evidence, lines }
  }

  const sqlOne = async (text, params = []) => (await admin.client.query(text, params)).rows
  const failures = evidence.failures

  // P3-1 (gate): every post-seed exit path (a failed member-group/sheet seed, an expired
  // exemption after seeding, an unexpected throw) must still clean up — otherwise an aborted run
  // strands stamped synthetic subjects, exactly the residue the CLEAN verdict was blind to. These
  // are hoisted to function scope so the finally can run a best-effort cleanup for any early exit
  // that already created rows; the happy path sets cleanupDone so it is not run twice.
  let cleanupState = null
  let cleanupDone = false

  try {
    // ---------------- Phase 0 — posture preflight -------------------------
    log(lines, '── phase 0 · posture preflight ────────────────────────────────')
    const postureRows = (await admin.client.query(POSTURE_TRIGGER_QUERY, [
      EXPECTED_AUTHORITY_TRIGGERS.map((trigger) => trigger.triggerName),
      AUTHORITY_TRIGGER_FUNCTIONS,
    ])).rows
    const postureFunctionRows = (await admin.client.query(POSTURE_FUNCTION_QUERY, [
      AUTHORITY_FUNCTION_NAMES,
    ])).rows
    const postureShadowRows = (await admin.client.query(POSTURE_FUNCTION_SHADOW_QUERY, [
      AUTHORITY_FUNCTION_NAMES,
    ])).rows
    const posture = evaluatePosture(postureRows, EXPECTED_AUTHORITY_TRIGGERS, {
      functionRows: postureFunctionRows,
      shadowFunctionRows: postureShadowRows,
    })
    evidence.posture = {
      triggers_armed: posture.armedCount,
      triggers_expected: posture.expectedCount,
      // Keyed by trigger name, VALUED by the table the trigger was actually observed on plus its
      // tgenabled letter. A bare name→letter map made the escape invisible in the evidence file
      // itself: it read `trg_user_roles_...: "O"` while user_roles carried no trigger.
      trigger_fingerprint: posture.fingerprint,
      trigger_identity_offenders: posture.offenders,
      authority_function_offenders: posture.functionOffenders,
      shadowed_authority_functions: posture.shadowOffenders,
      unexpected_authority_triggers: posture.unexpectedTriggers,
      unexpected_authority_functions: posture.unexpectedFunctions,
      // The battery is deliberately FLAG-AGNOSTIC. L1 is "triggers ENABLED, all four recovery
      // flags OFF"; the battery requires no flag in any state and asserts nothing about them.
      // They are recorded only so the evidence names the posture the run observed.
      recovery_flags_observed: {
        MULTITABLE_HISTORY_CONTIGUITY_STRICT: env.MULTITABLE_HISTORY_CONTIGUITY_STRICT ?? null,
        MULTITABLE_ENABLE_WRITER_FENCE: env.MULTITABLE_ENABLE_WRITER_FENCE ?? null,
        MULTITABLE_ENABLE_SHEET_REVERT: env.MULTITABLE_ENABLE_SHEET_REVERT ?? null,
        MULTITABLE_ENABLE_PIT_RESET: env.MULTITABLE_ENABLE_PIT_RESET ?? null,
      },
      flag_requirement: 'none — the battery runs at L1 posture and is independent of all four recovery flags',
    }
    if (!posture.armed) {
      const report = notArmedReport(posture)
      for (const line of report.output.split('\n')) log(lines, line)
      failures.push({ phase: 'preflight', failure: 'not_armed', reason: `${posture.armedCount}/${posture.expectedCount} armed` })
      evidence.finished_at = new Date().toISOString()
      return { exitCode: report.exitCode, evidence, lines }
    }
    log(
      lines,
      `PHASE 0 VERDICT: ARMED - ${posture.armedCount}/${posture.expectedCount} recovery-authority triggers match the expected canonical identity (schema, table, name, function, event, args, WHEN clause, update columns) AND are ENABLED; ${EXPECTED_AUTHORITY_FUNCTIONS.length}/${EXPECTED_AUTHORITY_FUNCTIONS.length} authority function bodies match their expected fingerprint and none is shadowed from another schema`,
    )

    // Login through the REAL login endpoint. A token is never minted locally
    // (生产token走login不铸币): the battery only ever carries what the app issued it.
    const login = await http.call('POST', '/api/auth/login', { identifier: adminEmail, password: adminPassword })
    const token = login.body?.data?.token
    if (login.status !== 200 || typeof token !== 'string' || !token) {
      log(lines, `VERDICT: NOT_ARMED - login failed (${login.status}); the battery cannot drive any write surface`)
      failures.push({ phase: 'preflight', failure: 'login_failed', reason: `status ${login.status}`, excerpt: login.excerpt })
      evidence.finished_at = new Date().toISOString()
      return { exitCode: 2, evidence, lines }
    }
    http.token = token
    http.secrets = [...secrets, token]

    // SAME-DATABASE PROOF. `routes/roles.ts` and `routes/spreadsheet-permissions.ts` both branch
    // on `if (pool)` and fall back to in-memory Maps; an app booted against a different (or no)
    // database answers 2xx from those routes forever, which phase 3 would otherwise report as
    // "trigger did not fire". Close that ambiguity here, with its own distinct refusal.
    const adminId = String(login.body?.data?.user?.id ?? '')
    const adminRows = await sqlOne('SELECT 1 FROM users WHERE id = $1', [adminId])
    if (adminRows.length !== 1) {
      log(lines, "VERDICT: NOT_ARMED - the logged-in admin is not present in the battery's DATABASE_URL: the app and the battery are on DIFFERENT databases")
      failures.push({ phase: 'preflight', failure: 'app_db_mismatch', reason: 'admin id from login is absent in the battery database' })
      evidence.finished_at = new Date().toISOString()
      return { exitCode: 2, evidence, lines }
    }
    log(lines, 'PHASE 0 VERDICT: SAME-DB - the application writes the database this battery leases')

    // The NOT-DRIVEN excuses are not taken on trust. The one that is a SCHEMA claim rather than an
    // architectural one is re-verified here; if it has stopped being true on this database, the
    // battery fails and demands the surface be driven, instead of carrying a stale exemption.
    //
    // THIS PREMISE CHECK IS STRICTER THAN IT USED TO BE, deliberately. It now covers EVERY
    // recovery-authority-triggered child of `roles` (not only `role_permissions` — `user_roles`
    // carries `trg_user_roles_recovery_authority_lock` and 033_create_rbac_core.sql:36 gives it its
    // own independent cascading FK) and EVERY parent-delete action that writes the child row
    // (SET NULL and SET DEFAULT UPDATE the child and fire the same BEFORE INSERT OR UPDATE OR
    // DELETE trigger, not just CASCADE). So this battery will now expire the `roles:delete` excuse
    // — and exit 1 rather than produce evidence — in strictly MORE situations than before. That is
    // the point: every one of those situations is a database on which `roles:delete` really is
    // blockable and therefore really must be driven.
    // SCHEMA/OID BINDING — the presence control this query must be paired with. The witness
    // resolves `roles` through the SESSION's search_path, so zero rows from a session that cannot
    // see a `roles` table would read as "nothing writes a triggered child" and quietly keep the
    // exemption. `users` resolving in the same-DB proof above does NOT establish this: the two
    // tables could sit in different schemas. Same client, same session, same resolution as the
    // query it guards — that is the whole point.
    // SAME DOORS, SAME ORDER, SAME REASONS as the independent witness runner's
    // `classifyObservation` — the two must stay in lockstep or one can certify what the other
    // refuses. Every failure here is NOT_ARMED / exit 2, never a verdict.
    const binding = buildRoleCascadeBindingSql(CANONICAL_ROLES_SCHEMA)
    const bindingRow = (await sqlOne(`SELECT
      ${binding.canonicalRolesPresentSql} AS canonical_present,
      ${binding.sessionBindsCanonicalSql} AS session_binds_canonical,
      ${binding.sessionRolesSchemaSql} AS session_roles_schema,
      ${binding.visibleRolesRelationsSql} AS visible_roles_relations,
      ${binding.canonicalTriggerCarriersSql} AS canonical_trigger_carriers`))[0] ?? {}
    const bindingFailure = (() => {
      if (bindingRow.canonical_present !== true) {
        return {
          failure: 'role_cascade_canonical_relation_absent',
          reason: `no ordinary table \`${binding.schema}.roles\` on the observed database`,
        }
      }
      if (bindingRow.session_binds_canonical !== true) {
        return {
          failure: 'role_cascade_binding_mismatch',
          reason: `the session's own \`roles\` resolves to schema `
            + `${JSON.stringify(bindingRow.session_roles_schema ?? null)}, not the canonical `
            + `\`${binding.schema}\` — the observed environment is not the one being certified`,
        }
      }
      if (Number(bindingRow.visible_roles_relations) !== 1) {
        return {
          failure: 'role_cascade_relation_ambiguous',
          reason: `${Number(bindingRow.visible_roles_relations)} \`roles\` tables are visible on this `
            + "session's search_path; the binding cannot be uniquely confirmed",
        }
      }
      if (Number(bindingRow.canonical_trigger_carriers) < 1) {
        return {
          failure: 'role_cascade_premise_unobservable',
          reason: `no relation in \`${binding.schema}\` carries a canonical recovery-authority trigger, `
            + 'so the witness query is structurally incapable of returning a row',
        }
      }
      return null
    })()
    if (bindingFailure) {
      log(lines, `VERDICT: NOT_ARMED - the roles:delete premise cannot be re-checked here (${bindingFailure.failure}): ${bindingFailure.reason}; zero rows from the witness query would not be evidence of absence`)
      failures.push({ phase: 'preflight', ...bindingFailure })
      evidence.finished_at = new Date().toISOString()
      return { exitCode: 2, evidence, lines }
    }
    evidence.posture.role_delete_binding = {
      canonical_schema: binding.schema,
      session_roles_schema: bindingRow.session_roles_schema ?? null,
      visible_roles_relations: Number(bindingRow.visible_roles_relations),
      canonical_trigger_carriers: Number(bindingRow.canonical_trigger_carriers),
    }
    const cascadeRows = (await admin.client.query(buildRoleCascadeWitnessQuery(CANONICAL_ROLES_SCHEMA))).rows
    const cascadePresent = roleDeleteCascadeExists(cascadeRows)
    evidence.posture.role_delete_cascade_present = cascadePresent
    // Auditable, not a bare boolean: the exact rows the predicate decided on.
    evidence.posture.role_delete_triggered_children = cascadeRows.map((row) => ({
      child_schema: String(row?.child_schema ?? ''),
      child_table: String(row?.child_table ?? ''),
      conname: String(row?.conname ?? ''),
      confdeltype: String(row?.confdeltype ?? ''),
    }))
    if (cascadePresent) {
      const offenders = roleDeleteChildWrites(cascadeRows).map((row) => describeRoleCascadeRow(row)).join('; ')
      log(lines, `VERDICT: FAIL - deleting a role on this database writes into a recovery-authority-triggered table [${offenders}], so roles:delete IS blockable here; the ledger's NOT-DRIVEN exemption for it no longer holds and the surface must be driven`)
      failures.push({ phase: 'preflight', failure: 'not_driven_reason_expired', reason: `roles:delete is drivable on this schema (parent-delete writes a triggered child: ${offenders}) but is listed NOT-DRIVEN` })
      evidence.verdict = 'FAIL'
      evidence.finished_at = new Date().toISOString()
      return { exitCode: 1, evidence, lines }
    }
    log(lines, 'PHASE 0 VERDICT: EXEMPTION-VALID - no foreign key writes a recovery-authority-triggered child of roles on a role delete, so the roles:delete NOT-DRIVEN reason still holds on this database')

    // ---------------- Phase 1 — seed (no lease held) ----------------------
    log(lines, '── phase 1 · seed synthetic subjects (no lease held) ──────────')
    const ctx = {
      userId: null,
      sheetId: names.sheetId,
      groupId: null,
      templateId: null,
      templatePermissions: [],
      roles: { ...names.roles },
      codes: {},
      statusTarget: null,
    }
    // From here on, any exit must clean up what seeding has created so far (P3-1).
    cleanupState = { ctx, names }

    const permsResponse = await http.call('GET', '/api/permissions', null)
    const availableCodes = Array.isArray(permsResponse.body?.data)
      ? permsResponse.body.data.map((row) => String(row?.code ?? '')).filter(Boolean).sort()
      : []
    if (availableCodes.length < 4) {
      log(lines, `VERDICT: NOT_ARMED - seed precondition unmet: only ${availableCodes.length} permission codes exist; the battery needs 4 distinct codes`)
      failures.push({ phase: 'seed', failure: 'seed_precondition', reason: 'fewer than 4 permission codes available' })
      evidence.finished_at = new Date().toISOString()
      return { exitCode: 2, evidence, lines }
    }
    // Distinct code per surface so no surface's precondition depends on another's ordering.
    ctx.codes = {
      grant: availableCodes[0],
      revoke: availableCodes[1],
      rolePerm: availableCodes[2],
      wrongKindUser: availableCodes[3],
      wrongKindRole: availableCodes[availableCodes.length - 1],
    }

    const templatesResponse = await http.call('GET', '/api/admin/permission-templates', null)
    const templates = Array.isArray(templatesResponse.body?.data) ? templatesResponse.body.data : []
    const usableTemplate = templates.find((template) =>
      Array.isArray(template?.permissions)
      && template.permissions.length > 0
      && template.permissions.every((code) => availableCodes.includes(String(code))))
    if (!usableTemplate) {
      // Name the STATUS as well as the shortage: a 403 here means the supplied admin passes the
      // legacy token claim but is not an RBAC admin (no user_roles row for 'admin'), which is a
      // different remedy from "this deployment defines no templates".
      log(lines, `VERDICT: NOT_ARMED - seed precondition unmet: no permission template whose codes all exist (GET /api/admin/permission-templates → ${templatesResponse.status}, ${templates.length} template(s) returned)`)
      failures.push({ phase: 'seed', failure: 'seed_precondition', reason: `no usable permission template (templates endpoint returned ${templatesResponse.status})` })
      evidence.finished_at = new Date().toISOString()
      return { exitCode: 2, evidence, lines }
    }
    ctx.templateId = String(usableTemplate.id)
    ctx.templatePermissions = usableTemplate.permissions.map((code) => String(code))

    // Battery user — created over the real admin HTTP API.
    const createUser = await http.call('POST', '/api/admin/users', {
      name: names.userName,
      email: names.email,
      password: batteryPassword,
      isActive: true,
    })
    ctx.userId = String(createUser.body?.data?.userId ?? createUser.body?.data?.user?.id ?? '')
    if (createUser.status < 200 || createUser.status >= 300 || !ctx.userId) {
      log(lines, `VERDICT: NOT_ARMED - seed failed: could not create the battery user (${createUser.status})`)
      failures.push({ phase: 'seed', failure: 'seed_failed', reason: 'create battery user', excerpt: createUser.excerpt })
      evidence.finished_at = new Date().toISOString()
      return { exitCode: 2, evidence, lines }
    }
    const seededUser = await sqlOne('SELECT is_active FROM users WHERE id = $1', [ctx.userId])
    if (seededUser.length !== 1) {
      log(lines, "VERDICT: NOT_ARMED - the user the app just created is absent from the battery's database")
      failures.push({ phase: 'seed', failure: 'app_db_mismatch', reason: 'seeded user not observable over SQL' })
      evidence.finished_at = new Date().toISOString()
      return { exitCode: 2, evidence, lines }
    }
    ctx.statusTarget = seededUser[0].is_active !== true

    // Roles: one per surface, so phase-4 preconditions never depend on phase-4 ordering.
    for (const roleId of Object.values(ctx.roles)) {
      const created = await http.call('POST', '/api/roles', { id: roleId, name: roleId, permissions: [] })
      if (created.status < 200 || created.status >= 300) {
        log(lines, `VERDICT: NOT_ARMED - seed failed: could not create role ${roleId} (${created.status})`)
        failures.push({ phase: 'seed', failure: 'seed_failed', reason: `create role ${roleId}`, excerpt: created.excerpt })
        evidence.finished_at = new Date().toISOString()
        return { exitCode: 2, evidence, lines }
      }
    }
    // Member group.
    const group = await http.call('POST', '/api/admin/role-delegation/member-groups', { name: names.groupName })
    ctx.groupId = String(group.body?.data?.item?.id ?? '')
    if (group.status < 200 || group.status >= 300 || !ctx.groupId) {
      log(lines, `VERDICT: NOT_ARMED - seed failed: could not create the member group (${group.status})`)
      failures.push({ phase: 'seed', failure: 'seed_failed', reason: 'create member group', excerpt: group.excerpt })
      evidence.finished_at = new Date().toISOString()
      return { exitCode: 2, evidence, lines }
    }

    // Sheet parent for spreadsheet_permissions. The FK target differs by migration lineage
    // (`spreadsheets` in the SQL migration, `meta_sheets` in the TS one, whichever created the
    // table first), so seed BOTH parents with the same stamped id and let the real FK bind.
    // P3-5 (gate): status-check this seed. If the sheet parent fails to create, the later
    // spreadsheet_permissions write would fail for a FIXTURE reason and be misfiled as an
    // O2-S2 `unmapped_5xx` — the single misdiagnosis this tool most needs to avoid. A non-2xx
    // here is a seed failure (NOT_ARMED, exit 2), not evidence about the classifier. The
    // direct INSERT fallback below still binds whichever parent table the FK actually needs.
    const sheetSeed = await http.call('POST', '/api/spreadsheets', { id: ctx.sheetId, name: names.sheetId })
    if (sheetSeed.status >= 500) {
      log(lines, `VERDICT: NOT_ARMED - seed failed: sheet parent create returned ${sheetSeed.status} (fixture failure, not classifier evidence)`)
      failures.push({ phase: 'seed', failure: 'seed_failed', reason: 'create sheet parent', excerpt: sheetSeed.excerpt })
      evidence.finished_at = new Date().toISOString()
      return { exitCode: 2, evidence, lines }
    }
    for (const table of ['meta_sheets', 'spreadsheets']) {
      const exists = await sqlOne('SELECT to_regclass($1) AS oid', [`public.${table}`])
      if (!exists[0]?.oid) continue
      await admin.client.query(
        `INSERT INTO ${table} (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [ctx.sheetId, names.sheetId],
      ).catch(() => {})
    }

    // Seed the rows the DELETE-shaped surfaces need (a DELETE that matches nothing fires no
    // row-level trigger, which would look exactly like "the trigger did not fire").
    const seedGrants = [
      ['permissions-revoke seed', 'POST', '/api/permissions/grant', { userId: ctx.userId, permission: ctx.codes.revoke }],
      ['spreadsheet revoke seed', 'POST', `/api/spreadsheets/${encodeURIComponent(ctx.sheetId)}/permissions/grant`, { userId: ctx.userId, permission: 'comment' }],
      ['role unassign seed', 'POST', `/api/admin/users/${encodeURIComponent(ctx.userId)}/roles/assign`, { roleId: ctx.roles.unassign }],
    ]
    for (const [label, method, path, body] of seedGrants) {
      const seeded = await http.call(method, path, body)
      if (seeded.status < 200 || seeded.status >= 300) {
        log(lines, `VERDICT: NOT_ARMED - seed failed: ${label} (${seeded.status})`)
        failures.push({ phase: 'seed', failure: 'seed_failed', reason: label, excerpt: seeded.excerpt })
        evidence.finished_at = new Date().toISOString()
        return { exitCode: 2, evidence, lines }
      }
    }
    log(lines, `PHASE 1 VERDICT: SEEDED - user=${ctx.userId} roles=${Object.keys(ctx.roles).length} group=${ctx.groupId} sheet=${ctx.sheetId}`)

    // ---------------- Phases 2+3 — hold + drive-blocked -------------------
    log(lines, '── phases 2+3 · hold exclusive lease, drive each surface ──────')
    const surfaces = orderedSurfaces()
    const records = new Map()
    for (const surface of surfaces) {
      const key = resolveLeaseKey(surface, ctx)
      const record = {
        id: surface.id,
        census_sites: [...surface.censusSites],
        method: surface.method,
        path: resolvePath(surface, ctx),
        table: surface.table,
        trigger: surface.trigger,
        lease_kind: surface.lease,
        lease_function: LEASE_FUNCTION_BY_KIND[surface.lease],
        blocked_status: null,
        blocked_code: null,
        blocked_latency_ms: null,
        cleared_status: null,
        cleared_latency_ms: null,
        cleared_row_verified: null,
      }
      records.set(surface.id, record)
      evidence.surfaces.push(record)

      // Exactly ONE lease, of exactly the kind this surface's table maps to. Holding several at
      // once would let a 409 caused by a different lease masquerade as this surface's evidence.
      const acquired = await holdLease(lease.client, surface.lease, key)
      if (!acquired) {
        const reason = `${surface.id}: could not acquire the EXCLUSIVE ${surface.lease} lease on the synthetic subject — another holder exists; the battery refuses to report a result it did not construct`
        log(lines, `  FAIL ${reason}`)
        failures.push({ phase: 'hold', failure: 'lease_unavailable', reason })
        continue
      }
      const outcome = await http.call(surface.method, resolvePath(surface, ctx), surface.body ? surface.body(ctx) : null)
      await releaseLease(lease.client)

      record.blocked_status = outcome.status
      record.blocked_code = extractErrorCode(outcome.body)
      record.blocked_latency_ms = outcome.latencyMs
      const verdict = classifyBlockedOutcome(surface, outcome.status, outcome.body)
      if (verdict.ok) {
        log(lines, `  PASS ${surface.id.padEnd(36)} ${outcome.status} ${record.blocked_code} (${outcome.latencyMs}ms, ${surface.lease} lease on ${surface.table})`)
      } else {
        log(lines, `  FAIL ${verdict.reason}`)
        log(lines, `       body excerpt: ${outcome.excerpt}`)
        failures.push({ phase: 'drive-blocked', surface: surface.id, failure: verdict.failure, reason: verdict.reason, excerpt: outcome.excerpt })
      }
    }
    const blockedPassed = [...records.values()].filter(
      (record) => record.blocked_status === RECOVERY_CONFLICT_HTTP_STATUS && record.blocked_code === RECOVERY_CONFLICT_HTTP_CODE,
    ).length
    log(lines, `PHASE 3 VERDICT: ${blockedPassed === surfaces.length ? 'PASS' : 'FAIL'} - ${blockedPassed}/${surfaces.length} surfaces returned the named retryable 409 under a held lease`)

    // ---------------- Phase 3b — wrong-kind control -----------------------
    log(lines, '── phase 3b · wrong-kind lease control (mapping discrimination) ')
    const wrongKindControls = [
      {
        id: 'role-lease-does-not-block-user-keyed-write',
        heldLease: 'role',
        heldKey: ctx.roles.create,
        targetLease: 'user',
        method: 'POST',
        path: '/api/permissions/grant',
        body: { userId: ctx.userId, permission: ctx.codes.wrongKindUser },
        verify: {
          sql: 'SELECT 1 FROM user_permissions WHERE user_id = $1 AND permission_code = $2',
          params: [ctx.userId, ctx.codes.wrongKindUser],
        },
      },
      {
        id: 'user-lease-does-not-block-role-keyed-write',
        heldLease: 'user',
        heldKey: ctx.userId,
        targetLease: 'role',
        method: 'POST',
        path: '/api/roles',
        body: { id: ctx.roles.create, name: ctx.roles.create, permissions: [ctx.codes.wrongKindRole] },
        verify: {
          sql: 'SELECT 1 FROM role_permissions WHERE role_id = $1 AND permission_code = $2',
          params: [ctx.roles.create, ctx.codes.wrongKindRole],
        },
      },
    ]
    for (const control of wrongKindControls) {
      const record = { id: control.id, held_lease: control.heldLease, target_lease: control.targetLease, status: null, latency_ms: null, row_verified: null }
      evidence.wrong_kind_controls.push(record)
      const acquired = await holdLease(lease.client, control.heldLease, control.heldKey)
      if (!acquired) {
        const reason = `${control.id}: could not acquire the ${control.heldLease} lease for the control`
        log(lines, `  FAIL ${reason}`)
        failures.push({ phase: 'wrong-kind', failure: 'lease_unavailable', reason })
        continue
      }
      const outcome = await http.call(control.method, control.path, control.body)
      await releaseLease(lease.client)
      record.status = outcome.status
      record.latency_ms = outcome.latencyMs
      const verdict = classifyWrongKindOutcome(control, outcome.status)
      const rows = await sqlOne(control.verify.sql, control.verify.params)
      record.row_verified = rows.length > 0
      if (verdict.ok && record.row_verified) {
        log(lines, `  PASS ${control.id.padEnd(46)} ${outcome.status} (write landed under the wrong-kind lease, as the mapping requires)`)
      } else if (!verdict.ok) {
        log(lines, `  FAIL ${verdict.reason}`)
        failures.push({ phase: 'wrong-kind', failure: verdict.failure, reason: verdict.reason, excerpt: outcome.excerpt })
      } else {
        const reason = `${control.id}: the route answered ${outcome.status} but the row did not land — the control proves nothing`
        log(lines, `  FAIL ${reason}`)
        failures.push({ phase: 'wrong-kind', failure: 'wrong_kind_control_vacuous', reason })
      }
    }

    // ---------------- Phase 4 — release + drive-clear ---------------------
    log(lines, '── phase 4 · lease released · positive control ────────────────')
    for (const surface of surfaces) {
      const record = records.get(surface.id)
      const outcome = await http.call(surface.method, resolvePath(surface, ctx), surface.body ? surface.body(ctx) : null)
      record.cleared_status = outcome.status
      record.cleared_latency_ms = outcome.latencyMs
      const verdict = classifyClearedOutcome(surface, outcome.status)
      // A 2xx is not enough: assert the write actually LANDED in the database.
      const spec = surface.verify(ctx)
      const rows = await sqlOne(spec.sql, spec.params)
      const rowOk = spec.expectAtLeast !== undefined
        ? rows.length >= spec.expectAtLeast
        : rows.length === spec.expectRows
      record.cleared_row_verified = rowOk
      if (verdict.ok && rowOk) {
        log(lines, `  PASS ${surface.id.padEnd(36)} ${outcome.status} (${outcome.latencyMs}ms, row state verified)`)
      } else if (!verdict.ok) {
        log(lines, `  FAIL ${verdict.reason}`)
        log(lines, `       body excerpt: ${outcome.excerpt}`)
        failures.push({ phase: 'drive-clear', surface: surface.id, failure: verdict.failure, reason: verdict.reason, excerpt: outcome.excerpt })
      } else {
        const reason = `${surface.id}: answered ${outcome.status} after release but the expected row state is absent — the positive control is vacuous`
        log(lines, `  FAIL ${reason}`)
        failures.push({ phase: 'drive-clear', surface: surface.id, failure: 'positive_control_vacuous', reason })
      }
    }
    const clearedPassed = surfaces.filter((s) => records.get(s.id).cleared_status >= 200 && records.get(s.id).cleared_status < 300 && records.get(s.id).cleared_row_verified).length
    log(lines, `PHASE 4 VERDICT: ${clearedPassed === surfaces.length ? 'PASS' : 'FAIL'} - ${clearedPassed}/${surfaces.length} surfaces succeeded once the lease was released`)

    // ---------------- Phase 5 — cleanup + residue -------------------------
    log(lines, '── phase 5 · cleanup + residue scan ──────────────────────────')
    const residue = await cleanupAndScan(admin.client, ctx, names)
    cleanupDone = true
    evidence.residue = residue
    for (const failed of residue.delete_errors) {
      const reason = `cleanup DELETE on ${failed.relation} failed (SQLSTATE ${failed.sqlstate})`
      log(lines, `  FAIL ${reason}`)
      failures.push({ phase: 'cleanup', failure: 'cleanup_delete_failed', reason })
    }
    if (residue.total === 0 && residue.delete_errors.length === 0) {
      log(lines, `PHASE 5 VERDICT: CLEAN - zero residue across ${residue.scope.length} scanned relations, matched by stamp (${STAMP_PREFIX}%) AND by the battery user id`)
    } else {
      log(lines, `PHASE 5 VERDICT: FAIL - ${residue.total} residual row(s) remain`)
      for (const entry of residue.remaining) log(lines, `  residue: ${entry.relation} → ${entry.count}`)
      failures.push({ phase: 'cleanup', failure: 'residue', reason: `${residue.total} residual rows` })
    }

    // ---------------- Phase 6 — evidence + verdict ------------------------
    const passed = failures.length === 0
    evidence.verdict = passed ? 'PASS' : 'FAIL'
    evidence.finished_at = new Date().toISOString()
    evidence.notes.push(
      `${DRIVEN_SURFACES.length} surfaces driven; ${NOT_DRIVEN_SITES.length} census sites NOT driven (each with a named reason).`,
      'Code-level classification for the NOT-DRIVEN sites is already census-proven (recovery-conflict-census.test.ts + the runtime leg recorder); this battery adds only the end-to-end HTTP proof, which those sites cannot receive.',
    )
    return { exitCode: passed ? 0 : 1, evidence, lines }
  } catch (error) {
    // Never echo driver text: only the error NAME and, when present, the SQLSTATE.
    const code = typeof error?.code === 'string' ? ` (SQLSTATE ${error.code})` : ''
    const reason = `unexpected ${error?.name ?? 'Error'}${code} during the run`
    log(lines, `VERDICT: FAIL - ${reason}`)
    failures.push({ phase: 'run', failure: 'unexpected_error', reason })
    evidence.verdict = 'FAIL'
    evidence.finished_at = new Date().toISOString()
    return { exitCode: 1, evidence, lines }
  } finally {
    // P3-1: release the lease FIRST (so the cleanup deletes are not self-blocked by the very
    // triggers this battery armed), then best-effort clean any residue an early exit left behind.
    await lease.client.query('ROLLBACK').catch(() => {})
    if (cleanupState && !cleanupDone && admin?.client) {
      try {
        const residue = await cleanupAndScan(admin.client, cleanupState.ctx, cleanupState.names)
        evidence.residue = residue
        // P3-6 (regate): report on stdout via log(), not lines.push, and record the outcome in
        // evidence — an early-exit that leaves residue must be visible, not silent.
        log(lines, `  cleanup (early-exit best-effort): ${residue.total} residual row(s) after delete` +
          (residue.total ? ` — ${residue.remaining.map((r) => `${r.relation}:${r.count}`).join(', ')}` : ''))
        if (residue.total > 0 || residue.delete_errors.length > 0) {
          evidence.failures.push({ phase: 'cleanup', failure: 'early_exit_residue', reason: `${residue.total} residual rows after an early-exit cleanup` })
        }
      } catch (cleanupError) {
        log(lines, `  WARNING: early-exit cleanup failed (${cleanupError?.name ?? 'Error'}) — residue may remain`)
        evidence.failures.push({ phase: 'cleanup', failure: 'early_exit_cleanup_failed', reason: cleanupError?.name ?? 'Error' })
      }
    }
    await lease.close().catch(() => {})
    await admin.close().catch(() => {})
  }
}

/**
 * Delete every synthetic object, then scan for residue.
 *
 * Scope is EXPLICIT and reported: the identity / recovery-authority relations the battery writes.
 * The audit trail (`audit_logs`) is deliberately OUT of scope — it is append-only evidence of what
 * the battery did, not residue, and erasing it would destroy the run's own provenance. Saying so
 * here rather than silently narrowing the scan.
 */
async function cleanupAndScan(client, ctx, names) {
  const roleIds = Object.values(ctx.roles)
  const like = `${names.base}%`

  const deletes = [
    ['user_permissions', 'DELETE FROM user_permissions WHERE user_id = $1', [ctx.userId]],
    ['user_roles', 'DELETE FROM user_roles WHERE user_id = $1 OR role_id = ANY($2::text[])', [ctx.userId, roleIds]],
    ['platform_member_group_members', 'DELETE FROM platform_member_group_members WHERE user_id = $1 OR group_id::text = $2', [ctx.userId, String(ctx.groupId)]],
    ['spreadsheet_permissions', 'DELETE FROM spreadsheet_permissions WHERE sheet_id LIKE $1 OR subject_id = $2', [like, ctx.userId]],
    ['role_permissions', 'DELETE FROM role_permissions WHERE role_id = ANY($1::text[])', [roleIds]],
    ['roles', 'DELETE FROM roles WHERE id = ANY($1::text[])', [roleIds]],
    ['platform_member_groups', 'DELETE FROM platform_member_groups WHERE name LIKE $1', [like]],
    ['sheets', 'DELETE FROM sheets WHERE spreadsheet_id LIKE $1', [like]],
    ['spreadsheets', 'DELETE FROM spreadsheets WHERE id LIKE $1', [like]],
    ['meta_sheets', 'DELETE FROM meta_sheets WHERE id LIKE $1', [like]],
    ['user_orgs', 'DELETE FROM user_orgs WHERE user_id = $1', [ctx.userId]],
    // UUID-keyed dependents. The battery user's id is server-generated, so these rows carry NO
    // stamp and a `LIKE 'o2bat_%'` scan can never see them. phase 4's admin-users-status flip to
    // is_active=false calls revokeUserSessions, which writes user_session_revocations — a table
    // with no FK to users, so deleting the user does NOT cascade it away. Found by checking
    // rather than by assuming the stamp was sufficient.
    ['user_session_revocations', 'DELETE FROM user_session_revocations WHERE user_id = $1', [ctx.userId]],
    ['user_sessions', 'DELETE FROM user_sessions WHERE user_id = $1', [ctx.userId]],
    ['user_login_aliases', 'DELETE FROM user_login_aliases WHERE user_id = $1', [ctx.userId]],
    // P1-1 (gate): phase-1 `POST /api/admin/users` writes user_invites via invite-ledger.ts.
    // That table has NO FK cascade from users, and it accumulated one row per run while PHASE 5
    // printed CLEAN. Two genuinely independent keys reach it: the stamped invited email, and
    // user_invites.user_id = the created user's id (NOT invited_by, which holds the ADMIN caller —
    // P2-3 corrected that dead disjunct).
    ['user_invites', 'DELETE FROM user_invites WHERE email LIKE $1 OR user_id = $2', [like, ctx.userId]],
    ['users', 'DELETE FROM users WHERE id = $1', [ctx.userId]],
  ]
  // A swallowed delete error is indistinguishable from a successful delete, and would only be
  // caught if the scan below happened to cover that relation. Record the SQLSTATE instead.
  const deleteErrors = []
  for (const [relation, text, params] of deletes) {
    const exists = await client.query('SELECT to_regclass($1) AS oid', [`public.${relation}`])
    if (!exists.rows[0]?.oid) continue
    try {
      await client.query(text, params)
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'unknown'
      deleteErrors.push({ relation, sqlstate: code })
    }
  }

  const scans = [
    ['users', 'SELECT COUNT(*)::int AS c FROM users WHERE email LIKE $1 OR name LIKE $1', [like]],
    ['user_login_aliases', 'SELECT COUNT(*)::int AS c FROM user_login_aliases WHERE normalized_value LIKE $1', [like]],
    ['roles', 'SELECT COUNT(*)::int AS c FROM roles WHERE id LIKE $1 OR name LIKE $1', [like]],
    ['role_permissions', 'SELECT COUNT(*)::int AS c FROM role_permissions WHERE role_id LIKE $1', [like]],
    ['user_roles', 'SELECT COUNT(*)::int AS c FROM user_roles WHERE role_id LIKE $1 OR user_id = $2', [like, ctx.userId]],
    ['user_permissions', 'SELECT COUNT(*)::int AS c FROM user_permissions WHERE user_id = $1', [ctx.userId]],
    ['platform_member_groups', 'SELECT COUNT(*)::int AS c FROM platform_member_groups WHERE name LIKE $1', [like]],
    ['platform_member_group_members', 'SELECT COUNT(*)::int AS c FROM platform_member_group_members WHERE user_id = $1', [ctx.userId]],
    ['spreadsheet_permissions', 'SELECT COUNT(*)::int AS c FROM spreadsheet_permissions WHERE sheet_id LIKE $1 OR subject_id = $2', [like, ctx.userId]],
    ['meta_sheets', 'SELECT COUNT(*)::int AS c FROM meta_sheets WHERE id LIKE $1', [like]],
    ['spreadsheets', 'SELECT COUNT(*)::int AS c FROM spreadsheets WHERE id LIKE $1', [like]],
    ['user_session_revocations', 'SELECT COUNT(*)::int AS c FROM user_session_revocations WHERE user_id = $1', [ctx.userId]],
    ['user_sessions', 'SELECT COUNT(*)::int AS c FROM user_sessions WHERE user_id = $1', [ctx.userId]],
    ['user_orgs', 'SELECT COUNT(*)::int AS c FROM user_orgs WHERE user_id = $1', [ctx.userId]],
    // P1-1 (gate): the relation the CLEAN verdict was blind to. Scanned by the same two axes it is
    // deleted by, so a surviving invite row now reds PHASE 5 instead of being invisible.
    ['user_invites', 'SELECT COUNT(*)::int AS c FROM user_invites WHERE email LIKE $1 OR user_id = $2', [like, ctx.userId]],
  ]
  const remaining = []
  const scope = []
  let total = 0
  for (const [relation, text, params] of scans) {
    const exists = await client.query('SELECT to_regclass($1) AS oid', [`public.${relation}`])
    if (!exists.rows[0]?.oid) continue
    scope.push(relation)
    const result = await client.query(text, params)
    const count = Number(result.rows[0]?.c ?? 0)
    total += count
    if (count > 0) remaining.push({ relation, count })
  }
  return {
    // Scope is BY STAMP *and* BY BATTERY USER ID: the synthetic user's id is a server-generated
    // UUID, so stamped-name matching alone cannot reach its dependent rows.
    stamp_pattern: like,
    battery_user_id_scoped: true,
    scope,
    out_of_scope: [
      'audit_logs — append-only provenance of this run, deliberately preserved',
      'rows keyed by neither the stamp nor the battery user id (none known; this line exists so the boundary is stated, not implied)',
    ],
    delete_errors: deleteErrors,
    remaining,
    total,
  }
}

export async function runCli({ argv = process.argv.slice(2), env = process.env } = {}) {
  const parsed = parseCliArgs(argv)
  if (!parsed.ok) return { exitCode: 2, output: parsed.output, evidence: null }

  const { exitCode, evidence, lines } = await runBattery({ env, options: parsed.options })
  try {
    writeFileSync(parsed.options.out, `${JSON.stringify(evidence, null, 2)}\n`)
  } catch (error) {
    lines.push(`WARNING: evidence file could not be written (${error?.name ?? 'Error'})`)
  }

  const driven = evidence.surfaces.length
  const blocked = evidence.surfaces.filter((s) => s.blocked_status === RECOVERY_CONFLICT_HTTP_STATUS && s.blocked_code === RECOVERY_CONFLICT_HTTP_CODE).length
  const cleared = evidence.surfaces.filter((s) => s.cleared_status >= 200 && s.cleared_status < 300 && s.cleared_row_verified).length
  // P3-4 (gate): the trigger-coverage number in the summary must reflect what ACTUALLY fired this
  // run, not the declarative capability. A disarmed/aborted run drives 0 surfaces, so it must not
  // print "6/9 exercised". Count the distinct triggers whose surfaces genuinely blocked with the
  // named 409; keep the declarative capability (trigger_coverage.exercised_count = the ceiling)
  // in the evidence JSON, but label the summary as the measured value.
  const firedTriggers = new Set(
    evidence.surfaces
      .filter((s) => s.blocked_status === RECOVERY_CONFLICT_HTTP_STATUS && s.blocked_code === RECOVERY_CONFLICT_HTTP_CODE)
      .map((s) => s.trigger)
      .filter(Boolean),
  )
  evidence.trigger_coverage.measured_count = firedTriggers.size
  const summary = `VERDICT: ${evidence.verdict} - ${blocked}/${driven} surfaces blocked with ${RECOVERY_CONFLICT_HTTP_CODE}, ${cleared}/${driven} cleared after release, ${evidence.wrong_kind_controls.filter((c) => c.status >= 200 && c.status < 300 && c.row_verified).length}/${evidence.wrong_kind_controls.length} wrong-kind controls green, ${firedTriggers.size}/${evidence.trigger_coverage.total_count} recovery-authority TRIGGERS exercised this run (declarative ceiling ${evidence.trigger_coverage.exercised_count}/${evidence.trigger_coverage.total_count}), ${NOT_DRIVEN_SITES.length} census sites NOT driven, ${evidence.failures.length} failure(s); evidence → ${parsed.options.out}`
  return { exitCode, output: [...lines, summary].join('\n'), evidence }
}

async function main() {
  const result = await runCli()
  const stream = result.exitCode === 0 ? process.stdout : process.stderr
  // `lines` were already streamed as they happened; print only the final verdict line here.
  stream.write(`${result.output.split('\n').at(-1)}\n`)
  process.exitCode = result.exitCode
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
