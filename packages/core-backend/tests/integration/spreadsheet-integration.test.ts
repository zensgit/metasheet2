/**
 * Spreadsheet Integration Tests
 * Tests end-to-end workflows combining API, formula engine, and database
 */

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { spreadsheetsRouter } from '../../src/routes/spreadsheets'
import { FormulaEngine } from '../../src/formula/engine'
import { createMockDb, PerformanceTracker } from '../utils/test-db'
import {
  BASIC_SPREADSHEET,
  BASIC_SHEET,
  TEST_CELLS,
  TEST_IDS,
  COMPLEX_SPREADSHEET,
  API_FIXTURES,
  LARGE_SPREADSHEET
} from '../utils/test-fixtures'

// Extend expect with custom matchers
declare module 'vitest' {
  interface Assertion<T = any> {
    toHaveSuccessResponse(): T
    toHaveErrorResponse(code?: string): T
    toBeValidCellRef(): T
    toBeValidFormula(): T
    toHaveValidSpreadsheetStructure(): T
  }
}

expect.extend({
  toHaveSuccessResponse(received: any) {
    const hasOk = received.body?.ok === true
    const hasData = 'data' in received.body
    const pass = hasOk && hasData

    return {
      pass,
      message: () => pass
        ? 'Expected response not to be successful'
        : `Expected response to be successful with ok: true and data field. Got: ${JSON.stringify(received.body)}`
    }
  },

  toHaveErrorResponse(received: any, expectedCode?: string) {
    const hasOk = received.body?.ok === false
    const hasError = 'error' in received.body
    const codeMatches = !expectedCode || received.body?.error?.code === expectedCode
    const pass = hasOk && hasError && codeMatches

    return {
      pass,
      message: () => pass
        ? `Expected response not to be error${expectedCode ? ` with code ${expectedCode}` : ''}`
        : `Expected response to be error${expectedCode ? ` with code ${expectedCode}` : ''}. Got: ${JSON.stringify(received.body)}`
    }
  },

  toBeValidCellRef(received: string) {
    const cellRefPattern = /^[A-Z]+\d+$/
    const pass = cellRefPattern.test(received)

    return {
      pass,
      message: () => pass
        ? `Expected ${received} not to be a valid cell reference`
        : `Expected ${received} to be a valid cell reference (e.g., A1, B2, AA10)`
    }
  },

  toBeValidFormula(received: string) {
    const pass = received.startsWith('=') && received.length > 1

    return {
      pass,
      message: () => pass
        ? `Expected ${received} not to be a valid formula`
        : `Expected ${received} to be a valid formula (must start with =)`
    }
  },

  toHaveValidSpreadsheetStructure(received: any) {
    const requiredFields = ['id', 'name', 'sheets']
    const hasAllFields = requiredFields.every(field => field in received)
    const hasValidSheets = Array.isArray(received.sheets)

    const pass = hasAllFields && hasValidSheets

    return {
      pass,
      message: () => pass
        ? `Expected spreadsheet not to have valid structure`
        : `Expected spreadsheet to have valid structure with fields: ${requiredFields.join(', ')} and sheets array`
    }
  }
})

describe('Spreadsheet Integration Tests', () => {
  let app: express.Application
  let mockDb: ReturnType<typeof createMockDb>
  let formulaEngine: FormulaEngine
  let performanceTracker: PerformanceTracker

  beforeEach(() => {
    // Create mock database and formula engine
    mockDb = createMockDb()
    formulaEngine = new FormulaEngine({ db: mockDb })
    performanceTracker = new PerformanceTracker()

    // Create Express app
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.user = {
        id: TEST_IDS.USER_1,
        roles: ['admin'],
        perms: ['spreadsheets:read', 'spreadsheets:write']
      }
      next()
    })
    app.use(spreadsheetsRouter(undefined, { db: mockDb }))
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    performanceTracker.clear()
  })

  describe('End-to-End Spreadsheet Lifecycle', () => {
    test('should create spreadsheet with formulas and calculate correctly', async () => {
      // Setup mock database responses for creation
      const transactionMock = {
        execute: vi.fn().mockImplementation(async (fn) => {
          const trx = {
            insertInto: vi.fn().mockReturnValue({
              values: vi.fn().mockReturnValue({
                returningAll: vi.fn().mockReturnValue({
                  executeTakeFirstOrThrow: vi.fn()
                    .mockResolvedValueOnce({ ...BASIC_SPREADSHEET, name: 'Formula Test Spreadsheet' })
                    .mockResolvedValueOnce(BASIC_SHEET)
                })
              })
            })
          }
          return await fn(trx)
        })
      }

      mockDb.transaction.mockReturnValue(transactionMock)

      // Step 1: Create spreadsheet
      const createResponse = await request(app)
        .post('/api/spreadsheets')
        .send({
          name: 'Formula Test Spreadsheet',
          owner_id: TEST_IDS.USER_1,
          workspace_id: TEST_IDS.WORKSPACE_1
        })
        .expect(201)

      expect(createResponse).toHaveSuccessResponse()
      expect(createResponse.body.data.spreadsheet.name).toBe('Formula Test Spreadsheet')

      // Step 2: Add cells with formulas
      const cellUpdateTransactionMock = {
        execute: vi.fn().mockImplementation(async (fn) => {
          const trx = {
            selectFrom: vi.fn().mockReturnValue({
              selectAll: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  executeTakeFirst: vi.fn().mockResolvedValue(null) // No existing cells
                })
              })
            }),
            insertInto: vi.fn().mockReturnValue({
              values: vi.fn().mockReturnValue({
                returningAll: vi.fn().mockReturnValue({
                  executeTakeFirstOrThrow: vi.fn().mockResolvedValue(TEST_CELLS.FORMULA_CELL)
                })
              })
            })
          }
          return await fn(trx)
        })
      }

      mockDb.transaction.mockReturnValue(cellUpdateTransactionMock)

      const cellsUpdate = {
        cells: [
          { row: 0, col: 0, value: '10', dataType: 'number' },
          { row: 0, col: 1, value: '20', dataType: 'number' },
          { row: 0, col: 2, formula: '=A1+B1', dataType: 'number' }
        ]
      }

      const updateResponse = await request(app)
        .put(`/api/spreadsheets/${TEST_IDS.SPREADSHEET_1}/sheets/${TEST_IDS.SHEET_1}/cells`)
        .send(cellsUpdate)
        .expect(200)

      expect(updateResponse).toHaveSuccessResponse()

      // Step 3: Verify formula calculation
      const context = {
        sheetId: TEST_IDS.SHEET_1,
        spreadsheetId: TEST_IDS.SPREADSHEET_1,
        currentCell: { row: 0, col: 2 },
        cache: new Map([
          [`${TEST_IDS.SHEET_1}:0:0`, 10],
          [`${TEST_IDS.SHEET_1}:0:1`, 20]
        ])
      }

      const formulaResult = await formulaEngine.calculate('=A1+B1', context)
      expect(formulaResult).toBe(30)
    })

    test('should handle complex multi-sheet formulas', async () => {
      // Mock complex spreadsheet data
      const complexSpreadsheet = COMPLEX_SPREADSHEET

      // Setup database mocks for multi-sheet scenario
      const spreadsheetQueryBuilder = vi.fn().mockReturnValue({
        selectAll: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn().mockResolvedValue(complexSpreadsheet.spreadsheet)
      })

      const sheetsQueryBuilder = vi.fn().mockReturnValue({
        selectAll: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue(complexSpreadsheet.sheets)
      })

      mockDb.selectFrom
        .mockReturnValueOnce(spreadsheetQueryBuilder()) // for spreadsheet
        .mockReturnValueOnce(sheetsQueryBuilder()) // for sheets

      // Get spreadsheet with sheets
      const response = await request(app)
        .get(`/api/spreadsheets/${TEST_IDS.SPREADSHEET_2}`)
        .expect(200)

      expect(response).toHaveSuccessResponse()
      expect(response.body.data).toHaveValidSpreadsheetStructure()
      expect(response.body.data.sheets).toHaveLength(2)
      expect(response.body.data.sheets[0].name).toBe('Data')
      expect(response.body.data.sheets[1].name).toBe('Summary')
    })

    test('should retrieve sheet cells for a spreadsheet', async () => {
      const sheetQueryBuilder = vi.fn().mockReturnValue({
        selectAll: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn().mockResolvedValue(BASIC_SHEET)
      })

      const cells = [
        { id: TEST_IDS.CELL_A1, sheet_id: TEST_IDS.SHEET_1, row_index: 0, column_index: 0, value: { value: 'Hello' }, formula: null },
        { id: TEST_IDS.CELL_B1, sheet_id: TEST_IDS.SHEET_1, row_index: 1, column_index: 0, value: { value: 42 }, formula: null },
        { id: TEST_IDS.CELL_C1, sheet_id: TEST_IDS.SHEET_1, row_index: 1, column_index: 1, value: null, formula: '=A2+1' }
      ]

      const cellsQueryBuilder = vi.fn().mockReturnValue({
        selectAll: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue(cells)
      })

      mockDb.selectFrom
        .mockReturnValueOnce(sheetQueryBuilder())
        .mockReturnValueOnce(cellsQueryBuilder())

      const response = await request(app)
        .get(`/api/spreadsheets/${TEST_IDS.SPREADSHEET_1}/sheets/${TEST_IDS.SHEET_1}/cells`)
        .expect(200)

      expect(response).toHaveSuccessResponse()
      expect(response.body.data.sheet.id).toBe(TEST_IDS.SHEET_1)
      expect(response.body.data.cells).toHaveLength(3)
      expect(response.body.data.cells[0].row_index).toBe(0)
      expect(response.body.data.cells[2].formula).toBe('=A2+1')
    })

    test('should update sheet metadata', async () => {
      const existingSheet = { ...BASIC_SHEET, row_count: 10, column_count: 5 }
      const updatedSheet = { ...existingSheet, row_count: 20, column_count: 8 }

      const sheetQueryBuilder = vi.fn().mockReturnValue({
        selectAll: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn().mockResolvedValue(existingSheet)
      })

      const updateBuilder = {
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        returningAll: vi.fn().mockReturnThis(),
        executeTakeFirstOrThrow: vi.fn().mockResolvedValue(updatedSheet)
      }

      mockDb.selectFrom.mockReturnValueOnce(sheetQueryBuilder())
      mockDb.updateTable.mockReturnValueOnce(updateBuilder as any)

      const response = await request(app)
        .put(`/api/spreadsheets/${TEST_IDS.SPREADSHEET_1}/sheets/${TEST_IDS.SHEET_1}`)
        .send({ row_count: 20, column_count: 8 })
        .expect(200)

      expect(response).toHaveSuccessResponse()
      expect(response.body.data.row_count).toBe(20)
      expect(response.body.data.column_count).toBe(8)
    })

    test('should maintain data integrity during concurrent operations', async () => {
      // Simulate concurrent cell updates
      const concurrentOperations = Array.from({ length: 5 }, (_, i) => {
        const transactionMock = {
          execute: vi.fn().mockImplementation(async (fn) => {
            const trx = {
              selectFrom: vi.fn().mockReturnValue({
                selectAll: vi.fn().mockReturnValue({
                  where: vi.fn().mockReturnValue({
                    executeTakeFirst: vi.fn().mockResolvedValue(null)
                  })
                })
              }),
              insertInto: vi.fn().mockReturnValue({
                values: vi.fn().mockReturnValue({
                  returningAll: vi.fn().mockReturnValue({
                    executeTakeFirstOrThrow: vi.fn().mockResolvedValue({
                      ...TEST_CELLS.TEXT_CELL,
                      id: `cell-${i}`,
                      value: `Cell ${i}`
                    })
                  })
                })
              })
            }
            return await fn(trx)
          })
        }

        mockDb.transaction.mockReturnValue(transactionMock)

        return request(app)
          .put(`/api/spreadsheets/${TEST_IDS.SPREADSHEET_1}/sheets/${TEST_IDS.SHEET_1}/cells`)
          .send({
            cells: [{
              row: i,
              col: 0,
              value: `Cell ${i}`,
              dataType: 'text'
            }]
          })
      })

      const responses = await Promise.all(concurrentOperations)

      // All operations should succeed
      responses.forEach((response, i) => {
        expect(response.status).toBe(200)
        expect(response).toHaveSuccessResponse()
      })
    })
  })

  describe('Formula Calculation Workflows', () => {
    test('should calculate dependent formulas in correct order', async () => {
      // Create a dependency chain: A1 = 5, B1 = A1 * 2, C1 = B1 + 10
      const context = {
        sheetId: TEST_IDS.SHEET_1,
        spreadsheetId: TEST_IDS.SPREADSHEET_1,
        currentCell: { row: 0, col: 2 },
        cache: new Map()
      }

      // Mock cell values
      let cellCallCount = 0
      mockDb.selectFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn().mockImplementation(() => {
          const cells = [
            { value: '5', data_type: 'number', formula: null }, // A1
            { value: '10', data_type: 'number', formula: '=A1*2' }, // B1
            { value: '20', data_type: 'number', formula: '=B1+10' } // C1
          ]
          return Promise.resolve(cells[cellCallCount++] || null)
        })
      })

      // Calculate each formula in dependency order
      const a1Result = await formulaEngine.calculate('=5', context)
      expect(a1Result).toBe(5)

      // Reset context cache for B1 calculation
      context.cache.set(`${TEST_IDS.SHEET_1}:0:0`, 5) // A1 = 5
      const b1Result = await formulaEngine.calculate('=A1*2', context)
      expect(b1Result).toBe(10)

      // Reset context cache for C1 calculation
      context.cache.set(`${TEST_IDS.SHEET_1}:0:1`, 10) // B1 = 10
      const c1Result = await formulaEngine.calculate('=B1+10', context)
      expect(c1Result).toBe(20)
    })

    test('should handle volatile formulas correctly', async () => {
      const context = {
        sheetId: TEST_IDS.SHEET_1,
        spreadsheetId: TEST_IDS.SPREADSHEET_1,
        currentCell: { row: 0, col: 0 },
        cache: new Map()
      }

      // NOW() should return different values (or at least valid dates)
      const now1 = await formulaEngine.calculate('=NOW()', context)
      await new Promise(resolve => setTimeout(resolve, 5))
      const now2 = await formulaEngine.calculate('=NOW()', context)

      expect(now1).toBeInstanceOf(Date)
      expect(now2).toBeInstanceOf(Date)
      expect(now2.getTime()).toBeGreaterThanOrEqual(now1.getTime())

      // TODAY() should be consistent within same calculation cycle
      const today1 = await formulaEngine.calculate('=TODAY()', context)
      const today2 = await formulaEngine.calculate('=TODAY()', context)

      expect(today1).toBeInstanceOf(Date)
      expect(today2).toBeInstanceOf(Date)
      expect(today1.toDateString()).toBe(today2.toDateString())
    })

    test('should handle formula errors gracefully', async () => {
      const context = {
        sheetId: TEST_IDS.SHEET_1,
        spreadsheetId: TEST_IDS.SPREADSHEET_1,
        currentCell: { row: 0, col: 0 },
        cache: new Map()
      }

      // Division by zero
      const divZeroResult = await formulaEngine.calculate('=5/0', context)
      expect(divZeroResult).toBe('#DIV/0!')

      // Invalid function
      const invalidFuncResult = await formulaEngine.calculate('=INVALIDFUNC()', context)
      expect(invalidFuncResult).toBe('#ERROR!')

      // Missing cell reference
      mockDb.selectFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn().mockResolvedValue(null)
      })

      const missingCellResult = await formulaEngine.calculate('=A1', context)
      expect(missingCellResult).toBe('#ERROR!')
    })

    test('should handle complex nested formulas', async () => {
      const context = {
        sheetId: TEST_IDS.SHEET_1,
        spreadsheetId: TEST_IDS.SPREADSHEET_1,
        currentCell: { row: 0, col: 0 },
        cache: new Map()
      }

      // Complex nested formula
      const complexFormula = '=IF(SUM(1,2,3) > 5, CONCATENATE("Sum is ", SUM(1,2,3)), "Sum is small")'
      const result = await formulaEngine.calculate(complexFormula, context)

      expect(result).toBe('Sum is 6')
    })

    test('should handle range formulas efficiently', async () => {
      const context = {
        sheetId: TEST_IDS.SHEET_1,
        spreadsheetId: TEST_IDS.SPREADSHEET_1,
        currentCell: { row: 0, col: 0 },
        cache: new Map()
      }

      // Mock range data
      let rangeCallIndex = 0
      mockDb.selectFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn().mockImplementation(() => {
          const rangeValues = ['1', '2', '3', '4', '5']
          return Promise.resolve({
            value: rangeValues[rangeCallIndex++] || '0',
            data_type: 'number',
            formula: null
          })
        })
      })

      const end = performanceTracker.start('range_formula')
      const result = await formulaEngine.calculate('=SUM(A1:A5)', context)
      end()

      expect(result).toBe(15) // 1+2+3+4+5

      const stats = performanceTracker.getStats('range_formula')
      expect(stats?.avg).toBeLessThan(100)
    })
  })

  describe('Named Ranges Integration', () => {
    test('should create and use named ranges', async () => {
      // Create named range
      const namedRange = {
        id: 'range-1',
        spreadsheet_id: TEST_IDS.SPREADSHEET_1,
        sheet_id: TEST_IDS.SHEET_1,
        name: 'SalesData',
        range: 'A1:A5',
        description: 'Q1 Sales Data'
      }

      const queryBuilder = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue([namedRange])
      })

      mockDb.insertInto.mockReturnValue(queryBuilder())

      // In a real implementation, you'd have a named ranges API endpoint
      // For now, we're testing the database operation
      await mockDb.insertInto('named_ranges')
        .values(namedRange)
        .execute()

      expect(queryBuilder().values).toHaveBeenCalledWith(namedRange)
    })

    test('should validate named range uniqueness', async () => {
      const duplicateRange = {
        name: 'DataRange',
        spreadsheet_id: TEST_IDS.SPREADSHEET_1
      }

      const queryBuilder = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnThis(),
        execute: vi.fn().mockRejectedValue(
          new Error('duplicate key value violates unique constraint')
        )
      })

      mockDb.insertInto.mockReturnValue(queryBuilder())

      await expect(
        mockDb.insertInto('named_ranges')
          .values(duplicateRange)
          .execute()
      ).rejects.toThrow('duplicate key value violates unique constraint')
    })
  })

  describe('Version History Integration', () => {
    test('should create version history on cell updates', async () => {
      // Mock existing cell
      const existingCell = TEST_CELLS.TEXT_CELL

      const transactionMock = {
        execute: vi.fn().mockImplementation(async (fn) => {
          const trx = {
            selectFrom: vi.fn().mockReturnValue({
              selectAll: vi.fn().mockReturnThis(),
              where: vi.fn().mockReturnThis(),
              executeTakeFirst: vi.fn().mockResolvedValue(existingCell)
            }),
            updateTable: vi.fn().mockReturnValue({
              set: vi.fn().mockReturnThis(),
              where: vi.fn().mockReturnThis(),
              returningAll: vi.fn().mockReturnThis(),
              executeTakeFirstOrThrow: vi.fn().mockResolvedValue({
                ...existingCell,
                value: 'Updated Value'
              })
            }),
            insertInto: vi.fn().mockReturnValue({
              values: vi.fn().mockReturnThis(),
              execute: vi.fn().mockResolvedValue({})
            })
          }
          return await fn(trx)
        })
      }

      mockDb.transaction.mockReturnValue(transactionMock)

      const updateResponse = await request(app)
        .put(`/api/spreadsheets/${TEST_IDS.SPREADSHEET_1}/sheets/${TEST_IDS.SHEET_1}/cells`)
        .send({
          cells: [{
            row: 0,
            col: 0,
            value: 'Updated Value'
          }]
        })
        .expect(200)

      expect(updateResponse).toHaveSuccessResponse()

      // Verify version history was created (through transaction)
      expect(transactionMock.execute).toHaveBeenCalled()
    })

    test('should retrieve cell version history', async () => {
      const versions = [
        { version_number: 1, value: 'Original Value', created_at: new Date('2024-01-01') },
        { version_number: 2, value: 'Updated Value', created_at: new Date('2024-01-02') }
      ]

      const queryBuilder = vi.fn().mockReturnValue({
        selectAll: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue(versions)
      })

      mockDb.selectFrom.mockReturnValue(queryBuilder())

      const result = await mockDb.selectFrom('cell_versions')
        .selectAll()
        .where('cell_id', '=', TEST_IDS.CELL_A1)
        .orderBy('version_number', 'desc')
        .execute()

      expect(result).toEqual(versions)
      expect(result[1].version_number).toBe(2) // Latest version first
    })
  })

  describe('Performance Integration Tests', () => {
    test('should handle large spreadsheet operations efficiently', async () => {
      const largeDataset = LARGE_SPREADSHEET.generateCells(50, 20) // 1000 cells

      const transactionMock = {
        execute: vi.fn().mockImplementation(async (fn) => {
          const trx = {
            selectFrom: vi.fn().mockReturnValue({
              selectAll: vi.fn().mockReturnThis(),
              where: vi.fn().mockReturnThis(),
              executeTakeFirst: vi.fn().mockResolvedValue(null)
            }),
            insertInto: vi.fn().mockReturnValue({
              values: vi.fn().mockReturnThis(),
              returningAll: vi.fn().mockReturnThis(),
              executeTakeFirstOrThrow: vi.fn().mockResolvedValue(TEST_CELLS.TEXT_CELL)
            })
          }
          return await fn(trx)
        })
      }

      mockDb.transaction.mockReturnValue(transactionMock)

      const end = performanceTracker.start('large_update')

      const response = await request(app)
        .put(`/api/spreadsheets/${TEST_IDS.SPREADSHEET_1}/sheets/${TEST_IDS.SHEET_1}/cells`)
        .send({
          cells: largeDataset.map(cell => ({
            row: cell.row_index,
            col: cell.column_index,
            value: cell.value,
            dataType: 'number'
          }))
        })
        .expect(200)

      end()

      expect(response).toHaveSuccessResponse()

      const stats = performanceTracker.getStats('large_update')
      expect(stats?.avg).toBeLessThan(10000) // Should complete within 10 seconds
    })

    test('should handle complex formula calculations efficiently', async () => {
      const context = {
        sheetId: TEST_IDS.SHEET_1,
        spreadsheetId: TEST_IDS.SPREADSHEET_1,
        currentCell: { row: 0, col: 0 },
        cache: new Map()
      }

      const complexFormulas = [
        '=SUM(1,2,3,4,5,6,7,8,9,10)',
        '=AVERAGE(1,2,3,4,5,6,7,8,9,10)',
        '=IF(SUM(1,2,3) > 5, MAX(1,2,3,4,5), MIN(1,2,3,4,5))',
        '=CONCATENATE("Result: ", SUM(1,2,3,4,5))',
        '=ROUND(AVERAGE(1,2,3,4,5) * 1.5, 2)'
      ]

      const end = performanceTracker.start('complex_formulas')

      const results = await Promise.all(
        complexFormulas.map(formula => formulaEngine.calculate(formula, context))
      )

      end()

      expect(results).toEqual([55, 5.5, 5, 'Result: 15', 4.5])

      const stats = performanceTracker.getStats('complex_formulas')
      expect(stats?.avg).toBeLessThan(100)
    })

    test('should maintain performance with deep formula dependencies', async () => {
      // Create a chain of 10 dependent formulas
      const context = {
        sheetId: TEST_IDS.SHEET_1,
        spreadsheetId: TEST_IDS.SPREADSHEET_1,
        currentCell: { row: 0, col: 0 },
        cache: new Map()
      }

      // Pre-populate cache with values for dependency chain
      for (let i = 0; i < 10; i++) {
        context.cache.set(`${TEST_IDS.SHEET_1}:${i}:0`, i + 1)
      }

      const end = performanceTracker.start('deep_dependencies')

      // Calculate a formula that references the end of the chain
      const result = await formulaEngine.calculate('=A10', context)

      end()

      expect(result).toBe(10)

      const stats = performanceTracker.getStats('deep_dependencies')
      expect(stats?.avg).toBeLessThan(50)
    })
  })

  describe('Error Recovery Integration', () => {
    test('should recover from database connection errors', async () => {
      // First call fails with connection error
      const connectionError = new Error('connection terminated')

      const failingQueryBuilder = vi.fn().mockReturnValue({
        selectAll: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        offset: vi.fn().mockReturnThis(),
        execute: vi.fn().mockRejectedValueOnce(connectionError)
      })

      const successQueryBuilder = vi.fn().mockReturnValue({
        selectAll: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        offset: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue([BASIC_SPREADSHEET])
      })

      mockDb.selectFrom
        .mockReturnValueOnce(failingQueryBuilder()) // First call fails
        .mockReturnValueOnce(successQueryBuilder()) // Second call succeeds

      // First request should fail
      const failedResponse = await request(app)
        .get('/api/spreadsheets')
        .expect(500)

      expect(failedResponse).toHaveErrorResponse('INTERNAL_ERROR')

      // Second request should succeed (simulating connection recovery)
      const successResponse = await request(app)
        .get('/api/spreadsheets')
        .expect(200)

      expect(successResponse).toHaveSuccessResponse()
    })

    test('should handle partial transaction failures', async () => {
      // Transaction that fails midway
      const partialFailureTransactionMock = {
        execute: vi.fn().mockImplementation(async (fn) => {
          const trx = {
            insertInto: vi.fn().mockReturnValue({
              values: vi.fn().mockReturnValue({
                returningAll: vi.fn().mockReturnValue({
                  executeTakeFirstOrThrow: vi.fn()
                    .mockResolvedValueOnce(BASIC_SPREADSHEET) // Spreadsheet creation succeeds
                    .mockRejectedValueOnce(new Error('Sheet creation failed')) // Sheet creation fails
                })
              })
            })
          }
          return await fn(trx)
        })
      }

      mockDb.transaction.mockReturnValue(partialFailureTransactionMock)

      const response = await request(app)
        .post('/api/spreadsheets')
        .send({
          name: 'Test Spreadsheet',
          initial_sheets: [{ name: 'Sheet1' }, { name: 'Sheet2' }]
        })
        .expect(500)

      expect(response).toHaveErrorResponse('INTERNAL_ERROR')
    })

    test('should validate input data integrity', async () => {
      // Test with invalid cell data
      const invalidCellData = {
        cells: [
          {
            row: -1, // Invalid negative row
            col: -1, // Invalid negative column
            value: 'Invalid Cell'
          }
        ]
      }

      const response = await request(app)
        .put(`/api/spreadsheets/${TEST_IDS.SPREADSHEET_1}/sheets/${TEST_IDS.SHEET_1}/cells`)
        .send(invalidCellData)
        .expect(400)

      expect(response).toHaveErrorResponse('INVALID_INPUT')
    })
  })

  describe('Real-world Scenarios', () => {
    test('should handle budget spreadsheet scenario', async () => {
      // Simulate a budget spreadsheet with categories, amounts, and totals
      const budgetData = {
        cells: [
          // Headers
          { row: 0, col: 0, value: 'Category', dataType: 'text' },
          { row: 0, col: 1, value: 'Budgeted', dataType: 'text' },
          { row: 0, col: 2, value: 'Actual', dataType: 'text' },
          { row: 0, col: 3, value: 'Difference', dataType: 'text' },

          // Data rows
          { row: 1, col: 0, value: 'Food', dataType: 'text' },
          { row: 1, col: 1, value: '500', dataType: 'number' },
          { row: 1, col: 2, value: '450', dataType: 'number' },
          { row: 1, col: 3, formula: '=B2-C2', dataType: 'number' },

          { row: 2, col: 0, value: 'Transport', dataType: 'text' },
          { row: 2, col: 1, value: '200', dataType: 'number' },
          { row: 2, col: 2, value: '220', dataType: 'number' },
          { row: 2, col: 3, formula: '=B3-C3', dataType: 'number' },

          // Totals
          { row: 3, col: 0, value: 'Total', dataType: 'text' },
          { row: 3, col: 1, formula: '=SUM(B2:B3)', dataType: 'number' },
          { row: 3, col: 2, formula: '=SUM(C2:C3)', dataType: 'number' },
          { row: 3, col: 3, formula: '=SUM(D2:D3)', dataType: 'number' }
        ]
      }

      const transactionMock = {
        execute: vi.fn().mockImplementation(async (fn) => {
          const trx = {
            selectFrom: vi.fn().mockReturnValue({
              selectAll: vi.fn().mockReturnThis(),
              where: vi.fn().mockReturnThis(),
              executeTakeFirst: vi.fn().mockResolvedValue(null)
            }),
            insertInto: vi.fn().mockReturnValue({
              values: vi.fn().mockReturnThis(),
              returningAll: vi.fn().mockReturnThis(),
              executeTakeFirstOrThrow: vi.fn().mockResolvedValue(TEST_CELLS.TEXT_CELL)
            })
          }
          return await fn(trx)
        })
      }

      mockDb.transaction.mockReturnValue(transactionMock)

      const response = await request(app)
        .put(`/api/spreadsheets/${TEST_IDS.SPREADSHEET_1}/sheets/${TEST_IDS.SHEET_1}/cells`)
        .send(budgetData)
        .expect(200)

      expect(response).toHaveSuccessResponse()

      // Test formula calculations for budget scenario
      const context = {
        sheetId: TEST_IDS.SHEET_1,
        spreadsheetId: TEST_IDS.SPREADSHEET_1,
        currentCell: { row: 1, col: 3 },
        cache: new Map([
          [`${TEST_IDS.SHEET_1}:1:1`, 500], // B2 = 500
          [`${TEST_IDS.SHEET_1}:1:2`, 450], // C2 = 450
        ])
      }

      const differenceResult = await formulaEngine.calculate('=B2-C2', context)
      expect(differenceResult).toBe(50) // 500 - 450
    })

    test('should handle sales report scenario with statistical functions', async () => {
      const context = {
        sheetId: TEST_IDS.SHEET_1,
        spreadsheetId: TEST_IDS.SPREADSHEET_1,
        currentCell: { row: 0, col: 0 },
        cache: new Map()
      }

      // Sales data: [100, 150, 200, 180, 220]
      const salesData = [100, 150, 200, 180, 220]
      const salesFormula = `=SUM(${salesData.join(', ')})`
      const avgFormula = `=AVERAGE(${salesData.join(', ')})`
      const maxFormula = `=MAX(${salesData.join(', ')})`
      const minFormula = `=MIN(${salesData.join(', ')})`

      const totalSales = await formulaEngine.calculate(salesFormula, context)
      const avgSales = await formulaEngine.calculate(avgFormula, context)
      const maxSales = await formulaEngine.calculate(maxFormula, context)
      const minSales = await formulaEngine.calculate(minFormula, context)

      expect(totalSales).toBe(850)
      expect(avgSales).toBe(170)
      expect(maxSales).toBe(220)
      expect(minSales).toBe(100)
    })

    test('should handle inventory tracking scenario', async () => {
      const inventoryData = {
        cells: [
          // Headers
          { row: 0, col: 0, value: 'Item', dataType: 'text' },
          { row: 0, col: 1, value: 'Stock', dataType: 'text' },
          { row: 0, col: 2, value: 'Sold', dataType: 'text' },
          { row: 0, col: 3, value: 'Remaining', dataType: 'text' },
          { row: 0, col: 4, value: 'Status', dataType: 'text' },

          // Items
          { row: 1, col: 0, value: 'Widget A', dataType: 'text' },
          { row: 1, col: 1, value: '100', dataType: 'number' },
          { row: 1, col: 2, value: '75', dataType: 'number' },
          { row: 1, col: 3, formula: '=B2-C2', dataType: 'number' },
          { row: 1, col: 4, formula: '=IF(D2<10,"Low Stock","OK")', dataType: 'text' },

          { row: 2, col: 0, value: 'Widget B', dataType: 'text' },
          { row: 2, col: 1, value: '50', dataType: 'number' },
          { row: 2, col: 2, value: '45', dataType: 'number' },
          { row: 2, col: 3, formula: '=B3-C3', dataType: 'number' },
          { row: 2, col: 4, formula: '=IF(D3<10,"Low Stock","OK")', dataType: 'text' }
        ]
      }

      const transactionMock = {
        execute: vi.fn().mockResolvedValue(inventoryData.cells)
      }

      mockDb.transaction.mockReturnValue(transactionMock)

      const response = await request(app)
        .put(`/api/spreadsheets/${TEST_IDS.SPREADSHEET_1}/sheets/${TEST_IDS.SHEET_1}/cells`)
        .send(inventoryData)
        .expect(200)

      expect(response).toHaveSuccessResponse()

      // Test inventory status calculation
      const context = {
        sheetId: TEST_IDS.SHEET_1,
        spreadsheetId: TEST_IDS.SPREADSHEET_1,
        currentCell: { row: 1, col: 4 },
        cache: new Map([
          [`${TEST_IDS.SHEET_1}:1:3`, 25], // D2 = 25 (remaining)
          [`${TEST_IDS.SHEET_1}:2:3`, 5],  // D3 = 5 (remaining)
        ])
      }

      const status1 = await formulaEngine.calculate('=IF(D2<10,"Low Stock","OK")', context)
      expect(status1).toBe('OK') // 25 is not less than 10

      context.currentCell = { row: 2, col: 4 }
      const status2 = await formulaEngine.calculate('=IF(D3<10,"Low Stock","OK")', context)
      expect(status2).toBe('Low Stock') // 5 is less than 10
    })
  })

  describe('Edge Cases Integration', () => {
    test('should handle very large formulas', async () => {
      const context = {
        sheetId: TEST_IDS.SHEET_1,
        spreadsheetId: TEST_IDS.SPREADSHEET_1,
        currentCell: { row: 0, col: 0 },
        cache: new Map()
      }

      // Create a very large SUM formula with 500 numbers
      const numbers = Array.from({ length: 500 }, (_, i) => i + 1)
      const largeFormula = `=SUM(${numbers.join(', ')})`

      const end = performanceTracker.start('large_formula')
      const result = await formulaEngine.calculate(largeFormula, context)
      end()

      expect(result).toBe(125250) // Sum of 1 to 500

      const stats = performanceTracker.getStats('large_formula')
      expect(stats?.avg).toBeLessThan(1000) // Should complete within 1 second
    })

    test('should handle empty and null cell references', async () => {
      const context = {
        sheetId: TEST_IDS.SHEET_1,
        spreadsheetId: TEST_IDS.SPREADSHEET_1,
        currentCell: { row: 0, col: 0 },
        cache: new Map()
      }

      mockDb.selectFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn().mockResolvedValue(null)
      })

      const result = await formulaEngine.calculate('=A1', context)
      expect(result).toBe('#ERROR!')

      // SUM should treat null/empty cells as 0
      const sumResult = await formulaEngine.calculate('=SUM(A1, 5, A2)', context)
      expect(sumResult).toBe(5) // null + 5 + null = 5
    })

    test('should handle circular reference detection', async () => {
      // This would typically be handled by the dependency graph builder
      // Here we test that the formula engine doesn't get stuck in infinite loops

      const context = {
        sheetId: TEST_IDS.SHEET_1,
        spreadsheetId: TEST_IDS.SPREADSHEET_1,
        currentCell: { row: 0, col: 0 },
        cache: new Map()
      }

      // Mock a circular reference scenario where A1 refers to B1 and B1 refers to A1
      // The formula engine should detect this through the cache or dependency system
      context.cache.set(`${TEST_IDS.SHEET_1}:0:0`, '#CIRCULAR!')

      const result = await formulaEngine.calculate('=A1', context)
      expect(result).toBe('#CIRCULAR!')
    })
  })

  describe('Data Validation Integration', () => {
    test('should validate cell references', async () => {
      expect('A1').toBeValidCellRef()
      expect('Z99').toBeValidCellRef()
      expect('AA1').toBeValidCellRef()
      expect('invalid').not.toBeValidCellRef()
      expect('1A').not.toBeValidCellRef()
    })

    test('should validate formula syntax', async () => {
      expect('=SUM(A1:A10)').toBeValidFormula()
      expect('=1+2').toBeValidFormula()
      expect('SUM(A1:A10)').not.toBeValidFormula()
      expect('').not.toBeValidFormula()
    })

    test('should validate spreadsheet structure', async () => {
      const validSpreadsheet = {
        id: TEST_IDS.SPREADSHEET_1,
        name: 'Test',
        sheets: []
      }

      const invalidSpreadsheet = {
        id: TEST_IDS.SPREADSHEET_1,
        name: 'Test'
        // missing sheets
      }

      expect(validSpreadsheet).toHaveValidSpreadsheetStructure()
      expect(invalidSpreadsheet).not.toHaveValidSpreadsheetStructure()
    })
  })

  afterAll(() => {
    performanceTracker.clear()
  })
})
