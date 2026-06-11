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
  // AI shortcut state copy (A3 §2.3) — keyed STRICTLY on error.code; the body
  // top-level `status` discriminator never reaches the frontend.
  | 'error.aiBlocked'
  | 'error.aiRateLimited'
  | 'error.aiQuotaExhausted'
  | 'error.aiUnsafeInput'
  | 'error.aiProviderError'
  | 'error.aiVersionConflict'

const META_API_ERROR_LABELS: Record<MetaApiErrorLabelKey, LocaleText> = {
  'error.forbidden': { en: 'Insufficient permissions', zh: '权限不足' },
  'error.unauthenticated': { en: 'Please sign in to continue.', zh: '请先登录后继续。' },
  'error.validation': { en: 'Please check the submitted data and try again.', zh: '请检查提交的数据后重试。' },
  'error.fieldValidation': { en: 'Validation failed', zh: '验证失败' },
  // AI_BLOCKED is a deliberate readiness state, NOT a generic 5xx outage —
  // admins diagnose it via the A1 readiness endpoint.
  'error.aiBlocked': { en: 'AI is not enabled or not ready. Contact an administrator.', zh: 'AI 能力未启用或未就绪，请联系管理员' },
  'error.aiRateLimited': { en: 'Too many AI requests.', zh: '操作过于频繁' },
  'error.aiQuotaExhausted': { en: 'AI usage quota reached.', zh: 'AI 用量已达上限' },
  'error.aiUnsafeInput': { en: 'The content contains secret-shaped text; the request was not sent.', zh: '内容含敏感形态，已拒绝发送' },
  'error.aiProviderError': { en: 'The AI service is temporarily unavailable. Please retry.', zh: 'AI 服务暂时不可用，请重试' },
  // Shared recovery copy for BOTH the 409 write conflict AND the local-version
  // drift guard (A3 §2.2: same refresh recovery copy).
  'error.aiVersionConflict': { en: 'The record changed during the AI run. Refresh and retry.', zh: '记录已被他人更新，请刷新后重试' },
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

// --- AI shortcut error copy (A3 §2.3) ---

const AI_SHORTCUT_ERROR_KEY_BY_CODE: Record<string, MetaApiErrorLabelKey> = {
  AI_BLOCKED: 'error.aiBlocked',
  RATE_LIMITED: 'error.aiRateLimited',
  AI_QUOTA_EXHAUSTED: 'error.aiQuotaExhausted',
  AI_UNSAFE_INPUT: 'error.aiUnsafeInput',
  AI_PROVIDER_ERROR: 'error.aiProviderError',
  VERSION_CONFLICT: 'error.aiVersionConflict',
}

/**
 * UI copy for a known AI shortcut error code (§2.3 table), or null when the
 * code is not an AI state — callers fall back to the raw backend message.
 */
export function aiShortcutErrorMessage(code: string | undefined, isZh: boolean): string | null {
  const key = code ? AI_SHORTCUT_ERROR_KEY_BY_CODE[code] : undefined
  return key ? metaApiErrorLabel(key, isZh) : null
}

/** RATE_LIMITED countdown suffix (the seconds value is numeric data, interpolated raw). */
export function aiRetryCountdown(seconds: number, isZh: boolean): string {
  return isZh ? `${seconds} 秒后可重试` : `Retry in ${seconds}s`
}
