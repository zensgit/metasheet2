/**
 * T6 P3 — the unified canonical restore diff (`computeRecordRestoreDiff`). Pure unit; pins the PUBLIC helper
 * behavior (not the private `sameLinkSet`), per the design-lock acceptance: the collision case must be exercised
 * THROUGH the helper's link branch, so a future "simplification" back to `.join(' ')` fails here.
 */
import { describe, expect, it } from 'vitest'

import { computeRecordRestoreDiff } from '../../src/multitable/record-restore-diff'

// Minimal stand-in for the route's normalizeLinkIds (array → string[]; the helper only needs the parse contract).
const nlz = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : [])

describe('computeRecordRestoreDiff — canonical shared restore diff', () => {
  it('link collision (the canonicalization): equal-length sets whose .join would collide is a CHANGE, not a no-op', () => {
    // `.sort().join(' ')` would equate these (both → "a b") and emit nothing; the robust canonical must not.
    const diff = computeRecordRestoreDiff({
      fieldById: new Map([['lk', { type: 'link' }]]),
      rawTypeById: new Map([['lk', 'link']]),
      targetSnapshot: { lk: ['a b', 'c'] },
      currentData: { lk: ['a', 'b c'] },
      recordId: 'r1', currentVersion: 2, normalizeLinkIds: nlz,
    })
    expect(diff).toHaveLength(1) // robust set-compare sees ['a','b c'] != ['a b','c']; a .join(' ') form would miss it (both 'a b c')
    expect(diff[0]).toMatchObject({ recordId: 'r1', fieldId: 'lk', op: 'set', value: ['a b', 'c'], expectedVersion: 2 })
  })

  it('link no-op: the same id set in a different order emits nothing (order-insensitive)', () => {
    const diff = computeRecordRestoreDiff({
      fieldById: new Map([['lk', { type: 'link' }]]),
      rawTypeById: new Map([['lk', 'link']]),
      targetSnapshot: { lk: ['a', 'b'] }, currentData: { lk: ['b', 'a'] },
      recordId: 'r1', currentVersion: 2, normalizeLinkIds: nlz,
    })
    expect(diff).toHaveLength(0)
  })

  it('scalar set / unset, with non-restorable + button + no-op all skipped', () => {
    const diff = computeRecordRestoreDiff({
      fieldById: new Map<string, { type: string }>([
        ['s', { type: 'string' }],    // changed → set
        ['u', { type: 'number' }],    // present now, absent in snapshot → unset
        ['f', { type: 'formula' }],   // non-restorable → skip
        ['b', { type: 'string' }],    // raw type 'button' → skip
        ['same', { type: 'string' }], // unchanged → no-op
      ]),
      rawTypeById: new Map([['b', 'button']]),
      targetSnapshot: { s: 'new', same: 'x' },
      currentData: { s: 'old', u: 5, same: 'x' },
      recordId: 'r1', currentVersion: 3, normalizeLinkIds: nlz,
    })
    const byField = Object.fromEntries(diff.map((c) => [c.fieldId, c]))
    expect(byField.s).toMatchObject({ op: 'set', value: 'new', expectedVersion: 3 })
    expect(byField.u).toMatchObject({ op: 'unset' })
    expect(byField.f).toBeUndefined()
    expect(byField.b).toBeUndefined()
    expect(byField.same).toBeUndefined()
  })
})
