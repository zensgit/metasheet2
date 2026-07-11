import { describe, expect, it } from 'vitest'

import {
  loadRuleEntriesConcurrently,
  mergeRuleEntries,
} from '../src/multitable/utils/automation-rule-concurrent-merge'

describe('mergeRuleEntries', () => {
  it('returns prev unchanged (new object) when entries is empty', () => {
    const prev = { a: 1 }
    const next = mergeRuleEntries(prev, [])
    expect(next).toEqual({ a: 1 })
    expect(next).not.toBe(prev)
  })

  it('adds new ruleIds without disturbing existing ones', () => {
    const prev = { a: 1 }
    const next = mergeRuleEntries(prev, [['b', 2], ['c', 3]])
    expect(next).toEqual({ a: 1, b: 2, c: 3 })
  })

  it('overwrites an existing ruleId with a newly fetched value', () => {
    const prev = { a: 1 }
    const next = mergeRuleEntries(prev, [['a', 99]])
    expect(next).toEqual({ a: 99 })
  })

  it('last entry wins when the same ruleId appears twice in one batch', () => {
    const next = mergeRuleEntries({}, [['a', 1], ['a', 2]])
    expect(next).toEqual({ a: 2 })
  })

  it('does not mutate the prev snapshot passed in', () => {
    const prev = { a: 1 }
    mergeRuleEntries(prev, [['b', 2]])
    expect(prev).toEqual({ a: 1 })
  })

  // Anchor regression case (G-B2-23): concurrently-resolved fetches must all survive a
  // one-shot merge. This is written to go RED if `mergeRuleEntries` is ever "simplified"
  // back into a per-entry re-spread against the same stale `prev` (e.g. `entries.forEach(
  // ([id, v]) => { next = { ...prev, [id]: v } })`) — that shape keeps only the LAST
  // entry applied and silently drops every earlier one.
  it('loses none of N entries resolved together, even alongside a pre-existing prev key', () => {
    const prev = { existing: 'kept' }
    const entries: Array<readonly [string, string]> = Array.from({ length: 10 }, (_, i) => [
      `rule-${i}`,
      `stats-${i}`,
    ] as const)
    const next = mergeRuleEntries(prev, entries)
    expect(next.existing).toBe('kept')
    for (let i = 0; i < 10; i++) {
      expect(next[`rule-${i}`]).toBe(`stats-${i}`)
    }
    expect(Object.keys(next)).toHaveLength(11)
  })
})

describe('loadRuleEntriesConcurrently', () => {
  it('fetches every ruleId and merges all successes into prev', async () => {
    const calls: string[] = []
    const result = await loadRuleEntriesConcurrently({ existing: 0 }, ['r1', 'r2', 'r3'], async (ruleId) => {
      calls.push(ruleId)
      return ruleId.length
    })
    expect(calls.sort()).toEqual(['r1', 'r2', 'r3'])
    expect(result).toEqual({ existing: 0, r1: 2, r2: 2, r3: 2 })
  })

  it('runs fetches concurrently, not serially (total time ~= slowest single fetch)', async () => {
    const delays = [30, 30, 30, 30, 30]
    const start = Date.now()
    await loadRuleEntriesConcurrently(
      {},
      delays.map((_, i) => `r${i}`),
      (ruleId) => new Promise((resolve) => setTimeout(() => resolve(ruleId), delays[Number(ruleId.slice(1))])),
    )
    const elapsed = Date.now() - start
    // Serial would take ~150ms (5 * 30ms); concurrent should stay well under that.
    expect(elapsed).toBeLessThan(120)
  })

  it('isolates a single rejecting fetch — the rest are still merged in (failure does not blank the batch)', async () => {
    const result = await loadRuleEntriesConcurrently({}, ['ok-1', 'bad', 'ok-2'], async (ruleId) => {
      if (ruleId === 'bad') throw new Error('boom')
      return `stats-for-${ruleId}`
    })
    expect(result).toEqual({ 'ok-1': 'stats-for-ok-1', 'ok-2': 'stats-for-ok-2' })
    expect(result).not.toHaveProperty('bad')
  })

  it('a rule missing from this fetch keeps its previously-merged value (partial refresh does not wipe prior data)', async () => {
    const result = await loadRuleEntriesConcurrently({ stale: 'old', fresh: 'old' }, ['fresh'], async () => 'new')
    expect(result).toEqual({ stale: 'old', fresh: 'new' })
  })

  it('returns prev unchanged for an empty ruleIds list', async () => {
    const result = await loadRuleEntriesConcurrently({ a: 1 }, [], async () => 0)
    expect(result).toEqual({ a: 1 })
  })
})
