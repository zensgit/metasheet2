'use strict'

// Slice #3763: pure readonly intake contract. It normalizes already-read or
// imported PLM/K3/ERP rows into MVP table shapes; it never connects outward.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  INTAKE_STATUSES,
  ROW_ERROR_TYPES,
  StockPreparationReadonlyIntakeError,
  normalizeStockPreparationReadonlyIntake,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-readonly-intake.cjs'))

function baseInput(overrides = {}) {
  return {
    sourceSystem: 'readonly_source_alpha',
    runId: 'run_readonly_alpha',
    startedAt: '2026-07-07T03:30:00.000Z',
    snapshotBatchId: 'snapshot_batch_alpha',
    snapshotVersion: 2,
    sourceBomId: 'source_bom_alpha',
    projects: [
      {
        sourceProjectNo: 'project_no_alpha',
        projectName: 'project_name_alpha',
        owner: 'owner_alpha',
      },
    ],
    plmBomLines: [
      {
        pathKey: 'root/parent_alpha/child_alpha',
        parentDrawingNo: 'parent_alpha',
        parentVersion: 'A',
        childDrawingNo: 'child_alpha',
        childVersion: 'B',
        bomLevel: 1,
        designQty: '2',
        designUnit: 'piece',
        sourceFingerprint: 'source_fingerprint_alpha',
      },
    ],
    erpMaterials: [
      {
        FNumber: 'erp_code_alpha',
        FItemID: 'erp_internal_alpha',
        FName: 'erp_name_alpha',
        FModel: 'erp_spec_alpha',
        FBaseUnit: 'piece',
        FInventoryUnit: 'piece',
        FIssueUnit: 'kg',
      },
    ],
    ...overrides,
  }
}

function main() {
  const result = normalizeStockPreparationReadonlyIntake(baseInput())
  assert.equal(result.status, INTAKE_STATUSES.READY)
  assert.equal(result.projects.length, 1)
  assert.equal(result.bomSnapshotBatches.length, 1)
  assert.equal(result.bomSnapshotLines.length, 1)
  assert.equal(result.erpMaterials.length, 1)
  assert.equal(result.rowErrors.length, 0)
  assert.equal(result.projects[0].sourceProjectNo, 'project_no_alpha')
  assert.match(result.projects[0].projectId, /^stockprep_project_/)
  assert.equal(result.bomSnapshotBatches[0].snapshotBatchId, 'snapshot_batch_alpha')
  assert.equal(result.bomSnapshotBatches[0].snapshotVersion, 2)
  assert.equal(result.bomSnapshotLines[0].snapshotBatchId, 'snapshot_batch_alpha')
  assert.match(result.bomSnapshotLines[0].snapshotLineId, /^stockprep_snapshot_line_/)
  assert.equal(result.bomSnapshotLines[0].designQty, 2)
  assert.equal(result.erpMaterials[0].erpMaterialCode, 'erp_code_alpha')
  assert.equal(result.erpMaterials[0].erpMaterialInternalId, 'erp_internal_alpha')
  assert.match(result.erpMaterials[0].erpMaterialId, /^stockprep_erp_material_/)
  assert.equal(result.runRecord.runType, 'readonly_intake')
  assert.equal(result.runRecord.status, INTAKE_STATUSES.READY)
  assert.deepEqual(result.evidence.result.byRowErrorType, {})

  const repeat = normalizeStockPreparationReadonlyIntake(baseInput())
  assert.equal(repeat.projects[0].projectId, result.projects[0].projectId, 'project id is deterministic')
  assert.equal(repeat.bomSnapshotLines[0].snapshotLineId, result.bomSnapshotLines[0].snapshotLineId, 'snapshot line id is deterministic')
  assert.equal(repeat.erpMaterials[0].erpMaterialId, result.erpMaterials[0].erpMaterialId, 'material id is deterministic')

  const partial = normalizeStockPreparationReadonlyIntake(baseInput({
    projects: [
      {},
      { sourceProjectNo: 'project_no_valid' },
    ],
    plmBomLines: [
      {},
      { sourceProjectNo: 'project_no_valid', pathKey: 'root/valid_child', childDrawingNo: 'valid_child', designQty: 1 },
    ],
    erpMaterials: [
      { FNumber: 'erp_code_missing_internal' },
      { FItemID: 'erp_internal_missing_code' },
      { FNumber: 'erp_code_valid', FItemID: 'erp_internal_valid' },
    ],
  }))
  assert.equal(partial.status, INTAKE_STATUSES.PARTIAL)
  assert.equal(partial.projects.length, 1, 'valid project still normalizes')
  assert.equal(partial.bomSnapshotLines.length, 1, 'valid BOM row still normalizes')
  assert.equal(partial.erpMaterials.length, 1, 'valid ERP row still normalizes')
  assert.deepEqual(partial.rowErrors.map((error) => error.type).sort(), [
    ROW_ERROR_TYPES.MISSING_BOM_PATH_KEY,
    ROW_ERROR_TYPES.MISSING_MATERIAL_CODE,
    ROW_ERROR_TYPES.MISSING_MATERIAL_INTERNAL_ID,
    ROW_ERROR_TYPES.MISSING_PROJECT_KEY,
  ].sort())
  assert.equal(partial.evidence.result.byRowErrorType.missing_project_key, 1)
  assert.equal(partial.evidence.result.byRowErrorTable.erp_material_master, 2)
  assert.equal(partial.runRecord.status, INTAKE_STATUSES.PARTIAL)

  const noProjectForBom = normalizeStockPreparationReadonlyIntake(baseInput({
    projects: [],
    plmBomLines: [{ pathKey: 'root/orphan_child', childDrawingNo: 'orphan_child' }],
    erpMaterials: [],
  }))
  assert.equal(noProjectForBom.status, INTAKE_STATUSES.PARTIAL)
  assert.deepEqual(noProjectForBom.rowErrors.map((error) => error.type), [ROW_ERROR_TYPES.MISSING_BOM_PROJECT])

  const evidenceText = JSON.stringify(result.evidence)
  for (const rawValue of [
    'project_no_alpha',
    'project_name_alpha',
    'root/parent_alpha/child_alpha',
    'child_alpha',
    'erp_code_alpha',
    'erp_internal_alpha',
    'source_fingerprint_alpha',
  ]) {
    assert.equal(evidenceText.includes(rawValue), false, `evidence omits row value ${rawValue}`)
  }
  assert.equal(JSON.stringify(result.runRecord).includes('project_no_alpha'), false, 'run record shapes are values-free')

  assert.throws(
    () => normalizeStockPreparationReadonlyIntake({ sourceSystem: 'x', projects: {} }),
    StockPreparationReadonlyIntakeError,
    'array contract is enforced',
  )
  assert.throws(
    () => normalizeStockPreparationReadonlyIntake({ sourceSystem: 'x', startedAt: 'not-a-date' }),
    StockPreparationReadonlyIntakeError,
    'time contract is enforced',
  )

  console.log('stock-preparation-readonly-intake.test.cjs OK')
}

main()
