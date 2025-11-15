/**
 * Test database utilities
 * Provides database mocking and test data creation
 */

import { vi, type MockedFunction } from 'vitest'
import type { DB, Database, SpreadsheetsTable, SheetsTable, CellsTable, FormulasTable, CellVersionsTable, NamedRangesTable } from '../../src/db/db'
import { v4 as uuidv4 } from 'uuid'

// Mock database interface
export interface MockDB extends DB {
  selectFrom: MockedFunction<any>
  insertInto: MockedFunction<any>
  updateTable: MockedFunction<any>
  deleteFrom: MockedFunction<any>
  transaction: MockedFunction<any>
  fn: {
    max: MockedFunction<any>
  }
}

// Mock query builder
export function createMockQueryBuilder() {
  const builder = {
    selectAll: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    returningAll: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    execute: vi.fn(),
    executeTakeFirst: vi.fn(),
    executeTakeFirstOrThrow: vi.fn()
  }
  return builder
}

// Create mock database
export function createMockDb(): MockDB {
  const queryBuilder = createMockQueryBuilder()

  return {
    selectFrom: vi.fn().mockReturnValue(queryBuilder),
    insertInto: vi.fn().mockReturnValue(queryBuilder),
    updateTable: vi.fn().mockReturnValue(queryBuilder),
    deleteFrom: vi.fn().mockReturnValue(queryBuilder),
    transaction: vi.fn().mockReturnValue({
      execute: vi.fn()
    }),
    fn: {
      max: vi.fn().mockReturnValue({ as: vi.fn() })
    }
  } as MockDB
}

// Test data generators
export function createTestSpreadsheet(overrides: Partial<SpreadsheetsTable> = {}): SpreadsheetsTable {
  return {
    id: uuidv4(),
    name: 'Test Spreadsheet',
    description: 'A test spreadsheet',
    owner_id: uuidv4(),
    workspace_id: uuidv4(),
    is_template: false,
    template_id: null,
    settings: {},
    metadata: {},
    created_by: uuidv4(),
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides
  }
}

export function createTestSheet(spreadsheetId: string, overrides: Partial<SheetsTable> = {}): SheetsTable {
  return {
    id: uuidv4(),
    spreadsheet_id: spreadsheetId,
    name: 'Sheet1',
    order_index: 0,
    row_count: 1000,
    column_count: 26,
    frozen_rows: 0,
    frozen_columns: 0,
    hidden_rows: [],
    hidden_columns: [],
    row_heights: {},
    column_widths: {},
    config: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides
  }
}

export function createTestCell(sheetId: string, row: number, col: number, overrides: Partial<CellsTable> = {}): CellsTable {
  const cellRef = `${String.fromCharCode(65 + col)}${row + 1}`

  return {
    id: uuidv4(),
    sheet_id: sheetId,
    row_index: row,
    column_index: col,
    cell_ref: cellRef,
    value: null,
    display_value: null,
    data_type: 'text',
    formula: null,
    formula_result: null,
    format: {},
    validation: null,
    metadata: {},
    locked: false,
    comment: null,
    updated_by: null,
    updated_at: new Date(),
    ...overrides
  }
}

export function createTestFormula(cellId: string, sheetId: string, overrides: Partial<FormulasTable> = {}): FormulasTable {
  return {
    id: uuidv4(),
    cell_id: cellId,
    sheet_id: sheetId,
    formula_text: '=SUM(A1:A10)',
    parsed_ast: null,
    dependencies: ['A1', 'A2', 'A3'],
    dependents: [],
    calculation_order: null,
    is_volatile: false,
    last_calculated_at: null,
    error_message: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides
  }
}

export function createTestCellVersion(cellId: string, sheetId: string, overrides: Partial<CellVersionsTable> = {}): CellVersionsTable {
  return {
    id: uuidv4(),
    cell_id: cellId,
    sheet_id: sheetId,
    version_number: 1,
    value: 'old value',
    formula: null,
    format: {},
    changed_by: uuidv4(),
    change_type: 'update',
    change_summary: 'Value changed',
    created_at: new Date(),
    ...overrides
  }
}

export function createTestNamedRange(spreadsheetId: string, overrides: Partial<NamedRangesTable> = {}): NamedRangesTable {
  return {
    id: uuidv4(),
    spreadsheet_id: spreadsheetId,
    sheet_id: null,
    name: 'TestRange',
    range: 'A1:B10',
    description: 'A test range',
    created_by: uuidv4(),
    created_at: new Date(),
    ...overrides
  }
}

// Custom matchers for spreadsheet testing
export const spreadsheetMatchers = {
  toBeValidCellRef: (received: string) => {
    const cellRefPattern = /^[A-Z]+\d+$/
    const pass = cellRefPattern.test(received)

    return {
      pass,
      message: () => pass
        ? `Expected ${received} not to be a valid cell reference`
        : `Expected ${received} to be a valid cell reference (e.g., A1, B2, AA10)`
    }
  },

  toBeValidFormula: (received: string) => {
    const pass = received.startsWith('=') && received.length > 1

    return {
      pass,
      message: () => pass
        ? `Expected ${received} not to be a valid formula`
        : `Expected ${received} to be a valid formula (must start with =)`
    }
  },

  toHaveValidSpreadsheetStructure: (received: any) => {
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
}

// Performance testing utilities
export class PerformanceTracker {
  private measurements: Map<string, number[]> = new Map()

  start(label: string): () => void {
    const startTime = performance.now()

    return () => {
      const endTime = performance.now()
      const duration = endTime - startTime

      if (!this.measurements.has(label)) {
        this.measurements.set(label, [])
      }

      this.measurements.get(label)!.push(duration)
    }
  }

  getStats(label: string) {
    const times = this.measurements.get(label) || []
    if (times.length === 0) return null

    const sorted = [...times].sort((a, b) => a - b)
    const avg = times.reduce((a, b) => a + b, 0) / times.length
    const min = sorted[0]
    const max = sorted[sorted.length - 1]
    const p50 = sorted[Math.floor(sorted.length * 0.5)]
    const p95 = sorted[Math.floor(sorted.length * 0.95)]
    const p99 = sorted[Math.floor(sorted.length * 0.99)]

    return {
      count: times.length,
      min,
      max,
      avg,
      p50,
      p95,
      p99
    }
  }

  clear(): void {
    this.measurements.clear()
  }
}

// Large dataset generators for performance testing
export function generateLargeDataset(rows: number, cols: number) {
  const cells: Array<{ row: number; col: number; value: any; formula?: string }> = []

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const value = Math.random() * 1000
      cells.push({
        row,
        col,
        value: value.toFixed(2),
        ...(Math.random() < 0.1 && { formula: `=SUM(A${row + 1}:${String.fromCharCode(65 + col - 1)}${row + 1})` })
      })
    }
  }

  return cells
}

export function generateFormulaChain(length: number) {
  const formulas: Array<{ cell: string; formula: string }> = []

  for (let i = 0; i < length; i++) {
    const cell = `A${i + 1}`
    const formula = i === 0 ? '=1' : `=A${i} + 1`
    formulas.push({ cell, formula })
  }

  return formulas
}