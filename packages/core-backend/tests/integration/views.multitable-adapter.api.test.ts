import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, test, vi } from 'vitest'

type QueryResult = {
  rows: any[]
  rowCount?: number
}

type QueryHandler = (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>

function createMockPool(queryHandler: QueryHandler) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => queryHandler(sql, params))
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

async function createApp(queryHandler: QueryHandler, tokenPerms: string[] = ['multitable:write']) {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue(tokenPerms),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { viewsRouter } = await import('../../src/routes/views')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const mockPool = createMockPool(queryHandler)
  vi.spyOn(poolManager, 'get').mockReturnValue(mockPool as any)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = {
      id: 'user_views_adapter',
      roles: [],
      perms: tokenPerms,
    }
    next()
  })
  app.use('/api/views', viewsRouter())
  app.use('/api/multitable', univerMetaRouter())
  return { app, mockPool }
}

describe('Views multitable adapter API', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  test('falls back to multitable form config for legacy /api/views/:viewId/config', async () => {
    const { app } = await createApp(async (sql, params) => {
      if (sql.includes('SELECT * FROM views WHERE id = $1 AND deleted_at IS NULL')) {
        expect(params).toEqual(['view_form_ops'])
        return { rows: [] }
      }
      if (sql.includes('FROM meta_views') && sql.includes('WHERE id = $1')) {
        expect(params).toEqual(['view_form_ops'])
        return {
          rows: [{
            id: 'view_form_ops',
            sheet_id: 'sheet_ops',
            name: 'Ops Intake',
            type: 'form',
            filter_info: {},
            sort_info: {},
            group_info: {},
            hidden_field_ids: [],
            created_at: '2026-03-18T00:00:00.000Z',
            updated_at: '2026-03-18T00:00:00.000Z',
          }],
        }
      }
      if (sql.includes('SELECT id, name, description FROM meta_sheets WHERE id = $1')) {
        expect(params).toEqual(['sheet_ops'])
        return { rows: [{ id: 'sheet_ops', name: 'Ops', description: 'Ops intake form' }] }
      }
      if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC')) {
        if (params?.[0] === 'sheet_ops') {
          return {
            rows: [
              { id: 'fld_title', name: 'Title', type: 'string', property: { required: true }, order: 1 },
              { id: 'fld_priority', name: 'Priority', type: 'select', property: { options: [{ value: 'P0', label: 'P0' }] }, order: 2 },
              { id: 'fld_vendor', name: 'Vendor', type: 'link', property: { foreignSheetId: 'sheet_vendors', limitSingleRecord: true }, order: 3 },
            ],
          }
        }
        if (params?.[0] === 'sheet_vendors') {
          return {
            rows: [{ id: 'fld_vendor_name', name: 'Vendor Name', type: 'string', property: {}, order: 1 }],
          }
        }
      }
      if (sql.includes('SELECT id, data FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC LIMIT 200')) {
        expect(params).toEqual(['sheet_vendors'])
        return { rows: [{ id: 'vendor_1', data: { fld_vendor_name: 'Acme Supply' } }] }
      }
      throw new Error(`Unhandled SQL in test: ${sql}`)
    }, ['multitable:read'])

    const response = await request(app)
      .get('/api/views/view_form_ops/config')
      .expect(200)

    expect(response.body.success).toBe(true)
    expect(response.body.data).toMatchObject({
      id: 'view_form_ops',
      type: 'form',
      tableId: 'sheet_ops',
    })
    expect(response.body.data.fields).toEqual([
      expect.objectContaining({ id: 'fld_title', name: 'fld_title', label: 'Title', type: 'text' }),
      expect.objectContaining({ id: 'fld_priority', type: 'select', options: [{ value: 'P0', label: 'P0' }] }),
      expect.objectContaining({ id: 'fld_vendor', type: 'select', options: [{ value: 'vendor_1', label: 'Acme Supply' }] }),
    ])
  })

  test('exposes multitable form responses through legacy /api/views/:viewId/responses', async () => {
    const { app } = await createApp(async (sql, params) => {
      if (sql.includes('FROM meta_views') && sql.includes('WHERE id = $1')) {
        expect(params).toEqual(['view_form_ops'])
        return {
          rows: [{
            id: 'view_form_ops',
            sheet_id: 'sheet_ops',
            name: 'Ops Intake',
            type: 'form',
            filter_info: {},
            sort_info: {},
            group_info: {},
            hidden_field_ids: [],
          }],
        }
      }
      if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC')) {
        expect(params).toEqual(['sheet_ops'])
        return {
          rows: [{ id: 'fld_title', name: 'Title', type: 'string', property: {}, order: 1 }],
        }
      }
      if (sql.includes('SELECT COUNT(*)::int AS total FROM meta_records WHERE sheet_id = $1')) {
        expect(params).toEqual(['sheet_ops'])
        return { rows: [{ total: 2 }] }
      }
      if (sql.includes('SELECT id, data, created_at FROM meta_records WHERE sheet_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3')) {
        expect(params).toEqual(['sheet_ops', 2, 0])
        return {
          rows: [
            { id: 'rec_2', data: { fld_title: 'Second' }, created_at: '2026-03-18T02:00:00.000Z' },
            { id: 'rec_1', data: { fld_title: 'First' }, created_at: '2026-03-18T01:00:00.000Z' },
          ],
        }
      }
      throw new Error(`Unhandled SQL in test: ${sql}`)
    }, ['multitable:read'])

    const response = await request(app)
      .get('/api/views/view_form_ops/responses')
      .query({ page: '1', pageSize: '2' })
      .expect(200)

    expect(response.body.success).toBe(true)
    expect(response.body.meta).toEqual({
      total: 2,
      page: 1,
      pageSize: 2,
      hasMore: false,
    })
    expect(response.body.data).toEqual([
      expect.objectContaining({
        id: 'rec_2',
        formId: 'view_form_ops',
        data: { Title: 'Second' },
        status: 'submitted',
      }),
      expect.objectContaining({
        id: 'rec_1',
        data: { Title: 'First' },
      }),
    ])
  })

  test('bridges legacy /api/views/:viewId/submit to multitable submit', async () => {
    const { app } = await createApp(async (sql, params) => {
      if (sql.includes('FROM meta_views') && sql.includes('WHERE id = $1')) {
        expect(params).toEqual(['view_form_ops'])
        return {
          rows: [{
            id: 'view_form_ops',
            sheet_id: 'sheet_ops',
            name: 'Ops Intake',
            type: 'form',
            filter_info: {},
            sort_info: {},
            group_info: {},
            hidden_field_ids: [],
          }],
        }
      }
      if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
        expect(params).toEqual(['sheet_ops'])
        return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: 'Ops intake' }] }
      }
      if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC')) {
        expect(params).toEqual(['sheet_ops'])
        return {
          rows: [{ id: 'fld_title', name: 'Title', type: 'string', property: {}, order: 1 }],
        }
      }
      if (sql.includes('INSERT INTO meta_records') && sql.includes('RETURNING id, version')) {
        expect(params).toEqual([expect.any(String), 'sheet_ops', JSON.stringify({ fld_title: 'Created from legacy submit' })])
        return { rows: [{ id: 'rec_created', version: 1 }] }
      }
      if (sql.includes('SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
        expect(params).toEqual(['rec_created', 'sheet_ops'])
        return {
          rows: [{
            id: 'rec_created',
            version: 1,
            data: { fld_title: 'Created from legacy submit' },
          }],
        }
      }
      throw new Error(`Unhandled SQL in test: ${sql}`)
    })

    const response = await request(app)
      .post('/api/views/view_form_ops/submit')
      .redirects(1)
      .send({
        data: {
          fld_title: 'Created from legacy submit',
        },
      })
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.mode).toBe('create')
    expect(response.body.data.record).toMatchObject({
      id: 'rec_created',
      version: 1,
      data: { fld_title: 'Created from legacy submit' },
    })
  })

  test('falls back to multitable gallery config and data for legacy /api/views/:viewId/*', async () => {
    const { app } = await createApp(async (sql, params) => {
      if (sql.includes('SELECT * FROM views WHERE id = $1 AND deleted_at IS NULL')) {
        expect(params).toEqual(['view_gallery_assets'])
        return { rows: [] }
      }
      if (sql.includes('SELECT id, type, table_id, config, filters, sorting, visible_fields FROM views WHERE id = $1 AND deleted_at IS NULL')) {
        expect(params).toEqual(['view_gallery_assets'])
        return { rows: [] }
      }
      if (sql.includes('FROM meta_views') && sql.includes('WHERE id = $1')) {
        expect(params).toEqual(['view_gallery_assets'])
        return {
          rows: [{
            id: 'view_gallery_assets',
            sheet_id: 'sheet_assets',
            name: 'Assets Gallery',
            type: 'gallery',
            filter_info: {},
            sort_info: { items: [{ fieldId: 'fld_project', direction: 'asc' }] },
            group_info: {},
            hidden_field_ids: [],
            created_at: '2026-03-18T00:00:00.000Z',
            updated_at: '2026-03-18T00:00:00.000Z',
          }],
        }
      }
      if (sql.includes('SELECT id, name, description FROM meta_sheets WHERE id = $1')) {
        expect(params).toEqual(['sheet_assets'])
        return { rows: [{ id: 'sheet_assets', name: 'Assets', description: 'Asset library' }] }
      }
      if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC')) {
        expect(params).toEqual(['sheet_assets'])
        return {
          rows: [
            { id: 'fld_title', name: 'asset_name', type: 'string', property: {}, order: 1 },
            { id: 'fld_project', name: 'project_name', type: 'string', property: {}, order: 2 },
            { id: 'fld_status', name: 'status', type: 'select', property: { options: ['Approved'] }, order: 3 },
            { id: 'fld_image', name: 'thumbnail_url', type: 'string', property: {}, order: 4 },
            { id: 'fld_tags', name: 'labels', type: 'link', property: {}, order: 5 },
          ],
        }
      }
      if (sql.includes('SELECT COUNT(*)::int AS total FROM meta_records WHERE sheet_id = $1')) {
        expect(params).toEqual(['sheet_assets'])
        return { rows: [{ total: 1 }] }
      }
      if (sql.includes('SELECT id, data FROM meta_records WHERE sheet_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3')) {
        expect(params).toEqual(['sheet_assets', 20, 0])
        return {
          rows: [{
            id: 'rec_asset_1',
            data: {
              fld_title: 'Hero image',
              fld_project: 'Summer launch',
              fld_status: 'Approved',
              fld_image: 'https://cdn.example.com/hero.png',
              fld_tags: ['brand', 'homepage'],
            },
          }],
        }
      }
      throw new Error(`Unhandled SQL in test: ${sql}`)
    }, ['multitable:read'])

    const configResponse = await request(app)
      .get('/api/views/view_gallery_assets/config')
      .expect(200)

    expect(configResponse.body.success).toBe(true)
    expect(configResponse.body.data).toMatchObject({
      id: 'view_gallery_assets',
      type: 'gallery',
      name: 'Assets Gallery',
      cardTemplate: {
        titleField: 'asset_name',
        imageField: 'thumbnail_url',
        contentFields: ['project_name', 'status'],
        tagFields: ['labels'],
      },
      sorting: [{ field: 'project_name', direction: 'asc' }],
    })

    const dataResponse = await request(app)
      .get('/api/views/view_gallery_assets/data')
      .query({ page: '1', pageSize: '20' })
      .expect(200)

    expect(dataResponse.body.success).toBe(true)
    expect(dataResponse.body.meta).toEqual({
      total: 1,
      page: 1,
      pageSize: 20,
      hasMore: false,
    })
    expect(dataResponse.body.data).toEqual([
      {
        id: 'rec_asset_1',
        asset_name: 'Hero image',
        project_name: 'Summer launch',
        status: 'Approved',
        thumbnail_url: 'https://cdn.example.com/hero.png',
        labels: ['brand', 'homepage'],
      },
    ])
  })

  test('falls back to multitable calendar config and data for legacy /api/views/:viewId/*', async () => {
    const { app } = await createApp(async (sql, params) => {
      if (sql.includes('SELECT * FROM views WHERE id = $1 AND deleted_at IS NULL')) {
        expect(params).toEqual(['view_calendar_ops'])
        return { rows: [] }
      }
      if (sql.includes('SELECT id, type, table_id, config, filters, sorting, visible_fields FROM views WHERE id = $1 AND deleted_at IS NULL')) {
        expect(params).toEqual(['view_calendar_ops'])
        return { rows: [] }
      }
      if (sql.includes('FROM meta_views') && sql.includes('WHERE id = $1')) {
        expect(params).toEqual(['view_calendar_ops'])
        return {
          rows: [{
            id: 'view_calendar_ops',
            sheet_id: 'sheet_ops',
            name: 'Ops Calendar',
            type: 'calendar',
            filter_info: {},
            sort_info: {},
            group_info: {},
            hidden_field_ids: [],
            created_at: '2026-03-18T00:00:00.000Z',
            updated_at: '2026-03-18T00:00:00.000Z',
          }],
        }
      }
      if (sql.includes('SELECT id, name, description FROM meta_sheets WHERE id = $1')) {
        expect(params).toEqual(['sheet_ops'])
        return { rows: [{ id: 'sheet_ops', name: 'Ops', description: 'Operations schedule' }] }
      }
      if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC')) {
        expect(params).toEqual(['sheet_ops'])
        return {
          rows: [
            { id: 'fld_title', name: 'title', type: 'string', property: {}, order: 1 },
            { id: 'fld_start', name: 'startDate', type: 'string', property: {}, order: 2 },
            { id: 'fld_end', name: 'endDate', type: 'string', property: {}, order: 3 },
            { id: 'fld_location', name: 'location', type: 'string', property: {}, order: 4 },
            { id: 'fld_category', name: 'category', type: 'select', property: { options: ['meeting'] }, order: 5 },
            { id: 'fld_description', name: 'description', type: 'string', property: {}, order: 6 },
          ],
        }
      }
      if (sql.includes('SELECT COUNT(*)::int AS total FROM meta_records WHERE sheet_id = $1')) {
        expect(params).toEqual(['sheet_ops'])
        return { rows: [{ total: 1 }] }
      }
      if (sql.includes('SELECT id, data FROM meta_records WHERE sheet_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3')) {
        expect(params).toEqual(['sheet_ops', 10, 0])
        return {
          rows: [{
            id: 'rec_event_1',
            data: {
              fld_title: 'Kickoff',
              fld_start: '2026-03-20T10:00:00.000Z',
              fld_end: '2026-03-20T11:00:00.000Z',
              fld_location: 'Room A',
              fld_category: 'meeting',
              fld_description: 'Project kickoff',
            },
          }],
        }
      }
      throw new Error(`Unhandled SQL in test: ${sql}`)
    }, ['multitable:read'])

    const configResponse = await request(app)
      .get('/api/views/view_calendar_ops/config')
      .expect(200)

    expect(configResponse.body.success).toBe(true)
    expect(configResponse.body.data).toMatchObject({
      id: 'view_calendar_ops',
      type: 'calendar',
      defaultView: 'month',
      weekStartsOn: 1,
      timeFormat: 24,
      fields: {
        title: 'title',
        start: 'startDate',
        startDate: 'startDate',
        end: 'endDate',
        endDate: 'endDate',
        location: 'location',
        category: 'category',
        description: 'description',
      },
    })

    const dataResponse = await request(app)
      .get('/api/views/view_calendar_ops/data')
      .query({ page: '1', pageSize: '10' })
      .expect(200)

    expect(dataResponse.body.success).toBe(true)
    expect(dataResponse.body.data).toEqual([
      {
        id: 'rec_event_1',
        title: 'Kickoff',
        startDate: '2026-03-20T10:00:00.000Z',
        endDate: '2026-03-20T11:00:00.000Z',
        location: 'Room A',
        category: 'meeting',
        description: 'Project kickoff',
      },
    ])
  })
})
