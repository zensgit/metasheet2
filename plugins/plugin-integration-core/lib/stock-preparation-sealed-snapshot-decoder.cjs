'use strict'

const crypto = require('node:crypto')

const canonicalCodec = require('./sealed-export/canonical-json.cjs')
const {
  normalizeStockPreparationReadonlyIntake,
} = require('./stock-preparation-readonly-intake.cjs')
const {
  __internals: {
    PERSIST_MAX_PLAN_LINES,
  },
} = require('./stock-preparation-sync-run-persist.cjs')

const PAYLOAD_VERSION = 1
const SOURCE_SYSTEM = 'sqlserver.sealed_snapshot.v1'
const MAX_BUSINESS_LINES = PERSIST_MAX_PLAN_LINES
const PAYLOAD_FIELDS = Object.freeze([
  'bomLevel',
  'childDrawingNo',
  'childVersion',
  'designQty',
  'designUnit',
  'lineStatus',
  'parentDrawingNo',
  'parentVersion',
  'pathKey',
  'projectId',
  'projectName',
  'snapshotBatchId',
  'snapshotVersion',
  'sourceBomId',
  'sourceProjectNo',
  'syncRunId',
])
const SCOPE_FIELDS = Object.freeze([
  'projectId',
  'projectName',
  'snapshotBatchId',
  'snapshotVersion',
  'sourceBomId',
  'sourceProjectNo',
  'syncRunId',
])
const LINE_STATUSES = new Set([
  'active',
  'imported',
  'inactive',
  'incomplete',
])
const DECIMAL_TEXT = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/

class StockPreparationSealedSnapshotDecodeError extends Error {
  constructor(code, details = {}) {
    super('sealed snapshot rows do not satisfy the stock-preparation payload contract')
    this.name = 'StockPreparationSealedSnapshotDecodeError'
    this.status = 422
    this.code = code
    this.details = details
  }
}

function refuse(code, field, index, extra = {}) {
  throw new StockPreparationSealedSnapshotDecodeError(code, {
    field,
    index,
    ...extra,
  })
}

function ownValue(object, field, index) {
  const descriptor = Object.getOwnPropertyDescriptor(object, field)
  if (
    !descriptor
    || descriptor.get
    || descriptor.set
    || !descriptor.enumerable
  ) {
    refuse(
      'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
      field,
      index,
    )
  }
  return descriptor.value
}

function exactObject(value, fields, index, field) {
  if (!canonicalCodec.__internals.isStrictPlainObject(value)) {
    refuse(
      'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
      field,
      index,
    )
  }
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (
    actual.length !== expected.length
    || expected.some((key, keyIndex) => key !== actual[keyIndex])
  ) {
    refuse(
      'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
      field,
      index,
    )
  }
  return value
}

function boundedString(value, field, index, maxLength = 512) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maxLength
  ) {
    refuse(
      'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
      field,
      index,
    )
  }
  for (let position = 0; position < value.length; position += 1) {
    const code = value.charCodeAt(position)
    if (code < 0x20 || code === 0x7f) {
      refuse(
        'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
        field,
        index,
      )
    }
  }
  return value
}

function nullableString(value, field, index, maxLength = 512) {
  if (value === null) return null
  return boundedString(value, field, index, maxLength)
}

function positiveInteger(value, field, index) {
  if (!Number.isSafeInteger(value) || value < 1) {
    refuse(
      'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
      field,
      index,
    )
  }
  return value
}

function nonNegativeInteger(value, field, index) {
  if (!Number.isSafeInteger(value) || value < 0) {
    refuse(
      'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
      field,
      index,
    )
  }
  return value
}

function positiveDecimal(value, field, index) {
  if (typeof value !== 'string' || !DECIMAL_TEXT.test(value)) {
    refuse(
      'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
      field,
      index,
    )
  }
  const numeric = Number(value)
  const [integerText, fractionText = ''] = value.split('.')
  const integerPart = BigInt(integerText)
  const maximumSafeInteger = BigInt(Number.MAX_SAFE_INTEGER)
  if (
    !Number.isFinite(numeric)
    || numeric <= 0
    || integerPart > maximumSafeInteger
    || (
      integerPart === maximumSafeInteger
      && /[1-9]/.test(fractionText)
    )
  ) {
    refuse(
      'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
      field,
      index,
    )
  }
  return numeric
}

function sameScope(left, right) {
  return SCOPE_FIELDS.every((field) => left[field] === right[field])
}

function deepFreezeOwned(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value
  }
  for (const key of Object.keys(value)) {
    deepFreezeOwned(value[key])
  }
  return Object.freeze(value)
}

function parsePayload(row, index) {
  exactObject(row, ['payload', 'payloadVersion', 'rowId'], index, 'row')
  const rowId = positiveInteger(ownValue(row, 'rowId', index), 'rowId', index)
  const payloadVersion = positiveInteger(
    ownValue(row, 'payloadVersion', index),
    'payloadVersion',
    index,
  )
  if (payloadVersion !== PAYLOAD_VERSION) {
    refuse(
      'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
      'payloadVersion',
      index,
    )
  }
  const payloadText = ownValue(row, 'payload', index)
  if (
    typeof payloadText !== 'string'
    || !canonicalCodec.isCanonicalJsonText(payloadText)
  ) {
    refuse(
      'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
      'payload',
      index,
    )
  }
  let parsed
  try {
    parsed = JSON.parse(payloadText)
  } catch {
    refuse(
      'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
      'payload',
      index,
    )
  }
  const payload = exactObject(parsed, PAYLOAD_FIELDS, index, 'payload')
  const lineStatus = boundedString(
    ownValue(payload, 'lineStatus', index),
    'lineStatus',
    index,
    32,
  )
  if (!LINE_STATUSES.has(lineStatus)) {
    refuse(
      'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
      'lineStatus',
      index,
    )
  }
  const normalized = Object.freeze({
    bomLevel: nonNegativeInteger(
      ownValue(payload, 'bomLevel', index),
      'bomLevel',
      index,
    ),
    childDrawingNo: boundedString(
      ownValue(payload, 'childDrawingNo', index),
      'childDrawingNo',
      index,
    ),
    childVersion: nullableString(
      ownValue(payload, 'childVersion', index),
      'childVersion',
      index,
    ),
    designQty: positiveDecimal(
      ownValue(payload, 'designQty', index),
      'designQty',
      index,
    ),
    designUnit: boundedString(
      ownValue(payload, 'designUnit', index),
      'designUnit',
      index,
      64,
    ),
    lineStatus,
    parentDrawingNo: nullableString(
      ownValue(payload, 'parentDrawingNo', index),
      'parentDrawingNo',
      index,
    ),
    parentVersion: nullableString(
      ownValue(payload, 'parentVersion', index),
      'parentVersion',
      index,
    ),
    pathKey: boundedString(
      ownValue(payload, 'pathKey', index),
      'pathKey',
      index,
      1024,
    ),
    projectId: boundedString(
      ownValue(payload, 'projectId', index),
      'projectId',
      index,
    ),
    projectName: nullableString(
      ownValue(payload, 'projectName', index),
      'projectName',
      index,
    ),
    snapshotBatchId: boundedString(
      ownValue(payload, 'snapshotBatchId', index),
      'snapshotBatchId',
      index,
    ),
    snapshotVersion: positiveInteger(
      ownValue(payload, 'snapshotVersion', index),
      'snapshotVersion',
      index,
    ),
    sourceBomId: nullableString(
      ownValue(payload, 'sourceBomId', index),
      'sourceBomId',
      index,
    ),
    sourceProjectNo: boundedString(
      ownValue(payload, 'sourceProjectNo', index),
      'sourceProjectNo',
      index,
    ),
    syncRunId: boundedString(
      ownValue(payload, 'syncRunId', index),
      'syncRunId',
      index,
    ),
  })
  return Object.freeze({ payload: normalized, payloadText, rowId })
}

function decodeStockPreparationSealedSnapshotRows(input = {}) {
  exactObject(input, ['actor', 'rows', 'startedAt'], -1, 'input')
  const actor = boundedString(ownValue(input, 'actor', -1), 'actor', -1)
  const startedAt = boundedString(
    ownValue(input, 'startedAt', -1),
    'startedAt',
    -1,
    64,
  )
  let normalizedStartedAt
  try {
    normalizedStartedAt = new Date(startedAt).toISOString()
  } catch {
    normalizedStartedAt = null
  }
  if (normalizedStartedAt !== startedAt) {
    refuse(
      'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
      'startedAt',
      -1,
    )
  }
  const rows = ownValue(input, 'rows', -1)
  if (!Array.isArray(rows) || rows.length < 1) {
    refuse(
      'STOCK_PREPARATION_SEALED_SNAPSHOT_EMPTY',
      'rows',
      -1,
      { observedCount: Array.isArray(rows) ? rows.length : 0 },
    )
  }
  if (!canonicalCodec.__internals.isStrictDenseArray(rows)) {
    refuse(
      'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
      'rows',
      -1,
    )
  }
  if (rows.length > MAX_BUSINESS_LINES) {
    refuse(
      'STOCK_PREPARATION_SEALED_SNAPSHOT_BUDGET_EXCEEDED',
      'rows',
      -1,
      {
        observedCount: rows.length,
        permittedCount: MAX_BUSINESS_LINES,
      },
    )
  }

  const ownedRows = []
  for (let index = 0; index < rows.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(rows, String(index))
    const owned = descriptor
      ? canonicalCodec.tryFreezeCanonical(descriptor.value)
      : Object.freeze({ ok: false })
    if (!owned.ok) {
      refuse(
        'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
        'rows',
        index,
      )
    }
    ownedRows.push(owned.value)
  }
  Object.freeze(ownedRows)

  const decoded = []
  const rowIds = new Set()
  const pathKeys = new Set()
  let scope = null
  for (let index = 0; index < ownedRows.length; index += 1) {
    const current = parsePayload(ownedRows[index], index)
    if (rowIds.has(current.rowId) || pathKeys.has(current.payload.pathKey)) {
      refuse(
        'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
        rowIds.has(current.rowId) ? 'rowId' : 'pathKey',
        index,
      )
    }
    rowIds.add(current.rowId)
    pathKeys.add(current.payload.pathKey)
    if (scope === null) {
      scope = current.payload
    } else if (!sameScope(scope, current.payload)) {
      refuse(
        'STOCK_PREPARATION_SEALED_SNAPSHOT_SCOPE_MISMATCH',
        'payload',
        index,
      )
    }
    decoded.push(current)
  }

  const lines = decoded.map(({ payload, payloadText, rowId }) => ({
    bomLevel: payload.bomLevel,
    childDrawingNo: payload.childDrawingNo,
    childVersion: payload.childVersion,
    designQty: payload.designQty,
    designUnit: payload.designUnit,
    lineStatus: payload.lineStatus,
    parentDrawingNo: payload.parentDrawingNo,
    parentVersion: payload.parentVersion,
    pathKey: payload.pathKey,
    projectId: payload.projectId,
    snapshotLineId: `sealed_snapshot_line_${rowId}`,
    sourceFingerprint: `sha256:${crypto
      .createHash('sha256')
      .update(payloadText)
      .digest('hex')}`,
  }))
  const intake = normalizeStockPreparationReadonlyIntake({
    sourceSystem: SOURCE_SYSTEM,
    runId: scope.syncRunId,
    startedAt,
    createdBy: actor,
    snapshotBatchId: scope.snapshotBatchId,
    snapshotVersion: scope.snapshotVersion,
    sourceBomId: scope.sourceBomId,
    projects: [{
      projectId: scope.projectId,
      projectName: scope.projectName,
      sourceProjectNo: scope.sourceProjectNo,
      sourceSystem: SOURCE_SYSTEM,
    }],
    plmBomLines: lines,
  })
  if (
    intake.status !== 'ready'
    || intake.rowErrors.length !== 0
    || intake.bomSnapshotLines.length !== ownedRows.length
    || intake.projects.length !== 1
    || intake.bomSnapshotBatches.length !== 1
  ) {
    refuse(
      'STOCK_PREPARATION_SEALED_SNAPSHOT_INTAKE_INVALID',
      'intake',
      -1,
      {
        observedCount: intake.bomSnapshotLines.length,
        permittedCount: ownedRows.length,
      },
    )
  }
  return deepFreezeOwned({
    intake,
    request: {
      projectId: scope.projectId,
      snapshotBatchId: scope.snapshotBatchId,
      snapshotVersion: scope.snapshotVersion,
      sourceProjectNo: scope.sourceProjectNo,
      syncRunId: scope.syncRunId,
    },
    evidence: {
      inputRows: ownedRows.length,
      decodedRows: intake.bomSnapshotLines.length,
      payloadVersion: PAYLOAD_VERSION,
      sourceSystem: SOURCE_SYSTEM,
      valuesFree: true,
    },
  })
}

module.exports = Object.freeze({
  MAX_BUSINESS_LINES,
  PAYLOAD_FIELDS,
  PAYLOAD_VERSION,
  SOURCE_SYSTEM,
  StockPreparationSealedSnapshotDecodeError,
  decodeStockPreparationSealedSnapshotRows,
})
