/**
 * Pins for `src/views/formViewValidation.ts` — the public form's field
 * validation, and in particular the length gate that sits in front of
 * `new RegExp(validation.pattern)`. The same function is also replayed from
 * the backend lane (`packages/core-backend/tests/unit/user-regex-limits-three-copy-parity.test.ts`).
 *
 * MUTATION that turns the gate cases red: replace the
 * `findUserRegexLengthRefusal(...)` call in formViewValidation.ts with `null`
 * (the pattern then runs on the over-limit value and answers).
 */
import { describe, expect, it } from 'vitest'

import { validateFormField } from '../src/views/formViewValidation'
import { USER_REGEX_MAX_PATTERN_LEN, USER_REGEX_MAX_SUBJECT_LEN } from '../src/utils/userRegexLimits'
import type { FormField } from '../src/types/views'

const P = USER_REGEX_MAX_PATTERN_LEN
const S = USER_REGEX_MAX_SUBJECT_LEN

const field = (validation?: FormField['validation'], extra: Partial<FormField> = {}): FormField => ({
  id: 'f1', name: 'f1', label: '备注', type: 'text', required: false, order: 0, validation, ...extra,
})

describe('validateFormField — length gate in front of the pattern', () => {
  it('a value AT the subject limit is pattern-checked and gets its real answer', () => {
    expect(validateFormField(field({ pattern: '^a+$' }), 'a'.repeat(S))).toBeNull()
    expect(validateFormField(field({ pattern: '^b+$' }), 'a'.repeat(S))).toBe('备注 格式不正确')
  })

  it('a value one over the subject limit is refused with the length message (the pattern would have accepted it)', () => {
    expect(validateFormField(field({ pattern: '^a+$' }), 'a'.repeat(S + 1))).toBe(`备注 不能超过 ${S} 个字符`)
  })

  it('a pattern one over the pattern limit is refused with the rule-too-long message (the pattern would have mismatched)', () => {
    expect(validateFormField(field({ pattern: 'a'.repeat(P + 1) }), 'abc')).toBe('备注 的格式规则过长，无法校验')
  })

  it('the pattern limit is checked before the subject limit when both are over', () => {
    expect(validateFormField(field({ pattern: 'a'.repeat(P + 1) }), 'a'.repeat(S + 1))).toBe('备注 的格式规则过长，无法校验')
  })

  it('a pattern AT the pattern limit is compiled and run', () => {
    expect(validateFormField(field({ pattern: 'abc|' + '/'.repeat(P - 4) }), 'abc')).toBeNull()
  })

  it('an explicit maxLength below the limit reports first, as before', () => {
    expect(validateFormField(field({ maxLength: 5, pattern: '^a+$' }), 'a'.repeat(S + 1))).toBe('备注 不能超过 5 个字符')
  })
})

describe('validateFormField — the rest of the form\'s rules are unchanged by the extraction', () => {
  it.each([
    ['required, empty', field(undefined, { required: true }), '', '备注 是必填项'],
    ['required, present', field(undefined, { required: true }), 'x', null],
    ['no validation', field(), 'anything', null],
    ['minLength', field({ minLength: 3 }), 'ab', '备注 至少需要 3 个字符'],
    ['maxLength', field({ maxLength: 3 }), 'abcd', '备注 不能超过 3 个字符'],
    ['pattern mismatch', field({ pattern: '^[0-9]+$' }), 'abc', '备注 格式不正确'],
    ['pattern match', field({ pattern: '^[0-9]+$' }), '123', null],
    ['number below min', field({ min: 1 }), 0, '备注 不能小于 1'],
    ['number above max', field({ max: 9 }), 10, '备注 不能大于 9'],
    ['number in range', field({ min: 1, max: 9 }), 5, null],
    ['pattern is not applied to a number', field({ pattern: '^x$' }), 5, null],
  ])('%s', (_name, f, value, expected) => {
    expect(validateFormField(f, value)).toBe(expected)
  })
})
