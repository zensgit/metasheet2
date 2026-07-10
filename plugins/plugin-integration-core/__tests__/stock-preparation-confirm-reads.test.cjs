'use strict'

// #3751 stock-prep MVP — READONLY confirmation-state reads (FE views 3/4). Covered:
//   (a) 403-before-IO — permission denied => ZERO provisioning + ZERO records calls, all four reads;
//   (b) STRUCTURALLY read-only — the fakes' write methods THROW if ever invoked; the api guard needs
//       only queryRecords (a fake without write methods works);
//   (c) R3 mapping summary — FE-pinned EXACT key set, zero-filled enum maps, junk status folds into
//       `unknown` (the junk string itself never crosses), pendingConfirmCount over ACTIVE rows;
//   (d) R4 mapping candidates — values-free projection (handle + enums + booleans + confidence ONLY;
//       planted drawing/name/spec/ERP-code secrets never cross), matchStatus filter + enum gate,
//       confirmed / hasErpTarget / plmVersionPresent booleans, row cap fails closed;
//   (e) R8 unit summary — FE-pinned EXACT key set; requiresConfirmationCount counts active UNSTAMPED
//       requiresConfirmation rows only; pendingUnitLineCount computed over the LATEST COMPLETE batch
//       (candidate + unit-side helds counted; mapping-side helds excluded); no complete batch => 0;
//   (f) R9 unit candidates — COMPUTED rows with candidateRule VALUES STRIPPED (only hasCandidate
//       crosses; planted unit-symbol secrets never appear), byOutcome/byReason, explicit-batch
//       selection, 404 when no complete batch exists;
//   (g) staging/business split — business projectId as locator => empty summary (sheet miss).

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  getMaterialMappingSummary,
  listMaterialMappingCandidates,
  getUnitConversionSummary,
  listUnitConversionCandidates,
  listStockPreparationExceptions,
  listStockPreparationPrepLines,
  StockPreparationConfirmReadError,
  MAPPING_OBJECT_ID,
  RULE_OBJECT_ID,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-confirm-reads.cjs'))
const {
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-templates.cjs'))

function objectIdByRole(role) {
  return STOCK_PREPARATION_MVP_TABLE_TEMPLATES.find((template) => template.role === role).objectId
}
const BATCH_OBJECT_ID = objectIdByRole('bom_snapshot_batch')
const LINE_OBJECT_ID = objectIdByRole('bom_snapshot_line')
const RUN_OBJECT_ID = objectIdByRole('run_record')
const MATERIAL_OBJECT_ID = objectIdByRole('erp_material_master')

const STAGING_PROJECT_ID = 'tenant_x:integration-core'
const BUSINESS_PROJECT_ID = 'proj_1'
const OPERATOR = 'user_admin_1'
const SECRET = 'SECRET_W3C_e2a9'

const EXCEPTION_OBJECT_ID = objectIdByRole('exception_confirmation')
const PREP_LINE_OBJECT_ID = objectIdByRole('stock_preparation_line')
const SHEET = {
  exception: `sheet_${EXCEPTION_OBJECT_ID}`,
  prepLine: `sheet_${PREP_LINE_OBJECT_ID}`,
  batch: `sheet_${BATCH_OBJECT_ID}`,
  line: `sheet_${LINE_OBJECT_ID}`,
  run: `sheet_${RUN_OBJECT_ID}`,
  material: `sheet_${MATERIAL_OBJECT_ID}`,
  mapping: `sheet_${MAPPING_OBJECT_ID}`,
  rule: `sheet_${RULE_OBJECT_ID}`,
}

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
  assert.ok(caught instanceof StockPreparationConfirmReadError, `expected confirm-read error, got ${caught && caught.name}: ${caught && caught.message}`)
  assert.equal(caught.status, status)
  assert.equal(caught.code, code)
  return caught
}

// READONLY fake: queryRecords honors filters + limit/offset; the write methods THROW if ever called
// (structural read-only proof). `seed` plants rows.
function makeReadOnlyRecordsApi() {
  const store = new Map()
  const queryCalls = []
  let seq = 0
  return {
    queryCalls,
    seed(sheetId, data) {
      const rows = store.get(sheetId) || []
      seq += 1
      rows.push({ id: `rec_${seq}`, data: { ...data } })
      store.set(sheetId, rows)
    },
    async queryRecords(input = {}) {
      const { sheetId, filters = {}, limit = 500, offset = 0 } = input
      queryCalls.push({ sheetId, filters })
      const rows = (store.get(sheetId) || []).filter((record) =>
        Object.entries(filters).every(([key, value]) => record.data[key] === value))
      return rows.slice(offset, offset + limit).map((record) => ({ id: record.id, data: { ...record.data } }))
    },
    async createRecord() {
      throw new Error('READONLY VIOLATION: createRecord was called')
    },
    async patchRecord() {
      throw new Error('READONLY VIOLATION: patchRecord was called')
    },
    async deleteRecord() {
      throw new Error('READONLY VIOLATION: deleteRecord was called')
    },
  }
}

function makeProvisioning({ missing = new Set(), stagingProjectId = STAGING_PROJECT_ID } = {}) {
  let findObjectSheetCalls = 0
  return {
    get findObjectSheetCalls() {
      return findObjectSheetCalls
    },
    async findObjectSheet({ projectId, objectId } = {}) {
      findObjectSheetCalls += 1
      if (projectId !== stagingProjectId) return null
      if (missing.has(objectId)) return null
      return { id: `sheet_${objectId}` }
    },
  }
}

function baseInput(api, provisioning, overrides = {}) {
  return {
    permission: 'admin',
    recordsApi: api,
    provisioning,
    targetProjectId: STAGING_PROJECT_ID,
    ...overrides,
  }
}

function seedCompleteBatch(api, { snapshotBatchId = 'batch_1', projectId = BUSINESS_PROJECT_ID, snapshotVersion = 1, withRun = true, lines = null } = {}) {
  const syncRunId = `run_${snapshotBatchId}`
  api.seed(SHEET.batch, { snapshotBatchId, projectId, snapshotVersion, syncRunId })
  if (withRun) api.seed(SHEET.run, { runId: syncRunId, status: 'succeeded' })
  const seeded = lines || [
    { snapshotLineId: `${snapshotBatchId}_l1`, snapshotBatchId, projectId, childDrawingNo: `DRW_${SECRET}`, childVersion: 'V1', designUnit: `unit_${SECRET}`, designQty: 3 },
  ]
  for (const line of seeded) api.seed(SHEET.line, line)
}

async function main() {
  // ---- (a) 403 before IO ----
  await run('permission denied fails closed before any provisioning or records access (all reads)', async () => {
    for (const op of [
      (api, prov) => getMaterialMappingSummary({ permission: 'read', recordsApi: api, provisioning: prov, targetProjectId: STAGING_PROJECT_ID }),
      (api, prov) => listMaterialMappingCandidates({ permission: 'read', recordsApi: api, provisioning: prov, targetProjectId: STAGING_PROJECT_ID }),
      (api, prov) => getUnitConversionSummary({ permission: 'read', recordsApi: api, provisioning: prov, targetProjectId: STAGING_PROJECT_ID, projectId: BUSINESS_PROJECT_ID }),
      (api, prov) => listUnitConversionCandidates({ permission: 'read', recordsApi: api, provisioning: prov, targetProjectId: STAGING_PROJECT_ID, projectId: BUSINESS_PROJECT_ID }),
    ]) {
      const api = makeReadOnlyRecordsApi()
      const provisioning = makeProvisioning()
      await expectError(op(api, provisioning), { status: 403, code: 'CONFIRM_READS_PERMISSION_DENIED' })
      assert.equal(provisioning.findObjectSheetCalls, 0)
      assert.equal(api.queryCalls.length, 0)
    }
  })

  // ---- (b) queryRecords-only guard ----
  await run('a records api with ONLY queryRecords passes the guard (no write method required)', async () => {
    const api = makeReadOnlyRecordsApi()
    const queryOnly = { queryRecords: api.queryRecords.bind(api) }
    const result = await getMaterialMappingSummary(baseInput(queryOnly, makeProvisioning()))
    assert.equal(result.totalMappingCount, 0)
  })

  // ---- (c) R3 mapping summary ----
  await run('R3 summary: FE-pinned exact keys, zero-filled enums, unknown fold, active-only pending count', async () => {
    const api = makeReadOnlyRecordsApi()
    api.seed(SHEET.mapping, { mappingId: 'm1', plmDrawingNo: `D_${SECRET}`, matchStatus: 'matched', versionPolicy: 'drawing_and_version', isActive: true, confirmedBy: OPERATOR, confirmedAt: 'x' })
    api.seed(SHEET.mapping, { mappingId: 'm2', plmDrawingNo: 'D2', matchStatus: 'pending_confirm', versionPolicy: 'drawing_only', isActive: true })
    api.seed(SHEET.mapping, { mappingId: 'm3', plmDrawingNo: 'D3', matchStatus: 'not_found', versionPolicy: 'drawing_only', isActive: true })
    api.seed(SHEET.mapping, { mappingId: 'm4', plmDrawingNo: 'D4', matchStatus: `junk_${SECRET}`, versionPolicy: `junk_${SECRET}`, isActive: true })
    api.seed(SHEET.mapping, { mappingId: 'm5', plmDrawingNo: 'D5', matchStatus: 'pending_confirm', versionPolicy: 'manual', isActive: false })
    const result = await getMaterialMappingSummary(baseInput(api, makeProvisioning()))
    assert.deepEqual(
      Object.keys(result).sort(),
      ['activeMappingCount', 'matchStatusCounts', 'pendingConfirmCount', 'totalMappingCount', 'versionPolicyCounts'],
      'FE-pinned exact top-level key set',
    )
    assert.equal(result.totalMappingCount, 5)
    assert.equal(result.activeMappingCount, 4)
    // zero-fill: every enum key present even when 0
    for (const key of ['matched', 'pending_confirm', 'multi_candidate', 'not_found', 'version_conflict']) {
      assert.ok(key in result.matchStatusCounts, `matchStatusCounts zero-fills ${key}`)
    }
    assert.equal(result.matchStatusCounts.matched, 1)
    assert.equal(result.matchStatusCounts.pending_confirm, 1)
    assert.equal(result.matchStatusCounts.unknown, 1, 'junk status folds into unknown')
    assert.equal(result.pendingConfirmCount, 2, 'active pending_confirm + not_found (inactive excluded)')
    assert.equal(JSON.stringify(result).includes(SECRET), false, 'junk strings and values never cross')
  })

  // ---- (d) R4 mapping candidates ----
  await run('R4 candidates: values-free projection, booleans, filter, enum gate, cap', async () => {
    const api = makeReadOnlyRecordsApi()
    api.seed(SHEET.mapping, { mappingId: 'c1', plmDrawingNo: `D_${SECRET}`, plmMaterialName: `N_${SECRET}`, plmSpec: `S_${SECRET}`, plmVersion: 'V1', erpMaterialCode: `E_${SECRET}`, erpMaterialInternalId: 'I1', matchStatus: 'pending_confirm', matchMethod: 'exact_code_candidate', versionPolicy: 'drawing_and_version', confidence: 0.95, isActive: true })
    api.seed(SHEET.mapping, { mappingId: 'c2', plmDrawingNo: 'D2', matchStatus: 'not_found', matchMethod: 'none', versionPolicy: 'drawing_only', confidence: 0, isActive: true })
    api.seed(SHEET.mapping, { mappingId: 'c3', plmDrawingNo: 'D3', matchStatus: 'matched', matchMethod: 'manual_confirm', versionPolicy: 'manual', confidence: 1, isActive: true, erpMaterialCode: 'E3', erpMaterialInternalId: 'I3', confirmedBy: OPERATOR, confirmedAt: 'x' })
    api.seed(SHEET.mapping, { mappingId: 'c4', plmDrawingNo: 'D4', matchStatus: 'pending_confirm', matchMethod: `junk_${SECRET}`, versionPolicy: 'drawing_only', confidence: 0.5, isActive: true })
    const result = await listMaterialMappingCandidates(baseInput(api, makeProvisioning()))
    assert.equal(result.rowCount, 4)
    assert.equal(result.rows.find((row) => row.mappingId === 'c4').matchMethod, 'unknown', 'junk matchMethod folds — the junk string never crosses')
    assert.equal(result.rows.find((row) => row.mappingId === 'c3').matchMethod, 'manual_confirm')
    const first = result.rows.find((row) => row.mappingId === 'c1')
    assert.deepEqual(
      Object.keys(first).sort(),
      ['confidence', 'confirmed', 'hasErpTarget', 'isActive', 'mappingId', 'matchMethod', 'matchStatus', 'plmVersionPresent', 'versionPolicy'],
      'row projection is the closed values-free key set',
    )
    assert.equal(first.hasErpTarget, true)
    assert.equal(first.plmVersionPresent, true)
    assert.equal(first.confirmed, false)
    const confirmedRow = result.rows.find((row) => row.mappingId === 'c3')
    assert.equal(confirmedRow.confirmed, true)
    assert.equal(JSON.stringify(result).includes(SECRET), false, 'drawing/name/spec/ERP-code values never cross')
    const filtered = await listMaterialMappingCandidates(baseInput(api, makeProvisioning(), { matchStatus: 'not_found' }))
    assert.equal(filtered.rowCount, 1)
    assert.equal(filtered.rows[0].mappingId, 'c2')
    await expectError(
      listMaterialMappingCandidates(baseInput(api, makeProvisioning(), { matchStatus: 'bogus' })),
      { status: 422, code: 'CONFIRM_READS_CONFIG_INVALID' },
    )
    const bigApi = makeReadOnlyRecordsApi()
    for (let index = 0; index < 2001; index += 1) {
      bigApi.seed(SHEET.mapping, { mappingId: `big_${index}`, plmDrawingNo: `D${index}`, matchStatus: 'pending_confirm', versionPolicy: 'drawing_only', isActive: true })
    }
    await expectError(
      listMaterialMappingCandidates(baseInput(bigApi, makeProvisioning())),
      { status: 422, code: 'CONFIRM_READS_ROWS_TOO_LARGE' },
    )
  })

  // ---- (e) R8 unit summary ----
  await run('R8 summary: FE-pinned keys, unstamped-requiresConfirmation count, computed pending unit lines', async () => {
    const api = makeReadOnlyRecordsApi()
    // rules: one confirmed generic, one unstamped requires-confirmation, one inactive
    api.seed(SHEET.rule, { conversionRuleId: 'r1', plmUnit: `u_${SECRET}`, erpIssueUnit: 'g', conversionFactor: 1000, scopeType: 'generic', roundingRule: 'none', requiresConfirmation: true, isActive: true, confirmedBy: OPERATOR, confirmedAt: 'x' })
    api.seed(SHEET.rule, { conversionRuleId: 'r2', plmUnit: 'm', erpIssueUnit: 'mm', conversionFactor: 1000, scopeType: 'material', scopeKey: 'I1', roundingRule: 'ceil', requiresConfirmation: true, isActive: true })
    api.seed(SHEET.rule, { conversionRuleId: 'r3', plmUnit: 'kg', erpIssueUnit: 't', conversionFactor: 0.001, scopeType: 'category', roundingRule: 'none', requiresConfirmation: false, isActive: false })
    // P2-C1 (review): a SECOND unstamped requires-confirmation row makes the count asymmetric (2 vs
    // stamped 1) so inverting the !isStamped condition can no longer produce the same number.
    api.seed(SHEET.rule, { conversionRuleId: 'r4', plmUnit: 'cm', erpIssueUnit: 'mm', conversionFactor: 10, scopeType: 'generic', roundingRule: 'none', requiresConfirmation: true, isActive: true })
    // complete batch whose single line has NO mapping => held missing_mapping (EXCLUDED from pending)
    seedCompleteBatch(api)
    const result = await getUnitConversionSummary(baseInput(api, makeProvisioning(), { projectId: BUSINESS_PROJECT_ID }))
    assert.deepEqual(
      Object.keys(result).sort(),
      ['activeRuleCount', 'pendingUnitLineCount', 'requiresConfirmationCount', 'roundingRuleCounts', 'scopeTypeCounts', 'totalRuleCount'],
      'FE-pinned exact top-level key set',
    )
    assert.equal(result.totalRuleCount, 4)
    assert.equal(result.activeRuleCount, 3)
    assert.equal(result.requiresConfirmationCount, 2, 'exactly the active UNSTAMPED requires-confirmation rows (stamped r1 excluded)')
    for (const key of ['material', 'category', 'generic']) assert.ok(key in result.scopeTypeCounts)
    for (const key of ['none', 'ceil', 'floor', 'nearest', 'pack_size']) assert.ok(key in result.roundingRuleCounts)
    assert.equal(result.pendingUnitLineCount, 0, 'mapping-side held (missing_mapping) is view-3 work, not a pending unit line')
    assert.equal(JSON.stringify(result).includes(SECRET), false)
    // no complete batch at all => 0 (not an error; FE shape lockstep)
    const emptyApi = makeReadOnlyRecordsApi()
    const empty = await getUnitConversionSummary(baseInput(emptyApi, makeProvisioning(), { projectId: BUSINESS_PROJECT_ID }))
    assert.equal(empty.pendingUnitLineCount, 0)
  })

  await run('R8 pending count includes 1:1 candidates and unit-side helds over the LATEST complete batch', async () => {
    const api = makeReadOnlyRecordsApi()
    // confirmed mapping + material whose issue unit matches the design unit => candidate outcome
    api.seed(SHEET.mapping, { mappingId: 'map_ok', plmDrawingNo: 'A-100', plmVersion: 'V1', erpMaterialCode: 'A-100', erpMaterialInternalId: 'ITM_1', versionPolicy: 'drawing_and_version', matchStatus: 'matched', isActive: true, confirmedBy: OPERATOR, confirmedAt: 'x' })
    api.seed(SHEET.material, { erpMaterialId: 'erp_1', erpMaterialCode: 'A-100', erpMaterialInternalId: 'ITM_1', issueUnit: 'pcs', isActive: true })
    // orphaned newer batch (no run row) MUST be skipped in favor of the complete older one
    seedCompleteBatch(api, {
      snapshotBatchId: 'complete_1', snapshotVersion: 1,
      lines: [{ snapshotLineId: 'ok1', snapshotBatchId: 'complete_1', projectId: BUSINESS_PROJECT_ID, childDrawingNo: 'A-100', childVersion: 'V1', designUnit: 'pcs', designQty: 1 }],
    })
    seedCompleteBatch(api, { snapshotBatchId: 'orphan_2', snapshotVersion: 2, withRun: false, lines: [{ snapshotLineId: 'x1', snapshotBatchId: 'orphan_2', projectId: BUSINESS_PROJECT_ID, childDrawingNo: 'Z', designUnit: 'kg', designQty: 1 }] })
    const result = await getUnitConversionSummary(baseInput(api, makeProvisioning(), { projectId: BUSINESS_PROJECT_ID }))
    assert.equal(result.pendingUnitLineCount, 1, 'the 1:1 candidate from the COMPLETE batch counts')
  })

  // ---- (f) R9 unit candidates ----
  await run('R9 candidates: computed values-stripped rows, byOutcome/byReason, explicit batch, 404 when none', async () => {
    const api = makeReadOnlyRecordsApi()
    api.seed(SHEET.mapping, { mappingId: 'map_ok', plmDrawingNo: 'A-100', plmVersion: 'V1', erpMaterialCode: 'A-100', erpMaterialInternalId: 'ITM_1', versionPolicy: 'drawing_and_version', matchStatus: 'matched', isActive: true, confirmedBy: OPERATOR, confirmedAt: 'x' })
    api.seed(SHEET.material, { erpMaterialId: 'erp_1', erpMaterialCode: 'A-100', erpMaterialInternalId: 'ITM_1', issueUnit: `unit_${SECRET}`, isActive: true })
    seedCompleteBatch(api, {
      snapshotBatchId: 'cb1',
      lines: [
        { snapshotLineId: 'l1', snapshotBatchId: 'cb1', projectId: BUSINESS_PROJECT_ID, childDrawingNo: 'A-100', childVersion: 'V1', designUnit: `unit_${SECRET}`, designQty: 1 },
        { snapshotLineId: 'l2', snapshotBatchId: 'cb1', projectId: BUSINESS_PROJECT_ID, childDrawingNo: 'B-200', childVersion: 'V1', designUnit: 'kg', designQty: 1 },
      ],
    })
    const result = await listUnitConversionCandidates(baseInput(api, makeProvisioning(), { projectId: BUSINESS_PROJECT_ID }))
    assert.equal(result.snapshotBatchId, 'cb1')
    assert.equal(result.rowCount, 2)
    assert.ok(result.byOutcome.candidate >= 1, 'the 1:1 unit context surfaces as a candidate')
    assert.ok(result.byOutcome.held >= 1, 'the unmapped line surfaces as held')
    const candidateRow = result.rows.find((row) => row.outcome === 'candidate')
    assert.deepEqual(
      Object.keys(candidateRow).sort().filter((key) => candidateRow[key] !== undefined),
      ['contextFingerprint', 'hasCandidate', 'outcome', 'reason'].filter((key) => candidateRow[key] !== undefined).sort(),
      'candidate row carries only the closed key set',
    )
    assert.equal(candidateRow.hasCandidate, true)
    assert.match(candidateRow.contextFingerprint, /^sha16:/)
    assert.equal(JSON.stringify(result).includes(SECRET), false, 'candidateRule values (unit symbols) are stripped')
    // explicit batch id selects it; unknown/incomplete batch for the project => 404
    const explicit = await listUnitConversionCandidates(baseInput(api, makeProvisioning(), { projectId: BUSINESS_PROJECT_ID, snapshotBatchId: 'cb1' }))
    assert.equal(explicit.snapshotBatchId, 'cb1')
    await expectError(
      listUnitConversionCandidates(baseInput(api, makeProvisioning(), { projectId: BUSINESS_PROJECT_ID, snapshotBatchId: 'nope' })),
      { status: 404, code: 'CONFIRM_READS_BATCH_NOT_FOUND' },
    )
    const emptyApi = makeReadOnlyRecordsApi()
    await expectError(
      listUnitConversionCandidates(baseInput(emptyApi, makeProvisioning(), { projectId: BUSINESS_PROJECT_ID })),
      { status: 404, code: 'CONFIRM_READS_BATCH_NOT_FOUND' },
    )
    // P2-C2 (review): an EXISTING complete batch that belongs to ANOTHER project must 404 through the
    // explicit-id path — deleting the project-ownership guard now has a failing negative.
    seedCompleteBatch(api, {
      snapshotBatchId: 'other_proj_batch', projectId: 'proj_other',
      lines: [{ snapshotLineId: 'op1', snapshotBatchId: 'other_proj_batch', projectId: 'proj_other', childDrawingNo: 'X', childVersion: 'V1', designUnit: 'pcs', designQty: 1 }],
    })
    await expectError(
      listUnitConversionCandidates(baseInput(api, makeProvisioning(), { projectId: BUSINESS_PROJECT_ID, snapshotBatchId: 'other_proj_batch' })),
      { status: 404, code: 'CONFIRM_READS_BATCH_NOT_FOUND' },
    )
  })

  // ---- (g) staging/business split ----
  await run('business projectId as the sheet locator finds nothing (split preserved)', async () => {
    const api = makeReadOnlyRecordsApi()
    api.seed(SHEET.mapping, { mappingId: 'm1', plmDrawingNo: 'D', matchStatus: 'matched', versionPolicy: 'manual', isActive: true })
    const result = await getMaterialMappingSummary(baseInput(api, makeProvisioning(), { targetProjectId: BUSINESS_PROJECT_ID }))
    assert.equal(result.totalMappingCount, 0, 'sheet lookup under the business project misses')
  })

  // ---- W5a: exception queue list ----
  await run('exception list: values-free rows (message never crosses), filters, unresolved-blocking count', async () => {
    const api = makeReadOnlyRecordsApi()
    api.seed(SHEET.exception, { exceptionId: 'e1', projectId: BUSINESS_PROJECT_ID, snapshotBatchId: 'b1', snapshotLineId: 'l1', stockPrepLineId: 'p1', exceptionType: 'missing_mapping', severity: 'blocking', status: 'open', message: `secret msg ${SECRET}` })
    api.seed(SHEET.exception, { exceptionId: 'e2', projectId: BUSINESS_PROJECT_ID, snapshotBatchId: 'b1', exceptionType: 'unit_missing', severity: 'blocking', status: 'resolved', resolutionAction: 'unit_rule_confirmed', resolvedBy: OPERATOR, resolvedAt: 'x', message: `m2_${SECRET}` })
    api.seed(SHEET.exception, { exceptionId: 'e3', projectId: BUSINESS_PROJECT_ID, snapshotBatchId: 'b2', exceptionType: `junk_${SECRET}`, severity: 'warning', status: 'open', message: 'x' })
    api.seed(SHEET.exception, { exceptionId: 'e4', projectId: 'proj_other', snapshotBatchId: 'bx', exceptionType: 'invalid_qty', severity: 'blocking', status: 'open', message: 'x' })
    const result = await listStockPreparationExceptions(baseInput(api, makeProvisioning(), { projectId: BUSINESS_PROJECT_ID }))
    assert.equal(result.rowCount, 3, 'other-project rows never surface')
    assert.equal(result.unresolvedBlockingCount, 1, 'resolved blocking row excluded; warning excluded')
    assert.equal(result.byType.missing_mapping, 1)
    assert.equal(result.byType.unknown, 1, 'junk type folds')
    const resolvedRow = result.rows.find((row) => row.exceptionId === 'e2')
    assert.equal(resolvedRow.resolved, true)
    assert.equal(resolvedRow.resolvedByPresent, true)
    assert.equal(resolvedRow.resolutionAction, 'unit_rule_confirmed')
    for (const row of result.rows) {
      assert.ok(!('message' in row), 'message cell never crosses')
    }
    assert.equal(JSON.stringify(result).includes(SECRET), false, 'no business text or junk string leaks')
    // filters + enum gates
    const openOnly = await listStockPreparationExceptions(baseInput(api, makeProvisioning(), { projectId: BUSINESS_PROJECT_ID, status: 'open' }))
    assert.ok(openOnly.rows.every((row) => row.status === 'open'))
    const batchOnly = await listStockPreparationExceptions(baseInput(api, makeProvisioning(), { projectId: BUSINESS_PROJECT_ID, snapshotBatchId: 'b1' }))
    assert.equal(batchOnly.rowCount, 2)
    await expectError(
      listStockPreparationExceptions(baseInput(api, makeProvisioning(), { projectId: BUSINESS_PROJECT_ID, status: 'bogus' })),
      { status: 422, code: 'CONFIRM_READS_CONFIG_INVALID' },
    )
    await expectError(
      listStockPreparationExceptions(baseInput(api, makeProvisioning(), { projectId: BUSINESS_PROJECT_ID, exceptionType: 'nope' })),
      { status: 422, code: 'CONFIRM_READS_CONFIG_INVALID' },
    )
  })

  // ---- W5a: prep-line list ----
  await run('prep-line list: values-free summary rows (no drawing/qty/unit values), filters, enum folds', async () => {
    const api = makeReadOnlyRecordsApi()
    api.seed(SHEET.prepLine, { stockPrepLineId: 'p1', projectId: BUSINESS_PROJECT_ID, snapshotBatchId: 'b1', snapshotLineId: 'l1', childDrawingNo: `D_${SECRET}`, designQty: 3, designUnit: `u_${SECRET}`, issueQtyFinal: 3, issueUnit: `u_${SECRET}`, erpMaterialCode: 'C1', erpMaterialInternalId: 'I1', prepStatus: 'draft', mappingStatus: 'matched', unitStatus: 'converted', exceptionCount: 0, createdFromRunId: 'run_x' })
    api.seed(SHEET.prepLine, { stockPrepLineId: 'p2', projectId: BUSINESS_PROJECT_ID, snapshotBatchId: 'b1', snapshotLineId: 'l2', childDrawingNo: 'D2', prepStatus: 'held', mappingStatus: 'not_found', unitStatus: 'missing_rule', exceptionCount: 2 })
    api.seed(SHEET.prepLine, { stockPrepLineId: 'p3', projectId: 'proj_other', snapshotBatchId: 'bx', prepStatus: 'draft' })
    const result = await listStockPreparationPrepLines(baseInput(api, makeProvisioning(), { projectId: BUSINESS_PROJECT_ID }))
    assert.equal(result.rowCount, 2, 'other-project rows never surface')
    assert.equal(result.byPrepStatus.draft, 1)
    assert.equal(result.byPrepStatus.held, 1)
    const first = result.rows.find((row) => row.stockPrepLineId === 'p1')
    assert.equal(first.hasIssueQty, true)
    assert.equal(first.hasErpTarget, true)
    assert.equal(first.createdFromRunId, 'run_x')
    const second = result.rows.find((row) => row.stockPrepLineId === 'p2')
    assert.equal(second.hasIssueQty, false)
    assert.equal(second.exceptionCount, 2)
    for (const row of result.rows) {
      for (const key of Object.keys(row)) {
        assert.ok(!['childDrawingNo', 'designQty', 'designUnit', 'issueQtyFinal', 'issueQtyRaw', 'issueUnit', 'conversionFactor', 'lossRate', 'erpMaterialCode', 'erpMaterialInternalId'].includes(key), `value-bearing key ${key} must never cross (owner-gated)`)
      }
    }
    assert.equal(JSON.stringify(result).includes(SECRET), false)
    const heldOnly = await listStockPreparationPrepLines(baseInput(api, makeProvisioning(), { projectId: BUSINESS_PROJECT_ID, prepStatus: 'held' }))
    assert.equal(heldOnly.rowCount, 1)
    await expectError(
      listStockPreparationPrepLines(baseInput(api, makeProvisioning(), { projectId: BUSINESS_PROJECT_ID, prepStatus: 'bogus' })),
      { status: 422, code: 'CONFIRM_READS_CONFIG_INVALID' },
    )
  })

  const total = passed + failed
  console.log(`\nstock-preparation-confirm-reads: ${passed}/${total} passed`)
  if (failed > 0) {
    console.error(`${failed} test(s) failed`)
    process.exit(1)
  }
  console.log('✓ stock-preparation-confirm-reads')
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
