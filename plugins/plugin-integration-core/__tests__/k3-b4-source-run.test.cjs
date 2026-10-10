'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')

const { buildK3WiseMaterialListB4Config } = require('../lib/read-source-k3-material-list-b4-contract.cjs')
const { validateReadSourceConfig } = require('../lib/read-source-config.cjs')
const { prepareConfiguredRead } = require('../lib/read-source-read-runtime.cjs')
const { createK3WiseWebApiAdapter } = require('../lib/adapters/k3-wise-webapi-adapter.cjs')
const {
  publicReadonlySourceRunResult,
  runErpMaterialReadonlySource,
} = require('../lib/stock-preparation-readonly-source-run.cjs')

const SYNTHETIC_SYSTEM_ID = 'synthetic-b4-source'
const SYNTHETIC_URL = 'https://synthetic-k3.invalid'
const SYNTHETIC_SESSION = 'synthetic-session-never-published'
const RAW_ROW = Object.freeze({
  FItemID: 'synthetic-item-101',
  FNumber: 'SYN-MAT-101',
  FName: 'Synthetic material 101',
  FModel: 'Synthetic spec 101',
  FUnitID: 'SYN-UNIT-1',
})

function rowAt(index) {
  return {
    FItemID: `synthetic-item-${index}`,
    FNumber: `SYN-MAT-${index}`,
    FName: `Synthetic material ${index}`,
    FModel: `Synthetic spec ${index}`,
    FUnitID: `SYN-UNIT-${index}`,
  }
}

function listEnvelope(rows, pageIndex, options = {}) {
  const data = {
    PAGEINDEX: pageIndex,
    PAGESIZE: options.pageSize ?? 10,
    DATA: rows,
  }
  if (options.rowCount !== undefined) data.ROWCOUNT = options.rowCount
  return { StatusCode: 200, Data: data }
}

function scenario(payloads, systemId = SYNTHETIC_SYSTEM_ID, systemConfig = {}) {
  const validated = validateReadSourceConfig(buildK3WiseMaterialListB4Config({ systemId }))
  assert.equal(validated.valid, true, JSON.stringify(validated.errors))
  const preparedRead = prepareConfiguredRead({ config: validated.normalized })
  const system = {
    id: systemId,
    tenantId: 'synthetic-tenant',
    kind: 'erp:k3-wise-webapi',
    role: 'source',
    credentials: { sessionId: SYNTHETIC_SESSION },
    config: { baseUrl: SYNTHETIC_URL, objects: { material: {} }, ...systemConfig },
  }
  const calls = []
  const fetchImpl = async (url, options) => {
    const page = calls.length
    calls.push({ path: new URL(url).pathname, method: options.method, body: JSON.parse(options.body) })
    assert.ok(page < payloads.length, `unexpected synthetic fetch for page ${page + 1}`)
    return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify(payloads[page]) },
    }
  }
  return {
    calls,
    run: () => runErpMaterialReadonlySource({
      permission: 'admin',
      syncRunId: 'synthetic-b4-source-run',
      preparedRead,
      system,
      createAdapter: (overlaidSystem) => createK3WiseWebApiAdapter({ system: overlaidSystem, fetchImpl }),
    }),
  }
}

function assertFixedFetches(calls, count) {
  assert.equal(calls.length, count)
  for (const [index, call] of calls.entries()) {
    assert.equal(call.path, '/K3API/Material/GetList')
    assert.equal(call.method, 'POST')
    assert.equal(call.body.Data.Top, 10)
    assert.equal(call.body.Data.PageSize, 10)
    assert.equal(call.body.Data.PageIndex, index + 1)
    assert.equal(call.body.Data.Fields, 'FItemID,FNumber,FName,FModel,FUnitID')
  }
}

async function expectSourceFailure(runtime, code, errorCode) {
  await assert.rejects(runtime.run(), (error) => {
    assert.equal(error.code, code)
    if (errorCode) assert.equal(error.details?.errorCode, errorCode)
    return true
  })
}

test('B4 real configured read feeds the ERP material intake and values-free public projection', async () => {
  const configResult = validateReadSourceConfig(buildK3WiseMaterialListB4Config({ systemId: SYNTHETIC_SYSTEM_ID }))
  assert.equal(configResult.valid, true, JSON.stringify(configResult.errors))
  const preparedRead = prepareConfiguredRead({ config: configResult.normalized })
  const system = {
    id: SYNTHETIC_SYSTEM_ID,
    tenantId: 'synthetic-tenant',
    kind: 'erp:k3-wise-webapi',
    role: 'source',
    credentials: { sessionId: SYNTHETIC_SESSION },
    config: { baseUrl: SYNTHETIC_URL, objects: { material: {} } },
  }
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body) })
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          StatusCode: 200,
          Data: {
            PAGEINDEX: 1,
            PAGESIZE: 10,
            ROWCOUNT: 1,
            DATA: [RAW_ROW],
          },
        })
      },
    }
  }

  let outcome
  let runError
  try {
    outcome = await runErpMaterialReadonlySource({
      permission: 'admin',
      syncRunId: 'synthetic-b4-source-run',
      preparedRead,
      system,
      createAdapter: (overlaidSystem) => createK3WiseWebApiAdapter({ system: overlaidSystem, fetchImpl }),
    })
  } catch (error) {
    runError = error
  }

  assert.equal(calls.length, 1)
  assert.equal(new URL(calls[0].url).pathname, '/K3API/Material/GetList')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].body.Data.PageIndex, 1)
  assert.equal(calls[0].body.Data.PageSize, 10)
  if (runError) throw runError
  assert.equal(outcome.status, 'ready')
  assert.equal(outcome.evidence.sourceRows, 1)
  assert.equal(outcome.intake.erpMaterials.length, 1)
  assert.equal(outcome.intake.erpMaterials[0].erpMaterialCode, RAW_ROW.FNumber)
  assert.equal(outcome.intake.erpMaterials[0].erpMaterialInternalId, RAW_ROW.FItemID)
  assert.equal(outcome.intake.erpMaterials[0].erpMaterialName, RAW_ROW.FName)
  assert.equal(outcome.intake.erpMaterials[0].erpSpec, RAW_ROW.FModel)
  assert.equal(outcome.intake.erpMaterials[0].baseUnit, RAW_ROW.FUnitID)

  const publicOutcome = publicReadonlySourceRunResult(outcome)
  assert.deepEqual(Object.keys(publicOutcome).sort(), ['evidence', 'mode', 'sourceRun', 'status'])
  const serialized = JSON.stringify(publicOutcome)
  for (const privateValue of [
    ...Object.values(RAW_ROW),
    SYNTHETIC_URL,
    SYNTHETIC_SESSION,
    SYNTHETIC_SYSTEM_ID,
  ]) {
    assert.equal(serialized.includes(privateValue), false, `public evidence must omit ${privateValue}`)
  }
  assert.equal(publicOutcome.evidence.valuesFree, true)
  assert.equal(publicOutcome.evidence.externalWriteExecuted, false)
})

test('B4 real source run follows declared 10+1 pages and preserves five reviewed fields', async () => {
  const first = Array.from({ length: 10 }, (_, index) => rowAt(index + 1))
  const last = [rowAt(11)]
  const runtime = scenario([
    listEnvelope(first, 1, { rowCount: 11 }),
    listEnvelope(last, 2, { rowCount: 11 }),
  ])
  const outcome = await runtime.run()
  assertFixedFetches(runtime.calls, 2)
  assert.equal(outcome.status, 'ready')
  assert.equal(outcome.evidence.pages, 2)
  assert.equal(outcome.evidence.sourceRows, 11)
  assert.equal(outcome.evidence.completenessProof, 'declared_total')
  assert.equal(outcome.intake.erpMaterials.length, 11)
  assert.equal(outcome.intake.erpMaterials[10].erpMaterialCode, last[0].FNumber)
  assert.equal(outcome.intake.erpMaterials[10].erpMaterialInternalId, last[0].FItemID)
  assert.equal(outcome.intake.erpMaterials[10].erpMaterialName, last[0].FName)
  assert.equal(outcome.intake.erpMaterials[10].erpSpec, last[0].FModel)
  assert.equal(outcome.intake.erpMaterials[10].baseUnit, last[0].FUnitID)
  assert.equal(JSON.stringify(publicReadonlySourceRunResult(outcome)).includes(last[0].FNumber), false)
})

test('B4 real source run treats an empty terminal page as completion, not an adapter done hint', async () => {
  const rows = Array.from({ length: 10 }, (_, index) => rowAt(index + 1))
  const runtime = scenario([listEnvelope(rows, 1), listEnvelope([], 2)])
  const outcome = await runtime.run()
  assertFixedFetches(runtime.calls, 2)
  assert.equal(outcome.status, 'ready')
  assert.equal(outcome.evidence.sourceRows, 10)
  assert.equal(outcome.evidence.completenessProof, 'short_page')
  assert.equal(outcome.intake.erpMaterials.length, 10)
})

test('B4 follows a server-applied page size of 5, despite requesting 10, until a 5+2 short page proves completion', async () => {
  const first = Array.from({ length: 5 }, (_, index) => rowAt(index + 1))
  const last = [rowAt(6), rowAt(7)]
  const runtime = scenario([
    listEnvelope(first, 1, { pageSize: 5 }),
    listEnvelope(last, 2, { pageSize: 5 }),
  ])
  const outcome = await runtime.run()
  assertFixedFetches(runtime.calls, 2)
  assert.equal(outcome.status, 'ready')
  assert.equal(outcome.evidence.sourceRows, 7)
  assert.equal(outcome.evidence.sourcePageSizeRequested, 10)
  assert.equal(outcome.evidence.sourcePageSizeEffective, 5)
  assert.equal(outcome.evidence.completenessProof, 'short_page')
  assert.equal(outcome.intake.erpMaterials[6].erpMaterialCode, last[1].FNumber)
})

test('B4 refuses a changed applied page size across page-index reads in either direction', async () => {
  const fiveThenTen = scenario([
    listEnvelope(Array.from({ length: 5 }, (_, index) => rowAt(index + 1)), 1, { pageSize: 5 }),
    listEnvelope([rowAt(6), rowAt(7)], 2, { pageSize: 10 }),
  ])
  await expectSourceFailure(fiveThenTen, 'SOURCE_RUN_PAGINATION_INCONSISTENT')
  assertFixedFetches(fiveThenTen.calls, 2)

  const tenThenFive = scenario([
    listEnvelope(Array.from({ length: 10 }, (_, index) => rowAt(index + 1)), 1, { pageSize: 10 }),
    listEnvelope([rowAt(11), rowAt(12)], 2, { pageSize: 5 }),
  ])
  await expectSourceFailure(tenThenFive, 'SOURCE_RUN_PAGINATION_INCONSISTENT')
  assertFixedFetches(tenThenFive.calls, 2)
})

test('B4 keeps extra and prototype-shaped raw fields out of real intake and public evidence', async () => {
  const rawRow = { ...RAW_ROW, FSecret: 'SYNTHETIC-EXTRA-SECRET' }
  Object.defineProperty(rawRow, '__proto__', { value: 'SYNTHETIC-PROTO-SECRET', enumerable: true })
  const runtime = scenario([listEnvelope([rawRow], 1, { rowCount: 1 })])
  const outcome = await runtime.run()
  assertFixedFetches(runtime.calls, 1)
  assert.equal(outcome.status, 'ready')
  const intakeRow = outcome.intake.erpMaterials[0]
  assert.equal(intakeRow.erpMaterialCode, RAW_ROW.FNumber)
  assert.equal(intakeRow.erpMaterialInternalId, RAW_ROW.FItemID)
  assert.equal(intakeRow.erpMaterialName, RAW_ROW.FName)
  assert.equal(intakeRow.erpSpec, RAW_ROW.FModel)
  assert.equal(intakeRow.baseUnit, RAW_ROW.FUnitID)
  assert.equal(Object.prototype.hasOwnProperty.call(intakeRow, 'FSecret'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(intakeRow, '__proto__'), false)
  for (const value of ['SYNTHETIC-EXTRA-SECRET', 'SYNTHETIC-PROTO-SECRET']) {
    assert.equal(JSON.stringify(outcome.intake).includes(value), false)
    assert.equal(JSON.stringify(publicReadonlySourceRunResult(outcome)).includes(value), false)
  }
})

test('the same reviewed B4 content is usable with two distinct local system references', async () => {
  const body = listEnvelope([RAW_ROW], 1, { rowCount: 1 })
  const first = scenario([body], 'synthetic-b4-source-a')
  const second = scenario([body], 'synthetic-b4-source-b')
  const a = await first.run()
  const b = await second.run()
  assertFixedFetches(first.calls, 1)
  assertFixedFetches(second.calls, 1)
  assert.deepEqual(first.calls, second.calls)
  assert.equal(a.status, 'ready')
  assert.equal(b.status, 'ready')
  assert.equal(a.intake.erpMaterials[0].erpMaterialCode, b.intake.erpMaterials[0].erpMaterialCode)
  assert.equal(a.intake.erpMaterials[0].baseUnit, b.intake.erpMaterials[0].baseUnit)
})

test('B4 refuses missing, non-array, mixed, or wrong-cased Data.DATA at the real adapter boundary', async () => {
  const badPages = [
    [{ StatusCode: 200, Data: { PAGEINDEX: 1, PAGESIZE: 10, ROWCOUNT: 1 } }, 'READ_SOURCE_PROBE_CONTAINER_NOT_FOUND'],
    [{ StatusCode: 200, Data: { PAGEINDEX: 1, PAGESIZE: 10, ROWCOUNT: 1, DATA: null } }, 'READ_SOURCE_PROBE_SHAPE_MISMATCH'],
    [{ StatusCode: 200, Data: { PAGEINDEX: 1, PAGESIZE: 10, ROWCOUNT: 1, DATA: {} } }, 'READ_SOURCE_PROBE_SHAPE_MISMATCH'],
    [{ StatusCode: 200, Data: { PAGEINDEX: 1, PAGESIZE: 10, ROWCOUNT: 2, DATA: [RAW_ROW, null] } }, 'READ_SOURCE_PROBE_SHAPE_MISMATCH'],
    [{ StatusCode: 200, Data: { PAGEINDEX: 1, PAGESIZE: 10, ROWCOUNT: 1, Data: [RAW_ROW] } }, 'READ_SOURCE_PROBE_CONTAINER_NOT_FOUND'],
  ]
  for (const [payload, errorCode] of badPages) {
    const runtime = scenario([payload])
    await expectSourceFailure(runtime, 'SOURCE_RUN_READ_FAILED', errorCode)
    assertFixedFetches(runtime.calls, 1)
  }

  const fullFirstPage = Array.from({ length: 10 }, (_, index) => rowAt(index + 1))
  const badLaterPages = [
    [{ PAGEINDEX: 2, PAGESIZE: 10 }, 'READ_SOURCE_PROBE_CONTAINER_NOT_FOUND'],
    [{ PAGEINDEX: 2, PAGESIZE: 10, DATA: null }, 'READ_SOURCE_PROBE_SHAPE_MISMATCH'],
    [{ PAGEINDEX: 2, PAGESIZE: 10, DATA: [rowAt(11), null] }, 'READ_SOURCE_PROBE_SHAPE_MISMATCH'],
  ]
  for (const [badData, errorCode] of badLaterPages) {
    const runtime = scenario([listEnvelope(fullFirstPage, 1), { StatusCode: 200, Data: badData }])
    await expectSourceFailure(runtime, 'SOURCE_RUN_READ_FAILED', errorCode)
    assertFixedFetches(runtime.calls, 2)
  }
})

test('B4 refuses oversized raw DATA on both first and later pages before reporting ready', async () => {
  const oversized = Array.from({ length: 11 }, (_, index) => rowAt(index + 1))
  const first = scenario([listEnvelope(oversized, 1)])
  await expectSourceFailure(first, 'SOURCE_RUN_READ_FAILED', 'READ_SOURCE_PROBE_CAP_REACHED')
  assertFixedFetches(first.calls, 1)
  const full = Array.from({ length: 10 }, (_, index) => rowAt(index + 1))
  const later = scenario([listEnvelope(full, 1), listEnvelope(oversized, 2)])
  await expectSourceFailure(later, 'SOURCE_RUN_READ_FAILED', 'READ_SOURCE_PROBE_CAP_REACHED')
  assertFixedFetches(later.calls, 2)
})

test('B4 refuses K3 business failure even if the response also carries success-shaped fields', async () => {
  const data = listEnvelope([RAW_ROW], 1, { rowCount: 1 })
  // Data.Code is the adapter's actual positive success signal; a top-level Code would not exercise it.
  const codeSaysYes = scenario([{ ...data, Data: { ...data.Data, Code: 'Y' }, StatusCode: 500 }])
  await expectSourceFailure(codeSaysYes, 'SOURCE_RUN_READ_FAILED', 'READ_SOURCE_PROBE_RESPONSE_UNRECOGNIZED')
  assertFixedFetches(codeSaysYes.calls, 1)

  const pathSaysYes = scenario(
    [{ ...data, Success: true, StatusCode: 500 }],
    SYNTHETIC_SYSTEM_ID,
    { successPath: 'Success' },
  )
  await expectSourceFailure(pathSaysYes, 'SOURCE_RUN_READ_FAILED', 'READ_SOURCE_PROBE_RESPONSE_UNRECOGNIZED')
  assertFixedFetches(pathSaysYes.calls, 1)
})

test('B4 source-run demands real page-size and page-index echoes', async () => {
  const noSize = scenario([{ StatusCode: 200, Data: { PAGEINDEX: 1, ROWCOUNT: 1, DATA: [RAW_ROW] } }])
  await expectSourceFailure(noSize, 'SOURCE_RUN_COMPLETENESS_UNPROVABLE')
  assertFixedFetches(noSize.calls, 1)
  const noIndex = scenario([{ StatusCode: 200, Data: { PAGESIZE: 10, ROWCOUNT: 1, DATA: [RAW_ROW] } }])
  await expectSourceFailure(noIndex, 'SOURCE_RUN_PAGINATION_UNVERIFIED')
  assertFixedFetches(noIndex.calls, 1)
})

test('B4 refuses repeated pages, contradictory totals, and an unproven ten-page bound', async () => {
  const full = Array.from({ length: 10 }, (_, index) => rowAt(index + 1))
  const replay = scenario([listEnvelope(full, 1), listEnvelope(full, 2)])
  await expectSourceFailure(replay, 'SOURCE_RUN_PAGE_NOT_ADVANCING')
  assertFixedFetches(replay.calls, 2)

  const totalChange = scenario([
    listEnvelope(full, 1, { rowCount: 11 }),
    listEnvelope([rowAt(11)], 2, { rowCount: 12 }),
  ])
  await expectSourceFailure(totalChange, 'SOURCE_RUN_PAGINATION_INCONSISTENT')
  assertFixedFetches(totalChange.calls, 2)

  const tenFull = scenario(Array.from({ length: 10 }, (_, page) => listEnvelope(
    Array.from({ length: 10 }, (_, index) => rowAt(page * 10 + index + 1)),
    page + 1,
  )))
  await expectSourceFailure(tenFull, 'SOURCE_RUN_RESULT_TOO_LARGE')
  assertFixedFetches(tenFull.calls, 10)
})

test('B4 accepts the three established pagination metadata aliases but rejects invalid or conflicting echoes', async () => {
  for (const names of [
    ['PAGEINDEX', 'PAGESIZE', 'ROWCOUNT'],
    ['pageIndex', 'pageSize', 'rowCount'],
    ['PageIndex', 'PageSize', 'RowCount'],
  ]) {
    const data = { DATA: [RAW_ROW], [names[0]]: 1, [names[1]]: 10, [names[2]]: 1 }
    const runtime = scenario([{ StatusCode: 200, Data: data }])
    const outcome = await runtime.run()
    assertFixedFetches(runtime.calls, 1)
    assert.equal(outcome.status, 'ready')
  }
  for (const data of [
    { PAGEINDEX: 1, PAGESIZE: 10, pageSize: 5, ROWCOUNT: 1, DATA: [RAW_ROW] },
    { PAGEINDEX: 1, PAGESIZE: 'invalid', ROWCOUNT: 1, DATA: [RAW_ROW] },
    { PAGEINDEX: 1, PAGESIZE: 0, ROWCOUNT: 1, DATA: [RAW_ROW] },
  ]) {
    const runtime = scenario([{ StatusCode: 200, Data: data }])
    await expectSourceFailure(runtime, 'SOURCE_RUN_READ_FAILED', 'READ_SOURCE_PROBE_RESPONSE_UNRECOGNIZED')
    assertFixedFetches(runtime.calls, 1)
  }
})

test('Data.Total is not a declared-total alias and an empty first page remains SOURCE_RUN_EMPTY', async () => {
  const full = Array.from({ length: 10 }, (_, index) => rowAt(index + 1))
  const noNewAlias = scenario([
    { StatusCode: 200, Data: { PAGEINDEX: 1, PAGESIZE: 10, Total: 1, DATA: full } },
    { StatusCode: 200, Data: { PAGEINDEX: 2, PAGESIZE: 10, Total: 1, DATA: [] } },
  ])
  const outcome = await noNewAlias.run()
  assertFixedFetches(noNewAlias.calls, 2)
  assert.equal(outcome.status, 'ready')
  assert.equal(outcome.evidence.sourceTotalKnown, false)
  assert.equal(outcome.evidence.sourceRows, 10)

  const empty = scenario([listEnvelope([], 1, { rowCount: 0 })])
  await expectSourceFailure(empty, 'SOURCE_RUN_EMPTY')
  assertFixedFetches(empty.calls, 1)
})
