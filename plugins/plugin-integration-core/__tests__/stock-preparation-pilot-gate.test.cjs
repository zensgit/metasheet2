'use strict'

// 备料分批拉取第一期 step 3 PR B — THE PILOT LANE GATE, THE READINESS EVALUATOR, THE REGISTRY'S PILOT
// SURFACE and the lib hooks, hermetic (plan §5.1 / §9.4 L01–L05 / §9.5 U05; step-4 design §12, D8).
//
//   G-01 the codes, the large-lane vocabulary and the two states are pinned; an unknown lane is 500 before any read
//   G-02 NO store (no plugin SQL db): `not_pilot` and `registry: 'absent'`, by name; a store that EXISTS but lacks
//        the pilot reads is 503 STATE_UNREADABLE — a wiring defect never reads as "not pilot"
//   G-03 by (tenant, project) AND by sheet: either row pilot ⇒ `pilot`; neither ⇒ `not_pilot`; a row read on a
//        database without migration 101 (no column at all) ⇒ not pilot
//   G-04 A FAILED READ IS UNREADABLE, NEVER NOT PILOT: a throwing store ⇒ 503 STATE_UNREADABLE with the operation
//        and the SQLSTATE class code only (values-free), on both reads
//   G-05 assertLargeLaneAllowed: pilot ⇒ 409 LARGE_LANE_REFUSED naming the lane + two booleans + partial:false;
//        not pilot ⇒ the read; unreadable ⇒ the 503
//   G-06 the small lane's over-cap rule: pilot ⇒ 409 SMALL_LANE_LIMIT_EXCEEDED; not pilot ⇒ the read
//   G-07 THE LIB HOOK (L03): `dryRunStockPreparationAction` runs `pilotLaneGuard` only when the expansion hit a
//        small-lane cap, BEFORE the token block — a throwing guard mints no token; an unbounded run never calls it;
//        no guard ⇒ the pre-PR-B answer (`large_bom_bounded`) byte for byte
//   R-01 readiness: every check passes on a satisfied fake ⇒ ready, failing [], version 1, the id list pinned
//   R-02 EVERY CHECK FAILS CLOSED ON ITS OWN: one mutation per check id ⇒ exactly the expected failing set, the
//        continuation marker included (the build literal is 0 until step 4 PR-3 flips it)
//   R-03 a probe that throws is `ok: false`, never a thrown readiness; the answer is values-free
//   R-04 collectGenericWriterTargets: both registries must answer (else incomplete); object configs and pipeline
//        erp-feedback options are collected; a throwing registry is incomplete
//   S-13 rowToPilotState: no column ⇒ not pilot; the three columns project as handles / clock / integer; the public
//        target projection is UNCHANGED (no pilot key)
//   S-14 markPilotEnabled: ONE transaction, the tenant lock, the row FOR UPDATE, ONE compare-and-set update whose
//        where repeats status 'active' AND pilot_enabled_at IS NULL and whose set carries the three columns together
//        (migration 101's CHECK holds); the second call answers alreadyEnabled with the ORIGINAL stamp and no update
//   S-15 markPilotEnabled refusals: ABSENT / ARCHIVED 409 with no update; a bad readinessVersion 422 before any db
//        call; the CAS backstop (an update that matches nothing) is 409 STATE_MOVED, never a silent success
//   S-16 probeTableReadable: readable / 42P01 undefined_table / any other failure read_failed with its SQLSTATE
//
// Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const {
  PILOT_ERROR_CODES,
  PILOT_LARGE_LANES,
  PILOT_STATES,
  StockPreparationPilotError,
  createStockPreparationPilotGate,
} = require(path.join(LIB, 'stock-preparation-pilot-gate.cjs'))
const readiness = require(path.join(LIB, 'stock-preparation-pilot-readiness.cjs'))
const continuationSupport = require(path.join(LIB, 'stock-preparation-continuation-support.cjs'))
const {
  PROJECT_TARGET_TABLE,
  PROJECT_TARGET_CREATE_LOCK_PREFIX,
  PROJECT_TARGET_PILOT_STATE_MOVED_CODE,
  StockPreparationProjectTargetStoreError,
  createStockPreparationProjectTargetStore,
  rowToPilotState,
  __internals: storeInternals,
} = require(path.join(LIB, 'stock-preparation-project-target-store.cjs'))
const { PROJECT_SHEET_PLM_SYSTEM_FIELD_IDS } = require(path.join(LIB, 'stock-preparation-project-targets.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE, normalizeStockPreparationTemplate } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const { templateContractOptionFields } = require(path.join(LIB, 'stock-preparation-option-sync.cjs'))
const { dryRunStockPreparationAction } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const kit = require('./support/stock-preparation-project-write-lock-kit.cjs')

const TENANT = 'tenant-syn-pilot'
const PROJECT = 'PRJ-SYN-PILOT-01'
const OTHER_PROJECT = 'PRJ-SYN-PILOT-02'
const SHEET = 'sheet_syn_pilot_01'
const OTHER_SHEET = 'sheet_syn_pilot_02'
const OBJECT = 'plm_stock_preparation_sandbox_p_0123456789abcdef01234567'
const PROJECT_ID = `${TENANT}:integration-core`
const AT = new Date('2026-10-23T08:00:00Z')

const tests = []
const test = (name, fn) => tests.push([name, fn])

async function rejects(promise, { status, code }) {
  let caught = null
  try { await promise } catch (error) { caught = error }
  assert.ok(caught, `expected ${code}`)
  assert.equal(caught.code, code, `${caught.name}: ${caught.message}`)
  if (status !== undefined) assert.equal(caught.status, status)
  return caught
}

// A registry store double answering the two pilot reads from `rows`; `fail` makes every read throw it.
function fakeStore(rows = [], { fail = null, methods = ['getPilotState', 'getPilotStateBySheetId'] } = {}) {
  const calls = []
  const store = { calls }
  const find = (predicate) => rowToPilotState(rows.find(predicate) || null)
  if (methods.includes('getPilotState')) {
    store.getPilotState = async ({ tenantId, projectNo }) => { calls.push(['byProject', tenantId, projectNo]); if (fail) throw fail; return find((r) => r.tenant_id === tenantId && r.project_no === projectNo) }
  }
  if (methods.includes('getPilotStateBySheetId')) {
    store.getPilotStateBySheetId = async ({ sheetId }) => { calls.push(['bySheet', sheetId]); if (fail) throw fail; return find((r) => r.sheet_id === sheetId) }
  }
  return store
}

const row = (overrides = {}) => ({
  tenant_id: TENANT, project_no: PROJECT, sheet_id: SHEET, object_id: OBJECT, status: 'active',
  pilot_enabled_at: null, pilot_enabled_by: null, pilot_readiness_version: null, ...overrides,
})
const pilotRow = (overrides = {}) => row({ pilot_enabled_at: AT, pilot_enabled_by: 'u_admin', pilot_readiness_version: 1, ...overrides })

// ── the gate ────────────────────────────────────────────────────────────────────────────────────────

test('G-01 codes, lanes and states are pinned; an unknown lane is refused 500 before any read', async () => {
  assert.deepEqual(PILOT_ERROR_CODES, {
    LARGE_LANE_REFUSED: 'STOCK_PREP_PILOT_LARGE_LANE_REFUSED',
    SMALL_LANE_LIMIT_EXCEEDED: 'STOCK_PREP_PILOT_SMALL_LANE_LIMIT_EXCEEDED',
    STATE_UNREADABLE: 'STOCK_PREP_PILOT_STATE_UNREADABLE',
    NOT_READY: 'STOCK_PREP_PILOT_NOT_READY',
  })
  assert.deepEqual(PILOT_LARGE_LANES, ['large_expansion_start', 'large_expansion_run', 'large_plan', 'large_approve', 'large_apply_chunk'])
  assert.deepEqual(PILOT_STATES, ['pilot', 'not_pilot'])
  const store = fakeStore([pilotRow()])
  const gate = createStockPreparationPilotGate({ store })
  const caught = await rejects(gate.assertLargeLaneAllowed({ tenantId: TENANT, projectNo: PROJECT, sheetId: SHEET }, 'small_apply'), { status: 500, code: PILOT_ERROR_CODES.STATE_UNREADABLE })
  assert.equal(caught.details.reason, 'lane_unknown')
  assert.deepEqual(store.calls, [], 'an unknown lane costs no read')
})

test('G-02 no store ⇒ not_pilot by name (registry absent); a store without the pilot reads ⇒ 503, never not_pilot', async () => {
  const absent = createStockPreparationPilotGate({ store: null })
  assert.deepEqual(await absent.readPilotState({ tenantId: TENANT, projectNo: PROJECT, sheetId: SHEET }), { state: 'not_pilot', byProject: false, bySheet: false, registry: 'absent' })
  for (const methods of [[], ['getPilotState'], ['getPilotStateBySheetId']]) {
    const partial = createStockPreparationPilotGate({ store: fakeStore([pilotRow()], { methods }) })
    const caught = await rejects(partial.readPilotState({ tenantId: TENANT, projectNo: PROJECT, sheetId: SHEET }), { status: 503, code: PILOT_ERROR_CODES.STATE_UNREADABLE })
    assert.equal(caught.details.operation, 'store_surface')
    assert.equal(caught.details.partial, false)
  }
})

test('G-03 pilot by project OR by sheet; neither ⇒ not_pilot; a row without the 101 column ⇒ not pilot', async () => {
  const rows = [pilotRow(), row({ project_no: OTHER_PROJECT, sheet_id: OTHER_SHEET })]
  const gate = createStockPreparationPilotGate({ store: fakeStore(rows) })
  assert.deepEqual(await gate.readPilotState({ tenantId: TENANT, projectNo: PROJECT, sheetId: SHEET }), { state: 'pilot', byProject: true, bySheet: true, registry: 'present' })
  // L04: the pilot project number through ANOTHER sheet (a stored snapshot) — still pilot, by project.
  assert.deepEqual(await gate.readPilotState({ tenantId: TENANT, projectNo: PROJECT, sheetId: OTHER_SHEET }), { state: 'pilot', byProject: true, bySheet: false, registry: 'present' })
  // L04: another project number targeting the pilot SHEET — still pilot, by sheet.
  assert.deepEqual(await gate.readPilotState({ tenantId: TENANT, projectNo: OTHER_PROJECT, sheetId: SHEET }), { state: 'pilot', byProject: false, bySheet: true, registry: 'present' })
  assert.deepEqual(await gate.readPilotState({ tenantId: TENANT, projectNo: OTHER_PROJECT, sheetId: OTHER_SHEET }), { state: 'not_pilot', byProject: false, bySheet: false, registry: 'present' })
  // Only a sheet, only a project: each read runs alone.
  const store = fakeStore(rows)
  const alone = createStockPreparationPilotGate({ store })
  await alone.readPilotState({ sheetId: SHEET })
  await alone.readPilotState({ tenantId: TENANT, projectNo: PROJECT })
  assert.deepEqual(store.calls, [['bySheet', SHEET], ['byProject', TENANT, PROJECT]])
  // A database where migration 101 has not run: the row has NO pilot key at all.
  const legacy = { tenant_id: TENANT, project_no: PROJECT, sheet_id: SHEET, object_id: OBJECT, status: 'active' }
  const preMigration = createStockPreparationPilotGate({ store: fakeStore([legacy]) })
  assert.equal((await preMigration.readPilotState({ tenantId: TENANT, projectNo: PROJECT, sheetId: SHEET })).state, 'not_pilot')
})

test('G-04 a FAILED read is 503 STATE_UNREADABLE (operation + SQLSTATE class only), never not_pilot — on both reads', async () => {
  for (const [label, fail, sqlState] of [
    ['undefined table', Object.assign(new Error('relation does not exist'), { code: '42P01' }), '42P01'],
    ['connection', new Error('connection reset'), undefined],
  ]) {
    const gate = createStockPreparationPilotGate({ store: fakeStore([pilotRow()], { fail }) })
    for (const input of [{ tenantId: TENANT, projectNo: PROJECT }, { sheetId: SHEET }, { tenantId: TENANT, projectNo: PROJECT, sheetId: SHEET }]) {
      const caught = await rejects(gate.readPilotState(input), { status: 503, code: PILOT_ERROR_CODES.STATE_UNREADABLE })
      assert.ok(caught instanceof StockPreparationPilotError)
      assert.deepEqual(caught.details, { operation: 'pilot_state_read', ...(sqlState ? { sqlState } : {}), partial: false }, label)
      assert.ok(!JSON.stringify(caught).includes('connection reset'), 'the store message never travels')
      for (const lane of PILOT_LARGE_LANES) await rejects(gate.assertLargeLaneAllowed(input, lane), { status: 503, code: PILOT_ERROR_CODES.STATE_UNREADABLE })
      await rejects(gate.assertSmallLaneCapNotExceededForPilot(input), { status: 503, code: PILOT_ERROR_CODES.STATE_UNREADABLE })
    }
  }
})

test('G-05 assertLargeLaneAllowed: pilot ⇒ 409 LARGE_LANE_REFUSED naming the lane; not pilot ⇒ the read', async () => {
  const gate = createStockPreparationPilotGate({ store: fakeStore([pilotRow(), row({ project_no: OTHER_PROJECT, sheet_id: OTHER_SHEET })]) })
  for (const lane of PILOT_LARGE_LANES) {
    const caught = await rejects(gate.assertLargeLaneAllowed({ tenantId: TENANT, projectNo: PROJECT, sheetId: SHEET }, lane), { status: 409, code: PILOT_ERROR_CODES.LARGE_LANE_REFUSED })
    assert.deepEqual(caught.details, { lane, reason: 'pilot_project', byProject: true, bySheet: true, partial: false })
    const text = JSON.stringify({ message: caught.message, details: caught.details })
    assert.ok(!text.includes(PROJECT) && !text.includes(SHEET) && !text.includes(TENANT), 'values-free refusal')
  }
  assert.equal((await gate.assertLargeLaneAllowed({ tenantId: TENANT, projectNo: OTHER_PROJECT, sheetId: OTHER_SHEET }, 'large_plan')).state, 'not_pilot')
})

test('G-06 the small lane over-cap rule: pilot ⇒ 409 SMALL_LANE_LIMIT_EXCEEDED; not pilot ⇒ the read', async () => {
  const gate = createStockPreparationPilotGate({ store: fakeStore([pilotRow()]) })
  const caught = await rejects(gate.assertSmallLaneCapNotExceededForPilot({ tenantId: TENANT, projectNo: PROJECT, sheetId: SHEET }), { status: 409, code: PILOT_ERROR_CODES.SMALL_LANE_LIMIT_EXCEEDED })
  assert.deepEqual(caught.details, { reason: 'pilot_project', byProject: true, bySheet: true, partial: false })
  assert.equal((await gate.assertSmallLaneCapNotExceededForPilot({ tenantId: TENANT, projectNo: OTHER_PROJECT, sheetId: OTHER_SHEET })).state, 'not_pilot')
})

test('G-07 (L03) the dry run calls pilotLaneGuard only on a capped expansion, before the token block; no guard ⇒ large_bom_bounded unchanged', async () => {
  const harness = kit.createLibWriteLockHarness()
  const run = async ({ maxRows, guard }) => {
    const storage = kit.createConsumableStorage()
    const records = kit.createRecordsApi()
    const source = kit.createSourceAdapter(kit.goldenPlmData())
    const action = kit.goldenAction(maxRows ? { maxRows } : {})
    const input = { action, parameters: { projectNo: kit.GOLDEN_PROJECT_NO }, sourceAdapter: source.adapter, recordsApi: records.recordsApi, tokenStore: storage, plannedAt: kit.GOLDEN_PLANNED_AT, runId: kit.GOLDEN_RUN_ID, ...(guard ? { pilotLaneGuard: guard } : {}) }
    return { storage, result: await harness.wrapDryRun(dryRunStockPreparationAction)(input) }
  }
  // Calibration: the golden BOM is two rows; maxRows 1 bounds it.
  const bounded = await run({ maxRows: 1 })
  assert.equal(bounded.result.status, 'large_bom_bounded', 'calibration: the golden BOM exceeds maxRows 1')
  assert.equal(bounded.result.largeBom, true)
  assert.equal(bounded.result.dryRunToken, null)
  // The guard runs on the capped expansion, and a throwing guard ends the run with its own error and no token.
  let guardCalls = 0
  const refusal = new StockPreparationPilotError(409, PILOT_ERROR_CODES.SMALL_LANE_LIMIT_EXCEEDED, 'pilot', { reason: 'pilot_project', partial: false })
  let storage
  await rejects((async () => { const out = await run({ maxRows: 1, guard: async () => { guardCalls += 1; throw refusal } }); storage = out.storage; return out })(), { status: 409, code: PILOT_ERROR_CODES.SMALL_LANE_LIMIT_EXCEEDED })
  assert.equal(guardCalls, 1, 'the guard ran once')
  // A non-throwing guard on a capped expansion: the answer is the same bounded answer (nothing else changes).
  guardCalls = 0
  const passed = await run({ maxRows: 1, guard: async () => { guardCalls += 1 } })
  assert.equal(guardCalls, 1)
  assert.equal(passed.result.status, 'large_bom_bounded')
  // Byte-identical apart from the read's wall-clock millisecond count (plmReadPhase.wallMs is timing, not content).
  const canon = (result) => { const copy = JSON.parse(JSON.stringify(result)); if (copy.plmReadPhase) delete copy.plmReadPhase.wallMs; return copy }
  assert.deepEqual(canon(passed.result), canon(bounded.result), 'a passing guard changes nothing in the answer')
  assert.equal(passed.storage.calls.filter(([method]) => method === 'set').length, 0, 'no token stored on a capped expansion')
  // An UNBOUNDED run never consults the guard — the pilot read costs the small lane nothing on a normal pull.
  guardCalls = 0
  const normal = await run({ guard: async () => { guardCalls += 1; throw refusal } })
  assert.equal(guardCalls, 0, 'the guard is not consulted on an unbounded expansion')
  assert.equal(normal.result.status, 'ready')
  assert.equal(typeof normal.result.dryRunToken, 'string')
})

// ── readiness ───────────────────────────────────────────────────────────────────────────────────────

const TEMPLATE = normalizeStockPreparationTemplate(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)

function readyDeps(overrides = {}) {
  const fields = new Map(TEMPLATE.fields.map((field) => [field.id, { property: {} }]))
  for (const id of PROJECT_SHEET_PLM_SYSTEM_FIELD_IDS) fields.get(id).property.humanWriteLock = 'plm_system'
  for (const field of templateContractOptionFields(TEMPLATE)) fields.get(field.id).property.options = [{ value: 'syn_option' }]
  const provisioning = {
    async findObjectSheet({ objectId }) { return objectId === OBJECT ? { id: SHEET } : null },
    async resolveExistingObjectFieldIds({ fieldIds }) { return Object.fromEntries(fieldIds.filter((id) => fields.has(id)).map((id) => [id, `fld_${id}`])) },
    async resolveFieldIds({ fieldIds }) { return Object.fromEntries(fieldIds.map((id) => [id, `fld_${id}`])) },
    getObjectSheetId: () => SHEET,
    async getObjectField({ fieldId }) { const field = fields.get(fieldId); return field ? { id: `fld_${fieldId}`, property: { ...field.property } } : null },
    getObjectViewId: (_projectId, _objectId, viewId) => `view_${viewId}`,
    async closeSheetGridExport() { throw new Error('readiness must never stamp') },
    async getSheetGridExportClosure({ sheetId }) { return { sheetId, present: true, closure: null, closedAt: null, closedBy: null } },
  }
  return {
    fields,
    provisioning,
    row: { status: 'active', sheetId: SHEET, objectId: OBJECT },
    sheetId: SHEET,
    objectId: OBJECT,
    projectId: PROJECT_ID,
    projectNo: PROJECT,
    tenantId: TENANT,
    action: { source: { readPlan: { part: { specField: 'Specification' } } }, target: { sheetId: SHEET, objectId: OBJECT } },
    target: { sheetId: SHEET, objectId: OBJECT },
    recordsApi: { async queryRecords() { return [] } },
    assertTargetSheetHoldsNoForeignActiveRows: async () => {},
    lock: { async readState() { return { present: false, generation: 0, fencingEpoch: 0, leaseHeld: false } } },
    writeScope: 'spw2:syn',
    probeTableReadable: async () => ({ readable: true }),
    specReadPlanSlotDeclaration: null,
    collectGenericWriterTargets: async () => ({ complete: true, sheetIds: new Set(), objectIds: new Set() }),
    ...overrides,
  }
}

async function withContinuationSupport(version, fn) {
  const original = continuationSupport.CONTINUATION_SUPPORT_VERSION
  continuationSupport.CONTINUATION_SUPPORT_VERSION = version
  try { return await fn() } finally { continuationSupport.CONTINUATION_SUPPORT_VERSION = original }
}

test('R-01 every check passes on a satisfied fake ⇒ ready; the id list and the version are pinned; the answer is values-free', async () => {
  assert.equal(readiness.PILOT_READINESS_VERSION, 1)
  assert.equal(continuationSupport.CONTINUATION_SUPPORT_VERSION, 0, 'the build marker ships at 0 (step 4 PR-3 flips it)')
  assert.deepEqual(readiness.PILOT_READINESS_CHECK_IDS, [
    'registry_row_active', 'sheet_present', 'target_fields_present', 'plm_column_lock', 'contract_option_sets', 'views_present',
    'single_project_on_sheet', 'write_lock_store_readable', 'write_lock_free', 'export_closure_port',
    'continuation_store_readable', 'refresh_state_store_readable', 'spec_read_plan_slot', 'no_generic_writer_names_sheet', 'continuation_support_version',
  ])
  const answer = await withContinuationSupport(1, () => readiness.evaluatePilotReadiness(readyDeps()))
  assert.equal(answer.ready, true, JSON.stringify(answer.failing))
  assert.deepEqual([...answer.failing], [])
  assert.equal(answer.version, 1)
  assert.deepEqual(answer.checks.map((check) => check.id), [...readiness.PILOT_READINESS_CHECK_IDS])
  assert.ok(answer.checks.every((check) => check.ok === true))
  const text = JSON.stringify(answer)
  assert.ok(!text.includes(SHEET) && !text.includes(OBJECT) && !text.includes(PROJECT) && !text.includes(TENANT), 'values-free')
  // The default build (marker 0) refuses exactly the marker, nothing else.
  const shipped = await readiness.evaluatePilotReadiness(readyDeps())
  assert.deepEqual([...shipped.failing], ['continuation_support_version'])
  assert.equal(shipped.ready, false)
})

test('R-02 every check fails closed on its own: one mutation per id ⇒ exactly the expected failing set', async () => {
  const table = [
    ['registry_row_active', (d) => ({ row: { ...d.row, status: 'archived' } }), ['registry_row_active']],
    ['registry_row_active (another sheet)', (d) => ({ row: { ...d.row, sheetId: OTHER_SHEET } }), ['registry_row_active']],
    ['registry_row_active (absent)', () => ({ row: null }), ['registry_row_active']],
    ['sheet_present', (d) => ({ provisioning: { ...d.provisioning, async findObjectSheet() { return null } } }), ['sheet_present']],
    ['sheet_present (another id)', (d) => ({ provisioning: { ...d.provisioning, async findObjectSheet() { return { id: OTHER_SHEET } } } }), ['sheet_present']],
    ['target_fields_present (a human column missing)', (d) => { d.fields.delete(TEMPLATE.fields.find((field) => !PROJECT_SHEET_PLM_SYSTEM_FIELD_IDS.includes(field.id) && !templateContractOptionFields(TEMPLATE).some((option) => option.id === field.id)).id); return {} }, ['target_fields_present']],
    ['target_fields_present (computed only, not from the database)', (d) => { const { resolveExistingObjectFieldIds: _db, ...rest } = d.provisioning; return { provisioning: rest } }, ['target_fields_present']],
    ['plm_column_lock (one column unmarked)', (d) => { d.fields.get(PROJECT_SHEET_PLM_SYSTEM_FIELD_IDS[0]).property = {}; return {} }, ['plm_column_lock']],
    ['plm_column_lock (host cannot read fields)', (d) => { const { getObjectField: _read, ...rest } = d.provisioning; return { provisioning: rest } }, ['plm_column_lock', 'contract_option_sets']],
    ['contract_option_sets (empty list)', (d) => { d.fields.get(templateContractOptionFields(TEMPLATE)[0].id).property.options = []; return {} }, ['contract_option_sets']],
    ['views_present', (d) => ({ provisioning: { ...d.provisioning, getObjectViewId: () => null } }), ['views_present']],
    ['single_project_on_sheet', () => ({ assertTargetSheetHoldsNoForeignActiveRows: async () => { throw Object.assign(new Error('foreign'), { code: 'TARGET_SHEET_FOREIGN_PROJECT' }) } }), ['single_project_on_sheet']],
    ['write_lock_store_readable (store down)', () => ({ lock: { async readState() { throw Object.assign(new Error('down'), { code: '42P01' }) } } }), ['write_lock_store_readable', 'write_lock_free']],
    ['write_lock_store_readable (no lock service)', () => ({ lock: null }), ['write_lock_store_readable', 'write_lock_free']],
    ['write_lock_free (a live lease)', () => ({ lock: { async readState() { return { present: true, leaseHeld: true, leaseLive: true } } } }), ['write_lock_free']],
    ['export_closure_port (no port)', (d) => { const { closeSheetGridExport: _c, getSheetGridExportClosure: _g, ...rest } = d.provisioning; return { provisioning: rest } }, ['export_closure_port']],
    ['export_closure_port (sheet not present on the host)', (d) => ({ provisioning: { ...d.provisioning, async getSheetGridExportClosure({ sheetId }) { return { sheetId, present: false, closure: null, closedAt: null, closedBy: null } } } }), ['export_closure_port']],
    ['continuation_store_readable', () => ({ probeTableReadable: async (table) => ({ readable: table !== readiness.STEP4_STORE_TABLES.continuation, ...(table === readiness.STEP4_STORE_TABLES.continuation ? { reason: 'undefined_table' } : {}) }) }), ['continuation_store_readable']],
    ['refresh_state_store_readable', () => ({ probeTableReadable: async (table) => ({ readable: table !== readiness.STEP4_STORE_TABLES.refreshState }) }), ['refresh_state_store_readable']],
    ['both step-4 stores (no probe)', () => ({ probeTableReadable: undefined }), ['continuation_store_readable', 'refresh_state_store_readable']],
    ['spec_read_plan_slot (undeclared, nothing said)', () => ({ action: { source: { readPlan: { part: {} } }, target: { sheetId: SHEET, objectId: OBJECT } } }), ['spec_read_plan_slot']],
    ['spec_read_plan_slot (undeclared, a non-literal declaration)', () => ({ action: { source: { readPlan: { part: {} } }, target: { sheetId: SHEET, objectId: OBJECT } }, specReadPlanSlotDeclaration: 'maybe' }), ['spec_read_plan_slot']],
    ['no_generic_writer_names_sheet (an object config names the sheet)', () => ({ collectGenericWriterTargets: async () => ({ complete: true, sheetIds: new Set([SHEET]), objectIds: new Set() }) }), ['no_generic_writer_names_sheet']],
    ['no_generic_writer_names_sheet (an option names the objectId)', () => ({ collectGenericWriterTargets: async () => ({ complete: true, sheetIds: new Set(), objectIds: new Set([OBJECT]) }) }), ['no_generic_writer_names_sheet']],
    ['no_generic_writer_names_sheet (a registry did not answer)', () => ({ collectGenericWriterTargets: async () => ({ complete: false, sheetIds: new Set(), objectIds: new Set() }) }), ['no_generic_writer_names_sheet']],
  ]
  for (const [label, mutate, expected] of table) {
    const deps = readyDeps()
    const answer = await withContinuationSupport(1, () => readiness.evaluatePilotReadiness({ ...deps, ...mutate(deps) }))
    assert.deepEqual([...answer.failing], expected, label)
    assert.equal(answer.ready, false, label)
  }
  // The explicit NOT-APPLICABLE declaration (server config literal) satisfies the slot without a column.
  const declared = await withContinuationSupport(1, () => readiness.evaluatePilotReadiness({ ...readyDeps(), action: { source: { readPlan: { part: {} } }, target: { sheetId: SHEET, objectId: OBJECT } }, specReadPlanSlotDeclaration: readiness.SPEC_READ_PLAN_SLOT_NOT_APPLICABLE }))
  assert.deepEqual([...declared.failing], [])
  // The build marker: 0 ⇒ failing; 1 ⇒ ok; a non-integer ⇒ failing.
  for (const [version, failing] of [[0, ['continuation_support_version']], [1, []], ['1', ['continuation_support_version']]]) {
    const answer = await withContinuationSupport(version, () => readiness.evaluatePilotReadiness(readyDeps()))
    assert.deepEqual([...answer.failing], failing, `marker ${JSON.stringify(version)}`)
  }
})

test('R-03 a throwing probe is ok:false, never a thrown readiness; the evaluator itself never throws', async () => {
  const deps = readyDeps({
    provisioning: { ...readyDeps().provisioning, async findObjectSheet() { throw new Error(`host down ${SHEET}`) } },
    assertTargetSheetHoldsNoForeignActiveRows: async () => { throw new Error('records down') },
    probeTableReadable: async () => { throw new Error('db down') },
    collectGenericWriterTargets: async () => { throw new Error('registry down') },
  })
  const answer = await withContinuationSupport(1, () => readiness.evaluatePilotReadiness(deps))
  assert.deepEqual([...answer.failing], ['sheet_present', 'single_project_on_sheet', 'continuation_store_readable', 'refresh_state_store_readable', 'no_generic_writer_names_sheet'])
  assert.ok(!JSON.stringify(answer).includes(SHEET), 'a thrown message never travels into the answer')
  const empty = await readiness.evaluatePilotReadiness({})
  assert.equal(empty.ready, false)
  assert.equal(empty.failing.length, readiness.PILOT_READINESS_CHECK_IDS.length, 'nothing is ready with no inputs')
})

test('R-04 collectGenericWriterTargets: both registries must answer; object configs and erp-feedback options are collected', async () => {
  const systems = [
    { kind: 'metasheet:multitable', config: { objects: { syn_object: { sheetId: 'sheet_named_by_a_pipeline' }, other: { sheetId: 'sheet_other' } } } },
    { kind: 'metasheet:multitable', config: {} },
  ]
  const pipelines = [
    { options: { erpFeedback: { objectId: 'plm_feedback_object', stagingObjectId: 'plm_staging_object' } }, stagingSheetId: 'sheet_staging', targetObject: 'erp_target' },
    { options: {}, stagingObjectId: 'plm_pipeline_staging' },
  ]
  const calls = []
  const externalSystemRegistry = { async listExternalSystems(input) { calls.push(['systems', input]); return systems } }
  const pipelineRegistry = { async listPipelines(input) { calls.push(['pipelines', input]); return pipelines } }
  const targets = await readiness.collectGenericWriterTargets({ externalSystemRegistry, pipelineRegistry, tenantId: TENANT, workspaceId: 'workspace-syn' })
  assert.equal(targets.complete, true)
  assert.deepEqual([...targets.sheetIds].sort(), ['sheet_named_by_a_pipeline', 'sheet_other', 'sheet_staging'])
  assert.deepEqual([...targets.objectIds].sort(), ['erp_target', 'other', 'plm_feedback_object', 'plm_pipeline_staging', 'plm_staging_object', 'syn_object'])
  // Both scopes were asked (the workspace and the tenant-wide rows), the systems filtered to the multitable kind.
  assert.deepEqual(calls.map(([which, input]) => [which, input.tenantId, input.workspaceId || null, input.kind || null]), [
    ['systems', TENANT, 'workspace-syn', 'metasheet:multitable'], ['pipelines', TENANT, 'workspace-syn', null],
    ['systems', TENANT, null, 'metasheet:multitable'], ['pipelines', TENANT, null, null],
  ])
  // Incomplete: a registry missing, or throwing — never "nobody writes the sheet".
  assert.equal((await readiness.collectGenericWriterTargets({ externalSystemRegistry, tenantId: TENANT })).complete, false)
  assert.equal((await readiness.collectGenericWriterTargets({ pipelineRegistry, tenantId: TENANT })).complete, false)
  assert.equal((await readiness.collectGenericWriterTargets({ externalSystemRegistry: { async listExternalSystems() { throw new Error('down') } }, pipelineRegistry, tenantId: TENANT })).complete, false)
  assert.equal((await readiness.collectGenericWriterTargets({ externalSystemRegistry, pipelineRegistry, tenantId: '' })).complete, false)
})

// ── the registry's pilot surface ────────────────────────────────────────────────────────────────────

function makeMemoryDb({ failSelectWith = null } = {}) {
  const rows = []
  const calls = []
  const matches = (candidate, where) => Object.entries(where).every(([column, value]) => (candidate[column] === undefined ? null : candidate[column]) === (value === undefined ? null : value))
  const impl = {
    async selectOne(table, where) { if (failSelectWith) throw failSelectWith; return rows.find((r) => matches(r, where)) || null },
    async select(table, { where } = {}) { if (failSelectWith) throw failSelectWith; return rows.filter((r) => matches(r, where || {})) },
    async selectOneForUpdate(table, where) { return rows.find((r) => matches(r, where)) || null },
    async updateRow(table, set, where) { const hit = rows.filter((r) => matches(r, where)); for (const r of hit) Object.assign(r, set); return hit.map((r) => ({ ...r })) },
    async insertOne() { throw new Error('not used') },
    async countRows() { return rows.length },
  }
  const tagged = (prefix) => ({
    async selectOne(table, where) { calls.push([`${prefix}selectOne`, table, { ...where }]); return impl.selectOne(table, where) },
    async select(table, options) { calls.push([`${prefix}select`, table]); return impl.select(table, options) },
    async selectOneForUpdate(table, where) { calls.push([`${prefix}selectOneForUpdate`, table, { ...where }]); return impl.selectOneForUpdate(table, where) },
    async updateRow(table, set, where) { calls.push([`${prefix}updateRow`, table, { ...where }, Object.keys(set).sort()]); return impl.updateRow(table, set, where) },
    insertOne: impl.insertOne,
    countRows: impl.countRows,
  })
  return {
    rows,
    calls,
    ...tagged(''),
    async transaction(fn) {
      calls.push(['transaction'])
      return fn({ ...tagged('trx.'), async advisoryXactLock(key) { calls.push(['trx.advisoryXactLock', key]) } })
    },
  }
}

const makeStore = (db) => createStockPreparationProjectTargetStore({ db, idGenerator: () => 'pt-1', now: () => AT })

test('S-13 rowToPilotState: no column ⇒ not pilot; the three columns project as handles / clock / integer; the public target has no pilot key', () => {
  assert.equal(rowToPilotState(null), null)
  const legacy = { tenant_id: TENANT, project_no: PROJECT, sheet_id: SHEET, object_id: OBJECT, status: 'active' }
  assert.deepEqual(rowToPilotState(legacy), { tenantId: TENANT, projectNo: PROJECT, sheetId: SHEET, objectId: OBJECT, status: 'active', pilot: false, pilotEnabledAt: null, pilotEnabledBy: null, pilotReadinessVersion: null })
  assert.equal(rowToPilotState(row()).pilot, false)
  assert.deepEqual(rowToPilotState(pilotRow({ pilot_readiness_version: '1' })), { tenantId: TENANT, projectNo: PROJECT, sheetId: SHEET, objectId: OBJECT, status: 'active', pilot: true, pilotEnabledAt: AT.toISOString(), pilotEnabledBy: 'u_admin', pilotReadinessVersion: 1 })
  const publicTarget = storeInternals.rowToPublicTarget(pilotRow())
  assert.ok(!Object.keys(publicTarget).some((key) => /pilot/i.test(key)), 'rowToPublicTarget stays byte-identical: no pilot key')
  assert.deepEqual(publicTarget, storeInternals.rowToPublicTarget(row()), 'the public projection cannot tell a pilot row from a plain one')
})

test('S-14 markPilotEnabled: transaction → tenant lock → FOR UPDATE → ONE compare-and-set with the three columns; a second call is alreadyEnabled with the original stamp and no update', async () => {
  const db = makeMemoryDb()
  db.rows.push(row())
  const store = makeStore(db)
  const first = await store.markPilotEnabled({ tenantId: TENANT, projectNo: PROJECT, actorId: 'u_admin', readinessVersion: 1 })
  assert.deepEqual(first, { enabled: true, alreadyEnabled: false, pilot: { tenantId: TENANT, projectNo: PROJECT, sheetId: SHEET, objectId: OBJECT, status: 'active', pilot: true, pilotEnabledAt: AT.toISOString(), pilotEnabledBy: 'u_admin', pilotReadinessVersion: 1 } })
  assert.deepEqual(db.calls, [
    ['transaction'],
    ['trx.advisoryXactLock', `${PROJECT_TARGET_CREATE_LOCK_PREFIX}${TENANT}`],
    ['trx.selectOneForUpdate', PROJECT_TARGET_TABLE, { tenant_id: TENANT, project_no: PROJECT }],
    ['trx.updateRow', PROJECT_TARGET_TABLE, { tenant_id: TENANT, project_no: PROJECT, status: 'active', pilot_enabled_at: null }, ['pilot_enabled_at', 'pilot_enabled_by', 'pilot_readiness_version', 'updated_at']],
  ])
  const stored = db.rows[0]
  assert.equal(stored.pilot_enabled_at, AT)
  assert.equal(stored.pilot_enabled_by, 'u_admin')
  assert.equal(stored.pilot_readiness_version, 1)
  // Migration 101's CHECK: the stamp and its version land together.
  assert.equal(stored.pilot_enabled_at !== null, stored.pilot_readiness_version !== null)
  // Set-once: the second call changes nothing, answers alreadyEnabled with the ORIGINAL stamp, no update statement.
  db.calls.length = 0
  const second = await store.markPilotEnabled({ tenantId: TENANT, projectNo: PROJECT, actorId: 'u_other', readinessVersion: 7 })
  assert.deepEqual(second, { enabled: false, alreadyEnabled: true, pilot: first.pilot })
  assert.ok(!db.calls.some(([method]) => method === 'trx.updateRow'), 'no update on a re-mark')
  assert.equal(stored.pilot_enabled_by, 'u_admin')
  assert.equal(stored.pilot_readiness_version, 1)
  // The reads.
  assert.deepEqual(await store.getPilotState({ tenantId: TENANT, projectNo: PROJECT }), first.pilot)
  assert.deepEqual(await store.getPilotStateBySheetId({ sheetId: SHEET }), first.pilot)
  assert.equal(await store.getPilotState({ tenantId: TENANT, projectNo: OTHER_PROJECT }), null)
  assert.equal(await store.getPilotStateBySheetId({ sheetId: OTHER_SHEET }), null)
})

test('S-15 markPilotEnabled refusals: ABSENT / ARCHIVED 409 with no update; a bad readinessVersion 422 before any db call; the CAS backstop is 409 STATE_MOVED', async () => {
  const db = makeMemoryDb()
  const store = makeStore(db)
  for (const bad of [0, -1, 1.5, '1', undefined, null]) {
    await rejects(store.markPilotEnabled({ tenantId: TENANT, projectNo: PROJECT, readinessVersion: bad }), { status: 422, code: 'STOCK_PREPARATION_PROJECT_TARGET_SCOPE_INVALID' })
  }
  assert.deepEqual(db.calls, [], 'a bad version costs no db call')
  await rejects(store.markPilotEnabled({ tenantId: TENANT, projectNo: PROJECT, readinessVersion: 1 }), { status: 409, code: 'STOCK_PREPARATION_PROJECT_ABSENT' })
  db.rows.push(row({ status: 'archived', archived_at: AT }))
  await rejects(store.markPilotEnabled({ tenantId: TENANT, projectNo: PROJECT, readinessVersion: 1 }), { status: 409, code: 'STOCK_PREPARATION_PROJECT_ARCHIVED' })
  assert.ok(!db.calls.some(([method]) => method === 'trx.updateRow'), 'no update on a refusal')
  assert.equal(db.rows[0].pilot_enabled_at, null)
  // Another tenant's row with the same project number is never touched.
  db.rows.length = 0
  db.rows.push(row({ tenant_id: 'tenant-syn-foreign' }))
  await rejects(store.markPilotEnabled({ tenantId: TENANT, projectNo: PROJECT, readinessVersion: 1 }), { status: 409, code: 'STOCK_PREPARATION_PROJECT_ABSENT' })
  assert.equal(db.rows[0].pilot_enabled_at, null)
  // The CAS backstop: the FOR UPDATE read answers active-and-unmarked but the update matches nothing.
  const moved = makeMemoryDb()
  moved.rows.push(row())
  const originalUpdate = moved.transaction
  moved.transaction = async (fn) => originalUpdate(async (trx) => fn({ ...trx, async updateRow(table, set, where) { moved.calls.push(['trx.updateRow', table, { ...where }, Object.keys(set).sort()]); return [] } }))
  const caught = await rejects(makeStore(moved).markPilotEnabled({ tenantId: TENANT, projectNo: PROJECT, readinessVersion: 1 }), { status: 409, code: PROJECT_TARGET_PILOT_STATE_MOVED_CODE })
  assert.ok(caught instanceof StockPreparationProjectTargetStoreError)
  assert.equal(moved.rows[0].pilot_enabled_at, null)
})

test('S-16 probeTableReadable: readable / undefined_table (42P01) / read_failed with its SQLSTATE — never a throw', async () => {
  assert.deepEqual(await makeStore(makeMemoryDb()).probeTableReadable('integration_stock_prep_continuation'), { readable: true })
  assert.deepEqual(await makeStore(makeMemoryDb({ failSelectWith: Object.assign(new Error('relation does not exist'), { code: '42P01' }) })).probeTableReadable('integration_stock_prep_continuation'), { readable: false, reason: 'undefined_table' })
  assert.deepEqual(await makeStore(makeMemoryDb({ failSelectWith: Object.assign(new Error('permission denied'), { code: '42501' }) })).probeTableReadable('integration_stock_prep_continuation'), { readable: false, reason: 'read_failed', sqlState: '42501' })
  assert.deepEqual(await makeStore(makeMemoryDb({ failSelectWith: new Error('socket hang up') })).probeTableReadable('integration_stock_prep_continuation'), { readable: false, reason: 'read_failed' })
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-pilot-gate.test.cjs', tests, { passLine: '✓ stock-preparation-pilot-gate' })
