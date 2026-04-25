'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const {
  jsonByteLength,
  isSensitivePayloadKey,
  sanitizeIntegrationPayload,
} = require(path.join(__dirname, '..', 'lib', 'payload-redaction.cjs'))

function main() {
  assert.equal(isSensitivePayloadKey('Authorization'), true)
  assert.equal(isSensitivePayloadKey('x-api-key'), true)
  assert.equal(isSensitivePayloadKey('apiKeyHeader'), false)
  assert.equal(isSensitivePayloadKey('tokenPath'), false)

  const circular = { code: 'MAT-001' }
  circular.self = circular
  const payload = {
    code: 'MAT-001',
    password: 'secret',
    headers: {
      Authorization: 'Bearer token',
    },
    rawPayload: {
      token: 'raw-token',
    },
    rows: [
      { cookie: 'sid=1' },
    ],
    circular,
  }

  const redacted = sanitizeIntegrationPayload(payload)
  assert.equal(redacted.code, 'MAT-001')
  assert.equal(redacted.password, '[redacted]')
  assert.equal(redacted.headers.Authorization, '[redacted]')
  assert.equal(redacted.rawPayload, '[redacted]')
  assert.equal(redacted.rows[0].cookie, '[redacted]')
  assert.equal(redacted.circular.self, '[circular]')

  const longValue = sanitizeIntegrationPayload({ message: 'x'.repeat(2100) })
  assert.equal(longValue.message.endsWith('...[truncated]'), true)

  const capped = sanitizeIntegrationPayload({
    code: 'MAT-001',
    details: 'x'.repeat(5000),
    token: 'secret-token',
  }, { maxBytes: 512 })
  assert.equal(capped.payloadTruncated, true)
  assert.equal(capped.originalBytes > 512, true)
  assert.ok(jsonByteLength(capped) <= 512, 'capped payload fits maxBytes')
  assert.equal(capped.preview.token, '[redacted]')

  const malicious = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":{"polluted":true},"safe":"ok"}')
  const sanitized = sanitizeIntegrationPayload({ nested: malicious })
  assert.equal(Object.getPrototypeOf(sanitized), null, 'sanitized objects use null prototype')
  assert.equal(Object.getPrototypeOf(sanitized.nested), null, 'nested sanitized objects use null prototype')
  assert.equal(Object.hasOwn(sanitized.nested, '__proto__'), false, 'unsafe __proto__ key is skipped')
  assert.equal(Object.hasOwn(sanitized.nested, 'constructor'), false, 'unsafe constructor key is skipped')
  assert.equal(Object.hasOwn(sanitized.nested, 'prototype'), false, 'unsafe prototype key is skipped')
  assert.equal(sanitized.nested.safe, 'ok')
  assert.equal({}.polluted, undefined, 'Object.prototype is not polluted')

  console.log('✓ payload-redaction: sensitive key redaction tests passed')
}

try {
  main()
} catch (err) {
  console.error('✗ payload-redaction FAILED')
  console.error(err)
  process.exit(1)
}
