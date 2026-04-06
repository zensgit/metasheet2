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
  requestPermissions?: string[]
  requestRole?: string
  userPermissionMap?: Record<string, string[]>
  queryHandler: QueryHandler
}) {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockImplementation(async (userId: string) => args.userPermissionMap?.[userId] ?? []),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const mockPool = createMockPool(args.queryHandler)
  vi.spyOn(poolManager, 'get').mockReturnValue(mockPool as any)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = {
      id: 'user_sheet_acl_1',
      role: args.requestRole,
      permissions: args.requestPermissions,
      roles: args.tokenRoles ?? [],
      perms: args.tokenPerms ?? [],
    }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return { app, mockPool }
}

describe('Multitable sheet-scoped permissions API', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  test('narrows context and record actions when sheet permission is read-only', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write', 'comments:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM meta_sheets s') && sql.includes('LEFT JOIN meta_bases')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Orders', description: 'Ops records' }],
          }
        }
        if (sql.includes('FROM meta_bases') && sql.includes('WHERE id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [{ id: 'base_ops', name: 'Ops Base', icon: 'table', color: '#1677ff', owner_id: 'owner_1', workspace_id: 'workspace_1' }],
          }
        }
        if (sql.includes('FROM meta_sheets') && sql.includes('WHERE base_id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Orders', description: 'Ops records' }],
          }
        }
        if (sql.includes('FROM spreadsheet_permissions')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return {
            rows: [{ sheet_id: 'sheet_ops', perm_code: 'spreadsheet:read' }],
          }
        }
        if (sql.includes('FROM meta_views') && sql.includes('WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'view_grid', sheet_id: 'sheet_ops', name: 'Grid', type: 'grid', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} }],
          }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 1 }],
          }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Orders', description: 'Ops records' }],
          }
        }
        if (sql.includes('SELECT id, sheet_id, version, data, created_by FROM meta_records WHERE id = $1')) {
          expect(params).toEqual(['rec_1'])
          return {
            rows: [{ id: 'rec_1', sheet_id: 'sheet_ops', version: 3, data: { fld_name: 'Order A' } }],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const contextResponse = await request(app)
      .get('/api/multitable/context')
      .query({ sheetId: 'sheet_ops' })
      .expect(200)

    expect(contextResponse.body.data.capabilities).toEqual({
      canRead: true,
      canCreateRecord: false,
      canEditRecord: false,
      canDeleteRecord: false,
      canManageFields: false,
      canManageSheetAccess: false,
      canManageViews: false,
      canComment: true,
      canManageAutomation: false,
    })
    expect(contextResponse.body.data.viewPermissions).toEqual({
      view_grid: {
        canAccess: true,
        canConfigure: false,
        canDelete: false,
      },
    })

    const recordResponse = await request(app)
      .get('/api/multitable/records/rec_1')
      .expect(200)

    expect(recordResponse.body.data.rowActions).toEqual({
      canEdit: false,
      canDelete: false,
      canComment: true,
    })
    expect(recordResponse.body.data.capabilities).toMatchObject({
      canRead: true,
      canEditRecord: false,
      canDeleteRecord: false,
    })
  })

  test('allows context when sheet read grant exists without global multitable permission', async () => {
    const { app } = await createApp({
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM meta_sheets s') && sql.includes('LEFT JOIN meta_bases')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Orders', description: 'Ops records' }],
          }
        }
        if (sql.includes('FROM meta_bases') && sql.includes('WHERE id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [{ id: 'base_ops', name: 'Ops Base', icon: 'table', color: '#1677ff', owner_id: 'owner_1', workspace_id: 'workspace_1' }],
          }
        }
        if (sql.includes('FROM meta_sheets') && sql.includes('WHERE base_id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Orders', description: 'Ops records' }],
          }
        }
        if (sql.includes('FROM spreadsheet_permissions')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return {
            rows: [{ sheet_id: 'sheet_ops', perm_code: 'spreadsheet:read' }],
          }
        }
        if (sql.includes('FROM meta_views') && sql.includes('WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'view_grid', sheet_id: 'sheet_ops', name: 'Grid', type: 'grid', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} }],
          }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 1 }],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/context')
      .query({ sheetId: 'sheet_ops' })
      .expect(200)

    expect(response.body.data.capabilities).toMatchObject({
      canRead: true,
      canCreateRecord: false,
      canEditRecord: false,
      canDeleteRecord: false,
      canManageFields: false,
      canManageSheetAccess: false,
      canManageViews: false,
      canComment: false,
    })
    expect(response.body.data.sheet?.id).toBe('sheet_ops')
  })

  test('allows context when sheet write-own grant exists without global multitable permission', async () => {
    const { app } = await createApp({
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM meta_sheets s') && sql.includes('LEFT JOIN meta_bases')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Orders', description: 'Ops records' }],
          }
        }
        if (sql.includes('FROM meta_bases') && sql.includes('WHERE id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [{ id: 'base_ops', name: 'Ops Base', icon: 'table', color: '#1677ff', owner_id: 'owner_1', workspace_id: 'workspace_1' }],
          }
        }
        if (sql.includes('FROM meta_sheets') && sql.includes('WHERE base_id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Orders', description: 'Ops records' }],
          }
        }
        if (sql.includes('FROM spreadsheet_permissions')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return {
            rows: [
              { sheet_id: 'sheet_ops', perm_code: 'spreadsheet:read' },
              { sheet_id: 'sheet_ops', perm_code: 'spreadsheet:write-own' },
            ],
          }
        }
        if (sql.includes('FROM meta_views') && sql.includes('WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'view_grid', sheet_id: 'sheet_ops', name: 'Grid', type: 'grid', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} }],
          }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 1 }],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/context')
      .query({ sheetId: 'sheet_ops' })
      .expect(200)

    expect(response.body.data.capabilities).toMatchObject({
      canRead: true,
      canCreateRecord: true,
      canEditRecord: true,
      canDeleteRecord: true,
      canManageFields: false,
      canManageSheetAccess: false,
      canManageViews: false,
      canComment: false,
    })
    expect(response.body.data.sheet?.id).toBe('sheet_ops')
  })

  test('rejects context when neither global multitable permission nor sheet grant exists', async () => {
    const { app } = await createApp({
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM meta_sheets s') && sql.includes('LEFT JOIN meta_bases')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Orders', description: 'Ops records' }],
          }
        }
        if (sql.includes('FROM meta_bases') && sql.includes('WHERE id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [{ id: 'base_ops', name: 'Ops Base', icon: 'table', color: '#1677ff', owner_id: 'owner_1', workspace_id: 'workspace_1' }],
          }
        }
        if (sql.includes('FROM meta_sheets') && sql.includes('WHERE base_id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Orders', description: 'Ops records' }],
          }
        }
        if (sql.includes('FROM spreadsheet_permissions')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return { rows: [] }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/context')
      .query({ sheetId: 'sheet_ops' })
      .expect(403)

    expect(response.body).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
    })
  })

  test('allows view when sheet read grant exists without global multitable permission', async () => {
    const { app } = await createApp({
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM spreadsheet_permissions')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return {
            rows: [{ sheet_id: 'sheet_ops', perm_code: 'spreadsheet:read', subject_type: 'user' }],
          }
        }
        if (sql.includes('SELECT id, name FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', name: 'Orders' }] }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 1 }],
          }
        }
        if (sql.includes('SELECT id, version, data FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [] }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/view')
      .query({ sheetId: 'sheet_ops' })
      .expect(200)

    expect(response.body.data.meta.permissions.fieldPermissions).toEqual({
      fld_name: {
        visible: true,
        readOnly: true,
      },
    })
    expect(response.body.data.meta.permissions.rowActions).toEqual({
      canEdit: false,
      canDelete: false,
      canComment: false,
    })
  })

  test('allows form and record context when sheet write-own grant exists without global multitable permission', async () => {
    const { app } = await createApp({
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM spreadsheet_permissions')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return {
            rows: [
              { sheet_id: 'sheet_ops', perm_code: 'spreadsheet:read', subject_type: 'user' },
              { sheet_id: 'sheet_ops', perm_code: 'spreadsheet:write-own', subject_type: 'user' },
            ],
          }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Orders', description: null }] }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 1 }],
          }
        }
        if (sql.includes('SELECT id, version, data, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
          expect(params).toEqual(['rec_owned', 'sheet_ops'])
          return {
            rows: [{ id: 'rec_owned', version: 3, data: { fld_name: 'Mine' }, created_by: 'user_sheet_acl_1' }],
          }
        }
        if (sql.includes('SELECT id, sheet_id, version, data, created_by FROM meta_records WHERE id = $1')) {
          expect(params).toEqual(['rec_owned'])
          return {
            rows: [{ id: 'rec_owned', sheet_id: 'sheet_ops', version: 3, data: { fld_name: 'Mine' }, created_by: 'user_sheet_acl_1' }],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const formResponse = await request(app)
      .get('/api/multitable/form-context')
      .query({ sheetId: 'sheet_ops', recordId: 'rec_owned' })
      .expect(200)

    expect(formResponse.body.data.capabilities).toMatchObject({
      canRead: true,
      canCreateRecord: true,
      canEditRecord: true,
      canDeleteRecord: true,
    })
    expect(formResponse.body.data.rowActions).toEqual({
      canEdit: true,
      canDelete: true,
      canComment: false,
    })

    const recordResponse = await request(app)
      .get('/api/multitable/records/rec_owned')
      .expect(200)

    expect(recordResponse.body.data.capabilities).toMatchObject({
      canRead: true,
      canCreateRecord: true,
      canEditRecord: true,
      canDeleteRecord: true,
    })
    expect(recordResponse.body.data.rowActions).toEqual({
      canEdit: true,
      canDelete: true,
      canComment: false,
    })
  })

  test('rejects view, form-context, and record context when neither global multitable permission nor sheet grant exists', async () => {
    const { app } = await createApp({
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM spreadsheet_permissions')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return { rows: [] }
        }
        if (sql.includes('SELECT id, sheet_id, version, data, created_by FROM meta_records WHERE id = $1')) {
          expect(params).toEqual(['rec_1'])
          return {
            rows: [{ id: 'rec_1', sheet_id: 'sheet_ops', version: 1, data: { fld_name: 'Blocked' }, created_by: 'user_sheet_acl_2' }],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    await request(app)
      .get('/api/multitable/view')
      .query({ sheetId: 'sheet_ops' })
      .expect(403)

    await request(app)
      .get('/api/multitable/form-context')
      .query({ sheetId: 'sheet_ops' })
      .expect(403)

    await request(app)
      .get('/api/multitable/records/rec_1')
      .expect(403)
  })

  test('rejects create, patch, delete, and form submit when sheet permission is read-only', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write', 'comments:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM spreadsheet_permissions')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return {
            rows: [{ sheet_id: 'sheet_ops', perm_code: 'spreadsheet:read' }],
          }
        }
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops' }] }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_form_ops'])
          return {
            rows: [{ id: 'view_form_ops', sheet_id: 'sheet_ops', name: 'Form', type: 'form', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} }],
          }
        }
        if (
          sql.includes('SELECT id, sheet_id FROM meta_records WHERE id = $1')
          || sql.includes('SELECT id, sheet_id, created_by FROM meta_records WHERE id = $1')
        ) {
          expect(params).toEqual(['rec_1'])
          return { rows: [{ id: 'rec_1', sheet_id: 'sheet_ops' }] }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const createResponse = await request(app)
      .post('/api/multitable/records')
      .send({ sheetId: 'sheet_ops', data: { fld_name: 'Blocked create' } })
      .expect(403)
    expect(createResponse.body).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
    })

    const patchResponse = await request(app)
      .patch('/api/multitable/records/rec_1')
      .send({ data: { fld_name: 'Blocked patch' } })
      .expect(403)
    expect(patchResponse.body).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
    })

    const deleteResponse = await request(app)
      .delete('/api/multitable/records/rec_1')
      .expect(403)
    expect(deleteResponse.body).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
    })

    const submitResponse = await request(app)
      .post('/api/multitable/views/view_form_ops/submit')
      .send({ data: { fld_name: 'Blocked submit' } })
      .expect(403)
    expect(submitResponse.body).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
    })
  })

  test('returns owner-scoped row action overrides when sheet permission is write-own', async () => {
    const { app } = await createApp({
      tokenPerms: ['comments:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM spreadsheet_permissions')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return {
            rows: [
              { sheet_id: 'sheet_ops', perm_code: 'spreadsheet:read' },
              { sheet_id: 'sheet_ops', perm_code: 'spreadsheet:write-own' },
            ],
          }
        }
        if (sql.includes('SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_grid_owner'])
          return {
            rows: [{ id: 'view_grid_owner', sheet_id: 'sheet_ops', name: 'Owner Grid', type: 'grid', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} }],
          }
        }
        if (sql.includes('SELECT id, name FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', name: 'Ops' }] }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 1 }],
          }
        }
        if (
          sql.includes('SELECT id, version, data, COUNT(*) OVER()::int AS total')
          || sql.includes('SELECT id, version, data FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC')
        ) {
          expect(params?.[0]).toBe('sheet_ops')
          return {
            rows: [
              { id: 'rec_owned', version: 1, data: { fld_name: 'Mine' }, total: 2 },
              { id: 'rec_foreign', version: 1, data: { fld_name: 'Theirs' }, total: 2 },
            ],
          }
        }
        if (sql.includes('SELECT id, created_by FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])')) {
          expect(params).toEqual(['sheet_ops', ['rec_owned', 'rec_foreign']])
          return {
            rows: [
              { id: 'rec_owned', created_by: 'user_sheet_acl_1' },
              { id: 'rec_foreign', created_by: 'user_sheet_acl_2' },
            ],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/view')
      .query({ viewId: 'view_grid_owner' })
      .expect(200)

    expect(response.body.data.meta.permissions.rowActions).toEqual({
      canEdit: false,
      canDelete: false,
      canComment: true,
    })
    expect(response.body.data.meta.permissions.rowActionOverrides).toEqual({
      rec_owned: {
        canEdit: true,
        canDelete: true,
        canComment: true,
      },
    })
  })

  test('returns record-specific row actions and rejects foreign deletes when sheet permission is write-own without global multitable permission', async () => {
    const { app } = await createApp({
      tokenPerms: ['comments:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM spreadsheet_permissions')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return {
            rows: [
              { sheet_id: 'sheet_ops', perm_code: 'spreadsheet:read' },
              { sheet_id: 'sheet_ops', perm_code: 'spreadsheet:write-own' },
            ],
          }
        }
        if (
          sql.includes('SELECT id, sheet_id, version, data, created_by FROM meta_records WHERE id = $1')
          || sql.includes('SELECT id, sheet_id, version, data FROM meta_records WHERE id = $1')
        ) {
          const recordId = String(params?.[0] ?? '')
          return {
            rows: [{
              id: recordId,
              sheet_id: 'sheet_ops',
              version: recordId === 'rec_owned' ? 3 : 4,
              data: { fld_name: recordId === 'rec_owned' ? 'Mine' : 'Theirs' },
              created_by: recordId === 'rec_owned' ? 'user_sheet_acl_1' : 'user_sheet_acl_2',
            }],
          }
        }
        if (
          sql.includes('SELECT id, sheet_id, created_by FROM meta_records WHERE id = $1')
          || sql.includes('SELECT id, sheet_id FROM meta_records WHERE id = $1')
        ) {
          const recordId = String(params?.[0] ?? '')
          return {
            rows: [{
              id: recordId,
              sheet_id: 'sheet_ops',
              created_by: recordId === 'rec_owned' ? 'user_sheet_acl_1' : 'user_sheet_acl_2',
            }],
          }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 1 }],
          }
        }
        if (sql.includes('SELECT id, version, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE')) {
          const recordId = String(params?.[0] ?? '')
          return {
            rows: [{
              id: recordId,
              version: recordId === 'rec_owned' ? 3 : 4,
              created_by: recordId === 'rec_owned' ? 'user_sheet_acl_1' : 'user_sheet_acl_2',
            }],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const ownedResponse = await request(app)
      .get('/api/multitable/records/rec_owned')
      .expect(200)
    expect(ownedResponse.body.data.rowActions).toEqual({
      canEdit: true,
      canDelete: true,
      canComment: true,
    })

    const foreignResponse = await request(app)
      .get('/api/multitable/records/rec_foreign')
      .expect(200)
    expect(foreignResponse.body.data.rowActions).toEqual({
      canEdit: false,
      canDelete: false,
      canComment: true,
    })

    const patchResponse = await request(app)
      .delete('/api/multitable/records/rec_foreign')
      .expect(403)
    expect(patchResponse.body).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Record deletion is not allowed for this row' },
    })
  })

  test('allows create, form submit, patch, and own delete when sheet permission is write-own without global multitable permission', async () => {
    const records = new Map<string, { id: string; sheetId: string; version: number; data: Record<string, unknown>; createdBy: string | null }>([
      ['rec_owned', { id: 'rec_owned', sheetId: 'sheet_ops', version: 3, data: { fld_name: 'Mine' }, createdBy: 'user_sheet_acl_1' }],
    ])

    const { app } = await createApp({
      tokenPerms: ['comments:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM spreadsheet_permissions')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return {
            rows: [
              { sheet_id: 'sheet_ops', perm_code: 'spreadsheet:read', subject_type: 'user' },
              { sheet_id: 'sheet_ops', perm_code: 'spreadsheet:write-own', subject_type: 'user' },
            ],
          }
        }
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops' }] }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
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
        if (sql.includes('SELECT id, type, property FROM meta_fields WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'fld_name', type: 'string', property: {} }],
          }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 1 }],
          }
        }
        if (sql.includes('SELECT id, name, type, property FROM meta_fields WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'fld_name', name: 'Name', type: 'string', property: {} }],
          }
        }
        if (sql.includes('INSERT INTO meta_records (id, sheet_id, data, version, created_by)')) {
          const [recordId, sheetId, dataJson, _version, createdBy] = params as [string, string, string, number, string]
          const next = {
            id: recordId,
            sheetId,
            version: 1,
            data: JSON.parse(dataJson),
            createdBy,
          }
          records.set(recordId, next)
          return { rows: [{ id: recordId, version: 1 }] }
        }
        if (sql.includes('SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
          const recordId = String(params?.[0] ?? '')
          expect(params?.[1]).toEqual('sheet_ops')
          const row = records.get(recordId)
          return {
            rows: row ? [{ id: row.id, version: row.version, data: row.data }] : [],
          }
        }
        if (sql.includes('SELECT id, version, created_by FROM meta_records WHERE sheet_id = $1 AND id = $2 FOR UPDATE')) {
          expect(params?.[0]).toEqual('sheet_ops')
          const recordId = String(params?.[1] ?? '')
          const row = records.get(recordId)
          return {
            rows: row ? [{ id: row.id, version: row.version, created_by: row.createdBy }] : [],
          }
        }
        if (sql.includes('UPDATE meta_records') && sql.includes('WHERE sheet_id = $2 AND id = $3')) {
          const patch = JSON.parse(String(params?.[0] ?? '{}')) as Record<string, unknown>
          const recordId = String(params?.[2] ?? '')
          const row = records.get(recordId)
          if (!row) return { rows: [] }
          row.version += 1
          row.data = { ...row.data, ...patch }
          records.set(recordId, row)
          return { rows: [{ version: row.version }] }
        }
        if (sql.includes('SELECT record_id FROM meta_links WHERE foreign_record_id = ANY($1::text[])')) {
          expect(params).toEqual([['rec_owned']])
          return { rows: [] }
        }
        if (sql.includes('SELECT id, sheet_id, created_by FROM meta_records WHERE id = $1')) {
          expect(params).toEqual(['rec_owned'])
          const row = records.get('rec_owned')
          return {
            rows: row ? [{ id: row.id, sheet_id: row.sheetId, created_by: row.createdBy }] : [],
          }
        }
        if (sql.includes('SELECT id, sheet_id, version FROM meta_records WHERE id = $1 FOR UPDATE')) {
          expect(params).toEqual(['rec_owned'])
          const row = records.get('rec_owned')
          return {
            rows: row ? [{ id: row.id, sheet_id: row.sheetId, version: row.version }] : [],
          }
        }
        if (sql.includes('DELETE FROM meta_links WHERE record_id = $1 OR foreign_record_id = $1')) {
          expect(params).toEqual(['rec_owned'])
          return { rows: [] }
        }
        if (sql.includes('DELETE FROM meta_records WHERE id = $1')) {
          expect(params).toEqual(['rec_owned'])
          records.delete('rec_owned')
          return { rows: [] }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const createResponse = await request(app)
      .post('/api/multitable/records')
      .send({ sheetId: 'sheet_ops', data: { fld_name: 'Created via grid' } })
      .expect(200)
    expect(createResponse.body.data.record).toMatchObject({
      version: 1,
      data: { fld_name: 'Created via grid' },
    })

    const submitResponse = await request(app)
      .post('/api/multitable/views/view_form_ops/submit')
      .send({ data: { fld_name: 'Created via form' } })
      .expect(200)
    expect(submitResponse.body.data.mode).toBe('create')
    expect(submitResponse.body.data.record).toMatchObject({
      version: 1,
      data: { fld_name: 'Created via form' },
    })

    const patchResponse = await request(app)
      .post('/api/multitable/patch')
      .send({
        sheetId: 'sheet_ops',
        changes: [{
          recordId: 'rec_owned',
          fieldId: 'fld_name',
          value: 'Mine updated',
          expectedVersion: 3,
        }],
      })
      .expect(200)
    expect(patchResponse.body.data.updated).toEqual([{ recordId: 'rec_owned', version: 4 }])
    expect(records.get('rec_owned')?.data).toEqual({ fld_name: 'Mine updated' })

    const deleteResponse = await request(app)
      .delete('/api/multitable/records/rec_owned')
      .expect(200)
    expect(deleteResponse.body).toEqual({
      ok: true,
      data: { deleted: 'rec_owned' },
    })
    expect(records.has('rec_owned')).toBe(false)
  })

  test('rejects field, view, person preset, and sheet management when sheet permission is read-only', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM spreadsheet_permissions')) {
          if (JSON.stringify(params) === JSON.stringify(['user_sheet_acl_1', ['sheet_ops']])) {
            return { rows: [{ sheet_id: 'sheet_ops', perm_code: 'spreadsheet:read' }] }
          }
        }
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops' }] }
        }
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops' }] }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('SELECT id, sheet_id FROM meta_fields WHERE id = $1')) {
          expect(params).toEqual(['fld_title'])
          return { rows: [{ id: 'fld_title', sheet_id: 'sheet_ops' }] }
        }
        if (sql.includes('SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_grid'])
          return {
            rows: [{ id: 'view_grid', sheet_id: 'sheet_ops', name: 'Grid', type: 'grid', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} }],
          }
        }
        if (sql.includes('SELECT id, sheet_id FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_grid'])
          return { rows: [{ id: 'view_grid', sheet_id: 'sheet_ops' }] }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const responses = [
      await request(app).post('/api/multitable/fields').send({ sheetId: 'sheet_ops', name: 'Blocked Field', type: 'string' }),
      await request(app).post('/api/multitable/person-fields/prepare').send({ sheetId: 'sheet_ops' }),
      await request(app).patch('/api/multitable/fields/fld_title').send({ name: 'Blocked rename' }),
      await request(app).delete('/api/multitable/fields/fld_title'),
      await request(app).post('/api/multitable/views').send({ sheetId: 'sheet_ops', name: 'Blocked View', type: 'grid' }),
      await request(app).patch('/api/multitable/views/view_grid').send({ name: 'Blocked view rename' }),
      await request(app).delete('/api/multitable/views/view_grid'),
      await request(app).delete('/api/multitable/sheets/sheet_ops'),
    ]

    for (const response of responses) {
      expect(response.status).toBe(403)
      expect(response.body).toEqual({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
      })
    }
  })

  test('lists sheet permission entries and permission candidates for full sheet writers', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write', 'multitable:share'],
      userPermissionMap: {
        user_alpha: ['multitable:read'],
      },
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('FROM spreadsheet_permissions') && sql.includes('sheet_id = ANY')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return { rows: [{ sheet_id: 'sheet_ops', perm_code: 'spreadsheet:write', subject_type: 'user' }] }
        }
        if (sql.includes('FROM spreadsheet_permissions sp') && sql.includes('GROUP BY sp.subject_type, sp.subject_id')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [
              {
                subject_type: 'user',
                subject_id: 'user_alpha',
                permission_codes: ['spreadsheet:read'],
                user_name: 'Alpha User',
                user_email: 'alpha@example.com',
                user_is_active: true,
              },
              {
                subject_type: 'role',
                subject_id: 'role_ops_writer',
                permission_codes: ['spreadsheet:write'],
                role_name: 'Ops Writers',
              },
            ],
          }
        }
        if (sql.includes('WITH user_candidates AS') && sql.includes('role_candidates AS')) {
          expect(params).toEqual(['sheet_ops', '', '%', 20])
          return {
            rows: [
              {
                subject_type: 'user',
                subject_id: 'user_alpha',
                user_name: 'Alpha User',
                user_email: 'alpha@example.com',
                user_is_active: true,
                permission_codes: ['spreadsheet:read'],
              },
              {
                subject_type: 'role',
                subject_id: 'role_ops_writer',
                user_is_active: true,
                role_name: 'Ops Writers',
                permission_codes: ['spreadsheet:write'],
              },
            ],
          }
        }
        if (sql.includes('SELECT permission_code FROM role_permissions WHERE role_id = $1')) {
          expect(params).toEqual(['role_ops_writer'])
          return { rows: [{ permission_code: 'multitable:write' }] }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const listResponse = await request(app)
      .get('/api/multitable/sheets/sheet_ops/permissions')
      .expect(200)

    expect(listResponse.body.data.items).toEqual([
      {
        subjectType: 'user',
        subjectId: 'user_alpha',
        accessLevel: 'read',
        permissions: ['spreadsheet:read'],
        label: 'Alpha User',
        subtitle: 'alpha@example.com',
        isActive: true,
      },
      {
        subjectType: 'role',
        subjectId: 'role_ops_writer',
        accessLevel: 'write',
        permissions: ['spreadsheet:write'],
        label: 'Ops Writers',
        subtitle: 'role_ops_writer',
        isActive: true,
      },
    ])

    const candidatesResponse = await request(app)
      .get('/api/multitable/sheets/sheet_ops/permission-candidates')
      .query({ q: '' })
      .expect(200)

    expect(candidatesResponse.body.data).toEqual({
      items: [
        {
          subjectType: 'user',
          subjectId: 'user_alpha',
          label: 'Alpha User',
          subtitle: 'alpha@example.com',
          isActive: true,
          accessLevel: 'read',
        },
        {
          subjectType: 'role',
          subjectId: 'role_ops_writer',
          label: 'Ops Writers',
          subtitle: 'role_ops_writer',
          isActive: true,
          accessLevel: 'write',
        },
      ],
      total: 2,
      limit: 20,
      query: '',
    })
  })

  test('prefers direct user grants over inherited role grants when resolving effective sheet access', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write', 'comments:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM meta_sheets s') && sql.includes('LEFT JOIN meta_bases')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Orders', description: 'Ops records' }],
          }
        }
        if (sql.includes('FROM meta_bases') && sql.includes('WHERE id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [{ id: 'base_ops', name: 'Ops Base', icon: 'table', color: '#1677ff', owner_id: 'owner_1', workspace_id: 'workspace_1' }],
          }
        }
        if (sql.includes('FROM meta_sheets') && sql.includes('WHERE base_id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Orders', description: 'Ops records' }],
          }
        }
        if (sql.includes('FROM spreadsheet_permissions') && sql.includes('sheet_id = ANY')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return {
            rows: [
              { sheet_id: 'sheet_ops', perm_code: 'spreadsheet:read', subject_type: 'user' },
              { sheet_id: 'sheet_ops', perm_code: 'spreadsheet:write', subject_type: 'role' },
            ],
          }
        }
        if (sql.includes('FROM meta_views') && sql.includes('WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'view_grid', sheet_id: 'sheet_ops', name: 'Grid', type: 'grid', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} }],
          }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 1 }],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/context')
      .query({ sheetId: 'sheet_ops' })
      .expect(200)

    expect(response.body.data.capabilities).toMatchObject({
      canRead: true,
      canCreateRecord: false,
      canEditRecord: false,
      canDeleteRecord: false,
      canManageFields: false,
      canManageSheetAccess: false,
      canManageViews: false,
      canComment: true,
    })
  })

  test('filters permission candidates that lack global multitable access', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write', 'multitable:share'],
      userPermissionMap: {
        user_allowed: ['multitable:write'],
      },
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('FROM spreadsheet_permissions') && sql.includes('sheet_id = ANY')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return { rows: [{ sheet_id: 'sheet_ops', perm_code: 'spreadsheet:write', subject_type: 'user' }] }
        }
        if (sql.includes('WITH user_candidates AS') && sql.includes('role_candidates AS')) {
          expect(params).toEqual(['sheet_ops', '', '%', 20])
          return {
            rows: [
              {
                subject_type: 'user',
                subject_id: 'user_allowed',
                user_name: 'Allowed User',
                user_email: 'allowed@example.com',
                user_is_active: true,
                permission_codes: [],
              },
              {
                subject_type: 'user',
                subject_id: 'user_scope_only',
                user_name: 'Scope Only User',
                user_email: 'scope@example.com',
                user_is_active: true,
                permission_codes: ['spreadsheet:read'],
              },
              {
                subject_type: 'role',
                subject_id: 'role_allowed',
                role_name: 'Allowed Role',
                user_is_active: true,
                permission_codes: [],
              },
              {
                subject_type: 'role',
                subject_id: 'role_scope_only',
                role_name: 'Scope Only Role',
                user_is_active: true,
                permission_codes: ['spreadsheet:read'],
              },
            ],
          }
        }
        if (sql.includes('SELECT permission_code FROM role_permissions WHERE role_id = $1')) {
          if (params?.[0] === 'role_allowed') return { rows: [{ permission_code: 'multitable:read' }] }
          if (params?.[0] === 'role_scope_only') return { rows: [] }
          throw new Error(`Unexpected role permission lookup: ${params?.[0]}`)
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/sheets/sheet_ops/permission-candidates')
      .expect(200)

    expect(response.body.data).toEqual({
      items: [
        {
          subjectType: 'user',
          subjectId: 'user_allowed',
          label: 'Allowed User',
          subtitle: 'allowed@example.com',
          isActive: true,
          accessLevel: null,
        },
        {
          subjectType: 'role',
          subjectId: 'role_allowed',
          label: 'Allowed Role',
          subtitle: 'role_allowed',
          isActive: true,
          accessLevel: null,
        },
      ],
      total: 2,
      limit: 20,
      query: '',
    })
  })

  test('sets sheet permission access levels through the authoring endpoint', async () => {
    const deleteCalls: Array<unknown[] | undefined> = []
    const insertCalls: Array<unknown[] | undefined> = []

    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write', 'multitable:share'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('FROM spreadsheet_permissions') && sql.includes('sheet_id = ANY')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return { rows: [{ sheet_id: 'sheet_ops', perm_code: 'spreadsheet:write', subject_type: 'user' }] }
        }
        if (sql.includes('SELECT id FROM users WHERE id = $1')) {
          expect(params).toEqual(['user_target'])
          return { rows: [{ id: 'user_target' }] }
        }
        if (sql.includes('DELETE FROM spreadsheet_permissions') && sql.includes('subject_type = $2')) {
          deleteCalls.push(params)
          return { rows: [], rowCount: 2 }
        }
        if (sql.includes('INSERT INTO spreadsheet_permissions(sheet_id, user_id, subject_type, subject_id, perm_code)')) {
          insertCalls.push(params)
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('FROM spreadsheet_permissions sp') && sql.includes('GROUP BY sp.subject_type, sp.subject_id')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{
              subject_type: 'user',
              subject_id: 'user_target',
              permission_codes: ['spreadsheet:write-own'],
              user_name: 'Target User',
              user_email: 'target@example.com',
              user_is_active: true,
            }],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .put('/api/multitable/sheets/sheet_ops/permissions/user/user_target')
      .send({ accessLevel: 'write-own' })
      .expect(200)

    expect(deleteCalls).toEqual([[
      'sheet_ops',
      'user',
      'user_target',
      [
        'spreadsheet:read',
        'spreadsheet:write',
        'spreadsheet:write-own',
        'spreadsheets:read',
        'spreadsheets:write',
        'spreadsheets:write-own',
        'multitable:read',
        'multitable:write',
        'multitable:write-own',
      ],
    ]])
    expect(insertCalls).toEqual([['sheet_ops', 'user_target', 'user', 'user_target', 'spreadsheet:write-own']])
    expect(response.body.data).toEqual({
      subjectType: 'user',
      subjectId: 'user_target',
      accessLevel: 'write-own',
      entry: {
        subjectType: 'user',
        subjectId: 'user_target',
        accessLevel: 'write-own',
        permissions: ['spreadsheet:write-own'],
        label: 'Target User',
        subtitle: 'target@example.com',
        isActive: true,
      },
    })
  })

  test('allows sheet permission authoring with multitable share even when field management is unavailable', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:share'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('FROM spreadsheet_permissions') && sql.includes('sheet_id = ANY')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return { rows: [{ sheet_id: 'sheet_ops', perm_code: 'spreadsheet:write', subject_type: 'user' }] }
        }
        if (sql.includes('FROM meta_sheets s') && sql.includes('LEFT JOIN meta_bases')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('FROM meta_bases') && sql.includes('WHERE id = $1')) {
          expect(params).toEqual(['base_ops'])
          return { rows: [{ id: 'base_ops', name: 'Ops Base', icon: 'table', color: '#1677ff', owner_id: 'owner_1', workspace_id: 'workspace_1' }] }
        }
        if (sql.includes('FROM meta_sheets') && sql.includes('WHERE base_id = $1')) {
          expect(params).toEqual(['base_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('FROM meta_views') && sql.includes('WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [] }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [] }
        }
        if (sql.includes('FROM spreadsheet_permissions sp') && sql.includes('GROUP BY sp.subject_type, sp.subject_id')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{
              subject_type: 'user',
              subject_id: 'user_target',
              permission_codes: ['spreadsheet:write'],
              user_name: 'Target User',
              user_email: 'target@example.com',
              user_is_active: true,
            }],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const [contextResponse, permissionsResponse] = await Promise.all([
      request(app).get('/api/multitable/context').query({ sheetId: 'sheet_ops' }).expect(200),
      request(app).get('/api/multitable/sheets/sheet_ops/permissions').expect(200),
    ])

    expect(contextResponse.body.data.capabilities).toMatchObject({
      canManageFields: false,
      canManageSheetAccess: true,
    })
    expect(permissionsResponse.body.data.items).toEqual([
      {
        subjectType: 'user',
        subjectId: 'user_target',
        accessLevel: 'write',
        permissions: ['spreadsheet:write'],
        label: 'Target User',
        subtitle: 'target@example.com',
        isActive: true,
      },
    ])
  })

  test('rejects write-own grants for role subjects', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write', 'multitable:share'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('FROM spreadsheet_permissions') && sql.includes('sheet_id = ANY')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return { rows: [{ sheet_id: 'sheet_ops', perm_code: 'spreadsheet:write', subject_type: 'user' }] }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .put('/api/multitable/sheets/sheet_ops/permissions/role/role_ops_writer')
      .send({ accessLevel: 'write-own' })
      .expect(400)

    expect(response.body).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'write-own is only supported for direct user grants' },
    })
  })

  test('rejects sheet permission authoring for write-own scoped users', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write', 'multitable:share'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('FROM spreadsheet_permissions') && sql.includes('sheet_id = ANY')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return { rows: [{ sheet_id: 'sheet_ops', perm_code: 'spreadsheet:write-own', subject_type: 'user' }] }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const responses = [
      await request(app).get('/api/multitable/sheets/sheet_ops/permissions'),
      await request(app).get('/api/multitable/sheets/sheet_ops/permission-candidates'),
      await request(app).put('/api/multitable/sheets/sheet_ops/permissions/user/user_target').send({ accessLevel: 'read' }),
    ]

    for (const response of responses) {
      expect(response.status).toBe(403)
      expect(response.body).toEqual({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
      })
    }
  })

  test('rejects sheet permission authoring when multitable write exists without share access', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('FROM spreadsheet_permissions') && sql.includes('sheet_id = ANY')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return { rows: [{ sheet_id: 'sheet_ops', perm_code: 'spreadsheet:write', subject_type: 'user' }] }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const responses = await Promise.all([
      request(app).get('/api/multitable/sheets/sheet_ops/permissions'),
      request(app).get('/api/multitable/sheets/sheet_ops/permission-candidates'),
      request(app).put('/api/multitable/sheets/sheet_ops/permissions/user/user_target').send({ accessLevel: 'read' }),
    ])

    for (const response of responses) {
      expect(response.status).toBe(403)
      expect(response.body).toEqual({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
      })
    }
  })

  test('rejects records summary when sheet permission has no read access', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
          expect(params).toEqual(['sheet_locked'])
          return { rows: [{ id: 'sheet_locked' }] }
        }
        if (sql.includes('FROM spreadsheet_permissions')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_locked']])
          return {
            rows: [{ sheet_id: 'sheet_locked', perm_code: 'spreadsheet:comment' }],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/records-summary')
      .query({ sheetId: 'sheet_locked' })
      .expect(403)

    expect(response.body).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
    })
  })

  test('allows records summary when sheet read grant exists without global multitable permission', async () => {
    const { app } = await createApp({
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
          expect(params).toEqual(['sheet_open'])
          return { rows: [{ id: 'sheet_open' }] }
        }
        if (sql.includes('FROM spreadsheet_permissions')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_open']])
          return {
            rows: [{ sheet_id: 'sheet_open', perm_code: 'spreadsheet:read', subject_type: 'user' }],
          }
        }
        if (sql.includes('SELECT id, name, type FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC')) {
          expect(params).toEqual(['sheet_open'])
          return {
            rows: [{ id: 'fld_title', name: 'Title', type: 'string' }],
          }
        }
        if (sql.includes('SELECT id, data FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC')) {
          expect(params).toEqual(['sheet_open'])
          return {
            rows: [
              { id: 'rec_1', data: { fld_title: 'Alpha' } },
              { id: 'rec_2', data: { fld_title: 'Beta' } },
            ],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/records-summary')
      .query({ sheetId: 'sheet_open' })
      .expect(200)

    expect(response.body.data.records).toEqual([
      { id: 'rec_1', display: 'Alpha' },
      { id: 'rec_2', display: 'Beta' },
    ])
    expect(response.body.data.page).toMatchObject({
      offset: 0,
      limit: 50,
      total: 2,
      hasMore: false,
    })
  })

  test('rejects link options when target sheet permission has no read access', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, sheet_id, name, type, property FROM meta_fields WHERE id = $1')) {
          expect(params).toEqual(['fld_vendor_link'])
          return {
            rows: [{
              id: 'fld_vendor_link',
              sheet_id: 'sheet_source',
              name: 'Vendor',
              type: 'link',
              property: { foreignSheetId: 'sheet_target' },
            }],
          }
        }
        if (sql.includes('FROM spreadsheet_permissions')) {
          if (JSON.stringify(params) === JSON.stringify(['user_sheet_acl_1', ['sheet_source']])) {
            return { rows: [{ sheet_id: 'sheet_source', perm_code: 'spreadsheet:read' }] }
          }
          if (JSON.stringify(params) === JSON.stringify(['user_sheet_acl_1', ['sheet_target']])) {
            return { rows: [{ sheet_id: 'sheet_target', perm_code: 'spreadsheet:comment' }] }
          }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_target'])
          return { rows: [{ id: 'sheet_target', base_id: 'base_ops', name: 'Vendors', description: null }] }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/fields/fld_vendor_link/link-options')
      .expect(403)

    expect(response.body).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
    })
  })

  test('allows link options when source and target sheets are readable via sheet grants', async () => {
    const { app } = await createApp({
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, sheet_id, name, type, property FROM meta_fields WHERE id = $1')) {
          expect(params).toEqual(['fld_vendor_link'])
          return {
            rows: [{
              id: 'fld_vendor_link',
              sheet_id: 'sheet_source',
              name: 'Vendor',
              type: 'link',
              property: { foreignSheetId: 'sheet_target' },
            }],
          }
        }
        if (sql.includes('FROM spreadsheet_permissions')) {
          if (JSON.stringify(params) === JSON.stringify(['user_sheet_acl_1', ['sheet_source']])) {
            return { rows: [{ sheet_id: 'sheet_source', perm_code: 'spreadsheet:read', subject_type: 'user' }] }
          }
          if (JSON.stringify(params) === JSON.stringify(['user_sheet_acl_1', ['sheet_target']])) {
            return { rows: [{ sheet_id: 'sheet_target', perm_code: 'spreadsheet:write-own', subject_type: 'user' }] }
          }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_target'])
          return { rows: [{ id: 'sheet_target', base_id: 'base_ops', name: 'Vendors', description: null }] }
        }
        if (sql.includes('SELECT id, name, type FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC')) {
          expect(params).toEqual(['sheet_target'])
          return {
            rows: [{ id: 'fld_vendor_name', name: 'Vendor Name', type: 'string' }],
          }
        }
        if (sql.includes('SELECT id, data FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC')) {
          expect(params).toEqual(['sheet_target'])
          return {
            rows: [
              { id: 'vendor_1', data: { fld_vendor_name: 'Acme' } },
              { id: 'vendor_2', data: { fld_vendor_name: 'Globex' } },
            ],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/fields/fld_vendor_link/link-options')
      .expect(200)

    expect(response.body.data.targetSheet).toEqual({
      id: 'sheet_target',
      baseId: 'base_ops',
      name: 'Vendors',
      description: null,
    })
    expect(response.body.data.records).toEqual([
      { id: 'vendor_1', display: 'Acme' },
      { id: 'vendor_2', display: 'Globex' },
    ])
  })

  test('redacts lookup, rollup, and link summaries when foreign sheet permission has no read access', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, sheet_id, version, data, created_by FROM meta_records WHERE id = $1')) {
          expect(params).toEqual(['rec_order_1'])
          return {
            rows: [{
              id: 'rec_order_1',
              sheet_id: 'sheet_orders',
              version: 4,
              data: { fld_name: 'Order A' },
              created_by: 'user_sheet_acl_1',
            }],
          }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_orders'])
          return {
            rows: [{ id: 'sheet_orders', base_id: 'base_ops', name: 'Orders', description: null }],
          }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
          if (params?.[0] === 'sheet_orders') {
            return {
              rows: [
                { id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 1 },
                { id: 'fld_vendor_link', name: 'Vendor', type: 'link', property: { foreignSheetId: 'sheet_vendors' }, order: 2 },
                { id: 'fld_vendor_name_lookup', name: 'Vendor Name', type: 'lookup', property: { linkFieldId: 'fld_vendor_link', targetFieldId: 'fld_vendor_name' }, order: 3 },
                { id: 'fld_vendor_score_rollup', name: 'Vendor Score', type: 'rollup', property: { linkFieldId: 'fld_vendor_link', targetFieldId: 'fld_vendor_score', aggregation: 'max' }, order: 4 },
              ],
            }
          }
          if (params?.[0] === 'sheet_vendors') {
            throw new Error('foreign field lookup should not run when target sheet is unreadable')
          }
        }
        if (sql.includes('FROM meta_links') && sql.includes('record_id = ANY($2::text[])')) {
          expect(params).toEqual([['fld_vendor_link'], ['rec_order_1']])
          return { rows: [{ field_id: 'fld_vendor_link', record_id: 'rec_order_1', foreign_record_id: 'vendor_1' }] }
        }
        if (sql.includes('SELECT id, data FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])')) {
          if (params?.[0] === 'sheet_vendors') {
            throw new Error('foreign record lookup should not run when target sheet is unreadable')
          }
        }
        if (sql.includes('FROM spreadsheet_permissions')) {
          if (JSON.stringify(params) === JSON.stringify(['user_sheet_acl_1', ['sheet_orders']])) {
            return { rows: [{ sheet_id: 'sheet_orders', perm_code: 'spreadsheet:read' }] }
          }
          if (JSON.stringify(params) === JSON.stringify(['user_sheet_acl_1', ['sheet_vendors']])) {
            return { rows: [{ sheet_id: 'sheet_vendors', perm_code: 'spreadsheet:comment' }] }
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/records/rec_order_1')
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.record).toMatchObject({
      id: 'rec_order_1',
      version: 4,
      data: {
        fld_name: 'Order A',
        fld_vendor_link: ['vendor_1'],
        fld_vendor_name_lookup: [],
        fld_vendor_score_rollup: null,
      },
    })
    expect(response.body.data.linkSummaries).toEqual({
      fld_vendor_link: [],
    })
  })

  test('rejects lookup field creation when foreign sheet permission has no read access', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
          expect(params).toEqual(['sheet_source'])
          return { rows: [{ id: 'sheet_source' }] }
        }
        if (sql.includes('FROM spreadsheet_permissions')) {
          if (JSON.stringify(params) === JSON.stringify(['user_sheet_acl_1', ['sheet_source']])) {
            return { rows: [{ sheet_id: 'sheet_source', perm_code: 'spreadsheet:write' }] }
          }
          if (JSON.stringify(params) === JSON.stringify(['user_sheet_acl_1', ['sheet_target']])) {
            return { rows: [{ sheet_id: 'sheet_target', perm_code: 'spreadsheet:comment' }] }
          }
        }
        if (sql.includes('SELECT id, type, property FROM meta_fields WHERE sheet_id = $1 AND id = $2')) {
          expect(params).toEqual(['sheet_source', 'fld_vendor_link'])
          return {
            rows: [{
              id: 'fld_vendor_link',
              type: 'link',
              property: { foreignSheetId: 'sheet_target' },
            }],
          }
        }
        if (sql.includes('SELECT id FROM meta_fields WHERE sheet_id = $1 AND id = $2')) {
          expect(params).toEqual(['sheet_target', 'fld_vendor_name'])
          return { rows: [{ id: 'fld_vendor_name' }] }
        }
        if (sql.includes('INSERT INTO meta_fields')) {
          throw new Error('field insert should not run when foreign sheet is unreadable')
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .post('/api/multitable/fields')
      .send({
        sheetId: 'sheet_source',
        name: 'Vendor Name',
        type: 'lookup',
        property: { linkFieldId: 'fld_vendor_link', targetFieldId: 'fld_vendor_name' },
      })
      .expect(403)

    expect(response.body).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Insufficient permissions to read linked sheet: sheet_target' },
    })
  })

  test('filters sheet listings to directly granted readable sheets without requiring global multitable read', async () => {
    const { app } = await createApp({
      tokenPerms: [],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 200')) {
          return {
            rows: [
              { id: 'sheet_allowed', base_id: 'base_allowed', name: 'Visible Orders', description: 'Ops records' },
              { id: 'sheet_blocked', base_id: 'base_blocked', name: 'Hidden Payroll', description: 'Payroll records' },
              { id: 'sheet_people', base_id: 'base_system', name: 'People', description: '__metasheet_system:people__' },
            ],
          }
        }
        if (sql.includes('FROM spreadsheet_permissions') && sql.includes('sheet_id = ANY')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_allowed', 'sheet_blocked']])
          return {
            rows: [
              { sheet_id: 'sheet_allowed', perm_code: 'spreadsheet:read', subject_type: 'user' },
              { sheet_id: 'sheet_blocked', perm_code: 'spreadsheet:comment', subject_type: 'user' },
            ],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/sheets')
      .expect(200)

    expect(response.body.data.sheets).toEqual([
      {
        id: 'sheet_allowed',
        baseId: 'base_allowed',
        name: 'Visible Orders',
        description: 'Ops records',
      },
    ])
  })

  test('filters base listings to bases with at least one directly granted readable sheet', async () => {
    const { app } = await createApp({
      tokenPerms: [],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, name, icon, color, owner_id, workspace_id') && sql.includes('FROM meta_bases')) {
          return {
            rows: [
              { id: 'base_allowed', name: 'Visible Base', icon: 'table', color: '#1677ff', owner_id: 'owner_1', workspace_id: 'workspace_1' },
              { id: 'base_blocked', name: 'Hidden Base', icon: 'lock', color: '#f5222d', owner_id: 'owner_2', workspace_id: 'workspace_1' },
              { id: 'base_system', name: 'System Base', icon: 'users', color: '#722ed1', owner_id: 'owner_3', workspace_id: 'workspace_1' },
            ],
          }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 200')) {
          return {
            rows: [
              { id: 'sheet_allowed', base_id: 'base_allowed', name: 'Visible Orders', description: 'Ops records' },
              { id: 'sheet_blocked', base_id: 'base_blocked', name: 'Hidden Payroll', description: 'Payroll records' },
              { id: 'sheet_people', base_id: 'base_system', name: 'People', description: '__metasheet_system:people__' },
            ],
          }
        }
        if (sql.includes('FROM spreadsheet_permissions') && sql.includes('sheet_id = ANY')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_allowed', 'sheet_blocked']])
          return {
            rows: [
              { sheet_id: 'sheet_allowed', perm_code: 'spreadsheet:read', subject_type: 'user' },
              { sheet_id: 'sheet_blocked', perm_code: 'spreadsheet:comment', subject_type: 'user' },
            ],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/bases')
      .expect(200)

    expect(response.body.data.bases).toEqual([
      {
        id: 'base_allowed',
        name: 'Visible Base',
        icon: 'table',
        color: '#1677ff',
        ownerId: 'owner_1',
        workspaceId: 'workspace_1',
      },
    ])
  })
})
