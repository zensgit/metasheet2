/**
 * PROPOSED (H-3, 2026-09-22) — timing + correctness proof for the user-supplied
 * regex ReDoS candidates. Each catastrophic case is paired with a LINEAR CONTROL:
 * a benign call of the same shape that must stay fast, so a fast result on the
 * fixed path is attributable to the fix, not to a machine that is simply quick.
 */
import { describe, expect, it } from 'vitest'
import { FormulaEngine } from '../engine'
import { substituteLiteral } from '../regex-safety'

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
