/**
 * Pure unit lock for the T9-W Tier 2 (#3298) field-retype-revert predicates — `isFieldRetypeRevert` (structural gate
 * that drives the per-tier flag) and `isSupportedFieldRetypeRevert` (the confirmable/executable scalar-safe subset).
 * DB-free, so it runs in the default `test` job every PR (the real-DB wiring is
 * tests/integration/multitable-field-retype-revert-realdb.test.ts).
 *
 * Mirrors the Tier-1 lock from #3297. Tier 2's supported surface is defined by EXCLUSION (everything scalar except
 * FIELD_RETYPE_EXCLUDED_TYPES), so the "silent future widening" risk is REMOVING a type from that exclusion set (or a
 * new side-effect type slipping in unexcluded). The excluded-endpoint cases below pin the exclusion set BEHAVIORALLY:
 * removing any of the 11 locked types flips its `→ not supported` assertion red, forcing a T9-W design-lock update +
 * goldens first. (FIELD_RETYPE_EXCLUDED_TYPES is module-private; if it's later exported, an exact-set `.toEqual`
 * tripwire could replace this loop — kept behavioral to stay tests-only.)
 *
 * N2 (single-transaction atomicity) is intentionally NOT here — it's a heavier real-DB follow-up; the generic
 * transaction/rollback mechanism is already proven by the Tier-1 atomicity golden.
 */
import { describe, expect, test } from 'vitest'

import { isFieldRetypeRevert, isSupportedFieldRetypeRevert, type ConfigRevisionRow } from '../src/multitable/config-restore'

// The 11 side-effect types design-locked as EXCLUDED (forward retype runs handlers — autoNumber sequence, formula/
// lookup/rollup deps, link join-table, attachment blobs, system-managed — that a raw schema UPDATE would skip).
const EXCLUDED_TYPES = [
  'formula', 'lookup', 'rollup', 'link', 'attachment', 'button',
  'autoNumber', 'createdTime', 'modifiedTime', 'createdBy', 'modifiedBy',
] as const

const rev = (over: Partial<ConfigRevisionRow>): ConfigRevisionRow => ({
  id: 'rev1', sheet_id: 's1', entity_type: 'field', entity_id: 'f1', action: 'update',
  before: { type: 'text' }, after: { type: 'number' }, changed_keys: ['type'],
  ...over,
}) as ConfigRevisionRow

describe('field-retype revert predicates — T9-W Tier 2 (#3298)', () => {
  test('supported: a scalar→scalar type-changing retype (type, or type+property)', () => {
    expect(isFieldRetypeRevert(rev({ changed_keys: ['type'] }))).toBe(true)
    expect(isSupportedFieldRetypeRevert(rev({ changed_keys: ['type'] }))).toBe(true)
    expect(isSupportedFieldRetypeRevert(rev({ changed_keys: ['type', 'property'] }))).toBe(true)
    expect(isSupportedFieldRetypeRevert(rev({ changed_keys: ['name', 'order', 'type'] }))).toBe(true)
  })

  test('malformed changed_keys (non-array, forged row) → not a retype, not thrown', () => {
    for (const bad of [undefined, null, 'type'] as const) {
      expect(isFieldRetypeRevert(rev({ changed_keys: bad as unknown as string[] }))).toBe(false)
      expect(isSupportedFieldRetypeRevert(rev({ changed_keys: bad as unknown as string[] }))).toBe(false)
    }
  })

  test('create/delete (action ≠ update) → gated, not supported', () => {
    for (const action of ['create', 'delete'] as const) {
      expect(isFieldRetypeRevert(rev({ action }))).toBe(false)
      expect(isSupportedFieldRetypeRevert(rev({ action }))).toBe(false)
    }
  })

  test('property-only retype → structural gate true, but NOT supported (v1 type-change-only; property-only deferred)', () => {
    const propOnly = rev({ changed_keys: ['property'] })
    expect(isFieldRetypeRevert(propOnly)).toBe(true)        // touches a retype key → drives the flag
    expect(isSupportedFieldRetypeRevert(propOnly)).toBe(false) // no `type` change → deferred, stays gated/422
  })

  test('unknown / mixed-unknown changed_keys → not a retype', () => {
    expect(isFieldRetypeRevert(rev({ changed_keys: ['someUnknownKey'] }))).toBe(false)
    expect(isFieldRetypeRevert(rev({ changed_keys: ['type', 'someUnknownKey'] }))).toBe(false) // every() must hold
  })

  test('non-string type (forged before/after) → not supported, not thrown', () => {
    expect(isSupportedFieldRetypeRevert(rev({ before: { type: 123 }, after: { type: 'number' } }))).toBe(false)
    expect(isSupportedFieldRetypeRevert(rev({ before: { type: 'text' }, after: {} }))).toBe(false)
    expect(isSupportedFieldRetypeRevert(rev({ before: null, after: null }))).toBe(false)
  })

  test('wrong entity_type is never a field retype', () => {
    for (const entity_type of ['sheet_config', 'view', 'permission'] as const) {
      expect(isFieldRetypeRevert(rev({ entity_type }))).toBe(false)
      expect(isSupportedFieldRetypeRevert(rev({ entity_type }))).toBe(false)
    }
  })

  // BEHAVIORAL TRIPWIRE (N1): each excluded type stays UNSUPPORTED as either endpoint. Removing one from
  // FIELD_RETYPE_EXCLUDED_TYPES (silently widening Tier 2 to a side-effect type a raw UPDATE can't safely revert)
  // flips its assertion red → forces a T9-W design-lock update + handler/goldens first.
  test('TRIPWIRE: every excluded (side-effect) type stays gated as either retype endpoint', () => {
    for (const t of EXCLUDED_TYPES) {
      // still a structural retype (drives the flag) ...
      expect(isFieldRetypeRevert(rev({ before: { type: t }, after: { type: 'number' } }))).toBe(true)
      // ... but NOT confirmable/executable from OR to that type
      expect(isSupportedFieldRetypeRevert(rev({ before: { type: t }, after: { type: 'number' } }))).toBe(false)
      expect(isSupportedFieldRetypeRevert(rev({ before: { type: 'text' }, after: { type: t } }))).toBe(false)
    }
  })

  // N3 — native `person` 口径: type='person' (value = userId[]) is NOT in the exclusion list, so a person↔scalar
  // retype IS supported. This is intentional and safe despite person being ARRAY-VALUED (not a traditional scalar):
  // the revert is SCHEMA-ONLY (raw meta_fields UPDATE, never touches meta_records), so stored userId[] values are
  // left raw and the read path tolerates the type mismatch — symmetric with the non-migrating forward retype. The
  // side-effect-bearing legacy person field is persisted as type='link' (refKind:'user'), which IS excluded. So
  // "schema-only safe but array-valued" — locked here so a later reclassification of person is a conscious change.
  test('N3: native person (array-valued, schema-only-safe) is a SUPPORTED retype endpoint', () => {
    expect(isSupportedFieldRetypeRevert(rev({ before: { type: 'person' }, after: { type: 'text' } }))).toBe(true)
    expect(isSupportedFieldRetypeRevert(rev({ before: { type: 'singleLineText' }, after: { type: 'person' } }))).toBe(true)
    // contrast: legacy person = link = excluded → stays gated
    expect(isSupportedFieldRetypeRevert(rev({ before: { type: 'link' }, after: { type: 'person' } }))).toBe(false)
  })
})
