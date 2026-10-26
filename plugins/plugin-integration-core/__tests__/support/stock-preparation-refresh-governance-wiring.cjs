'use strict'

// Test support (NOT a suite; support/ is outside the chain-completeness walk): THE REAL step-4 governance for a
// suite — batch-refresh step 4 PR-3a, plan-final §2.9.
//
//   * ONE refresh-kit fake db (stock-preparation-refresh-store-kit.cjs: the five step-4 tables of migrations
//     102 / 103 parsed from the migration text, plus the registry table of 087 / 101);
//   * the REAL continuation store and the REAL governance reader over it;
//   * the REAL registry store over the SAME db (M-4: the reader runs PR B's pilot reads on the consult's
//     snapshot handle, so a registry row seeded anywhere else would be invisible to it);
//   * the suite's OWN project write lock (lazily: the reader's lock reads must see the very lock row the routes'
//     leases write, or the verdict's generation token would not be the write fence's);
//   * the REAL handle builder (lib/stock-preparation-refresh-lanes.cjs createRefreshGovernanceHandle) for direct
//     lib calls, and the REAL large-lane verdict for a direct chunk gate.
// A stub reader is forbidden (P3-C3): every seed goes through the store's own methods (reconcileHolds,
// confirmContinuation with the kit's fake bumpWithin, endContinuation, beginExecution / finishExecution) or a
// registry row through the registry table. Synthetic values only.

const path = require('node:path')

const LIB = path.join(__dirname, '..', '..', 'lib')
const refreshKit = require('./stock-preparation-refresh-store-kit.cjs')
const { createStockPreparationContinuationStore, REFRESH_STORE_TABLES } = require(path.join(LIB, 'stock-preparation-continuation-store.cjs'))
const { createStockPreparationRefreshGovernance } = require(path.join(LIB, 'stock-preparation-refresh-governance.cjs'))
const { createStockPreparationProjectTargetStore } = require(path.join(LIB, 'stock-preparation-project-target-store.cjs'))
const lanes = require(path.join(LIB, 'stock-preparation-refresh-lanes.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(LIB, 'stock-preparation-templates.cjs'))

const DEFAULT_TENANT = 'tenant_rgw_default'

// A pack-install ledger fake: an empty ledger by default (=> the strict read answers `no_pack`), a per-scope
// list of field ids, and a fault switch (=> `read_failed`).
function createPackInstallStoreFake() {
  const ledger = new Map()
  const calls = []
  let fault = null
  const key = ({ tenantId, projectId, objectId }) => `${tenantId}|${projectId}|${objectId}`
  return {
    calls,
    setFieldIds(scope, fieldIds) { ledger.set(key(scope), fieldIds.slice()) },
    fail(error) { fault = error },
    clearFault() { fault = null },
    async listInstalledFieldIds(scope) {
      calls.push({ ...scope })
      if (fault) throw fault
      return { fieldIds: (ledger.get(key(scope)) || []).slice() }
    },
  }
}

// A source-binding fake for the lane's unanimity check (only `listForAction` is read by the check; `get` is the
// route's action resolver and answers the exact / tenant-null row like the real store's first two legs).
function createSourceBindingStoreFake() {
  const rows = []
  const calls = []
  let fault = null
  let incomplete = false
  return {
    rows,
    calls,
    seed({ tenantId, actionId, workspaceId = null, externalSystemId }) {
      const existing = rows.find((row) => row.tenantId === tenantId && row.actionId === actionId && row.workspaceId === workspaceId)
      if (existing) existing.externalSystemId = externalSystemId
      else rows.push({ tenantId, actionId, workspaceId, externalSystemId })
    },
    fail(error) { fault = error },
    clearFault() { fault = null },
    setIncomplete(value) { incomplete = value === true },
    async get({ tenantId, actionId, workspaceId = null }) {
      calls.push(['get', tenantId, actionId, workspaceId])
      const exact = rows.find((row) => row.tenantId === tenantId && row.actionId === actionId && row.workspaceId === (workspaceId || null))
      if (exact) return { ...exact, matchedWorkspaceId: workspaceId || null, scopeFallback: null }
      if (workspaceId) {
        const tenantWide = rows.find((row) => row.tenantId === tenantId && row.actionId === actionId && row.workspaceId === null)
        return tenantWide ? { ...tenantWide, matchedWorkspaceId: null, scopeFallback: 'tenant_null_row' } : null
      }
      return null
    },
    async listForAction({ tenantId, actionId }) {
      calls.push(['listForAction', tenantId, actionId])
      if (fault) throw fault
      return { bindings: rows.filter((row) => row.tenantId === tenantId && row.actionId === actionId).map((row) => ({ ...row })), complete: !incomplete }
    },
  }
}

/**
 * The governance environment. `lock` (or `lockOf()`, resolved at every read) is the suite's project write lock;
 * without either, an in-memory lock of the lock kit (a not-governed preview of a never-leased sheet reads its
 * absent row, which is all it needs).
 */
// The kit's fake refuses OVERLAPPING transactions (so a store suite can never pass on an interleaving PostgreSQL
// would run differently). A ROUTE suite runs concurrent requests (a background dry-run next to a synchronous one),
// so the environment queues its transactions one after another — PostgreSQL would run them side by side; the
// interleavings themselves are proven by the real-DB cases (S2 / S3A), never here.
function serializeTransactions(db) {
  let tail = Promise.resolve()
  return new Proxy(db, {
    get(target, key, receiver) {
      if (key !== 'transaction') return Reflect.get(target, key, receiver)
      return (callback) => {
        const run = tail.then(() => target.transaction(callback))
        tail = run.catch(() => undefined)
        return run
      }
    },
  })
}

function createRefreshGovernanceEnv(options = {}) {
  const clock = options.clock || refreshKit.createClock()
  // PR-4 `lockOnRefreshDb`: ONE fake db serves the store AND the REAL lock module (the lock table of migration
  // 100 modelled beside the five step-4 tables), so a route suite drives the real composition — the decision
  // transaction's `bumpGenerationWithin` on the store's transaction handle, a lease the routes take on the same
  // row. The lock built here is the suite's lock (`lockOf` / `lock` are then ignored).
  const lockOnRefreshDb = options.lockOnRefreshDb === true
  const db = serializeTransactions(options.refreshDb || refreshKit.createFakeRefreshDb({ clock, registryPilotColumns: options.registryPilotColumns !== false, lockTable: lockOnRefreshDb }))
  let n = 0
  const idPrefix = options.idPrefix || 'rgw'
  const store = createStockPreparationContinuationStore({ db, now: clock.now, idGenerator: (kind) => `${kind}_${idPrefix}_${String((n += 1)).padStart(4, '0')}` })
  const registryStore = createStockPreparationProjectTargetStore({ db })
  const sharedLock = lockOnRefreshDb
    ? require(path.join(LIB, 'stock-preparation-project-write-lock.cjs')).createStockPreparationProjectWriteLock({ db, now: clock.now, ...(options.lockOptions || {}) })
    : null
  let fallbackLock = null
  function currentLock() {
    if (sharedLock) return sharedLock
    const lock = typeof options.lockOf === 'function' ? options.lockOf() : options.lock
    if (lock) return lock
    if (!fallbackLock) {
      const lockKit = require('./stock-preparation-project-write-lock-kit.cjs')
      fallbackLock = lockKit.createInMemoryProjectWriteLock({ timers: 'real' }).lock
    }
    return fallbackLock
  }
  // The reader only reads the lock (readState / readGeneration); a lazy proxy keeps it on the suite's lock.
  const lockProxy = Object.freeze({
    readState: (scopeKey) => currentLock().readState(scopeKey),
    readGeneration: (scopeKey) => currentLock().readGeneration(scopeKey),
  })
  // The registry the reader asks for the pilot marker. Default: the REAL registry store over the SAME kit db
  // (M-4), so the pilot read runs on the consult's snapshot handle exactly as in production. A ROUTE suite whose
  // routes use their own registry store passes `registryOf` (resolved per read): the reader then asks THAT
  // store, without the snapshot executor — the plan-final §7 risk-2 fallback, hermetic suites only (the single
  // snapshot is proven on real PostgreSQL by #6514's S2-07 / S2-08 and the S3A cases).
  function readerRegistry() {
    const suiteStore = typeof options.registryOf === 'function' ? options.registryOf() : null
    if (suiteStore && typeof suiteStore.getPilotState === 'function' && typeof suiteStore.getPilotStateBySheetId === 'function') {
      return {
        getPilotState: (input) => suiteStore.getPilotState(input),
        getPilotStateBySheetId: (input) => suiteStore.getPilotStateBySheetId(input),
      }
    }
    return registryStore
  }
  const registryProxy = Object.freeze({
    getPilotState: (input, readOptions) => readerRegistry().getPilotState(input, readOptions),
    getPilotStateBySheetId: (input, readOptions) => readerRegistry().getPilotStateBySheetId(input, readOptions),
  })
  const governance = createStockPreparationRefreshGovernance({ continuationStore: store, projectTargetStore: registryProxy, projectWriteLock: lockProxy })
  const packInstallStore = options.packInstallStore === undefined ? createPackInstallStoreFake() : options.packInstallStore
  const sourceBindingStore = options.sourceBindingStore === undefined ? null : options.sourceBindingStore
  const bump = refreshKit.createFakeBumpWithin()

  function handleFor(tenantId = DEFAULT_TENANT, overrides = {}) {
    const pick = (name, fallback) => (Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : fallback)
    return lanes.createRefreshGovernanceHandle({
      tenantId,
      resolveServices: pick('resolveServices', () => ({ governance, store })),
      sourceBindingStore: pick('sourceBindingStore', sourceBindingStore),
      packInstallStore: pick('packInstallStore', packInstallStore),
      resolveProvisioning: () => pick('provisioning', options.provisioning || null),
      projectId: pick('projectId', `${tenantId}:integration-core`),
      defaultObjectId: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId,
      extFieldMapping: pick('extFieldMapping', options.extFieldMapping || null),
    })
  }

  // The chunk gate a direct large-lane caller hands the lib: the REAL consult + the REAL large-lane verdict.
  function chunkGateFor(tenantId, projectNo) {
    return async ({ target } = {}) => lanes.largeLaneVerdictOf(await governance.consult({ tenantId, projectNo, sheetId: target && target.sheetId }), 'large_apply_chunk')
  }

  function scopeOf({ tenantId = DEFAULT_TENANT, sheetId, projectNo }) {
    return { tenantId, sheetId, projectNo }
  }

  function decisionVersionOf(scope) {
    const state = db.rows(REFRESH_STORE_TABLES.state).find((row) => row.sheet_id === scope.sheetId && row.project_no === scope.projectNo)
    return state ? state.decision_version : 0
  }

  const env = {
    db,
    clock,
    store,
    registryStore,
    governance,
    packInstallStore,
    sourceBindingStore,
    bump,
    lock: currentLock,
    handleFor,
    chunkGateFor,
    services() {
      return { stockPreparationRefreshGovernance: governance, stockPreparationContinuationStore: store }
    },
    rows(table) {
      return db.rows(REFRESH_STORE_TABLES[table] || table)
    },
    // Every row of the five step-4 tables (the "nothing persisted" check).
    stepFourRowCount() {
      return Object.values(REFRESH_STORE_TABLES).reduce((sum, table) => sum + db.rows(table).length, 0)
    },
    snapshot() {
      return JSON.stringify(Object.values(REFRESH_STORE_TABLES).map((table) => db.rows(table)))
    },
    async registerProject({ tenantId = DEFAULT_TENANT, projectNo, sheetId, objectId, pilot = false, status = 'active' }) {
      await db.insertOne(refreshKit.REGISTRY_TABLE, refreshKit.registryRow({ tenantId, projectNo, sheetId, objectId, pilot, status }))
    },
    // Persist holds the way a computation would (governs the project).
    async seedHolds(input, holds, { suspended = holds.length > 0, verdicts, lane = 'small_preview' } = {}) {
      const scope = scopeOf(input)
      return store.reconcileHolds({ ...scope, decisionVersionObserved: decisionVersionOf(scope), holds, computation: { lane, suspended, generationToken: null, sourceContentDigest: null }, ...(verdicts ? { verdicts } : {}) })
    },
    // Persist a candidate hold and confirm it (the kit's fake in-transaction bump), the way PR-4's route will.
    async seedConfirmedContinuation(input, hold, { sourceIdentity, confirmedBy = 'u_rgw_puller' } = {}) {
      const scope = scopeOf(input)
      await env.seedHolds(scope, [hold])
      const row = db.rows(REFRESH_STORE_TABLES.hold).find((entry) => entry.fingerprint === hold.fingerprint && entry.status === 'open' && entry.sheet_id === scope.sheetId)
      if (!row) throw new Error('wiring: the candidate hold was not persisted')
      return store.confirmContinuation({
        ...scope, holdId: row.id, echo: refreshKit.echoOf(hold), basis: { kind: 'puller_confirmed_same_demand' }, confirmedBy, sourceIdentity,
      }, { bumpWithin: bump.bumpWithin })
    },
    // R-6's corrected recipe: confirm -> reconcile a reconfirm hold WITH a status-reason verdict -> escalate.
    async seedEscalatedContinuation(input, hold, { sourceIdentity, verdict = 'source_scope_changed' } = {}) {
      const scope = scopeOf(input)
      const confirmed = await env.seedConfirmedContinuation(scope, hold, { sourceIdentity })
      const reconfirm = refreshKit.reconfirmHoldFor(confirmed.continuationId)
      await env.seedHolds(scope, [reconfirm], { verdicts: { [confirmed.continuationId]: verdict } })
      await store.endContinuation({ ...scope, continuationId: confirmed.continuationId, revision: 1, outcome: 'escalate_special_repair', endedBy: 'u_rgw_puller' }, { bumpWithin: bump.bumpWithin })
      return { confirmed, reconfirm }
    },
    async seedExecution(input, { status = 'failed', leaseId = 'lease_rgw_dead', leaseRunId = 'run_rgw_dead', refreshBinding = { continuations: [] } } = {}) {
      const scope = scopeOf(input)
      const execution = await store.beginExecution({
        ...scope,
        lane: 'small_apply',
        guard: { leaseRunId, leaseId, fencingEpoch: 1, generation: 1, generationToken: 'tok_rgw_dead' },
        tokenRevision: 'rev_rgw_dead',
        planDigest: 'plan_rgw_dead',
        plannedCounts: { add: 0, update: 0, inactive: 0 },
        refreshBinding,
        startedBy: 'u_rgw_puller',
      })
      if (status !== 'running') await store.finishExecution({ ...scope, executionId: execution.id, status, written: 0, attemptedWrites: 0 })
      return execution
    },
  }
  return env
}

/**
 * Wire the two services a route suite's `registerIntegrationRoutes({ services })` needs. The reader's lock is the
 * suite's `services.stockPreparationProjectWriteLock`, resolved lazily (a suite may set it after this call).
 */
function wireRefreshGovernance(services, options = {}) {
  const env = createRefreshGovernanceEnv({
    lockOf: () => services.stockPreparationProjectWriteLock || null,
    registryOf: () => services.stockPreparationProjectTargetStore || null,
    ...options,
  })
  services.stockPreparationRefreshGovernance = env.governance
  services.stockPreparationContinuationStore = env.store
  // PR-4: the routes' lock IS the env's shared lock when the suite asked for one db (see createRefreshGovernanceEnv).
  if (options.lockOnRefreshDb === true) services.stockPreparationProjectWriteLock = env.lock()
  if (options.wirePackInstallStore === true) services.stockPreparationPackInstallStore = env.packInstallStore
  if (options.sourceBindingStore && options.wireSourceBindingStore === true) services.stockPreparationSourceBindingStore = options.sourceBindingStore
  return env
}

// The expression form for a suite that builds its services inline: `services: withRefreshGovernance(...)`. The
// environment rides the services object as a non-enumerable `refreshGovernanceEnv` (never a route input).
function withRefreshGovernance(services, options = {}) {
  const env = wireRefreshGovernance(services, options)
  Object.defineProperty(services, 'refreshGovernanceEnv', { value: env, enumerable: false, configurable: true })
  return services
}

module.exports = {
  DEFAULT_TENANT,
  createPackInstallStoreFake,
  createRefreshGovernanceEnv,
  createSourceBindingStoreFake,
  withRefreshGovernance,
  wireRefreshGovernance,
}
