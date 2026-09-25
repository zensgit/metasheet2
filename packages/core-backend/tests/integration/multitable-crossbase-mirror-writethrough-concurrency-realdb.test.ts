/**
 * C2 cross-base mirror write-through — DECISION-F concurrency golden (#3440 §4 / #3441 §6/§8).
 *
 * The flag-on ENABLEMENT PRECONDITION: a real-DB TOCTOU/lock-closure proof that a concurrent FORWARD
 * link-edit (a normal /patch on rec_A.F_A) and the mirror op cannot interleave to break the canonical edge
 * or bypass the per-record mask. The op's WITHIN-op resolve-then-write TOCTOU is already closed by the
 * guard's `FOR UPDATE` on sheets+recB+recA; this suite proves the op serializes correctly against an
 * INDEPENDENT writer contending on the SAME rec_A meta_records row.
 *
 * BOUNDARY (unchanged by this file): this is a TEST-ONLY proof of ALREADY-implemented closure. It does NOT
 * enable the flag — MULTITABLE_ENABLE_CROSSBASE_MIRROR_WRITE stays default-off; the suite sets it per its own
 * request window and restores it. Passing Decision-F is a PRECONDITION FOR a future owner enablement
 * decision, not the enablement itself. No runtime change is made here.
 *
 * Proofs (each with the spine assertion count(meta_links WHERE field_id = M_B) === 0 after every case):
 *   F-1 serialization — while rec_A's meta_records row is held FOR UPDATE by an independent txn, the mirror
 *       op BLOCKS (does not settle); on release it completes and writes exactly one (F_A, rec_A, rec_B) edge.
 *   F-2 no stale read / no lost update — a forward edge committed by the holder WHILE the op is blocked is
 *       visible to the op's under-lock read: the op's set-replace preserves it (final set is the UNION), so a
 *       concurrent forward edit is never silently dropped by the op's read-modify-write.
 *   F-3 dedup under concurrency — two mirror ops adding the SAME edge concurrently ⇒ exactly ONE canonical
 *       row (serialized read-modify-write + the forward service's dedup; never a duplicate).
 *   F-4 mask not bypassable under concurrency — a row-read-denied rec_A stays the uniform
 *       MIRROR_LINK_TARGET_UNAVAILABLE 403 even with a concurrent forward edit on that rec_A; the mask is
 *       evaluated under the acquired lock, so a concurrent write cannot make a masked rec_A appear readable.
 *   F-5/F-6 sheet liveness is re-read UNDER the sheet lock (#5954) — a soft delete of sheet A (F-5) or sheet
 *       B (F-6) that is still uncommitted when the op's pre-transaction liveness gates read "live", and that
 *       COMMITS while the op is parked on the in-transaction sheet lock, is REFUSED with the same values-free
 *       404 SHEET_DELETED body the pre-transaction gate answers — and nothing is written (no edge, no rec_A
 *       version bump, no revision row). Before #5954 the lock was lock-only, and the two ends failed
 *       differently: F-6 (sheet B) answered 200 and wrote (one forward edge, rec_A version bumped, one revision
 *       row); F-5 (sheet A) wrote nothing, but only INCIDENTALLY — Lock C's readability derivation reads sheet A
 *       with `deleted_at IS NULL`, finds nothing and throws the uniform 403 MIRROR_LINK_TARGET_UNAVAILABLE. That
 *       is not a liveness refusal, and by code order it runs after the base-A authority check and the shared
 *       cross-base quota call.
 *   F-7 control — the same interleaving with the concurrent delete ROLLED BACK: the op waits, then succeeds.
 *       The refusal in F-5/F-6 is caused by the committed delete, not by having waited on the lock.
 *   F-8 refusal precedence — BOTH ends die in the window with DIFFERENT verdicts (sheet B soft-deleted, sheet
 *       A hard-deleted, one deleter transaction): B's 404 SHEET_DELETED is answered, not A's 404 NOT_FOUND,
 *       the same order the pre-transaction gates run in (B first). Runs on a disposable pair of its own.
 *
 * Runs only with DATABASE_URL (describeIfDatabase) via the plugin-tests.yml real-DB runner list, and is
 * two-point wired (vitest.config.ts no-DB exclusion + whole-file real-DB step), pinned by
 * scripts/ops/multitable-exact-anchor-ci-wiring.test.mjs; the sentinel below reds that step if it ever loses
 * DATABASE_URL instead of letting the suite skip green.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import {
  SHEETS_ROW_LOCK_LIVENESS_SQL,
  SHEET_DELETED_CODE,
  SHEET_DELETED_MESSAGE,
  SHEET_NOT_FOUND_MESSAGE,
} from '../../src/multitable/sheet-liveness'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

// Fail-not-skip: in the real-DB step (the workflow sets METASHEET_REAL_DB_TEST_STEP=1) a missing DATABASE_URL
// must RED, not collect-and-skip the whole suite green.
test('sentinel: C2 Decision-F real-DB lane must not skip-green', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('C2 Decision-F cross-base mirror concurrency real-DB step is missing DATABASE_URL')
  }
  expect(true).toBe(true)
})

const TS = Date.now()
const BASE_A = `base_c2df_a_${TS}`
const BASE_B = `base_c2df_b_${TS}`
const SA = `sheet_c2df_a_${TS}`
const SB = `sheet_c2df_b_${TS}`
const F_A = `fld_c2df_fwd_${TS}` // forward twoWay link A→B (the canonical edge key)
const M_B = `fld_c2df_mir_${TS}` // mirror twoWay link B→A, mirrorOf=F_A
const F_B_NAME = `fld_c2df_bname_${TS}`
const REC_A1 = `rec_c2df_a1_${TS}` // the contended base-A record (rec_A)
const REC_A2 = `rec_c2df_a2_${TS}` // the masked base-A record (F-4)
const REC_B1 = `rec_c2df_b1_${TS}` // rec_B — the acting mirror record
const REC_B2 = `rec_c2df_b2_${TS}` // a second base-B record, target of the concurrent forward edit
// F-8 only: a DISPOSABLE mirror pair in the same two bases. F-8 hard-deletes its sheet A (the cascade takes
// that sheet's fields and records with it), so it cannot share SA/SB with the other cases.
const SA8 = `sheet_c2df_a8_${TS}`
const SB8 = `sheet_c2df_b8_${TS}`
const F_A8 = `fld_c2df_fwd8_${TS}`
const M_B8 = `fld_c2df_mir8_${TS}`
const F_B8_NAME = `fld_c2df_bname8_${TS}`
const REC_A8 = `rec_c2df_a8_${TS}`
const REC_B8 = `rec_c2df_b8_${TS}`

const OWNER = `u_c2df_owner_${TS}` // owns BASE_A ⇒ base-A writable + full multitable perms

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let app: Express
let currentUser: { id: string; roles: string[]; perms: string[] } = {
  id: OWNER,
  roles: ['member'],
  perms: ['multitable:read', 'multitable:write'],
}

const mirrorRows = async (): Promise<number> =>
  Number(((await q('SELECT count(*)::int AS n FROM meta_links WHERE field_id = $1', [M_B])).rows[0] as { n: number }).n)
const forwardEdgeCount = async (recA: string, recB: string): Promise<number> =>
  Number(((await q('SELECT count(*)::int AS n FROM meta_links WHERE field_id = $1 AND record_id = $2 AND foreign_record_id = $3', [F_A, recA, recB])).rows[0] as { n: number }).n)
const forwardTargets = async (recA: string): Promise<string[]> =>
  (await q('SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2 ORDER BY foreign_record_id', [F_A, recA])).rows
    .map((r) => String((r as { foreign_record_id: unknown }).foreign_record_id))

type MirrorOpBody = { foreignRecordId?: string; action?: 'add' | 'remove'; sheetId?: string; recordId?: string; fieldId?: string }
const mirrorOp = (overrides: MirrorOpBody = {}) =>
  request(app).post('/api/multitable/crossbase/mirror-link').send({
    sheetId: SB, recordId: REC_B1, fieldId: M_B, action: 'add', foreignRecordId: REC_A1, targetBaseId: BASE_A, ...overrides,
  })
// An INDEPENDENT forward-field edit on rec_A.F_A through the general /patch (set-replace of the link set).
const forwardPatch = (recA: string, value: string[]) =>
  request(app).post('/api/multitable/patch').send({ sheetId: SA, changes: [{ recordId: recA, fieldId: F_A, value }] })

/**
 * Run `start()` while holding rec_A's meta_records row FOR UPDATE in an independent transaction. Optionally
 * apply `whileHeld` inside that same txn (e.g. commit a forward edge) BEFORE releasing. Asserts the started
 * request does NOT settle while the row is locked, then commits (releasing), then returns the settled value —
 * proving the op is genuinely serialized on the rec_A row lock, not merely racing.
 */
async function runWhileRecordLockHeld<T>(
  recordId: string,
  start: () => Promise<T>,
  whileHeld?: (client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<void>,
): Promise<T> {
  const client = await poolManager.get().getInternalPool().connect()
  await client.query('BEGIN')
  await client.query('SELECT id FROM meta_records WHERE id = $1 FOR UPDATE', [recordId])
  let settled = false
  const started = start().then((v) => { settled = true; return v }, (e) => { settled = true; throw e })
  try {
    await sleep(150)
    const settledWhileLocked = settled
    if (whileHeld) await whileHeld(client)
    await client.query('COMMIT')
    const result = await started
    expect(settledWhileLocked).toBe(false) // it BLOCKED on the rec_A row lock — genuine serialization
    return result
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

type DeleterClient = { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }> }
type SheetDeleter = (client: DeleterClient) => Promise<void>

// The production soft-delete statement (routes/univer-meta.ts, DELETE /sheets/:sheetId).
const softDeleteSheet = (sheetId: string): SheetDeleter => async (client) => {
  const del = await client.query('UPDATE meta_sheets SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [sheetId])
  expect(del.rowCount).toBe(1)
}
// A HARD delete — the only way a sheet reads `absent` under the lock. No runtime route issues it (in
// core-backend `src` only a migration hard-deletes `meta_sheets` rows), so F-8 uses it purely to make the two
// ends' verdicts differ.
const hardDeleteSheet = (sheetId: string): SheetDeleter => async (client) => {
  const del = await client.query('DELETE FROM meta_sheets WHERE id = $1', [sheetId])
  expect(del.rowCount).toBe(1)
}

/**
 * #5954 interleaving: run `deleter` (a soft delete of one sheet, or several deletes) in an INDEPENDENT
 * transaction and keep it UNCOMMITTED while the mirror op starts. The op's pre-transaction liveness gates
 * read the committed row (still live — an uncommitted UPDATE/DELETE is invisible to them and does not block
 * a plain read), pass, and the op then PARKS on the in-transaction sheet lock behind the deleter. Only once
 * the op is observed parked — by `pg_blocking_pids`, so this cannot go blind if the lock statement is
 * reworded — does the deleter `outcome` (COMMIT = the delete lands in the op's window; ROLLBACK = the
 * control). Returns the settled response and the parked statement's text.
 *
 * Why this is the #5954 window: when the deleter commits, the op's `FOR UPDATE` returns the NEW row version
 * (deleted_at set), or no row for a hard delete. A lock-only statement never looks at it — exactly as when
 * the delete commits before the lock request and the lock is simply free. Either way only a re-read under
 * the lock can see the delete.
 */
async function runWithSheetDeleteInWindow<T>(
  deleter: SheetDeleter,
  outcome: 'commit' | 'rollback',
  start: () => PromiseLike<T>,
): Promise<{ result: T; parkedQuery: string }> {
  const client = await poolManager.get().getInternalPool().connect()
  let open = false
  try {
    await client.query('BEGIN')
    open = true
    const holderPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    await deleter(client)

    let settled = false
    const started = Promise.resolve(start()).then((v) => { settled = true; return v }, (e) => { settled = true; throw e })
    let parkedQuery = ''
    const deadline = Date.now() + 10_000
    while (!parkedQuery) {
      if (settled) {
        // It answered without ever waiting on the deleter: it did not reach the sheet lock at all.
        await started.catch(() => {})
        throw new Error('the mirror op settled before parking on the held sheet row')
      }
      if (Date.now() > deadline) throw new Error('the mirror op never parked on the held sheet row')
      const waiters = await q(
        "SELECT query FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'",
        [holderPid],
      )
      if (waiters.rows.length > 1) throw new Error(`expected exactly one backend parked behind the deleter, saw ${waiters.rows.length}`)
      if (waiters.rows.length === 1) parkedQuery = String((waiters.rows[0] as { query: unknown }).query)
      else await sleep(20)
    }
    expect(settled).toBe(false) // parked behind the uncommitted delete — past BOTH pre-transaction gates

    await client.query(outcome === 'commit' ? 'COMMIT' : 'ROLLBACK')
    open = false
    return { result: await started, parkedQuery }
  } finally {
    if (open) await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

const recordVersion = async (recordId: string): Promise<number> =>
  Number(((await q('SELECT version FROM meta_records WHERE id = $1', [recordId])).rows[0] as { version: unknown }).version)
const revisionCount = async (recordId: string): Promise<number> =>
  Number(((await q('SELECT count(*)::int AS n FROM meta_record_revisions WHERE record_id = $1', [recordId])).rows[0] as { n: number }).n)

describeIfDatabase('C2 Decision-F — forward-edit ↔ mirror-op concurrency (real DB)', () => {
  beforeAll(async () => {
    process.env.MULTITABLE_ENABLE_CROSSBASE_MIRROR_WRITE = 'true'
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as express.Request & { user?: unknown }).user = currentUser; next() })
    app.use('/api/multitable', univerMetaRouter())

    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [OWNER])
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [BASE_A, 'C2DF A', OWNER])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_B, 'C2DF B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3),($4,$5,$6)', [SA, BASE_A, 'A', SB, BASE_B, 'B'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [F_A, SA, 'Fwd', 'link', JSON.stringify({ foreignSheetId: SB, foreignBaseId: BASE_B, twoWay: true, mirrorFieldId: M_B }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [M_B, SB, 'Mir', 'link', JSON.stringify({ foreignSheetId: SA, foreignBaseId: BASE_A, twoWay: true, mirrorFieldId: F_A, mirrorOf: F_A }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [F_B_NAME, SB, 'BName', 'string', '{}', 2])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1),($4,$5,$6::jsonb,1),($7,$8,$9::jsonb,1),($10,$11,$12::jsonb,1)',
      [REC_A1, SA, '{}', REC_A2, SA, '{}', REC_B1, SB, JSON.stringify({ [F_B_NAME]: 'b1' }), REC_B2, SB, JSON.stringify({ [F_B_NAME]: 'b2' })])
  })

  afterAll(async () => {
    delete process.env.MULTITABLE_ENABLE_CROSSBASE_MIRROR_WRITE
    await q('DELETE FROM meta_links WHERE field_id = ANY($1::text[])', [[F_A, M_B, F_A8, M_B8]]).catch(() => {})
    await q('DELETE FROM record_permissions WHERE sheet_id = ANY($1::text[])', [[SA, SB]]).catch(() => {})
    await q('UPDATE meta_sheets SET row_level_read_permissions_enabled = false WHERE id = ANY($1::text[])', [[SA, SB]]).catch(() => {})
    for (const t of ['meta_record_revisions', 'meta_records']) await q(`DELETE FROM ${t} WHERE sheet_id = ANY($1::text[])`, [[SA, SB, SA8, SB8]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SA, SB, SA8, SB8]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SA, SB, SA8, SB8]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_A, BASE_B]]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [OWNER]).catch(() => {})
    await poolManager.get().end?.()
  })

  afterEach(async () => {
    expect(await mirrorRows()).toBe(0) // spine holds after EVERY interleaving
    await q('DELETE FROM meta_links WHERE field_id = $1', [F_A]).catch(() => {}) // reset edges between cases
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  // F-1: the mirror op blocks on rec_A's row lock, then completes — genuine serialization, not a race.
  test('F-1 serialization: mirror op BLOCKS while rec_A is row-locked, completes on release with one edge', async () => {
    const res = await runWhileRecordLockHeld(REC_A1, () => mirrorOp({ foreignRecordId: REC_A1 }))
    expect(res.status).toBe(200)
    expect(await forwardEdgeCount(REC_A1, REC_B1)).toBe(1)
    expect(await mirrorRows()).toBe(0)
  })

  // F-2: a forward edge committed by the holder WHILE the op is blocked is seen by the op's under-lock read;
  // the op's set-replace preserves it (UNION), never a stale-read lost update.
  test('F-2 no stale read: a forward edge committed while the op is blocked survives (final set is the union)', async () => {
    const res = await runWhileRecordLockHeld(
      REC_A1,
      () => mirrorOp({ foreignRecordId: REC_A1 }), // op wants to add (F_A, REC_A1, REC_B1)
      async (client) => {
        // Independent forward edit commits (F_A, REC_A1, REC_B2) WHILE the op is blocked on the row lock.
        await client.query('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [F_A, REC_A1, REC_B2])
      },
    )
    expect(res.status).toBe(200)
    // If the op had read a STALE empty set it would set-replace to [REC_B1] and drop REC_B2 (lost update).
    // Because it reads currentIds UNDER the lock (after the holder committed), the union survives.
    expect(await forwardTargets(REC_A1)).toEqual([REC_B1, REC_B2].sort())
    expect(await forwardEdgeCount(REC_A1, REC_B1)).toBe(1)
    expect(await forwardEdgeCount(REC_A1, REC_B2)).toBe(1)
    expect(await mirrorRows()).toBe(0)
  })

  // F-3: two concurrent mirror ops adding the SAME edge ⇒ exactly ONE canonical row (dedup under concurrency).
  test('F-3 dedup under concurrency: two concurrent adds of the same edge ⇒ exactly one canonical row', async () => {
    const [a, b] = await Promise.all([
      mirrorOp({ foreignRecordId: REC_A1 }),
      mirrorOp({ foreignRecordId: REC_A1 }),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(await forwardEdgeCount(REC_A1, REC_B1)).toBe(1) // never a duplicate (F_A, REC_A1, REC_B1)
    expect(await forwardTargets(REC_A1)).toEqual([REC_B1])
    expect(await mirrorRows()).toBe(0)
  })

  // F-4: a row-read-denied rec_A stays the uniform 403 even with a concurrent forward edit on that rec_A —
  // the mask is evaluated under the acquired lock; a concurrent write cannot make a masked rec_A readable.
  test('F-4 mask not bypassable under concurrency: masked rec_A stays uniform 403 despite a concurrent forward edit', async () => {
    await q('UPDATE meta_sheets SET row_level_read_permissions_enabled = true WHERE id = $1', [SA])
    await q('INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1,$2,$3,$4,$5)',
      [SA, REC_A2, 'user', OWNER, 'none'])
    try {
      const [masked, fwd] = await Promise.all([
        mirrorOp({ foreignRecordId: REC_A2 }),         // masked read on REC_A2 → must uniform-deny
        forwardPatch(REC_A2, [REC_B2]),                 // a concurrent forward edit on the SAME rec_A
      ])
      expect(masked.status).toBe(403)
      expect(masked.body?.error?.code).toBe('MIRROR_LINK_TARGET_UNAVAILABLE')
      expect(fwd.status).toBe(200) // the forward edit (by the base-A owner) is unaffected
      // The mirror op wrote NOTHING for its intended edge, even though a forward edit touched REC_A2.
      expect(await forwardEdgeCount(REC_A2, REC_B1)).toBe(0)
      expect(await mirrorRows()).toBe(0)
    } finally {
      await q('DELETE FROM record_permissions WHERE sheet_id = $1', [SA]).catch(() => {})
      await q('UPDATE meta_sheets SET row_level_read_permissions_enabled = false WHERE id = $1', [SA])
    }
  })

  // F-5/F-6 (#5954): a soft delete of EITHER end that commits inside the op's window is refused under the lock.
  for (const [label, sheetId] of [['F-5 sheet A (forward / base-A end)', SA], ['F-6 sheet B (mirror / base-B end)', SB]] as const) {
    test(`${label}: a soft delete committed while the op is parked on the sheet lock is refused with no side effects`, async () => {
      const versionBefore = await recordVersion(REC_A1)
      const revisionsBefore = await revisionCount(REC_A1)
      try {
        const { result: res, parkedQuery } = await runWithSheetDeleteInWindow(softDeleteSheet(sheetId), 'commit', () => mirrorOp({ foreignRecordId: REC_A1 }))
        // The SAME values-free 404 the pre-transaction gate answers for a deleted sheet: no id, no rec_A info.
        expect(res.status).toBe(404)
        expect(res.body).toEqual({ ok: false, error: { code: SHEET_DELETED_CODE, message: SHEET_DELETED_MESSAGE } })
        for (const id of [SA, SB, REC_A1, REC_B1, F_A, M_B, BASE_A, BASE_B]) expect(JSON.stringify(res.body)).not.toContain(id)
        // No side effects: the transaction rolled back before the forward write.
        expect(await forwardEdgeCount(REC_A1, REC_B1)).toBe(0)
        expect(await forwardTargets(REC_A1)).toEqual([])
        expect(await recordVersion(REC_A1)).toBe(versionBefore)
        expect(await revisionCount(REC_A1)).toBe(revisionsBefore)
        expect(await mirrorRows()).toBe(0)
        // It parked on the helper's own statement (pattern DERIVED from the exported constant, not copied).
        expect(parkedQuery.startsWith(SHEETS_ROW_LOCK_LIVENESS_SQL)).toBe(true)
      } finally {
        await q('UPDATE meta_sheets SET deleted_at = NULL WHERE id = $1', [sheetId])
      }
    })
  }

  // F-7 control: the same interleaving, the delete ROLLED BACK — the op waited on the lock and then succeeds.
  test('F-7 control: the concurrent delete rolls back ⇒ the parked op proceeds and writes exactly one edge', async () => {
    const { result: res } = await runWithSheetDeleteInWindow(softDeleteSheet(SA), 'rollback', () => mirrorOp({ foreignRecordId: REC_A1 }))
    expect(res.status).toBe(200)
    expect(await forwardEdgeCount(REC_A1, REC_B1)).toBe(1)
    expect(await mirrorRows()).toBe(0)
  })

  // F-8 (#5954): BOTH ends die in the op's window, with DIFFERENT verdicts, in ONE deleter transaction: sheet
  // B soft-deleted (`deleted` ⇒ 404 SHEET_DELETED) and sheet A hard-deleted (`absent` ⇒ 404 NOT_FOUND 'Sheet
  // not found'). The route hands the helper [sheetB, sheetA] and the helper reports the first non-live id in
  // that order, so B's verdict is the one answered — the same precedence the pre-transaction gates run in (B
  // is gated first). This is the only interleaving where the argument order is observable: swapping it to
  // [sheetA, sheetB] answers A's NOT_FOUND body instead, and this case reds.
  test('F-8 both ends die with different verdicts (B soft-deleted, A hard-deleted) ⇒ B\'s 404 SHEET_DELETED is answered', async () => {
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3),($4,$5,$6)', [SA8, BASE_A, 'A8', SB8, BASE_B, 'B8'])
    try {
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
        [F_A8, SA8, 'Fwd8', 'link', JSON.stringify({ foreignSheetId: SB8, foreignBaseId: BASE_B, twoWay: true, mirrorFieldId: M_B8 }), 1])
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
        [M_B8, SB8, 'Mir8', 'link', JSON.stringify({ foreignSheetId: SA8, foreignBaseId: BASE_A, twoWay: true, mirrorFieldId: F_A8, mirrorOf: F_A8 }), 1])
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
        [F_B8_NAME, SB8, 'BName8', 'string', '{}', 2])
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1),($4,$5,$6::jsonb,1)',
        [REC_A8, SA8, '{}', REC_B8, SB8, JSON.stringify({ [F_B8_NAME]: 'b8' })])

      const both: SheetDeleter = async (client) => {
        await softDeleteSheet(SB8)(client)
        await hardDeleteSheet(SA8)(client)
      }
      const { result: res, parkedQuery } = await runWithSheetDeleteInWindow(
        both,
        'commit',
        () => mirrorOp({ sheetId: SB8, recordId: REC_B8, fieldId: M_B8, foreignRecordId: REC_A8 }),
      )
      // It parked on the helper's own statement, past BOTH pre-transaction gates, before the deleter committed.
      expect(parkedQuery.startsWith(SHEETS_ROW_LOCK_LIVENESS_SQL)).toBe(true)
      // B's verdict (deleted), NOT A's (absent ⇒ { code: 'NOT_FOUND', message: SHEET_NOT_FOUND_MESSAGE }).
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ ok: false, error: { code: SHEET_DELETED_CODE, message: SHEET_DELETED_MESSAGE } })
      expect(res.body.error.message).not.toBe(SHEET_NOT_FOUND_MESSAGE)
      for (const id of [SA8, SB8, REC_A8, REC_B8, F_A8, M_B8, BASE_A, BASE_B]) expect(JSON.stringify(res.body)).not.toContain(id)
      // Nothing written: no edge on either field of the pair (sheet A's rows are gone with the hard delete).
      const edges = await q('SELECT count(*)::int AS n FROM meta_links WHERE field_id = ANY($1::text[])', [[F_A8, M_B8]])
      expect(Number((edges.rows[0] as { n: number }).n)).toBe(0)
    } finally {
      await q('DELETE FROM meta_links WHERE field_id = ANY($1::text[])', [[F_A8, M_B8]]).catch(() => {})
      for (const t of ['meta_record_revisions', 'meta_records']) await q(`DELETE FROM ${t} WHERE sheet_id = ANY($1::text[])`, [[SA8, SB8]]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SA8, SB8]]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SA8, SB8]]).catch(() => {})
    }
  })
})
