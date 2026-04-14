import { describe, expect, test } from 'vitest'
import {
  validateFieldValue,
  validateRecord,
  getDefaultValidationRules,
} from '../../src/multitable/field-validation-engine'
import type { FieldValidationConfig } from '../../src/multitable/field-validation'

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function errors(
  fieldType: string,
  value: unknown,
  rules: FieldValidationConfig,
) {
  return validateFieldValue('fld_1', 'TestField', fieldType, value, rules)
}

// ---------------------------------------------------------------------------
// required
// ---------------------------------------------------------------------------

describe('required rule', () => {
  const rules: FieldValidationConfig = [{ type: 'required' }]

  test('null fails', () => {
    const errs = errors('string', null, rules)
    expect(errs).toHaveLength(1)
    expect(errs[0].rule).toBe('required')
  })

  test('undefined fails', () => {
    expect(errors('string', undefined, rules)).toHaveLength(1)
  })

  test('empty string fails', () => {
    expect(errors('string', '', rules)).toHaveLength(1)
  })

  test('whitespace-only string fails', () => {
    expect(errors('string', '   ', rules)).toHaveLength(1)
  })

  test('empty array fails', () => {
    expect(errors('select', [], rules)).toHaveLength(1)
  })

  test('non-empty string passes', () => {
    expect(errors('string', 'hello', rules)).toHaveLength(0)
  })

  test('zero passes (0 is not empty)', () => {
    expect(errors('number', 0, rules)).toHaveLength(0)
  })

  test('false passes (boolean false is not empty)', () => {
    expect(errors('boolean', false, rules)).toHaveLength(0)
  })

  test('non-empty array passes', () => {
    expect(errors('select', ['a'], rules)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// min / max
// ---------------------------------------------------------------------------

describe('min rule', () => {
  const rules: FieldValidationConfig = [{ type: 'min', params: { value: 5 } }]

  test('below min fails', () => {
    const errs = errors('number', 4, rules)
    expect(errs).toHaveLength(1)
    expect(errs[0].rule).toBe('min')
  })

  test('exact min passes', () => {
    expect(errors('number', 5, rules)).toHaveLength(0)
  })

  test('above min passes', () => {
    expect(errors('number', 100, rules)).toHaveLength(0)
  })

  test('string-encoded number works', () => {
    expect(errors('number', '10', rules)).toHaveLength(0)
  })

  test('NaN fails', () => {
    expect(errors('number', NaN, rules)).toHaveLength(1)
  })

  test('non-numeric string fails', () => {
    expect(errors('number', 'abc', rules)).toHaveLength(1)
  })
})

describe('max rule', () => {
  const rules: FieldValidationConfig = [{ type: 'max', params: { value: 100 } }]

  test('above max fails', () => {
    expect(errors('number', 101, rules)).toHaveLength(1)
  })

  test('exact max passes', () => {
    expect(errors('number', 100, rules)).toHaveLength(0)
  })

  test('below max passes', () => {
    expect(errors('number', 50, rules)).toHaveLength(0)
  })

  test('negative value passes', () => {
    expect(errors('number', -999, rules)).toHaveLength(0)
  })
})

describe('combined min + max', () => {
  const rules: FieldValidationConfig = [
    { type: 'min', params: { value: 1 } },
    { type: 'max', params: { value: 10 } },
  ]

  test('value in range passes', () => {
    expect(errors('number', 5, rules)).toHaveLength(0)
  })

  test('value below range fails with min', () => {
    const errs = errors('number', 0, rules)
    expect(errs).toHaveLength(1)
    expect(errs[0].rule).toBe('min')
  })

  test('value above range fails with max', () => {
    const errs = errors('number', 11, rules)
    expect(errs).toHaveLength(1)
    expect(errs[0].rule).toBe('max')
  })
})

// ---------------------------------------------------------------------------
// minLength / maxLength
// ---------------------------------------------------------------------------

describe('minLength rule', () => {
  const rules: FieldValidationConfig = [{ type: 'minLength', params: { value: 3 } }]

  test('short string fails', () => {
    const errs = errors('string', 'ab', rules)
    expect(errs).toHaveLength(1)
    expect(errs[0].rule).toBe('minLength')
  })

  test('exact length passes', () => {
    expect(errors('string', 'abc', rules)).toHaveLength(0)
  })

  test('longer string passes', () => {
    expect(errors('string', 'abcdef', rules)).toHaveLength(0)
  })

  test('array length checked', () => {
    expect(errors('select', ['a', 'b'], rules)).toHaveLength(1)
    expect(errors('select', ['a', 'b', 'c'], rules)).toHaveLength(0)
  })
})

describe('maxLength rule', () => {
  const rules: FieldValidationConfig = [{ type: 'maxLength', params: { value: 5 } }]

  test('too long string fails', () => {
    expect(errors('string', 'abcdef', rules)).toHaveLength(1)
  })

  test('exact length passes', () => {
    expect(errors('string', 'abcde', rules)).toHaveLength(0)
  })

  test('short string passes', () => {
    expect(errors('string', 'ab', rules)).toHaveLength(0)
  })

  test('very long string fails', () => {
    expect(errors('string', 'a'.repeat(10001), rules)).toHaveLength(1)
  })

  test('array length checked', () => {
    expect(errors('select', ['a', 'b', 'c', 'd', 'e', 'f'], rules)).toHaveLength(1)
    expect(errors('select', ['a', 'b', 'c', 'd', 'e'], rules)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// pattern
// ---------------------------------------------------------------------------

describe('pattern rule', () => {
  const emailRules: FieldValidationConfig = [
    { type: 'pattern', params: { regex: '^[^@]+@[^@]+\\.[^@]+$' } },
  ]

  test('valid email passes', () => {
    expect(errors('string', 'test@example.com', emailRules)).toHaveLength(0)
  })

  test('invalid email fails', () => {
    expect(errors('string', 'not-an-email', emailRules)).toHaveLength(1)
  })

  test('flag support (case insensitive)', () => {
    const rules: FieldValidationConfig = [
      { type: 'pattern', params: { regex: '^abc$', flags: 'i' } },
    ]
    expect(errors('string', 'ABC', rules)).toHaveLength(0)
    expect(errors('string', 'xyz', rules)).toHaveLength(1)
  })

  test('special regex chars in value do not break', () => {
    const rules: FieldValidationConfig = [
      { type: 'pattern', params: { regex: '^\\d+$' } },
    ]
    expect(errors('string', '123', rules)).toHaveLength(0)
    expect(errors('string', '12.3', rules)).toHaveLength(1)
  })

  test('invalid regex treated as failure', () => {
    const rules: FieldValidationConfig = [
      { type: 'pattern', params: { regex: '[invalid' } },
    ]
    expect(errors('string', 'anything', rules)).toHaveLength(1)
  })

  test('non-string value fails', () => {
    expect(errors('string', 42, emailRules)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// enum
// ---------------------------------------------------------------------------

describe('enum rule', () => {
  const rules: FieldValidationConfig = [
    { type: 'enum', params: { values: ['red', 'green', 'blue'] } },
  ]

  test('value in list passes', () => {
    expect(errors('select', 'red', rules)).toHaveLength(0)
  })

  test('value not in list fails', () => {
    const errs = errors('select', 'yellow', rules)
    expect(errs).toHaveLength(1)
    expect(errs[0].rule).toBe('enum')
  })

  test('number value compared as string', () => {
    const numRules: FieldValidationConfig = [
      { type: 'enum', params: { values: ['1', '2', '3'] } },
    ]
    expect(errors('select', 2, numRules)).toHaveLength(0)
    expect(errors('select', 4, numRules)).toHaveLength(1)
  })

  test('empty values list always fails', () => {
    const emptyRules: FieldValidationConfig = [
      { type: 'enum', params: { values: [] } },
    ]
    expect(errors('select', 'any', emptyRules)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// validateRecord
// ---------------------------------------------------------------------------

describe('validateRecord', () => {
  test('returns valid:true when no rules', () => {
    const result = validateRecord(
      [{ id: 'fld_1', name: 'Name', type: 'string' }],
      { fld_1: 'hello' },
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  test('returns valid:true when all rules pass', () => {
    const result = validateRecord(
      [
        { id: 'fld_1', name: 'Name', type: 'string', config: { validation: [{ type: 'required' }] } },
        { id: 'fld_2', name: 'Age', type: 'number', config: { validation: [{ type: 'min', params: { value: 0 } }] } },
      ],
      { fld_1: 'Alice', fld_2: 25 },
    )
    expect(result.valid).toBe(true)
  })

  test('returns all errors at once (not fail-fast)', () => {
    const result = validateRecord(
      [
        { id: 'fld_1', name: 'Name', type: 'string', config: { validation: [{ type: 'required' }] } },
        { id: 'fld_2', name: 'Age', type: 'number', config: { validation: [{ type: 'min', params: { value: 0 } }] } },
      ],
      { fld_1: '', fld_2: -5 },
    )
    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(2)
    expect(result.errors.map((e) => e.fieldId).sort()).toEqual(['fld_1', 'fld_2'])
  })

  test('mixed valid/invalid fields', () => {
    const result = validateRecord(
      [
        { id: 'fld_1', name: 'Name', type: 'string', config: { validation: [{ type: 'required' }] } },
        { id: 'fld_2', name: 'Color', type: 'select', config: { validation: [{ type: 'enum', params: { values: ['r', 'g', 'b'] } }] } },
      ],
      { fld_1: 'Alice', fld_2: 'yellow' },
    )
    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].fieldId).toBe('fld_2')
  })

  test('fields without config are skipped', () => {
    const result = validateRecord(
      [
        { id: 'fld_1', name: 'Name', type: 'string' },
        { id: 'fld_2', name: 'Color', type: 'select', config: { validation: [{ type: 'required' }] } },
      ],
      { fld_1: '', fld_2: 'red' },
    )
    expect(result.valid).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Default messages
// ---------------------------------------------------------------------------

describe('default messages', () => {
  test('required message includes field name', () => {
    const errs = validateFieldValue('fld_1', 'Email', 'string', null, [{ type: 'required' }])
    expect(errs[0].message).toContain('Email')
    expect(errs[0].message).toContain('required')
  })

  test('min message includes limit value', () => {
    const errs = validateFieldValue('fld_1', 'Score', 'number', 0, [{ type: 'min', params: { value: 10 } }])
    expect(errs[0].message).toContain('10')
  })

  test('max message includes limit value', () => {
    const errs = validateFieldValue('fld_1', 'Score', 'number', 200, [{ type: 'max', params: { value: 100 } }])
    expect(errs[0].message).toContain('100')
  })

  test('pattern message mentions format', () => {
    const errs = validateFieldValue('fld_1', 'Code', 'string', 'bad', [
      { type: 'pattern', params: { regex: '^\\d+$' } },
    ])
    expect(errs[0].message).toContain('format')
  })
})

// ---------------------------------------------------------------------------
// Custom messages
// ---------------------------------------------------------------------------

describe('custom messages', () => {
  test('custom message overrides default', () => {
    const errs = validateFieldValue('fld_1', 'Email', 'string', null, [
      { type: 'required', message: 'Please enter your email' },
    ])
    expect(errs[0].message).toBe('Please enter your email')
  })

  test('custom message for pattern', () => {
    const errs = validateFieldValue('fld_1', 'Email', 'string', 'bad', [
      { type: 'pattern', params: { regex: '^[^@]+@[^@]+$' }, message: 'Must be a valid email' },
    ])
    expect(errs[0].message).toBe('Must be a valid email')
  })
})

// ---------------------------------------------------------------------------
// Null value skips non-required rules
// ---------------------------------------------------------------------------

describe('null value behavior', () => {
  test('null skips min rule', () => {
    expect(errors('number', null, [{ type: 'min', params: { value: 0 } }])).toHaveLength(0)
  })

  test('null skips maxLength rule', () => {
    expect(errors('string', null, [{ type: 'maxLength', params: { value: 5 } }])).toHaveLength(0)
  })

  test('null skips pattern rule', () => {
    expect(errors('string', null, [{ type: 'pattern', params: { regex: '.*' } }])).toHaveLength(0)
  })

  test('null skips enum rule', () => {
    expect(errors('select', null, [{ type: 'enum', params: { values: ['a'] } }])).toHaveLength(0)
  })

  test('undefined skips all non-required rules', () => {
    const rules: FieldValidationConfig = [
      { type: 'min', params: { value: 0 } },
      { type: 'max', params: { value: 100 } },
      { type: 'pattern', params: { regex: '.*' } },
    ]
    expect(errors('number', undefined, rules)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// getDefaultValidationRules
// ---------------------------------------------------------------------------

describe('getDefaultValidationRules', () => {
  test('string type returns maxLength 10000', () => {
    const rules = getDefaultValidationRules('string')
    expect(rules).toHaveLength(1)
    expect(rules[0].type).toBe('maxLength')
    expect((rules[0].params as any).value).toBe(10000)
  })

  test('select type returns enum from options', () => {
    const rules = getDefaultValidationRules('select', {
      options: [{ value: 'red' }, { value: 'blue' }],
    })
    expect(rules).toHaveLength(1)
    expect(rules[0].type).toBe('enum')
    expect((rules[0].params as any).values).toEqual(['red', 'blue'])
  })

  test('select type with string options', () => {
    const rules = getDefaultValidationRules('select', {
      options: ['a', 'b', 'c'],
    })
    expect(rules).toHaveLength(1)
    expect((rules[0].params as any).values).toEqual(['a', 'b', 'c'])
  })

  test('number type returns empty', () => {
    expect(getDefaultValidationRules('number')).toHaveLength(0)
  })

  test('unknown type returns empty', () => {
    expect(getDefaultValidationRules('foobar')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  test('NaN for min rule fails', () => {
    expect(errors('number', NaN, [{ type: 'min', params: { value: 0 } }])).toHaveLength(1)
  })

  test('Infinity passes max if value is not above', () => {
    expect(errors('number', Infinity, [{ type: 'max', params: { value: Infinity } }])).toHaveLength(0)
  })

  test('empty string skips non-required rules (treated as empty)', () => {
    const rules: FieldValidationConfig = [
      { type: 'minLength', params: { value: 3 } },
    ]
    expect(errors('string', '', rules)).toHaveLength(0)
  })

  test('empty string + required + minLength returns only required error', () => {
    const rules: FieldValidationConfig = [
      { type: 'required' },
      { type: 'minLength', params: { value: 3 } },
    ]
    const errs = errors('string', '', rules)
    expect(errs).toHaveLength(1)
    expect(errs[0].rule).toBe('required')
  })

  test('custom rule type is skipped (pass-through)', () => {
    expect(errors('string', 'test', [{ type: 'custom' }])).toHaveLength(0)
  })

  test('multiple rules collect all failures', () => {
    const rules: FieldValidationConfig = [
      { type: 'required' },
      { type: 'minLength', params: { value: 5 } },
      { type: 'pattern', params: { regex: '^[a-z]+$' } },
    ]
    // 'AB' is non-empty (passes required), too short (fails minLength), uppercase (fails pattern)
    const errs = errors('string', 'AB', rules)
    expect(errs).toHaveLength(2)
    expect(errs.map((e) => e.rule).sort()).toEqual(['minLength', 'pattern'])
  })
})
