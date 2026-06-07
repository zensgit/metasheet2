'use strict'

// #2253 C5-1: backend parameterized table action contract for PLM project BOM
// -> stock-preparation. This module wires the already-landed C2/C3/C4 helpers
// without adding UI, migrations, external DB writes, or K3 paths.

const crypto = require('node:crypto')

const {
  PLM_STOCK_PREPARATION_BOM_READ_PLAN,
  STOCK_PREPARATION_BOM_SOURCE_KINDS,
  expandPlmProjectBom,
  isLargeBomBoundedExpansion,
  summarizeBomExpansionForEvidence,
} = require('./stock-preparation-bom-expansion.cjs')
const {
  DECISIONS,
  planStockPreparationConflicts,
  summarizeConflictPlanForEvidence,
} = require('./stock-preparation-conflict-planner.cjs')
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  normalizeStockPreparationTemplate,
} = require('./stock-preparation-templates.cjs')
const {
  applyStockPreparationPlan,
  summarizeApplyResultForEvidence,
} = require('./stock-preparation-apply-writer.cjs')

const PLM_STOCK_PREPARATION_ACTION_ID = 'plm.stock-preparation.pull-bom.v1'
const TABLE_ACTION_KIND = 'parameterized_table_action'
const DRY_RUN_TOKEN_PREFIX = 'integration:table-action:dry-run-token:'
const DEFAULT_DRY_RUN_TOKEN_TTL_MS = 30 * 60 * 1000
const DEFAULT_EXISTING_ROWS_PAGE_LIMIT = 1000
const DEFAULT_EXISTING_ROWS_MAX_PAGES = 100

class StockPreparationTableActionError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationTableActionError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requiredString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', `${field} is required`, { field })
  }
  return normalized
}

function positiveInteger(value, field, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', `${field} must be a positive integer`, { field })
  }
  return number
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function hashJson(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex')
}

function normalizeFieldIdMap(value, field) {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) {
    throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', `${field} must be an object`, { field })
  }
  const out = {}
  for (const [logical, physical] of Object.entries(value)) {
    const logicalName = optionalString(logical)
    const physicalName = optionalString(physical)
    if (logicalName && physicalName) out[logicalName] = physicalName
  }
  return out
}

function normalizeTarget(input = {}) {
  if (!isPlainObject(input)) {
    throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', 'target must be an object', { field: 'target' })
  }
  return {
    sheetId: requiredString(input.sheetId, 'target.sheetId'),
    objectId: optionalString(input.objectId) || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId,
    keyField: optionalString(input.keyField) || 'idempotencyKey',
    fieldIdMap: normalizeFieldIdMap(input.fieldIdMap, 'target.fieldIdMap'),
  }
}

function normalizeSource(input = {}) {
  if (!isPlainObject(input)) {
    throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', 'source must be an object', { field: 'source' })
  }
  const kind = optionalString(input.kind) || 'data-source:sql-readonly'
  if (!STOCK_PREPARATION_BOM_SOURCE_KINDS.includes(kind)) {
    throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', 'source.kind must be data-source:sql-readonly or bridge:legacy-sql-readonly', {
      field: 'source.kind',
    })
  }
  const readPlan = cloneJson(input.readPlan || PLM_STOCK_PREPARATION_BOM_READ_PLAN)
  if (!isPlainObject(readPlan)) {
    throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', 'source.readPlan must be an object', { field: 'source.readPlan' })
  }
  if (!input.readPlan || !optionalString(input.readPlan.sourceKind)) {
    readPlan.sourceKind = kind
  }
  if (optionalString(readPlan.sourceKind) !== kind) {
    throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', 'source.readPlan.sourceKind must match source.kind', {
      field: 'source.readPlan.sourceKind',
    })
  }
  return {
    externalSystemId: requiredString(input.externalSystemId, 'source.externalSystemId'),
    kind,
    readPlan,
  }
}

function normalizeStockPreparationActionConfig(input = {}) {
  if (!isPlainObject(input)) {
    throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', 'action config must be an object', { field: 'action' })
  }
  const actionId = optionalString(input.actionId) || PLM_STOCK_PREPARATION_ACTION_ID
  if (actionId !== PLM_STOCK_PREPARATION_ACTION_ID) {
    throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', `unsupported actionId: ${actionId}`, { field: 'actionId' })
  }
  const kind = optionalString(input.kind) || TABLE_ACTION_KIND
  if (kind !== TABLE_ACTION_KIND) {
    throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', `unsupported action kind: ${kind}`, { field: 'kind' })
  }
  return {
    actionId,
    kind,
    label: optionalString(input.label) || 'PLM project BOM -> stock preparation',
    configured: true,
    source: normalizeSource(input.source),
    target: normalizeTarget(input.target),
    template: normalizeStockPreparationTemplate(input.template || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE),
    conflictStrategy: isPlainObject(input.conflictStrategy) ? cloneJson(input.conflictStrategy) : {},
    pageLimit: positiveInteger(input.pageLimit, 'pageLimit', undefined),
    maxPages: positiveInteger(input.maxPages, 'maxPages', undefined),
    maxReadCount: positiveInteger(input.maxReadCount, 'maxReadCount', undefined),
    maxElapsedMs: positiveInteger(input.maxElapsedMs, 'maxElapsedMs', undefined),
    maxDepth: input.maxDepth,
    maxRows: input.maxRows,
  }
}

function targetFieldMapHasExplicitBindings(fieldIdMap = {}) {
  return Object.keys(fieldIdMap || {}).some((field) => optionalString(fieldIdMap[field]))
}

function plmSystemFieldIds(template) {
  return template.fields
    .filter((field) => field.ownership === 'plm_system')
    .map((field) => field.id)
}

function assertTargetFieldMapCompleteness(action) {
  if (!targetFieldMapHasExplicitBindings(action.target.fieldIdMap)) return
  const requiredFields = plmSystemFieldIds(action.template)
  const missingFields = requiredFields.filter((field) => !optionalString(action.target.fieldIdMap[field]))
  if (missingFields.length === 0) return
  throw new StockPreparationTableActionError(
    422,
    'TARGET_SCHEMA_INCOMPLETE',
    'target.fieldIdMap is missing C5 PLM/system fields',
    {
      targetObjectId: action.target.objectId,
      fieldMapMode: 'explicit',
      missingFields,
      requiredFields,
    },
  )
}

function assertStockPreparationTargetReady(input = {}) {
  const action = normalizeStockPreparationActionConfig(input)
  assertTargetFieldMapCompleteness(action)
  return action
}

function publicActionMetadata(action) {
  const configured = Boolean(action && action.configured === true)
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    kind: TABLE_ACTION_KIND,
    label: configured && action.label ? action.label : 'PLM project BOM -> stock preparation',
    configured,
    parameters: [{
      id: 'projectNo',
      label: 'Project number',
      type: 'string',
      required: true,
      trim: true,
      binding: {
        type: 'equality_filter',
        field: 'FileCode',
      },
    }],
    permissions: {
      dryRun: 'read',
      apply: 'write',
    },
    evidence: {
      valuesFreeIssueEvidence: true,
    },
  }
}

function normalizeActionList(actions) {
  if (actions === undefined || actions === null) return []
  if (Array.isArray(actions)) return actions
  if (isPlainObject(actions)) return Object.values(actions)
  throw new StockPreparationTableActionError(422, 'TABLE_ACTION_CONFIG_INVALID', 'table actions config must be an array/object')
}

function createStockPreparationTableActionRegistry({ actions } = {}) {
  const configs = new Map()
  for (const action of normalizeActionList(actions)) {
    const normalized = normalizeStockPreparationActionConfig(action)
    configs.set(normalized.actionId, normalized)
  }
  return {
    async listTableActions() {
      const action = configs.get(PLM_STOCK_PREPARATION_ACTION_ID)
      return [publicActionMetadata(action)]
    },
    async getTableAction(input = {}) {
      const actionId = optionalString(input.actionId) || PLM_STOCK_PREPARATION_ACTION_ID
      if (actionId !== PLM_STOCK_PREPARATION_ACTION_ID) {
        throw new StockPreparationTableActionError(404, 'TABLE_ACTION_NOT_FOUND', `table action not found: ${actionId}`, { actionId })
      }
      const action = configs.get(actionId)
      if (!action) {
        throw new StockPreparationTableActionError(422, 'TABLE_ACTION_NOT_CONFIGURED', `table action is not configured: ${actionId}`, { actionId })
      }
      return cloneJson(action)
    },
  }
}

function normalizeActionParameters(value) {
  if (!isPlainObject(value)) {
    throw new StockPreparationTableActionError(400, 'TABLE_ACTION_PARAMETERS_INVALID', 'parameters must be an object', { field: 'parameters' })
  }
  const allowed = new Set(['projectNo'])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new StockPreparationTableActionError(400, 'TABLE_ACTION_PARAMETERS_INVALID', `unsupported parameter: ${key}`, { field: `parameters.${key}` })
    }
  }
  const projectNo = optionalString(value.projectNo)
  if (!projectNo) {
    throw new StockPreparationTableActionError(400, 'TABLE_ACTION_PARAMETERS_INVALID', 'projectNo is required', { field: 'parameters.projectNo' })
  }
  return { projectNo }
}

function ensureRecordsApi(recordsApi) {
  if (!recordsApi || typeof recordsApi.queryRecords !== 'function') {
    throw new StockPreparationTableActionError(501, 'TABLE_ACTION_RECORDS_API_UNAVAILABLE', 'table action requires multitable.records.queryRecords')
  }
  return recordsApi
}

function ensureWriteRecordsApi(recordsApi) {
  ensureRecordsApi(recordsApi)
  if (typeof recordsApi.createRecord !== 'function' || typeof recordsApi.patchRecord !== 'function') {
    throw new StockPreparationTableActionError(501, 'TABLE_ACTION_RECORDS_API_UNAVAILABLE', 'table action apply requires queryRecords/createRecord/patchRecord')
  }
  return recordsApi
}

function mapFieldName(field, fieldIdMap = {}) {
  return fieldIdMap[field] || field
}

function unmapRecordFields(record, fieldIdMap = {}) {
  const data = isPlainObject(record && record.data) ? record.data : record
  const inverse = {}
  for (const [logical, physical] of Object.entries(fieldIdMap || {})) inverse[physical] = logical
  const out = {}
  for (const [field, value] of Object.entries(data || {})) {
    out[inverse[field] || field] = value
  }
  return out
}

async function readExistingStockPreparationRows(recordsApi, target, projectNo, options = {}) {
  const api = ensureRecordsApi(recordsApi)
  const limit = positiveInteger(options.limit, 'existingRows.limit', DEFAULT_EXISTING_ROWS_PAGE_LIMIT)
  const maxPages = positiveInteger(options.maxPages, 'existingRows.maxPages', DEFAULT_EXISTING_ROWS_MAX_PAGES)
  const rows = []
  const filters = {
    [mapFieldName('projectNo', target.fieldIdMap)]: projectNo,
  }
  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * limit
    const pageRows = await api.queryRecords({
      sheetId: target.sheetId,
      filters,
      limit,
      offset,
    })
    if (!Array.isArray(pageRows)) {
      throw new StockPreparationTableActionError(500, 'TABLE_ACTION_RECORDS_API_INVALID', 'queryRecords must return an array')
    }
    rows.push(...pageRows.map((row) => unmapRecordFields(row, target.fieldIdMap)))
    if (pageRows.length < limit) return rows
  }
  throw new StockPreparationTableActionError(422, 'TABLE_ACTION_EXISTING_ROWS_TOO_LARGE', 'existing stock-preparation rows exceeded maxPages', {
    maxPages,
  })
}

function createTargetScopedRecordsApi(recordsApi, target) {
  const api = ensureWriteRecordsApi(recordsApi)
  function withTargetSheet(input = {}) {
    if (input.sheetId && input.sheetId !== target.sheetId) {
      throw new StockPreparationTableActionError(403, 'TABLE_ACTION_TARGET_SCOPE_VIOLATION', 'records API call attempted to leave configured target sheet')
    }
    return { ...input, sheetId: target.sheetId }
  }
  return {
    queryRecords(input = {}) {
      return api.queryRecords(withTargetSheet(input))
    },
    createRecord(input = {}) {
      return api.createRecord(withTargetSheet(input))
    },
    patchRecord(input = {}) {
      return api.patchRecord(withTargetSheet(input))
    },
  }
}

function emptyPlan() {
  return {
    valid: true,
    runId: 'dry-run',
    plannedAt: null,
    decisions: [],
    counts: {
      [DECISIONS.ADD]: 0,
      [DECISIONS.UPDATE]: 0,
      [DECISIONS.SKIP]: 0,
      [DECISIONS.INACTIVE]: 0,
      [DECISIONS.MANUAL_CONFIRM]: 0,
    },
    summary: {
      runIdPresent: false,
      plannedAtPresent: false,
      counts: {
        [DECISIONS.ADD]: 0,
        [DECISIONS.UPDATE]: 0,
        [DECISIONS.SKIP]: 0,
        [DECISIONS.INACTIVE]: 0,
        [DECISIONS.MANUAL_CONFIRM]: 0,
      },
      expandedRows: 0,
      existingRows: 0,
      rowErrors: 0,
      humanPreservedFields: [],
      plmSystemFields: [],
      conflictTypes: [],
    },
  }
}

function buildRevision({ action, parameters, expansion, existingRows }) {
  return hashJson({
    actionId: action.actionId,
    parameters,
    source: {
      externalSystemId: action.source.externalSystemId,
      readPlan: action.source.readPlan,
    },
    target: action.target,
    expansion: {
      status: expansion.status,
      rows: expansion.rows,
      errors: expansion.errors,
      rowErrors: expansion.rowErrors,
    },
    existingRows,
  })
}

function tokenStoreKey(token) {
  return `${DRY_RUN_TOKEN_PREFIX}${token}`
}

function requireTokenStore(tokenStore) {
  if (!tokenStore || typeof tokenStore.get !== 'function' || typeof tokenStore.set !== 'function') {
    throw new StockPreparationTableActionError(501, 'TABLE_ACTION_TOKEN_STORE_UNAVAILABLE', 'table action requires plugin storage for dry-run tokens')
  }
  return tokenStore
}

async function createDryRunToken(tokenStore, record) {
  const store = requireTokenStore(tokenStore)
  const token = crypto.randomBytes(24).toString('base64url')
  await store.set(tokenStoreKey(token), {
    ...record,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + DEFAULT_DRY_RUN_TOKEN_TTL_MS).toISOString(),
  })
  return token
}

async function consumeDryRunToken(tokenStore, token, expected) {
  const store = requireTokenStore(tokenStore)
  const dryRunToken = optionalString(token)
  if (!dryRunToken) {
    throw new StockPreparationTableActionError(400, 'TABLE_ACTION_DRY_RUN_TOKEN_REQUIRED', 'dryRunToken is required for apply', { field: 'confirm.dryRunToken' })
  }
  const key = tokenStoreKey(dryRunToken)
  const stored = await store.get(key)
  if (typeof store.delete === 'function') await store.delete(key)
  if (!isPlainObject(stored)) {
    throw new StockPreparationTableActionError(409, 'TABLE_ACTION_DRY_RUN_TOKEN_INVALID', 'dryRunToken is missing, expired, or already used')
  }
  const expiresAt = Date.parse(stored.expiresAt)
  if (!Number.isNaN(expiresAt) && expiresAt < Date.now()) {
    throw new StockPreparationTableActionError(409, 'TABLE_ACTION_DRY_RUN_TOKEN_INVALID', 'dryRunToken is expired')
  }
  if (stored.actionId !== expected.actionId || stored.parametersHash !== expected.parametersHash || stored.revision !== expected.revision) {
    throw new StockPreparationTableActionError(409, 'TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH', 'dryRunToken does not match the current dry-run revision')
  }
  return stored
}

async function computeDryRun({ action, parameters, sourceAdapter, recordsApi, plannedAt, runId }) {
  const expansion = await expandPlmProjectBom({
    sourceAdapter,
    projectNo: parameters.projectNo,
    readPlan: action.source.readPlan,
    pageLimit: action.pageLimit,
    maxPages: action.maxPages,
    maxReadCount: action.maxReadCount,
    maxElapsedMs: action.maxElapsedMs,
    maxDepth: action.maxDepth,
    maxRows: action.maxRows,
  })
  const hasGlobalErrors = Array.isArray(expansion.errors) && expansion.errors.length > 0
  if (expansion.status === 'not_found') {
    const revision = buildRevision({ action, parameters, expansion, existingRows: [] })
    return { expansion, existingRows: [], plan: emptyPlan(), revision, canApply: false, hasGlobalErrors }
  }
  const existingRows = await readExistingStockPreparationRows(recordsApi, action.target, parameters.projectNo)
  const revision = buildRevision({ action, parameters, expansion, existingRows })
  const plan = planStockPreparationConflicts({
    template: action.template,
    conflictStrategy: action.conflictStrategy,
    expandedRows: expansion.rows,
    existingRows,
    rowErrors: expansion.rowErrors,
    runId: runId || `table-action:${action.actionId}`,
    plannedAt: plannedAt || new Date().toISOString(),
  })
  return {
    expansion,
    existingRows,
    plan,
    revision,
    canApply: !hasGlobalErrors,
    hasGlobalErrors,
  }
}

function evidenceForDryRun({ action, parameters, expansion, plan, revision, canApply }) {
  return {
    actionId: action.actionId,
    projectNoPresent: Boolean(parameters.projectNo),
    dryRunRevision: revision,
    canApply: canApply === true,
    expansion: summarizeBomExpansionForEvidence(expansion),
    plan: summarizeConflictPlanForEvidence(plan),
  }
}

function largeBomBoundedPreview(expansion) {
  if (!isLargeBomBoundedExpansion(expansion)) return undefined
  const evidence = summarizeBomExpansionForEvidence(expansion)
  return evidence.boundedPreview
}

function dryRunStatus(dryRun) {
  if (dryRun.expansion.status === 'not_found') return 'not_found'
  if (isLargeBomBoundedExpansion(dryRun.expansion)) return 'large_bom_bounded'
  if (dryRun.canApply) return dryRun.plan.valid ? 'ready' : 'manual_confirm_required'
  return 'failed'
}

async function dryRunStockPreparationAction(input = {}) {
  const action = assertStockPreparationTargetReady(input.action)
  const parameters = normalizeActionParameters(input.parameters)
  const dryRun = await computeDryRun({
    action,
    parameters,
    sourceAdapter: input.sourceAdapter,
    recordsApi: input.recordsApi,
    plannedAt: input.plannedAt,
    runId: input.runId,
  })
  let dryRunToken = null
  if (dryRun.canApply) {
    dryRunToken = await createDryRunToken(input.tokenStore, {
      actionId: action.actionId,
      parametersHash: hashJson(parameters),
      revision: dryRun.revision,
    })
  }
  return {
    action: publicActionMetadata(action),
    status: dryRunStatus(dryRun),
    largeBom: isLargeBomBoundedExpansion(dryRun.expansion),
    boundedPreview: largeBomBoundedPreview(dryRun.expansion),
    dryRunToken,
    revision: dryRun.revision,
    canApply: dryRun.canApply,
    counts: cloneJson(dryRun.plan.counts),
    evidence: evidenceForDryRun({
      action,
      parameters,
      expansion: dryRun.expansion,
      plan: dryRun.plan,
      revision: dryRun.revision,
      canApply: dryRun.canApply,
    }),
  }
}

async function applyStockPreparationAction(input = {}) {
  const action = assertStockPreparationTargetReady(input.action)
  const parameters = normalizeActionParameters(input.parameters)
  const dryRun = await computeDryRun({
    action,
    parameters,
    sourceAdapter: input.sourceAdapter,
    recordsApi: input.recordsApi,
    plannedAt: input.plannedAt,
    runId: input.runId,
  })
  await consumeDryRunToken(input.tokenStore, input.dryRunToken, {
    actionId: action.actionId,
    parametersHash: hashJson(parameters),
    revision: dryRun.revision,
  })
  if (!dryRun.canApply) {
    throw new StockPreparationTableActionError(409, 'TABLE_ACTION_DRY_RUN_NOT_APPLYABLE', 'current dry-run is not applyable')
  }
  if (dryRun.plan.counts[DECISIONS.MANUAL_CONFIRM] > 0 && input.acceptManualConfirmHold !== true) {
    throw new StockPreparationTableActionError(409, 'TABLE_ACTION_MANUAL_CONFIRM_REQUIRED', 'manual-confirm rows require acceptManualConfirmHold=true')
  }
  const applyResult = await applyStockPreparationPlan({
    permission: input.permission,
    plan: dryRun.plan,
    target: action.target,
    template: action.template,
    recordsApi: createTargetScopedRecordsApi(input.recordsApi, action.target),
  })
  return {
    action: publicActionMetadata(action),
    status: applyResult.status,
    permission: applyResult.permission,
    dryRunRevision: dryRun.revision,
    apply: summarizeApplyResultForEvidence(applyResult),
    evidence: {
      actionId: action.actionId,
      projectNoPresent: Boolean(parameters.projectNo),
      dryRunRevision: dryRun.revision,
      dryRun: evidenceForDryRun({
        action,
        parameters,
        expansion: dryRun.expansion,
        plan: dryRun.plan,
        revision: dryRun.revision,
        canApply: dryRun.canApply,
      }),
      apply: summarizeApplyResultForEvidence(applyResult),
    },
  }
}

module.exports = {
  DEFAULT_DRY_RUN_TOKEN_TTL_MS,
  PLM_STOCK_PREPARATION_ACTION_ID,
  TABLE_ACTION_KIND,
  StockPreparationTableActionError,
  applyStockPreparationAction,
  assertStockPreparationTargetReady,
  createStockPreparationTableActionRegistry,
  createTargetScopedRecordsApi,
  dryRunStockPreparationAction,
  normalizeActionParameters,
  normalizeStockPreparationActionConfig,
  publicActionMetadata,
  __internals: {
    buildRevision,
    consumeDryRunToken,
    createDryRunToken,
    hashJson,
    plmSystemFieldIds,
    readExistingStockPreparationRows,
    stableStringify,
    targetFieldMapHasExplicitBindings,
    unmapRecordFields,
  },
}
