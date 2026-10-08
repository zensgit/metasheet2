/** Explicit local acceptance, NOT a required-CI lane. No supplied database or API URL. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { access, mkdir, mkdtemp, readFile, rm, statfs, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { seedProposal, snapshot, revoke } from './acp1b-browser-realdb-fixture.mts'

const run = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const backend = path.join(root, 'packages/core-backend')
const web = path.join(root, 'apps/web')
const backendRequire = createRequire(path.join(backend, 'package.json'))
const webRequire = createRequire(path.join(web, 'package.json'))
const args = process.argv.slice(2)
const pgBin = args[0]
const mutation = args[1] ?? 'none'
assert(pgBin && path.isAbsolute(pgBin), 'PG_BIN_ABSOLUTE_REQUIRED')
assert(args.length <= 2 && ['none', 'disconnect-apply', 'foreign-tenant'].includes(mutation), 'ARGUMENTS_REFUSED')
for (const key of ['DATABASE_URL', 'ATTENDANCE_TEST_DATABASE_URL', 'PGHOST', 'PGDATABASE', 'REDIS_URL', 'VITE_API_URL', 'VITE_API_BASE']) {
  assert(!process.env[key], 'EXTERNAL_CONFIGURATION_REFUSED')
}
assert.equal(process.cwd(), root, 'RUN_FROM_REPOSITORY_ROOT')
for (const dir of [root]) {
  let present = false
  try { await access(path.join(dir, '.env')); present = true } catch {}
  assert(!present, 'ENV_FILE_REFUSED')
}
// This standalone process never imports ambient integration credentials or flags.
const environmentKeys = new Set(['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'NODE_OPTIONS'])
for (const key of Object.keys(process.env)) if (!environmentKeys.has(key)) delete process.env[key]
for (const binary of ['initdb', 'pg_ctl']) await access(path.join(pgBin, binary))
const disk = await statfs(root)
assert(disk.bavail * disk.bsize > 2 * 1024 ** 3, 'INSUFFICIENT_FREE_DISK')
const nonce = randomUUID().replaceAll('-', '')
const database = `acp_browser_${nonce}`
const runtime = await mkdtemp(path.join(os.tmpdir(), 'acp-browser-pg-'))
const dataDir = path.join(runtime, 'data')
const evidence = path.join(root, 'tmp', `acp-browser-${nonce}`)
await mkdir(evidence, { recursive: true })
await writeFile(path.join(runtime, 'owner'), nonce)
let stage = 'initdb'
let pgStartAttempted = false
let databaseCreated = false
let failed = false
let cleanupFailed = false
let dbPort = 0
let apiPort = 0
let uiPort = 0
const apiStatuses: number[] = []
const browserFaults: string[] = []
const allowedPorts = new Set<number>()
let blockedConnections = 0
net.Socket.prototype.connect = new Proxy(net.Socket.prototype.connect, {
  apply(target, receiver, rawArgs) {
    const args = Array.isArray(rawArgs[0]) ? rawArgs[0] : rawArgs
    const options = args[0]
    const host = typeof options === 'object' ? options.host : args[1]
    const port = typeof options === 'object' ? options.port : options
    if (host !== '127.0.0.1' || !allowedPorts.has(Number(port))) {
      blockedConnections++
      throw new Error('NETWORK_BOUNDARY_REFUSED')
    }
    return Reflect.apply(target, receiver, rawArgs)
  },
})
let server: import('../../../packages/core-backend/src/index').MetaSheetServer | undefined
let vite: import('vite').ViteDevServer | undefined
let browser: import('@playwright/test').Browser | undefined
const { Pool } = backendRequire('pg') as typeof import('pg')
let admin: InstanceType<typeof Pool> | undefined
let pool: InstanceType<typeof Pool> | undefined
const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
// Host/plugin diagnostics may contain IDs or payloads. Acceptance evidence only uses fixed codes/counts.
for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) console[method] = () => {}

async function bounded<T>(action: Promise<T>, milliseconds = 30000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([action, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('ACCEPTANCE_TIMEOUT')), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

async function freePort() {
  const probe = net.createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  assert(address && typeof address !== 'string', 'PORT_ALLOCATION_FAILED')
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  return address.port
}

async function assertPortClosed(port: number) {
  if (!port) return
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.setTimeout(1000)
    socket.once('connect', () => { socket.destroy(); reject(new Error('PORT_RESIDUE')) })
    socket.once('error', (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED' ? resolve() : reject(new Error('PORT_CHECK_FAILED')))
    socket.once('timeout', () => { socket.destroy(); reject(new Error('PORT_CHECK_TIMEOUT')) })
  })
}

try {
  dbPort = await freePort()
  allowedPorts.add(dbPort)
  await run(path.join(pgBin, 'initdb'), ['-D', dataDir, '-U', 'acp_browser', '--auth=trust', '--locale=C', '--encoding=UTF8'], { timeout: 60000 })
  pgStartAttempted = true
  await run(path.join(pgBin, 'pg_ctl'), ['-D', dataDir, '-l', path.join(runtime, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${dbPort} -k ${runtime}`, '-w', '-t', '30', 'start'], { timeout: 40000 })
  admin = new Pool({ host: '127.0.0.1', port: dbPort, user: 'acp_browser', database: 'postgres' })
  assert.equal((await admin.query('SHOW data_directory')).rows[0].data_directory, dataDir)
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE $1', ['acp_browser_%'])).rows[0].n, 0)
  await admin.query(`CREATE DATABASE "${database}"`)
  databaseCreated = true
  const databaseUrl = `postgresql://acp_browser@127.0.0.1:${dbPort}/${database}`
  Object.assign(process.env, { DATABASE_URL: databaseUrl, NODE_ENV: 'test', LOG_LEVEL: 'error',
    JWT_SECRET: randomUUID() + randomUUID(),
    RBAC_BYPASS: 'false', RBAC_TOKEN_TRUST: 'true', SKIP_PLUGINS: 'false', DISABLE_EVENT_BUS: 'true',
    DISABLE_WORKFLOW: 'true', WEBHOOK_RETRY_SCHEDULER_DISABLED: '1' })
  delete process.env.PORT
  stage = 'migrations'
  await run(process.execPath, [backendRequire.resolve('tsx/cli'), 'src/db/migrate.ts'], { cwd: backend, env: process.env, timeout: 180000, maxBuffer: 16 * 1024 ** 2 })
  pool = new Pool({ connectionString: databaseUrl })
  // Seed test-only settings before the real plugin populates its settings cache.
  await pool.query("INSERT INTO system_configs (key, value) VALUES ('attendance.settings', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [JSON.stringify({ attendanceMultitableCleaningPolicy: { enabled: true } })])
  stage = 'real-server'
  const { MetaSheetServer } = await import('../../../packages/core-backend/src/index')
  server = new MetaSheetServer({ host: '127.0.0.1', port: 0, pluginDirs: [path.join(root, 'plugins/plugin-attendance')] })
  await bounded(server.start(), 90000)
  const address = server.getAddress()
  assert(address && typeof address !== 'string', 'SERVER_ADDRESS_MISSING')
  apiPort = address.port
  allowedPorts.add(apiPort)
  const apiOrigin = `http://127.0.0.1:${apiPort}`
  stage = 'fixture'
  const fixture = await seedProposal(pool, apiOrigin, nonce)
  const foreignOrgId = randomUUID()
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_orgs WHERE org_id = $1', [foreignOrgId])).rows[0].n, 0)
  await writeFile(path.join(evidence, 'ownership.json'), JSON.stringify({ nonce, database, orgId: fixture.orgId, foreignOrgId }))
  const { createServer } = webRequire('vite') as typeof import('vite')
  const { default: vue } = await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-vue')).href)
  const { chromium } = webRequire('@playwright/test') as typeof import('@playwright/test')
  const html = `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div><script type="module">
    import { createApp } from 'vue';
    import Section from '/src/views/attendance/AttendanceReportFieldsSection.vue';
    createApp(Section,{orgId:${JSON.stringify(fixture.orgId)},tr:(en,zh)=>zh}).mount('#app');
    </script></body></html>`
  vite = await createServer({ root: web, configFile: false, envFile: false,
    cacheDir: path.join(evidence, 'vite-cache'), plugins: [vue(), {
      name: 'acp-browser-realdb', configureServer(instance) {
        instance.middlewares.use(`/__acp/${nonce}`, async (_request, response, next) => {
          try { response.setHeader('Content-Type', 'text/html'); response.end(await instance.transformIndexHtml(`/__acp/${nonce}`, html)) }
          catch { next(new Error('HARNESS_HTML_FAILED')) }
        })
      },
    }], optimizeDeps: { include: ['vue'] },
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {
      '/api': { target: apiOrigin, changeOrigin: false,
        rewrite: value => mutation === 'disconnect-apply' ? value.replace('/cleaning-apply', '/deliberately-missing-apply') : value,
        configure(proxy) {
          proxy.on('proxyReq', (request, incoming) => {
            if (mutation === 'foreign-tenant' && incoming.url?.endsWith('/cleaning-apply')) request.setHeader('X-Org-Id', foreignOrgId)
          })
        },
      },
    } },
  })
  await vite.listen()
  const uiAddress = vite.httpServer?.address()
  assert(uiAddress && typeof uiAddress !== 'string', 'UI_ADDRESS_MISSING')
  uiPort = uiAddress.port
  allowedPorts.add(uiPort)
  const uiOrigin = `http://127.0.0.1:${uiPort}`
  stage = 'browser'
  browser = await chromium.launch({ headless: true })
  const browserContext = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const unexpected: string[] = []
  // Origin firewall only; same-origin /api always goes to the actual proxy/server.
  await browserContext.route('**/*', route => {
    if (new URL(route.request().url()).origin === uiOrigin) return route.continue()
    unexpected.push('EXTERNAL_REQUEST_BLOCKED')
    return route.abort('blockedbyclient')
  })
  const page = await browserContext.newPage()
  page.setDefaultTimeout(15000)
  await page.addInitScript(({ token }) => localStorage.setItem('auth_token', token), { token: fixture.token })
  const posts: { body: unknown; org: string | undefined; tenant: string | undefined }[] = []
  let deniedPhase = false
  let deniedResponses = 0
  page.on('pageerror', error => { unexpected.push('PAGE_ERROR'); browserFaults.push(error.name) })
  browserContext.on('requestfailed', () => unexpected.push('REQUEST_FAILED'))
  browserContext.on('request', request => {
    const target = new URL(request.url())
    if (target.origin !== uiOrigin) unexpected.push('UNEXPECTED_ORIGIN')
    if (target.pathname.endsWith('/cleaning-apply')) posts.push({ body: request.postDataJSON(), org: request.headers()['x-org-id'], tenant: request.headers()['x-tenant-id'] })
  })
  browserContext.on('response', response => {
    if (!new URL(response.url()).pathname.startsWith('/api/')) return
    apiStatuses.push(response.status())
    if (response.status() >= 200 && response.status() < 300) return
    if (deniedPhase && response.url().endsWith('/cleaning-apply') && response.status() === 403) deniedResponses++
    else unexpected.push('UNEXPECTED_API_STATUS')
  })
  // No response fixtures or application API replacement: Vite only forwards HTTP.
  stage = 'browser-navigation'
  const metadataResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/attendance/report-fields')
  await page.goto(`${uiOrigin}/__acp/${nonce}`)
  stage = 'metadata-descriptor'
  const metadata = await (await metadataResponse).json()
  assert.equal(metadata.data?.cleaningReview?.enabled, true, 'DESCRIPTOR_DISABLED')
  assert.equal(metadata.data.cleaningReview.orgId, fixture.orgId, 'DESCRIPTOR_TENANT')
  assert.equal(metadata.data.cleaningReview.sheetId, fixture.sheetId, 'DESCRIPTOR_SHEET')
  stage = 'browser-load-proposals'
  await page.locator('[data-cleaning-load]').click()
  stage = 'browser-review-proposal'
  await page.locator('[data-cleaning-review]').click()
  const before = await snapshot(pool, fixture)
  assert.equal(posts.length, 0, 'PRECONFIRM_POST')
  assert.equal(before.edits, 0, 'PRECONFIRM_WRITE')
  assert.equal(before.canonical.status, 'late')
  assert.equal(before.operations, 0)
  assert.equal(before.manualOverrideCalculations, 0)
  assert.equal(before.events, 0)
  await page.screenshot({ path: path.join(evidence, 'desktop-review.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: path.join(evidence, 'narrow-review.png') })
  const applied = page.waitForResponse(response => response.url().endsWith('/cleaning-apply'))
  await page.locator('[data-cleaning-confirm]').click()
  stage = 'APPLY_HTTP_STATUS'
  const applyResponse = await applied
  if (applyResponse.status() !== 200) {
    const payload = await applyResponse.json().catch(() => null)
    const code = payload?.error?.code
    output({ applyStatus: applyResponse.status(), code: typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : 'UNCLASSIFIED', blockedConnections })
    assert.deepEqual(await snapshot(pool, fixture), before, 'REFUSED_APPLY_WROTE_DATA')
    output({ refusedApplyZeroWrite: true })
  }
  assert.equal(applyResponse.status(), 200, 'APPLY_HTTP_STATUS')
  stage = 'positive-oracles'
  await page.getByRole('status').filter({ hasText: '考勤已更新，建议已处理' }).waitFor()
  assert.equal(await page.locator('[data-cleaning-review]').count(), 0)
  assert.deepEqual(posts, [{ body: { expectedVersion: 1 }, org: fixture.orgId, tenant: fixture.orgId }])
  const after = await snapshot(pool, fixture)
  assert.equal(after.canonical.status, 'normal')
  assert.equal(after.edits, 1)
  assert.equal(after.operations, 1)
  assert.equal(after.completedOperations, 1)
  assert.equal(after.manualOverrideCalculations, 1)
  assert.equal(after.events, 1)
  assert.equal(after.notified, 0)
  assert.equal(after.projection.data[fixture.physical('cleaning_requested')], false)
  assert.equal(after.projection.data[fixture.physical('cleaning_reason')], null)
  assert.equal(after.projection.data.custom_keep, nonce)
  await page.screenshot({ path: path.join(evidence, 'narrow-consumed.png') })
  // A later proposal is reviewed, then membership is revoked before confirmation.
  stage = 'revocation'
  await page.close()
  const deniedPage = await browserContext.newPage()
  deniedPage.setDefaultTimeout(15000)
  // Same real component and actor, with a fresh browser document.
  await deniedPage.addInitScript(({ token }) => localStorage.setItem('auth_token', token), { token: fixture.token })
  // Keep the original actor/proposal for the denied request by restoring only the
  // consumed proposal fields locally, then anchor refresh is unnecessary: auth must reject first.
  await pool.query('UPDATE meta_records SET data = data || $1::jsonb, version = version + 1 WHERE id = $2',
    [JSON.stringify({ [fixture.physical('cleaning_requested')]: true, [fixture.physical('cleaning_reason')]: 'synthetic revoke control' }), fixture.projectionId])
  await deniedPage.goto(`${uiOrigin}/__acp/${nonce}`)
  await deniedPage.locator('[data-cleaning-load]').click()
  await deniedPage.locator('[data-cleaning-review]').click()
  const deniedBefore = await snapshot(pool, fixture)
  await revoke(pool, fixture)
  deniedPhase = true
  deniedPage.on('pageerror', () => unexpected.push('DENIED_PAGE_ERROR'))
  const refusal = deniedPage.waitForResponse(response => response.url().endsWith('/cleaning-apply'))
  await deniedPage.locator('[data-cleaning-confirm]').click()
  assert.equal((await refusal).status(), 403, 'REVOCATION_STATUS')
  assert.equal(posts.length, 2)
  assert.deepEqual(posts[1], { body: { expectedVersion: deniedBefore.projection.version }, org: fixture.orgId, tenant: fixture.orgId })
  assert.deepEqual(await snapshot(pool, fixture), deniedBefore, 'REVOCATION_WROTE_DATA')
  assert.equal(deniedResponses, 1)
  assert.deepEqual(unexpected, [])
  assert.equal(blockedConnections, 0, 'UNEXPECTED_BACKEND_NETWORK')
  await deniedPage.getByRole('status').filter({ hasText: '未确认更正结果' }).waitFor()
  await deniedPage.screenshot({ path: path.join(evidence, 'desktop-denied.png') })
  stage = 'PASS'
  output({ result: 'PASS', desktop: true, narrow: true, apiResponseReplacement: false, revokedZeroWrite: true })
} catch (error) {
  failed = true
  const failedPage = browser?.contexts()[0]?.pages()[0]
  if (failedPage) await failedPage.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => undefined)
  const code = (error as { code?: unknown }).code
  output({ result: 'FAIL', stage, apiStatuses, browserFaults, code: typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'ACCEPTANCE_ERROR' })
} finally {
  async function cleanupStep(name: string, action: () => Promise<unknown>) {
    try { await bounded(action()) }
    catch { cleanupFailed = true; output({ cleanupStep: name, result: 'FAIL' }) }
  }
  await cleanupStep('browser', async () => browser?.close())
  await cleanupStep('vite', async () => vite?.close())
  await cleanupStep('server', async () => server?.stop())
  await cleanupStep('pool', async () => pool?.end())
  await cleanupStep('database', async () => {
    if (admin && databaseCreated) {
      assert.equal(await readFile(path.join(runtime, 'owner'), 'utf8'), nonce)
      assert.equal((await admin.query('SHOW data_directory')).rows[0].data_directory, dataDir)
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1', [database])).rows[0].n, 0, 'DATABASE_BACKENDS_REMAIN')
      await admin.query(`DROP DATABASE "${database}"`)
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE $1', ['acp_browser_%'])).rows[0].n, 0)
    }
  })
  await cleanupStep('admin', async () => admin?.end())
  await cleanupStep('postgres', async () => {
    if (!pgStartAttempted) return
    assert.equal(await readFile(path.join(runtime, 'owner'), 'utf8'), nonce)
    // -D is always this invocation's mkdtemp; never a supplied/shared cluster.
    let running = false
    try { await run(path.join(pgBin, 'pg_ctl'), ['-D', dataDir, 'status'], { timeout: 5000 }); running = true }
    catch (error) { assert.equal((error as { code?: number }).code, 3, 'POSTGRES_STATUS_UNKNOWN') }
    if (running) await run(path.join(pgBin, 'pg_ctl'), ['-D', dataDir, '-m', 'fast', '-w', '-t', '20', 'stop'], { timeout: 25000 })
  })
  await cleanupStep('residue', async () => {
    await assertPortClosed(dbPort)
    await assertPortClosed(apiPort)
    await assertPortClosed(uiPort)
    assert.equal(await readFile(path.join(runtime, 'owner'), 'utf8'), nonce)
    if (!cleanupFailed) await rm(runtime, { recursive: true })
  })
  output(cleanupFailed ? { cleanup: 'FAIL' } : { cleanup: 'PASS', databases: 0, backends: 0, ports: 0 })
  process.exit(failed || cleanupFailed ? 1 : 0)
}
