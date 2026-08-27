'use strict'

// THE WIRING, not the registry.
//
// b2a-trial-registry.test.cjs pins what the registry DECIDES. This suite pins the only thing that
// makes any of it matter: that the real HTTP routes reach it, that a refusal lands BEFORE the source
// adapter is ever asked for a row, and that a deployment which has not armed the gate behaves
// byte-identically to one that never heard of B2a.
//
// `B2a` had ZERO occurrences in main's tracked code before this change: the registration /
// scope / expiry / no-reuse mechanism the v9.1 review asked for existed only as prose, and "narrow"
// held only by everyone remembering to be careful. Every assertion below would have been red then —
// most of them vacuously, because there was nothing to call.
//
// THE ONE THAT IS NOT ABOUT REFUSING. `unsetEnvIsDormantAndByteIdentical` is asserted against a
// RECOMPUTATION through the pre-change call shape (`dryRunStockPreparationAction` invoked without
// the three new keys), not against a remembered constant — so "byte-identical" is a live comparison
// that breaks if the armed path ever leaks into the dormant one.
//
// Hermetic and dependency-free: no DB, no network, no filesystem writes. Values-free: the only
// literals are schema ids, frozen reason tokens, synthetic project numbers and synthetic cell text.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const {
  dryRunStockPreparationAction,
  PLM_STOCK_PREPARATION_ACTION_ID,
} = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const {
  B2A_TRIAL_REGISTRY_CONFIG_KEY,
  B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
  B2A_PURPOSE_STOCK_PREPARATION_LARGE_BOM,
} = require(path.join(LIB, 'b2a-trial-registry.cjs'))

// The literal the HOST writes onto server config. A self-referential assertion (import the constant,
// configure with it, compare) passes just as happily when the key is mistyped and the gate is
// permanently dormant — so the key is restated here.
assert.equal(B2A_TRIAL_REGISTRY_CONFIG_KEY, 'b2aTrialRegistry')

const TENANT_ID = 'tenant_1'
const OTHER_TENANT_ID = 'tenant_2'
const OBJECT_ID = 'stockPreparationMain'
const SOURCE_SYSTEM_ID = 'plm_sql_source'
const OTHER_SOURCE_SYSTEM_ID = 'k3_sql_source'
const SHEET_ID = 'sheet_stock_b2a'
const PROJECT_NO = 'P-001'
const OUT_OF_SCOPE_PROJECT_NO = 'P-999'

const DAY_MS = 24 * 60 * 60 * 1000
const FAR_FUTURE = new Date(Date.now() + 60 * DAY_MS).toISOString().replace(/\.\d{3}Z$/, 'Z')
const RECENT_PAST_START = new Date(Date.now() - 30 * DAY_MS).toISOString().replace(/\.\d{3}Z$/, 'Z')
const ALREADY_EXPIRED = new Date(Date.now() - DAY_MS).toISOString().replace(/\.\d{3}Z$/, 'Z')

const READ_USER = Object.freeze({ id: 'user_read', tenantId: TENANT_ID, permissions: ['integration:read'] })
const ADMIN_USER = Object.freeze({ id: 'user_admin', tenantId: TENANT_ID, roles: ['admin'], permissions: ['integration:admin'] })

function registryEntry(overrides = {}) {
  return {
    entryId: 'b2a-factory-a-plm',
    tenantId: TENANT_ID,
    sourceBinding: { externalSystemId: SOURCE_SYSTEM_ID },
    projectScope: { projectNos: [PROJECT_NO] },
    purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
    owner: 'owner-a',
    effectiveAt: RECENT_PAST_START,
    expiresAt: FAR_FUTURE,
    forbidReuse: true,
    b2bCondition: 'migrate onto the generalized binding before expiry',
    expiryHandling: 'refuse',
    ...overrides,
  }
}

function registry(entries) {
  return { registryId: 'b2a-2026-q3', registryVersion: 1, entries }
}

// ── fixtures ──────────────────────────────────────────────────────────────────

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function sourceData() {
  return {
    DN_PDM_PathExAttrInfo: [{ FileCode: PROJECT_NO, Parent_OBJ_ID: 'PATH-1' }],
    DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-1' }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-1', path_id: 'PATH-1' }],
    DN_PDM_OrderDetailInfo: [{ order_id: 'ORDER-1', part_id: 'PART-A', quantity: '2' }],
    DN_PDM_PartLibraryInfo: [{
      OBJ_ID: 'PART-A',
      IdentityNo: 'A-001',
      IdentityName: 'Assembly',
      Material: 'Steel',
      SysVer: 'V1',
    }],
    DN_PDM_BomHeadInfo: [],
    DN_PDM_BomDetailsInfo: [],
  }
}

/**
 * THE CALL-RECORDING FAKE. `reads` is the whole point of this suite: "refused before any source
 * read" is not an argument about statement order, it is `reads.length === 0` after a 403.
 *
 * The adapter contract is satisfied only by `read`, which is the single method the expansion uses;
 * anything else the plugin might reach for would throw rather than silently succeed.
 */
function createRecordingSourceAdapter(data = sourceData()) {
  const reads = []
  return {
    reads,
    adapter: {
      async read(input = {}) {
        reads.push(input.object)
        const rows = Array.isArray(data[input.object]) ? data[input.object] : []
        const matches = rows.filter((row) =>
          Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
        return { records: matches.map(clone), nextCursor: null, done: true }
      },
    },
  }
}

function createRecordsApi() {
  const rows = []
  const calls = []
  const record = (name, input) => calls.push([name, clone(input), input])
  return {
    calls,
    rawPayload(name) {
      const call = calls.find(([callName]) => callName === name)
      assert.ok(call, `expected ${name} to have been called`)
      return call[2]
    },
    api: {
      async queryRecords(input = {}) {
        record('queryRecords', input)
        return rows.filter((row) => row.sheetId === input.sheetId).map(clone)
      },
      async createRecord(input = {}) {
        record('createRecord', input)
        const created = { id: `rec_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }
        rows.push(created)
        return clone(created)
      },
      async patchRecord(input = {}) {
        record('patchRecord', input)
        const row = rows.find((entry) => entry.id === input.recordId)
        row.version += 1
        row.data = { ...row.data, ...(input.changes || {}) }
        return clone(row)
      },
    },
  }
}

function inertService(methods) {
  const service = {}
  for (const method of methods) {
    service[method] = async () => { throw new Error(`unexpected service call: ${method}`) }
  }
  return service
}

function baseServices(sourceAdapter, externalSystemLoads) {
  return {
    externalSystemRegistry: {
      ...inertService(['upsertExternalSystem', 'deleteExternalSystem', 'listExternalSystems']),
      async getExternalSystem(input = {}) {
        // Recorded too: a refusal that happens before `loadTableActionSourceAdapter` costs not even
        // an external-system registry lookup, and the large-BOM assertion below checks exactly that.
        if (externalSystemLoads) externalSystemLoads.push(input.id)
        return {
          id: input.id,
          tenantId: input.tenantId,
          name: 'Readonly PLM SQL',
          kind: 'data-source:sql-readonly',
          role: 'source',
          status: 'active',
          config: { dataSourceId: 'ds_plm', object: 'DN_PDM_PathExAttrInfo' },
        }
      },
    },
    adapterRegistry: {
      createAdapter() { return sourceAdapter },
      listAdapterKinds() { return [] },
    },
    pipelineRegistry: inertService(['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns']),
    pipelineRunner: inertService(['runPipeline']),
    deadLetterStore: inertService(['listDeadLetters']),
    stagingInstaller: inertService(['installStaging', 'listStagingDescriptors']),
    templateRegistry: inertService(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
    readSourceConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    readSourceCompositionConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    bridgeAgentChecklistStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'getForApply']),
  }
}

function actionConfig() {
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: { externalSystemId: SOURCE_SYSTEM_ID, kind: 'data-source:sql-readonly' },
    target: { sheetId: SHEET_ID, objectId: OBJECT_ID },
  }
}

function mount({ b2aEntries, b2aRaw, records, source, externalSystemLoads } = {}) {
  const routes = new Map()
  const config = {
    stockPreparationTableActions: [actionConfig()],
    // FOS-4b-3 P0: sandbox apply for this suite's non-canonical target.
    stockPrepApplySandbox: { enabled: true, allowedTargetObjectIds: [OBJECT_ID] },
  }
  // THE ARMING SWITCH, exactly as the host writes it: the key is present only when
  // INTEGRATION_CORE_B2A_REGISTRY_PATH was set. `b2aEntries === undefined` is the unset env.
  if (b2aRaw !== undefined) config[B2A_TRIAL_REGISTRY_CONFIG_KEY] = b2aRaw
  else if (b2aEntries !== undefined) config[B2A_TRIAL_REGISTRY_CONFIG_KEY] = registry(b2aEntries)

  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      multitable: {
        provisioning: { async findObjectSheet() { return { id: SHEET_ID, baseId: null, name: OBJECT_ID, description: null } } },
        records: records ? records.api : createRecordsApi().api,
      },
    },
    // `durable: true` is what the large-BOM job store demands before it accepts a job.
    storage: Object.assign(new Map(), { durable: true }),
    config,
  }
  httpRoutes.registerIntegrationRoutes({
    context,
    services: baseServices((source || createRecordingSourceAdapter()).adapter, externalSystemLoads),
    logger: { info() {}, warn() {}, error() {} },
  })
  return { routes, context }
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

const DRY_RUN_ROUTE = '/api/integration/table-actions/:actionId/dry-run'
const APPLY_ROUTE = '/api/integration/table-actions/:actionId/apply'
const MVP_PERSIST_ROUTE = '/api/integration/table-actions/:actionId/mvp-persist'
const LARGE_BOM_START_ROUTE = '/api/integration/table-actions/:actionId/large-bom/expansion-jobs'
const LARGE_BOM_RUN_ROUTE = '/api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/run'
const ACTION_PARAMS = { actionId: PLM_STOCK_PREPARATION_ACTION_ID }

async function routeDryRun(routes, { projectNo = PROJECT_NO, user = READ_USER } = {}) {
  return call(routes, 'POST', DRY_RUN_ROUTE, { user, params: ACTION_PARAMS, body: { parameters: { projectNo } } })
}

function assertB2aRefusal(res, reason, label, { entryId } = {}) {
  assert.equal(res.statusCode, 403, `${label}: expected a 403, got ${res.statusCode} ${JSON.stringify(res.body)}`)
  assert.equal(res.body.ok, false, label)
  assert.equal(res.body.error.code, 'B2A_TRIAL_REGISTRATION_REQUIRED', `${label}: ${JSON.stringify(res.body.error)}`)
  assert.equal(res.body.error.details.reason, reason, `${label}: wrong reason token`)
  if (entryId) assert.ok(JSON.stringify(res.body.error.details).includes(entryId), `${label}: the refusal names the entry`)
  // VALUES-FREE over the WHOLE response, not just the details: no project number, no tenant id, no
  // owner, no migration condition, no expiry date reaches a caller.
  const text = JSON.stringify(res.body)
  for (const forbidden of [PROJECT_NO, OUT_OF_SCOPE_PROJECT_NO, TENANT_ID, OTHER_TENANT_ID, 'owner-a', 'migrate onto', FAR_FUTURE]) {
    assert.equal(text.includes(forbidden), false, `${label}: response leaked ${JSON.stringify(forbidden)}`)
  }
}

// ── RED 1. UNSET ENV IS DORMANT, AND BYTE-IDENTICAL ──────────────────────────

async function unsetEnvIsDormantAndByteIdentical() {
  const source = createRecordingSourceAdapter()
  const records = createRecordsApi()
  const { routes } = mount({ records, source })

  const res = await routeDryRun(routes)
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  assert.equal(res.body.data.status, 'ready')
  assert.ok(source.reads.length > 0, 'a dormant deployment reads its source exactly as before')

  // THE BASELINE. Recomputed through the PRE-CHANGE call shape: `dryRunStockPreparationAction`
  // invoked without `b2aTrialRegistry`, without `tenantId` and without `now` — literally the call
  // that shipped before this change — over the same fixtures.
  const baseline = await dryRunStockPreparationAction({
    action: actionConfig(),
    parameters: { projectNo: PROJECT_NO },
    sourceAdapter: createRecordingSourceAdapter().adapter,
    recordsApi: createRecordsApi().api,
    tokenStore: new Map(),
    policyStore: new Map(),
  })

  assert.equal(res.body.data.revision, baseline.revision, 'the gated route plans exactly what the ungated call planned')
  assert.deepEqual(res.body.data.counts, baseline.counts)
  assert.deepEqual(res.body.data.evidence, baseline.evidence, 'evidence gains nothing when the gate is dormant')
  assert.equal('b2aTrialRegistration' in res.body.data.evidence, false, 'a dormant deployment stamps no B2a stanza')
  assert.equal('b2aTrialRegistration' in baseline.evidence, false)
  // Everything except the single-use token, which is minted fresh per call by construction.
  const { dryRunToken: _routeToken, ...routeRest } = res.body.data
  const { dryRunToken: _baselineToken, ...baselineRest } = {
    action: baseline.action,
    status: baseline.status,
    largeBom: baseline.largeBom,
    boundedPreview: baseline.boundedPreview,
    dryRunToken: baseline.dryRunToken,
    revision: baseline.revision,
    canApply: baseline.canApply,
    counts: baseline.counts,
    evidence: baseline.evidence,
  }
  assert.deepEqual(routeRest, baselineRest, 'the whole dry-run payload is byte-identical when dormant')

  // APPLY too — it writes, and the written payload must be untouched.
  const applied = await call(routes, 'POST', APPLY_ROUTE, {
    user: ADMIN_USER,
    params: ACTION_PARAMS,
    body: { parameters: { projectNo: PROJECT_NO }, confirm: { dryRunToken: res.body.data.dryRunToken } },
  })
  assert.equal(applied.statusCode, 200, JSON.stringify(applied.body))
  assert.equal(applied.body.data.apply.counts.created, 1)
  // UN-CLONED: a JSON round trip deletes `undefined`-valued keys and would make this pass vacuously.
  assert.equal(
    'b2aTrialRegistration' in applied.body.data.evidence,
    false,
    'a dormant apply stamps no B2a stanza either',
  )
  assert.equal(records.rawPayload('createRecord').data.componentCode, 'A-001', 'the write is what it was')
}

// ── RED 2. ARMED + MATCHING ENTRY ⇒ PASS ─────────────────────────────────────

async function armedWithAMatchingEntryPasses() {
  const source = createRecordingSourceAdapter()
  const records = createRecordsApi()
  const { routes } = mount({ b2aEntries: [registryEntry()], records, source })

  const res = await routeDryRun(routes)
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  assert.equal(res.body.data.status, 'ready')
  assert.ok(source.reads.length > 0, 'an authorized read reaches the source')

  const stanza = res.body.data.evidence.b2aTrialRegistration
  assert.ok(stanza, 'an armed pass stamps the registration into evidence')
  assert.equal(stanza.armed, true, 'the stanza says so explicitly, so armed and dormant are distinguishable from the output alone')
  assert.equal(stanza.entryId, 'b2a-factory-a-plm')
  assert.equal(stanza.registryId, 'b2a-2026-q3')
  assert.equal(stanza.registryVersion, 1)
  assert.equal(stanza.purpose, B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION)
  assert.equal(stanza.projectInScope, true)
  assert.equal(stanza.sourceBindingMatched, true)
  assert.equal(stanza.notExpired, true)
  assert.equal(stanza.effective, true)
  assert.equal(stanza.forbidReuse, true)
  // Values-free: the stanza carries ids and booleans, never the scope contents it matched against.
  const text = JSON.stringify(stanza)
  for (const forbidden of [PROJECT_NO, TENANT_ID, 'owner-a', 'migrate onto', FAR_FUTURE]) {
    assert.equal(text.includes(forbidden), false, `the pass stanza leaked ${JSON.stringify(forbidden)}`)
  }

  // Apply carries it too, and the dry-run/apply pair still agrees on the revision — the gate does
  // not perturb the plan.
  const applied = await call(routes, 'POST', APPLY_ROUTE, {
    user: ADMIN_USER,
    params: ACTION_PARAMS,
    body: { parameters: { projectNo: PROJECT_NO }, confirm: { dryRunToken: res.body.data.dryRunToken } },
  })
  assert.equal(applied.statusCode, 200, JSON.stringify(applied.body))
  assert.equal(applied.body.data.dryRunRevision, res.body.data.revision, 'arming does not move the revision between the two routes')
  assert.equal(applied.body.data.evidence.b2aTrialRegistration.entryId, 'b2a-factory-a-plm')
  assert.equal(records.rawPayload('createRecord').data.componentCode, 'A-001')
}

// ── RED 3–6. REFUSALS, EACH WITH ZERO SOURCE READS ───────────────────────────

/**
 * The shared shape of the four scope refusals. Each drives BOTH the dry-run and the apply route and
 * requires the recording adapter to have been asked for exactly ZERO rows.
 *
 * The apply half also proves ORDERING: it is driven with a deliberately bogus dryRunToken. Because
 * the gate sits ahead of `consumeDryRunToken`, the answer must be the B2a refusal — if the gate had
 * been placed after the token consume, the response would be a token error instead, and an
 * out-of-scope caller would additionally have burned an artifact they were never allowed to use.
 */
async function assertRefusedBeforeAnySourceRead({ entries, projectNo = PROJECT_NO, reason, label, entryId }) {
  const source = createRecordingSourceAdapter()
  const records = createRecordsApi()
  const { routes } = mount({ b2aEntries: entries, records, source })

  const dry = await routeDryRun(routes, { projectNo })
  assertB2aRefusal(dry, reason, `${label} (dry-run)`, { entryId })
  assert.equal(source.reads.length, 0, `${label}: the source adapter was asked for ZERO rows`)

  const applied = await call(routes, 'POST', APPLY_ROUTE, {
    user: ADMIN_USER,
    params: ACTION_PARAMS,
    body: { parameters: { projectNo }, confirm: { dryRunToken: 'not-a-real-token' } },
  })
  assertB2aRefusal(applied, reason, `${label} (apply)`, { entryId })
  assert.equal(source.reads.length, 0, `${label}: apply too read ZERO rows`)
  assert.deepEqual(records.calls, [], `${label}: not even the target table was queried`)
}

async function aMissingEntryRefusesBeforeAnySourceRead() {
  // Armed, and nothing in it covers this tenant. The strongest form: the registry is not empty, so
  // the refusal is a real miss rather than a degenerate one.
  await assertRefusedBeforeAnySourceRead({
    entries: [registryEntry({ tenantId: OTHER_TENANT_ID })],
    reason: 'no_entry',
    label: 'an unregistered tenant',
  })
  // And the degenerate one: armed with nothing at all.
  await assertRefusedBeforeAnySourceRead({ entries: [], reason: 'no_entry', label: 'an armed but empty registry' })
}

async function anExpiredRegistrationRefusesBeforeAnySourceRead() {
  await assertRefusedBeforeAnySourceRead({
    entries: [registryEntry({ effectiveAt: RECENT_PAST_START, expiresAt: ALREADY_EXPIRED })],
    reason: 'expired',
    label: 'an expired registration',
    entryId: 'b2a-factory-a-plm',
  })
}

async function aProjectOutsideTheScopeRefusesBeforeAnySourceRead() {
  await assertRefusedBeforeAnySourceRead({
    entries: [registryEntry()],
    projectNo: OUT_OF_SCOPE_PROJECT_NO,
    reason: 'project_out_of_scope',
    label: 'a project outside the registered scope',
    entryId: 'b2a-factory-a-plm',
  })
}

// THE R-09 DIMENSION. tenant+project alone was ruled insufficient because one customer can connect
// several PLM/ERP systems; an exception granted for one must not authorize the other. Here the
// tenant matches, the project matches, and the registration names a DIFFERENT system.
async function aWrongSourceBindingRefusesBeforeAnySourceRead() {
  await assertRefusedBeforeAnySourceRead({
    entries: [registryEntry({ sourceBinding: { externalSystemId: OTHER_SOURCE_SYSTEM_ID } })],
    reason: 'no_entry',
    label: 'a registration for the customer\'s OTHER system',
  })
  // …and the same with the adapter kind pinned to something the action is not.
  await assertRefusedBeforeAnySourceRead({
    entries: [registryEntry({ sourceBinding: { externalSystemId: SOURCE_SYSTEM_ID, systemKind: 'bridge:legacy-sql-readonly' } })],
    reason: 'no_entry',
    label: 'a registration pinned to a different adapter kind',
  })
}

// ── RED 7. A MALFORMED REGISTRY FAILS AT REGISTRATION ────────────────────────

function assertRegistrationRefuses(raw, label) {
  let thrown = null
  try {
    mount({ b2aRaw: raw })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, `${label}: route registration must throw`)
  assert.equal(thrown.name, 'B2aTrialRegistryError', `${label}: wrong error class (${thrown.name})`)
  assert.equal(thrown.code, 'B2A_TRIAL_REGISTRY_INVALID', label)
  assert.equal(thrown.status, 500, label)
  return thrown
}

function aMalformedRegistryFailsAtRegistrationNotOnTheFirstDryRun() {
  // A typo in the registration file must NOT look exactly like "no registry configured" — that
  // difference is the difference between a gate and no gate.
  assertRegistrationRefuses(registry([registryEntry({ expiresAt: undefined })]), 'a registration with no expiry')
  assertRegistrationRefuses(registry([registryEntry({ owner: undefined })]), 'a registration nobody owns')
  assertRegistrationRefuses(registry([registryEntry({ b2bCondition: undefined })]), 'a registration with no migration condition')
  assertRegistrationRefuses(registry([registryEntry({ expiryHandling: undefined })]), 'a registration with no overrun handling')
  assertRegistrationRefuses(registry([registryEntry({ sourceBinding: {} })]), 'a registration naming no external system')
  assertRegistrationRefuses(registry([registryEntry({ projectScope: { projectNos: [] } })]), 'a registration with an empty data scope')
  assertRegistrationRefuses(registry([registryEntry({ expiresAt: '2999-01-01T00:00:00Z' })]), 'an unbounded window')
  assertRegistrationRefuses(registry([registryEntry({ expiresAt: '2999' })]), 'a loose timestamp')
  assertRegistrationRefuses([registryEntry()], 'an array is not a registry')
  assertRegistrationRefuses('b2a-2026-q3', 'a string is not a registry')
  // The obvious "switch it off" value is FATAL here, unlike the ext-field mapping's `false`: the
  // supported way to be dormant is unsetting the env var, which is a deployment act.
  const off = assertRegistrationRefuses(false, 'false is not a kill switch')
  assert.ok(off.message.includes('INTEGRATION_CORE_B2A_REGISTRY_PATH'), 'the message names the env var')

  // And a well-formed one still registers, so the guard above is not just "everything throws".
  assert.ok(mount({ b2aEntries: [registryEntry()] }).routes.size > 0)
}

// ── RED 8. forbidReuse REFUSES A SECOND CONSUMER ─────────────────────────────

// `purpose` is the identity of a CALL SITE — a frozen constant at every call site, never
// request-derived. An entry with `forbidReuse: true` matches only its own purpose, so a DIFFERENT
// read path reaching for the same narrow binding is refused even though tenant, system and project
// all match. That is what "禁止被其他应用复用" reduces to mechanically.
//
// Exercised through the MVP-persist route, which is a genuinely different consumer: it re-reads the
// same source and commits into the MetaSheet-internal MVP snapshot tables rather than the canonical
// sheet. The registration below authorizes the refresh action and nothing else.
async function forbidReuseRefusesASecondConsumer() {
  const previous = process.env.MULTITABLE_STOCK_PREP_TABLE_ACTION_MVP_PERSIST_ENABLED
  process.env.MULTITABLE_STOCK_PREP_TABLE_ACTION_MVP_PERSIST_ENABLED = 'true'
  try {
    const source = createRecordingSourceAdapter()
    const { routes } = mount({ b2aEntries: [registryEntry({ forbidReuse: true, purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION })], source })

    // The registered consumer passes.
    const dry = await routeDryRun(routes)
    assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
    assert.equal(dry.body.data.evidence.b2aTrialRegistration.forbidReuse, true)
    const readsAfterAuthorized = source.reads.length
    assert.ok(readsAfterAuthorized > 0)

    // The SECOND consumer, same tenant, same system, same project — refused.
    const persisted = await call(routes, 'POST', MVP_PERSIST_ROUTE, {
      user: ADMIN_USER,
      params: ACTION_PARAMS,
      body: { parameters: { projectNo: PROJECT_NO } },
    })
    assertB2aRefusal(persisted, 'purpose_not_permitted', 'a second consumer on a forbidReuse registration')
    assert.equal(persisted.body.error.details.forbidReuse, true, 'the refusal says WHY it refused')
    assert.equal(source.reads.length, readsAfterAuthorized, 'the refused consumer read ZERO additional rows')

    // The explicit, reviewable opposite: a per-consumer registration. Adding the second entry is the
    // deliberate act — this module cannot and does not claim to stop a human writing it, only to
    // make it a visible edit to a reviewed file.
    const sharedSource = createRecordingSourceAdapter()
    const shared = mount({
      b2aEntries: [
        registryEntry({ entryId: 'b2a-refresh', purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION }),
        registryEntry({ entryId: 'b2a-mvp', purpose: 'stock-preparation.mvp-persist' }),
      ],
      source: sharedSource,
    })
    const allowed = await call(shared.routes, 'POST', MVP_PERSIST_ROUTE, {
      user: ADMIN_USER,
      params: ACTION_PARAMS,
      body: { parameters: { projectNo: PROJECT_NO } },
    })
    // It gets PAST the B2a gate. Where it lands afterwards is the persist path's business (this
    // suite wires no snapshot store), so the only claim here is the negative one: not a B2a refusal.
    assert.notEqual(allowed.body.error && allowed.body.error.code, 'B2A_TRIAL_REGISTRATION_REQUIRED',
      'a per-consumer registration authorizes the second consumer')
    // POSITIVELY, so the negative above cannot pass by failing somewhere EARLIER than the gate:
    // the authorized second consumer actually reached the source.
    assert.ok(sharedSource.reads.length > 0, 'the authorized second consumer reaches the source')
  } finally {
    if (previous === undefined) delete process.env.MULTITABLE_STOCK_PREP_TABLE_ACTION_MVP_PERSIST_ENABLED
    else process.env.MULTITABLE_STOCK_PREP_TABLE_ACTION_MVP_PERSIST_ENABLED = previous
  }
}

// ── RED 9. THE REGISTRY IS SERVER-RESOLVED, NEVER REQUEST-SUPPLIED ───────────

async function aRequestCannotSupplyOrDisarmTheRegistry() {
  const source = createRecordingSourceAdapter()
  const { routes } = mount({ b2aEntries: [registryEntry({ tenantId: OTHER_TENANT_ID })], source })

  // Every shape a caller might try: an inline registry, a null one, and a widened project scope —
  // in the body, in the parameters, and in the query.
  const attempts = [
    { body: { parameters: { projectNo: PROJECT_NO }, b2aTrialRegistry: registry([registryEntry()]) } },
    { body: { parameters: { projectNo: PROJECT_NO }, b2aTrialRegistry: null } },
    { body: { parameters: { projectNo: PROJECT_NO, b2aTrialRegistry: registry([registryEntry()]) } } },
    { body: { parameters: { projectNo: PROJECT_NO } }, query: { b2aTrialRegistry: 'null' } },
  ]
  for (const attempt of attempts) {
    const res = await call(routes, 'POST', DRY_RUN_ROUTE, { user: READ_USER, params: ACTION_PARAMS, ...attempt })
    // Either the body/parameter allowlist rejects the extra key (400) or the gate refuses (403).
    // What must NEVER happen is a 200: a request cannot arm, disarm or widen the registry.
    assert.notEqual(res.statusCode, 200, `a request supplied a registry and was served: ${JSON.stringify(attempt)}`)
    assert.ok([400, 403].includes(res.statusCode), `unexpected status ${res.statusCode}: ${JSON.stringify(res.body)}`)
    assert.equal(source.reads.length, 0, 'no attempt reached the source')
  }
}

// ── RED 10. THE FOURTH SOURCE-READING CALL SITE ──────────────────────────────

// `loadTableActionSourceAdapter` has exactly four call sites in this plugin. Three go through the
// table-action wrappers; this one drives a STORED job and does not, so it is gated at the route.
// Gated BEFORE the adapter load, which is why the external-system registry is never even consulted.
async function theLargeBomExpansionJobRunIsGated() {
  const source = createRecordingSourceAdapter()
  const externalSystemLoads = []
  const { routes } = mount({
    b2aEntries: [registryEntry({ purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION })],
    source,
    externalSystemLoads,
  })

  const started = await call(routes, 'POST', LARGE_BOM_START_ROUTE, {
    user: READ_USER,
    params: ACTION_PARAMS,
    body: { parameters: { projectNo: PROJECT_NO } },
  })
  assert.equal(started.statusCode, 202, JSON.stringify(started.body))
  const jobId = started.body.data.jobId || started.body.data.id
  assert.ok(jobId, `the job has an id: ${JSON.stringify(started.body.data)}`)

  // The registration above names the REFRESH purpose and forbids reuse, so the background expansion
  // — a different consumer — is refused.
  const ran = await call(routes, 'POST', LARGE_BOM_RUN_ROUTE, {
    user: READ_USER,
    params: { ...ACTION_PARAMS, jobId },
    body: {},
  })
  assertB2aRefusal(ran, 'purpose_not_permitted', 'the large-BOM expansion run is a distinct consumer')
  assert.equal(source.reads.length, 0, 'the refused expansion read ZERO rows')
  assert.deepEqual(externalSystemLoads, [], 'refused before the adapter load: not even a registry lookup')

  // Registered for its own purpose, it runs.
  const okSource = createRecordingSourceAdapter()
  const ok = mount({
    b2aEntries: [
      registryEntry({ entryId: 'b2a-refresh', purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION }),
      registryEntry({ entryId: 'b2a-large-bom', purpose: B2A_PURPOSE_STOCK_PREPARATION_LARGE_BOM }),
    ],
    source: okSource,
  })
  const okStarted = await call(ok.routes, 'POST', LARGE_BOM_START_ROUTE, {
    user: READ_USER,
    params: ACTION_PARAMS,
    body: { parameters: { projectNo: PROJECT_NO } },
  })
  const okJobId = okStarted.body.data.jobId || okStarted.body.data.id
  const okRan = await call(ok.routes, 'POST', LARGE_BOM_RUN_ROUTE, {
    user: READ_USER,
    params: { ...ACTION_PARAMS, jobId: okJobId },
    body: {},
  })
  assert.notEqual(okRan.body.error && okRan.body.error.code, 'B2A_TRIAL_REGISTRATION_REQUIRED',
    'a registration for this purpose lets the expansion run')
  assert.ok(okSource.reads.length > 0, 'the authorized expansion reaches the source')

  // …and an OUT-OF-SCOPE project is refused on this path too, proving the stored job's projectNo is
  // what the gate reads rather than an unchecked request field.
  const scopedSource = createRecordingSourceAdapter()
  const scoped = mount({
    b2aEntries: [
      registryEntry({ entryId: 'b2a-refresh', purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION, projectScope: { projectNos: [PROJECT_NO, OUT_OF_SCOPE_PROJECT_NO] } }),
      registryEntry({ entryId: 'b2a-large-bom', purpose: B2A_PURPOSE_STOCK_PREPARATION_LARGE_BOM, projectScope: { projectNos: [PROJECT_NO] } }),
    ],
    source: scopedSource,
  })
  const scopedStarted = await call(scoped.routes, 'POST', LARGE_BOM_START_ROUTE, {
    user: READ_USER,
    params: ACTION_PARAMS,
    body: { parameters: { projectNo: OUT_OF_SCOPE_PROJECT_NO } },
  })
  const scopedJobId = scopedStarted.body.data.jobId || scopedStarted.body.data.id
  const scopedRan = await call(scoped.routes, 'POST', LARGE_BOM_RUN_ROUTE, {
    user: READ_USER,
    params: { ...ACTION_PARAMS, jobId: scopedJobId },
    body: {},
  })
  assertB2aRefusal(scopedRan, 'project_out_of_scope', 'the stored job\'s project is what the gate reads')
  assert.equal(scopedSource.reads.length, 0, 'zero rows again')
}

const TESTS = [
  unsetEnvIsDormantAndByteIdentical,
  armedWithAMatchingEntryPasses,
  aMissingEntryRefusesBeforeAnySourceRead,
  anExpiredRegistrationRefusesBeforeAnySourceRead,
  aProjectOutsideTheScopeRefusesBeforeAnySourceRead,
  aWrongSourceBindingRefusesBeforeAnySourceRead,
  aMalformedRegistryFailsAtRegistrationNotOnTheFirstDryRun,
  forbidReuseRefusesASecondConsumer,
  aRequestCannotSupplyOrDisarmTheRegistry,
  theLargeBomExpansionJobRunIsGated,
]

async function main() {
  for (const test of TESTS) {
    await test()
    process.stdout.write(`  ${test.name} OK\n`)
  }
  process.stdout.write('b2a-trial-registry-wiring.test.cjs OK\n')
}

main().catch((error) => {
  process.exitCode = 1
  throw error
})
