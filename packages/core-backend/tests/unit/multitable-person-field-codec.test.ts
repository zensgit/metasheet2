/**
 * Native person field (人员 / member, design 2026-06-16) — codec unit tests.
 *
 * Covers the storage + write-validation contract of a FIRST-CLASS person field whose value is
 * `userId[]` (NOT the recordId[] of a legacy link-backed person). COEXISTENCE is the spine: a
 * native person is stored as `type='person'`; legacy person fields stay `type='link'`+refKind:user
 * and are unaffected by this codec.
 *
 * Asserts:
 *   - mapFieldType('person') === 'person' (alias to 'link' REMOVED — this is the contract flip).
 *   - sanitizeFieldProperty('person', …): limitSingleRecord default TRUE (matches legacy person);
 *     junk dropped; NOT readOnly; restrictToMemberGroupIds normalized when present.
 *   - validatePersonValue: dedupes, rejects non-member userId (SECURITY), enforces single-record
 *     cap, accepts member userIds, empty → [], null member-set = closed set.
 *   - serializeFieldRow round-trips a raw DB type='person' row as type='person' (NOT coerced to link).
 */

import { describe, it, expect } from 'vitest'
import {
  isPersonSingleRecord,
  mapFieldType,
  sanitizeFieldProperty,
  serializeFieldRow,
  validatePersonValue,
} from '../../src/multitable/field-codecs'

describe('native person field codec', () => {
  describe('mapFieldType', () => {
    it("maps 'person' to 'person' (alias to 'link' removed)", () => {
      expect(mapFieldType('person')).toBe('person')
      expect(mapFieldType('PERSON')).toBe('person')
      // legacy link stays link
      expect(mapFieldType('link')).toBe('link')
    })
  })

  describe("sanitizeFieldProperty('person')", () => {
    it('defaults limitSingleRecord to TRUE (matches legacy person), not the link default of false', () => {
      expect(sanitizeFieldProperty('person', {})).toEqual({ limitSingleRecord: true })
      expect(sanitizeFieldProperty('person', undefined)).toEqual({ limitSingleRecord: true })
    })

    it('honors explicit limitSingleRecord: false (multi-person)', () => {
      expect(sanitizeFieldProperty('person', { limitSingleRecord: false })).toEqual({ limitSingleRecord: false })
    })

    it('drops junk keys (no foreignSheetId / refKind leak) and is NOT readOnly', () => {
      const sanitized = sanitizeFieldProperty('person', {
        limitSingleRecord: true,
        foreignSheetId: 'sheet_spoofed',
        refKind: 'user',
        bogus: 1,
      })
      expect(sanitized).not.toHaveProperty('foreignSheetId')
      expect(sanitized).not.toHaveProperty('refKind')
      expect(sanitized).not.toHaveProperty('bogus')
      expect(sanitized).not.toHaveProperty('readOnly')
    })

    it('normalizes restrictToMemberGroupIds (dedupe + trim) when present, omits when empty/absent', () => {
      expect(
        sanitizeFieldProperty('person', { restrictToMemberGroupIds: [' g1 ', 'g1', 'g2', 7, ''] }),
      ).toEqual({ limitSingleRecord: true, restrictToMemberGroupIds: ['g1', 'g2'] })
      expect(sanitizeFieldProperty('person', { restrictToMemberGroupIds: [] })).not.toHaveProperty(
        'restrictToMemberGroupIds',
      )
    })
  })

  describe('isPersonSingleRecord', () => {
    it('defaults to TRUE on undefined / missing flag', () => {
      expect(isPersonSingleRecord(undefined)).toBe(true)
      expect(isPersonSingleRecord({})).toBe(true)
      expect(isPersonSingleRecord({ limitSingleRecord: true })).toBe(true)
    })
    it('is FALSE only when explicitly limitSingleRecord:false', () => {
      expect(isPersonSingleRecord({ limitSingleRecord: false })).toBe(false)
    })
  })

  describe('validatePersonValue', () => {
    const members = new Set(['u1', 'u2', 'u3'])

    it('returns [] for empty / null / undefined / ""', () => {
      expect(validatePersonValue([], 'f', members, false)).toEqual([])
      expect(validatePersonValue(null, 'f', members, false)).toEqual([])
      expect(validatePersonValue(undefined, 'f', members, false)).toEqual([])
      expect(validatePersonValue('', 'f', members, false)).toEqual([])
    })

    it('accepts member userIds and dedupes (order-preserving)', () => {
      expect(validatePersonValue(['u1', 'u2', 'u1'], 'f', members, false)).toEqual(['u1', 'u2'])
    })

    it('trims and coerces numeric ids', () => {
      expect(validatePersonValue([' u1 ', 2 as unknown as string], 'f', new Set(['u1', '2']), false)).toEqual(['u1', '2'])
    })

    it('rejects a non-member userId (SECURITY membership boundary)', () => {
      expect(() => validatePersonValue(['u1', 'intruder'], 'f', members, false)).toThrow(/not a member/)
    })

    it('rejects more than one id when limitSingleRecord is true', () => {
      expect(() => validatePersonValue(['u1', 'u2'], 'f', members, true)).toThrow(/single user/)
      expect(validatePersonValue(['u1'], 'f', members, true)).toEqual(['u1'])
    })

    it('rejects a non-array value', () => {
      expect(() => validatePersonValue('u1', 'f', members, false)).toThrow(/must be an array/)
    })

    it('treats a null member set as a CLOSED set (rejects any non-empty value, never open egress)', () => {
      expect(validatePersonValue([], 'f', null, false)).toEqual([])
      expect(() => validatePersonValue(['u1'], 'f', null, false)).toThrow(/not a member/)
    })

    it('rejects an over-long userId', () => {
      const longId = 'u'.repeat(51)
      expect(() => validatePersonValue([longId], 'f', new Set([longId]), false)).toThrow(/too long/)
    })
  })

  describe('serializeFieldRow', () => {
    it('round-trips a raw DB type=person row as type=person (NOT coerced to link)', () => {
      const row = serializeFieldRow({
        id: 'fld_owner',
        name: 'Owner',
        type: 'person',
        property: { limitSingleRecord: false, foreignSheetId: 'junk' },
        order: 3,
      })
      expect(row.type).toBe('person')
      expect(row.property).toEqual({ limitSingleRecord: false })
    })
  })
})
