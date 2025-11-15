/**
 * Spreadsheet API Endpoints Tests
 * Tests all spreadsheet CRUD operations and cell management
 */

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createMockDb, createMockQueryBuilder } from '../utils/test-db'
import { BASIC_SPREADSHEET, BASIC_SHEET, TEST_CELLS, TEST_IDS, API_FIXTURES } from '../utils/test-fixtures'

// Mock database BEFORE importing routes
let mockDb: ReturnType<typeof createMockDb>
vi.mock('../../src/db/db', () => ({
  get db() { return mockDb }
}))

// Import routes AFTER mock setup
import spreadsheetRouter from '../../src/routes/spreadsheet'

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

  toHaveStatus(received: any, expectedStatus: number) {
    const pass = received.status === expectedStatus

    return {
      pass,
      message: () => pass
        ? `Expected status not to be ${expectedStatus}`
        : `Expected status ${expectedStatus}, but got ${received.status}`
    }
  }
})

describe('Spreadsheet API Endpoints', () => {
  let app: express.Application

  beforeEach(() => {
    // Create mock database
    mockDb = createMockDb()

    // Create Express app with router
    app = express()
    app.use(express.json())
    app.use('/api', spreadsheetRouter)
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  describe('GET /api/spreadsheets', () => {
    test('should list all spreadsheets', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.execute.mockResolvedValue([BASIC_SPREADSHEET])
      mockDb.selectFrom.mockReturnValue(queryBuilder)

      const response = await request(app)
        .get('/api/spreadsheets')
        .expect(200)

      expect(response).toHaveSuccessResponse()
      expect(response.body.data).toEqual([BASIC_SPREADSHEET])
      expect(mockDb.selectFrom).toHaveBeenCalledWith('spreadsheets')
    })

    test('should filter by workspace_id', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.execute.mockResolvedValue([BASIC_SPREADSHEET])
      mockDb.selectFrom.mockReturnValue(queryBuilder)

      await request(app)
        .get('/api/spreadsheets')
        .query({ workspace_id: TEST_IDS.WORKSPACE_1 })
        .expect(200)

      expect(queryBuilder.where).toHaveBeenCalledWith('workspace_id', '=', TEST_IDS.WORKSPACE_1)
    })

    test('should filter by owner_id', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.execute.mockResolvedValue([])
      mockDb.selectFrom.mockReturnValue(queryBuilder)

      await request(app)
        .get('/api/spreadsheets')
        .query({ owner_id: TEST_IDS.USER_1 })
        .expect(200)

      expect(queryBuilder.where).toHaveBeenCalledWith('owner_id', '=', TEST_IDS.USER_1)
    })

    test('should filter by is_template', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.execute.mockResolvedValue([])
      mockDb.selectFrom.mockReturnValue(queryBuilder)

      await request(app)
        .get('/api/spreadsheets')
        .query({ is_template: 'true' })
        .expect(200)

      expect(queryBuilder.where).toHaveBeenCalledWith('is_template', '=', true)
    })

    test('should exclude deleted spreadsheets', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.execute.mockResolvedValue([])
      mockDb.selectFrom.mockReturnValue(queryBuilder)

      await request(app)
        .get('/api/spreadsheets')
        .expect(200)

      expect(queryBuilder.where).toHaveBeenCalledWith('deleted_at', 'is', null)
    })

    test('should handle database unavailable', async () => {
      vi.doMock('../../src/db/db', () => ({ db: undefined }))

      const response = await request(app)
        .get('/api/spreadsheets')
        .expect(503)

      expect(response).toHaveErrorResponse('DB_UNAVAILABLE')
    })

    test('should handle database errors', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.execute.mockRejectedValue(new Error('Database connection failed'))
      mockDb.selectFrom.mockReturnValue(queryBuilder)

      const response = await request(app)
        .get('/api/spreadsheets')
        .expect(500)

      expect(response).toHaveErrorResponse('INTERNAL_ERROR')
    })
  })

  describe('POST /api/spreadsheets', () => {
    test('should create a new spreadsheet with default sheet', async () => {
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

      const response = await request(app)
        .post('/api/spreadsheets')
        .send(API_FIXTURES.CREATE_SPREADSHEET_REQUEST)
        .expect(201)

      expect(response).toHaveSuccessResponse()
      expect(response.body.data.spreadsheet).toBeDefined()
      expect(response.body.data.sheets).toHaveLength(2)
      expect(mockDb.transaction).toHaveBeenCalled()
    })

    test('should create spreadsheet with custom name and description', async () => {
      const customSpreadsheet = {
        ...BASIC_SPREADSHEET,
        name: 'Custom Name',
        description: 'Custom description'
      }

      const transactionMock = {
        execute: vi.fn().mockImplementation(async (fn) => {
          return await fn({
            insertInto: vi.fn().mockReturnValue({
              values: vi.fn().mockReturnValue({
                returningAll: vi.fn().mockReturnValue({
                  executeTakeFirstOrThrow: vi.fn().mockResolvedValueOnce(customSpreadsheet)
                    .mockResolvedValueOnce(BASIC_SHEET)
                })
              })
            })
          })
        })
      }

      mockDb.transaction.mockReturnValue(transactionMock)

      const response = await request(app)
        .post('/api/spreadsheets')
        .send({
          name: 'Custom Name',
          description: 'Custom description',
          owner_id: TEST_IDS.USER_1
        })
        .expect(201)

      expect(response).toHaveSuccessResponse()
      expect(response.body.data.spreadsheet.name).toBe('Custom Name')
      expect(response.body.data.spreadsheet.description).toBe('Custom description')
    })

    test('should handle transaction failures', async () => {
      const transactionMock = {
        execute: vi.fn().mockRejectedValue(new Error('Transaction failed'))
      }

      mockDb.transaction.mockReturnValue(transactionMock)

      const response = await request(app)
        .post('/api/spreadsheets')
        .send(API_FIXTURES.CREATE_SPREADSHEET_REQUEST)
        .expect(500)

      expect(response).toHaveErrorResponse('INTERNAL_ERROR')
    })
  })

  describe('GET /api/spreadsheets/:id', () => {
    test('should get spreadsheet with sheets', async () => {
      const queryBuilder1 = createMockQueryBuilder()
      const queryBuilder2 = createMockQueryBuilder()

      queryBuilder1.executeTakeFirst.mockResolvedValue(BASIC_SPREADSHEET)
      queryBuilder2.execute.mockResolvedValue([BASIC_SHEET])

      mockDb.selectFrom
        .mockReturnValueOnce(queryBuilder1) // for spreadsheet
        .mockReturnValueOnce(queryBuilder2) // for sheets

      const response = await request(app)
        .get(`/api/spreadsheets/${TEST_IDS.SPREADSHEET_1}`)
        .expect(200)

      expect(response).toHaveSuccessResponse()
      expect(response.body.data.id).toBe(TEST_IDS.SPREADSHEET_1)
      expect(response.body.data.sheets).toEqual([BASIC_SHEET])
    })

    test('should return 404 for non-existent spreadsheet', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.executeTakeFirst.mockResolvedValue(null)
      mockDb.selectFrom.mockReturnValue(queryBuilder)

      const response = await request(app)
        .get('/api/spreadsheets/non-existent-id')
        .expect(404)

      expect(response).toHaveErrorResponse('NOT_FOUND')
    })

    test('should exclude deleted spreadsheets', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.executeTakeFirst.mockResolvedValue(null)
      mockDb.selectFrom.mockReturnValue(queryBuilder)

      await request(app)
        .get(`/api/spreadsheets/${TEST_IDS.SPREADSHEET_1}`)
        .expect(404)

      expect(queryBuilder.where).toHaveBeenCalledWith('deleted_at', 'is', null)
    })
  })

  describe('PUT /api/spreadsheets/:id', () => {
    test('should update spreadsheet metadata', async () => {
      const updatedSpreadsheet = {
        ...BASIC_SPREADSHEET,
        name: 'Updated Name',
        description: 'Updated description'
      }

      const queryBuilder = createMockQueryBuilder()
      queryBuilder.executeTakeFirst.mockResolvedValue(updatedSpreadsheet)
      mockDb.updateTable.mockReturnValue(queryBuilder)

      const response = await request(app)
        .put(`/api/spreadsheets/${TEST_IDS.SPREADSHEET_1}`)
        .send({
          name: 'Updated Name',
          description: 'Updated description'
        })
        .expect(200)

      expect(response).toHaveSuccessResponse()
      expect(response.body.data.name).toBe('Updated Name')
      expect(response.body.data.description).toBe('Updated description')
    })

    test('should update settings and metadata', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.executeTakeFirst.mockResolvedValue(BASIC_SPREADSHEET)
      mockDb.updateTable.mockReturnValue(queryBuilder)

      const newSettings = { autoCalculate: false }
      const newMetadata = { version: 2 }

      await request(app)
        .put(`/api/spreadsheets/${TEST_IDS.SPREADSHEET_1}`)
        .send({ settings: newSettings, metadata: newMetadata })
        .expect(200)

      expect(queryBuilder.set).toHaveBeenCalledWith(expect.objectContaining({
        settings: newSettings,
        metadata: newMetadata
      }))
    })

    test('should return 404 for non-existent spreadsheet', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.executeTakeFirst.mockResolvedValue(null)
      mockDb.updateTable.mockReturnValue(queryBuilder)

      const response = await request(app)
        .put('/api/spreadsheets/non-existent-id')
        .send({ name: 'New Name' })
        .expect(404)

      expect(response).toHaveErrorResponse('NOT_FOUND')
    })
  })

  describe('DELETE /api/spreadsheets/:id', () => {
    test('should soft delete spreadsheet', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.executeTakeFirst.mockResolvedValue(BASIC_SPREADSHEET)
      mockDb.updateTable.mockReturnValue(queryBuilder)

      const response = await request(app)
        .delete(`/api/spreadsheets/${TEST_IDS.SPREADSHEET_1}`)
        .expect(200)

      expect(response.body.ok).toBe(true)
      expect(response.body.message).toBe('Spreadsheet deleted successfully')
      expect(queryBuilder.set).toHaveBeenCalledWith(expect.objectContaining({
        deleted_at: expect.any(Date)
      }))
    })

    test('should return 404 for non-existent spreadsheet', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.executeTakeFirst.mockResolvedValue(null)
      mockDb.updateTable.mockReturnValue(queryBuilder)

      const response = await request(app)
        .delete('/api/spreadsheets/non-existent-id')
        .expect(404)

      expect(response).toHaveErrorResponse('NOT_FOUND')
    })
  })

  describe('GET /api/spreadsheets/:spreadsheetId/sheets/:sheetId/cells', () => {
    test('should get cells for a sheet', async () => {
      const cells = [TEST_CELLS.TEXT_CELL, TEST_CELLS.NUMBER_CELL]

      const queryBuilder = createMockQueryBuilder()
      queryBuilder.execute.mockResolvedValue(cells)
      mockDb.selectFrom.mockReturnValue(queryBuilder)

      const response = await request(app)
        .get(`/api/spreadsheets/${TEST_IDS.SPREADSHEET_1}/sheets/${TEST_IDS.SHEET_1}/cells`)
        .expect(200)

      expect(response).toHaveSuccessResponse()
      expect(response.body.data.cells).toEqual(cells)
      expect(response.body.data.grid).toBeDefined()
    })

    test('should apply range filters', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.execute.mockResolvedValue([])
      mockDb.selectFrom.mockReturnValue(queryBuilder)

      await request(app)
        .get(`/api/spreadsheets/${TEST_IDS.SPREADSHEET_1}/sheets/${TEST_IDS.SHEET_1}/cells`)
        .query({
          startRow: 5,
          endRow: 15,
          startCol: 2,
          endCol: 8
        })
        .expect(200)

      expect(queryBuilder.where).toHaveBeenCalledWith('row_index', '>=', 5)
      expect(queryBuilder.where).toHaveBeenCalledWith('row_index', '<=', 15)
      expect(queryBuilder.where).toHaveBeenCalledWith('column_index', '>=', 2)
      expect(queryBuilder.where).toHaveBeenCalledWith('column_index', '<=', 8)
    })

    test('should convert cells to grid format', async () => {
      const cells = [
        { ...TEST_CELLS.TEXT_CELL, row_index: 0, column_index: 0 },
        { ...TEST_CELLS.NUMBER_CELL, row_index: 0, column_index: 1 }
      ]

      const queryBuilder = createMockQueryBuilder()
      queryBuilder.execute.mockResolvedValue(cells)
      mockDb.selectFrom.mockReturnValue(queryBuilder)

      const response = await request(app)
        .get(`/api/spreadsheets/${TEST_IDS.SPREADSHEET_1}/sheets/${TEST_IDS.SHEET_1}/cells`)
        .expect(200)

      expect(response.body.data.grid[0]).toBeDefined()
      expect(response.body.data.grid[0][0]).toEqual({
        value: cells[0].value,
        formula: cells[0].formula,
        format: cells[0].format,
        dataType: cells[0].data_type,
        locked: cells[0].locked,
        comment: cells[0].comment
      })
    })
  })

  describe('PUT /api/spreadsheets/:spreadsheetId/sheets/:sheetId/cells', () => {
    test('should update multiple cells', async () => {
      const existingCell = TEST_CELLS.TEXT_CELL
      const updatedCell = { ...existingCell, value: 'Updated Value' }

      const transactionMock = {
        execute: vi.fn().mockImplementation(async (fn) => {
          const trx = {
            selectFrom: vi.fn().mockReturnValue({
              selectAll: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  executeTakeFirst: vi.fn().mockResolvedValue(existingCell)
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
            }),
            insertInto: vi.fn().mockReturnValue({
              values: vi.fn().mockReturnValue({
                execute: vi.fn().mockResolvedValue({})
              })
            })
          }
          return await fn(trx)
        })
      }

      mockDb.transaction.mockReturnValue(transactionMock)

      const response = await request(app)
        .put(`/api/spreadsheets/${TEST_IDS.SPREADSHEET_1}/sheets/${TEST_IDS.SHEET_1}/cells`)
        .send(API_FIXTURES.UPDATE_CELLS_REQUEST)
        .expect(200)

      expect(response).toHaveSuccessResponse()
      expect(mockDb.transaction).toHaveBeenCalled()
    })

    test('should create new cells if they don\'t exist', async () => {
      const newCell = TEST_CELLS.TEXT_CELL

      const transactionMock = {
        execute: vi.fn().mockImplementation(async (fn) => {
          const trx = {
            selectFrom: vi.fn().mockReturnValue({
              selectAll: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  executeTakeFirst: vi.fn().mockResolvedValue(null) // No existing cell
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

      const response = await request(app)
        .put(`/api/spreadsheets/${TEST_IDS.SPREADSHEET_1}/sheets/${TEST_IDS.SHEET_1}/cells`)
        .send({
          cells: [{
            row: 0,
            col: 0,
            value: 'New Cell Value'
          }]
        })
        .expect(200)

      expect(response).toHaveSuccessResponse()
    })

    test('should validate cells array', async () => {
      const response = await request(app)
        .put(`/api/spreadsheets/${TEST_IDS.SPREADSHEET_1}/sheets/${TEST_IDS.SHEET_1}/cells`)
        .send({ cells: 'not an array' })
        .expect(400)

      expect(response).toHaveErrorResponse('INVALID_INPUT')
    })

    test('should handle formula cells', async () => {
      // Test formula handling is covered in the formula engine tests
      const transactionMock = {
        execute: vi.fn().mockResolvedValue([])
      }

      mockDb.transaction.mockReturnValue(transactionMock)

      await request(app)
        .put(`/api/spreadsheets/${TEST_IDS.SPREADSHEET_1}/sheets/${TEST_IDS.SHEET_1}/cells`)
        .send({
          cells: [{
            row: 0,
            col: 0,
            formula: '=SUM(A1:A10)'
          }]
        })
        .expect(200)
    })
  })

  describe('POST /api/spreadsheets/:spreadsheetId/sheets', () => {
    test('should create a new sheet', async () => {
      const maxOrderQueryBuilder = createMockQueryBuilder()
      maxOrderQueryBuilder.executeTakeFirst.mockResolvedValue({ max_order: 2 })

      const insertQueryBuilder = createMockQueryBuilder()
      const newSheet = { ...BASIC_SHEET, name: 'New Sheet', order_index: 3 }
      insertQueryBuilder.executeTakeFirstOrThrow.mockResolvedValue(newSheet)

      mockDb.selectFrom.mockReturnValue(maxOrderQueryBuilder)
      mockDb.insertInto.mockReturnValue(insertQueryBuilder)

      const response = await request(app)
        .post(`/api/spreadsheets/${TEST_IDS.SPREADSHEET_1}/sheets`)
        .send({ name: 'New Sheet', rowCount: 500, columnCount: 20 })
        .expect(201)

      expect(response).toHaveSuccessResponse()
      expect(response.body.data.name).toBe('New Sheet')
      expect(response.body.data.order_index).toBe(3)
    })

    test('should use default values', async () => {
      const maxOrderQueryBuilder = createMockQueryBuilder()
      maxOrderQueryBuilder.executeTakeFirst.mockResolvedValue({ max_order: null })

      const insertQueryBuilder = createMockQueryBuilder()
      insertQueryBuilder.executeTakeFirstOrThrow.mockResolvedValue(BASIC_SHEET)

      mockDb.selectFrom.mockReturnValue(maxOrderQueryBuilder)
      mockDb.insertInto.mockReturnValue(insertQueryBuilder)

      await request(app)
        .post(`/api/spreadsheets/${TEST_IDS.SPREADSHEET_1}/sheets`)
        .send({})
        .expect(201)

      // Check that default values were used
      expect(insertQueryBuilder.values).toHaveBeenCalledWith(expect.objectContaining({
        name: 'New Sheet',
        row_count: 1000,
        column_count: 26,
        order_index: 0
      }))
    })
  })

  describe('Error Handling', () => {
    test('should handle database unavailable globally', async () => {
      vi.doMock('../../src/db/db', () => ({ db: undefined }))

      const endpoints = [
        () => request(app).get('/api/spreadsheets'),
        () => request(app).post('/api/spreadsheets').send({}),
        () => request(app).get('/api/spreadsheets/test-id'),
        () => request(app).put('/api/spreadsheets/test-id').send({}),
        () => request(app).delete('/api/spreadsheets/test-id'),
        () => request(app).get('/api/spreadsheets/test-id/sheets/sheet-id/cells'),
        () => request(app).put('/api/spreadsheets/test-id/sheets/sheet-id/cells').send({ cells: [] }),
        () => request(app).post('/api/spreadsheets/test-id/sheets').send({})
      ]

      for (const endpoint of endpoints) {
        const response = await endpoint().expect(503)
        expect(response).toHaveErrorResponse('DB_UNAVAILABLE')
      }
    })

    test('should handle unexpected errors', async () => {
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.execute.mockRejectedValue(new Error('Unexpected error'))
      mockDb.selectFrom.mockReturnValue(queryBuilder)

      const response = await request(app)
        .get('/api/spreadsheets')
        .expect(500)

      expect(response).toHaveErrorResponse('INTERNAL_ERROR')
    })
  })

  describe('Performance', () => {
    test('should handle large cell updates efficiently', async () => {
      const largeCellsUpdate = {
        cells: Array.from({ length: 1000 }, (_, i) => ({
          row: Math.floor(i / 26),
          col: i % 26,
          value: `Cell ${i}`,
          dataType: 'text'
        }))
      }

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
                  executeTakeFirstOrThrow: vi.fn().mockResolvedValue(TEST_CELLS.TEXT_CELL)
                })
              })
            })
          }
          return await fn(trx)
        })
      }

      mockDb.transaction.mockReturnValue(transactionMock)

      const start = Date.now()

      const response = await request(app)
        .put(`/api/spreadsheets/${TEST_IDS.SPREADSHEET_1}/sheets/${TEST_IDS.SHEET_1}/cells`)
        .send(largeCellsUpdate)
        .expect(200)

      const duration = Date.now() - start

      expect(response).toHaveSuccessResponse()
      expect(duration).toBeLessThan(5000) // Should complete within 5 seconds
    })
  })
})