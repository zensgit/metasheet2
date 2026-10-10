'use strict'

// Server-only saved-draft sample stage. The caller owns tenant/current-owner,
// source revision and B2a admission checks BEFORE supplying this canonical SQL
// adapter. This module grants no activation, target access or apply capability.
const { ROLES, SOURCE_KIND, validateStockPreparationReadPlanConfig } = require('./stock-preparation-read-plan-config.cjs')
const { inspectStockPreparationReadPlanCatalog } = require('./stock-preparation-read-plan-catalog.cjs')
const { expandPlmProjectBom, normalizeRootSelection } = require('./stock-preparation-bom-expansion.cjs')
const {
  B2A_ERROR_CODES, B2aReadAuthorizationError, assertB2aSchemaContract,
  runB2aGuardedSourceRead, assertB2aFullBatchComplete, assertB2aSourceUnchangedAfterRead,
} = require('./b2a-trial-registry.cjs')

const LIMITS = Object.freeze({
  pageLimit: [100, 1000], maxPages: [10, 100], maxReadCount: [100, 1000],
  maxElapsedMs: [15000, 30000], maxDepth: [20, 20], maxRows: [1000, 10000],
  rowErrorLimit: [100, 1000],
})
const SAMPLE_FIELDS = Object.freeze([
  'componentSourceId', 'parentSourceId', 'path', 'depth', 'componentCode',
  'componentName', 'material', 'sourceVersion', 'orderBomVersion', 'rawQuantity', 'totalQuantity',
  'active', 'spec', 'sortLine',
])
const SAMPLE_LIMIT = 20
const OBJECT = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/

class StockPreparationReadPlanValidationReadError extends Error {
  constructor(status, code) {
    super(code)
    this.name = 'StockPreparationReadPlanValidationReadError'
    this.status = status
    this.code = code
  }
}
function refuse(code, status = 422) { throw new StockPreparationReadPlanValidationReadError(status, code) }
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return [Object.prototype, null].includes(Object.getPrototypeOf(value))
}
function limitsFor(action, config) {
  const limits = {}
  for (const [key, [fallback, ceiling]] of Object.entries(LIMITS)) {
    const value = action[key] === undefined ? fallback : action[key]
    if (!Number.isSafeInteger(value) || value < (key === 'maxDepth' ? 0 : 1)) {
      refuse('READ_PLAN_VALIDATION_INPUT_INVALID')
    }
    limits[key] = Math.min(value, ceiling)
  }
  limits.maxReadCount = Math.min(limits.maxReadCount, config.readPlan.maxReadCount)
  return limits
}
function checkedSchema(described, object) {
  if (!record(described) || described.object !== object || !Array.isArray(described.fields)
    || described.fields.length === 0 || described.fields.length > 4096) {
    refuse('READ_PLAN_VALIDATION_CATALOG_UNVERIFIED')
  }
  const fields = described.fields.map((field) => {
    if (!record(field) || typeof field.name !== 'string' || !field.name || field.name.length > 128
      || (field.type !== undefined && (typeof field.type !== 'string' || field.type.length > 128))
      || (field.nullable !== undefined && typeof field.nullable !== 'boolean')) {
      refuse('READ_PLAN_VALIDATION_CATALOG_UNVERIFIED')
    }
    return { name: field.name, type: field.type, nullable: field.nullable }
  })
  return { object, fields }
}
function sampleRow(row) {
  const projected = {}
  for (const field of SAMPLE_FIELDS) {
    const value = row[field]
    if (value === undefined) continue
    if (value !== null && typeof value !== 'boolean'
      && !(typeof value === 'number' && Number.isFinite(value))
      && !(typeof value === 'string' && value.length <= 4096)) {
      refuse('READ_PLAN_VALIDATION_INCOMPLETE', 409)
    }
    projected[field] = value
  }
  return projected
}
function completeExpansion(expansion) {
  return record(expansion) && expansion.valid === true && expansion.status === 'expanded'
    && Array.isArray(expansion.rows) && expansion.rows.length > 0
    && Array.isArray(expansion.errors) && expansion.errors.length === 0
    && Array.isArray(expansion.rowErrors) && expansion.rowErrors.length === 0
    && Array.isArray(expansion.missingComponents) && expansion.missingComponents.length === 0
    && expansion.missingComponentDistinctCount === 0
    && record(expansion.summary) && expansion.summary.rowErrorsTruncated !== true
    && !(expansion.summary.rowErrorsTotal > 0)
}

async function validateStockPreparationReadPlanSample(input = {}) {
  if (!record(input)) refuse('READ_PLAN_VALIDATION_INPUT_INVALID')
  let config, limits, rootSelection, objects, projectNo
  const { action, sourceAdapter, dialect, b2aTrialRegistration, b2aClaimStore, b2aSourceObjects, b2aNow } = input
  try {
    config = validateStockPreparationReadPlanConfig(input.config)
    if (!record(action) || action.actionId !== config.actionId || !record(action.source)
      || action.source.kind !== SOURCE_KIND || action.source.externalSystemId !== config.systemId
      || !['postgres', 'postgresql', 'sqlserver'].includes(dialect)
      || !sourceAdapter || typeof sourceAdapter.getSchema !== 'function' || typeof sourceAdapter.read !== 'function'
      || (sourceAdapter.kind !== undefined && sourceAdapter.kind !== SOURCE_KIND)) {
      refuse('READ_PLAN_VALIDATION_INPUT_INVALID')
    }
    projectNo = typeof input.projectNo === 'string' ? input.projectNo.trim() : ''
    if (!projectNo || projectNo.length > 128
      || [...projectNo].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      refuse('READ_PLAN_VALIDATION_INPUT_INVALID')
    }
    limits = limitsFor(action, config)
    rootSelection = normalizeRootSelection(action.rootSelection)
    objects = [...new Set(Object.keys(ROLES).map((role) => config.readPlan[role].object))]
    if (objects.length > 7 || objects.some((object) => !OBJECT.test(object))) refuse('READ_PLAN_VALIDATION_CATALOG_UNVERIFIED')
    if (b2aTrialRegistration !== null && b2aTrialRegistration !== undefined) {
      if (!record(b2aTrialRegistration) || b2aTrialRegistration.armed !== true || !Number.isFinite(b2aNow)
        || !b2aClaimStore || typeof b2aClaimStore.get !== 'function' || typeof b2aClaimStore.set !== 'function'
        || !Array.isArray(b2aSourceObjects) || b2aSourceObjects.length > 8
        || b2aSourceObjects.some((object) => typeof object !== 'string' || object.length > 128 || !OBJECT.test(object))
        || objects.some((object) => !b2aSourceObjects.includes(object))) refuse('READ_PLAN_VALIDATION_INPUT_INVALID')
    }
  } catch (error) {
    if (error instanceof StockPreparationReadPlanValidationReadError) throw error
    refuse('READ_PLAN_VALIDATION_INPUT_INVALID')
  }

  // Bounds response latency, NOT driver cancellation. Once the deadline closes,
  // an in-flight call may settle but no later schema/page read can start. Driver
  // timeout/connection fencing remains the trusted loader's responsibility.
  let closed = false
  let timer
  const deadlineAt = Date.now() + limits.maxElapsedMs
  const checkOpen = () => { if (closed || Date.now() >= deadlineAt) refuse('READ_PLAN_VALIDATION_TIMEOUT', 504) }
  const adapter = {
    kind: SOURCE_KIND,
    async getSchema(request) {
      checkOpen()
      const described = await sourceAdapter.getSchema(request)
      checkOpen()
      return checkedSchema(described, request.object)
    },
    async read(request) {
      checkOpen()
      const page = await sourceAdapter.read(request)
      checkOpen()
      // The direct SQL adapter's actual protocol is resumable and explicit.
      // Do not inherit the generic expander's legacy missing-done fallback here.
      if (!record(page) || !Array.isArray(page.records) || page.records.length > request.limit
        || page.records.some((row) => !record(row)) || typeof page.done !== 'boolean'
        || (page.done === false && (typeof page.nextCursor !== 'string' || !page.nextCursor))
        || (page.done === true && page.nextCursor !== undefined && page.nextCursor !== null && page.nextCursor !== '')) {
        refuse('READ_PLAN_VALIDATION_INCOMPLETE', 409)
      }
      return page
    },
  }
  async function run() {
    const catalogRows = []
    for (const object of objects) {
      const described = await runB2aGuardedSourceRead(b2aTrialRegistration, () => adapter.getSchema({ object }))
      const [schema, name] = object.split('.')
      catalogRows.push({ schema, name, columns: described.fields })
    }
    const catalog = inspectStockPreparationReadPlanCatalog({ config, catalog: catalogRows, dialect })
    if (catalog.status !== 'matched') refuse('READ_PLAN_VALIDATION_CATALOG_UNVERIFIED')
    const contract = await assertB2aSchemaContract({
      store: b2aClaimStore, authorization: b2aTrialRegistration, sourceAdapter: adapter,
      sourceObjects: b2aSourceObjects, now: b2aNow,
    })
    const expansion = await runB2aGuardedSourceRead(b2aTrialRegistration, () => expandPlmProjectBom({
      sourceAdapter: adapter, projectNo, readPlan: config.readPlan, ...limits, rootSelection,
      requireCompleteBatch: true,
    }))
    assertB2aFullBatchComplete(b2aTrialRegistration, expansion.errors)
    await assertB2aSourceUnchangedAfterRead({
      authorization: b2aTrialRegistration, contract, sourceAdapter: adapter, sourceObjects: b2aSourceObjects,
    })
    if (!completeExpansion(expansion)) refuse('READ_PLAN_VALIDATION_INCOMPLETE', 409)
    // Check every normalized row's projected cells, even those outside display
    // range: a broken hidden tail cannot make this sample a successful check.
    const projected = expansion.rows.map(sampleRow)
    const rows = projected.slice(0, SAMPLE_LIMIT)
    checkOpen()
    return {
      status: 'sample_ready', catalog,
      sample: { rows, totalRows: expansion.rows.length, displayedRows: rows.length, truncated: rows.length < expansion.rows.length },
      evidence: {
        rowCount: expansion.rows.length, sampleCount: expansion.rows.length, readCount: expansion.summary.readCount,
        objectCount: objects.length, displayedRowCount: rows.length, complete: true,
        maxReadCount: limits.maxReadCount, maxPages: limits.maxPages, maxRows: limits.maxRows,
        maxElapsedMs: limits.maxElapsedMs, targetWrites: 0,
      },
      canApply: false, tokenIssued: false, authorizesExecution: false,
    }
  }
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        closed = true
        reject(new StockPreparationReadPlanValidationReadError(504, 'READ_PLAN_VALIDATION_TIMEOUT'))
      }, limits.maxElapsedMs)
    })
    return await Promise.race([run(), deadline])
  } catch (error) {
    if (closed || Date.now() >= deadlineAt) refuse('READ_PLAN_VALIDATION_TIMEOUT', 504)
    if (error instanceof StockPreparationReadPlanValidationReadError) throw error
    if (error instanceof B2aReadAuthorizationError && B2A_ERROR_CODES.includes(error.code)) {
      throw new StockPreparationReadPlanValidationReadError(error.status, error.code)
    }
    refuse('READ_PLAN_VALIDATION_SOURCE_FAILED', 502)
  } finally {
    closed = true
    clearTimeout(timer)
  }
}

module.exports = { StockPreparationReadPlanValidationReadError, validateStockPreparationReadPlanSample }
