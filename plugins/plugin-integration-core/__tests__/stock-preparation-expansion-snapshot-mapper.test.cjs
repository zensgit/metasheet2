'use strict'

// #3751 stock-prep MVP: pure bridge from PLM BOM expansion output rows -> bom-snapshot-line shape.
// No live PLM/K3/ERP calls, no SQL, no write path — this only reshapes in-memory expansion output.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  LINE_STATUSES,
  MISSING_CHILD_BOM_ROW_ERROR,
  SPEC_KEYS,
  StockPreparationExpansionSnapshotMapperError,
  mapExpansionRowsToSnapshotLines,
  summarizeExpansionSnapshotMappingForEvidence,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-expansion-snapshot-mapper.cjs'))

const {
  planBomSnapshotDiff,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-snapshot-diff.cjs'))

const {
  generateStockPreparationMvp,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-mvp-generation.cjs'))

// An expansion output row exactly as createRow() in stock-preparation-bom-expansion.cjs emits it.
function expansionRow(overrides = {}) {
  return {
    projectNo: 'PRJ-1',
    idempotencyKey: JSON.stringify({ k: Math.random() }),
    componentSourceId: 'obj-child',
    parentSourceId: 'obj-parent',
    path: '["obj-parent","obj-child"]',
    depth: 1,
    componentCode: 'DRW-CHILD',
    componentName: 'child part',
    material: 'steel',
    sourceVersion: 'B',
    rawQuantity: 2,
    totalQuantity: 6,
    active: true,
    ...overrides,
  }
}

function run(name, fn) {
  fn()
  process.stdout.write(`ok - ${name}\n`)
}

// ---------------------------------------------------------------------------
// 1. Field-mapping correctness (expansion vocabulary -> snapshot-line vocabulary)
// ---------------------------------------------------------------------------
run('maps expansion field vocabulary to snapshot-line vocabulary', () => {
  const parent = expansionRow({
    componentSourceId: 'obj-parent',
    parentSourceId: null,
    path: '["obj-parent"]',
    depth: 0,
    componentCode: 'DRW-PARENT',
    sourceVersion: 'A',
    rawQuantity: 1,
    totalQuantity: 1,
  })
  const child = expansionRow()
  const result = mapExpansionRowsToSnapshotLines([parent, child], { snapshotBatchId: 'batch-1' })

  assert.equal(result.status, 'mapped')
  assert.equal(result.lines.length, 2)

  const childLine = result.lines.find((line) => line.childDrawingNo === 'DRW-CHILD')
  assert.ok(childLine, 'child line present')
  // childDrawingNo <- componentCode, childVersion <- sourceVersion (plan.part code/version fields)
  assert.equal(childLine.childDrawingNo, 'DRW-CHILD')
  assert.equal(childLine.childVersion, 'B')
  // bomLevel <- depth, pathKey <- path
  assert.equal(childLine.bomLevel, 1)
  assert.equal(childLine.pathKey, '["obj-parent","obj-child"]')
  // designQty <- rawQuantity (plan quantityField), NOT the totalQuantity rollup
  assert.equal(childLine.designQty, 2)
  // parentDrawingNo/parentVersion resolved via parentSourceId -> parent row join
  assert.equal(childLine.parentDrawingNo, 'DRW-PARENT')
  assert.equal(childLine.parentVersion, 'A')
  // normal line status + required identity fields
  assert.equal(childLine.lineStatus, LINE_STATUSES.ACTIVE)
  assert.equal(childLine.snapshotBatchId, 'batch-1')
  assert.ok(childLine.snapshotLineId, 'snapshotLineId stamped')
  assert.ok(childLine.sourceFingerprint, 'sourceFingerprint stamped')
  // plan declares no unit field -> designUnit absent unless caller supplies a default
  assert.ok(!('designUnit' in childLine))
  // material is persisted as a first-class snapshot-line field (adjudication design 20260901:
  // fingerprint decomposition) — no longer only baked into the sourceFingerprint hash.
  assert.equal(childLine.material, 'steel')
})

run('material is persisted when present and omitted when the expansion row lacks it', () => {
  const withMaterial = mapExpansionRowsToSnapshotLines([expansionRow()], { snapshotBatchId: 'batch-m1' })
  assert.equal(withMaterial.lines[0].material, 'steel')
  const withoutMaterial = mapExpansionRowsToSnapshotLines(
    [expansionRow({ material: null })],
    { snapshotBatchId: 'batch-m2' },
  )
  assert.ok(!('material' in withoutMaterial.lines[0]), 'absent material stays absent (no invented field)')
})

run('persisting material does not change the sourceFingerprint computation (old batches stay comparable)', () => {
  // sourceIdentity already hashed material before it became a persisted field; the fingerprint for the
  // SAME source row must be byte-identical, so pre-change batches do not all fingerprint-differ.
  const a = mapExpansionRowsToSnapshotLines([expansionRow({ idempotencyKey: 'fp-fixed' })], { snapshotBatchId: 'bfp' })
  const b = mapExpansionRowsToSnapshotLines([expansionRow({ idempotencyKey: 'fp-fixed' })], { snapshotBatchId: 'bfp' })
  assert.equal(a.lines[0].sourceFingerprint, b.lines[0].sourceFingerprint)
})

// ---------------------------------------------------------------------------
// THE SEVEN FIELDS A 备料 PULL MUST CARRY (owner spec):
//   父组件图号 / 父组件名称 / 当前组件图号 / 当前组件名称 / 规格 / 材料 / 总数量.
// The audit found only the drawing numbers, versions and per-level quantity reached the PERSISTED
// line: 材料 survived only inside the fingerprint hash, 当前组件名称 was read by the expansion and
// dropped here, 总数量 was traded for the per-level quantity, 父组件名称 was never emitted, and 规格
// was never read from the source at all. Each assertion below fails on the pre-change mapper.
// ---------------------------------------------------------------------------
run('the seven fields all reach the persisted snapshot line', () => {
  const parent = expansionRow({
    componentSourceId: 'obj-parent',
    parentSourceId: null,
    path: '["obj-parent"]',
    depth: 0,
    componentCode: 'DRW-PARENT',
    componentName: 'parent assembly',
    sourceVersion: 'A',
    rawQuantity: 1,
    totalQuantity: 1,
  })
  const child = expansionRow({ spec: 'DN1200x12' })
  const line = mapExpansionRowsToSnapshotLines([parent, child], { snapshotBatchId: 'batch-7' })
    .lines.find((entry) => entry.childDrawingNo === 'DRW-CHILD')

  assert.equal(line.parentDrawingNo, 'DRW-PARENT', '父组件图号')
  // 父组件名称: the expansion emits NO parentName key — the parent is only an OBJ_ID on the child
  // row — so it resolves through the same in-batch parentIndex join the drawing no already used.
  assert.equal(line.parentName, 'parent assembly', '父组件名称')
  assert.equal(line.childDrawingNo, 'DRW-CHILD', '当前组件图号')
  assert.equal(line.childName, 'child part', '当前组件名称')
  assert.equal(line.spec, 'DN1200x12', '规格')
  assert.equal(line.material, 'steel', '材料')
  assert.equal(line.totalQuantity, 6, '总数量 — the rollup, kept alongside the per-level quantity')
  assert.equal(line.designQty, 2, '逐层数量 — resolution unchanged')
})

run('each new field is ABSENT, not empty, when the source did not carry it', () => {
  // A deployment whose read plan declares no specField, whose parent is outside the batch, and
  // whose source has no name: every one of the four must simply not be on the line. `clean()` drops
  // null/undefined, so a downstream reader can tell "not read" from "read as blank".
  const bare = mapExpansionRowsToSnapshotLines(
    [expansionRow({ componentName: null, totalQuantity: null, parentSourceId: null })],
    { snapshotBatchId: 'batch-bare' },
  )
  const line = bare.lines[0]
  for (const fieldId of ['parentName', 'childName', 'spec', 'totalQuantity']) {
    assert.ok(!(fieldId in line), `absent ${fieldId} stays absent (no invented field, no empty string)`)
  }
})

run('the seven fields do NOT change the sourceFingerprint (existing batches are not mass re-diffed)', () => {
  // THE backward-compatibility property. `sourceIdentity` is deliberately UNTOUCHED: childName and
  // spec are persisted but never hashed. Had they been added to the hash, the first refresh after
  // this change would have fingerprint-differed EVERY line of EVERY existing batch and held a whole
  // BOM for review of a change that never happened.
  const PINNED = 'sha16:522bdc6c334323bb'
  const withoutNewFields = mapExpansionRowsToSnapshotLines(
    [expansionRow({ idempotencyKey: 'fp-fixed' })],
    { snapshotBatchId: 'bfp' },
  )
  assert.equal(
    withoutNewFields.lines[0].sourceFingerprint,
    PINNED,
    'the fingerprint of a row with no spec/createTime is the pre-change value, byte for byte',
  )
  const withNewFields = mapExpansionRowsToSnapshotLines(
    [expansionRow({ idempotencyKey: 'fp-fixed', spec: 'DN1200x12', createTime: '2026-08-30T09:15:00' })],
    { snapshotBatchId: 'bfp' },
  )
  assert.equal(
    withNewFields.lines[0].sourceFingerprint,
    PINNED,
    'adding spec/createTime to the SOURCE row must not move the fingerprint either',
  )
  // ...and therefore not the derived snapshotLineId, which seeds off the same identity.
  assert.equal(withNewFields.lines[0].snapshotLineId, withoutNewFields.lines[0].snapshotLineId)
  // createTime is consumed by the batch-identity mint, never persisted onto a line.
  assert.ok(!('createTime' in withNewFields.lines[0]), 'createTime is not a snapshot-line field')
})

run('spec accepts the readonly-intake spelling so both intake paths agree', () => {
  const viaSpecification = mapExpansionRowsToSnapshotLines(
    [expansionRow({ specification: 'DN800' })],
    { snapshotBatchId: 'batch-spec-alias' },
  )
  assert.equal(viaSpecification.lines[0].spec, 'DN800')
  assert.deepEqual([...SPEC_KEYS], ['spec', 'specification'], 'the spec vocabulary is CLOSED')
})

run('designQty prefers rawQuantity over the totalQuantity rollup', () => {
  const result = mapExpansionRowsToSnapshotLines(
    [expansionRow({ rawQuantity: 3, totalQuantity: 99 })],
    { snapshotBatchId: 'batch-q' },
  )
  assert.equal(result.lines[0].designQty, 3)
})

run('designUnit is only stamped from opts.defaultDesignUnit (plan declares no unit field)', () => {
  const withUnit = mapExpansionRowsToSnapshotLines([expansionRow()], {
    snapshotBatchId: 'batch-u',
    defaultDesignUnit: 'piece',
  })
  assert.equal(withUnit.lines[0].designUnit, 'piece')
})

run('mapping is deterministic — identical input yields identical snapshotLineId + fingerprint', () => {
  const a = mapExpansionRowsToSnapshotLines([expansionRow({ idempotencyKey: 'fixed' })], { snapshotBatchId: 'b' })
  const b = mapExpansionRowsToSnapshotLines([expansionRow({ idempotencyKey: 'fixed' })], { snapshotBatchId: 'b' })
  assert.equal(a.lines[0].snapshotLineId, b.lines[0].snapshotLineId)
  assert.equal(a.lines[0].sourceFingerprint, b.lines[0].sourceFingerprint)
})

run('active === false maps to inactive lineStatus', () => {
  const result = mapExpansionRowsToSnapshotLines([expansionRow({ active: false })], { snapshotBatchId: 'b' })
  assert.equal(result.lines[0].lineStatus, LINE_STATUSES.INACTIVE)
})

// ---------------------------------------------------------------------------
// 2. missing_child_bom rowError stamping produces the marker
// ---------------------------------------------------------------------------
run('stamps missing_child_bom rowError into an incomplete line carrying the marker', () => {
  const result = mapExpansionRowsToSnapshotLines(
    { rows: [expansionRow()], rowErrors: [{ type: MISSING_CHILD_BOM_ROW_ERROR, field: 'bom_pid', depth: 2 }] },
    { snapshotBatchId: 'batch-mc' },
  )
  assert.equal(result.status, 'incomplete')
  const stamped = result.lines.find((line) => line.missingChildBom === true)
  assert.ok(stamped, 'a stamped missing-child line exists')
  assert.equal(stamped.lineStatus, LINE_STATUSES.INCOMPLETE)
  assert.equal(stamped.missingChildBom, true)
  assert.ok(stamped.pathKey, 'stamped line has a non-empty synthetic pathKey')
  assert.equal(stamped.snapshotBatchId, 'batch-mc')
  assert.ok(stamped.snapshotLineId)
})

run('rowErrors can be supplied via opts.rowErrors when rows is a bare array', () => {
  const result = mapExpansionRowsToSnapshotLines([expansionRow()], {
    snapshotBatchId: 'batch-o',
    rowErrors: [{ type: MISSING_CHILD_BOM_ROW_ERROR, depth: 1 }],
  })
  assert.equal(result.evidence.result.stampedMissingChildLines, 1)
  assert.equal(result.evidence.result.missingChildBomMarked, 1)
})

run('non missing_child_bom rowErrors are not stamped', () => {
  const result = mapExpansionRowsToSnapshotLines([expansionRow()], {
    snapshotBatchId: 'batch-n',
    rowErrors: [{ type: 'ambiguous_component', depth: 1 }, { type: 'missing_component', depth: 0 }],
  })
  assert.equal(result.status, 'mapped')
  assert.equal(result.lines.length, 1)
  assert.equal(result.evidence.result.stampedMissingChildLines, 0)
})

// ---------------------------------------------------------------------------
// 3. mapped output is accepted by planBomSnapshotDiff + generateStockPreparationMvp
// ---------------------------------------------------------------------------
run('mapped lines feed planBomSnapshotDiff without a shape error and reach the missing_child_bom case', () => {
  const mapped = mapExpansionRowsToSnapshotLines(
    { rows: [expansionRow()], rowErrors: [{ type: MISSING_CHILD_BOM_ROW_ERROR, depth: 2 }] },
    { snapshotBatchId: 'batch-cur' },
  )
  const diff = planBomSnapshotDiff({
    previousSnapshotBatchId: 'batch-prev',
    currentSnapshotBatchId: 'batch-cur',
    previousLines: [],
    currentLines: mapped.lines,
  })
  assert.ok(Array.isArray(diff.diffs))
  // The stamped missing-child line makes the diff engine's missing_child_bom change type reachable.
  assert.ok(
    (diff.evidence.result.byChangeType.missing_child_bom || 0) >= 1,
    'missing_child_bom change type is reachable end-to-end',
  )
})

run('mapped lines feed generateStockPreparationMvp without a shape error and reach the missing_child_bom exception', () => {
  const mapped = mapExpansionRowsToSnapshotLines(
    { rows: [expansionRow()], rowErrors: [{ type: MISSING_CHILD_BOM_ROW_ERROR, depth: 2 }] },
    { snapshotBatchId: 'batch-gen', defaultDesignUnit: 'piece' },
  )
  const generated = generateStockPreparationMvp({
    projectId: 'proj-1',
    snapshotBatchId: 'batch-gen',
    bomSnapshotLines: mapped.lines,
    erpMaterials: [],
    materialMappings: [],
    unitConversionRules: [],
  })
  assert.ok(Array.isArray(generated.lines))
  assert.ok(Array.isArray(generated.exceptions))
  assert.ok(
    (generated.evidence.result.byExceptionType.missing_child_bom || 0) >= 1,
    'missing_child_bom exception is reachable end-to-end',
  )
})

run('mapped happy-path line generates a draft stock-prep line when mapping + unit rule resolve', () => {
  const mapped = mapExpansionRowsToSnapshotLines([expansionRow()], {
    snapshotBatchId: 'batch-happy',
    defaultDesignUnit: 'piece',
  })
  const generated = generateStockPreparationMvp({
    projectId: 'proj-2',
    snapshotBatchId: 'batch-happy',
    bomSnapshotLines: mapped.lines,
    erpMaterials: [
      { erpMaterialId: 'MAT-1', erpMaterialCode: 'M-CODE', erpMaterialInternalId: 'M-INT', issueUnit: 'each' },
    ],
    materialMappings: [
      {
        mappingId: 'MAP-1',
        plmDrawingNo: 'DRW-CHILD',
        versionPolicy: 'drawing_only',
        matchStatus: 'matched',
        erpMaterialCode: 'M-CODE',
        erpMaterialInternalId: 'M-INT',
      },
    ],
    unitConversionRules: [
      { plmUnit: 'piece', erpIssueUnit: 'each', scopeType: 'generic', conversionFactor: 1 },
    ],
  })
  assert.equal(generated.exceptions.length, 0)
  assert.equal(generated.lines.length, 1)
  assert.equal(generated.lines[0].childDrawingNo, 'DRW-CHILD')
  assert.equal(generated.lines[0].prepStatus, 'draft')
})

// ---------------------------------------------------------------------------
// 4. Guards + values-free evidence
// ---------------------------------------------------------------------------
run('requires snapshotBatchId', () => {
  assert.throws(
    () => mapExpansionRowsToSnapshotLines([expansionRow()], {}),
    StockPreparationExpansionSnapshotMapperError,
  )
})

run('rejects a read plan that does not declare part.codeField', () => {
  assert.throws(
    () => mapExpansionRowsToSnapshotLines([expansionRow()], {
      snapshotBatchId: 'b',
      readPlan: { id: 'bad', part: {} },
    }),
    StockPreparationExpansionSnapshotMapperError,
  )
})

run('rejects non-object rows', () => {
  assert.throws(
    () => mapExpansionRowsToSnapshotLines([null], { snapshotBatchId: 'b' }),
    StockPreparationExpansionSnapshotMapperError,
  )
})

run('accepts an empty expansion result and returns a mapped envelope', () => {
  const result = mapExpansionRowsToSnapshotLines([], { snapshotBatchId: 'b' })
  assert.equal(result.status, 'mapped')
  assert.deepEqual(result.lines, [])
})

run('evidence is values-free (counts / field-key names / booleans only)', () => {
  const result = mapExpansionRowsToSnapshotLines(
    { rows: [expansionRow()], rowErrors: [{ type: MISSING_CHILD_BOM_ROW_ERROR, depth: 1 }] },
    { snapshotBatchId: 'batch-ev' },
  )
  const evidence = summarizeExpansionSnapshotMappingForEvidence(result)
  assert.equal(evidence.valuesFree, true)
  assert.equal(evidence.input.expansionRows, 1)
  assert.equal(evidence.input.missingChildBomRowErrors, 1)
  assert.equal(evidence.result.mappedLines, 1)
  assert.equal(evidence.result.stampedMissingChildLines, 1)
  // No raw source values (drawing numbers / project ids / OBJ_IDs) leak into evidence.
  const serialized = JSON.stringify(evidence)
  assert.ok(!serialized.includes('DRW-CHILD'))
  assert.ok(!serialized.includes('obj-child'))
  assert.ok(!serialized.includes('PRJ-1'))
})

process.stdout.write('all stock-preparation-expansion-snapshot-mapper tests passed\n')
