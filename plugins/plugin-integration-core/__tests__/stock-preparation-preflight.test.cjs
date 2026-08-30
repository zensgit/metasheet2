'use strict'

// STOCK-PREPARATION DEPLOYMENT PREFLIGHT — the suite.
//
// The route exists because of two real failures on the first customer deployment, in one session:
//
//   INCIDENT 1  an operator invented a sandbox objectId and was refused for being outside the
//               `plm_stock_preparation_sandbox` namespace, by a refusal that did not name the
//               namespace.
//   INCIDENT 2  two people configured the same instance in parallel onto DIFFERENT sandbox
//               objectIds, so the installed pack declared one target while the table that existed
//               carried another name. The dry-run failed with a missing-target error that never
//               mentions the PACK'S OWN declared name.
//
// P-05 is the regression that would have saved that session: a pack declaring target X while table
// Y exists must produce a blocker whose FIX QUOTES X — and must not quote Y, because quoting the
// table that happens to exist is exactly the wrong instruction.
//
// Guards (each RED-witnessed by mutation; see the PR body's mutation table):
//   P-01 the route is registered and gated on stock-prep:read, with platform admin satisfying it
//   P-02 a fully configured deployment: ready true, blockers empty, posture still present
//   P-03 ledger missing            -> blocker + the exact ensure call
//   P-04 no customer pack          -> blocker naming the packs-file env var
//   P-05 declared target missing   -> blocker whose fix quotes the PACK'S declared objectId  (INCIDENT 2)
//   P-06 ext mapping missing       -> blocker naming the mapping-file env var
//   P-07 allowlist mismatch        -> blocker + the recomputed allowlist line
//   P-08 sandbox mode off          -> blocker + `STOCK_PREP_SANDBOX_MODE=true`
//   P-09 fences are POSTURE: reported, never blockers, and never carrying a fix
//   P-10 READ-ONLY: no provisioning/records call outside the read set
//   P-11 VALUES-FREE: no connection-ish input reaches the response
//   P-12 blockers are ordered most-blocking first, and every code is in the frozen vocabulary
//   P-13 the env var names the fix lines quote really are the names the owning modules read
//   P-14 the request cannot steer the target (no projectId/objectId query surface)
//
// Hermetic: no DB, no network. Every service the route module requires is stubbed to throw.

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const REPO_ROOT = path.join(__dirname, '..', '..', '..')

const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const {
  CUSTOMER_PACKS_PATH_ENV,
  EXT_FIELD_MAPPING_PATH_ENV,
  B2A_REGISTRY_PATH_ENV,
  SANDBOX_MODE_ENV,
  SANDBOX_TARGET_OBJECT_IDS_ENV,
  SANDBOX_OBJECT_ID_NAMESPACE_PREFIX,
  PREFLIGHT_BLOCKER_CODES,
  PREFLIGHT_BLOCKER_CODE_ORDER,
  PREFLIGHT_ROUTE_PATH,
} = require(path.join(LIB, 'stock-preparation-preflight.cjs'))
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const {
  STOCK_PREP_READ,
  STOCK_PREP_OPERATE,
} = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { OUTBOUND_HTTP_WRITE_TARGETS_ENV } = require(path.join(LIB, 'outbound-http-write-gate.cjs'))

const TENANT_ID = 'tenant-a'
const STAGING_PROJECT_ID = `${TENANT_ID}:integration-core`

const LEDGER_OBJECT_ID = STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE.objectId
const LEDGER_FIELD_IDS = STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE.fields.map((field) => field.id)
const CANONICAL_OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
const CANONICAL_FIELD_IDS = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => field.id)

// INCIDENT 2, as data. `DECLARED` is what the pack says; `EXISTING` is the table two people in
// parallel actually created. Both are legal sandbox ids — that is what made the divergence silent.
const DECLARED_SANDBOX_OBJECT_ID = 'plm_stock_preparation_sandbox_r6_trial'
const EXISTING_SANDBOX_OBJECT_ID = 'plm_stock_preparation_sandbox_trial'

const PACK_ID = 'preflight-suite-pack'
const EXT_PLM = 'ext_legacyRowId'
const EXT_HUMAN = 'ext_blankLength'

function packDeclaring(targetObjectId) {
  return {
    packId: PACK_ID,
    packVersion: 1,
    label: 'preflight suite pack',
    ...(targetObjectId === undefined ? {} : { targetObjectId }),
    extensionFields: [
      { id: EXT_PLM, label: '旧系统ID', type: 'string', ownership: 'plm_system' },
      { id: EXT_HUMAN, label: '毛胚长度', type: 'number', ownership: 'human_preserved' },
    ],
    optionSets: [],
    roleViews: [],
  }
}

const EXT_FIELD_MAPPING_CONFIG = Object.freeze({
  packId: PACK_ID,
  mappingId: 'preflight-suite-mapping',
  mappingVersion: 1,
  mappings: [{ sourceColumn: 'LegacyRowId', target: EXT_PLM }],
})

// ---------------------------------------------------------------------------
// actors
// ---------------------------------------------------------------------------

const ANONYMOUS = undefined
const LOGGED_IN = Object.freeze({ id: 'u_plain', tenantId: TENANT_ID, permissions: [] })
const INTEGRATION_READER = Object.freeze({ id: 'u_int_reader', tenantId: TENANT_ID, permissions: ['integration:read'] })
const INTEGRATION_WRITER = Object.freeze({ id: 'u_int_writer', tenantId: TENANT_ID, permissions: ['integration:write'] })
const ORPHAN_OPERATE = Object.freeze({ id: 'u_op_orphan', tenantId: TENANT_ID, permissions: [STOCK_PREP_OPERATE] })
const OPERATOR_READ = Object.freeze({ id: 'u_op_read', tenantId: TENANT_ID, permissions: [STOCK_PREP_READ] })
const PLATFORM_ADMIN = Object.freeze({ id: 'u_admin', tenantId: TENANT_ID, roles: ['admin'], permissions: ['integration:admin'] })

// ---------------------------------------------------------------------------
// substrate
// ---------------------------------------------------------------------------

// Byte-for-byte the platform derivation (multitable/provisioning.ts getObjectFieldId).
function physicalFieldId(projectId, objectId, fieldId) {
  const digest = createHash('sha1').update([projectId, objectId, fieldId].join(':')).digest('hex').slice(0, 24)
  return `fld_${digest}`.slice(0, 50)
}

/**
 * The provisioning surface, recording EVERY call BY NAME — including the write primitives, which the
 * preflight must never touch. P-10 states the read-only proof as "no call outside the read set",
 * not "these specific writes did not happen", so a future write primitive is caught by default.
 *
 * `objects` is `{ [objectId]: { fields: 'all' | string[] } }`. An absent objectId is a missing sheet;
 * a partial `fields` list is the "exists but incomplete" shape.
 */
const PROVISIONING_READ_METHODS = Object.freeze(['findObjectSheet', 'resolveFieldIds', 'getFieldId', 'readObjectFieldsContent'])
const PROVISIONING_WRITE_METHODS = Object.freeze(['ensureObject', 'ensureMissingObjectFields', 'patchObjectFieldProperty', 'ensureView'])

function createFakeProvisioning({ objects = {} } = {}) {
  const calls = []
  const api = {
    calls,
    async findObjectSheet({ projectId, objectId } = {}) {
      calls.push('findObjectSheet')
      if (projectId !== STAGING_PROJECT_ID) return null
      return objects[objectId] ? { id: `sheet_${objectId}`, baseId: null, name: objectId, description: null } : null
    },
    async resolveFieldIds({ projectId, objectId, fieldIds } = {}) {
      calls.push('resolveFieldIds')
      const entry = objects[objectId]
      if (!entry) return {}
      const requested = Array.isArray(fieldIds) ? fieldIds : []
      const present = entry.fields === 'all' ? null : new Set(entry.fields)
      const out = {}
      for (const fieldId of requested) {
        if (present && !present.has(fieldId)) continue
        out[fieldId] = physicalFieldId(projectId, objectId, fieldId)
      }
      return out
    },
    getFieldId(projectId, objectId, fieldId) {
      calls.push('getFieldId')
      return physicalFieldId(projectId, objectId, fieldId)
    },
    async readObjectFieldsContent() {
      calls.push('readObjectFieldsContent')
      return {}
    },
  }
  // The write half is present and LOUD: reaching one is a failure, not a silent no-op.
  for (const method of PROVISIONING_WRITE_METHODS) {
    api[method] = async () => {
      calls.push(method)
      throw new Error(`preflight must not call provisioning.${method}`)
    }
  }
  return api
}

function createFakeRecordsApi() {
  const calls = []
  const api = { calls }
  for (const method of ['createRecord', 'patchRecord', 'deleteRecord', 'runStockPreparationPersistUnitOfWork']) {
    api[method] = async () => {
      calls.push(method)
      throw new Error(`preflight must not call records.${method}`)
    }
  }
  api.queryRecords = async () => {
    calls.push('queryRecords')
    return []
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
 * Mount the plugin's routes over a fake host.
 *
 * `objects` decides which managed multitable objects EXIST; `packs` / `extFieldMapping` are the
 * server-held config the routes build once at registration; `env` is applied to `process.env` for
 * the duration of the call (the route reads the sandbox gate from the live environment, exactly as
 * the apply gate does).
 */
function mount({ packs, extFieldMapping, objects, config = {} } = {}) {
  const routes = new Map()
  const provisioning = createFakeProvisioning({ objects })
  const records = createFakeRecordsApi()
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
    config: {
      ...config,
      ...(packs === undefined ? {} : { stockPreparationCustomerPacks: packs }),
      ...(extFieldMapping === undefined ? {} : { stockPreparationExtFieldMapping: extFieldMapping }),
    },
  }
  httpRoutes.registerIntegrationRoutes({
    context,
    services: baseServices(),
    logger: { info() {}, warn() {}, error() {} },
  })
  return { routes, provisioning, records, context }
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
  await handler({ user: req.user, body: req.body || {}, query: req.query || {}, params: req.params || {} }, res)
  assert.notEqual(res.body, undefined, `${method} ${routePath} produced a body`)
  return res
}

/**
 * Run one preflight with a scoped environment, restored afterwards whatever happens.
 *
 * `user` is read by KEY PRESENCE, not by a destructuring default: the anonymous actor IS `undefined`,
 * and a default would have silently promoted every anonymous case to the read-tier operator.
 */
async function preflight(harness, options = {}) {
  const user = Object.prototype.hasOwnProperty.call(options, 'user') ? options.user : OPERATOR_READ
  const { query = {}, env = {} } = options
  const saved = new Map()
  const managed = [
    SANDBOX_MODE_ENV,
    SANDBOX_TARGET_OBJECT_IDS_ENV,
    OUTBOUND_HTTP_WRITE_TARGETS_ENV,
    ...Object.keys(env),
  ]
  for (const key of managed) saved.set(key, process.env[key])
  try {
    for (const key of managed) delete process.env[key]
    for (const [key, value] of Object.entries(env)) process.env[key] = value
    return await call(harness.routes, 'GET', PREFLIGHT_ROUTE_PATH, { user, query })
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** The provisioning state of a deployment where everything the pack declares really exists. */
function readyObjects(targetObjectId) {
  return {
    [LEDGER_OBJECT_ID]: { fields: 'all' },
    [targetObjectId]: { fields: 'all' },
  }
}

/** The env of a deployment whose sandbox write authorization is open for `objectIds`. */
function sandboxEnv(objectIds) {
  return {
    [SANDBOX_MODE_ENV]: 'true',
    [SANDBOX_TARGET_OBJECT_IDS_ENV]: objectIds.join(','),
  }
}

/** A fully green deployment, as one harness + one env — the baseline every RED case perturbs. */
function greenDeployment() {
  return {
    harness: mount({
      packs: { [PACK_ID]: packDeclaring(DECLARED_SANDBOX_OBJECT_ID) },
      extFieldMapping: EXT_FIELD_MAPPING_CONFIG,
      objects: readyObjects(DECLARED_SANDBOX_OBJECT_ID),
    }),
    env: sandboxEnv([DECLARED_SANDBOX_OBJECT_ID]),
  }
}

/** Every string ANYWHERE in a response — keys included, at any depth. See P-11 for why not JSON text. */
function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const entry of value) collectStrings(entry, out)
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      out.push(key)
      collectStrings(entry, out)
    }
  }
  return out
}

function blockerByCode(body, code) {
  const found = body.data.blockers.find((entry) => entry.code === code)
  assert.ok(found, `expected a blocker with code ${code}; got ${JSON.stringify(body.data.blockers.map((b) => b.code))}`)
  return found
}

// ---------------------------------------------------------------------------
// P-01 — the route, and its gate
// ---------------------------------------------------------------------------

async function routeIsRegisteredAndReadGated() {
  assert.ok(
    httpRoutes.ROUTES.some(([method, routePath]) => method === 'GET' && routePath === PREFLIGHT_ROUTE_PATH),
    'P-01: the preflight is in the route table',
  )

  const { harness, env } = greenDeployment()

  for (const user of [ANONYMOUS, LOGGED_IN, INTEGRATION_READER, INTEGRATION_WRITER, ORPHAN_OPERATE]) {
    const res = await preflight(harness, { user, env })
    assert.equal(res.body.ok, false, `P-01: ${user ? user.id : 'anonymous'} is refused`)
    assert.ok([401, 403].includes(res.statusCode), `P-01: ${user ? user.id : 'anonymous'} -> ${res.statusCode}`)
  }
  // The gate stands BEFORE any host work.
  assert.deepEqual(harness.provisioning.calls, [], 'P-01: a refused caller reaches no host API')

  for (const user of [OPERATOR_READ, PLATFORM_ADMIN]) {
    const res = await preflight(harness, { user, env })
    assert.equal(res.statusCode, 200, `P-01: ${user.id} is served`)
    assert.equal(res.body.ok, true)
  }
}

// ---------------------------------------------------------------------------
// P-02 — the green case
// ---------------------------------------------------------------------------

async function fullyConfiguredDeploymentIsReady() {
  const { harness, env } = greenDeployment()
  const res = await preflight(harness, { env })

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.ready, true, 'P-02: a fully configured deployment is ready')
  assert.deepEqual(res.body.data.blockers, [], 'P-02: with an EMPTY blocker list')
  assert.equal(res.body.data.blockerCount, 0)
  // ...and the posture section is still there. "ready" does not mean "nothing left to say".
  assert.ok(res.body.data.posture, 'P-02: posture is present on a green deployment')
  for (const fence of ['productionApply', 'k3ExternalWrite', 'b2aTrialRegistry', 'outboundHttpWrite']) {
    assert.ok(res.body.data.posture[fence], `P-02: posture reports ${fence}`)
  }
  assert.equal(res.body.data.checks.customerPacks.packCount, 1)
  assert.deepEqual(res.body.data.checks.declaredTargets.map((entry) => entry.objectId), [DECLARED_SANDBOX_OBJECT_ID])
  assert.equal(res.body.data.checks.declaredTargets[0].ready, true)
}

// ---------------------------------------------------------------------------
// P-03 — the confirmation-decision ledger
// ---------------------------------------------------------------------------

async function missingLedgerNamesItsEnsureCall() {
  const harness = mount({
    packs: { [PACK_ID]: packDeclaring(DECLARED_SANDBOX_OBJECT_ID) },
    extFieldMapping: EXT_FIELD_MAPPING_CONFIG,
    // The ledger is absent: it is created ON DEMAND and is NOT in the SQL migration chain, which is
    // exactly the thing no deployment step told the operator.
    objects: { [DECLARED_SANDBOX_OBJECT_ID]: { fields: 'all' } },
  })
  const res = await preflight(harness, { env: sandboxEnv([DECLARED_SANDBOX_OBJECT_ID]) })

  assert.equal(res.body.data.ready, false)
  const found = blockerByCode(res.body, PREFLIGHT_BLOCKER_CODES.CONFIRMATION_LEDGER_NOT_READY)
  assert.equal(found.fix.kind, 'http')
  assert.equal(found.fix.method, 'POST')
  assert.equal(found.fix.path, '/api/integration/stock-preparation/confirmation-decisions/ensure')
  assert.deepEqual(found.fix.body, {})
  assert.equal(found.fix.run, 'POST /api/integration/stock-preparation/confirmation-decisions/ensure {}')
  assert.ok(found.what.includes(LEDGER_OBJECT_ID), 'P-03: the blocker names the ledger objectId')
  assert.equal(res.body.data.checks.confirmationLedger.ready, false)

  // An INCOMPLETE ledger is a blocker too — same code, same ensure call, different `what`.
  const partial = mount({
    packs: { [PACK_ID]: packDeclaring(DECLARED_SANDBOX_OBJECT_ID) },
    extFieldMapping: EXT_FIELD_MAPPING_CONFIG,
    objects: {
      [LEDGER_OBJECT_ID]: { fields: LEDGER_FIELD_IDS.slice(0, LEDGER_FIELD_IDS.length - 1) },
      [DECLARED_SANDBOX_OBJECT_ID]: { fields: 'all' },
    },
  })
  const partialRes = await preflight(partial, { env: sandboxEnv([DECLARED_SANDBOX_OBJECT_ID]) })
  const partialBlocker = blockerByCode(partialRes.body, PREFLIGHT_BLOCKER_CODES.CONFIRMATION_LEDGER_NOT_READY)
  assert.equal(partialBlocker.detail.missingFieldCount, 1)
  assert.equal(partialRes.body.data.checks.confirmationLedger.present, true)
}

// ---------------------------------------------------------------------------
// P-04 — no customer pack configured
// ---------------------------------------------------------------------------

async function noCustomerPackNamesTheEnvVar() {
  const harness = mount({ objects: readyObjects(DECLARED_SANDBOX_OBJECT_ID) })
  const res = await preflight(harness, { env: sandboxEnv([DECLARED_SANDBOX_OBJECT_ID]) })

  assert.equal(res.body.data.ready, false)
  const found = blockerByCode(res.body, PREFLIGHT_BLOCKER_CODES.CUSTOMER_PACK_NOT_CONFIGURED)
  assert.equal(found.fix.kind, 'env')
  assert.equal(found.fix.name, CUSTOMER_PACKS_PATH_ENV)
  assert.equal(found.fix.placeholder, true, 'P-04: the path is the operator\'s to supply, and is marked as such')
  assert.ok(found.fix.run.startsWith(`${CUSTOMER_PACKS_PATH_ENV}=`), 'P-04: the fix is a literal KEY=value line')
  assert.ok(found.what.includes(CUSTOMER_PACKS_PATH_ENV), 'P-04: the blocker names the env var')
  assert.equal(res.body.data.checks.customerPacks.configured, false)
  assert.deepEqual(res.body.data.checks.declaredTargets, [], 'P-04: with no pack there is no declared target to check')
}

// ---------------------------------------------------------------------------
// P-05 — INCIDENT 2. THE regression this whole route exists for.
// ---------------------------------------------------------------------------

async function packDeclaredTargetIsCheckedAndQuoted() {
  // The pack declares X. The table that two people in parallel actually created is Y. Both are legal
  // sandbox ids, so nothing refused either of them — the deployment simply did not work, with an
  // error that named neither name.
  const harness = mount({
    packs: { [PACK_ID]: packDeclaring(DECLARED_SANDBOX_OBJECT_ID) },
    extFieldMapping: EXT_FIELD_MAPPING_CONFIG,
    objects: {
      [LEDGER_OBJECT_ID]: { fields: 'all' },
      [EXISTING_SANDBOX_OBJECT_ID]: { fields: 'all' },
    },
  })
  const res = await preflight(harness, { env: sandboxEnv([EXISTING_SANDBOX_OBJECT_ID]) })

  assert.equal(res.body.data.ready, false, 'P-05: a pack pointed at a table that does not exist is NOT ready')
  const found = blockerByCode(res.body, PREFLIGHT_BLOCKER_CODES.PACK_TARGET_MISSING)

  // THE assertion. The fix quotes the PACK'S declared objectId, in the body and in the runnable line.
  assert.equal(found.fix.kind, 'http')
  assert.equal(found.fix.method, 'POST')
  assert.equal(found.fix.path, '/api/integration/stock-preparation/sandbox-target/ensure')
  assert.deepEqual(found.fix.body, { objectId: DECLARED_SANDBOX_OBJECT_ID })
  assert.equal(
    found.fix.run,
    `POST /api/integration/stock-preparation/sandbox-target/ensure {"objectId":"${DECLARED_SANDBOX_OBJECT_ID}"}`,
    'P-05: the runnable fix line quotes the pack\'s declared objectId verbatim',
  )
  assert.ok(found.what.includes(DECLARED_SANDBOX_OBJECT_ID), 'P-05: the human line names the declared id too')
  assert.ok(found.what.includes(PACK_ID), 'P-05: ...and which pack declared it')

  // And it must NOT hand the operator the name of the table that happens to exist. Pointing the pack
  // at Y is the wrong repair — it is how the two configurations diverged in the first place.
  assert.ok(
    !JSON.stringify(found).includes(EXISTING_SANDBOX_OBJECT_ID),
    'P-05: the blocker never quotes the table that happens to exist under another name',
  )

  // The check surface carries the same fact, machine-readably.
  const target = res.body.data.checks.declaredTargets.find((entry) => entry.objectId === DECLARED_SANDBOX_OBJECT_ID)
  assert.ok(target, 'P-05: the declared target is the one inspected')
  assert.equal(target.ready, false)
  assert.deepEqual(target.declaredByPackIds, [PACK_ID])

  // A pack declaring the CANONICAL target (i.e. omitting targetObjectId) gets the canonical ensure.
  const canonical = mount({
    packs: { [PACK_ID]: packDeclaring(undefined) },
    extFieldMapping: EXT_FIELD_MAPPING_CONFIG,
    objects: { [LEDGER_OBJECT_ID]: { fields: 'all' } },
  })
  const canonicalRes = await preflight(canonical, {})
  const canonicalBlocker = blockerByCode(canonicalRes.body, PREFLIGHT_BLOCKER_CODES.PACK_TARGET_MISSING)
  assert.equal(canonicalBlocker.fix.path, '/api/integration/stock-preparation/target/ensure')
  assert.ok(canonicalBlocker.what.includes(CANONICAL_OBJECT_ID))

  // A declared target that EXISTS but is missing the pack's own `ext_` columns is a different
  // blocker with a different fix: install the pack, which adds them additively.
  const incomplete = mount({
    packs: { [PACK_ID]: packDeclaring(DECLARED_SANDBOX_OBJECT_ID) },
    extFieldMapping: EXT_FIELD_MAPPING_CONFIG,
    objects: {
      [LEDGER_OBJECT_ID]: { fields: 'all' },
      [DECLARED_SANDBOX_OBJECT_ID]: { fields: CANONICAL_FIELD_IDS },
    },
  })
  const incompleteRes = await preflight(incomplete, { env: sandboxEnv([DECLARED_SANDBOX_OBJECT_ID]) })
  const incompleteBlocker = blockerByCode(incompleteRes.body, PREFLIGHT_BLOCKER_CODES.PACK_TARGET_INCOMPLETE)
  assert.equal(incompleteBlocker.fix.path, `/api/integration/stock-preparation/customer-packs/${PACK_ID}/install`)
  assert.deepEqual(incompleteBlocker.fix.body, { mode: 'install' })
  assert.deepEqual(incompleteBlocker.detail.missingFields.slice().sort(), [EXT_HUMAN, EXT_PLM].sort())
}

// ---------------------------------------------------------------------------
// P-06 — the source -> `ext_` field mapping
// ---------------------------------------------------------------------------

async function missingExtFieldMappingNamesTheEnvVar() {
  const harness = mount({
    packs: { [PACK_ID]: packDeclaring(DECLARED_SANDBOX_OBJECT_ID) },
    objects: readyObjects(DECLARED_SANDBOX_OBJECT_ID),
  })
  const res = await preflight(harness, { env: sandboxEnv([DECLARED_SANDBOX_OBJECT_ID]) })

  assert.equal(res.body.data.ready, false)
  const found = blockerByCode(res.body, PREFLIGHT_BLOCKER_CODES.EXT_FIELD_MAPPING_NOT_CONFIGURED)
  assert.equal(found.fix.kind, 'env')
  assert.equal(found.fix.name, EXT_FIELD_MAPPING_PATH_ENV)
  assert.ok(found.fix.run.startsWith(`${EXT_FIELD_MAPPING_PATH_ENV}=`))
  assert.ok(found.what.includes(EXT_FIELD_MAPPING_PATH_ENV))
  assert.equal(res.body.data.checks.extFieldMapping.configured, false)
}

// ---------------------------------------------------------------------------
// P-07 / P-08 — sandbox WRITE authorization
// ---------------------------------------------------------------------------

async function sandboxAllowlistMismatchIsItsOwnBlocker() {
  // The confusing LATE failure: everything installs, everything dry-runs, and the apply is refused
  // because the declared target is not in the write allowlist. Two independent authorizations.
  const { harness } = greenDeployment()
  const res = await preflight(harness, { env: sandboxEnv([EXISTING_SANDBOX_OBJECT_ID]) })

  assert.equal(res.body.data.ready, false, 'P-07: an installable deployment whose rows cannot be written is NOT ready')
  const found = blockerByCode(res.body, PREFLIGHT_BLOCKER_CODES.SANDBOX_ALLOWLIST_MISSING_TARGET)
  assert.equal(found.fix.kind, 'env')
  assert.equal(found.fix.name, SANDBOX_TARGET_OBJECT_IDS_ENV)
  assert.equal(found.fix.placeholder, false, 'P-07: the server knows every member of this list, so nothing is left blank')
  // The value is the EXISTING allowlist plus the missing declared target — one paste, nothing dropped.
  assert.equal(found.fix.value, `${EXISTING_SANDBOX_OBJECT_ID},${DECLARED_SANDBOX_OBJECT_ID}`)
  assert.equal(found.fix.run, `${SANDBOX_TARGET_OBJECT_IDS_ENV}=${EXISTING_SANDBOX_OBJECT_ID},${DECLARED_SANDBOX_OBJECT_ID}`)
  assert.ok(found.what.includes(DECLARED_SANDBOX_OBJECT_ID), 'P-07: the blocker names the target that is missing from the list')
  assert.ok(
    found.what.includes(SANDBOX_OBJECT_ID_NAMESPACE_PREFIX),
    'P-07: ...and names the namespace whose absence caused incident 1',
  )
  assert.deepEqual(found.detail.missingFromAllowlist, [DECLARED_SANDBOX_OBJECT_ID])
  assert.deepEqual(res.body.data.checks.sandboxWriteAuthorization.unlistedDeclaredTargetObjectIds, [DECLARED_SANDBOX_OBJECT_ID])
}

async function sandboxModeOffIsItsOwnBlocker() {
  const { harness } = greenDeployment()
  const res = await preflight(harness, { env: {} })

  assert.equal(res.body.data.ready, false)
  const found = blockerByCode(res.body, PREFLIGHT_BLOCKER_CODES.SANDBOX_MODE_NOT_ENABLED)
  assert.equal(found.fix.kind, 'env')
  assert.equal(found.fix.run, `${SANDBOX_MODE_ENV}=true`, 'P-08: the fix is the literal env line')
  assert.equal(res.body.data.checks.sandboxWriteAuthorization.modeEnabled, false)

  // A pack that declares the CANONICAL production target raises NEITHER sandbox blocker: the apply
  // gate refuses the canonical target structurally whatever the allowlist says, so listing it would
  // be advice that cannot work. Production Apply is reported under posture instead.
  const canonical = mount({
    packs: { [PACK_ID]: packDeclaring(undefined) },
    extFieldMapping: EXT_FIELD_MAPPING_CONFIG,
    objects: readyObjects(CANONICAL_OBJECT_ID),
  })
  const canonicalRes = await preflight(canonical, { env: {} })
  const codes = canonicalRes.body.data.blockers.map((entry) => entry.code)
  assert.ok(!codes.includes(PREFLIGHT_BLOCKER_CODES.SANDBOX_MODE_NOT_ENABLED), 'P-08: no sandbox blocker for a canonical-declaring pack')
  assert.ok(!codes.includes(PREFLIGHT_BLOCKER_CODES.SANDBOX_ALLOWLIST_MISSING_TARGET))
  assert.equal(canonicalRes.body.data.posture.productionApply.state, 'closed')
  assert.equal(canonicalRes.body.data.ready, true, 'P-08: that deployment is otherwise ready')
}

// ---------------------------------------------------------------------------
// P-09 — the fences are POSTURE, never blockers, never with a fix
// ---------------------------------------------------------------------------

async function fencesAreReportedNeverFixed() {
  const { harness, env } = greenDeployment()
  const res = await preflight(harness, { env })
  const { posture, blockers } = res.body.data

  assert.equal(posture.productionApply.state, 'closed')
  assert.equal(posture.k3ExternalWrite.state, 'permanently_disabled')
  assert.equal(posture.b2aTrialRegistry.state, 'dormant')
  assert.equal(posture.b2aTrialRegistry.envVar, B2A_REGISTRY_PATH_ENV)
  assert.equal(posture.outboundHttpWrite.state, 'unset')
  assert.equal(posture.outboundHttpWrite.envVar, OUTBOUND_HTTP_WRITE_TARGETS_ENV)

  // NOT A NUDGE. Nothing in the posture section may look like something to run: no `fix`, no `run`,
  // no `KEY=` line hiding in a note. Unset is the correct posture for the last two, and a preflight
  // that offered a way to arm them would be actively harmful.
  for (const [fence, entry] of Object.entries(posture)) {
    assert.ok(!('fix' in entry), `P-09: posture.${fence} carries no fix`)
    assert.ok(!('run' in entry), `P-09: posture.${fence} carries nothing runnable`)
    for (const value of Object.values(entry)) {
      if (typeof value !== 'string') continue
      assert.ok(
        !new RegExp(`${B2A_REGISTRY_PATH_ENV}\\s*=|${OUTBOUND_HTTP_WRITE_TARGETS_ENV}\\s*=`).test(value),
        `P-09: posture.${fence} never spells an env assignment that would arm a dormant gate`,
      )
    }
  }

  // ...and no fence ever becomes a blocker, on a green deployment or on the worst one we can build.
  const worst = mount({ objects: {} })
  const worstRes = await preflight(worst, { env: {} })
  for (const body of [res.body, worstRes.body]) {
    for (const entry of body.data.blockers) {
      assert.ok(
        PREFLIGHT_BLOCKER_CODE_ORDER.includes(entry.code),
        `P-09: ${entry.code} is in the frozen blocker vocabulary — no fence leaked in`,
      )
      assert.ok(!/B2A|K3|OUTBOUND|PRODUCTION_APPLY/.test(entry.code), `P-09: ${entry.code} is not a fence`)
    }
  }
  assert.ok(worstRes.body.data.posture, 'P-09: posture survives a deployment with nothing configured')
  assert.equal(blockers.length, 0)
}

// ---------------------------------------------------------------------------
// P-10 — READ-ONLY
// ---------------------------------------------------------------------------

async function preflightPerformsNoProvisioningWrite() {
  // Stated as "no call outside the read set" rather than "these writes did not happen", so a write
  // primitive added to the provisioning API tomorrow is caught without anyone remembering to add it
  // to a list here. Run every scenario, green and broken: the read-only property is unconditional.
  const scenarios = [
    () => greenDeployment(),
    () => ({ harness: mount({ objects: {} }), env: {} }),
    () => ({
      harness: mount({
        packs: { [PACK_ID]: packDeclaring(DECLARED_SANDBOX_OBJECT_ID) },
        extFieldMapping: EXT_FIELD_MAPPING_CONFIG,
        objects: { [EXISTING_SANDBOX_OBJECT_ID]: { fields: 'all' } },
      }),
      env: sandboxEnv([EXISTING_SANDBOX_OBJECT_ID]),
    }),
  ]
  for (const build of scenarios) {
    const { harness, env } = build()
    await preflight(harness, { env })
    const readSet = new Set(PROVISIONING_READ_METHODS)
    for (const method of harness.provisioning.calls) {
      assert.ok(readSet.has(method), `P-10: the preflight called provisioning.${method}, which is not a read`)
    }
    assert.ok(harness.provisioning.calls.includes('findObjectSheet'), 'P-10: precondition — it really did inspect')
    assert.deepEqual(harness.records.calls, [], 'P-10: the preflight touches the records API not at all')
  }
}

// ---------------------------------------------------------------------------
// P-11 — VALUES-FREE
// ---------------------------------------------------------------------------

async function responseCarriesNoConnectionishInput() {
  // Seed the deployment with the shapes a stock-prep deployment really has around it — a source
  // host, a port, a credential, a filesystem path — and assert not one of them reaches the response.
  // The preflight quotes only DEPLOYMENT-AUTHORED schema vocabulary: objectIds, field ids, packIds,
  // env KEY names.
  const SECRETS = Object.freeze({
    host: '192.168.11.222',
    hostname: 'plm-sqlserver-222.factory.internal',
    port: '1433',
    user: 'plm_trial_readonly',
    password: 'Tr1alP@ssw0rd!',
    database: 'PLM_PROD',
    connectionString: 'Server=192.168.11.222,1433;Database=PLM_PROD;User Id=plm_trial_readonly;Password=Tr1alP@ssw0rd!',
    packsPath: 'D:\\deploy\\222\\customer-packs.json',
    mappingPath: 'D:\\deploy\\222\\ext-field-mapping.json',
    businessValue: '领料节点-粗加工',
  })

  const harness = mount({
    packs: { [PACK_ID]: packDeclaring(DECLARED_SANDBOX_OBJECT_ID) },
    extFieldMapping: EXT_FIELD_MAPPING_CONFIG,
    objects: { [EXISTING_SANDBOX_OBJECT_ID]: { fields: 'all' } },
    // Server config a real deployment carries alongside the stock-prep keys.
    config: {
      externalSystems: [{
        id: 'plm-222',
        kind: 'data-source:sql-readonly',
        config: {
          host: SECRETS.host,
          port: Number(SECRETS.port),
          database: SECRETS.database,
          connectionString: SECRETS.connectionString,
        },
        privateConfig: { user: SECRETS.user, password: SECRETS.password },
      }],
    },
  })

  const res = await preflight(harness, {
    env: {
      ...sandboxEnv([EXISTING_SANDBOX_OBJECT_ID]),
      // The env the preflight itself reads NAMES a path. It must never echo the path's value.
      [CUSTOMER_PACKS_PATH_ENV]: SECRETS.packsPath,
      [EXT_FIELD_MAPPING_PATH_ENV]: SECRETS.mappingPath,
      PLM_SOURCE_PASSWORD: SECRETS.password,
    },
  })

  // The check walks the response and tests every string it contains, rather than searching the
  // JSON text. A serialized search silently misses anything JSON escapes — a Windows deploy path is
  // `D:\\deploy\\...` in the JSON and `D:\deploy\...` in the value, so a raw substring test on the
  // serialized form reports clean while the path is right there. (Witnessed: mutation M10 echoed the
  // path into the response and survived the serialized form of this assertion.)
  const strings = collectStrings(res.body)
  for (const [label, value] of Object.entries(SECRETS)) {
    const leak = strings.find((entry) => entry.includes(value))
    assert.equal(leak, undefined, `P-11: the response carries no ${label} (found in ${JSON.stringify(leak)})`)
  }
  // Precondition: the response is not vacuously clean — it really did say something.
  assert.ok(strings.some((entry) => entry.includes(DECLARED_SANDBOX_OBJECT_ID)), 'P-11: precondition — the response carries the declared objectId')
  // The env vars it DOES name, it names by KEY only — the deploy-time paths above stay unquoted.
  assert.ok(strings.some((entry) => entry.includes(SANDBOX_TARGET_OBJECT_IDS_ENV)), 'P-11: ...and env KEY names, which are not values')
  assert.ok(strings.some((entry) => entry.includes(B2A_REGISTRY_PATH_ENV)), 'P-11: ...including the posture ones')
}

// ---------------------------------------------------------------------------
// P-12 — ordering and vocabulary
// ---------------------------------------------------------------------------

async function blockersAreOrderedMostBlockingFirst() {
  // Nothing configured, nothing provisioned: every blocker that can fire, fires.
  const harness = mount({ objects: {} })
  const res = await preflight(harness, { env: {} })
  const codes = res.body.data.blockers.map((entry) => entry.code)

  assert.ok(codes.length >= 3, 'P-12: precondition — several blockers fired')
  assert.equal(res.body.data.blockerCount, codes.length)
  const ranks = codes.map((code) => PREFLIGHT_BLOCKER_CODE_ORDER.indexOf(code))
  assert.deepEqual(ranks, ranks.slice().sort((a, b) => a - b), 'P-12: blockers come back most-blocking first')
  assert.ok(!ranks.includes(-1), 'P-12: every code is in the frozen vocabulary')
  // The ledger is the first thing to fix: the confirmation queue is the operator's entry surface.
  assert.equal(codes[0], PREFLIGHT_BLOCKER_CODES.CONFIRMATION_LEDGER_NOT_READY)

  // Every blocker carries the full contract: a code, a human line, and something literal to run.
  for (const entry of res.body.data.blockers) {
    assert.equal(typeof entry.code, 'string')
    assert.ok(entry.what.length > 0, `P-12: ${entry.code} explains itself`)
    assert.ok(['http', 'env'].includes(entry.fix.kind), `P-12: ${entry.code} has a typed fix`)
    assert.ok(entry.fix.run.length > 0, `P-12: ${entry.code} has a literal thing to run`)
    if (entry.fix.kind === 'http') assert.ok(entry.fix.path.startsWith('/api/integration/'), `P-12: ${entry.code} names a real route`)
    else assert.ok(entry.fix.run.startsWith(`${entry.fix.name}=`), `P-12: ${entry.code} is a KEY=value line`)
  }
}

// ---------------------------------------------------------------------------
// P-13 — the fix lines quote env var names that really exist
// ---------------------------------------------------------------------------

function envVarNamesMatchTheirOwners() {
  // A fix line naming an env var that nothing reads is worse than no fix line: the operator sets it
  // and nothing changes. The two owning sources are asserted directly.
  const runtimeConfig = fs.readFileSync(
    path.join(REPO_ROOT, 'packages', 'core-backend', 'src', 'plugin-runtime-config.ts'),
    'utf8',
  )
  for (const name of [CUSTOMER_PACKS_PATH_ENV, EXT_FIELD_MAPPING_PATH_ENV, B2A_REGISTRY_PATH_ENV]) {
    assert.ok(runtimeConfig.includes(`'${name}'`), `P-13: plugin-runtime-config.ts really reads ${name}`)
  }
  const tableActions = fs.readFileSync(path.join(LIB, 'stock-preparation-table-actions.cjs'), 'utf8')
  for (const name of [SANDBOX_MODE_ENV, SANDBOX_TARGET_OBJECT_IDS_ENV]) {
    assert.ok(tableActions.includes(`env.${name}`), `P-13: the apply gate really reads ${name}`)
  }
  const outboundGate = fs.readFileSync(path.join(LIB, 'outbound-http-write-gate.cjs'), 'utf8')
  assert.ok(outboundGate.includes(`'${OUTBOUND_HTTP_WRITE_TARGETS_ENV}'`), 'P-13: the outbound gate really reads its env var')

  // And the namespace prefix the fix line quotes is the one the sandbox guard actually enforces.
  const provisioningSource = fs.readFileSync(path.join(LIB, 'stock-preparation-target-provisioning.cjs'), 'utf8')
  assert.ok(
    provisioningSource.includes(`^${SANDBOX_OBJECT_ID_NAMESPACE_PREFIX}`),
    'P-13: the quoted namespace prefix is the one assertSandboxObjectId enforces',
  )
}

// ---------------------------------------------------------------------------
// P-14 — the request cannot steer the target
// ---------------------------------------------------------------------------

async function requestCannotSteerTheTarget() {
  const { harness, env } = greenDeployment()
  // Letting a request name a projectId or an objectId would recreate incident 2 at the API: the
  // declared target must come from the PACK and from nowhere else.
  for (const query of [{ projectId: 'tenant-b:integration-core' }, { objectId: EXISTING_SANDBOX_OBJECT_ID }, { packId: PACK_ID }]) {
    const res = await preflight(harness, { query, env })
    assert.equal(res.statusCode, 400, `P-14: query ${JSON.stringify(query)} is refused`)
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_PREFLIGHT_REQUEST_INVALID')
  }
  // A cross-tenant read by a tenant-bound principal is refused by the shared tenant guard.
  const crossTenant = await preflight(harness, { query: { tenantId: 'tenant-b' }, env })
  assert.equal(crossTenant.statusCode, 403)
}

// ---------------------------------------------------------------------------

async function main() {
  await routeIsRegisteredAndReadGated()
  await fullyConfiguredDeploymentIsReady()
  await missingLedgerNamesItsEnsureCall()
  await noCustomerPackNamesTheEnvVar()
  await packDeclaredTargetIsCheckedAndQuoted()
  await missingExtFieldMappingNamesTheEnvVar()
  await sandboxAllowlistMismatchIsItsOwnBlocker()
  await sandboxModeOffIsItsOwnBlocker()
  await fencesAreReportedNeverFixed()
  await preflightPerformsNoProvisioningWrite()
  await responseCarriesNoConnectionishInput()
  await blockersAreOrderedMostBlockingFirst()
  envVarNamesMatchTheirOwners()
  await requestCannotSteerTheTarget()
  console.log('stock-preparation-preflight: OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
