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
import { snapshot, revoke } from './acp1b-browser-realdb-fixture.mts'
import { seedCanonical, seedForeignCanary, seedSheetSetupActor, snapshotActorAuthority } from './acp1b-full-app-realdb-fixture.mts'

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
assert(args.length <= 2 && ['none', 'disconnect-apply', 'foreign-tenant', 'response-timeout'].includes(mutation), 'ARGUMENTS_REFUSED')
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
const database = `acp_full_${nonce}`
const runtime = await mkdtemp(path.join(os.tmpdir(), 'acp-full-pg-'))
const dataDir = path.join(runtime, 'data')
const evidence = path.join(root, 'tmp', `acp-full-${nonce}`)
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
const apiFailures = new Map<string, number>()
const unknownApiShapes = new Set<string>()
function observeApiResponse(response: import('@playwright/test').Response) {
  const pathname = new URL(response.url()).pathname
  if (!pathname.startsWith('/api/')) return
  apiStatuses.push(response.status())
  if (response.status() < 400) return
  const routes: [RegExp, string][] = [
    [/^\/api\/comments$/, 'comments-read'],
    [/^\/api\/comments\/summary$/, 'comments-summary'],
    [/^\/api\/comments\/mention-summary$/, 'comments-mention-summary'],
    [/^\/api\/comments\/inbox$/, 'comments-inbox'],
    [/^\/api\/comments\/unread-count$/, 'comments-unread-count'],
    [/^\/api\/comments\/mention-candidates$/, 'comments-mention-candidates'],
    [/^\/api\/multitable\/[^/]+\/comments\/presence$/, 'comments-presence'],
    [/^\/api\/multitable\/record-subscription-notifications(?:\/unread-count)?$/, 'record-subscription-notifications'],
    [/^\/api\/multitable\/sheets\/[^/]+\/records\/[^/]+\/permissions$/, 'record-permissions'],
    [/^\/api\/multitable\/sheets\/[^/]+\/records\/[^/]+\/subscriptions$/, 'record-subscriptions'],
    [/^\/api\/multitable\/sheets\/[^/]+\/field-permissions$/, 'field-permissions'],
    [/^\/api\/multitable\/sheets\/[^/]+\/permissions$/, 'sheet-permissions'],
    [/^\/api\/multitable\/views\/[^/]+\/permissions$/, 'view-permissions'],
    [/^\/api\/attendance\/report-records\/[^/]+\/cleaning-apply$/, 'cleaning-apply'],
    [/^\/api\/attendance\/records$/, 'attendance-records'],
    [/^\/api\/attendance\/reports\/requests$/, 'attendance-request-report'],
    [/^\/api\/attendance\/summary$/, 'attendance-summary'],
    [/^\/api\/attendance\/requests$/, 'attendance-requests'],
    [/^\/api\/attendance\/anomalies$/, 'attendance-anomalies'],
    [/^\/api\/attendance\/holidays$/, 'attendance-holidays'],
    [/^\/api\/multitable\/ai\/readiness$/, 'ai-readiness'],
    [/^\/api\/multitable\/sheets\/[^/]+\/records\/[^/]+\/history$/, 'record-history'],
  ]
  const label = routes.find(([pattern]) => pattern.test(pathname))?.[1] ?? 'UNCLASSIFIED'
  if (label === 'UNCLASSIFIED') {
    const literals = new Set(['api', 'attendance', 'multitable', 'auth', 'records', 'calendar', 'settings', 'summary', 'reports', 'requests', 'users', 'me', 'profile', 'self', 'permissions', 'groups', 'current', 'effective', 'schedule', 'workbench', 'context', 'comments', 'presence', 'history', 'subscriptions'])
    unknownApiShapes.add(pathname.split('/').map(part => literals.has(part) ? part : '_').join('/'))
  }
  // Only fixed route labels and stage codes, never supplied path/query/body values.
  const key = `${stage}:${label}:${response.status()}`
  apiFailures.set(key, (apiFailures.get(key) ?? 0) + 1)
}
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

// Start observing rejection immediately, even while its triggering UI action
// is still pending. The caller must unwrap it; failures remain failures.
function observed<T>(promise: Promise<T>): () => Promise<T> {
  const settled = promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
  return async () => {
    const outcome = await settled
    if (outcome.ok === false) throw outcome.error
    return outcome.value
  }
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
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE $1', ['acp_full_%'])).rows[0].n, 0)
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
  const canonical = await seedCanonical(pool, nonce)
  process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = canonical.orgId
  const foreignOrgId = randomUUID()
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_orgs WHERE org_id = $1', [foreignOrgId])).rows[0].n, 0)
  await writeFile(path.join(evidence, 'ownership.json'), JSON.stringify({ nonce, database, orgId: canonical.orgId, foreignOrgId }))
  const { createServer } = webRequire('vite') as typeof import('vite')
  const { default: vue } = await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-vue')).href)
  const { chromium } = webRequire('@playwright/test') as typeof import('@playwright/test')
  // Serve the actual index.html/main.ts/router, not a component fixture.
  vite = await createServer({ root: web, configFile: false, envFile: false,
    cacheDir: path.join(evidence, 'vite-cache'), plugins: [vue()],
    resolve: { alias: { '@': path.join(web, 'src') } },
    optimizeDeps: { include: ['vue', 'vue-router', 'pinia'] },
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
  const posts: { body: unknown; org: string | undefined; tenant: string | undefined }[] = []
  browserContext.on('page', opened => opened.on('pageerror', error => browserFaults.push(error.name)))
  page.on('pageerror', error => browserFaults.push(error.name))
  browserContext.on('request', request => {
    if (new URL(request.url()).pathname.endsWith('/cleaning-apply')) {
      posts.push({ body: request.postDataJSON(), org: request.headers()['x-org-id'], tenant: request.headers()['x-tenant-id'] })
    }
  })
  browserContext.on('response', observeApiResponse)
  stage = 'real-login'
  const attendancePath = '/attendance?tab=admin&section=attendance-admin-report-fields'
  await page.goto(uiOrigin + '/login?redirect=' + encodeURIComponent(attendancePath))
  await page.locator('input[autocomplete="username"]').fill(canonical.email)
  await page.locator('input[autocomplete="current-password"]').fill(canonical.password)
  if (mutation === 'response-timeout') {
    stage = 'response-timeout-control'
    const timedOut = observed(page.waitForResponse(response => new URL(response.url()).pathname === '/deliberately-absent-response', { timeout: 100 }))
    // Wait for a local page task longer than the response deadline; this is a
    // deterministic lifecycle negative, not synchronization for product data.
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 250)))
    await timedOut()
    assert.fail('RESPONSE_TIMEOUT_NOT_DETECTED')
  }
  const loginWait = observed(page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login'))
  await page.locator('.login-submit').click()
  const loginResponse = await loginWait()
  assert.equal(loginResponse.status(), 200, 'LOGIN_STATUS')
  const login = await loginResponse.json()
  assert.equal(login.success, true, 'LOGIN_FAILED')
  const token: string = login.data.token
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
  assert.equal(claims.tenantId, canonical.orgId, 'LOGIN_TENANT')
  await page.waitForURL(url => url.pathname === '/attendance')
  stage = 'ui-tenant-context'
  // Admin mode shows the scoped report project; the Org ID input belongs to Reports.
  await page.locator('.attendance-report-fields .attendance__section-meta code').waitFor()
  assert.equal(await page.locator('.attendance-report-fields .attendance__section-meta code').textContent(), canonical.orgId + ':attendance', 'UI_TENANT')
  await page.screenshot({ path: path.join(evidence, 'desktop-attendance.png') })

  stage = 'ui-catalog-sync'
  const catalogWait = observed(page.waitForResponse(response => new URL(response.url()).pathname === '/api/attendance/report-fields/sync'))
  await page.getByRole('button', { name: 'Sync catalog', exact: true }).click()
  const catalogResponse = await catalogWait()
  assert.equal(catalogResponse.status(), 200, 'CATALOG_SYNC_STATUS')
  const catalogBody = await catalogResponse.json()
  assert.equal(catalogBody.ok, true, 'CATALOG_SYNC_FAILED')
  assert.equal(catalogBody.data.multitable.available, true, 'CATALOG_UNAVAILABLE')

  stage = 'ui-report-sync'
  await page.locator('[data-report-record-sync-from]').fill(canonical.workDate)
  await page.locator('[data-report-record-sync-to]').fill(canonical.workDate)
  await page.locator('[data-report-record-sync-user]').fill(canonical.userId)
  const syncWait = observed(page.waitForResponse(response => new URL(response.url()).pathname === '/api/attendance/report-records/sync'))
  await page.locator('[data-report-record-sync-button]').click()
  const syncResponse = await syncWait()
  assert.equal(syncResponse.status(), 200, 'SYNC_STATUS')
  const syncBody = await syncResponse.json()
  assert.equal(syncBody.ok, true, 'SYNC_FAILED')
  assert.notEqual(syncBody.data.degraded, true, 'SYNC_DEGRADED')
  const sheetId: string = syncBody.data.multitable.sheetId
  const projection = await pool.query('SELECT id, data FROM meta_records WHERE sheet_id = $1', [sheetId])
  assert.equal(projection.rows.length, 1, 'SYNC_PROJECTION_COUNT')
  const fields = (await pool.query('SELECT id, name FROM meta_fields WHERE sheet_id = $1', [sheetId])).rows as {id: string; name: string}[]
  const { getObjectFieldId } = await import('../../../packages/core-backend/src/multitable/provisioning')
  const physical = (code: string) => getObjectFieldId(canonical.orgId + ':attendance', 'attendance_report_records', code)
  const fixture = { ...canonical, token, sheetId, projectionId: projection.rows[0].id as string, physical, data: projection.rows[0].data }
  const beforeProposal = await snapshot(pool, fixture)
  assert.equal(beforeProposal.edits, 0, 'SYNC_CORRECTION_WRITE')
  assert.equal(beforeProposal.projection.data[physical('cleaning_requested')] === true, false, 'PRESEEDED_PROPOSAL')

  stage = 'real-multitable-popup'
  const popupWait = observed(page.waitForEvent('popup'))
  await page.locator('[data-report-record-open-multitable]').click()
  const table = await popupWait()
  table.setDefaultTimeout(20000)
  await table.getByRole('grid').waitFor()
  stage = 'custom-field-setup'
  const reviewAuthority = await snapshotActorAuthority(pool, canonical.userId)
  const setupActor = await seedSheetSetupActor(pool, canonical.orgId, sheetId)
  const setupAuthority = await snapshotActorAuthority(pool, setupActor.userId)
  assert.equal(setupAuthority.roles.length, 0, 'SETUP_ROLE_EXPANSION')
  assert.equal(setupAuthority.permissions.length, 0, 'SETUP_GLOBAL_PERMISSION')
  assert.deepEqual(setupAuthority.sheets, [{ sheet_id: sheetId, perm_code: 'multitable:write' }], 'SETUP_SCOPE_EXPANSION')
  assert.deepEqual(setupAuthority.memberships, [{ org_id: canonical.orgId, is_active: true }], 'SETUP_TENANT_EXPANSION')
  const setupContext = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  setupContext.on('response', observeApiResponse)
  await setupContext.route('**/*', route => {
    if (new URL(route.request().url()).origin === uiOrigin) return route.continue()
    unexpected.push('SETUP_EXTERNAL_REQUEST_BLOCKED')
    return route.abort('blockedbyclient')
  })
  const setupPage = await setupContext.newPage()
  setupPage.setDefaultTimeout(20000)
  const customName = `Synthetic note ${nonce}`
  stage = 'setup-login'
  await setupPage.goto(uiOrigin + '/login?redirect=' + encodeURIComponent(new URL(table.url()).pathname + new URL(table.url()).search))
  await setupPage.locator('input[autocomplete="username"]').fill(setupActor.email)
  await setupPage.locator('input[autocomplete="current-password"]').fill(setupActor.password)
  const setupLoginWait = observed(setupPage.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login'))
  await setupPage.locator('.login-submit').click()
  assert.equal((await setupLoginWait()).status(), 200, 'SETUP_LOGIN_FAILED')
  stage = 'setup-grid-entry'
  await setupPage.getByRole('grid').waitFor()
  stage = 'setup-fields-open'
  await setupPage.locator('button.mt-workbench__mgr-btn').filter({ hasText: 'Fields' }).click()
  stage = 'setup-field-form'
  await setupPage.locator('.meta-field-mgr__add-row input').fill(customName)
  await setupPage.locator('.meta-field-mgr__add-row select').selectOption('string')
  const createWait = observed(setupPage.waitForResponse(response => new URL(response.url()).pathname === '/api/multitable/fields' && response.request().method() === 'POST'))
  await setupPage.locator('.meta-field-mgr__add-row .meta-field-mgr__btn-add').click()
  stage = 'setup-field-response'
  assert.equal((await createWait()).status(), 201, 'CUSTOM_FIELD_CREATE_STATUS')
  const customRows = await pool.query('SELECT id, type FROM meta_fields WHERE sheet_id = $1 AND name = $2', [sheetId, customName])
  assert.equal(customRows.rows.length, 1, 'CUSTOM_FIELD_COUNT')
  assert.equal(customRows.rows[0].type, 'string', 'CUSTOM_FIELD_TYPE')
  const customId: string = customRows.rows[0].id
  await setupPage.screenshot({ path: path.join(evidence, 'setup-custom-field.png') })
  await setupContext.close()
  await pool.query("DELETE FROM spreadsheet_permissions WHERE sheet_id = $1 AND subject_type = 'user' AND subject_id = $2", [sheetId, setupActor.userId])
  await pool.query('UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2', [setupActor.userId, canonical.orgId])
  assert.deepEqual(await snapshotActorAuthority(pool, canonical.userId), reviewAuthority, 'REVIEW_AUTHORITY_CHANGED')
  await table.reload()
  stage = 'custom-grid-reload'
  await table.getByRole('grid').waitFor()
  const customClose = table.locator('.meta-record-drawer__close')
  if (await customClose.isVisible()) await customClose.click()
  const customCell = table.getByRole('gridcell', { name: customName, exact: true }).first()
  stage = 'custom-grid-edit'
  // The far-right cell is covered by the Inspector opened by the first click;
  // use the existing keyboard edit path after closing that selected-row panel.
  await customCell.click()
  await table.locator('.meta-record-drawer__fields').waitFor()
  await customClose.click()
  await table.getByRole('grid').press('Enter')
  await customCell.locator('input,textarea').waitFor()
  const customValue = `Synthetic retained value ${nonce}`
  const [customPatched] = await Promise.all([
    table.waitForResponse(response => new URL(response.url()).pathname === '/api/multitable/patch'),
    (async () => {
      await customCell.locator('input,textarea').fill(customValue)
      await customCell.locator('input,textarea').press('Enter')
    })(),
  ])
  assert.equal(customPatched.status(), 200, 'CUSTOM_GRID_PATCH_STATUS')
  assert.equal((await snapshot(pool, fixture)).projection.data[customId], customValue, 'CUSTOM_GRID_VALUE')
  output({ setupUiCreatedField: true, setupGlobalPermissions: 0, setupRoles: 0, reviewAuthorityUnchanged: true })
  const edit = async (code: string, value: string | boolean) => {
    const closeInspector = table.locator('.meta-record-drawer__close')
    if ((table.viewportSize()?.width ?? 1280) > 390 && await closeInspector.isVisible()) await closeInspector.click()
    const field = fields.find(item => item.id === physical(code))
    assert(field, 'PHYSICAL_FIELD_MISSING')
    const cell = table.getByRole('gridcell', { name: field.name, exact: true }).first()
    if ((table.viewportSize()?.width ?? 1280) <= 390) {
      stage = 'narrow-inspector-edit'
      if (!await closeInspector.isVisible()) await table.locator('.meta-grid__row-num').first().click()
      const fieldPanel = table.locator('.meta-record-drawer__field').filter({ has: table.getByText(field.name, { exact: true }) })
      stage = 'narrow-inspector-field'
      output({ narrowFieldPanels: await fieldPanel.count(), narrowEditableInputs: await fieldPanel.locator('input').count() })
      const patchWait = observed(table.waitForResponse(response => new URL(response.url()).pathname === '/api/multitable/patch'))
      if (typeof value === 'boolean') await fieldPanel.locator('input[type="checkbox"]').setChecked(value)
      else {
        await fieldPanel.locator('input[type="text"]').fill(value)
        await fieldPanel.locator('input[type="text"]').press('Tab')
      }
      stage = 'narrow-inspector-persist'
      assert.equal((await patchWait()).status(), 200, 'INSPECTOR_PATCH_STATUS')
      assert.equal((await snapshot(pool!, fixture)).projection.data[physical(code)], value, 'INSPECTOR_VALUE_NOT_PERSISTED')
      await table.screenshot({ path: path.join(evidence, 'narrow-inspector-' + code + '.png') })
      return
    }
    stage = code === 'cleaning_reason' ? 'reason-open' : 'requested-open'
    await cell.dblclick()
    const patchWait = observed(table.waitForResponse(response => new URL(response.url()).pathname === '/api/multitable/patch'))
    stage = code === 'cleaning_reason' ? 'reason-input' : 'requested-input'
    if (typeof value === 'boolean') {
      const checkbox = cell.locator('input[type="checkbox"]')
      assert.notEqual(await checkbox.isChecked(), value, 'GRID_EXPECTED_CHANGED_VALUE')
      // Native change immediately confirms and unmounts the editor. setChecked's
      // post-click element check is not valid after that real component lifecycle.
      await checkbox.click()
    }
    else {
      await cell.locator('input,textarea').fill(value)
      await cell.locator('input,textarea').press('Enter')
    }
    stage = code === 'cleaning_reason' ? 'reason-patch-response' : 'requested-patch-response'
    assert.equal((await patchWait()).status(), 200, 'GRID_PATCH_STATUS')
    const persisted = await snapshot(pool!, fixture)
    assert.equal(persisted.projection.data[physical(code)], value, 'GRID_VALUE_NOT_PERSISTED')
  }
  stage = 'grid-proposal-edit'
  await edit('cleaning_reason', 'synthetic verified correction')
  await edit('cleaning_requested', true)
  await table.screenshot({ path: path.join(evidence, 'desktop-grid-proposal.png') })
  await table.setViewportSize({ width: 390, height: 844 })
  await table.screenshot({ path: path.join(evidence, 'narrow-grid-proposal.png') })
  const proposed = await snapshot(pool, fixture)
  assert.deepEqual(proposed.canonical, beforeProposal.canonical, 'PROPOSAL_CANONICAL_WRITE')
  assert.equal(proposed.edits, 0)
  assert.equal(proposed.projection.data[physical('cleaning_requested')], true)

  stage = 'review-proposal'
  await page.bringToFront()
  // The descriptor is discovered after actual sync, never fixture-injected.
  await page.reload()
  await page.locator('[data-cleaning-load]').click()
  await page.locator('[data-cleaning-review]').click()
  // A second real tab can retain an already-reviewed version while the first
  // tab applies it. Retry only this reachable UI state, never an invented button.
  const repeatPage = await browserContext.newPage()
  repeatPage.setDefaultTimeout(15000)
  await repeatPage.goto(uiOrigin + attendancePath)
  await repeatPage.locator('[data-cleaning-load]').click()
  await repeatPage.locator('[data-cleaning-review]').click()
  const before = await snapshot(pool, fixture)
  assert.equal(posts.length, 0, 'PRECONFIRM_POST')
  assert.deepEqual(before.canonical, beforeProposal.canonical)
  assert.equal(before.operations, beforeProposal.operations)
  assert.equal(before.events, 0)
  await page.locator('[data-cleaning-section]').screenshot({ path: path.join(evidence, 'desktop-review-section.png') })
  await page.screenshot({ path: path.join(evidence, 'desktop-review.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-cleaning-section]').screenshot({ path: path.join(evidence, 'narrow-review-section.png') })
  await page.screenshot({ path: path.join(evidence, 'narrow-review.png') })
  const applyWait = observed(page.waitForResponse(response => response.url().endsWith('/cleaning-apply')))
  await page.locator('[data-cleaning-confirm]').click()
  stage = 'APPLY_HTTP_STATUS'
  const applied = await applyWait()
  if (applied.status() !== 200) {
    const payload = await applied.json().catch(() => null)
    const refusalCode = payload?.error?.code
    assert.deepEqual(await snapshot(pool, fixture), before, 'REFUSED_APPLY_WROTE_DATA')
    output({ refusedApplyZeroWrite: true, applyStatus: applied.status(), refusalCode: typeof refusalCode === 'string' && /^[A-Z_]+$/.test(refusalCode) ? refusalCode : 'UNCLASSIFIED' })
    // Diagnostic read only, after the actual HTTP outcome. Never feeds the route.
    const { readAttendanceCleaningSourceSeed } = await import('../../../packages/core-backend/src/attendance/attendance-multitable-cleaning-authority')
    let queryIndex = 0
    try {
      await readAttendanceCleaningSourceSeed(async (sql, params) => {
        const index = ++queryIndex
        try {
          const result = await pool!.query(sql, params)
          output({ seedReadQuery: index, rows: result.rows.length })
          return result
        } catch (error) {
          const code = (error as { code?: string }).code
          output({ seedReadQuery: index, sqlState: code && /^[A-Z0-9]{5}$/.test(code) ? code : 'UNKNOWN' })
          throw error
        }
      }, { orgId: canonical.orgId, actorId: canonical.userId, tokenSubjectUserId: canonical.userId,
        projectionRecordId: fixture.projectionId, expectedVersion: before.projection.version })
      output({ seedRead: 'PASS' })
    } catch { output({ seedRead: 'FAIL', queryCount: queryIndex }) }
  }
  assert.equal(applied.status(), 200, 'APPLY_HTTP_STATUS')
  await page.getByRole('status').filter({ hasText: /Attendance updated; proposal consumed|考勤已更新，建议已处理/ }).waitFor()
  assert.deepEqual(posts, [{ body: { expectedVersion: before.projection.version }, org: canonical.orgId, tenant: canonical.orgId }])
  const after = await snapshot(pool, fixture)
  assert.equal(after.canonical.status, 'normal')
  assert.equal(after.edits, 1)
  assert.equal(after.completedOperations, 1)
  assert.equal(after.manualOverrideCalculations, 1)
  assert.equal(after.events, 1)
  assert.equal(after.notified, 0)
  stage = 'custom-preservation-after-apply'
  assert.equal(after.projection.data[customId], customValue, 'CUSTOM_VALUE_LOST_ON_APPLY')
  assert.equal(after.projection.data[physical('cleaning_requested')], false)
  assert.equal(after.projection.data[physical('cleaning_reason')], null)
  await page.screenshot({ path: path.join(evidence, 'narrow-consumed.png') })
  stage = 'stale-tab-repeat'
  const repeatWait = observed(repeatPage.waitForResponse(response => response.url().endsWith('/cleaning-apply')))
  await repeatPage.locator('[data-cleaning-confirm]').click()
  const repeatResponse = await repeatWait()
  // Current readSeed deliberately classifies a stale projection version as
  // unavailable before the mutation boundary. Preserve this exact contract.
  assert.equal(repeatResponse.status(), 503, 'REPEAT_REFUSAL_STATUS')
  assert.equal((await repeatResponse.json()).error?.code, 'ATTENDANCE_CLEANING_UNAVAILABLE', 'REPEAT_REFUSAL_CODE')
  assert.deepEqual(await snapshot(pool, fixture), after, 'REPEAT_WROTE_DATA')
  await repeatPage.getByRole('status').filter({ hasText: /Correction not confirmed|未确认更正结果/ }).waitFor()
  await repeatPage.screenshot({ path: path.join(evidence, 'stale-tab-repeat-denied.png') })
  await repeatPage.locator('[data-cleaning-load]').click()
  await repeatPage.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-cleaning-load]')
    return button && !button.disabled
  })
  assert.equal(await repeatPage.locator('[data-cleaning-review]').count(), 0, 'CONSUMED_PROPOSAL_REAPPEARED')
  await repeatPage.close()

  stage = 'custom-resync-preservation'
  // The review-page reload reset these controls; choose the same real UI scope.
  await page.locator('[data-report-record-sync-from]').fill(canonical.workDate)
  await page.locator('[data-report-record-sync-to]').fill(canonical.workDate)
  await page.locator('[data-report-record-sync-user]').fill(canonical.userId)
  const resyncWait = observed(page.waitForResponse(response => new URL(response.url()).pathname === '/api/attendance/report-records/sync'))
  await page.locator('[data-report-record-sync-button]').click()
  const resynced = await resyncWait()
  assert.equal(resynced.status(), 200, 'RESYNC_STATUS')
  assert.equal((await resynced.json()).ok, true, 'RESYNC_FAILED')
  const afterResync = await snapshot(pool, fixture)
  assert.equal(afterResync.projection.data[customId], customValue, 'CUSTOM_VALUE_LOST_ON_RESYNC')
  assert.deepEqual(afterResync.canonical, after.canonical, 'RESYNC_CANONICAL_CHANGED')
  for (const key of ['edits', 'completedOperations', 'manualOverrideCalculations', 'events', 'notified'] as const) {
    assert.equal(afterResync[key], after[key], 'RESYNC_REPEATED_EFFECT')
  }
  assert.deepEqual(await snapshotActorAuthority(pool, canonical.userId), reviewAuthority, 'REVIEW_AUTHORITY_CHANGED')
  output({ staleTabRetryDenied: true, retryZeroWrite: true, customPreservedAfterApplyAndResync: true, canonicalEffects: 1 })
  await table.reload()
  await table.getByRole('grid').waitFor()
  // Reload preserves the selected-record route. Wait for its actual detail
  // content; do not race deep-link hydration with a second row selection.
  await table.locator('.meta-record-drawer__fields').waitFor()
  const retainedPanel = table.locator('.meta-record-drawer__field').filter({ has: table.getByText(customName, { exact: true }) })
  assert.equal(await retainedPanel.locator('input').inputValue(), customValue, 'CUSTOM_UI_VALUE_NOT_RETAINED')
  await retainedPanel.scrollIntoViewIfNeeded()
  await table.screenshot({ path: path.join(evidence, 'narrow-custom-retained.png') })
  const requestedName = fields.find(field => field.id === physical('cleaning_requested'))!.name
  const consumedPanel = table.locator('.meta-record-drawer__field').filter({ has: table.getByText(requestedName, { exact: true }) })
  assert.equal(await consumedPanel.locator('input[type="checkbox"]').isChecked(), false, 'CONSUMED_UI_FLAG_NOT_CLEARED')
  await consumedPanel.scrollIntoViewIfNeeded()
  await table.screenshot({ path: path.join(evidence, 'narrow-grid-consumed.png') })

  stage = 'canonical-report-return'
  const reportsPage = await browserContext.newPage()
  reportsPage.setDefaultTimeout(15000)
  await reportsPage.goto(uiOrigin + '/attendance?tab=reports')
  await reportsPage.locator('#attendance-from-date').fill(canonical.workDate)
  await reportsPage.locator('#attendance-to-date').fill(canonical.workDate)
  await reportsPage.locator('#attendance-user-id').fill(canonical.userId)
  assert.equal(await reportsPage.locator('#attendance-org-id').inputValue(), canonical.orgId, 'REPORT_UI_TENANT')
  const recordsWait = observed(reportsPage.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/attendance/records' && url.searchParams.get('from') === canonical.workDate
      && url.searchParams.get('to') === canonical.workDate && url.searchParams.get('userId') === canonical.userId
  }))
  await reportsPage.getByRole('button', { name: 'Reload report', exact: true }).first().click()
  const recordsResponse = await recordsWait()
  assert.equal(recordsResponse.status(), 200, 'REPORT_RETURN_STATUS')
  const recordBody = await recordsResponse.json()
  assert.equal(recordBody.data.total, 1, 'REPORT_RETURN_COUNT')
  const resultRows = reportsPage.locator('table.attendance__table--records tbody > tr:not(.attendance__table-row--meta)')
  await resultRows.first().waitFor()
  assert.equal(await resultRows.count(), 1, 'REPORT_UI_ROW_COUNT')
  assert.match(await resultRows.first().innerText(), /Normal|正常/, 'REPORT_UI_NORMAL')
  await resultRows.first().scrollIntoViewIfNeeded()
  await reportsPage.screenshot({ path: path.join(evidence, 'desktop-canonical-report.png') })
  await reportsPage.setViewportSize({ width: 390, height: 844 })
  // Both punch_result and attendance_result can render Normal in the same row.
  const normalCell = resultRows.first().locator('td').filter({ hasText: /^(Normal|正常)$/ }).first()
  await normalCell.scrollIntoViewIfNeeded()
  await normalCell.screenshot({ path: path.join(evidence, 'narrow-canonical-cell.png') })
  const normalBounds = await normalCell.boundingBox()
  assert(normalBounds && normalBounds.x >= 0 && normalBounds.y >= 0
    && normalBounds.x + normalBounds.width <= 390 && normalBounds.y + normalBounds.height <= 844,
  'NARROW_CANONICAL_CELL_OUTSIDE_VIEWPORT')
  await reportsPage.screenshot({ path: path.join(evidence, 'narrow-canonical-report.png') })
  stage = 'foreign-org-canary'
  const canary = await seedForeignCanary(pool, foreignOrgId)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_orgs WHERE user_id = $1 AND org_id = $2', [canonical.userId, foreignOrgId])).rows[0].n, 0, 'UNEXPECTED_FOREIGN_MEMBERSHIP')
  await reportsPage.locator('#attendance-user-id').fill(canary.userId)
  const foreignHolidayWait = observed(reportsPage.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/attendance/holidays' && url.searchParams.get('orgId') === foreignOrgId
  }))
  const foreignWait = observed(reportsPage.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/attendance/records' && url.searchParams.get('orgId') === foreignOrgId
      && url.searchParams.get('userId') === canary.userId
  }))
  await reportsPage.locator('#attendance-org-id').fill(foreignOrgId)
  const foreignResponse = await foreignWait()
  const foreignPayload = await foreignResponse.json()
  const foreignItems = Array.isArray(foreignPayload.data?.items) ? foreignPayload.data.items : []
  const canaryVisible = foreignItems.some((item: { id?: string }) => item.id === canary.recordId)
  output({ foreignStatus: foreignResponse.status(), foreignRows: foreignItems.length, canaryVisible, loginHasForeignMembership: false })
  assert.equal(canaryVisible, false, 'FOREIGN_CANARY_DISCLOSED')
  assert.equal(foreignResponse.status(), 403, 'FOREIGN_ORG_NOT_DENIED')
  // Existing group-route identity guard rejects the mismatched selector before
  // holiday queries. Pin the complete values-free refusal, not any 404 response.
  const foreignHolidayResponse = await foreignHolidayWait()
  assert.equal(foreignHolidayResponse.status(), 404, 'FOREIGN_HOLIDAYS_NOT_DENIED')
  assert.deepEqual(await foreignHolidayResponse.json(), {
    ok: false, error: { code: 'NOT_FOUND', message: 'Group not found' },
  }, 'FOREIGN_HOLIDAYS_REFUSAL_CONTRACT')
  await reportsPage.close()

  stage = 'revoked-confirmation'
  await edit('cleaning_reason', 'synthetic revoke control')
  await edit('cleaning_requested', true)
  await page.locator('[data-cleaning-load]').click()
  await page.locator('[data-cleaning-review]').click()
  stage = 'revoked-confirmation'
  const deniedBefore = await snapshot(pool, fixture)
  await revoke(pool, fixture)
  const deniedWait = observed(page.waitForResponse(response => response.url().endsWith('/cleaning-apply')))
  await page.locator('[data-cleaning-confirm]').click()
  assert.equal((await deniedWait()).status(), 403, 'REVOCATION_STATUS')
  assert.deepEqual(await snapshot(pool, fixture), deniedBefore, 'REVOCATION_WROTE_DATA')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('[data-cleaning-section] [role="status"]').waitFor()
  await page.locator('[data-cleaning-section]').screenshot({ path: path.join(evidence, 'desktop-denied-section.png') })
  await page.screenshot({ path: path.join(evidence, 'desktop-denied.png') })
  assert.deepEqual(unexpected, [])
  assert.deepEqual(browserFaults, [])
  assert.equal(blockedConnections, 0, 'UNEXPECTED_BACKEND_NETWORK')
  for (const key of apiFailures.keys()) {
    const [failureStage, route, status] = key.split(':')
    const expected = (route.startsWith('comments-') && status === '403')
      || (failureStage === 'stale-tab-repeat' && route === 'cleaning-apply' && status === '503')
      || (failureStage === 'foreign-org-canary' && route === 'attendance-records' && status === '403')
      || (failureStage === 'foreign-org-canary' && route === 'attendance-holidays' && status === '404')
      || (failureStage === 'revoked-confirmation' && route === 'cleaning-apply' && status === '403')
    assert(expected, 'UNEXPECTED_API_FAILURE')
  }
  stage = 'BASELINE_PASS'
  output({ result: 'BASELINE_PASS', realLogin: true, realSync: true, gridProposal: true, revokedZeroWrite: true,
    apiFailures: Object.fromEntries(apiFailures),
    completionPending: ['final-evidence-review', 'draft-publication'] })

} catch (error) {
  failed = true
  for (const [index, failedPage] of (browser?.contexts().flatMap(context => context.pages()) ?? []).entries()) {
    await failedPage.screenshot({ path: path.join(evidence, `failure-${index}.png`), fullPage: true }).catch(() => undefined)
  }
  const code = (error as { code?: unknown }).code
  const rawMessage = (error as { message?: unknown }).message
  const message = typeof rawMessage === 'string' ? rawMessage.split('\n')[0].trim() : ''
  output({ result: 'FAIL', stage, apiStatuses, apiFailures: Object.fromEntries(apiFailures), unknownApiShapes: [...unknownApiShapes], browserFaults, assertion: typeof message === 'string' && /^[A-Z_]+$/.test(message) ? message : 'NON_CODE_ERROR', code: typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'ACCEPTANCE_ERROR' })
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
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE $1', ['acp_full_%'])).rows[0].n, 0)
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
