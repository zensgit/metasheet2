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
  buildOrderingKeyDuplicateProbeSql,
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
    'QUALIFICATION_NOT_OBJECT',
    'QUALIFICATION_DIGEST_MISMATCH',
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
  rejectsWith(() => __internals.assertReadOnlySql('SELECT 1 INTO y FROM x UPDATE'), 'PROBE_SQL_NOT_READ_ONLY')
  // identifier hygiene: embedded quotes doubled, never raw
  assert.equal(__internals.quoteIdentifier('we"ird'), '"we""ird"')
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
  assert.equal(qualification.evidence.duplicateGroupsFound, 0)
  assert.equal(qualification.evidence.checkedKeyColumnCount, 2)
  assert.equal(seenSql.length, 1)
  assert.match(seenSql[0], /^SELECT /)

  // duplicates ⇒ fail closed, and the thrown error must NOT echo key values
  const SECRET = 'secret_item_A17'
  const dupQuery = async () => ({ rows: [{ item_no: SECRET, rev: 'B', duplicate_count: 3 }] })
  const caught = await rejectsWithAsync(() => probeBindingQualification({
    ...BASE_INPUTS, query: dupQuery, keyColumns: ['item_no', 'rev'], probedAt: 't',
  }), 'ORDERING_KEY_DUPLICATE_FOUND')
  assert.ok(!JSON.stringify({ m: caught.message, d: caught.details }).includes(SECRET),
    'duplicate-key failure must stay values-free')

  await rejectsWithAsync(() => probeBindingQualification({
    ...BASE_INPUTS, query: async () => { throw new Error('boom') }, keyColumns: ['k'], probedAt: 't',
  }), 'PROBE_QUERY_FAILED')
  await rejectsWithAsync(() => probeBindingQualification({
    ...BASE_INPUTS, query: async () => ({}), keyColumns: ['k'], probedAt: 't',
  }), 'PROBE_QUERY_FAILED')
}

// ── 5. Verify: pure-local, digest-bound, expiring, status-gated ──
async function verifyBehaviour() {
  const query = async () => ({ rows: [] })
  const qualification = await probeBindingQualification({
    ...BASE_INPUTS, query, keyColumns: ['item_no'], probedAt: 't0', expiresAt: '2026-07-24T00:00:00Z',
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
    qualification: { ...qualification, status: 'revoked' }, expectedInputs: { ...BASE_INPUTS }, now: 't',
  }), 'QUALIFICATION_STATUS_INVALID')

  // PURE-LOCAL invariant: verify takes no query fn — source-level pin
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'gip-binding-qualification-spike.cjs'), 'utf8')
  const verifyBody = src.slice(src.indexOf('function verifyBindingQualification'), src.indexOf('module.exports'))
  assert.ok(!/\bquery\b/.test(verifyBody) && !/\bawait\b/.test(verifyBody),
    'verifyBindingQualification must stay pure-local (no query fn, no await)')
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
