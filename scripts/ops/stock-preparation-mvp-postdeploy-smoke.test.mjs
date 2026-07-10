import test from 'node:test'
import assert from 'node:assert/strict'

import {
  AUDIT_ACTIONS,
  DIFF_ROW_KEYS,
  ENGINE_MESSAGE_SENTINELS,
  buildOptionSetsFixture,
  buildSmokeFixture,
  diffRowProjectionValid,
  formatSummaryBlock,
  leakScan,
  newIds,
  readyInvariantHolds,
} from './stock-preparation-mvp-postdeploy-smoke.mjs'

test('buildSmokeFixture: salted, self-contained, and every value-bearing token is a sentinel', () => {
  const fixture = buildSmokeFixture('t123', 'stockprep-smoke')
  assert.equal(fixture.projectId, 'stockprep-smoke-t123')
  assert.equal(fixture.snapshotBatchId, 'smoke_batch_t123')
  assert.equal(fixture.expansionResult.rows.length, 2)
  assert.deepEqual(fixture.expansionResult.rowErrors, [])
  // Row B references row A as parent so the mapper resolves parentDrawingNo in-batch.
  assert.equal(fixture.expansionResult.rows[1].parentSourceId, fixture.expansionResult.rows[0].componentSourceId)
  // Both drawing numbers, both paths, both units, both ERP ids, and both quantities are sentinels.
  for (const value of [
    fixture.drawingA, fixture.drawingB, fixture.unitPlm, fixture.unitErp,
    fixture.erpCodeA, fixture.erpItemA,
    String(fixture.expansionResult.rows[0].rawQuantity), String(fixture.expansionResult.rows[1].rawQuantity),
  ]) {
    assert.ok(fixture.sentinels.includes(value), `sentinel list must include ${typeof value}`)
  }
  // Different salts must never collide (fresh idempotency key per run).
  const other = buildSmokeFixture('t124', 'stockprep-smoke')
  assert.notEqual(other.snapshotBatchId, fixture.snapshotBatchId)
  assert.notEqual(other.drawingA, fixture.drawingA)
})

test('fixture quantity sentinels cannot collide with ISO-timestamp millisecond substrings', () => {
  const fixture = buildSmokeFixture('t123')
  for (const row of fixture.expansionResult.rows) {
    const text = String(row.rawQuantity)
    const decimals = text.split('.')[1] || ''
    assert.ok(decimals.length >= 4, `quantity ${typeof row.rawQuantity} needs >=4 decimals to dodge "SS.mmmZ" substrings`)
  }
  // Regression shape for the false-positive class: a 3-digit-millis timestamp must scan clean.
  assert.equal(leakScan({ createdAt: '2026-07-09T21:03:53.512Z' }, fixture.sentinels), true)
})

test('buildOptionSetsFixture: contract-only source keys carrying the enum literals the chain writes', () => {
  const sets = buildOptionSetsFixture()
  for (const [key, options] of Object.entries(sets)) {
    assert.match(key, /^stock_preparation_[a-z_]+_v1$/, `unexpected source key shape: ${key}`)
    assert.ok(Array.isArray(options) && options.length >= 2)
    for (const option of options) {
      assert.deepEqual(Object.keys(option), ['value'])
      assert.match(option.value, /^[a-z_]+$/)
    }
  }
  const values = (key) => sets[key].map((option) => option.value)
  // Spot-check the literals the smoke's own writes depend on (select-vocabulary coverage).
  assert.ok(values('stock_preparation_snapshot_status_v1').includes('draft'))
  assert.ok(values('stock_preparation_run_type_v1').includes('plm_sync'))
  assert.ok(values('stock_preparation_run_type_v1').includes('prep_generate'))
  assert.ok(values('stock_preparation_match_method_v1').includes('manual_confirm'))
  assert.ok(values('stock_preparation_version_policy_v1').includes('drawing_only'))
  assert.ok(values('stock_preparation_exception_severity_v1').includes('blocking'))
  assert.ok(values('stock_preparation_resolution_action_v1').includes('manual_hold'))
  assert.ok(values('stock_preparation_resolution_action_v1').includes('accepted_change'))
})

test('leakScan flags embedded sentinels and ignores empty ones', () => {
  assert.equal(leakScan({ a: 'clean evidence' }, ['SMKDWG-A-t1', '', undefined]), true)
  assert.equal(leakScan({ a: 'contains SMKDWG-A-t1 value' }, ['SMKDWG-A-t1']), false)
  assert.equal(leakScan({ nested: { deep: ['smkut1'] } }, ['smkut1']), false)
})

test('engine-message sentinels are the stored exception texts, never allowed to cross', () => {
  assert.ok(ENGINE_MESSAGE_SENTINELS.length >= 6)
  assert.equal(leakScan({ rows: [{ exceptionType: 'missing_mapping', resolved: false }] }, ENGINE_MESSAGE_SENTINELS), true)
  assert.equal(
    leakScan({ rows: [{ message: 'BOM line does not have a unique confirmed material mapping' }] }, ENGINE_MESSAGE_SENTINELS),
    false,
  )
})

test('diffRowProjectionValid enforces the closed 11-key projection', () => {
  assert.equal(DIFF_ROW_KEYS.length, 11)
  const validRow = {
    diffId: 'diff_x', diffType: 'added', reviewStatus: 'held', changeTypes: ['added'],
    rowCount: 1, currentSnapshotLineId: 'line_x', keyFingerprint: 'abc123',
  }
  assert.equal(diffRowProjectionValid([validRow]), true)
  assert.equal(diffRowProjectionValid([]), true)
  assert.equal(diffRowProjectionValid([{ ...validRow, childDrawingNo: 'LEAK' }]), false)
  assert.equal(diffRowProjectionValid('not-an-array'), false)
})

test('readyInvariantHolds pins ready === (engine ready AND zero unresolved blocking)', () => {
  assert.equal(readyInvariantHolds({ ready: true, status: 'ready', unresolvedBlockingExceptionCount: 0 }), true)
  assert.equal(readyInvariantHolds({ ready: false, status: 'ready', unresolvedBlockingExceptionCount: 1 }), true)
  assert.equal(readyInvariantHolds({ ready: false, status: 'blocked', unresolvedBlockingExceptionCount: 0 }), true)
  // The frontend-manufactured-readiness shapes the invariant must refuse:
  assert.equal(readyInvariantHolds({ ready: true, status: 'blocked', unresolvedBlockingExceptionCount: 0 }), false)
  assert.equal(readyInvariantHolds({ ready: true, status: 'ready', unresolvedBlockingExceptionCount: 2 }), false)
  assert.equal(readyInvariantHolds({ ready: 'yes', status: 'ready', unresolvedBlockingExceptionCount: 0 }), false)
  assert.equal(readyInvariantHolds(null), false)
})

test('newIds attributes only fresh non-empty ids (candidate cleanup capture)', () => {
  assert.deepEqual(newIds(['a', 'b'], ['a', 'b', 'c', 'd']), ['c', 'd'])
  assert.deepEqual(newIds([], ['a']), ['a'])
  assert.deepEqual(newIds(['a'], ['a']), [])
  assert.deepEqual(newIds(['a'], ['a', '', null]), [])
})

test('AUDIT_ACTIONS is the closed 8-action W5b vocabulary', () => {
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

test('formatSummaryBlock is a flat values-free key=value block', () => {
  const block = formatSummaryBlock({ pass: true, auditActionsCovered: '8/8' })
  assert.equal(block.split('\n')[0], 'STOCK_PREPARATION_MVP_POSTDEPLOY_SMOKE')
  assert.ok(block.includes('pass=true'))
  assert.ok(block.includes('auditActionsCovered=8/8'))
})
