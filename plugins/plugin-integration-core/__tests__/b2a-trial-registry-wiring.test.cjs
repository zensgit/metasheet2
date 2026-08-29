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
// Case ids follow the acceptance matrix: R-01, R-02, R-05, R-06, R-07, E3-01..E3-05, plus M78 (the
// migration-078 wiring: armed + no database => refuse fail-closed at every entry point, dormant +
// no database => untouched, and the AUTHORITY for a spent operation is the SQL row rather than the
// kv record, which is now only a projection of it). NOT covered and
// NOT claimed here: R-08 (expiry disposition of value-bearing artifacts), and the ROW-LEVEL half of
// E3-05 (a data generation that moves mid-read), which no source on this path can report — see the
// note above `E3_05_aMidReadSourceChangeRefuses`.
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
  B2A_SOURCE_TIMEOUT,
  B2A_PAGE_LIMIT_EXCEEDED,
  B2A_SCHEMA_DRIFT,
  C6_SAFE_LIFECYCLE_REQUIRED,
  C6_FULL_BATCH_INCOMPLETE,
  SCHEMA_CONTRACT_KEY_PREFIX,
  SEALED_SNAPSHOT_BINDING_REF,
  B2A_AUTHORIZED_RUN_ID,
  B2A_AUTHORIZATION_INVALID,
  B2A_SOURCE_TIMEOUT_DISABLED_REJECTED,
  // R-wave (external review finding 4): the server-side C6 write-lifecycle context.
  C6_WRITE_LIFECYCLE_CONTEXT,
  readPlanSourceObjects,
  createB2aOperationClaim,
  B2A_OPERATION_CLAIM_TABLE,
  assertB2aReadAuthorization,
  createB2aRegistry,
} = require(path.join(LIB, 'b2a-trial-registry.cjs'))
// R-wave (external review finding 2): the REAL adapter whose armed read floors are opt-in on the
// authorization stanza. Used below to prove the runner threads that stanza rather than discarding it.
const {
  createDataSourceSqlReadonlySourceAdapterFactory,
} = require(path.join(LIB, 'adapters', 'data-source-sql-readonly-source-adapter.cjs'))
const {
  PLM_STOCK_PREPARATION_BOM_READ_PLAN,
} = require(path.join(LIB, 'stock-preparation-bom-expansion.cjs'))
// W-2: the runner is the layer the fence was sunk to, and index.cjs is the door that reaches it
// without a route. Both are exercised for real below rather than through a stand-in.
const { createPipelineRunner } = require(path.join(LIB, 'pipeline-runner.cjs'))
const {
  FEATURE_FLAG: STOCK_PREPARATION_FEATURE_FLAG,
} = require(path.join(LIB, 'sealed-export', 'stock-preparation-runtime-config.cjs'))

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

// The structural schema every fake source reports. Shape copied from the two real read-only
// adapters: `data-source:sql-readonly` emits `{ name, type, nullable }`, `bridge:legacy-sql-readonly`
// emits `{ name, label, type, required }` — the contract has to read both, so both are exercised.
function sourceSchema() {
  const columnsFor = (object) => {
    const rows = sourceData()[object]
    const names = Array.isArray(rows) && rows.length > 0 ? Object.keys(rows[0]) : ['OBJ_ID']
    return names.map((name) => ({ name, type: 'nvarchar', nullable: false }))
  }
  const out = {}
  for (const object of Object.keys(sourceData())) out[object] = columnsFor(object)
  return out
}

/**
 * THE CALL-RECORDING FAKE. `reads` is the whole point of this suite: "refused before any source
 * read" is not an argument about statement order, it is `reads.length === 0` after a refusal.
 *
 * `getSchema` is present because every REAL adapter has it — `contracts.cjs` lists it in
 * `REQUIRED_ADAPTER_METHODS`, so an adapter without one cannot be registered. R-06's contract check
 * fails closed on an adapter that cannot describe itself, and a fixture without `getSchema` would
 * therefore be testing a shape the runtime cannot produce.
 */
function createRecordingSourceAdapter(data = sourceData(), options = {}) {
  const reads = []
  const schemaReads = []
  const state = { schema: options.schema || sourceSchema(), pages: options.pages || null }
  return {
    reads,
    schemaReads,
    state,
    adapter: {
      async getSchema(input = {}) {
        schemaReads.push(input.object)
        const fields = state.schema[input.object]
        return { object: input.object, fields: Array.isArray(fields) ? fields.map(clone) : [] }
      },
      async read(input = {}) {
        reads.push(input.object)
        if (typeof options.onRead === 'function') {
          const injected = options.onRead(input, { reads, schemaReads, state })
          if (injected !== undefined) return injected
        }
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
    pipelineLoads: [],
    // W-2: what the ROUTE hands the runner under the shared-run marker. `undefined` for a dormant
    // deployment (nothing is attached at all) and the route's own server-generated run id when armed.
    runnerRunMarkers: [],
    // R-wave (finding 4): what the ROUTE hands the runner under the C6 write-lifecycle marker.
    // `undefined` when dormant — the same "no key at all" rule the run marker follows.
    runnerWriteContexts: [],
    // R-wave (finding 3): the NON-DECRYPTING config accessor the object-scope resolver uses. Armed
    // reads over a kind that can hide an object call it; a dormant one must never call it at all.
    configLoads: [],
    // R-wave (finding 2): the `deps` object each adapter was created with, so "the stanza is
    // threaded on the source side and the key is ABSENT when dormant" is a fact about an object.
    adapterDeps: [],
  }
}

function baseServices({ sourceAdapter, spies, targetKind, pipelineProjectId, includeGetDeadLetter, extraServices, sourceSystemConfig, omitAdapterConfigAccessor }) {
  const system = (id) => ({
    id,
    tenantId: TENANT_ID,
    name: 'system',
    kind: id === 'target_system' ? (targetKind || 'mock-target') : SYSTEM_KIND,
    role: id === 'target_system' ? 'target' : 'source',
    status: 'active',
    config: {
      dataSourceId: 'ds_plm',
      object: 'DN_PDM_PathExAttrInfo',
      // R-wave (finding 3): the PRIVATE config subtree. The real `getExternalSystem` deletes it from
      // the public projection, which is exactly why the guard needs its own non-decrypting accessor.
      ...(id === 'target_system' ? {} : (sourceSystemConfig || {})),
    },
  })
  return {
    externalSystemRegistry: {
      ...inertService(['upsertExternalSystem', 'deleteExternalSystem', 'listExternalSystems']),
      async getExternalSystem(input = {}) {
        spies.publicSystemLoads.push(input.id)
        // The PUBLIC projection strips each kind's private config keys — modelled here, because a
        // guard that could see `lookupProjection` through THIS accessor would prove nothing.
        const { config, ...rest } = system(input.id)
        const { lookupProjection: _private, ...publicConfig } = config
        return { ...rest, config: publicConfig }
      },
      // R-wave (finding 3): the NON-DECRYPTING adapter-config accessor. Omitted on request, which is
      // the fail-closed leg: an armed read over a kind that can hide an object refuses without it.
      ...(omitAdapterConfigAccessor === true ? {} : {
        async getExternalSystemAdapterConfig(input = {}) {
          spies.configLoads.push(input.id)
          const resolved = system(input.id)
          return { id: resolved.id, kind: resolved.kind, config: resolved.config }
        },
      }),
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
        spies.runnerRunMarkers.push(input[B2A_AUTHORIZED_RUN_ID])
        spies.runnerWriteContexts.push(input[C6_WRITE_LIFECYCLE_CONTEXT])
        return { id: 'run_1', status: 'succeeded' }
      },
      async replayDeadLetter(input = {}) {
        spies.pipelineRuns.push(input.id)
        spies.runnerRunMarkers.push(input[B2A_AUTHORIZED_RUN_ID])
        spies.runnerWriteContexts.push(input[C6_WRITE_LIFECYCLE_CONTEXT])
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
    // Opt-in only. The audit store and the reconcile lease are OPTIONAL services, and every test that
    // predates W-2 mounts without them; handing them to everybody would change what those routes do.
    ...(extraServices || {}),
  }
}

function actionConfig(overrides = {}) {
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: { externalSystemId: SOURCE_SYSTEM_ID, kind: SYSTEM_KIND },
    target: { sheetId: SHEET_ID, objectId: OBJECT_ID },
    ...overrides,
  }
}

// Migration 078's substrate, in-model: a fake of the SCOPED SQL helper whose insertOne enforces the
// PRIMARY KEY on claim_key the way Postgres does (same shape as the unit suite's, and as the PR-A
// lease fake in stock-preparation-confirmation-decisions.test.cjs).
function makeFakeClaimDb() {
  const rows = new Map()
  return {
    rows,
    async insertOne(table, row) {
      assert.equal(table, B2A_OPERATION_CLAIM_TABLE, `the claim must only touch ${B2A_OPERATION_CLAIM_TABLE}, saw ${table}`)
      if (rows.has(row.claim_key)) {
        const error = new Error('duplicate key value violates unique constraint')
        error.code = '23505'
        throw error
      }
      rows.set(row.claim_key, { ...row })
      return [{ ...row }]
    },
    async selectOne(table, where) {
      assert.equal(table, B2A_OPERATION_CLAIM_TABLE, `the claim must only touch ${B2A_OPERATION_CLAIM_TABLE}, saw ${table}`)
      const row = rows.get(where.claim_key)
      return row ? { ...row } : null
    },
  }
}

// The claim table's lifetime tracks the kv storage's, so a mount that carries storage forward keeps
// the claims it already made and a fresh mount starts clean — the substrate split in two, not the
// test semantics. `operationClaim: null` mounts a deployment whose db is unreachable.
const CLAIM_BY_STORAGE = new WeakMap()
function claimForStorage(storage) {
  if (!CLAIM_BY_STORAGE.has(storage)) {
    CLAIM_BY_STORAGE.set(storage, createB2aOperationClaim({ db: makeFakeClaimDb() }))
  }
  return CLAIM_BY_STORAGE.get(storage)
}

function mount({ registrations, raw, records, source, targetKind, pipelineProjectId, includeGetDeadLetter = true, action, storage, operationClaim, extraServices, sourceSystemConfig, omitAdapterConfigAccessor } = {}) {
  const routes = new Map()
  const spies = createSpies()
  const config = {
    stockPreparationTableActions: [actionConfig(action)],
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
    // `durable: true` is what the large-BOM job store demands; it is also where the values-free
    // PROJECTION of the B2a operation claim is recorded. Since migration 078 the AUTHORITY for the
    // one-operation limit is the SQL row, not this map.
    storage: storage || Object.assign(new Map(), { durable: true }),
    config,
  }
  httpRoutes.registerIntegrationRoutes({
    context,
    services: {
      ...baseServices({
        sourceAdapter: (source || createRecordingSourceAdapter()).adapter,
        spies,
        targetKind,
        pipelineProjectId,
        includeGetDeadLetter,
        // W-2: opt-in extra services (audit store, reconcile lease) for the routes that need them.
        extraServices,
        // R-wave (finding 3): an optional private source config, and the fail-closed leg.
        sourceSystemConfig,
        omitAdapterConfigAccessor,
      }),
      // W-3 / migration 078. `operationClaim: null` is an ARMED deployment whose database is
      // unreachable. Applied AFTER the baseServices spread so the mount-level parameter stays the
      // authority on the claim, exactly as the W-3 suite's M78 cases require.
      b2aOperationClaim: operationClaim === null ? null : (operationClaim || claimForStorage(context.storage)),
    },
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
const LARGE_BOM_PLAN_ROUTE = '/api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/plan'
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

// ── Migration 078: the claim is DB-enforced, threaded, and fail-closed ──────
//
// Three legs, because the interesting property is what happens at each of the three states a
// deployment can be in, not just the happy one.

async function M78_armedWithoutTheDbEnforcedClaimRefusesFailClosed() {
  // ARMED, database unreachable (`operationClaim: null`). Every gated entry point refuses with the
  // fixed code, and — the part that matters — NOT ONE of them falls back to the kv-only
  // read-then-write path that migration 078 exists to replace.
  const source = createRecordingSourceAdapter()
  const { routes, spies } = mount({ registrations: [registration()], source, operationClaim: null })

  const dry = await routeDryRun(routes)
  assertB2aRefusal(dry, B2A_AUTHORIZATION_INVALID, 'operation_claim_unavailable',
    'M78 armed + no claim: the stock-preparation dry-run')
  assert.equal(source.reads.length, 0, 'M78: the refused read touched ZERO source rows')
  assert.deepEqual(spies.credentialLoads, [], 'M78: and reloaded ZERO credentials')

  const c6 = await call(routes, 'POST', C6_DRY_RUN_ROUTE, { user: WRITE_USER, params: { id: PIPELINE_ID }, body: {} })
  assertB2aRefusal(c6, B2A_AUTHORIZATION_INVALID, 'operation_claim_unavailable', 'M78 armed + no claim: the C6 dry-run')

  const ran = await call(routes, 'POST', PIPELINE_RUN_ROUTE, { user: WRITE_USER, params: { id: PIPELINE_ID }, body: {} })
  assertB2aRefusal(ran, B2A_AUTHORIZATION_INVALID, 'operation_claim_unavailable', 'M78 armed + no claim: the pipeline runner')
  assert.deepEqual(spies.pipelineRuns, [], 'M78: the refused run started no pipeline')

  const sealed = await call(routes, 'POST', SEALED_SNAPSHOT_ROUTE, { user: ADMIN_USER, body: { operationId: 'op-1' } })
  assertB2aRefusal(sealed, B2A_AUTHORIZATION_INVALID, 'operation_claim_unavailable', 'M78 armed + no claim: the sealed-snapshot session')
  assert.deepEqual(spies.sealedSnapshotRuns, [], 'M78: the refused session opened nothing')

  assert.deepEqual(spies.credentialLoads, [], 'M78: across all four entry points, ZERO credential reloads')
}

async function M78_dormantNeedsNoClaimAtAll() {
  // DORMANT + no claim service: byte-identical to a deployment that never heard of B2a. The claim is
  // not merely unused — the guard returns before it is even looked at, which is why an unarmed
  // deployment cannot be broken by a database that is down.
  const source = createRecordingSourceAdapter()
  const records = createRecordsApi()
  const { routes, spies } = mount({ records, source, operationClaim: null })

  const res = await routeDryRun(routes)
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  assert.equal(res.body.data.status, 'ready')
  assert.ok(source.reads.length > 0, 'a dormant deployment reads its source exactly as before')
  assert.equal('b2aTrialRegistration' in res.body.data.evidence, false, 'a dormant deployment stamps no B2a stanza')

  const ran = await call(routes, 'POST', PIPELINE_RUN_ROUTE, { user: WRITE_USER, params: { id: PIPELINE_ID }, body: {} })
  assert.equal(ran.statusCode, 202, JSON.stringify(ran.body))
  assert.deepEqual(spies.pipelineRuns, [PIPELINE_ID], 'a dormant deployment runs the pipeline as before')

  const sealed = await call(routes, 'POST', SEALED_SNAPSHOT_ROUTE, { user: ADMIN_USER, body: { operationId: 'op-1' } })
  assert.equal(sealed.statusCode, 200, JSON.stringify(sealed.body))
  assert.deepEqual(spies.sealedSnapshotRuns, ['op-1'])
}

async function M78_theAuthorityIsTheSqlRowAndTheKvRecordIsAProjection() {
  // ARMED and wired. One armed dry-run must leave exactly ONE claim row in the DATABASE, and the
  // kv record under the same key must be a values-free projection of it — same key, no more
  // authority. Wiping the projection must NOT resurrect a spent operation.
  const claimDb = makeFakeClaimDb()
  const source = createRecordingSourceAdapter()
  const { routes, context } = mount({
    registrations: [registration()],
    source,
    operationClaim: createB2aOperationClaim({ db: claimDb }),
  })

  const res = await routeDryRun(routes)
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  assert.equal(claimDb.rows.size, 1, 'the armed read left exactly ONE claim row in the database')
  const [row] = [...claimDb.rows.values()]
  assert.equal(row.registration_id, 'b2a-factory-a-plm')
  assert.equal(row.registration_version, 1)
  assert.ok(typeof row.run_id === 'string' && row.run_id.length > 0, 'the row names the Run that holds it')
  assert.ok(!Number.isNaN(Date.parse(row.claimed_at)), 'claimed_at is a real timestamp')
  const rowText = JSON.stringify(row)
  for (const forbidden of FORBIDDEN_IN_RESPONSE) {
    assert.equal(rowText.includes(forbidden), false, `the claim row leaked ${JSON.stringify(forbidden)}`)
  }

  const kvClaimKeys = [...context.storage.keys()].filter((key) => key.startsWith('integration:b2a:operation-claim:'))
  assert.deepEqual(kvClaimKeys, [row.claim_key], 'the kv projection is keyed identically to the SQL row')

  // THE PROJECTION IS NOT THE AUTHORITY. Delete it and try a NEW Run: the SQL row still refuses.
  // Before migration 078 this deletion would have handed the caller a fresh, unlimited read.
  for (const key of kvClaimKeys) context.storage.delete(key)
  const readsSoFar = source.reads.length
  const applied = await call(routes, 'POST', APPLY_ROUTE, {
    user: ADMIN_USER,
    params: ACTION_PARAMS,
    body: { parameters: { projectNo: PROJECT_NO }, confirm: { dryRunToken: res.body.data.dryRunToken } },
  })
  assertB2aRefusal(applied, B2A_AUTHORIZATION_INVALID, 'operation_already_consumed',
    'M78 a wiped kv projection does not resurrect a spent operation')
  assert.equal(source.reads.length, readsSoFar, 'the refused Run read ZERO additional rows')
  assert.equal(claimDb.rows.size, 1, 'and wrote no second claim row')
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

// ── R-05 / R-06 / E3-02..E3-05: READ HARDENING, THE SCHEMA CONTRACT, FULL BATCH ─────────────
//
// Everything below is ARMED-ONLY by construction, and each case re-runs its own fixture DORMANT to
// prove it. That is not ceremony: the whole change rests on a deployment that has not set
// INTEGRATION_CORE_B2A_REGISTRY_PATH behaving exactly as it did before, and a guard that fires on
// both sides would break that silently.
//
// WHICH FIXED CODE, AND WHY IT IS NOT ALWAYS `C6_FULL_BATCH_INCOMPLETE`. §15.2 R-05 asks for a fixed
// timeout/limit code and E3-02 asks for `C6_FULL_BATCH_INCOMPLETE`, and a row cap is honestly BOTH.
// The split taken here: when a HARDENED BOUND explains why the batch is short, the code names that
// bound (`B2A_SOURCE_TIMEOUT` / `B2A_PAGE_LIMIT_EXCEEDED`) because that is what the caller can act
// on; when nothing does — a broken cursor, an unclassifiable read failure, a source that moved
// mid-read — the code names the property (`C6_FULL_BATCH_INCOMPLETE`). EVERY one of them carries
// `fullBatch: false` and produces no plan, no revision and no token, which is the invariant E3-02
// actually asserts, so `assertIncompleteBatchRefusal` checks the invariant on all of them and the
// code only where the case pins a specific cause.
const INCOMPLETE_BATCH_CODES = Object.freeze([
  B2A_SOURCE_TIMEOUT, B2A_PAGE_LIMIT_EXCEEDED, C6_FULL_BATCH_INCOMPLETE,
])

function assertIncompleteBatchRefusal(res, { code, reason, causeClass, status = 409 }, records, label) {
  assert.equal(res.statusCode, status, `${label}: expected ${status}, got ${res.statusCode} ${JSON.stringify(res.body)}`)
  assert.equal(res.body.ok, false, label)
  assert.ok(INCOMPLETE_BATCH_CODES.includes(res.body.error.code),
    `${label}: ${res.body.error.code} is not one of the frozen incomplete-batch codes`)
  if (code) assert.equal(res.body.error.code, code, `${label}: ${JSON.stringify(res.body.error)}`)
  if (reason) assert.equal(res.body.error.details.reason, reason, `${label}: wrong reason token`)
  if (causeClass) assert.equal(res.body.error.details.causeClass, causeClass, `${label}: cause class not preserved`)
  // NO BUSINESS ARTIFACT. The refusal body is an error, so there is no plan, no revision and no
  // token in it; and the records API — the only thing that could have written a target row — was
  // never touched.
  assert.equal(res.body.data, undefined, `${label}: a refusal must carry no plan payload`)
  if (records) {
    const writes = records.calls.filter(([name]) => name !== 'queryRecords')
    assert.deepEqual(writes, [], `${label}: target writes must be 0`)
  }
  const text = JSON.stringify(res.body)
  for (const forbidden of FORBIDDEN_IN_RESPONSE) {
    assert.equal(text.includes(forbidden), false, `${label}: response leaked ${JSON.stringify(forbidden)}`)
  }
}

// R-05 — A SOURCE TIMEOUT SURFACES THE FIXED CODE, NOT THE DRIVER'S.
//
// The failure injected is the one the host's `requestTimeout` actually produces: mssql/tedious
// raises `RequestError` with `code: 'ETIMEOUT'`. Nothing in this repo recognized that token before —
// `inferHttpStatus` turned it into a 500 carrying the driver's own message, which is both
// values-bearing and useless as evidence. Note the expander CATCHES the throw and records it as a
// global error, so this also pins that the ORIGINAL CAUSE CLASS survives that catch: without it the
// seam could only say "incomplete", never "timed out".
async function R05_armedSourceTimeoutSurfacesTheFixedCode() {
  const timeout = () => {
    const error = new Error('Timeout: Request failed to complete in 30000ms')
    error.name = 'RequestError'
    error.code = 'ETIMEOUT'
    throw error
  }
  const source = createRecordingSourceAdapter(sourceData(), { onRead: timeout })
  const records = createRecordsApi()
  const { routes } = mount({ registrations: [registration()], source, records })
  const res = await routeDryRun(routes)
  assertIncompleteBatchRefusal(res, {
    code: B2A_SOURCE_TIMEOUT, reason: 'source_read_timeout', causeClass: 'ETIMEOUT', status: 504,
  }, records, 'R-05 timeout')

  // DORMANT, same injected failure: no B2a code, and the pre-change shape is untouched.
  const dormantSource = createRecordingSourceAdapter(sourceData(), { onRead: timeout })
  const dormant = await routeDryRun(mount({ source: dormantSource }).routes)
  assert.equal(dormant.statusCode, 200, 'a dormant deployment still returns its ordinary failed dry-run')
  assert.equal(dormant.body.data.status, 'failed')
  assert.equal(dormant.body.data.canApply, false)
  assert.equal(dormant.body.data.dryRunToken, null, 'a failed dry-run mints no token, armed or not')
}

// R-05 — A ROW/PAGE CAP SURFACES THE FIXED LIMIT CODE.
//
// `maxReadCount: 1` is the smallest bound the action schema accepts and the read plan needs several
// objects, so the second page trips `read_count_exceeded` deterministically — no clock, no data
// volume. The four expander bounds share one fixed code on purpose: from the caller's side
// "the row cap fired" and "the page cap fired" are the same fact, and §15.2 R-05 asks for one.
async function R05_armedRowAndPageCapSurfaceTheFixedLimitCode() {
  const source = createRecordingSourceAdapter()
  const records = createRecordsApi()
  const { routes } = mount({
    registrations: [registration()], source, records, action: { maxReadCount: 1 },
  })
  const res = await routeDryRun(routes)
  assertIncompleteBatchRefusal(res, {
    code: B2A_PAGE_LIMIT_EXCEEDED, reason: 'source_read_bound_exceeded', causeClass: 'read_count_exceeded',
  }, records, 'R-05 cap')

  // DORMANT: the same bound fires, and the same truncated-but-unappliable dry-run comes back that
  // came back before this change. `canApply: false` was ALREADY true here — what was missing was a
  // fixed code and the refusal to build a plan off a partial read.
  const dormant = await routeDryRun(mount({
    source: createRecordingSourceAdapter(), action: { maxReadCount: 1 },
  }).routes)
  assert.equal(dormant.statusCode, 200)
  assert.equal(dormant.body.data.canApply, false)
  assert.ok(dormant.body.data.evidence.expansion.errorTypes.includes('read_count_exceeded'))
}

// R-06 — THE FIRST ARMED READ PINS THE CONTRACT; AN IDENTICAL SCHEMA PASSES.
//
// Two mounts, because one registration authorizes exactly one source-read Run: the second mount
// re-presents the contract the first one pinned, which is what a second Run under a fresh
// registration sees. The contract lives in the SAME durable store the operation claim and the
// registration-version floor use — the registry file is a read-only deploy artifact and is never
// written to.
async function R06_firstArmedReadPinsTheContractAndAnIdenticalSchemaPasses() {
  const first = mount({ registrations: [registration()], source: createRecordingSourceAdapter() })
  const pinned = await routeDryRun(first.routes)
  assert.equal(pinned.statusCode, 200, JSON.stringify(pinned.body))
  const stanza = pinned.body.data.evidence.b2aSchemaContract
  assert.ok(stanza, 'an armed read stamps the contract stanza')
  assert.equal(stanza.schemaContractPinned, true, 'the FIRST armed read pins')
  assert.equal(stanza.schemaDrift, false)
  assert.equal(stanza.objectCount, STOCK_PREP_OBJECTS.length, 'the contract covers every object the plan touches')
  assert.ok(Number.isInteger(stanza.fieldCount) && stanza.fieldCount > 0)
  // VALUES-FREE: a digest, two counts, two booleans and a version. No column name, no object name.
  assert.deepEqual(Object.keys(stanza).sort(), [
    'fieldCount', 'objectCount', 'schemaContractPinned', 'schemaContractVersion', 'schemaDigest', 'schemaDrift',
  ])
  assert.match(stanza.schemaDigest, /^[0-9a-f]{64}$/)

  const contractKeys = [...first.context.storage.keys()].filter((key) => key.startsWith(SCHEMA_CONTRACT_KEY_PREFIX))
  assert.equal(contractKeys.length, 1, 'exactly one contract record, keyed to the registration')
  const stored = first.context.storage.get(contractKeys[0])
  assert.equal(JSON.stringify(stored).includes('IdentityNo'), false, 'no column name is stored in the clear')
  assert.equal(JSON.stringify(stored).includes('DN_PDM_PartLibraryInfo'), false, 'no object name is stored in the clear')

  // SAME SCHEMA, SECOND RUN -> passes, and reports that it compared rather than pinned.
  const storage = Object.assign(new Map(first.context.storage), { durable: true })
  for (const key of [...storage.keys()]) {
    if (!key.startsWith(SCHEMA_CONTRACT_KEY_PREFIX)) storage.delete(key)
  }
  const second = mount({ registrations: [registration()], source: createRecordingSourceAdapter(), storage })
  const compared = await routeDryRun(second.routes)
  assert.equal(compared.statusCode, 200, JSON.stringify(compared.body))
  assert.equal(compared.body.data.evidence.b2aSchemaContract.schemaContractPinned, false, 'the second read COMPARES')
  assert.equal(compared.body.data.evidence.b2aSchemaContract.schemaDrift, false)
  assert.equal(compared.body.data.evidence.b2aSchemaContract.schemaDigest,
    stanza.schemaDigest, 'an identical schema produces an identical digest')
  assert.equal(compared.body.data.revision, pinned.body.data.revision, 'and the plan is the plan it was')
}

// R-06 — DRIFT REFUSES BEFORE ANY BUSINESS ARTIFACT.
//
// Three drift kinds, each on the SAME pinned contract: a column dropped, a column retyped, and the
// `ext_` mapping identity changed (§13's 映射漂移, which is not a source property at all). Every one
// refuses with the fixed code, and `source.reads.length === 0` is the load-bearing assertion: the
// contract is compared before the first ROW is read, so no plan, revision or evidence can exist.
async function R06_schemaDriftRefusesBeforeAnyBusinessArtifact() {
  const seed = mount({ registrations: [registration()], source: createRecordingSourceAdapter() })
  assert.equal((await routeDryRun(seed.routes)).statusCode, 200)
  const pinnedStorage = () => {
    const storage = Object.assign(new Map(), { durable: true })
    for (const [key, value] of seed.context.storage) {
      if (key.startsWith(SCHEMA_CONTRACT_KEY_PREFIX)) storage.set(key, value)
    }
    assert.equal(storage.size, 1, 'the pinned contract was carried forward')
    return storage
  }

  const dropped = sourceSchema()
  dropped.DN_PDM_PartLibraryInfo = dropped.DN_PDM_PartLibraryInfo.slice(1)
  const retyped = sourceSchema()
  retyped.DN_PDM_PartLibraryInfo = retyped.DN_PDM_PartLibraryInfo.map((column, index) =>
    (index === 0 ? { ...column, type: 'int' } : column))
  const renullabled = sourceSchema()
  renullabled.DN_PDM_PartLibraryInfo = renullabled.DN_PDM_PartLibraryInfo.map((column, index) =>
    (index === 0 ? { ...column, nullable: true } : column))

  for (const [label, schema] of [['field missing', dropped], ['type change', retyped], ['nullability change', renullabled]]) {
    const source = createRecordingSourceAdapter(sourceData(), { schema })
    const records = createRecordsApi()
    const { routes } = mount({ registrations: [registration()], source, records, storage: pinnedStorage() })
    const res = await routeDryRun(routes)
    assert.equal(res.statusCode, 409, `${label}: ${JSON.stringify(res.body)}`)
    assert.equal(res.body.error.code, B2A_SCHEMA_DRIFT, label)
    assert.equal(res.body.error.details.reason, 'schema_contract_drift', label)
    assert.equal(source.reads.length, 0, `${label}: drift refuses BEFORE the first source row`)
    assert.deepEqual(records.calls, [], `${label}: no target read or write happened`)
    assert.equal(res.body.data, undefined, `${label}: no plan payload`)
    const text = JSON.stringify(res.body)
    for (const forbidden of [...FORBIDDEN_IN_RESPONSE, 'IdentityNo', 'DN_PDM_PartLibraryInfo']) {
      assert.equal(text.includes(forbidden), false, `${label}: leaked ${JSON.stringify(forbidden)}`)
    }
  }

  // DORMANT with the same drifted source: nothing is compared and nothing refuses.
  const dormant = await routeDryRun(mount({
    source: createRecordingSourceAdapter(sourceData(), { schema: dropped }),
  }).routes)
  assert.equal(dormant.statusCode, 200, 'a dormant deployment has no contract to drift from')
  assert.equal('b2aSchemaContract' in dormant.body.data.evidence, false, 'and stamps no contract stanza')
}

// E3-02 — A BROKEN CURSOR REFUSES, WHERE IT USED TO TRUNCATE IN SILENCE.
//
// THE DEFECT THIS PINS. `readAll`'s page loop terminated on `!result.nextCursor`, so a page that
// reported `done: false` and supplied no cursor ended the batch and returned what it had. The
// planner then received a PARTIAL BOM as if it were the whole one — `canApply: true`, a token
// minted, a revision that hashes a truncated expansion. That is §9.1(3)'s 断游标 case and it was
// reachable in production, not hypothetical.
//
// The check is `done === false`, not falsy, because the ordinary single-page shape
// (`{ records: [...] }`) leaves `done` UNDEFINED and must keep terminating normally — an assertion
// the dormant leg below would catch if it were widened.
async function E3_02_brokenCursorRefusesAndNoPlanIsProduced() {
  const brokenCursor = (input) => (input.object === PLM_STOCK_PREPARATION_BOM_READ_PLAN.pathExAttr.object
    ? { records: sourceData()[input.object].map(clone), done: false, nextCursor: null }
    : undefined)
  const source = createRecordingSourceAdapter(sourceData(), { onRead: brokenCursor })
  const records = createRecordsApi()
  const { routes } = mount({ registrations: [registration()], source, records })
  const res = await routeDryRun(routes)
  assertIncompleteBatchRefusal(res, {
    code: C6_FULL_BATCH_INCOMPLETE, reason: 'source_read_cursor_broken', causeClass: 'read_cursor_broken',
  }, records, 'E3-02 broken cursor')
  assert.equal(res.body.error.details.fullBatch, false, 'the refusal states the property it failed')

  // DORMANT: byte-identically the old behaviour, truncation included. The guard is armed-only, and
  // this leg is what proves it rather than asserting it.
  const dormantSource = createRecordingSourceAdapter(sourceData(), { onRead: brokenCursor })
  const dormant = await routeDryRun(mount({ source: dormantSource }).routes)
  assert.equal(dormant.statusCode, 200, 'a dormant deployment keeps the loop it had')
  assert.equal(dormant.body.data.evidence.expansion.errorTypes.includes('read_cursor_broken'), false)

  // AND THE ORDINARY TERMINATION IS UNTOUCHED WHEN ARMED: `done: true` with no cursor is a complete
  // batch, and `done` absent is the common fixture shape. Neither may be read as a broken cursor.
  const ordinary = await routeDryRun(mount({
    registrations: [registration()],
    source: createRecordingSourceAdapter(sourceData(), {
      onRead: (input) => ({ records: (sourceData()[input.object] || []).filter((row) =>
        Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected)).map(clone) }),
    }),
  }).routes)
  assert.equal(ordinary.statusCode, 200, `a cursorless complete page is not a broken cursor: ${JSON.stringify(ordinary.body)}`)
}

// E3-03 — NO WATERMARK IS READ OR ADVANCED ON THE DEDICATED PATH. (PROVEN, not guarded.)
//
// The property holds STRUCTURALLY: the dedicated stock-preparation path never asks for one. So this
// is a proof in two independent halves, because either alone is weak:
//
//   GREP HALF     — the three modules that make up the dedicated path contain no watermark token at
//                   all. This catches a future edit that adds watermark machinery even on a code
//                   path this suite's fixtures never reach.
//   RUNTIME HALF  — every read request the path actually issues is inspected: no `watermark`, no
//                   `watermarkConfig`, and no cursor carrying the source adapter's watermark prefix
//                   (`dswm1:`, from data-source-sql-readonly-source-adapter.cjs). And no key in the
//                   durable store — the one place a watermark could be persisted — names one.
//
// A mutation that wires a watermark in must fail BOTH halves, which is the property §9.1(5) freezes:
// B2a `full_snapshot` neither reads, sets, nor advances an incremental watermark, in any end state.
async function E3_03_noWatermarkIsReadOrAdvancedOnTheDedicatedPath() {
  const fs = require('node:fs')
  const DEDICATED_PATH_MODULES = [
    'stock-preparation-bom-expansion.cjs',
    'stock-preparation-table-actions.cjs',
    'stock-preparation-large-bom-jobs.cjs',
  ]
  for (const module of DEDICATED_PATH_MODULES) {
    const text = fs.readFileSync(path.join(LIB, module), 'utf8')
    const hits = text.match(/watermark/gi) || []
    assert.deepEqual(hits, [], `${module} names a watermark ${hits.length} time(s); the dedicated path has none`)
  }

  const requests = []
  const source = createRecordingSourceAdapter(sourceData(), {
    onRead: (input) => { requests.push(input); return undefined },
  })
  const { routes, context } = mount({ registrations: [registration()], source })
  const res = await routeDryRun(routes)
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  assert.ok(requests.length > 0, 'the path did read its source')
  for (const request of requests) {
    assert.equal('watermark' in request, false, 'a read request carried a watermark')
    assert.equal('watermarkConfig' in request, false, 'a read request carried a watermark config')
    assert.equal(String(request.cursor || '').startsWith('dswm1:'), false, 'a read used a watermark cursor')
    assert.deepEqual(Object.keys(request).sort().filter((key) => /water|since|incremental/i.test(key)), [])
  }
  for (const key of context.storage.keys()) {
    assert.equal(/water|high_?water|incremental/i.test(key), false, `durable key ${key} looks like a watermark`)
  }
}

// E3-04 — A MULTI-PAGE BATCH IS ONE PLAN, ONE TOKEN, ONE CLAIM. (PROVEN, not guarded.)
//
// §9.1(2): cursor paging produces no independent approval, token or watermark. The dedicated path
// holds this structurally — paging happens INSIDE one `expandPlmProjectBom` call, inside one guarded
// Run — so this pins the counts rather than adding a guard. The fixture pages the largest object
// three ways so the assertion is about a genuinely multi-page batch, not a single-page one.
async function E3_04_aMultiPageBatchProducesExactlyOnePlanAndOneToken() {
  const PAGED_OBJECT = PLM_STOCK_PREPARATION_BOM_READ_PLAN.orderDetail.object
  const rows = [
    { order_id: 'ORDER-1', part_id: 'PART-A', quantity: '2', sort_id: '1' },
    { order_id: 'ORDER-1', part_id: 'PART-A', quantity: '3', sort_id: '2' },
    { order_id: 'ORDER-1', part_id: 'PART-A', quantity: '4', sort_id: '3' },
  ]
  let pages = 0
  const source = createRecordingSourceAdapter(sourceData(), {
    onRead: (input) => {
      if (input.object !== PAGED_OBJECT) return undefined
      const index = input.cursor ? Number(input.cursor) : 0
      pages += 1
      const last = index >= rows.length - 1
      return {
        records: [clone(rows[index])],
        done: last,
        nextCursor: last ? null : String(index + 1),
      }
    },
  })
  const records = createRecordsApi()
  const { routes, context } = mount({ registrations: [registration()], source, records })
  const res = await routeDryRun(routes)
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  assert.equal(pages, rows.length, 'the batch really did span several pages')

  // ONE plan: one revision, one set of counts, and a row count that is the SUM of the pages — a
  // per-page plan would have produced the last page's rows only.
  assert.equal(typeof res.body.data.revision, 'string')
  assert.equal(res.body.data.evidence.expansion.rowsExpanded, rows.length, 'every page landed in the one plan')
  // ONE token, for the whole batch.
  const tokenKeys = [...context.storage.keys()].filter((key) => key.startsWith('integration:table-action:dry-run-token:'))
  assert.equal(tokenKeys.length, 1, 'a multi-page batch mints exactly one dry-run token')
  // ONE operation claim, continued across the pages rather than re-taken per page.
  const claimKeys = [...context.storage.keys()].filter((key) => key.startsWith('integration:b2a:operation-claim:'))
  assert.equal(claimKeys.length, 1, 'a multi-page batch spends exactly one operation claim')
  assert.equal(res.body.data.evidence.b2aTrialRegistration.sourceReadOperationLimit, 1)
  // ONE schema contract, not one per page.
  const contractKeys = [...context.storage.keys()].filter((key) => key.startsWith(SCHEMA_CONTRACT_KEY_PREFIX))
  assert.equal(contractKeys.length, 1)
}

// E3-05 — A SOURCE THAT CHANGES MID-READ REFUSES. (GUARDED, for the half that is observable.)
//
// The schema is re-read after the batch and compared to the digest the pre-read check agreed on, so
// a DDL change while the batch was in flight refuses with a fixed incomplete code and no plan.
//
// WHAT IS NOT COVERED, and is DEFERRED rather than faked: a ROW-LEVEL generation change. These
// sources carry no generation marker, snapshot token or change counter, so "the rows moved under us
// mid-read" is not observable from here at any cost short of source-side snapshot isolation — which
// is Mirror-spike machinery, and anything built for it now would be replaced by it. The half that IS
// observable is guarded here; the half that is not is named in the change description.
async function E3_05_aMidReadSourceChangeRefuses() {
  const source = createRecordingSourceAdapter(sourceData(), {
    onRead: (input, ctx) => {
      // Mutate the schema the moment the batch has started, so the pre-read pin and the post-read
      // check see two different sources.
      ctx.state.schema = { ...ctx.state.schema, [input.object]: [{ name: 'renamed', type: 'nvarchar', nullable: false }] }
      return undefined
    },
  })
  const records = createRecordsApi()
  const { routes } = mount({ registrations: [registration()], source, records })
  const res = await routeDryRun(routes)
  assertIncompleteBatchRefusal(res, {
    code: C6_FULL_BATCH_INCOMPLETE, reason: 'source_changed_mid_read',
  }, records, 'E3-05 mid-read change')
  assert.equal(res.body.error.details.fullBatch, false)
  assert.ok(source.reads.length > 0, 'the batch was read before the change was detected')

  // DORMANT: the same mid-read change, and nothing looks.
  const dormant = await routeDryRun(mount({
    source: createRecordingSourceAdapter(sourceData(), {
      onRead: (input, ctx) => {
        ctx.state.schema = { ...ctx.state.schema, [input.object]: [] }
        return undefined
      },
    }),
  }).routes)
  assert.equal(dormant.statusCode, 200, 'a dormant deployment reads no schema at all')
}

// E3-02, background half — PROVEN, not guarded. The large-BOM path already holds the property
// structurally and this pins the mechanism rather than adding a second one: ANY global error makes
// `expandPlmProjectBom` return `valid: false`, which makes the job `failed` and `authoritative:
// false`, and `tableActionLargeBomExpansionJobPlan` refuses a non-authoritative artifact BEFORE it
// builds a plan. So a truncated background expansion cannot become a plan on this path either — by
// a different route than the small path's refusal, and worth pinning precisely because it differs.
async function E3_02_aTruncatedBackgroundExpansionNeverBecomesAPlan() {
  const registrations = [registration({
    registrationId: 'b2a-large-bom',
    operationRef: 'op-large-bom',
    purpose: B2A_PURPOSE_STOCK_PREPARATION_LARGE_BOM,
  })]
  const records = createRecordsApi()
  const { routes } = mount({
    registrations, records, source: createRecordingSourceAdapter(), action: { maxReadCount: 1 },
  })
  const started = await call(routes, 'POST', LARGE_BOM_START_ROUTE, {
    user: READ_USER, params: ACTION_PARAMS, body: { parameters: { projectNo: PROJECT_NO } },
  })
  const jobId = started.body.data.jobId || started.body.data.id
  const ran = await call(routes, 'POST', LARGE_BOM_RUN_ROUTE, {
    user: READ_USER, params: { ...ACTION_PARAMS, jobId }, body: {},
  })
  assert.equal(ran.statusCode, 200, JSON.stringify(ran.body))
  assert.equal(ran.body.data.status, 'failed', 'a bounded background expansion does not complete')
  assert.equal(ran.body.data.authoritative, false, 'and it is never authoritative')

  const planned = await call(routes, 'POST', LARGE_BOM_PLAN_ROUTE, {
    user: READ_USER, params: { ...ACTION_PARAMS, jobId }, body: {},
  })
  assert.equal(planned.body.ok, false, `a truncated artifact must not plan: ${JSON.stringify(planned.body)}`)
  assert.equal(planned.body.error.code, 'LARGE_BOM_ARTIFACT_NOT_AUTHORITATIVE')
  assert.equal(planned.body.data, undefined, 'plan payloads = 0')
  const writes = records.calls.filter(([name]) => name !== 'queryRecords')
  assert.deepEqual(writes, [], 'target writes = 0')
}

// ══════════════════════════════════════════════════════════════════════════════
// W-2 — THE CHOKE POINT, SUNK BELOW THE HTTP LAYER
// ══════════════════════════════════════════════════════════════════════════════
//
// Two gaps, both verified on main before this suite grew:
//
//   (1) `tableActionConfirmationDecisionsReconcile` called `loadTableActionSourceAdapter` — and so
//       `getExternalSystemForAdapter`, which DECRYPTS — with no B2a assertion in front of it. Every
//       other stock-prep read entry got the fence in PR-C; this route was missed, and its handoff
//       (`prepareStockPreparationConfirmationDecisions`) carries no wrapper-level guard either, so
//       nothing further down caught it.
//
//   (2) The cross-plugin communication API's `runPipeline` / `replayDeadLetter` enter the pipeline
//       runner DIRECTLY. PR-C's own comment said "every caller that exists today ... is a route and
//       is covered"; these two existed and were not. Any plugin holding
//       `context.communication.call('integration-core', 'runPipeline', …)` read an armed
//       deployment's source with no registration.
//
// What is asserted here is the same thing the PR-C suite asserts and nothing softer: a refusal is
// `reads.length === 0` and `credentialLoads.length === 0`, not an argument about statement order.

function capturedRejection(promise) {
  return promise.then(
    (value) => { throw new Error(`expected a rejection, got ${JSON.stringify(value)}`) },
    (error) => error,
  )
}

// The registration that authorizes the PIPELINE-RUNNER entry point for this suite's fixture pipeline.
function runnerRegistration(overrides = {}) {
  return registration({
    registrationId: 'b2a-runner',
    operationRef: 'op-runner',
    purpose: B2A_PURPOSE_PIPELINE_RUNNER_READ,
    projectDataScope: { dataScopeRefs: [PIPELINE_PROJECT_ID] },
    objectScope: { sourceObjects: [PIPELINE_SOURCE_OBJECT] },
    ...overrides,
  })
}

/**
 * A REAL `createPipelineRunner`, wired the way index.cjs wires it. Not a stand-in: the whole point
 * of W-2 is that the fence is INSIDE this module, so a fake runner would assert nothing.
 */
function createRunnerHarness({
  registrations,
  storage,
  pipelineOverrides,
  // R-wave (finding 3): the SOURCE system's private config, and the fail-closed leg that removes the
  // non-decrypting accessor the object-scope resolver needs.
  sourceSystemConfig,
  omitAdapterConfigAccessor,
  // R-wave (finding 2): build the source adapter with a REAL factory instead of the recording fake,
  // so "the stanza reaches the adapter" can be proven by the adapter's own armed floor firing.
  sourceAdapterFactory,
} = {}) {
  const spies = createSpies()
  const source = createRecordingSourceAdapter()
  const config = {}
  if (registrations !== undefined) config[B2A_REGISTRY_CONFIG_KEY] = registry(registrations)
  const b2aTrialRegistry = createB2aRegistry({ config })
  const claimStore = storage || Object.assign(new Map(), { durable: true })
  const pipeline = {
    id: PIPELINE_ID,
    tenantId: TENANT_ID,
    workspaceId: null,
    status: 'active',
    mode: 'manual',
    createdBy: 'owner@example.invalid',
    projectId: PIPELINE_PROJECT_ID,
    sourceSystemId: SOURCE_SYSTEM_ID,
    targetSystemId: 'target_system',
    sourceObject: PIPELINE_SOURCE_OBJECT,
    targetObject: 'imported_items',
    fieldMappings: [],
    options: {},
    ...(pipelineOverrides || {}),
  }
  const system = (id) => ({
    id,
    tenantId: TENANT_ID,
    kind: id === 'target_system' ? 'mock-target' : SYSTEM_KIND,
    role: id === 'target_system' ? 'target' : 'source',
    status: 'active',
    config: id === 'target_system' ? {} : { dataSourceId: 'ds_plm', ...(sourceSystemConfig || {}) },
  })
  const deadLetter = {
    id: 'dl_1',
    tenantId: TENANT_ID,
    workspaceId: null,
    pipelineId: PIPELINE_ID,
    status: 'open',
    retryCount: 0,
    sourcePayload: { code: 'ROW-1' },
  }
  const targetWrites = []
  const runner = createPipelineRunner({
    pipelineRegistry: {
      async getPipeline(input = {}) {
        spies.pipelineLoads.push(input.id)
        return pipeline
      },
    },
    externalSystemRegistry: {
      async getExternalSystem(input = {}) {
        // The credential-STRIPPED accessor. The fence may use this one; it never decrypts. It also
        // strips each kind's PRIVATE config subtree, which is why a second accessor exists.
        spies.publicSystemLoads.push(input.id)
        const { config, ...rest } = system(input.id)
        const { lookupProjection: _private, ...publicConfig } = config
        return { ...rest, config: publicConfig }
      },
      // R-wave (finding 3): the non-decrypting adapter-config accessor. `credentialLoads` stays
      // untouched by it — which is the property that lets the object-scope widening sit INSIDE the
      // fence instead of after the credential reload.
      ...(omitAdapterConfigAccessor === true ? {} : {
        async getExternalSystemAdapterConfig(input = {}) {
          spies.configLoads.push(input.id)
          const resolved = system(input.id)
          return { id: resolved.id, kind: resolved.kind, config: resolved.config }
        },
      }),
      async getExternalSystemForAdapter(input = {}) {
        // THE CREDENTIAL RELOAD. Every armed refusal below requires this to have stayed empty of the
        // SOURCE binding.
        spies.credentialLoads.push(input.id)
        return system(input.id)
      },
    },
    adapterRegistry: {
      createAdapter(sys, options = {}) {
        spies.adapterCreations.push(sys && sys.id)
        spies.adapterDeps.push({ id: sys && sys.id, options })
        if (options.role === 'source' && typeof sourceAdapterFactory === 'function') {
          return sourceAdapterFactory({ system: sys, ...options })
        }
        if (options.role === 'target') {
          return {
            async upsert(input = {}) {
              targetWrites.push(input.object)
              return { written: (input.records || []).length, skipped: 0, failed: 0, errors: [] }
            },
            async previewUpsert() { return { records: [] } },
          }
        }
        return source.adapter
      },
    },
    deadLetterStore: {
      async createDeadLetter() { return null },
      async getDeadLetter() { return { ...deadLetter } },
      async markReplayed() { return { ...deadLetter, status: 'replayed' } },
    },
    watermarkStore: {
      async getWatermark() { return null },
      async setWatermark() { return null },
    },
    runLogger: {
      async startRun(input = {}) { return { id: 'run_1', ...input } },
      async finishRun(run, metrics, status) { return { ...run, status } },
    },
    b2aTrialRegistry,
    b2aClaimStore: claimStore,
    // MERGE-TRAIN (W-3 x W-2). The runner's fence needs migration 078's DB-enforced claim exactly as
    // the routes do — `claimForStorage` keys it off the SAME store, so a route and a runner sharing
    // one claim store share one claim table, which is what the shared-run cases below assert.
    b2aOperationClaim: claimForStorage(claimStore),
  })
  return { runner, spies, source, claimStore, targetWrites, b2aTrialRegistry }
}

function runnerInput(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    workspaceId: null,
    pipelineId: PIPELINE_ID,
    mode: 'full',
    triggeredBy: 'plugin',
    ...overrides,
  }
}

/**
 * R-wave (finding 4). The shape a GOVERNED live write has by the time it reaches the runner: the
 * C6 write-lifecycle context the two HTTP write routes attach AFTER their own lifecycle checks.
 *
 * Every case below whose subject is the READ fence uses this, because without it an armed live run
 * is now refused one layer earlier — which is the new fence doing its job, not the read fence. The
 * write fence has its own cases (`R3_*`), and the DISCRIMINATING control there is precisely that the
 * same call without this marker is refused with a different code.
 */
function runnerWriteInput(overrides = {}) {
  return runnerInput({ [C6_WRITE_LIFECYCLE_CONTEXT]: true, ...overrides })
}

function replayInput(overrides = {}) {
  return { tenantId: TENANT_ID, workspaceId: null, id: 'dl_1', ...overrides }
}

function governedReplayInput(overrides = {}) {
  return replayInput({ [C6_WRITE_LIFECYCLE_CONTEXT]: true, ...overrides })
}

function claimKeysIn(store) {
  return [...store.keys()].filter((key) => key.startsWith('integration:b2a:operation-claim:'))
}

function assertRunnerRefusal(error, code, reason, label) {
  assert.equal(error.name, 'B2aReadAuthorizationError', `${label}: wrong error class (${error.name}: ${error.message})`)
  assert.equal(error.status, 403, label)
  assert.equal(error.code, code, `${label}: ${JSON.stringify(error.details)}`)
  assert.equal(error.details.reason, reason, `${label}: wrong reason token`)
  const text = JSON.stringify(error.details)
  for (const forbidden of FORBIDDEN_IN_RESPONSE) {
    assert.equal(text.includes(forbidden), false, `${label}: refusal leaked ${JSON.stringify(forbidden)}`)
  }
}

// ── (1) the confirmation-decision RECONCILE route ────────────────────────────

// The reconcile route needs the two OPTIONAL services it fails closed without. They are handed to
// this route's mounts only, so every test that predates W-2 keeps the harness it had.
function reconcileServices() {
  return {
    stockPreparationAuditStore: { async append() { return { ok: true } } },
    stockPreparationConfirmationDecisionLease: {
      async acquire() { return { held: true, leaseId: 'lease-1' } },
      // MERGE-TRAIN (W-4 x W-2). W-4 made `renew` a REQUIRED method on the reconcile-lease
      // contract — a lease without it is refused fail-closed with
      // CONFIRMATION_DECISION_RECONCILE_LEASE_UNAVAILABLE. This double was written against the
      // pre-W-4 contract, so without this leg the reconcile route stops at the lease check instead
      // of the field-id resolution the case below pins. Production is unaffected: the real
      // `createConfirmationDecisionReconcileLease` grew `renew` in the same change.
      async renew() { return { held: true } },
      async release() { return { released: true } },
    },
  }
}

const RECONCILE_ROUTE = '/api/integration/table-actions/:actionId/confirmation-decisions/reconcile'

async function routeReconcile(routes, { projectNo = PROJECT_NO } = {}) {
  return call(routes, 'POST', RECONCILE_ROUTE, {
    user: ADMIN_USER, params: ACTION_PARAMS, body: { parameters: { projectNo } },
  })
}

async function W2_reconcileRouteIsFencedBeforeAnyCredentialReload() {
  // Armed for the PIPELINE-RUNNER purpose: reconcile presents `stock-preparation.table-action` and
  // a registration written for another consumer does not cover it.
  for (const [registrations, code, reason, label] of [
    [[registration({ purpose: B2A_PURPOSE_PIPELINE_RUNNER_READ })], B2A_SCOPE_MISMATCH, 'purpose_not_permitted',
      'W-2 (1) reconcile, registration for another consumer'],
    [[], B2A_REGISTRATION_REQUIRED, 'no_registration', 'W-2 (1) reconcile, armed but empty registry'],
    [[registration({ status: 'revoked' })], B2A_REGISTRATION_REQUIRED, 'revoked', 'W-2 (1) reconcile, revoked'],
  ]) {
    const source = createRecordingSourceAdapter()
    const records = createRecordsApi()
    const { routes, spies } = mount({
      registrations, records, source, extraServices: reconcileServices(),
    })
    const res = await routeReconcile(routes)
    assertB2aRefusal(res, code, reason, label)
    assert.equal(source.reads.length, 0, `${label}: the source adapter was asked for ZERO rows`)
    assert.deepEqual(spies.credentialLoads, [], `${label}: refused BEFORE the credential reload`)
    assert.deepEqual(spies.adapterCreations, [], `${label}: no source adapter was ever built`)
    assert.deepEqual(records.calls, [], `${label}: not even the ledger's own table was queried`)
  }

  // OUT OF SCOPE PROJECT: the same route, a registration that covers the purpose but not the data
  // scope. Proves the fence keys on the scope reconcile will actually read, not on the route.
  const scoped = mount({
    registrations: [registration()], source: createRecordingSourceAdapter(), extraServices: reconcileServices(),
  })
  const outOfScope = await routeReconcile(scoped.routes, { projectNo: OUT_OF_SCOPE_PROJECT_NO })
  assertB2aRefusal(outOfScope, B2A_SCOPE_MISMATCH, 'data_scope_mismatch', 'W-2 (1) reconcile, project out of scope')
  assert.deepEqual(scoped.spies.credentialLoads, [], 'W-2 (1) out-of-scope reconcile: no credential reload')
}

// DORMANCY for the reconcile route, and the strongest form available to it: an ARMED-AND-AUTHORIZED
// reconcile and a DORMANT one must produce the byte-identical response. The guard contributes
// nothing to this route's output — it either refuses or is invisible — so any divergence is the
// fence leaking into a payload it has no business touching.
async function W2_reconcileRouteIsUnchangedWhenDormantOrAuthorized() {
  const dormant = mount({
    source: createRecordingSourceAdapter(),
    records: createRecordsApi(),
    extraServices: reconcileServices(),
  })
  const dormantRes = await routeReconcile(dormant.routes)
  assert.deepEqual(dormant.spies.credentialLoads, [SOURCE_SYSTEM_ID],
    'a dormant reconcile loads the source exactly as it did before the fence existed')

  const armedSource = createRecordingSourceAdapter()
  const armed = mount({
    registrations: [registration()],
    source: armedSource,
    records: createRecordsApi(),
    extraServices: reconcileServices(),
  })
  const armedRes = await routeReconcile(armed.routes)
  assert.deepEqual(armed.spies.credentialLoads, [SOURCE_SYSTEM_ID],
    'an authorized reconcile loads the source too')
  assert.ok(armedSource.reads.length > 0, 'an authorized reconcile reaches the source')

  assert.equal(armedRes.statusCode, dormantRes.statusCode,
    `armed/dormant status divergence: ${JSON.stringify(armedRes.body)} vs ${JSON.stringify(dormantRes.body)}`)
  assert.deepEqual(armedRes.body, dormantRes.body,
    'the reconcile response is byte-identical whether the gate is dormant or authorizing')
  // WHERE THIS HARNESS STOPS, said plainly so the equality above is not read as more than it is: the
  // ledger's own field-id resolution, which needs a provisioning surface this suite deliberately does
  // not fake. That is AFTER the guard, AFTER the credential reload, AFTER the source expansion and
  // AFTER the audit append — every step W-2 is about — and it is the SAME stop in both modes. Pinned
  // by code so a change that made reconcile fail EARLIER (before the source read) would show up here
  // instead of quietly making the equality vacuous.
  assert.equal(dormantRes.statusCode, 503, JSON.stringify(dormantRes.body))
  assert.equal(dormantRes.body.error.code, 'TABLE_ACTION_FIELD_IDS_UNRESOLVED', JSON.stringify(dormantRes.body))
  // And the ARMED run really did go through the guard: one operation claim was spent.
  assert.equal(claimKeysIn(armed.context.storage).length, 1, 'the authorized reconcile spent exactly one claim')
  assert.equal(claimKeysIn(dormant.context.storage).length, 0, 'a dormant reconcile records no claim at all')
}

// ── (2) the cross-plugin door: the runner's own fence ────────────────────────

async function W2_inProcessRunPipelineIsFencedBeforeAnyCredentialReload() {
  for (const [registrations, code, reason, label] of [
    [[registration()], B2A_SCOPE_MISMATCH, 'purpose_not_permitted',
      'W-2 (2) runPipeline, registration for another consumer'],
    [[], B2A_REGISTRATION_REQUIRED, 'no_registration', 'W-2 (2) runPipeline, armed but empty registry'],
    [[runnerRegistration({ projectDataScope: { dataScopeRefs: [OUT_OF_SCOPE_PROJECT_NO] } })],
      B2A_SCOPE_MISMATCH, 'data_scope_mismatch', 'W-2 (2) runPipeline, pipeline project out of scope'],
    [[runnerRegistration({ objectScope: { sourceObjects: ['some_other_object'] } })],
      B2A_SCOPE_MISMATCH, 'object_out_of_scope', 'W-2 (2) runPipeline, source object out of scope'],
  ]) {
    const harness = createRunnerHarness({ registrations })
    // R-wave: a GOVERNED write (the marker the HTTP write routes attach), so what this case measures
    // is still the READ fence and not the write fence standing in front of it.
    const error = await capturedRejection(harness.runner.runPipeline(runnerWriteInput()))
    assertRunnerRefusal(error, code, reason, label)
    assert.deepEqual(harness.spies.credentialLoads, [], `${label}: refused BEFORE any credential reload`)
    assert.deepEqual(harness.spies.adapterCreations, [], `${label}: no adapter was created`)
    assert.deepEqual(harness.source.reads, [], `${label}: the source was asked for ZERO rows`)
    assert.deepEqual(harness.targetWrites, [], `${label}: ZERO target writes`)
  }

  // A NULL project id is refused rather than treated as a wildcard — pipelines.cjs stores
  // `row.project_id ?? null`, so this is the shape a project-less pipeline actually has.
  const nullScope = createRunnerHarness({
    registrations: [runnerRegistration()],
    pipelineOverrides: { projectId: null },
  })
  const nullScopeError = await capturedRejection(nullScope.runner.runPipeline(runnerWriteInput()))
  assertRunnerRefusal(nullScopeError, B2A_SCOPE_MISMATCH, 'missing_scope', 'W-2 (2) runPipeline, null project id')
  assert.equal(nullScopeError.details.dataScopeResolved, false)
  assert.deepEqual(nullScope.spies.credentialLoads, [], 'a project-less pipeline never reaches a credential')

  // Registered for this purpose and scope -> the in-process run proceeds and reads.
  const allowed = createRunnerHarness({ registrations: [runnerRegistration()] })
  const ran = await allowed.runner.runPipeline(runnerWriteInput())
  assert.equal(ran.run.status, 'succeeded', JSON.stringify(ran))
  assert.deepEqual(allowed.spies.credentialLoads, [SOURCE_SYSTEM_ID, 'target_system'],
    'the authorized run loads both systems, as it always did')
  assert.deepEqual(allowed.source.reads, [PIPELINE_SOURCE_OBJECT], 'the authorized run reaches the source')
  assert.equal(claimKeysIn(allowed.claimStore).length, 1, 'one in-process run spends exactly one operation')
}

async function W2_inProcessReplayDeadLetterIsFencedBeforeAnySourceCredentialReload() {
  const denied = createRunnerHarness({ registrations: [registration()] })
  // R-wave: governed (the replay route's own write-lifecycle context), so the READ fence is what
  // this case still measures. The MARKERLESS replay has its own case in `R3_*`.
  const error = await capturedRejection(denied.runner.replayDeadLetter(governedReplayInput()))
  assertRunnerRefusal(error, B2A_SCOPE_MISMATCH, 'purpose_not_permitted', 'W-2 (2) replayDeadLetter')
  assert.deepEqual(denied.source.reads, [], 'replay refused: ZERO source rows')
  assert.deepEqual(denied.spies.adapterCreations, [], 'replay refused: no adapter was built')
  assert.deepEqual(denied.targetWrites, [], 'replay refused: ZERO target writes')
  // THE RESIDUAL, pinned rather than described: the pre-existing K3 target-kind fence runs FIRST (so
  // a replay that will be refused for a K3 target never spends the registration), and its own lookup
  // uses the adapter-capable accessor. So the TARGET system's credentials are reloaded before the
  // read fence — and the SOURCE system's are not, which is what B2a authorizes.
  assert.deepEqual(denied.spies.credentialLoads, ['target_system'],
    'replay refused before the SOURCE credential reload; only the K3 fence\'s target lookup ran')

  const allowed = createRunnerHarness({ registrations: [runnerRegistration()] })
  const replayed = await allowed.runner.replayDeadLetter(governedReplayInput())
  // The stored payload is re-fed through the pipeline. Whether it survives transform/idempotency is
  // this fixture's business and not the fence's — what matters is that the replay RAN.
  assert.equal(replayed.replay.run.pipelineId, PIPELINE_ID, JSON.stringify(replayed))
  assert.equal(replayed.replay.metrics.rowsRead, 1, 'the authorized replay re-fed its stored row')
  assert.ok(allowed.spies.credentialLoads.includes(SOURCE_SYSTEM_ID), 'the authorized replay loads the source')
  assert.equal(claimKeysIn(allowed.claimStore).length, 1, 'one in-process replay spends exactly one operation')
}

// ── NO DOUBLE BURN ───────────────────────────────────────────────────────────
//
// The fence now stands at the route AND in the runner. One HTTP request must still spend ONE
// operation: `sourceReadOperationLimit` is 1, so a second claim would not merely be untidy, it would
// refuse the very request the route just authorized.
async function W2_theRouteAndTheRunnerShareOneOperationClaim() {
  const harness = createRunnerHarness({ registrations: [runnerRegistration()] })

  // The ROUTE half, driven exactly as `assertPipelineRunAllowed` drives it: assert, and claim.
  const routeRunId = 'pipeline-run:route-generated-1'
  const routeStanza = await assertB2aReadAuthorization({
    registry: harness.b2aTrialRegistry,
    store: harness.claimStore,
    // MERGE-TRAIN (W-3 x W-2). The route half must present migration 078's claim, and it must be the
    // SAME one the runner harness holds — `claimForStorage` keys it off the shared claim store. That
    // is what makes the runner's continue leg run through the SQL claim's same-run continuation
    // (`holderRunId === routeRunId` -> continue) rather than any kv-only path.
    operationClaim: claimForStorage(harness.claimStore),
    tenantScope: TENANT_ID,
    sourceSystemType: SYSTEM_KIND,
    sourceBindingRef: SOURCE_SYSTEM_ID,
    dataScopeRef: PIPELINE_PROJECT_ID,
    sourceObjects: [PIPELINE_SOURCE_OBJECT],
    purpose: B2A_PURPOSE_PIPELINE_RUNNER_READ,
    runId: routeRunId,
    now: Date.now(),
  })
  assert.equal(routeStanza.operationClaimed, true, 'the route takes the claim')
  assert.equal(routeStanza.pageReads, 1)

  // The RUNNER half, handed the same run under the marker: it CONTINUES that claim.
  const ran = await harness.runner.runPipeline(runnerWriteInput({ [B2A_AUTHORIZED_RUN_ID]: routeRunId }))
  assert.equal(ran.run.status, 'succeeded', JSON.stringify(ran))
  const keys = claimKeysIn(harness.claimStore)
  assert.equal(keys.length, 1, 'one HTTP-initiated run spends exactly ONE claim, not two')
  assert.equal(harness.claimStore.get(keys[0]).runId, routeRunId, 'and it is the route\'s run that holds it')
  assert.equal(harness.claimStore.get(keys[0]).pageReads, 2, 'route + runner rode the SAME operation')

  // THE DISCRIMINATING CONTROL. Without the marker the runner would take a claim of its own — and on
  // a spent registration that is a refusal, which is exactly the failure the marker prevents. So the
  // marker is load-bearing, not decorative.
  const unmarked = await capturedRejection(harness.runner.runPipeline(runnerWriteInput()))
  assertRunnerRefusal(unmarked, B2A_AUTHORIZATION_INVALID, 'operation_already_consumed',
    'W-2 a second, unmarked run on a spent registration')

  // REPLAY carries the marker the same way — it FORWARDS it into its internal `runPipeline`. Without
  // that forwarding an armed HTTP replay would be refused by the runner as a second run, so this is
  // the same load-bearing property on the second door.
  const replayHarness = createRunnerHarness({ registrations: [runnerRegistration()] })
  const replayRouteRunId = 'pipeline-dead-letter-replay:route-generated-1'
  await assertB2aReadAuthorization({
    registry: replayHarness.b2aTrialRegistry,
    store: replayHarness.claimStore,
    // MERGE-TRAIN (W-3 x W-2), replay door: same shared claim, same reason as above.
    operationClaim: claimForStorage(replayHarness.claimStore),
    tenantScope: TENANT_ID,
    sourceSystemType: SYSTEM_KIND,
    sourceBindingRef: SOURCE_SYSTEM_ID,
    dataScopeRef: PIPELINE_PROJECT_ID,
    sourceObjects: [PIPELINE_SOURCE_OBJECT],
    purpose: B2A_PURPOSE_PIPELINE_RUNNER_READ,
    runId: replayRouteRunId,
    now: Date.now(),
  })
  const replayed = await replayHarness.runner.replayDeadLetter(governedReplayInput({
    [B2A_AUTHORIZED_RUN_ID]: replayRouteRunId,
  }))
  assert.equal(replayed.replay.metrics.rowsRead, 1, 'the marked replay continued the route\'s claim and ran')
  const replayKeys = claimKeysIn(replayHarness.claimStore)
  assert.equal(replayKeys.length, 1, 'one HTTP-initiated replay spends exactly ONE claim')
  assert.equal(replayHarness.claimStore.get(replayKeys[0]).pageReads, 2, 'route + runner rode one operation')

  const unmarkedReplay = await capturedRejection(replayHarness.runner.replayDeadLetter(governedReplayInput()))
  assertRunnerRefusal(unmarkedReplay, B2A_AUTHORIZATION_INVALID, 'operation_already_consumed',
    'W-2 a second, unmarked replay on a spent registration')
}

// The route half of the same property: the HTTP layer really does hand its run id down, and hands
// down NOTHING when the gate is dormant.
async function W2_theRoutesHandTheirRunToTheRunner() {
  for (const [route, params, prefix] of [
    [PIPELINE_RUN_ROUTE, { id: PIPELINE_ID }, 'pipeline-run:'],
    [PIPELINE_DRY_RUN_ROUTE, { id: PIPELINE_ID }, 'pipeline-dry-run:'],
    [DEAD_LETTER_REPLAY_ROUTE, { id: 'dl_1' }, 'pipeline-dead-letter-replay:'],
  ]) {
    const armed = mount({ registrations: [runnerRegistration()] })
    const res = await call(armed.routes, 'POST', route, { user: WRITE_USER, params, body: {} })
    assert.ok(res.statusCode < 400, `${route} armed+authorized: ${JSON.stringify(res.body)}`)
    assert.equal(armed.spies.runnerRunMarkers.length, 1, `${route}: the runner was entered once`)
    const marker = armed.spies.runnerRunMarkers[0]
    assert.equal(typeof marker, 'string', `${route}: the route hands the runner its run id`)
    assert.ok(marker.startsWith(prefix), `${route}: unexpected run label ${marker}`)

    // DORMANT: the runner input gains no key at all — not the marker, not an undefined placeholder.
    const dormant = mount({})
    const dormantRes = await call(dormant.routes, 'POST', route, { user: WRITE_USER, params, body: {} })
    assert.ok(dormantRes.statusCode < 400, `${route} dormant: ${JSON.stringify(dormantRes.body)}`)
    assert.deepEqual(dormant.spies.runnerRunMarkers, [undefined], `${route}: dormant attaches no marker`)
  }
}

// ── DORMANCY at the runner layer ─────────────────────────────────────────────
async function W2_theRunnerIsDormantWhenTheRegistryIsUnset() {
  const dormant = createRunnerHarness()
  const dormantRan = await dormant.runner.runPipeline(runnerInput())
  assert.equal(dormantRan.run.status, 'succeeded')
  // NOT ONE EXTRA PLATFORM READ. The fence's own two reads (the pipeline row and the
  // credential-stripped source system) never happen, so a dormant runner makes exactly the calls it
  // made before this fence existed.
  assert.deepEqual(dormant.spies.pipelineLoads, [PIPELINE_ID], 'dormant: ONE pipeline read, the runner\'s own')
  assert.deepEqual(dormant.spies.publicSystemLoads, [], 'dormant: the stripped accessor is never called')
  assert.equal(claimKeysIn(dormant.claimStore).length, 0, 'dormant: no claim, no durable trace at all')
  assert.deepEqual([...dormant.claimStore.keys()], [], 'dormant: the claim store is untouched')

  const armed = createRunnerHarness({ registrations: [runnerRegistration()] })
  const armedRan = await armed.runner.runPipeline(runnerWriteInput())
  // ... and an ARMED, AUTHORIZED run produces the same RESULT. The fence adds reads, never output.
  assert.equal(armedRan.run.status, dormantRan.run.status)
  assert.deepEqual(
    { ...armedRan.metrics, durationMs: 0 },
    { ...dormantRan.metrics, durationMs: 0 },
    'an authorized run computes exactly what a dormant one computes',
  )
  assert.deepEqual(armedRan.preview, dormantRan.preview)
  assert.deepEqual(armed.spies.pipelineLoads, [PIPELINE_ID, PIPELINE_ID], 'armed: the fence costs one extra pipeline read')
  assert.deepEqual(armed.spies.publicSystemLoads, [SOURCE_SYSTEM_ID], 'armed: and one credential-STRIPPED system read')
  assert.deepEqual(armed.spies.credentialLoads, dormant.spies.credentialLoads,
    'the fence adds no credential reload of its own')
  // R-wave (finding 3): the object-scope resolver's own read — armed only, and credential-free. A
  // DORMANT deployment must not make it at all, which is the half that keeps dormancy exact.
  assert.deepEqual(dormant.spies.configLoads, [], 'dormant: the adapter-config accessor is never called')
  assert.deepEqual(armed.spies.configLoads, [SOURCE_SYSTEM_ID],
    'armed: exactly one credential-free config read, for the source binding only')
}

// ── THE CROSS-PLUGIN DOOR, THROUGH THE REAL index.cjs ────────────────────────
//
// Everything above proves the runner holds the fence. This proves index.cjs actually GIVES it the
// registry and the claim store — without which the communication API is as open as it was.
function activationContext(registrations) {
  const pipelineRow = {
    id: PIPELINE_ID,
    tenant_id: TENANT_ID,
    workspace_id: null,
    project_id: PIPELINE_PROJECT_ID,
    name: 'pipeline',
    source_system_id: SOURCE_SYSTEM_ID,
    source_object: PIPELINE_SOURCE_OBJECT,
    target_system_id: 'target_system',
    target_object: 'imported_items',
    mode: 'manual',
    status: 'active',
    options: {},
    idempotency_key_fields: [],
    created_by: 'owner@example.invalid',
  }
  const systemRow = {
    id: SOURCE_SYSTEM_ID,
    tenant_id: TENANT_ID,
    workspace_id: null,
    name: 'source',
    kind: SYSTEM_KIND,
    role: 'source',
    status: 'active',
    config: {},
    capabilities: {},
    credentials_encrypted: null,
  }
  const deadLetterRow = {
    id: 'dl_1',
    tenant_id: TENANT_ID,
    workspace_id: null,
    run_id: 'run_0',
    pipeline_id: PIPELINE_ID,
    idempotency_key: 'idem_1',
    source_payload: { code: 'ROW-1' },
    transformed_payload: null,
    error_code: 'VALIDATION_FAILED',
    error_message: 'synthetic',
    retry_count: 0,
    status: 'open',
    last_replay_run_id: null,
    created_at: '2026-05-07T00:00:00.000Z',
    updated_at: '2026-05-07T00:00:00.000Z',
  }
  const namespaces = new Map()
  // MERGE-TRAIN (W-3 x W-2). Migration 078 moved the AUTHORITY for "who holds this operation" out of
  // the kv store and into `integration_b2a_operation_claim`. This activation drives the REAL
  // index.cjs, so its claim goes through the real `createDb` helper and lands here — and the
  // precondition this case needs ("another run already holds the operation") therefore has to be a
  // ROW, not a kv record. The fake below models exactly the two statements the claim issues, with
  // the PRIMARY KEY on claim_key enforced the way Postgres enforces it.
  const claimRows = new Map()
  function claimKeyParam(sql, params) {
    // `insertOne` emits INSERT INTO … ("claim_key", …) VALUES ($1, …); `selectOne` emits
    // SELECT * FROM … WHERE "claim_key" = $1 …. Either way the column order is the parameter order.
    const cols = String(sql).match(/"([a-z_]+)"/g) || []
    const idx = cols.indexOf('"claim_key"')
    // The first quoted identifier is the table name, so column positions are offset by one.
    return idx > 0 ? params[idx - 1] : params[0]
  }
  const context = {
    api: {
      http: { addRoute() {} },
      database: {
        async query(sql, params = []) {
          const text = String(sql)
          if (text.includes('"integration_b2a_operation_claim"')) {
            const key = claimKeyParam(text, params)
            if (text.startsWith('INSERT')) {
              if (claimRows.has(key)) {
                const error = new Error('duplicate key value violates unique constraint')
                error.code = '23505'
                throw error
              }
              const cols = (text.match(/\(([^)]*)\)\s+VALUES/) || [, ''])[1]
                .split(',').map((c) => c.trim().replace(/"/g, ''))
              const row = {}
              cols.forEach((c, i) => { row[c] = params[i] })
              claimRows.set(key, row)
              return [{ ...row }]
            }
            const row = claimRows.get(key)
            return row ? [{ ...row }] : []
          }
          if (text.includes('"integration_pipelines"')) return [pipelineRow]
          if (text.includes('"integration_external_systems"')) return [systemRow]
          if (text.includes('"integration_dead_letters"')) return [deadLetterRow]
          return []
        },
      },
    },
    communication: { register(namespace, api) { namespaces.set(namespace, api) }, call() {}, on() {}, emit() {} },
    logger: { info() {}, warn() {}, error() {} },
    services: {
      security: {
        async encrypt(value) { return `enc:${Buffer.from(value, 'utf8').toString('base64')}` },
        async decrypt(value) { return Buffer.from(value.slice(4), 'base64').toString('utf8') },
        async hash(value) { return `hash:${value}` },
      },
    },
    storage: Object.assign(new Map(), { durable: true }),
    config: { [B2A_REGISTRY_CONFIG_KEY]: registry(registrations) },
  }
  // The claim seen through the same substrate index.cjs will use, so a claim taken by the "other
  // request" below is the very row the activated runner reads back.
  const operationClaim = createB2aOperationClaim({
    db: {
      async insertOne(table, row) {
        const cols = Object.keys(row)
        const sql = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`
        return context.api.database.query(sql, cols.map((c) => row[c]))
      },
      async selectOne(table, where) {
        const keys = Object.keys(where)
        const sql = `SELECT * FROM "${table}" WHERE ${keys.map((k, i) => `"${k}" = $${i + 1}`).join(' AND ')} LIMIT 1`
        const rows = await context.api.database.query(sql, keys.map((k) => where[k]))
        return rows[0] || null
      },
    },
  })
  return { context, namespaces, operationClaim }
}

async function W2_activationWiresTheFenceIntoTheCrossPluginApi() {
  const entry = require(path.join(__dirname, '..', 'index.cjs'))
  const previousFlag = process.env[STOCK_PREPARATION_FEATURE_FLAG]
  process.env[STOCK_PREPARATION_FEATURE_FLAG] = 'false'

  try {
    // ARMED, and EMPTY: a deployment that has switched the gate on with no exception approved yet.
    // If index.cjs did not hand the runner the registry, this call would sail past into
    // `loadPipelineContext` and run.
    const empty = activationContext([])
    await entry.activate(empty.context)
    const emptyApi = empty.namespaces.get('integration-core')
    assert.ok(emptyApi, 'the cross-plugin namespace is registered')

    // A cross-plugin DRY RUN still reads the source, so the B2a read fence is what refuses it. It is
    // spelled `dryRun: true` here since R-wave: a cross-plugin WRITE no longer reaches the read fence
    // at all (the C6 write fence stands in front of it — see the write cases immediately below), and
    // a case that could not tell those two refusals apart would stop testing this one.
    const runRefusal = await capturedRejection(emptyApi.runPipeline({
      tenantId: TENANT_ID, workspaceId: null, pipelineId: PIPELINE_ID, mode: 'full', triggeredBy: 'plugin', dryRun: true,
    }))
    assertRunnerRefusal(runRefusal, B2A_REGISTRATION_REQUIRED, 'no_registration',
      'W-2 cross-plugin runPipeline (dry) on an armed deployment')

    // R-wave (finding 4), THE CROSS-PLUGIN WRITE DOOR, through the real index.cjs. A live write and
    // a replay are refused for want of the C6 write-lifecycle context that only the governed HTTP
    // routes attach — before the read fence, so neither spends the registration's one operation.
    const writeRefusal = await capturedRejection(emptyApi.runPipeline({
      tenantId: TENANT_ID, workspaceId: null, pipelineId: PIPELINE_ID, mode: 'full', triggeredBy: 'plugin',
    }))
    assertRunnerRefusal(writeRefusal, C6_SAFE_LIFECYCLE_REQUIRED, 'runner_write_outside_c6_lifecycle',
      'R-wave cross-plugin runPipeline WRITE on an armed deployment')

    const replayRefusal = await capturedRejection(emptyApi.replayDeadLetter({
      tenantId: TENANT_ID, workspaceId: null, id: 'dl_1',
    }))
    // A replay is ALWAYS a live write (it re-enters `runPipeline` with no `dryRun`), so this door has
    // no dry variant at all: cross-plugin replay is refused outright on an armed deployment.
    assertRunnerRefusal(replayRefusal, C6_SAFE_LIFECYCLE_REQUIRED, 'runner_write_outside_c6_lifecycle',
      'R-wave cross-plugin replayDeadLetter on an armed deployment')

    // AND THE MARKER CANNOT BE FORGED OVER THE CROSS-PLUGIN CALL. Presenting it explicitly changes
    // nothing: `index.cjs` strips it, so the refusal is byte-identical to the one above.
    const forgedWrite = await capturedRejection(emptyApi.runPipeline({
      tenantId: TENANT_ID,
      workspaceId: null,
      pipelineId: PIPELINE_ID,
      mode: 'full',
      triggeredBy: 'plugin',
      [C6_WRITE_LIFECYCLE_CONTEXT]: true,
    }))
    assertRunnerRefusal(forgedWrite, C6_SAFE_LIFECYCLE_REQUIRED, 'runner_write_outside_c6_lifecycle',
      'R-wave cross-plugin runPipeline presenting a forged write-lifecycle context')
    const forgedReplayContext = await capturedRejection(emptyApi.replayDeadLetter({
      tenantId: TENANT_ID, workspaceId: null, id: 'dl_1', [C6_WRITE_LIFECYCLE_CONTEXT]: true,
    }))
    assertRunnerRefusal(forgedReplayContext, C6_SAFE_LIFECYCLE_REQUIRED, 'runner_write_outside_c6_lifecycle',
      'R-wave cross-plugin replayDeadLetter presenting a forged write-lifecycle context')
    await entry.deactivate()

    // A CALLER MAY NOT PRESENT SOMEBODY ELSE'S RUN. The registration below is real and its single
    // operation has already been claimed by another run — the shape of an HTTP request in flight. A
    // cross-plugin caller that presents that run id must NOT ride the claim.
    //
    // DISCRIMINATING BY CONSTRUCTION: with the marker honoured the runner would CONTINUE the claim
    // and the read would proceed; stripped, it takes its own and is refused as a second run. The two
    // outcomes are different codes, so this cannot pass for the wrong reason.
    const armed = activationContext([runnerRegistration()])
    const otherRunId = 'pipeline-run:belongs-to-another-request'
    await assertB2aReadAuthorization({
      registry: createB2aRegistry({ config: armed.context.config }),
      store: armed.context.storage,
      // MERGE-TRAIN (W-3 x W-2). Post-078 the operation is held by a ROW, so the "another request
      // already holds it" precondition has to be taken against the same database the activated
      // runner will read — otherwise the runner would find no row, claim freely, and the case would
      // pass for the wrong reason.
      operationClaim: armed.operationClaim,
      tenantScope: TENANT_ID,
      sourceSystemType: SYSTEM_KIND,
      sourceBindingRef: SOURCE_SYSTEM_ID,
      dataScopeRef: PIPELINE_PROJECT_ID,
      sourceObjects: [PIPELINE_SOURCE_OBJECT],
      purpose: B2A_PURPOSE_PIPELINE_RUNNER_READ,
      runId: otherRunId,
      now: Date.now(),
    })
    await entry.activate(armed.context)
    const armedApi = armed.namespaces.get('integration-core')
    const forged = await capturedRejection(armedApi.runPipeline({
      tenantId: TENANT_ID,
      workspaceId: null,
      pipelineId: PIPELINE_ID,
      mode: 'full',
      triggeredBy: 'plugin',
      // Dry, so the C6 write fence is not what refuses this — the run-marker strip is, which is the
      // property this case exists for.
      dryRun: true,
      [B2A_AUTHORIZED_RUN_ID]: otherRunId,
    }))
    assertRunnerRefusal(forged, B2A_AUTHORIZATION_INVALID, 'operation_already_consumed',
      'W-2 cross-plugin runPipeline presenting another request\'s run marker')
    // The replay door has no dry variant, so BOTH markers must be presented for the run-marker strip
    // to be the thing under test — and both are stripped, so the refusal is the write fence's.
    const forgedReplay = await capturedRejection(armedApi.replayDeadLetter({
      tenantId: TENANT_ID,
      workspaceId: null,
      id: 'dl_1',
      [B2A_AUTHORIZED_RUN_ID]: otherRunId,
      [C6_WRITE_LIFECYCLE_CONTEXT]: true,
    }))
    assertRunnerRefusal(forgedReplay, C6_SAFE_LIFECYCLE_REQUIRED, 'runner_write_outside_c6_lifecycle',
      'R-wave cross-plugin replayDeadLetter cannot forge either marker')
  } finally {
    await entry.deactivate()
    if (previousFlag === undefined) delete process.env[STOCK_PREPARATION_FEATURE_FLAG]
    else process.env[STOCK_PREPARATION_FEATURE_FLAG] = previousFlag
  }
}

// ═══ R-WAVE: THE THREE RUNNER-SEAM CLOSURES ══════════════════════════════════
//
// External post-merge review, findings 2, 3 and 4. Each one was a hole between two things that were
// individually correct — an armed floor nobody armed, an object scope that described the plan rather
// than the read, and a write lifecycle that lived only at HTTP.

const LOOKUP_OBJECT = 'legacy_materials'

// A `data-source:sql-readonly` system config carrying the optional, server-bound lookup projection.
// Shape from that adapter's own `normalizeLookupProjection`: a SECOND, distinct table read on every
// page to enrich the base rows. It lives in the PRIVATE config subtree, which the public accessor
// strips — hence the guard's separate, non-decrypting one.
function lookupProjectionConfig(lookupObject = LOOKUP_OBJECT, baseObject = PIPELINE_SOURCE_OBJECT) {
  return {
    lookupProjection: {
      baseObject,
      lookupObject,
      localKey: 'material_id',
      foreignKey: 'id',
      fields: { FNumber: 'code', FName: 'name' },
      maxRows: 3,
    },
  }
}

// ── (finding 2) THE RUNNER THREADS THE AUTHORIZATION STANZA ──────────────────
//
// W-5 armed two SQL-Server read floors inside `data-source:sql-readonly` and made them OPT-IN on the
// authorization stanza the caller forwards. The runner captured that stanza and dropped it, so every
// runner-initiated armed read ran with both floors off. Two independent witnesses below: the `deps`
// object the adapter is built with, and the REAL adapter's floor actually firing.
async function R1_theRunnerThreadsTheB2aStanzaIntoTheSourceAdapter() {
  const sourceDeps = (harness) => harness.spies.adapterDeps.find((entry) => entry.options.role === 'source').options
  const targetDeps = (harness) => harness.spies.adapterDeps.find((entry) => entry.options.role === 'target').options

  const armed = createRunnerHarness({ registrations: [runnerRegistration()] })
  await armed.runner.runPipeline(runnerWriteInput())
  const armedSource = sourceDeps(armed)
  assert.equal(armedSource.b2aAuthorization.armed, true, 'the source adapter is handed the stanza')
  assert.equal(armedSource.b2aAuthorization.purpose, B2A_PURPOSE_PIPELINE_RUNNER_READ,
    'and it is THIS run\'s stanza, for this entry point')
  assert.equal(armedSource.b2aAuthorization.registrationId, runnerRegistration().registrationId,
    'the stanza names the registration that authorized THIS read')
  assert.equal(armedSource.principal, 'owner@example.invalid', 'the C2a principal is untouched by the addition')
  // SOURCE ONLY. A read authorization is not a write authorization, and handing it to the target
  // adapter would imply it was.
  assert.equal('b2aAuthorization' in targetDeps(armed), false, 'the TARGET adapter is handed no read stanza')

  // DORMANT: the key is ABSENT — not `undefined`, absent — so every factory sees the deps object it
  // saw before this dep existed.
  const dormant = createRunnerHarness()
  await dormant.runner.runPipeline(runnerInput())
  assert.equal('b2aAuthorization' in sourceDeps(dormant), false, 'dormant: no key at all on the source deps')
  assert.deepEqual(Object.keys(sourceDeps(dormant)).sort(), ['principal', 'role'],
    'dormant: byte-identical deps to the pre-change runner')

  // THE FLOOR ITSELF, on the runner path, through the REAL adapter and its REAL facade contract.
  // `select`'s 5th argument is the armed flag, and floor 1 maps the facade's generic pre-connect
  // refusal to the fixed B2a code — but ONLY when the stanza reached the adapter.
  function armedAwareSource(thrown, facadeError) {
    const armedFlags = []
    const factory = createDataSourceSqlReadonlySourceAdapterFactory({
      context: {
        api: {
          dataSources: {
            async test() { return { success: true } },
            async getSchema() { return { tables: [], views: [] } },
            async getTableInfo() { return { columns: [] } },
            async select(id, table, options, principal, armedFlag) {
              armedFlags.push(armedFlag)
              if (facadeError) throw facadeError
              return { data: [], metadata: {} }
            },
          },
        },
      },
    })
    return {
      armedFlags,
      factory(deps) {
        const adapter = factory(deps)
        return {
          ...adapter,
          async read(input) {
            try {
              return await adapter.read(input)
            } catch (error) {
              thrown.push(error)
              throw error
            }
          },
        }
      },
    }
  }

  const timeoutDisabled = () => Object.assign(
    new Error('data source has connection.requestTimeoutMs=0 (no timeout)'),
    { code: 'DATA_SOURCE_REQUEST_TIMEOUT_DISABLED', status: 422 },
  )

  const armedThrown = []
  const armedReal = armedAwareSource(armedThrown, timeoutDisabled())
  const armedFloor = createRunnerHarness({
    registrations: [runnerRegistration()],
    sourceAdapterFactory: armedReal.factory,
  })
  await capturedRejection(armedFloor.runner.runPipeline(runnerWriteInput()))
  assert.deepEqual(armedReal.armedFlags, [true], 'the armed flag reached the facade on the RUNNER path')
  assert.equal(armedThrown[0].code, B2A_SOURCE_TIMEOUT_DISABLED_REJECTED,
    `the armed floor fired on the runner path (saw ${armedThrown[0] && armedThrown[0].code})`)

  // THE DISCRIMINATING CONTROL: the same adapter, the same facade error, a DORMANT deployment. The
  // floor is a strict no-op and the generic error propagates verbatim — which is exactly what an
  // armed runner used to do before this change, and why the gap was invisible.
  const dormantThrown = []
  const dormantReal = armedAwareSource(dormantThrown, timeoutDisabled())
  const dormantFloor = createRunnerHarness({ sourceAdapterFactory: dormantReal.factory })
  await capturedRejection(dormantFloor.runner.runPipeline(runnerInput()))
  assert.deepEqual(dormantReal.armedFlags, [false], 'dormant reads pass armed=false, never undefined')
  assert.equal(dormantThrown[0].code, 'DATA_SOURCE_REQUEST_TIMEOUT_DISABLED',
    'dormant: the facade error propagates unmapped, byte-identical to before')
}

// ── (finding 3) THE CONFIG-BOUND SECOND OBJECT IS IN SCOPE OR IT IS REFUSED ──
async function R2_theLookupProjectionObjectIsPartOfTheObjectScope() {
  // A registration naming ONLY the pipeline's own source object, against a source whose config adds
  // a second table. Before this change the read was authorized and touched both.
  const denied = createRunnerHarness({
    registrations: [runnerRegistration()],
    sourceSystemConfig: lookupProjectionConfig(),
  })
  const error = await capturedRejection(denied.runner.runPipeline(runnerWriteInput()))
  assertRunnerRefusal(error, B2A_SCOPE_MISMATCH, 'object_out_of_scope',
    'R-wave (3) a registration that does not enumerate the lookup object')
  assert.equal(error.details.unauthorizedObjectCount, 1, 'exactly one object was outside the scope')
  assert.equal(JSON.stringify(error.details).includes(LOOKUP_OBJECT), false,
    'values-free: the refusal counts the unauthorized objects, it never names them')
  assert.deepEqual(denied.spies.credentialLoads, [], 'refused BEFORE any credential reload')
  assert.deepEqual(denied.source.reads, [], 'and before a single row was read')
  assert.equal(claimKeysIn(denied.claimStore).length, 0, 'a scope refusal spends no operation')
  // The config read that made the refusal possible is credential-free and armed-only.
  assert.deepEqual(denied.spies.configLoads, [SOURCE_SYSTEM_ID])

  // ENUMERATED -> the read proceeds. Without this leg the case above would pass for a registry that
  // refused everything.
  const allowed = createRunnerHarness({
    registrations: [runnerRegistration({ objectScope: { sourceObjects: [PIPELINE_SOURCE_OBJECT, LOOKUP_OBJECT] } })],
    sourceSystemConfig: lookupProjectionConfig(),
  })
  const ran = await allowed.runner.runPipeline(runnerWriteInput())
  assert.equal(ran.run.status, 'succeeded', JSON.stringify(ran))
  assert.deepEqual(allowed.source.reads, [PIPELINE_SOURCE_OBJECT], 'the authorized run reads its source')

  // DORMANT with the very same config: unchanged, and not one extra platform read.
  const dormant = createRunnerHarness({ sourceSystemConfig: lookupProjectionConfig() })
  const dormantRan = await dormant.runner.runPipeline(runnerInput())
  assert.equal(dormantRan.run.status, 'succeeded')
  assert.deepEqual(dormant.spies.configLoads, [], 'dormant: the config accessor is never called')

  // FAIL-CLOSED: armed, a kind that can hide an object, and no way to resolve its config.
  const unresolvable = createRunnerHarness({
    registrations: [runnerRegistration()],
    omitAdapterConfigAccessor: true,
  })
  const unresolvableError = await capturedRejection(unresolvable.runner.runPipeline(runnerWriteInput()))
  assertRunnerRefusal(unresolvableError, B2A_SCOPE_MISMATCH, 'config_bound_object_unresolvable',
    'R-wave (3) armed, and the private config cannot be resolved')
  assert.deepEqual(unresolvable.spies.credentialLoads, [], 'the fail-closed leg reloads no credential either')

  // THE ROUTE HALF. The same widening on the stock-preparation entry point, through the real routes:
  // the read plan's objects PLUS the source system's configured lookup object, matched against a
  // registration written for the plan alone.
  const routeSource = createRecordingSourceAdapter()
  const { routes, spies } = mount({
    registrations: [registration()],
    source: routeSource,
    sourceSystemConfig: lookupProjectionConfig(LOOKUP_OBJECT, 'DN_PDM_PathExAttrInfo'),
  })
  const res = await routeDryRun(routes)
  assertB2aRefusal(res, B2A_SCOPE_MISMATCH, 'object_out_of_scope',
    'R-wave (3) the stock-preparation route, lookup object out of scope')
  assert.equal(JSON.stringify(res.body).includes(LOOKUP_OBJECT), false, 'the route refusal names no object either')
  assert.equal(routeSource.reads.length, 0, 'the route refused before the source adapter read anything')
  assert.deepEqual(spies.credentialLoads, [], 'and before the credential reload')
}

// ── (finding 4) A LIVE WRITE NEEDS THE C6 WRITE-LIFECYCLE CONTEXT ────────────
async function R3_aLiveRunnerWriteNeedsTheC6WriteLifecycleContext() {
  // MARKERLESS + ARMED + LIVE -> refused, and refused BEFORE anything at all happens. The strongest
  // form of "it costs nothing": not one platform read, and the registration is NOT spent.
  const denied = createRunnerHarness({ registrations: [runnerRegistration()] })
  const error = await capturedRejection(denied.runner.runPipeline(runnerInput()))
  assertRunnerRefusal(error, C6_SAFE_LIFECYCLE_REQUIRED, 'runner_write_outside_c6_lifecycle',
    'R-wave (4) an in-process live write with no lifecycle context')
  assert.equal(error.details.dryRun, false)
  assert.deepEqual(denied.spies.pipelineLoads, [], 'refused before even the pipeline row is read')
  assert.deepEqual(denied.spies.publicSystemLoads, [], 'and before any system metadata read')
  assert.deepEqual(denied.spies.credentialLoads, [], 'and before any credential reload')
  assert.deepEqual(denied.source.reads, [], 'ZERO source rows')
  assert.deepEqual(denied.targetWrites, [], 'ZERO target writes')
  assert.equal(claimKeysIn(denied.claimStore).length, 0,
    'a write refused for want of the lifecycle context does NOT burn the registration')

  // THE ANTI-BLANKET-DENY LEG (E4-05). The SAME harness and the SAME registration, now carrying the
  // context the governed HTTP write routes attach: the write proceeds and actually writes. A fence
  // that refused this would not be a fence, it would be an outage.
  const ran = await denied.runner.runPipeline(runnerWriteInput({ sourceRecords: [{ id: 'ROW-1' }] }))
  assert.equal(ran.run.status, 'succeeded', JSON.stringify(ran))
  assert.deepEqual(denied.targetWrites, ['imported_items'], 'the governed write really wrote')
  assert.equal(claimKeysIn(denied.claimStore).length, 1, 'and it spent exactly one operation')

  // DRY RUNS ARE UNTOUCHED — armed, markerless, and they still read. Both spellings of the flag, so
  // the fence uses the same coercion the write leg does rather than a stricter one that would refuse
  // a legitimate preview.
  for (const dryRun of [true, 'true']) {
    const dry = createRunnerHarness({ registrations: [runnerRegistration()] })
    const dryRan = await dry.runner.runPipeline(runnerInput({ dryRun }))
    assert.equal(dryRan.run.status, 'succeeded', `dryRun: ${JSON.stringify(dryRun)} -> ${JSON.stringify(dryRan)}`)
    assert.ok(dry.source.reads.length > 0, 'an armed markerless dry run still READS')
    assert.deepEqual(dry.targetWrites, [], 'and writes nothing, which is why it needs no write context')
  }

  // DORMANT: a markerless live write is exactly what it always was.
  const dormant = createRunnerHarness()
  const dormantRan = await dormant.runner.runPipeline(runnerInput({ sourceRecords: [{ id: 'ROW-1' }] }))
  assert.equal(dormantRan.run.status, 'succeeded')
  assert.deepEqual(dormant.targetWrites, ['imported_items'], 'dormant: the write happens as before')

  // REPLAY is always a live write. Markerless and armed it is refused AHEAD of the K3 fence's own
  // target lookup — which is the credential-DECRYPTING accessor, so this ordering is worth a number:
  // the authorized replay case above records `['target_system']` there, and this one records nothing.
  const replayDenied = createRunnerHarness({ registrations: [runnerRegistration()] })
  const replayError = await capturedRejection(replayDenied.runner.replayDeadLetter(replayInput()))
  assertRunnerRefusal(replayError, C6_SAFE_LIFECYCLE_REQUIRED, 'runner_write_outside_c6_lifecycle',
    'R-wave (4) an in-process replay with no lifecycle context')
  assert.deepEqual(replayDenied.spies.credentialLoads, [],
    'the replay refusal lands ahead of even the K3 fence\'s target credential reload')
  assert.equal(claimKeysIn(replayDenied.claimStore).length, 0, 'and spends no operation')

  // GOVERNED replay proceeds, and forwards the context into its internal `runPipeline` — without
  // that forwarding this call would pass the top-level check and then fail one layer down.
  const replayAllowed = createRunnerHarness({ registrations: [runnerRegistration()] })
  const replayed = await replayAllowed.runner.replayDeadLetter(governedReplayInput())
  assert.equal(replayed.replay.metrics.rowsRead, 1, 'the governed replay ran')
}

// The ROUTE half of finding 4: the marker is attached by the two governed WRITE routes, by neither
// the dry-run route nor a dormant deployment.
async function R3_theGovernedWriteRoutesAttachTheLifecycleContext() {
  for (const [route, params, label] of [
    [PIPELINE_RUN_ROUTE, { id: PIPELINE_ID }, 'pipelines/:id/run'],
    [DEAD_LETTER_REPLAY_ROUTE, { id: 'dl_1' }, 'dead-letters/:id/replay'],
  ]) {
    const armed = mount({ registrations: [runnerRegistration()] })
    const res = await call(armed.routes, 'POST', route, { user: WRITE_USER, params, body: {} })
    assert.ok(res.statusCode < 400, `${label} armed+authorized: ${JSON.stringify(res.body)}`)
    assert.deepEqual(armed.spies.runnerWriteContexts, [true],
      `${label}: the governed write route attaches the lifecycle context`)

    const dormant = mount({})
    const dormantRes = await call(dormant.routes, 'POST', route, { user: WRITE_USER, params, body: {} })
    assert.ok(dormantRes.statusCode < 400, `${label} dormant: ${JSON.stringify(dormantRes.body)}`)
    assert.deepEqual(dormant.spies.runnerWriteContexts, [undefined],
      `${label}: dormant attaches no key at all`)
  }

  // The DRY-RUN route attaches nothing, armed or not: it is not a write, and a marker there would be
  // an assertion nobody checked.
  const dry = mount({ registrations: [runnerRegistration()] })
  const dryRes = await call(dry.routes, 'POST', PIPELINE_DRY_RUN_ROUTE, {
    user: WRITE_USER, params: { id: PIPELINE_ID }, body: {},
  })
  assert.ok(dryRes.statusCode < 400, JSON.stringify(dryRes.body))
  assert.deepEqual(dry.spies.runnerWriteContexts, [undefined], 'the dry-run route attaches no write context')
}

const TESTS = [
  unsetEnvIsDormantAndByteIdentical,
  unsetEnvLeavesTheOtherEntryPointsUntouched,
  armedWithAMatchingRegistrationPasses,
  M78_armedWithoutTheDbEnforcedClaimRefusesFailClosed,
  M78_dormantNeedsNoClaimAtAll,
  M78_theAuthorityIsTheSqlRowAndTheKvRecordIsAProjection,
  R01_lifecycleRefusalsThroughTheRoute,
  R02_scopeRefusalsThroughTheRoute,
  R07_entry1_largeBomExpansion,
  R07_entry2_c6ExternalWriteDryRun,
  R07_entry3_ordinaryPipelineRunner,
  R07_entry4_sealedSnapshotSession,
  E3_01_ordinaryMultitableWriteIsRefused,
  aMalformedRegistryFailsAtRegistrationNotOnTheFirstRead,
  aRequestCannotSupplyOrDisarmTheRegistry,
  R05_armedSourceTimeoutSurfacesTheFixedCode,
  R05_armedRowAndPageCapSurfaceTheFixedLimitCode,
  R06_firstArmedReadPinsTheContractAndAnIdenticalSchemaPasses,
  R06_schemaDriftRefusesBeforeAnyBusinessArtifact,
  E3_02_brokenCursorRefusesAndNoPlanIsProduced,
  E3_02_aTruncatedBackgroundExpansionNeverBecomesAPlan,
  E3_03_noWatermarkIsReadOrAdvancedOnTheDedicatedPath,
  E3_04_aMultiPageBatchProducesExactlyOnePlanAndOneToken,
  E3_05_aMidReadSourceChangeRefuses,
  // W-2: the choke point sunk below HTTP.
  W2_reconcileRouteIsFencedBeforeAnyCredentialReload,
  W2_reconcileRouteIsUnchangedWhenDormantOrAuthorized,
  W2_inProcessRunPipelineIsFencedBeforeAnyCredentialReload,
  W2_inProcessReplayDeadLetterIsFencedBeforeAnySourceCredentialReload,
  W2_theRouteAndTheRunnerShareOneOperationClaim,
  W2_theRoutesHandTheirRunToTheRunner,
  W2_theRunnerIsDormantWhenTheRegistryIsUnset,
  W2_activationWiresTheFenceIntoTheCrossPluginApi,
  // R-wave: the three runner-seam closures from the external post-merge review.
  R1_theRunnerThreadsTheB2aStanzaIntoTheSourceAdapter,
  R2_theLookupProjectionObjectIsPartOfTheObjectScope,
  R3_aLiveRunnerWriteNeedsTheC6WriteLifecycleContext,
  R3_theGovernedWriteRoutesAttachTheLifecycleContext,
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
