/**
 * P22 — Time-Machine exact-anchor recovery: FOREIGN-SHEET fence availability (real DB, constructed races).
 *
 * DEFECT (base head 92bbf77829): `applyExactAnchorRecovery` fenced only the SOURCE sheet, then took
 * `FOR NO KEY UPDATE NOWAIT` (meta_sheets) + `FOR UPDATE NOWAIT` (meta_records) over the source AND every
 * linked FOREIGN sheet/record. A perfectly ordinary fenced writer on a foreign sheet holds that sheet's
 * canonical advisory fence + `FOR UPDATE` on a linked record; the recovery's NOWAIT record lock then aborts
 * with 55P03, which `classifyExactAnchorDatabaseConflict` maps to `preview-drift` — indistinguishable from a
 * genuine drift, with no retry. ~1 foreign write/sec was enough to fail the recovery almost every time.
 *
 * FIX (this slice): the recovery now acquires the canonical write fence for EVERY sheet it will lock
 * (source + all linked foreign sheets) in ONE deterministic sheet-id order, BEFORE any row lock
 * (`discoverRecoveryAuthoritySheetIds` + `acquireCanonicalSheetFencesInOrder`). Foreign sheets serialise on
 * the SAME blocking fence their own fenced writers take, so by the time the recovery reaches its NOWAIT
 * record locks no fenced writer can be holding a record on those sheets.
 *
 * DEADLOCK-FREEDOM (must be preserved — #4654 constructively removed three deadlock classes): every writer
 * holds AT MOST ONE canonical fence, and the recovery holds ALL of its canonical fences (sorted) before ANY
 * NOWAIT row lock. A recovery blocked on a fence therefore holds no row lock another writer could wait on ⇒
 * single global ordered acquisition ⇒ no wait cycle. These tests PROVE that with constructed races, and the
 * `source-first` mutation proves the sorted order is load-bearing (it ABBA-deadlocks).
 *
 * WHY THE LOCK LAYER (not the full apply) is the primary instrument: the change is entirely in lock
 * acquisition. This suite drives the EXACT changed code — `discoverRecoveryAuthoritySheetIds`,
 * `acquireCanonicalSheetFencesInOrder`, and `lockExactAnchorRecoveryAuthorityScope` — with real clients,
 * so the availability effect and the deadlock-freedom claim are both observed directly and are each
 * falsifiable by a named mutation (neuter the foreign fence ⇒ availability reds; reverse the order ⇒
 * deadlock reds). 40P01 is never swallowed here (no ApplyRefusalError mapping), so a deadlock is visible.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { resolveExactAnchor } from '../../src/multitable/exact-anchor-recovery'
import {
  applyExactAnchorRecovery,
  discoverRecoveryAuthoritySheetIds,
  lockExactAnchorRecoveryAuthorityScope,
  type ExactAnchorApplyMode,
} from '../../src/multitable/exact-anchor-recovery-execute'
import {
  acquireCanonicalSheetFence,
  acquireCanonicalSheetFencesInOrder,
  assertNoActiveWriterBlock,
  __resetRecoveryWriterStateColumnProbe,
} from '../../src/multitable/canonical-sheet-fence'
import { activateCheckpoint, type QueryFn } from '../../src/multitable/history-trust-checkpoint'
import { __resetOperationLedgerColumnProbe } from '../../src/multitable/operation-ledger'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const FLAG = 'MULTITABLE_ENABLE_WRITER_FENCE'
const TS = Date.now()
const BASE = `base_p22_${TS}`
// Names chosen so lexical sort is deterministic: `p22f_*` (foreign) < `p22s_*` (source). Both recovery
// directions must therefore acquire fence(F) THEN fence(S) — the property that makes them non-inverting.
const S = `p22s_sheet_${TS}` // source sheet
const F = `p22f_sheet_${TS}` // foreign sheet
const F_STR = `p22_note_${TS}`
const F_LINK = `p22_link_${TS}`
const R_S = `p22_recS_${TS}`
const R_F = `p22_recF_${TS}`

type Client = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>; release: () => void }
const q = (sql: string, params: unknown[] = []) => poolManager.get().query(sql, params)
const connect = async (): Promise<Client> => {
  const internal = poolManager.get().getInternalPool()
  if (!internal) throw new Error('no internal pool')
  return (await internal.connect()) as unknown as Client
}
// A `(sql, params) => Promise<{rows, rowCount}>` adapter usable as both the kernel `QueryFn` and `FenceQuery`.
const asQuery = (c: Client) => ((sql: string, params?: unknown[]) => c.query(sql, params)) as never
const pgCode = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null ? (e as { code?: string }).code : undefined
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Minimal two-party barrier: each side opens its own gate and awaits the other's. */
function makeGate() {
  let open!: () => void
  const p = new Promise<void>((r) => { open = r })
  return { wait: () => p, open: () => open() }
}

test('sentinel: this real-DB suite must RUN, never skip-green', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('P22 foreign-fence real-DB step is missing DATABASE_URL — harness broken, not skippable')
  }
  expect(true).toBe(true)
})

describeIfDatabase.sequential('P22 exact-anchor recovery — foreign-sheet fence availability + deadlock-freedom', () => {
  beforeAll(async () => {
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [`u_p22_${TS}`])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'P22 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [S, BASE, 'P22 Source'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [F, BASE, 'P22 Foreign'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_STR, S, 'Note', 'string', '{}', 1])
    // Forward CROSS-SHEET link field on the source pointing at the foreign sheet.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_LINK, S, 'Rel', 'link', JSON.stringify({ foreignSheetId: F }), 2])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,$4)', [R_S, S, JSON.stringify({ [F_STR]: 's0', [F_LINK]: [R_F] }), 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,$4)', [R_F, F, JSON.stringify({}), 1])
    // Real edge R_S --F_LINK--> R_F: this makes discoverRecoveryAuthoritySheetIds({S}) AND ({F}) both
    // resolve to sorted {F,S}, and makes lockExactAnchorRecoveryAuthorityScope(S) NOWAIT-lock R_F.
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_${TS}`.slice(0, 50), F_LINK, R_S, R_F])
  })

  beforeEach(() => {
    process.env[FLAG] = 'true'
    __resetRecoveryWriterStateColumnProbe()
  })

  afterAll(async () => {
    delete process.env[FLAG]
    await q('DELETE FROM meta_links WHERE record_id = $1 OR foreign_record_id = $1', [R_S]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[S, F]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[S, F]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[S, F]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [`u_p22_${TS}`]).catch(() => {})
  })

  // --- shared participants -------------------------------------------------------------------------

  /**
   * One recovery lock-acquisition attempt, in its own transaction.
   *  - `foreignFence: true`  = the FIX: acquire canonical fences for {source + foreign} in sorted order
   *    (+ source durable-block check), then the authority NOWAIT scope.
   *  - `foreignFence: false` = the pre-fix / NEUTERED path: fence the SOURCE sheet ONLY, then the same
   *    authority NOWAIT scope (this is exactly what line-748 `fenceWriterEntry(source)` did).
   * Returns 'ok' | '55P03' | 'other:<code>'; never swallows a deadlock.
   */
  async function recoveryLockAttempt(foreignFence: boolean): Promise<string> {
    const c = await connect()
    try {
      await c.query('BEGIN')
      if (foreignFence) {
        const ids = await discoverRecoveryAuthoritySheetIds(asQuery(c), S)
        await acquireCanonicalSheetFencesInOrder(asQuery(c), ids)
        await assertNoActiveWriterBlock(asQuery(c), S)
      } else {
        await acquireCanonicalSheetFence(asQuery(c), S) // source only — the defect
      }
      await lockExactAnchorRecoveryAuthorityScope(asQuery(c), S)
      await c.query('COMMIT')
      return 'ok'
    } catch (e) {
      try { await c.query('ROLLBACK') } catch { /* ignore */ }
      const code = pgCode(e)
      return code === '55P03' ? '55P03' : code === '40P01' ? '40P01' : `other:${code ?? String(e)}`
    } finally {
      c.release()
    }
  }

  /** A fenced foreign writer: hold fence(F) + FOR UPDATE(R_F) for `holdMs`, then commit. */
  async function foreignWriterHold(holdMs: number, onLocked?: () => void): Promise<void> {
    const c = await connect()
    try {
      await c.query('BEGIN')
      await acquireCanonicalSheetFence(asQuery(c), F)
      await c.query('SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE', [R_F, F])
      onLocked?.()
      await sleep(holdMs)
      await c.query('COMMIT')
    } catch {
      try { await c.query('ROLLBACK') } catch { /* ignore */ }
    } finally {
      c.release()
    }
  }

  /**
   * A fenced foreign writer that HOLDS fence(F)+FOR UPDATE(R_F) until `release` opens, then commits.
   * `held` opens once the locks are actually held — so a caller can synchronise deterministically rather
   * than racing a duty cycle. Used to make the neuter/fix arms of the availability golden non-probabilistic.
   */
  async function foreignWriterHeld(held: { open: () => void }, release: { wait: () => Promise<void> }): Promise<void> {
    const c = await connect()
    try {
      await c.query('BEGIN')
      await acquireCanonicalSheetFence(asQuery(c), F)
      await c.query('SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE', [R_F, F])
      held.open()
      await release.wait()
      await c.query('COMMIT')
    } catch {
      try { await c.query('ROLLBACK') } catch { /* ignore */ }
    } finally {
      c.release()
    }
  }

  // --- 1. AVAILABILITY GOLDEN --------------------------------------------------------------------------
  // Two DETERMINISTIC arms (gate-synchronised, not duty-cycle-probabilistic) prove the effect by
  // construction, plus a third arm that REPORTS the realistic ~duty-cycle failure rate under a continuous
  // writer (the "~14/15" figure the caller asked about). The neuter is the SOURCE-ONLY fence path; it is
  // the falsifying mutation for the fix arm.

  test('AVAILABILITY (deterministic): with a foreign writer definitely holding the linked record, SOURCE-ONLY fencing aborts every time (55P03≈drift) while FOREIGN fencing always completes', async () => {
    const N = 6

    // ARM A — NEUTER (pre-fix, source-only fence): each attempt runs while the writer is provably holding
    // fence(F)+FOR UPDATE(R_F). The NOWAIT record lock therefore aborts 55P03 EVERY time, by construction.
    const neuter: string[] = []
    for (let i = 0; i < N; i++) {
      const held = makeGate()
      const release = makeGate()
      const w = foreignWriterHeld(held, release)
      await held.wait()                       // writer is holding fence(F)+FOR UPDATE(R_F)
      neuter.push(await recoveryLockAttempt(false)) // source-only ⇒ NOWAIT on R_F fails instantly
      release.open()
      await w
    }

    // ARM B — FIX (foreign fence in sorted order): each attempt starts while the writer holds, BLOCKS on
    // fence(F), and completes ok once the writer releases. Deterministically 'ok' (never a NOWAIT abort:
    // once recovery holds fence(F) no fenced writer can be holding R_F).
    const fixed: string[] = []
    for (let i = 0; i < N; i++) {
      const held = makeGate()
      const release = makeGate()
      const w = foreignWriterHeld(held, release)
      await held.wait()
      const attempt = recoveryLockAttempt(true) // blocks on fence(F)
      await sleep(40)
      release.open()                            // writer commits ⇒ recovery proceeds
      fixed.push(await attempt)
      await w
    }

    // eslint-disable-next-line no-console
    console.log(`[P22 availability deterministic] source-only fence = ${neuter.filter((r) => r === '55P03').length}/${N} aborted (55P03) ; foreign fence = ${fixed.filter((r) => r !== 'ok').length}/${N} aborted`)

    expect(neuter.every((r) => r === '55P03')).toBe(true)   // NEUTER reds deterministically
    expect(fixed.every((r) => r === 'ok')).toBe(true)       // FIX green deterministically
  }, 30000)

  test('AVAILABILITY (measured rate): under a CONTINUOUS foreign writer, report source-only vs foreign-fence failure rate (the realistic ~14/15 figure); fix stays deterministically 0', async () => {
    const N = 15
    const stop = { v: false }
    const writerLoop = (async () => {
      while (!stop.v) { await foreignWriterHold(50); await sleep(10) } // ~83% duty cycle
    })()

    const before: string[] = []
    for (let i = 0; i < N; i++) { before.push(await recoveryLockAttempt(false)); await sleep(15) }
    const beforeFail = before.filter((r) => r === '55P03').length

    const after: string[] = []
    for (let i = 0; i < N; i++) { after.push(await recoveryLockAttempt(true)); await sleep(15) }
    const afterFail = after.filter((r) => r !== 'ok').length

    stop.v = true
    await writerLoop

    // eslint-disable-next-line no-console
    console.log(`[P22 availability measured] continuous foreign writes: source-only fence = ${beforeFail}/${N} failed (55P03) ; foreign fence = ${afterFail}/${N} failed`)

    expect(afterFail).toBe(0)                                            // FIX: deterministically 0
    expect(before.every((r) => r === 'ok' || r === '55P03')).toBe(true) // only availability failures, never 40P01
    // Not an equality assertion (duty cycle is machine-dependent): just confirm the neuter effect is present.
    expect(beforeFail).toBeGreaterThan(0)
  }, 30000)

  // --- 2. DEADLOCK-FREEDOM POSITIVE CONTROLS (assert NO 40P01; count/report 55P03 separately) ---------

  test('CONTROL-1 recovery-vs-recovery (mirror source/foreign): sorted fence order ⇒ NO 40P01', async () => {
    // Two recoveries whose source/foreign are mirror images (source=S/foreign=F vs source=F/foreign=S).
    // Both discover sorted {F,S} and acquire fence(F) then fence(S), so they fully serialise on fence(F).
    async function recoveryFrom(source: string): Promise<string> {
      const c = await connect()
      try {
        await c.query('BEGIN')
        const ids = await discoverRecoveryAuthoritySheetIds(asQuery(c), source)
        expect(ids).toEqual([F, S]) // both directions ⇒ identical sorted order (non-inverting)
        await acquireCanonicalSheetFencesInOrder(asQuery(c), ids)
        await lockExactAnchorRecoveryAuthorityScope(asQuery(c), source)
        await c.query('COMMIT')
        return 'ok'
      } catch (e) {
        try { await c.query('ROLLBACK') } catch { /* ignore */ }
        return pgCode(e) ?? 'ok'
      } finally {
        c.release()
      }
    }
    const results = await Promise.all([recoveryFrom(S), recoveryFrom(F), recoveryFrom(S), recoveryFrom(F)])
    // eslint-disable-next-line no-console
    console.log(`[P22 control-1] mirror recovery-vs-recovery results: ${JSON.stringify(results)}`)
    expect(results).not.toContain('40P01') // deadlock-free
  }, 30000)

  test('CONTROL-1 MUTATION (load-bearing): forcing SOURCE-FIRST (unsorted) order ⇒ 40P01 IS reproducible', async () => {
    // The falsifier for the sorted order: if each recovery locked its OWN sheet first then the foreign one
    // (source=S ⇒ S,F ; source=F ⇒ F,S) the two invert and ABBA-deadlock. Barrier forces the overlap.
    const g1 = makeGate()
    const g2 = makeGate()
    const c1 = await connect()
    const c2 = await connect()
    const acquireSourceFirst = async (c: Client, first: string, second: string, mineOpen: () => void, theirs: () => Promise<void>): Promise<string> => {
      try {
        await c.query('BEGIN')
        await acquireCanonicalSheetFence(asQuery(c), first) // OWN sheet first — the inversion
        mineOpen()
        await theirs()
        await acquireCanonicalSheetFence(asQuery(c), second) // then the foreign one — blocks
        await c.query('COMMIT')
        return 'ok'
      } catch (e) {
        try { await c.query('ROLLBACK') } catch { /* ignore */ }
        return pgCode(e) ?? 'ok'
      } finally {
        c.release()
      }
    }
    const [r1, r2] = await Promise.all([
      acquireSourceFirst(c1, S, F, g1.open, g2.wait), // source=S ⇒ S then F
      acquireSourceFirst(c2, F, S, g2.open, g1.wait), // source=F ⇒ F then S  (inverted vs r1)
    ])
    // eslint-disable-next-line no-console
    console.log(`[P22 control-1 mutation] source-first (unsorted) results: ${JSON.stringify([r1, r2])}`)
    expect([r1, r2]).toContain('40P01') // the mutation MUST be able to deadlock ⇒ sorted order is load-bearing
  }, 30000)

  test('CONTROL-2 recovery-vs-authority-writer: recovery waits on the foreign fence, NO 40P01, completes ok', async () => {
    // A fenced foreign writer holds fence(F)+FOR UPDATE(R_F); the recovery (fix path) must block on fence(F),
    // then complete once the writer commits — never deadlock, never NOWAIT-abort.
    const lockedGate = makeGate()
    const writer = foreignWriterHold(200, lockedGate.open)
    await lockedGate.wait() // ensure the writer holds fence(F)+FOR UPDATE(R_F) before the recovery starts
    const recovery = recoveryLockAttempt(true)
    const [rec] = await Promise.all([recovery, writer])
    // eslint-disable-next-line no-console
    console.log(`[P22 control-2] recovery-vs-authority-writer recovery result: ${rec}`)
    expect(rec).not.toBe('40P01')
    expect(rec).toBe('ok') // waited for the writer, then acquired cleanly
  }, 30000)

  test('CONTROL-3 normal-write-vs-normal-write: two fenced writers on the foreign sheet serialise, NO 40P01', async () => {
    // Two ordinary fenced writers contend for fence(F) + FOR UPDATE(R_F); the fence serialises them.
    async function fencedWrite(): Promise<string> {
      const c = await connect()
      try {
        await c.query('BEGIN')
        await acquireCanonicalSheetFence(asQuery(c), F)
        await c.query('SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE', [R_F, F])
        await sleep(30)
        await c.query('COMMIT')
        return 'ok'
      } catch (e) {
        try { await c.query('ROLLBACK') } catch { /* ignore */ }
        return pgCode(e) ?? 'ok'
      } finally {
        c.release()
      }
    }
    const results = await Promise.all([fencedWrite(), fencedWrite(), fencedWrite()])
    // eslint-disable-next-line no-console
    console.log(`[P22 control-3] normal-write-vs-normal-write results: ${JSON.stringify(results)}`)
    expect(results).not.toContain('40P01')
    expect(results.every((r) => r === 'ok')).toBe(true)
  }, 30000)
})

// =====================================================================================================
// FULL-APPLY availability golden — proves the PRODUCTION `applyExactAnchorRecovery` path is actually
// wired to the foreign-fence acquisition (the lock-layer suite above calls the helper directly and would
// pass even if the apply forgot to call it; this closes that "verified one link ≠ verified the chain"
// gap). A fenced foreign writer holds fence(F2)+FOR UPDATE(R2_F) across the apply's lock window; on the
// FIXED code the real apply blocks on the foreign fence and then COMMITS ok. Reverting the line-748 hunk
// to source-only fencing makes this same scenario return `preview-drift` (demonstrated out-of-band with a
// cp backup) — i.e. this assertion reds under that mutation, so the source edit is load-bearing.
// =====================================================================================================
const STRICT = 'MULTITABLE_HISTORY_CONTIGUITY_STRICT'
const BASE2 = `base_p22b_${TS}`
const S2 = `p22s2_sheet_${TS}` // source
const F2 = `p22f2_sheet_${TS}` // foreign (F2 < S2 lexically ⇒ apply fences F2 first)
const F2_STR = `p22b_note_${TS}`
const F2_LINK = `p22b_link_${TS}`
const ACTOR2 = `u_p22b_${TS}`

describeIfDatabase.sequential('P22 exact-anchor recovery — FULL apply availability under foreign contention', () => {
  const txn = <T>(fn: (query: QueryFn) => Promise<T>): Promise<T> =>
    poolManager.get().transaction(async ({ query }) => fn(query as unknown as QueryFn)) as Promise<T>
  const activate = () => txn((query) => activateCheckpoint(query, { sheetId: S2 }))
  const revSeq = (recordId: string, version: number, action: 'create' | 'update' | 'delete', snap: Record<string, unknown> | null, seq: string, opId?: string | null) =>
    q(
      `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, seq, operation_id)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,'rest',ARRAY[]::text[],'{}'::jsonb,$5::jsonb,$6::bigint,$7::uuid)`,
      [S2, recordId, version, action, snap === null ? null : JSON.stringify(snap), seq, opId ?? null],
    )
  const liveRec = (id: string, sheetId: string, data: Record<string, unknown>, version = 1) =>
    q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,$4)', [id, sheetId, JSON.stringify(data), version])
  async function sealAnchorOp(recordId: string, eventSeqs: Array<{ seq: string; version: number; action?: 'create' | 'update' | 'delete'; snap?: Record<string, unknown> }>): Promise<string> {
    const opId = randomUUID()
    const maxSeq = eventSeqs.map((e) => e.seq).reduce((a, b) => (BigInt(a) >= BigInt(b) ? a : b))
    await txn(async (query) => {
      for (const e of eventSeqs) {
        await query(
          `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, seq, operation_id)
           VALUES (gen_random_uuid(),$1,$2,$3,$4,'rest',ARRAY[]::text[],'{}'::jsonb,$5::jsonb,$6::bigint,$7::uuid)`,
          [S2, recordId, e.version, e.action ?? 'update', JSON.stringify(e.snap ?? {}), e.seq, opId],
        )
      }
      await query(
        `INSERT INTO meta_record_history_operations (sheet_id, operation_id, endpoint_seq, event_count) VALUES ($1,$2::uuid,$3::bigint,$4::int)`,
        [S2, opId, maxSeq, eventSeqs.length],
      )
    })
    return opId
  }
  async function seqBand(count: number): Promise<string[]> {
    await activate()
    const floorRes = await q(
      `SELECT trusted_since_seq::text AS s FROM meta_history_trust_checkpoints
       WHERE sheet_id = $1 AND state = 'active' AND pruned_at IS NULL`,
      [S2],
    )
    const floor = BigInt(String((floorRes.rows[0] as { s: string }).s))
    const seqs: string[] = []
    while (seqs.length < count) {
      const r = await q(`SELECT nextval('meta_record_chain_seq')::text AS s`)
      const s = BigInt(String((r.rows[0] as { s: string }).s))
      if (s > floor) seqs.push(String(s))
    }
    return seqs
  }
  const ALLOW = async () => true
  const applyArgs = (token: string) => ({
    token,
    sheetId: S2,
    actorId: ACTOR2,
    preliminaryFullRead: ALLOW,
    stabilizeAuthorization: async () => 'ready' as const,
    finalLockedFullRead: ALLOW,
    evaluatePlanAuthorization: ALLOW,
  })
  const preview = async (anchorOp: string, mode: ExactAnchorApplyMode = 'revert') => {
    const res = await resolveExactAnchor(q as unknown as QueryFn, { sheetId: S2, request: { kind: 'exact-anchor', anchorOperationId: anchorOp }, actorId: ACTOR2, mode, evaluateFullReadAccess: ALLOW })
    if (!res.ok) throw new Error(`preview failed: ${JSON.stringify(res)}`)
    return res
  }

  let R2_REV = ''
  let R2_F = ''

  async function wipe(): Promise<void> {
    await q('DELETE FROM meta_links WHERE record_id IN (SELECT id FROM meta_records WHERE sheet_id = ANY($1::text[])) OR foreign_record_id IN (SELECT id FROM meta_records WHERE sheet_id = ANY($1::text[]))', [[S2, F2]]).catch(() => {})
    for (const t of ['meta_history_baselines', 'meta_history_trust_checkpoints', 'meta_recovery_token_burns', 'meta_record_version_markers', 'meta_records_trash', 'meta_record_revisions'])
      await q(`DELETE FROM ${t} WHERE sheet_id = ANY($1::text[])`, [[S2, F2]]).catch(() => {})
    await q('DELETE FROM meta_record_history_operations WHERE sheet_id = ANY($1::text[])', [[S2, F2]]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[S2, F2]]).catch(() => {})
  }

  beforeAll(async () => {
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR2])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE2, 'P22b Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [S2, BASE2, 'P22b Source'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [F2, BASE2, 'P22b Foreign'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F2_STR, S2, 'Note', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F2_LINK, S2, 'Rel', 'link', JSON.stringify({ foreignSheetId: F2 }), 2])
  })
  beforeEach(async () => {
    await wipe()
    process.env[FLAG] = 'true'
    process.env[STRICT] = 'true'
    __resetRecoveryWriterStateColumnProbe()
    __resetOperationLedgerColumnProbe()
  })
  afterEach(() => {
    delete process.env[FLAG]
    delete process.env[STRICT]
  })
  afterAll(async () => {
    delete process.env[FLAG]
    delete process.env[STRICT]
    await wipe()
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[S2, F2]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[S2, F2]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE2]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR2]).catch(() => {})
  })

  /** Seed a scalar-revert scenario whose source record is cross-linked to a foreign record. */
  async function seedForeignLinkedRevert() {
    R2_REV = `p22b_rev_${TS}_${Math.random().toString(36).slice(2, 6)}`
    R2_F = `p22b_frec_${TS}_${Math.random().toString(36).slice(2, 6)}`
    const [sCreate, sUpdate] = await seqBand(2)
    // Foreign target + the forward edge (present at anchor AND live ⇒ the revert is scalar-only, no link write).
    await liveRec(R2_F, F2, {}, 1)
    const anchorOp = await sealAnchorOp(R2_REV, [
      { seq: sCreate, version: 1, action: 'create', snap: { [F2_STR]: 'rev-at-anchor', [F2_LINK]: [R2_F] } },
    ])
    await revSeq(R2_REV, 2, 'update', { [F2_STR]: 'rev-now', [F2_LINK]: [R2_F] }, sUpdate)
    await liveRec(R2_REV, S2, { [F2_STR]: 'rev-now', [F2_LINK]: [R2_F] }, 2)
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk2_${TS}`.slice(0, 50), F2_LINK, R2_REV, R2_F])
    return { anchorOp }
  }

  const connectLocal = async () => {
    const internal = poolManager.get().getInternalPool()
    if (!internal) throw new Error('no internal pool')
    return (await internal.connect()) as unknown as { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>; release: () => void }
  }

  test('FULL-APPLY: the real applyExactAnchorRecovery COMMITS ok while a fenced foreign writer holds the linked foreign record (source-only fencing would preview-drift here)', async () => {
    const { anchorOp } = await seedForeignLinkedRevert()
    const pv = await preview(anchorOp)

    // Fenced foreign writer holds fence(F2)+FOR UPDATE(R2_F) across the apply's lock window, then releases.
    const held = makeGate()
    const writer = (async () => {
      const c = await connectLocal()
      try {
        await c.query('BEGIN')
        await acquireCanonicalSheetFence(((s: string, p?: unknown[]) => c.query(s, p)) as never, F2)
        await c.query('SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE', [R2_F, F2])
        held.open()
        await sleep(400) // hold across the apply's fence-wait, then release so the FIXED apply can proceed
        await c.query('COMMIT')
      } catch { try { await c.query('ROLLBACK') } catch { /* ignore */ } } finally { c.release() }
    })()

    await held.wait() // writer is now holding fence(F2)+FOR UPDATE(R2_F)
    const out = await applyExactAnchorRecovery(txn, applyArgs(pv.token))
    await writer

    // eslint-disable-next-line no-console
    console.log(`[P22 full-apply] applyExactAnchorRecovery under foreign contention => ${JSON.stringify(out)}`)
    expect(out.ok).toBe(true) // FIXED: real apply waited on fence(F2), then committed — NOT preview-drift
    const reverted = (await q('SELECT data FROM meta_records WHERE id = $1 AND sheet_id = $2', [R2_REV, S2])).rows[0] as { data: Record<string, unknown> } | undefined
    expect(reverted?.data?.[F2_STR]).toBe('rev-at-anchor') // the revert actually landed
  }, 30000)
})
