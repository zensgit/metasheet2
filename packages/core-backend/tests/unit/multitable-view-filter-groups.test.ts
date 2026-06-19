/**
 * 2a nested AND/OR filter groups — pure-helper goldens, with the anti-oracle / redaction security
 * properties as the centerpiece. The nested tree must recurse correctly through eval, the anti-oracle
 * prune, redaction, and the re-save merge guard; a miss at any one leaks or erases permission data.
 * Flat (group-less) filters must remain byte-for-byte unchanged (backward compat).
 */
import { describe, test, expect } from 'vitest'
import {
  parseMetaFilterInfo,
  matchesFilterInfo,
  pruneFilterInfoByField,
  redactViewConfigFilterLiterals,
  mergeRedactedFilterInfoForUpdate,
} from '../../src/routes/univer-meta'

const cond = (fieldId: string, value?: unknown) => ({ fieldId, operator: 'is', ...(value !== undefined ? { value } : {}) })

describe('2a nested filter groups — parse + caps', () => {
  test('flat form is unchanged (no group field)', () => {
    const fi = parseMetaFilterInfo({ conjunction: 'or', conditions: [cond('a', 1), cond('b', 2)] })
    expect(fi).not.toBeNull()
    expect(fi!.conjunction).toBe('or')
    expect(fi!.group).toBeUndefined()
    expect(fi!.conditions.map((c) => c.fieldId)).toEqual(['a', 'b'])
  })

  test('group form parses + mirrors ALL leaves into conditions', () => {
    const fi = parseMetaFilterInfo({
      group: { conjunction: 'or', children: [cond('a', 1), { conjunction: 'and', children: [cond('b', 2), cond('c', 3)] }] },
    })
    expect(fi).not.toBeNull()
    expect(fi!.group).toBeDefined()
    expect(fi!.conditions.map((c) => c.fieldId).sort()).toEqual(['a', 'b', 'c']) // flattened mirror = every leaf
  })

  test('caps: over-depth, over-count, and empty groups are rejected (→ null = no filter)', () => {
    // 6 nested groups exceeds MAX depth (5).
    let deep: any = cond('x', 1)
    for (let i = 0; i < 6; i++) deep = { conjunction: 'and', children: [deep] }
    expect(parseMetaFilterInfo({ group: deep })).toBeNull()
    // > 50 leaf conditions.
    const many = { conjunction: 'or', children: Array.from({ length: 51 }, (_, i) => cond(`f${i}`, i)) }
    expect(parseMetaFilterInfo({ group: many })).toBeNull()
    // empty group.
    expect(parseMetaFilterInfo({ group: { conjunction: 'and', children: [] } })).toBeNull()
  })
})

describe('2a nested filter groups — eval truth tables', () => {
  const truthy = (...ids: string[]) => (c: { fieldId: string }) => new Set(ids).has(c.fieldId)

  test('(A AND B) OR C', () => {
    const fi = parseMetaFilterInfo({
      group: { conjunction: 'or', children: [{ conjunction: 'and', children: [cond('A'), cond('B')] }, cond('C')] },
    })!
    expect(matchesFilterInfo(fi, truthy('A', 'B'))).toBe(true)  // left branch true
    expect(matchesFilterInfo(fi, truthy('C'))).toBe(true)       // right branch true
    expect(matchesFilterInfo(fi, truthy('A'))).toBe(false)      // A true, B false, C false → false
    expect(matchesFilterInfo(fi, truthy())).toBe(false)
  })

  test('flat eval still works (and / or)', () => {
    const andFi = parseMetaFilterInfo({ conjunction: 'and', conditions: [cond('A'), cond('B')] })!
    expect(matchesFilterInfo(andFi, truthy('A', 'B'))).toBe(true)
    expect(matchesFilterInfo(andFi, truthy('A'))).toBe(false)
    const orFi = parseMetaFilterInfo({ conjunction: 'or', conditions: [cond('A'), cond('B')] })!
    expect(matchesFilterInfo(orFi, truthy('B'))).toBe(true)
  })
})

describe('2a nested filter groups — ANTI-ORACLE prune (security)', () => {
  const keep = (...allowed: string[]) => (fieldId: string) => new Set(allowed).has(fieldId)

  test('a denied-field leaf nested in a group is DROPPED and never evaluated', () => {
    const fi = parseMetaFilterInfo({
      group: { conjunction: 'and', children: [cond('pub', 1), { conjunction: 'or', children: [cond('secret', 'x'), cond('pub2', 2)] }] },
    })!
    const pruned = pruneFilterInfoByField(fi, keep('pub', 'pub2')) // 'secret' denied
    expect(pruned).not.toBeNull()
    // the surviving leaves contain NO denied field
    expect(pruned!.conditions.some((c) => c.fieldId === 'secret')).toBe(false)
    // and eval of the pruned tree never consults 'secret' (would-be-true 'secret' must not flip the result)
    const sawSecret = { hit: false }
    matchesFilterInfo(pruned!, (c) => { if (c.fieldId === 'secret') sawSecret.hit = true; return true })
    expect(sawSecret.hit).toBe(false)
  })

  test('a group whose every leaf is denied collapses to null (no filter)', () => {
    const fi = parseMetaFilterInfo({ group: { conjunction: 'or', children: [cond('s1'), cond('s2')] } })!
    expect(pruneFilterInfoByField(fi, keep('other'))).toBeNull()
  })

  test('flat prune unchanged', () => {
    const fi = parseMetaFilterInfo({ conjunction: 'and', conditions: [cond('a'), cond('secret')] })!
    const pruned = pruneFilterInfoByField(fi, keep('a'))
    expect(pruned!.conditions.map((c) => c.fieldId)).toEqual(['a'])
    expect(pruned!.group).toBeUndefined()
  })
})

describe('2a nested filter groups — redaction (security)', () => {
  const allowed = new Set(['pub'])

  test('a denied literal nested in a group is omitted (recursively)', () => {
    const view = { filterInfo: { group: { conjunction: 'and', children: [cond('pub', 1), { conjunction: 'or', children: [cond('secret', 'LEAK')] }] } } }
    const out = redactViewConfigFilterLiterals(view, allowed) as any
    const deniedLeaf = out.filterInfo.group.children[1].children[0]
    expect(deniedLeaf.fieldId).toBe('secret')
    expect(Object.prototype.hasOwnProperty.call(deniedLeaf, 'value')).toBe(false) // literal omitted
    // allowed leaf keeps its value
    expect(out.filterInfo.group.children[0].value).toBe(1)
  })

  test('group-only filterInfo (no conditions array) is STILL redacted (the early-return gap)', () => {
    const view = { filterInfo: { group: { conjunction: 'and', children: [cond('secret', 'LEAK')] } } }
    const out = redactViewConfigFilterLiterals(view, allowed) as any
    expect(Object.prototype.hasOwnProperty.call(out.filterInfo.group.children[0], 'value')).toBe(false)
  })

  test('fully-allowed group is returned unchanged (same ref, no needless copy)', () => {
    const view = { filterInfo: { group: { conjunction: 'and', children: [cond('pub', 1)] } } }
    expect(redactViewConfigFilterLiterals(view, allowed)).toBe(view)
  })
})

describe('2a nested filter groups — re-save merge guard (security, fail-closed)', () => {
  const allowed = new Set(['pub'])

  test('a denied leaf that lost its value (redacted) → REJECT (null), never silently erased', () => {
    const incoming = { group: { conjunction: 'and', children: [cond('pub', 1), cond('secret')] } } // secret has NO value
    expect(mergeRedactedFilterInfoForUpdate(incoming, null, allowed)).toBeNull()
  })

  test('a denied leaf that still carries its own value → nothing to protect → pass through', () => {
    const incoming = { group: { conjunction: 'and', children: [cond('secret', 'explicit')] } }
    expect(mergeRedactedFilterInfoForUpdate(incoming, null, allowed)).toBe(incoming)
  })

  test('a fully-allowed group → pass through', () => {
    const incoming = { group: { conjunction: 'and', children: [cond('pub', 1)] } }
    expect(mergeRedactedFilterInfoForUpdate(incoming, null, allowed)).toBe(incoming)
  })

  test('flat form merge is unchanged (denied-no-value restored from current by index)', () => {
    const incoming = { conditions: [cond('secret')] } // denied, no value (came back redacted)
    const current = { conditions: [cond('secret', 'restore-me')] }
    const merged = mergeRedactedFilterInfoForUpdate(incoming, current, allowed) as any
    expect(merged.conditions[0].value).toBe('restore-me')
  })
})
