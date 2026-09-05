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
  STOCK_PREP_HANDOFF_NOTIFY_OUTCOMES,
  assertStockPreparationHandoffNotifyOutcome,
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
      // F1: `tenantId` is REQUIRED. There is no deploy-global chain any more — see
      // f1AChainWithoutATenantIdIsRefusedRatherThanDeployGlobal for why the old default was not
      // merely undocumented but exploitable.
      tenantId: TENANT_ID,
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

/**
 * RC2 — the host tenant-principal directory the #5445 scope resolver leans on.
 *
 * `verdict` is a function of (userId, tenantId), so a witness can express the case that matters:
 * "this principal is in ITS OWN tenant but not in the one the x-tenant-id header named".
 */
function makeTenantDirectory(verdict) {
  const calls = []
  return {
    calls,
    async verifyTenantMembership({ userId, tenantId }) {
      calls.push({ userId, tenantId })
      return { member: verdict(userId, tenantId) }
    },
  }
}

/** Says yes to everything — the default, so the G/F suites keep testing what they were written for. */
function vouchingTenantDirectory() {
  return makeTenantDirectory(() => true)
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
  // RC2: the #5445 host membership seam. Both handoff routes now derive their tenant through
  // resolveOperatorValueScope, which REQUIRES the host to vouch for the (principal, tenant) pairing
  // — so the default here says "yes, this principal is in the tenant it claims", and the RC2
  // witnesses below swap in one that refuses.
  tenantPrincipalDirectory = vouchingTenantDirectory(),
  // G3/G4: the vocabulary probe's verdict, so a witness can drive the un-migrated database and the
  // moment it is migrated. Default: the DB already knows the action.
  auditProbe = async () => ({ supported: true, reason: 'check_constraint_accepts' }),
  // G3: `null` is the no-SQL-db deployment.
  handoffStore,
} = {}) {
  const routes = new Map()
  const auditAppends = []
  // Every call the ROUTE makes into the audit store, in order — `append` and the F2 vocabulary probe
  // alike. `auditAppends` still records only the trail rows, so existing witnesses are untouched.
  const auditCalls = []
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
      auditCalls.push({ method: 'append', action: entry.action, tenantId: entry.tenantId })
      // The REAL gate, so a values-bearing detail reds here exactly as it would in production.
      auditInternals.assertValuesFreeDetail(entry.detail)
      assert.ok(STOCK_PREP_AUDIT_ACTIONS.includes(entry.action), `audit action ${entry.action} is in the closed vocabulary`)
      auditAppends.push(entry)
      return { ok: true }
    },
    // F2 — WITHOUT THIS THE RC2 WITNESSES MEASURED NOTHING. `requireStockPreparationAuditVocabulary`
    // returns at its first line when the store has no `supportsAction`, so a fake that omits it makes
    // "zero audit calls before the refusal" true BY CONSTRUCTION rather than by the route's ordering.
    // In production the probe is a real write-transaction against the audit table (INSERT + rollback),
    // so every call it makes before the tenant is established is a call an unauthorised caller caused.
    async supportsAction(action, options = {}) {
      auditCalls.push({ method: 'supportsAction', action, tenantId: (options && options.tenantId) || null })
      return auditProbe(action, options)
    },
    // J1(b): the status read reads the notification_lost rows back — the trail is the only place an
    // interior gap exists, so a fake without `list` would make lostStepKeys vacuously empty.
    async list({ projectId } = {}) {
      auditCalls.push({ method: 'list', action: null, tenantId: null })
      return {
        rowCount: auditAppends.length,
        entries: auditAppends.filter((entry) => !projectId || entry.projectId === projectId).slice().reverse(),
      }
    },
  }
  services.stockPreparationHandoffStore = handoffStore === null ? null : createStockPreparationHandoffStore({
    db,
    idGenerator: (() => {
      let n = 0
      return () => `handoff-${(n += 1)}`
    })(),
  })
  services.stockPreparationHandoffNotifier = notifier
  services.tenantPrincipalDirectory = tenantPrincipalDirectory
  httpRoutes.registerIntegrationRoutes({
    context,
    services,
    logger: { info() {}, warn() {}, error() {} },
  })
  return { routes, auditAppends, auditCalls, notifier, db, records, tenantPrincipalDirectory }
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
  await handler({
    user: req.user,
    body: req.body || {},
    query: req.query || {},
    params: req.params || {},
    // RC2: the host middleware sets this ONLY from a verified token claim. Leaving it undefined is
    // the claimless-token case, in which `user.tenantId` may be nothing but the x-tenant-id HEADER.
    authenticatedTenantId: req.authenticatedTenantId,
  }, res)
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
      // J5: the inert branch declares every key the configured branch does, at its inert value —
      // the TS interface calls them required and the two branches had already drifted once.
      notificationsConfigured: false,
      resendableStepKey: null,
      lostStepKeys: [],
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
  // RC2: both handoff routes now make the HOST vouch for the (principal, tenant) pairing.
  services.tenantPrincipalDirectory = vouchingTenantDirectory()
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
    // G5: an OBSERVATION, honest at append time — this request moved the cursor itself, so the hop
    // was not already owed a notification. The committed verdict lives on the RESPONSE (`resumed`).
    notificationOwed: false,
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
  // RC2: both handoff routes now make the HOST vouch for the (principal, tenant) pairing.
  services.tenantPrincipalDirectory = vouchingTenantDirectory()
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
  // RC2: both handoff routes now make the HOST vouch for the (principal, tenant) pairing.
  services.tenantPrincipalDirectory = vouchingTenantDirectory()
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
  assert.equal(res.body.data.notifyOutcome, 'no_destination')
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
  // RC2: both handoff routes now make the HOST vouch for the (principal, tenant) pairing.
  services.tenantPrincipalDirectory = vouchingTenantDirectory()
  httpRoutes.registerIntegrationRoutes({ context, services, logger: { info() {}, warn() {}, error() {} } })
  const res = await call(routes, 'POST', ADVANCE_PATH, {
    user: OPERATOR_ZHANG,
    body: { tenantId: TENANT_ID, projectNo: PROJECT, fromStepKey: 'prep_entry' },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.notifyOutcome, 'no_destination')
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
      [HANDOFF_CONFIG_KEY]: { tenantId: TENANT_ID, steps: [{ key: 'invented_role', handlerUserIds: ['u1'] }] },
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
      tenantId: TENANT_ID,
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
  const { routes } = mount({ config: { [HANDOFF_CONFIG_KEY]: { tenantId: TENANT_ID, steps: [] } } })
  assert.ok(routes.has('GET /api/integration/stock-preparation/prep-lines'), 'unrelated routes still registered')
  const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(res.statusCode, 500)
  assert.equal(res.body.error.code, 'STOCK_PREPARATION_HANDOFF_CONFIG_INVALID')
}

async function storeCompareAndSetRefusesAStaleAdvance() {
  const db = makeMemoryDb()
  const store = createStockPreparationHandoffStore({ db, idGenerator: () => 'handoff-1' })
  const scope = { tenantId: TENANT_ID, workspaceId: null, projectNo: PROJECT }
  const first = await store.advance({ ...scope, expectedStepIndex: 0, toStepIndex: 1, actor: ZHANG })
  assert.equal(first.changed, true)
  // RC1: the claim is a SEPARATE compare-and-set, taken after the route's audit row lands. Taking it
  // here is what the route does next, and it is at-most-once by its own predicate, not by advance's.
  assert.deepEqual(await store.claimNotification({ ...scope, stepIndex: 0 }), { claimed: true, notifiedStepIndex: 0 })
  assert.deepEqual(
    await store.claimNotification({ ...scope, stepIndex: 0 }),
    { claimed: false, notifiedStepIndex: 0 },
    'a second claim for the same hop is refused — that IS the at-most-once guarantee',
  )
  // Someone else already moved it; this caller planned against a cursor of 0.
  await assert.rejects(
    () => store.advance({ ...scope, expectedStepIndex: 0, toStepIndex: 2, actor: LI }),
    (error) => {
      assert.equal(error.status, 409)
      assert.equal(error.code, 'STOCK_PREPARATION_HANDOFF_STEP_MISMATCH')
      return true
    },
  )
  assert.equal(db.rows[0].step_index, 1, 'the stale advance did not move the cursor')
  // The idempotent replay path: same destination, no write.
  const replay = await store.advance({ ...scope, expectedStepIndex: 0, toStepIndex: 1, actor: ZHANG })
  assert.equal(replay.changed, false)
  assert.equal(replay.handoff.notifiedStepIndex, 0, 'and it reports the claim it can see, so the route can resume')
}

async function storeIsTenantAndProjectScoped() {
  const db = makeMemoryDb()
  const store = createStockPreparationHandoffStore({ db, idGenerator: (() => { let n = 0; return () => `h-${(n += 1)}` })() })
  await store.advance({ tenantId: TENANT_ID, workspaceId: null, projectNo: PROJECT, expectedStepIndex: 0, toStepIndex: 1, actor: ZHANG })
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
  // RC2 MADE THIS STRICTER, AND F1 MADE IT STRICTER AGAIN. A body naming another tenant used to be
  // silently applied to the caller's OWN — no cross-tenant write, but a request that said one thing
  // and did another. The #5445 resolver refuses a carried tenant that disagrees with the principal's.
  const res = await call(routes, 'POST', ADVANCE_PATH, {
    user: intruder,
    body: { tenantId: TENANT_ID, projectNo: PROJECT, fromStepKey: 'prep_entry' },
  })
  assert.equal(res.statusCode, 403, 'a body naming another tenant is refused, not quietly rewritten')
  assert.equal(res.body.error.code, 'OPERATOR_SCOPE_TENANT_MISMATCH')
  assert.deepEqual(db.rows, [], 'and nothing is written for either tenant')

  // Drop the contradicting key and the caller is now refused for a DIFFERENT and equally deliberate
  // reason (F1): this deployment's chain belongs to TENANT_ID, and a chain announces into ITS OWN
  // tenant's DingTalk group. Being authentic in your own tenant does not make somebody else's chain
  // yours to advance.
  const ownTenantOnAForeignChain = await call(routes, 'POST', ADVANCE_PATH, {
    user: intruder,
    body: { projectNo: PROJECT, fromStepKey: 'prep_entry' },
  })
  // G7: and the refusal is the SAME one an unconfigured deployment gives, so a POST tells a foreign
  // tenant nothing the sibling GET would not — see g7AForeignTenantGetsTheSameAnswerAsAnUnconfigured…
  assert.equal(ownTenantOnAForeignChain.statusCode, 501)
  assert.equal(ownTenantOnAForeignChain.body.error.code, 'STOCK_PREPARATION_HANDOFF_NOT_CONFIGURED')
  assert.deepEqual(db.rows, [])
  assert.equal(notifier.calls.length, 0)

  // On a deployment whose chain IS theirs, the row lands under the AUTHENTICATED tenant — never a
  // request-supplied one. That is the property this witness exists for, and it survives F1.
  const theirsConfig = chainConfig()
  theirsConfig[HANDOFF_CONFIG_KEY].tenantId = OTHER_TENANT
  const theirs = mount({ config: theirsConfig })
  const own = await call(theirs.routes, 'POST', ADVANCE_PATH, {
    user: intruder,
    body: { projectNo: PROJECT, fromStepKey: 'prep_entry' },
  })
  assert.equal(own.statusCode, 200)
  assert.equal(theirs.db.rows.length, 1)
  assert.equal(theirs.db.rows[0].tenant_id, OTHER_TENANT, 'the row landed in the AUTHENTICATED tenant')

  // The victim's chain is untouched.
  const victim = await status(routes, OPERATOR_ZHANG)
  assert.equal(victim.body.data.stepIndex, 0)
  // A cross-tenant READ is refused the same way.
  const readRes = await call(routes, 'GET', STATUS_PATH, {
    user: intruder,
    query: { tenantId: TENANT_ID, projectNo: PROJECT },
  })
  assert.equal(readRes.statusCode, 403)
  assert.equal(readRes.body.error.code, 'OPERATOR_SCOPE_TENANT_MISMATCH')
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
    store.advance({ ...scope, expectedStepIndex: 0, toStepIndex: 1, actor: ZHANG }),
    store.advance({ ...scope, expectedStepIndex: 0, toStepIndex: 1, actor: LI }),
  ])
  const changed = settled.filter((r) => r.status === 'fulfilled' && r.value.changed === true)
  assert.equal(changed.length, 1, `F1: exactly ONE of two concurrent advances may report changed:true (got ${changed.length})`)
  assert.equal(db.rows[0].step_index, 1, 'F1: the cursor moved exactly one step')
}

async function f1TwoConcurrentClaimsTakeTheNotificationOnce() {
  // THE OTHER HALF OF F1, now that the claim is its own write (RC1). Two people whose advances both
  // resolved to the same hop — the winner of the cursor race and a replayer resuming an interrupted
  // one — reach claimNotification at the same instant. Exactly one may come away with it, or the
  // 仓库+采购 fan-out goes out twice, which is the very thing at-most-once exists to prevent.
  const db = makeRacingDb(2)
  const store = createStockPreparationHandoffStore({ db, idGenerator: () => 'h-1' })
  const scope = { tenantId: TENANT_ID, projectNo: PROJECT }
  db.rows.push({ id: 'h-0', tenant_id: TENANT_ID, project_no: PROJECT, step_index: 1, notified_step_index: null, updated_by: ZHANG })
  const settled = await Promise.allSettled([
    store.claimNotification({ ...scope, stepIndex: 0 }),
    store.claimNotification({ ...scope, stepIndex: 0 }),
  ])
  const claimed = settled.filter((r) => r.status === 'fulfilled' && r.value.claimed === true)
  assert.equal(claimed.length, 1, `F1: exactly ONE of two concurrent claims may take it (got ${claimed.length})`)
  assert.equal(db.rows[0].notified_step_index, 0, 'F1: and the claim landed exactly once')
  // A claim for a project with no cursor row invents nothing.
  assert.deepEqual(
    await store.claimNotification({ tenantId: TENANT_ID, projectNo: 'PRJ-NONE', stepIndex: 0 }),
    { claimed: false, notifiedStepIndex: null },
  )
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
    () => store.advance({ tenantId: TENANT_ID, workspaceId: null, projectNo: PROJECT, expectedStepIndex: 0, toStepIndex: 1, actor: ZHANG }),
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
  await store.advance({ ...scope, expectedStepIndex: 0, toStepIndex: 1, actor: ZHANG })
  assert.equal(counts.forUpdate, 1, 'F1: the advance read the cursor FOR UPDATE')
  assert.equal(counts.plain, 0, 'F1: and never through the unlocked read')
  // The second hop goes down the UPDATE path rather than the INSERT path — same requirement.
  await store.advance({ ...scope, expectedStepIndex: 1, toStepIndex: 2, actor: LI })
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
  // route burned its at-most-once notification claim and answered `notifyOutcome: 'no_destination'`.
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
      // `tenantId` is supplied on every case so each one fails on the key it is ABOUT: the parser
      // refuses a missing tenant (F1) before it looks at notify/terminal, and a witness that tripped
      // on that instead would stop testing typos.
      () => parseStockPreparationHandoffConfig({ [HANDOFF_CONFIG_KEY]: { tenantId: TENANT_ID, ...bad } }),
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
  const chain = parseStockPreparationHandoffConfig({ [HANDOFF_CONFIG_KEY]: { tenantId: TENANT_ID, steps: STEPS3 } })
  assert.equal(chain.configured, true)
  assert.equal(chain.notifyGroupDestinationId, null)
  assert.deepEqual([...chain.terminalGroupDestinationIds], [])
  // A ONE-STEP chain has no mid-chain hop at all, so it may declare `terminal` alone.
  const single = parseStockPreparationHandoffConfig({
    [HANDOFF_CONFIG_KEY]: { tenantId: TENANT_ID, steps: [{ key: 'final_review', handlerUserIds: [WANG] }], terminal: GOOD_TERMINAL },
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
  const turnStateOnly = parseStockPreparationHandoffConfig({ [HANDOFF_CONFIG_KEY]: { tenantId: TENANT_ID, steps: STEPS3 } })
  assert.equal(chainHasDestinationForHop(turnStateOnly, false), false)
  assert.equal(chainHasDestinationForHop(turnStateOnly, true), false)
  const full = parseStockPreparationHandoffConfig(chainConfig())
  assert.equal(chainHasDestinationForHop(full, false), true)
  assert.equal(chainHasDestinationForHop(full, true), true)
  assert.equal(chainHasDestinationForHop(parseStockPreparationHandoffConfig({}), false), false, 'an unconfigured chain has no hop')

  // End to end: the turn-state-only chain moves the cursor and leaves the claim UNSPENT.
  const db = makeMemoryDb()
  const notifier = makeNotifierSpy()
  const { routes } = mount({ config: { [HANDOFF_CONFIG_KEY]: { tenantId: TENANT_ID, steps: STEPS3 } }, notifier, db })
  const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.notifyOutcome, 'no_destination')
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
    // RC2: both handoff routes now make the HOST vouch for the (principal, tenant) pairing.
    services.tenantPrincipalDirectory = vouchingTenantDirectory()
    httpRoutes.registerIntegrationRoutes({ context, services, logger: { info() {}, warn() {}, error() {} } })
    return { routes: routeMap }
  })()
  const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(res.statusCode, 200)
  assert.equal(seenAtAppend.length, 1)
  assert.equal(seenAtAppend[0].length, 1, 'F6: the cursor row already existed when the audit was appended')
  assert.equal(seenAtAppend[0][0].step_index, 1, 'F6: and it already held the NEW step index')
  // RC1 MOVED THE OTHER HALF OF THIS ASSERTION, DELIBERATELY. The claim used to be stamped in the
  // same transaction as the cursor and so was already visible here; it is now taken AFTER this append
  // returns, which is the whole point — an audit failure must not be able to spend it. So at append
  // time the hop is committed and still OWED a notification, and only a trail row that landed lets
  // the claim be taken at all.
  assert.equal(
    seenAtAppend[0][0].notified_step_index,
    null,
    'RC1: the notification claim is NOT yet spent when the trail row is written',
  )
  assert.equal(db.rows[0].notified_step_index, 0, 'RC1: and it is taken once the append has returned')
  assert.equal(notifier.calls.length, 1, 'and exactly one message went out for the hop')
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
  assert.equal(db.rows[0].notified_step_index, 1, 'P3: the claim UPDATE wrote the NEW claim, not the old one')
  const claimWrites = db.updateCalls.filter((c) => 'notified_step_index' in c.patch)
  assert.equal(claimWrites.length, 2, 'P3: one claim UPDATE per hop, and it is a separate write (RC1)')
  assert.equal(claimWrites[1].patch.notified_step_index, 1, 'P3: and the new claim is in its SET clause')
  assert.equal(claimWrites[1].where.notified_step_index, 0, 'P3: predicated on the claim it compared against')
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
    () => store.advance({ tenantId: TENANT_ID, workspaceId: null, projectNo: PROJECT, expectedStepIndex: 0, toStepIndex: 1, actor: ZHANG }),
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
    () => store.advance({ tenantId: TENANT_ID, workspaceId: null, projectNo: PROJECT, expectedStepIndex: 0, toStepIndex: 1, actor: ZHANG }),
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
    () => otherStore.advance({ tenantId: TENANT_ID, workspaceId: null, projectNo: PROJECT, expectedStepIndex: 0, toStepIndex: 1, actor: ZHANG }),
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
  const applied = await raceStore.advance({ tenantId: TENANT_ID, workspaceId: null, projectNo: PROJECT, expectedStepIndex: 0, toStepIndex: 1, actor: ZHANG })
  assert.equal(applied.changed, false, 'P3: the loser sees the winner\'s cursor and reports a replay')
  assert.deepEqual(
    await raceStore.claimNotification({ tenantId: TENANT_ID, projectNo: PROJECT, stepIndex: 0 }),
    { claimed: false, notifiedStepIndex: 0 },
    'P3: and cannot re-claim the notification the winner already took',
  )
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


// ---------------------------------------------------------------------------
// RC1..RC7 — the post-rebase adversarial recheck (10 confirmed findings, 0 refuted).
//
// Each block below is the witness for ONE root cause, and each was RED on 04b6f0aa0 before the
// production change that answers it. What they have in common is that the first round's fixes were
// all real and all NARROW: F6 moved the audit AFTER the store and thereby opened the mirror-image
// hole (RC1); F2 hardened `projectNo` and left `workspaceId` beside it untouched (RC3); and both
// routes were written to the pre-#5445 tenant pattern in a file where the remedy already existed
// three routes above them (RC2).
// ---------------------------------------------------------------------------

/**
 * A db whose FIRST out-of-transaction read (the route's `store.get`, which the planner runs on) sees
 * the world as it was, and whose in-transaction read then sees a co-handler's committed move. That
 * is the plan/commit race, expressed as a fake rather than as a sleep.
 */
function makeCursorRaceDb(injectAfterFirstGet) {
  const inner = makeMemoryDb()
  let gets = 0
  const racing = {
    get rows() { return inner.rows },
    get updateCalls() { return inner.updateCalls },
    async selectOne(table, where) {
      const result = await inner.selectOne(table, where)
      gets += 1
      if (gets === 1) injectAfterFirstGet(inner)
      return result
    },
    selectOneForUpdate: (...args) => inner.selectOneForUpdate(...args),
    insertOne: (...args) => inner.insertOne(...args),
    updateRow: (...args) => inner.updateRow(...args),
    async transaction(fn) { return fn(racing) },
  }
  return racing
}

// --- RC1: an audit failure must not burn the at-most-once notification claim ------------------

async function rc1AnAuditFailureLeavesTheClaimUnspentAndTheHopRecoverable() {
  // THE MIRROR IMAGE OF F6, and the reason the claim is now a SEPARATE write.
  //
  // F6 was right that a refused compare-and-set must leave no audit row, so the store commits before
  // the trail is written. But the first cut of that reorder stamped the CURSOR and the at-most-once
  // NOTIFICATION CLAIM in one transaction, so an audit append that failed afterwards left a hop
  // whose turn had moved and whose notification could never be sent again: the next click is a
  // replay, a replay could not re-claim, and the one thing this whole feature exists to do had
  // silently not happened.
  //
  // Now the cursor moves alone, the trail is written, and only then is the claim taken — by its own
  // compare-and-set, which is what makes the interrupted request RESUMABLE rather than lost.
  let auditWorks = false
  const auditAppends = []
  const notifier = makeNotifierSpy()
  const db = makeMemoryDb()
  const routes = new Map()
  const context = {
    api: {
      http: { addRoute(m, rp, h) { routes.set(`${m.toUpperCase()} ${rp}`, h) } },
      multitable: { provisioning: inertService(['resolveFieldIds']), records: makeRecordsApi() },
    },
    storage: new Map(),
    config: { ...chainConfig(), stockPreparationTableActions: [tableActionConfig()] },
  }
  const services = baseServices()
  services.stockPreparationAuditStore = {
    async append(entry) {
      if (!auditWorks) {
        const error = new Error('audit ledger unavailable')
        error.status = 422
        error.code = 'AUDIT_DETAIL_INVALID'
        throw error
      }
      auditInternals.assertValuesFreeDetail(entry.detail)
      auditAppends.push(entry)
      return { ok: true }
    },
  }
  services.stockPreparationHandoffStore = createStockPreparationHandoffStore({ db, idGenerator: () => 'handoff-x' })
  services.stockPreparationHandoffNotifier = notifier
  services.tenantPrincipalDirectory = vouchingTenantDirectory()
  httpRoutes.registerIntegrationRoutes({ context, services, logger: { info() {}, warn() {}, error() {} } })

  const first = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(first.statusCode, 422, 'the caller is told the trail write failed')
  assert.equal(auditAppends.length, 0)
  assert.equal(notifier.calls.length, 0, 'nothing is announced for a handoff with no trail entry')
  assert.equal(db.rows.length, 1)
  assert.equal(db.rows[0].step_index, 1, 'the cursor move is committed — F6 traded this away on purpose')
  assert.equal(
    db.rows[0].notified_step_index,
    null,
    'RC1: the at-most-once claim is NOT burned by a failed audit — that is what makes the hop recoverable',
  )

  // The audit store comes back. The operator clicks the same button again.
  auditWorks = true
  const second = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(second.statusCode, 200)
  assert.equal(second.body.data.changed, false, 'the cursor really had moved, so this IS a replay')
  assert.equal(second.body.data.notifyOutcome, 'sent', 'RC1: the notification the failed request owed goes out now')
  assert.equal(notifier.calls.length, 1, 'exactly one notification for one hop, across both clicks')
  assert.equal(db.rows[0].notified_step_index, 0, 'and the claim is spent exactly once')
  assert.equal(auditAppends.length, 1)
  // The mode is the STORE's committed verdict (RC5) — this request moved nothing. The row records
  // what it OBSERVED (the hop was owed); the committed verdict that it finished the hop is on the
  // RESPONSE, because the append happens before the claim and may not assert what it has not seen
  // (G5).
  assert.equal(auditAppends[0].mode, 'replayed')
  assert.equal(auditAppends[0].detail.notificationOwed, true, 'RC1: the trail records that this hop was owed a notice')
  assert.equal(second.body.data.resumed, true, 'RC1/G5: and the response reports that this click completed it')

  // And a third click changes nothing at all.
  const third = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(third.body.data.notifyOutcome, 'skipped')
  assert.equal(notifier.calls.length, 1, 'at-most-once survives the recovery path')
  assert.equal(auditAppends[1].detail.notificationOwed, false)
  assert.equal(third.body.data.resumed, false)
}

async function rc1AMissingAuditVocabularyIsANamed503BeforeAnyWrite() {
  // THE REALISTIC TRIGGER for the failure above, closed at its source. `requireStockPreparationAudit`
  // only ever checked that the service OBJECT exists; it could not see whether migration 085 had run.
  // On a deployment where the code is live and 085 is not applied, 082's CHECK constraint rejects
  // action='handoff_advance', so EVERY first advance landed in the state above — with a raw
  // constraint-violation message reaching the operator. Now the route probes the vocabulary once and
  // refuses BY NAME, before the cursor moves.
  const notifier = makeNotifierSpy()
  const db = makeMemoryDb()
  const routes = new Map()
  const context = {
    api: {
      http: { addRoute(m, rp, h) { routes.set(`${m.toUpperCase()} ${rp}`, h) } },
      multitable: { provisioning: inertService(['resolveFieldIds']), records: makeRecordsApi() },
    },
    storage: new Map(),
    config: { ...chainConfig(), stockPreparationTableActions: [tableActionConfig()] },
  }
  const services = baseServices()
  let probes = 0
  services.stockPreparationAuditStore = {
    async append() { throw new Error('must never be reached: the vocabulary probe refuses first') },
    async supportsAction(action) {
      probes += 1
      assert.equal(action, 'handoff_advance')
      return { supported: false, reason: 'action_not_in_check_constraint' }
    },
  }
  services.stockPreparationHandoffStore = createStockPreparationHandoffStore({ db, idGenerator: () => 'handoff-x' })
  services.stockPreparationHandoffNotifier = notifier
  services.tenantPrincipalDirectory = vouchingTenantDirectory()
  httpRoutes.registerIntegrationRoutes({ context, services, logger: { info() {}, warn() {}, error() {} } })

  const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(res.statusCode, 503)
  assert.equal(res.body.error.code, 'STOCK_PREPARATION_AUDIT_VOCABULARY_UNAVAILABLE')
  assert.match(res.body.error.message, /085/, 'the refusal names the migration an operator has to run')
  assert.deepEqual(db.rows, [], 'nothing was written')
  assert.equal(notifier.calls.length, 0)

  // G4 CHANGED WHAT IS MEMOISED, AND ONLY THE POSITIVE HALF IS. A negative verdict is the state the
  // operator is being told to fix, so it is re-probed every request — otherwise running 085 exactly
  // as this 503 instructs would never unblock the route without a process restart nobody documented.
  // (The positive half is still cached once; see g4TheVocabularyProbeRecoversWhenTheMigrationIsApplied.)
  await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(probes, 2, 'a NEGATIVE verdict is re-probed, so the fix the message names can take effect')
}

// --- RC2: the tenant comes from the verified principal, never from x-tenant-id -----------------

async function rc2AHeaderSteeredTenantCannotReachAnotherTenantsChain() {
  // THE HOLE: `hydrateAuthenticatedUser` copies the x-tenant-id REQUEST HEADER onto `user.tenantId`
  // whenever the verified token carries no tenant claim. Both handoff routes used to read exactly
  // that field, so one header decided whose cursor was read, whose was advanced, whose audit row was
  // written, and which project number went into a DingTalk group.
  //
  // Both routes now go through resolveOperatorValueScope, which makes the HOST vouch for the
  // (principal, tenant) pairing. A claimless token whose header names a tenant the principal is not
  // in is refused — BEFORE any store, records or notifier call.
  const directory = makeTenantDirectory((userId, tenantId) => tenantId === OTHER_TENANT)
  const notifier = makeNotifierSpy()
  const db = makeMemoryDb()
  const records = makeRecordsApi()
  const { routes, auditAppends } = mount({ notifier, db, records, tenantPrincipalDirectory: directory })
  // The claimless token: no verified claim, and `user.tenantId` is whatever the header said.
  const steered = { id: ZHANG, tenantId: TENANT_ID, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] }

  const write = await call(routes, 'POST', ADVANCE_PATH, {
    user: steered,
    authenticatedTenantId: undefined,
    body: { projectNo: PROJECT, fromStepKey: 'prep_entry' },
  })
  assert.equal(write.statusCode, 403)
  assert.equal(write.body.error.code, 'OPERATOR_SCOPE_TENANT_MEMBERSHIP_DENIED')
  assert.deepEqual(db.rows, [], 'RC2: no cursor row for a tenant the host will not vouch for')
  assert.deepEqual(auditAppends, [], 'and no audit row')
  assert.equal(notifier.calls.length, 0, 'and nothing announced into that tenant\u2019s group')
  assert.equal(records.queries.length, 0, 'the refusal costs zero records IO')

  const read = await call(routes, 'GET', STATUS_PATH, {
    user: steered,
    authenticatedTenantId: undefined,
    query: { projectNo: PROJECT },
  })
  assert.equal(read.statusCode, 403)
  assert.equal(read.body.error.code, 'OPERATOR_SCOPE_TENANT_MEMBERSHIP_DENIED')
}

async function rc2AHeaderThatContradictsTheVerifiedClaimIsRefusedOnBothRoutes() {
  const notifier = makeNotifierSpy()
  const db = makeMemoryDb()
  const { routes } = mount({ notifier, db })
  const contradicted = { id: ZHANG, tenantId: OTHER_TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] }
  for (const [method, routePath, payload] of [
    ['POST', ADVANCE_PATH, { body: { projectNo: PROJECT, fromStepKey: 'prep_entry' } }],
    ['GET', STATUS_PATH, { query: { projectNo: PROJECT } }],
  ]) {
    const res = await call(routes, method, routePath, {
      user: contradicted,
      // The VERIFIED claim says one tenant; the header-filled user object says another.
      authenticatedTenantId: TENANT_ID,
      ...payload,
    })
    assert.equal(res.statusCode, 403, `${method} ${routePath} refuses a contradicted tenant`)
    assert.equal(res.body.error.code, 'OPERATOR_SCOPE_TENANT_CONTRADICTED')
  }
  assert.deepEqual(db.rows, [])
  assert.equal(notifier.calls.length, 0)
}

async function rc2ATenantlessPrincipalIsRefusedOnBothRoutes() {
  // The platform side: a tenantless admin has no tenant of its own, so there is no chain that is
  // theirs to read or to advance. #5445 made this refusal the posture for the value plane; the
  // handoff joins it, because an advance both writes and speaks outside the system.
  const notifier = makeNotifierSpy()
  const db = makeMemoryDb()
  const records = makeRecordsApi()
  const { routes } = mount({ notifier, db, records })
  const tenantless = { id: 'u_admin', permissions: ['role:admin', 'integration:admin'] }
  for (const [method, routePath, payload] of [
    ['POST', ADVANCE_PATH, { body: { projectNo: PROJECT, fromStepKey: 'prep_entry' } }],
    ['GET', STATUS_PATH, { query: { projectNo: PROJECT } }],
  ]) {
    const res = await call(routes, method, routePath, { user: tenantless, ...payload })
    assert.equal(res.statusCode, 403, `${method} ${routePath} refuses a tenantless principal`)
    assert.equal(res.body.error.code, 'OPERATOR_SCOPE_TENANT_REQUIRED')
  }
  assert.deepEqual(db.rows, [])
  assert.equal(records.queries.length, 0)
}

async function rc2AnAbsentHostDirectoryFailsClosedOnBothRoutes() {
  const db = makeMemoryDb()
  const { routes } = mount({ db, tenantPrincipalDirectory: null })
  for (const [method, routePath, payload] of [
    ['POST', ADVANCE_PATH, { body: { projectNo: PROJECT, fromStepKey: 'prep_entry' } }],
    ['GET', STATUS_PATH, { query: { projectNo: PROJECT } }],
  ]) {
    const res = await call(routes, method, routePath, { user: OPERATOR_ZHANG, ...payload })
    assert.equal(res.statusCode, 501, `${method} ${routePath} fails closed without the host seam`)
    assert.equal(res.body.error.code, 'OPERATOR_SCOPE_DIRECTORY_UNAVAILABLE')
  }
  assert.deepEqual(db.rows, [])
}

// --- RC3: the turn is a PROJECT-level fact, so workspaceId cannot multiply it ------------------

async function rc3WorkspaceIdCannotMultiplyTheCursorOrTheNotification() {
  // WHY THIS WAS WORSE THAN THE PLUGIN-WIDE `workspaceId` CONVENTION IT INHERITED. Everywhere else in
  // this family workspaceId is a same-tenant scope selector on a READ. Here it was part of the key of
  // the at-most-once NOTIFICATION CLAIM, so five requests differing only in a string nobody validates
  // produced five cursor rows and five identical pings into the same DingTalk group — defeating the
  // one guarantee this store is built around, with no race and no extra privilege.
  //
  // The turn is a fact about a PROJECT (migration 084's own rationale), so workspaceId is gone from
  // the scope entirely. It stays in the request allowlist because the workbench spreads its scope
  // into every call in this family, and it is documented there as carrying no meaning here.
  const notifier = makeNotifierSpy()
  const db = makeMemoryDb()
  const { routes, auditAppends } = mount({ notifier, db })
  for (const workspaceId of [undefined, 'w1', 'w2', 'w3', 'anything-at-all']) {
    const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry', workspaceId })
    assert.equal(res.statusCode, 200, `workspaceId=${String(workspaceId)} is accepted, not refused`)
  }
  assert.equal(db.rows.length, 1, 'RC3: one project, one cursor row, whatever the caller calls its workspace')
  assert.equal(db.rows[0].step_index, 1)
  assert.equal(notifier.calls.length, 1, 'RC3: one hop, one ping')
  assert.equal(auditAppends.length, 5, 'every click is still recorded — it is the CURSOR that must not fork')
  assert.deepEqual(
    auditAppends.map((entry) => entry.mode),
    ['advanced', 'replayed', 'replayed', 'replayed', 'replayed'],
  )
  const seen = await status(routes, OPERATOR_ZHANG, { workspaceId: 'a-completely-different-one' })
  assert.equal(seen.body.data.stepIndex, 1, 'and the status read cannot be steered onto a different cursor either')
}

/**
 * J8 — EVERY OUTCOME LITERAL THE ROUTE AND THE DISPATCHER MENTION.
 *
 * This used to BE the vocabulary, derived by reading the source, and a text scrape is the wrong shape
 * of guarantee for a closed set: `const x = 'deferred'` on one line and `notifyOutcome = x` on the
 * next escaped it completely, shipping a wire value with no plain-language copy and a green suite.
 *
 * The vocabulary now lives in production code (`STOCK_PREP_HANDOFF_NOTIFY_OUTCOMES`) and the wire is
 * checked against it at runtime, so this scrape has a smaller and more honest job: catch a literal
 * that LOOKS like an outcome but never joined the set, statically, before the runtime check has to.
 */
function collectHandoffNotifyOutcomes(source) {
  const out = new Set()
  const dispatcher = source.slice(source.indexOf('async function dispatchStockPreparationHandoffNotification'))
  const dispatcherBody = dispatcher.slice(0, dispatcher.indexOf(String.fromCharCode(10) + '  }' + String.fromCharCode(10)))
  for (const line of dispatcherBody.match(/return .*/g) || []) {
    for (const m of line.matchAll(/'([a-z_]+)'/g)) out.add(m[1])
  }
  const route = source.slice(source.indexOf('async stockPreparationHandoffAdvance(req, res) {'))
  const routeBody = route.slice(0, route.indexOf(String.fromCharCode(10) + '    },' + String.fromCharCode(10)))
  for (const line of routeBody.match(/notifyOutcome\s*=.*/g) || []) {
    for (const m of line.matchAll(/'([a-z_]+)'/g)) out.add(m[1])
  }
  return [...out]
}

// --- RC4: a partial terminal fan-out is reported as partial ------------------------------------

async function rc4APartialTerminalFanOutIsNotReportedAsSent() {
  // 仓库 AND 采购 on the terminal hop. The host deliberately keeps going when one destination fails
  // and returns {delivered, failed}; the route used to throw `failed` away and map delivered > 0 to
  // 'sent', so the operator was told in words that the group had been told — and at-most-once meant
  // clicking again could never fix it. The gap is now named.
  const partialNotifier = {
    calls: [],
    async sendToDestinations(request) {
      this.calls.push(request)
      return { delivered: 1, failed: request.destinationIds.length - 1 }
    },
  }
  const db = makeMemoryDb()
  const { routes } = mount({ notifier: partialNotifier, db })
  await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  await advance(routes, OPERATOR_LI, { fromStepKey: 'process' })
  const terminal = await advance(routes, OPERATOR_WANG, { fromStepKey: 'final_review' })
  assert.equal(terminal.statusCode, 200)
  assert.equal(terminal.body.data.terminal, true)
  assert.equal(terminal.body.data.notifyOutcome, 'partial', 'RC4: one of the two groups was not told')
  assert.equal(terminal.body.data.notified, false, '`notified` may not claim a fan-out that half-failed')
  // The turn still moved — the notice is about the message, not about the work.
  assert.equal(terminal.body.data.currentStepKey, null)
}

async function rc4EveryOutcomeTheRouteCanReturnHasCopy() {
  // The enum and the words the operator reads must not drift apart. Deriving the list from the ROUTE
  // rather than typing it here is what makes a future outcome fail this instead of shipping silent.
  const fs = require('node:fs')
  const source = fs.readFileSync(path.join(LIB, 'http-routes.cjs'), 'utf8')
  // J8: the vocabulary is the frozen CONSTANT now, not a scrape — see
  // j8TheScrapedLiteralsAreAllMembersOfTheClosedVocabulary for what the scrape still guards.
  const returned = STOCK_PREP_HANDOFF_NOTIFY_OUTCOMES
  assert.ok(returned.includes('partial'), 'RC4: the vocabulary carries partial')
  assert.ok(returned.includes('sent') && returned.includes('failed'), 'and sent / failed')
  const plainPath = path.join(
    __dirname, '..', '..', '..',
    'apps', 'web', 'src', 'services', 'integration', 'stockPreparation', 'plainLanguage.ts',
  )
  const table = fs.readFileSync(plainPath, 'utf8')
  const start = table.indexOf('STOCK_PREP_HANDOFF_OUTCOME_PLAIN: Record')
  assert.ok(start > 0, 'the outcome copy table is where this expects it')
  const copy = table.slice(start, table.indexOf(String.fromCharCode(10) + 'export ', start))
  for (const outcome of returned) {
    assert.ok(copy.includes(`${outcome}: Object.freeze(`), `RC4: outcome '${outcome}' has plain-language copy`)
  }
}

// --- RC5: the audit mode is the committed verdict, not the plan --------------------------------

async function rc5TheAuditModeComesFromTheCommittedVerdictNotThePlan() {
  // A step may have MORE THAN ONE configured handler (`handlerUserIds` is a list). If 赵 commits the
  // same hop in the window between 张's plan and 张's commit, the store correctly refuses to write —
  // but the trail used to take its `mode` from the PLAN, and so recorded that 张 advanced a step 赵
  // advanced. Two answers to "who handed this off", for one cursor move.
  const config = {
    [HANDOFF_CONFIG_KEY]: {
      tenantId: TENANT_ID,
      steps: [
        { key: 'prep_entry', handlerUserIds: [ZHANG, 'u_zhao'] },
        { key: 'process', handlerUserIds: [LI] },
        { key: 'final_review', handlerUserIds: [WANG] },
      ],
      notify: { groupDestinationId: NOTIFY_DEST },
      terminal: { groupDestinationIds: [WAREHOUSE_DEST, PURCHASING_DEST] },
    },
  }
  const db = makeCursorRaceDb((inner) => {
    inner.rows.push({
      id: 'handoff-race',
      tenant_id: TENANT_ID,
      project_no: PROJECT,
      step_index: 1,
      notified_step_index: 0,
      updated_by: 'u_zhao',
    })
  })
  const notifier = makeNotifierSpy()
  const { routes, auditAppends } = mount({ config, db, notifier })
  const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.changed, false, 'the store refused to write — 赵 had already moved it')
  assert.equal(auditAppends.length, 1)
  assert.equal(
    auditAppends[0].mode,
    'replayed',
    'RC5: the trail records what the STORE did, never what the planner intended',
  )
  assert.equal(notifier.calls.length, 0, 'and the hop 赵 already claimed is not announced twice')
}

// --- RC6: the handler gate runs before any records IO ------------------------------------------

async function rc6ANonHandlerCannotTellAnExistingProjectFromAnUnknownOne() {
  // The existence probe used to run BEFORE the handler check, so a caller the route was about to
  // refuse could still tell 404 (this project number is real) from 403 (it is not) — a project-number
  // oracle for anyone holding stock-prep:operate, and one that leaves no audit row behind. The plan
  // now runs first, off the tenant-scoped cursor, so a non-handler gets ONE answer either way and
  // costs zero records IO.
  const records = makeRecordsApi([PROJECT])
  const db = makeMemoryDb()
  const { routes, auditAppends } = mount({ db, records })
  const existing = await call(routes, 'POST', ADVANCE_PATH, {
    user: OPERATOR_STRANGER,
    body: { projectNo: PROJECT, fromStepKey: 'prep_entry' },
  })
  const unknown = await call(routes, 'POST', ADVANCE_PATH, {
    user: OPERATOR_STRANGER,
    body: { projectNo: 'PRJ-NOT-A-REAL-ONE', fromStepKey: 'prep_entry' },
  })
  assert.equal(existing.statusCode, 403)
  assert.equal(unknown.statusCode, 403)
  assert.equal(existing.body.error.code, 'STOCK_PREPARATION_HANDOFF_NOT_CURRENT_HANDLER')
  assert.deepEqual(
    unknown.body.error,
    existing.body.error,
    'RC6: a non-handler gets one indistinguishable refusal, so the route is no project-number oracle',
  )
  assert.equal(records.queries.length, 0, 'RC6: and the refusal costs zero records IO')
  assert.deepEqual(db.rows, [])
  assert.deepEqual(auditAppends, [])
  // The real handler still gets the honest 404 — the existence check did not go away, it moved.
  const handler = await advance(routes, OPERATOR_ZHANG, { projectNo: 'PRJ-NOT-A-REAL-ONE', fromStepKey: 'prep_entry' })
  assert.equal(handler.statusCode, 404)
  assert.equal(handler.body.error.code, 'STOCK_PREPARATION_HANDOFF_PROJECT_NOT_FOUND')
  assert.deepEqual(db.rows, [], 'and still nothing is written for a project that does not exist')
}

// --- RC7: a chain may be BOUND to one tenant, and says so when it is not ------------------------

async function rc7ATenantBoundChainRefusesEveryOtherTenant() {
  // The notifier seam has no tenant dimension: destination ids are deploy-global and
  // `sendToDestination` proves only that a destination is admin-managed, never that its org is the
  // org whose project is being announced. Per-tenant chains are a later change; what this one adds is
  // the ability to SAY which tenant a deploy-global chain belongs to, and to refuse every other one
  // by name.
  const bound = chainConfig()
  bound[HANDOFF_CONFIG_KEY].tenantId = OTHER_TENANT
  const notifier = makeNotifierSpy()
  const db = makeMemoryDb()
  const records = makeRecordsApi()
  const { routes, auditAppends } = mount({ config: bound, notifier, db, records })

  const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  // G7: the WIRE answer is the one an unconfigured deployment gives — a foreign tenant may not learn
  // from a POST that a chain exists here and is somebody else's. The distinct reason lives in the log.
  assert.equal(res.statusCode, 501)
  assert.equal(res.body.error.code, 'STOCK_PREPARATION_HANDOFF_NOT_CONFIGURED')
  assert.deepEqual(db.rows, [])
  assert.deepEqual(auditAppends, [])
  assert.equal(notifier.calls.length, 0)
  assert.equal(records.queries.length, 0)

  // And to a tenant it is not bound to, a bound chain is simply NO chain — the workbench renders
  // nothing rather than a turn signal it may not act on.
  const seen = await status(routes, OPERATOR_ZHANG)
  assert.equal(seen.statusCode, 200)
  assert.equal(seen.body.data.configured, false)
  assert.deepEqual(seen.body.data.steps, [])

  // The bound tenant is served exactly as before.
  const owner = mount({ config: bound })
  const zhangThere = { id: ZHANG, tenantId: OTHER_TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] }
  const ok = await call(owner.routes, 'POST', ADVANCE_PATH, {
    user: zhangThere,
    body: { projectNo: PROJECT, fromStepKey: 'prep_entry' },
  })
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.body.data.notifyOutcome, 'sent')
}



// ---------------------------------------------------------------------------
// F1..F3 — round-2 recheck of the RC fixes (3 confirmed, lane B).
//
// The RC round closed real holes and left three: RC7's unbound default was justified by a config
// contract that was never written (F1), RC2's "zero audit calls before the refusal" was true only of
// a fake that had no probe to call (F2), and the repo's STATIC anti-regression tripwire — the one
// whose header promises a new write route cannot silently reintroduce the class — never learned about
// either handoff handler (F3).
// ---------------------------------------------------------------------------

async function f1AChainWithoutATenantIdIsRefusedRatherThanDeployGlobal() {
  // RC7 SHIPPED THE GUARD AND LEFT IT OFF BY DEFAULT, citing a contract that does not exist. Two code
  // comments said app.manifest.json's `stockPrepHandoff` note and the 222 runbook state that omitting
  // `tenantId` asserts a single-tenant deployment. The manifest note never mentioned tenancy at all
  // and the PR changed no documentation, so an administrator following the documented contract could
  // not discover the key — while the default it left on announced one tenant's project number into
  // another tenant's group (see the dual-org witness below).
  //
  // A guarantee that depends on a sentence nobody wrote is not a guarantee. `tenantId` is now
  // REQUIRED, which costs one line of deploy config and removes the default entirely.
  const noTenant = chainConfig()
  delete noTenant[HANDOFF_CONFIG_KEY].tenantId
  assert.throws(
    () => parseStockPreparationHandoffConfig(noTenant),
    (error) => {
      assert.equal(error.status, 500)
      assert.equal(error.code, 'STOCK_PREPARATION_HANDOFF_CONFIG_INVALID')
      assert.equal(error.details.field, 'tenantId', 'F1: the refusal NAMES the key an operator has to add')
      return true
    },
    'F1: a chain that names no tenant is a configuration error, not a deploy-global default',
  )
  // Typed like every other required config string.
  for (const bad of [42, '', '   ', null, {}]) {
    const wrong = chainConfig()
    wrong[HANDOFF_CONFIG_KEY].tenantId = bad
    assert.throws(
      () => parseStockPreparationHandoffConfig(wrong),
      (error) => error.code === 'STOCK_PREPARATION_HANDOFF_CONFIG_INVALID' && error.details.field === 'tenantId',
      `F1: tenantId=${JSON.stringify(bad)} is refused by name`,
    )
  }
  // And BOTH routes refuse rather than degrading to "no chain here" — a missing required key must
  // never be indistinguishable from an unconfigured deployment, which is the whole F3 doctrine.
  const { routes, db, auditAppends, notifier, records } = mount({ config: noTenant })
  for (const [method, routePath, payload] of [
    ['POST', ADVANCE_PATH, { body: { projectNo: PROJECT, fromStepKey: 'prep_entry' } }],
    ['GET', STATUS_PATH, { query: { projectNo: PROJECT } }],
  ]) {
    const res = await call(routes, method, routePath, { user: OPERATOR_ZHANG, ...payload })
    assert.equal(res.statusCode, 500, `F1: ${method} ${routePath} refuses a chain with no tenant`)
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_HANDOFF_CONFIG_INVALID')
    assert.equal(res.body.error.details.field, 'tenantId')
  }
  assert.deepEqual(db.rows, [], 'F1: nothing written')
  assert.deepEqual(auditAppends, [], 'F1: nothing audited')
  assert.equal(notifier.calls.length, 0, 'F1: nothing announced')
  assert.equal(records.queries.length, 0, 'F1: and no records IO')
  // The chain object itself no longer has a null-tenant shape to reason about.
  assert.equal(parseStockPreparationHandoffConfig(chainConfig()).tenantId, TENANT_ID)
}

async function f1TheDualOrgHeaderReproCannotAnnounceAcrossTenants() {
  // THE EXECUTED REPRO FROM THE RECHECK, TURNED INTO A WITNESS.
  //
  // `resolveSessionTenantId` omits the tenant claim for any account with zero OR TWO-PLUS org
  // memberships — the codebase says so itself — so a person active in two orgs carries a CLAIMLESS
  // token, `user.tenantId` is nothing but the x-tenant-id header, and the host directory correctly
  // vouches for EITHER org. RC2 stops a tenant the principal is not in; it cannot stop a principal
  // choosing between two tenants that are both genuinely theirs. What stops tenant BETA's project
  // number reaching tenant ACME's DingTalk group is the chain binding — which is why it may not be
  // optional.
  const ACME = 'tenant-acme'
  const BETA = 'tenant-beta'
  const chain = {
    [HANDOFF_CONFIG_KEY]: {
      tenantId: ACME,
      steps: [
        { key: 'prep_entry', handlerUserIds: [ZHANG] },
        { key: 'process', handlerUserIds: [LI] },
        { key: 'final_review', handlerUserIds: [WANG] },
      ],
      notify: { groupDestinationId: 'acme-prep-group' },
      terminal: { groupDestinationIds: ['acme-warehouse'] },
    },
  }
  // The real user_orgs shape: Zhang is an active member of BOTH.
  const directory = makeTenantDirectory((userId, tenantId) => userId === ZHANG && [ACME, BETA].includes(tenantId))
  const notifier = makeNotifierSpy()
  const db = makeMemoryDb()
  const records = makeRecordsApi(['ACME-2026-01', 'BETA-SECRET-PROJECT-9'])
  const { routes, auditAppends } = mount({ config: chain, notifier, db, records, tenantPrincipalDirectory: directory })

  // The header naming HIS OWN other tenant. Claimless token, so `user.tenantId` IS the header.
  const beta = await call(routes, 'POST', ADVANCE_PATH, {
    user: { id: ZHANG, tenantId: BETA, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] },
    authenticatedTenantId: undefined,
    body: { projectNo: 'BETA-SECRET-PROJECT-9', fromStepKey: 'prep_entry' },
  })
  assert.equal(beta.statusCode, 501, 'F1: the deployment\u2019s chain is ACME\u2019s, so BETA cannot advance through it')
  // G7: refused in the words an unconfigured deployment uses — BETA learns neither that a chain
  // exists here nor whose it is.
  assert.equal(beta.body.error.code, 'STOCK_PREPARATION_HANDOFF_NOT_CONFIGURED')
  assert.equal(notifier.calls.length, 0, 'F1: BETA\u2019s project handle never leaves the system')
  assert.deepEqual(db.rows, [])
  assert.deepEqual(auditAppends, [])

  // And BETA is told there is no chain here, not shown ACME's turn state.
  const betaStatus = await call(routes, 'GET', STATUS_PATH, {
    user: { id: ZHANG, tenantId: BETA, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] },
    query: { projectNo: 'BETA-SECRET-PROJECT-9' },
  })
  assert.equal(betaStatus.statusCode, 200)
  assert.equal(betaStatus.body.data.configured, false)

  // ACME, the tenant the chain belongs to, is served exactly as before.
  const acme = await call(routes, 'POST', ADVANCE_PATH, {
    user: { id: ZHANG, tenantId: ACME, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] },
    authenticatedTenantId: undefined,
    body: { projectNo: 'ACME-2026-01', fromStepKey: 'prep_entry' },
  })
  assert.equal(acme.statusCode, 200)
  assert.equal(acme.body.data.notifyOutcome, 'sent')
  assert.equal(notifier.calls.length, 1)
  assert.match(notifier.calls[0].body, /ACME-2026-01/)
  assert.ok(!notifier.calls[0].body.includes('BETA'), 'F1: and nothing about the other tenant rode along')
}

async function f1TheCodeCitesNoContractItDoesNotCarry() {
  // The two comments RC7 shipped attributed the safety of the old default to
  // "app.manifest.json's stockPrepHandoff surface and the 222 runbook". Both were false, and a
  // citation that cannot be checked is how a reviewer is talked out of checking. Now that the key is
  // REQUIRED the claim is about a key that must exist, so it is checkable — and checked here.
  const fs = require('node:fs')
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.manifest.json'), 'utf8'))
  const surface = (manifest.configSurfaces || []).find((entry) => entry.id === 'stockPrepHandoff')
  assert.ok(surface, 'the handoff config surface is declared')
  assert.match(surface.note, /tenantId/, 'F1: the ONLY documentation of this file names the tenantId key')
  assert.ok(/必填|required/i.test(surface.note), 'F1: and says it is required')
  // And the OPTIONAL PARSE that produced the default is gone from the source, not merely unreachable:
  // a chain object with a null tenantId can no longer be constructed by the configured branch. (The
  // two files still SAY "deploy-global" — to record that there is no such thing and why — which is
  // the opposite of claiming one, so the check is on the code that made it possible, not on prose.)
  const parser = fs.readFileSync(path.join(__dirname, '..', 'lib', 'stock-preparation-handoff.cjs'), 'utf8')
  assert.ok(
    !parser.includes('raw.tenantId === undefined'),
    'F1: the optional-tenantId parse branch is deleted, not just unreachable',
  )
  assert.ok(
    parser.includes("requiredConfigString(raw.tenantId, 'tenantId')"),
    'F1: tenantId goes through the same required-string check as every other mandatory config key',
  )
  // The runbook PR #5456 made current carries the step.
  const runbook = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'docs', 'development', 'takeover-beiliao-20260821', '222-deploy-window-runbook-20260901.md'),
    'utf8',
  )
  assert.match(runbook, /stockPreparationHandoff/, 'F1: the 222 runbook names the config key')
  assert.match(runbook, /tenantId/, 'F1: and the required tenantId within it')
}

// --- F2: the vocabulary probe is a WRITE, so it may not precede the tenant refusal -------------

async function f2TheAuditVocabularyProbeRunsAfterTheTenantScope() {
  // THE PROBE IS NOT A CHEAP LOOKUP. In production `supportsAction` opens a transaction, INSERTs into
  // the audit table and rolls back — that is how it asks the database whether migration 085 widened
  // the CHECK constraint. Running it before the tenant is established meant every refused
  // tenant-steering caller caused a write-transaction against integration_stock_prep_audit, which is
  // exactly what RC2 said could not happen. The RC2 witnesses could not see it because the fake audit
  // store had no `supportsAction` to call; it does now (see mount()).
  const denying = makeTenantDirectory(() => false)
  const cases = [
    ['header-steered, host refuses to vouch', { user: { id: ZHANG, tenantId: TENANT_ID, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] } }, denying, 403, 'OPERATOR_SCOPE_TENANT_MEMBERSHIP_DENIED'],
    ['header contradicts the verified claim', { user: { id: ZHANG, tenantId: OTHER_TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] }, authenticatedTenantId: TENANT_ID }, null, 403, 'OPERATOR_SCOPE_TENANT_CONTRADICTED'],
    ['tenantless principal', { user: { id: 'u_admin', permissions: ['role:admin', 'integration:admin'] } }, null, 403, 'OPERATOR_SCOPE_TENANT_REQUIRED'],
    ['body names another tenant', { user: OPERATOR_ZHANG, body: { tenantId: OTHER_TENANT } }, null, 403, 'OPERATOR_SCOPE_TENANT_MISMATCH'],
    ['host directory absent', { user: OPERATOR_ZHANG }, undefined, 501, 'OPERATOR_SCOPE_DIRECTORY_UNAVAILABLE'],
  ]
  for (const [label, req, directory, status, code] of cases) {
    const mountArgs = {}
    if (directory !== null) mountArgs.tenantPrincipalDirectory = directory === undefined ? null : directory
    const { routes, auditCalls, db, notifier, records } = mount(mountArgs)
    const res = await call(routes, 'POST', ADVANCE_PATH, {
      user: req.user,
      authenticatedTenantId: req.authenticatedTenantId,
      body: { projectNo: PROJECT, fromStepKey: 'prep_entry', ...(req.body || {}) },
    })
    assert.equal(res.statusCode, status, `F2 (${label}): ${res.statusCode} ${JSON.stringify(res.body && res.body.error)}`)
    assert.equal(res.body.error.code, code, `F2 (${label}): coded refusal`)
    assert.deepEqual(auditCalls, [], `F2 (${label}): ZERO audit-store calls — the probe is a write and must not precede the refusal`)
    assert.deepEqual(db.rows, [], `F2 (${label}): no cursor row`)
    assert.equal(notifier.calls.length, 0, `F2 (${label}): nothing announced`)
    assert.equal(records.queries.length, 0, `F2 (${label}): no records IO`)
  }
}

async function f2ThePermittedCallerStillProbesOnceAndUnderItsOwnTenant() {
  // The probe did not go away, it moved. It still runs before any WRITE, still exactly once per
  // process, and now carries the RESOLVED tenant instead of probing under a '__probe__' placeholder —
  // so the row it inserts and rolls back belongs to the tenant whose write it is clearing.
  const { routes, auditCalls } = mount()
  await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  const probes = auditCalls.filter((entry) => entry.method === 'supportsAction')
  assert.equal(probes.length, 1, 'F2: probed once')
  assert.equal(probes[0].action, 'handoff_advance')
  assert.equal(probes[0].tenantId, TENANT_ID, 'F2: under the RESOLVED tenant, not a placeholder')
  // And it precedes the append, which is the ordering the probe exists for.
  assert.equal(auditCalls[0].method, 'supportsAction')
  assert.equal(auditCalls[1].method, 'append')
  // Six more advances add no further probes.
  for (let i = 0; i < 6; i += 1) await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(auditCalls.filter((entry) => entry.method === 'supportsAction').length, 1, 'F2: still once per process')
}


// ---------------------------------------------------------------------------
// G2..G9 — round-2 lanes A and C. Eleven findings on the RC fixes; the two that lane B already
// closed (the required tenantId, the static tripwire enrolment) are not repeated here.
// ---------------------------------------------------------------------------

// --- G3: an unconfigured deployment must still be byte-identical ------------------------------

async function g3AnUnconfiguredDeploymentNeverTouchesTheAuditTable() {
  // THE PROBE IS A WRITE (INSERT + rollback), and F2 moved it below the tenant scope — but left it
  // ABOVE the "is there a chain at all" check. So a deployment that never opted into 通知下一步 still
  // wrote to `integration_stock_prep_audit` before its 501, which contradicts the promise this
  // feature is built on: absent config behaves EXACTLY as it did before the feature existed. Worse,
  // on a database where 085 has not run the probe answers `supported:false` and that deployment was
  // told to run a migration for a feature it does not have.
  for (const [label, probeVerdict, expectedStatus, expectedCode] of [
    ['migrated db', { supported: true, reason: 'check_constraint_accepts' }, 501, 'STOCK_PREPARATION_HANDOFF_NOT_CONFIGURED'],
    ['un-migrated db', { supported: false, reason: 'action_not_in_check_constraint' }, 501, 'STOCK_PREPARATION_HANDOFF_NOT_CONFIGURED'],
  ]) {
    const { routes, auditCalls, db, notifier, records } = mount({
      config: {},
      auditProbe: async () => probeVerdict,
    })
    const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
    assert.equal(res.statusCode, expectedStatus, `G3 (${label}): ${JSON.stringify(res.body && res.body.error)}`)
    assert.equal(res.body.error.code, expectedCode, `G3 (${label}): an unconfigured deployment refuses by CONFIG, never by migration`)
    assert.deepEqual(auditCalls, [], `G3 (${label}): ZERO audit-store calls — the probe is a write and this deployment has no feature to probe for`)
    assert.deepEqual(db.rows, [])
    assert.equal(notifier.calls.length, 0)
    assert.equal(records.queries.length, 0)
  }
}

async function g3TheStoreAndChainChecksPrecedeEveryAuditCall() {
  // The absent-STORE branch too: a deployment with a chain but no SQL db must 501 on the store
  // without probing either.
  const { routes, auditCalls } = mount({ handoffStore: null })
  const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(res.statusCode, 501)
  assert.equal(res.body.error.code, 'STOCK_PREPARATION_HANDOFF_STORE_UNAVAILABLE')
  assert.deepEqual(auditCalls, [], 'G3: no audit call before the store check either')
}

// --- G4: a negative vocabulary verdict must not outlive the migration -------------------------

async function g4TheVocabularyProbeRecoversWhenTheMigrationIsApplied() {
  // The 503 says "run migration 085 before using this route". The operator runs it — and the route
  // kept refusing, because the NEGATIVE verdict was memoised for the life of the process and nothing
  // anywhere said a restart was required. A refusal that its own instructions cannot clear is worse
  // than no instructions.
  let migrated = false
  let probes = 0
  const { routes, db, notifier } = mount({
    auditProbe: async () => {
      probes += 1
      return migrated
        ? { supported: true, reason: 'check_constraint_accepts' }
        : { supported: false, reason: 'action_not_in_check_constraint' }
    },
  })
  for (const attempt of [1, 2, 3]) {
    const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
    assert.equal(res.statusCode, 503, `G4: still refusing on attempt ${attempt}`)
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_AUDIT_VOCABULARY_UNAVAILABLE')
    assert.deepEqual(db.rows, [], 'G4: and writing nothing while broken')
  }
  assert.equal(probes, 3, 'G4: a NEGATIVE verdict is re-probed every request — one rolled-back INSERT while genuinely broken is cheap')

  // The operator runs 085. No restart.
  migrated = true
  const after = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(after.statusCode, 200, 'G4: the very next request succeeds — no process restart required')
  assert.equal(after.body.data.notifyOutcome, 'sent')
  assert.equal(notifier.calls.length, 1)
  const probesAfterSuccess = probes

  // And the POSITIVE verdict IS memoised, so the steady state costs nothing.
  for (let i = 0; i < 5; i += 1) await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(probes, probesAfterSuccess, 'G4: once supported, never probed again')
}

// --- G5: the trail may not assert a claim it has not seen -------------------------------------

async function g5TheTrailNeverClaimsToHaveFinishedAHopItDidNotClaim() {
  // The same intent-vs-verdict bug RC5 fixed for `mode`, still live in the same detail object:
  // `resumed` was computed from state read inside the ADVANCE transaction and written twenty lines
  // BEFORE the claim was attempted. Two concurrent resume clicks therefore wrote two rows both
  // saying they had completed the owed hop, for one notification.
  //
  // The append cannot move below the claim — that ordering is what RC1 exists to prevent (an audit
  // failure after a spent claim loses the ping forever) — so the ROW records what this request
  // OBSERVED (`notificationOwed`) and the RESPONSE carries the committed verdict (`resumed`).
  const db = makeMemoryDb()
  const notifier = makeNotifierSpy()
  const { routes, auditAppends } = mount({ db, notifier })
  // Someone else's advance already moved the cursor and left the hop's notification owed.
  db.rows.push({
    id: 'handoff-lost',
    tenant_id: TENANT_ID,
    project_no: PROJECT,
    step_index: 1,
    notified_step_index: null,
    updated_by: ZHANG,
  })
  // ...and the claim is lost between our append and our CAS: the UPDATE matches nothing.
  const realUpdate = db.updateRow.bind(db)
  db.updateRow = async (table, patch, where) => {
    if ('notified_step_index' in patch) return []
    return realUpdate(table, patch, where)
  }
  const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.changed, false)
  assert.equal(res.body.data.notifyOutcome, 'skipped', 'the claim was lost, so nothing was sent')
  assert.equal(notifier.calls.length, 0)
  assert.equal(
    res.body.data.resumed,
    false,
    'G5: the RESPONSE reports the COMMITTED verdict — this request finished nothing',
  )
  assert.equal(auditAppends.length, 1)
  assert.equal(auditAppends[0].mode, 'replayed')
  assert.equal(
    auditAppends[0].detail.notificationOwed,
    true,
    'G5: the ROW records what this request OBSERVED (the hop was owed), which is true at append time',
  )
  assert.ok(
    !('resumed' in auditAppends[0].detail),
    'G5: and it no longer asserts a claim it had not taken yet',
  )
}

async function g5AGenuineResumeReportsResumedOnTheResponse() {
  // The other side of the same coin: when the claim IS taken on a replay, the response says so, and
  // that is what the workbench renders (see apps/web/tests/StockPreparationHandoff.spec.ts H-16).
  const db = makeMemoryDb()
  const notifier = makeNotifierSpy()
  const { routes, auditAppends } = mount({ db, notifier })
  db.rows.push({
    id: 'handoff-owed',
    tenant_id: TENANT_ID,
    project_no: PROJECT,
    step_index: 1,
    notified_step_index: null,
    updated_by: ZHANG,
  })
  const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(res.body.data.changed, false)
  assert.equal(res.body.data.notifyOutcome, 'sent')
  assert.equal(res.body.data.resumed, true, 'G5: this click completed the owed hop')
  assert.equal(notifier.calls.length, 1)
  assert.equal(auditAppends[0].detail.notificationOwed, true)
  // A first-time advance resumes nothing.
  const fresh = mount()
  const first = await advance(fresh.routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(first.body.data.changed, true)
  assert.equal(first.body.data.resumed, false)
  assert.equal(fresh.auditAppends[0].detail.notificationOwed, false)
}

// --- G6: a hop whose notice can never be sent leaves a record ---------------------------------

async function g6ASupersededOwedNotificationIsRecorded() {
  // RC1's recovery is real but NARROW: the same handler, before the chain moves on. When a
  // co-handler advances first, their claim moves `notified_step_index` past the owed hop and the
  // claim is monotonic, so that ping can never be sent by anyone. Until now nothing recorded it —
  // 「谁该被通知却没被通知」 was unanswerable after the fact.
  const db = makeMemoryDb()
  const notifier = makeNotifierSpy()
  const { routes, auditAppends } = mount({ db, notifier })
  // Hop 0 moved the cursor but its notification was never claimed (the interrupted request).
  db.rows.push({
    id: 'handoff-superseded',
    tenant_id: TENANT_ID,
    project_no: PROJECT,
    step_index: 1,
    notified_step_index: null,
    updated_by: ZHANG,
  })
  // LI, who was never told it was his turn, advances anyway.
  const res = await advance(routes, OPERATOR_LI, { fromStepKey: 'process' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.changed, true)
  assert.equal(res.body.data.notifyOutcome, 'sent', 'LI\u2019s own hop IS announced')
  assert.equal(notifier.calls.length, 1)

  const lost = auditAppends.filter((entry) => entry.mode === 'notification_lost')
  assert.equal(lost.length, 1, 'G6: the hop whose notice can never be sent leaves exactly one row')
  assert.equal(lost[0].action, 'handoff_advance', 'G6: inside the closed action vocabulary')
  assert.equal(lost[0].subjectId, 'prep_entry', 'G6: named by the STEP whose notice was lost')
  assert.equal(lost[0].detail.operation, 'handoff_notification_lost')
  assert.equal(lost[0].detail.lostStepIndex, 0)
  assert.equal(lost[0].projectId, PROJECT)
  // The advance row itself is still written, and still says what the store did.
  assert.equal(auditAppends.filter((entry) => entry.mode === 'advanced').length, 1)
}

async function g6NoLostRowWhenEveryHopWasNotified() {
  const { routes, auditAppends } = mount()
  await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  await advance(routes, OPERATOR_LI, { fromStepKey: 'process' })
  assert.deepEqual(auditAppends.filter((entry) => entry.mode === 'notification_lost'), [])
}

async function g6NoLostRowOnATurnStateOnlyChain() {
  // A chain with no destinations never notifies at all; every hop is "un-notified" and none is lost.
  const config = { [HANDOFF_CONFIG_KEY]: { tenantId: TENANT_ID, steps: STEPS3 } }
  const { routes, auditAppends } = mount({ config })
  await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  await advance(routes, OPERATOR_LI, { fromStepKey: 'process' })
  assert.deepEqual(auditAppends.filter((entry) => entry.mode === 'notification_lost'), [])
}

async function g6TheStatusReadSurfacesTheGap() {
  // The workbench cannot render what the payload does not carry. `notificationsConfigured` is the
  // half that keeps a turn-state-only deployment from reading its permanent null as a lost notice.
  const db = makeMemoryDb()
  const { routes } = mount({ db })
  db.rows.push({ id: 'h', tenant_id: TENANT_ID, project_no: PROJECT, step_index: 2, notified_step_index: 0, updated_by: ZHANG })
  const withDestinations = await status(routes, OPERATOR_ZHANG)
  assert.equal(withDestinations.body.data.stepIndex, 2)
  assert.equal(withDestinations.body.data.notifiedStepIndex, 0)
  assert.equal(withDestinations.body.data.notificationsConfigured, true)

  const db2 = makeMemoryDb()
  const turnOnly = mount({ config: { [HANDOFF_CONFIG_KEY]: { tenantId: TENANT_ID, steps: STEPS3 } }, db: db2 })
  db2.rows.push({ id: 'h', tenant_id: TENANT_ID, project_no: PROJECT, step_index: 2, notified_step_index: null, updated_by: ZHANG })
  const seen = await status(turnOnly.routes, OPERATOR_ZHANG)
  assert.equal(seen.body.data.notificationsConfigured, false, 'G6: so the page does not cry wolf')
}

// --- G7: a foreign tenant learns nothing about somebody else's chain --------------------------

async function g7AForeignTenantGetsTheSameAnswerAsAnUnconfiguredDeployment() {
  // The status route was written to hide it — `configured: false`, render nothing. The advance route
  // undid that with one POST: 403 CHAIN_NOT_FOR_THIS_TENANT versus 501 NOT_CONFIGURED separates
  // "there is a 备料 chain here and it is not yours" from "there is none", which is a one-bit
  // cross-tenant configuration disclosure the sibling route exists to prevent.
  const bound = chainConfig()
  bound[HANDOFF_CONFIG_KEY].tenantId = OTHER_TENANT
  const foreign = mount({ config: bound })
  const unconfigured = mount({ config: {} })

  const a = await advance(foreign.routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  const b = await advance(unconfigured.routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(a.statusCode, b.statusCode)
  assert.deepEqual(
    a.body,
    b.body,
    'G7: the two answers are byte-identical, so a POST tells a foreign tenant nothing a GET would not',
  )
  assert.equal(a.body.error.code, 'STOCK_PREPARATION_HANDOFF_NOT_CONFIGURED')
  assert.deepEqual(foreign.db.rows, [])
  assert.deepEqual(foreign.auditAppends, [])
  assert.equal(foreign.notifier.calls.length, 0)
  assert.equal(foreign.records.queries.length, 0)

  // The status route's answers match too — that was always the point.
  const sa = await status(foreign.routes, OPERATOR_ZHANG)
  const sb = await status(unconfigured.routes, OPERATOR_ZHANG)
  assert.deepEqual(sa.body, sb.body)

  // And the tenant the chain belongs to is served.
  const ownerDb = makeMemoryDb()
  const owner = mount({ config: bound, db: ownerDb })
  const zhangThere = { id: ZHANG, tenantId: OTHER_TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] }
  const ok = await call(owner.routes, 'POST', ADVANCE_PATH, {
    user: zhangThere,
    body: { projectNo: PROJECT, fromStepKey: 'prep_entry' },
  })
  assert.equal(ok.statusCode, 200)
}

// --- G8: the outcome/copy guard must see the ROUTE, not only the dispatcher --------------------

async function j8TheScrapedLiteralsAreAllMembersOfTheClosedVocabulary() {
  // The static half of J8: any outcome-shaped literal reachable into `notifyOutcome` must be a member
  // of the frozen set. A new one introduced directly reds HERE; one introduced through a variable
  // reds at the runtime assertion instead (j2TheWireOutcomeIsAlwaysInTheClosedVocabulary). Between
  // them there is no way to put a wordless outcome on the wire.
  const fs = require('node:fs')
  const source = fs.readFileSync(path.join(LIB, 'http-routes.cjs'), 'utf8')
  const scraped = collectHandoffNotifyOutcomes(source)
  assert.ok(scraped.length >= 4, 'J8: a scrape that came back empty would make this vacuous')
  for (const outcome of scraped) {
    assert.ok(
      STOCK_PREP_HANDOFF_NOTIFY_OUTCOMES.includes(outcome),
      `J8: '${outcome}' is assigned to notifyOutcome but is not in the closed vocabulary`,
    )
  }
  // And a direct mutation is still caught statically, which is the cheap half of the guarantee.
  const mutated = source.replace(
    "let notifyOutcome = hopHasDestination ? 'skipped' : 'no_destination'",
    "let notifyOutcome = hopHasDestination ? 'skipped' : 'no_destination'\n      if (terminal) notifyOutcome = 'deferred'",
  )
  assert.notEqual(mutated, source, 'J8: the mutation anchor still exists')
  assert.ok(
    collectHandoffNotifyOutcomes(mutated).includes('deferred'),
    'J8: a new route-level literal is seen by the scrape',
  )
}

async function g8TheOutcomeGuardScrapesTheRouteToo() {
  // RC4's guard sliced only `dispatchStockPreparationHandoffNotification` and then hand-typed the one
  // route-level value it knew about (`.concat(['skipped'])`). A reachable route-level outcome with no
  // copy therefore left the whole suite green — the same hand-kept-list failure this PR had already
  // fixed once, in platform-app-registry's P-03.
  const fs = require('node:fs')
  const source = fs.readFileSync(path.join(LIB, 'http-routes.cjs'), 'utf8')
  const outcomes = collectHandoffNotifyOutcomes(source)
  for (const expected of STOCK_PREP_HANDOFF_NOTIFY_OUTCOMES) {
    assert.ok(outcomes.includes(expected), `G8: the derivation finds '${expected}'`)
  }
  assert.ok(outcomes.length >= 5, 'G8: a scrape that came back empty would make this vacuous')
  // Every one of them has copy — derived, never typed here.
  const plainPath = path.join(
    __dirname, '..', '..', '..',
    'apps', 'web', 'src', 'services', 'integration', 'stockPreparation', 'plainLanguage.ts',
  )
  const table = fs.readFileSync(plainPath, 'utf8')
  const start = table.indexOf('STOCK_PREP_HANDOFF_OUTCOME_PLAIN: Record')
  assert.ok(start > 0)
  const copy = table.slice(start, table.indexOf(String.fromCharCode(10) + 'export ', start))
  for (const outcome of outcomes) {
    assert.ok(copy.includes(`${outcome}: Object.freeze(`), `G8: outcome '${outcome}' has plain-language copy`)
  }
  // The derivation really does read the ROUTE: a route-level literal the dispatcher never returns is
  // still collected. (This is the mutation the recheck used, asserted directly rather than by hand.)
  const mutated = source.replace(
    "let notifyOutcome = hopHasDestination ? 'skipped' : 'no_destination'",
    "let notifyOutcome = hopHasDestination ? 'skipped' : 'no_destination'\n      if (terminal) notifyOutcome = 'deferred'",
  )
  assert.notEqual(mutated, source, 'G8: the mutation anchor still exists')
  assert.ok(
    collectHandoffNotifyOutcomes(mutated).includes('deferred'),
    'G8: a NEW route-level outcome is seen by the derivation, so a missing copy entry reds this suite',
  )
}


// --- G2: the UI witness must actually RUN in the required gate --------------------------------

async function g2TheWebWitnessesAreEnrolledInTheRequiredGate() {
  // A 578-line spec that no CI job selects is not a guarantee, it is a file. The required `web-tests`
  // gate runs a hand-curated substring filter (apps/web/scripts/run-required-web-tests.sh), and this
  // feature's two web witnesses matched no token in it — including the one both workbench-access
  // mirrors point at, in writing, as the place the handoff controls' visibility is covered.
  //
  // Asserted from HERE, in the always-chained plugin suite, so the enrolment cannot be dropped in a
  // later refactor without something red.
  const fs = require('node:fs')
  const gate = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'apps', 'web', 'scripts', 'run-required-web-tests.sh'),
    'utf8',
  )
  const execLine = gate.split(String.fromCharCode(10)).find((line) => line.startsWith('exec npx vitest run '))
  assert.ok(execLine, 'G2: the required gate still runs vitest with a token filter')
  const tokens = execLine.slice('exec npx vitest run '.length).split(/\s+/).filter((t) => t && !t.startsWith('--'))
  const webDir = path.join(__dirname, '..', '..', '..', 'apps', 'web', 'tests')
  for (const spec of ['StockPreparationHandoff.spec.ts', 'stockPreparationConfirmationQueue.spec.ts']) {
    assert.ok(fs.existsSync(path.join(webDir, spec)), `G2: ${spec} exists`)
    const matched = tokens.filter((token) => `tests/${spec}`.includes(token))
    assert.ok(
      matched.length > 0,
      `G2: ${spec} is selected by NO token in the required web-tests gate — it would run in no CI job`,
    )
  }
}

// --- G9: the comments that are the contract must say what the code does -----------------------

async function g9TheCommittedProseMatchesTheCodeItDescribes() {
  // This PR's review posture is that the long comments ARE the contract. Round 2 changed two
  // properties — the schema key lost `workspace_id`, and the notification claim left the advance
  // transaction — and six committed statements still described the old behaviour, in the very files
  // that implement the new one. A reader debugging a 23505 was pointed at a key shape that does not
  // exist; a reader of the design record was told the claim rides a transaction it no longer rides.
  const fs = require('node:fs')
  const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8')
  const store = read('lib', 'stock-preparation-handoff-store.cjs')
  const handoff = read('lib', 'stock-preparation-handoff.cjs')
  const index = read('index.cjs')
  const scope = read('lib', 'stock-preparation-operator-scope.cjs')
  const migrationsDir = path.join(__dirname, '..', '..', '..', 'packages', 'core-backend', 'migrations')
  const migration = fs.readFileSync(path.join(migrationsDir, '084_create_integration_stock_prep_handoff.sql'), 'utf8')
  const vocabulary = fs.readFileSync(path.join(migrationsDir, '085_extend_stock_prep_audit_handoff_action.sql'), 'utf8')

  // (a) the scope key, in the file that routes 23505 on it
  assert.ok(!store.includes("COALESCE(workspace_id,'')"), 'G9: the store no longer documents a column 084 does not create')
  assert.ok(store.includes('(tenant_id, project_no)'), 'G9: and names the index that actually exists')
  // (b) advance()'s return shape
  assert.ok(!store.includes('{ handoff, changed, notifyClaimed }'), 'G9: advance() no longer advertises a field it does not return')
  // (c) the claim is a separate CAS — in the migration and in the design record
  for (const [label, src] of [['migration 084', migration], ['stock-preparation-handoff.cjs', handoff]]) {
    assert.ok(
      !/stamped in the same transaction as the (cursor move|advance)/.test(src),
      `G9: ${label} no longer says the claim rides the advance transaction`,
    )
    assert.ok(/claimNotification/.test(src), `G9: ${label} points at where the claim actually lives`)
  }
  // (d) the wiring site's migration number and scope
  assert.ok(!index.includes('通知下一步 (migration 082)'), 'G9: index.cjs names the migration that creates the table')
  assert.ok(index.includes('migration 084'), 'G9: which is 084')
  assert.ok(!/per-\(tenant,\s*workspace,\s*projectNo\) cursor/.test(index), 'G9: and the post-RC3 scope')
  // (e) J7 — 085's header is the ONLY place the `mode` vocabulary is written down. `mode` carries no
  // CHECK constraint (066), so unlike `action` there is no schema to read it off and no migration
  // test that can set-compare it; a stale sentence there is the whole of the documentation being
  // wrong. Derived from the ROUTE, the way G8 derives notifyOutcome, so it cannot go stale silently.
  const routeSrc = read('lib', 'http-routes.cjs')
  const advanceBody = (() => {
    const start = routeSrc.indexOf('async stockPreparationHandoffAdvance(req, res) {')
    return routeSrc.slice(start, routeSrc.indexOf(String.fromCharCode(10) + '    },' + String.fromCharCode(10), start))
  })()
  const modes = new Set()
  for (const line of advanceBody.match(/mode:.*/g) || []) {
    for (const m of line.matchAll(/'([a-z_]+)'/g)) modes.add(m[1])
  }
  // The ternary form `mode: applied.changed ? (terminal ? 'completed' : 'advanced') : 'replayed'`
  // yields three on one line; `notification_lost` is its own.
  assert.ok(modes.size >= 4, `J7: the mode derivation found only ${[...modes].join(',')}`)
  for (const mode of modes) {
    assert.ok(vocabulary.includes(mode), `J7: migration 085 names the '${mode}' audit mode it documents`)
  }
  assert.ok(!vocabulary.includes('advanced|replayed|completed;'), 'J7: and no longer names only three')
  // The two real detail shapes, keyed off what the route actually writes.
  for (const key of ['notificationOwed', 'lostStepIndex', 'operation']) {
    assert.ok(vocabulary.includes(key), `J7: 085 documents the '${key}' detail key the route writes`)
  }
  for (const gone of ['/ changed / notified /']) {
    assert.ok(!vocabulary.includes(gone), `J7: and no longer lists detail keys the route never writes (${gone})`)
  }

  // (f) the operator-scope header's own contract, which every future surface is told to obey
  assert.ok(!scope.includes('exactly three'), 'G9: the scope header no longer claims a set of three')
  assert.ok(
    !/It does NOT authorize a WRITE\./.test(scope),
    'G9: nor forbids the exact use the advance route now makes of it',
  )
  const callSites = (read('lib', 'http-routes.cjs').match(/resolveOperatorValueScope\(\{/g) || []).length
  // 项目备料页 added two: the board read and the project directory read. W3a added a ninth — the
  // dry-run's opt-in missing-component list. The count is the whole point of the assertion — a new
  // surface deciding tenancy on its own must show up HERE, as a failure, rather than quietly
  // becoming the nth thing the header does not mention.
  assert.equal(callSites, 9, 'G9: nine call sites — if this changes, the header list must too')
  for (const marker of ['stockPreparationHandoffStatus', 'stockPreparationHandoffAdvance', 'stockPreparationOperatorProjectBoard', 'tableActionDryRun']) {
    assert.ok(scope.includes(marker), `G9: the header enumerates ${marker}`)
  }
}


// ---------------------------------------------------------------------------
// J1..J8 — the round-3 closing recheck (10 confirmed, 0 refuted).
// ---------------------------------------------------------------------------

/**
 * J1 — DRIVE THE REAL LOSS, NEVER HAND-SEED IT.
 *
 * The G6 witnesses seeded `{step_index: 2, notified_step_index: 0}` and called it "the gap". That is
 * the state where the TAIL hop is unclaimed — i.e. exactly the state RC1 makes recoverable by the
 * same handler's next click. The state the lost-row loop actually produces is different and the store
 * has to be walked into it: an advance whose audit failed (cursor moves, claim unspent), and then a
 * DIFFERENT handler advancing past it.
 *
 * Returns the mount plus the two states, so the witnesses below assert on something the store built.
 */
async function driveASupersededLostHop() {
  let auditWorks = true
  const auditAppends = []
  const notifier = makeNotifierSpy()
  const db = makeMemoryDb()
  const routes = new Map()
  const context = {
    api: {
      http: { addRoute(m, rp, h) { routes.set(`${m.toUpperCase()} ${rp}`, h) } },
      multitable: { provisioning: inertService(['resolveFieldIds']), records: makeRecordsApi() },
    },
    storage: new Map(),
    config: { ...chainConfig(), stockPreparationTableActions: [tableActionConfig()] },
  }
  const services = baseServices()
  services.stockPreparationAuditStore = {
    async append(entry) {
      if (!auditWorks) {
        const error = new Error('audit ledger unavailable')
        error.status = 422
        throw error
      }
      auditInternals.assertValuesFreeDetail(entry.detail)
      auditAppends.push(entry)
      return { ok: true }
    },
    async supportsAction() { return { supported: true, reason: 'check_constraint_accepts' } },
    // The status read reads the trail back for the lost hops — the append-only rows ARE the record.
    async list({ projectId }) {
      return {
        rowCount: auditAppends.length,
        entries: auditAppends.filter((e) => e.projectId === projectId).slice().reverse(),
      }
    },
  }
  services.stockPreparationHandoffStore = createStockPreparationHandoffStore({ db, idGenerator: () => 'handoff-1' })
  services.stockPreparationHandoffNotifier = notifier
  services.tenantPrincipalDirectory = vouchingTenantDirectory()
  httpRoutes.registerIntegrationRoutes({ context, services, logger: { info() {}, warn() {}, error() {} } })

  // 1. ZHANG hands off prep_entry; the trail write fails, so the cursor moves and the claim is unspent.
  auditWorks = false
  const interrupted = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(interrupted.statusCode, 422)
  assert.equal(db.rows[0].step_index, 1)
  assert.equal(db.rows[0].notified_step_index, null)
  assert.equal(notifier.calls.length, 0)

  // 2. The RESENDABLE state: the tail hop is hop 0 and ZHANG is its handler.
  auditWorks = true
  const resendable = await status(routes, OPERATOR_ZHANG)

  // 3. LI — a DIFFERENT handler, who was never told it was his turn — advances anyway. His claim for
  //    hop 1 moves the monotonic max past hop 0, which is the moment hop 0 becomes irreversible.
  const superseding = await advance(routes, OPERATOR_LI, { fromStepKey: 'process' })
  assert.equal(superseding.statusCode, 200)
  assert.equal(db.rows[0].notified_step_index, 1)
  const lost = await status(routes, OPERATOR_ZHANG)

  return { routes, db, notifier, auditAppends, resendable, lost }
}

async function j1TheResendableHopInvitesTheClickAndTheLostOneDoesNot() {
  const { resendable, lost, auditAppends, notifier, routes, db } = await driveASupersededLostHop()

  // THE RESENDABLE STATE. G6 fired its "can never be resent" banner on exactly this, discouraging the
  // one click that fixes it.
  assert.equal(resendable.body.data.stepIndex, 1)
  assert.equal(resendable.body.data.notifiedStepIndex, null)
  assert.equal(resendable.body.data.resendableStepKey, 'prep_entry', 'J1: the tail hop is still sendable, and by this caller')
  assert.deepEqual(resendable.body.data.lostStepKeys, [], 'J1: and nothing is lost yet')

  // THE LOST STATE, produced by the store rather than seeded. This is what the notification_lost row
  // describes, and G6 was silent for it.
  assert.equal(lost.body.data.stepIndex, 2)
  assert.equal(lost.body.data.notifiedStepIndex, 1)
  assert.deepEqual(lost.body.data.lostStepKeys, ['prep_entry'], 'J1: hop 0 can never be announced now')
  assert.equal(lost.body.data.resendableStepKey, null, 'J1: and there is nothing left to invite a click for')
  assert.equal(auditAppends.filter((e) => e.mode === 'notification_lost').length, 1)

  // The invitation is honest: ZHANG pressing again really does send it.
  const fresh = await driveASupersededLostHop.call(null)
  void fresh
  const again = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(again.statusCode, 409, 'J1: once superseded even the handler is refused — which is why it is LOST, not resendable')
  assert.equal(notifier.calls.length, 1, 'only LI\u2019s own hop was ever announced')
  assert.equal(db.rows.length, 1)
}

async function j1PressingAgainInTheResendableStateActuallySendsIt() {
  // The other half: BEFORE anyone supersedes it, the invitation is actionable and the click works.
  let auditWorks = true
  const auditAppends = []
  const notifier = makeNotifierSpy()
  const db = makeMemoryDb()
  const routes = new Map()
  const context = {
    api: {
      http: { addRoute(m, rp, h) { routes.set(`${m.toUpperCase()} ${rp}`, h) } },
      multitable: { provisioning: inertService(['resolveFieldIds']), records: makeRecordsApi() },
    },
    storage: new Map(),
    config: { ...chainConfig(), stockPreparationTableActions: [tableActionConfig()] },
  }
  const services = baseServices()
  services.stockPreparationAuditStore = {
    async append(entry) {
      if (!auditWorks) { const e = new Error('audit down'); e.status = 422; throw e }
      auditInternals.assertValuesFreeDetail(entry.detail)
      auditAppends.push(entry)
      return { ok: true }
    },
    async supportsAction() { return { supported: true } },
    async list() { return { rowCount: 0, entries: [] } },
  }
  services.stockPreparationHandoffStore = createStockPreparationHandoffStore({ db, idGenerator: () => 'h-1' })
  services.stockPreparationHandoffNotifier = notifier
  services.tenantPrincipalDirectory = vouchingTenantDirectory()
  httpRoutes.registerIntegrationRoutes({ context, services, logger: { info() {}, warn() {}, error() {} } })

  auditWorks = false
  await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  auditWorks = true
  const invited = await status(routes, OPERATOR_ZHANG)
  assert.equal(invited.body.data.resendableStepKey, 'prep_entry')

  const resent = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(resent.statusCode, 200)
  assert.equal(resent.body.data.resumed, true, 'J1: the invitation was true — this click completed the owed hop')
  assert.equal(resent.body.data.notifyOutcome, 'sent')
  assert.equal(notifier.calls.length, 1)
  const after = await status(routes, OPERATOR_ZHANG)
  assert.equal(after.body.data.resendableStepKey, null, 'J1: and the invitation is withdrawn once it is done')
  assert.deepEqual(after.body.data.lostStepKeys, [])
}

async function j1TheInvitationIsOnlyShownToTheHandlerWhoCanAct() {
  // `planStockPreparationHandoffAdvance` checks the roster of the step being REPLAYED, so inviting
  // anybody else to press would be inviting them into a 403.
  let auditWorks = true
  const db = makeMemoryDb()
  const routes = new Map()
  const context = {
    api: {
      http: { addRoute(m, rp, h) { routes.set(`${m.toUpperCase()} ${rp}`, h) } },
      multitable: { provisioning: inertService(['resolveFieldIds']), records: makeRecordsApi() },
    },
    storage: new Map(),
    config: { ...chainConfig(), stockPreparationTableActions: [tableActionConfig()] },
  }
  const services = baseServices()
  services.stockPreparationAuditStore = {
    async append(entry) {
      if (!auditWorks) { const e = new Error('audit down'); e.status = 422; throw e }
      auditInternals.assertValuesFreeDetail(entry.detail)
      return { ok: true }
    },
    async supportsAction() { return { supported: true } },
    async list() { return { rowCount: 0, entries: [] } },
  }
  services.stockPreparationHandoffStore = createStockPreparationHandoffStore({ db, idGenerator: () => 'h-1' })
  services.stockPreparationHandoffNotifier = makeNotifierSpy()
  services.tenantPrincipalDirectory = vouchingTenantDirectory()
  httpRoutes.registerIntegrationRoutes({ context, services, logger: { info() {}, warn() {}, error() {} } })

  auditWorks = false
  await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  auditWorks = true
  assert.equal((await status(routes, OPERATOR_ZHANG)).body.data.resendableStepKey, 'prep_entry')
  for (const other of [OPERATOR_LI, OPERATOR_WANG, READ_ONLY, PLATFORM_ADMIN]) {
    const seen = await status(routes, other)
    assert.equal(seen.body.data.resendableStepKey, null, `J1: ${other.id} cannot resend hop 0, so is not invited to try`)
  }
}

async function j1ATurnStateOnlyChainInvitesNothingAndLosesNothing() {
  const config = { [HANDOFF_CONFIG_KEY]: { tenantId: TENANT_ID, steps: STEPS3 } }
  const { routes } = mount({ config })
  await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  const seen = await status(routes, OPERATOR_ZHANG)
  assert.equal(seen.body.data.notificationsConfigured, false)
  assert.equal(seen.body.data.resendableStepKey, null, 'J1: nothing to resend on a chain that sends nothing')
  assert.deepEqual(seen.body.data.lostStepKeys, [])
}

// --- J2: two different facts, two different sentences ------------------------------------------

async function j2AConfiguredChainWithNoDestinationSaysSoWithoutBlamingTheAdmin() {
  // A multi-step chain declaring neither `notify` nor `terminal` is LEGAL — the turn-state-only
  // deployment. It used to answer `not_configured` on a SUCCESSFUL advance, whose copy tells the
  // operator the deployment has no chain and an admin must set one up, on a screen whose button only
  // renders because the chain IS configured.
  const config = { [HANDOFF_CONFIG_KEY]: { tenantId: TENANT_ID, steps: STEPS3 } }
  const { routes, db } = mount({ config })
  const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.changed, true, 'the turn really did move')
  assert.equal(res.body.data.notifyOutcome, 'no_destination', 'J2: and the word for that is not "no chain configured"')
  assert.equal(db.rows[0].notified_step_index, null, 'J2: no destination means no claim spent')
}

async function j2TheWireOutcomeIsAlwaysInTheClosedVocabulary() {
  // J8's runtime half: an outcome outside the frozen set never reaches the caller, however it got
  // assigned. A text scrape could be escaped by one indirection; this cannot.
  const { routes } = mount()
  const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.ok(
    STOCK_PREP_HANDOFF_NOTIFY_OUTCOMES.includes(res.body.data.notifyOutcome),
    'J8: the wire value is a member of the closed vocabulary',
  )
  assert.throws(
    () => assertStockPreparationHandoffNotifyOutcome('deferred'),
    (error) => error.status === 500 && error.code === 'STOCK_PREPARATION_HANDOFF_OUTCOME_INVALID',
    'J8: and a value that never joined the vocabulary is refused rather than shipped',
  )
  // Every member has plain-language copy — derived from the CONSTANT, not from a scrape of the route.
  const fs = require('node:fs')
  const table = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'apps', 'web', 'src', 'services', 'integration', 'stockPreparation', 'plainLanguage.ts'),
    'utf8',
  )
  const start = table.indexOf('STOCK_PREP_HANDOFF_OUTCOME_PLAIN: Record')
  const copy = table.slice(start, table.indexOf(String.fromCharCode(10) + 'export ', start))
  for (const outcome of STOCK_PREP_HANDOFF_NOTIFY_OUTCOMES) {
    assert.ok(copy.includes(`${outcome}: Object.freeze(`), `J8: outcome '${outcome}' has plain-language copy`)
  }
  // And the copy table carries nothing the route can no longer produce.
  for (const stale of [...copy.matchAll(/\n  ([a-z_]+): Object\.freeze\(/g)].map((m) => m[1])) {
    assert.ok(
      STOCK_PREP_HANDOFF_NOTIFY_OUTCOMES.includes(stale),
      `J8: the copy table carries '${stale}', which the route cannot return — set-equality, both ways`,
    )
  }
}

// --- J3: an absent notifier seam may not spend the claim ---------------------------------------

async function j3AnAbsentNotifierLeavesTheHopClaimableForALaterDeployment() {
  // The seam is documented OPTIONAL. With destinations configured and no notifier wired, the claim
  // used to fire anyway and the hop became permanently unnotifiable — and because `applied.changed`
  // is true the lost-row loop never saw it either, so it left no trace at all.
  const db = makeMemoryDb()
  const { routes, auditAppends } = mount({ db, notifier: null })
  const res = await advance(routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.changed, true, 'the turn still moves — turn state and notification are separate concerns')
  assert.equal(res.body.data.notifyOutcome, 'no_destination')
  assert.equal(db.rows[0].notified_step_index, null, 'J3: the claim is NOT spent on a hop nothing could have sent')
  assert.equal(auditAppends.filter((e) => e.mode === 'notification_lost').length, 0, 'and nothing is lost, because nothing is gone')

  // THE POINT OF LEAVING IT UNCLAIMED: a deployment that wires the seam tomorrow can still announce it.
  const wired = makeNotifierSpy()
  const later = mount({ db, notifier: wired })
  const resent = await advance(later.routes, OPERATOR_ZHANG, { fromStepKey: 'prep_entry' })
  assert.equal(resent.body.data.notifyOutcome, 'sent', 'J3: yesterday\u2019s hop is still announceable today')
  assert.equal(resent.body.data.resumed, true)
  assert.equal(wired.calls.length, 1)
  assert.equal(db.rows[0].notified_step_index, 0)
}

// --- J4: both routes refuse in the same order --------------------------------------------------

async function j4AScopeFailingCallerCannotTellAConfiguredDeploymentFromAnUnconfiguredOne() {
  // The advance route checked the chain BEFORE the scope while the status route did the opposite, so
  // a caller whose scope cannot resolve got 501 on a deployment with no chain and 403 on one that has
  // one — learning, from the difference alone, that a 备料 chain exists here.
  const tenantless = { id: 'u_admin', permissions: ['role:admin', 'integration:admin'] }
  const configured = mount()
  const unconfigured = mount({ config: {} })
  for (const [method, routePath, payload] of [
    ['POST', ADVANCE_PATH, { body: { projectNo: PROJECT, fromStepKey: 'prep_entry' } }],
    ['GET', STATUS_PATH, { query: { projectNo: PROJECT } }],
  ]) {
    const a = await call(configured.routes, method, routePath, { user: tenantless, ...payload })
    const b = await call(unconfigured.routes, method, routePath, { user: tenantless, ...payload })
    assert.equal(a.statusCode, 403, `J4: ${method} refuses the principal first`)
    assert.deepEqual(a.body, b.body, `J4: ${method} answers identically whether or not a chain exists`)
    assert.equal(a.body.error.code, 'OPERATOR_SCOPE_TENANT_REQUIRED')
  }
  assert.deepEqual(configured.db.rows, [])
  assert.deepEqual(configured.auditCalls, [], 'J4: and the refusal still costs no audit call')
  assert.equal(configured.records.queries.length, 0)
}

// --- J5: the inert payload is complete ---------------------------------------------------------

async function j5TheInertStatusPayloadCarriesEveryDeclaredKey() {
  const unconfigured = mount({ config: {} })
  const bound = chainConfig()
  bound[HANDOFF_CONFIG_KEY].tenantId = OTHER_TENANT
  const foreign = mount({ config: bound })
  const INERT = Object.freeze({
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
    notificationsConfigured: false,
    resendableStepKey: null,
    lostStepKeys: [],
  })
  for (const [label, mounted] of [['unconfigured', unconfigured], ['foreign tenant', foreign]]) {
    const res = await status(mounted.routes, OPERATOR_ZHANG)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body.data, INERT, `J5: the ${label} payload is field-for-field the inert one`)
  }
  // And the CONFIGURED branch declares the same key set, so the two cannot drift apart again.
  const live = await status(mount().routes, OPERATOR_ZHANG)
  assert.deepEqual(
    Object.keys(live.body.data).sort(),
    Object.keys(INERT).sort(),
    'J5: both branches return the same keys',
  )
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
    ['F1 two concurrent claims take the notification exactly once', f1TwoConcurrentClaimsTakeTheNotificationOnce],
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
    // --- third round: the post-rebase recheck, RC1..RC7 -----------------------------------------
    ['RC1 an audit failure leaves the claim unspent and the hop recoverable', rc1AnAuditFailureLeavesTheClaimUnspentAndTheHopRecoverable],
    ['RC1 a missing audit vocabulary is a named 503 before any write', rc1AMissingAuditVocabularyIsANamed503BeforeAnyWrite],
    ['RC2 a header-steered tenant cannot reach another tenant\'s chain', rc2AHeaderSteeredTenantCannotReachAnotherTenantsChain],
    ['RC2 a header contradicting the verified claim is refused on both routes', rc2AHeaderThatContradictsTheVerifiedClaimIsRefusedOnBothRoutes],
    ['RC2 a tenantless principal is refused on both routes', rc2ATenantlessPrincipalIsRefusedOnBothRoutes],
    ['RC2 an absent host directory fails closed on both routes', rc2AnAbsentHostDirectoryFailsClosedOnBothRoutes],
    ['RC3 workspaceId cannot multiply the cursor or the notification', rc3WorkspaceIdCannotMultiplyTheCursorOrTheNotification],
    ['RC4 a partial terminal fan-out is not reported as sent', rc4APartialTerminalFanOutIsNotReportedAsSent],
    ['RC4 every outcome the route can return has copy', rc4EveryOutcomeTheRouteCanReturnHasCopy],
    ['RC5 the audit mode comes from the committed verdict, not the plan', rc5TheAuditModeComesFromTheCommittedVerdictNotThePlan],
    ['RC6 a non-handler cannot tell an existing project from an unknown one', rc6ANonHandlerCannotTellAnExistingProjectFromAnUnknownOne],
    ['RC7 a tenant-bound chain refuses every other tenant', rc7ATenantBoundChainRefusesEveryOtherTenant],
    // --- round 2: lane B's three findings on the RC fixes ---------------------------------------
    ['F1 a chain without a tenantId is refused, not deploy-global', f1AChainWithoutATenantIdIsRefusedRatherThanDeployGlobal],
    ['F1 the dual-org header repro cannot announce across tenants', f1TheDualOrgHeaderReproCannotAnnounceAcrossTenants],
    ['F1 the code cites no contract it does not carry', f1TheCodeCitesNoContractItDoesNotCarry],
    ['F2 the audit-vocabulary probe runs AFTER the tenant scope', f2TheAuditVocabularyProbeRunsAfterTheTenantScope],
    ['F2 a permitted caller still probes once, under its own tenant', f2ThePermittedCallerStillProbesOnceAndUnderItsOwnTenant],
    // --- round 2, lanes A and C ------------------------------------------------------------------
    ['G3 an unconfigured deployment never touches the audit table', g3AnUnconfiguredDeploymentNeverTouchesTheAuditTable],
    ['G3 the store and chain checks precede every audit call', g3TheStoreAndChainChecksPrecedeEveryAuditCall],
    ['G4 the vocabulary probe recovers when the migration is applied', g4TheVocabularyProbeRecoversWhenTheMigrationIsApplied],
    ['G5 the trail never claims to have finished a hop it did not claim', g5TheTrailNeverClaimsToHaveFinishedAHopItDidNotClaim],
    ['G5 a genuine resume reports resumed on the response', g5AGenuineResumeReportsResumedOnTheResponse],
    ['G6 a superseded owed notification is recorded', g6ASupersededOwedNotificationIsRecorded],
    ['G6 no lost row when every hop was notified', g6NoLostRowWhenEveryHopWasNotified],
    ['G6 no lost row on a turn-state-only chain', g6NoLostRowOnATurnStateOnlyChain],
    ['G6 the status read surfaces the gap', g6TheStatusReadSurfacesTheGap],
    ['G7 a foreign tenant gets the same answer as an unconfigured deployment', g7AForeignTenantGetsTheSameAnswerAsAnUnconfiguredDeployment],
    ['G8 the outcome guard scrapes the route too', g8TheOutcomeGuardScrapesTheRouteToo],
    ['J8 the scraped literals are all members of the closed vocabulary', j8TheScrapedLiteralsAreAllMembersOfTheClosedVocabulary],
    ['G2 the web witnesses are enrolled in the required gate', g2TheWebWitnessesAreEnrolledInTheRequiredGate],
    ['G9 the committed prose matches the code it describes', g9TheCommittedProseMatchesTheCodeItDescribes],
    // --- round 3: the closing recheck ------------------------------------------------------------
    ['J1 the resendable hop invites the click and the lost one does not', j1TheResendableHopInvitesTheClickAndTheLostOneDoesNot],
    ['J1 pressing again in the resendable state actually sends it', j1PressingAgainInTheResendableStateActuallySendsIt],
    ['J1 the invitation is only shown to the handler who can act', j1TheInvitationIsOnlyShownToTheHandlerWhoCanAct],
    ['J1 a turn-state-only chain invites nothing and loses nothing', j1ATurnStateOnlyChainInvitesNothingAndLosesNothing],
    ['J2 a configured chain with no destination says so without blaming the admin', j2AConfiguredChainWithNoDestinationSaysSoWithoutBlamingTheAdmin],
    ['J2/J8 the wire outcome is always in the closed vocabulary', j2TheWireOutcomeIsAlwaysInTheClosedVocabulary],
    ['J3 an absent notifier leaves the hop claimable for a later deployment', j3AnAbsentNotifierLeavesTheHopClaimableForALaterDeployment],
    ['J4 a scope-failing caller cannot tell a configured deployment from an unconfigured one', j4AScopeFailingCallerCannotTellAConfiguredDeploymentFromAnUnconfiguredOne],
    ['J5 the inert status payload carries every declared key', j5TheInertStatusPayloadCarriesEveryDeclaredKey],
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
