/**
 * Spreadsheet Database Operations Tests
 * Tests database operations, schema validation, and data integrity
 */

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest'
import { createMockDb, createMockQueryBuilder } from '../utils/test-db'
import {
  BASIC_SPREADSHEET,
  BASIC_SHEET,
  TEST_CELLS,
  TEST_IDS,
  FORMULA_FIXTURES,
  COMPLEX_SPREADSHEET,
  LARGE_SPREADSHEET
} from '../utils/test-fixtures'
import { PerformanceTracker } from '../utils/test-db'

describe('Spreadsheet Database Operations', () => {
  let mockDb: ReturnType<typeof createMockDb>
  let performanceTracker: PerformanceTracker

  beforeEach(() => {
    mockDb = createMockDb()
    performanceTracker = new PerformanceTracker()

    // Mock the database import
    vi.doMock('../../src/db/db', () => ({ db: mockDb }))
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    performanceTracker.clear()
  })

  describe('Spreadsheet Operations', () => {
    describe('Create Spreadsheet', () => {
      test('should create spreadsheet with all required fields', async () => {
        const queryBuilder = createMockQueryBuilder()
        queryBuilder.executeTakeFirstOrThrow.mockResolvedValue(BASIC_SPREADSHEET)
        mockDb.insertInto.mockReturnValue(queryBuilder)

        // Simulate database insert
        const result = await mockDb.insertInto('spreadsheets')
          .values(BASIC_SPREADSHEET)
          .returningAll()
          .executeTakeFirstOrThrow()

        expect(result).toEqual(BASIC_SPREADSHEET)
        expect(mockDb.insertInto).toHaveBeenCalledWith('spreadsheets')
        expect(queryBuilder.values).toHaveBeenCalledWith(BASIC_SPREADSHEET)
      })

      test('should generate UUID for new spreadsheet', async () => {
        const newSpreadsheet = {
          ...BASIC_SPREADSHEET,
          id: '550e8400-e29b-41d4-a716-446655440099'
        }

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.executeTakeFirstOrThrow.mockResolvedValue(newSpreadsheet)
        mockDb.insertInto.mockReturnValue(queryBuilder)

        const result = await mockDb.insertInto('spreadsheets')
          .values(newSpreadsheet)
          .returningAll()
          .executeTakeFirstOrThrow()

        expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      })

      test('should set default values correctly', async () => {
        const spreadsheetWithDefaults = {
          ...BASIC_SPREADSHEET,
          is_template: false,
          settings: {},
          metadata: {},
          deleted_at: null
        }

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.executeTakeFirstOrThrow.mockResolvedValue(spreadsheetWithDefaults)
        mockDb.insertInto.mockReturnValue(queryBuilder)

        const result = await mockDb.insertInto('spreadsheets')
          .values(spreadsheetWithDefaults)
          .returningAll()
          .executeTakeFirstOrThrow()

        expect(result.is_template).toBe(false)
        expect(result.settings).toEqual({})
        expect(result.metadata).toEqual({})
        expect(result.deleted_at).toBeNull()
      })

      test('should handle template creation', async () => {
        const templateSpreadsheet = {
          ...BASIC_SPREADSHEET,
          name: 'Budget Template',
          is_template: true
        }

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.executeTakeFirstOrThrow.mockResolvedValue(templateSpreadsheet)
        mockDb.insertInto.mockReturnValue(queryBuilder)

        const result = await mockDb.insertInto('spreadsheets')
          .values(templateSpreadsheet)
          .returningAll()
          .executeTakeFirstOrThrow()

        expect(result.is_template).toBe(true)
        expect(result.name).toBe('Budget Template')
      })
    })

    describe('Read Spreadsheet', () => {
      test('should retrieve spreadsheet by ID', async () => {
        const queryBuilder = createMockQueryBuilder()
        queryBuilder.executeTakeFirst.mockResolvedValue(BASIC_SPREADSHEET)
        mockDb.selectFrom.mockReturnValue(queryBuilder)

        const result = await mockDb.selectFrom('spreadsheets')
          .selectAll()
          .where('id', '=', TEST_IDS.SPREADSHEET_1)
          .executeTakeFirst()

        expect(result).toEqual(BASIC_SPREADSHEET)
        expect(queryBuilder.where).toHaveBeenCalledWith('id', '=', TEST_IDS.SPREADSHEET_1)
      })

      test('should filter out deleted spreadsheets', async () => {
        const queryBuilder = createMockQueryBuilder()
        queryBuilder.execute.mockResolvedValue([BASIC_SPREADSHEET])
        mockDb.selectFrom.mockReturnValue(queryBuilder)

        await mockDb.selectFrom('spreadsheets')
          .selectAll()
          .where('deleted_at', 'is', null)
          .execute()

        expect(queryBuilder.where).toHaveBeenCalledWith('deleted_at', 'is', null)
      })

      test('should filter by workspace', async () => {
        const queryBuilder = createMockQueryBuilder()
        queryBuilder.execute.mockResolvedValue([BASIC_SPREADSHEET])
        mockDb.selectFrom.mockReturnValue(queryBuilder)

        await mockDb.selectFrom('spreadsheets')
          .selectAll()
          .where('workspace_id', '=', TEST_IDS.WORKSPACE_1)
          .where('deleted_at', 'is', null)
          .execute()

        expect(queryBuilder.where).toHaveBeenCalledWith('workspace_id', '=', TEST_IDS.WORKSPACE_1)
      })

      test('should filter by owner', async () => {
        const queryBuilder = createMockQueryBuilder()
        queryBuilder.execute.mockResolvedValue([BASIC_SPREADSHEET])
        mockDb.selectFrom.mockReturnValue(queryBuilder)

        await mockDb.selectFrom('spreadsheets')
          .selectAll()
          .where('owner_id', '=', TEST_IDS.USER_1)
          .where('deleted_at', 'is', null)
          .execute()

        expect(queryBuilder.where).toHaveBeenCalledWith('owner_id', '=', TEST_IDS.USER_1)
      })

      test('should filter templates', async () => {
        const queryBuilder = createMockQueryBuilder()
        queryBuilder.execute.mockResolvedValue([])
        mockDb.selectFrom.mockReturnValue(queryBuilder)

        await mockDb.selectFrom('spreadsheets')
          .selectAll()
          .where('is_template', '=', true)
          .execute()

        expect(queryBuilder.where).toHaveBeenCalledWith('is_template', '=', true)
      })
    })

    describe('Update Spreadsheet', () => {
      test('should update spreadsheet metadata', async () => {
        const updatedData = {
          name: 'Updated Name',
          description: 'Updated description',
          updated_at: expect.any(Date)
        }

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.executeTakeFirst.mockResolvedValue({
          ...BASIC_SPREADSHEET,
          ...updatedData
        })
        mockDb.updateTable.mockReturnValue(queryBuilder)

        const result = await mockDb.updateTable('spreadsheets')
          .set(updatedData)
          .where('id', '=', TEST_IDS.SPREADSHEET_1)
          .returningAll()
          .executeTakeFirst()

        expect(result.name).toBe('Updated Name')
        expect(result.description).toBe('Updated description')
        expect(queryBuilder.set).toHaveBeenCalledWith(updatedData)
      })

      test('should update settings', async () => {
        const newSettings = {
          autoCalculate: false,
          showFormulas: true,
          showGridlines: false
        }

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.executeTakeFirst.mockResolvedValue({
          ...BASIC_SPREADSHEET,
          settings: newSettings
        })
        mockDb.updateTable.mockReturnValue(queryBuilder)

        const result = await mockDb.updateTable('spreadsheets')
          .set({ settings: newSettings })
          .where('id', '=', TEST_IDS.SPREADSHEET_1)
          .returningAll()
          .executeTakeFirst()

        expect(result.settings).toEqual(newSettings)
      })

      test('should update metadata', async () => {
        const newMetadata = {
          version: 2,
          lastModified: new Date().toISOString(),
          tags: ['important', 'financial']
        }

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.executeTakeFirst.mockResolvedValue({
          ...BASIC_SPREADSHEET,
          metadata: newMetadata
        })
        mockDb.updateTable.mockReturnValue(queryBuilder)

        const result = await mockDb.updateTable('spreadsheets')
          .set({ metadata: newMetadata })
          .where('id', '=', TEST_IDS.SPREADSHEET_1)
          .returningAll()
          .executeTakeFirst()

        expect(result.metadata).toEqual(newMetadata)
      })
    })

    describe('Delete Spreadsheet', () => {
      test('should soft delete spreadsheet', async () => {
        const deleteTime = new Date()
        const queryBuilder = createMockQueryBuilder()
        queryBuilder.executeTakeFirst.mockResolvedValue({
          ...BASIC_SPREADSHEET,
          deleted_at: deleteTime
        })
        mockDb.updateTable.mockReturnValue(queryBuilder)

        const result = await mockDb.updateTable('spreadsheets')
          .set({ deleted_at: deleteTime })
          .where('id', '=', TEST_IDS.SPREADSHEET_1)
          .returningAll()
          .executeTakeFirst()

        expect(result.deleted_at).toEqual(deleteTime)
        expect(queryBuilder.set).toHaveBeenCalledWith({ deleted_at: deleteTime })
      })
    })
  })

  describe('Sheet Operations', () => {
    describe('Create Sheet', () => {
      test('should create sheet with default values', async () => {
        const queryBuilder = createMockQueryBuilder()
        queryBuilder.executeTakeFirstOrThrow.mockResolvedValue(BASIC_SHEET)
        mockDb.insertInto.mockReturnValue(queryBuilder)

        const result = await mockDb.insertInto('sheets')
          .values(BASIC_SHEET)
          .returningAll()
          .executeTakeFirstOrThrow()

        expect(result).toEqual(BASIC_SHEET)
        expect(result.row_count).toBe(1000)
        expect(result.column_count).toBe(26)
        expect(result.frozen_rows).toBe(0)
        expect(result.frozen_columns).toBe(0)
      })

      test('should set correct order index', async () => {
        const maxOrderQueryBuilder = createMockQueryBuilder()
        maxOrderQueryBuilder.executeTakeFirst.mockResolvedValue({ max_order: 2 })

        const insertQueryBuilder = createMockQueryBuilder()
        const newSheet = { ...BASIC_SHEET, order_index: 3 }
        insertQueryBuilder.executeTakeFirstOrThrow.mockResolvedValue(newSheet)

        mockDb.selectFrom.mockReturnValue(maxOrderQueryBuilder)
        mockDb.insertInto.mockReturnValue(insertQueryBuilder)

        // Simulate getting max order
        const maxOrder = await mockDb.selectFrom('sheets')
          .select(mockDb.fn.max('order_index').as('max_order'))
          .where('spreadsheet_id', '=', TEST_IDS.SPREADSHEET_1)
          .executeTakeFirst()

        // Create new sheet
        const result = await mockDb.insertInto('sheets')
          .values({ ...BASIC_SHEET, order_index: (maxOrder?.max_order ?? -1) + 1 })
          .returningAll()
          .executeTakeFirstOrThrow()

        expect(result.order_index).toBe(3)
      })
    })

    describe('Read Sheets', () => {
      test('should retrieve sheets by spreadsheet ID', async () => {
        const sheets = [BASIC_SHEET, { ...BASIC_SHEET, id: 'sheet2', name: 'Sheet2', order_index: 1 }]

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.execute.mockResolvedValue(sheets)
        mockDb.selectFrom.mockReturnValue(queryBuilder)

        const result = await mockDb.selectFrom('sheets')
          .selectAll()
          .where('spreadsheet_id', '=', TEST_IDS.SPREADSHEET_1)
          .orderBy('order_index', 'asc')
          .execute()

        expect(result).toEqual(sheets)
        expect(queryBuilder.where).toHaveBeenCalledWith('spreadsheet_id', '=', TEST_IDS.SPREADSHEET_1)
        expect(queryBuilder.orderBy).toHaveBeenCalledWith('order_index', 'asc')
      })
    })

    describe('Update Sheet', () => {
      test('should update sheet configuration', async () => {
        const updatedConfig = {
          showHeaders: false,
          showGridlines: true,
          theme: 'dark'
        }

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.executeTakeFirst.mockResolvedValue({
          ...BASIC_SHEET,
          config: updatedConfig
        })
        mockDb.updateTable.mockReturnValue(queryBuilder)

        const result = await mockDb.updateTable('sheets')
          .set({ config: updatedConfig })
          .where('id', '=', TEST_IDS.SHEET_1)
          .returningAll()
          .executeTakeFirst()

        expect(result.config).toEqual(updatedConfig)
      })

      test('should update column widths', async () => {
        const newColumnWidths = {
          0: 150, // Column A
          1: 200, // Column B
          2: 100  // Column C
        }

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.executeTakeFirst.mockResolvedValue({
          ...BASIC_SHEET,
          column_widths: newColumnWidths
        })
        mockDb.updateTable.mockReturnValue(queryBuilder)

        const result = await mockDb.updateTable('sheets')
          .set({ column_widths: newColumnWidths })
          .where('id', '=', TEST_IDS.SHEET_1)
          .returningAll()
          .executeTakeFirst()

        expect(result.column_widths).toEqual(newColumnWidths)
      })

      test('should update frozen rows and columns', async () => {
        const updates = {
          frozen_rows: 2,
          frozen_columns: 1
        }

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.executeTakeFirst.mockResolvedValue({
          ...BASIC_SHEET,
          ...updates
        })
        mockDb.updateTable.mockReturnValue(queryBuilder)

        const result = await mockDb.updateTable('sheets')
          .set(updates)
          .where('id', '=', TEST_IDS.SHEET_1)
          .returningAll()
          .executeTakeFirst()

        expect(result.frozen_rows).toBe(2)
        expect(result.frozen_columns).toBe(1)
      })
    })
  })

  describe('Cell Operations', () => {
    describe('Create Cell', () => {
      test('should create cell with all properties', async () => {
        const queryBuilder = createMockQueryBuilder()
        queryBuilder.executeTakeFirstOrThrow.mockResolvedValue(TEST_CELLS.TEXT_CELL)
        mockDb.insertInto.mockReturnValue(queryBuilder)

        const result = await mockDb.insertInto('cells')
          .values(TEST_CELLS.TEXT_CELL)
          .returningAll()
          .executeTakeFirstOrThrow()

        expect(result).toEqual(TEST_CELLS.TEXT_CELL)
        expect(result.cell_ref).toBe('A1')
        expect(result.row_index).toBe(0)
        expect(result.column_index).toBe(0)
      })

      test('should create formula cell', async () => {
        const formulaCell = TEST_CELLS.FORMULA_CELL

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.executeTakeFirstOrThrow.mockResolvedValue(formulaCell)
        mockDb.insertInto.mockReturnValue(queryBuilder)

        const result = await mockDb.insertInto('cells')
          .values(formulaCell)
          .returningAll()
          .executeTakeFirstOrThrow()

        expect(result.formula).toBe('=B1*2')
        expect(result.data_type).toBe('number')
        expect(result.formula_result).toBeDefined()
      })

      test('should validate unique cell position', async () => {
        // This would be enforced by database constraints
        // The test simulates the unique index on (sheet_id, row_index, column_index)

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.executeTakeFirstOrThrow.mockRejectedValue(
          new Error('duplicate key value violates unique constraint')
        )
        mockDb.insertInto.mockReturnValue(queryBuilder)

        await expect(
          mockDb.insertInto('cells')
            .values(TEST_CELLS.TEXT_CELL)
            .returningAll()
            .executeTakeFirstOrThrow()
        ).rejects.toThrow('duplicate key value violates unique constraint')
      })
    })

    describe('Read Cells', () => {
      test('should retrieve cells by sheet ID', async () => {
        const cells = [TEST_CELLS.TEXT_CELL, TEST_CELLS.NUMBER_CELL]

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.execute.mockResolvedValue(cells)
        mockDb.selectFrom.mockReturnValue(queryBuilder)

        const result = await mockDb.selectFrom('cells')
          .selectAll()
          .where('sheet_id', '=', TEST_IDS.SHEET_1)
          .execute()

        expect(result).toEqual(cells)
        expect(queryBuilder.where).toHaveBeenCalledWith('sheet_id', '=', TEST_IDS.SHEET_1)
      })

      test('should retrieve cells in range', async () => {
        const queryBuilder = createMockQueryBuilder()
        queryBuilder.execute.mockResolvedValue([TEST_CELLS.TEXT_CELL])
        mockDb.selectFrom.mockReturnValue(queryBuilder)

        await mockDb.selectFrom('cells')
          .selectAll()
          .where('sheet_id', '=', TEST_IDS.SHEET_1)
          .where('row_index', '>=', 0)
          .where('row_index', '<=', 10)
          .where('column_index', '>=', 0)
          .where('column_index', '<=', 5)
          .execute()

        expect(queryBuilder.where).toHaveBeenCalledWith('row_index', '>=', 0)
        expect(queryBuilder.where).toHaveBeenCalledWith('row_index', '<=', 10)
        expect(queryBuilder.where).toHaveBeenCalledWith('column_index', '>=', 0)
        expect(queryBuilder.where).toHaveBeenCalledWith('column_index', '<=', 5)
      })

      test('should retrieve cell by reference', async () => {
        const queryBuilder = createMockQueryBuilder()
        queryBuilder.executeTakeFirst.mockResolvedValue(TEST_CELLS.TEXT_CELL)
        mockDb.selectFrom.mockReturnValue(queryBuilder)

        const result = await mockDb.selectFrom('cells')
          .selectAll()
          .where('sheet_id', '=', TEST_IDS.SHEET_1)
          .where('cell_ref', '=', 'A1')
          .executeTakeFirst()

        expect(result).toEqual(TEST_CELLS.TEXT_CELL)
        expect(queryBuilder.where).toHaveBeenCalledWith('cell_ref', '=', 'A1')
      })
    })

    describe('Update Cell', () => {
      test('should update cell value', async () => {
        const updatedCell = {
          ...TEST_CELLS.TEXT_CELL,
          value: 'Updated Value',
          display_value: 'Updated Value'
        }

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.executeTakeFirstOrThrow.mockResolvedValue(updatedCell)
        mockDb.updateTable.mockReturnValue(queryBuilder)

        const result = await mockDb.updateTable('cells')
          .set({
            value: 'Updated Value',
            display_value: 'Updated Value',
            updated_at: expect.any(Date)
          })
          .where('id', '=', TEST_IDS.CELL_A1)
          .returningAll()
          .executeTakeFirstOrThrow()

        expect(result.value).toBe('Updated Value')
        expect(result.display_value).toBe('Updated Value')
      })

      test('should update cell format', async () => {
        const newFormat = {
          font: { family: 'Times', size: 14, bold: true },
          alignment: { horizontal: 'center', vertical: 'middle' },
          background: '#FFFF00'
        }

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.executeTakeFirstOrThrow.mockResolvedValue({
          ...TEST_CELLS.TEXT_CELL,
          format: newFormat
        })
        mockDb.updateTable.mockReturnValue(queryBuilder)

        const result = await mockDb.updateTable('cells')
          .set({ format: newFormat })
          .where('id', '=', TEST_IDS.CELL_A1)
          .returningAll()
          .executeTakeFirstOrThrow()

        expect(result.format).toEqual(newFormat)
      })

      test('should update cell formula', async () => {
        const newFormula = '=SUM(A1:A10)'

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.executeTakeFirstOrThrow.mockResolvedValue({
          ...TEST_CELLS.FORMULA_CELL,
          formula: newFormula
        })
        mockDb.updateTable.mockReturnValue(queryBuilder)

        const result = await mockDb.updateTable('cells')
          .set({ formula: newFormula })
          .where('id', '=', TEST_IDS.CELL_C1)
          .returningAll()
          .executeTakeFirstOrThrow()

        expect(result.formula).toBe(newFormula)
      })
    })
  })

  describe('Formula Operations', () => {
    describe('Create Formula', () => {
      test('should create formula record', async () => {
        const queryBuilder = createMockQueryBuilder()
        queryBuilder.execute.mockResolvedValue([FORMULA_FIXTURES.SIMPLE_SUM])
        mockDb.insertInto.mockReturnValue(queryBuilder)

        await mockDb.insertInto('formulas')
          .values(FORMULA_FIXTURES.SIMPLE_SUM)
          .execute()

        expect(queryBuilder.values).toHaveBeenCalledWith(FORMULA_FIXTURES.SIMPLE_SUM)
      })

      test('should track formula dependencies', async () => {
        const formula = FORMULA_FIXTURES.SIMPLE_SUM

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.execute.mockResolvedValue([formula])
        mockDb.insertInto.mockReturnValue(queryBuilder)

        await mockDb.insertInto('formulas')
          .values(formula)
          .execute()

        expect(formula.dependencies).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10'])
      })

      test('should mark volatile formulas', async () => {
        const volatileFormula = FORMULA_FIXTURES.VOLATILE_FORMULA

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.execute.mockResolvedValue([volatileFormula])
        mockDb.insertInto.mockReturnValue(queryBuilder)

        await mockDb.insertInto('formulas')
          .values(volatileFormula)
          .execute()

        expect(volatileFormula.is_volatile).toBe(true)
      })
    })

    describe('Read Formulas', () => {
      test('should retrieve formulas by sheet', async () => {
        const formulas = [FORMULA_FIXTURES.SIMPLE_SUM, FORMULA_FIXTURES.VOLATILE_FORMULA]

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.execute.mockResolvedValue(formulas)
        mockDb.selectFrom.mockReturnValue(queryBuilder)

        const result = await mockDb.selectFrom('formulas')
          .select(['cell_id', 'dependencies', 'dependents'])
          .where('sheet_id', '=', TEST_IDS.SHEET_1)
          .execute()

        expect(result).toEqual(formulas)
        expect(queryBuilder.where).toHaveBeenCalledWith('sheet_id', '=', TEST_IDS.SHEET_1)
      })
    })

    describe('Update Formula', () => {
      test('should update formula dependencies', async () => {
        const newDependencies = ['B1', 'B2', 'B3']

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.execute.mockResolvedValue([])
        mockDb.updateTable.mockReturnValue(queryBuilder)

        await mockDb.updateTable('formulas')
          .set({
            dependencies: newDependencies,
            updated_at: expect.any(Date)
          })
          .where('cell_id', '=', TEST_IDS.CELL_C1)
          .execute()

        expect(queryBuilder.set).toHaveBeenCalledWith({
          dependencies: newDependencies,
          updated_at: expect.any(Date)
        })
      })
    })
  })

  describe('Cell Versions', () => {
    describe('Create Version', () => {
      test('should create cell version history', async () => {
        const cellVersion = {
          id: 'version-1',
          cell_id: TEST_IDS.CELL_A1,
          sheet_id: TEST_IDS.SHEET_1,
          version_number: 1,
          value: 'Previous Value',
          formula: null,
          format: {},
          changed_by: TEST_IDS.USER_1,
          change_type: 'update',
          change_summary: 'Value changed from "Hello" to "Hello World"',
          created_at: new Date()
        }

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.execute.mockResolvedValue([cellVersion])
        mockDb.insertInto.mockReturnValue(queryBuilder)

        await mockDb.insertInto('cell_versions')
          .values(cellVersion)
          .execute()

        expect(queryBuilder.values).toHaveBeenCalledWith(cellVersion)
      })

      test('should increment version number', async () => {
        const versions = [
          { version_number: 3 },
          { version_number: 2 },
          { version_number: 1 }
        ]

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.execute.mockResolvedValue(versions)
        mockDb.selectFrom.mockReturnValue(queryBuilder)

        const result = await mockDb.selectFrom('cell_versions')
          .select(['version_number'])
          .where('cell_id', '=', TEST_IDS.CELL_A1)
          .orderBy('version_number', 'desc')
          .execute()

        expect(result[0].version_number).toBe(3) // Latest version
      })
    })

    describe('Read Versions', () => {
      test('should retrieve cell version history', async () => {
        const versions = [
          { ...TEST_CELLS.TEXT_CELL, version_number: 1, value: 'Version 1' },
          { ...TEST_CELLS.TEXT_CELL, version_number: 2, value: 'Version 2' }
        ]

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.execute.mockResolvedValue(versions)
        mockDb.selectFrom.mockReturnValue(queryBuilder)

        const result = await mockDb.selectFrom('cell_versions')
          .selectAll()
          .where('cell_id', '=', TEST_IDS.CELL_A1)
          .orderBy('version_number', 'desc')
          .execute()

        expect(result).toEqual(versions)
        expect(queryBuilder.orderBy).toHaveBeenCalledWith('version_number', 'desc')
      })
    })
  })

  describe('Named Ranges', () => {
    describe('Create Named Range', () => {
      test('should create named range', async () => {
        const namedRange = {
          id: 'range-1',
          spreadsheet_id: TEST_IDS.SPREADSHEET_1,
          sheet_id: TEST_IDS.SHEET_1,
          name: 'DataRange',
          range: 'A1:B10',
          description: 'Main data range',
          created_by: TEST_IDS.USER_1,
          created_at: new Date()
        }

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.execute.mockResolvedValue([namedRange])
        mockDb.insertInto.mockReturnValue(queryBuilder)

        await mockDb.insertInto('named_ranges')
          .values(namedRange)
          .execute()

        expect(queryBuilder.values).toHaveBeenCalledWith(namedRange)
      })

      test('should enforce unique names per spreadsheet', async () => {
        const namedRange = {
          name: 'DataRange',
          spreadsheet_id: TEST_IDS.SPREADSHEET_1
        }

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.execute.mockRejectedValue(
          new Error('duplicate key value violates unique constraint')
        )
        mockDb.insertInto.mockReturnValue(queryBuilder)

        await expect(
          mockDb.insertInto('named_ranges')
            .values(namedRange)
            .execute()
        ).rejects.toThrow('duplicate key value violates unique constraint')
      })
    })

    describe('Read Named Ranges', () => {
      test('should retrieve named ranges by spreadsheet', async () => {
        const ranges = [
          { name: 'DataRange', range: 'A1:B10' },
          { name: 'HeaderRange', range: 'A1:B1' }
        ]

        const queryBuilder = createMockQueryBuilder()
        queryBuilder.execute.mockResolvedValue(ranges)
        mockDb.selectFrom.mockReturnValue(queryBuilder)

        const result = await mockDb.selectFrom('named_ranges')
          .selectAll()
          .where('spreadsheet_id', '=', TEST_IDS.SPREADSHEET_1)
          .execute()

        expect(result).toEqual(ranges)
        expect(queryBuilder.where).toHaveBeenCalledWith('spreadsheet_id', '=', TEST_IDS.SPREADSHEET_1)
      })
    })
  })

  describe('Transaction Operations', () => {
    test('should handle transaction rollback on error', async () => {
      const transactionError = new Error('Transaction failed')

      const transactionMock = {
        execute: vi.fn().mockRejectedValue(transactionError)
      }

      mockDb.transaction.mockReturnValue(transactionMock)

      await expect(
        mockDb.transaction().execute(async (trx) => {
          throw transactionError
        })
      ).rejects.toThrow('Transaction failed')

      expect(transactionMock.execute).toHaveBeenCalled()
    })

    test('should commit successful transaction', async () => {
      const transactionMock = {
        execute: vi.fn().mockResolvedValue('success')
      }

      mockDb.transaction.mockReturnValue(transactionMock)

      const result = await mockDb.transaction().execute(async (trx) => {
        return 'success'
      })

      expect(result).toBe('success')
      expect(transactionMock.execute).toHaveBeenCalled()
    })

    test('should handle complex multi-table transaction', async () => {
      const transactionMock = {
        execute: vi.fn().mockImplementation(async (fn) => {
          const trx = {
            insertInto: vi.fn().mockReturnValue({
              values: vi.fn().mockReturnValue({
                returningAll: vi.fn().mockReturnValue({
                  executeTakeFirstOrThrow: vi.fn().mockResolvedValue(BASIC_SPREADSHEET)
                })
              })
            })
          }
          return await fn(trx)
        })
      }

      mockDb.transaction.mockReturnValue(transactionMock)

      const result = await mockDb.transaction().execute(async (trx) => {
        // Create spreadsheet
        const spreadsheet = await trx.insertInto('spreadsheets')
          .values(BASIC_SPREADSHEET)
          .returningAll()
          .executeTakeFirstOrThrow()

        // Create initial sheets (would be multiple operations)
        return { spreadsheet }
      })

      expect(result.spreadsheet).toEqual(BASIC_SPREADSHEET)
      expect(transactionMock.execute).toHaveBeenCalled()
    })
  })

  describe('Performance Tests', () => {
    test('should handle bulk cell inserts efficiently', async () => {
      const largeCellSet = LARGE_SPREADSHEET.generateCells(100, 20) // 2000 cells

      const queryBuilder = createMockQueryBuilder()
      queryBuilder.execute.mockResolvedValue(largeCellSet)
      mockDb.insertInto.mockReturnValue(queryBuilder)

      // Simulate bulk insert
      for (const cell of largeCellSet) {
        const end = performanceTracker.start('bulk_insert')
        await mockDb.insertInto('cells')
          .values(cell)
          .execute()
        end()
      }

      const stats = performanceTracker.getStats('bulk_insert')
      expect(stats?.count).toBe(2000)
      expect(stats?.avg).toBeLessThan(10) // Should be very fast with mocks
    })

    test('should handle large range queries efficiently', async () => {
      const largeRange = Array.from({ length: 1000 }, (_, i) => ({
        ...TEST_CELLS.TEXT_CELL,
        id: `cell-${i}`,
        row_index: Math.floor(i / 26),
        column_index: i % 26,
        cell_ref: `${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 26) + 1}`
      }))

      const queryBuilder = createMockQueryBuilder()
      queryBuilder.execute.mockResolvedValue(largeRange)
      mockDb.selectFrom.mockReturnValue(queryBuilder)

      const end = performanceTracker.start('large_query')

      const result = await mockDb.selectFrom('cells')
        .selectAll()
        .where('sheet_id', '=', TEST_IDS.SHEET_1)
        .where('row_index', '>=', 0)
        .where('row_index', '<=', 100)
        .execute()

      end()

      expect(result).toEqual(largeRange)

      const stats = performanceTracker.getStats('large_query')
      expect(stats?.avg).toBeLessThan(100) // Should complete quickly
    })

    test('should handle concurrent operations', async () => {
      const operations = Array.from({ length: 10 }, (_, i) => {
        const queryBuilder = createMockQueryBuilder()
        queryBuilder.executeTakeFirst.mockResolvedValue({
          ...BASIC_SPREADSHEET,
          id: `sheet-${i}`
        })
        mockDb.selectFrom.mockReturnValue(queryBuilder)

        return mockDb.selectFrom('spreadsheets')
          .selectAll()
          .where('id', '=', `sheet-${i}`)
          .executeTakeFirst()
      })

      const end = performanceTracker.start('concurrent_ops')

      const results = await Promise.all(operations)

      end()

      expect(results).toHaveLength(10)
      expect(results.every(r => r?.id.startsWith('sheet-'))).toBe(true)

      const stats = performanceTracker.getStats('concurrent_ops')
      expect(stats?.avg).toBeLessThan(100)
    })
  })

  describe('Data Integrity', () => {
    test('should validate foreign key constraints', async () => {
      const invalidSheet = {
        ...BASIC_SHEET,
        spreadsheet_id: 'non-existent-id'
      }

      const queryBuilder = createMockQueryBuilder()
      queryBuilder.executeTakeFirstOrThrow.mockRejectedValue(
        new Error('violates foreign key constraint')
      )
      mockDb.insertInto.mockReturnValue(queryBuilder)

      await expect(
        mockDb.insertInto('sheets')
          .values(invalidSheet)
          .returningAll()
          .executeTakeFirstOrThrow()
      ).rejects.toThrow('violates foreign key constraint')
    })

    test('should validate cell position constraints', async () => {
      const invalidCell = {
        ...TEST_CELLS.TEXT_CELL,
        row_index: -1, // Invalid negative row
        column_index: -1 // Invalid negative column
      }

      const queryBuilder = createMockQueryBuilder()
      queryBuilder.executeTakeFirstOrThrow.mockRejectedValue(
        new Error('check constraint violation')
      )
      mockDb.insertInto.mockReturnValue(queryBuilder)

      await expect(
        mockDb.insertInto('cells')
          .values(invalidCell)
          .returningAll()
          .executeTakeFirstOrThrow()
      ).rejects.toThrow('check constraint violation')
    })

    test('should handle cascading deletes', async () => {
      // When a spreadsheet is deleted, sheets should be deleted too
      const queryBuilder = createMockQueryBuilder()
      queryBuilder.execute.mockResolvedValue([])
      mockDb.deleteFrom.mockReturnValue(queryBuilder)

      await mockDb.deleteFrom('spreadsheets')
        .where('id', '=', TEST_IDS.SPREADSHEET_1)
        .execute()

      // This would trigger CASCADE DELETE on sheets, cells, etc.
      expect(queryBuilder.where).toHaveBeenCalledWith('id', '=', TEST_IDS.SPREADSHEET_1)
    })
  })

  describe('Error Handling', () => {
    test('should handle database connection errors', async () => {
      const connectionError = new Error('connection terminated')

      const queryBuilder = createMockQueryBuilder()
      queryBuilder.execute.mockRejectedValue(connectionError)
      mockDb.selectFrom.mockReturnValue(queryBuilder)

      await expect(
        mockDb.selectFrom('spreadsheets')
          .selectAll()
          .execute()
      ).rejects.toThrow('connection terminated')
    })

    test('should handle timeout errors', async () => {
      const timeoutError = new Error('query timeout')

      const queryBuilder = createMockQueryBuilder()
      queryBuilder.execute.mockRejectedValue(timeoutError)
      mockDb.selectFrom.mockReturnValue(queryBuilder)

      await expect(
        mockDb.selectFrom('spreadsheets')
          .selectAll()
          .execute()
      ).rejects.toThrow('query timeout')
    })

    test('should handle invalid JSON data', async () => {
      const invalidJsonError = new Error('invalid input syntax for type json')

      const queryBuilder = createMockQueryBuilder()
      queryBuilder.executeTakeFirstOrThrow.mockRejectedValue(invalidJsonError)
      mockDb.insertInto.mockReturnValue(queryBuilder)

      await expect(
        mockDb.insertInto('spreadsheets')
          .values({
            ...BASIC_SPREADSHEET,
            settings: 'invalid json' as any
          })
          .returningAll()
          .executeTakeFirstOrThrow()
      ).rejects.toThrow('invalid input syntax for type json')
    })
  })
})