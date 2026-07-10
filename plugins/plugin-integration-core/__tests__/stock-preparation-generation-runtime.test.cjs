'use strict'

// #3751 stock-prep MVP — GENERATION run + EXCEPTION resolution (W4 write half). Covered:
//   (a) 403-before-IO — permission denied => ZERO provisioning + ZERO records calls, all three ops;
//   (b) generation happy path — draft prep lines + blocking exceptions + run record persisted, every
//       write grounded to template field ids, exception rows STRUCTURALLY carry no resolution trio;
//   (c) THE INVARIANT — ready is NEVER true while an unresolved blocking exception exists (engine
//       'ready' + a pre-existing unresolved blocking row => ready:false), and resolving it flips a
//       re-run to ready:true; frontend can never manufacture readiness;
//   (d) re-run semantics — prep lines UPSERT (patch, not duplicate); existing exception ids skipped
//       (a human-resolved row is never recreated or clobbered); run record create-only;
//   (e) resolve — patch EXACTLY {status,resolutionAction,resolvedBy,resolvedAt}; vocabulary gate;
//       replay => skipped_already_resolved with zero patches; 404 unknown;
//   (f) bulk resolve — SAME-REASON gate refuses mixed exceptionTypes BEFORE any patch; bound 200;
//       mixed already-resolved rows counted as skipped; missing id => 404 before any patch;
//   (g) staging/business split + batch gates (explicit unknown/other-project/incomplete);
//   (h) values-free — planted secrets (drawing no / unit / exception message) never reach evidence
//       or thrown error details (persisted rows legitimately carry them).

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  runStockPreparationGeneration,
  resolveStockPreparationException,
  bulkResolveStockPreparationExceptions,
  StockPreparationGenerationRuntimeError,
  RESOLUTION_ACTIONS,
  __internals: { PREP_LINE_FIELD_IDS, EXCEPTION_FIELD_IDS, EXCEPTION_HUMAN_FIELD_IDS, MAX_BULK_RESOLVE },
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-generation-runtime.cjs'))
const {
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-templates.cjs'))

function objectIdByRole(role) {
  return STOCK_PREPARATION_MVP_TABLE_TEMPLATES.find((template) => template.role === role).objectId
}
const SHEET = {
  batch: `sheet_${objectIdByRole('bom_snapshot_batch')}`,
  line: `sheet_${objectIdByRole('bom_snapshot_line')}`,
  run: `sheet_${objectIdByRole('run_record')}`,
  material: `sheet_${objectIdByRole('erp_material_master')}`,
  mapping: `sheet_${objectIdByRole('material_mapping')}`,
  rule: `sheet_${objectIdByRole('unit_conversion_rule')}`,
  prepLine: `sheet_${objectIdByRole('stock_preparation_line')}`,
  exception: `sheet_${objectIdByRole('exception_confirmation')}`,
}

const STAGING_PROJECT_ID = 'tenant_x:integration-core'
const BUSINESS_PROJECT_ID = 'proj_1'
const OPERATOR = 'user_admin_1'
const SECRET = 'SECRET_W4A_7b3d'
const PREP_LINE_FIELD_ID_SET = new Set(PREP_LINE_FIELD_IDS)
const EXCEPTION_FIELD_ID_SET = new Set(EXCEPTION_FIELD_IDS)

let passed = 0
let failed = 0
const failures = []

function run(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
    })
    .catch((error) => {
      failed += 1
      failures.push({ name, error })
      console.error(`FAIL: ${name}`)
      console.error(error && error.stack ? error.stack : error)
    })
}

async function expectError(promise, { status, code }) {
  let caught = null
  try {
    await promise
  } catch (error) {
    caught = error
  }
  assert.ok(caught, 'expected an error')
  assert.ok(caught instanceof StockPreparationGenerationRuntimeError, `expected generation-runtime error, got ${caught && caught.name}: ${caught && caught.message}`)
  assert.equal(caught.status, status)
  assert.equal(caught.code, code)
  return caught
}

function makeRecordsApi() {
  const store = new Map()
  const createCalls = []
  const patchCalls = []
  const queryCalls = []
  let seq = 0
  return {
    createCalls,
    patchCalls,
    queryCalls,
    seed(sheetId, data) {
      const rows = store.get(sheetId) || []
      seq += 1
      const record = { id: `rec_${seq}`, data: { ...data } }
      rows.push(record)
      store.set(sheetId, rows)
      return record
    },
    rowsOf(sheetId) {
      return (store.get(sheetId) || []).map((record) => ({ id: record.id, data: { ...record.data } }))
    },
    async createRecord(input = {}) {
      const { sheetId, data } = input
      createCalls.push({ sheetId, data: { ...data } })
      const rows = store.get(sheetId) || []
      seq += 1
      const record = { id: `rec_${seq}`, data: { ...data } }
      rows.push(record)
      store.set(sheetId, rows)
      return record
    },
    async queryRecords(input = {}) {
      const { sheetId, filters = {}, limit = 500, offset = 0 } = input
      queryCalls.push({ sheetId, filters })
      const rows = (store.get(sheetId) || []).filter((record) =>
        Object.entries(filters).every(([key, value]) => record.data[key] === value))
      return rows.slice(offset, offset + limit).map((record) => ({ id: record.id, data: { ...record.data } }))
    },
    async patchRecord(input = {}) {
      const { sheetId, recordId, changes } = input
      patchCalls.push({ sheetId, recordId, changes: { ...changes } })
      const rows = store.get(sheetId) || []
      const record = rows.find((entry) => entry.id === recordId)
      if (record) Object.assign(record.data, changes)
      return { id: recordId }
    },
  }
}

function makeProvisioning({ stagingProjectId = STAGING_PROJECT_ID } = {}) {
  let findObjectSheetCalls = 0
  return {
    get findObjectSheetCalls() {
      return findObjectSheetCalls
    },
    async findObjectSheet({ projectId, objectId } = {}) {
      findObjectSheetCalls += 1
      if (projectId !== stagingProjectId) return null
      return { id: `sheet_${objectId}` }
    },
  }
}

// COMPLETE batch + confirmed mapping + material + confirmed generic rule => one fully-resolvable
// line (drawing A) and one exception-bound line (drawing B: no mapping => blocking exception).
function seedGenerationFixture(api, { snapshotBatchId = 'batch_g1' } = {}) {
  const syncRunId = `run_${snapshotBatchId}`
  api.seed(SHEET.batch, { snapshotBatchId, projectId: BUSINESS_PROJECT_ID, snapshotVersion: 1, syncRunId })
  api.seed(SHEET.run, { runId: syncRunId, status: 'succeeded' })
  api.seed(SHEET.line, { snapshotLineId: 'g_l1', snapshotBatchId, projectId: BUSINESS_PROJECT_ID, childDrawingNo: `A_${SECRET}`, childVersion: 'V1', designUnit: 'pcs', designQty: 3 })
  api.seed(SHEET.line, { snapshotLineId: 'g_l2', snapshotBatchId, projectId: BUSINESS_PROJECT_ID, childDrawingNo: 'B-200', childVersion: 'V1', designUnit: `u_${SECRET}`, designQty: 2 })
  api.seed(SHEET.mapping, { mappingId: 'map_a', plmDrawingNo: `A_${SECRET}`, plmVersion: 'V1', erpMaterialCode: `A_${SECRET}`, erpMaterialInternalId: 'ITM_A', versionPolicy: 'drawing_and_version', matchStatus: 'matched', isActive: true, confirmedBy: OPERATOR, confirmedAt: 'x' })
  api.seed(SHEET.material, { erpMaterialId: 'erp_a', erpMaterialCode: `A_${SECRET}`, erpMaterialInternalId: 'ITM_A', issueUnit: 'pcs', isActive: true })
  api.seed(SHEET.rule, { conversionRuleId: 'rule_g', plmUnit: 'pcs', erpIssueUnit: 'pcs', conversionFactor: 1, scopeType: 'generic', roundingRule: 'none', requiresConfirmation: true, isActive: true, confirmedBy: OPERATOR, confirmedAt: 'x' })
  return { snapshotBatchId }
}

function baseRunInput(api, provisioning, overrides = {}) {
  return {
    permission: 'admin',
    recordsApi: api,
    provisioning,
    targetProjectId: STAGING_PROJECT_ID,
    projectId: BUSINESS_PROJECT_ID,
    ...overrides,
  }
}

async function main() {
  // ---- (a) 403 before IO ----
  await run('permission denied fails closed before any provisioning or records access (all ops)', async () => {
    for (const op of [
      (api, prov) => runStockPreparationGeneration({ permission: 'write', recordsApi: api, provisioning: prov, targetProjectId: STAGING_PROJECT_ID, projectId: BUSINESS_PROJECT_ID }),
      (api, prov) => resolveStockPreparationException({ permission: 'write', recordsApi: api, provisioning: prov, targetProjectId: STAGING_PROJECT_ID, exceptionId: 'x', resolutionAction: 'manual_hold', resolvedBy: OPERATOR }),
      (api, prov) => bulkResolveStockPreparationExceptions({ permission: 'write', recordsApi: api, provisioning: prov, targetProjectId: STAGING_PROJECT_ID, exceptionIds: ['x'], resolutionAction: 'manual_hold', resolvedBy: OPERATOR }),
    ]) {
      const api = makeRecordsApi()
      const provisioning = makeProvisioning()
      await expectError(op(api, provisioning), { status: 403, code: 'GENERATION_PERMISSION_DENIED' })
      assert.equal(provisioning.findObjectSheetCalls, 0)
      assert.equal(api.createCalls.length + api.patchCalls.length + api.queryCalls.length, 0)
    }
  })

  // ---- (b) generation happy path ----
  await run('generation persists grounded prep lines + blocking exceptions + run record; resolution trio structurally absent', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    seedGenerationFixture(api)
    const result = await runStockPreparationGeneration(baseRunInput(api, provisioning))
    assert.equal(result.snapshotBatchId, 'batch_g1')
    assert.equal(result.status, 'partial', 'one resolvable line + one exception line => partial')
    assert.equal(result.ready, false)
    assert.equal(result.created.lines, 1)
    assert.equal(result.created.exceptions, 1)
    assert.equal(result.created.run, 1)
    for (const call of api.createCalls.filter((entry) => entry.sheetId === SHEET.prepLine)) {
      for (const key of Object.keys(call.data)) {
        assert.ok(PREP_LINE_FIELD_ID_SET.has(key), `prep-line key ${key} must be template-declared`)
      }
      assert.equal(call.data.prepStatus, 'draft')
    }
    for (const call of api.createCalls.filter((entry) => entry.sheetId === SHEET.exception)) {
      for (const key of Object.keys(call.data)) {
        assert.ok(EXCEPTION_FIELD_ID_SET.has(key), `exception key ${key} must be template-declared`)
        assert.ok(!EXCEPTION_HUMAN_FIELD_IDS.includes(key), `generation must never write ${key}`)
      }
      assert.equal(call.data.severity, 'blocking')
      assert.equal(call.data.status, 'open')
    }
    const runWrites = api.createCalls.filter((entry) => entry.sheetId === SHEET.run && entry.data.runType === 'generation')
    assert.equal(runWrites.length, 1)
    assert.ok(!JSON.stringify(result.evidence).includes(SECRET), 'evidence stays values-free')
  })

  // ---- (c) THE INVARIANT ----
  await run('ready is never true while an unresolved blocking exception exists; resolving flips it', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    const { snapshotBatchId } = seedGenerationFixture(api, { snapshotBatchId: 'batch_inv' })
    // Make BOTH lines resolvable: add the missing mapping for drawing B and its material+unit context.
    api.seed(SHEET.mapping, { mappingId: 'map_b', plmDrawingNo: 'B-200', plmVersion: 'V1', erpMaterialCode: 'B-200', erpMaterialInternalId: 'ITM_B', versionPolicy: 'drawing_and_version', matchStatus: 'matched', isActive: true, confirmedBy: OPERATOR, confirmedAt: 'x' })
    // Line B's design unit in the shared fixture is a leaky token with NO confirmed rule — override
    // its snapshot line to 'pcs' so the confirmed generic pcs->pcs rule covers it too.
    const lineRows = api.rowsOf(SHEET.line)
    const lineB = lineRows.find((row) => row.data.snapshotLineId === 'g_l2')
    await api.patchRecord({ sheetId: SHEET.line, recordId: lineB.id, changes: { designUnit: 'pcs' } })
    api.patchCalls.length = 0
    api.seed(SHEET.material, { erpMaterialId: 'erp_b', erpMaterialCode: 'B-200', erpMaterialInternalId: 'ITM_B', issueUnit: 'pcs', isActive: true })
    // A PRE-EXISTING unresolved blocking exception on this batch (from an earlier run).
    api.seed(SHEET.exception, { exceptionId: 'exc_old', projectId: BUSINESS_PROJECT_ID, snapshotBatchId, exceptionType: 'unit_missing', severity: 'blocking', status: 'open', message: `msg_${SECRET}` })
    const first = await runStockPreparationGeneration(baseRunInput(api, provisioning, { snapshotBatchId }))
    assert.equal(first.status, 'ready', 'engine itself is ready (all lines resolvable)')
    assert.equal(first.ready, false, 'INVARIANT: pre-existing unresolved blocking exception blocks ready')
    assert.ok(first.unresolvedBlockingExceptionCount >= 1)
    // Resolve it; a re-run now reports ready.
    await resolveStockPreparationException({
      permission: 'admin', recordsApi: api, provisioning, targetProjectId: STAGING_PROJECT_ID,
      exceptionId: 'exc_old', resolutionAction: 'unit_rule_confirmed', resolvedBy: OPERATOR,
    })
    const second = await runStockPreparationGeneration(baseRunInput(api, provisioning, { snapshotBatchId }))
    assert.equal(second.ready, true)
    assert.equal(second.unresolvedBlockingExceptionCount, 0)
  })

  // ---- (d) re-run semantics ----
  await run('re-run upserts prep lines (patch, no duplicate), skips existing exception ids, keeps the run row', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    seedGenerationFixture(api)
    await runStockPreparationGeneration(baseRunInput(api, provisioning))
    const createsAfterFirst = api.createCalls.length
    const replay = await runStockPreparationGeneration(baseRunInput(api, provisioning))
    assert.equal(replay.created.lines, 0)
    assert.equal(replay.patched.lines, 1, 'existing prep line refreshed via patch')
    assert.equal(replay.created.exceptions, 0)
    assert.ok(replay.skipped.exceptions >= 1)
    assert.equal(replay.created.run, 0, 'stable runId => run row create-only')
    assert.equal(replay.mode, 'refreshed')
    assert.equal(api.createCalls.length, createsAfterFirst, 'replay created zero new rows')
    assert.equal(api.rowsOf(SHEET.prepLine).length, 1, 'no prep-line duplicates')
    // A human-resolved exception row is never clobbered by a re-run.
    const excRecord = api.rowsOf(SHEET.exception)[0]
    await resolveStockPreparationException({
      permission: 'admin', recordsApi: api, provisioning, targetProjectId: STAGING_PROJECT_ID,
      exceptionId: excRecord.data.exceptionId, resolutionAction: 'mapping_confirmed', resolvedBy: OPERATOR,
    })
    await runStockPreparationGeneration(baseRunInput(api, provisioning))
    const after = api.rowsOf(SHEET.exception)[0]
    assert.equal(after.data.status, 'resolved', 're-run preserved the human resolution')
    assert.equal(after.data.resolvedBy, OPERATOR)
  })

  // ---- (e) resolve ----
  await run('resolve patches exactly the resolution quartet; vocabulary + replay + 404 gates hold', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    api.seed(SHEET.exception, { exceptionId: 'exc_1', projectId: BUSINESS_PROJECT_ID, exceptionType: 'mapping_missing', severity: 'blocking', status: 'open', message: `m_${SECRET}` })
    const base = (overrides = {}) => ({
      permission: 'admin', recordsApi: api, provisioning, targetProjectId: STAGING_PROJECT_ID,
      exceptionId: 'exc_1', resolutionAction: 'mapping_confirmed', resolvedBy: OPERATOR, ...overrides,
    })
    await expectError(resolveStockPreparationException(base({ resolutionAction: 'bogus' })), { status: 400, code: 'EXCEPTION_RESOLUTION_ACTION_INVALID' })
    await expectError(resolveStockPreparationException(base({ resolutionAction: undefined })), { status: 400, code: 'EXCEPTION_RESOLUTION_ACTION_INVALID' })
    assert.equal(api.patchCalls.length, 0)
    const result = await resolveStockPreparationException(base())
    assert.equal(result.mode, 'resolved')
    const patch = api.patchCalls[0]
    assert.deepEqual(Object.keys(patch.changes).sort(), ['resolutionAction', 'resolvedAt', 'resolvedBy', 'status'])
    assert.equal(patch.changes.status, 'resolved')
    assert.equal(patch.changes.resolvedBy, OPERATOR)
    assert.match(patch.changes.resolvedAt, /^\d{4}-\d{2}-\d{2}T/)
    const replay = await resolveStockPreparationException(base())
    assert.equal(replay.mode, 'skipped_already_resolved')
    assert.equal(api.patchCalls.length, 1)
    await expectError(resolveStockPreparationException(base({ exceptionId: 'nope' })), { status: 404, code: 'EXCEPTION_NOT_FOUND' })
    assert.ok(RESOLUTION_ACTIONS.includes('manual_hold'))
  })

  // ---- (f) bulk resolve ----
  await run('bulk resolve enforces the same-reason gate BEFORE any patch, bounds ids, and counts skips', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    api.seed(SHEET.exception, { exceptionId: 'b1', projectId: BUSINESS_PROJECT_ID, exceptionType: 'unit_missing', severity: 'blocking', status: 'open' })
    api.seed(SHEET.exception, { exceptionId: 'b2', projectId: BUSINESS_PROJECT_ID, exceptionType: 'unit_missing', severity: 'blocking', status: 'resolved', resolutionAction: 'manual_hold', resolvedBy: OPERATOR, resolvedAt: 'x' })
    api.seed(SHEET.exception, { exceptionId: 'b3', projectId: BUSINESS_PROJECT_ID, exceptionType: 'mapping_missing', severity: 'blocking', status: 'open' })
    const base = (overrides = {}) => ({
      permission: 'admin', recordsApi: api, provisioning, targetProjectId: STAGING_PROJECT_ID,
      exceptionIds: ['b1', 'b2'], resolutionAction: 'unit_rule_confirmed', resolvedBy: OPERATOR, ...overrides,
    })
    // Mixed types refused before any patch.
    await expectError(bulkResolveStockPreparationExceptions(base({ exceptionIds: ['b1', 'b3'] })), { status: 409, code: 'EXCEPTION_BULK_MIXED_TYPES' })
    assert.equal(api.patchCalls.length, 0, 'same-reason gate fires before any patch')
    // Missing id refused before any patch.
    await expectError(bulkResolveStockPreparationExceptions(base({ exceptionIds: ['b1', 'ghost'] })), { status: 404, code: 'EXCEPTION_NOT_FOUND' })
    assert.equal(api.patchCalls.length, 0)
    // Bounds.
    await expectError(bulkResolveStockPreparationExceptions(base({ exceptionIds: [] })), { status: 400, code: 'EXCEPTION_BULK_IDS_INVALID' })
    await expectError(
      bulkResolveStockPreparationExceptions(base({ exceptionIds: Array.from({ length: MAX_BULK_RESOLVE + 1 }, (_, index) => `x${index}`) })),
      { status: 422, code: 'EXCEPTION_BULK_TOO_LARGE' },
    )
    // Happy: same type, one already resolved => resolved 1 / skipped 1.
    const result = await bulkResolveStockPreparationExceptions(base())
    assert.equal(result.resolved, 1)
    assert.equal(result.skipped, 1)
    assert.equal(result.exceptionType, 'unit_missing')
    assert.equal(api.patchCalls.length, 1)
    assert.deepEqual(Object.keys(api.patchCalls[0].changes).sort(), ['resolutionAction', 'resolvedAt', 'resolvedBy', 'status'])
  })

  // ---- (g) split + batch gates ----
  await run('staging/business split + explicit batch gates fail closed', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    seedGenerationFixture(api)
    const splitError = await expectError(
      runStockPreparationGeneration(baseRunInput(api, provisioning, { targetProjectId: BUSINESS_PROJECT_ID })),
      { status: 409, code: 'GENERATION_TARGET_NOT_PROVISIONED' },
    )
    assert.equal(api.createCalls.length + api.patchCalls.length, 0)
    assert.ok(!JSON.stringify(splitError.details).includes(SECRET))
    await expectError(
      runStockPreparationGeneration(baseRunInput(api, provisioning, { snapshotBatchId: 'ghost' })),
      { status: 404, code: 'GENERATION_BATCH_NOT_FOUND' },
    )
    api.seed(SHEET.batch, { snapshotBatchId: 'orphan', projectId: BUSINESS_PROJECT_ID, snapshotVersion: 9, syncRunId: 'run_orphan_missing' })
    await expectError(
      runStockPreparationGeneration(baseRunInput(api, provisioning, { snapshotBatchId: 'orphan' })),
      { status: 409, code: 'GENERATION_BATCH_INCOMPLETE' },
    )
  })

  const total = passed + failed
  console.log(`\nstock-preparation-generation-runtime: ${passed}/${total} passed`)
  if (failed > 0) {
    console.error(`${failed} test(s) failed`)
    process.exit(1)
  }
  console.log('✓ stock-preparation-generation-runtime')
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
