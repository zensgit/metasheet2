/**
 * Shared backend redactor for automation execution logs.
 *
 * Single source of truth for redacting secret-shaped values out of automation
 * execution snapshots before they are persisted (trigger_event / rule_snapshot /
 * steps / execution-level error). Reused by:
 *   - `automation-log-service.record()` (4-channel write-time redaction)
 *   - `automation-executor` DingTalk failure-alert text
 *
 * Ported from the Phase-3 release-gate redactor
 * (`scripts/ops/multitable-phase3-release-gate-redact.mjs`, mirrored in the
 * frontend by `apps/web/src/multitable/utils/automation-log-redact.ts`) so the
 * backend stops carrying a separate copy. Adds the DingTalk robot-webhook URL
 * pattern (which a DingTalk action's rule_snapshot / alert text can contain).
 *
 * Scope: secret/auth-shaped scrubbing — secret-shaped string VALUES, plus the
 * values of auth/credential structured keys matched case- and separator-
 * insensitively (so arbitrary `send_webhook` headers like `Authorization` /
 * `X-API-Key` / `Cookie` are masked wholesale). Business field values are
 * preserved for diagnosis; contact/PII keys (`to` / `recipient` / …) are NOT
 * masked here — persist-time PII masking is deferred to the retry scope gate.
 */

export const REDACTION_VERSION = 1

const STRING_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // DingTalk robot webhook (token-bearing) — must run before the generic
  // `access_token=` rule so the whole URL is masked, not just its token.
  [/https:\/\/oapi\.dingtalk\.com\/robot\/send\?access_token=[A-Za-z0-9._~-]+/gi, '<dingtalk-robot-webhook-redacted>'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>'],
  [/\beyJ[A-Za-z0-9._-]{20,}/g, '<jwt:redacted>'],
  [/\bSEC[A-Za-z0-9+/=_-]{8,}\b/g, 'SEC<redacted>'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, 'sk-<redacted>'],
  [/(access_token=)[^&\s)"'<>]+/gi, '$1<redacted>'],
  [/(publicToken=)[^&\s)"'<>]+/gi, '$1<redacted>'],
  [/([?&](?:sign|timestamp)=)[^&\s)"'<>]+/gi, '$1<redacted>'],
  [
    /\b([A-Z][A-Z0-9_]*(?:API_KEY|CLIENT_SECRET|TOKEN|SECRET|PASSWORD))(\s*[:=]\s*)("?)([^&\s"'<>]+)\3/g,
    '$1$2$3<redacted>$3',
  ],
  [
    // SMTP_*, MULTITABLE_EMAIL_SMTP_*, and any uppercase env namespace prefix
    // terminating in SMTP_<HOST|USER|PASS|PASSWORD|PORT|FROM>.
    /\b((?:[A-Z][A-Z0-9_]*_)?SMTP_(?:USER|PASS|PASSWORD|HOST|PORT|FROM))(\s*[:=]\s*)("?)([^&\s"'<>]+)\3/g,
    '$1$2$3<redacted>$3',
  ],
  [
    /\b(MULTITABLE_EMAIL_SMOKE_(?:TO|FROM|SUBJECT))(\s*[:=]\s*)("?)([^&\s"'<>]+)\3/g,
    '$1$2$3<redacted>$3',
  ],
  [/\b(postgres(?:ql)?:\/\/)[^@\s"'<>]+@/gi, '$1<redacted>@'],
  [/\b(mysql:\/\/)[^@\s"'<>]+@/gi, '$1<redacted>@'],
]

/**
 * Key names (NORMALIZED: lowercased, `-`/`_` stripped) whose values are masked
 * wholesale regardless of value shape. Covers auth headers and credential config
 * — `send_webhook.config.headers` is arbitrary, so matching is case- AND
 * separator-insensitive: `Authorization`, `X-API-Key`, `auth_token`, `Set-Cookie`
 * all hit. Contact/PII keys (`to` / `recipient` / …) are deliberately NOT here —
 * persist-time PII masking is deferred to the retry scope gate, not decided in A1.
 */
const STRUCTURED_FIELDS: ReadonlySet<string> = new Set([
  'authtoken',
  'authorization',
  'proxyauthorization',
  'accesstoken',
  'apikey',
  'xapikey',
  'xauthtoken',
  'xamzsecuritytoken',
  'clientsecret',
  'secret',
  'token',
  'jwt',
  'bearer',
  'password',
  'cookie',
  'setcookie',
  'smtppassword',
  'smtpuser',
  'smtphost',
  'webhook',
  'webhookurl',
])

/** Normalize a key for structured-field matching: lowercase + strip `-` and `_`. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '')
}

/** Redact secret-shaped substrings out of a single string. */
export function redactString(value: unknown): string {
  let result = String(value ?? '')
  for (const [pattern, replacement] of STRING_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return result
}

/** Recursively redact a value: strings scrubbed, structured-field keys masked. */
export function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (STRUCTURED_FIELDS.has(normalizeKey(key))) {
        out[key] = Array.isArray(val) ? val.map(() => '<redacted>') : val == null ? val : '<redacted>'
      } else {
        out[key] = redactValue(val)
      }
    }
    return out
  }
  return value
}
