import test from 'node:test'
import assert from 'node:assert/strict'

// T4 (#3751, closeout §5b) companion contract test — the harness itself, no live server needed.
// Same posture as stock-preparation-mvp-postdeploy-smoke.test.mjs: pin the fixture invariants the
// deployed run depends on, the closed values-free projections, and the sanitizing output layer.

import {
  PREP_LINE_ROW_KEYS,
  SUMMARY_HEADER,
  T4_ALLOWED_ERROR_CODES,
  buildExtendedSmokeFixture,
  formatSummaryBlock,
  prepLineRowProjectionValid,
  prepLineRowResolved,
  safeCode,
} from './stock-preparation-prep-line-extended-smoke.mjs'

import {
  ALLOWED_ERROR_CODES,
  AUDIT_ACTIONS,
  ENGINE_MESSAGE_SENTINELS,
  MISSING,
  UNREGISTERED,
  buildOptionSetsFixture,
  leakScan,
} from './stock-preparation-mvp-postdeploy-smoke.mjs'

test('fixture: salted, 3-line BOM with parent refs, and every value-bearing token is a sentinel', () => {
  const fixture = buildExtendedSmokeFixture('t123', 'stockprep-t4')
  assert.equal(fixture.projectId, 'stockprep-t4-t123')
  assert.equal(fixture.snapshotBatchId, 'smoke_t4_batch_t123')
  assert.equal(fixture.expansionResult.rows.length, 3)
  assert.deepEqual(fixture.expansionResult.rowErrors, [])
  // B and C reference A as parent so the mapper resolves parentDrawingNo in-batch.
  assert.equal(fixture.expansionResult.rows[1].parentSourceId, fixture.expansionResult.rows[0].componentSourceId)
  assert.equal(fixture.expansionResult.rows[2].parentSourceId, fixture.expansionResult.rows[0].componentSourceId)
  for (const value of [
    fixture.drawingA, fixture.drawingB, fixture.drawingC,
    fixture.unitPlm, fixture.unitErp,
    fixture.erpItemA, fixture.erpItemB, fixture.erpItemC,
    fixture.materialA.erpMaterialName, fixture.materialB.erpMaterialName, fixture.materialC.erpMaterialName,
    fixture.sourceProjectNo, fixture.projectName,
    ...fixture.expansionResult.rows.map((row) => String(row.rawQuantity)),
  ]) {
    assert.ok(fixture.sentinels.includes(value), `sentinel list must include ${value}`)
  }
  // Different salts must never collide (fresh idempotency key per run).
  const other = buildExtendedSmokeFixture('t124', 'stockprep-t4')
  assert.notEqual(other.snapshotBatchId, fixture.snapshotBatchId)
  assert.notEqual(other.drawingA, fixture.drawingA)
})

test('fixture: THE T4 CACHE-JOIN INVARIANT — each cached material code EQUALS its BOM drawing', () => {
  // This is the whole point of T4 vs the W6 smoke (whose erpCodeA deliberately differs from its
  // drawings): the exact-code auto-match ladder joins line.childDrawingNo to material.erpMaterialCode.
  const fixture = buildExtendedSmokeFixture('t123')
  assert.equal(fixture.materialA.erpMaterialCode, fixture.drawingA)
  assert.equal(fixture.materialB.erpMaterialCode, fixture.drawingB)
  assert.equal(fixture.materialC.erpMaterialCode, fixture.drawingC)
  // Each material carries a FULL ERP identity (confirm-by-mappingId requires both identifiers).
  for (const material of [fixture.materialA, fixture.materialB, fixture.materialC]) {
    assert.ok(material.erpMaterialId.length > 0)
    assert.ok(material.erpMaterialInternalId.length > 0)
    // The generic unit rule matches only when material.issueUnit (when set) equals rule.erpIssueUnit.
    assert.equal(material.issueUnit, fixture.unitErp)
    assert.equal(material.materialStatus, 'active')
  }
  // The three material identities are distinct (no accidental upsert-merge).
  const ids = new Set([fixture.materialA.erpMaterialId, fixture.materialB.erpMaterialId, fixture.materialC.erpMaterialId])
  assert.equal(ids.size, 3)
})

test('fixture: quantity sentinels dodge ISO-timestamp millisecond substrings (>=4 decimals)', () => {
  const fixture = buildExtendedSmokeFixture('t123')
  for (const row of fixture.expansionResult.rows) {
    const decimals = String(row.rawQuantity).split('.')[1] || ''
    assert.ok(decimals.length >= 4, `quantity ${row.rawQuantity} needs >=4 decimals`)
  }
  assert.equal(leakScan({ createdAt: '2026-07-14T09:03:53.512Z' }, fixture.sentinels), true)
  assert.equal(leakScan({ echoed: fixture.drawingB }, fixture.sentinels), false)
  assert.equal(leakScan({ nested: { deep: [fixture.materialC.erpMaterialName] } }, fixture.sentinels), false)
})

test('prep-line rows: closed values-free 10-key projection (shape-lock on the W5 read)', () => {
  assert.equal(PREP_LINE_ROW_KEYS.length, 10)
  const validRow = {
    stockPrepLineId: 'stockprep_line_x', snapshotBatchId: 'smoke_t4_batch_t1', snapshotLineId: 'line_x',
    prepStatus: 'draft', mappingStatus: 'matched', unitStatus: 'converted',
    exceptionCount: 0, hasIssueQty: true, hasErpTarget: true, createdFromRunId: 'stockprep_run_x',
  }
  assert.equal(prepLineRowProjectionValid([validRow]), true)
  assert.equal(prepLineRowProjectionValid([]), true)
  // Optional handles may be ABSENT — still valid.
  const { snapshotBatchId, createdFromRunId, ...bare } = validRow
  assert.equal(prepLineRowProjectionValid([bare]), true)
  // A value-bearing key (a drawing number / quantity / unit column) breaks the shape-lock.
  assert.equal(prepLineRowProjectionValid([{ ...validRow, childDrawingNo: 'LEAK' }]), false)
  assert.equal(prepLineRowProjectionValid([{ ...validRow, issueQtyFinal: 14.0625 }]), false)
  assert.equal(prepLineRowProjectionValid('not-an-array'), false)
  assert.equal(prepLineRowProjectionValid([null]), false)
})

test('prepLineRowResolved pins the fully-resolved summary shape and refuses every degradation', () => {
  const resolved = {
    prepStatus: 'draft', mappingStatus: 'matched', unitStatus: 'converted',
    exceptionCount: 0, hasIssueQty: true, hasErpTarget: true,
  }
  assert.equal(prepLineRowResolved(resolved), true)
  assert.equal(prepLineRowResolved({ ...resolved, prepStatus: 'held' }), false)
  assert.equal(prepLineRowResolved({ ...resolved, mappingStatus: 'pending_confirm' }), false)
  assert.equal(prepLineRowResolved({ ...resolved, unitStatus: 'missing_rule' }), false)
  assert.equal(prepLineRowResolved({ ...resolved, exceptionCount: 1 }), false)
  assert.equal(prepLineRowResolved({ ...resolved, hasIssueQty: false }), false)
  assert.equal(prepLineRowResolved({ ...resolved, hasErpTarget: false }), false)
  assert.equal(prepLineRowResolved(null), false)
})

test('T4 error-code registry: a CLOSED superset of the W6 registry plus the T2 route vocabulary', () => {
  for (const code of ALLOWED_ERROR_CODES) {
    assert.ok(T4_ALLOWED_ERROR_CODES.has(code), `W6 code ${code} must stay registered`)
  }
  for (const code of [
    'STOCK_PREPARATION_ERP_MATERIAL_SYNC_REQUEST_INVALID',
    'ERP_MATERIAL_SYNC_CONFIG_INVALID',
    'ERP_MATERIAL_SYNC_TARGET_NOT_PROVISIONED',
  ]) {
    assert.ok(T4_ALLOWED_ERROR_CODES.has(code), `T2 code ${code} must be registered`)
  }
  // The probes this smoke asserts on:
  assert.equal(safeCode('CONFIRM_MAPPING_TARGET_INCOMPLETE'), 'CONFIRM_MAPPING_TARGET_INCOMPLETE')
  assert.equal(safeCode('STOCK_PREPARATION_ERP_MATERIAL_SYNC_REQUEST_INVALID'), 'STOCK_PREPARATION_ERP_MATERIAL_SYNC_REQUEST_INVALID')
  // POISON: a server echoing a business value into `code` cannot reach the output.
  assert.equal(safeCode('T4DWG-A-t123'), UNREGISTERED)
  assert.equal(safeCode('M-001 材料图号'), UNREGISTERED)
  assert.equal(safeCode(null), MISSING)
})

test('T4 triggers the full closed 8-action audit vocabulary (parity with the W5b design)', () => {
  // The harness asserts >=1 scoped row for EVERY action in AUDIT_ACTIONS; this pins that the shared
  // vocabulary is exactly the 8 the chain (sync/confirm/retire x2, run, resolve x2) can produce.
  assert.deepEqual([...AUDIT_ACTIONS].sort(), [
    'exception_bulk_resolve',
    'exception_resolve',
    'generation_run',
    'mapping_candidates_sync',
    'mapping_confirm',
    'mapping_retire',
    'unit_confirm',
    'unit_retire',
  ])
})

test('option-set fixture carries the enum literals the T4 chain writes', () => {
  const sets = buildOptionSetsFixture()
  const values = (key) => sets[key].map((option) => option.value)
  assert.ok(values('stock_preparation_run_type_v1').includes('erp_material_sync'))
  assert.ok(values('stock_preparation_run_type_v1').includes('prep_generate'))
  assert.ok(values('stock_preparation_unit_scope_type_v1').includes('generic'))
  assert.ok(values('stock_preparation_resolution_action_v1').includes('mapping_confirmed'))
  assert.ok(values('stock_preparation_match_method_v1').includes('exact_code_candidate'))
  assert.ok(values('stock_preparation_match_status_v1').includes('pending_confirm'))
  assert.ok(values('stock_preparation_material_status_v1').includes('inactive'))
})

test('engine-message sentinels ride the self-scan (stored exception texts must never cross)', () => {
  assert.ok(ENGINE_MESSAGE_SENTINELS.includes('Confirmed material mapping does not resolve to an ERP/K3 material master row'))
  assert.equal(
    leakScan({ rows: [{ message: 'BOM line does not have a unique confirmed material mapping' }] }, ENGINE_MESSAGE_SENTINELS),
    false,
  )
})

test('summary block: own header, flat values-free key=value lines', () => {
  const block = formatSummaryBlock({ pass: true, auditActionsCovered: '8/8', externalWrite: false })
  assert.equal(block.split('\n')[0], SUMMARY_HEADER)
  assert.equal(SUMMARY_HEADER, 'STOCK_PREPARATION_PREP_LINE_EXTENDED_SMOKE')
  assert.ok(block.includes('pass=true'))
  assert.ok(block.includes('auditActionsCovered=8/8'))
  assert.ok(block.includes('externalWrite=false'))
})
