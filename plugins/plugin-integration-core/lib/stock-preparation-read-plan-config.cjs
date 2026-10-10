'use strict'

// Structure-only SA02 draft contract. This is deliberately narrower than the
// generic BOM normalizer: no legacy defaults, executable blocks, or extensions.
const { normalizeStockPreparationBomReadPlan } = require('./stock-preparation-bom-expansion.cjs')
const { PLM_STOCK_PREPARATION_ACTION_ID } = require('./stock-preparation-source-binding.cjs')

const READ_PLAN_ID = 'plm.stock-preparation.bom-read.user-draft.v1'
const SOURCE_KIND = 'data-source:sql-readonly'
const ROLES = Object.freeze({
  pathExAttr: { required: ['object', 'matchField', 'pathIdField'], optional: [] },
  pathInfo: { required: ['object', 'idField'], optional: [] },
  orderHead: { required: ['object', 'idField', 'pathIdField'], optional: [] },
  orderDetail: { required: ['object', 'orderIdField', 'componentIdField', 'quantityField'], optional: ['sortField', 'versionField'] },
  part: { required: ['object', 'idField'], optional: ['codeField', 'nameField', 'materialField', 'versionField', 'specField', 'createTimeField'] },
  bomHead: { required: ['object', 'parentPartField', 'bomIdField'], optional: ['versionField', 'activeField'] },
  bomDetail: { required: ['object', 'bomParentField', 'componentIdField', 'quantityField'], optional: ['sortField'] },
})
const FIELD_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const DISALLOWED_SEGMENT = /^(?:select|from|where|join|union|drop|delete|insert|update|exec|execute|script|javascript|http|https|url|password|passwd|pwd|secret|token|credential|credentials|apikey|appkey|authoritycode|tenant|identity|principal|constructor|prototype|proto)$/i

// One or two nonempty ASCII SQL identifier segments. A third part is an
// explicit strict SA02 interoperability limit.
function objectIdentifierText(text) {
  const segments = text.split('.')
  return segments.length >= 1 && segments.length <= 2
    && segments.every((segment) => FIELD_IDENTIFIER.test(segment))
}

class StockPreparationReadPlanConfigError extends Error {
  constructor(code) {
    super(code)
    this.name = 'StockPreparationReadPlanConfigError'
    this.code = code
  }
}

function refuse(code) { throw new StockPreparationReadPlanConfigError(code) }
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
function exactKeys(value, allowed) {
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key))) refuse('READ_PLAN_SHAPE_INVALID')
}
function requiredHandle(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) refuse('READ_PLAN_HANDLE_INVALID')
  return value
}
function identifier(value, kind) {
  if (typeof value !== 'string') refuse('READ_PLAN_IDENTIFIER_INVALID')
  const text = value.trim()
  const grammarOk = kind === 'object' ? objectIdentifierText(text) : FIELD_IDENTIFIER.test(text)
  if (!text || text.length > 128 || !grammarOk
    || text.split(/[._]/).some((segment) => DISALLOWED_SEGMENT.test(segment))) {
    refuse('READ_PLAN_IDENTIFIER_INVALID')
  }
  return text
}
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
}

function validateStockPreparationReadPlanConfig(input) {
  exactKeys(input, ['schemaVersion', 'actionId', 'systemId', 'readPlan'])
  if (input.schemaVersion !== 1 || input.actionId !== PLM_STOCK_PREPARATION_ACTION_ID) {
    refuse('READ_PLAN_FIXED_VALUE_INVALID')
  }
  const systemId = requiredHandle(input.systemId)
  const plan = input.readPlan
  exactKeys(plan, ['id', 'sourceKind', 'matchField', 'maxReadCount', ...Object.keys(ROLES)])
  if (plan.id !== READ_PLAN_ID || plan.sourceKind !== SOURCE_KIND) refuse('READ_PLAN_FIXED_VALUE_INVALID')
  if (!Number.isInteger(plan.maxReadCount) || plan.maxReadCount < 1 || plan.maxReadCount > 1000) {
    refuse('READ_PLAN_BUDGET_INVALID')
  }
  const roles = {}
  for (const [role, schema] of Object.entries(ROLES)) {
    const source = plan[role]
    exactKeys(source, [...schema.required, ...schema.optional])
    const normalized = {}
    for (const key of schema.required) normalized[key] = identifier(source[key], key === 'object' ? 'object' : 'field')
    for (const key of schema.optional) {
      if (source[key] === undefined) continue
      normalized[key] = identifier(source[key], 'field')
    }
    roles[role] = normalized
  }
  const matchField = identifier(plan.matchField, 'field')
  if (matchField !== roles.pathExAttr.matchField) refuse('READ_PLAN_MATCH_FIELD_INVALID')
  if (roles.orderDetail.versionField && !roles.bomHead.versionField) refuse('READ_PLAN_VERSION_DEPENDENCY_INVALID')
  const readPlan = {
    id: READ_PLAN_ID, sourceKind: SOURCE_KIND, matchField,
    ...roles, maxReadCount: plan.maxReadCount,
  }
  try {
    const actual = normalizeStockPreparationBomReadPlan(readPlan)
    // The production normalizer is the final contract, not a substitute for
    // this exact allowlist. It may add no effective fields to this v1 shape.
    if (stable(actual) !== stable(readPlan)) refuse('READ_PLAN_NORMALIZER_MISMATCH')
  } catch (_error) {
    refuse('READ_PLAN_NORMALIZER_REJECTED')
  }
  return { schemaVersion: 1, actionId: PLM_STOCK_PREPARATION_ACTION_ID, systemId, readPlan }
}

module.exports = {
  READ_PLAN_ID, SOURCE_KIND, ROLES,
  StockPreparationReadPlanConfigError,
  validateStockPreparationReadPlanConfig,
}
