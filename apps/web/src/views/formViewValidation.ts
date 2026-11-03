/**
 * Field validation for the public form (`FormView.vue`).
 *
 * Extracted from the view so the length gate that sits in front of
 * `new RegExp(validation.pattern)` is an importable pure function rather than
 * a closure inside a component. It is called by `tests/formViewValidation.spec.ts`
 * (this root) and by
 * `packages/core-backend/tests/unit/user-regex-limits-three-copy-parity.test.ts`
 * (backend lane). The view delegates here; the messages are the ones the form
 * showed before the extraction.
 */
import type { FormField } from '../types/views'
import { findUserRegexLengthRefusal } from '../utils/userRegexLimits'

export function validateFormField(field: FormField, value: unknown): string | null {
  if (field.required && (!value || value === '')) {
    return `${field.label} 是必填项`
  }

  if (!field.validation) return null

  const validation = field.validation

  if (typeof value === 'string') {
    if (validation.minLength && value.length < validation.minLength) {
      return `${field.label} 至少需要 ${validation.minLength} 个字符`
    }
    if (validation.maxLength && value.length > validation.maxLength) {
      return `${field.label} 不能超过 ${validation.maxLength} 个字符`
    }
    if (validation.pattern) {
      // Same length limits as the backend's pattern rule (utils/userRegexLimits.ts):
      // a value over the limit is refused before the pattern runs on it.
      const refusal = findUserRegexLengthRefusal(validation.pattern.length, value.length)
      if (refusal) {
        return refusal.kind === 'subject-too-long'
          ? `${field.label} 不能超过 ${refusal.limit} 个字符`
          : `${field.label} 的格式规则过长，无法校验`
      }
      const regex = new RegExp(validation.pattern)
      if (!regex.test(value)) {
        return `${field.label} 格式不正确`
      }
    }
  }

  if (typeof value === 'number') {
    if (validation.min !== undefined && value < validation.min) {
      return `${field.label} 不能小于 ${validation.min}`
    }
    if (validation.max !== undefined && value > validation.max) {
      return `${field.label} 不能大于 ${validation.max}`
    }
  }

  return null
}
