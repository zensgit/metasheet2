'use strict'

const crypto = require('node:crypto')

const INTAKE_STATUSES = Object.freeze({
  READY: 'ready',
  PARTIAL: 'partial',
  EMPTY: 'empty',
})

const ROW_ERROR_TYPES = Object.freeze({
  MISSING_PROJECT_KEY: 'missing_project_key',
  MISSING_BOM_PATH_KEY: 'missing_bom_path_key',
  MISSING_BOM_PROJECT: 'missing_bom_project',
  MISSING_MATERIAL_CODE: 'missing_material_code',
  MISSING_MATERIAL_INTERNAL_ID: 'missing_material_internal_id',
})

class StockPreparationReadonlyIntakeError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'StockPreparationReadonlyIntakeError'
    this.details = details
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function optionalString(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function requiredString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new StockPreparationReadonlyIntakeError(`${field} is required`, { field })
  }
  return normalized
}

function numberOrUndefined(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function asArray(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new StockPreparationReadonlyIntakeError(`${field} must be an array`, { field })
  }
  return value
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function stableFingerprint(value) {
  return `sha16:${stableHash(value)}`
}

function firstValue(row, keys) {
  for (const key of keys) {
    const value = optionalString(row && row[key])
    if (value !== null) return value
  }
  return null
}

function firstNumber(row, keys) {
  for (const key of keys) {
    const value = numberOrUndefined(row && row[key])
    if (value !== undefined) return value
  }
  return undefined
}

function normalizeRows(rows, field) {
  return asArray(rows, field).map((row, index) => {
    if (!isPlainObject(row)) {
      throw new StockPreparationReadonlyIntakeError(`${field}[${index}] must be an object`, { field: `${field}[${index}]` })
    }
    return { ...row }
  })
}

function pushRowError(rowErrors, table, index, type, field) {
  rowErrors.push({
    table,
    index,
    type,
    field,
    severity: 'blocking',
  })
}

function normalizeIsoTime(value) {
  if (value === undefined || value === null || value === '') return new Date().toISOString()
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  if (typeof value === 'string' && value.trim()) {
    const timestamp = Date.parse(value.trim())
    if (!Number.isNaN(timestamp)) return new Date(timestamp).toISOString()
  }
  throw new StockPreparationReadonlyIntakeError('startedAt must be an ISO string or Date', { field: 'startedAt' })
}

function normalizeInput(input = {}) {
  const sourceSystem = optionalString(input.sourceSystem) || 'manual_import'
  const runId = optionalString(input.runId) || `stockprep_readonly_intake_${stableHash(`${sourceSystem}|${Date.now()}`)}`
  const startedAt = normalizeIsoTime(input.startedAt)
  return {
    sourceSystem,
    runId,
    startedAt,
    createdBy: optionalString(input.createdBy) || 'system',
    snapshotBatchId: optionalString(input.snapshotBatchId) || `stockprep_snapshot_${stableHash(`${sourceSystem}|${runId}`)}`,
    snapshotVersion: numberOrUndefined(input.snapshotVersion) || 1,
    sourceBomId: optionalString(input.sourceBomId),
    projects: normalizeRows(input.projects, 'projects'),
    plmBomLines: normalizeRows(input.plmBomLines, 'plmBomLines'),
    erpMaterials: normalizeRows(input.erpMaterials, 'erpMaterials'),
  }
}

function projectKey(row) {
  return firstValue(row, ['sourceProjectNo', 'projectNo', 'FileCode', 'FProjectNo', 'projectCode'])
}

function projectIdFor(sourceSystem, sourceProjectNo) {
  return `stockprep_project_${stableHash(`${sourceSystem}|${sourceProjectNo}`)}`
}

function normalizeProjects(input, rowErrors) {
  const out = []
  const bySourceProjectNo = new Map()
  for (const [index, row] of input.projects.entries()) {
    const sourceProjectNo = projectKey(row)
    if (!sourceProjectNo) {
      pushRowError(rowErrors, 'project', index, ROW_ERROR_TYPES.MISSING_PROJECT_KEY, 'sourceProjectNo')
      continue
    }
    const sourceSystem = firstValue(row, ['sourceSystem']) || input.sourceSystem
    const projectId = firstValue(row, ['projectId']) || projectIdFor(sourceSystem, sourceProjectNo)
    const normalized = {
      projectId,
      sourceProjectNo,
      projectName: firstValue(row, ['projectName', 'name', 'FileName', 'FProjectName']),
      sourceSystem,
      projectStatus: firstValue(row, ['projectStatus', 'status']) || 'imported',
      lastSyncRunId: input.runId,
      lastSyncedAt: input.startedAt,
      owner: firstValue(row, ['owner', 'createdBy']),
    }
    out.push(normalized)
    bySourceProjectNo.set(sourceProjectNo, projectId)
  }
  return { rows: out, bySourceProjectNo }
}

function inferProjectId(input, projectIndex, row) {
  const explicitProjectId = firstValue(row, ['projectId'])
  if (explicitProjectId) return explicitProjectId
  const sourceProjectNo = projectKey(row)
  if (sourceProjectNo && projectIndex.bySourceProjectNo.has(sourceProjectNo)) {
    return projectIndex.bySourceProjectNo.get(sourceProjectNo)
  }
  if (projectIndex.rows.length === 1) return projectIndex.rows[0].projectId
  if (sourceProjectNo) return projectIdFor(input.sourceSystem, sourceProjectNo)
  return null
}

function normalizeBomLine(input, projectIndex, row, index, rowErrors) {
  const pathKey = firstValue(row, ['pathKey', 'path', 'bomPath'])
  if (!pathKey) {
    pushRowError(rowErrors, 'bom_snapshot_line', index, ROW_ERROR_TYPES.MISSING_BOM_PATH_KEY, 'pathKey')
    return null
  }
  const projectId = inferProjectId(input, projectIndex, row)
  if (!projectId) {
    pushRowError(rowErrors, 'bom_snapshot_line', index, ROW_ERROR_TYPES.MISSING_BOM_PROJECT, 'projectId')
    return null
  }
  const snapshotLineId = firstValue(row, ['snapshotLineId']) ||
    `stockprep_snapshot_line_${stableHash(`${input.snapshotBatchId}|${pathKey}`)}`
  const normalized = {
    snapshotLineId,
    snapshotBatchId: input.snapshotBatchId,
    projectId,
    parentDrawingNo: firstValue(row, ['parentDrawingNo', 'parentCode', 'parentFileCode', 'parentFNumber']),
    parentVersion: firstValue(row, ['parentVersion', 'parentRev', 'parentRevision']),
    childDrawingNo: firstValue(row, ['childDrawingNo', 'childCode', 'childFileCode', 'childFNumber', 'componentCode']),
    childVersion: firstValue(row, ['childVersion', 'childRev', 'childRevision', 'sourceVersion']),
    bomLevel: firstNumber(row, ['bomLevel', 'level', 'depth']),
    pathKey,
    designQty: firstNumber(row, ['designQty', 'quantity', 'qty', 'rawQuantity', 'totalQuantity']),
    designUnit: firstValue(row, ['designUnit', 'unit', 'unitName']),
    lineStatus: firstValue(row, ['lineStatus', 'status']) || (row.missingChildBom === true ? 'missing_child_bom' : 'imported'),
    sourceFingerprint: firstValue(row, ['sourceFingerprint']) || stableFingerprint(stableJson(row)),
  }
  return normalized
}

function normalizeBomSnapshot(input, projectIndex, rowErrors) {
  const lines = []
  for (const [index, row] of input.plmBomLines.entries()) {
    const normalized = normalizeBomLine(input, projectIndex, row, index, rowErrors)
    if (normalized) lines.push(normalized)
  }
  const projectId = lines[0] && lines[0].projectId
    ? lines[0].projectId
    : (projectIndex.rows[0] && projectIndex.rows[0].projectId)
  const batches = projectId ? [{
    snapshotBatchId: input.snapshotBatchId,
    projectId,
    sourceSystem: input.sourceSystem,
    sourceBomId: input.sourceBomId,
    snapshotVersion: input.snapshotVersion,
    syncRunId: input.runId,
    snapshotStatus: rowErrors.length ? INTAKE_STATUSES.PARTIAL : INTAKE_STATUSES.READY,
    createdAt: input.startedAt,
    createdBy: input.createdBy,
  }] : []
  return { batches, lines }
}

function normalizeErpMaterial(input, row, index, rowErrors) {
  const erpMaterialCode = firstValue(row, ['erpMaterialCode', 'FNumber', 'materialCode', 'number', 'code'])
  if (!erpMaterialCode) {
    pushRowError(rowErrors, 'erp_material_master', index, ROW_ERROR_TYPES.MISSING_MATERIAL_CODE, 'erpMaterialCode')
    return null
  }
  const erpMaterialInternalId = firstValue(row, ['erpMaterialInternalId', 'FItemID', 'materialInternalId', 'itemId'])
  if (!erpMaterialInternalId) {
    pushRowError(rowErrors, 'erp_material_master', index, ROW_ERROR_TYPES.MISSING_MATERIAL_INTERNAL_ID, 'erpMaterialInternalId')
    return null
  }
  return {
    erpMaterialId: firstValue(row, ['erpMaterialId']) || `stockprep_erp_material_${stableHash(`${input.sourceSystem}|${erpMaterialInternalId}|${erpMaterialCode}`)}`,
    erpMaterialCode,
    erpMaterialInternalId,
    erpMaterialName: firstValue(row, ['erpMaterialName', 'FName', 'name']),
    erpSpec: firstValue(row, ['erpSpec', 'FModel', 'spec', 'specification']),
    baseUnit: firstValue(row, ['baseUnit', 'FBaseUnit', 'baseUnitName']),
    inventoryUnit: firstValue(row, ['inventoryUnit', 'FInventoryUnit', 'stockUnitName']),
    issueUnit: firstValue(row, ['issueUnit', 'FIssueUnit', 'unitName']),
    unitGroup: firstValue(row, ['unitGroup', 'FUnitGroup', 'unitGroupName']),
    materialStatus: firstValue(row, ['materialStatus', 'status']) || 'imported',
    lastSyncedAt: input.startedAt,
  }
}

function normalizeErpMaterials(input, rowErrors) {
  const rows = []
  for (const [index, row] of input.erpMaterials.entries()) {
    const normalized = normalizeErpMaterial(input, row, index, rowErrors)
    if (normalized) rows.push(normalized)
  }
  return rows
}

function summarizeBy(rows, field) {
  const out = {}
  for (const row of rows) {
    const key = optionalString(row && row[field]) || 'unknown'
    out[key] = (out[key] || 0) + 1
  }
  return out
}

function buildValuesFreeEvidence(input, output) {
  return {
    input: {
      projects: input.projects.length,
      plmBomLines: input.plmBomLines.length,
      erpMaterials: input.erpMaterials.length,
      sourceSystemPresent: Boolean(input.sourceSystem),
      snapshotBatchIdPresent: Boolean(input.snapshotBatchId),
      runIdPresent: Boolean(input.runId),
    },
    result: {
      projectRows: output.projects.length,
      bomSnapshotBatches: output.bomSnapshotBatches.length,
      bomSnapshotLines: output.bomSnapshotLines.length,
      erpMaterialRows: output.erpMaterials.length,
      rowErrors: output.rowErrors.length,
      byRowErrorType: summarizeBy(output.rowErrors, 'type'),
      byRowErrorTable: summarizeBy(output.rowErrors, 'table'),
    },
    valuesFree: true,
  }
}

function buildRunRecord(input, output, evidence) {
  return {
    runId: input.runId,
    runType: 'readonly_intake',
    status: output.rowErrors.length ? INTAKE_STATUSES.PARTIAL : (evidence.result.projectRows || evidence.result.bomSnapshotLines || evidence.result.erpMaterialRows ? INTAKE_STATUSES.READY : INTAKE_STATUSES.EMPTY),
    startedAt: input.startedAt,
    finishedAt: input.startedAt,
    inputShape: JSON.stringify(evidence.input),
    resultShape: JSON.stringify(evidence.result),
    createdBy: input.createdBy,
  }
}

function normalizeStockPreparationReadonlyIntake(input = {}) {
  const normalized = normalizeInput(input)
  const rowErrors = []
  const projects = normalizeProjects(normalized, rowErrors)
  const bom = normalizeBomSnapshot(normalized, projects, rowErrors)
  const erpMaterials = normalizeErpMaterials(normalized, rowErrors)
  const output = {
    projects: projects.rows,
    bomSnapshotBatches: bom.batches,
    bomSnapshotLines: bom.lines,
    erpMaterials,
    rowErrors,
  }
  const evidence = buildValuesFreeEvidence(normalized, output)
  return {
    status: rowErrors.length ? INTAKE_STATUSES.PARTIAL : (evidence.result.projectRows || evidence.result.bomSnapshotLines || evidence.result.erpMaterialRows ? INTAKE_STATUSES.READY : INTAKE_STATUSES.EMPTY),
    runRecord: buildRunRecord(normalized, output, evidence),
    ...output,
    evidence,
  }
}

module.exports = {
  INTAKE_STATUSES,
  ROW_ERROR_TYPES,
  StockPreparationReadonlyIntakeError,
  normalizeStockPreparationReadonlyIntake,
  __internals: {
    firstNumber,
    firstValue,
    projectIdFor,
    stableFingerprint,
    stableHash,
    stableJson,
  },
}
