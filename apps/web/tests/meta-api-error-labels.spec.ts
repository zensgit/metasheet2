import { describe, expect, it } from 'vitest'

import {
  META_API_ERROR_LABEL_KEYS,
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
    ])

    for (const key of META_API_ERROR_LABEL_KEYS) {
      expect(metaApiErrorLabel(key, false)).toBeTruthy()
      expect(metaApiErrorLabel(key, true)).toBeTruthy()
    }
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
