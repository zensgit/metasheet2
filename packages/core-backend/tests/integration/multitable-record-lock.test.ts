/**
 * Real-DB integration test for record locking (design #2278 follow-up — lock_record storage contract).
 *
 * The lock_record automation action historically UPDATEd a non-existent `meta_records.locked` column
 * (crash at runtime; #2278 only hid it from the rule-editor dropdown). This suite is the FAIL-FIRST
 * canary set for the full storage contract:
 *  - LR-T1  a locked record rejects an EDIT by a canUnlock=false actor
 *  - LR-T2  a locked record rejects a DELETE by a canUnlock=false actor
 *  - LR-T3  comments are a SEPARATE path — a locked record still accepts a comment
 *  - LR-T4  canUnlock's three layers each individually permit (locker / owner / sheet-admin)
 *  - LR-T5  executeLockRecord truly writes the lock columns, then truly clears them on unlock
 *  - LR-T6  an admin is NOT silently bypassed — admin edit on a locked record is rejected until unlock
 *  - LR-T7  pre-existing rows behave as locked=false (regression)
 *  - LR-T10 wire-vs-fixture — locked/locked_by round-trip through the REAL records wire (/view + /records)
 *
 * (LR-T8 migration up/down lives in the unit suite; LR-T9 frontend lives in apps/web jsdom.)
 *
 * The lock columns ride as RECORD-LEVEL METADATA (top-level on the wire), NOT inside `data`, so they
 * are never swept by §2a.3's `filterRecordDataByFieldIds` masking — LR-T10 asserts that round-trip.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { AutomationExecutor } from '../../src/multitable/automation-executor'
import { canUnlock } from '../../src/multitable/record-lock'
import { EventBus } from '../../src/integration/events/event-bus'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_lr_${TS}`
const SHEET_ID = `sheet_lr_${TS}`
const FLD_NAME = `fld_lr_name_${TS}` // string
const OWNER_ID = `u_lr_owner_${TS}` // record creator (created_by)
const STRANGER_ID = `u_lr_stranger_${TS}` // not locker, not owner, not admin → canUnlock=false
const ADMIN_ID = `u_lr_admin_${TS}` // sheet admin (multitable:admin)

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

let app: Express
let currentUser: { id: string; roles: string[]; perms: string[] } = {
  id: STRANGER_ID,
  roles: ['member'],
  perms: ['multitable:write'],
}

const asUser = (id: string, perms: string[], roles: string[] = ['member']) => {
  currentUser = { id, roles, perms }
}

const seedRecord = async (recordId: string, createdBy: string | null, name: string) => {
  await q(
    'INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)',
    [recordId, SHEET_ID, JSON.stringify({ [FLD_NAME]: name }), createdBy],
  )
}

const lockRow = async (recordId: string, lockedBy: string) => {
  await q(
    'UPDATE meta_records SET locked = true, locked_by = $2, locked_at = now() WHERE id = $1',
    [recordId, lockedBy],
  )
}

const patchReq = (recordId: string, body: Record<string, unknown>) =>
  request(app).patch(`/api/multitable/records/${recordId}`).send(body)
const deleteReq = (recordId: string) =>
  request(app).delete(`/api/multitable/records/${recordId}`)
const viewReq = () =>
  request(app).get('/api/multitable/view').query({ sheetId: SHEET_ID })
const listReq = () =>
  request(app).get('/api/multitable/records').query({ sheetId: SHEET_ID })

const dbLock = async (recordId: string) => {
  const r = await q('SELECT locked, locked_by, locked_at FROM meta_records WHERE id = $1', [recordId])
  return r.rows[0] as { locked: boolean; locked_by: string | null; locked_at: unknown } | undefined
}

describeIfDatabase('record locking (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = currentUser
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'LR Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'LR Sheet'])
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_NAME, SHEET_ID, 'Name', 'string', '{}', 1],
    )
  })

  afterAll(async () => {
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID])
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID])
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID])
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID])
  })

  test('LR-T1: a locked record rejects an EDIT by a canUnlock=false actor', async () => {
    const recId = `rec_lr_t1_${TS}`
    await seedRecord(recId, OWNER_ID, 'before')
    await lockRow(recId, OWNER_ID) // locked by the owner, NOT the stranger
    asUser(STRANGER_ID, ['multitable:write'])

    const res = await patchReq(recId, { data: { [FLD_NAME]: 'after' } })
    expect(res.status).toBe(403)

    // and the value must NOT have changed
    const r = await q('SELECT data FROM meta_records WHERE id = $1', [recId])
    expect((r.rows[0]?.data as Record<string, unknown>)?.[FLD_NAME]).toBe('before')
  })

  test('LR-T2: a locked record rejects a DELETE by a canUnlock=false actor', async () => {
    const recId = `rec_lr_t2_${TS}`
    await seedRecord(recId, OWNER_ID, 'keep')
    await lockRow(recId, OWNER_ID)
    asUser(STRANGER_ID, ['multitable:write'])

    const res = await deleteReq(recId)
    expect(res.status).toBe(403)

    const r = await q('SELECT id FROM meta_records WHERE id = $1', [recId])
    expect(r.rows.length).toBe(1) // still present
  })

  test('LR-T3: comments are a separate path — a locked record still accepts a comment', async () => {
    const recId = `rec_lr_t3_${TS}`
    await seedRecord(recId, OWNER_ID, 'commentable')
    await lockRow(recId, OWNER_ID)

    // The comment store has no lock awareness and no FK to meta_records: a comment on a locked
    // record persists exactly as on an unlocked one (decision d — comments bypass the lock guard).
    const commentId = `cmt_lr_t3_${TS}`
    await q(
      `INSERT INTO meta_comments (id, spreadsheet_id, row_id, target_id, container_id, content, author_id)
       VALUES ($1,$2,$3,$3,$2,$4,$5)`,
      [commentId, SHEET_ID, recId, 'a comment on a locked record', STRANGER_ID],
    )
    const r = await q('SELECT id FROM meta_comments WHERE id = $1', [commentId])
    expect(r.rows.length).toBe(1)
  })

  test('LR-T4: canUnlock three layers each individually permit', () => {
    const caps = { canManageSheetAccess: false }
    const adminCaps = { canManageSheetAccess: true }
    const record = { lockedBy: OWNER_ID, createdBy: OWNER_ID }

    // locker
    expect(canUnlock(OWNER_ID, { lockedBy: OWNER_ID, createdBy: 'someone-else' }, caps)).toBe(true)
    // owner (locked by a third party)
    expect(canUnlock(OWNER_ID, { lockedBy: 'someone-else', createdBy: OWNER_ID }, caps)).toBe(true)
    // sheet admin (neither locker nor owner)
    expect(canUnlock(ADMIN_ID, { lockedBy: 'x', createdBy: 'y' }, adminCaps)).toBe(true)
    // none of the three → denied
    expect(canUnlock(STRANGER_ID, record, caps)).toBe(false)
  })

  test('LR-T5: executeLockRecord writes the lock columns, then clears them on unlock', async () => {
    const recId = `rec_lr_t5_${TS}`
    await seedRecord(recId, OWNER_ID, 'automate-me')

    const executor = new AutomationExecutor({
      eventBus: new EventBus(),
      queryFn: (sql: string, params?: unknown[]) => poolManager.get().query(sql, params),
    })

    const baseRule = {
      id: `rule_lr_${TS}`,
      name: 'Lock rule',
      sheetId: SHEET_ID,
      trigger: { type: 'record.updated' as const, config: {} },
      enabled: true,
      createdBy: ADMIN_ID,
      createdAt: '2026-01-01T00:00:00Z',
    }
    const triggerEvent = { recordId: recId, sheetId: SHEET_ID, actorId: ADMIN_ID, data: {} }

    // LOCK
    const lockExec = await executor.execute(
      { ...baseRule, actions: [{ type: 'lock_record', config: { locked: true } }] },
      triggerEvent,
    )
    expect(lockExec.steps[0]?.status).toBe('success')
    const afterLock = await dbLock(recId)
    expect(afterLock?.locked).toBe(true)
    expect(afterLock?.locked_by).toBe(ADMIN_ID)
    expect(afterLock?.locked_at).not.toBeNull()

    // UNLOCK (config.locked === false)
    const unlockExec = await executor.execute(
      { ...baseRule, actions: [{ type: 'lock_record', config: { locked: false } }] },
      triggerEvent,
    )
    expect(unlockExec.steps[0]?.status).toBe('success')
    const afterUnlock = await dbLock(recId)
    expect(afterUnlock?.locked).toBe(false)
    expect(afterUnlock?.locked_by).toBeNull()
    expect(afterUnlock?.locked_at).toBeNull()
  })

  test('LR-T6: an admin is NOT silently bypassed — admin edit on a locked record is rejected until unlock', async () => {
    const recId = `rec_lr_t6_${TS}`
    await seedRecord(recId, OWNER_ID, 'admin-cannot-edit-blindly')
    await lockRow(recId, OWNER_ID)

    // NOTE: decision e — even an admin must explicitly unlock first. But the admin IS a canUnlock
    // layer (canManageSheetAccess), so for decision e to be testable the guard must reject a DIRECT
    // edit when the record is still locked. To isolate "no silent bypass" from "admin can unlock",
    // this asserts the admin's edit is rejected while locked, then succeeds after an explicit unlock.
    asUser(ADMIN_ID, ['multitable:admin', 'multitable:write'], ['admin'])

    const blocked = await patchReq(recId, { data: { [FLD_NAME]: 'sneaky' } })
    expect(blocked.status).toBe(403)

    // explicit unlock (admin clears the lock), then the edit succeeds
    await q('UPDATE meta_records SET locked = false, locked_by = NULL, locked_at = NULL WHERE id = $1', [recId])
    const ok = await patchReq(recId, { data: { [FLD_NAME]: 'after-unlock' } })
    expect(ok.status).toBe(200)
  })

  test('LR-T7: pre-existing rows behave as locked=false (regression)', async () => {
    const recId = `rec_lr_t7_${TS}`
    await seedRecord(recId, STRANGER_ID, 'never-locked')
    asUser(STRANGER_ID, ['multitable:write'])

    const dbRow = await dbLock(recId)
    expect(dbRow?.locked).toBe(false)

    // an unlocked record edits freely
    const res = await patchReq(recId, { data: { [FLD_NAME]: 'edited' } })
    expect(res.status).toBe(200)
  })

  test('LR-T10: locked/locked_by round-trip through the real records wire (/view + /records)', async () => {
    const recId = `rec_lr_t10_${TS}`
    await seedRecord(recId, OWNER_ID, 'wire-roundtrip')
    await lockRow(recId, OWNER_ID)
    asUser(ADMIN_ID, ['multitable:admin', 'multitable:write'], ['admin'])

    // (a) GET /view (primary grid loader)
    const viewRes = await viewReq()
    expect(viewRes.status).toBe(200)
    const viewRow = (viewRes.body.data.rows as Array<Record<string, unknown>>).find((r) => r.id === recId)
    expect(viewRow).toBeDefined()
    expect(viewRow?.locked).toBe(true)
    expect(viewRow?.lockedBy).toBe(OWNER_ID)
    expect(typeof viewRow?.lockedAt).toBe('string')
    // lock metadata is TOP-LEVEL, never inside data
    expect((viewRow?.data as Record<string, unknown>)?.locked).toBeUndefined()

    // (b) GET /records (cursor list)
    const listRes = await listReq()
    expect(listRes.status).toBe(200)
    const listRow = (listRes.body.data.records as Array<Record<string, unknown>>).find((r) => r.id === recId)
    expect(listRow).toBeDefined()
    expect(listRow?.locked).toBe(true)
    expect(listRow?.lockedBy).toBe(OWNER_ID)
  })
})
