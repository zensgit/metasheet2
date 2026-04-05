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
    eventBus: { publish: publishSpy },
  }))

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const mockPool = createMockPool(args.queryHandler)
  vi.spyOn(poolManager, 'get').mockReturnValue(mockPool as any)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = {
      id: 'user_realtime_1',
      roles: args.tokenRoles ?? [],
      perms: args.tokenPerms ?? [],
    }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())

  return { app, publishSpy }
}

describe('Multitable sheet realtime events', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  test('publishes spreadsheet.cell.updated after creating a record', async () => {
    const { app, publishSpy } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops' }] }
        }
        if (sql.includes('SELECT id, type, property FROM meta_fields WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'fld_title', type: 'string', property: {} }] }
        }
        if (sql.includes('INSERT INTO meta_records') && sql.includes('RETURNING version')) {
          expect(params).toEqual([expect.stringMatching(/^rec_/), 'sheet_ops', JSON.stringify({ fld_title: 'Alpha' })])
          return { rows: [{ version: 1 }] }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .post('/api/multitable/records')
      .send({
        sheetId: 'sheet_ops',
        data: { fld_title: 'Alpha' },
      })
      .expect(200)

    expect(response.body.data.record).toMatchObject({
      version: 1,
      data: { fld_title: 'Alpha' },
    })
    expect(publishSpy).toHaveBeenCalledWith('spreadsheet.cell.updated', expect.objectContaining({
      spreadsheetId: 'sheet_ops',
      actorId: 'user_realtime_1',
      source: 'multitable',
      kind: 'record-created',
      recordId: response.body.data.record.id,
      recordIds: [response.body.data.record.id],
      fieldIds: ['fld_title'],
      recordPatches: [{
        recordId: response.body.data.record.id,
        version: 1,
        patch: { fld_title: 'Alpha' },
      }],
    }))
  })

  test('publishes spreadsheet.cell.updated after form submit updates a record', async () => {
    const { app, publishSpy } = await createApp({
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
              hidden_field_ids: [],
              config: {},
            }],
          }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'fld_title', name: 'Title', type: 'string', property: {}, order: 1 }] }
        }
        if (sql.includes('SELECT id, version FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE')) {
          expect(params).toEqual(['rec_1', 'sheet_ops'])
          return { rows: [{ id: 'rec_1', version: 4 }] }
        }
        if (sql.includes('UPDATE meta_records') && sql.includes('RETURNING version')) {
          expect(params).toEqual([JSON.stringify({ fld_title: 'Updated title' }), 'rec_1', 'sheet_ops'])
          return { rows: [{ version: 5 }] }
        }
        if (sql.includes('SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
          expect(params).toEqual(['rec_1', 'sheet_ops'])
          return { rows: [{ id: 'rec_1', version: 5, data: { fld_title: 'Updated title' } }] }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .post('/api/multitable/views/view_form_ops/submit')
      .send({
        recordId: 'rec_1',
        expectedVersion: 4,
        data: { fld_title: 'Updated title' },
      })
      .expect(200)

    expect(response.body.data.mode).toBe('update')
    expect(publishSpy).toHaveBeenCalledWith('spreadsheet.cell.updated', {
      spreadsheetId: 'sheet_ops',
      actorId: 'user_realtime_1',
      source: 'multitable',
      kind: 'record-updated',
      recordId: 'rec_1',
      recordIds: ['rec_1'],
      fieldIds: ['fld_title'],
      recordPatches: [{
        recordId: 'rec_1',
        version: 5,
        patch: { fld_title: 'Updated title' },
      }],
    })
  })

  test('publishes aggregate update events for bulk patch', async () => {
    const { app, publishSpy } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops' }] }
        }
        if (sql.includes('SELECT id, name, type, property FROM meta_fields WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'fld_title', name: 'Title', type: 'string', property: {} }] }
        }
        if (sql.includes('SELECT id, version FROM meta_records WHERE sheet_id = $1 AND id = $2 FOR UPDATE')) {
          expect(params).toEqual(['sheet_ops', 'rec_1'])
          return { rows: [{ id: 'rec_1', version: 2 }] }
        }
        if (sql.includes('UPDATE meta_records') && sql.includes('WHERE sheet_id = $2 AND id = $3')) {
          expect(params).toEqual([JSON.stringify({ fld_title: 'Bulk patched' }), 'sheet_ops', 'rec_1'])
          return { rows: [{ version: 3 }] }
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
        sheetId: 'sheet_ops',
        changes: [{ recordId: 'rec_1', fieldId: 'fld_title', value: 'Bulk patched', expectedVersion: 2 }],
      })
      .expect(200)

    expect(response.body.data.updated).toEqual([{ recordId: 'rec_1', version: 3 }])
    expect(publishSpy).toHaveBeenCalledWith('spreadsheet.cell.updated', {
      spreadsheetId: 'sheet_ops',
      actorId: 'user_realtime_1',
      source: 'multitable',
      kind: 'record-updated',
      recordIds: ['rec_1'],
      fieldIds: ['fld_title'],
      recordPatches: [{
        recordId: 'rec_1',
        version: 3,
        patch: { fld_title: 'Bulk patched' },
      }],
    })
  })
})
