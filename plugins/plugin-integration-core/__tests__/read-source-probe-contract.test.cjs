'use strict'

// External-API read self-service S2-a — probe contract + values-free evidence schema.
// Pure functions only: no network, no registry, no credentials, no persistence, no routes, no writes.

const assert = require('node:assert/strict')
const path = require('node:path')

const { validateReadSourceConfig } = require(path.join(__dirname, '..', 'lib', 'read-source-config.cjs'))
const {
  READ_SOURCE_PROBE_TIMEOUT_MS,
  READ_SOURCE_PROBE_ROW_CAP,
  ReadSourceProbeContractError,
  normalizeReadSourceProbeContract,
  readSourceProbeContractErrorEvidence,
  readSourceProbeEvidence,
} = require(path.join(__dirname, '..', 'lib', 'read-source-probe-contract.cjs'))

function normalizedConfig(mode) {
  const cfg = {
    version: 1,
    systemId: 'sys_1',
    requiredKind: 'erp:k3-wise-webapi',
    object: mode === 'detail_with_lines' ? 'material-bom' : 'material',
    mode,
    readPath: '/K3API/Material/GetList',
    readMethod: 'POST',
    operations: ['read'],
  }
  if (mode === 'single_record') {
    cfg.keyField = 'FNumber'
    cfg.keyEncoding = 'structured_json_field'
    cfg.containerPaths = ['Data']
  }
  if (mode === 'list_page') {
    cfg.containerPaths = ['Data.Data', 'Data.DATA']
  }
  if (mode === 'detail_with_lines') {
    cfg.readPath = '/K3API/BOM/GetDetail'
    cfg.keyField = 'FBillNo'
    cfg.keyEncoding = 'structured_json_field'
    cfg.headerContainerPaths = ['Data.Page1']
    cfg.lineContainerPaths = ['Data.Page2']
  }
  if (mode === 'resolver_lookup') {
    cfg.keyField = 'FMaterialId'
    cfg.keyEncoding = 'structured_json_field'
    cfg.containerPaths = ['Data.Rows']
    cfg.multiplicityRuleField = 'FIsCurrent'
  }
  const result = validateReadSourceConfig(cfg)
  assert.equal(result.valid, true, `${mode} fixture must validate: ${JSON.stringify(result.errors)}`)
  return result.normalized
}

function assertContractReason(input, reason) {
  assert.throws(
    () => normalizeReadSourceProbeContract(input),
    (error) => error instanceof ReadSourceProbeContractError && error.reason === reason,
    `expected ${reason}`,
  )
}

// --- 1. S2-a consumes S1 normalized config only and emits a frozen future probe plan ---
{
  const plan = normalizeReadSourceProbeContract({ config: normalizedConfig('list_page'), boundedSmoke: true })
  assert.deepEqual(plan, {
    systemId: 'sys_1',
    requiredKind: 'erp:k3-wise-webapi',
    object: 'material',
    mode: 'list_page',
    readPath: '/K3API/Material/GetList',
    readMethod: 'POST',
    operations: ['read'],
    requiredNamedInputs: [],
    containers: [{ alias: 'primary', paths: ['Data.Data', 'Data.DATA'] }],
    boundedSmoke: true,
    timeoutMs: READ_SOURCE_PROBE_TIMEOUT_MS,
    rowCap: READ_SOURCE_PROBE_ROW_CAP,
  })
  assert.ok(Object.isFrozen(plan), 'plan is frozen')
  assert.ok(Object.isFrozen(plan.operations), 'operations is frozen')
  assert.ok(Object.isFrozen(plan.containers), 'containers list is frozen')
  assert.ok(Object.isFrozen(plan.containers[0].paths), 'container paths are frozen')
}

// detail_with_lines gets distinct aliases; keyed modes declare the future runtime key input but do not accept a key value.
{
  const plan = normalizeReadSourceProbeContract({ config: normalizedConfig('detail_with_lines') })
  assert.equal(plan.keyField, 'FBillNo')
  assert.equal(plan.keyEncoding, 'structured_json_field')
  assert.deepEqual(plan.requiredNamedInputs, ['key'])
  assert.deepEqual(plan.containers, [
    { alias: 'header', paths: ['Data.Page1'] },
    { alias: 'lines', paths: ['Data.Page2'] },
  ])
}

// resolver metadata is structural; no row values are involved.
{
  const plan = normalizeReadSourceProbeContract({ config: normalizedConfig('resolver_lookup') })
  assert.equal(plan.multiplicityRuleField, 'FIsCurrent')
  assert.deepEqual(plan.requiredNamedInputs, ['key'])
  assert.deepEqual(plan.containers, [{ alias: 'primary', paths: ['Data.Rows'] }])
}

// --- 2. Strict top-level contract: raw path/method/body/credential cannot ride beside config ---
assertContractReason(null, 'not_object')
assertContractReason({ config: normalizedConfig('list_page'), readPath: '/K3API/evil' }, 'unexpected_field')
assertContractReason({ config: normalizedConfig('list_page'), credential: 'Bearer SECRET' }, 'unexpected_field')
assertContractReason({ config: normalizedConfig('list_page'), boundedSmoke: 'yes' }, 'bounded_smoke_invalid')
assertContractReason({ config: null }, 'config_required')

// A valid-but-raw S1 config is rejected until caller passes S1's normalized output.
{
  const raw = {
    version: 1,
    systemId: ' sys_1 '.trim(),
    requiredKind: 'erp:k3-wise-webapi',
    object: 'material',
    mode: 'list_page',
    readPath: 'K3API/Material/GetList',
    readMethod: 'POST',
    operations: ['read'],
    containerPaths: ['Data.Data'],
  }
  assert.equal(validateReadSourceConfig(raw).valid, true, 'raw config validates at S1')
  assertContractReason({ config: raw }, 'config_not_normalized')
}

// Invalid config stays values-free: the hostile URL never appears in the contract error evidence.
{
  let error
  try {
    normalizeReadSourceProbeContract({
      config: {
        ...normalizedConfig('list_page'),
        readPath: 'https://EVIL-HOST-LEAK.example/steal',
      },
    })
  } catch (e) {
    error = e
  }
  const evidence = readSourceProbeContractErrorEvidence(error)
  assert.deepEqual(evidence, {
    ok: false,
    errorCode: 'READ_SOURCE_PROBE_CONTRACT_INVALID',
    reason: 'config_invalid',
  })
  const text = JSON.stringify(evidence)
  for (const leak of ['EVIL-HOST-LEAK', 'steal', 'https://']) {
    assert.ok(!text.includes(leak), `contract error evidence must not leak ${leak}`)
  }
}

// --- 3. Probe evidence is values-free and alias-only; arbitrary containers/values are stripped ---
{
  const plan = normalizeReadSourceProbeContract({ config: normalizedConfig('detail_with_lines'), boundedSmoke: true })
  const evidence = readSourceProbeEvidence(plan, {
    ok: true,
    recordCount: 3,
    rowCount: 4,
    sampleCount: 2,
    containerLocated: true,
    boundedSmokeExecuted: true,
    timeoutReached: false,
    capReached: false,
    raw: { secret: 'SECRET-RAW' },
    readPath: 'https://k3host/K3API/BOM/GetDetail',
    containers: {
      header: { type: 'array', arrayLength: 1, rows: [{ materialNumber: 'SECRET-H-001' }] },
      lines: { type: 'array', arrayLength: 3, materialNumber: 'SECRET-L-001' },
      primary: { type: 'array', arrayLength: 99, materialNumber: 'SECRET-P-001' },
      arbitraryContainer: { type: 'array', arrayLength: 42, materialNumber: 'SECRET-X-001' },
    },
  })
  assert.deepEqual(evidence, {
    ok: true,
    object: 'material-bom',
    mode: 'detail_with_lines',
    boundedSmoke: true,
    containers: {
      header: { type: 'array', arrayLength: 1 },
      lines: { type: 'array', arrayLength: 3 },
    },
    recordCount: 3,
    rowCount: 4,
    sampleCount: 2,
    containerLocated: true,
    boundedSmokeExecuted: true,
    timeoutReached: false,
    capReached: false,
  })
  const text = JSON.stringify(evidence)
  for (const leak of ['SECRET-RAW', 'SECRET-H-001', 'SECRET-L-001', 'SECRET-P-001', 'SECRET-X-001', 'materialNumber', 'arbitraryContainer', 'rows', 'k3host', 'readPath']) {
    assert.ok(!text.includes(leak), `probe evidence must not leak ${leak}`)
  }
}

// Bad counts/types and non-allowlisted booleans are dropped.
{
  const plan = normalizeReadSourceProbeContract({ config: normalizedConfig('list_page') })
  const evidence = readSourceProbeEvidence(plan, {
    ok: true,
    recordCount: -1,
    rowCount: 1.5,
    sampleCount: '10',
    containerLocated: 'yes',
    arbitraryBoolean: true,
    containers: {
      primary: { type: 'not-a-type', arrayLength: 2 },
      lines: { type: 'array', arrayLength: -1 },
    },
  })
  assert.deepEqual(evidence, {
    ok: true,
    object: 'material',
    mode: 'list_page',
    boundedSmoke: false,
  })
}

// Error evidence is coarse and enum-shaped. Messages / raw details are never read.
{
  const plan = normalizeReadSourceProbeContract({ config: normalizedConfig('list_page') })
  const evidence = readSourceProbeEvidence(plan, {
    ok: false,
    errorCode: 'READ_SOURCE_PROBE_REJECTED',
    errorType: 'K3WiseWebApiAdapterError',
    message: 'material MAT-001 leaked',
    details: { token: 'SECRET-TOKEN' },
    containers: {
      primary: { type: 'null', arrayLength: null, materialNumber: 'SECRET-MAT-001' },
    },
  })
  assert.deepEqual(evidence, {
    ok: false,
    object: 'material',
    mode: 'list_page',
    boundedSmoke: false,
    containers: {
      primary: { type: 'null', arrayLength: null },
    },
    errorCode: 'READ_SOURCE_PROBE_REJECTED',
    errorType: 'K3WiseWebApiAdapterError',
  })
  const text = JSON.stringify(evidence)
  for (const leak of ['MAT-001', 'SECRET-TOKEN', 'materialNumber', 'message', 'details']) {
    assert.ok(!text.includes(leak), `probe error evidence must not leak ${leak}`)
  }
}

// Unsafe error code/type falls back to safe defaults.
{
  const plan = normalizeReadSourceProbeContract({ config: normalizedConfig('list_page') })
  for (const [errorCode, errorType, expectedErrorType] of [
    ['MAT-001', 'evil.example.com', 'Error'],
    ['PO-2024-000123', 'Data.Page2.FItemId', 'Error'],
    ['READ_SOURCE_PROBE_MAT-001', 'K3WiseWebApiAdapterError', 'K3WiseWebApiAdapterError'],
    ['READ_FAILED_MAT_001', 'bad type with spaces', 'Error'],
    ['MAT-001 failed with secret value 42', 'https://evil.example.com', 'Error'],
  ]) {
    const evidence = readSourceProbeEvidence(plan, { ok: false, errorCode, errorType })
    assert.deepEqual(evidence, {
      ok: false,
      object: 'material',
      mode: 'list_page',
      boundedSmoke: false,
      errorCode: 'READ_SOURCE_PROBE_FAILED',
      errorType: expectedErrorType,
    })
    const text = JSON.stringify(evidence)
    for (const leak of ['MAT-001', 'PO-2024-000123', 'evil.example.com', 'Data.Page2.FItemId', 'READ_FAILED_MAT_001', 'READ_SOURCE_PROBE_MAT-001']) {
      assert.ok(!text.includes(leak), `unsafe error evidence must not leak ${leak}`)
    }
  }
}

console.log('read-source-probe-contract.test.cjs OK')
