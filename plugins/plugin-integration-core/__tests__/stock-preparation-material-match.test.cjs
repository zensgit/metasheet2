'use strict'

// Slice #3765: pure material mapping candidate generation. It proposes
// candidates only; non-historical candidates remain pending confirmation.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  MATCH_METHODS,
  MATCH_STATUSES,
  VERSION_POLICIES,
  StockPreparationMaterialMatchError,
  generateMaterialMappingCandidates,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-material-match.cjs'))

function line(overrides = {}) {
  return {
    snapshotLineId: 'line_alpha',
    childDrawingNo: 'DRAW-001',
    childVersion: 'A',
    plmMaterialName: 'name_alpha',
    plmSpec: 'spec_alpha',
    ...overrides,
  }
}

function material(overrides = {}) {
  return {
    erpMaterialCode: 'DRAW-001',
    erpMaterialInternalId: 'ERP-INTERNAL-001',
    erpMaterialName: 'name_alpha',
    erpSpec: 'spec_alpha',
    isActive: true,
    ...overrides,
  }
}

function result(overrides = {}) {
  return generateMaterialMappingCandidates({
    plmBomLines: [line()],
    erpMaterials: [material()],
    confirmedMappings: [],
    ...overrides,
  })
}

function main() {
  const exact = result()
  assert.equal(exact.status, 'pending_confirmation')
  assert.equal(exact.mappingRows.length, 1)
  assert.equal(exact.mappingRows[0].matchStatus, MATCH_STATUSES.PENDING_CONFIRM)
  assert.equal(exact.mappingRows[0].matchMethod, MATCH_METHODS.EXACT_CODE)
  assert.equal(exact.mappingRows[0].confidence, 0.95)
  assert.equal(exact.mappingRows[0].erpMaterialCode, 'DRAW-001')
  assert.equal(exact.mappingRows[0].erpMaterialInternalId, 'ERP-INTERNAL-001')
  assert.match(exact.mappingRows[0].mappingId, /^stockprep_mapping_/)

  const historical = result({
    erpMaterials: [],
    confirmedMappings: [{
      mappingId: 'confirmed_mapping_alpha',
      plmDrawingNo: 'DRAW-001',
      plmVersion: 'A',
      erpMaterialCode: 'ERP-CODE-HIST',
      erpMaterialInternalId: 'ERP-INTERNAL-HIST',
      versionPolicy: VERSION_POLICIES.DRAWING_AND_VERSION,
      matchStatus: MATCH_STATUSES.MATCHED,
      confirmedBy: 'operator_alpha',
      confirmedAt: '2026-07-07T03:35:00.000Z',
      isActive: true,
    }],
  })
  assert.equal(historical.status, 'matched')
  assert.equal(historical.mappingRows[0].mappingId, 'confirmed_mapping_alpha')
  assert.equal(historical.mappingRows[0].matchStatus, MATCH_STATUSES.MATCHED)
  assert.equal(historical.mappingRows[0].matchMethod, MATCH_METHODS.HISTORICAL_CONFIRMED)
  assert.equal(historical.mappingRows[0].confidence, 1)
  assert.equal(historical.mappingRows[0].confirmedBy, 'operator_alpha')

  const normalized = result({
    plmBomLines: [line({ childDrawingNo: '9030216' })],
    erpMaterials: [material({ erpMaterialCode: '9.03.02.16', erpMaterialInternalId: 'ERP-INTERNAL-NORM' })],
  })
  assert.equal(normalized.mappingRows[0].matchStatus, MATCH_STATUSES.PENDING_CONFIRM)
  assert.equal(normalized.mappingRows[0].matchMethod, MATCH_METHODS.NORMALIZED_CODE)

  const byNameSpec = result({
    plmBomLines: [line({ childDrawingNo: 'NO-CODE', plmMaterialName: 'same_name', plmSpec: 'same_spec' })],
    erpMaterials: [material({ erpMaterialCode: 'ERP-OTHER', erpMaterialInternalId: 'ERP-INTERNAL-NAME', erpMaterialName: 'same_name', erpSpec: 'same_spec' })],
  })
  assert.equal(byNameSpec.mappingRows[0].matchStatus, MATCH_STATUSES.PENDING_CONFIRM)
  assert.equal(byNameSpec.mappingRows[0].matchMethod, MATCH_METHODS.NAME_SPEC)

  const multi = result({
    erpMaterials: [
      material({ erpMaterialCode: 'DRAW-001', erpMaterialInternalId: 'ERP-INTERNAL-A' }),
      material({ erpMaterialCode: 'DRAW-001', erpMaterialInternalId: 'ERP-INTERNAL-B' }),
    ],
  })
  assert.equal(multi.mappingRows.length, 1)
  assert.equal(multi.mappingRows[0].matchStatus, MATCH_STATUSES.MULTI_CANDIDATE)
  assert.equal(multi.mappingRows[0].erpMaterialCode, undefined, 'multi-candidate does not pick a winner')

  const missing = result({ erpMaterials: [] })
  assert.equal(missing.mappingRows[0].matchStatus, MATCH_STATUSES.NOT_FOUND)
  assert.equal(missing.mappingRows[0].matchMethod, MATCH_METHODS.NONE)

  const versionConflict = result({
    erpMaterials: [material()],
    confirmedMappings: [{
      plmDrawingNo: 'DRAW-001',
      plmVersion: 'B',
      erpMaterialCode: 'ERP-CODE-B',
      erpMaterialInternalId: 'ERP-INTERNAL-B',
      versionPolicy: VERSION_POLICIES.DRAWING_AND_VERSION,
      matchStatus: MATCH_STATUSES.MATCHED,
      isActive: true,
    }],
  })
  assert.equal(versionConflict.mappingRows[0].matchStatus, MATCH_STATUSES.VERSION_CONFLICT)
  assert.equal(versionConflict.mappingRows[0].erpMaterialCode, undefined, 'version conflict does not pick ERP row')

  const duplicateLines = result({
    plmBomLines: [line(), line({ snapshotLineId: 'line_beta' })],
  })
  assert.equal(duplicateLines.mappingRows.length, 1, 'same drawing/version is matched once')

  const evidenceText = JSON.stringify(exact.evidence)
  for (const rawValue of ['DRAW-001', 'ERP-INTERNAL-001', 'name_alpha', 'spec_alpha']) {
    assert.equal(evidenceText.includes(rawValue), false, `evidence omits row value ${rawValue}`)
  }
  assert.deepEqual(exact.evidence.result.byMatchStatus, { pending_confirm: 1 })
  assert.deepEqual(exact.evidence.result.byMatchMethod, { exact_code_candidate: 1 })

  assert.throws(
    () => generateMaterialMappingCandidates({ plmBomLines: {}, erpMaterials: [] }),
    StockPreparationMaterialMatchError,
    'array contract is enforced',
  )

  console.log('stock-preparation-material-match.test.cjs OK')
}

main()
