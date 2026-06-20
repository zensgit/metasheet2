/**
 * 2a filter-by-link (first cut) — pure leaf evaluator `evaluateLinkFilterCondition`.
 *
 * Two evaluation bases, by design (multitable-2a-filter-by-link-lookup-designlock §2 / D5·D6):
 *   • PRESENCE (isEmpty / isNotEmpty) → RAW link id count. Permission-INVARIANT; touches no display.
 *   • VALUE (contains / is) → the PERMISSION-FILTERED visible display set (denied links already excluded
 *     upstream). contains = any visible display contains substring; is = membership (exact equals one).
 *
 * The keystone security case (the D5 leak this split avoids): a row whose links are ALL hidden from the
 * requester has rawLinkIds.length > 0 but visibleDisplays = []. isEmpty MUST stay false (it HAS links) so
 * the restricted user never sees an "empty" match a full-permission user wouldn't; contains/is MUST NOT
 * match (nothing visible to match, no display string leaks).
 */
import { describe, expect, it } from 'vitest'
import { evaluateLinkFilterCondition } from '../../src/routes/univer-meta'

const cond = (operator: string, value?: unknown) => ({ fieldId: 'link1', operator, value })

describe('evaluateLinkFilterCondition — presence (raw, permission-invariant)', () => {
  it('isEmpty: true only when there are no raw link ids', () => {
    expect(evaluateLinkFilterCondition([], [], cond('isEmpty'))).toBe(true)
    expect(evaluateLinkFilterCondition(['r1'], ['Acme'], cond('isEmpty'))).toBe(false)
  })

  it('isNotEmpty: true when there is at least one raw link id', () => {
    expect(evaluateLinkFilterCondition(['r1'], ['Acme'], cond('isNotEmpty'))).toBe(true)
    expect(evaluateLinkFilterCondition([], [], cond('isNotEmpty'))).toBe(false)
  })

  it('presence ignores visibleDisplays entirely (permission-invariant)', () => {
    // same raw ids, different visible sets (full vs all-denied) → identical presence result
    expect(evaluateLinkFilterCondition(['r1'], ['Acme'], cond('isEmpty'))).toBe(false)
    expect(evaluateLinkFilterCondition(['r1'], [], cond('isEmpty'))).toBe(false)
    expect(evaluateLinkFilterCondition(['r1'], ['Acme'], cond('isNotEmpty'))).toBe(true)
    expect(evaluateLinkFilterCondition(['r1'], [], cond('isNotEmpty'))).toBe(true)
  })
})

describe('evaluateLinkFilterCondition — value (permission-filtered display set)', () => {
  it('contains: case/space-insensitive substring over any visible display (D6 any)', () => {
    expect(evaluateLinkFilterCondition(['r1', 'r2'], ['Acme Corp', 'Globex'], cond('contains', 'acme'))).toBe(true)
    expect(evaluateLinkFilterCondition(['r1', 'r2'], ['Acme Corp', 'Globex'], cond('contains', 'GLOB'))).toBe(true)
    expect(evaluateLinkFilterCondition(['r1', 'r2'], ['Acme Corp', 'Globex'], cond('contains', 'initech'))).toBe(false)
  })

  it('contains with empty value = match-all (mirrors string-branch convention)', () => {
    expect(evaluateLinkFilterCondition(['r1'], ['Acme'], cond('contains', ''))).toBe(true)
    expect(evaluateLinkFilterCondition([], [], cond('contains', ''))).toBe(true)
  })

  it('is: membership — any visible display equals the value exactly, not whole-set equality (D6)', () => {
    expect(evaluateLinkFilterCondition(['r1', 'r2'], ['Acme', 'Globex'], cond('is', 'Acme'))).toBe(true)
    expect(evaluateLinkFilterCondition(['r1', 'r2'], ['Acme', 'Globex'], cond('is', 'globex'))).toBe(true)
    // substring is NOT a match for `is`
    expect(evaluateLinkFilterCondition(['r1'], ['Acme Corp'], cond('is', 'Acme'))).toBe(false)
  })
})

describe('evaluateLinkFilterCondition — D5 keystone: all-links-hidden row', () => {
  const allHidden = ['hiddenRecA', 'hiddenRecB'] // raw ids exist…
  const noVisible: string[] = [] // …but none are visible to the requester

  it('isEmpty stays FALSE for an all-hidden-links row (no empty-for-restricted / non-empty-for-full leak)', () => {
    expect(evaluateLinkFilterCondition(allHidden, noVisible, cond('isEmpty'))).toBe(false)
    expect(evaluateLinkFilterCondition(allHidden, noVisible, cond('isNotEmpty'))).toBe(true)
  })

  it('value operators never match via a hidden link (no display-string leak)', () => {
    expect(evaluateLinkFilterCondition(allHidden, noVisible, cond('contains', 'hidden'))).toBe(false)
    expect(evaluateLinkFilterCondition(allHidden, noVisible, cond('is', 'hiddenRecA'))).toBe(false)
  })
})

describe('evaluateLinkFilterCondition — first-cut scope', () => {
  it('operators outside contains/is/isEmpty/isNotEmpty are inert (match-all), mirroring the catch-all', () => {
    expect(evaluateLinkFilterCondition(['r1'], ['Acme'], cond('isNot', 'Acme'))).toBe(true)
    expect(evaluateLinkFilterCondition(['r1'], ['Acme'], cond('doesNotContain', 'Acme'))).toBe(true)
    expect(evaluateLinkFilterCondition(['r1'], ['Acme'], cond('isAnyOf', ['Acme']))).toBe(true)
  })

  it('operator matching is case/space-tolerant on the operator token', () => {
    expect(evaluateLinkFilterCondition([], [], cond(' IsEmpty '))).toBe(true)
    expect(evaluateLinkFilterCondition(['r1'], ['Acme'], cond('CONTAINS', 'acme'))).toBe(true)
  })
})
