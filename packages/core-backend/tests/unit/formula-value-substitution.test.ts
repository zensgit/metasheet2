/**
 * A2b — value-substitution hardening for MultitableFormulaEngine.evaluateField (shared by record
 * recalc + dry-run). Regression-pins scalar substitution (unchanged), locks the new complex-value
 * contract (array → quoted joined literal; object/other → #VALUE!), and proves no expression
 * injection from malicious string/array values. Pure, no DB (only {fld} refs).
 */
import { describe, expect, it } from 'vitest'

import { FormulaEngine } from '../../src/formula/engine'
import { MultitableFormulaEngine } from '../../src/multitable/formula-engine'

type EngineDb = NonNullable<ConstructorParameters<typeof FormulaEngine>[0]>['db']
const FIELDS = [
  { id: 'fld_a', type: 'number' },
  { id: 'fld_s', type: 'string' },
]
const engine = new MultitableFormulaEngine(
  new FormulaEngine({ db: { selectFrom() { throw new Error('no db') } } as unknown as EngineDb }),
)
const evalField = (expr: string, data: Record<string, unknown>) => engine.evaluateField(expr, data, FIELDS)

describe('evaluateField — scalar substitution (regression: unchanged by A2b)', () => {
  it('number computes', async () => {
    expect(await evalField('={fld_a}+1', { fld_a: 5 })).toBe(6)
  })
  it('null/undefined → 0', async () => {
    expect(await evalField('={fld_a}+1', { fld_a: null })).toBe(1)
    expect(await evalField('={fld_a}+1', {})).toBe(1)
  })
  it('string passes through as a (quoted) literal', async () => {
    expect(await evalField('={fld_s}', { fld_s: 'hi' })).toBe('hi')
  })
})

describe('evaluateField — complex values (A2b contract)', () => {
  it('SCALAR array → quoted joined string literal (value preserved)', async () => {
    expect(await evalField('={fld_s}', { fld_s: ['a', 'b'] })).toBe('a,b')
    expect(await evalField('={fld_s}', { fld_s: [1, 2] })).toBe('1,2')
  })
  it('object → #VALUE! (not "[object Object]")', async () => {
    expect(await evalField('={fld_s}', { fld_s: { x: 1 } })).toBe('#VALUE!')
  })
  it('object anywhere in the expression errors the whole field', async () => {
    expect(await evalField('={fld_a}+1', { fld_a: { x: 1 } })).toBe('#VALUE!')
  })
  // the real lookup shape: a multi-value lookup of an object/location-valued field → array of objects
  it('array of OBJECTS → #VALUE! (NOT a fake "[object Object]" join)', async () => {
    expect(await evalField('={fld_s}', { fld_s: [{ x: 1 }, { y: 2 }] })).toBe('#VALUE!')
  })
  it('mixed scalar+object array → #VALUE!', async () => {
    expect(await evalField('={fld_s}', { fld_s: ['a', { x: 1 }] })).toBe('#VALUE!')
  })
})

describe('evaluateField — no injection from value content (A2b core)', () => {
  it('a string with quotes/operators is a single literal, not executed', async () => {
    expect(await evalField('={fld_s}', { fld_s: 'a"; 1+1 ;"b' })).toBe('a"; 1+1 ;"b')
  })
  it('a string "1+1" stays the literal text, not evaluated to 2', async () => {
    expect(await evalField('={fld_s}', { fld_s: '1+1' })).toBe('1+1')
  })
  it('a string containing a {fld} token is not re-expanded', async () => {
    expect(await evalField('={fld_s}', { fld_s: '{fld_a}' })).toBe('{fld_a}')
  })
  it('an array element with a quote stays quoted-safe (no injection)', async () => {
    expect(await evalField('={fld_s}', { fld_s: ['x"', 'y'] })).toBe('x",y')
  })
  it('a very long string does not break substitution', async () => {
    const long = 'z'.repeat(5000)
    expect(await evalField('={fld_s}', { fld_s: long })).toBe(long)
  })
})
