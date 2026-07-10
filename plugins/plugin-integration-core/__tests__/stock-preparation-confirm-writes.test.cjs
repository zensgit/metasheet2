'use strict'

// #3751 stock-prep MVP — HUMAN CONFIRM writes (material-mapping candidate-sync / confirm / retire +
// unit-conversion-rule confirm / retire). These are the MVP's first human-in-the-loop writes, so the
// tests lock the safety invariants, not just happy paths. Covered:
//   (a)  403-before-IO — permission denied => ZERO provisioning + ZERO records calls, all five ops;
//   (b)  R5 candidate-sync happy path — pending rows created, grounded to template field ids, and the
//        human_preserved trio (confirmedBy / confirmedAt / notes) is STRUCTURALLY absent;
//   (c)  R5 create-only idempotency — replay creates nothing, patches nothing;
//   (d)  R5 never creates a CONFIRMED row (drift guard via an id-less confirmed mapping fixture);
//   (e)  R5 OD2 — defaultVersionPolicy absent / non-vocabulary => 400; both policies round-trip;
//   (f)  R5 batch gates — unknown / other-project => 404; run-less or line-less => 409 INCOMPLETE;
//        latest-complete auto-pick SKIPS an orphaned newer batch;
//   (g)  staging/business split — business projectId as locator => 409 NOT_PROVISIONED, zero writes;
//   (h)  R6 XOR + confirm-existing patch shape (EXACT key set) + notes variant + target-incomplete 409
//        + inactive 409 + already-confirmed skip + key-ambiguity 500;
//   (i)  R6 create-confirmed — closed allowlist, both-ERP-ids required, policy vocabulary, version
//        required under drawing_and_version, replay skips;
//   (j)  R7 / R11 retire — patch EXACTLY { isActive: false }, replay skips, retire-then-recreate with
//        a different factor mints a DIFFERENT rule id (full-content hash);
//   (k)  R10 tri-XOR + mode-a stamp (manual rows only; UNSTAMPED system_candidate => 409) + mode-b
//        fingerprint-confirm persists the SERVER-derived 1:1 candidate (stale fingerprint => 409) +
//        mode-c validation battery (factor / rounding / scope);
//   (l)  cross-project reuse — a mapping confirmed under project A resolves project B's lines;
//   (m)  held/待确认 propagation — drawing_and_version version bump creates a NEW pending row while
//        the confirmed row is never patched; the drawing_only twin creates nothing;
//   (n)  values-free — planted SECRET tokens (drawing no / unit / business project) never reach any
//        result evidence or thrown error details.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  syncMaterialMappingCandidates,
  confirmMaterialMapping,
  retireMaterialMapping,
  confirmUnitConversionRule,
  retireUnitConversionRule,
  StockPreparationConfirmWriteError,
  MAPPING_OBJECT_ID,
  RULE_OBJECT_ID,
  MANUAL_CONFIRM_MATCH_METHOD,
  MANUAL_RULE_SOURCE,
  __internals: { MAPPING_FIELD_IDS, RULE_FIELD_IDS, MAPPING_HUMAN_FIELD_IDS },
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-confirm-writes.cjs'))
const {
  generateUnitConversionRuleCandidates,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-unit-rule-match.cjs'))

const {
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-templates.cjs'))

// Derive the substrate objectIds from the frozen templates (never hardcode — the run-record id is
// plm_stock_preparation_run, not _run_record).
function objectIdByRole(role) {
  return STOCK_PREPARATION_MVP_TABLE_TEMPLATES.find((template) => template.role === role).objectId
}
const BATCH_OBJECT_ID = objectIdByRole('bom_snapshot_batch')
const LINE_OBJECT_ID = objectIdByRole('bom_snapshot_line')
const RUN_OBJECT_ID = objectIdByRole('run_record')
const MATERIAL_OBJECT_ID = objectIdByRole('erp_material_master')

const STAGING_PROJECT_ID = 'tenant_x:integration-core'
const BUSINESS_PROJECT_ID = 'proj_1'
const OTHER_PROJECT_ID = 'proj_2'
const OPERATOR = 'user_admin_1'

// Planted leak tokens that must NEVER reach evidence / error details (rows legitimately carry them).
const SECRET = 'SECRET_W3B_51c7'
const LEAKY_DRAWING = `DRW_${SECRET}`
const LEAKY_UNIT = `unit_${SECRET}`

const MAPPING_FIELD_ID_SET = new Set(MAPPING_FIELD_IDS)
const RULE_FIELD_ID_SET = new Set(RULE_FIELD_IDS)

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
  assert.ok(caught instanceof StockPreparationConfirmWriteError, `expected confirm-write error, got ${caught.name}: ${caught.message}`)
  assert.equal(caught.status, status)
  assert.equal(caught.code, code)
  return caught
}

// Stateful in-memory fake records API. Unlike the persist fake, patchRecord here APPLIES its changes
// (confirm tests assert the patched row) and queryRecords honors limit/offset (the module paginates).
function makeRecordsApi() {
  const store = new Map() // sheetId -> [{ id, data }]
  const createCalls = []
  const patchCalls = []
  const queryCalls = []
  let seq = 0
  return {
    store,
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
      return rows.slice(offset, offset + limit)
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

// Fake provisioning: distinct sheetId per MVP objectId, resolvable ONLY under the staging project.
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

const SHEET = {
  batch: `sheet_${BATCH_OBJECT_ID}`,
  line: `sheet_${LINE_OBJECT_ID}`,
  run: `sheet_${RUN_OBJECT_ID}`,
  material: `sheet_${MATERIAL_OBJECT_ID}`,
  mapping: `sheet_${MAPPING_OBJECT_ID}`,
  rule: `sheet_${RULE_OBJECT_ID}`,
}

// A COMPLETE batch fixture: batch row + run row + two snapshot lines (canonical snapshot-line keys,
// one with a leaky drawing number + unit so the values-free scan bites).
function seedCompleteBatch(api, {
  snapshotBatchId = 'batch_1',
  projectId = BUSINESS_PROJECT_ID,
  snapshotVersion = 1,
  withRun = true,
  lines = null,
} = {}) {
  const syncRunId = `run_${snapshotBatchId}`
  api.seed(SHEET.batch, { snapshotBatchId, projectId, snapshotVersion, syncRunId, snapshotStatus: 'draft' })
  if (withRun) api.seed(SHEET.run, { runId: syncRunId, snapshotBatchId, projectId, status: 'succeeded' })
  const seededLines = lines || [
    { snapshotLineId: `${snapshotBatchId}_l1`, snapshotBatchId, projectId, childDrawingNo: LEAKY_DRAWING, childVersion: 'V1', designUnit: LEAKY_UNIT, designQty: 3 },
    { snapshotLineId: `${snapshotBatchId}_l2`, snapshotBatchId, projectId, childDrawingNo: 'B-200', childVersion: 'V2', designUnit: 'pcs', designQty: 5 },
  ]
  for (const line of seededLines) api.seed(SHEET.line, line)
  return { snapshotBatchId, syncRunId, lines: seededLines }
}

function seedMaterials(api) {
  // Exact-code match for LEAKY_DRAWING; issue unit equals the line's design unit (1:1 candidate).
  api.seed(SHEET.material, { erpMaterialId: 'erp_1', erpMaterialCode: LEAKY_DRAWING, erpMaterialInternalId: 'ITM_1', erpMaterialName: 'M1', issueUnit: LEAKY_UNIT, isActive: true })
}

function baseSyncInput(api, provisioning, overrides = {}) {
  return {
    permission: 'admin',
    recordsApi: api,
    provisioning,
    targetProjectId: STAGING_PROJECT_ID,
    projectId: BUSINESS_PROJECT_ID,
    defaultVersionPolicy: 'drawing_and_version',
    ...overrides,
  }
}

function assertNoSecret(value, label) {
  assert.ok(!JSON.stringify(value).includes(SECRET), `${label} must not leak the planted secret`)
}

async function main() {
  // ---- (a) 403 BEFORE any IO, all five ops ----
  await run('permission denied fails closed before any provisioning or records access (all ops)', async () => {
    for (const op of [
      (api, prov) => syncMaterialMappingCandidates({ permission: 'write', recordsApi: api, provisioning: prov, targetProjectId: STAGING_PROJECT_ID, projectId: BUSINESS_PROJECT_ID, defaultVersionPolicy: 'drawing_only' }),
      (api, prov) => confirmMaterialMapping({ permission: 'write', recordsApi: api, provisioning: prov, targetProjectId: STAGING_PROJECT_ID, mappingId: 'x', confirmedBy: OPERATOR }),
      (api, prov) => retireMaterialMapping({ permission: 'write', recordsApi: api, provisioning: prov, targetProjectId: STAGING_PROJECT_ID, mappingId: 'x' }),
      (api, prov) => confirmUnitConversionRule({ permission: 'write', recordsApi: api, provisioning: prov, targetProjectId: STAGING_PROJECT_ID, conversionRuleId: 'x', confirmedBy: OPERATOR }),
      (api, prov) => retireUnitConversionRule({ permission: 'write', recordsApi: api, provisioning: prov, targetProjectId: STAGING_PROJECT_ID, conversionRuleId: 'x' }),
    ]) {
      const api = makeRecordsApi()
      const provisioning = makeProvisioning()
      await expectError(op(api, provisioning), { status: 403, code: 'CONFIRM_PERMISSION_DENIED' })
      assert.equal(provisioning.findObjectSheetCalls, 0)
      assert.equal(api.createCalls.length + api.patchCalls.length + api.queryCalls.length, 0)
    }
  })

  // ---- (b) R5 happy path ----
  await run('R5 creates pending candidate rows grounded to template ids, human trio structurally absent', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    seedCompleteBatch(api)
    seedMaterials(api)
    const result = await syncMaterialMappingCandidates(baseSyncInput(api, provisioning))
    assert.equal(result.persisted, true)
    assert.equal(result.mode, 'created')
    assert.equal(result.snapshotBatchId, 'batch_1')
    // Two unique PLM items: one pending_confirm (exact code), one not_found.
    assert.equal(result.created.mappings, 2)
    const writes = api.createCalls.filter((call) => call.sheetId === SHEET.mapping)
    assert.equal(writes.length, 2)
    for (const call of writes) {
      for (const key of Object.keys(call.data)) {
        assert.ok(MAPPING_FIELD_ID_SET.has(key), `persisted mapping key ${key} must be template-declared`)
        assert.ok(!MAPPING_HUMAN_FIELD_IDS.includes(key), `sync must never write human field ${key}`)
      }
      assert.notEqual(call.data.matchStatus, 'matched')
    }
    assert.equal(api.patchCalls.length, 0)
    assertNoSecret(result.evidence, 'R5 evidence')
  })

  // ---- (c) R5 create-only idempotency ----
  await run('R5 replay skips every existing mappingId and patches nothing', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    seedCompleteBatch(api)
    seedMaterials(api)
    await syncMaterialMappingCandidates(baseSyncInput(api, provisioning))
    const before = api.createCalls.length
    const replay = await syncMaterialMappingCandidates(baseSyncInput(api, provisioning))
    assert.equal(replay.persisted, false)
    assert.equal(replay.mode, 'skipped_existing')
    assert.equal(replay.created.mappings, 0)
    assert.ok(replay.skipped.existing >= 2)
    assert.equal(api.createCalls.length, before)
    assert.equal(api.patchCalls.length, 0)
  })

  // ---- (d) R5 never creates a confirmed row (drift guard) ----
  await run('R5 skips a confirmed matched re-emit even when its table row lacks a mappingId', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    seedCompleteBatch(api)
    seedMaterials(api)
    // Confirmed mapping WITHOUT a mappingId cell: the engine re-emits it as a matched historical row
    // with a DERIVED (new) id — the matchStatus guard must refuse to create it.
    api.seed(SHEET.mapping, {
      plmDrawingNo: LEAKY_DRAWING, plmVersion: 'V1', erpMaterialCode: LEAKY_DRAWING, erpMaterialInternalId: 'ITM_1',
      versionPolicy: 'drawing_and_version', matchStatus: 'matched', isActive: true, confirmedBy: OPERATOR, confirmedAt: '2026-07-01T00:00:00.000Z',
    })
    const result = await syncMaterialMappingCandidates(baseSyncInput(api, provisioning))
    assert.equal(result.skipped.matched, 1)
    const matchedWrites = api.createCalls.filter((call) => call.sheetId === SHEET.mapping && call.data.matchStatus === 'matched')
    assert.equal(matchedWrites.length, 0)
  })

  // ---- (e) OD2 ----
  await run('R5 rejects an absent or non-vocabulary defaultVersionPolicy and accepts both shipped policies', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    seedCompleteBatch(api)
    seedMaterials(api)
    await expectError(
      syncMaterialMappingCandidates(baseSyncInput(api, provisioning, { defaultVersionPolicy: undefined })),
      { status: 400, code: 'CONFIRM_VERSION_POLICY_INVALID' },
    )
    await expectError(
      syncMaterialMappingCandidates(baseSyncInput(api, provisioning, { defaultVersionPolicy: 'bogus_policy' })),
      { status: 400, code: 'CONFIRM_VERSION_POLICY_INVALID' },
    )
    const withVersion = await syncMaterialMappingCandidates(baseSyncInput(api, provisioning, { defaultVersionPolicy: 'drawing_and_version' }))
    assert.ok(api.createCalls.filter((call) => call.sheetId === SHEET.mapping).every((call) => call.data.versionPolicy === 'drawing_and_version'))
    assert.equal(withVersion.persisted, true)
    // drawing_only run on a fresh store round-trips the policy too.
    const api2 = makeRecordsApi()
    seedCompleteBatch(api2)
    seedMaterials(api2)
    await syncMaterialMappingCandidates(baseSyncInput(api2, makeProvisioning(), { defaultVersionPolicy: 'drawing_only' }))
    assert.ok(api2.createCalls.filter((call) => call.sheetId === SHEET.mapping).every((call) => call.data.versionPolicy === 'drawing_only'))
  })

  // ---- (f) batch gates ----
  await run('R5 batch gates: unknown/other-project 404, incomplete 409, auto-pick skips orphaned batch', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    seedCompleteBatch(api, { snapshotBatchId: 'batch_1', snapshotVersion: 1 })
    seedMaterials(api)
    await expectError(
      syncMaterialMappingCandidates(baseSyncInput(api, provisioning, { snapshotBatchId: 'batch_missing' })),
      { status: 404, code: 'CONFIRM_BATCH_NOT_FOUND' },
    )
    // Other-project batch: exists but belongs to proj_2.
    seedCompleteBatch(api, { snapshotBatchId: 'batch_p2', projectId: OTHER_PROJECT_ID, snapshotVersion: 1 })
    await expectError(
      syncMaterialMappingCandidates(baseSyncInput(api, provisioning, { snapshotBatchId: 'batch_p2' })),
      { status: 404, code: 'CONFIRM_BATCH_NOT_FOUND' },
    )
    // Run-less batch => explicit request 409.
    seedCompleteBatch(api, { snapshotBatchId: 'batch_orphan', snapshotVersion: 2, withRun: false })
    await expectError(
      syncMaterialMappingCandidates(baseSyncInput(api, provisioning, { snapshotBatchId: 'batch_orphan' })),
      { status: 409, code: 'CONFIRM_BATCH_INCOMPLETE' },
    )
    // Line-less batch => 409.
    api.seed(SHEET.batch, { snapshotBatchId: 'batch_bare', projectId: BUSINESS_PROJECT_ID, snapshotVersion: 3, syncRunId: 'run_batch_bare' })
    api.seed(SHEET.run, { runId: 'run_batch_bare', status: 'succeeded' })
    await expectError(
      syncMaterialMappingCandidates(baseSyncInput(api, provisioning, { snapshotBatchId: 'batch_bare' })),
      { status: 409, code: 'CONFIRM_BATCH_INCOMPLETE' },
    )
    // Auto-pick: the orphaned v2 batch (no run) is skipped in favor of complete v1.
    const result = await syncMaterialMappingCandidates(baseSyncInput(api, provisioning))
    assert.equal(result.snapshotBatchId, 'batch_1')
    // No complete batch at all => 404.
    const emptyApi = makeRecordsApi()
    await expectError(
      syncMaterialMappingCandidates(baseSyncInput(emptyApi, makeProvisioning())),
      { status: 404, code: 'CONFIRM_BATCH_NOT_FOUND' },
    )
  })

  // ---- (g) staging/business split ----
  await run('R5 with the business projectId as locator fails closed with zero writes', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    seedCompleteBatch(api)
    const error = await expectError(
      syncMaterialMappingCandidates(baseSyncInput(api, provisioning, { targetProjectId: BUSINESS_PROJECT_ID })),
      { status: 409, code: 'CONFIRM_TARGET_NOT_PROVISIONED' },
    )
    assert.equal(api.createCalls.length, 0)
    assert.equal(api.patchCalls.length, 0)
    assertNoSecret(error.details, 'not-provisioned error details')
  })

  // ---- (h) R6 XOR + confirm-existing ----
  await run('R6 rejects zero or two modes', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    await expectError(
      confirmMaterialMapping({ permission: 'admin', recordsApi: api, provisioning, targetProjectId: STAGING_PROJECT_ID, confirmedBy: OPERATOR }),
      { status: 400, code: 'CONFIRM_MODE_AMBIGUOUS' },
    )
    await expectError(
      confirmMaterialMapping({ permission: 'admin', recordsApi: api, provisioning, targetProjectId: STAGING_PROJECT_ID, confirmedBy: OPERATOR, mappingId: 'm1', mapping: { plmDrawingNo: 'D' } }),
      { status: 400, code: 'CONFIRM_MODE_AMBIGUOUS' },
    )
  })

  await run('R6 confirm-existing patches EXACTLY matchStatus+stamps (+notes when given)', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    api.seed(SHEET.mapping, { mappingId: 'map_1', plmDrawingNo: LEAKY_DRAWING, plmVersion: 'V1', erpMaterialCode: 'C1', erpMaterialInternalId: 'ITM_1', versionPolicy: 'drawing_and_version', matchStatus: 'pending_confirm', isActive: true })
    const result = await confirmMaterialMapping({ permission: 'admin', recordsApi: api, provisioning, targetProjectId: STAGING_PROJECT_ID, mappingId: 'map_1', confirmedBy: OPERATOR })
    assert.equal(result.persisted, true)
    assert.equal(result.mode, 'confirmed')
    assert.equal(api.patchCalls.length, 1)
    const patch = api.patchCalls[0]
    assert.deepEqual(Object.keys(patch.changes).sort(), ['confirmedAt', 'confirmedBy', 'matchStatus'])
    assert.equal(patch.changes.matchStatus, 'matched')
    assert.equal(patch.changes.confirmedBy, OPERATOR)
    assert.match(patch.changes.confirmedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    assertNoSecret(result, 'R6 confirm result')
    // notes variant
    const api2 = makeRecordsApi()
    api2.seed(SHEET.mapping, { mappingId: 'map_2', plmDrawingNo: 'D2', erpMaterialCode: 'C2', erpMaterialInternalId: 'ITM_2', versionPolicy: 'drawing_only', matchStatus: 'pending_confirm', isActive: true })
    await confirmMaterialMapping({ permission: 'admin', recordsApi: api2, provisioning: makeProvisioning(), targetProjectId: STAGING_PROJECT_ID, mappingId: 'map_2', confirmedBy: OPERATOR, notes: 'checked against ERP' })
    assert.deepEqual(Object.keys(api2.patchCalls[0].changes).sort(), ['confirmedAt', 'confirmedBy', 'matchStatus', 'notes'])
  })

  await run('R6 confirm-existing gates: 404 / key-ambiguous 500 / inactive 409 / already-confirmed skip / target-incomplete 409', async () => {
    const provisioning = makeProvisioning()
    const base = (api, mappingId) => ({ permission: 'admin', recordsApi: api, provisioning, targetProjectId: STAGING_PROJECT_ID, mappingId, confirmedBy: OPERATOR })
    const api = makeRecordsApi()
    await expectError(confirmMaterialMapping(base(api, 'missing')), { status: 404, code: 'CONFIRM_MAPPING_NOT_FOUND' })
    api.seed(SHEET.mapping, { mappingId: 'dup', plmDrawingNo: 'D', erpMaterialCode: 'C', erpMaterialInternalId: 'I', matchStatus: 'pending_confirm', isActive: true })
    api.seed(SHEET.mapping, { mappingId: 'dup', plmDrawingNo: 'D', erpMaterialCode: 'C', erpMaterialInternalId: 'I', matchStatus: 'pending_confirm', isActive: true })
    await expectError(confirmMaterialMapping(base(api, 'dup')), { status: 500, code: 'CONFIRM_KEY_AMBIGUOUS' })
    api.seed(SHEET.mapping, { mappingId: 'retired', plmDrawingNo: 'D', erpMaterialCode: 'C', erpMaterialInternalId: 'I', matchStatus: 'pending_confirm', isActive: false })
    await expectError(confirmMaterialMapping(base(api, 'retired')), { status: 409, code: 'CONFIRM_MAPPING_INACTIVE' })
    api.seed(SHEET.mapping, { mappingId: 'done', plmDrawingNo: 'D', erpMaterialCode: 'C', erpMaterialInternalId: 'I', matchStatus: 'matched', isActive: true, confirmedBy: OPERATOR, confirmedAt: '2026-07-01T00:00:00.000Z' })
    const patchesBefore = api.patchCalls.length
    const skipped = await confirmMaterialMapping(base(api, 'done'))
    assert.equal(skipped.persisted, false)
    assert.equal(skipped.mode, 'skipped_already_confirmed')
    assert.equal(api.patchCalls.length, patchesBefore)
    // A candidate without the full ERP identity can never be selected by the engines — refuse.
    api.seed(SHEET.mapping, { mappingId: 'incomplete', plmDrawingNo: 'D', erpMaterialCode: 'C', matchStatus: 'not_found', isActive: true })
    await expectError(confirmMaterialMapping(base(api, 'incomplete')), { status: 409, code: 'CONFIRM_MAPPING_TARGET_INCOMPLETE' })
    assert.equal(api.patchCalls.length, patchesBefore)
  })

  // ---- (i) R6 create-confirmed ----
  await run('R6 create-confirmed validates the closed allowlist and required fields', async () => {
    const provisioning = makeProvisioning()
    const create = (api, mapping) => confirmMaterialMapping({ permission: 'admin', recordsApi: api, provisioning, targetProjectId: STAGING_PROJECT_ID, mapping, confirmedBy: OPERATOR })
    const api = makeRecordsApi()
    const unknown = await expectError(create(api, { plmDrawingNo: 'D', erpMaterialCode: 'C', erpMaterialInternalId: 'I', versionPolicy: 'drawing_only', confirmedBy: 'evil' }), { status: 400, code: 'CONFIRM_MAPPING_FIELDS_INVALID' })
    assert.equal(unknown.details.field, 'confirmedBy')
    await expectError(create(api, { erpMaterialCode: 'C', erpMaterialInternalId: 'I', versionPolicy: 'drawing_only' }), { status: 400, code: 'CONFIRM_MAPPING_FIELDS_INVALID' })
    await expectError(create(api, { plmDrawingNo: 'D', erpMaterialInternalId: 'I', versionPolicy: 'drawing_only' }), { status: 400, code: 'CONFIRM_MAPPING_FIELDS_INVALID' })
    await expectError(create(api, { plmDrawingNo: 'D', erpMaterialCode: 'C', versionPolicy: 'drawing_only' }), { status: 400, code: 'CONFIRM_MAPPING_FIELDS_INVALID' })
    await expectError(create(api, { plmDrawingNo: 'D', erpMaterialCode: 'C', erpMaterialInternalId: 'I', versionPolicy: 'bogus' }), { status: 400, code: 'CONFIRM_MAPPING_FIELDS_INVALID' })
    await expectError(create(api, { plmDrawingNo: 'D', erpMaterialCode: 'C', erpMaterialInternalId: 'I', versionPolicy: 'drawing_and_version' }), { status: 400, code: 'CONFIRM_MAPPING_FIELDS_INVALID' })
    assert.equal(api.createCalls.length, 0)
  })

  await run('R6 create-confirmed persists a grounded manual_confirm row and replays skip', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    const input = {
      permission: 'admin', recordsApi: api, provisioning, targetProjectId: STAGING_PROJECT_ID, confirmedBy: OPERATOR,
      mapping: { plmDrawingNo: LEAKY_DRAWING, plmVersion: 'V1', erpMaterialCode: 'C1', erpMaterialInternalId: 'ITM_1', versionPolicy: 'drawing_and_version', notes: 'manual entry' },
    }
    const result = await confirmMaterialMapping(input)
    assert.equal(result.persisted, true)
    assert.equal(result.mode, 'created')
    const write = api.createCalls.find((call) => call.sheetId === SHEET.mapping)
    assert.ok(write)
    for (const key of Object.keys(write.data)) {
      assert.ok(MAPPING_FIELD_ID_SET.has(key), `created mapping key ${key} must be template-declared`)
    }
    assert.equal(write.data.matchStatus, 'matched')
    assert.equal(write.data.matchMethod, MANUAL_CONFIRM_MATCH_METHOD)
    assert.equal(write.data.confidence, 1)
    assert.equal(write.data.isActive, true)
    assert.equal(write.data.confirmedBy, OPERATOR)
    assert.ok(write.data.confirmedAt)
    assertNoSecret(result, 'R6 create result')
    const replay = await confirmMaterialMapping(input)
    assert.equal(replay.persisted, false)
    assert.equal(replay.mode, 'skipped_existing')
    assert.equal(replay.mappingId, result.mappingId)
    assert.equal(api.createCalls.filter((call) => call.sheetId === SHEET.mapping).length, 1)
  })

  // ---- (j) R7 retire ----
  await run('R7 retire patches EXACTLY isActive:false; replay skips; unknown 404', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    api.seed(SHEET.mapping, { mappingId: 'map_r', plmDrawingNo: 'D', erpMaterialCode: 'C', erpMaterialInternalId: 'I', matchStatus: 'matched', isActive: true, confirmedBy: OPERATOR, confirmedAt: '2026-07-01T00:00:00.000Z' })
    const result = await retireMaterialMapping({ permission: 'admin', recordsApi: api, provisioning, targetProjectId: STAGING_PROJECT_ID, mappingId: 'map_r' })
    assert.equal(result.mode, 'retired')
    assert.deepEqual(api.patchCalls[0].changes, { isActive: false })
    const replay = await retireMaterialMapping({ permission: 'admin', recordsApi: api, provisioning, targetProjectId: STAGING_PROJECT_ID, mappingId: 'map_r' })
    assert.equal(replay.persisted, false)
    assert.equal(replay.mode, 'skipped_inactive')
    assert.equal(api.patchCalls.length, 1)
    await expectError(
      retireMaterialMapping({ permission: 'admin', recordsApi: api, provisioning, targetProjectId: STAGING_PROJECT_ID, mappingId: 'nope' }),
      { status: 404, code: 'CONFIRM_MAPPING_NOT_FOUND' },
    )
  })

  // ---- (k) R10 ----
  await run('R10 rejects zero or multiple modes', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    const base = { permission: 'admin', recordsApi: api, provisioning, targetProjectId: STAGING_PROJECT_ID, confirmedBy: OPERATOR }
    await expectError(confirmUnitConversionRule({ ...base }), { status: 400, code: 'CONFIRM_MODE_AMBIGUOUS' })
    await expectError(confirmUnitConversionRule({ ...base, conversionRuleId: 'r1', rule: { plmUnit: 'kg' } }), { status: 400, code: 'CONFIRM_MODE_AMBIGUOUS' })
    await expectError(confirmUnitConversionRule({ ...base, conversionRuleId: 'r1', contextFingerprint: 'sha16:aa', rule: { plmUnit: 'kg' } }), { status: 400, code: 'CONFIRM_MODE_AMBIGUOUS' })
  })

  await run('R10 mode-a stamps a manual rule; system_candidate unstamped is refused; gates hold', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    const base = (conversionRuleId) => ({ permission: 'admin', recordsApi: api, provisioning, targetProjectId: STAGING_PROJECT_ID, conversionRuleId, confirmedBy: OPERATOR })
    await expectError(confirmUnitConversionRule(base('missing')), { status: 404, code: 'CONFIRM_UNIT_RULE_NOT_FOUND' })
    api.seed(SHEET.rule, { conversionRuleId: 'rule_manual', plmUnit: 'kg', erpIssueUnit: 'g', conversionFactor: 1000, scopeType: 'generic', source: MANUAL_RULE_SOURCE, requiresConfirmation: true, isActive: true })
    const result = await confirmUnitConversionRule(base('rule_manual'))
    assert.equal(result.mode, 'confirmed')
    assert.deepEqual(Object.keys(api.patchCalls[0].changes).sort(), ['confirmedAt', 'confirmedBy'])
    const replay = await confirmUnitConversionRule(base('rule_manual'))
    assert.equal(replay.mode, 'skipped_already_confirmed')
    assert.equal(api.patchCalls.length, 1)
    api.seed(SHEET.rule, { conversionRuleId: 'rule_sys', plmUnit: 'm', erpIssueUnit: 'm', conversionFactor: 1, scopeType: 'material', scopeKey: 'ITM_1', source: 'system_candidate', requiresConfirmation: true, isActive: true })
    await expectError(confirmUnitConversionRule(base('rule_sys')), { status: 409, code: 'CONFIRM_UNIT_RULE_SOURCE_UNCONFIRMABLE' })
    assert.equal(api.patchCalls.length, 1)
    api.seed(SHEET.rule, { conversionRuleId: 'rule_off', plmUnit: 'kg', erpIssueUnit: 't', conversionFactor: 0.001, scopeType: 'generic', source: MANUAL_RULE_SOURCE, isActive: false })
    await expectError(confirmUnitConversionRule(base('rule_off')), { status: 409, code: 'CONFIRM_UNIT_RULE_INACTIVE' })
  })

  await run('R10 mode-b persists the server-derived 1:1 candidate for a live fingerprint; stale => 409', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    const batch = seedCompleteBatch(api)
    seedMaterials(api)
    // Confirmed mapping so the unit engine can resolve line -> material.
    api.seed(SHEET.mapping, { mappingId: 'map_ok', plmDrawingNo: LEAKY_DRAWING, plmVersion: 'V1', erpMaterialCode: LEAKY_DRAWING, erpMaterialInternalId: 'ITM_1', versionPolicy: 'drawing_and_version', matchStatus: 'matched', isActive: true, confirmedBy: OPERATOR, confirmedAt: '2026-07-01T00:00:00.000Z' })
    // Derive the live fingerprint the same way the module will (same engine, same fixture data).
    const engine = generateUnitConversionRuleCandidates({
      bomSnapshotLines: batch.lines,
      materialMappings: api.rowsOf(SHEET.mapping).map((row) => row.data),
      erpMaterials: api.rowsOf(SHEET.material).map((row) => row.data),
      unitConversionRules: [],
    })
    const candidate = engine.outcomes.find((entry) => entry.outcome === 'candidate')
    assert.ok(candidate, 'fixture must yield a 1:1 candidate')
    const input = {
      permission: 'admin', recordsApi: api, provisioning, targetProjectId: STAGING_PROJECT_ID,
      projectId: BUSINESS_PROJECT_ID, contextFingerprint: candidate.contextFingerprint, confirmedBy: OPERATOR,
    }
    const result = await confirmUnitConversionRule(input)
    assert.equal(result.persisted, true)
    assert.equal(result.mode, 'created')
    const write = api.createCalls.find((call) => call.sheetId === SHEET.rule)
    assert.ok(write)
    for (const key of Object.keys(write.data)) {
      assert.ok(RULE_FIELD_ID_SET.has(key), `created rule key ${key} must be template-declared`)
    }
    assert.equal(write.data.conversionFactor, 1)
    assert.equal(write.data.scopeType, 'material')
    assert.equal(write.data.source, 'system_candidate')
    assert.equal(write.data.confirmedBy, OPERATOR)
    assert.ok(write.data.confirmedAt)
    assertNoSecret(result, 'R10 mode-b result')
    // Replay: the confirmed rule now matches, so the context is REUSED — no live candidate => 409.
    await expectError(confirmUnitConversionRule(input), { status: 409, code: 'CONFIRM_UNIT_CANDIDATE_NOT_FOUND' })
    assert.equal(api.createCalls.filter((call) => call.sheetId === SHEET.rule).length, 1)
    // Bogus fingerprint => 409.
    await expectError(
      confirmUnitConversionRule({ ...input, contextFingerprint: 'sha16:deadbeefdeadbeef' }),
      { status: 409, code: 'CONFIRM_UNIT_CANDIDATE_NOT_FOUND' },
    )
  })

  await run('R10 mode-c validation battery rejects every malformed rule', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    const create = (rule) => confirmUnitConversionRule({ permission: 'admin', recordsApi: api, provisioning, targetProjectId: STAGING_PROJECT_ID, rule, confirmedBy: OPERATOR })
    const good = { plmUnit: 'kg', erpIssueUnit: 'g', conversionFactor: 1000, scopeType: 'generic' }
    for (const [label, rule] of [
      ['unknown key', { ...good, source: 'manual' }],
      ['factor 0', { ...good, conversionFactor: 0 }],
      ['factor negative', { ...good, conversionFactor: -1 }],
      ['factor NaN', { ...good, conversionFactor: 'abc' }],
      ['bad rounding', { ...good, roundingRule: 'round_up' }],
      ['bad scope', { ...good, scopeType: 'tenant' }],
      ['material without scopeKey', { ...good, scopeType: 'material' }],
      ['generic with scopeKey', { ...good, scopeKey: 'ITM_1' }],
      ['negative lossRate', { ...good, lossRate: -0.1 }],
      ['negative minimumIssueQty', { ...good, minimumIssueQty: -5 }],
      ['missing plmUnit', { erpIssueUnit: 'g', conversionFactor: 1, scopeType: 'generic' }],
      ['missing erpIssueUnit', { plmUnit: 'kg', conversionFactor: 1, scopeType: 'generic' }],
    ]) {
      await expectError(create(rule), { status: 400, code: 'CONFIRM_UNIT_RULE_FIELDS_INVALID' }).catch((error) => {
        throw new Error(`${label}: ${error.message}`)
      })
    }
    assert.equal(api.createCalls.length, 0)
  })

  await run('R10 mode-c creates a manual rule; exact replay skips; retire-then-different-factor mints a new id', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    const create = (rule) => confirmUnitConversionRule({ permission: 'admin', recordsApi: api, provisioning, targetProjectId: STAGING_PROJECT_ID, rule, confirmedBy: OPERATOR })
    const rule = { plmUnit: LEAKY_UNIT, erpIssueUnit: 'g', conversionFactor: 1000, scopeType: 'material', scopeKey: 'ITM_1', roundingRule: 'ceil', minimumIssueQty: 10 }
    const created = await create(rule)
    assert.equal(created.mode, 'created')
    const write = api.createCalls.find((call) => call.sheetId === SHEET.rule)
    assert.equal(write.data.source, MANUAL_RULE_SOURCE)
    assert.equal(write.data.requiresConfirmation, true)
    assert.equal(write.data.isActive, true)
    assert.equal(write.data.confirmedBy, OPERATOR)
    assert.equal(write.data.lossRate, 0)
    assertNoSecret(created, 'R10 mode-c result')
    const replay = await create(rule)
    assert.equal(replay.mode, 'skipped_existing')
    assert.equal(replay.conversionRuleId, created.conversionRuleId)
    // retire, then re-create with a DIFFERENT factor: full-content hash must mint a fresh id.
    await retireUnitConversionRule({ permission: 'admin', recordsApi: api, provisioning, targetProjectId: STAGING_PROJECT_ID, conversionRuleId: created.conversionRuleId })
    const recreated = await create({ ...rule, conversionFactor: 500 })
    assert.equal(recreated.mode, 'created')
    assert.notEqual(recreated.conversionRuleId, created.conversionRuleId)
  })

  await run('R11 retire patches exactly isActive:false; replay skips; unknown 404', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    api.seed(SHEET.rule, { conversionRuleId: 'rule_x', plmUnit: 'kg', erpIssueUnit: 'g', conversionFactor: 1000, scopeType: 'generic', source: MANUAL_RULE_SOURCE, isActive: true, confirmedBy: OPERATOR, confirmedAt: '2026-07-01T00:00:00.000Z' })
    const result = await retireUnitConversionRule({ permission: 'admin', recordsApi: api, provisioning, targetProjectId: STAGING_PROJECT_ID, conversionRuleId: 'rule_x' })
    assert.equal(result.mode, 'retired')
    assert.deepEqual(api.patchCalls[0].changes, { isActive: false })
    const replay = await retireUnitConversionRule({ permission: 'admin', recordsApi: api, provisioning, targetProjectId: STAGING_PROJECT_ID, conversionRuleId: 'rule_x' })
    assert.equal(replay.mode, 'skipped_inactive')
    assert.equal(api.patchCalls.length, 1)
    await expectError(
      retireUnitConversionRule({ permission: 'admin', recordsApi: api, provisioning, targetProjectId: STAGING_PROJECT_ID, conversionRuleId: 'nope' }),
      { status: 404, code: 'CONFIRM_UNIT_RULE_NOT_FOUND' },
    )
  })

  // ---- (l) cross-project reuse ----
  await run('a mapping confirmed under project A resolves project B lines (no new pending row)', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    // Project B batch whose single line matches the mapping confirmed during project A's flow.
    seedCompleteBatch(api, {
      snapshotBatchId: 'batch_b', projectId: OTHER_PROJECT_ID,
      lines: [{ snapshotLineId: 'b_l1', snapshotBatchId: 'batch_b', projectId: OTHER_PROJECT_ID, childDrawingNo: LEAKY_DRAWING, childVersion: 'V1', designUnit: 'pcs', designQty: 1 }],
    })
    api.seed(SHEET.mapping, { mappingId: 'map_a', plmDrawingNo: LEAKY_DRAWING, plmVersion: 'V1', erpMaterialCode: LEAKY_DRAWING, erpMaterialInternalId: 'ITM_1', versionPolicy: 'drawing_and_version', matchStatus: 'matched', isActive: true, confirmedBy: OPERATOR, confirmedAt: '2026-07-01T00:00:00.000Z' })
    const result = await syncMaterialMappingCandidates(baseSyncInput(api, provisioning, { projectId: OTHER_PROJECT_ID }))
    assert.equal(result.status, 'matched')
    assert.equal(result.created.mappings, 0)
    assert.equal(api.createCalls.filter((call) => call.sheetId === SHEET.mapping).length, 0)
  })

  // ---- (m) held/待确认 propagation on snapshot change ----
  await run('drawing_and_version version bump creates a NEW pending row and never patches the confirmed row', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    seedMaterials(api)
    api.seed(SHEET.mapping, { mappingId: 'map_v1', plmDrawingNo: LEAKY_DRAWING, plmVersion: 'V1', erpMaterialCode: LEAKY_DRAWING, erpMaterialInternalId: 'ITM_1', versionPolicy: 'drawing_and_version', matchStatus: 'matched', isActive: true, confirmedBy: OPERATOR, confirmedAt: '2026-07-01T00:00:00.000Z' })
    // v2 batch: the SAME drawing at a NEW version — stops matching under drawing_and_version.
    seedCompleteBatch(api, {
      snapshotBatchId: 'batch_2', snapshotVersion: 2,
      lines: [{ snapshotLineId: 'l_v2', snapshotBatchId: 'batch_2', projectId: BUSINESS_PROJECT_ID, childDrawingNo: LEAKY_DRAWING, childVersion: 'V2', designUnit: 'pcs', designQty: 1 }],
    })
    const result = await syncMaterialMappingCandidates(baseSyncInput(api, provisioning))
    assert.equal(result.created.mappings, 1)
    const write = api.createCalls.find((call) => call.sheetId === SHEET.mapping)
    assert.notEqual(write.data.matchStatus, 'matched')
    assert.equal(api.patchCalls.length, 0)
    // drawing_only twin: fresh store, same version bump, confirmed row KEEPS matching => nothing new.
    const api2 = makeRecordsApi()
    seedMaterials(api2)
    api2.seed(SHEET.mapping, { mappingId: 'map_v1', plmDrawingNo: LEAKY_DRAWING, plmVersion: 'V1', erpMaterialCode: LEAKY_DRAWING, erpMaterialInternalId: 'ITM_1', versionPolicy: 'drawing_only', matchStatus: 'matched', isActive: true, confirmedBy: OPERATOR, confirmedAt: '2026-07-01T00:00:00.000Z' })
    seedCompleteBatch(api2, {
      snapshotBatchId: 'batch_2', snapshotVersion: 2,
      lines: [{ snapshotLineId: 'l_v2', snapshotBatchId: 'batch_2', projectId: BUSINESS_PROJECT_ID, childDrawingNo: LEAKY_DRAWING, childVersion: 'V2', designUnit: 'pcs', designQty: 1 }],
    })
    const result2 = await syncMaterialMappingCandidates(baseSyncInput(api2, makeProvisioning(), { defaultVersionPolicy: 'drawing_only' }))
    assert.equal(result2.created.mappings, 0)
    assert.equal(result2.status, 'matched')
  })

  // ---- review follow-ups (#4015): direct guard tests ----
  await run('groundRow strips excluded human fields even when the row carries them (belt-and-suspenders)', async () => {
    const { __internals } = require(path.join(__dirname, '..', 'lib', 'stock-preparation-confirm-writes.cjs'))
    const grounded = __internals.groundRow(
      MAPPING_FIELD_IDS,
      { mappingId: 'gm1', plmDrawingNo: 'D', confirmedBy: 'evil', confirmedAt: '2026-01-01T00:00:00.000Z', notes: 'evil-note' },
      MAPPING_HUMAN_FIELD_IDS,
    )
    assert.equal(grounded.confirmedBy, undefined)
    assert.equal(grounded.confirmedAt, undefined)
    assert.equal(grounded.notes, undefined)
    assert.equal(grounded.mappingId, 'gm1')
  })

  await run('R5 with a missing targetProjectId fails closed 422 before any IO', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    await expectError(
      syncMaterialMappingCandidates({ permission: 'admin', recordsApi: api, provisioning, targetProjectId: '', projectId: BUSINESS_PROJECT_ID, defaultVersionPolicy: 'drawing_only' }),
      { status: 422, code: 'CONFIRM_CONFIG_INVALID' },
    )
    assert.equal(provisioning.findObjectSheetCalls, 0)
    assert.equal(api.createCalls.length + api.patchCalls.length + api.queryCalls.length, 0)
  })

  await run('R6 create-confirmed honors top-level notes when mapping.notes is absent', async () => {
    const api = makeRecordsApi()
    const provisioning = makeProvisioning()
    await confirmMaterialMapping({
      permission: 'admin', recordsApi: api, provisioning, targetProjectId: STAGING_PROJECT_ID, confirmedBy: OPERATOR, notes: 'top-level note',
      mapping: { plmDrawingNo: 'DN', erpMaterialCode: 'C9', erpMaterialInternalId: 'ITM_9', versionPolicy: 'drawing_only' },
    })
    const write = api.createCalls.find((call) => call.sheetId === SHEET.mapping)
    assert.equal(write.data.notes, 'top-level note')
  })

  const total = passed + failed
  console.log(`\nstock-preparation-confirm-writes: ${passed}/${total} passed`)
  if (failed > 0) {
    console.error(`${failed} test(s) failed`)
    process.exit(1)
  }
  console.log('✓ stock-preparation-confirm-writes')
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
