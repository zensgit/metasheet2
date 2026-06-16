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

  test('COUNTIF text matching is case-INSENSITIVE (Excel/Feishu parity)', async () => {
    expect(await calc('=COUNTIF([["Apple", "APPLE", "apple"]], "apple")')).toBe(3)
    expect(await calc('=COUNTIF([["Cat", "cat", "dog"]], "=CAT")')).toBe(2)
  })

  test('COUNTIF numeric comparators do NOT over-count blanks/booleans (Number() coercion guard)', async () => {
    expect(await calc('=COUNTIF([[5, null]], ">-1")')).toBe(1)   // null is not 0
    expect(await calc('=COUNTIF([[5, null, ""]], ">=0")')).toBe(1) // null/"" excluded
    expect(await calc('=COUNTIF([[null]], "=0")')).toBe(0)
  })

  test('WEEKDAY is timezone-stable for date-only strings (parsed as local, matching DATE())', async () => {
    // exact weekday, computed via the SAME local-midnight construction the fix uses → TZ-independent.
    const dow = new Date(2026, 0, 4).getDay() // 2026-01-04
    expect(await calc('=WEEKDAY("2026-01-04")')).toBe(dow + 1)              // type 1: Sun=1..Sat=7
    expect(await calc('=WEEKDAY("2026-01-04", 2)')).toBe(dow === 0 ? 7 : dow) // type 2: Mon=1..Sun=7
    expect(await calc('=WEEKDAY(DATE(2026, 1, 4))')).toBe(dow + 1)          // DATE() path agrees
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

  test('ROUNDUP/ROUNDDOWN are float-precision-safe on everyday monetary values', async () => {
    // 0.29*100 === 28.999…996 / 0.07*100 === 7.000…001 — naive floor/ceil rounds the wrong way.
    expect(await calc('=ROUNDDOWN(0.29, 2)')).toBeCloseTo(0.29, 10)
    expect(await calc('=ROUNDDOWN(0.58, 2)')).toBeCloseTo(0.58, 10)
    expect(await calc('=ROUNDDOWN(1.16, 2)')).toBeCloseTo(1.16, 10)
    expect(await calc('=ROUNDUP(0.07, 2)')).toBeCloseTo(0.07, 10)
  })

  test('ISERROR/IFERROR also trap a NaN numeric error (e.g. SQRT(-1))', async () => {
    expect(await calc('=ISERROR(SQRT(-1))')).toBe(true)
    expect(await calc('=IFERROR(SQRT(-1), "x")')).toBe('x')
  })
})
