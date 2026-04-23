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
  queryHandler: QueryHandler
  yjsInvalidator?: (recordIds: string[]) => Promise<void>
}) {
  vi.resetModules()
  const publishSpy = vi.fn()

  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue([]),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))
  vi.doMock('../../src/integration/events/event-bus', () => ({
    eventBus: { publish: publishSpy, emit: vi.fn() },
  }))

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const univerMetaModule = await import('../../src/routes/univer-meta')
  const mockPool = createMockPool(args.queryHandler)
  vi.spyOn(poolManager, 'get').mockReturnValue(mockPool as any)

  if (args.yjsInvalidator) {
    univerMetaModule.setYjsInvalidatorForRoutes(args.yjsInvalidator)
  } else {
    univerMetaModule.setYjsInvalidatorForRoutes(null)
  }

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = {
      id: 'user_patch_1',
      roles: args.tokenRoles ?? [],
      perms: args.tokenPerms ?? [],
    }
    next()
  })
  app.use('/api/multitable', univerMetaModule.univerMetaRouter())

  return { app, publishSpy, mockPool }
}

/**
 * Integration coverage for `PATCH /records/:recordId` after the M2 slice 3
 * extraction into `multitable/record-service.ts`.
 *
 * These tests are pure extraction regression guards: they lock the exact
 * SQL sequence, the response shape, and the side-effect ordering the
 * route contract has today.
 */
describe('Multitable PATCH /records/:recordId (record-service extraction)', () => {
  afterEach(async () => {
    // Clear the module-level yjs invalidator before other tests in the
    // process reset it too.
    const univerMetaModule = await import('../../src/routes/univer-meta')
    univerMetaModule.setYjsInvalidatorForRoutes(null)
    vi.restoreAllMocks()
    vi.resetModules()
  })

  test('patches a text field and returns the hydrated record payload', async () => {
    const yjsInvalidatorSpy = vi.fn(async (_: string[]) => {})
    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      yjsInvalidator: yjsInvalidatorSpy,
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM spreadsheet_permissions')) return { rows: [] }
        if (sql.includes('SELECT id, sheet_id FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
          expect(params).toEqual(['rec_1', 'sheet_ops'])
          return { rows: [{ id: 'rec_1', sheet_id: 'sheet_ops' }] }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
          return { rows: [{ id: 'fld_title', name: 'Title', type: 'string', property: {}, order: 1 }] }
        }
        if (sql.includes('SELECT id, version, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE')) {
          expect(params).toEqual(['rec_1', 'sheet_ops'])
          return {
            rows: [{ id: 'rec_1', version: 7, created_by: 'user_patch_1', data: { fld_title: 'Previous' } }],
          }
        }
        if (sql.includes('UPDATE meta_records') && sql.includes('RETURNING version')) {
          expect(params).toEqual([
            JSON.stringify({ fld_title: 'Updated title' }),
            'rec_1',
            'sheet_ops',
          ])
          return { rows: [{ version: 8 }] }
        }
        if (sql.includes('SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
          return { rows: [{ id: 'rec_1', version: 8, data: { fld_title: 'Updated title' } }] }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .patch('/api/multitable/records/rec_1')
      .send({
        sheetId: 'sheet_ops',
        expectedVersion: 7,
        data: { fld_title: 'Updated title' },
      })
      .expect(200)

    expect(response.body.data.record).toMatchObject({
      id: 'rec_1',
      version: 8,
      data: { fld_title: 'Updated title' },
    })
    expect(response.body.data.commentsScope).toMatchObject({
      targetType: 'meta_record',
      targetId: 'rec_1',
      sheetId: 'sheet_ops',
      recordId: 'rec_1',
    })
    expect(yjsInvalidatorSpy).toHaveBeenCalledWith(['rec_1'])
  })

  test('returns 400 with aggregated fieldErrors when multiple fields fail validation', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, _params) => {
        if (sql.includes('FROM spreadsheet_permissions')) return { rows: [] }
        if (sql.includes('SELECT id, sheet_id FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
          return { rows: [{ id: 'rec_1', sheet_id: 'sheet_ops' }] }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
          return {
            rows: [
              { id: 'fld_tag', name: 'Tag', type: 'select', property: { options: [{ value: 'a' }, { value: 'b' }] }, order: 1 },
            ],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .patch('/api/multitable/records/rec_1')
      .send({
        sheetId: 'sheet_ops',
        data: { fld_tag: 'not-allowed', fld_missing: 'x' },
      })
      .expect(400)

    expect(response.body.error.code).toBe('VALIDATION_ERROR')
    expect(response.body.error.fieldErrors).toEqual({
      fld_tag: 'Invalid select option',
      fld_missing: 'Unknown field',
    })
  })

  test('returns 403 FIELD_READONLY when all field errors are "Field is readonly"', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, _params) => {
        if (sql.includes('FROM spreadsheet_permissions')) return { rows: [] }
        if (sql.includes('SELECT id, sheet_id FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
          return { rows: [{ id: 'rec_1', sheet_id: 'sheet_ops' }] }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
          return {
            rows: [
              { id: 'fld_lookup', name: 'Lookup', type: 'lookup', property: {}, order: 1 },
            ],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .patch('/api/multitable/records/rec_1')
      .send({
        sheetId: 'sheet_ops',
        data: { fld_lookup: 'ignored' },
      })
      .expect(403)

    expect(response.body.error.code).toBe('FIELD_READONLY')
    expect(response.body.error.message).toBe('Readonly field update rejected')
    expect(response.body.error.fieldErrors).toEqual({ fld_lookup: 'Field is readonly' })
  })

  test('returns 409 VERSION_CONFLICT when expectedVersion disagrees with row', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, _params) => {
        if (sql.includes('FROM spreadsheet_permissions')) return { rows: [] }
        if (sql.includes('SELECT id, sheet_id FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
          return { rows: [{ id: 'rec_1', sheet_id: 'sheet_ops' }] }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
          return { rows: [{ id: 'fld_title', name: 'Title', type: 'string', property: {}, order: 1 }] }
        }
        if (sql.includes('SELECT id, version, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE')) {
          return { rows: [{ id: 'rec_1', version: 11, created_by: 'user_patch_1', data: {} }] }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .patch('/api/multitable/records/rec_1')
      .send({
        sheetId: 'sheet_ops',
        expectedVersion: 2,
        data: { fld_title: 'stale' },
      })
      .expect(409)

    expect(response.body.error.code).toBe('VERSION_CONFLICT')
    expect(response.body.error.serverVersion).toBe(11)
  })

  test('updates link targets: diff-inserts new links and removes dropped ones', async () => {
    const yjsInvalidatorSpy = vi.fn(async (_: string[]) => {})
    const captured: Array<{ sql: string; params?: unknown[] }> = []
    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      yjsInvalidator: yjsInvalidatorSpy,
      queryHandler: async (sql, params) => {
        captured.push({ sql, ...(params !== undefined ? { params } : {}) })
        if (sql.includes('FROM spreadsheet_permissions')) return { rows: [] }
        if (sql.includes('SELECT id, sheet_id FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
          return { rows: [{ id: 'rec_1', sheet_id: 'sheet_ops' }] }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
          return {
            rows: [
              {
                id: 'fld_customer',
                name: 'Customer',
                type: 'link',
                property: { foreignSheetId: 'sheet_customer' },
                order: 1,
              },
            ],
          }
        }
        if (sql.includes('SELECT id FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])')) {
          expect(params).toEqual(['sheet_customer', ['rec_c2', 'rec_c3']])
          return { rows: [{ id: 'rec_c2' }, { id: 'rec_c3' }] }
        }
        if (sql.includes('SELECT id, version, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE')) {
          return {
            rows: [{ id: 'rec_1', version: 2, created_by: 'user_patch_1', data: { fld_customer: ['rec_c1', 'rec_c2'] } }],
          }
        }
        if (sql.includes('UPDATE meta_records') && sql.includes('RETURNING version')) {
          expect(params).toEqual([
            JSON.stringify({ fld_customer: ['rec_c2', 'rec_c3'] }),
            'rec_1',
            'sheet_ops',
          ])
          return { rows: [{ version: 3 }] }
        }
        if (sql.includes('SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2')) {
          return { rows: [{ foreign_record_id: 'rec_c1' }, { foreign_record_id: 'rec_c2' }] }
        }
        if (sql.includes('DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2 AND foreign_record_id = ANY($3::text[])')) {
          expect(params).toEqual(['fld_customer', 'rec_1', ['rec_c1']])
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('INSERT INTO meta_links')) {
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
          return { rows: [{ id: 'rec_1', version: 3, data: { fld_customer: ['rec_c2', 'rec_c3'] } }] }
        }
        if (sql.includes('SELECT field_id, record_id, foreign_record_id')) {
          // Response hydration fetches current link values for the record
          return { rows: [
            { field_id: 'fld_customer', record_id: 'rec_1', foreign_record_id: 'rec_c2' },
            { field_id: 'fld_customer', record_id: 'rec_1', foreign_record_id: 'rec_c3' },
          ] }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .patch('/api/multitable/records/rec_1')
      .send({
        sheetId: 'sheet_ops',
        data: { fld_customer: ['rec_c2', 'rec_c3'] },
      })
      .expect(200)

    expect(response.body.data.record.data.fld_customer).toEqual(['rec_c2', 'rec_c3'])
    // Assert the tx ran: UPDATE before DELETE-links before INSERT-links.
    const updateIdx = captured.findIndex(({ sql }) => sql.includes('UPDATE meta_records') && sql.includes('RETURNING version'))
    const deleteLinksIdx = captured.findIndex(({ sql }) => sql.includes('DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2 AND foreign_record_id = ANY'))
    const insertLinksIdx = captured.findIndex(({ sql }) => sql.includes('INSERT INTO meta_links'))
    expect(updateIdx).toBeGreaterThanOrEqual(0)
    expect(deleteLinksIdx).toBeGreaterThan(updateIdx)
    expect(insertLinksIdx).toBeGreaterThan(updateIdx)
    // Yjs invalidation happens AFTER the tx commits. Spy was called once.
    expect(yjsInvalidatorSpy).toHaveBeenCalledTimes(1)
    expect(yjsInvalidatorSpy).toHaveBeenCalledWith(['rec_1'])
  })

  test('preserves best-effort Yjs invalidation: PATCH returns 200 even when the invalidator throws', async () => {
    // The yjs invalidator failure is best-effort: the PATCH still returns 200
    // and the response body is identical to the happy path.
    const invalidatorError = new Error('purge blew up')
    const yjsInvalidatorSpy = vi.fn(async (_: string[]) => {
      throw invalidatorError
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      yjsInvalidator: yjsInvalidatorSpy,
      queryHandler: async (sql, _params) => {
        if (sql.includes('FROM spreadsheet_permissions')) return { rows: [] }
        if (sql.includes('SELECT id, sheet_id FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
          return { rows: [{ id: 'rec_1', sheet_id: 'sheet_ops' }] }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
          return {
            rows: [
              { id: 'fld_files', name: 'Files', type: 'attachment', property: {}, order: 1 },
            ],
          }
        }
        if (sql.includes('FROM multitable_attachments') && sql.includes('id = ANY')) {
          return { rows: [{ id: 'att_new_1', field_id: 'fld_files' }] }
        }
        if (sql.includes('SELECT id, version, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE')) {
          return {
            rows: [{
              id: 'rec_1',
              version: 2,
              created_by: 'user_patch_1',
              data: { fld_files: ['att_old_1', 'att_old_2'] },
            }],
          }
        }
        if (sql.includes('UPDATE meta_records') && sql.includes('RETURNING version')) {
          return { rows: [{ version: 3 }] }
        }
        if (sql.includes('SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
          return { rows: [{ id: 'rec_1', version: 3, data: { fld_files: ['att_new_1'] } }] }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .patch('/api/multitable/records/rec_1')
      .send({
        sheetId: 'sheet_ops',
        data: { fld_files: ['att_new_1'] },
      })
      .expect(200)

    expect(response.body.data.record.data.fld_files).toEqual(['att_new_1'])
    expect(yjsInvalidatorSpy).toHaveBeenCalledWith(['rec_1'])
    // The warning log for invalidator failure must have fired so the
    // operator can find the stale-snapshot lag.
    const hadWarning = errorSpy.mock.calls.some((call) => {
      const msg = call[0]
      return typeof msg === 'string' && msg.includes('Yjs invalidation failed')
    })
    expect(hadWarning).toBe(true)
    errorSpy.mockRestore()
  })
})
