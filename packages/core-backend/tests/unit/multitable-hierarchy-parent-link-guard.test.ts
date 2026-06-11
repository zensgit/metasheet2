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
 *
 * Discriminating cases prove we did NOT over-reject:
 *   - POST hierarchy WITHOUT parentFieldId stays allowed (auto/first-link mode).
 *   - POST a non-hierarchy view whose config carries a stray `parentFieldId`
 *     pointing at a multi-value link stays allowed (guard is hierarchy-scoped).
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'

const SHEET_ID = 'sheet_hier'
const VIEW_ID = 'view_hier'

type StoredField = {
  id: string
  name: string
  type: string
  property: Record<string, unknown>
  order: number
}
type QueryResult = { rows: any[]; rowCount?: number }

function createStore(fields: StoredField[]) {
  const fieldById = new Map(fields.map((f) => [f.id, f]))
  const inserts: unknown[][] = []
  const updates: unknown[][] = []

  const handler = (sql: string, params?: unknown[]): QueryResult => {
    if (sql.includes('FROM meta_sheets WHERE id = $1')) {
      return { rows: [{ id: SHEET_ID }] }
    }
    if (sql.includes('FROM meta_views WHERE id = $1')) {
      return {
        rows: [{
          id: VIEW_ID,
          sheet_id: SHEET_ID,
          name: 'Hierarchy',
          type: 'hierarchy',
          filter_info: {},
          sort_info: {},
          group_info: {},
          hidden_field_ids: [],
          config: {},
        }],
      }
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
    return { rows: [], rowCount: 0 }
  }

  return { inserts, updates, handler }
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
const TEXT_FIELD = field({ id: 'fld_notes', type: 'string' })

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
})
