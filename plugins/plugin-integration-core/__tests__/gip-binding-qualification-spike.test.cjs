'use strict'

// GIP-D0 A3 — read-only qualification spike battery. Plain node test. Hermetic
// (fake query fn), values-free, zero writes by construction.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  QUALIFICATION_ERROR_REASONS,
  RESOLUTION_PROBE_INPUT_KEYS,
  RESOLUTION_VERIFY_INPUT_KEYS,
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
  verifyBindingQualificationFromResolution,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'gip-binding-qualification-spike.cjs'))

// B1a / R3.3 — the resolution-bound battery uses the REAL approved-binding resolver, so the
// WeakSet identity that authenticates a resolution is the real one (a stub would prove
// nothing about trust). Scoping/approval/content-key correctness is the resolver suite's
// job; here the resolver is driven by a minimal store/registry double whose ONLY duty is to
// hand it a valid approved world.
const {
  BINDING_RESOLUTION_FIELDS,
  createApprovedBindingResolver,
} = require(path.join(__dirname, '..', 'lib', 'gip-approved-binding-resolver.cjs'))
const { __internals: storeInternals } = require(path.join(__dirname, '..', 'lib', 'read-source-config-store.cjs'))
const { deepCloneFrozenCanonical } = require(path.join(__dirname, '..', 'lib', 'gip-canonical-json.cjs'))

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
    'QUALIFICATION_RESOLUTION_NOT_TRUSTED',
    'QUALIFICATION_RESOLUTION_INPUT_CONFLICT',
  ], 'the frozen reason vocabulary must match its pin exactly — a change must update both in one edit (subset AND superset must red)')
  assert.ok(Object.isFrozen(QUALIFICATION_ERROR_REASONS))
  // B1a / R3.3: the resolution-bound run-input allowlists are frozen and exact. Pinning
  // them is what makes "expectedInputs is REFUSED, not ignored" a contract rather than an
  // implementation detail — `expectedInputs` must never appear in the verify list.
  assert.deepEqual([...RESOLUTION_PROBE_INPUT_KEYS], ['resolution', 'query', 'envelopeKey', 'probedAt', 'expiresAt'],
    'the resolution-bound probe accepts exactly these run keys; every tuple field is DERIVED')
  assert.deepEqual([...RESOLUTION_VERIFY_INPUT_KEYS], ['resolution', 'qualification', 'envelopeKey', 'now'],
    'the resolution-bound verify accepts exactly these keys — expectedInputs is the surface it closes')
  assert.ok(Object.isFrozen(RESOLUTION_PROBE_INPUT_KEYS) && Object.isFrozen(RESOLUTION_VERIFY_INPUT_KEYS))
  for (const field of BINDING_RESOLUTION_FIELDS) {
    assert.ok(!RESOLUTION_PROBE_INPUT_KEYS.includes(field), 'no tuple field may be a probe run-input key')
    assert.ok(!RESOLUTION_VERIFY_INPUT_KEYS.includes(field), 'no tuple field may be a verify input key')
  }
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
  // NEGATIVE CONTROL — trust is OBJECT IDENTITY, not a forgeable public field (review
  // P1 round-6). A FULLY duck-typed registry — carrying __gipTrustedRegistry:true AND a
  // resolve() that returns a working, attacker-authored strategy with a smuggled
  // snapshotSemantics marker — is STILL rejected by the factory, because it was never
  // constructed by createProbeStrategyRegistry (not in the module-private WeakSet). The
  // owner's probe {"accepted":true,"markerLeaked":true} is closed: no prober is ever
  // minted from a forged registry, so the marker path is unreachable.
  const forgedRegistry = {
    __gipTrustedRegistry: true,
    resolve: () => ({
      buildTotalOrderProbeSql: () => 'SELECT 0 AS duplicate_groups_sampled, 0 AS null_key_rows',
      strategyId: 'gip.total_order_probe.postgres', strategyVersion: 'v1',
      dialect: 'postgres', snapshotSemantics: 'ATTACKER_SMUGGLED_MARKER',
    }),
  }
  rejectsWith(() => createBindingQualificationProber(forgedRegistry), 'QUALIFICATION_INPUT_INVALID')
  // primitives / null are rejected too (WeakSet.has returns false, never throws through)
  rejectsWith(() => createBindingQualificationProber(null), 'QUALIFICATION_INPUT_INVALID')
  rejectsWith(() => createBindingQualificationProber('nope'), 'QUALIFICATION_INPUT_INVALID')
  rejectsWith(() => createBindingQualificationProber({ resolve: () => null }), 'QUALIFICATION_INPUT_INVALID')
  // a REAL registry (WeakSet member) yields a working prober — identity, not property
  assert.equal(typeof createBindingQualificationProber(REGISTRY).probe, 'function')
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

// ── 6. B1a / R3.3 — RESOLUTION-BOUND probe + verify ───────────────────────────────────
// The point of the slice: the mix-and-match forgery ("config A's contentKey with field set
// B", "config A + system-or-profile B") must be INEXPRESSIBLE, not detectable. Evidence is
// values-free (a COUNT, never field names), so nothing downstream could ever catch it.
const { contentKeyFor } = storeInternals

const RES_TENANT = 'tenant-alpha'
const RES_WORKSPACE = 'ws-bom'
const RES_CONFIG_ID = 'cfg-approved-1'
const RES_SYSTEM_ID = 'k3-erp'
const RES_OBJECT_KEY = 'v_bom_lines'
const RES_PROFILE_VERSION = 'bridge.bounded_read.v2'
const RES_SCOPE = Object.freeze({ tenantId: RES_TENANT, workspaceId: RES_WORKSPACE, approvedConfigVersionId: RES_CONFIG_ID })
const RES_PROBED_AT = '2026-07-23T00:00:00Z'
const RES_NOW = '2026-07-23T12:00:00Z'

function resolutionBody(overrides = {}) {
  return {
    version: 3,
    systemId: RES_SYSTEM_ID,
    requiredKind: 'k3wise',
    object: RES_OBJECT_KEY,
    mode: 'list_page',
    readPath: '/api/read/bom',
    readMethod: 'GET',
    operations: ['read'],
    containerPaths: ['Data.Rows'],
    fieldMap: [
      { source: 'FNumber', target: 'material_code' },
      { source: 'Data.FQty', target: 'qty' },
    ],
    actionProfileVersion: RES_PROFILE_VERSION,
    orderingKeySpec: [
      { fieldId: 'material_code', direction: 'ASC' },
      { fieldId: 'qty', direction: 'DESC' },
    ],
    ...overrides,
  }
}

// Minimal store/registry doubles under the REAL resolver — so the WeakSet identity that
// authenticates a resolution here is the real one. (Approval/scope/content-key correctness
// is proven against production code in the resolver's own suite; duplicating that harness
// here would prove nothing extra.) The system record is camelCase because that is what the
// real external-system registry returns from its snake_case row.
function makeResolver(options = {}) {
  const body = options.body || resolutionBody()
  const systemConfig = options.systemConfig || { baseUrl: 'https://erp.internal.example/api' }
  return createApprovedBindingResolver({
    configStore: {
      async getForRuntime() {
        return {
          id: RES_CONFIG_ID,
          tenantId: RES_TENANT,
          workspaceId: RES_WORKSPACE,
          systemId: body.systemId,
          object: body.object,
          mode: body.mode,
          config: body,
          contentKey: contentKeyFor(body),
          version: body.version,
          status: 'approved',
        }
      },
    },
    systemRegistry: {
      // The UNSANITIZED identity read — the capability the resolver's factory now REQUIRES
      // (B1a D2.1). The registry's public getExternalSystem returns a lossy projection of
      // row.config and may never back a system identity; a double named after it is refused
      // by the factory, which is exactly the intended contract.
      async getExternalSystemForAdapter() {
        return {
          id: RES_SYSTEM_ID,
          tenantId: RES_TENANT,
          workspaceId: RES_WORKSPACE,
          name: 'K3 WISE production',
          kind: 'k3wise',
          role: 'source',
          config: systemConfig,
          capabilities: {},
          status: 'active',
        }
      },
    },
  })
}

const RES_REGISTRY = createProbeStrategyRegistry([{
  actionProfileVersion: RES_PROFILE_VERSION,
  ...postgresTotalOrderProbeStrategy,
}])
const RES_PROBER = createBindingQualificationProber(RES_REGISTRY)

const okRows = { rows: [{ duplicate_groups_sampled: 0, null_key_rows: 0 }] }
const tupleOf = (resolution) => ({
  actionProfileVersion: resolution.actionProfileVersion,
  systemContentKey: resolution.systemContentKey,
  configContentKey: resolution.configContentKey,
  objectKey: resolution.objectKey,
  canonicalObjectVersion: resolution.canonicalObjectVersion,
})

async function resolutionBoundQualification() {
  const resolution = await makeResolver().resolveApprovedBinding({ ...RES_SCOPE })

  // ── POSITIVE CONTROL FIRST: a broken fixture must fail AS a fixture, not as a mystery ──
  assert.equal(resolution.objectKey, RES_OBJECT_KEY, 'fixture: the resolution carries the approved object')
  assert.equal(resolution.actionProfileVersion, RES_PROFILE_VERSION, 'fixture: the resolution carries the approved profile')
  assert.equal(resolution.orderingKeySpec.length, 2, 'fixture: the approved ordering key has two entries')

  const seenSql = []
  const okQuery = async (sql) => { seenSql.push(sql); return okRows }
  const qualification = await RES_PROBER.probeFromResolution({
    resolution, query: okQuery, envelopeKey: ENVELOPE_KEY, probedAt: RES_PROBED_AT, expiresAt: '2026-07-24T00:00:00Z',
  })
  assert.equal(qualification.status, 'candidate', 'the resolution-bound probe mints a candidate')

  // The PROBED FIELD SET came from the resolution's ordering key, in order, and the probed
  // object from its objectKey — neither is reachable from run input at all.
  assert.equal(seenSql.length, 1, 'still exactly one statement')
  assert.match(seenSql[0], /FROM "v_bom_lines"/, 'the probe reads the RESOLUTION\'s object')
  assert.match(seenSql[0], /GROUP BY "material_code", "qty"/, 'the probed field set is the RESOLUTION\'s ordering key, in order')
  assert.equal(qualification.evidence.checkedKeyColumnCount, 2, 'evidence counts the resolution-derived field set')

  // ORDER IS LOAD-BEARING — an ordering key is a SEQUENCE, not a set. The fixture above has
  // alphabetical fieldIds, so it could NOT tell an ordered derivation from a sorted one
  // (a sort() mutation SURVIVED against it). This one is deliberately non-alphabetical.
  const descendingFirst = await makeResolver({
    body: resolutionBody({ orderingKeySpec: [{ fieldId: 'qty', direction: 'DESC' }, { fieldId: 'material_code', direction: 'ASC' }] }),
  }).resolveApprovedBinding({ ...RES_SCOPE })
  assert.deepEqual(
    __internals.deriveProbeKeyColumns(descendingFirst.orderingKeySpec),
    ['qty', 'material_code'],
    'the derived field set preserves the approved ordering-key SEQUENCE (never sorted, never reordered)',
  )
  const orderedSql = []
  await RES_PROBER.probeFromResolution({
    resolution: descendingFirst,
    query: async (sql) => { orderedSql.push(sql); return okRows },
    envelopeKey: ENVELOPE_KEY,
    probedAt: RES_PROBED_AT,
  })
  assert.match(orderedSql[0], /GROUP BY "qty", "material_code"/, 'the probe SQL carries the ordering key in the APPROVED order')

  // ── A RESOLUTION-DERIVED DIGEST VERIFIES ──
  const verified = verifyBindingQualificationFromResolution({
    qualification, resolution, envelopeKey: ENVELOPE_KEY, now: RES_NOW,
  })
  assert.equal(verified.verified, true, 'a qualification probed from a resolution verifies against that resolution')
  assert.equal(
    verified.qualificationDigest,
    computeQualificationDigest({ ...tupleOf(resolution), evidence: qualification.evidence }),
    'the verified digest is exactly the RESOLUTION tuple + the probe evidence',
  )
  // BOTH PATHS AGREE — the additive entry point is not a divergent second implementation.
  const throughRatified = verifyBindingQualification({
    qualification, expectedInputs: tupleOf(resolution), envelopeKey: ENVELOPE_KEY, now: RES_NOW,
  })
  assert.deepEqual(throughRatified, verified, 'the resolution-bound path delegates to the ratified one (one digest implementation)')

  // ── THE FORGERY: a mismatched tuple field supplied ALONGSIDE a valid resolution ──
  // Refused, not ignored — a caller must never believe its value was honoured.
  for (const field of BINDING_RESOLUTION_FIELDS) {
    const forged = field === 'orderingKeySpec' ? [{ fieldId: 'qty', direction: 'ASC' }] : 'attacker_supplied_value'
    const error = await rejectsWithAsync(() => RES_PROBER.probeFromResolution({
      resolution, query: okQuery, envelopeKey: ENVELOPE_KEY, probedAt: RES_PROBED_AT, [field]: forged,
    }), 'QUALIFICATION_RESOLUTION_INPUT_CONFLICT')
    assert.equal(error.details.rejectedKeyCount, 1, `a forged ${field} is counted, never echoed`)
    rejectsWith(() => verifyBindingQualificationFromResolution({
      qualification, resolution, envelopeKey: ENVELOPE_KEY, now: RES_NOW, [field]: forged,
    }), 'QUALIFICATION_RESOLUTION_INPUT_CONFLICT')
  }
  // The FIELD SET is not supplyable either — `keyColumns` is the "config A + field set B" leg.
  await rejectsWithAsync(() => RES_PROBER.probeFromResolution({
    resolution, query: okQuery, envelopeKey: ENVELOPE_KEY, probedAt: RES_PROBED_AT, keyColumns: ['material_code'],
  }), 'QUALIFICATION_RESOLUTION_INPUT_CONFLICT')
  // …and `expectedInputs` — THE caller-supplied surface this slice exists to close.
  rejectsWith(() => verifyBindingQualificationFromResolution({
    qualification, resolution, envelopeKey: ENVELOPE_KEY, now: RES_NOW, expectedInputs: tupleOf(resolution),
  }), 'QUALIFICATION_RESOLUTION_INPUT_CONFLICT')
  // POSITIVE CONTROL beside the refusals: the same call without the extra key still works.
  assert.equal(verifyBindingQualificationFromResolution({
    qualification, resolution, envelopeKey: ENVELOPE_KEY, now: RES_NOW,
  }).verified, true, 'the allowlist is not a blanket rejector')

  // VALUES-FREE: the conflict surface carries a COUNT and nothing else.
  const conflict = await rejectsWithAsync(() => RES_PROBER.probeFromResolution({
    resolution, query: okQuery, envelopeKey: ENVELOPE_KEY, probedAt: RES_PROBED_AT,
    objectKey: 'v_attacker_view', keyColumns: ['secret_column'],
  }), 'QUALIFICATION_RESOLUTION_INPUT_CONFLICT')
  assert.equal(conflict.details.rejectedKeyCount, 2, 'the count is the observable substitute for the omitted key names')
  const conflictSurface = JSON.stringify({ message: conflict.message, details: conflict.details })
  for (const secret of [...BINDING_RESOLUTION_FIELDS, 'keyColumns', 'v_attacker_view', 'secret_column', RES_OBJECT_KEY]) {
    assert.ok(!conflictSurface.includes(secret), `the conflict error must not carry "${secret}" (values-free)`)
  }

  // ── TRUST IS OBJECT IDENTITY: a hand-built resolution is refused by BOTH entry points ──
  const handBuilt = deepCloneFrozenCanonical(JSON.parse(JSON.stringify(resolution)))
  assert.deepEqual(handBuilt, resolution, 'the hand-built resolution is structurally identical, so only IDENTITY can refuse it')
  await rejectsWithAsync(() => RES_PROBER.probeFromResolution({
    resolution: handBuilt, query: okQuery, envelopeKey: ENVELOPE_KEY, probedAt: RES_PROBED_AT,
  }), 'QUALIFICATION_RESOLUTION_NOT_TRUSTED')
  rejectsWith(() => verifyBindingQualificationFromResolution({
    qualification, resolution: handBuilt, envelopeKey: ENVELOPE_KEY, now: RES_NOW,
  }), 'QUALIFICATION_RESOLUTION_NOT_TRUSTED')
  for (const impostor of [null, undefined, 'resolution', 42, {}, { ...JSON.parse(JSON.stringify(resolution)), __gipTrustedResolution: true }]) {
    await rejectsWithAsync(() => RES_PROBER.probeFromResolution({
      resolution: impostor, query: okQuery, envelopeKey: ENVELOPE_KEY, probedAt: RES_PROBED_AT,
    }), 'QUALIFICATION_RESOLUTION_NOT_TRUSTED')
    rejectsWith(() => verifyBindingQualificationFromResolution({
      qualification, resolution: impostor, envelopeKey: ENVELOPE_KEY, now: RES_NOW,
    }), 'QUALIFICATION_RESOLUTION_NOT_TRUSTED')
  }
  // POSITIVE CONTROL: a real resolution is still accepted (identity, not a blanket refusal).
  assert.equal((await RES_PROBER.probeFromResolution({
    resolution, query: okQuery, envelopeKey: ENVELOPE_KEY, probedAt: RES_PROBED_AT,
  })).status, 'candidate', 'the trust gate is not a blanket rejector')

  // ── AN OVERRIDE IS INEXPRESSIBLE AT THE DERIVATION CHOKE POINT ──
  // Called with an extra override-shaped argument — the position a careless refactor would
  // wire run input into. The derivation takes the resolution and NOTHING else.
  const derived = __internals.deriveQualificationInputsFromResolution(resolution, {
    objectKey: 'v_attacker_view', configContentKey: 'cck_attacker', keyColumns: ['attacker_column'],
  })
  assert.equal(derived.objectKey, resolution.objectKey, 'assembly must derive objectKey from the resolution, never from an argument')
  assert.equal(derived.configContentKey, resolution.configContentKey, 'assembly must derive configContentKey from the resolution')
  assert.deepEqual(derived.keyColumns, ['material_code', 'qty'], 'the probed field set is the resolution ordering key, never an argument')
}

// ── 7. B1a / R3.3 — cross-binding is INEXPRESSIBLE (the money assertions) ─────────────
async function crossBindingIsInexpressible() {
  const resolution = await makeResolver().resolveApprovedBinding({ ...RES_SCOPE })
  const qualification = await RES_PROBER.probeFromResolution({
    resolution, query: async () => okRows, envelopeKey: ENVELOPE_KEY, probedAt: RES_PROBED_AT,
  })
  // POSITIVE CONTROL: it verifies against its own resolution.
  assert.equal(verifyBindingQualificationFromResolution({
    qualification, resolution, envelopeKey: ENVELOPE_KEY, now: RES_NOW,
  }).verified, true, 'positive control: the qualification verifies against the resolution it was probed from')

  // (a) SAME config body, system REPOINTED at another host ⇒ different systemContentKey.
  const repointed = await makeResolver({ systemConfig: { baseUrl: 'https://attacker.example/api' } })
    .resolveApprovedBinding({ ...RES_SCOPE })
  assert.equal(repointed.configContentKey, resolution.configContentKey, 'fixture: the config body is identical in both worlds')
  assert.notEqual(repointed.systemContentKey, resolution.systemContentKey, 'repointing the system changes its content key')
  rejectsWith(() => verifyBindingQualificationFromResolution({
    qualification, resolution: repointed, envelopeKey: ENVELOPE_KEY, now: RES_NOW,
  }), 'QUALIFICATION_DIGEST_MISMATCH')

  // (b) SAME everything except the ORDERING KEY — the "config A + field set B" leg. Both
  // specs have TWO entries, so the values-free evidence (checkedKeyColumnCount: 2) is
  // IDENTICAL and could never tell them apart. What separates them is that orderingKeySpec
  // lives in the immutable approved body, so contentKeyFor(body) covers it: a different
  // ordering key ⇒ a different configContentKey ⇒ a different digest. That binding only
  // holds because the probe DERIVES its field set from the resolution — a caller-supplied
  // field set would be bound to nothing at all, and undetectable afterwards.
  const reordered = await makeResolver({
    body: resolutionBody({ orderingKeySpec: [{ fieldId: 'qty', direction: 'DESC' }, { fieldId: 'material_code', direction: 'ASC' }] }),
  }).resolveApprovedBinding({ ...RES_SCOPE })
  assert.equal(reordered.orderingKeySpec.length, resolution.orderingKeySpec.length, 'both ordering keys have the same LENGTH (a count cannot separate them)')
  assert.notEqual(reordered.configContentKey, resolution.configContentKey, 'the ordering key is inside the content-keyed immutable body')
  assert.notEqual(
    computeQualificationDigest({ ...tupleOf(reordered), evidence: qualification.evidence }),
    computeQualificationDigest({ ...tupleOf(resolution), evidence: qualification.evidence }),
    'under IDENTICAL evidence the two ordering keys digest differently — the field set is bound transitively through configContentKey',
  )
  rejectsWith(() => verifyBindingQualificationFromResolution({
    qualification, resolution: reordered, envelopeKey: ENVELOPE_KEY, now: RES_NOW,
  }), 'QUALIFICATION_DIGEST_MISMATCH')

  // ── R2 CONTINUATION AT THIS BOUNDARY: the async source window ──
  // probeWithTrustedRegistry reads the tuple AFTER the source round-trip. The resolution-
  // bound path assembles a parse-time object THIS module owns, so a caller mutating its own
  // run input during that window reaches nothing; and the resolution itself is deep-frozen.
  let refusedResolutionWrites = 0
  const runInput = {
    resolution, envelopeKey: ENVELOPE_KEY, probedAt: RES_PROBED_AT, query: null,
  }
  runInput.query = async () => {
    await new Promise((resolve) => setImmediate(resolve))
    runInput.probedAt = '2020-01-01T00:00:00Z'
    runInput.envelopeKey = { keyId: 'k_attacker', secret: Buffer.alloc(32, 3) }
    try { resolution.orderingKeySpec[0].fieldId = 'attacker_column' } catch (_error) { refusedResolutionWrites += 1 }
    await new Promise((resolve) => setImmediate(resolve))
    return okRows
  }
  const windowQualification = await RES_PROBER.probeFromResolution(runInput)
  assert.equal(refusedResolutionWrites, 1, 'the resolution must stay deep-frozen inside the source window')
  assert.equal(windowQualification.evidence.probedAt, RES_PROBED_AT, 'run data is snapshotted at parse time — a mutation inside the window must not reach it')
  assert.equal(windowQualification.envelopeKeyId, 'k2026a', 'the envelope key is the one the call started with')
  assert.equal(
    windowQualification.qualificationDigest,
    computeQualificationDigest({ ...tupleOf(resolution), evidence: windowQualification.evidence }),
    'the digest still binds the RESOLUTION tuple after the source window',
  )
  assert.equal(verifyBindingQualificationFromResolution({
    qualification: windowQualification, resolution, envelopeKey: ENVELOPE_KEY, now: RES_NOW,
  }).verified, true, 'the qualification minted across the window verifies')
}

// ── 8. THE RESIDUAL, PINNED BEHAVIOURALLY (so the caveat cannot rot) ──────────────────
// The API choice was ADDITIVE: the ratified `probe()` stays exported and still takes
// `keyColumns` as RUN DATA. So a caller who legitimately holds resolution A can mint a
// qualification carrying A's five digest fields while probing FIELD SET B — and because
// evidence is values-free, `verifyBindingQualificationFromResolution` CANNOT see it and
// returns verified:true. The forgery is inexpressible only for callers restricted to the
// *FromResolution* pair; closing it for everyone is the GATED WIRING POINT's job (bind the
// runtime to probeFromResolution/verifyBindingQualificationFromResolution ONLY).
// A count check in verify would NOT fix this: it would catch a different-SIZE field set and
// miss a same-size foreign one — a partial detector for a hole the wiring gate closes
// completely, and shipping it would contradict "detection is impossible, therefore
// construction-prevention". This test exists so the residual is a MEASURED fact.
async function ratifiedPathRemainsAnOpenConstruction() {
  const resolution = await makeResolver().resolveApprovedBinding({ ...RES_SCOPE })
  assert.equal(resolution.orderingKeySpec.length, 2, 'fixture: the approved ordering key has two entries')

  const forgedSql = []
  const forged = await RES_PROBER.probe({
    ...tupleOf(resolution),
    keyColumns: ['qty'], // FIELD SET B — never the approved ordering key
    query: async (sql) => { forgedSql.push(sql); return okRows },
    envelopeKey: ENVELOPE_KEY,
    probedAt: RES_PROBED_AT,
  })
  assert.ok(!/material_code/.test(forgedSql[0]), 'the ratified path really did probe a DIFFERENT field set')
  assert.equal(forged.evidence.checkedKeyColumnCount, 1, 'evidence carries a COUNT — and the count is not even the same one')
  assert.equal(
    verifyBindingQualificationFromResolution({
      qualification: forged, resolution, envelopeKey: ENVELOPE_KEY, now: RES_NOW,
    }).verified,
    true,
    'RESIDUAL (measured, not accidental): a qualification minted through the RATIFIED probe over a foreign field set still verifies against the resolution — evidence is values-free, so verify cannot see the field set. Closure is the gated wiring point\'s job.',
  )
  // CONTROL: the digest is still doing its job — the same forged qualification does NOT
  // verify against a different binding. The residual is specifically the FIELD SET.
  const reordered = await makeResolver({
    body: resolutionBody({ orderingKeySpec: [{ fieldId: 'qty', direction: 'DESC' }, { fieldId: 'material_code', direction: 'ASC' }] }),
  }).resolveApprovedBinding({ ...RES_SCOPE })
  rejectsWith(() => verifyBindingQualificationFromResolution({
    qualification: forged, resolution: reordered, envelopeKey: ENVELOPE_KEY, now: RES_NOW,
  }), 'QUALIFICATION_DIGEST_MISMATCH')

  // …and the resolution-bound probe CANNOT be talked into that field set at all.
  await rejectsWithAsync(() => RES_PROBER.probeFromResolution({
    resolution, keyColumns: ['qty'], query: async () => okRows, envelopeKey: ENVELOPE_KEY, probedAt: RES_PROBED_AT,
  }), 'QUALIFICATION_RESOLUTION_INPUT_CONFLICT')

  // Named (not merely allowlist-generic) refusal of the strategy-injection keys on the
  // resolution-bound path, mirroring the ratified path's own negative controls.
  for (const smuggled of ['strategyRegistry', 'probeStrategy']) {
    await rejectsWithAsync(() => RES_PROBER.probeFromResolution({
      resolution, query: async () => okRows, envelopeKey: ENVELOPE_KEY, probedAt: RES_PROBED_AT,
      [smuggled]: { resolve: () => null, buildTotalOrderProbeSql: () => 'SELECT 1' },
    }), 'QUALIFICATION_RESOLUTION_INPUT_CONFLICT')
  }

  // VALUES-FREE on the other new reason too.
  const untrusted = await rejectsWithAsync(() => RES_PROBER.probeFromResolution({
    resolution: { ...JSON.parse(JSON.stringify(resolution)) },
    query: async () => okRows, envelopeKey: ENVELOPE_KEY, probedAt: RES_PROBED_AT,
  }), 'QUALIFICATION_RESOLUTION_NOT_TRUSTED')
  const untrustedSurface = JSON.stringify({ message: untrusted.message, details: untrusted.details })
  for (const secret of ['material_code', 'qty', RES_OBJECT_KEY, RES_SYSTEM_ID, RES_TENANT, resolution.configContentKey, resolution.systemContentKey]) {
    assert.ok(!untrustedSurface.includes(secret), `the untrusted-resolution error must not carry "${secret}" (values-free)`)
  }
}

// RESIDUAL 2, pinned so the header paragraph cannot rot: probeFromResolution() binds the
// tuple and the field set to the resolution, but NOT the SOURCE HANDLE. `query` is
// caller-supplied, so evidence need never come from the bound system — two resolutions that
// differ in their system can be answered by the SAME caller-side function, and both
// qualifications verify. The fix (derive the handle from the resolution's own system record)
// belongs to the gated wiring point; asserting it closed here would be a lie.
async function callerSuppliedQueryRemainsAnOpenConstruction() {
  const resolution = await makeResolver().resolveApprovedBinding({ ...RES_SCOPE })
  const elsewhere = await makeResolver({ systemConfig: { baseUrl: 'https://attacker.example/api' } })
    .resolveApprovedBinding({ ...RES_SCOPE })
  assert.notEqual(
    elsewhere.systemContentKey,
    resolution.systemContentKey,
    'fixture: the two resolutions really are bound to different systems',
  )
  // ONE caller-side answer, never touching either system, satisfies BOTH probes.
  let sourcesTouched = 0
  const answerFromNowhere = async () => { sourcesTouched += 1; return okRows }
  const first = await RES_PROBER.probeFromResolution({
    resolution, query: answerFromNowhere, envelopeKey: ENVELOPE_KEY, probedAt: RES_PROBED_AT,
  })
  const second = await RES_PROBER.probeFromResolution({
    resolution: elsewhere, query: answerFromNowhere, envelopeKey: ENVELOPE_KEY, probedAt: RES_PROBED_AT,
  })
  assert.equal(sourcesTouched, 2, 'both probes were answered by the SAME caller-supplied function')
  assert.equal(
    verifyBindingQualificationFromResolution({ qualification: first, resolution, envelopeKey: ENVELOPE_KEY, now: RES_NOW }).verified,
    true,
    'RESIDUAL (measured): evidence produced without touching the bound system still verifies — a qualification proves the six approved inputs, NOT that the evidence came from the bound system',
  )
  assert.equal(
    verifyBindingQualificationFromResolution({ qualification: second, resolution: elsewhere, envelopeKey: ENVELOPE_KEY, now: RES_NOW }).verified,
    true,
    'RESIDUAL (measured): the same holds for a resolution bound to a DIFFERENT system',
  )
  // CONTROL: the residual is specifically the SOURCE HANDLE — the two qualifications are NOT
  // interchangeable, because the system identity is still in the digest.
  rejectsWith(() => verifyBindingQualificationFromResolution({
    qualification: first, resolution: elsewhere, envelopeKey: ENVELOPE_KEY, now: RES_NOW,
  }), 'QUALIFICATION_DIGEST_MISMATCH')
}

async function main() {
  frozenVocabulary()
  digestProperties()
  probeSqlReadOnly()
  await probeBehaviour()
  await verifyBehaviour()
  await resolutionBoundQualification()
  await crossBindingIsInexpressible()
  await ratifiedPathRemainsAnOpenConstruction()
  await callerSuppliedQueryRemainsAnOpenConstruction()
  console.log('gip-binding-qualification-spike.test.cjs OK')
}

main().catch((error) => {
  console.error('gip-binding-qualification-spike.test.cjs FAILED')
  console.error(error)
  process.exit(1)
})
