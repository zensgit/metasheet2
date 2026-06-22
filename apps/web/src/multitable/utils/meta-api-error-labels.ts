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
  // AI BULK fill state copy (B-3) — bulk-specific error codes keyed on
  // error.code, distinct from the per-record codes above.
  | 'error.aiBulkQuotaInsufficient'
  | 'error.aiBulkScopeTooLarge'
  | 'error.aiBulkViewFilterUnsupported'
  | 'error.aiBulkInlineConfigRejected'
  | 'error.aiBulkFieldForbidden'

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
  // AI bulk fill error copy (B-3). These are whole-run refusals — nothing was
  // generated and nothing was charged.
  'error.aiBulkQuotaInsufficient': {
    en: 'This bulk run would exceed the remaining AI quota — nothing was generated. Reduce the row count or try later.',
    zh: '本次批量填充会超出剩余 AI 配额，未生成任何内容。请减少行数或稍后重试。',
  },
  'error.aiBulkScopeTooLarge': {
    en: 'Too many rows to fill at once. Narrow the view filter or select fewer rows, then try again.',
    zh: '一次填充的行数过多。请收窄视图筛选或选择更少的行后重试。',
  },
  'error.aiBulkViewFilterUnsupported': {
    en: 'This view filters on a computed (lookup/rollup/formula) field, which bulk fill cannot resolve yet. Narrow the view to non-computed filters, or select rows explicitly.',
    zh: '该视图按计算字段（lookup/rollup/公式）筛选，批量填充暂不支持。请改用非计算字段筛选，或显式选择行。',
  },
  'error.aiBulkInlineConfigRejected': {
    en: 'Bulk fill runs only the saved AI config on this field. Save the field configuration first.',
    zh: '批量填充仅执行该字段已保存的 AI 配置，请先保存字段配置。',
  },
  'error.aiBulkFieldForbidden': {
    en: 'This field is not editable, so it cannot be bulk-filled.',
    zh: '该字段不可编辑，无法进行批量填充。',
  },
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

// --- AI bulk fill error copy (B-3) ---

// Bulk-specific error codes. Codes SHARED with the per-record path (RATE_LIMITED,
// AI_BLOCKED, AI_QUOTA_EXHAUSTED, AI_PROVIDER_ERROR, AI_UNSAFE_INPUT) delegate to
// aiShortcutErrorMessage so copy is not duplicated.
const AI_BULK_ERROR_KEY_BY_CODE: Record<string, MetaApiErrorLabelKey> = {
  AI_BULK_QUOTA_INSUFFICIENT: 'error.aiBulkQuotaInsufficient',
  BULK_SCOPE_TOO_LARGE: 'error.aiBulkScopeTooLarge',
  AI_BULK_VIEW_FILTER_UNSUPPORTED: 'error.aiBulkViewFilterUnsupported',
  AI_INLINE_CONFIG_REJECTED: 'error.aiBulkInlineConfigRejected',
  FIELD_FORBIDDEN: 'error.aiBulkFieldForbidden',
}

/**
 * UI copy for an AI bulk-fill error code, or null when the code is unknown
 * (callers fall back to the raw backend message). Tries the bulk-specific map
 * first, then the shared per-record AI codes (RATE_LIMITED / AI_BLOCKED / …).
 */
export function aiBulkErrorMessage(code: string | undefined, isZh: boolean): string | null {
  const key = code ? AI_BULK_ERROR_KEY_BY_CODE[code] : undefined
  if (key) return metaApiErrorLabel(key, isZh)
  return aiShortcutErrorMessage(code, isZh)
}
