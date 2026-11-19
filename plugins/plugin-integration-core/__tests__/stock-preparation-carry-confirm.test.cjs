'use strict'

// W4a executor + W4b route (execution-plan general-prep-execution-plan-20260722.md:111-127).
//
// applyCarryViaConfirm is the ONE sanctioned write path for a CARRY_VIA_CONFIRM decision: a
// K2-style, admin-gated, server-stamped confirm write of the carried human fields onto the
// canonical row — never an ADD, never through the apply-writer. The locked 6 steps, each tested:
//   1  assertAdminPermission BEFORE any provisioning/records IO;
//   2  assertCarryViaConfirmShape (fail-closed on any malformed decision);
//   3  carryFields ⊆ HUMAN_PRESERVED_FIELD_IDS and writeVia === 'k2_confirm';
//   4  source row read by sourceIdempotencyKey MUST be active === false; target row read by
//      idempotencyKey (findByKeyField semantics: 404 absent, 500 ambiguous);
//   5  the module stamps carriedBy (route identity) / carriedAt (module clock) — the decision and
//      body can carry NEITHER (closed key allowlists refuse them);
//   6  idempotency / no-overwrite: a non-blank target human field is NEVER clobbered — equal
//      values skip (no-op replay), differing values refuse with a closed reason.
//
// M1–M10 + MP (owner ruling 2026-11-17 「按建议」): the carry also copies the MACHINE write-back
// column(s) (MACHINE_WRITEBACK_FIELD_IDS, today `issueConfirmDate`) from the predecessor onto an
// EMPTY successor cell, by the write-back's own D8 cell rule (decideIssueConfirmCell): blank -> carried,
// equal -> already set, any other value -> kept (never an overwrite, never a refusal). People can still
// never name the column in a decision.
//
// W4b: POST /api/integration/stock-preparation/carry/confirm, handler stockPreparationCarryConfirm,
// mirroring stockPreparationMaterialMappingConfirm — admin gate, closed body allowlist,
// values-free audit (existing exception_resolve action + fixed operation subtype, the same
// migration-frozen-vocabulary precedent the confirmation-decision confirm route set).

const assert = require('node:assert/strict')
const { withRefreshGovernance } = require('./support/stock-preparation-refresh-governance-wiring.cjs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const {
  applyCarryViaConfirm,
  StockPreparationConfirmWriteError,
} = require(path.join(LIB, 'stock-preparation-confirm-writes.cjs'))
const {
  OBJECT_ID: LEDGER_OBJECT_ID,
  createConfirmationDecisionReconcileLease,
  reconcileConfirmationDecisions,
} = require(path.join(LIB, 'stock-preparation-confirmation-decisions.cjs'))
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  HUMAN_PRESERVED_FIELD_IDS,
  MACHINE_WRITEBACK_FIELD_IDS,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))
// The write-back's own D8 cell rule — required ONLY by this test, to pin the carry leg's parity with it
// (the executor deliberately does not import the write-back module).
const { decideIssueConfirmCell } = require(path.join(LIB, 'yida-issue-confirm-writeback.cjs'))
const {
  makeFakeProvisioning,
  makeStrictRecordsApi,
  physicalFieldId,
  physicalRow,
  logicalData,
} = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const { createStockPreparationAuditStore } = require(path.join(LIB, 'stock-preparation-audit-store.cjs'))
const lockKit = require(path.join(__dirname, 'support', 'stock-preparation-project-write-lock-kit.cjs'))

const CANONICAL_OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
const STAGING = 'tenant-a:integration-core'
const CANONICAL_SHEET = 'sheet_plm_stock_preparation_main'
const LEDGER_SHEET = 'sheet_confirmation_decisions'
const OPERATOR = 'user_admin_1'

// THE BOUND TARGET the deployment's table action names. The carry executor takes this instead of
// resolving the canonical objectId through provisioning: on a default (sandbox-only) install those
// are DIFFERENT TABLES, and the old lookup addressed one nobody writes. This suite keeps exercising
// the CANONICAL sheet — i.e. an owner-configured production deployment — and the sandbox-twin half
// of the contract lives in stock-preparation-carry-target-binding.test.cjs.
const CARRY_TARGET = Object.freeze({
  sheetId: CANONICAL_SHEET,
  objectId: CANONICAL_OBJECT_ID,
  fieldIdMap: Object.freeze(Object.fromEntries(
    STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => [field.id, physicalFieldId(STAGING, CANONICAL_OBJECT_ID, field.id)]),
  )),
})
const CARRY_TABLE_ACTION_CONFIG = Object.freeze({
  actionId: PLM_STOCK_PREPARATION_ACTION_ID,
  source: { externalSystemId: 'plm_sql_source', kind: 'data-source:sql-readonly' },
  target: CARRY_TARGET,
})

const NEW_KEY = JSON.stringify({ projectNo: 'P-9', componentSourceId: 'COMP-X', parentSourceId: null, path: ['NEW', 'COMP-X'] })
const OLD_KEY = JSON.stringify({ projectNo: 'P-9', componentSourceId: 'COMP-X', parentSourceId: null, path: ['OLD', 'COMP-X'] })
const HUMAN_NOTE = 'ordered 2026-08-01 supplier confirmed'
const HUMAN_REPLY = 'in transit, ETA 09-10'
// Synthetic machine write-back dates (the date-typed column stores a string).
const MACHINE_FIELD = 'issueConfirmDate'
const SYN_DATE = '2031-04-17'
const SYN_DATE_OTHER = '2031-05-23'

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

function canonicalRow(logical, id) {
  const row = physicalRow(STAGING, CANONICAL_OBJECT_ID, logical, id)
  row.sheetId = CANONICAL_SHEET
  return row
}

function sourceRowFixture(overrides = {}) {
  return canonicalRow({
    projectNo: 'P-9',
    idempotencyKey: OLD_KEY,
    componentSourceId: 'COMP-X',
    path: JSON.stringify(['OLD', 'COMP-X']),
    totalQuantity: 2,
    active: false,
    notes: HUMAN_NOTE,
    procurementReply: HUMAN_REPLY,
    ...overrides,
  }, 'row_source')
}

function targetRowFixture(overrides = {}) {
  return canonicalRow({
    projectNo: 'P-9',
    idempotencyKey: NEW_KEY,
    componentSourceId: 'COMP-X',
    path: JSON.stringify(['NEW', 'COMP-X']),
    totalQuantity: 2,
    active: true,
    ...overrides,
  }, 'row_target')
}

function carryEnv({ rows } = {}) {
  const provisioning = makeFakeProvisioning({
    stagingProjectId: STAGING,
    sheetIdByObjectId: {
      [CANONICAL_OBJECT_ID]: CANONICAL_SHEET,
      [LEDGER_OBJECT_ID]: LEDGER_SHEET,
    },
  })
  const records = makeStrictRecordsApi({
    stagingProjectId: STAGING,
    objectIdBySheetId: {
      [CANONICAL_SHEET]: CANONICAL_OBJECT_ID,
      [LEDGER_SHEET]: LEDGER_OBJECT_ID,
    },
    rowsBySheet: { [CANONICAL_SHEET]: rows || [sourceRowFixture(), targetRowFixture()], [LEDGER_SHEET]: [] },
  })
  return { provisioning, records }
}

function callInput(env, overrides = {}) {
  return {
    permission: 'admin',
    recordsApi: env.records,
    provisioning: env.provisioning,
    targetProjectId: STAGING,
    target: CARRY_TARGET,
    decision: decisionFixture(),
    confirmedBy: OPERATOR,
    ...overrides,
  }
}

function canonicalRows(env) {
  return env.records.rows(CANONICAL_SHEET).map((row) => ({ id: row.id, data: logicalData(STAGING, CANONICAL_OBJECT_ID, row.data) }))
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
// W4b route harness (mirrors the source-binding routes test mount).
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
    async select(table, { where } = {}) {
      return rows.filter((row) => row.__table === table)
    },
  }
}

function mountCarryRoute({ withAuditStore = true, rows, ledgerRows = [] } = {}) {
  const routes = new Map()
  const auditDb = createFakeAuditDb()
  const auditStore = createStockPreparationAuditStore({ db: auditDb, idGenerator: () => `audit_${auditDb.rows.length + 1}` })
  const provisioning = makeFakeProvisioning({
    stagingProjectId: STAGING,
    sheetIdByObjectId: {
      [CANONICAL_OBJECT_ID]: CANONICAL_SHEET,
      [LEDGER_OBJECT_ID]: LEDGER_SHEET,
    },
  })
  const records = makeStrictRecordsApi({
    stagingProjectId: STAGING,
    objectIdBySheetId: {
      [CANONICAL_SHEET]: CANONICAL_OBJECT_ID,
      [LEDGER_SHEET]: LEDGER_OBJECT_ID,
    },
    rowsBySheet: {
      [CANONICAL_SHEET]: rows || [sourceRowFixture(), targetRowFixture()],
      [LEDGER_SHEET]: ledgerRows,
    },
  })
  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      // PR-0: the carry runs under the sheet write lease and its patch is host-fenced, so the fake
      // host declares + enforces the fence the way the real host does (the strict fake underneath is
      // untouched: the wrapper strips the fence before delegating, and `rows` / `store` / `patchCalls`
      // and a later method swap on the strict fake still reach it through the Proxy).
      multitable: { provisioning, records: lockKit.withFakeHostWriteFence(records) },
    },
    storage: new Map(),
    // The deploy-time table action the carry route now reads its target off — the SAME config shape
    // apply and dry-run are driven by.
    config: { stockPreparationTableActions: [CARRY_TABLE_ACTION_CONFIG] },
  }
  const services = {
    // PR-0: the sheet write lease the carry route holds (501 without it); the in-memory lock over the
    // kit's faithful fake of the scoped db helper.
    stockPreparationProjectWriteLock: lockKit.createInMemoryProjectWriteLock({ timers: 'real' }).lock,
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
    ...(withAuditStore ? { stockPreparationAuditStore: auditStore } : {}),
    // The host capability the carry route's tenant wall requires (#5445): the plugin submits two
    // identity strings and receives one boolean. These suites drive the route as the deployment's own
    // tenant, so the pairing is vouched for and the wall is transparent to them — the wall itself is
    // witnessed in stock-preparation-carry-target-binding.test.cjs (T9-*).
    tenantPrincipalDirectory: { async verifyTenantMembership() { return { member: true } } },
  }
  httpRoutes.registerIntegrationRoutes({ context, services: withRefreshGovernance(services), logger: { info() {}, warn() {}, error() {} } })
  return { routes, auditDb, provisioning, records }
}

const ADMIN = Object.freeze({ id: OPERATOR, roles: ['admin'], tenantId: 'tenant-a' })
const READER = Object.freeze({ id: 'u_reader', permissions: ['integration:read'], tenantId: 'tenant-a' })

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

function makeFakeLeaseDb() {
  const rows = new Map()
  return {
    async insertOne(table, row) {
      if (rows.has(row.scope_key)) { const e = new Error('duplicate key'); e.code = '23505'; throw e }
      rows.set(row.scope_key, { ...row })
      return [{ ...row }]
    },
    async selectOne(table, where) { const row = rows.get(where.scope_key); return row ? { ...row } : null },
    async updateRow(table, set, where) {
      const row = rows.get(where.scope_key)
      if (!row || row.lease_id !== where.lease_id) return []
      Object.assign(row, set); return [{ ...row }]
    },
    async deleteRows(table, where) {
      const row = rows.get(where.scope_key)
      if (!row || row.lease_id !== where.lease_id) return []
      rows.delete(where.scope_key); return [{ ...row }]
    },
  }
}

// A GENUINE pending carry row, produced by the real reconcile over the real planner hold shape.
// Hand-seeded rows are deliberately no longer usable here: the carry confirm binds the decision to
// the row by re-deriving stableDecisionKey/inputFingerprint, so only a真 reconcile artifact matches.
async function seedCarryLedgerRow(mounted, { decision = decisionFixture() } = {}) {
  await reconcileConfirmationDecisions({
    recordsApi: mounted.records,
    provisioning: mounted.provisioning,
    targetProjectId: STAGING,
    permission: 'admin',
    reconcileLease: createConfirmationDecisionReconcileLease({ db: makeFakeLeaseDb() }),
    projectNo: 'P-9',
    plan: {
      decisions: [{
        decision: 'manual_confirm',
        idempotencyKey: decision.idempotencyKey,
        conflictSummary: { type: 'carry_reattach_requires_confirm', proposed: true },
        changedFields: [],
        source: 'carry_policy',
        carryProposal: decision,
      }],
    },
    sourceRevision: 'rev-1',
  })
  return mounted.records.rows(LEDGER_SHEET).map((row) => logicalData(STAGING, LEDGER_OBJECT_ID, row.data))[0]
}

async function main() {
  // -------------------------------------------------------------------------
  // Step 1 — admin gate BEFORE any IO.
  // -------------------------------------------------------------------------
  await run('W4a-1: non-admin permission => 403 with ZERO provisioning and ZERO records calls', async () => {
    const env = carryEnv()
    await expectError(
      applyCarryViaConfirm(callInput(env, { permission: 'write' })),
      { status: 403, code: 'CONFIRM_PERMISSION_DENIED' },
    )
    assert.equal(env.provisioning.calls.findObjectSheet.length, 0)
    assert.equal(env.records.queryCalls.length, 0)
    assert.equal(env.records.patchCalls.length, 0)
  })

  // -------------------------------------------------------------------------
  // Steps 2+3 — shape + whitelist subset, fail-closed.
  // -------------------------------------------------------------------------
  await run('W4a-2/3: malformed decisions are refused before any write (shape battery)', async () => {
    const battery = [
      decisionFixture({ decision: 'add' }),
      decisionFixture({ requiresConfirm: false }),
      decisionFixture({ writeVia: 'planner_add' }),
      decisionFixture({ record: { notes: 'smuggled' } }),
      decisionFixture({ carryFields: ['notes', 'idempotencyKey'] }),
      decisionFixture({ carryFields: ['notes', 'lastPlmRefreshRunId'] }),
      decisionFixture({ notes: 'a human VALUE riding the decision' }),
      null,
      'carry',
    ]
    for (const decision of battery) {
      const env = carryEnv()
      await expectError(
        applyCarryViaConfirm(callInput(env, { decision })),
        { status: 422, code: 'CONFIRM_CARRY_DECISION_INVALID' },
      )
      assert.equal(env.records.patchCalls.length, 0, 'no malformed decision may reach a write')
    }
  })

  await run('W4a-5(guard): a decision smuggling carriedBy / carriedAt / confirmedBy is refused (server-stamp only)', async () => {
    for (const key of ['carriedBy', 'carriedAt', 'confirmedBy', 'confirmedAt']) {
      const env = carryEnv()
      await expectError(
        applyCarryViaConfirm(callInput(env, { decision: decisionFixture({ [key]: 'attacker' }) })),
        { status: 422, code: 'CONFIRM_CARRY_DECISION_INVALID' },
      )
    }
  })

  await run('W4a-3(guard): empty carryFields is refused (a carry that carries nothing is malformed)', async () => {
    const env = carryEnv()
    await expectError(
      applyCarryViaConfirm(callInput(env, { decision: decisionFixture({ carryFields: [] }) })),
      { status: 422, code: 'CONFIRM_CARRY_DECISION_INVALID' },
    )
  })

  // -------------------------------------------------------------------------
  // Step 4 — source must be inactive; both rows must resolve.
  // -------------------------------------------------------------------------
  await run('W4a-4: an ACTIVE source row is refused — a live row is never a carry source', async () => {
    const env = carryEnv({ rows: [sourceRowFixture({ active: true }), targetRowFixture()] })
    await expectError(
      applyCarryViaConfirm(callInput(env)),
      { status: 409, code: 'CONFIRM_CARRY_SOURCE_ACTIVE' },
    )
    assert.equal(env.records.patchCalls.length, 0)
  })

  await run('W4a-4b: absent source / absent target => 404; inactive target => 409', async () => {
    await expectError(
      applyCarryViaConfirm(callInput(carryEnv({ rows: [targetRowFixture()] }))),
      { status: 404, code: 'CONFIRM_CARRY_SOURCE_NOT_FOUND' },
    )
    await expectError(
      applyCarryViaConfirm(callInput(carryEnv({ rows: [sourceRowFixture()] }))),
      { status: 404, code: 'CONFIRM_CARRY_TARGET_NOT_FOUND' },
    )
    await expectError(
      applyCarryViaConfirm(callInput(carryEnv({ rows: [sourceRowFixture(), targetRowFixture({ active: false })] }))),
      { status: 409, code: 'CONFIRM_CARRY_TARGET_INACTIVE' },
    )
  })

  await run('W4a-4c: componentSourceId must agree on decision, source row AND target row', async () => {
    const env = carryEnv({
      rows: [sourceRowFixture({ componentSourceId: 'COMP-OTHER' }), targetRowFixture()],
    })
    await expectError(
      applyCarryViaConfirm(callInput(env)),
      { status: 409, code: 'CONFIRM_CARRY_COMPONENT_SOURCE_MISMATCH' },
    )
  })

  // -------------------------------------------------------------------------
  // Steps 5+6 — the write, the stamps, the no-overwrite discipline.
  // -------------------------------------------------------------------------
  await run('W4a-5: happy path — carried values patched onto the target, carriedBy/carriedAt module-stamped, values-free evidence', async () => {
    const env = carryEnv()
    const before = Date.parse('2026-09-02T00:00:00.000Z')
    const result = await applyCarryViaConfirm(callInput(env))
    assert.equal(result.persisted, true)
    assert.equal(result.mode, 'carried')
    assert.equal(result.carriedBy, OPERATOR, 'carriedBy is the route-derived identity')
    assert.ok(Number.isFinite(Date.parse(result.carriedAt)), 'carriedAt is a module-stamped ISO time')
    assert.ok(Date.parse(result.carriedAt) >= before - 86400000)
    assert.deepEqual(result.carriedFields.slice().sort(), ['notes', 'procurementReply'])

    // The canonical target now carries the human values — copied, not invented.
    const target = canonicalRows(env).find((row) => row.data.idempotencyKey === NEW_KEY)
    assert.equal(target.data.notes, HUMAN_NOTE)
    assert.equal(target.data.procurementReply, HUMAN_REPLY)

    // Exactly ONE patch, containing EXACTLY the carried fields — no stamps as columns,
    // no plm_system field, nothing else.
    assert.equal(env.records.patchCalls.length, 1)
    const patched = logicalData(STAGING, CANONICAL_OBJECT_ID, env.records.patchCalls[0].changes)
    assert.deepEqual(Object.keys(patched).sort(), ['notes', 'procurementReply'])

    // Values-free evidence: field NAMES and counts only.
    assert.equal(JSON.stringify(result.evidence).includes(HUMAN_NOTE), false)
    assert.equal(result.evidence.valuesFree, true)
    assert.deepEqual(result.evidence.carriedFields.slice().sort(), ['notes', 'procurementReply'])
  })

  await run('W4a-6: replay is a no-op (skipped_already_carried, zero patches)', async () => {
    const env = carryEnv()
    await applyCarryViaConfirm(callInput(env))
    const patchesAfterFirst = env.records.patchCalls.length
    const replay = await applyCarryViaConfirm(callInput(env))
    assert.equal(replay.persisted, false)
    assert.equal(replay.mode, 'skipped_already_carried')
    assert.equal(env.records.patchCalls.length, patchesAfterFirst, 'replay must not patch')
  })

  await run('W4a-6b: a target field the human edited since is NEVER clobbered (closed refusal, zero patches)', async () => {
    const env = carryEnv({
      rows: [sourceRowFixture(), targetRowFixture({ notes: 'the human already wrote something newer' })],
    })
    const caught = await expectError(
      applyCarryViaConfirm(callInput(env)),
      { status: 409, code: 'CONFIRM_CARRY_TARGET_ALREADY_SET' },
    )
    assert.deepEqual(caught.details.fields, ['notes'], 'the refusal names field NAMES only')
    assert.equal(JSON.stringify(caught.details).includes('the human already wrote'), false, 'never the value')
    assert.equal(env.records.patchCalls.length, 0, 'a conflicted carry writes NOTHING — not even the clean fields')
  })

  await run('W4a-6c: a source field that lost its value since plan time refuses (stale proposal)', async () => {
    const env = carryEnv({
      rows: [sourceRowFixture({ procurementReply: null }), targetRowFixture()],
    })
    await expectError(
      applyCarryViaConfirm(callInput(env)),
      { status: 409, code: 'CONFIRM_CARRY_SOURCE_CONTEXT_MISSING' },
    )
    assert.equal(env.records.patchCalls.length, 0)
  })

  await run('W4a: partial pre-existing EQUAL value skips that field and fills only the blank ones', async () => {
    const env = carryEnv({
      rows: [sourceRowFixture(), targetRowFixture({ notes: HUMAN_NOTE })],
    })
    const result = await applyCarryViaConfirm(callInput(env))
    assert.equal(result.persisted, true)
    assert.deepEqual(result.carriedFields, ['procurementReply'])
    assert.deepEqual(result.alreadyCarriedFields, ['notes'])
    const patched = logicalData(STAGING, CANONICAL_OBJECT_ID, env.records.patchCalls[0].changes)
    assert.deepEqual(Object.keys(patched), ['procurementReply'])
  })

  // -------------------------------------------------------------------------
  // M1–M10 + MP — the machine write-back column follows the re-keyed row (empty cell only).
  // -------------------------------------------------------------------------
  const valuesFree = (label, value) => {
    const text = JSON.stringify(value)
    assert.equal(text.includes(SYN_DATE) || text.includes(SYN_DATE_OTHER), false, `${label}: values-free (no date)`)
  }
  const patchedKeys = (env, index = 0) => Object.keys(logicalData(STAGING, CANONICAL_OBJECT_ID, env.records.patchCalls[index].changes)).sort()
  const targetData = (env) => canonicalRows(env).find((row) => row.data.idempotencyKey === NEW_KEY).data

  await run('M0: calibration — the machine band is exactly issueConfirmDate, outside the human whitelist', async () => {
    assert.deepEqual(MACHINE_WRITEBACK_FIELD_IDS.slice(), [MACHINE_FIELD])
    assert.equal(HUMAN_PRESERVED_FIELD_IDS.includes(MACHINE_FIELD), false)
    assert.ok(CARRY_TARGET.fieldIdMap[MACHINE_FIELD], 'the explicit-map fixture binds the machine column')
  })

  await run('M1: notes + date on the predecessor, blank successor => ONE patch carrying the human fields AND the date', async () => {
    const env = carryEnv({ rows: [sourceRowFixture({ [MACHINE_FIELD]: SYN_DATE }), targetRowFixture()] })
    const result = await applyCarryViaConfirm(callInput(env))
    assert.equal(result.persisted, true)
    assert.equal(result.mode, 'carried')
    assert.deepEqual(result.carriedFields.slice().sort(), ['notes', 'procurementReply'])
    assert.deepEqual(result.machineCarriedFields, [MACHINE_FIELD])
    assert.deepEqual(result.machineAlreadySetFields, [])
    assert.deepEqual(result.machineKeptExistingFields, [])
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'machineCode'), false)
    assert.equal(env.records.patchCalls.length, 1, 'one patch, no second write')
    assert.deepEqual(patchedKeys(env), [MACHINE_FIELD, 'notes', 'procurementReply'])
    assert.equal(targetData(env)[MACHINE_FIELD], SYN_DATE, 'the date followed the row')
    assert.deepEqual(result.evidence.machine, { carried: 1, alreadySet: 0, keptExisting: 0 })
    valuesFree('M1 result', result)
  })

  await run('M2: the successor already holds the SAME date => counted already set, not patched', async () => {
    const env = carryEnv({ rows: [sourceRowFixture({ [MACHINE_FIELD]: SYN_DATE }), targetRowFixture({ [MACHINE_FIELD]: SYN_DATE })] })
    const result = await applyCarryViaConfirm(callInput(env))
    assert.equal(result.mode, 'carried')
    assert.deepEqual(result.machineCarriedFields, [])
    assert.deepEqual(result.machineAlreadySetFields, [MACHINE_FIELD])
    assert.deepEqual(result.machineKeptExistingFields, [])
    assert.deepEqual(patchedKeys(env), ['notes', 'procurementReply'])
    assert.deepEqual(result.evidence.machine, { carried: 0, alreadySet: 1, keptExisting: 0 })
    valuesFree('M2 result', result)
  })

  await run('M3: the successor holds a DIFFERENT date => kept_existing + code; human fields still carried; the date never overwritten; no 409', async () => {
    const env = carryEnv({ rows: [sourceRowFixture({ [MACHINE_FIELD]: SYN_DATE }), targetRowFixture({ [MACHINE_FIELD]: SYN_DATE_OTHER })] })
    const result = await applyCarryViaConfirm(callInput(env))
    assert.equal(result.persisted, true)
    assert.equal(result.mode, 'carried')
    assert.deepEqual(result.carriedFields.slice().sort(), ['notes', 'procurementReply'])
    assert.deepEqual(result.machineCarriedFields, [])
    assert.deepEqual(result.machineKeptExistingFields, [MACHINE_FIELD])
    assert.equal(result.machineCode, 'CONFIRM_CARRY_MACHINE_KEPT_EXISTING')
    assert.deepEqual(patchedKeys(env), ['notes', 'procurementReply'], 'no date in the patch')
    assert.equal(targetData(env)[MACHINE_FIELD], SYN_DATE_OTHER, 'the successor date stands')
    assert.deepEqual(result.evidence.machine, { carried: 0, alreadySet: 0, keptExisting: 1 })
    valuesFree('M3 result', result)
  })

  await run('M4: a replay whose human fields are already equal carries just the date (persisted, mode carried, one patch)', async () => {
    const env = carryEnv({ rows: [sourceRowFixture({ [MACHINE_FIELD]: SYN_DATE }), targetRowFixture({ notes: HUMAN_NOTE, procurementReply: HUMAN_REPLY })] })
    const result = await applyCarryViaConfirm(callInput(env))
    assert.equal(result.persisted, true)
    assert.equal(result.mode, 'carried')
    assert.deepEqual(result.carriedFields, [])
    assert.deepEqual(result.alreadyCarriedFields.slice().sort(), ['notes', 'procurementReply'])
    assert.deepEqual(result.machineCarriedFields, [MACHINE_FIELD])
    assert.equal(env.records.patchCalls.length, 1)
    assert.deepEqual(patchedKeys(env), [MACHINE_FIELD])
    assert.equal(targetData(env)[MACHINE_FIELD], SYN_DATE)
    // ...and the replay of THAT is a true no-op.
    const again = await applyCarryViaConfirm(callInput(env))
    assert.equal(again.persisted, false)
    assert.equal(again.mode, 'skipped_already_carried')
    assert.deepEqual(again.machineAlreadySetFields, [MACHINE_FIELD])
    assert.equal(env.records.patchCalls.length, 1, 'no second patch')
    valuesFree('M4 result', [result, again])
  })

  await run('M5: a human conflict with a source date is still 409 with ZERO patches (a refused carry writes nothing, not even the date)', async () => {
    const env = carryEnv({ rows: [sourceRowFixture({ [MACHINE_FIELD]: SYN_DATE }), targetRowFixture({ notes: 'a newer human note' })] })
    const caught = await expectError(applyCarryViaConfirm(callInput(env)), { status: 409, code: 'CONFIRM_CARRY_TARGET_ALREADY_SET' })
    assert.deepEqual(caught.details.fields, ['notes'])
    assert.equal(env.records.patchCalls.length, 0)
    assert.equal(targetData(env)[MACHINE_FIELD], undefined)
    valuesFree('M5 details', caught.details)
  })

  await run('M6: no source date => empty machine arrays, the patch is the human fields only', async () => {
    const env = carryEnv()
    const result = await applyCarryViaConfirm(callInput(env))
    assert.deepEqual(result.machineCarriedFields, [])
    assert.deepEqual(result.machineAlreadySetFields, [])
    assert.deepEqual(result.machineKeptExistingFields, [])
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'machineCode'), false)
    assert.deepEqual(patchedKeys(env), ['notes', 'procurementReply'])
    assert.deepEqual(result.evidence.machine, { carried: 0, alreadySet: 0, keptExisting: 0 })
  })

  await run('M7: a person can never name the machine column in carryFields (422, zero IO)', async () => {
    for (const carryFields of [[MACHINE_FIELD], ['notes', MACHINE_FIELD]]) {
      const env = carryEnv({ rows: [sourceRowFixture({ [MACHINE_FIELD]: SYN_DATE }), targetRowFixture()] })
      await expectError(applyCarryViaConfirm(callInput(env, { decision: decisionFixture({ carryFields }) })), { status: 422, code: 'CONFIRM_CARRY_DECISION_INVALID' })
      assert.equal(env.records.queryCalls.length, 0)
      assert.equal(env.records.patchCalls.length, 0)
    }
  })

  await run('M8: the machine column as a decision KEY is refused by name (422, zero IO)', async () => {
    const env = carryEnv({ rows: [sourceRowFixture({ [MACHINE_FIELD]: SYN_DATE }), targetRowFixture()] })
    await expectError(applyCarryViaConfirm(callInput(env, { decision: decisionFixture({ [MACHINE_FIELD]: SYN_DATE }) })), { status: 422, code: 'CONFIRM_CARRY_DECISION_INVALID' })
    assert.equal(env.records.queryCalls.length, 0)
    assert.equal(env.records.patchCalls.length, 0)
  })

  await run('M9: an explicit map that does not bind the machine column => 500 CONFIRM_CARRY_TARGET_FIELDS_UNRESOLVED, zero IO', async () => {
    const fieldIdMap = { ...CARRY_TARGET.fieldIdMap }
    delete fieldIdMap[MACHINE_FIELD]
    const env = carryEnv({ rows: [sourceRowFixture({ [MACHINE_FIELD]: SYN_DATE }), targetRowFixture()] })
    const caught = await expectError(applyCarryViaConfirm(callInput(env, { target: { ...CARRY_TARGET, fieldIdMap } })), { status: 500, code: 'CONFIRM_CARRY_TARGET_FIELDS_UNRESOLVED' })
    assert.deepEqual(caught.details.missingFields, [MACHINE_FIELD])
    assert.equal(env.records.queryCalls.length, 0)
    assert.equal(env.records.patchCalls.length, 0)
  })

  await run('M10: a version conflict on a machine-only patch is 409 CONFIRM_CARRY_TARGET_VERSION_CONFLICT naming the field', async () => {
    const env = carryEnv({ rows: [sourceRowFixture({ [MACHINE_FIELD]: SYN_DATE }), targetRowFixture({ notes: HUMAN_NOTE, procurementReply: HUMAN_REPLY })] })
    const originalPatch = env.records.patchRecord.bind(env.records)
    env.records.patchRecord = async (input) => {
      env.records.store.get(CANONICAL_SHEET).find((row) => row.id === input.recordId).version += 1 // the row moved meanwhile
      return originalPatch(input)
    }
    const caught = await expectError(applyCarryViaConfirm(callInput(env)), { status: 409, code: 'CONFIRM_CARRY_TARGET_VERSION_CONFLICT' })
    assert.deepEqual(caught.details.fields, [MACHINE_FIELD])
    assert.equal(targetData(env)[MACHINE_FIELD], undefined, 'nothing written')
    valuesFree('M10 details', caught.details)
  })

  await run('MP: parity with the write-back D8 cell rule (decideIssueConfirmCell) over undefined / null / empty / equal / other / blank-padded', async () => {
    const cases = [
      ['undefined', undefined, false],
      ['null', null, true],
      ['empty', '', true],
      ['equal', SYN_DATE, true],
      ['other', SYN_DATE_OTHER, true],
      ['spaces', '  ', true],
    ]
    for (const [label, cell, present] of cases) {
      const env = carryEnv({ rows: [sourceRowFixture({ [MACHINE_FIELD]: SYN_DATE }), targetRowFixture(present ? { [MACHINE_FIELD]: cell } : {})] })
      const result = await applyCarryViaConfirm(callInput(env))
      const states = [
        ...result.machineCarriedFields.map(() => 'patch'),
        ...result.machineAlreadySetFields.map(() => 'already_set'),
        ...result.machineKeptExistingFields.map(() => 'kept_existing'),
      ]
      assert.deepEqual(states, [decideIssueConfirmCell(cell, SYN_DATE)], `parity: ${label}`)
    }
  })

  // -------------------------------------------------------------------------
  // W4b — the route.
  // -------------------------------------------------------------------------
  await run('W4b-1: happy path — admin POST applies the carry, closes the named ledger row, audits values-free', async () => {
    const mounted = mountCarryRoute()
    const ledgerRow = await seedCarryLedgerRow(mounted)
    const res = await call(mounted.routes, 'POST', CARRY_ROUTE, {
      user: ADMIN,
      body: {
        decision: decisionFixture(),
        decisionId: ledgerRow.decisionId,
        inputFingerprint: ledgerRow.inputFingerprint,
      },
    })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(res.body.ok, true)
    assert.equal(res.body.data.mode, 'carried')
    assert.equal(res.body.data.carriedBy, OPERATOR)
    assert.equal(res.body.data.ledger.status, 'confirmed')

    // The canonical row got the values.
    const target = mounted.records.rows(CANONICAL_SHEET).map((row) => logicalData(STAGING, CANONICAL_OBJECT_ID, row.data))
      .find((data) => data.idempotencyKey === NEW_KEY)
    assert.equal(target.notes, HUMAN_NOTE)

    // The ledger row is confirmed with the reserved carry token.
    const ledger = mounted.records.rows(LEDGER_SHEET).map((row) => logicalData(STAGING, LEDGER_OBJECT_ID, row.data))[0]
    assert.equal(ledger.status, 'confirmed')
    assert.equal(ledger.resolutionAction, 'carry_via_confirm')
    assert.equal(ledger.confirmedBy, OPERATOR)

    // Values-free audit on the migration-frozen vocabulary.
    assert.equal(mounted.auditDb.rows.length, 1)
    const audit = mounted.auditDb.rows[0]
    assert.equal(audit.action, 'exception_resolve')
    assert.equal(audit.detail.operation, 'stock_preparation_carry_confirm')
    assert.equal(audit.actor, OPERATOR)
    assert.equal(JSON.stringify(audit).includes(HUMAN_NOTE), false, 'audit stays values-free')
  })

  await run('W4b-1m: the route carries the machine date too — counts in the response and in the audit, values-free', async () => {
    const mounted = mountCarryRoute({ rows: [sourceRowFixture({ [MACHINE_FIELD]: SYN_DATE }), targetRowFixture()] })
    const ledgerRow = await seedCarryLedgerRow(mounted)
    const res = await call(mounted.routes, 'POST', CARRY_ROUTE, {
      user: ADMIN,
      body: { decision: decisionFixture(), decisionId: ledgerRow.decisionId, inputFingerprint: ledgerRow.inputFingerprint },
    })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(res.body.data.mode, 'carried')
    assert.deepEqual(res.body.data.machineCarriedFields, [MACHINE_FIELD])
    assert.equal(res.body.data.ledger.status, 'confirmed')
    const target = mounted.records.rows(CANONICAL_SHEET).map((row) => logicalData(STAGING, CANONICAL_OBJECT_ID, row.data))
      .find((data) => data.idempotencyKey === NEW_KEY)
    assert.equal(target[MACHINE_FIELD], SYN_DATE)
    assert.equal(mounted.auditDb.rows.length, 1)
    const audit = mounted.auditDb.rows[0]
    assert.equal(audit.detail.machineCarriedFieldCount, 1)
    assert.equal(audit.detail.machineKeptExistingCount, 0)
    assert.equal(audit.detail.carriedFieldCount, 2)
    const text = JSON.stringify([audit, res.body])
    assert.equal(text.includes(SYN_DATE) || text.includes(HUMAN_NOTE), false, 'values-free')
  })

  await run('W4b-2: the admin gate — anonymous 401, read-tier 403, ZERO records IO on refusal', async () => {
    const mounted = mountCarryRoute()
    const anonymous = await call(mounted.routes, 'POST', CARRY_ROUTE, { body: { decision: decisionFixture() } })
    assert.equal(anonymous.statusCode, 401)
    const reader = await call(mounted.routes, 'POST', CARRY_ROUTE, { user: READER, body: { decision: decisionFixture() } })
    assert.equal(reader.statusCode, 403)
    assert.equal(mounted.records.queryCalls.length, 0)
    assert.equal(mounted.records.patchCalls.length, 0)
    assert.equal(mounted.auditDb.rows.length, 0)
  })

  await run('W4b-3: closed body allowlist — an extra key (confirmedBy / carriedBy / anything) => 400 naming the field', async () => {
    for (const [key, value] of [['confirmedBy', 'attacker'], ['carriedBy', 'attacker'], ['carriedAt', 'now'], ['resolutionAction', 'keep_multiple_rows']]) {
      const mounted = mountCarryRoute()
      const res = await call(mounted.routes, 'POST', CARRY_ROUTE, {
        user: ADMIN,
        body: { decision: decisionFixture(), [key]: value },
      })
      assert.equal(res.statusCode, 400, `${key} must be refused`)
      assert.equal(res.body.error.code, 'STOCK_PREPARATION_CARRY_CONFIRM_REQUEST_INVALID')
      assert.equal(res.body.error.details.field, key)
      assert.equal(mounted.records.patchCalls.length, 0)
    }
  })

  await run('W4b-4: decisionId and inputFingerprint must travel together', async () => {
    const mounted = mountCarryRoute()
    const res = await call(mounted.routes, 'POST', CARRY_ROUTE, {
      user: ADMIN,
      body: { decision: decisionFixture(), decisionId: 'd1c1d1c1d1c1d1c1' },
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_CARRY_CONFIRM_REQUEST_INVALID')
    assert.equal(mounted.records.patchCalls.length, 0)
  })

  await run('W4b-5: no audit store => 501 refusal BEFORE any write (unaudited carry is refused)', async () => {
    const mounted = mountCarryRoute({ withAuditStore: false })
    const res = await call(mounted.routes, 'POST', CARRY_ROUTE, {
      user: ADMIN,
      body: { decision: decisionFixture() },
    })
    assert.equal(res.statusCode, 501)
    assert.equal(res.body.error.code, 'AUDIT_STORE_UNAVAILABLE')
    assert.equal(mounted.records.patchCalls.length, 0)
  })

  await run('W4b-6: apply-only mode (no ledger pair) works; a failed ledger close reports honestly without undoing the carry', async () => {
    // Apply-only: no decisionId/fingerprint — the carry applies, no ledger key in the response.
    const applyOnly = mountCarryRoute()
    const res = await call(applyOnly.routes, 'POST', CARRY_ROUTE, {
      user: ADMIN,
      body: { decision: decisionFixture() },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.mode, 'carried')
    assert.equal(Object.prototype.hasOwnProperty.call(res.body.data, 'ledger'), false)

  })

  await run('W4b-7: a SUPERSEDED approval row is refused BEFORE any write (a stale approval never carries)', async () => {
    // Tightened by the P1 fix: the pre-flight bind checks status too, so a carry whose approval was
    // superseded (the source moved and reconcile closed the hold) writes NOTHING. Previously this
    // carried first and merely reported the ledger half as failed — i.e. it applied a human decision
    // that no longer stood.
    const mounted = mountCarryRoute()
    const ledgerRow = await seedCarryLedgerRow(mounted)
    const stored = mounted.records.store.get(LEDGER_SHEET)[0]
    stored.data[physicalFieldId(STAGING, LEDGER_OBJECT_ID, 'status')] = 'superseded'
    const patchesBefore = mounted.records.patchCalls.length

    const res = await call(mounted.routes, 'POST', CARRY_ROUTE, {
      user: ADMIN,
      body: { decision: decisionFixture(), decisionId: ledgerRow.decisionId, inputFingerprint: ledgerRow.inputFingerprint },
    })
    assert.equal(res.statusCode, 409)
    assert.equal(res.body.error.code, 'CONFIRMATION_DECISION_NOT_PENDING')
    assert.equal(mounted.records.patchCalls.length, patchesBefore, 'nothing written')
    const target = mounted.records.rows(CANONICAL_SHEET).map((row) => logicalData(STAGING, CANONICAL_OBJECT_ID, row.data))
      .find((data) => data.idempotencyKey === NEW_KEY)
    assert.equal(target.notes, undefined, 'the stale-approved carry did not happen')
  })

  await run('W4b-8: a row superseded in the RACE window (after the bind, before the close) reports the ledger half honestly', async () => {
    // The one remaining path to a failed close: the row moves between the pre-flight bind and the
    // close. The carry has landed by then, so the response says so — and says the ledger half
    // failed — rather than lying in either direction.
    const mounted = mountCarryRoute()
    const ledgerRow = await seedCarryLedgerRow(mounted)
    let carryPatched = false
    const base = mounted.records
    // Flip the ledger row to superseded the moment the canonical carry patch lands.
    const originalPatch = base.patchRecord.bind(base)
    base.patchRecord = async (input) => {
      const result = await originalPatch(input)
      if (!carryPatched && input.sheetId === CANONICAL_SHEET) {
        carryPatched = true
        base.store.get(LEDGER_SHEET)[0].data[physicalFieldId(STAGING, LEDGER_OBJECT_ID, 'status')] = 'superseded'
      }
      return result
    }

    const res = await call(mounted.routes, 'POST', CARRY_ROUTE, {
      user: ADMIN,
      body: { decision: decisionFixture(), decisionId: ledgerRow.decisionId, inputFingerprint: ledgerRow.inputFingerprint },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.mode, 'carried')
    assert.equal(res.body.data.ledger.ok, false)
    assert.equal(res.body.data.ledger.code, 'CONFIRMATION_DECISION_NOT_PENDING')
    const target = base.rows(CANONICAL_SHEET).map((row) => logicalData(STAGING, CANONICAL_OBJECT_ID, row.data))
      .find((data) => data.idempotencyKey === NEW_KEY)
    assert.equal(target.notes, HUMAN_NOTE, 'the carry itself stood')
  })

  void HUMAN_PRESERVED_FIELD_IDS

  console.log(`carry-confirm: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.error(`failures: ${failures.join(', ')}`)
    process.exit(1)
  }
}

// S3 follow-ups 2 (item 5): the fail-closed runner (support/fail-closed-suite-runner.cjs) — `main` runs as one test
// under the exit sentinel and the whole-suite timeout, so a check that hangs can never end this suite with exit 0.
require('./support/fail-closed-suite-runner.cjs').runFailClosedMain('stock-preparation-carry-confirm.test.cjs', main)
