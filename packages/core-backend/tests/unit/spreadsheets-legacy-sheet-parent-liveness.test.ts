/**
 * issue #5828 — the LEGACY spreadsheet API's `:sheetId` routes had no parent-liveness gate, and the
 * cell-write route never bound `:sheetId` to `:id` at all.
 *
 * Why the multitable answer does not apply: `:sheetId` names a row of the legacy `sheets` table
 * (src/db/types.ts SheetsTable), not `meta_sheets`, and `sheets` carries no `deleted_at` of its own —
 * soft delete lives on its parent (`spreadsheets.deleted_at`, set by DELETE /api/spreadsheets/:id,
 * which leaves every child row in place). So `multitable/sheet-liveness.ts` and its
 * `sendSheetNotLive` refusal shape are the wrong instrument here; the refusal must be this entity's
 * own 404 (`{ ok: false, error: { code: 'NOT_FOUND', message: 'Sheet not found' } }`, the shape
 * PUT / DELETE /api/spreadsheets/:id already answer with).
 *
 * What these specs pin, through a real express mount (so the gate is proven to sit in the chain, not
 * just in a helper nobody calls):
 *  1. a soft-deleted parent refuses all three routes — metadata write, cell read, cell write;
 *  2. `:sheetId` is bound to `:id`: spreadsheet A's path may not address spreadsheet B's sheet, which
 *     before this was a WRITE primitive (PUT …/cells read `req.params.sheetId` alone);
 *  3. every miss answers the SAME 404 body — deleted parent, wrong parent and unknown sheet are
 *     indistinguishable, so the gate is not an existence oracle;
 *  4. fail-closed: a parent lookup that throws answers 500 and no sheet-keyed row is touched;
 *  5. on every refusal NOTHING was read or written below the gate (asserted on the recorded calls) —
 *     a 404 that had already written would have been the same hole with a nicer answer;
 *  6. positive control: the live, bound case still answers 200 on all three routes.
 *
 * Transport: usePinnedServer() + request(pinned.url()) — tests/unit may never call request(app)
 * (#4154; tests/unit/supertest-app-mode.guard.test.ts is zero-tolerance).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'

import { usePinnedServer } from '../utils/pinned-server'

vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))
vi.mock('../../src/audit/audit', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/db/db', () => ({ db: {} }))
vi.mock('../../src/core/logger', () => ({
  Logger: class {
    info() {}
    warn() {}
    error() {}
    debug() {}
  },
}))

import { spreadsheetsRouter } from '../../src/routes/spreadsheets'

const SS_A = 'spreadsheet_a'
const SS_B = 'spreadsheet_b'
const SHEET_A = 'sheet_a'
const SHEET_B = 'sheet_b'

type Row = Record<string, unknown>

interface FakeDbOptions {
  /** Tables whose SELECT must throw, to prove the fail-closed path. */
  throwOnSelect?: string[]
}

/**
 * In-memory stand-in for the slice of kysely this router uses. It records every call so a refusal can
 * be shown to have touched nothing, and it applies the router's real predicates (`where(col, op, v)`
 * and the expression-builder form used by the cell lookup) rather than replaying a queued answer.
 */
function makeFakeDb(tables: Record<string, Row[]>, options: FakeDbOptions = {}) {
  const calls: string[] = []
  const throwOnSelect = new Set(options.throwOnSelect ?? [])

  const matches = (row: Row, filters: Array<[string, string, unknown]>): boolean =>
    filters.every(([col, op, value]) => {
      if (op === 'is' && value === null) return row[col] === null || row[col] === undefined
      if (op === '=') return row[col] === value
      if (op === '>=') return (row[col] as number) >= (value as number)
      if (op === '<=') return (row[col] as number) <= (value as number)
      throw new Error(`fake db: unsupported operator ${op}`)
    })

  const collectFilters = (
    filters: Array<[string, string, unknown]>,
    fieldOrPredicate: unknown,
    op?: string,
    value?: unknown,
  ): void => {
    if (typeof fieldOrPredicate === 'string') {
      filters.push([fieldOrPredicate, op as string, value])
      return
    }
    const eb: any = (col: string, o: string, v: unknown) => [col, o, v]
    eb.and = (parts: Array<[string, string, unknown]>) => parts
    eb.or = () => { throw new Error('fake db: OR is not used by this router') }
    const raw = (fieldOrPredicate as (b: unknown) => unknown)(eb)
    const parts = Array.isArray(raw) && Array.isArray(raw[0]) ? raw : [raw]
    for (const part of parts as Array<[string, string, unknown]>) filters.push(part)
  }

  const selectFrom = (table: string) => {
    calls.push(`select:${table}`)
    const filters: Array<[string, string, unknown]> = []
    let take: number | undefined
    let skip: number | undefined
    const rows = () => {
      if (throwOnSelect.has(table)) throw new Error(`fake db: ${table} is unavailable`)
      let out = (tables[table] ?? []).filter((r) => matches(r, filters))
      if (skip !== undefined) out = out.slice(skip)
      if (take !== undefined) out = out.slice(0, take)
      return out.map((r) => ({ ...r }))
    }
    const chain: any = {
      select: () => chain,
      selectAll: () => chain,
      orderBy: () => chain,
      limit: (n: number) => { take = n; return chain },
      offset: (n: number) => { skip = n; return chain },
      where: (fieldOrPredicate: unknown, op?: string, value?: unknown) => {
        collectFilters(filters, fieldOrPredicate, op, value)
        return chain
      },
      executeTakeFirst: async () => rows()[0],
      execute: async () => rows(),
    }
    return chain
  }

  const updateTable = (table: string) => {
    calls.push(`update:${table}`)
    const filters: Array<[string, string, unknown]> = []
    let patch: Row = {}
    const apply = () => {
      const target = (tables[table] ?? []).find((r) => matches(r, filters))
      if (!target) return undefined
      for (const [key, value] of Object.entries(patch)) {
        // `sql\`version + 1\`` arrives as an opaque builder; the router only ever bumps `version`.
        target[key] = key === 'version' && typeof value === 'object' && value !== null
          ? ((target.version as number) ?? 1) + 1
          : value
      }
      return { ...target }
    }
    const chain: any = {
      set: (values: Row) => { patch = values; return chain },
      where: (fieldOrPredicate: unknown, op?: string, value?: unknown) => {
        collectFilters(filters, fieldOrPredicate, op, value)
        return chain
      },
      returningAll: () => chain,
      executeTakeFirst: async () => apply(),
      executeTakeFirstOrThrow: async () => {
        const updated = apply()
        if (!updated) throw new Error(`fake db: no ${table} row matched the update`)
        return updated
      },
      execute: async () => [apply()],
    }
    return chain
  }

  const insertInto = (table: string) => {
    calls.push(`insert:${table}`)
    let inserted: Row = {}
    const chain: any = {
      values: (values: Row) => {
        inserted = { id: `${table}_${(tables[table] ?? []).length + 1}`, version: 1, ...values }
        ;(tables[table] ??= []).push(inserted)
        return chain
      },
      returningAll: () => chain,
      executeTakeFirst: async () => ({ ...inserted }),
      executeTakeFirstOrThrow: async () => ({ ...inserted }),
      execute: async () => [{ ...inserted }],
    }
    return chain
  }

  const db: any = {
    selectFrom,
    updateTable,
    insertInto,
    transaction: () => ({
      execute: async (cb: (trx: unknown) => Promise<unknown>) => {
        calls.push('transaction')
        return cb(db)
      },
    }),
  }
  return { db, calls, tables }
}

/** A live spreadsheet A with sheet A, a live spreadsheet B with sheet B, and one cell in each. */
function seed(): Record<string, Row[]> {
  return {
    spreadsheets: [
      { id: SS_A, name: 'A', deleted_at: null },
      { id: SS_B, name: 'B', deleted_at: null },
    ],
    sheets: [
      { id: SHEET_A, spreadsheet_id: SS_A, name: 'SheetA', row_count: 10, column_count: 5 },
      { id: SHEET_B, spreadsheet_id: SS_B, name: 'SheetB', row_count: 10, column_count: 5 },
    ],
    cells: [
      { id: 'cell_a', sheet_id: SHEET_A, row_index: 0, column_index: 0, value: { value: 'A' }, version: 1 },
      { id: 'cell_b', sheet_id: SHEET_B, row_index: 0, column_index: 0, value: { value: 'B' }, version: 1 },
    ],
    cell_versions: [],
  }
}

const NOT_FOUND_BODY = { ok: false, error: { code: 'NOT_FOUND', message: 'Sheet not found' } }

/** Calls that reach a sheet-keyed row — none of these may appear on a refusal. */
const BELOW_THE_GATE = /^(?:update:sheets|insert:cells|insert:cell_versions|select:cells|transaction)$/

describe('#5828 legacy spreadsheet `:sheetId` routes — parent liveness and :sheetId ↔ :id binding', () => {
  const pinned = usePinnedServer()
  let fake: ReturnType<typeof makeFakeDb>

  function install(tables: Record<string, Row[]>, options: FakeDbOptions = {}): void {
    fake = makeFakeDb(tables, options)
    const app: Express = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as express.Request & { user?: { id: string } }).user = { id: 'user_1' }
      next()
    })
    app.use(spreadsheetsRouter(undefined, { db: fake.db }))
    pinned.setApp(app)
  }

  const putMeta = (id: string, sheetId: string) =>
    request(pinned.url()).put(`/api/spreadsheets/${id}/sheets/${sheetId}`).send({ row_count: 20 })
  const getCells = (id: string, sheetId: string) =>
    request(pinned.url()).get(`/api/spreadsheets/${id}/sheets/${sheetId}/cells`)
  const putCells = (id: string, sheetId: string) =>
    request(pinned.url())
      .put(`/api/spreadsheets/${id}/sheets/${sheetId}/cells`)
      .send({ cells: [{ row: 0, col: 0, value: 'written', dataType: 'text' }] })

  const touchedBelowTheGate = () => fake.calls.filter((c) => BELOW_THE_GATE.test(c))

  beforeEach(() => {
    vi.clearAllMocks()
    install(seed())
  })

  describe('positive control: live parent, sheet bound to it', () => {
    it('PUT …/sheets/:sheetId updates the metadata', async () => {
      const res = await putMeta(SS_A, SHEET_A)
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.data.row_count).toBe(20)
    })

    it('GET …/sheets/:sheetId/cells returns the sheet and its cells', async () => {
      const res = await getCells(SS_A, SHEET_A)
      expect(res.status).toBe(200)
      expect(res.body.data.sheet.id).toBe(SHEET_A)
      expect(res.body.data.cells.map((c: Row) => c.id)).toEqual(['cell_a'])
    })

    it('PUT …/sheets/:sheetId/cells writes the cell', async () => {
      const res = await putCells(SS_A, SHEET_A)
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(fake.tables.cells!.find((c) => c.id === 'cell_a')!.value).toEqual({ value: 'written' })
    })
  })

  describe('the parent spreadsheet is soft-deleted', () => {
    beforeEach(() => {
      const tables = seed()
      tables.spreadsheets!.find((s) => s.id === SS_A)!.deleted_at = new Date()
      install(tables)
    })

    it('PUT …/sheets/:sheetId refuses and writes nothing', async () => {
      const res = await putMeta(SS_A, SHEET_A)
      expect(res.status).toBe(404)
      expect(res.body).toEqual(NOT_FOUND_BODY)
      expect(touchedBelowTheGate()).toEqual([])
      expect(fake.tables.sheets!.find((s) => s.id === SHEET_A)!.row_count).toBe(10)
    })

    it('GET …/sheets/:sheetId/cells refuses and reads no cell', async () => {
      const res = await getCells(SS_A, SHEET_A)
      expect(res.status).toBe(404)
      expect(res.body).toEqual(NOT_FOUND_BODY)
      expect(touchedBelowTheGate()).toEqual([])
    })

    it('PUT …/sheets/:sheetId/cells refuses and writes nothing', async () => {
      const res = await putCells(SS_A, SHEET_A)
      expect(res.status).toBe(404)
      expect(res.body).toEqual(NOT_FOUND_BODY)
      expect(touchedBelowTheGate()).toEqual([])
      expect(fake.tables.cells!.find((c) => c.id === 'cell_a')!.value).toEqual({ value: 'A' })
    })

    it('a sheet of a LIVE sibling spreadsheet is still reachable — the refusal is the parent’s, not global', async () => {
      const res = await getCells(SS_B, SHEET_B)
      expect(res.status).toBe(200)
      expect(res.body.data.sheet.id).toBe(SHEET_B)
    })
  })

  describe('cross-spreadsheet addressing: A’s path, B’s sheet (both parents live)', () => {
    it('PUT …/sheets/:sheetId refuses and leaves B’s sheet untouched', async () => {
      const res = await putMeta(SS_A, SHEET_B)
      expect(res.status).toBe(404)
      expect(res.body).toEqual(NOT_FOUND_BODY)
      expect(touchedBelowTheGate()).toEqual([])
      expect(fake.tables.sheets!.find((s) => s.id === SHEET_B)!.row_count).toBe(10)
    })

    it('GET …/sheets/:sheetId/cells refuses and reads none of B’s cells', async () => {
      const res = await getCells(SS_A, SHEET_B)
      expect(res.status).toBe(404)
      expect(res.body).toEqual(NOT_FOUND_BODY)
      expect(touchedBelowTheGate()).toEqual([])
    })

    it('PUT …/sheets/:sheetId/cells refuses and leaves B’s cell untouched (the #5828 write primitive)', async () => {
      const res = await putCells(SS_A, SHEET_B)
      expect(res.status).toBe(404)
      expect(res.body).toEqual(NOT_FOUND_BODY)
      expect(touchedBelowTheGate()).toEqual([])
      expect(fake.tables.cells!.find((c) => c.id === 'cell_b')!.value).toEqual({ value: 'B' })
      expect(fake.tables.cells!).toHaveLength(2)
    })
  })

  it('no existence oracle: deleted parent, wrong parent, unknown sheet and unknown spreadsheet all answer the same', async () => {
    const tables = seed()
    tables.spreadsheets!.find((s) => s.id === SS_A)!.deleted_at = new Date()
    install(tables)
    const deletedParent = await putCells(SS_A, SHEET_A)
    install(seed())
    const wrongParent = await putCells(SS_A, SHEET_B)
    install(seed())
    const unknownSheet = await putCells(SS_A, 'sheet_does_not_exist')
    install(seed())
    const unknownSpreadsheet = await putCells('spreadsheet_does_not_exist', SHEET_A)

    for (const res of [deletedParent, wrongParent, unknownSheet, unknownSpreadsheet]) {
      expect(res.status).toBe(404)
      expect(res.body).toEqual(NOT_FOUND_BODY)
    }
  })

  describe('fail-closed: the parent lookup throws', () => {
    beforeEach(() => {
      install(seed(), { throwOnSelect: ['spreadsheets'] })
    })

    it('PUT …/sheets/:sheetId answers 500 and writes nothing', async () => {
      const res = await putMeta(SS_A, SHEET_A)
      expect(res.status).toBe(500)
      expect(res.body.error.code).toBe('INTERNAL_ERROR')
      expect(touchedBelowTheGate()).toEqual([])
      expect(fake.tables.sheets!.find((s) => s.id === SHEET_A)!.row_count).toBe(10)
    })

    it('GET …/sheets/:sheetId/cells answers 500 and reads no cell', async () => {
      const res = await getCells(SS_A, SHEET_A)
      expect(res.status).toBe(500)
      expect(res.body.error.code).toBe('INTERNAL_ERROR')
      expect(touchedBelowTheGate()).toEqual([])
    })

    it('PUT …/sheets/:sheetId/cells answers 500 and writes nothing', async () => {
      const res = await putCells(SS_A, SHEET_A)
      expect(res.status).toBe(500)
      expect(res.body.error.code).toBe('INTERNAL_ERROR')
      expect(touchedBelowTheGate()).toEqual([])
      expect(fake.tables.cells!.find((c) => c.id === 'cell_a')!.value).toEqual({ value: 'A' })
    })
  })
})
