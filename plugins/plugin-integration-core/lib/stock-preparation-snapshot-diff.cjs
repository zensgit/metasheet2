'use strict'

const crypto = require('node:crypto')

const DIFF_TYPES = Object.freeze({
  ADDED: 'added',
  REMOVED: 'removed',
  CHANGED: 'changed',
  UNCHANGED: 'unchanged',
  HELD: 'held',
})

const CHANGE_TYPES = Object.freeze({
  ADDED: 'added',
  REMOVED: 'removed',
  QUANTITY_CHANGED: 'quantity_changed',
  UNIT_CHANGED: 'unit_changed',
  VERSION_CHANGED: 'version_changed',
  PATH_CHANGED: 'path_changed',
  PARENT_CHANGED: 'parent_changed',
  SOURCE_FINGERPRINT_CHANGED: 'source_fingerprint_changed',
  INVALID_QTY: 'invalid_qty',
  MISSING_CHILD_BOM: 'missing_child_bom',
  DUPLICATE_PATH_KEY: 'duplicate_path_key',
  MISSING_PATH_KEY: 'missing_path_key',
})

const REVIEW_STATUSES = Object.freeze({
  READY: 'ready',
  HELD: 'held',
})

const BLOCKING_CHANGE_TYPES = Object.freeze([
  CHANGE_TYPES.ADDED,
  CHANGE_TYPES.REMOVED,
  CHANGE_TYPES.QUANTITY_CHANGED,
  CHANGE_TYPES.UNIT_CHANGED,
  CHANGE_TYPES.VERSION_CHANGED,
  CHANGE_TYPES.PATH_CHANGED,
  CHANGE_TYPES.PARENT_CHANGED,
  CHANGE_TYPES.SOURCE_FINGERPRINT_CHANGED,
  CHANGE_TYPES.INVALID_QTY,
  CHANGE_TYPES.MISSING_CHILD_BOM,
  CHANGE_TYPES.DUPLICATE_PATH_KEY,
  CHANGE_TYPES.MISSING_PATH_KEY,
])

class StockPreparationSnapshotDiffError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'StockPreparationSnapshotDiffError'
    this.details = details
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requiredString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new StockPreparationSnapshotDiffError(`${field} is required`, { field })
  }
  return normalized
}

function asArray(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new StockPreparationSnapshotDiffError(`${field} must be an array`, { field })
  }
  return value
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}

function stableDiffId(previousSnapshotBatchId, currentSnapshotBatchId, key) {
  return `stockprep_diff_${stableHash(`${previousSnapshotBatchId}|${currentSnapshotBatchId}|${key}`)}`
}

function stableFingerprint(value) {
  return `sha16:${stableHash(value)}`
}

function numberOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function normalizedComparable(value) {
  if (value === undefined) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }
  return value
}

function sameText(left, right) {
  const a = optionalString(left)
  const b = optionalString(right)
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return a.toLowerCase() === b.toLowerCase()
}

function sameValue(left, right) {
  return normalizedComparable(left) === normalizedComparable(right)
}

function quantityChanged(previous, current) {
  const left = numberOrNull(previous && previous.designQty)
  const right = numberOrNull(current && current.designQty)
  if (left === null && right === null) return false
  return left !== right
}

function currentHasInvalidQty(current) {
  const qty = numberOrNull(current && current.designQty)
  return qty === null || qty <= 0
}

function currentHasMissingChildBom(current) {
  return current && (current.missingChildBom === true || current.lineStatus === CHANGE_TYPES.MISSING_CHILD_BOM)
}

function snapshotPathKey(row) {
  return optionalString(row && row.pathKey)
}

function snapshotLineId(row) {
  return optionalString(row && row.snapshotLineId)
}

function identityKey(row) {
  const childDrawingNo = optionalString(row && row.childDrawingNo)
  const childVersion = optionalString(row && row.childVersion) || ''
  if (!childDrawingNo) return null
  return `${childDrawingNo.toLowerCase()}|${childVersion.toLowerCase()}`
}

function normalizeRows(rows, field) {
  return asArray(rows, field).map((row, index) => {
    if (!isPlainObject(row)) {
      throw new StockPreparationSnapshotDiffError(`${field}[${index}] must be an object`, { field: `${field}[${index}]` })
    }
    return { ...row }
  })
}

function groupBy(rows, picker) {
  const keyed = new Map()
  const missing = []
  for (const row of rows) {
    const key = picker(row)
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

function singletons(grouped) {
  const out = new Map()
  for (const [key, rows] of grouped.entries()) {
    if (rows.length === 1) out.set(key, rows[0])
  }
  return out
}

function duplicateKeys(grouped) {
  return Array.from(grouped.entries()).filter(([, rows]) => rows.length > 1)
}

function increment(out, key) {
  out[key] = (out[key] || 0) + 1
}

function compareMatchedRows(previous, current) {
  const changeTypes = []
  if (quantityChanged(previous, current)) changeTypes.push(CHANGE_TYPES.QUANTITY_CHANGED)
  if (!sameText(previous.designUnit, current.designUnit)) changeTypes.push(CHANGE_TYPES.UNIT_CHANGED)
  if (!sameText(previous.childVersion, current.childVersion)) changeTypes.push(CHANGE_TYPES.VERSION_CHANGED)
  if (!sameText(previous.pathKey, current.pathKey)) changeTypes.push(CHANGE_TYPES.PATH_CHANGED)
  if (!sameText(previous.parentDrawingNo, current.parentDrawingNo) || !sameText(previous.parentVersion, current.parentVersion)) {
    changeTypes.push(CHANGE_TYPES.PARENT_CHANGED)
  }
  if (!sameValue(previous.sourceFingerprint, current.sourceFingerprint)) {
    changeTypes.push(CHANGE_TYPES.SOURCE_FINGERPRINT_CHANGED)
  }
  if (currentHasInvalidQty(current)) changeTypes.push(CHANGE_TYPES.INVALID_QTY)
  if (currentHasMissingChildBom(current)) changeTypes.push(CHANGE_TYPES.MISSING_CHILD_BOM)
  return Array.from(new Set(changeTypes))
}

function reviewStatusForChangeTypes(changeTypes) {
  return changeTypes.some((changeType) => BLOCKING_CHANGE_TYPES.includes(changeType))
    ? REVIEW_STATUSES.HELD
    : REVIEW_STATUSES.READY
}

function makeDiff({
  previousSnapshotBatchId,
  currentSnapshotBatchId,
  key,
  diffType,
  previousLine,
  currentLine,
  changeTypes,
  reason,
  rowCount,
}) {
  const uniqueChangeTypes = Array.from(new Set(changeTypes))
  const reviewStatus = reviewStatusForChangeTypes(uniqueChangeTypes)
  return {
    diffId: stableDiffId(previousSnapshotBatchId, currentSnapshotBatchId, key),
    diffType,
    reviewStatus,
    changeTypes: uniqueChangeTypes,
    previousSnapshotLineId: snapshotLineId(previousLine),
    currentSnapshotLineId: snapshotLineId(currentLine),
    keyFingerprint: stableFingerprint(key),
    previousPathKeyFingerprint: previousLine && snapshotPathKey(previousLine) ? stableFingerprint(snapshotPathKey(previousLine)) : undefined,
    currentPathKeyFingerprint: currentLine && snapshotPathKey(currentLine) ? stableFingerprint(snapshotPathKey(currentLine)) : undefined,
    reason,
    rowCount,
  }
}

function addMissingKeyDiffs({
  diffs,
  rows,
  previousSnapshotBatchId,
  currentSnapshotBatchId,
  side,
}) {
  for (const [index, row] of rows.entries()) {
    diffs.push(makeDiff({
      previousSnapshotBatchId,
      currentSnapshotBatchId,
      key: `${side}|missing-path-key|${index}|${snapshotLineId(row) || 'unknown'}`,
      diffType: DIFF_TYPES.HELD,
      previousLine: side === 'previous' ? row : undefined,
      currentLine: side === 'current' ? row : undefined,
      changeTypes: [CHANGE_TYPES.MISSING_PATH_KEY],
      reason: `${side}_missing_path_key`,
      rowCount: 1,
    }))
  }
}

function addDuplicateKeyDiffs({
  diffs,
  groups,
  previousSnapshotBatchId,
  currentSnapshotBatchId,
  side,
}) {
  for (const [key, rows] of groups) {
    diffs.push(makeDiff({
      previousSnapshotBatchId,
      currentSnapshotBatchId,
      key: `${side}|duplicate-path-key|${key}`,
      diffType: DIFF_TYPES.HELD,
      changeTypes: [CHANGE_TYPES.DUPLICATE_PATH_KEY],
      reason: `${side}_duplicate_path_key`,
      rowCount: rows.length,
    }))
  }
}

function summarizeBy(rows, field) {
  const out = {}
  for (const row of rows) {
    const key = optionalString(row && row[field]) || 'unknown'
    increment(out, key)
  }
  return out
}

function summarizeChangeTypes(rows) {
  const out = {}
  for (const row of rows) {
    for (const changeType of row.changeTypes || []) increment(out, changeType)
  }
  return out
}

function buildValuesFreeEvidence(input, diffs) {
  return {
    input: {
      previousLines: input.previousLines.length,
      currentLines: input.currentLines.length,
      previousSnapshotBatchIdPresent: Boolean(input.previousSnapshotBatchId),
      currentSnapshotBatchIdPresent: Boolean(input.currentSnapshotBatchId),
    },
    result: {
      diffs: diffs.length,
      byDiffType: summarizeBy(diffs, 'diffType'),
      byReviewStatus: summarizeBy(diffs, 'reviewStatus'),
      byChangeType: summarizeChangeTypes(diffs),
      heldCount: diffs.filter((diff) => diff.reviewStatus === REVIEW_STATUSES.HELD).length,
      readyCount: diffs.filter((diff) => diff.reviewStatus === REVIEW_STATUSES.READY).length,
    },
    valuesFree: true,
  }
}

function normalizeInput(input = {}) {
  return {
    previousSnapshotBatchId: requiredString(input.previousSnapshotBatchId, 'previousSnapshotBatchId'),
    currentSnapshotBatchId: requiredString(input.currentSnapshotBatchId, 'currentSnapshotBatchId'),
    runId: optionalString(input.runId) || null,
    previousLines: normalizeRows(input.previousLines, 'previousLines'),
    currentLines: normalizeRows(input.currentLines, 'currentLines'),
  }
}

function addMatchedByPathDiffs({
  diffs,
  previousByPath,
  currentByPath,
  consumedPrevious,
  consumedCurrent,
  previousSnapshotBatchId,
  currentSnapshotBatchId,
}) {
  for (const [key, previousLine] of previousByPath.entries()) {
    const currentLine = currentByPath.get(key)
    if (!currentLine) continue
    consumedPrevious.add(previousLine)
    consumedCurrent.add(currentLine)
    const changeTypes = compareMatchedRows(previousLine, currentLine)
    diffs.push(makeDiff({
      previousSnapshotBatchId,
      currentSnapshotBatchId,
      key: `path|${key}`,
      diffType: changeTypes.length ? DIFF_TYPES.CHANGED : DIFF_TYPES.UNCHANGED,
      previousLine,
      currentLine,
      changeTypes,
      reason: changeTypes.length ? 'matched_path_changed' : 'matched_path_unchanged',
      rowCount: 1,
    }))
  }
}

function addMovedIdentityDiffs({
  diffs,
  unmatchedPrevious,
  unmatchedCurrent,
  consumedPrevious,
  consumedCurrent,
  previousSnapshotBatchId,
  currentSnapshotBatchId,
}) {
  const previousByIdentity = groupBy(unmatchedPrevious, identityKey)
  const currentByIdentity = groupBy(unmatchedCurrent, identityKey)
  const previousSingles = singletons(previousByIdentity.keyed)
  const currentSingles = singletons(currentByIdentity.keyed)
  for (const [key, previousLine] of previousSingles.entries()) {
    const currentLine = currentSingles.get(key)
    if (!currentLine) continue
    consumedPrevious.add(previousLine)
    consumedCurrent.add(currentLine)
    const changeTypes = compareMatchedRows(previousLine, currentLine)
    if (!changeTypes.includes(CHANGE_TYPES.PATH_CHANGED)) changeTypes.push(CHANGE_TYPES.PATH_CHANGED)
    diffs.push(makeDiff({
      previousSnapshotBatchId,
      currentSnapshotBatchId,
      key: `identity|${key}`,
      diffType: DIFF_TYPES.CHANGED,
      previousLine,
      currentLine,
      changeTypes,
      reason: 'matched_identity_path_or_parent_changed',
      rowCount: 1,
    }))
  }
}

function addAddedRemovedDiffs({
  diffs,
  previousLines,
  currentLines,
  consumedPrevious,
  consumedCurrent,
  previousSnapshotBatchId,
  currentSnapshotBatchId,
}) {
  for (const previousLine of previousLines) {
    if (consumedPrevious.has(previousLine)) continue
    const key = snapshotPathKey(previousLine) || snapshotLineId(previousLine) || stableHash(JSON.stringify(previousLine))
    diffs.push(makeDiff({
      previousSnapshotBatchId,
      currentSnapshotBatchId,
      key: `removed|${key}`,
      diffType: DIFF_TYPES.REMOVED,
      previousLine,
      changeTypes: [CHANGE_TYPES.REMOVED],
      reason: 'missing_from_current_snapshot',
      rowCount: 1,
    }))
  }
  for (const currentLine of currentLines) {
    if (consumedCurrent.has(currentLine)) continue
    const changeTypes = [CHANGE_TYPES.ADDED]
    if (currentHasInvalidQty(currentLine)) changeTypes.push(CHANGE_TYPES.INVALID_QTY)
    if (currentHasMissingChildBom(currentLine)) changeTypes.push(CHANGE_TYPES.MISSING_CHILD_BOM)
    const key = snapshotPathKey(currentLine) || snapshotLineId(currentLine) || stableHash(JSON.stringify(currentLine))
    diffs.push(makeDiff({
      previousSnapshotBatchId,
      currentSnapshotBatchId,
      key: `added|${key}`,
      diffType: DIFF_TYPES.ADDED,
      currentLine,
      changeTypes,
      reason: 'new_in_current_snapshot',
      rowCount: 1,
    }))
  }
}

function planBomSnapshotDiff(input = {}) {
  const normalized = normalizeInput(input)
  const previousPathGroups = groupBy(normalized.previousLines, snapshotPathKey)
  const currentPathGroups = groupBy(normalized.currentLines, snapshotPathKey)
  const duplicatePreviousPathKeys = new Set(duplicateKeys(previousPathGroups.keyed).map(([key]) => key))
  const duplicateCurrentPathKeys = new Set(duplicateKeys(currentPathGroups.keyed).map(([key]) => key))
  const previousSingles = singletons(previousPathGroups.keyed)
  const currentSingles = singletons(currentPathGroups.keyed)
  const diffs = []
  const consumedPrevious = new Set()
  const consumedCurrent = new Set()

  addMissingKeyDiffs({
    diffs,
    rows: previousPathGroups.missing,
    previousSnapshotBatchId: normalized.previousSnapshotBatchId,
    currentSnapshotBatchId: normalized.currentSnapshotBatchId,
    side: 'previous',
  })
  addMissingKeyDiffs({
    diffs,
    rows: currentPathGroups.missing,
    previousSnapshotBatchId: normalized.previousSnapshotBatchId,
    currentSnapshotBatchId: normalized.currentSnapshotBatchId,
    side: 'current',
  })
  addDuplicateKeyDiffs({
    diffs,
    groups: duplicateKeys(previousPathGroups.keyed),
    previousSnapshotBatchId: normalized.previousSnapshotBatchId,
    currentSnapshotBatchId: normalized.currentSnapshotBatchId,
    side: 'previous',
  })
  addDuplicateKeyDiffs({
    diffs,
    groups: duplicateKeys(currentPathGroups.keyed),
    previousSnapshotBatchId: normalized.previousSnapshotBatchId,
    currentSnapshotBatchId: normalized.currentSnapshotBatchId,
    side: 'current',
  })

  for (const key of duplicatePreviousPathKeys) {
    for (const row of previousPathGroups.keyed.get(key) || []) consumedPrevious.add(row)
  }
  for (const key of duplicateCurrentPathKeys) {
    for (const row of currentPathGroups.keyed.get(key) || []) consumedCurrent.add(row)
  }
  for (const row of previousPathGroups.missing) consumedPrevious.add(row)
  for (const row of currentPathGroups.missing) consumedCurrent.add(row)

  addMatchedByPathDiffs({
    diffs,
    previousByPath: previousSingles,
    currentByPath: currentSingles,
    consumedPrevious,
    consumedCurrent,
    previousSnapshotBatchId: normalized.previousSnapshotBatchId,
    currentSnapshotBatchId: normalized.currentSnapshotBatchId,
  })

  addMovedIdentityDiffs({
    diffs,
    unmatchedPrevious: normalized.previousLines.filter((row) => !consumedPrevious.has(row)),
    unmatchedCurrent: normalized.currentLines.filter((row) => !consumedCurrent.has(row)),
    consumedPrevious,
    consumedCurrent,
    previousSnapshotBatchId: normalized.previousSnapshotBatchId,
    currentSnapshotBatchId: normalized.currentSnapshotBatchId,
  })

  addAddedRemovedDiffs({
    diffs,
    previousLines: normalized.previousLines,
    currentLines: normalized.currentLines,
    consumedPrevious,
    consumedCurrent,
    previousSnapshotBatchId: normalized.previousSnapshotBatchId,
    currentSnapshotBatchId: normalized.currentSnapshotBatchId,
  })

  diffs.sort((left, right) => left.diffId.localeCompare(right.diffId))

  return {
    valid: diffs.every((diff) => diff.reviewStatus === REVIEW_STATUSES.READY),
    status: diffs.some((diff) => diff.reviewStatus === REVIEW_STATUSES.HELD) ? 'held' : 'ready',
    runId: normalized.runId,
    previousSnapshotBatchId: normalized.previousSnapshotBatchId,
    currentSnapshotBatchId: normalized.currentSnapshotBatchId,
    diffs,
    evidence: buildValuesFreeEvidence(normalized, diffs),
  }
}

function summarizeSnapshotDiffForEvidence(plan = {}) {
  if (!isPlainObject(plan.evidence)) {
    return buildValuesFreeEvidence({ previousLines: [], currentLines: [] }, [])
  }
  return JSON.parse(JSON.stringify(plan.evidence))
}

module.exports = {
  DIFF_TYPES,
  CHANGE_TYPES,
  // The single held/ready policy source (currently: EVERY change type blocks). Exported so the diff
  // read surface / generation / FE consume THIS array instead of forking the policy.
  BLOCKING_CHANGE_TYPES,
  REVIEW_STATUSES,
  StockPreparationSnapshotDiffError,
  planBomSnapshotDiff,
  summarizeSnapshotDiffForEvidence,
  __internals: {
    compareMatchedRows,
    currentHasInvalidQty,
    currentHasMissingChildBom,
    identityKey,
    quantityChanged,
    snapshotPathKey,
    stableDiffId,
    stableFingerprint,
  },
}
