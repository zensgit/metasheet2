/**
 * A-min (formula-over-lookup, design #2246) — value-source unit coverage.
 *
 * Proves the multitable wrapper evaluates a formula against a row whose lookup value is PRESENT
 * (hydrated) — yielding the actual value, not the absent-on-reload `undefined → '0'` — and that
 * recalculateRecordFromData writes back ONLY formula keys (lookup/rollup are NOT materialized).
 * The same-record TRIGGER + the real wire are covered in the real-DB integration test
 * (tests/integration/multitable-formula-over-lookup-view.test.ts).
 *
 * NOTE on numeric semantics (observed, not assumed): a single-value scalar lookup hydrates as an
 * array (e.g. [5]); evaluateField joins a scalar array into a string literal ("5"), and the frozen
 * base engine coerces it numerically in arithmetic — so `={LU}+1` over [5] = 6, `={LU}*2` = 10.
 * A bare `={LU}` yields the value-as-string ("5"/"beta"); a multi-value lookup joins to a string
 * ("5,7"). Correct numeric arithmetic over MULTI-value lookups is Option D (parser), out of A-min.
 */
import { describe, expect, it, vi } from 'vitest'

import { MultitableFormulaEngine } from '../../src/multitable/formula-engine'

const fields = [
  { id: 'fld_lu', name: 'LU', type: 'lookup' as const },
  { id: 'fld_f', name: 'F', type: 'formula' as const },
]

describe('A-min value source: evaluateField over a hydrated (array-valued) lookup', () => {
  const eng = new MultitableFormulaEngine()

  it('single-value numeric lookup is numerically usable in arithmetic (was: computes against 0)', async () => {
    expect(await eng.evaluateField('={fld_lu}+1', { fld_lu: [5] } as any, fields as any)).toBe(6)
    expect(await eng.evaluateField('={fld_lu}*2', { fld_lu: [5] } as any, fields as any)).toBe(10)
  })

  it('absent lookup (the pre-fix bug) computes against 0', async () => {
    expect(await eng.evaluateField('={fld_lu}+1', {} as any, fields as any)).toBe(1)
    expect(await eng.evaluateField('={fld_lu}', {} as any, fields as any)).toBe(0)
  })

  it('bare lookup reaches eval as its value-as-string (string + numeric)', async () => {
    expect(await eng.evaluateField('={fld_lu}', { fld_lu: ['beta'] } as any, fields as any)).toBe('beta')
    expect(await eng.evaluateField('={fld_lu}', { fld_lu: [5] } as any, fields as any)).toBe('5')
  })

  it('multi-value scalar lookup joins to a string (no arithmetic; Option-D territory)', async () => {
    expect(await eng.evaluateField('={fld_lu}', { fld_lu: [5, 7] } as any, fields as any)).toBe('5,7')
  })

  it('object-valued lookup → #VALUE! (A2b), never a fake join or 0', async () => {
    expect(await eng.evaluateField('={fld_lu}', { fld_lu: [{ a: 1 }] } as any, fields as any)).toBe('#VALUE!')
  })

  it('rollup hydrates as a scalar number (cleaner than lookup) and is numerically usable', async () => {
    // rollup aggregates to a number|null, so no array-join — `={ru}+1` over 5 = 6 directly.
    const rfields = [{ id: 'fld_ru', name: 'RU', type: 'rollup' as const }, ...fields]
    expect(await eng.evaluateField('={fld_ru}+1', { fld_ru: 5 } as any, rfields as any)).toBe(6)
    expect(await eng.evaluateField('={fld_ru}', { fld_ru: 5 } as any, rfields as any)).toBe(5)
  })
})

describe('A-min value source: recalculateRecordFromData evals against PROVIDED hydrated data', () => {
  it('computes the formula from the hydrated lookup and writes back ONLY formula keys', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] })
      return { rows: [], rowCount: 1 }
    })
    const eng = new MultitableFormulaEngine()
    const ffields = [
      { id: 'fld_lu', name: 'LU', type: 'lookup' as const },
      { id: 'fld_f', name: 'F', type: 'formula' as const, property: { expression: '={fld_lu}+1' } },
    ]
    // hydrated row: lookup already resolved in-memory (the write-path Step-4 snapshot)
    const hydrated = { fld_lu: [5] }

    const next = await eng.recalculateRecordFromData(query as any, 'sheet_1', 'rec_1', hydrated as any, ffields as any)

    // returns the formula computed from the hydrated lookup (6 = 5 + 1), not 1 (absent→0)
    expect(next).toMatchObject({ fld_f: 6 })

    // exactly one UPDATE, merging ONLY the formula key — lookup value is NOT materialized
    const update = calls.find((c) => /UPDATE meta_records/.test(c.sql))
    expect(update).toBeTruthy()
    const writtenBack = JSON.parse(String(update!.params[0]))
    expect(writtenBack).toEqual({ fld_f: 6 })
    expect('fld_lu' in writtenBack).toBe(false) // lookup NOT persisted
    // no SELECT reload — recalculateRecordFromData evaluates against the provided data
    expect(calls.some((c) => /SELECT/.test(c.sql))).toBe(false)
  })
})
