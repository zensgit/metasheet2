/** Real workbench/HTTP acceptance using a seeded archive, not a production capture/provider. */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { hash } from 'bcryptjs'
import { Pool } from 'pg'
import type { RecoveryArchiveApplicationDatabaseRuntime } from '../src/multitable/recovery-archive-application'
import type { RecoveryArchiveDurableFixture } from '../tests/utils/recovery-archive-durable-fixture'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const web = resolve(repo, 'apps/web')
const output = resolve(repo, 'artifacts/recovery-archive-server')
const runId = randomUUID()
await mkdir(output, { recursive: true })
await writeFile(resolve(output, 'evidence.json'), `${JSON.stringify({ runId, result: 'RUNNING' })}\n`)
const adminUrl = new URL(process.env.TM_ARCHIVE_TEST_ADMIN_URL ?? 'http://invalid')
const pgdata = await realpath(process.env.TM_ARCHIVE_TEST_PGDATA ?? '/invalid')
assert.equal(process.env.NODE_ENV, 'test')
assert.equal(adminUrl.protocol, 'postgresql:')
assert.equal(adminUrl.hostname, '127.0.0.1')
assert.equal(adminUrl.pathname, '/postgres')
assert.equal(adminUrl.username, 'tm_actor_owner')
assert.match(pgdata, /^\/private\/tmp\/tm-recovery-actor-authority-pg-[a-z0-9-]+$/)
assert.ok(adminUrl.port && !['5432', '5433', '5435'].includes(adminUrl.port))
const databaseName = `tm_archive_server_${runId.replaceAll('-', '')}`
const database = new URL(adminUrl)
database.pathname = `/${databaseName}`
const configPath = resolve(output, 'isolated-config.json')
await writeFile(configPath, '{}\n')
const keep = new Set(['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT'])
for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key]
Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: database.href, JWT_SECRET: randomBytes(48).toString('hex'),
  CONFIG_FILE: configPath, SECRET_PROVIDER: 'env', CACHE_TYPE: 'memory',
  SKIP_PLUGINS: 'true', DISABLE_WORKFLOW: 'true', DISABLE_EVENT_BUS: 'true',
  APPROVAL_PROJECTION_SWEEP_DISABLED: '1', APPROVAL_SLA_SCHEDULER_DISABLED: '1',
  WEBHOOK_RETRY_SCHEDULER_DISABLED: '1', MULTITABLE_AI_LEDGER_RETENTION_DISABLED: '1',
  DINGTALK_GROUP_DELIVERY_RETENTION_DISABLED: '1', DINGTALK_DELIVERY_RETENTION_DISABLED: '1',
  METASHEET_ENV_DIR: output,
})
const ports = new Set([Number(database.port)])
const networkErrors: string[] = []
const originalConnect = Socket.prototype.connect
Socket.prototype.connect = new Proxy(originalConnect, {
  apply(target, receiver, args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0]
    const options = typeof first === 'object' && first !== null ? first : { port: first, host: args[1] }
    if (options.path || !['127.0.0.1', '::1', 'localhost'].includes(options.host ?? 'localhost')
      || !ports.has(Number(options.port))) {
      networkErrors.push('UNAPPROVED_SOCKET')
      throw new Error('UNAPPROVED_SOCKET')
    }
    return Reflect.apply(target, receiver, args)
  },
})
assert.throws(() => new Socket().connect({ host: '127.0.0.1', port: 1 }), /UNAPPROVED_SOCKET/)
assert.deepEqual(networkErrors.splice(0), ['UNAPPROVED_SOCKET'])
const admin = new Pool({ connectionString: adminUrl.href, max: 1 })
let created = false
let objectsPath: string | undefined
let app: import('../src/index').MetaSheetServer | undefined
let poolManager: typeof import('../src/integration/db/connection-pool').poolManager | undefined
let cleanupGlobals: (() => Promise<void>) | undefined
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const webRequire = createRequire(resolve(web, 'package.json'))
const { createServer } = await import(pathToFileURL(webRequire.resolve('vite')).href)
let vite: Awaited<ReturnType<typeof createServer>> | undefined
const cases: string[] = []
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const sourcePaths = [
  'packages/core-backend/scripts/verify-recovery-archive-server.mts',
  'packages/core-backend/scripts/tsconfig.recovery-archive-acceptance.json',
  'packages/core-backend/tests/utils/recovery-archive-verified-fixture.ts',
  'packages/core-backend/tests/integration/multitable-recovery-archive-restore-jobs-realdb.test.ts',
  'apps/web/src/multitable/components/RecoveryArchiveModal.vue',
  'apps/web/src/multitable/views/MultitableWorkbench.vue',
]
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [
  path, createHash('sha256').update(await readFile(resolve(repo, path))).digest('hex'),
])))
const dirtyDiffHash = () => createHash('sha256').update(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: repo })).digest('hex')
const evidence: Record<string, unknown> = {
  runId, result: 'RUNNING', sourceHead: git('rev-parse', 'HEAD'), sourceTree: git('rev-parse', 'HEAD^{tree}'),
  worktreeClean: git('status', '--porcelain') === '',
  scriptSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
  sourceHashes: await sourceHashes(), dirtyDiffSha256: dirtyDiffHash(),
  fixture: 'synthetic seeded encrypted archive; test custody and local object store',
  backend: 'MetaSheetServer.start()', cases,
  frontend: 'index.html -> src/main.ts -> real LoginView and MultitableWorkbench',
}
try {
  assert.equal(await realpath((await admin.query('SHOW data_directory')).rows[0].data_directory), pgdata)
  assert.equal((await admin.query('SELECT current_user AS owner')).rows[0].owner, 'tm_actor_owner')
  await admin.query(`CREATE DATABASE "${databaseName}"`)
  created = true
  const migrationLog = openSync(resolve(output, 'migration.log'), 'w')
  try {
    for (const phase of ['fresh', 'replay']) {
      const result = spawnSync('pnpm', ['--filter', '@metasheet/core-backend', 'migrate'], {
        cwd: repo, env: process.env, stdio: ['ignore', migrationLog, migrationLog], timeout: 180_000,
      })
      assert.equal(result.status, 0, `MIGRATION_${phase.toUpperCase()}_FAILED`)
    }
  } finally { closeSync(migrationLog) }
  Object.assign(process.env, {
    MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true', MULTITABLE_ENABLE_WRITER_FENCE: 'true',
    MULTITABLE_HISTORY_CONTIGUITY_STRICT: 'true',
  })
  const [{ MetaSheetServer }, pools, { createRecoveryArchiveWorkerCallbacks },
    { createLocalRecoveryArchiveObjectStoreProvider }, { seedVerifiedArchive },
    { createRecoveryArchiveDurableFixture }, { RECOVERY_AUTHORITY_TRIGGERS }] = await Promise.all([
    import('../src/index'), import('../src/integration/db/connection-pool'), import('../src/routes/univer-meta'),
    import('../src/multitable/recovery-archive-object-store'), import('../tests/utils/recovery-archive-verified-fixture'),
    import('../tests/utils/recovery-archive-durable-fixture'), import('../src/db/migrations/zzzz20260721121000_add_recovery_authority_locks'),
  ])
  poolManager = pools.poolManager
  const { getSafetyGuard } = await import('../src/guards/SafetyGuard')
  const { destroyIdempotency } = await import('../src/guards/idempotency')
  const { messageBus } = await import('../src/integration/messaging/message-bus')
  cleanupGlobals = async () => { if (app) getSafetyGuard().destroy(); destroyIdempotency(); await messageBus.shutdown() }
  const pool = poolManager.get()
  const runtime: RecoveryArchiveApplicationDatabaseRuntime = {
    query: pool.query.bind(pool),
    transaction: (work) => pool.transaction(({ query }) => work(query)),
    transactionDepthProbe: pool.transactionDepthProbe,
  }
  const q = pool.query.bind(pool)
  evidence.migrations = Number((await q('SELECT count(*)::int AS n FROM kysely_migration')).rows[0].n)
  for (const [table, trigger] of RECOVERY_AUTHORITY_TRIGGERS) await q(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)
  objectsPath = await mkdtemp(join(tmpdir(), 'tm-archive-server-objects-'))
  const objectStore = createLocalRecoveryArchiveObjectStoreProvider({ environment: 'test', basePath: objectsPath })
  let durable: RecoveryArchiveDurableFixture | undefined
  let fieldId = ''
  let recordIds: string[] = []
  const fixture = await seedVerifiedArchive({
    prefix: `tm_http_${runId.replaceAll('-', '').slice(0, 8)}`, ...runtime, label: 'standard_server',
    materialize: async (candidate) => {
      fieldId = `fld_${candidate.sheetId}`
      recordIds = Array.from({ length: 5001 }, (_, i) => `${candidate.sheetId}_${i}`)
      const row = (await q('SELECT created_at,expires_at FROM meta_recovery_archives WHERE generation_id=$1::uuid', [candidate.generationId])).rows[0]
      durable = await createRecoveryArchiveDurableFixture({
        binding: {
          archive_generation_id: candidate.generationId, workspace_id: candidate.workspaceId,
          base_id: candidate.baseId, sheet_id: candidate.sheetId, anchor_operation_id: candidate.anchorOperationId,
          anchor_seq: candidate.anchorSeq, checkpoint_id: candidate.checkpointId,
          created_at: new Date(row.created_at as string).toISOString(), expires_at: new Date(row.expires_at as string).toISOString(),
          source_vector_hash: candidate.sourceVectorHash,
        },
        keyId: candidate.keyId, objectStore, transactionDepth: runtime.transactionDepthProbe,
        objectExpiresAt: new Date(row.expires_at as string).toISOString(),
        sectionRows: {
          schema: [{ field_id: fieldId, name: 'Value', type: 'string', property: {}, order: 1 }],
          records: recordIds.map((id, i) => ({ record_id: id, exists: true, version: 1, data: { [fieldId]: `archived-${i}` } })),
          links: [], field_value_tombstones: [], link_tombstones: [], auto_number: [], attachments_index: [], permission_evidence: [], views_config: [],
        },
      })
      return durable
    },
  })
  assert.ok(durable)
  const password = randomBytes(24).toString('hex')
  const readerId = `${fixture.actorId}_reader`
  for (const [id, role, permissions] of [
    [fixture.actorId, 'admin', ['multitable:read', 'multitable:write', 'multitable:share', 'multitable:manage-schema']],
    [readerId, 'user', ['multitable:read']],
  ] as const) {
    await q(`INSERT INTO users (id,email,name,password_hash,role,permissions,is_active,activation_status,local_password_set,must_change_password)
      VALUES ($1,$2,'Archive Tester',$3,$4,$5::jsonb,true,'activated',true,false)`,
    [id, `${id}@example.test`, await hash(password, 10), role, JSON.stringify(permissions)])
  }
  await q('UPDATE meta_bases SET owner_id=$2 WHERE id=$1', [fixture.baseId, fixture.actorId])
  const viewId = `${fixture.sheetId}_view`
  await q(`INSERT INTO meta_views (id,sheet_id,name,type,filter_info,sort_info,group_info,hidden_field_ids,config)
    VALUES ($1,$2,'Archive acceptance','grid','{}','{}','{}','[]','{}')`, [viewId, fixture.sheetId])
  await q('INSERT INTO meta_fields (id,sheet_id,name,type,property,"order") VALUES ($1,$2,\'Value\',\'string\',\'{}\',1)', [fieldId, fixture.sheetId])
  await q(`INSERT INTO meta_records (id,sheet_id,data,version,created_by,modified_by)
    SELECT $1::text || '_' || i::text,$1,jsonb_build_object($2::text,'live-' || i::text),2,$3,$3
    FROM generate_series(0,5000) AS i`, [fixture.sheetId, fieldId, fixture.actorId])
  const callbacks = createRecoveryArchiveWorkerCallbacks(runtime)
  app = new MetaSheetServer({
    port: 0, host: '127.0.0.1', pluginDirs: [],
    createRecoveryArchiveComposition: () => ({
      keyCustody: durable!.keyCustody, objectStore, auditedReplayHorizonMs: 60_000,
      asyncResumeHorizonMs: 600_000, workerIntervalMs: 10,
      worker: { ...callbacks, leaseMs: 60_000, replayHorizonMs: 60_000, maxChunksPerRun: 20, workerOwnerId: 'synthetic-http-worker' },
    }),
  })
  await app.start()
  const address = app.getAddress()
  assert.ok(address && typeof address !== 'string')
  ports.add(address.port)
  const origin = `http://127.0.0.1:${address.port}`
  const request = async (path: string, expected: number, token?: string, body?: unknown) => {
    const response = await fetch(`${origin}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const json = await response.json()
    assert.equal(response.status, expected, `HTTP_STATUS:${path}:${JSON.stringify(json)}`)
    assert.ok(json && typeof json === 'object' && !Array.isArray(json), 'JSON_OBJECT_REQUIRED')
    return json as Record<string, unknown>
  }
  const data = (json: Record<string, unknown>): Record<string, unknown> => {
    assert.ok(json.data && typeof json.data === 'object' && !Array.isArray(json.data), 'DATA_OBJECT_REQUIRED')
    return json.data as Record<string, unknown>
  }
  const login = async (id: string) => {
    const result = data(await request('/auth/login', 200, undefined, { email: `${id}@example.test`, password }))
    assert.equal(typeof result.token, 'string')
    return result.token as string
  }
  const token = await login(fixture.actorId)
  const readerToken = await login(readerId)
  assert.equal((await q('SELECT count(*)::int AS n FROM user_sessions')).rows[0].n, 2)
  const path = `/multitable/sheets/${fixture.sheetId}/recovery-archive`
  await request(`${path}/catalog`, 401)
  await request(`${path}/catalog`, 403, readerToken)
  const catalog = await request(`${path}/catalog`, 200, token)
  const entries = data(catalog).entries
  assert.ok(Array.isArray(entries))
  const entry = entries.find((candidate) => candidate.generationId === fixture.generationId)
  assert.ok(entry)
  assert.equal(typeof entry.recoveryPointAt, 'string')
  cases.push('canonical password login/session; anonymous and reader cannot manage archive')
  process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'false'
  await request(`${path}/catalog`, 503, token)
  process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'true'
  const preview = data(await request(`${path}/preview`, 200, token, {
    generationId: fixture.generationId, mode: 'revert', scope: { kind: 'whole_sheet' },
  }))
  assert.equal(preview.executable, true)
  assert.equal(preview.executionKind, 'async')
  assert.equal((await q('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id=$1 AND version=2', [fixture.sheetId])).rows[0].n, 5001)
  cases.push('flag-off rejection; authenticated preview produces async plan without modifying rows')
  Object.assign(process.env, { VITE_API_URL: origin, VITE_API_BASE: origin })
  vite = await createServer({
    root: web, configFile: resolve(web, 'vite.config.ts'), envDir: output, mode: 'development',
    cacheDir: resolve(output, 'vite-cache'), server: { host: '127.0.0.1', port: 0, strictPort: true },
  })
  await vite.listen()
  const webAddress = vite.httpServer?.address()
  assert.ok(webAddress && typeof webAddress !== 'string')
  ports.add(webAddress.port)
  const webOrigin = `http://127.0.0.1:${webAddress.port}`
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/New_York', locale: 'en-US' })
  context.setDefaultTimeout(30_000)
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (['data:', 'blob:'].includes(url.protocol) || [origin, webOrigin].includes(url.origin)) return route.continue()
    networkErrors.push('UNAPPROVED_BROWSER_REQUEST')
    await route.abort('blockedbyclient')
  })
  await context.routeWebSocket('**/*', (socket) => {
    const url = new URL(socket.url())
    if (url.hostname === '127.0.0.1' && ports.has(Number(url.port))) socket.connectToServer()
    else { networkErrors.push('UNAPPROVED_BROWSER_WEBSOCKET'); socket.close() }
  })
  const page = await context.newPage()
  page.on('pageerror', () => networkErrors.push('BROWSER_PAGE_ERROR'))
  page.on('requestfailed', (req) => networkErrors.push(`BROWSER_REQUEST_FAILED:${new URL(req.url()).pathname}`))
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/api/') && !response.ok()) {
      networkErrors.push(`BROWSER_API_FAILED:${response.request().method()}:${new URL(response.url()).pathname}:${response.status()}`)
    }
  })
  const workbenchPath = `/multitable/${fixture.sheetId}/${viewId}?baseId=${fixture.baseId}`
  await page.goto(`${webOrigin}/login?redirect=${encodeURIComponent(workbenchPath)}`)
  await page.locator('input[autocomplete="username"]').fill(`${fixture.actorId}@example.test`)
  await page.locator('input[autocomplete="current-password"]').fill(password)
  await page.locator('button.login-submit').click()
  await expect(page).toHaveURL(`${webOrigin}${workbenchPath}`)
  await expect(page.getByText('live-0', { exact: true })).toBeVisible()
  assert.equal((await q('SELECT count(*)::int AS n FROM user_sessions')).rows[0].n, 3)
  await page.locator('[data-action="open-archive-recovery"]').click()
  const modal = page.locator('[data-test="archive-recovery-modal"]')
  await expect(modal).toBeVisible()
  const catalogEntry = modal.locator(`[data-test="archive-recovery-entry-${fixture.generationId}"]`)
  const point = new Date(entry.recoveryPointAt)
  const localTime = point.toLocaleString('en-US', { timeZone: 'America/New_York' })
  assert.notEqual(localTime, point.toLocaleString('en-US', { timeZone: 'UTC' }))
  await expect(catalogEntry.locator('.archive-recovery__entry-time')).toHaveText(localTime)
  await catalogEntry.click()
  await modal.locator('[data-test="archive-recovery-mode-revert"]').click()
  await modal.locator('[data-test="archive-recovery-request-preview"]').click()
  await expect(modal.locator('[data-test="archive-recovery-summary"]')).toContainText('5001')
  await expect(modal.locator('[data-test="archive-recovery-async-required"]')).toBeVisible()
  const execute = modal.locator('[data-test="archive-recovery-execute"]')
  await expect(execute).toBeDisabled()
  assert.equal((await q('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id=$1 AND version=2', [fixture.sheetId])).rows[0].n, 5001)
  cases.push('real browser login/catalog in viewer timezone/async preview; confirmation required and preview leaves live rows unchanged')
  await page.screenshot({ path: resolve(output, 'archive-preview-desktop.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(modal.locator('[data-test="archive-recovery-summary"]')).toBeVisible()
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'MOBILE_PREVIEW_OVERFLOW')
  await page.screenshot({ path: resolve(output, 'archive-preview-mobile.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await modal.locator('[data-test="archive-recovery-confirm-input"]').check()
  const acceptResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api${path}/jobs/accept`)
  await execute.click()
  const response = await acceptResponse
  assert.equal(response.status(), 202)
  const accepted = data(await response.json())
  assert.equal(typeof accepted.jobId, 'string')
  await expect(modal.locator('[data-test="archive-recovery-job"]')).toBeVisible()
  await page.reload()
  await expect(page.locator('[data-action="open-archive-recovery"]')).toBeVisible()
  const rediscovered = page.waitForResponse((reply) => new URL(reply.url()).pathname === `/api${path}/jobs`)
  await page.locator('[data-action="open-archive-recovery"]').click()
  assert.ok(JSON.stringify(await (await rediscovered).json()).includes(accepted.jobId as string))
  await expect(modal.locator('[data-test="archive-recovery-job"]')).toBeVisible()
  await expect(modal.locator('[data-test="archive-recovery-job-state"]')).toHaveText(/^(Completed|已完成)$/, { timeout: 300_000 })
  await expect(modal.locator('[data-test="archive-recovery-job-counts"]')).toHaveText('5001 / 5001')
  await expect(modal.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
  cases.push('browser accepted one job; full page reload rediscovers persisted job and reports complete progress')
  await page.screenshot({ path: resolve(output, 'archive-completed-desktop.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  for (const visibleProgress of [
    modal.locator('[data-test="archive-recovery-job-counts"]'),
    modal.getByRole('progressbar'),
    modal.locator('[data-test="archive-recovery-job-outcome"]'),
  ]) {
    await expect(visibleProgress).toBeVisible()
    await expect(visibleProgress).toBeInViewport({ ratio: 1 })
    assert.ok(await visibleProgress.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), 'MOBILE_PROGRESS_CLIPPED')
  }
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'MOBILE_OVERFLOW')
  await page.screenshot({ path: resolve(output, 'archive-completed-mobile.png'), animations: 'disabled' })
  await modal.locator('.archive-recovery__close').click()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await expect(page.getByText('archived-0', { exact: true })).toBeVisible()
  await expect(page.getByText('live-0', { exact: true })).toHaveCount(0)
  assert.equal((await q('SELECT count(*)::int AS n FROM meta_recovery_archive_jobs WHERE sheet_id=$1', [fixture.sheetId])).rows[0].n, 1)
  cases.push('completed recovery refreshes visible workbench values; mobile progress remains readable; only one job exists')
  const deadline = Date.now() + 300_000
  let snapshot = accepted
  while (snapshot.state !== 'done' && Date.now() < deadline) {
    assert.ok(typeof snapshot.state === 'string' && ['planned', 'applying'].includes(snapshot.state), `JOB_STATE:${snapshot.state}`)
    await new Promise((done) => setTimeout(done, 500))
    snapshot = data(await request(`${path}/jobs/${accepted.jobId}`, 200, token))
  }
  assert.equal(snapshot.state, 'done', 'WORKER_COMPLETION_REQUIRED')
  assert.equal(Number(snapshot.completedCount), 5001)
  const restored = await q('SELECT id,data,version FROM meta_records WHERE sheet_id=$1', [fixture.sheetId])
  assert.equal(restored.rows.length, 5001)
  for (const [i, id] of recordIds.entries()) {
    const row = restored.rows.find((item) => item.id === id)
    assert.deepEqual(row?.data, { [fieldId]: `archived-${i}` })
    assert.equal(row?.version, 3)
  }
  let derived = { n: 0, pending: 1 }
  const derivedDeadline = Date.now() + 300_000
  while (Date.now() < derivedDeadline) {
    derived = (await q(`SELECT count(*)::int AS n,count(*) FILTER (WHERE completed_at IS NULL)::int AS pending
      FROM meta_recovery_archive_derived_effects WHERE job_id=$1`, [accepted.jobId])).rows[0] as typeof derived
    if (derived.n === 5001 && derived.pending === 0) break
    await new Promise((done) => setTimeout(done, 500))
  }
  assert.deepEqual(derived, { n: 5001, pending: 0 })
  assert.equal((await q("SELECT count(*)::int AS n FROM meta_record_revisions WHERE sheet_id=$1 AND source='restore'", [fixture.sheetId])).rows[0].n, 5001)
  assert.deepEqual(networkErrors, [])
  assert.equal(git('rev-parse', 'HEAD'), evidence.sourceHead, 'SOURCE_HEAD_CHANGED')
  assert.deepEqual(await sourceHashes(), evidence.sourceHashes, 'SOURCE_FILES_CHANGED')
  assert.equal(dirtyDiffHash(), evidence.dirtyDiffSha256, 'SOURCE_DIFF_CHANGED')
  evidence.restoredCount = 5001
  evidence.derived = derived
  cases.push('browser accepted job restored 5001 rows exactly once through server-owned worker and canonical derived processor')
  evidence.result = 'PASS'
} finally {
  const cleanupErrors: string[] = []
  const clean = async (name: string, work: () => Promise<unknown> | void) => {
    try { await work() } catch { cleanupErrors.push(name) }
  }
  await clean('browser', () => browser?.close())
  await clean('vite', () => vite?.close())
  await clean('server', () => app?.stop('TM_ARCHIVE_SERVER_ACCEPTANCE'))
  await clean('server-address', () => { if (app) assert.equal(app.getAddress(), null) })
  await clean('singletons', () => cleanupGlobals?.())
  await clean('database-pool', () => { if (!app || cleanupErrors.includes('server')) return poolManager?.close() })
  if (created) {
    await clean('database-connections', async () => {
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [databaseName])).rows[0].n, 0)
    })
    await clean('database-drop', () => admin.query(`DROP DATABASE "${databaseName}"`))
    await clean('database-residue', async () => {
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_database WHERE datname=$1', [databaseName])).rows[0].n, 0)
      evidence.databaseResidue = 0
    })
  }
  await clean('objects', async () => { if (objectsPath) await rm(objectsPath, { recursive: true }) })
  await clean('admin-pool', () => admin.end())
  Socket.prototype.connect = originalConnect
  evidence.cleanupErrors = cleanupErrors
  if (evidence.result !== 'PASS' || cleanupErrors.length) evidence.result = 'FAIL'
  await writeFile(resolve(output, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  assert.deepEqual(cleanupErrors, [], 'CLEANUP_FAILED')
}
console.log(`TM_ARCHIVE_SERVER_PASS ${cases.length}`)
