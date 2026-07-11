/**
 * Cluster-C path-1 batch 1: 13 standard scalar functions — PRODUCT / SIGN / PI / RADIANS / DEGREES /
 * GCD / LCM / VALUE / PROPER / TEXTJOIN / STDEVP / VARP / CHOOSE. All are pure-scalar or
 * variadic-scalar (no range/array semantics — SUMIFS/COUNTIFS-style criteria functions are excluded
 * by design and stay out of this batch). Locks per-function correct-value + edge-case + error-sentinel
 * behavior, mirroring the existing SUM/STDEV/INT/LN-style patterns already in engine.ts.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { FormulaEngine, type FormulaContext } from '../../src/formula/engine'
import { createMockDb, type MockDB } from '../utils/test-db'
import { TEST_IDS } from '../utils/test-fixtures'

describe('Cluster-C batch 1 scalar functions', () => {
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

  test('PRODUCT multiplies numeric args; non-numeric coerces to 0 (mirrors SUM); empty → 0', async () => {
    expect(await calc('=PRODUCT(2, 3, 4)')).toBe(24)
    expect(await calc('=PRODUCT(5)')).toBe(5)
    expect(await calc('=PRODUCT("x", 5)')).toBe(0) // non-numeric coerces to 0, like SUM does
    expect(await calc('=PRODUCT()')).toBe(0) // empty args → 0, matching SUM()'s empty-args convention
  })

  test('SIGN returns -1/0/1; non-numeric → #VALUE!', async () => {
    expect(await calc('=SIGN(42)')).toBe(1)
    expect(await calc('=SIGN(-7)')).toBe(-1)
    expect(await calc('=SIGN(0)')).toBe(0)
    expect(await calc('=SIGN("x")')).toBe('#VALUE!')
  })

  test('PI takes zero args and returns Math.PI', async () => {
    expect(await calc('=PI()')).toBeCloseTo(Math.PI, 12)
  })

  test('RADIANS / DEGREES convert; non-numeric → #VALUE!', async () => {
    expect(await calc('=RADIANS(180)')).toBeCloseTo(Math.PI, 12)
    expect(await calc('=RADIANS(0)')).toBe(0)
    expect(await calc('=RADIANS("x")')).toBe('#VALUE!')
    expect(await calc('=DEGREES(PI())')).toBeCloseTo(180, 9)
    expect(await calc('=DEGREES("x")')).toBe('#VALUE!')
  })

  test('GCD: truncates non-integers, GCD(0,0)=0, negative → #NUM!, non-numeric → #VALUE!', async () => {
    expect(await calc('=GCD(12, 18)')).toBe(6)
    expect(await calc('=GCD(0, 0)')).toBe(0)
    expect(await calc('=GCD(4.9, 6)')).toBe(2) // 4.9 truncates to 4; gcd(4,6)=2
    expect(await calc('=GCD(-4, 6)')).toBe('#NUM!')
    expect(await calc('=GCD("x", 6)')).toBe('#VALUE!')
  })

  test('LCM: standard case, 0 short-circuits to 0, negative → #NUM!, non-numeric → #VALUE!', async () => {
    expect(await calc('=LCM(4, 6)')).toBe(12)
    expect(await calc('=LCM(4, 0)')).toBe(0)
    expect(await calc('=LCM(-4, 6)')).toBe('#NUM!')
    expect(await calc('=LCM("x", 6)')).toBe('#VALUE!')
  })

  test('VALUE parses a number from text; unparseable/empty → #VALUE!', async () => {
    expect(await calc('=VALUE("42")')).toBe(42)
    expect(await calc('=VALUE("  3.14  ")')).toBe(3.14)
    expect(await calc('=VALUE("abc")')).toBe('#VALUE!')
    expect(await calc('=VALUE("")')).toBe('#VALUE!')
  })

  test('PROPER title-cases each letter-run; non-letters reset the boundary; non-string passthrough', async () => {
    expect(await calc('=PROPER("hello world")')).toBe('Hello World')
    expect(await calc('=PROPER("mcdonald\'s farm")')).toBe("Mcdonald'S Farm")
    expect(await calc('=PROPER(123)')).toBe('123') // no letters to titlecase
  })

  test('TEXTJOIN joins with a delimiter; ignore_empty drops blank entries', async () => {
    expect(await calc('=TEXTJOIN("-", TRUE(), "a", "", "b")')).toBe('a-b')
    expect(await calc('=TEXTJOIN("-", FALSE(), "a", "", "b")')).toBe('a--b')
    expect(await calc('=TEXTJOIN(",", TRUE(), 1, 2, 3)')).toBe('1,2,3')
  })

  test('STDEVP / VARP are population variants (divide by N, not N-1)', async () => {
    // Sample STDEV(1,2,3,4,5) ≈ 1.581 (existing golden); population divides by N instead of N-1.
    expect(await calc('=STDEVP(1, 2, 3, 4, 5)')).toBeCloseTo(1.41421356, 6)
    expect(await calc('=VARP(1, 2, 3, 4, 5)')).toBeCloseTo(2, 9)
    // A single value is a valid population (variance 0) — distinct from the sample variant, which is
    // undefined (NaN) for N<2. This is the correct population-vs-sample distinction, not an error case.
    expect(await calc('=STDEVP(4)')).toBe(0)
    expect(await calc('=VARP(4)')).toBe(0)
    // Zero args is the true degenerate case; mirrors STDEV()'s own 0-arg behavior (propagates as a
    // thrown error, caught by calculate() as '#ERROR!') rather than inventing a new sentinel.
    expect(await calc('=STDEV()')).toBe('#ERROR!')
    expect(await calc('=STDEVP()')).toBe('#ERROR!')
    expect(await calc('=VARP()')).toBe('#ERROR!')
  })

  test('CHOOSE returns the 1-based index-th value; truncates fractional index; out-of-range → #VALUE!', async () => {
    expect(await calc('=CHOOSE(2, "a", "b", "c")')).toBe('b')
    expect(await calc('=CHOOSE(1, "a", "b", "c")')).toBe('a')
    expect(await calc('=CHOOSE(1.9, "a", "b", "c")')).toBe('a') // truncates toward zero, Excel convention
    expect(await calc('=CHOOSE(5, "a", "b")')).toBe('#VALUE!')
    expect(await calc('=CHOOSE(0, "a", "b")')).toBe('#VALUE!')
    expect(await calc('=CHOOSE("x", "a", "b")')).toBe('#VALUE!')
  })

  test('the full batch-1 set is registered', () => {
    const names = new Set(engine.getRegisteredFunctionNames())
    const batch1 = ['PRODUCT', 'SIGN', 'PI', 'RADIANS', 'DEGREES', 'GCD', 'LCM', 'VALUE', 'PROPER', 'TEXTJOIN', 'STDEVP', 'VARP', 'CHOOSE']
    for (const fn of batch1) expect(names.has(fn), `missing ${fn}`).toBe(true)
    // Range/criteria functions (SUMIFS/COUNTIFS-style) are deliberately excluded from this scalar batch.
    for (const fn of ['SUMIFS', 'AVERAGEIF']) expect(names.has(fn)).toBe(false)
  })
})
