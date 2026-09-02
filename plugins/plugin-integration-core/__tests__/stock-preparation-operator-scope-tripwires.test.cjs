'use strict'

// TRIPWIRES for the operator value scope — the guards whose ABSENCE the shipped code survives.
//
// The directory suite (stock-preparation-operator-project-directory.test.cjs) asserts what the
// feature DOES. An adversarial re-read of it found the other half missing: several properties the
// design leans on are true in the shipped code and would stay green if you deleted the line that
// makes them true. A guarantee nothing can red is a comment. These are the reds.
//
//   S-01 THE WIRING, THROUGH THE REAL index.cjs. Every other route suite hands `services` straight to
//        `registerIntegrationRoutes`, so the plugin's own passthrough
//        (`context.services.tenantPrincipalDirectory`) is never exercised: deleting it would red
//        nothing. This activates the REAL plugin entry point and asserts the seam arrives — and that
//        a host which does NOT inject it produces the named 501, not a read on `req.user.tenantId`.
//   S-02 THE RESPONSE PROJECTION IS KEY-PINNED. The directory builds an explicit ten-key object; a
//        future `...data` spread would ship `owner`, and any customer-pack `ext_` column that happens
//        to sit on the project row, with no test noticing. A canary is planted in BOTH a template
//        field the projection omits (`owner`) and a NON-template physical column, and neither may
//        appear in any byte of the response.
//   S-03 THE SEAM IS ASKED THE RIGHT QUESTION. The verdict is checked but the QUESTION was not: a
//        route that asked about the request's tenant, or about `user.email` instead of `user.id`,
//        would pass every existing assertion. Both substitutions are red here.
//   S-04 A TRUTHY VERDICT IS NOT A VERDICT. `member !== true` is deliberately strict; relaxing it to
//        truthiness redded nothing. The malformed-verdict matrix fixes that.
//   S-05 THE PLATFORM-ADMIN CONVENTION, PINNED DELIBERATELY. A tenant-BOUND platform admin holding no
//        stock-prep grant at all is SERVED this read for the tenant they are a member of. That is the
//        existing `role:admin`/`integration:admin` convention this plugin has always followed
//        (satisfiesStockPrepAccess short-circuits on it) — stated here as an intended property with
//        its two real limits, not left to be discovered.
//   S-06 THE AUDIT ROW CARRIES NO PROJECT NUMBER, and that is a CHOICE rather than an accident of
//        validation: the audit store's SAFE_STRING_PATTERN would happily accept `230920006`.
//   S-07 NO AUDIT STORE, NO VALUES. `requireStockPreparationAudit`'s 501 was untested on this route.
//
// Hermetic: no DB, no network. Every service these routes must not touch is stubbed to throw.

const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

// S-01 loads the REAL plugin entry point, whose module graph reaches three things that have nothing
// to do with the tenant seam: the workspace package `@metasheet/mssql-readonly-utils`, and the `pg` /
// `mssql` drivers. On a checkout where the plugin's own dependencies were not installed, the require
// throws before any of this suite's subject matter is reached — a property of the CHECKOUT, not of
// the code under test.
//
// So each is resolved by a LAST-RESORT fallback, used only when normal resolution has already failed:
//
//   * the workspace package is resolved BY PATH to the very file the pnpm link would have pointed at
//     — byte-identical, no substitution at all; and
//   * the two drivers are resolved to a stub that REFUSES to be used: it survives a load-time
//     destructure and throws by name on the first call, so it can never quietly green a path that
//     really touched a database. Nothing on this path does (the sealed-snapshot runtime flag is off).
//
// On a properly installed checkout (CI) none of these branches runs.
const WORKSPACE_FALLBACKS = Object.freeze({
  '@metasheet/mssql-readonly-utils': path.join(__dirname, '..', '..', '..', 'packages', 'mssql-readonly-utils', 'index.cjs'),
  pg: path.join(__dirname, 'fixtures', 'absent-runtime-driver-stub.cjs'),
  mssql: path.join(__dirname, 'fixtures', 'absent-runtime-driver-stub.cjs'),
})
const originalResolveFilename = Module._resolveFilename
Module._resolveFilename = function resolveWithWorkspaceFallback(request, ...rest) {
  try {
    return originalResolveFilename.call(this, request, ...rest)
  } catch (error) {
    const fallback = WORKSPACE_FALLBACKS[request]
    if (!fallback) throw error
    return originalResolveFilename.call(this, fallback, ...rest)
  }
}

const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const {
  STOCK_PREP_OPERATE,
  STOCK_PREP_READ,
} = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const {
  OBJECT_ID: DECISION_OBJECT_ID,
  FIRST_CUT_CONFLICT_TYPE,
  STATUSES,
} = require(path.join(LIB, 'stock-preparation-confirmation-decisions.cjs'))
const {
  PROJECT_OBJECT_ID,
} = require(path.join(LIB, 'stock-preparation-operator-project-directory.cjs'))
const auditStoreModule = require(path.join(LIB, 'stock-preparation-audit-store.cjs'))
const {
  FEATURE_FLAG: STOCK_PREPARATION_FEATURE_FLAG,
} = require(path.join(LIB, 'sealed-export', 'stock-preparation-runtime-config.cjs'))
const {
  makeFakeProvisioning,
  makeStrictRecordsApi,
  physicalFieldId,
  physicalRow,
} = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))

const DIRECTORY_PATH = '/api/integration/stock-preparation/operator/projects'

const TENANT_A = 'tenant-a'
const STAGING_A = `${TENANT_A}:integration-core`
const PROJECT_SHEET_A = 'sheet_project_a'
const LEDGER_SHEET_A = 'sheet_ledger_a'

const PROJECT_A_NO = '230920006'
const PROJECT_A_NAME = 'RY2注射水缓冲罐部件'
const PROJECT_A_ID = 'stockprep_project_a1'

// THE PROJECTION CANARIES. `owner` is a real field of the frozen project template that the operator
// projection deliberately omits; the second is a column no template knows about at all — the shape a
// customer pack's `ext_` field takes on a real deployment. A response containing either means the row
// was spread rather than projected.
const OWNER_CANARY = 'ZZOWNERCANARYZZ'
const EXTRA_COLUMN_CANARY = 'ZZEXTRACOLUMNCANARYZZ'
const EXTRA_COLUMN_PHYSICAL_ID = 'fld_zzunknowncolumnzz1234'

/** The ten keys an operator project row may carry. A new key here is a widening — restate it. */
const OPERATOR_PROJECT_PROJECTION = Object.freeze([
  'heldLineCount',
  'lastSyncRunId',
  'openExceptionCount',
  'pendingDecisionCount',
  'projectId',
  'projectName',
  'projectNo',
  'projectStatus',
  'readyLineCount',
  'snapshotBatchCount',
])

// ---------------------------------------------------------------------------
// actors
// ---------------------------------------------------------------------------

const OPERATOR_A = Object.freeze({ id: 'u_op_a', tenantId: TENANT_A, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
/** id AND email, different strings, so "which one travels" is decidable rather than coincidental. */
const OPERATOR_A_WITH_EMAIL = Object.freeze({
  id: 'u_op_a',
  email: 'operator-a@example.invalid',
  tenantId: TENANT_A,
  permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE],
})
/** No `id` at all — the fallback the confirm/export routes already use for `actor`. */
const OPERATOR_A_EMAIL_ONLY = Object.freeze({
  email: 'operator-a@example.invalid',
  tenantId: TENANT_A,
  permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE],
})
/** A TENANT-BOUND platform admin holding NO stock-prep grant whatsoever. S-05's subject. */
const PLATFORM_ADMIN_IN_TENANT_A = Object.freeze({ id: 'u_adm_a', tenantId: TENANT_A, roles: ['admin'], permissions: ['integration:admin'] })
const INTEGRATION_ADMIN_IN_TENANT_A = Object.freeze({ id: 'u_iadm_a', tenantId: TENANT_A, permissions: ['integration:admin'] })

// ---------------------------------------------------------------------------
// substrate
// ---------------------------------------------------------------------------

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
    bridgeAgentChecklistStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForApply']),
  }
}

/**
 * Tenant A's project row, carrying BOTH canaries: `owner` (a template field the projection omits) and
 * a physical column no template declares, which is how a customer pack's `ext_` field really arrives.
 * `toLogicalRecord` passes an unknown physical id through untranslated, so a spread would ship it
 * key and all.
 */
function projectRowWithCanaries() {
  const row = physicalRow(STAGING_A, PROJECT_OBJECT_ID, {
    projectId: PROJECT_A_ID,
    sourceProjectNo: PROJECT_A_NO,
    projectName: PROJECT_A_NAME,
    projectStatus: 'active',
    lastSyncRunId: 'run_a1',
    owner: OWNER_CANARY,
  }, 'rec_a1')
  row.sheetId = PROJECT_SHEET_A
  row.data[EXTRA_COLUMN_PHYSICAL_ID] = EXTRA_COLUMN_CANARY
  return row
}

function decisionRow() {
  const row = physicalRow(STAGING_A, DECISION_OBJECT_ID, {
    decisionId: 'decision_a_1',
    projectNo: PROJECT_A_NO,
    conflictType: FIRST_CUT_CONFLICT_TYPE,
    status: STATUSES.PENDING,
    inputFingerprint: 'sha16:0000000000000001',
  }, 'rec_d1')
  row.sheetId = LEDGER_SHEET_A
  return row
}

/** Counts every provisioning/records call, so "refused before any IO" is measured. */
function countedSubstrate() {
  let hostCalls = 0
  const provisioningA = makeFakeProvisioning({
    stagingProjectId: STAGING_A,
    sheetIdByObjectId: { [PROJECT_OBJECT_ID]: PROJECT_SHEET_A, [DECISION_OBJECT_ID]: LEDGER_SHEET_A },
  })
  const recordsA = makeStrictRecordsApi({
    stagingProjectId: STAGING_A,
    objectIdBySheetId: { [PROJECT_SHEET_A]: PROJECT_OBJECT_ID, [LEDGER_SHEET_A]: DECISION_OBJECT_ID },
    rowsBySheet: {
      [PROJECT_SHEET_A]: [projectRowWithCanaries()],
      [LEDGER_SHEET_A]: [decisionRow()],
    },
  })
  function counted(target) {
    return new Proxy(target, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver)
        if (typeof value !== 'function') return value
        return (...args) => {
          hostCalls += 1
          return value.apply(obj, args)
        }
      },
    })
  }
  return {
    hostCallCount: () => hostCalls,
    provisioning: counted({
      findObjectSheet: (input) => provisioningA.findObjectSheet(input),
      resolveFieldIds: (input) => provisioningA.resolveFieldIds(input),
      async ensureObject() { throw new Error('unexpected provisioning write: ensureObject') },
    }),
    records: counted({
      queryRecords: (input) => recordsA.queryRecords(input),
      async createRecord() { throw new Error('unexpected records write: createRecord') },
      async patchRecord() { throw new Error('unexpected records write: patchRecord') },
    }),
  }
}

/**
 * A recording seam. `calls` is what S-03 asserts on; `verdict` is what S-04 varies.
 *
 * The verdict is passed as a ONE-ELEMENT ARRAY rather than directly, because S-04's matrix includes
 * `undefined` — and a default parameter would have quietly turned that case into `{ member: true }`,
 * i.e. into a test that asserts the opposite of what it claims. (It did, on the first run.)
 */
function hostDirectory(box = [{ member: true }]) {
  const [verdict] = box
  const calls = []
  return {
    calls,
    async verifyTenantMembership(input) {
      calls.push(input)
      return verdict
    },
  }
}

/** The ordinary mount: services handed straight to registerIntegrationRoutes. */
function mount({ tenantPrincipalDirectory = hostDirectory(), auditStore } = {}) {
  const routes = new Map()
  const substrate = countedSubstrate()
  const auditAppends = []
  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      multitable: { provisioning: substrate.provisioning, records: substrate.records },
    },
    storage: new Map(),
    config: {},
  }
  const services = baseServices()
  if (auditStore !== null) {
    services.stockPreparationAuditStore = auditStore || {
      async append(entry) {
        auditAppends.push(entry)
        return { ok: true }
      },
    }
  }
  if (tenantPrincipalDirectory) services.tenantPrincipalDirectory = tenantPrincipalDirectory
  httpRoutes.registerIntegrationRoutes({
    context,
    services,
    logger: { info() {}, warn() {}, error() {} },
  })
  return { routes, auditAppends, tenantPrincipalDirectory, hostCallCount: substrate.hostCallCount }
}

/**
 * S-01's mount: the REAL plugin entry point, activated exactly as the host activates it, with the
 * seam offered (or withheld) where the host really offers it — `context.services`.
 */
async function activateRealPlugin({ hostServices } = {}) {
  const entry = require(path.join(__dirname, '..', 'index.cjs'))
  const previousFlag = process.env[STOCK_PREPARATION_FEATURE_FLAG]
  process.env[STOCK_PREPARATION_FEATURE_FLAG] = 'false'
  const routes = new Map()
  const substrate = countedSubstrate()
  const auditRows = []
  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      // The plugin builds its own audit store over this; an INSERT lands here, values-free.
      database: {
        async query(sql, params = []) {
          if (String(sql).startsWith('INSERT')) auditRows.push({ sql: String(sql), params })
          return []
        },
      },
      multitable: { provisioning: substrate.provisioning, records: substrate.records },
    },
    communication: { register() {}, call() {}, on() {}, emit() {} },
    logger: { info() {}, warn() {}, error() {} },
    services: hostServices || {},
    storage: new Map(),
    config: {},
  }
  await entry.activate(context)
  return {
    routes,
    auditRows,
    hostCallCount: substrate.hostCallCount,
    async dispose() {
      await entry.deactivate()
      if (previousFlag === undefined) delete process.env[STOCK_PREPARATION_FEATURE_FLAG]
      else process.env[STOCK_PREPARATION_FEATURE_FLAG] = previousFlag
    },
  }
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    sentBody: undefined,
    sent: false,
    headers: {},
    status(code) { this.statusCode = code; return this },
    _write(payload) {
      this.body = payload
      if (!this.sent) {
        this.sent = true
        this.sentBody = payload
      }
      return this
    },
    json(payload) { return this._write(payload) },
    setHeader(name, value) { this.headers[name] = value; return this },
    send(payload) { return this._write(payload) },
  }
}

async function call(routes, method, routePath, req = {}) {
  const handler = routes.get(`${method.toUpperCase()} ${routePath}`)
  assert.ok(handler, `route ${method} ${routePath} is registered`)
  const res = createResponse()
  await handler({
    user: req.user,
    authenticatedTenantId: req.authenticatedTenantId,
    body: req.body || {},
    query: req.query || {},
    params: req.params || {},
  }, res)
  return res
}

function errorCode(res) {
  return res.body && res.body.error && res.body.error.code
}

let failures = 0
const only = process.env.ONLY_TEST || ''
async function run(name, fn) {
  if (only && !name.includes(only)) return
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}\n    ${error && error.stack ? error.stack : error}`)
  }
}

async function main() {
  // -------------------------------------------------------------------------
  // S-01 THE WIRING, THROUGH THE REAL index.cjs
  // -------------------------------------------------------------------------

  await run('S-01a the plugin passes the HOST-injected seam through to the route, and the read answers', async () => {
    const directory = hostDirectory()
    const harness = await activateRealPlugin({ hostServices: { tenantPrincipalDirectory: directory } })
    try {
      const res = await call(harness.routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
      assert.equal(res.statusCode, 200, `the activated plugin serves the read (${JSON.stringify(res.body && res.body.error)})`)
      assert.equal(res.body.data.tenantId, TENANT_A)
      assert.equal(JSON.stringify(res.body).includes(PROJECT_A_NAME), true, 'and it really carries the values')
      assert.deepEqual(directory.calls, [{ userId: OPERATOR_A.id, tenantId: TENANT_A }],
        'the seam the HOST injected is the one the route asked')
    } finally {
      await harness.dispose()
    }
  })

  await run('S-01b a host that injects NO seam yields the named 501 — never a read on req.user.tenantId', async () => {
    const harness = await activateRealPlugin({ hostServices: {} })
    try {
      const res = await call(harness.routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
      assert.equal(res.statusCode, 501)
      assert.equal(errorCode(res), 'OPERATOR_SCOPE_DIRECTORY_UNAVAILABLE')
      assert.equal(harness.hostCallCount(), 0, 'and it costs no multitable IO')
      assert.equal(JSON.stringify(res.body).includes(PROJECT_A_NAME), false)
    } finally {
      await harness.dispose()
    }
  })

  // -------------------------------------------------------------------------
  // S-02 THE RESPONSE PROJECTION IS KEY-PINNED
  // -------------------------------------------------------------------------

  await run('S-02a every project row carries EXACTLY the ten-key projection', async () => {
    const { routes } = mount()
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(Object.keys(res.body.data).sort(), [
      'directoryReady',
      'ledgerReady',
      'pendingProjectCount',
      'projectCount',
      'projects',
      'tenantId',
    ])
    assert.ok(res.body.data.projects.length > 0, 'precondition: there is a row to pin')
    for (const project of res.body.data.projects) {
      assert.deepEqual(Object.keys(project).sort(), OPERATOR_PROJECT_PROJECTION,
        'a row must be BUILT key by key, never spread from the stored record')
    }
  })

  await run('S-02b neither the omitted template field NOR an unknown column reaches any byte', async () => {
    const { routes } = mount()
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
    const serialized = JSON.stringify(res.body)
    // The values...
    assert.equal(serialized.includes(OWNER_CANARY), false, 'owner is a stored value this route does not project')
    assert.equal(serialized.includes(EXTRA_COLUMN_CANARY), false, 'nor does it project a column no template declares')
    // ...and the field NAMES, which are themselves a disclosure about the customer's schema.
    assert.equal(serialized.includes('"owner"'), false)
    assert.equal(serialized.includes(EXTRA_COLUMN_PHYSICAL_ID), false)
    // The canaries really were in the substrate — otherwise this guard is vacuous.
    const seeded = projectRowWithCanaries()
    assert.equal(seeded.data[physicalFieldId(STAGING_A, PROJECT_OBJECT_ID, 'owner')], OWNER_CANARY)
    assert.equal(seeded.data[EXTRA_COLUMN_PHYSICAL_ID], EXTRA_COLUMN_CANARY)
    // ...and the feature itself still works, so this is not passing because nothing was returned.
    assert.equal(serialized.includes(PROJECT_A_NAME), true)
  })

  // -------------------------------------------------------------------------
  // S-03 THE SEAM IS ASKED THE RIGHT QUESTION
  // -------------------------------------------------------------------------

  await run('S-03a the seam receives the principal id and the SCOPED tenant, not the request\'s', async () => {
    const directory = hostDirectory()
    const { routes } = mount({ tenantPrincipalDirectory: directory })
    const res = await call(routes, 'GET', DIRECTORY_PATH, {
      user: OPERATOR_A_WITH_EMAIL,
      authenticatedTenantId: TENANT_A,
      // A request-carried tenant equal to the caller's own: compatibility, never a selector. It must
      // not be what the host is asked about, even when the two happen to agree.
      query: { tenantId: TENANT_A },
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(directory.calls, [{ userId: OPERATOR_A_WITH_EMAIL.id, tenantId: TENANT_A }])
    // `id` wins over `email` when both exist: a seam asked about the email would be asking the host
    // about a principal handle the rest of this route family does not key on.
    assert.notEqual(directory.calls[0].userId, OPERATOR_A_WITH_EMAIL.email)
    // Exactly the two keys the port accepts — the boundary refuses a third, so a route that added one
    // would be silently denied rather than loudly wrong.
    assert.deepEqual(Object.keys(directory.calls[0]).sort(), ['tenantId', 'userId'])
  })

  await run('S-03b a principal with only an email travels under the email — the documented fallback', async () => {
    const directory = hostDirectory()
    const { routes } = mount({ tenantPrincipalDirectory: directory })
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A_EMAIL_ONLY })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(directory.calls, [{ userId: OPERATOR_A_EMAIL_ONLY.email, tenantId: TENANT_A }])
  })

  await run('S-03c a principal with NO stable handle at all is refused before the host is asked', async () => {
    const directory = hostDirectory()
    const { routes, hostCallCount } = mount({ tenantPrincipalDirectory: directory })
    const res = await call(routes, 'GET', DIRECTORY_PATH, {
      user: { tenantId: TENANT_A, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] },
    })
    assert.equal(res.statusCode, 403)
    assert.equal(errorCode(res), 'OPERATOR_SCOPE_PRINCIPAL_UNKNOWN')
    assert.equal(directory.calls.length, 0, 'there is no question to ask about a principal with no name')
    assert.equal(hostCallCount(), 0)
  })

  // -------------------------------------------------------------------------
  // S-04 A TRUTHY VERDICT IS NOT A VERDICT
  // -------------------------------------------------------------------------

  const MALFORMED_VERDICTS = [
    ['undefined', undefined],
    ['null', null],
    ['the string "yes"', 'yes'],
    ['the number 1', 1],
    ['an empty object', {}],
    ['{ member: 1 }', { member: 1 }],
    ["{ member: 'true' }", { member: 'true' }],
    ["{ member: 'no' }", { member: 'no' }],
    ['{ member: [true] }', { member: [true] }],
    ['{ member: {} }', { member: {} }],
    ['{ member: false }', { member: false }],
    ['{ membership: true }', { membership: true }],
    ['an array', [{ member: true }]],
  ]
  for (const [label, verdict] of MALFORMED_VERDICTS) {
    await run(`S-04 a verdict of ${label} is a REFUSAL, not a truthy pass`, async () => {
      const { routes, hostCallCount } = mount({ tenantPrincipalDirectory: hostDirectory([verdict]) })
      const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
      assert.equal(res.statusCode, 403, `${label} must not be read as membership`)
      assert.equal(errorCode(res), 'OPERATOR_SCOPE_TENANT_MEMBERSHIP_DENIED')
      assert.equal(hostCallCount(), 0, 'and nothing is read on the strength of it')
      assert.equal(JSON.stringify(res.body).includes(PROJECT_A_NAME), false)
    })
  }

  await run('S-04+ …and the ONE well-formed affirmative really is served (the positive control)', async () => {
    const { routes } = mount({ tenantPrincipalDirectory: hostDirectory([{ member: true }]) })
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
    assert.equal(res.statusCode, 200, 'exactly `{ member: true }` passes — so S-04 is not refusing everything')
  })

  // -------------------------------------------------------------------------
  // S-05 THE PLATFORM-ADMIN CONVENTION, PINNED DELIBERATELY
  // -------------------------------------------------------------------------

  await run('S-05 a TENANT-BOUND platform admin with NO stock-prep grant is served their OWN tenant', async () => {
    // INTENDED, and stated as such: `satisfiesStockPrepAccess` short-circuits on `role:admin` /
    // `integration:admin`, which is this plugin's long-standing convention for every stock-prep code
    // — this route inherits it rather than inventing a new answer. The two limits that keep it sound
    // are asserted elsewhere and named here: the admin must have a tenant OF THEIR OWN (a TENANTLESS
    // platform admin is refused — directory suite G-04, and value-read-scope V-04), and the HOST must
    // still vouch for the pairing (S-04 above), so this is "an admin of tenant A sees tenant A", never
    // "an admin sees everything".
    for (const admin of [PLATFORM_ADMIN_IN_TENANT_A, INTEGRATION_ADMIN_IN_TENANT_A]) {
      const directory = hostDirectory()
      const { routes } = mount({ tenantPrincipalDirectory: directory })
      const res = await call(routes, 'GET', DIRECTORY_PATH, { user: admin })
      assert.equal(res.statusCode, 200, `${admin.id} holds no stock-prep code and is still served`)
      assert.equal(res.body.data.tenantId, TENANT_A)
      assert.deepEqual(directory.calls, [{ userId: admin.id, tenantId: TENANT_A }],
        'the host still had to vouch — admin is not an exemption from membership')
    }
  })

  await run('S-05b …and the host CAN refuse an admin: the short-circuit is on the permission, not on the tenant', async () => {
    const { routes } = mount({ tenantPrincipalDirectory: hostDirectory([{ member: false }]) })
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: PLATFORM_ADMIN_IN_TENANT_A })
    assert.equal(res.statusCode, 403)
    assert.equal(errorCode(res), 'OPERATOR_SCOPE_TENANT_MEMBERSHIP_DENIED')
  })

  // -------------------------------------------------------------------------
  // S-06 NO PROJECT NUMBER ON THE TRAIL, BY CHOICE
  // -------------------------------------------------------------------------

  await run('S-06 the audit row carries no project number, though the store would have accepted one', async () => {
    const { routes, auditAppends } = mount()
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
    assert.equal(res.statusCode, 200)
    assert.equal(auditAppends.length, 1)
    const entry = auditAppends[0]
    // The audit store's own validator WOULD have taken it — `230920006` is a perfectly legal
    // SAFE_STRING. So its absence is this route's decision, not a rule it merely failed to break.
    const SAFE_STRING_PATTERN = auditStoreModule.__internals && auditStoreModule.__internals.SAFE_STRING_PATTERN
    assert.ok(SAFE_STRING_PATTERN, 'the audit store exposes its value pattern')
    assert.equal(SAFE_STRING_PATTERN.test(PROJECT_A_NO), true, 'a pure-digit project number is SAFE_STRING-shaped')
    assert.equal(entry.projectId, undefined, 'this read is about a whole tenant, so no project handle belongs on it')
    assert.equal(entry.subjectId, undefined)
    // ...and no project number anywhere else in the row either.
    assert.equal(JSON.stringify(entry).includes(PROJECT_A_NO), false)
    // The ruling this pins: on THIS route the number would be a VALUE (the answer itself), not a
    // handle naming what the request was about — unlike prep_line_export, whose request IS one
    // project and whose `projectId` is therefore the navigation handle it looks like.
    assert.equal(entry.action, 'project_directory_read')
  })

  // -------------------------------------------------------------------------
  // S-07 NO AUDIT STORE, NO VALUES
  // -------------------------------------------------------------------------

  await run('S-07 an ABSENT audit store 501s the read — the trail is not optional for a value plane', async () => {
    const { routes, hostCallCount } = mount({ auditStore: null })
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
    assert.equal(res.statusCode, 501)
    assert.equal(errorCode(res), 'AUDIT_STORE_UNAVAILABLE')
    assert.equal(hostCallCount(), 0, 'refused before any read, so no values are even fetched')
    assert.equal(JSON.stringify(res.body).includes(PROJECT_A_NAME), false)
  })

  await run('S-07b an audit store whose append is not a function is the same refusal', async () => {
    const { routes } = mount({ auditStore: { append: 'not-a-function' } })
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
    assert.equal(res.statusCode, 501)
    assert.equal(errorCode(res), 'AUDIT_STORE_UNAVAILABLE')
  })

  if (failures > 0) {
    console.error(`\n${failures} tripwire(s) FAILED`)
    process.exitCode = 1
  } else {
    console.log('\nall operator scope tripwires passed')
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
