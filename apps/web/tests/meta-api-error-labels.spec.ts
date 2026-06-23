import { describe, expect, it } from 'vitest'

import {
  META_API_ERROR_LABEL_KEYS,
  aiRetryCountdown,
  aiShortcutErrorMessage,
  apiDefaultErrorMessage,
  apiFieldValidationFallback,
  metaApiErrorLabel,
} from '../src/multitable/utils/meta-api-error-labels'

describe('meta-api-error-labels', () => {
  it('exposes all API fallback keys in both locales', () => {
    expect(META_API_ERROR_LABEL_KEYS).toEqual([
      'error.forbidden',
      'error.unauthenticated',
      'error.validation',
      'error.fieldValidation',
      // A3 AI shortcut state copy (§2.3) — keyed on error.code.
      'error.aiBlocked',
      'error.aiRateLimited',
      'error.aiQuotaExhausted',
      'error.aiUnsafeInput',
      'error.aiProviderError',
      'error.aiVersionConflict',
      // B-3 AI bulk-fill state copy — bulk-specific error codes.
      'error.aiBulkQuotaInsufficient',
      'error.aiBulkScopeTooLarge',
      'error.aiBulkViewFilterUnsupported',
      'error.aiBulkInlineConfigRejected',
      'error.aiBulkFieldForbidden',
      // B-4 AI bulk async-job lifecycle conflicts.
      'error.aiBulkActiveJobExists',
      'error.aiBulkJobNotCommittable',
      'error.aiBulkJobCommitInProgress',
    ])

    for (const key of META_API_ERROR_LABEL_KEYS) {
      expect(metaApiErrorLabel(key, false)).toBeTruthy()
      expect(metaApiErrorLabel(key, true)).toBeTruthy()
    }
  })

  it('A3-T8: maps every AI shortcut error code to §2.3 copy in both locales; unknown codes → null', () => {
    const codes = ['AI_BLOCKED', 'RATE_LIMITED', 'AI_QUOTA_EXHAUSTED', 'AI_UNSAFE_INPUT', 'AI_PROVIDER_ERROR', 'VERSION_CONFLICT']
    for (const code of codes) {
      expect(aiShortcutErrorMessage(code, false)).toBeTruthy()
      expect(aiShortcutErrorMessage(code, true)).toBeTruthy()
    }
    // AI_BLOCKED has dedicated readiness copy — never a generic 5xx message.
    expect(aiShortcutErrorMessage('AI_BLOCKED', true)).toContain('管理员')
    // Unknown codes fall back to the raw backend message at the caller.
    expect(aiShortcutErrorMessage('SOMETHING_NEW', false)).toBeNull()
    expect(aiShortcutErrorMessage(undefined, false)).toBeNull()
  })

  it('A3-T8: rate-limit countdown copy interpolates the seconds in both locales', () => {
    expect(aiRetryCountdown(5, false)).toBe('Retry in 5s')
    expect(aiRetryCountdown(5, true)).toBe('5 秒后可重试')
  })

  it('localizes static fallback labels', () => {
    expect(metaApiErrorLabel('error.forbidden', false)).toBe('Insufficient permissions')
    expect(metaApiErrorLabel('error.forbidden', true)).toBe('权限不足')
    expect(metaApiErrorLabel('error.unauthenticated', false)).toBe('Please sign in to continue.')
    expect(metaApiErrorLabel('error.unauthenticated', true)).toBe('请先登录后继续。')
    expect(metaApiErrorLabel('error.validation', false)).toBe('Please check the submitted data and try again.')
    expect(metaApiErrorLabel('error.validation', true)).toBe('请检查提交的数据后重试。')
  })

  it('localizes field validation fallbacks', () => {
    expect(apiFieldValidationFallback(false)).toBe('Validation failed')
    expect(apiFieldValidationFallback(true)).toBe('验证失败')
    expect(apiFieldValidationFallback()).toBe('Validation failed')
  })

  it('maps API error codes to localized fallback messages', () => {
    expect(apiDefaultErrorMessage('FORBIDDEN', 403, false)).toBe('Insufficient permissions')
    expect(apiDefaultErrorMessage('FORBIDDEN', 403, true)).toBe('权限不足')
    expect(apiDefaultErrorMessage('UNAUTHENTICATED', 401, true)).toBe('请先登录后继续。')
    expect(apiDefaultErrorMessage('VALIDATION_ERROR', 422, true)).toBe('请检查提交的数据后重试。')
  })

  it('keeps unknown API status fallback technical and locale-neutral', () => {
    expect(apiDefaultErrorMessage('SOMETHING_NEW', 418, false)).toBe('API 418')
    expect(apiDefaultErrorMessage('SOMETHING_NEW', 418, true)).toBe('API 418')
    expect(apiDefaultErrorMessage(undefined, 500, true)).toBe('API 500')
  })
})
