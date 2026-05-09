import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/db/db', () => ({
  db: undefined,
}))

vi.mock('../../src/core/logger', () => ({
  Logger: class {
    info() {}
    warn() {}
    error() {}
    debug() {}
  },
}))

import { FormulaEngine, type FormulaContext } from '../../src/formula/engine'
import { MultitableFormulaEngine } from '../../src/multitable/formula-engine'
import type { MultitableField } from '../../src/multitable/field-codecs'

function makeContext(): FormulaContext {
  return {
    sheetId: 'test-sheet',
    spreadsheetId: 'test-spreadsheet',
    currentCell: { row: 0, col: 0 },
    cache: new Map(),
  }
}

describe('FormulaEngine - new functions', () => {
  let engine: FormulaEngine

  beforeEach(() => {
    engine = new FormulaEngine({ db: undefined as any })
  })

  describe('SWITCH', () => {
    it('returns matching result for first match', async () => {
      const result = await engine.calculate('=SWITCH(2,1,"one",2,"two",3,"three")', makeContext())
      expect(result).toBe('two')
    })

    it('returns default when no match', async () => {
      const result = await engine.calculate('=SWITCH(5,1,"one",2,"two","default")', makeContext())
      expect(result).toBe('default')
    })

    it('returns #N/A when no match and no default', async () => {
      const result = await engine.calculate('=SWITCH(5,1,"one",2,"two")', makeContext())
      expect(result).toBe('#N/A')
    })
  })

  describe('CONCAT', () => {
    it('concatenates multiple strings', async () => {
      const result = await engine.calculate('=CONCAT("hello"," ","world")', makeContext())
      expect(result).toBe('hello world')
    })

    it('concatenates numbers as strings', async () => {
      const result = await engine.calculate('=CONCAT("val",1)', makeContext())
      expect(result).toBe('val1')
    })

    it('decodes escaped quoted string literals', async () => {
      const result = await engine.calculate('=CONCAT("A \\"quoted\\" value","\\\\path")', makeContext())
      expect(result).toBe('A "quoted" value\\path')
    })

    it('returns #ERROR! for malformed quoted string literals', async () => {
      const result = await engine.calculate('=CONCAT("bad \\\\","suffix")', makeContext())
      expect(result).toBe('#ERROR!')
    })

    it('does not split operators inside quoted string literals', async () => {
      const plusResult = await engine.calculate('="A+B"', makeContext())
      const equalsResult = await engine.calculate('="A=B"', makeContext())
      const comparisonResult = await engine.calculate('="A=B"="A=B"', makeContext())

      expect(plusResult).toBe('A+B')
      expect(equalsResult).toBe('A=B')
      expect(comparisonResult).toBe(true)
    })

    it('does not split operators inside nested function arguments', async () => {
      const result = await engine.calculate('=IF("a>b"="a>b","ok","bad")', makeContext())
      expect(result).toBe('ok')
    })
  })

  describe('parenthesized expressions', () => {
    it('evaluates arithmetic groups inside formulas', async () => {
      const result = await engine.calculate('=(1+2)*3', makeContext())
      expect(result).toBe(9)
    })

    it('evaluates nested arithmetic groups', async () => {
      const result = await engine.calculate('=((1+2)*(4-1))', makeContext())
      expect(result).toBe(9)
    })

    it('evaluates parenthesized function arguments', async () => {
      const result = await engine.calculate('=SUM((1+2),3)', makeContext())
      expect(result).toBe(6)
    })

    it('does not strip partial leading parentheses', async () => {
      const result = await engine.calculate('=(1+2)+(3+4)', makeContext())
      expect(result).toBe(10)
    })
  })

  describe('DATEDIF', () => {
    it('calculates days between dates', async () => {
      const result = await engine.calculate('=DATEDIF("2024-01-01","2024-01-31","D")', makeContext())
      expect(result).toBe(30)
    })

    it('calculates months between dates', async () => {
      const result = await engine.calculate('=DATEDIF("2024-01-15","2024-04-15","M")', makeContext())
      expect(result).toBe(3)
    })

    it('calculates years between dates', async () => {
      const result = await engine.calculate('=DATEDIF("2020-06-01","2024-06-01","Y")', makeContext())
      expect(result).toBe(4)
    })

    it('returns #VALUE! for invalid unit', async () => {
      const result = await engine.calculate('=DATEDIF("2024-01-01","2024-01-31","X")', makeContext())
      expect(result).toBe('#VALUE!')
    })
  })

  describe('DATEDIFF', () => {
    it('calculates day difference using end date then start date', async () => {
      const result = await engine.calculate('=DATEDIFF("2024-01-31","2024-01-01")', makeContext())
      expect(result).toBe(30)
    })

    it('returns #VALUE! for invalid dates', async () => {
      const result = await engine.calculate('=DATEDIFF("not-a-date","2024-01-01")', makeContext())
      expect(result).toBe('#VALUE!')
    })
  })

  describe('COUNTA', () => {
    it('counts non-empty values', async () => {
      const result = await engine.calculate('=COUNTA("a","b","",NULL)', makeContext())
      // "a", "b" are non-empty; "" is empty; NULL parses as null
      expect(result).toBe(2)
    })

    it('counts numbers and booleans as non-empty', async () => {
      const result = await engine.calculate('=COUNTA(1,0,TRUE)', makeContext())
      expect(result).toBe(3)
    })
  })
})

describe('MultitableFormulaEngine', () => {
  let mtEngine: MultitableFormulaEngine

  const sampleFields: MultitableField[] = [
    { id: 'fld_price', name: 'Price', type: 'number' },
    { id: 'fld_fee', name: 'Fee', type: 'number' },
    { id: 'fld_qty', name: 'Quantity', type: 'number' },
    { id: 'fld_total', name: 'Total', type: 'formula', property: { expression: '={fld_price}*{fld_qty}' } },
    { id: 'fld_name', name: 'Name', type: 'string' },
  ]

  beforeEach(() => {
    mtEngine = new MultitableFormulaEngine()
  })

  describe('extractFieldReferences', () => {
    it('extracts field IDs from formula', () => {
      const refs = mtEngine.extractFieldReferences('={fld_price}*{fld_qty}+{fld_tax}')
      expect(refs).toEqual(['fld_price', 'fld_qty', 'fld_tax'])
    })

    it('deduplicates references', () => {
      const refs = mtEngine.extractFieldReferences('={fld_a}+{fld_a}')
      expect(refs).toEqual(['fld_a'])
    })

    it('returns empty array for no references', () => {
      const refs = mtEngine.extractFieldReferences('=1+2')
      expect(refs).toEqual([])
    })
  })

  describe('evaluateField', () => {
    it('resolves field references and evaluates', async () => {
      const result = await mtEngine.evaluateField(
        '={fld_price}*{fld_qty}',
        { fld_price: 10, fld_qty: 5 },
        sampleFields,
      )
      expect(result).toBe(50)
    })

    it('evaluates parenthesized field reference groups', async () => {
      const result = await mtEngine.evaluateField(
        '=({fld_price}+{fld_fee})*{fld_qty}',
        { fld_price: 10, fld_fee: 2, fld_qty: 5 },
        sampleFields,
      )
      expect(result).toBe(60)
    })

    it('evaluates unary signs for grouped field reference expressions', async () => {
      const result = await mtEngine.evaluateField(
        '=-({fld_price}+{fld_fee})*{fld_qty}',
        { fld_price: 10, fld_fee: 2, fld_qty: 5 },
        sampleFields,
      )
      expect(result).toBe(-60)
    })

    it('evaluates unary signs for function results', async () => {
      const result = await mtEngine.evaluateField(
        '=-SUM({fld_price},{fld_fee})',
        { fld_price: 10, fld_fee: 2 },
        sampleFields,
      )
      expect(result).toBe(-12)
    })

    it('handles string field references', async () => {
      const result = await mtEngine.evaluateField(
        '=CONCAT({fld_name}," total")',
        { fld_name: 'Widget' },
        sampleFields,
      )
      expect(result).toBe('Widget total')
    })

    it('handles lowercase function names after resolving field references', async () => {
      const result = await mtEngine.evaluateField(
        '=concat({fld_name}," x")',
        { fld_name: 'Widget' },
        sampleFields,
      )
      expect(result).toBe('Widget x')
    })

    it('escapes quoted string field references before evaluation', async () => {
      const result = await mtEngine.evaluateField(
        '=CONCAT({fld_name}," shipped")',
        { fld_name: 'Widget "Pro"' },
        sampleFields,
      )
      expect(result).toBe('Widget "Pro" shipped')
    })

    it('escapes backslash and newline string field references', async () => {
      const result = await mtEngine.evaluateField(
        '=CONCAT({fld_name}," done")',
        { fld_name: 'C:\\temp\nline2' },
        sampleFields,
      )
      expect(result).toBe('C:\\temp\nline2 done')
    })

    it('does not split operators inside string field references', async () => {
      const result = await mtEngine.evaluateField(
        '={fld_name}="A+B=C"',
        { fld_name: 'A+B=C' },
        sampleFields,
      )
      expect(result).toBe(true)
    })
  })

  describe('lookup', () => {
    it('returns matching field value from another sheet', async () => {
      const mockQuery = vi.fn().mockResolvedValue({
        rows: [{ data: { fld_name: 'Widget', fld_price: 25 } }],
        rowCount: 1,
      })

      const result = await mtEngine.lookup(
        mockQuery,
        'Widget',
        'sheet_products',
        'fld_name',
        'fld_price',
      )
      expect(result).toBe(25)
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('SELECT data FROM meta_records'),
        ['sheet_products', 'fld_name', 'Widget'],
      )
    })

    it('returns #N/A when no match found', async () => {
      const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })

      const result = await mtEngine.lookup(
        mockQuery,
        'Unknown',
        'sheet_products',
        'fld_name',
        'fld_price',
      )
      expect(result).toBe('#N/A')
    })
  })

  describe('recalculateRecord', () => {
    it('evaluates formula fields and writes back', async () => {
      const recordData = {
        fld_price: 10,
        fld_qty: 3,
        fld_total: '={fld_price}*{fld_qty}',
        fld_name: 'Item',
      }

      const selectMock = vi.fn().mockResolvedValue({
        rows: [{ id: 'rec_1', data: recordData }],
        rowCount: 1,
      })
      const updateMock = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 })

      const mockQuery = vi.fn().mockImplementation((sql: string) => {
        if (sql.startsWith('SELECT')) return selectMock(sql)
        return updateMock(sql)
      })

      const result = await mtEngine.recalculateRecord(
        mockQuery,
        'sheet_1',
        'rec_1',
        sampleFields,
      )

      expect(result).not.toBeNull()
      expect(result!.fld_total).toBe(30)
      expect(mockQuery).toHaveBeenCalledTimes(2) // SELECT + UPDATE
    })

    it('returns null when record not found', async () => {
      const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })

      const result = await mtEngine.recalculateRecord(
        mockQuery,
        'sheet_1',
        'rec_nonexistent',
        sampleFields,
      )
      expect(result).toBeNull()
    })
  })
})
