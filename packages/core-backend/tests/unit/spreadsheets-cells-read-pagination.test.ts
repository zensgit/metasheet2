import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'

vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: () => (_req: Request, _res: Response, next: () => void) => next(),
}))
vi.mock('../../src/audit/audit', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/db/db', () => ({
  db: {},
}))
vi.mock('../../src/core/logger', () => ({
  Logger: class {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_context: string) {}
    info() {}
    warn() {}
    error() {}
    debug() {}
  },
}))

const spreadsheetId = 'spreadsheet_1'
const sheetId = 'sheet_1'

function createMockRes() {
  const res: any = {
    statusCode: 200,
    jsonPayload: null,
    status(code: number) { res.statusCode = code; return res },
    json(payload: unknown) { res.jsonPayload = payload; return res },
  }
  return res as Response & { statusCode: number; jsonPayload: any }
}

function makeSelectQuery(result: { takeFirst?: unknown; execute?: unknown[] }) {
  const state = {
    where: [] as Array<[unknown, unknown, unknown]>,
    orderBy: [] as Array<[unknown, unknown]>,
    limit: undefined as number | undefined,
    offset: undefined as number | undefined,
  }
  const chain: any = {
    selectAll: vi.fn(() => chain),
    where: vi.fn((field: unknown, op: unknown, value: unknown) => {
      state.where.push([field, op, value])
      return chain
    }),
    orderBy: vi.fn((field: unknown, direction: unknown) => {
      state.orderBy.push([field, direction])
      return chain
    }),
    limit: vi.fn((value: number) => {
      state.limit = value
      return chain
    }),
    offset: vi.fn((value: number) => {
      state.offset = value
      return chain
    }),
    executeTakeFirst: vi.fn().mockResolvedValue(result.takeFirst),
    execute: vi.fn().mockResolvedValue(result.execute ?? []),
  }
  return { chain, state }
}

function makeDb(cells: unknown[] = []) {
  const sheetQuery = makeSelectQuery({
    takeFirst: { id: sheetId, spreadsheet_id: spreadsheetId, name: 'Sheet1' },
  })
  const cellsQuery = makeSelectQuery({ execute: cells })
  const db = {
    selectFrom: vi.fn((table: string) => {
      if (table === 'sheets') return sheetQuery.chain
      if (table === 'cells') return cellsQuery.chain
      throw new Error(`unexpected table ${table}`)
    }),
  }
  return { db, sheetQuery, cellsQuery }
}

async function loadRouter(db: unknown) {
  const mod = await import('../../src/routes/spreadsheets')
  return mod.spreadsheetsRouter(undefined, { db: db as any })
}

async function callGetCells(router: any, query: Request['query'] = {}) {
  const req = {
    params: { id: spreadsheetId, sheetId },
    query,
    user: { id: 'user_1' },
  } as unknown as Request
  const res = createMockRes()
  const layer = router.stack.find((l: any) => l?.route?.path === '/api/spreadsheets/:id/sheets/:sheetId/cells' && l.route.methods?.get)
  if (!layer) throw new Error('GET cells route not registered')
  const handlers = layer.route.stack.map((s: any) => s.handle)
  const realHandler = handlers[handlers.length - 1]
  await realHandler(req, res, () => {})
  return res
}

describe('GET /api/spreadsheets/:id/sheets/:sheetId/cells pagination (#530)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('preserves full cell reads when pagination params are absent', async () => {
    const cells = [
      { id: 'cell_1', sheet_id: sheetId, row_index: 0, column_index: 0 },
      { id: 'cell_2', sheet_id: sheetId, row_index: 1, column_index: 0 },
    ]
    const { db, cellsQuery } = makeDb(cells)
    const router = await loadRouter(db)

    const res = await callGetCells(router)

    expect(res.statusCode).toBe(200)
    expect(res.jsonPayload.ok).toBe(true)
    expect(res.jsonPayload.data.cells).toEqual(cells)
    expect(cellsQuery.state.where).toEqual([['sheet_id', '=', sheetId]])
    expect(cellsQuery.state.orderBy).toEqual([['row_index', 'asc'], ['column_index', 'asc']])
    expect(cellsQuery.chain.limit).not.toHaveBeenCalled()
    expect(cellsQuery.chain.offset).not.toHaveBeenCalled()
  })

  it('applies row range and limit/offset query params to the cells query', async () => {
    const cells = [
      { id: 'cell_3', sheet_id: sheetId, row_index: 2, column_index: 0 },
      { id: 'cell_4', sheet_id: sheetId, row_index: 3, column_index: 0 },
    ]
    const { db, cellsQuery } = makeDb(cells)
    const router = await loadRouter(db)

    const res = await callGetCells(router, { startRow: '2', endRow: '5', limit: '2', offset: '1' })

    expect(res.statusCode).toBe(200)
    expect(res.jsonPayload.data.cells).toEqual(cells)
    expect(cellsQuery.state.where).toEqual([
      ['sheet_id', '=', sheetId],
      ['row_index', '>=', 2],
      ['row_index', '<=', 5],
    ])
    expect(cellsQuery.state.limit).toBe(2)
    expect(cellsQuery.state.offset).toBe(1)
  })

  it('rejects an inverted row range before hitting the database', async () => {
    const { db } = makeDb()
    const router = await loadRouter(db)

    const res = await callGetCells(router, { startRow: '5', endRow: '2' })

    expect(res.statusCode).toBe(400)
    expect(res.jsonPayload.ok).toBe(false)
    expect(res.jsonPayload.error.code).toBe('INVALID_QUERY')
    expect(db.selectFrom).not.toHaveBeenCalled()
  })
})
