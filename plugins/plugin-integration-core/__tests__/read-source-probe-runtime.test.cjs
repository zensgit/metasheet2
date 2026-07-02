'use strict'

// External-API read self-service S2-b — fixed locate-container probe runtime.
// Mock adapter/system only — no real network, no persistence, no write path.

const assert = require('node:assert/strict')
const path = require('node:path')

const { validateReadSourceConfig } = require(path.join(__dirname, '..', 'lib', 'read-source-config.cjs'))
const {
  ReadSourceProbeContractError,
} = require(path.join(__dirname, '..', 'lib', 'read-source-probe-contract.cjs'))
const {
  READ_SMOKE_LIST_REQUEST_MARKER,
  READ_SMOKE_BOM_REQUEST_MARKER,
} = require(path.join(__dirname, '..', 'lib', 'read-smoke-marker.cjs'))
const {
  ReadSourceProbeRuntimeError,
  prepareReadSourceProbe,
  executeReadSourceProbe,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'read-source-probe-runtime.cjs'))

function normalizedConfig(mode, overrides = {}) {
  const cfg = {
    version: 1,
    systemId: 'sys_1',
    requiredKind: 'erp:k3-wise-webapi',
    object: mode === 'detail_with_lines' ? 'material-bom' : 'material',
    mode,
    readPath: '/K3API/Material/GetDetail',
    readMethod: 'POST',
    operations: ['read'],
  }
  if (mode === 'single_record') {
    cfg.keyField = 'FNumber'
    cfg.containerPaths = ['Data']
  }
  if (mode === 'list_page') {
    cfg.readPath = '/K3API/Material/GetList'
    cfg.containerPaths = ['Data.Data', 'Data.DATA']
  }
  if (mode === 'detail_with_lines') {
    cfg.readPath = '/K3API/BOM/GetDetail'
    cfg.keyField = 'FBillNo'
    cfg.headerContainerPaths = ['Data.Page1']
    cfg.lineContainerPaths = ['Data.Page2']
  }
  Object.assign(cfg, overrides)
  const result = validateReadSourceConfig(cfg)
  assert.equal(result.valid, true, `${mode} fixture must validate: ${JSON.stringify(result.errors)}`)
  return result.normalized
}

const STORED_SYSTEM = Object.freeze({
  id: 'sys_1',
  tenantId: 'tenant_1',
  kind: 'erp:k3-wise-webapi',
  role: 'target',
  credentials: Object.freeze({ bearerToken: 'secret-token' }),
  config: Object.freeze({
    baseUrl: 'https://k3host.internal',
    objects: Object.freeze({
      material: Object.freeze({ operations: Object.freeze(['upsert']), savePath: '/K3API/Material/Save' }),
    }),
  }),
})

function mockDeps({ read, system = STORED_SYSTEM } = {}) {
  const state = { adapterSystems: [], readArgs: [], writeCalls: [] }
  const deps = {
    system,
    createAdapter(adapterSystem) {
      state.adapterSystems.push(adapterSystem)
      return {
        async read(request) {
          state.readArgs.push(request)
          return read(request)
        },
        async upsert(input) { state.writeCalls.push(['upsert', input]); return {} },
        async save(input) { state.writeCalls.push(['save', input]); return {} },
        async submit(input) { state.writeCalls.push(['submit', input]); return {} },
        async audit(input) { state.writeCalls.push(['audit', input]); return {} },
      }
    },
  }
  return { deps, state }
}

function assertNoLeak(evidence, leaks) {
  const text = JSON.stringify(evidence)
  for (const leak of leaks) {
    assert.ok(!text.includes(leak), `evidence must not leak ${leak}`)
  }
}

async function testPrepareSplitsInputsAndKeepsContractStrict() {
  const config = normalizedConfig('single_record')
  const probe = prepareReadSourceProbe({ config, boundedSmoke: true, inputs: { key: ' M-001 ' } })
  assert.equal(probe.plan.systemId, 'sys_1')
  assert.equal(probe.plan.boundedSmoke, true)
  assert.deepEqual(probe.inputs, { key: 'M-001' })

  // The S2-a strict top-key allowlist is untouched: an unknown key beside the contract still fail-closes.
  assert.throws(
    () => prepareReadSourceProbe({ config, rawPath: '/etc/passwd' }),
    (error) => error instanceof ReadSourceProbeContractError && error.reason === 'unexpected_field',
  )
  // Inputs are validated against the plan, both directions fail-closed.
  assert.throws(
    () => prepareReadSourceProbe({ config }),
    (error) => error instanceof ReadSourceProbeContractError && error.reason === 'key_required',
  )
  assert.throws(
    () => prepareReadSourceProbe({ config, inputs: { key: 'M-001', filter: "1=1; DROP TABLE" } }),
    (error) => error instanceof ReadSourceProbeContractError && error.reason === 'inputs_unexpected_field',
  )
  assert.throws(
    () => prepareReadSourceProbe({ config, inputs: 'M-001' }),
    (error) => error instanceof ReadSourceProbeContractError && error.reason === 'inputs_invalid',
  )
  assert.throws(
    () => prepareReadSourceProbe({ config: normalizedConfig('list_page'), inputs: { key: 'M-001' } }),
    (error) => error instanceof ReadSourceProbeContractError && error.reason === 'key_not_allowed',
  )
  // Key values are bounded: embedded control chars and oversized values are rejected (never echoed).
  assert.throws(
    () => prepareReadSourceProbe({ config, inputs: { key: 'M-001' } }),
    (error) => error instanceof ReadSourceProbeContractError && error.reason === 'key_required',
  )
  assert.throws(
    () => prepareReadSourceProbe({ config, inputs: { key: 'x'.repeat(129) } }),
    (error) => error instanceof ReadSourceProbeContractError && error.reason === 'key_required',
  )
}

async function testSingleRecordSuccessAndOverlay() {
  const probe = prepareReadSourceProbe({ config: normalizedConfig('single_record'), boundedSmoke: true, inputs: { key: 'M-001' } })
  const { deps, state } = mockDeps({
    read: () => ({
      records: [{ FName: 'SECRET-NAME', FNumber: 'M-001' }],
      raw: { Data: { FName: 'SECRET-NAME', FNumber: 'M-001' } },
    }),
  })
  const evidence = await executeReadSourceProbe(probe, deps)
  assert.equal(evidence.ok, true)
  assert.equal(evidence.object, 'material')
  assert.equal(evidence.mode, 'single_record')
  assert.deepEqual(evidence.containers, { primary: { type: 'object', arrayLength: null } })
  assert.equal(evidence.containerLocated, true)
  assert.equal(evidence.boundedSmokeExecuted, true)
  assert.equal(evidence.recordCount, 1)
  assert.equal(evidence.capReached, false)
  assert.equal(evidence.timeoutReached, false)

  // Keyed detail read request; adapter called exactly once; no write surface touched.
  assert.equal(state.readArgs.length, 1)
  assert.deepEqual(state.readArgs[0], { object: 'material', filters: { FNumber: 'M-001' } })
  assert.equal(state.writeCalls.length, 0)

  // Read-only overlay merged in memory; stored system object untouched.
  const adapterSystem = state.adapterSystems[0]
  assert.deepEqual(adapterSystem.config.objects.material, {
    operations: ['upsert', 'read'],
    savePath: '/K3API/Material/Save',
    readPath: '/K3API/Material/GetDetail',
    readMethod: 'POST',
  })
  assert.deepEqual(adapterSystem.credentials, { bearerToken: 'secret-token' })
  assert.equal(STORED_SYSTEM.config.objects.material.readPath, undefined)

  // Values-free: never the key, record values, credential, or host.
  assertNoLeak(evidence, ['M-001', 'SECRET-NAME', 'secret-token', 'k3host', '/K3API'])
}

async function testListPageRequestShapeAndMarker() {
  const probe = prepareReadSourceProbe({ config: normalizedConfig('list_page'), boundedSmoke: true })
  const { deps, state } = mockDeps({
    read: () => ({
      records: Array.from({ length: 12 }, (_, i) => ({ FNumber: `M-${i}` })),
      raw: { Data: { Data: Array.from({ length: 12 }, (_, i) => ({ FNumber: `M-${i}` })) } },
    }),
  })
  const evidence = await executeReadSourceProbe(probe, deps)
  assert.equal(evidence.ok, true)
  assert.deepEqual(evidence.containers, { primary: { type: 'array', arrayLength: 12 } })
  assert.equal(evidence.recordCount, 10, 'record count is capped at the platform row cap')
  assert.equal(evidence.capReached, true)

  const request = state.readArgs[0]
  assert.equal(request.limit, 10, 'list probe read is bounded by the platform row cap')
  assert.equal(request.options.k3ReadMode, 'list')
  assert.equal(request.options[READ_SMOKE_LIST_REQUEST_MARKER], true, 'list probe rides the internal route marker')
  const overlayObject = state.adapterSystems[0].config.objects.material
  assert.equal(overlayObject.readMode, 'list')
  assert.equal(overlayObject.maxListLimit, 10)
}

async function testDetailWithLinesContainers() {
  const probe = prepareReadSourceProbe({ config: normalizedConfig('detail_with_lines'), inputs: { key: 'PBOM-001' } })
  const { deps, state } = mockDeps({
    read: () => ({
      records: [],
      raw: { Data: { Page1: [{ FBillNo: 'PBOM-001' }], Page2: [{ FItemID: 'C-1' }, { FItemID: 'C-2' }] } },
    }),
  })
  const evidence = await executeReadSourceProbe(probe, deps)
  assert.equal(evidence.ok, true)
  assert.deepEqual(evidence.containers, {
    header: { type: 'array', arrayLength: 1 },
    lines: { type: 'array', arrayLength: 2 },
  })
  assert.equal(evidence.boundedSmokeExecuted, false)
  assert.equal(evidence.recordCount, undefined, 'no counts without boundedSmoke opt-in')

  const request = state.readArgs[0]
  assert.equal(request.options.k3ReadMode, 'bom')
  assert.equal(request.options.bomKey, 'PBOM-001')
  assert.equal(request.options[READ_SMOKE_BOM_REQUEST_MARKER], true, 'bom probe rides the internal route marker')
  assert.equal(state.adapterSystems[0].config.objects['material-bom'].readBomParentKeyField, 'FBillNo')
  assertNoLeak(evidence, ['PBOM-001', 'C-1', 'FItemID'])
}

async function testContainerNotFoundAndShapeMismatch() {
  const missing = prepareReadSourceProbe({ config: normalizedConfig('detail_with_lines'), inputs: { key: 'PBOM-001' } })
  const { deps } = mockDeps({ read: () => ({ records: [], raw: { Data: { Page1: [{}] } } }) })
  const missingEvidence = await executeReadSourceProbe(missing, deps)
  assert.equal(missingEvidence.ok, false)
  assert.equal(missingEvidence.errorCode, 'READ_SOURCE_PROBE_CONTAINER_NOT_FOUND')
  assert.equal(missingEvidence.containerLocated, false)
  assert.deepEqual(missingEvidence.containers, {
    header: { type: 'array', arrayLength: 1 },
    lines: { type: 'missing', arrayLength: null },
  })

  const probe = prepareReadSourceProbe({ config: normalizedConfig('single_record'), inputs: { key: 'M-001' } })
  const scalar = mockDeps({ read: () => ({ records: [], raw: { Data: 'a scalar, not a container' } }) })
  const scalarEvidence = await executeReadSourceProbe(probe, scalar.deps)
  assert.equal(scalarEvidence.ok, false)
  assert.equal(scalarEvidence.errorCode, 'READ_SOURCE_PROBE_SHAPE_MISMATCH')
  assert.deepEqual(scalarEvidence.containers, { primary: { type: 'string', arrayLength: null } })
  assertNoLeak(scalarEvidence, ['a scalar'])

  const noRaw = mockDeps({ read: () => ({ records: [{}] }) })
  const noRawEvidence = await executeReadSourceProbe(probe, noRaw.deps)
  assert.equal(noRawEvidence.ok, false)
  assert.equal(noRawEvidence.errorCode, 'READ_SOURCE_PROBE_RESPONSE_UNRECOGNIZED')
}

async function testContainerWalkIsOwnPropertyOnly() {
  const probe = prepareReadSourceProbe({
    config: normalizedConfig('single_record', { containerPaths: ['Data.constructor', 'Data.toString'] }),
    inputs: { key: 'M-001' },
  })
  const { deps } = mockDeps({ read: () => ({ records: [], raw: { Data: {} } }) })
  const evidence = await executeReadSourceProbe(probe, deps)
  assert.equal(evidence.errorCode, 'READ_SOURCE_PROBE_CONTAINER_NOT_FOUND', 'prototype keys never resolve as containers')
}

async function testProbeTimePathReGuard() {
  const probe = prepareReadSourceProbe({ config: normalizedConfig('single_record'), inputs: { key: 'M-001' } })
  // Simulate a plan that lost the config-time guarantee (defense-in-depth per design-lock lock 2): the
  // frozen plan cannot be edited, so rebuild an unfrozen copy with a hostile path.
  const tampered = { plan: { ...probe.plan, readPath: 'https://evil.example.com/x' }, inputs: probe.inputs }
  let adapterCreated = false
  const evidence = await executeReadSourceProbe(tampered, {
    system: STORED_SYSTEM,
    createAdapter() { adapterCreated = true; throw new Error('must not be reached') },
  })
  assert.equal(evidence.ok, false)
  assert.equal(evidence.errorCode, 'READ_SOURCE_PROBE_REJECTED')
  assert.equal(adapterCreated, false, 'no adapter (and no outbound path) exists for a rejected readPath')
  assertNoLeak(evidence, ['evil.example.com'])

  for (const readPath of ['//evil.example.com/x', '/a/%2e%2e/admin', '/a/../admin', '\\\\host\\share']) {
    const rejected = await executeReadSourceProbe(
      { plan: { ...probe.plan, readPath }, inputs: probe.inputs },
      { system: STORED_SYSTEM, createAdapter() { throw new Error('must not be reached') } },
    )
    assert.equal(rejected.errorCode, 'READ_SOURCE_PROBE_REJECTED', `probe-time guard must reject ${JSON.stringify(readPath)}`)
  }
}

async function testKindMismatchThrows() {
  const probe = prepareReadSourceProbe({ config: normalizedConfig('single_record'), inputs: { key: 'M-001' } })
  await assert.rejects(
    () => executeReadSourceProbe(probe, {
      system: { ...STORED_SYSTEM, kind: 'generic:http' },
      createAdapter() { throw new Error('must not be reached') },
    }),
    (error) => error instanceof ReadSourceProbeRuntimeError && error.reason === 'kind_mismatch',
  )
}

async function testErrorClassificationIsCoarseAndValuesFree() {
  const probe = prepareReadSourceProbe({ config: normalizedConfig('single_record'), inputs: { key: 'M-001' } })
  const cases = [
    [Object.assign(new Error('401 from https://k3host M-001'), { name: 'K3WiseWebApiAdapterError', status: 401 }), 'READ_SOURCE_PROBE_AUTH_FAILED', 'K3WiseWebApiAdapterError'],
    [Object.assign(new Error('login failed'), { name: 'K3WiseWebApiAdapterError', details: { code: 'K3_WISE_LOGIN_FAILED' } }), 'READ_SOURCE_PROBE_AUTH_FAILED', 'K3WiseWebApiAdapterError'],
    [Object.assign(new Error('credentials are not stored'), { name: 'K3WiseWebApiAdapterError', details: { code: 'K3_WISE_CREDENTIALS_MISSING' } }), 'READ_SOURCE_PROBE_AUTH_FAILED', 'K3WiseWebApiAdapterError'],
    [Object.assign(new Error('business response failed'), { name: 'K3WiseWebApiAdapterError', details: { code: 'K3_WISE_READ_BUSINESS_ERROR' } }), 'READ_SOURCE_PROBE_RESPONSE_UNRECOGNIZED', 'K3WiseWebApiAdapterError'],
    [Object.assign(new Error('filter not allowed'), { name: 'AdapterValidationError' }), 'READ_SOURCE_PROBE_REJECTED', 'Error'],
    [Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' }), 'READ_SOURCE_PROBE_NETWORK_FAILED', 'TypeError'],
    [Object.assign(new Error('read failed'), { name: 'K3WiseWebApiAdapterError', details: { code: 'K3_WISE_READ_FAILED' } }), 'READ_SOURCE_PROBE_NETWORK_FAILED', 'K3WiseWebApiAdapterError'],
    [new Error('something odd with M-001 at https://k3host'), 'READ_SOURCE_PROBE_FAILED', 'Error'],
  ]
  for (const [error, expectedCode, expectedType] of cases) {
    const { deps } = mockDeps({ read: () => { throw error } })
    const evidence = await executeReadSourceProbe(probe, deps)
    assert.equal(evidence.ok, false)
    assert.equal(evidence.errorCode, expectedCode)
    assert.equal(evidence.errorType, expectedType)
    assertNoLeak(evidence, ['M-001', 'k3host', 'login failed', 'fetch failed'])
  }
}

async function testTimeoutIsPlatformBoundedAndValuesFree() {
  const probe = prepareReadSourceProbe({ config: normalizedConfig('single_record'), inputs: { key: 'M-001' } })
  const { deps } = mockDeps({ read: () => new Promise(() => {}) })
  // timeoutMs here is dependency injection from the ROUTE side (tests); the request body has no such field
  // (the S2-a contract rejects it), so the platform constant is not request-reachable.
  const evidence = await executeReadSourceProbe(probe, { ...deps, timeoutMs: 20 })
  assert.equal(evidence.ok, false)
  assert.equal(evidence.errorCode, 'READ_SOURCE_PROBE_TIMEOUT')
  assert.equal(evidence.errorType, 'TimeoutError')
  assert.equal(evidence.timeoutReached, true)
}

async function testLateRejectionAfterTimeoutIsSwallowed() {
  const probe = prepareReadSourceProbe({ config: normalizedConfig('single_record'), inputs: { key: 'M-001' } })
  let rejectLate
  const { deps } = mockDeps({ read: () => new Promise((resolve, reject) => { rejectLate = reject }) })
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const evidence = await executeReadSourceProbe(probe, { ...deps, timeoutMs: 20 })
    assert.equal(evidence.errorCode, 'READ_SOURCE_PROBE_TIMEOUT')
    rejectLate(new Error('late failure with M-001'))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(unhandled.length, 0, 'late adapter rejection must not become an unhandled rejection')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
}

async function main() {
  await testPrepareSplitsInputsAndKeepsContractStrict()
  await testSingleRecordSuccessAndOverlay()
  await testListPageRequestShapeAndMarker()
  await testDetailWithLinesContainers()
  await testContainerNotFoundAndShapeMismatch()
  await testContainerWalkIsOwnPropertyOnly()
  await testProbeTimePathReGuard()
  await testKindMismatchThrows()
  await testErrorClassificationIsCoarseAndValuesFree()
  await testTimeoutIsPlatformBoundedAndValuesFree()

  // __internals stays test-only coverage for the pure helpers.
  assert.deepEqual(__internals.locateContainerShape({ a: { b: [1, 2] } }, ['a.b']), { type: 'array', arrayLength: 2 })
  assert.deepEqual(__internals.locateContainerShape({ a: null }, ['a']), { type: 'null', arrayLength: null })
  assert.deepEqual(__internals.locateContainerShape([1, 2], ['length']), { type: 'missing', arrayLength: null })

  await testLateRejectionAfterTimeoutIsSwallowed()
  console.log('read-source-probe-runtime.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
