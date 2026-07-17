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

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const FLAG = 'MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION'
const FENCE_FLAG = 'MULTITABLE_ENABLE_WRITER_FENCE'
// Gate M1: activation requires the canonical fence — the standard posture for these goldens is BOTH ON.
const enableBoth = () => { process.env[FLAG] = 'true'; process.env[FENCE_FLAG] = 'true' }
const TS = Date.now()
const BASE = `base_l5w_${TS}`
const SHEET = `sheet_l5w_${TS}`
const F_STR = `fld_l5w_note_${TS}`
const ADMIN = `u_l5w_admin_${TS}` // base owner ⇒ canManageSheetAccess
const WRITER = `u_l5w_writer_${TS}` // plain writer ⇒ NO canManageSheetAccess

const q = (sql: string, params: unknown[] = []) => poolManager.get().query(sql, params)

let app: Express
let actor: { id: string; perms: string[] } = { id: ADMIN, perms: ['multitable:read', 'multitable:write', 'multitable:share'] }

const activateReq = (sheetId: string = SHEET) => request(app).post(`/api/multitable/sheets/${sheetId}/trust-checkpoint-activate`).send({})
const checkpointRows = async () =>
  (await q(`SELECT id, state FROM meta_history_trust_checkpoints WHERE sheet_id = $1 ORDER BY created_at`, [SHEET])).rows as Array<{ id: string; state: string }>
const baselineCountFor = async (checkpointId: string) =>
  Number(((await q('SELECT count(*)::int c FROM meta_history_baselines WHERE checkpoint_id = $1', [checkpointId])).rows[0] as { c: number }).c)

test('sentinel: the real-DB allowlist step must have DATABASE_URL (fail-not-skip, scoped to that step)', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('real-DB allowlist step is missing DATABASE_URL — the harness is broken, not legitimately skippable')
  }
  expect(true).toBe(true)
})

describeIfDatabase('W0-1 L5-wire — trust-checkpoint activation route (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: actor.id, roles: ['member'], perms: actor.perms }; next() })
    app.use('/api/multitable', univerMetaRouter())
    for (const u of [ADMIN, WRITER]) await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [u])
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [BASE, 'L5W Base', ADMIN])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'L5W'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_STR, SHEET, 'Note', 'string', '{}', 1])
  })
  afterEach(async () => {
    delete process.env[FLAG]
    delete process.env[FENCE_FLAG]
    __resetRecoveryWriterStateColumnProbe()
    actor = { id: ADMIN, perms: ['multitable:read', 'multitable:write', 'multitable:share'] }
    for (const t of ['meta_history_baselines', 'meta_history_trust_checkpoints', 'meta_records_trash', 'meta_record_revisions', 'meta_records'])
      await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
  })
  afterAll(async () => {
    delete process.env[FLAG]
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    for (const u of [ADMIN, WRITER]) await q('DELETE FROM users WHERE id = $1', [u]).catch(() => {})
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
    const res = await activateReq(`sheet_l5w_missing_${TS}`)
    expect(res.status).toBe(404)
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
})
