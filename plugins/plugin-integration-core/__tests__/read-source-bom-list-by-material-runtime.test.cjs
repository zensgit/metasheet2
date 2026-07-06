'use strict'

// K3 WISE BOM/GetList-by-material — BL2 runtime tests (#1709, BL0 design-lock
// integration-k3wise-bom-list-by-material-id-design-lock-20260705.md). Hermetic: mock adapter for the
// runtime plane, injected fetch for the REAL adapter wire plane — no network, no persistence, no route.
//
// Coverage map (BL0 §Negative Controls + owner review of #3689 constraints 1&2):
//   contract lock  — every preset-owned field drift fails closed BEFORE any adapter/outbound call
//   pinned wire    — real-adapter fetch-level EXACT body assert (operator `=`, 7-key body, Data root,
//                    SelectPage=2, Fields=FBOMNumber) — the wire-vs-fixture drift rule
//   key discipline — numeric-only key, injection-shaped/missing/non-scalar keys fail before K3
//   family surface — NOT_FOUND / AMBIGUOUS / FIELD_MISSING / SHAPE_MISMATCH / REJECTED / KEY_INVALID
//   values-free    — no key, BOM value, host, credential, or K3 message text in any evidence
//   read-only      — no write method, no BOM/GetDetail, single GetList call, cap enforced

const assert = require('node:assert/strict')
const path = require('node:path')

const { validateReadSourceConfig } = require(path.join(__dirname, '..', 'lib', 'read-source-config.cjs'))
const {
  READ_SOURCE_PROBE_ERROR_CODES,
  ReadSourceProbeContractError,
} = require(path.join(__dirname, '..', 'lib', 'read-source-probe-contract.cjs'))
const {
  prepareConfiguredRead,
  executeConfiguredRead,
} = require(path.join(__dirname, '..', 'lib', 'read-source-read-runtime.cjs'))
const { READ_SMOKE_BOM_LIST_BY_MATERIAL_REQUEST_MARKER } = require(path.join(__dirname, '..', 'lib', 'read-smoke-marker.cjs'))
const {
  K3WISE_BOM_LIST_BY_MATERIAL_PRESET,
  K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODES,
  K3_WISE_BOM_LIST_BY_MATERIAL_RESOLVER_CODE_MAP,
  isBomListByMaterialKeyValid,
  bomListByMaterialContractViolation,
} = require(path.join(__dirname, '..', 'lib', 'read-source-bom-list-by-material-contract.cjs'))
const { createK3WiseWebApiAdapter } = require(path.join(__dirname, '..', 'lib', 'adapters', 'k3-wise-webapi-adapter.cjs'))

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────────

function presetConfig(overrides = {}) {
  const cfg = {
    version: 1,
    systemId: 'sys_bl2',
    requiredKind: 'erp:k3-wise-webapi',
    object: 'material-bom-list',
    mode: 'resolver_lookup',
    readPath: '/K3API/BOM/GetList',
    readMethod: 'POST',
    operations: ['read'],
    keyField: 'FPercentItemID',
    keyEncoding: 'numeric_id',
    containerPaths: ['Data.DATA'],
    resolverRule: 'exactly_one',
    fieldMap: [{ source: 'FBOMNumber', target: 'bom_number' }],
  }
  Object.assign(cfg, overrides)
  const result = validateReadSourceConfig(cfg)
  assert.equal(result.valid, true, `preset fixture must S1-validate: ${JSON.stringify(result.errors)}`)
  return result.normalized
}

const STORED_SYSTEM = Object.freeze({
  id: 'sys_bl2',
  tenantId: 'tenant_1',
  kind: 'erp:k3-wise-webapi',
  role: 'target',
  credentials: Object.freeze({ username: 'demo', password: 'wire-secret', acctId: '001' }),
  config: Object.freeze({ baseUrl: 'https://k3host.internal' }),
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

function happyRaw() {
  return {
    StatusCode: 200,
    Message: 'Successful',
    Data: { ROWCOUNT: 1, PAGESIZE: 10, PAGEINDEX: 1, DATA: [{ FBOMNumber: 'BOM-PLANTED-001' }] },
  }
}

// Data-plane / private-value sentinels that must NEVER appear in values-free evidence.
const EVIDENCE_SENTINELS = Object.freeze([
  '31415', 'BOM-PLANTED', 'FBOMNumber', 'bom_number', 'k3host', 'wire-secret', 'Successful', 'boom-message',
  'tenant_1', 'sys_bl2',
])

function assertEvidenceValuesFree(evidence) {
  const text = JSON.stringify(evidence)
  for (const sentinel of EVIDENCE_SENTINELS) {
    assert.ok(!text.includes(sentinel), `evidence must not leak ${sentinel}: ${text}`)
  }
}

// ── contract-lock (owner review constraint 1): every preset-owned field drift fails closed early ──────

function testContractLockDrifts() {
  const drifts = [
    [{ keyField: 'FItemID' }, 'bom_list_by_material_filter_field_drift'],
    [{ keyEncoding: undefined }, 'bom_list_by_material_key_encoding_drift'],
    [{ keyEncoding: 'filter_expression' }, 'bom_list_by_material_key_encoding_drift'],
    [{ readPath: '/K3API/BOM/GetOther' }, 'bom_list_by_material_read_path_drift'],
    // Suffix trap: a path that merely CONTAINS the endpoint name is still a drift.
    [{ readPath: '/K3API/BOM/GetListExtra' }, 'bom_list_by_material_read_path_drift'],
    [{ readMethod: 'GET' }, 'bom_list_by_material_read_method_drift'],
    [{ containerPaths: ['Data.Rows'] }, 'bom_list_by_material_row_container_drift'],
    [{ containerPaths: ['Data.DATA', 'Data.Rows'] }, 'bom_list_by_material_row_container_drift'],
    [
      { resolverRule: 'first_when_sorted', multiplicityRuleField: 'FVersion', resolverSortDirection: 'desc' },
      'bom_list_by_material_resolver_rule_drift',
    ],
    [{ fieldMap: [{ source: 'FInterID', target: 'bom_number' }] }, 'bom_list_by_material_output_field_drift'],
  ]
  for (const [overrides, reason] of drifts) {
    const config = presetConfig(overrides)
    assert.throws(
      () => prepareConfiguredRead({ config, inputs: { key: '31415' } }),
      (error) => error instanceof ReadSourceProbeContractError && error.reason === reason,
      `drifted preset config must fail closed with ${reason}`,
    )
  }

  // Bare endpoint (no deployment prefix) is NOT a drift — the preset owns the trailing endpoint.
  prepareConfiguredRead({ config: presetConfig({ readPath: '/BOM/GetList' }), inputs: { key: '31415' } })

  // Identity-negative control: a NON-preset resolver_lookup (hop-1 shape) is untouched by the lock.
  const hop1 = {
    version: 1,
    systemId: 'sys_bl2',
    requiredKind: 'erp:k3-wise-webapi',
    object: 'material',
    mode: 'resolver_lookup',
    readPath: '/K3API/Material/GetDetail',
    readMethod: 'POST',
    operations: ['read'],
    keyField: 'FNumber',
    containerPaths: ['Data.Rows'],
    resolverRule: 'exactly_one',
    fieldMap: [{ source: 'FItemID', target: 'item_id' }],
  }
  const hop1Result = validateReadSourceConfig(hop1)
  assert.equal(hop1Result.valid, true)
  prepareConfiguredRead({ config: hop1Result.normalized, inputs: { key: 'MAT-SENTINEL-1' } })

  // The pure lock helper itself: a fully-locked config yields null.
  assert.equal(bomListByMaterialContractViolation(presetConfig()), null)
}

// ── runtime request shape + overlay (mock adapter) ────────────────────────────────────────────────────

async function testRequestShapeAndHappyPath() {
  const prepared = prepareConfiguredRead({ config: presetConfig(), inputs: { key: '31415' } })
  const { deps, state } = mockDeps({ read: async () => ({ records: [], raw: happyRaw() }) })
  const outcome = await executeConfiguredRead(prepared, deps)

  // Happy path: resolver data plane carries exactly the one output target+value.
  assert.equal(outcome.evidence.ok, true)
  assert.equal(outcome.evidence.resolved, true)
  assert.equal(outcome.evidence.rule, 'exactly_one')
  assert.equal(outcome.evidence.candidateCount, 1)
  assert.deepEqual(outcome.data, { resolver: { target: 'bom_number', value: 'BOM-PLANTED-001' } })
  assertEvidenceValuesFree(outcome.evidence)

  // Request: key rides ONLY as the dedicated option; no filters, no endpoint, no body, no field list.
  assert.equal(state.readArgs.length, 1)
  const request = state.readArgs[0]
  assert.equal(request.object, 'material-bom-list')
  assert.equal(request.limit, 10)
  assert.deepEqual(request.filters, undefined)
  // String-keyed options exactly these two (the Symbol marker is asserted separately below).
  assert.deepEqual(
    Object.fromEntries(Object.keys(request.options).map((key) => [key, request.options[key]])),
    { k3ReadMode: 'bom_list_by_material', bomListMaterialKey: '31415' },
  )
  assert.equal(request.options[READ_SMOKE_BOM_LIST_BY_MATERIAL_REQUEST_MARKER], true, 'marker must ride the request options')

  // Overlay: readMode mapped, operations read-only, path/method from the locked config — and NOTHING
  // filter/body-shaped (those are pinned inside the adapter mode, not overlay-configurable).
  assert.equal(state.adapterSystems.length, 1)
  const overlayObject = state.adapterSystems[0].config.objects['material-bom-list']
  assert.deepEqual(overlayObject, {
    operations: ['read'],
    readPath: '/K3API/BOM/GetList',
    readMethod: 'POST',
    readMode: 'bom_list_by_material',
  })

  // Read-only invariant: no write method was ever called.
  assert.deepEqual(state.writeCalls, [])
}

// ── resolver failure → registered family remap (BL0 taxonomy) ────────────────────────────────────────

async function testResolverFamilyRemap() {
  const cases = [
    [{ StatusCode: 200, Data: { DATA: [] } }, 'K3_WISE_BOM_LIST_BY_MATERIAL_NOT_FOUND'],
    [
      { StatusCode: 200, Data: { DATA: [{ FBOMNumber: 'BOM-PLANTED-001' }, { FBOMNumber: 'BOM-PLANTED-002' }] } },
      'K3_WISE_BOM_LIST_BY_MATERIAL_AMBIGUOUS',
    ],
    [{ StatusCode: 200, Data: { DATA: [{ FInterID: 7 }] } }, 'K3_WISE_BOM_LIST_BY_MATERIAL_FIELD_MISSING'],
    // The ORIGINAL live failure shape: scalar Data status envelope — container missing → shape family.
    [{ StatusCode: 200, Data: 'scalar-status-data' }, 'K3_WISE_BOM_LIST_BY_MATERIAL_SHAPE_MISMATCH'],
    // Cap reached: uniqueness cannot be proven within the bounded read.
    [
      { StatusCode: 200, Data: { DATA: Array.from({ length: 12 }, (_, i) => ({ FBOMNumber: `BOM-PLANTED-${i}` })) } },
      'K3_WISE_BOM_LIST_BY_MATERIAL_AMBIGUOUS',
    ],
  ]
  for (const [raw, expectedCode] of cases) {
    const prepared = prepareConfiguredRead({ config: presetConfig(), inputs: { key: '31415' } })
    const { deps, state } = mockDeps({ read: async () => ({ records: [], raw }) })
    const outcome = await executeConfiguredRead(prepared, deps)
    assert.equal(outcome.evidence.ok, false, expectedCode)
    assert.equal(outcome.evidence.errorCode, expectedCode)
    assert.equal(outcome.data, null, `${expectedCode} must not leak a winner (no "first row wins")`)
    assert.ok(READ_SOURCE_PROBE_ERROR_CODES.includes(outcome.evidence.errorCode), 'family code must be registered')
    assertEvidenceValuesFree(outcome.evidence)
    assert.deepEqual(state.writeCalls, [])
  }

  // Every map entry lands inside the registered 8-code family (no unregistered target can slip in).
  for (const mapped of Object.values(K3_WISE_BOM_LIST_BY_MATERIAL_RESOLVER_CODE_MAP)) {
    assert.ok(K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODES.includes(mapped))
  }

  // Identity-negative: a non-preset resolver keeps its generic resolver code (no blanket remap).
  const hop1 = validateReadSourceConfig({
    version: 1,
    systemId: 'sys_bl2',
    requiredKind: 'erp:k3-wise-webapi',
    object: 'material',
    mode: 'resolver_lookup',
    readPath: '/K3API/Material/GetList',
    readMethod: 'POST',
    operations: ['read'],
    keyField: 'FNumber',
    containerPaths: ['Data.DATA'],
    resolverRule: 'exactly_one',
    fieldMap: [{ source: 'FItemID', target: 'item_id' }],
  }).normalized
  const preparedHop1 = prepareConfiguredRead({ config: hop1, inputs: { key: 'MAT-SENTINEL-1' } })
  const { deps } = mockDeps({ read: async () => ({ records: [], raw: { StatusCode: 200, Data: { DATA: [] } } }) })
  const hop1Outcome = await executeConfiguredRead(preparedHop1, deps)
  assert.equal(hop1Outcome.evidence.errorCode, 'READ_SOURCE_RESOLVER_NO_MATCH')
}

// ── REAL adapter wire plane: pinned body, single GetList, no write/GetDetail (constraint 2) ──────────

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async text() { return JSON.stringify(body) },
  }
}

function createWireHarness(getListBody) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url)
    calls.push({
      pathname: parsed.pathname,
      method: options.method || 'GET',
      body: options.body ? JSON.parse(options.body) : undefined,
    })
    if (parsed.pathname === '/K3API/Login') {
      return jsonResponse(200, { success: true, sessionId: 'k3-session-1' })
    }
    if (parsed.pathname === '/K3API/BOM/GetList') {
      return jsonResponse(200, getListBody)
    }
    return jsonResponse(404, { StatusCode: 404, Message: 'not found' })
  }
  const deps = {
    system: STORED_SYSTEM,
    createAdapter: (adapterSystem) => createK3WiseWebApiAdapter({ system: adapterSystem, fetchImpl }),
  }
  return { calls, deps }
}

async function testRealAdapterPinnedWire() {
  const prepared = prepareConfiguredRead({ config: presetConfig(), inputs: { key: '31415' } })
  const { calls, deps } = createWireHarness(happyRaw())
  const outcome = await executeConfiguredRead(prepared, deps)

  assert.equal(outcome.evidence.ok, true)
  assert.deepEqual(outcome.data, { resolver: { target: 'bom_number', value: 'BOM-PLANTED-001' } })
  assertEvidenceValuesFree(outcome.evidence)

  // Exactly one login + ONE GetList — no GetDetail, no Save/Submit/Audit, no recursion, nothing else.
  assert.deepEqual(calls.map((call) => call.pathname), ['/K3API/Login', '/K3API/BOM/GetList'])
  const wire = calls[1]
  assert.equal(wire.method, 'POST')
  // THE pinned-body lock (owner review constraint 2): exact 7-key body under the Data root, pinned `=`
  // operator, bracketed pinned filter column, bare validated numeric key, SelectPage=2, Fields pinned.
  assert.deepEqual(wire.body, {
    Data: {
      Top: 10,
      PageSize: 10,
      PageIndex: 1,
      Filter: '[FPercentItemID] = 31415',
      OrderBy: '',
      SelectPage: 2,
      Fields: 'FBOMNumber',
    },
  })
}

async function testRealAdapterEnvelopeRejected() {
  const prepared = prepareConfiguredRead({ config: presetConfig(), inputs: { key: '31415' } })
  const { calls, deps } = createWireHarness({ StatusCode: 500, Message: 'boom-message', Data: 'scalar-status-data' })
  const outcome = await executeConfiguredRead(prepared, deps)
  assert.equal(outcome.evidence.ok, false)
  assert.equal(outcome.evidence.errorCode, 'K3_WISE_BOM_LIST_BY_MATERIAL_REJECTED')
  assert.equal(outcome.evidence.errorType, 'K3WiseWebApiAdapterError')
  assert.equal(outcome.data, null)
  // K3 message text must never surface in evidence.
  assertEvidenceValuesFree(outcome.evidence)
  assert.deepEqual(calls.map((call) => call.pathname), ['/K3API/Login', '/K3API/BOM/GetList'])
}

async function testRealAdapterKeyDiscipline() {
  // Non-numeric / injection-shaped keys fail BEFORE any outbound call (no login, no GetList).
  for (const badKey of ['31a15', '1 OR 1=1', "1' --", '1;DROP', '9'.repeat(21), '[FItemID]']) {
    const prepared = prepareConfiguredRead({ config: presetConfig(), inputs: { key: badKey } })
    const { calls, deps } = createWireHarness(happyRaw())
    const outcome = await executeConfiguredRead(prepared, deps)
    assert.equal(outcome.evidence.ok, false, `key ${JSON.stringify(badKey)} must fail`)
    assert.equal(outcome.evidence.errorCode, 'K3_WISE_BOM_LIST_BY_MATERIAL_KEY_INVALID')
    assert.equal(calls.length, 0, 'a rejected key must produce ZERO outbound calls (not even login)')
    assertEvidenceValuesFree(outcome.evidence)
  }

  // Missing / non-scalar keys fail at the input-normalization tier (contract error, values-free reason).
  assert.throws(
    () => prepareConfiguredRead({ config: presetConfig(), inputs: {} }),
    (error) => error instanceof ReadSourceProbeContractError && error.reason === 'key_required',
  )
  assert.throws(
    () => prepareConfiguredRead({ config: presetConfig(), inputs: { key: { nested: 1 } } }),
    (error) => error instanceof ReadSourceProbeContractError && error.reason === 'key_required',
  )
}

// ── adapter-direct gates: marker, config mode, limit cap, wrong object/mode ─────────────────────────

async function testAdapterDirectGates() {
  const system = {
    ...STORED_SYSTEM,
    config: {
      baseUrl: 'https://k3host.internal',
      objects: {
        'material-bom-list': {
          operations: ['read'],
          readPath: '/K3API/BOM/GetList',
          readMethod: 'POST',
          readMode: 'bom_list_by_material',
        },
      },
    },
  }
  const fetchImpl = async () => { throw new Error('no outbound call may happen in gate tests') }
  const adapter = createK3WiseWebApiAdapter({ system, fetchImpl })

  const markedOptions = (extra = {}) => {
    const options = { k3ReadMode: 'bom_list_by_material', bomListMaterialKey: '31415', ...extra }
    Object.defineProperty(options, READ_SMOKE_BOM_LIST_BY_MATERIAL_REQUEST_MARKER, { value: true, enumerable: true })
    return options
  }

  // Marker gate: without the Symbol marker the mode is unreachable (a JSON body cannot manufacture it).
  // limit is set to the in-bound value so the marker is the ONLY failing gate here — otherwise the limit
  // guard's identical family code would alias this test and a removed marker gate would go unnoticed
  // (caught by mutation-testing this exact guard).
  await assert.rejects(
    adapter.read({ object: 'material-bom-list', limit: 10, options: { k3ReadMode: 'bom_list_by_material', bomListMaterialKey: '31415' } }),
    (error) => error.name === 'AdapterValidationError' && error.details.code === 'K3_WISE_BOM_LIST_BY_MATERIAL_REJECTED',
  )

  // Request-supplied raw filter is rejected outright.
  await assert.rejects(
    adapter.read({ object: 'material-bom-list', filters: { Filter: '[FPercentItemID] = 31415' }, options: markedOptions() }),
    (error) => error.name === 'AdapterValidationError' && error.details.code === 'K3_WISE_BOM_LIST_BY_MATERIAL_REJECTED',
  )

  // Request-supplied unexpected option (e.g. a smuggled field list) is rejected outright.
  await assert.rejects(
    adapter.read({ object: 'material-bom-list', options: markedOptions({ fields: 'FBOMNumber,FSecret' }) }),
    (error) => error.name === 'AdapterValidationError' && error.details.code === 'K3_WISE_BOM_LIST_BY_MATERIAL_REJECTED',
  )

  // Fixed page bound.
  await assert.rejects(
    adapter.read({ object: 'material-bom-list', limit: 50, options: markedOptions() }),
    (error) => error.name === 'AdapterValidationError' && error.details.code === 'K3_WISE_BOM_LIST_BY_MATERIAL_REJECTED',
  )

  // Config without the matching readMode cannot be steered into the mode by the option alone.
  const detailSystem = {
    ...system,
    config: {
      baseUrl: 'https://k3host.internal',
      objects: { 'material-bom-list': { operations: ['read'], readPath: '/K3API/BOM/GetList' } },
    },
  }
  const detailAdapter = createK3WiseWebApiAdapter({ system: detailSystem, fetchImpl })
  await assert.rejects(
    detailAdapter.read({ object: 'material-bom-list', options: markedOptions() }),
    (error) => error.name === 'AdapterValidationError' && error.details.code === 'K3_WISE_BOM_LIST_BY_MATERIAL_NOT_CONFIGURED',
  )
}

// Wrong MODE with the preset object (identity miss → generic path → adapter scope guard fires before
// any outbound read; BL0 "wrong object or mode fails before adapter read").
async function testWrongModeFailsBeforeRead() {
  const config = validateReadSourceConfig({
    version: 1,
    systemId: 'sys_bl2',
    requiredKind: 'erp:k3-wise-webapi',
    object: 'material-bom-list',
    mode: 'list_page',
    readPath: '/K3API/BOM/GetList',
    readMethod: 'POST',
    operations: ['read'],
    containerPaths: ['Data.DATA'],
    fieldMap: [{ source: 'FBOMNumber', target: 'bom_number' }],
  }).normalized
  const prepared = prepareConfiguredRead({ config, inputs: undefined })
  const { calls, deps } = createWireHarness(happyRaw())
  const outcome = await executeConfiguredRead(prepared, deps)
  assert.equal(outcome.evidence.ok, false)
  // The LIST scope guard rejects the non-material object before any outbound LIST call.
  assert.equal(outcome.evidence.errorCode, 'READ_SOURCE_PROBE_REJECTED')
  assert.equal(calls.filter((call) => call.pathname === '/K3API/BOM/GetList').length, 0)
}

// ── latent-state + key predicate units ───────────────────────────────────────────────────────────────

function testLatentStateAndKeyPredicate() {
  // The controlled false→true transition (owner review constraint; BL0 standalone-first gate) happened
  // at BL3: standalone entity-machine smoke PASS #3701 (happy path + fail-closed AMBIGUOUS policy check).
  assert.equal(K3WISE_BOM_LIST_BY_MATERIAL_PRESET.runtimeValidated, true)
  assert.equal(K3WISE_BOM_LIST_BY_MATERIAL_PRESET.byMaterialExampleInDocs, false)

  for (const good of ['31415', '007', 42, '9'.repeat(20)]) {
    assert.equal(isBomListByMaterialKeyValid(good), true, `key ${JSON.stringify(good)} must be valid`)
  }
  // Precision-lossy large doubles are rejected on the number branch (Number.isSafeInteger bound) — a
  // corrupted stringification must never become a filter value.
  for (const bad of ['', '31a15', '1 OR 1=1', "1'", '-1', 1.5, -3, 1e20, Number.MAX_SAFE_INTEGER + 2, null, undefined, {}, [], '9'.repeat(21), 'FItemID']) {
    assert.equal(isBomListByMaterialKeyValid(bad), false, `key ${JSON.stringify(bad)} must be invalid`)
  }
}

async function main() {
  testContractLockDrifts()
  await testRequestShapeAndHappyPath()
  await testResolverFamilyRemap()
  await testRealAdapterPinnedWire()
  await testRealAdapterEnvelopeRejected()
  await testRealAdapterKeyDiscipline()
  await testAdapterDirectGates()
  await testWrongModeFailsBeforeRead()
  testLatentStateAndKeyPredicate()
  console.log('read-source-bom-list-by-material-runtime.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
