import { describe, expect, it } from 'vitest'

import {
  sanitizeFieldProperty,
  serializeFieldRow,
} from '../../src/multitable/field-codecs'
import {
  sanitizeFieldVisibilityRule,
  withFieldVisibilityRule,
} from '../../src/multitable/field-visibility-rule'

// Conditional field-VISIBILITY MVP (2026-06-14): a field's `property.visibilityRule`
// rides the field property JSON, reusing the conditional-formatting operator
// vocabulary. These assert the rule is sanitized cross-cuttingly (every field
// type) and round-trips through the read-serialize path — NOT via incidental
// `...obj` passthrough.

describe('sanitizeFieldVisibilityRule', () => {
  it('accepts a well-formed rule and strips the formatting-only envelope', () => {
    expect(sanitizeFieldVisibilityRule({ fieldId: 'fld_y', operator: 'eq', value: 'Z' })).toEqual({
      fieldId: 'fld_y',
      operator: 'eq',
      value: 'Z',
    })
  })

  it('keeps value-less operators (is_empty) without a value key', () => {
    expect(sanitizeFieldVisibilityRule({ fieldId: 'fld_y', operator: 'is_empty' })).toEqual({
      fieldId: 'fld_y',
      operator: 'is_empty',
    })
  })

  it('trims fieldId', () => {
    expect(sanitizeFieldVisibilityRule({ fieldId: '  fld_y  ', operator: 'eq', value: 1 })).toEqual({
      fieldId: 'fld_y',
      operator: 'eq',
      value: 1,
    })
  })

  it('rejects malformed rules (missing fieldId, unknown operator, missing required value)', () => {
    expect(sanitizeFieldVisibilityRule(null)).toBeNull()
    expect(sanitizeFieldVisibilityRule({ operator: 'eq', value: 'Z' })).toBeNull()
    expect(sanitizeFieldVisibilityRule({ fieldId: 'fld_y', operator: 'frobnicate', value: 'Z' })).toBeNull()
    // `eq` requires a value (operator vocab inherited from conditional-formatting)
    expect(sanitizeFieldVisibilityRule({ fieldId: 'fld_y', operator: 'eq' })).toBeNull()
  })
})

describe('withFieldVisibilityRule', () => {
  it('merges a sanitized rule onto a property object', () => {
    expect(
      withFieldVisibilityRule({ foo: 1 }, { visibilityRule: { fieldId: 'fld_y', operator: 'eq', value: 'Z' } }),
    ).toEqual({ foo: 1, visibilityRule: { fieldId: 'fld_y', operator: 'eq', value: 'Z' } })
  })

  it('omits the key when the rule is absent or invalid', () => {
    expect(withFieldVisibilityRule({ foo: 1 }, {})).toEqual({ foo: 1 })
    expect(withFieldVisibilityRule({ foo: 1 }, { visibilityRule: { operator: 'eq' } })).toEqual({ foo: 1 })
    // a passed-through invalid rule on the by-type result is dropped
    expect(withFieldVisibilityRule({ foo: 1, visibilityRule: { bad: true } }, {})).toEqual({ foo: 1 })
  })
})

describe('sanitizeFieldProperty preserves visibilityRule cross-cuttingly', () => {
  const RULE = { fieldId: 'fld_y', operator: 'eq', value: 'Z' }

  // Cover types whose sanitizer does NOT end in a bare `...obj` (string/select/
  // number/link/autoNumber) plus a few plain ones — the rule must survive ALL.
  for (const type of ['string', 'number', 'select', 'link', 'autoNumber', 'longText', 'rating']) {
    it(`survives type=${type}`, () => {
      const out = sanitizeFieldProperty(type, { visibilityRule: { ...RULE } })
      expect(out.visibilityRule).toEqual(RULE)
    })
  }

  it('drops a malformed rule rather than passing it through', () => {
    const out = sanitizeFieldProperty('string', { visibilityRule: { operator: 'eq' } })
    expect('visibilityRule' in out).toBe(false)
  })

  it('no rule ⇒ no visibilityRule key', () => {
    const out = sanitizeFieldProperty('string', {})
    expect('visibilityRule' in out).toBe(false)
  })
})

describe('serializeFieldRow round-trips visibilityRule through the read path', () => {
  it('a stored field with a visibilityRule reads back with the rule', () => {
    const field = serializeFieldRow({
      id: 'fld_x',
      name: 'Detail',
      type: 'string',
      order: 3,
      property: { visibilityRule: { fieldId: 'fld_y', operator: 'eq', value: 'Z' } },
    })
    expect(field.property?.visibilityRule).toEqual({ fieldId: 'fld_y', operator: 'eq', value: 'Z' })
  })
})
