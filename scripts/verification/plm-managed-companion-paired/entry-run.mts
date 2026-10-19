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
  PLM_MANAGED_SNAPSHOT_SHARE_ENABLED: input.snapshotShare ? 'true' : 'false',
  ...(input.snapshotShare ? { PLM_BOM_REVIEW_ENABLED: 'true', AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true', MULTITABLE_ENABLE_WRITER_FENCE: 'true' } : {}),
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

if (input.snapshotShare) {
  const { bootstrapPlmBomReviewTestDb } = await import(root + '/tests/plm-bom-review/bootstrap.ts')
  const { bootstrapBomReviewNativeHttpDb } = await import(root + '/tests/plm-bom-review/native-bootstrap.ts')
  await bootstrapPlmBomReviewTestDb(pool)
  await bootstrapBomReviewNativeHttpDb(pool)
  await pool.query(`ALTER TABLE users
    ALTER COLUMN permissions TYPE jsonb USING to_jsonb(permissions),
    ADD COLUMN email text, ADD COLUMN username text, ADD COLUMN mobile text, ADD COLUMN name text,
    ADD COLUMN password_hash text, ADD COLUMN must_change_password boolean,
    ADD COLUMN created_at timestamptz DEFAULT now(), ADD COLUMN updated_at timestamptz DEFAULT now();
    ALTER TABLE data_sources ADD COLUMN auto_connect boolean DEFAULT false;`)
} else {
  await pool.query(`  CREATE TABLE users (
    id text PRIMARY KEY, email text, username text, mobile text, name text, role text,
    permissions jsonb, password_hash text, is_active boolean, must_change_password boolean,
    activation_status text, local_password_set boolean, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE data_sources (
    id text PRIMARY KEY, name text, owner_id text, workspace_id text, tenant_id text, scope_kind text,
    type text, config jsonb, is_active boolean, deleted_at timestamptz, auto_connect boolean DEFAULT false
  );`)
}
await pool.query(`
  CREATE TABLE user_orgs (user_id text, org_id text, is_active boolean, created_at timestamptz DEFAULT now());
  CREATE UNIQUE INDEX user_orgs_user_org_uidx ON user_orgs (user_id, org_id);
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
if (input.snapshotShare) {
  const { up } = await import(root + '/src/db/migrations/zzzz20261019010000_create_plm_snapshot_share_intents.ts')
  await up(db)
}
if (input.snapshotPreReview) {
  const { ensureApprovalSchemaReady } = await import(root + '/tests/helpers/approval-schema-bootstrap.ts')
  await ensureApprovalSchemaReady()
  await pool.query(`ALTER TABLE users ADD COLUMN is_admin boolean DEFAULT false, ADD COLUMN department text;
    ALTER TABLE meta_bases ADD COLUMN created_at timestamptz DEFAULT now(), ADD COLUMN updated_at timestamptz DEFAULT now();
    CREATE TABLE permissions(code text PRIMARY KEY,name text,description text);`)
  const { up: submissions } = await import(root + '/src/db/migrations/zzzz20260915120000_create_multitable_record_approval_submissions.ts')
  const { up: submitPermission } = await import(root + '/src/db/migrations/zzzz20260915121000_add_multitable_submit_approval_permission.ts')
  const { up: namespaceAdmissions } = await import(root + '/src/db/migrations/zzzz20260411120000_create_user_namespace_admissions.ts')
  await namespaceAdmissions(db)
  await submissions(db)
  await submitPermission(db)
}
await pool.query(
  `INSERT INTO users (id, email, name, role, permissions, is_active, activation_status, must_change_password, local_password_set)
   VALUES ('meta-owner', 'owner@example.test', 'Owner', 'user', '[]'::jsonb, true, 'activated', false, true)`,
)
if (input.snapshotShare) {
  await pool.query("INSERT INTO meta_bases(id,owner_id,name,workspace_id) VALUES('share-target','meta-owner','Confirmed collaboration audience','workspace-1')")
}
await pool.query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ('meta-owner', 'meta-org', true)`)
await pool.query(
  `INSERT INTO data_sources (id, name, owner_id, workspace_id, tenant_id, scope_kind, type, config, is_active, auto_connect)
   VALUES ('source-1', 'Paired PLM', 'meta-owner', 'workspace-1', 'meta-org', 'private', 'plm', $1::jsonb, true, false)`,
  [JSON.stringify(sourceConfig)],
)

if (input.snapshotPreReview) {
  await pool.query(`INSERT INTO users(id,email,name,role,permissions,is_active,activation_status,local_password_set,must_change_password)
    VALUES('meta-reviewer','reviewer@example.test','Separate Meta Reviewer','user','[]'::jsonb,true,'activated',true,false);
    INSERT INTO user_orgs(user_id,org_id,is_active) VALUES('meta-reviewer','meta-org',true);`)
  for (const actor of ['meta-owner', 'meta-reviewer']) {
    for (const code of ['multitable:read','multitable:submit-approval','approvals:read','approvals:write']) {
      await pool.query('INSERT INTO permissions(code,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [code])
      await pool.query('INSERT INTO user_permissions(user_id,permission_code) VALUES($1,$2)', [actor, code])
    }
  }
}

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
if (input.snapshotShare) {
  const { createPlmBomReviewsRouter } = await import(root + '/src/routes/plm-bom-reviews.ts')
  const { univerMetaRouter } = await import(root + '/src/routes/univer-meta.ts')
  const { poolManager } = await import(root + '/src/integration/db/connection-pool.ts')
  app.use('/api/plm-bom-reviews', createPlmBomReviewsRouter({ pool: poolManager.get(), dataSourceManager: ds.getDataSourceManager() }))
  app.use('/api/multitable', univerMetaRouter())
  if (input.snapshotPreReview) {
    const { createMultitableRecordApprovalRoutes } = await import(root + '/src/routes/multitable-record-approvals.ts')
    app.use('/api/multitable', createMultitableRecordApprovalRoutes())
  }
}
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
    hmr: false,
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

  if (input.snapshotShare) {
    const panel = page.getByTestId('plm-snapshot-share')
    const targets = page.waitForResponse(response => response.url().includes('/managed-share/targets'))
    await panel.getByRole('button', { name: '分享 BOM 快照到协作空间' }).click()
    const targetsResponse = await targets
    assert.equal(targetsResponse.status(), 200, await targetsResponse.text())
    await panel.locator('select').selectOption('share-target')
    await panel.locator('input').fill('Native confirmed snapshot')
    await panel.getByRole('button', { name: '前往元图确认' }).click()
    await page.waitForURL(url => url.pathname === '/bom-snapshot-share')
    await page.locator('#consent:not([disabled])').waitFor()
    assert((await page.locator('#details').innerText()).includes('Confirmed collaboration audience'))
    assert.equal((await pool.query('SELECT count(*)::int n FROM meta_records')).rows[0].n, 0)
    await page.locator('#consent').check()
    await page.locator('#confirm').click()
    await page.waitForURL(url => url.origin === input.origin && url.pathname.startsWith('/multitable/'), { timeout: 120000 })
    await page.locator('.mt-workbench').waitFor({ state: 'visible', timeout: 90000 })
    await page.getByText('C-001', { exact: true }).first().waitFor({ state: 'visible', timeout: 90000 })
    const saved = (await pool.query("SELECT binding_id FROM plm_snapshot_share_intents WHERE status='published'")).rows
    assert.equal(saved.length, 1)
    const binding = (await pool.query('SELECT * FROM meta_plm_bom_review_bindings WHERE id=$1', [saved[0].binding_id])).rows[0]
    assert(binding?.sheet_id)
    assert((await pool.query('SELECT count(*)::int n FROM meta_records WHERE sheet_id=$1', [binding.sheet_id])).rows[0].n > 0)
    writeSync(1, 'SNAPSHOT_SHARE_PROOF ' + JSON.stringify({ ok: true, explicit_native_confirmation: true,
      pre_confirmation_records: 0, published_bindings: 1, destination_grid_rendered: true, native_rpc: 'real HTTP', target: 'share-target',
      installed_image: false, native_storage: 'isolated SQLite fixture', meta_storage: 'actual PostgreSQL' }) + '\n')
  }

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

  if (input.snapshotShare) {
    const binding = (await pool.query(`SELECT b.* FROM meta_plm_bom_review_bindings b
      JOIN plm_snapshot_share_intents i ON i.binding_id=b.id WHERE i.status='published'`)).rows[0]
    const exportUrl = metaBase + '/api/multitable/sheets/' + binding.sheet_id + '/export-xlsx?format=csv&viewId=' + binding.view_id
    const noExport = await fetch(exportUrl, { headers: { Authorization: 'Bearer ' + loginJwt } })
    assert.equal(noExport.status, 403, await noExport.text())
    // Independent existing Meta read/export permission; native consent never mints it.
    await pool.query("INSERT INTO user_permissions(user_id,permission_code) VALUES('meta-owner','multitable:read')")
    const exportJwt = jwt.sign({ userId: 'meta-owner', role: 'user', roles: ['user'], perms: ['multitable:read'], tenantId: 'meta-org' },
      process.env.JWT_SECRET, { expiresIn: '5m' })
    const ownerHeaders = { Authorization: 'Bearer ' + exportJwt }
    const exported = await fetch(exportUrl, { headers: ownerHeaders })
    assert.equal(exported.status, 200, await exported.clone().text())
    assert((await exported.text()).includes('C-001'))
    await pool.query(`INSERT INTO users(id,role,permissions,is_active,activation_status,local_password_set,must_change_password)
      VALUES('target-outsider','user','[]'::jsonb,true,'activated',true,false)`)
    const outsiderJwt = jwt.sign({ userId: 'target-outsider', role: 'user', roles: ['user'], perms: ['attendance:read'], tenantId: 'meta-org' },
      process.env.JWT_SECRET, { expiresIn: '5m' })
    const refused = await fetch(exportUrl, { headers: { Authorization: 'Bearer ' + outsiderJwt } })
    assert.equal(refused.status, 403, await refused.text())
    if (input.snapshotPreReview) {
      const { ApprovalProductService } = await import(root + '/src/services/ApprovalProductService.ts')
      const approvals = new ApprovalProductService()
      const template = await approvals.createTemplate({ key: 'snapshot-review-' + Date.now(), name: 'Snapshot collaboration pre-review',
        visibilityScope: { type: 'all', ids: [] }, formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] },
        approvalGraph: { nodes: [ { key: 'start', type: 'start', name: 'Start', config: {} },
          { key: 'approval_1', type: 'approval', name: 'Separate reviewer', config: {
            assigneeSources: [{ kind: 'static_user', userIds: ['meta-reviewer'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
          { key: 'end', type: 'end', name: 'End', config: {} } ],
          edges: [{ key: 'start-review', source: 'start', target: 'approval_1' }, { key: 'review-end', source: 'approval_1', target: 'end' }] } })
      await approvals.publishTemplate(template.id, { policy: { allowRevoke: true } })
      const record = (await pool.query('SELECT id FROM meta_records WHERE sheet_id=$1 ORDER BY id LIMIT 1', [binding.sheet_id])).rows[0]
      const url = metaBase + '/api/multitable/sheets/' + binding.sheet_id + '/records/' + record.id + '/approvals'
      const before = await pool.query('SELECT data,version FROM meta_records WHERE id=$1', [record.id])
      const body = JSON.stringify({ templateId: template.id, formData: { summary: 'Review the authorized snapshot; no native mutation' } })
      const missingSubmit = await fetch(url, { method: 'POST', headers: { ...ownerHeaders, 'content-type': 'application/json' }, body })
      assert.equal(missingSubmit.status, 403, await missingSubmit.text())
      const reviewJwt = jwt.sign({ userId: 'meta-owner', role: 'user', roles: ['user'], tenantId: 'meta-org',
        perms: ['multitable:read','multitable:submit-approval','approvals:read','approvals:write'] }, process.env.JWT_SECRET, { expiresIn: '5m' })
      const submitted = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + reviewJwt, 'content-type': 'application/json' }, body })
      assert.equal(submitted.status, 201, await submitted.clone().text())
      const submission = (await pool.query('SELECT * FROM multitable_record_approval_submissions WHERE record_id=$1', [record.id])).rows[0]
      assert.equal(submission.status, 'pending')
      const { loadAuthorizedApprovalActor } = await import(root + '/src/multitable/automation-approval-bridge-service.ts')
      await approvals.dispatchAction(submission.approval_instance_id, { action: 'approve', comment: 'Snapshot reviewed' }, await loadAuthorizedApprovalActor('meta-reviewer'))
      const instance = (await pool.query('SELECT status FROM approval_instances WHERE id=$1', [submission.approval_instance_id])).rows[0]
      assert.equal(instance.status, 'approved')
      const event = (await pool.query("SELECT payload FROM meta_automation_outbox WHERE event_type='approval.approved' AND payload->'approval'->>'instanceId'=$1", [submission.approval_instance_id])).rows
      assert.equal(event.length, 1)
      const { createRecordApprovalCompletionSink, createPoolTransactionRunner } = await import(root + '/src/multitable/record-approval-submission-service.ts')
      const { poolManager } = await import(root + '/src/integration/db/connection-pool.ts')
      const actualPool = poolManager.get()
      const sink = createRecordApprovalCompletionSink(actualPool.query.bind(actualPool), { runInTransaction: createPoolTransactionRunner(actualPool) })
      await sink.handleApprovalCompletion(event[0].payload)
      await sink.handleApprovalCompletion(event[0].payload)
      assert.equal((await pool.query('SELECT status FROM multitable_record_approval_submissions WHERE id=$1', [submission.id])).rows[0].status, 'approved')
      assert.equal((await pool.query("SELECT count(*)::int n FROM meta_record_subscription_notifications WHERE sheet_id=$1 AND record_id=$2 AND event_type='notification.sent'", [binding.sheet_id,record.id])).rows[0].n, 1)
      assert.deepEqual((await pool.query('SELECT data,version FROM meta_records WHERE id=$1', [record.id])).rows, before.rows)
      writeSync(1, 'SNAPSHOT_PRE_REVIEW_PROOF ' + JSON.stringify({ ok: true, imported_record: true, missing_submit_permission_forbidden: true,
        real_approval_engine: true, separate_meta_reviewer: true, actual_durable_event_replayed_twice: true, one_completion_notification: true, snapshot_record_unchanged: true }) + '\n')
    }
    const unlinked = await fetch(metaBase + '/api/plm/managed-login/unlink', { method: 'POST',
      headers: { ...ownerHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ dataSourceId: 'source-1' }) })
    assert.equal(unlinked.status, 200, await unlinked.clone().text())
    assert.equal((await unlinked.json() as { state: string }).state, 'acked')
    const retained = await fetch(exportUrl, { headers: ownerHeaders })
    assert.equal(retained.status, 200, await retained.clone().text())
    assert((await retained.text()).includes('C-001'))
    const targetsAfterUnlink = await context.request.get(input.origin + '/api/plm-bom-reviews/managed-share/targets?dataSourceId=source-1&partId=' + encodeURIComponent(rootPartId))
    assert([401,403].includes(targetsAfterUnlink.status()), await targetsAfterUnlink.text())
    writeSync(1, 'SNAPSHOT_EXPORT_PROOF ' + JSON.stringify({ ok: true, generic_csv_export: true,
      ungranted_export_forbidden: true, outsider_without_target_read_forbidden: true, unlink_acknowledged: true, retained_target_acl_export: true, new_share_after_unlink_refused: true }) + '\n')
  }

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
