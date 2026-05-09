import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { buildXlsxBuffer, type XlsxModule } from '../../src/multitable/xlsx-service'

type QueryResult = {
  rows: any[]
  rowCount?: number
}

type QueryHandler = (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>

const SHEET_ID = 'sheet_xlsx'
const FIELD_ROWS = [
  { id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 1 },
  { id: 'fld_amount', name: 'Amount', type: 'number', property: {}, order: 2 },
  { id: 'fld_hidden', name: 'Hidden', type: 'string', property: { hidden: true }, order: 3 },
]

const xlsx = await import('xlsx') as unknown as XlsxModule

function createMockPool(queryHandler: QueryHandler) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM spreadsheet_permissions')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM field_permissions')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM view_permissions')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM meta_view_permissions')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM record_permissions')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM formula_dependencies')) return { rows: [], rowCount: 0 }
    return queryHandler(sql, params)
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

async function createApp(args: {
  tokenPerms?: string[]
  queryHandler: QueryHandler
}) {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue([]),
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
      id: 'user_xlsx',
      roles: [],
      perms: args.tokenPerms ?? [],
      permissions: args.tokenPerms ?? [],
    }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return { app, mockPool }
}

function defaultQueryHandler(records: any[] = []): QueryHandler {
  return async (sql, params) => {
    if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
      expect(params).toEqual([SHEET_ID])
      return { rows: [{ id: SHEET_ID, base_id: 'base_xlsx', name: 'XLSX Sheet', description: null }] }
    }
    if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
      expect(params).toEqual([SHEET_ID])
      return { rows: [{ id: SHEET_ID }] }
    }
    if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
      expect(params).toEqual([SHEET_ID])
      return { rows: FIELD_ROWS }
    }
    if (sql.includes('SELECT id, name, type, property FROM meta_fields WHERE sheet_id = $1')) {
      expect(params).toEqual([SHEET_ID])
      return { rows: FIELD_ROWS }
    }
    if (
      sql.includes('FROM meta_records') &&
      sql.includes('SELECT id, sheet_id, version, data')
    ) {
      expect(params?.[0]).toBe(SHEET_ID)
      return { rows: records }
    }
    if (sql.includes('INSERT INTO meta_records')) {
      return { rows: [{ version: 1 }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }
}

describe('multitable xlsx routes', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  test('imports xlsx rows through the record create path', async () => {
    const buffer = buildXlsxBuffer(xlsx, {
      sheetName: 'Rows',
      headers: ['Name', 'Amount', 'Hidden'],
      rows: [['Alpha', 12, 'secret']],
    })
    const { app, mockPool } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write'],
      queryHandler: defaultQueryHandler(),
    })

    const response = await request(app)
      .post(`/api/multitable/sheets/${SHEET_ID}/import-xlsx`)
      .attach('file', buffer, 'rows.xlsx')
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.imported).toBe(1)
    expect(response.body.data.mapping).toEqual({ 0: 'fld_name', 1: 'fld_amount' })
    const insertCall = mockPool.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO meta_records'))
    expect(insertCall?.[1]?.[1]).toBe(SHEET_ID)
    expect(JSON.parse(String(insertCall?.[1]?.[2]))).toEqual({ fld_name: 'Alpha', fld_amount: '12' })
  })

  test('rejects invalid xlsx files before creating records', async () => {
    const { app, mockPool } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write'],
      queryHandler: defaultQueryHandler(),
    })

    const response = await request(app)
      .post(`/api/multitable/sheets/${SHEET_ID}/import-xlsx`)
      .attach('file', Buffer.from('not an xlsx'), 'rows.xlsx')
      .expect(400)

    expect(response.body.error).toEqual({ code: 'VALIDATION_ERROR', message: 'No XLSX columns map to importable fields' })
    expect(mockPool.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO meta_records'))).toBe(false)
  })

  test('denies xlsx import without create permission', async () => {
    const buffer = buildXlsxBuffer(xlsx, {
      headers: ['Name'],
      rows: [['Alpha']],
    })
    const { app } = await createApp({
      tokenPerms: ['multitable:read'],
      queryHandler: defaultQueryHandler(),
    })

    await request(app)
      .post(`/api/multitable/sheets/${SHEET_ID}/import-xlsx`)
      .attach('file', buffer, 'rows.xlsx')
      .expect(403)
  })

  test('exports readable visible fields as xlsx', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read'],
      queryHandler: defaultQueryHandler([
        { id: 'rec_1', sheet_id: SHEET_ID, version: 1, data: { fld_name: 'Alpha', fld_amount: 12, fld_hidden: 'secret' } },
      ]),
    })

    const response = await request(app)
      .get(`/api/multitable/sheets/${SHEET_ID}/export-xlsx`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        res.on('end', () => callback(null, Buffer.concat(chunks)))
      })
      .expect(200)

    expect(response.header['content-type']).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(response.header['content-disposition']).toContain('XLSX_Sheet.xlsx')
    const parsed = xlsx.read(response.body, { type: 'buffer' })
    const rows = xlsx.utils.sheet_to_json(parsed.Sheets[parsed.SheetNames[0]], { header: 1, raw: false, defval: '' })
    expect(rows).toEqual([
      ['Name', 'Amount'],
      ['Alpha', '12'],
    ])
  })
})
