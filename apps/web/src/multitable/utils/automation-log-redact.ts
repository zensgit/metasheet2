/**
 * UI-side redaction helper for automation execution log step.output /
 * step.error rendering.
 *
 * Mirrors the server-side Phase 3 redactor
 * (`scripts/ops/multitable-phase3-release-gate-redact.mjs`) plus
 * automation-specific fields: DingTalk `receiverUserIds`, real email
 * recipients, common automation action output keys.
 *
 * The redactor is DOM-safe and dependency-free so it can run in the
 * browser bundle without leaking secrets into rendered DOM nodes.
 */

const STRING_PATTERNS: Array<[RegExp, string]> = [
  // Bearer auth header
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>'],
  // JWT (eyJ-prefixed)
  [/\beyJ[A-Za-z0-9._-]{20,}/g, '<jwt:redacted>'],
  // DingTalk SEC robot secret
  [/\bSEC[A-Za-z0-9+/=_-]{8,}\b/g, 'SEC<redacted>'],
  // OpenAI / Anthropic / generic sk- key
  [/\bsk-[A-Za-z0-9_-]{20,}/g, 'sk-<redacted>'],
  // access_token / publicToken in URL queries
  [/(access_token=)[^&\s)"'<>]+/gi, '$1<redacted>'],
  [/(publicToken=)[^&\s)"'<>]+/gi, '$1<redacted>'],
  // DingTalk signed URL query (sign / timestamp)
  [/([?&](?:sign|timestamp)=)[^&\s)"'<>]+/gi, '$1<redacted>'],
  // Env-style API key / secret / token / password
  [
    /\b([A-Z][A-Z0-9_]*(?:API_KEY|CLIENT_SECRET|TOKEN|SECRET|PASSWORD))(\s*[:=]\s*)("?)([^&\s"'<>]+)\3/g,
    '$1$2$3<redacted>$3',
  ],
  // SMTP credentials in env form (also covers project-prefixed MULTITABLE_EMAIL_SMTP_*)
  [
    /\b((?:[A-Z][A-Z0-9_]*_)?SMTP_(?:USER|PASS|PASSWORD|HOST|PORT|FROM))(\s*[:=]\s*)("?)([^&\s"'<>]+)\3/g,
    '$1$2$3<redacted>$3',
  ],
  // Project-specific email smoke envelope env names
  [
    /\b(MULTITABLE_EMAIL_SMOKE_(?:TO|FROM|SUBJECT))(\s*[:=]\s*)("?)([^&\s"'<>]+)\3/g,
    '$1$2$3<redacted>$3',
  ],
  // Postgres / MySQL connection URI credentials
  [/\b(postgres(?:ql)?:\/\/)[^@\s"'<>]+@/gi, '$1<redacted>@'],
  [/\b(mysql:\/\/)[^@\s"'<>]+@/gi, '$1<redacted>@'],
  // Bare email addresses surfaced in free-text fields (error messages,
  // step output strings, audit lines). Runs AFTER env-style and
  // SMTP_*/SMOKE_* patterns so legitimate `KEY=value` assignments are
  // redacted at the assignment level first; this rule catches the
  // remaining bare addresses (e.g. `delivery failed to qa@example.com`).
  // Replaced with `<email:redacted>` so operators can still see that an
  // email-shaped value was redacted without seeing the address itself.
  [
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}\b/g,
    '<email:redacted>',
  ],
]

/**
 * Object keys whose values are treated as opaque secrets regardless
 * of their content. Covers SMTP credentials, recipient identifiers,
 * webhook URLs, DingTalk receiverUserIds, and the email recipients
 * field used by send_email automation action.
 */
const STRUCTURED_FIELDS_TO_REDACT = new Set([
  // Auth / API
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
  // Passwords
  'password',
  'smtpPassword',
  'smtp_password',
  'smtpUser',
  'smtp_user',
  'smtpHost',
  'smtp_host',
  // Webhooks / hooks
  'webhook',
  'webhookUrl',
  'webhook_url',
  // Recipients (email + DingTalk)
  'recipient',
  'recipients',
  'to',
  'emailTo',
  'email_to',
  'cc',
  'bcc',
  'receiverUserIds',
  'receiver_user_ids',
  'userIds',
  'user_ids',
  // Subject (may contain real customer names / order ids when send_email
  // populates from record fields)
  'subject',
  'emailSubject',
  'email_subject',
])

export const REDACTION_VERSION = 1

export function redactString(value: unknown): string {
  let result = String(value ?? '')
  for (const [pattern, replacement] of STRING_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return result
}

export function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      if (STRUCTURED_FIELDS_TO_REDACT.has(key)) {
        if (entryValue === null || entryValue === undefined) {
          out[key] = entryValue
        } else if (Array.isArray(entryValue)) {
          out[key] = entryValue.map(() => '<redacted>')
        } else if (typeof entryValue === 'object') {
          out[key] = '<redacted>'
        } else {
          out[key] = '<redacted>'
        }
      } else {
        out[key] = redactValue(entryValue)
      }
    }
    return out
  }
  return value
}

const OUTPUT_PREVIEW_MAX_LENGTH = 280

/**
 * Render-safe summary of an automation step's `output` field. Applies
 * structured-field redaction then JSON.stringify (so the result stays
 * one-line for table-like rendering) and truncates to a UI-friendly
 * cap with an explicit `...` suffix.
 */
export function summarizeStepOutput(output: unknown): string {
  if (output === null || output === undefined || output === '') return ''
  const redacted = redactValue(output)
  let text: string
  try {
    text = typeof redacted === 'string' ? redacted : JSON.stringify(redacted)
  } catch {
    text = String(redacted)
  }
  if (text.length > OUTPUT_PREVIEW_MAX_LENGTH) {
    return `${text.slice(0, OUTPUT_PREVIEW_MAX_LENGTH - 3)}...`
  }
  return text
}

/**
 * Render-safe redaction for an automation step's `error` string.
 * Applies the string-pattern redactor only; structured-field masking
 * is unnecessary for plain strings.
 */
export function summarizeStepError(error: unknown): string {
  if (error === null || error === undefined || error === '') return ''
  return redactString(error)
}
