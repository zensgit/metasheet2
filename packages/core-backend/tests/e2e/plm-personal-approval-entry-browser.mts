// Real main.ts entry rehearsal with owned PostgreSQL, production auth/routes and Chrome.
// No Yuantus grant issuance or DingTalk network: those remain separate cross-stack acceptance.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHmac, randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import express from 'express'
import { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { chromium, expect } from '@playwright/test'
import { bootstrapPlmBomReviewTestDb } from '../plm-bom-review/bootstrap'
import { bootstrapPlmBomReviewAuthTestDb } from '../plm-bom-review/auth-bootstrap'

const require = createRequire(import.meta.url)
const repo = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const output = resolve(process.env.W22_BROWSER_OUTPUT || '')
const pg = process.env.W22_PG_BIN
assert(process.env.W22_BROWSER_OUTPUT && pg, 'W22_BROWSER_OUTPUT and W22_PG_BIN required')
assert(process.versions.node.startsWith('20.'), 'Node 20 required')
await mkdir(output, { recursive: false })
const work = await mkdtemp(join(tmpdir(), 'w22-entry-browser-'))
const socket = join(work, 's'), data = join(work, 'pg')
await mkdir(socket, { mode: 0o700 })
const report: any = { exitCode: 1, checks: {}, observations: {}, commands: [], http: [], pageErrors: [], cleanup: false }
const observed = report.observations
let pool: Pool | undefined
let server: ReturnType<ReturnType<typeof express>['listen']> | undefined
let vite: ReturnType<typeof spawn> | undefined
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let viteLog = ''
const started = Date.now()
function command(name: string, args: string[]) {
  const out = execFileSync(join(pg!, name), args, { encoding: 'utf8', timeout: 30000, env: { ...process.env, LC_ALL: 'C' } })
  report.commands.push({ executable: join(pg!, name), args, exitCode: 0 })
  return out
}
async function port() {
  const s = createServer(); await new Promise<void>(r => s.listen(0, '127.0.0.1', r))
  const p = (s.address() as { port: number }).port
  await new Promise<void>(r => s.close(() => r())); return p
}
function check(name: string, value: boolean) { report.checks[name] = value; assert(value, name) }
let cleanupPromise: Promise<void> | undefined
function cleanup(): Promise<void> {
  if (cleanupPromise) return cleanupPromise
  cleanupPromise = (async () => {
    const failures: string[] = []
    async function close(name: string, action: () => Promise<unknown>) {
      try { await action() } catch (error) { failures.push(`${name}: ${error}`) }
    }
    await close('browser', async () => { await browser?.close() })
    await close('vite', async () => {
      if (!vite || vite.exitCode !== null || vite.signalCode !== null) return
      const exited = new Promise<void>(r => vite!.once('exit', () => r()))
      vite.kill('SIGTERM')
      await Promise.race([exited, delay(5000)])
      if (vite.exitCode === null && vite.signalCode === null) { vite.kill('SIGKILL'); await exited }
    })
    await close('http', async () => { if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())) } })
    await close('pools', async () => { await require('../../src/integration/db/connection-pool.ts').poolManager.close() })
    await close('messages', async () => { await require('../../src/integration/messaging/message-bus.ts').messageBus.shutdown() })
    await close('fixture-pool', async () => { await pool?.end() })
    await close('postgres', async () => { if (existsSync(join(data, 'postmaster.pid'))) command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']) })
    report.cleanupState = {
      failures, postgresStopped: !existsSync(join(data, 'postmaster.pid')),
      viteStopped: !vite || vite.exitCode !== null || vite.signalCode !== null,
      browserDisconnected: !browser || !browser.isConnected(), httpStopped: !server || !server.listening,
    }
    await writeFile(join(output, 'postgres.log'), await readFile(join(work, 'postgres.log')).catch(() => Buffer.from('')))
    await writeFile(join(output, 'vite.log'), viteLog)
    if (report.cleanupState.postgresStopped) await close('temporary-directory', async () => { await rm(work, { recursive: true, force: true }) })
    report.cleanupState.directoryRemoved = !existsSync(work)
    report.cleanup = failures.length === 0 && Object.entries(report.cleanupState).every(([key,value]) => key === 'failures' || value === true)
    if (!report.cleanup) report.exitCode = 1
    report.seconds = (Date.now() - started) / 1000
    await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n')
  })()
  return cleanupPromise
}
process.once('SIGTERM', () => {
  report.exitCode = 1; report.error = 'Runner interrupted by SIGTERM'
  void cleanup().finally(() => process.exit(1))
})
await writeFile(join(output, 'fixture.json'), JSON.stringify({ work, data, pg, nodePid: process.pid }) + '\n')
try {
  command('initdb', ['-D', data, '-A', 'trust', '-U', 'w22_owner', '--no-locale', '--encoding=UTF8'])
  command('pg_ctl', ['-D', data, '-l', join(work, 'postgres.log'), '-w', '-o', `-k ${socket} -p 55477 -h '' -c shared_buffers=16MB`, 'start'])
  command('createdb', ['-h', socket, '-p', '55477', '-U', 'w22_owner', 'w22_entries'])
  const webPort = await port(), webOrigin = `http://127.0.0.1:${webPort}`
  // The database address is constructed only from the owned temporary directory, never caller input.
  Object.assign(process.env, {
    DATABASE_URL: `postgresql://w22_owner@localhost/w22_entries?host=${socket}&port=55477`, DB_SSL: 'false',
    JWT_SECRET: 'w22-entry-browser-synthetic-jwt-not-production', RBAC_TOKEN_TRUST: 'false',
    PRODUCT_MODE: 'plm-workbench', ENABLE_PLM: 'true', NODE_ENV: 'production',
    PLM_APPROVAL_CARD_ENABLED: 'true', PLM_APPROVAL_CARD_CONNECTION_ID: 'entry-fixture',
    APPROVAL_CARD_LINK_SECRET: 'synthetic-w22-entry-link-key',
    PLM_BASE_URL: 'https://yuantus-fixture.invalid', PLM_API_MODE: 'yuantus', PLM_TENANT_ID: 'fixture', PLM_ORG_ID: 'fixture',
  })
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  await bootstrapPlmBomReviewTestDb(pool)
  await bootstrapPlmBomReviewAuthTestDb(pool)
  await pool.query(`CREATE TABLE approval_instances(id text PRIMARY KEY);
    INSERT INTO users(id,is_active,role,activation_status,local_password_set,permissions,name,email)
      VALUES('entry-owner',true,'user','activated',true,'{}','Entry Owner','entry-owner@synthetic.invalid'),
      ('entry-other',true,'user','activated',true,'{}','Entry Other','entry-other@synthetic.invalid');
    INSERT INTO user_permissions(user_id,permission_code) VALUES('entry-owner','approvals:act'),('entry-other','approvals:act');`)
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  for (const name of [
    'zzzz20260323120000_create_user_external_identities',
    'zzzz20260324143000_create_user_external_auth_grants',
    'zzzz20260324150000_create_directory_sync_tables',
    'zzzz20260705120000_create_dingtalk_approval_card_deliveries',
    'zzzz20260705150100_add_send_columns_to_dingtalk_approval_card_deliveries',
    'zzzz20260709133000_add_integration_id_to_dingtalk_approval_card_deliveries',
    'zzzz20260710150000_add_outcome_unknown_delivery_status',
    'zzzz20260710160000_add_task_id_index_to_dingtalk_approval_card_deliveries',
    'zzzz20260711120000_add_entry_epoch_to_dingtalk_approval_card_deliveries',
    'zzzz20261015040000_create_plm_personal_approval_cards',
  ]) await require(`../../src/db/migrations/${name}.ts`).up(db)
  const { authService } = require('../../src/auth/AuthService.ts')
  const { authRouter } = require('../../src/routes/auth.ts')
  const { approvalsRouter } = require('../../src/routes/approvals.ts')
  const { createPlmApprovalBindingsRouter } = require('../../src/routes/plm-approval-bindings.ts')
  const { PlmPersonalApprovalBindingService } = require('../../src/services/PlmPersonalApprovalBindingService.ts')
  const { createContainer } = require('../../src/di/container.ts')
  const { IPLMAdapter } = require('../../src/di/identifiers.ts')
  const adapter = createContainer().get(IPLMAdapter)
  await adapter.initializePersonalApproval()
  const service = new PlmPersonalApprovalBindingService(pool, () => adapter)
  const token = authService.createToken((await pool.query("SELECT * FROM users WHERE id='entry-owner'")).rows[0])
  const app = express(); app.use(express.json())
  app.use((req, res, next) => {
    if (req.headers.origin === webOrigin) {
      res.setHeader('Access-Control-Allow-Origin', webOrigin)
      res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,x-tenant-id,x-org-id,x-request-id')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    }
    res.on('finish', () => report.http.push({ method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode }))
    if (req.method === 'OPTIONS') { res.sendStatus(204); return }; next()
  })
  app.use('/api/auth', authRouter)
  app.use('/api/me/plm-approval-bindings', createPlmApprovalBindingsRouter(service))
  app.use(approvalsRouter({ plmPersonalCards: service }))
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server!.once('listening', r))
  const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  report.runtime = { node: process.version, pg: command('postgres', ['--version']).trim(), api, webOrigin, ownedDirectory: work }
  const me = await fetch(api + '/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
  const principal = await me.json()
  check('real-auth-plm-focus', me.status === 200 && principal.data.user.id === 'entry-owner' && principal.data.features.mode === 'plm-workbench')
  check('ordinary-user', principal.data.user.role === 'user' && !principal.data.user.permissions.includes('*:*'))
  check('anonymous-binding-denied', (await fetch(api + '/api/me/plm-approval-bindings')).status === 401)
  await writeFile(join(work, '.env.development'), `VITE_API_URL=${api}\nVITE_API_BASE=${api}\n`)
  vite = spawn(process.execPath, [join(repo, 'apps/web/node_modules/vite/bin/vite.js'), '--config', 'vite.config.ts', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
    cwd: join(repo, 'apps/web'), env: { ...process.env, NODE_ENV: 'development', METASHEET_ENV_DIR: work }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  vite.stdout?.on('data', b => { viteLog += b }); vite.stderr?.on('data', b => { viteLog += b })
  for (let i = 0; i < 150; i++) { try { if ((await fetch(webOrigin)).ok) break } catch {} if (i === 149) throw new Error('Vite did not start'); await delay(200) }
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true })
  await writeFile(join(output, 'browser-ready.json'), JSON.stringify({ nodePid: process.pid }) + '\n')
  const owner = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
  await owner.addInitScript(jwt => { localStorage.setItem('metasheet_locale', 'zh-CN'); localStorage.setItem('auth_token', jwt) }, token)
  const page = await owner.newPage(); page.on('pageerror', e => report.pageErrors.push(e.message))
  await page.goto(webOrigin + '/settings')
  await expect(page.locator('.nav-actions a[href="/settings"]')).toBeVisible({ timeout: 30000 })
  await page.locator('.nav-actions a[href="/settings"]').click()
  await delay(500)
  observed.settingsPath = new URL(page.url()).pathname
  observed.settingsVisible = await page.getByRole('button', { name: '管理 Yuantus 审批授权', exact: true }).isVisible()
  await page.screenshot({ path: join(output, 'settings.png'), fullPage: true })
  check('settings-binding-entry-visible', observed.settingsVisible === true)
  if (observed.settingsVisible) {
    await page.getByRole('button', { name: '管理 Yuantus 审批授权', exact: true }).click()
    await expect(page.locator('#plm-personal-grant')).toBeVisible()
    check('real-binding-api', report.http.some((h: any) => h.path === '/api/me/plm-approval-bindings' && h.status === 200))
    check('actual-grant-management-link', await page.getByRole('link', { name: '在 Yuantus 创建授权' }).getAttribute('href') === 'https://yuantus-fixture.invalid/personal-approval-grants')
    await expect(page.getByRole('button', { name: '验证并绑定个人授权', exact: true })).toBeDisabled()
    await page.screenshot({ path: join(output, 'binding-panel.png'), fullPage: true })
    await page.reload()
    await expect(page.getByRole('button', { name: '管理 Yuantus 审批授权', exact: true })).toBeVisible()
    check('settings-refresh-stays', new URL(page.url()).pathname === '/settings')
  }
  const decision = await owner.newPage(); decision.on('pageerror', e => report.pageErrors.push(e.message))
  const path = '/m/approval-decision?d=00000000-0000-4000-8000-000000000022&t=invalid-fixture-token'
  await decision.goto(webOrigin + path)
  await delay(1500)
  observed.decisionPath = new URL(decision.url()).pathname
  observed.decisionVisible = await decision.getByTestId('card-decision-page').isVisible()
  await decision.screenshot({ path: join(output, 'decision.png'), fullPage: true })
  check('both-real-main-entry-paths', observed.settingsPath === '/settings' && observed.settingsVisible && observed.decisionPath === '/m/approval-decision' && observed.decisionVisible)
  await expect(decision.getByTestId('card-decision-load-error')).toContainText('链接无效或已失效。')
  check('real-invalid-ledger-request-404', report.http.some((h: any) => h.path === '/api/approval-card-deliveries/00000000-0000-4000-8000-000000000022' && h.status === 404))
  check('invalid-card-zero-actions', await decision.getByTestId('card-decision-approve').count() === 0 && await decision.getByTestId('card-decision-reject').count() === 0)
  const summariesBefore = report.http.filter((h: any) => h.path.startsWith('/api/approval-card-deliveries/')).length
  await decision.goto(webOrigin + '/m/approval-decision')
  await expect(decision.getByTestId('card-decision-load-error')).toContainText('缺少必要参数')
  check('missing-parameters-no-summary', report.http.filter((h: any) => h.path.startsWith('/api/approval-card-deliveries/')).length === summariesBefore)
  // A real, signed but revoked PLM ledger row exercises summary/recipient checks without a Y call.
  const bindingId = randomUUID(), taskId = randomUUID(), stageId = randomUUID(), deliveryId = randomUUID()
  await pool.query(`INSERT INTO plm_personal_approval_bindings(id,owner_id,connection_id,subject_id,tenant_id,org_id,grant_id,expires_at)
    VALUES($1,'entry-owner','entry-fixture','42','fixture','fixture','synthetic-expired-grant','2000-01-01')`, [bindingId])
  await pool.query(`INSERT INTO plm_personal_approval_tasks(id,binding_id,source_task_id,source_round_id,source_eco_id,source_stage_id,active,task)
    VALUES($1,$2,$3,$4,$5,$6,false,'{"eco_name":"Revoked synthetic ECO"}')`, [taskId,bindingId,randomUUID(),randomUUID(),randomUUID(),stageId])
  await pool.query(`INSERT INTO dingtalk_approval_card_deliveries(id,plm_task_id,node_key,recipient_user_id,recipient_dingtalk_user_id,delivery_kind,card_state,send_status,entry_epoch)
    SELECT $1,id,source_stage_id,'entry-owner','synthetic-ding','work_notice_action_card','revoked','sent',entry_epoch FROM plm_personal_approval_tasks WHERE id=$2`, [deliveryId,taskId])
  const linkToken = createHmac('sha256', process.env.APPROVAL_CARD_LINK_SECRET!).update(deliveryId).digest('hex').slice(0,32)
  const stalePath = `/m/approval-decision?d=${deliveryId}&t=${linkToken}`
  await decision.goto(webOrigin + stalePath)
  await expect(decision.getByTestId('card-decision-title')).toHaveText('Revoked synthetic ECO')
  await expect(decision.getByTestId('card-decision-stale')).toBeVisible()
  check('signed-revoked-summary-no-actions', await decision.getByTestId('card-decision-approve').count() === 0 && await decision.getByTestId('card-decision-reject').count() === 0)
  await decision.screenshot({ path: join(output, 'revoked-card.png'), fullPage: true })
  await decision.goto(webOrigin + stalePath.replace(linkToken, '0'.repeat(32)))
  await expect(decision.getByTestId('card-decision-load-error')).toContainText('链接无效或已失效。')
  check('existing-card-bad-hmac-denied', true)
  const otherToken = authService.createToken((await pool.query("SELECT * FROM users WHERE id='entry-other'")).rows[0])
  const other = await browser.newContext()
  await other.addInitScript(jwt => { localStorage.setItem('metasheet_locale', 'zh-CN'); localStorage.setItem('auth_token', jwt) }, otherToken)
  const op = await other.newPage(); op.on('pageerror', e => report.pageErrors.push(e.message))
  await op.goto(webOrigin + stalePath)
  await expect(op.getByTestId('card-decision-load-error')).toContainText('链接无效或已失效。')
  check('foreign-recipient-no-actions', await op.getByTestId('card-decision-approve').count() === 0 && await op.getByTestId('card-decision-reject').count() === 0)
  const anonymous = await browser.newContext()
  await anonymous.addInitScript(() => localStorage.setItem('metasheet_locale', 'zh-CN'))
  const ap = await anonymous.newPage(); ap.on('pageerror', e => report.pageErrors.push(e.message))
  await ap.goto(webOrigin + '/settings')
  await expect.poll(() => {
    const url = new URL(ap.url())
    return { path: url.pathname, redirect: url.searchParams.get('redirect') }
  }).toEqual({ path: '/login', redirect: '/settings' })
  check('settings-requires-login', true)
  await ap.goto(webOrigin + path)
  await expect(ap.getByTestId('card-decision-login')).toBeVisible({ timeout: 15000 })
  check('decision-keeps-local-login-flow', new URL(ap.url()).pathname === '/m/approval-decision' && report.http.some((h: any) => h.path === '/api/auth/dingtalk/launch'))
  check('no-card-command-or-grant-write', !report.http.some((h: any) => h.method === 'POST' && (h.path.includes('/actions') || h.path.includes('/plm-approval-bindings'))))
  check('no-page-errors', report.pageErrors.length === 0)
  report.exitCode = 0
} catch (error) {
  report.error ??= String(error)
} finally {
  await cleanup()
  process.exitCode = report.exitCode
  process.stdout.write(JSON.stringify({ exitCode: report.exitCode, observations: observed, cleanup: report.cleanup, seconds: report.seconds }) + '\n')
}
