import { createRequire } from 'node:module'
import { writeSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const input = JSON.parse(await readFile('/dev/stdin', 'utf8'))
const root = input.metaCheckout + '/packages/core-backend'
const web = input.metaCheckout + '/apps/web'
const require = createRequire(root + '/package.json')
const webRequire = createRequire(web + '/package.json')
assert(String(input.pgUrl).includes('/tmp/plm-managed-paired-'))
assert(input.origin.startsWith('http://127.0.0.1:'))
assert(input.nativeOrigin.startsWith('https://127.0.0.1:'))
assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0')
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: input.pgUrl,
  JWT_SECRET: 'paired-managed-secret-abcdefghijklmnopqrstuvwxyz',
  ENCRYPTION_KEY: 'paired-managed-synthetic-key',
  ENCRYPTION_SALT: 'paired-managed-synthetic-salt',
  LOG_LEVEL: 'error',
  RBAC_TOKEN_TRUST: 'true',
  PLM_MANAGED_COMPANION_ENABLED: 'true',
  PLM_PERSONAL_BOM_WRITE_ENABLED: 'true',
  PLM_API_TOKEN: 'shared-must-not-be-used',
  PLM_BASE_URL: 'http://127.0.0.1:9',
  PLM_MANAGED_COMPANION_CLIENTS_JSON: JSON.stringify([{
    issuer: input.issuer,
    clientId: 'managed-fixture',
    clientSecret: input.secret,
    callback: input.callback,
    origin: input.origin,
    nativeTenantId: 'default',
    nativeOrgId: 'fixture-org',
    nativeBaseUrl: input.nativeOrigin,
  }]),
})

const express = require('express')
const jwt = require('jsonwebtoken')
const { Pool } = require('pg')
const { Kysely, PostgresDialect } = require('kysely')
const pool = new Pool({ connectionString: input.pgUrl, max: 6 })
const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
const sourceConfig = {
  connection: {
    url: input.nativeOrigin + '/',
    headers: { 'x-tenant-id': 'default', 'x-org-id': 'fixture-org' },
  },
  options: { apiMode: 'yuantus', tenantId: 'default', orgId: 'fixture-org' },
}

await pool.query(`
  CREATE TABLE users (
    id text PRIMARY KEY, email text, username text, mobile text, name text, role text,
    permissions jsonb, password_hash text, is_active boolean, must_change_password boolean,
    activation_status text, local_password_set boolean, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE user_orgs (user_id text, org_id text, is_active boolean, created_at timestamptz DEFAULT now());
  CREATE UNIQUE INDEX user_orgs_user_org_uidx ON user_orgs (user_id, org_id);
  CREATE TABLE data_sources (
    id text PRIMARY KEY, name text, owner_id text, workspace_id text, tenant_id text, scope_kind text,
    type text, config jsonb, is_active boolean, deleted_at timestamptz, auto_connect boolean DEFAULT false
  );
  CREATE TABLE user_sessions (
    id text PRIMARY KEY, user_id text, issued_at timestamptz, expires_at timestamptz, last_seen_at timestamptz,
    revoked_at timestamptz, revoked_by text, revoke_reason text, ip_address text, user_agent text,
    created_at timestamptz, updated_at timestamptz
  );
  CREATE TABLE operation_audit_logs (
    id bigserial PRIMARY KEY, actor_id text, actor_type text, action text, resource_type text, resource_id text,
    request_id text, ip text, user_agent text, route text, status_code integer, latency_ms integer, meta jsonb,
    occurred_at timestamptz, created_at timestamptz
  );
`)
const { up: upManaged } = await import(root + '/src/db/migrations/zzzz20261018010000_create_plm_managed_companion.ts')
const { up: upBindings } = await import(root + '/src/db/migrations/zzzz20261017010000_create_plm_personal_bom_write_bindings.ts')
const { up: upIntents } = await import(root + '/src/db/migrations/zzzz20261017020000_create_plm_personal_bom_write_intents.ts')
await upManaged(db)
await upBindings(db)
await upIntents(db)
await pool.query(
  `INSERT INTO users (id, email, name, role, permissions, is_active, activation_status, must_change_password, local_password_set)
   VALUES ('meta-owner', 'owner@example.test', 'Owner', 'user', '[]'::jsonb, true, 'activated', false, true)`,
)
await pool.query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ('meta-owner', 'meta-org', true)`)
await pool.query(
  `INSERT INTO data_sources (id, name, owner_id, workspace_id, tenant_id, scope_kind, type, config, is_active, auto_connect)
   VALUES ('source-1', 'Paired PLM', 'meta-owner', 'workspace-1', 'meta-org', 'private', 'plm', $1::jsonb, true, false)`,
  [JSON.stringify(sourceConfig)],
)

const { provisionManagedLink } = await import(root + '/src/services/plm-managed-companion-flow.ts')
const link = await provisionManagedLink({ id: 'meta-owner', role: 'user', authenticatedTenantId: 'meta-org' }, {
  issuer: input.issuer,
  nativeAuthUserId: '42',
  nativeTenantId: 'default',
  nativeOrgId: 'fixture-org',
  metaUserId: 'meta-owner',
  metaTenantId: 'meta-org',
  metaOrgId: 'meta-org',
  dataSourceId: 'source-1',
  rootPartId: 'part',
  ownerOptIn: true,
})
assert.equal(link.generation, 1)

const ds = await import(root + '/src/routes/data-sources.ts')
await ds.initializeDataSourceManager(db)
const { jwtAuthMiddleware } = await import(root + '/src/auth/jwt-middleware.ts')
const managed = (await import(root + '/src/routes/plm-managed-companion.ts')).default
const { PlmPersonalBomWriteBindingService } = await import(root + '/src/services/PlmPersonalBomWriteBindingService.ts')
const { bindPlmPersonalBomWriteService } = await import(root + '/src/services/plm-personal-bom-write-http.ts')
const { PLMAdapter } = await import(root + '/src/data-adapters/PLMAdapter.ts')
const { Logger } = await import(root + '/src/core/logger.ts')
const writeTransport = new PLMAdapter(
  { get: async () => undefined } as never,
  new Logger('PairedManagedWriteTransport') as never,
  {
    id: 'stale-provider',
    type: 'plm',
    connection: {
      url: 'https://stale-native.invalid',
      headers: {
        Authorization: 'Bearer shared-must-not-be-used',
        'x-tenant-id': 'wrong-native-tenant',
        'x-org-id': 'wrong-native-org',
      },
    },
    options: { apiMode: 'yuantus' },
  } as never,
)
const service = new PlmPersonalBomWriteBindingService(pool, () => writeTransport)
bindPlmPersonalBomWriteService(service)
const { createPlmPersonalBomWriteBindingsRouter } = await import(root + '/src/routes/plm-personal-bom-write-bindings.ts')
const workbench = (await import(root + '/src/routes/plm-workbench.ts')).default
const app = express()
app.use(express.json())
app.use((req, res, next) => {
  if (req.path === '/api/plm/managed-login/callback') return next()
  return jwtAuthMiddleware(req, res, next)
})
app.use('/api/plm/managed-login', managed)
app.use('/api/me/plm-bom-write-bindings', createPlmPersonalBomWriteBindingsRouter(service))
app.use(workbench)
const metaServer = await new Promise<import('node:http').Server>((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
})
const metaBase = 'http://127.0.0.1:' + (metaServer.address() as { port: number }).port
const loginJwt = jwt.sign({
  userId: 'meta-owner', email: 'owner@example.test', role: 'user', roles: ['user'], perms: ['attendance:read'], tenantId: 'meta-org',
}, process.env.JWT_SECRET, { expiresIn: '10m' })

const { createServer } = await import(webRequire.resolve('vite'))
const { default: vue } = await import(webRequire.resolve('@vitejs/plugin-vue'))
const { chromium } = webRequire('@playwright/test')
const entryHtml = '<div id="app"></div><script type="module">import {createApp,h} from "vue";import {createRouter,createWebHistory,RouterView} from "vue-router";import {appRoutes} from "/src/router/appRoutes.ts";const route=appRoutes.find(r=>r.path==="/plm/bom-review");if(!route)throw new Error("customer BOM route missing");const router=createRouter({history:createWebHistory(),routes:[route]});const app=createApp({render:()=>h(RouterView)});app.use(router);await router.isReady();app.mount("#app")</script>'
const vite = await createServer({
  configFile: false,
  root: web,
  envDir: process.cwd(),
  cacheDir: process.cwd() + '/vite-cache',
  logLevel: 'error',
  resolve: { alias: { '@': web + '/src' } },
  plugins: [vue(), {
    name: 'owned-managed-browser-harness',
    configureServer(server) {
      server.middlewares.use('/plm/bom-review', async (_req, res) => {
        res.setHeader('Content-Type', 'text/html')
        res.end(await server.transformIndexHtml('/plm/bom-review', entryHtml))
      })
    },
  }],
  server: {
    host: '127.0.0.1',
    port: input.vitePort,
    strictPort: true,
    proxy: { '/api': { target: metaBase, changeOrigin: false } },
  },
})
await vite.listen()
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ ignoreHTTPSErrors: true })
await context.addInitScript((token: string) => localStorage.setItem('auth_token', token), loginJwt)
const page = await context.newPage()
page.setDefaultTimeout(30000)
const callbackUrls: string[] = []
page.on('request', (request) => {
  const url = request.url()
  if (url.includes('/api/plm/managed-login/callback')) callbackUrls.push(url.split('?')[0] + '?redacted')
  assert(!url.includes('yur_') && !url.includes('code_verifier') && !url.includes('client_secret'))
})

async function handshake(label: string): Promise<void> {
  await page.goto(input.origin + '/plm/bom-review?dataSourceId=source-1&partId=part')
  await page.getByTestId('plm-managed-start').click()
  await page.waitForURL(/\/(login|managed-login)/)
  if (page.url().includes('/login')) {
    await page.fill('#tenant-id', 'default')
    await page.fill('#org-id', 'fixture-org')
    await page.fill('#username', 'writer')
    await page.fill('#password', 'synthetic-browser-password')
    await page.click('#submit')
    await page.waitForURL(/\/managed-login/)
  }
  await page.locator('#continue:not([disabled])').click()
  await page.waitForURL(/managed=ready/)
  assert(page.url().startsWith(input.origin + '/plm/bom-review'))
  assert(!page.url().includes('code='))
  await page.locator('[data-testid="plm-bom-review-row"][data-bom-line-id="line"]').waitFor()
  assert((await page.getByTestId('plm-managed-ready').textContent())?.includes('元图读取会话已建立'))
  assert(label.length > 0)
}

async function meta(path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(metaBase + path, {
    method,
    headers: {
      authorization: 'Bearer ' + loginJwt,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

let proved = false
try {
  await handshake('first')
  await page.goto(input.nativeOrigin + '/personal-approval-grants#bom-write')
  await page.waitForFunction(() => {
    const text = document.querySelector('#status')?.textContent || ''
    return text !== '' && !text.includes('正在验证')
  })
  const grantStatus = (await page.locator('#status').innerText()).trim()
  assert.equal(grantStatus, '已验证当前登录。', grantStatus)
  await page.locator('#connection').selectOption('personal-fixture')
  await page.locator('#create:not([disabled])').click()
  await page.locator('#issued').waitFor()
  const grant = await page.locator('#secret').inputValue()
  assert(grant.startsWith('yuw_'))
  await page.goto(input.origin + '/plm/bom-review?dataSourceId=source-1&partId=part')
  await page.locator('[data-testid="plm-bom-review-row"][data-bom-line-id="line"]').waitFor()
  await page.getByTestId('plm-bom-write-bindings-open').click()
  await page.getByTestId('plm-bom-write-grant').fill(grant)
  await page.getByTestId('plm-bom-write-connection-id').fill('personal-fixture')
  const bindResponse = page.waitForResponse((response) => response.url().includes('/api/me/plm-bom-write-bindings') && response.request().method() === 'POST')
  await page.getByTestId('plm-bom-write-bind').click()
  const bindResult = await bindResponse
  assert.equal(bindResult.status(), 201, await bindResult.text())
  assert.equal(await page.getByTestId('plm-bom-write-grant').inputValue(), '')
  await page.getByTestId('plm-bom-write-binding-row').waitFor()
  await page.getByTestId('plm-bom-review-quantity-input').fill('4')
  const lineResponse = page.waitForResponse((response) => response.request().method() === 'PATCH')
  await page.getByTestId('plm-bom-review-save').click()
  const lineResult = await lineResponse
  assert.equal(lineResult.status(), 200, await lineResult.text())
  const audits = await pool.query(`SELECT action, status_code FROM operation_audit_logs`)
  assert(audits.rows.length > 0)

  const nativeLogout = await page.request.post(input.nativeOrigin + '/api/v1/auth/logout', {
    data: '{}',
    headers: {
      'content-type': 'application/json',
      origin: input.nativeOrigin,
      'x-yuantus-ui-request': 'logout',
    },
  })
  assert.equal(nativeLogout.status(), 204, await nativeLogout.text())
  const afterLogout = await page.request.get(input.origin + '/api/plm-workbench/data-sources/source-1/bom-multitable/part/context')
  const afterLogoutBody = await afterLogout.json()
  assert.notEqual(afterLogoutBody.available, true)

  const transferred = await meta('/api/plm/managed-login/links/' + link.linkId + '/transfer', 'POST', {})
  assert.equal(transferred.status, 200)
  assert.equal(transferred.body.state, 'acked')
  const afterTransfer = await meta('/api/plm-workbench/data-sources/source-1/bom-multitable/part/context')
  assert.notEqual(afterTransfer.body.available, true)

  const rebound = await meta('/api/plm/managed-login/links', 'POST', {
    issuer: input.issuer,
    nativeAuthUserId: '42',
    nativeTenantId: 'default',
    nativeOrgId: 'fixture-org',
    metaUserId: 'meta-owner',
    metaTenantId: 'meta-org',
    metaOrgId: 'meta-org',
    dataSourceId: 'source-1',
    rootPartId: 'part',
    ownerOptIn: true,
  })
  assert.equal(rebound.status, 200)
  assert.equal(rebound.body.generation, 2)
  await handshake('rebind')
  const lateTarget = page.url()
  process.kill(input.nativePid, 'SIGSTOP')
  await page.getByTestId('plm-managed-unlink').click()
  await page.getByTestId('plm-managed-status').waitFor()
  assert((await page.getByTestId('plm-managed-status').textContent())?.includes('等待元图确认'))
  const duringOutage = await meta('/api/plm/managed-login/session?dataSourceId=source-1')
  assert.equal(duringOutage.status, 200)
  assert.equal(duringOutage.body.pendingRevoke, true)
  process.kill(input.nativePid, 'SIGCONT')
  const retried = await meta('/api/plm/managed-login/revoke-retry', 'POST', { dataSourceId: 'source-1' })
  assert.equal(retried.status, 200)
  assert.equal(retried.body.ok, true)
  assert.equal(retried.body.state, 'acked')
  assert.deepEqual(Object.keys(retried.body).sort(), ['ok', 'state'])
  assert(!JSON.stringify(retried.body).includes('yur_'))
  await page.goto(callbackUrls.length ? input.origin + '/api/plm/managed-login/callback?code=late&state=late' : lateTarget)
  const revived = await pool.query(`SELECT count(*)::int AS n FROM plm_managed_sessions WHERE revoked_at IS NULL`)
  assert.equal(revived.rows[0].n, 0)
  const text = await page.locator('body').innerText()
  assert(!text.includes('yur_') && !text.includes(input.secret) && !text.includes(grant))
  writeSync(1, 'PAIRED_PROOF ' + JSON.stringify({
    ok: true,
    handshakes: 2,
    bom_line: 'line',
    write_patch: 200,
    meta_audit_rows: audits.rows.length,
    native_logout: 204,
    transfer: 'acked',
    rebind_generation: 2,
    revoke_outage: 'pending-then-acked',
    late_callback_open_sessions: 0,
    callback_urls_observed: callbackUrls.length,
  }) + '\n')
  proved = true
} catch (error) {
  writeSync(2, (error instanceof Error ? error.stack || error.message : String(error)) + '\n')
} finally {
  try { process.kill(input.nativePid, 'SIGCONT') } catch { /* already continued */ }
}

const failures: string[] = []
const steps: Array<[string, () => Promise<void>]> = [
  ['page', () => page.close({ runBeforeUnload: false })],
  ['browser', () => browser.close()],
  ['vite', () => vite.close()],
  ['metaServer', () => new Promise<void>((resolve, reject) => {
    metaServer.close((error) => error ? reject(error) : resolve())
  })],
  ['pool', () => pool.end()],
]
for (const [name, step] of steps) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      step(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(name + ' cleanup timed out')), 10000)
      }),
    ])
  } catch (error) {
    failures.push(name + ': ' + (error instanceof Error ? error.message : String(error)))
  } finally {
    if (timer) clearTimeout(timer)
  }
}
const cleanupOk = failures.length === 0
writeSync(1, 'CLEANUP_PROOF ' + JSON.stringify({ ok: cleanupOk, failures }) + '\n')
if (!proved || !cleanupOk) process.exit(1)
process.exit(0)
