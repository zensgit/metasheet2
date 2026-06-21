import { describe, expect, it } from 'vitest'

import {
  sanitizeFieldProperty,
  serializeFieldRow,
} from '../../src/multitable/field-codecs'
import {
  withFieldRequiredWhenRule,
} from '../../src/multitable/field-visibility-rule'

// Conditional-REQUIRED ("required-IF", A4): a field's `property.requiredWhen`
// rides the field property JSON, REUSING the conditional-formatting / visibility
// operator vocabulary + shape. These assert the rule is sanitized cross-cuttingly
// (every field type) and round-trips through the read-serialize path — NOT via
// incidental `...obj` passthrough. Enforcement is client-side (form view); this
// covers only durable PERSISTENCE of the authored rule.

describe('withFieldRequiredWhenRule', () => {
  it('merges a sanitized rule onto a property object under the requiredWhen key', () => {
    expect(
      withFieldRequiredWhenRule({ foo: 1 }, { requiredWhen: { fieldId: 'fld_y', operator: 'eq', value: 'Z' } }),
    ).toEqual({ foo: 1, requiredWhen: { fieldId: 'fld_y', operator: 'eq', value: 'Z' } })
  })

  it('keeps value-less operators (is_empty) without a value key', () => {
    expect(
      withFieldRequiredWhenRule({}, { requiredWhen: { fieldId: 'fld_y', operator: 'is_empty' } }),
    ).toEqual({ requiredWhen: { fieldId: 'fld_y', operator: 'is_empty' } })
  })

  it('trims fieldId', () => {
    expect(
      withFieldRequiredWhenRule({}, { requiredWhen: { fieldId: '  fld_y  ', operator: 'eq', value: 1 } }),
    ).toEqual({ requiredWhen: { fieldId: 'fld_y', operator: 'eq', value: 1 } })
  })

  it('omits the key when the rule is absent or invalid', () => {
    expect(withFieldRequiredWhenRule({ foo: 1 }, {})).toEqual({ foo: 1 })
    expect(withFieldRequiredWhenRule({ foo: 1 }, { requiredWhen: { operator: 'eq' } })).toEqual({ foo: 1 })
    // `eq` requires a value (operator vocab inherited from conditional-formatting)
    expect(withFieldRequiredWhenRule({ foo: 1 }, { requiredWhen: { fieldId: 'fld_y', operator: 'eq' } })).toEqual({ foo: 1 })
    // a passed-through invalid rule on the by-type result is dropped
    expect(withFieldRequiredWhenRule({ foo: 1, requiredWhen: { bad: true } }, {})).toEqual({ foo: 1 })
  })

  it('is independent of visibilityRule (each key merged on its own)', () => {
    // A property carrying BOTH rules keeps both after their respective merges.
    const out = withFieldRequiredWhenRule(
      { visibilityRule: { fieldId: 'fld_v', operator: 'eq', value: 'open' } },
      { requiredWhen: { fieldId: 'fld_y', operator: 'eq', value: 'Z' } },
    )
    expect(out).toEqual({
      visibilityRule: { fieldId: 'fld_v', operator: 'eq', value: 'open' },
      requiredWhen: { fieldId: 'fld_y', operator: 'eq', value: 'Z' },
    })
  })
})

describe('sanitizeFieldProperty preserves requiredWhen cross-cuttingly', () => {
  const RULE = { fieldId: 'fld_y', operator: 'eq', value: 'Z' }

  // Cover types whose sanitizer does NOT end in a bare `...obj` (string/select/
  // number/link/autoNumber) plus a few plain ones — the rule must survive ALL.
  for (const type of ['string', 'number', 'select', 'link', 'autoNumber', 'longText', 'rating']) {
    it(`survives type=${type}`, () => {
      const out = sanitizeFieldProperty(type, { requiredWhen: { ...RULE } })
      expect(out.requiredWhen).toEqual(RULE)
    })
  }

  it('drops a malformed rule rather than passing it through', () => {
    const out = sanitizeFieldProperty('string', { requiredWhen: { operator: 'eq' } })
    expect('requiredWhen' in out).toBe(false)
  })

  it('no rule ⇒ no requiredWhen key', () => {
    const out = sanitizeFieldProperty('string', {})
    expect('requiredWhen' in out).toBe(false)
  })

  it('keeps visibilityRule and requiredWhen side-by-side on one field', () => {
    const out = sanitizeFieldProperty('string', {
      visibilityRule: { fieldId: 'fld_v', operator: 'eq', value: 'open' },
      requiredWhen: { ...RULE },
    })
    expect(out.visibilityRule).toEqual({ fieldId: 'fld_v', operator: 'eq', value: 'open' })
    expect(out.requiredWhen).toEqual(RULE)
  })
})

describe('serializeFieldRow round-trips requiredWhen through the read path', () => {
  it('a stored field with a requiredWhen reads back with the rule', () => {
    const field = serializeFieldRow({
      id: 'fld_x',
      name: 'Reason',
      type: 'string',
      order: 3,
      property: { requiredWhen: { fieldId: 'fld_status', operator: 'eq', value: 'rejected' } },
    })
    expect(field.property?.requiredWhen).toEqual({ fieldId: 'fld_status', operator: 'eq', value: 'rejected' })
  })
})
