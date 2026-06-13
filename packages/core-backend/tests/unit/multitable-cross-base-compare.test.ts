/**
 * ②a wall — §2a.4 cross-base base-comparison rule (pure unit).
 *
 * The single source of truth for "are these two bases different bases" — shared by the §2a.2 wall
 * (`validateLinkFieldConfig`), the §2a.4-c sheet-create TOCTOU guard, and (replicated in SQL via
 * `IS DISTINCT FROM`) the §2a.4-b sweep. The rule is STRICT and null-aware: a null/legacy base and a set
 * base count as cross-base; null-vs-null is same-base; set-vs-same-set is same-base. This unit pins the
 * rule so the route guard, the wall, and the sweep cannot silently drift apart.
 */
import { describe, expect, test } from 'vitest'

import { baseIdsAreCrossBase } from '../../src/routes/univer-meta'

describe('②a §2a.4 cross-base base-comparison rule', () => {
  test('set vs DIFFERENT set = cross-base', () => {
    expect(baseIdsAreCrossBase('base_a', 'base_b')).toBe(true)
  })

  test('set vs SAME set = same-base', () => {
    expect(baseIdsAreCrossBase('base_a', 'base_a')).toBe(false)
  })

  test('set vs null = cross-base (null-vs-set)', () => {
    expect(baseIdsAreCrossBase('base_a', null)).toBe(true)
    expect(baseIdsAreCrossBase(null, 'base_a')).toBe(true)
  })

  test('null vs null = same-base', () => {
    expect(baseIdsAreCrossBase(null, null)).toBe(false)
  })
})
