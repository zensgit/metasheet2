/**
 * Capability-depth 1a (companion to #2930 math) — scalar TEXT + DATE function goldens.
 * Locks per-function behavior of FIND/SEARCH/REPLACE/REPT/TEXT/REGEX* and
 * HOUR/MINUTE/DATEADD/EOMONTH/WORKDAY/WEEKNUM incl. their error sentinels. Pure scalar
 * semantics — no range/criteria/record-data (SUMIF/COUNTIFS/AVERAGEIF are the gated 1b).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { FormulaEngine, type FormulaContext } from '../../src/formula/engine'
import { createMockDb, type MockDB } from '../utils/test-db'
import { TEST_IDS } from '../utils/test-fixtures'

describe('1a scalar text + date expansion', () => {
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

  describe('text', () => {
    test('FIND is case-sensitive, 1-based, #VALUE! when absent', async () => {
      expect(await calc('=FIND("b", "abc")')).toBe(2)
      expect(await calc('=FIND("B", "abc")')).toBe('#VALUE!') // case-sensitive
      expect(await calc('=FIND("x", "abc")')).toBe('#VALUE!')
    })
    test('SEARCH is case-insensitive, 1-based', async () => {
      expect(await calc('=SEARCH("B", "abc")')).toBe(2)
      expect(await calc('=SEARCH("x", "abc")')).toBe('#VALUE!')
    })
    test('REPLACE swaps N chars from a 1-based start', async () => {
      expect(await calc('=REPLACE("abcdef", 2, 3, "XY")')).toBe('aXYef')
    })
    test('REPT repeats and guards a runaway count', async () => {
      expect(await calc('=REPT("ab", 3)')).toBe('ababab')
      expect(await calc('=REPT("x", 0)')).toBe('')
      expect(await calc('=REPT("x", -1)')).toBe('#VALUE!')
    })
    test('TEXT formats the documented subset; falls back to String otherwise', async () => {
      expect(await calc('=TEXT(0.5, "0%")')).toBe('50%')
      expect(await calc('=TEXT(0.1234, "0.00%")')).toBe('12.34%')
      expect(await calc('=TEXT(3.14159, "0.00")')).toBe('3.14')
      expect(await calc('=TEXT(1234.5, "#,##0.00")')).toBe('1,234.50')
      expect(await calc('=TEXT("abc", "0.00")')).toBe('abc') // non-numeric → passthrough
    })
    test('REGEXMATCH / REGEXEXTRACT / REGEXREPLACE incl. bad-pattern sentinel', async () => {
      expect(await calc('=REGEXMATCH("abc123", "[0-9]+")')).toBe(true)
      expect(await calc('=REGEXMATCH("abc", "[0-9]+")')).toBe(false)
      expect(await calc('=REGEXMATCH("x", "(")')).toBe('#ERROR!') // unbalanced → caught
      expect(await calc('=REGEXEXTRACT("abc123", "[0-9]+")')).toBe('123')
      expect(await calc('=REGEXEXTRACT("id=42", "id=([0-9]+)")')).toBe('42') // capture group 1
      expect(await calc('=REGEXEXTRACT("abc", "[0-9]+")')).toBe('#VALUE!')
      expect(await calc('=REGEXREPLACE("a1b2", "[0-9]", "#")')).toBe('a#b#')
    })
  })

  describe('date / time', () => {
    test('HOUR / MINUTE read a datetime; #VALUE! on garbage', async () => {
      expect(await calc('=HOUR("2026-01-01T13:30:00")')).toBe(13)
      expect(await calc('=MINUTE("2026-01-01T13:30:00")')).toBe(30)
      expect(await calc('=HOUR("not-a-date")')).toBe('#VALUE!')
    })
    test('DATEADD adds the unit; bad unit → #VALUE!', async () => {
      expect(await calc('=DAY(DATEADD(DATE(2026, 3, 15), 10, "days"))')).toBe(25)
      expect(await calc('=MONTH(DATEADD(DATE(2026, 1, 15), 2, "months"))')).toBe(3)
      expect(await calc('=YEAR(DATEADD(DATE(2026, 6, 1), 1, "years"))')).toBe(2027)
      expect(await calc('=DATEADD(DATE(2026, 1, 1), 1, "lightyears")')).toBe('#VALUE!')
    })
    test('EOMONTH lands on the last day, leap-aware', async () => {
      expect(await calc('=DAY(EOMONTH(DATE(2026, 2, 10), 0))')).toBe(28) // 2026 not leap
      expect(await calc('=DAY(EOMONTH(DATE(2024, 2, 10), 0))')).toBe(29) // 2024 leap
      expect(await calc('=DAY(EOMONTH(DATE(2026, 1, 31), 1))')).toBe(28) // one month forward → Feb
    })
    test('WORKDAY never lands on a weekend; 0 days is identity', async () => {
      // type-2 WEEKDAY: Mon=1..Sun=7 → a weekday result is ≤ 5.
      expect(await calc('=WEEKDAY(WORKDAY(DATE(2026, 6, 3), 7), 2)')).toBeLessThanOrEqual(5)
      expect(await calc('=WEEKDAY(WORKDAY(DATE(2026, 6, 4), -3), 2)')).toBeLessThanOrEqual(5)
      expect(await calc('=DAY(WORKDAY(DATE(2026, 6, 15), 0))')).toBe(15)
      expect(await calc('=WORKDAY("bad", 1)')).toBe('#VALUE!')
    })
    test('WEEKNUM is ISO-8601 (week 1 holds the first Thursday)', async () => {
      expect(await calc('=WEEKNUM(DATE(2026, 1, 1))')).toBe(1) // 2026-01-01 is a Thursday
      const mid = await calc('=WEEKNUM(DATE(2026, 6, 15))')
      expect(typeof mid).toBe('number')
      expect(mid as number).toBeGreaterThanOrEqual(1)
      expect(mid as number).toBeLessThanOrEqual(53)
      expect(await calc('=WEEKNUM("bad")')).toBe('#VALUE!')
    })
  })

  test('the full 1a set is registered (math via #2930 + text/date here); range/criteria are NOT', () => {
    const names = new Set(engine.getRegisteredFunctionNames())
    const scalar1a = [
      'INT', 'TRUNC', 'EXP', 'LN', 'LOG', // math (#2930)
      'FIND', 'SEARCH', 'REPLACE', 'REPT', 'TEXT', 'REGEXMATCH', 'REGEXEXTRACT', 'REGEXREPLACE', // text
      'HOUR', 'MINUTE', 'DATEADD', 'EOMONTH', 'WORKDAY', 'WEEKNUM', // date
    ]
    for (const fn of scalar1a) expect(names.has(fn), `missing ${fn}`).toBe(true)
    // SUMIF/COUNTIFS/AVERAGEIF need range/criteria semantics (1b) — must not be smuggled in as scalar.
    for (const fn of ['SUMIF', 'COUNTIFS', 'AVERAGEIF']) expect(names.has(fn)).toBe(false)
  })
})
