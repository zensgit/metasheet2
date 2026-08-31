/**
 * Cross-base / link referential integrity — dangling-link repair (real DB). `meta_links.foreign_record_id` has
 * NO FK (record_id does: ON DELETE CASCADE), so an inbound edge to a since-deleted record DANGLES and would
 * surface as a GHOST foreign id on read.
 *   (i) repair-on-read: loadLinkValuesByRecord filters edges whose foreign record no longer exists —
 *       and (F21) edges whose foreign record lives in a SOFT-DELETED sheet.
 *   (ii) sheet delete: DELETE /sheets/:id is now a SOFT delete. It keeps the sheet's records and every
 *        inbound edge (so POST /sheets/:id/restore is complete) and relies on (i) to hide them.
 * Goldens: (a) a manually-inserted dangling edge is NOT surfaced as a ghost link id (repair-on-read; RED before);
 * (b) deleting the foreign sheet hides the inbound link from the source while the edge and records survive;
 * (c) restoring the sheet makes the link readable again.
 * Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { canonicalSheetFenceKey } from '../../src/multitable/canonical-sheet-fence'
import { prepareSheetLinkDeleteFencePlan } from '../../src/multitable/link-writer-fence'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const FLAG = 'MULTITABLE_ENABLE_WRITER_FENCE'
const ORIGINAL_FLAG = process.env[FLAG]
const TS = Date.now()
const BASE = `base_dl_${TS}`
const SA = `sheet_dl_a_${TS}` // source sheet (has the link field)
const SB = `sheet_dl_b_${TS}` // foreign target sheet (deleted in golden b)
const SC = `sheet_dl_c_${TS}` // configured outbound target of the deleted sheet
const SD = `sheet_dl_d_${TS}` // late inbound participant used by the drift golden
const FLD_LINK = `fld_dl_link_${TS}`
const FLD_B = `fld_dl_b_${TS}`
const FLD_OUT = `fld_dl_out_${TS}`
const FLD_LATE = `fld_dl_late_${TS}`
const RA = `rec_dl_a_${TS}`
const RB = `rec_dl_b_${TS}`
const RD = `rec_dl_d_${TS}`
const GHOST = `rec_dl_ghost_${TS}` // never inserted into meta_records → a dangling foreign_record_id
const U = `u_dl_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const buildApp = (): Express => {
  const a = express(); a.use(express.json())
  // F21: deleting a sheet now takes SCHEMA authority (`canManageFields` = admin or
  // multitable:manage-schema), not the record-write tier — a write-only operator is refused
  // (pinned in tests/integration/multitable-context.api.test.ts). This suite is about link
  // referential integrity, not about the gate, so its actor holds the schema code.
  a.use((req, _res, next) => { ;(req as { user?: unknown }).user = { id: U, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:manage-schema'], permissions: ['multitable:read', 'multitable:write', 'multitable:manage-schema'] }; next() })
  a.use('/api/multitable', univerMetaRouter()); return a
}
const linkValue = async (recId: string): Promise<unknown[]> => {
  const res = await request(buildApp()).get(`/api/multitable/records/${recId}`)
  expect(res.status).toBe(200)
  const v = res.body?.data?.record?.data?.[FLD_LINK]
  return Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : (x as { id?: string })?.id ?? x)) : []
}
const inboundEdgeCount = async (foreignId: string): Promise<number> =>
  Number(((await q('SELECT count(*)::int AS n FROM meta_links WHERE foreign_record_id=$1', [foreignId])).rows[0] as { n: number }).n)
// F21: `DELETE /sheets/:id` is now a SOFT delete (`deleted_at`), so the row survives on purpose —
// "deleted" is a deleted_at fact, not an absent row. Every product listing filters the same way.
const sheetIsLive = async (sheetId: string): Promise<boolean> =>
  (await q('SELECT 1 FROM meta_sheets WHERE id=$1 AND deleted_at IS NULL', [sheetId])).rows.length === 1
const sheetRowSurvives = async (sheetId: string): Promise<boolean> =>
  (await q('SELECT 1 FROM meta_sheets WHERE id=$1', [sheetId])).rows.length === 1
const recordCount = async (sheetId: string): Promise<number> =>
  Number(((await q('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id=$1', [sheetId])).rows[0] as { n: number }).n)
const setBlock = (sheetId: string, state: 'applying' | null) =>
  q('UPDATE meta_sheets SET recovery_writer_state=$2 WHERE id=$1', [sheetId, state])

type Client = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>
  release: () => void
}
const connect = async (): Promise<Client> => {
  const internal = poolManager.get().getInternalPool()
  if (!internal) throw new Error('no internal pool')
  return await internal.connect() as unknown as Client
}
const waitForAdvisoryWaiter = async (blockerPid: number): Promise<void> => {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await q(
      `SELECT count(*)::int AS n
         FROM pg_stat_activity
        WHERE datname=current_database()
          AND wait_event_type='Lock'
          AND wait_event='advisory'
          AND $1::int = ANY(pg_blocking_pids(pid))`,
      [blockerPid],
    )
    if (Number((result.rows[0] as { n: number }).n) > 0) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('sheet delete did not park on the canonical fence')
}
const settleWhileRowLockHeld = async <T>(promise: Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('sheet delete waited on an unfenced row lock')), 3_000)
    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })

describeIfDatabase('multitable dangling-link referential integrity (real DB)', () => {
  beforeEach(async () => {
    delete process.env[FLAG]
    const sheets = [SA, SB, SC, SD]
    await q('DELETE FROM meta_links WHERE field_id = ANY($1::text[])', [[FLD_LINK, FLD_OUT, FLD_LATE]]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [sheets]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id=$1', [BASE]).catch(() => {})
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'DL Base'])
    for (const [sheetId, name] of [[SA, 'DL A'], [SB, 'DL B'], [SC, 'DL C'], [SD, 'DL D']] as const) {
      await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [sheetId, BASE, name])
    }
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_B, SB, 'BF', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LINK, SA, 'Link', 'link', JSON.stringify({ foreignSheetId: SB }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_OUT, SB, 'Outbound', 'link', JSON.stringify({ foreignSheetId: SC }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LATE, SD, 'Late', 'link', JSON.stringify({ foreignSheetId: SB }), 1])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [U])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [RB, SB, JSON.stringify({ [FLD_B]: 'b-val' })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [RA, SA, JSON.stringify({ [FLD_LINK]: [RB] })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [RD, SD, '{}'])
    // authoritative edge RA → RB (meta_links is the source of truth, not data[FLD_LINK])
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_dl_real_${TS}`, FLD_LINK, RA, RB])
  })
  afterAll(async () => {
    if (ORIGINAL_FLAG === undefined) delete process.env[FLAG]
    else process.env[FLAG] = ORIGINAL_FLAG
    const sheets = [SA, SB, SC, SD]
    await q('DELETE FROM meta_links WHERE field_id = ANY($1::text[])', [[FLD_LINK, FLD_OUT, FLD_LATE]]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [sheets]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id=$1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id=$1', [U]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('sheet-delete plan is query-inert while the writer fence is off', async () => {
    let queries = 0
    const plan = await prepareSheetLinkDeleteFencePlan(async () => {
      queries += 1
      return { rows: [] }
    }, SB)
    expect(plan).toBeNull()
    expect(queries).toBe(0)
  })

  test('(a) repair-on-read: a dangling inbound edge (foreign record never existed) is NOT surfaced as a ghost link id', async () => {
    // foreign_record_id has no FK → a dangling edge is insertable; it must be filtered on read.
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_dl_ghost_${TS}`, FLD_LINK, RA, GHOST])
    const v = await linkValue(RA)
    expect(v).toContain(RB) // the real linked record still surfaces
    expect(v).not.toContain(GHOST) // the dangling edge is filtered (RED before the repair-on-read fix)
  })

  // F21 — this golden's MECHANISM changed deliberately; its OBSERVABLE contract did not.
  //
  // Before: the delete destroyed the sheet's records, so the inbound edge had to be destroyed too
  // (`foreign_record_id` carries no FK) or it would dangle and surface as a ghost.
  // Now: the delete is SOFT, so nothing is destroyed and there is nothing to dangle. The edge is KEPT
  // on purpose — that is what makes `POST /sheets/:sheetId/restore` complete — and the READ path hides
  // it instead (repair-on-read now also requires the foreign record's sheet to be live).
  //
  // So the assertion that MATTERS — "the source reads no ghost" — is unchanged and still enforced.
  // The row-level assertion is inverted, and its inversion is the recoverability guarantee.
  test('(b) sheet delete: the source reads no link into a deleted sheet, and the edge + records survive for a restore', async () => {
    expect(await inboundEdgeCount(RB)).toBe(1) // RA → RB edge exists pre-delete
    expect(await linkValue(RA)).toContain(RB) // ... and it is visible pre-delete (this leg is not vacuous)
    const del = await request(buildApp()).delete(`/api/multitable/sheets/${SB}`)
    expect(del.status).toBe(200)
    expect(await linkValue(RA)).not.toContain(RB) // the source shows no link into the deleted sheet
    expect(await inboundEdgeCount(RB)).toBe(1) // the edge SURVIVES (soft delete — restorable)
    expect(await recordCount(SB)).toBeGreaterThan(0) // the records survive too
    expect(await sheetRowSurvives(SB)).toBe(true)
    expect(await sheetIsLive(SB)).toBe(false)
  })

  test('restore brings the sheet, its records and its inbound links back', async () => {
    expect((await request(buildApp()).delete(`/api/multitable/sheets/${SB}`)).status).toBe(200)
    expect(await sheetIsLive(SB)).toBe(false)
    expect(await linkValue(RA)).not.toContain(RB)

    const restore = await request(buildApp()).post(`/api/multitable/sheets/${SB}/restore`)
    expect(restore.status).toBe(200)
    expect(restore.body.data.restored).toBe(SB)
    expect(await sheetIsLive(SB)).toBe(true)
    expect(await inboundEdgeCount(RB)).toBe(1)
    expect(await linkValue(RA)).toContain(RB) // the link is readable again — the restore is complete

    // Restoring a live sheet is not a no-op success: there is nothing to restore.
    const again = await request(buildApp()).post(`/api/multitable/sheets/${SB}/restore`)
    expect(again.status).toBe(404)
    expect(again.body.error.code).toBe('NOT_FOUND')
  })

  test('writer-fence ON preserves the successful sheet-delete contract when every participant is available', async () => {
    process.env[FLAG] = 'true'
    const response = await request(buildApp()).delete(`/api/multitable/sheets/${SB}`)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true, data: { deleted: SB } })
    expect(await sheetIsLive(SB)).toBe(false)
    // Soft delete: the edge is retained for the restore; the read path is what hides it.
    expect(await inboundEdgeCount(RB)).toBe(1)
    expect(await linkValue(RA)).not.toContain(RB)
  })

  test('sheet delete refuses a blocked inbound source before deleting the target or its edge', async () => {
    process.env[FLAG] = 'true'
    await setBlock(SA, 'applying')
    const response = await request(buildApp()).delete(`/api/multitable/sheets/${SB}`)
    expect(response.status).toBe(409)
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'RECOVERY_IN_PROGRESS',
        message: 'Another recovery operation is in progress on this sheet; retry shortly.',
      },
    })
    expect(JSON.stringify(response.body)).not.toContain(SA)
    expect(JSON.stringify(response.body)).not.toContain(SB)
    expect(await sheetIsLive(SB)).toBe(true)
    expect(await inboundEdgeCount(RB)).toBe(1)
  })

  test('sheet delete refuses a blocked configured outbound target even when no edge exists yet', async () => {
    process.env[FLAG] = 'true'
    await setBlock(SC, 'applying')
    const response = await request(buildApp()).delete(`/api/multitable/sheets/${SB}`)
    expect(response.status).toBe(409)
    expect(response.body.error).toEqual({
      code: 'RECOVERY_IN_PROGRESS',
      message: 'Another recovery operation is in progress on this sheet; retry shortly.',
    })
    expect(await sheetIsLive(SB)).toBe(true)
    expect(await inboundEdgeCount(RB)).toBe(1)
  })

  test('sheet delete refuses its own durable block even when the sheet has no links', async () => {
    process.env[FLAG] = 'true'
    await setBlock(SC, 'applying')
    const response = await request(buildApp()).delete(`/api/multitable/sheets/${SC}`)
    expect(response.status).toBe(409)
    expect(response.body.error).toEqual({
      code: 'RECOVERY_IN_PROGRESS',
      message: 'Another recovery operation is in progress on this sheet; retry shortly.',
    })
    expect(await sheetIsLive(SC)).toBe(true)
  })

  test('sheet delete fails closed instead of waiting behind a concurrent sheet-row owner', async () => {
    process.env[FLAG] = 'true'
    const blocker = await connect()
    let responsePromise: ReturnType<typeof request> | null = null
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM meta_sheets WHERE id=$1 FOR UPDATE', [SB])
      responsePromise = request(buildApp()).delete(`/api/multitable/sheets/${SB}`)
      const response = await settleWhileRowLockHeld(responsePromise)
      expect(response.status).toBe(409)
      expect(response.body.error).toEqual({
        code: 'LINK_WRITER_FENCE_PLAN_CHANGED',
        message: 'Sheet link participants changed concurrently; retry the write',
      })
      expect(await sheetIsLive(SB)).toBe(true)
      expect(await inboundEdgeCount(RB)).toBe(1)
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
      if (responsePromise) await responsePromise.catch(() => {})
    }
  })

  test('sheet delete rejects a newly committed inbound participant before any destruction', async () => {
    process.env[FLAG] = 'true'
    const blocker = await connect()
    try {
      await blocker.query('BEGIN')
      const blockerPid = Number(((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number }).pid)
      await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(SB)])

      const responsePromise = request(buildApp())
        .delete(`/api/multitable/sheets/${SB}`)
        .then((response) => response)
      await waitForAdvisoryWaiter(blockerPid)
      await q(
        'INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)',
        [`lnk_dl_late_${TS}`, FLD_LATE, RD, RB],
      )
      await blocker.query('COMMIT')

      const response = await responsePromise
      expect(response.status).toBe(409)
      expect(response.body.error).toEqual({
        code: 'LINK_WRITER_FENCE_PLAN_CHANGED',
        message: 'Sheet link participants changed concurrently; retry the write',
      })
      expect(JSON.stringify(response.body)).not.toContain(SB)
      expect(JSON.stringify(response.body)).not.toContain(SD)
      expect(await sheetIsLive(SB)).toBe(true)
      expect(await inboundEdgeCount(RB)).toBe(2)
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
    }
  })
})
