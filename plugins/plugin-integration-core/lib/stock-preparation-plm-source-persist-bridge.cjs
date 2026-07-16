'use strict'

// T3b-1b: pure, closed-shape bridge from an approved PLM source-run's internal intake to the existing
// sync-run persistence input. It has no runtime flag, route, platform API, or I/O dependency. Business
// rows stay in memory and only the fields accepted by the existing expansion mapper are projected.

const { isPlainObject, optionalString } = require('./stock-preparation-common.cjs')

const ACCEPTED_LINE_STATUSES = Object.freeze(['imported', 'active', 'inactive', 'incomplete'])
const CANONICAL_LINE_STATUSES = Object.freeze(['active', 'inactive', 'incomplete'])
const ACCEPTED_LINE_STATUS_SET = new Set(ACCEPTED_LINE_STATUSES)
const EXPANSION_ROW_KEYS = Object.freeze([
  'snapshotLineId',
  'parentDrawingNo',
  'parentVersion',
  'childDrawingNo',
  'childVersion',
  'bomLevel',
  'pathKey',
  'designQty',
  'designUnit',
  'lineStatus',
  'sourceFingerprint',
])

class StockPreparationPlmSourcePersistBridgeError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationPlmSourcePersistBridgeError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function invalid(field, reason = 'invalid_shape') {
  throw new StockPreparationPlmSourcePersistBridgeError(
    422,
    'STOCK_PREPARATION_PLM_AUTOPERSIST_INTAKE_INVALID',
    'approved PLM source intake cannot be persisted',
    { field, reason },
  )
}

function requiredString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) invalid(field, 'required')
  return normalized
}

function positiveInteger(value, field) {
  const normalized = Number(value)
  if (!Number.isInteger(normalized) || normalized <= 0) invalid(field, 'positive_integer_required')
  return normalized
}

function requiredSingleRow(value, field) {
  if (!Array.isArray(value) || value.length !== 1 || !isPlainObject(value[0])) {
    invalid(field, 'exactly_one_row_required')
  }
  return value[0]
}

function assertSameText(left, right, field) {
  if (requiredString(left, field) !== requiredString(right, field)) invalid(field, 'scope_mismatch')
}

function cleanProjection(source, keys) {
  const out = {}
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null) out[key] = value
  }
  return out
}

function canonicalLineStatus(value) {
  const status = optionalString(value)
  if (!status || !ACCEPTED_LINE_STATUS_SET.has(status)) return null
  return status === 'imported' ? 'active' : status
}

function projectExpansionRows(lines, projectId, snapshotBatchId) {
  let unsupportedRowCount = 0
  const rows = lines.map((line) => {
    if (!isPlainObject(line)) invalid('intake.bomSnapshotLines', 'row_object_required')
    assertSameText(line.projectId, projectId, 'intake.bomSnapshotLines.projectId')
    assertSameText(line.snapshotBatchId, snapshotBatchId, 'intake.bomSnapshotLines.snapshotBatchId')
    requiredString(line.snapshotLineId, 'intake.bomSnapshotLines.snapshotLineId')
    requiredString(line.pathKey, 'intake.bomSnapshotLines.pathKey')
    requiredString(line.sourceFingerprint, 'intake.bomSnapshotLines.sourceFingerprint')
    const lineStatus = canonicalLineStatus(line.lineStatus)
    if (!lineStatus) unsupportedRowCount += 1
    return cleanProjection({ ...line, lineStatus }, EXPANSION_ROW_KEYS)
  })
  if (unsupportedRowCount > 0) {
    throw new StockPreparationPlmSourcePersistBridgeError(
      422,
      'STOCK_PREPARATION_PLM_AUTOPERSIST_LINE_STATUS_UNSUPPORTED',
      'approved PLM source line status is not supported for internal persistence',
      {
        field: 'intake.bomSnapshotLines.lineStatus',
        acceptedInput: ACCEPTED_LINE_STATUSES.slice(),
        canonicalOutput: CANONICAL_LINE_STATUSES.slice(),
        unsupportedRowCount,
      },
    )
  }
  return rows
}

function buildPlmSourcePersistInput({ request, intake } = {}) {
  if (!isPlainObject(request)) invalid('request', 'object_required')
  if (!isPlainObject(intake)) invalid('intake', 'object_required')
  if (!Array.isArray(intake.rowErrors) || intake.rowErrors.length > 0) {
    invalid('intake.rowErrors', 'empty_array_required')
  }

  const project = requiredSingleRow(intake.projects, 'intake.projects')
  const batch = requiredSingleRow(intake.bomSnapshotBatches, 'intake.bomSnapshotBatches')
  if (!Array.isArray(intake.bomSnapshotLines) || intake.bomSnapshotLines.length < 1) {
    invalid('intake.bomSnapshotLines', 'non_empty_array_required')
  }
  if (!isPlainObject(intake.runRecord)) invalid('intake.runRecord', 'object_required')

  const projectId = requiredString(request.projectId, 'request.projectId')
  const sourceProjectNo = requiredString(request.sourceProjectNo, 'request.sourceProjectNo')
  const syncRunId = requiredString(request.syncRunId, 'request.syncRunId')
  const snapshotBatchId = requiredString(request.snapshotBatchId, 'request.snapshotBatchId')
  const snapshotVersion = positiveInteger(request.snapshotVersion, 'request.snapshotVersion')

  assertSameText(project.projectId, projectId, 'intake.projects.projectId')
  assertSameText(project.sourceProjectNo, sourceProjectNo, 'intake.projects.sourceProjectNo')
  assertSameText(project.lastSyncRunId, syncRunId, 'intake.projects.lastSyncRunId')
  assertSameText(batch.projectId, projectId, 'intake.bomSnapshotBatches.projectId')
  assertSameText(batch.snapshotBatchId, snapshotBatchId, 'intake.bomSnapshotBatches.snapshotBatchId')
  assertSameText(batch.syncRunId, syncRunId, 'intake.bomSnapshotBatches.syncRunId')
  assertSameText(intake.runRecord.runId, syncRunId, 'intake.runRecord.runId')
  if (positiveInteger(batch.snapshotVersion, 'intake.bomSnapshotBatches.snapshotVersion') !== snapshotVersion) {
    invalid('intake.bomSnapshotBatches.snapshotVersion', 'scope_mismatch')
  }

  const projectSourceSystem = requiredString(project.sourceSystem, 'intake.projects.sourceSystem')
  assertSameText(batch.sourceSystem, projectSourceSystem, 'intake.bomSnapshotBatches.sourceSystem')
  const expansionResult = projectExpansionRows(intake.bomSnapshotLines, projectId, snapshotBatchId)
  if (expansionResult.length !== intake.bomSnapshotLines.length) {
    invalid('intake.bomSnapshotLines', 'row_count_mismatch')
  }

  const output = {
    projectId,
    sourceProjectNo,
    sourceSystem: projectSourceSystem,
    syncRunId,
    snapshotBatchId,
    snapshotVersion,
    expansionResult,
  }
  const projectName = optionalString(project.projectName)
  if (projectName) output.projectName = projectName
  return output
}

// ── T3b-1c structural config guard (owner P2, #4390 review round). The bridge's closed status vocabulary
// 422s a row whose lineStatus IS 'missing_child_bom' — but a config that maps a target literally named
// `missingChildBom` (boolean marker) TOGETHER WITH an explicit lineStatus (e.g. 'active') slips the marker
// past the status check entirely: intake keeps the explicit status and the marker is silently dropped
// downstream, erasing the missing-child signal. Values cannot catch that combination — the CONFIG must.
// The T3b-1c route MUST call this on the approved config BEFORE any source read / provisioning / persist
// I/O. Pure: inspects only the given config object; throws the dedicated coarse 422 (values-free).
const FORBIDDEN_FIELD_MAP_TARGETS = Object.freeze(['missingChildBom'])
function configShapeInvalid(reason) {
  throw new StockPreparationPlmSourcePersistBridgeError(
    422,
    'STOCK_PREPARATION_PLM_AUTOPERSIST_CONFIG_SHAPE_INVALID',
    'approved source config fieldMap is malformed for the auto-persisting PLM source-run',
    { field: 'fieldMap', reason },
  )
}
function assertPlmAutoPersistSourceConfigSafe(config) {
  // Fail-closed by construction (owner P2, #4391 review): this helper is defined as T3b-1c's independent,
  // pre-I/O safety boundary and must NOT lean on an upstream validator always being correct. A non-array
  // fieldMap, an EMPTY fieldMap, or ANY malformed entry (non-object, or a non-string / empty `target`) is
  // rejected here — before it can reach source read / provisioning / persist.
  // isPlainObject (module convention) rejects arrays-carrying-props and prototype-bearing objects that a
  // bare `typeof x === 'object'` would wave through (owner P3, #4391).
  if (!isPlainObject(config)) configShapeInvalid('config_object_required')
  if (!Array.isArray(config.fieldMap)) configShapeInvalid('fieldmap_array_required')
  if (config.fieldMap.length < 1) configShapeInvalid('fieldmap_empty')
  for (const entry of config.fieldMap) {
    if (!isPlainObject(entry)) configShapeInvalid('entry_object_required')
    if (typeof entry.target !== 'string' || entry.target.length === 0) configShapeInvalid('entry_target_string_required')
    if (FORBIDDEN_FIELD_MAP_TARGETS.includes(entry.target)) {
      throw new StockPreparationPlmSourcePersistBridgeError(
        422,
        'STOCK_PREPARATION_PLM_AUTOPERSIST_CONFIG_TARGET_FORBIDDEN',
        'approved source config maps a forbidden internal marker target for the auto-persisting PLM source-run',
        { target: entry.target, forbiddenTargets: FORBIDDEN_FIELD_MAP_TARGETS.slice() },
      )
    }
  }
}

module.exports = {
  ACCEPTED_LINE_STATUSES,
  CANONICAL_LINE_STATUSES,
  EXPANSION_ROW_KEYS,
  FORBIDDEN_FIELD_MAP_TARGETS,
  StockPreparationPlmSourcePersistBridgeError,
  assertPlmAutoPersistSourceConfigSafe,
  buildPlmSourcePersistInput,
  __internals: {
    canonicalLineStatus,
    projectExpansionRows,
  },
}
