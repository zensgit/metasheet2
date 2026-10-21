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

const {
  mapExpansionRowsToSnapshotLines,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-expansion-snapshot-mapper.cjs'))

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

// ---------------------------------------------------------------------------
// THE OPERATOR STOPS HAND-TYPING THE PLM SIDE.
//
// `plmNameOf` / `plmSpecOf` have ALWAYS read `childName` / `spec` off a snapshot line — the
// matcher was wired for name+spec matching from the start. What it never had was DATA: the mapper
// dropped the component name and never read 规格 at all, so every persisted line reached this
// module as a bare drawing number, NAME_SPEC could not fire, and the operator hand-typed
// plmMaterialName / plmSpec into the mapping form.
//
// So the fix for the mapping form is not new wiring — it is the seven-field pull. This builds the
// line through the SHIPPED mapper rather than hand-writing one, which is what makes it a witness:
// on the pre-change mapper the line has no childName and no spec and both assertions fail.
// ---------------------------------------------------------------------------
function mappingFormPrefillsFromThePulledLine() {
  const expansionRow = {
    projectNo: 'PRJ-1',
    componentSourceId: 'obj-child',
    parentSourceId: null,
    path: '["obj-child"]',
    depth: 0,
    componentCode: 'NO-ERP-CODE', // deliberately NOT an ERP material code: only name+spec can match
    componentName: '标准封头D',
    material: 'S30408',
    spec: 'EHA-DN1200x12',
    sourceVersion: 'A',
    rawQuantity: 1,
    totalQuantity: 1,
    active: true,
  }
  const pulledLine = mapExpansionRowsToSnapshotLines([expansionRow], { snapshotBatchId: 'batch_prefill' }).lines[0]
  assert.equal(pulledLine.childName, '标准封头D', 'control: the pulled line carries 当前组件名称')
  assert.equal(pulledLine.spec, 'EHA-DN1200x12', 'control: the pulled line carries 规格')
  assert.equal(pulledLine.plmMaterialName, undefined, 'control: nobody hand-typed the PLM side')
  assert.equal(pulledLine.plmSpec, undefined)

  const erp = material({
    erpMaterialCode: 'ERP-9001',
    erpMaterialInternalId: 'ERP-INTERNAL-PREFILL',
    erpMaterialName: '标准封头D',
    erpSpec: 'EHA-DN1200x12',
  })
  const matched = generateMaterialMappingCandidates({
    plmBomLines: [pulledLine],
    erpMaterials: [erp],
    confirmedMappings: [],
  })
  const row = matched.mappingRows[0]
  // (1) auto-matching FIRES on a line the operator did not have to touch.
  assert.equal(row.matchMethod, MATCH_METHODS.NAME_SPEC, 'name+spec auto-match fires on a pulled line')
  assert.equal(row.erpMaterialInternalId, 'ERP-INTERNAL-PREFILL')
  // (2) the mapping row's PLM side is PRE-FILLED from the line — this is the mapping form's
  //     plmMaterialName / plmSpec, which is exactly what the operator used to type by hand.
  assert.equal(row.plmMaterialName, '标准封头D', 'the mapping form\'s PLM name is pre-filled from the pull')
  assert.equal(row.plmSpec, 'EHA-DN1200x12', 'the mapping form\'s PLM spec is pre-filled from the pull')

  // Negative control: the SAME component pulled by a deployment whose read plan declares no spec
  // column and whose source has no name is still a bare drawing number — no auto-match, and the
  // form has nothing to pre-fill. Absence degrades to today's behaviour instead of guessing.
  const bareLine = mapExpansionRowsToSnapshotLines(
    [{ ...expansionRow, componentName: null, spec: undefined }],
    { snapshotBatchId: 'batch_bare' },
  ).lines[0]
  const unmatched = generateMaterialMappingCandidates({
    plmBomLines: [bareLine],
    erpMaterials: [erp],
    confirmedMappings: [],
  })
  assert.equal(unmatched.mappingRows[0].matchMethod, MATCH_METHODS.NONE, 'a bare drawing number still cannot auto-match')
  assert.ok(!unmatched.mappingRows[0].plmMaterialName, 'and the form is left for the operator, not filled with a guess')
  assert.ok(!unmatched.mappingRows[0].plmSpec)

  console.log('  ✓ a pulled line auto-matches by name+spec and pre-fills the mapping form\'s PLM side')
}

function main() {
  mappingFormPrefillsFromThePulledLine()

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

  // OD2 round-1 fail-closed (#4391 doctrine: stored approved rows are not trusted): a stored
  // confirmed row carrying an UNIMPLEMENTED versionPolicy — the reserved category_rule and junk
  // alike, the guard is allowlist-shaped — NEVER auto-matches. The OLD tail heuristic matched it
  // on drawing alone whenever a version was absent; now the line degrades to the visible
  // not_found/missing path, and a version mismatch is NOT reported as version_conflict either.
  for (const unimplementedPolicy of ['category_rule', 'totally_bogus']) {
    const storedRow = {
      mappingId: 'confirmed_mapping_unimplemented',
      plmDrawingNo: 'DRAW-001',
      erpMaterialCode: 'ERP-CODE-HIST',
      erpMaterialInternalId: 'ERP-INTERNAL-HIST',
      versionPolicy: unimplementedPolicy,
      matchStatus: MATCH_STATUSES.MATCHED,
      isActive: true,
    }
    const failClosed = result({
      plmBomLines: [line({ childVersion: undefined })],
      erpMaterials: [],
      confirmedMappings: [storedRow],
    })
    assert.equal(failClosed.mappingRows[0].matchStatus, MATCH_STATUSES.NOT_FOUND, `${unimplementedPolicy} never auto-matches even with versions absent`)
    assert.notEqual(failClosed.mappingRows[0].mappingId, 'confirmed_mapping_unimplemented', `${unimplementedPolicy} stored row is never re-emitted as matched`)
    const mismatch = result({
      erpMaterials: [],
      confirmedMappings: [{ ...storedRow, plmVersion: 'B' }],
    })
    assert.equal(mismatch.mappingRows[0].matchStatus, MATCH_STATUSES.NOT_FOUND, `${unimplementedPolicy} version mismatch is not reported as version_conflict`)
    // Round 2 (guard ordering): a stored matchStatus='version_conflict' must not FORCE the
    // version_conflict path either — the policy guard runs BEFORE the stored-status short-circuit,
    // so the row never participates and the line degrades to the visible missing path.
    const storedConflict = result({
      erpMaterials: [],
      confirmedMappings: [{ ...storedRow, matchStatus: MATCH_STATUSES.VERSION_CONFLICT }],
    })
    assert.equal(storedConflict.mappingRows[0].matchStatus, MATCH_STATUSES.NOT_FOUND, `${unimplementedPolicy} stored version_conflict status degrades to the missing path`)
  }

  // OD2 input boundary (engine backstop; the confirm-writes validator rejects first with 422): a
  // SUPPLIED defaultVersionPolicy outside the implemented set throws with the field NAME only.
  for (const unimplementedPolicy of ['category_rule', 'totally_bogus']) {
    assert.throws(
      () => generateMaterialMappingCandidates({ plmBomLines: [line()], erpMaterials: [material()], defaultVersionPolicy: unimplementedPolicy }),
      (error) => {
        assert.ok(error instanceof StockPreparationMaterialMatchError)
        assert.deepEqual(error.details, { field: 'defaultVersionPolicy' }, 'details carry ONLY the field name')
        assert.equal(error.message.includes(unimplementedPolicy), false, 'error message is values-free')
        return true
      },
      `unimplemented defaultVersionPolicy ${unimplementedPolicy} is refused`,
    )
  }
  for (const implementedPolicy of Object.values(VERSION_POLICIES)) {
    const accepted = result({ defaultVersionPolicy: implementedPolicy })
    assert.equal(accepted.mappingRows[0].versionPolicy, implementedPolicy, `implemented policy ${implementedPolicy} still passes`)
  }

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
