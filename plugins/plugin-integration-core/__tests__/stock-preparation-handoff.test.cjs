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
} = require(path.join(LIB, 'stock-preparation-handoff.cjs'))
const {
  HANDOFF_TABLE,
  createStockPreparationHandoffStore,
} = require(path.join(LIB, 'stock-preparation-handoff-store.cjs'))

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
 * handoff store touches. Deliberately NOT transactional in the isolation sense — it runs the
 * callback inline — because what these tests exercise is the store's compare-and-set LOGIC (read the
 * cursor, refuse if it moved), not Postgres' isolation levels, which are the database's job and are
 * covered by the unique index the migration declares.
 */
function makeMemoryDb() {
  const rows = []
  function matches(row, where) {
    return Object.entries(where).every(([column, value]) => {
      const actual = row[column] === undefined ? null : row[column]
      return actual === (value === undefined ? null : value)
    })
  }
  const api = {
    rows,
    async selectOne(table, where) {
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
function mount({ config = chainConfig(), notifier = makeNotifierSpy(), db = makeMemoryDb() } = {}) {
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
        records: inertService(['listRecords']),
      },
    },
    storage: new Map(),
    config,
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
  return { routes, auditAppends, notifier, db }
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

async function g4AuditFailureStopsTheTurnAndTheNotification() {
  // "Record intent FIRST": if the audit store refuses, nothing else may happen.
  const notifier = makeNotifierSpy()
  const db = makeMemoryDb()
  const routes = new Map()
  const context = {
    api: {
      http: { addRoute(method, routePath, handler) { routes.set(`${method.toUpperCase()} ${routePath}`, handler) } },
      multitable: { provisioning: inertService(['resolveFieldIds']), records: inertService(['listRecords']) },
    },
    storage: new Map(),
    config: chainConfig(),
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
  assert.deepEqual(db.rows, [], 'an unaudited handoff never moves the turn')
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
      multitable: { provisioning: inertService(['resolveFieldIds']), records: inertService(['listRecords']) },
    },
    storage: new Map(),
    config: chainConfig(),
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
    ['G4 an audit failure stops the turn and the notification', g4AuditFailureStopsTheTurnAndTheNotification],
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
