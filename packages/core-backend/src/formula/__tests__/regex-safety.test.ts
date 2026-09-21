/**
 * PROPOSED (H-3, 2026-09-22) — timing + correctness proof for the user-supplied
 * regex ReDoS candidates. Each catastrophic case is paired with a LINEAR CONTROL:
 * a benign call of the same shape that must stay fast, so a fast result on the
 * fixed path is attributable to the fix, not to a machine that is simply quick.
 */
import { describe, expect, it } from 'vitest'
import { FormulaEngine } from '../engine'
import {
  substituteLiteral,
  assessUserPattern,
  hasNestedUnboundedQuantifier,
  USER_REGEX_MAX_SUBJECT_LEN,
} from '../regex-safety'

const engine = new FormulaEngine({ db: undefined as never })
const ctx = { sheetId: 's', row: 1, col: 1, values: {} } as never

async function evalMs(formula: string): Promise<{ ms: number; result: unknown }> {
  const t0 = process.hrtime.bigint()
  const result = await engine.calculate(formula, ctx)
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, result }
}

describe('SUBSTITUTE — literal replacement (Excel/Sheets semantics), no regex', () => {
  it('replaces literally and treats arg-2 metacharacters as literal text', () => {
    expect(substituteLiteral('a.b.c', '.', '-')).toBe('a-b-c')
    // Prior regex impl would treat "a+" as a quantifier; literal must match "a+".
    expect(substituteLiteral('xa+y', 'a+', 'Z')).toBe('xZy')
    expect(substituteLiteral('hello', '', '-')).toBe('hello') // empty old-text: unchanged
  })

  it('POSITIVE: a nested-quantifier arg-2 no longer backtracks (was ~300ms+, now sub-ms)', async () => {
    const subject = 'a'.repeat(30) + '!'
    const { ms, result } = await evalMs(`SUBSTITUTE("${subject}", "^(a+)+$", "X")`)
    // Literal: no "^(a+)+$" substring is present, so the text is returned verbatim.
    expect(result).toBe(subject)
    expect(ms).toBeLessThan(50)
  })

  it('LINEAR CONTROL: ordinary SUBSTITUTE stays correct and fast', async () => {
    const { ms, result } = await evalMs('SUBSTITUTE("2026-09-22", "-", "/")')
    expect(result).toBe('2026/09/22')
    expect(ms).toBeLessThan(50)
  })
})

describe('assessUserPattern — static catastrophic-shape rejection', () => {
  it('flags nested unbounded quantifiers, passes linear patterns', () => {
    expect(hasNestedUnboundedQuantifier('^(a+)+$')).toBe(true)
    expect(hasNestedUnboundedQuantifier('(?:x+)*')).toBe(true)
    expect(hasNestedUnboundedQuantifier('(\\d+){2,}')).toBe(true)
    expect(hasNestedUnboundedQuantifier('^[a-z0-9-]+$')).toBe(false)
    expect(hasNestedUnboundedQuantifier('^\\d{4}-\\d{2}$')).toBe(false)
    // Char-class contents must not be mistaken for a quantified group.
    expect(hasNestedUnboundedQuantifier('[(+*)]+')).toBe(false)
    expect(assessUserPattern('^(a+)+$').safe).toBe(false)
    expect(assessUserPattern('^[a-z]+$').safe).toBe(true)
    expect(assessUserPattern('x'.repeat(2000)).safe).toBe(false)
  })
})

describe('REGEXMATCH/EXTRACT/REPLACE — bounded, no cross-tenant freeze', () => {
  it('POSITIVE: REGEXMATCH nested-quantifier pattern is refused, returns fast', async () => {
    const subject = 'a'.repeat(32) + '!' // unfixed: measured ~20s in-process
    const { ms, result } = await evalMs(`REGEXMATCH("${subject}", "^(a+)+$")`)
    expect(result).toBe('#ERROR!')
    expect(ms).toBeLessThan(200)
  })

  it('POSITIVE: REGEXREPLACE trim-idiom pattern on an over-long subject is refused fast', async () => {
    const subject = 'Z' + ' '.repeat(USER_REGEX_MAX_SUBJECT_LEN + 50000) + 'Z'
    const { ms, result } = await evalMs(`REGEXREPLACE("${subject}", "^\\\\s+|\\\\s+$", "")`)
    expect(result).toBe('#ERROR!')
    expect(ms).toBeLessThan(200)
  })

  it('LINEAR CONTROL: a legitimate linear pattern still works', async () => {
    const m = await evalMs('REGEXMATCH("hello-world", "^[a-z-]+$")')
    expect(m.result).toBe(true)
    expect(m.ms).toBeLessThan(50)
    const r = await evalMs('REGEXREPLACE("a1b2c3", "[0-9]", "")')
    expect(r.result).toBe('abc')
    expect(r.ms).toBeLessThan(50)
    const e = await evalMs('REGEXEXTRACT("id=42", "id=([0-9]+)")')
    expect(e.result).toBe('42')
  })
})
