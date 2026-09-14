'use strict'

/**
 * B3 — the stock-preparation OWN BASE (方案 ③): a fresh install lands the main table AND the
 * confirmation ledger in one plugin-owned system base derived from the AUTHENTICATED tenant, not in
 * the shared `base_legacy`; an existing install (222) is untouched because whichever half of the
 * pair already exists anchors the other to its own base and nothing ever derives next to it.
 *
 *   T1   derived id: deterministic, prefixed, regex-valid, tenant-opaque; blank tenant -> 400
 *   T2   the prefix is the plugin's own (`base_<plugin.json name minus plugin->_`)
 *   T3   fresh install with the opt-in: anchor lookup (ledger absent), ensureSystemBase BEFORE
 *        ensureObject, baseId = derived, name by locale (zh-CN -> 备料), evidence
 *        ownBaseSource/ownBaseCreated
 *   T3b  a caller WITHOUT the opt-in on a capable host: today's contract (null, zero ensureSystemBase)
 *   T4   main table exists -> zero ensureSystemBase, zero ensureObject, canonical_existing
 *   T5   ledger with the opt-in follows an EXISTING main table's base, zero ensureSystemBase
 *   T5b  ledger without the opt-in on a capable host -> null, zero ensureSystemBase
 *   T5c  ledger, opt-in, capable, NO tenant, main missing -> 400, nothing written (fail-closed)
 *   T6   every creation order ends in ONE base for the main table + ledger pair — including the
 *        round-1 refuted state (ledger pre-existing, main table missing: (d) through the REAL
 *        routes, (g) module-level in an arbitrary base), the gate flipped off between the two
 *        ensures (e), and host version skew between the two ensures (f)
 *   T7   env off (every off-value, trimmed/case-insensitive) -> zero ensureSystemBase, baseId null
 *        on a fresh install; the anchor still runs (it neither derives nor creates); unset / other
 *        values -> on
 *   T8   host without ensureSystemBase + opt-in -> null with ownBaseSource api_unavailable (the ONLY
 *        pin of that degrade; unreachable in a single-repo release), in BOTH orders
 *   T9   canonical, opt-in, capable, NO tenant -> 400, nothing written
 *   T10  derivation ignores the projectId prefix
 *   T11  a request baseId on the write route is still 400 STOCK_PREPARATION_BASE_ID_NOT_ALLOWED
 *   T12  body/query/header tenant values never change the derived id (only the principal's does)
 *   T13  ledger route threads the principal's tenant + the opt-in
 *   T14  sandbox and MVP routes never call ensureSystemBase and pass baseId null on a capable host
 *   T15  a 409 MULTITABLE_BASE_ADOPTION_REFUSED reaches the client typed, zero ensureObject, and
 *        leaks no owner value
 *   T16  structural: exactly the two write routes opt in; BOTH pair members hand the resolver
 *        their own objectId (the ledger only ever names OBJECT_ID — G1); the pair constant is
 *        exactly {main, ledger} and partners are symmetric
 *   T17  the anchor is pair-scoped: a non-member objectId (or none) never looks anything up
 *
 * Mutation witnesses (in-memory only; recorded in the PR body): M2 derive from body/query ->
 * T12 red (projectId variant -> T10 red); M3 remove the anchor step -> T5 red; M4 detach the
 * ledger from the resolver (no objectId) -> T5 red; M5 gate always on -> T7 red; M9 detach the
 * MAIN TABLE from the resolver (no objectId) -> T3 red, T6(d) red; M10 gate before anchor -> T6(e)
 * red.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const HTTP_ROUTES_PATH = path.join(LIB, 'http-routes.cjs')
const LEDGER_PATH = path.join(LIB, 'stock-preparation-confirmation-decisions.cjs')

const ownBase = require(path.join(LIB, 'stock-preparation-own-base.cjs'))
const {
  STOCK_PREP_OWN_BASE_ENV,
  STOCK_PREPARATION_OWN_BASE_ID_PREFIX,
  STOCK_PREPARATION_OWN_BASE_PAIR_OBJECT_IDS,
  stockPreparationOwnBaseEnabled,
  deriveStockPreparationBaseId,
  stockPreparationOwnBasePairPartners,
  resolveStockPreparationOwnBase,
} = ownBase
const {
  ensureStockPreparationCanonicalTarget,
  ensureStockPreparationSandboxTarget,
  StockPreparationTargetProvisioningError,
} = require(path.join(LIB, 'stock-preparation-target-provisioning.cjs'))
const { ensureConfirmationDecisionTarget, OBJECT_ID: LEDGER_OBJECT_ID } = require(LEDGER_PATH)
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE,
  TEMPLATE_LABEL_LOCALE_ENV,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const TARGET_PROVISIONING_PATH = path.join(LIB, 'stock-preparation-target-provisioning.cjs')
const httpRoutes = require(HTTP_ROUTES_PATH)
const pluginManifest = require(path.join(__dirname, '..', 'plugin.json'))

const MAIN_OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
const SYSTEM_BASE_ID_PATTERN = /^base_[A-Za-z0-9][A-Za-z0-9_-]{2,119}$/
const PROJECT_ID = 'tenant_1:integration-core'
const ADMIN_USER = { id: 'user_admin', tenantId: 'tenant_1', roles: ['admin'], permissions: ['integration:admin'] }
const CANONICAL_ROUTE = '/api/integration/stock-preparation/target/ensure'
const LEDGER_ROUTE = '/api/integration/stock-preparation/confirmation-decisions/ensure'
const SANDBOX_ROUTE = '/api/integration/stock-preparation/sandbox-target/ensure'
const MVP_ROUTE = '/api/integration/stock-preparation/mvp/ensure'

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function names(calls) {
  return calls.map(([name]) => name)
}

function findCalls(calls, name) {
  return calls.filter(([callName]) => callName === name)
}

function mainSheet(baseId) {
  return { id: 'sheet_main_existing', baseId, name: 'PLM Stock Preparation Main', description: null }
}

function ledgerSheet(baseId) {
  return { id: 'sheet_ledger_existing', baseId, name: 'Stock Preparation Confirmation Decision', description: null }
}

function baseIdsPassedToEnsureObject(host) {
  return new Set(findCalls(host.calls, 'ensureObject').map(([, input]) => input.baseId))
}

// ── the host fake: ONE ordered call log across every provisioning method ───────────────────────
function createOwnBaseHostFake({ sheets = {}, withEnsureSystemBase = true, existingBases = [] } = {}) {
  const calls = []
  const sheetsByObjectId = new Map(Object.entries(sheets).map(([objectId, sheet]) => [objectId, { ...sheet }]))
  const bases = new Map(existingBases.map((base) => [base.id, { ...base }]))
  const api = {
    async findObjectSheet(input) {
      calls.push(['findObjectSheet', clone(input)])
      const sheet = sheetsByObjectId.get(input.objectId)
      return sheet ? clone(sheet) : null
    },
    async resolveFieldIds(input) {
      calls.push(['resolveFieldIds', clone(input)])
      if (!sheetsByObjectId.has(input.objectId)) return {}
      return Object.fromEntries((input.fieldIds || []).map((fieldId) => [fieldId, `fld_${fieldId}`]))
    },
    async ensureObject(input) {
      calls.push(['ensureObject', clone(input)])
      const sheet = {
        id: `sheet_${input.descriptor.id}`,
        baseId: input.baseId === undefined || input.baseId === null ? null : input.baseId,
        name: input.descriptor.name,
        description: input.descriptor.description || null,
      }
      sheetsByObjectId.set(input.descriptor.id, sheet)
      return {
        baseId: sheet.baseId,
        sheet: clone(sheet),
        fields: (input.descriptor.fields || []).map((field, index) => ({
          id: `physical_${index}_${field.id}`,
          sheetId: sheet.id,
          name: field.name,
          type: field.type,
          property: field.property || {},
          order: index,
        })),
      }
    },
    async ensureObjectDefaultView(input) {
      calls.push(['ensureObjectDefaultView', clone(input)])
      return { created: true, viewId: `view_${input.objectId}`, existingViewCount: 0 }
    },
    async getObjectField(input) {
      calls.push(['getObjectField', clone(input)])
      return null
    },
    async patchObjectFieldProperty(input) {
      calls.push(['patchObjectFieldProperty', clone(input)])
      return { id: `fld_${input.fieldId}`, sheetId: 'sheet_x', name: input.fieldId, type: 'select', property: clone(input.propertyPatch || {}), order: 0 }
    },
  }
  if (withEnsureSystemBase) {
    api.ensureSystemBase = async (input) => {
      calls.push(['ensureSystemBase', clone(input)])
      const existing = bases.get(input.baseId)
      if (existing && existing.owned) {
        // The exact shape core's MultitableBaseAdoptionError carries (pinned by the core suite, case 10).
        throw Object.assign(new Error(`Refusing to adopt multitable base ${input.baseId} as a system base (owned)`), {
          name: 'MultitableBaseAdoptionError',
          code: 'MULTITABLE_BASE_ADOPTION_REFUSED',
          status: 409,
          baseId: input.baseId,
          reason: 'owned',
        })
      }
      const created = !existing
      if (created) bases.set(input.baseId, { id: input.baseId })
      return { baseId: input.baseId, created }
    }
  }
  return { api, calls, bases, sheets: sheetsByObjectId }
}

function context(api) {
  return { api: { multitable: { provisioning: api } } }
}

// ── route harness (the customer-pack routes suite's shape) ─────────────────────────────────────
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

function mountRoutes(api) {
  const routes = new Map()
  const ctx = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      multitable: {
        provisioning: api,
        records: { async queryRecords() { return [] } },
      },
    },
    storage: new Map(),
    config: {},
  }
  httpRoutes.registerIntegrationRoutes({ context: ctx, services: baseServices(), logger: { info() {}, warn() {}, error() {} } })
  return routes
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

async function invoke(routes, method, routePath, req = {}) {
  const handler = routes.get(`${method.toUpperCase()} ${routePath}`)
  assert.ok(handler, `route ${method} ${routePath} is registered`)
  const res = createResponse()
  await handler({
    user: req.user,
    body: req.body || {},
    query: req.query || {},
    params: req.params || {},
    headers: req.headers || {},
    authenticatedTenantId: req.authenticatedTenantId,
  }, res)
  assert.notEqual(res.body, undefined, `${method} ${routePath} produced a JSON body`)
  return res
}

async function withEnv(patch, fn) {
  const saved = {}
  for (const key of Object.keys(patch)) {
    saved[key] = process.env[key]
    if (patch[key] === undefined) delete process.env[key]
    else process.env[key] = patch[key]
  }
  try {
    return await fn()
  } finally {
    for (const key of Object.keys(patch)) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

// ── T1 / T2 / T10: the derivation ──────────────────────────────────────────────────────────────
function testDerivedIdShape() {
  const derived = deriveStockPreparationBaseId('tenant_1')
  assert.equal(derived, deriveStockPreparationBaseId('tenant_1'), 'T1 deterministic')
  assert.equal(derived, deriveStockPreparationBaseId('  tenant_1  '), 'T1 trims like every other tenant reader')
  assert.notEqual(derived, deriveStockPreparationBaseId('tenant_2'), 'T1 distinct tenants get distinct bases')
  assert.ok(derived.startsWith(STOCK_PREPARATION_OWN_BASE_ID_PREFIX), 'T1 prefixed')
  assert.match(derived, SYSTEM_BASE_ID_PATTERN, 'T1 satisfies the core id rule')
  assert.equal(derived.length, STOCK_PREPARATION_OWN_BASE_ID_PREFIX.length + 24, 'T1 24 hex chars of sha1')
  assert.match(derived.slice(STOCK_PREPARATION_OWN_BASE_ID_PREFIX.length), /^[0-9a-f]{24}$/, 'T1 hex digest')
  assert.equal(derived.includes('tenant_1'), false, 'T1 the tenant string never appears in the id')
  for (const blank of ['', '   ', null, undefined, 42]) {
    assert.throws(
      () => deriveStockPreparationBaseId(blank),
      (error) => error instanceof StockPreparationTargetProvisioningError
        && error.status === 400
        && error.code === 'STOCK_PREPARATION_OWN_BASE_TENANT_REQUIRED',
      `T1 blank tenant (${JSON.stringify(blank)}) is a 400, never a legacy fall-back`,
    )
  }

  // T2: the prefix is the plugin's OWN, exactly what plugin-scope derives from the manifest name.
  const slug = pluginManifest.name.replace(/^plugin-/, '')
  assert.equal(slug, 'integration-core')
  assert.equal(STOCK_PREPARATION_OWN_BASE_ID_PREFIX, `base_${slug}_sp_`, 'T2 prefix = base_<slug>_sp_')
  assert.ok(derived.startsWith(`base_${slug}_`), 'T2 under the plugin-scope prefix base_<slug>_')
}

async function testDerivationIgnoresProjectId() {
  const host = createOwnBaseHostFake()
  const resolved = await resolveStockPreparationOwnBase({
    provisioning: host.api,
    projectId: 'tenant_other:integration-core',
    tenantId: 'tenant_1',
    env: {},
  })
  assert.equal(resolved.baseId, deriveStockPreparationBaseId('tenant_1'), 'T10 the projectId prefix never feeds the derivation')
  assert.equal(resolved.source, 'derived')
  assert.equal(resolved.created, true)
  assert.equal(deriveStockPreparationBaseId.length, 1, 'T10 derive takes the tenant and nothing else')
  assert.equal(findCalls(host.calls, 'findObjectSheet').length, 0, 'T10 no objectId -> no anchor lookup')
}

// ── T17: the anchor is pair-scoped ─────────────────────────────────────────────────────────────
async function testAnchorIsPairScoped() {
  assert.deepEqual(stockPreparationOwnBasePairPartners(MAIN_OBJECT_ID), [LEDGER_OBJECT_ID], 'T17 main -> ledger')
  assert.deepEqual(stockPreparationOwnBasePairPartners(LEDGER_OBJECT_ID), [MAIN_OBJECT_ID], 'T17 ledger -> main')
  for (const outsider of ['plm_stock_preparation_sandbox_validation', 'plm_stock_preparation_line', '', null, undefined, 42]) {
    assert.deepEqual(stockPreparationOwnBasePairPartners(outsider), [], `T17 ${JSON.stringify(outsider)} has no partner`)
  }
  // A non-member with BOTH pair tables present in some base never follows them: no lookup, derives.
  const host = createOwnBaseHostFake({ sheets: { [MAIN_OBJECT_ID]: mainSheet('base_legacy'), [LEDGER_OBJECT_ID]: ledgerSheet('base_legacy') } })
  const resolved = await resolveStockPreparationOwnBase({
    provisioning: host.api,
    projectId: PROJECT_ID,
    objectId: 'plm_stock_preparation_sandbox_validation',
    tenantId: 'tenant_1',
    env: {},
  })
  assert.equal(findCalls(host.calls, 'findObjectSheet').length, 0, 'T17 a non-member never looks the pair up')
  assert.equal(resolved.source, 'derived')
}

// ── T3 / T3b / T4 / T9: the main table ─────────────────────────────────────────────────────────
async function testFreshInstallDerivesBeforeEnsureObject() {
  const host = createOwnBaseHostFake()
  const result = await ensureStockPreparationCanonicalTarget({
    context: context(host.api),
    projectId: PROJECT_ID,
    permission: 'admin',
    tenantId: 'tenant_1',
    resolveOwnBase: true,
    env: {},
  })
  const derived = deriveStockPreparationBaseId('tenant_1')
  assert.equal(result.mode, 'canonical_create')
  assert.deepEqual(names(host.calls).slice(0, 5), ['findObjectSheet', 'findObjectSheet', 'ensureSystemBase', 'ensureObject', 'resolveFieldIds'], 'T3 order')
  const lookups = findCalls(host.calls, 'findObjectSheet').map(([, input]) => input.objectId)
  assert.deepEqual(lookups, [MAIN_OBJECT_ID, LEDGER_OBJECT_ID], 'T3 own readiness, then the anchor lookup of the ledger, before any derivation')
  const ensureBase = findCalls(host.calls, 'ensureSystemBase')
  assert.equal(ensureBase.length, 1)
  assert.deepEqual(ensureBase[0][1], { baseId: derived, name: 'Stock preparation' }, 'T3 derived id + English name by default')
  const ensureObject = findCalls(host.calls, 'ensureObject')
  assert.equal(ensureObject.length, 1)
  assert.equal(ensureObject[0][1].baseId, derived, 'T3 ensureObject lands in the derived base')
  assert.equal(ensureObject[0][1].projectId, PROJECT_ID)
  assert.equal(result.evidence.ownBaseSource, 'derived')
  assert.equal(result.evidence.ownBaseCreated, true)
  assert.equal(JSON.stringify(result.evidence).includes(derived), false, 'T3 evidence never carries the base id')

  const zh = createOwnBaseHostFake()
  await ensureStockPreparationCanonicalTarget({
    context: context(zh.api),
    projectId: PROJECT_ID,
    permission: 'admin',
    tenantId: 'tenant_1',
    resolveOwnBase: true,
    locale: 'zh-CN',
    env: {},
  })
  assert.equal(findCalls(zh.calls, 'ensureSystemBase')[0][1].name, '备料', 'T3 zh-CN name through the one locale reader')
}

async function testModuleCallerWithoutOptInIsUnchanged() {
  const host = createOwnBaseHostFake()
  const result = await ensureStockPreparationCanonicalTarget({
    context: context(host.api),
    projectId: PROJECT_ID,
    permission: 'admin',
    tenantId: 'tenant_1',
    env: {},
  })
  assert.equal(result.mode, 'canonical_create')
  assert.equal(findCalls(host.calls, 'ensureSystemBase').length, 0, 'T3b no opt-in -> no ensureSystemBase, even on a capable host with a tenant')
  assert.equal(findCalls(host.calls, 'ensureObject')[0][1].baseId, null, 'T3b today\'s value')
  assert.equal(result.evidence.ownBaseSource, 'unchanged')
  assert.equal(result.evidence.ownBaseCreated, false)
}

async function testExistingMainTableNeverDerives() {
  const host = createOwnBaseHostFake({ sheets: { [MAIN_OBJECT_ID]: mainSheet('base_legacy') } })
  const routes = mountRoutes(host.api)
  const res = await invoke(routes, 'POST', CANONICAL_ROUTE, { user: ADMIN_USER, body: {} })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.data.mode, 'canonical_existing')
  assert.equal(findCalls(host.calls, 'ensureSystemBase').length, 0, 'T4 an existing install never touches ensureSystemBase')
  assert.equal(findCalls(host.calls, 'ensureObject').length, 0, 'T4 an existing table is never re-ensured (so never moved)')
  assert.equal(host.sheets.get(MAIN_OBJECT_ID).baseId, 'base_legacy', 'T4 the existing base_id is untouched')
}

async function testCanonicalWithoutTenantFailsClosed() {
  const host = createOwnBaseHostFake()
  await assert.rejects(
    () => ensureStockPreparationCanonicalTarget({
      context: context(host.api),
      projectId: PROJECT_ID,
      permission: 'admin',
      resolveOwnBase: true,
      env: {},
    }),
    (error) => error.status === 400 && error.code === 'STOCK_PREPARATION_OWN_BASE_TENANT_REQUIRED',
    'T9 no tenant with the opt-in is a 400, never legacy',
  )
  assert.equal(findCalls(host.calls, 'ensureSystemBase').length, 0, 'T9 nothing ensured')
  assert.equal(findCalls(host.calls, 'ensureObject').length, 0, 'T9 nothing created')
}

// ── T5 / T5b / T5c / T13: the ledger ───────────────────────────────────────────────────────────
async function testLedgerFollowsExistingMainTable() {
  const host = createOwnBaseHostFake({ sheets: { [MAIN_OBJECT_ID]: mainSheet('base_legacy') } })
  const routes = mountRoutes(host.api)
  const res = await invoke(routes, 'POST', LEDGER_ROUTE, { user: ADMIN_USER, body: {} })
  assert.equal(res.statusCode, 201, JSON.stringify(res.body))
  assert.equal(res.body.data.mode, 'confirmation_decision_created')
  assert.equal(findCalls(host.calls, 'ensureSystemBase').length, 0, 'T5 the ledger never derives next to an existing main table')
  const ensureObject = findCalls(host.calls, 'ensureObject')
  assert.equal(ensureObject.length, 1)
  assert.equal(ensureObject[0][1].baseId, 'base_legacy', 'T5 the ledger lands in the main table\'s base')
  assert.equal(ensureObject[0][1].descriptor.id, LEDGER_OBJECT_ID)
  const lookups = findCalls(host.calls, 'findObjectSheet').map(([, input]) => input.objectId)
  assert.equal(lookups[0], LEDGER_OBJECT_ID, 'T5 first lookup is the ledger\'s own readiness')
  assert.equal(lookups[1], MAIN_OBJECT_ID, 'T5 second lookup is the anchor: the main table')
  assert.equal(res.body.data.evidence.ownBaseSource, 'anchor')
  assert.equal(res.body.data.evidence.ownBaseCreated, false)

  // A main table whose baseId is not a string (legacy null) anchors to null — never a derived id.
  const legacy = createOwnBaseHostFake({ sheets: { [MAIN_OBJECT_ID]: mainSheet(null) } })
  await ensureConfirmationDecisionTarget({ context: context(legacy.api), projectId: PROJECT_ID, permission: 'admin', tenantId: 'tenant_1', resolveOwnBase: true, env: {} })
  assert.equal(findCalls(legacy.calls, 'ensureSystemBase').length, 0)
  assert.equal(findCalls(legacy.calls, 'ensureObject')[0][1].baseId, null, 'T5 a null-based main table keeps the ledger in the legacy base')
}

async function testLedgerWithoutOptInIsUnchanged() {
  const host = createOwnBaseHostFake()
  const result = await ensureConfirmationDecisionTarget({ context: context(host.api), projectId: PROJECT_ID, permission: 'admin', tenantId: 'tenant_1' })
  assert.equal(result.created, true)
  assert.equal(findCalls(host.calls, 'ensureSystemBase').length, 0, 'T5b no opt-in -> no ensureSystemBase')
  assert.equal(findCalls(host.calls, 'ensureObject')[0][1].baseId, null, 'T5b today\'s value')
  assert.equal(result.evidence.ownBaseSource, 'unchanged')
  const lookups = findCalls(host.calls, 'findObjectSheet').map(([, input]) => input.objectId)
  assert.ok(lookups.every((objectId) => objectId === LEDGER_OBJECT_ID), 'T5b no anchor lookup without the opt-in')
}

async function testLedgerWithoutTenantFailsClosed() {
  const host = createOwnBaseHostFake()
  await assert.rejects(
    () => ensureConfirmationDecisionTarget({ context: context(host.api), projectId: PROJECT_ID, permission: 'admin', resolveOwnBase: true, env: {} }),
    (error) => error.status === 400 && error.code === 'STOCK_PREPARATION_OWN_BASE_TENANT_REQUIRED',
    'T5c ledger: no tenant with the opt-in and no main table is a 400',
  )
  assert.equal(findCalls(host.calls, 'ensureSystemBase').length, 0)
  assert.equal(findCalls(host.calls, 'ensureObject').length, 0)
}

async function testLedgerRouteThreadsTenantAndOptIn() {
  const host = createOwnBaseHostFake()
  const routes = mountRoutes(host.api)
  const res = await invoke(routes, 'POST', LEDGER_ROUTE, { user: ADMIN_USER, body: {} })
  assert.equal(res.statusCode, 201, JSON.stringify(res.body))
  const derived = deriveStockPreparationBaseId('tenant_1')
  const ensureBase = findCalls(host.calls, 'ensureSystemBase')
  assert.equal(ensureBase.length, 1, 'T13 fresh both -> the ledger derives once')
  assert.equal(ensureBase[0][1].baseId, derived)
  assert.equal(findCalls(host.calls, 'ensureObject')[0][1].baseId, derived, 'T13 the ledger lands in the derived base')
  assert.equal(res.body.data.evidence.ownBaseSource, 'derived')
  assert.equal(res.body.data.evidence.ownBaseCreated, true)
  assert.equal(JSON.stringify(res.body).includes(derived), false, 'T13 the response never carries the base id')
}

// ── T6: three orders, one base ─────────────────────────────────────────────────────────────────
async function testThreeOrdersOneBase() {
  const derived = deriveStockPreparationBaseId('tenant_1')
  const common = { projectId: PROJECT_ID, permission: 'admin', tenantId: 'tenant_1', resolveOwnBase: true, env: {} }
  // The guarantee is the MAIN TABLE + CONFIRMATION LEDGER pair only. Staging and MVP tables are
  // not resolved here and still default to the legacy base (disclosed in the PR body).

  // (a) main first, then ledger
  const a = createOwnBaseHostFake()
  await ensureStockPreparationCanonicalTarget({ ...common, context: context(a.api) })
  await ensureConfirmationDecisionTarget({ ...common, context: context(a.api) })
  assert.deepEqual([...baseIdsPassedToEnsureObject(a)], [derived], 'T6(a) main then ledger: one base')
  assert.equal(findCalls(a.calls, 'ensureSystemBase').length, 1, 'T6(a) the ledger anchored, it did not derive again')

  // (b) ledger first, then main
  const b = createOwnBaseHostFake()
  await ensureConfirmationDecisionTarget({ ...common, context: context(b.api) })
  await ensureStockPreparationCanonicalTarget({ ...common, context: context(b.api) })
  assert.deepEqual([...baseIdsPassedToEnsureObject(b)], [derived], 'T6(b) ledger then main: one base')
  assert.equal(findCalls(b.calls, 'ensureSystemBase').length, 1, 'T6(b) the main table anchored to the ledger, it did not derive again')

  // (c) main pre-existing in some other base, then ledger
  const c = createOwnBaseHostFake({ sheets: { [MAIN_OBJECT_ID]: mainSheet('base_stock') } })
  await ensureConfirmationDecisionTarget({ ...common, context: context(c.api) })
  assert.deepEqual([...baseIdsPassedToEnsureObject(c)], ['base_stock'], 'T6(c) the ledger follows the pre-existing main table')
  assert.equal(findCalls(c.calls, 'ensureSystemBase').length, 0, 'T6(c) zero derivation next to an existing main table')

  // (d) THE ROUND-1 REFUTED STATE, through the REAL routes: the ledger already sits in base_legacy
  // (an install page that ensured the ledger and stopped at PACK_CATALOG_EMPTY, a rollback window,
  // a re-provision after the main table was deleted), the main table is missing, the gate is on.
  // The first cut derived here and split the pair. Now the main table follows the ledger.
  const d = createOwnBaseHostFake({ sheets: { [LEDGER_OBJECT_ID]: ledgerSheet('base_legacy') } })
  const dRoutes = mountRoutes(d.api)
  const dLedger = await invoke(dRoutes, 'POST', LEDGER_ROUTE, { user: ADMIN_USER, body: {} })
  assert.equal(dLedger.statusCode, 200, JSON.stringify(dLedger.body))
  assert.equal(dLedger.body.data.mode, 'confirmation_decision_existing')
  const dMain = await invoke(dRoutes, 'POST', CANONICAL_ROUTE, { user: ADMIN_USER, body: {} })
  assert.equal(dMain.statusCode, 201, JSON.stringify(dMain.body))
  assert.equal(dMain.body.data.mode, 'canonical_create')
  assert.equal(dMain.body.data.evidence.ownBaseSource, 'anchor', 'T6(d) the main table anchored to the pre-existing ledger')
  assert.equal(dMain.body.data.evidence.ownBaseCreated, false)
  assert.equal(findCalls(d.calls, 'ensureSystemBase').length, 0, 'T6(d) zero derivation next to an existing ledger')
  assert.deepEqual([...baseIdsPassedToEnsureObject(d)], ['base_legacy'], 'T6(d) the main table lands in the LEDGER\'s base')
  assert.equal(d.sheets.get(MAIN_OBJECT_ID).baseId, d.sheets.get(LEDGER_OBJECT_ID).baseId, 'T6(d) one base for the pair')
  assert.equal(JSON.stringify(dMain.body).includes('base_legacy'), false, 'T6(d) the response never carries the base id')

  // (e) the gate flipped OFF between the two ensures: the ledger landed in the derived base while
  // the gate was on, then MULTITABLE_STOCK_PREP_OWN_BASE=false, then the main table is ensured.
  // The anchor runs BEFORE the gate, so the rollback switch cannot split a pair whose first half
  // already landed; it still derives nothing and creates no base.
  const e = createOwnBaseHostFake()
  await ensureConfirmationDecisionTarget({ ...common, context: context(e.api) })
  assert.equal(e.sheets.get(LEDGER_OBJECT_ID).baseId, derived)
  const eMain = await ensureStockPreparationCanonicalTarget({ ...common, context: context(e.api), env: { [STOCK_PREP_OWN_BASE_ENV]: 'false' } })
  assert.equal(eMain.evidence.ownBaseSource, 'anchor', 'T6(e) gate off + existing ledger -> anchor, not disabled')
  assert.deepEqual([...baseIdsPassedToEnsureObject(e)], [derived], 'T6(e) gate off after the ledger landed: still one base')
  assert.equal(findCalls(e.calls, 'ensureSystemBase').length, 1, 'T6(e) the gate-off leg derived nothing')
  // ... and the mirror (main landed derived, gate off, then the ledger).
  const e2 = createOwnBaseHostFake()
  await ensureStockPreparationCanonicalTarget({ ...common, context: context(e2.api) })
  const e2Ledger = await ensureConfirmationDecisionTarget({ ...common, context: context(e2.api), env: { [STOCK_PREP_OWN_BASE_ENV]: 'false' } })
  assert.equal(e2Ledger.evidence.ownBaseSource, 'anchor')
  assert.deepEqual([...baseIdsPassedToEnsureObject(e2)], [derived], 'T6(e) mirror: still one base')
  assert.equal(findCalls(e2.calls, 'ensureSystemBase').length, 1)

  // (f) host version skew between the two ensures: the ledger was created on a host WITHOUT
  // ensureSystemBase (api_unavailable -> legacy null), the main table later on a capable host.
  const f = createOwnBaseHostFake({ withEnsureSystemBase: false })
  const fLedger = await ensureConfirmationDecisionTarget({ ...common, context: context(f.api) })
  assert.equal(fLedger.evidence.ownBaseSource, 'api_unavailable')
  const capable = createOwnBaseHostFake({ sheets: { [LEDGER_OBJECT_ID]: f.sheets.get(LEDGER_OBJECT_ID) } })
  const fMain = await ensureStockPreparationCanonicalTarget({ ...common, context: context(capable.api) })
  assert.equal(fMain.evidence.ownBaseSource, 'anchor', 'T6(f) the main table follows the null-based ledger on the newer host')
  assert.equal(findCalls(capable.calls, 'ensureSystemBase').length, 0, 'T6(f) zero derivation on the capable host next to an existing ledger')
  assert.deepEqual([...baseIdsPassedToEnsureObject(capable)], [null], 'T6(f) legacy null, same as the ledger')

  // (g) ledger pre-existing in an arbitrary base, then main (the mirror of (c)).
  const g = createOwnBaseHostFake({ sheets: { [LEDGER_OBJECT_ID]: ledgerSheet('base_stock') } })
  const gMain = await ensureStockPreparationCanonicalTarget({ ...common, context: context(g.api) })
  assert.equal(gMain.evidence.ownBaseSource, 'anchor')
  assert.deepEqual([...baseIdsPassedToEnsureObject(g)], ['base_stock'], 'T6(g) the main table follows the pre-existing ledger')
  assert.equal(findCalls(g.calls, 'ensureSystemBase').length, 0, 'T6(g) zero derivation next to an existing ledger')
}

// ── T7: the env gate ───────────────────────────────────────────────────────────────────────────
async function testEnvGate() {
  for (const off of ['false', ' FALSE ', 'False', '0', 'off', 'no', ' No ']) {
    assert.equal(stockPreparationOwnBaseEnabled({ [STOCK_PREP_OWN_BASE_ENV]: off }), false, `T7 off-value ${JSON.stringify(off)}`)
  }
  for (const on of [{}, { [STOCK_PREP_OWN_BASE_ENV]: 'true' }, { [STOCK_PREP_OWN_BASE_ENV]: '' }, { [STOCK_PREP_OWN_BASE_ENV]: 'yes' }]) {
    assert.equal(stockPreparationOwnBaseEnabled(on), true, `T7 on for ${JSON.stringify(on)}`)
  }

  await withEnv({ [STOCK_PREP_OWN_BASE_ENV]: ' FALSE ' }, async () => {
    const host = createOwnBaseHostFake()
    const routes = mountRoutes(host.api)
    const canonical = await invoke(routes, 'POST', CANONICAL_ROUTE, { user: ADMIN_USER, body: {} })
    assert.equal(canonical.statusCode, 201, JSON.stringify(canonical.body))
    const ledger = await invoke(routes, 'POST', LEDGER_ROUTE, { user: ADMIN_USER, body: {} })
    assert.equal(ledger.statusCode, 201, JSON.stringify(ledger.body))
    assert.equal(findCalls(host.calls, 'ensureSystemBase').length, 0, 'T7 env off: zero ensureSystemBase on both routes')
    for (const [, input] of findCalls(host.calls, 'ensureObject')) {
      assert.equal(input.baseId, null, 'T7 env off: today\'s legacy null')
    }
    assert.equal(canonical.body.data.evidence.ownBaseSource, 'disabled', 'T7 fresh install, gate off: the main table takes today\'s value')
    assert.equal(ledger.body.data.evidence.ownBaseSource, 'anchor', 'T7 gate off: the ledger still follows the (null-based) main table just created')
    // The anchor lookup still runs with the gate off (it neither derives nor creates — see T6(e));
    // on this fresh install it finds nothing on the canonical leg. The main-table lookups are the
    // canonical route's own readiness inspect plus the ledger route's anchor lookup.
    const lookups = findCalls(host.calls, 'findObjectSheet').map(([, input]) => input.objectId)
    assert.equal(lookups.filter((objectId) => objectId === MAIN_OBJECT_ID).length, 2, 'T7 gate off: readiness inspect + the ledger\'s anchor lookup')
    assert.equal(lookups.filter((objectId) => objectId === LEDGER_OBJECT_ID).length, 3, 'T7 gate off: the main table\'s anchor lookup + the ledger\'s inspect + verify')
  })
}

// ── T8: incapable host ─────────────────────────────────────────────────────────────────────────
async function testIncapableHostDegrades() {
  const host = createOwnBaseHostFake({ withEnsureSystemBase: false })
  const result = await ensureStockPreparationCanonicalTarget({ context: context(host.api), projectId: PROJECT_ID, permission: 'admin', tenantId: 'tenant_1', resolveOwnBase: true, env: {} })
  assert.equal(result.mode, 'canonical_create')
  assert.equal(findCalls(host.calls, 'ensureObject')[0][1].baseId, null, 'T8 today\'s path on an older host')
  assert.equal(result.evidence.ownBaseSource, 'api_unavailable')
  const ledger = await ensureConfirmationDecisionTarget({ context: context(host.api), projectId: PROJECT_ID, permission: 'admin', tenantId: 'tenant_1', resolveOwnBase: true, env: {} })
  assert.equal(ledger.evidence.ownBaseSource, 'anchor', 'T8 the ledger still follows the (just created, null-based) main table')
  assert.equal(findCalls(host.calls, 'ensureObject')[1][1].baseId, null)

  const reversed = createOwnBaseHostFake({ withEnsureSystemBase: false })
  const first = await ensureConfirmationDecisionTarget({ context: context(reversed.api), projectId: PROJECT_ID, permission: 'admin', tenantId: 'tenant_1', resolveOwnBase: true, env: {} })
  assert.equal(first.evidence.ownBaseSource, 'api_unavailable', 'T8 ledger first on an older host degrades the same way')
  const second = await ensureStockPreparationCanonicalTarget({ context: context(reversed.api), projectId: PROJECT_ID, permission: 'admin', tenantId: 'tenant_1', resolveOwnBase: true, env: {} })
  assert.equal(second.evidence.ownBaseSource, 'anchor', 'T8 the main table follows the (just created, null-based) ledger')
  assert.deepEqual([...baseIdsPassedToEnsureObject(reversed)], [null])
}

// ── T11 / T12 / T15: the routes ────────────────────────────────────────────────────────────────
async function testRequestBaseIdStillRefused() {
  const host = createOwnBaseHostFake()
  const routes = mountRoutes(host.api)
  const res = await invoke(routes, 'POST', CANONICAL_ROUTE, { user: ADMIN_USER, body: { baseId: 'base_attacker' } })
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.error.code, 'STOCK_PREPARATION_BASE_ID_NOT_ALLOWED')
  assert.equal(host.calls.length, 0, 'T11 refused before any provisioning call')
}

async function testOnlyThePrincipalTenantDerives() {
  const derived = deriveStockPreparationBaseId('tenant_1')
  const steered = deriveStockPreparationBaseId('tenant_other')
  assert.notEqual(derived, steered)

  const host = createOwnBaseHostFake()
  const routes = mountRoutes(host.api)
  const res = await invoke(routes, 'POST', CANONICAL_ROUTE, {
    user: ADMIN_USER,
    body: { tenantId: 'tenant_other', projectId: 'tenant_other:integration-core' },
    query: { tenantId: 'tenant_other' },
    headers: { 'x-tenant-id': 'tenant_other' },
  })
  assert.equal(res.statusCode, 201, JSON.stringify(res.body))
  const ensureBase = findCalls(host.calls, 'ensureSystemBase')
  assert.equal(ensureBase.length, 1)
  assert.equal(ensureBase[0][1].baseId, derived, 'T12 the derived base is the PRINCIPAL\'s tenant')
  assert.notEqual(ensureBase[0][1].baseId, steered, 'T12 body/query/header tenant values are inert at the plugin boundary (upstream, the host jwt middleware may fill a CLAIMLESS token\'s user.tenantId from x-tenant-id unless MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED is on — the known hole, unchanged by B3)')
  const ensureObject = findCalls(host.calls, 'ensureObject')[0][1]
  assert.equal(ensureObject.baseId, derived)
  assert.equal(ensureObject.projectId, PROJECT_ID, 'T12 the write projectId is the principal\'s too')

  const ledgerHost = createOwnBaseHostFake()
  const ledgerRoutes = mountRoutes(ledgerHost.api)
  const ledgerRes = await invoke(ledgerRoutes, 'POST', LEDGER_ROUTE, {
    user: ADMIN_USER,
    body: {},
    query: { tenantId: 'tenant_other' },
    headers: { 'x-tenant-id': 'tenant_other' },
  })
  assert.equal(ledgerRes.statusCode, 201, JSON.stringify(ledgerRes.body))
  assert.equal(findCalls(ledgerHost.calls, 'ensureSystemBase')[0][1].baseId, derived, 'T12 ledger: principal only')
}

async function testAdoptionRefusalReachesClientTyped() {
  const derived = deriveStockPreparationBaseId('tenant_1')
  for (const routePath of [CANONICAL_ROUTE, LEDGER_ROUTE]) {
    const host = createOwnBaseHostFake({ existingBases: [{ id: derived, owned: true, ownerId: 'user_squatter_9f2' }] })
    const routes = mountRoutes(host.api)
    const res = await invoke(routes, 'POST', routePath, { user: ADMIN_USER, body: {} })
    assert.equal(res.statusCode, 409, `T15 ${routePath}: ${JSON.stringify(res.body)}`)
    assert.equal(res.body.ok, false)
    assert.equal(res.body.error.code, 'MULTITABLE_BASE_ADOPTION_REFUSED')
    assert.equal(findCalls(host.calls, 'ensureSystemBase').length, 1)
    assert.equal(findCalls(host.calls, 'ensureObject').length, 0, 'T15 nothing created on a refused base')
    const serialized = JSON.stringify(res.body)
    assert.equal(serialized.includes('user_'), false, 'T15 no owner value in the response')
    assert.equal(serialized.includes('squatter'), false)
  }
}

// ── T14: sandbox and MVP never derive ──────────────────────────────────────────────────────────
async function testSandboxAndMvpNeverDerive() {
  const host = createOwnBaseHostFake()
  const routes = mountRoutes(host.api)
  const sandbox = await invoke(routes, 'POST', SANDBOX_ROUTE, {
    user: ADMIN_USER,
    body: {
      objectId: 'plm_stock_preparation_sandbox_validation',
      label: 'Sandbox Stock Preparation',
      optionSets: {
        material_type: [{ value: 'plate', label: 'Plate' }],
        blank_type: [{ value: 'casting', label: 'Casting' }],
        stock_preparation_status: [{ value: 'pending', label: 'Pending' }],
      },
    },
  })
  assert.equal(sandbox.statusCode, 201, JSON.stringify(sandbox.body))
  assert.equal(sandbox.body.data.mode, 'sandbox_create')
  const mvp = await invoke(routes, 'POST', MVP_ROUTE, { user: ADMIN_USER, body: {} })
  assert.equal(mvp.statusCode, 201, JSON.stringify(mvp.body))
  assert.equal(findCalls(host.calls, 'ensureSystemBase').length, 0, 'T14 sandbox + MVP: zero ensureSystemBase on a capable host')
  const ensures = findCalls(host.calls, 'ensureObject')
  assert.ok(ensures.length >= 2, 'T14 both routes created something')
  for (const [, input] of ensures) {
    assert.equal(input.baseId, null, `T14 ${input.descriptor.id} still passes today\'s null`)
  }

  // Module-level sandbox with the opt-in accidentally set still takes its explicit/legacy path
  // (no tenant): the sandbox wrapper never forwards a tenant, so this is defence in depth only.
  const direct = createOwnBaseHostFake()
  const sandboxResult = await ensureStockPreparationSandboxTarget({
    context: context(direct.api),
    projectId: PROJECT_ID,
    objectId: 'plm_stock_preparation_sandbox_validation',
    label: 'Sandbox',
    permission: 'admin',
    baseId: 'base_explicit_sandbox',
    resolveOwnBase: true,
    env: {},
  })
  assert.equal(sandboxResult.mode, 'sandbox_create')
  assert.equal(findCalls(direct.calls, 'ensureSystemBase').length, 0, 'T14 an explicit baseId is verbatim (step 2) and never derives')
  assert.equal(findCalls(direct.calls, 'ensureObject')[0][1].baseId, 'base_explicit_sandbox')
  assert.equal(sandboxResult.evidence.ownBaseSource, 'explicit')
}

// ── T16: structural pins ───────────────────────────────────────────────────────────────────────
function testStructuralPins() {
  const routesSrc = fs.readFileSync(HTTP_ROUTES_PATH, 'utf8')
  const optIns = routesSrc.match(/resolveOwnBase: true/g) || []
  assert.equal(optIns.length, 2, 'T16 exactly two route opt-ins (canonical ensure + ledger ensure)')
  for (const handler of ['stockPreparationTargetEnsure', 'stockPreparationConfirmationDecisionsEnsure']) {
    const start = routesSrc.indexOf(`async ${handler}(req, res)`)
    assert.ok(start > 0, `T16 ${handler} exists`)
    const body = routesSrc.slice(start, routesSrc.indexOf('\n    },', start))
    assert.ok(body.includes('resolveOwnBase: true'), `T16 ${handler} opts in`)
    assert.equal(body.includes('requestBody(req).tenantId') || body.includes('requestQuery(req).tenantId'), false, `T16 ${handler} never reads a request tenant`)
  }
  for (const handler of ['stockPreparationSandboxTargetEnsure', 'stockPreparationMvpEnsure', 'stagingInstall']) {
    const start = routesSrc.indexOf(`async ${handler}(req, res)`)
    assert.ok(start > 0, `T16 ${handler} exists`)
    const body = routesSrc.slice(start, routesSrc.indexOf('\n    },', start))
    assert.equal(body.includes('resolveOwnBase'), false, `T16 ${handler} does not opt in`)
  }
  // Both pair members hand the resolver their OWN objectId; the resolver (which owns the pair)
  // anchors each to the other. The ledger only ever names OBJECT_ID (G1); the main table passes
  // the template's objectId (a sandbox template is not a pair member and never anchors).
  function resolverCallBlock(src, label) {
    const start = src.indexOf('await resolveStockPreparationOwnBase({')
    assert.ok(start > 0, `T16 ${label} calls the resolver`)
    assert.equal(src.indexOf('await resolveStockPreparationOwnBase({', start + 1), -1, `T16 ${label} calls the resolver exactly once`)
    return src.slice(start, src.indexOf('})', start))
  }
  const ledgerSrc = fs.readFileSync(LEDGER_PATH, 'utf8')
  assert.ok(resolverCallBlock(ledgerSrc, 'the ledger').includes('objectId: OBJECT_ID,'), 'T16 the ledger anchors through its own objectId')
  assert.equal(ledgerSrc.includes('anchorToMainTable'), false, 'T16 the one-directional anchor flag is gone')
  assert.ok(ledgerSrc.includes('resolveOwnBase === true'), 'T16 the ledger resolves only on the opt-in')
  assert.equal(ledgerSrc.includes(MAIN_OBJECT_ID), false, 'T16 the ledger still never names the canonical object (G1)')
  const provisioningSrc = fs.readFileSync(TARGET_PROVISIONING_PATH, 'utf8')
  assert.ok(resolverCallBlock(provisioningSrc, 'the main table').includes('objectId: template.objectId,'), 'T16 the main table anchors through its own objectId')
  assert.equal(provisioningSrc.includes('anchorToMainTable'), false)
  // The pair is exactly {main, ledger}, spelled from the two templates, and the ledger's identity
  // in the pair is the ledger module's exported OBJECT_ID.
  assert.deepEqual([...STOCK_PREPARATION_OWN_BASE_PAIR_OBJECT_IDS], [MAIN_OBJECT_ID, STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE.objectId], 'T16 the pair')
  assert.equal(STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE.objectId, LEDGER_OBJECT_ID, 'T16 the pair names the ledger by its module\'s own id')
  assert.ok(Object.isFrozen(STOCK_PREPARATION_OWN_BASE_PAIR_OBJECT_IDS))
}

async function main() {
  await withEnv({ [TEMPLATE_LABEL_LOCALE_ENV]: undefined, [STOCK_PREP_OWN_BASE_ENV]: undefined }, async () => {
    testDerivedIdShape()
    await testDerivationIgnoresProjectId()
    await testAnchorIsPairScoped()
    await testFreshInstallDerivesBeforeEnsureObject()
    await testModuleCallerWithoutOptInIsUnchanged()
    await testExistingMainTableNeverDerives()
    await testCanonicalWithoutTenantFailsClosed()
    await testLedgerFollowsExistingMainTable()
    await testLedgerWithoutOptInIsUnchanged()
    await testLedgerWithoutTenantFailsClosed()
    await testLedgerRouteThreadsTenantAndOptIn()
    await testThreeOrdersOneBase()
    await testEnvGate()
    await testIncapableHostDegrades()
    await testRequestBaseIdStillRefused()
    await testOnlyThePrincipalTenantDerives()
    await testAdoptionRefusalReachesClientTyped()
    await testSandboxAndMvpNeverDerive()
    testStructuralPins()
  })
  console.log('stock-preparation-own-base.test.cjs OK')
}

main().catch((error) => {
  console.error('stock-preparation-own-base.test.cjs FAILED')
  console.error(error)
  process.exit(1)
})
