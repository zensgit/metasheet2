'use strict'

// Genuine plugin activation and factories; only host capabilities/storage IO
// are synthetic. Native SQL/authority execution is covered by the core suite.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const Module = require('node:module')
const profile = require('../lib/stock-preparation-automation-profile.cjs')
const { deriveAutomationReadTargetContract } = require('../lib/stock-preparation-automation-target-contract.cjs')
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE: template } = require('../lib/stock-preparation-templates.cjs')
const { FEATURE_FLAG } = require('../lib/sealed-export/stock-preparation-runtime-config.cjs')

function loadEntry() {
  const entryPath = require.resolve('../index.cjs')
  const captures = {}
  const factories = {
    './lib/external-systems.cjs': ['createExternalSystemRegistry'],
    './lib/contracts.cjs': ['createAdapterRegistry'],
    './lib/stock-preparation-read-plan-store.cjs': ['createStockPreparationReadPlanStore'],
    './lib/b2a-trial-registry.cjs': ['createB2aRegistry', 'createB2aOperationClaim'],
    './lib/stock-preparation-automation-preview.cjs': ['createStockPreparationAutomationPreview'],
  }
  const original = Module._load
  delete require.cache[entryPath]
  Module._load = function (request, parent, main) {
    const exported = original.call(this, request, parent, main)
    if (parent?.filename !== entryPath || !factories[request]) return exported
    const wrapped = { ...exported }
    for (const name of factories[request]) wrapped[name] = (...args) => {
      const result = exported[name](...args)
      captures[name] = { args, result }
      return result
    }
    return wrapped
  }
  try { return { entry: require('../index.cjs'), captures } } finally { Module._load = original }
}

function fixture({ configured = true } = {}) {
  const { entry, captures } = loadEntry()
  const events = [], routes = new Map(), namespaces = new Map(), values = new Map()
  let supplied, stopCalls = 0
  const context = {
    config: {
      stockPreparationTableActions: [{ actionId: 'plm.stock-preparation.pull-bom.v1',
        source: { externalSystemId: 'synthetic-system', kind: 'data-source:sql-readonly' },
        target: { sheetId: 'synthetic-sheet', objectId: template.objectId,
          fieldIdMap: Object.fromEntries(template.fields.map(field => [field.id, `physical-${field.id}`])) } }],
      b2aTrialRegistry: { registryId: 'synthetic-registry', registryVersion: 1, registrations: [] },
      ...(configured ? { stockPreparationAutomationProfiles: [{ tenantId: 'synthetic-tenant', workspaceId: null,
        projectId: 'synthetic-project', actionId: 'plm.stock-preparation.pull-bom.v1' }] } : {}),
    },
    api: {
      http: { addRoute(method, path, handler) { events.push('route'); routes.set(`${method} ${path}`, handler) } },
      database: { async query() { throw new Error('Activation must not query host DB') } },
      dataSources: {},
    },
    storage: { async get(key) { return values.get(key) }, async set(key, value) { values.set(key, value) } },
    communication: { register(name, api) { events.push('communication'); namespaces.set(name, api) } },
    logger: { info() { events.push('log') }, warn() { events.push('warn') }, error() { events.push('error') } },
    services: {
      security: { async encrypt() { throw new Error('No credentials') }, async decrypt() { throw new Error('No credentials') },
        async hash() { throw new Error('No credentials') } },
      automationReadRuntime: { async activate(input) {
        events.push('automation-activate'); supplied = input
        // The production HOST captures configuration; the plugin sends only the
        // real preparer, never tenant material or already-prepared profiles.
        input.prepareProfiles({ config: context.config })
        return { async stop() { stopCalls++; events.push('automation-stop') } }
      } },
    },
  }
  return { entry, captures, context, events, routes, namespaces,
    get supplied() { return supplied }, get stopCalls() { return stopCalls } }
}

async function scoped(run) {
  const previous = process.env[FEATURE_FLAG]
  process.env[FEATURE_FLAG] = 'false'
  const instances = []
  try { await run(options => { const item = fixture(options); instances.push(item); return item }) }
  finally {
    for (const item of instances) await item.entry.deactivate()
    if (previous === undefined) delete process.env[FEATURE_FLAG]
    else process.env[FEATURE_FLAG] = previous
  }
}

test('configured actual plugin supplies its real private dependencies as the final activation step', () => scoped(async make => {
  const f = make()
  await f.entry.activate(f.context)
  assert.deepEqual(Object.keys(f.supplied).sort(), ['codec', 'prepareProfiles', 'preview', 'sourceStore'])
  assert.equal(f.supplied.prepareProfiles, profile.prepareStockPreparationAutomationProfiles)
  assert.deepEqual(f.supplied.codec, {
    restoreStockPreparationAutomationProfileMaterial: profile.restoreStockPreparationAutomationProfileMaterial,
    deriveAutomationReadTargetContract,
    composeStockPreparationAutomationExecution: profile.composeStockPreparationAutomationExecution,
  })
  const preview = f.captures.createStockPreparationAutomationPreview
  assert.equal(f.supplied.preview, preview.result)
  assert.equal(preview.args[0].externalSystems, f.captures.createExternalSystemRegistry.result)
  assert.equal(preview.args[0].adapterRegistry, f.captures.createAdapterRegistry.result)
  assert.equal(preview.args[0].b2aTrialRegistry, f.captures.createB2aRegistry.result)
  assert.equal(preview.args[0].b2aOperationClaim, f.captures.createB2aOperationClaim.result)
  assert.equal(preview.args[0].b2aClaimStore, f.context.storage)
  assert.deepEqual(Object.keys(f.supplied.sourceStore), ['lockActiveForAutomation'])
  const queries = []
  await assert.rejects(() => f.supplied.sourceStore.lockActiveForAutomation({ async query(sql) {
    queries.push(sql); return { rows: [] }
  } }, { tenantId: 'synthetic-tenant', workspaceId: null, actor: 'synthetic-owner',
    actionId: 'plm.stock-preparation.pull-bom.v1', systemId: 'synthetic-system' }),
  { code: 'READ_PLAN_TRANSACTION_UNAVAILABLE' })
  assert.equal(queries.length, 1)
  assert.match(queries[0], /pg_current_xact_id\(\)/)
  await assert.rejects(() => f.supplied.preview({}), { code: 'AUTOMATION_PREVIEW_INPUT_INVALID' })
  assert.equal(f.events.at(-1), 'automation-activate')
  assert.ok(f.events.indexOf('communication') < f.events.indexOf('automation-activate'))
  assert.ok(!Object.keys(f.namespaces.get('integration-core')).some(key => /automation|producer|preview/i.test(key)))
}))

test('absent deployment segment never reads or invokes the host capability', () => scoped(async make => {
  const f = make({ configured: false })
  Object.defineProperty(f.context.services, 'automationReadRuntime', { get() { throw new Error('Dormant capability accessed') } })
  await f.entry.activate(f.context)
  assert.equal(f.supplied, undefined)
  assert.equal(f.captures.createStockPreparationAutomationPreview, undefined)
  assert.ok(f.namespaces.has('integration-core'))
  await f.entry.deactivate()
  assert.equal(f.stopCalls, 0)
}))

test('configured missing host capability fails closed without constructing a preview', () => scoped(async make => {
  const f = make()
  delete f.context.services.automationReadRuntime
  await assert.rejects(() => f.entry.activate(f.context), { message: 'AUTOMATION_READ_RUNTIME_UNAVAILABLE' })
  assert.equal(f.captures.createStockPreparationAutomationPreview, undefined)
}))

test('actual preparer rejects malformed deployment descriptors through the host activation', () => scoped(async make => {
  const f = make()
  f.context.config.stockPreparationAutomationProfiles[0].workspaceId = 'synthetic-workspace'
  await assert.rejects(() => f.entry.activate(f.context), { code: 'AUTOMATION_PROFILE_INVALID' })
  assert.equal(f.stopCalls, 0)
}))

test('deactivation invokes stop synchronously before awaiting its drain and only once', () => scoped(async make => {
  const f = make()
  let drain
  const pending = new Promise(resolve => { drain = resolve })
  let calls = 0, stopped = false
  f.context.services.automationReadRuntime.activate = async () => ({ stop() {
    calls++; stopped = true; f.events.push('automation-stop'); return pending
  } })
  await f.entry.activate(f.context)
  const deactivating = f.entry.deactivate()
  assert.equal(stopped, true)
  assert.equal(f.events.at(-1), 'automation-stop', 'cleanup must wait for the host stop drain')
  drain()
  await deactivating
  await f.entry.deactivate()
  assert.equal(calls, 1)
}))

test('stop failure is values-free and does not prevent remaining plugin cleanup', () => scoped(async make => {
  const f = make()
  f.context.services.automationReadRuntime.activate = async () => ({ async stop() { throw new Error('synthetic-private-stop-detail') } })
  const warnings = []
  f.context.logger.warn = message => warnings.push(message)
  await f.entry.activate(f.context)
  await f.entry.deactivate()
  assert.deepEqual(warnings, ['[plugin-integration-core] automation read runtime stop failed'])
  await f.entry.deactivate()
  assert.equal(warnings.length, 1)
}))
