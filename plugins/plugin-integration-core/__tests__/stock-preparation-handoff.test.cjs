'use strict'

// 通知下一步 —— RED witnesses for the light 备料 handoff (turn state + advance route + notification).
//
// THE SIX GUARDS THE CHANGE PROMISES, each written to fail loudly if its production line is removed:
//
//   G1 ABSENT CONFIG => BYTE-IDENTICAL. With no `stockPreparationHandoff` server-config key, driving
//      the advance route leaves the ENTIRE observable side-effect surface deep-equal to its initial
//      state — no audit row, no db row, no notification attempt — and the status read answers a
//      frozen inert payload. Deep-equal pin, not a spot check.
//   G2 NOT THE CURRENT HANDLER => REFUSED. Including a platform admin, who is deliberately not
//      exempted, and including the case where the caller holds the right PERMISSION but not the turn.
//   G3 DOUBLE-ADVANCE DOES NOT DOUBLE-NOTIFY. The second click is a replay: 200, changed:false, and
//      the notifier is called exactly once across both.
//   G4 THE AUDIT ENTRY IS VALUES-FREE. Asserted against every seeded material string, and against
//      the live values-free gate the real store applies (assertValuesFreeDetail), not just by eye.
//   G5 THE TERMINAL STEP NOTIFIES EXACTLY ONCE AND NAMES THE APPROVER. One send, to the configured
//      warehouse+purchasing destinations, whose body contains the approver and a pointer to the
//      export — and which says the SYSTEM sent it (no impersonation).
//   G6 A NOTIFICATION FAILURE DOES NOT ROLL BACK OR CORRUPT THE TURN. The turn is committed BEFORE
//      the send; a throwing notifier yields 200 + notifyOutcome 'failed', the cursor stays advanced,
//      and the failure is NOT retried by clicking again (at-most-once, deliberately).
//
// plus: the closed step vocabulary is enforced, the body allowlist REFUSES extra keys (rather than
// ignoring them), a request cannot steer its own destination step, and the store's compare-and-set
// refuses a stale advance.
//
// THE SECOND ROUND — F1..F6, from the adversarial review of PR #5442. The six guards above were all
// real, and all six of these got past them, because each one lives in a gap the G-suite's fakes
// happened to close by accident:
//
//   F1 THE STORE'S "COMPARE-AND-SET" WAS ONLY A COMPARE. The in-transaction read was a plain
//      `selectOne` and the UPDATE's WHERE carried only the scope, so two advances whose READS both
//      landed before either WRITE both passed and both claimed the notification. The in-memory db
//      here runs the callback inline, which serialized the race away and hid it. Now: the read is
//      `selectOneForUpdate` and the UPDATE carries `step_index` / `notified_step_index` predicates,
//      zero rows == 409 WRITE_CONFLICT. Pinned by a db whose UPDATE sees the predicate fail.
//   F2 `projectNo` WAS UNVALIDATED FREE TEXT that is interpolated into a DingTalk markdown body,
//      an append-only audit row and a durable cursor row. Now: a shape rule (400) plus an existence
//      check against the bound target (404), both before any write.
//   F3 A CONFIG TYPO PARSED TO "configured, but with no destinations" — `terminal.groupDestinationId`
//      (singular), a bare string, a numeric id, a misspelt top-level key. The deployment believed
//      通知下一步 was wired up and nobody was ever told anything. Now: closed key sets, typed values,
//      and notify/terminal are all-or-nothing.
//   F5 THE REPLAY BRANCH RAN BEFORE THE HANDLER CHECK, so any stock-prep:operate holder who was
//      nobody's handler got a 200 and an audit row reading "replayed" under their own name. Now the
//      handler check is first — and the real handler's own double click is STILL a replay, because
//      the check consults the roster of `fromStepKey`, not the cursor.
//   F6 THE AUDIT ROW WAS WRITTEN BEFORE THE STORE CONFIRMED THE ADVANCE, so a refused compare-and-set
//      left an append-only row claiming a handoff that never happened. Now: store first, audit second.
//
// (F4 is the host-side companion — a server-originated DingTalk send must ride an admin-managed
// org-scoped destination — and is pinned in packages/core-backend/tests/unit/
// stock-preparation-handoff-notifier.test.ts, where that code lives.)
//
// Hermetic: no DB, no network, no DingTalk. The handoff store under test is the REAL one
// (stock-preparation-handoff-store.cjs) driven against an in-memory db fake, so the compare-and-set
// is genuinely exercised rather than stubbed away; the notifier is a spy standing in for the
// host-injected group-destination wrapper (packages/core-backend/src/index.ts).

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const { STOCK_PREP_OPERATE, STOCK_PREP_READ, STOCK_PREP_WORKBENCH_CAPABILITIES } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { STOCK_PREP_AUDIT_ACTIONS, __internals: auditInternals } = require(path.join(LIB, 'stock-preparation-audit-store.cjs'))
const {
  HANDOFF_CONFIG_KEY,
  STOCK_PREP_HANDOFF_STEPS,
  StockPreparationHandoffError,
  parseStockPreparationHandoffConfig,
  planStockPreparationHandoffAdvance,
  buildStockPreparationHandoffNotification,
  chainHasDestinationForHop,
} = require(path.join(LIB, 'stock-preparation-handoff.cjs'))
const {
  HANDOFF_TABLE,
  createStockPreparationHandoffStore,
} = require(path.join(LIB, 'stock-preparation-handoff-store.cjs'))
const { isValidStockPrepProjectNo } = require(path.join(LIB, 'stock-preparation-common.cjs'))
// F2: the advance route proves the project EXISTS before it writes anything, through the same
// getTableAction + records seam the export read uses. The suite therefore has to bind a target.
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(LIB, 'stock-preparation-templates.cjs'))

const TENANT_ID = 'tenant-handoff'
const OTHER_TENANT = 'tenant-other'
const PROJECT = 'PRJ-H1'

const STATUS_PATH = '/api/integration/stock-preparation/handoff'
const ADVANCE_PATH = '/api/integration/stock-preparation/handoff/advance'

const ZHANG = 'u_zhang'
const LI = 'u_li'
const WANG = 'u_wang'

const OPERATOR_ZHANG = Object.freeze({ id: ZHANG, tenantId: TENANT_ID, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const OPERATOR_LI = Object.freeze({ id: LI, tenantId: TENANT_ID, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const OPERATOR_WANG = Object.freeze({ id: WANG, tenantId: TENANT_ID, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
// Holds the write tier but is nobody's configured handler — the "permitted but not your turn" case.
const OPERATOR_STRANGER = Object.freeze({ id: 'u_stranger', tenantId: TENANT_ID, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const READ_ONLY = Object.freeze({ id: 'u_read', tenantId: TENANT_ID, permissions: [STOCK_PREP_READ] })
const INTEGRATION_WRITER = Object.freeze({ id: 'u_writer', tenantId: TENANT_ID, permissions: ['integration:write'] })
// Platform admin: passes the permission gate for everything, and is STILL refused a step that is not
// theirs, because an admin advancing someone else's step would make the trail lie about who did it.
const PLATFORM_ADMIN = Object.freeze({ id: 'u_admin', tenantId: TENANT_ID, permissions: ['role:admin', 'integration:admin'] })

const NOTIFY_DEST = 'dest-prep-team'
const WAREHOUSE_DEST = 'dest-warehouse'
const PURCHASING_DEST = 'dest-purchasing'
const EXPORT_PATH_HINT = '/stock-prep?tab=confirmation-queue'

// Synthetic customer values that must NEVER reach an audit row or a notification body. They are not
// used to seed anything the handoff reads — that is the point: if any of them ever appears in a
// handoff artifact, something has started reading row content that has no business doing so.
const FORBIDDEN_VALUES = Object.freeze([
  'DWG-A1', 'A项目部件一', 'Q235B', 'DN100', '1250',
])

function chainConfig() {
  return {
    [HANDOFF_CONFIG_KEY]: {
      steps: [
        { key: 'prep_entry', handlerUserIds: [ZHANG] },
        { key: 'process', handlerUserIds: [LI] },
        { key: 'final_review', handlerUserIds: [WANG] },
      ],
      notify: { groupDestinationId: NOTIFY_DEST },
      terminal: { groupDestinationIds: [WAREHOUSE_DEST, PURCHASING_DEST], exportPath: EXPORT_PATH_HINT },
    },
  }
}

// ---------------------------------------------------------------------------
// substrate
// ---------------------------------------------------------------------------

/**
 * A tiny in-memory stand-in for the plugin's scoped db helper, sufficient for the ONE table the
 * handoff store touches.
 *
 * TWO THINGS IT MODELS ON PURPOSE, both learned the hard way (F1):
 *
 *   * `matches` honours the FULL where clause, `step_index` / `notified_step_index` predicates
 *     included. A fake that matched on scope alone would make the store's compare-and-set look like
 *     it worked while the predicate did nothing — which is exactly the shape of the defect.
 *   * `updateRow` returns what the real one returns. `lib/db.cjs`'s updateRow is
 *     `UPDATE … RETURNING *` handed straight back from `database.query`, i.e. an ARRAY of the rows
 *     it actually touched: `[]` when the predicate matched nothing. The store reads that emptiness
 *     as a refusal, so the fake must be able to produce it.
 *
 * Deliberately NOT transactional in the isolation sense — it runs the callback inline. What the
 * concurrency guards need instead is a db that can put two reads before either write; that is
 * `makeRacingDb` below, and it is a separate fake precisely because this one cannot express it.
 */
function makeMemoryDb() {
  const rows = []
  const updateCalls = []
  function matches(row, where) {
    return Object.entries(where).every(([column, value]) => {
      const actual = row[column] === undefined ? null : row[column]
      return actual === (value === undefined ? null : value)
    })
  }
  const api = {
    rows,
    updateCalls,
    async selectOne(table, where) {
      assert.equal(table, HANDOFF_TABLE, 'the handoff store touches exactly one table')
      return rows.find((row) => matches(row, where)) || null
    },
    // SELECT … FOR UPDATE. Inline execution means there is nothing to lock out here; what this fake
    // does provide is the SEAM, so the store's wiring-time requirement ("a db without it degrades
    // the compare-and-set to a plain read") is satisfied by something real rather than stubbed.
    async selectOneForUpdate(table, where) {
      assert.equal(table, HANDOFF_TABLE, 'the handoff store touches exactly one table')
      return rows.find((row) => matches(row, where)) || null
    },
    async insertOne(table, row) {
      assert.equal(table, HANDOFF_TABLE)
      const stored = { workspace_id: null, notified_step_index: null, updated_by: null, ...row }
      rows.push(stored)
      return [stored]
    },
    async updateRow(table, patch, where) {
      assert.equal(table, HANDOFF_TABLE)
      updateCalls.push({ patch, where })
      const found = rows.find((row) => matches(row, where))
      if (!found) return []
      Object.assign(found, patch)
      return [found]
    },
    async transaction(fn) {
      return fn(api)
    },
  }
  return api
}

// The sheet the bound stock-prep target resolves to. Only its identity matters here — no row content
// is ever read by the handoff, which is the point of the existence check being `limit: 1`.
const HANDOFF_SHEET = 'sheet_handoff_main'

/** The deploy-time table-action binding the advance route's existence check resolves through. */
function tableActionConfig() {
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: { externalSystemId: 'plm_sql_source', kind: 'data-source:sql-readonly' },
    target: { sheetId: HANDOFF_SHEET, objectId: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId, fieldIdMap: {} },
  }
}

/**
 * A read-only multitable records API that knows about `projectNos` and nothing else.
 *
 * `queries` is recorded so a test can assert the existence check is a SINGLE-ROW probe rather than a
 * full material listing — the whole reason `stockPreparationProjectHasMainRows` exists separately
 * from the export.
 */
function makeRecordsApi(projectNos = [PROJECT]) {
  const queries = []
  return {
    queries,
    async queryRecords(input) {
      queries.push(input)
      const wanted = input && input.filters && input.filters.projectNo
      return projectNos.includes(wanted) ? [{ id: 'rec_1', data: { projectNo: wanted, active: true } }] : []
    },
  }
}

/** Records every send the route asks for; `mode` decides whether it succeeds, fails or throws. */
function makeNotifierSpy(mode = 'ok') {
  const calls = []
  return {
    calls,
    async sendToDestinations(request) {
      calls.push(request)
      if (mode === 'throw') throw new Error('webhook exploded — this message must never reach a caller')
      if (mode === 'zero') return { delivered: 0, failed: request.destinationIds.length }
      return { delivered: request.destinationIds.length, failed: 0 }
    },
  }
}

function inertService(methods) {
  const service = {}
  for (const method of methods) {
    service[method] = async () => {
      throw new Error(`unexpected service call: ${method}`)
    }
  }
  return service
}

function baseServices() {
  return {
    externalSystemRegistry: inertService(['upsertExternalSystem', 'getExternalSystem', 'deleteExternalSystem', 'listExternalSystems']),
    adapterRegistry: inertService(['createAdapter', 'listAdapterKinds']),
    pipelineRegistry: inertService(['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns']),
    pipelineRunner: inertService(['runPipeline']),
    deadLetterStore: inertService(['listDeadLetters']),
    stagingInstaller: inertService(['installStaging', 'listStagingDescriptors']),
    templateRegistry: inertService(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
    readSourceConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    readSourceCompositionConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    bridgeAgentChecklistStore: inertService(['saveVersion', 'approve', 'retire', 'getForApply']),
  }
}

/**
 * Mount the real route stack.
 *
 * `config` defaults to the three-step chain; pass `{}` for the ABSENT-CONFIG case (G1).
 * The audit store applies the REAL values-free gate rather than merely recording, so a detail that
 * would be refused in production is refused here too.
 */
function mount({
  config = chainConfig(),
  notifier = makeNotifierSpy(),
  db = makeMemoryDb(),
  // F2: the advance route resolves the bound target and asks whether this project has ANY
  // stock-prep row before it writes. Default: the suite's PROJECT exists.
  records = makeRecordsApi(),
} = {}) {
  const routes = new Map()
  const auditAppends = []
  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      multitable: {
        provisioning: inertService(['resolveFieldIds']),
        records,
      },
    },
    storage: new Map(),
    config: { ...config, stockPreparationTableActions: [tableActionConfig()] },
  }
  const services = baseServices()
  services.stockPreparationAuditStore = {
    async append(entry) {
      // The REAL gate, so a values-bearing detail reds here exactly as it would in production.
      auditInternals.assertValuesFreeDetail(entry.detail)
      assert.ok(STOCK_PREP_AUDIT_ACTIONS.includes(entry.action), `audit action ${entry.action} is in the closed vocabulary`)
      auditAppends.push(entry)
      return { ok: true }
    },
  }
  services.stockPreparationHandoffStore = createStockPreparationHandoffStore({
    db,
    idGenerator: (() => {
      let n = 0
      return () => `handoff-${(n += 1)}`
    })(),
  })
  services.stockPreparationHandoffNotifier = notifier
  httpRoutes.registerIntegrationRoutes({
    context,
    services,
    logger: { info() {}, warn() {}, error() {} },
  })
  return { routes, auditAppends, notifier, db, records }
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    setHeader(name, value) { this.headers[name] = value; return this },
    send(payload) { this.sentBuffer = payload; return this },
  }
}

async function call(routes, method, routePath, req = {}) {
  const handler = routes.get(`${method.toUpperCase()} ${routePath}`)
  assert.ok(handler, `route ${method} ${routePath} is registered`)
  const res = createResponse()
  await handler({ user: req.user, body: req.body || {}, query: req.query || {}, params: req.params || {} }, res)
  return res
}

function advance(routes, user, body) {
  return call(routes, 'POST', ADVANCE_PATH, { user, body: { tenantId: TENANT_ID, projectNo: PROJECT, ...body } })
}

function status(routes, user, query = {}) {
  return call(routes, 'GET', STATUS_PATH, { user, query: { tenantId: TENANT_ID, projectNo: PROJECT, ...query } })
}

// ---------------------------------------------------------------------------
// G1 — absent config => byte-identical
// ---------------------------------------------------------------------------

async function g1AbsentConfigLeavesEveryObservableSurfaceUntouched() {
  const notifier = makeNotifierSpy()
  const db = makeMemoryDb()
  const { routes, auditAppends } = mount({ config: {}, notifier, db })

  // A deep-equal PIN over the whole observable side-effect surface, captured before anything runs.
  const before = JSON.parse(JSON.stringify({ auditAppends, dbRows: db.rows, notifierCalls: notifier.calls }))
  assert.deepEqual(before, { auditAppends: [], dbRows: [], notifierCalls: [] })

  // Drive the advance route as hard as a real operator could: the right permission, the right
  // tenant, a real step key from the closed vocabulary, twice.
  for (const step of ['prep_entry', 'final_review']) {
    const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: step })
    assert.equal(res.statusCode, 501, 'G1: an unconfigured deployment refuses the advance')
    assert.equal(res.body.ok, false)
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_HANDOFF_NOT_CONFIGURED')
  }

  const after = JSON.parse(JSON.stringify({ auditAppends, dbRows: db.rows, notifierCalls: notifier.calls }))
  assert.deepEqual(
    after,
    before,
    'G1: with no handoff config the deployment\'s state is byte-identical — no audit row, no db row, no notification attempt',
  )

  // And the status read answers an inert payload rather than erroring, so an unconfigured workbench
  // renders nothing instead of showing the operator a failure on a page they came to for other work.
  const statusRes = await status(routes, READ_ONLY)
  assert.equal(statusRes.statusCode, 200)
  assert.deepEqual(statusRes.body, {
    ok: true,
    data: {
      configured: false,
      projectNo: PROJECT,
      steps: [],
      stepCount: 0,
      stepIndex: null,
      currentStepKey: null,
      terminal: false,
      completed: false,
      isCurrentHandler: false,
      notifiedStepIndex: null,
    },
  }, 'G1: the inert status payload is pinned field-for-field')
}

async function g1AbsentConfigRefusesBeforeTouchingTheStore() {
  // The refusal must come from the CONFIG check, not from something downstream noticing later. A
  // store that throws on any call proves the order.
  const explodingStore = {
    async get() { throw new Error('the store must never be reached without config') },
    async advance() { throw new Error('the store must never be reached without config') },
  }
  const notifier = makeNotifierSpy()
  const { routes } = (() => {
    const db = makeMemoryDb()
    const mounted = mount({ config: {}, notifier, db })
    return mounted
  })()
  // Re-mount with the exploding store in place of the real one.
  const routes2 = new Map()
  const context = {
    api: {
      http: { addRoute(method, routePath, handler) { routes2.set(`${method.toUpperCase()} ${routePath}`, handler) } },
      multitable: { provisioning: inertService(['resolveFieldIds']), records: inertService(['listRecords']) },
    },
    storage: new Map(),
    config: {},
  }
  const services = baseServices()
  services.stockPreparationAuditStore = { async append() { throw new Error('the audit store must never be reached without config') } }
  services.stockPreparationHandoffStore = explodingStore
  services.stockPreparationHandoffNotifier = notifier
  httpRoutes.registerIntegrationRoutes({ context, services, logger: { info() {}, warn() {}, error() {} } })
  const res = await call(routes2, 'POST', ADVANCE_PATH, {
    user: OPERATOR_ZHANG,
    body: { tenantId: TENANT_ID, projectNo: PROJECT, fromStepKey: 'prep_entry' },
  })
  assert.equal(res.statusCode, 501)
  assert.equal(res.body.error.code, 'STOCK_PREPARATION_HANDOFF_NOT_CONFIGURED')
  assert.equal(notifier.calls.length, 0)
  assert.ok(routes.size > 0, 'the first mount registered routes (sanity)')
}

// ---------------------------------------------------------------------------
// G2 — not the current handler => refused
// ---------------------------------------------------------------------------

async function g2NonCurrentHandlerIsRefused() {
  // Every one of these holds the WRITE permission (or more), and none of them holds the TURN.
  for (const user of [OPERATOR_LI, OPERATOR_WANG, OPERATOR_STRANGER, PLATFORM_ADMIN]) {
    const notifier = makeNotifierSpy()
    const db = makeMemoryDb()
    const { routes, auditAppends } = mount({ notifier, db })
    const res = await advance(routes, user, { fromStepKey: 'prep_entry' })
    assert.equal(res.statusCode, 403, `G2: ${user.id} does not hold step prep_entry (got ${res.statusCode})`)
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_HANDOFF_NOT_CURRENT_HANDLER')
    assert.deepEqual(db.rows, [], `G2: ${user.id}'s refused advance left no turn state`)
    assert.equal(notifier.calls.length, 0, `G2: ${user.id}'s refused advance sent nothing`)
    assert.deepEqual(auditAppends, [], `G2: ${user.id} is refused BEFORE the audit append`)
  }
}

async function g2PermissionGateStillRefusesUnderPrivilegedPrincipals() {
  // The turn check is not a substitute for the permission gate. A read-only principal is refused by
  // the GATE even when they ARE the configured handler.
  const config = chainConfig()
  config[HANDOFF_CONFIG_KEY].steps[0].handlerUserIds = [READ_ONLY.id, INTEGRATION_WRITER.id]
  for (const user of [undefined, READ_ONLY, INTEGRATION_WRITER]) {
    const notifier = makeNotifierSpy()
    const db = makeMemoryDb()
    const { routes } = mount({ config, notifier, db })
    const res = await advance(routes, user, { fromStepKey: 'prep_entry' })
    assert.ok([401, 403].includes(res.statusCode), `${user ? user.id : 'anonymous'} is refused`)
    assert.ok(['UNAUTHENTICATED', 'FORBIDDEN'].includes(res.body.error.code), 'refused by the permission GATE, not the turn check')
    assert.deepEqual(db.rows, [])
    assert.equal(notifier.calls.length, 0)
  }
}

async function g2StatusReportsWhoseTurnItIsWithoutLeakingTheRoster() {
  const { routes } = mount()
  const mine = await status(routes, OPERATOR_ZHANG)
  assert.equal(mine.statusCode, 200)
  assert.equal(mine.body.data.currentStepKey, 'prep_entry')
  assert.equal(mine.body.data.isCurrentHandler, true, 'the configured handler is told it is their turn')
  const theirs = await status(routes, OPERATOR_LI)
  assert.equal(theirs.body.data.isCurrentHandler, false, 'a later step\'s handler is told it is not theirs yet')
  // COUNTS, never identities.
  assert.deepEqual(theirs.body.data.steps, [
    { key: 'prep_entry', order: 0, handlerCount: 1 },
    { key: 'process', order: 1, handlerCount: 1 },
    { key: 'final_review', order: 2, handlerCount: 1 },
  ])
  const flat = JSON.stringify(theirs.body)
  for (const identity of [ZHANG, WANG, NOTIFY_DEST, WAREHOUSE_DEST, PURCHASING_DEST]) {
    assert.ok(!flat.includes(identity), `the values-free status read must not carry ${identity}`)
  }
}

// ---------------------------------------------------------------------------
// G3 — double-advance does not double-notify
// ---------------------------------------------------------------------------

async function g3DoubleAdvanceDoesNotDoubleNotify() {
  const notifier = makeNotifierSpy()
  const db = makeMemoryDb()
  const { routes } = mount({ notifier, db })

  const first = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(first.statusCode, 200)
  assert.equal(first.body.data.changed, true)
  assert.equal(first.body.data.notified, true)
  assert.equal(first.body.data.notifyOutcome, 'sent')
  assert.equal(first.body.data.currentStepKey, 'process')
  assert.equal(notifier.calls.length, 1)

  // The same person clicks again — the classic double click. It is a REPLAY, not an error and not a
  // second advance.
  const second = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(second.statusCode, 200, 'G3: a double click is not an error')
  assert.equal(second.body.data.changed, false, 'G3: the second click changed nothing')
  assert.equal(second.body.data.notified, false)
  assert.equal(second.body.data.currentStepKey, 'process', 'G3: the cursor did not move twice')
  assert.equal(notifier.calls.length, 1, 'G3: exactly ONE notification across two clicks')

  assert.equal(db.rows.length, 1, 'G3: one project, one cursor row')
  assert.equal(db.rows[0].step_index, 1)
  assert.equal(db.rows[0].notified_step_index, 0)
}

async function g3AStaleAdvanceIsRefusedRatherThanSkippingAStep() {
  const notifier = makeNotifierSpy()
  const db = makeMemoryDb()
  const { routes } = mount({ notifier, db })
  await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  // 王 tries to hand off the LAST step while the chain is only at step 1. Advancing anyway would
  // silently skip 李's step and fire the 仓库/采购 notice early.
  const res = await advance(routes, OPERATOR_WANG, { fromStepKey: 'final_review' })
  assert.equal(res.statusCode, 409)
  assert.equal(res.body.error.code, 'STOCK_PREPARATION_HANDOFF_STEP_MISMATCH')
  assert.equal(db.rows[0].step_index, 1, 'the cursor did not move')
  assert.equal(notifier.calls.length, 1, 'only the legitimate first handoff notified')
}

// ---------------------------------------------------------------------------
// G4 — the audit entry is values-free
// ---------------------------------------------------------------------------

async function g4AuditEntryIsValuesFree() {
  const { routes, auditAppends } = mount()
  const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(res.statusCode, 200)
  assert.equal(auditAppends.length, 1, 'G4: exactly one audit entry per advance')
  const entry = auditAppends[0]
  assert.equal(entry.action, 'handoff_advance')
  assert.equal(entry.tenantId, TENANT_ID)
  assert.equal(entry.projectId, PROJECT, 'the project HANDLE may cross — a navigation id, not a material value')
  assert.equal(entry.subjectId, 'prep_entry', 'the step key is closed-vocabulary')
  assert.equal(entry.mode, 'advanced')
  assert.equal(entry.actor, ZHANG)
  assert.deepEqual(entry.detail, {
    operation: 'handoff_advance',
    fromStepIndex: 0,
    toStepIndex: 1,
    stepCount: 3,
    terminal: false,
  }, 'G4: the detail is pinned field-for-field — integers and booleans only')

  const flat = JSON.stringify(auditAppends)
  for (const forbidden of FORBIDDEN_VALUES) {
    assert.ok(!flat.includes(forbidden), `G4: the audit entry must not carry ${forbidden}`)
  }
  // The HANDLER ROSTER is deploy config, not history. It must not be written to an append-only trail
  // on every click.
  for (const identity of [LI, WANG]) {
    assert.ok(!flat.includes(identity), `G4: the audit entry must not carry the roster identity ${identity}`)
  }
  // No destination id may reach the trail either — a webhook handle is infrastructure, not a decision.
  for (const dest of [NOTIFY_DEST, WAREHOUSE_DEST, PURCHASING_DEST]) {
    assert.ok(!flat.includes(dest), `G4: the audit entry must not carry the destination ${dest}`)
  }
}

async function g4ReplayIsAuditedAsAReplayNotAsASecondAdvance() {
  const { routes, auditAppends } = mount()
  await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(auditAppends.length, 2, 'both clicks are recorded — a person pressed the button twice, and that is a fact')
  assert.equal(auditAppends[0].mode, 'advanced')
  assert.equal(auditAppends[1].mode, 'replayed', 'the second is distinguishable from a real advance')
}

async function g4AuditFailureStopsTheNotification() {
  // F6 CHANGED WHAT THIS WITNESS CAN PROMISE, and the change is deliberate rather than a weakening
  // nobody noticed. The route used to audit the INTENT first, so a refusing audit store stopped the
  // turn as well as the message. It cannot any more: the store's compare-and-set may REFUSE, and an
  // audit row written before that refusal is an append-only claim that a handoff happened when it
  // did not — a lie the trail can never retract. So the order is now store, then audit.
  //
  // WHAT SURVIVES, and is pinned here: a refusing audit store still stops the NOTIFICATION. Nobody's
  // phone buzzes about a handoff that has no trail entry, the caller is told (422), and the operator
  // can see the turn moved and go and fix the audit store. What is deliberately NOT claimed any more
  // is that the cursor stays put — it does not, and asserting otherwise would be asserting a promise
  // the code no longer makes.
  //
  // The stronger guarantee is kept where it can be: `requireStockPreparationAudit()` still runs
  // FIRST, so an UNAVAILABLE audit store is a 501 before anything is read or written at all — see
  // g4NoAuditStoreIsAFailClosed501, which pins the empty-db half this one gave up.
  const notifier = makeNotifierSpy()
  const db = makeMemoryDb()
  const routes = new Map()
  const context = {
    api: {
      http: { addRoute(method, routePath, handler) { routes.set(`${method.toUpperCase()} ${routePath}`, handler) } },
      multitable: { provisioning: inertService(['resolveFieldIds']), records: makeRecordsApi() },
    },
    storage: new Map(),
    config: { ...chainConfig(), stockPreparationTableActions: [tableActionConfig()] },
  }
  const services = baseServices()
  services.stockPreparationAuditStore = {
    async append() {
      const error = new Error('audit refused')
      error.status = 422
      error.code = 'AUDIT_DETAIL_INVALID'
      throw error
    },
  }
  services.stockPreparationHandoffStore = createStockPreparationHandoffStore({ db, idGenerator: () => 'handoff-x' })
  services.stockPreparationHandoffNotifier = notifier
  httpRoutes.registerIntegrationRoutes({ context, services, logger: { info() {}, warn() {}, error() {} } })
  const res = await call(routes, 'POST', ADVANCE_PATH, {
    user: OPERATOR_ZHANG,
    body: { tenantId: TENANT_ID, projectNo: PROJECT, fromStepKey: 'prep_entry' },
  })
  assert.equal(res.statusCode, 422)
  assert.equal(notifier.calls.length, 0, 'an unaudited handoff never notifies')
}

async function g4NoAuditStoreIsAFailClosed501() {
  const routes = new Map()
  const db = makeMemoryDb()
  const notifier = makeNotifierSpy()
  const context = {
    api: {
      http: { addRoute(method, routePath, handler) { routes.set(`${method.toUpperCase()} ${routePath}`, handler) } },
      multitable: { provisioning: inertService(['resolveFieldIds']), records: inertService(['listRecords']) },
    },
    storage: new Map(),
    config: chainConfig(),
  }
  const services = baseServices()
  services.stockPreparationHandoffStore = createStockPreparationHandoffStore({ db, idGenerator: () => 'handoff-x' })
  services.stockPreparationHandoffNotifier = notifier
  httpRoutes.registerIntegrationRoutes({ context, services, logger: { info() {}, warn() {}, error() {} } })
  const res = await call(routes, 'POST', ADVANCE_PATH, {
    user: OPERATOR_ZHANG,
    body: { tenantId: TENANT_ID, projectNo: PROJECT, fromStepKey: 'prep_entry' },
  })
  assert.equal(res.statusCode, 501)
  assert.equal(res.body.error.code, 'AUDIT_STORE_UNAVAILABLE')
  assert.deepEqual(db.rows, [])
  assert.equal(notifier.calls.length, 0)
}

// ---------------------------------------------------------------------------
// G5 — the terminal step notifies exactly once and names the approver
// ---------------------------------------------------------------------------

async function g5TerminalStepNotifiesExactlyOnceAndNamesTheApprover() {
  const notifier = makeNotifierSpy()
  const db = makeMemoryDb()
  const { routes, auditAppends } = mount({ notifier, db })

  await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  await advance(routes, OPERATOR_LI, { fromStepKey: 'process' })
  assert.equal(notifier.calls.length, 2, 'two mid-chain handoffs, two notifications')

  const terminalRes = await advance(routes, OPERATOR_WANG, { fromStepKey: 'final_review' })
  assert.equal(terminalRes.statusCode, 200)
  assert.equal(terminalRes.body.data.terminal, true)
  assert.equal(terminalRes.body.data.changed, true)
  assert.equal(terminalRes.body.data.notified, true)
  assert.equal(terminalRes.body.data.currentStepKey, null, 'the chain is finished')
  assert.equal(terminalRes.body.data.stepIndex, null)

  assert.equal(notifier.calls.length, 3, 'G5: the terminal notice fired exactly once')
  const terminal = notifier.calls[2]
  assert.deepEqual(
    terminal.destinationIds,
    [WAREHOUSE_DEST, PURCHASING_DEST],
    'G5: the terminal notice goes to the configured warehouse + purchasing recipient set',
  )
  assert.ok(terminal.body.includes(WANG), 'G5: the approver is NAMED in the body')
  assert.ok(terminal.body.includes(PROJECT), 'G5: the project is named')
  assert.ok(terminal.body.includes('终审'), 'G5: the completed step is named in words')
  assert.ok(terminal.body.includes(EXPORT_PATH_HINT), 'G5: the body points at where the export lives')
  assert.ok(terminal.body.includes('仓库') && terminal.body.includes('采购'), 'G5: it says who should act')
  assert.ok(terminal.body.includes('本条由系统发送'), 'G5: the message says the SYSTEM sent it — no impersonation is claimed')

  // Clicking the finished chain again must not re-notify 仓库/采购.
  const again = await advance(routes, OPERATOR_WANG, { fromStepKey: 'final_review' })
  assert.equal(again.statusCode, 200)
  assert.equal(again.body.data.changed, false)
  assert.equal(notifier.calls.length, 3, 'G5: a completed chain cannot be re-notified')

  const completedAudit = auditAppends.filter((entry) => entry.mode === 'completed')
  assert.equal(completedAudit.length, 1, 'G5: exactly one completion recorded')
  assert.equal(completedAudit[0].detail.terminal, true)

  const finalStatus = await status(routes, OPERATOR_WANG)
  assert.equal(finalStatus.body.data.completed, true)
  assert.equal(finalStatus.body.data.currentStepKey, null)
  assert.equal(finalStatus.body.data.isCurrentHandler, false)
}

async function g5MidChainNotificationNamesTheNextStepAndCarriesNoValues() {
  const notifier = makeNotifierSpy()
  const { routes } = mount({ notifier })
  await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  const sent = notifier.calls[0]
  assert.deepEqual(sent.destinationIds, [NOTIFY_DEST])
  assert.ok(sent.body.includes(PROJECT))
  assert.ok(sent.body.includes('备料填写'), 'the completed step, in words')
  assert.ok(sent.body.includes('工艺'), 'the NEXT step, in words')
  assert.ok(sent.body.includes(ZHANG), 'who finished it')
  const flat = JSON.stringify(notifier.calls)
  for (const forbidden of FORBIDDEN_VALUES) {
    assert.ok(!flat.includes(forbidden), `the notification body must not carry ${forbidden}`)
  }
}

async function g5NoDestinationConfiguredStillMovesTheTurn() {
  // Turn state and notification are separate concerns. A chain with no destinations is legitimate.
  const config = chainConfig()
  delete config[HANDOFF_CONFIG_KEY].notify
  delete config[HANDOFF_CONFIG_KEY].terminal
  const notifier = makeNotifierSpy()
  const db = makeMemoryDb()
  const { routes } = mount({ config, notifier, db })
  const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.changed, true, 'the turn still moves')
  assert.equal(res.body.data.notified, false)
  assert.equal(res.body.data.notifyOutcome, 'not_configured')
  assert.equal(notifier.calls.length, 0)
  assert.equal(db.rows[0].step_index, 1)
}

async function g5NoNotifierInjectedStillMovesTheTurn() {
  const db = makeMemoryDb()
  const routes = new Map()
  const context = {
    api: {
      http: { addRoute(method, routePath, handler) { routes.set(`${method.toUpperCase()} ${routePath}`, handler) } },
      multitable: { provisioning: inertService(['resolveFieldIds']), records: makeRecordsApi() },
    },
    storage: new Map(),
    config: { ...chainConfig(), stockPreparationTableActions: [tableActionConfig()] },
  }
  const services = baseServices()
  services.stockPreparationAuditStore = { async append() { return { ok: true } } }
  services.stockPreparationHandoffStore = createStockPreparationHandoffStore({ db, idGenerator: () => 'handoff-x' })
  // no stockPreparationHandoffNotifier at all — the host never injected one
  httpRoutes.registerIntegrationRoutes({ context, services, logger: { info() {}, warn() {}, error() {} } })
  const res = await call(routes, 'POST', ADVANCE_PATH, {
    user: OPERATOR_ZHANG,
    body: { tenantId: TENANT_ID, projectNo: PROJECT, fromStepKey: 'prep_entry' },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.notifyOutcome, 'not_configured')
  assert.equal(db.rows[0].step_index, 1)
}

// ---------------------------------------------------------------------------
// G6 — a notification failure does not roll back or corrupt the turn
// ---------------------------------------------------------------------------

async function g6ThrowingNotifierDoesNotRollBackTheTurn() {
  const notifier = makeNotifierSpy('throw')
  const db = makeMemoryDb()
  const { routes } = mount({ notifier, db })

  const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(res.statusCode, 200, 'G6: a send failure is not a 500 — the handoff itself succeeded')
  assert.equal(res.body.data.changed, true)
  assert.equal(res.body.data.notified, false)
  assert.equal(res.body.data.notifyOutcome, 'failed', 'G6: the caller is told the truth')
  assert.equal(db.rows.length, 1)
  assert.equal(db.rows[0].step_index, 1, 'G6: the turn STAYS advanced — a DingTalk outage must not un-finish someone\'s work')
  assert.equal(db.rows[0].notified_step_index, 0, 'G6: the notification was claimed, so it is not silently retried')

  // The workbench agrees with the database.
  const after = await status(routes, OPERATOR_LI)
  assert.equal(after.body.data.currentStepKey, 'process')
  assert.equal(after.body.data.isCurrentHandler, true, 'G6: the next person really does hold the turn')

  // AT-MOST-ONCE, stated and pinned: clicking again does NOT retry the failed send.
  const again = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(again.body.data.changed, false)
  assert.equal(again.body.data.notifyOutcome, 'skipped', 'G6: a replay does not re-attempt a claimed notification')
  assert.equal(notifier.calls.length, 1, 'G6: exactly one send ATTEMPT, even though it failed')
}

async function g6ZeroDeliveriesIsReportedAsFailedNotAsSent() {
  const notifier = makeNotifierSpy('zero')
  const db = makeMemoryDb()
  const { routes } = mount({ notifier, db })
  const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(res.body.data.notifyOutcome, 'failed', 'a host that delivered to nobody did not "send"')
  assert.equal(res.body.data.notified, false)
  assert.equal(db.rows[0].step_index, 1, 'the turn still advanced')
}

async function g6NotifierErrorTextNeverReachesTheCaller() {
  const notifier = makeNotifierSpy('throw')
  const { routes } = mount({ notifier })
  const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  const flat = JSON.stringify(res.body)
  assert.ok(!flat.includes('webhook exploded'), 'the host\'s error text is discarded, never echoed to a caller')
  assert.ok(!flat.includes(NOTIFY_DEST), 'no destination handle is echoed either')
}

// ---------------------------------------------------------------------------
// closed vocabulary, closed body, and the store's own compare-and-set
// ---------------------------------------------------------------------------

async function bodyAllowlistRefusesExtraKeysRatherThanIgnoringThem() {
  const notifier = makeNotifierSpy()
  const db = makeMemoryDb()
  const { routes, auditAppends } = mount({ notifier, db })
  // Each of these would be a real steering vector if it were merely ignored: choosing the
  // destination step would let anyone jump to the terminal notice; supplying an actor would let
  // anyone hand off as somebody else; supplying a destination would let anyone pick who gets pinged.
  for (const extra of [
    { toStepKey: 'final_review' },
    { stepIndex: 2 },
    { actor: WANG },
    { advancedBy: WANG },
    { destinationIds: ['dest-attacker'] },
    { notify: false },
  ]) {
    const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry', ...extra })
    assert.equal(res.statusCode, 400, `extra key ${Object.keys(extra)[0]} is REFUSED`)
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_HANDOFF_REQUEST_INVALID')
    assert.equal(res.body.error.details.field, Object.keys(extra)[0], 'the refusal names the field')
  }
  assert.deepEqual(db.rows, [], 'no refused request moved the turn')
  assert.deepEqual(auditAppends, [], 'no refused request was audited as an advance')
  assert.equal(notifier.calls.length, 0)
}

async function unknownStepKeyIsRefused() {
  const { routes } = mount()
  const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'not_a_step' })
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.error.code, 'STOCK_PREPARATION_HANDOFF_REQUEST_INVALID')
  assert.equal(res.body.error.details.field, 'fromStepKey')
}

async function aStepOutsideTheClosedVocabularyIsRefusedAtConfigParse() {
  assert.throws(
    () => parseStockPreparationHandoffConfig({
      [HANDOFF_CONFIG_KEY]: { steps: [{ key: 'invented_role', handlerUserIds: ['u1'] }] },
    }),
    (error) => {
      assert.ok(error instanceof StockPreparationHandoffError)
      assert.equal(error.code, 'STOCK_PREPARATION_HANDOFF_CONFIG_INVALID')
      assert.equal(error.details.field, 'steps[0].key')
      return true
    },
    'a step key outside the closed vocabulary is refused',
  )
  // Every advertised key IS accepted, so the vocabulary and the parser cannot drift apart.
  const chain = parseStockPreparationHandoffConfig({
    [HANDOFF_CONFIG_KEY]: {
      steps: STOCK_PREP_HANDOFF_STEPS.map((key) => ({ key, handlerUserIds: ['u1'] })),
    },
  })
  assert.equal(chain.steps.length, STOCK_PREP_HANDOFF_STEPS.length)
  assert.deepEqual(chain.steps.map((step) => step.key), [...STOCK_PREP_HANDOFF_STEPS])
}

async function malformedConfigThrowsRatherThanDegradingToInert() {
  // A typo must never be indistinguishable from "nothing configured": the difference is whether
  // anybody ever gets told anything.
  for (const [bad, field] of [
    [{ steps: [] }, 'steps'],
    [{ steps: 'process' }, 'steps'],
    [{ steps: [{ key: 'process' }] }, 'steps[0].handlerUserIds'],
    [{ steps: [{ key: 'process', handlerUserIds: [] }] }, 'steps[0].handlerUserIds'],
    [{ steps: [{ key: 'process', handlerUserIds: ['a'] }, { key: 'process', handlerUserIds: ['b'] }] }, 'steps[1].key'],
  ]) {
    assert.throws(
      () => parseStockPreparationHandoffConfig({ [HANDOFF_CONFIG_KEY]: bad }),
      (error) => {
        assert.equal(error.code, 'STOCK_PREPARATION_HANDOFF_CONFIG_INVALID')
        assert.equal(error.details.field, field)
        return true
      },
    )
  }
  // ...but an ABSENT key is inert, not an error.
  assert.deepEqual(parseStockPreparationHandoffConfig({}).configured, false)
  assert.deepEqual(parseStockPreparationHandoffConfig(undefined).configured, false)
  assert.deepEqual(parseStockPreparationHandoffConfig(null).configured, false)
}

async function malformedConfigFailsOnlyTheHandoffRoutes() {
  // The lazy parse is load-bearing: a bad chain must not take the plugin's whole route surface down.
  const { routes } = mount({ config: { [HANDOFF_CONFIG_KEY]: { steps: [] } } })
  assert.ok(routes.has('GET /api/integration/stock-preparation/prep-lines'), 'unrelated routes still registered')
  const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(res.statusCode, 500)
  assert.equal(res.body.error.code, 'STOCK_PREPARATION_HANDOFF_CONFIG_INVALID')
}

async function storeCompareAndSetRefusesAStaleAdvance() {
  const db = makeMemoryDb()
  const store = createStockPreparationHandoffStore({ db, idGenerator: () => 'handoff-1' })
  const scope = { tenantId: TENANT_ID, workspaceId: null, projectNo: PROJECT }
  const first = await store.advance({ ...scope, expectedStepIndex: 0, toStepIndex: 1, notifyForStepIndex: 0, actor: ZHANG })
  assert.equal(first.changed, true)
  assert.equal(first.notifyClaimed, true)
  // Someone else already moved it; this caller planned against a cursor of 0.
  await assert.rejects(
    () => store.advance({ ...scope, expectedStepIndex: 0, toStepIndex: 2, notifyForStepIndex: 0, actor: LI }),
    (error) => {
      assert.equal(error.status, 409)
      assert.equal(error.code, 'STOCK_PREPARATION_HANDOFF_STEP_MISMATCH')
      return true
    },
  )
  assert.equal(db.rows[0].step_index, 1, 'the stale advance did not move the cursor')
  // The idempotent replay path: same destination, no write, no re-claim.
  const replay = await store.advance({ ...scope, expectedStepIndex: 0, toStepIndex: 1, notifyForStepIndex: null, actor: ZHANG })
  assert.equal(replay.changed, false)
  assert.equal(replay.notifyClaimed, false)
}

async function storeIsTenantAndProjectScoped() {
  const db = makeMemoryDb()
  const store = createStockPreparationHandoffStore({ db, idGenerator: (() => { let n = 0; return () => `h-${(n += 1)}` })() })
  await store.advance({ tenantId: TENANT_ID, workspaceId: null, projectNo: PROJECT, expectedStepIndex: 0, toStepIndex: 1, notifyForStepIndex: 0, actor: ZHANG })
  // Another tenant's cursor for the SAME project number is a different row and starts at zero.
  assert.equal(await store.get({ tenantId: OTHER_TENANT, projectNo: PROJECT }), null)
  // Another project in the same tenant likewise.
  assert.equal(await store.get({ tenantId: TENANT_ID, projectNo: 'PRJ-OTHER' }), null)
  const mine = await store.get({ tenantId: TENANT_ID, projectNo: PROJECT })
  assert.equal(mine.stepIndex, 1)
}

async function routeIsTenantScoped() {
  const notifier = makeNotifierSpy()
  const db = makeMemoryDb()
  const { routes } = mount({ notifier, db })
  const intruder = { id: ZHANG, tenantId: OTHER_TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] }
  // The write derives its tenant from the PRINCIPAL, so an intruder cannot reach TENANT_ID's cursor
  // even by naming it in the body.
  const res = await call(routes, 'POST', ADVANCE_PATH, {
    user: intruder,
    body: { tenantId: TENANT_ID, projectNo: PROJECT, fromStepKey: 'prep_entry' },
  })
  assert.equal(res.statusCode, 200, 'the intruder advances THEIR OWN tenant\'s chain, not the victim\'s')
  assert.equal(db.rows.length, 1)
  assert.equal(db.rows[0].tenant_id, OTHER_TENANT, 'the row landed in the AUTHENTICATED tenant, never the body-supplied one')
  // The victim's chain is untouched.
  const victim = await status(routes, OPERATOR_ZHANG)
  assert.equal(victim.body.data.stepIndex, 0)
  // A cross-tenant READ is refused outright.
  const readRes = await call(routes, 'GET', STATUS_PATH, {
    user: intruder,
    query: { tenantId: TENANT_ID, projectNo: PROJECT },
  })
  assert.equal(readRes.statusCode, 403)
  assert.equal(readRes.body.error.code, 'TENANT_MISMATCH')
}

async function notificationBuilderNeverImpersonates() {
  const chain = parseStockPreparationHandoffConfig(chainConfig())
  const mid = buildStockPreparationHandoffNotification({ chain, projectNo: PROJECT, fromStepIndex: 0, actorLabel: ZHANG, terminal: false })
  const terminal = buildStockPreparationHandoffNotification({ chain, projectNo: PROJECT, fromStepIndex: 2, actorLabel: WANG, terminal: true })
  for (const notification of [mid, terminal]) {
    assert.ok(notification.body.includes('本条由系统发送'), 'every body says the system sent it')
    assert.ok(notification.title.startsWith('备料接力'), 'the title names the feature, not a person')
  }
  assert.equal(mid.kind, 'next')
  assert.equal(terminal.kind, 'terminal')
}

async function planRefusesAnUnconfiguredChain() {
  assert.throws(
    () => planStockPreparationHandoffAdvance({
      chain: parseStockPreparationHandoffConfig({}),
      currentStepIndex: 0,
      fromStepKey: 'prep_entry',
      actorId: ZHANG,
    }),
    (error) => error.status === 501 && error.code === 'STOCK_PREPARATION_HANDOFF_NOT_CONFIGURED',
  )
}

async function capabilityManifestDeclaresBothHandoffRoutes() {
  const byCapability = new Map(STOCK_PREP_WORKBENCH_CAPABILITIES.map((entry) => [entry.capability, entry]))
  const read = byCapability.get('handoff.read')
  const advanceCapability = byCapability.get('handoff.advance')
  assert.ok(read && advanceCapability, 'both handoff capabilities are declared')
  assert.equal(read.code, STOCK_PREP_READ, 'the values-free status read rides the broad READ tier')
  assert.equal(read.method, 'GET')
  assert.equal(read.path, STATUS_PATH)
  assert.equal(advanceCapability.code, STOCK_PREP_OPERATE, 'the advance rides the OPERATE write tier')
  assert.equal(advanceCapability.method, 'POST')
  assert.equal(advanceCapability.path, ADVANCE_PATH)
  // control: null is deliberate — these controls are additionally gated on runtime turn state, so
  // presence is NOT equivalent to a permission grant and the F-04 matrix must not assert on them.
  assert.equal(read.control, null)
  assert.equal(advanceCapability.control, null)
}

// ---------------------------------------------------------------------------
// F1 — the store's compare-and-set is a COMPARE-AND-SET, not a compare
// ---------------------------------------------------------------------------

/**
 * A db fake that models the ONE thing `makeMemoryDb` silently assumes away: two requests whose READS
 * both happen before either WRITE. `selectOneForUpdate` additionally models a real row lock (the
 * read blocks while another transaction holds it), which is what makes the fixed store serialize
 * where the unfixed one interleaved.
 *
 * `participants` is how many advances must arrive before either is allowed past its read — without
 * that rendezvous the inline-callback fake would run them one after the other and the race the
 * defect needs could never be staged at all.
 */
function makeRacingDb(participants) {
  const rows = []
  const updateCalls = []
  let arrived = 0
  let releaseGate
  const gate = new Promise((resolve) => { releaseGate = resolve })
  const held = new Map()
  function matches(row, where) {
    return Object.entries(where).every(([c, v]) => (row[c] === undefined ? null : row[c]) === (v === undefined ? null : v))
  }
  async function arrive() {
    arrived += 1
    if (arrived >= participants) releaseGate()
    else await gate
  }
  function keyOf(where) { return JSON.stringify([where.tenant_id, where.workspace_id ?? null, where.project_no]) }
  function base(txHeld) {
    return {
      rows,
      updateCalls,
      async selectOne(table, where) {
        await arrive()
        const found = rows.find((r) => matches(r, where))
        return found ? { ...found } : null
      },
      async selectOneForUpdate(table, where) {
        await arrive()
        const key = keyOf(where)
        while (held.has(key)) await held.get(key)
        let release
        held.set(key, new Promise((resolve) => { release = resolve }))
        txHeld.push(() => { held.delete(key); release() })
        const found = rows.find((r) => matches(r, where))
        return found ? { ...found } : null
      },
      async insertOne(table, row) {
        const stored = { workspace_id: null, notified_step_index: null, updated_by: null, ...row }
        rows.push(stored)
        return [stored]
      },
      async updateRow(table, patch, where) {
        updateCalls.push({ patch, where })
        const found = rows.find((r) => matches(r, where))
        if (!found) return []
        Object.assign(found, patch)
        return [{ ...found }]
      },
    }
  }
  const outer = base([])
  outer.transaction = async (fn) => {
    const txHeld = []
    try {
      return await fn(base(txHeld))
    } finally {
      for (const release of txHeld) release()
    }
  }
  return outer
}

async function f1TwoConcurrentAdvancesFromTheSameStepClaimTheNotificationOnce() {
  // Two people press 通知下一步 on the same project at the same instant. Before the fix both reads
  // saw step 0, both compares passed, both writes landed and BOTH claimed the notification — two
  // DingTalk pings for one handoff, and on the terminal step two copies of the 仓库+采购 fan-out.
  const db = makeRacingDb(2)
  const store = createStockPreparationHandoffStore({ db, idGenerator: (() => { let n = 0; return () => `h-${(n += 1)}` })() })
  const scope = { tenantId: TENANT_ID, workspaceId: null, projectNo: PROJECT }
  db.rows.push({ id: 'h-0', tenant_id: TENANT_ID, workspace_id: null, project_no: PROJECT, step_index: 0, notified_step_index: null, updated_by: null })
  const settled = await Promise.allSettled([
    store.advance({ ...scope, expectedStepIndex: 0, toStepIndex: 1, notifyForStepIndex: 0, actor: ZHANG }),
    store.advance({ ...scope, expectedStepIndex: 0, toStepIndex: 1, notifyForStepIndex: 0, actor: LI }),
  ])
  const claimed = settled.filter((r) => r.status === 'fulfilled' && r.value.notifyClaimed === true)
  assert.equal(claimed.length, 1, `F1: exactly ONE of two concurrent advances may claim the notification (got ${claimed.length})`)
  const changed = settled.filter((r) => r.status === 'fulfilled' && r.value.changed === true)
  assert.equal(changed.length, 1, `F1: exactly ONE of two concurrent advances may report changed:true (got ${changed.length})`)
  assert.equal(db.rows[0].step_index, 1, 'F1: the cursor moved exactly one step')
}

async function f1TheUpdateCarriesTheExpectedCursorAsAPredicate() {
  // The row moved between the read and the write. Without `step_index = <what we compared against>`
  // in the UPDATE's WHERE, the write clobbers the newer cursor and reports success — so both read
  // seams here hand back a STALE snapshot (cursor 0) while the stored row is already at 2. Only a
  // predicate ON THE WRITE can catch that, which is why the row lock alone is not the whole story.
  const db = makeMemoryDb()
  const realSelectOne = db.selectOne.bind(db)
  const stale = async (table, where) => {
    const found = await realSelectOne(table, where)
    return found ? { ...found, step_index: 0, notified_step_index: null } : null
  }
  db.selectOne = stale
  db.selectOneForUpdate = stale
  db.rows.push({ id: 'h-0', tenant_id: TENANT_ID, workspace_id: null, project_no: PROJECT, step_index: 2, notified_step_index: 1, updated_by: LI })
  const store = createStockPreparationHandoffStore({ db, idGenerator: () => 'h-1' })
  await assert.rejects(
    () => store.advance({ tenantId: TENANT_ID, workspaceId: null, projectNo: PROJECT, expectedStepIndex: 0, toStepIndex: 1, notifyForStepIndex: 0, actor: ZHANG }),
    (error) => {
      assert.equal(error.status, 409)
      assert.equal(error.code, 'STOCK_PREPARATION_HANDOFF_WRITE_CONFLICT', `F1: got ${error.code}`)
      return true
    },
    'F1: a write whose predicate no longer matches must fail closed, never clobber',
  )
  assert.equal(db.rows[0].step_index, 2, 'F1: the newer cursor survived')
  assert.equal(db.rows[0].notified_step_index, 1, 'F1: and so did its notification claim')
  assert.equal(db.updateCalls.length, 1, 'F1: the UPDATE was attempted (this is a WRITE-side refusal, not a read-side one)')
  assert.equal(db.updateCalls[0].where.step_index, 0, 'F1: the UPDATE names the compared cursor in its WHERE')
  assert.equal(db.updateCalls[0].where.notified_step_index, null, 'F1: and the compared notification claim too')
}

async function f1TheInTransactionReadTakesTheRowLock() {
  // THE LOCK IS THE FIRST OF THE TWO HALVES, and it needs its own witness because the second half
  // hides it: with the write predicate in place, downgrading `selectOneForUpdate` back to a plain
  // `selectOne` still fails the race CLOSED, so every outcome-shaped assertion above stays green
  // while the store has quietly stopped serializing and started relying on a refusal instead. That
  // is a worse deployment — the loser gets a 409 they would not otherwise have seen — so the seam
  // itself is pinned, not only its effect. (The constructor's requirement is pinned separately, in
  // p3TheStoreRefusesADbBindingWithoutTheLockSeam; requiring a seam and USING it are two facts.)
  const db = makeMemoryDb()
  const counts = { plain: 0, forUpdate: 0 }
  const realSelectOne = db.selectOne.bind(db)
  const realForUpdate = db.selectOneForUpdate.bind(db)
  db.selectOne = async (table, where) => { counts.plain += 1; return realSelectOne(table, where) }
  db.selectOneForUpdate = async (table, where) => { counts.forUpdate += 1; return realForUpdate(table, where) }
  const store = createStockPreparationHandoffStore({ db, idGenerator: () => 'h-1' })
  const scope = { tenantId: TENANT_ID, workspaceId: null, projectNo: PROJECT }
  await store.advance({ ...scope, expectedStepIndex: 0, toStepIndex: 1, notifyForStepIndex: 0, actor: ZHANG })
  assert.equal(counts.forUpdate, 1, 'F1: the advance read the cursor FOR UPDATE')
  assert.equal(counts.plain, 0, 'F1: and never through the unlocked read')
  // The second hop goes down the UPDATE path rather than the INSERT path — same requirement.
  await store.advance({ ...scope, expectedStepIndex: 1, toStepIndex: 2, notifyForStepIndex: 1, actor: LI })
  assert.equal(counts.forUpdate, 2)
  assert.equal(counts.plain, 0)
  // `get` is the READ surface and is deliberately NOT locked: taking a row lock to answer "whose
  // turn is it" on a workbench refresh would serialize every viewer behind every writer.
  await store.get(scope)
  assert.equal(counts.plain, 1, 'F1: the status read stays an ordinary read')
  assert.equal(counts.forUpdate, 2)
}

async function f1RouteAnswers409WriteConflictAndClaimsNothing() {
  // The same defect seen from the OUTSIDE, which is where it hurts: a caller must be told 409 and
  // the deployment must be left with no audit row and no ping. `updateRow` is wrapped so that the
  // cursor moves under it — somebody else's advance landing between our read and our write — which
  // makes the CAS predicate match zero rows exactly as it would in Postgres.
  const db = makeMemoryDb()
  db.rows.push({ id: 'h-0', tenant_id: TENANT_ID, workspace_id: null, project_no: PROJECT, step_index: 0, notified_step_index: null, updated_by: null })
  const realUpdateRow = db.updateRow.bind(db)
  db.updateRow = async (table, patch, where) => {
    // The interloper commits between the FOR UPDATE read and this UPDATE.
    db.rows[0].step_index = 1
    db.rows[0].notified_step_index = 0
    return realUpdateRow(table, patch, where)
  }
  const notifier = makeNotifierSpy()
  const { routes, auditAppends } = mount({ notifier, db })
  const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(res.statusCode, 409, `F1: a lost write race is a 409, never a reported success (got ${res.statusCode})`)
  assert.equal(res.body.error.code, 'STOCK_PREPARATION_HANDOFF_WRITE_CONFLICT')
  assert.deepEqual(auditAppends, [], 'F1: a refused advance leaves NO audit row')
  assert.equal(notifier.calls.length, 0, 'F1: and NO notification is claimed or sent')
  assert.equal(db.rows[0].notified_step_index, 0, 'F1: the interloper\'s claim was not overwritten')
}

// ---------------------------------------------------------------------------
// F2 — projectNo is a HANDLE, and it has to name a project that exists
// ---------------------------------------------------------------------------

// Each of these rides straight into a DingTalk markdown body a person reads on their phone
// (`项目 ${project} …`), into an append-only audit row's `project_id`, and into a durable cursor row.
const HOSTILE_PROJECT_NOS = Object.freeze([
  '[点这里领奖](http://evil.example/x)',
  'PRJ-1\n\n> ### 系统通知:请立即转账\n',
  '<img src=x onerror=alert(1)>',
  'PRJ-1`rm -rf /`',
  '../../etc/passwd',
  'PRJ 1',
])

async function f2AMarkdownInjectionProjectNoIsRefusedWithNoSideEffects() {
  for (const hostile of HOSTILE_PROJECT_NOS) {
    const notifier = makeNotifierSpy()
    const db = makeMemoryDb()
    const { routes, auditAppends } = mount({ notifier, db })
    const res = await call(routes, 'POST', ADVANCE_PATH, {
      user: OPERATOR_ZHANG,
      body: { tenantId: TENANT_ID, projectNo: hostile, fromStepKey: 'prep_entry' },
    })
    assert.equal(res.statusCode, 400, `F2: ${JSON.stringify(hostile)} is refused (got ${res.statusCode})`)
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_HANDOFF_PROJECT_NO_INVALID')
    assert.equal(res.body.error.details.field, 'projectNo', 'F2: the refusal names the field')
    assert.ok(
      !JSON.stringify(res.body).includes(hostile.slice(0, 8)),
      'F2: the refusal NEVER echoes the value — the error is itself a reflection surface',
    )
    assert.equal(notifier.calls.length, 0, 'F2: nothing was sent')
    assert.deepEqual(auditAppends, [], 'F2: nothing was audited')
    assert.deepEqual(db.rows, [], 'F2: no handoff row')
  }
}

async function f2AnOverlongProjectNoIsRefusedAndTheBoundaryIsExact() {
  const notifier = makeNotifierSpy()
  const db = makeMemoryDb()
  const { routes, auditAppends } = mount({ notifier, db })
  const res = await call(routes, 'POST', ADVANCE_PATH, {
    user: OPERATOR_ZHANG,
    body: { tenantId: TENANT_ID, projectNo: 'P'.repeat(20000), fromStepKey: 'prep_entry' },
  })
  assert.equal(res.statusCode, 400, `F2: a 20k-character projectNo is refused (got ${res.statusCode})`)
  assert.equal(res.body.error.code, 'STOCK_PREPARATION_HANDOFF_PROJECT_NO_INVALID')
  assert.deepEqual(auditAppends, [])
  assert.deepEqual(db.rows, [])
  assert.equal(notifier.calls.length, 0)
  // The rule is a SHAPE rule, not a moat: 80 characters is the boundary and is accepted, and every
  // separator a real project number uses passes. A check that refused real handles would be worse
  // than none, because the deployment would simply be turned off.
  assert.ok(isValidStockPrepProjectNo('P'.repeat(80)), 'F2: 80 characters is inside the boundary')
  assert.ok(!isValidStockPrepProjectNo('P'.repeat(81)), 'F2: 81 is outside it')
  for (const good of [PROJECT, 'PRJ_2026.01', 'A/B-1', '2026001']) {
    assert.ok(isValidStockPrepProjectNo(good), `F2: ${good} is a real project handle and must pass`)
  }
}

async function f2AnUnknownProjectIs404WithNoSideEffects() {
  const notifier = makeNotifierSpy()
  const db = makeMemoryDb()
  // The bound target holds rows for no project at all — the typo case.
  const { routes, auditAppends, records } = mount({ notifier, db, records: makeRecordsApi([]) })
  const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(res.statusCode, 404, `F2: a project with no stock-prep rows is 404 (got ${res.statusCode})`)
  assert.equal(res.body.error.code, 'STOCK_PREPARATION_HANDOFF_PROJECT_NOT_FOUND')
  assert.deepEqual(auditAppends, [], 'F2: an unknown project is not audited')
  assert.deepEqual(db.rows, [], 'F2: an unknown project starts no chain')
  assert.equal(notifier.calls.length, 0)
  // Existence is a yes/no. Paging a real project's whole material list to answer it would be a waste
  // at best and a timeout at worst, which is why this is not the export read.
  assert.equal(records.queries.length, 1, 'F2: exactly one existence probe')
  assert.equal(records.queries[0].limit, 1, 'F2: and it asks for ONE row, not the material list')
}

async function f2TheStatusReadRefusesTheSameShapes() {
  // One route accepting a shape its sibling refuses is how the two drift apart, and the status read
  // echoes the handle back, so it is a reflection surface in its own right.
  const { routes } = mount()
  for (const hostile of HOSTILE_PROJECT_NOS) {
    const res = await call(routes, 'GET', STATUS_PATH, {
      user: READ_ONLY,
      query: { tenantId: TENANT_ID, projectNo: hostile },
    })
    assert.equal(res.statusCode, 400, `F2: the status read refuses ${JSON.stringify(hostile)} too`)
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_HANDOFF_PROJECT_NO_INVALID')
    assert.ok(!JSON.stringify(res.body).includes(hostile.slice(0, 8)), 'F2: and does not echo it back')
  }
}

// ---------------------------------------------------------------------------
// F3 — a config typo is REFUSED, never accepted as "configured with no destinations"
// ---------------------------------------------------------------------------

const STEPS3 = Object.freeze([
  { key: 'prep_entry', handlerUserIds: [ZHANG] },
  { key: 'process', handlerUserIds: [LI] },
  { key: 'final_review', handlerUserIds: [WANG] },
])
const GOOD_NOTIFY = Object.freeze({ groupDestinationId: NOTIFY_DEST })
const GOOD_TERMINAL = Object.freeze({ groupDestinationIds: [WAREHOUSE_DEST] })

async function f3ATypoIsRefusedRatherThanAcceptedAsNoDestinations() {
  // Every one of these used to parse to `configured: true` with an empty destination set, so the
  // route burned its at-most-once notification claim and answered `notifyOutcome: 'not_configured'`.
  // The deployment believed 通知下一步 was wired up. Nobody was ever told anything.
  const cases = [
    [{ steps: STEPS3, notify: GOOD_NOTIFY, terminal: { groupDestinationId: 'x' } }, 'terminal.groupDestinationId'],
    [{ steps: STEPS3, notify: GOOD_NOTIFY, terminal: 'x' }, 'terminal'],
    [{ steps: STEPS3, notify: { groupDestinationId: 42 }, terminal: GOOD_TERMINAL }, 'notify.groupDestinationId'],
    [{ steps: STEPS3, notify: GOOD_NOTIFY, terminal: GOOD_TERMINAL, notifyy: {} }, 'notifyy'],
    [{ steps: STEPS3, notify: {}, terminal: GOOD_TERMINAL }, 'notify.groupDestinationId'],
    [{ steps: STEPS3, notify: GOOD_NOTIFY, terminal: { groupDestinationIds: [] } }, 'terminal.groupDestinationIds'],
    [{ steps: STEPS3, notify: GOOD_NOTIFY, terminal: { groupDestinationIds: ['ok', ''] } }, 'terminal.groupDestinationIds'],
    // ALL-OR-NOTHING: half a chain notifies at some hops and silently skips others, and the hop it
    // skips is the one somebody is waiting on.
    [{ steps: STEPS3, notify: GOOD_NOTIFY }, 'terminal'],
    [{ steps: STEPS3, terminal: GOOD_TERMINAL }, 'notify'],
    [{ steps: STEPS3, notify: GOOD_NOTIFY, terminal: { groupDestinationIds: [WAREHOUSE_DEST], exportPath: 7 } }, 'terminal.exportPath'],
    // The closed key set reaches inside a step too.
    [{ steps: [{ key: 'process', handlerUserIds: [LI], handler: LI }] }, 'steps[0].handler'],
  ]
  for (const [bad, field] of cases) {
    assert.throws(
      () => parseStockPreparationHandoffConfig({ [HANDOFF_CONFIG_KEY]: bad }),
      (error) => {
        assert.ok(error instanceof StockPreparationHandoffError)
        assert.equal(error.code, 'STOCK_PREPARATION_HANDOFF_CONFIG_INVALID', `F3: ${field} got code ${error.code}`)
        assert.equal(error.details.field, field, `F3: ${field} was reported as ${error.details.field}`)
        // The field NAME crosses; the value it carried never does.
        return true
      },
      `F3: ${field} must be refused by name`,
    )
  }
}

async function f3TurnStateWithoutNotificationsStaysLegal() {
  // The deliberate turn-state-only deployment. Turn state is useful on its own, and this must stay
  // reachable — what the strict parse removes is arriving in this state BY TYPO, not the state.
  const chain = parseStockPreparationHandoffConfig({ [HANDOFF_CONFIG_KEY]: { steps: STEPS3 } })
  assert.equal(chain.configured, true)
  assert.equal(chain.notifyGroupDestinationId, null)
  assert.deepEqual([...chain.terminalGroupDestinationIds], [])
  // A ONE-STEP chain has no mid-chain hop at all, so it may declare `terminal` alone.
  const single = parseStockPreparationHandoffConfig({
    [HANDOFF_CONFIG_KEY]: { steps: [{ key: 'final_review', handlerUserIds: [WANG] }], terminal: GOOD_TERMINAL },
  })
  assert.equal(single.configured, true)
  assert.deepEqual([...single.terminalGroupDestinationIds], [WAREHOUSE_DEST])
  // ...and the fully configured chain still parses to exactly what it says.
  const full = parseStockPreparationHandoffConfig(chainConfig())
  assert.equal(full.notifyGroupDestinationId, NOTIFY_DEST)
  assert.deepEqual([...full.terminalGroupDestinationIds], [WAREHOUSE_DEST, PURCHASING_DEST])
  assert.equal(full.exportPath, EXPORT_PATH_HINT)
}

async function f3TheClaimIsNotSpentOnAHopWithNowhereToSend() {
  // `notified_step_index` is at-most-once: once claimed for a step, the next click is a replay and
  // that hop can NEVER be notified again. Claiming it for a chain with no destination would leave a
  // deployment that adds one tomorrow with yesterday's hops permanently silent.
  const turnStateOnly = parseStockPreparationHandoffConfig({ [HANDOFF_CONFIG_KEY]: { steps: STEPS3 } })
  assert.equal(chainHasDestinationForHop(turnStateOnly, false), false)
  assert.equal(chainHasDestinationForHop(turnStateOnly, true), false)
  const full = parseStockPreparationHandoffConfig(chainConfig())
  assert.equal(chainHasDestinationForHop(full, false), true)
  assert.equal(chainHasDestinationForHop(full, true), true)
  assert.equal(chainHasDestinationForHop(parseStockPreparationHandoffConfig({}), false), false, 'an unconfigured chain has no hop')

  // End to end: the turn-state-only chain moves the cursor and leaves the claim UNSPENT.
  const db = makeMemoryDb()
  const notifier = makeNotifierSpy()
  const { routes } = mount({ config: { [HANDOFF_CONFIG_KEY]: { steps: STEPS3 } }, notifier, db })
  const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.notifyOutcome, 'not_configured')
  assert.equal(db.rows[0].step_index, 1, 'the turn moved')
  assert.equal(db.rows[0].notified_step_index, null, 'F3: and the at-most-once claim was NOT burned')
  assert.equal(notifier.calls.length, 0)
}

// ---------------------------------------------------------------------------
// F5 — the handler check runs BEFORE the replay branch
// ---------------------------------------------------------------------------

async function f5AReplayFromSomeoneElseIsRefused() {
  // Before the fix, ANY stock-prep:operate holder who was nobody's handler could POST the step 张三
  // had just completed and receive 200 plus an append-only audit row reading "replayed" under their
  // own identity — for a handoff they had no part in.
  const notifier = makeNotifierSpy()
  const db = makeMemoryDb()
  const { routes, auditAppends } = mount({ notifier, db })
  await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  const auditBefore = auditAppends.length
  const notifyBefore = notifier.calls.length

  const res = await advance(routes, OPERATOR_STRANGER, { fromStepKey: 'prep_entry' })
  assert.equal(res.statusCode, 403, `F5: a stranger's "replay" is not theirs to replay (got ${res.statusCode})`)
  assert.equal(res.body.error.code, 'STOCK_PREPARATION_HANDOFF_NOT_CURRENT_HANDLER')
  assert.equal(auditAppends.length, auditBefore, 'F5: no audit row under the stranger\'s identity')
  assert.equal(notifier.calls.length, notifyBefore, 'F5: and nothing was sent')

  // ...while the REAL handler's own double click is STILL a replay, because the check consults the
  // roster of `fromStepKey`, not the cursor. 张三 is a configured handler of prep_entry even after
  // the cursor has moved past it.
  const own = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(own.statusCode, 200, 'F5: the handler\'s own double click is not an error')
  assert.equal(own.body.data.changed, false)
  assert.equal(auditAppends[auditAppends.length - 1].mode, 'replayed')
}

async function f5PlannerRefusesAReplayFromANonHandler() {
  const chain = parseStockPreparationHandoffConfig(chainConfig())
  assert.throws(
    () => planStockPreparationHandoffAdvance({ chain, currentStepIndex: 1, fromStepKey: 'prep_entry', actorId: 'u_stranger' }),
    (error) => error.status === 403 && error.code === 'STOCK_PREPARATION_HANDOFF_NOT_CURRENT_HANDLER',
    'F5: the planner refuses a non-handler on the replay path too',
  )
  const replay = planStockPreparationHandoffAdvance({ chain, currentStepIndex: 1, fromStepKey: 'prep_entry', actorId: ZHANG })
  assert.equal(replay.decision, 'replay', 'F5: and the roster holder\'s replay survives the reorder')
  // The terminal step's replay (cursor past the end) likewise.
  const terminalReplay = planStockPreparationHandoffAdvance({ chain, currentStepIndex: 3, fromStepKey: 'final_review', actorId: WANG })
  assert.equal(terminalReplay.decision, 'replay')
}

// ---------------------------------------------------------------------------
// F6 — the audit row records what HAPPENED, so the store commits first
// ---------------------------------------------------------------------------

async function f6ARefusedAdvanceWritesNoAuditRow() {
  // The route's planner read sees cursor 0; the store's own read (inside the transaction) sees 2, so
  // the store refuses. Auditing the INTENT first would already have written `mode: 'advanced'` for a
  // handoff that never happened — and an append-only trail cannot take that back.
  const db = makeMemoryDb()
  db.rows.push({ id: 'h-0', tenant_id: TENANT_ID, workspace_id: null, project_no: PROJECT, step_index: 2, notified_step_index: 1, updated_by: LI })
  let inTx = false
  const realSelectOne = db.selectOne.bind(db)
  db.selectOne = async (table, where) => {
    const row = await realSelectOne(table, where)
    if (inTx || !row) return row
    return { ...row, step_index: 0, notified_step_index: null }
  }
  db.selectOneForUpdate = async (table, where) => realSelectOne(table, where)
  const realTransaction = db.transaction.bind(db)
  db.transaction = async (fn) => { inTx = true; try { return await realTransaction(fn) } finally { inTx = false } }
  const notifier = makeNotifierSpy()
  const { routes, auditAppends } = mount({ notifier, db })
  const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(res.statusCode, 409, `F6: the store refuses the advance (got ${res.statusCode})`)
  assert.equal(res.body.error.code, 'STOCK_PREPARATION_HANDOFF_STEP_MISMATCH')
  assert.deepEqual(auditAppends, [], 'F6: a refused advance must leave NO audit row claiming it happened')
  assert.equal(notifier.calls.length, 0)
}

async function f6TheStoreCommitsBeforeTheAuditAppend() {
  // The ORDER itself, pinned directly rather than inferred: the audit store looks at the cursor table
  // at append time and must already see the move it is being asked to record.
  const db = makeMemoryDb()
  const notifier = makeNotifierSpy()
  const seenAtAppend = []
  const { routes } = (() => {
    const routeMap = new Map()
    const context = {
      api: {
        http: { addRoute(method, routePath, handler) { routeMap.set(`${method.toUpperCase()} ${routePath}`, handler) } },
        multitable: { provisioning: inertService(['resolveFieldIds']), records: makeRecordsApi() },
      },
      storage: new Map(),
      config: { ...chainConfig(), stockPreparationTableActions: [tableActionConfig()] },
    }
    const services = baseServices()
    services.stockPreparationAuditStore = {
      async append(entry) {
        auditInternals.assertValuesFreeDetail(entry.detail)
        seenAtAppend.push(JSON.parse(JSON.stringify(db.rows)))
        return { ok: true }
      },
    }
    services.stockPreparationHandoffStore = createStockPreparationHandoffStore({ db, idGenerator: () => 'handoff-1' })
    services.stockPreparationHandoffNotifier = notifier
    httpRoutes.registerIntegrationRoutes({ context, services, logger: { info() {}, warn() {}, error() {} } })
    return { routes: routeMap }
  })()
  const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(res.statusCode, 200)
  assert.equal(seenAtAppend.length, 1)
  assert.equal(seenAtAppend[0].length, 1, 'F6: the cursor row already existed when the audit was appended')
  assert.equal(seenAtAppend[0][0].step_index, 1, 'F6: and it already held the NEW step index')
  assert.equal(seenAtAppend[0][0].notified_step_index, 0, 'F6: and the notification claim')
}

async function f6ThePlannerRefusesAStaleCursorOnItsOwn() {
  // Not redundant with the store's compare-and-set even though both answer STEP_MISMATCH: this one
  // refuses BEFORE any durable write is attempted, which is what keeps a stale click out of the trail
  // entirely; the store's is the racing writer's last line of defence.
  const chain = parseStockPreparationHandoffConfig(chainConfig())
  assert.throws(
    () => planStockPreparationHandoffAdvance({ chain, currentStepIndex: 2, fromStepKey: 'prep_entry', actorId: ZHANG }),
    (error) => {
      assert.equal(error.status, 409)
      assert.equal(error.code, 'STOCK_PREPARATION_HANDOFF_STEP_MISMATCH')
      return true
    },
    'F6: the PLANNER refuses a stale cursor — independently of whatever the store would say',
  )
}

// ---------------------------------------------------------------------------
// P3 — guards that a mutation used to survive
// ---------------------------------------------------------------------------

async function p3TheUpdatePathWritesTheNewNotifiedStepIndex() {
  // The INSERT path was covered; the UPDATE path was not, so a mutation that dropped
  // `notified_step_index` from the SET clause left the suite green — and the second hop of every
  // real project goes through the UPDATE, not the INSERT.
  const db = makeMemoryDb()
  const notifier = makeNotifierSpy()
  const { routes } = mount({ notifier, db })
  await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(db.rows[0].notified_step_index, 0, 'first hop (INSERT) claimed step 0')
  await advance(routes, OPERATOR_LI, { fromStepKey: 'process' })
  assert.equal(db.rows.length, 1, 'still one cursor row')
  assert.equal(db.rows[0].step_index, 2, 'the UPDATE moved the cursor')
  assert.equal(db.rows[0].notified_step_index, 1, 'P3: the UPDATE wrote the NEW claim, not the old one')
  assert.equal(db.updateCalls.length, 1, 'exactly one UPDATE (the first hop inserted)')
  assert.equal(db.updateCalls[0].patch.notified_step_index, 1, 'P3: and it is in the SET clause')
  assert.equal(notifier.calls.length, 2, 'both hops notified exactly once each')
}

async function p3ZeroUpdatedRowsIsARefusalNotASuccess() {
  // The store's `if (!row)` branch, reached directly: a db whose UPDATE matches nothing at all.
  // Without this branch the store would return `rowToPublicHandoff(null)` and the route would tell
  // somebody "the next person has been notified" for a cursor that never moved.
  const db = makeMemoryDb()
  db.rows.push({ id: 'h-0', tenant_id: TENANT_ID, workspace_id: null, project_no: PROJECT, step_index: 0, notified_step_index: null, updated_by: null })
  db.updateRow = async () => []
  const store = createStockPreparationHandoffStore({ db, idGenerator: () => 'h-1' })
  await assert.rejects(
    () => store.advance({ tenantId: TENANT_ID, workspaceId: null, projectNo: PROJECT, expectedStepIndex: 0, toStepIndex: 1, notifyForStepIndex: 0, actor: ZHANG }),
    (error) => {
      assert.equal(error.status, 409)
      assert.equal(error.code, 'STOCK_PREPARATION_HANDOFF_WRITE_CONFLICT')
      assert.equal(error.details.field, 'projectNo')
      return true
    },
    'P3: zero updated rows must be a refusal',
  )
}

async function p3TheUniqueViolationRetryIsBounded() {
  // Two concurrent FIRST advances both see "no row" and both INSERT; the unique index arbitrates and
  // the loser gets 23505. Retrying is correct — the loser re-enters and finds the winner's row — but
  // an UNBOUNDED retry on a violation we may have misdiagnosed is a spin, so the loop is capped.
  //
  // The constraint name mirrors migration 084's unique index; the store routes on it by name so that
  // an unrelated 23505 (some other index) is NOT swallowed as a retryable race.
  const SCOPE_CONSTRAINT = 'uniq_integration_stock_prep_handoff_scope'
  const attempts = { insert: 0 }
  const db = makeMemoryDb()
  db.insertOne = async () => {
    attempts.insert += 1
    const error = new Error('duplicate key value violates unique constraint')
    error.code = '23505'
    error.constraint = SCOPE_CONSTRAINT
    throw error
  }
  const store = createStockPreparationHandoffStore({ db, idGenerator: () => 'h-1' })
  await assert.rejects(
    () => store.advance({ tenantId: TENANT_ID, workspaceId: null, projectNo: PROJECT, expectedStepIndex: 0, toStepIndex: 1, notifyForStepIndex: 0, actor: ZHANG }),
    (error) => error.code === '23505',
    'P3: a violation that never resolves eventually propagates rather than spinning',
  )
  assert.equal(attempts.insert, 3, 'P3: exactly MAX_ADVANCE_ATTEMPTS tries, then it gives up')

  // An UNRELATED unique violation is not retried at all — it is a different bug and must surface.
  const otherDb = makeMemoryDb()
  let otherAttempts = 0
  otherDb.insertOne = async () => {
    otherAttempts += 1
    const error = new Error('duplicate key value violates unique constraint')
    error.code = '23505'
    error.constraint = 'some_other_index'
    throw error
  }
  const otherStore = createStockPreparationHandoffStore({ db: otherDb, idGenerator: () => 'h-1' })
  await assert.rejects(
    () => otherStore.advance({ tenantId: TENANT_ID, workspaceId: null, projectNo: PROJECT, expectedStepIndex: 0, toStepIndex: 1, notifyForStepIndex: 0, actor: ZHANG }),
    (error) => error.constraint === 'some_other_index',
  )
  assert.equal(otherAttempts, 1, 'P3: an unrelated 23505 is not retried')

  // ...and the retry that DOES resolve behaves: the loser re-enters, finds the winner's row, and its
  // compare-and-set correctly reports a replay rather than moving the cursor twice.
  const raceDb = makeMemoryDb()
  const realInsert = raceDb.insertOne.bind(raceDb)
  let firstInsert = true
  raceDb.insertOne = async (table, row) => {
    if (firstInsert) {
      firstInsert = false
      // The winner's row lands while we are mid-flight.
      raceDb.rows.push({ id: 'h-winner', tenant_id: TENANT_ID, workspace_id: null, project_no: PROJECT, step_index: 1, notified_step_index: 0, updated_by: LI })
      const error = new Error('duplicate key value violates unique constraint')
      error.code = '23505'
      error.constraint = SCOPE_CONSTRAINT
      throw error
    }
    return realInsert(table, row)
  }
  const raceStore = createStockPreparationHandoffStore({ db: raceDb, idGenerator: () => 'h-loser' })
  const applied = await raceStore.advance({ tenantId: TENANT_ID, workspaceId: null, projectNo: PROJECT, expectedStepIndex: 0, toStepIndex: 1, notifyForStepIndex: 0, actor: ZHANG })
  assert.equal(applied.changed, false, 'P3: the loser sees the winner\'s cursor and reports a replay')
  assert.equal(applied.notifyClaimed, false, 'P3: and does NOT re-claim the notification')
  assert.equal(raceDb.rows.length, 1, 'P3: one project, one cursor row')
}

async function p3TheStatusQueryAllowlistIsClosed() {
  // The status read's query keys are a closed set for the same reason the advance body's are: a key
  // that is merely IGNORED is a key a caller believes is doing something.
  const { routes } = mount()
  for (const extra of [{ stepIndex: 2 }, { actor: WANG }, { destinationIds: 'x' }, { steps: '3' }]) {
    const res = await call(routes, 'GET', STATUS_PATH, {
      user: READ_ONLY,
      query: { tenantId: TENANT_ID, projectNo: PROJECT, ...extra },
    })
    assert.equal(res.statusCode, 400, `P3: unknown query key ${Object.keys(extra)[0]} is REFUSED, not ignored`)
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_HANDOFF_REQUEST_INVALID')
    assert.equal(res.body.error.details.field, Object.keys(extra)[0], 'P3: the refusal names the field')
  }
  // The four allowlisted keys still work.
  const ok = await call(routes, 'GET', STATUS_PATH, {
    user: READ_ONLY,
    query: { tenantId: TENANT_ID, workspaceId: 'ws-1', projectNo: PROJECT },
  })
  assert.equal(ok.statusCode, 200)
}

async function p3TheStoreRefusesADbBindingWithoutTheLockSeam() {
  // A binding without `selectOneForUpdate` degrades the compare-and-set to a plain read under READ
  // COMMITTED — the exact double-notify bug. It must fail at WIRING time, loudly, not at 2am.
  const db = makeMemoryDb()
  delete db.selectOneForUpdate
  assert.throws(
    () => createStockPreparationHandoffStore({ db }),
    /selectOneForUpdate/,
    'P3: a db without the row-lock seam is refused at construction',
  )
  const noTransaction = makeMemoryDb()
  delete noTransaction.transaction
  assert.throws(() => createStockPreparationHandoffStore({ db: noTransaction }), /transaction/)
}

async function main() {
  const tests = [
    ['G1 absent config leaves every observable surface untouched', g1AbsentConfigLeavesEveryObservableSurfaceUntouched],
    ['G1 absent config refuses before touching the store', g1AbsentConfigRefusesBeforeTouchingTheStore],
    ['G2 a non-current handler (incl. platform admin) is refused', g2NonCurrentHandlerIsRefused],
    ['G2 the permission gate still refuses under-privileged principals', g2PermissionGateStillRefusesUnderPrivilegedPrincipals],
    ['G2 status reports the turn without leaking the roster', g2StatusReportsWhoseTurnItIsWithoutLeakingTheRoster],
    ['G3 double-advance does not double-notify', g3DoubleAdvanceDoesNotDoubleNotify],
    ['G3 a stale advance is refused rather than skipping a step', g3AStaleAdvanceIsRefusedRatherThanSkippingAStep],
    ['G4 the audit entry is values-free', g4AuditEntryIsValuesFree],
    ['G4 a replay is audited as a replay', g4ReplayIsAuditedAsAReplayNotAsASecondAdvance],
    ['G4 an audit failure stops the notification', g4AuditFailureStopsTheNotification],
    ['G4 no audit store is a fail-closed 501', g4NoAuditStoreIsAFailClosed501],
    ['G5 the terminal step notifies exactly once and names the approver', g5TerminalStepNotifiesExactlyOnceAndNamesTheApprover],
    ['G5 a mid-chain notification names the next step and carries no values', g5MidChainNotificationNamesTheNextStepAndCarriesNoValues],
    ['G5 no destination configured still moves the turn', g5NoDestinationConfiguredStillMovesTheTurn],
    ['G5 no notifier injected still moves the turn', g5NoNotifierInjectedStillMovesTheTurn],
    ['G6 a throwing notifier does not roll back the turn', g6ThrowingNotifierDoesNotRollBackTheTurn],
    ['G6 zero deliveries is reported as failed, not sent', g6ZeroDeliveriesIsReportedAsFailedNotAsSent],
    ['G6 notifier error text never reaches the caller', g6NotifierErrorTextNeverReachesTheCaller],
    ['the body allowlist refuses extra keys rather than ignoring them', bodyAllowlistRefusesExtraKeysRatherThanIgnoringThem],
    ['an unknown step key is refused', unknownStepKeyIsRefused],
    ['a step outside the closed vocabulary is refused at config parse', aStepOutsideTheClosedVocabularyIsRefusedAtConfigParse],
    ['malformed config throws rather than degrading to inert', malformedConfigThrowsRatherThanDegradingToInert],
    ['malformed config fails only the handoff routes', malformedConfigFailsOnlyTheHandoffRoutes],
    ['the store compare-and-set refuses a stale advance', storeCompareAndSetRefusesAStaleAdvance],
    ['the store is tenant- and project-scoped', storeIsTenantAndProjectScoped],
    ['the route is tenant-scoped and body tenantId cannot steer it', routeIsTenantScoped],
    ['the notification builder never impersonates', notificationBuilderNeverImpersonates],
    ['plan refuses an unconfigured chain', planRefusesAnUnconfiguredChain],
    ['the capability manifest declares both handoff routes', capabilityManifestDeclaresBothHandoffRoutes],
    // --- second round: the adversarial findings F1..F6 (F4 lives in core-backend) ---------------
    ['F1 two concurrent advances claim the notification exactly once', f1TwoConcurrentAdvancesFromTheSameStepClaimTheNotificationOnce],
    ['F1 the UPDATE carries the compared cursor as a predicate', f1TheUpdateCarriesTheExpectedCursorAsAPredicate],
    ['F1 the in-transaction read takes the row lock', f1TheInTransactionReadTakesTheRowLock],
    ['F1 a lost write race is a 409 that claims nothing', f1RouteAnswers409WriteConflictAndClaimsNothing],
    ['F2 a markdown-injection projectNo is refused with no side effects', f2AMarkdownInjectionProjectNoIsRefusedWithNoSideEffects],
    ['F2 an overlong projectNo is refused and the boundary is exact', f2AnOverlongProjectNoIsRefusedAndTheBoundaryIsExact],
    ['F2 an unknown project is 404 with no side effects', f2AnUnknownProjectIs404WithNoSideEffects],
    ['F2 the status read refuses the same shapes', f2TheStatusReadRefusesTheSameShapes],
    ['F3 a config typo is refused rather than accepted as no destinations', f3ATypoIsRefusedRatherThanAcceptedAsNoDestinations],
    ['F3 turn state without notifications stays legal', f3TurnStateWithoutNotificationsStaysLegal],
    ['F3 the claim is not spent on a hop with nowhere to send', f3TheClaimIsNotSpentOnAHopWithNowhereToSend],
    ['F5 a replay from someone else is refused', f5AReplayFromSomeoneElseIsRefused],
    ['F5 the planner refuses a replay from a non-handler', f5PlannerRefusesAReplayFromANonHandler],
    ['F6 a refused advance writes no audit row', f6ARefusedAdvanceWritesNoAuditRow],
    ['F6 the store commits before the audit append', f6TheStoreCommitsBeforeTheAuditAppend],
    ['F6 the planner refuses a stale cursor on its own', f6ThePlannerRefusesAStaleCursorOnItsOwn],
    // --- P3: guards a mutation used to survive --------------------------------------------------
    ['P3 the UPDATE path writes the new notified_step_index', p3TheUpdatePathWritesTheNewNotifiedStepIndex],
    ['P3 zero updated rows is a refusal, not a success', p3ZeroUpdatedRowsIsARefusalNotASuccess],
    ['P3 the unique-violation retry is bounded', p3TheUniqueViolationRetryIsBounded],
    ['P3 the status query allowlist is closed', p3TheStatusQueryAllowlistIsClosed],
    ['P3 the store refuses a db binding without the lock seam', p3TheStoreRefusesADbBindingWithoutTheLockSeam],
  ]
  for (const [name, fn] of tests) {
    await fn()
    console.log(`  ${name} OK`)
  }
  console.log('stock-preparation-handoff: 通知下一步 turn state, advance route and notification guards passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
