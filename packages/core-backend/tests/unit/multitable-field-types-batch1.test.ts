/**
 * MF2/MF3 field types — currency / percent / rating / url / email / phone / longText.
 *
 * Covers:
 *   - mapFieldType: each new type is recognised (not falling through to 'string').
 *   - sanitizeFieldProperty: defaults applied for missing options; bad input
 *     coerced or clamped to safe defaults; round-trips for valid input.
 *   - serializeFieldRow: type + property survive round-trip.
 *   - coerceBatch1Value + per-type validators: accept valid values, reject
 *     malformed ones, return null for empty input.
 */

import { describe, it, expect } from 'vitest'
import {
  BATCH1_FIELD_TYPES,
  EMAIL_REGEX,
  PHONE_REGEX,
  URL_REGEX,
  coerceBatch1Value,
  coerceCurrencyValue,
  coercePercentValue,
  coerceRatingValue,
  mapFieldType,
  normalizeMultiSelectValue,
  sanitizeFieldProperty,
  serializeFieldRow,
  validateEmailValue,
  validateLongTextValue,
  validatePhoneValue,
  validateUrlValue,
} from '../../src/multitable/field-codecs'

describe('mapFieldType — MF2 batch-1', () => {
  it('recognises every new type literally', () => {
    expect(mapFieldType('currency')).toBe('currency')
    expect(mapFieldType('percent')).toBe('percent')
    expect(mapFieldType('rating')).toBe('rating')
    expect(mapFieldType('url')).toBe('url')
    expect(mapFieldType('email')).toBe('email')
    expect(mapFieldType('phone')).toBe('phone')
  })

  it('is case-insensitive and trims whitespace', () => {
    expect(mapFieldType('  CURRENCY  ')).toBe('currency')
    expect(mapFieldType('Email')).toBe('email')
  })

  it('keeps legacy types working', () => {
    expect(mapFieldType('string')).toBe('string')
    expect(mapFieldType('number')).toBe('number')
    expect(mapFieldType('select')).toBe('select')
  })

  it('recognises multiSelect aliases without falling back to select', () => {
    expect(mapFieldType('multiSelect')).toBe('multiSelect')
    expect(mapFieldType('multiselect')).toBe('multiSelect')
    expect(mapFieldType('multi-select')).toBe('multiSelect')
    expect(mapFieldType('multi_select')).toBe('multiSelect')
  })

  it('recognises longText aliases without falling back to string', () => {
    expect(mapFieldType('longText')).toBe('longText')
    expect(mapFieldType('long_text')).toBe('longText')
    expect(mapFieldType('textarea')).toBe('longText')
    expect(mapFieldType('multi_line_text')).toBe('longText')
  })

  it('exposes BATCH1_FIELD_TYPES set with all 6 names', () => {
    expect(Array.from(BATCH1_FIELD_TYPES).sort()).toEqual([
      'currency', 'email', 'percent', 'phone', 'rating', 'url',
    ])
  })
})

describe('sanitizeFieldProperty — currency', () => {
  it('round-trips valid input', () => {
    expect(sanitizeFieldProperty('currency', { code: 'USD', decimals: 2 })).toEqual({
      code: 'USD',
      decimals: 2,
    })
  })

  it('upper-cases code and applies CNY default for invalid code', () => {
    expect(sanitizeFieldProperty('currency', { code: 'eur', decimals: 0 })).toEqual({
      code: 'EUR',
      decimals: 0,
    })
    expect(sanitizeFieldProperty('currency', { code: 'NOTACODE', decimals: 2 })).toEqual({
      code: 'CNY',
      decimals: 2,
    })
  })

  it('clamps decimals to default 2 when invalid', () => {
    expect(sanitizeFieldProperty('currency', { code: 'USD', decimals: -1 })).toEqual({
      code: 'USD',
      decimals: 2,
    })
    expect(sanitizeFieldProperty('currency', { code: 'USD', decimals: 99 })).toEqual({
      code: 'USD',
      decimals: 2,
    })
  })

  it('falls back to defaults on empty input', () => {
    expect(sanitizeFieldProperty('currency', {})).toEqual({ code: 'CNY', decimals: 2 })
  })
})

describe('sanitizeFieldProperty — percent', () => {
  it('round-trips valid decimals', () => {
    expect(sanitizeFieldProperty('percent', { decimals: 0 })).toEqual({ decimals: 0 })
    expect(sanitizeFieldProperty('percent', { decimals: 3 })).toEqual({ decimals: 3 })
  })

  it('falls back to default 1 on missing or invalid decimals', () => {
    expect(sanitizeFieldProperty('percent', {})).toEqual({ decimals: 1 })
    expect(sanitizeFieldProperty('percent', { decimals: -2 })).toEqual({ decimals: 1 })
    expect(sanitizeFieldProperty('percent', { decimals: 'abc' })).toEqual({ decimals: 1 })
  })
})

describe('sanitizeFieldProperty — rating', () => {
  it('round-trips valid max', () => {
    expect(sanitizeFieldProperty('rating', { max: 5 })).toEqual({ max: 5 })
    expect(sanitizeFieldProperty('rating', { max: 10 })).toEqual({ max: 10 })
  })

  it('clamps max to default 5 outside [1, 10]', () => {
    expect(sanitizeFieldProperty('rating', { max: 0 })).toEqual({ max: 5 })
    expect(sanitizeFieldProperty('rating', { max: 99 })).toEqual({ max: 5 })
    expect(sanitizeFieldProperty('rating', { max: 'bad' })).toEqual({ max: 5 })
  })
})

describe('sanitizeFieldProperty — url / email / phone', () => {
  it('returns the property object unchanged (no required options)', () => {
    expect(sanitizeFieldProperty('url', {})).toEqual({})
    expect(sanitizeFieldProperty('email', {})).toEqual({})
    expect(sanitizeFieldProperty('phone', {})).toEqual({})
  })

  it('keeps custom keys for forward-compat', () => {
    expect(sanitizeFieldProperty('url', { hint: 'External link' })).toEqual({ hint: 'External link' })
  })
})

describe('sanitizeFieldProperty — longText', () => {
  it('preserves validation config for multiline text', () => {
    expect(sanitizeFieldProperty('longText', {
      validation: [{ type: 'maxLength', params: { value: 2000 } }],
      placeholder: 'Paste notes',
    })).toEqual({
      validation: [{ type: 'maxLength', params: { value: 2000 } }],
      placeholder: 'Paste notes',
    })
  })
})

describe('sanitizeFieldProperty — multiSelect', () => {
  it('preserves options and validation config', () => {
    expect(sanitizeFieldProperty('multiSelect', {
      options: [{ value: 'Urgent', color: '#f56c6c' }, { value: 'VIP' }],
      validation: [{ type: 'enum', params: { values: ['Urgent', 'VIP'] } }],
    })).toEqual({
      options: [{ value: 'Urgent', color: '#f56c6c' }, { value: 'VIP' }],
      validation: [{ type: 'enum', params: { values: ['Urgent', 'VIP'] } }],
    })
  })
})

describe('serializeFieldRow — batch-1 round-trip', () => {
  it('persists currency type + property', () => {
    const row = {
      id: 'fld_currency',
      name: 'Price',
      type: 'currency',
      property: { code: 'USD', decimals: 2 },
      order: 0,
    }
    const serialized = serializeFieldRow(row)
    expect(serialized.type).toBe('currency')
    expect(serialized.property).toEqual({ code: 'USD', decimals: 2 })
  })

  it('persists rating with sanitized max', () => {
    const serialized = serializeFieldRow({
      id: 'fld_rating',
      name: 'Score',
      type: 'rating',
      property: { max: 7 },
      order: 1,
    })
    expect(serialized.type).toBe('rating')
    expect(serialized.property).toEqual({ max: 7 })
  })

  it('persists longText type + property', () => {
    const serialized = serializeFieldRow({
      id: 'fld_notes',
      name: 'Notes',
      type: 'long_text',
      property: { validation: [{ type: 'maxLength', params: { value: 5000 } }] },
      order: 2,
    })
    expect(serialized.type).toBe('longText')
    expect(serialized.property).toEqual({
      validation: [{ type: 'maxLength', params: { value: 5000 } }],
    })
  })

  it('persists multiSelect type + options', () => {
    const serialized = serializeFieldRow({
      id: 'fld_tags',
      name: 'Tags',
      type: 'multi-select',
      property: { options: [{ value: 'Urgent', color: '#f56c6c' }, { value: 'VIP' }] },
      order: 3,
    })
    expect(serialized.type).toBe('multiSelect')
    expect(serialized.options).toEqual([{ value: 'Urgent', color: '#f56c6c' }, { value: 'VIP' }])
  })
})

describe('normalizeMultiSelectValue', () => {
  it('normalizes arrays, trims values, and removes duplicates', () => {
    expect(normalizeMultiSelectValue(['Urgent', 'VIP', 'Urgent', ''], 'fld_tags', ['Urgent', 'VIP'])).toEqual(['Urgent', 'VIP'])
  })

  it('treats empty input as an empty selection', () => {
    expect(normalizeMultiSelectValue(null, 'fld_tags', ['Urgent'])).toEqual([])
    expect(normalizeMultiSelectValue('', 'fld_tags', ['Urgent'])).toEqual([])
  })

  it('rejects scalar or unknown options', () => {
    expect(() => normalizeMultiSelectValue('Urgent', 'fld_tags', ['Urgent'])).toThrow(/must be an array/)
    expect(() => normalizeMultiSelectValue(['Missing'], 'fld_tags', ['Urgent'])).toThrow(/Invalid multi-select option/)
  })
})

describe('coerceCurrencyValue', () => {
  it('returns null for empty input', () => {
    expect(coerceCurrencyValue(null, 'fld')).toBeNull()
    expect(coerceCurrencyValue(undefined, 'fld')).toBeNull()
    expect(coerceCurrencyValue('', 'fld')).toBeNull()
  })

  it('passes finite numbers through', () => {
    expect(coerceCurrencyValue(99.99, 'fld')).toBe(99.99)
    expect(coerceCurrencyValue(0, 'fld')).toBe(0)
    expect(coerceCurrencyValue(-50, 'fld')).toBe(-50)
  })

  it('parses numeric strings', () => {
    expect(coerceCurrencyValue('1234.56', 'fld')).toBe(1234.56)
    expect(coerceCurrencyValue('  42  ', 'fld')).toBe(42)
  })

  it('throws for non-numeric strings', () => {
    expect(() => coerceCurrencyValue('abc', 'fld')).toThrow(/numeric/)
  })

  it('throws for non-finite numbers', () => {
    expect(() => coerceCurrencyValue(Infinity, 'fld')).toThrow(/finite/)
    expect(() => coerceCurrencyValue(NaN, 'fld')).toThrow(/numeric|finite/)
  })
})

describe('coercePercentValue', () => {
  it('passes valid numbers through unchanged', () => {
    expect(coercePercentValue(25.5, 'fld')).toBe(25.5)
  })

  it('parses string input', () => {
    expect(coercePercentValue('33.3', 'fld')).toBe(33.3)
  })

  it('throws on garbage', () => {
    expect(() => coercePercentValue('not-a-number', 'fld')).toThrow()
  })
})

describe('coerceRatingValue', () => {
  it('accepts integers within [0, max]', () => {
    expect(coerceRatingValue(0, 'fld', 5)).toBe(0)
    expect(coerceRatingValue(3, 'fld', 5)).toBe(3)
    expect(coerceRatingValue(5, 'fld', 5)).toBe(5)
  })

  it('rejects values above max', () => {
    expect(() => coerceRatingValue(6, 'fld', 5)).toThrow(/between/)
  })

  it('rejects negative values', () => {
    expect(() => coerceRatingValue(-1, 'fld', 5)).toThrow(/between/)
  })

  it('rejects non-integers', () => {
    expect(() => coerceRatingValue(2.5, 'fld', 5)).toThrow(/integer/)
  })

  it('returns null for empty input', () => {
    expect(coerceRatingValue(null, 'fld', 5)).toBeNull()
    expect(coerceRatingValue('', 'fld', 5)).toBeNull()
  })
})

describe('validateUrlValue', () => {
  it('accepts http/https URLs', () => {
    expect(validateUrlValue('https://example.com', 'fld')).toBe('https://example.com')
    expect(validateUrlValue('http://feishu.cn/path', 'fld')).toBe('http://feishu.cn/path')
  })

  it('rejects URLs without protocol', () => {
    expect(() => validateUrlValue('example.com', 'fld')).toThrow(/Invalid URL/)
  })

  it('rejects ftp/javascript schemes (only http/https allowed)', () => {
    expect(() => validateUrlValue('ftp://example.com', 'fld')).toThrow(/Invalid URL/)
    expect(() => validateUrlValue('javascript:alert(1)', 'fld')).toThrow(/Invalid URL/)
  })

  it('returns null for empty input', () => {
    expect(validateUrlValue(null, 'fld')).toBeNull()
    expect(validateUrlValue('', 'fld')).toBeNull()
  })

  it('throws for non-string input', () => {
    expect(() => validateUrlValue(123, 'fld')).toThrow(/string/)
  })
})

describe('validateEmailValue', () => {
  it('accepts standard email addresses', () => {
    expect(validateEmailValue('user@example.com', 'fld')).toBe('user@example.com')
    expect(validateEmailValue('first.last+tag@sub.domain.co', 'fld')).toBe('first.last+tag@sub.domain.co')
  })

  it('rejects malformed emails', () => {
    expect(() => validateEmailValue('not-an-email', 'fld')).toThrow(/Invalid email/)
    expect(() => validateEmailValue('@example.com', 'fld')).toThrow(/Invalid email/)
    expect(() => validateEmailValue('user@', 'fld')).toThrow(/Invalid email/)
    expect(() => validateEmailValue('user@example', 'fld')).toThrow(/Invalid email/)
  })

  it('returns null for empty', () => {
    expect(validateEmailValue('', 'fld')).toBeNull()
  })
})

describe('validatePhoneValue', () => {
  it('accepts common phone formats', () => {
    expect(validatePhoneValue('+86 138 0000 0000', 'fld')).toBe('+86 138 0000 0000')
    expect(validatePhoneValue('+1-415-555-1234', 'fld')).toBe('+1-415-555-1234')
    expect(validatePhoneValue('13800001234', 'fld')).toBe('13800001234')
    expect(validatePhoneValue('(02) 1234 5678', 'fld')).toBe('(02) 1234 5678')
  })

  it('rejects too-short numbers', () => {
    expect(() => validatePhoneValue('123', 'fld')).toThrow(/Invalid phone/)
  })

  it('rejects letters and other invalid chars', () => {
    expect(() => validatePhoneValue('not-a-number', 'fld')).toThrow(/Invalid phone/)
  })

  it('returns null for empty', () => {
    expect(validatePhoneValue('', 'fld')).toBeNull()
  })
})

describe('validateLongTextValue', () => {
  it('preserves multiline strings exactly', () => {
    expect(validateLongTextValue('line 1\n  line 2\n', 'fld_notes')).toBe('line 1\n  line 2\n')
  })

  it('returns null for empty input', () => {
    expect(validateLongTextValue(null, 'fld_notes')).toBeNull()
    expect(validateLongTextValue('', 'fld_notes')).toBeNull()
  })

  it('rejects non-string input', () => {
    expect(() => validateLongTextValue(['line'], 'fld_notes')).toThrow(/Long text value must be a string/)
  })
})

describe('coerceBatch1Value — dispatch', () => {
  it('dispatches to currency / percent / rating coercion', () => {
    expect(coerceBatch1Value('currency', { code: 'USD', decimals: 2 }, 'fld', '99.99')).toBe(99.99)
    expect(coerceBatch1Value('percent', { decimals: 1 }, 'fld', '12.5')).toBe(12.5)
    expect(coerceBatch1Value('rating', { max: 5 }, 'fld', 4)).toBe(4)
  })

  it('dispatches to url / email / phone validation', () => {
    expect(coerceBatch1Value('url', undefined, 'fld', 'https://feishu.cn')).toBe('https://feishu.cn')
    expect(coerceBatch1Value('email', undefined, 'fld', 'a@b.co')).toBe('a@b.co')
    expect(coerceBatch1Value('phone', undefined, 'fld', '+86 138 0000 0000')).toBe('+86 138 0000 0000')
  })

  it('uses default rating max when property missing', () => {
    // Default max is 5; value of 6 should throw.
    expect(() => coerceBatch1Value('rating', undefined, 'fld', 6)).toThrow(/between/)
  })

  it('respects custom rating max from property', () => {
    expect(coerceBatch1Value('rating', { max: 10 }, 'fld', 8)).toBe(8)
  })

  it('passes through non-batch1 types untouched', () => {
    expect(coerceBatch1Value('string', undefined, 'fld', 'hello')).toBe('hello')
    expect(coerceBatch1Value('number', undefined, 'fld', 42)).toBe(42)
  })

  it('returns null for empty values across the batch', () => {
    expect(coerceBatch1Value('currency', { code: 'CNY', decimals: 2 }, 'fld', null)).toBeNull()
    expect(coerceBatch1Value('percent', { decimals: 1 }, 'fld', '')).toBeNull()
    expect(coerceBatch1Value('rating', { max: 5 }, 'fld', undefined)).toBeNull()
    expect(coerceBatch1Value('url', undefined, 'fld', null)).toBeNull()
    expect(coerceBatch1Value('email', undefined, 'fld', '')).toBeNull()
    expect(coerceBatch1Value('phone', undefined, 'fld', null)).toBeNull()
  })

  it('surfaces validation errors as thrown exceptions', () => {
    expect(() => coerceBatch1Value('email', undefined, 'fld', 'bogus')).toThrow(/Invalid email/)
    expect(() => coerceBatch1Value('url', undefined, 'fld', 'no-protocol.com')).toThrow(/Invalid URL/)
    expect(() => coerceBatch1Value('phone', undefined, 'fld', 'abc')).toThrow(/Invalid phone/)
  })
})

describe('exported regex patterns', () => {
  it('URL_REGEX requires http/https protocol', () => {
    expect(URL_REGEX.test('https://example.com')).toBe(true)
    expect(URL_REGEX.test('http://example.com')).toBe(true)
    expect(URL_REGEX.test('ftp://example.com')).toBe(false)
    expect(URL_REGEX.test('example.com')).toBe(false)
  })

  it('EMAIL_REGEX matches simple Feishu-compatible shape', () => {
    expect(EMAIL_REGEX.test('a@b.c')).toBe(true)
    expect(EMAIL_REGEX.test('user.name@sub.example.co')).toBe(true)
    expect(EMAIL_REGEX.test('a@b')).toBe(false)
  })

  it('PHONE_REGEX is lenient (digits + separators, 6+ chars)', () => {
    expect(PHONE_REGEX.test('+86 138 0000 0000')).toBe(true)
    expect(PHONE_REGEX.test('1 415 555 1234')).toBe(true)
    expect(PHONE_REGEX.test('123')).toBe(false)
  })
})
