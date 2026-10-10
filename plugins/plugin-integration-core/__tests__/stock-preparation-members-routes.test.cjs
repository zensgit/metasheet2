'use strict'

// 备料「成员与权限」— THE FOUR S5b ROUTES (ADR adr-stock-prep-project-sheets-20261008 §11.4–11.6;
// register R-39). The real route stack is mounted; the host's narrow members port is a COUNTING fake
// that follows the real port's order (caller first, then the targets); the project registry is the
// REAL store over an in-memory db; the provisioning G1 port, the audit store and the tenant directory
// are fakes in the shape of the project-target suite's.
//
//   MR-01 SWITCH OFF: every route answers 404 STOCK_PREP_MEMBERS_PAGE_DISABLED for every admitted tier,
//         with ZERO port, registry, provisioning and audit calls; only the exact literal 'true' is on;
//         the switch is read per request.
//   MR-02 GATE FIRST: below WORKBENCH_ADMIN the gate refuses (401 / 403 FORBIDDEN) whatever the switch
//         says — the switch never turns a permission refusal into a 404.
//   MR-03 SWITCH ON, THE TIER MATRIX: every actor × route; refused cells make zero port calls; pass
//         cells reach the port with the authenticated user id and nothing from the request.
//   MR-04 CLOSED BODIES: an unknown key (or a query on the read) is 400 before the port is touched.
//   MR-05 THE PORT DECIDES: its refusals (403 FORBIDDEN tier, ROLE_DELEGATION_SCOPE_REQUIRED, 400
//         platform code, 403 read-only built-in) come back with their own status and code; create is
//         201, update forwards only the keys present.
//   MR-06 PROJECT SHEETS: also need the project-sheets switch; malformed numbers are 400 before IO; the
//         registry is read only after the port admitted the caller; only the caller's OWN tenant's
//         ACTIVE rows can be named (absent / another tenant's / archived → 409, nothing granted); the
//         grant is the G1 port with roleIds [roleId] and the derived project-sheet objectId, audited
//         `project_target_grant` per landed call.
//   MR-07 PORT ABSENT: 501 STOCK_PREP_MEMBERS_PORT_UNAVAILABLE, never a fallback.
//   MR-08 SOURCE ORDER: in each handler the gate precedes the switch, which precedes the first await.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const { STOCK_PREP_ADMIN, STOCK_PREP_OPERATE, STOCK_PREP_PULL, STOCK_PREP_READ, STOCK_PREP_WORKBENCH_CAPABILITIES } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { STOCK_PREP_AUDIT_ACTIONS, __internals: auditInternals } = require(path.join(LIB, 'stock-preparation-audit-store.cjs'))
const { createStockPreparationProjectTargetStore } = require(path.join(LIB, 'stock-preparation-project-target-store.cjs'))
const { PROJECT_SHEETS_ENABLED_ENV, deriveProjectSheetObjectId } = require(path.join(LIB, 'stock-preparation-project-targets.cjs'))
const { STOCK_PREP_MEMBERS_PAGE_ENABLED_ENV, stockPrepMembersPageEnabled } = require(path.join(LIB, 'stock-preparation-members.cjs'))

const HTTP_ROUTES_SOURCE = fs.readFileSync(path.join(LIB, 'http-routes.cjs'), 'utf8').split('\r\n').join('\n')

const TENANT = 'tenant-s5b'
const OTHER_TENANT = 'tenant-s5b-foreign'
const PROJECT = 'PRJ-S5B-1'
const PROJECT_2 = 'PRJ-S5B-2'
const ARCHIVED_PROJECT = 'PRJ-S5B-ARCH'
const FOREIGN_PROJECT = 'PRJ-S5B-FOREIGN'
const ROLE = 'stock-prep_c_0a1b2c3d'

const READ_PATH = '/api/integration/stock-preparation/members'
const CREATE_PATH = '/api/integration/stock-preparation/members/custom-roles'
const UPDATE_PATH = '/api/integration/stock-preparation/members/custom-roles/:roleId'
const TARGETS_PATH = '/api/integration/stock-preparation/members/custom-roles/:roleId/project-targets'

const ANONYMOUS = undefined
const LOGGED_IN = Object.freeze({ id: 'u_plain', tenantId: TENANT, permissions: [] })
const INTEGRATION_WRITER = Object.freeze({ id: 'u_int_writer', tenantId: TENANT, permissions: ['integration:write'] })
const OPERATOR_READ = Object.freeze({ id: 'u_op_read', tenantId: TENANT, permissions: [STOCK_PREP_READ] })
const FLOOR = Object.freeze({ id: 'u_floor', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const PULLER = Object.freeze({ id: 'u_puller', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })
const WILDCARD = Object.freeze({ id: 'u_wild', tenantId: TENANT, permissions: ['stock-prep:*', '*:*'] })
const WORKBENCH_ADMIN = Object.freeze({ id: 'u_wb_admin', tenantId: TENANT, permissions: [STOCK_PREP_ADMIN] })
const PLATFORM_ADMIN = Object.freeze({ id: 'u_admin', tenantId: TENANT, roles: ['admin'], permissions: ['integration:admin'] })

const REFUSED_BY_GATE = [ANONYMOUS, LOGGED_IN, INTEGRATION_WRITER, OPERATOR_READ, FLOOR, PULLER, WILDCARD]
const ADMITTED_BY_GATE = [WORKBENCH_ADMIN, PLATFORM_ADMIN]

// ── substrate ────────────────────────────────────────────────────────────────────────────────────

function makeMemoryDb() {
  const rows = []
  const calls = []
  const matches = (row, where) => Object.entries(where).every(([c, v]) => (row[c] === undefined ? null : row[c]) === (v === undefined ? null : v))
  const api = {
    rows,
    calls,
    async transaction(fn) { calls.push('transaction'); return fn({ ...api, async advisoryXactLock(key) { calls.push(`advisoryXactLock:${key}`) } }) },
    async selectOne(_t, where) { calls.push('selectOne'); return rows.find((r) => matches(r, where)) || null },
    async select(_t, { where } = {}) { calls.push('select'); return rows.filter((r) => matches(r, where || {})) },
    async insertOne() { throw new Error('the members routes never register a project sheet') },
    async countRows(_t, where) { calls.push('countRows'); return rows.filter((r) => matches(r, where || {})).length },
    async selectOneForUpdate(_t, where) { calls.push('selectOneForUpdate'); return rows.find((r) => matches(r, where)) || null },
  }
  return api
}

function makeProvisioning({ grantResult = () => ({ granted: [ROLE], alreadyGranted: [] }) } = {}) {
  const calls = []
  return {
    calls,
    getObjectSheetId: (projectId, objectId) => `sheet_${projectId}_${objectId}`.replace(/[^A-Za-z0-9_]/g, '_'),
    async grantSheetRoleWrite(input) { calls.push(['grantSheetRoleWrite', input]); return grantResult(input) },
  }
}

/**
 * The host port, faked in the REAL port's order: the caller is decided first (a configured refusal
 * throws before anything else), then the targets are resolved, then each target's grant runs.
 */
function makeMembersPort({ refuse = null } = {}) {
  const calls = []
  const refuseNow = () => {
    if (!refuse) return
    throw Object.assign(new Error(refuse.code), { status: refuse.status, code: refuse.code, details: {} })
  }
  return {
    calls,
    async describe(input) { calls.push(['describe', input]); refuseNow(); return { enabled: true, builtInRoles: [], customRoles: [], otherRoles: [], audit: { available: true, entries: [] } } },
    async createCustomRole(input) { calls.push(['createCustomRole', input]); refuseNow(); return { roleId: ROLE, name: input.name, permissionCodes: input.permissionCodes } },
    async updateCustomRole(input) { calls.push(['updateCustomRole', input]); refuseNow(); return { roleId: input.roleId } },
    async grantCustomRoleProjectSheets(input) {
      calls.push(['grantCustomRoleProjectSheets', { actorId: input.actorId, roleId: input.roleId }])
      refuseNow()
      const targets = await input.resolveTargets()
      const sheets = []
      for (const target of targets) {
        const outcome = await target.grant()
        sheets.push({ sheetId: target.sheetId, granted: outcome.granted })
      }
      return { roleId: input.roleId, sheets }
    },
  }
}

function inertService(methods) {
  const service = {}
  for (const method of methods) service[method] = async () => { throw new Error(`unexpected service call: ${method}`) }
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

function withEnv(values, fn) {
  const keys = [STOCK_PREP_MEMBERS_PAGE_ENABLED_ENV, PROJECT_SHEETS_ENABLED_ENV]
  const previous = {}
  for (const key of keys) {
    previous[key] = process.env[key]
    if (values[key] === undefined) delete process.env[key]
    else process.env[key] = values[key]
  }
  const restore = () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
  return Promise.resolve().then(fn).finally(restore)
}

const ON = { [STOCK_PREP_MEMBERS_PAGE_ENABLED_ENV]: 'true', [PROJECT_SHEETS_ENABLED_ENV]: 'true' }

function mount({ port = makeMembersPort(), provisioning = makeProvisioning(), withPort = true, directory = { async verifyTenantMembership() { return { member: true } } } } = {}) {
  const routes = new Map()
  const auditAppends = []
  const auditProbes = []
  const db = makeMemoryDb()
  const context = {
    api: {
      http: { addRoute(method, routePath, handler) { routes.set(`${method.toUpperCase()} ${routePath}`, handler) } },
      multitable: { provisioning, records: inertService(['queryRecords']) },
    },
    storage: new Map(),
    config: {},
  }
  const services = baseServices()
  services.stockPreparationAuditStore = {
    async append(entry) {
      auditInternals.assertValuesFreeDetail(entry.detail)
      assert.ok(STOCK_PREP_AUDIT_ACTIONS.includes(entry.action), `audit action ${entry.action} is in the closed vocabulary`)
      auditAppends.push(entry)
      return { ok: true }
    },
    async supportsAction(action) { auditProbes.push(action); return { supported: true, reason: 'check_constraint_accepts' } },
    async list() { return { rowCount: 0, entries: [] } },
  }
  let n = 0
  services.stockPreparationProjectTargetStore = createStockPreparationProjectTargetStore({ db, idGenerator: () => `pt-${(n += 1)}` })
  services.tenantPrincipalDirectory = directory
  if (withPort) services.stockPreparationMembers = port
  httpRoutes.registerIntegrationRoutes({ context, services, logger: { info() {}, warn() {}, error() {} } })
  const seed = (tenantId, projectNo, status = 'active') => {
    const objectId = deriveProjectSheetObjectId(tenantId, projectNo)
    const sheetId = provisioning.getObjectSheetId(`${tenantId}:integration-core`, objectId)
    db.rows.push({ id: `seed-${tenantId}-${projectNo}`, tenant_id: tenantId, project_no: projectNo, sheet_id: sheetId, object_id: objectId, status, created_by: 'seed', created_at: new Date('2026-10-08T00:00:00Z'), archived_at: status === 'archived' ? new Date('2026-10-09T00:00:00Z') : null })
    return { sheetId, objectId }
  }
  return {
    routes, port, provisioning, db, auditAppends, auditProbes, seed,
    ioCount: () => port.calls.length + provisioning.calls.length + db.calls.length + auditAppends.length + auditProbes.length,
  }
}

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
  const request = { user: req.user, body: req.body || {}, query: req.query || {}, params: req.params || {} }
  if (req.authenticatedTenantId !== undefined) request.authenticatedTenantId = req.authenticatedTenantId
  await handler(request, res)
  assert.notEqual(res.body, undefined, `${method} ${routePath} produced a body`)
  return res
}

const errorCode = (res) => res.body && res.body.error && res.body.error.code

/** One well-formed request per route. */
const REQUESTS = Object.freeze([
  ['GET', READ_PATH, () => ({ query: {} })],
  ['POST', CREATE_PATH, () => ({ body: { name: '采购只读', permissionCodes: [STOCK_PREP_READ] } })],
  ['PATCH', UPDATE_PATH, () => ({ params: { roleId: ROLE }, body: { name: '改名' } })],
  ['POST', TARGETS_PATH, () => ({ params: { roleId: ROLE }, body: { projectNos: [PROJECT] } })],
])

async function main() {
  // The four routes are exactly the four members.* manifest rows (and nothing else is).
  assert.deepEqual(
    STOCK_PREP_WORKBENCH_CAPABILITIES.filter((entry) => entry.capability.startsWith('members.')).map((entry) => [entry.method, entry.path, entry.code]),
    REQUESTS.map(([method, routePath]) => [method, routePath, STOCK_PREP_ADMIN]),
    'the members manifest rows are the four routes, all on STOCK_PREP_ADMIN',
  )

  // MR-01 SWITCH OFF ───────────────────────────────────────────────────────────────────────────────
  for (const value of [undefined, 'TRUE', ' true', 'true ', '1', 'yes', 'false']) {
    await withEnv({ [STOCK_PREP_MEMBERS_PAGE_ENABLED_ENV]: value, [PROJECT_SHEETS_ENABLED_ENV]: 'true' }, async () => {
      for (const user of ADMITTED_BY_GATE) {
        const h = mount()
        h.seed(TENANT, PROJECT)
        h.db.calls.length = 0
        for (const [method, routePath, build] of REQUESTS) {
          const res = await call(h.routes, method, routePath, { ...build(), user })
          assert.equal(res.statusCode, 404, `MR-01: ${method} ${routePath} @ ${JSON.stringify(value)} is 404`)
          assert.equal(errorCode(res), 'STOCK_PREP_MEMBERS_PAGE_DISABLED', `MR-01: ${method} ${routePath} code`)
        }
        assert.equal(h.ioCount(), 0, `MR-01: switch ${JSON.stringify(value)} off costs ZERO port / registry / provisioning / audit calls for ${user.id}`)
      }
    })
  }
  assert.equal(stockPrepMembersPageEnabled({ [STOCK_PREP_MEMBERS_PAGE_ENABLED_ENV]: 'true' }), true)
  assert.equal(stockPrepMembersPageEnabled({}), false)
  // Read per request: one mount, the env flipped between calls.
  {
    const h = mount()
    await withEnv({}, async () => {
      assert.equal((await call(h.routes, 'GET', READ_PATH, { user: PLATFORM_ADMIN })).statusCode, 404)
    })
    await withEnv(ON, async () => {
      assert.equal((await call(h.routes, 'GET', READ_PATH, { user: PLATFORM_ADMIN })).statusCode, 200, 'MR-01: the switch is read per request')
    })
    await withEnv({}, async () => {
      assert.equal((await call(h.routes, 'GET', READ_PATH, { user: PLATFORM_ADMIN })).statusCode, 404, 'MR-01: …in both directions')
    })
  }

  // MR-02 GATE FIRST ───────────────────────────────────────────────────────────────────────────────
  for (const env of [{}, ON]) {
    await withEnv(env, async () => {
      for (const user of REFUSED_BY_GATE) {
        const h = mount()
        for (const [method, routePath, build] of REQUESTS) {
          const res = await call(h.routes, method, routePath, { ...build(), user })
          assert.equal(res.statusCode, user === undefined ? 401 : 403, `MR-02: ${user ? user.id : 'anonymous'} @ ${method} ${routePath} (${env === ON ? 'on' : 'off'})`)
          assert.equal(errorCode(res), user === undefined ? 'UNAUTHENTICATED' : 'FORBIDDEN', 'MR-02: the GATE refused, not the switch')
        }
        assert.equal(h.ioCount(), 0, `MR-02: a gate-refused ${user ? user.id : 'anonymous'} costs zero IO`)
      }
    })
  }

  // MR-03 SWITCH ON — the pass cells reach the port with the authenticated id ─────────────────────
  await withEnv(ON, async () => {
    for (const user of ADMITTED_BY_GATE) {
      const h = mount()
      h.seed(TENANT, PROJECT)
      const read = await call(h.routes, 'GET', READ_PATH, { user })
      assert.equal(read.statusCode, 200, `MR-03: ${user.id} reads`)
      assert.deepEqual(h.port.calls[0], ['describe', { actorId: user.id }], 'MR-03: describe gets the authenticated id and nothing else')
      const created = await call(h.routes, 'POST', CREATE_PATH, { user, body: { name: '采购只读', permissionCodes: [STOCK_PREP_READ] } })
      assert.equal(created.statusCode, 201, `MR-03: ${user.id} creates (201)`)
      assert.deepEqual(h.port.calls[1], ['createCustomRole', { actorId: user.id, name: '采购只读', permissionCodes: [STOCK_PREP_READ] }])
      const updated = await call(h.routes, 'PATCH', UPDATE_PATH, { user, params: { roleId: ROLE }, body: { permissionCodes: [STOCK_PREP_READ, STOCK_PREP_OPERATE] } })
      assert.equal(updated.statusCode, 200)
      // Only the keys the request carried are forwarded — an absent name is not "rename to undefined".
      assert.deepEqual(h.port.calls[2], ['updateCustomRole', { actorId: user.id, roleId: ROLE, permissionCodes: [STOCK_PREP_READ, STOCK_PREP_OPERATE] }])
      const granted = await call(h.routes, 'POST', TARGETS_PATH, { user, params: { roleId: ROLE }, body: { projectNos: [PROJECT] } })
      assert.equal(granted.statusCode, 200, `MR-03: ${user.id} adds a project sheet, got ${JSON.stringify(granted.body)}`)
      assert.deepEqual(h.port.calls[3], ['grantCustomRoleProjectSheets', { actorId: user.id, roleId: ROLE }])
    }
  })

  // MR-04 CLOSED BODIES ────────────────────────────────────────────────────────────────────────────
  await withEnv(ON, async () => {
    const bad = [
      ['GET', READ_PATH, { query: { tenantId: TENANT } }],
      ['POST', CREATE_PATH, { body: { name: 'x', permissionCodes: [], id: 'stock-prep_admin' } }],
      ['POST', CREATE_PATH, { body: { name: 'x', permissionCodes: [], roleId: 'stock-prep_c_0a1b2c3d' } }],
      ['PATCH', UPDATE_PATH, { params: { roleId: ROLE }, body: { name: 'x', members: ['u_x'] } }],
      ['POST', TARGETS_PATH, { params: { roleId: ROLE }, body: { projectNos: [PROJECT], sheetIds: ['sheet_x'] } }],
      ['POST', TARGETS_PATH, { params: { roleId: ROLE }, body: { projectNos: [PROJECT], level: 'admin' } }],
    ]
    for (const [method, routePath, req] of bad) {
      const h = mount()
      const res = await call(h.routes, method, routePath, { ...req, user: PLATFORM_ADMIN })
      assert.equal(res.statusCode, 400, `MR-04: ${method} ${routePath} ${JSON.stringify(req.body || req.query)} is 400`)
      assert.equal(errorCode(res), 'STOCK_PREP_MEMBERS_REQUEST_INVALID')
      assert.equal(h.ioCount(), 0, 'MR-04: a malformed request costs zero IO')
    }
  })

  // MR-05 THE PORT DECIDES ─────────────────────────────────────────────────────────────────────────
  await withEnv(ON, async () => {
    const refusals = [
      { status: 403, code: 'STOCK_PREP_MEMBERS_FORBIDDEN' },
      { status: 403, code: 'ROLE_DELEGATION_SCOPE_REQUIRED' },
      { status: 400, code: 'STOCK_PREP_CUSTOM_ROLE_PLATFORM_CODE_FORBIDDEN' },
      { status: 403, code: 'STOCK_PREP_BUILTIN_ROLE_READ_ONLY' },
      { status: 404, code: 'STOCK_PREP_MEMBERS_PAGE_DISABLED' },
    ]
    for (const refuse of refusals) {
      const h = mount({ port: makeMembersPort({ refuse }) })
      h.seed(TENANT, PROJECT)
      h.db.calls.length = 0
      for (const [method, routePath, build] of REQUESTS) {
        const res = await call(h.routes, method, routePath, { ...build(), user: WORKBENCH_ADMIN })
        assert.equal(res.statusCode, refuse.status, `MR-05: the port's ${refuse.code} reaches the caller at ${method} ${routePath}`)
        assert.equal(errorCode(res), refuse.code)
      }
      // The port refused BEFORE it asked for the targets: no registry read, no grant, no audit.
      assert.deepEqual(h.db.calls, [], `MR-05: a port refusal (${refuse.code}) reads no registry row`)
      assert.deepEqual(h.provisioning.calls, [], 'MR-05: …and grants nothing')
      assert.deepEqual(h.auditAppends, [], 'MR-05: …and audits nothing')
    }
  })

  // MR-06 PROJECT SHEETS ───────────────────────────────────────────────────────────────────────────
  // (a) the project-sheets switch is required too.
  await withEnv({ [STOCK_PREP_MEMBERS_PAGE_ENABLED_ENV]: 'true' }, async () => {
    const h = mount()
    h.seed(TENANT, PROJECT)
    h.db.calls.length = 0
    const res = await call(h.routes, 'POST', TARGETS_PATH, { user: PLATFORM_ADMIN, params: { roleId: ROLE }, body: { projectNos: [PROJECT] } })
    assert.equal(res.statusCode, 404, 'MR-06a: project sheets off ⇒ 404')
    assert.equal(errorCode(res), 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED')
    assert.equal(h.ioCount(), 0, 'MR-06a: …with zero IO')
  })
  await withEnv(ON, async () => {
    // (b) malformed numbers: 400 before the port.
    for (const projectNos of [[], 'PRJ', [''], ['   '], Array.from({ length: 51 }, (_, i) => `PRJ-${i}`), [42]]) {
      const h = mount()
      const res = await call(h.routes, 'POST', TARGETS_PATH, { user: PLATFORM_ADMIN, params: { roleId: ROLE }, body: { projectNos } })
      assert.equal(res.statusCode, 400, `MR-06b: projectNos ${JSON.stringify(projectNos).slice(0, 40)} is 400`)
      assert.equal(errorCode(res), 'STOCK_PREP_MEMBERS_REQUEST_INVALID')
      assert.equal(h.ioCount(), 0)
    }
    // (c) the happy path: the caller's own tenant, active rows, the G1 port, the audit row.
    {
      const h = mount({ provisioning: makeProvisioning({ grantResult: (input) => (input.sheetId.includes(deriveProjectSheetObjectId(TENANT, PROJECT_2).replace(/[^A-Za-z0-9_]/g, '_')) ? { granted: [], alreadyGranted: [ROLE] } : { granted: [ROLE], alreadyGranted: [] }) }) })
      const a = h.seed(TENANT, PROJECT)
      const b = h.seed(TENANT, PROJECT_2)
      const res = await call(h.routes, 'POST', TARGETS_PATH, { user: WORKBENCH_ADMIN, params: { roleId: ROLE }, body: { projectNos: [PROJECT, PROJECT_2, PROJECT] } })
      assert.equal(res.statusCode, 200, `MR-06c: ${JSON.stringify(res.body)}`)
      assert.deepEqual(res.body.data, { roleId: ROLE, sheets: [{ sheetId: a.sheetId, granted: true }, { sheetId: b.sheetId, granted: false }] })
      assert.deepEqual(h.provisioning.calls, [
        ['grantSheetRoleWrite', { projectId: `${TENANT}:integration-core`, sheetId: a.sheetId, objectId: a.objectId, roleIds: [ROLE], actorId: WORKBENCH_ADMIN.id }],
        ['grantSheetRoleWrite', { projectId: `${TENANT}:integration-core`, sheetId: b.sheetId, objectId: b.objectId, roleIds: [ROLE], actorId: WORKBENCH_ADMIN.id }],
      ], 'MR-06c: the G1 port, role subject only, the derived project-sheet objectId, the verified tenant\'s project')
      assert.deepEqual(h.auditAppends.map((entry) => [entry.action, entry.projectId, entry.subjectId, entry.mode, entry.detail]), [
        ['project_target_grant', PROJECT, a.sheetId, 'custom_role_granted', { roleId: ROLE, granted: 1, alreadyGranted: 0 }],
        ['project_target_grant', PROJECT_2, b.sheetId, 'custom_role_already_granted', { roleId: ROLE, granted: 0, alreadyGranted: 1 }],
      ])
      assert.deepEqual(h.auditProbes, ['project_target_grant'], 'MR-06c: the audit vocabulary is probed once')
    }
    // (d) another tenant's project, an unregistered one and an archived one — 409, nothing granted.
    for (const [projectNo, code] of [[FOREIGN_PROJECT, 'STOCK_PREPARATION_PROJECT_ABSENT'], ['PRJ-NEVER', 'STOCK_PREPARATION_PROJECT_ABSENT'], [ARCHIVED_PROJECT, 'STOCK_PREPARATION_PROJECT_ARCHIVED']]) {
      const h = mount()
      h.seed(TENANT, PROJECT)
      h.seed(OTHER_TENANT, FOREIGN_PROJECT)
      h.seed(TENANT, ARCHIVED_PROJECT, 'archived')
      const res = await call(h.routes, 'POST', TARGETS_PATH, { user: PLATFORM_ADMIN, params: { roleId: ROLE }, body: { projectNos: [PROJECT, projectNo] } })
      assert.equal(res.statusCode, 409, `MR-06d: ${projectNo}`)
      assert.equal(errorCode(res), code)
      assert.deepEqual(h.provisioning.calls, [], `MR-06d: ${projectNo} — the whole call grants nothing, the valid sheet included`)
      assert.deepEqual(h.auditAppends, [])
      assert.ok(!JSON.stringify(res.body).includes(projectNo), 'MR-06d: values-free — the refused number is not echoed')
    }
    // (e) a header-carried tenant that contradicts the verified claim is refused by the operator scope.
    {
      const h = mount()
      h.seed(TENANT, PROJECT)
      h.seed(OTHER_TENANT, FOREIGN_PROJECT)
      const res = await call(h.routes, 'POST', TARGETS_PATH, {
        user: { ...PLATFORM_ADMIN, tenantId: OTHER_TENANT },
        authenticatedTenantId: TENANT,
        params: { roleId: ROLE },
        body: { projectNos: [FOREIGN_PROJECT] },
      })
      assert.equal(res.statusCode, 403, `MR-06e: ${JSON.stringify(res.body)}`)
      assert.deepEqual(h.provisioning.calls, [])
    }
    // (f) a host without the grant port: 501, nothing audited.
    {
      const provisioning = makeProvisioning()
      delete provisioning.grantSheetRoleWrite
      const h = mount({ provisioning })
      h.seed(TENANT, PROJECT)
      const res = await call(h.routes, 'POST', TARGETS_PATH, { user: PLATFORM_ADMIN, params: { roleId: ROLE }, body: { projectNos: [PROJECT] } })
      assert.equal(res.statusCode, 501)
      assert.equal(errorCode(res), 'STOCK_PREP_MEMBERS_GRANT_PORT_UNAVAILABLE')
      assert.deepEqual(h.auditAppends, [])
    }
  })

  // MR-07 PORT ABSENT ──────────────────────────────────────────────────────────────────────────────
  await withEnv(ON, async () => {
    const h = mount({ withPort: false })
    for (const [method, routePath, build] of REQUESTS) {
      const res = await call(h.routes, method, routePath, { ...build(), user: PLATFORM_ADMIN })
      assert.equal(res.statusCode, 501, `MR-07: ${method} ${routePath}`)
      assert.equal(errorCode(res), 'STOCK_PREP_MEMBERS_PORT_UNAVAILABLE')
    }
    assert.equal(h.ioCount(), 0)
  })

  // MR-08 SOURCE ORDER ─────────────────────────────────────────────────────────────────────────────
  for (const handler of ['stockPreparationMembersRead', 'stockPreparationMembersCustomRoleCreate', 'stockPreparationMembersCustomRoleUpdate', 'stockPreparationMembersCustomRoleProjectTargets']) {
    const start = HTTP_ROUTES_SOURCE.indexOf(`    async ${handler}(req, res) {`)
    assert.ok(start > 0, `MR-08: ${handler} exists`)
    const body = HTTP_ROUTES_SOURCE.slice(start, HTTP_ROUTES_SOURCE.indexOf('\n    },', start)).replace(/\/\/[^\n]*/g, '')
    const gate = body.indexOf('requireAccess(req, STOCK_PREP_ADMIN)')
    const flag = body.indexOf('requireMembersPageEnabled()')
    const firstAwait = body.indexOf('await ')
    assert.ok(gate > 0, `MR-08: ${handler} is gated on STOCK_PREP_ADMIN`)
    assert.ok(flag > gate, `MR-08: ${handler} checks the switch AFTER the gate`)
    assert.ok(firstAwait > flag, `MR-08: ${handler} does no IO before the switch`)
    assert.ok(!/requireAccess\(req,\s*'/.test(body), `MR-08: ${handler} carries no literal gate token`)
  }

  console.log('stock-preparation members routes (S5b, R-39): all assertions passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
