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
 * Runs only with DATABASE_URL (describeIfDatabase) via the plugin-tests.yml real-DB runner list.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
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
