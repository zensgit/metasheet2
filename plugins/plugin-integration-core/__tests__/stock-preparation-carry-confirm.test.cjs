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
// W4b: POST /api/integration/stock-preparation/carry/confirm, handler stockPreparationCarryConfirm,
// mirroring stockPreparationMaterialMappingConfirm — admin gate, closed body allowlist,
// values-free audit (existing exception_resolve action + fixed operation subtype, the same
// migration-frozen-vocabulary precedent the confirmation-decision confirm route set).

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const {
  applyCarryViaConfirm,
  StockPreparationConfirmWriteError,
} = require(path.join(LIB, 'stock-preparation-confirm-writes.cjs'))
const {
  OBJECT_ID: LEDGER_OBJECT_ID,
} = require(path.join(LIB, 'stock-preparation-confirmation-decisions.cjs'))
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  HUMAN_PRESERVED_FIELD_IDS,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const {
  makeFakeProvisioning,
  makeStrictRecordsApi,
  physicalRow,
  logicalData,
} = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const { createStockPreparationAuditStore } = require(path.join(LIB, 'stock-preparation-audit-store.cjs'))

const CANONICAL_OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
const STAGING = 'tenant-a:integration-core'
const CANONICAL_SHEET = 'sheet_plm_stock_preparation_main'
const LEDGER_SHEET = 'sheet_confirmation_decisions'
const OPERATOR = 'user_admin_1'

const NEW_KEY = JSON.stringify({ projectNo: 'P-9', componentSourceId: 'COMP-X', parentSourceId: null, path: ['NEW', 'COMP-X'] })
const OLD_KEY = JSON.stringify({ projectNo: 'P-9', componentSourceId: 'COMP-X', parentSourceId: null, path: ['OLD', 'COMP-X'] })
const HUMAN_NOTE = 'ordered 2026-08-01 supplier confirmed'
const HUMAN_REPLY = 'in transit, ETA 09-10'

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
      multitable: { provisioning, records },
    },
    storage: new Map(),
    config: {},
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
    ...(withAuditStore ? { stockPreparationAuditStore: auditStore } : {}),
  }
  httpRoutes.registerIntegrationRoutes({ context, services, logger: { info() {}, warn() {}, error() {} } })
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

function seedCarryLedgerRow({ decisionId = 'd1c1d1c1d1c1d1c1', inputFingerprint = 'f1f1f1f1f1f1f1f1', conflictType = 'carry_reattach_requires_confirm', status = 'pending' } = {}) {
  const row = physicalRow(STAGING, LEDGER_OBJECT_ID, {
    decisionId,
    stableDecisionKey: 'sk1',
    projectNo: 'P-9',
    rowIdentity: NEW_KEY,
    conflictType,
    inputFingerprint,
    sourceRevision: 'rev-1',
    status,
    openedAt: '2026-09-01T00:00:00.000Z',
  }, 'ledger_row_1')
  row.sheetId = LEDGER_SHEET
  return row
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
  // W4b — the route.
  // -------------------------------------------------------------------------
  await run('W4b-1: happy path — admin POST applies the carry, closes the named ledger row, audits values-free', async () => {
    const mounted = mountCarryRoute({ ledgerRows: [seedCarryLedgerRow()] })
    const res = await call(mounted.routes, 'POST', CARRY_ROUTE, {
      user: ADMIN,
      body: {
        decision: decisionFixture(),
        decisionId: 'd1c1d1c1d1c1d1c1',
        inputFingerprint: 'f1f1f1f1f1f1f1f1',
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

    // Ledger close failure (row already superseded): the carry applied; the response says the
    // ledger half honestly instead of lying with a clean 200-or-500 coin flip.
    const superseded = mountCarryRoute({ ledgerRows: [seedCarryLedgerRow({ status: 'superseded' })] })
    const res2 = await call(superseded.routes, 'POST', CARRY_ROUTE, {
      user: ADMIN,
      body: {
        decision: decisionFixture(),
        decisionId: 'd1c1d1c1d1c1d1c1',
        inputFingerprint: 'f1f1f1f1f1f1f1f1',
      },
    })
    assert.equal(res2.statusCode, 200)
    assert.equal(res2.body.data.mode, 'carried')
    assert.equal(res2.body.data.ledger.ok, false)
    assert.equal(res2.body.data.ledger.code, 'CONFIRMATION_DECISION_NOT_PENDING')
    const target = superseded.records.rows(CANONICAL_SHEET).map((row) => logicalData(STAGING, CANONICAL_OBJECT_ID, row.data))
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

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
