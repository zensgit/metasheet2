'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { validateReadSourceConfig } = require('../lib/read-source-config.cjs')
const { buildK3WiseMaterialListB4Config } = require('../lib/read-source-k3-material-list-b4-contract.cjs')
const { prepareConfiguredRead, executeConfiguredRead } = require('../lib/read-source-read-runtime.cjs')
const { prepareReadSourceProbe, executeReadSourceProbe } = require('../lib/read-source-probe-runtime.cjs')
const { createK3WiseWebApiAdapter } = require('../lib/adapters/k3-wise-webapi-adapter.cjs')
const { b4MaterialListResponseViolation } = require('../lib/k3-read-operation-profiles.cjs')

function approvedConfig(profile = 'k3wise.material_list.v1') {
  const candidate = { ...buildK3WiseMaterialListB4Config({ systemId: 'synthetic' }), version: 9 }
  if (profile === null) delete candidate.actionProfileVersion
  else if (profile !== 'k3wise.material_list.v1') candidate.actionProfileVersion = profile
  const result = validateReadSourceConfig(candidate)
  assert.equal(result.valid, true)
  return result.normalized
}

function system() {
  return {
    id: 'synthetic', tenantId: 'synthetic', kind: 'erp:k3-wise-webapi', role: 'source',
    credentials: { sessionId: 'synthetic-session' },
    config: { baseUrl: 'http://127.0.0.1:1', objects: { material: { operations: ['read'] } } },
  }
}

function response(body) {
  return { ok: true, status: 200, async text() { return JSON.stringify(body) } }
}

async function run(kind, body, { profile, rowSource = 'adapter_records', pageIndex = 1, systemConfig = {} } = {}) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ path: new URL(url).pathname, body: JSON.parse(options.body) })
    return response(body)
  }
  const targetSystem = system()
  Object.assign(targetSystem.config, systemConfig)
  const deps = {
    system: targetSystem,
    createAdapter: (adapterSystem) => createK3WiseWebApiAdapter({ system: adapterSystem, fetchImpl }),
  }
  const config = approvedConfig(profile)
  if (kind === 'probe') {
    const prepared = prepareReadSourceProbe({ config, boundedSmoke: true, inputs: { pageIndex } })
    return { outcome: await executeReadSourceProbe(prepared, deps), calls }
  }
  const prepared = prepareConfiguredRead({ config, inputs: { pageIndex } })
  return { outcome: await executeConfiguredRead(prepared, deps, { rowSource, pageIndex, rowCap: 10 }), calls }
}

const row = { FItemID: 1001, FNumber: 'MAT-1', FName: 'Material 1', FModel: 'SPEC', FUnitID: 'PCS', PasswordCanary: 'MUST-NOT-LEAK' }
const valid = { StatusCode: 200, Data: { DATA: [row], PAGEINDEX: 1, PAGESIZE: 10, ROWCOUNT: 1 } }
const consumers = [
  { kind: 'configured', rowSource: 'adapter_records' },
  { kind: 'configured', rowSource: 'raw_containers' },
  { kind: 'probe' },
]

test('known B4 projects only four reviewed aliases plus explicit baseUnit on both configured row planes', async () => {
  for (const rowSource of ['adapter_records', 'raw_containers']) {
    const { outcome, calls } = await run('configured', valid, { rowSource })
    assert.equal(calls.length, 1)
    assert.equal(outcome.evidence.ok, true)
    assert.deepEqual(outcome.data.containers.primary.records, [{
      FItemID: 1001, FNumber: 'MAT-1', FName: 'Material 1', FModel: 'SPEC', baseUnit: 'PCS',
    }])
  }
})

test('known B4 refuses a successful-envelope list with no Data.DATA array before either consumer reports success', async () => {
  for (const consumer of consumers) {
    const { outcome, calls } = await run(consumer.kind, { StatusCode: 200, Data: { DATA: null, PAGEINDEX: 1, PAGESIZE: 10 } }, consumer)
    assert.equal(calls.length, 1)
    assert.equal((outcome.evidence || outcome).ok, false)
    assert.equal((outcome.evidence || outcome).errorCode, 'READ_SOURCE_PROBE_SHAPE_MISMATCH')
  }
})

test('known B4 refuses missing, scalar, mixed and over-cap raw rows on both real consumer legs', async () => {
  const cases = [
    [{ StatusCode: 200, Data: { PAGEINDEX: 1, PAGESIZE: 10 } }, 'READ_SOURCE_PROBE_CONTAINER_NOT_FOUND'],
    [{ StatusCode: 200, Data: { DATA: null, PAGEINDEX: 1, PAGESIZE: 10 } }, 'READ_SOURCE_PROBE_SHAPE_MISMATCH'],
    [{ StatusCode: 200, Data: { DATA: {}, PAGEINDEX: 1, PAGESIZE: 10 } }, 'READ_SOURCE_PROBE_SHAPE_MISMATCH'],
    [{ StatusCode: 200, Data: { DATA: [row, false], PAGEINDEX: 1, PAGESIZE: 10 } }, 'READ_SOURCE_PROBE_SHAPE_MISMATCH'],
    [{ StatusCode: 200, Data: { DATA: [...Array.from({ length: 10 }, (_, i) => ({ ...row, FItemID: i + 1 })), false], PAGEINDEX: 1, PAGESIZE: 10 } }, 'READ_SOURCE_PROBE_SHAPE_MISMATCH'],
    [{ StatusCode: 200, Data: { DATA: Array.from({ length: 11 }, (_, i) => ({ ...row, FItemID: i + 1 })), PAGEINDEX: 1, PAGESIZE: 10 } }, 'READ_SOURCE_PROBE_CAP_REACHED'],
    [{ StatusCode: 200, Data: { Data: [row], PAGEINDEX: 1, PAGESIZE: 10 } }, 'READ_SOURCE_PROBE_CONTAINER_NOT_FOUND'],
  ]
  for (const consumer of consumers) {
    for (const [body, expected] of cases) {
      const { outcome, calls } = await run(consumer.kind, body, consumer)
      const evidence = outcome.evidence || outcome
      assert.equal(calls.length, 1)
      assert.equal(evidence.ok, false)
      assert.equal(evidence.errorCode, expected)
      assert.equal(JSON.stringify(evidence).includes('MUST-NOT-LEAK'), false)
    }
  }
})

test('known B4 negative explicit status wins over Code:Y and stored successPath', async () => {
  for (const consumer of consumers) {
    const { outcome } = await run(consumer.kind, {
      StatusCode: 400,
      Data: { Code: 'Y', DATA: [row], PAGEINDEX: 1, PAGESIZE: 10 },
    }, consumer)
    assert.equal((outcome.evidence || outcome).errorCode, 'READ_SOURCE_PROBE_RESPONSE_UNRECOGNIZED')
  }
  for (const body of [
    { StatusCode: 400, Data: { Code: 'Y', DATA: [row], PAGEINDEX: 1, PAGESIZE: 10 } },
    { statusCode: '500', Data: { Code: 'Y', DATA: [row], PAGEINDEX: 1, PAGESIZE: 10 } },
    { StatusCode: 'NaN', Data: { Code: 'Y', DATA: [row], PAGEINDEX: 1, PAGESIZE: 10 } },
  ]) {
    for (const consumer of consumers) {
      const { outcome, calls } = await run(consumer.kind, body, { ...consumer, systemConfig: { successPath: 'Data.Code' } })
      assert.equal(calls.length, 1)
      assert.equal((outcome.evidence || outcome).errorCode, 'READ_SOURCE_PROBE_RESPONSE_UNRECOGNIZED')
    }
  }
  const noStatus = await run('configured', { Data: { Code: 'Y', DATA: [row], PAGEINDEX: 1, PAGESIZE: 10 } })
  assert.equal(noStatus.outcome.evidence.ok, true, 'missing status preserves existing business-success contract')
})

test('known B4 rejects malformed and conflicting optional pagination aliases', async () => {
  const cases = [
    { PAGEINDEX: 'not-an-integer' },
    { PAGEINDEX: 0 },
    { PAGEINDEX: 2 },
    { PAGEINDEX: 1, PageIndex: 2 },
    { PAGESIZE: 0 },
    { PAGESIZE: 11 },
    { PAGESIZE: 1, PageSize: 2 },
    { PAGESIZE: 1, DATA: [row, { ...row, FItemID: 2 }] },
    { ROWCOUNT: -1 },
    { ROWCOUNT: 0 },
    { ROWCOUNT: 1, RowCount: 2 },
  ]
  for (const consumer of consumers) {
    for (const override of cases) {
      const body = { StatusCode: 200, Data: { DATA: [row], PAGEINDEX: 1, PAGESIZE: 10, ROWCOUNT: 1, ...override } }
      const { outcome } = await run(consumer.kind, body, consumer)
      const evidence = outcome.evidence || outcome
      assert.equal(evidence.ok, false)
      assert.equal(evidence.errorCode, 'READ_SOURCE_PROBE_RESPONSE_UNRECOGNIZED')
    }
  }
})

test('legal empty and partial B4 pages pass the response guard; page-size metadata is the effective limit', async () => {
  const empty = await run('configured', { StatusCode: 200, Data: { DATA: [], PAGEINDEX: 1, PAGESIZE: 5, ROWCOUNT: 0 } })
  assert.equal(empty.outcome.evidence.ok, true)
  assert.deepEqual(empty.outcome.data.containers.primary.records, [])
  assert.equal(empty.outcome.page.effectiveLimit, 5)
  const partial = await run('configured', { StatusCode: 200, Data: { DATA: [row], PAGEINDEX: 1, PAGESIZE: 5 } })
  assert.equal(partial.outcome.evidence.ok, true)
  assert.equal(partial.outcome.page.effectiveLimit, 5)
  const noEcho = await run('probe', { StatusCode: 200, Data: { DATA: [] } })
  assert.equal(noEcho.outcome.ok, true, 'single-page probe success does not assert completeness')
})

test('B4 raw/adapter-record parity guard rejects divergent fixed fields without promoting canary values', () => {
  const request = { limit: 10, options: { listPageIndex: 1 } }
  const raw = { StatusCode: 200, Data: { DATA: [row], PAGEINDEX: 1, PAGESIZE: 10 } }
  assert.equal(b4MaterialListResponseViolation({ raw, records: [{ ...row }] }, request), null)
  assert.equal(b4MaterialListResponseViolation({ raw, records: [] }, request), 'READ_SOURCE_PROBE_SHAPE_MISMATCH')
  assert.equal(b4MaterialListResponseViolation({ raw, records: [{ ...row, FNumber: 'OTHER' }] }, request), 'READ_SOURCE_PROBE_SHAPE_MISMATCH')
  assert.equal(b4MaterialListResponseViolation({ raw, records: [{ ...row, PasswordCanary: 'different' }] }, request), null,
    'unreviewed values are not a basis for the B4 payload')
})

test('unreviewed and absent profile identities keep the pre-existing target-only projection', async () => {
  for (const profile of [null, 'unreviewed.profile.v1']) {
    for (const rowSource of ['adapter_records', 'raw_containers']) {
      const { outcome } = await run('configured', valid, { profile, rowSource })
      assert.equal(outcome.evidence.ok, true)
      assert.deepEqual(outcome.data.containers.primary.records, [{ baseUnit: 'PCS' }])
    }
  }
})

test('B4 projection retains existing FUnitID missing/null/non-scalar per-row behavior without inventing a field rule', async () => {
  const rows = [row, { ...row, FItemID: 1002 }, { ...row, FItemID: 1003, FUnitID: null }, { ...row, FItemID: 1004, FUnitID: { label: 'PCS' } }]
  delete rows[1].FUnitID
  const body = { StatusCode: 200, Data: { DATA: rows, PAGEINDEX: 1, PAGESIZE: 10, ROWCOUNT: 4 } }
  for (const rowSource of ['adapter_records', 'raw_containers']) {
    const { outcome } = await run('configured', body, { rowSource })
    assert.equal(outcome.evidence.ok, true)
    assert.deepEqual(outcome.data.containers.primary.records.map((mapped) => mapped.baseUnit), [
      'PCS', null, null, { label: 'PCS' },
    ])
    assert.ok(outcome.data.containers.primary.records.every((mapped) => !Object.prototype.hasOwnProperty.call(mapped, 'FUnitID')))
  }
})
