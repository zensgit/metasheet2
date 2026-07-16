/**
 * W0-1 v3.5 (design lock #4262, §2/§4/C2) — the STRICT (`MULTITABLE_HISTORY_CONTIGUITY_STRICT`) seq-ordered
 * generation-aware precheck, real DB. Companion to `multitable-history-contiguity-realdb.test.ts` (the
 * landed #4269 legacy-comparator suite, which stays green — flag-off is byte-identical to it).
 *
 * DB state is constructed DIRECTLY via raw SQL against `meta_record_revisions` / `meta_record_version_markers`
 * / `meta_records_trash` (same convention this file's sibling already uses for HEALED-GAP/DELETE-REUSE) rather
 * than replayed through the write routes — this precheck is a pure read over already-committed rows, so the
 * goldens pin exact shapes rather than the writers that could produce them. The one exception is the P1-1
 * regression golden, which calls the REAL `recordVersionMarker` — the exact function whose write-time
 * behavior (loud vs. silently-swallowed) is what's actually under test there.
 *
 * The C2 golden is a CONSTRUCTED shape representing the OUTCOME a genuine concurrent-write race would leave
 * behind (seq order disagreeing with version order) — not a live two-connection blocking harness like the
 * PHANTOM-INSERT race in the sibling file. That distinction matters: C2 is a data-integrity invariant over
 * already-committed rows (this lane), not a concurrency-WINDOW fix — the shared all-writer fence that would
 * make such a window constructible/closable end-to-end (§3) is explicitly DEFERRED to a later lane (L4).
 *
 * Goldens (owner Step-4 rubric):
 *   GENERATION-2 LOCK SURVIVES   the P1-1 regression: a new generation's lock/unlock at a version the FIRST
 *       generation also marked is not silently swallowed (marker INSERT succeeds, both rows persist) →
 *       strict precheck passes. Mutation-surface companion: if the write HAD been swallowed (marker absent,
 *       simulating the old ON CONFLICT DO NOTHING), the identical shape correctly refuses.
 *   DUP-WITHIN-GENERATION        two occupants at one version in ONE generation → chain_corrupt.
 *   C3 DELETED-GAP               a mid-generation gap in a DELETED/trashed record's terminal generation →
 *       strict 409 — paired with the flag-off parity leg (identical rows, flag off → 200: #4269 never
 *       enumerated non-live records at all, so this is invisible to it, not "healed").
 *   DELETE→RESTORE→DELETE        a CLEAN multi-generation deleted chain is not false-refused by C3 (positive
 *       control for the enumeration itself).
 *   C2 TIME-REVERSAL             seq/version disagreement within a generation → nonmonotonic_history, paired
 *       with flag-off parity on the SAME rows (the legacy structural comparator's version-tiebreak-within-
 *       same-epoch ordering happens to reconstruct this specific shape as contiguous — a genuine "the old
 *       comparator could not see this corruption" demonstration, not a coincidence of casing).
 *   FORMULA-NOT-REFUSED          a formula-sheet healthy record passes strict mode (derived-field content
 *       exclusion is unaffected by the new comparator).
 *   POSITIVE CONTROL             a full healthy multi-event chain (create/update/lock/unlock) passes.
 *
 * Two-point wiring: excluded from the no-DB default config (vitest.config.ts) + whitelisted in
 * plugin-tests.yml's real-DB run list, alongside its sibling files. Runs only with DATABASE_URL.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { precheckSheetHistoryIntegrity } from '../../src/multitable/history-integrity-precheck'
import { recordVersionMarker } from '../../src/multitable/record-history-service'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_hcss_${TS}`
const SHEET = `sheet_hcss_${TS}`
const SHEET_F = `sheet_hcss_formula_${TS}`
const NAME = `fld_hcss_name_${TS}`
const FNAME = `fld_hcss_fname_${TS}`, FORMULA = `fld_hcss_formula_${TS}`

const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-01-02T00:00:00.000Z'
const T2 = '2026-01-03T00:00:00.000Z'
const T3 = '2026-01-04T00:00:00.000Z'

// QueryFn-shaped directly (params optional) so this same `q` doubles as the precheck/recordVersionMarker arg.
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const setStrict = (on: boolean): void => {
  if (on) process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT = 'true'
  else delete process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
}

/** Revision row with an EXPLICIT seq (bypassing the shared sequence's default) — deterministic causal order. */
const revSeq = (sheet: string, id: string, version: number, action: string, snap: Record<string, unknown>, at: string, seq: number) =>
  q(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at, seq)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,'rest',ARRAY[]::text[],'{}'::jsonb,$5::jsonb,$6,$7)`,
    [sheet, id, version, action, JSON.stringify(snap), at, seq],
  )
/** Marker row with an EXPLICIT seq — same causal-order control as `revSeq`. */
const markerSeq = (sheet: string, id: string, version: number, kind: 'lock' | 'unlock', at: string, seq: number) =>
  q(
    `INSERT INTO meta_record_version_markers (id, sheet_id, record_id, version, kind, created_at, seq)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)`,
    [sheet, id, version, kind, at, seq],
  )
const insertLive = (sheet: string, id: string, data: Record<string, unknown>, version: number) =>
  q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,$4)', [id, sheet, JSON.stringify(data), version])
const insertTrash = (sheet: string, id: string, data: Record<string, unknown>, version: number, at: string) =>
  q(
    `INSERT INTO meta_records_trash (record_id, sheet_id, data, original_version, deleted_at) VALUES ($1,$2,$3::jsonb,$4,$5)`,
    [id, sheet, JSON.stringify(data), version, at],
  )
const markerRowCount = async (sheet: string, id: string, version: number): Promise<number> =>
  Number(((await q('SELECT count(*)::int c FROM meta_record_version_markers WHERE sheet_id=$1 AND record_id=$2 AND version=$3', [sheet, id, version])).rows[0] as { c: number }).c)

/**
 * A fresh value from the REAL shared `meta_record_chain_seq` sequence — used instead of hardcoded integer
 * literals so every manually-constructed event is guaranteed to sort BEFORE any subsequent REAL write in the
 * same test (e.g. `recordVersionMarker`'s own `DEFAULT nextval(...)`, which draws from this exact sequence).
 * A fixed literal would be wrong whenever it happened to be smaller than the sequence's already-advanced
 * current value (this bit a first draft of this file: literal 100001 sorted BEFORE a real nextval() draw of
 * ~460, inverting the intended causal order).
 */
const nextSeq = async (): Promise<number> =>
  Number(((await q("SELECT nextval('meta_record_chain_seq') AS v")).rows[0] as { v: string }).v)

describeIfDatabase('W0-1 v3.5 strict (seq-ordered) generation-aware contiguity — C2/C3 (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'HCSS Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3),($4,$2,$5)', [SHEET, BASE, 'HCSS Plain', SHEET_F, 'HCSS Formula'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [NAME, SHEET, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FNAME, SHEET_F, 'FName', 'string', '{}', 1])
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FORMULA, SHEET_F, 'Computed', 'formula', JSON.stringify({ expression: `{${FNAME}}` }), 2],
    )
  })
  afterAll(async () => {
    for (const sheet of [SHEET, SHEET_F]) {
      for (const t of ['meta_record_version_markers', 'meta_records_trash', 'meta_record_revisions', 'meta_records', 'meta_fields']) {
        await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [sheet]).catch(() => {})
      }
      await q('DELETE FROM meta_sheets WHERE id = $1', [sheet]).catch(() => {})
    }
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })
  beforeEach(async () => {
    for (const sheet of [SHEET, SHEET_F]) {
      await q('DELETE FROM meta_record_version_markers WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheet])
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheet])
    }
  })
  afterEach(() => setStrict(false))

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  // ── GENERATION-2 LOCK SURVIVES (P1-1 regression) ────────────────────────────────────────────────────────
  test("GENERATION-2 LOCK SURVIVES: a new generation's lock at a version the FIRST generation also marked is NOT swallowed — strict precheck passes", async () => {
    const R = `rec_g2_${TS}`
    // gen1: create@1, lock marker@2, delete@2 (reuse).
    await revSeq(SHEET, R, 1, 'create', { [NAME]: 'gen1' }, T0, await nextSeq())
    await markerSeq(SHEET, R, 2, 'lock', T0, await nextSeq())
    await revSeq(SHEET, R, 2, 'delete', { [NAME]: 'gen1' }, T1, await nextSeq())
    // gen2 (restore): create@1 — SAME record id, version reset to 1 (design lock §2's exact scenario).
    await revSeq(SHEET, R, 1, 'create', { [NAME]: 'gen2' }, T2, await nextSeq())
    await insertLive(SHEET, R, { [NAME]: 'gen2' }, 1)
    // gen2's lock at version 2 — the SAME (sheet_id, record_id, version) triple gen1's marker occupies. The
    // real write path (loud INSERT, no ON CONFLICT, DEFAULT nextval() seq) must NOT throw and must NOT
    // swallow — and because it draws from the SAME shared sequence as `nextSeq()` above, it is guaranteed to
    // sort AFTER every manually-constructed event, exactly like a real write would.
    await expect(recordVersionMarker(q, { sheetId: SHEET, recordId: R, version: 2, kind: 'lock' })).resolves.toBeUndefined()
    await q('UPDATE meta_records SET version = 2 WHERE id = $1', [R])
    expect(await markerRowCount(SHEET, R, 2)).toBe(2) // one row per generation — genuinely both persisted
    setStrict(true)
    expect(await precheckSheetHistoryIntegrity(q, SHEET)).toEqual({ ok: true })
  })

  test('GENERATION-2 LOCK mutation surface: if the write HAD been silently swallowed (marker absent), the identical shape correctly refuses', async () => {
    // Simulates exactly what the OLD `ON CONFLICT ... DO NOTHING` would have produced: the version bump
    // happens (meta_records.version = 2) but gen2's marker row was never written.
    const R = `rec_g2mut_${TS}`
    await revSeq(SHEET, R, 1, 'create', { [NAME]: 'gen1' }, T0, await nextSeq())
    await markerSeq(SHEET, R, 2, 'lock', T0, await nextSeq())
    await revSeq(SHEET, R, 2, 'delete', { [NAME]: 'gen1' }, T1, await nextSeq())
    await revSeq(SHEET, R, 1, 'create', { [NAME]: 'gen2' }, T2, await nextSeq())
    await insertLive(SHEET, R, { [NAME]: 'gen2' }, 2) // version bumped, but NO gen2 marker@2 written
    setStrict(true)
    expect(await precheckSheetHistoryIntegrity(q, SHEET)).toEqual({ ok: false, reason: 'chain_hole' })
  })

  // ── DUP-WITHIN-GENERATION ────────────────────────────────────────────────────────────────────────────────
  test('DUP-WITHIN-GENERATION: a marker and a revision occupying the SAME version in ONE generation → chain_corrupt', async () => {
    const R = `rec_dupgen_${TS}`
    await revSeq(SHEET, R, 1, 'create', { [NAME]: 'a' }, T0, await nextSeq())
    await revSeq(SHEET, R, 2, 'update', { [NAME]: 'b' }, T1, await nextSeq())
    await markerSeq(SHEET, R, 2, 'lock', T1, await nextSeq()) // SAME generation, SAME version as the update above
    await insertLive(SHEET, R, { [NAME]: 'b' }, 2)
    setStrict(true)
    expect(await precheckSheetHistoryIntegrity(q, SHEET)).toEqual({ ok: false, reason: 'chain_corrupt' })
  })

  // ── C3 DELETED-GAP (+ flag-off parity) ───────────────────────────────────────────────────────────────────
  test('C3 DELETED-GAP: a mid-generation gap in a DELETED/trashed record — strict 409', async () => {
    const R = `rec_c3gap_${TS}`
    // R: create@1, then update@3 (v2 MISSING — a hole), then delete@3 (reuse). R is NOT live.
    await revSeq(SHEET, R, 1, 'create', { [NAME]: 'x1' }, T0, await nextSeq())
    await revSeq(SHEET, R, 3, 'update', { [NAME]: 'x3' }, T1, await nextSeq())
    await revSeq(SHEET, R, 3, 'delete', { [NAME]: 'x3' }, T2, await nextSeq())
    await insertTrash(SHEET, R, { [NAME]: 'x3' }, 3, T2)
    const H = `rec_c3h_${TS}` // a healthy LIVE sibling — the sheet is not otherwise empty
    await revSeq(SHEET, H, 1, 'create', { [NAME]: 'healthy' }, T0, await nextSeq())
    await insertLive(SHEET, H, { [NAME]: 'healthy' }, 1)
    setStrict(true)
    expect(await precheckSheetHistoryIntegrity(q, SHEET)).toEqual({ ok: false, reason: 'chain_hole' })
  })

  test('C3 DELETED-GAP flag-off PARITY: the IDENTICAL rows pass (200) with the flag off — #4269 never enumerated non-live records', async () => {
    const R = `rec_c3gapoff_${TS}`
    await revSeq(SHEET, R, 1, 'create', { [NAME]: 'x1' }, T0, await nextSeq())
    await revSeq(SHEET, R, 3, 'update', { [NAME]: 'x3' }, T1, await nextSeq())
    await revSeq(SHEET, R, 3, 'delete', { [NAME]: 'x3' }, T2, await nextSeq())
    await insertTrash(SHEET, R, { [NAME]: 'x3' }, 3, T2)
    const H = `rec_c3hoff_${TS}`
    await revSeq(SHEET, H, 1, 'create', { [NAME]: 'healthy' }, T0, await nextSeq())
    await insertLive(SHEET, H, { [NAME]: 'healthy' }, 1)
    setStrict(false)
    expect(await precheckSheetHistoryIntegrity(q, SHEET)).toEqual({ ok: true })
  })

  // ── DELETE→RESTORE→DELETE (positive control for C3 enumeration) ────────────────────────────────────────
  test('DELETE→RESTORE→DELETE passes: a CLEAN multi-generation deleted chain is not false-refused by C3', async () => {
    const R = `rec_drd_${TS}`
    // gen1: create@1, delete@1 (reuse).
    await revSeq(SHEET, R, 1, 'create', { [NAME]: 'g1' }, T0, await nextSeq())
    await revSeq(SHEET, R, 1, 'delete', { [NAME]: 'g1' }, T1, await nextSeq())
    // gen2 (restore): create@1, delete@1 (reuse) — terminal generation, clean, no gap.
    await revSeq(SHEET, R, 1, 'create', { [NAME]: 'g2' }, T2, await nextSeq())
    await revSeq(SHEET, R, 1, 'delete', { [NAME]: 'g2' }, T3, await nextSeq())
    await insertTrash(SHEET, R, { [NAME]: 'g2' }, 1, T3)
    const H = `rec_drdh_${TS}`
    await revSeq(SHEET, H, 1, 'create', { [NAME]: 'healthy' }, T0, await nextSeq())
    await insertLive(SHEET, H, { [NAME]: 'healthy' }, 1)
    setStrict(true)
    expect(await precheckSheetHistoryIntegrity(q, SHEET)).toEqual({ ok: true })
  })

  // ── C2 TIME-REVERSAL (constructed, + flag-off parity on the SAME rows) ─────────────────────────────────
  test('C2 TIME-REVERSAL (constructed): seq order disagrees with version order within a generation → nonmonotonic_history; the SAME rows pass under the legacy (flag-off) comparator', async () => {
    const R = `rec_c2race_${TS}`
    // Represents the OUTCOME a genuine concurrent-write race would leave: the writer whose revision INSERT
    // executed FIRST (lower seq) recorded the HIGHER version (3); the writer whose INSERT executed SECOND
    // (higher seq) recorded the LOWER version (2). Versions {1,2,3} are each occupied exactly once (no hole,
    // no duplicate) — only a TRUE seq-vs-version order check catches this as corruption.
    await revSeq(SHEET, R, 1, 'create', { [NAME]: 'v1' }, T0, await nextSeq())
    await revSeq(SHEET, R, 3, 'update', { [NAME]: 'v3-out-of-order' }, T1, await nextSeq())
    await revSeq(SHEET, R, 2, 'update', { [NAME]: 'v2-out-of-order' }, T1, await nextSeq()) // SAME epoch T1 as the row above
    // Live data matches whichever snapshot the LEGACY comparator's own bookkeeping treats as "latest" (its
    // structural tiebreak at equal epoch is version, so it picks update@3 as latest — see the flag-off leg
    // below) — this keeps the content-projection layer a non-issue for BOTH legs, isolating contiguity/C2.
    await insertLive(SHEET, R, { [NAME]: 'v3-out-of-order' }, 3)

    setStrict(true)
    expect(await precheckSheetHistoryIntegrity(q, SHEET)).toEqual({ ok: false, reason: 'nonmonotonic_history' })

    // FLAG-OFF PARITY, same rows: the legacy structural comparator orders by (epoch, version, delete-last) —
    // at the SAME epoch (T1) its tiebreak is VERSION, so it reconstructs update@2 BEFORE update@3 regardless
    // of insertion/seq order, sees a perfectly contiguous {1,2,3}, and PASSES. This is not a coincidence of
    // casing: it is precisely the class of corruption #4269's comparator cannot see, which is why C2 is
    // fail-closed only under the strict flag (the design lock's C2 fix target).
    setStrict(false)
    expect(await precheckSheetHistoryIntegrity(q, SHEET)).toEqual({ ok: true })
  })

  // ── FORMULA-NOT-REFUSED ──────────────────────────────────────────────────────────────────────────────────
  test('FORMULA-NOT-REFUSED (strict): a formula-sheet healthy record — materialized derived key absent from its snapshot — passes', async () => {
    const R = `rec_formula_${TS}`
    // The record-service create shape: the in-txn snapshot is the user patch (no formula key); the formula
    // materializes into live `data` post-commit. Content-projection excludes derived fields; contiguity must
    // not be fooled by the missing key either.
    await revSeq(SHEET_F, R, 1, 'create', { [FNAME]: 'alice' }, T0, await nextSeq())
    await insertLive(SHEET_F, R, { [FNAME]: 'alice', [FORMULA]: 'ALICE-COMPUTED' }, 1)
    setStrict(true)
    expect(await precheckSheetHistoryIntegrity(q, SHEET_F)).toEqual({ ok: true })
  })

  // ── POSITIVE CONTROL ─────────────────────────────────────────────────────────────────────────────────────
  test('POSITIVE CONTROL (strict): a full healthy chain — create, update, lock, unlock — passes', async () => {
    const R = `rec_pos_${TS}`
    await revSeq(SHEET, R, 1, 'create', { [NAME]: 'a' }, T0, await nextSeq())
    await revSeq(SHEET, R, 2, 'update', { [NAME]: 'b' }, T1, await nextSeq())
    await markerSeq(SHEET, R, 3, 'lock', T1, await nextSeq())
    await markerSeq(SHEET, R, 4, 'unlock', T2, await nextSeq())
    await insertLive(SHEET, R, { [NAME]: 'b' }, 4)
    setStrict(true)
    expect(await precheckSheetHistoryIntegrity(q, SHEET)).toEqual({ ok: true })
  })
})
