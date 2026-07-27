'use strict'

// GIP B1a — the approved-binding resolver (§3.1 ⟲R2/⟲R3), the precondition of
// §4 step 1.4. Hermetic: a REAL `createReadSourceConfigStore` over an in-memory db
// double, so every config object the resolver sees comes out of the REAL read
// projection (`rowToPublicReadSourceConfig` — null-prototype, sanitized), not a
// hand-built plain-object double. That fixture shape is load-bearing: a plain,
// unsanitized double is the shape `getForRuntime` NEVER produces, and it is the most
// likely reason the lossy-read problem survived undetected before.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const storeModule = require(path.join(LIB, 'read-source-config-store.cjs'))
const resolverModule = require(path.join(LIB, 'gip-approved-binding-resolver.cjs'))
const { validateReadSourceConfig } = require(path.join(LIB, 'read-source-config.cjs'))
const { CANONICAL_OBJECT_CONTRACT_REGISTRY } = require(path.join(LIB, 'gip-canonical-object-contract-registry.cjs'))
const { createUntrustedSystemIdentityServiceForTests } = require(path.join(LIB, 'gip-system-identity-read.cjs'))
const {
  createHarnessHttpProbeActionRegistryForTests,
  createHarnessSourceBinderForTests,
  createServerBoundSourceExecutor,
} = require(path.join(LIB, 'gip-server-bound-source-executor.cjs'))
const { createBindingQualificationProber } = require(path.join(LIB, 'gip-binding-qualification-spike.cjs'))

const { createReadSourceConfigStore, isFirstPartyReadSourceConfigStore, __internals: { contentKeyFor } } = storeModule
const {
  GipApprovedBindingResolverError,
  BINDING_RESOLVER_ERROR_REASONS,
  RESOLUTION_KEYS,
  createApprovedBindingResolver,
  createCertifiedSystemIdentityAuthority,
  createCertifiedCanonicalObjectAuthority,
  createHarnessSystemIdentityAuthorityForTests,
  createHarnessCanonicalObjectAuthorityForTests,
  isTrustedBindingResolution,
  assertTrustedBindingResolution,
  isBrandedApprovedBindingResolverError,
} = resolverModule

const PROFILE = 'fixture.http_read.v1'
const ENVELOPE_KEY = Object.freeze({ keyId: 'kres', secret: Buffer.alloc(32, 3) })

function refusesWith(fn, expectedReason) {
  let caught = null
  try { fn() } catch (error) { caught = error }
  assert.ok(isBrandedApprovedBindingResolverError(caught),
    `expected an error MINTED by the module (unforgeable brand), got ${caught && caught.name}: ${caught && caught.message}`)
  assert.equal(caught.reason, expectedReason)
  return caught
}

async function refusesWithAsync(fn, expectedReason) {
  let caught = null
  try { await fn() } catch (error) { caught = error }
  assert.ok(isBrandedApprovedBindingResolverError(caught),
    `expected an error MINTED by the module (unforgeable brand), got ${caught && caught.name}: ${caught && caught.message}`)
  assert.equal(caught.reason, expectedReason)
  return caught
}

function keySet(object) { return Object.keys(object).sort() }

// --- fixtures ---------------------------------------------------------------

function body(overrides = {}) {
  const fieldCount = overrides.fieldCount || 3
  const fieldMap = []
  for (let i = 1; i <= fieldCount; i += 1) fieldMap.push({ source: `Src${i}`, target: `tgt_${i}` })
  const base = {
    version: 1,
    systemId: 'sys-alpha',
    object: 'material_master',
    mode: 'list_page',
    requiredKind: 'erp_http',
    operations: ['read'],
    readPath: 'api/objects',
    readMethod: 'GET',
    containerPaths: ['Data'],
    fieldMap,
    orderingKeySpec: [{ fieldId: 'tgt_1', direction: 'ASC' }, { fieldId: 'tgt_2', direction: 'DESC' }],
    actionProfileVersion: PROFILE,
  }
  delete overrides.fieldCount
  return { ...base, ...overrides }
}

// The row is produced the way `saveVersion` produces it: content key over the
// UNSANITIZED normalized body, `version` overwritten with the minted row version.
function rowFor(id, configBody, mutate) {
  const validated = validateReadSourceConfig(configBody)
  assert.ok(validated.valid, `fixture must validate: ${JSON.stringify(validated.errors)}`)
  const stored = JSON.parse(JSON.stringify(validated.normalized))
  stored.version = 1
  const row = {
    id,
    tenant_id: 't-1',
    workspace_id: null,
    system_id: configBody.systemId,
    object: configBody.object,
    mode: configBody.mode,
    config: stored,
    content_key: contentKeyFor(validated.normalized),
    version: 1,
    status: 'approved',
  }
  if (typeof mutate === 'function') mutate(row)
  return row
}

function storeOver(rows) {
  return createReadSourceConfigStore({
    db: {
      async selectOne(_t, where) {
        return rows.find((row) => Object.keys(where).every((key) => row[key] === where[key])) || null
      },
      async select() { return [] },
      async insertOne() { return null },
      async updateRow() { return null },
      async transaction(fn) { return fn(this) },
    },
  })
}

function harnessAuthorities() {
  return {
    systemIdentityAuthority: createHarnessSystemIdentityAuthorityForTests({
      'sys-alpha': 'SCK-ALPHA-DISTINGUISHABLE',
      'sys-beta': 'SCK-BETA-DISTINGUISHABLE',
    }),
    canonicalObjectAuthority: createHarnessCanonicalObjectAuthorityForTests([
      { contractId: 'material_master', contractVersion: PROFILE, canonicalObjectVersion: 'com.acme.material/7' },
      { contractId: 'material_master', contractVersion: 'fixture.http_read.v2', canonicalObjectVersion: 'com.acme.material/9' },
    ]),
  }
}

function resolverOver(rows) {
  return createApprovedBindingResolver({ configStore: storeOver(rows), ...harnessAuthorities() })
}

const RUN = { tenantId: 't-1', workspaceId: null, approvedConfigVersionId: 'cfg-1' }

// ---------------------------------------------------------------------------
// The six-field tuple, complete and server-derived. POSITIVE CONTROL FIRST.
// ---------------------------------------------------------------------------
async function tupleIsCompleteAndServerDerived() {
  const resolver = resolverOver([rowFor('cfg-1', body())])
  const resolution = await resolver.resolveApprovedBinding(RUN)

  // SET EQUALITY on the resolution object, not containment.
  assert.deepEqual(keySet(resolution), [...RESOLUTION_KEYS].sort())
  assert.deepEqual([...RESOLUTION_KEYS], [
    'actionProfileVersion', 'systemContentKey', 'configContentKey',
    'objectKey', 'canonicalObjectVersion', 'orderingKeySpec',
  ])
  assert.equal(resolution.actionProfileVersion, PROFILE)
  assert.equal(resolution.objectKey, 'material_master')
  assert.equal(resolution.canonicalObjectVersion, 'com.acme.material/7')
  assert.deepEqual(resolution.orderingKeySpec.map((e) => `${e.fieldId}:${e.direction}`), ['tgt_1:ASC', 'tgt_2:DESC'])
  assert.ok(isTrustedBindingResolution(resolution))
  assert.equal(assertTrustedBindingResolution(resolution), resolution)

  // `systemContentKey` is OBTAINED, never derived here — pinned by PROVENANCE: the
  // authority returns a DISTINGUISHABLE value that the tuple must carry VERBATIM, so
  // a locally-computed value of the right SHAPE cannot pass.
  assert.equal(resolution.systemContentKey, 'SCK-ALPHA-DISTINGUISHABLE')

  // `canonicalObjectVersion` is a LOOKUP, not a function of the other tuple fields:
  // two configs identical except for `actionProfileVersion` follow the REGISTRY.
  const two = resolverOver([
    rowFor('cfg-1', body()),
    rowFor('cfg-2', body({ actionProfileVersion: 'fixture.http_read.v2' })),
  ])
  const first = await two.resolveApprovedBinding(RUN)
  const second = await two.resolveApprovedBinding({ ...RUN, approvedConfigVersionId: 'cfg-2' })
  assert.equal(first.canonicalObjectVersion, 'com.acme.material/7')
  assert.equal(second.canonicalObjectVersion, 'com.acme.material/9')
  assert.equal(first.objectKey, second.objectKey)
  assert.equal(first.systemContentKey, second.systemContentKey)

  // `configContentKey` is the RECOMPUTED value and it equals the stored column.
  assert.equal(resolution.configContentKey, contentKeyFor(validateReadSourceConfig(body()).normalized))
}

// ---------------------------------------------------------------------------
// Run input is a CLOSED ALLOWLIST, and no field may be caller-supplied.
// ---------------------------------------------------------------------------
async function runInputIsAClosedAllowlist() {
  const resolver = resolverOver([rowFor('cfg-1', body())])

  for (const key of [
    'objectKey', 'actionProfileVersion', 'orderingKeySpec', 'systemContentKey',
    'configContentKey', 'canonicalObjectVersion', 'configStore', 'systemIdentityAuthority',
    'query', 'aTotallyNovelKeyName',
  ]) {
    await refusesWithAsync(() => resolver.resolveApprovedBinding({ ...RUN, [key]: 'x' }), 'RESOLVER_RUN_INPUT_INVALID')
  }
  const symbolKeyed = { ...RUN }
  symbolKeyed[Symbol('configStore')] = {}
  await refusesWithAsync(() => resolver.resolveApprovedBinding(symbolKeyed), 'RESOLVER_RUN_INPUT_INVALID')
  await refusesWithAsync(() => resolver.resolveApprovedBinding(null), 'RESOLVER_RUN_INPUT_INVALID')
  await refusesWithAsync(() => resolver.resolveApprovedBinding({ tenantId: 't-1' }), 'RESOLVER_RUN_INPUT_INVALID')

  // POSITIVE CONTROL — the legal input set still resolves.
  assert.ok(isTrustedBindingResolution(await resolver.resolveApprovedBinding(RUN)))
}

// ---------------------------------------------------------------------------
// Approval, tenancy and scope re-verified at resolution time; ONE merged reason.
// ---------------------------------------------------------------------------
async function approvalTenancyAndScope() {
  const rows = [rowFor('cfg-1', body())]
  const resolver = resolverOver(rows)
  assert.ok(isTrustedBindingResolution(await resolver.resolveApprovedBinding(RUN)))

  // Revoke AFTER a successful resolution: the next resolution must NOT be honoured
  // from a cached decision.
  rows[0].status = 'retired'
  await refusesWithAsync(() => resolver.resolveApprovedBinding(RUN), 'RESOLVER_APPROVED_CONFIG_UNAVAILABLE')
  rows[0].status = 'approved'
  assert.ok(isTrustedBindingResolution(await resolver.resolveApprovedBinding(RUN)))

  // Wrong tenant, wrong workspace, unknown id — ALL collapse to the SAME outward
  // reason, so the resolver is not a cross-tenant existence oracle.
  const oracle = []
  for (const run of [
    { ...RUN, tenantId: 't-2' },
    { ...RUN, workspaceId: 'w-9' },
    { ...RUN, approvedConfigVersionId: 'cfg-does-not-exist' },
  ]) {
    oracle.push((await refusesWithAsync(() => resolver.resolveApprovedBinding(run), 'RESOLVER_APPROVED_CONFIG_UNAVAILABLE')).message)
  }
  assert.equal(new Set(oracle).size, 1, 'exists-but-not-yours and does-not-exist must be indistinguishable')
}

// ---------------------------------------------------------------------------
// `configContentKey` recomputed and COMPARED; the lossy-read cliff is NAMED.
// ---------------------------------------------------------------------------
async function contentKeyIsRecomputedAndCompared() {
  // A stored column that disagrees with the body is a closed refusal — the column is
  // never trusted.
  const tampered = resolverOver([rowFor('cfg-1', body(), (row) => { row.content_key = 'f'.repeat(64) })])
  await refusesWithAsync(() => tampered.resolveApprovedBinding(RUN), 'RESOLVER_CONFIG_CONTENT_KEY_MISMATCH')

  // A body edited after approval likewise fails the compare.
  const edited = resolverOver([rowFor('cfg-1', body(), (row) => { row.config.readPath = 'api/other' })])
  await refusesWithAsync(() => edited.resolveApprovedBinding(RUN), 'RESOLVER_CONFIG_CONTENT_KEY_MISMATCH')

  // POSITIVE CONTROL — an untampered version resolves and the keys match.
  const ok = resolverOver([rowFor('cfg-1', body())])
  const resolution = await ok.resolveApprovedBinding(RUN)
  assert.equal(resolution.configContentKey.length, 64)

  // THE LOSSY-READ CLIFF (RQ-1, UNRULED — no lossless store read is added here).
  // `getForRuntime` returns `sanitizeIntegrationPayload(row.config)`, whose arrays
  // truncate at 50, while the stored content key was computed over the UNSANITIZED
  // body. A legal 51-entry fieldMap is therefore UNRESOLVABLE at this head. What this
  // slice changes is that it is NAMED — NOT_LOSSLESS, i.e. "the read was lossy" —
  // rather than reported as CONTENT_KEY_MISMATCH, i.e. accusing the database of
  // tampering. Door 5 fires BEFORE door 4, which is what makes the two attributable.
  const fifty = resolverOver([rowFor('cfg-1', body({ fieldCount: 50 }))])
  assert.ok(isTrustedBindingResolution(await fifty.resolveApprovedBinding(RUN)),
    'the 50-entry positive control must RESOLVE — otherwise the 51-entry result below proves nothing')
  const fiftyOne = resolverOver([rowFor('cfg-1', body({ fieldCount: 51 }))])
  await refusesWithAsync(() => fiftyOne.resolveApprovedBinding(RUN), 'RESOLVER_APPROVED_CONFIG_NOT_LOSSLESS')
}

// ---------------------------------------------------------------------------
// ⟲R6's closed schema, RE-CHECKED at resolution time, UPPERCASE-strict.
// ---------------------------------------------------------------------------
async function orderingKeySpecClosedSchema() {
  // Each clause dropped in turn. These bodies bypass the validator on purpose — the
  // resolver must not assume the stored body met the CURRENT validator, because a
  // body approved under an older one, or a manually inserted row, is reachable.
  function rowWithSpec(spec) {
    const validated = validateReadSourceConfig(body())
    const stored = JSON.parse(JSON.stringify(validated.normalized))
    stored.version = 1
    stored.orderingKeySpec = spec
    return {
      id: 'cfg-1', tenant_id: 't-1', workspace_id: null, system_id: 'sys-alpha',
      object: 'material_master', mode: 'list_page', config: stored,
      content_key: contentKeyFor({ ...validated.normalized, orderingKeySpec: spec }),
      version: 1, status: 'approved',
    }
  }
  for (const spec of [
    [],
    [{ fieldId: 'tgt_1', direction: 'ASC' }, { fieldId: 'tgt_1', direction: 'DESC' }], // duplicate
    [{ fieldId: 'not_a_target', direction: 'ASC' }],                                   // unresolvable
    [{ fieldId: 'tgt_1', direction: 'asc' }],                                          // lowercase
    [{ fieldId: 'tgt_1', direction: 'ASCENDING' }],
    [{ fieldId: 'tgt_1', direction: 'ASC', nullable: true }],                          // widened entry shape
    [{ fieldId: 'tgt_1' }],
    'tgt_1 ASC',
  ]) {
    await refusesWithAsync(
      () => resolverOver([rowWithSpec(spec)]).resolveApprovedBinding(RUN),
      'RESOLVER_ORDERING_KEY_SPEC_INVALID',
    )
  }
  // POSITIVE CONTROL — a legal spec resolves, IN ORDER.
  const ok = await resolverOver([rowWithSpec([
    { fieldId: 'tgt_2', direction: 'DESC' }, { fieldId: 'tgt_1', direction: 'ASC' },
  ])]).resolveApprovedBinding(RUN)
  assert.deepEqual(ok.orderingKeySpec.map((e) => e.fieldId), ['tgt_2', 'tgt_1'])
  assert.deepEqual(keySet(ok.orderingKeySpec[0]), ['direction', 'fieldId'])
}

// ---------------------------------------------------------------------------
// ⟲R2 — deep-immutable, and THE LEDGER'S MANDATED NEGATIVE CONTROL, which is not
// optional: "mutate the ORIGINAL field array from inside the async query callback
// and prove the probe still uses the parse-time copy."
// ---------------------------------------------------------------------------
async function deepImmutabilityAndTheMandatedAsyncControl() {
  const resolver = resolverOver([rowFor('cfg-1', body())])
  const resolution = await resolver.resolveApprovedBinding(RUN)

  // Frozen by TRAVERSAL, not by Object.isFrozen on the root alone.
  const nodes = []
  ;(function walk(value) {
    if (!value || typeof value !== 'object') return
    nodes.push(value)
    for (const key of Object.keys(value)) walk(value[key])
  })(resolution)
  assert.ok(nodes.length >= 4, 'the traversal must reach the nested orderingKeySpec entries')
  for (const node of nodes) assert.ok(Object.isFrozen(node), 'every nested node must be frozen')

  // The strict canonical-JSON domain: null prototypes are fine, but the clone is an
  // OWNED plain structure — no Proxy, no accessors, no symbol keys survive into it.
  assert.deepEqual(Object.getOwnPropertySymbols(resolution), [])
  for (const node of nodes) {
    for (const key of Object.keys(node)) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key)
      assert.equal(typeof descriptor.get, 'undefined', 'no accessor properties may survive the clone')
    }
  }

  // THE MANDATED CONTROL. The mutation happens INSIDE the async executor callback —
  // i.e. inside the await window, after the resolution was minted and after the
  // probe captured its parse-time copy.
  let mutationSucceeded = null
  let observedLengthDuringAwait = null
  const actionRegistry = createHarnessHttpProbeActionRegistryForTests([{
    actionProfileVersion: PROFILE,
    actionId: 'fixture.connector.total_order_probe',
    actionVersion: 'v1',
    connectorKind: 'erp_http',
    sourceFieldFor(fieldId) {
      const declared = { tgt_1: 'ItemNo', tgt_2: 'Revision' }
      if (!Object.prototype.hasOwnProperty.call(declared, fieldId)) throw new Error('undeclared')
      return declared[fieldId]
    },
    execute: async () => { throw new Error('unused') },
  }])
  const sourceBinder = createHarnessSourceBinderForTests([{
    systemContentKey: 'SCK-ALPHA-DISTINGUISHABLE',
    credentialFactory: () => Object.freeze({
      async execute() {
        // Mutate the ORIGINAL nested array from inside the async callback.
        try {
          resolution.orderingKeySpec.push({ fieldId: 'tgt_3', direction: 'ASC' })
          resolution.orderingKeySpec[0].direction = 'DESC'
          mutationSucceeded = true
        } catch (_error) {
          mutationSucceeded = false
        }
        observedLengthDuringAwait = resolution.orderingKeySpec.length
        return { duplicateGroupsSampled: 0, nullKeyRowsSampled: 0 }
      },
    }),
  }])
  const prober = createBindingQualificationProber({
    executor: createServerBoundSourceExecutor({ actionRegistry, sourceBinder }),
  })
  const qualification = await prober.probeFromResolution({
    resolution, envelopeKey: ENVELOPE_KEY, probedAt: '2026-07-26T00:00:00Z',
  })

  // The mutation must not have taken (deep freeze), and the probe must have used the
  // PARSE-TIME copy either way. Under a shallow `Object.freeze` the nested array is
  // writable, `mutationSucceeded` becomes true and the length becomes 3 — this is the
  // assertion that REDs.
  assert.equal(mutationSucceeded, false, 'the nested orderingKeySpec array must not be mutable')
  assert.equal(observedLengthDuringAwait, 2, 'the array observed during the await window must be the parse-time copy')
  assert.equal(resolution.orderingKeySpec.length, 2)
  assert.equal(resolution.orderingKeySpec[0].direction, 'ASC')
  assert.equal(qualification.evidence.checkedKeyColumnCount, 2)

  // The positive half: an unmutated async probe completes normally.
  assert.equal(qualification.status, 'candidate')
}

// ---------------------------------------------------------------------------
// Trust is object identity; build is split from trust; dependencies are admitted
// by FIRST-PARTY IDENTITY, never by duck-type.
// ---------------------------------------------------------------------------
async function trustIsObjectIdentity() {
  const resolver = resolverOver([rowFor('cfg-1', body())])
  const resolution = await resolver.resolveApprovedBinding(RUN)

  // A hand-built object carrying EVERY expected public field and a plausible brand.
  const duckTyped = { ...resolution, __gipTrustedResolution: true }
  assert.equal(isTrustedBindingResolution(duckTyped), false)
  refusesWith(() => assertTrustedBindingResolution(duckTyped), 'RESOLVER_RESOLUTION_NOT_TRUSTED')
  // The checker never throws for primitives / null.
  for (const value of [null, undefined, 'x', 7, Symbol('s')]) {
    assert.equal(isTrustedBindingResolution(value), false)
  }

  // THE RV-10 MUTATION: dependencies admitted by duck-type let ANY importer mint a
  // trusted resolution from two fakes. They are admitted by first-party identity.
  const fakeStore = { getForRuntime: async () => ({ config: {}, contentKey: 'x', object: 'o', systemId: 's' }) }
  assert.equal(isFirstPartyReadSourceConfigStore(fakeStore), false)
  refusesWith(() => createApprovedBindingResolver({ configStore: fakeStore, ...harnessAuthorities() }),
    'RESOLVER_COMPONENTS_INVALID')
  refusesWith(() => createApprovedBindingResolver({
    configStore: storeOver([]),
    systemIdentityAuthority: { systemContentKeyFor: async () => 'FORGED' },
    canonicalObjectAuthority: harnessAuthorities().canonicalObjectAuthority,
  }), 'RESOLVER_COMPONENTS_INVALID')
  refusesWith(() => createApprovedBindingResolver({
    configStore: storeOver([]),
    systemIdentityAuthority: harnessAuthorities().systemIdentityAuthority,
    canonicalObjectAuthority: { canonicalObjectVersionFor: () => 'FORGED' },
  }), 'RESOLVER_COMPONENTS_INVALID')
  // Components are a CLOSED key set too.
  refusesWith(() => createApprovedBindingResolver({ ...harnessAuthorities(), configStore: storeOver([]), extra: 1 }),
    'RESOLVER_COMPONENTS_INVALID')
  refusesWith(() => createApprovedBindingResolver(null), 'RESOLVER_COMPONENTS_INVALID')

  // The GRANTER is exported nowhere; only CHECKERS are exported.
  assert.equal(resolverModule.buildTrustedBindingResolution, undefined)
  assert.equal(resolverModule.__internals.buildTrustedBindingResolution, undefined)
  // A checker admits nothing: calling it does NOT make its argument trusted.
  isTrustedBindingResolution(duckTyped)
  assert.equal(isTrustedBindingResolution(duckTyped), false)

  // POSITIVE CONTROL — an internally-wired resolver still mints an accepted resolution.
  assert.ok(isTrustedBindingResolution(await resolver.resolveApprovedBinding(RUN)))
}

// ---------------------------------------------------------------------------
// The CERTIFIED authorities are fail-closed at this head, and that is the accurate
// posture of the substrate — reported, not quietly routed around (RQ-2 / RQ-3).
// ---------------------------------------------------------------------------
async function certifiedAuthoritiesAreFailClosed() {
  // (γ) — the ONLY trusted contract registry is the EMPTY module-load instance, so
  // every real object is unregistered. ⟲OD2: an inventory TOOL is not a RESULT.
  const certifiedObject = createCertifiedCanonicalObjectAuthority(CANONICAL_OBJECT_CONTRACT_REGISTRY)
  const resolverGamma = createApprovedBindingResolver({
    configStore: storeOver([rowFor('cfg-1', body())]),
    systemIdentityAuthority: harnessAuthorities().systemIdentityAuthority,
    canonicalObjectAuthority: certifiedObject,
  })
  await refusesWithAsync(() => resolverGamma.resolveApprovedBinding(RUN),
    'RESOLVER_CANONICAL_OBJECT_CONTRACT_UNREGISTERED')

  // (β) — `buildSystemIdentityService` is exported NOWHERE and has no call site, so
  // the identity read refuses EVERY caller. The only reachable constructor yields a
  // service that is refused by design.
  const untrustedService = createUntrustedSystemIdentityServiceForTests({
    credentialStore: { decrypt: async () => '{}' },
    hmacKey: Buffer.alloc(32, 1),
    resolveSystem: async () => ({ id: 'sys-alpha', kind: 'erp_http' }),
  })
  const certifiedIdentity = createCertifiedSystemIdentityAuthority(untrustedService)
  const resolverBeta = createApprovedBindingResolver({
    configStore: storeOver([rowFor('cfg-1', body())]),
    systemIdentityAuthority: certifiedIdentity,
    canonicalObjectAuthority: harnessAuthorities().canonicalObjectAuthority,
  })
  await refusesWithAsync(() => resolverBeta.resolveApprovedBinding(RUN), 'RESOLVER_SYSTEM_IDENTITY_UNAVAILABLE')

  // NOTE, stated rather than left implicit: the CERTIFIED positive controls — "a
  // certified kind resolves and the tuple carries the identity read's value" and "a
  // registered object resolves its registered version" — are NOT CONSTRUCTIBLE at
  // this head. They are reported as BLOCKED (RQ-2 / RQ-3), never satisfied by routing
  // through `__internals` or an untrusted registry, which would make the provenance
  // mutations above undetectable.
}

// ---------------------------------------------------------------------------
// Values-free refusals, a closed vocabulary, and no foreign-text channel.
// ---------------------------------------------------------------------------
async function refusalsAreValuesFreeAndClosed() {
  const ATTACKER = 'RESOLVER-ATTACKER-CANARY-6f23e39f'
  const observed = []

  // A hostile getter on the row the store returns cannot be reached through the real
  // store, so the hostile surface exercised here is the caller-facing one.
  const hostileRun = { tenantId: 't-1', workspaceId: null }
  Object.defineProperty(hostileRun, 'approvedConfigVersionId', {
    enumerable: true, get() { throw new Error(ATTACKER) },
  })
  const resolver = resolverOver([rowFor('cfg-1', body())])
  // B1a-3 round 5: the token moved from RESOLVER_RUN_INPUT_INVALID to
  // RESOLVER_INPUT_HOSTILE, and the move is the POINT rather than a regression. The
  // throwing getter used to be caught late, by `readIdentityToken`'s own guarded read
  // AFTER the allowlist had run. It is now caught at FIRST TOUCH by the inert-entry
  // gate, before any shape check — which is precisely the ordering round 4 showed was
  // missing, when `isPlainObject`'s unguarded prototype interrogation leaked BEFORE
  // the allowlist. A hostile input is now reported as hostile, not as malformed.
  observed.push((await refusesWithAsync(() => resolver.resolveApprovedBinding(hostileRun), 'RESOLVER_INPUT_HOSTILE')).message)

  const ownKeysBomb = new Proxy({ ...RUN }, { ownKeys() { throw new Error(ATTACKER) } })
  observed.push((await refusesWithAsync(() => resolver.resolveApprovedBinding(ownKeysBomb), 'RESOLVER_INPUT_HOSTILE')).message)

  // A store whose failure carries attacker text: every store error crossing the catch
  // is discarded unconditionally — no cause, no stack, no message, no class exemption.
  const angryStore = createReadSourceConfigStore({
    db: {
      async selectOne() { throw new Error(ATTACKER) },
      async select() { return [] },
      async insertOne() { return null },
      async updateRow() { return null },
      async transaction(fn) { return fn(this) },
    },
  })
  const angry = createApprovedBindingResolver({ configStore: angryStore, ...harnessAuthorities() })
  const caught = await refusesWithAsync(() => angry.resolveApprovedBinding(RUN), 'RESOLVER_APPROVED_CONFIG_UNAVAILABLE')
  for (const key of Object.getOwnPropertyNames(Object(caught))) {
    try { observed.push(String(caught[key])) } catch (_ignored) { /* discard */ }
  }
  observed.push(String(caught.stack), String(caught.cause))

  // `fail` takes no message and no details at all, so a foreign callback that
  // require()s this module cannot mint a branded error carrying attacker text —
  // and neither can direct construction.
  assert.equal(resolverModule.fail, undefined)
  assert.equal(resolverModule.__internals.fail, undefined)
  const branded = new GipApprovedBindingResolverError('RESOLVER_RUN_INPUT_INVALID', ATTACKER, { leak: ATTACKER })
  observed.push(String(branded.message), String(branded.details))
  assert.equal(branded.details, undefined)

  for (const text of observed) {
    assert.ok(!String(text).includes(ATTACKER), `foreign text escaped: ${String(text).slice(0, 200)}`)
  }
  // A refusal names no field, no identifier and no value either.
  for (const text of observed) {
    assert.ok(!String(text).includes('cfg-1') && !String(text).includes('t-1') && !String(text).includes('sys-alpha'),
      `a refusal must be values-free: ${String(text).slice(0, 200)}`)
  }

  // POSITIVE CONTROL for the discard — a legitimate refusal still surfaces its NAMED
  // reason, so "discard everything" does not pass.
  assert.deepEqual([...BINDING_RESOLVER_ERROR_REASONS], [
    'RESOLVER_COMPONENTS_INVALID',
    'RESOLVER_RUN_INPUT_INVALID',
    'RESOLVER_INPUT_HOSTILE',
    'RESOLVER_APPROVED_CONFIG_UNAVAILABLE',
    'RESOLVER_APPROVED_CONFIG_NOT_LOSSLESS',
    'RESOLVER_CONFIG_CONTENT_KEY_MISMATCH',
    'RESOLVER_CONFIG_BODY_INVALID',
    'RESOLVER_ORDERING_KEY_SPEC_INVALID',
    'RESOLVER_SYSTEM_IDENTITY_UNAVAILABLE',
    'RESOLVER_CANONICAL_OBJECT_CONTRACT_UNREGISTERED',
    'RESOLVER_RESOLUTION_NOT_TRUSTED',
    // B1a-3 round 5. L2-ONLY token — see `entryTableIsGated`.
    'RESOLVER_ENTRY_NOT_INERT',
  ])
  assert.ok(Object.isFrozen(BINDING_RESOLVER_ERROR_REASONS))
}

// ---------------------------------------------------------------------------
// The fixture really is the shape the read path produces (RAC-24).
// ---------------------------------------------------------------------------
async function fixtureMatchesTheRealReadProjection() {
  const store = storeOver([rowFor('cfg-1', body())])
  const read = await store.getForRuntime({ tenantId: 't-1', workspaceId: null, id: 'cfg-1' })
  // Asserted in the fixture itself, so a later "simplification" back to a plain
  // object literal reds.
  assert.equal(Object.getPrototypeOf(read.config), null,
    'getForRuntime returns a null-prototype sanitized projection — a plain-object double is a shape production never produces')
  assert.equal(read.status, 'approved')
  assert.equal(typeof read.contentKey, 'string')
}

async function main() {
  await tupleIsCompleteAndServerDerived()
  await runInputIsAClosedAllowlist()
  await approvalTenancyAndScope()
  await contentKeyIsRecomputedAndCompared()
  await orderingKeySpecClosedSchema()
  await deepImmutabilityAndTheMandatedAsyncControl()
  await trustIsObjectIdentity()
  await certifiedAuthoritiesAreFailClosed()
  await refusalsAreValuesFreeAndClosed()
  await fixtureMatchesTheRealReadProjection()
  console.log('gip-approved-binding-resolver.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
