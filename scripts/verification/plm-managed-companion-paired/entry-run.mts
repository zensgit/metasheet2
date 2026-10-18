import { createRequire } from 'node:module'
import { writeSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const input = JSON.parse(await readFile('/dev/stdin', 'utf8'))
const root = input.metaCheckout + '/packages/core-backend'
const web = input.metaCheckout + '/apps/web'
const rootPartId: string = input.rootPartId ?? 'part'
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
  rootPartId,
  ownerOptIn: true,
})
assert.equal(link.generation, 1)

const ds = await import(root + '/src/routes/data-sources.ts')
await ds.initializeDataSourceManager(db)
const { jwtAuthMiddleware } = await import(root + '/src/auth/jwt-middleware.ts')
const { isGateException } = await import(root + '/src/auth/api-path-policy.ts')
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
const { authRouter } = await import(root + '/src/routes/auth.ts')
const app = express()
app.use(express.json())
app.use((req, res, next) => {
  if (isGateException(req.path)) return next()
  return jwtAuthMiddleware(req, res, next)
})
app.use('/api/auth', authRouter)
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
const vite = await createServer({
  appType: 'spa',
  configFile: false,
  root: web,
  envDir: process.cwd(),
  cacheDir: process.cwd() + '/vite-cache-entry',
  logLevel: 'error',
  resolve: { alias: { '@': web + '/src' } },
  plugins: [vue()],
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
const page = await context.newPage()
page.setDefaultTimeout(60000)
const seen: string[] = []
const apiStatus: string[] = []
page.on('request', (request) => {
  const url = request.url()
  seen.push(url.split('?')[0])
  const params = new URL(url).searchParams
  assert(!params.has('code_verifier') && !params.has('client_secret'))
  assert(!url.includes('embed-token') && !url.includes('embedToken'))
})
page.on('response', (response) => {
  const url = response.url().split('?')[0]
  if (url.includes('/api/')) apiStatus.push(`${response.status()} ${url.replace(input.origin, '')}`)
})
page.on('pageerror', (error) => {
  writeSync(2, `PAGEERROR ${error.message}\n`)
})

let proved = false
try {
  const entry = new URLSearchParams({
    issuer: input.issuer,
    tenant_id: 'default',
    org_id: 'fixture-org',
    client_id: 'managed-fixture',
    root_part_id: rootPartId,
    native_subject_hint: '42',
  })
  if (input.workspaceEntry) {
    await page.goto(input.nativeOrigin + '/login?next=%2Fworkspace', { waitUntil: 'domcontentloaded', timeout: 120000 })
    await page.fill('#tenant-id', 'default')
    await page.fill('#org-id', 'fixture-org')
    await page.fill('#username', 'writer')
    await page.fill('#password', 'synthetic-browser-password')
    await page.click('#submit')
    await page.waitForURL((url) => url.pathname === '/workspace')
    await page.click('[data-tab="bom"]')
    await page.locator('#metasheet-review-button').waitFor({ state: 'visible' })
    await page.evaluate((partId: string) => {
      (document.querySelector('#item-type') as HTMLInputElement).value = 'Part';
      (document.querySelector('#item-id') as HTMLInputElement).value = partId;
      (document.querySelector('#api-base') as HTMLInputElement).value = 'https://evil.example/api';
      (document.querySelector('#bearer-token') as HTMLInputElement).value = 'forged-no-authority';
    }, rootPartId)
    const [launch] = await Promise.all([
      page.waitForRequest((request) => request.url().endsWith('/api/v1/auth/managed-login/launch')),
      page.click('#metasheet-review-button'),
    ])
    assert.equal(launch.method(), 'POST')
    assert.deepEqual(launch.postDataJSON(), { root_part_id: rootPartId })
    assert.equal(launch.headers()['authorization'], undefined)
    assert.equal(launch.headers()['x-tenant-id'], undefined)
    assert.equal(launch.headers()['x-org-id'], undefined)
    assert.equal(launch.headers()['x-yuantus-ui-request'], 'managed-login')
    assert(!seen.some((url) => url.startsWith('https://evil.example')))

  } else {
    await page.goto(input.origin + '/plm/managed-entry?' + entry.toString(), { waitUntil: 'domcontentloaded', timeout: 120000 })
  }
  await page.waitForURL(/\/(login|managed-login)/, { timeout: 120000 })
  if (page.url().includes('/login')) {
    await page.fill('#tenant-id', 'default')
    await page.fill('#org-id', 'fixture-org')
    await page.fill('#username', 'writer')
    await page.fill('#password', 'synthetic-browser-password')
    await page.click('#submit')
    await page.waitForURL(/\/managed-login/, { timeout: 60000 })
  }
  await page.locator('#continue:not([disabled])').click()
  await page.waitForURL((url) => url.pathname === '/plm/bom-review', { timeout: 120000 })
  assert(page.url().startsWith(input.origin + '/plm/bom-review'))
  assert(page.url().includes('managed=ready'))
  assert(!page.url().includes('code='))
  await page.locator('[data-testid="plm-bom-review-row"][data-bom-line-id="line"]').waitFor({ timeout: 60000 })
  const storage = await page.evaluate(`(() => {
    const read = (area) => Object.keys(area).map((key) => area.getItem(key) || '').join('\\n')
    return {
      auth: localStorage.getItem('auth_token'),
      jwt: localStorage.getItem('jwt'),
      dev: localStorage.getItem('devToken'),
      dump: read(localStorage) + '\\n' + read(sessionStorage),
    }
  })()`) as { auth: string | null; jwt: string | null; dev: string | null; dump: string }
  assert.equal(storage.auth, null)
  assert.equal(storage.jwt, null)
  assert.equal(storage.dev, null)
  assert(!/yur_[A-Za-z0-9._~-]{30,}/.test(storage.dump))
  assert.equal(page.frames().length, 1)
  assert(!seen.some((url) => url.includes('/api/auth/dev-token')))
  assert(!seen.some((url) => url.includes('/api/plm-embed')))
  assert(seen.some((url) => url.includes('/api/plm/managed-login/current')))
  const openSessions = await pool.query(`SELECT count(*)::int AS n FROM plm_managed_sessions WHERE revoked_at IS NULL`)
  assert.equal(openSessions.rows[0].n, 1)

  const ownerContext = await browser.newContext({ ignoreHTTPSErrors: true })
  await ownerContext.addInitScript({
    content: `localStorage.setItem('auth_token', ${JSON.stringify(loginJwt)})`,
  })
  const ownerPage = await ownerContext.newPage()
  ownerPage.setDefaultTimeout(60000)
  const ownerSeen: string[] = []
  ownerPage.on('request', (request) => ownerSeen.push(request.url().split('?')[0]))
  await ownerPage.goto(input.origin + '/plm/bom-review?dataSourceId=source-1&partId=' + encodeURIComponent(rootPartId), { waitUntil: 'domcontentloaded', timeout: 120000 })
  await ownerPage.getByTestId('plm-managed-start').click()
  await ownerPage.waitForURL(/\/(login|managed-login)/, { timeout: 120000 })
  assert(ownerSeen.some((url) => url.includes('/api/plm/managed-login/start')))
  assert(!ownerSeen.some((url) => url.includes('/api/auth/dev-token')))
  await ownerPage.close()
  await ownerContext.close()

  writeSync(1, 'ENTRY_BOOTSTRAP_PROOF ' + JSON.stringify({
    ok: true,
    bom_line: 'line',
    open_sessions: 1,
    dev_token_requests: 0,
    embed_requests: 0,
    ordinary_owner_start: true,
    meta_user: 'meta-owner',
    native_subject_hint: '42',
    native_workspace_launch: Boolean(input.workspaceEntry),
    root_part_id: rootPartId,
  }) + '\n')
  proved = true
} catch (error) {
  const text = await page.locator('body').innerText().catch(() => '')
  writeSync(2, `PAGE ${page.url()}\n${text.slice(0, 1200)}\nAPI ${apiStatus.join(' | ')}\n`)
  await page.screenshot({ path: '/tmp/plm-managed-b2b-entry-fail.png', fullPage: true }).catch(() => undefined)
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
