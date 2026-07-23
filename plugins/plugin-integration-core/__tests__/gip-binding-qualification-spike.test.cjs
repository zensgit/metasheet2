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
  computeEnvelopeMac,
  buildOrderingKeyDuplicateProbeSql,
  buildOrderingKeyNullProbeSql,
  buildOrderingKeyTotalOrderProbeSql,
  postgresTotalOrderProbeStrategy,
  createProbeStrategyRegistry,
  createBindingQualificationProber,
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

// raw-bytes secrets, >=32 bytes (review P2: string secrets — even long ones — are
// refused; short keys are offline-brute-forceable since message+MAC are public)
const ENVELOPE_KEY = Object.freeze({ keyId: 'k2026a', secret: Buffer.alloc(32, 7) })
const WRONG_KEY = Object.freeze({ keyId: 'k2026a', secret: Buffer.alloc(32, 9) })
const REGISTRY = createProbeStrategyRegistry([{
  actionProfileVersion: 'fixture.paged_read.v1',
  ...postgresTotalOrderProbeStrategy,
}])
const PROBER = createBindingQualificationProber(REGISTRY)

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
    'PROBE_STRATEGY_UNBOUND',
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
  // COMBINED single-statement probe (review P1: one source snapshot, no torn read)
  const combined = buildOrderingKeyTotalOrderProbeSql({ objectName: 'fixture_view', keyColumns: ['item_no'] })
  assert.match(combined, /^SELECT \(SELECT COUNT\(\*\) FROM \(SELECT /)
  // ::int casts so the REAL pg driver returns numbers (int8 COUNT(*) arrives as string)
  assert.match(combined, /\)::int AS duplicate_groups_sampled, \(SELECT COUNT\(\*\) FROM \(SELECT 1 AS null_key_row /)
  assert.match(combined, /\)::int AS null_key_rows$/)
  assert.equal(__internals.assertReadOnlySql(combined), combined)
  // duplicate keyColumns declaration is rejected, never silently deduped (review P2)
  rejectsWith(() => buildOrderingKeyDuplicateProbeSql({ objectName: 'v', keyColumns: ['k', 'k'] }), 'QUALIFICATION_INPUT_INVALID')
}

// ── 4. Probe: uniqueness pass / duplicate fail-closed (values-free) ──
async function probeBehaviour() {
  const seenSql = []
  const okQuery = async (sql) => { seenSql.push(sql); return { rows: [{ duplicate_groups_sampled: 0, null_key_rows: 0 }] } }
  const qualification = await PROBER.probe({
    ...BASE_INPUTS,
    envelopeKey: ENVELOPE_KEY,
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
  assert.equal(qualification.evidence.probeStrategyId, 'gip.total_order_probe.postgres')
  assert.equal(qualification.evidence.probeStrategyVersion, 'v1')
  assert.equal(qualification.evidence.probeDialect, 'postgres')
  assert.equal(qualification.evidence.snapshotSemantics, 'single_statement_mvcc')
  assert.equal(qualification.envelopeKeyId, 'k2026a')
  assert.ok(typeof qualification.envelopeMac === 'string' && qualification.envelopeMac.length === 64)
  // the secret never appears anywhere in the qualification
  assert.ok(!JSON.stringify(qualification).includes(ENVELOPE_KEY.secret.toString('hex')))
  // EXACTLY ONE statement (review P1: a second read would reopen the torn-check hole)
  assert.equal(seenSql.length, 1)
  assert.match(seenSql[0], /duplicate_groups_sampled/)
  assert.match(seenSql[0], /null_key_rows/)

  // duplicates ⇒ fail closed, values-free
  const SECRET = 'secret_item_A17'
  const dupQuery = async () => ({ rows: [{ duplicate_groups_sampled: 3, null_key_rows: 0, leak: SECRET }] })
  const caught = await rejectsWithAsync(() => PROBER.probe({
    ...BASE_INPUTS, envelopeKey: ENVELOPE_KEY, query: dupQuery, keyColumns: ['item_no', 'rev'], probedAt: '2026-07-23T00:00:00Z',
  }), 'ORDERING_KEY_DUPLICATE_FOUND')
  assert.ok(!JSON.stringify({ m: caught.message, d: caught.details }).includes(SECRET),
    'duplicate-key failure must stay values-free')

  // NULL key components ⇒ fail closed (same single statement)
  const nullQuery = async () => ({ rows: [{ duplicate_groups_sampled: 0, null_key_rows: 2 }] })
  await rejectsWithAsync(() => PROBER.probe({
    ...BASE_INPUTS, envelopeKey: ENVELOPE_KEY, query: nullQuery, keyColumns: ['item_no'], probedAt: '2026-07-23T00:00:00Z',
  }), 'ORDERING_KEY_NULL_FOUND')

  await rejectsWithAsync(() => PROBER.probe({
    ...BASE_INPUTS, envelopeKey: ENVELOPE_KEY, query: async () => { throw new Error('boom') }, keyColumns: ['k'], probedAt: '2026-07-23T00:00:00Z',
  }), 'PROBE_QUERY_FAILED')
  await rejectsWithAsync(() => PROBER.probe({
    ...BASE_INPUTS, envelopeKey: ENVELOPE_KEY, query: async () => ({ rows: [] }), keyColumns: ['k'], probedAt: '2026-07-23T00:00:00Z',
  }), 'PROBE_QUERY_FAILED')
  // no envelope key ⇒ fail closed before any probing
  await rejectsWithAsync(() => PROBER.probe({
    ...BASE_INPUTS, query: okQuery, keyColumns: ['k'], probedAt: '2026-07-23T00:00:00Z',
  }), 'QUALIFICATION_INPUT_INVALID')

  // REGISTRY IS FACTORY-BOUND (review P1): run input must NOT carry a strategy or a
  // registry — a fake duck-typed registry can never enter the qualification chain.
  await rejectsWithAsync(() => PROBER.probe({
    ...BASE_INPUTS, envelopeKey: ENVELOPE_KEY,
    strategyRegistry: { resolve: () => ({ buildTotalOrderProbeSql: () => 'SELECT 1', strategyId: 'EVIL', strategyVersion: 'v', dialect: 'evil', snapshotSemantics: 'marker' }) },
    query: okQuery, keyColumns: ['k'], probedAt: '2026-07-23T00:00:00Z',
  }), 'QUALIFICATION_INPUT_INVALID')
  await rejectsWithAsync(() => PROBER.probe({
    ...BASE_INPUTS, envelopeKey: ENVELOPE_KEY,
    probeStrategy: { dialect: 'evil', snapshotSemantics: 'marker_smuggle', buildTotalOrderProbeSql: () => 'SELECT 1' },
    query: okQuery, keyColumns: ['k'], probedAt: '2026-07-23T00:00:00Z',
  }), 'QUALIFICATION_INPUT_INVALID')
  // the factory itself REFUSES a non-branded (fake) registry — the injection never
  // even reaches a prober.
  assert.throws(() => createBindingQualificationProber({ resolve: () => null }))
  // profile with NO bound strategy ⇒ PROBE_STRATEGY_UNBOUND (named fail-closed)
  await rejectsWithAsync(() => PROBER.probe({
    ...BASE_INPUTS, actionProfileVersion: 'fixture.unbound_read.v1', envelopeKey: ENVELOPE_KEY,
    query: okQuery, keyColumns: ['k'], probedAt: '2026-07-23T00:00:00Z',
  }), 'PROBE_STRATEGY_UNBOUND')
  // strategy identity is a CLOSED evidence field sourced from the registry
  // (the earlier fake-strategy marker path is gone by construction)
  // weak keys are refused: string secrets (any length) and short buffers
  await rejectsWithAsync(() => PROBER.probe({
    ...BASE_INPUTS, envelopeKey: { keyId: 'k', secret: 'x' },
    query: okQuery, keyColumns: ['k'], probedAt: '2026-07-23T00:00:00Z',
  }), 'QUALIFICATION_INPUT_INVALID')
  await rejectsWithAsync(() => PROBER.probe({
    ...BASE_INPUTS, envelopeKey: { keyId: 'k', secret: 'server_held_secret_material_1_long_enough_but_text' },
    query: okQuery, keyColumns: ['k'], probedAt: '2026-07-23T00:00:00Z',
  }), 'QUALIFICATION_INPUT_INVALID')
  await rejectsWithAsync(() => PROBER.probe({
    ...BASE_INPUTS, envelopeKey: { keyId: 'k', secret: Buffer.alloc(16, 1) },
    query: okQuery, keyColumns: ['k'], probedAt: '2026-07-23T00:00:00Z',
  }), 'QUALIFICATION_INPUT_INVALID')
  // DEFENSIVE KEY COPY is LOAD-BEARING (review P2): the caller mutates its own key
  // Buffer INSIDE the query callback — i.e. during the await window BETWEEN the key
  // copy and the MAC computation. Because probe took a defensive copy up front, the
  // MAC binds the ORIGINAL bytes, so verify with the original key succeeds. Without
  // the copy the MAC would bind the mutated bytes (this exact test REDs on removal).
  const original = Buffer.alloc(32, 7)
  const attackerControlled = Buffer.from(original) // the buffer probe receives
  const windowQuery = async (sql) => {
    attackerControlled.fill(9) // mutate DURING the await, after the copy was taken
    return { rows: [{ duplicate_groups_sampled: 0, null_key_rows: 0 }] }
  }
  const windowQual = await PROBER.probe({
    ...BASE_INPUTS, envelopeKey: { keyId: 'kx', secret: attackerControlled },
    query: windowQuery, keyColumns: ['item_no'], probedAt: '2026-07-23T00:00:00Z', expiresAt: '2026-07-24T00:00:00Z',
  })
  const verifiedOriginal = verifyBindingQualification({
    qualification: windowQual, expectedInputs: { ...BASE_INPUTS }, envelopeKey: { keyId: 'kx', secret: original }, now: '2026-07-23T12:00:00Z',
  })
  assert.equal(verifiedOriginal.verified, true, 'MAC must bind the ORIGINAL key bytes (copy taken before await)')
  // …and the mutated value must NOT verify (it never was the key)
  rejectsWith(() => verifyBindingQualification({
    qualification: windowQual, expectedInputs: { ...BASE_INPUTS }, envelopeKey: { keyId: 'kx', secret: Buffer.alloc(32, 9) }, now: '2026-07-23T12:00:00Z',
  }), 'QUALIFICATION_ENVELOPE_MISMATCH')
  // registry field hygiene: control chars / oversize identity strings fail loud
  assert.throws(() => createProbeStrategyRegistry([{ actionProfileVersion: 'x.y.v1', strategyId: 'a\nb', strategyVersion: 'v1', dialect: 'postgres', snapshotSemantics: 's', buildTotalOrderProbeSql: () => 'SELECT 1' }]))
  assert.throws(() => createProbeStrategyRegistry([{ actionProfileVersion: 'x.y.v1', strategyId: 'z'.repeat(200), strategyVersion: 'v1', dialect: 'postgres', snapshotSemantics: 's', buildTotalOrderProbeSql: () => 'SELECT 1' }]))

  // REAL-DRIVER COUNT SHAPE (review P1): node-postgres returns int8 counts as
  // STRINGS — a '0'/'0' summary row must qualify, not PROBE_QUERY_FAILED.
  const pgShapeQuery = async () => ({ rows: [{ duplicate_groups_sampled: '0', null_key_rows: '0' }] })
  const pgShaped = await PROBER.probe({
    ...BASE_INPUTS, envelopeKey: ENVELOPE_KEY,
    query: pgShapeQuery, keyColumns: ['item_no'], probedAt: '2026-07-23T00:00:00Z',
  })
  assert.equal(pgShaped.status, 'candidate')
  // …string counts still trip the fail-closed branches
  const pgDupQuery = async () => ({ rows: [{ duplicate_groups_sampled: '2', null_key_rows: '0' }] })
  await rejectsWithAsync(() => PROBER.probe({
    ...BASE_INPUTS, envelopeKey: ENVELOPE_KEY,
    query: pgDupQuery, keyColumns: ['item_no'], probedAt: '2026-07-23T00:00:00Z',
  }), 'ORDERING_KEY_DUPLICATE_FOUND')
  // …and junk shapes stay rejected ('007', '1e3', negative, non-decimal)
  for (const bad of ['007', '1e3', '-1', 'abc']) {
    const junk = async () => ({ rows: [{ duplicate_groups_sampled: bad, null_key_rows: '0' }] })
    await rejectsWithAsync(() => PROBER.probe({
      ...BASE_INPUTS, envelopeKey: ENVELOPE_KEY,
      query: junk, keyColumns: ['item_no'], probedAt: '2026-07-23T00:00:00Z',
    }), 'PROBE_QUERY_FAILED')
  }
}

// ── 5. Verify: pure-local, digest-bound, expiring, status-gated ──
async function verifyBehaviour() {
  const query = async () => ({ rows: [{ duplicate_groups_sampled: 0, null_key_rows: 0 }] })
  const qualification = await PROBER.probe({
    ...BASE_INPUTS, envelopeKey: ENVELOPE_KEY, query, keyColumns: ['item_no'], probedAt: '2026-07-23T00:00:00Z', expiresAt: '2026-07-24T00:00:00Z',
  })

  const ok = verifyBindingQualification({
    qualification, expectedInputs: { ...BASE_INPUTS }, envelopeKey: ENVELOPE_KEY, now: '2026-07-23T12:00:00Z',
  })
  assert.equal(ok.verified, true)

  // cross-object reuse ⇒ content digest mismatch (input binding is load-bearing)
  rejectsWith(() => verifyBindingQualification({
    qualification, expectedInputs: { ...BASE_INPUTS, objectKey: 'another_view' }, envelopeKey: ENVELOPE_KEY, now: '2026-07-23T12:00:00Z',
  }), 'QUALIFICATION_DIGEST_MISMATCH')

  // expiry ⇒ fail closed: Run-start proper never probes — fresh Preflight required
  rejectsWith(() => verifyBindingQualification({
    qualification, expectedInputs: { ...BASE_INPUTS }, envelopeKey: ENVELOPE_KEY, now: '2026-07-25T00:00:00Z',
  }), 'QUALIFICATION_EXPIRED')

  // tampered evidence ⇒ envelope holds (content digest unchanged in copy) then
  // content digest mismatch
  const tampered = { ...qualification, evidence: { ...qualification.evidence, duplicateGroupsFound: 1 } }
  rejectsWith(() => verifyBindingQualification({
    qualification: tampered, expectedInputs: { ...BASE_INPUTS }, envelopeKey: ENVELOPE_KEY, now: '2026-07-23T12:00:00Z',
  }), 'QUALIFICATION_DIGEST_MISMATCH')

  // status gate: only 'candidate' verifiable
  rejectsWith(() => verifyBindingQualification({
    qualification: { ...qualification, status: 'revoked' }, expectedInputs: { ...BASE_INPUTS }, envelopeKey: ENVELOPE_KEY, now: '2026-07-23T12:00:00Z',
  }), 'QUALIFICATION_STATUS_INVALID')

  // ── LIFECYCLE AUTHENTICATION (review P1: keyed MAC, not a public checksum) ──
  // (a) postponed copy WITHOUT recompute ⇒ envelope mismatch
  rejectsWith(() => verifyBindingQualification({
    qualification: { ...qualification, expiresAt: '2027-01-01T00:00:00Z' }, expectedInputs: { ...BASE_INPUTS }, envelopeKey: ENVELOPE_KEY, now: '2026-07-25T00:00:00Z',
  }), 'QUALIFICATION_ENVELOPE_MISMATCH')
  // (b) THE ATTACK: postponed copy + envelope RECOMPUTED from public values with a
  //     guessed secret — the server-held key defeats it (an unkeyed hash would not).
  const forged = {
    ...qualification,
    expiresAt: '2027-01-01T00:00:00Z',
    envelopeMac: computeEnvelopeMac({
      envelopeKey: WRONG_KEY,
      qualificationDigest: qualification.qualificationDigest,
      status: qualification.status,
      expiresAt: '2027-01-01T00:00:00Z',
    }),
  }
  rejectsWith(() => verifyBindingQualification({
    qualification: forged, expectedInputs: { ...BASE_INPUTS }, envelopeKey: ENVELOPE_KEY, now: '2026-07-25T00:00:00Z',
  }), 'QUALIFICATION_ENVELOPE_MISMATCH')
  // (c) keyId mismatch ⇒ fail closed (rotation selects keys; unknown key never verifies)
  rejectsWith(() => verifyBindingQualification({
    qualification: { ...qualification, envelopeKeyId: 'k2020x' }, expectedInputs: { ...BASE_INPUTS }, envelopeKey: ENVELOPE_KEY, now: '2026-07-23T12:00:00Z',
  }), 'QUALIFICATION_ENVELOPE_MISMATCH')

  // malformed MAC (64 chars but non-hex) stays INSIDE the frozen vocabulary —
  // never ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH (review P2)
  rejectsWith(() => verifyBindingQualification({
    qualification: { ...qualification, envelopeMac: 'z'.repeat(64) }, expectedInputs: { ...BASE_INPUTS }, envelopeKey: ENVELOPE_KEY, now: '2026-07-23T12:00:00Z',
  }), 'QUALIFICATION_ENVELOPE_MISMATCH')
  rejectsWith(() => verifyBindingQualification({
    qualification: { ...qualification, envelopeMac: 'abc' }, expectedInputs: { ...BASE_INPUTS }, envelopeKey: ENVELOPE_KEY, now: '2026-07-23T12:00:00Z',
  }), 'QUALIFICATION_ENVELOPE_MISMATCH')

  // a COPY with malformed expiresAt is a lifecycle tamper — envelope catches it
  rejectsWith(() => verifyBindingQualification({
    qualification: { ...qualification, expiresAt: 'tomorrow' }, expectedInputs: { ...BASE_INPUTS }, envelopeKey: ENVELOPE_KEY, now: '2026-07-23T12:00:00Z',
  }), 'QUALIFICATION_ENVELOPE_MISMATCH')

  // TIMESTAMP PIN — non-ISO `now` fails CLOSED
  rejectsWith(() => verifyBindingQualification({
    qualification, expectedInputs: { ...BASE_INPUTS }, envelopeKey: ENVELOPE_KEY, now: '07/25/2026',
  }), 'QUALIFICATION_INPUT_INVALID')
  // probe-side pin: malformed probedAt fails closed at generation time
  await rejectsWithAsync(() => PROBER.probe({
    ...BASE_INPUTS, envelopeKey: ENVELOPE_KEY, query: async () => ({ rows: [{ duplicate_groups_sampled: 0, null_key_rows: 0 }] }), keyColumns: ['k'], probedAt: 'not-a-time',
  }), 'QUALIFICATION_INPUT_INVALID')

  // digest material domain (shared codec): undefined / NaN / Date all fail closed
  rejectsWith(() => computeQualificationDigest({ ...BASE_INPUTS, evidence: { a: undefined } }), 'QUALIFICATION_INPUT_INVALID')
  rejectsWith(() => computeQualificationDigest({ ...BASE_INPUTS, evidence: { a: NaN } }), 'QUALIFICATION_INPUT_INVALID')
  rejectsWith(() => computeQualificationDigest({ ...BASE_INPUTS, evidence: { a: new Date(0) } }), 'QUALIFICATION_INPUT_INVALID')

  // impossible calendar dates are rejected even though Date.parse normalizes them
  rejectsWith(() => verifyBindingQualification({
    qualification, expectedInputs: { ...BASE_INPUTS }, envelopeKey: ENVELOPE_KEY, now: '2026-02-30T00:00:00Z',
  }), 'QUALIFICATION_INPUT_INVALID')

  // PURE-LOCAL invariant: verify takes no query fn — source-level pin
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'gip-binding-qualification-spike.cjs'), 'utf8')
  const verifyBody = src.slice(src.indexOf('function verifyBindingQualification'), src.indexOf('module.exports'))
  assert.ok(!/\bquery\b/.test(verifyBody) && !/\bawait\b/.test(verifyBody),
    'verifyBindingQualification must stay pure-local (no query fn, no await)')

  // WIRING pin: probe routes its ONLY query through runReadOnlyProbe/assertReadOnlySql
  const helperStart = src.indexOf('async function runReadOnlyProbe')
  const probeStart = src.indexOf('async function probeWithTrustedRegistry')
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
