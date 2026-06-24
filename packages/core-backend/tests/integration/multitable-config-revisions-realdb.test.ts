/**
 * T9 config/schema-change history recording — real DB. Mutations append meta_config_revisions rows IN the mutation's
 * transaction (diff-first; no-op records nothing). Read-only: this slice only RECORDS — no read API/gate yet. Runs
 * only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_cr_${TS}`
const SHEET = `sheet_cr_${TS}`
const ACTOR = `user_cr_${TS}`
const SUBJECT = `user_cr_subject_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
const createField = (body: Record<string, unknown>) => request(app).post('/api/multitable/fields').send({ sheetId: SHEET, ...body })
const updateField = (fieldId: string, body: Record<string, unknown>) => request(app).patch(`/api/multitable/fields/${fieldId}`).send(body)
const deleteField = (fieldId: string) => request(app).delete(`/api/multitable/fields/${fieldId}`)
const createView = (body: Record<string, unknown>) => request(app).post('/api/multitable/views').send({ sheetId: SHEET, name: 'View', ...body })
const updateView = (viewId: string, body: Record<string, unknown>) => request(app).patch(`/api/multitable/views/${viewId}`).send(body)
const deleteView = (viewId: string) => request(app).delete(`/api/multitable/views/${viewId}`)
const putSheetPermission = (accessLevel: string) => request(app).put(`/api/multitable/sheets/${SHEET}/permissions/user/${SUBJECT}`).send({ accessLevel })
const putFieldPermission = (fieldId: string, body: Record<string, unknown>) =>
  request(app).put(`/api/multitable/sheets/${SHEET}/field-permissions/${fieldId}/user/${SUBJECT}`).send(body)
const putViewPermission = (viewId: string, permission: string) =>
  request(app).put(`/api/multitable/views/${viewId}/permissions/user/${SUBJECT}`).send({ permission })
const putRowDeny = (enabled: boolean) => request(app).put(`/api/multitable/sheets/${SHEET}/row-level-read-deny`).send({ enabled })
const putConditionalRules = (rules: unknown[]) => request(app).put(`/api/multitable/sheets/${SHEET}/conditional-rules`).send({ rules })
const patchFormShare = (viewId: string, body: Record<string, unknown>) =>
  request(app).patch(`/api/multitable/sheets/${SHEET}/views/${viewId}/form-share`).send(body)
const regenerateFormShare = (viewId: string) =>
  request(app).post(`/api/multitable/sheets/${SHEET}/views/${viewId}/form-share/regenerate`).send({})
const permissionEntityId = (scope: 'field' | 'sheet' | 'view', parts: string[]) => `${scope}:${JSON.stringify(parts)}`
const configRevs = async (entityId?: string) => (await q(
  `SELECT entity_type, entity_id, action, before, after, changed_keys, batch_id, actor_id
   FROM meta_config_revisions WHERE sheet_id = $1 ${entityId ? 'AND entity_id = $2' : ''} ORDER BY created_at DESC, id DESC`,
  entityId ? [SHEET, entityId] : [SHEET],
)).rows as Array<{ entity_type: string; entity_id: string; action: string; before: any; after: any; changed_keys: string[]; batch_id: string | null; actor_id: string | null }>

describeIfDatabase('multitable config-revisions recording — T9-R1 (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: ACTOR, roles: ['owner'], perms: ['multitable:read', 'multitable:write', 'multitable:manage'] }; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'CR Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'CR Sheet'])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [SUBJECT])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_view_permissions WHERE view_id IN (SELECT id FROM meta_views WHERE sheet_id = $1)', [SHEET]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    for (const t of ['meta_views', 'meta_fields', 'meta_records']) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [SUBJECT]).catch(() => {})
  })

  beforeEach(async () => {
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM meta_view_permissions WHERE view_id IN (SELECT id FROM meta_views WHERE sheet_id = $1)', [SHEET]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET])
    await q("UPDATE meta_sheets SET row_level_read_permissions_enabled = false, conditional_read_rules = '[]'::jsonb WHERE id = $1", [SHEET])
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('field CREATE → one config-revision (entity field, action create, after=config, all keys, actor)', async () => {
    const res = await createField({ name: 'Title', type: 'string' })
    expect(res.status).toBe(201)
    const fid = res.body?.data?.field?.id
    const revs = await configRevs(fid)
    expect(revs.length).toBe(1)
    expect(revs[0]).toMatchObject({ entity_type: 'field', entity_id: fid, action: 'create', actor_id: ACTOR })
    expect(revs[0].before).toBeNull()
    expect(revs[0].after).toMatchObject({ name: 'Title', type: 'string' })
    expect(revs[0].changed_keys.sort()).toEqual(['name', 'order', 'property', 'type'])
    expect(revs[0].batch_id).toBeTruthy()
  })

  test('field RENAME → action update, changed_keys=[name] only, before/after the name', async () => {
    const fid = (await createField({ name: 'Old', type: 'string' })).body?.data?.field?.id
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET]) // isolate the update
    const res = await updateField(fid, { name: 'New' })
    expect(res.status).toBe(200)
    const revs = await configRevs(fid)
    expect(revs.length).toBe(1)
    expect(revs[0]).toMatchObject({ action: 'update' })
    expect(revs[0].changed_keys).toEqual(['name'])
    expect(revs[0].before).toMatchObject({ name: 'Old' })
    expect(revs[0].after).toMatchObject({ name: 'New' })
  })

  test('field RETYPE → action update, changed_keys includes type', async () => {
    const fid = (await createField({ name: 'Num', type: 'string' })).body?.data?.field?.id
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET])
    await updateField(fid, { type: 'number' })
    const revs = await configRevs(fid)
    expect(revs.length).toBe(1)
    expect(revs[0].action).toBe('update')
    expect(revs[0].changed_keys).toContain('type')
  })

  test('field NO-OP update (rename to the same name) records NOTHING', async () => {
    const fid = (await createField({ name: 'Same', type: 'string' })).body?.data?.field?.id
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET])
    await updateField(fid, { name: 'Same' })
    expect((await configRevs(fid)).length).toBe(0) // empty diff → no spam
  })

  test('field DELETE → action delete, before=config, after=null, batch_id (for the R2 cascade)', async () => {
    const fid = (await createField({ name: 'Gone', type: 'string' })).body?.data?.field?.id
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET])
    await deleteField(fid)
    const revs = await configRevs(fid)
    expect(revs.length).toBe(1)
    expect(revs[0].action).toBe('delete')
    expect(revs[0].before).toMatchObject({ name: 'Gone', type: 'string' })
    expect(revs[0].after).toBeNull()
    expect(revs[0].batch_id).toBeTruthy()
  })

  test('deterministic order + no record-value leakage (config-only columns)', async () => {
    const a = (await createField({ name: 'A', type: 'string' })).body?.data?.field?.id
    const b = (await createField({ name: 'B', type: 'string' })).body?.data?.field?.id
    const revs = await configRevs()
    expect(revs.length).toBe(2)
    expect(revs[0].entity_id).toBe(b) // most-recent first (created_at DESC, id DESC)
    expect(revs[1].entity_id).toBe(a)
    // structure-only: the row carries config keys, never a record-data column
    for (const r of revs) expect(Object.keys(r.after ?? {}).sort()).toEqual(['name', 'order', 'property', 'type'])
  })

  test('MIDDLE INSERT: create at order 0 shifts existing fields — each shift recorded under ONE batchId', async () => {
    const a = (await createField({ name: 'A', type: 'string' })).body?.data?.field?.id // order 0
    const b = (await createField({ name: 'B', type: 'string' })).body?.data?.field?.id // order 1
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET])
    const c = (await createField({ name: 'C', type: 'string', order: 0 })).body?.data?.field?.id // insert at front → A,B shift +1
    const revs = await configRevs()
    expect(revs.length).toBe(3) // C create + A,B order shifts (previously only C was recorded — the [P2] gap)
    const byId = Object.fromEntries(revs.map((r) => [r.entity_id, r]))
    expect(byId[c].action).toBe('create')
    expect(byId[a]).toMatchObject({ action: 'update' }); expect(byId[a].changed_keys).toEqual(['order'])
    expect(byId[a].before).toMatchObject({ order: 0 }); expect(byId[a].after).toMatchObject({ order: 1 })
    expect(byId[b].before).toMatchObject({ order: 1 }); expect(byId[b].after).toMatchObject({ order: 2 })
    expect(new Set(revs.map((r) => r.batch_id)).size).toBe(1) // one logical operation = one batchId
  })

  test('REORDER: moving a field shifts the fields between it — each recorded under ONE batchId', async () => {
    const a = (await createField({ name: 'A', type: 'string' })).body?.data?.field?.id // 0
    const b = (await createField({ name: 'B', type: 'string' })).body?.data?.field?.id // 1
    const c = (await createField({ name: 'C', type: 'string' })).body?.data?.field?.id // 2
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET])
    await updateField(a, { order: 2 }) // A 0→2 ; B,C shift -1
    const revs = await configRevs()
    expect(revs.length).toBe(3) // A update + B,C shifts
    const byId = Object.fromEntries(revs.map((r) => [r.entity_id, r]))
    expect(byId[a].action).toBe('update'); expect(byId[a].changed_keys).toContain('order')
    expect(byId[b].changed_keys).toEqual(['order']); expect(byId[c].changed_keys).toEqual(['order'])
    expect(new Set(revs.map((r) => r.batch_id)).size).toBe(1)
  })

  test('DELETE shift: deleting a middle field shifts later fields -1 — recorded under ONE batchId', async () => {
    const a = (await createField({ name: 'A', type: 'string' })).body?.data?.field?.id // 0
    const b = (await createField({ name: 'B', type: 'string' })).body?.data?.field?.id // 1
    const c = (await createField({ name: 'C', type: 'string' })).body?.data?.field?.id // 2
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET])
    await deleteField(b) // B deleted (order 1) ; C shifts 2→1
    const revs = await configRevs()
    expect(revs.length).toBe(2) // B delete + C shift
    const byId = Object.fromEntries(revs.map((r) => [r.entity_id, r]))
    expect(byId[b].action).toBe('delete')
    expect(byId[c].changed_keys).toEqual(['order'])
    expect(byId[c].before).toMatchObject({ order: 2 }); expect(byId[c].after).toMatchObject({ order: 1 })
    expect(new Set(revs.map((r) => r.batch_id)).size).toBe(1)
    void a // a unused beyond setup
  })

  test('field permission create/update/delete records the changed subject grant only', async () => {
    const fid = (await createField({ name: 'Secured', type: 'string' })).body?.data?.field?.id
    const entityId = permissionEntityId('field', [fid, 'user', SUBJECT])
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET])

    expect((await putFieldPermission(fid, { visible: false, readOnly: true })).status).toBe(200)
    let revs = await configRevs(entityId)
    expect(revs.length).toBe(1)
    expect(revs[0]).toMatchObject({ entity_type: 'permission', action: 'create', actor_id: ACTOR })
    expect(revs[0].before).toBeNull()
    expect(revs[0].after).toMatchObject({ fieldId: fid, subjectType: 'user', subjectId: SUBJECT, visible: false, readOnly: true })

    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET])
    expect((await putFieldPermission(fid, { visible: false, readOnly: false })).status).toBe(200)
    revs = await configRevs(entityId)
    expect(revs.length).toBe(1)
    expect(revs[0]).toMatchObject({ action: 'update' })
    expect(revs[0].changed_keys).toEqual(['readOnly'])
    expect(revs[0].before).toMatchObject({ readOnly: true })
    expect(revs[0].after).toMatchObject({ readOnly: false })

    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET])
    expect((await putFieldPermission(fid, { remove: true })).status).toBe(200)
    revs = await configRevs(entityId)
    expect(revs.length).toBe(1)
    expect(revs[0]).toMatchObject({ action: 'delete' })
    expect(revs[0].before).toMatchObject({ fieldId: fid, subjectId: SUBJECT, visible: false, readOnly: false })
    expect(revs[0].after).toBeNull()
  })

  test('sheet and view permission changes record permission revisions without whole-list leakage', async () => {
    const sheetEntityId = permissionEntityId('sheet', ['user', SUBJECT])
    expect((await putSheetPermission('write')).status).toBe(200)
    let revs = await configRevs(sheetEntityId)
    expect(revs.length).toBe(1)
    expect(revs[0]).toMatchObject({ entity_type: 'permission', action: 'create' })
    expect(revs[0].after).toMatchObject({ subjectType: 'user', subjectId: SUBJECT, accessLevel: 'write' })

    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET])
    expect((await putSheetPermission('read')).status).toBe(200)
    revs = await configRevs(sheetEntityId)
    expect(revs.length).toBe(1)
    expect(revs[0].changed_keys).toEqual(['accessLevel'])
    expect(revs[0].before).toMatchObject({ accessLevel: 'write' })
    expect(revs[0].after).toMatchObject({ accessLevel: 'read' })

    const viewId = (await createView({ name: 'Perm View' })).body?.data?.view?.id
    const viewEntityId = permissionEntityId('view', [viewId, 'user', SUBJECT])
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET])
    expect((await putViewPermission(viewId, 'admin')).status).toBe(200)
    revs = await configRevs(viewEntityId)
    expect(revs.length).toBe(1)
    expect(revs[0]).toMatchObject({ entity_type: 'permission', action: 'create' })
    expect(revs[0].after).toMatchObject({ viewId, subjectType: 'user', subjectId: SUBJECT, permission: 'admin' })

    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET])
    expect((await putViewPermission(viewId, 'none')).status).toBe(200)
    revs = await configRevs(viewEntityId)
    expect(revs.length).toBe(1)
    expect(revs[0]).toMatchObject({ action: 'delete' })
    expect(revs[0].before).toMatchObject({ permission: 'admin' })
    expect(revs[0].after).toBeNull()
  })

  test('view create/update/delete records diff-first view config revisions', async () => {
    const fieldId = (await createField({ name: 'Status', type: 'string' })).body?.data?.field?.id
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET])

    const create = await createView({
      name: 'Roadmap',
      type: 'grid',
      filterInfo: { conditions: [{ fieldId, operator: 'contains', value: 'open' }] },
      hiddenFieldIds: [fieldId],
    })
    expect(create.status).toBe(201)
    const viewId = create.body?.data?.view?.id
    let revs = await configRevs(viewId)
    expect(revs.length).toBe(1)
    expect(revs[0]).toMatchObject({ entity_type: 'view', action: 'create' })
    expect(revs[0].before).toBeNull()
    expect(revs[0].after).toMatchObject({ name: 'Roadmap', type: 'grid', hiddenFieldIds: [fieldId] })

    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET])
    expect((await updateView(viewId, { name: 'Roadmap v2', hiddenFieldIds: [] })).status).toBe(200)
    revs = await configRevs(viewId)
    expect(revs.length).toBe(1)
    expect(revs[0]).toMatchObject({ action: 'update' })
    expect(revs[0].changed_keys.sort()).toEqual(['hiddenFieldIds', 'name'])
    expect(revs[0].before).toMatchObject({ name: 'Roadmap', hiddenFieldIds: [fieldId] })
    expect(revs[0].after).toMatchObject({ name: 'Roadmap v2', hiddenFieldIds: [] })

    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET])
    expect((await deleteView(viewId)).status).toBe(200)
    revs = await configRevs(viewId)
    expect(revs.length).toBe(1)
    expect(revs[0]).toMatchObject({ action: 'delete' })
    expect(revs[0].before).toMatchObject({ name: 'Roadmap v2', type: 'grid' })
    expect(revs[0].after).toBeNull()
  })

  test('field delete view-config cascade records a view update under the field-delete batch', async () => {
    const keepId = (await createField({ name: 'Keep', type: 'string' })).body?.data?.field?.id
    const doomedId = (await createField({ name: 'Doomed', type: 'string' })).body?.data?.field?.id
    const viewId = (await createView({
      name: 'Cascade View',
      filterInfo: { conditions: [{ fieldId: doomedId, operator: 'contains', value: 'x' }] },
      sortInfo: { rules: [{ fieldId: doomedId, direction: 'asc' }] },
      groupInfo: { fieldId: doomedId },
      hiddenFieldIds: [keepId, doomedId],
    })).body?.data?.view?.id
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET])

    expect((await deleteField(doomedId)).status).toBe(200)
    const revs = await configRevs()
    const fieldRev = revs.find((r) => r.entity_type === 'field' && r.entity_id === doomedId)
    const viewRev = revs.find((r) => r.entity_type === 'view' && r.entity_id === viewId)
    expect(fieldRev).toMatchObject({ action: 'delete' })
    expect(viewRev).toMatchObject({ action: 'update' })
    expect(viewRev?.batch_id).toBe(fieldRev?.batch_id)
    expect(viewRev?.changed_keys.sort()).toEqual(['filterInfo', 'groupInfo', 'hiddenFieldIds', 'sortInfo'])
    expect(viewRev?.before).toMatchObject({ hiddenFieldIds: [keepId, doomedId] })
    expect(viewRev?.after).toMatchObject({ filterInfo: {}, sortInfo: {}, groupInfo: {}, hiddenFieldIds: [keepId] })
  })

  test('sheet-config row-deny and conditional-rules changes record sheet_config revisions', async () => {
    const fieldId = (await createField({ name: 'Flag', type: 'string' })).body?.data?.field?.id
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET])

    expect((await putRowDeny(true)).status).toBe(200)
    let revs = await configRevs(SHEET)
    expect(revs.length).toBe(1)
    expect(revs[0]).toMatchObject({ entity_type: 'sheet_config', entity_id: SHEET, action: 'update' })
    expect(revs[0].changed_keys).toEqual(['rowLevelReadPermissionsEnabled'])
    expect(revs[0].before).toMatchObject({ rowLevelReadPermissionsEnabled: false })
    expect(revs[0].after).toMatchObject({ rowLevelReadPermissionsEnabled: true })

    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET])
    const rule = { id: 'deny_flag', fieldId, operator: 'eq', value: 'secret', effect: 'deny_read' }
    expect((await putConditionalRules([rule])).status).toBe(200)
    revs = await configRevs(SHEET)
    expect(revs.length).toBe(1)
    expect(revs[0]).toMatchObject({ entity_type: 'sheet_config', action: 'update' })
    expect(revs[0].changed_keys).toEqual(['conditionalReadRules'])
    expect(revs[0].before).toMatchObject({ conditionalReadRules: [] })
    expect(revs[0].after).toMatchObject({ conditionalReadRules: [rule] })
  })

  test('form-share patch and token regeneration record view config updates', async () => {
    const viewId = (await createView({ name: 'Public Form', type: 'form' })).body?.data?.view?.id
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET])

    expect((await patchFormShare(viewId, { enabled: true, accessMode: 'public' })).status).toBe(200)
    let revs = await configRevs(viewId)
    expect(revs.length).toBe(1)
    expect(revs[0]).toMatchObject({ entity_type: 'view', action: 'update' })
    expect(revs[0].changed_keys).toEqual(['config'])
    expect(revs[0].after?.config).toMatchObject({ publicForm: { enabled: true, accessMode: 'public' } })

    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET])
    expect((await regenerateFormShare(viewId)).status).toBe(200)
    revs = await configRevs(viewId)
    expect(revs.length).toBe(1)
    expect(revs[0]).toMatchObject({ entity_type: 'view', action: 'update' })
    expect(revs[0].changed_keys).toEqual(['config'])
    expect(revs[0].before?.config).toHaveProperty('publicForm.publicToken')
    expect(revs[0].after?.config).toHaveProperty('publicForm.publicToken')
    expect(revs[0].after?.config.publicForm.publicToken).not.toEqual(revs[0].before?.config.publicForm.publicToken)
  })
})
