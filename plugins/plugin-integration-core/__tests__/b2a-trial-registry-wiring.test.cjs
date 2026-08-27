'use strict'

// THE WIRING, not the registry.
//
// b2a-trial-registry.test.cjs pins what the registry DECIDES. This suite pins the only thing that
// makes any of it matter: that the real HTTP routes reach it, that every inventoried read entry
// point is fenced BEFORE any external work, and that a deployment which has not armed the gate
// behaves byte-identically to one that never heard of B2a.
//
// `B2a` had ZERO occurrences in main's tracked code before this change: the registration / scope /
// expiry / no-reuse mechanism the review asked for existed only as prose, and "narrow" held only by
// everyone remembering to be careful. Every assertion below would have been red then — most of them
// vacuously, because there was nothing to call.
//
// Case ids follow the acceptance matrix (R-01, R-02, R-07, E3-01). NOT covered and NOT claimed here:
// R-05 (SQL Server timeout / stable paging / row+page caps), R-06 (schema contract and drift), R-08
// (expiry disposition of value-bearing artifacts), E3-02..E3-05 (full-batch and watermark guards).
//
// Hermetic and dependency-free: no DB, no network, no filesystem writes. Values-free: the only
// literals are schema ids, frozen reason tokens, synthetic scope refs and synthetic cell text.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const {
  dryRunStockPreparationAction,
  PLM_STOCK_PREPARATION_ACTION_ID,
} = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const {
  B2A_REGISTRY_CONFIG_KEY,
  B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
  B2A_PURPOSE_STOCK_PREPARATION_LARGE_BOM,
  B2A_PURPOSE_C6_EXTERNAL_WRITE_DRY_RUN,
  B2A_PURPOSE_PIPELINE_RUNNER_READ,
  B2A_PURPOSE_SEALED_SNAPSHOT_SQLSERVER,
  B2A_REGISTRATION_REQUIRED,
  B2A_SCOPE_MISMATCH,
  C6_SAFE_LIFECYCLE_REQUIRED,
  SEALED_SNAPSHOT_BINDING_REF,
  readPlanSourceObjects,
} = require(path.join(LIB, 'b2a-trial-registry.cjs'))
const {
  PLM_STOCK_PREPARATION_BOM_READ_PLAN,
} = require(path.join(LIB, 'stock-preparation-bom-expansion.cjs'))

// The literal the HOST writes onto server config. A self-referential assertion (import the constant,
// configure with it, compare) passes just as happily when the key is mistyped and the gate is
// permanently dormant — so the key is restated here.
assert.equal(B2A_REGISTRY_CONFIG_KEY, 'b2aTrialRegistry')
// The multitable target kind the E3-01 fence keys on, restated for the same reason.
const MULTITABLE_KIND = 'metasheet:multitable'
const SEALED_SNAPSHOT_OBJECT_KEY = 'stock-preparation-bom'

const TENANT_ID = 'tenant_1'
const OTHER_TENANT_ID = 'tenant_2'
const OBJECT_ID = 'stockPreparationMain'
const SOURCE_SYSTEM_ID = 'plm_sql_source'
const OTHER_SOURCE_SYSTEM_ID = 'k3_sql_source'
const SYSTEM_KIND = 'data-source:sql-readonly'
const SHEET_ID = 'sheet_stock_b2a'
const PROJECT_NO = 'P-001'
const OUT_OF_SCOPE_PROJECT_NO = 'P-999'
const PIPELINE_ID = 'pipeline_1'
const PIPELINE_PROJECT_ID = 'proj_1'
const PIPELINE_SOURCE_OBJECT = 'legacy_items'
const STOCK_PREP_OBJECTS = readPlanSourceObjects(PLM_STOCK_PREPARATION_BOM_READ_PLAN)

const DAY_MS = 24 * 60 * 60 * 1000
const isoAt = (offset) => new Date(Date.now() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
const FAR_FUTURE = isoAt(60 * DAY_MS)
const RECENT_PAST_START = isoAt(-30 * DAY_MS)
const ALREADY_EXPIRED = isoAt(-DAY_MS)

const READ_USER = Object.freeze({ id: 'user_read', tenantId: TENANT_ID, permissions: ['integration:read'] })
const WRITE_USER = Object.freeze({ id: 'user_write', tenantId: TENANT_ID, permissions: ['integration:write'] })
const ADMIN_USER = Object.freeze({ id: 'user_admin', tenantId: TENANT_ID, roles: ['admin'], permissions: ['integration:admin'] })

function registration(overrides = {}) {
  return {
    registrationId: 'b2a-factory-a-plm',
    tenantScope: TENANT_ID,
    sourceSystemType: SYSTEM_KIND,
    sourceBindingRef: SOURCE_SYSTEM_ID,
    projectDataScope: { dataScopeRefs: [PROJECT_NO] },
    objectScope: { sourceObjects: [...STOCK_PREP_OBJECTS] },
    purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
    ownerPrincipalRef: 'owner-ref-a',
    authorizationRef: 'auth-ref-a',
    operationRef: 'op-ref-a',
    effectiveAt: RECENT_PAST_START,
    expiresAt: FAR_FUTURE,
    forbidReuse: true,
    sourceReadOperationLimit: 1,
    artifactReplayLimit: 0,
    consumptionState: 'unconsumed',
    consumedAt: null,
    b2bMigrationCondition: 'migrate onto the generalized binding before expiry',
    expiryHandling: 'deny_replay',
    status: 'active',
    registrationVersion: 1,
    ...overrides,
  }
}

function registry(registrations) {
  return { registryId: 'b2a-2026-q3', registryVersion: 1, registrations }
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
      OBJ_ID: 'PART-A', IdentityNo: 'A-001', IdentityName: 'Assembly', Material: 'Steel', SysVer: 'V1',
    }],
    DN_PDM_BomHeadInfo: [],
    DN_PDM_BomDetailsInfo: [],
  }
}

/**
 * THE CALL-RECORDING FAKE. `reads` is the whole point of this suite: "refused before any source
 * read" is not an argument about statement order, it is `reads.length === 0` after a refusal.
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

/**
 * Every external touch this suite cares about is COUNTED, so "the fence held" is a number and not a
 * narrative:
 *   `credentialLoads` — `getExternalSystemForAdapter`, which decrypts. The contract puts the fence
 *                       before credential reload, so an armed refusal must leave this at 0.
 *   `adapterCreations` — `adapterRegistry.createAdapter`.
 *   `pipelineRuns`     — the runner ever being entered.
 *   `sealedSnapshotRuns` — the sealed-snapshot runtime ever being entered.
 */
function createSpies() {
  return {
    credentialLoads: [],
    publicSystemLoads: [],
    adapterCreations: [],
    pipelineRuns: [],
    sealedSnapshotRuns: [],
    targetUpserts: [],
  }
}

function baseServices({ sourceAdapter, spies, targetKind, pipelineProjectId, includeGetDeadLetter }) {
  const system = (id) => ({
    id,
    tenantId: TENANT_ID,
    name: 'system',
    kind: id === 'target_system' ? (targetKind || 'mock-target') : SYSTEM_KIND,
    role: id === 'target_system' ? 'target' : 'source',
    status: 'active',
    config: { dataSourceId: 'ds_plm', object: 'DN_PDM_PathExAttrInfo' },
  })
  return {
    externalSystemRegistry: {
      ...inertService(['upsertExternalSystem', 'deleteExternalSystem', 'listExternalSystems']),
      async getExternalSystem(input = {}) {
        spies.publicSystemLoads.push(input.id)
        return system(input.id)
      },
      async getExternalSystemForAdapter(input = {}) {
        // THE CREDENTIAL RELOAD. Every armed refusal below asserts this stayed at zero.
        spies.credentialLoads.push(input.id)
        return system(input.id)
      },
    },
    adapterRegistry: {
      createAdapter(sys) {
        spies.adapterCreations.push(sys && sys.id)
        return sourceAdapter
      },
      listAdapterKinds() { return [] },
    },
    pipelineRegistry: {
      ...inertService(['upsertPipeline', 'listPipelines', 'listPipelineRuns']),
      async getPipeline() {
        return {
          id: PIPELINE_ID,
          tenantId: TENANT_ID,
          workspaceId: null,
          status: 'active',
          createdBy: 'owner@example.invalid',
          projectId: pipelineProjectId === undefined ? PIPELINE_PROJECT_ID : pipelineProjectId,
          sourceSystemId: SOURCE_SYSTEM_ID,
          targetSystemId: 'target_system',
          sourceObject: PIPELINE_SOURCE_OBJECT,
          targetObject: 'imported_items',
        }
      },
    },
    pipelineRunner: {
      async runPipeline(input = {}) {
        spies.pipelineRuns.push(input.pipelineId)
        return { id: 'run_1', status: 'succeeded' }
      },
      async replayDeadLetter(input = {}) {
        spies.pipelineRuns.push(input.id)
        return { id: 'run_2', status: 'succeeded' }
      },
    },
    deadLetterStore: {
      async listDeadLetters() { return [] },
      ...(includeGetDeadLetter
        ? { async getDeadLetter() { return { id: 'dl_1', pipelineId: PIPELINE_ID } } }
        : {}),
    },
    stagingInstaller: inertService(['installStaging', 'listStagingDescriptors']),
    templateRegistry: inertService(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
    readSourceConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    readSourceCompositionConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    bridgeAgentChecklistStore: inertService(['saveVersion', 'approve', 'retire', 'getForApply']),
    stockPreparationSqlServerRuntime: {
      async run(input = {}) {
        spies.sealedSnapshotRuns.push(input.operationId)
        return { status: 'captured' }
      },
    },
  }
}

function actionConfig() {
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: { externalSystemId: SOURCE_SYSTEM_ID, kind: SYSTEM_KIND },
    target: { sheetId: SHEET_ID, objectId: OBJECT_ID },
  }
}

function mount({ registrations, raw, records, source, targetKind, pipelineProjectId, includeGetDeadLetter = true } = {}) {
  const routes = new Map()
  const spies = createSpies()
  const config = {
    stockPreparationTableActions: [actionConfig()],
    stockPrepApplySandbox: { enabled: true, allowedTargetObjectIds: [OBJECT_ID] },
  }
  // THE ARMING SWITCH, exactly as the host writes it: the key is present only when
  // INTEGRATION_CORE_B2A_REGISTRY_PATH was set. `registrations === undefined` is the unset env.
  if (raw !== undefined) config[B2A_REGISTRY_CONFIG_KEY] = raw
  else if (registrations !== undefined) config[B2A_REGISTRY_CONFIG_KEY] = registry(registrations)

  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) { routes.set(`${method.toUpperCase()} ${routePath}`, handler) },
      },
      multitable: {
        provisioning: { async findObjectSheet() { return { id: SHEET_ID, baseId: null, name: OBJECT_ID, description: null } } },
        records: records ? records.api : createRecordsApi().api,
      },
    },
    // `durable: true` is what the large-BOM job store demands; it is also the claim store the B2a
    // operation limit is recorded in.
    storage: Object.assign(new Map(), { durable: true }),
    config,
  }
  httpRoutes.registerIntegrationRoutes({
    context,
    services: baseServices({
      sourceAdapter: (source || createRecordingSourceAdapter()).adapter,
      spies,
      targetKind,
      pipelineProjectId,
      includeGetDeadLetter,
    }),
    logger: { info() {}, warn() {}, error() {} },
  })
  return { routes, context, spies }
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
const C6_DRY_RUN_ROUTE = '/api/integration/pipelines/:id/external-write/dry-run'
const PIPELINE_RUN_ROUTE = '/api/integration/pipelines/:id/run'
const PIPELINE_DRY_RUN_ROUTE = '/api/integration/pipelines/:id/dry-run'
const DEAD_LETTER_REPLAY_ROUTE = '/api/integration/dead-letters/:id/replay'
const SEALED_SNAPSHOT_ROUTE = '/api/integration/internal/stock-preparation/sqlserver-sealed-snapshot/run'
const ACTION_PARAMS = { actionId: PLM_STOCK_PREPARATION_ACTION_ID }

async function routeDryRun(routes, { projectNo = PROJECT_NO, user = READ_USER } = {}) {
  return call(routes, 'POST', DRY_RUN_ROUTE, { user, params: ACTION_PARAMS, body: { parameters: { projectNo } } })
}

const FORBIDDEN_IN_RESPONSE = Object.freeze([
  PROJECT_NO, OUT_OF_SCOPE_PROJECT_NO, TENANT_ID, OTHER_TENANT_ID, SOURCE_SYSTEM_ID,
  OTHER_SOURCE_SYSTEM_ID, 'owner-ref-a', 'auth-ref-a', 'op-ref-a', 'migrate onto', FAR_FUTURE,
])

function assertB2aRefusal(res, code, reason, label) {
  assert.equal(res.statusCode, 403, `${label}: expected 403, got ${res.statusCode} ${JSON.stringify(res.body)}`)
  assert.equal(res.body.ok, false, label)
  assert.equal(res.body.error.code, code, `${label}: ${JSON.stringify(res.body.error)}`)
  if (reason) assert.equal(res.body.error.details.reason, reason, `${label}: wrong reason token`)
  // VALUES-FREE over the WHOLE response, not just the details.
  const text = JSON.stringify(res.body)
  for (const forbidden of FORBIDDEN_IN_RESPONSE) {
    assert.equal(text.includes(forbidden), false, `${label}: response leaked ${JSON.stringify(forbidden)}`)
  }
}

function assertNoExternalWork(spies, label) {
  assert.deepEqual(spies.credentialLoads, [], `${label}: NO credential reload`)
  assert.deepEqual(spies.adapterCreations, [], `${label}: NO adapter was created`)
  assert.deepEqual(spies.pipelineRuns, [], `${label}: the runner was never entered`)
  assert.deepEqual(spies.sealedSnapshotRuns, [], `${label}: the sealed-snapshot runtime was never entered`)
}

// ── DORMANCY: unset env is byte-identical ────────────────────────────────────

async function unsetEnvIsDormantAndByteIdentical() {
  const source = createRecordingSourceAdapter()
  const records = createRecordsApi()
  const { routes } = mount({ records, source })

  const res = await routeDryRun(routes)
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  assert.equal(res.body.data.status, 'ready')
  assert.ok(source.reads.length > 0, 'a dormant deployment reads its source exactly as before')

  // THE BASELINE. Recomputed through the PRE-CHANGE call shape: `dryRunStockPreparationAction`
  // invoked without any of the B2a keys — literally the call that shipped before this change.
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
  const { dryRunToken: _t, ...routeRest } = res.body.data
  assert.deepEqual(routeRest, {
    action: baseline.action,
    status: baseline.status,
    largeBom: baseline.largeBom,
    boundedPreview: baseline.boundedPreview,
    revision: baseline.revision,
    canApply: baseline.canApply,
    counts: baseline.counts,
    evidence: baseline.evidence,
  }, 'the whole dry-run payload is byte-identical when dormant')

  const applied = await call(routes, 'POST', APPLY_ROUTE, {
    user: ADMIN_USER,
    params: ACTION_PARAMS,
    body: { parameters: { projectNo: PROJECT_NO }, confirm: { dryRunToken: res.body.data.dryRunToken } },
  })
  assert.equal(applied.statusCode, 200, JSON.stringify(applied.body))
  assert.equal(applied.body.data.apply.counts.created, 1)
  assert.equal('b2aTrialRegistration' in applied.body.data.evidence, false, 'a dormant apply stamps no stanza either')
  assert.equal(records.rawPayload('createRecord').data.componentCode, 'A-001', 'the write is what it was')
}

// A DORMANT deployment must also leave the OTHER three entry points untouched — including the
// E3-01 fence, which is scoped to an armed B2a deployment.
async function unsetEnvLeavesTheOtherEntryPointsUntouched() {
  const { routes, spies } = mount({ targetKind: MULTITABLE_KIND })
  const ran = await call(routes, 'POST', PIPELINE_RUN_ROUTE, { user: WRITE_USER, params: { id: PIPELINE_ID }, body: {} })
  assert.equal(ran.statusCode, 202, JSON.stringify(ran.body))
  assert.deepEqual(spies.pipelineRuns, [PIPELINE_ID], 'a dormant deployment runs the pipeline as before')
  // Not one extra platform read either: the fence returns before touching the registry.
  assert.deepEqual(spies.publicSystemLoads, [], 'dormant costs not even a target-kind lookup')

  const sealed = await call(routes, 'POST', SEALED_SNAPSHOT_ROUTE, { user: ADMIN_USER, body: { operationId: 'op-1' } })
  assert.equal(sealed.statusCode, 200, JSON.stringify(sealed.body))
  assert.deepEqual(spies.sealedSnapshotRuns, ['op-1'])
}

// ── ARMED + MATCHING ⇒ PASS ──────────────────────────────────────────────────

async function armedWithAMatchingRegistrationPasses() {
  const source = createRecordingSourceAdapter()
  const records = createRecordsApi()
  const { routes } = mount({ registrations: [registration()], records, source })

  const res = await routeDryRun(routes)
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  assert.equal(res.body.data.status, 'ready')
  assert.ok(source.reads.length > 0, 'an authorized read reaches the source')

  const stanza = res.body.data.evidence.b2aTrialRegistration
  assert.ok(stanza, 'an armed pass stamps the registration into evidence')
  assert.equal(stanza.armed, true, 'armed and dormant are distinguishable from the output alone')
  assert.equal(stanza.registrationId, 'b2a-factory-a-plm')
  assert.equal(stanza.registrationVersion, 1)
  assert.equal(stanza.purpose, B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION)
  assert.equal(stanza.dataScopeInScope, true)
  assert.equal(stanza.objectInScope, true)
  // TWO GUARDS, ONE RUN. The ROUTE claims the operation ahead of the credential reload; the
  // table-action WRAPPER then re-enters the guard with the same `runId` and CONTINUES on that claim
  // rather than taking a second one. The stanza in evidence is the wrapper's, so it reports the
  // continuation — which is the honest description of what happened, and `pageReads` counts both
  // guard entries within the single authorized operation.
  assert.equal(stanza.operationClaimed, false, 'the wrapper continued the claim the route took')
  assert.equal(stanza.operationContinued, true)
  assert.equal(stanza.pageReads, 2, 'both guard entries rode ONE operation')
  assert.equal(stanza.sourceReadOperationLimit, 1)
  const text = JSON.stringify(stanza)
  for (const forbidden of FORBIDDEN_IN_RESPONSE) {
    assert.equal(text.includes(forbidden), false, `the pass stanza leaked ${JSON.stringify(forbidden)}`)
  }

  // ONE REGISTRATION = ONE SOURCE-READ OPERATION. Apply re-expands the source, so it is a NEW Run
  // and is refused on the SAME registration — the shape §9.1 intends (B2a v1 is dry-run-shaped).
  const readsAfterDryRun = source.reads.length
  const applied = await call(routes, 'POST', APPLY_ROUTE, {
    user: ADMIN_USER,
    params: ACTION_PARAMS,
    body: { parameters: { projectNo: PROJECT_NO }, confirm: { dryRunToken: res.body.data.dryRunToken } },
  })
  assertB2aRefusal(applied, 'B2A_AUTHORIZATION_INVALID', 'operation_already_consumed',
    'a second Run on a spent registration')
  assert.equal(source.reads.length, readsAfterDryRun, 'the refused second Run read ZERO additional rows')
}

// ── R-01 / R-02: refusals, each with zero external work ─────────────────────

/**
 * The shared shape of the scope refusals. Each drives BOTH the dry-run and the apply route and
 * requires the recording adapter to have been asked for ZERO rows and no credential to have been
 * reloaded.
 *
 * The apply half also proves ORDERING: it is driven with a deliberately bogus dryRunToken. Because
 * the guard sits ahead of `consumeDryRunToken`, the answer must be the B2a refusal — if the guard
 * had been placed after the token consume, the response would be a token error instead, and an
 * out-of-scope caller would additionally have burned an artifact they were never allowed to use.
 */
async function assertRefusedBeforeAnySourceRead({ registrations, projectNo = PROJECT_NO, code, reason, label }) {
  const source = createRecordingSourceAdapter()
  const records = createRecordsApi()
  const { routes, spies } = mount({ registrations, records, source })

  const dry = await routeDryRun(routes, { projectNo })
  assertB2aRefusal(dry, code, reason, `${label} (dry-run)`)
  assert.equal(source.reads.length, 0, `${label}: the source adapter was asked for ZERO rows`)

  const applied = await call(routes, 'POST', APPLY_ROUTE, {
    user: ADMIN_USER,
    params: ACTION_PARAMS,
    body: { parameters: { projectNo }, confirm: { dryRunToken: 'not-a-real-token' } },
  })
  assertB2aRefusal(applied, code, reason, `${label} (apply)`)
  assert.equal(source.reads.length, 0, `${label}: apply too read ZERO rows`)
  assert.deepEqual(records.calls, [], `${label}: not even the target table was queried`)
  assert.deepEqual(spies.credentialLoads, [], `${label}: no credential reload`)
}

async function R01_lifecycleRefusalsThroughTheRoute() {
  await assertRefusedBeforeAnySourceRead({
    registrations: [registration({ tenantScope: OTHER_TENANT_ID })],
    code: B2A_REGISTRATION_REQUIRED, reason: 'no_registration', label: 'R-01 an unregistered tenant',
  })
  await assertRefusedBeforeAnySourceRead({
    registrations: [], code: B2A_REGISTRATION_REQUIRED, reason: 'no_registration',
    label: 'R-01 an armed but empty registry',
  })
  await assertRefusedBeforeAnySourceRead({
    registrations: [registration({ effectiveAt: RECENT_PAST_START, expiresAt: ALREADY_EXPIRED })],
    code: B2A_REGISTRATION_REQUIRED, reason: 'expired', label: 'R-01 an expired registration',
  })
  await assertRefusedBeforeAnySourceRead({
    registrations: [registration({ status: 'revoked' })],
    code: B2A_REGISTRATION_REQUIRED, reason: 'revoked', label: 'R-01 a revoked registration',
  })
  await assertRefusedBeforeAnySourceRead({
    registrations: [registration({ consumptionState: 'consumed', consumedAt: ALREADY_EXPIRED })],
    code: 'B2A_AUTHORIZATION_INVALID', reason: 'already_consumed', label: 'R-01 a consumed registration',
  })
}

async function R02_scopeRefusalsThroughTheRoute() {
  await assertRefusedBeforeAnySourceRead({
    registrations: [registration()], projectNo: OUT_OF_SCOPE_PROJECT_NO,
    code: B2A_SCOPE_MISMATCH, reason: 'data_scope_mismatch', label: 'R-02 a project outside the scope',
  })
  // THE R-09 DIMENSION: tenant and project match, the registration names the customer's OTHER system.
  await assertRefusedBeforeAnySourceRead({
    registrations: [registration({ sourceBindingRef: OTHER_SOURCE_SYSTEM_ID })],
    code: B2A_REGISTRATION_REQUIRED, reason: 'no_registration', label: 'R-02 the customer\'s OTHER system',
  })
  await assertRefusedBeforeAnySourceRead({
    registrations: [registration({ sourceSystemType: 'bridge:legacy-sql-readonly' })],
    code: B2A_REGISTRATION_REQUIRED, reason: 'no_registration', label: 'R-02 a different adapter kind',
  })
  // THE WIDENED QUERY: the registration enumerates fewer objects than the read plan touches.
  await assertRefusedBeforeAnySourceRead({
    registrations: [registration({ objectScope: { sourceObjects: [STOCK_PREP_OBJECTS[0]] } })],
    code: B2A_SCOPE_MISMATCH, reason: 'object_out_of_scope', label: 'R-02 the read plan reaches unlisted objects',
  })
  await assertRefusedBeforeAnySourceRead({
    registrations: [registration({ purpose: B2A_PURPOSE_PIPELINE_RUNNER_READ })],
    code: B2A_SCOPE_MISMATCH, reason: 'purpose_not_permitted', label: 'R-02 a registration for another consumer',
  })
}

// ── R-07: all four inventoried entry points are fenced ──────────────────────

// (1) stock-preparation BOM expansion, large-BOM half — the fourth
// `loadTableActionSourceAdapter` call site, gated at the route because it drives a STORED job.
async function R07_entry1_largeBomExpansion() {
  const source = createRecordingSourceAdapter()
  const { routes, spies } = mount({ registrations: [registration()], source })

  const started = await call(routes, 'POST', LARGE_BOM_START_ROUTE, {
    user: READ_USER, params: ACTION_PARAMS, body: { parameters: { projectNo: PROJECT_NO } },
  })
  assert.equal(started.statusCode, 202, JSON.stringify(started.body))
  const jobId = started.body.data.jobId || started.body.data.id
  assert.ok(jobId)

  // The registration names the REFRESH purpose, so the background expansion — a distinct consumer —
  // is refused, before the adapter load and therefore before any credential reload.
  const ran = await call(routes, 'POST', LARGE_BOM_RUN_ROUTE, {
    user: READ_USER, params: { ...ACTION_PARAMS, jobId }, body: {},
  })
  assertB2aRefusal(ran, B2A_SCOPE_MISMATCH, 'purpose_not_permitted', 'R-07 (1) large-BOM expansion')
  assert.equal(source.reads.length, 0, 'ZERO rows read')
  assert.deepEqual(spies.credentialLoads, [], 'refused before the adapter load: not even a credential reload')

  // Registered for its own purpose, it runs — so the fence keys on the purpose, not on the path.
  const okSource = createRecordingSourceAdapter()
  const ok = mount({
    registrations: [
      registration({ registrationId: 'b2a-refresh', operationRef: 'op-refresh' }),
      registration({
        registrationId: 'b2a-large-bom',
        operationRef: 'op-large-bom',
        purpose: B2A_PURPOSE_STOCK_PREPARATION_LARGE_BOM,
      }),
    ],
    source: okSource,
  })
  const okStarted = await call(ok.routes, 'POST', LARGE_BOM_START_ROUTE, {
    user: READ_USER, params: ACTION_PARAMS, body: { parameters: { projectNo: PROJECT_NO } },
  })
  const okJobId = okStarted.body.data.jobId || okStarted.body.data.id
  const okRan = await call(ok.routes, 'POST', LARGE_BOM_RUN_ROUTE, {
    user: READ_USER, params: { ...ACTION_PARAMS, jobId: okJobId }, body: {},
  })
  assert.notEqual(okRan.statusCode, 403, `expected the registered expansion to run: ${JSON.stringify(okRan.body)}`)
  assert.ok(okSource.reads.length > 0, 'the authorized expansion reaches the source')
}

// (2) C6 external-write dry-run.
async function R07_entry2_c6ExternalWriteDryRun() {
  // Not registered for this purpose -> refused BEFORE the source credential reload.
  const denied = mount({ registrations: [registration()] })
  const res = await call(denied.routes, 'POST', C6_DRY_RUN_ROUTE, {
    user: WRITE_USER, params: { id: PIPELINE_ID }, body: {},
  })
  assertB2aRefusal(res, B2A_SCOPE_MISMATCH, 'purpose_not_permitted', 'R-07 (2) C6 external-write dry-run')
  assertNoExternalWork(denied.spies, 'R-07 (2)')

  // A pipeline with NO project id cannot be B2a-authorized at all: a null data scope is not a
  // wildcard. This is the case that would otherwise let every project-less pipeline through.
  const nullProject = mount({
    registrations: [registration({ purpose: B2A_PURPOSE_C6_EXTERNAL_WRITE_DRY_RUN, operationRef: 'op-c6' })],
    pipelineProjectId: null,
  })
  const nullRes = await call(nullProject.routes, 'POST', C6_DRY_RUN_ROUTE, {
    user: WRITE_USER, params: { id: PIPELINE_ID }, body: {},
  })
  assertB2aRefusal(nullRes, B2A_SCOPE_MISMATCH, 'missing_scope', 'R-07 (2) a project-less pipeline')
  assertNoExternalWork(nullProject.spies, 'R-07 (2) null project')

  // Registered for this purpose and scope -> the guard passes and the route proceeds (it fails
  // later, on this suite's deliberately inert C6 plumbing, which is not a B2a refusal).
  const allowed = mount({
    registrations: [registration({
      registrationId: 'b2a-c6',
      operationRef: 'op-c6',
      purpose: B2A_PURPOSE_C6_EXTERNAL_WRITE_DRY_RUN,
      projectDataScope: { dataScopeRefs: [PIPELINE_PROJECT_ID] },
      objectScope: { sourceObjects: [PIPELINE_SOURCE_OBJECT] },
    })],
  })
  const allowedRes = await call(allowed.routes, 'POST', C6_DRY_RUN_ROUTE, {
    user: WRITE_USER, params: { id: PIPELINE_ID }, body: {},
  })
  assert.notEqual(allowedRes.body.error && allowedRes.body.error.code, B2A_SCOPE_MISMATCH)
  assert.notEqual(allowedRes.body.error && allowedRes.body.error.code, B2A_REGISTRATION_REQUIRED)
  // POSITIVELY, so the negative above cannot pass by failing EARLIER than the guard: the authorized
  // path got past the fence and reloaded the source credential.
  assert.ok(allowed.spies.credentialLoads.length > 0, 'the authorized C6 dry-run proceeded past the fence')
}

// (3) the ordinary pipeline runner, both doors.
async function R07_entry3_ordinaryPipelineRunner() {
  const denied = mount({ registrations: [registration()] })
  for (const [route, label] of [
    [PIPELINE_RUN_ROUTE, 'run'],
    [PIPELINE_DRY_RUN_ROUTE, 'dry-run'],
  ]) {
    const res = await call(denied.routes, 'POST', route, { user: WRITE_USER, params: { id: PIPELINE_ID }, body: {} })
    assertB2aRefusal(res, B2A_SCOPE_MISMATCH, 'purpose_not_permitted', `R-07 (3) pipeline ${label}`)
  }
  assertNoExternalWork(denied.spies, 'R-07 (3)')

  // The SECOND door: dead-letter replay re-enters `runPipeline`, so it gets the same fence.
  const replay = await call(denied.routes, 'POST', DEAD_LETTER_REPLAY_ROUTE, {
    user: WRITE_USER, params: { id: 'dl_1' }, body: {},
  })
  assertB2aRefusal(replay, B2A_SCOPE_MISMATCH, 'purpose_not_permitted', 'R-07 (3) dead-letter replay')
  assertNoExternalWork(denied.spies, 'R-07 (3) replay')

  // FAIL-CLOSED when the dead-letter store cannot resolve the row: an armed deployment refuses a
  // replay whose scope it cannot resolve rather than replaying unfenced.
  const unresolvable = mount({ registrations: [registration()], includeGetDeadLetter: false })
  const unresolvableRes = await call(unresolvable.routes, 'POST', DEAD_LETTER_REPLAY_ROUTE, {
    user: WRITE_USER, params: { id: 'dl_1' }, body: {},
  })
  assertB2aRefusal(unresolvableRes, B2A_REGISTRATION_REQUIRED, 'replay_scope_unresolvable',
    'R-07 (3) unresolvable replay scope')
  assertNoExternalWork(unresolvable.spies, 'R-07 (3) unresolvable')

  // Registered for this purpose and scope -> the run proceeds.
  const allowed = mount({
    registrations: [registration({
      registrationId: 'b2a-runner',
      operationRef: 'op-runner',
      purpose: B2A_PURPOSE_PIPELINE_RUNNER_READ,
      projectDataScope: { dataScopeRefs: [PIPELINE_PROJECT_ID] },
      objectScope: { sourceObjects: [PIPELINE_SOURCE_OBJECT] },
    })],
  })
  const ran = await call(allowed.routes, 'POST', PIPELINE_RUN_ROUTE, {
    user: WRITE_USER, params: { id: PIPELINE_ID }, body: {},
  })
  assert.equal(ran.statusCode, 202, JSON.stringify(ran.body))
  assert.deepEqual(allowed.spies.pipelineRuns, [PIPELINE_ID], 'the authorized run reaches the runner')
}

// (4) the sealed-snapshot SQL Server session.
async function R07_entry4_sealedSnapshotSession() {
  const denied = mount({ registrations: [registration()] })
  const res = await call(denied.routes, 'POST', SEALED_SNAPSHOT_ROUTE, {
    user: ADMIN_USER, body: { operationId: 'op-1' },
  })
  // The sealed-snapshot guard presents the SENTINEL binding ref, which the stock-prep registration
  // does not name — so it refuses on the binding before it ever reaches the purpose check. Either
  // refusal is correct; the assertion pins which one actually fires so a later change to the
  // ordering shows up here rather than passing silently.
  assertB2aRefusal(res, B2A_REGISTRATION_REQUIRED, 'no_registration', 'R-07 (4) sealed-snapshot session')
  assert.deepEqual(denied.spies.sealedSnapshotRuns, [], 'the sealed-snapshot runtime was never entered')

  // Registered for this purpose -> the session runs. Note the SENTINEL binding ref: this guard
  // authorizes the session for a tenant, purpose and data scope and does NOT pin the binding
  // instance, because the runtime resolves that internally. Weaker than the other three, on purpose
  // and on the record.
  const allowed = mount({
    registrations: [registration({
      registrationId: 'b2a-sealed',
      operationRef: 'op-sealed',
      purpose: B2A_PURPOSE_SEALED_SNAPSHOT_SQLSERVER,
      sourceBindingRef: SEALED_SNAPSHOT_BINDING_REF,
      projectDataScope: { dataScopeRefs: [SEALED_SNAPSHOT_OBJECT_KEY] },
      objectScope: { sourceObjects: [SEALED_SNAPSHOT_OBJECT_KEY] },
    })],
  })
  assert.equal(SEALED_SNAPSHOT_BINDING_REF, 'sealed-snapshot:active-binding')
  const ok = await call(allowed.routes, 'POST', SEALED_SNAPSHOT_ROUTE, {
    user: ADMIN_USER, body: { operationId: 'op-1' },
  })
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body))
  assert.deepEqual(allowed.spies.sealedSnapshotRuns, ['op-1'], 'the authorized session runs')
}

// ── E3-01: the ordinary non-dry MetaSheet upsert bypass ─────────────────────

// The ordinary `pipeline-runner -> metasheet:multitable upsert` non-dry path is a live, token-less
// write to a MetaSheet target outside the C6 dry-run -> token -> apply lifecycle. It is reachable
// TODAY at all three layers — the route forwards no `dryRun`, pipeline validation checks target ROLE
// but never target KIND, and the adapter's `upsert` has no lifecycle guard — so "physically
// unreachable" is not an available claim and a real fence is required.
async function E3_01_ordinaryMultitableWriteIsRefused() {
  const armed = mount({
    registrations: [registration({
      registrationId: 'b2a-runner',
      operationRef: 'op-runner',
      purpose: B2A_PURPOSE_PIPELINE_RUNNER_READ,
      projectDataScope: { dataScopeRefs: [PIPELINE_PROJECT_ID] },
      objectScope: { sourceObjects: [PIPELINE_SOURCE_OBJECT] },
    })],
    targetKind: MULTITABLE_KIND,
  })

  // The registration authorizes the READ. The write fence is independent of it and fires anyway.
  const ran = await call(armed.routes, 'POST', PIPELINE_RUN_ROUTE, {
    user: WRITE_USER, params: { id: PIPELINE_ID }, body: {},
  })
  assert.equal(ran.statusCode, 403, JSON.stringify(ran.body))
  assert.equal(ran.body.error.code, C6_SAFE_LIFECYCLE_REQUIRED, JSON.stringify(ran.body.error))
  assert.equal(ran.body.error.details.reason, 'ordinary_runner_multitable_write')
  assert.equal(ran.body.error.details.dryRun, false)
  assert.deepEqual(armed.spies.pipelineRuns, [], 'the runner was never entered, so upserts=0')
  assert.deepEqual(armed.spies.credentialLoads, [], 'refused before any credential reload')

  // Dead-letter replay is the second non-dry door and gets the same refusal.
  const replay = await call(armed.routes, 'POST', DEAD_LETTER_REPLAY_ROUTE, {
    user: WRITE_USER, params: { id: 'dl_1' }, body: {},
  })
  assert.equal(replay.body.error.code, C6_SAFE_LIFECYCLE_REQUIRED, JSON.stringify(replay.body.error))
  assert.deepEqual(armed.spies.pipelineRuns, [], 'replay did not reach the runner either')

  // DISCRIMINATING CONTROL 1: the DRY path is untouched — a preview is read-only, and the C6
  // lifecycle needs it. Proves the fence keys on non-dry, not on the target kind alone.
  const dry = await call(armed.routes, 'POST', PIPELINE_DRY_RUN_ROUTE, {
    user: WRITE_USER, params: { id: PIPELINE_ID }, body: {},
  })
  assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
  assert.deepEqual(armed.spies.pipelineRuns, [PIPELINE_ID], 'the dry run still reaches the runner')

  // DISCRIMINATING CONTROL 2: a NON-multitable target on the same non-dry route is not fenced.
  // Proves the fence keys on the target kind, not on non-dry alone.
  const otherTarget = mount({
    registrations: [registration({
      registrationId: 'b2a-runner',
      operationRef: 'op-runner',
      purpose: B2A_PURPOSE_PIPELINE_RUNNER_READ,
      projectDataScope: { dataScopeRefs: [PIPELINE_PROJECT_ID] },
      objectScope: { sourceObjects: [PIPELINE_SOURCE_OBJECT] },
    })],
    targetKind: 'mock-target',
  })
  const otherRan = await call(otherTarget.routes, 'POST', PIPELINE_RUN_ROUTE, {
    user: WRITE_USER, params: { id: PIPELINE_ID }, body: {},
  })
  assert.equal(otherRan.statusCode, 202, JSON.stringify(otherRan.body))
  assert.deepEqual(otherTarget.spies.pipelineRuns, [PIPELINE_ID])
}

// ── A MALFORMED REGISTRY FAILS AT REGISTRATION ──────────────────────────────

function assertRegistrationRefuses(raw, label) {
  let thrown = null
  try {
    mount({ raw })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, `${label}: route registration must throw`)
  assert.equal(thrown.name, 'B2aReadAuthorizationError', `${label}: wrong error class (${thrown.name})`)
  assert.equal(thrown.code, 'B2A_REGISTRY_INVALID', label)
  assert.equal(thrown.status, 500, label)
  return thrown
}

function aMalformedRegistryFailsAtRegistrationNotOnTheFirstRead() {
  // A typo in the registration file must NOT look exactly like "no registry configured" — that
  // difference is the difference between a gate and no gate.
  assertRegistrationRefuses(registry([registration({ expiresAt: undefined })]), 'no expiry')
  assertRegistrationRefuses(registry([registration({ ownerPrincipalRef: undefined })]), 'nobody owns it')
  assertRegistrationRefuses(registry([registration({ authorizationRef: undefined })]), 'no authorization ref')
  assertRegistrationRefuses(registry([registration({ operationRef: undefined })]), 'no operation ref')
  assertRegistrationRefuses(registry([registration({ b2bMigrationCondition: undefined })]), 'no migration condition')
  assertRegistrationRefuses(registry([registration({ expiryHandling: undefined })]), 'no expiry handling')
  assertRegistrationRefuses(registry([registration({ sourceBindingRef: undefined })]), 'no binding')
  assertRegistrationRefuses(registry([registration({ objectScope: { sourceObjects: [] } })]), 'an empty object scope')
  assertRegistrationRefuses(registry([registration({ forbidReuse: false })]), 'a reusable registration')
  assertRegistrationRefuses(registry([registration({ sourceReadOperationLimit: 5 })]), 'a raised operation limit')
  assertRegistrationRefuses(registry([registration({ expiresAt: '2999-01-01T00:00:00Z' })]), 'an unbounded window')
  assertRegistrationRefuses(registry([registration({ password: 'x' })]), 'a smuggled credential')
  assertRegistrationRefuses([registration()], 'an array is not a registry')
  const off = assertRegistrationRefuses(false, 'false is not a kill switch')
  assert.ok(off.message.includes('INTEGRATION_CORE_B2A_REGISTRY_PATH'), 'the message names the env var')

  // And a well-formed one still registers, so the guard above is not just "everything throws".
  assert.ok(mount({ registrations: [registration()] }).routes.size > 0)
}

// ── THE REGISTRY IS SERVER-RESOLVED, NEVER REQUEST-SUPPLIED ─────────────────

async function aRequestCannotSupplyOrDisarmTheRegistry() {
  const source = createRecordingSourceAdapter()
  const { routes } = mount({ registrations: [registration({ tenantScope: OTHER_TENANT_ID })], source })
  const attempts = [
    { body: { parameters: { projectNo: PROJECT_NO }, b2aTrialRegistry: registry([registration()]) } },
    { body: { parameters: { projectNo: PROJECT_NO }, b2aTrialRegistry: null } },
    { body: { parameters: { projectNo: PROJECT_NO, b2aTrialRegistry: registry([registration()]) } } },
    { body: { parameters: { projectNo: PROJECT_NO } }, query: { b2aTrialRegistry: 'null' } },
    { body: { parameters: { projectNo: PROJECT_NO } }, query: { b2aRunId: 'someone-elses-run' } },
  ]
  for (const attempt of attempts) {
    const res = await call(routes, 'POST', DRY_RUN_ROUTE, { user: READ_USER, params: ACTION_PARAMS, ...attempt })
    // Either the body/parameter allowlist rejects the extra key (400) or the guard refuses (403).
    // What must NEVER happen is a 200: a request cannot arm, disarm, widen or re-scope the registry.
    assert.notEqual(res.statusCode, 200, `a request steered the guard and was served: ${JSON.stringify(attempt)}`)
    assert.ok([400, 403].includes(res.statusCode), `unexpected status ${res.statusCode}: ${JSON.stringify(res.body)}`)
    assert.equal(source.reads.length, 0, 'no attempt reached the source')
  }
}

const TESTS = [
  unsetEnvIsDormantAndByteIdentical,
  unsetEnvLeavesTheOtherEntryPointsUntouched,
  armedWithAMatchingRegistrationPasses,
  R01_lifecycleRefusalsThroughTheRoute,
  R02_scopeRefusalsThroughTheRoute,
  R07_entry1_largeBomExpansion,
  R07_entry2_c6ExternalWriteDryRun,
  R07_entry3_ordinaryPipelineRunner,
  R07_entry4_sealedSnapshotSession,
  E3_01_ordinaryMultitableWriteIsRefused,
  aMalformedRegistryFailsAtRegistrationNotOnTheFirstRead,
  aRequestCannotSupplyOrDisarmTheRegistry,
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
