'use strict'

// GIP B1a-3 — §4 step 1.4 (server-bound source executor, δ=(c) HTTP-only) and
// §4 step 1.5 (retirement of the legacy caller-supplied-tuple `probe()`), together
// with the approved-binding resolver that produces their input.
//
// The FOUR controls this slice actually turns on are marked:
//   [R1] residual 1 — retired as INEXPRESSIBLE, pinned by the EXACT KEY SET of the
//        frozen prober object (NOT "absent from module exports", which passes on the
//        unfixed head and is vacuous).
//   [R2] residual 2 — a NAMED closed refusal, asserted by token EQUALITY.
//   [B1] the control that actually carries B-1 — two resolutions bound to DIFFERENT
//        systems must NOT both qualify from a single executor answer.
//   [PC] the positive control — a probe executed THROUGH the executor against the
//        harness source still qualifies.
//
// Hermetic. No database, no network, no route, no flag.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const storeModule = require(path.join(LIB, 'read-source-config-store.cjs'))
const resolverModule = require(path.join(LIB, 'gip-approved-binding-resolver.cjs'))
const executorModule = require(path.join(LIB, 'gip-server-bound-source-executor.cjs'))
const spikeModule = require(path.join(LIB, 'gip-binding-qualification-spike.cjs'))
const { validateReadSourceConfig } = require(path.join(LIB, 'read-source-config.cjs'))

const { createReadSourceConfigStore, __internals: { contentKeyFor } } = storeModule
const {
  GipApprovedBindingResolverError,
  RESOLUTION_KEYS,
  createApprovedBindingResolver,
  createHarnessSystemIdentityAuthorityForTests,
  createHarnessCanonicalObjectAuthorityForTests,
  isTrustedBindingResolution,
} = resolverModule
const {
  GipSourceExecutorError,
  SOURCE_EXECUTOR_ERROR_REASONS,
  HTTP_PROBE_ACTION_DECLARATION_KEYS,
  CERTIFIED_HTTP_PROBE_ACTION_REGISTRY,
  createHttpProbeActionRegistry,
  createHarnessHttpProbeActionRegistryForTests,
  createHarnessSourceBinderForTests,
  createServerBoundSourceExecutor,
} = executorModule
const {
  GipQualificationError,
  QUALIFICATION_ERROR_REASONS,
  createBindingQualificationProber,
  verifyBindingQualification,
} = spikeModule

const ENVELOPE_KEY = Object.freeze({ keyId: 'k2026b', secret: Buffer.alloc(32, 5) })
const PROBED_AT = '2026-07-26T00:00:00Z'
const SECRET_CANARY = 'CONNECTION-SECRET-CANARY-6f23e39f'
const ATTACKER_TEXT = 'ATTACKER-CANARY-6f23e39f'

// Token EQUALITY, never `includes` — two tokens minted at the same fail() call site
// can otherwise cover for each other.
function refusesWith(fn, ErrorClass, expectedReason) {
  let caught = null
  try { fn() } catch (error) { caught = error }
  assert.ok(caught instanceof ErrorClass, `expected ${ErrorClass.name}, got ${caught && caught.name}: ${caught && caught.message}`)
  assert.equal(caught.reason, expectedReason)
  return caught
}

async function refusesWithAsync(fn, ErrorClass, expectedReason) {
  let caught = null
  try { await fn() } catch (error) { caught = error }
  assert.ok(caught instanceof ErrorClass, `expected ${ErrorClass.name}, got ${caught && caught.name}: ${caught && caught.message}`)
  assert.equal(caught.reason, expectedReason)
  return caught
}

function keySet(object) { return Object.keys(object).sort() }

// --- fixtures ---------------------------------------------------------------
// RAC-24: the resolver is driven through the REAL read projection. The config
// objects the resolver sees come out of the REAL `createReadSourceConfigStore` and
// its REAL `rowToPublicReadSourceConfig` — null-prototype, sanitized — not a
// hand-built plain-object double, which is the shape that let the lossy-read
// problem survive undetected before.

function configBody({ systemId, objectKey, actionProfileVersion, fieldCount = 3 }) {
  const fieldMap = []
  for (let i = 1; i <= fieldCount; i += 1) fieldMap.push({ source: `Src${i}`, target: `tgt_${i}` })
  return {
    version: 1,
    systemId,
    object: objectKey,
    mode: 'list_page',
    requiredKind: 'erp_http',
    operations: ['read'],
    readPath: 'api/objects',
    readMethod: 'GET',
    containerPaths: ['Data'],
    fieldMap,
    orderingKeySpec: [{ fieldId: 'tgt_1', direction: 'ASC' }, { fieldId: 'tgt_2', direction: 'DESC' }],
    actionProfileVersion,
  }
}

function approvedRow(id, spec) {
  const validated = validateReadSourceConfig(configBody(spec))
  assert.ok(validated.valid, `fixture config must validate: ${JSON.stringify(validated.errors)}`)
  const stored = JSON.parse(JSON.stringify(validated.normalized))
  stored.version = 1
  return {
    id,
    tenant_id: 't-1',
    workspace_id: null,
    system_id: spec.systemId,
    object: spec.objectKey,
    mode: 'list_page',
    config: stored,
    content_key: contentKeyFor(validated.normalized),
    version: 1,
    status: 'approved',
  }
}

function fakeDb(rows) {
  return {
    async selectOne(_table, where) {
      return rows.find((row) => Object.keys(where).every((key) => row[key] === where[key])) || null
    },
    async select() { return [] },
    async insertOne() { return null },
    async updateRow() { return null },
    async transaction(fn) { return fn(this) },
  }
}

// A harness "source": a connector-owned credential factory that consumes the secret
// INSIDE its own boundary and returns an execution CLOSURE. (α): the executor never
// holds, sees or hashes the authentication secret.
function harnessSource({ duplicateGroups = 0, nullRows = 0, onExecute } = {}) {
  const log = { calls: 0, lastRequest: null }
  const credentialFactory = () => {
    // `secret` lives ONLY in this closure. It is never a property of the returned
    // handle, so it is unreachable by enumerable traversal from the executor.
    const secret = SECRET_CANARY
    return Object.freeze({
      async execute(request) {
        log.calls += 1
        log.lastRequest = request
        if (typeof onExecute === 'function') await onExecute(request)
        assert.equal(typeof secret, 'string') // the closure really does hold it
        return { duplicateGroupsSampled: duplicateGroups, nullKeyRowsSampled: nullRows }
      },
    })
  }
  return { credentialFactory, log }
}

const ACTION_PROFILE = 'fixture.http_read.v1'
const OTHER_PROFILE = 'fixture.http_read.v2'

function harnessAction(overrides = {}) {
  return {
    actionProfileVersion: ACTION_PROFILE,
    actionId: 'fixture.connector.total_order_probe',
    actionVersion: 'v1',
    connectorKind: 'erp_http',
    // CERTIFIED, CONNECTOR-OWNED translation. Only declared fieldIds resolve; there
    // is no raw passthrough.
    sourceFieldFor(fieldId) {
      const declared = { tgt_1: 'ItemNo', tgt_2: 'Revision' }
      if (!Object.prototype.hasOwnProperty.call(declared, fieldId)) {
        throw new Error('undeclared field')
      }
      return declared[fieldId]
    },
    execute: undefined, // replaced below — kept here so the key set stays closed
    ...overrides,
  }
}

// Builds the whole stack. Returns the pieces each control needs.
function buildStack({ actionOverrides = {}, sources } = {}) {
  const rows = [
    approvedRow('cfg-alpha', { systemId: 'sys-alpha', objectKey: 'material_master', actionProfileVersion: ACTION_PROFILE }),
    approvedRow('cfg-beta', { systemId: 'sys-beta', objectKey: 'material_master', actionProfileVersion: ACTION_PROFILE }),
  ]
  const store = createReadSourceConfigStore({ db: fakeDb(rows) })
  const identityAuthority = createHarnessSystemIdentityAuthorityForTests({
    'sys-alpha': 'SCK-ALPHA-DISTINGUISHABLE',
    'sys-beta': 'SCK-BETA-DISTINGUISHABLE',
  })
  const objectAuthority = createHarnessCanonicalObjectAuthorityForTests([
    { contractId: 'material_master', contractVersion: ACTION_PROFILE, canonicalObjectVersion: 'com.acme.material/7' },
    { contractId: 'material_master', contractVersion: OTHER_PROFILE, canonicalObjectVersion: 'com.acme.material/9' },
  ])
  const resolver = createApprovedBindingResolver({
    configStore: store,
    systemIdentityAuthority: identityAuthority,
    canonicalObjectAuthority: objectAuthority,
  })

  const alpha = sources ? sources.alpha : harnessSource()
  const beta = sources ? sources.beta : harnessSource()
  const declaration = harnessAction(actionOverrides)
  // The action's `execute` is not used by the executor — the HANDLE executes. The
  // declaration key set is closed, so `execute` must be present and a function.
  declaration.execute = async () => { throw new Error('the handle executes, not the declaration') }
  const actionRegistry = createHarnessHttpProbeActionRegistryForTests([declaration])
  const sourceBinder = createHarnessSourceBinderForTests([
    { systemContentKey: 'SCK-ALPHA-DISTINGUISHABLE', credentialFactory: alpha.credentialFactory },
    { systemContentKey: 'SCK-BETA-DISTINGUISHABLE', credentialFactory: beta.credentialFactory },
  ])
  const executor = createServerBoundSourceExecutor({ actionRegistry, sourceBinder })
  const prober = createBindingQualificationProber({ executor })
  return { store, resolver, executor, prober, alpha, beta, actionRegistry, sourceBinder, rows }
}

async function resolveAlpha(resolver) {
  return resolver.resolveApprovedBinding({ tenantId: 't-1', workspaceId: null, approvedConfigVersionId: 'cfg-alpha' })
}
async function resolveBeta(resolver) {
  return resolver.resolveApprovedBinding({ tenantId: 't-1', workspaceId: null, approvedConfigVersionId: 'cfg-beta' })
}

// ---------------------------------------------------------------------------
// [PC] POSITIVE CONTROL — a probe executed THROUGH the server-bound executor
//      against the harness source still qualifies.
//      Without this, an all-refusing implementation passes every item below.
// ---------------------------------------------------------------------------
async function positiveControlThroughExecutor() {
  const stack = buildStack()
  const resolution = await resolveAlpha(stack.resolver)

  assert.ok(isTrustedBindingResolution(resolution))
  assert.deepEqual(keySet(resolution), [...RESOLUTION_KEYS].sort())
  assert.equal(resolution.systemContentKey, 'SCK-ALPHA-DISTINGUISHABLE')
  assert.equal(resolution.canonicalObjectVersion, 'com.acme.material/7')

  const qualification = await stack.prober.probeFromResolution({
    resolution,
    envelopeKey: ENVELOPE_KEY,
    probedAt: PROBED_AT,
    expiresAt: '2026-07-27T00:00:00Z',
  })
  assert.equal(qualification.status, 'candidate')
  assert.equal(qualification.evidence.probeTransport, 'http_action')
  assert.equal(qualification.evidence.probeActionId, 'fixture.connector.total_order_probe')
  assert.equal(qualification.evidence.probeConnectorKind, 'erp_http')
  assert.equal(qualification.evidence.checkedKeyColumnCount, 2)
  assert.equal(qualification.evidence.duplicateGroupsFound, 0)
  assert.equal(qualification.evidence.nullKeyRowsFound, 0)
  assert.equal(typeof qualification.envelopeMac, 'string')
  assert.equal(qualification.envelopeMac.length, 64)
  assert.equal(stack.alpha.log.calls, 1)

  // The probed FIELD SET derives from the RESOLUTION and is translated through the
  // action's certified declaration — never raw fieldIds.
  assert.deepEqual(
    stack.alpha.log.lastRequest.orderingKeyAddressing.map((entry) => entry.address),
    ['ItemNo', 'Revision'],
  )
  assert.deepEqual(
    stack.alpha.log.lastRequest.orderingKeyAddressing.map((entry) => entry.direction),
    ['ASC', 'DESC'],
  )
  assert.equal(stack.alpha.log.lastRequest.objectKey, 'material_master')

  // AC-21 BY CONSTRUCTION: nothing B1a-3 ships carries a dialect / snapshot /
  // isolation / read-only guarantee token. Asserted as an EXACT KEY SET, so adding
  // one reds rather than being ignored.
  assert.deepEqual(keySet(qualification.evidence), [
    'checkedKeyColumnCount', 'duplicateGroupsFound', 'nullKeyRowsFound',
    'probeActionId', 'probeActionVersion', 'probeConnectorKind', 'probeKind',
    'probeTransport', 'probedAt',
  ])
  assert.equal(qualification.evidence.snapshotSemantics, undefined)
  assert.equal(qualification.evidence.probeDialect, undefined)

  // AC-7 / RAC-20: verify re-enters through the RESOLUTION, not a caller tuple.
  const verified = verifyBindingQualification({
    qualification, resolution, envelopeKey: ENVELOPE_KEY, now: '2026-07-26T12:00:00Z',
  })
  assert.equal(verified.verified, true)
  assert.equal(verified.qualificationDigest, qualification.qualificationDigest)
}

// ---------------------------------------------------------------------------
// [R1] Residual 1 — RETIRED AS INEXPRESSIBLE, pinned by EXACT KEY SET.
//
// The ratified text is explicit that "`probe()` absent from the module's exports"
// is VACUOUS: `probe` was never a module export, it was a method on the frozen
// object `createBindingQualificationProber` returns. So the pin is SET EQUALITY on
// THAT object, which reds on a re-addition under ANY name.
// ---------------------------------------------------------------------------
async function residual1InexpressibleByExactKeySet() {
  const stack = buildStack()

  // SET EQUALITY, not containment, not a denylist of known names.
  assert.deepEqual(keySet(stack.prober), ['probeFromResolution'])
  assert.equal(Object.getOwnPropertyNames(stack.prober).length, 1)
  // Symbol-keyed re-additions are covered too.
  assert.deepEqual(Object.getOwnPropertySymbols(stack.prober), [])
  assert.ok(Object.isFrozen(stack.prober))
  assert.equal(typeof stack.prober.probeFromResolution, 'function')

  // The retired construction is now a MISSING METHOD — inexpressible, not detected.
  // (B-1 explicitly rejects "keep probe() and add a check", which is detection.)
  assert.equal(stack.prober.probe, undefined)
  assert.equal(stack.prober.legacyProbe, undefined)

  // …and the module no longer offers any other door onto a caller-supplied tuple.
  assert.equal(spikeModule.probe, undefined)
  assert.equal(spikeModule.probeWithTrustedRegistry, undefined)
  assert.equal(spikeModule.__internals.probeWithTrustedRegistry, undefined)
  // The SQL EXECUTION path is gone (the builders remain, on no probe path).
  assert.equal(spikeModule.__internals.runReadOnlyProbe, undefined)
}

// ---------------------------------------------------------------------------
// [R2] Residual 2 — a caller-supplied query / handle / statement / executor is
//      refused with a NAMED closed reason, under ANY input key.
// ---------------------------------------------------------------------------
async function residual2NamedClosedRefusal() {
  const stack = buildStack()
  const resolution = await resolveAlpha(stack.resolver)
  const legal = { resolution, envelopeKey: ENVELOPE_KEY, probedAt: PROBED_AT }

  const smuggled = [
    // the names the shipped code knew about…
    { query: async () => ({ rows: [] }) },
    { probeStrategy: { buildTotalOrderProbeSql: () => 'SELECT 1' } },
    { strategyRegistry: { resolve: () => ({}) } },
    // …a NOVEL key name, which is what an allowlist catches and a denylist does not…
    { totallyNovelExecutorKey: { execute: async () => ({}) } },
    { connection: { query: async () => ({}) } },
    { statement: 'SELECT 1' },
    // …and the six tuple fields, which may never be caller-supplied.
    { actionProfileVersion: 'attacker.v1' },
    { systemContentKey: 'SCK-BETA-DISTINGUISHABLE' },
    { configContentKey: 'cck-forged' },
    { objectKey: 'other_object' },
    { canonicalObjectVersion: 'com.acme.material/9' },
    { orderingKeySpec: [{ fieldId: 'tgt_1', direction: 'ASC' }] },
  ]
  for (const extra of smuggled) {
    await refusesWithAsync(
      () => stack.prober.probeFromResolution({ ...legal, ...extra }),
      GipQualificationError,
      'PROBE_CALLER_SUPPLIED_EXECUTION_REFUSED',
    )
  }

  // Symbol-keyed executor.
  const symbolKeyed = { ...legal }
  symbolKeyed[Symbol('executor')] = { execute: async () => ({}) }
  await refusesWithAsync(
    () => stack.prober.probeFromResolution(symbolKeyed),
    GipQualificationError,
    'PROBE_CALLER_SUPPLIED_EXECUTION_REFUSED',
  )

  // Trust is object identity: a duck-typed resolution carrying EVERY expected public
  // field and a plausible brand is refused BY NAME.
  const duckTyped = { ...resolution, __gipTrustedResolution: true }
  await refusesWithAsync(
    () => stack.prober.probeFromResolution({ ...legal, resolution: duckTyped }),
    GipQualificationError,
    'PROBE_RESOLUTION_UNTRUSTED',
  )
  // …and so is a duck-typed EXECUTOR at construction time.
  refusesWith(
    () => createBindingQualificationProber({ executor: { executeOrderingKeyProbe: async () => ({}) } }),
    GipQualificationError,
    'PROBE_EXECUTOR_UNTRUSTED',
  )
  refusesWith(() => createBindingQualificationProber({ executor: null }), GipQualificationError, 'PROBE_EXECUTOR_UNTRUSTED')
  refusesWith(() => createBindingQualificationProber({ executor: 'nope' }), GipQualificationError, 'PROBE_EXECUTOR_UNTRUSTED')

  // POSITIVE CONTROL for this group — the legal input set still probes, so
  // "refuse everything" does not pass.
  const ok = await stack.prober.probeFromResolution(legal)
  assert.equal(ok.status, 'candidate')
}

// ---------------------------------------------------------------------------
// [B1] THE control that actually carries B-1 — two resolutions bound to DIFFERENT
//      systems must NOT both qualify from a single executor answer.
//
//      The handle demonstrably derives from EACH RESOLUTION'S OWN system record.
//      MUTATION that must RED: derive the handle from a process-level/default
//      source instead of from the resolution — then BETA's probe is served ALPHA's
//      answer, BETA qualifies, and beta.log.calls stays 0. Both halves are asserted,
//      so the mutation cannot be masked by the counts alone.
// ---------------------------------------------------------------------------
async function crossSystemAnswersDoNotTransfer() {
  const alpha = harnessSource({ duplicateGroups: 0 })
  // BETA'S OWN SOURCE reports a duplicate group, so BETA must NOT qualify.
  const beta = harnessSource({ duplicateGroups: 1 })
  const stack = buildStack({ sources: { alpha, beta } })

  const resolutionA = await resolveAlpha(stack.resolver)
  const resolutionB = await resolveBeta(stack.resolver)
  assert.notEqual(resolutionA.systemContentKey, resolutionB.systemContentKey)
  assert.notEqual(resolutionA.configContentKey, resolutionB.configContentKey)

  // A qualifies against ITS OWN source.
  const qualificationA = await stack.prober.probeFromResolution({
    resolution: resolutionA, envelopeKey: ENVELOPE_KEY, probedAt: PROBED_AT,
  })
  assert.equal(qualificationA.status, 'candidate')

  // B does NOT — because B's handle came from B's system record, not from A's
  // answer and not from a process default.
  await refusesWithAsync(
    () => stack.prober.probeFromResolution({ resolution: resolutionB, envelopeKey: ENVELOPE_KEY, probedAt: PROBED_AT }),
    GipQualificationError,
    'ORDERING_KEY_DUPLICATE_FOUND',
  )

  // Each source was consulted exactly once, by its OWN resolution. Under the
  // default-source mutation beta.log.calls is 0 and alpha.log.calls is 2.
  assert.equal(alpha.log.calls, 1, 'alpha source must be consulted exactly once, by resolution A')
  assert.equal(beta.log.calls, 1, 'beta source must be consulted exactly once, by resolution B')

  // A resolution whose system has NO bound handle fails closed by NAME rather than
  // falling back to any other source.
  const orphanBinder = createHarnessSourceBinderForTests([
    { systemContentKey: 'SCK-SOMETHING-ELSE', credentialFactory: harnessSource().credentialFactory },
  ])
  const orphanExecutor = createServerBoundSourceExecutor({
    actionRegistry: stack.actionRegistry, sourceBinder: orphanBinder,
  })
  await refusesWithAsync(
    () => orphanExecutor.executeOrderingKeyProbe(resolutionA),
    GipSourceExecutorError,
    'PROBE_SOURCE_HANDLE_UNAVAILABLE',
  )

  // And the two qualifications are not interchangeable: A's qualification does not
  // verify against B's resolution.
  refusesWith(
    () => verifyBindingQualification({
      qualification: qualificationA, resolution: resolutionB, envelopeKey: ENVELOPE_KEY, now: '2026-07-26T12:00:00Z',
    }),
    GipQualificationError,
    'QUALIFICATION_DIGEST_MISMATCH',
  )
}

// ---------------------------------------------------------------------------
// Build/trust split on the HTTP probe-action registry (the V-7 class, relocated to
// the surface that is actually live under δ=(c)).
// ---------------------------------------------------------------------------
async function buildIsSplitFromTrust() {
  const stack = buildStack()

  // The EXPORTED factory is BUILD-ONLY: calling it, from anywhere, confers NOTHING.
  // It is retained deliberately as the untrusted test seam.
  const untrusted = createHttpProbeActionRegistry([harnessAction({ execute: async () => ({}) })])
  assert.equal(untrusted.size(), 1)
  assert.ok(untrusted.resolve(ACTION_PROFILE), 'the build-only registry still BUILDS')
  refusesWith(
    () => createServerBoundSourceExecutor({ actionRegistry: untrusted, sourceBinder: stack.sourceBinder }),
    GipSourceExecutorError,
    'PROBE_ACTION_REGISTRY_UNTRUSTED',
  )
  // A duck-typed registry carrying a plausible brand and a working resolve() is
  // refused too — trust is WeakSet membership, never a public property.
  refusesWith(
    () => createServerBoundSourceExecutor({
      actionRegistry: { __gipTrustedRegistry: true, size: () => 1, resolve: () => harnessAction({ execute: async () => ({}) }) },
      sourceBinder: stack.sourceBinder,
    }),
    GipSourceExecutorError,
    'PROBE_ACTION_REGISTRY_UNTRUSTED',
  )
  // The trust GRANTER is exported nowhere — not at top level, not under __internals.
  assert.equal(executorModule.buildTrustedHttpProbeActionRegistry, undefined)
  assert.equal(executorModule.__internals.buildTrustedHttpProbeActionRegistry, undefined)
  // Likewise for the resolver's granter.
  assert.equal(resolverModule.buildTrustedBindingResolution, undefined)
  assert.equal(resolverModule.__internals.buildTrustedBindingResolution, undefined)

  // A duck-typed source binder is refused as well.
  refusesWith(
    () => createServerBoundSourceExecutor({
      actionRegistry: stack.actionRegistry, sourceBinder: { handleFor: () => ({ execute: async () => ({}) }) },
    }),
    GipSourceExecutorError,
    'EXECUTOR_COMPONENTS_INVALID',
  )

  // The certified registry SHIPS EMPTY (⟲OD2 — an inventory TOOL is not an
  // inventory RESULT), so a real profile fails closed BY NAME.
  assert.equal(CERTIFIED_HTTP_PROBE_ACTION_REGISTRY.size(), 0)
  const emptyExecutor = createServerBoundSourceExecutor({
    actionRegistry: CERTIFIED_HTTP_PROBE_ACTION_REGISTRY, sourceBinder: stack.sourceBinder,
  })
  const resolution = await resolveAlpha(stack.resolver)
  await refusesWithAsync(
    () => emptyExecutor.executeOrderingKeyProbe(resolution),
    GipSourceExecutorError,
    'PROBE_ACTION_UNBOUND',
  )

  // POSITIVE CONTROL — an internally-registered action still executes. Without
  // this, deleting the registry passes.
  const qualification = await stack.prober.probeFromResolution({
    resolution, envelopeKey: ENVELOPE_KEY, probedAt: PROBED_AT,
  })
  assert.equal(qualification.status, 'candidate')
}

// ---------------------------------------------------------------------------
// The declaration surface carries NO guarantee token (Q2 / (ε) is UNRULED and this
// is the minimum claim), and translation is certified — guessing is inexpressible.
// ---------------------------------------------------------------------------
async function declarationAndTranslation() {
  assert.deepEqual([...HTTP_PROBE_ACTION_DECLARATION_KEYS], [
    'actionProfileVersion', 'actionId', 'actionVersion', 'connectorKind', 'sourceFieldFor', 'execute',
  ])
  // No `dialect`, no `snapshotSemantics` — and they cannot ride in, because the
  // declaration key set is CLOSED.
  for (const smuggled of ['dialect', 'snapshotSemantics', 'isolation', 'readOnly', 'guarantee']) {
    refusesWith(
      () => createHttpProbeActionRegistry([harnessAction({ execute: async () => ({}), [smuggled]: 'claimed' })]),
      GipSourceExecutorError,
      'PROBE_ACTION_DECLARATION_INVALID',
    )
  }
  // P2-D (B1a-3 round 3): the SAME smuggled claims, SYMBOL-KEYED. Until this round
  // `assertClosedKeySet` in the executor read `Object.keys` only, so every one of
  // these was ACCEPTED while its string-keyed twin above was refused — the header's
  // "an exact-key-set pin" was not true of the code. The resolver's version has
  // checked `getOwnPropertySymbols` since it landed; this is the parity fix.
  for (const smuggled of ['dialect', 'snapshotSemantics', 'isolation', 'readOnly', 'guarantee']) {
    const declaration = harnessAction({ execute: async () => ({}) })
    declaration[Symbol(smuggled)] = 'claimed'
    refusesWith(
      () => createHttpProbeActionRegistry([declaration]),
      GipSourceExecutorError,
      'PROBE_ACTION_DECLARATION_INVALID',
    )
  }
  // The same parity holds on the OTHER two call sites of `assertClosedKeySet`: the
  // executor's own components, and the foreign connector's ANSWER.
  {
    const registry = createHarnessHttpProbeActionRegistryForTests([harnessAction({ execute: async () => ({}) })])
    const binder = createHarnessSourceBinderForTests([{
      systemContentKey: 'SCK-ALPHA-DISTINGUISHABLE',
      credentialFactory: () => Object.freeze({ async execute() { return {} } }),
    }])
    const components = { actionRegistry: registry, sourceBinder: binder }
    components[Symbol('query')] = () => {}
    refusesWith(
      () => createServerBoundSourceExecutor(components),
      GipSourceExecutorError,
      'EXECUTOR_COMPONENTS_INVALID',
    )
  }
  {
    const symbolAnswer = { duplicateGroupsSampled: 0, nullKeyRowsSampled: 0 }
    symbolAnswer[Symbol('snapshotSemantics')] = 'single_statement_mvcc'
    const symbolSource = {
      log: { calls: 0 },
      credentialFactory: () => Object.freeze({ async execute() { return symbolAnswer } }),
    }
    const symbolStack = buildStack({ sources: { alpha: symbolSource, beta: harnessSource() } })
    const symbolResolution = await resolveAlpha(symbolStack.resolver)
    await refusesWithAsync(
      () => symbolStack.prober.probeFromResolution({
        resolution: symbolResolution, envelopeKey: ENVELOPE_KEY, probedAt: PROBED_AT,
      }),
      GipSourceExecutorError,
      'PROBE_ANSWER_UNVERIFIABLE',
    )
  }
  // A second action for the same profile is a wiring bug, never a fallback.
  refusesWith(
    () => createHttpProbeActionRegistry([
      harnessAction({ execute: async () => ({}) }), harnessAction({ execute: async () => ({}) }),
    ]),
    GipSourceExecutorError,
    'PROBE_ACTION_DECLARATION_INVALID',
  )

  // An UNDECLARED fieldId is a named closed refusal, and it is VALUES-FREE: the
  // reason carries no field name, no identifier and no value.
  const stack = buildStack({
    actionOverrides: {
      sourceFieldFor(fieldId) {
        if (fieldId === 'tgt_1') return 'ItemNo'
        throw new Error(`no translation for ${fieldId}`)
      },
    },
  })
  const resolution = await resolveAlpha(stack.resolver)
  const caught = await refusesWithAsync(
    () => stack.prober.probeFromResolution({ resolution, envelopeKey: ENVELOPE_KEY, probedAt: PROBED_AT }),
    GipSourceExecutorError,
    'PROBE_FIELD_TRANSLATION_UNDECLARED',
  )
  const observable = JSON.stringify({
    m: caught.message, d: caught.details, s: caught.stack,
  })
  assert.ok(!observable.includes('tgt_2'), 'translation refusal must not echo the field id')
  assert.ok(!observable.includes('no translation for'), 'translation refusal must not echo connector text')

  // A translation that returns a NON-string (a silent raw passthrough would return
  // the fieldId itself) is refused rather than used.
  const passthroughStack = buildStack({ actionOverrides: { sourceFieldFor: () => 42 } })
  const passthroughResolution = await resolveAlpha(passthroughStack.resolver)
  await refusesWithAsync(
    () => passthroughStack.prober.probeFromResolution({
      resolution: passthroughResolution, envelopeKey: ENVELOPE_KEY, probedAt: PROBED_AT,
    }),
    GipSourceExecutorError,
    'PROBE_FIELD_TRANSLATION_UNDECLARED',
  )

  // POSITIVE CONTROL — a fully declared translation resolves and the probe runs.
  const okStack = buildStack()
  const okResolution = await resolveAlpha(okStack.resolver)
  const ok = await okStack.prober.probeFromResolution({
    resolution: okResolution, envelopeKey: ENVELOPE_KEY, probedAt: PROBED_AT,
  })
  assert.equal(ok.status, 'candidate')
}

// ---------------------------------------------------------------------------
// (α) — the executor holds an OPAQUE HANDLE, never the authentication secret.
// ---------------------------------------------------------------------------
async function opaqueCredentialHandle() {
  const stack = buildStack()
  await stack.prober.probeFromResolution({
    resolution: await resolveAlpha(stack.resolver), envelopeKey: ENVELOPE_KEY, probedAt: PROBED_AT,
  })

  // Enumerable traversal of everything reachable from the executor, the binder and
  // the prober. Asserted over the WHOLE surface, not by spot-checking one field.
  const seen = new Set()
  const found = []
  function walk(value, depth) {
    if (depth > 8 || value === null || value === undefined) return
    if (typeof value === 'string') {
      if (value.includes(SECRET_CANARY)) found.push(value)
      return
    }
    if (typeof value !== 'object' && typeof value !== 'function') return
    if (seen.has(value)) return
    seen.add(value)
    let keys = []
    try { keys = Object.keys(value) } catch (_error) { return }
    for (let i = 0; i < keys.length; i += 1) {
      let member
      try { member = value[keys[i]] } catch (_error) { continue }
      if (String(keys[i]).includes(SECRET_CANARY)) found.push(keys[i])
      walk(member, depth + 1)
    }
  }
  walk(stack.executor, 0)
  walk(stack.sourceBinder, 0)
  walk(stack.prober, 0)
  assert.deepEqual(found, [], 'the authentication secret must be unreachable from the executor surface')

  // …and it never reaches evidence either.
  const qualification = await stack.prober.probeFromResolution({
    resolution: await resolveAlpha(stack.resolver), envelopeKey: ENVELOPE_KEY, probedAt: PROBED_AT,
  })
  assert.ok(!JSON.stringify(qualification).includes(SECRET_CANARY))
  assert.ok(!JSON.stringify(qualification).includes(ENVELOPE_KEY.secret.toString('hex')))

  // POSITIVE CONTROL — the traversal must be shown to FIND the canary when it IS
  // reachable, otherwise the empty result above proves nothing.
  const leaky = { handle: { plaintextSecret: SECRET_CANARY } }
  const leakFound = []
  const leakSeen = new Set()
  function walkLeak(value, depth) {
    if (depth > 8 || value === null || value === undefined) return
    if (typeof value === 'string') { if (value.includes(SECRET_CANARY)) leakFound.push(value); return }
    if (typeof value !== 'object' && typeof value !== 'function') return
    if (leakSeen.has(value)) return
    leakSeen.add(value)
    for (const key of Object.keys(value)) walkLeak(value[key], depth + 1)
  }
  walkLeak(leaky, 0)
  assert.equal(leakFound.length, 1, 'the reachability traversal must find a planted secret')
}

// ---------------------------------------------------------------------------
// The answer plane is COUNTS ONLY — a connector cannot smuggle values or a
// guarantee token back through it, and foreign text thrown by a connector never
// escapes through a REFUSAL raised on the probe path.
//
// SCOPE (narrowed, B1a-3 round 3): the branded-error half of this function covers
// THE TWO NEW MODULES' classes only. `GipQualificationError` is NOT clean and is not
// claimed to be — see the in-body note and
// `brandedErrorChannelIsOpenOnTheSpikeClass()`.
// ---------------------------------------------------------------------------
async function answerPlaneIsValuesFreeAndForeignTextIsDiscarded() {
  const observed = []
  function record(error) {
    observed.push(String(error && error.message), String(error && error.stack))
    for (const key of Object.getOwnPropertyNames(Object(error))) {
      try { observed.push(String(error[key])) } catch (_ignored) { /* discard */ }
    }
    try { observed.push(JSON.stringify(error, Object.getOwnPropertyNames(Object(error)))) } catch (_ignored) { /* discard */ }
  }

  // A connector that throws attacker text.
  const throwing = harnessSource({ onExecute() { throw new Error(ATTACKER_TEXT) } })
  const stackA = buildStack({ sources: { alpha: throwing, beta: harnessSource() } })
  const resolutionA = await resolveAlpha(stackA.resolver)
  record(await refusesWithAsync(
    () => stackA.prober.probeFromResolution({
      resolution: resolutionA, envelopeKey: ENVELOPE_KEY, probedAt: PROBED_AT,
    }),
    GipSourceExecutorError,
    'PROBE_ACTION_FAILED',
  ))

  // A connector that returns an EXTRA key (row values, a marker, a guarantee token).
  function answering(extra) {
    const log = { calls: 0 }
    return {
      log,
      credentialFactory: () => Object.freeze({
        async execute() {
          log.calls += 1
          return { duplicateGroupsSampled: 0, nullKeyRowsSampled: 0, ...extra }
        },
      }),
    }
  }
  for (const extra of [
    { snapshotSemantics: 'ATTACKER_SMUGGLED_MARKER' },
    { rows: [{ item: ATTACKER_TEXT }] },
    { probeActionId: 'FORGED' },
  ]) {
    const stack = buildStack({ sources: { alpha: answering(extra), beta: harnessSource() } })
    const resolution = await resolveAlpha(stack.resolver)
    record(await refusesWithAsync(
      () => stack.prober.probeFromResolution({
        resolution, envelopeKey: ENVELOPE_KEY, probedAt: PROBED_AT,
      }),
      GipSourceExecutorError,
      'PROBE_ANSWER_UNVERIFIABLE',
    ))
  }

  // A hostile GETTER on the answer, and a Proxy whose ownKeys trap throws during
  // ENUMERATION — guarding the property read alone is not enough.
  const hostileAnswer = { duplicateGroupsSampled: 0 }
  Object.defineProperty(hostileAnswer, 'nullKeyRowsSampled', {
    enumerable: true, get() { throw new Error(ATTACKER_TEXT) },
  })
  const stackG = buildStack({ sources: { alpha: answering({}), beta: harnessSource() } })
  // Replace the handle's answer with the hostile object by rebuilding the stack
  // around a source that returns it.
  const hostileSource = {
    log: { calls: 0 },
    credentialFactory: () => Object.freeze({ async execute() { return hostileAnswer } }),
  }
  const stackH = buildStack({ sources: { alpha: hostileSource, beta: harnessSource() } })
  const resolutionH = await resolveAlpha(stackH.resolver)
  record(await refusesWithAsync(
    () => stackH.prober.probeFromResolution({
      resolution: resolutionH, envelopeKey: ENVELOPE_KEY, probedAt: PROBED_AT,
    }),
    GipSourceExecutorError,
    'PROBE_ANSWER_UNVERIFIABLE',
  ))

  const ownKeysBomb = new Proxy({ duplicateGroupsSampled: 0, nullKeyRowsSampled: 0 }, {
    ownKeys() { throw new Error(ATTACKER_TEXT) },
  })
  const bombSource = {
    log: { calls: 0 },
    credentialFactory: () => Object.freeze({ async execute() { return ownKeysBomb } }),
  }
  const stackB = buildStack({ sources: { alpha: bombSource, beta: harnessSource() } })
  const resolutionB = await resolveAlpha(stackB.resolver)
  record(await refusesWithAsync(
    () => stackB.prober.probeFromResolution({
      resolution: resolutionB, envelopeKey: ENVELOPE_KEY, probedAt: PROBED_AT,
    }),
    GipSourceExecutorError,
    'EXECUTOR_INPUT_HOSTILE',
  ))

  // ── SCOPE, NARROWED TO EXACTLY WHAT IS TESTED (B1a-3 round 3, P1-C) ──────────
  // RETRACTION: this block previously read "a foreign callback that require()s THE
  // MODULES ... cannot mint a branded error carrying attacker text" while
  // constructing ONLY `GipSourceExecutorError` and `GipApprovedBindingResolverError`
  // — the two NEW, already-clean classes. The one class that fails that sentence was
  // the one class it did not construct. The sentence is now scoped to what it tests.
  //
  // WHAT THIS ASSERTS — THE TWO NEW MODULES ONLY (`gip-server-bound-source-executor.cjs`
  // and `gip-approved-binding-resolver.cjs`): their `fail()` takes NO `message` and
  // NO `details` parameter at all, and their error classes read a frozen per-reason
  // message and ignore every further constructor argument. For those two, a foreign
  // callback that require()s the module has nothing to put text into.
  //
  // WHAT THIS DOES **NOT** ASSERT: anything about `gip-binding-qualification-spike.cjs`.
  // Its `GipQualificationError` is exported (and was already exported on `main`),
  // takes `(reason, message, details)`, and GENUINELY DOES carry caller text. It is
  // deliberately NOT added to the `observed[]` loop below: that loop asserts the text
  // does NOT escape, and this class does carry it, so adding it there would red
  // forever — and weakening the loop to accommodate it would be the wrong fix. The
  // residual is instead pinned POSITIVELY, as a channel that EXISTS, by
  // `brandedErrorChannelIsOpenOnTheSpikeClass()` in this file.
  //
  // Read the two together: THESE TWO ARE CLEAN (asserted here); THE THIRD IS NOT,
  // and there is the test that proves it isn't.
  assert.equal(executorModule.fail, undefined)
  assert.equal(executorModule.__internals.fail, undefined)
  assert.equal(resolverModule.fail, undefined)
  assert.equal(resolverModule.__internals.fail, undefined)
  // TRUE, and kept — but re-captioned. Removing `fail` from the spike's `__internals`
  // buys ONE FEWER PATH plus frozen-vocabulary validation on the internal path. It
  // does NOT close the branded-error text channel, because the class is exported.
  // See `brandedErrorChannelIsOpenOnTheSpikeClass()`.
  assert.equal(spikeModule.__internals.fail, undefined)
  const branded = new GipSourceExecutorError('PROBE_ACTION_FAILED', ATTACKER_TEXT, { leak: ATTACKER_TEXT })
  observed.push(String(branded.message), String(branded.details))
  assert.equal(branded.details, undefined)
  const brandedResolver = new GipApprovedBindingResolverError('RESOLVER_RUN_INPUT_INVALID', ATTACKER_TEXT)
  observed.push(String(brandedResolver.message))

  assert.ok(observed.length > 0)
  for (const text of observed) {
    assert.ok(!String(text).includes(ATTACKER_TEXT),
      `foreign text escaped: ${String(text).slice(0, 200)}`)
  }

  // POSITIVE CONTROL for the discard — "discard everything" must not pass: a
  // legitimate internal refusal still surfaces its NAMED reason (asserted by every
  // refusesWithAsync above, each of which pins an exact token).
  assert.deepEqual([...SOURCE_EXECUTOR_ERROR_REASONS], [
    'EXECUTOR_COMPONENTS_INVALID',
    'EXECUTOR_INPUT_HOSTILE',
    'PROBE_ACTION_DECLARATION_INVALID',
    'PROBE_ACTION_REGISTRY_UNTRUSTED',
    'PROBE_ACTION_UNBOUND',
    'PROBE_FIELD_TRANSLATION_UNDECLARED',
    'PROBE_SOURCE_HANDLE_UNAVAILABLE',
    'PROBE_ACTION_FAILED',
    'PROBE_ANSWER_UNVERIFIABLE',
  ])
}

// ---------------------------------------------------------------------------
// P1-B (B1a-3 round 3) · A HOSTILE GETTER PARKED ON AN **ALLOWLISTED** KEY NAME.
//
// `probeFromTrustedResolution` refuses an `ownKeys` trap and an undeclared key, then
// reads four ALLOWLISTED keys. `Object.keys()` enumeration does NOT invoke getters,
// so a throwing getter on an allowlisted NAME passes the allowlist untouched and
// fires on READ — and if the throw escapes, raw attacker text lands in the caller's
// `.message` and `.stack`.
//
// Driven through PUBLIC EXPORTS ONLY: `createBindingQualificationProber(...)
// .probeFromResolution(input)`. No `__internals`, no private require.
//
// FOUR CASES, ONE PER READ — not one case standing in for four. Four fail-closed
// doors covering for each other is exactly the failure mode this line has paid for:
// each of the four `safeReadRunInput` calls is separately mutated in the battery and
// each REDs on its own case.
//
// The `resolution` case uses a NON-ENUMERABLE getter on purpose: the key never
// appears in `Object.keys(input)` at all, which demonstrates directly that the
// allowlist loop is not what protects these reads.
// ---------------------------------------------------------------------------
async function hostileGetterOnAnAllowlistedKeyIsRefusedNotLeaked() {
  const cases = [
    ['resolution', false],
    ['envelopeKey', true],
    ['probedAt', true],
    ['expiresAt', true],
  ]
  const observations = []
  for (const [key, enumerable] of cases) {
    const stack = buildStack()
    const resolution = await resolveAlpha(stack.resolver)
    const base = {
      resolution,
      envelopeKey: ENVELOPE_KEY,
      probedAt: PROBED_AT,
      expiresAt: '2026-07-27T00:00:00Z',
    }
    delete base[key]
    const input = { ...base }
    Object.defineProperty(input, key, {
      enumerable, configurable: true, get() { throw new Error(ATTACKER_TEXT) },
    })

    // The getter's key passes the allowlist: either it is not enumerated at all, or
    // its NAME is on the allowlist. Asserted, so the case cannot silently degrade
    // into "refused by the allowlist" and stop testing the read.
    const enumerated = Object.keys(input)
    if (enumerable) {
      assert.ok(enumerated.includes(key), `${key}: the hostile key must be enumerated`)
    } else {
      assert.ok(!enumerated.includes(key), `${key}: the hostile key must be invisible to Object.keys`)
    }
    for (const seen of enumerated) {
      assert.ok(['resolution', 'envelopeKey', 'probedAt', 'expiresAt'].includes(seen),
        `${key}: the fixture must not smuggle an undeclared key — that would test the allowlist, not the read`)
    }

    let caught = null
    try {
      await stack.prober.probeFromResolution(input)
    } catch (error) { caught = error }

    assert.ok(caught, `${key}: the hostile getter must fail the probe closed`)
    // Collect every observable surface, then assert on all of them at once.
    const surfaces = [String(caught.message), String(caught.stack), JSON.stringify(caught.details || {})]
    observations.push({ key, reason: caught.reason, surfaces })

    // FAIL CLOSED under the ALREADY-DECLARED token, by EQUALITY.
    assert.ok(caught instanceof GipQualificationError,
      `${key}: expected GipQualificationError, got ${caught && caught.name}`)
    assert.equal(caught.reason, 'PROBE_CALLER_SUPPLIED_EXECUTION_REFUSED')
  }

  // THE ASSERTION: the attacker's text reaches no caller-observable surface.
  assert.equal(observations.length, cases.length)
  for (const observation of observations) {
    for (const surface of observation.surfaces) {
      assert.ok(!surface.includes(ATTACKER_TEXT),
        `${observation.key}: attacker text escaped: ${surface.slice(0, 200)}`)
    }
  }

  // POSITIVE CONTROL for the discard — "discard everything and refuse" must not be
  // enough to pass. The same stack, with NO hostile getter, still qualifies.
  const clean = buildStack()
  const cleanResolution = await resolveAlpha(clean.resolver)
  const qualification = await clean.prober.probeFromResolution({
    resolution: cleanResolution, envelopeKey: ENVELOPE_KEY, probedAt: PROBED_AT,
  })
  assert.equal(qualification.status, 'candidate')

  // POSITIVE CONTROL for the canary itself: the traversal must be shown to FIND the
  // text when it is present, otherwise every "absent" above is vacuous.
  assert.ok(String(new Error(ATTACKER_TEXT).stack).includes(ATTACKER_TEXT))
}

// ---------------------------------------------------------------------------
// P1-A (B1a-3 round 3) · A RESIDUAL PINNED BY ASSERTING THE CHANNEL **EXISTS**.
//
// `gip-binding-qualification-spike.cjs` removed `fail` from `__internals` and its
// comment claimed that closed the branded-error text channel. IT DOES NOT:
// `GipQualificationError` is itself exported, and was ALREADY exported on `main`
// (the class body and its export are byte-identical to `main` at this head), so an
// importer never needed `fail`. Hardening the class is OUT OF SCOPE here — it is
// pre-existing `main` code belonging to the landed `bridge.bounded_read.v2` line and
// needs its own gate.
//
// So the residual is DISCLOSED rather than dropped: this test asserts, POSITIVELY,
// that the attacker text IS carried. A residual quietly missing from an assertion is
// hidden; a residual pinned by an assertion is on the record. When a future PR
// hardens the class, THIS TEST REDS — which forces the ledger to be updated instead
// of going stale. That is its purpose, not an accident.
// ---------------------------------------------------------------------------
function brandedErrorChannelIsOpenOnTheSpikeClass() {
  // PUBLIC EXPORT ONLY. No `__internals`, no `fail`.
  assert.equal(spikeModule.fail, undefined)
  assert.equal(spikeModule.__internals.fail, undefined)
  assert.equal(typeof spikeModule.GipQualificationError, 'function')

  const branded = new GipQualificationError(
    'QUALIFICATION_INPUT_INVALID', ATTACKER_TEXT, { leak: ATTACKER_TEXT },
  )
  // The brand is GENUINE — an `instanceof` consumer cannot distinguish this from an
  // internally-minted error.
  assert.ok(branded instanceof GipQualificationError)
  assert.ok(branded instanceof Error)
  assert.equal(branded.name, 'GipQualificationError')
  assert.equal(branded.reason, 'QUALIFICATION_INPUT_INVALID')

  // THE POINT, ASSERTED POSITIVELY: the caller text IS carried, on both surfaces.
  assert.equal(branded.message, ATTACKER_TEXT)
  assert.ok(String(branded.stack).includes(ATTACKER_TEXT))
  assert.deepEqual(branded.details, { leak: ATTACKER_TEXT })

  // And the vocabulary check that `fail()` performs on the INTERNAL path is NOT
  // performed by direct construction — this is exactly the delta that removing
  // `fail` from `__internals` buys, stated as what it is and no more.
  const undeclared = new GipQualificationError('NOT_A_DECLARED_REASON', ATTACKER_TEXT)
  assert.ok(!QUALIFICATION_ERROR_REASONS.includes('NOT_A_DECLARED_REASON'))
  assert.equal(undeclared.reason, 'NOT_A_DECLARED_REASON')
  assert.equal(undeclared.message, ATTACKER_TEXT)

  // CONTRAST, so the narrowing in `answerPlaneIsValuesFreeAndForeignTextIsDiscarded`
  // is legible here too: the two NEW modules' classes refuse the same construction.
  assert.equal(new GipSourceExecutorError('PROBE_ACTION_FAILED', ATTACKER_TEXT, { leak: ATTACKER_TEXT }).message,
    'the HTTP probe action did not complete')
  assert.equal(new GipApprovedBindingResolverError('RESOLVER_RUN_INPUT_INVALID', ATTACKER_TEXT).message.includes(ATTACKER_TEXT),
    false)
}

// ---------------------------------------------------------------------------
// Exact key-set pins on every exported surface this slice adds or touches.
// ---------------------------------------------------------------------------
function exportSurfacesArePinned() {
  assert.deepEqual(keySet(executorModule), [
    'CERTIFIED_HTTP_PROBE_ACTION_REGISTRY',
    'GipSourceExecutorError',
    'HTTP_PROBE_ACTION_DECLARATION_KEYS',
    'SOURCE_EXECUTOR_ERROR_REASONS',
    '__internals',
    'createHarnessHttpProbeActionRegistryForTests',
    'createHarnessSourceBinderForTests',
    'createHttpProbeActionRegistry',
    'createServerBoundSourceExecutor',
    'isTrustedServerBoundSourceExecutor',
  ])
  assert.deepEqual(keySet(executorModule.__internals), [
    'hasControlCharacter', 'isPlainObject', 'normalizeActionDeclaration',
  ])
  assert.deepEqual(keySet(resolverModule), [
    'BINDING_RESOLVER_ERROR_REASONS',
    'GipApprovedBindingResolverError',
    'RESOLUTION_KEYS',
    '__internals',
    'assertTrustedBindingResolution',
    'createApprovedBindingResolver',
    'createCertifiedCanonicalObjectAuthority',
    'createCertifiedSystemIdentityAuthority',
    'createHarnessCanonicalObjectAuthorityForTests',
    'createHarnessSystemIdentityAuthorityForTests',
    'isTrustedBindingResolution',
  ])
  assert.deepEqual(keySet(resolverModule.__internals), [
    'assertLosslessConfigBody', 'hasControlCharacter', 'isPlainObject',
  ])
  // The spike module's surface after §4 step 1.5.
  assert.deepEqual(keySet(spikeModule), [
    'GipQualificationError',
    'QUALIFICATION_ERROR_REASONS',
    'QUALIFICATION_STATUSES',
    '__internals',
    'buildOrderingKeyDuplicateProbeSql',
    'buildOrderingKeyNullProbeSql',
    'buildOrderingKeyTotalOrderProbeSql',
    'computeEnvelopeMac',
    'computeQualificationDigest',
    'createBindingQualificationProber',
    'createProbeStrategyRegistry',
    'postgresTotalOrderProbeStrategy',
    'verifyBindingQualification',
  ])
  assert.deepEqual(keySet(spikeModule.__internals), [
    'assertReadOnlySql', 'quoteIdentifier', 'stableStringify',
  ])
  // The store gained a CHECKER, never a granter.
  assert.deepEqual(keySet(storeModule), [
    'ReadSourceConfigConflictError',
    'ReadSourceConfigNotApprovedError',
    'ReadSourceConfigNotFoundError',
    'ReadSourceConfigValidationError',
    '__internals',
    'createReadSourceConfigStore',
    'isFirstPartyReadSourceConfigStore',
  ])
}

// ---------------------------------------------------------------------------
// LATENT — executed enumeration with its own positive control.
// ---------------------------------------------------------------------------
function latentByEnumeration() {
  const fs = require('node:fs')
  const repoRoot = path.join(__dirname, '..', '..', '..')
  const modules = ['gip-server-bound-source-executor', 'gip-approved-binding-resolver']
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.turbo'])
  const hits = []

  function walk(dir) {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_error) { return }
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(path.join(dir, entry.name))
        continue
      }
      if (!/\.(cjs|mjs|js|ts|tsx)$/.test(entry.name)) continue
      const full = path.join(dir, entry.name)
      let text
      try { text = fs.readFileSync(full, 'utf8') } catch (_error) { continue }
      for (const name of modules) {
        if (text.includes(name)) hits.push(`${path.relative(repoRoot, full)}::${name}`)
      }
    }
  }
  walk(repoRoot)

  // POSITIVE CONTROL: the enumeration must be shown to FIND references. An empty
  // grep is not absence until the grep is shown to work.
  assert.ok(hits.length >= 4, `enumeration found too little — it is not reading the tree: ${JSON.stringify(hits)}`)

  // The permitted referrer set is stated as a RULE, not a filename list, so a new
  // route or a scheduled run cannot be waved through by appending a name:
  //   * anything under `plugins/plugin-integration-core/__tests__/` — tests are not
  //     production consumers;
  //   * within `plugins/plugin-integration-core/lib/`, ONLY the three modules of this
  //     slice. `gip-binding-qualification-spike.cjs` is the one first-party consumer
  //     the slice deliberately wires, and it is itself LATENT;
  //   * NOTHING anywhere else in the tree — no route module, no scheduled run, no
  //     runtime caller, in this package or any other.
  const PLUGIN = 'plugins/plugin-integration-core/'
  const LIB_ALLOWED = new Set([
    'gip-server-bound-source-executor.cjs',
    'gip-approved-binding-resolver.cjs',
    'gip-binding-qualification-spike.cjs',
  ])
  const unexpected = hits.filter((hit) => {
    const file = hit.split('::')[0]
    if (!file.startsWith(PLUGIN)) return true
    const rest = file.slice(PLUGIN.length)
    if (rest.startsWith('__tests__/')) return false
    if (rest.startsWith('lib/')) return !LIB_ALLOWED.has(rest.slice('lib/'.length))
    return true
  })
  assert.deepEqual(unexpected, [],
    `B1a-3 must ship LATENT — no route, no scheduled run, no runtime caller: ${JSON.stringify(unexpected)}`)

  // POSITIVE CONTROL for the RULE (not just for the grep): a hypothetical production
  // caller in a route module must be reported as unexpected. Without this, a filter
  // that returns false for everything would pass the assertion above.
  const plantedRoute = `${PLUGIN}lib/http-routes.cjs::gip-server-bound-source-executor`
  const plantedOther = 'packages/core-backend/src/routes/x.ts::gip-approved-binding-resolver'
  for (const planted of [plantedRoute, plantedOther]) {
    const file = planted.split('::')[0]
    const flagged = !file.startsWith(PLUGIN)
      || !(file.slice(PLUGIN.length).startsWith('__tests__/')
        || (file.slice(PLUGIN.length).startsWith('lib/')
          && LIB_ALLOWED.has(file.slice(PLUGIN.length + 4))))
    assert.ok(flagged, `the latency rule must flag a production caller: ${planted}`)
  }

  // NO SQL is minted anywhere in this slice: neither new module reaches the SQL
  // builders, on any path.
  for (const name of ['gip-server-bound-source-executor.cjs', 'gip-approved-binding-resolver.cjs']) {
    const raw = fs.readFileSync(path.join(LIB, name), 'utf8')
    const code = raw.replace(/\/\/.*$/gm, '')
    assert.ok(!code.includes('buildTotalOrderProbeSql'), `${name} must not reach the SQL builders`)
    assert.ok(!/\bSELECT\b/.test(code), `${name} must mint no SQL`)
    assert.ok(!code.includes("require('./gip-binding-qualification-spike.cjs')"),
      `${name} must not require the SQL spike module`)
    // POSITIVE CONTROL for this scan: it must be shown to FIND the token when it is
    // present, otherwise the three assertions above are grepping nothing.
    assert.ok(`${code}\nbuildTotalOrderProbeSql`.includes('buildTotalOrderProbeSql'))
  }
}

async function main() {
  await positiveControlThroughExecutor()
  await residual1InexpressibleByExactKeySet()
  await residual2NamedClosedRefusal()
  await crossSystemAnswersDoNotTransfer()
  await buildIsSplitFromTrust()
  await declarationAndTranslation()
  await opaqueCredentialHandle()
  await answerPlaneIsValuesFreeAndForeignTextIsDiscarded()
  await hostileGetterOnAnAllowlistedKeyIsRefusedNotLeaked()
  brandedErrorChannelIsOpenOnTheSpikeClass()
  exportSurfacesArePinned()
  latentByEnumeration()
  console.log('gip-server-bound-source-executor.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
