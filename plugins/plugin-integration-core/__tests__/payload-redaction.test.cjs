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

  // value-scrub coverage extension: secret-shaped key=value beyond password/pwd,
  // and standalone JWTs — all must redact even under a benign key.
  const moreSecretValues = [
    ['token=ABC123DEF456GHI789', 'token=[redacted]'],
    ['api_key=sk_live_0123456789abcdef', 'api_key=[redacted]'],
    ['apikey=0123456789abcdef', 'apikey=[redacted]'],
    ['secret=topSecretValue123', 'secret=[redacted]'],
    ['access_token=xyz987abc654', 'access_token=[redacted]'],
    ['client_secret=cs_abc123def', 'client_secret=[redacted]'],
    ['refresh_token=rt_998877', 'refresh_token=[redacted]'],
    // standalone JWT with no Bearer/token= prefix
    ['auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpM', 'auth [redacted-jwt]'],
  ]
  for (const [input, expected] of moreSecretValues) {
    assert.equal(scrubSecretStringValue(input), expected, `secret value must be scrubbed: ${input}`)
  }

  // benign-key leak path through the live sanitizer (the F1 the value-scrub closes)
  const leakObj = sanitizeIntegrationPayload({
    detail: 'callback rejected: token=ABC123DEF456 expired',
    note: 'use api_key=sk_test_abcdef when calling',
    trace: 'id token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.aGVsbG8td29ybGQtc2ln',
  })
  assert.equal(leakObj.detail, 'callback rejected: token=[redacted] expired')
  assert.equal(leakObj.note, 'use api_key=[redacted] when calling')
  assert.equal(leakObj.trace.includes('[redacted-jwt]'), true)
  assert.equal(leakObj.trace.includes('eyJhbGci'), false, 'raw JWT head must not survive')

  // Bearer-prefixed JWT still redacted (regression on the existing Bearer rule)
  assert.equal(
    scrubSecretStringValue('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.aGVsbG8td29ybGQ'),
    'Authorization: Bearer [redacted]',
  )

  // extended false-positive matrix — these MUST survive (no `=`, or not JWT-shaped)
  const benignExtended = [
    'keep it secret, keep it safe',
    'tokens of appreciation were handed out',
    'the client secret handshake is documented here',
    'order qty=2 price=100 status=open',
    'base64 thumbnail starts eyJonly-one-segment-no-dots here',
  ]
  for (const s of benignExtended) {
    assert.equal(scrubSecretStringValue(s), s, `benign string must not be over-redacted: ${s}`)
  }

  // DSN userinfo where the PASSWORD ITSELF contains '@' — must mask to the LAST '@'
  // before the host, not stop at the first one (regression for the inherited bug).
  assert.equal(
    scrubSecretStringValue('jdbc:sqlserver://user:P@ssw0rd@host;databaseName=db'),
    'jdbc:sqlserver://user:[redacted]@host;databaseName=db',
  )
  assert.equal(
    scrubSecretStringValue('postgres://user:p@ss@host/db'),
    'postgres://user:[redacted]@host/db',
  )
  // no secret tail must survive
  assert.equal(scrubSecretStringValue('mongodb://u:p@ss@w0rd@cluster').includes('ss@w0rd'), false)
  // through the live sanitizer under a benign key (the F1 conn-string leak case)
  const dsnLeak = sanitizeIntegrationPayload({ detail: 'jdbc:sqlserver://user:P@ssw0rd@host;databaseName=db' })
  assert.equal(dsnLeak.detail, 'jdbc:sqlserver://user:[redacted]@host;databaseName=db')
  assert.equal(dsnLeak.detail.includes('ssw0rd'), false, 'password @-tail must not leak')
  // host:port with NO credentials (no userinfo '@') must survive
  assert.equal(scrubSecretStringValue('redis://localhost:6379/0'), 'redis://localhost:6379/0')

  // consolidation: shapes folded in from the former http-routes redactor must scrub here
  const consolidated = [
    ['id_token=eyJhdr.body.sig', 'id_token=[redacted]'],
    ['session_id=abc123sessionvalue', 'session_id=[redacted]'],
    ['signature=9f8e7d6c5b4a', 'signature=[redacted]'],
    ['sig=deadbeefcafe', 'sig=[redacted]'],
    ['sign=abc123def', 'sign=[redacted]'],
  ]
  for (const [input, expected] of consolidated) {
    assert.equal(scrubSecretStringValue(input), expected, `consolidated shape must scrub: ${input}`)
  }

  // Basic auth — HIGH-CONFIDENCE: base64 decodes to printable "user:pass" → redact;
  // benign "Basic authentication"/"Basic auth" must NOT be redacted.
  assert.equal(scrubSecretStringValue('Authorization: Basic dXNlcjpwYXNzd29yZA=='), 'Authorization: Basic [redacted]')
  assert.equal(scrubSecretStringValue('use Basic authentication for the proxy'), 'use Basic authentication for the proxy')
  assert.equal(scrubSecretStringValue('Basic auth required'), 'Basic auth required')

  // SEC-prefixed opaque secret id (12+, requires a digit) → redacted; plain prose kept
  assert.equal(scrubSecretStringValue('id SEC1a2b3c4d5e6f7g'), 'id [redacted-secret-id]')
  assert.equal(scrubSecretStringValue('see the SECTIONHEADING below'), 'see the SECTIONHEADING below')

  // Bearer now 8+ (folds the former http-routes 8+ coverage); benign phrase still safe
  assert.equal(scrubSecretStringValue('Bearer abcd1234efgh5678'), 'Bearer [redacted]')
  assert.equal(scrubSecretStringValue('Bearer of bad news arrived'), 'Bearer of bad news arrived')

  // left word-boundary on sig/sign — must NOT over-redact design=/assign=
  for (const s of ['the design=modern was chosen', 'please assign=alice to triage', 'redesign=v2 shipped']) {
    assert.equal(scrubSecretStringValue(s), s, `word-boundary must protect: ${s}`)
  }

  console.log('✓ payload-redaction: sensitive key + value-scrub + false-positive matrix tests passed')
}

try {
  main()
} catch (err) {
  console.error('✗ payload-redaction FAILED')
  console.error(err)
  process.exit(1)
}
