'use strict'

// 通知下一步 (the handoff ADVANCE) — THE TARGET TENANT WALL BEFORE THE EXISTENCE PROBE (#6121).
//
// THE HOLE. Before it writes anything, the advance proves the project exists by probing the
// deployment-bound table-action target (`stockPreparationProjectHasMainRows` on `action.target`).
// That binding is DEPLOY-GLOBAL: `getTableAction` is keyed by actionId alone, so every tenant on the
// deployment probes the same sheet. The chain-for-tenant check proves the CHAIN is the caller's,
// never the SHEET — so a caller whose chain check passed, but whose sheet it is not, learned one bit
// per click ("does this project number have rows in that sheet": 404 versus 200), and on a 200 went
// on to write a cursor row and an audit row for that project number and send a DingTalk ping about
// it. The 结转 write and the 按项目导出物料 read (#6109) had already closed the same sheet with
// `assertStockPreparationTargetBelongsToTenant`; the advance had not.
//
// THE FIX IS NOT A NEW WALL. The advance now runs THAT wall — same function, same host port, same
// `decideCarryTargetOwnership` verdict — answering in its own STOCK_PREPARATION_HANDOFF_TARGET_*
// vocabulary, BEFORE the probe and therefore before every write. The chain policy
// (`requireStockPreparationHandoffChainForTenant`) is deliberately left exactly as it is: what a chain
// without a tenant should mean is an owner decision, and the wall must hold whatever that decision is.
//
// WHAT THIS SUITE PINS (each has a RED witness — see the PR body's mutation table):
//   HW-01 THE OWNER STILL ADVANCES. Chain bound to the tenant whose sheet it is: 200, one cursor row,
//         one audit row, one notification — and the wall RAN (registry asked about the caller's own
//         staging project), so the pass is the registry's proof, not the wall being skipped.
//   HW-02 A FOREIGN-OWNED TARGET IS REFUSED WITH ZERO SIDE EFFECTS. Chain bound to tenant B, bound sheet
//         owned by tenant A, tenant B's handler clicks: 409 STOCK_PREPARATION_HANDOFF_TARGET_TENANT_MISMATCH,
//         zero records reads, no cursor write, no audit row, no notification, values-free details.
//   HW-03 THE BIT ITSELF. A project number that exists in tenant A's sheet and one that exists nowhere
//         get byte-identical refusals and zero probes — the refusal cannot depend on the probe.
//   HW-04 THE CLAIMLESS SHAPE (the demo machine's), exactly as #6109's X-10: no verified claim on the
//         request, the tenant comes from user.tenantId and is vouched for by the host directory.
//         (a) the foreign tenant is still refused with zero side effects; (b) the owner still advances,
//         with the wall having run.
//   HW-05 A CHAIN WITHOUT A tenantId. The config parser refuses such a chain today (F1), so the state
//         is simulated by loading an isolated copy of the route module over a parser that strips the
//         tenant. `requireStockPreparationHandoffChainForTenant` then lets every tenant through —
//         unchanged, on purpose — and the WALL is what refuses the foreign one.
//   HW-06 THE x-tenant-id HEADER CANNOT MOVE THE WALL. A verified tenant-B request carrying a header that
//         names tenant A is refused: the wall asks about the VERIFIED tenant's project.
//   HW-07 THE REST OF THE VERDICT: a pre-registry install (derived id) still advances; another tenant's
//         derived id does not; an undecidable owner refuses with its own code.
//   HW-08 NO OWNERSHIP FACT IS NOT A PASS: a host without the port is a typed 501, a host whose port
//         throws is a non-2xx — both with zero side effects.
//   HW-09 ONE VERDICT, THREE VOCABULARIES: every refusing state maps into the handoff's own family and
//         never into the carry's or the export's.
//   HW-10 STRUCTURE: the advance handler calls the shared wall BEFORE the probe and every write, derives
//         the project it asks about from the resolved scope, and grows no private ownership check.
//   HW-11 THE REQUEST BODY CANNOT MOVE THE WALL EITHER. A verified tenant-B request whose body sets
//         `workspaceId` to tenant A's staging project is refused, and the registry is asked about tenant
//         B's staging project only. HW-10 pins the same property as source text; this pins it as
//         behaviour, so a wall that took its project from the request is red on what it DOES.
//
// Hermetic: no DB, no network, no DingTalk. The handoff store is the REAL one over an in-memory db;
// the audit store, the notifier, the records API, the host directory and the ownership port are spies.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const handoffModule = require(path.join(LIB, 'stock-preparation-handoff.cjs'))
const { HANDOFF_CONFIG_KEY, parseStockPreparationHandoffConfig } = handoffModule
const { HANDOFF_TABLE, createStockPreparationHandoffStore } = require(path.join(LIB, 'stock-preparation-handoff-store.cjs'))
const { STOCK_PREP_OPERATE, STOCK_PREP_READ } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const {
  CARRY_TARGET_OWNERSHIP_STATES,
  CARRY_TARGET_OWNERSHIP_REFUSAL_CODES,
  PREP_LINE_EXPORT_TARGET_OWNERSHIP_REFUSAL_CODES,
  STOCK_PREPARATION_HANDOFF_TARGET_OWNERSHIP_REFUSAL_CODES,
} = require(path.join(LIB, 'stock-preparation-target-provisioning.cjs'))
const { resolveOperatorValueScope } = require(path.join(LIB, 'stock-preparation-operator-scope.cjs'))
const { derivedSheetId } = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))

const MAIN_OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
const ADVANCE_PATH = '/api/integration/stock-preparation/handoff/advance'

// Synthetic handles only — no real tenant, sheet or project.
const TENANT_A = 'tenant-hw-a'
const TENANT_B = 'tenant-hw-b'
const STAGING_A = `${TENANT_A}:integration-core`
const STAGING_B = `${TENANT_B}:integration-core`

// A sheet tenant A's own ensure provisioned and the deployment was bound to BY HAND: its id is not the
// one derived for either tenant, so the ONLY thing attributing it to tenant A is the registry row.
const HAND_BOUND_SHEET = 'sheet_hw_hand_bound_by_tenant_a'

// A project number that HAS rows in tenant A's sheet, and one that exists nowhere.
const PROJECT_IN_A = 'PRJ-HW-A1'
const PROJECT_INVENTED = 'PRJ-HW-NONE'

const OPERATOR_A = Object.freeze({ id: 'u_hw_op_a', tenantId: TENANT_A, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const OPERATOR_B = Object.freeze({ id: 'u_hw_op_b', tenantId: TENANT_B, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
// Each operator belongs to exactly one tenant, so a refusal below is the WALL, never a scope refusal
// wearing its clothes.
const MEMBERSHIPS = Object.freeze({ u_hw_op_a: [TENANT_A], u_hw_op_b: [TENANT_B] })

const NOTIFY_DEST = 'dest-hw-next'
const WAREHOUSE_DEST = 'dest-hw-warehouse'
const PURCHASING_DEST = 'dest-hw-purchasing'

const TENANT_MISMATCH = 'STOCK_PREPARATION_HANDOFF_TARGET_TENANT_MISMATCH'
const OWNER_UNKNOWN = 'STOCK_PREPARATION_HANDOFF_TARGET_OWNER_UNKNOWN'
const PORT_UNAVAILABLE = 'STOCK_PREPARATION_HANDOFF_PROVISIONING_UNAVAILABLE'

let passed = 0
let failed = 0
async function run(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok - ${name}`)
  } catch (error) {
    failed += 1
    console.error(`not ok - ${name}\n    ${error && error.stack ? error.stack : error}`)
  }
}

// ---------------------------------------------------------------------------
// substrate
// ---------------------------------------------------------------------------

/**
 * The chain. Both operators are handlers of the first step on purpose: the handler gate must PASS for
 * the foreign caller, so that what refuses them below is the wall and nothing else.
 */
function chainConfig(tenantId) {
  return {
    [HANDOFF_CONFIG_KEY]: {
      tenantId,
      steps: [
        { key: 'prep_entry', handlerUserIds: [OPERATOR_A.id, OPERATOR_B.id] },
        { key: 'process', handlerUserIds: ['u_hw_process'] },
        { key: 'final_review', handlerUserIds: ['u_hw_final'] },
      ],
      notify: { groupDestinationId: NOTIFY_DEST },
      terminal: { groupDestinationIds: [WAREHOUSE_DEST, PURCHASING_DEST], exportPath: '/stock-prep?tab=confirmation-queue' },
    },
  }
}

/**
 * The in-memory db the REAL handoff store runs on. `writes` records every INSERT/UPDATE so "no cursor
 * row" is asserted on the writes themselves, not only on the resulting table.
 */
function makeMemoryDb() {
  const rows = []
  const writes = []
  function matches(row, where) {
    return Object.entries(where).every(([column, value]) => {
      const actual = row[column] === undefined ? null : row[column]
      return actual === (value === undefined ? null : value)
    })
  }
  const api = {
    rows,
    writes,
    async selectOne(table, where) {
      assert.equal(table, HANDOFF_TABLE)
      return rows.find((row) => matches(row, where)) || null
    },
    async selectOneForUpdate(table, where) {
      assert.equal(table, HANDOFF_TABLE)
      return rows.find((row) => matches(row, where)) || null
    },
    async insertOne(table, row) {
      assert.equal(table, HANDOFF_TABLE)
      writes.push({ op: 'insert', tenantId: row.tenant_id })
      const stored = { workspace_id: null, notified_step_index: null, updated_by: null, ...row }
      rows.push(stored)
      return [stored]
    },
    async updateRow(table, patch, where) {
      assert.equal(table, HANDOFF_TABLE)
      writes.push({ op: 'update', tenantId: where && where.tenant_id })
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
    externalSystemRegistry: inertService(['upsertExternalSystem', 'getExternalSystem', 'getExternalSystemForAdapter', 'deleteExternalSystem', 'listExternalSystems']),
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
 * One deployment.
 *
 *   chainTenantId  the tenant the handoff chain is bound to
 *   boundSheet     the deploy-global target sheet
 *   registry       plugin_multitable_object_registry as { sheetId: projectId }
 *   port           'full'      isSheetOwnedByProject + getObjectSheetId (a current host)
 *                  'no-derive' isSheetOwnedByProject only
 *                  'no-port'   a provisioning surface without the ownership port
 *                  'none'      no provisioning surface at all
 *                  'throws'    as 'full', but isSheetOwnedByProject REJECTS
 *   routesModule   the route module to mount (HW-05 mounts an isolated copy)
 */
function mount({
  chainTenantId = TENANT_A,
  boundSheet = HAND_BOUND_SHEET,
  registry = { [HAND_BOUND_SHEET]: STAGING_A },
  port = 'full',
  routesModule = httpRoutes,
} = {}) {
  const routes = new Map()

  const recordsReads = []
  const records = {
    async queryRecords(input) {
      recordsReads.push({ sheetId: input && input.sheetId, limit: input && input.limit })
      const wanted = input && input.filters && input.filters.projectNo
      return input && input.sheetId === boundSheet && wanted === PROJECT_IN_A
        ? [{ id: 'rec_hw_1', data: { projectNo: wanted, active: true } }]
        : []
    },
    async createRecord() { throw new Error('unexpected records write: createRecord') },
    async patchRecord() { throw new Error('unexpected records write: patchRecord') },
  }

  const registryCalls = []
  const deriveCalls = []
  let provisioning
  if (port !== 'none') {
    provisioning = {
      async findObjectSheet() { throw new Error('unexpected provisioning read: findObjectSheet') },
      async ensureObject() { throw new Error('unexpected provisioning write: ensureObject') },
    }
    if (port !== 'no-port') {
      provisioning.isSheetOwnedByProject = async (sheetId, projectId) => {
        registryCalls.push({ sheetId, projectId })
        if (port === 'throws') throw new Error('ownership registry read failed (fixture)')
        return Object.prototype.hasOwnProperty.call(registry, sheetId) && registry[sheetId] === projectId
      }
    }
    if (port === 'full' || port === 'throws') {
      provisioning.getObjectSheetId = (projectId, objectId) => {
        deriveCalls.push({ projectId, objectId })
        return derivedSheetId(projectId, objectId)
      }
    }
  }

  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      multitable: provisioning ? { records, provisioning } : { records },
    },
    storage: new Map(),
    config: {
      ...chainConfig(chainTenantId),
      stockPreparationTableActions: [{
        actionId: PLM_STOCK_PREPARATION_ACTION_ID,
        source: { externalSystemId: 'plm_sql_source', kind: 'data-source:sql-readonly' },
        target: { sheetId: boundSheet, objectId: MAIN_OBJECT_ID, fieldIdMap: {} },
      }],
    },
  }

  const services = baseServices()
  const auditAppends = []
  const auditProbes = []
  services.stockPreparationAuditStore = {
    async append(entry) {
      auditAppends.push({ action: entry.action, tenantId: entry.tenantId, projectId: entry.projectId })
      return { ok: true }
    },
    async supportsAction(action, options = {}) {
      auditProbes.push({ action, tenantId: (options && options.tenantId) || null })
      return { supported: true, reason: 'check_constraint_accepts' }
    },
    async list() {
      return { rowCount: 0, entries: [] }
    },
  }
  const db = makeMemoryDb()
  const realStore = createStockPreparationHandoffStore({
    db,
    idGenerator: (() => {
      let n = 0
      return () => `handoff-hw-${(n += 1)}`
    })(),
  })
  // A spy over the REAL store: every port call is recorded, the behaviour is the store's own.
  const storeCalls = []
  services.stockPreparationHandoffStore = {
    async get(input) { storeCalls.push({ method: 'get', tenantId: input && input.tenantId }); return realStore.get(input) },
    async advance(input) { storeCalls.push({ method: 'advance', tenantId: input && input.tenantId }); return realStore.advance(input) },
    async claimNotification(input) { storeCalls.push({ method: 'claimNotification', tenantId: input && input.tenantId }); return realStore.claimNotification(input) },
  }
  const notifierCalls = []
  services.stockPreparationHandoffNotifier = {
    async sendToDestinations(request) {
      notifierCalls.push({ destinationIds: [...(request.destinationIds || [])] })
      return { delivered: request.destinationIds.length, failed: 0 }
    },
  }
  const directoryCalls = []
  services.tenantPrincipalDirectory = {
    async verifyTenantMembership(input) {
      directoryCalls.push({ userId: input && input.userId, tenantId: input && input.tenantId })
      return { member: (MEMBERSHIPS[input && input.userId] || []).includes(input && input.tenantId) }
    },
  }
  routesModule.registerIntegrationRoutes({ context, services, logger: { info() {}, warn() {}, error() {} } })
  return { routes, boundSheet, recordsReads, registryCalls, deriveCalls, auditAppends, auditProbes, db, storeCalls, notifierCalls, directoryCalls }
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

/**
 * Drive the advance. By default the request carries a VERIFIED tenant claim equal to user.tenantId
 * (the host middleware sets `req.authenticatedTenantId` only from a verified token claim).
 * `claimless: true` is the demo machine's shape: the key is ABSENT, not empty.
 */
async function advanceAs(harness, user, { projectNo = PROJECT_IN_A, claimless = false, headers = {}, body = {} } = {}) {
  const handler = harness.routes.get(`POST ${ADVANCE_PATH}`)
  assert.ok(handler, 'the advance route is registered')
  const req = { user, body: { projectNo, fromStepKey: 'prep_entry', ...body }, query: {}, params: {}, headers: { ...headers } }
  if (!claimless) req.authenticatedTenantId = user.tenantId
  const res = createResponse()
  await handler(req, res)
  return res
}

// The route's sanitizer hands back null-prototype objects; compare their JSON shape.
function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function assertNoSideEffects(harness, label) {
  assert.deepEqual(harness.recordsReads, [], `${label}: zero records reads of the bound sheet — the existence probe never ran`)
  assert.deepEqual(harness.db.writes, [], `${label}: no cursor write was attempted`)
  assert.deepEqual(harness.db.rows, [], `${label}: and no cursor row exists`)
  assert.equal(harness.storeCalls.some((call) => call.method === 'advance' || call.method === 'claimNotification'), false,
    `${label}: the store was never asked to move a cursor or claim a notification`)
  assert.deepEqual(harness.auditAppends, [], `${label}: no audit row`)
  assert.deepEqual(harness.notifierCalls, [], `${label}: no notification dispatched`)
}

function assertWallRefusal(harness, res, status, code, label) {
  assert.equal(res.statusCode, status, `${label}: expected ${status} ${code}, got ${res.statusCode} ${JSON.stringify(res.body && res.body.error)}`)
  assert.equal(res.body && res.body.ok, false, `${label}: an error envelope`)
  assert.equal(res.body.error.code, code, `${label}: the handoff's own code`)
  assert.ok(/^STOCK_PREPARATION_HANDOFF_/.test(res.body.error.code), `${label}: never a carry or export code`)
  assertNoSideEffects(harness, label)
}

function assertValuesFree(res, label) {
  const sent = JSON.stringify(res.body)
  for (const forbidden of [HAND_BOUND_SHEET, STAGING_A, STAGING_B, TENANT_A, PROJECT_IN_A]) {
    assert.equal(sent.includes(forbidden), false, `${label}: the refusal names no sheet, project or tenant handle`)
  }
}

function assertAdvanced(harness, res, tenantId, label) {
  assert.equal(res.statusCode, 200, `${label}: expected the advance to succeed, got ${res.statusCode} ${JSON.stringify(res.body && res.body.error)}`)
  assert.equal(res.body.data.changed, true, `${label}: the turn moved`)
  assert.equal(res.body.data.currentStepKey, 'process', `${label}: to the next step`)
  assert.equal(res.body.data.notifyOutcome, 'sent', `${label}: and the next step was told`)
  assert.equal(harness.recordsReads.length, 1, `${label}: exactly one existence probe`)
  assert.equal(harness.recordsReads[0].sheetId, harness.boundSheet, `${label}: of the bound sheet`)
  assert.equal(harness.recordsReads[0].limit, 1, `${label}: for ONE row`)
  assert.equal(harness.db.rows.length, 1, `${label}: one cursor row`)
  assert.equal(harness.db.rows[0].tenant_id, tenantId, `${label}: under the caller's own tenant`)
  assert.deepEqual(harness.auditAppends.map((entry) => entry.action), ['handoff_advance'], `${label}: one audit row`)
  assert.equal(harness.notifierCalls.length, 1, `${label}: one notification`)
}

/**
 * HW-05 — an ISOLATED copy of the route module whose chain parser strips the tenant. The shared
 * module cache is restored before this returns, so no other witness (in this file or any other)
 * ever sees the substitute.
 */
function loadRoutesWithTenantlessChain() {
  const handoffPath = require.resolve(path.join(LIB, 'stock-preparation-handoff.cjs'))
  const routesPath = require.resolve(path.join(LIB, 'http-routes.cjs'))
  const cachedHandoff = require.cache[handoffPath]
  const cachedRoutes = require.cache[routesPath]
  assert.ok(cachedHandoff && cachedRoutes, 'fixture: both modules are already loaded')
  const realExports = cachedHandoff.exports
  cachedHandoff.exports = {
    ...realExports,
    parseStockPreparationHandoffConfig(config) {
      const chain = realExports.parseStockPreparationHandoffConfig(config)
      return chain.configured ? Object.freeze({ ...chain, tenantId: null }) : chain
    },
  }
  delete require.cache[routesPath]
  try {
    return require(routesPath)
  } finally {
    cachedHandoff.exports = realExports
    require.cache[routesPath] = cachedRoutes
  }
}

// ---------------------------------------------------------------------------
// witnesses
// ---------------------------------------------------------------------------

async function main() {
  // Fixture sanity: the hand-bound sheet is derived for NOTHING this suite asks about, so a pass on
  // HW-01 cannot be the derived-id fallback in disguise; and the chain the suite configures is the
  // one the real parser accepts (it refuses a chain without a tenant — HW-05 simulates that state).
  for (const staging of [STAGING_A, STAGING_B]) {
    assert.notEqual(HAND_BOUND_SHEET, derivedSheetId(staging, MAIN_OBJECT_ID))
  }
  assert.equal(parseStockPreparationHandoffConfig(chainConfig(TENANT_B)).tenantId, TENANT_B)
  assert.throws(() => parseStockPreparationHandoffConfig(chainConfig(undefined)), /tenantId/,
    'fixture: on this commit the parser itself refuses a chain without a tenant')

  await run('HW-01 the owning tenant still advances, and the wall ran to prove it', async () => {
    const harness = mount({ chainTenantId: TENANT_A })
    const res = await advanceAs(harness, OPERATOR_A)
    assertAdvanced(harness, res, TENANT_A, 'HW-01')
    assert.deepEqual(harness.registryCalls, [{ sheetId: HAND_BOUND_SHEET, projectId: STAGING_A }],
      'HW-01: the registry is asked exactly once, about the bound sheet, for the caller\'s own staging project')
    assert.deepEqual(harness.deriveCalls, [], 'HW-01: registry-proven, the derived-id fallback is never consulted')
  })

  await run('HW-02 a foreign-owned target is refused 409 with zero records reads, no cursor, no audit, no notification', async () => {
    // The chain is tenant B's, so the chain check lets tenant B's handler through; the SHEET is A's.
    const harness = mount({ chainTenantId: TENANT_B })
    const res = await advanceAs(harness, OPERATOR_B)
    // THE LEAK ITSELF, asserted FIRST: on the pre-wall route this is the line that fails, naming what
    // crossed the tenant line rather than only a status mismatch.
    assert.deepEqual(harness.recordsReads, [], 'HW-02: tenant B\'s click must not probe tenant A\'s sheet at all')
    assert.deepEqual(harness.db.rows, [], 'HW-02: and must not start a chain for a project in tenant A\'s sheet')
    assertWallRefusal(harness, res, 409, TENANT_MISMATCH, 'HW-02')
    assert.equal(res.body.error.code, STOCK_PREPARATION_HANDOFF_TARGET_OWNERSHIP_REFUSAL_CODES[CARRY_TARGET_OWNERSHIP_STATES.NOT_OWNED])
    assert.deepEqual(plain(res.body.error.details), { objectId: MAIN_OBJECT_ID }, 'HW-02: values-free details, the public objectId only')
    assertValuesFree(res, 'HW-02')
    assert.deepEqual(harness.registryCalls, [{ sheetId: HAND_BOUND_SHEET, projectId: STAGING_B }],
      'HW-02: the wall asked about the CALLER\'s own staging project')
    // Every read that did happen before the refusal was the caller's OWN: the host membership check
    // and the caller-tenant cursor lookup. Nothing touched tenant A.
    assert.deepEqual(harness.directoryCalls, [{ userId: OPERATOR_B.id, tenantId: TENANT_B }])
    assert.ok(harness.storeCalls.every((call) => call.tenantId === TENANT_B), 'HW-02: the store was only ever asked about tenant B')
  })

  await run('HW-03 the foreign caller cannot tell an existing project from an invented one: identical refusal, zero probes', async () => {
    const answers = []
    for (const projectNo of [PROJECT_IN_A, PROJECT_INVENTED]) {
      const harness = mount({ chainTenantId: TENANT_B })
      const res = await advanceAs(harness, OPERATOR_B, { projectNo })
      assertWallRefusal(harness, res, 409, TENANT_MISMATCH, `HW-03 ${projectNo === PROJECT_IN_A ? 'existing' : 'invented'}`)
      answers.push({ status: res.statusCode, body: plain(res.body), registryCalls: harness.registryCalls, storeCalls: harness.storeCalls })
    }
    assert.deepEqual(answers[0], answers[1], 'HW-03: the refusal, and every port call behind it, is the same for both project numbers')
  })

  // Fixture sanity for HW-04: the claimless request really is the shape whose scope reports an
  // UNVERIFIED claim — otherwise HW-04 would be re-running HW-01/HW-02 under another name.
  for (const operator of [OPERATOR_A, OPERATOR_B]) {
    const scope = await resolveOperatorValueScope({
      user: operator,
      authenticatedTenantId: undefined,
      explicitTenantIds: [],
      tenantPrincipalDirectory: { async verifyTenantMembership(input) { return { member: (MEMBERSHIPS[input.userId] || []).includes(input.tenantId) } } },
      requiredTier: STOCK_PREP_OPERATE,
    })
    assert.equal(scope.tenantId, operator.tenantId, 'the claimless scope resolves to user.tenantId')
    assert.equal(scope.tenantClaimVerified, false, 'and reports the claim as NOT verified — the demo-machine shape')
  }

  await run('HW-04a claimless token (demo-machine shape): the foreign tenant is still refused with zero side effects', async () => {
    const harness = mount({ chainTenantId: TENANT_B })
    const res = await advanceAs(harness, OPERATOR_B, { claimless: true })
    assert.deepEqual(harness.recordsReads, [], 'HW-04a: the claimless click must not probe tenant A\'s sheet either')
    assertWallRefusal(harness, res, 409, TENANT_MISMATCH, 'HW-04a')
    assert.deepEqual(plain(res.body.error.details), { objectId: MAIN_OBJECT_ID })
    assert.deepEqual(harness.directoryCalls, [{ userId: OPERATOR_B.id, tenantId: TENANT_B }],
      'HW-04a: the scope was vouched for by the host directory, not by a claim')
    assert.deepEqual(harness.registryCalls, [{ sheetId: HAND_BOUND_SHEET, projectId: STAGING_B }],
      'HW-04a: the wall RAN on the claimless path, asking about the directory-vouched tenant\'s own project')
  })

  await run('HW-04b claimless token (demo-machine shape): the owning tenant still advances, and the wall ran to prove it', async () => {
    const harness = mount({ chainTenantId: TENANT_A })
    const res = await advanceAs(harness, OPERATOR_A, { claimless: true })
    assertAdvanced(harness, res, TENANT_A, 'HW-04b')
    assert.deepEqual(harness.directoryCalls, [{ userId: OPERATOR_A.id, tenantId: TENANT_A }])
    assert.deepEqual(harness.registryCalls, [{ sheetId: HAND_BOUND_SHEET, projectId: STAGING_A }],
      'HW-04b: the 200 is the registry\'s proof, not the wall being skipped')
  })

  await run('HW-05 a chain without a tenantId lets every tenant past the chain check; the wall still refuses the foreign target', async () => {
    const isolated = loadRoutesWithTenantlessChain()
    assert.notEqual(isolated, httpRoutes, 'fixture: an isolated copy of the route module')
    // The shared cache is back to the real parser: a chain without a tenant is still refused by it.
    assert.equal(require(path.join(LIB, 'stock-preparation-handoff.cjs')).parseStockPreparationHandoffConfig, parseStockPreparationHandoffConfig)
    assert.equal(require(path.join(LIB, 'http-routes.cjs')), httpRoutes)

    // The foreign caller: the chain check lets them through (the chain names no tenant), so the only
    // thing between them and the probe is the wall.
    const foreign = mount({ routesModule: isolated })
    const refused = await advanceAs(foreign, OPERATOR_B)
    assert.notEqual(refused.body && refused.body.error && refused.body.error.code, 'STOCK_PREPARATION_HANDOFF_NOT_CONFIGURED',
      'HW-05: fixture — the chain check really did let the foreign tenant through')
    assert.deepEqual(foreign.recordsReads, [], 'HW-05: a tenantless chain must not open the probe to a foreign tenant')
    assertWallRefusal(foreign, refused, 409, TENANT_MISMATCH, 'HW-05 foreign')
    assert.deepEqual(foreign.registryCalls, [{ sheetId: HAND_BOUND_SHEET, projectId: STAGING_B }])
    assertValuesFree(refused, 'HW-05')

    // And the same tenantless chain still serves the sheet's owner: the wall is what separates them.
    const owner = mount({ routesModule: isolated })
    const ok = await advanceAs(owner, OPERATOR_A)
    assertAdvanced(owner, ok, TENANT_A, 'HW-05 owner')
  })

  await run('HW-06 an x-tenant-id header naming the owning tenant cannot move the wall off the verified tenant', async () => {
    const harness = mount({ chainTenantId: TENANT_B })
    // A verified tenant-B token. The host middleware only copies the header onto user.tenantId when
    // the token has NO claim, so here the header is just a header — and it names the sheet's owner.
    const res = await advanceAs(harness, OPERATOR_B, { headers: { 'x-tenant-id': TENANT_A } })
    assert.deepEqual(harness.recordsReads, [], 'HW-06: the header must not open tenant A\'s sheet to tenant B')
    assertWallRefusal(harness, res, 409, TENANT_MISMATCH, 'HW-06')
    assert.deepEqual(harness.registryCalls, [{ sheetId: HAND_BOUND_SHEET, projectId: STAGING_B }],
      'HW-06: the wall asked about the VERIFIED tenant\'s project, not the header\'s')
  })

  await run('HW-07 pre-registry install still advances; another tenant\'s derived id does not; an undecidable owner refuses', async () => {
    // (a) No registry row, but the bound sheet IS the id derived for (tenant A, the target's objectId).
    const legacySheet = derivedSheetId(STAGING_A, MAIN_OBJECT_ID)
    const legacy = mount({ chainTenantId: TENANT_A, boundSheet: legacySheet, registry: {} })
    const ok = await advanceAs(legacy, OPERATOR_A)
    assertAdvanced(legacy, ok, TENANT_A, 'HW-07a')
    assert.deepEqual(legacy.deriveCalls, [{ projectId: STAGING_A, objectId: MAIN_OBJECT_ID }])

    // (b) The same sheet is tenant A's derived id, not tenant B's.
    const foreignDerived = mount({ chainTenantId: TENANT_B, boundSheet: legacySheet, registry: {} })
    const refused = await advanceAs(foreignDerived, OPERATOR_B)
    assertWallRefusal(foreignDerived, refused, 409, TENANT_MISMATCH, 'HW-07b')
    assert.deepEqual(foreignDerived.deriveCalls, [{ projectId: STAGING_B, objectId: MAIN_OBJECT_ID }])

    // (c) Registry miss on a host that exposes no derivation: undecidable, its own code.
    const undecidable = mount({ chainTenantId: TENANT_A, registry: {}, port: 'no-derive' })
    const unknown = await advanceAs(undecidable, OPERATOR_A)
    assertWallRefusal(undecidable, unknown, 409, OWNER_UNKNOWN, 'HW-07c')
  })

  await run('HW-08 no ownership fact is not a pass: a missing port is a typed 501, a throwing port is non-2xx, zero side effects', async () => {
    for (const port of ['no-port', 'none']) {
      const harness = mount({ chainTenantId: TENANT_A, port })
      const res = await advanceAs(harness, OPERATOR_A)
      assertWallRefusal(harness, res, 501, PORT_UNAVAILABLE, `HW-08 ${port}`)
      assert.deepEqual(plain(res.body.error.details), { requiredMethods: ['isSheetOwnedByProject'] }, `HW-08 ${port}: names the missing port`)
    }
    // Both operators, because a fail-open means something different for each: for the owner it probes
    // on no evidence at all; for the other tenant it reopens the bit this change closes.
    for (const [operator, chainTenantId, staging] of [[OPERATOR_A, TENANT_A, STAGING_A], [OPERATOR_B, TENANT_B, STAGING_B]]) {
      const harness = mount({ chainTenantId, port: 'throws' })
      const res = await advanceAs(harness, operator)
      assert.ok(res.statusCode < 200 || res.statusCode >= 300, `HW-08 throws/${operator.id}: expected non-2xx, got ${res.statusCode}`)
      assert.equal(res.body && res.body.ok, false)
      assert.deepEqual(harness.registryCalls, [{ sheetId: HAND_BOUND_SHEET, projectId: staging }],
        `HW-08 throws/${operator.id}: the port WAS asked — this is the reject path, not an earlier refusal`)
      assertNoSideEffects(harness, `HW-08 throws/${operator.id}`)
    }
  })

  await run('HW-09 one verdict, three vocabularies: every refusing state maps into the handoff family and never another route\'s', async () => {
    const { assertStockPreparationTargetBelongsToTenant, STOCK_PREPARATION_TARGET_TENANT_WALLS } = httpRoutes.__internals
    const wall = STOCK_PREPARATION_TARGET_TENANT_WALLS.handoffAdvance
    assert.ok(wall, 'the handoff advance has its own wall vocabulary')
    assert.equal(wall.refusalCodes, STOCK_PREPARATION_HANDOFF_TARGET_OWNERSHIP_REFUSAL_CODES)
    assert.equal(wall.portUnavailableCode, PORT_UNAVAILABLE)
    const cases = [
      { state: CARRY_TARGET_OWNERSHIP_STATES.NOT_OWNED, provisioning: { async isSheetOwnedByProject() { return false }, getObjectSheetId: () => 'sheet_hw_other' }, target: { sheetId: 'sheet_hw_bound', objectId: MAIN_OBJECT_ID } },
      { state: CARRY_TARGET_OWNERSHIP_STATES.UNDECIDABLE, provisioning: { async isSheetOwnedByProject() { return false } }, target: { sheetId: 'sheet_hw_bound', objectId: MAIN_OBJECT_ID } },
      { state: CARRY_TARGET_OWNERSHIP_STATES.UNBOUND, provisioning: { async isSheetOwnedByProject() { return true } }, target: { sheetId: '', objectId: MAIN_OBJECT_ID } },
    ]
    for (const { state, provisioning, target } of cases) {
      await assert.rejects(
        assertStockPreparationTargetBelongsToTenant({ provisioning, targetProjectId: STAGING_A, target, wall }),
        (error) => {
          assert.equal(error.status, 409)
          assert.equal(error.code, STOCK_PREPARATION_HANDOFF_TARGET_OWNERSHIP_REFUSAL_CODES[state], state)
          return true
        },
      )
      const code = STOCK_PREPARATION_HANDOFF_TARGET_OWNERSHIP_REFUSAL_CODES[state]
      assert.match(code, /^STOCK_PREPARATION_HANDOFF_TARGET_/)
      assert.notEqual(code, CARRY_TARGET_OWNERSHIP_REFUSAL_CODES[state])
      assert.notEqual(code, PREP_LINE_EXPORT_TARGET_OWNERSHIP_REFUSAL_CODES[state])
    }
    // The closed family, pinned exactly: a deployer's runbook and the preflight quote these strings.
    assert.deepEqual({ ...STOCK_PREPARATION_HANDOFF_TARGET_OWNERSHIP_REFUSAL_CODES }, {
      [CARRY_TARGET_OWNERSHIP_STATES.NOT_OWNED]: TENANT_MISMATCH,
      [CARRY_TARGET_OWNERSHIP_STATES.UNDECIDABLE]: OWNER_UNKNOWN,
      [CARRY_TARGET_OWNERSHIP_STATES.UNBOUND]: TENANT_MISMATCH,
    })
    // The other two vocabularies are untouched by this change.
    assert.equal(STOCK_PREPARATION_TARGET_TENANT_WALLS.carry.refusalCodes, CARRY_TARGET_OWNERSHIP_REFUSAL_CODES)
    assert.equal(STOCK_PREPARATION_TARGET_TENANT_WALLS.prepLineExport.refusalCodes, PREP_LINE_EXPORT_TARGET_OWNERSHIP_REFUSAL_CODES)
  })

  await run('HW-10 structure: the shared wall runs before the probe and every write, on the resolved scope\'s project', async () => {
    const LF = String.fromCharCode(10)
    const source = fs.readFileSync(path.join(LIB, 'http-routes.cjs'), 'utf8').split(String.fromCharCode(13, 10)).join(LF)
    const start = source.indexOf('    async stockPreparationHandoffAdvance(req, res) {')
    assert.ok(start > 0, 'found the advance handler')
    const end = source.indexOf(LF + '    },' + LF, start)
    // Code only — a comment that NAMES a call must not satisfy an ordering check.
    const body = source.slice(start, end).split(LF).filter((line) => !/^\s*\/\//.test(line)).join(LF)
    const wallAt = body.indexOf('await assertHandoffAdvanceTargetBelongsToTenant(')
    assert.ok(wallAt > 0, 'the advance handler calls the shared wall')
    for (const later of ['stockPreparationProjectHasMainRows(', 'store.advance(', 'audit.append(', 'store.claimNotification(', 'dispatchStockPreparationHandoffNotification(']) {
      const at = body.indexOf(later)
      assert.ok(at > wallAt, `the wall runs BEFORE ${later}`)
    }
    const wallCall = body.slice(wallAt, body.indexOf(LF + '      })', wallAt))
    assert.ok(wallCall.includes('targetProjectId: resolveIntegrationStagingProjectId(scope.tenantId, undefined)'),
      'the project the registry is asked about comes from the RESOLVED scope, with no request projectId')
    assert.ok(wallCall.includes('target: action.target'), 'and the target is the bound action\'s — the sheet the probe reads')
    assert.equal(/isSheetOwnedByProject\(/.test(body), false, 'the handler grows no private ownership check')
    assert.equal(/getObjectSheetId\(/.test(body), false, 'nor a private derived-id check')
    assert.equal(/headers/.test(body), false, 'nor reads a request header')
    const code = source.split(LF).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join(LF)
    assert.equal((code.match(/\.isSheetOwnedByProject\(/g) || []).length, 1, 'one ownership-port call site in http-routes.cjs')
    assert.ok(/function assertHandoffAdvanceTargetBelongsToTenant\([^)]*\) \{\n\s+return assertStockPreparationTargetBelongsToTenant\([^\n]*STOCK_PREPARATION_TARGET_TENANT_WALLS\.handoffAdvance \}\)/.test(code),
      'the handoff wrapper delegates to the shared wall with the handoff vocabulary')
  })

  await run('HW-11 a body workspaceId naming the owning tenant\'s staging project cannot move the wall off the verified tenant', async () => {
    // THE STEERING VALUE IS LIVE, which is what makes this a witness and not a formality. The advance's
    // body allowlist accepts `workspaceId`, and the staging resolver hands back an `…:integration-core`
    // project it is given VERBATIM (resolveIntegrationStagingProjectId's second argument). So a wall
    // that took its project from the request would ask the registry about tenant A's staging project,
    // get "owned", and let tenant B's click probe tenant A's sheet — the bit this change closes.
    assert.equal(STAGING_A.split(':').pop(), 'integration-core',
      'fixture: the steering value has the shape the staging resolver returns verbatim')
    const answers = []
    for (const projectNo of [PROJECT_IN_A, PROJECT_INVENTED]) {
      const label = `HW-11 ${projectNo === PROJECT_IN_A ? 'existing' : 'invented'}`
      // Chain bound to tenant B, the bound sheet owned by tenant A, a verified tenant-B token.
      const harness = mount({ chainTenantId: TENANT_B })
      const res = await advanceAs(harness, OPERATOR_B, { projectNo, body: { workspaceId: STAGING_A } })
      assert.deepEqual(harness.recordsReads, [], `${label}: a body workspaceId must not open tenant A's sheet to tenant B`)
      assertWallRefusal(harness, res, 409, TENANT_MISMATCH, label)
      assert.deepEqual(harness.registryCalls, [{ sheetId: HAND_BOUND_SHEET, projectId: STAGING_B }],
        `${label}: the registry was asked about the VERIFIED tenant's staging project, and only that`)
      assert.deepEqual(harness.deriveCalls, [{ projectId: STAGING_B, objectId: MAIN_OBJECT_ID }],
        `${label}: and so was the derived-id fallback`)
      assert.deepEqual(harness.directoryCalls, [{ userId: OPERATOR_B.id, tenantId: TENANT_B }],
        `${label}: the scope itself never looked at tenant A`)
      assertValuesFree(res, label)
      answers.push({ status: res.statusCode, body: plain(res.body), registryCalls: harness.registryCalls, storeCalls: harness.storeCalls })
    }
    assert.deepEqual(answers[0], answers[1], 'HW-11: the same refusal for an existing and an invented project')
  })

  console.log(`\nstock-preparation-handoff-advance-tenant-wall: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.error('stock-preparation-handoff-advance-tenant-wall FAILED')
    process.exitCode = 1
    return
  }
  console.log('stock-preparation-handoff-advance-tenant-wall OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
