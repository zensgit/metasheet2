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
])

const UNSAFE_PAYLOAD_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isSensitivePayloadKey(key) {
  return SENSITIVE_PAYLOAD_KEYS.has(normalizeKey(key))
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
    return value.length > maxStringLength
      ? `${value.slice(0, maxStringLength)}...[truncated]`
      : value
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
  jsonByteLength,
  isSensitivePayloadKey,
  sanitizeIntegrationPayload,
}
