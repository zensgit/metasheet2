/**
 * Unit tests for formula dry-run (#5a, design #1860) — pure, no DB.
 * Covers: pre-eval gates (unknown field, A1/range), sentinel classification, thrown-error,
 * type-mismatch / missing-sample advisories, and the no-DB invariant (DB-query spy = 0).
 */
import { describe, expect, it } from 'vitest'

import { FormulaEngine } from '../../src/formula/engine'
import { MultitableFormulaEngine, detectUnsupportedReferences } from '../../src/multitable/formula-engine'

type EngineDb = NonNullable<ConstructorParameters<typeof FormulaEngine>[0]>['db']
const FIELDS = [
  { id: 'fld_a', type: 'number' },
  { id: 'fld_b', type: 'number' },
  { id: 'fld_s', type: 'string' },
]
// A throwing no-DB engine (the production backstop) for the gate/classification cases.
const noDb = new MultitableFormulaEngine(
  new FormulaEngine({ db: { selectFrom() { throw new Error('no db') } } as unknown as EngineDb }),
)

describe('detectUnsupportedReferences', () => {
  it('flags bare cell + range refs, ignores {fld} refs and function calls', () => {
    expect(detectUnsupportedReferences('=A1+1')).toBe(true)
    expect(detectUnsupportedReferences('=SUM(A1:B3)')).toBe(true)
    expect(detectUnsupportedReferences('={fld_a}+$A$1')).toBe(true) // absolute ref
    expect(detectUnsupportedReferences('={fld_a}+{fld_b}')).toBe(false)
    expect(detectUnsupportedReferences('=LOG10({fld_a})')).toBe(false) // function, not a cell ref
    expect(detectUnsupportedReferences('="A1 is text"')).toBe(false) // inside a string literal
  })
})

describe('MultitableFormulaEngine.dryRun', () => {
  it('evaluates a valid {fld}-only expression', async () => {
    const r = await noDb.dryRun('={fld_a}+{fld_b}', { fld_a: 2, fld_b: 3 }, FIELDS)
    expect(r.success).toBe(true)
    expect(r.result).toBe(5)
    expect(r.resultType).toBe('number')
    expect(r.referencedFields.sort()).toEqual(['fld_a', 'fld_b'])
    expect(r.diagnostics).toEqual([])
  })

  it('returns a string result for a string passthrough', async () => {
    const r = await noDb.dryRun('={fld_s}', { fld_s: 'hi' }, FIELDS)
    expect(r.success).toBe(true)
    expect(r.result).toBe('hi')
    expect(r.resultType).toBe('string')
  })

  it('classifies a #DIV/0! sentinel as a runtime error (success:false)', async () => {
    const r = await noDb.dryRun('={fld_a}/0', { fld_a: 5 }, FIELDS)
    expect(r.success).toBe(false)
    expect(r.result).toBe('#DIV/0!')
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ severity: 'error', kind: 'runtime', code: '#DIV/0!' }))
  })

  it('GATE: unknown {fld} reference → error, NOT evaluated', async () => {
    const r = await noDb.dryRun('={fld_missing}+1', { fld_missing: 9 }, FIELDS)
    expect(r.success).toBe(false)
    expect(r.result).toBeUndefined() // never evaluated → no false-green
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ kind: 'unknown_field', severity: 'error', fieldId: 'fld_missing' }))
  })

  it('GATE: A1/range reference → unsupported error, NOT evaluated', async () => {
    const r = await noDb.dryRun('={fld_a}+A1', { fld_a: 1 }, FIELDS)
    expect(r.success).toBe(false)
    expect(r.result).toBeUndefined()
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ kind: 'unsupported', severity: 'error' }))
  })

  it('type mismatch → warning, but still evaluates (no silent coercion)', async () => {
    const r = await noDb.dryRun('={fld_a}+1', { fld_a: '3' }, FIELDS) // string for a number field
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ kind: 'type_mismatch', severity: 'warning', fieldId: 'fld_a', expectedType: 'number', actualType: 'string' }))
    expect(r.success).toBeDefined() // evaluation still proceeds
  })

  it('missing sample value → info diagnostic, treated as empty', async () => {
    const r = await noDb.dryRun('={fld_a}+{fld_b}', { fld_a: 1 }, FIELDS) // fld_b missing
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ kind: 'missing_sample', severity: 'info', fieldId: 'fld_b' }))
    expect(r.success).toBe(true)
    expect(r.result).toBe(1) // fld_b → 0
  })

  it('NO-DB invariant: a {fld}-only dry-run issues ZERO DB queries', async () => {
    let dbCalls = 0
    const spy = new MultitableFormulaEngine(
      new FormulaEngine({ db: { selectFrom() { dbCalls++; return undefined } } as unknown as EngineDb }),
    )
    const r = await spy.dryRun('={fld_a}*{fld_b}', { fld_a: 4, fld_b: 5 }, FIELDS)
    expect(r.success).toBe(true)
    expect(r.result).toBe(20)
    expect(dbCalls).toBe(0) // the gate keeps cell/range refs out → engine never touches the DB
  })
})
