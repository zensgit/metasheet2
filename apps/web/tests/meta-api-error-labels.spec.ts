import { describe, expect, it } from 'vitest'

import {
  META_API_ERROR_LABEL_KEYS,
  aiRetryCountdown,
  aiShortcutErrorMessage,
  apiDefaultErrorMessage,
  apiFieldValidationFallback,
  metaApiErrorLabel,
} from '../src/multitable/utils/meta-api-error-labels'
import { networkUnavailableMessage } from '../src/utils/networkErrors'

describe('meta-api-error-labels', () => {
  it('exposes all API fallback keys in both locales', () => {
    expect(META_API_ERROR_LABEL_KEYS).toEqual([
      'error.forbidden',
      'error.unauthenticated',
      'error.validation',
      'error.fieldValidation',
      // F8A: the server-side lossless-retype whitelist refusal (FIELD_RETYPE_NOT_LOSSLESS).
      'error.fieldRetypeNotLossless',
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
      // F4-B gateway-outage copy (502/503/504).
      'error.serverRestarting',
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
    // F8A: a stable refusal code gets real copy in BOTH locales instead of `API 400`
    // (the server's own Chinese message still wins in parseJson when one is present).
    expect(apiDefaultErrorMessage('FIELD_RETYPE_NOT_LOSSLESS', 400, true))
      .toBe('这样改字段类型会让已有数据不可读，已被拒绝。只允许无损的类型转换。')
    expect(apiDefaultErrorMessage('FIELD_RETYPE_NOT_LOSSLESS', 400, false))
      .toBe('This field type change would make the existing data unreadable, so it was refused. Only lossless conversions are allowed.')
    // values-free: the copy names no field id
    expect(apiDefaultErrorMessage('FIELD_RETYPE_NOT_LOSSLESS', 400, true)).not.toMatch(/fld[_-]/)
  })

  it('keeps unknown API status fallback technical and locale-neutral', () => {
    expect(apiDefaultErrorMessage('SOMETHING_NEW', 418, false)).toBe('API 418')
    expect(apiDefaultErrorMessage('SOMETHING_NEW', 418, true)).toBe('API 418')
    expect(apiDefaultErrorMessage(undefined, 500, true)).toBe('API 500')
  })

  // F4-B: during a backend outage nginx answers 502/503/504 with no JSON body, so
  // client.ts falls through to apiDefaultErrorMessage and the red toast used to read
  // "API 502". Gateway statuses now get human copy; 500 deliberately does not.
  it('F4-B: 502/503/504 get neutral human copy in both locales', () => {
    for (const status of [502, 503, 504]) {
      expect(apiDefaultErrorMessage(undefined, status, true)).toBe('服务暂时不可用，请稍后重试')
      expect(apiDefaultErrorMessage(undefined, status, false))
        .toBe('The service is temporarily unavailable. Please try again in a moment.')
      expect(apiDefaultErrorMessage(undefined, status, true)).not.toBe(`API ${status}`)
      // Neutral by owner ruling: the copy must not announce an upgrade.
      expect(apiDefaultErrorMessage(undefined, status, true)).not.toContain('升级')
      expect(apiDefaultErrorMessage(undefined, status, false).toLowerCase()).not.toContain('upgrad')
    }
    // A gateway code with the same status resolves identically.
    expect(apiDefaultErrorMessage('BAD_GATEWAY', 502, true)).toBe('服务暂时不可用，请稍后重试')
    expect(apiDefaultErrorMessage('GATEWAY_TIMEOUT', 504, true)).toBe('服务暂时不可用，请稍后重试')
  })

  it('F4-B BOUNDARY: 500 and 501 stay `API <status>` — an app bug must not read as "retry in a moment"', () => {
    expect(apiDefaultErrorMessage(undefined, 500, true)).toBe('API 500')
    expect(apiDefaultErrorMessage(undefined, 500, false)).toBe('API 500')
    expect(apiDefaultErrorMessage('INTERNAL_ERROR', 500, true)).toBe('API 500')
    expect(apiDefaultErrorMessage(undefined, 501, true)).toBe('API 501')
    expect(apiDefaultErrorMessage(undefined, 505, true)).toBe('API 505')
  })

  // F4-B CONTRACT (cross-module): the two outage copies live in two files on two different
  // layers — utils/networkErrors.ts (no HTTP response at all) and this module (gateway answered
  // 502/503/504). A user cannot tell the two apart, so they must be BYTE-IDENTICAL per locale.
  // Nothing else enforces that: api.spec.ts's EN assertion used to compare the helper with
  // itself, so rewriting only one of the two files left every spec green. These assertions are
  // the whole enforcement of the "one wording, two layers" ruling.
  it('F4-B CONTRACT: transport copy and gateway-status copy are identical in both locales', () => {
    expect(networkUnavailableMessage(false)).toBe(metaApiErrorLabel('error.serverRestarting', false))
    expect(networkUnavailableMessage(true)).toBe(metaApiErrorLabel('error.serverRestarting', true))
    // …and identical through the status path the gateway actually takes.
    expect(networkUnavailableMessage(false)).toBe(apiDefaultErrorMessage(undefined, 502, false))
    expect(networkUnavailableMessage(true)).toBe(apiDefaultErrorMessage(undefined, 503, true))
    expect(networkUnavailableMessage(false)).toBe(apiDefaultErrorMessage(undefined, 504, false))
    // Both sides pinned to the literal, so a matched rename of BOTH files still turns this red.
    expect(networkUnavailableMessage(false)).toBe('The service is temporarily unavailable. Please try again in a moment.')
    expect(networkUnavailableMessage(true)).toBe('服务暂时不可用，请稍后重试')
    // The EN/zh pair must stay two distinct strings (a copy-paste slip is a real failure mode).
    expect(networkUnavailableMessage(true)).not.toBe(networkUnavailableMessage(false))
  })

  it('F4-B REGRESSION: the code-keyed branches still win over the new status branch', () => {
    expect(apiDefaultErrorMessage('FORBIDDEN', 502, true)).toBe('权限不足')
    expect(apiDefaultErrorMessage('UNAUTHENTICATED', 503, true)).toBe('请先登录后继续。')
    expect(apiDefaultErrorMessage('VALIDATION_ERROR', 504, true)).toBe('请检查提交的数据后重试。')
  })
})
