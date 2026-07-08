'use strict'

// External-API WRITE self-service — W2-a dry-run PREVIEW runtime (static-preview level, #3878).
// Hermetic: no network, no persistence, no route. Mock adapter/system injection only. Every hard lock
// from the design-lock's §4/§5 gets a dedicated proof below (zero outbound write, mutation-provable
// derived marker, sandbox-only resolution, values-free evidence, fail-closed config states, exact-code
// family + generic clamp).

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const MODULE_PATH = path.join(__dirname, '..', 'lib', 'write-target-dry-run-runtime.cjs')
const {
  WRITE_TARGET_DRY_RUN_DEFAULT_MAX_ROWS,
  WRITE_TARGET_DRY_RUN_MAX_ROWS,
  WRITE_TARGET_DRY_RUN_ERROR_CODES,
  WRITE_TARGET_DRY_RUN_ERROR_TYPES,
  WriteTargetDryRunError,
  createWriteDispatchGuard,
  dryRunWriteTarget,
  writeTargetDryRunErrorEvidence,
  __internals,
} = require(MODULE_PATH)

// ---------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------

function validRawConfig(overrides = {}) {
  return {
    version: 1,
    systemId: 'k3_prod',
    sandboxSystemId: 'k3_sandbox',
    requiredKind: 'erp:k3-wise-webapi',
    object: 'material',
    operation: 'upsert',
    writePath: '/K3API/Material/Save',
    writeMethod: 'POST',
    operations: ['write'],
    keyField: 'materialNumber',
    keyEncoding: 'structured_json_field',
    fieldMap: [
      { source: 'cleansing_name', target: 'Data.FName' },
      { source: 'cleansing_spec', target: 'Data.FSpec' },
    ],
    ...overrides,
  }
}

// `overrides` patches the CONFIG-RECORD fields (id/status/version) only -- e.g. approvedConfigRecord({
// status: 'draft' }). To mutate the underlying raw write-target config itself, build the record and then
// spread-override its `.config` sub-object directly (see the invalid/not-normalized fixtures below).
function approvedConfigRecord(overrides = {}) {
  const { validateWriteTargetConfig } = require(path.join(__dirname, '..', 'lib', 'write-target-config.cjs'))
  const raw = validRawConfig()
  const result = validateWriteTargetConfig(raw)
  assert.equal(result.valid, true, `fixture config must validate: ${JSON.stringify(result.errors)}`)
  return {
    id: 'cfg_1',
    status: 'approved',
    version: 1,
    config: result.normalized,
    ...overrides,
  }
}

const SANDBOX_SYSTEM = Object.freeze({ id: 'k3_sandbox', kind: 'erp:k3-wise-webapi' })
const PRODUCTION_SYSTEM = Object.freeze({ id: 'k3_prod', kind: 'erp:k3-wise-webapi' })

function row(overrides = {}) {
  return { materialNumber: 'M-001', cleansing_name: 'Widget', cleansing_spec: 'v2', ...overrides }
}

// A hostile adapter/factory: any write-shaped method throws loudly (and is spy-counted) if ever invoked.
// Mirrors read-source-read-runtime.test.cjs's mockDeps() pattern (upsert/save on the returned adapter),
// strengthened per this task's explicit request: THROW, don't just record, if called.
// Synchronous throws (not async/rejecting) so a direct `assert.throws` sanity check is meaningful without
// needing to await a promise -- the real proof (never CALLED at all) doesn't depend on sync vs async.
function hostileCreateAdapter(state) {
  return function createAdapter(adapterSystem) {
    state.createAdapterCalls.push(adapterSystem)
    return {
      read() { state.writeCalls.push('read'); throw new Error('must never be called') },
      upsert() { state.writeCalls.push('upsert'); throw new Error('must never be called') },
      save() { state.writeCalls.push('save'); throw new Error('must never be called') },
      write() { state.writeCalls.push('write'); throw new Error('must never be called') },
    }
  }
}

function hostileDeps() {
  const state = { createAdapterCalls: [], writeCalls: [] }
  return { deps: { createAdapter: hostileCreateAdapter(state) }, state }
}

function assertDryRunError(fn, code, messageForFailure) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof WriteTargetDryRunError, messageForFailure || 'must be a WriteTargetDryRunError')
    assert.equal(error.code, code, `expected code ${code}, got ${error.code} (reason=${error.reason})`)
    return true
  })
}

// ---------------------------------------------------------------------------------------------------
// A. Happy dry-run — values-free evidence, adapter write-spy NEVER called
// ---------------------------------------------------------------------------------------------------

function testHappyDryRun() {
  const { deps, state } = hostileDeps()
  const result = dryRunWriteTarget({
    configRecord: approvedConfigRecord(),
    payload: { rows: [row(), row({ materialNumber: 'M-002' })] },
    sandboxSystem: SANDBOX_SYSTEM,
  }, deps)

  assert.equal(result.evidence.ok, true)
  assert.equal(result.evidence.configId, 'cfg_1')
  assert.equal(result.evidence.configVersion, 1)
  assert.equal(result.evidence.status, 'not_applyable')
  assert.equal(result.evidence.canApply, false)
  assert.equal(result.evidence.lookupExecuted, false)
  assert.equal(result.evidence.tokenIssued, false)
  assert.equal(result.evidence.capReached, false)
  assert.equal(result.evidence.sandboxBindingResolved, true)
  assert.equal(result.evidence.externalWriteAttempted, false)
  assert.equal(result.evidence.planned, 2)
  assert.equal(result.evidence.invalid, 0)
  assert.equal(result.evidence.rowCount, 2)

  assert.equal(state.createAdapterCalls.length, 0, 'createAdapter must never be invoked (zero network, zero write)')
  assert.equal(state.writeCalls.length, 0, 'no adapter method may ever be called')
}

// ---------------------------------------------------------------------------------------------------
// B. Zero-write proof — adapter injected with methods that THROW if called; dry-run still succeeds
// ---------------------------------------------------------------------------------------------------

function testZeroWriteProof() {
  const { deps, state } = hostileDeps()
  // Sanity: prove the hostile adapter really does throw when invoked directly (so "never called" below
  // is a meaningful claim, not an accident of a no-op stub).
  const adapter = deps.createAdapter({ id: 'k3_sandbox' })
  assert.throws(() => adapter.upsert(), /must never be called/)
  assert.equal(state.writeCalls.length, 1)
  state.writeCalls.length = 0
  state.createAdapterCalls.length = 0

  const result = dryRunWriteTarget({
    configRecord: approvedConfigRecord(),
    payload: { rows: [row()] },
    sandboxSystem: SANDBOX_SYSTEM,
  }, deps)

  assert.equal(result.evidence.ok, true)
  assert.equal(result.evidence.externalWriteAttempted, false)
  assert.equal(state.createAdapterCalls.length, 0)
  assert.equal(state.writeCalls.length, 0)
}

// ---------------------------------------------------------------------------------------------------
// C. Sandbox-only resolution — production systemId (or anything else) must fail closed
// ---------------------------------------------------------------------------------------------------

function testSandboxOnly() {
  const { deps } = hostileDeps()
  const configRecord = approvedConfigRecord()

  assertDryRunError(
    () => dryRunWriteTarget({ configRecord, payload: { rows: [row()] }, sandboxSystem: PRODUCTION_SYSTEM }, deps),
    'WRITE_TARGET_DRY_RUN_SANDBOX_BINDING_MISSING',
    'production systemId must fail closed',
  )
  assertDryRunError(
    () => dryRunWriteTarget({ configRecord, payload: { rows: [row()] }, sandboxSystem: { id: 'some_other_system' } }, deps),
    'WRITE_TARGET_DRY_RUN_SANDBOX_BINDING_MISSING',
  )
  assertDryRunError(
    () => dryRunWriteTarget({ configRecord, payload: { rows: [row()] }, sandboxSystem: {} }, deps),
    'WRITE_TARGET_DRY_RUN_SANDBOX_BINDING_MISSING',
  )
  assertDryRunError(
    () => dryRunWriteTarget({ configRecord, payload: { rows: [row()] } }, deps),
    'WRITE_TARGET_DRY_RUN_SANDBOX_BINDING_MISSING',
    'missing sandboxSystem entirely must still fail closed as a sandbox-binding problem',
  )
}

// ---------------------------------------------------------------------------------------------------
// D. Fail-closed on config state — draft / retired / missing / invalid / non-normalized
// ---------------------------------------------------------------------------------------------------

function testFailClosedConfigState() {
  const { deps, state } = hostileDeps()
  const payload = { rows: [row()] }

  assertDryRunError(
    () => dryRunWriteTarget({ configRecord: null, payload, sandboxSystem: SANDBOX_SYSTEM }, deps),
    'WRITE_TARGET_DRY_RUN_CONFIG_NOT_FOUND',
  )
  assertDryRunError(
    () => dryRunWriteTarget({ payload, sandboxSystem: SANDBOX_SYSTEM }, deps),
    'WRITE_TARGET_DRY_RUN_CONFIG_NOT_FOUND',
    'configRecord key entirely absent must resolve the same as an explicit null',
  )
  assertDryRunError(
    () => dryRunWriteTarget({ configRecord: approvedConfigRecord({ status: 'draft' }), payload, sandboxSystem: SANDBOX_SYSTEM }, deps),
    'WRITE_TARGET_DRY_RUN_CONFIG_NOT_APPROVED',
  )
  assertDryRunError(
    () => dryRunWriteTarget({ configRecord: approvedConfigRecord({ status: 'retired' }), payload, sandboxSystem: SANDBOX_SYSTEM }, deps),
    'WRITE_TARGET_DRY_RUN_CONFIG_NOT_APPROVED',
  )
  assertDryRunError(
    () => dryRunWriteTarget({ configRecord: approvedConfigRecord({ status: 'unknown_status' }), payload, sandboxSystem: SANDBOX_SYSTEM }, deps),
    'WRITE_TARGET_DRY_RUN_CONFIG_NOT_APPROVED',
  )

  const invalidRecord = approvedConfigRecord()
  const mutableInvalid = { ...invalidRecord, config: { ...invalidRecord.config, fieldMap: [] } }
  assertDryRunError(
    () => dryRunWriteTarget({ configRecord: mutableInvalid, payload, sandboxSystem: SANDBOX_SYSTEM }, deps),
    'WRITE_TARGET_DRY_RUN_CONFIG_INVALID',
  )

  const notNormalized = approvedConfigRecord()
  const mutableNotNormalized = { ...notNormalized, config: { ...notNormalized.config, keyField: `${notNormalized.config.keyField}  ` } }
  assertDryRunError(
    () => dryRunWriteTarget({ configRecord: mutableNotNormalized, payload, sandboxSystem: SANDBOX_SYSTEM }, deps),
    'WRITE_TARGET_DRY_RUN_CONFIG_NOT_NORMALIZED',
  )

  // None of the above fail-closed paths may reach adapter construction.
  assert.equal(state.createAdapterCalls.length, 0)
  assert.equal(state.writeCalls.length, 0)
}

// ---------------------------------------------------------------------------------------------------
// E. Payload shape / caps
// ---------------------------------------------------------------------------------------------------

function testPayloadShapeAndCaps() {
  const { deps } = hostileDeps()
  const configRecord = approvedConfigRecord()

  assertDryRunError(
    () => dryRunWriteTarget({ configRecord, payload: { rows: [] }, sandboxSystem: SANDBOX_SYSTEM }, deps),
    'WRITE_TARGET_DRY_RUN_PAYLOAD_INVALID',
  )
  assertDryRunError(
    () => dryRunWriteTarget({ configRecord, payload: { rows: 'not-an-array' }, sandboxSystem: SANDBOX_SYSTEM }, deps),
    'WRITE_TARGET_DRY_RUN_PAYLOAD_INVALID',
  )
  assertDryRunError(
    () => dryRunWriteTarget({ configRecord, payload: { rows: [row(), 'not-an-object'] }, sandboxSystem: SANDBOX_SYSTEM }, deps),
    'WRITE_TARGET_DRY_RUN_PAYLOAD_INVALID',
  )

  // Hard-ceiling reject: more rows than WRITE_TARGET_DRY_RUN_MAX_ROWS is rejected wholesale.
  const tooManyRows = Array.from({ length: WRITE_TARGET_DRY_RUN_MAX_ROWS + 1 }, (_, i) => row({ materialNumber: `M-${i}` }))
  assertDryRunError(
    () => dryRunWriteTarget({ configRecord, payload: { rows: tooManyRows }, sandboxSystem: SANDBOX_SYSTEM }, deps),
    'WRITE_TARGET_DRY_RUN_CAP_REACHED',
  )

  // Soft cap: above the default max but under the hard ceiling degrades to capReached:true, still ok.
  const overDefaultRows = Array.from({ length: WRITE_TARGET_DRY_RUN_DEFAULT_MAX_ROWS + 5 }, (_, i) => row({ materialNumber: `M-${i}` }))
  const capped = dryRunWriteTarget({ configRecord, payload: { rows: overDefaultRows }, sandboxSystem: SANDBOX_SYSTEM }, deps)
  assert.equal(capped.evidence.ok, true)
  assert.equal(capped.evidence.capReached, true)
  assert.equal(capped.evidence.rowCount, WRITE_TARGET_DRY_RUN_DEFAULT_MAX_ROWS)

  assertDryRunError(
    () => dryRunWriteTarget({ configRecord, payload: { rows: [row()] }, sandboxSystem: SANDBOX_SYSTEM, maxRows: -1 }, deps),
    'WRITE_TARGET_DRY_RUN_CONTRACT_INVALID',
  )
}

// ---------------------------------------------------------------------------------------------------
// F. KEY_MISSING — total vs partial failure
// ---------------------------------------------------------------------------------------------------

function testKeyMissing() {
  const { deps } = hostileDeps()
  const configRecord = approvedConfigRecord()

  assertDryRunError(
    () => dryRunWriteTarget({
      configRecord,
      payload: { rows: [row({ materialNumber: '' }), row({ materialNumber: undefined })] },
      sandboxSystem: SANDBOX_SYSTEM,
    }, deps),
    'WRITE_TARGET_DRY_RUN_KEY_MISSING',
    'all rows missing key must be a total failure',
  )

  const partial = dryRunWriteTarget({
    configRecord,
    payload: { rows: [row(), row({ materialNumber: '' })] },
    sandboxSystem: SANDBOX_SYSTEM,
  }, deps)
  assert.equal(partial.evidence.ok, true)
  assert.equal(partial.evidence.planned, 1)
  assert.equal(partial.evidence.invalid, 1)
  assert.equal(partial.evidence.rowCount, 2)
}

// ---------------------------------------------------------------------------------------------------
// G. Values-free evidence — sentinel scan across every code path
// ---------------------------------------------------------------------------------------------------

const SENTINELS = Object.freeze([
  'SENTINEL-ROW-VALUE-9f8e', 'SENTINEL-TOKEN-abc123', 'sentinel-host.internal', 'Widget-Secret-Spec',
])

function assertNoSentinelLeak(value, label) {
  const text = JSON.stringify(value)
  for (const sentinel of SENTINELS) {
    assert.ok(!text.includes(sentinel), `${label} must not leak sentinel "${sentinel}": ${text}`)
  }
}

function testValuesFreeSentinelScan() {
  const { deps } = hostileDeps()
  const configRecord = approvedConfigRecord()
  const poisonedSandbox = {
    id: 'k3_sandbox',
    kind: 'erp:k3-wise-webapi',
    // Extra fields a hostile/careless caller might attach; the module must never read or echo these.
    credentials: { bearerToken: 'SENTINEL-TOKEN-abc123' },
    config: { baseUrl: 'https://sentinel-host.internal' },
  }
  const poisonedRows = [row({ cleansing_name: 'SENTINEL-ROW-VALUE-9f8e', cleansing_spec: 'Widget-Secret-Spec' })]

  const result = dryRunWriteTarget({ configRecord, payload: { rows: poisonedRows }, sandboxSystem: poisonedSandbox }, deps)
  assert.equal(result.evidence.ok, true)
  assertNoSentinelLeak(result.evidence, 'success evidence')

  // Every failure path too.
  const failureCases = [
    () => dryRunWriteTarget({ configRecord: approvedConfigRecord({ status: 'draft' }), payload: { rows: poisonedRows }, sandboxSystem: poisonedSandbox }, deps),
    () => dryRunWriteTarget({ configRecord, payload: { rows: poisonedRows }, sandboxSystem: PRODUCTION_SYSTEM }, deps),
    () => dryRunWriteTarget({ configRecord, payload: { rows: [] }, sandboxSystem: poisonedSandbox }, deps),
  ]
  for (const attempt of failureCases) {
    try {
      attempt()
      assert.fail('expected failure case to throw')
    } catch (error) {
      assertNoSentinelLeak({ message: error.message, code: error.code, reason: error.reason }, 'thrown error')
      assertNoSentinelLeak(writeTargetDryRunErrorEvidence(error), 'error evidence')
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// H. Exact-registered coarse-code family + generic clamp
// ---------------------------------------------------------------------------------------------------

function testExactCodeFamilyAndClamp() {
  assert.ok(Object.isFrozen(WRITE_TARGET_DRY_RUN_ERROR_CODES))
  assert.deepEqual([...WRITE_TARGET_DRY_RUN_ERROR_CODES], [
    'WRITE_TARGET_DRY_RUN_CONTRACT_INVALID',
    'WRITE_TARGET_DRY_RUN_CONFIG_NOT_FOUND',
    'WRITE_TARGET_DRY_RUN_CONFIG_NOT_APPROVED',
    'WRITE_TARGET_DRY_RUN_CONFIG_INVALID',
    'WRITE_TARGET_DRY_RUN_CONFIG_NOT_NORMALIZED',
    'WRITE_TARGET_DRY_RUN_SANDBOX_BINDING_MISSING',
    'WRITE_TARGET_DRY_RUN_KEY_MISSING',
    'WRITE_TARGET_DRY_RUN_PAYLOAD_INVALID',
    'WRITE_TARGET_DRY_RUN_CAP_REACHED',
    'WRITE_TARGET_DRY_RUN_WRITE_BLOCKED',
    'WRITE_TARGET_DRY_RUN_FAILED',
  ])
  // Not registered in this slice — nothing here can produce them (no network, no token).
  for (const deferred of ['WRITE_TARGET_DRY_RUN_LOOKUP_AMBIGUOUS', 'WRITE_TARGET_DRY_RUN_AUTH_FAILED', 'WRITE_TARGET_DRY_RUN_NETWORK_FAILED', 'WRITE_TARGET_DRY_RUN_TIMEOUT', 'WRITE_TARGET_DRY_RUN_TOKEN_STORE_UNAVAILABLE']) {
    assert.ok(!WRITE_TARGET_DRY_RUN_ERROR_CODES.includes(deferred), `${deferred} must not be registered by this slice`)
  }

  // Prefix matching is NOT allowed: an unregistered code that merely starts with a registered prefix
  // must clamp to the generic fallback, never be echoed as-is.
  const fakePrefixError = new Error('boom')
  fakePrefixError.name = 'SomeUnrelatedError'
  const prefixLikeInstance = new WriteTargetDryRunError('WRITE_TARGET_DRY_RUN_CONFIG_NOT_APPROVED_EXTRA', 'looks_like_a_prefix')
  assert.equal(prefixLikeInstance.code, 'WRITE_TARGET_DRY_RUN_FAILED', 'unregistered/prefix-like code must clamp to the generic fallback at construction time')

  // errorType is ALSO exact-registered: an unregistered producer type name (not
  // WriteTargetDryRunError/Error) clamps to the generic 'Error', never echoed verbatim.
  const genericEvidence = writeTargetDryRunErrorEvidence(fakePrefixError)
  assert.equal(genericEvidence.errorCode, 'WRITE_TARGET_DRY_RUN_FAILED')
  assert.equal(genericEvidence.errorType, 'Error')

  const unknownTypeEvidence = writeTargetDryRunErrorEvidence({ name: 42 })
  assert.equal(unknownTypeEvidence.errorType, 'Error')

  assert.ok(Object.isFrozen(WRITE_TARGET_DRY_RUN_ERROR_TYPES))
  assert.deepEqual([...WRITE_TARGET_DRY_RUN_ERROR_TYPES], ['WriteTargetDryRunError', 'Error'])
}

// ---------------------------------------------------------------------------------------------------
// I. Write-dispatch guard — real throw+tally semantics, derived (not hardcoded) marker
// ---------------------------------------------------------------------------------------------------

function testWriteDispatchGuard() {
  const fresh = createWriteDispatchGuard()
  assert.equal(fresh.writeAttempts, 0)

  const poisoned = createWriteDispatchGuard()
  assert.throws(
    () => poisoned.blockDispatch('upsert'),
    (error) => error instanceof WriteTargetDryRunError && error.code === 'WRITE_TARGET_DRY_RUN_WRITE_BLOCKED',
  )
  assert.equal(poisoned.writeAttempts, 1)

  // Quality-gate pin (review): buildSuccessEvidence must FAITHFULLY carry the derived marker — passing
  // true surfaces true, passing false surfaces false. This is the mutation-provable part of the
  // "externalWriteAttempted DERIVED not hardcoded" lock (the call-site `guard.writeAttempts > 0` at the
  // compose path is a provable-EQUIVALENT of `false` since >0 fails closed earlier, so it can't be killed;
  // the killable guarantee is that the evidence builder never clamps/hardcodes the marker).
  {
    const evTrue = __internals.buildSuccessEvidence({ configId: 'c', configVersion: 1, counts: {}, capReached: false, externalWriteAttempted: true })
    assert.equal(evTrue.externalWriteAttempted, true, 'evidence must surface a true write-attempted marker (never hardcoded false)')
    const evFalse = __internals.buildSuccessEvidence({ configId: 'c', configVersion: 1, counts: {}, capReached: false, externalWriteAttempted: false })
    assert.equal(evFalse.externalWriteAttempted, false)
  }
  // Calling it again keeps tallying and keeps throwing — never a silent no-op after the first attempt.
  assert.throws(() => poisoned.blockDispatch(), WriteTargetDryRunError)
  assert.equal(poisoned.writeAttempts, 2)

  // Derived-not-hardcoded: the evidence builder must read the marker FROM the guard's tally, not from a
  // literal. Same helper, two different guard states, two different results.
  const evidenceFresh = __internals.buildSuccessEvidence({
    configId: 'cfg_1', configVersion: 1, counts: { planned: 1, invalid: 0, rowCount: 1 }, capReached: false,
    externalWriteAttempted: fresh.writeAttempts > 0,
  })
  const evidencePoisoned = __internals.buildSuccessEvidence({
    configId: 'cfg_1', configVersion: 1, counts: { planned: 1, invalid: 0, rowCount: 1 }, capReached: false,
    externalWriteAttempted: poisoned.writeAttempts > 0,
  })
  assert.equal(evidenceFresh.externalWriteAttempted, false)
  assert.equal(evidencePoisoned.externalWriteAttempted, true)

  // Integration-level proof: a guard that already recorded an attempt (simulating a hostile/mutated code
  // path that wrongly reached the guard) makes the WHOLE run fail closed with WRITE_BLOCKED and produces
  // no success evidence — this is the line `if (guard.writeAttempts > 0) throw ...` at the top of
  // dryRunWriteTarget; removing it turns this specific assertion red.
  const { deps } = hostileDeps()
  assertDryRunError(
    () => dryRunWriteTarget({
      configRecord: approvedConfigRecord(),
      payload: { rows: [row()] },
      sandboxSystem: SANDBOX_SYSTEM,
    }, { ...deps, writeDispatchGuard: poisoned }),
    'WRITE_TARGET_DRY_RUN_WRITE_BLOCKED',
    'a guard that already observed a write attempt must fail the whole run closed',
  )
}

// ---------------------------------------------------------------------------------------------------
// J. Static source-scan — "structurally incapable" backstop
// ---------------------------------------------------------------------------------------------------

function testStaticSourceScan() {
  const source = fs.readFileSync(MODULE_PATH, 'utf8')
  const forbidden = [
    /\.write\(/, /\.upsert\(/, /\.save\(/, /\bfetch\(/, /http\.request/, /https\.request/,
    /XMLHttpRequest/, /require\(['"]node-fetch['"]\)/, /\.insertRows\(/, /\.updateRows\(/,
    /require\(['"]node:http['"]\)/, /require\(['"]node:https['"]\)/, /require\(['"]http['"]\)/, /require\(['"]https['"]\)/,
  ]
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(source), `module source must not contain ${pattern} (structurally incapable of writing/dispatching)`)
  }
}

// ---------------------------------------------------------------------------------------------------
// K. __internals sanity (walkOwnPath prototype-safety, classifyRow discards body)
// ---------------------------------------------------------------------------------------------------

function testInternals() {
  const resolved = __internals.walkOwnPath({ a: { b: 1 } }, 'a.b')
  assert.deepEqual(resolved, { resolved: true, value: 1 })
  const unresolved = __internals.walkOwnPath({}, 'toString')
  assert.equal(unresolved.resolved, false, 'prototype-inherited keys must never resolve')

  const config = approvedConfigRecord().config
  const classified = __internals.classifyRow(row(), config)
  assert.equal(classified.ok, true)
  assert.ok(isPlainObjectLike(classified.body))

  const missingKey = __internals.classifyRow(row({ materialNumber: '' }), config)
  assert.equal(missingKey.ok, false)
}

function isPlainObjectLike(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

// ---------------------------------------------------------------------------------------------------
// L. No token-shaped export — W2-b (token issuance) and W3 (redemption) are separate later opt-ins;
//    this module must not pre-emptively expose a mint/issue/consume/redeem surface (design-lock §5.3:
//    "no W2 route or export accepts/consumes the token -- static assertion on module exports").
// ---------------------------------------------------------------------------------------------------

function testNoTokenShapedExport() {
  const moduleExports = require(MODULE_PATH)
  const forbiddenNamePattern = /mint|issue|token|consume|redeem/i
  for (const exportName of Object.keys(moduleExports)) {
    if (exportName === '__internals') continue
    assert.ok(
      !forbiddenNamePattern.test(exportName),
      `export "${exportName}" looks token-shaped -- W2-b token issuance / W3 redemption must not exist in this module`,
    )
  }
  for (const internalName of Object.keys(moduleExports.__internals)) {
    assert.ok(
      !forbiddenNamePattern.test(internalName),
      `__internals export "${internalName}" looks token-shaped -- W2-b/W3 must not exist in this module`,
    )
  }
}

// ---------------------------------------------------------------------------------------------------

testHappyDryRun()
testZeroWriteProof()
testSandboxOnly()
testFailClosedConfigState()
testPayloadShapeAndCaps()
testKeyMissing()
testValuesFreeSentinelScan()
testExactCodeFamilyAndClamp()
testWriteDispatchGuard()
testNoTokenShapedExport()
testStaticSourceScan()
testInternals()

console.log('write-target-dry-run-runtime.test.cjs OK')
