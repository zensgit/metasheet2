'use strict'

// #2253 C3: conflict planner for PLM stock-preparation refreshes.
// Pure and write-free. It consumes C2 expanded rows + existing stock-preparation
// rows + C2 rowErrors, then produces add/update/skip/inactive/manual_confirm
// decisions for a later C4 apply writer. No PLM read, MetaSheet write, route,
// UI, external DB write, or K3 path.

const {
  HUMAN_PRESERVED_FIELD_IDS,
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  normalizeStockPreparationTemplate,
} = require('./stock-preparation-templates.cjs')

const DECISIONS = Object.freeze({
  ADD: 'add',
  UPDATE: 'update',
  SKIP: 'skip',
  INACTIVE: 'inactive',
  MANUAL_CONFIRM: 'manual_confirm',
})

const RUN_FIELD_IDS = Object.freeze([
  'lastPlmRefreshRunId',
  'lastPlmRefreshAt',
  'lastPlmRefreshDecision',
  'lastPlmConflictSummary',
])

const LINEAGE_FIELD_IDS = Object.freeze([
  'projectNo',
  'componentSourceId',
  'parentSourceId',
  'path',
])

const IDENTITY_FIELD_IDS = Object.freeze([
  'componentCode',
  'componentName',
  'material',
  'sourceVersion',
])

class StockPreparationConflictPlannerError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'StockPreparationConflictPlannerError'
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

function optionalString(value, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StockPreparationConflictPlannerError(`${field} must be a string`, { field })
  }
  return value.trim()
}

function normalizeRows(rows, field) {
  if (rows === undefined || rows === null) return []
  if (!Array.isArray(rows)) {
    throw new StockPreparationConflictPlannerError(`${field} must be an array`, { field })
  }
  return rows.filter(isPlainObject).map((row) => ({ ...row }))
}

function normalizeRunId(value) {
  return optionalString(value, 'runId', 'dry-run')
}

function normalizeIsoTime(value) {
  if (value === undefined || value === null || value === '') {
    return new Date().toISOString()
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed !== '') {
      const timestamp = Date.parse(trimmed)
      if (!Number.isNaN(timestamp)) return new Date(timestamp).toISOString()
    }
  }
  throw new StockPreparationConflictPlannerError('plannedAt must be an ISO string or Date', { field: 'plannedAt' })
}

function normalizeTemplate(template) {
  return normalizeStockPreparationTemplate(template || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
}

function normalizeStrategy(template, override) {
  const strategy = { ...(template.conflictStrategy || {}), ...(isPlainObject(override) ? override : {}) }
  if (strategy.deleteByDefault === true) {
    throw new StockPreparationConflictPlannerError('deleteByDefault is not supported for stock-preparation planning', {
      field: 'conflictStrategy.deleteByDefault',
    })
  }
  if (strategy.preserveHumanFields === false) {
    throw new StockPreparationConflictPlannerError('human-preserved fields must be preserved', {
      field: 'conflictStrategy.preserveHumanFields',
    })
  }
  if (strategy.missingFromPlmPolicy && strategy.missingFromPlmPolicy !== 'mark_inactive') {
    throw new StockPreparationConflictPlannerError('missingFromPlmPolicy must be mark_inactive for v1', {
      field: 'conflictStrategy.missingFromPlmPolicy',
    })
  }
  return {
    addMissing: strategy.addMissing !== false,
    refreshPlmSystemFields: strategy.refreshPlmSystemFields !== false,
    preserveHumanFields: true,
    duplicatePolicy: strategy.duplicatePolicy || 'skip_or_conflict',
    missingFromPlmPolicy: 'mark_inactive',
    deleteByDefault: false,
  }
}

function fieldIdsByOwnership(template, ownership) {
  return template.fields.filter((field) => field.ownership === ownership).map((field) => field.id)
}

function plmRefreshFieldIds(template) {
  return fieldIdsByOwnership(template, 'plm_system').filter((id) => !RUN_FIELD_IDS.includes(id))
}

function keyOf(row) {
  return isPlainObject(row) && typeof row.idempotencyKey === 'string' && row.idempotencyKey.trim() !== ''
    ? row.idempotencyKey
    : null
}

function groupByKey(rows) {
  const keyed = new Map()
  const missing = []
  for (const row of rows) {
    const key = keyOf(row)
    if (!key) {
      missing.push(row)
      continue
    }
    const group = keyed.get(key) || []
    group.push(row)
    keyed.set(key, group)
  }
  return { keyed, missing }
}

function comparableValue(value) {
  return value === undefined ? null : value
}

function isPrimitiveComparable(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

function valuesEqual(left, right) {
  const normalizedLeft = comparableValue(left)
  const normalizedRight = comparableValue(right)
  if (normalizedLeft === normalizedRight) return true
  if (isPrimitiveComparable(normalizedLeft) && isPrimitiveComparable(normalizedRight)) return false
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight)
}

function changedFields(nextRow, existingRow, fields) {
  return fields.filter((field) => !valuesEqual(nextRow[field], existingRow[field]))
}

function pickFields(row, fields) {
  const out = {}
  for (const field of fields) {
    if (row[field] !== undefined) out[field] = row[field]
  }
  return out
}

function assertNoHumanFields(payload, humanFields, context) {
  for (const field of humanFields) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      throw new StockPreparationConflictPlannerError(`${context} must not include human-preserved field ${field}`, {
        field,
        context,
      })
    }
  }
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  const leftSet = new Set(left)
  if (leftSet.size !== left.length) return false
  const rightSet = new Set(right)
  if (rightSet.size !== right.length) return false
  return right.every((value) => leftSet.has(value))
}

function runPatch(runId, plannedAt, decision, conflictSummary = '') {
  return {
    lastPlmRefreshRunId: runId,
    lastPlmRefreshAt: plannedAt,
    lastPlmRefreshDecision: decision,
    lastPlmConflictSummary: conflictSummary,
  }
}

function makeConflictSummary(type, details = {}) {
  const out = { type }
  for (const [key, value] of Object.entries(details)) {
    if (value !== undefined && value !== null && value !== '') out[key] = value
  }
  return out
}

function addDecision(decisions, counts, decision) {
  decisions.push(decision)
  counts[decision.decision] += 1
}

function manualConfirm(decisions, counts, input) {
  addDecision(decisions, counts, {
    decision: DECISIONS.MANUAL_CONFIRM,
    idempotencyKey: input.idempotencyKey,
    conflictSummary: makeConflictSummary(input.type, input.details),
    changedFields: Array.isArray(input.changedFields) ? input.changedFields.slice() : [],
    source: input.source || 'planner',
  })
}

function makeAddDecision(row, runId, plannedAt, plmFields, humanFields) {
  const record = {
    ...pickFields(row, plmFields),
    ...runPatch(runId, plannedAt, DECISIONS.ADD),
  }
  assertNoHumanFields(record, humanFields, 'add record')
  return {
    decision: DECISIONS.ADD,
    idempotencyKey: row.idempotencyKey,
    record,
    conflictSummary: makeConflictSummary('add_missing'),
  }
}

function makeUpdateDecision(row, existing, runId, plannedAt, plmFields, humanFields, changed) {
  const patch = {
    ...pickFields(row, plmFields),
    ...runPatch(runId, plannedAt, DECISIONS.UPDATE, JSON.stringify({ type: 'plm_system_refresh', changedFields: changed })),
  }
  assertNoHumanFields(patch, humanFields, 'update patch')
  return {
    decision: DECISIONS.UPDATE,
    idempotencyKey: row.idempotencyKey,
    patch,
    changedFields: changed,
    conflictSummary: makeConflictSummary('plm_system_refresh', { changedFieldCount: changed.length }),
  }
}

function makeSkipDecision(row) {
  return {
    decision: DECISIONS.SKIP,
    idempotencyKey: row.idempotencyKey,
    conflictSummary: makeConflictSummary('unchanged'),
  }
}

function makeInactiveDecision(existing, runId, plannedAt, humanFields) {
  const patch = {
    active: false,
    ...runPatch(runId, plannedAt, DECISIONS.INACTIVE, JSON.stringify({ type: 'missing_from_plm' })),
  }
  assertNoHumanFields(patch, humanFields, 'inactive patch')
  return {
    decision: DECISIONS.INACTIVE,
    idempotencyKey: existing.idempotencyKey,
    patch,
    conflictSummary: makeConflictSummary('missing_from_plm'),
  }
}

function planStockPreparationConflicts(input = {}) {
  const template = normalizeTemplate(input.template)
  const strategy = normalizeStrategy(template, input.conflictStrategy)
  const runId = normalizeRunId(input.runId)
  const plannedAt = normalizeIsoTime(input.plannedAt)
  const expandedRows = normalizeRows(input.expandedRows, 'expandedRows')
  const existingRows = normalizeRows(input.existingRows, 'existingRows')
  const rowErrors = normalizeRows(input.rowErrors, 'rowErrors')

  const humanFields = HUMAN_PRESERVED_FIELD_IDS.slice()
  const templateHumanFields = fieldIdsByOwnership(template, 'human_preserved')
  if (!sameStringSet(humanFields, templateHumanFields)) {
    throw new StockPreparationConflictPlannerError('human field whitelist drifted from template', {
      field: 'template.fields',
    })
  }
  const plmFields = plmRefreshFieldIds(template)
  const counts = {
    [DECISIONS.ADD]: 0,
    [DECISIONS.UPDATE]: 0,
    [DECISIONS.SKIP]: 0,
    [DECISIONS.INACTIVE]: 0,
    [DECISIONS.MANUAL_CONFIRM]: 0,
  }
  const decisions = []

  const expanded = groupByKey(expandedRows)
  const existing = groupByKey(existingRows)

  for (const row of expanded.missing) {
    manualConfirm(decisions, counts, {
      type: 'missing_expanded_idempotency_key',
      source: 'expanded_row',
    })
  }
  for (const row of existing.missing) {
    manualConfirm(decisions, counts, {
      type: 'missing_existing_idempotency_key',
      source: 'existing_row',
    })
  }
  for (const rowError of rowErrors) {
    manualConfirm(decisions, counts, {
      type: rowError.type || 'c2_row_error',
      source: 'c2_row_error',
      details: {
        field: rowError.field,
        depth: rowError.depth,
        relation: rowError.relation,
      },
    })
  }

  const duplicateExpandedKeys = new Set()
  for (const [key, rows] of expanded.keyed.entries()) {
    if (rows.length > 1) {
      duplicateExpandedKeys.add(key)
      manualConfirm(decisions, counts, {
        idempotencyKey: key,
        type: 'duplicate_expanded_key',
        source: 'expanded_rows',
        details: { count: rows.length },
      })
    }
  }
  const duplicateExistingKeys = new Set()
  for (const [key, rows] of existing.keyed.entries()) {
    if (rows.length > 1) {
      duplicateExistingKeys.add(key)
      manualConfirm(decisions, counts, {
        idempotencyKey: key,
        type: 'duplicate_existing_key',
        source: 'existing_rows',
        details: { count: rows.length },
      })
    }
  }

  for (const [key, rows] of expanded.keyed.entries()) {
    if (duplicateExpandedKeys.has(key) || duplicateExistingKeys.has(key)) continue
    const row = rows[0]
    const existingGroup = existing.keyed.get(key)
    const existingRow = existingGroup && existingGroup[0]
    if (!existingRow) {
      if (strategy.addMissing) {
        addDecision(decisions, counts, makeAddDecision(row, runId, plannedAt, plmFields, humanFields))
      } else {
        manualConfirm(decisions, counts, {
          idempotencyKey: key,
          type: 'add_missing_disabled',
          source: 'conflict_strategy',
        })
      }
      continue
    }

    const lineageChanges = changedFields(row, existingRow, LINEAGE_FIELD_IDS)
    if (lineageChanges.length > 0) {
      manualConfirm(decisions, counts, {
        idempotencyKey: key,
        type: 'lineage_mismatch',
        source: 'existing_row',
        changedFields: lineageChanges,
        details: { changedFieldCount: lineageChanges.length },
      })
      continue
    }

    const identityChanges = changedFields(row, existingRow, IDENTITY_FIELD_IDS)
    if (identityChanges.length > 0) {
      manualConfirm(decisions, counts, {
        idempotencyKey: key,
        type: 'component_identity_conflict',
        source: 'existing_row',
        changedFields: identityChanges,
        details: { changedFieldCount: identityChanges.length },
      })
      continue
    }

    const refreshChanges = strategy.refreshPlmSystemFields ? changedFields(row, existingRow, plmFields) : []
    if (refreshChanges.length === 0) {
      addDecision(decisions, counts, makeSkipDecision(row))
      continue
    }
    addDecision(decisions, counts, makeUpdateDecision(row, existingRow, runId, plannedAt, plmFields, humanFields, refreshChanges))
  }

  for (const [key, rows] of existing.keyed.entries()) {
    if (expanded.keyed.has(key) || duplicateExistingKeys.has(key)) continue
    const existingRow = rows[0]
    if (existingRow.active === false) {
      addDecision(decisions, counts, {
        decision: DECISIONS.SKIP,
        idempotencyKey: key,
        conflictSummary: makeConflictSummary('already_inactive'),
      })
      continue
    }
    addDecision(decisions, counts, makeInactiveDecision(existingRow, runId, plannedAt, humanFields))
  }

  return {
    valid: counts[DECISIONS.MANUAL_CONFIRM] === 0,
    runId,
    plannedAt,
    decisions,
    counts,
    summary: {
      runIdPresent: !isBlank(runId),
      plannedAtPresent: !isBlank(plannedAt),
      counts: { ...counts },
      expandedRows: expandedRows.length,
      existingRows: existingRows.length,
      rowErrors: rowErrors.length,
      humanPreservedFields: humanFields.slice(),
      plmSystemFields: plmFields.slice(),
      conflictTypes: Array.from(new Set(decisions.map((decision) => decision.conflictSummary && decision.conflictSummary.type).filter(Boolean))).sort(),
    },
  }
}

function summarizeConflictPlanForEvidence(plan = {}) {
  const summary = isPlainObject(plan.summary) ? plan.summary : {}
  return {
    valid: plan.valid === true,
    runIdPresent: summary.runIdPresent === true,
    plannedAtPresent: summary.plannedAtPresent === true,
    counts: isPlainObject(summary.counts) ? { ...summary.counts } : {},
    expandedRows: Number(summary.expandedRows || 0),
    existingRows: Number(summary.existingRows || 0),
    rowErrors: Number(summary.rowErrors || 0),
    humanPreservedFields: Array.isArray(summary.humanPreservedFields) ? summary.humanPreservedFields.slice() : [],
    plmSystemFields: Array.isArray(summary.plmSystemFields) ? summary.plmSystemFields.slice() : [],
    conflictTypes: Array.isArray(summary.conflictTypes) ? summary.conflictTypes.slice() : [],
  }
}

module.exports = {
  DECISIONS,
  RUN_FIELD_IDS,
  LINEAGE_FIELD_IDS,
  IDENTITY_FIELD_IDS,
  StockPreparationConflictPlannerError,
  planStockPreparationConflicts,
  summarizeConflictPlanForEvidence,
  __internals: {
    changedFields,
    groupByKey,
    normalizeStrategy,
    normalizeIsoTime,
    plmRefreshFieldIds,
    sameStringSet,
    valuesEqual,
  },
}
