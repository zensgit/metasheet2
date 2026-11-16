/**
 * Redaction for text that may reach a log, an error message or a report: tokens, bearer credentials,
 * application secrets, URLs and Feishu identifier shapes are replaced. The replacement is deliberately
 * coarse (it may also replace harmless text of the same shape): a false replacement costs a word in a
 * log line, a missed one writes a credential.
 *
 * Pure module: no imports, no I/O. Hosts are matched by URL shape, not by name.
 */
export const FEISHU_REDACTED = '[redacted]'

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi
const BEARER_RE = /\bBearer\s+[^\s"',;]+/gi
const BASIC_RE = /\bBasic\s+[A-Za-z0-9+/=]{12,}/g
const SECRET_PAIR_RE =
  /("?\b(?:client_secret|app_secret|appSecret|access_token|tenant_access_token|user_access_token|refresh_token|code_verifier)\b"?\s*[:=]\s*)("[^"]*"|[^\s&,;}]+)/gi
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g
const TOKEN_PREFIX_RE = /\b[tu]-[A-Za-z0-9._-]{8,}/g
const IDENTIFIER_RE = /\b(?:ou|on|od)[_-][A-Za-z0-9_-]{4,}/g
const APP_ID_RE = /\bcli_[A-Za-z0-9_]{2,}/g
const OPAQUE_RE = /[A-Za-z0-9_-]{40,}/g

/** Replaces credentials, URLs and identifier-shaped words in `text`. */
export function redactFeishuText(text: string): string {
  return text
    .replace(URL_RE, `${FEISHU_REDACTED}`)
    .replace(BEARER_RE, `Bearer ${FEISHU_REDACTED}`)
    .replace(BASIC_RE, `Basic ${FEISHU_REDACTED}`)
    .replace(SECRET_PAIR_RE, `$1${FEISHU_REDACTED}`)
    .replace(JWT_RE, FEISHU_REDACTED)
    .replace(TOKEN_PREFIX_RE, FEISHU_REDACTED)
    .replace(IDENTIFIER_RE, FEISHU_REDACTED)
    .replace(APP_ID_RE, FEISHU_REDACTED)
    .replace(OPAQUE_RE, FEISHU_REDACTED)
}

const SECRET_KEY_RE = /(?:secret|token|authorization|password|verifier|credential)/i

/**
 * Log metadata with every string value redacted and every secret-named key dropped (replaced by the
 * placeholder); nested records and arrays are walked to a fixed depth, deeper values are replaced.
 */
export function redactFeishuMeta(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactFeishuText(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= 4) return FEISHU_REDACTED
  if (Array.isArray(value)) return value.map((item) => redactFeishuMeta(item, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_RE.test(key) ? FEISHU_REDACTED : redactFeishuMeta(inner, depth + 1)
  }
  return out
}

/** What a log line may say about a caught value: its class name and, for a typed failure, its numeric code. Never its text. */
export function feishuLogLabel(error: unknown): string {
  if (!(error instanceof Error)) return 'non-error'
  const code = (error as { code?: unknown }).code
  const status = (error as { statusCode?: unknown }).statusCode
  if (typeof code === 'number' && Number.isSafeInteger(code)) return `${error.name} code ${code}`
  if (typeof status === 'number' && Number.isSafeInteger(status)) return `${error.name} HTTP ${status}`
  return error.name
}
