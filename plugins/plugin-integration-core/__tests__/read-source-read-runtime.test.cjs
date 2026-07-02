'use strict'

// External-API read self-service S3-1 — config-driven read executor (data-plane field-map extraction).
// Mock adapter/system only — no real network, no persistence, no route, no write path.

const assert = require('node:assert/strict')
const path = require('node:path')

const { validateReadSourceConfig } = require(path.join(__dirname, '..', 'lib', 'read-source-config.cjs'))
const {
  ReadSourceProbeContractError,
} = require(path.join(__dirname, '..', 'lib', 'read-source-probe-contract.cjs'))
const probeRuntime = require(path.join(__dirname, '..', 'lib', 'read-source-probe-runtime.cjs'))
const {
  prepareConfiguredRead,
  executeConfiguredRead,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'read-source-read-runtime.cjs'))

const { ReadSourceProbeRuntimeError } = probeRuntime

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
    fieldMap: [
      { source: 'FSigmaField', target: 'colGamma' },
      { source: 'FUnitRef.FDeltaCode', target: 'colDelta' },
      { source: 'FAbsentField', target: 'colAbsent' },
    ],
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
      }
    },
  }
  return { deps, state }
}

// The separation invariant: these strings belong to the DATA plane (mapped values / fieldMap names /
// raw row content / supplied key) and must never appear in the values-free evidence.
const DATA_PLANE_SENTINELS = Object.freeze([
  'SIGMA-VALUE', 'DELTA-CODE', 'UNMAPPED-VALUE', 'FSigmaField', 'FDeltaCode', 'FAbsentField',
  'colGamma', 'colDelta', 'colAbsent', 'FUnwantedField', 'M-001', 'PBOM-001', 'k3host', 'secret-token',
])

function assertEvidenceValuesFree(evidence) {
  const text = JSON.stringify(evidence)
  for (const sentinel of DATA_PLANE_SENTINELS) {
    assert.ok(!text.includes(sentinel), `evidence must not leak ${sentinel}`)
  }
}

async function testPrepareFailClosed() {
  const config = normalizedConfig('single_record')
  // Strict body allowlist.
  assert.throws(
    () => prepareConfiguredRead({ config, inputs: { key: 'M-001' }, rawPath: '/etc/passwd' }),
    (error) => error instanceof ReadSourceProbeContractError && error.reason === 'unexpected_field',
  )
  assert.throws(
    () => prepareConfiguredRead('not-an-object'),
    (error) => error instanceof ReadSourceProbeContractError && error.reason === 'not_object',
  )
  // Normalized-only: a merely-valid RAW config (untrimmed) is refused by the S2-a comparison.
  const raw = { ...config, systemId: ' sys_1 ', containerPaths: ['Data'], fieldMap: config.fieldMap.map((e) => ({ ...e })) }
  assert.throws(
    () => prepareConfiguredRead({ config: raw, inputs: { key: 'M-001' } }),
    (error) => error instanceof ReadSourceProbeContractError && error.reason === 'config_not_normalized',
  )
  // Data-plane rule: fieldMap is REQUIRED for a configured read (probe accepts its absence; this does not).
  const noFieldMap = normalizedConfig('single_record', { fieldMap: undefined })
  assert.equal(noFieldMap.fieldMap, undefined, 'fixture without fieldMap')
  assert.throws(
    () => prepareConfiguredRead({ config: noFieldMap, inputs: { key: 'M-001' } }),
    (error) => error instanceof ReadSourceProbeContractError && error.reason === 'field_map_required',
  )
  // Named-inputs discipline is the S2-b one (key required when keyField declared).
  assert.throws(
    () => prepareConfiguredRead({ config }),
    (error) => error instanceof ReadSourceProbeContractError && error.reason === 'key_required',
  )
}

async function testSingleRecordDataPlane() {
  const prepared = prepareConfiguredRead({ config: normalizedConfig('single_record'), inputs: { key: 'M-001' } })
  const { deps, state } = mockDeps({
    read: (req) => ({
      records: [{}],
      raw: {
        Data: {
          FSigmaField: 'SIGMA-VALUE',
          FUnitRef: { FDeltaCode: 'DELTA-CODE' },
          FUnwantedField: 'UNMAPPED-VALUE',
          FNumber: req.filters.FNumber,
        },
      },
    }),
  })
  const { evidence, data } = await executeConfiguredRead(prepared, deps)
  assert.equal(evidence.ok, true)
  assert.equal(evidence.containerLocated, true)
  assert.equal(evidence.boundedSmokeExecuted, true)
  assert.equal(evidence.recordCount, 1)
  assert.equal(evidence.capReached, false)
  assert.deepEqual(evidence.containers, { primary: { type: 'object', arrayLength: null } })
  // Exact data-plane projection: fieldMap targets ONLY; missing source → null; unmapped fields absent.
  assert.deepEqual(data, {
    containers: {
      primary: {
        records: [{ colGamma: 'SIGMA-VALUE', colDelta: 'DELTA-CODE', colAbsent: null }],
      },
    },
    recordCount: 1,
  })
  assertEvidenceValuesFree(evidence)
  // Same outbound discipline as the probe: keyed detail request, one read, no writes.
  assert.deepEqual(state.readArgs, [{ object: 'material', filters: { FNumber: 'M-001' } }])
  assert.equal(state.writeCalls.length, 0)
}

async function testListPageCapAndProjection() {
  const prepared = prepareConfiguredRead({ config: normalizedConfig('list_page') })
  const { deps, state } = mockDeps({
    read: () => ({
      records: [],
      raw: {
        Data: {
          Data: Array.from({ length: 12 }, (_, i) => ({ FSigmaField: `SIGMA-VALUE-${i}` })),
        },
      },
    }),
  })
  const { evidence, data } = await executeConfiguredRead(prepared, deps)
  assert.equal(evidence.ok, true)
  assert.deepEqual(evidence.containers, { primary: { type: 'array', arrayLength: 12 } })
  assert.equal(evidence.recordCount, 10, 'data plane is capped at the platform row cap')
  assert.equal(evidence.capReached, true)
  assert.equal(data.recordCount, 10)
  assert.equal(data.containers.primary.records.length, 10)
  assert.deepEqual(data.containers.primary.records[0], { colGamma: 'SIGMA-VALUE-0', colDelta: null, colAbsent: null })
  assertEvidenceValuesFree(evidence)
  assert.equal(state.readArgs[0].limit, 10)
}

async function testDetailWithLinesBothContainersMapped() {
  const prepared = prepareConfiguredRead({ config: normalizedConfig('detail_with_lines'), inputs: { key: 'PBOM-001' } })
  const { deps } = mockDeps({
    read: () => ({
      records: [],
      raw: {
        Data: {
          Page1: [{ FSigmaField: 'SIGMA-VALUE' }],
          Page2: [{ FUnitRef: { FDeltaCode: 'DELTA-CODE' } }, { FSigmaField: 'SIGMA-VALUE-L2' }],
        },
      },
    }),
  })
  const { evidence, data } = await executeConfiguredRead(prepared, deps)
  assert.equal(evidence.ok, true)
  assert.deepEqual(evidence.containers, {
    header: { type: 'array', arrayLength: 1 },
    lines: { type: 'array', arrayLength: 2 },
  })
  assert.equal(evidence.recordCount, 3, 'total mapped records across containers')
  assert.deepEqual(data.containers.header.records, [{ colGamma: 'SIGMA-VALUE', colDelta: null, colAbsent: null }])
  assert.deepEqual(data.containers.lines.records, [
    { colGamma: null, colDelta: 'DELTA-CODE', colAbsent: null },
    { colGamma: 'SIGMA-VALUE-L2', colDelta: null, colAbsent: null },
  ])
  assert.equal(data.recordCount, 3)
  assertEvidenceValuesFree(evidence)
}

async function testContainerMissingAndShapeMismatch() {
  const prepared = prepareConfiguredRead({ config: normalizedConfig('detail_with_lines'), inputs: { key: 'PBOM-001' } })
  const missing = mockDeps({ read: () => ({ records: [], raw: { Data: { Page1: [{}] } } }) })
  const missingOutcome = await executeConfiguredRead(prepared, missing.deps)
  assert.equal(missingOutcome.evidence.ok, false)
  assert.equal(missingOutcome.evidence.errorCode, 'READ_SOURCE_PROBE_CONTAINER_NOT_FOUND')
  assert.equal(missingOutcome.evidence.containerLocated, false)
  assert.equal(missingOutcome.data, null, 'no data plane on container miss')

  const single = prepareConfiguredRead({ config: normalizedConfig('single_record'), inputs: { key: 'M-001' } })
  const scalar = mockDeps({ read: () => ({ records: [], raw: { Data: 'scalar SIGMA-VALUE here' } }) })
  const scalarOutcome = await executeConfiguredRead(single, scalar.deps)
  assert.equal(scalarOutcome.evidence.ok, false)
  assert.equal(scalarOutcome.evidence.errorCode, 'READ_SOURCE_PROBE_SHAPE_MISMATCH')
  assert.equal(scalarOutcome.data, null, 'no data plane on shape mismatch')
  assertEvidenceValuesFree(scalarOutcome.evidence)

  const noRaw = mockDeps({ read: () => ({ records: [{}] }) })
  const noRawOutcome = await executeConfiguredRead(single, noRaw.deps)
  assert.equal(noRawOutcome.evidence.errorCode, 'READ_SOURCE_PROBE_RESPONSE_UNRECOGNIZED')
  assert.equal(noRawOutcome.data, null)
}

async function testAdapterErrorsAreCoarseWithNullData() {
  const prepared = prepareConfiguredRead({ config: normalizedConfig('single_record'), inputs: { key: 'M-001' } })
  const cases = [
    [Object.assign(new Error('401 at https://k3host for M-001'), { name: 'K3WiseWebApiAdapterError', status: 401 }), 'READ_SOURCE_PROBE_AUTH_FAILED'],
    [Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' }), 'READ_SOURCE_PROBE_NETWORK_FAILED'],
    [Object.assign(new Error('business failed'), { name: 'K3WiseWebApiAdapterError', details: { code: 'K3_WISE_READ_BUSINESS_ERROR' } }), 'READ_SOURCE_PROBE_RESPONSE_UNRECOGNIZED'],
  ]
  for (const [error, expectedCode] of cases) {
    const { deps } = mockDeps({ read: () => { throw error } })
    const outcome = await executeConfiguredRead(prepared, deps)
    assert.equal(outcome.evidence.ok, false)
    assert.equal(outcome.evidence.errorCode, expectedCode)
    assert.equal(outcome.data, null)
    assertEvidenceValuesFree(outcome.evidence)
  }
}

async function testTimeoutInjectableAndPathReGuard() {
  const prepared = prepareConfiguredRead({ config: normalizedConfig('single_record'), inputs: { key: 'M-001' } })
  const hang = mockDeps({ read: () => new Promise(() => {}) })
  const timedOut = await executeConfiguredRead(prepared, { ...hang.deps, timeoutMs: 20 })
  assert.equal(timedOut.evidence.errorCode, 'READ_SOURCE_PROBE_TIMEOUT')
  assert.equal(timedOut.evidence.timeoutReached, true)
  assert.equal(timedOut.data, null)

  // Tampered plan (frozen plans cannot be edited; rebuild an unfrozen copy) → refused before any adapter.
  let adapterCreated = false
  for (const readPath of ['https://evil.example.com/x', '//evil.example.com/x', '/a/../admin', '/a/%2e%2e/admin']) {
    const outcome = await executeConfiguredRead(
      { plan: { ...prepared.plan, readPath }, fieldMap: prepared.fieldMap, inputs: prepared.inputs },
      { system: STORED_SYSTEM, createAdapter() { adapterCreated = true; throw new Error('must not be reached') } },
    )
    assert.equal(outcome.evidence.errorCode, 'READ_SOURCE_PROBE_REJECTED', `re-guard must reject ${JSON.stringify(readPath)}`)
    assert.equal(outcome.data, null)
  }
  assert.equal(adapterCreated, false, 'no adapter exists for a rejected readPath')

  await assert.rejects(
    () => executeConfiguredRead(prepared, {
      system: { ...STORED_SYSTEM, kind: 'generic:http' },
      createAdapter() { throw new Error('must not be reached') },
    }),
    (error) => error instanceof ReadSourceProbeRuntimeError && error.reason === 'kind_mismatch',
  )
}

async function main() {
  await testPrepareFailClosed()
  await testSingleRecordDataPlane()
  await testListPageCapAndProjection()
  await testDetailWithLinesBothContainersMapped()
  await testContainerMissingAndShapeMismatch()
  await testAdapterErrorsAreCoarseWithNullData()
  await testTimeoutInjectableAndPathReGuard()

  // Promoted S2-b exports are the SAME functions as their __internals aliases (single source of truth).
  assert.equal(probeRuntime.buildReadSourceProbeOverlayPreset, probeRuntime.__internals.buildReadSourceProbeOverlayPreset)
  assert.equal(probeRuntime.buildReadSourceProbeRequest, probeRuntime.__internals.buildReadSourceProbeRequest)
  assert.equal(probeRuntime.classifyProbeErrorCode, probeRuntime.__internals.classifyProbeErrorCode)
  assert.equal(probeRuntime.normalizeReadSourceProbeInputs, probeRuntime.__internals.normalizeReadSourceProbeInputs)

  // Value-walk internals: own-property only, prototype keys never resolve.
  assert.deepEqual(__internals.walkOwnPath({ a: { b: 7 } }, 'a.b'), { resolved: true, value: 7 })
  assert.deepEqual(__internals.walkOwnPath({ a: {} }, 'a.constructor'), { resolved: false, value: null })
  assert.deepEqual(__internals.mapRecord({ x: 1 }, [{ source: 'x', target: 'y' }]), { y: 1 })

  console.log('read-source-read-runtime.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
