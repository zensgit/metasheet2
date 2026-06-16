/**
 * Native person field (人员, design 2026-06-16) — filter/sort semantics (pure functions, no DB).
 *
 * FILTER: a native person value is a `userId[]`. It reuses the multiSelect-parity path
 * (the string fallback in evaluateMetaFilterCondition) — `contains` matches a userId inside
 * the array, and `isEmpty`/`isNotEmpty` use the shared empty-array nullish rule. No dedicated
 * person filter branch is needed; this test PINS that the shared path gives the right answers.
 *
 * SORT-by-display: compareMetaSortValue's string fallback orders a raw `userId[]` lexicographically.
 * The view endpoint injects the resolved DISPLAY string before sorting (resolvePersonSortDisplayMap),
 * which is exercised on the real `/view` wire (DB-gated). Here we PIN the raw-array fallback so the
 * "display injection happens at the view layer, not in the comparator" contract is explicit.
 */
import { describe, expect, it } from 'vitest'

import { compareMetaSortValue, evaluateMetaFilterCondition } from '../../src/routes/univer-meta'

const cond = (operator: string, value?: unknown) => ({ fieldId: 'f', operator, value })

describe('native person filter (multiSelect-parity over userId[])', () => {
  it('isEmpty / isNotEmpty over the userId array', () => {
    expect(evaluateMetaFilterCondition('person', [], cond('isEmpty'))).toBe(true)
    expect(evaluateMetaFilterCondition('person', null, cond('isEmpty'))).toBe(true)
    expect(evaluateMetaFilterCondition('person', ['u1'], cond('isEmpty'))).toBe(false)
    expect(evaluateMetaFilterCondition('person', ['u1'], cond('isNotEmpty'))).toBe(true)
    expect(evaluateMetaFilterCondition('person', [], cond('isNotEmpty'))).toBe(false)
  })

  it('contains a specific userId', () => {
    expect(evaluateMetaFilterCondition('person', ['u1', 'u2'], cond('contains', 'u2'))).toBe(true)
    expect(evaluateMetaFilterCondition('person', ['u1', 'u2'], cond('contains', 'u3'))).toBe(false)
    // empty filter value → no-op match (shared text-path semantics)
    expect(evaluateMetaFilterCondition('person', ['u1'], cond('contains', ''))).toBe(true)
  })

  it('doesNotContain a userId', () => {
    expect(evaluateMetaFilterCondition('person', ['u1', 'u2'], cond('doesNotContain', 'u3'))).toBe(true)
    expect(evaluateMetaFilterCondition('person', ['u1', 'u2'], cond('doesNotContain', 'u1'))).toBe(false)
  })
})

describe('native person sort (raw-array fallback; display injected at the view layer)', () => {
  it('orders by the stringified userId array in the comparator (view layer substitutes display)', () => {
    // Without the view-layer display injection, the comparator sees raw ids. This PINS that
    // the comparator itself is display-agnostic — sort-by-display is a view-endpoint concern.
    const rows = [['u_charlie'], ['u_alice'], ['u_bob']]
    const sorted = [...rows].sort((a, b) => compareMetaSortValue('person', a, b, false))
    expect(sorted).toEqual([['u_alice'], ['u_bob'], ['u_charlie']])
  })

  it('empty person cells sort last (nullish-last rule)', () => {
    const rows: unknown[] = [['u_b'], [], ['u_a']]
    const sorted = [...rows].sort((a, b) => compareMetaSortValue('person', a, b, false))
    expect(sorted).toEqual([['u_a'], ['u_b'], []])
  })
})
