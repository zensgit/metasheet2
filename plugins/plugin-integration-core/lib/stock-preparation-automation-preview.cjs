'use strict'

const { previewStockPreparationForAutomation } = require('./stock-preparation-table-actions.cjs')
const { deriveAutomationReadTargetContract } = require('./stock-preparation-automation-target-contract.cjs')
const { __internals: { rowToPublicExternalSystem } } = require('./external-systems.cjs')
const {
  B2A_PURPOSE_STOCK_PREPARATION_AUTOMATION_PREVIEW,
  assertB2aReadAuthorization, readPlanSourceObjects, resolveB2aSourceObjects,
} = require('./b2a-trial-registry.cjs')

const SOURCE_KIND = 'data-source:sql-readonly'
const COUNTS = ['add', 'update', 'skip', 'inactive', 'manual_confirm']
const STATUSES = new Set(['ready', 'manual_confirm_required', 'not_found'])
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u

class StockPreparationAutomationPreviewError extends Error {
  constructor(code) { super(code); this.name = 'StockPreparationAutomationPreviewError'; this.code = code }
}
function fail(code = 'AUTOMATION_PREVIEW_DENIED') { throw new StockPreparationAutomationPreviewError(code) }
function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}
function data(value, keys) {
  if (!plain(value) || Reflect.ownKeys(value).length !== keys.length) fail('AUTOMATION_PREVIEW_INPUT_INVALID')
  return Object.fromEntries(keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('AUTOMATION_PREVIEW_INPUT_INVALID')
    return [key, descriptor.value]
  }))
}
function id(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 && value.trim() === value
    // eslint-disable-next-line no-control-regex -- Reject embedded control characters in host identifiers.
    && !/[\u0000-\u001f\u007f]/u.test(value)
}
function positive(value, ceiling) { return Number.isSafeInteger(value) && value > 0 && value <= ceiling }
function copyJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!value || typeof value !== 'object' || seen.has(value) || seen.size > 64) fail()
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) fail()
      return Object.freeze(Array.from({ length: value.length }, (_, index) => {
        const d = Object.getOwnPropertyDescriptor(value, String(index))
        if (!d?.enumerable || !Object.hasOwn(d, 'value')) fail()
        return copyJson(d.value, seen)
      }))
    }
    if (!plain(value)) fail()
    return Object.freeze(Object.fromEntries(Reflect.ownKeys(value).map(key => {
      const d = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || !d?.enumerable || !Object.hasOwn(d, 'value')) fail()
      return [key, copyJson(d.value, seen)]
    })))
  } finally { seen.delete(value) }
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (plain(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value)
}
function method(object, name) {
  const descriptor = object && Object.getOwnPropertyDescriptor(object, name)
  if (!descriptor || typeof descriptor.value !== 'function') fail('AUTOMATION_PREVIEW_INPUT_INVALID')
  return descriptor.value.bind(object)
}
function checkedSystem(system, scope, connectionId) {
  if (!plain(system) || system.id !== scope.id || system.tenantId !== scope.tenantId
    || system.workspaceId !== null || system.connectionId !== connectionId
    || system.kind !== SOURCE_KIND || system.status !== 'active' || !['source', 'bidirectional'].includes(system.role)
    || !plain(system.config)) fail()
}
function bindingConfig(config, connectionId) {
  if (!plain(config) || (Object.hasOwn(config, 'dataSourceId') && config.dataSourceId !== connectionId)) fail()
  return copyJson({ ...config, dataSourceId: connectionId })
}

/**
 * Host-private composition only. Inputs are captured by the current host's live
 * authority/material port, never a route or Automation action configuration.
 * This module performs no business writes and never receives a token store.
 * Armed B2a claim/schema bookkeeping is separate control-plane state.
 *
 * These wrappers bound logical calls and prevent new calls after a refusal.
 * They do not cancel a driver already running. The trusted host MUST bind the
 * actual source facade/native adapter to its per-query checkpoint/deadline and
 * revalidate the execution lease before publication. No production registration
 * or authority capability is created by this factory.
 */
function createStockPreparationAutomationPreview(options) {
  let getMetadata, getConfig, resolve, createAdapter, registry, claimStore, operationClaim
  try {
    const o = data(options, ['externalSystems', 'adapterRegistry', 'b2aTrialRegistry', 'b2aClaimStore', 'b2aOperationClaim'])
    getMetadata = method(o.externalSystems, 'getExternalSystem')
    getConfig = method(o.externalSystems, 'getExternalSystemAdapterConfig')
    resolve = method(o.externalSystems, 'getExternalSystemForAdapter')
    createAdapter = method(o.adapterRegistry, 'createAdapter')
    if (!plain(o.b2aTrialRegistry)) fail('AUTOMATION_PREVIEW_INPUT_INVALID')
    registry = o.b2aTrialRegistry
    claimStore = Object.freeze({ get: method(o.b2aClaimStore, 'get'), set: method(o.b2aClaimStore, 'set') })
    operationClaim = Object.freeze({ claim: method(o.b2aOperationClaim, 'claim') })
  } catch { fail('AUTOMATION_PREVIEW_INPUT_INVALID') }

  return async function preview(input) {
    let material, action, actor, validation, projectNo, runId, budget, signal, checkpoint, trackPendingWork, queryRecords
    try {
      const i = data(input, ['action', 'installedFieldProperties', 'extFieldMapping', 'recordsApi', 'actor',
        'sourceValidation', 'projectNo', 'runId', 'budget', 'signal', 'checkpoint', 'trackPendingWork'])
      actor = Object.freeze(data(i.actor, ['actorId', 'tenantId', 'workspaceId']))
      validation = Object.freeze(data(i.sourceValidation, ['connectionId', 'connectionRevision', 'bindingRevision']))
      budget = Object.freeze(data(i.budget, ['maxRows', 'maxPages', 'maxReadCount', 'timeoutMs']))
      if (!id(actor.actorId) || !id(actor.tenantId) || actor.workspaceId !== null
        || !id(validation.connectionId) || !UUID.test(validation.connectionRevision) || !UUID.test(validation.bindingRevision)
        || !id(i.projectNo) || i.projectNo.length > 128 || !id(i.runId)
        || !positive(budget.maxRows, 100000) || !positive(budget.maxPages, 1000)
        || !positive(budget.maxReadCount, 10000) || !positive(budget.timeoutMs, 300000)
        || !(i.signal instanceof AbortSignal) || typeof i.checkpoint !== 'function'
        || typeof i.trackPendingWork !== 'function') fail('AUTOMATION_PREVIEW_INPUT_INVALID')
      signal = i.signal; checkpoint = i.checkpoint; trackPendingWork = i.trackPendingWork; projectNo = i.projectNo; runId = i.runId
      queryRecords = method(i.recordsApi, 'queryRecords')
      material = deriveAutomationReadTargetContract({ action: i.action,
        installedFieldProperties: i.installedFieldProperties, extFieldMapping: i.extFieldMapping })
      if (material.action.source.kind !== SOURCE_KIND || !id(material.action.source.externalSystemId)) fail('AUTOMATION_PREVIEW_INPUT_INVALID')
      action = Object.freeze({ ...material.action,
        pageLimit: Math.min(material.action.pageLimit ?? 1000, budget.maxRows, 1000),
        maxRows: Math.min(material.action.maxRows ?? budget.maxRows, budget.maxRows),
        maxPages: Math.min(material.action.maxPages ?? budget.maxPages, budget.maxPages),
        maxReadCount: Math.min(material.action.maxReadCount ?? budget.maxReadCount, budget.maxReadCount),
        maxElapsedMs: Math.min(material.action.maxElapsedMs ?? budget.timeoutMs, budget.timeoutMs),
      })
    } catch { fail('AUTOMATION_PREVIEW_INPUT_INVALID') }

    const deadlineAt = Date.now() + budget.timeoutMs
    let closed = false, failure = null, timer, abortListener
    let pages = 0, reads = 0, rows = 0
    const stop = code => {
      if (!failure) failure = new StockPreparationAutomationPreviewError(code)
      throw failure
    }
    const check = () => {
      if (failure) throw failure
      if (signal.aborted) stop('AUTOMATION_PREVIEW_ABORTED')
      if (closed || Date.now() >= deadlineAt) stop('AUTOMATION_PREVIEW_TIMEOUT')
    }
    const gate = async () => {
      check()
      try { await checkpoint() } catch { stop('AUTOMATION_PREVIEW_DENIED') }
      check()
    }
    const guarded = async work => {
      await gate()
      let value
      try { value = await work() } catch (error) {
        check()
        if (error instanceof StockPreparationAutomationPreviewError) { failure = error; throw error }
        stop('AUTOMATION_PREVIEW_UNAVAILABLE')
      }
      await gate()
      return value
    }
    const startRead = page => {
      check()
      if (++reads > budget.maxReadCount || (page && ++pages > budget.maxPages)) stop('AUTOMATION_PREVIEW_BUDGET_EXCEEDED')
    }
    const countRows = records => {
      if (!Array.isArray(records) || records.some(row => !plain(row))) stop('AUTOMATION_PREVIEW_UNAVAILABLE')
      rows += records.length
      if (rows > budget.maxRows) stop('AUTOMATION_PREVIEW_BUDGET_EXCEEDED')
    }
    const runClaimStore = Object.freeze({
      get: key => guarded(() => claimStore.get(key)),
      set: (key, value) => guarded(() => claimStore.set(key, value)),
    })
    const runOperationClaim = Object.freeze({ claim: request => guarded(() => operationClaim.claim(request)) })
    async function run() {
      const scope = Object.freeze({ tenantId: actor.tenantId, workspaceId: null, id: action.source.externalSystemId })
      const metadata = await guarded(() => getMetadata(scope))
      checkedSystem(metadata, scope, validation.connectionId)
      const metadataConfig = copyJson(metadata.config)
      const full = await guarded(() => getConfig(scope))
      if (!plain(full) || full.id !== scope.id || full.kind !== SOURCE_KIND || full.connectionId !== validation.connectionId) fail()
      // Use the registry's actual public projection, including its redaction and
      // private-subtree omission. The adapter config itself stays complete.
      if (canonical(metadataConfig) !== canonical(rowToPublicExternalSystem({ kind: SOURCE_KIND, config: full.config }).config)) fail()
      const config = bindingConfig(full.config, validation.connectionId)
      const sourceObjects = Object.freeze((await resolveB2aSourceObjects({ sourceObjects: readPlanSourceObjects(action.source.readPlan),
        sourceSystemType: SOURCE_KIND, loadSourceSystemConfig: async () => ({ config }) })).sort())
      const authorization = await guarded(() => assertB2aReadAuthorization({
        registry, store: runClaimStore, operationClaim: runOperationClaim, tenantScope: actor.tenantId,
        sourceSystemType: SOURCE_KIND, sourceBindingRef: scope.id, dataScopeRef: projectNo,
        sourceObjects, purpose: B2A_PURPOSE_STOCK_PREPARATION_AUTOMATION_PREVIEW, runId, now: Date.now(),
      }))
      if (!authorization || authorization.armed !== true) fail()
      const resolved = await guarded(() => resolve({ ...scope, principal: actor.actorId, runAs: 'user' }))
      checkedSystem(resolved, scope, validation.connectionId)
      if (resolved.bindingValidationRevision !== validation.bindingRevision
        || resolved.config.dataSourceId !== validation.connectionId
        || canonical(bindingConfig(resolved.config, validation.connectionId)) !== canonical(config)) fail()
      const resolvedObjects = (await resolveB2aSourceObjects({ sourceObjects: readPlanSourceObjects(action.source.readPlan),
        sourceSystemType: SOURCE_KIND, loadSourceSystemConfig: async () => ({ config: resolved.config }) })).sort()
      if (canonical(sourceObjects) !== canonical(resolvedObjects)) fail()
      await gate()
      const adapter = createAdapter(resolved, { principal: actor.actorId,
        expectedValidationRevision: validation.connectionRevision, b2aAuthorization: authorization })
      const read = method(adapter, 'read'), schema = method(adapter, 'getSchema')
      await gate()
      const sourceAdapter = Object.freeze({
        async getSchema(request) {
          return guarded(async () => { startRead(false); return schema(request) })
        },
        async read(request) {
          return guarded(async () => {
            startRead(true)
            const page = await read(request)
            check()
            if (!plain(page) || !Array.isArray(page.records) || page.records.length > request.limit
              || typeof page.done !== 'boolean' || (page.done === false && !id(page.nextCursor))
              || (page.done === true && page.nextCursor !== undefined && page.nextCursor !== null && page.nextCursor !== '')) {
              stop('AUTOMATION_PREVIEW_UNAVAILABLE')
            }
            countRows(page.records)
            return page
          })
        },
      })
      const recordsApi = Object.freeze({ async queryRecords(request) {
        return guarded(async () => { startRead(true); const value = await queryRecords(request); check(); countRows(value); return value })
      } })
      const result = await previewStockPreparationForAutomation({ action, parameters: { projectNo }, sourceAdapter, recordsApi,
        installedFieldProperties: material.installedFieldProperties, extFieldMapping: material.extFieldMapping,
        tenantId: actor.tenantId, b2aTrialRegistry: registry, b2aClaimStore: runClaimStore,
        b2aOperationClaim: runOperationClaim, b2aSourceObjects: sourceObjects, b2aRunId: runId,
        runId, now: Date.now(), plannedAt: new Date().toISOString(),
      })
      await gate() // The expander catches some read failures as data. A sticky refusal must still win.
      if (!plain(result) || !STATUSES.has(result.status) || result.canApply !== false
        || !plain(result.counts) || Object.keys(result.counts).length !== COUNTS.length
        || COUNTS.some(key => !Number.isSafeInteger(result.counts[key]) || result.counts[key] < 0)) fail()
      return Object.freeze({ status: result.status,
        counts: Object.freeze(Object.fromEntries(COUNTS.map(key => [key, result.counts[key]]))), canApply: false })
    }
    try {
      check()
      const deadline = new Promise((_, reject) => {
        const refuse = code => { if (!failure) failure = new StockPreparationAutomationPreviewError(code); reject(failure) }
        timer = setTimeout(() => refuse('AUTOMATION_PREVIEW_TIMEOUT'), budget.timeoutMs)
        abortListener = () => refuse('AUTOMATION_PREVIEW_ABORTED')
        signal.addEventListener('abort', abortListener, { once: true })
      })
      const running = run()
      trackPendingWork(running)
      return await Promise.race([running, deadline])
    } catch (error) {
      if (failure) throw failure
      if (error instanceof StockPreparationAutomationPreviewError) throw error
      fail('AUTOMATION_PREVIEW_UNAVAILABLE')
    } finally {
      closed = true
      clearTimeout(timer)
      if (abortListener) signal.removeEventListener('abort', abortListener)
    }
  }
}

module.exports = { createStockPreparationAutomationPreview, StockPreparationAutomationPreviewError }
