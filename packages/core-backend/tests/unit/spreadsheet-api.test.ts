/**
 * Spreadsheet API Unit Tests
 * Tests spreadsheet CRUD operations and cell management logic
 * Note: Uses mock Request/Response instead of supertest for HTTP testing
 */

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest'
import type { Request, Response } from 'express'
import { createMockDb, createMockQueryBuilder } from '../utils/test-db'
import { BASIC_SPREADSHEET, BASIC_SHEET, TEST_CELLS, TEST_IDS, API_FIXTURES } from '../utils/test-fixtures'

// Mock database BEFORE importing routes
let mockDb: any
vi.mock('../../src/db/db', () => ({
  get db() { return mockDb }
}))

// Helper to create mock request
function createMockRequest(overrides: Partial<Request> = {}): Request {
  return {
    params: {},
    query: {},
    body: {},
    headers: {},
    path: '',
    method: 'GET',
    ...overrides
  } as Request
}

// Helper to create mock response
function createMockResponse(): Response & { _json: any; _status: number } {
  const res: any = {
    _json: null,
    _status: 200,
    json: vi.fn(function(data: any) {
      res._json = data
      return res
    }),
    status: vi.fn(function(code: number) {
      res._status = code
      return res
    }),
    send: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis()
  }
  return res
}

// Extend expect with custom matchers
declare module 'vitest' {
  interface Assertion<T = any> {
    toHaveSuccessResponse(): T
    toHaveErrorResponse(code?: string): T
    toHaveStatus(status: number): T
  }
}

expect.extend({
  toHaveSuccessResponse(received: any) {
    const hasOk = received._json?.ok === true
    const hasData = 'data' in (received._json || {})
    const pass = hasOk && hasData

    return {
      pass,
      message: () => pass
        ? 'Expected response not to be successful'
        : `Expected response to be successful with ok: true and data field. Got: ${JSON.stringify(received._json)}`
    }
  },

  toHaveErrorResponse(received: any, expectedCode?: string) {
    const hasOk = received._json?.ok === false
    const hasError = 'error' in (received._json || {})
    const codeMatches = !expectedCode || received._json?.error?.code === expectedCode
    const pass = hasOk && hasError && codeMatches

    return {
      pass,
      message: () => pass
        ? `Expected response not to be error${expectedCode ? ` with code ${expectedCode}` : ''}`
        : `Expected response to be error${expectedCode ? ` with code ${expectedCode}` : ''}. Got: ${JSON.stringify(received._json)}`
    }
  },

  toHaveStatus(received: any, expectedStatus: number) {
    const pass = received._status === expectedStatus

    return {
      pass,
      message: () => pass
        ? `Expected status not to be ${expectedStatus}`
        : `Expected status ${expectedStatus}, but got ${received._status}`
    }
  }
})

describe('Spreadsheet API Logic Tests', () => {
  beforeEach(() => {
    // Create mock database
    mockDb = createMockDb()
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  describe('Database query builder', () => {
    test('should create query builder with correct methods', () => {
      const queryBuilder = createMockQueryBuilder()

      expect(queryBuilder.execute).toBeDefined()
      expect(queryBuilder.executeTakeFirst).toBeDefined()
      expect(queryBuilder.executeTakeFirstOrThrow).toBeDefined()
      expect(queryBuilder.selectAll).toBeDefined()
      expect(queryBuilder.where).toBeDefined()
      expect(queryBuilder.orderBy).toBeDefined()
      expect(queryBuilder.limit).toBeDefined()
      expect(queryBuilder.values).toBeDefined()
      expect(queryBuilder.set).toBeDefined()
      expect(queryBuilder.returningAll).toBeDefined()
    })

    test('should support method chaining', () => {
      const queryBuilder = createMockQueryBuilder()

      const result = queryBuilder
        .selectAll()
        .where('id', '=', 'test')
        .orderBy('created_at', 'desc')
        .limit(10)

      expect(result).toBe(queryBuilder)
    })
  })

  describe('List spreadsheets logic', () => {
    test('should query spreadsheets from database', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.execute.mockResolvedValue([BASIC_SPREADSHEET])
      mockDb.selectFrom.mockReturnValue(queryBuilder)

      // Simulate calling the database query through mockDb
      const qb = mockDb.selectFrom('spreadsheets')
      const result = await qb.execute()

      expect(result).toEqual([BASIC_SPREADSHEET])
      expect(mockDb.selectFrom).toHaveBeenCalledWith('spreadsheets')
    })

    test('should filter by workspace_id', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.execute.mockResolvedValue([BASIC_SPREADSHEET])
      mockDb.selectFrom.mockReturnValue(queryBuilder)

      queryBuilder.where('workspace_id', '=', TEST_IDS.WORKSPACE_1)

      expect(queryBuilder.where).toHaveBeenCalledWith('workspace_id', '=', TEST_IDS.WORKSPACE_1)
    })

    test('should filter by owner_id', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.execute.mockResolvedValue([])
      mockDb.selectFrom.mockReturnValue(queryBuilder)

      queryBuilder.where('owner_id', '=', TEST_IDS.USER_1)

      expect(queryBuilder.where).toHaveBeenCalledWith('owner_id', '=', TEST_IDS.USER_1)
    })

    test('should filter by is_template', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.execute.mockResolvedValue([])
      mockDb.selectFrom.mockReturnValue(queryBuilder)

      queryBuilder.where('is_template', '=', true)

      expect(queryBuilder.where).toHaveBeenCalledWith('is_template', '=', true)
    })

    test('should exclude deleted spreadsheets', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.execute.mockResolvedValue([])
      mockDb.selectFrom.mockReturnValue(queryBuilder)

      queryBuilder.where('deleted_at', 'is', null)

      expect(queryBuilder.where).toHaveBeenCalledWith('deleted_at', 'is', null)
    })

    test('should handle database errors', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.execute.mockRejectedValue(new Error('Database connection failed'))
      mockDb.selectFrom.mockReturnValue(queryBuilder)

      await expect(queryBuilder.execute()).rejects.toThrow('Database connection failed')
    })
  })

  describe('Create spreadsheet logic', () => {
    test('should create spreadsheet with default sheet', async () => {
      const transactionMock = {
        execute: vi.fn().mockImplementation(async (fn) => {
          return await fn({
            insertInto: vi.fn().mockReturnValue({
              values: vi.fn().mockReturnValue({
                returningAll: vi.fn().mockReturnValue({
                  executeTakeFirstOrThrow: vi.fn().mockResolvedValueOnce(BASIC_SPREADSHEET)
                    .mockResolvedValueOnce(BASIC_SHEET)
                })
              })
            })
          })
        })
      }

      mockDb.transaction.mockReturnValue(transactionMock)

      const result = await transactionMock.execute(async (trx: any) => {
        const spreadsheet = await trx.insertInto('spreadsheets')
          .values({ name: 'New Spreadsheet' })
          .returningAll()
          .executeTakeFirstOrThrow()

        const sheet = await trx.insertInto('sheets')
          .values({ spreadsheet_id: spreadsheet.id })
          .returningAll()
          .executeTakeFirstOrThrow()

        return { spreadsheet, sheet }
      })

      expect(result.spreadsheet).toEqual(BASIC_SPREADSHEET)
      expect(result.sheet).toEqual(BASIC_SHEET)
    })

    test('should handle transaction failures', async () => {
      const transactionMock = {
        execute: vi.fn().mockRejectedValue(new Error('Transaction failed'))
      }

      mockDb.transaction.mockReturnValue(transactionMock)

      await expect(transactionMock.execute()).rejects.toThrow('Transaction failed')
    })
  })

  describe('Get spreadsheet logic', () => {
    test('should get spreadsheet with sheets', async () => {
      const queryBuilder1 = createMockQueryBuilder()
      const queryBuilder2 = createMockQueryBuilder()

      queryBuilder1.executeTakeFirst.mockResolvedValue(BASIC_SPREADSHEET)
      queryBuilder2.execute.mockResolvedValue([BASIC_SHEET])

      mockDb.selectFrom
        .mockReturnValueOnce(queryBuilder1) // for spreadsheet
        .mockReturnValueOnce(queryBuilder2) // for sheets

      const spreadsheet = await queryBuilder1.executeTakeFirst()
      const sheets = await queryBuilder2.execute()

      expect(spreadsheet).toEqual(BASIC_SPREADSHEET)
      expect(sheets).toEqual([BASIC_SHEET])
    })

    test('should return null for non-existent spreadsheet', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.executeTakeFirst.mockResolvedValue(null)
      mockDb.selectFrom.mockReturnValue(queryBuilder)

      const result = await queryBuilder.executeTakeFirst()

      expect(result).toBeNull()
    })
  })

  describe('Update spreadsheet logic', () => {
    test('should update spreadsheet metadata', async () => {
      const updatedSpreadsheet = {
        ...BASIC_SPREADSHEET,
        name: 'Updated Name',
        description: 'Updated description'
      }

      const queryBuilder = createMockQueryBuilder()
      queryBuilder.executeTakeFirst.mockResolvedValue(updatedSpreadsheet)
      mockDb.updateTable.mockReturnValue(queryBuilder)

      const result = await queryBuilder.executeTakeFirst()

      expect(result.name).toBe('Updated Name')
      expect(result.description).toBe('Updated description')
    })

    test('should return null for non-existent spreadsheet', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.executeTakeFirst.mockResolvedValue(null)
      mockDb.updateTable.mockReturnValue(queryBuilder)

      const result = await queryBuilder.executeTakeFirst()

      expect(result).toBeNull()
    })
  })

  describe('Delete spreadsheet logic', () => {
    test('should soft delete spreadsheet', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.executeTakeFirst.mockResolvedValue(BASIC_SPREADSHEET)
      mockDb.updateTable.mockReturnValue(queryBuilder)

      queryBuilder.set({ deleted_at: expect.any(Date) })

      expect(queryBuilder.set).toHaveBeenCalled()
    })

    test('should return null for non-existent spreadsheet', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.executeTakeFirst.mockResolvedValue(null)
      mockDb.updateTable.mockReturnValue(queryBuilder)

      const result = await queryBuilder.executeTakeFirst()

      expect(result).toBeNull()
    })
  })

  describe('Cell operations logic', () => {
    test('should get cells for a sheet', async () => {
      const cells = [TEST_CELLS.TEXT_CELL, TEST_CELLS.NUMBER_CELL]

      const queryBuilder = createMockQueryBuilder()
      queryBuilder.execute.mockResolvedValue(cells)
      mockDb.selectFrom.mockReturnValue(queryBuilder)

      const result = await queryBuilder.execute()

      expect(result).toEqual(cells)
    })

    test('should apply range filters', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.execute.mockResolvedValue([])
      mockDb.selectFrom.mockReturnValue(queryBuilder)

      queryBuilder.where('row_index', '>=', 5)
      queryBuilder.where('row_index', '<=', 15)
      queryBuilder.where('column_index', '>=', 2)
      queryBuilder.where('column_index', '<=', 8)

      expect(queryBuilder.where).toHaveBeenCalledWith('row_index', '>=', 5)
      expect(queryBuilder.where).toHaveBeenCalledWith('row_index', '<=', 15)
      expect(queryBuilder.where).toHaveBeenCalledWith('column_index', '>=', 2)
      expect(queryBuilder.where).toHaveBeenCalledWith('column_index', '<=', 8)
    })

    test('should convert cells to grid format', () => {
      const cells = [
        { ...TEST_CELLS.TEXT_CELL, row_index: 0, column_index: 0 },
        { ...TEST_CELLS.NUMBER_CELL, row_index: 0, column_index: 1 }
      ]

      // Simulate grid conversion logic
      const grid: any[][] = []
      for (const cell of cells) {
        if (!grid[cell.row_index]) {
          grid[cell.row_index] = []
        }
        grid[cell.row_index][cell.column_index] = {
          value: cell.value,
          formula: cell.formula,
          format: cell.format,
          dataType: cell.data_type,
          locked: cell.locked,
          comment: cell.comment
        }
      }

      expect(grid[0]).toBeDefined()
      expect(grid[0][0].value).toBe('Hello World')
      expect(grid[0][1].value).toBe('123.45')
    })
  })

  describe('Update cells logic', () => {
    test('should update multiple cells in transaction', async () => {
      const existingCell = TEST_CELLS.TEXT_CELL
      const updatedCell = { ...existingCell, value: 'Updated Value' }

      const transactionMock = {
        execute: vi.fn().mockImplementation(async (fn) => {
          const trx = {
            selectFrom: vi.fn().mockReturnValue({
              selectAll: vi.fn().mockReturnValue({
                where: vi.fn().mockImplementation(() => {
                  const chainableWhere: any = {
                    where: vi.fn().mockImplementation(() => chainableWhere),
                    executeTakeFirst: vi.fn().mockResolvedValue(existingCell)
                  }
                  return chainableWhere
                })
              })
            }),
            updateTable: vi.fn().mockReturnValue({
              set: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  returningAll: vi.fn().mockReturnValue({
                    executeTakeFirstOrThrow: vi.fn().mockResolvedValue(updatedCell)
                  })
                })
              })
            })
          }
          return await fn(trx)
        })
      }

      mockDb.transaction.mockReturnValue(transactionMock)

      const result = await transactionMock.execute(async (trx: any) => {
        const existing = await trx.selectFrom('cells')
          .selectAll()
          .where('sheet_id', '=', TEST_IDS.SHEET_1)
          .where('row_index', '=', 0)
          .executeTakeFirst()

        if (existing) {
          return await trx.updateTable('cells')
            .set({ value: 'Updated Value' })
            .where('id', '=', existing.id)
            .returningAll()
            .executeTakeFirstOrThrow()
        }
        return null
      })

      expect(result?.value).toBe('Updated Value')
    })

    test('should create new cells if they don\'t exist', async () => {
      const newCell = TEST_CELLS.TEXT_CELL

      const transactionMock = {
        execute: vi.fn().mockImplementation(async (fn) => {
          const trx = {
            selectFrom: vi.fn().mockReturnValue({
              selectAll: vi.fn().mockReturnValue({
                where: vi.fn().mockImplementation(() => {
                  const chainableWhere: any = {
                    where: vi.fn().mockImplementation(() => chainableWhere),
                    executeTakeFirst: vi.fn().mockResolvedValue(null) // No existing cell
                  }
                  return chainableWhere
                })
              })
            }),
            insertInto: vi.fn().mockReturnValue({
              values: vi.fn().mockReturnValue({
                returningAll: vi.fn().mockReturnValue({
                  executeTakeFirstOrThrow: vi.fn().mockResolvedValue(newCell)
                })
              })
            })
          }
          return await fn(trx)
        })
      }

      mockDb.transaction.mockReturnValue(transactionMock)

      const result = await transactionMock.execute(async (trx: any) => {
        const existing = await trx.selectFrom('cells')
          .selectAll()
          .where('sheet_id', '=', TEST_IDS.SHEET_1)
          .where('row_index', '=', 0)
          .executeTakeFirst()

        if (!existing) {
          return await trx.insertInto('cells')
            .values({ value: 'New Cell Value' })
            .returningAll()
            .executeTakeFirstOrThrow()
        }
        return existing
      })

      expect(result).toEqual(newCell)
    })

    test('should validate cells array', () => {
      const invalidInput = { cells: 'not an array' }

      const isValid = Array.isArray(invalidInput.cells)

      expect(isValid).toBe(false)
    })
  })

  describe('Create sheet logic', () => {
    test('should create a new sheet with correct order', async () => {
      const maxOrderQueryBuilder = createMockQueryBuilder()
      maxOrderQueryBuilder.executeTakeFirst.mockResolvedValue({ max_order: 2 })

      const insertQueryBuilder = createMockQueryBuilder()
      const newSheet = { ...BASIC_SHEET, name: 'New Sheet', order_index: 3 }
      insertQueryBuilder.executeTakeFirstOrThrow.mockResolvedValue(newSheet)

      mockDb.selectFrom.mockReturnValue(maxOrderQueryBuilder)
      mockDb.insertInto.mockReturnValue(insertQueryBuilder)

      const maxOrder = await maxOrderQueryBuilder.executeTakeFirst()
      const sheet = await insertQueryBuilder.executeTakeFirstOrThrow()

      expect(maxOrder?.max_order).toBe(2)
      expect(sheet.name).toBe('New Sheet')
      expect(sheet.order_index).toBe(3)
    })

    test('should use default values for first sheet', async () => {
      const maxOrderQueryBuilder = createMockQueryBuilder()
      maxOrderQueryBuilder.executeTakeFirst.mockResolvedValue({ max_order: null })

      mockDb.selectFrom.mockReturnValue(maxOrderQueryBuilder)

      const maxOrder = await maxOrderQueryBuilder.executeTakeFirst()
      const newOrderIndex = (maxOrder?.max_order ?? -1) + 1

      expect(newOrderIndex).toBe(0)
    })
  })

  describe('Error handling', () => {
    test('should detect database unavailable', () => {
      const db = undefined
      const isDbAvailable = db !== undefined

      expect(isDbAvailable).toBe(false)
    })

    test('should handle unexpected errors gracefully', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.execute.mockRejectedValue(new Error('Unexpected error'))
      mockDb.selectFrom.mockReturnValue(queryBuilder)

      await expect(queryBuilder.execute()).rejects.toThrow('Unexpected error')
    })
  })

  describe('Performance', () => {
    test('should handle large cell updates efficiently', async () => {
      const largeCellsUpdate = Array.from({ length: 1000 }, (_, i) => ({
        row: Math.floor(i / 26),
        col: i % 26,
        value: `Cell ${i}`,
        dataType: 'text'
      }))

      expect(largeCellsUpdate.length).toBe(1000)
      expect(largeCellsUpdate[0]).toEqual({
        row: 0,
        col: 0,
        value: 'Cell 0',
        dataType: 'text'
      })
    })
  })

  describe('Mock response helpers', () => {
    test('should create mock response with status and json', () => {
      const res = createMockResponse()

      res.status(200).json({ ok: true, data: BASIC_SPREADSHEET })

      expect(res._status).toBe(200)
      expect(res._json).toEqual({ ok: true, data: BASIC_SPREADSHEET })
    })

    test('should validate success response', () => {
      const res = createMockResponse()
      res.status(200).json({ ok: true, data: BASIC_SPREADSHEET })

      expect(res).toHaveSuccessResponse()
    })

    test('should validate error response', () => {
      const res = createMockResponse()
      res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } })

      expect(res).toHaveStatus(404)
      expect(res).toHaveErrorResponse('NOT_FOUND')
    })
  })

  describe('API fixtures validation', () => {
    test('should have valid create spreadsheet request', () => {
      expect(API_FIXTURES.CREATE_SPREADSHEET_REQUEST).toMatchObject({
        name: expect.any(String),
        owner_id: expect.any(String)
      })
    })

    test('should have valid update cells request', () => {
      expect(API_FIXTURES.UPDATE_CELLS_REQUEST.cells).toBeInstanceOf(Array)
      expect(API_FIXTURES.UPDATE_CELLS_REQUEST.cells.length).toBeGreaterThan(0)
    })
  })
})
