'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const {
  jsonByteLength,
  isSensitivePayloadKey,
  scrubSecretStringValue,
  sanitizeIntegrationPayload,
} = require(path.join(__dirname, '..', 'lib', 'payload-redaction.cjs'))

function main() {
  assert.equal(isSensitivePayloadKey('Authorization'), true)
  assert.equal(isSensitivePayloadKey('x-api-key'), true)
  assert.equal(isSensitivePayloadKey('JSESSIONID'), true)
  assert.equal(isSensitivePayloadKey('connect.sid'), true)
  assert.equal(isSensitivePayloadKey('X-Session-Id'), true)
  assert.equal(isSensitivePayloadKey('sid'), true)
  assert.equal(isSensitivePayloadKey('connectionString'), true)
  assert.equal(isSensitivePayloadKey('database-url'), true)
  assert.equal(isSensitivePayloadKey('jdbcUrl'), true)
  assert.equal(isSensitivePayloadKey('dbUrl'), true)
  assert.equal(isSensitivePayloadKey('odbcConnectionString'), true)
  assert.equal(isSensitivePayloadKey('sqlConnectionString'), true)
  assert.equal(isSensitivePayloadKey('apiKeyHeader'), false)
  assert.equal(isSensitivePayloadKey('tokenPath'), false)

  const circular = { code: 'MAT-001' }
  circular.self = circular
  const payload = {
    code: 'MAT-001',
    password: 'secret',
    headers: {
      Authorization: 'Bearer token',
      'X-Session-Id': 'session-token',
    },
    cookies: {
      JSESSIONID: 'k3-session',
      'connect.sid': 'connect-session',
      sid: 'short-session',
    },
    rawPayload: {
      token: 'raw-token',
    },
    connectionString: 'postgres://user:pass@example.invalid/db',
    databaseUrl: 'postgres://user:pass@example.invalid/db',
    rows: [
      { cookie: 'sid=1' },
    ],
    circular,
  }

  const redacted = sanitizeIntegrationPayload(payload)
  assert.equal(redacted.code, 'MAT-001')
  assert.equal(redacted.password, '[redacted]')
  assert.equal(redacted.headers.Authorization, '[redacted]')
  assert.equal(redacted.headers['X-Session-Id'], '[redacted]')
  assert.equal(redacted.cookies.JSESSIONID, '[redacted]')
  assert.equal(redacted.cookies['connect.sid'], '[redacted]')
  assert.equal(redacted.cookies.sid, '[redacted]')
  assert.equal(redacted.rawPayload, '[redacted]')
  assert.equal(redacted.connectionString, '[redacted]')
  assert.equal(redacted.databaseUrl, '[redacted]')
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

  // --- value-based scrubbing: secret-shaped SUBSTRINGS under benign keys ---
  // positives (substring masking preserves scheme/host/db context)
  assert.equal(scrubSecretStringValue('postgres://user:s3cr3t@host/db'), 'postgres://user:[redacted]@host/db')
  assert.equal(scrubSecretStringValue('https://alice:tok123@example.com/p'), 'https://alice:[redacted]@example.com/p')
  assert.equal(scrubSecretStringValue('jdbc:mysql://svc:p@db.host:3306/app'), 'jdbc:mysql://svc:[redacted]@db.host:3306/app')
  assert.equal(scrubSecretStringValue('Driver={SQL Server};Server=h;Uid=sa;Pwd=p@ssw0rd;'), 'Driver={SQL Server};Server=h;Uid=sa;Pwd=[redacted];')
  assert.equal(scrubSecretStringValue('host/db?user=a&password=hunter2&x=1'), 'host/db?user=a&password=[redacted]&x=1')
  assert.equal(scrubSecretStringValue('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), 'Authorization: Bearer [redacted]')

  // F1 closure: a connection string embedded in a benign-key value is masked,
  // context preserved (via the live sanitizer, proving the wiring).
  const embedded = sanitizeIntegrationPayload({
    errorMessage: 'connect failed: postgres://svc:secret@db:5432/app timeout',
    details: 'Driver={SQL Server};Uid=sa;Pwd=topsecret;',
  })
  assert.equal(embedded.errorMessage, 'connect failed: postgres://svc:[redacted]@db:5432/app timeout')
  assert.equal(embedded.details, 'Driver={SQL Server};Uid=sa;Pwd=[redacted];')

  // false-positive matrix — benign strings MUST survive unredacted
  // (guards the operator-in-the-loop diagnostic signal from over-redaction)
  const benign = [
    'user forgot their password, please reset',
    'the password field is required',
    'see https://docs.example.com/guide?topic=auth',
    'connection refused to db.host:5432',
    'Bearer of bad news arrived today',
  ]
  for (const s of benign) {
    assert.equal(scrubSecretStringValue(s), s, `benign string must not be over-redacted: ${s}`)
  }
  const benignObj = sanitizeIntegrationPayload({ note: 'user forgot password', url: 'https://host/p?x=1' })
  assert.equal(benignObj.note, 'user forgot password')
  assert.equal(benignObj.url, 'https://host/p?x=1')

  // scrub runs BEFORE truncation: secret head is masked even when the value is truncated
  const longSecret = sanitizeIntegrationPayload({ blob: `postgres://u:p@h/db ${'x'.repeat(2100)}` })
  assert.equal(longSecret.blob.includes('[redacted]'), true, 'secret masked before truncation')
  assert.equal(longSecret.blob.includes('u:p@'), false, 'raw password not exposed in truncated head')
  assert.equal(longSecret.blob.endsWith('...[truncated]'), true)

  console.log('✓ payload-redaction: sensitive key + value-scrub + false-positive matrix tests passed')
}

try {
  main()
} catch (err) {
  console.error('✗ payload-redaction FAILED')
  console.error(err)
  process.exit(1)
}
