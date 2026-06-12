/**
 * Real-DB regression canaries for the rank-8 review — record locking must hold across EVERY mutation
 * path, not just the three named ones (single PATCH / bulk PATCH / single DELETE, covered by
 * `multitable-record-lock.test.ts`). The adversarial review found four advisory-only paths:
 *
 *  - LRX-B1  automation `update_record` overwrote a locked record (automation-executor.ts)
 *  - LRX-B2  authenticated form-submit EDIT mode overwrote a locked record (POST /views/:id/submit)
 *  - LRX-B3  DELETE /attachments/:id removed an attachment from a locked record (an edit of its data)
 *  - LRX-M1  plugin-SDK bare patchRecord / deleteRecord (records.ts) — actor-less, must be hard read-only
 *
 * Each canary seeds a record LOCKED BY THE OWNER, then attempts the mutation as a non-`canEditWhileLocked`
 * actor (a plain `multitable:write` STRANGER — not locker, owner, or admin) and asserts the mutation is
 * REJECTED and the row is byte-for-byte unchanged. These FAIL-FIRST on HEAD (the paths bypassed the lock)
 * and pass once every path routes through `ensureRecordNotLocked`.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { AutomationExecutor } from '../../src/multitable/automation-executor'
import { EventBus } from '../../src/integration/events/event-bus'
import { patchRecord, deleteRecord } from '../../src/multitable/records'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_lrx_${TS}`
const SHEET_ID = `sheet_lrx_${TS}`
const VIEW_ID = `view_lrx_${TS}`
const FLD_NAME = `fld_lrx_name_${TS}` // string
const FLD_ATT = `fld_lrx_att_${TS}` // attachment
const OWNER_ID = `u_lrx_owner_${TS}` // record creator + locker
const STRANGER_ID = `u_lrx_stranger_${TS}` // plain write member — not locker/owner/admin → canUnlock=false

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const queryFn = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

let app: Express
let currentUser: { id: string; roles: string[]; perms: string[] } = {
  id: STRANGER_ID,
  roles: ['member'],
  perms: ['multitable:write'],
}

const asUser = (id: string, perms: string[], roles: string[] = ['member']) => {
  currentUser = { id, roles, perms }
}

const seedLockedRecord = async (recordId: string, name: string, extra: Record<string, unknown> = {}) => {
  await q(
    'INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)',
    [recordId, SHEET_ID, JSON.stringify({ [FLD_NAME]: name, ...extra }), OWNER_ID],
  )
  await q(
    'UPDATE meta_records SET locked = true, locked_by = $2, locked_at = now() WHERE id = $1',
    [recordId, OWNER_ID], // locked by the OWNER, not the stranger
  )
}

const readData = async (recordId: string) => {
  const r = await q('SELECT data FROM meta_records WHERE id = $1', [recordId])
  return (r.rows[0]?.data as Record<string, unknown> | undefined) ?? undefined
}

describeIfDatabase('record lock — every-mutation-path bypass canaries (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as { user?: unknown }).user = currentUser
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'LRX Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'LRX Sheet'])
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_NAME, SHEET_ID, 'Name', 'string', '{}', 1],
    )
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_ATT, SHEET_ID, 'Files', 'attachment', '{}', 2],
    )
    await q(
      'INSERT INTO meta_views (id, sheet_id, name, type, config) VALUES ($1,$2,$3,$4,$5::jsonb)',
      [VIEW_ID, SHEET_ID, 'LRX Form', 'form', '{}'],
    )
  })

  afterAll(async () => {
    await q('DELETE FROM multitable_attachments WHERE sheet_id = $1', [SHEET_ID])
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID])
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET_ID])
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID])
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID])
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID])
  })

  test('LRX-B1: automation update_record cannot overwrite a record locked by another actor', async () => {
    const recId = `rec_lrx_b1_${TS}`
    await seedLockedRecord(recId, 'before')

    const executor = new AutomationExecutor({ eventBus: new EventBus(), queryFn })
    const rule = {
      id: `rule_lrx_b1_${TS}`,
      name: 'Overwrite rule',
      sheetId: SHEET_ID,
      trigger: { type: 'record.updated' as const, config: {} },
      enabled: true,
      createdBy: STRANGER_ID,
      createdAt: '2026-01-01T00:00:00Z',
      actions: [{ type: 'update_record', config: { fields: { [FLD_NAME]: 'AUTOMATION-OVERWROTE' } } }],
    }
    // actorId = the stranger — NOT the locker/owner → must be blocked (decision f: author unlocks first).
    const triggerEvent = { recordId: recId, sheetId: SHEET_ID, actorId: STRANGER_ID, data: {} }

    const exec = await executor.execute(rule, triggerEvent)
    expect(exec.steps[0]?.status).toBe('failed')
    expect(String(exec.steps[0]?.error ?? '')).toMatch(/lock/i)

    expect((await readData(recId))?.[FLD_NAME]).toBe('before') // unchanged
  })

  test('LRX-B2: authenticated form-submit EDIT cannot overwrite a locked record', async () => {
    const recId = `rec_lrx_b2_${TS}`
    await seedLockedRecord(recId, 'before')
    asUser(STRANGER_ID, ['multitable:write'])

    const res = await request(app)
      .post(`/api/multitable/views/${VIEW_ID}/submit`)
      .send({ recordId: recId, data: { [FLD_NAME]: 'FORM-OVERWROTE' } })
    expect(res.status).toBe(403)

    expect((await readData(recId))?.[FLD_NAME]).toBe('before') // unchanged
  })

  test('LRX-B3: DELETE /attachments cannot remove an attachment from a locked record', async () => {
    const recId = `rec_lrx_b3_${TS}`
    const attId = `att_lrx_b3_${TS}`
    await seedLockedRecord(recId, 'before', { [FLD_ATT]: [attId] })
    await q(
      `INSERT INTO multitable_attachments
         (id, sheet_id, record_id, field_id, storage_file_id, filename, original_name, mime_type, size, storage_path, storage_provider, metadata, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
      [attId, SHEET_ID, recId, FLD_ATT, `sf_${attId}`, 'f.txt', 'f.txt', 'text/plain', 3, `/tmp/${attId}`, 'local', '{}', OWNER_ID],
    )
    asUser(STRANGER_ID, ['multitable:write'])

    const res = await request(app).delete(`/api/multitable/attachments/${attId}`)
    expect(res.status).toBe(403)

    // the attachment id is still in the locked record's data AND the row not soft-deleted
    expect((await readData(recId))?.[FLD_ATT]).toEqual([attId])
    const att = await q('SELECT deleted_at FROM multitable_attachments WHERE id = $1', [attId])
    expect((att.rows[0] as { deleted_at: unknown } | undefined)?.deleted_at).toBeNull()
  })

  test('LRX-M1a: plugin-SDK patchRecord cannot edit a locked record (actor-less → hard read-only)', async () => {
    const recId = `rec_lrx_m1a_${TS}`
    await seedLockedRecord(recId, 'before')

    await expect(
      patchRecord({ query: queryFn, sheetId: SHEET_ID, recordId: recId, changes: { [FLD_NAME]: 'PLUGIN-OVERWROTE' } }),
    ).rejects.toThrow(/lock/i)

    expect((await readData(recId))?.[FLD_NAME]).toBe('before') // unchanged
  })

  test('LRX-M1b: plugin-SDK deleteRecord cannot delete a locked record', async () => {
    const recId = `rec_lrx_m1b_${TS}`
    await seedLockedRecord(recId, 'keep')

    await expect(
      deleteRecord({ query: queryFn, sheetId: SHEET_ID, recordId: recId }),
    ).rejects.toThrow(/lock/i)

    const r = await q('SELECT id FROM meta_records WHERE id = $1', [recId])
    expect(r.rows.length).toBe(1) // still present
  })
})
