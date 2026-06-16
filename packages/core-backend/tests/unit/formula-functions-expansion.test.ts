/**
 * Formula library expansion (Feishu parity): IFERROR / ISERROR / ISBLANK / ISNUMBER / IFS / XOR /
 * COUNTIF / WEEKDAY / ROUNDUP / ROUNDDOWN. Locks behavior incl. the review-flagged COUNTIF criteria
 * coercion (String(criteria) — a non-string criteria must never throw or mis-count).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { FormulaEngine, type FormulaContext } from '../../src/formula/engine'
import { createMockDb, type MockDB } from '../utils/test-db'
import { TEST_IDS } from '../utils/test-fixtures'

describe('Formula library expansion', () => {
  let engine: FormulaEngine
  let context: FormulaContext
  let mockDb: MockDB

  beforeEach(() => {
    mockDb = createMockDb()
    engine = new FormulaEngine({ db: mockDb })
    context = { sheetId: TEST_IDS.SHEET_1, spreadsheetId: TEST_IDS.SPREADSHEET_1, currentCell: { row: 0, col: 0 }, cache: new Map() }
  })
  afterEach(() => { vi.clearAllMocks(); vi.resetModules() })
  const calc = (f: string) => engine.calculate(f, context)

  test('IFERROR traps an error result and passes a clean value through', async () => {
    expect(await calc('=IFERROR(1/0, "fallback")')).toBe('fallback') // 1/0 => #DIV/0!
    expect(await calc('=IFERROR(5, "fallback")')).toBe(5)
  })

  test('ISERROR / ISBLANK / ISNUMBER predicates', async () => {
    expect(await calc('=ISERROR(1/0)')).toBe(true)
    expect(await calc('=ISERROR(5)')).toBe(false)
    expect(await calc('=ISBLANK("")')).toBe(true)
    expect(await calc('=ISBLANK("x")')).toBe(false)
    expect(await calc('=ISNUMBER(5)')).toBe(true)
    expect(await calc('=ISNUMBER("x")')).toBe(false)
  })

  test('IFS returns the first truthy branch', async () => {
    expect(await calc('=IFS(1>2, "a", 3>2, "b")')).toBe('b')
    expect(await calc('=IFS(2>1, "a", 3>2, "b")')).toBe('a')
  })

  test('XOR is true iff an odd number of args are truthy', async () => {
    expect(await calc('=XOR(TRUE(), FALSE())')).toBe(true)
    expect(await calc('=XOR(TRUE(), TRUE())')).toBe(false)
    expect(await calc('=XOR(TRUE(), TRUE(), TRUE())')).toBe(true)
  })

  test('COUNTIF supports comparator, numeric, and text criteria', async () => {
    expect(await calc('=COUNTIF([[1, 2, 3, 4, 5]], ">2")')).toBe(3)
    expect(await calc('=COUNTIF([[1, 2, 3, 4, 5]], "<=2")')).toBe(2)
    expect(await calc('=COUNTIF([[1, 2, 2, 3]], 2)')).toBe(2) // bare-number criteria (non-string) must not throw
    expect(await calc('=COUNTIF([["a", "b", "a"]], "a")')).toBe(2)
  })

  test('WEEKDAY returns 1..7 for a valid date, #VALUE! for garbage', async () => {
    const r = await calc('=WEEKDAY(DATE(2026, 1, 4))')
    expect(typeof r).toBe('number')
    expect(r as number).toBeGreaterThanOrEqual(1)
    expect(r as number).toBeLessThanOrEqual(7)
    expect(await calc('=WEEKDAY("not-a-date")')).toBe('#VALUE!')
  })

  test('ROUNDUP / ROUNDDOWN round away-from / toward zero at the given precision', async () => {
    expect(await calc('=ROUNDUP(2.1, 0)')).toBe(3)
    expect(await calc('=ROUNDDOWN(2.9, 0)')).toBe(2)
    expect(await calc('=ROUNDUP(2.144, 1)')).toBeCloseTo(2.2, 10)
    expect(await calc('=ROUNDDOWN(2.166, 1)')).toBeCloseTo(2.1, 10)
    expect(await calc('=ROUNDUP(-2.1, 0)')).toBe(-3)
    expect(await calc('=ROUNDDOWN(-2.9, 0)')).toBe(-2)
  })
})
