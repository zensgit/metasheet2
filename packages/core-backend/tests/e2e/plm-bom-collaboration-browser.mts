// Disposable loopback browser rehearsal. Real JWT/DSM/Y HTTP/native services; no route.fulfill.
import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import express from 'express'
import { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { chromium, expect } from '@playwright/test'
import { bootstrapPlmBomReviewTestDb } from '../plm-bom-review/bootstrap'
import { bootstrapPlmBomReviewAuthTestDb } from '../plm-bom-review/auth-bootstrap'
import { bootstrapBomReviewNativeHttpDb } from '../plm-bom-review/native-bootstrap'

const runtimeRequire = createRequire(import.meta.url)
const repo = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const output = process.env.W20_BROWSER_OUTPUT
const mode = process.env.W20_BROWSER_EXPECT
for (const key of ['DATABASE_URL', 'Y_BASE_URL', 'Y_AUTH_TOKEN', 'W20_Y_FIXTURE_DATABASE_URL', 'W20_BROWSER_OUTPUT']) assert(process.env[key], `${key} required`)
assert(['red', 'green'].includes(mode!), 'W20_BROWSER_EXPECT=red|green required')
for (const key of ['DATABASE_URL', 'Y_BASE_URL', 'W20_Y_FIXTURE_DATABASE_URL']) assert(['127.0.0.1', 'localhost'].includes(new URL(process.env[key]!).hostname), 'Private loopback fixture only')
const fixtureDir = await realpath(process.env.W20_BROWSER_FIXTURE_DIR || '')
assert.equal(dirname(fixtureDir), await realpath(tmpdir()), 'Owned temporary root required')
assert(basename(fixtureDir).startsWith('w20-browser-'))
const marker = JSON.parse(await readFile(join(fixtureDir, 'fixture.json'), 'utf8'))
assert.equal(marker.id, process.env.W20_BROWSER_FIXTURE_ID)
assert.equal(marker.socket, join(fixtureDir, 's'))
for (const [key, name] of [['DATABASE_URL', 'w20_metasheet'], ['W20_Y_FIXTURE_DATABASE_URL', 'w20_business']]) {
  const url = new URL(process.env[key]!)
  assert.equal(url.protocol, 'postgresql:')
  assert.equal(url.username, 'w20_owner')
  assert.equal(url.password, '')
  assert.equal(url.pathname, '/' + name)
  // pg reads the last duplicate query value; reject duplicates before reading any first value.
  assert.deepEqual([...url.searchParams.keys()].sort(),
    key === 'DATABASE_URL' ? ['host', 'port'] : ['host', 'options', 'port'])
  if (key === 'W20_Y_FIXTURE_DATABASE_URL') assert.equal(url.searchParams.get('options'), '-csearch_path=yt_t_w20,public')
  assert.equal(await realpath(url.searchParams.get('host')!), marker.socket)
  assert.equal(url.searchParams.get('port'), String(marker.port))
  assert(marker.databases.includes(name))
}
await mkdir(output!, { recursive: true })
Object.assign(process.env, {
  JWT_SECRET: 'w20-browser-synthetic-jwt-signing-material-not-production', RBAC_TOKEN_TRUST: 'false',
  PRODUCT_MODE: 'plm-workbench', ENABLE_PLM: 'true', NODE_ENV: 'test', DB_SSL: 'false',
  PLM_BASE_URL: process.env.Y_BASE_URL, PLM_API_MODE: 'yuantus', PLM_API_TOKEN: process.env.Y_AUTH_TOKEN,
  PLM_TENANT_ID: 'default', PLM_ORG_ID: 'fixture-org',
  PLM_BOM_REVIEW_ENABLED: 'true', MULTITABLE_ENABLE_WRITER_FENCE: 'true', AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true',
  ENCRYPTION_KEY: 'w20-browser-synthetic-private-encryption-material', ENCRYPTION_SALT: 'w20-browser-synthetic-private-salt',
})
const observed: Record<string, unknown> = { mode, entry: 'real-components-harness', routeFulfill: false }
const http: Array<{ method: string, path: string, status: number }> = []
const errors: string[] = []
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 })
const sourcePool = new Pool({ connectionString: process.env.W20_Y_FIXTURE_DATABASE_URL, max: 2 })
const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
let server: ReturnType<ReturnType<typeof express>['listen']> | undefined
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let vite: ReturnType<typeof spawn> | undefined
let envDir: string | undefined
let disposeManager: (() => Promise<void>) | undefined
let closeGlobalPools: (() => Promise<unknown>) | undefined
let deactivateIntegration: (() => Promise<void>) | undefined
let exitCode = 1
async function port() { const s = createServer(); await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); const p = (s.address() as { port: number }).port; await new Promise<void>(r => s.close(() => r())); return p }
try {
  await bootstrapPlmBomReviewTestDb(pool)
  await bootstrapPlmBomReviewAuthTestDb(pool)
  await bootstrapBomReviewNativeHttpDb(pool)
  await pool.query('ALTER TABLE meta_bases ADD COLUMN created_at timestamptz DEFAULT now()')
  await pool.query(`ALTER TABLE data_sources ADD COLUMN auto_connect boolean DEFAULT false, ADD COLUMN status text, ADD COLUMN updated_at timestamptz, ADD COLUMN last_connected_at timestamptz, ADD COLUMN last_error text;
    INSERT INTO users(id,is_active,role,activation_status,local_password_set,permissions,name,email) VALUES
    ('browser-owner',true,'user','activated',true,'{}','Browser Owner','browser-owner@synthetic.invalid'),
    ('browser-member',true,'user','activated',true,'{}','Browser Member','browser-member@synthetic.invalid'),
    ('browser-outsider',true,'user','activated',true,'{}','Browser Outsider','browser-outsider@synthetic.invalid'),
    ('browser-assignee',true,'user','activated',true,'{}','Browser Assignee','browser-assignee@synthetic.invalid');
    INSERT INTO user_permissions(user_id,permission_code) VALUES
    ('browser-owner','integration:write'),('browser-owner','data_sources:read'),('browser-member','integration:write'),
    ('browser-member','comments:read'),('browser-member','comments:write'),('browser-assignee','multitable:read');
    INSERT INTO roles(id,name) VALUES('browser-integrations','Integration users'),('browser-data-sources','Data source users');
    INSERT INTO role_permissions(role_id,permission_code) VALUES('browser-integrations','integration:write'),('browser-data-sources','data_sources:read');
    INSERT INTO user_roles(user_id,role_id) VALUES('browser-owner','browser-integrations'),('browser-member','browser-integrations'),('browser-owner','browser-data-sources');
    INSERT INTO user_namespace_admissions(user_id,namespace,enabled) VALUES('browser-owner','integration',true),('browser-member','integration',true),('browser-owner','data_sources',true);
    INSERT INTO meta_bases(id,name,owner_id) VALUES('browser-base','Browser collaboration base','browser-owner');`)
  const { encryptStoredSecretValue } = runtimeRequire('../../src/security/encrypted-secrets.ts')
  const config = { connection: { url: process.env.Y_BASE_URL }, options: { apiMode: 'yuantus', tenantId: 'default', orgId: 'fixture-org' }, credentials: { token: encryptStoredSecretValue(process.env.Y_AUTH_TOKEN!) } }
  await pool.query("INSERT INTO data_sources(id,name,type,config,owner_id,is_active,scope_kind,tenant_id,auto_connect) VALUES('w20-y-source','Actual private Y HTTP','plm',$1::jsonb,'browser-owner',true,'private','default',true)", [JSON.stringify(config)])
  // Apply actual integration schemas over the existing isolated precursor fixture.
  for (const name of ['057_create_integration_core_tables.sql', '062_create_integration_read_source_configs.sql', '063_create_integration_read_source_composition_configs.sql']) {
    await pool.query(await readFile(join(repo, 'packages/core-backend/migrations', name), 'utf8'))
  }
  await runtimeRequire('../../src/db/migrations/zzzz20260902120000_add_integration_connection_binding.ts').up(db)
  await pool.query(`INSERT INTO integration_external_systems(id,tenant_id,name,kind,role,connection_id,status)
    VALUES('w20-y-system','default','Original BOM source','data-source:sql-readonly','source','w20-y-source','active')`)
  const { initializeDataSourceManager, dataSourcesRouter } = runtimeRequire('../../src/routes/data-sources.ts')
  const manager = await initializeDataSourceManager(db)
  disposeManager = () => manager.dispose()
  assert(manager.getDataSource('w20-y-source'), 'Real DSM loads persisted source')
  await runtimeRequire('../../src/db/migrations/_ensure-user-orgs.ts').ensureCanonicalUserOrgsTable(db)
  await pool.query(`INSERT INTO user_orgs(user_id,org_id,is_active) VALUES('browser-owner','default',true),('browser-member','default',true),('browser-outsider','default',true)`)
  const { authService } = runtimeRequire('../../src/auth/AuthService.ts')
  const tokens: Record<string, string> = {}
  for (const id of ['browser-owner', 'browser-member', 'browser-outsider']) {
    tokens[id] = authService.createToken({ ...(await pool.query('SELECT * FROM users WHERE id=$1', [id])).rows[0], tenantId: 'default' })
    const verified = await authService.verifyToken(tokens[id])
    assert.equal(verified?.id, id); assert.equal(verified?.email, id + '@synthetic.invalid'); assert.equal(verified?.role, 'user'); assert(!verified?.permissions.includes('*:*'))
  }
  const [{ authenticate }, { authRouter }, { default: plmRouter }, { univerMetaRouter }, { commentsRouter }, { createContainer }, { createPlmBomReviewsRouter }, { poolManager }] = [
    runtimeRequire('../../src/middleware/auth.ts'), runtimeRequire('../../src/routes/auth.ts'), runtimeRequire('../../src/routes/plm-workbench.ts'),
    runtimeRequire('../../src/routes/univer-meta.ts'), runtimeRequire('../../src/routes/comments.ts'), runtimeRequire('../../src/di/container.ts'),
    runtimeRequire('../../src/routes/plm-bom-reviews.ts'), runtimeRequire('../../src/integration/db/connection-pool.ts'),
  ]
  closeGlobalPools = () => poolManager.close()
  const tx = { query: pool.query.bind(pool), async transaction(fn: (q: { query: typeof pool.query }) => Promise<unknown>) {
    const client = await pool.connect()
    try { await client.query('BEGIN'); const result = await fn({ query: client.query.bind(client) as typeof pool.query }); await client.query('COMMIT'); return result }
    catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
  } }
  const app = express()
  app.use(express.json())
  const webPort = await port(), webOrigin = `http://127.0.0.1:${webPort}`
  app.use((req, res, next) => {
    if (req.headers.origin === webOrigin) { res.setHeader('Access-Control-Allow-Origin', webOrigin); res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,x-tenant-id,x-org-id,x-request-id'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS') }
    res.on('finish', () => http.push({ method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode }))
    if (req.method === 'OPTIONS') { res.sendStatus(204); return }; next()
  })
  app.use('/api/auth', authRouter)
  app.use(authenticate)
  app.use(plmRouter)
  app.use(dataSourcesRouter())
  const integration = runtimeRequire('../../../../plugins/plugin-integration-core/index.cjs')
  const { createDataSourcePluginFacade } = runtimeRequire('../../src/data-adapters/data-source-plugin-facade.ts')
  await integration.activate({
    logger: console, config: {},
    api: {
      database: { query: async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows },
      dataSources: createDataSourcePluginFacade(() => manager),
      http: { addRoute(method: string, path: string, handler: express.RequestHandler) {
        app[method.toLowerCase() as 'get'](path, handler)
      } },
    },
    communication: { register() {} },
  })
  deactivateIntegration = () => integration.deactivate()
  app.use('/api/plm-bom-reviews', createPlmBomReviewsRouter({ pool: tx as never, dataSourceManager: manager }))
  app.use('/api/multitable', univerMetaRouter())
  app.use(commentsRouter(createContainer()))
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(r => server!.once('listening', r))
  const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  async function request(actor: string, path: string, method = 'GET', body?: unknown) {
    const response = await fetch(api + path, { method, headers: { Authorization: `Bearer ${tokens[actor]}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  const me = await request('browser-owner', '/api/auth/me'); assert.equal(me.status, 200); assert.equal(me.body.data.features.mode, 'plm-workbench')
  for (const id of Object.keys(tokens)) {
    const response = await request(id, '/api/auth/me')
    assert.equal(response.status, 200); assert.equal(response.body.data.user.id, id)
    assert.equal(response.body.data.user.tenantId, 'default')
    assert.equal(response.body.data.user.email, id + '@synthetic.invalid'); assert.equal(response.body.data.user.role, 'user')
    assert(!response.body.data.user.permissions.includes('*:*'))
    if (id !== 'browser-outsider') assert(response.body.data.user.permissions.includes('integration:write'), 'Real auth/me namespace admission grants the workbench route')
  }
  const bad = tokens['browser-owner'].split('.'); bad[2] = (bad[2][0] === 'A' ? 'B' : 'A') + bad[2].slice(1)
  assert.equal((await fetch(api + '/api/auth/me', { headers: { Authorization: 'Bearer ' + bad.join('.') } })).status, 401)
  await pool.query("UPDATE users SET is_active=false WHERE id='browser-member'")
  assert.equal((await request('browser-member', '/api/auth/me')).status, 401)
  await pool.query("UPDATE users SET is_active=true WHERE id='browser-member'")
  assert.equal((await request('browser-member', '/api/auth/me')).status, 200)
  observed.actualAuthMe = true
  observed.testModeLoopbackTransport = true
  observed.tamperedJwtAndInactiveDeniedRestoredActive = true
  const externalSystems = await request('browser-owner', '/api/integration/external-systems?tenantId=default')
  assert.equal(externalSystems.status, 200, JSON.stringify(externalSystems.body))
  assert(externalSystems.body.data.some((system: { id: string }) => system.id === 'w20-y-system'))
  observed.actualIntegrationPluginWithTenantMembership = true
  const context = await request('browser-owner', '/api/plm-workbench/data-sources/w20-y-source/bom-multitable/root/context')
  assert.equal(context.status, 200); assert.equal(context.body.entitled, true); assert(context.body.context.lines.length)
  observed.actualOwnerContext = true
  envDir = await mkdtemp(join(tmpdir(), 'w20-browser-vite-'))
  await writeFile(join(envDir, '.env.development'), `VITE_API_URL=${api}\nVITE_API_BASE=${api}\n`)
  vite = spawn(process.execPath, [join(repo, 'apps/web/node_modules/vite/bin/vite.js'), '--config', 'vite.config.ts', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], { cwd: join(repo, 'apps/web'), env: { ...process.env, NODE_ENV: 'development', METASHEET_ENV_DIR: envDir }, stdio: ['ignore', 'pipe', 'pipe'] })
  let viteLog = ''; vite.stdout?.on('data', d => { viteLog += String(d) }); vite.stderr?.on('data', d => { viteLog += String(d) })
  for (let i = 0; i < 150; i++) { try { if ((await fetch(webOrigin)).ok) break } catch {} if (i === 149) throw new Error('Vite did not start'); await delay(200) }
  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : { channel: 'chrome' }), headless: true })
  const owner = await browser.newContext({ viewport: { width: 1600, height: 1000 }, timezoneId: 'Asia/Taipei' })
  const member = await browser.newContext({ viewport: { width: 1600, height: 1000 }, timezoneId: 'Asia/Taipei' })
  for (const [ctx, id] of [[owner, 'browser-owner'], [member, 'browser-member']] as const) await ctx.addInitScript(token => localStorage.setItem('auth_token', token), tokens[id])
  const page = await owner.newPage()
  page.on('pageerror', e => errors.push(e.message))
  const harness = `${webOrigin}/verification/plm-bom-collaboration-harness.html`
  async function panel() { await page.goto(harness + '#/plm'); const openDialog = page.getByRole('dialog',{ name: 'BOM 协作表' }); if (await openDialog.isVisible()) await openDialog.getByRole('button',{ name: '关闭',exact: true }).click(); await page.getByTestId('plm-bom-review-part-input').fill('root'); await page.getByTestId('plm-bom-review-load').click(); await expect(page.getByTestId('plm-bom-review-state')).toHaveAttribute('data-state', 'table', { timeout: 30000 }); await page.getByTestId('plm-bom-collaboration-open').click() }
  await panel()
  await page.getByTestId('collaboration-base').selectOption('browser-base')
  await page.getByTestId('collaboration-name').fill('Actual browser BOM collaboration')
  await page.getByRole('button', { name: '预览分享范围', exact: true }).click()
  await expect(page.getByTestId('collaboration-preview')).toBeVisible()
  await page.getByTestId('collaboration-consent').check()
  const created = page.waitForResponse(r => new URL(r.url()).pathname === '/api/plm-bom-reviews' && r.request().method() === 'POST')
  await page.getByRole('button', { name: '确认分享并打开协作表', exact: true }).click()
  const creation = await created; assert.equal(creation.status(), 200)
  const binding = (await creation.json()).data
  const nativePath = `/multitable/${binding.sheetId}/${binding.viewId}?baseId=${binding.baseId}`
  await delay(500)
  observed.afterConfirmUrl = new URL(page.url()).hash
  observed.focusBounce = !new URL(page.url()).hash.startsWith('#/multitable/')
  await page.screenshot({ path: join(output!, 'after-confirm.png'), fullPage: true })
  assert.equal((await request('browser-owner', `/api/multitable/sheets/${binding.sheetId}/permissions/user/browser-member`, 'PUT', { accessLevel: 'write' })).status, 200)
  // Save real policies through the shipped components; the source and API are not intercepted.
  await panel()
  await page.getByRole('button', { name: '配置通知规则',exact: true }).click()
  await expect(page.getByTestId('issue-enabled')).toBeEnabled()
  await page.getByTestId('issue-enabled').check()
  await page.getByTestId('issue-strategy').selectOption('event_owner')
  await page.getByTestId('reminder-enabled').check()
  await page.getByTestId('reminder-minutes').fill('15')
  await page.getByTestId('reminder-strategy').selectOption('current_owner')
  await page.getByTestId('escalation-enabled').check()
  await page.getByTestId('sla-minutes').fill('60')
  await page.getByTestId('recipient-search').fill('browser-member')
  await page.getByRole('button',{ name: '搜索',exact: true }).click()
  await page.getByRole('button',{ name: /· 选择$/ }).click()
  const notifySaved = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/notifications') && r.request().method() === 'POST')
  await page.getByTestId('save-notifications').click()
  assert.equal((await notifySaved).status(),200)
  await expect(page.getByText('规则已保存；后台任务启用后按规则处理站内通知。',{ exact: true })).toBeVisible()
  await page.getByRole('button', { name: '关闭配置',exact: true }).click()
  await page.getByRole('button', { name: '配置通知规则',exact: true }).click()
  await expect(page.getByTestId('issue-enabled')).toBeChecked()
  await expect(page.getByTestId('issue-strategy')).toHaveValue('event_owner')
  await expect(page.getByTestId('reminder-minutes')).toHaveValue('15')
  await expect(page.getByTestId('reminder-strategy')).toHaveValue('current_owner')
  await expect(page.getByTestId('sla-minutes')).toHaveValue('60')
  await page.screenshot({ path: join(output!,'notification-policy.png'),fullPage: true })
  await page.getByRole('button', { name: '关闭配置',exact: true }).click()
  await pool.query("INSERT INTO user_permissions(user_id,permission_code) VALUES('browser-owner','multitable:send_webhook')")
  await pool.query(`INSERT INTO multitable_webhooks(id,name,url,created_by) VALUES
    ('browser-review-target','Browser review target','https://erp.synthetic.invalid/review','browser-owner'),
    ('browser-plm-target','Browser PLM target','https://mes.synthetic.invalid/applied','browser-owner')`)
  await page.getByRole('button', { name: '配置完成 Webhook',exact: true }).click()
  await expect(page.getByTestId('reviewCompleted-enabled')).toBeEnabled()
  await page.getByTestId('reviewCompleted-enabled').check()
  await page.getByTestId('reviewCompleted-target').selectOption('browser-review-target')
  await page.getByTestId('reviewCompleted-granularity').selectOption('row')
  await page.getByTestId('plmChangeApplied-enabled').check()
  await page.getByTestId('plmChangeApplied-target').selectOption('browser-plm-target')
  await page.getByTestId('plmChangeApplied-source').selectOption('bom_line_writeback')
  const completionSaved = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/completion-webhooks') && r.request().method() === 'POST')
  await page.getByTestId('save-completion').click()
  assert.equal((await completionSaved).status(),200)
  await expect(page.getByText('完成规则已保存；仅处理后续符合权限和来源授权的事件。',{ exact: true })).toBeVisible()
  await page.screenshot({ path: join(output!,'completion-policy.png'),fullPage: true })
  await page.getByRole('button', { name: '关闭配置',exact: true }).click()
  await page.getByRole('button', { name: '配置完成 Webhook',exact: true }).click()
  await expect(page.getByTestId('reviewCompleted-target')).toHaveValue('browser-review-target')
  await expect(page.getByTestId('plmChangeApplied-target')).toHaveValue('browser-plm-target')
  observed.browserPoliciesPersistOnReopen = true
  await expect(page.getByTestId('reviewCompleted-granularity')).toHaveValue('row')
  await expect(page.getByTestId('plmChangeApplied-source')).toHaveValue('bom_line_writeback')
  observed.completionUiSeparatesSourcesAndRequiresOwnerListener = true
  await page.getByRole('button', { name: '关闭配置',exact: true }).click()
  await page.getByRole('dialog',{ name: 'BOM 协作表' }).getByRole('button',{ name: '关闭',exact: true }).click()
  const mp = await member.newPage(); mp.on('pageerror', e => errors.push(e.message))
  await mp.goto(mode === 'red' ? `${harness}#/plm/native-probe/${binding.sheetId}/${binding.viewId}?baseId=${binding.baseId}` : webOrigin + nativePath)
  await expect(mp.locator('.meta-grid__cell[aria-label="备注"]').first()).toBeVisible({ timeout: 45000 })
  if (mode === 'green') {
    await expect(mp.getByTestId('rail-view-node').filter({ hasText: /^全部$/ })).toHaveAttribute('aria-selected', 'true')
    await expect(mp.getByTestId('rail-view-node').filter({ hasText: /^按负责人$/ })).toHaveCount(1)
    await expect(mp.locator('[data-test="group-header"]')).toHaveCount(0)
    observed.primaryViewRemainsUngrouped = true
  }
  observed.nativeHttpRead = http.some(x => x.path === '/api/multitable/view' && x.status === 200)
  const note = mp.locator('.meta-grid__cell[aria-label="备注"]').first()
  await note.dblclick(); await delay(200)
  observed.longTextEditorMissing = await note.locator('textarea').count() === 0
  await mp.screenshot({ path: join(output!, 'native-note-editor.png'), fullPage: true })
  if (mode === 'red') {
    await writeFile(join(output!, 'vite.log'), viteLog)
    assert.deepEqual({ focusBounce: observed.focusBounce, longTextEditorMissing: observed.longTextEditorMissing }, { focusBounce: false, longTextEditorMissing: false }, 'Correct UI must reach native route and offer an inline longText editor')
  }
  assert.equal(observed.focusBounce, false)
  await note.locator('textarea').fill('Browser member note\nretained after refresh')
  await note.locator('textarea').press('Control+Enter')
  await expect(note).toContainText('Browser member note')
  const person = mp.locator('.meta-grid__cell[aria-label="负责人"]').first()
  await person.dblclick(); await mp.locator('.meta-cell-editor').getByRole('button').first().click()
  await mp.locator('.meta-person-picker__input').fill('browser-assignee')
  await mp.locator('[data-test="person-picker-member"] input').check()
  await mp.locator('[data-test="person-picker-confirm"]').click()
  const date = mp.locator('.meta-grid__cell[aria-label="截止时间"]').first()
  await date.dblclick(); await date.locator('input').fill('2026-10-08 10:30'); await date.locator('input').press('Enter')
  await mp.locator('.meta-grid__comment-action').first().click()
  await mp.locator('.meta-comment-composer textarea').fill('Browser member comment retained')
  await mp.locator('.meta-comment-composer__submit').click()
  await expect(mp.locator('.meta-comments-drawer__item')).toContainText('Browser member comment retained')
  const stored = (await pool.query('SELECT fields FROM meta_plm_bom_review_bindings WHERE id=$1', [binding.id])).rows[0]
  const local = Object.fromEntries((await pool.query('SELECT name,id FROM meta_fields WHERE sheet_id=$1', [binding.sheetId])).rows.map(r => [r.name, r.id]))
  await expect.poll(async () => (await pool.query('SELECT data FROM meta_records WHERE sheet_id=$1 AND data->>$2=$3', [binding.sheetId, local['备注'], 'Browser member note\nretained after refresh'])).rows[0]?.data[local['截止时间']]).toBe('2026-10-08T02:30:00.000Z')
  const assignedRow = (await pool.query('SELECT data FROM meta_records WHERE sheet_id=$1 AND data->>$2=$3', [binding.sheetId, local['备注'], 'Browser member note\nretained after refresh'])).rows[0]
  assert.deepEqual(assignedRow.data[local['负责人']], ['browser-assignee'])
  const before = (await pool.query('SELECT id,data FROM meta_records WHERE sheet_id=$1 ORDER BY id', [binding.sheetId])).rows
  assert(before.some(r => Object.values(r.data).includes('Browser member note\nretained after refresh')))
  await sourcePool.query("UPDATE yt_t_w20.meta_items SET properties=jsonb_set(properties::jsonb,'{quantity}','7') WHERE id='child-leaf'")
  await panel(); await page.getByRole('button', { name: '刷新来源快照', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '来源快照已刷新' })).toBeVisible()
  await mp.reload(); await expect(mp.locator('.meta-grid__cell[aria-label="备注"]').first()).toContainText('Browser member note', { timeout: 30000 })
  const after = (await pool.query('SELECT id,data FROM meta_records WHERE sheet_id=$1 ORDER BY id', [binding.sheetId])).rows
  const sourceIds = new Set(Object.values(stored.fields))
  for (const row of before) for (const [key, value] of Object.entries(row.data)) if (!sourceIds.has(key)) assert.deepEqual(after.find(r => r.id === row.id).data[key], value)
  assert(after.some(r => r.data[stored.fields.quantity] === '7'))
  const refreshedSourceRow = mp.locator('.meta-grid__row').filter({
    has: mp.locator('.meta-grid__cell[aria-label="PLM bom_line_id"]').filter({ hasText: /^child-leaf$/ }),
  })
  await expect(refreshedSourceRow.locator('.meta-grid__cell[aria-label="PLM quantity"]')).toHaveText('7')
  observed.memberSeesRefreshedChildLeafQuantity = '7'
  await mp.locator('.meta-grid__comment-action').first().click()
  await expect(mp.locator('.meta-comments-drawer__item')).toContainText('Browser member comment retained')
  observed.persistedPerson = ['browser-assignee']
  observed.persistedDateTime = '2026-10-08T02:30:00.000Z'
  observed.commentRetainedAfterReload = true
  const sourceCell = mp.locator('.meta-grid__cell[aria-label="PLM quantity"]').first(); await sourceCell.dblclick(); assert.equal(await sourceCell.locator('.meta-cell-editor').count(), 0)
  assert.equal((await request('browser-outsider', `/api/multitable/context?sheetId=${binding.sheetId}`)).status, 403)
  assert.equal((await request('browser-member', '/api/plm-workbench/data-sources/w20-y-source/bom-multitable/root/context')).status, 404)
  observed.fullMainNativeReload = true
  observed.localFieldsPreservedAfterActualSourceRefresh = true
  observed.memberCannotBorrowSource = true
  observed.outsiderDenied = true
  observed.sourceReadOnly = true
  await mp.screenshot({ path: join(output!, 'native-final.png'), fullPage: true })
  const ownerView = mp.getByTestId('rail-view-node').filter({ hasText: /^按负责人$/ })
  await ownerView.click()
  await expect(ownerView).toHaveAttribute('aria-selected', 'true')
  await expect(mp.locator('[data-test="group-header"]')).toHaveCount(2)
  const assignedGroup = mp.locator('[data-test="group-header"]').filter({ hasText: 'Browser Assignee' })
  await expect(assignedGroup.locator('.meta-grid__group-label')).toHaveText('Browser Assignee')
  await expect(assignedGroup.locator('.meta-grid__group-count')).toHaveText('(1)')
  await expect(assignedGroup).toHaveAttribute('data-group-path', JSON.stringify(['browser-assignee']))
  await expect(mp.locator('.meta-grid__row').filter({ hasText: 'Browser member note' })).toHaveCount(1)
  const groupButton = mp.getByRole('button', { name: 'Group', exact: true })
  await expect(groupButton.locator('.meta-toolbar__badge')).toHaveText('1')
  await groupButton.click()
  await expect(mp.locator('.meta-toolbar__group-select')).toHaveValue(local['负责人'])
  await groupButton.click()
  const groupedView = (await pool.query('SELECT id FROM meta_views WHERE sheet_id=$1 AND name=$2', [binding.sheetId, '按负责人'])).rows[0]
  assert.equal((await request('browser-member', `/api/multitable/views/${groupedView.id}`, 'PATCH', {
    config: { aggregations: { [stored.fields.quantity]: 'count' } },
  })).status, 200)
  observed.ownerViewGroupsAssignedAndUnassigned = true
  // Native rail selection is in-memory; the initial permalink still names the primary view.
  // Reload the owner view's explicit native permalink to verify its persisted configuration.
  await mp.goto(`${webOrigin}/multitable/${binding.sheetId}/${groupedView.id}?baseId=${binding.baseId}`)
  await expect(ownerView).toHaveAttribute('aria-selected', 'true', { timeout: 30000 })
  await mp.reload()
  await expect(ownerView).toHaveAttribute('aria-selected', 'true', { timeout: 30000 })
  await expect(assignedGroup.locator('.meta-grid__group-count')).toHaveText('(1)')
  await expect(mp.locator('[data-test="group-header"]')).toHaveCount(2)
  const subtotals = mp.locator('[data-test="group-subtotal"]')
  await expect(subtotals).toHaveCount(2)
  await expect(subtotals.filter({ has: mp.locator('.meta-grid__foot-value').filter({ hasText: /^1$/ }) })).toHaveCount(1)
  await expect(subtotals.filter({ has: mp.locator('.meta-grid__foot-value').filter({ hasText: new RegExp(`^${before.length - 1}$`) }) })).toHaveCount(1)
  observed.ownerViewNativeGroupSubtotals = { assigned: 1, unassigned: before.length - 1 }
  observed.ownerViewPersistsOnNativeReload = true
  await mp.screenshot({ path: join(output!, 'native-owner-view.png'), fullPage: true })
  const pendingView = mp.getByTestId('rail-view-node').filter({ hasText: /^待评审$/ })
  await pendingView.click(); await expect(pendingView).toHaveAttribute('aria-selected','true')
  await expect(mp.locator('.meta-grid__cell[aria-label="备注"]')).toHaveCount(before.length)
  const issueView = mp.getByTestId('rail-view-node').filter({ hasText: /^问题项$/ })
  await issueView.click(); await expect(issueView).toHaveAttribute('aria-selected','true')
  await expect(mp.locator('.meta-grid__cell[aria-label="备注"]')).toHaveCount(0)
  await mp.screenshot({ path: join(output!,'native-issue-empty-view.png'),fullPage: true })
  observed.statusViewsActuallyFilterInNativeBrowser = { pending: before.length,issues: 0 }
  // Controlled issue round, after the earlier preservation/grouping proofs. Native writes only.
  await pool.query("INSERT INTO user_permissions(user_id,permission_code) VALUES('browser-member','multitable:read')")
  const issueRow = before.find(r => Array.isArray(r.data[local['负责人']]) && r.data[local['负责人']].includes('browser-assignee'))!
  const mutate = (changes: Array<{ fieldId: string; value: unknown }>) => request('browser-member','/api/multitable/patch','POST',{
    sheetId: binding.sheetId,viewId: binding.viewId,changes: changes.map(change => ({ recordId: issueRow.id,...change })),
  })
  const assignedIssue = await mutate([
    { fieldId: local['负责人'],value: ['browser-member'] },
    { fieldId: local['截止时间'],value: '2032-10-14T10:30:00.000Z' },
    { fieldId: local['评审状态'],value: '评审中' },
  ])
  assert.equal(assignedIssue.status,200,JSON.stringify(assignedIssue.body))
  assert.equal((await mutate([{ fieldId: local['评审状态'],value: '有问题' }])).status,200)
  const { PlmBomReviewService } = runtimeRequire('../../src/multitable/plm-bom-review-service.ts')
  const { PlmBomNotificationWorker } = runtimeRequire('../../src/multitable/plm-bom-notification-worker.ts')
  const reviewService = new PlmBomReviewService({ pool: tx,dataSourceManager: manager })
  const workerFailures: number[] = []
  const worker = new PlmBomNotificationWorker(tx,reviewService,() => workerFailures.push(1))
  try { await worker.start(); await worker.tick() } finally { await worker.stop() }
  assert.deepEqual(workerFailures,[])
  const receipts = (await pool.query(`SELECT n.* FROM meta_record_subscription_notifications n
    JOIN meta_plm_bom_review_notification_events e ON n.source_event_id='bom-review:'||e.id::text WHERE e.binding_id=$1`,[binding.id])).rows
  assert.equal(receipts.length,1); assert.equal(receipts[0].user_id,'browser-member')
  await mp.goto(webOrigin + nativePath)
  await mp.locator('[data-test="notification-bell-btn"]').click()
  await expect(mp.locator('[data-test="notification-message"]').filter({ hasText: 'BOM 评审问题通知' })).toHaveCount(1)
  await mp.screenshot({ path: join(output!,'native-notification-centre.png'),fullPage: true })
  const issueId = (await pool.query('SELECT id FROM meta_views WHERE sheet_id=$1 AND name=$2',[binding.sheetId,'问题项'])).rows[0].id
  await mp.goto(`${webOrigin}/multitable/${binding.sheetId}/${issueId}?baseId=${binding.baseId}`)
  await expect(mp.locator('.meta-grid__cell[aria-label="备注"]')).toHaveCount(1)
  await expect(mp.locator('.meta-grid__cell[aria-label="评审状态"]')).toContainText('有问题')
  observed.nativeBrowserIssueReceiptAndPositiveFilter = true
  for (const value of ['已完成','评审中','有问题']) assert.equal((await mutate([{ fieldId: local['评审状态'],value }])).status,200)
  await reviewService.scanNotifications(binding.id)
  const nextEvent = (await pool.query(`SELECT id FROM meta_plm_bom_review_notification_events WHERE binding_id=$1 AND kind='issue' ORDER BY round DESC LIMIT 1`,[binding.id])).rows[0].id
  assert.equal((await reviewService.prepareNotification(nextEvent)).state,'prepared')
  await pool.query("UPDATE users SET is_active=false WHERE id='browser-member'")
  try {
    assert.deepEqual(await reviewService.deliverNotification(nextEvent),{ state: 'cancelled',inserted: 0 })
    assert.equal((await request('browser-member','/api/multitable/record-subscription-notifications')).status,401)
    assert.equal((await pool.query('SELECT count(*)::int n FROM meta_record_subscription_notifications WHERE source_event_id=$1',['bom-review:'+nextEvent])).rows[0].n,0)
  } finally { await pool.query("UPDATE users SET is_active=true WHERE id='browser-member'") }
  observed.revokedRecipientCancelsPreparedNextRound = true
  // Actual short SLA interval in the isolated fixture; no public clock injection.
  const dueNow = await mutate([{ fieldId: local['截止时间'],value: new Date(Date.now()+10*60000).toISOString() }])
  assert.equal(dueNow.status,200,JSON.stringify(dueNow.body))
  await panel()
  await page.getByRole('button',{ name: '配置通知规则',exact: true }).click()
  await page.getByTestId('sla-minutes').fill('1')
  const shortSlaSaved = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/notifications') && r.request().method() === 'POST')
  await page.getByTestId('save-notifications').click(); assert.equal((await shortSlaSaved).status(),200)
  await page.getByRole('button',{ name: '关闭配置',exact: true }).click()
  await page.getByRole('dialog',{ name: 'BOM 协作表' }).getByRole('button',{ name: '关闭',exact: true }).click()
  const issueStarted = (await pool.query('SELECT issue_started_at FROM meta_plm_bom_review_rounds WHERE record_id=$1 ORDER BY round DESC LIMIT 1',[issueRow.id])).rows[0].issue_started_at as Date
  const laterWorker = new PlmBomNotificationWorker(tx,reviewService,() => workerFailures.push(1))
  const waitStarted = Date.now()
  try {
    await laterWorker.start()
    await delay(Math.max(0,issueStarted.getTime()+60000-Date.now())+100)
    await laterWorker.tick(); await laterWorker.tick()
  } finally { await laterWorker.stop() }
  assert.deepEqual(workerFailures,[])
  const delivered = (await pool.query(`SELECT e.kind,n.message FROM meta_record_subscription_notifications n
    JOIN meta_plm_bom_review_notification_events e ON n.source_event_id='bom-review:'||e.id::text WHERE e.binding_id=$1 ORDER BY e.kind`,[binding.id])).rows
  assert.deepEqual(delivered.map(r => r.kind),['escalation','issue','reminder'])
  await mp.goto(webOrigin + nativePath)
  await mp.locator('[data-test="notification-bell-btn"]').click()
  for (const message of ['BOM 评审问题通知','BOM 评审截止提醒','BOM 评审问题 SLA 升级'])
    await expect(mp.locator('[data-test="notification-message"]').filter({ hasText: new RegExp('^'+message+'$') })).toHaveCount(1)
  await mp.screenshot({ path: join(output!,'native-three-notification-kinds.png'),fullPage: true })
  observed.actualShortSlaElapsed = { thresholdMs: 60000,waitMs: Date.now()-waitStarted,issueAgeMs: Date.now()-issueStarted.getTime() }
  observed.nativeBrowserThreeNotificationKinds = ['issue','reminder','escalation']
  // Real native table -> actual IntegrationWorkbench -> exact original per-source BOM.
  await expect(mp.locator('[data-action="open-plm-bom-source"]')).toHaveCount(0)
  await page.goto(webOrigin + nativePath)
  const returnLink = page.locator('[data-action="open-plm-bom-source"]')
  await expect(returnLink).toBeVisible({ timeout: 30000 })
  assert((await page.evaluate(() => JSON.parse(localStorage.getItem('user_permissions') || '[]'))).includes('integration:write'))
  observed.realWorkbenchNamespaceAdmission = true
  const beforeReturn = http.length
  await returnLink.click()
  await expect(page).toHaveURL(/\/integrations\/workbench\?section=cleaning-mapping&plmDataSourceId=w20-y-source&plmPartId=root#int-sec-object-template/)
  await expect(page.getByTestId('source-system')).toHaveValue('w20-y-system', { timeout: 30000 })
  await expect(page.getByTestId('plm-bom-review-part-input')).toHaveValue('root')
  await expect(page.getByTestId('plm-bom-review-load')).toBeEnabled()
  assert.equal(http.slice(beforeReturn).filter(x => x.path.endsWith('/bom-multitable/root/context')).length, 0, 'Returning only prefills; explicit Load owns the source fetch')
  observed.returnPrefillsOriginalSourceWithoutBomLoad = true
  await expect(page.getByTestId('source-system')).toBeInViewport()
  observed.returnLandsOnSourceSection = true
  await page.screenshot({ path: join(output!, 'return-prefilled.png'), fullPage: true })
  await page.getByTestId('plm-bom-review-load').click()
  await expect(page.getByTestId('plm-bom-review-state')).toHaveAttribute('data-state', 'table', { timeout: 30000 })
  const explicitLoads = http.slice(beforeReturn).filter(x => x.method === 'GET' && x.path.includes('/bom-multitable/'))
  assert.equal(explicitLoads.length, 1)
  assert.equal(explicitLoads[0].path, '/api/plm-workbench/data-sources/w20-y-source/bom-multitable/root/context')
  assert([200, 304].includes(explicitLoads[0].status), 'Express conditional response may reuse the current browser representation')
  observed.explicitOriginalSourceLoadStatus = explicitLoads[0].status
  await page.getByTestId('plm-bom-collaboration-open').click()
  await expect(page.getByRole('dialog')).toContainText('Actual browser BOM collaboration')
  await page.getByRole('button', { name: '打开协作表', exact: true }).click()
  await expect(page).toHaveURL(webOrigin + nativePath)
  await expect(returnLink).toBeVisible({ timeout: 30000 })
  observed.originalSourceTableRoundTrip = true
  observed.nonOwnerWithWorkbenchPermissionHasNoReturnLink = true
  await page.screenshot({ path: join(output!, 'return-roundtrip.png'), fullPage: true })
  const beforeInvalid = http.length
  await page.goto(webOrigin + '/integrations/workbench?section=cleaning-mapping&plmDataSourceId=missing-source&plmPartId=root#int-sec-object-template')
  await expect(page.getByTestId('plm-bom-return-unavailable')).toBeVisible({ timeout: 30000 })
  await expect(page.getByTestId('plm-bom-review-part-input')).toHaveCount(0)
  assert.equal(http.slice(beforeInvalid).filter(x => x.path.includes('/bom-multitable/')).length, 0)
  observed.unavailableSourceCannotFallback = true
  await writeFile(join(output!, 'vite.log'), viteLog)
  assert.deepEqual(errors, [], 'No uncaught page exceptions')
  assert.deepEqual(http.filter(r => r.status >= 500 && (r.path.startsWith('/api/multitable') || r.path.startsWith('/api/comments') || r.path.startsWith('/api/plm-bom-reviews') || r.path.startsWith('/api/plm-workbench'))), [], 'No core HTTP 5xx')
  exitCode = 0
} catch (error) {
  observed.failure = error instanceof Error ? error.message : String(error)
  console.error(observed.failure)
  const failurePages: Array<{ url: string; screenshot?: string }> = []
  for (const context of browser?.contexts() ?? []) {
    for (const page of context.pages()) {
      const name = `failure-page-${failurePages.length}.png`
      try { await page.screenshot({ path: join(output!, name), fullPage: true, timeout: 10000 }) }
      catch { /* Preserve the original assertion failure if the page is already closed. */ }
      failurePages.push({ url: page.url(), screenshot: name })
    }
  }
  observed.failurePages = failurePages
} finally {
  await browser?.close()
  if (vite && vite.exitCode === null && vite.signalCode === null) {
    const exited = new Promise<void>(r => vite!.once('exit', () => r()))
    vite.kill('SIGTERM'); await Promise.race([exited, delay(5000)])
    if (vite.exitCode === null && vite.signalCode === null) { vite.kill('SIGKILL'); await exited }
    observed.viteStopped = vite.exitCode !== null || vite.signalCode !== null
  }
  if (server) await new Promise<void>(r => server!.close(() => r()))
  await deactivateIntegration?.()
  await disposeManager?.()
  if (!closeGlobalPools) { const { poolManager } = runtimeRequire('../../src/integration/db/connection-pool.ts'); closeGlobalPools = () => poolManager.close() }
  await closeGlobalPools()
  const { messageBus } = runtimeRequire('../../src/integration/messaging/message-bus.ts')
  await messageBus.shutdown()
  await pool.end(); await sourcePool.end()
  if (envDir) await rm(envDir, { recursive: true, force: true })
  observed.finalActiveResources = process.getActiveResourcesInfo()
  await writeFile(join(output!, 'browser-result.json'), JSON.stringify({ exitCode, observed, http, pageErrors: errors }, null, 2) + '\n')
  process.exitCode = exitCode
}
