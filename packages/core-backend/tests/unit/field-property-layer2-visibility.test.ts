/**
 * Layer-2 field visibility keys are CROSS-CUTTING — they must survive EVERY field type's sanitizer.
 *
 * `isFieldPermissionHidden` (permission-derivation.ts) decides layer-2 hiding by reading exactly two keys:
 *   property.hidden === true   ||   property.visible === false
 *
 * The per-type sanitizer has two shapes of branch:
 *   - PASSTHROUGH (`return { ...obj, … }` / link's `...cleanObj`) — select, link, lookup, rollup, formula,
 *     attachment, currency, dateTime, … — these carried the keys through incidentally.
 *   - CLOSED ALLOWLIST (`return { …only these keys }`) — **exactly `person` and `button`** (plus any custom
 *     `fieldTypeRegistry` codec that does the same). These rebuilt `property` from scratch and DROPPED the
 *     two keys, so the predicate never saw them.
 *
 * MEASURED, NOT ASSUMED: reverting the cross-cutting rule reds ONLY the `person` and `button` rows below.
 * The other types already preserved the keys — they are kept in the table as CONTROLS, so that converting
 * any of them to a closed allowlist later (or adding a new type) is caught immediately.
 *
 * So: whether a field could be hidden at all depended on which branch its type happened to fall into.
 * `sanitizeFieldProperty` already applied `visibilityRule` / `requiredWhen` as cross-cutting rules for
 * exactly this reason — `hidden`/`visible` were simply never added to that set. The fix adds them there
 * rather than patching the two guilty branches, because a branch only has to forget once.
 */
import { describe, expect, it } from 'vitest'

import { sanitizeFieldProperty } from '../../src/multitable/field-codecs'
import { isFieldPermissionHidden } from '../../src/multitable/permission-derivation'

// The two types that ACTUALLY dropped the keys (measured: reverting the fix reds only these).
const AFFECTED_TYPES = ['person', 'button'] as const
// Types that already preserved them (passthrough branches). Kept as controls: they prove the assertion is
// not vacuous, and they catch a future conversion of any of them into a closed allowlist.
const CONTROL_TYPES = ['select', 'link', 'lookup', 'rollup', 'formula', 'attachment'] as const

describe('layer-2 visibility keys survive every field type sanitizer', () => {
  describe.each([...AFFECTED_TYPES, ...CONTROL_TYPES])('type=%s', (type) => {
    it('preserves `hidden: true` — so isFieldPermissionHidden() can see it', () => {
      const property = sanitizeFieldProperty(type, { hidden: true })
      expect(property.hidden).toBe(true)
      expect(isFieldPermissionHidden({ property })).toBe(true)
    })

    it('preserves `visible: false` — the other half of the same predicate', () => {
      const property = sanitizeFieldProperty(type, { visible: false })
      expect(property.visible).toBe(false)
      expect(isFieldPermissionHidden({ property })).toBe(true)
    })

    it('NON-VACUOUS control: a field with neither key is NOT hidden', () => {
      const property = sanitizeFieldProperty(type, {})
      expect(isFieldPermissionHidden({ property })).toBe(false)
    })
  })

  it('does not invent the keys: permissive values are not carried (only the HIDING signals are)', () => {
    // `hidden: false` / `visible: true` are not load-bearing for the predicate; carrying them would churn
    // existing property shapes for no benefit. What matters is that neither makes the field hidden.
    const p1 = sanitizeFieldProperty('person', { hidden: false })
    const p2 = sanitizeFieldProperty('person', { visible: true })
    expect(isFieldPermissionHidden({ property: p1 })).toBe(false)
    expect(isFieldPermissionHidden({ property: p2 })).toBe(false)
  })

  it('the type-specific sanitization still happens (the cross-cutting rule does not replace it)', () => {
    // person's own key survives alongside the carried layer-2 key…
    const person = sanitizeFieldProperty('person', { hidden: true, limitSingleRecord: false })
    expect(person.hidden).toBe(true)
    expect(person.limitSingleRecord).toBe(false)
    // …and button still gets its enforced readOnly, plus its own allowlisted keys.
    const button = sanitizeFieldProperty('button', { hidden: true, label: 'Go', variant: 'primary' })
    expect(button.hidden).toBe(true)
    expect(button.readOnly).toBe(true)
    expect(button.label).toBe('Go')
  })

  it('a junk property value cannot smuggle a truthy-but-not-true hidden', () => {
    // the predicate is strict (=== true / === false); the carrier must be equally strict, so a truthy
    // non-boolean must NOT become a hiding signal (it would be an unpredictable, type-dependent mask).
    for (const junk of ['true', 1, {}, []]) {
      const property = sanitizeFieldProperty('person', { hidden: junk })
      expect(isFieldPermissionHidden({ property })).toBe(false)
    }
  })
})
