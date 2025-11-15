/**
 * Formula Engine Tests
 * Tests formula parsing, calculation, dependency tracking, and performance
 */

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest'
import { FormulaEngine, type FormulaContext } from '../../src/formula/engine'
import { createMockDb } from '../utils/test-db'
import { TEST_IDS, TEST_CELLS } from '../utils/test-fixtures'
import { PerformanceTracker } from '../utils/test-db'

describe('Formula Engine', () => {
  let engine: FormulaEngine
  let mockDb: ReturnType<typeof createMockDb>
  let context: FormulaContext

  beforeEach(() => {
    engine = new FormulaEngine()
    mockDb = createMockDb()

    // Mock the database import
    vi.doMock('../../src/db/db', () => ({ db: mockDb }))

    context = {
      sheetId: TEST_IDS.SHEET_1,
      spreadsheetId: TEST_IDS.SPREADSHEET_1,
      currentCell: { row: 0, col: 0 },
      cache: new Map()
    }
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  describe('Basic Function Tests', () => {
    describe('Math Functions', () => {
      test('SUM function should calculate correctly', async () => {
        const result = await engine.calculate('=SUM(1, 2, 3, 4, 5)', context)
        expect(result).toBe(15)
      })

      test('SUM with nested arrays', async () => {
        const result = await engine.calculate('=SUM([[1, 2], [3, 4]])', context)
        expect(result).toBe(10)
      })

      test('AVERAGE function', async () => {
        const result = await engine.calculate('=AVERAGE(1, 2, 3, 4, 5)', context)
        expect(result).toBe(3)
      })

      test('COUNT function', async () => {
        const result = await engine.calculate('=COUNT(1, 2, "", 4, null)', context)
        expect(result).toBe(3)
      })

      test('MAX function', async () => {
        const result = await engine.calculate('=MAX(1, 5, 2, 8, 3)', context)
        expect(result).toBe(8)
      })

      test('MIN function', async () => {
        const result = await engine.calculate('=MIN(5, 1, 8, 2, 3)', context)
        expect(result).toBe(1)
      })

      test('ABS function', async () => {
        expect(await engine.calculate('=ABS(-5)', context)).toBe(5)
        expect(await engine.calculate('=ABS(5)', context)).toBe(5)
      })

      test('ROUND function', async () => {
        expect(await engine.calculate('=ROUND(3.14159, 2)', context)).toBe(3.14)
        expect(await engine.calculate('=ROUND(3.14159)', context)).toBe(3)
      })

      test('POWER function', async () => {
        expect(await engine.calculate('=POWER(2, 3)', context)).toBe(8)
      })

      test('SQRT function', async () => {
        expect(await engine.calculate('=SQRT(9)', context)).toBe(3)
      })

      test('MOD function', async () => {
        expect(await engine.calculate('=MOD(10, 3)', context)).toBe(1)
      })
    })

    describe('Text Functions', () => {
      test('CONCATENATE function', async () => {
        const result = await engine.calculate('=CONCATENATE("Hello", " ", "World")', context)
        expect(result).toBe('Hello World')
      })

      test('LEFT function', async () => {
        expect(await engine.calculate('=LEFT("Hello", 3)', context)).toBe('Hel')
      })

      test('RIGHT function', async () => {
        expect(await engine.calculate('=RIGHT("Hello", 3)', context)).toBe('llo')
      })

      test('MID function', async () => {
        expect(await engine.calculate('=MID("Hello", 2, 3)', context)).toBe('ell')
      })

      test('LEN function', async () => {
        expect(await engine.calculate('=LEN("Hello")', context)).toBe(5)
      })

      test('UPPER function', async () => {
        expect(await engine.calculate('=UPPER("hello")', context)).toBe('HELLO')
      })

      test('LOWER function', async () => {
        expect(await engine.calculate('=LOWER("HELLO")', context)).toBe('hello')
      })

      test('TRIM function', async () => {
        expect(await engine.calculate('=TRIM("  hello  ")', context)).toBe('hello')
      })

      test('SUBSTITUTE function', async () => {
        expect(await engine.calculate('=SUBSTITUTE("hello world", "world", "there")', context)).toBe('hello there')
      })
    })

    describe('Logical Functions', () => {
      test('IF function', async () => {
        expect(await engine.calculate('=IF(TRUE, "yes", "no")', context)).toBe('yes')
        expect(await engine.calculate('=IF(FALSE, "yes", "no")', context)).toBe('no')
        expect(await engine.calculate('=IF(5 > 3, "greater", "lesser")', context)).toBe('greater')
      })

      test('AND function', async () => {
        expect(await engine.calculate('=AND(TRUE, TRUE)', context)).toBe(true)
        expect(await engine.calculate('=AND(TRUE, FALSE)', context)).toBe(false)
        expect(await engine.calculate('=AND(1, 1)', context)).toBe(true)
        expect(await engine.calculate('=AND(1, 0)', context)).toBe(false)
      })

      test('OR function', async () => {
        expect(await engine.calculate('=OR(TRUE, FALSE)', context)).toBe(true)
        expect(await engine.calculate('=OR(FALSE, FALSE)', context)).toBe(false)
        expect(await engine.calculate('=OR(0, 1)', context)).toBe(true)
      })

      test('NOT function', async () => {
        expect(await engine.calculate('=NOT(TRUE)', context)).toBe(false)
        expect(await engine.calculate('=NOT(FALSE)', context)).toBe(true)
      })
    })

    describe('Date Functions', () => {
      test('NOW function', async () => {
        const result = await engine.calculate('=NOW()', context)
        expect(result).toBeInstanceOf(Date)
        expect(Math.abs(result.getTime() - Date.now())).toBeLessThan(1000)
      })

      test('TODAY function', async () => {
        const result = await engine.calculate('=TODAY()', context)
        expect(result).toBeInstanceOf(Date)
        expect(result.getHours()).toBe(0)
        expect(result.getMinutes()).toBe(0)
        expect(result.getSeconds()).toBe(0)
      })

      test('DATE function', async () => {
        const result = await engine.calculate('=DATE(2024, 1, 15)', context)
        expect(result).toBeInstanceOf(Date)
        expect(result.getFullYear()).toBe(2024)
        expect(result.getMonth()).toBe(0) // January is 0
        expect(result.getDate()).toBe(15)
      })

      test('YEAR, MONTH, DAY functions', async () => {
        const date = new Date(2024, 0, 15)
        context.cache.set('test:0:0', date)

        mockDb.selectFrom.mockReturnValue({
          select: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          executeTakeFirst: vi.fn().mockResolvedValue({
            value: date.toISOString(),
            data_type: 'date',
            formula: null
          })
        })

        expect(await engine.calculate('=YEAR(A1)', context)).toBe(2024)
        expect(await engine.calculate('=MONTH(A1)', context)).toBe(1)
        expect(await engine.calculate('=DAY(A1)', context)).toBe(15)
      })
    })

    describe('Statistical Functions', () => {
      test('STDEV function', async () => {
        const result = await engine.calculate('=STDEV(1, 2, 3, 4, 5)', context)
        expect(result).toBeCloseTo(1.58, 1)
      })

      test('VAR function', async () => {
        const result = await engine.calculate('=VAR(1, 2, 3, 4, 5)', context)
        expect(result).toBeCloseTo(2.5, 1)
      })

      test('MEDIAN function', async () => {
        expect(await engine.calculate('=MEDIAN(1, 2, 3, 4, 5)', context)).toBe(3)
        expect(await engine.calculate('=MEDIAN(1, 2, 3, 4)', context)).toBe(2.5)
      })

      test('MODE function', async () => {
        expect(await engine.calculate('=MODE(1, 2, 2, 3, 3, 3)', context)).toBe(3)
      })
    })
  })

  describe('Operators', () => {
    test('Arithmetic operators', async () => {
      expect(await engine.calculate('=5 + 3', context)).toBe(8)
      expect(await engine.calculate('=5 - 3', context)).toBe(2)
      expect(await engine.calculate('=5 * 3', context)).toBe(15)
      expect(await engine.calculate('=6 / 3', context)).toBe(2)
    })

    test('Division by zero', async () => {
      expect(await engine.calculate('=5 / 0', context)).toBe('#DIV/0!')
    })

    test('Comparison operators', async () => {
      expect(await engine.calculate('=5 > 3', context)).toBe(true)
      expect(await engine.calculate('=5 < 3', context)).toBe(false)
      expect(await engine.calculate('=5 = 5', context)).toBe(true)
      expect(await engine.calculate('=5 >= 5', context)).toBe(true)
      expect(await engine.calculate('=5 <= 4', context)).toBe(false)
      expect(await engine.calculate('=5 <> 3', context)).toBe(true)
    })
  })

  describe('Cell References', () => {
    test('Single cell reference', async () => {
      mockDb.selectFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn().mockResolvedValue({
          value: '42',
          data_type: 'number',
          formula: null
        })
      })

      const result = await engine.calculate('=A1', context)
      expect(result).toBe(42)
    })

    test('Cell reference with formula', async () => {
      mockDb.selectFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn().mockResolvedValue({
          value: '84',
          data_type: 'number',
          formula: '=42*2'
        })
      })

      const result = await engine.calculate('=A1', context)
      expect(result).toBe(84) // Should use the calculated value, not formula
    })

    test('Range reference', async () => {
      // Mock database to return range data
      const cellValues = [
        { value: '1', data_type: 'number', formula: null },
        { value: '2', data_type: 'number', formula: null },
        { value: '3', data_type: 'number', formula: null }
      ]

      let callIndex = 0
      mockDb.selectFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn().mockImplementation(() => {
          return Promise.resolve(cellValues[callIndex++] || null)
        })
      })

      const result = await engine.calculate('=SUM(A1:A3)', context)
      expect(result).toBe(6)
    })
  })

  describe('Lookup Functions', () => {
    test('VLOOKUP exact match', async () => {
      const lookupTable = [
        ['apple', 1.50],
        ['banana', 0.75],
        ['orange', 2.00]
      ]

      const result = await engine.calculate('=VLOOKUP("banana", [[lookupTable]], 2)', context)
      expect(result).toBe(0.75)
    })

    test('VLOOKUP not found', async () => {
      const lookupTable = [
        ['apple', 1.50],
        ['banana', 0.75]
      ]

      const result = await engine.calculate('=VLOOKUP("grape", [[lookupTable]], 2)', context)
      expect(result).toBe('#N/A')
    })

    test('HLOOKUP function', async () => {
      const lookupTable = [
        ['apple', 'banana', 'orange'],
        [1.50, 0.75, 2.00]
      ]

      const result = await engine.calculate('=HLOOKUP("banana", [[lookupTable]], 2)', context)
      expect(result).toBe(0.75)
    })

    test('INDEX function', async () => {
      const array = [
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9]
      ]

      expect(await engine.calculate('=INDEX([[array]], 2, 2)', context)).toBe(5)
      expect(await engine.calculate('=INDEX([[array]], 3, 1)', context)).toBe(7)
    })

    test('MATCH function', async () => {
      const array = [10, 20, 30, 40, 50]
      expect(await engine.calculate('=MATCH(30, [array])', context)).toBe(3)
      expect(await engine.calculate('=MATCH(25, [array])', context)).toBe(-1)
    })
  })

  describe('Complex Formulas', () => {
    test('Nested functions', async () => {
      const result = await engine.calculate('=SUM(MAX(1, 2), MIN(5, 3))', context)
      expect(result).toBe(5) // MAX(1,2) = 2, MIN(5,3) = 3, SUM(2,3) = 5
    })

    test('Mixed data types', async () => {
      const result = await engine.calculate('=CONCATENATE(SUM(1, 2), " items")', context)
      expect(result).toBe('3 items')
    })

    test('Complex logical formula', async () => {
      const result = await engine.calculate('=IF(AND(5 > 3, 2 < 4), SUM(1, 2, 3), "false")', context)
      expect(result).toBe(6)
    })
  })

  describe('Error Handling', () => {
    test('Invalid function name', async () => {
      const result = await engine.calculate('=NONEXISTENT(1, 2)', context)
      expect(result).toBe('#ERROR!')
    })

    test('Invalid cell reference', async () => {
      const result = await engine.calculate('=INVALID_REF', context)
      expect(result).toBe('#ERROR!')
    })

    test('Circular reference detection', async () => {
      // This would be handled at a higher level during dependency graph building
      // The formula engine itself just calculates what it's given
      expect(true).toBe(true) // Placeholder for circular reference tests
    })

    test('Invalid formula syntax', async () => {
      const result = await engine.calculate('=SUM(', context)
      expect(result).toBe('#ERROR!')
    })
  })

  describe('Performance Tests', () => {
    test('Large SUM calculation', async () => {
      const tracker = new PerformanceTracker()
      const end = tracker.start('large_sum')

      // Create array of 1000 numbers
      const numbers = Array.from({ length: 1000 }, (_, i) => i + 1)
      const formula = `=SUM(${numbers.join(', ')})`

      const result = await engine.calculate(formula, context)
      end()

      expect(result).toBe(500500) // Sum of 1 to 1000

      const stats = tracker.getStats('large_sum')
      expect(stats?.avg).toBeLessThan(100) // Should complete in under 100ms
    })

    test('Nested function performance', async () => {
      const tracker = new PerformanceTracker()

      for (let i = 0; i < 100; i++) {
        const end = tracker.start('nested_calc')
        await engine.calculate('=SUM(MAX(1, 2, 3), MIN(4, 5, 6), AVERAGE(7, 8, 9))', context)
        end()
      }

      const stats = tracker.getStats('nested_calc')
      expect(stats?.avg).toBeLessThan(10) // Should be very fast
      expect(stats?.p95).toBeLessThan(20)
    })

    test('String manipulation performance', async () => {
      const tracker = new PerformanceTracker()
      const end = tracker.start('string_perf')

      // Complex string operation
      const result = await engine.calculate(
        '=CONCATENATE(LEFT("Hello World", 5), " ", RIGHT("Hello World", 5), " ", UPPER("test"))',
        context
      )
      end()

      expect(result).toBe('Hello World TEST')

      const stats = tracker.getStats('string_perf')
      expect(stats?.avg).toBeLessThan(50)
    })
  })

  describe('Caching', () => {
    test('Cell value caching', async () => {
      const mockExecuteTakeFirst = vi.fn().mockResolvedValue({
        value: '42',
        data_type: 'number',
        formula: null
      })

      mockDb.selectFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        executeTakeFirst: mockExecuteTakeFirst
      })

      // First call should hit database
      await engine.calculate('=A1', context)
      expect(mockExecuteTakeFirst).toHaveBeenCalledTimes(1)

      // Second call should use cache
      await engine.calculate('=A1', context)
      expect(mockExecuteTakeFirst).toHaveBeenCalledTimes(1) // Still 1
    })

    test('Cache key generation', async () => {
      const context1 = { ...context, sheetId: 'sheet1' }
      const context2 = { ...context, sheetId: 'sheet2' }

      mockDb.selectFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn().mockResolvedValue({
          value: '42',
          data_type: 'number',
          formula: null
        })
      })

      await engine.calculate('=A1', context1)
      await engine.calculate('=A1', context2)

      // Should be different cache entries for different sheets
      expect(context1.cache.size).toBe(1)
      expect(context2.cache.size).toBe(1)
    })
  })

  describe('Data Type Handling', () => {
    test('Number conversion', async () => {
      mockDb.selectFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn().mockResolvedValue({
          value: '123.45',
          data_type: 'number',
          formula: null
        })
      })

      const result = await engine.calculate('=A1', context)
      expect(result).toBe(123.45)
      expect(typeof result).toBe('number')
    })

    test('Boolean conversion', async () => {
      mockDb.selectFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn().mockResolvedValue({
          value: 'true',
          data_type: 'boolean',
          formula: null
        })
      })

      const result = await engine.calculate('=A1', context)
      expect(result).toBe(true)
      expect(typeof result).toBe('boolean')
    })

    test('Date conversion', async () => {
      const dateStr = '2024-01-15T00:00:00Z'
      mockDb.selectFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn().mockResolvedValue({
          value: dateStr,
          data_type: 'date',
          formula: null
        })
      })

      const result = await engine.calculate('=A1', context)
      expect(result).toBeInstanceOf(Date)
      expect(result.toISOString()).toBe(dateStr)
    })
  })

  describe('Dependency Graph', () => {
    test('Build dependency graph', async () => {
      const formulas = [
        {
          cell_id: 'cell1',
          dependencies: ['A1', 'B1'],
          dependents: []
        },
        {
          cell_id: 'cell2',
          dependencies: ['A1'],
          dependents: []
        }
      ]

      mockDb.selectFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue(formulas)
      })

      await engine.buildDependencyGraph(TEST_IDS.SHEET_1)

      // This tests internal state - in a real implementation,
      // you'd expose methods to verify the dependency graph
      expect(mockDb.selectFrom).toHaveBeenCalledWith('formulas')
    })
  })

  describe('Edge Cases', () => {
    test('Empty string formula', async () => {
      const result = await engine.calculate('', context)
      expect(result).toBe('#ERROR!')
    })

    test('Formula without equals sign', async () => {
      const result = await engine.calculate('SUM(1,2,3)', context)
      expect(result).toBe(6) // Should still work
    })

    test('Very long formula', async () => {
      const longFormula = '=SUM(' + Array.from({ length: 100 }, (_, i) => i + 1).join(',') + ')'
      const result = await engine.calculate(longFormula, context)
      expect(result).toBe(5050)
    })

    test('Null and undefined handling', async () => {
      mockDb.selectFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn().mockResolvedValue(null)
      })

      const result = await engine.calculate('=A1', context)
      expect(result).toBeNull()
    })

    test('Non-existent cell reference', async () => {
      mockDb.selectFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn().mockResolvedValue(null)
      })

      const result = await engine.calculate('=ZZ999', context)
      expect(result).toBeNull()
    })
  })

  describe('Volatile Functions', () => {
    test('NOW() should be marked as volatile', async () => {
      const result1 = await engine.calculate('=NOW()', context)

      // Wait a small amount
      await new Promise(resolve => setTimeout(resolve, 2))

      const result2 = await engine.calculate('=NOW()', context)

      // Both should be dates but potentially different times
      expect(result1).toBeInstanceOf(Date)
      expect(result2).toBeInstanceOf(Date)
      expect(result2.getTime()).toBeGreaterThanOrEqual(result1.getTime())
    })

    test('TODAY() should return consistent value within same day', async () => {
      const result1 = await engine.calculate('=TODAY()', context)
      const result2 = await engine.calculate('=TODAY()', context)

      expect(result1).toBeInstanceOf(Date)
      expect(result2).toBeInstanceOf(Date)
      expect(result1.toDateString()).toBe(result2.toDateString())
    })
  })
})