'use strict'

// Slice #3760: pure BOM snapshot diff planner. No live PLM/K3/ERP calls,
// no SQL, no write path.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  CHANGE_TYPES,
  DIFF_TYPES,
  REVIEW_STATUSES,
  StockPreparationSnapshotDiffError,
  planBomSnapshotDiff,
  summarizeSnapshotDiffForEvidence,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-snapshot-diff.cjs'))

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function line(overrides = {}) {
  return {
    snapshotLineId: 'line_alpha',
    snapshotBatchId: 'batch_previous',
    parentDrawingNo: 'parent_alpha',
    parentVersion: 'A',
    childDrawingNo: 'child_alpha',
    childVersion: 'A',
    bomLevel: 1,
    pathKey: 'root/parent_alpha/child_alpha',
    designQty: 2,
    designUnit: 'piece',
    lineStatus: 'active',
    sourceFingerprint: 'fingerprint_alpha',
    ...overrides,
  }
}

function baseInput(overrides = {}) {
  return {
    previousSnapshotBatchId: 'batch_previous',
    currentSnapshotBatchId: 'batch_current',
    runId: 'run_diff',
    previousLines: [line()],
    currentLines: [line({ snapshotBatchId: 'batch_current' })],
    ...overrides,
  }
}

function plan(overrides = {}) {
  return planBomSnapshotDiff(baseInput(overrides))
}

function byType(result, type) {
  return result.diffs.filter((diff) => diff.diffType === type)
}

function assertEvidenceValuesFree(result) {
  const evidenceText = JSON.stringify(summarizeSnapshotDiffForEvidence(result))
  for (const rawValue of [
    'batch_previous',
    'batch_current',
    'line_alpha',
    'parent_alpha',
    'child_alpha',
    'root/parent_alpha/child_alpha',
    'fingerprint_alpha',
  ]) {
    assert.equal(evidenceText.includes(rawValue), false, `evidence omits row value ${rawValue}`)
  }
}

function main() {
  const unchanged = plan()
  assert.equal(unchanged.valid, true)
  assert.equal(unchanged.status, 'ready')
  assert.equal(unchanged.diffs.length, 1)
  assert.equal(unchanged.diffs[0].diffType, DIFF_TYPES.UNCHANGED)
  assert.equal(unchanged.diffs[0].reviewStatus, REVIEW_STATUSES.READY)
  assert.deepEqual(unchanged.diffs[0].changeTypes, [])
  assert.deepEqual(unchanged.evidence.result.byDiffType, { unchanged: 1 })
  assert.deepEqual(unchanged.evidence.result.byReviewStatus, { ready: 1 })
  assertEvidenceValuesFree(unchanged)

  const addedRemoved = plan({
    previousLines: [
      line({ snapshotLineId: 'line_removed', pathKey: 'root/removed', childDrawingNo: 'child_removed' }),
    ],
    currentLines: [
      line({ snapshotLineId: 'line_added', snapshotBatchId: 'batch_current', pathKey: 'root/added', childDrawingNo: 'child_added' }),
    ],
  })
  assert.equal(addedRemoved.valid, false)
  assert.equal(addedRemoved.status, 'held')
  assert.equal(byType(addedRemoved, DIFF_TYPES.ADDED).length, 1)
  assert.equal(byType(addedRemoved, DIFF_TYPES.REMOVED).length, 1)
  assert.equal(addedRemoved.evidence.result.byChangeType.added, 1)
  assert.equal(addedRemoved.evidence.result.byChangeType.removed, 1)
  assert.equal(addedRemoved.evidence.result.heldCount, 2)

  const changed = plan({
    previousLines: [line()],
    currentLines: [
      line({
        snapshotBatchId: 'batch_current',
        designQty: 3,
        designUnit: 'kg',
        childVersion: 'B',
        parentDrawingNo: 'parent_beta',
        sourceFingerprint: 'fingerprint_beta',
      }),
    ],
  })
  assert.equal(changed.valid, false)
  assert.equal(changed.diffs.length, 1)
  assert.equal(changed.diffs[0].diffType, DIFF_TYPES.CHANGED)
  assert.equal(changed.diffs[0].reviewStatus, REVIEW_STATUSES.HELD)
  assert.deepEqual(new Set(changed.diffs[0].changeTypes), new Set([
    CHANGE_TYPES.QUANTITY_CHANGED,
    CHANGE_TYPES.UNIT_CHANGED,
    CHANGE_TYPES.VERSION_CHANGED,
    CHANGE_TYPES.PARENT_CHANGED,
    CHANGE_TYPES.SOURCE_FINGERPRINT_CHANGED,
  ]))

  const moved = plan({
    previousLines: [line({ pathKey: 'root/old_parent/child_alpha', parentDrawingNo: 'old_parent' })],
    currentLines: [
      line({
        snapshotBatchId: 'batch_current',
        pathKey: 'root/new_parent/child_alpha',
        parentDrawingNo: 'new_parent',
      }),
    ],
  })
  assert.equal(moved.diffs.length, 1)
  assert.equal(moved.diffs[0].diffType, DIFF_TYPES.CHANGED)
  assert.ok(moved.diffs[0].changeTypes.includes(CHANGE_TYPES.PATH_CHANGED), 'path move is detected')
  assert.ok(moved.diffs[0].changeTypes.includes(CHANGE_TYPES.PARENT_CHANGED), 'parent move is detected')

  const unresolved = plan({
    currentLines: [
      line({
        snapshotBatchId: 'batch_current',
        designQty: 0,
        missingChildBom: true,
      }),
    ],
  })
  assert.equal(unresolved.valid, false)
  assert.equal(unresolved.diffs.length, 1)
  assert.ok(unresolved.diffs[0].changeTypes.includes(CHANGE_TYPES.INVALID_QTY))
  assert.ok(unresolved.diffs[0].changeTypes.includes(CHANGE_TYPES.MISSING_CHILD_BOM))
  assert.equal(unresolved.evidence.result.byChangeType.invalid_qty, 1)
  assert.equal(unresolved.evidence.result.byChangeType.missing_child_bom, 1)

  const duplicatePath = plan({
    previousLines: [
      line({ snapshotLineId: 'dup_prev_1', pathKey: 'root/dup' }),
      line({ snapshotLineId: 'dup_prev_2', pathKey: 'root/dup' }),
    ],
    currentLines: [
      line({ snapshotBatchId: 'batch_current', snapshotLineId: 'dup_current_1', pathKey: 'root/current_dup' }),
      line({ snapshotBatchId: 'batch_current', snapshotLineId: 'dup_current_2', pathKey: 'root/current_dup' }),
    ],
  })
  assert.equal(duplicatePath.status, 'held')
  assert.equal(duplicatePath.evidence.result.byChangeType.duplicate_path_key, 2)
  assert.equal(duplicatePath.diffs.every((diff) => diff.diffType === DIFF_TYPES.HELD), true)
  assert.equal(duplicatePath.diffs.every((diff) => diff.keyFingerprint.startsWith('sha16:')), true)

  const missingPath = plan({
    previousLines: [line({ pathKey: '' })],
    currentLines: [line({ snapshotBatchId: 'batch_current', pathKey: null })],
  })
  assert.equal(missingPath.status, 'held')
  assert.equal(missingPath.evidence.result.byChangeType.missing_path_key, 2)

  const input = baseInput()
  const before = JSON.stringify(input)
  planBomSnapshotDiff(input)
  assert.equal(JSON.stringify(input), before, 'diff planner does not mutate inputs')

  assert.throws(
    () => planBomSnapshotDiff({ previousSnapshotBatchId: 'batch_previous', currentSnapshotBatchId: 'batch_current', previousLines: {} }),
    StockPreparationSnapshotDiffError,
    'array contract is enforced',
  )

  console.log('stock-preparation-snapshot-diff.test.cjs OK')
}

main()
