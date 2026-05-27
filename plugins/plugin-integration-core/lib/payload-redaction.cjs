'use strict'

const SENSITIVE_PAYLOAD_KEYS = new Set([
  'apikey',
  'accesstoken',
  'refreshtoken',
  'token',
  'password',
  'secret',
  'clientsecret',
  'privatekey',
  'connectsid',
  'jsessionid',
  'sid',
  'sessionid',
  'authorization',
  'cookie',
  'setcookie',
  'proxyauthorization',
  'xapikey',
  'xauthtoken',
  'xsessionid',
  'credentials',
  'rawpayload',
  'connectionstring',
  'databaseurl',
  'dburl',
  'jdbcurl',
  'odbcconnectionstring',
  'sqlconnectionstring',
])

const UNSAFE_PAYLOAD_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isSensitivePayloadKey(key) {
  return SENSITIVE_PAYLOAD_KEYS.has(normalizeKey(key))
}

// Basic-auth credential heuristic: a real `Basic <base64>` decodes to a printable
// "user:pass" (contains ':'). Used so benign phrases like "Basic authentication"
// (whose word does NOT base64-decode to printable user:pass) are NOT redacted.
function looksLikeBasicCredential(token) {
  if (typeof token !== 'string' || token.length < 8) return false
  let decoded
  try {
    decoded = Buffer.from(token, 'base64').toString('utf8')
  } catch {
    return false
  }
  // A real `Basic <base64>` decodes to a "user:pass" string: contains ':' and is
  // valid printable text. Non-ASCII (e.g. CJK) user/pass is allowed; only control
  // chars (C0/DEL/C1) and U+FFFD (invalid-UTF-8 garbage, i.e. a benign word that
  // happened to base64-decode) are rejected -- so "Basic authentication" is kept
  // while a base64 of a CJK user:pass is redacted.
  if (!decoded.includes(':')) return false
  for (let i = 0; i < decoded.length; i++) {
    const c = decoded.charCodeAt(i)
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0xfffd) return false
  }
  return true
}

// Value-based secret scrubbing. Key-based redaction only fires when the KEY is
// sensitive; a secret riding inside a benign string value (error messages,
// `details`, free text) would otherwise leak. These patterns mask the secret
// SUBSTRING only — preserving surrounding diagnostic context (scheme/host/db),
// the operator-in-the-loop debugging signal — rather than nuking the whole value.
// Patterns are deliberately anchored/conservative to avoid over-redacting benign
// prose (e.g. the word "password" with no `=`, or "Bearer of bad news").
const SECRET_VALUE_PATTERNS = Object.freeze([
  // URL/DSN userinfo: scheme://user:password@host  → mask the password only.
  // Covers postgres/mysql/redis/amqp/http(s)/jdbc:... DSNs carrying credentials.
  // Password is matched greedily up to the LAST `@` before the host (bounded to the
  // authority via [^\s/?#]+), so passwords that themselves contain `@`
  // (e.g. user:P@ssw0rd@host) are fully masked, not just up to the first `@`.
  { re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s/?#]+@([^\s/@:;?#]+)/gi, replace: '$1:[redacted]@$2' },
  // key=value credential params (ODBC / SQL Server / JDBC query, URL query, free text).
  // Union of the shared set and the former http-routes set (consolidated here so there
  // is ONE secret-shape source). LEFT word-boundary anchored so benign prose never
  // matches — e.g. "design=x" / "assign=y" do NOT match sign=/sig=.
  { re: /\b(password|pwd|passwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?id|signature|sig|sign|api[_-]?key|apikey)=([^;&\s"']+)/gi, replace: '$1=[redacted]' },
  // Bearer token — token-shaped value (8+, incl '=' padding); "Bearer of bad news" is safe.
  { re: /\b(Bearer)\s+([A-Za-z0-9._~+/=-]{8,})/g, replace: '$1 [redacted]' },
  // Basic auth — HIGH-CONFIDENCE ONLY: the base64 token must decode to a printable
  // "user:pass" (contains ':'), so "Basic authentication" / "Basic auth" are kept.
  { re: /\b(Basic)\s+([A-Za-z0-9+/]+={0,2})/g, replace: (m, _kw, tok) => (looksLikeBasicCredential(tok) ? 'Basic [redacted]' : m) },
  // Standalone JWT (eyJ… three base64url segments) even without a Bearer/token= prefix.
  // The `eyJ` header + dotted-triple shape is JWT-specific; benign text won't match.
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: '[redacted-jwt]' },
  // Opaque secret id: SEC-prefixed, 12+ chars, REQUIRING at least one digit so plain
  // uppercase prose ("SECTIONHEADING") is not scrubbed.
  { re: /\bSEC(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{12,}\b/g, replace: '[redacted-secret-id]' },
])

function scrubSecretStringValue(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  let out = value
  for (const { re, replace } of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, replace)
  }
  return out
}

function jsonByteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return Infinity
  }
}

function truncateSanitizedPayload(value, originalBytes, options) {
  const preview = sanitizePayloadValue(value, {
    ...options,
    maxDepth: Math.min(Number.isInteger(options.maxDepth) ? options.maxDepth : 6, 2),
    maxArrayItems: Math.min(Number.isInteger(options.maxArrayItems) ? options.maxArrayItems : 50, 10),
    maxStringLength: Math.min(Number.isInteger(options.maxStringLength) ? options.maxStringLength : 2000, 200),
  }, { depth: 0, seen: new WeakSet() })
  const compact = {
    payloadTruncated: true,
    originalBytes,
    preview,
  }
  if (jsonByteLength(compact) <= options.maxBytes) return compact
  return {
    payloadTruncated: true,
    originalBytes,
    preview: '[omitted]',
  }
}

function sanitizePayloadValue(value, options, state) {
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 6
  const maxArrayItems = Number.isInteger(options.maxArrayItems) ? options.maxArrayItems : 50
  const maxStringLength = Number.isInteger(options.maxStringLength) ? options.maxStringLength : 2000
  const seen = state.seen || new WeakSet()
  const depth = state.depth || 0

  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    // scrub secret-shaped substrings BEFORE truncation, otherwise a truncated
    // prefix could still expose the secret head.
    const scrubbed = scrubSecretStringValue(value)
    return scrubbed.length > maxStringLength
      ? `${scrubbed.slice(0, maxStringLength)}...[truncated]`
      : scrubbed
  }
  if (typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  if (depth >= maxDepth) return '[max-depth]'
  seen.add(value)

  if (Array.isArray(value)) {
    const sliced = value.slice(0, maxArrayItems).map((item) => sanitizePayloadValue(item, options, {
      depth: depth + 1,
      seen,
    }))
    if (value.length > maxArrayItems) sliced.push(`[${value.length - maxArrayItems} more items truncated]`)
    return sliced
  }

  const result = Object.create(null)
  for (const [key, child] of Object.entries(value)) {
    if (UNSAFE_PAYLOAD_KEYS.has(key)) continue
    if (isSensitivePayloadKey(key)) {
      result[key] = '[redacted]'
      continue
    }
    result[key] = sanitizePayloadValue(child, options, {
      depth: depth + 1,
      seen,
    })
  }
  return result
}

function sanitizeIntegrationPayload(value, options = {}) {
  const sanitized = sanitizePayloadValue(value, options, { depth: 0, seen: new WeakSet() })
  if (!Number.isInteger(options.maxBytes) || options.maxBytes <= 0) return sanitized
  const bytes = jsonByteLength(sanitized)
  if (bytes <= options.maxBytes) return sanitized
  return truncateSanitizedPayload(sanitized, bytes, options)
}

module.exports = {
  SENSITIVE_PAYLOAD_KEYS,
  UNSAFE_PAYLOAD_KEYS,
  SECRET_VALUE_PATTERNS,
  jsonByteLength,
  isSensitivePayloadKey,
  scrubSecretStringValue,
  sanitizeIntegrationPayload,
}
