/**
 * W0-1 v3.7 (owner-ratified #4331 §3) — Lane L5 TRUST-CHECKPOINT real-DB goldens: the building→active state
 * machine (partial-unique one-active guard + concurrent double-activation), seq-based + display-T selection
 * (totally ordered, exact bigint), the floor-clamped retention prune, the server-owned non-forgeable
 * system_kind, and the P3-2 enablement precondition. Pure-helper goldens live in
 * `tests/unit/multitable-history-trust-checkpoint.test.ts`.
 *
 * This is a DEFAULT-OFF slice: nothing here enables strict mode, Revert, or Reset in any real environment,
 * and nothing wires checkpoint activation into the live restore/execute path (that in-fence cutover is
 * L5-wire, deferred until L4's fence lands). `activateCheckpoint` is exercised in isolation by opening a
 * transaction here — the "L4 wires this in" seam.
 *
 * Fixture hygiene (v3.7 P2-C): every checkpoint is created either via `activateCheckpoint` (which allocates
 * from the shared `meta_record_chain_seq` via NORMAL `nextval` — never `setval`) or by inserting EXPLICIT
 * synthetic `trusted_since_seq` literals into isolated fixture rows. This file NEVER calls `setval` on the
 * shared sequence. Every sheet is created under this file's own base; `afterAll` cascade-deletes them, which
 * cascades to checkpoints + baselines (FK ON DELETE CASCADE).
 *
 * Two-point wiring: plugin-tests.yml real-DB run list + vitest.integration.config.ts. Runs only with
 * DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import type { QueryFn } from '../../src/multitable/permission-service'
import {
  activateCheckpoint,
  selectCheckpointByAnchorSeq,
  selectCheckpointByT,
  retentionFloorSeq,
  pruneRetainedCheckpoints,
} from '../../src/multitable/history-trust-checkpoint'
import { checkStrictEnablementPrecondition } from '../../src/multitable/history-trust-precondition'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_l5ck_${TS}`
const ACTOR = `user_l5ck_${TS}`
const NAME = `fld_l5ck_name_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let sheetSeq = 0

/** A fresh, file-namespaced sheet (its OWN active-checkpoint domain — no cross-test coupling). */
async function mkSheet(opts?: { systemKind?: string }): Promise<string> {
  const id = `sheet_l5ck_${TS}_${sheetSeq++}`
  await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [id, BASE, `L5 ${id}`])
  await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [`${id}_f`, id, NAME, 'string', '{}', 1])
  if (opts?.systemKind) await q('UPDATE meta_sheets SET system_kind = $2 WHERE id = $1', [id, opts.systemKind])
  return id
}
async function insertLive(sheetId: string, recordId: string, data: Record<string, unknown>, version: number) {
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,$4)', [recordId, sheetId, JSON.stringify(data), version])
}
async function insertTrash(sheetId: string, recordId: string, data: Record<string, unknown>, originalVersion: number) {
  await q('INSERT INTO meta_records_trash (record_id, sheet_id, data, original_version) VALUES ($1,$2,$3::jsonb,$4)', [recordId, sheetId, JSON.stringify(data), originalVersion])
}
/** Run `activateCheckpoint` inside a real transaction (the seam L4 will provide, holding the fence). */
async function activate(sheetId: string) {
  return poolManager.get().transaction(async ({ query }) => activateCheckpoint(query as unknown as QueryFn, { sheetId }))
}
/** Insert a SYNTHETIC checkpoint with an EXPLICIT seq (isolated fixture; never a setval on the shared seq). */
async function insertSyntheticCheckpoint(input: { id: string; sheetId: string; state: string; seq: string; trustedFromAt?: string | null }) {
  await q(
    `INSERT INTO meta_history_trust_checkpoints (id, sheet_id, state, trusted_since_seq, trusted_from_at)
     VALUES ($1,$2,$3,$4::bigint,$5)`,
    [input.id, input.sheetId, input.state, input.seq, input.trustedFromAt ?? null],
  )
}
async function checkpointRow(id: string) {
  const r = await q(`SELECT id, state, trusted_since_seq::text AS seq, system_kind, pruned_at, trusted_from_at, activated_at FROM meta_history_trust_checkpoints WHERE id = $1`, [id])
  return r.rows[0] as { id: string; state: string; seq: string; system_kind: string | null; pruned_at: Date | null; trusted_from_at: Date | null; activated_at: Date | null } | undefined
}
async function activeCount(sheetId: string): Promise<number> {
  const r = await q(`SELECT count(*)::int AS c FROM meta_history_trust_checkpoints WHERE sheet_id=$1 AND state='active'`, [sheetId])
  return Number((r.rows[0] as { c: number }).c)
}

// Red-not-skip-green sentinel — TOP-LEVEL (outside describeIfDatabase) so it runs even without a DB and FAILS,
// rather than silently skipping, when the REAL-DB ALLOWLIST STEP runs this file without DATABASE_URL. Scoped to
// that step via the workflow-injected METASHEET_REAL_DB_TEST_STEP env: the normal no-DB core-backend test job
// also collects this file (CI=true, no DATABASE_URL) and there the sentinel MUST pass — the describeIfDatabase
// goldens legitimately skip in that job; we don't red it. (Pattern mirrors the sibling real-DB files.)
test('sentinel: the real-DB allowlist step must have DATABASE_URL (fail-not-skip, scoped to that step)', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('real-DB allowlist step is missing DATABASE_URL — the harness is broken, not legitimately skippable')
  }
  expect(true).toBe(true)
})

describeIfDatabase('W0-1 v3.7 L5 trust checkpoint (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: ACTOR, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:share'] }; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'L5 Checkpoint Base'])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
  })
  afterAll(async () => {
    // Cascade: deleting sheets under this base drops their checkpoints + baselines (FK ON DELETE CASCADE).
    await q('DELETE FROM meta_records_trash WHERE sheet_id IN (SELECT id FROM meta_sheets WHERE base_id = $1)', [BASE]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id IN (SELECT id FROM meta_sheets WHERE base_id = $1)', [BASE]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id IN (SELECT id FROM meta_sheets WHERE base_id = $1)', [BASE]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE base_id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  // ── BASELINE SNAPSHOT + ATOMIC FLIP ──────────────────────────────────────────────────────────────────
  test('activation snapshots live + recoverable-trash rows into a SEPARATE baselines table and flips building→active atomically', async () => {
    const S = await mkSheet()
    await insertLive(S, `${S}_r1`, { [NAME]: 'a' }, 1)
    await insertLive(S, `${S}_r2`, { [NAME]: 'b' }, 3)
    await insertTrash(S, `${S}_t1`, { [NAME]: 'gone' }, 2)

    const res = await activate(S)
    expect(res.baselineCount).toBe(3)
    const ck = await checkpointRow(res.checkpointId)
    expect(ck?.state).toBe('active')
    expect(ck?.trusted_from_at).toBeTruthy() // clock_timestamp() stamped at the flip (NOT null)
    expect(ck?.activated_at).toBeTruthy()
    expect(BigInt(ck!.seq) > 0n).toBe(true)

    const baselines = await q('SELECT record_id, version, is_trashed FROM meta_history_baselines WHERE checkpoint_id = $1 ORDER BY record_id', [res.checkpointId])
    const rows = baselines.rows as Array<{ record_id: string; version: number; is_trashed: boolean }>
    expect(rows.map((r) => [r.record_id.replace(`${S}_`, ''), r.version, r.is_trashed])).toEqual([
      ['r1', 1, false],
      ['r2', 3, false],
      ['t1', 2, true],
    ])
  })

  // ── SEQUENTIAL RE-ACTIVATION (supersede) ─────────────────────────────────────────────────────────────
  test('a second activation supersedes the first — exactly one active, both retained, seq strictly increases', async () => {
    const S = await mkSheet()
    const a = await activate(S)
    const b = await activate(S)
    expect(await activeCount(S)).toBe(1)
    const ca = await checkpointRow(a.checkpointId)
    const cb = await checkpointRow(b.checkpointId)
    expect(ca?.state).toBe('superseded')
    expect(cb?.state).toBe('active')
    expect(BigInt(b.trustedSinceSeq) > BigInt(a.trustedSinceSeq)).toBe(true) // exact bigint, monotonic
    expect(ca?.pruned_at).toBeNull() // superseded is still retained (selectable by an older anchor)
  })

  // ── CONCURRENT DOUBLE-ACTIVATION (constructed race, two raw clients) ──────────────────────────────────
  test('two concurrent activations on one sheet → the partial-unique reds the loser; exactly ONE active survives', async () => {
    const S = await mkSheet()
    const pool = poolManager.get().getInternalPool()
    const c1 = await pool.connect()
    const c2 = await pool.connect()
    const c1q: QueryFn = (sql, params) => c1.query(sql, params as unknown[])
    const c2q: QueryFn = (sql, params) => c2.query(sql, params as unknown[])
    try {
      await c1.query('BEGIN')
      // c1 runs the whole activation and holds its building→active flip in an UNCOMMITTED txn (holding the
      // partial-unique key for (sheet)).
      await activateCheckpoint(c1q, { sheetId: S })

      await c2.query('BEGIN')
      // c2's activation runs concurrently; its flip to state='active' MUST block on c1's uncommitted key.
      const p2 = activateCheckpoint(c2q, { sheetId: S })

      // Positive control that the race is genuinely constructed (not sequential): poll until c2's backend
      // is blocked BY c1's backend ([[feedback_toctou_needs_constructed_race]]).
      const c2pid = (c2 as any).processID as number
      let blocked = false
      for (let i = 0; i < 100 && !blocked; i++) {
        const r = await c1.query('SELECT cardinality(pg_blocking_pids($1)) AS n', [c2pid])
        if (Number((r.rows[0] as { n: number }).n) > 0) blocked = true
        else await new Promise((r2) => setTimeout(r2, 20))
      }
      expect(blocked).toBe(true)

      // Commit c1 → releases the key → c2's flip resolves with a unique_violation (23505).
      await c1.query('COMMIT')
      await expect(p2).rejects.toMatchObject({ code: '23505' })
      await c2.query('ROLLBACK')
    } finally {
      c1.release()
      c2.release()
    }
    expect(await activeCount(S)).toBe(1)
  })

  // ── SELECT-BY-ANCHORSEQ: totally ordered, EXACT BIGINT ───────────────────────────────────────────────
  test('selectCheckpointByAnchorSeq returns the latest retained checkpoint with trusted_since_seq <= anchor (exact bigint across 2^53)', async () => {
    const S = await mkSheet()
    // Two synthetic checkpoints straddling 2^53 — Number() would collapse these to one float64.
    const LO = '9007199254740992' // 2^53
    const HI = '9007199254740993' // 2^53 + 1
    await insertSyntheticCheckpoint({ id: `${S}_ck_lo`, sheetId: S, state: 'superseded', seq: LO })
    await insertSyntheticCheckpoint({ id: `${S}_ck_hi`, sheetId: S, state: 'active', seq: HI })

    const atHi = await selectCheckpointByAnchorSeq(q, S, HI)
    expect(atHi?.id).toBe(`${S}_ck_hi`)
    expect(atHi?.trustedSinceSeq).toBe(HI) // exact — not collapsed to LO

    const atLo = await selectCheckpointByAnchorSeq(q, S, LO)
    expect(atLo?.id).toBe(`${S}_ck_lo`) // HI (2^53+1) is > LO, excluded — proves the boundary is exact

    const below = await selectCheckpointByAnchorSeq(q, S, '1')
    expect(below).toBeNull()
  })

  // ── SELECT tiebreak: NEVER two candidates (deterministic id DESC) ────────────────────────────────────
  test('selectCheckpointByAnchorSeq is TOTALLY ordered: two checkpoints sharing a seq resolve deterministically by id DESC', async () => {
    const S = await mkSheet()
    const SEQ = '5000000000000'
    // Same trusted_since_seq — only the id tiebreak separates them. Expected winner = the lexicographically
    // greater id ('...zzz'). Mutation: flip the ORDER BY tiebreak id DESC → id ASC ⇒ returns '...aaa' ⇒ reds.
    await insertSyntheticCheckpoint({ id: `${S}_ck_aaa`, sheetId: S, state: 'superseded', seq: SEQ })
    await insertSyntheticCheckpoint({ id: `${S}_ck_zzz`, sheetId: S, state: 'superseded', seq: SEQ })

    const sel1 = await selectCheckpointByAnchorSeq(q, S, SEQ)
    const sel2 = await selectCheckpointByAnchorSeq(q, S, SEQ)
    expect(sel1?.id).toBe(`${S}_ck_zzz`)
    expect(sel2?.id).toBe(`${S}_ck_zzz`) // deterministic across repeated calls — never two candidates
  })

  // ── SELECT-BY-T (display path) ───────────────────────────────────────────────────────────────────────
  test('selectCheckpointByT selects the latest retained checkpoint with trusted_from_at <= T (display metadata, not the recovery authority)', async () => {
    const S = await mkSheet()
    await insertSyntheticCheckpoint({ id: `${S}_ck_old`, sheetId: S, state: 'superseded', seq: '100', trustedFromAt: '2026-02-01T00:00:00.000Z' })
    await insertSyntheticCheckpoint({ id: `${S}_ck_new`, sheetId: S, state: 'active', seq: '200', trustedFromAt: '2026-02-03T00:00:00.000Z' })

    const atMid = await selectCheckpointByT(q, S, '2026-02-02T00:00:00.000Z')
    expect(atMid?.id).toBe(`${S}_ck_old`)
    const atLater = await selectCheckpointByT(q, S, '2026-02-04T00:00:00.000Z')
    expect(atLater?.id).toBe(`${S}_ck_new`)
    const atBefore = await selectCheckpointByT(q, S, '2026-01-01T00:00:00.000Z')
    expect(atBefore).toBeNull()
  })

  // ── RETENTION FLOOR CLAMP ────────────────────────────────────────────────────────────────────────────
  test('retention prune is CLAMPED at the active-checkpoint floor: a cutoff above the floor never prunes the active checkpoint', async () => {
    const S = await mkSheet()
    const a = await activate(S) // becomes superseded after b
    const b = await activate(S) // ACTIVE — its seq is the floor
    const floor = await retentionFloorSeq(q, S)
    expect(floor).toBe(b.trustedSinceSeq)

    // Request a cutoff WAY above the floor (prune "everything up to a huge seq"). The clamp must pin it to
    // the floor so the ACTIVE checkpoint (seq == floor) survives; only the older superseded one is pruned.
    // Mutation: remove the clamp (use requestedCutoff directly) ⇒ the active checkpoint gets pruned ⇒ reds.
    const requested = (BigInt(b.trustedSinceSeq) + 1_000_000n).toString()
    const result = await poolManager.get().transaction(async ({ query }) => pruneRetainedCheckpoints(query as unknown as QueryFn, S, requested))
    expect(result.clampedCutoffSeq).toBe(b.trustedSinceSeq) // clamped down to the floor
    expect(result.prunedCount).toBe(1) // only the superseded one

    const ca = await checkpointRow(a.checkpointId)
    const cb = await checkpointRow(b.checkpointId)
    expect(cb?.pruned_at).toBeNull() // ACTIVE checkpoint survived the clamp
    expect(cb?.state).toBe('active')
    expect(ca?.pruned_at).toBeTruthy() // the older superseded checkpoint was pruned
  })

  // ── system_kind NON-FORGEABLE ────────────────────────────────────────────────────────────────────────
  test('system_kind is NON-FORGEABLE: a client-supplied system_kind on POST /sheets is ignored (persisted NULL)', async () => {
    const forgeId = `sheet_l5ck_forge_${TS}`
    const res = await request(app).post('/api/multitable/sheets').send({ id: forgeId, baseId: BASE, name: 'forge attempt', system_kind: 'people_directory' })
    expect([200, 201]).toContain(res.status)
    const row = await q('SELECT system_kind FROM meta_sheets WHERE id = $1', [forgeId])
    expect((row.rows[0] as { system_kind: unknown }).system_kind).toBeNull() // client value ignored
    await q('DELETE FROM meta_sheets WHERE id = $1', [forgeId]).catch(() => {})
  })

  test('checkpoint system_kind is DERIVED server-side from the sheet (never a caller value)', async () => {
    // A sheet whose system_kind was set only server-side (provisioning/backfill) — the activation function
    // reads it from meta_sheets; there is no caller channel to supply or override it.
    const S = await mkSheet({ systemKind: 'approval_projection' })
    const res = await activate(S)
    const ck = await checkpointRow(res.checkpointId)
    expect(ck?.system_kind).toBe('approval_projection')
  })

  // ── P3-2 ENABLEMENT PRECONDITION (real-DB checkpoint half) ───────────────────────────────────────────
  test('checkStrictEnablementPrecondition detects the active-checkpoint half against a real DB, and stays fail-closed until L6', async () => {
    const S = await mkSheet()
    // No checkpoint yet: both conditions unmet.
    const before = await checkStrictEnablementPrecondition(q, S)
    expect(before.canEnable).toBe(false)
    expect([...before.unmet].sort()).toEqual(['no_active_checkpoint', 'reconstruction_non_causal'])

    await activate(S)
    // Checkpoint half now satisfied — ONLY reconstruction remains unmet (still fail-closed: L6 not landed).
    const after = await checkStrictEnablementPrecondition(q, S)
    expect(after.canEnable).toBe(false) // GUARD stays fail-closed until L6 — must not pass
    expect(after.unmet).toEqual(['reconstruction_non_causal'])
  })
})
