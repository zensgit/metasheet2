/**
 * Cluster-C path-1 batch 2: 26 standard scalar functions — trig/math (SIN/COS/TAN/ASIN/ACOS/ATAN/
 * ATAN2/LOG10/EVEN/ODD/FACT/QUOTIENT/MROUND), numeric predicates (ISEVEN/ISODD), text
 * (EXACT/CHAR/CODE/CLEAN/ISTEXT), and date/time (DATEVALUE/TIMEVALUE/TIME/ISOWEEKNUM/YEARFRAC/
 * NETWORKDAYS). All are pure-scalar (no range/array semantics — SUMIFS/COUNTIFS-style criteria
 * functions are excluded by design, same rule as batch 1). Locks per-function correct-value +
 * edge-case + error-sentinel behavior, mirroring the existing batch-1 / 1a-expansion test shape.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { FormulaEngine, type FormulaContext } from '../../src/formula/engine'
import { createMockDb, type MockDB } from '../utils/test-db'
import { TEST_IDS } from '../utils/test-fixtures'

describe('Cluster-C batch 2 scalar functions', () => {
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

  describe('trig', () => {
    test('SIN / COS / TAN evaluate at standard angles; non-numeric → #VALUE!', async () => {
      expect(await calc('=SIN(0)')).toBe(0)
      expect(await calc('=SIN(PI() / 2)')).toBeCloseTo(1, 9)
      expect(await calc('=COS(0)')).toBe(1)
      expect(await calc('=COS(PI())')).toBeCloseTo(-1, 9)
      expect(await calc('=TAN(0)')).toBe(0)
      expect(await calc('=SIN("x")')).toBe('#VALUE!')
      expect(await calc('=COS("x")')).toBe('#VALUE!')
      expect(await calc('=TAN("x")')).toBe('#VALUE!')
    })

    test('ASIN / ACOS: domain [-1, 1], outside it → #NUM! (distinct from #VALUE!)', async () => {
      expect(await calc('=ASIN(1)')).toBeCloseTo(Math.PI / 2, 9)
      expect(await calc('=ASIN(-1)')).toBeCloseTo(-Math.PI / 2, 9)
      expect(await calc('=ASIN(2)')).toBe('#NUM!')
      expect(await calc('=ASIN("x")')).toBe('#VALUE!')
      expect(await calc('=ACOS(1)')).toBe(0)
      expect(await calc('=ACOS(-1)')).toBeCloseTo(Math.PI, 9)
      expect(await calc('=ACOS(2)')).toBe('#NUM!')
      expect(await calc('=ACOS("x")')).toBe('#VALUE!')
    })

    test('ATAN has no domain restriction; non-numeric → #VALUE!', async () => {
      expect(await calc('=ATAN(1)')).toBeCloseTo(Math.PI / 4, 9)
      expect(await calc('=ATAN("x")')).toBe('#VALUE!')
    })

    test('ATAN2(x_num, y_num) uses Excel coordinate arg order, locked by a worked MS-doc example', async () => {
      // ATAN2(1, -1) = -0.785398163 per Microsoft's own documented example (angle to point (1,-1) is
      // -45°) — this pins the arg order as (x, y), not JS's atan2(y, x).
      expect(await calc('=ATAN2(1, -1)')).toBeCloseTo(-0.785398163, 8)
      expect(await calc('=ATAN2(1, 1)')).toBeCloseTo(0.785398163, 8)
      expect(await calc('=ATAN2(0, 0)')).toBe('#DIV/0!')
      expect(await calc('=ATAN2("x", 1)')).toBe('#VALUE!')
    })
  })

  describe('math', () => {
    test('LOG10: base-10 log; domain n>0, else #NUM!; non-numeric → #VALUE!', async () => {
      expect(await calc('=LOG10(100)')).toBeCloseTo(2, 9)
      expect(await calc('=LOG10(1)')).toBe(0)
      expect(await calc('=LOG10(0)')).toBe('#NUM!')
      expect(await calc('=LOG10(-5)')).toBe('#NUM!')
      expect(await calc('=LOG10("x")')).toBe('#VALUE!')
    })

    test('EVEN rounds away from zero to the nearest even integer; EVEN(0) = 0', async () => {
      expect(await calc('=EVEN(1.5)')).toBe(2)
      expect(await calc('=EVEN(3)')).toBe(4)
      expect(await calc('=EVEN(2)')).toBe(2)
      expect(await calc('=EVEN(-1)')).toBe(-2)
      expect(await calc('=EVEN(-3)')).toBe(-4)
      expect(await calc('=EVEN(0)')).toBe(0)
      expect(await calc('=EVEN("x")')).toBe('#VALUE!')
    })

    test('ODD rounds away from zero to the nearest odd integer; ODD(0) = 1', async () => {
      expect(await calc('=ODD(1.5)')).toBe(3)
      expect(await calc('=ODD(3)')).toBe(3)
      expect(await calc('=ODD(2)')).toBe(3)
      expect(await calc('=ODD(-1)')).toBe(-1)
      expect(await calc('=ODD(-2)')).toBe(-3)
      expect(await calc('=ODD(0)')).toBe(1)
      expect(await calc('=ODD("x")')).toBe('#VALUE!')
    })

    test('FACT: non-negative-integer domain (stricter than Excel truncation) — negative/non-integer → #NUM!', async () => {
      expect(await calc('=FACT(5)')).toBe(120)
      expect(await calc('=FACT(0)')).toBe(1)
      expect(await calc('=FACT(-1)')).toBe('#NUM!')
      expect(await calc('=FACT(3.5)')).toBe('#NUM!') // non-integer is a hard reject in this batch, not a silent truncation
      expect(await calc('=FACT("x")')).toBe('#VALUE!')
    })

    test('QUOTIENT truncates toward zero; divisor 0 → #DIV/0!', async () => {
      expect(await calc('=QUOTIENT(7, 2)')).toBe(3)
      expect(await calc('=QUOTIENT(-7, 2)')).toBe(-3)
      expect(await calc('=QUOTIENT(7, -2)')).toBe(-3)
      expect(await calc('=QUOTIENT(5, 0)')).toBe('#DIV/0!')
      expect(await calc('=QUOTIENT("x", 2)')).toBe('#VALUE!')
    })

    test('MROUND rounds to the nearest multiple; opposite signs → #NUM!; multiple 0 → 0', async () => {
      expect(await calc('=MROUND(10, 3)')).toBe(9)
      expect(await calc('=MROUND(-10, -3)')).toBe(-9)
      expect(await calc('=MROUND(10, 0)')).toBe(0)
      expect(await calc('=MROUND(10, -3)')).toBe('#NUM!') // number/multiple sign mismatch
      expect(await calc('=MROUND("x", 3)')).toBe('#VALUE!')
    })
  })

  describe('numeric predicates', () => {
    test('ISEVEN / ISODD truncate toward zero before testing parity; non-numeric → #VALUE!', async () => {
      expect(await calc('=ISEVEN(4)')).toBe(true)
      expect(await calc('=ISEVEN(3)')).toBe(false)
      expect(await calc('=ISEVEN(2.9)')).toBe(true) // truncates to 2
      expect(await calc('=ISEVEN(-4)')).toBe(true)
      expect(await calc('=ISEVEN("x")')).toBe('#VALUE!')
      expect(await calc('=ISODD(3)')).toBe(true)
      expect(await calc('=ISODD(4)')).toBe(false)
      expect(await calc('=ISODD(-3)')).toBe(true)
      expect(await calc('=ISODD("x")')).toBe('#VALUE!')
    })
  })

  describe('text', () => {
    test('EXACT is case-SENSITIVE (distinct from = and from COUNTIF text matching)', async () => {
      expect(await calc('=EXACT("Abc", "Abc")')).toBe(true)
      expect(await calc('=EXACT("Abc", "abc")')).toBe(false)
      expect(await calc('=EXACT(1, "1")')).toBe(true) // both coerce to the string "1"
    })

    test('CHAR/CODE round-trip over the documented 1..255 range; out-of-range CHAR → #VALUE!', async () => {
      expect(await calc('=CHAR(65)')).toBe('A')
      expect(await calc('=CHAR(97)')).toBe('a')
      expect(await calc('=CHAR(0)')).toBe('#VALUE!') // below range
      expect(await calc('=CHAR(256)')).toBe('#VALUE!') // above range
      expect(await calc('=CHAR("x")')).toBe('#VALUE!')
      expect(await calc('=CODE("A")')).toBe(65)
      expect(await calc('=CODE("apple")')).toBe(97) // first character only
      expect(await calc('=CODE("")')).toBe('#VALUE!')
    })

    test('CLEAN strips ASCII control characters (built via CHAR to avoid literal control bytes in source)', async () => {
      expect(await calc('=CLEAN("hello")')).toBe('hello') // no-op on already-clean text
      expect(await calc('=CLEAN("a" & CHAR(7) & "b")')).toBe('ab') // strips BEL
      expect(await calc('=CLEAN("x" & CHAR(9) & "y")')).toBe('xy') // strips TAB
    })

    test('ISTEXT is a type predicate (mirrors ISNUMBER/ISBLANK/ISERROR)', async () => {
      expect(await calc('=ISTEXT("abc")')).toBe(true)
      expect(await calc('=ISTEXT(123)')).toBe(false)
      expect(await calc('=ISTEXT(TRUE())')).toBe(false)
    })
  })

  describe('date / time', () => {
    test('DATEVALUE parses text into a date; unparseable → #VALUE!', async () => {
      expect(await calc('=DAY(DATEVALUE("2026-06-15"))')).toBe(15)
      expect(await calc('=MONTH(DATEVALUE("2026-06-15"))')).toBe(6)
      expect(await calc('=YEAR(DATEVALUE("2026-06-15"))')).toBe(2026)
      expect(await calc('=DATEVALUE("not-a-date")')).toBe('#VALUE!')
    })

    test('TIME builds a time value from h/m/s, truncating fractional parts; non-numeric → #VALUE!', async () => {
      expect(await calc('=HOUR(TIME(13, 30, 45))')).toBe(13)
      expect(await calc('=MINUTE(TIME(13, 30, 45))')).toBe(30)
      expect(await calc('=SECOND(TIME(13, 30, 45))')).toBe(45)
      expect(await calc('=HOUR(TIME(1.9, 2.9, 3.9))')).toBe(1) // truncates, does not round
      expect(await calc('=TIME("x", 0, 0)')).toBe('#VALUE!')
    })

    test('TIMEVALUE parses "HH:MM[:SS]" text; out-of-range/garbage → #VALUE!', async () => {
      expect(await calc('=HOUR(TIMEVALUE("13:30:45"))')).toBe(13)
      expect(await calc('=MINUTE(TIMEVALUE("13:30:45"))')).toBe(30)
      expect(await calc('=SECOND(TIMEVALUE("13:30:45"))')).toBe(45)
      expect(await calc('=SECOND(TIMEVALUE("13:30"))')).toBe(0) // seconds default to 0
      expect(await calc('=TIMEVALUE("25:00:00")')).toBe('#VALUE!') // hour out of range
      expect(await calc('=TIMEVALUE("not-a-time")')).toBe('#VALUE!')
    })

    test('ISOWEEKNUM is ISO-8601 (Monday-first, week 1 holds the first Thursday), incl. year-boundary weeks', async () => {
      expect(await calc('=ISOWEEKNUM(DATE(2026, 1, 1))')).toBe(1) // 2026-01-01 is a Thursday → week 1
      // 2027-01-01 is a Friday that ISO-belongs to week 53 of 2026 (year boundary, forward direction).
      expect(await calc('=ISOWEEKNUM(DATE(2027, 1, 1))')).toBe(53)
      // 2025-12-29 is a Monday that ISO-belongs to week 1 of 2026 (year boundary, backward direction).
      expect(await calc('=ISOWEEKNUM(DATE(2025, 12, 29))')).toBe(1)
      expect(await calc('=ISOWEEKNUM("bad")')).toBe('#VALUE!')
    })

    test('YEARFRAC basis 0 (US 30/360): whole/half/quarter year, order-independence; non-0 basis rejected', async () => {
      expect(await calc('=YEARFRAC(DATE(2026, 1, 1), DATE(2027, 1, 1))')).toBeCloseTo(1, 9)
      expect(await calc('=YEARFRAC(DATE(2026, 1, 1), DATE(2026, 7, 1))')).toBeCloseTo(0.5, 9)
      expect(await calc('=YEARFRAC(DATE(2026, 1, 1), DATE(2026, 4, 1))')).toBeCloseTo(0.25, 9)
      // Reversed argument order still yields the same positive fraction (matches Excel).
      expect(await calc('=YEARFRAC(DATE(2026, 7, 1), DATE(2026, 1, 1))')).toBeCloseTo(0.5, 9)
      expect(await calc('=YEARFRAC(DATE(2026, 1, 1), DATE(2026, 1, 1), 0)')).toBe(0)
      // Any explicit non-default basis is a hard reject, not a silently-wrong day-count convention.
      expect(await calc('=YEARFRAC(DATE(2026, 1, 1), DATE(2027, 1, 1), 1)')).toBe('#VALUE!')
      expect(await calc('=YEARFRAC("bad", DATE(2026, 1, 1))')).toBe('#VALUE!')
    })

    test('NETWORKDAYS: inclusive Mon-Fri count, same-day, weekend-crossing, and signed reversal', async () => {
      // 2026-06-01 is a Monday; 2026-06-05 is the Friday of the same week.
      expect(await calc('=NETWORKDAYS(DATE(2026, 6, 1), DATE(2026, 6, 5))')).toBe(5)
      expect(await calc('=NETWORKDAYS(DATE(2026, 6, 1), DATE(2026, 6, 1))')).toBe(1) // same day, a weekday
      expect(await calc('=NETWORKDAYS(DATE(2026, 6, 6), DATE(2026, 6, 6))')).toBe(0) // same day, a Saturday
      // 2026-06-08 is the following Monday — spans one full weekend.
      expect(await calc('=NETWORKDAYS(DATE(2026, 6, 1), DATE(2026, 6, 8))')).toBe(6)
      // Reversed order (start after end) → negative, matching Excel's documented NETWORKDAYS behavior.
      expect(await calc('=NETWORKDAYS(DATE(2026, 6, 5), DATE(2026, 6, 1))')).toBe(-5)
      expect(await calc('=NETWORKDAYS("bad", DATE(2026, 6, 1))')).toBe('#VALUE!')
    })
  })

  test('the full batch-2 set is registered', () => {
    const names = new Set(engine.getRegisteredFunctionNames())
    const batch2 = [
      'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN', 'ATAN2', 'LOG10', 'EVEN', 'ODD', 'FACT', 'QUOTIENT', 'MROUND',
      'ISEVEN', 'ISODD',
      'EXACT', 'CHAR', 'CODE', 'CLEAN', 'ISTEXT',
      'DATEVALUE', 'TIMEVALUE', 'TIME', 'ISOWEEKNUM', 'YEARFRAC', 'NETWORKDAYS',
    ]
    expect(batch2.length).toBe(26)
    for (const fn of batch2) expect(names.has(fn), `missing ${fn}`).toBe(true)
    // Range/criteria functions (SUMIFS/COUNTIFS-style) are deliberately excluded from this scalar batch.
    for (const fn of ['SUMIFS', 'AVERAGEIF']) expect(names.has(fn)).toBe(false)
  })
})
