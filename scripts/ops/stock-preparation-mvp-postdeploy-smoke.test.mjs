import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ALLOWED_ERROR_CODES,
  ALLOWED_FIELD_NAMES,
  ALLOWED_MODES,
  ALLOWED_STATUS_VALUES,
  AUDIT_ACTIONS,
  SMOKE_PHASES,
  computeDiagnosticLocus,
  computeFailureClass,
  DIFF_ROW_KEYS,
  ENGINE_MESSAGE_SENTINELS,
  MISSING,
  UNREGISTERED,
  buildOptionSetsFixture,
  buildSmokeFixture,
  diffRowProjectionValid,
  formatSummaryBlock,
  leakScan,
  newIds,
  projectCounts,
  readyInvariantHolds,
  safeCode,
  safeCount,
  safeField,
  safeHandle,
  safeMode,
  safeStatus,
} from './stock-preparation-mvp-postdeploy-smoke.mjs'

test('buildSmokeFixture: salted, self-contained, and every value-bearing token is a sentinel', () => {
  const fixture = buildSmokeFixture('t123', 'stockprep-smoke')
  assert.equal(fixture.projectId, 'stockprep-smoke-t123')
  assert.equal(fixture.snapshotBatchId, 'smoke_batch_t123')
  assert.equal(fixture.expansionResult.rows.length, 2)
  assert.deepEqual(fixture.expansionResult.rowErrors, [])
  // Row B references row A as parent so the mapper resolves parentDrawingNo in-batch.
  assert.equal(fixture.expansionResult.rows[1].parentSourceId, fixture.expansionResult.rows[0].componentSourceId)
  // #4163 T1: the project-row populator's own inputs are present and salted.
  assert.equal(fixture.sourceProjectNo, 'SMKPRJNO-t123')
  assert.equal(fixture.projectName, 'Smoke Project t123')
  // Both drawing numbers, both paths, both units, both ERP ids, both quantities, and the project-row
  // populator's own inputs (sourceProjectNo/projectName) are all sentinels.
  for (const value of [
    fixture.drawingA, fixture.drawingB, fixture.unitPlm, fixture.unitErp,
    fixture.erpCodeA, fixture.erpItemA, fixture.sourceProjectNo, fixture.projectName,
    String(fixture.expansionResult.rows[0].rawQuantity), String(fixture.expansionResult.rows[1].rawQuantity),
  ]) {
    assert.ok(fixture.sentinels.includes(value), `sentinel list must include ${typeof value}`)
  }
  // Different salts must never collide (fresh idempotency key per run).
  const other = buildSmokeFixture('t124', 'stockprep-smoke')
  assert.notEqual(other.snapshotBatchId, fixture.snapshotBatchId)
  assert.notEqual(other.drawingA, fixture.drawingA)
  assert.notEqual(other.sourceProjectNo, fixture.sourceProjectNo)
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

// ── P2-2 (#4038 review): the sanitizing output layer, exercised with POISONED responses ───────────

test('registries carry the vocabulary the smoke asserts on (registered literals pass through)', () => {
  assert.equal(safeMode('created'), 'created')
  assert.equal(safeMode('skipped_existing'), 'skipped_existing')
  assert.equal(safeStatus('draft'), 'draft')
  assert.equal(safeStatus('blocked'), 'blocked')
  assert.equal(safeCode('EXCEPTION_BULK_MIXED_TYPES'), 'EXCEPTION_BULK_MIXED_TYPES')
  assert.equal(safeCode('SNAPSHOT_DIFF_BASE_NOT_FOUND'), 'SNAPSHOT_DIFF_BASE_NOT_FOUND')
  assert.equal(safeField('confirmedBy'), 'confirmedBy')
  for (const registry of [ALLOWED_ERROR_CODES, ALLOWED_MODES, ALLOWED_STATUS_VALUES, ALLOWED_FIELD_NAMES]) {
    assert.ok(registry.size > 0)
  }
  // Missing values print the missing marker, never an empty passthrough.
  assert.equal(safeMode(undefined), MISSING)
  assert.equal(safeCode(null), MISSING)
  assert.equal(safeStatus(''), MISSING)
})

test('POISON INJECTION: a server echoing business values into mode/code/status/field cannot reach the output', () => {
  // The owner's demonstrated exploitation path: a response carrying a material number / drawing text
  // in fields the old formatter printed verbatim. Every accessor must collapse them to placeholders.
  const poison = {
    mode: 'MAT-001',
    status: 'SECRET-DRAWING-7A',
    code: 'M-001 材料图号',
    field: 'materialNumber',
    handle: 'MAT-001',
  }
  assert.equal(safeMode(poison.mode), UNREGISTERED)
  assert.equal(safeStatus(poison.status), UNREGISTERED)
  assert.equal(safeCode(poison.code), UNREGISTERED)
  assert.equal(safeField(poison.field), UNREGISTERED)
  assert.equal(safeHandle(poison.handle), UNREGISTERED)
  // End-to-end through the summary block: no poison survives into the printed text.
  const block = formatSummaryBlock({
    persistMode: safeMode(poison.mode),
    run1Status: safeStatus(poison.status),
    probeCode: safeCode(poison.code),
    probeField: safeField(poison.field),
    batchHandle: safeHandle(poison.handle),
  })
  for (const value of Object.values(poison)) {
    assert.ok(!block.includes(value), `poison value must not reach the summary block`)
  }
  assert.ok(block.includes(`persistMode=${UNREGISTERED}`))
})

test('POISON INJECTION: count objects are projected key-by-key, never stringified wholesale', () => {
  const poisonedCreated = { batch: 1, lines: 2, run: 1, materialNumber: 'MAT-001', note: '图号 SECRET' }
  const projected = projectCounts(poisonedCreated, ['batch', 'lines', 'run'])
  assert.equal(projected, 'batch:1|lines:2|run:1')
  assert.ok(!projected.includes('MAT-001'))
  assert.ok(!projected.includes('materialNumber'))
  // A known key carrying a poison STRING collapses to -1, never the string.
  assert.equal(projectCounts({ batch: 'MAT-001', lines: 2 }, ['batch', 'lines']), 'batch:-1|lines:2')
  // Non-object fragments never crash or leak.
  assert.equal(projectCounts(null, ['batch']), 'batch:-1')
  assert.equal(projectCounts('MAT-001', ['batch']), 'batch:-1')
})

test('safeCount admits finite numbers only; poison strings and null collapse to -1', () => {
  assert.equal(safeCount(2), 2)
  assert.equal(safeCount('2'), 2)
  assert.equal(safeCount('MAT-001'), -1)
  assert.equal(safeCount(null), -1)
  assert.equal(safeCount(undefined), -1)
  assert.equal(safeCount(true), -1)
  assert.equal(safeCount(Infinity), -1)
})

test('safeHandle admits only platform handle shapes', () => {
  assert.equal(safeHandle('smoke_batch_t1783651754'), 'smoke_batch_t1783651754')
  assert.equal(safeHandle('stockprep_mapping_0123456789abcdef'), 'stockprep_mapping_0123456789abcdef')
  assert.equal(safeHandle('0123456789abcdef'), '0123456789abcdef')
  assert.equal(safeHandle('SMKDWG-A-t123'), UNREGISTERED) // a drawing number is NOT a handle
  assert.equal(safeHandle('MAT-001'), UNREGISTERED)
  assert.equal(safeHandle(''), MISSING)
  assert.equal(safeHandle(42), UNREGISTERED)
})

// ── corrective-5: bounded values-free diagnostic contract ────────────────────────────────────────
test('SMOKE_PHASES is the closed 13-phase ladder with no values-free-forbidden substrings', () => {
  assert.equal(SMOKE_PHASES.length, 13)
  assert.equal(SMOKE_PHASES[0], 'AUTH')
  assert.equal(SMOKE_PHASES[SMOKE_PHASES.length - 1], 'RESPONSE_LEAK_SCAN')
  for (const p of SMOKE_PHASES) {
    assert.ok(/^[A-Z_]+$/.test(p), `phase token ${p} must be an all-caps enum`)
    assert.ok(!/drawing|qty|quantity|unit|material|host|token|password|secret/i.test(p), `phase token ${p} must not contain a forbidden substring`)
  }
})

test('computeDiagnosticLocus: a check-failed early-return localizes to the phase before the stop + the first failed phase', () => {
  const result = {
    summary: { leakScanClean: undefined },
    checks: [
      { name: 'auth ok', ok: true, phase: 'AUTH' },
      { name: 'readiness covers 9', ok: false, phase: 'PROVISIONING' },
      { name: 'options synced', ok: false, phase: 'PROVISIONING' },
    ],
  }
  computeDiagnosticLocus(result, SMOKE_PHASES.indexOf('PROVISIONING')) // stopped in PROVISIONING
  assert.equal(result.summary.lastCompletedPhase, 'AUTH')       // AUTH completed, PROVISIONING did not
  assert.equal(result.summary.firstFailedCheck, 'PROVISIONING') // first failed check's phase — a fixed enum
  assert.equal(result.summary.failedCheckCount, 2)
  assert.equal(result.summary.responseLeakScanStatus, 'NOT_RUN') // never reached the leak-scan phase
})

test('computeDiagnosticLocus: firstFailedCheck is a FIXED enum — an off-vocabulary check.phase becomes UNKNOWN, never a value', () => {
  const result = { summary: {}, checks: [{ name: 'x', ok: false, phase: 'DWG-88472-A material Q235' }] }
  computeDiagnosticLocus(result, 2)
  assert.equal(result.summary.firstFailedCheck, 'UNKNOWN')
  assert.ok(!/DWG-88472|Q235|material/.test(result.summary.firstFailedCheck))
})

test('computeDiagnosticLocus: a full pass reaching the last phase reports RESPONSE_LEAK_SCAN completed + PASS', () => {
  const result = { summary: { leakScanClean: true }, checks: [{ name: 'x', ok: true, phase: 'RESPONSE_LEAK_SCAN' }] }
  computeDiagnosticLocus(result, SMOKE_PHASES.length - 1)
  assert.equal(result.summary.lastCompletedPhase, 'RESPONSE_LEAK_SCAN')
  assert.equal(result.summary.firstFailedCheck, 'NONE')
  assert.equal(result.summary.failedCheckCount, 0)
  assert.equal(result.summary.responseLeakScanStatus, 'PASS')
})

test('computeFailureClass: NONE on pass, FATAL_EXCEPTION on throw, SELF_SCAN_FAILED, else CHECK_FAILED', () => {
  const mk = (over) => { const r = { summary: over }; return r }
  let r = mk({ pass: true }); computeFailureClass(r); assert.equal(r.summary.failureClass, 'NONE')
  r = mk({ pass: false }); computeFailureClass(r, { fatal: true }); assert.equal(r.summary.failureClass, 'FATAL_EXCEPTION')
  r = mk({ pass: false, selfScanClean: false }); computeFailureClass(r); assert.equal(r.summary.failureClass, 'SELF_SCAN_FAILED')
  r = mk({ pass: false, selfScanClean: true }); computeFailureClass(r); assert.equal(r.summary.failureClass, 'CHECK_FAILED')
})
