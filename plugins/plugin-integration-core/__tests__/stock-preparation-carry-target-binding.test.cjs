'use strict'

// THE CARRY EXECUTOR MUST WRITE THE TABLE APPLY WROTE — the same disease the 按项目导出物料 Excel
// export had in #5437 and #5446 fixed, now on the write side.
//
// applyCarryViaConfirm used to locate its sheet by hardcoding the CANONICAL objectId
// (`plm_stock_preparation_main`) and resolving it through provisioning, while the apply writer
// (stock-preparation-apply-writer.cjs, target normalized in stock-preparation-table-actions.cjs) and
// the export (stock-preparation-prep-line-export.cjs) both write/read the DEPLOYMENT-BOUND
// `action.target.sheetId`. On a default install those are DIFFERENT TABLES: apply is sandbox-only
// unless an owner configured a time-boxed production policy, and `assertStockPrepApplySandboxAllowed`
// rejects the canonical objectId outright on that path — so the operator's rows live in the sandbox
// twin and the canonical table is empty forever. Carry therefore either 409'd
// CONFIRM_CARRY_TARGET_NOT_PROVISIONED, or 404'd on a source row that plainly exists, or — the worst
// of the three — quietly operated on the EMPTY canonical table while the human work it exists to
// preserve sat in the twin, reporting `carried` for a write nobody would ever see.
//
// The fix is not a smarter table lookup. It is to stop having a rule at all: the carry executor now
// takes the BOUND `target` ({ sheetId, fieldIdMap }) — the same object the writer writes through and
// the export reads through — and the route derives it SERVER-SIDE from the bound table action
// (getTableAction + assertStockPreparationTargetReady, exactly as the export route does). Nothing new
// is taken from the client; the closed body allowlist is unchanged.
//
// EVERY EXISTING CARRY GUARD IS RE-WITNESSED HERE against a sandbox-bound deployment, so "the carry
// moved tables" can never be read as "the carry got weaker": whitelist subset, source active===false,
// componentSourceId AND projectNo agreement, no-overwrite, replay no-op, optimistic concurrency,
// server-stamped carriedBy/carriedAt.
//
// FIXTURE LIMITATION, stated rather than hidden (same one #5446's export suite states):
// makeStrictRecordsApi validates physical field ids against a FROZEN template looked up by objectId,
// and a real sandbox twin's restamped objectId has no entry in that registry. So both sheets are
// registered under the canonical objectId here. That is faithful on the point under test — the twin
// IS the canonical template restamped, and the thing that differs between the two deployments is the
// SHEET the action is bound to, which is exactly what `target.sheetId` selects and exactly what the
// defect got wrong.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const {
  applyCarryViaConfirm,
  StockPreparationConfirmWriteError,
} = require(path.join(LIB, 'stock-preparation-confirm-writes.cjs'))
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  HUMAN_PRESERVED_FIELD_IDS,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { OBJECT_ID: LEDGER_OBJECT_ID } = require(path.join(LIB, 'stock-preparation-confirmation-decisions.cjs'))
const {
  makeFakeProvisioning,
  makeStrictRecordsApi,
  physicalFieldId,
  physicalRow,
  logicalData,
} = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const { createStockPreparationAuditStore } = require(path.join(LIB, 'stock-preparation-audit-store.cjs'))

const MAIN_OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
const STAGING = 'tenant-a:integration-core'
const TENANT_ID = 'tenant-a'
// The canonical table a default install provisions and NEVER writes.
const MAIN_SHEET = 'sheet_plm_stock_preparation_main'
// The sandbox twin a default install's apply actually writes.
const SANDBOX_SHEET = 'sheet_stock_prep_sandbox_twin'
// ...and its OWN objectId. The twin is the canonical template RESTAMPED under a sandbox id
// (stock-preparation-target-provisioning.cjs SANDBOX_OBJECT_ID_NAMESPACE), which is exactly why the
// canonical-objectId lookup could never find it. Giving the two bindings DIFFERENT objectIds is what
// lets T7-j witness its own headline: while both said `plm_stock_preparation_main`, an executor that
// reported a hardcoded canonical id satisfied the assertion identically.
const SANDBOX_OBJECT_ID = 'plm_stock_preparation_sandbox_m0'
const LEDGER_SHEET = 'sheet_confirmation_decisions'
const OPERATOR = 'user_admin_1'

const NEW_KEY = JSON.stringify({ projectNo: 'P-9', componentSourceId: 'COMP-X', parentSourceId: null, path: ['NEW', 'COMP-X'] })
const OLD_KEY = JSON.stringify({ projectNo: 'P-9', componentSourceId: 'COMP-X', parentSourceId: null, path: ['OLD', 'COMP-X'] })
const HUMAN_NOTE = '仓库已下单 2026-08-01 供应商确认'
const HUMAN_REPLY = '在途,预计 09-10'
// Content that must NEVER reach the bound sheet: it lives in whichever table the action is NOT
// bound to. A regression that reintroduces a hardcoded table cannot pass by accident — it carries
// THIS text, and the assertion names it.
const DECOY_NOTE = 'DECOY-NOTE-FROM-THE-WRONG-TABLE'
const DECOY_REPLY = 'DECOY-REPLY-FROM-THE-WRONG-TABLE'

let passed = 0
let failed = 0
const failures = []

function run(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1 })
    .catch((error) => {
      failed += 1
      failures.push(name)
      console.error(`FAIL: ${name}`)
      console.error(error && error.stack ? error.stack : error)
    })
}

function decisionFixture(overrides = {}) {
  return {
    decision: 'carry_via_confirm',
    idempotencyKey: NEW_KEY,
    sourceIdempotencyKey: OLD_KEY,
    componentSourceId: 'COMP-X',
    carryKey: 'component_source_id',
    manualRowReattach: 'propose_confirm',
    carryFields: ['notes', 'procurementReply'],
    writeVia: 'k2_confirm',
    requiresConfirm: true,
    carry: true,
    ...overrides,
  }
}

function mainRow(logical, id) {
  return physicalRow(STAGING, MAIN_OBJECT_ID, logical, id)
}

function sourceRowFixture(overrides = {}, id = 'row_source') {
  return mainRow({
    projectNo: 'P-9',
    idempotencyKey: OLD_KEY,
    componentSourceId: 'COMP-X',
    path: JSON.stringify(['OLD', 'COMP-X']),
    totalQuantity: 2,
    active: false,
    notes: HUMAN_NOTE,
    procurementReply: HUMAN_REPLY,
    ...overrides,
  }, id)
}

function targetRowFixture(overrides = {}, id = 'row_target') {
  return mainRow({
    projectNo: 'P-9',
    idempotencyKey: NEW_KEY,
    componentSourceId: 'COMP-X',
    path: JSON.stringify(['NEW', 'COMP-X']),
    totalQuantity: 2,
    active: true,
    ...overrides,
  }, id)
}

/** The operator's real rows: an inactive predecessor holding the human band + its re-keyed successor. */
function operatorRows() {
  return [sourceRowFixture(), targetRowFixture()]
}

/**
 * A COMPLETE, carry-eligible pair in the table the action is NOT bound to, carrying DECOY content.
 *
 * Deliberately carry-eligible rather than merely present: if it were absent or malformed, a
 * regression that goes back to the hardcoded canonical objectId would surface as a plain 404 and
 * could be mistaken for an unrelated fixture problem. Because it IS eligible, such a regression
 * SUCCEEDS against the wrong table — writing DECOY_NOTE onto a row the operator never sees while
 * the real target keeps its blank cells — which is precisely the silent failure this suite exists
 * to make loud.
 */
function decoyRows() {
  return [
    sourceRowFixture({ notes: DECOY_NOTE, procurementReply: DECOY_REPLY }, 'row_decoy_source'),
    targetRowFixture({}, 'row_decoy_target'),
  ]
}

// A target as real provisioning builds it: EVERY frozen template column bound to its derived
// physical id. The deploy-time completeness gate (assertTargetFieldMapCompleteness) independently
// REQUIRES an explicit map to bind the whole plm_system band, so a route-level mount with anything
// less is refused before the executor is reached.
const ALL_TEMPLATE_FIELD_IDS = Object.freeze(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => field.id))

function targetFor(sheetId, { without = [] } = {}) {
  const fieldIdMap = {}
  for (const fieldId of ALL_TEMPLATE_FIELD_IDS) {
    if (without.includes(fieldId)) continue
    fieldIdMap[fieldId] = physicalFieldId(STAGING, MAIN_OBJECT_ID, fieldId)
  }
  // The objectId is the BINDING's own — canonical for the production sheet, the restamped sandbox id
  // for the twin. The physical field ids stay derived from MAIN_OBJECT_ID: that is the stated fixture
  // limitation above (the strict records fake validates against a frozen template looked up by
  // objectId), and it is inert here because `pre_mapped` mode never consults the objectId at all.
  return { sheetId, objectId: sheetId === SANDBOX_SHEET ? SANDBOX_OBJECT_ID : MAIN_OBJECT_ID, fieldIdMap }
}

/**
 * Both sheets are ALWAYS seeded, with different content: whichever the action does not name holds
 * the decoys. `boundSheet` decides which deployment this models —
 *   SANDBOX_SHEET — a DEFAULT install: apply is sandbox-only, so the twin holds the operator's rows.
 *   MAIN_SHEET    — an owner-configured PRODUCTION install: the canonical table holds them.
 * Neither is named inside the executor; both are the same code path with a different binding.
 */
function substrate({ boundSheet = SANDBOX_SHEET, mainRows, sandboxRows, ledgerRows = [] } = {}) {
  const records = makeStrictRecordsApi({
    stagingProjectId: STAGING,
    objectIdBySheetId: {
      [MAIN_SHEET]: MAIN_OBJECT_ID,
      [SANDBOX_SHEET]: MAIN_OBJECT_ID,
      [LEDGER_SHEET]: LEDGER_OBJECT_ID,
    },
    rowsBySheet: {
      [MAIN_SHEET]: mainRows || (boundSheet === MAIN_SHEET ? operatorRows() : decoyRows()),
      [SANDBOX_SHEET]: sandboxRows || (boundSheet === SANDBOX_SHEET ? operatorRows() : decoyRows()),
      [LEDGER_SHEET]: ledgerRows,
    },
  })
  // Provisioning still resolves the CANONICAL objectId to the canonical sheet — exactly as a real
  // deployment's provisioning does. It is present in every fixture on purpose: the executor must
  // reach the bound sheet even though the old lookup is right there and would answer.
  const provisioning = makeFakeProvisioning({
    stagingProjectId: STAGING,
    sheetIdByObjectId: { [MAIN_OBJECT_ID]: MAIN_SHEET, [SANDBOX_OBJECT_ID]: SANDBOX_SHEET, [LEDGER_OBJECT_ID]: LEDGER_SHEET },
  })
  return { records, provisioning, target: targetFor(boundSheet), boundSheet }
}

function callInput(env, overrides = {}) {
  return {
    permission: 'admin',
    recordsApi: env.records,
    // Still supplied, exactly as the route has them for its LEDGER work — so a failure here can
    // never be "the test forgot to pass provisioning". The carry executor must ignore them.
    provisioning: env.provisioning,
    targetProjectId: STAGING,
    target: env.target,
    decision: decisionFixture(),
    confirmedBy: OPERATOR,
    ...overrides,
  }
}

function rowsOf(env, sheetId) {
  return env.records.rows(sheetId).map((row) => ({ id: row.id, version: row.version, data: logicalData(STAGING, MAIN_OBJECT_ID, row.data) }))
}

function rowByKey(env, sheetId, key) {
  const found = rowsOf(env, sheetId).filter((row) => row.data.idempotencyKey === key)
  assert.equal(found.length, 1, `exactly one row with that key in ${sheetId}`)
  return found[0]
}

async function expectError(promise, { status, code }) {
  let caught = null
  try {
    await promise
  } catch (error) {
    caught = error
  }
  assert.ok(caught, `expected an error (${code})`)
  assert.ok(caught instanceof StockPreparationConfirmWriteError,
    `expected confirm-write error, got ${caught.name}: ${caught.message}`)
  assert.equal(caught.status, status)
  assert.equal(caught.code, code)
  return caught
}

// ---------------------------------------------------------------------------
// Route harness — mirrors the carry-confirm suite's mount, plus the deploy-time
// table action the route now reads its target off.
// ---------------------------------------------------------------------------
function inertService(methods) {
  const out = {}
  for (const method of methods) {
    out[method] = async () => { throw new Error(`unexpected ${method}`) }
  }
  return out
}

function createFakeAuditDb() {
  const rows = []
  return {
    rows,
    async insertOne(table, row) {
      rows.push({ __table: table, ...JSON.parse(JSON.stringify(row)) })
      return [row]
    },
    async select(table) {
      return rows.filter((row) => row.__table === table)
    },
  }
}

function tableActionConfigFor(target) {
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: { externalSystemId: 'plm_sql_source', kind: 'data-source:sql-readonly' },
    target: { sheetId: target.sheetId, objectId: target.objectId, fieldIdMap: target.fieldIdMap },
  }
}

function mountCarryRoute({ boundSheet = SANDBOX_SHEET, configured = true, targetOverride } = {}) {
  const env = substrate({ boundSheet })
  if (targetOverride) env.target = targetOverride(env.target)
  const routes = new Map()
  const auditDb = createFakeAuditDb()
  const auditStore = createStockPreparationAuditStore({ db: auditDb, idGenerator: () => `audit_${auditDb.rows.length + 1}` })
  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      multitable: { provisioning: env.provisioning, records: env.records },
    },
    storage: new Map(),
    config: configured ? { stockPreparationTableActions: [tableActionConfigFor(env.target)] } : {},
  }
  const services = {
    externalSystemRegistry: {
      ...inertService(['upsertExternalSystem', 'deleteExternalSystem']),
      async getExternalSystem() { return null },
      async getExternalSystemForAdapter() { return null },
      async listExternalSystems() { return [] },
    },
    adapterRegistry: { listAdapterKinds() { return [] }, createAdapter() { throw new Error('unexpected adapter') } },
    pipelineRegistry: { ...inertService(['upsertPipeline', 'getPipeline', 'listPipelineRuns']), async listPipelines() { return [] } },
    pipelineRunner: inertService(['runPipeline']),
    deadLetterStore: inertService(['listDeadLetters']),
    stagingInstaller: inertService(['installStaging', 'listStagingDescriptors']),
    templateRegistry: inertService(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
    readSourceConfigStore: { ...inertService(['saveVersion', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']), async list() { return [] } },
    readSourceCompositionConfigStore: { ...inertService(['saveVersion', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']), async list() { return [] } },
    bridgeAgentChecklistStore: inertService(['saveVersion', 'approve', 'retire', 'getForApply']),
    stockPreparationAuditStore: auditStore,
  }
  httpRoutes.registerIntegrationRoutes({ context, services, logger: { info() {}, warn() {}, error() {} } })
  return { routes, auditDb, env }
}

const ADMIN = Object.freeze({ id: OPERATOR, roles: ['admin'], tenantId: TENANT_ID })
const CARRY_ROUTE = '/api/integration/stock-preparation/carry/confirm'

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

async function call(routes, method, routePath, req = {}) {
  const handler = routes.get(`${method.toUpperCase()} ${routePath}`)
  assert.ok(handler, `route ${method} ${routePath} is registered`)
  const res = createResponse()
  await handler({ user: req.user, body: req.body || {}, query: req.query || {}, params: req.params || {} }, res)
  return res
}

async function main() {
  // =========================================================================
  // T1 — the default install: canonical EMPTY, the operator's rows in the twin.
  // =========================================================================
  await run('T1: default (sandbox-bound) install — the human fields land on the TWIN row', async () => {
    const env = substrate({ boundSheet: SANDBOX_SHEET, mainRows: [] })
    const result = await applyCarryViaConfirm(callInput(env))
    assert.equal(result.persisted, true)
    assert.equal(result.mode, 'carried')
    assert.deepEqual(result.carriedFields.slice().sort(), ['notes', 'procurementReply'])
    const carried = rowByKey(env, SANDBOX_SHEET, NEW_KEY)
    assert.equal(carried.data.notes, HUMAN_NOTE, 'T1: the carried note landed on the row the operator actually has')
    assert.equal(carried.data.procurementReply, HUMAN_REPLY)
    assert.deepEqual(rowsOf(env, MAIN_SHEET), [], 'T1: the empty canonical table stayed empty')
  })

  await run('T1b: canonical table not provisioned at all — carry no longer 409s on a table it never needed', async () => {
    const env = substrate({ boundSheet: SANDBOX_SHEET, mainRows: [] })
    // A default install may not have the canonical table provisioned under the staging project at
    // all. That used to be a hard 409 CONFIRM_CARRY_TARGET_NOT_PROVISIONED even though the rows the
    // carry addresses were sitting right there in the bound sheet.
    env.provisioning = makeFakeProvisioning({
      stagingProjectId: STAGING,
      sheetIdByObjectId: { [LEDGER_OBJECT_ID]: LEDGER_SHEET },
    })
    const result = await applyCarryViaConfirm(callInput(env))
    assert.equal(result.mode, 'carried')
    assert.equal(rowByKey(env, SANDBOX_SHEET, NEW_KEY).data.notes, HUMAN_NOTE)
  })

  // =========================================================================
  // T2 — the SILENT one: both tables carry an eligible pair. Only the bound one may move.
  // =========================================================================
  await run('T2: canonical holds a stale eligible pair — the carry writes the BOUND twin, never the canonical', async () => {
    const env = substrate({ boundSheet: SANDBOX_SHEET })
    const result = await applyCarryViaConfirm(callInput(env))
    assert.equal(result.mode, 'carried')
    const carried = rowByKey(env, SANDBOX_SHEET, NEW_KEY)
    assert.equal(carried.data.notes, HUMAN_NOTE)
    assert.equal(carried.data.procurementReply, HUMAN_REPLY)
    const canonicalTarget = rowByKey(env, MAIN_SHEET, NEW_KEY)
    assert.equal(canonicalTarget.data.notes, undefined, 'T2: the unbound canonical row was never patched')
    assert.equal(canonicalTarget.data.procurementReply, undefined)
    assert.equal(canonicalTarget.version, 1, 'T2: the unbound canonical row did not even move a version')
    const flat = JSON.stringify(rowsOf(env, SANDBOX_SHEET))
    assert.ok(!flat.includes(DECOY_NOTE), 'T2: the wrong table\'s content never reached the bound sheet')
  })

  // =========================================================================
  // T3 — the production-policy deployment still works, unchanged.
  // =========================================================================
  await run('T3: owner-configured production install (canonical is the bound target) still carries', async () => {
    const env = substrate({ boundSheet: MAIN_SHEET })
    const result = await applyCarryViaConfirm(callInput(env))
    assert.equal(result.mode, 'carried')
    const carried = rowByKey(env, MAIN_SHEET, NEW_KEY)
    assert.equal(carried.data.notes, HUMAN_NOTE)
    assert.equal(carried.data.procurementReply, HUMAN_REPLY)
    const twinTarget = rowByKey(env, SANDBOX_SHEET, NEW_KEY)
    assert.equal(twinTarget.data.notes, undefined, 'T3: the unbound twin was never patched')
    assert.equal(twinTarget.version, 1)
  })

  // =========================================================================
  // T4 — the two never cross, in EITHER direction, at the host-call level.
  // =========================================================================
  await run('T4: every host records call names the BOUND sheet — both bindings, reads and writes', async () => {
    for (const boundSheet of [SANDBOX_SHEET, MAIN_SHEET]) {
      const other = boundSheet === SANDBOX_SHEET ? MAIN_SHEET : SANDBOX_SHEET
      const env = substrate({ boundSheet })
      await applyCarryViaConfirm(callInput(env))
      const touched = [...env.records.queryCalls, ...env.records.patchCalls].map((c) => c.sheetId)
      assert.ok(touched.length > 0, 'T4: the carry did reach the host')
      assert.deepEqual([...new Set(touched)], [boundSheet], `T4: only ${boundSheet} was addressed`)
      assert.ok(!touched.includes(other), `T4: ${other} was never addressed`)
      assert.equal(env.records.patchCalls.length, 1, 'T4: exactly ONE patch, on the bound sheet')
      assert.equal(env.records.patchCalls[0].sheetId, boundSheet)
    }
  })

  await run('T4b: a scoped records call cannot leave the bound sheet even if it tries', async () => {
    // The scope wall is createTargetScopedRecordsApi's (TABLE_ACTION_TARGET_SCOPE_VIOLATION); this
    // asserts the carry executor is genuinely behind it rather than calling the raw records API.
    const env = substrate({ boundSheet: SANDBOX_SHEET })
    const leaks = []
    const spying = {
      ...env.records,
      async queryRecords(input) { leaks.push(input.sheetId); return env.records.queryRecords(input) },
      async patchRecord(input) { leaks.push(input.sheetId); return env.records.patchRecord(input) },
      async createRecord(input) { leaks.push(input.sheetId); return env.records.createRecord(input) },
    }
    await applyCarryViaConfirm(callInput(env, { recordsApi: spying }))
    assert.deepEqual([...new Set(leaks)], [SANDBOX_SHEET])
  })

  // =========================================================================
  // T5 — the mutation witness: the executor may not resolve a sheet of its own.
  // =========================================================================
  await run('T5: carry needs NO provisioning and NO staging projectId — it cannot look a sheet up at all', async () => {
    const env = substrate({ boundSheet: SANDBOX_SHEET })
    const result = await applyCarryViaConfirm({
      permission: 'admin',
      recordsApi: env.records,
      target: env.target,
      decision: decisionFixture(),
      confirmedBy: OPERATOR,
    })
    assert.equal(result.mode, 'carried')
    assert.equal(rowByKey(env, SANDBOX_SHEET, NEW_KEY).data.notes, HUMAN_NOTE)
  })

  await run('T5b: when provisioning IS supplied, the carry never consults it', async () => {
    const env = substrate({ boundSheet: SANDBOX_SHEET })
    await applyCarryViaConfirm(callInput(env))
    assert.deepEqual(env.provisioning.calls.findObjectSheet, [],
      'T5b: a carry that resolves a sheet through provisioning is the defect')
    assert.deepEqual(env.provisioning.calls.resolveFieldIds, [],
      'T5b: field ids ride the bound target\'s own map, not an objectId-keyed registry lookup')
  })

  // =========================================================================
  // T6 — the target is mandatory, validated, and fails CLOSED on an unbound field.
  // =========================================================================
  await run('T6: an absent / sheetId-less target is refused 422 before any host IO', async () => {
    for (const target of [undefined, null, {}, { sheetId: '  ' }, 'sheet_x', { sheetId: MAIN_SHEET, fieldIdMap: 'nope' }]) {
      const env = substrate({ boundSheet: SANDBOX_SHEET })
      await expectError(
        applyCarryViaConfirm(callInput(env, { target })),
        { status: 422, code: 'CONFIRM_CARRY_TARGET_INVALID' },
      )
      assert.equal(env.records.queryCalls.length, 0, 'T6: refused before any read')
      assert.equal(env.records.patchCalls.length, 0)
    }
  })

  await run('T6b: a target that does not bind a CARRIED human column refuses by field NAME, and writes nothing', async () => {
    const env = substrate({ boundSheet: SANDBOX_SHEET })
    const error = await expectError(
      applyCarryViaConfirm(callInput(env, { target: targetFor(SANDBOX_SHEET, { without: ['procurementReply'] }) })),
      { status: 409, code: 'CONFIRM_CARRY_FIELD_NOT_BOUND' },
    )
    assert.deepEqual(error.details.fields, ['procurementReply'])
    assert.equal(JSON.stringify(error.details).includes(HUMAN_NOTE), false, 'T6b: refusals stay values-free')
    assert.equal(env.records.patchCalls.length, 0, 'T6b: nothing was written')
  })

  await run('T6b-pos: an UNCARRIED human column left unbound is NOT a refusal — carry binds only what it writes', async () => {
    // The POSITIVE CONTROL for T6b. T6b alone cannot witness the narrowing it names: widening the
    // required-binding set from `decision.carryFields` to every HUMAN_PRESERVED id keeps T6b green
    // (it removes a CARRIED field) while falsely 409-ing legal deployments on the 11 columns this
    // decision does not touch. Only a case that leaves an UNCARRIED human column unbound can tell
    // the two apart.
    const uncarried = HUMAN_PRESERVED_FIELD_IDS.filter((field) => !['notes', 'procurementReply'].includes(field))
    assert.ok(uncarried.length >= 2, 'the whitelist has human columns this decision does not carry')
    const env = substrate({ boundSheet: SANDBOX_SHEET })
    const result = await applyCarryViaConfirm(callInput(env, {
      target: targetFor(SANDBOX_SHEET, { without: uncarried }),
    }))
    assert.equal(result.mode, 'carried')
    assert.deepEqual(result.carriedFields.slice().sort(), ['notes', 'procurementReply'])
    assert.equal(rowByKey(env, SANDBOX_SHEET, NEW_KEY).data.notes, HUMAN_NOTE,
      'T6b-pos: a deployment that binds only the columns it uses still carries')
  })

  await run('T6c: a target that does not bind a SCOPE column is a broken config, not a best effort', async () => {
    for (const fieldId of ['idempotencyKey', 'active', 'componentSourceId', 'projectNo']) {
      const env = substrate({ boundSheet: SANDBOX_SHEET })
      const error = await expectError(
        applyCarryViaConfirm(callInput(env, { target: targetFor(SANDBOX_SHEET, { without: [fieldId] }) })),
        { status: 500, code: 'CONFIRM_CARRY_TARGET_FIELDS_UNRESOLVED' },
      )
      assert.deepEqual(error.details.missingFields, [fieldId])
      assert.equal(env.records.patchCalls.length, 0)
    }
  })

  await run('T6d: an EMPTY fieldIdMap is the logical-addressing mode, not an unbound target', async () => {
    // The same two modes the writer (apply-writer fieldIdMapHasExplicitBindings) and the export
    // (prep-line-export) decide with the same predicate: an empty map means the sheet is addressed
    // by logical id and every key passes through untranslated.
    const rows = operatorRows().map((row) => ({ ...row, data: logicalData(STAGING, MAIN_OBJECT_ID, row.data) }))
    const patched = []
    const logicalRecords = {
      async queryRecords({ sheetId, filters = {} }) {
        assert.equal(sheetId, SANDBOX_SHEET)
        return rows.filter((row) => Object.entries(filters).every(([k, v]) => row.data[k] === v)).map((row) => ({ ...row, data: { ...row.data } }))
      },
      async patchRecord({ sheetId, recordId, changes, expectedVersion }) {
        assert.equal(sheetId, SANDBOX_SHEET)
        patched.push({ recordId, changes, expectedVersion })
        const row = rows.find((r) => r.id === recordId)
        Object.assign(row.data, changes)
        row.version += 1
        return { ...row, data: { ...row.data } }
      },
      async createRecord() { throw new Error('carry never creates a row') },
    }
    const result = await applyCarryViaConfirm({
      permission: 'admin',
      recordsApi: logicalRecords,
      target: { sheetId: SANDBOX_SHEET, fieldIdMap: {} },
      decision: decisionFixture(),
      confirmedBy: OPERATOR,
    })
    assert.equal(result.mode, 'carried')
    assert.deepEqual(Object.keys(patched[0].changes).sort(), ['notes', 'procurementReply'],
      'T6d: logical keys crossed the boundary untranslated')
  })

  // =========================================================================
  // T7 — EVERY pre-existing guard, re-witnessed against the sandbox-bound target.
  // =========================================================================
  await run('T7-a: admin gate still fires FIRST, before any host IO', async () => {
    for (const permission of ['write', 'read', undefined, 'ADMIN']) {
      const env = substrate({ boundSheet: SANDBOX_SHEET })
      await expectError(
        applyCarryViaConfirm(callInput(env, { permission })),
        { status: 403, code: 'CONFIRM_PERMISSION_DENIED' },
      )
      assert.equal(env.records.queryCalls.length, 0)
      assert.equal(env.records.patchCalls.length, 0)
    }
  })

  await run('T7-b: carryFields must stay a non-empty subset of the human-preserved whitelist', async () => {
    const env = substrate({ boundSheet: SANDBOX_SHEET })
    for (const carryFields of [[], ['componentCode'], ['notes', 'active'], ['projectNo']]) {
      await expectError(
        applyCarryViaConfirm(callInput(env, { decision: decisionFixture({ carryFields }) })),
        { status: 422, code: 'CONFIRM_CARRY_DECISION_INVALID' },
      )
    }
    assert.equal(env.records.patchCalls.length, 0)
    for (const field of ['notes', 'procurementReply']) {
      assert.ok(HUMAN_PRESERVED_FIELD_IDS.includes(field))
    }
  })

  await run('T7-c: the source row must be INACTIVE on the bound sheet', async () => {
    const env = substrate({ boundSheet: SANDBOX_SHEET, sandboxRows: [sourceRowFixture({ active: true }), targetRowFixture()] })
    await expectError(applyCarryViaConfirm(callInput(env)), { status: 409, code: 'CONFIRM_CARRY_SOURCE_ACTIVE' })
    assert.equal(env.records.patchCalls.length, 0)
  })

  await run('T7-d: componentSourceId must agree across decision, source row and target row', async () => {
    const env = substrate({ boundSheet: SANDBOX_SHEET, sandboxRows: [sourceRowFixture({ componentSourceId: 'COMP-OTHER' }), targetRowFixture()] })
    await expectError(applyCarryViaConfirm(callInput(env)), { status: 409, code: 'CONFIRM_CARRY_COMPONENT_SOURCE_MISMATCH' })
    assert.equal(env.records.patchCalls.length, 0)
  })

  await run('T7-e: projectNo must agree — one project\'s human band never reaches another\'s row', async () => {
    const env = substrate({ boundSheet: SANDBOX_SHEET, sandboxRows: [sourceRowFixture({ projectNo: 'P-OTHER' }), targetRowFixture()] })
    await expectError(applyCarryViaConfirm(callInput(env)), { status: 409, code: 'CONFIRM_CARRY_PROJECT_MISMATCH' })
    assert.equal(env.records.patchCalls.length, 0)
  })

  await run('T7-f: no-overwrite — a differing non-blank target cell refuses, and NOTHING is written', async () => {
    const env = substrate({
      boundSheet: SANDBOX_SHEET,
      sandboxRows: [sourceRowFixture(), targetRowFixture({ procurementReply: '仓库自己写的答复' })],
    })
    const error = await expectError(applyCarryViaConfirm(callInput(env)), { status: 409, code: 'CONFIRM_CARRY_TARGET_ALREADY_SET' })
    assert.deepEqual(error.details.fields, ['procurementReply'])
    assert.equal(env.records.patchCalls.length, 0, 'T7-f: not even the clean field was half-carried')
    assert.equal(rowByKey(env, SANDBOX_SHEET, NEW_KEY).data.notes, undefined)
  })

  await run('T7-g: full replay is a no-op skip on the bound sheet', async () => {
    const env = substrate({ boundSheet: SANDBOX_SHEET })
    await applyCarryViaConfirm(callInput(env))
    assert.equal(env.records.patchCalls.length, 1)
    const replay = await applyCarryViaConfirm(callInput(env))
    assert.equal(replay.persisted, false)
    assert.equal(replay.mode, 'skipped_already_carried')
    assert.equal(env.records.patchCalls.length, 1, 'T7-g: the replay wrote nothing')
  })

  await run('T7-h: the patch carries expectedVersion — optimistic concurrency survives the move', async () => {
    const env = substrate({ boundSheet: SANDBOX_SHEET })
    const before = rowByKey(env, SANDBOX_SHEET, NEW_KEY)
    await applyCarryViaConfirm(callInput(env))
    assert.equal(env.records.patchCalls[0].expectedVersion, before.version)
    // ...and a row that moved between the read and the write is REFUSED, not clobbered.
    const racing = substrate({ boundSheet: SANDBOX_SHEET })
    const raced = {
      ...racing.records,
      async queryRecords(input) {
        const rows = await racing.records.queryRecords(input)
        return rows.map((row) => ({ ...row, version: (row.version || 1) - 1 }))
      },
    }
    await expectError(
      applyCarryViaConfirm(callInput(racing, { recordsApi: raced })),
      { status: 409, code: 'CONFIRM_CARRY_TARGET_VERSION_CONFLICT' },
    )
    assert.equal(rowByKey(racing, SANDBOX_SHEET, NEW_KEY).data.notes, undefined)
  })

  await run('T7-i: carriedBy/carriedAt are server-stamped, never decision- or body-sourced', async () => {
    const env = substrate({ boundSheet: SANDBOX_SHEET })
    for (const key of ['carriedBy', 'carriedAt', 'confirmedBy', 'confirmedAt']) {
      await expectError(
        applyCarryViaConfirm(callInput(env, { decision: decisionFixture({ [key]: 'attacker' }) })),
        { status: 422, code: 'CONFIRM_CARRY_DECISION_INVALID' },
      )
    }
    const result = await applyCarryViaConfirm(callInput(env))
    assert.equal(result.carriedBy, OPERATOR)
    assert.match(result.carriedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
    // The stamps live in the RESULT, never as columns on the row.
    const carried = rowByKey(env, SANDBOX_SHEET, NEW_KEY)
    assert.equal(Object.prototype.hasOwnProperty.call(carried.data, 'carriedBy'), false)
    assert.deepEqual(Object.keys(env.records.patchCalls[0].changes).length, 2, 'T7-i: exactly the two carried columns were written')
  })

  await run('T7-j: evidence stays values-free and names the BOUND target, not a hardcoded one', async () => {
    for (const boundSheet of [SANDBOX_SHEET, MAIN_SHEET]) {
      const env = substrate({ boundSheet })
      const result = await applyCarryViaConfirm(callInput(env))
      assert.equal(result.evidence.valuesFree, true)
      assert.equal(JSON.stringify(result.evidence).includes(HUMAN_NOTE), false)
      assert.equal(JSON.stringify(result.evidence).includes(DECOY_NOTE), false)
      assert.equal(result.evidence.target.keyField, 'idempotencyKey')
      // The BOUND binding's own objectId — canonical here, the restamped sandbox id there. An
      // executor that reported a hardcoded canonical constant fails this on the sandbox binding.
      assert.equal(result.evidence.target.objectId, env.target.objectId)
      assert.deepEqual(result.evidence.carriedFields.slice().sort(), ['notes', 'procurementReply'])
    }
  })

  // =========================================================================
  // T8 — the ROUTE derives the target server-side and takes nothing new from the client.
  // =========================================================================
  await run('T8: POST carry/confirm on a default (sandbox-bound) deployment carries the TWIN row', async () => {
    const { routes, env } = mountCarryRoute({ boundSheet: SANDBOX_SHEET })
    const res = await call(routes, 'POST', CARRY_ROUTE, { user: ADMIN, body: { decision: decisionFixture() } })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(res.body.ok, true)
    assert.equal(res.body.data.mode, 'carried')
    assert.equal(rowByKey(env, SANDBOX_SHEET, NEW_KEY).data.notes, HUMAN_NOTE)
    assert.equal(rowByKey(env, MAIN_SHEET, NEW_KEY).data.notes, undefined, 'T8: the canonical table was not touched')
  })

  await run('T8b: POST carry/confirm on an owner-configured production deployment carries the canonical row', async () => {
    const { routes, env } = mountCarryRoute({ boundSheet: MAIN_SHEET })
    const res = await call(routes, 'POST', CARRY_ROUTE, { user: ADMIN, body: { decision: decisionFixture() } })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(rowByKey(env, MAIN_SHEET, NEW_KEY).data.notes, HUMAN_NOTE)
    assert.equal(rowByKey(env, SANDBOX_SHEET, NEW_KEY).data.notes, undefined)
  })

  await run('T8c: the client cannot name the table — the closed body allowlist still refuses every target key', async () => {
    for (const key of ['target', 'sheetId', 'objectId', 'actionId', 'targetProjectId', 'fieldIdMap']) {
      const { routes, env } = mountCarryRoute({ boundSheet: SANDBOX_SHEET })
      const res = await call(routes, 'POST', CARRY_ROUTE, {
        user: ADMIN,
        body: { decision: decisionFixture(), [key]: MAIN_SHEET },
      })
      assert.equal(res.statusCode, 400, `T8c: body key ${key} must be refused`)
      assert.equal(res.body.error.code, 'STOCK_PREPARATION_CARRY_CONFIRM_REQUEST_INVALID')
      assert.equal(env.records.patchCalls.length, 0)
    }
  })

  await run('T8d: a deployment with NO configured stock-prep action refuses rather than guessing a table', async () => {
    const { routes, env } = mountCarryRoute({ boundSheet: SANDBOX_SHEET, configured: false })
    const res = await call(routes, 'POST', CARRY_ROUTE, { user: ADMIN, body: { decision: decisionFixture() } })
    assert.equal(res.statusCode, 422)
    assert.equal(res.body.error.code, 'TABLE_ACTION_NOT_CONFIGURED')
    assert.equal(env.records.patchCalls.length, 0, 'T8d: nothing was written anywhere')
    assert.equal(rowByKey(env, SANDBOX_SHEET, NEW_KEY).data.notes, undefined)
    assert.equal(rowByKey(env, MAIN_SHEET, NEW_KEY).data.notes, undefined)
  })

  await run('T8d-order: unconfigured deployment + a LEDGER pair => refused with ZERO host reads', async () => {
    // T8d alone cannot witness the handler's "resolve the target BEFORE the ledger pre-flight"
    // ordering: it sends no decisionId/inputFingerprint, so the pre-flight never runs and moving the
    // resolution after it stays green. With a ledger pair in the body the ordering becomes
    // observable — and it is behavioural, not cosmetic: resolving late turns an actionable 422
    // TABLE_ACTION_NOT_CONFIGURED into a misleading 404 about a ledger row, after a host read on a
    // deployment that can never carry.
    const { routes, env } = mountCarryRoute({ boundSheet: SANDBOX_SHEET, configured: false })
    const res = await call(routes, 'POST', CARRY_ROUTE, {
      user: ADMIN,
      body: { decision: decisionFixture(), decisionId: 'dec_1', inputFingerprint: 'fp_1' },
    })
    assert.equal(res.statusCode, 422, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'TABLE_ACTION_NOT_CONFIGURED')
    assert.equal(env.records.queryCalls.length, 0, 'T8d-order: not one host read before the refusal')
    assert.equal(env.records.patchCalls.length, 0)
  })

  await run('T8f: the route runs the READINESS gate on the bound target, not merely getTableAction', async () => {
    // `assertStockPreparationTargetReady` is the second half of the seam — without it an
    // incompletely-bound deployment would reach the executor and surface as its own 500 instead of
    // the deploy-time 422 an admin can act on. Dropping the assertion from the handler therefore
    // changes the code this case sees, which is what makes it mutation-sensitive rather than
    // decorative. A plm_system column is chosen because that is exactly the band the completeness
    // gate covers.
    const { routes, env } = mountCarryRoute({
      boundSheet: SANDBOX_SHEET,
      targetOverride(target) {
        const fieldIdMap = { ...target.fieldIdMap }
        delete fieldIdMap.componentSourceId
        return { ...target, fieldIdMap }
      },
    })
    const res = await call(routes, 'POST', CARRY_ROUTE, { user: ADMIN, body: { decision: decisionFixture() } })
    assert.equal(res.statusCode, 422, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'TARGET_SCHEMA_INCOMPLETE')
    assert.deepEqual(res.body.error.details.missingFields, ['componentSourceId'])
    assert.equal(env.records.patchCalls.length, 0, 'T8f: nothing was written')
    assert.equal(rowByKey(env, SANDBOX_SHEET, NEW_KEY).data.notes, undefined)
  })

  await run('T8e: the route still audits values-free, and the audit rides the same exception_resolve vocabulary', async () => {
    const { routes, auditDb } = mountCarryRoute({ boundSheet: SANDBOX_SHEET })
    const res = await call(routes, 'POST', CARRY_ROUTE, { user: ADMIN, body: { decision: decisionFixture() } })
    assert.equal(res.statusCode, 200)
    const entries = auditDb.rows.filter((row) => row.action === 'exception_resolve')
    assert.equal(entries.length, 1)
    const flat = JSON.stringify(entries[0])
    assert.equal(flat.includes(HUMAN_NOTE), false, 'T8e: the audit never carries a human value')
    assert.equal(flat.includes(DECOY_NOTE), false)
  })

  console.log(`carry-target-binding: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.error(`failing: ${failures.join(', ')}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
