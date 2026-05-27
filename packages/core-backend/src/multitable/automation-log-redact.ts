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
 * Scope: secret-shaped VALUE scrubbing only — business field values are
 * preserved for diagnosis. Business-data / PII masking is a separate concern
 * (deferred to the retry scope gate), NOT done here.
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

/** Key names whose values are always replaced wholesale, regardless of shape. */
const STRUCTURED_FIELDS: ReadonlySet<string> = new Set([
  'authToken',
  'auth_token',
  'accessToken',
  'access_token',
  'apiKey',
  'api_key',
  'clientSecret',
  'client_secret',
  'jwt',
  'bearer',
  'password',
  'smtpPassword',
  'smtp_password',
  'smtpUser',
  'smtp_user',
  'smtpHost',
  'smtp_host',
  'recipient',
  'recipients',
  'to',
  'emailTo',
  'email_to',
  'webhook',
  'webhookUrl',
  'webhook_url',
])

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
      if (STRUCTURED_FIELDS.has(key)) {
        out[key] = Array.isArray(val) ? val.map(() => '<redacted>') : val == null ? val : '<redacted>'
      } else {
        out[key] = redactValue(val)
      }
    }
    return out
  }
  return value
}
