/**
 * W0-1 v3.7 (owner-ratified #4331 §9, docs/development/multitable-w0-1-v37-exact-anchor-trust-design-lock-
 * 20260715.md) — the STRICT (seq-ordered, ALL-generations) chain-integrity precheck, behind
 * `MULTITABLE_HISTORY_CONTIGUITY_STRICT` (default OFF). This is a DEFAULT-OFF implementation slice: no
 * recovery flag is enabled by default, this file only toggles env vars inside its OWN test process to
 * exercise the code paths (identical convention to the pre-existing
 * `multitable-history-contiguity-realdb.test.ts`), and nothing here arms strict mode, Revert, or Reset in
 * any real environment.
 *
 * Goldens (owner rubric — v3.7 §9.3/§6, this lane's required set):
 *   FLAG-OFF PARITY                strict unset behaves BYTE-IDENTICAL to the pre-existing #4269 comparator
 *       on the exact same data (proven directly against `precheckSheetHistoryIntegrity`).
 *   GENERATION-2-LOCK-SURVIVES     a record's SECOND generation has a lock marker (via the REAL HTTP lock
 *       endpoint — exercising the "loud marker" `ON CONFLICT` removal) filling what would be a hole →
 *       passes. Proves marker attribution is per-generation, not just "current chain", and that removing the
 *       cross-generation UNIQUE constraint did not break the ordinary lock/unlock write path.
 *   TARGET-GENERATION HOLE, CLEAN TERMINAL ⇒ 409  (the owner High-2 regression this lane exists to fix): an
 *       OLDER generation has an uncaptured hole; the TERMINAL generation is completely clean. A
 *       terminal-only comparator (the superseded v3.5 shape) PASSES this; the v3.7 all-generations walk
 *       refuses. Mutation: revert `checkAllGenerationsContiguity` to only walk the terminal generation ⇒ this
 *       test reds (200 instead of 409).
 *   DUP-WITHIN-GENERATION ⇒ chain_corrupt   two content events at the same version, same generation.
 *   DELETED-GAP (C3)               a record with NO live row (chain-only + trash) whose only generation has
 *       an uncaptured hole → refuses. Positive control: a clean deleted chain does not refuse.
 *   EXACT-BIGINT > 2^53            two explicit SYNTHETIC seq values (inserted directly, NEVER via `setval`
 *       on the shared `meta_record_chain_seq` — v3.7 P2-C) that Number() collapses to the same float64 must
 *       be treated as distinct, non-colliding, correctly ordered — the chain passes. Mutation: compare seq
 *       via `Number(a) === Number(b)` (or `Number(a) - Number(b)`) instead of exact string/BigInt ⇒ reds
 *       (falsely refuses a healthy chain as `comparator_error`).
 *   ILLEGAL-SEQ FAIL-CLOSE          a directly-inserted revision with a non-positive seq (bypassing every
 *       app-level writer) refuses, never coerced to zero.
 *   FORMULA-NOT-REFUSED            a live formula-field value that differs from its stored snapshot (formula
 *       fields recompute live, never captured in a revision) does not trigger the content-projection layer.
 *   POSITIVE CONTROL               a full healthy chain reverts and executes under strict mode.
 *
 * Two-point wiring: plugin-tests.yml real-DB run list + vitest.integration.config.ts. Runs only with
 * DATABASE_URL. Fixture hygiene (P2-C): every seq value here is either the natural `DEFAULT nextval(...)`
 * (ordinary app-shaped inserts) or an EXPLICIT literal on an isolated fixture row; this file never calls
 * `setval` on the shared sequence, and `afterAll` cleans up only its own sheet/base/user rows.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { precheckSheetHistoryIntegrity, precheckSheetHistoryIntegrityStrict } from '../../src/multitable/history-integrity-precheck'
import { activateCheckpoint, type QueryFn } from '../../src/multitable/history-trust-checkpoint'
import { checkStrictEnablementPrecondition } from '../../src/multitable/history-trust-precondition'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_hcss_${TS}`
const SHEET = `sheet_hcss_${TS}`
const NAME = `fld_hcss_name_${TS}`
const FORMULA_FIELD = `fld_hcss_formula_${TS}`
const ACTOR = `user_hcss_${TS}`
// H (the shared healthy record) uses explicit, well-separated timestamps: T0=create('old'), T2=update('new').
// T1 (between them) is the default `asOf` — reverting to T1 must reconstruct H's T0 ('old') state, exactly
// like the pre-existing `multitable-history-contiguity-realdb.test.ts`'s T0/T1/T2 convention.
const T0 = '2026-02-01T00:00:00.000Z', T1 = '2026-02-02T00:00:00.000Z', T2 = '2026-02-03T00:00:00.000Z'

const HISTORY_INCOMPLETE_BODY = {
  ok: false,
  error: {
    code: 'HISTORY_INCOMPLETE',
    message: 'Record history for this sheet is incomplete or inconsistent with its live data; destructive recovery is refused and nothing was written. History must be trustworthy before revert/reset can run.',
  },
}

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
const revertPreview = (sheet: string, asOf = T1) => request(app).post(`/api/multitable/sheets/${sheet}/revert-preview`).send({ asOf })
const revertExecute = (sheet: string, previewIdentity: string, asOf = T1) => request(app).post(`/api/multitable/sheets/${sheet}/revert-execute`).send({ asOf, previewIdentity })
const lockRecord = (id: string, locked: boolean) => request(app).post(`/api/multitable/records/${id}/lock`).send({ locked })

// Ordinary insert — seq comes from the shared sequence's DEFAULT nextval(), exactly like a real app write.
// Sequential `await`s preserve true causal (seq-ascending) order among a test's own inserts. `at` is an
// OPTIONAL explicit `created_at` — irrelevant to strict (seq-ordered) verdicts, but the FLAG-OFF PARITY test
// also exercises the LEGACY (epoch/version-ordered) comparator, which needs distinct, well-separated
// timestamps (same-millisecond inserts would collapse its ordering) — mirrors the pre-existing
// `multitable-history-contiguity-realdb.test.ts`'s fixed T0/T1/T2 convention.
const rev = (sheet: string, id: string, version: number, action: string, snap: Record<string, unknown>, at?: string) =>
  q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,'rest',ARRAY[]::text[],'{}'::jsonb,$5::jsonb,COALESCE($6::timestamptz, now()))`,
    [sheet, id, version, action, JSON.stringify(snap), at ?? null])
// Explicit-seq insert (P2-C: isolated fixture row, NEVER a `setval` on the shared sequence) — for the
// production-magnitude (>2^53) and illegal-seq goldens, which need EXACT control over the literal seq value.
const revExplicitSeq = (sheet: string, id: string, version: number, action: string, snap: Record<string, unknown>, seq: string) =>
  q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, seq)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,'rest',ARRAY[]::text[],'{}'::jsonb,$5::jsonb,$6::bigint)`, [sheet, id, version, action, JSON.stringify(snap), seq])
const insertLive = (sheet: string, id: string, data: Record<string, unknown>, version: number) =>
  q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,$4)', [id, sheet, JSON.stringify(data), version])
// Ordinary marker insert — seq comes from the shared sequence's DEFAULT nextval() (same as `rev`), so a marker
// inserted BEFORE a create (sequential await) causally precedes it (lower seq) — used by the generation-0
// marker golden below. NEVER a `setval` (P2-C).
const marker = (sheet: string, id: string, version: number, kind: 'lock' | 'unlock') =>
  q('INSERT INTO meta_record_version_markers (id, sheet_id, record_id, version, kind) VALUES (gen_random_uuid(),$1,$2,$3,$4)', [sheet, id, version, kind])
const insertTrash = (sheet: string, id: string, data: Record<string, unknown>, originalVersion: number) =>
  q('INSERT INTO meta_records_trash (record_id, sheet_id, data, original_version) VALUES ($1,$2,$3::jsonb,$4)', [id, sheet, JSON.stringify(data), originalVersion])
const recordRow = async (id: string) => (await q('SELECT data, version FROM meta_records WHERE id = $1', [id])).rows[0] as { data: Record<string, unknown>; version: number } | undefined

async function sheetWriteState(sheet: string) {
  const records = (await q('SELECT id, data, version FROM meta_records WHERE sheet_id = $1 ORDER BY id', [sheet])).rows
  const revisionCount = Number(((await q('SELECT count(*)::int c FROM meta_record_revisions WHERE sheet_id = $1', [sheet])).rows[0] as { c: number }).c)
  return { records, revisionCount }
}

/**
 * Owner P2 (2026-07-16): under the wired strict-enablement gate (seam held false — owner ruling 2026-07-17),
 * EVERY strict-flag-on production request
 * refuses `strict_enablement_unmet` before the comparator runs — so the HTTP 409 alone would be a VACUOUS
 * proof of the chain-level verdict. This helper therefore asserts BOTH layers: the comparator itself (called
 * directly — the pure strict function, per the owner's prescription) returns the expected chain-level reason,
 * AND the production path refuses with the values-free unified envelope + zero writes (D-1c rule 1: the body
 * is deliberately indistinguishable from any other integrity refusal — no oracle).
 */
async function expectRevertRefusesWithZeroWrites(sheet: string, expectedReason: 'chain_hole' | 'chain_corrupt' | 'comparator_error'): Promise<void> {
  const pool = poolManager.get()
  expect(await precheckSheetHistoryIntegrityStrict(pool.query.bind(pool), sheet)).toEqual({ ok: false, reason: expectedReason })
  const before = await sheetWriteState(sheet)
  const pv = await revertPreview(sheet)
  expect(pv.status).toBe(409)
  expect(pv.body).toEqual(HISTORY_INCOMPLETE_BODY)
  const ex = await revertExecute(sheet, 'dummy-never-minted')
  expect(ex.status).toBe(409)
  expect(ex.body).toEqual(HISTORY_INCOMPLETE_BODY)
  expect(await sheetWriteState(sheet)).toEqual(before)
}

describeIfDatabase('W0-1 v3.7 STRICT history contiguity — seq-ordered, ALL generations (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: ACTOR, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:share'] }; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'HCSS Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'HCSS'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [NAME, SHEET, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FORMULA_FIELD, SHEET, 'Formula', 'formula', '{}', 2])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
  })
  afterAll(async () => {
    delete process.env.MULTITABLE_ENABLE_PIT_RESET
    delete process.env.MULTITABLE_ENABLE_SHEET_REVERT
    delete process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
    for (const t of ['meta_record_version_markers', 'meta_records_trash', 'meta_record_revisions', 'meta_records', 'meta_fields']) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })
  beforeEach(async () => {
    process.env.MULTITABLE_ENABLE_PIT_RESET = 'true'
    process.env.MULTITABLE_ENABLE_SHEET_REVERT = 'true'
    process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT = 'true' // default OFF in real deployments; this test process only
    await q('DELETE FROM meta_record_version_markers WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET])
    // H — the healthy shared record (single-generation, live v2), reused by the POSITIVE CONTROL test.
    await insertLive(SHEET, `rec_h_${TS}`, { [NAME]: 'new' }, 2)
    await rev(SHEET, `rec_h_${TS}`, 1, 'create', { [NAME]: 'old' }, T0)
    await rev(SHEET, `rec_h_${TS}`, 2, 'update', { [NAME]: 'new' }, T2)
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  // ── FLAG-OFF PARITY ──────────────────────────────────────────────────────────────────────────────────────
  test('FLAG-OFF PARITY: an older-generation hole with a clean terminal generation PASSES with strict OFF (byte-identical #4269), REFUSES with strict ON', async () => {
    const R = `rec_hcss_parity_${TS}`
    // gen1 (older): create@1, update@3 (v2 MISSING — hole), delete@3 (reuse). gen2 (terminal, live=2): create@1, update@2 (clean).
    // Explicit, well-separated timestamps: the LEGACY comparator orders by created_at — same-millisecond
    // inserts would collapse its ordering, which is not what this test is exercising.
    await rev(SHEET, R, 1, 'create', { [NAME]: 'g1-v1' }, '2026-01-01T00:00:00.000Z')
    await rev(SHEET, R, 3, 'update', { [NAME]: 'g1-v3' }, '2026-01-01T00:00:01.000Z')
    await rev(SHEET, R, 3, 'delete', { [NAME]: 'g1-v3' }, '2026-01-01T00:00:02.000Z')
    await rev(SHEET, R, 1, 'create', { [NAME]: 'g2-v1' }, '2026-01-01T00:00:03.000Z')
    await rev(SHEET, R, 2, 'update', { [NAME]: 'g2-v2' }, '2026-01-01T00:00:04.000Z')
    await insertLive(SHEET, R, { [NAME]: 'g2-v2' }, 2)

    delete process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
    const pool = poolManager.get()
    expect(await precheckSheetHistoryIntegrity(pool.query.bind(pool), SHEET)).toEqual({ ok: true }) // legacy: terminal generation only, clean

    process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT = 'true'
    // Owner P2: the gated production entry now refuses BEFORE the comparator (enablement precondition);
    // the chain-level verdict is asserted against the strict comparator directly.
    expect(await precheckSheetHistoryIntegrity(pool.query.bind(pool), SHEET)).toEqual({ ok: false, reason: 'strict_enablement_unmet' })
    expect(await precheckSheetHistoryIntegrityStrict(pool.query.bind(pool), SHEET)).toEqual({ ok: false, reason: 'chain_hole' }) // strict comparator: all generations
  })

  // ── GENERATION-2-LOCK-SURVIVES ───────────────────────────────────────────────────────────────────────────
  test('GENERATION-2-LOCK-SURVIVES: a lock marker in the SECOND generation (via the real HTTP lock endpoint) fills the hole → passes', async () => {
    const R = `rec_hcss_gen2lock_${TS}`
    // gen1: create@1, delete@1 (reuse). gen2 (terminal, live starts at 1): create@1. Explicit well-separated
    // timestamps: the flag-off HTTP leg below exercises the LEGACY (created_at-ordered) comparator, which
    // collapses same-millisecond inserts (see the `rev` helper's doc comment).
    await rev(SHEET, R, 1, 'create', { [NAME]: 'gen1' }, '2026-01-01T00:00:00.000Z')
    await rev(SHEET, R, 1, 'delete', { [NAME]: 'gen1' }, '2026-01-01T00:00:01.000Z')
    await rev(SHEET, R, 1, 'create', { [NAME]: 'gen2' }, '2026-01-01T00:00:02.000Z')
    await insertLive(SHEET, R, { [NAME]: 'gen2' }, 1)
    // Real HTTP lock: version 1→2, marker written at v2 via the (ON-CONFLICT-free) recordVersionMarker path.
    const lockRes = await lockRecord(R, true)
    expect(lockRes.status).toBe(200)
    expect((await recordRow(R))?.version).toBe(2)

    const pool = poolManager.get()
    expect(await precheckSheetHistoryIntegrityStrict(pool.query.bind(pool), SHEET)).toEqual({ ok: true })
    delete process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT // strict-on HTTP is gate-refused (see ENABLEMENT-GATE golden)
    const pv = await revertPreview(SHEET)
    expect(pv.status).toBe(200)
  })

  // ── TARGET-GENERATION HOLE, CLEAN TERMINAL (owner High-2) ────────────────────────────────────────────────
  test('TARGET-GENERATION HOLE, CLEAN TERMINAL ⇒ 409: an older-generation hole refuses even though the terminal generation is completely healthy', async () => {
    const R = `rec_hcss_targetgen_${TS}`
    await rev(SHEET, R, 1, 'create', { [NAME]: 'g1-v1' })
    await rev(SHEET, R, 3, 'update', { [NAME]: 'g1-v3' }) // v2 uncaptured — the hole
    await rev(SHEET, R, 3, 'delete', { [NAME]: 'g1-v3' })
    await rev(SHEET, R, 1, 'create', { [NAME]: 'g2-v1' })
    await rev(SHEET, R, 2, 'update', { [NAME]: 'g2-v2' }) // terminal generation — clean
    await insertLive(SHEET, R, { [NAME]: 'g2-v2' }, 2)

    await expectRevertRefusesWithZeroWrites(SHEET, 'chain_hole')
  })

  // ── GENERATION-0 HOLE (owner High-2 counterexample, #4339) ───────────────────────────────────────────────
  // Events/markers that PRECEDE the record's first captured create sit in generation 0 — which the strict
  // all-generations walk (g=1..creates) never visited before the fix, so an older generation missing its
  // create + a clean terminal generation wrongly returned {ok:true}. Live data matches the terminal
  // generation's latest snapshot in each case, so the content-projection layer does NOT fire — the ONLY reason
  // to refuse is the generation-0 hole. Mutation proof: delete `if (generation[0] === 0) return … chain_hole`
  // from checkAllGenerationsContiguity ⇒ each of these reds (revert-preview returns 200 instead of 409).
  test('GENERATION-0 (owner counterexample) ⇒ 409: an OLDER generation missing its create + a clean terminal generation refuses even though the terminal walk is healthy', async () => {
    const R = `rec_hcss_gen0_${TS}`
    // gen0 (create swept — retention/uncaptured): update@2, delete@2. gen1 (terminal, live=2): create@1, update@2 (clean).
    await rev(SHEET, R, 2, 'update', { [NAME]: 'gA-v2' })
    await rev(SHEET, R, 2, 'delete', { [NAME]: 'gA-v2' })
    await rev(SHEET, R, 1, 'create', { [NAME]: 'gB-v1' })
    await rev(SHEET, R, 2, 'update', { [NAME]: 'gB-v2' })
    await insertLive(SHEET, R, { [NAME]: 'gB-v2' }, 2) // live == terminal latest snapshot ⇒ content layer clean

    await expectRevertRefusesWithZeroWrites(SHEET, 'chain_hole')
  })

  test('GENERATION-0 (b) ⇒ 409: an UPDATE before any create refuses (chain_hole)', async () => {
    const R = `rec_hcss_gen0_update_${TS}`
    await rev(SHEET, R, 2, 'update', { [NAME]: 'orphan-v2' }) // generation 0 — no create captured yet
    await rev(SHEET, R, 1, 'create', { [NAME]: 'v1' })
    await rev(SHEET, R, 2, 'update', { [NAME]: 'v2' })
    await insertLive(SHEET, R, { [NAME]: 'v2' }, 2)

    await expectRevertRefusesWithZeroWrites(SHEET, 'chain_hole')
  })

  test('GENERATION-0 (c) ⇒ 409: a VERSION MARKER before any create refuses (chain_hole)', async () => {
    const R = `rec_hcss_gen0_marker_${TS}`
    await marker(SHEET, R, 2, 'lock') // generation 0 — a lock marker before any captured create
    await rev(SHEET, R, 1, 'create', { [NAME]: 'v1' })
    await rev(SHEET, R, 2, 'update', { [NAME]: 'v2' })
    await insertLive(SHEET, R, { [NAME]: 'v2' }, 2)

    await expectRevertRefusesWithZeroWrites(SHEET, 'chain_hole')
  })

  test('GENERATION-0 (d) ⇒ 409: a DELETE before any create refuses (chain_hole)', async () => {
    const R = `rec_hcss_gen0_delete_${TS}`
    await rev(SHEET, R, 1, 'delete', { [NAME]: 'orphan' }) // generation 0 — a delete of a swept-create generation
    await rev(SHEET, R, 1, 'create', { [NAME]: 'v1' })
    await insertLive(SHEET, R, { [NAME]: 'v1' }, 1)

    await expectRevertRefusesWithZeroWrites(SHEET, 'chain_hole')
  })

  // ── DUP-WITHIN-GENERATION ────────────────────────────────────────────────────────────────────────────────
  test('DUP-WITHIN-GENERATION ⇒ chain_corrupt: two content events at the same version, same generation, refuses', async () => {
    const R = `rec_hcss_dupgen_${TS}`
    await rev(SHEET, R, 1, 'create', { [NAME]: 'v1' })
    await rev(SHEET, R, 2, 'update', { [NAME]: 'v2-a' })
    await rev(SHEET, R, 2, 'update', { [NAME]: 'v2-b' }) // duplicate occupant at v2
    await insertLive(SHEET, R, { [NAME]: 'v2-b' }, 2)

    const pool = poolManager.get()
    expect(await precheckSheetHistoryIntegrityStrict(pool.query.bind(pool), SHEET)).toEqual({ ok: false, reason: 'chain_corrupt' })
    await expectRevertRefusesWithZeroWrites(SHEET, 'chain_corrupt')
  })

  // ── DELETED-GAP (C3) ─────────────────────────────────────────────────────────────────────────────────────
  test('DELETED-GAP (C3): a record with NO live row whose only generation has an uncaptured hole refuses; a clean deleted chain does not', async () => {
    const BAD = `rec_hcss_delgap_${TS}`
    await rev(SHEET, BAD, 1, 'create', { [NAME]: 'd1' })
    await rev(SHEET, BAD, 3, 'update', { [NAME]: 'd3' }) // v2 uncaptured — the hole
    await rev(SHEET, BAD, 3, 'delete', { [NAME]: 'd3' })
    await insertTrash(SHEET, BAD, { [NAME]: 'd3' }, 3)
    // BAD is not live (never inserted into meta_records) — enumerated via chain ∪ trash.
    await expectRevertRefusesWithZeroWrites(SHEET, 'chain_hole')

    // Positive control: replace BAD with a CLEAN deleted chain — the sheet must pass again.
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2', [SHEET, BAD])
    await q('DELETE FROM meta_records_trash WHERE sheet_id = $1 AND record_id = $2', [SHEET, BAD])
    const GOOD = `rec_hcss_delclean_${TS}`
    await rev(SHEET, GOOD, 1, 'create', { [NAME]: 'g1' })
    await rev(SHEET, GOOD, 2, 'update', { [NAME]: 'g2' })
    await rev(SHEET, GOOD, 2, 'delete', { [NAME]: 'g2' }) // clean, delete-reuse
    await insertTrash(SHEET, GOOD, { [NAME]: 'g2' }, 2)
    const pool = poolManager.get()
    expect(await precheckSheetHistoryIntegrityStrict(pool.query.bind(pool), SHEET)).toEqual({ ok: true })
    delete process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
    const pv = await revertPreview(SHEET)
    expect(pv.status).toBe(200)
  })

  // ── EXACT BIGINT > 2^53 (v3.7 §9.7 / P2-C: explicit synthetic seq, NEVER setval) ─────────────────────────
  test('EXACT-BIGINT: two synthetic seqs straddling 2^53 (Number() collapses them) remain distinct — healthy chain passes', async () => {
    const R = `rec_hcss_bigseq_${TS}`
    // 2^53 = 9007199254740992 (exact in float64); 2^53+1 = 9007199254740993 collapses to the SAME float64
    // via Number() — a naive Number()-based duplicate/order check would wrongly see these as one value.
    const TWO_POW_53 = '9007199254740992'
    const TWO_POW_53_PLUS_1 = '9007199254740993'
    expect(Number(TWO_POW_53) === Number(TWO_POW_53_PLUS_1)).toBe(true) // sanity: the collapse is real in JS
    await revExplicitSeq(SHEET, R, 1, 'create', { [NAME]: 'v1' }, TWO_POW_53)
    await revExplicitSeq(SHEET, R, 2, 'update', { [NAME]: 'v2' }, TWO_POW_53_PLUS_1)
    await insertLive(SHEET, R, { [NAME]: 'v2' }, 2)

    const pool = poolManager.get()
    expect(await precheckSheetHistoryIntegrityStrict(pool.query.bind(pool), SHEET)).toEqual({ ok: true })
    delete process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
    const pv = await revertPreview(SHEET)
    expect(pv.status).toBe(200)
  })

  // ── ILLEGAL-SEQ FAIL-CLOSE ───────────────────────────────────────────────────────────────────────────────
  test('ILLEGAL-SEQ FAIL-CLOSE: a directly-inserted revision with a non-positive seq refuses, never coerced to zero', async () => {
    const R = `rec_hcss_illegalseq_${TS}`
    await revExplicitSeq(SHEET, R, 1, 'create', { [NAME]: 'v1' }, '0') // illegal: non-positive
    await insertLive(SHEET, R, { [NAME]: 'v1' }, 1)

    const pool = poolManager.get()
    expect(await precheckSheetHistoryIntegrityStrict(pool.query.bind(pool), SHEET)).toEqual({ ok: false, reason: 'comparator_error' })
    await expectRevertRefusesWithZeroWrites(SHEET, 'comparator_error')
  })

  // ── FORMULA-NOT-REFUSED ──────────────────────────────────────────────────────────────────────────────────
  test('FORMULA-NOT-REFUSED: a live formula-field value that differs from its stored snapshot does not trigger content_mismatch', async () => {
    const R = `rec_hcss_formula_${TS}`
    await rev(SHEET, R, 1, 'create', { [NAME]: 'x', [FORMULA_FIELD]: 100 })
    // Live data has a DIFFERENT (recomputed) formula value — formula fields are excluded from the
    // content-projection layer's userFieldIds, so this must NOT refuse.
    await insertLive(SHEET, R, { [NAME]: 'x', [FORMULA_FIELD]: 999 }, 1)

    const pool = poolManager.get()
    expect(await precheckSheetHistoryIntegrityStrict(pool.query.bind(pool), SHEET)).toEqual({ ok: true })
    delete process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
    const pv = await revertPreview(SHEET)
    expect(pv.status).toBe(200)
  })

  // ── POSITIVE CONTROL ─────────────────────────────────────────────────────────────────────────────────────
  test('POSITIVE CONTROL: strict comparator passes the healthy chain; the full revert executes end-to-end (flag off — strict-on HTTP is gate-refused for this checkpoint-less sheet)', async () => {
    const pool = poolManager.get()
    expect(await precheckSheetHistoryIntegrityStrict(pool.query.bind(pool), SHEET)).toEqual({ ok: true })
    delete process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
    const pv = await revertPreview(SHEET)
    expect(pv.status).toBe(200)
    expect(pv.body?.data?.summary?.visibleRevertCount).toBe(1)
    const ex = await revertExecute(SHEET, pv.body?.data?.previewIdentity)
    expect(ex.status).toBe(200)
    const h = await recordRow(`rec_h_${TS}`)
    expect(h?.data?.[NAME]).toBe('old')
    expect(h?.version).toBe(3)
  })

  // ── STRICT-ENABLEMENT GATE (owner P2, 2026-07-16; seam HELD false, owner ruling 2026-07-17) ─────────────
  test('ENABLEMENT-GATE: strict ON — a NO-checkpoint sheet refuses fail-closed with zero writes; a checkpoint-bearing HEALTHY sheet is STILL refused (seam held false until the Revert/Reset wiring PR)', async () => {
    // The shared fixture record is HEALTHY (the strict comparator passes it), so any gate verdict below is
    // attributable ONLY to the enablement precondition, not to a chain verdict.
    const pool = poolManager.get()
    expect(await precheckSheetHistoryIntegrityStrict(pool.query.bind(pool), SHEET)).toEqual({ ok: true })

    // (a) NO active checkpoint: BOTH halves unmet (the seam is held false too). The WIRED entry returns
    // `strict_enablement_unmet`, and the production HTTP surface refuses with the unified values-free
    // envelope + zero writes (no oracle — D-1c).
    const beforeState = await sheetWriteState(SHEET)
    const preNoCkpt = await checkStrictEnablementPrecondition(pool.query.bind(pool), SHEET)
    expect(preNoCkpt.canEnable).toBe(false)
    expect([...preNoCkpt.unmet].sort()).toEqual(['no_active_checkpoint', 'reconstruction_non_causal'])
    expect(await precheckSheetHistoryIntegrity(pool.query.bind(pool), SHEET)).toEqual({ ok: false, reason: 'strict_enablement_unmet' })
    const pv1 = await revertPreview(SHEET)
    expect(pv1.status).toBe(409)
    expect(pv1.body).toEqual(HISTORY_INCOMPLETE_BODY)
    expect(await sheetWriteState(SHEET)).toEqual(beforeState)

    // (b) checkpoint-BEARING sheet: the refusal narrows to EXACTLY the held-back seam — and the WIRED entry
    // STILL refuses. This is the backstop pin at the wired layer (owner ruling 2026-07-17): even a healthy,
    // checkpoint-bearing sheet stays categorically refused until the PR that wires legacy Revert/Reset onto
    // the L8 exact-anchor apply flips `RECONSTRUCTION_CAUSALITY_LANDED`. The unmet SET changing (not just its
    // size) proves the checkpoint half is evaluated independently on this path.
    await pool.transaction(async ({ query }) => activateCheckpoint(query as unknown as QueryFn, { sheetId: SHEET }))
    const preCkpt = await checkStrictEnablementPrecondition(pool.query.bind(pool), SHEET)
    expect(preCkpt).toEqual({ canEnable: false, unmet: ['reconstruction_non_causal'] })
    expect(await precheckSheetHistoryIntegrity(pool.query.bind(pool), SHEET)).toEqual({ ok: false, reason: 'strict_enablement_unmet' })
    // The comparator itself still PASSES the healthy chain when called directly — the refusal above is the
    // gate, not a chain verdict (keeps this golden non-vacuous about WHAT refused).
    expect(await precheckSheetHistoryIntegrityStrict(pool.query.bind(pool), SHEET)).toEqual({ ok: true })
    // cleanup: remove the checkpoint rows so sibling tests see a checkpoint-free sheet.
    await q('DELETE FROM meta_history_baselines WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_history_trust_checkpoints WHERE sheet_id = $1', [SHEET]).catch(() => {})
  })
})
