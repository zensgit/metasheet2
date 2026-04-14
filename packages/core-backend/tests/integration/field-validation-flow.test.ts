import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, test, vi } from 'vitest'

type QueryResult = {
  rows: any[]
  rowCount?: number
}

type QueryHandler = (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>

function createMockPool(queryHandler: QueryHandler) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM spreadsheet_permissions')) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('FROM field_permissions')) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('FROM view_permissions')) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('FROM meta_view_permissions')) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('FROM record_permissions')) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('FROM formula_dependencies')) {
      return { rows: [], rowCount: 0 }
    }
    return queryHandler(sql, params)
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

async function createApp(args: {
  tokenPerms?: string[]
  tokenRoles?: string[]
  queryHandler?: QueryHandler
  fallbackPermissions?: string[]
  user?: { id?: string; roles?: string[]; perms?: string[] } | null
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
  if (args.user !== null) {
    app.use((req, _res, next) => {
      req.user = {
        id: args.user?.id ?? 'user_val_1',
        roles: args.user?.roles ?? args.tokenRoles ?? [],
        perms: args.user?.perms ?? args.tokenPerms ?? [],
      }
      next()
    })
  }
  app.use('/api/multitable', univerMetaRouter())

  return { app, mockPool }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VIEW_ID = 'view_form_1'
const SHEET_ID = 'sheet_1'

function defaultQueryHandler(fieldRows: any[]): QueryHandler {
  return async (sql, params) => {
    // view resolution
    if (sql.includes('FROM meta_views WHERE id = $1')) {
      return {
        rows: [{
          id: VIEW_ID,
          sheet_id: SHEET_ID,
          name: 'Test Form',
          type: 'form',
          filter_info: {},
          sort_info: {},
          group_info: {},
          hidden_field_ids: [],
          config: {},
        }],
      }
    }
    // sheet lookup
    if (sql.includes('FROM meta_sheets WHERE id = $1')) {
      return { rows: [{ id: SHEET_ID, base_id: 'base_1', name: 'Test', description: null }] }
    }
    // fields
    if (sql.includes('FROM meta_fields WHERE sheet_id = $1')) {
      return { rows: fieldRows }
    }
    // record insert RETURNING
    if (sql.includes('INSERT INTO meta_records')) {
      return { rows: [{ id: params?.[0] ?? 'rec_new', version: 1 }] }
    }
    // record select after insert
    if (sql.includes('SELECT id, version, data FROM meta_records WHERE id = $1')) {
      return { rows: [{ id: 'rec_new', version: 1, data: {} }] }
    }
    return { rows: [], rowCount: 0 }
  }
}

// ---------------------------------------------------------------------------
// Tests — form submit validation (/views/:viewId/submit)
// ---------------------------------------------------------------------------

describe('Field validation — form submit', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  test('submit with required field missing returns 422', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write'],
      queryHandler: defaultQueryHandler([
        { id: 'fld_name', name: 'Name', type: 'string', property: { validation: [{ type: 'required' }] }, order: 1 },
      ]),
    })

    const res = await request(app)
      .post(`/api/multitable/views/${VIEW_ID}/submit`)
      .send({ data: {} })

    expect(res.status).toBe(422)
    expect(res.body.error).toBe('VALIDATION_FAILED')
    expect(res.body.fieldErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fieldId: 'fld_name', rule: 'required' }),
      ]),
    )
  })

  test('submit with value below min returns 422', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write'],
      queryHandler: defaultQueryHandler([
        { id: 'fld_age', name: 'Age', type: 'number', property: { validation: [{ type: 'min', params: { value: 0 } }] }, order: 1 },
      ]),
    })

    const res = await request(app)
      .post(`/api/multitable/views/${VIEW_ID}/submit`)
      .send({ data: { fld_age: -5 } })

    expect(res.status).toBe(422)
    expect(res.body.fieldErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fieldId: 'fld_age', rule: 'min' }),
      ]),
    )
  })

  test('submit with string exceeding maxLength returns 422', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write'],
      queryHandler: defaultQueryHandler([
        { id: 'fld_bio', name: 'Bio', type: 'string', property: { validation: [{ type: 'maxLength', params: { value: 10 } }] }, order: 1 },
      ]),
    })

    const res = await request(app)
      .post(`/api/multitable/views/${VIEW_ID}/submit`)
      .send({ data: { fld_bio: 'This string is way too long for the limit' } })

    expect(res.status).toBe(422)
    expect(res.body.fieldErrors[0].rule).toBe('maxLength')
  })

  test('submit with valid data succeeds', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write'],
      queryHandler: defaultQueryHandler([
        { id: 'fld_name', name: 'Name', type: 'string', property: { validation: [{ type: 'required' }] }, order: 1 },
        { id: 'fld_age', name: 'Age', type: 'number', property: { validation: [{ type: 'min', params: { value: 0 } }] }, order: 2 },
      ]),
    })

    const res = await request(app)
      .post(`/api/multitable/views/${VIEW_ID}/submit`)
      .send({ data: { fld_name: 'Alice', fld_age: 25 } })

    expect(res.status).toBe(200)
  })

  test('multiple validation errors returned at once', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write'],
      queryHandler: defaultQueryHandler([
        { id: 'fld_name', name: 'Name', type: 'string', property: { validation: [{ type: 'required' }] }, order: 1 },
        { id: 'fld_email', name: 'Email', type: 'string', property: { validation: [{ type: 'required' }, { type: 'pattern', params: { regex: '^[^@]+@[^@]+\\.[^@]+$' } }] }, order: 2 },
        { id: 'fld_score', name: 'Score', type: 'number', property: { validation: [{ type: 'min', params: { value: 0 } }, { type: 'max', params: { value: 100 } }] }, order: 3 },
      ]),
    })

    const res = await request(app)
      .post(`/api/multitable/views/${VIEW_ID}/submit`)
      .send({ data: { fld_name: '', fld_email: '', fld_score: 200 } })

    expect(res.status).toBe(422)
    // fld_name: required, fld_email: required, fld_score: max
    expect(res.body.fieldErrors.length).toBeGreaterThanOrEqual(3)
  })

  test('public form submission respects validation rules', async () => {
    const publicToken = 'tok_public_123'
    const { app } = await createApp({
      user: null,
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM meta_views WHERE id = $1')) {
          return {
            rows: [{
              id: VIEW_ID,
              sheet_id: SHEET_ID,
              name: 'Public Form',
              type: 'form',
              filter_info: {},
              sort_info: {},
              group_info: {},
              hidden_field_ids: [],
              config: { publicForm: { enabled: true, publicToken } },
            }],
          }
        }
        if (sql.includes('FROM meta_sheets WHERE id = $1')) {
          return { rows: [{ id: SHEET_ID, base_id: 'base_1', name: 'Test', description: null }] }
        }
        if (sql.includes('FROM meta_fields WHERE sheet_id = $1')) {
          return {
            rows: [
              { id: 'fld_name', name: 'Name', type: 'string', property: { validation: [{ type: 'required' }] }, order: 1 },
            ],
          }
        }
        return { rows: [], rowCount: 0 }
      },
    })

    const res = await request(app)
      .post(`/api/multitable/views/${VIEW_ID}/submit?publicToken=${publicToken}`)
      .send({ data: {} })

    expect(res.status).toBe(422)
    expect(res.body.error).toBe('VALIDATION_FAILED')
    expect(res.body.fieldErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fieldId: 'fld_name', rule: 'required' }),
      ]),
    )
  })

  test('pattern validation on form submit', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write'],
      queryHandler: defaultQueryHandler([
        { id: 'fld_email', name: 'Email', type: 'string', property: { validation: [{ type: 'pattern', params: { regex: '^[^@]+@[^@]+\\.[^@]+$' }, message: 'Must be a valid email' }] }, order: 1 },
      ]),
    })

    const res = await request(app)
      .post(`/api/multitable/views/${VIEW_ID}/submit`)
      .send({ data: { fld_email: 'not-an-email' } })

    expect(res.status).toBe(422)
    expect(res.body.fieldErrors[0]).toMatchObject({
      fieldId: 'fld_email',
      rule: 'pattern',
      message: 'Must be a valid email',
    })
  })

  test('enum validation rejects unlisted value', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write'],
      queryHandler: defaultQueryHandler([
        { id: 'fld_color', name: 'Color', type: 'select', property: { options: [{ value: 'red' }, { value: 'blue' }], validation: [{ type: 'enum', params: { values: ['red', 'blue'] } }] }, order: 1 },
      ]),
    })

    const res = await request(app)
      .post(`/api/multitable/views/${VIEW_ID}/submit`)
      .send({ data: { fld_color: 'green' } })

    // The existing select validation in the handler might catch this first (400),
    // or the field-validation engine catches it (422). Either way, it should not succeed.
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  test('default text maxLength validation enforced', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write'],
      queryHandler: defaultQueryHandler([
        { id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 1 },
      ]),
    })

    // Default maxLength for text is 10000
    const res = await request(app)
      .post(`/api/multitable/views/${VIEW_ID}/submit`)
      .send({ data: { fld_name: 'x'.repeat(10001) } })

    expect(res.status).toBe(422)
    expect(res.body.fieldErrors[0].rule).toBe('maxLength')
  })

  test('null values skip non-required validation rules on submit', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write'],
      queryHandler: defaultQueryHandler([
        { id: 'fld_score', name: 'Score', type: 'number', property: { validation: [{ type: 'min', params: { value: 0 } }] }, order: 1 },
        { id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 2 },
      ]),
    })

    // fld_score is not required, so omitting it (not present in data) should be OK
    const res = await request(app)
      .post(`/api/multitable/views/${VIEW_ID}/submit`)
      .send({ data: { fld_name: 'Alice' } })

    expect(res.status).toBe(200)
  })

  test('update record with validation validates changed fields', async () => {
    const recordId = 'rec_existing'
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM meta_views WHERE id = $1')) {
          return {
            rows: [{
              id: VIEW_ID,
              sheet_id: SHEET_ID,
              name: 'Test Form',
              type: 'form',
              filter_info: {},
              sort_info: {},
              group_info: {},
              hidden_field_ids: [],
              config: {},
            }],
          }
        }
        if (sql.includes('FROM meta_sheets WHERE id = $1')) {
          return { rows: [{ id: SHEET_ID, base_id: 'base_1', name: 'Test', description: null }] }
        }
        if (sql.includes('FROM meta_fields WHERE sheet_id = $1')) {
          return {
            rows: [
              { id: 'fld_name', name: 'Name', type: 'string', property: { validation: [{ type: 'required' }, { type: 'minLength', params: { value: 2 } }] }, order: 1 },
            ],
          }
        }
        if (sql.includes('FROM meta_records WHERE id = $1') && sql.includes('FOR UPDATE')) {
          return { rows: [{ id: recordId, version: 1, created_by: 'user_val_1' }] }
        }
        if (sql.includes('UPDATE meta_records')) {
          return { rows: [{ version: 2 }] }
        }
        if (sql.includes('SELECT id, version, data FROM meta_records WHERE id = $1')) {
          return { rows: [{ id: recordId, version: 2, data: { fld_name: 'AB' } }] }
        }
        return { rows: [], rowCount: 0 }
      },
    })

    // submit with too-short name should fail
    const resFail = await request(app)
      .post(`/api/multitable/views/${VIEW_ID}/submit`)
      .send({ recordId, data: { fld_name: 'A' } })

    expect(resFail.status).toBe(422)
    expect(resFail.body.fieldErrors[0].rule).toBe('minLength')

    // submit with valid name should pass
    const resOk = await request(app)
      .post(`/api/multitable/views/${VIEW_ID}/submit`)
      .send({ recordId, data: { fld_name: 'Alice' } })

    expect(resOk.status).toBe(200)
  })

  test('custom error message propagated in response', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write'],
      queryHandler: defaultQueryHandler([
        { id: 'fld_name', name: 'Name', type: 'string', property: { validation: [{ type: 'required', message: 'Name cannot be blank' }] }, order: 1 },
      ]),
    })

    const res = await request(app)
      .post(`/api/multitable/views/${VIEW_ID}/submit`)
      .send({ data: {} })

    expect(res.status).toBe(422)
    expect(res.body.fieldErrors[0].message).toBe('Name cannot be blank')
  })

  test('combined range rules both checked', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write'],
      queryHandler: defaultQueryHandler([
        {
          id: 'fld_pct',
          name: 'Percentage',
          type: 'number',
          property: {
            validation: [
              { type: 'min', params: { value: 0 } },
              { type: 'max', params: { value: 100 } },
            ],
          },
          order: 1,
        },
      ]),
    })

    const resTooHigh = await request(app)
      .post(`/api/multitable/views/${VIEW_ID}/submit`)
      .send({ data: { fld_pct: 150 } })
    expect(resTooHigh.status).toBe(422)
    expect(resTooHigh.body.fieldErrors[0].rule).toBe('max')

    const resTooLow = await request(app)
      .post(`/api/multitable/views/${VIEW_ID}/submit`)
      .send({ data: { fld_pct: -1 } })
    expect(resTooLow.status).toBe(422)
    expect(resTooLow.body.fieldErrors[0].rule).toBe('min')
  })
})
