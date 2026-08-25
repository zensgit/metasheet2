/**
 * W0-1 L5-wire — trust-checkpoint ACTIVATION route (real DB): the production caller for activateCheckpoint.
 *
 * Owner review 2026-07-17: `activateCheckpoint` had NO production caller — without an activated checkpoint,
 * exact-anchor recovery (L6-b) can only refuse `no-covering-checkpoint`. This route is that caller:
 * `POST /sheets/:sheetId/trust-checkpoint-activate`, default-OFF `MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION`,
 * sheet-admin (D2) floor, ONE fenced transaction (canonical fence first → design-lock §3 cutover).
 *
 * Goldens (each mutation-proven in the PR matrix):
 *   FLAG-OFF          route refuses 403 TRUST_CHECKPOINT_ACTIVATION_DISABLED, zero checkpoint rows.
 *   NON-ADMIN         a plain writer (no canManageSheetAccess) ⇒ 403, zero rows (D2 floor).
 *   HAPPY             admin + flag ON ⇒ 200 {checkpointId, trustedSinceSeq, baselineCount}; row is `active`;
 *                     baselines snapshot live rows; a SECOND activation supersedes the first (exactly one
 *                     active per sheet).
 *   UNATTRIBUTABLE    a trashed-only record with a NULL delete_revision_id ⇒ 409 HISTORY_INCOMPLETE
 *                     (values-free) and the WHOLE activation rolls back (no checkpoint, no baselines).
 *   FENCE-PARK        a raw client holding the canonical fence parks the activation until release
 *                     (constructed race — proves the fence call is real, not decorative).
 *   NOT-FOUND         unknown sheet ⇒ 404.
 *
 * ── P2 authorization fix (2026-08-25) — added goldens ─────────────────────────────────────────────────
 * The route authorized ONLY before the fenced transaction, via `resolveSheetCapabilities`, which
 * `multitable/access.ts#resolveRequestAccess` can satisfy from JWT CLAIMS ALONE (early return on an admin
 * role, and again on a non-empty `perms` array — neither touches the database). Nothing re-checked inside
 * the transaction, so a REVOKED user with an unexpired token could still mint the durable trust anchor that
 * destructive recovery later resolves against. And any sheet id was accepted — the ladder's "named canary
 * sheet" scoping was convention only.
 *
 *   STALE-TOKEN       same token, same actor: activates while the DB grant exists, then is REFUSED 403 once
 *                     the grant is revoked in the database (the in-transaction DB-fresh re-check catches it).
 *                     The pre-fix implementation returns 200 here and writes a checkpoint row.
 *   REVOKE-DURING-QUEUE  constructed race (two connections): the revoke COMMITS after the route's outer
 *                     capability check, while the activation parks on the canonical fence ⇒ 403, zero rows.
 *   NOT-ALLOWLISTED   a fully-authorized admin on a sheet outside MULTITABLE_TRUST_CHECKPOINT_SHEET_ALLOWLIST
 *                     ⇒ 409 TRUST_CHECKPOINT_SHEET_NOT_ALLOWLISTED; the SAME actor on the allowlisted sheet
 *                     proceeds (the discriminating pair).
 *   ALLOWLIST-UNSET   allowlist unset / whitespace-only ⇒ refuse for EVERY sheet (fail-closed default).
 *   GATE-ORDER        an unauthorized caller on a NON-allowlisted sheet gets the uniform 403, never the
 *                     allowlist code — allowlist membership is not disclosed to an unauthorized caller.
 *
 * Because the fix makes DB-backed authority load-bearing, ADMIN now carries REAL `user_permissions` rows
 * (previously its authority existed only in the injected token) and the standard posture also designates
 * SHEET in the allowlist. That is the precondition becoming real, not a relaxation: every pre-existing
 * golden above is unchanged in status/code/row assertions.
 *
 * ── Actor authority LEASE (2026-08-25) — added goldens ───────────────────────────────────────────────
 * The in-transaction DB-fresh re-check above still ran at READ COMMITTED, so a revoke committing in the
 * sliver between its reads and the cutover was not observed. The activation transaction now takes the
 * EXISTING recovery-authority lease (`acquireRecoveryAuthorityLease`, same keys, no new protocol) in a
 * fixed order:
 *
 *   BEGIN → canonical sheet fence → actor authority lease → DB-fresh FINAL authorization
 *         → durable-block / allowlist / existence adjudication → activateCheckpoint → COMMIT
 *
 *   SUBSTRATE-DISABLED   freshly migrated posture (all nine authority triggers DISABLED) ⇒ the lease is
 *                        `unavailable` ⇒ 409 TRUST_CHECKPOINT_AUTHORITY_UNAVAILABLE and ZERO checkpoint
 *                        AND baseline rows. This is INTENDED rung precedence, not a defect: on a
 *                        disabled rung the lease would exclude nothing (the triggers are the only shared
 *                        acquirers), so "degrade to ready" would ship a lease that protects nothing.
 *   SUBSTRATE-PARTIAL    8/9 armed ⇒ the same refusal. The bar is exactly 9/9.
 *   LEASE-BUSY           a concurrent OPEN permission-writer transaction holds the actor's shared
 *                        authority key ⇒ 409 TRUST_CHECKPOINT_AUTHORITY_BUSY (retryable, values-free),
 *                        zero rows; the SAME request succeeds once that writer rolls back (the
 *                        discriminating half).
 *   ACTIVATION-WINS      while the activation holds the lease, a concurrent revoke on EVERY covered
 *                        authority surface (user_permissions / user_roles / role_permissions /
 *                        platform_member_group_members / spreadsheet_permissions(member-group) /
 *                        users.is_active) is refused 40001 METASHEET_RECOVERY_AUTHORITY_BUSY — each leg
 *                        paired with an UNCOVERED-subject control that must SUCCEED, so the 40001 is
 *                        attributable to the leased key and not to any table-level lock.
 *   REVOKE-WINS          a revoke that COMMITS while the activation parks on the fence ⇒ 403, zero rows —
 *                        for direct-user, ROLE-derived and member-GROUP-derived authority (all three
 *                        participate in `canManageSheetAccess`; see loadSheetPermissionScopeMap).
 *   ORACLE-AFTER-LEASE   allowlist (409) and existence (404) are no longer reachable before the lease: a
 *                        fully-authorized admin gets the SAME unavailable refusal for a non-designated
 *                        sheet and for a missing sheet when the lease cannot be taken.
 *   NO-40P01             the fence-first ordering never constructs a deadlock in the interleaving that
 *                        would otherwise close a cycle (holder takes the fence, then meta_sheets FOR
 *                        UPDATE, while the activation wants the fence and then the FK KEY SHARE), proven
 *                        against an explicit bound with pg_stat_activity/pg_blocking_pids evidence —
 *                        and HARNESS-40P01 deliberately constructs a real 40P01 the same harness DOES
 *                        observe, so the negative is discriminating rather than blind.
 *
 * Because the lease is load-bearing, the standard posture for this suite ARMS all nine authority
 * triggers in `beforeAll` and restores the captured (migration-default DISABLED) posture in `afterAll`;
 * SUBSTRATE-DISABLED / SUBSTRATE-PARTIAL disarm deliberately and re-arm in `finally`.
 *
 * P2-C hygiene: unique fixture ids; no `setval`; cleanup deletes only this suite's rows. Two-point wiring:
 * plugin-tests.yml real-DB run list + vitest glob; fail-not-skip sentinel scoped to the allowlist step.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { pool } from '../../src/db/pg'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { __resetRecoveryWriterStateColumnProbe } from '../../src/multitable/canonical-sheet-fence'
import { RECOVERY_AUTHORITY_TRIGGERS } from '../../src/db/migrations/zzzz20260721121000_add_recovery_authority_locks'
import { RECOVERY_AUTHORITY_BUSY_MARKER } from '../../src/multitable/recovery-authorization-stability'
import {
  TRUST_CHECKPOINT_AUTHORITY_BUSY_CODE,
  TRUST_CHECKPOINT_AUTHORITY_BUSY_MESSAGE,
  TRUST_CHECKPOINT_AUTHORITY_UNAVAILABLE_CODE,
  TRUST_CHECKPOINT_AUTHORITY_UNAVAILABLE_MESSAGE,
} from '../../src/multitable/trust-checkpoint-activation-authz'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const FLAG = 'MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION'
const FENCE_FLAG = 'MULTITABLE_ENABLE_WRITER_FENCE'
const ALLOWLIST = 'MULTITABLE_TRUST_CHECKPOINT_SHEET_ALLOWLIST'
// Gate M1: activation requires the canonical fence — the standard posture for these goldens is BOTH ON.
// P2 fix: the canary allowlist is fail-closed (unset ⇒ refuse EVERY sheet), so the standard posture also
// designates THIS suite's sheet. `enableBoth` is the "everything the operator must have set" helper; the
// ALLOWLIST-UNSET / NOT-ALLOWLISTED goldens below deliberately unset or narrow it again.
const enableBoth = () => { process.env[FLAG] = 'true'; process.env[FENCE_FLAG] = 'true'; process.env[ALLOWLIST] = SHEET }
const TS = Date.now()
const BASE = `base_l5w_${TS}`
const SHEET = `sheet_l5w_${TS}`
const OTHER_SHEET = `sheet_l5w_other_${TS}` // real sheet, deliberately NOT in the allowlist
const F_STR = `fld_l5w_note_${TS}`
const ADMIN = `u_l5w_admin_${TS}` // sheet-admin via REAL user_permissions rows (multitable:share)
const WRITER = `u_l5w_writer_${TS}` // plain writer ⇒ NO canManageSheetAccess
const STALE = `u_l5w_stale_${TS}` // token keeps multitable:share after the DB grant is revoked
// Lease-coverage fixtures. ADMIN additionally holds a role assignment and a member-group membership so
// the lease genuinely discovers a ROLE key and a GROUP key for it (the lease's role/group discovery
// reads user_roles / platform_member_group_members for the leased user ids). UNLEASED mirrors every one
// of those rows on subjects the lease does NOT cover — it is the control half of each 40001 leg.
const ROLEY = `u_l5w_role_${TS}` // canManageSheetAccess derived ONLY from a role grant
const GROUPY = `u_l5w_group_${TS}` // canManageSheetAccess derived ONLY from a member-group sheet grant
const UNLEASED = `u_l5w_unleased_${TS}` // never leased; its writes must stay UNAFFECTED
const ROLE_LEASED = `role_l5w_leased_${TS}` // assigned to ADMIN ⇒ its key IS leased
const ROLE_SHARE = `role_l5w_share_${TS}` // assigned to ROLEY, carries multitable:share
const ROLE_UNLEASED = `role_l5w_unleased_${TS}` // assigned to nobody leased ⇒ its key is NOT leased
const SHARE_PERMS = ['multitable:read', 'multitable:write', 'multitable:share']
// uuid group ids are allocated in beforeAll (platform_member_groups.id is a uuid).
let GRP_LEASED = ''
let GRP_UNLEASED = ''
const grantDb = async (userId: string) => {
  for (const code of SHARE_PERMS) {
    await q('INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, code])
  }
}
const revokeDb = async (userId: string) => { await q('DELETE FROM user_permissions WHERE user_id = $1', [userId]) }

const q = (sql: string, params: unknown[] = []) => poolManager.get().query(sql, params)

let app: Express
let actor: { id: string; perms: string[] } = { id: ADMIN, perms: ['multitable:read', 'multitable:write', 'multitable:share'] }

const activateReq = (sheetId: string = SHEET) => request(app).post(`/api/multitable/sheets/${sheetId}/trust-checkpoint-activate`).send({})
/** The awaited supertest response of one activation request (used by the in-flight race goldens). */
type ActivationResponse = Awaited<ReturnType<typeof activateReq>>
const checkpointRows = async () =>
  (await q(`SELECT id, state FROM meta_history_trust_checkpoints WHERE sheet_id = $1 ORDER BY created_at`, [SHEET])).rows as Array<{ id: string; state: string }>
const baselineCountFor = async (checkpointId: string) =>
  Number(((await q('SELECT count(*)::int c FROM meta_history_baselines WHERE checkpoint_id = $1', [checkpointId])).rows[0] as { c: number }).c)

// ── actor-authority-lease harness ───────────────────────────────────────────────────────────────────
// "zero writes" means zero CHECKPOINT rows AND zero BASELINE rows, for every sheet this suite touches:
// a checkpoint-only assertion would miss a partial cutover that inserted baselines and then aborted.
const SUITE_SHEETS = [SHEET, OTHER_SHEET]
const activationWriteCounts = async () => {
  const checkpoints = Number(((await q(
    'SELECT count(*)::int c FROM meta_history_trust_checkpoints WHERE sheet_id = ANY($1::text[])', [SUITE_SHEETS],
  )).rows[0] as { c: number }).c)
  const baselines = Number(((await q(
    'SELECT count(*)::int c FROM meta_history_baselines WHERE sheet_id = ANY($1::text[])', [SUITE_SHEETS],
  )).rows[0] as { c: number }).c)
  return { checkpoints, baselines }
}

const AUTHORITY_TRIGGERS = [...RECOVERY_AUTHORITY_TRIGGERS] as ReadonlyArray<readonly [string, string]>
const AUTHORITY_TRIGGER_NAMES = AUTHORITY_TRIGGERS.map(([, trigger]) => trigger)
const armSubstrate = async () => {
  for (const [table, trigger] of AUTHORITY_TRIGGERS) await q(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)
}
const disarmSubstrate = async () => {
  for (const [table, trigger] of AUTHORITY_TRIGGERS) await q(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`)
}
/** tgenabled per authority trigger NAME (names are unique across the nine, including the two on users). */
const substratePosture = async (): Promise<Array<{ name: string; enabled: string }>> =>
  (await q(
    `SELECT tgname, tgenabled FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY($1::text[]) ORDER BY tgname`,
    [AUTHORITY_TRIGGER_NAMES],
  )).rows.map((row) => ({
    name: String((row as { tgname: unknown }).tgname),
    enabled: String((row as { tgenabled: unknown }).tgenabled),
  }))

/**
 * Every "is / is not waiting" claim in this file is proven by polling real catalog evidence to an
 * EXPLICIT bound — never by a fixed sleep. Exceeding the bound throws with the label, so a mutation
 * that stops the awaited condition from ever happening reds the golden instead of silently passing.
 */
const POLL_BOUND_MS = 15_000
const POLL_STEP_MS = 25
async function pollUntil<T>(label: string, probe: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + POLL_BOUND_MS
  for (;;) {
    const value = await probe()
    if (value !== null) return value
    if (Date.now() >= deadline) throw new Error(`poll bound ${POLL_BOUND_MS}ms exceeded waiting for: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, POLL_STEP_MS))
  }
}

type RawClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>
  release: () => void
}
const connect = async (): Promise<RawClient> => {
  expect(pool).toBeTruthy()
  return (await pool!.connect()) as unknown as RawClient
}

/**
 * Granted advisory locks held by backends on THIS database. Deliberately a COUNT and not a
 * reconstruction of the lease's `hashtextextended('metasheet:recovery-authority:user:'||id, 0)` key:
 * recomputing that expression (and its int8 → classid/objid decomposition) is easy to get wrong, and a
 * wrong key never matches — which is byte-identical to "the lease was never taken", so the mutation
 * transcript would be unreadable. The activation holds exactly ONE advisory lock (the canonical fence)
 * before the lease and at least TWO after it, which rises exactly when the lease is acquired.
 */
const grantedAdvisoryLocks = async (client: RawClient): Promise<number> =>
  Number(((await client.query(
    `SELECT count(*)::int AS c
       FROM pg_locks l
       JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.granted AND a.datname = current_database()`,
  )).rows[0] as { c: number }).c)

/** Wait evidence for every blocked backend on this database (owner criterion: no fixed sleeps). */
const waitEvidence = async (client: RawClient) =>
  (await client.query(
    `SELECT a.pid, a.wait_event_type, a.wait_event, pg_blocking_pids(a.pid)::text AS blockers
       FROM pg_stat_activity a
      WHERE a.datname = current_database()
        AND a.pid <> pg_backend_pid()
        AND cardinality(pg_blocking_pids(a.pid)) > 0`,
  )).rows as Array<{ pid: number; wait_event_type: string; wait_event: string; blockers: string }>

type WriteAttempt = { ok: true } | { ok: false; code?: string; message: string }
/**
 * Attempt one authority write on its OWN connection and ALWAYS roll it back — the test only needs the
 * trigger's verdict, so no fixture is mutated and no afterEach churn is introduced.
 */
const attemptAuthorityWrite = async (sql: string, params: unknown[]): Promise<WriteAttempt> => {
  const client = await connect()
  try {
    await client.query('BEGIN')
    const res = await client.query(sql, params)
    // A no-op write proves nothing: a row-level BEFORE trigger only fires when a row is affected.
    expect(res.rowCount ?? 1).toBeGreaterThan(0)
    await client.query('ROLLBACK')
    return { ok: true }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    return {
      ok: false,
      code: (error as { code?: string }).code,
      message: String((error as { message?: unknown }).message ?? ''),
    }
  } finally {
    client.release()
  }
}

/** Run one statement on a raw client, capturing a SQLSTATE instead of throwing (40P01 detection). */
const runCapturing = async (client: RawClient, sql: string, params: unknown[] = []): Promise<WriteAttempt> => {
  try {
    await client.query(sql, params)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      code: (error as { code?: string }).code,
      message: String((error as { message?: unknown }).message ?? ''),
    }
  }
}

test('sentinel: the real-DB allowlist step must have DATABASE_URL (fail-not-skip, scoped to that step)', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('real-DB allowlist step is missing DATABASE_URL — the harness is broken, not legitimately skippable')
  }
  expect(true).toBe(true)
})

describeIfDatabase('W0-1 L5-wire — trust-checkpoint activation route (real DB)', () => {
  /** tgenabled captured BEFORE this suite arms anything, restored verbatim in afterAll. */
  let capturedSubstratePosture: Array<{ name: string; enabled: string }> = []

  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: actor.id, roles: ['member'], perms: actor.perms }; next() })
    app.use('/api/multitable', univerMetaRouter())
    for (const u of [ADMIN, WRITER, STALE, ROLEY, GROUPY, UNLEASED]) await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [u])
    // P2 fix: the in-transaction re-check derives authority from CURRENT DB rows, so the admin fixture must
    // hold REAL grants — a token-only "admin" is exactly the thing the fix now refuses. WRITER stays
    // grant-less on purpose (its token carries no share perm either, so it is refused at the outer floor).
    await grantDb(ADMIN)
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [BASE, 'L5W Base', ADMIN])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'L5W'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [OTHER_SHEET, BASE, 'L5W Other'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_STR, SHEET, 'Note', 'string', '{}', 1])

    // ── lease-coverage fixtures ──────────────────────────────────────────────────────────────────
    for (const roleId of [ROLE_LEASED, ROLE_SHARE, ROLE_UNLEASED]) {
      await q('INSERT INTO roles (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [roleId, roleId])
    }
    // ADMIN carries a role assignment and a group membership so the lease genuinely DISCOVERS a role key
    // and a group key for it. ROLE_LEASED grants only multitable:read, so ADMIN's sheet-admin authority
    // still comes from its own user_permissions — the fixture adds lease COVERAGE, not authority.
    await q('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ROLE_LEASED, 'multitable:read'])
    await q('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ADMIN, ROLE_LEASED])
    // ROLEY: canManageSheetAccess comes ONLY from a role grant. It needs the full share triple, not
    // multitable:share alone: with no sheet-scoped assignment, applySheetPermissionScope resolves
    // canManageSheetAccess as `canManageSheetAccess && canRead`, so a share-without-read role would be
    // denied for a reason that has nothing to do with the revocation under test.
    for (const code of SHARE_PERMS) {
      await q('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ROLE_SHARE, code])
    }
    await q('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ROLEY, ROLE_SHARE])
    // UNLEASED mirrors every covered surface on subjects the lease never holds — the control half.
    await q('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ROLE_UNLEASED, 'multitable:read'])
    await q('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [UNLEASED, ROLE_UNLEASED])
    await q('INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [UNLEASED, 'multitable:read'])

    GRP_LEASED = String(((await q('INSERT INTO platform_member_groups (name) VALUES ($1) RETURNING id::text AS id', [`grp_l5w_leased_${TS}`])).rows[0] as { id: string }).id)
    GRP_UNLEASED = String(((await q('INSERT INTO platform_member_groups (name) VALUES ($1) RETURNING id::text AS id', [`grp_l5w_unleased_${TS}`])).rows[0] as { id: string }).id)
    await q('INSERT INTO platform_member_group_members (group_id, user_id) VALUES ($1::uuid,$2) ON CONFLICT DO NOTHING', [GRP_LEASED, ADMIN])
    // GROUPY: canManageSheetAccess comes ONLY from a member-group sheet grant. Groups DO participate in
    // canManageSheetAccess (permission-service.ts loadSheetPermissionScopeMap resolves 'member-group'
    // subjects through platform_member_group_members, and applyContextSheetSchemaWriteGrant turns a
    // read+write+admin sheet scope into canManageSheetAccess) — verified in source, not assumed.
    await q('INSERT INTO platform_member_group_members (group_id, user_id) VALUES ($1::uuid,$2) ON CONFLICT DO NOTHING', [GRP_LEASED, GROUPY])
    await q('INSERT INTO platform_member_group_members (group_id, user_id) VALUES ($1::uuid,$2) ON CONFLICT DO NOTHING', [GRP_UNLEASED, UNLEASED])
    // SHEET carries a member-group ADMIN grant for GRP_LEASED. Deliberately NOT a weaker grant and
    // deliberately NOT on OTHER_SHEET: applySheetPermissionScope makes a sheet-scoped assignment
    // AUTHORITATIVE (canManageSheetAccess becomes scope.canAdmin), so a read-only member-group grant on
    // OTHER_SHEET would silently STRIP ADMIN's global share there and turn the allowlist goldens into
    // 403s for a reason unrelated to the allowlist.
    await q('INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [SHEET, 'member-group', GRP_LEASED, 'multitable:admin'])
    // The UNCOVERED control row: GRP_UNLEASED contains only UNLEASED, which never issues a request.
    await q('INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [OTHER_SHEET, 'member-group', GRP_UNLEASED, 'multitable:read'])

    // The lease is load-bearing for every golden that reaches the transaction, and the migration ships
    // the canonical substrate 9/9 DISABLED (fail-closed by design). Arm it for the suite; restore the
    // captured posture in afterAll so no other suite inherits an armed database.
    capturedSubstratePosture = await substratePosture()
    await armSubstrate()
  })
  afterEach(async () => {
    delete process.env[FLAG]
    delete process.env[FENCE_FLAG]
    delete process.env[ALLOWLIST]
    __resetRecoveryWriterStateColumnProbe()
    actor = { id: ADMIN, perms: ['multitable:read', 'multitable:write', 'multitable:share'] }
    await revokeDb(STALE).catch(() => {})
    await grantDb(ADMIN).catch(() => {}) // a revoke-race case may have stripped it mid-test
    for (const sheet of [SHEET, OTHER_SHEET])
      for (const t of ['meta_history_baselines', 'meta_history_trust_checkpoints', 'meta_records_trash', 'meta_record_revisions', 'meta_records'])
        await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [sheet]).catch(() => {})
  })
  afterAll(async () => {
    delete process.env[FLAG]
    delete process.env[ALLOWLIST]
    // Restore the pre-suite substrate posture BEFORE dropping fixtures: an armed trigger on a fixture
    // teardown write would raise 40001 if any lease were still held, and no other suite may inherit
    // an armed database from this one.
    const capturedByName = new Map(capturedSubstratePosture.map((entry) => [entry.name, entry.enabled]))
    for (const [table, trigger] of AUTHORITY_TRIGGERS) {
      const captured = capturedByName.get(trigger)
      await q(`ALTER TABLE ${table} ${captured === 'O' ? 'ENABLE' : 'DISABLE'} TRIGGER ${trigger}`).catch(() => {})
    }
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    for (const sheet of [SHEET, OTHER_SHEET]) await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1', [sheet]).catch(() => {})
    for (const sheet of [SHEET, OTHER_SHEET]) await q('DELETE FROM meta_sheets WHERE id = $1', [sheet]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    for (const u of [ADMIN, WRITER, STALE, ROLEY, GROUPY, UNLEASED]) {
      await q('DELETE FROM user_permissions WHERE user_id = $1', [u]).catch(() => {})
      await q('DELETE FROM user_roles WHERE user_id = $1', [u]).catch(() => {})
      await q('DELETE FROM platform_member_group_members WHERE user_id = $1', [u]).catch(() => {})
      await q('DELETE FROM users WHERE id = $1', [u]).catch(() => {})
    }
    for (const roleId of [ROLE_LEASED, ROLE_SHARE, ROLE_UNLEASED]) {
      await q('DELETE FROM role_permissions WHERE role_id = $1', [roleId]).catch(() => {})
      await q('DELETE FROM roles WHERE id = $1', [roleId]).catch(() => {})
    }
    for (const groupId of [GRP_LEASED, GRP_UNLEASED]) {
      if (groupId) await q('DELETE FROM platform_member_groups WHERE id = $1::uuid', [groupId]).catch(() => {})
    }
  })

  test('sentinel: DATABASE_URL is set (this suite must RUN, never skip-green)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('FLAG-OFF: refuses 403 TRUST_CHECKPOINT_ACTIVATION_DISABLED, zero checkpoint rows (default posture)', async () => {
    delete process.env[FLAG]
    const res = await activateReq()
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('TRUST_CHECKPOINT_ACTIVATION_DISABLED')
    expect(await checkpointRows()).toEqual([])
  })

  test('FENCE-REQUIRED (gate M1): activation flag ON but the L4 fence flag OFF ⇒ 409 TRUST_CHECKPOINT_FENCE_REQUIRED, zero rows', async () => {
    // A checkpoint minted without the canonical fence is a DURABLE untrustworthy artifact (a concurrent
    // write can interleave between the trusted_since_seq allocation and the baseline snapshot — torn
    // baseline). The route must fail closed rather than provision it.
    process.env[FLAG] = 'true'
    delete process.env[FENCE_FLAG]
    const res = await activateReq()
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe('TRUST_CHECKPOINT_FENCE_REQUIRED')
    expect(await checkpointRows()).toEqual([])
  })

  test('RECOVERY_IN_PROGRESS (gate M2): a durable writer block on the sheet refuses the activation with zero rows', async () => {
    enableBoth()
    await q(`UPDATE meta_sheets SET recovery_writer_state = 'applying' WHERE id = $1`, [SHEET])
    try {
      const res = await activateReq()
      expect(res.status).toBe(409)
      expect(res.body?.error?.code).toBe('RECOVERY_IN_PROGRESS')
      expect(await checkpointRows()).toEqual([])
    } finally {
      await q('UPDATE meta_sheets SET recovery_writer_state = NULL WHERE id = $1', [SHEET])
    }
  })

  test('NON-ADMIN: a plain writer is refused (D2 floor), zero rows', async () => {
    enableBoth()
    actor = { id: WRITER, perms: ['multitable:read', 'multitable:write'] }
    const res = await activateReq()
    expect(res.status).toBe(403)
    expect(await checkpointRows()).toEqual([])
  })

  test('HAPPY: admin + flag ON activates; baselines snapshot live rows; a second activation supersedes (exactly one active)', async () => {
    enableBoth()
    await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [`rec_l5w_a_${TS}`, SHEET, JSON.stringify({ [F_STR]: 'a' }), ADMIN])
    await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [`rec_l5w_b_${TS}`, SHEET, JSON.stringify({ [F_STR]: 'b' }), ADMIN])

    const first = await activateReq()
    expect(first.status).toBe(200)
    expect(first.body?.data?.checkpointId).toBeTruthy()
    expect(String(first.body?.data?.trustedSinceSeq)).toMatch(/^[0-9]+$/)
    expect(first.body?.data?.baselineCount).toBe(2)
    expect(await baselineCountFor(first.body.data.checkpointId)).toBe(2)

    const second = await activateReq()
    expect(second.status).toBe(200)
    const rows = await checkpointRows()
    expect(rows.length).toBe(2)
    expect(rows.filter((r) => r.state === 'active').length).toBe(1) // exactly one active
    expect(rows.find((r) => r.id === first.body.data.checkpointId)?.state).toBe('superseded')
    expect(rows.find((r) => r.id === second.body.data.checkpointId)?.state).toBe('active')
  })

  test('UNATTRIBUTABLE trash: 409 HISTORY_INCOMPLETE (values-free) and the WHOLE activation rolls back', async () => {
    enableBoth()
    // A trashed-only record whose vintage cannot be causally attributed (NULL delete_revision_id, no live row).
    await q('INSERT INTO meta_records_trash (record_id, sheet_id, data, original_version) VALUES ($1,$2,$3::jsonb,1)', [`rec_l5w_ghost_${TS}`, SHEET, '{}'])
    const res = await activateReq()
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe('HISTORY_INCOMPLETE')
    // values-free: no record id / count leaks in the envelope.
    expect(JSON.stringify(res.body)).not.toContain(`rec_l5w_ghost_${TS}`)
    expect(await checkpointRows()).toEqual([]) // full rollback — not even a `building` row
  })

  test('NOT-FOUND: unknown sheet ⇒ 404', async () => {
    enableBoth()
    // Gate order is allowlist BEFORE existence, so the missing sheet must be DESIGNATED to reach the 404
    // at all. Designating it is what makes this still a 404 golden rather than an allowlist golden — the
    // deployment-scoped refusal must not be able to masquerade as "sheet not found" (and vice versa).
    const missing = `sheet_l5w_missing_${TS}`
    process.env[ALLOWLIST] = `${SHEET},${missing}`
    const res = await activateReq(missing)
    expect(res.status).toBe(404)
    expect(res.body?.error?.code).toBe('NOT_FOUND')
    // VALUES-FREE (owner fix, 2026-08-25): the refusal must not echo the requested sheet id back.
    // The error class already carried a fixed message; the route's catch had pasted `${sheetId}` in,
    // which un-did it at the only place a caller can observe. Assert on the SERIALISED body so no
    // field (message, details, anywhere) can reintroduce it.
    expect(JSON.stringify(res.body)).not.toContain(missing)
  })

  // ── P2 authorization fix: DB-fresh in-transaction re-check ──────────────────────────────────────────

  test('STALE-TOKEN (headline): the SAME unexpired token activates while granted, then is REFUSED 403 once the grant is revoked in the DB', async () => {
    enableBoth()
    // The actor's token carries multitable:share for the whole test — `resolveRequestAccess` returns on
    // the token's non-empty `perms` WITHOUT any DB read, so the pre-transaction floor passes in BOTH legs.
    // The only thing that changes between them is the DATABASE grant. That isolates the mutation to
    // exactly the authority source under test.
    actor = { id: STALE, perms: [...SHARE_PERMS] }
    await grantDb(STALE)

    // Leg A (positive control): DB grant present ⇒ the token+actor genuinely work on this route.
    const granted = await activateReq()
    expect(granted.status).toBe(200)
    expect(granted.body?.data?.checkpointId).toBeTruthy()
    const rowsAfterGrant = await checkpointRows()
    expect(rowsAfterGrant.length).toBe(1)

    // Leg B: revoke in the DB, keep the identical token ⇒ refused, and NOT ONE new row is written.
    await revokeDb(STALE)
    const revoked = await activateReq()
    expect(revoked.status).toBe(403)
    expect(revoked.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
    expect(await checkpointRows()).toEqual(rowsAfterGrant) // byte-identical row set: full rollback

    // Leg C (oracle closure): the SAME revoked-but-unexpired claims-admin token, aimed at a sheet that is
    // NOT in the allowlist, must get the SAME uniform 403 — not the 409 allowlist refusal. Without the
    // pool-level DB-fresh pre-check a revoked actor could tell 409 (designated canary missing) from
    // 404 (no such sheet) and enumerate which sheets the owner designated. Stale claims must observe
    // NO differentiated response at all.
    const probedOffList = await activateReq(`${SHEET}-not-allowlisted`)
    expect(probedOffList.status).toBe(403)
    expect(probedOffList.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
  })

  test('REVOKE-DURING-QUEUE (constructed race, two connections): a revoke that commits while the activation parks on the fence is observed ⇒ 403, zero rows', async () => {
    enableBoth()
    actor = { id: STALE, perms: [...SHARE_PERMS] }
    await grantDb(STALE)
    expect(pool).toBeTruthy()
    const holder = await pool!.connect()
    try {
      // Hold the canonical fence so the activation transaction parks INSIDE the fenced transaction,
      // AFTER the route's outer (pre-transaction) capability check has already passed with the grant live.
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`meta:auto-number:sheet:${SHEET}`])
      const inflight = activateReq().then((r) => r) // supertest is lazy — kick it off eagerly

      let sawWaiter = false
      for (let i = 0; i < 100; i++) {
        const waiters = await holder.query(`SELECT count(*)::int AS c FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)
        if (Number((waiters.rows[0] as { c: number }).c) > 0) { sawWaiter = true; break }
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(sawWaiter).toBe(true) // the outer check is done; the txn is genuinely parked on the fence

      // COMMIT the revoke on a SEPARATE connection while the activation is parked. Under READ COMMITTED
      // the in-fence re-check's statements take a fresh snapshot, so this revoke is visible to it.
      await revokeDb(STALE)
      await holder.query('COMMIT') // release the fence → the parked txn proceeds to the re-check

      const res = await inflight
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
      expect(await checkpointRows()).toEqual([]) // whole transaction rolled back
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      holder.release()
    }
  })

  // ── P2 authorization fix: fail-closed canary allowlist ──────────────────────────────────────────────

  test('NOT-ALLOWLISTED: a fully-authorized admin is refused 409 on a non-designated sheet, and PROCEEDS on the designated one (discriminating pair)', async () => {
    enableBoth() // designates SHEET only
    const refused = await activateReq(OTHER_SHEET)
    expect(refused.status).toBe(409)
    expect(refused.body?.error?.code).toBe('TRUST_CHECKPOINT_SHEET_NOT_ALLOWLISTED')
    expect(refused.body?.error?.message).toContain('MULTITABLE_TRUST_CHECKPOINT_SHEET_ALLOWLIST')
    // values-free: the refusal must not echo the requested sheet id or disclose the designated ones
    expect(JSON.stringify(refused.body)).not.toContain(OTHER_SHEET)
    expect(JSON.stringify(refused.body)).not.toContain(SHEET)
    expect((await q('SELECT id FROM meta_history_trust_checkpoints WHERE sheet_id = $1', [OTHER_SHEET])).rows).toEqual([])

    // SAME actor, SAME posture, only the sheet differs ⇒ proceeds. Without this half the refusal above
    // could be caused by anything (a broken fixture, a missing grant), not by the allowlist.
    const allowed = await activateReq(SHEET)
    expect(allowed.status).toBe(200)
    expect(allowed.body?.data?.checkpointId).toBeTruthy()
  })

  test('ALLOWLIST-UNSET (fail-closed default): with the allowlist unset — or whitespace/separator-only — activation is refused for EVERY sheet', async () => {
    for (const value of [undefined, '', '   ', ' , , ']) {
      process.env[FLAG] = 'true'
      process.env[FENCE_FLAG] = 'true'
      if (value === undefined) delete process.env[ALLOWLIST]
      else process.env[ALLOWLIST] = value
      for (const sheet of [SHEET, OTHER_SHEET]) {
        const res = await activateReq(sheet)
        expect(res.status).toBe(409)
        expect(res.body?.error?.code).toBe('TRUST_CHECKPOINT_SHEET_NOT_ALLOWLISTED')
      }
    }
    expect(await checkpointRows()).toEqual([])
  })

  test('GATE-ORDER: an UNAUTHORIZED caller on a NON-allowlisted sheet gets the uniform 403 — allowlist membership is never disclosed to them', async () => {
    enableBoth() // designates SHEET only
    actor = { id: WRITER, perms: ['multitable:read', 'multitable:write'] }
    const res = await activateReq(OTHER_SHEET)
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
    expect(res.body?.error?.code).not.toBe('TRUST_CHECKPOINT_SHEET_NOT_ALLOWLISTED')
  })

  test('CONCURRENT-ACTIVATION (two real connections, persistent CI golden — owner P2): route-level race serializes on the fence; module-level race is caught by the one-active partial-unique', async () => {
    enableBoth()
    // (a) ROUTE level: two concurrent requests. The fence serializes the two cutover transactions, so the
    // outcome is deterministic in SHAPE: every success activated exactly once, later success supersedes,
    // and the DB ends with EXACTLY ONE active row. (A loser that interleaves at the flip maps to 409
    // ACTIVATION_CONFLICT — accepted; never a 500, never two actives.)
    const [r1, r2] = await Promise.all([activateReq().then((r) => r), activateReq().then((r) => r)])
    const statuses = [r1.status, r2.status].sort()
    expect([[200, 200], [200, 409]]).toContainEqual(statuses)
    // A 409 here must still be the ACTIVATION_CONFLICT it always was. Asserting only the STATUS would
    // stay green if the lease turned this into a busy/unavailable refusal instead — the same number for
    // a different reason. Both racers are the SAME actor, so they serialize on the canonical fence and
    // the loser takes the lease only after the winner's transaction (and its lease) has ended.
    for (const r of [r1, r2]) if (r.status === 409) expect(r.body?.error?.code).toBe('ACTIVATION_CONFLICT')
    const rows = await checkpointRows()
    expect(rows.filter((r) => r.state === 'active').length).toBe(1)
    expect(rows.length).toBe([r1, r2].filter((r) => r.status === 200).length)

    // (b) MODULE level (the DB backstop itself): two raw clients race activateCheckpoint WITHOUT the fence
    // (the exact bypass the route's M1 guard forbids) — the one-active partial-unique must let exactly one
    // commit; the loser gets a unique violation and rolls back fully.
    expect(pool).toBeTruthy()
    const [c1, c2] = await Promise.all([pool!.connect(), pool!.connect()])
    try {
      await q('DELETE FROM meta_history_baselines WHERE sheet_id = $1', [SHEET])
      await q('DELETE FROM meta_history_trust_checkpoints WHERE sheet_id = $1', [SHEET])
      const { activateCheckpoint } = await import('../../src/multitable/history-trust-checkpoint')
      const raceOne = async (client: (typeof c1)) => {
        await client.query('BEGIN')
        try {
          const res = await activateCheckpoint(((sql: string, params?: unknown[]) => client.query(sql, params)) as never, { sheetId: SHEET })
          await client.query('COMMIT')
          return { ok: true as const, id: res.checkpointId }
        } catch (e) {
          await client.query('ROLLBACK').catch(() => undefined)
          return { ok: false as const, code: (e as { code?: string }).code }
        }
      }
      const [a, b] = await Promise.all([raceOne(c1), raceOne(c2)])
      const winners = [a, b].filter((r) => r.ok)
      const losers = [a, b].filter((r) => !r.ok)
      // Either they serialized on row locks (both commit, second supersedes) or the partial-unique caught
      // the true flip race (loser 23505) — in EVERY outcome: exactly one active, loser left zero rows.
      expect(winners.length).toBeGreaterThanOrEqual(1)
      for (const l of losers) expect(l.code).toBe('23505')
      const finalRows = await checkpointRows()
      expect(finalRows.filter((r) => r.state === 'active').length).toBe(1)
      expect(finalRows.length).toBe(winners.length)
    } finally {
      c1.release()
      c2.release()
    }
  })

  test('FENCE-PARK (constructed race): a raw client holding the canonical fence parks the activation until release', async () => {
    enableBoth()
    expect(pool).toBeTruthy()
    const holder = await pool!.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`meta:auto-number:sheet:${SHEET}`])
      // NOTE: the route's fence is flag-gated by the L4 fence flag — turn it on for THIS test so the
      // activation genuinely parks (with it off, fenceWriterEntry is a no-op by design).
      process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
      // supertest Tests are LAZY (nothing fires until then/await) — kick it off eagerly so it can park.
      const inflight = activateReq().then((r) => r)
      let sawWaiter = false
      for (let i = 0; i < 100; i++) {
        const waiters = await holder.query(`SELECT count(*)::int AS c FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)
        if (Number((waiters.rows[0] as { c: number }).c) > 0) { sawWaiter = true; break }
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(sawWaiter).toBe(true) // genuinely parked behind the fence
      await holder.query('COMMIT')
      const res = await inflight
      expect(res.status).toBe(200) // proceeds to a successful activation once the fence is released
    } finally {
      delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
      holder.release()
    }
  })

  // ── Actor authority lease: substrate posture (owner positive control A) ─────────────────────────────

  test('SUBSTRATE-DISABLED (positive control A): the freshly-migrated 9/9-DISABLED posture refuses the activation with ZERO checkpoint and ZERO baseline rows', async () => {
    enableBoth()
    await disarmSubstrate()
    try {
      // The migration ships all nine authority triggers DISABLED; this restores that exact posture.
      expect(new Set((await substratePosture()).map((entry) => entry.enabled))).toEqual(new Set(['D']))
      const before = await activationWriteCounts()
      expect(before).toEqual({ checkpoints: 0, baselines: 0 })

      const res = await activateReq()
      expect(res.status).toBe(409)
      expect(res.body).toEqual({
        ok: false,
        error: {
          code: TRUST_CHECKPOINT_AUTHORITY_UNAVAILABLE_CODE,
          message: TRUST_CHECKPOINT_AUTHORITY_UNAVAILABLE_MESSAGE,
          details: { retryable: false },
        },
      })
      // values-free: the refusal names the operator action, never a trigger / function / subject / count.
      const envelope = JSON.stringify(res.body)
      for (const [, trigger] of AUTHORITY_TRIGGERS) expect(envelope).not.toContain(trigger)
      for (const token of [SHEET, ADMIN, 'metasheet_try_recovery_authority']) expect(envelope).not.toContain(token)
      expect(envelope).not.toMatch(/[0-9]\s*\/\s*9/)
      // ZERO writes — checkpoints AND baselines, for every sheet this suite owns.
      expect(await activationWriteCounts()).toEqual({ checkpoints: 0, baselines: 0 })
    } finally {
      await armSubstrate()
    }
  })

  test('SUBSTRATE-PARTIAL: 8/9 armed is NOT armed — the same fail-closed refusal, zero rows (the bar is exactly 9/9)', async () => {
    enableBoth()
    const [skipTable, skipTrigger] = AUTHORITY_TRIGGERS[0]
    await q(`ALTER TABLE ${skipTable} DISABLE TRIGGER ${skipTrigger}`)
    try {
      const posture = await substratePosture()
      expect(posture.filter((entry) => entry.enabled === 'O')).toHaveLength(AUTHORITY_TRIGGERS.length - 1)
      const res = await activateReq()
      expect(res.status).toBe(409)
      expect(res.body?.error?.code).toBe(TRUST_CHECKPOINT_AUTHORITY_UNAVAILABLE_CODE)
      expect(await activationWriteCounts()).toEqual({ checkpoints: 0, baselines: 0 })
    } finally {
      await armSubstrate()
    }
  })

  test('ORACLE-AFTER-LEASE: with the lease unavailable, a NON-designated sheet and a MISSING sheet return the SAME refusal — allowlist/404 are no longer adjudicated before the lease', async () => {
    // Pre-lease ordering emitted 409 TRUST_CHECKPOINT_SHEET_NOT_ALLOWLISTED and 404 NOT_FOUND before the
    // transaction ever opened, so those differentiated answers were reachable on a state the transaction
    // never re-confirmed. They now run after the lease and after the post-lease final authorization, so
    // when the lease refuses, NOTHING downstream of it is observable.
    enableBoth()
    await disarmSubstrate()
    try {
      const designated = await activateReq(SHEET)
      const notDesignated = await activateReq(OTHER_SHEET)
      const missing = await activateReq(`sheet_l5w_absent_${TS}`)
      for (const res of [designated, notDesignated, missing]) {
        expect(res.status).toBe(409)
        expect(res.body?.error?.code).toBe(TRUST_CHECKPOINT_AUTHORITY_UNAVAILABLE_CODE)
      }
      expect(notDesignated.body).toEqual(designated.body)
      expect(missing.body).toEqual(designated.body)
      expect(await activationWriteCounts()).toEqual({ checkpoints: 0, baselines: 0 })
    } finally {
      await armSubstrate()
    }
  })

  // ── Actor authority lease: busy (owner positive control B — revoke-wins, contended variant) ─────────

  test('LEASE-BUSY: a concurrent OPEN permission write holding the actor authority key ⇒ retryable 409, zero rows; the SAME request succeeds once it rolls back', async () => {
    enableBoth()
    const writer = await connect()
    try {
      // An UNCOMMITTED permission write takes the actor's SHARED authority key for the life of its
      // transaction (armed trigger). The activation's exclusive try-lock therefore cannot be taken.
      await writer.query('BEGIN')
      await writer.query('DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = $2', [ADMIN, 'multitable:read'])

      const busy = await activateReq()
      expect(busy.status).toBe(409)
      expect(busy.body).toEqual({
        ok: false,
        error: {
          code: TRUST_CHECKPOINT_AUTHORITY_BUSY_CODE,
          message: TRUST_CHECKPOINT_AUTHORITY_BUSY_MESSAGE,
          details: { retryable: true },
        },
      })
      expect(JSON.stringify(busy.body)).not.toContain(ADMIN) // values-free: no subject echoed
      expect(await activationWriteCounts()).toEqual({ checkpoints: 0, baselines: 0 })

      // Discriminating half: the refusal is caused by the CONTENTION and nothing else.
      await writer.query('ROLLBACK')
      const ready = await activateReq()
      expect(ready.status).toBe(200)
      expect(ready.body?.data?.checkpointId).toBeTruthy()
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined)
      writer.release()
    }
  })

  // ── Actor authority lease: activation-wins (owner positive control B) ───────────────────────────────

  test('ACTIVATION-WINS: while the activation holds the lease, every COVERED revocation surface is refused 40001 and every UNCOVERED control succeeds; the activation then commits', async () => {
    enableBoth()
    // Pause point AFTER the lease: a holder on meta_sheets(SHEET) FOR UPDATE blocks the checkpoint
    // INSERT's FK `FOR KEY SHARE`, which is the FIRST blocking acquisition after fence → lease → final
    // authorization → adjudication. The holder takes NO advisory lock, so it can never close a cycle
    // with the fence (this is the safe side of the fence-first constraint; see NO-40P01 below).
    const holder = await connect()
    const observer = await connect()
    let inflight: Promise<ActivationResponse> | null = null
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE', [SHEET])

      inflight = activateReq().then((r) => r)
      // The activation holds exactly ONE advisory lock (the canonical fence) before the lease and >= 2
      // after it. Deleting the lease — or moving it after activateCheckpoint — never reaches 2, so this
      // poll exhausts its bound and reds the golden.
      await pollUntil('the activation to hold the fence AND the actor authority lease', async () =>
        (await grantedAdvisoryLocks(observer)) >= 2 ? true : null)
      // ... and it is genuinely parked on the FK row lock, not merely slow: real catalog evidence.
      // NOT redundant with the advisory count above: that count can reach 2 with only the fence and the
      // actor's USER key held, before the discovered ROLE and GROUP keys land. Waiting until the
      // activation is BLOCKED on the FK row lock proves the WHOLE lease (user → role → group) is held
      // before the ROLE_LEASED / GRP_LEASED legs below run. Do not delete this as duplicated polling.
      const blocked = await pollUntil('the activation to block on the meta_sheets FK row lock', async () => {
        const rows = await waitEvidence(observer)
        return rows.some((row) => row.wait_event_type === 'Lock') ? rows : null
      })
      expect(blocked.some((row) => row.wait_event_type === 'Lock')).toBe(true)

      // Every revocation surface that can change canManageSheetAccess, each paired with an UNCOVERED
      // control on the SAME table. Without the control a 40001 could come from anything (a table lock,
      // an unrelated serialization failure) and the positive would be blind.
      const legs: Array<{ name: string; covered: [string, unknown[]]; control: [string, unknown[]] }> = [
        {
          name: 'direct-user permission (user_permissions → actor key)',
          covered: ['DELETE FROM user_permissions WHERE user_id = $1', [ADMIN]],
          control: ['DELETE FROM user_permissions WHERE user_id = $1', [UNLEASED]],
        },
        {
          name: 'role assignment (user_roles → actor key)',
          covered: ['DELETE FROM user_roles WHERE user_id = $1', [ADMIN]],
          control: ['DELETE FROM user_roles WHERE user_id = $1', [UNLEASED]],
        },
        {
          name: 'role grant (role_permissions → ROLE key discovered from the actor assignment)',
          covered: ['DELETE FROM role_permissions WHERE role_id = $1', [ROLE_LEASED]],
          control: ['DELETE FROM role_permissions WHERE role_id = $1', [ROLE_UNLEASED]],
        },
        {
          name: 'group membership (platform_member_group_members → actor key)',
          covered: ['DELETE FROM platform_member_group_members WHERE user_id = $1', [ADMIN]],
          control: ['DELETE FROM platform_member_group_members WHERE user_id = $1', [UNLEASED]],
        },
        {
          name: 'member-group sheet grant (spreadsheet_permissions → GROUP key discovered from membership)',
          covered: ['DELETE FROM spreadsheet_permissions WHERE subject_type = $1 AND subject_id = $2', ['member-group', GRP_LEASED]],
          control: ['DELETE FROM spreadsheet_permissions WHERE subject_type = $1 AND subject_id = $2', ['member-group', GRP_UNLEASED]],
        },
        {
          name: 'account deactivation (users.is_active → actor key)',
          covered: ['UPDATE users SET is_active = FALSE WHERE id = $1', [ADMIN]],
          control: ['UPDATE users SET is_active = FALSE WHERE id = $1', [UNLEASED]],
        },
      ]
      for (const leg of legs) {
        const control = await attemptAuthorityWrite(leg.control[0], leg.control[1])
        expect(control, `${leg.name}: UNCOVERED control must be unaffected by the lease`).toEqual({ ok: true })
        const covered = await attemptAuthorityWrite(leg.covered[0], leg.covered[1])
        expect(covered.ok, `${leg.name}: covered revoke must be refused while the lease is held`).toBe(false)
        expect((covered as { code?: string }).code, leg.name).toBe('40001')
        expect((covered as { message: string }).message, leg.name).toBe(RECOVERY_AUTHORITY_BUSY_MARKER)
      }

      await holder.query('ROLLBACK')
      const res = await inflight
      inflight = null
      expect(res.status).toBe(200) // the activation wins: it commits, and nothing revoked underneath it
      expect(res.body?.data?.checkpointId).toBeTruthy()
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      // ALWAYS drain the in-flight request before leaving. If an assertion (or a poll bound on a slow
      // runner) aborts this test early, an undrained activation commits its checkpoint AFTER afterEach
      // has already cleaned up — poisoning the NEXT test's zero-rows assertion with a cascade failure
      // that looks like a defect in a test that is actually fine.
      await inflight?.catch(() => undefined)
      holder.release()
      observer.release()
    }
  }, 60_000)

  // ── Actor authority lease: revoke-wins across every authority derivation ────────────────────────────

  const revokeWinsLeg = async (
    actorId: string,
    tokenPerms: string[],
    revoke: () => Promise<void>,
    restore: () => Promise<void>,
  ) => {
    enableBoth()
    actor = { id: actorId, perms: tokenPerms }
    const holder = await connect()
    try {
      // Park the activation on the canonical fence, i.e. AFTER the route's pre-transaction fast reject
      // has already passed with the grant live, and BEFORE the lease + final authorization run.
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`meta:auto-number:sheet:${SHEET}`])
      const inflight = activateReq().then((r) => r)
      await pollUntil('the activation to park on the canonical fence', async () =>
        (await waitEvidence(holder)).some((row) => row.wait_event === 'advisory') ? true : null)

      await revoke() // COMMITS while the activation is parked
      await holder.query('COMMIT') // release the fence → lease → DB-fresh FINAL authorization observes it

      const res = await inflight
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
      expect(await activationWriteCounts()).toEqual({ checkpoints: 0, baselines: 0 })
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      holder.release()
      await restore()
    }
  }

  test('REVOKE-WINS (role-derived): revoking the ROLE ASSIGNMENT while the activation parks ⇒ 403, zero rows', async () => {
    // ROLEY's canManageSheetAccess exists ONLY because role_permissions(ROLE_SHARE) carries
    // multitable:share and user_roles assigns it — no user_permissions row is involved.
    await revokeWinsLeg(
      ROLEY,
      [...SHARE_PERMS],
      async () => { await q('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [ROLEY, ROLE_SHARE]) },
      async () => { await q('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ROLEY, ROLE_SHARE]) },
    )
  }, 60_000)

  test('REVOKE-WINS (role-derived, grant side): revoking the ROLE GRANT while the activation parks ⇒ 403, zero rows', async () => {
    await revokeWinsLeg(
      ROLEY,
      [...SHARE_PERMS],
      async () => { await q('DELETE FROM role_permissions WHERE role_id = $1 AND permission_code = $2', [ROLE_SHARE, 'multitable:share']) },
      async () => { await q('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ROLE_SHARE, 'multitable:share']) },
    )
  }, 60_000)

  test('REVOKE-WINS (member-group-derived): revoking the GROUP MEMBERSHIP while the activation parks ⇒ 403, zero rows', async () => {
    // GROUPY's canManageSheetAccess exists ONLY because it is a member of GRP_LEASED and that group
    // holds a multitable:admin grant on SHEET (groups DO participate in canManageSheetAccess). Its token
    // carries no share perm, so nothing else can be supplying the capability.
    await revokeWinsLeg(
      GROUPY,
      ['multitable:read'],
      async () => { await q('DELETE FROM platform_member_group_members WHERE group_id = $1::uuid AND user_id = $2', [GRP_LEASED, GROUPY]) },
      async () => { await q('INSERT INTO platform_member_group_members (group_id, user_id) VALUES ($1::uuid,$2) ON CONFLICT DO NOTHING', [GRP_LEASED, GROUPY]) },
    )
  }, 60_000)

  test('MEMBER-GROUP authority is genuinely load-bearing (control for the group leg): GROUPY activates while the group grant stands', async () => {
    // Without this the group revoke-wins leg above could be green for the wrong reason (GROUPY never had
    // authority at all, so any refusal would look identical).
    enableBoth()
    actor = { id: GROUPY, perms: ['multitable:read'] }
    const res = await activateReq()
    expect(res.status).toBe(200)
    expect(res.body?.data?.checkpointId).toBeTruthy()
  })

  // ── No 40P01, with a harness negative control ───────────────────────────────────────────────────────

  test('HARNESS-40P01 (negative control): this harness DOES observe a real deadlock when one is deliberately constructed', async () => {
    // Without this, "no 40P01 was observed" would be a vacuous green — indistinguishable from a harness
    // that cannot see one. Two blocking ROW locks taken in opposite order on two rows this suite owns.
    const a = await connect()
    const b = await connect()
    try {
      await a.query('BEGIN')
      await b.query('BEGIN')
      await a.query('SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE', [SHEET])
      await b.query('SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE', [OTHER_SHEET])
      const aWaits = runCapturing(a, 'SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE', [OTHER_SHEET])
      const bWaits = runCapturing(b, 'SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE', [SHEET])
      const outcomes = await Promise.all([aWaits, bWaits])
      const codes = outcomes.map((outcome) => (outcome.ok ? null : outcome.code))
      expect(codes).toContain('40P01') // *** the harness is not vacuous ***
    } finally {
      await a.query('ROLLBACK').catch(() => undefined)
      await b.query('ROLLBACK').catch(() => undefined)
      a.release()
      b.release()
    }
  }, 60_000)

  test('NO-40P01 (fence-first ordering): the activation takes the canonical fence BEFORE any meta_sheets row lock, so the cycle-closing interleaving never deadlocks', async () => {
    // THE shape that would deadlock (reproduced on real PostgreSQL by the lock-order census):
    //   holder : F(SHEET)                  ═══> meta_sheets(SHEET) FOR UPDATE
    //   activation : meta_sheets FOR UPDATE ═══> F(SHEET)
    // The activation's real ordering is fence FIRST, so while it waits on F it holds NO meta_sheets row
    // lock and the holder's FOR UPDATE is granted immediately — one directed wait edge, never a cycle.
    // Moving any meta_sheets row lock ahead of the fence inverts the activation's half and makes 40P01
    // live; that mutation reds this golden (either the holder's FOR UPDATE raises 40P01, or the
    // activation is the victim and answers 500).
    enableBoth()
    const holder = await connect()
    const observer = await connect()
    const deadlockTimeoutMs = Number(((await observer.query(
      "SELECT setting::int AS ms FROM pg_settings WHERE name = 'deadlock_timeout'",
    )).rows[0] as { ms: number }).ms)
    let inflight: Promise<ActivationResponse> | null = null
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`meta:auto-number:sheet:${SHEET}`])
      inflight = activateReq().then((r) => r)

      // Bound the wait explicitly and prove the block with catalog evidence, never a sleep. The bound is
      // >> deadlock_timeout (reported above), so a deadlock that DID form would be detected and reported
      // by PostgreSQL well inside it rather than showing up here as a timeout.
      const evidence = await pollUntil('the activation to park on the canonical fence', async () => {
        const rows = await waitEvidence(observer)
        return rows.some((row) => row.wait_event === 'advisory') ? rows : null
      })
      expect(evidence.some((row) => row.wait_event_type === 'Lock' && row.wait_event === 'advisory')).toBe(true)
      // State the bound against the server's own detector interval: a deadlock that DID form would be
      // raised by PostgreSQL long before this poll could time out, so a timeout here is never a
      // mis-reported deadlock.
      expect(deadlockTimeoutMs).toBeGreaterThan(0)
      expect(deadlockTimeoutMs * 3).toBeLessThan(POLL_BOUND_MS)

      // The holder now takes the row lock the activation would need LATER (via the checkpoint FK). With
      // fence-first ordering the activation holds no meta_sheets row lock, so this is granted at once.
      const rowLock = await runCapturing(holder, 'SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE', [SHEET])
      expect(rowLock).toEqual({ ok: true }) // no 40P01 on the holder side
      await holder.query('COMMIT')

      const res = await inflight
      inflight = null
      expect(res.status).toBe(200) // no 40P01 on the activation side either
      expect((res.body as { error?: { code?: string } }).error?.code).toBeUndefined()
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await inflight?.catch(() => undefined) // drain: see ACTIVATION-WINS for why an undrained request cascades
      holder.release()
      observer.release()
    }
  }, 60_000)
})
