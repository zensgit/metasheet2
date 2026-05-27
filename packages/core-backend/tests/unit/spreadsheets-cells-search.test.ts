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
    select: [] as unknown[],
    where: [] as unknown[][],
    innerJoin: [] as Array<[unknown, unknown, unknown]>,
    orderBy: [] as Array<[unknown, unknown]>,
    limit: undefined as number | undefined,
    offset: undefined as number | undefined,
  }
  const chain: any = {
    select: vi.fn((fields: unknown) => {
      state.select.push(fields)
      return chain
    }),
    selectAll: vi.fn(() => chain),
    innerJoin: vi.fn((table: unknown, left: unknown, right: unknown) => {
      state.innerJoin.push([table, left, right])
      return chain
    }),
    where: vi.fn((...args: unknown[]) => {
      state.where.push(args)
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

function makeDb(options: { spreadsheet?: unknown; items?: unknown[] } = {}) {
  const spreadsheetQuery = makeSelectQuery({
    takeFirst: options.spreadsheet === undefined ? { id: spreadsheetId } : options.spreadsheet,
  })
  const cellsQuery = makeSelectQuery({ execute: options.items ?? [] })
  const db = {
    selectFrom: vi.fn((table: string) => {
      if (table === 'spreadsheets') return spreadsheetQuery.chain
      if (table === 'cells') return cellsQuery.chain
      throw new Error(`unexpected table ${table}`)
    }),
  }
  return { db, spreadsheetQuery, cellsQuery }
}

async function loadRouter(db: unknown) {
  const mod = await import('../../src/routes/spreadsheets')
  return mod.spreadsheetsRouter(undefined, { db: db as any })
}

async function callSearch(router: any, query: Request['query'] = {}) {
  const req = {
    params: { id: spreadsheetId },
    query,
    user: { id: 'user_1' },
  } as unknown as Request
  const res = createMockRes()
  const layer = router.stack.find((l: any) => l?.route?.path === '/api/spreadsheets/:id/search' && l.route.methods?.get)
  if (!layer) throw new Error('GET spreadsheet search route not registered')
  const handlers = layer.route.stack.map((s: any) => s.handle)
  const realHandler = handlers[handlers.length - 1]
  await realHandler(req, res, () => {})
  return res
}

describe('GET /api/spreadsheets/:id/search (#529)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('searches cells with default paging and stable ordering', async () => {
    const items = [
      {
        id: 'cell_1',
        sheet_id: 'sheet_1',
        row_index: 2,
        column_index: 1,
        value: { value: 'Alpha' },
        sheet_name: 'Sheet1',
        sheet_order_index: 0,
      },
    ]
    const { db, cellsQuery } = makeDb({ items })
    const router = await loadRouter(db)

    const res = await callSearch(router, { q: 'Alpha' })

    expect(res.statusCode).toBe(200)
    expect(res.jsonPayload).toEqual({ ok: true, data: { q: 'Alpha', limit: 50, offset: 0, items } })
    expect(db.selectFrom).toHaveBeenNthCalledWith(1, 'spreadsheets')
    expect(db.selectFrom).toHaveBeenNthCalledWith(2, 'cells')
    expect(cellsQuery.state.innerJoin).toEqual([['sheets', 'sheets.id', 'cells.sheet_id']])
    expect(cellsQuery.state.where[0]).toEqual(['sheets.spreadsheet_id', '=', spreadsheetId])
    expect(cellsQuery.state.where).toHaveLength(2)
    expect(cellsQuery.state.orderBy).toEqual([
      ['sheets.order_index', 'asc'],
      ['cells.row_index', 'asc'],
      ['cells.column_index', 'asc'],
    ])
    expect(cellsQuery.state.limit).toBe(50)
    expect(cellsQuery.state.offset).toBe(0)
  })

  it('accepts query alias plus explicit limit and offset', async () => {
    const { db, cellsQuery } = makeDb()
    const router = await loadRouter(db)

    const res = await callSearch(router, { query: 'Beta', limit: '2', offset: '3' })

    expect(res.statusCode).toBe(200)
    expect(res.jsonPayload.data.q).toBe('Beta')
    expect(res.jsonPayload.data.limit).toBe(2)
    expect(res.jsonPayload.data.offset).toBe(3)
    expect(cellsQuery.state.limit).toBe(2)
    expect(cellsQuery.state.offset).toBe(3)
  })

  it('rejects an empty search term before hitting the database', async () => {
    const { db } = makeDb()
    const router = await loadRouter(db)

    const res = await callSearch(router, { q: '   ' })

    expect(res.statusCode).toBe(400)
    expect(res.jsonPayload.ok).toBe(false)
    expect(res.jsonPayload.error.code).toBe('INVALID_QUERY')
    expect(db.selectFrom).not.toHaveBeenCalled()
  })

  it('rejects an oversized limit before hitting the database', async () => {
    const { db } = makeDb()
    const router = await loadRouter(db)

    const res = await callSearch(router, { q: 'Alpha', limit: '201' })

    expect(res.statusCode).toBe(400)
    expect(res.jsonPayload.error.message).toBe('limit must be less than or equal to 200')
    expect(db.selectFrom).not.toHaveBeenCalled()
  })

  it('returns 404 when the spreadsheet does not exist', async () => {
    const { db, cellsQuery } = makeDb({ spreadsheet: null })
    const router = await loadRouter(db)

    const res = await callSearch(router, { q: 'Alpha' })

    expect(res.statusCode).toBe(404)
    expect(res.jsonPayload.error.code).toBe('NOT_FOUND')
    expect(cellsQuery.chain.execute).not.toHaveBeenCalled()
  })
})
