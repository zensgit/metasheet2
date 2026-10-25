'use strict'

const freshProjectWriteLock = () => require('./support/stock-preparation-project-write-lock-kit.cjs').createInMemoryProjectWriteLock({ timers: 'real' }).lock

const { consumableMap } = require('./support/consumable-storage.cjs')

// #6475 — WHY 批次存档 (mvp-persist) DOES NOT REUSE THE DRY-RUN'S RESOLVED DUPLICATE GROUPS.
// THROUGH THE REAL ROUTE TABLE, PLUS THE ONE LIB-LEVEL FACT THAT MAKES IT LOAD-BEARING.
//
// `prepareStockPreparationMvpSnapshot` plans with no table-scope policies and no confirmation-ledger
// readback, while the dry-run and apply routes pass both. That looks like a parity bug, and #6475's
// first diagnosis ranked it as the likely cause of a red step ④. It is not a bug to "fix" by
// threading the two inputs in, and this suite exists so that a future attempt to do exactly that goes
// red with the reason in front of it:
//
//   * The ONLY hold a stored policy or a confirmed decision can resolve is a duplicate_expanded_key
//     group, resolved by `keep_multiple_rows` (DUPLICATE_EXPANDED_KEY_RESOLVING_POLICY in the
//     planner; READBACK_POLICY_BY_RESOLUTION_ACTION in the ledger). Every other resolution action
//     maps to a hold.
//   * The rows of such a group share their idempotency key, and the key is built from the BOM path
//     (`makeIdempotencyKey(projectNo, component, parent, pathTokens)`), so they share their `path`.
//   * The snapshot mapper keys a line by that path (`snapshotLineIdFor(batch, pathKey)`), so the two
//     rows become ONE snapshot line id, and the persist refuses the batch 422
//     PERSIST_PLAN_LINE_KEY_AMBIGUOUS.
//
// So the archive's plan-validity gate (`!dryRun.plan.valid` → 409
// STOCK_PREPARATION_MVP_SOURCE_EXPANSION_NOT_READY) is what keeps a project the snapshot cannot hold
// on a typed "not ready" answer. Threading the policies/resolver in only trades that 409 for the 422,
// and the archive still stores nothing. Storing a resolved group needs a snapshot line identity that
// carries the discriminator — a snapshot-schema decision, not a plan-input one.
//
// (The project-sync panel never reaches this state anyway: its apply sends no
// `acceptDuplicateResolution`, so a resolved group stops at step ③ with 409
// TABLE_ACTION_DUPLICATE_RESOLUTION_REVIEW_REQUIRED. The workbench's acknowledged apply is the path
// these cases drive.)
//
// CASES
//   D1 the structural fact, lib-level: the two expanded rows of the group carry the same idempotency
//      key and path, and the snapshot mapper gives them the same snapshot line id.
//   D2 TABLE-SCOPE POLICY: dry-run held → PUT keep_multiple_rows → dry-run ready → acknowledged apply
//      writes 2 rows → mvp-persist answers 409 NOT_READY (never 422) and NO snapshot row is written.
//   D3 CONFIRMED LEDGER DECISION, REPEAT PULL: reconcile → confirm → dry-run ready → apply writes →
//      reconcile → confirm again (the write moved the revision the ledger binds to) → dry-run ready →
//      apply writes nothing → mvp-persist answers 409 NOT_READY and NO snapshot row is written.
//
// MUTATIONS this suite is calibrated against (in-memory, never on disk):
//   MG1 drop `|| !dryRun.plan.valid` from the archive's readiness gate        => D2 and D3 red (422)
//   MG2 thread the stored table-scope policies into the archive's plan         => D2 red (422)
//   MG3 thread the confirmation-ledger resolver into the archive's plan        => D3 red (422)
//   MG4 key the snapshot line by the idempotency key + sort line instead       => D1 red
//
// THE HARNESS IS THE PRODUCTION WIRING (#6475 review round 1, blocker 4). It wires the REAL
// source-binding store (index.cjs `createStockPreparationSourceBindingStore({ db })`, here over an
// in-memory db) holding the workbench picker's row under the page's workspace hint, and it drives
// every step with the shape its real caller sends: dry-run, reconcile, the policy save and apply carry
// the page scope `?tenantId&workspaceId` (projectSync.ts / the workbench), mvp-persist carries NO
// query and hands back the apply's `sourceScopeDigest`. So the "not ready" these cases pin is reached
// AFTER the archive's source check has passed — it is the plan gate answering, not a scope split; the
// split itself is stock-preparation-mvp-persist-source-parity.test.cjs's subject. The deploy-time
// default the action config names resolves to NO system, so the store is load-bearing here:
//   H1 stop wiring the binding store                                           => D2 and D3 red
//      (the dry-run falls back to the deploy-time default: 422 TABLE_ACTION_SOURCE_INVALID)

const assert = require('node:assert/strict')
const { withRefreshGovernance } = require('./support/stock-preparation-refresh-governance-wiring.cjs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const {
  PLM_STOCK_PREPARATION_ACTION_ID,
  normalizeStockPreparationActionConfig,
} = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const { expandPlmProjectBom } = require(path.join(LIB, 'stock-preparation-bom-expansion.cjs'))
const { mapExpansionRowsToSnapshotLines } = require(path.join(LIB, 'stock-preparation-expansion-snapshot-mapper.cjs'))
const {
  BATCH_OBJECT_ID,
  LINE_OBJECT_ID,
  RUN_OBJECT_ID,
  PROJECT_OBJECT_ID,
} = require(path.join(LIB, 'stock-preparation-sync-run-persist.cjs'))
const { OBJECT_ID: LEDGER_OBJECT_ID, STATUSES, RESOLUTION_ACTIONS } = require(path.join(LIB, 'stock-preparation-confirmation-decisions.cjs'))
const {
  BINDING_TABLE,
  createStockPreparationSourceBindingStore,
} = require(path.join(LIB, 'stock-preparation-source-binding-store.cjs'))

const MVP_PERSIST_GATE = 'MULTITABLE_STOCK_PREP_TABLE_ACTION_MVP_PERSIST_ENABLED'
const TENANT_ID = 'tenant_1'
const WS_PAGE = 'workspace_page'
// The page scope the panel and the workbench put on every request but mvp-persist's.
const PAGE_QUERY = Object.freeze({ tenantId: TENANT_ID, workspaceId: WS_PAGE })
const DIGEST_SHAPE = /^[0-9a-f]{32}$/
const CANONICAL_OBJECT_ID = 'stockPreparationMain'
const CANONICAL_SHEET_ID = `sheet_${CANONICAL_OBJECT_ID}`
// The source the workbench BOUND (and the only one the registry below can load), and the deploy-time
// default the action config names — which resolves to NO system here, so any step that stopped
// resolving through the binding store fails loudly instead of quietly reading the same data.
const SOURCE_SYSTEM_ID = 'plm_sql_source'
const DEPLOY_DEFAULT_SYSTEM_ID = 'plm_sql_source_deploy_default'
const TEMPLATE_FIELD_IDS = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => field.id)
const PROJECT_NO = 'P-001'
const MVP_SHEET_IDS = Object.freeze([BATCH_OBJECT_ID, LINE_OBJECT_ID, RUN_OBJECT_ID, PROJECT_OBJECT_ID].map((id) => `sheet_${id}`))
const NOT_READY = 'STOCK_PREPARATION_MVP_SOURCE_EXPANSION_NOT_READY'

// One principal for the whole pull: the platform-admin tier the archive requires plus the stock-prep
// operate tier the confirm route requires; the verified tenant claim rides on every request.
const ADMIN_USER = Object.freeze({
  id: 'user_admin',
  tenantId: TENANT_ID,
  roles: ['admin'],
  permissions: ['integration:admin', 'stock-prep:read', 'stock-prep:operate'],
})

const ROUTE = Object.freeze({
  dryRun: '/api/integration/table-actions/:actionId/dry-run',
  apply: '/api/integration/table-actions/:actionId/apply',
  reconcile: '/api/integration/table-actions/:actionId/confirmation-decisions/reconcile',
  confirm: '/api/integration/stock-preparation/confirmation-decisions/confirm',
  policies: '/api/integration/table-actions/:actionId/conflict-policies',
  mvpPersist: '/api/integration/table-actions/:actionId/mvp-persist',
})
const ACTION_PARAMS = Object.freeze({ actionId: PLM_STOCK_PREPARATION_ACTION_ID })

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

// Two order lines of the SAME part under one order, told apart only by their sort line: one
// duplicate_expanded_key group with a stable discriminator — the shape keep_multiple_rows resolves.
function duplicateSourceData() {
  return {
    DN_PDM_PathExAttrInfo: [{ FileCode: PROJECT_NO, Parent_OBJ_ID: 'PATH-1' }],
    DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-1' }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-1', path_id: 'PATH-1' }],
    DN_PDM_OrderDetailInfo: [
      { order_id: 'ORDER-1', part_id: 'PART-A', quantity: '2', sort_id: '10' },
      { order_id: 'ORDER-1', part_id: 'PART-A', quantity: '3', sort_id: '20' },
    ],
    DN_PDM_PartLibraryInfo: [{ OBJ_ID: 'PART-A', IdentityNo: 'A-001', IdentityName: 'Assembly', Material: 'Steel', SysVer: 'V1' }],
    DN_PDM_BomHeadInfo: [],
    DN_PDM_BomDetailsInfo: [],
  }
}

function createSourceAdapter(data) {
  return {
    async read(input = {}) {
      const rows = Array.isArray(data[input.object]) ? data[input.object] : []
      const matches = rows.filter((row) =>
        Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
      return { records: matches.map(clone), nextCursor: null, done: true }
    },
  }
}

// ONE in-memory records API for every sheet the pull touches — the canonical target, the
// confirmation ledger and the four MVP snapshot tables — so what one step writes the next one reads.
function createRecordsApi() {
  const sheets = new Map()
  let seq = 0
  const sheetFor = (sheetId) => {
    if (!sheets.has(sheetId)) sheets.set(sheetId, new Map())
    return sheets.get(sheetId)
  }
  const api = {
    async queryRecords({ sheetId, filters, limit, offset } = {}) {
      const predicate = filters && typeof filters === 'object' ? filters : {}
      const all = [...sheetFor(sheetId).values()]
        .filter((row) => Object.entries(predicate).every(([key, value]) => row.data[key] === value))
        .map((row) => ({ id: row.id, sheetId: row.sheetId, version: 1, data: { ...row.data } }))
      const start = Number.isInteger(offset) ? offset : 0
      return Number.isInteger(limit) ? all.slice(start, start + limit) : all.slice(start)
    },
    async createRecord({ sheetId, data } = {}) {
      seq += 1
      const id = `rec_${seq}`
      sheetFor(sheetId).set(id, { id, sheetId, data: { ...data } })
      return { id, sheetId, version: 1, data: { ...data } }
    },
    async patchRecord({ sheetId, recordId, changes } = {}) {
      const existing = sheetFor(sheetId).get(recordId)
      if (!existing) throw new Error(`patchRecord: unknown record ${recordId}`)
      const data = { ...existing.data, ...(changes || {}) }
      sheetFor(sheetId).set(recordId, { id: recordId, sheetId, data })
      return { id: recordId, sheetId, version: 2, data: { ...data } }
    },
    async runStockPreparationPersistUnitOfWork(_input, operation) {
      return operation(api)
    },
  }
  return {
    api,
    rows(sheetId) {
      return [...sheetFor(sheetId).values()].map((row) => ({ id: row.id, data: { ...row.data } }))
    },
  }
}

// Every object — canonical, ledger, the four snapshot tables — resolves to `sheet_<objectId>` with
// identity field ids, and the DB-backed column read reports every requested column present: the
// snapshot tables are provisioned and complete, so nothing but the plan can stop the archive.
function createProvisioning() {
  const identity = (fieldIds) => Object.fromEntries((Array.isArray(fieldIds) ? fieldIds : []).map((id) => [id, id]))
  return {
    getObjectSheetId(_projectId, objectId) {
      return `sheet_${objectId}`
    },
    async findObjectSheet({ objectId } = {}) {
      return { id: `sheet_${objectId}`, baseId: null, name: objectId, description: null }
    },
    async resolveFieldIds({ fieldIds } = {}) {
      return identity(fieldIds)
    },
    async resolveExistingObjectFieldIds({ fieldIds } = {}) {
      return identity(fieldIds)
    },
    async ensureObject() {
      throw new Error('ensureObject must never be called on this path')
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

// The binding store's db, in memory (pg result shape, bare array off select). The workbench picker's
// row is seeded straight into the table — exactly what its hinted POST leaves behind.
function createBindingDb() {
  const rows = []
  const matches = (row, where) => Object.entries(where || {}).every(([column, value]) => (row[column] ?? null) === (value ?? null))
  const handle = {
    rows,
    async selectOne(table, where) {
      return rows.find((row) => row.__table === table && matches(row, where)) || null
    },
    async select(table, options = {}) {
      const found = rows.filter((row) => row.__table === table && matches(row, options.where))
      return Number.isInteger(options.limit) ? found.slice(0, options.limit) : found
    },
    async insertOne() { throw new Error('the binding table is seeded directly in this suite') },
    async updateRow() { throw new Error('the binding table is seeded directly in this suite') },
    async selectOneForKeyShare() { throw new Error('the binding table is seeded directly in this suite') },
    async transaction(callback) { return callback(handle) },
  }
  rows.push({
    __table: BINDING_TABLE,
    id: 'binding_workbench',
    tenant_id: TENANT_ID,
    workspace_id: WS_PAGE,
    action_id: PLM_STOCK_PREPARATION_ACTION_ID,
    external_system_id: SOURCE_SYSTEM_ID,
    updated_by: null,
    created_at: 't0',
    updated_at: 't0',
  })
  return handle
}

function services(sourceAdapter, bindingStore) {
  const system = (input = {}) => (input.id !== SOURCE_SYSTEM_ID ? null : {
    id: input.id,
    tenantId: input.tenantId,
    name: 'Readonly PLM SQL',
    kind: 'data-source:sql-readonly',
    role: 'source',
    status: 'active',
    config: { dataSourceId: 'ds_plm', object: 'DN_PDM_PathExAttrInfo' },
  })
  return {
    // Batch-refresh phase 0 step 1: apply holds the project write lease (fails closed 501 without the lock).
    stockPreparationProjectWriteLock: freshProjectWriteLock(),
    externalSystemRegistry: {
      ...inertService(['upsertExternalSystem', 'deleteExternalSystem', 'listExternalSystems']),
      async getExternalSystem(input = {}) { return system(input) },
      async getExternalSystemForAdapter(input = {}) {
        const found = system(input)
        return found ? { ...found, credentials: {} } : null
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
    bridgeAgentChecklistStore: inertService(['saveVersion', 'approve', 'retire', 'getForApply']),
    stockPreparationAuditStore: { async append() { return { ok: true } } },
    stockPreparationConfirmationDecisionLease: {
      async acquire() { return { leaseId: 'lease_1', held: true } },
      async release() { return true },
      async renew() { return { held: true } },
    },
    tenantPrincipalDirectory: { async verifyTenantMembership() { return { member: true } } },
    stockPreparationSourceBindingStore: bindingStore,
  }
}

function actionConfig() {
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: { externalSystemId: DEPLOY_DEFAULT_SYSTEM_ID, kind: 'data-source:sql-readonly' },
    target: {
      sheetId: CANONICAL_SHEET_ID,
      objectId: CANONICAL_OBJECT_ID,
      fieldIdMap: Object.fromEntries(TEMPLATE_FIELD_IDS.map((id) => [id, id])),
    },
  }
}

function mount() {
  const routes = new Map()
  const records = createRecordsApi()
  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      multitable: { provisioning: createProvisioning(), records: require('./support/stock-preparation-project-write-lock-kit.cjs').withFakeHostWriteFence(records.api) },
    },
    storage: consumableMap(),
    config: {
      stockPreparationTableActions: [actionConfig()],
      stockPrepApplySandbox: { enabled: true, allowedTargetObjectIds: [CANONICAL_OBJECT_ID] },
    },
  }
  httpRoutes.registerIntegrationRoutes({
    context,
    services: withRefreshGovernance(services(
      createSourceAdapter(duplicateSourceData()),
      createStockPreparationSourceBindingStore({ db: createBindingDb() }),
    )),
    logger: { info() {}, warn() {}, error() {} },
  })
  return { routes, records, lastApplyDigest: null }
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

async function call(routes, method, routePath, { body = {}, params = ACTION_PARAMS, query = PAGE_QUERY } = {}) {
  const handler = routes.get(`${method} ${routePath}`)
  assert.ok(handler, `route ${method} ${routePath} is registered`)
  const res = createResponse()
  try {
    await handler({ user: ADMIN_USER, authenticatedTenantId: TENANT_ID, body, query, params }, res)
  } catch (error) {
    res.statusCode = error && error.status ? error.status : 500
    res.body = { ok: false, error: { code: error && error.code ? error.code : 'THREW', message: error && error.message } }
  }
  assert.notEqual(res.body, undefined, `${method} ${routePath} produced a body`)
  return res
}

const pull = () => ({ parameters: { projectNo: PROJECT_NO } })

async function dryRun(h) {
  const res = await call(h.routes, 'POST', ROUTE.dryRun, { body: pull() })
  assert.equal(res.statusCode, 200, `dry-run: ${JSON.stringify(res.body)}`)
  return res.body.data
}

async function applyAcknowledged(h, token) {
  const res = await call(h.routes, 'POST', ROUTE.apply, {
    body: { ...pull(), confirm: { dryRunToken: token, acceptDuplicateResolution: true } },
  })
  assert.equal(res.statusCode, 200, `apply: ${JSON.stringify(res.body)}`)
  assert.equal(res.body.data.status, 'succeeded')
  assert.match(res.body.data.sourceScopeDigest, DIGEST_SHAPE, 'apply answers the digest of the source it read')
  h.lastApplyDigest = res.body.data.sourceScopeDigest
  return res.body.data
}

async function reconcileAndConfirm(h) {
  const reconciled = await call(h.routes, 'POST', ROUTE.reconcile, { body: pull() })
  assert.equal(reconciled.statusCode, 201, `reconcile: ${JSON.stringify(reconciled.body)}`)
  const pending = h.records.rows(`sheet_${LEDGER_OBJECT_ID}`).filter((row) => row.data.status === STATUSES.PENDING)
  assert.equal(pending.length, 1, 'exactly one pending decision is queued')
  const confirmed = await call(h.routes, 'POST', ROUTE.confirm, {
    params: {},
    query: {},
    body: {
      decisionId: pending[0].data.decisionId,
      inputFingerprint: pending[0].data.inputFingerprint,
      resolutionAction: RESOLUTION_ACTIONS.KEEP_MULTIPLE_ROWS,
    },
  })
  assert.equal(confirmed.statusCode, 200, `confirm: ${JSON.stringify(confirmed.body)}`)
}

function snapshotRowCount(h) {
  return MVP_SHEET_IDS.reduce((total, sheetId) => total + h.records.rows(sheetId).length, 0)
}

async function assertArchiveRefusesNotReady(h, label) {
  // The panel's step-④ shape: NO query (the route refuses one), the apply's digest handed back.
  const res = await call(h.routes, 'POST', ROUTE.mvpPersist, {
    body: { ...pull(), sourceScopeDigest: h.lastApplyDigest },
    query: {},
  })
  assert.equal(res.statusCode, 409, `${label}: the archive answers 409 (got ${res.statusCode} ${JSON.stringify(res.body && res.body.error)})`)
  assert.equal(res.body.error.code, NOT_READY, `${label}: with the typed "not ready" code — never the snapshot's 422 line-key ambiguity`)
  assert.equal(snapshotRowCount(h), 0, `${label}: and not one snapshot row was written`)
}

// ── D1 ───────────────────────────────────────────────────────────────────────────────────────

async function d1TheGroupsRowsCollideOnOneSnapshotLineId() {
  const action = normalizeStockPreparationActionConfig(actionConfig())
  const expansion = await expandPlmProjectBom({
    sourceAdapter: createSourceAdapter(duplicateSourceData()),
    projectNo: PROJECT_NO,
    readPlan: action.source.readPlan,
  })
  const parts = expansion.rows.filter((row) => row.componentSourceId === 'PART-A')
  assert.equal(parts.length, 2, 'D1 control: the source yields the two rows of the group')
  assert.equal(parts[0].idempotencyKey, parts[1].idempotencyKey, 'D1: one duplicate_expanded_key group')
  assert.notEqual(parts[0].sortLine, parts[1].sortLine, 'D1 control: told apart only by the sort line')
  assert.equal(parts[0].path, parts[1].path, 'D1: the key is path-derived, so the two rows share their path')
  const mapped = mapExpansionRowsToSnapshotLines(parts, { snapshotBatchId: 'snapshot_d1' })
  assert.equal(mapped.lines.length, 2)
  assert.equal(mapped.lines[0].snapshotLineId, mapped.lines[1].snapshotLineId,
    'D1: the snapshot keys a line by its path, so the two rows become ONE line id — a batch the persist refuses as ambiguous')
}

// ── D2 ───────────────────────────────────────────────────────────────────────────────────────

async function d2TableScopePolicyResolvedGroupStillRefusesTheArchive() {
  const h = mount()
  const held = await dryRun(h)
  assert.equal(held.status, 'manual_confirm_required', 'D2 control: the group holds without a policy')
  const fingerprint = held.evidence.plan.duplicateExpandedKeyDiagnostics.groups[0].fingerprint
  const saved = await call(h.routes, 'PUT', ROUTE.policies, {
    body: { conflictType: 'duplicate_expanded_key', policies: [{ fingerprint, policy: 'keep_multiple_rows' }] },
  })
  assert.equal(saved.statusCode, 200, `D2 policy save: ${JSON.stringify(saved.body)}`)
  const ready = await dryRun(h)
  assert.equal(ready.status, 'ready', 'D2 control: the stored policy resolves the group for the dry-run')
  const applied = await applyAcknowledged(h, ready.dryRunToken)
  assert.equal(applied.apply.counts.created, 2, 'D2 control: apply wrote both rows of the group')
  await assertArchiveRefusesNotReady(h, 'D2')
}

// ── D3 ───────────────────────────────────────────────────────────────────────────────────────

async function d3ConfirmedDecisionResolvedGroupStillRefusesTheArchive() {
  const h = mount()
  assert.equal((await dryRun(h)).status, 'manual_confirm_required', 'D3 control: held before any decision')
  await reconcileAndConfirm(h)
  const first = await dryRun(h)
  assert.equal(first.status, 'ready', 'D3 control: the confirmed decision resolves the group')
  assert.equal((await applyAcknowledged(h, first.dryRunToken)).apply.counts.created, 2)
  // The write moved the sheet the ledger's revision hashes: the repeat pull is held again until the
  // group is confirmed against the CURRENT sheet.
  assert.equal((await dryRun(h)).status, 'manual_confirm_required', 'D3 control: the written sheet re-opens the hold')
  await reconcileAndConfirm(h)
  const repeat = await dryRun(h)
  assert.equal(repeat.status, 'ready', 'D3 control: the repeat pull plans ready through the ledger')
  assert.equal(repeat.evidence.confirmationDecision.matchedPolicyCount, 1)
  const applied = await applyAcknowledged(h, repeat.dryRunToken)
  assert.equal(applied.apply.counts.created + applied.apply.counts.updated + applied.apply.counts.inactive, 0,
    'D3 control: the repeat apply writes nothing')
  await assertArchiveRefusesNotReady(h, 'D3')
}

async function main() {
  const previousGate = process.env[MVP_PERSIST_GATE]
  process.env[MVP_PERSIST_GATE] = 'true'
  try {
    await d1TheGroupsRowsCollideOnOneSnapshotLineId()
    await d2TableScopePolicyResolvedGroupStillRefusesTheArchive()
    await d3ConfirmedDecisionResolvedGroupStillRefusesTheArchive()
  } finally {
    if (previousGate === undefined) delete process.env[MVP_PERSIST_GATE]
    else process.env[MVP_PERSIST_GATE] = previousGate
  }
  console.log('stock-preparation-mvp-persist-duplicate-hold-gate tests passed')
}

require('./support/fail-closed-suite-runner.cjs').runFailClosedMain('stock-preparation-mvp-persist-duplicate-hold-gate.test.cjs', main)
