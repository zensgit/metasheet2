import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { buildXlsxBuffer, type XlsxModule } from '../../src/multitable/xlsx-service'
import { answerSheetLiveness, isSheetLivenessQuery } from './sheet-liveness-mock'

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
    // SHEET LIVENESS (soft delete) — see ./sheet-liveness-mock.ts. Translated, not enumerated, so
    // this fixture keeps its own notion of which sheets exist.
    if (isSheetLivenessQuery(sql)) return answerSheetLiveness(queryHandler, params)
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

function defaultQueryHandler(records: any[] = [], fieldRows: any[] = FIELD_ROWS): QueryHandler {
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
      return { rows: fieldRows }
    }
    if (sql.includes('SELECT id, name, type, property FROM meta_fields WHERE sheet_id = $1')) {
      expect(params).toEqual([SHEET_ID])
      return { rows: fieldRows }
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

  // 客户反馈 2026-09-24 #4c (PR #6083 review B1/S1): a dateTime column exports as the business-zone wall clock
  // the grid shows (`YYYY-MM-DD HH:mm`, Asia/Shanghai by default) — not the raw stored `…T01:00:00.000Z` — and
  // that exact text imports back to the same instant. createdTime/modifiedTime use the same format.
  test('dateTime exports as YYYY-MM-DD HH:mm in the business zone (xlsx AND csv) and re-imports to the same instant', async () => {
    const fieldRows = [
      { id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 1 },
      { id: 'fld_when', name: 'When', type: 'dateTime', property: { timezone: 'UTC' }, order: 2 },
      { id: 'fld_tokyo', name: 'Tokyo', type: 'dateTime', property: { timezone: 'Asia/Tokyo' }, order: 3 },
      { id: 'fld_created', name: 'Created', type: 'createdTime', property: {}, order: 4 },
    ]
    const stored = '2026-09-24T01:00:00.000Z' // 09:00 Beijing, 10:00 Tokyo
    // createdTime is record METADATA: query-service `mapRecordRow` → `injectSystemFieldValues` fills it from
    // the row's `created_at`, never from `data` (a `data.fld_created` key would be overwritten).
    const records = [
      { id: 'rec_1', sheet_id: SHEET_ID, version: 1, created_at: new Date('2026-09-24T13:05:00.000Z'), data: { fld_name: 'Alpha', fld_when: stored, fld_tokyo: stored } },
      { id: 'rec_2', sheet_id: SHEET_ID, version: 1, created_at: null, data: { fld_name: 'Junk', fld_when: 'not a date', fld_tokyo: null } },
    ]
    const parseBody = (res: any, callback: any) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: any) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => callback(null, Buffer.concat(chunks)))
    }

    const exporter = await createApp({ tokenPerms: ['multitable:read'], queryHandler: defaultQueryHandler(records, fieldRows) })
    const xlsxResponse = await request(exporter.app)
      .get(`/api/multitable/sheets/${SHEET_ID}/export-xlsx`)
      .buffer(true)
      .parse(parseBody)
      .expect(200)
    const parsed = xlsx.read(xlsxResponse.body, { type: 'buffer' })
    const rows = xlsx.utils.sheet_to_json(parsed.Sheets[parsed.SheetNames[0]], { header: 1, raw: false, defval: '' })
    expect(rows).toEqual([
      ['Name', 'When', 'Tokyo', 'Created'],
      ['Alpha', '2026-09-24 09:00', '2026-09-24 10:00', '2026-09-24 21:05'], // createdTime: business zone too
      ['Junk', 'not a date', '', ''], // a non-date-time value keeps the raw projection, never dropped
    ])

    const csvResponse = await request(exporter.app)
      .get(`/api/multitable/sheets/${SHEET_ID}/export-xlsx?format=csv`)
      .buffer(true)
      .parse(parseBody)
      .expect(200)
    const csvText = Buffer.from(csvResponse.body).toString('utf8').replace(/^﻿/, '')
    expect(csvText.split(/\r?\n/)[1]).toBe('Alpha,2026-09-24 09:00,2026-09-24 10:00,2026-09-24 21:05')
    expect(csvText).not.toContain('T01:00:00.000Z')
    expect(csvText).not.toContain('T13:05:00.000Z')

    // Round trip: the exported wall clock is what the import receives, and the write path reads it in the
    // SAME zone rule (field zone, else business zone) → the identical instant is stored.
    const importer = await createApp({ tokenPerms: ['multitable:read', 'multitable:write'], queryHandler: defaultQueryHandler([], fieldRows) })
    const buffer = buildXlsxBuffer(xlsx, {
      sheetName: 'Rows',
      headers: ['Name', 'When', 'Tokyo'],
      rows: [['Alpha', '2026-09-24 09:00', '2026-09-24 10:00']],
    })
    const importResponse = await request(importer.app)
      .post(`/api/multitable/sheets/${SHEET_ID}/import-xlsx`)
      .attach('file', buffer, 'rows.xlsx')
      .expect(200)
    expect(importResponse.body.ok).toBe(true)
    expect(importResponse.body.data.imported).toBe(1)
    const insertCall = importer.mockPool.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO meta_records'))
    expect(JSON.parse(String(insertCall?.[1]?.[2]))).toEqual({ fld_name: 'Alpha', fld_when: stored, fld_tokyo: stored })
  })

  // PR #6083 review must-fix item 1: a workbook whose dateTime / date columns are Excel NATIVE date cells
  // (numFmt 22 `m/d/yy h:mm`, numFmt 14 `m/d/yy`) — what a person gets by typing a date into Excel — must
  // import: the dateTime cell as the Excel wall clock in the business zone, the date cell as that calendar day.
  test('imports Excel native date cells (numFmt 22 dateTime, numFmt 14 date-only) through the record create path', async () => {
    const fieldRows = [
      { id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 1 },
      { id: 'fld_when', name: 'When', type: 'dateTime', property: {}, order: 2 },
      { id: 'fld_day', name: 'Day', type: 'date', property: {}, order: 3 },
    ]
    const ws = xlsx.utils.aoa_to_sheet([
      ['Name', 'When', 'Day'],
      ['Alpha', 46289.375, 46289], // 2026-09-24 09:00 / 2026-09-24 as Excel serials
    ]) as Record<string, any>
    ws.B2.z = 'm/d/yy h:mm'
    ws.C2.z = 'm/d/yy'
    const wb = xlsx.utils.book_new()
    xlsx.utils.book_append_sheet(wb, ws, 'Rows')
    const buffer = Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer)
    // The fixture really is a native date cell: SheetJS's own formatted read shows the US-locale text.
    const control = xlsx.read(buffer, { type: 'buffer' })
    expect((xlsx.utils.sheet_to_json(control.Sheets.Rows, { header: 1, raw: false, defval: '' }) as string[][])[1]).toEqual(['Alpha', '9/24/26 9:00', '9/24/26'])

    const { app, mockPool } = await createApp({ tokenPerms: ['multitable:read', 'multitable:write'], queryHandler: defaultQueryHandler([], fieldRows) })
    const response = await request(app)
      .post(`/api/multitable/sheets/${SHEET_ID}/import-xlsx`)
      .attach('file', buffer, 'rows.xlsx')
      .expect(200)
    expect(response.body.ok).toBe(true)
    expect(response.body.data.imported).toBe(1)
    expect(response.body.data.failures).toEqual([])
    const insertCall = mockPool.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO meta_records'))
    expect(JSON.parse(String(insertCall?.[1]?.[2]))).toEqual({
      fld_name: 'Alpha',
      fld_when: '2026-09-24T01:00:00.000Z', // 09:00 北京时间 — the Excel wall clock, not the process zone
      fld_day: '2026-09-24', // the calendar day as written
    })
  })
})
