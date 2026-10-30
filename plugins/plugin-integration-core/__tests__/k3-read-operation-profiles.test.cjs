'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { validateReadSourceConfig } = require('../lib/read-source-config.cjs')
const { prepareConfiguredRead, executeConfiguredRead } = require('../lib/read-source-read-runtime.cjs')
const { prepareReadSourceProbe, executeReadSourceProbe } = require('../lib/read-source-probe-runtime.cjs')
const { buildK3WiseMaterialListB4Config } = require('../lib/read-source-k3-material-list-b4-contract.cjs')
const { createK3WiseWebApiAdapter } = require('../lib/adapters/k3-wise-webapi-adapter.cjs')
const { isB4ReadOperationProfile, b4ReadOperationProfileViolation } = require('../lib/k3-read-operation-profiles.cjs')

const cleanBody = {
  Data: {
    Top: 10,
    PageIndex: 1,
    PageSize: 10,
    Fields: 'FItemID,FNumber,FName,FModel,FUnitID',
    OrderBy: 'FNumber',
  },
}

function approvedConfig(systemId = 'synthetic-a', version = 7) {
  const validated = validateReadSourceConfig({ ...buildK3WiseMaterialListB4Config({ systemId }), version })
  assert.equal(validated.valid, true)
  return validated.normalized
}

function syntheticSystem(systemId, pollution) {
  return {
    id: systemId,
    tenantId: 'synthetic-tenant',
    kind: 'erp:k3-wise-webapi',
    role: 'source',
    credentials: { sessionId: 'synthetic-session' },
    config: {
      baseUrl: 'http://127.0.0.1:1',
      objects: { material: pollution || {} },
    },
  }
}

async function runRealRead(kind, systemId, pollution, inputs, trustedExecution) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ path: new URL(url).pathname, method: options.method, body: JSON.parse(options.body) })
    return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify({ StatusCode: 200, Data: { DATA: [] } }) },
    }
  }
  const system = syntheticSystem(systemId, pollution)
  const createAdapter = (overlaid) => createK3WiseWebApiAdapter({ system: overlaid, fetchImpl })
  const config = approvedConfig(systemId)
  let outcome
  if (kind === 'configured') {
    const prepared = prepareConfiguredRead({ config, inputs })
    outcome = await executeConfiguredRead(prepared, { system, createAdapter }, trustedExecution)
  } else {
    const prepared = prepareReadSourceProbe({ config, boundedSmoke: true, inputs })
    outcome = await executeReadSourceProbe(prepared, { system, createAdapter })
  }
  return { calls, outcome, system }
}

test('B4 configured and probe read ignore polluted stored material body at the real adapter boundary', async () => {
  const pollutions = [
    // Existing Data member values used to win over readListFields/readListOrderBy and survive the merge.
    { readListBodyTemplate: { Data: { Fields: '*', Filter: '1=1', SelectPage: 99 } } },
    // Body-root and pagination key pollution must not create a parallel request envelope.
    {
      readListBodyTemplate: { Other: { Fields: '*', Filter: '1=1', SelectPage: 99 } },
      readListBodyKey: 'Other',
      topField: 'SelectPage',
      pageIndexField: 'WrongIndex',
      pageSizeField: 'WrongSize',
    },
    // Independent field-list/order pollution without a body template also cannot change projection.
    { readListFields: ['FSecret'], readListOrderBy: 'FSecret' },
    { operations: ['upsert'], readPath: '/K3API/Material/GetDetail', readMethod: 'GET' },
  ]
  for (const kind of ['configured', 'probe']) {
    const clean = await runRealRead(kind, 'synthetic-a', {}, undefined)
    assert.equal(clean.calls.length, 1)
    assert.deepEqual(clean.calls[0], { path: '/K3API/Material/GetList', method: 'POST', body: cleanBody })
    assert.equal((clean.outcome.evidence || clean.outcome).ok, true)
    for (const pollution of pollutions) {
      const dirty = await runRealRead(kind, 'synthetic-a', pollution, undefined)
      assert.equal(dirty.calls.length, 1)
      assert.deepEqual(dirty.calls[0], clean.calls[0])
      assert.equal((dirty.outcome.evidence || dirty.outcome).ok, true)
      assert.deepEqual(dirty.system.config.objects.material, pollution)
    }
  }
})

test('B4 profile identity survives both prepare paths and a store-minted version above one', () => {
  const config = approvedConfig('synthetic-b', 23)
  const configured = prepareConfiguredRead({ config })
  const probe = prepareReadSourceProbe({ config, boundedSmoke: true })
  assert.equal(configured.plan.actionProfileVersion, 'k3wise.material_list.v1')
  assert.equal(probe.plan.actionProfileVersion, 'k3wise.material_list.v1')
  assert.equal(b4ReadOperationProfileViolation(config), null)
  assert.equal(isB4ReadOperationProfile(config.actionProfileVersion), true)
  assert.equal(isB4ReadOperationProfile('unreviewed.profile.v1'), false)
})

test('B4 prepare snapshots a mutable DB-restored fieldMap before later drift', async () => {
  const restored = JSON.parse(JSON.stringify(approvedConfig()))
  const prepared = prepareConfiguredRead({ config: restored })
  restored.fieldMap[0].source = 'UnreviewedSource'
  restored.fieldMap[0].target = 'unreviewedTarget'
  assert.equal(validateReadSourceConfig(restored).valid, false)
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ path: new URL(url).pathname, body: JSON.parse(options.body) })
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ StatusCode: 200, Data: { DATA: [{ FUnitID: 'UNIT-1' }] } })
      },
    }
  }
  const outcome = await executeConfiguredRead(prepared, {
    system: syntheticSystem('synthetic-a'),
    createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl }),
  })
  assert.equal(outcome.evidence.ok, true)
  assert.deepEqual(outcome.data.containers.primary.records, [{ baseUnit: 'UNIT-1' }])
  assert.deepEqual(calls[0].body, cleanBody)
  assert.equal(calls.length, 1)
})

test('two local system references produce identical B4 wire request and never mutate either source', async () => {
  const a = await runRealRead('configured', 'synthetic-a', { readListFields: ['Wrong'] })
  const b = await runRealRead('configured', 'synthetic-b', { readListFields: ['Wrong'] })
  assert.deepEqual(a.calls, b.calls)
  assert.deepEqual(a.calls[0].body, cleanBody)
  assert.deepEqual(a.system.config.objects.material, { readListFields: ['Wrong'] })
  assert.deepEqual(b.system.config.objects.material, { readListFields: ['Wrong'] })
})

test('B4 drifted config is rejected with a fixed value-free code before adapter creation', () => {
  for (const changed of [
    { readPath: '/K3API/Material/GetDetail' },
    { readMethod: 'GET' },
    { fieldMap: [{ source: 'FUnitID', target: 'otherUnit' }] },
    { containerPaths: ['Data.Other'] },
    { orderingKeySpec: [{ fieldId: 'baseUnit', direction: 'ASC' }] },
  ]) {
    const candidate = { ...buildK3WiseMaterialListB4Config({ systemId: 'synthetic-a' }), version: 8, ...changed }
    const result = validateReadSourceConfig(candidate)
    assert.equal(result.valid, false)
    assert.deepEqual(result.errors, [{
      code: 'READ_SOURCE_ACTION_PROFILE_CONFIG_DRIFT',
      field: 'actionProfileVersion',
      reason: 'profile_config_drift',
    }])
    assert.throws(
      () => prepareConfiguredRead({ config: candidate }),
      (error) => error.code === 'READ_SOURCE_PROBE_CONTRACT_INVALID' && error.reason === 'config_invalid',
    )
    assert.throws(
      () => prepareReadSourceProbe({ config: candidate, boundedSmoke: true }),
      (error) => error.code === 'READ_SOURCE_PROBE_CONTRACT_INVALID' && error.reason === 'config_invalid',
    )
  }
})

test('B4 page 1..10 and reduced trusted rowCap change only bounded pagination', async () => {
  const page = await runRealRead('configured', 'synthetic-a', {}, { pageIndex: 10 }, { rowCap: 4, pageIndex: 10 })
  assert.equal(page.calls.length, 1)
  assert.deepEqual(page.calls[0].body, {
    Data: { ...cleanBody.Data, Top: 4, PageIndex: 10, PageSize: 4 },
  })
  const probePage = await runRealRead('probe', 'synthetic-a', {}, { pageIndex: 10 })
  assert.equal(probePage.calls.length, 1)
  assert.deepEqual(probePage.calls[0].body, {
    Data: { ...cleanBody.Data, PageIndex: 10 },
  })
})

test('B4 oversized rowCap, page, cursor, raw key/filter/body and extra runtime keys refuse before adapter/fetch', async () => {
  const config = approvedConfig()
  const system = syntheticSystem('synthetic-a')
  let created = 0
  const deps = { system, createAdapter() { created++; throw new Error('adapter must not be created') } }
  const prepared = prepareConfiguredRead({ config })
  for (const trusted of [
    { rowCap: 11 }, { rowCap: 1000 }, { pageIndex: 11 }, { pageIndex: 0 },
    { cursor: 'raw-cursor' }, { filter: 'FNumber=*' }, { body: { Data: {} } },
  ]) {
    await assert.rejects(
      executeConfiguredRead(prepared, deps, trusted),
      (error) => error.code === 'READ_SOURCE_PROBE_CONTRACT_INVALID',
    )
  }
  for (const inputs of [
    { pageIndex: 11 }, { pageIndex: 0 }, { key: 'arbitrary' },
    { filter: 'FNumber=*' }, { body: { Data: {} } },
  ]) {
    assert.throws(() => prepareConfiguredRead({ config, inputs }), /inputs_|page_index_|key_not_allowed/)
    assert.throws(() => prepareReadSourceProbe({ config, boundedSmoke: true, inputs }), /inputs_|page_index_|key_not_allowed/)
  }
  assert.throws(() => prepareConfiguredRead({ config, inputs: {}, body: { Data: {} } }), /unexpected_field/)
  assert.equal(created, 0)
})

test('unknown profile identity retains generic behavior and is not represented as B4-reviewed', () => {
  const candidate = { ...buildK3WiseMaterialListB4Config({ systemId: 'synthetic-a' }), actionProfileVersion: 'unreviewed.profile.v1' }
  const result = validateReadSourceConfig(candidate)
  assert.equal(result.valid, true)
  const configured = prepareConfiguredRead({ config: result.normalized })
  const probe = prepareReadSourceProbe({ config: result.normalized })
  assert.equal(configured.plan.actionProfileVersion, undefined)
  assert.equal(probe.plan.actionProfileVersion, undefined)
})
