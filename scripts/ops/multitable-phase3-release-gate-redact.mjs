/**
 * Shared redaction helper for Phase 3 release gate artifacts.
 *
 * Used by `multitable-phase3-release-gate.mjs` and
 * `multitable-phase3-release-gate-report.mjs`.
 *
 * Goal: no original secret value survives into stdout, stderr,
 * report.json, or report.md.
 */

export const REDACTION_VERSION = 1

const STRING_PATTERNS = [
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
    // Matches SMTP_*, MULTITABLE_EMAIL_SMTP_*, and any other uppercase
    // env namespace prefix terminating in SMTP_<HOST|USER|PASS|PASSWORD|PORT|FROM>.
    // The optional prefix is greedy on word chars; the SMTP_ segment is
    // required so unrelated env vars are not redacted.
    /\b((?:[A-Z][A-Z0-9_]*_)?SMTP_(?:USER|PASS|PASSWORD|HOST|PORT|FROM))(\s*[:=]\s*)("?)([^&\s"'<>]+)\3/g,
    '$1$2$3<redacted>$3',
  ],
  [
    // Matches MULTITABLE_EMAIL_SMOKE_TO / FROM / SUBJECT for the recipient
    // and subject envelope fields used by the email real-send smoke harness.
    /\b(MULTITABLE_EMAIL_SMOKE_(?:TO|FROM|SUBJECT))(\s*[:=]\s*)("?)([^&\s"'<>]+)\3/g,
    '$1$2$3<redacted>$3',
  ],
  [
    // Use URL parsing rather than a first-@ regex so raw `@` characters in
    // username/password do not leak.
    /\b(?:postgres(?:ql)?|mysql):\/\/[^\s<>]+/gi,
    redactDatabaseUrlCredentials,
  ],
]

function redactDatabaseUrlCredentials(value) {
  try {
    const url = new URL(value)
    if (!/^(postgres(?:ql)?|mysql):$/i.test(url.protocol)) return value
    if (!url.username && !url.password) return value
    return `${url.protocol}//<redacted>@${url.host}${url.pathname}${url.search}${url.hash}`
  } catch {
    return redactMalformedDatabaseUrlCredentials(value)
  }
}

function redactMalformedDatabaseUrlCredentials(value) {
  const match = /^(postgres(?:ql)?|mysql):\/\/(.+)$/i.exec(value)
  if (!match) return value
  const scheme = match[1]
  const rest = match[2]
  const at = findDatabaseAuthoritySeparator(rest)
  if (at <= 0 || at === rest.length - 1) return value
  return `${scheme}://<redacted>@${rest.slice(at + 1)}`
}

function findDatabaseAuthoritySeparator(rest) {
  const hostPattern = /^(?:\[[^\]\s]+\]|[A-Za-z0-9_][A-Za-z0-9_.-]*)(?::\d+)?(?=$|[/?#])/
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] !== '@') continue
    if (hostPattern.test(rest.slice(index + 1))) return index
  }
  return -1
}

const STRUCTURED_FIELDS = new Set([
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

export function redactString(value) {
  let result = String(value ?? '')
  for (const [pattern, replacement] of STRING_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return result
}

export function redactValue(value) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry))
  if (typeof value === 'object') {
    const out = {}
    for (const [key, val] of Object.entries(value)) {
      if (STRUCTURED_FIELDS.has(key)) {
        if (val === null || val === undefined) {
          out[key] = val
        } else if (Array.isArray(val)) {
          out[key] = val.map(() => '<redacted>')
        } else if (typeof val === 'object') {
          out[key] = '<redacted>'
        } else {
          out[key] = '<redacted>'
        }
      } else {
        out[key] = redactValue(val)
      }
    }
    return out
  }
  return value
}
