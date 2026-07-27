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

// ROUND 6, P1-A — BRANDEDNESS IS JUDGED BY AN UNFORGEABLE CHECKER WHERE ONE EXISTS.
//
// `caught instanceof ErrorClass` is not a brand and never was. All three refutations
// were EXECUTED against the round-5 head: `Object.create(ErrorClass.prototype)`
// satisfies it while carrying attacker text; `.name` is an ordinary writable property
// so every name-based criterion (including the one behind the RETRACTED 0/12 matrix)
// is satisfied by a plain `Error`; and a `Symbol.hasInstance` hijack makes the
// EXPRESSION ITSELF throw — inside this helper that would abort the run rather than
// fail the case. The two in-scope modules now expose module-private-WeakSet checkers,
// which invoke no caller code, cannot be made to throw, and cannot be conferred from
// outside.
//
// ⚠ DISCLOSED, NOT FIXED — `GipQualificationError` HAS NO UNFORGEABLE BRAND. The
// spike module's `fail()` and its error class are BYTE-IDENTICAL to `origin/main`
// (verified: `git diff origin/main -- lib/gip-binding-qualification-spike.cjs` carries
// no hunk over either), so under this PR's scope rule they are disclosed rather than
// changed. Cells judged against that class therefore still rest on `instanceof`, and
// what they actually prove is the `reason` TOKEN EQUALITY on the next line — which is
// asserted for every cell either way. `spikeClassHasNoUnforgeableBrand()` pins the
// residual positively, so the day a future PR brands that class, this comment REDs
// instead of going stale.
const UNFORGEABLE_BRAND_CHECKER = new Map([
  [GipSourceExecutorError, executorModule.isBrandedSourceExecutorError],
  [GipApprovedBindingResolverError, resolverModule.isBrandedApprovedBindingResolverError],
])

function judgeBranded(ErrorClass, caught) {
  const checker = UNFORGEABLE_BRAND_CHECKER.get(ErrorClass)
  if (typeof checker === 'function') return checker(caught)
  return caught instanceof ErrorClass
}

// Token EQUALITY, never `includes` — two tokens minted at the same fail() call site
// can otherwise cover for each other.
function refusesWith(fn, ErrorClass, expectedReason) {
  let caught = null
  try { fn() } catch (error) { caught = error }
  assert.ok(judgeBranded(ErrorClass, caught), `expected ${ErrorClass.name}, got ${caught && caught.name}: ${caught && caught.message}`)
  assert.equal(caught.reason, expectedReason)
  return caught
}

async function refusesWithAsync(fn, ErrorClass, expectedReason) {
  let caught = null
  try { await fn() } catch (error) { caught = error }
  assert.ok(judgeBranded(ErrorClass, caught), `expected ${ErrorClass.name}, got ${caught && caught.name}: ${caught && caught.message}`)
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
    // B1a-3 round 5. L2-ONLY token — see `entryTableIsGated`.
    'EXECUTOR_ENTRY_NOT_INERT',
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
    assert.ok(judgeBranded(GipQualificationError, caught),
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
// P1-B, SECOND SITE (B1a-3 round 3) · `verifyBindingQualification` had the SAME leak.
//
// `qualification` is a CALLER-SUPPLIED plain object with NO closed key set, read RAW
// at eight sites over six keys — `status` three times, `qualificationDigest` and
// `expiresAt` more than once each. Executed before the fix: FIVE of the six keys
// leaked attacker text as a bare `Error`; `evidence` escaped only because the MAC
// check happens to fire first, which is ordering, not a guard.
//
// This function is IN SCOPE: this PR changed its signature (`expectedInputs` removed,
// resolution gate added). Fixing the probe path and leaving this one open would make
// the body's own "hostile property getters" claim false in the other half of the
// module.
//
// SIX CASES, ONE PER KEY, and six separate mutations in the battery.
// ---------------------------------------------------------------------------
async function hostileGetterOnTheVerifiedQualificationIsRefusedNotLeaked() {
  const stack = buildStack()
  const resolution = await resolveAlpha(stack.resolver)
  // A REAL qualification first, so the fixture is the shape the function actually
  // verifies rather than a bare stand-in that trips an earlier guard.
  const genuine = await stack.prober.probeFromResolution({
    resolution, envelopeKey: ENVELOPE_KEY, probedAt: PROBED_AT, expiresAt: '2026-07-27T00:00:00Z',
  })
  // POSITIVE CONTROL: unmodified, it verifies.
  assert.equal(verifyBindingQualification({
    qualification: genuine, resolution, envelopeKey: ENVELOPE_KEY, now: '2026-07-26T12:00:00Z',
  }).verified, true)

  const keys = ['status', 'envelopeKeyId', 'envelopeMac', 'qualificationDigest', 'expiresAt', 'evidence']
  for (const key of keys) {
    const hostile = { ...genuine }
    delete hostile[key]
    Object.defineProperty(hostile, key, {
      enumerable: true, configurable: true, get() { throw new Error(ATTACKER_TEXT) },
    })
    let caught = null
    try {
      verifyBindingQualification({
        qualification: hostile, resolution, envelopeKey: ENVELOPE_KEY, now: '2026-07-26T12:00:00Z',
      })
    } catch (error) { caught = error }

    assert.ok(caught, `qualification.${key}: the hostile getter must fail closed`)
    assert.ok(judgeBranded(GipQualificationError, caught),
      `qualification.${key}: expected GipQualificationError, got ${caught && caught.name}`)
    assert.equal(caught.reason, 'QUALIFICATION_NOT_OBJECT')
    for (const surface of [String(caught.message), String(caught.stack), JSON.stringify(caught.details || {})]) {
      assert.ok(!surface.includes(ATTACKER_TEXT),
        `qualification.${key}: attacker text escaped: ${surface.slice(0, 200)}`)
    }
  }

  // DECLARED, NOT CLOSED — the same class is still OPEN one level out, on
  // `envelopeKey`, which `normalizeEnvelopeKey` reads raw. That function is
  // byte-identical to `main` and is OUT OF SCOPE here; this assertion PINS the
  // residual as OPEN so it cannot silently vanish from the ledger (see §9A/OS-3).
  const hostileKey = { secret: Buffer.alloc(32, 5) }
  Object.defineProperty(hostileKey, 'keyId', {
    enumerable: true, configurable: true, get() { throw new Error(ATTACKER_TEXT) },
  })
  let envelopeCaught = null
  try {
    verifyBindingQualification({
      qualification: genuine, resolution, envelopeKey: hostileKey, now: '2026-07-26T12:00:00Z',
    })
  } catch (error) { envelopeCaught = error }
  assert.ok(envelopeCaught)
  assert.ok(!judgeBranded(GipQualificationError, envelopeCaught),
    'OS-3 residual: this is expected to be an UNBRANDED escape today — if it is now branded, the '
    + 'residual was closed and §9A/OS-3 must be updated')
  assert.ok(String(envelopeCaught.message).includes(ATTACKER_TEXT),
    'OS-3 residual: the envelopeKey getter channel is asserted to be OPEN — if this fails, it was '
    + 'closed and the ledger must be updated')
}

// ---------------------------------------------------------------------------
// P1 (B1a-3 round 4) · A HOSTILE GETTER ON THE PROBER'S **COMPONENTS** OBJECT.
//
// `createBindingQualificationProber(components)` read `components.executor` RAW. The
// spike's `isPlainObject` is the LOOSE one — no enumeration, no prototype check — so
// `{ get executor() { throw new Error(<attacker text>) } }` passed it intact and the
// throw escaped the PUBLIC export as an UNBRANDED `Error` with the attacker's text
// verbatim in `.message` and `.stack`.
//
// THIS SITE IS IN SCOPE AND IS NOT SHIELDED BY "byte-identical to main": on `main`
// the factory was `createBindingQualificationProber(strategyRegistry)` — a POSITIONAL
// argument that read no property from caller data. `const executor =
// components.executor` is a `+` line in this PR's diff.
//
// THREE CONSTRUCTIONS, because they are three different mechanisms and any one of
// them alone would leave the other two untested:
//   ① an ENUMERABLE getter,
//   ② a NON-ENUMERABLE getter (invisible to `Object.keys` entirely),
//   ③ a Proxy GET-trap.
// The Proxy OWNKEYS-trap is included as a FOURTH case and is asserted to be refused
// — but note WHY, because it is not a guard: the ownKeys trap is never invoked on
// this path at all; the read falls through to the empty target, yields `undefined`,
// and the identity check rejects it. Recording that distinction is the point.
// ---------------------------------------------------------------------------
async function hostileGetterOnTheProberComponentsIsRefusedNotLeaked() {
  const stack = buildStack()

  // POSITIVE CONTROL first: a well-formed components object still mints a prober,
  // so "refuse everything" cannot pass this test.
  const good = createBindingQualificationProber({ executor: stack.executor })
  assert.deepEqual(keySet(good), ['probeFromResolution'])

  const constructions = [
    ['enumerable getter', () => {
      const o = {}
      Object.defineProperty(o, 'executor', {
        enumerable: true, configurable: true, get() { throw new Error(ATTACKER_TEXT) },
      })
      return o
    }],
    ['non-enumerable getter', () => {
      const o = {}
      Object.defineProperty(o, 'executor', {
        enumerable: false, configurable: true, get() { throw new Error(ATTACKER_TEXT) },
      })
      return o
    }],
    ['Proxy get-trap', () => new Proxy({}, {
      get(_target, prop) { throw new Error(`${ATTACKER_TEXT}::${String(prop)}`) },
    })],
    ['Proxy ownKeys-trap', () => new Proxy({}, {
      ownKeys() { throw new Error(ATTACKER_TEXT) },
    })],
  ]

  for (const [label, make] of constructions) {
    const components = make()
    // The construction must actually REACH the read: the loose `isPlainObject` must
    // accept it. Asserted, so a case cannot silently degrade into "refused by the
    // type check" and stop testing the read.
    assert.ok(components && typeof components === 'object' && !Array.isArray(components),
      `${label}: the fixture must pass the loose plain-object check`)

    let caught = null
    try { createBindingQualificationProber(components) } catch (error) { caught = error }

    assert.ok(caught, `${label}: must fail closed`)
    assert.ok(judgeBranded(GipQualificationError, caught),
      `${label}: expected GipQualificationError, got ${caught && caught.name}`)
    // Token EQUALITY on the reason this DOOR declares — not the run-input token.
    assert.equal(caught.reason, 'PROBE_EXECUTOR_UNTRUSTED')
    for (const surface of [String(caught.message), String(caught.stack), JSON.stringify(caught.details || {})]) {
      assert.ok(!surface.includes(ATTACKER_TEXT),
        `${label}: attacker text escaped: ${surface.slice(0, 200)}`)
    }
  }

  // POSITIVE CONTROL for the canary traversal itself.
  assert.ok(String(new Error(ATTACKER_TEXT).stack).includes(ATTACKER_TEXT))
}

// ---------------------------------------------------------------------------
// P2 (B1a-3 round 4) · THE **SPIKE'S OWN** ENUMERATION DOOR, TESTED SEPARATELY.
//
// `probeFromTrustedResolution` wraps `Object.keys(input)` in a try/catch because the
// `ownKeys` trap fires during ENUMERATION, before any property is read. That guard
// had NO test in any of the four suites: neutered alone, all four stayed exit 0.
//
// Meanwhile the body's leak-channel table listed channel 4 (ownKeys-during-
// enumeration) as closed and cited **M19** — but M19's RED comes from the EXECUTOR
// module's `safeOwnKeys`, a DIFFERENT DOOR in a DIFFERENT MODULE. The tested door was
// covering for the untested one. This is 门级排他 ≠ 词级排他: one channel NAME, two
// doors, and neutering either one still REDs while the other fires.
//
// So this test drives the SPIKE's door specifically, through public exports only, and
// asserts BOTH states are distinguishable:
//   guard PRESENT ⇒ branded `PROBE_CALLER_SUPPLIED_EXECUTION_REFUSED`, no leak;
//   guard REMOVED ⇒ bare `Error` carrying the canary in `.message` AND `.stack`
//                   (executed; see the round-4 battery — and note the escape is NOT a
//                   `GipSourceExecutorError`, which is what proves the executor's
//                   `safeOwnKeys` is not the door answering here).
// ---------------------------------------------------------------------------
async function ownKeysTrapDuringRunInputEnumerationIsRefusedNotLeaked() {
  const stack = buildStack()
  const resolution = await resolveAlpha(stack.resolver)

  const target = { resolution, envelopeKey: ENVELOPE_KEY, probedAt: PROBED_AT }
  let ownKeysCalls = 0
  const input = new Proxy(target, {
    ownKeys() { ownKeysCalls += 1; throw new Error(ATTACKER_TEXT) },
  })

  // The fixture must reach the ENUMERATION: the loose `isPlainObject` accepts a Proxy
  // over a plain object, so nothing refuses it earlier.
  assert.ok(input && typeof input === 'object' && !Array.isArray(input))

  let caught = null
  try { await stack.prober.probeFromResolution(input) } catch (error) { caught = error }

  assert.ok(caught, 'a throwing ownKeys trap must fail the probe closed')
  assert.ok(judgeBranded(GipQualificationError, caught),
    `expected GipQualificationError, got ${caught && caught.name}`)
  assert.equal(caught.reason, 'PROBE_CALLER_SUPPLIED_EXECUTION_REFUSED')
  for (const surface of [String(caught.message), String(caught.stack), JSON.stringify(caught.details || {})]) {
    assert.ok(!surface.includes(ATTACKER_TEXT), `attacker text escaped: ${surface.slice(0, 200)}`)
  }

  // THE DOOR IS DEMONSTRABLY LIVE. Without this, the refusal above could be coming
  // from anywhere and the test would prove nothing about the enumeration guard.
  assert.equal(ownKeysCalls, 1, 'the ownKeys trap must actually have been invoked')

  // DOOR EXCLUSIVITY, asserted rather than assumed: the refusal is the SPIKE's, not
  // the executor module's `safeOwnKeys`. A `GipSourceExecutorError` here would mean
  // this test is measuring the other door — the exact substitution the round-3 table
  // made in prose.
  // ROUND 6, P1-A: judged by the UNFORGEABLE checker. `!(x instanceof C)` is an even
  // worse criterion than its positive twin — a `Symbol.hasInstance` hijack makes the
  // expression throw, and a prototype forgery makes it FALSE, so a leak would read as
  // a pass on both counts.
  assert.ok(!executorModule.isBrandedSourceExecutorError(caught),
    'the refusal must come from the spike module, not the executor module')

  // POSITIVE CONTROL: the same stack with an ordinary run input still qualifies.
  const clean = await stack.prober.probeFromResolution({
    resolution, envelopeKey: ENVELOPE_KEY, probedAt: PROBED_AT,
  })
  assert.equal(clean.status, 'candidate')
}

// ---------------------------------------------------------------------------
// P2 (B1a-3 round 4) · THE **OUTER** ARGUMENT OF `verifyBindingQualification`.
//
// Round 3 wrote `readQualificationField` for the six INNER reads and left the OUTER
// read that obtains `qualification` raw — the argument was DESTRUCTURED in the
// parameter list, which fires before any guard in the body. Executed before the fix:
// 5 of 5 leaked UNBRANDED (one throwing getter per field, plus a Proxy get-trap over
// the whole argument). The destructure pattern exists on `main`, so the CHANNEL is
// not new; the ASYMMETRY — a guard already sitting in the same function — is what
// this closes.
// ---------------------------------------------------------------------------
async function outerVerifyArgumentIsGuardedNotDestructuredRaw() {
  const stack = buildStack()
  const resolution = await resolveAlpha(stack.resolver)
  const genuine = await stack.prober.probeFromResolution({
    resolution, envelopeKey: ENVELOPE_KEY, probedAt: PROBED_AT, expiresAt: '2026-07-27T00:00:00Z',
  })

  // POSITIVE CONTROL: the ordinary object-literal call still verifies.
  assert.equal(verifyBindingQualification({
    qualification: genuine, resolution, envelopeKey: ENVELOPE_KEY, now: '2026-07-26T12:00:00Z',
  }).verified, true)

  const fields = ['qualification', 'resolution', 'envelopeKey', 'now']
  const constructions = fields.map((field) => [`throwing getter on .${field}`, () => {
    const o = {
      qualification: genuine, resolution, envelopeKey: ENVELOPE_KEY, now: '2026-07-26T12:00:00Z',
    }
    delete o[field]
    Object.defineProperty(o, field, {
      enumerable: true, configurable: true, get() { throw new Error(ATTACKER_TEXT) },
    })
    return o
  }])
  constructions.push(['Proxy get-trap over the WHOLE argument', () => new Proxy({}, {
    get(_target, prop) { throw new Error(`${ATTACKER_TEXT}::${String(prop)}`) },
  })])

  for (const [label, make] of constructions) {
    let caught = null
    try { verifyBindingQualification(make()) } catch (error) { caught = error }
    assert.ok(caught, `${label}: must fail closed`)
    assert.ok(judgeBranded(GipQualificationError, caught),
      `${label}: expected GipQualificationError, got ${caught && caught.name}`)
    assert.equal(caught.reason, 'QUALIFICATION_NOT_OBJECT')
    for (const surface of [String(caught.message), String(caught.stack), JSON.stringify(caught.details || {})]) {
      assert.ok(!surface.includes(ATTACKER_TEXT),
        `${label}: attacker text escaped: ${surface.slice(0, 200)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// P3 (B1a-3 round 4) · THE READ-ONCE INVARIANT, PINNED INSTEAD OF ASSERTED.
//
// Both paths carry an in-code comment stating as FACT that `expiresAt` is read ONCE
// through the guarded reader into a local, "so a differing-return accessor cannot
// answer one thing to a presence test and another to the use". NEITHER path had a
// test: the round-3 battery's M9 DISCLOSED the gap on the probe path, and the verify
// path's identical gap (M14 — a second `readQualificationField('expiresAt')` left all
// four suites GREEN) was not disclosed at all — it was written as a closed invariant.
//
// An asserted-but-untested invariant is a hidden bug, so BOTH are pinned, which also
// removes the asymmetry rather than merely declaring it.
//
// THE TWO PATHS ARE **SEPARATE TEST FUNCTIONS**, deliberately. Written as one
// function they would both RED inside the same frame, and "it REDs" would not say
// WHICH read-once guard fired — the exact door-vs-word confusion this round's P2
// finding is about. Split, the battery's frame extraction reports one EXCLUSIVE test
// per mutation.
//
// The discriminator is BEHAVIOURAL, not a call count. A call count alone is the
// "counting guard" shape this line has already paid for — `reads === 1` is asserted
// too, but it is the CONSEQUENCE assertions that carry each test.
// ---------------------------------------------------------------------------

// VERIFY PATH — the gap that was NOT disclosed (the old M14).
// The getter answers the genuine instant on read #1 (so the MAC still authenticates)
// and a POSTPONED instant on read #2. Read-once ⇒ the local is the genuine instant ⇒
// QUALIFICATION_EXPIRED. Double-read ⇒ the expiry comparison sees the postponed
// instant ⇒ the call RETURNS VERIFIED — a fail-OPEN inversion, which is precisely
// what the in-code comment claims cannot happen.
async function expiresAtIsReadExactlyOnceOnTheVerifyPath() {
  const stack = buildStack()
  const resolution = await resolveAlpha(stack.resolver)
  const GENUINE_EXPIRY = '2026-07-27T00:00:00Z'
  const POSTPONED_EXPIRY = '2027-01-01T00:00:00Z'
  const genuine = await stack.prober.probeFromResolution({
    resolution, envelopeKey: ENVELOPE_KEY, probedAt: PROBED_AT, expiresAt: GENUINE_EXPIRY,
  })

  const hostile = { ...genuine }
  delete hostile.expiresAt
  let verifyReads = 0
  Object.defineProperty(hostile, 'expiresAt', {
    enumerable: true,
    configurable: true,
    get() {
      verifyReads += 1
      // Read #1 answers the GENUINE value, so the MAC still authenticates and the
      // function proceeds; every later read answers the POSTPONED value.
      return verifyReads === 1 ? GENUINE_EXPIRY : POSTPONED_EXPIRY
    },
  })

  // `now` is AFTER the genuine expiry and BEFORE the postponed one — the two readings
  // give opposite verdicts, which is what makes this discriminating.
  const NOW_AFTER_GENUINE_EXPIRY = '2026-07-28T00:00:00Z'
  refusesWith(
    () => verifyBindingQualification({
      qualification: hostile, resolution, envelopeKey: ENVELOPE_KEY, now: NOW_AFTER_GENUINE_EXPIRY,
    }),
    GipQualificationError,
    'QUALIFICATION_EXPIRED',
  )
  assert.equal(verifyReads, 1,
    'verifyBindingQualification must read qualification.expiresAt EXACTLY once')

  // The two-verdict property of the fixture is asserted, not assumed: with the
  // POSTPONED value the same `now` would NOT be expired. Without this, the refusal
  // above could hold for a reason unrelated to which value was read.
  assert.ok(Date.parse(POSTPONED_EXPIRY) > Date.parse(NOW_AFTER_GENUINE_EXPIRY))
  assert.ok(Date.parse(GENUINE_EXPIRY) <= Date.parse(NOW_AFTER_GENUINE_EXPIRY))
}

// PROBE PATH — the gap round 3 DID disclose (the old M9), now closed too, so the two
// paths are pinned symmetrically instead of one being pinned and one declared.
// The getter answers instant A on read #1 and instant B on read #2. Read-once ⇒ the
// minted qualification carries A. Double-read ⇒ it carries B, which the MAC was not
// computed over.
async function expiresAtIsReadExactlyOnceOnTheProbePath() {
  const probeStack = buildStack()
  const probeResolution = await resolveAlpha(probeStack.resolver)
  const FIRST = '2026-07-27T00:00:00Z'
  const SECOND = '2026-12-31T00:00:00Z'
  let probeReads = 0
  const runInput = { resolution: probeResolution, envelopeKey: ENVELOPE_KEY, probedAt: PROBED_AT }
  Object.defineProperty(runInput, 'expiresAt', {
    enumerable: true,
    configurable: true,
    get() { probeReads += 1; return probeReads === 1 ? FIRST : SECOND },
  })
  const minted = await probeStack.prober.probeFromResolution(runInput)
  assert.equal(probeReads, 1, 'the probe path must read input.expiresAt EXACTLY once')
  assert.equal(minted.expiresAt, FIRST,
    'the minted qualification must carry the value from the SINGLE read')
  assert.notEqual(FIRST, SECOND)

  // ...and the minted qualification is internally consistent: its MAC authenticates
  // the expiry it actually carries. Under a double read the two would disagree.
  assert.equal(verifyBindingQualification({
    qualification: minted, resolution: probeResolution, envelopeKey: ENVELOPE_KEY, now: '2026-07-26T12:00:00Z',
  }).verified, true)
}

// ---------------------------------------------------------------------------
// NIT (B1a-3 round 4) · THE BINDER FAILS CLOSED ON A DUPLICATE, LIKE THE REGISTRY.
//
// `createHarnessSourceBinderForTests` used a bare last-wins `set`, while the action
// registry refuses a duplicate outright. The binder is, per the module header, the
// SOLE granting path into `trustedSourceBinders` and the whole of B-1's mechanism, so
// a silent re-point of a systemContentKey is the worst place for last-wins.
// ---------------------------------------------------------------------------
function duplicateSystemContentKeyIsRefusedNotLastWins() {
  const first = harnessSource()
  const second = harnessSource()
  refusesWith(
    () => createHarnessSourceBinderForTests([
      { systemContentKey: 'SCK-DUPLICATE', credentialFactory: first.credentialFactory },
      { systemContentKey: 'SCK-DUPLICATE', credentialFactory: second.credentialFactory },
    ]),
    GipSourceExecutorError,
    'EXECUTOR_COMPONENTS_INVALID',
  )
  // POSITIVE CONTROL: two DISTINCT keys still build, so this is not "refuse two
  // entries".
  const ok = createHarnessSourceBinderForTests([
    { systemContentKey: 'SCK-DISTINCT-1', credentialFactory: harnessSource().credentialFactory },
    { systemContentKey: 'SCK-DISTINCT-2', credentialFactory: harnessSource().credentialFactory },
  ])
  assert.ok(ok.handleFor('SCK-DISTINCT-1'))
  assert.ok(ok.handleFor('SCK-DISTINCT-2'))
  // Mirrors the registry's own duplicate refusal, asserted side by side so the two
  // stay aligned.
  refusesWith(
    () => createHttpProbeActionRegistry([harnessAction({ execute: async () => ({}) }), harnessAction({ execute: async () => ({}) })]),
    GipSourceExecutorError,
    'PROBE_ACTION_DECLARATION_INVALID',
  )
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
// [B1] ROUND 6 — THE AUTHORITY IS CLOSURE-BOUND, PROVEN RATHER THAN ASSUMED.
//
// FOUND BY MUTATION, NOT BY READING. §4's B-1 clause is two claims, and this suite only
// executed one of them. "Two resolutions bound to different systems must not both
// qualify from a single executor answer" was covered; "the authority to qualify must be
// CLOSURE-BOUND, not caller-injected" was NOT. Giving
// `executeOrderingKeyProbe(resolution)` a second parameter that overrides the
// closure-bound components — `executeOrderingKeyProbeInternal(override || bound, ...)`
// — left the ENTIRE suite GREEN. Every test called it with one argument, so a
// caller-injected registry and binder had nothing to trip.
//
// That is the "asserted invariant is a bug" shape: the module header states authority
// is captured at construction and that there is "no seam through which a caller could
// pass a registry, a binder, a handle or a query", and until this test that sentence
// was a comment. The mutation now REDs.
// ---------------------------------------------------------------------------
async function probeAuthorityIsClosureBoundNotCallerInjected() {
  const stack = buildStack()
  const rival = buildStack()
  const resolution = await resolveAlpha(stack.resolver)

  // A WELL-FORMED components record — both members genuinely trusted, so nothing but
  // the closure binding can be what refuses it. Handing over garbage would prove only
  // that garbage is refused.
  const injected = { actionRegistry: rival.actionRegistry, sourceBinder: rival.sourceBinder }
  assert.equal(executorModule.isTrustedHttpProbeActionRegistry(injected.actionRegistry), true)
  assert.equal(executorModule.isTrustedSourceBinder(injected.sourceBinder), true)

  const observation = await stack.executor.executeOrderingKeyProbe(resolution, injected)
  assert.equal(observation.probeKind, 'ordering_key_total_order_negative')
  assert.equal(stack.alpha.log.calls, 1, 'the CLOSURE-BOUND source must be the one that executed')
  assert.equal(rival.alpha.log.calls, 0,
    'a caller-supplied components record was HONOURED — authority is not closure-bound')
  assert.equal(rival.beta.log.calls, 0)

  // Same through the prober, which is the path §4 actually names: the run input is a
  // CLOSED allowlist, so a components record cannot even be expressed there.
  await refusesWithAsync(
    () => stack.prober.probeFromResolution({
      resolution, envelopeKey: ENVELOPE_KEY, probedAt: PROBED_AT, components: injected,
    }),
    GipQualificationError, 'PROBE_CALLER_SUPPLIED_EXECUTION_REFUSED',
  )
  assert.equal(rival.alpha.log.calls, 0, 'the refused run input must not have reached the rival source')
  console.log('  [B1] authority closure-bound: injected trusted components ignored by the executor, refused by the prober')
}

// ---------------------------------------------------------------------------
// ROUND 6, ITEM 2 — THE TRUST-MINTING SURFACE, ENUMERATED MECHANICALLY.
//
// -- WHAT THIS IS, AND WHAT IT IS NOT ---------------------------------------
// It is an OPEN-SET LEDGER, not a closure assertion. It does NOT claim "no public
// export mints trust" — that claim is FALSE at this head and writing it would be the
// exact overclaim shape this PR keeps paying for. What it asserts is that the set of
// publicly-reachable trust-minting paths is EXACTLY the declared eight, by set
// equality. Both directions are load-bearing:
//   * a NINTH granting factory appears ⇒ RED, naming the export that minted;
//   * one of the eight is CLOSED       ⇒ RED, forcing this ledger and the PR body to
//                                        be revised instead of going stale.
// Same shape as `brandedErrorChannelIsOpenOnTheSpikeClass` and
// `spikeClassHasNoUnforgeableBrand`: a residual asserted POSITIVELY is a residual that
// cannot quietly change.
//
// -- HOW IT LOOKS, RATHER THAN WHO IT ASKS ----------------------------------
// A hand-written list of "the factories I think grant trust" proves nothing — that is
// the same reading which produced the round-5 header claiming ONE public factory when
// there were TWO. So this SATURATES instead: seed a pool with every export of the four
// modules plus caller-controlled attacker fixtures, call every function export with
// every argument tuple the pool can form, feed every result back into the pool, and
// repeat. Anything the pool ever reaches that ANY of the six trust checkers accepts is
// recorded together with the export that produced it. TRANSITIVE trust is found the
// same way as direct trust — `createServerBoundSourceExecutor` only mints once the pool
// has ALREADY reached a trusted registry and a trusted binder, which is exactly the
// property that would make a closure real if the leaves were ever closed.
//
// -- SCOPE, STATED ----------------------------------------------------------
// The pool is seeded from the FOUR modules' exports plus attacker data. It does NOT
// seed a first-party read-source config store, so `resolveApprovedBinding` — which
// mints the sixth brand — is not reached BY THIS SWEEP; it is in the ledger anyway,
// EXECUTED directly below. Reporting only what the sweep reached would understate the
// surface, which is the failure this ledger exists to prevent.
// ---------------------------------------------------------------------------
const TRUST_CHECKERS = Object.freeze({
  httpProbeActionRegistry: executorModule.isTrustedHttpProbeActionRegistry,
  sourceBinder: executorModule.isTrustedSourceBinder,
  serverBoundSourceExecutor: executorModule.isTrustedServerBoundSourceExecutor,
  systemIdentityAuthority: resolverModule.isTrustedSystemIdentityAuthority,
  canonicalObjectAuthority: resolverModule.isTrustedCanonicalObjectAuthority,
  bindingResolution: resolverModule.isTrustedBindingResolution,
})

// THE DECLARED LEDGER: export -> the brand it mints.
//
// The two `createCertified*` entries are DECLARED, NOT DEFECTS-IN-WAITING: each mints a
// trust-branded authority whose behaviour is entirely FIRST-PARTY and FAIL-CLOSED at
// this head — (β) `deriveSystemContentKeyForSystemId` refuses every service because
// `buildSystemIdentityService` has no call site, and (γ) the only trusted contract
// registry is the EMPTY module-load instance. They carry no caller-controlled behaviour
// or values. The four `createHarness*ForTests` entries DO carry caller-controlled
// behaviour and values, and that is the class ITEM 2 asks to be closed.
const DECLARED_TRUST_MINTING_PATHS = Object.freeze({
  'executor.createHarnessHttpProbeActionRegistryForTests': 'httpProbeActionRegistry',
  'executor.createHarnessSourceBinderForTests': 'sourceBinder',
  'executor.createServerBoundSourceExecutor': 'serverBoundSourceExecutor',
  'resolver.createHarnessSystemIdentityAuthorityForTests': 'systemIdentityAuthority',
  'resolver.createHarnessCanonicalObjectAuthorityForTests': 'canonicalObjectAuthority',
  'resolver.createCertifiedSystemIdentityAuthority': 'systemIdentityAuthority',
  'resolver.createCertifiedCanonicalObjectAuthority': 'canonicalObjectAuthority',
  'resolver.<resolver>.resolveApprovedBinding': 'bindingResolution',
})

// Brands a value carries. TRI-STATE ON THE CHECKER ITSELF: a checker that THROWS has
// not answered "no", and must never be recorded as "no" (round 6, P2-C).
function brandsHeldBy(value, violations, label) {
  const held = []
  for (const [brand, check] of Object.entries(TRUST_CHECKERS)) {
    let answer
    try {
      answer = check(value)
    } catch (error) {
      violations.push(`${label}: the ${brand} checker THREW (${describeErrorSafely(error)}) — a check that failed is not a "no"`)
      continue
    }
    if (answer === true) held.push(brand)
    else if (answer !== false) violations.push(`${label}: the ${brand} checker answered ${String(answer)}, not a boolean`)
  }
  return held
}

function describeErrorSafely(error) {
  try { return String(error && error.constructor && error.constructor.name) } catch (_e) { return 'unreadable' }
}

function attackerSeedPool() {
  const hostileHandle = { execute: async () => ({ duplicateGroupsSampled: 0, nullKeyRowsSampled: 0 }) }
  return [
    undefined, null, 0, 1, '', 'x', true, false,
    {}, [], () => {}, async () => {},
    // PLAUSIBLE arguments — the point is to let a factory SUCCEED wherever it can, not
    // to feed it only garbage it would have refused anyway.
    [{
      actionProfileVersion: 'attacker.profile.v1', actionId: 'a', actionVersion: 'v',
      connectorKind: 'erp_http', sourceFieldFor: () => 'col', execute: async () => ({}),
    }],
    [{ systemContentKey: 'ATTACKER-SCK', credentialFactory: () => hostileHandle }],
    [{ contractId: 'attacker', contractVersion: 'v1', canonicalObjectVersion: 'attacker/1' }],
    { 'attacker-system': 'ATTACKER-SCK' },
    { actionRegistry: {}, sourceBinder: {} },
    { configStore: {}, systemIdentityAuthority: {}, canonicalObjectAuthority: {} },
    { tenantId: 't', workspaceId: null, approvedConfigVersionId: 'cfg' },
    { value: 1 },
  ]
}

function functionExportsOf(label, table) {
  const out = []
  for (const key of Object.keys(table)) {
    const value = table[key]
    if (typeof value === 'function') out.push({ name: `${label}.${key}`, fn: value })
    else if (key === '__internals' && value && typeof value === 'object') {
      for (const inner of Object.keys(value)) {
        if (typeof value[inner] === 'function') out.push({ name: `${label}.__internals.${inner}`, fn: value[inner] })
      }
    } else if (value && typeof value === 'object') {
      for (const inner of Object.keys(value)) {
        if (typeof value[inner] === 'function') out.push({ name: `${label}.${key}.${inner}`, fn: value[inner] })
      }
    }
  }
  return out
}

const MAX_POOL = 64

// A value's admission-relevant shape: what a downstream factory's checks can see.
function shapeOf(value) {
  const kind = typeof value
  if (kind === 'function') return 'function'
  let keys = []
  try { keys = Object.keys(value).sort() } catch (_error) { return 'unreadable' }
  let inner = ''
  if (Array.isArray(value)) {
    try {
      inner = value.length === 0 ? '[]' : `[${Object.keys(value[0] || {}).sort().join(',')}]`
    } catch (_error) { inner = '[unreadable]' }
    return `array${inner}`
  }
  return `object{${keys.join(',')}}`
}

async function saturateAndFindMintingPaths(tables, rounds) {
  const violations = []
  const found = new Map()
  const seen = new Set()
  const pool = []
  // Every trusted value the closure has reached so far. It is what makes TRANSITIVE
  // trust findable: a factory that admits COMPONENTS never sees a pooled value as an
  // argument, it sees a RECORD built out of them.
  // ONE REPRESENTATIVE PER BRAND. Every successful factory call mints a NEW trusted
  // object, so keeping them all made composition O(n^3) over thousands and the process
  // ran out of heap. For composition one trusted registry is interchangeable with any
  // other — what the next factory reads is the BRAND — so the closure keeps exactly one
  // of each and stays finite. `trustedBrandsReached` is reported so a run that reached
  // fewer brands than the ledger declares is visible rather than silent.
  const trustedByBrand = new Map()
  const record = (name, value) => {
    const brands = brandsHeldBy(value, violations, name)
    for (const brand of brands) if (!trustedByBrand.has(brand)) trustedByBrand.set(brand, value)
    for (const brand of brands) {
      if (!found.has(name)) found.set(name, new Set())
      found.get(name).add(brand)
    }
  }

  // COMPOSITION. The first version of this sweep called every export with pooled values
  // as ARGUMENTS and nothing else, and it therefore MISSED
  // `createServerBoundSourceExecutor` entirely: that factory takes a RECORD whose two
  // members must both already be trusted, and no amount of passing a trusted registry
  // as an argument ever builds one. A sweep that misses the transitive path is a sweep
  // that would report a closure the moment the leaves were closed, without ever having
  // been able to see the composite. The component key sets are not secret — they are
  // the modules' own closed-key-set checks — so the closure builds records over them
  // from everything trusted it has reached.
  const COMPONENT_KEY_SETS = [
    ['actionRegistry', 'sourceBinder'],
    ['configStore', 'systemIdentityAuthority', 'canonicalObjectAuthority'],
  ]
  const composeRecords = () => {
    const out = []
    for (const keys of COMPONENT_KEY_SETS) {
      const candidates = [...trustedByBrand.values()]
      const build = (index, draft) => {
        if (index === keys.length) { out.push({ ...draft }); return }
        for (const candidate of candidates) build(index + 1, { ...draft, [keys[index]]: candidate })
      }
      if (candidates.length > 0) build(0, {})
    }
    return out
  }
  // BOUNDED. Feeding every produced value back unbounded is N^2 per round over a pool
  // that grows every round — it does not terminate in useful time and a saturation
  // nobody can run is a saturation nobody runs. Primitives are seeded once and never
  // re-added (they cannot carry a brand); objects and functions are capped, and the cap
  // is asserted NOT to have been hit, so a silently truncated sweep cannot pass as a
  // complete one.
  let capHits = 0
  const shapes = new Set()
  const addToPool = (value) => {
    if (value === null || value === undefined
      || (typeof value !== 'object' && typeof value !== 'function')) return
    if (seen.has(value)) return
    // DEDUPE BY SHAPE. Feeding back every produced object is N^2 over a pool that grows
    // every round: the first attempt produced 72,573 values and did not terminate in
    // useful time. What matters for trust is a value's SHAPE, because that is what the
    // next factory's admission check reads — two frozen `{size,resolve}` registries are
    // the same candidate. One representative per shape keeps the closure honest and
    // finite; `capHits` is asserted to be zero so a TRUNCATED sweep can never pass as a
    // complete one.
    const shape = shapeOf(value)
    if (shapes.has(shape)) return
    if (pool.length >= MAX_POOL) { capHits += 1; return }
    shapes.add(shape)
    seen.add(value)
    pool.push(value)
  }

  for (const value of attackerSeedPool()) {
    if (value === null || value === undefined
      || (typeof value !== 'object' && typeof value !== 'function')) pool.push(value)
    else addToPool(value)
  }
  const exportsList = []
  for (const [label, table] of Object.entries(tables)) {
    for (const key of Object.keys(table)) addToPool(table[key])
    for (const entry of functionExportsOf(label, table)) exportsList.push(entry)
  }

  let calls = 0
  let compositesTried = 0
  for (let round = 0; round < rounds; round += 1) {
    const snapshot = pool.slice()
    const produced = []
    for (const entry of exportsList) {
      for (const first of snapshot) {
        // Arity 1 AND arity 2 — a two-argument call can succeed where a one-argument
        // call refuses, and vice versa.
        calls += 1
        try {
          let single = entry.fn(first)
          if (single && typeof single.then === 'function') single = await single
          record(entry.name, single)
          produced.push(single)
        } catch (_error) { /* a refusal is the expected answer; it is not a finding */ }
        for (const second of snapshot) {
          calls += 1
          try {
            let result = entry.fn(first, second)
            if (result && typeof result.then === 'function') result = await result
            record(entry.name, result)
            produced.push(result)
          } catch (_error) { /* refused */ }
        }
      }
    }
    for (const value of produced) addToPool(value)
    // Composites live in their OWN list and are passed as the SOLE argument, for two
    // measured reasons:
    //   * they must BYPASS the shape dedupe — the attacker seed pool already carries
    //     `{ actionRegistry, sourceBinder }` filled with untrusted objects, the
    //     IDENTICAL shape, so shape-dedupe silently dropped every trusted composite and
    //     the sweep reported `createServerBoundSourceExecutor` as minting nothing;
    //   * and they must NOT enter the N^2 argument pool — 6 brands compose into 252
    //     records per round, which blew the pool cap (486 dropped) and would have made
    //     the sweep quadratic in them for no gain: a components record is only ever
    //     read as ONE argument.
    const composites = composeRecords()
    for (const entry of exportsList) {
      for (const composite of composites) {
        // ONE try PER CALL. Wrapping the inner loop instead would let the FIRST export
        // that refuses abort every export after it — a sweep that stops at the first
        // refusal reports "nothing mints" and looks like a closure.
        calls += 1
        try {
          let result = entry.fn(composite)
          if (result && typeof result.then === 'function') result = await result
          record(entry.name, result)
          produced.push(result)
        } catch (_error) { /* a refusal is the expected answer, not a finding */ }
      }
    }
    compositesTried += composites.length
  }
  return {
    violations, found, calls, poolSize: pool.length,
    exportCount: exportsList.length, capHits, compositesTried,
    trustedBrandsReached: [...trustedByBrand.keys()].sort(),
  }
}

async function publicSurfaceMintsExactlyTheDeclaredTrust() {
  const result = await saturateAndFindMintingPaths({
    executor: executorModule,
    resolver: resolverModule,
    observability: require(path.join(LIB, 'gip-read-observability-contracts.cjs')),
    gate: require(path.join(LIB, 'gip-inert-entry.cjs')),
  }, 3)

  assert.deepEqual(result.violations, [],
    `trust checkers must answer, not throw:\n  ${result.violations.join('\n  ')}`)
  // The saturation must be shown to have DONE something — one that made zero calls
  // finds zero minting paths and passes every assertion below it.
  assert.ok(result.calls > 20000, `the saturation made too few calls (${result.calls})`)
  assert.ok(result.exportCount >= 20, `too few function exports walked (${result.exportCount})`)
  assert.ok(result.compositesTried > 0,
    'the closure never built a COMPONENTS record — transitive minting would be invisible')
  // WHICH BRANDS the closure actually reached. Without this, a sweep that reached only
  // two brands and found only two minting paths would satisfy a set equality written
  // for those two, and the missing five would read as "closed".
  assert.deepEqual(result.trustedBrandsReached, [
    'canonicalObjectAuthority', 'httpProbeActionRegistry',
    'serverBoundSourceExecutor', 'sourceBinder', 'systemIdentityAuthority',
  ], 'the closure must reach every brand the ledger says is publicly mintable except bindingResolution, '
    + 'which needs a first-party config store the pool does not seed')
  assert.equal(result.capHits, 0,
    `the saturation pool hit its cap (${result.capHits} values dropped) — the sweep is TRUNCATED and its `
    + 'set equality below would be a statement about a subset, not about the public surface')

  const swept = {}
  for (const [name, brands] of result.found) swept[name] = [...brands].sort().join('+')

  assert.deepEqual(Object.keys(swept).sort(), [
    'executor.createHarnessHttpProbeActionRegistryForTests',
    'executor.createHarnessSourceBinderForTests',
    'executor.createServerBoundSourceExecutor',
    'resolver.createCertifiedCanonicalObjectAuthority',
    'resolver.createCertifiedSystemIdentityAuthority',
    'resolver.createHarnessCanonicalObjectAuthorityForTests',
    'resolver.createHarnessSystemIdentityAuthorityForTests',
  ], `the SATURATED public surface mints trust from a different set than declared:\n${JSON.stringify(swept, null, 2)}`)

  // "We found seven names" is not "the seven mint what the ledger says they mint".
  for (const [name, brand] of Object.entries(swept)) {
    assert.equal(DECLARED_TRUST_MINTING_PATHS[name], brand,
      `${name} mints ${brand}; the ledger declares ${DECLARED_TRUST_MINTING_PATHS[name]}`)
  }

  // AND THE ONE THE SWEEP CANNOT REACH, EXECUTED DIRECTLY so the ledger is complete.
  const stack = buildStack()
  const resolution = await resolveAlpha(stack.resolver)
  assert.equal(resolverModule.isTrustedBindingResolution(resolution), true,
    'resolveApprovedBinding is declared as the eighth minting path; it must actually mint')
  assert.equal(Object.keys(DECLARED_TRUST_MINTING_PATHS).length, Object.keys(swept).length + 1,
    'the declared ledger must be exactly the swept set plus the directly-executed resolution path')

  console.log(`  TRUST-SURFACE ${result.calls} calls over ${result.exportCount} exports, pool=${result.poolSize}: `
    + `${Object.keys(swept).length} minting paths swept + 1 executed directly = ${Object.keys(DECLARED_TRUST_MINTING_PATHS).length} declared`)
}

// ---------------------------------------------------------------------------
// ADDING A GRANTING FACTORY BACK MUST RED — the positive control the owner named.
//
// Everything above asserts a SET EQUALITY. A saturation that silently reached nothing,
// or a `found` map that is never written to, would satisfy it against nothing. So the
// SAME saturation runs over a synthetic table carrying ONE granting factory added back,
// and it must find it AND NAME it, and must NOT smear onto its honest sibling. This
// runs on every CI run; it is not a substitute for mutating the real module, which is
// recorded separately in the PR body.
// ---------------------------------------------------------------------------
async function addingAGrantingFactoryBackIsFound() {
  const stack = buildStack()
  const syntheticTable = {
    // "A public factory whose products are trusted" reduces to exactly this.
    reAddedGrantingFactory() { return stack.sourceBinder },
    // Its control sibling: a public factory whose product is NOT trusted.
    honestUntrustedFactory() { return { handleFor() { return null } } },
  }
  const result = await saturateAndFindMintingPaths({ synthetic: syntheticTable }, 1)
  const names = [...result.found.keys()].sort()
  assert.deepEqual(names, ['synthetic.reAddedGrantingFactory'],
    `the sweep must NAME a re-added granting factory and must not smear onto its honest sibling; got ${JSON.stringify(names)}`)
  assert.deepEqual([...result.found.get('synthetic.reAddedGrantingFactory')], ['sourceBinder'],
    'the sweep must name WHICH brand the re-added factory mints')
  console.log('  RE-ADD CONTROL the sweep named synthetic.reAddedGrantingFactory (sourceBinder), 0 on the honest sibling')
}

// ---------------------------------------------------------------------------
// ROUND 6, P1-A — NO SUITE MAY JUDGE THE TWO IN-SCOPE BRANDS BY `instanceof`/`.name`.
//
// The behavioural proof that the brand holds lives in `forgedBrandsAreRefused()` in
// the gate suite. THIS is the COMPLETENESS half: a forgery test proves the checker
// works, it does NOT prove that every assertion in five files actually uses it. One
// leftover `caught instanceof GipSourceExecutorError` is a cell that passes on a
// prototype forgery, and finding those by reading is exactly how three rounds of this
// PR shipped a stale claim.
//
// SCOPE THE INSTRUMENT HONESTLY (source-text assertions are not behaviour assertions):
// this is a SOURCE-TEXT sweep. It cannot prove behaviour and a determined edit can
// route around it. What it does is keep the criterion FIXED — a newly written
// `instanceof`-based brand assertion on either in-scope class REDs, naming the file
// and line. The count pin on the DISCLOSED `GipQualificationError` residual does the
// same job in the other direction: closing that residual, or adding a new one, REDs
// and forces this ledger entry to be revised rather than left stale.
// ---------------------------------------------------------------------------
function noSuiteJudgesInScopeBrandsByInstanceof() {
  const fs = require('node:fs')
  const SUITES = [
    'gip-inert-entry-gate.test.cjs',
    'gip-server-bound-source-executor.test.cjs',
    'gip-approved-binding-resolver.test.cjs',
    'gip-read-observability-contracts.test.cjs',
    'gip-binding-qualification-spike.test.cjs',
  ]
  // The two classes whose modules ARE in this PR's scope and DO carry an unforgeable
  // checker. Zero tolerance: there is a correct instrument, so nothing may use the
  // forgeable one.
  const IN_SCOPE = /instanceof\s+(?:\w+\.)?(?:GipSourceExecutorError|GipApprovedBindingResolverError)\b/
  // `.name`-based brandedness — the criterion behind the RETRACTED 0/12 matrix.
  const NAME_CRITERION = /\.name\s*!==\s*'Error'|\.name\s*===\s*'Gip\w*Error'/
  const violations = []
  let scanned = 0
  let disclosedResidual = 0

  for (const suite of SUITES) {
    const lines = fs.readFileSync(path.join(__dirname, suite), 'utf8').split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      scanned += 1
      // Comments are the ledger; they DESCRIBE the retired criterion by name and must
      // not be mistaken for uses of it.
      if (/^\s*(\/\/|\*)/.test(line)) continue
      if (IN_SCOPE.test(line)) violations.push(`${suite}:${index + 1}: ${line.trim()}`)
      if (NAME_CRITERION.test(line)) violations.push(`${suite}:${index + 1}: name-based brand criterion: ${line.trim()}`)
      if (/instanceof\s+GipQualificationError\b/.test(line)) disclosedResidual += 1
    }
  }

  assert.deepEqual(violations, [],
    `an in-scope brand is still judged by a forgeable criterion:\n  ${violations.join('\n  ')}`)
  // The sweep must be shown to have READ something — a scan over zero lines passes
  // every assertion above it.
  assert.ok(scanned > 3000, `the sweep read too few lines (${scanned})`)
  // EXACTLY THREE disclosed residual sites, and they are named so the pin is a ledger
  // rather than a number:
  //   1. `judgeQualificationBrand` (spike suite) — the ONE criterion every spike-side
  //      refusal assertion routes through. Every other call site was converted.
  //   2. `brandedErrorChannelIsOpenOnTheSpikeClass` — asserts the residual POSITIVELY.
  //   3. `spikeClassHasNoUnforgeableBrand` — asserts the prototype forgery is accepted
  //      by that class and REFUSED by both in-scope classes.
  // All three are ASSERTIONS ABOUT the residual, not uses of it to prove a refusal.
  assert.equal(disclosedResidual, 3,
    `the DISCLOSED GipQualificationError residual is pinned at exactly 3 named sites; found ${disclosedResidual}. `
    + 'More means a new forgeable criterion was written; fewer means the residual was closed and the '
    + 'disclosure comments plus the PR ledger must be updated.')
  console.log(`  BRAND-SWEEP ${scanned} lines across ${SUITES.length} suites: 0 forgeable in-scope criteria, ${disclosedResidual} disclosed residual`)
}

// ---------------------------------------------------------------------------
// ROUND 6 — THE DISCLOSED RESIDUAL, PINNED POSITIVELY.
// `GipQualificationError` carries NO unforgeable brand, because the spike module's
// `fail()` and error class are byte-identical to `origin/main` and are therefore
// outside this PR's scope. Asserting the residual EXISTS is what stops the disclosure
// from going stale: when a future PR brands that class, this REDs.
// ---------------------------------------------------------------------------
function spikeClassHasNoUnforgeableBrand() {
  assert.equal(typeof spikeModule.isBrandedQualificationError, 'undefined',
    'the spike module now exposes a brand checker — the round-6 disclosure is stale and must be revised')
  // And the forgery the missing brand admits, EXECUTED rather than asserted in prose.
  const forged = Object.create(GipQualificationError.prototype)
  forged.message = ATTACKER_TEXT
  forged.reason = 'QUALIFICATION_INPUT_INVALID'
  assert.ok(forged instanceof GipQualificationError,
    'the residual is that `instanceof` accepts a prototype forgery on this class')
  assert.equal(judgeBranded(GipQualificationError, forged), true,
    'DISCLOSED: with no unforgeable checker, the helper accepts a forgery on this class')
  // The two IN-SCOPE classes refuse the identical construction — the exclusive
  // failure that shows the fix is real and not a relabelling.
  const forgedExecutor = Object.create(GipSourceExecutorError.prototype)
  forgedExecutor.message = ATTACKER_TEXT
  assert.equal(judgeBranded(GipSourceExecutorError, forgedExecutor), false,
    'the in-scope brand must refuse the identical prototype forgery')
  const forgedResolver = Object.create(GipApprovedBindingResolverError.prototype)
  assert.equal(judgeBranded(GipApprovedBindingResolverError, forgedResolver), false,
    'the in-scope brand must refuse the identical prototype forgery')
  console.log('  RESIDUAL spike class unbranded (disclosed); both in-scope classes refuse the same forgery')
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
    // ROUND 6, P1-A. CHECKERS, not granters — predicates over objects that already
    // exist. They admit nothing and mint nothing, and they exist so that no assertion
    // anywhere has to fall back on the forgeable `instanceof`/`.name` criteria.
    'isBrandedSourceExecutorError',
    // ROUND 6, ITEM 2. CHECKERS for the two leaf brands this module owns, added so the
    // trust-minting surface can be ENUMERATED MECHANICALLY instead of argued in prose.
    'isTrustedHttpProbeActionRegistry',
    'isTrustedServerBoundSourceExecutor',
    'isTrustedSourceBinder',
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
    'isBrandedApprovedBindingResolverError',
    'isTrustedBindingResolution',
    'isTrustedCanonicalObjectAuthority',
    'isTrustedSystemIdentityAuthority',
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
  await hostileGetterOnTheVerifiedQualificationIsRefusedNotLeaked()
  // --- B1a-3 round 4 ---
  await hostileGetterOnTheProberComponentsIsRefusedNotLeaked()
  await ownKeysTrapDuringRunInputEnumerationIsRefusedNotLeaked()
  await outerVerifyArgumentIsGuardedNotDestructuredRaw()
  await expiresAtIsReadExactlyOnceOnTheVerifyPath()
  await expiresAtIsReadExactlyOnceOnTheProbePath()
  duplicateSystemContentKeyIsRefusedNotLastWins()
  brandedErrorChannelIsOpenOnTheSpikeClass()
  exportSurfacesArePinned()
  await probeAuthorityIsClosureBoundNotCallerInjected()
  await publicSurfaceMintsExactlyTheDeclaredTrust()
  await addingAGrantingFactoryBackIsFound()
  noSuiteJudgesInScopeBrandsByInstanceof()
  spikeClassHasNoUnforgeableBrand()
  latentByEnumeration()
  console.log('gip-server-bound-source-executor.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
