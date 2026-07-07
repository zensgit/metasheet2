'use strict'

// Slice #3754: manual/imported stock-preparation MVP generation.
// Pure service test only: no PLM live sync, no K3/ERP write, no raw SQL.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  EXCEPTION_TYPES,
  MATERIAL_MATCH_STATUSES,
  PREP_STATUSES,
  UNIT_STATUSES,
  VERSION_POLICIES,
  StockPreparationMvpGenerationError,
  generateStockPreparationMvp,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-mvp-generation.cjs'))

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function baseInput(overrides = {}) {
  const input = {
    projectId: 'project_alpha',
    snapshotBatchId: 'batch_alpha',
    runId: 'run_alpha',
    bomSnapshotLines: [
      {
        snapshotLineId: 'snapshot_line_1',
        parentDrawingNo: 'parent_drawing_alpha',
        childDrawingNo: 'child_drawing_alpha',
        childVersion: 'A',
        pathKey: '0/1',
        designQty: 2,
        designUnit: 'piece',
      },
    ],
    erpMaterials: [
      {
        erpMaterialId: 'erp_internal_alpha',
        erpMaterialCode: 'erp_code_alpha',
        erpMaterialInternalId: 'erp_internal_alpha',
        erpMaterialCategory: 'category_alpha',
        issueUnit: 'kg',
      },
    ],
    materialMappings: [
      {
        mappingId: 'mapping_alpha',
        plmDrawingNo: 'child_drawing_alpha',
        plmVersion: 'A',
        erpMaterialCode: 'erp_code_alpha',
        erpMaterialInternalId: 'erp_internal_alpha',
        versionPolicy: VERSION_POLICIES.DRAWING_AND_VERSION,
        matchStatus: MATERIAL_MATCH_STATUSES.MATCHED,
        isActive: true,
      },
    ],
    unitConversionRules: [
      {
        conversionRuleId: 'rule_alpha',
        plmUnit: 'piece',
        erpIssueUnit: 'kg',
        conversionFactor: 1.5,
        lossRate: 0.1,
        roundingRule: 'ceil',
        minimumIssueQty: 1,
        scopeType: 'material',
        scopeKey: 'erp_internal_alpha',
        isActive: true,
      },
    ],
  }
  return {
    ...input,
    ...overrides,
  }
}

function generate(overrides = {}) {
  return generateStockPreparationMvp(baseInput(overrides))
}

function exceptionTypes(result) {
  return result.exceptions.map((entry) => entry.exceptionType)
}

function assertSingleException(result, type) {
  assert.equal(result.lines.length, 0, 'no stock-preparation line is generated')
  assert.equal(result.exceptions.length, 1, 'one blocking exception is generated')
  assert.deepEqual(exceptionTypes(result), [type])
  assert.equal(result.exceptions[0].status, 'open')
  assert.equal(result.exceptions[0].severity, 'blocking')
  assert.match(result.exceptions[0].exceptionId, /^stockprep_exception_/)
}

function main() {
  const happy = generate()
  assert.equal(happy.status, 'ready')
  assert.equal(happy.lines.length, 1)
  assert.equal(happy.exceptions.length, 0)
  const line = happy.lines[0]
  assert.match(line.stockPrepLineId, /^stockprep_line_/)
  assert.equal(line.prepStatus, PREP_STATUSES.DRAFT)
  assert.equal(line.mappingStatus, MATERIAL_MATCH_STATUSES.MATCHED)
  assert.equal(line.unitStatus, UNIT_STATUSES.CONVERTED)
  assert.equal(line.designQty, 2)
  assert.equal(line.designUnit, 'piece')
  assert.equal(line.conversionFactor, 1.5)
  assert.equal(line.lossRate, 0.1)
  assert.ok(Math.abs(line.issueQtyRaw - 3.3) < 0.000001)
  assert.equal(line.issueQtyFinal, 4)
  assert.equal(line.issueUnit, 'kg')
  assert.equal(happy.evidence.valuesFree, true)
  assert.deepEqual(happy.evidence.input, {
    bomSnapshotLines: 1,
    erpMaterials: 1,
    materialMappings: 1,
    unitConversionRules: 1,
    existingStockPreparationLines: 0,
  })
  assert.deepEqual(happy.evidence.result.byPrepStatus, { draft: 1 })
  assert.deepEqual(happy.evidence.result.byMappingStatus, { matched: 1 })
  assert.deepEqual(happy.evidence.result.byUnitStatus, { converted: 1 })
  const evidenceText = JSON.stringify(happy.evidence)
  for (const rawValue of ['project_alpha', 'child_drawing_alpha', 'erp_code_alpha', 'snapshot_line_1']) {
    assert.equal(evidenceText.includes(rawValue), false, `evidence omits row value ${rawValue}`)
  }

  assertSingleException(generate({ materialMappings: [] }), EXCEPTION_TYPES.MISSING_MAPPING)

  assertSingleException(generate({
    materialMappings: [
      ...clone(baseInput().materialMappings),
      {
        mappingId: 'mapping_beta',
        plmDrawingNo: 'child_drawing_alpha',
        plmVersion: 'A',
        erpMaterialCode: 'erp_code_beta',
        erpMaterialInternalId: 'erp_internal_beta',
        versionPolicy: VERSION_POLICIES.DRAWING_AND_VERSION,
        matchStatus: MATERIAL_MATCH_STATUSES.MATCHED,
        isActive: true,
      },
    ],
  }), EXCEPTION_TYPES.MULTI_CANDIDATE)

  assertSingleException(generate({
    materialMappings: [
      {
        ...clone(baseInput().materialMappings[0]),
        plmVersion: 'B',
      },
    ],
  }), EXCEPTION_TYPES.VERSION_CONFLICT)

  assertSingleException(generate({ erpMaterials: [] }), EXCEPTION_TYPES.MISSING_MATERIAL_MASTER)

  assertSingleException(generate({ unitConversionRules: [] }), EXCEPTION_TYPES.UNIT_MISSING)

  assertSingleException(generate({
    unitConversionRules: [
      {
        ...clone(baseInput().unitConversionRules[0]),
        conversionRuleId: 'rule_conflict_1',
        scopeType: 'generic',
        scopeKey: undefined,
      },
      {
        ...clone(baseInput().unitConversionRules[0]),
        conversionRuleId: 'rule_conflict_2',
        scopeType: 'generic',
        scopeKey: undefined,
      },
    ],
  }), EXCEPTION_TYPES.UNIT_CONFLICT)

  assertSingleException(generate({
    bomSnapshotLines: [
      {
        ...clone(baseInput().bomSnapshotLines[0]),
        designQty: 0,
      },
    ],
  }), EXCEPTION_TYPES.INVALID_QTY)

  assertSingleException(generate({
    bomSnapshotLines: [
      {
        ...clone(baseInput().bomSnapshotLines[0]),
        missingChildBom: true,
      },
    ],
  }), EXCEPTION_TYPES.MISSING_CHILD_BOM)

  const first = generate()
  const second = generate({
    runId: 'run_beta',
    existingStockPreparationLines: [
      {
        stockPrepLineId: first.lines[0].stockPrepLineId,
        plannerNote: 'preserve me',
        manualApproval: 'approved',
        issueQtyFinal: 999,
        createdFromRunId: 'old_run',
      },
    ],
    humanFieldIds: ['manualApproval'],
  })
  assert.equal(second.status, 'ready')
  assert.equal(second.lines[0].stockPrepLineId, first.lines[0].stockPrepLineId, 'line id is deterministic')
  assert.equal(second.lines[0].plannerNote, 'preserve me', 'extra human field is preserved')
  assert.equal(second.lines[0].manualApproval, 'approved', 'explicit human field is preserved')
  assert.equal(second.lines[0].issueQtyFinal, 4, 'system quantity is regenerated')
  assert.equal(second.lines[0].createdFromRunId, 'run_beta', 'system run id is regenerated')

  assert.throws(
    () => generateStockPreparationMvp({ projectId: 'project_alpha', snapshotBatchId: 'batch_alpha', bomSnapshotLines: {} }),
    StockPreparationMvpGenerationError,
    'array contract is enforced',
  )

  console.log('stock-preparation-mvp-generation.test.cjs OK')
}

main()
