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
  duplicateExpandedKeyDiagnosticsForRows,
  planStockPreparationConflicts,
  summarizeConflictPlanForEvidence,
} = require('./stock-preparation-conflict-planner.cjs')
const {
  buildConflictPolicyReview,
  loadTableScopeConflictPolicies,
  normalizeRunOnlyConflictPolicyReview,
} = require('./stock-preparation-conflict-policies.cjs')
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
  normalizeStockPreparationTemplate,
} = require('./stock-preparation-templates.cjs')
const {
  applyStockPreparationPlan,
  summarizeApplyResultForEvidence,
} = require('./stock-preparation-apply-writer.cjs')
const {
  normalizeStockPrepApplyProductionPolicy,
  assertProductionPolicyNotExpired,
} = require('./stock-preparation-production-policy.cjs')

const PLM_STOCK_PREPARATION_ACTION_ID = 'plm.stock-preparation.pull-bom.v1'
const TABLE_ACTION_KIND = 'parameterized_table_action'
const GENERIC_TABLE_ACTION_KIND = 'apply_to_target_table'
const DRY_RUN_TOKEN_PREFIX = 'integration:table-action:dry-run-token:'
const DEFAULT_DRY_RUN_TOKEN_TTL_MS = 30 * 60 * 1000
const DEFAULT_EXISTING_ROWS_PAGE_LIMIT = 1000
const DEFAULT_EXISTING_ROWS_MAX_PAGES = 100
const HARD_APPLY_BLOCKING_ROW_ERROR_TYPES = new Set(['missing_child_bom'])

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
    workspaceId: optionalString(input.workspaceId) || undefined,
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
    label: 'Apply to target table',
    configured,
    display: {
      genericActionKind: GENERIC_TABLE_ACTION_KIND,
      commandLabel: 'Apply to target table',
      commandLabelZh: 'Apply 到目标表',
      targetLabel: 'configured target table',
      targetLabelZh: '已配置目标表',
      presetLabel: 'PLM stock-preparation preset',
      presetLabelZh: 'PLM 备料预设',
      policyLabel: 'fresh dry-run token + server recompute',
      policyLabelZh: 'fresh dry-run token + 服务端重新计算',
    },
    parameters: [{
      id: 'projectNo',
      label: 'Project number',
      type: 'string',
      required: true,
      trim: true,
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

// ── #4160: logical-key <-> physical fieldId translation, bound to the ONE records entry point ──────
//
// The frozen templates declare LOGICAL field keys ('snapshotBatchId'); provisioning materializes each
// one as a DERIVED physical fieldId ('fld_<sha1(projectId:objectId:fieldId)>' — see the platform's
// getObjectFieldId). The multitable records service only ever speaks physical ids: an unknown key is
// rejected outright by buildNormalizedPatch (writes) and normalizeQueryFilters (filters), and the rows
// it returns are keyed by physical id. So EVERY stock-preparation read and write must translate.
//
// The translation is bound HERE — inside the single target-scoped records API that every stock-prep
// records call already goes through — precisely so that "forgot to call resolveFieldIds" stops being a
// convention a module can silently omit (which is exactly how #4160 shipped) and becomes structurally
// impossible. There are exactly TWO modes and a target that declares NEITHER is REJECTED (fail-closed):
//
//   'logical'    (default) — the caller passes `provisioning` + the staging `projectId`; the map is
//                  resolved HERE from the target's frozen template via provisioning.resolveFieldIds.
//                  Writes (data / changes) and reads (filters) are translated key-by-key, an UNKNOWN
//                  logical key THROWS (never a silent drop), and returned rows are translated BACK so
//                  callers keep reading/writing logical keys.
//   'pre_mapped'          — the C4 apply path only: its writer already maps every payload key through
//                  the operator-configured `target.fieldIdMap`, so this API must not map a second time.
//                  Both of its call sites pass the mode EXPLICITLY — an opt-out you cannot fall into.
const FIELD_ID_TRANSLATION_MODES = Object.freeze(['logical', 'pre_mapped'])
const MVP_TEMPLATE_BY_OBJECT_ID = new Map(
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES.map((template) => [template.objectId, template]),
)

// Resolve the target objectId's frozen logical field ids to physical ids. Fail-closed on every step:
// an unknown objectId, a provisioning API without resolveFieldIds, or ANY declared logical field the
// platform did not resolve — a partial map would silently drop columns on write.
async function resolveTargetFieldIds(provisioning, projectId, objectId) {
  const template = MVP_TEMPLATE_BY_OBJECT_ID.get(objectId)
  if (!template) {
    throw new StockPreparationTableActionError(500, 'TABLE_ACTION_FIELD_IDS_UNRESOLVED', 'target objectId has no frozen stock-preparation template to resolve field ids from', { objectId })
  }
  if (!provisioning || typeof provisioning.resolveFieldIds !== 'function' || !optionalString(projectId)) {
    throw new StockPreparationTableActionError(503, 'TABLE_ACTION_FIELD_IDS_UNRESOLVED', 'target-scoped records API requires multitable.provisioning.resolveFieldIds and the resolution projectId', { objectId })
  }
  const fieldIds = template.fields.map((field) => field.id)
  const resolved = await provisioning.resolveFieldIds({ projectId, objectId, fieldIds })
  const map = {}
  const missingFields = []
  for (const fieldId of fieldIds) {
    const physical = optionalString(isPlainObject(resolved) ? resolved[fieldId] : null)
    if (physical) map[fieldId] = physical
    else missingFields.push(fieldId)
  }
  if (missingFields.length > 0) {
    throw new StockPreparationTableActionError(500, 'TABLE_ACTION_FIELD_IDS_UNRESOLVED', 'target-scoped records API could not resolve every declared field id', { objectId, missingFields })
  }
  return map
}

function invertFieldIdMap(fieldIds) {
  const inverse = {}
  for (const [logical, physical] of Object.entries(fieldIds)) inverse[physical] = logical
  return inverse
}

// Fail-closed key translation: an unknown logical key THROWS. Silently dropping it would write a row
// that is missing a column the caller believed it had written — a green lie.
function toPhysicalFieldId(logicalKey, fieldIds, objectId, part) {
  const physical = fieldIds[logicalKey]
  if (!physical) {
    throw new StockPreparationTableActionError(500, 'TABLE_ACTION_UNKNOWN_LOGICAL_FIELD', 'records API call used a field the target template does not declare', {
      field: logicalKey,
      part,
      targetObjectId: objectId,
    })
  }
  return physical
}

function toPhysicalKeys(source, fieldIds, objectId, part) {
  const out = {}
  for (const [key, value] of Object.entries(isPlainObject(source) ? source : {})) {
    out[toPhysicalFieldId(key, fieldIds, objectId, part)] = value
  }
  return out
}

// Reverse direction: the records service returns { id, sheetId, version, data: { <physical>: value } }.
// Only `data` keys are translated — id / sheetId / version (and the recordId the callers patch by) are
// platform identities and pass through untouched. A physical key with no logical twin (a field outside
// the frozen template) is passed through as-is rather than dropped.
function toLogicalRecord(record, inverse) {
  if (!isPlainObject(record) || !isPlainObject(record.data)) return record
  const data = {}
  for (const [key, value] of Object.entries(record.data)) {
    data[Object.prototype.hasOwnProperty.call(inverse, key) ? inverse[key] : key] = value
  }
  return { ...record, data }
}

async function createTargetScopedRecordsApi(recordsApi, target, options = {}) {
  const readOnly = options.readOnly === true
  const api = readOnly ? ensureRecordsApi(recordsApi) : ensureWriteRecordsApi(recordsApi)
  const mode = optionalString(options.fieldIdTranslation) || 'logical'
  if (!FIELD_ID_TRANSLATION_MODES.includes(mode)) {
    throw new StockPreparationTableActionError(500, 'TABLE_ACTION_FIELD_ID_TRANSLATION_INVALID', 'unsupported fieldIdTranslation mode', { fieldIdTranslation: mode })
  }
  const objectId = optionalString(target && target.objectId)
  const fieldIds = mode === 'logical'
    ? await resolveTargetFieldIds(options.provisioning, options.projectId, objectId)
    : null
  const inverse = fieldIds ? invertFieldIdMap(fieldIds) : null

  function withTargetSheet(input = {}) {
    if (input.sheetId && input.sheetId !== target.sheetId) {
      throw new StockPreparationTableActionError(403, 'TABLE_ACTION_TARGET_SCOPE_VIOLATION', 'records API call attempted to leave configured target sheet')
    }
    return { ...input, sheetId: target.sheetId }
  }

  async function queryRecords(input = {}) {
    const scoped = withTargetSheet(input)
    if (mode === 'pre_mapped') return api.queryRecords(scoped)
    if (scoped.filters !== undefined) scoped.filters = toPhysicalKeys(scoped.filters, fieldIds, objectId, 'filters')
    const rows = await api.queryRecords(scoped)
    // A non-array passes straight through so each caller's own "queryRecords must return an array"
    // guard still fires (rather than being masked by a mapping TypeError).
    return Array.isArray(rows) ? rows.map((row) => toLogicalRecord(row, inverse)) : rows
  }

  const scopedApi = { queryRecords }
  if (readOnly) return scopedApi

  scopedApi.createRecord = async function createRecord(input = {}) {
    const scoped = withTargetSheet(input)
    if (mode === 'pre_mapped') return api.createRecord(scoped)
    scoped.data = toPhysicalKeys(scoped.data, fieldIds, objectId, 'data')
    return toLogicalRecord(await api.createRecord(scoped), inverse)
  }
  scopedApi.patchRecord = async function patchRecord(input = {}) {
    const scoped = withTargetSheet(input)
    if (mode === 'pre_mapped') return api.patchRecord(scoped)
    scoped.changes = toPhysicalKeys(scoped.changes, fieldIds, objectId, 'changes')
    return toLogicalRecord(await api.patchRecord(scoped), inverse)
  }
  return scopedApi
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

function buildRevision({ action, parameters, expansion, existingRows, conflictPolicyReview, plan }) {
  return hashJson({
    actionId: action.actionId,
    parameters,
    source: {
      externalSystemId: action.source.externalSystemId,
      workspaceId: action.source.workspaceId,
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
    conflictPolicyReview: conflictPolicyReview || null,
    plan: plan
      ? {
          counts: plan.counts,
          valid: plan.valid === true,
          conflictTypes: plan.summary && plan.summary.conflictTypes,
          duplicateExpandedKeyResolution: plan.summary && plan.summary.duplicateExpandedKeyResolution,
        }
      : null,
  })
}

function duplicateReviewEffectSummary(resolution) {
  if (!isPlainObject(resolution) || resolution.conflictType !== 'duplicate_expanded_key') return null
  const effects = new Map()
  const resolved = Array.isArray(resolution.resolvedPolicies) ? resolution.resolvedPolicies : []
  for (const row of resolved) {
    if (isPlainObject(row) && typeof row.fingerprint === 'string') effects.set(row.fingerprint, 'add_decisions_require_ack')
  }
  const held = Array.isArray(resolution.heldPolicies) ? resolution.heldPolicies : []
  for (const row of held) {
    if (isPlainObject(row) && typeof row.fingerprint === 'string' && !effects.has(row.fingerprint)) {
      effects.set(row.fingerprint, 'manual_confirm_held')
    }
  }
  if (effects.size === 0) return null
  return effects
}

function conflictPolicyReviewForEvidence(review, plan) {
  if (!isPlainObject(review)) return review
  const resolution = plan && plan.summary && plan.summary.duplicateExpandedKeyResolution
  const effects = duplicateReviewEffectSummary(resolution)
  if (!effects) return review
  let resolvedCount = 0
  let heldCount = 0
  const selectedPolicies = Array.isArray(review.selectedPolicies)
    ? review.selectedPolicies.map((row) => {
        if (!isPlainObject(row) || typeof row.fingerprint !== 'string') return row
        const writeEffect = effects.get(row.fingerprint)
        if (!writeEffect) return { ...row }
        if (writeEffect === 'add_decisions_require_ack') resolvedCount += 1
        if (writeEffect === 'manual_confirm_held') heldCount += 1
        return { ...row, writeEffect }
      })
    : review.selectedPolicies
  let writeEffect = review.writeEffect
  if (resolvedCount > 0 && heldCount > 0) {
    writeEffect = 'mixed_duplicate_resolution'
  } else if (resolvedCount > 0) {
    writeEffect = 'add_decisions_require_ack'
  }
  return {
    ...review,
    writeEffect,
    selectedPolicies,
  }
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
  if (stored.actionId !== expected.actionId || stored.parametersHash !== expected.parametersHash || (expected.revision && stored.revision !== expected.revision)) {
    throw new StockPreparationTableActionError(409, 'TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH', 'dryRunToken does not match the current dry-run revision')
  }
  return stored
}

async function computeDryRun({ action, parameters, sourceAdapter, recordsApi, plannedAt, runId, runOnlyReview, tableScopeReview }) {
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
  const hasHardRowErrors = hasHardApplyBlockingRowErrors(expansion)
  if (expansion.status === 'not_found') {
    const revision = buildRevision({ action, parameters, expansion, existingRows: [] })
    return { expansion, existingRows: [], plan: emptyPlan(), revision, canApply: false, hasGlobalErrors }
  }
  const existingRows = await readExistingStockPreparationRows(recordsApi, action.target, parameters.projectNo)
  const duplicateDiagnostics = duplicateExpandedKeyDiagnosticsForRows(expansion.rows)
  const conflictPolicyReview = buildConflictPolicyReview({
    diagnostics: duplicateDiagnostics,
    runOnlyReview,
    tableScopeReview,
  })
  const plan = planStockPreparationConflicts({
    template: action.template,
    conflictStrategy: action.conflictStrategy,
    expandedRows: expansion.rows,
    existingRows,
    rowErrors: expansion.rowErrors,
    runId: runId || `table-action:${action.actionId}`,
    plannedAt: plannedAt || new Date().toISOString(),
    duplicatePolicyReview: conflictPolicyReview,
  })
  const revision = buildRevision({ action, parameters, expansion, existingRows, conflictPolicyReview, plan })
  return {
    expansion,
    existingRows,
    plan,
    revision,
    canApply: !hasGlobalErrors && !hasHardRowErrors,
    hasGlobalErrors,
    conflictPolicyReview,
  }
}

function evidenceForDryRun({ action, parameters, expansion, plan, revision, canApply, conflictPolicyReview }) {
  const planEvidence = summarizeConflictPlanForEvidence(plan)
  if (planEvidence && conflictPolicyReview) planEvidence.conflictPolicyReview = conflictPolicyReviewForEvidence(conflictPolicyReview, plan)
  return {
    actionId: action.actionId,
    projectNoPresent: Boolean(parameters.projectNo),
    dryRunRevision: revision,
    canApply: canApply === true,
    expansion: summarizeBomExpansionForEvidence(expansion),
    plan: planEvidence,
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

function hasHardApplyBlockingRowErrors(expansion) {
  const rowErrors = Array.isArray(expansion && expansion.rowErrors) ? expansion.rowErrors : []
  return rowErrors.some((entry) => isPlainObject(entry) && HARD_APPLY_BLOCKING_ROW_ERROR_TYPES.has(entry.type))
}

async function dryRunStockPreparationAction(input = {}) {
  const action = assertStockPreparationTargetReady(input.action)
  const parameters = normalizeActionParameters(input.parameters)
  const runOnlyReview = normalizeRunOnlyConflictPolicyReview(input.conflictPolicyReview)
  const tableScopeReview = input.policyStore
    ? await loadTableScopeConflictPolicies({ action, policyStore: input.policyStore })
    : null
  const dryRun = await computeDryRun({
    action,
    parameters,
    sourceAdapter: input.sourceAdapter,
    recordsApi: input.recordsApi,
    plannedAt: input.plannedAt,
    runId: input.runId,
    runOnlyReview,
    tableScopeReview,
  })
  let dryRunToken = null
  if (dryRun.canApply) {
    dryRunToken = await createDryRunToken(input.tokenStore, {
      actionId: action.actionId,
      parametersHash: hashJson(parameters),
      revision: dryRun.revision,
      conflictPolicyReview: runOnlyReview,
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
      conflictPolicyReview: dryRun.conflictPolicyReview,
    }),
  }
}

// FOS-4b-3 (sandbox-only apply) — P0 gate. apply may run ONLY when sandbox mode is enabled AND the target
// is in the sandbox allowlist, and NEVER against the production canonical stock-prep object. Fail-closed by
// default: a missing/disabled policy, an unallowlisted target, or the prod canonical → 403. This is the
// FIRST thing apply does (before token consume / dry-run / write). Production apply = separate FOS-4b-3-prod
// owner gate. Error is values-free (only a coarse reason).
function assertStockPrepApplySandboxAllowed(target, sandboxPolicy) {
  // Mirror the writer's target identity: objectId defaults to the prod canonical when unset, so a target
  // missing objectId is treated as canonical (and rejected) rather than slipping through on sheetId.
  const objectId = (target && optionalString(target.objectId)) || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
  // Defense-in-depth: the prod canonical target is never appliable on the sandbox path, regardless of policy.
  if (objectId === STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId) {
    throw new StockPreparationTableActionError(403, 'STOCK_PREP_APPLY_SANDBOX_ONLY', 'apply is sandbox-only; the production canonical stock-prep target is not appliable (production apply is a separate owner gate)', { reason: 'prod_canonical' })
  }
  const policy = isPlainObject(sandboxPolicy) ? sandboxPolicy : {}
  if (policy.enabled !== true) {
    throw new StockPreparationTableActionError(403, 'STOCK_PREP_APPLY_SANDBOX_ONLY', 'apply is sandbox-only; sandbox mode is not enabled', { reason: 'sandbox_disabled' })
  }
  const allowed = Array.isArray(policy.allowedTargetObjectIds) ? policy.allowedTargetObjectIds : []
  if (!allowed.includes(objectId)) {
    throw new StockPreparationTableActionError(403, 'STOCK_PREP_APPLY_SANDBOX_ONLY', 'apply target is not in the sandbox allowlist', { reason: 'target_not_allowlisted' })
  }
}

// FOS-4b-3: resolve the sandbox policy from server config. Explicit config wins (config-file / tests);
// otherwise the recommended env gate STOCK_PREP_SANDBOX_MODE=true + STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS
// (comma-separated allowlist). Absent / mode!=='true' → undefined → apply fail-closed (gate rejects).
function resolveStockPrepApplySandboxPolicy(config, env = process.env) {
  if (config && isPlainObject(config.stockPrepApplySandbox)) {
    return config.stockPrepApplySandbox
  }
  if (env && env.STOCK_PREP_SANDBOX_MODE === 'true') {
    return {
      enabled: true,
      allowedTargetObjectIds: String(env.STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    }
  }
  return undefined
}

// FOS-4b-3-prod P2: resolve the production policy from SERVER CONFIG ONLY (no env — dormant by default).
// Absent → undefined → the apply path stays on the sandbox gate (canonical rejected). A production policy is
// only ever present when an owner explicitly sets context.config.stockPrepApplyProduction. There is
// deliberately no env switch: production must require explicit server config, never an environment variable.
function resolveStockPrepApplyProductionPolicy(config) {
  if (config && isPlainObject(config.stockPrepApplyProduction)) {
    return config.stockPrepApplyProduction
  }
  return undefined
}

// FOS-4b-3-prod P2: the SINGLE apply gate for BOTH write entry points (small-BOM in-function + large-BOM
// route), so route parity is structural and the two paths cannot drift. It branches on the PRESENCE of a
// production policy (not on validation success): a configured production policy takes the production path and
// ANY failure is a hard reject (never a silent demotion to sandbox); absent → the unchanged sandbox gate
// (canonical rejected). The controlled canonical exception requires a valid + unexpired + in-window policy,
// an EXPLICIT canonical objectId, and matching route + action. Returns { mode, maxCleanRows } for the later
// post-plan bound. Values-free errors (coarse reason only). now is the caller-supplied current time.
function assertStockPrepApplyAllowed(target, gateContext = {}) {
  const { sandboxPolicy, productionPolicy, now, route, actionId } = gateContext
  if (productionPolicy !== undefined && productionPolicy !== null) {
    const policy = normalizeStockPrepApplyProductionPolicy(productionPolicy) // throws (422) on malformed
    assertProductionPolicyNotExpired(policy, now) // throws (422) expired / expiry_too_far / missing_now
    const objectId = target && optionalString(target.objectId)
    // Require an EXPLICIT canonical objectId — an omitted/defaulted objectId must not authorize a prod write.
    if (!objectId || objectId !== policy.authorizedTargetObjectId) {
      throw new StockPreparationTableActionError(403, 'STOCK_PREP_PRODUCTION_APPLY_DENIED', 'production apply target is not the authorized canonical target', { reason: 'target_mismatch' })
    }
    if (policy.allowedRoute !== 'both' && policy.allowedRoute !== route) {
      throw new StockPreparationTableActionError(403, 'STOCK_PREP_PRODUCTION_APPLY_DENIED', 'production apply route is not authorized', { reason: 'route_mismatch' })
    }
    if (!actionId || policy.allowedActionId !== actionId) {
      throw new StockPreparationTableActionError(403, 'STOCK_PREP_PRODUCTION_APPLY_DENIED', 'production apply action is not authorized', { reason: 'action_mismatch' })
    }
    return { mode: 'production', maxCleanRows: policy.maxCleanRows }
  }
  // No production policy configured → sandbox gate (unchanged; canonical rejected; sandbox allowlist).
  assertStockPrepApplySandboxAllowed(target, sandboxPolicy)
  return { mode: 'sandbox', maxCleanRows: null }
}

// FOS-4b-3-prod P2: post-plan, pre-write bound. Only enforced on the production path; rejects before any
// write if the plan's clean (add/update) row count exceeds the authorized maxCleanRows.
function assertProductionCleanRowsWithinBound(gateResult, cleanRowCount) {
  if (gateResult && gateResult.mode === 'production' && cleanRowCount > gateResult.maxCleanRows) {
    throw new StockPreparationTableActionError(403, 'STOCK_PREP_PRODUCTION_APPLY_DENIED', 'production apply clean-row count exceeds the authorized bound', { reason: 'max_clean_rows_exceeded' })
  }
}

async function applyStockPreparationAction(input = {}) {
  const action = assertStockPreparationTargetReady(input.action)
  // FOS-4b-3-prod P2: shared apply gate FIRST — fail-closed before any token consume, dry-run, or write.
  // No production policy → sandbox gate (canonical rejected). A configured production policy may authorize
  // the canonical (small route) per the controlled exception.
  const applyGate = assertStockPrepApplyAllowed(action.target, {
    sandboxPolicy: input.sandboxPolicy,
    productionPolicy: input.productionPolicy,
    now: input.now,
    route: 'small',
    actionId: action.actionId,
  })
  const parameters = normalizeActionParameters(input.parameters)
  const tokenRecord = await consumeDryRunToken(input.tokenStore, input.dryRunToken, {
    actionId: action.actionId,
    parametersHash: hashJson(parameters),
  })
  const runOnlyReview = normalizeRunOnlyConflictPolicyReview(tokenRecord.conflictPolicyReview)
  const tableScopeReview = input.policyStore
    ? await loadTableScopeConflictPolicies({ action, policyStore: input.policyStore })
    : null
  const dryRun = await computeDryRun({
    action,
    parameters,
    sourceAdapter: input.sourceAdapter,
    recordsApi: input.recordsApi,
    plannedAt: input.plannedAt,
    runId: input.runId,
    runOnlyReview,
    tableScopeReview,
  })
  if (tokenRecord.revision !== dryRun.revision) {
    throw new StockPreparationTableActionError(409, 'TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH', 'dryRunToken does not match the current dry-run revision')
  }
  if (!dryRun.canApply) {
    throw new StockPreparationTableActionError(409, 'TABLE_ACTION_DRY_RUN_NOT_APPLYABLE', 'current dry-run is not applyable')
  }
  if (dryRun.plan.counts[DECISIONS.MANUAL_CONFIRM] > 0 && input.acceptManualConfirmHold !== true) {
    throw new StockPreparationTableActionError(409, 'TABLE_ACTION_MANUAL_CONFIRM_REQUIRED', 'manual-confirm rows require acceptManualConfirmHold=true')
  }
  const duplicateResolution = dryRun.plan.summary && dryRun.plan.summary.duplicateExpandedKeyResolution
  if (duplicateResolution && Number(duplicateResolution.resolvedGroupCount || 0) > 0 && input.acceptDuplicateResolution !== true) {
    throw new StockPreparationTableActionError(409, 'TABLE_ACTION_DUPLICATE_RESOLUTION_REVIEW_REQUIRED', 'resolved duplicate groups require acceptDuplicateResolution=true')
  }
  // FOS-4b-3-prod P2: post-plan production bound — clean (add/update) rows must be within maxCleanRows.
  // No-op on the sandbox path (mode!=='production'); rejects before any write on the production path.
  const cleanRowCount = (dryRun.plan.counts[DECISIONS.ADD] || 0) + (dryRun.plan.counts[DECISIONS.UPDATE] || 0)
  assertProductionCleanRowsWithinBound(applyGate, cleanRowCount)
  const applyResult = await applyStockPreparationPlan({
    permission: input.permission,
    plan: dryRun.plan,
    target: action.target,
    template: action.template,
    // C4 apply: the writer already maps every payload key through the operator-configured
    // target.fieldIdMap, so the scoped API must NOT translate a second time (#4160).
    recordsApi: await createTargetScopedRecordsApi(input.recordsApi, action.target, { fieldIdTranslation: 'pre_mapped' }),
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
        conflictPolicyReview: dryRun.conflictPolicyReview,
      }),
      apply: summarizeApplyResultForEvidence(applyResult),
    },
  }
}

module.exports = {
  DEFAULT_DRY_RUN_TOKEN_TTL_MS,
  GENERIC_TABLE_ACTION_KIND,
  PLM_STOCK_PREPARATION_ACTION_ID,
  TABLE_ACTION_KIND,
  StockPreparationTableActionError,
  applyStockPreparationAction,
  assertProductionCleanRowsWithinBound,
  assertStockPrepApplyAllowed,
  assertStockPrepApplySandboxAllowed,
  assertStockPreparationTargetReady,
  createStockPreparationTableActionRegistry,
  resolveStockPrepApplyProductionPolicy,
  resolveStockPrepApplySandboxPolicy,
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
