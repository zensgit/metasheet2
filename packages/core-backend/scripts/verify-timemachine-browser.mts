/** Manual synthetic browser -> canonical login/router -> isolated PG acceptance (tsx). */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import express from 'express'
import { hash } from 'bcryptjs'
import { chromium, expect } from '@playwright/test'

const database = new URL(process.env.DATABASE_URL ?? 'http://invalid')
assert.equal(process.env.NODE_ENV, 'test', 'NODE_ENV=test required')
assert.equal(database.protocol, 'postgresql:')
assert.equal(database.hostname, '127.0.0.1')
assert.match(database.pathname, /^\/tm_browser_acceptance_[a-z0-9_]+$/)
assert.ok(database.port && !['5432', '5433', '5435'].includes(database.port), 'Dedicated PG port required')
process.env.JWT_SECRET = randomBytes(48).toString('hex')

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const web = resolve(repo, 'apps/web')
const output = resolve(repo, 'artifacts/timemachine-browser')
const webRequire = createRequire(resolve(web, 'package.json'))
const { createServer } = await import(pathToFileURL(webRequire.resolve('vite')).href)
const { default: vue } = await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-vue')).href)
const { authRouter } = await import('../src/routes/auth')
const { jwtAuthMiddleware } = await import('../src/auth/jwt-middleware')
const { univerMetaRouter } = await import('../src/routes/univer-meta')
const { poolManager } = await import('../src/integration/db/connection-pool')
const { messageBus } = await import('../src/integration/messaging/message-bus')
const q = (sql: string, params: unknown[] = []) => poolManager.get().query(sql, params)
const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
const baseId = `tm_browser_base_${suffix}`
const sheetId = `tm_browser_sheet_${suffix}`
const fieldIds = [`tm_browser_name_${suffix}`, `tm_browser_qty_${suffix}`]
const recordIds = [`tm_browser_row1_${suffix}`, `tm_browser_row2_${suffix}`]
const users = [`tm_browser_admin_${suffix}`, `tm_browser_reader_${suffix}`]
const password = randomBytes(24).toString('hex')
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const evidence: Record<string, unknown> = {
  fixture: 'synthetic-only', sourceHead: git('rev-parse', 'HEAD'), sourceTree: git('rev-parse', 'HEAD^{tree}'),
  trackedWorktreeClean: git('status', '--porcelain', '--untracked-files=no') === '', cases: [],
}
const cases = evidence.cases as string[]
const vite = await createServer({
  configFile: false, envFile: false, root: web, plugins: [vue()],
  cacheDir: resolve(output, 'vite-cache'),
  resolve: { alias: { '@': resolve(web, 'src') }, dedupe: ['vue'] },
  server: { middlewareMode: true, hmr: false, fs: { allow: [repo] } },
  appType: 'custom',
})
const app = express()
app.use(express.json())
app.use('/api/auth', authRouter)
app.use('/api/multitable', jwtAuthMiddleware, univerMetaRouter())
app.use(vite.middlewares)
app.get('/', async (_req, res, next) => {
  try {
    res.type('html').send(await vite.transformIndexHtml('/', `<!doctype html>
      <html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Time Machine isolated acceptance</title><body style="font:16px sans-serif"><div id="app"></div>
      <script type="module">
      import { createApp, h, ref } from 'vue'
      import 'element-plus/dist/index.css'
      import '/src/styles/tokens.css'
      import SheetTrashModal from '/src/multitable/components/SheetTrashModal.vue'
      import HistoryCenterModal from '/src/multitable/components/HistoryCenterModal.vue'
      import { MultitableApiClient } from '/src/multitable/api/client.ts'
      const client = new MultitableApiClient()
      createApp({ setup() {
        const signedIn = ref(false), open = ref(false), message = ref('')
        const historyOpen = ref(false), fields = ref([]), isAdmin = ref(false)
        async function login(event) {
          event.preventDefault()
          const data = new FormData(event.target)
          const response = await fetch('/api/auth/login', { method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ identifier: data.get('identifier'), password: data.get('password') }) })
          if (!response.ok) throw new Error('LOGIN_FAILED')
          const body = await response.json()
          localStorage.setItem('auth_token', body.data.token)
          isAdmin.value = body.data.user.role === 'admin'
          signedIn.value = true
        }
        return () => h('main', { style: 'padding:24px;font:16px sans-serif' }, [
          h('h1', 'Time Machine isolated acceptance'),
          !signedIn.value ? h('form', { onSubmit: login }, [
            h('label', ['Account', h('input', {name:'identifier', autocomplete:'username'})]),
            h('label', ['Password', h('input', {name:'password', type:'password', autocomplete:'current-password'})]),
            h('button', {type:'submit'}, 'Sign in'),
          ]) : h('section', [h('p', {'data-test':'signed-in'}, 'Signed in'),
            h('button', {onClick:async () => { await client.deleteSheet(${JSON.stringify(sheetId)}); message.value='Table deleted' }}, 'Delete fixture table'),
            h('button', {onClick:() => {open.value=true}}, 'Recycle bin'),
            h('button', {onClick:async () => {await client.deleteRecord(${JSON.stringify(recordIds[0])}, 1); message.value='Record deleted'}}, 'Delete fixture record'),
            h('button', {onClick:async () => {fields.value=(await client.listFields(${JSON.stringify(sheetId)})).fields; historyOpen.value=true}}, 'History'),
            h('p', {'data-test':'outcome'}, message.value),
            h(SheetTrashModal, {open:open.value, baseId:${JSON.stringify(baseId)}, client,
              onClose:()=>{open.value=false}, onRestored:()=>{message.value='Table restored'}}),
            h(HistoryCenterModal, {open:historyOpen.value, baseId:${JSON.stringify(baseId)}, sheetId:${JSON.stringify(sheetId)},
              fields:fields.value, canRestoreRecords:isAdmin.value, onClose:()=>{historyOpen.value=false},
              onRestored:()=>{message.value='Record restored'}}),
          ]),
        ])
      }}).mount('#app')
      </script></body></html>`))
  } catch (error) { next(error) }
})
const server = app.listen(0, '127.0.0.1')
await new Promise<void>((done) => server.listening ? done() : server.once('listening', done))
const address = server.address()
assert.ok(address && typeof address !== 'string')
const origin = `http://127.0.0.1:${address.port}`
const browser = await chromium.launch({ headless: true })
const snapshot = async () => {
  const fields = await q('SELECT * FROM meta_fields WHERE sheet_id=$1 ORDER BY id', [sheetId])
  const records = await q('SELECT * FROM meta_records WHERE sheet_id=$1 ORDER BY id', [sheetId])
  const views = await q('SELECT * FROM meta_views WHERE sheet_id=$1 ORDER BY id', [sheetId])
  return { fields: fields.rows, records: records.rows, views: views.rows }
}
try {
  await mkdir(output, { recursive: true })
  const identity = await q('SELECT current_database() AS name')
  assert.equal(identity.rows[0].name, database.pathname.slice(1))
  const passwordHash = await hash(password, 10)
  for (const [index, id] of users.entries()) {
    await q(`INSERT INTO users (id,email,name,password_hash,role,is_active,activation_status,local_password_set,must_change_password)
      VALUES ($1,$2,$3,$4,$5,true,'activated',true,false)`,
    [id, `${id}@example.test`, index === 0 ? 'Recovery Tester' : 'Read Only Tester', passwordHash, index === 0 ? 'admin' : 'user'])
  }
  await q('INSERT INTO meta_bases (id,name,owner_id) VALUES ($1,$2,$3)', [baseId, 'Recovery acceptance', users[0]])
  await q('INSERT INTO meta_sheets (id,base_id,name) VALUES ($1,$2,$3)', [sheetId, baseId, 'Restore all retained content'])
  for (const [index, id] of fieldIds.entries()) {
    await q('INSERT INTO meta_fields (id,sheet_id,name,type,property,"order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [id, sheetId, index === 0 ? 'Project' : 'Quantity', index === 0 ? 'string' : 'number', '{}', index])
  }
  for (const [index, id] of recordIds.entries()) {
    await q('INSERT INTO meta_records (id,sheet_id,data,version) VALUES ($1,$2,$3::jsonb,1)',
      [id, sheetId, JSON.stringify({ [fieldIds[0]]: `Synthetic project ${index}`, [fieldIds[1]]: index + 7 })])
  }
  await q(`INSERT INTO meta_views (id,sheet_id,name,type,filter_info,sort_info,group_info,hidden_field_ids,config)
    VALUES ($1,$2,'Saved grid','grid','{}','{}','{}','[]','{}')`, [`tm_browser_view_${suffix}`, sheetId])
  await q(`INSERT INTO spreadsheet_permissions (sheet_id,subject_type,subject_id,perm_code)
    VALUES ($1,'user',$2,'spreadsheet:read')`, [sheetId, users[1]])
  const before = await snapshot()
  assert.equal(before.fields.length, 2)
  assert.equal(before.records.length, 2)
  assert.equal(before.views.length, 1)
  const viewerZone = 'America/New_York'
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId: viewerZone, locale: 'en-US' })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.name))
  page.on('requestfailed', (request) => errors.push(`REQUEST_FAILED:${new URL(request.url()).pathname}`))
  page.on('response', (response) => { if (response.url().startsWith(`${origin}/api/`) && !response.ok()) errors.push(`API_${response.status()}`) })
  await page.goto(origin)
  await page.getByLabel('Account', { exact: true }).fill(`${users[0]}@example.test`)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.locator('[data-test="signed-in"]')).toBeVisible()
  assert.equal((await q('SELECT count(*)::int AS n FROM user_sessions WHERE user_id=$1', [users[0]])).rows[0].n, 1)
  cases.push('canonical password login persists a real session')
  await page.getByRole('button', { name: 'Delete fixture table', exact: true }).click()
  await expect(page.locator('[data-test="outcome"]')).toHaveText('Table deleted')
  assert.ok((await q('SELECT deleted_at FROM meta_sheets WHERE id=$1', [sheetId])).rows[0].deleted_at)
  assert.deepEqual(await snapshot(), before)
  cases.push('canonical delete hides the table and retains exact field/record/view rows')
  await page.getByRole('button', { name: 'Recycle bin', exact: true }).click()
  await expect(page.locator('[data-test="sheet-trash-row"]')).toHaveCount(1)
  await expect(page.locator('[data-test="sheet-trash-row"] strong')).toHaveText('Restore all retained content')
  const deletedAt = (await q('SELECT deleted_at FROM meta_sheets WHERE id=$1', [sheetId])).rows[0].deleted_at as Date
  await expect(page.locator('[data-test="sheet-trash-row"] time')).toHaveText(new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZoneName: 'short', timeZone: viewerZone,
  }).format(deletedAt))
  cases.push('deletion time uses the browser viewer zone independently of the server zone')
  await page.screenshot({ path: resolve(output, 'trash-before-restore.png'), animations: 'disabled' })
  const reader = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const denied = await reader.newPage()
  await denied.goto(origin)
  await denied.getByLabel('Account', { exact: true }).fill(`${users[1]}@example.test`)
  await denied.getByLabel('Password', { exact: true }).fill(password)
  await denied.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(denied.locator('[data-test="signed-in"]')).toBeVisible()
  await denied.getByRole('button', { name: 'Recycle bin', exact: true }).click()
  await expect(denied.getByRole('alert')).toHaveText('You do not have permission to view this recycle bin.')
  assert.deepEqual(await snapshot(), before)
  await denied.screenshot({ path: resolve(output, 'trash-reader-denied.png'), animations: 'disabled' })
  const deniedStatus = await denied.evaluate(async (id) => (await fetch(`/api/multitable/sheets/${id}/restore`, {
    method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('auth_token')}` },
  })).status, sheetId)
  assert.equal(deniedStatus, 403)
  assert.ok((await q('SELECT deleted_at FROM meta_sheets WHERE id=$1', [sheetId])).rows[0].deleted_at)
  cases.push('real non-admin session cannot enumerate or restore; no persistence change')
  const anonymous = await reader.request.post(`${origin}/api/multitable/sheets/${sheetId}/restore`)
  assert.equal(anonymous.status(), 401)
  cases.push('anonymous restore denied by canonical JWT middleware')
  await page.locator('[data-test="sheet-trash-restore"]').click()
  await expect(page.locator('[data-test="sheet-trash-confirm"]')).toBeVisible()
  // Confirmation is necessary: displaying it must not change persistence.
  assert.ok((await q('SELECT deleted_at FROM meta_sheets WHERE id=$1', [sheetId])).rows[0].deleted_at)
  await page.locator('[data-test="sheet-trash-confirm"]').click()
  await expect(page.locator('[data-test="outcome"]')).toHaveText('Table restored')
  await expect(page.locator('[data-test="sheet-trash-empty"]')).toBeVisible()
  assert.equal((await q('SELECT deleted_at FROM meta_sheets WHERE id=$1', [sheetId])).rows[0].deleted_at, null)
  assert.deepEqual(await snapshot(), before)
  assert.deepEqual(errors, [])
  cases.push('real modal confirmation restores exact retained content through production client/router')
  await page.screenshot({ path: resolve(output, 'trash-after-restore.png'), animations: 'disabled' })
  await page.getByRole('button', { name: 'Close this dialog', exact: true }).click()
  const beforeRecord = before.records.find((record) => record.id === recordIds[0])
  assert.ok(beforeRecord)
  await page.getByRole('button', { name: 'Delete fixture record', exact: true }).click()
  await expect(page.locator('[data-test="outcome"]')).toHaveText('Record deleted')
  assert.equal((await q('SELECT count(*)::int AS n FROM meta_records WHERE id=$1', [recordIds[0]])).rows[0].n, 0)
  const tombstone = (await q('SELECT data,deleted_by FROM meta_records_trash WHERE record_id=$1', [recordIds[0]])).rows
  assert.equal(tombstone.length, 1)
  assert.deepEqual(tombstone[0].data, beforeRecord.data)
  assert.equal(tombstone[0].deleted_by, users[0])
  assert.equal(await denied.evaluate(async (id) => (await fetch(`/api/multitable/records/${id}/restore`, {
    method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('auth_token')}` },
  })).status, recordIds[0]), 403)
  assert.equal((await reader.request.post(`${origin}/api/multitable/records/${recordIds[0]}/restore`)).status(), 401)
  assert.equal((await q('SELECT count(*)::int AS n FROM meta_records WHERE id=$1', [recordIds[0]])).rows[0].n, 0)
  assert.deepEqual((await q('SELECT data FROM meta_records_trash WHERE record_id=$1', [recordIds[0]])).rows[0].data, beforeRecord.data)
  cases.push('authenticated read-only and anonymous record restores denied without changing the tombstone')
  await reader.close()
  await page.getByRole('button', { name: 'History', exact: true }).click()
  const history = page.getByRole('dialog', { name: 'History', exact: true })
  await expect(history.locator('[data-test="hist-batch"]')).toHaveCount(1)
  await expect(history).toContainText('Recovery Tester')
  await history.locator('[data-test="hist-batch"]').click()
  await expect(history.locator('[data-test="hist-rec-label"]')).toHaveText('Synthetic project 0')
  await expect(history.locator('[data-test="hist-diff-row"]')).toHaveCount(2)
  await expect(history.locator('.meta-hist__diff-after')).toHaveCount(0)
  await expect(history.locator('[data-test="hist-diff-row"]').filter({ hasText: 'Project' })).toContainText('Synthetic project 0')
  await expect(history.locator('[data-test="hist-diff-row"]').filter({ hasText: 'Quantity' })).toContainText('7')
  await page.screenshot({ path: resolve(output, 'history-deleted-record.png'), animations: 'disabled' })
  await history.locator('[data-test="hist-restore-deleted-record"]').click()
  const deleted = page.getByRole('dialog', { name: 'Deleted records', exact: true })
  await expect(deleted.locator('[data-test="trash-record-title"]')).toHaveText('Synthetic project 0')
  await expect(deleted.locator('[data-test="trash-record-details"] dt')).toHaveText(['Project', 'Quantity'])
  await expect(deleted.locator('[data-test="trash-record-details"] dd')).toHaveText(['Synthetic project 0', '7'])
  await expect(deleted).toContainText('Recovery Tester')
  await deleted.locator('[data-test="trash-restore"]').click()
  assert.equal((await q('SELECT count(*)::int AS n FROM meta_records WHERE id=$1', [recordIds[0]])).rows[0].n, 0)
  const restoreResponse = page.waitForResponse((response) => response.url() === `${origin}/api/multitable/records/${recordIds[0]}/restore` && response.request().method() === 'POST')
  await deleted.locator('[data-test="trash-restore-confirm"]').click()
  assert.equal((await restoreResponse).status(), 200)
  await expect(page.locator('[data-test="outcome"]')).toHaveText('Record restored')
  const restoredRecord = (await q('SELECT * FROM meta_records WHERE id=$1', [recordIds[0]])).rows[0]
  for (const key of ['id', 'sheet_id', 'data', 'created_at', 'updated_at', 'created_by']) {
    assert.deepEqual(restoredRecord[key], beforeRecord[key], `Record restore must preserve ${key}`)
  }
  assert.equal(restoredRecord.modified_by, users[0])
  assert.equal((await q('SELECT count(*)::int AS n FROM meta_records_trash WHERE record_id=$1', [recordIds[0]])).rows[0].n, 0)
  assert.deepEqual((await q('SELECT * FROM meta_records WHERE id=$1', [recordIds[1]])).rows[0], before.records.find((record) => record.id === recordIds[1]))
  assert.deepEqual(errors, [])
  cases.push('history shows canonical deletion actor and both pre-delete field values')
  cases.push('history-selected current tombstone restores the whole row via deleted-record endpoint, preserving its peer')
  await page.screenshot({ path: resolve(output, 'history-after-record-restore.png'), animations: 'disabled' })
  await context.close()
  evidence.result = 'PASS'
} finally {
  await browser.close()
  await vite.close()
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()))
  await q('DELETE FROM spreadsheet_permissions WHERE sheet_id=$1', [sheetId])
  await q('DELETE FROM meta_record_revisions WHERE sheet_id=$1', [sheetId])
  await q('DELETE FROM meta_records_trash WHERE sheet_id=$1', [sheetId])
  await q('DELETE FROM meta_sheets WHERE id=$1', [sheetId])
  await q('DELETE FROM meta_bases WHERE id=$1', [baseId])
  await q('DELETE FROM user_sessions WHERE user_id=ANY($1::text[])', [users])
  await q('DELETE FROM users WHERE id=ANY($1::text[])', [users])
  const residue = await q(`SELECT
    (SELECT count(*)::int FROM meta_sheets WHERE id=$1) AS sheets,
    (SELECT count(*)::int FROM meta_fields WHERE sheet_id=$1) AS fields,
    (SELECT count(*)::int FROM meta_records WHERE sheet_id=$1) AS records,
    (SELECT count(*)::int FROM meta_views WHERE sheet_id=$1) AS views,
    (SELECT count(*)::int FROM spreadsheet_permissions WHERE sheet_id=$1) AS grants,
    (SELECT count(*)::int FROM user_sessions WHERE user_id=ANY($2::text[])) AS sessions,
    (SELECT count(*)::int FROM users WHERE id=ANY($2::text[])) AS users`, [sheetId, users])
  assert.deepEqual(residue.rows[0], { sheets: 0, fields: 0, records: 0, views: 0, grants: 0, sessions: 0, users: 0 })
  evidence.fixtureResidue = residue.rows[0]
  await messageBus.shutdown()
  await poolManager.close()
  await writeFile(resolve(output, 'result.json'), `${JSON.stringify(evidence, null, 2)}\n`)
}
console.log(JSON.stringify(evidence))
