'use strict'

// Slice #3760: pure BOM snapshot diff planner. No live PLM/K3/ERP calls,
// no SQL, no write path.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  CHANGE_TYPES,
  DIFF_TYPES,
  BLOCKING_CHANGE_TYPES,
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

  // #5364-follow-up (adjudication design 20260901): fingerprint decomposition — an in-place MATERIAL
  // substitution at unchanged path/parent/version/qty must surface BY NAME, not only as the opaque
  // source_fingerprint_changed. It may ALSO fingerprint-differ; the named token is the point.
  const materialSwap = plan({
    previousLines: [line({ material: 'Q235B' })],
    currentLines: [
      line({ snapshotBatchId: 'batch_current', material: 'Q345R', sourceFingerprint: 'fingerprint_beta' }),
    ],
  })
  assert.equal(materialSwap.diffs.length, 1)
  assert.ok(
    materialSwap.diffs[0].changeTypes.includes(CHANGE_TYPES.MATERIAL_CHANGED),
    'in-place material substitution surfaces as material_changed by name',
  )
  assert.equal(materialSwap.diffs[0].reviewStatus, REVIEW_STATUSES.HELD, 'material substitution blocks')
  assert.equal(materialSwap.evidence.result.byChangeType.material_changed, 1)

  // Component-code swap at the same position (path/parent/version unchanged): childDrawingNo has been
  // persisted on snapshot lines all along but was never compared first-class.
  const componentSwap = plan({
    previousLines: [line()],
    currentLines: [
      line({ snapshotBatchId: 'batch_current', childDrawingNo: 'child_beta', sourceFingerprint: 'fingerprint_beta' }),
    ],
  })
  assert.equal(componentSwap.diffs.length, 1)
  assert.ok(
    componentSwap.diffs[0].changeTypes.includes(CHANGE_TYPES.COMPONENT_CODE_CHANGED),
    'same-position component-code swap surfaces as component_code_changed by name',
  )
  assert.equal(componentSwap.diffs[0].reviewStatus, REVIEW_STATUSES.HELD, 'component-code swap blocks')

  // BACKWARD COMPATIBILITY: historical batches persisted before `material` existed carry NO material
  // field. One-sided material must NOT emit a spurious material_changed — that dimension falls back to
  // today's fingerprint behaviour (which still holds the row).
  const oldLineVsNewLine = plan({
    previousLines: [line()], // pre-change persisted line: no material field
    currentLines: [
      line({ snapshotBatchId: 'batch_current', material: 'Q345R', sourceFingerprint: 'fingerprint_beta' }),
    ],
  })
  assert.equal(oldLineVsNewLine.diffs.length, 1)
  assert.equal(
    oldLineVsNewLine.diffs[0].changeTypes.includes(CHANGE_TYPES.MATERIAL_CHANGED),
    false,
    'old-line (no material) vs new-line (material present) must not fabricate material_changed',
  )
  assert.ok(
    oldLineVsNewLine.diffs[0].changeTypes.includes(CHANGE_TYPES.SOURCE_FINGERPRINT_CHANGED),
    'the fingerprint fallback stays intact for the one-sided-material case',
  )
  const newLineVsOldLine = plan({
    previousLines: [line({ material: 'Q235B' })],
    currentLines: [line({ snapshotBatchId: 'batch_current', sourceFingerprint: 'fingerprint_beta' })],
  })
  assert.equal(
    newLineVsOldLine.diffs[0].changeTypes.includes(CHANGE_TYPES.MATERIAL_CHANGED),
    false,
    'material present only on the PREVIOUS side must not fabricate material_changed either',
  )

  // No false positives: a pure unrelated-metadata edit (only the hashed remainder differs; material and
  // childDrawingNo both present and equal) still yields ONLY source_fingerprint_changed.
  const metadataOnly = plan({
    previousLines: [line({ material: 'Q235B' })],
    currentLines: [
      line({ snapshotBatchId: 'batch_current', material: 'Q235B', sourceFingerprint: 'fingerprint_beta' }),
    ],
  })
  assert.equal(metadataOnly.diffs.length, 1)
  assert.deepEqual(
    metadataOnly.diffs[0].changeTypes,
    [CHANGE_TYPES.SOURCE_FINGERPRINT_CHANGED],
    'an unrelated metadata edit stays a lone source_fingerprint_changed — the new comparisons add no false positive',
  )

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // BACKWARD COMPATIBILITY for the SEVEN-FIELD pull (parentName / childName / spec /
  // totalQuantity). These land on the snapshot line the way `material` did, and the hazard is the
  // same but larger: on the first refresh after this change EVERY line in the store is one-sided —
  // the previous batch predates the columns and the current batch carries them. If any of the four
  // reached the comparator, an entire BOM would light up as changed and every row would be held for
  // a review of a change that never happened.
  //
  // The rule: the four are PERSISTED and CARRIED, never COMPARED. They are also deliberately NOT in
  // `sourceIdentity` (the mapper hashes the same keys it always did), so the fingerprint of an
  // unchanged row is unchanged too — see the expansion-snapshot-mapper suite for that half.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const SEVEN_FIELD_ADDITIONS = {
    parentName: '筒体组件B',
    childName: '标准封头D',
    spec: 'EHA-DN1200x12',
    totalQuantity: 12,
  }

  // THE headline case: a line persisted before the change vs the very same line re-read after it.
  // Nothing about the source moved, so the fingerprint is equal — and the row must stay UNCHANGED.
  const preChangeVsPostChange = plan({
    previousLines: [line()], // persisted before the four columns existed
    currentLines: [line({ snapshotBatchId: 'batch_current', ...SEVEN_FIELD_ADDITIONS })],
  })
  assert.equal(preChangeVsPostChange.diffs.length, 1)
  assert.equal(
    preChangeVsPostChange.diffs[0].diffType,
    DIFF_TYPES.UNCHANGED,
    'a historical line vs the same line now carrying name/spec/totalQuantity is UNCHANGED — one-sided absence must not fabricate a change',
  )
  assert.deepEqual(preChangeVsPostChange.diffs[0].changeTypes, [], 'and it raises no change type at all')
  assert.equal(preChangeVsPostChange.diffs[0].reviewStatus, REVIEW_STATUSES.READY, 'so nothing is held for review')
  assert.equal(preChangeVsPostChange.valid, true, 'the whole refresh stays applyable')

  // Each field on its own, in BOTH directions (absent-then-present and present-then-absent), so a
  // rollback is as quiet as a roll-forward.
  for (const [fieldId, value] of Object.entries(SEVEN_FIELD_ADDITIONS)) {
    const forward = plan({
      previousLines: [line()],
      currentLines: [line({ snapshotBatchId: 'batch_current', [fieldId]: value })],
    })
    assert.deepEqual(forward.diffs[0].changeTypes, [], `one-sided ${fieldId} (absent -> present) must not raise any change type`)
    assert.equal(forward.diffs[0].diffType, DIFF_TYPES.UNCHANGED)
    const backward = plan({
      previousLines: [line({ [fieldId]: value })],
      currentLines: [line({ snapshotBatchId: 'batch_current' })],
    })
    assert.deepEqual(backward.diffs[0].changeTypes, [], `one-sided ${fieldId} (present -> absent) must not raise any change type`)
    assert.equal(backward.diffs[0].diffType, DIFF_TYPES.UNCHANGED)
  }

  // Not merely "absent on one side": a DIFFERENT value on both sides is still not a change type of
  // its own. These four are carried for the operator and the material matcher, not adjudicated —
  // whatever they reflect is already inside the fingerprint dimensions that ARE compared.
  const bothSidesDiffer = plan({
    previousLines: [line({ ...SEVEN_FIELD_ADDITIONS })],
    currentLines: [
      line({
        snapshotBatchId: 'batch_current',
        parentName: '筒体组件B(改)',
        childName: '标准封头D(改)',
        spec: 'EHA-DN1200x14',
        totalQuantity: 14,
        sourceFingerprint: 'fingerprint_beta',
      }),
    ],
  })
  assert.deepEqual(
    bothSidesDiffer.diffs[0].changeTypes,
    [CHANGE_TYPES.SOURCE_FINGERPRINT_CHANGED],
    'the four carried fields add NO named change type — the vocabulary is unchanged by this PR',
  )

  // And they do not disturb the tokens that DO fire: a real material substitution on lines that also
  // carry the four still reports exactly what it reported before.
  const substitutionWithNewFields = plan({
    previousLines: [line({ material: 'Q235B', ...SEVEN_FIELD_ADDITIONS })],
    currentLines: [
      line({
        snapshotBatchId: 'batch_current',
        material: 'Q345R',
        ...SEVEN_FIELD_ADDITIONS,
        sourceFingerprint: 'fingerprint_beta',
      }),
    ],
  })
  assert.deepEqual(
    substitutionWithNewFields.diffs[0].changeTypes,
    materialSwap.diffs[0].changeTypes,
    'carrying the four fields leaves an existing material substitution byte-identical in its verdict',
  )

  // Vocabulary guard: the two decomposed tokens follow the existing naming style and both BLOCK
  // (the design's tier work comes later; today every change type holds the row).
  assert.equal(CHANGE_TYPES.MATERIAL_CHANGED, 'material_changed')
  assert.equal(CHANGE_TYPES.COMPONENT_CODE_CHANGED, 'component_code_changed')
  assert.ok(BLOCKING_CHANGE_TYPES.includes(CHANGE_TYPES.MATERIAL_CHANGED), 'material_changed blocks')
  assert.ok(BLOCKING_CHANGE_TYPES.includes(CHANGE_TYPES.COMPONENT_CODE_CHANGED), 'component_code_changed blocks')

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

  // W3a: BLOCKING_CHANGE_TYPES is the exported single policy source — frozen, and (currently) the
  // FULL change-type vocabulary: every single change type alone yields a HELD row; no changes => ready.
  assert.ok(Object.isFrozen(BLOCKING_CHANGE_TYPES), 'blocking policy array is frozen')
  assert.deepEqual(
    [...BLOCKING_CHANGE_TYPES].sort(),
    Object.values(CHANGE_TYPES).sort(),
    'blocking policy currently blocks on every change type',
  )
  for (const changeType of [CHANGE_TYPES.QUANTITY_CHANGED, CHANGE_TYPES.VERSION_CHANGED, CHANGE_TYPES.UNIT_CHANGED]) {
    const previousLine = { snapshotLineId: 'bp1', childDrawingNo: 'BLK', childVersion: 'V1', pathKey: '/root/BLK', designQty: 1, designUnit: 'pcs' }
    const currentLine = { ...previousLine, snapshotLineId: 'bc1' }
    if (changeType === CHANGE_TYPES.QUANTITY_CHANGED) currentLine.designQty = 2
    if (changeType === CHANGE_TYPES.VERSION_CHANGED) currentLine.childVersion = 'V2'
    if (changeType === CHANGE_TYPES.UNIT_CHANGED) currentLine.designUnit = 'kg'
    const plan = planBomSnapshotDiff({
      previousSnapshotBatchId: 'bb1',
      currentSnapshotBatchId: 'bb2',
      previousLines: [previousLine],
      currentLines: [currentLine],
    })
    const changed = plan.diffs.find((diff) => diff.changeTypes.includes(changeType))
    assert.ok(changed, `a ${changeType} diff row surfaces`)
    assert.equal(changed.reviewStatus, REVIEW_STATUSES.HELD, `${changeType} alone holds the row`)
  }
  const unchangedPlan = planBomSnapshotDiff({
    previousSnapshotBatchId: 'bb1',
    currentSnapshotBatchId: 'bb2',
    previousLines: [{ snapshotLineId: 'u1', childDrawingNo: 'BLK', childVersion: 'V1', pathKey: '/root/BLK', designQty: 1 }],
    currentLines: [{ snapshotLineId: 'u2', childDrawingNo: 'BLK', childVersion: 'V1', pathKey: '/root/BLK', designQty: 1 }],
  })
  assert.ok(unchangedPlan.diffs.every((diff) => diff.reviewStatus === REVIEW_STATUSES.READY), 'no change types => ready')

  console.log('stock-preparation-snapshot-diff.test.cjs OK')
}

main()
