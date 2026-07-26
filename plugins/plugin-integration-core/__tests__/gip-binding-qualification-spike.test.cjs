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

// ── §4 step 1.5 RE-POINT (B1a-3) — WHICH TESTS MOVED, AND WHY ────────────────
// This file used to build a probe-strategy registry through the EXPORTED
// `createProbeStrategyRegistry` and drive `PROBER.probe({ query, keyColumns, ...tuple })`.
// BOTH constructions are gone:
//   * the caller-supplied-tuple entry point was REMOVED (§4 step 1.5). The frozen
//     prober object's exact key set is now `{ probeFromResolution }`;
//   * `createProbeStrategyRegistry` is now BUILD-ONLY (the V-7 fix) and reaches no
//     probe path under δ=(c), so it can no longer mint a prober at all.
// The affected tests are re-pointed at the SANCTIONED seam — a trusted resolution
// from the approved-binding resolver plus a closure-bound HTTP executor — and NEVER
// by re-granting trust to a public factory. Everything that still has a subject is
// retained verbatim: the digest properties, the SQL builders and their read-only
// guard, the whole envelope-MAC battery, the timestamp pins, the async-window
// defensive key copy, and the real-driver count shapes (which now arrive through the
// executor's answer plane instead of a pg summary row).
const { createReadSourceConfigStore, __internals: storeInternals } = require(path.join(__dirname, '..', 'lib', 'read-source-config-store.cjs'))
const { validateReadSourceConfig } = require(path.join(__dirname, '..', 'lib', 'read-source-config.cjs'))
const {
  createApprovedBindingResolver,
  createHarnessSystemIdentityAuthorityForTests,
  createHarnessCanonicalObjectAuthorityForTests,
} = require(path.join(__dirname, '..', 'lib', 'gip-approved-binding-resolver.cjs'))
const {
  createHarnessHttpProbeActionRegistryForTests,
  createHarnessSourceBinderForTests,
  createServerBoundSourceExecutor,
} = require(path.join(__dirname, '..', 'lib', 'gip-server-bound-source-executor.cjs'))

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
// BUILD-ONLY now: the product of this exported factory is trusted by nothing, and
// no probe path resolves a SQL strategy under δ=(c). It is retained deliberately as
// the untrusted seam, and its field hygiene is still asserted below.
const BUILD_ONLY_REGISTRY = createProbeStrategyRegistry([{
  actionProfileVersion: 'fixture.paged_read.v1',
  ...postgresTotalOrderProbeStrategy,
}])

// BASE_INPUTS stays a plain object: it is the material for the PURE digest tests,
// which take a tuple by value and are unaffected by §4 step 1.5.
const BASE_INPUTS = Object.freeze({
  actionProfileVersion: 'fixture.paged_read.v1',
  systemContentKey: 'sck_fixture_1',
  configContentKey: 'cck_fixture_1',
  objectKey: 'fixture_view',
  canonicalObjectVersion: 'material.v1',
})

const FIXTURE_PROFILE = 'fixture.paged_read.v1'

function fixtureConfigBody(objectKey) {
  return {
    version: 1,
    systemId: 'sys-fixture',
    object: objectKey,
    mode: 'list_page',
    requiredKind: 'erp_http',
    operations: ['read'],
    readPath: 'api/fixture',
    readMethod: 'GET',
    containerPaths: ['Data'],
    fieldMap: [{ source: 'ItemNo', target: 'item_no' }, { source: 'Rev', target: 'rev' }],
    orderingKeySpec: [{ fieldId: 'item_no', direction: 'ASC' }, { fieldId: 'rev', direction: 'ASC' }],
    actionProfileVersion: FIXTURE_PROFILE,
  }
}

// A fresh stack per probe, so each test configures its own source behaviour without
// leaking state into the next. The resolution is minted by the REAL resolver over
// the REAL store, so the tuple is never caller-supplied.
async function buildProbe({ answer, onExecute, secretBuffer, objectKey = 'fixture_view' } = {}) {
  const validated = validateReadSourceConfig(fixtureConfigBody(objectKey))
  assert.ok(validated.valid, `fixture must validate: ${JSON.stringify(validated.errors)}`)
  const stored = JSON.parse(JSON.stringify(validated.normalized))
  stored.version = 1
  const row = {
    id: 'cfg-fixture', tenant_id: 't-1', workspace_id: null, system_id: 'sys-fixture',
    object: objectKey, mode: 'list_page', config: stored,
    content_key: storeInternals.contentKeyFor(validated.normalized), version: 1, status: 'approved',
  }
  const db = {
    async selectOne(_t, where) { return Object.keys(where).every((k) => row[k] === where[k]) ? row : null },
    async select() { return [] },
    async insertOne() { return null },
    async updateRow() { return null },
    async transaction(fn) { return fn(this) },
  }
  const resolver = createApprovedBindingResolver({
    configStore: createReadSourceConfigStore({ db }),
    systemIdentityAuthority: createHarnessSystemIdentityAuthorityForTests({ 'sys-fixture': 'sck_fixture_1' }),
    canonicalObjectAuthority: createHarnessCanonicalObjectAuthorityForTests([
      { contractId: objectKey, contractVersion: FIXTURE_PROFILE, canonicalObjectVersion: 'material.v1' },
    ]),
  })
  const resolution = await resolver.resolveApprovedBinding({
    tenantId: 't-1', workspaceId: null, approvedConfigVersionId: 'cfg-fixture',
  })
  const actionRegistry = createHarnessHttpProbeActionRegistryForTests([{
    actionProfileVersion: FIXTURE_PROFILE,
    actionId: 'fixture.connector.total_order_probe',
    actionVersion: 'v1',
    connectorKind: 'erp_http',
    sourceFieldFor(fieldId) {
      const declared = { item_no: 'ItemNo', rev: 'Rev' }
      if (!Object.prototype.hasOwnProperty.call(declared, fieldId)) throw new Error('undeclared')
      return declared[fieldId]
    },
    execute: async () => { throw new Error('the handle executes, not the declaration') },
  }])
  const sourceBinder = createHarnessSourceBinderForTests([{
    systemContentKey: 'sck_fixture_1',
    credentialFactory: () => Object.freeze({
      async execute() {
        if (typeof onExecute === 'function') await onExecute()
        if (typeof answer === 'function') return answer()
        return answer || { duplicateGroupsSampled: 0, nullKeyRowsSampled: 0 }
      },
    }),
  }])
  const executor = createServerBoundSourceExecutor({ actionRegistry, sourceBinder })
  const prober = createBindingQualificationProber({ executor })
  return { prober, resolution, executor, secretBuffer }
}

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
    'PROBE_CALLER_SUPPLIED_EXECUTION_REFUSED',
    'PROBE_EXECUTOR_UNTRUSTED',
    'PROBE_RESOLUTION_UNTRUSTED',
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

// -- 4. Probe: uniqueness pass / duplicate fail-closed (values-free) --
//    RE-POINTED: driven through the resolution-bound entry point and the
//    closure-bound HTTP executor. The strategy-registry injection cases below are
//    replaced by the stronger property they were approximating -- the run input is a
//    CLOSED ALLOWLIST, so a registry/strategy/query is refused under ANY key.
async function probeBehaviour() {
  const ok = await buildProbe()
  const qualification = await ok.prober.probeFromResolution({
    resolution: ok.resolution,
    envelopeKey: ENVELOPE_KEY,
    probedAt: '2026-07-23T00:00:00Z',
    expiresAt: '2026-07-24T00:00:00Z',
  })
  assert.equal(qualification.status, 'candidate')
  assert.equal(qualification.evidence.probeKind, 'ordering_key_total_order_negative')
  assert.equal(qualification.evidence.duplicateGroupsFound, 0)
  assert.equal(qualification.evidence.nullKeyRowsFound, 0)
  assert.equal(qualification.evidence.checkedKeyColumnCount, 2)
  // MOVED, not deleted: the four strategy-identity evidence fields
  // (probeStrategyId / probeStrategyVersion / probeDialect / snapshotSemantics) are
  // gone BY CONSTRUCTION under delta=(c) -- an HTTP action declares no dialect and no
  // snapshot semantics, and decision (epsilon) is unruled. First-party ACTION identity
  // replaces them, and the absence of any guarantee token is asserted as an exact
  // key set so a re-addition reds.
  assert.equal(qualification.evidence.probeTransport, 'http_action')
  assert.equal(qualification.evidence.probeActionId, 'fixture.connector.total_order_probe')
  assert.equal(qualification.evidence.probeActionVersion, 'v1')
  assert.equal(qualification.evidence.probeConnectorKind, 'erp_http')
  assert.deepEqual(Object.keys(qualification.evidence).sort(), [
    'checkedKeyColumnCount', 'duplicateGroupsFound', 'nullKeyRowsFound',
    'probeActionId', 'probeActionVersion', 'probeConnectorKind', 'probeKind',
    'probeTransport', 'probedAt',
  ])
  assert.equal(qualification.envelopeKeyId, 'k2026a')
  assert.ok(typeof qualification.envelopeMac === 'string' && qualification.envelopeMac.length === 64)
  // the secret never appears anywhere in the qualification
  assert.ok(!JSON.stringify(qualification).includes(ENVELOPE_KEY.secret.toString('hex')))

  // duplicates => fail closed, values-free
  const SECRET = 'secret_item_A17'
  const dup = await buildProbe({ answer: () => ({ duplicateGroupsSampled: 3, nullKeyRowsSampled: 0 }) })
  const caught = await rejectsWithAsync(() => dup.prober.probeFromResolution({
    resolution: dup.resolution, envelopeKey: ENVELOPE_KEY, probedAt: '2026-07-23T00:00:00Z',
  }), 'ORDERING_KEY_DUPLICATE_FOUND')
  assert.ok(!JSON.stringify({ m: caught.message, d: caught.details }).includes(SECRET),
    'duplicate-key failure must stay values-free')

  // NULL key components => fail closed (same single answer)
  const nul = await buildProbe({ answer: () => ({ duplicateGroupsSampled: 0, nullKeyRowsSampled: 2 }) })
  await rejectsWithAsync(() => nul.prober.probeFromResolution({
    resolution: nul.resolution, envelopeKey: ENVELOPE_KEY, probedAt: '2026-07-23T00:00:00Z',
  }), 'ORDERING_KEY_NULL_FOUND')

  // no envelope key => fail closed before any probing
  await rejectsWithAsync(() => ok.prober.probeFromResolution({
    resolution: ok.resolution, probedAt: '2026-07-23T00:00:00Z',
  }), 'QUALIFICATION_INPUT_INVALID')

  // EXECUTION IS FACTORY-BOUND (S4 step 1.5). Run input must NOT carry a strategy, a
  // registry, a query or an executor -- under a KNOWN name or a NOVEL one. This is
  // strictly stronger than the two denylist cases it replaces: the gate is an
  // allowlist, so a novel key name is refused too.
  for (const smuggled of [
    { strategyRegistry: { resolve: () => ({ buildTotalOrderProbeSql: () => 'SELECT 1', strategyId: 'EVIL', strategyVersion: 'v', dialect: 'evil', snapshotSemantics: 'marker' }) } },
    { probeStrategy: { dialect: 'evil', snapshotSemantics: 'marker_smuggle', buildTotalOrderProbeSql: () => 'SELECT 1' } },
    { query: async () => ({ rows: [] }) },
    { keyColumns: ['item_no'] },
    { aCompletelyNovelKeyName: { execute: async () => ({}) } },
  ]) {
    await rejectsWithAsync(() => ok.prober.probeFromResolution({
      resolution: ok.resolution, envelopeKey: ENVELOPE_KEY, probedAt: '2026-07-23T00:00:00Z', ...smuggled,
    }), 'PROBE_CALLER_SUPPLIED_EXECUTION_REFUSED')
  }

  // NEGATIVE CONTROL -- trust is OBJECT IDENTITY, not a forgeable public field. The
  // forged-REGISTRY case is retired with the construction it attacked (the prober no
  // longer takes a registry at all); the SAME property is now asserted one layer up,
  // against a forged EXECUTOR carrying every expected public field.
  const forgedExecutor = {
    __gipTrustedExecutor: true,
    executeOrderingKeyProbe: async () => ({
      probeTransport: 'http_action', probeActionId: 'FORGED', probeActionVersion: 'v1',
      probeConnectorKind: 'evil', checkedKeyColumnCount: 1,
      duplicateGroupsSampled: 0, nullKeyRowsSampled: 0,
    }),
  }
  rejectsWith(() => createBindingQualificationProber({ executor: forgedExecutor }), 'PROBE_EXECUTOR_UNTRUSTED')
  // primitives / null are rejected too (WeakSet.has returns false, never throws through)
  rejectsWith(() => createBindingQualificationProber({ executor: null }), 'PROBE_EXECUTOR_UNTRUSTED')
  rejectsWith(() => createBindingQualificationProber({ executor: 'nope' }), 'PROBE_EXECUTOR_UNTRUSTED')
  rejectsWith(() => createBindingQualificationProber(null), 'PROBE_EXECUTOR_UNTRUSTED')
  // ...and a forged RESOLUTION carrying every public field is refused at probe time.
  const forgedResolution = { ...ok.resolution }
  await rejectsWithAsync(() => ok.prober.probeFromResolution({
    resolution: forgedResolution, envelopeKey: ENVELOPE_KEY, probedAt: '2026-07-23T00:00:00Z',
  }), 'PROBE_RESOLUTION_UNTRUSTED')
  // a REAL executor (WeakSet member) yields a working prober -- identity, not property
  assert.equal(typeof createBindingQualificationProber({ executor: ok.executor }).probeFromResolution, 'function')

  // RESIDUAL 1, retired as INEXPRESSIBLE: the frozen prober object's EXACT KEY SET.
  // "probe() absent from the module's exports" would be vacuous -- probe never was
  // a module export.
  assert.deepEqual(Object.keys(ok.prober).sort(), ['probeFromResolution'])
  assert.deepEqual(Object.getOwnPropertySymbols(ok.prober), [])
  assert.equal(ok.prober.probe, undefined)

  // weak keys are refused: string secrets (any length) and short buffers
  for (const secret of ['x', 'server_held_secret_material_1_long_enough_but_text', Buffer.alloc(16, 1)]) {
    await rejectsWithAsync(() => ok.prober.probeFromResolution({
      resolution: ok.resolution, envelopeKey: { keyId: 'k', secret }, probedAt: '2026-07-23T00:00:00Z',
    }), 'QUALIFICATION_INPUT_INVALID')
  }

  // DEFENSIVE KEY COPY is LOAD-BEARING (review P2): the caller mutates its own key
  // Buffer INSIDE the executor callback -- i.e. during the await window BETWEEN the
  // key copy and the MAC computation. Because probe took a defensive copy up front,
  // the MAC binds the ORIGINAL bytes, so verify with the original key succeeds.
  // Without the copy the MAC would bind the mutated bytes (this exact test REDs on
  // removal).
  const original = Buffer.alloc(32, 7)
  const attackerControlled = Buffer.from(original) // the buffer probe receives
  const windowStack = await buildProbe({
    onExecute() { attackerControlled.fill(9) }, // mutate DURING the await, after the copy
  })
  const windowQual = await windowStack.prober.probeFromResolution({
    resolution: windowStack.resolution,
    envelopeKey: { keyId: 'kx', secret: attackerControlled },
    probedAt: '2026-07-23T00:00:00Z',
    expiresAt: '2026-07-24T00:00:00Z',
  })
  const verifiedOriginal = verifyBindingQualification({
    qualification: windowQual, resolution: windowStack.resolution, envelopeKey: { keyId: 'kx', secret: original }, now: '2026-07-23T12:00:00Z',
  })
  assert.equal(verifiedOriginal.verified, true, 'MAC must bind the ORIGINAL key bytes (copy taken before await)')
  // ...and the mutated value must NOT verify (it never was the key)
  rejectsWith(() => verifyBindingQualification({
    qualification: windowQual, resolution: windowStack.resolution, envelopeKey: { keyId: 'kx', secret: Buffer.alloc(32, 9) }, now: '2026-07-23T12:00:00Z',
  }), 'QUALIFICATION_ENVELOPE_MISMATCH')

  // registry field hygiene: control chars / oversize identity strings fail loud.
  // RETAINED against the now BUILD-ONLY factory -- its products are trusted by
  // nothing, but a malformed registration must still fail loud rather than ship
  // control chars into anything.
  assert.throws(() => createProbeStrategyRegistry([{ actionProfileVersion: 'x.y.v1', strategyId: 'a\nb', strategyVersion: 'v1', dialect: 'postgres', snapshotSemantics: 's', buildTotalOrderProbeSql: () => 'SELECT 1' }]))
  assert.throws(() => createProbeStrategyRegistry([{ actionProfileVersion: 'x.y.v1', strategyId: 'z'.repeat(200), strategyVersion: 'v1', dialect: 'postgres', snapshotSemantics: 's', buildTotalOrderProbeSql: () => 'SELECT 1' }]))
  // ...and the V-7 FIX itself: the product of the exported factory is trusted by
  // nothing, because the trust set it used to write into no longer exists.
  assert.ok(BUILD_ONLY_REGISTRY && typeof BUILD_ONLY_REGISTRY.resolve === 'function')
  rejectsWith(() => createBindingQualificationProber({ executor: BUILD_ONLY_REGISTRY }), 'PROBE_EXECUTOR_UNTRUSTED')

  // REAL-DRIVER COUNT SHAPE (review P1): a driver may return int8 counts as STRINGS --
  // a '0'/'0' answer must qualify, not PROBE_QUERY_FAILED.
  const pgShaped = await buildProbe({ answer: () => ({ duplicateGroupsSampled: '0', nullKeyRowsSampled: '0' }) })
  assert.equal((await pgShaped.prober.probeFromResolution({
    resolution: pgShaped.resolution, envelopeKey: ENVELOPE_KEY, probedAt: '2026-07-23T00:00:00Z',
  })).status, 'candidate')
  // ...string counts still trip the fail-closed branches
  const pgDup = await buildProbe({ answer: () => ({ duplicateGroupsSampled: '2', nullKeyRowsSampled: '0' }) })
  await rejectsWithAsync(() => pgDup.prober.probeFromResolution({
    resolution: pgDup.resolution, envelopeKey: ENVELOPE_KEY, probedAt: '2026-07-23T00:00:00Z',
  }), 'ORDERING_KEY_DUPLICATE_FOUND')
  // ...and junk shapes stay rejected ('007', '1e3', negative, non-decimal). The refusal
  // is now the EXECUTOR's answer-plane token, which is the door that sees them first.
  for (const bad of ['007', '1e3', '-1', 'abc']) {
    const junk = await buildProbe({ answer: () => ({ duplicateGroupsSampled: bad, nullKeyRowsSampled: '0' }) })
    let caughtJunk = null
    try {
      await junk.prober.probeFromResolution({
        resolution: junk.resolution, envelopeKey: ENVELOPE_KEY, probedAt: '2026-07-23T00:00:00Z',
      })
    } catch (error) { caughtJunk = error }
    assert.ok(caughtJunk, `junk count ${bad} must fail closed`)
    assert.equal(caughtJunk.reason, 'PROBE_ANSWER_UNVERIFIABLE')
  }
}

// ── 5. Verify: pure-local, digest-bound, expiring, status-gated ──
async function verifyBehaviour() {
  // RE-POINTED (§3.1 L371): verify no longer takes a caller-supplied `expectedInputs`
  // tuple — that parameter was a live counter-construction to "both probe AND verify
  // re-enter through the resolver". The expected tuple is now the RESOLUTION's and
  // nothing else.
  const stack = await buildProbe()
  const RESOLUTION = stack.resolution
  const qualification = await stack.prober.probeFromResolution({
    resolution: RESOLUTION, envelopeKey: ENVELOPE_KEY, probedAt: '2026-07-23T00:00:00Z', expiresAt: '2026-07-24T00:00:00Z',
  })

  const ok = verifyBindingQualification({
    qualification, resolution: RESOLUTION, envelopeKey: ENVELOPE_KEY, now: '2026-07-23T12:00:00Z',
  })
  assert.equal(ok.verified, true)

  // A caller-supplied tuple is no longer honoured on the verify path: the parameter
  // is gone, and a hand-built object carrying every public field of a real
  // resolution is refused BY NAME rather than used.
  rejectsWith(() => verifyBindingQualification({
    qualification, resolution: { ...RESOLUTION }, envelopeKey: ENVELOPE_KEY, now: '2026-07-23T12:00:00Z',
  }), 'PROBE_RESOLUTION_UNTRUSTED')

  // cross-object reuse ⇒ content digest mismatch (input binding is load-bearing).
  // Demonstrated with a SECOND GENUINE resolution rather than by editing a caller
  // tuple — strictly stronger, since the caller tuple no longer exists.
  const otherStack = await buildProbe({ objectKey: 'another_view' })
  const otherQualification = await otherStack.prober.probeFromResolution({
    resolution: otherStack.resolution, envelopeKey: ENVELOPE_KEY, probedAt: '2026-07-23T00:00:00Z',
  })
  assert.notEqual(otherQualification.qualificationDigest, qualification.qualificationDigest,
    'two probes with different evidence must not share a digest')
  rejectsWith(() => verifyBindingQualification({
    qualification, resolution: otherStack.resolution, envelopeKey: ENVELOPE_KEY, now: '2026-07-23T12:00:00Z',
  }), 'QUALIFICATION_DIGEST_MISMATCH')

  // expiry ⇒ fail closed: Run-start proper never probes — fresh Preflight required
  rejectsWith(() => verifyBindingQualification({
    qualification, resolution: RESOLUTION, envelopeKey: ENVELOPE_KEY, now: '2026-07-25T00:00:00Z',
  }), 'QUALIFICATION_EXPIRED')

  // tampered evidence ⇒ envelope holds (content digest unchanged in copy) then
  // content digest mismatch
  const tampered = { ...qualification, evidence: { ...qualification.evidence, duplicateGroupsFound: 1 } }
  rejectsWith(() => verifyBindingQualification({
    qualification: tampered, resolution: RESOLUTION, envelopeKey: ENVELOPE_KEY, now: '2026-07-23T12:00:00Z',
  }), 'QUALIFICATION_DIGEST_MISMATCH')

  // status gate: only 'candidate' verifiable
  rejectsWith(() => verifyBindingQualification({
    qualification: { ...qualification, status: 'revoked' }, resolution: RESOLUTION, envelopeKey: ENVELOPE_KEY, now: '2026-07-23T12:00:00Z',
  }), 'QUALIFICATION_STATUS_INVALID')

  // ── LIFECYCLE AUTHENTICATION (review P1: keyed MAC, not a public checksum) ──
  // (a) postponed copy WITHOUT recompute ⇒ envelope mismatch
  rejectsWith(() => verifyBindingQualification({
    qualification: { ...qualification, expiresAt: '2027-01-01T00:00:00Z' }, resolution: RESOLUTION, envelopeKey: ENVELOPE_KEY, now: '2026-07-25T00:00:00Z',
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
    qualification: forged, resolution: RESOLUTION, envelopeKey: ENVELOPE_KEY, now: '2026-07-25T00:00:00Z',
  }), 'QUALIFICATION_ENVELOPE_MISMATCH')
  // (c) keyId mismatch ⇒ fail closed (rotation selects keys; unknown key never verifies)
  rejectsWith(() => verifyBindingQualification({
    qualification: { ...qualification, envelopeKeyId: 'k2020x' }, resolution: RESOLUTION, envelopeKey: ENVELOPE_KEY, now: '2026-07-23T12:00:00Z',
  }), 'QUALIFICATION_ENVELOPE_MISMATCH')

  // malformed MAC (64 chars but non-hex) stays INSIDE the frozen vocabulary —
  // never ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH (review P2)
  rejectsWith(() => verifyBindingQualification({
    qualification: { ...qualification, envelopeMac: 'z'.repeat(64) }, resolution: RESOLUTION, envelopeKey: ENVELOPE_KEY, now: '2026-07-23T12:00:00Z',
  }), 'QUALIFICATION_ENVELOPE_MISMATCH')
  rejectsWith(() => verifyBindingQualification({
    qualification: { ...qualification, envelopeMac: 'abc' }, resolution: RESOLUTION, envelopeKey: ENVELOPE_KEY, now: '2026-07-23T12:00:00Z',
  }), 'QUALIFICATION_ENVELOPE_MISMATCH')

  // a COPY with malformed expiresAt is a lifecycle tamper — envelope catches it
  rejectsWith(() => verifyBindingQualification({
    qualification: { ...qualification, expiresAt: 'tomorrow' }, resolution: RESOLUTION, envelopeKey: ENVELOPE_KEY, now: '2026-07-23T12:00:00Z',
  }), 'QUALIFICATION_ENVELOPE_MISMATCH')

  // TIMESTAMP PIN — non-ISO `now` fails CLOSED
  rejectsWith(() => verifyBindingQualification({
    qualification, resolution: RESOLUTION, envelopeKey: ENVELOPE_KEY, now: '07/25/2026',
  }), 'QUALIFICATION_INPUT_INVALID')
  // probe-side pin: malformed probedAt fails closed at generation time
  await rejectsWithAsync(() => stack.prober.probeFromResolution({
    resolution: RESOLUTION, envelopeKey: ENVELOPE_KEY, probedAt: 'not-a-time',
  }), 'QUALIFICATION_INPUT_INVALID')

  // digest material domain (shared codec): undefined / NaN / Date all fail closed
  rejectsWith(() => computeQualificationDigest({ ...BASE_INPUTS, evidence: { a: undefined } }), 'QUALIFICATION_INPUT_INVALID')
  rejectsWith(() => computeQualificationDigest({ ...BASE_INPUTS, evidence: { a: NaN } }), 'QUALIFICATION_INPUT_INVALID')
  rejectsWith(() => computeQualificationDigest({ ...BASE_INPUTS, evidence: { a: new Date(0) } }), 'QUALIFICATION_INPUT_INVALID')

  // impossible calendar dates are rejected even though Date.parse normalizes them
  rejectsWith(() => verifyBindingQualification({
    qualification, resolution: RESOLUTION, envelopeKey: ENVELOPE_KEY, now: '2026-02-30T00:00:00Z',
  }), 'QUALIFICATION_INPUT_INVALID')

  // PURE-LOCAL invariant: verify takes no query fn — source-level pin
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'gip-binding-qualification-spike.cjs'), 'utf8')
  const verifyBody = src.slice(src.indexOf('function verifyBindingQualification'), src.indexOf('module.exports'))
  assert.ok(!/\bquery\b/.test(verifyBody) && !/\bawait\b/.test(verifyBody),
    'verifyBindingQualification must stay pure-local (no query fn, no await)')

  // WIRING pin, RE-POINTED for S4 step 1.5. `runReadOnlyProbe` and
  // `probeWithTrustedRegistry` are DELETED, so the old pins have no subject. The
  // property that replaced them is stronger: the probe path takes no query fn at
  // all, and every tuple field comes from the resolution.
  assert.ok(!src.includes('async function runReadOnlyProbe'),
    'the SQL execution path must be removed, not privatised')
  assert.ok(!src.includes('async function probeWithTrustedRegistry'),
    'the caller-supplied-tuple probe must be removed')
  const probeStart = src.indexOf('async function probeFromTrustedResolution')
  assert.ok(probeStart > 0, 'the resolution-bound probe path must exist')
  const probeBody = src.slice(probeStart, src.indexOf('function verifyBindingQualification'))
  assert.ok(!/input\.query/.test(probeBody), 'the probe path must never take a caller query fn')
  assert.ok(!/input\.keyColumns/.test(probeBody), 'the probe path must never take caller keyColumns')
  assert.ok(/resolution\.systemContentKey/.test(probeBody), 'the digest must bind the RESOLUTION tuple')
  assert.ok(/isTrustedBindingResolution\(/.test(probeBody), 'the probe path must gate on resolution identity')
  // POSITIVE CONTROL for these source scans: they must be shown to FIND a token when
  // it is present, otherwise every "absent" assertion above is grepping nothing.
  assert.ok(`${src}\nasync function runReadOnlyProbe`.includes('async function runReadOnlyProbe'))
}

// ---------------------------------------------------------------------------
// P2-C (B1a-3 round 3) · `createProbeStrategyRegistry` iterates a CALLER array by
// INDEX, not `for...of`.
//
// `for...of` over caller data hands control to an attacker-reachable
// `Symbol.iterator` mid-loop — the same channel the slice's two new modules already
// close by index-based iteration. The factory is BUILD-ONLY and reaches no probe
// path, so this is hardening, not a live hole; it is fixed because the channel is
// the same one and leaving one instance open invites the next reader to copy it.
//
// NOT IN SCOPE: `buildOrderingKeyDuplicateProbeSql` and the other SQL builders are
// byte-identical to `main` and belong to the landed bounded-read line. They are not
// touched here.
// ---------------------------------------------------------------------------
function callerArrayIteratorIsNeverHandedControl() {
  const ITERATOR_CANARY = 'ITERATOR-CANARY-P2C'
  const entries = [{
    actionProfileVersion: 'x.y.v1',
    strategyId: 'gip.total_order_probe.fixture',
    strategyVersion: 'v1',
    dialect: 'postgres',
    snapshotSemantics: 'single_statement_mvcc',
    buildTotalOrderProbeSql: () => 'SELECT 1',
  }]
  let iteratorCalls = 0
  Object.defineProperty(entries, Symbol.iterator, {
    configurable: true,
    value() { iteratorCalls += 1; throw new Error(ITERATOR_CANARY) },
  })

  // The build succeeds, and the poisoned iterator is NEVER invoked.
  const registry = createProbeStrategyRegistry(entries)
  assert.equal(iteratorCalls, 0, 'the caller array\'s Symbol.iterator must never be handed control')
  assert.equal(registry.resolve('x.y.v1').strategyId, 'gip.total_order_probe.fixture')

  // POSITIVE CONTROL for the poison itself: it must be shown to FIRE under `for...of`,
  // otherwise `iteratorCalls === 0` above proves nothing about the loop shape.
  let control = null
  try { for (const _entry of entries) { void _entry } } catch (error) { control = error }
  assert.ok(control instanceof Error)
  assert.equal(control.message, ITERATOR_CANARY)
  assert.equal(iteratorCalls, 1, 'the poisoned iterator must be demonstrably live')
}

async function main() {
  frozenVocabulary()
  digestProperties()
  probeSqlReadOnly()
  await probeBehaviour()
  await verifyBehaviour()
  callerArrayIteratorIsNeverHandedControl()
  console.log('gip-binding-qualification-spike.test.cjs OK')
}

main().catch((error) => {
  console.error('gip-binding-qualification-spike.test.cjs FAILED')
  console.error(error)
  process.exit(1)
})
