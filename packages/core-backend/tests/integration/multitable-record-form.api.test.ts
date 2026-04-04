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

async function createApp(args: {
  tokenPerms?: string[]
  tokenRoles?: string[]
  queryHandler?: QueryHandler
  fallbackPermissions?: string[]
}) {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue(args.fallbackPermissions ?? []),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const mockPool = createMockPool(args.queryHandler ?? (() => ({ rows: [], rowCount: 0 })))
  vi.spyOn(poolManager, 'get').mockReturnValue(mockPool as any)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = {
      id: 'user_multitable_2',
      roles: args.tokenRoles ?? [],
      perms: args.tokenPerms ?? [],
    }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())

  return { app, mockPool }
}

describe('Multitable record and form context API', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  test('returns record drawer context with link summaries', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'comments:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, sheet_id, version, data FROM meta_records WHERE id = $1')) {
          expect(params).toEqual(['rec_1'])
          return {
            rows: [{
              id: 'rec_1',
              sheet_id: 'sheet_orders',
              version: 3,
              data: { fld_name: 'Order A', fld_vendor_link: ['vendor_1'], fld_files: ['att_1'] },
            }],
          }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          if (params?.[0] === 'sheet_orders') {
            return { rows: [{ id: 'sheet_orders', base_id: 'base_ops', name: 'Orders', description: 'Ops orders' }] }
          }
          if (params?.[0] === 'sheet_vendors') {
            return { rows: [{ id: 'sheet_vendors', base_id: 'base_ops', name: 'Vendors', description: null }] }
          }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
          if (params?.[0] === 'sheet_orders') {
            return {
              rows: [
                { id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 1 },
                { id: 'fld_vendor_link', name: 'Vendor', type: 'link', property: { foreignSheetId: 'sheet_vendors' }, order: 2 },
                { id: 'fld_files', name: 'Files', type: 'attachment', property: {}, order: 3 },
              ],
            }
          }
          if (params?.[0] === 'sheet_vendors') {
            return {
              rows: [
                { id: 'fld_vendor_name', name: 'Vendor Name', type: 'string', property: {}, order: 1 },
              ],
            }
          }
        }
        if (sql.includes('FROM meta_links') && sql.includes('record_id = ANY($2::text[])')) {
          expect(params).toEqual([['fld_vendor_link'], ['rec_1']])
          return { rows: [{ field_id: 'fld_vendor_link', record_id: 'rec_1', foreign_record_id: 'vendor_1' }] }
        }
        if (sql.includes('SELECT id, data FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])')) {
          expect(params).toEqual(['sheet_vendors', ['vendor_1']])
          return { rows: [{ id: 'vendor_1', data: { fld_vendor_name: 'Acme Supply' } }] }
        }
        if (sql.includes('FROM multitable_attachments')) {
          expect(params).toEqual(['sheet_orders', ['att_1']])
          return {
            rows: [{
              id: 'att_1',
              sheet_id: 'sheet_orders',
              record_id: 'rec_1',
              field_id: 'fld_files',
              filename: 'order.pdf',
              original_name: 'order.pdf',
              mime_type: 'application/pdf',
              size: 1024,
              created_at: '2026-03-19T10:00:00.000Z',
            }],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/records/rec_1')
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.sheet).toMatchObject({ id: 'sheet_orders', baseId: 'base_ops' })
    expect(response.body.data.record).toMatchObject({
      id: 'rec_1',
      version: 3,
      data: {
        fld_name: 'Order A',
        fld_vendor_link: ['vendor_1'],
        fld_files: ['att_1'],
      },
    })
    expect(response.body.data.commentsScope).toMatchObject({
      targetType: 'meta_record',
      targetId: 'rec_1',
      baseId: 'base_ops',
      sheetId: 'sheet_orders',
      viewId: null,
      recordId: 'rec_1',
      containerType: 'meta_sheet',
      containerId: 'sheet_orders',
    })
    expect(response.body.data.linkSummaries).toEqual({
      fld_vendor_link: [{ id: 'vendor_1', display: 'Acme Supply' }],
    })
    expect(response.body.data.attachmentSummaries).toEqual({
      fld_files: [expect.objectContaining({
        id: 'att_1',
        filename: 'order.pdf',
        mimeType: 'application/pdf',
        size: 1024,
        url: expect.stringContaining('/api/multitable/attachments/att_1'),
        thumbnailUrl: null,
        uploadedAt: '2026-03-19T10:00:00.000Z',
      })],
    })
  })

  test('returns form context with hidden fields filtered and readOnly when user cannot write', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_form_ops'])
          return {
            rows: [{
              id: 'view_form_ops',
              sheet_id: 'sheet_ops',
              name: 'Intake Form',
              type: 'form',
              filter_info: {},
              sort_info: {},
              group_info: {},
              hidden_field_ids: ['fld_internal'],
              config: {},
            }],
          }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: 'Ops intake' }] }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [
              { id: 'fld_title', name: 'Title', type: 'string', property: { required: true }, order: 1 },
              { id: 'fld_internal', name: 'Internal Only', type: 'string', property: {}, order: 2 },
              { id: 'fld_files', name: 'Files', type: 'attachment', property: {}, order: 3 },
            ],
          }
        }
        if (sql.includes('SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
          expect(params).toEqual(['rec_existing', 'sheet_ops'])
          return {
            rows: [{ id: 'rec_existing', version: 5, data: { fld_title: 'Existing record', fld_internal: 'secret', fld_files: ['att_form_1'] } }],
          }
        }
        if (sql.includes('FROM multitable_attachments')) {
          expect(params).toEqual(['sheet_ops', ['att_form_1']])
          return {
            rows: [{
              id: 'att_form_1',
              sheet_id: 'sheet_ops',
              record_id: 'rec_existing',
              field_id: 'fld_files',
              filename: 'intake.docx',
              original_name: 'intake.docx',
              mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              size: 2048,
              created_at: '2026-03-19T11:00:00.000Z',
            }],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/form-context')
      .query({ viewId: 'view_form_ops', recordId: 'rec_existing' })
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.mode).toBe('form')
    expect(response.body.data.readOnly).toBe(true)
    expect(response.body.data.sheet).toMatchObject({ id: 'sheet_ops', baseId: 'base_ops' })
    expect(response.body.data.view).toMatchObject({ id: 'view_form_ops', type: 'form' })
    expect(response.body.data.fields).toEqual([
      expect.objectContaining({ id: 'fld_title', name: 'Title' }),
      expect.objectContaining({ id: 'fld_files', name: 'Files' }),
    ])
    expect(response.body.data.record).toMatchObject({ id: 'rec_existing', version: 5 })
    expect(response.body.data.commentsScope).toMatchObject({
      targetType: 'meta_record',
      targetId: 'rec_existing',
      baseId: 'base_ops',
      sheetId: 'sheet_ops',
      viewId: 'view_form_ops',
      recordId: 'rec_existing',
      containerType: 'meta_sheet',
      containerId: 'sheet_ops',
    })
    expect(response.body.data.attachmentSummaries).toEqual({
      fld_files: [expect.objectContaining({
        id: 'att_form_1',
        filename: 'intake.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 2048,
        url: expect.stringContaining('/api/multitable/attachments/att_form_1'),
        thumbnailUrl: null,
        uploadedAt: '2026-03-19T11:00:00.000Z',
      })],
    })
  })

  test('marks computed and explicitly readonly fields as readOnly across form and record contexts', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write', 'comments:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_ops_permissions'])
          return {
            rows: [{
              id: 'view_ops_permissions',
              sheet_id: 'sheet_ops',
              name: 'Ops Grid',
              type: 'grid',
              filter_info: {},
              sort_info: {},
              group_info: {},
              hidden_field_ids: ['fld_hidden_lookup'],
              config: {},
            }],
          }
        }
        if (sql.includes('SELECT id, sheet_id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
          expect(params).toEqual(['rec_perm_1', 'sheet_ops'])
          return {
            rows: [{
              id: 'rec_perm_1',
              sheet_id: 'sheet_ops',
              version: 7,
              data: {
                fld_title: 'Editable title',
                fld_formula_total: '42',
                fld_hidden_lookup: 'Derived',
                fld_locked: 'Locked value',
              },
            }],
          }
        }
        if (sql.includes('SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
          expect(params).toEqual(['rec_perm_1', 'sheet_ops'])
          return {
            rows: [{
              id: 'rec_perm_1',
              version: 7,
              data: {
                fld_title: 'Editable title',
                fld_formula_total: '42',
                fld_hidden_lookup: 'Derived',
                fld_locked: 'Locked value',
              },
            }],
          }
        }
        if (sql.includes('SELECT id, sheet_id, version, data FROM meta_records WHERE id = $1')) {
          expect(params).toEqual(['rec_perm_1'])
          return {
            rows: [{
              id: 'rec_perm_1',
              sheet_id: 'sheet_ops',
              version: 7,
              data: {
                fld_title: 'Editable title',
                fld_formula_total: '42',
                fld_hidden_lookup: 'Derived',
                fld_locked: 'Locked value',
              },
            }],
          }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: 'Ops intake' }] }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [
              { id: 'fld_title', name: 'Title', type: 'string', property: {}, order: 1 },
              { id: 'fld_formula_total', name: 'Total', type: 'formula', property: { expression: '{fld_amount} * 2' }, order: 2 },
              { id: 'fld_hidden_lookup', name: 'Lookup', type: 'lookup', property: { linkFieldId: 'fld_vendor', targetFieldId: 'fld_name' }, order: 3 },
              { id: 'fld_locked', name: 'Locked', type: 'string', property: { readOnly: true }, order: 4 },
            ],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const formResponse = await request(app)
      .get('/api/multitable/form-context')
      .query({ viewId: 'view_ops_permissions', recordId: 'rec_perm_1' })
      .expect(200)

    expect(formResponse.body.data.readOnly).toBe(false)
    expect(formResponse.body.data.fieldPermissions).toEqual({
      fld_title: { visible: true, readOnly: false },
      fld_formula_total: { visible: true, readOnly: true },
      fld_hidden_lookup: { visible: false, readOnly: true },
      fld_locked: { visible: true, readOnly: true },
    })

    const recordResponse = await request(app)
      .get('/api/multitable/records/rec_perm_1')
      .query({ viewId: 'view_ops_permissions' })
      .expect(200)

    expect(recordResponse.body.data.fieldPermissions).toEqual({
      fld_title: { visible: true, readOnly: false },
      fld_formula_total: { visible: true, readOnly: true },
      fld_hidden_lookup: { visible: false, readOnly: true },
      fld_locked: { visible: true, readOnly: true },
    })
    expect(recordResponse.body.data.rowActions).toEqual({
      canEdit: true,
      canDelete: true,
      canComment: true,
    })
  })

  test('returns grid view data with optional link summaries', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_orders'])
          return {
            rows: [{
              id: 'view_orders',
              sheet_id: 'sheet_orders',
              name: 'Orders Grid',
              type: 'grid',
              filter_info: {},
              sort_info: {},
              group_info: {},
              hidden_field_ids: [],
              config: {},
            }],
          }
        }
        if (sql.includes('SELECT id, name FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
          expect(params).toEqual(['sheet_orders'])
          return { rows: [{ id: 'sheet_orders', name: 'Orders' }] }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC')) {
          if (params?.[0] === 'sheet_orders') {
            return {
              rows: [
                { id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 1 },
                { id: 'fld_vendor_link', name: 'Vendor', type: 'link', property: { foreignSheetId: 'sheet_vendors' }, order: 2 },
                { id: 'fld_files', name: 'Files', type: 'attachment', property: {}, order: 3 },
              ],
            }
          }
          if (params?.[0] === 'sheet_vendors') {
            return {
              rows: [{ id: 'fld_vendor_name', name: 'Vendor Name', type: 'string', property: {}, order: 1 }],
            }
          }
        }
        if (sql.includes('SELECT id, version, data FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC')) {
          expect(params).toEqual(['sheet_orders'])
          return {
            rows: [
              {
                id: 'rec_1',
                version: 2,
                data: { fld_name: 'Order A', fld_vendor_link: ['vendor_1'], fld_files: ['att_view_1'] },
              },
            ],
          }
        }
        if (sql.includes('FROM meta_links') && sql.includes('record_id = ANY($2::text[])')) {
          expect(params).toEqual([['fld_vendor_link'], ['rec_1']])
          return { rows: [{ field_id: 'fld_vendor_link', record_id: 'rec_1', foreign_record_id: 'vendor_1' }] }
        }
        if (sql.includes('SELECT id, data FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])')) {
          expect(params).toEqual(['sheet_vendors', ['vendor_1']])
          return { rows: [{ id: 'vendor_1', data: { fld_vendor_name: 'Acme Supply' } }] }
        }
        if (sql.includes('FROM multitable_attachments')) {
          expect(params).toEqual(['sheet_orders', ['att_view_1']])
          return {
            rows: [{
              id: 'att_view_1',
              sheet_id: 'sheet_orders',
              record_id: 'rec_1',
              field_id: 'fld_files',
              filename: 'invoice.png',
              original_name: 'invoice.png',
              mime_type: 'image/png',
              size: 512,
              created_at: '2026-03-19T12:00:00.000Z',
            }],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/view')
      .query({ viewId: 'view_orders', includeLinkSummaries: 'true' })
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.id).toBe('sheet_orders')
    expect(response.body.data.rows).toEqual([
      {
        id: 'rec_1',
        version: 2,
        data: {
          fld_name: 'Order A',
          fld_vendor_link: ['vendor_1'],
          fld_files: ['att_view_1'],
        },
      },
    ])
    expect(response.body.data.linkSummaries).toEqual({
      rec_1: {
        fld_vendor_link: [{ id: 'vendor_1', display: 'Acme Supply' }],
      },
    })
    expect(response.body.data.attachmentSummaries).toEqual({
      rec_1: {
        fld_files: [expect.objectContaining({
          id: 'att_view_1',
          filename: 'invoice.png',
          mimeType: 'image/png',
          size: 512,
          url: expect.stringContaining('/api/multitable/attachments/att_view_1'),
          thumbnailUrl: expect.stringContaining('/api/multitable/attachments/att_view_1?thumbnail=true'),
          uploadedAt: '2026-03-19T12:00:00.000Z',
        })],
      },
    })
  })

  test('applies server-side search before pagination for multitable view data', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_orders_search'])
          return {
            rows: [{
              id: 'view_orders_search',
              sheet_id: 'sheet_orders',
              name: 'Orders Search',
              type: 'grid',
              filter_info: {},
              sort_info: {},
              group_info: {},
              hidden_field_ids: [],
              config: {},
            }],
          }
        }
        if (sql.includes('SELECT id, name FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
          expect(params).toEqual(['sheet_orders'])
          return { rows: [{ id: 'sheet_orders', name: 'Orders' }] }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC')) {
          expect(params).toEqual(['sheet_orders'])
          return {
            rows: [
              { id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 1 },
              { id: 'fld_amount', name: 'Amount', type: 'number', property: {}, order: 2 },
            ],
          }
        }
        if (sql.includes('SELECT id, version, data, COUNT(*) OVER()::int AS total') && sql.includes('WHERE sheet_id = $1 AND (')) {
          expect(params).toEqual(['sheet_orders', '%120%', 'fld_name', 'fld_amount', 1, 0])
          return {
            rows: [
              {
                id: 'rec_2',
                version: 2,
                data: { fld_name: 'Beta rollout', fld_amount: 1200 },
                total: 2,
              },
            ],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/view')
      .query({ viewId: 'view_orders_search', search: '120', limit: '1', offset: '0' })
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.rows).toEqual([
      {
        id: 'rec_2',
        version: 2,
        data: {
          fld_name: 'Beta rollout',
          fld_amount: 1200,
        },
      },
    ])
    expect(response.body.data.page).toEqual({
      offset: 0,
      limit: 1,
      total: 2,
      hasMore: true,
    })
  })

  test('returns field-aware link options with selected records and search results', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, sheet_id, name, type, property FROM meta_fields WHERE id = $1')) {
          expect(params).toEqual(['fld_vendor_link'])
          return {
            rows: [{
              id: 'fld_vendor_link',
              sheet_id: 'sheet_orders',
              name: 'Vendor',
              type: 'link',
              property: { foreignSheetId: 'sheet_vendors' },
            }],
          }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          if (params?.[0] === 'sheet_vendors') {
            return { rows: [{ id: 'sheet_vendors', base_id: 'base_ops', name: 'Vendors', description: null }] }
          }
        }
        if (sql.includes('SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
          expect(params).toEqual(['rec_1', 'sheet_orders'])
          return { rows: [{ id: 'rec_1' }] }
        }
        if (sql.includes('FROM meta_links') && sql.includes('record_id = ANY($2::text[])')) {
          expect(params).toEqual([['fld_vendor_link'], ['rec_1']])
          return { rows: [{ field_id: 'fld_vendor_link', record_id: 'rec_1', foreign_record_id: 'vendor_1' }] }
        }
        if (sql.includes('SELECT id, name, type FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC')) {
          expect(params).toEqual(['sheet_vendors'])
          return {
            rows: [{ id: 'fld_vendor_name', name: 'Vendor Name', type: 'string' }],
          }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC')) {
          expect(params).toEqual(['sheet_vendors'])
          return {
            rows: [{ id: 'fld_vendor_name', name: 'Vendor Name', type: 'string', property: {}, order: 1 }],
          }
        }
        if (sql.includes('SELECT id, data FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])')) {
          expect(params).toEqual(['sheet_vendors', ['vendor_1']])
          return { rows: [{ id: 'vendor_1', data: { fld_vendor_name: 'Acme Supply' } }] }
        }
        if (sql.includes('SELECT id, data FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC')) {
          expect(params).toEqual(['sheet_vendors'])
          return {
            rows: [
              { id: 'vendor_1', data: { fld_vendor_name: 'Acme Supply' } },
              { id: 'vendor_2', data: { fld_vendor_name: 'Acme Industrial' } },
            ],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/fields/fld_vendor_link/link-options')
      .query({ recordId: 'rec_1', search: 'acme', limit: '20', offset: '0' })
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.field).toEqual({
      id: 'fld_vendor_link',
      name: 'Vendor',
      type: 'link',
    })
    expect(response.body.data.targetSheet).toMatchObject({
      id: 'sheet_vendors',
      baseId: 'base_ops',
      name: 'Vendors',
    })
    expect(response.body.data.selected).toEqual([{ id: 'vendor_1', display: 'Acme Supply' }])
    expect(response.body.data.records).toEqual([
      { id: 'vendor_1', display: 'Acme Supply' },
      { id: 'vendor_2', display: 'Acme Industrial' },
    ])
    expect(response.body.data.page).toEqual({
      offset: 0,
      limit: 20,
      total: 2,
      hasMore: false,
    })
  })

  test('submits form updates through a single view endpoint', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:write', 'comments:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_form_ops'])
          return {
            rows: [{
              id: 'view_form_ops',
              sheet_id: 'sheet_ops',
              name: 'Ops Form',
              type: 'form',
              filter_info: {},
              sort_info: {},
              group_info: {},
              hidden_field_ids: [],
              config: {},
            }],
          }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: 'Ops intake' }] }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC')) {
          if (params?.[0] === 'sheet_ops') {
            return {
              rows: [
                { id: 'fld_title', name: 'Title', type: 'string', property: {}, order: 1 },
                { id: 'fld_vendor_link', name: 'Vendor', type: 'link', property: { foreignSheetId: 'sheet_vendors' }, order: 2 },
                { id: 'fld_files', name: 'Files', type: 'attachment', property: {}, order: 3 },
              ],
            }
          }
          if (params?.[0] === 'sheet_vendors') {
            return {
              rows: [{ id: 'fld_vendor_name', name: 'Vendor Name', type: 'string', property: {}, order: 1 }],
            }
          }
        }
        if (sql.includes('SELECT id FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])')) {
          expect(params).toEqual(['sheet_vendors', ['vendor_1']])
          return { rows: [{ id: 'vendor_1' }] }
        }
        if (sql.includes('SELECT id, version FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE')) {
          expect(params).toEqual(['rec_existing', 'sheet_ops'])
          return { rows: [{ id: 'rec_existing', version: 5 }] }
        }
        if (sql.includes('UPDATE meta_records') && sql.includes('RETURNING version')) {
          expect(params).toEqual([JSON.stringify({ fld_title: 'Updated title', fld_vendor_link: ['vendor_1'] }), 'rec_existing', 'sheet_ops'])
          return { rows: [{ version: 6 }] }
        }
        if (sql.includes('SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2')) {
          expect(params).toEqual(['fld_vendor_link', 'rec_existing'])
          return { rows: [] }
        }
        if (sql.includes('INSERT INTO meta_links')) {
          expect(params?.[1]).toBe('fld_vendor_link')
          expect(params?.[2]).toBe('rec_existing')
          expect(params?.[3]).toBe('vendor_1')
          return { rows: [] }
        }
        if (sql.includes('SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
          expect(params).toEqual(['rec_existing', 'sheet_ops'])
          return {
            rows: [{
              id: 'rec_existing',
              version: 6,
              data: { fld_title: 'Updated title', fld_vendor_link: ['vendor_1'], fld_files: ['att_submit_1'] },
            }],
          }
        }
        if (sql.includes('FROM meta_links') && sql.includes('record_id = ANY($2::text[])')) {
          expect(params).toEqual([['fld_vendor_link'], ['rec_existing']])
          return { rows: [{ field_id: 'fld_vendor_link', record_id: 'rec_existing', foreign_record_id: 'vendor_1' }] }
        }
        if (sql.includes('FROM multitable_attachments')) {
          expect(params).toEqual(['sheet_ops', ['att_submit_1']])
          return {
            rows: [{
              id: 'att_submit_1',
              sheet_id: 'sheet_ops',
              record_id: 'rec_existing',
              field_id: 'fld_files',
              filename: 'submitted.pdf',
              original_name: 'submitted.pdf',
              mime_type: 'application/pdf',
              size: 333,
              created_at: '2026-03-19T12:30:00.000Z',
            }],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .post('/api/multitable/views/view_form_ops/submit')
      .send({
        recordId: 'rec_existing',
        expectedVersion: 5,
        data: {
          fld_title: 'Updated title',
          fld_vendor_link: ['vendor_1'],
        },
      })
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.mode).toBe('update')
    expect(response.body.data.record).toEqual({
      id: 'rec_existing',
      version: 6,
      data: {
        fld_title: 'Updated title',
        fld_vendor_link: ['vendor_1'],
        fld_files: ['att_submit_1'],
      },
    })
    expect(response.body.data.attachmentSummaries).toEqual({
      fld_files: [expect.objectContaining({
        id: 'att_submit_1',
        filename: 'submitted.pdf',
        mimeType: 'application/pdf',
        size: 333,
        url: expect.stringContaining('/api/multitable/attachments/att_submit_1'),
        thumbnailUrl: null,
        uploadedAt: '2026-03-19T12:30:00.000Z',
      })],
    })
    expect(response.body.data.commentsScope).toMatchObject({
      targetType: 'meta_record',
      targetId: 'rec_existing',
      baseId: 'base_ops',
      sheetId: 'sheet_ops',
      viewId: 'view_form_ops',
      recordId: 'rec_existing',
      containerType: 'meta_sheet',
      containerId: 'sheet_ops',
    })
  })

  test('patches a single multitable record through the adapter endpoint', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:write', 'comments:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, sheet_id FROM meta_records WHERE id = $1')) {
          expect(params).toEqual(['rec_existing'])
          return { rows: [{ id: 'rec_existing', sheet_id: 'sheet_ops' }] }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: 'Ops intake' }] }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC')) {
          if (params?.[0] === 'sheet_ops') {
            return {
              rows: [
                { id: 'fld_title', name: 'Title', type: 'string', property: {}, order: 1 },
                { id: 'fld_vendor_link', name: 'Vendor', type: 'link', property: { foreignSheetId: 'sheet_vendors' }, order: 2 },
                { id: 'fld_files', name: 'Files', type: 'attachment', property: {}, order: 3 },
              ],
            }
          }
          if (params?.[0] === 'sheet_vendors') {
            return {
              rows: [{ id: 'fld_vendor_name', name: 'Vendor Name', type: 'string', property: {}, order: 1 }],
            }
          }
        }
        if (sql.includes('SELECT id FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])')) {
          expect(params).toEqual(['sheet_vendors', ['vendor_1']])
          return { rows: [{ id: 'vendor_1' }] }
        }
        if (sql.includes('SELECT id, version FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE')) {
          expect(params).toEqual(['rec_existing', 'sheet_ops'])
          return { rows: [{ id: 'rec_existing', version: 3 }] }
        }
        if (sql.includes('UPDATE meta_records') && sql.includes('RETURNING version')) {
          expect(params).toEqual([JSON.stringify({ fld_title: 'Patched title', fld_vendor_link: ['vendor_1'] }), 'rec_existing', 'sheet_ops'])
          return { rows: [{ version: 4 }] }
        }
        if (sql.includes('SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2')) {
          expect(params).toEqual(['fld_vendor_link', 'rec_existing'])
          return { rows: [] }
        }
        if (sql.includes('INSERT INTO meta_links')) {
          expect(params?.[1]).toBe('fld_vendor_link')
          expect(params?.[2]).toBe('rec_existing')
          expect(params?.[3]).toBe('vendor_1')
          return { rows: [] }
        }
        if (sql.includes('SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
          expect(params).toEqual(['rec_existing', 'sheet_ops'])
          return {
            rows: [{
              id: 'rec_existing',
              version: 4,
              data: { fld_title: 'Patched title', fld_vendor_link: ['vendor_1'], fld_files: ['att_patch_1'] },
            }],
          }
        }
        if (sql.includes('FROM meta_links') && sql.includes('record_id = ANY($2::text[])')) {
          expect(params).toEqual([['fld_vendor_link'], ['rec_existing']])
          return { rows: [{ field_id: 'fld_vendor_link', record_id: 'rec_existing', foreign_record_id: 'vendor_1' }] }
        }
        if (sql.includes('FROM multitable_attachments')) {
          expect(params).toEqual(['sheet_ops', ['att_patch_1']])
          return {
            rows: [{
              id: 'att_patch_1',
              sheet_id: 'sheet_ops',
              record_id: 'rec_existing',
              field_id: 'fld_files',
              filename: 'patched.png',
              original_name: 'patched.png',
              mime_type: 'image/png',
              size: 444,
              created_at: '2026-03-19T12:45:00.000Z',
            }],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .patch('/api/multitable/records/rec_existing')
      .send({
        expectedVersion: 3,
        data: {
          fld_title: 'Patched title',
          fld_vendor_link: ['vendor_1'],
        },
      })
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.record).toEqual({
      id: 'rec_existing',
      version: 4,
      data: {
        fld_title: 'Patched title',
        fld_vendor_link: ['vendor_1'],
        fld_files: ['att_patch_1'],
      },
    })
    expect(response.body.data.attachmentSummaries).toEqual({
      fld_files: [expect.objectContaining({
        id: 'att_patch_1',
        filename: 'patched.png',
        mimeType: 'image/png',
        size: 444,
        url: expect.stringContaining('/api/multitable/attachments/att_patch_1'),
        thumbnailUrl: expect.stringContaining('/api/multitable/attachments/att_patch_1?thumbnail=true'),
        uploadedAt: '2026-03-19T12:45:00.000Z',
      })],
    })
    expect(response.body.data.commentsScope).toMatchObject({
      targetType: 'meta_record',
      targetId: 'rec_existing',
      baseId: 'base_ops',
      sheetId: 'sheet_ops',
      viewId: null,
      recordId: 'rec_existing',
      containerType: 'meta_sheet',
      containerId: 'sheet_ops',
    })
  })

  test('returns 404 when patching a missing multitable record through the direct endpoint', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, sheet_id FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
          expect(params).toEqual(['rec_missing', 'sheet_ops'])
          return { rows: [] }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .patch('/api/multitable/records/rec_missing')
      .send({
        sheetId: 'sheet_ops',
        expectedVersion: 1,
        data: {
          fld_title: 'Missing title',
        },
      })
      .expect(404)

    expect(response.body.ok).toBe(false)
    expect(response.body.error.code).toBe('NOT_FOUND')
    expect(response.body.error.message).toBe('Record not found: rec_missing')
  })

  test('returns link summaries from patch response for updated multitable link fields', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, name, type, property FROM meta_fields WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_orders'])
          return {
            rows: [
              { id: 'fld_vendor_link', name: 'Vendor', type: 'link', property: { foreignSheetId: 'sheet_vendors' } },
            ],
          }
        }
        if (sql.includes('SELECT id, version FROM meta_records WHERE sheet_id = $1 AND id = $2 FOR UPDATE')) {
          expect(params).toEqual(['sheet_orders', 'rec_1'])
          return { rows: [{ id: 'rec_1', version: 2 }] }
        }
        if (sql.includes('SELECT id FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])')) {
          expect(params).toEqual(['sheet_vendors', ['vendor_1', 'vendor_2']])
          return { rows: [{ id: 'vendor_1' }, { id: 'vendor_2' }] }
        }
        if (sql.includes('UPDATE meta_records') && sql.includes('WHERE sheet_id = $2 AND id = $3')) {
          expect(params).toEqual([JSON.stringify({ fld_vendor_link: ['vendor_1', 'vendor_2'] }), 'sheet_orders', 'rec_1'])
          return { rows: [{ version: 3 }] }
        }
        if (sql.includes('SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2')) {
          expect(params).toEqual(['fld_vendor_link', 'rec_1'])
          return { rows: [{ foreign_record_id: 'vendor_1' }] }
        }
        if (sql.includes('INSERT INTO meta_links')) {
          expect(params?.[1]).toBe('fld_vendor_link')
          expect(params?.[2]).toBe('rec_1')
          expect(params?.[3]).toBe('vendor_2')
          return { rows: [] }
        }
        if (sql.includes('SELECT record_id FROM meta_links WHERE foreign_record_id = ANY($1::text[])')) {
          expect(params).toEqual([['rec_1']])
          return { rows: [] }
        }
        if (sql.includes('FROM meta_links') && sql.includes('record_id = ANY($2::text[])')) {
          expect(params).toEqual([['fld_vendor_link'], ['rec_1']])
          return {
            rows: [
              { field_id: 'fld_vendor_link', record_id: 'rec_1', foreign_record_id: 'vendor_1' },
              { field_id: 'fld_vendor_link', record_id: 'rec_1', foreign_record_id: 'vendor_2' },
            ],
          }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_vendors'])
          return {
            rows: [{ id: 'fld_vendor_name', name: 'Vendor Name', type: 'string', property: {}, order: 1 }],
          }
        }
        if (sql.includes('SELECT id, data FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])')) {
          expect(params).toEqual(['sheet_vendors', ['vendor_1', 'vendor_2']])
          return {
            rows: [
              { id: 'vendor_1', data: { fld_vendor_name: 'Acme Supply' } },
              { id: 'vendor_2', data: { fld_vendor_name: 'Beacon Labs' } },
            ],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .post('/api/multitable/patch')
      .send({
        sheetId: 'sheet_orders',
        changes: [{
          recordId: 'rec_1',
          fieldId: 'fld_vendor_link',
          value: ['vendor_1', 'vendor_2'],
          expectedVersion: 2,
        }],
      })
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.updated).toEqual([{ recordId: 'rec_1', version: 3 }])
    expect(response.body.data.linkSummaries).toEqual({
      rec_1: {
        fld_vendor_link: [
          { id: 'vendor_1', display: 'Acme Supply' },
          { id: 'vendor_2', display: 'Beacon Labs' },
        ],
      },
    })
  })

  test('returns attachment summaries from patch response for updated multitable attachment fields', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, name, type, property FROM meta_fields WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_orders'])
          return {
            rows: [
              { id: 'fld_files', name: 'Files', type: 'attachment', property: {} },
            ],
          }
        }
        if (sql.includes('SELECT id, version FROM meta_records WHERE sheet_id = $1 AND id = $2 FOR UPDATE')) {
          expect(params).toEqual(['sheet_orders', 'rec_1'])
          return { rows: [{ id: 'rec_1', version: 7 }] }
        }
        if (sql.includes('FROM multitable_attachments')) {
          if (sql.includes('deleted_at IS NULL') && sql.includes('id = ANY($2::text[])')) {
            expect(params).toEqual(['sheet_orders', ['att_patch_a', 'att_patch_b']])
            return {
              rows: [
                {
                  id: 'att_patch_a',
                  sheet_id: 'sheet_orders',
                  record_id: 'rec_1',
                  field_id: 'fld_files',
                  filename: 'evidence-a.png',
                  original_name: 'evidence-a.png',
                  mime_type: 'image/png',
                  size: 100,
                  created_at: '2026-03-19T13:00:00.000Z',
                },
                {
                  id: 'att_patch_b',
                  sheet_id: 'sheet_orders',
                  record_id: 'rec_1',
                  field_id: 'fld_files',
                  filename: 'evidence-b.pdf',
                  original_name: 'evidence-b.pdf',
                  mime_type: 'application/pdf',
                  size: 200,
                  created_at: '2026-03-19T13:01:00.000Z',
                },
              ],
            }
          }
        }
        if (sql.includes('UPDATE meta_records') && sql.includes('WHERE sheet_id = $2 AND id = $3')) {
          expect(params).toEqual([JSON.stringify({ fld_files: ['att_patch_a', 'att_patch_b'] }), 'sheet_orders', 'rec_1'])
          return { rows: [{ version: 8 }] }
        }
        if (sql.includes('SELECT id, version, data FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])')) {
          expect(params).toEqual(['sheet_orders', ['rec_1']])
          return {
            rows: [{
              id: 'rec_1',
              version: 8,
              data: { fld_files: ['att_patch_a', 'att_patch_b'] },
            }],
          }
        }
        if (sql.includes('SELECT record_id FROM meta_links WHERE foreign_record_id = ANY($1::text[])')) {
          expect(params).toEqual([['rec_1']])
          return { rows: [] }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .post('/api/multitable/patch')
      .send({
        sheetId: 'sheet_orders',
        changes: [{
          recordId: 'rec_1',
          fieldId: 'fld_files',
          value: ['att_patch_a', 'att_patch_b'],
          expectedVersion: 7,
        }],
      })
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.updated).toEqual([{ recordId: 'rec_1', version: 8 }])
    expect(response.body.data.attachmentSummaries).toEqual({
      rec_1: {
        fld_files: [
          expect.objectContaining({
            id: 'att_patch_a',
            filename: 'evidence-a.png',
            mimeType: 'image/png',
            size: 100,
            url: expect.stringContaining('/api/multitable/attachments/att_patch_a'),
            thumbnailUrl: expect.stringContaining('/api/multitable/attachments/att_patch_a?thumbnail=true'),
            uploadedAt: '2026-03-19T13:00:00.000Z',
          }),
          expect.objectContaining({
            id: 'att_patch_b',
            filename: 'evidence-b.pdf',
            mimeType: 'application/pdf',
            size: 200,
            url: expect.stringContaining('/api/multitable/attachments/att_patch_b'),
            thumbnailUrl: null,
            uploadedAt: '2026-03-19T13:01:00.000Z',
          }),
        ],
      },
    })
  })

  test('returns form fieldErrors when hidden fields are submitted', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_form_ops'])
          return {
            rows: [{
              id: 'view_form_ops',
              sheet_id: 'sheet_ops',
              name: 'Ops Form',
              type: 'form',
              filter_info: {},
              sort_info: {},
              group_info: {},
              hidden_field_ids: ['fld_internal'],
              config: {},
            }],
          }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [
              { id: 'fld_title', name: 'Title', type: 'string', property: {}, order: 1 },
              { id: 'fld_internal', name: 'Internal Only', type: 'string', property: {}, order: 2 },
            ],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .post('/api/multitable/views/view_form_ops/submit')
      .send({
        data: {
          fld_internal: 'secret',
        },
      })
      .expect(400)

    expect(response.body.ok).toBe(false)
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
    expect(response.body.error.fieldErrors).toEqual({
      fld_internal: 'Field is not available in this form',
    })
  })
})
