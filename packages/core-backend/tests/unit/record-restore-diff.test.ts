/**
 * T6 P3 — the unified canonical restore diff (`computeRecordRestoreDiff`). Pure unit; pins the PUBLIC helper
 * behavior (not the private `sameLinkSet`), per the design-lock acceptance: the collision case must be exercised
 * THROUGH the helper's link branch, so a future "simplification" back to `.join(' ')` fails here.
 */
import { describe, expect, it } from 'vitest'

import {
  computeRecordRestoreDiff,
  projectRestorableOntoLive,
  canonicalDedupeLinkIds,
} from '../../src/multitable/record-restore-diff'
import {
  assertExactRestorableRecordValid,
  assertExactRestorableScalarValue,
  ExactRestoreValueError,
} from '../../src/multitable/exact-anchor-restore-validate'

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

describe('projectRestorableOntoLive — canonical restorable projection for L8 apply', () => {
  it('preserves formula/lookup/rollup/autoNumber (and other non-restorable) live values while projecting restorable scalars', () => {
    const out = projectRestorableOntoLive({
      fieldById: new Map<string, { type: string }>([
        ['s', { type: 'string' }],
        ['f', { type: 'formula' }],
        ['lk', { type: 'lookup' }],
        ['r', { type: 'rollup' }],
        ['an', { type: 'autoNumber' }],
      ]),
      rawTypeById: new Map(),
      targetSnapshot: { s: 'at-anchor', f: 'stale-formula', lk: 'stale-lk', r: 99, an: 7 },
      currentData: { s: 'live', f: 'live-formula', lk: 'live-lk', r: 1, an: 42 },
      recordId: 'r1',
      currentVersion: 3,
      normalizeLinkIds: nlz,
    })
    expect(out.isNoOp).toBe(false)
    expect(out.changedFieldIds).toEqual(['s'])
    expect(out.patch).toEqual({ s: 'at-anchor' })
    // Non-restorable materializations stay at LIVE values — never overwritten from the snapshot.
    expect(out.data).toEqual({ s: 'at-anchor', f: 'live-formula', lk: 'live-lk', r: 1, an: 42 })
    expect(out.linkUpdates).toEqual([])
  })

  it('derived-only difference is a no-op (no version/revision/link write surface)', () => {
    const out = projectRestorableOntoLive({
      fieldById: new Map<string, { type: string }>([
        ['s', { type: 'string' }],
        ['f', { type: 'formula' }],
      ]),
      rawTypeById: new Map(),
      targetSnapshot: { s: 'same', f: 'old-formula' },
      currentData: { s: 'same', f: 'new-formula' },
      recordId: 'r1',
      currentVersion: 2,
      normalizeLinkIds: nlz,
    })
    expect(out.isNoOp).toBe(true)
    expect(out.changedFieldIds).toEqual([])
    expect(out.patch).toEqual({})
    expect(out.linkUpdates).toEqual([])
    expect(out.data).toEqual({ s: 'same', f: 'new-formula' })
  })

  it('link set change emits linkUpdates (for meta_links sync) and keeps non-link restorable fields', () => {
    const out = projectRestorableOntoLive({
      fieldById: new Map<string, { type: string }>([
        ['s', { type: 'string' }],
        ['rel', { type: 'link' }],
      ]),
      rawTypeById: new Map(),
      targetSnapshot: { s: 'x', rel: ['A'] },
      currentData: { s: 'x', rel: ['B'] },
      recordId: 'r1',
      currentVersion: 2,
      normalizeLinkIds: nlz,
    })
    expect(out.isNoOp).toBe(false)
    expect(out.changedFieldIds).toEqual(['rel'])
    expect(out.data.rel).toEqual(['A'])
    expect(out.linkUpdates).toEqual([{ fieldId: 'rel', targetIds: ['A'] }])
  })

  it('unset restorable field drops the key from projected data and records null in patch', () => {
    const out = projectRestorableOntoLive({
      fieldById: new Map([['gone', { type: 'string' }]]),
      rawTypeById: new Map(),
      targetSnapshot: {},
      currentData: { gone: 'still-here', f: 'keep-me' },
      recordId: 'r1',
      currentVersion: 1,
      normalizeLinkIds: nlz,
    })
    expect(out.isNoOp).toBe(false)
    expect(out.patch).toEqual({ gone: null })
    expect(out.data).toEqual({ f: 'keep-me' })
    expect(Object.prototype.hasOwnProperty.call(out.data, 'gone')).toBe(false)
  })

  it('link id duplicates are deduped once into the SAME content for data, patch, and linkUpdates', () => {
    const out = projectRestorableOntoLive({
      fieldById: new Map([['rel', { type: 'link' }]]),
      rawTypeById: new Map(),
      targetSnapshot: { rel: ['A', 'A', 'B'] },
      currentData: { rel: [] },
      recordId: 'r1',
      currentVersion: 1,
      normalizeLinkIds: nlz,
    })
    expect(out.linkUpdates).toEqual([{ fieldId: 'rel', targetIds: ['A', 'B'] }])
    expect(out.data.rel).toEqual(['A', 'B'])
    expect(out.patch.rel).toEqual(['A', 'B'])
    expect(canonicalDedupeLinkIds(['x', 'x', 'y'])).toEqual(['x', 'y'])
  })
})

describe('assertExactRestorableScalarValue — exact-anchor current-schema fail-closed', () => {
  it('rich longText that would be sanitized differs from history ⇒ ExactRestoreValueError', () => {
    const unsafe = '<script>alert(1)</script><p>hi</p>'
    expect(() =>
      assertExactRestorableScalarValue(
        { id: 'lt', type: 'longText', property: { rich: true } },
        unsafe,
      ),
    ).toThrow(ExactRestoreValueError)
  })

  it('select option absent from CURRENT options ⇒ ExactRestoreValueError', () => {
    expect(() =>
      assertExactRestorableScalarValue(
        { id: 's', type: 'select', options: [{ value: 'a' }, { value: 'b' }] },
        'gone-option',
      ),
    ).toThrow(ExactRestoreValueError)
  })

  it('number string that would coerce to number differs from history ⇒ ExactRestoreValueError', () => {
    expect(() =>
      assertExactRestorableScalarValue({ id: 'n', type: 'number' }, '42'),
    ).toThrow(ExactRestoreValueError)
  })

  it('identical valid string scalar passes', () => {
    expect(() =>
      assertExactRestorableScalarValue({ id: 's', type: 'string' }, 'hello'),
    ).not.toThrow()
  })
})

describe('assertExactRestorableRecordValid — whole projected record under CURRENT rules', () => {
  it('newly-required field omitted/unset on projected data ⇒ ExactRestoreValueError', () => {
    expect(() =>
      assertExactRestorableRecordValid(
        [
          {
            id: 'req',
            name: 'Required',
            type: 'string',
            property: { validation: [{ type: 'required' }] },
          },
          { id: 'note', name: 'Note', type: 'string', property: {} },
        ],
        { note: 'present' }, // req omitted
      ),
    ).toThrow(ExactRestoreValueError)
  })

  it('explicit maxLength violation on projected data ⇒ ExactRestoreValueError', () => {
    expect(() =>
      assertExactRestorableRecordValid(
        [
          {
            id: 's',
            name: 'Short',
            type: 'string',
            property: { validation: [{ type: 'maxLength', params: { value: 3 } }] },
          },
        ],
        { s: 'toolong' },
      ),
    ).toThrow(ExactRestoreValueError)
  })

  it('explicit pattern violation on projected data ⇒ ExactRestoreValueError', () => {
    expect(() =>
      assertExactRestorableRecordValid(
        [
          {
            id: 'code',
            name: 'Code',
            type: 'string',
            property: { validation: [{ type: 'pattern', params: { regex: '^[A-Z]+$' } }] },
          },
        ],
        { code: 'not-upper' },
      ),
    ).toThrow(ExactRestoreValueError)
  })

  it('valid projected record under explicit required + pattern passes', () => {
    expect(() =>
      assertExactRestorableRecordValid(
        [
          {
            id: 'code',
            name: 'Code',
            type: 'string',
            property: {
              validation: [
                { type: 'required' },
                { type: 'pattern', params: { regex: '^[A-Z]+$' } },
              ],
            },
          },
        ],
        { code: 'ABC' },
      ),
    ).not.toThrow()
  })

  it('explicit property.validation replaces defaults (record-service ?? precedence)', () => {
    // Default string maxLength is 10000; explicit empty validation list means NO rules.
    expect(() =>
      assertExactRestorableRecordValid(
        [{ id: 's', name: 'S', type: 'string', property: { validation: [] } }],
        { s: 'x'.repeat(20000) },
      ),
    ).not.toThrow()
  })
})
