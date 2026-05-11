import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, test, vi } from 'vitest'

type QueryResult = {
  rows: any[]
  rowCount?: number
}

type QueryHandler = (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>

const patchRecordsMock = vi.fn()
const setPostCommitHooksMock = vi.fn()

function createMockPool(queryHandler: QueryHandler) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM spreadsheet_permissions')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM field_permissions')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM view_permissions')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM meta_view_permissions')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM record_permissions')) return { rows: [], rowCount: 0 }
    return queryHandler(sql, params)
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

async function createApp(args: {
  queryHandler?: QueryHandler
}) {
  vi.resetModules()

  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue([]),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))
  vi.doMock('../../src/multitable/record-write-service', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/multitable/record-write-service')>()
    return {
      ...actual,
      RecordWriteService: vi.fn().mockImplementation(() => ({
        patchRecords: patchRecordsMock,
        setPostCommitHooks: setPostCommitHooksMock,
      })),
    }
  })

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter, setYjsInvalidatorForRoutes } = await import('../../src/routes/univer-meta')
  setYjsInvalidatorForRoutes(null)
  const mockPool = createMockPool(args.queryHandler ?? (() => ({ rows: [], rowCount: 0 })))
  vi.spyOn(poolManager, 'get').mockReturnValue(mockPool as any)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = {
      id: 'user_partial_patch',
      roles: [],
      perms: ['multitable:write'],
    }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return { app, mockPool }
}

describe('Multitable POST /patch partialSuccess', () => {
  afterEach(async () => {
    const univerMetaModule = await import('../../src/routes/univer-meta')
    univerMetaModule.setYjsInvalidatorForRoutes(null)
    patchRecordsMock.mockReset()
    setPostCommitHooksMock.mockReset()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  test('keeps successful record patches and reports per-row version conflicts', async () => {
    const { app } = await createApp({
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_partial'])
          return { rows: [{ id: 'fld_title', name: 'Title', type: 'string', property: {}, order: 1 }] }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })
    const { VersionConflictError } = await import('../../src/multitable/record-write-service')
    patchRecordsMock.mockImplementation(async (input: { changesByRecord: Map<string, unknown> }) => {
      const recordId = [...input.changesByRecord.keys()][0]
      if (recordId === 'rec_stale') throw new VersionConflictError(recordId, 9)
      return {
        updated: [{ recordId, version: 4 }],
        records: [{ recordId, data: { fld_title: 'Bulk value' } }],
      }
    })

    const response = await request(app)
      .post('/api/multitable/patch')
      .send({
        sheetId: 'sheet_partial',
        partialSuccess: true,
        changes: [
          { recordId: 'rec_ok', fieldId: 'fld_title', value: 'Bulk value', expectedVersion: 3 },
          { recordId: 'rec_stale', fieldId: 'fld_title', value: 'Bulk value', expectedVersion: 3 },
        ],
      })
      .expect(200)

    expect(response.body).toMatchObject({
      ok: true,
      data: {
        updated: [{ recordId: 'rec_ok', version: 4 }],
        records: [{ recordId: 'rec_ok', data: { fld_title: 'Bulk value' } }],
        failed: [{
          recordId: 'rec_stale',
          code: 'VERSION_CONFLICT',
          message: 'Version conflict for rec_stale',
          serverVersion: 9,
        }],
      },
    })
    expect(patchRecordsMock).toHaveBeenCalledTimes(2)
    expect([...patchRecordsMock.mock.calls[0][0].changesByRecord.keys()]).toEqual(['rec_ok'])
    expect([...patchRecordsMock.mock.calls[1][0].changesByRecord.keys()]).toEqual(['rec_stale'])
  })

  test('preserves all-or-nothing mode when partialSuccess is not requested', async () => {
    patchRecordsMock.mockResolvedValue({
      updated: [
        { recordId: 'rec_1', version: 4 },
        { recordId: 'rec_2', version: 4 },
      ],
    })

    const { app } = await createApp({
      queryHandler: async (sql) => {
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
          return { rows: [{ id: 'fld_title', name: 'Title', type: 'string', property: {}, order: 1 }] }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .post('/api/multitable/patch')
      .send({
        sheetId: 'sheet_partial',
        changes: [
          { recordId: 'rec_1', fieldId: 'fld_title', value: 'Bulk value', expectedVersion: 3 },
          { recordId: 'rec_2', fieldId: 'fld_title', value: 'Bulk value', expectedVersion: 3 },
        ],
      })
      .expect(200)

    expect(response.body.data.failed).toBeUndefined()
    expect(response.body.data.updated).toEqual([
      { recordId: 'rec_1', version: 4 },
      { recordId: 'rec_2', version: 4 },
    ])
    expect(patchRecordsMock).toHaveBeenCalledTimes(1)
    expect([...patchRecordsMock.mock.calls[0][0].changesByRecord.keys()]).toEqual(['rec_1', 'rec_2'])
  })
})
