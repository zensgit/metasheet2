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
 *
 * A SECOND suite at the end of this file (#5954) races the op's two-sheet lock against a concurrent SOFT
 * DELETE of either sheet — see its own header.
 *
 * Runs only with DATABASE_URL (describeIfDatabase) via the plugin-tests.yml real-DB runner list. Two-point
 * wired since #5954: excluded from the no-DB default lane in vitest.config.ts (so it cannot collect and
 * skip-green there), and pinned by scripts/ops/multitable-exact-anchor-ci-wiring.test.mjs.
 */
import express, { type Express } from 'express'
import type { PoolClient } from 'pg'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { __resetSharedCrossBaseWriteQuotaForTest } from '../../src/multitable/automation-executor'
import {
  SHEETS_ROW_LOCK_LIVENESS_SQL,
  SHEET_DELETED_CODE,
  SHEET_DELETED_MESSAGE,
  SheetNotLiveError,
  assertSheetsLiveForUpdate,
} from '../../src/multitable/sheet-liveness'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

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

type MirrorOpBody = { foreignRecordId?: string; action?: 'add' | 'remove' }
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
    await q('DELETE FROM meta_links WHERE field_id = ANY($1::text[])', [[F_A, M_B]]).catch(() => {})
    await q('DELETE FROM record_permissions WHERE sheet_id = ANY($1::text[])', [[SA, SB]]).catch(() => {})
    await q('UPDATE meta_sheets SET row_level_read_permissions_enabled = false WHERE id = ANY($1::text[])', [[SA, SB]]).catch(() => {})
    for (const t of ['meta_record_revisions', 'meta_records']) await q(`DELETE FROM ${t} WHERE sheet_id = ANY($1::text[])`, [[SA, SB]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SA, SB]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SA, SB]]).catch(() => {})
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
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// #5954 — the op's TWO-SHEET lock re-reads liveness: the real interleaving, on real Postgres, two connections.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
/**
 * `POST /crossbase/mirror-link` gates both sheets' liveness through the POOL (outside any transaction), then
 * locks both sheet rows inside the patch transaction (`preWriteGuard`). Before #5954 that lock was the
 * lock-only `SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) FOR UPDATE`: a soft delete committing
 * between the gates and the lock left it FREE, and the op wrote the edge into the deleted sheet, answering
 * 200. It now locks through `assertSheetsLiveForUpdate`, which reads `deleted_at` in the locking statement.
 *
 * The unit suites script the window with fakes. A fake can SAY "the locked read returned the committed
 * row"; only Postgres can show that `FOR UPDATE` actually WAITS for an uncommitted soft delete and then
 * hands back the row version that delete committed — which is the whole fix. So it is proven here:
 *
 *   H-* (the helper, two raw connections)
 *     D: BEGIN; UPDATE meta_sheets SET deleted_at = now() … (the production soft delete) — uncommitted
 *     M: BEGIN; assertSheetsLiveForUpdate(M, [sheetA, sheetB]) — must PARK on that row. Proven twice: the
 *        call has not settled, AND pg_stat_activity shows M's backend waiting on a Lock, running the
 *        helper's statement, with D's pid in pg_blocking_pids(M).
 *     D: COMMIT   ⇒ M's FOR UPDATE returns the COMMITTED row (deleted_at set) and the helper REFUSES.
 *     D: ROLLBACK ⇒ M gets both rows live, PASSES, and then HOLDS both rows (a NOWAIT probe is refused).
 *   Run with sheet A and with sheet B as the deleted one.
 *
 *   R-* (the route, end to end)
 *     D holds the same uncommitted soft delete; the op passes its pool-level gates (an uncommitted delete is
 *     invisible to them — that is the window), enters the patch transaction and parks on its sheet lock.
 *     D commits ⇒ the values-free 404 SHEET_DELETED and NO edge (pre-#5954: 200 and the edge).
 *     D rolls back instead ⇒ 200 and exactly one canonical edge.
 *
 * The waiter probe DERIVES its `pg_stat_activity` pattern from SHEETS_ROW_LOCK_LIVENESS_SQL rather than
 * copying the statement (#5938: a copied pattern went blind when the statement was reworded); the
 * structural guard (tests/unit/multitable-permissions-txn-liveness-recheck.guard.test.ts) pins that from
 * source. Every wait is bounded (poll budget, `lock_timeout`, explicit settle timeouts), so a regression
 * reds in seconds instead of hanging the lane; every connection is rolled back and released in `finally`.
 *
 * Own fixture ids (`_mlrd_`), own app, own hooks — nothing is shared with the Decision-F suite above.
 */
test('sentinel: #5954 mirror sheet-liveness lock real-DB lane must not skip-green', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('#5954 mirror sheet-liveness lock real-DB step is missing DATABASE_URL')
  }
  expect(true).toBe(true)
})

describeIfDatabase.sequential('#5954 — mirror op two-sheet lock vs a concurrent soft delete (real DB)', () => {
  const LTS = Date.now()
  const L_BASE_A = `base_mlrd_a_${LTS}`
  const L_BASE_B = `base_mlrd_b_${LTS}`
  const L_SA = `sheet_mlrd_a_${LTS}` // base-A sheet — forward field, rec_A (the edge's write target)
  const L_SB = `sheet_mlrd_b_${LTS}` // base-B sheet — mirror field, rec_B
  const L_F_A = `fld_mlrd_fwd_${LTS}`
  const L_M_B = `fld_mlrd_mir_${LTS}`
  const L_F_B_NAME = `fld_mlrd_bname_${LTS}`
  const L_REC_A1 = `rec_mlrd_a1_${LTS}`
  const L_REC_B1 = `rec_mlrd_b1_${LTS}`
  const L_OWNER = `u_mlrd_owner_${LTS}` // owns L_BASE_A ⇒ base-A writable + full multitable perms

  /** The production soft delete, verbatim (routes/univer-meta.ts DELETE /sheets/:sheetId). */
  const SOFT_DELETE_SQL = 'UPDATE meta_sheets SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL'
  const SHEET_DELETED_BODY = { ok: false, error: { code: SHEET_DELETED_CODE, message: SHEET_DELETED_MESSAGE } }

  const connect = (): Promise<PoolClient> => poolManager.get().getInternalPool().connect()
  const backendPid = async (client: PoolClient): Promise<number> =>
    Number(((await client.query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: unknown }).pid)

  function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms)
      promise.then(
        (value) => { clearTimeout(timer); resolve(value) },
        (error: unknown) => { clearTimeout(timer); reject(error) },
      )
    })
  }

  /**
   * Poll until some backend is WAITING ON A LOCK, running the helper's statement, blocked BY `holderPid`.
   * Returns the waiter's pid, or null if none appeared within the budget or the caller settled first (a
   * settled caller did not wait — that is the failure this probe exists to see).
   *
   * Text AND pid: the text says WHICH statement waits (the liveness-reading lock, not some other read);
   * `pg_blocking_pids` says it waits on THIS holder (not on an unrelated lock elsewhere).
   */
  async function waitForParkedWaiter(holderPid: number, settled: () => boolean, waiterPid?: number): Promise<number | null> {
    for (let i = 0; i < 250; i++) {
      if (settled()) return null
      const res = await q(
        `SELECT pid
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND state = 'active'
            AND wait_event_type = 'Lock'
            AND query LIKE $1
            AND $2::int = ANY(pg_blocking_pids(pid))`,
        [`${SHEETS_ROW_LOCK_LIVENESS_SQL}%`, holderPid],
      )
      const pids = (res.rows as Array<{ pid: unknown }>).map((r) => Number(r.pid))
      const hit = waiterPid === undefined ? pids[0] : pids.find((pid) => pid === waiterPid)
      if (hit !== undefined) return hit
      await sleep(20)
    }
    return null
  }

  const lockMirrorRows = async (): Promise<number> =>
    Number(((await q('SELECT count(*)::int AS n FROM meta_links WHERE field_id = $1', [L_M_B])).rows[0] as { n: number }).n)
  const lockForwardEdgeCount = async (): Promise<number> =>
    Number(((await q(
      'SELECT count(*)::int AS n FROM meta_links WHERE field_id = $1 AND record_id = $2 AND foreign_record_id = $3',
      [L_F_A, L_REC_A1, L_REC_B1],
    )).rows[0] as { n: number }).n)

  let lockApp: Express
  const lockUser = { id: L_OWNER, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
  const lockMirrorOp = () =>
    request(lockApp).post('/api/multitable/crossbase/mirror-link').send({
      sheetId: L_SB, recordId: L_REC_B1, fieldId: L_M_B, action: 'add', foreignRecordId: L_REC_A1, targetBaseId: L_BASE_A,
    })

  beforeAll(async () => {
    process.env.MULTITABLE_ENABLE_CROSSBASE_MIRROR_WRITE = 'true'
    lockApp = express()
    lockApp.use(express.json())
    lockApp.use((req, _res, next) => { ;(req as express.Request & { user?: unknown }).user = lockUser; next() })
    lockApp.use('/api/multitable', univerMetaRouter())

    // Same fixture shape as the Decision-F suite above (whose F-1 proves this actor reaches 200 on this
    // op), so a red here is about the lock, not the setup.
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [L_OWNER])
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [L_BASE_A, 'MLRD A', L_OWNER])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [L_BASE_B, 'MLRD B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3),($4,$5,$6)', [L_SA, L_BASE_A, 'A', L_SB, L_BASE_B, 'B'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [L_F_A, L_SA, 'Fwd', 'link', JSON.stringify({ foreignSheetId: L_SB, foreignBaseId: L_BASE_B, twoWay: true, mirrorFieldId: L_M_B }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [L_M_B, L_SB, 'Mir', 'link', JSON.stringify({ foreignSheetId: L_SA, foreignBaseId: L_BASE_A, twoWay: true, mirrorFieldId: L_F_A, mirrorOf: L_F_A }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [L_F_B_NAME, L_SB, 'BName', 'string', '{}', 2])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1),($4,$5,$6::jsonb,1)',
      [L_REC_A1, L_SA, '{}', L_REC_B1, L_SB, JSON.stringify({ [L_F_B_NAME]: 'b1' })])
  })

  beforeEach(() => {
    __resetSharedCrossBaseWriteQuotaForTest()
  })

  afterEach(async () => {
    expect(await lockMirrorRows()).toBe(0) // the mirror field never owns a meta_links row, on any path
    await q('DELETE FROM meta_links WHERE field_id = $1', [L_F_A]).catch(() => {})
    // Every case soft-deletes one of the two sheets (or rolls that back); put both back to live.
    await q('UPDATE meta_sheets SET deleted_at = NULL WHERE id = ANY($1::text[])', [[L_SA, L_SB]])
  })

  afterAll(async () => {
    delete process.env.MULTITABLE_ENABLE_CROSSBASE_MIRROR_WRITE
    await q('DELETE FROM meta_links WHERE field_id = ANY($1::text[])', [[L_F_A, L_M_B]]).catch(() => {})
    for (const t of ['meta_record_revisions', 'meta_records']) {
      await q(`DELETE FROM ${t} WHERE sheet_id = ANY($1::text[])`, [[L_SA, L_SB]]).catch(() => {})
    }
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[L_SA, L_SB]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[L_SA, L_SB]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[L_BASE_A, L_BASE_B]]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [L_OWNER]).catch(() => {})
  })

  test('fixture: both sheets start live, and the helper passes on them uncontended', async () => {
    const m = await connect()
    try {
      await m.query('BEGIN')
      await expect(assertSheetsLiveForUpdate((sql, params) => m.query(sql, params), [L_SA, L_SB])).resolves.toBeUndefined()
    } finally {
      await m.query('ROLLBACK').catch(() => {})
      m.release()
    }
  })

  // ── H-*: the helper, two raw connections ──────────────────────────────────────────────────────────────

  type Outcome = { ok: true } | { ok: false; err: unknown }
  type HelperRace = { outcome: Outcome; lockedRows: unknown[][]; probe: PoolClient }

  /**
   * D soft-deletes `target` and holds it uncommitted; M runs the helper for [SA, SB] and must park on it.
   * `finish` decides D's fate; `inspect` then sees M's outcome and the rows M's locking statement actually
   * returned, WHILE M's transaction is still open (so a passed helper still holds its locks). All three
   * connections are rolled back and released here, whatever `inspect` or the race itself throws.
   */
  async function raceHelper(target: string, finish: 'COMMIT' | 'ROLLBACK', inspect: (race: HelperRace) => Promise<void>): Promise<void> {
    const d = await connect()
    const m = await connect()
    const probe = await connect()
    let mOutcome: Promise<Outcome> | null = null
    try {
      const dPid = await backendPid(d)
      const mPid = await backendPid(m)

      await d.query('BEGIN')
      const deleted = await d.query(SOFT_DELETE_SQL, [target])
      expect(deleted.rowCount).toBe(1) // D really holds a new row version of the target, uncommitted

      await m.query('BEGIN')
      await m.query("SET LOCAL lock_timeout = '10s'") // bounded, whatever goes wrong
      const lockedRows: unknown[][] = []
      const mQuery = async (sql: string, params: unknown[]) => {
        const res = await m.query(sql, params)
        if (sql === SHEETS_ROW_LOCK_LIVENESS_SQL) lockedRows.push(res.rows)
        return res
      }
      let settled = false
      mOutcome = assertSheetsLiveForUpdate(mQuery, [L_SA, L_SB])
        .then((): Outcome => ({ ok: true }), (err: unknown): Outcome => ({ ok: false, err }))
        .finally(() => { settled = true })

      // M must be WAITING — not done — and waiting on D, in the helper's statement.
      const parkedPid = await waitForParkedWaiter(dPid, () => settled, mPid)
      expect(settled, 'M settled while D still held the row — it did not wait on the lock').toBe(false)
      expect(parkedPid, 'M never showed up as a Lock waiter blocked by D in the helper statement').toBe(mPid)

      await d.query(finish)
      const outcome = await withTimeout(mOutcome, 10_000, `helper after D ${finish}`)
      await inspect({ outcome, lockedRows, probe })
    } finally {
      // D first: if M is still parked behind it, this is what lets M finish before it is released.
      await d.query('ROLLBACK').catch(() => {})
      if (mOutcome) await withTimeout(mOutcome, 10_000, 'drain M').catch(() => {})
      await m.query('ROLLBACK').catch(() => {})
      await probe.query('ROLLBACK').catch(() => {})
      d.release()
      m.release()
      probe.release()
    }
  }

  const rowOf = (rows: unknown[], id: string) =>
    (rows as Array<{ id: string; deleted_at: unknown }>).find((r) => r.id === id)

  for (const [label, target, other] of [['A', L_SA, L_SB], ['B', L_SB, L_SA]] as const) {
    test(`H-${label} COMMIT: M parks on sheet ${label}'s row; D commits the soft delete ⇒ M's lock returns the committed row and the helper REFUSES`, async () => {
      await raceHelper(target, 'COMMIT', async ({ outcome, lockedRows }) => {
        expect(outcome.ok, 'the helper PASSED on a sheet whose soft delete committed while it waited').toBe(false)
        const err = (outcome as { ok: false; err: unknown }).err
        expect(err).toBeInstanceOf(SheetNotLiveError)
        expect((err as SheetNotLiveError).liveness).toBe('deleted')
        expect((err as SheetNotLiveError).sheetId).toBe(target)
        expect((err as SheetNotLiveError).message).not.toContain(target)

        // What the ONE locking statement handed back: both rows, the target in its COMMITTED version.
        expect(lockedRows.length).toBe(1)
        expect(lockedRows[0]!.length).toBe(2)
        const targetRow = rowOf(lockedRows[0]!, target)
        expect(targetRow).toHaveProperty('deleted_at')
        expect(targetRow?.deleted_at).not.toBeNull()
        expect(rowOf(lockedRows[0]!, other)?.deleted_at).toBeNull()
      })
    })

    test(`H-${label} ROLLBACK: M parks on sheet ${label}'s row; D rolls back ⇒ the helper PASSES and M holds both rows`, async () => {
      await raceHelper(target, 'ROLLBACK', async ({ outcome, lockedRows, probe }) => {
        expect(outcome).toEqual({ ok: true })
        expect(lockedRows.length).toBe(1)
        expect(rowOf(lockedRows[0]!, L_SA)).toHaveProperty('deleted_at', null)
        expect(rowOf(lockedRows[0]!, L_SB)).toHaveProperty('deleted_at', null)

        // …and the pass is a HELD lock, not a read: a third session cannot take either row.
        for (const id of [L_SA, L_SB]) {
          await expect(probe.query('SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE NOWAIT', [id]))
            .rejects.toMatchObject({ code: '55P03' })
        }
      })
    })
  }

  // ── R-*: the route, end to end ────────────────────────────────────────────────────────────────────────

  /** D holds an uncommitted soft delete of `target` while the mirror op runs; `finish` decides D's fate. */
  async function raceRoute(target: string, finish: 'COMMIT' | 'ROLLBACK'): Promise<request.Response> {
    const d = await connect()
    let op: Promise<request.Response> | null = null
    try {
      const dPid = await backendPid(d)
      await d.query('BEGIN')
      const deleted = await d.query(SOFT_DELETE_SQL, [target])
      expect(deleted.rowCount).toBe(1)

      let settled = false
      op = Promise.resolve(lockMirrorOp()).finally(() => { settled = true })

      // The op got through its pool-level gates (the uncommitted delete is invisible to them) and is now
      // parked INSIDE the patch transaction, on the helper's statement, behind D.
      const parkedPid = await waitForParkedWaiter(dPid, () => settled)
      expect(settled, 'the op settled while D still held the row — it did not wait on the sheet lock').toBe(false)
      expect(parkedPid, 'the op never showed up as a Lock waiter blocked by D in the helper statement').not.toBeNull()

      await d.query(finish)
      return await withTimeout(op, 15_000, `mirror op after D ${finish}`)
    } finally {
      await d.query('ROLLBACK').catch(() => {})
      // Never leave a request in flight into the next case's cleanup.
      if (op) await withTimeout(op, 15_000, 'drain mirror op').catch(() => {})
      d.release()
    }
  }

  for (const [label, target] of [['A', L_SA], ['B', L_SB]] as const) {
    test(`R-${label} COMMIT: sheet ${label} is soft-deleted while the op waits on its lock ⇒ 404 SHEET_DELETED, no edge (pre-#5954: 200 + edge)`, async () => {
      const res = await raceRoute(target, 'COMMIT')
      expect(res.status).toBe(404)
      expect(res.body).toEqual(SHEET_DELETED_BODY)
      const raw = JSON.stringify(res.body)
      for (const value of [L_SA, L_SB, L_BASE_A, L_BASE_B, L_F_A, L_M_B, L_REC_A1, L_REC_B1]) expect(raw).not.toContain(value)
      expect(await lockForwardEdgeCount()).toBe(0)
      // The delete itself stood: the sheet is dead, and the op did not resurrect or touch it.
      const row = await q('SELECT deleted_at FROM meta_sheets WHERE id = $1', [target])
      expect((row.rows[0] as { deleted_at: unknown }).deleted_at).not.toBeNull()
    })
  }

  test('R-ROLLBACK: the soft delete rolls back while the op waits ⇒ 200 and exactly one canonical edge', async () => {
    const res = await raceRoute(L_SA, 'ROLLBACK')
    expect(res.status).toBe(200)
    expect(await lockForwardEdgeCount()).toBe(1)
  })
})
