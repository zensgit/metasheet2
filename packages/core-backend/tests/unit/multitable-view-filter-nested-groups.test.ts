/**
 * 2a nested filter groups — recursive view-filter model.
 *
 * Covers the pure helpers that carry ALL the security-critical logic for nested AND/OR groups:
 *   parse (recursive, depth-bounded, back-compat) / evaluate / collect-leaves / prune /
 *   redact-out (denied literals) / merge-on-save (preserve denied literals).
 *
 * The four security-gate cases (a denied/hidden field nested inside a subgroup) are the contract:
 *   (1) redact-out OMITS its value to the client;
 *   (2) it still trips leaf-collection (computed-/denied-field detection);
 *   (3) a re-save with the value omitted RESTORES the literal from the stored view;
 *   (4) a re-save that structurally changes the nesting around the denied leaf is REJECTED (→ 400).
 */
import { describe, expect, it } from 'vitest'
import {
  parseMetaFilterInfo,
  evaluateFilterNode,
  collectLeafConditions,
  pruneFilterNode,
  isFilterGroup,
  redactViewConfigFilterLiterals,
  mergeRedactedFilterInfoForUpdate,
  type MetaFilterNode,
} from '../../src/routes/univer-meta'

const leaf = (fieldId: string, value?: unknown) =>
  value === undefined ? { fieldId, operator: 'is' } : { fieldId, operator: 'is', value }
// Simple equality leaf-evaluator so the tests exercise the TREE logic (AND/OR/nesting), not the
// per-leaf operator semantics (those are covered by the evaluateMetaFilterCondition suites).
const evalAgainst = (record: Record<string, unknown>) => (c: { fieldId: string; value?: unknown }) =>
  record[c.fieldId] === c.value

describe('nested filter groups — parse', () => {
  it('parses a flat filter identically (backward-compatible degenerate single group)', () => {
    const parsed = parseMetaFilterInfo({ conjunction: 'or', conditions: [leaf('a', 1), leaf('b', 2)] })
    expect(parsed).toEqual({ conjunction: 'or', conditions: [{ fieldId: 'a', operator: 'is', value: 1 }, { fieldId: 'b', operator: 'is', value: 2 }] })
  })

  it('parses a nested subgroup into a tree', () => {
    const parsed = parseMetaFilterInfo({
      conjunction: 'and',
      conditions: [leaf('a', 1), { conjunction: 'or', conditions: [leaf('b', 2), leaf('c', 3)] }],
    })
    expect(parsed?.conjunction).toBe('and')
    expect(parsed?.conditions.length).toBe(2)
    expect(isFilterGroup(parsed!.conditions[1])).toBe(true)
    expect((parsed!.conditions[1] as { conjunction: string }).conjunction).toBe('or')
  })

  it('drops malformed leaves, empty groups, and ambiguous (group+leaf) nodes', () => {
    const parsed = parseMetaFilterInfo({
      conjunction: 'and',
      conditions: [
        leaf('a', 1),
        { operator: 'is' }, // no fieldId → dropped
        { conjunction: 'and', conditions: [] }, // empty group → dropped
        { fieldId: 'x', operator: 'is', conditions: [leaf('y', 9)] }, // BOTH shapes → dropped (read path is lenient)
      ],
    })
    expect(parsed?.conditions).toEqual([{ fieldId: 'a', operator: 'is', value: 1 }])
  })

  it('caps recursion depth — a too-deep subtree is trimmed while shallow siblings survive', () => {
    // 6 levels of nesting (root=d0 → groups d1..d6) collapses; a shallow sibling leaf is kept.
    let deep: MetaFilterNode = leaf('deep', 1)
    for (let i = 0; i < 6; i++) deep = { conjunction: 'and', conditions: [deep] } as MetaFilterNode
    const parsed = parseMetaFilterInfo({ conjunction: 'and', conditions: [leaf('shallow', 1), deep] })
    expect(parsed?.conditions).toEqual([{ fieldId: 'shallow', operator: 'is', value: 1 }])
  })
})

describe('nested filter groups — evaluate', () => {
  it('flat AND / OR', () => {
    const andF = parseMetaFilterInfo({ conjunction: 'and', conditions: [leaf('a', 1), leaf('b', 2)] })!
    expect(evaluateFilterNode(andF, evalAgainst({ a: 1, b: 2 }))).toBe(true)
    expect(evaluateFilterNode(andF, evalAgainst({ a: 1, b: 9 }))).toBe(false)
    const orF = parseMetaFilterInfo({ conjunction: 'or', conditions: [leaf('a', 1), leaf('b', 2)] })!
    expect(evaluateFilterNode(orF, evalAgainst({ a: 9, b: 2 }))).toBe(true)
    expect(evaluateFilterNode(orF, evalAgainst({ a: 9, b: 9 }))).toBe(false)
  })

  it('A AND (B OR C)', () => {
    const f = parseMetaFilterInfo({
      conjunction: 'and',
      conditions: [leaf('a', 1), { conjunction: 'or', conditions: [leaf('b', 2), leaf('c', 3)] }],
    })!
    expect(evaluateFilterNode(f, evalAgainst({ a: 1, b: 2, c: 0 }))).toBe(true) // a ok, B branch ok
    expect(evaluateFilterNode(f, evalAgainst({ a: 1, b: 0, c: 3 }))).toBe(true) // a ok, C branch ok
    expect(evaluateFilterNode(f, evalAgainst({ a: 1, b: 0, c: 0 }))).toBe(false) // a ok, neither B nor C
    expect(evaluateFilterNode(f, evalAgainst({ a: 9, b: 2, c: 3 }))).toBe(false) // a fails → whole AND fails
  })

  it('A OR (B AND C)', () => {
    const f = parseMetaFilterInfo({
      conjunction: 'or',
      conditions: [leaf('a', 1), { conjunction: 'and', conditions: [leaf('b', 2), leaf('c', 3)] }],
    })!
    expect(evaluateFilterNode(f, evalAgainst({ a: 1, b: 0, c: 0 }))).toBe(true) // a ok
    expect(evaluateFilterNode(f, evalAgainst({ a: 9, b: 2, c: 3 }))).toBe(true) // B AND C ok
    expect(evaluateFilterNode(f, evalAgainst({ a: 9, b: 2, c: 0 }))).toBe(false) // a fails, B AND C incomplete
  })
})

describe('nested filter groups — collectLeafConditions (flat-list consumers)', () => {
  it('flattens every leaf across nesting (depth-first, order-preserving)', () => {
    const f = parseMetaFilterInfo({
      conjunction: 'and',
      conditions: [leaf('a', 1), { conjunction: 'or', conditions: [leaf('b', 2), { conjunction: 'and', conditions: [leaf('c', 3)] }] }],
    })!
    expect(collectLeafConditions(f).map((c) => c.fieldId)).toEqual(['a', 'b', 'c'])
  })

  it('returns [] for null', () => {
    expect(collectLeafConditions(null)).toEqual([])
  })
})

describe('nested filter groups — prune (OR-semantics trap)', () => {
  const keepKnown = (known: Set<string>) => (c: { fieldId: string }) => known.has(c.fieldId)

  it('pruning a denied leaf from an OR group leaves siblings evaluable (denied = non-existent)', () => {
    // OR(visible=v, denied=d). A row matching v must still match after the denied leaf is pruned —
    // i.e. the denied leaf behaves like a non-existent field, NOT like a false branch that suppresses v.
    const f = parseMetaFilterInfo({ conjunction: 'or', conditions: [leaf('v', 1), leaf('d', 2)] })!
    const pruned = pruneFilterNode(f, keepKnown(new Set(['v'])))
    expect(pruned).not.toBeNull()
    expect(collectLeafConditions(pruned).map((c) => c.fieldId)).toEqual(['v'])
    expect(evaluateFilterNode(pruned!, evalAgainst({ v: 1, d: 0 }))).toBe(true)
  })

  it('a subgroup pruned empty is dropped (does not become an empty-OR false branch)', () => {
    // AND(v, OR(d1, d2)) with d1/d2 denied → the OR subgroup prunes empty and is DROPPED, leaving AND(v).
    const f = parseMetaFilterInfo({
      conjunction: 'and',
      conditions: [leaf('v', 1), { conjunction: 'or', conditions: [leaf('d1', 2), leaf('d2', 3)] }],
    })!
    const pruned = pruneFilterNode(f, keepKnown(new Set(['v'])))
    expect(collectLeafConditions(pruned).map((c) => c.fieldId)).toEqual(['v'])
    expect(evaluateFilterNode(pruned!, evalAgainst({ v: 1 }))).toBe(true) // not suppressed by the dropped OR
  })

  it('pruning every leaf returns null (no filter)', () => {
    const f = parseMetaFilterInfo({ conjunction: 'and', conditions: [leaf('d1', 1), leaf('d2', 2)] })!
    expect(pruneFilterNode(f, keepKnown(new Set()))).toBeNull()
  })
})

describe('nested filter groups — SECURITY: redact-out (denied literals to client)', () => {
  const allowed = new Set(['pub'])

  it('omits a denied leaf value nested inside a subgroup', () => {
    const view = {
      filterInfo: {
        conjunction: 'and',
        conditions: [leaf('pub', 'ok'), { conjunction: 'or', conditions: [leaf('secret', 'LEAK'), leaf('pub', 'also')] }],
      },
    }
    const redacted = redactViewConfigFilterLiterals(view, allowed)
    const leaves = collectLeafConditions(parseMetaFilterInfo((redacted as any).filterInfo))
    const secret = leaves.find((c) => c.fieldId === 'secret')!
    expect('value' in secret).toBe(false) // the nested denied literal is GONE
    // allowed fields keep their values; chip (fieldId+operator) preserved for the denied one
    expect(leaves.filter((c) => c.fieldId === 'pub').every((c) => 'value' in c)).toBe(true)
    expect(secret.operator).toBe('is')
  })

  it('returns the view by identity when nothing needs redacting (never mutates shared config)', () => {
    const view = { filterInfo: { conjunction: 'and', conditions: [leaf('pub', 'ok')] } }
    expect(redactViewConfigFilterLiterals(view, allowed)).toBe(view)
  })
})

describe('nested filter groups — SECURITY: merge-on-save (preserve denied literals)', () => {
  const allowed = new Set(['pub'])
  const current = {
    conjunction: 'and',
    conditions: [leaf('pub', 'p'), { conjunction: 'or', conditions: [{ fieldId: 'secret', operator: 'is', value: 'STORED' }, leaf('pub', 'p2')] }],
  }

  it('restores a nested denied literal that was echoed back without a value', () => {
    // client re-saves the SAME structure but the denied leaf has no value (it was redacted on the way out)
    const incoming = {
      conjunction: 'and',
      conditions: [leaf('pub', 'p'), { conjunction: 'or', conditions: [{ fieldId: 'secret', operator: 'is' }, leaf('pub', 'p2')] }],
    }
    const merged = mergeRedactedFilterInfoForUpdate(incoming, current, allowed)
    expect(merged).not.toBeNull()
    const secret = collectLeafConditions(parseMetaFilterInfo(merged)).find((c) => c.fieldId === 'secret')!
    expect(secret.value).toBe('STORED') // literal restored from the stored view, not erased
  })

  it('rejects (→ 400) when the nesting around a denied leaf is structurally changed', () => {
    // denied leaf moved out of the subgroup to the top level → can no longer be aligned → reject
    const incoming = {
      conjunction: 'and',
      conditions: [leaf('pub', 'p'), { fieldId: 'secret', operator: 'is' }, { conjunction: 'or', conditions: [leaf('pub', 'p2')] }],
    }
    expect(mergeRedactedFilterInfoForUpdate(incoming, current, allowed)).toBeNull()
  })

  it('trusts an allowed field or an explicit value without alignment', () => {
    const incoming = {
      conjunction: 'and',
      conditions: [leaf('pub', 'changed'), { conjunction: 'or', conditions: [{ fieldId: 'secret', operator: 'is', value: 'EXPLICIT' }, leaf('pub', 'p2')] }],
    }
    const merged = mergeRedactedFilterInfoForUpdate(incoming, current, allowed)
    const secret = collectLeafConditions(parseMetaFilterInfo(merged)).find((c) => c.fieldId === 'secret')!
    expect(secret.value).toBe('EXPLICIT')
  })

  it('rejects an ambiguous node carrying BOTH group and leaf shape at the write boundary', () => {
    const incoming = { conjunction: 'and', conditions: [{ fieldId: 'pub', operator: 'is', conditions: [leaf('secret')] }] }
    expect(mergeRedactedFilterInfoForUpdate(incoming, current, allowed)).toBeNull()
  })
})
