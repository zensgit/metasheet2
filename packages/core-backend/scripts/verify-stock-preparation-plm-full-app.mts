import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHook } from 'node:async_hooks'
import { randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { Server as HttpServer } from 'node:http'
import type { Server as SocketServer } from 'socket.io'
import type { Pool } from 'pg'
import { configuredBusinessSnapshot, configuredCoreModulePath, configureThroughOwnerHttp, seedConfiguredFixture,
  verifyConfiguredBrowserResult, type ConfiguredDataSourceRoutes } from '../tests/utils/stock-preparation-plm-full-app-fixture.ts'
import { createK3FullAppFixture } from '../tests/utils/stock-preparation-k3-full-app-fixture.ts'
import { configureAutomationFullAppDeployment, createAutomationFullAppFixture } from '../tests/utils/stock-preparation-automation-full-app-fixture.ts'
import { createAutomationIntervalFullAppFixture } from '../tests/utils/stock-preparation-automation-interval-full-app-fixture.ts'
import type { AutomationCheckpoint, ConfiguredAutomationBrowserResult } from '../tests/utils/stock-preparation-automation-full-app-browser.ts'
import { observeYidaOwnerOffQueries, ownerOffDatabaseCounts, ownerOffTables, probeYidaOwnerOffLogs } from '../tests/utils/stock-preparation-yida-owner-off-full-app.ts'
import type { provisionYidaInitializationAnchor } from '../src/integration/yida-initialization-bootstrap.ts'
import type { Queryable } from '../src/multitable/automation-durable-dispatcher.ts'
import type { YidaInitializationBrowserInput, runYidaInitializationFullApp } from '../tests/utils/stock-preparation-yida-initialization-full-app.ts'
import { runYidaAuthorizationFullApp } from '../tests/utils/stock-preparation-yida-initialization-full-app.ts'
import { assertRequiredMainMigrationInventory } from '../tests/utils/stock-preparation-main-migration-contract.ts'
import { verifyYidaAutomationMainDefaultOff } from '../tests/utils/yida-automation-main-full-app.ts'
import { createYidaMainSyntheticVendor, verifyYidaAutomationMainSyntheticExecution } from '../tests/utils/yida-automation-main-synthetic-send.ts'
import { beginYidaMainInFlightStop } from '../tests/utils/yida-automation-main-inflight-stop.ts'
import { observeUnknownLedger } from '../tests/utils/yida-automation-main-fresh-consent-fence.ts'
import { verifyYidaMainRemainingUnknown } from '../tests/utils/yida-automation-main-remaining-unknown.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
interface NamespaceScopeAuthority {
  decodeScope(repoRoot: string, argument: string): object
  assertOwnedNamespaceScope(scope: object): unknown
  namespaceChildArguments(scope: object): string[]
}
const namespaceAuthority = createRequire(import.meta.url)(path.join(root,
  'scripts/ops/lib/stock-preparation-plm-namespace-scope.cjs')) as NamespaceScopeAuthority
assert([4, 5].includes(Number(process.argv.length)), 'APP_CONFIGURED_NAMESPACE_ARGUMENT_REQUIRED')
const namespaceScope = namespaceAuthority.decodeScope(root, process.argv.splice(process.argv.length - 1, 1)[0])
namespaceAuthority.assertOwnedNamespaceScope(namespaceScope)
const yidaArgument = process.argv.splice(3, 1)[0]
assert(yidaArgument === undefined || yidaArgument === '--yida-case=remaining-unknown', 'APP_CONFIGURED_YIDA_CASE_INVALID')
const yidaCase = yidaArgument ? 'remaining-unknown' : undefined
assert.equal(yidaCase, (namespaceScope as { owner: { yidaCase?: string } }).owner.yidaCase, 'APP_CONFIGURED_YIDA_CASE_SCOPE_REQUIRED')
assert(process.argv.length === 3 && ['--automation-scenario=manual', '--automation-scenario=interval'].includes(process.argv[2]),
  'APP_AUTOMATION_EXACT_SCENARIO_ARGUMENT_REQUIRED')
const automationScenario = process.argv[2] === '--automation-scenario=interval' ? 'interval' : 'manual'
assert(yidaCase === undefined || automationScenario === 'manual', 'APP_CONFIGURED_YIDA_CASE_SCENARIO_REQUIRED')
const automationStage = `automation-${automationScenario}`
const coreRequire = createRequire(path.join(root, 'packages/core-backend/package.json'))
const coreModulePath = (relative: string) => configuredCoreModulePath(root, relative)
const loadCore = <T,>(relative: string): T => coreRequire(coreModulePath(relative)) as T
const scratch = process.env.PLM_FULL_APP_SCRATCH
assert(scratch && path.dirname(scratch) === path.join(root, 'tmp') && /^stock-preparation-plm-full-app-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(path.basename(scratch)))
assert.equal(process.cwd(), scratch)
assert(process.env.DATABASE_URL && process.env.DATABASE_URL === process.env.PLM_FULL_APP_DATABASE_URL,
  'APP_CONFIGURED_DATABASE_IDENTITY_REQUIRED')
const databaseUrl = new URL(process.env.DATABASE_URL)
assert(['postgres:', 'postgresql:'].includes(databaseUrl.protocol)
  && databaseUrl.hostname === '127.0.0.1'
  && databaseUrl.pathname === '/plm_full_app_synthetic'
  && Number.isSafeInteger(Number(databaseUrl.port)) && Number(databaseUrl.port) > 0
  && Number(databaseUrl.port) <= 65535 && databaseUrl.username && databaseUrl.password,
'APP_CONFIGURED_LOCAL_SYNTHETIC_DATABASE_REQUIRED')
interface HostServer {
  start(): Promise<void>
  stop(reason: string): Promise<void>
  getAddress(): ReturnType<HttpServer['address']>
}
interface MainPool {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
  transaction<T>(work: (trx: Queryable) => Promise<T>): Promise<T>
  stopMetricsCollection(): void
  getInternalPool(): Pool & { ended: boolean }
}
interface PoolManager { get(): MainPool }
interface ObservedCollaboration { getIO(): SocketServer | null }
interface ObservedAdapter { isConnected(): boolean; pool: (Pool & { ended: boolean }) | null }
let host: HostServer | undefined
let k3: Awaited<ReturnType<typeof createK3FullAppFixture>> | undefined
let automation: Awaited<ReturnType<typeof createAutomationFullAppFixture | typeof createAutomationIntervalFullAppFixture>> | undefined
let ownerOffQueryObservation: ReturnType<typeof observeYidaOwnerOffQueries> | undefined
let freshQueryObservation: ReturnType<typeof observeUnknownLedger> | undefined
let collabIo: SocketServer | undefined
let collaboration: ObservedCollaboration | undefined
let hostListener: HttpServer | undefined
let mainPool: MainPool | undefined
let sourceManager: (ConfiguredDataSourceRoutes['dataSourceManager'] & { adapters: Map<string, ObservedAdapter> }) | undefined
let sourcePool: (Pool & { ended: boolean }) | undefined
let sourceAdapter: ObservedAdapter | undefined
let sourceRegistrationCount: number | undefined
let liveCollaborationClientCount = 0
let collaborationDisconnects = 0
let collaborationStopStarted = false
let collaborationCompletion: Promise<{ disconnects: number; allDisconnected: boolean }> | undefined
let yidaInFlight: Awaited<ReturnType<typeof beginYidaMainInFlightStop>> | undefined
let yidaStopCheck: Promise<void> | undefined
let actualStopSucceeded = false
const emergencyCleanup: Array<() => void | Promise<void>> = []
const stage = (name: string, data: Record<string, unknown> = {}) => console.log('PLM_FULL_APP_PROBE ' + JSON.stringify({ stage: name, ...data }))
const timers = new Map<number, { value: WeakRef<{ hasRef(): boolean; _repeat?: number; _destroyed?: boolean }>; origin: string }>()
const timerHook = createHook({
  init(id, type, _trigger, resource) {
    if (type !== 'Timeout') return
    // Async-hook scaffolding occupies the default ten frames. Capture enough
    // to identify the compiled timer owner, without publishing absolute paths.
    const previousLimit = Error.stackTraceLimit
    let frames: string
    try {
      Error.stackTraceLimit = 40
      frames = (new Error().stack ?? '').replaceAll('\\', '/')
    } finally { Error.stackTraceLimit = previousLimit }
    const compiled = frames.match(/\/build\/backend\/dist\/(src\/[A-Za-z0-9_/-]+\.js):(\d+):/)
    const plugin = frames.match(/(plugins\/[A-Za-z0-9_./-]+\.(?:js|cjs|mjs)):(\d+):/)
    const dependency = frames.match(/\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[A-Za-z0-9_-]+\/)?[A-Za-z0-9_-]+)\//)
    const origin = compiled ? `compiled-core/${compiled[1]}:${compiled[2]}`
      : plugin ? `${plugin[1]}:${plugin[2]}` : dependency ? `dependency/${dependency[1]}` : 'tooling-or-runtime'
    const timer = resource as { hasRef(): boolean; _repeat?: number; _destroyed?: boolean }
    timers.set(id, { value: new WeakRef(timer), origin })
  },
  destroy(id) { timers.delete(id) },
}).enable()
try {
  // Production modules use createRequire, matching the established full-app loader.
  const { MetaSheetServer } = loadCore<{ MetaSheetServer: new (options: { port: number; host: string; pluginDirs: string[]; manageProcessSignals: boolean }) => HostServer }>('index.ts')
  stage('module-imported', { compiledCore: true })
  const { poolManager } = loadCore<{ poolManager: PoolManager }>('integration/db/connection-pool.ts')
  const pool = poolManager.get()
  mainPool = pool
  const { pool: exportedPool } = loadCore<{ pool: Pool }>('db/pg.ts')
  assert.equal(exportedPool, pool.getInternalPool(), 'APP_CONFIGURED_MAIN_POOL_IDENTITY_REQUIRED')
  // Failure-only recovery captures existing resources; no teardown getter may
  // create a new service. These actions are never part of a successful proof.
  emergencyCleanup.push(async () => {
    pool.stopMetricsCollection()
    if (!pool.getInternalPool().ended) await pool.getInternalPool().end()
  })
  const { messageBus } = loadCore<{ messageBus: { stopMaintenance(): void } }>('integration/messaging/message-bus.ts')
  const { stopSafetyGuardMaintenance } = loadCore<{ stopSafetyGuardMaintenance(): void }>('guards/SafetyGuard.ts')
  const { stopIdempotencyMaintenance } = loadCore<{ stopIdempotencyMaintenance(): void }>('guards/idempotency.ts')
  const { stopRateLimiterMaintenance } = loadCore<{ stopRateLimiterMaintenance(): void }>('middleware/rate-limiter.ts')
  const { stopTokenBucketMaintenance } = loadCore<{ stopTokenBucketMaintenance(): void }>('integration/rate-limiting/token-bucket.ts')
  emergencyCleanup.unshift(() => messageBus.stopMaintenance(), stopSafetyGuardMaintenance, stopIdempotencyMaintenance,
    stopRateLimiterMaintenance, stopTokenBucketMaintenance)
  const query = pool.query.bind(pool)
  for (const table of ['automation_rules', 'directory_integrations', 'multitable_webhooks', 'multitable_webhook_deliveries', 'data_sources']) {
    assert.equal((await query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0)
  }
  const migrationCount = Number(process.env.PLM_FULL_APP_MIGRATION_COUNT)
  assert(Number.isSafeInteger(migrationCount) && migrationCount > 0,
    'APP_CONFIGURED_FULL_MIGRATION_COUNT_REQUIRED')
  const { createCoreBackendMigrationProvider } = loadCore<{
    createCoreBackendMigrationProvider(): { getMigrations(): Promise<Record<string, unknown>> }
  }>('db/migration-provider.ts')
  const migrationNames = Object.keys(await createCoreBackendMigrationProvider().getMigrations()).sort()
  const appliedNames = (await query('SELECT name FROM kysely_migration')).rows.map(row => {
    assert.equal(typeof row.name, 'string', 'APP_CONFIGURED_MIGRATION_NAME_REQUIRED')
    return row.name as string
  }).sort()
  stage('full-migration-inventory', { expectedCount: migrationCount, providerCount: migrationNames.length,
    ledgerCount: appliedNames.length, missingCount: appliedNames.filter(name => !migrationNames.includes(name)).length,
    extraCount: migrationNames.filter(name => !appliedNames.includes(name)).length })
  assert.equal(migrationNames.length, migrationCount, 'APP_CONFIGURED_FULL_MIGRATION_COUNT_REQUIRED')
  assertRequiredMainMigrationInventory(migrationNames, appliedNames)
  assert.deepEqual(appliedNames, migrationNames, 'APP_CONFIGURED_NO_PENDING_MIGRATIONS_REQUIRED')
  stage('full-migration-ledger-verified', { appliedCount: migrationCount, pendingCount: 0 })
  const bcrypt = coreRequire('bcryptjs') as typeof import('bcryptjs')
  const owner = randomUUID(), tenantId = randomUUID()
  const identifier = `plm-full-app-${randomUUID()}@example.invalid`
  const password = randomBytes(24).toString('base64url')
  // Bootstrap authority is an explicit synthetic fixture, not an HTTP admin-enrolment claim.
  await query(`INSERT INTO users (id,email,name,password_hash,role,permissions,is_active,must_change_password,activation_status,local_password_set)
    VALUES ($1,$2,'Synthetic configured full app owner',$3,'admin','[]'::jsonb,true,false,'activated',true)`,
    [owner, identifier, await bcrypt.hash(password, 10)])
  await query('INSERT INTO user_orgs (user_id,org_id,is_active) VALUES ($1,$2,true)', [owner, tenantId])
  await query("INSERT INTO user_roles (user_id,role_id) VALUES ($1,'admin')", [owner])
  const fixture = await seedConfiguredFixture(root, scratch, query, owner, tenantId)
  await configureAutomationFullAppDeployment(scratch, fixture)
  stage('synthetic-fixture-seeded', { platformMigrationCount: migrationCount, sourceRoleCount: 7,
    seededVersions: 0, seededReceipts: 0, b2aArmed: true, b2aRegistrations: 3 })
  const originalFetch = globalThis.fetch
  const syntheticVendor = createYidaMainSyntheticVendor(originalFetch)
  emergencyCleanup.unshift(() => syntheticVendor.close())
  try {
    // Capture only the remote test boundary. Routes/JWT/plugin/worker remain
    // the original compiled main; restore global fetch BEFORE start/login/UI.
    globalThis.fetch = syntheticVendor.fetch
    host = new MetaSheetServer({ port: 0, host: '127.0.0.1',
      pluginDirs: [path.join(root, 'plugins/plugin-integration-core')], manageProcessSignals: false })
  } finally { globalThis.fetch = originalFetch }
  await host.start()
  // The actual compiled index must reference the same initialized manager
  // that real HTTP routes use. Observe it without repairing or initializing it.
  const requiredRoutes = loadCore<ConfiguredDataSourceRoutes>('routes/data-sources.ts')
  const routePath = coreModulePath('routes/data-sources.ts')
  const importedRoutes = await import(pathToFileURL(routePath).href) as ConfiguredDataSourceRoutes
  const requiredManager = requiredRoutes.getDataSourceManager()
  sourceManager = requiredManager as typeof sourceManager
  emergencyCleanup.unshift(() => requiredManager.dispose())
  const importedManager = importedRoutes.getDataSourceManager()
  const indexModule = coreRequire.cache[coreRequire.resolve(coreModulePath('index.ts'))]
  const routeChildren = (indexModule?.children ?? []).filter(module =>
    path.relative(routePath, module.filename.split('?')[0]) === '')
  assert.equal(routeChildren.length, 1, 'APP_CONFIGURED_COMPILED_INDEX_ROUTE_REQUIRED')
  const indexRoutes = routeChildren[0].exports as ConfiguredDataSourceRoutes
  assert.equal(indexRoutes.getDataSourceManager, requiredRoutes.getDataSourceManager,
    'APP_CONFIGURED_COMPILED_INDEX_MANAGER_IDENTITY_INVALID')
  assert.equal(indexRoutes.dataSourceManager, requiredManager,
    'APP_CONFIGURED_COMPILED_INDEX_MANAGER_IDENTITY_INVALID')
  assert.equal(requiredRoutes.getDataSourceManager, importedRoutes.getDataSourceManager,
    'APP_CONFIGURED_COMPILED_MANAGER_IDENTITY_INVALID')
  assert.equal(requiredManager, importedManager, 'APP_CONFIGURED_COMPILED_MANAGER_IDENTITY_INVALID')
  assert.equal(requiredManager.initialized, true, 'APP_CONFIGURED_COMPILED_MANAGER_UNINITIALIZED')
  assert(requiredManager.db !== undefined, 'APP_CONFIGURED_COMPILED_MANAGER_DATABASE_REQUIRED')
  assert.equal(requiredManager.getScope(fixture.connectionId), undefined,
    'APP_CONFIGURED_SOURCE_CONNECTION_MUST_BE_CREATED_BY_HTTP')
  stage('compiled-module-identity-positive-control', {
    sharedInitializedDatabaseBoundManager: true, indexRouteChildCount: 1,
  })
  const { ICollabService } = loadCore<{ ICollabService: unknown }>('di/identifiers.ts')
  const seam = host as unknown as { injector: { get(token: unknown): ObservedCollaboration }; httpServer: HttpServer }
  collaboration = seam.injector.get(ICollabService)
  collabIo = collaboration.getIO() ?? undefined
  hostListener = seam.httpServer
  assert(collabIo)
  const ownedIo = collabIo
  emergencyCleanup.unshift(async () => {
    if (collaboration?.getIO() === ownedIo) {
      ownedIo.disconnectSockets(true)
      await new Promise<void>(resolve => { void ownedIo.close(() => resolve()).catch(() => resolve()) })
    }
  })
  const address = host.getAddress()
  assert(address && typeof address !== 'string' && address.port > 0)
  const origin = `http://127.0.0.1:${address.port}`
  stage('actual-start-resolved')
  assert.equal((await fetch(origin + '/health', { signal: AbortSignal.timeout(10000) })).status, 200)
  const login = await fetch(origin + '/api/auth/login', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier, password }),
    signal: AbortSignal.timeout(10000) })
  assert.equal(login.status, 200)
  const loggedIn = await login.json() as { success: boolean; data: { token: string; user: { id: string; tenantId: string } } }
  assert.equal(loggedIn.success, true)
  assert.equal(loggedIn.data.user.id, owner)
  assert.equal(loggedIn.data.user.tenantId, tenantId)
  const plugins = await fetch(origin + '/api/plugins', {
    headers: { authorization: `Bearer ${loggedIn.data.token}` }, signal: AbortSignal.timeout(10000) })
  assert.equal(plugins.status, 200)
  const pluginState = await plugins.json() as { list: Array<{ name: string; status: string; error?: unknown }>; summary: { failed: number } }
  assert.equal(pluginState.list.length, 1)
  assert.equal(pluginState.list[0].name, fixture.pluginName)
  assert.equal(pluginState.list[0].status, 'active')
  assert(!pluginState.list[0].error)
  assert.equal(pluginState.summary.failed, 0)
  await configureThroughOwnerHttp({ root, origin, token: loggedIn.data.token, databaseUrl: process.env.DATABASE_URL!, fixture, query })
  // One owned-database row makes the real project board reachable. It is not a
  // PLM pull/apply result and is deliberately outside the original preview project.
  const yidaProjectNo = 'SYN-YIDA-PREVIEW'
  assert.notEqual(yidaProjectNo, fixture.projectNo, 'APP_CONFIGURED_YIDA_SEPARATE_PROJECT_REQUIRED')
  assert(fixture.target.fieldIdMap.projectNo && fixture.target.fieldIdMap.active,
    'APP_CONFIGURED_YIDA_TARGET_ROLES_REQUIRED')
  const yidaRowId = randomUUID()
  // A historical inactive row makes this separate project's real board readable
  // without violating the PLM target's one-active-project invariant. The local
  // preview takes explicit synthetic input, never this persisted row's contents.
  await query('INSERT INTO meta_records (id,sheet_id,data,version) VALUES ($1,$2,$3::jsonb,1)',
    [yidaRowId, fixture.target.sheetId, JSON.stringify({
      [fixture.target.fieldIdMap.projectNo]: yidaProjectNo, [fixture.target.fieldIdMap.active]: false,
    })])
  assert.equal((await query('SELECT count(*)::int AS count FROM meta_records WHERE id=$1 AND sheet_id=$2',
    [yidaRowId, fixture.target.sheetId])).rows[0]?.count, 1, 'APP_CONFIGURED_YIDA_FIXTURE_ROW_REQUIRED')
  stage('yida-synthetic-board-ready', { seededTargetRows: 1, seededActiveRows: 0, separateFromPlmProject: true })
  // Separate inactive board for the REAL draft project. Seed before the
  // original business snapshot; never weaken project consent to reuse SYN.
  assert.notEqual(fixture.projectNo, 'DEMO-P1', 'APP_CONFIGURED_YIDA_AUTH_SEPARATE_PROJECT_REQUIRED')
  await query('INSERT INTO meta_records (id,sheet_id,data,version) VALUES ($1,$2,$3::jsonb,1)',
    [randomUUID(), fixture.target.sheetId, JSON.stringify({
      [fixture.target.fieldIdMap.projectNo]: 'DEMO-P1', [fixture.target.fieldIdMap.active]: false,
    })])
  stage('yida-authorization-synthetic-board-ready', { seededTargetRows: 1, seededActiveRows: 0, separateFromPlmProject: true })
  k3 = await createK3FullAppFixture({ root, origin, ownerToken: loggedIn.data.token, ownerId: owner, tenantId, query })
  assert.equal(k3.stats().closed, false, 'APP_CONFIGURED_KTHREE_LISTENER_REQUIRED')
  stage('k3-synthetic-server-ready', { listening: true })
  const { getDataSourceManager } = loadCore<ConfiguredDataSourceRoutes>('routes/data-sources.ts')
  assert.equal(getDataSourceManager().getLoadState(fixture.connectionId), 'loaded')
  stage('real-owner-http-configuration-ready', { realPasswordLogin: true, activePluginCount: 1,
    registeredConnections: 1, registeredExternalSystems: 1, targetEnsured: true,
    sourceBindingSeeded: false, syntheticAdminOwnerOnly: true })
  const { Client } = coreRequire('pg') as { Client: { prototype: object } }
  // Install before the original Automation observer captures client-own query
  // methods; remain inactive until the later exact unknown-row negative case.
  freshQueryObservation = observeUnknownLedger(Client)
  emergencyCleanup.unshift(() => freshQueryObservation?.restore())
  ownerOffQueryObservation = observeYidaOwnerOffQueries(Client)
  emergencyCleanup.unshift(() => ownerOffQueryObservation?.restore())
  await ownerOffQueryObservation.positiveControl(() => query('SELECT count(*)::int AS count FROM integration_yida_draft_rows'))
  automation = await (automationScenario === 'interval' ? createAutomationIntervalFullAppFixture : createAutomationFullAppFixture)({ origin, ownerToken: loggedIn.data.token, fixture, query,
    hostServer: hostListener, hostPool: pool.getInternalPool(),
    reportObservation: data => stage(`${automationStage}-observation`, data),
    reportRecovery: data => stage(`${automationStage}-recovery-ready`, data),
    reportReadiness: data => stage(`${automationStage}-readiness-diagnostic`, { ...data }),
    executorModulePaths: [coreModulePath('integration/automation-read-executor.ts'),
      path.join(root, 'packages/core-backend/src/integration/automation-read-executor.ts')],
    reportExecutorAbort: data => stage('automation-manual-executor-abort-observation', { ...data }),
    reportTick: data => stage('automation-interval-natural-tick', data),
    getAdapter: () => sourceManager?.adapters.get(fixture.connectionId) })
  stage(`${automationStage}-fixture-ready`, automationScenario === 'manual'
    ? { realRuleHttpCreated: true, ruleEditorDomVerified: false, dedicatedOneShotPermit: true, hostProfileRegistered: true, manualOnly: true }
    : { noPrecreatedRule: true, dedicatedOneShotPermit: true, hostProfileRegistered: true, intervalOnly: true })
  const before = await configuredBusinessSnapshot(query, fixture)
  const ownerOffBefore = await ownerOffQueryObservation.suspend(() => ownerOffDatabaseCounts(query))
  stage('yida-owner-default-off-ready', { defaultOff: true, durableTables: 14, durableRowsBefore: 0 })
  // Keep observing through production stop. The isolated browser is a separate
  // process and does not inherit this async hook.
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT'].includes(key.toUpperCase())))
  Object.assign(childEnv, { NODE_ENV: 'production', PLM_FULL_APP_ALLOW_OWN_HTTP: '1', TSX_DISABLE_CACHE: '1',
    PLM_FULL_APP_BLOCK_OPTIONAL_TSX_PIPE: '1', PLM_FULL_APP_PARENT_HTTP_PORT: String(address.port) })
  stage('browser-starting')
  const compiledWebInput = process.env.PLM_FULL_APP_WEB_INPUT_PATH
  assert.equal(compiledWebInput, path.join(scratch, 'compiled-web-input.json'),
    'APP_CONFIGURED_WEB_INPUT_PATH_INVALID')
  const compiledWeb = JSON.parse(await readFile(compiledWebInput, 'utf8'))
  interface BrowserProcessDiagnostics {
    name: string
    ordinal: number
    code: number | null
    signal: NodeJS.Signals | null
    timedOut: boolean
    malformedMarker: boolean
    spawnFailed: boolean
    terminationReason: string
    elapsedMs: number
    complete: boolean
    outputLimitExceeded: boolean
    logs: Record<'stdout' | 'stderr', { path: string; bytes: number; sha256: string; observedBytes: number }>
  }
  interface BrowserProcessCapture {
    accept(stream: 'stdout' | 'stderr', chunk: Buffer): void
    readonly limitExceeded: boolean
    finalize(input: Pick<BrowserProcessDiagnostics, 'code' | 'signal' | 'timedOut' | 'malformedMarker'
      | 'spawnFailed' | 'terminationReason' | 'elapsedMs'>): Promise<BrowserProcessDiagnostics>
  }
  const captureModule: unknown = await import(pathToFileURL(path.join(root,
    'scripts/ops/run-stock-preparation-plm-full-app.mjs')).href)
  assert(captureModule && typeof captureModule === 'object' && 'createOwnedProcessCapture' in captureModule
    && typeof captureModule.createOwnedProcessCapture === 'function', 'APP_BROWSER_RAW_CAPTURE_REQUIRED')
  const createOwnedProcessCapture = captureModule.createOwnedProcessCapture as (input: {
    repoRoot: string; scratchDir: string; name: string; ordinal: number
  }) => Promise<BrowserProcessCapture>
  assert('validateYidaInitializationFailureMarker' in captureModule
    && typeof captureModule.validateYidaInitializationFailureMarker === 'function', 'APP_BROWSER_FAILURE_DECODER_REQUIRED')
  const validateInitializationFailure = captureModule.validateYidaInitializationFailureMarker as
    (value: unknown) => { diagnostic: string; phase: string }
  // This private capture includes opaque result handles, never stdin credentials.
  // Only fixed metadata and hashes may be forwarded to the public stage stream.
  const browserCapture = await createOwnedProcessCapture({ repoRoot: root, scratchDir: scratch,
    name: 'isolated-browser', ordinal: 0 })
  const browserResult = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const browserStartedAt = Date.now()
    const child = spawn(process.execPath, [...namespaceAuthority.namespaceChildArguments(namespaceScope),
      '--require', path.join(root, 'scripts/ops/lib/stock-preparation-plm-network-guard.cjs'),
      '--import', pathToFileURL(coreRequire.resolve('tsx')).href, path.join(root, 'packages/core-backend/tests/utils/stock-preparation-plm-full-app-ui.mts')],
    { env: childEnv, cwd: scratch, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let result: Record<string, unknown> | undefined
    let malformedFrame = false
    let spawnFailed = false
    let inputFailed = false
    let captureFailed = false
    let checkpointSerial = 0
    let authorityCheckpoints = 0
    const checkpointTasks = new Set<Promise<void>>()
    const stopBrowser = () => {
      // Terminate only this owned child; its actual close event remains the
      // authority for exit status and raw-log finalization.
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL') } catch { /* The parent stage still owns its original deadline. */ }
      }
    }
    const acceptStream = (stream: 'stdout' | 'stderr') => {
      // stdout and stderr may split independently; never concatenate fragments
      // from different streams into a private result or public evidence frame.
      const decoder = new StringDecoder('utf8')
      let buffer = ''
      const acceptDecoded = (decoded: string) => {
        buffer += decoded
        if (buffer.length > 1048576) {
          malformedFrame = true
          buffer = ''
          return
        }
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          try {
            if (line.startsWith('PLM_FULL_APP_PROBE ')) console.log(line)
            if (line.startsWith('PLM_FULL_APP_ISOLATION ')) {
              stage('isolated-browser-network', JSON.parse(line.slice('PLM_FULL_APP_ISOLATION '.length)))
            }
            if (line.startsWith('PLM_FULL_APP_UI_CHECKPOINT ')) {
              const frame = JSON.parse(line.slice('PLM_FULL_APP_UI_CHECKPOINT '.length)) as { id: number; command: AutomationCheckpoint }
              assert.deepEqual(Object.keys(frame).sort(), ['command', 'id'])
              assert.equal(frame.id, ++checkpointSerial)
              assert(checkpointSerial <= 126 && checkpointTasks.size === 0)
              const work = (async () => {
                try {
                  assert(automation)
                  const reply = await automation.checkpoint(frame.command)
                  if (!['observe-begin', 'observe-end', 'await-completed'].includes(frame.command.phase)) {
                    authorityCheckpoints += 1
                    stage(`${automationStage}-checkpoint`, { phase: frame.command.phase, verified: true })
                  }
                  child.stdin.write(JSON.stringify({ id: frame.id, ok: true, ...(reply ?? {}) }) + '\n')
                } catch (error) {
                  const message = error instanceof Error ? error.message : ''
                  stage(`${automationStage}-checkpoint-failed`, { diagnostic: /^APP_AUTOMATION_[A-Z_]+/.exec(message)?.[0] ?? 'CHECKPOINT_FAILED' })
                  malformedFrame = true
                  child.stdin.write(JSON.stringify({ id: frame.id, ok: false }) + '\n')
                }
              })()
              checkpointTasks.add(work)
              void work.finally(() => checkpointTasks.delete(work))
            }
            // Private opaque handles must never be forwarded to evidence output.
            if (line.startsWith('PLM_FULL_APP_UI_RESULT ')) {
              assert(!result, 'APP_BROWSER_DUPLICATE_RESULT')
              result = JSON.parse(line.slice('PLM_FULL_APP_UI_RESULT '.length))
              child.stdin.end()
            }
          } catch { malformedFrame = true }
        }
      }
      return {
        accept(chunk: Buffer) {
          try { browserCapture.accept(stream, chunk) } catch {
            captureFailed = true
            stopBrowser()
            return
          }
          if (browserCapture.limitExceeded) {
            stopBrowser()
            return
          }
          acceptDecoded(decoder.write(chunk))
        },
        end() {
          acceptDecoded(decoder.end())
          // The original framed protocol requires a terminating newline. Do
          // not turn a partial final frame into a new successful result path.
          if (buffer.length !== 0) malformedFrame = true
        },
      }
    }
    const streams = { stdout: acceptStream('stdout'), stderr: acceptStream('stderr') }
    child.stdout.on('data', streams.stdout.accept)
    child.stderr.on('data', streams.stderr.accept)
    child.stdin.write(JSON.stringify({ apiOrigin: origin, identifier, password, scratchDir: scratch,
      compiledWeb,
      k3: k3!.browserInput,
      yida: { projectNo: yidaProjectNo },
      automation: { ...automation!.browserInput, scenario: automationScenario },
      tenantId, systemId: fixture.systemId, projectNo: fixture.projectNo, readPlan: fixture.readPlan }) + '\n')
    child.once('error', () => { spawnFailed = true })
    child.stdin.once('error', () => { inputFailed = true; malformedFrame = true; stopBrowser() })
    child.once('close', (code, signal) => {
      void (async () => {
        streams.stdout.end()
        streams.stderr.end()
        // Values-free lifecycle evidence survives native crashes that cannot
        // emit the child's JS catch frame. Raw stderr remains private on disk.
        if (captureFailed) {
          stage('isolated-browser-exit', { code, signal, malformedFrame, hasResult: Boolean(result), captureFailed: true })
          reject(new Error('APP_BROWSER_CAPTURE_FAILED'))
          return
        }
        const terminationReason = spawnFailed ? 'spawn-failure' : browserCapture.limitExceeded ? 'output-limit'
          : inputFailed ? 'input-failure' : signal !== null ? 'signal' : malformedFrame ? 'malformed-marker' : 'exit'
        let diagnostics: BrowserProcessDiagnostics
        try {
          diagnostics = await browserCapture.finalize({ code, signal, timedOut: false,
            malformedMarker: malformedFrame, spawnFailed, terminationReason,
            elapsedMs: Math.max(0, Date.now() - browserStartedAt) })
        } catch {
          stage('isolated-browser-exit', { code, signal, malformedFrame, hasResult: Boolean(result), captureFailed: true })
          reject(new Error('APP_BROWSER_CAPTURE_FAILED'))
          return
        }
        stage('owned-process-diagnostics', { kind: 'isolated-browser', diagnostics })
        stage('isolated-browser-exit', { code, signal, malformedFrame, hasResult: Boolean(result) })
        if (code === 0 && signal === null && !spawnFailed && !captureFailed && !browserCapture.limitExceeded
          && diagnostics.complete === true && diagnostics.outputLimitExceeded === false && !malformedFrame
          && authorityCheckpoints === (automationScenario === 'interval' ? 9 : 5) && checkpointSerial >= 9
          && checkpointSerial <= 126 && checkpointTasks.size === 0 && result?.status === 'passed') resolve(result)
        else reject(new Error('APP_BROWSER_ISOLATED_PROCESS_FAILED'))
      })().catch(() => reject(new Error('APP_BROWSER_CAPTURE_FAILED')))
    })
  })
  const databaseEvidence = await verifyConfiguredBrowserResult(query, fixture, browserResult, before)
  assert(automation, 'APP_AUTOMATION_FIXTURE_REQUIRED')
  const automationResult = browserResult.automation as ConfiguredAutomationBrowserResult
  const automationAuthority = await automation.verify(automationResult)
  automation.dispose()
  assert.deepEqual(await configuredBusinessSnapshot(query, fixture), before, 'APP_AUTOMATION_BUSINESS_CHANGED')
  stage(`${automationStage}-browser-and-authority-verified`, { browser: automationResult.evidence,
    authority: { ...automationAuthority, observationProxiesRestored: true }, businessSnapshotUnchanged: true })
  stage('configured-browser-result', { status: 'passed', counts: browserResult.counts,
    evidence: browserResult.evidence, databaseEvidence })
  const k3Authority = await k3.verifyBrowserResultAndPermissions(browserResult.k3)
  const k3BrowserResult = browserResult.k3 as { evidence: Record<string, boolean | number> }
  stage('k3-browser-and-authority-verified', { browser: k3BrowserResult.evidence, authority: k3Authority })
  assert.deepEqual(await configuredBusinessSnapshot(query, fixture), before, 'APP_CONFIGURED_KTHREE_BUSINESS_CHANGED')
  const yidaResult = browserResult.yida as { evidence: Record<string, unknown>; counts: Record<string, unknown> }
  assert(yidaResult && yidaResult.evidence && yidaResult.counts, 'APP_CONFIGURED_YIDA_RESULT_REQUIRED')
  const yidaEvidence = Object.fromEntries(['realProjectBoardNavigation', 'v1CreatePreview', 'v2CreatePreview',
    'explicitInstanceUpdatePreview', 'renamedLayoutPreview', 'exactProjectAllocation', 'duplicateRowsRejected',
    'invalidNumberRejected', 'ruleExportImportClearsInputs', 'editsClearResults', 'closeReopenClearsInputs',
    'preparationEntryOpensOnlyLocalPreview', 'noBusinessRequests', 'storageSnapshotUnchanged', 'responseStubs', 'storageInjections']
    .map(key => [key, yidaResult.evidence[key]]))
  const yidaCounts = Object.fromEntries(['previewRuns', 'acceptedPreviews', 'rejectedPreviews',
    'localApiRequests', 'backgroundOverviewRequests', 'externalRequests'].map(key => [key, yidaResult.counts[key]]))
  stage('yida-static-browser-verified', { evidence: yidaEvidence, counts: yidaCounts, businessSnapshotUnchanged: true })
  const ownerOffResult = browserResult.yidaOwnerOff as {
    evidence: Record<string, unknown>; counts: Record<string, number>; previewRuns: number; serverCorrelationId: string
  }
  assert(ownerOffResult && typeof ownerOffResult === 'object', 'APP_YIDA_OWNER_OFF_BROWSER_RESULT_REQUIRED')
  assert.deepEqual(Object.keys(ownerOffResult).sort(), ['counts', 'evidence', 'previewRuns', 'serverCorrelationId'])
  assert.deepEqual(ownerOffResult.evidence, { parentPrimaryPreview: true, openingNoBusinessRequests: true,
    realSdkDraftPost: true, exactDisabled403: true, noTargetOperationOrGrant: true,
    errorRetained: true, retryDisabled: true, approvalAndSubmissionAbsent: true })
  assert.equal(ownerOffResult.previewRuns, 1)
  assert.deepEqual(Object.keys(ownerOffResult.counts).sort(), ['backgroundOverviewRequests', 'expectedConsoleErrors',
    'externalRequests', 'openingBusinessRequests', 'otherBusinessRequests', 'ownerPosts', 'ownerResponses'])
  for (const [key, expected] of Object.entries({ ownerPosts: 1, ownerResponses: 1,
    openingBusinessRequests: 0, otherBusinessRequests: 0, externalRequests: 0 })) assert.equal(ownerOffResult.counts[key], expected)
  assert(Number.isSafeInteger(ownerOffResult.counts.backgroundOverviewRequests) && ownerOffResult.counts.backgroundOverviewRequests >= 0)
  assert([0, 1].includes(ownerOffResult.counts.expectedConsoleErrors))
  assert.match(ownerOffResult.serverCorrelationId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u)
  assert.deepEqual(await ownerOffQueryObservation.suspend(() => ownerOffDatabaseCounts(query)), ownerOffBefore,
    'APP_YIDA_OWNER_OFF_BROWSER_DURABLE_CHANGED')
  stage('yida-owner-default-off-verified', { evidence: ownerOffResult.evidence,
    counts: { previewRuns: ownerOffResult.previewRuns, ...ownerOffResult.counts }, durableTables: 14,
    durableRowsAfter: 0, durableSnapshotUnchanged: true,
    queryObservation: ownerOffQueryObservation.verify() })
  const ownerLogProof = await probeYidaOwnerOffLogs(origin, loggedIn.data.token)
  ownerLogProof.serverIds.unshift(ownerOffResult.serverCorrelationId)
  assert.equal(new Set(ownerLogProof.serverIds).size, 4, 'APP_YIDA_OWNER_OFF_DISTINCT_IDS_REQUIRED')
  assert.deepEqual(await ownerOffQueryObservation.suspend(() => ownerOffDatabaseCounts(query)), ownerOffBefore,
    'APP_YIDA_OWNER_OFF_LOG_DURABLE_CHANGED')
  const ownerOffQueryEvidence = ownerOffQueryObservation.verify()
  ownerOffQueryObservation.restore()
  const ownerProofBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, ...ownerLogProof }) + '\n')
  // Private handoff contains opaque IDs and sentinels only, never request URL,
  // headers, body, session token or stored values. The outer owner verifies raw logs after close.
  await writeFile(path.join(scratch, 'yida-owner-log-proof.json'), ownerProofBytes, { flag: 'wx', mode: 0o600 })
  stage('yida-owner-log-http-verified', { counts: { ownerRequests: 3, ownerResponses: 3,
    ordinaryRequests: 1, ordinaryResponses: 1, distinctSentinels: 13, distinctOwnerServerIds: 4 },
    durableSnapshotUnchanged: true, queryObservation: { ...ownerOffQueryEvidence,
      prototypeRestored: true, observerInactive: true }, proofBytes: ownerProofBytes.length,
    proofSha256: createHash('sha256').update(ownerProofBytes).digest('hex') })
  // Independent initialization window begins ONLY after the original OFF query
  // observer and private log proof have closed. Use the managed compiled bootstrap;
  // it owns the anchor barrier and the real host pool owns BEGIN/COMMIT/ROLLBACK.
  const { provisionYidaInitializationAnchor: provisionInitialization } = loadCore<{
    provisionYidaInitializationAnchor: typeof provisionYidaInitializationAnchor
  }>('integration/yida-initialization-bootstrap.ts')
  const initializationTables = ['integration_yida_initialization_anchor', 'integration_yida_initializations'] as const
  const initializationSnapshot = async () => ({ owner: await Promise.all(ownerOffTables.map(async table =>
    (await query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0]?.count)),
    initialization: await Promise.all(initializationTables.map(async table =>
      (await query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0]?.count)) })
  const initializationBefore = await initializationSnapshot()
  assert.deepEqual(initializationBefore, { owner: ownerOffBefore, initialization: [0, 0] },
    'APP_CONFIGURED_YIDA_INIT_EMPTY_DATABASE_REQUIRED')
  const initializationAnchor = await provisionInitialization({ database: {
    transaction: work => pool.transaction(async trx => {
      await trx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      return await work(trx)
    }),
  } }, { ownerId: owner, tenantId })
  assert(initializationAnchor.ownerId === owner && initializationAnchor.tenantId === tenantId
    && initializationAnchor.workspaceId === null, 'APP_CONFIGURED_YIDA_INIT_ANCHOR_PRINCIPAL_INVALID')
  assert.deepEqual(await initializationSnapshot(), { owner: ownerOffBefore, initialization: [1, 0] },
    'APP_CONFIGURED_YIDA_INIT_BOOTSTRAP_ONLY_REQUIRED')
  stage('yida-initialization-ready', { managedBootstrap: true, bootstrapCommitted: true,
    defaultOff: true, separateFromOriginalOffWindow: true, anchorRows: 1, initializationRows: 0 })
  const initializationCapture = await createOwnedProcessCapture({ repoRoot: root, scratchDir: scratch,
    name: 'isolated-browser', ordinal: 1 })
  const initializationResult = await new Promise<Awaited<ReturnType<typeof runYidaInitializationFullApp>>>((resolve, reject) => {
    const started = Date.now()
    const child = spawn(process.execPath, [...namespaceAuthority.namespaceChildArguments(namespaceScope),
      '--require', path.join(root, 'scripts/ops/lib/stock-preparation-plm-network-guard.cjs'),
      '--import', pathToFileURL(coreRequire.resolve('tsx')).href,
      path.join(root, 'packages/core-backend/tests/utils/stock-preparation-yida-initialization-full-app-ui.mts')],
    { env: childEnv, cwd: scratch, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let result: Awaited<ReturnType<typeof runYidaInitializationFullApp>> | undefined
    let malformed = false, spawnFailed = false, captureFailed = false, inputFailed = false, isolationSeen = false
    const stopChild = () => { if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
    emergencyCleanup.unshift(stopChild)
    const stream = (name: 'stdout' | 'stderr') => {
      const decoder = new StringDecoder('utf8'); let buffer = ''
      const accept = (decoded: string) => {
        buffer += decoded
        if (buffer.length > 1048576) { buffer = ''; malformed = true; stopChild(); return }
        const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? ''
        for (const line of lines) {
          try {
            if (line.startsWith('PLM_FULL_APP_YIDA_INIT_RESULT ')) {
              assert(name === 'stdout' && !result, 'APP_CONFIGURED_YIDA_INIT_RESULT_DUPLICATED')
              result = JSON.parse(line.slice('PLM_FULL_APP_YIDA_INIT_RESULT '.length))
            } else if (line.startsWith('PLM_FULL_APP_ISOLATION ')) {
              assert(name === 'stderr' && !isolationSeen)
              const isolation = JSON.parse(line.slice('PLM_FULL_APP_ISOLATION '.length))
              assert.deepEqual(Object.keys(isolation).sort(), ['allowedConnections', 'forbiddenConnections', 'forbiddenEnvReads'])
              assert(isolation.forbiddenConnections === 0 && isolation.forbiddenEnvReads === 0
                && Number.isSafeInteger(isolation.allowedConnections) && isolation.allowedConnections > 0)
              isolationSeen = true
              stage('yida-initialization-browser-network', isolation)
            } else if (line.startsWith('PLM_FULL_APP_PROBE ')) {
              // Only a fixed failure marker is public. Never forward foreign child fields.
              const record = JSON.parse(line.slice('PLM_FULL_APP_PROBE '.length))
              const failure = validateInitializationFailure(record)
              malformed = true; stage('yida-initialization-browser-failed', failure)
            }
          } catch { malformed = true }
        }
      }
      return { chunk(bytes: Buffer) {
        try { initializationCapture.accept(name, bytes) } catch { captureFailed = true; stopChild(); return }
        if (initializationCapture.limitExceeded) { stopChild(); return }
        accept(decoder.write(bytes))
      }, end() { accept(decoder.end()); if (buffer) malformed = true } }
    }
    const streams = { stdout: stream('stdout'), stderr: stream('stderr') }
    child.stdout.on('data', streams.stdout.chunk); child.stderr.on('data', streams.stderr.chunk)
    child.once('error', () => { spawnFailed = true })
    child.stdin.once('error', () => { inputFailed = true; malformed = true; stopChild() })
    const input: YidaInitializationBrowserInput = { apiOrigin: origin, identifier, password, scratchDir: scratch,
      tenantId, ownerId: owner, commandId: initializationAnchor.commandId, projectNo: yidaProjectNo, compiledWeb }
    child.stdin.end(JSON.stringify(input) + '\n')
    child.once('close', (code, signal) => {
      void (async () => {
        streams.stdout.end(); streams.stderr.end()
        assert(!captureFailed, 'APP_CONFIGURED_YIDA_INIT_CAPTURE_FAILED')
        const diagnostics = await initializationCapture.finalize({ code, signal, timedOut: false,
          malformedMarker: malformed, spawnFailed, terminationReason: spawnFailed ? 'spawn-failure'
            : initializationCapture.limitExceeded ? 'output-limit' : inputFailed ? 'input-failure'
              : signal !== null ? 'signal' : malformed ? 'malformed-marker' : 'exit', elapsedMs: Math.max(0, Date.now() - started) })
        stage('owned-process-diagnostics', { kind: 'isolated-browser', diagnostics })
        assert(code === 0 && signal === null && !malformed && !spawnFailed && !inputFailed
          && !initializationCapture.limitExceeded && diagnostics.complete && !diagnostics.outputLimitExceeded
          && isolationSeen && result?.status === 'passed', 'APP_CONFIGURED_YIDA_INIT_CHILD_FAILED')
        resolve(result)
      })().catch(() => reject(new Error('APP_CONFIGURED_YIDA_INIT_CHILD_FAILED')))
    })
  })
  assert.deepEqual(Object.keys(initializationResult).sort(), ['automationOff', 'counts', 'evidence', 'state', 'status'])
  const initialized = initializationResult.state
  assert(initialized.commandId === initializationAnchor.commandId && initialized.status === 'initialized'
    && initialized.canSend === false && initialized.tokenIssued === false && initialized.externalWriteAttempted === false
    && initialized.draft?.rowCount === 2 && initialized.draft.reused === false, 'APP_CONFIGURED_YIDA_INIT_STATE_INVALID')
  const snapshotAfter = await initializationSnapshot()
  // Closed counts include all original fourteen tables plus the two initialization
  // tables. Sending approvals/admissions/ledger/audits must remain empty.
  assert.deepEqual(snapshotAfter.owner, [1, 1, 1, 1, 2, 1, 1, 1, 0, 0, 0, 0, 0, 0],
    'APP_CONFIGURED_YIDA_INIT_DURABLE_COUNTS_INVALID')
  assert.deepEqual(snapshotAfter.initialization, [1, 1], 'APP_CONFIGURED_YIDA_INIT_SINGLE_SLOT_REQUIRED')
  const durable = await query(`SELECT a.command_id,a.owner_id,a.tenant_id,a.workspace_id,
    i.operation_id,t.draft_target_ref,m.status AS material_status,m.generation,o.row_count,
    t.status AS target_status,o.status AS operation_status
    FROM integration_yida_initialization_anchor a JOIN integration_yida_initializations i
      ON i.slot=a.slot AND i.command_id=a.command_id AND i.owner_id=a.owner_id AND i.tenant_id=a.tenant_id AND i.workspace_id IS NULL
    JOIN integration_yida_approved_target t ON t.target_ref=i.target_ref AND t.operation_id=i.operation_id
      AND t.credential_ref=i.credential_ref AND t.credential_generation=i.credential_generation
      AND t.owner_id=a.owner_id AND t.tenant_id=a.tenant_id AND t.workspace_id IS NULL
    JOIN integration_yida_credential_materials m ON m.credential_ref=i.credential_ref AND m.generation=i.credential_generation
      AND m.owner_id=a.owner_id AND m.tenant_id=a.tenant_id AND m.workspace_id IS NULL
    JOIN integration_yida_draft_operations o ON o.operation_id=i.operation_id AND o.target_ref=t.draft_target_ref
    JOIN integration_yida_draft_targets d ON d.target_ref=o.target_ref
      AND d.owner_id=a.owner_id AND d.tenant_id=a.tenant_id AND d.workspace_id IS NULL WHERE a.slot=1`)
  assert.deepEqual(durable.rows, [{ command_id: initializationAnchor.commandId, owner_id: owner, tenant_id: tenantId,
    workspace_id: null, operation_id: initialized.draft.operationId, draft_target_ref: initialized.draft.targetRef,
    material_status: 'current', generation: 1, row_count: 2, target_status: 'manually_confirmed', operation_status: 'unverified' }],
  'APP_CONFIGURED_YIDA_INIT_ACTUAL_DURABLE_CHAIN_INVALID')
  const members = await query('SELECT row_key,ordinal FROM integration_yida_draft_rows WHERE operation_id=$1 ORDER BY ordinal', [initialized.draft.operationId])
  assert.deepEqual(members.rows, initialized.draft.rows.map(row => ({ row_key: row.rowKey, ordinal: row.index })),
    'APP_CONFIGURED_YIDA_INIT_ACTUAL_DURABLE_ROWS_INVALID')
  assert.deepEqual(await configuredBusinessSnapshot(query, fixture), before, 'APP_CONFIGURED_YIDA_INIT_BUSINESS_CHANGED')
  stage('yida-initialization-browser-and-authority-verified', { evidence: initializationResult.evidence,
    counts: initializationResult.counts, authority: { managedAnchorCommitted: true, actualDurableChainMatched: true,
      singleInitialization: true, credentialMaterials: 1, draftOperations: 1, draftRows: 2, approvedTargets: 1,
      sendRows: 0, originalBusinessSnapshotUnchanged: true } })
  const automaticBrowser = initializationResult.automationOff
  assert.deepEqual(automaticBrowser.evidence, { actualPanel: true, openingQuiet: true, actualServerDraftMembers: true,
    actualSdkRuleCreated: true, ruleNotAuthorization: true, twoRowsSelected: true, originalPreviewOff403: true,
    errorRetained: true, approvalAndRequestAbsent: true, responseStubs: 0, storageInjections: 0 })
  assert.deepEqual({ ...automaticBrowser.counts, expectedConsoleErrors: 0 }, { requests: 4, responses: 4, ruleGets: 1,
    rulePosts: 1, initializationGets: 1, previewPosts: 1, expectedConsoleErrors: 0 })
  assert([0, 1].includes(automaticBrowser.counts.expectedConsoleErrors))
  assert.equal(automaticBrowser.rule.sheetId, fixture.target.sheetId)
  assert.deepEqual((await query(`SELECT id,created_by,integration_authority_revision::text AS revision,action_config
    FROM automation_rules WHERE id=$1 AND sheet_id=$2`, [automaticBrowser.rule.id, fixture.target.sheetId])).rows,
  [{ id: automaticBrowser.rule.id, created_by: owner, revision: automaticBrowser.rule.revision,
    action_config: { authorizationSlot: automaticBrowser.rule.slot } }], 'APP_CONFIGURED_YIDA_AUTO_BROWSER_ACTUAL_RULE_REQUIRED')
  assert.deepEqual((await query(`SELECT (SELECT count(*)::int FROM integration_yida_auto_grants) AS grants,
    (SELECT count(*)::int FROM integration_yida_auto_requests) AS requests,
    (SELECT count(*)::int FROM integration_yida_auto_admissions) AS admissions,
    (SELECT count(*)::int FROM integration_yida_delivery_ledger) AS ledgers`)).rows,
  [{ grants: 0, requests: 0, admissions: 0, ledgers: 0 }], 'APP_CONFIGURED_YIDA_AUTO_BROWSER_OFF_DURABLE_REQUIRED')
  stage('yida-automation-default-off-browser-verified', { evidence: automaticBrowser.evidence,
    counts: automaticBrowser.counts, actualRuleMatched: true, grants: 0, requests: 0, admissions: 0, ledgers: 0 })
  // Separate from, and AFTER, every original default-OFF/initialization proof.
  // Keep both send flags OFF; exercise real main/JWT/plugin/shared-loop gates.
  const yidaAutomaticOff = await verifyYidaAutomationMainDefaultOff({ origin, ownerToken: loggedIn.data.token,
    ownerId: owner, tenantId, sheetId: fixture.target.sheetId, currentProjectNo: yidaProjectNo,
    operationId: initialized.draft.operationId, rowKeys: initialized.draft.rows.map(row => row.rowKey), query,
    hashPassword: password => bcrypt.hash(password, 10) })
  assert.deepEqual(await configuredBusinessSnapshot(query, fixture), before, 'APP_CONFIGURED_YIDA_AUTO_BUSINESS_CHANGED')
  stage('yida-automation-default-off-main-verified', yidaAutomaticOff)
  if (yidaCase === 'remaining-unknown') {
    const remaining = await verifyYidaMainRemainingUnknown({ origin, ownerToken: loggedIn.data.token,
      ownerId: owner, tenantId, operationId: initialized.draft.operationId,
      rowKeys: initialized.draft.rows.map(row => row.rowKey), rule: automaticBrowser.rule, query, vendor: syntheticVendor })
    assert.deepEqual(await configuredBusinessSnapshot(query, fixture), before, 'APP_CONFIGURED_YIDA_REMAINING_BUSINESS_CHANGED')
    stage('yida-automation-remaining-unknown-verified', { ...remaining, originalBusinessSnapshotUnchanged: true,
      originalSendFlagsRestored: [undefined, 'false'].includes(process.env.INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED)
        && [undefined, 'false'].includes(process.env.INTEGRATION_YIDA_OWNER_SEND_ENABLED) })
  } else if (automationScenario === 'manual') {
  const yidaSynthetic = await verifyYidaAutomationMainSyntheticExecution({ origin, ownerToken: loggedIn.data.token,
    ownerId: owner, tenantId, operationId: initialized.draft.operationId,
    rowKeys: initialized.draft.rows.map(row => row.rowKey), rule: automaticBrowser.rule, query, vendor: syntheticVendor,
    queryObservation: freshQueryObservation, reportFreshFence: evidence => stage('yida-automation-fresh-consent-fence-verified', evidence),
    report: phase => stage('yida-automation-synthetic-execution-progress', { phase }),
    browserExecute: async () => {
      const result = await runYidaAuthorizationFullApp({ apiOrigin: origin, identifier, password, scratchDir: scratch,
        tenantId, ownerId: owner, commandId: initializationAnchor.commandId, compiledWeb }, root,
      { operationId: initialized.draft!.operationId, rowKeys: initialized.draft!.rows.map(row => row.rowKey), rule: automaticBrowser.rule })
      stage('yida-automation-authorized-browser-verified', { evidence: result.authorization.evidence,
        counts: result.authorization.counts, session: result.evidence, browserAndPreviewServerClosed: true })
      return { grantId: result.authorization.grantId }
    } })
  assert([undefined, 'false'].includes(process.env.INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED))
  assert([undefined, 'false'].includes(process.env.INTEGRATION_YIDA_OWNER_SEND_ENABLED))
  assert.deepEqual(await configuredBusinessSnapshot(query, fixture), before, 'APP_CONFIGURED_YIDA_SYNTHETIC_BUSINESS_CHANGED')
  stage('yida-automation-synthetic-execution-verified', { ...yidaSynthetic, originalSendFlagsRestored: true,
    originalBusinessSnapshotUnchanged: true })
  }
  const sessions = await query('SELECT count(*)::int AS count FROM user_sessions WHERE user_id=$1', [owner])
  assert(typeof sessions.rows[0].count === 'number' && sessions.rows[0].count >= 2)
  stage('real-sessions-persisted', { ownerSetupAndBrowserSessionsPresent: true })
  // A separate, guarded client process retains the exact parent-owned HTTP port
  // through late polling close packets. It must exit naturally after real stop;
  // the server process never relaxes its live-listener network policy.
  const socketChild = spawn(process.execPath, [...namespaceAuthority.namespaceChildArguments(namespaceScope),
    '--require', path.join(root, 'scripts/ops/lib/stock-preparation-plm-network-guard.cjs'),
    '--import', pathToFileURL(coreRequire.resolve('tsx')).href,
    path.join(root, 'packages/core-backend/tests/utils/stock-preparation-plm-full-app-sockets.mts')],
  { env: childEnv, cwd: scratch, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  emergencyCleanup.unshift(() => {
    if (socketChild.pid && socketChild.exitCode === null && socketChild.signalCode === null) socketChild.kill()
  })
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const socketsReady = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  let resolveCompletion!: (result: { disconnects: number; allDisconnected: boolean }) => void
  let rejectCompletion!: (error: Error) => void
  collaborationCompletion = new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject })
  // Completion can fail while the parent is still checking readiness or stopping
  // the host. Observe both immediately; their original rejection remains awaited.
  void socketsReady.catch(() => undefined)
  void collaborationCompletion.catch(() => undefined)
  let readySeen = false, resultSeen = false, isolationSeen = false, socketFailure = false
  let completionTimeout: NodeJS.Timeout | undefined
  const failSockets = (code: string) => {
    socketFailure = true
    clearTimeout(readyTimeout)
    if (completionTimeout) clearTimeout(completionTimeout)
    rejectReady(new Error(code))
    rejectCompletion(new Error(code))
  }
  const readyTimeout = setTimeout(() => failSockets('APP_CONFIGURED_COLLAB_READY_TIMEOUT'), 25000)
  const socketBuffers = { stdout: '', stderr: '' }
  const acceptSocketLine = (line: string, stream: 'stdout' | 'stderr') => {
    const prefix = ['PLM_FULL_APP_SOCKET_READY ', 'PLM_FULL_APP_SOCKET_RESULT ',
      'PLM_FULL_APP_SOCKET_FAILED ', 'PLM_FULL_APP_ISOLATION '].find(value => line.startsWith(value))
    if (!prefix) return
    try {
      assert(!socketFailure)
      const parsed: unknown = JSON.parse(line.slice(prefix.length))
      assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      const record = parsed as Record<string, unknown>
      if (prefix === 'PLM_FULL_APP_SOCKET_READY ') {
        assert(stream === 'stdout' && !readySeen && !collaborationStopStarted)
        assert(record.twoConnected === true && record.connected === 2)
        assert.deepEqual(record.transports, ['websocket', 'polling'])
        readySeen = true
        liveCollaborationClientCount = 2
        clearTimeout(readyTimeout)
        completionTimeout = setTimeout(() => failSockets('APP_CONFIGURED_COLLAB_COMPLETION_TIMEOUT'), 60000)
        stage('isolated-sockets-ready', { liveCollaborationClients: 2, transports: ['websocket', 'polling'] })
        resolveReady()
      } else if (prefix === 'PLM_FULL_APP_SOCKET_RESULT ') {
        assert(stream === 'stdout' && readySeen && !resultSeen && collaborationStopStarted)
        assert(record.twoDisconnected === true && record.disconnects === 2 && record.allDisconnected === true)
        resultSeen = true
      } else if (prefix === 'PLM_FULL_APP_ISOLATION ') {
        assert(stream === 'stderr' && !isolationSeen)
        assert(record.forbiddenConnections === 0 && record.forbiddenEnvReads === 0)
        assert(Number.isSafeInteger(record.allowedConnections) && Number(record.allowedConnections) >= 2)
        isolationSeen = true
        stage('isolated-sockets-network', { forbiddenConnections: 0, forbiddenEnvReads: 0,
          allowedConnections: record.allowedConnections })
      } else {
        failSockets('APP_CONFIGURED_COLLAB_CHILD_FAILED')
      }
    } catch { failSockets('APP_CONFIGURED_COLLAB_CHILD_EVIDENCE_INVALID') }
  }
  const acceptSocketStream = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
    socketBuffers[stream] += chunk.toString()
    if (socketBuffers[stream].length > 1048576) {
      socketBuffers[stream] = ''
      failSockets('APP_CONFIGURED_COLLAB_CHILD_EVIDENCE_INVALID')
      return
    }
    const lines = socketBuffers[stream].split(/\r?\n/)
    socketBuffers[stream] = lines.pop() ?? ''
    for (const line of lines) acceptSocketLine(line, stream)
  }
  socketChild.stdout.on('data', acceptSocketStream('stdout'))
  socketChild.stderr.on('data', acceptSocketStream('stderr'))
  socketChild.once('error', () => failSockets('APP_CONFIGURED_COLLAB_CHILD_START_FAILED'))
  socketChild.stdin.once('error', () => failSockets('APP_CONFIGURED_COLLAB_CHILD_INPUT_FAILED'))
  socketChild.once('close', (code, signal) => {
    for (const stream of ['stdout', 'stderr'] as const) {
      if (socketBuffers[stream]) acceptSocketLine(socketBuffers[stream], stream)
    }
    clearTimeout(readyTimeout)
    if (completionTimeout) clearTimeout(completionTimeout)
    stage('isolated-sockets-exit', { code, signal, readySeen, resultSeen, isolationSeen })
    if (code === 0 && signal === null && readySeen && resultSeen && isolationSeen
      && collaborationStopStarted && !socketFailure) resolveCompletion({ disconnects: 2, allDisconnected: true })
    else failSockets('APP_CONFIGURED_COLLAB_ISOLATED_PROCESS_FAILED')
  })
  socketChild.stdin.end(JSON.stringify({ origin, token: loggedIn.data.token }))
  await socketsReady
  assert.equal(collabIo.engine.clientsCount, 2, 'APP_CONFIGURED_COLLAB_LIVE_CLIENTS_REQUIRED')
  sourceAdapter = sourceManager?.adapters.get(fixture.connectionId)
  assert(sourceAdapter && sourceAdapter.isConnected(), 'APP_CONFIGURED_SOURCE_POOL_POSITIVE_CONTROL_REQUIRED')
  sourcePool = sourceAdapter.pool ?? undefined
  assert(sourcePool && !sourcePool.ended, 'APP_CONFIGURED_SOURCE_POOL_POSITIVE_CONTROL_REQUIRED')
  sourceRegistrationCount = sourceManager?.listDataSources().length
  assert.equal(sourceRegistrationCount, 1, 'APP_CONFIGURED_SOURCE_REGISTRATION_REQUIRED')
  const activeMaintenance = [...timers.values()].filter(({ value }) => {
    const timer = value.deref()
    return timer && !timer._destroyed && Boolean(timer._repeat)
  }).length
  assert(activeMaintenance >= 5, 'APP_CONFIGURED_MAINTENANCE_POSITIVE_CONTROL_REQUIRED')
  stage('production-stop-positive-control', { mainPoolOpen: !pool.getInternalPool().ended,
    httpListenerOpen: hostListener.listening, sourcePoolOpen: true,
    collaborationInitialized: collaboration.getIO() === collabIo, liveCollaborationClients: liveCollaborationClientCount,
    transports: ['websocket', 'polling'], activeMaintenance })
  if (automationScenario === 'interval') {
    // A separate original scenario, not a replacement for the manual page
    // proof. Start last so its held native form reaches REAL stop in budget.
    yidaInFlight = await beginYidaMainInFlightStop({ origin, ownerToken: loggedIn.data.token,
      ownerId: owner, tenantId, operationId: initialized.draft.operationId,
      rowKeys: initialized.draft.rows.map(row => row.rowKey), rule: automaticBrowser.rule, query, vendor: syntheticVendor })
    emergencyCleanup.unshift(() => yidaInFlight?.close())
    assert.deepEqual(await configuredBusinessSnapshot(query, fixture), before, 'APP_CONFIGURED_YIDA_INFLIGHT_BUSINESS_CHANGED')
    stage('yida-automation-natural-interval-verified', yidaInFlight.natural)
    stage('yida-automation-inflight-ready', { ...yidaInFlight.ready, originalBusinessSnapshotUnchanged: true })
  }
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    && /^[A-Z0-9_]{3,80}$/.test(error.code) ? error.code : null
  const message = error instanceof Error ? error.message : ''
  const diagnostic = /^(?:PLM_FULL_APP|APP_BROWSER|APP_CONFIGURED)_[A-Z0-9_]{1,95}/.exec(message)?.[0]
    ?? (/cannot find (?:module|package)/i.test(message) ? 'MODULE_UNAVAILABLE'
      : error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'STARTUP_OR_PROBE_FAILED')
  const frames = (error instanceof Error ? error.stack ?? '' : '').split('\n').flatMap(line => {
    const matched = line.replaceAll('\\', '/').match(/((?:packages|plugins|tmp)\/[A-Za-z0-9_./-]+\.(?:ts|js|cjs|mjs|mts)):(\d+):(\d+)/)
    return matched ? [`${matched[1]}:${matched[2]}`] : []
  }).slice(0, 5)
  stage('failed', { code, diagnostic, frames })
  process.exitCode = 1
} finally {
  try { ownerOffQueryObservation?.restore() }
  catch { stage('yida-owner-query-observer-restore-failed'); process.exitCode = 1 }
  try { freshQueryObservation?.restore() }
  catch { stage('yida-fresh-query-observer-restore-failed'); process.exitCode = 1 }
  try {
    assert(k3, 'APP_CONFIGURED_KTHREE_FIXTURE_REQUIRED')
    await k3.close()
    assert.equal(k3.stats().closed, true, 'APP_CONFIGURED_KTHREE_LISTENER_NOT_CLOSED')
    stage('k3-synthetic-server-closed', { closed: true })
  } catch { stage('k3-synthetic-server-close-failed'); process.exitCode = 1 }
  try { automation?.dispose() } catch { stage(`${automationStage}-observer-close-failed`); process.exitCode = 1 }
  let yidaStopArmed = false
  try {
    if (yidaInFlight) { yidaInFlight.markStopping(); yidaStopArmed = true }
  } catch { yidaInFlight?.close(); stage('yida-automation-inflight-stop-failed', { phase: 'ARM' }); process.exitCode = 1 }
  try {
    assert(host, 'APP_CONFIGURED_HOST_REQUIRED')
    collaborationStopStarted = true
    const stopped = host.stop('PLM_FULL_APP_COMPLETE')
    assert.equal(host.stop('PLM_FULL_APP_REPEAT'), stopped, 'APP_CONFIGURED_STOP_PROMISE_IDENTITY_REQUIRED')
    if (yidaInFlight && yidaStopArmed) {
      yidaStopCheck = yidaInFlight.duringStop(stopped, () => mainPool?.getInternalPool().ended !== false)
      void yidaStopCheck.catch(() => undefined)
    }
    await stopped
    actualStopSucceeded = true
    stage('actual-stop-resolved')
  } catch { stage('actual-stop-failed'); process.exitCode = 1 }
  if (yidaInFlight) {
    try {
      assert(actualStopSucceeded && yidaStopCheck, 'APP_CONFIGURED_YIDA_INFLIGHT_ACTUAL_STOP_REQUIRED')
      await yidaStopCheck
      // The main pool must already be closed. Read the SAME owned database
      // with a separate actual client, then close it before timer assertions.
      assert.equal(mainPool?.getInternalPool().ended, true)
      const { Client } = coreRequire('pg') as typeof import('pg')
      const observer = new Client({ connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 5000, statement_timeout: 5000 })
      try {
        await observer.connect()
        const evidence = await yidaInFlight.verifyAfterStop((sql, values) => observer.query(sql, values))
        assert([undefined, 'false'].includes(process.env.INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED))
        assert([undefined, 'false'].includes(process.env.INTEGRATION_YIDA_OWNER_SEND_ENABLED))
        stage('yida-automation-inflight-stop-verified', { ...evidence, originalSendFlagsRestored: true })
      } finally { await observer.end() }
    } catch {
      yidaInFlight.close(); stage('yida-automation-inflight-stop-failed', { phase: 'VERIFY' }); process.exitCode = 1
    }
  }
  try {
    // Preserve the earlier acceptance failure instead of misreporting a socket
    // child that the failed browser path never reached. This remains a failed
    // stop proof; actual host.stop() above is always attempted independently.
    assert.equal(process.exitCode ?? 0, 0, 'APP_CONFIGURED_PROBE_MUST_PASS_BEFORE_STOP_PROOF')
    assert(collaborationCompletion, 'APP_CONFIGURED_COLLAB_CHILD_REQUIRED')
    const socketResult = await collaborationCompletion
    collaborationDisconnects = socketResult.disconnects
    assert.equal(socketResult.allDisconnected, true, 'APP_CONFIGURED_COLLAB_CLIENTS_REMAIN')
    await new Promise(resolve => setTimeout(resolve, 100))
    await new Promise(resolve => setImmediate(resolve))
    const remaining = [...timers.values()].flatMap(({ value, origin }) => {
      const timer = value.deref()
      return timer && !timer._destroyed && (timer.hasRef() || timer._repeat)
        ? [{ origin, referenced: timer.hasRef(), repeating: Boolean(timer._repeat) }] : []
    })
    stage('post-stop-observed-timers', { timers: remaining })
    assert.equal(mainPool?.getInternalPool().ended, true, 'APP_CONFIGURED_MAIN_POOL_NOT_ENDED')
    assert.equal(hostListener?.listening, false, 'APP_CONFIGURED_HTTP_NOT_CLOSED')
    assert.equal(collaboration?.getIO(), null, 'APP_CONFIGURED_COLLAB_NOT_CLOSED')
    assert.equal(collabIo?.engine.clientsCount, 0, 'APP_CONFIGURED_COLLAB_CLIENTS_REMAIN')
    assert.equal(collaborationDisconnects, 2, 'APP_CONFIGURED_COLLAB_DISCONNECT_REQUIRED')
    assert.equal(sourcePool?.ended, true, 'APP_CONFIGURED_SOURCE_POOL_NOT_ENDED')
    assert.equal(sourceAdapter?.isConnected(), false, 'APP_CONFIGURED_SOURCE_ADAPTER_STILL_CONNECTED')
    assert.equal(sourceManager?.listDataSources().length, sourceRegistrationCount,
      'APP_CONFIGURED_SOURCE_REGISTRATIONS_NOT_PRESERVED')
    assert.equal(sourceManager?.adapters.size, sourceRegistrationCount,
      'APP_CONFIGURED_SOURCE_ADAPTERS_NOT_PRESERVED')
    assert.equal(remaining.length, 0, 'APP_CONFIGURED_MAINTENANCE_REMAINS')
    stage('production-stop-verified', { emergencyCleanupUsed: false, mainPoolEnded: true,
      httpListenerClosed: true, collaborationClosed: true, referencedTimers: 0, maintenanceTimers: 0,
      sourcePoolEnded: true, sourceRegistrationsRetained: true, collaborationDisconnects: 2 })
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    stage('production-stop-failed', { diagnostic: /^APP_CONFIGURED_[A-Z_]+/.exec(message)?.[0] ?? 'STOP_PROOF_FAILED' })
    process.exitCode = 1
  }
  if (process.exitCode) {
    stage('harness-emergency-cleanup', { acceptanceFailed: true })
    for (const action of emergencyCleanup) {
      try { await action() } catch { stage('harness-emergency-cleanup-failed') }
    }
  }
  timerHook.disable()
}
