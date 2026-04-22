/**
 * Optimistic-lock tests for `PUT /api/spreadsheets/:id/sheets/:sheetId/cells`.
 *
 * Reviewer finding #526 (Pilot R1, 2026-03-20): the handler silently
 * last-write-wins on the legacy cells endpoint. Both `GridView.vue` and
 * `SpreadsheetDetailView.vue` still target it via App.vue's navbar, so
 * concurrent edits could overwrite each other with no feedback.
 *
 * The fix:
 *   - `cells.version` is now read on update, bumped on successful write.
 *   - The request body may carry `expectedVersion` per cell.
 *   - Mismatch → 409 VERSION_CONFLICT, transaction rolls back, the
 *     response payload carries both `expectedVersion` and the current
 *     `serverVersion` so the client can refetch + reconcile.
 *   - If `expectedVersion` is omitted, legacy last-write-wins is kept
 *     for back-compat (version still bumps so future clients can opt in).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'

// Dependencies the router imports — keep their shapes but stub the
// behavior we need so the transaction path is purely in memory.
vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: () => (_req: Request, _res: Response, next: () => void) => next(),
}))
vi.mock('../../src/audit/audit', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
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

interface CellRow {
  id: string
  sheet_id: string
  row_index: number
  column_index: number
  value: unknown
  data_type: string | null
  formula: string | null
  computed_value: unknown
  version: number
  created_at: Date
  updated_at: Date
}

/**
 * Minimal Kysely stand-in that supports just the chain used by the
 * cell-PUT handler:
 *   selectFrom('cells').selectAll().where(...).executeTakeFirst()
 *   updateTable('cells').set(...).where('id', '=', id).returningAll().executeTakeFirstOrThrow()
 *   insertInto('cells').values(...).returningAll().executeTakeFirstOrThrow()
 *   insertInto('cell_versions').values(...).execute()
 *   transaction().execute(cb)
 *
 * Behavior is driven by the `cells` array passed in so each test can
 * seed a scenario.
 */
function makeFakeDb(
  initial: CellRow[] = [],
  options: { afterSelect?: () => void; preserveExternalCellMutationsOnRollback?: boolean } = {},
) {
  const cells = [...initial]
  const cellVersionsInserts: Array<Record<string, unknown>> = []

  const baseQuery = {
    cells,
    cellVersionsInserts,
  }

  const trx = {
    selectFrom(table: 'cells') {
      if (table !== 'cells') throw new Error(`unexpected table ${table}`)
      const state: { where?: { sheetId: string; row: number; col: number }; id?: string } = {}
      const chain: any = {
        selectAll() { return chain },
        select() { return chain },
        where(fieldOrPredicate: string | ((eb: any) => any), _op?: string, value?: unknown) {
          if (typeof fieldOrPredicate === 'string') {
            if (fieldOrPredicate === 'id') state.id = value as string
            return chain
          }
          // Real Kysely `eb` is a callable with `.and` / `.or`. Build a
          // minimal shape sufficient for the handler's use:
          //   eb.and([eb('sheet_id','=',sheetId), eb('row_index','=',row), eb('col_index','=',col)])
          const eb: any = (col: string, _op: string, val: unknown) => ({ col, val })
          eb.and = (parts: Array<{ col: string; val: unknown }>) => parts
          eb.or = (parts: Array<{ col: string; val: unknown }>) => parts
          const raw = fieldOrPredicate(eb)
          const conditions: Array<{ col: string; val: unknown }> = Array.isArray(raw)
            ? raw
            : raw && typeof raw === 'object' && 'col' in raw
              ? [raw]
              : []
          const sheet = conditions.find((c) => c.col === 'sheet_id')?.val as string
          const row = conditions.find((c) => c.col === 'row_index')?.val as number
          const col = conditions.find((c) => c.col === 'column_index')?.val as number
          state.where = { sheetId: sheet, row, col }
          return chain
        },
        async executeTakeFirst() {
          if (state.id) {
            const found = cells.find((c) => c.id === state.id)
            return found ? { ...found } : undefined
          }
          if (!state.where) return undefined
          const found = cells.find(
            (c) =>
              c.sheet_id === state.where!.sheetId &&
              c.row_index === state.where!.row &&
              c.column_index === state.where!.col,
          )
          const snapshot = found ? { ...found } : undefined
          options.afterSelect?.()
          return snapshot
        },
      }
      return chain
    },
    updateTable(table: 'cells') {
      if (table !== 'cells') throw new Error(`unexpected updateTable ${table}`)
      const state: { values?: Partial<CellRow>; id?: string; version?: number } = {}
      const chain = {
        set(values: Partial<CellRow>) { state.values = values; return chain },
        where(field: string, _op: string, value: string | number) {
          if (field === 'id') state.id = value as string
          if (field === 'version') state.version = value as number
          return chain
        },
        returningAll() { return chain },
        async executeTakeFirst() {
          const row = cells.find((c) => c.id === state.id)
          if (!row) return undefined
          if (typeof state.version === 'number' && row.version !== state.version) return undefined
          const values = { ...(state.values ?? {}) } as Partial<CellRow>
          if ('version' in values && typeof values.version !== 'number') {
            values.version = row.version + 1
          }
          Object.assign(row, values)
          return { ...row }
        },
        async executeTakeFirstOrThrow() {
          const row = await chain.executeTakeFirst()
          if (!row) throw new Error('row not found')
          return row
        },
      }
      return chain
    },
    insertInto(table: 'cells' | 'cell_versions') {
      const state: { values?: Partial<CellRow> | Record<string, unknown> } = {}
      const chain = {
        values(v: any) { state.values = v; return chain },
        returningAll() { return chain },
        async executeTakeFirstOrThrow() {
          if (table !== 'cells') throw new Error('unexpected returningAll on cell_versions')
          const row: CellRow = {
            id: `cell_${cells.length + 1}`,
            sheet_id: (state.values as any).sheet_id,
            row_index: (state.values as any).row_index,
            column_index: (state.values as any).column_index,
            value: (state.values as any).value,
            data_type: (state.values as any).data_type ?? null,
            formula: (state.values as any).formula ?? null,
            computed_value: null,
            version: 1,
            created_at: new Date(),
            updated_at: new Date(),
          }
          cells.push(row)
          return { ...row }
        },
        async execute() {
          if (table === 'cell_versions') cellVersionsInserts.push(state.values as Record<string, unknown>)
          return [] as unknown[]
        },
      }
      return chain
    },
  }

  const db = {
    transaction() {
      return {
        async execute<T>(cb: (trx: typeof trx) => Promise<T>): Promise<T> {
          // Execute the callback with the in-memory trx. On throw, we
          // roll back by restoring the initial state snapshot.
          const snapshotCells = cells.map((c) => ({ ...c }))
          const snapshotInserts = [...cellVersionsInserts]
          try {
            return await cb(trx)
          } catch (err) {
            if (!options.preserveExternalCellMutationsOnRollback) {
              cells.splice(0, cells.length, ...snapshotCells)
            }
            cellVersionsInserts.splice(0, cellVersionsInserts.length, ...snapshotInserts)
            throw err
          }
        },
      }
    },
  }

  return { db, state: baseQuery }
}

// Mock the default db BEFORE importing the router.
let activeDb: ReturnType<typeof makeFakeDb>['db']
vi.mock('../../src/db/db', () => ({
  get db() { return activeDb },
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
async function loadRouter() {
  const mod = await import('../../src/routes/spreadsheets')
  return mod.spreadsheetsRouter()
}

function createMockRes() {
  const res: any = {
    statusCode: 200,
    jsonPayload: null,
    status(code: number) { res.statusCode = code; return res },
    json(payload: unknown) { res.jsonPayload = payload; return res },
  }
  return res as Response & { statusCode: number; jsonPayload: any }
}

async function callCellPut(router: any, body: unknown) {
  const req = {
    params: { id: 'sh_1', sheetId: 'sheet_1' },
    body,
    user: { id: 'user_1' },
  } as unknown as Request
  const res = createMockRes()
  // Locate the handler on the router stack for PUT /api/spreadsheets/:id/sheets/:sheetId/cells.
  const layer = router.stack.find((l: any) => l?.route?.path === '/api/spreadsheets/:id/sheets/:sheetId/cells' && l.route.methods?.put)
  if (!layer) throw new Error('PUT cells route not registered')
  // Skip rbacGuard (stubbed to pass-through) and invoke the handler directly.
  const handlers = layer.route.stack.map((s: any) => s.handle)
  const realHandler = handlers[handlers.length - 1]
  await realHandler(req, res, () => {})
  return res
}

const nowRow = (overrides: Partial<CellRow>): CellRow => ({
  id: 'cell_1',
  sheet_id: 'sheet_1',
  row_index: 0,
  column_index: 0,
  value: { value: 'old' },
  data_type: null,
  formula: null,
  computed_value: null,
  version: 1,
  created_at: new Date(),
  updated_at: new Date(),
  ...overrides,
})

describe('PUT /api/spreadsheets/:id/sheets/:sheetId/cells — cell version (#526)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('accepts the write when expectedVersion matches the stored row and bumps version', async () => {
    const { db, state } = makeFakeDb([nowRow({ version: 3, value: { value: 'A' } })])
    activeDb = db
    const router = await loadRouter()

    const res = await callCellPut(router, {
      cells: [{ row: 0, col: 0, value: 'B', expectedVersion: 3 }],
    })

    expect(res.statusCode).toBe(200)
    expect(res.jsonPayload.ok).toBe(true)
    expect(res.jsonPayload.data.cells[0].version).toBe(4)
    expect(state.cells[0].version).toBe(4)
    expect(state.cells[0].value).toEqual({ value: 'B' })
    // History row uses the PREVIOUS version (the value we snapshot out).
    expect(state.cellVersionsInserts[0].version_number).toBe(3)
  })

  it('returns 409 VERSION_CONFLICT when expectedVersion does not match — transaction rolls back', async () => {
    const { db, state } = makeFakeDb([nowRow({ version: 5, value: { value: 'current' } })])
    activeDb = db
    const router = await loadRouter()

    const res = await callCellPut(router, {
      cells: [{ row: 0, col: 0, value: 'attempt-to-overwrite', expectedVersion: 2 }],
    })

    expect(res.statusCode).toBe(409)
    expect(res.jsonPayload.ok).toBe(false)
    expect(res.jsonPayload.error.code).toBe('VERSION_CONFLICT')
    expect(res.jsonPayload.error.sheetId).toBe('sheet_1')
    expect(res.jsonPayload.error.row).toBe(0)
    expect(res.jsonPayload.error.col).toBe(0)
    expect(res.jsonPayload.error.serverVersion).toBe(5)
    expect(res.jsonPayload.error.expectedVersion).toBe(2)
    // Stored row is unchanged — rollback worked.
    expect(state.cells[0].version).toBe(5)
    expect(state.cells[0].value).toEqual({ value: 'current' })
    expect(state.cellVersionsInserts.length).toBe(0)
  })

  it('returns 409 when the row version changes between read and update', async () => {
    let mutated = false
    const { db, state } = makeFakeDb(
      [nowRow({ version: 3, value: { value: 'current' } })],
      {
        preserveExternalCellMutationsOnRollback: true,
        afterSelect: () => {
          if (mutated) return
          mutated = true
          state.cells[0].version = 4
          state.cells[0].value = { value: 'concurrent-write' }
        },
      },
    )
    activeDb = db
    const router = await loadRouter()

    const res = await callCellPut(router, {
      cells: [{ row: 0, col: 0, value: 'stale-write', expectedVersion: 3 }],
    })

    expect(res.statusCode).toBe(409)
    expect(res.jsonPayload.error.code).toBe('VERSION_CONFLICT')
    expect(res.jsonPayload.error.serverVersion).toBe(4)
    expect(res.jsonPayload.error.expectedVersion).toBe(3)
    expect(state.cells[0].version).toBe(4)
    expect(state.cells[0].value).toEqual({ value: 'concurrent-write' })
    expect(state.cellVersionsInserts.length).toBe(0)
  })

  it('409 on a batch aborts ALL cells in the batch (atomic rollback)', async () => {
    const { db, state } = makeFakeDb([
      nowRow({ id: 'cell_a', row_index: 0, column_index: 0, version: 1 }),
      nowRow({ id: 'cell_b', row_index: 0, column_index: 1, version: 10, value: { value: 'b-current' } }),
    ])
    activeDb = db
    const router = await loadRouter()

    const res = await callCellPut(router, {
      cells: [
        { row: 0, col: 0, value: 'a-new', expectedVersion: 1 },  // would succeed
        { row: 0, col: 1, value: 'b-stale', expectedVersion: 9 }, // triggers 409
      ],
    })

    expect(res.statusCode).toBe(409)
    expect(res.jsonPayload.error.code).toBe('VERSION_CONFLICT')
    // Neither cell was updated — the first-cell success is rolled back.
    expect(state.cells.find((c) => c.id === 'cell_a')!.version).toBe(1)
    expect(state.cells.find((c) => c.id === 'cell_b')!.version).toBe(10)
    expect(state.cells.find((c) => c.id === 'cell_b')!.value).toEqual({ value: 'b-current' })
  })

  it('last-write-wins back-compat: omitted expectedVersion still works (and bumps version)', async () => {
    const { db, state } = makeFakeDb([nowRow({ version: 7, value: { value: 'old' } })])
    activeDb = db
    const router = await loadRouter()

    const res = await callCellPut(router, {
      cells: [{ row: 0, col: 0, value: 'new' }], // no expectedVersion
    })

    expect(res.statusCode).toBe(200)
    expect(res.jsonPayload.ok).toBe(true)
    // Version bumps even without an expectedVersion — future clients that
    // opt in can rely on the counter being monotonically increasing.
    expect(state.cells[0].version).toBe(8)
    expect(state.cells[0].value).toEqual({ value: 'new' })
  })

  it('returns 409 when expectedVersion is provided for a non-existent cell', async () => {
    // Empty DB — nothing at (0,0).
    const { db, state } = makeFakeDb([])
    activeDb = db
    const router = await loadRouter()

    const res = await callCellPut(router, {
      cells: [{ row: 0, col: 0, value: 'new', expectedVersion: 3 }],
    })

    expect(res.statusCode).toBe(409)
    expect(res.jsonPayload.error.code).toBe('VERSION_CONFLICT')
    expect(res.jsonPayload.error.serverVersion).toBe(0)
    // No row inserted — client must refetch.
    expect(state.cells.length).toBe(0)
  })

  it('insert path: new cell with no expectedVersion creates version=1', async () => {
    const { db, state } = makeFakeDb([])
    activeDb = db
    const router = await loadRouter()

    const res = await callCellPut(router, {
      cells: [{ row: 5, col: 7, value: 'fresh' }],
    })

    expect(res.statusCode).toBe(200)
    expect(state.cells.length).toBe(1)
    expect(state.cells[0].version).toBe(1)
    expect(state.cells[0].value).toEqual({ value: 'fresh' })
  })
})
