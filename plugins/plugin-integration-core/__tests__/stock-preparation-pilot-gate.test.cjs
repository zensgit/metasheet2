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
//        continuation marker included (the build literal is 0 until the LAST PR of the D-22 set flips it; still 0 after PR-3b)
//   R-03 a probe that throws is `ok: false`, never a thrown readiness; the answer is values-free
//   R-04 collectGenericWriterTargets: both registries must answer (else incomplete); object configs and pipeline
//        erp-feedback options are collected; a throwing registry is incomplete
//   G-08 (pre-enable hardening F-4a) a read naming NEITHER identity is 500 STATE_UNREADABLE identity_missing — never
//        not_pilot, registry or not, before any read; each identity alone still reads
//   R-05 (F-5 / O-6) no_two_copy_component: an ACTIVE root and an ACTIVE nested row of one component refuse; the
//        continuation core's readings of active (`!== false`) and root (blank parent); the project read is asked once
//   R-06 (F-5 / O-8) pack_columns_installed: every declared ext_ column listed live by the ledger AND on the host, or
//        an explicit not-applicable the facts agree with; the reads are strict (a failing ledger fails the check)
//   S-17 (F-4c) markPilotEnabled `onMarked`: inside the transaction after the CAS; a throw rolls the mark back; never
//        on alreadyEnabled
//   S-13 rowToPilotState: no column ⇒ not pilot; the three columns project as handles / clock / integer; the public
//        target projection is UNCHANGED (no pilot key)
//   S-14 markPilotEnabled: ONE transaction, the tenant lock, the row FOR UPDATE, ONE compare-and-set update whose
//        where repeats status 'active' AND pilot_enabled_at IS NULL and whose set carries the three columns together
//        (migration 101's CHECK holds); the second call answers alreadyEnabled with the ORIGINAL stamp and no update
//   S-15 markPilotEnabled refusals: ABSENT / ARCHIVED 409 with no update; a bad readinessVersion 422 before any db
//        call; the CAS backstop (an update that matches nothing) is 409 STATE_MOVED, never a silent success
//   S-16 probeTableReadable: readable / 42P01 undefined_table / any other failure read_failed with its SQLSTATE
//   PG-N4 (S1 N4, review candidate) spec_read_plan_slot with the optional `specSlotReadPlans`: EVERY listed plan must
//        declare the 规格 column (an empty list, a non-list, a throwing dep fail); not applicable answers first
//        without calling the dep; without the dep the action's own plan decides, as before
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

test('G-08 (F-4a) a read that names NEITHER identity is refused 500 STATE_UNREADABLE identity_missing — never not_pilot, with or without a registry, before any read', async () => {
  const store = fakeStore([pilotRow()])
  const gate = createStockPreparationPilotGate({ store })
  const absent = createStockPreparationPilotGate({ store: null })
  const noIdentity = [
    {},
    undefined,
    { tenantId: TENANT },
    { projectNo: PROJECT },
    { tenantId: '  ', projectNo: PROJECT },
    { tenantId: TENANT, projectNo: '', sheetId: '   ' },
    { sheetId: null, projectNo: null, tenantId: null },
  ]
  for (const input of noIdentity) {
    for (const [label, which] of [['registry present', gate], ['registry absent', absent]]) {
      const caught = await rejects(which.readPilotState(input), { status: 500, code: PILOT_ERROR_CODES.STATE_UNREADABLE })
      assert.deepEqual(caught.details, { operation: 'pilot_state_read', reason: 'identity_missing', partial: false }, `${label}: ${JSON.stringify(input)}`)
      for (const lane of PILOT_LARGE_LANES) await rejects(which.assertLargeLaneAllowed(input, lane), { status: 500, code: PILOT_ERROR_CODES.STATE_UNREADABLE })
      await rejects(which.assertSmallLaneCapNotExceededForPilot(input), { status: 500, code: PILOT_ERROR_CODES.STATE_UNREADABLE })
    }
  }
  assert.deepEqual(store.calls, [], 'no identity costs no read')
  // Either identity alone still reads (G-03 pins which read runs).
  assert.equal((await gate.readPilotState({ sheetId: SHEET })).state, 'pilot')
  assert.equal((await gate.readPilotState({ tenantId: TENANT, projectNo: PROJECT })).state, 'pilot')
  assert.equal((await absent.readPilotState({ sheetId: SHEET })).registry, 'absent')
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
    // Pre-enable hardening (version 2): the project's rows (none), the job store's scan (nothing open), the
    // pack-install ledger (nothing installed) with the explicit "no customer pack" declaration.
    readExistingStockPreparationRows: async () => [],
    countOpenLargeJobs: async () => ({ open: 0, unattributed: 0, scanned: 0 }),
    packInstallStore: { async listInstalledFieldIds() { return { fieldIds: [], packIds: [] } } },
    customerPackDeclaration: readiness.CUSTOMER_PACK_NOT_APPLICABLE,
    ...overrides,
  }
}

// A sheet row as the project-scoped read answers it (logical keys). `parent` null ⇒ a root row.
const sheetRow = (component, { parent = null, active = true, key } = {}) => ({
  projectNo: PROJECT, componentSourceId: component, parentSourceId: parent, active,
  ...(key === undefined ? { idempotencyKey: JSON.stringify([component, parent]) } : (key === null ? {} : { idempotencyKey: key })),
})
// A ledger + host pair for the pack check: `ledger` the live field ids the pack-install ledger lists, `host` the
// field ids the host returns for this sheet.
function packDeps({ declared, ledger = [], packIds = ledger.length ? ['syn_pack'] : [], host = ledger, declaration = null }) {
  const calls = []
  return {
    calls,
    deps: {
      ...(declared === undefined ? {} : { action: { source: { readPlan: { part: { specField: 'Specification' } } }, target: { sheetId: SHEET, objectId: OBJECT }, extensionFieldIds: declared } }),
      packInstallStore: { async listInstalledFieldIds(input) { calls.push(['ledger', input]); return { fieldIds: [...ledger], packIds: [...packIds] } } },
      provisioning: {
        ...readyDeps().provisioning,
        async readObjectFieldsContent(input) { calls.push(['host', input]); return Object.fromEntries(input.fieldIds.filter((id) => host.includes(id)).map((id) => [id, { property: { stockPreparation: { ownership: 'plm_system' } } }])) },
      },
      customerPackDeclaration: declaration,
    },
  }
}

async function withContinuationSupport(version, fn) {
  const original = continuationSupport.CONTINUATION_SUPPORT_VERSION
  continuationSupport.CONTINUATION_SUPPORT_VERSION = version
  try { return await fn() } finally { continuationSupport.CONTINUATION_SUPPORT_VERSION = original }
}

test('R-01 every check passes on a satisfied fake ⇒ ready; the id list and the version are pinned; the answer is values-free', async () => {
  // Version 2 (pre-enable hardening, step-4 design §23.4 F-3 / F-5): three checks added, none removed or renamed.
  // Version 3 (#6324 S1/N4): spec_read_plan_slot also requires the effective online plan's slot while online read
  // plans are ON; same ids, only refuses more.
  assert.equal(readiness.PILOT_READINESS_VERSION, 3)
  assert.equal(continuationSupport.CONTINUATION_SUPPORT_VERSION, 0, 'the build marker ships at 0 (the last PR of the D-22 set flips it; PR-3a / PR-3b keep it 0)')
  assert.deepEqual(readiness.PILOT_READINESS_CHECK_IDS, [
    'registry_row_active', 'sheet_present', 'target_fields_present', 'plm_column_lock', 'contract_option_sets', 'views_present',
    'single_project_on_sheet', 'no_two_copy_component', 'write_lock_store_readable', 'write_lock_free', 'no_open_large_job', 'export_closure_port',
    'continuation_store_readable', 'refresh_state_store_readable', 'spec_read_plan_slot', 'pack_columns_installed', 'no_generic_writer_names_sheet', 'continuation_support_version',
  ])
  // The web clamps a failing id to /^[a-z][a-z0-9_]{0,63}$/ (projectTarget.ts): every id survives it.
  assert.ok(readiness.PILOT_READINESS_CHECK_IDS.every((id) => /^[a-z][a-z0-9_]{0,63}$/.test(id)))
  assert.equal(readiness.CUSTOMER_PACK_NOT_APPLICABLE, 'not_applicable')
  const answer = await withContinuationSupport(1, () => readiness.evaluatePilotReadiness(readyDeps()))
  assert.equal(answer.ready, true, JSON.stringify(answer.failing))
  assert.deepEqual([...answer.failing], [])
  assert.equal(answer.version, readiness.PILOT_READINESS_VERSION)
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
    // ── version 2 (pre-enable hardening) ──
    ['no_two_copy_component (one component an active root AND an active nested copy)', () => ({ readExistingStockPreparationRows: async () => [sheetRow('SYN-C1'), sheetRow('SYN-C1', { parent: 'SYN-P1' }), sheetRow('SYN-P1')] }), ['no_two_copy_component']],
    ['no_two_copy_component (the project read cannot run: not wired)', () => ({ readExistingStockPreparationRows: undefined }), ['no_two_copy_component']],
    ['no_two_copy_component (the project read refuses: past its bound)', () => ({ readExistingStockPreparationRows: async () => { throw Object.assign(new Error('too large'), { code: 'TABLE_ACTION_EXISTING_ROWS_TOO_LARGE' }) } }), ['no_two_copy_component']],
    ['no_two_copy_component (no project number to read by)', () => ({ projectNo: '' }), ['no_two_copy_component']],
    ['no_open_large_job (one open job on the sheet)', () => ({ countOpenLargeJobs: async () => ({ open: 1, unattributed: 0, scanned: 3 }) }), ['no_open_large_job']],
    ['no_open_large_job (an open job whose sheet cannot be read)', () => ({ countOpenLargeJobs: async () => ({ open: 0, unattributed: 1, scanned: 1 }) }), ['no_open_large_job']],
    ['no_open_large_job (the job store is unreadable)', () => ({ countOpenLargeJobs: async () => { throw Object.assign(new Error('store down'), { code: 'PLUGIN_DURABLE_STORAGE_UNAVAILABLE' }) } }), ['no_open_large_job']],
    ['no_open_large_job (no scan wired)', () => ({ countOpenLargeJobs: undefined }), ['no_open_large_job']],
    ['no_open_large_job (a scan that answers nothing usable)', () => ({ countOpenLargeJobs: async () => ({ open: '0', unattributed: 0 }) }), ['no_open_large_job']],
    ['pack_columns_installed (nothing declared and no not-applicable declaration)', () => ({ customerPackDeclaration: null }), ['pack_columns_installed']],
    ['pack_columns_installed (a non-literal declaration)', () => ({ customerPackDeclaration: 'n/a' }), ['pack_columns_installed']],
    ['pack_columns_installed (not applicable, but the ledger lists a live pack column)', () => packDeps({ declared: undefined, ledger: ['ext_synA'], declaration: readiness.CUSTOMER_PACK_NOT_APPLICABLE }).deps, ['pack_columns_installed']],
    ['pack_columns_installed (not applicable, but the action declares a column)', () => packDeps({ declared: ['ext_synA'], ledger: ['ext_synA'], packIds: [], declaration: readiness.CUSTOMER_PACK_NOT_APPLICABLE }).deps, ['pack_columns_installed']],
    ['pack_columns_installed (declared, not in the ledger)', () => packDeps({ declared: ['ext_synA'], ledger: [], host: ['ext_synA'] }).deps, ['pack_columns_installed']],
    ['pack_columns_installed (declared, one of two not in the ledger)', () => packDeps({ declared: ['ext_synA', 'ext_synB'], ledger: ['ext_synA'], host: ['ext_synA', 'ext_synB'] }).deps, ['pack_columns_installed']],
    ['pack_columns_installed (declared, in the ledger, gone from the host)', () => packDeps({ declared: ['ext_synA'], ledger: ['ext_synA'], host: [] }).deps, ['pack_columns_installed']],
    ['pack_columns_installed (a malformed declaration list)', () => packDeps({ declared: ['ext_synA', 7], ledger: ['ext_synA'] }).deps, ['pack_columns_installed']],
    ['pack_columns_installed (the ledger is unreadable)', () => ({ packInstallStore: { async listInstalledFieldIds() { throw Object.assign(new Error('ledger down'), { code: '42P01' }) } } }), ['pack_columns_installed']],
    ['pack_columns_installed (no ledger store)', () => ({ packInstallStore: null }), ['pack_columns_installed']],
    ['pack_columns_installed (the ledger answers no lists)', () => ({ packInstallStore: { async listInstalledFieldIds() { return {} } } }), ['pack_columns_installed']],
    ['pack_columns_installed (declared, the host cannot read fields)', (d) => { const { deps } = packDeps({ declared: ['ext_synA'], ledger: ['ext_synA'] }); const { readObjectFieldsContent: _r, ...rest } = deps.provisioning; return { ...deps, provisioning: rest } }, ['pack_columns_installed']],
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

test('R-05 (O-6) no_two_copy_component: only an ACTIVE root and an ACTIVE nested row of ONE component refuse; the continuation core\'s readings of active and root', async () => {
  const { countTwoCopyComponents } = readiness.__internals
  const cases = [
    ['nothing', [], 0],
    ['a root and a nested copy of one component', [sheetRow('C1'), sheetRow('C1', { parent: 'P1' })], 1],
    ['two components, both doubled', [sheetRow('C1'), sheetRow('C1', { parent: 'P1' }), sheetRow('C2'), sheetRow('C2', { parent: 'P9' })], 2],
    ['the root is inactive', [sheetRow('C1', { active: false }), sheetRow('C1', { parent: 'P1' })], 0],
    ['the nested copy is inactive', [sheetRow('C1'), sheetRow('C1', { parent: 'P1', active: false })], 0],
    ['a root of one component, a nested row of another', [sheetRow('C1'), sheetRow('C2', { parent: 'C1' })], 0],
    ['one component nested twice under different parents (no root)', [sheetRow('C1', { parent: 'P1' }), sheetRow('C1', { parent: 'P2' })], 0],
    // The core's "active" is `active !== false` — wider than the fill view's: an unset / null / text cell is active.
    ['an unset active cell counts as active', [sheetRow('C1', { active: null }), sheetRow('C1', { parent: 'P1', active: undefined })], 1],
    ['a text "false" active cell counts as active (core reading)', [sheetRow('C1', { active: 'false' }), sheetRow('C1', { parent: 'P1' })], 1],
    // The core's "root" is a blank parentSourceId: '' and whitespace are roots.
    ['a blank-string parent is a root', [sheetRow('C1', { parent: '  ' }), sheetRow('C1', { parent: 'P1' })], 1],
    ['keyless rows count too', [sheetRow('C1', { key: null }), sheetRow('C1', { parent: 'P1', key: null })], 1],
    ['a blank component is skipped', [sheetRow(''), sheetRow('', { parent: 'P1' }), sheetRow(null), sheetRow(null, { parent: 'P1' })], 0],
  ]
  for (const [label, rows, expected] of cases) assert.equal(countTwoCopyComponents(rows), expected, label)
  // Through the evaluator: the project read is asked with exactly (records, target, projectNo) and its answer decides.
  const calls = []
  const deps = readyDeps({ readExistingStockPreparationRows: async (recordsApi, target, projectNo) => { calls.push([recordsApi === deps.recordsApi, target, projectNo]); return [sheetRow('C1'), sheetRow('C1', { parent: 'P1' })] } })
  const refused = await withContinuationSupport(1, () => readiness.evaluatePilotReadiness(deps))
  assert.deepEqual([...refused.failing], ['no_two_copy_component'])
  assert.deepEqual(calls, [[true, deps.target, PROJECT]])
  assert.ok(!JSON.stringify(refused).includes('C1'), 'values-free: no component id in the answer')
  const clean = await withContinuationSupport(1, () => readiness.evaluatePilotReadiness(readyDeps({ readExistingStockPreparationRows: async () => [sheetRow('C1'), sheetRow('C2', { parent: 'C1' }), sheetRow('C1', { parent: 'P1', active: false })] })))
  assert.deepEqual([...clean.failing], [])
})

test('R-06 (O-8) pack_columns_installed: every declared ext_ column installed (ledger AND host), or an explicit not-applicable that the facts agree with — read strictly', async () => {
  // Positive: two declared columns, both listed live by the ledger and present on the host.
  const ok = packDeps({ declared: ['ext_synA', 'ext_synB'], ledger: ['ext_synA', 'ext_synB', 'ext_synHuman'] })
  const passed = await withContinuationSupport(1, () => readiness.evaluatePilotReadiness(readyDeps(ok.deps)))
  assert.deepEqual([...passed.failing], [])
  // The ledger is asked for exactly this sheet's (tenant, staging project, objectId); the host for exactly the declared ids.
  assert.deepEqual(ok.calls, [
    ['ledger', { tenantId: TENANT, projectId: PROJECT_ID, objectId: OBJECT }],
    ['host', { projectId: PROJECT_ID, objectId: OBJECT, fieldIds: ['ext_synA', 'ext_synB'] }],
  ])
  // Positive: the explicit not-applicable declaration with nothing declared and nothing installed — no host read.
  const none = packDeps({ declared: undefined, ledger: [], declaration: readiness.CUSTOMER_PACK_NOT_APPLICABLE })
  assert.deepEqual([...(await withContinuationSupport(1, () => readiness.evaluatePilotReadiness(readyDeps(none.deps)))).failing], [])
  assert.deepEqual(none.calls.map(([which]) => which), ['ledger'], 'not applicable still reads the ledger, never the host')
  // Not applicable WITH a declared column is a contradiction and refuses (R-02). And the read is strict: a failing
  // ledger is a failing check, never "no pack" (loadPackInstalledFieldProperties would have answered legacy here).
  const failingLedger = readyDeps({ packInstallStore: { async listInstalledFieldIds() { throw new Error('ledger down') } } })
  assert.deepEqual([...(await withContinuationSupport(1, () => readiness.evaluatePilotReadiness(failingLedger))).failing], ['pack_columns_installed'])
  const text = JSON.stringify(passed)
  assert.ok(!text.includes('ext_syn'), 'values-free: no column id in the answer')
})

test('R-03 a throwing probe is ok:false, never a thrown readiness; the evaluator itself never throws', async () => {
  const deps = readyDeps({
    provisioning: { ...readyDeps().provisioning, async findObjectSheet() { throw new Error(`host down ${SHEET}`) } },
    assertTargetSheetHoldsNoForeignActiveRows: async () => { throw new Error('records down') },
    probeTableReadable: async () => { throw new Error('db down') },
    collectGenericWriterTargets: async () => { throw new Error('registry down') },
    readExistingStockPreparationRows: async () => { throw new Error(`records down ${SHEET}`) },
    countOpenLargeJobs: async () => { throw new Error('job store down') },
    packInstallStore: { async listInstalledFieldIds() { throw new Error(`ledger down ${SHEET}`) } },
  })
  const answer = await withContinuationSupport(1, () => readiness.evaluatePilotReadiness(deps))
  assert.deepEqual([...answer.failing], ['sheet_present', 'single_project_on_sheet', 'no_two_copy_component', 'no_open_large_job', 'continuation_store_readable', 'refresh_state_store_readable', 'pack_columns_installed', 'no_generic_writer_names_sheet'])
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

// `rollback: true` (F-4(c)): a transaction whose callback throws restores every row to what it was when the
// transaction began — what PostgreSQL does, and what S-17 needs to show the mark and its hook share a fate.
function makeMemoryDb({ failSelectWith = null, rollback = false } = {}) {
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
      const snapshot = rollback ? rows.map((r) => ({ ...r })) : null
      try {
        return await fn({ ...tagged('trx.'), async advisoryXactLock(key) { calls.push(['trx.advisoryXactLock', key]) } })
      } catch (error) {
        if (snapshot) {
          rows.length = 0
          rows.push(...snapshot)
          calls.push(['rollback'])
        }
        throw error
      }
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

test('S-17 (F-4c) markPilotEnabled onMarked: runs INSIDE the transaction right after the CAS, with the trx handle and the new state; a throw rolls the mark back; never on alreadyEnabled; a non-function is 422 before any db call', async () => {
  const db = makeMemoryDb({ rollback: true })
  db.rows.push(row())
  const store = makeStore(db)
  // A non-function hook is refused before the transaction opens.
  for (const bad of ['audit', 7, {}]) {
    await rejects(store.markPilotEnabled({ tenantId: TENANT, projectNo: PROJECT, readinessVersion: 2, onMarked: bad }), { status: 422, code: 'STOCK_PREPARATION_PROJECT_TARGET_SCOPE_INVALID' })
  }
  assert.deepEqual(db.calls, [], 'a bad hook costs no db call')
  // A hook that throws (the audit insert failing, or the process dying between the two statements): the error
  // propagates and the mark is rolled back with it — the row is exactly as it was, nothing half-done.
  const crash = Object.assign(new Error('synthetic crash after the mark'), { code: '08006' })
  let crashSeen = null
  const caught = await rejects(store.markPilotEnabled({ tenantId: TENANT, projectNo: PROJECT, actorId: 'u_admin', readinessVersion: 2, onMarked: async (trx, outcome) => { crashSeen = { marked: db.rows[0].pilot_enabled_at, outcome }; throw crash } }), { code: '08006' })
  assert.equal(caught, crash)
  assert.equal(crashSeen.marked, AT, 'the hook ran AFTER the compare-and-set had landed in the transaction')
  assert.equal(crashSeen.outcome.pilot.pilot, true)
  assert.equal(db.rows[0].pilot_enabled_at, null, 'rolled back: not pilot')
  assert.equal(db.rows[0].pilot_readiness_version, null)
  assert.deepEqual(db.calls.slice(-1), [['rollback']])
  // The hook succeeds: it ran once, on the transaction handle (not the store db), after the update statement.
  db.calls.length = 0
  const seen = []
  const first = await store.markPilotEnabled({ tenantId: TENANT, projectNo: PROJECT, actorId: 'u_admin', readinessVersion: 2, onMarked: async (trx, outcome) => { seen.push({ isTrx: typeof trx.advisoryXactLock === 'function', pilot: outcome.pilot }); db.calls.push(['onMarked']) } })
  assert.equal(first.enabled, true)
  assert.deepEqual(seen, [{ isTrx: true, pilot: first.pilot }])
  assert.deepEqual(db.calls.map(([method]) => method), ['transaction', 'trx.advisoryXactLock', 'trx.selectOneForUpdate', 'trx.updateRow', 'onMarked'])
  // Already pilot: the hook is NOT called (the one row already exists with the first mark).
  const again = await store.markPilotEnabled({ tenantId: TENANT, projectNo: PROJECT, actorId: 'u_other', readinessVersion: 2, onMarked: async () => { seen.push('again') } })
  assert.equal(again.alreadyEnabled, true)
  assert.equal(seen.length, 1, 'no hook call on alreadyEnabled')
  // Without a hook (undefined or null) the store behaves as before (S-14).
})

test('S-16 probeTableReadable: readable / undefined_table (42P01) / read_failed with its SQLSTATE — never a throw', async () => {
  assert.deepEqual(await makeStore(makeMemoryDb()).probeTableReadable('integration_stock_prep_continuation'), { readable: true })
  assert.deepEqual(await makeStore(makeMemoryDb({ failSelectWith: Object.assign(new Error('relation does not exist'), { code: '42P01' }) })).probeTableReadable('integration_stock_prep_continuation'), { readable: false, reason: 'undefined_table' })
  assert.deepEqual(await makeStore(makeMemoryDb({ failSelectWith: Object.assign(new Error('permission denied'), { code: '42501' }) })).probeTableReadable('integration_stock_prep_continuation'), { readable: false, reason: 'read_failed', sqlState: '42501' })
  assert.deepEqual(await makeStore(makeMemoryDb({ failSelectWith: new Error('socket hang up') })).probeTableReadable('integration_stock_prep_continuation'), { readable: false, reason: 'read_failed' })
})

test('PG-N4 (S1 N4) spec_read_plan_slot with specSlotReadPlans: EVERY listed plan must declare the 规格 column; an empty list, a non-list and a throwing dep fail; not applicable passes WITHOUT calling the dep; without the dep the action\'s own plan decides (R-02 unchanged)', async () => {
  const declared = { part: { specField: 'Specification' } }
  const undeclared = { part: {} }
  const run = (overrides) => withContinuationSupport(1, () => readiness.evaluatePilotReadiness(readyDeps(overrides)))
  for (const [label, plans, failing] of [
    ['the deployment plan declares, the effective one does not', [declared, undeclared], ['spec_read_plan_slot']],
    ['the effective plan declares, the deployment one does not', [undeclared, declared], ['spec_read_plan_slot']],
    ['both declare', [declared, declared], []],
    ['the deployment plan alone, declared (switch OFF)', [declared], []],
    ['no plan at all', [], ['spec_read_plan_slot']],
    ['not a list', declared, ['spec_read_plan_slot']],
    ['a blank column name', [declared, { part: { specField: '  ' } }], ['spec_read_plan_slot']],
    ['a plan without a part role', [declared, {}], ['spec_read_plan_slot']],
  ]) {
    const answer = await run({ specSlotReadPlans: async () => plans })
    assert.deepEqual([...answer.failing], failing, label)
  }
  // A dep that throws (the effective plan could not be resolved) is not ok, never a thrown readiness; values-free.
  const thrown = await run({ specSlotReadPlans: async () => { throw Object.assign(new Error('synthetic resolver refusal'), { status: 409, code: 'READ_PLAN_ACTIVATION_DISABLED' }) } })
  assert.deepEqual([...thrown.failing], ['spec_read_plan_slot'])
  assert.ok(!JSON.stringify(thrown).includes('READ_PLAN_') && !JSON.stringify(thrown).includes('synthetic resolver'), 'values-free')
  // The explicit not-applicable declaration answers first: the dep is never asked.
  const depCalls = []
  const notApplicable = await run({ specReadPlanSlotDeclaration: readiness.SPEC_READ_PLAN_SLOT_NOT_APPLICABLE, specSlotReadPlans: async () => { depCalls.push('dep'); return [undeclared] } })
  assert.deepEqual([...notApplicable.failing], [])
  assert.deepEqual(depCalls, [], 'not applicable never calls the dep')
  // Without the dep: today's truth table — the action's own plan, or the literal declaration (R-02's rows).
  const undeclaredAction = { source: { readPlan: { part: {} } }, target: { sheetId: SHEET, objectId: OBJECT } }
  for (const [label, overrides, failing] of [
    ['a declared action', {}, []],
    ['undeclared, nothing said', { action: undeclaredAction }, ['spec_read_plan_slot']],
    ['undeclared, a non-literal declaration', { action: undeclaredAction, specReadPlanSlotDeclaration: 'maybe' }, ['spec_read_plan_slot']],
    ['undeclared, declared not applicable', { action: undeclaredAction, specReadPlanSlotDeclaration: readiness.SPEC_READ_PLAN_SLOT_NOT_APPLICABLE }, []],
  ]) {
    assert.deepEqual([...(await run(overrides)).failing], failing, `no dep: ${label}`)
  }
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-pilot-gate.test.cjs', tests, { passLine: '✓ stock-preparation-pilot-gate' })
