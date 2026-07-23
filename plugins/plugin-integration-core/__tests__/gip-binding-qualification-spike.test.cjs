'use strict'

// GIP-D0 A3 — read-only qualification spike battery. Plain node test. Hermetic
// (fake query fn), values-free, zero writes by construction.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  QUALIFICATION_ERROR_REASONS,
  GipQualificationError,
  computeQualificationDigest,
  computeEnvelopeDigest,
  buildOrderingKeyDuplicateProbeSql,
  buildOrderingKeyNullProbeSql,
  probeBindingQualification,
  verifyBindingQualification,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'gip-binding-qualification-spike.cjs'))

function rejectsWith(fn, reason) {
  let caught = null
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof GipQualificationError, `expected qualification error (${reason})`)
  assert.equal(caught.reason, reason)
  return caught
}

async function rejectsWithAsync(fn, reason) {
  let caught = null
  try {
    await fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof GipQualificationError, `expected qualification error (${reason})`)
  assert.equal(caught.reason, reason)
  return caught
}

const BASE_INPUTS = Object.freeze({
  actionProfileVersion: 'fixture.paged_read.v1',
  systemContentKey: 'sck_fixture_1',
  configContentKey: 'cck_fixture_1',
  objectKey: 'fixture_view',
  canonicalObjectVersion: 'material.v1',
})

// ── 1. Frozen vocabularies + source-level invariant ──
function frozenVocabulary() {
  assert.deepEqual([...QUALIFICATION_ERROR_REASONS], [
    'QUALIFICATION_INPUT_INVALID',
    'PROBE_SQL_NOT_READ_ONLY',
    'PROBE_QUERY_FAILED',
    'ORDERING_KEY_DUPLICATE_FOUND',
    'ORDERING_KEY_NULL_FOUND',
    'QUALIFICATION_NOT_OBJECT',
    'QUALIFICATION_DIGEST_MISMATCH',
    'QUALIFICATION_ENVELOPE_MISMATCH',
    'QUALIFICATION_EXPIRED',
    'QUALIFICATION_STATUS_INVALID',
  ])
  assert.ok(Object.isFrozen(QUALIFICATION_ERROR_REASONS))
  const src = fs
    .readFileSync(path.join(__dirname, '..', 'lib', 'gip-binding-qualification-spike.cjs'), 'utf8')
    .replace(/\/\/.*$/gm, '')
  const declared = new Set(QUALIFICATION_ERROR_REASONS)
  const re = /\bfail\(\s*['"]([A-Z_]+)['"]/g
  const undeclared = []
  let count = 0
  let match
  while ((match = re.exec(src))) {
    count += 1
    if (!declared.has(match[1])) undeclared.push(match[1])
  }
  assert.ok(count >= 10, `expected to locate fail() call sites (found ${count})`)
  assert.deepEqual(undeclared, [], 'every fail() reason must be declared')
}

// ── 2. Digest: deterministic, input-bound, order-insensitive serialization ──
function digestProperties() {
  const evidence = { probeKind: 'ordering_key_uniqueness_negative', checkedKeyColumnCount: 2, duplicateGroupsFound: 0, probedAt: 't1' }
  const a = computeQualificationDigest({ ...BASE_INPUTS, evidence })
  const b = computeQualificationDigest({ ...BASE_INPUTS, evidence: { duplicateGroupsFound: 0, probedAt: 't1', checkedKeyColumnCount: 2, probeKind: 'ordering_key_uniqueness_negative' } })
  assert.equal(a, b, 'key order must not change the digest (stableStringify)')
  // EVERY input perturbs the digest (input binding — no cross-object/config reuse).
  for (const field of ['actionProfileVersion', 'systemContentKey', 'configContentKey', 'objectKey', 'canonicalObjectVersion']) {
    const mutated = computeQualificationDigest({ ...BASE_INPUTS, [field]: `${BASE_INPUTS[field]}_x`, evidence })
    assert.notEqual(mutated, a, `digest must bind ${field}`)
  }
  rejectsWith(() => computeQualificationDigest({ ...BASE_INPUTS, objectKey: '' }), 'QUALIFICATION_INPUT_INVALID')
}

// ── 3. Probe SQL: SELECT-only by construction + guard is load-bearing ──
function probeSqlReadOnly() {
  const sql = buildOrderingKeyDuplicateProbeSql({ objectName: 'fixture_view', keyColumns: ['item_no', 'rev'] })
  assert.match(sql, /^SELECT /)
  assert.match(sql, /GROUP BY "item_no", "rev" HAVING COUNT\(\*\) > 1 LIMIT 1$/)
  assert.equal(__internals.assertReadOnlySql(sql), sql)
  rejectsWith(() => __internals.assertReadOnlySql('DELETE FROM x'), 'PROBE_SQL_NOT_READ_ONLY')
  rejectsWith(() => __internals.assertReadOnlySql('SELECT 1; DROP TABLE x'), 'PROBE_SQL_NOT_READ_ONLY')
  rejectsWith(() => __internals.assertReadOnlySql('SELECT 1 INTO y FROM x'), 'PROBE_SQL_NOT_READ_ONLY')
  rejectsWith(() => __internals.assertReadOnlySql("SELECT setval('s', 9)"), 'PROBE_SQL_NOT_READ_ONLY')
  rejectsWith(() => __internals.assertReadOnlySql('SELECT pg_advisory_lock(1)'), 'PROBE_SQL_NOT_READ_ONLY')
  rejectsWith(() => __internals.assertReadOnlySql('SELECT * FROM x FOR UPDATE'), 'PROBE_SQL_NOT_READ_ONLY')
  // identifier hygiene: embedded quotes doubled, never raw
  assert.equal(__internals.quoteIdentifier('we"ird'), '"we""ird"')
  // NULL probe shape (total order needs null-free key components)
  const nullSql = buildOrderingKeyNullProbeSql({ objectName: 'fixture_view', keyColumns: ['item_no', 'rev'] })
  assert.match(nullSql, /^SELECT 1 AS null_key_row FROM "fixture_view" WHERE "item_no" IS NULL OR "rev" IS NULL LIMIT 1$/)
  assert.equal(__internals.assertReadOnlySql(nullSql), nullSql)
  // duplicate keyColumns declaration is rejected, never silently deduped (review P2)
  rejectsWith(() => buildOrderingKeyDuplicateProbeSql({ objectName: 'v', keyColumns: ['k', 'k'] }), 'QUALIFICATION_INPUT_INVALID')
}

// ── 4. Probe: uniqueness pass / duplicate fail-closed (values-free) ──
async function probeBehaviour() {
  const seenSql = []
  const okQuery = async (sql) => { seenSql.push(sql); return { rows: [] } }
  const qualification = await probeBindingQualification({
    ...BASE_INPUTS,
    query: okQuery,
    keyColumns: ['item_no', 'rev'],
    probedAt: '2026-07-23T00:00:00Z',
    expiresAt: '2026-07-24T00:00:00Z',
  })
  assert.equal(qualification.status, 'candidate')
  assert.equal(qualification.evidence.probeKind, 'ordering_key_total_order_negative')
  assert.equal(qualification.evidence.duplicateGroupsFound, 0)
  assert.equal(qualification.evidence.nullKeyRowsFound, 0)
  assert.equal(qualification.evidence.checkedKeyColumnCount, 2)
  assert.ok(typeof qualification.envelopeDigest === 'string' && qualification.envelopeDigest.length === 64)
  // TWO read-only probes: duplicate-group + null-key (total order, review P2)
  assert.equal(seenSql.length, 2)
  assert.match(seenSql[0], /HAVING COUNT\(\*\) > 1/)
  assert.match(seenSql[1], /IS NULL/)

  // duplicates ⇒ fail closed, and the thrown error must NOT echo key values
  const SECRET = 'secret_item_A17'
  const dupQuery = async () => ({ rows: [{ item_no: SECRET, rev: 'B', duplicate_count: 3 }] })
  const caught = await rejectsWithAsync(() => probeBindingQualification({
    ...BASE_INPUTS, query: dupQuery, keyColumns: ['item_no', 'rev'], probedAt: '2026-07-23T00:00:00Z',
  }), 'ORDERING_KEY_DUPLICATE_FOUND')
  assert.ok(!JSON.stringify({ m: caught.message, d: caught.details }).includes(SECRET),
    'duplicate-key failure must stay values-free')

  // NULL key components ⇒ fail closed (second probe)
  let call = 0
  const nullQuery = async () => { call += 1; return call === 1 ? { rows: [] } : { rows: [{ null_key_row: 1 }] } }
  await rejectsWithAsync(() => probeBindingQualification({
    ...BASE_INPUTS, query: nullQuery, keyColumns: ['item_no'], probedAt: '2026-07-23T00:00:00Z',
  }), 'ORDERING_KEY_NULL_FOUND')

  await rejectsWithAsync(() => probeBindingQualification({
    ...BASE_INPUTS, query: async () => { throw new Error('boom') }, keyColumns: ['k'], probedAt: '2026-07-23T00:00:00Z',
  }), 'PROBE_QUERY_FAILED')
  await rejectsWithAsync(() => probeBindingQualification({
    ...BASE_INPUTS, query: async () => ({}), keyColumns: ['k'], probedAt: '2026-07-23T00:00:00Z',
  }), 'PROBE_QUERY_FAILED')
}

// ── 5. Verify: pure-local, digest-bound, expiring, status-gated ──
async function verifyBehaviour() {
  const query = async () => ({ rows: [] })
  const qualification = await probeBindingQualification({
    ...BASE_INPUTS, query, keyColumns: ['item_no'], probedAt: '2026-07-23T00:00:00Z', expiresAt: '2026-07-24T00:00:00Z',
  })

  const ok = verifyBindingQualification({
    qualification, expectedInputs: { ...BASE_INPUTS }, now: '2026-07-23T12:00:00Z',
  })
  assert.equal(ok.verified, true)

  // cross-object reuse ⇒ digest mismatch (input binding is load-bearing)
  rejectsWith(() => verifyBindingQualification({
    qualification, expectedInputs: { ...BASE_INPUTS, objectKey: 'another_view' }, now: '2026-07-23T12:00:00Z',
  }), 'QUALIFICATION_DIGEST_MISMATCH')

  // expiry ⇒ fail closed: Run-start proper never probes — fresh Preflight required
  rejectsWith(() => verifyBindingQualification({
    qualification, expectedInputs: { ...BASE_INPUTS }, now: '2026-07-25T00:00:00Z',
  }), 'QUALIFICATION_EXPIRED')

  // tampered evidence ⇒ digest mismatch
  const tampered = { ...qualification, evidence: { ...qualification.evidence, duplicateGroupsFound: 1 } }
  rejectsWith(() => verifyBindingQualification({
    qualification: tampered, expectedInputs: { ...BASE_INPUTS }, now: '2026-07-23T12:00:00Z',
  }), 'QUALIFICATION_DIGEST_MISMATCH')

  // status gate: only 'candidate' verifiable
  rejectsWith(() => verifyBindingQualification({
    qualification: { ...qualification, status: 'revoked' }, expectedInputs: { ...BASE_INPUTS }, now: '2026-07-23T12:00:00Z',
  }), 'QUALIFICATION_STATUS_INVALID')

  // TIMESTAMP PIN (review P3: lexicographic fail-open inversion) — a non-ISO `now`
  // must fail CLOSED, never silently verify an expired qualification.
  rejectsWith(() => verifyBindingQualification({
    qualification, expectedInputs: { ...BASE_INPUTS }, now: '07/25/2026',
  }), 'QUALIFICATION_INPUT_INVALID')
  // a COPY with malformed expiresAt is a lifecycle tamper — the envelope catches it
  // BEFORE format validation (authenticate-then-parse, review P2 ordering)
  rejectsWith(() => verifyBindingQualification({
    qualification: { ...qualification, expiresAt: 'tomorrow' }, expectedInputs: { ...BASE_INPUTS }, now: '2026-07-23T12:00:00Z',
  }), 'QUALIFICATION_ENVELOPE_MISMATCH')
  // probe-side pin: malformed probedAt/expiresAt fail closed at generation time
  await rejectsWithAsync(() => probeBindingQualification({
    ...BASE_INPUTS, query: async () => ({ rows: [] }), keyColumns: ['k'], probedAt: 'not-a-time',
  }), 'QUALIFICATION_INPUT_INVALID')

  // digest material must not contain undefined (collision fail-closed, review NIT)
  rejectsWith(() => computeQualificationDigest({ ...BASE_INPUTS, evidence: { a: undefined } }), 'QUALIFICATION_INPUT_INVALID')
  // …nor non-finite numbers (NaN collides with null under JSON semantics, review P2)
  rejectsWith(() => computeQualificationDigest({ ...BASE_INPUTS, evidence: { a: NaN } }), 'QUALIFICATION_INPUT_INVALID')

  // LIFECYCLE AUTHENTICATION (review P2): copying the qualification with a LATER
  // expiresAt must break the envelope — the postpone attack fails closed.
  const postponed = { ...qualification, expiresAt: '2027-01-01T00:00:00Z' }
  rejectsWith(() => verifyBindingQualification({
    qualification: postponed, expectedInputs: { ...BASE_INPUTS }, now: '2026-07-25T00:00:00Z',
  }), 'QUALIFICATION_ENVELOPE_MISMATCH')

  // impossible calendar dates are rejected even though Date.parse normalizes them
  rejectsWith(() => verifyBindingQualification({
    qualification, expectedInputs: { ...BASE_INPUTS }, now: '2026-02-30T00:00:00Z',
  }), 'QUALIFICATION_INPUT_INVALID')

  // PURE-LOCAL invariant: verify takes no query fn — source-level pin
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'gip-binding-qualification-spike.cjs'), 'utf8')
  const verifyBody = src.slice(src.indexOf('function verifyBindingQualification'), src.indexOf('module.exports'))
  assert.ok(!/\bquery\b/.test(verifyBody) && !/\bawait\b/.test(verifyBody),
    'verifyBindingQualification must stay pure-local (no query fn, no await)')

  // WIRING pin (review P3): the probe's ONLY execution path must run through
  // assertReadOnlySql. Source-level by necessity (the builder is safe by
  // construction, so no input can behaviorally expose an unwired guard) — the pin
  // still REDs the "remove the guard call" mutation.
  const helperStart = src.indexOf('async function runReadOnlyProbe')
  const probeStart = src.indexOf('async function probeBindingQualification')
  const helperBody = src.slice(helperStart, probeStart)
  const probeBody = src.slice(probeStart, src.indexOf('function verifyBindingQualification'))
  assert.ok(/assertReadOnlySql\(/.test(helperBody), 'runReadOnlyProbe must wire assertReadOnlySql')
  assert.ok(/runReadOnlyProbe\(/.test(probeBody), 'probe must route every query through runReadOnlyProbe')
  assert.ok(!/input\.query\(/.test(probeBody), 'probe must never call input.query directly (guard bypass)')
}

async function main() {
  frozenVocabulary()
  digestProperties()
  probeSqlReadOnly()
  await probeBehaviour()
  await verifyBehaviour()
  console.log('gip-binding-qualification-spike.test.cjs OK')
}

main().catch((error) => {
  console.error('gip-binding-qualification-spike.test.cjs FAILED')
  console.error(error)
  process.exit(1)
})
