/** Manual full workbench -> MetaSheetServer.start() -> disposable PostgreSQL acceptance. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { Socket } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hash } from 'bcryptjs'
import { chromium, expect } from '@playwright/test'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const web = resolve(repo, 'apps/web')
const output = resolve(repo, 'artifacts/timemachine-workbench')
const runId = randomUUID()
await mkdir(output, { recursive: true })
// A failed admission or interrupted rerun must never leave a previous PASS current.
await writeFile(resolve(output, 'evidence.json'), `${JSON.stringify({ runId, result: 'RUNNING' })}\n`)
const database = new URL(process.env.DATABASE_URL ?? 'http://invalid')
assert.equal(process.env.NODE_ENV, 'test', 'NODE_ENV=test required')
assert.equal(database.protocol, 'postgresql:')
assert.equal(database.hostname, '127.0.0.1')
assert.match(database.pathname, /^\/tm_browser_acceptance_[a-z0-9_]+$/)
assert.ok(database.port && !['5432', '5433', '5435'].includes(database.port), 'Dedicated PG port required')

const configPath = resolve(output, 'isolated-config.json')
await writeFile(configPath, '{}\n')
// Do not inherit customer endpoints, credentials, flags, Redis, or a repository config file.
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

const allowedPorts = new Set([Number(database.port)])
const networkErrors: string[] = []
const originalConnect = Socket.prototype.connect
Socket.prototype.connect = new Proxy(originalConnect, {
  apply(target, receiver, args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0]
    const options = typeof first === 'object' && first !== null ? first : { port: first, host: args[1] }
    if (options.path || !['127.0.0.1', '::1', 'localhost'].includes(options.host ?? 'localhost')
      || !allowedPorts.has(Number(options.port))) {
      networkErrors.push('UNAPPROVED_SOCKET')
      throw new Error('UNAPPROVED_SOCKET')
    }
    return Reflect.apply(target, receiver, args)
  },
})
assert.throws(() => new Socket().connect({ host: '127.0.0.1', port: 1 }), /UNAPPROVED_SOCKET/)
assert.deepEqual(networkErrors.splice(0), ['UNAPPROVED_SOCKET'])

const { MetaSheetServer } = await import('../src/index')
const { poolManager } = await import('../src/integration/db/connection-pool')
const { messageBus } = await import('../src/integration/messaging/message-bus')
const { getSafetyGuard } = await import('../src/guards/SafetyGuard')
const { destroyIdempotency } = await import('../src/guards/idempotency')
const q = (sql: string, params: unknown[] = []) => poolManager.get().query(sql, params)
let app: InstanceType<typeof MetaSheetServer> | undefined
let databaseAdmitted = false
const webRequire = createRequire(resolve(web, 'package.json'))
const { createServer } = await import(pathToFileURL(webRequire.resolve('vite')).href)
let vite: Awaited<ReturnType<typeof createServer>> | undefined
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
const baseId = `tm_workbench_base_${suffix}`
const sheetId = `tm_workbench_sheet_${suffix}`
const peerSheetId = `tm_workbench_peer_${suffix}`
const viewId = `tm_workbench_view_${suffix}`
const userId = `tm_workbench_admin_${suffix}`
const fields = [`tm_workbench_name_${suffix}`, `tm_workbench_qty_${suffix}`]
const records = [`tm_workbench_row1_${suffix}`, `tm_workbench_row2_${suffix}`]
const password = randomBytes(24).toString('hex')
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const evidence: Record<string, unknown> = {
  runId, result: 'RUNNING', fixture: 'synthetic-only', sourceHead: git('rev-parse', 'HEAD'), sourceTree: git('rev-parse', 'HEAD^{tree}'),
  worktreeClean: git('status', '--porcelain') === '',
  scriptSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
  backend: 'MetaSheetServer.start()', frontend: 'index.html -> src/main.ts -> appRoutes', cases: [],
}
const cases = evidence.cases as string[]
const errors: string[] = []
const snapshot = async () => ({
  fields: (await q('SELECT * FROM meta_fields WHERE sheet_id=$1 ORDER BY id', [sheetId])).rows,
  records: (await q('SELECT * FROM meta_records WHERE sheet_id=$1 ORDER BY id', [sheetId])).rows,
  views: (await q('SELECT * FROM meta_views WHERE sheet_id=$1 ORDER BY id', [sheetId])).rows,
})

try {
  assert.equal((await q('SELECT current_database() AS name')).rows[0].name, database.pathname.slice(1))
  assert.equal((await q(`SELECT pg_get_userbyid(datdba)=current_user AS owned
    FROM pg_database WHERE datname=current_database()`)).rows[0].owned, true, 'DATABASE_OWNER_REQUIRED')
  assert.equal((await q(`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname=current_database() AND pid<>pg_backend_pid()`)).rows[0].n, 0, 'EXCLUSIVE_DATABASE_REQUIRED')
  assert.equal((await q('SELECT count(*)::int AS n FROM directory_integrations')).rows[0].n, 0)
  assert.equal((await q("SELECT count(*)::int AS n FROM meta_bases WHERE id<>'base_legacy' OR owner_id IS NOT NULL OR workspace_id IS NOT NULL")).rows[0].n, 0, 'EMPTY_DATABASE_REQUIRED')
  for (const table of ['users', 'user_sessions', 'meta_sheets', 'meta_fields', 'meta_records', 'meta_views',
    'meta_record_revisions', 'meta_records_trash', 'meta_config_revisions', 'meta_field_value_tombstones', 'meta_link_tombstones']) {
    assert.equal((await q(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, 'EMPTY_DATABASE_REQUIRED')
  }
  databaseAdmitted = true
  evidence.databaseAdmission = 'owner/exclusive/empty'
  app = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
  await q(`INSERT INTO users (id,email,name,password_hash,role,is_active,activation_status,local_password_set,must_change_password)
    VALUES ($1,$2,'Recovery Tester',$3,'admin',true,'activated',true,false)`,
  [userId, `${userId}@example.test`, await hash(password, 10)])
  await q('INSERT INTO meta_bases (id,name,owner_id) VALUES ($1,$2,$3)', [baseId, 'Recovery acceptance', userId])
  for (const [index, id] of [sheetId, peerSheetId].entries()) {
    await q('INSERT INTO meta_sheets (id,base_id,name) VALUES ($1,$2,$3)',
      [id, baseId, index === 0 ? 'Recoverable projects' : 'Untouched peer'])
    await q(`INSERT INTO meta_views (id,sheet_id,name,type,filter_info,sort_info,group_info,hidden_field_ids,config)
      VALUES ($1,$2,'Saved grid','grid','{}','{}','{}','[]','{}')`, [index === 0 ? viewId : `${viewId}_peer`, id])
  }
  for (const [index, id] of fields.entries()) {
    await q('INSERT INTO meta_fields (id,sheet_id,name,type,property,"order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [id, sheetId, index === 0 ? 'Project' : 'Quantity', index === 0 ? 'string' : 'number', '{}', index])
  }
  for (const [index, id] of records.entries()) {
    await q('INSERT INTO meta_records (id,sheet_id,data,version) VALUES ($1,$2,$3::jsonb,1)',
      [id, sheetId, JSON.stringify({ [fields[0]]: `Synthetic project ${index}`, [fields[1]]: index + 7 })])
  }
  const before = await snapshot()
  await app.start()
  const backendAddress = app.getAddress()
  assert.ok(backendAddress && typeof backendAddress !== 'string')
  allowedPorts.add(backendAddress.port)
  const backendOrigin = `http://127.0.0.1:${backendAddress.port}`
  process.env.VITE_API_URL = backendOrigin
  process.env.VITE_API_BASE = backendOrigin
  vite = await createServer({
    root: web, configFile: resolve(web, 'vite.config.ts'), envDir: output, mode: 'development',
    cacheDir: resolve(output, 'vite-cache'), server: { host: '127.0.0.1', port: 0, strictPort: true },
  })
  await vite.listen()
  const frontendAddress = vite.httpServer?.address()
  assert.ok(frontendAddress && typeof frontendAddress !== 'string')
  allowedPorts.add(frontendAddress.port)
  const origin = `http://127.0.0.1:${frontendAddress.port}`
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/New_York', locale: 'en-US' })
  context.setDefaultTimeout(20_000)
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (['data:', 'blob:'].includes(url.protocol) || [origin, backendOrigin].includes(url.origin)) return route.continue()
    errors.push('UNAPPROVED_BROWSER_REQUEST')
    await route.abort('blockedbyclient')
  })
  await context.routeWebSocket('**/*', (socket) => {
    const url = new URL(socket.url())
    if (url.hostname === '127.0.0.1' && allowedPorts.has(Number(url.port))) socket.connectToServer()
    else { errors.push('UNAPPROVED_BROWSER_WEBSOCKET'); socket.close() }
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(`PAGE_ERROR:${error.name}:${error.message}`))
  page.on('requestfailed', (request) => errors.push(`REQUEST_FAILED:${new URL(request.url()).pathname}`))
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/api/') && !response.ok()) {
      errors.push(`API:${response.request().method()}:${new URL(response.url()).pathname}:${response.status()}`)
    }
  })
  const path = `/multitable/${sheetId}/${viewId}?baseId=${baseId}`
  try {
    await page.goto(`${origin}/login?redirect=${encodeURIComponent(path)}`)
    await page.locator('input[autocomplete="username"]').fill(`${userId}@example.test`)
    await page.locator('input[autocomplete="current-password"]').fill(password)
    await page.locator('button.login-submit').click()
    await expect(page).toHaveURL(`${origin}${path}`)
    await expect(page.locator('[data-action="open-history"]')).toBeVisible()
    await expect(page.getByText('Synthetic project 0', { exact: true })).toBeVisible()
    assert.equal((await q('SELECT count(*)::int AS n FROM user_sessions WHERE user_id=$1', [userId])).rows[0].n, 1)
    assert.deepEqual(await snapshot(), before)
    cases.push('real LoginView, persisted session, router and workbench load retained rows')
    await page.screenshot({ path: resolve(output, 'workbench.png'), animations: 'disabled' })
    await page.locator('[data-action="open-history"]').click()
    await expect(page.getByRole('dialog', { name: 'History', exact: true })).toBeVisible()
    cases.push('real workbench opens record history')
    await page.getByRole('dialog', { name: 'History', exact: true }).getByRole('button', { name: 'Close', exact: true }).click()
    const sheetNode = page.locator('[data-testid="rail-sheet-node"]').filter({ hasText: 'Recoverable projects' })
    await expect(sheetNode).toHaveCount(1)
    page.once('dialog', async (dialog) => {
      assert.equal(dialog.type(), 'confirm')
      assert.match(dialog.message(), /Recoverable projects/)
      await dialog.accept()
    })
    const deletedResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/multitable/sheets/${sheetId}`
      && response.request().method() === 'DELETE')
    await page.locator('[data-testid="rail-sheet-delete"]').first().click()
    assert.equal((await deletedResponse).status(), 200)
    await expect(sheetNode).toHaveCount(0)
    assert.ok((await q('SELECT deleted_at FROM meta_sheets WHERE id=$1', [sheetId])).rows[0].deleted_at)
    assert.deepEqual(await snapshot(), before)
    cases.push('workbench table deletion retains all rows, fields and views')
    await page.locator('[data-action="open-trash"]').click()
    const trash = page.locator('[data-test="sheet-trash"]')
    await expect(trash.locator('[data-test="sheet-trash-row"]')).toHaveCount(1)
    await expect(trash).toContainText('Recoverable projects')
    await trash.locator('[data-test="sheet-trash-restore"]').click()
    assert.ok((await q('SELECT deleted_at FROM meta_sheets WHERE id=$1', [sheetId])).rows[0].deleted_at)
    await page.screenshot({ path: resolve(output, 'table-restore-preview.png'), animations: 'disabled' })
    const restoredResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/multitable/sheets/${sheetId}/restore`)
    await trash.locator('[data-test="sheet-trash-confirm"]').click()
    assert.equal((await restoredResponse).status(), 200)
    await expect(trash.locator('[data-test="sheet-trash-row"]')).toHaveCount(0)
    assert.deepEqual(await snapshot(), before)
    cases.push('full workbench recycle bin explicitly restores the retained whole table')
    await page.getByRole('dialog', { name: 'Recycle bin', exact: true }).locator('.el-dialog__headerbtn').click()
    await expect(sheetNode).toHaveCount(1)
    await sheetNode.click()
    const row = page.locator('.meta-grid__row').filter({ hasText: 'Synthetic project 0' })
    await expect(row).toHaveCount(1)
    await row.locator('input[type="checkbox"]').check()
    const recordDeleted = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/multitable/records/${records[0]}`
      && response.request().method() === 'DELETE')
    await page.locator('.meta-grid__bulk-btn--danger').click()
    assert.equal((await recordDeleted).status(), 200)
    await expect(row).toHaveCount(0)
    await page.locator('[data-action="open-history"]').click()
    const history = page.getByRole('dialog', { name: 'History', exact: true })
    await expect(history.locator('[data-test="hist-batch"]')).toHaveCount(1)
    await expect(history).toContainText('Recovery Tester')
    await history.locator('[data-test="hist-batch"]').click()
    await expect(history.locator('[data-test="hist-diff-row"]')).toHaveCount(2)
    await expect(history.locator('[data-test="hist-diff-row"]').filter({ hasText: 'Project' })).toContainText('Synthetic project 0')
    await expect(history.locator('[data-test="hist-diff-row"]').filter({ hasText: 'Quantity' })).toContainText('7')
    await page.screenshot({ path: resolve(output, 'history-deleted-row.png'), animations: 'disabled' })
    await history.locator('[data-test="hist-restore-deleted-record"]').click()
    const deleted = page.getByRole('dialog', { name: 'Deleted records', exact: true })
    await expect(deleted.locator('[data-test="trash-record-details"] dt')).toHaveText(['Project', 'Quantity'])
    await expect(deleted.locator('[data-test="trash-record-details"] dd')).toHaveText(['Synthetic project 0', '7'])
    await deleted.locator('[data-test="trash-restore"]').click()
    assert.equal((await q('SELECT count(*)::int AS n FROM meta_records WHERE id=$1', [records[0]])).rows[0].n, 0)
    const recordRestored = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/multitable/records/${records[0]}/restore`)
    await deleted.locator('[data-test="trash-restore-confirm"]').click()
    assert.equal((await recordRestored).status(), 200)
    assert.deepEqual((await q('SELECT data FROM meta_records WHERE id=$1', [records[0]])).rows[0].data, before.records[0].data)
    assert.deepEqual((await q('SELECT * FROM meta_records WHERE id=$1', [records[1]])).rows[0], before.records[1])
    cases.push('workbench history shows named actor and every deleted value, then restores only that row')
    await page.getByRole('dialog', { name: 'History', exact: true }).getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.getByText('Synthetic project 0', { exact: true })).toBeVisible()
    await row.locator('[data-test="grid-open-record"]').click()
    const inspector = page.locator('.meta-record-drawer')
    await expect(inspector).toBeVisible()
    const inspectorHistory = page.waitForResponse((response) => new URL(response.url()).pathname
      === `/api/multitable/sheets/${sheetId}/records/${records[0]}/history`
      && response.request().method() === 'GET')
    await inspector.getByRole('tab', { name: 'History', exact: true }).click()
    const historyResponse = await inspectorHistory
    assert.equal(historyResponse.status(), 200)
    const historyEnvelope = await historyResponse.json()
    assert.equal(historyEnvelope.ok, true)
    const recordHistory = historyEnvelope.data
    assert.ok(Array.isArray(recordHistory.items) && recordHistory.items.length > 0)
    const historyRows = inspector.locator('.meta-record-drawer__history-item')
    await expect(historyRows).toHaveCount(recordHistory.items.length)
    await expect(historyRows.first()).toContainText('Recovery Tester')
    const deletedHistoryRow = historyRows.filter({ hasText: 'Deleted' })
    await expect(deletedHistoryRow).toHaveCount(1)
    await expect(deletedHistoryRow.locator('[data-test="history-field-diff"]')).toHaveCount(2)
    await expect(deletedHistoryRow).toContainText('Synthetic project 0')
    await expect(deletedHistoryRow).toContainText('Quantity')
    await expect(deletedHistoryRow.locator('[data-test="record-history-restore"]')).toHaveCount(0)
    await expect(historyRows.first().locator('time')).toHaveText(new Intl.DateTimeFormat('en-US', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23', timeZoneName: 'short', timeZone: 'America/New_York',
    }).format(new Date(recordHistory.items[0].createdAt)))
    await page.screenshot({ path: resolve(output, 'record-inspector-history.png'), animations: 'disabled' })
    cases.push('right-side record inspector loads real row history with deleted values, named actor and viewer-local time')
    await inspector.locator('.meta-record-drawer__close').click()
    await expect(inspector).toHaveCount(0)
    process.env.MULTITABLE_TOMBSTONE_CAPTURE_ENABLED = 'true'
    const beforeColumn = await snapshot()
    await page.locator('.mt-workbench__actions').getByRole('button', { name: 'Fields', exact: true }).click()
    const manager = page.locator('.meta-field-mgr')
    await manager.locator('.meta-field-mgr__row').filter({ hasText: 'Quantity' }).locator('.meta-field-mgr__action--danger').click()
    const columnDeleted = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/multitable/fields/${fields[1]}`
      && response.request().method() === 'DELETE')
    await manager.locator('.meta-field-mgr__btn-delete').click()
    assert.equal((await columnDeleted).status(), 200)
    await expect(manager.locator('.meta-field-mgr__row')).toHaveCount(1)
    await manager.locator('.meta-field-mgr__close').click()
    delete process.env.MULTITABLE_TOMBSTONE_CAPTURE_ENABLED
    process.env.MULTITABLE_ENABLE_CONFIG_UNDELETE = 'true'
    await page.locator('[data-action="open-config-history"]').click()
    const config = page.locator('[data-test="config-history"]')
    await config.locator('[data-test="config-history-filter-field"]').click()
    const revision = config.locator('.cfg-history__row').filter({ hasText: 'Delete field' })
    await expect(revision).toHaveCount(1)
    await expect(revision).toContainText('Quantity')
    await expect(revision).toContainText('Recovery Tester')
    await expect(revision.locator('.cfg-history__key[title="order"]')).toHaveText('Field order')
    const storedRevision = (await q(`SELECT actor_id,created_at FROM meta_config_revisions
      WHERE sheet_id=$1 AND entity_id=$2 AND action='delete'`, [sheetId, fields[1]])).rows
    assert.equal(storedRevision.length, 1)
    assert.equal(storedRevision[0].actor_id, userId)
    await expect(revision.locator('time')).toHaveText(new Intl.DateTimeFormat('en-US', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23', timeZoneName: 'short', timeZone: 'America/New_York',
    }).format(storedRevision[0].created_at))
    await revision.locator('[data-test="config-history-revert"]').click()
    await expect(config.locator('[data-test="config-restore-changes"]')).toContainText('will be restored where still applicable')
    await expect(config.locator('[data-test="config-restore-confirm-btn"]')).toBeDisabled()
    await config.locator('[data-test="config-restore-type-input"]').fill('undelete')
    const columnRestored = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/multitable/sheets/${sheetId}/config-restore-execute`)
    await config.locator('[data-test="config-restore-confirm-btn"]').click()
    assert.equal((await columnRestored).status(), 200)
    await expect(config.locator('[data-test="config-restore-confirm-btn"]')).toHaveCount(0)
    const afterColumn = await snapshot()
    assert.deepEqual(afterColumn.fields.map(({ id, name, type, property, order }) => ({ id, name, type, property, order })),
      beforeColumn.fields.map(({ id, name, type, property, order }) => ({ id, name, type, property, order })))
    assert.deepEqual(afterColumn.records.map(({ data }) => data), beforeColumn.records.map(({ data }) => data))
    await config.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.getByText('Quantity', { exact: true })).toBeVisible()
    await page.screenshot({ path: resolve(output, 'workbench-column-restored.png'), animations: 'disabled' })
    cases.push('workbench field delete shows viewer-local time, then typed config restore preserves the column and captured values')
    delete process.env.MULTITABLE_ENABLE_CONFIG_UNDELETE
    assert.deepEqual(errors, [])
    assert.deepEqual(networkErrors, [])
    evidence.result = 'PASS'
  } catch (error) {
    await page.screenshot({ path: resolve(output, 'failure.png'), animations: 'disabled' }).catch(() => undefined)
    await writeFile(resolve(output, 'failure.txt'), `${JSON.stringify({ errors, networkErrors })}\n${await page.locator('body').innerText()}`)
    throw error
  }
} finally {
  delete process.env.MULTITABLE_ENABLE_CONFIG_UNDELETE
  delete process.env.MULTITABLE_TOMBSTONE_CAPTURE_ENABLED
  const cleanupErrors: string[] = []
  const clean = async (name: string, operation: () => Promise<unknown> | void) => {
    try { await operation() } catch { cleanupErrors.push(name) }
  }
  await clean('browser', () => browser?.close())
  await clean('vite', () => vite?.close())
  if (databaseAdmitted) {
    for (const table of ['meta_record_revisions', 'meta_records_trash', 'meta_config_revisions', 'meta_field_value_tombstones', 'meta_link_tombstones']) {
      await clean(table, () => q(`DELETE FROM ${table} WHERE sheet_id=$1`, [sheetId]))
    }
    await clean('sheets', () => q('DELETE FROM meta_sheets WHERE base_id=$1', [baseId]))
    await clean('bases', () => q('DELETE FROM meta_bases WHERE id=$1', [baseId]))
    await clean('sessions', () => q('DELETE FROM user_sessions WHERE user_id=$1', [userId]))
    await clean('users', () => q('DELETE FROM users WHERE id=$1', [userId]))
    await clean('residue', async () => {
      const residue = (await q(`SELECT
      (SELECT count(*)::int FROM meta_bases WHERE id=$1) AS bases,
      (SELECT count(*)::int FROM meta_sheets WHERE base_id=$1) AS sheets,
      (SELECT count(*)::int FROM users WHERE id=$2) AS users,
      (SELECT count(*)::int FROM user_sessions WHERE user_id=$2) AS sessions,
      (SELECT count(*)::int FROM meta_fields WHERE sheet_id=ANY($3::text[])) AS fields,
      (SELECT count(*)::int FROM meta_records WHERE sheet_id=ANY($3::text[])) AS records,
      (SELECT count(*)::int FROM meta_views WHERE sheet_id=ANY($3::text[])) AS views,
      (SELECT count(*)::int FROM meta_record_revisions WHERE sheet_id=ANY($3::text[])) AS record_revisions,
      (SELECT count(*)::int FROM meta_records_trash WHERE sheet_id=ANY($3::text[])) AS record_trash,
      (SELECT count(*)::int FROM meta_config_revisions WHERE sheet_id=ANY($3::text[])) AS config_revisions,
      (SELECT count(*)::int FROM meta_field_value_tombstones WHERE sheet_id=ANY($3::text[])) AS value_tombstones,
      (SELECT count(*)::int FROM meta_link_tombstones WHERE sheet_id=ANY($3::text[])) AS link_tombstones`,
      [baseId, userId, [sheetId, peerSheetId]])).rows[0]
      assert.deepEqual(residue, {
        bases: 0, sheets: 0, users: 0, sessions: 0, fields: 0, records: 0, views: 0,
        record_revisions: 0, record_trash: 0, config_revisions: 0, value_tombstones: 0, link_tombstones: 0,
      })
      evidence.fixtureResidue = residue
    })
  }
  await clean('server', () => app?.stop('TM_WORKBENCH_ACCEPTANCE'))
  await clean('server-address', () => { if (app) assert.equal(app.getAddress(), null) })
  // These process-local singletons are initialized by the standard server entrypoint.
  await clean('safety-guard', () => { if (app) getSafetyGuard().destroy() })
  await clean('idempotency', () => destroyIdempotency())
  await clean('message-bus', () => messageBus.shutdown())
  await clean('database-pool', () => { if (!app || cleanupErrors.includes('server')) return poolManager.close() })
  Socket.prototype.connect = originalConnect
  evidence.cleanupErrors = cleanupErrors
  if (evidence.result !== 'PASS' || cleanupErrors.length) evidence.result = 'FAIL'
  await writeFile(resolve(output, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  assert.deepEqual(cleanupErrors, [], 'CLEANUP_FAILED')
}
console.log(`TM_WORKBENCH_PASS ${cases.length}`)
