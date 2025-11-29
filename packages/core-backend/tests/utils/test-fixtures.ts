/**
 * Test fixtures for spreadsheet testing
 * Provides consistent test data across test suites
 */

import { v4 as uuidv4 } from 'uuid'

// Test IDs - consistent across tests
export const TEST_IDS = {
  SPREADSHEET_1: '550e8400-e29b-41d4-a716-446655440001',
  SPREADSHEET_2: '550e8400-e29b-41d4-a716-446655440002',
  SHEET_1: '550e8400-e29b-41d4-a716-446655440011',
  SHEET_2: '550e8400-e29b-41d4-a716-446655440012',
  CELL_A1: '550e8400-e29b-41d4-a716-446655440021',
  CELL_B1: '550e8400-e29b-41d4-a716-446655440022',
  CELL_C1: '550e8400-e29b-41d4-a716-446655440023',
  USER_1: '550e8400-e29b-41d4-a716-446655440031',
  USER_2: '550e8400-e29b-41d4-a716-446655440032',
  WORKSPACE_1: '550e8400-e29b-41d4-a716-446655440041'
}

// Basic spreadsheet fixture
export const BASIC_SPREADSHEET = {
  id: TEST_IDS.SPREADSHEET_1,
  name: 'Basic Test Spreadsheet',
  description: 'A basic spreadsheet for testing',
  owner_id: TEST_IDS.USER_1,
  workspace_id: TEST_IDS.WORKSPACE_1,
  is_template: false,
  template_id: null,
  settings: {
    autoCalculate: true,
    showFormulas: false,
    showGridlines: true
  },
  metadata: {
    lastModified: new Date().toISOString(),
    version: 1
  },
  created_by: TEST_IDS.USER_1,
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
  deleted_at: null
}

// Basic sheet fixture
export const BASIC_SHEET = {
  id: TEST_IDS.SHEET_1,
  spreadsheet_id: TEST_IDS.SPREADSHEET_1,
  name: 'Sheet1',
  order_index: 0,
  row_count: 1000,
  column_count: 26,
  frozen_rows: 0,
  frozen_columns: 0,
  hidden_rows: [],
  hidden_columns: [],
  row_heights: {},
  column_widths: {
    0: 100, // Column A width
    1: 120  // Column B width
  },
  config: {
    showHeaders: true,
    showGridlines: true
  },
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z'
}

// Cell fixtures with different data types
export const TEST_CELLS = {
  TEXT_CELL: {
    id: TEST_IDS.CELL_A1,
    sheet_id: TEST_IDS.SHEET_1,
    row_index: 0,
    column_index: 0,
    cell_ref: 'A1',
    value: 'Hello World',
    display_value: 'Hello World',
    data_type: 'text',
    formula: null,
    formula_result: null,
    format: {
      font: { family: 'Arial', size: 12, bold: false },
      alignment: { horizontal: 'left', vertical: 'middle' }
    },
    validation: null,
    metadata: {},
    locked: false,
    comment: null,
    updated_by: TEST_IDS.USER_1,
    updated_at: '2024-01-01T00:00:00.000Z'
  },

  NUMBER_CELL: {
    id: TEST_IDS.CELL_B1,
    sheet_id: TEST_IDS.SHEET_1,
    row_index: 0,
    column_index: 1,
    cell_ref: 'B1',
    value: '123.45',
    display_value: '123.45',
    data_type: 'number',
    formula: null,
    formula_result: null,
    format: {
      numberFormat: { type: 'number', decimals: 2 }
    },
    validation: null,
    metadata: {},
    locked: false,
    comment: null,
    updated_by: TEST_IDS.USER_1,
    updated_at: '2024-01-01T00:00:00.000Z'
  },

  FORMULA_CELL: {
    id: TEST_IDS.CELL_C1,
    sheet_id: TEST_IDS.SHEET_1,
    row_index: 0,
    column_index: 2,
    cell_ref: 'C1',
    value: '123.45',
    display_value: '123.45',
    data_type: 'number',
    formula: '=B1*2',
    formula_result: { value: 246.9, error: null },
    format: {
      numberFormat: { type: 'number', decimals: 2 }
    },
    validation: null,
    metadata: {},
    locked: false,
    comment: 'Formula that doubles B1',
    updated_by: TEST_IDS.USER_1,
    updated_at: new Date('2024-01-01T00:00:00Z')
  }
}

// Formula fixtures for testing formula engine
export const FORMULA_FIXTURES = {
  SIMPLE_SUM: {
    id: uuidv4(),
    cell_id: TEST_IDS.CELL_C1,
    sheet_id: TEST_IDS.SHEET_1,
    formula_text: '=SUM(A1:A10)',
    parsed_ast: {
      type: 'function',
      name: 'SUM',
      arguments: [{
        type: 'range',
        start: { row: 0, col: 0 },
        end: { row: 9, col: 0 }
      }]
    },
    dependencies: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10'],
    dependents: [],
    calculation_order: 1,
    is_volatile: false,
    last_calculated_at: new Date('2024-01-01T00:00:00Z'),
    error_message: null,
    created_at: new Date('2024-01-01T00:00:00Z'),
    updated_at: new Date('2024-01-01T00:00:00Z')
  },

  VOLATILE_FORMULA: {
    id: uuidv4(),
    cell_id: uuidv4(),
    sheet_id: TEST_IDS.SHEET_1,
    formula_text: '=NOW()',
    parsed_ast: {
      type: 'function',
      name: 'NOW',
      arguments: []
    },
    dependencies: [],
    dependents: [],
    calculation_order: 0,
    is_volatile: true,
    last_calculated_at: new Date('2024-01-01T00:00:00Z'),
    error_message: null,
    created_at: new Date('2024-01-01T00:00:00Z'),
    updated_at: new Date('2024-01-01T00:00:00Z')
  },

  ERROR_FORMULA: {
    id: uuidv4(),
    cell_id: uuidv4(),
    sheet_id: TEST_IDS.SHEET_1,
    formula_text: '=1/0',
    parsed_ast: {
      type: 'operator',
      operator: '/',
      left: { type: 'number', value: 1 },
      right: { type: 'number', value: 0 }
    },
    dependencies: [],
    dependents: [],
    calculation_order: 0,
    is_volatile: false,
    last_calculated_at: new Date('2024-01-01T00:00:00Z'),
    error_message: '#DIV/0!',
    created_at: new Date('2024-01-01T00:00:00Z'),
    updated_at: new Date('2024-01-01T00:00:00Z')
  }
}

// Complex spreadsheet with multiple sheets and formulas
export const COMPLEX_SPREADSHEET = {
  spreadsheet: {
    ...BASIC_SPREADSHEET,
    id: TEST_IDS.SPREADSHEET_2,
    name: 'Complex Test Spreadsheet',
    description: 'A complex spreadsheet with multiple sheets and formulas'
  },
  sheets: [
    {
      ...BASIC_SHEET,
      id: TEST_IDS.SHEET_1,
      spreadsheet_id: TEST_IDS.SPREADSHEET_2,
      name: 'Data'
    },
    {
      ...BASIC_SHEET,
      id: TEST_IDS.SHEET_2,
      spreadsheet_id: TEST_IDS.SPREADSHEET_2,
      name: 'Summary',
      order_index: 1
    }
  ],
  cells: [
    // Data sheet cells
    { ...TEST_CELLS.NUMBER_CELL, id: uuidv4(), sheet_id: TEST_IDS.SHEET_1, row_index: 0, column_index: 0, cell_ref: 'A1', value: '100' },
    { ...TEST_CELLS.NUMBER_CELL, id: uuidv4(), sheet_id: TEST_IDS.SHEET_1, row_index: 1, column_index: 0, cell_ref: 'A2', value: '200' },
    { ...TEST_CELLS.NUMBER_CELL, id: uuidv4(), sheet_id: TEST_IDS.SHEET_1, row_index: 2, column_index: 0, cell_ref: 'A3', value: '300' },

    // Summary sheet cells with cross-sheet formulas
    {
      ...TEST_CELLS.FORMULA_CELL,
      id: uuidv4(),
      sheet_id: TEST_IDS.SHEET_2,
      row_index: 0,
      column_index: 0,
      cell_ref: 'A1',
      formula: '=SUM(Data!A1:A3)',
      value: '600'
    }
  ],
  namedRanges: [
    {
      id: uuidv4(),
      spreadsheet_id: TEST_IDS.SPREADSHEET_2,
      sheet_id: TEST_IDS.SHEET_1,
      name: 'DataRange',
      range: 'A1:A3',
      description: 'Main data range',
      created_by: TEST_IDS.USER_1,
      created_at: new Date('2024-01-01T00:00:00Z')
    }
  ]
}

// Performance test fixtures
export const LARGE_SPREADSHEET = {
  spreadsheet: {
    ...BASIC_SPREADSHEET,
    name: 'Large Performance Test Spreadsheet',
    description: 'A large spreadsheet for performance testing'
  },
  generateCells: (rows: number, cols: number) => {
    const cells = []
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cellRef = `${String.fromCharCode(65 + c)}${r + 1}`
        cells.push({
          id: uuidv4(),
          sheet_id: TEST_IDS.SHEET_1,
          row_index: r,
          column_index: c,
          cell_ref: cellRef,
          value: `${r * cols + c}`,
          display_value: `${r * cols + c}`,
          data_type: 'number',
          formula: null,
          formula_result: null,
          format: {},
          validation: null,
          metadata: {},
          locked: false,
          comment: null,
          updated_by: TEST_IDS.USER_1,
          updated_at: new Date()
        })
      }
    }
    return cells
  }
}

// Edge case fixtures
export const EDGE_CASES = {
  EMPTY_SPREADSHEET: {
    ...BASIC_SPREADSHEET,
    name: '',
    description: null
  },

  DELETED_SPREADSHEET: {
    ...BASIC_SPREADSHEET,
    deleted_at: new Date('2024-01-02T00:00:00Z')
  },

  VERY_LONG_FORMULA: {
    ...FORMULA_FIXTURES.SIMPLE_SUM,
    formula_text: '=SUM(' + Array.from({ length: 100 }, (_, i) => `A${i + 1}`).join(',') + ')'
  },

  CIRCULAR_DEPENDENCY: [
    {
      cell_ref: 'A1',
      formula: '=B1+1'
    },
    {
      cell_ref: 'B1',
      formula: '=A1+1'
    }
  ]
}

// API request/response fixtures
export const API_FIXTURES = {
  CREATE_SPREADSHEET_REQUEST: {
    name: 'New Spreadsheet',
    description: 'Created via API',
    owner_id: TEST_IDS.USER_1,
    workspace_id: TEST_IDS.WORKSPACE_1,
    initial_sheets: [
      { name: 'Sheet1' },
      { name: 'Sheet2' }
    ]
  },

  UPDATE_CELLS_REQUEST: {
    cells: [
      {
        row: 0,
        col: 0,
        value: 'Updated Value',
        dataType: 'text'
      },
      {
        row: 0,
        col: 1,
        value: '42',
        dataType: 'number'
      },
      {
        row: 0,
        col: 2,
        formula: '=B1*2',
        dataType: 'number'
      }
    ]
  },

  ERROR_RESPONSE: {
    ok: false,
    error: {
      code: 'NOT_FOUND',
      message: 'Spreadsheet not found'
    }
  },

  SUCCESS_RESPONSE: {
    ok: true,
    data: BASIC_SPREADSHEET
  }
}