// Multitable API fallback error chrome.
//
// Scope: frontend-generated fallback strings only. Backend payload messages,
// field error values, legacy string errors, codes, and HTTP status metadata
// stay raw in the API client.

type LocaleText = { en: string; zh: string }

export type MetaApiErrorLabelKey =
  | 'error.forbidden'
  | 'error.unauthenticated'
  | 'error.validation'
  | 'error.fieldValidation'

const META_API_ERROR_LABELS: Record<MetaApiErrorLabelKey, LocaleText> = {
  'error.forbidden': { en: 'Insufficient permissions', zh: '权限不足' },
  'error.unauthenticated': { en: 'Please sign in to continue.', zh: '请先登录后继续。' },
  'error.validation': { en: 'Please check the submitted data and try again.', zh: '请检查提交的数据后重试。' },
  'error.fieldValidation': { en: 'Validation failed', zh: '验证失败' },
}

export const META_API_ERROR_LABEL_KEYS = Object.freeze(
  Object.keys(META_API_ERROR_LABELS) as MetaApiErrorLabelKey[],
)

export function metaApiErrorLabel(key: MetaApiErrorLabelKey, isZh: boolean): string {
  return META_API_ERROR_LABELS[key][isZh ? 'zh' : 'en']
}

export function apiFieldValidationFallback(isZh = false): string {
  return metaApiErrorLabel('error.fieldValidation', isZh)
}

export function apiDefaultErrorMessage(code: string | undefined, status: number, isZh = false): string {
  switch (code) {
    case 'FORBIDDEN':
      return metaApiErrorLabel('error.forbidden', isZh)
    case 'UNAUTHENTICATED':
      return metaApiErrorLabel('error.unauthenticated', isZh)
    case 'VALIDATION_ERROR':
      return metaApiErrorLabel('error.validation', isZh)
    default:
      return `API ${status}`
  }
}
