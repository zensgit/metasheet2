/**
 * S4 — hierarchy parent link single-value guard (route-level).
 *
 * The hierarchy view reparents records by writing `[parentRecordId]` over the
 * configured parent link field (a generic record patch — there is no dedicated
 * reparent endpoint). If that field is a MULTI-value link (`limitSingleRecord`
 * absent/false), every drag-to-reparent silently overwrites the other linked
 * records. The view-config save path is the one place that knows a link field
 * is being used AS a hierarchy parent, so POST /views and PATCH /views/:viewId
 * must reject a hierarchy `config.parentFieldId` that does not resolve to a
 * single-value (`limitSingleRecord: true`) link field.
 *
 * These tests bind the REAL router (mock pool — see the wire-vs-fixture rule
 * and tests/unit/multitable-formula-reference-guard.test.ts precedent):
 *
 *   1. PATCH rejects a multi-value link parent (400, no UPDATE).
 *   2. PATCH accepts a single-value link parent (200, UPDATE persisted).
 *   3. POST rejects a non-link parent field (400, no INSERT).
 *   4. POST rejects a nonexistent parent field (400, no INSERT).
 *   5. PATCH /fields rejects downgrading a referenced single-value parent link
 *      to multi-value, non-link, or a different target sheet (400, no field UPDATE).
 *   6. PATCH /fields treats persisted whitespace around a hierarchy parentFieldId
 *      as still referencing the active field.
 *
 * Discriminating cases prove we did NOT over-reject:
 *   - POST hierarchy WITHOUT parentFieldId stays allowed (auto/first-link mode).
 *   - POST a non-hierarchy view whose config carries a stray `parentFieldId`
 *     pointing at a multi-value link stays allowed (guard is hierarchy-scoped).
 *   - PATCH /fields can still rename a referenced parent link while it remains
 *     single-value, and can still convert unreferenced links to multi-value.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'

const SHEET_ID = 'sheet_hier'
const OTHER_SHEET_ID = 'sheet_other'
const VIEW_ID = 'view_hier'

type StoredField = {
  id: string
  name: string
  type: string
  property: Record<string, unknown>
  order: number
}
type StoredView = {
  id: string
  sheetId: string
  name: string
  type: string
  config: Record<string, unknown>
}
type QueryResult = { rows: any[]; rowCount?: number }

function createStore(fields: StoredField[], views: StoredView[] = [{
  id: VIEW_ID,
  sheetId: SHEET_ID,
  name: 'Hierarchy',
  type: 'hierarchy',
  config: {},
}]) {
  const fieldById = new Map(fields.map((f) => [f.id, f]))
  const viewById = new Map(views.map((v) => [v.id, v]))
  const inserts: unknown[][] = []
  const updates: unknown[][] = []
  const fieldUpdates: unknown[][] = []

  const handler = (sql: string, params?: unknown[]): QueryResult => {
    if (sql.includes('FROM meta_sheets WHERE id = $1')) {
      return { rows: [{ id: SHEET_ID }] }
    }
    if (sql.includes('FROM meta_views WHERE id = $1')) {
      const view = viewById.get(params?.[0] as string)
      return {
        rows: view ? [{
          id: view.id,
          sheet_id: view.sheetId,
          name: view.name,
          type: 'hierarchy',
          filter_info: {},
          sort_info: {},
          group_info: {},
          hidden_field_ids: [],
          config: view.config,
        }] : [],
      }
    }
    if (sql.includes("config ? 'parentFieldId'")) {
      const sheetId = params?.[0]
      const viewType = params?.[1]
      return {
        rows: views
          .filter((v) =>
            v.sheetId === sheetId
            && v.type === viewType
            && Object.prototype.hasOwnProperty.call(v.config, 'parentFieldId'))
          .map((v) => ({ id: v.id, name: v.name, config: v.config })),
      }
    }
    if (sql.includes('SELECT id, sheet_id FROM meta_fields WHERE id = $1')) {
      const f = fieldById.get(params?.[0] as string)
      return { rows: f ? [{ id: f.id, sheet_id: SHEET_ID }] : [] }
    }
    if (sql.includes('SELECT id, sheet_id, name, type, property, "order" FROM meta_fields WHERE id = $1')) {
      const f = fieldById.get(params?.[0] as string)
      return { rows: f ? [{ ...f, sheet_id: SHEET_ID }] : [] }
    }
    // S4 guard — single-field lookup for the configured parent field.
    if (sql.includes('FROM meta_fields WHERE sheet_id = $1 AND id = $2')) {
      const f = fieldById.get(params?.[1] as string)
      return { rows: f ? [{ ...f }] : [] }
    }
    // loadAllowedFieldIds → loadFieldsForSheet (response redaction path).
    if (sql.includes('FROM meta_fields WHERE sheet_id = $1 ORDER BY')) {
      return { rows: fields.map((f) => ({ ...f })) }
    }
    if (sql.includes('INSERT INTO meta_views')) {
      inserts.push(params ?? [])
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('UPDATE meta_views')) {
      updates.push(params ?? [])
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('UPDATE meta_fields') && sql.includes('RETURNING id, name, type, property, "order"')) {
      fieldUpdates.push(params ?? [])
      const fieldId = params?.[0] as string
      const existing = fieldById.get(fieldId)
      if (!existing) return { rows: [], rowCount: 0 }
      const next = {
        ...existing,
        name: String(params?.[1] ?? existing.name),
        type: String(params?.[2] ?? existing.type),
        property: typeof params?.[3] === 'string' ? JSON.parse(params[3] as string) : existing.property,
        order: Number(params?.[4] ?? existing.order),
      }
      fieldById.set(fieldId, next)
      return { rows: [{ ...next }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }

  return { inserts, updates, fieldUpdates, handler }
}

function createMockPool(handler: (sql: string, params?: unknown[]) => QueryResult) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (
      sql.includes('FROM spreadsheet_permissions')
      || sql.includes('FROM field_permissions')
      || sql.includes('FROM view_permissions')
      || sql.includes('FROM meta_view_permissions')
      || sql.includes('FROM record_permissions')
    ) {
      return { rows: [], rowCount: 0 }
    }
    return handler(sql, params)
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

async function createApp(handler: (sql: string, params?: unknown[]) => QueryResult) {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue(['multitable:write']),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const mockPool = createMockPool(handler)
  vi.spyOn(poolManager, 'get').mockReturnValue(mockPool as any)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { id: 'user_hier', roles: [], perms: ['multitable:read', 'multitable:write'] }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return app
}

function field(over: Partial<StoredField> & { id: string; type: string }): StoredField {
  return { name: over.id, property: {}, order: 0, ...over }
}

const MULTI_LINK = field({
  id: 'fld_parent_multi',
  type: 'link',
  property: { foreignSheetId: SHEET_ID, limitSingleRecord: false },
})
const SINGLE_LINK = field({
  id: 'fld_parent_single',
  type: 'link',
  property: { foreignSheetId: SHEET_ID, limitSingleRecord: true },
})
const EXTERNAL_SINGLE_LINK = field({
  id: 'fld_parent_external',
  type: 'link',
  property: { foreignSheetId: OTHER_SHEET_ID, limitSingleRecord: true },
})
const UNRELATED_SINGLE_LINK = field({
  id: 'fld_unrelated_single',
  type: 'link',
  property: { foreignSheetId: SHEET_ID, limitSingleRecord: true },
})
const TEXT_FIELD = field({ id: 'fld_notes', type: 'string' })
const HIERARCHY_VIEW_USING_SINGLE_PARENT: StoredView = {
  id: VIEW_ID,
  sheetId: SHEET_ID,
  name: 'Hierarchy',
  type: 'hierarchy',
  config: { parentFieldId: 'fld_parent_single' },
}

describe('S4 — hierarchy parent link single-value guard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('PATCH rejects a hierarchy parentFieldId that resolves to a multi-value link field', async () => {
    const { updates, handler } = createStore([MULTI_LINK, SINGLE_LINK])
    const app = await createApp(handler)

    const res = await request(app)
      .patch(`/api/multitable/views/${VIEW_ID}`)
      .send({ config: { parentFieldId: 'fld_parent_multi', orphanMode: 'root' } })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.message).toBe(
      'Hierarchy parent field must be a single-value link field: fld_parent_multi',
    )
    expect(updates).toHaveLength(0)
  })

  it('PATCH accepts a hierarchy parentFieldId that resolves to a single-value link field', async () => {
    const { updates, handler } = createStore([MULTI_LINK, SINGLE_LINK])
    const app = await createApp(handler)

    const res = await request(app)
      .patch(`/api/multitable/views/${VIEW_ID}`)
      .send({ config: { parentFieldId: 'fld_parent_single', orphanMode: 'root' } })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(updates).toHaveLength(1)
    expect(updates[0]?.[7]).toBe(JSON.stringify({ parentFieldId: 'fld_parent_single', orphanMode: 'root' }))
  })

  it('PATCH normalizes a hierarchy parentFieldId before persisting config', async () => {
    const { updates, handler } = createStore([SINGLE_LINK])
    const app = await createApp(handler)

    const res = await request(app)
      .patch(`/api/multitable/views/${VIEW_ID}`)
      .send({ config: { parentFieldId: '\u00A0fld_parent_single\u00A0', orphanMode: 'root' } })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(updates).toHaveLength(1)
    expect(updates[0]?.[7]).toBe(JSON.stringify({ parentFieldId: 'fld_parent_single', orphanMode: 'root' }))
  })

  it('POST normalizes a hierarchy parentFieldId before persisting config', async () => {
    const { inserts, handler } = createStore([SINGLE_LINK])
    const app = await createApp(handler)

    const res = await request(app)
      .post('/api/multitable/views')
      .send({
        sheetId: SHEET_ID,
        name: 'Tree',
        type: 'hierarchy',
        config: { parentFieldId: '\u00A0fld_parent_single\u00A0', orphanMode: 'root' },
      })

    expect(res.status).toBe(201)
    expect(res.body.ok).toBe(true)
    expect(inserts).toHaveLength(1)
    expect(inserts[0]?.[8]).toBe(JSON.stringify({ parentFieldId: 'fld_parent_single', orphanMode: 'root' }))
  })

  it('POST rejects a hierarchy parentFieldId that resolves to a link targeting another sheet', async () => {
    const { inserts, handler } = createStore([EXTERNAL_SINGLE_LINK])
    const app = await createApp(handler)

    const res = await request(app)
      .post('/api/multitable/views')
      .send({ sheetId: SHEET_ID, name: 'Tree', type: 'hierarchy', config: { parentFieldId: 'fld_parent_external' } })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.message).toBe(
      'Hierarchy parent field must be a single-value link field: fld_parent_external',
    )
    expect(inserts).toHaveLength(0)
  })

  it('POST rejects a hierarchy parentFieldId that resolves to a non-link field', async () => {
    const { inserts, handler } = createStore([TEXT_FIELD])
    const app = await createApp(handler)

    const res = await request(app)
      .post('/api/multitable/views')
      .send({ sheetId: SHEET_ID, name: 'Tree', type: 'hierarchy', config: { parentFieldId: 'fld_notes' } })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.message).toBe(
      'Hierarchy parent field must be a single-value link field: fld_notes',
    )
    expect(inserts).toHaveLength(0)
  })

  it('POST rejects a hierarchy parentFieldId that resolves to no field at all', async () => {
    const { inserts, handler } = createStore([SINGLE_LINK])
    const app = await createApp(handler)

    const res = await request(app)
      .post('/api/multitable/views')
      .send({ sheetId: SHEET_ID, name: 'Tree', type: 'hierarchy', config: { parentFieldId: 'fld_ghost' } })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.message).toBe(
      'Hierarchy parent field must be a single-value link field: fld_ghost',
    )
    expect(inserts).toHaveLength(0)
  })

  it('POST ALLOWS a hierarchy view without an explicit parentFieldId (auto mode preserved)', async () => {
    const { inserts, handler } = createStore([MULTI_LINK])
    const app = await createApp(handler)

    const res = await request(app)
      .post('/api/multitable/views')
      .send({ sheetId: SHEET_ID, name: 'Tree', type: 'hierarchy', config: { orphanMode: 'hidden' } })

    expect(res.status).toBe(201)
    expect(res.body.ok).toBe(true)
    expect(inserts).toHaveLength(1)
  })

  it('POST ALLOWS a non-hierarchy view whose config carries a stray parentFieldId (guard is hierarchy-scoped)', async () => {
    const { inserts, handler } = createStore([MULTI_LINK])
    const app = await createApp(handler)

    const res = await request(app)
      .post('/api/multitable/views')
      .send({ sheetId: SHEET_ID, name: 'Grid', type: 'grid', config: { parentFieldId: 'fld_parent_multi' } })

    expect(res.status).toBe(201)
    expect(res.body.ok).toBe(true)
    expect(inserts).toHaveLength(1)
  })

  it('PATCH /fields rejects changing a hierarchy parent link from single-value to multi-value', async () => {
    const { fieldUpdates, handler } = createStore(
      [SINGLE_LINK],
      [HIERARCHY_VIEW_USING_SINGLE_PARENT],
    )
    const app = await createApp(handler)

    const res = await request(app)
      .patch('/api/multitable/fields/fld_parent_single')
      .send({
        property: { foreignSheetId: SHEET_ID, limitSingleRecord: false },
      })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.message).toBe(
      'Cannot change hierarchy parent field fld_parent_single: update or remove the hierarchy view parentFieldId first.',
    )
    expect(fieldUpdates).toHaveLength(0)
  })

  it('PATCH /fields rejects changing a referenced hierarchy parentFieldId even when persisted with whitespace', async () => {
    const { fieldUpdates, handler } = createStore(
      [SINGLE_LINK],
      [{
        ...HIERARCHY_VIEW_USING_SINGLE_PARENT,
        config: { parentFieldId: ' fld_parent_single ' },
      }],
    )
    const app = await createApp(handler)

    const res = await request(app)
      .patch('/api/multitable/fields/fld_parent_single')
      .send({
        property: { foreignSheetId: SHEET_ID, limitSingleRecord: false },
      })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.message).toBe(
      'Cannot change hierarchy parent field fld_parent_single: update or remove the hierarchy view parentFieldId first.',
    )
    expect(fieldUpdates).toHaveLength(0)
  })

  it('PATCH /fields rejects changing a referenced hierarchy parentFieldId even when persisted with tabs and newlines', async () => {
    const { fieldUpdates, handler } = createStore(
      [SINGLE_LINK],
      [{
        ...HIERARCHY_VIEW_USING_SINGLE_PARENT,
        config: { parentFieldId: '\tfld_parent_single\n' },
      }],
    )
    const app = await createApp(handler)

    const res = await request(app)
      .patch('/api/multitable/fields/fld_parent_single')
      .send({
        property: { foreignSheetId: SHEET_ID, limitSingleRecord: false },
      })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.message).toBe(
      'Cannot change hierarchy parent field fld_parent_single: update or remove the hierarchy view parentFieldId first.',
    )
    expect(fieldUpdates).toHaveLength(0)
  })

  it('PATCH /fields rejects changing a referenced hierarchy parentFieldId even when legacy config persisted Unicode whitespace', async () => {
    const { fieldUpdates, handler } = createStore(
      [SINGLE_LINK],
      [{
        ...HIERARCHY_VIEW_USING_SINGLE_PARENT,
        config: { parentFieldId: '\u00A0fld_parent_single\u00A0' },
      }],
    )
    const app = await createApp(handler)

    const res = await request(app)
      .patch('/api/multitable/fields/fld_parent_single')
      .send({
        property: { foreignSheetId: SHEET_ID, limitSingleRecord: false },
      })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.message).toBe(
      'Cannot change hierarchy parent field fld_parent_single: update or remove the hierarchy view parentFieldId first.',
    )
    expect(fieldUpdates).toHaveLength(0)
  })

  it('PATCH /fields rejects changing a hierarchy parent link into a non-link field', async () => {
    const { fieldUpdates, handler } = createStore(
      [SINGLE_LINK],
      [HIERARCHY_VIEW_USING_SINGLE_PARENT],
    )
    const app = await createApp(handler)

    const res = await request(app)
      .patch('/api/multitable/fields/fld_parent_single')
      .send({ type: 'string', property: {} })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.message).toBe(
      'Cannot change hierarchy parent field fld_parent_single: update or remove the hierarchy view parentFieldId first.',
    )
    expect(fieldUpdates).toHaveLength(0)
  })

  it('PATCH /fields rejects removing the target sheet from a referenced hierarchy parent link', async () => {
    const { fieldUpdates, handler } = createStore(
      [SINGLE_LINK],
      [HIERARCHY_VIEW_USING_SINGLE_PARENT],
    )
    const app = await createApp(handler)

    const res = await request(app)
      .patch('/api/multitable/fields/fld_parent_single')
      .send({
        property: { limitSingleRecord: true },
      })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.message).toBe(
      'Cannot change hierarchy parent field fld_parent_single: update or remove the hierarchy view parentFieldId first.',
    )
    expect(fieldUpdates).toHaveLength(0)
  })

  it('PATCH /fields rejects retargeting a referenced hierarchy parent link to another sheet', async () => {
    const { fieldUpdates, handler } = createStore(
      [SINGLE_LINK],
      [HIERARCHY_VIEW_USING_SINGLE_PARENT],
    )
    const app = await createApp(handler)

    const res = await request(app)
      .patch('/api/multitable/fields/fld_parent_single')
      .send({
        property: { foreignSheetId: OTHER_SHEET_ID, limitSingleRecord: true },
      })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.message).toBe(
      'Cannot change hierarchy parent field fld_parent_single: update or remove the hierarchy view parentFieldId first.',
    )
    expect(fieldUpdates).toHaveLength(0)
  })

  it('PATCH /fields allows renaming a hierarchy parent field while it stays single-value', async () => {
    const { fieldUpdates, handler } = createStore(
      [SINGLE_LINK],
      [HIERARCHY_VIEW_USING_SINGLE_PARENT],
    )
    const app = await createApp(handler)

    const res = await request(app)
      .patch('/api/multitable/fields/fld_parent_single')
      .send({ name: 'Parent link' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(fieldUpdates).toHaveLength(1)
    expect(fieldUpdates[0]?.[1]).toBe('Parent link')
    expect(fieldUpdates[0]?.[2]).toBe('link')
    expect(JSON.parse(fieldUpdates[0]?.[3] as string)).toMatchObject({ limitSingleRecord: true })
  })

  it('PATCH /fields allows retargeting an unrelated field while a hierarchy view references a different parent link', async () => {
    const { fieldUpdates, handler } = createStore(
      [SINGLE_LINK, UNRELATED_SINGLE_LINK],
      [HIERARCHY_VIEW_USING_SINGLE_PARENT],
    )
    const app = await createApp(handler)

    const res = await request(app)
      .patch('/api/multitable/fields/fld_unrelated_single')
      .send({
        property: { foreignSheetId: OTHER_SHEET_ID, limitSingleRecord: true },
      })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(fieldUpdates).toHaveLength(1)
    expect(JSON.parse(fieldUpdates[0]?.[3] as string)).toMatchObject({
      foreignSheetId: OTHER_SHEET_ID,
      limitSingleRecord: true,
    })
  })

  it('PATCH /fields allows multi-value conversion when no hierarchy view references the field', async () => {
    const { fieldUpdates, handler } = createStore([SINGLE_LINK])
    const app = await createApp(handler)

    const res = await request(app)
      .patch('/api/multitable/fields/fld_parent_single')
      .send({
        property: { foreignSheetId: SHEET_ID, limitSingleRecord: false },
      })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(fieldUpdates).toHaveLength(1)
    expect(JSON.parse(fieldUpdates[0]?.[3] as string)).toMatchObject({ limitSingleRecord: false })
  })
})
