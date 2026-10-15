/** Real Yuantus HTTP + MetaSheet relay/Vite + local Chrome; only Redis and registry are substituted. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createPrivateKey, sign } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { chromium, expect as browserExpect, type Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { generateEmbedKeys } from './harness'
import type { EmbedKeys } from './harness'

const registry = vi.hoisted(() => ({ adapter: null as unknown, used: new Set<string>() }))
vi.mock('../../src/routes/data-sources', () => ({ getDataSourceManager: () => ({ getDataSource: () => registry.adapter, isVisualReviewSourceCurrent: async () => true }) }))
vi.mock('../../src/db/redis', () => ({ getRedisClient: async () => ({
  set: async (key: string, _value: string, _ex: string, _ttl: number, nx?: string) => {
    if (nx === 'NX' && registry.used.has(key)) return null
    registry.used.add(key)
    return 'OK'
  },
}) }))

import plmEmbedRouter from '../../src/routes/plm-embed'
import plmEmbedVisualPreviewRouter from '../../src/routes/plm-embed-visual-preview'
import plmEmbedDiscussionRouter from '../../src/routes/plm-embed-discussion'
import plmEmbedDiscussionReadRouter from '../../src/routes/plm-embed-discussion-read'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'

const YUANTUS = process.env.E2E_YUANTUS_WORKTREE || ''
const PYTHON = process.env.E2E_YUANTUS_PYTHON || ''
const WEB = path.resolve(__dirname, '../../../../apps/web')
const TENANT = 'default'
const ORG = 'org-1'
const PARTS = ['item-1', 'item-2'] as const
let dir = ''
let provider: ChildProcess | null = null
let vite: ChildProcess | null = null
let relay: Server | null = null
let browser: Browser | null = null
let providerUrl = ''
let webUrl = ''
let relayUrl = ''
let bearer = ''
let adapter: PLMAdapter
let keys: EmbedKeys
let globalDb = ''
let identityDb = ''
let productDb = ''
const logs: string[] = []

function signedWith(token: string, claims: Record<string, unknown>): string {
  const [header, payload] = token.split('.')
  const original = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>
  const privateKey = createPrivateKey({ key: {
    kty: 'OKP', crv: 'Ed25519', d: Buffer.from(keys.privateSeedB64, 'base64').toString('base64url'),
    x: Buffer.from(keys.publicB64, 'base64').toString('base64url'),
  }, format: 'jwk' })
  const unsigned = `${header}.${Buffer.from(JSON.stringify({ ...original, ...claims })).toString('base64url')}`
  return `${unsigned}.${sign(null, Buffer.from(unsigned), privateKey).toString('base64url')}`
}

function runSeed(dbPath: string): void {
  const result = spawnSync(PYTHON, [path.join(__dirname, 'seed_yuantus.py')], {
    cwd: YUANTUS, env: { ...process.env, PYTHONPATH: path.join(YUANTUS, 'src'), YUANTUS_DATABASE_URL: `sqlite:///${dbPath}` }, encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`identity/product seed failed: ${result.stderr}`)
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('missing port'))
      server.close(() => resolve(address.port))
    })
  })
}

async function healthy(url: string, child?: ChildProcess): Promise<void> {
  const until = Date.now() + 90000
  while (Date.now() < until) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`server exited: ${logs.join('').slice(-2000)}`)
    try { if ((await fetch(url)).ok) return } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`server timeout ${url}: ${logs.join('').slice(-2000)}`)
}

async function mint(partId: string): Promise<string> {
  const response = await fetch(`${providerUrl}/api/v1/bom/multitable/${partId}/embed-token`, {
    method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'x-tenant-id': TENANT, 'x-org-id': ORG, 'Content-Type': 'application/json' },
    body: JSON.stringify({ origin: webUrl }),
  })
  if (!response.ok) throw new Error(`embed mint ${response.status}: ${await response.text()}`)
  return ((await response.json()) as { embed_token: string }).embed_token
}

describe('real visual preview browser loop', () => {
  beforeAll(async () => {
    if (!YUANTUS || !PYTHON || !fs.existsSync(PYTHON)) throw new Error('Set E2E_YUANTUS_WORKTREE and E2E_YUANTUS_PYTHON')
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plm-visual-browser-'))
    globalDb = path.join(dir, 'global.db')
    identityDb = path.join(dir, 'identity.db')
    productDb = path.join(dir, `${TENANT}-${ORG}.db`)
    const storage = path.join(dir, 'storage')
    runSeed(globalDb)
    runSeed(identityDb)
    runSeed(productDb)
    const extras = spawnSync(PYTHON, [path.join(__dirname, 'seed_visual_preview.py'), productDb, storage, identityDb, globalDb], {
      cwd: YUANTUS, env: { ...process.env, PYTHONPATH: path.join(YUANTUS, 'src') }, encoding: 'utf8',
    })
    if (extras.status !== 0) throw new Error(`preview seed failed: ${extras.stderr}`)

    const providerPort = await freePort()
    const webPort = await freePort()
    providerUrl = `http://127.0.0.1:${providerPort}`
    webUrl = `http://127.0.0.1:${webPort}`
    keys = generateEmbedKeys()
    const app = express()
    app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', webUrl)
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-PLM-Embed-Token, Authorization, X-Tenant-ID, X-Org-ID')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      if (req.method === 'OPTIONS') return res.sendStatus(204)
      next()
    })
    app.use(express.json())
    app.use(plmEmbedRouter())
    app.use(plmEmbedVisualPreviewRouter())
    app.use(plmEmbedDiscussionRouter())
    app.use(plmEmbedDiscussionReadRouter())
    relay = createServer(app)
    await new Promise<void>((resolve) => relay!.listen(0, '127.0.0.1', resolve))
    const relayAddress = relay.address()
    if (!relayAddress || typeof relayAddress === 'string') throw new Error('missing relay port')
    relayUrl = `http://127.0.0.1:${relayAddress.port}`

    provider = spawn(PYTHON, ['-m', 'uvicorn', 'yuantus.api.app:app', '--host', '127.0.0.1', '--port', String(providerPort), '--log-level', 'warning'], {
      cwd: YUANTUS, env: {
        ...process.env, PYTHONPATH: path.join(YUANTUS, 'src'), PYTHONDONTWRITEBYTECODE: '1',
        YUANTUS_AUTH_MODE: 'required', YUANTUS_TENANCY_MODE: 'db-per-tenant-org',
        YUANTUS_DATABASE_URL: `sqlite:///${globalDb}`,
        YUANTUS_IDENTITY_DATABASE_URL: `sqlite:///${identityDb}`,
        YUANTUS_DATABASE_URL_TEMPLATE: `sqlite:///${dir}/{tenant_id}-{org_id}.db`,
        YUANTUS_LOCAL_STORAGE_PATH: storage,
        YUANTUS_EMBED_TOKEN_SIGNING_KEY: keys.privateSeedB64,
        YUANTUS_EMBED_TOKEN_KEY_ID: 'embed-1', YUANTUS_EMBED_TOKEN_AUDIENCE: 'metasheet2.embed',
        YUANTUS_EMBED_ALLOWED_ORIGINS: webUrl, YUANTUS_METASHEET_EMBED_URL: `${webUrl}/plm-embed/bom-review`,
        YUANTUS_DISCUSSION_SESSION_ENABLED: 'true', YUANTUS_DISCUSSION_READ_SESSION_ENABLED: 'true', YUANTUS_VISUAL_PREVIEW_SESSION_ENABLED: 'true', YUANTUS_PREAUTH_RATE_LIMIT_ENABLED: 'false',
        YUANTUS_UI_BEARER_BRIDGE_ENABLED: 'true',
        YUANTUS_JWT_SECRET_KEY: keys.privateSeedB64,
      },
    })
    provider.stderr?.on('data', (data) => logs.push(String(data)))
    await healthy(`${providerUrl}/api/v1/health`, provider)

    vi.stubEnv('YUANTUS_EMBED_PUBLIC_KEY', keys.publicB64)
    vi.stubEnv('YUANTUS_EMBED_KEY_ID', 'embed-1')
    vi.stubEnv('PLM_EMBED_AUDIENCE', 'metasheet2.embed')
    vi.stubEnv('PLM_EMBED_ALLOWED_ORIGINS', `${providerUrl},${webUrl}`)
    vi.stubEnv('PLM_EMBED_DATA_SOURCE_ID', 'visual-browser')
    vi.stubEnv('PLM_EMBED_VISUAL_PREVIEW_ENABLED', 'true')
    const config: Record<string, unknown> = {
      'plm.url': providerUrl, 'plm.apiMode': 'yuantus', 'plm.mock': false,
      'plm.tenantId': TENANT, 'plm.orgId': ORG, 'plm.username': 'u42', 'plm.password': 'e2e-pw-42',
    }
    adapter = new PLMAdapter({ get: async (key: string) => config[key] } as never,
      { info() {}, warn() {}, error() {}, debug() {} } as never,
      { id: 'visual-browser', name: 'synthetic', type: 'plm', connection: { url: providerUrl }, options: { apiMode: 'yuantus', tenantId: TENANT, orgId: ORG, visualReviewEnabled: true } } as never)
    await adapter.connect()
    registry.adapter = adapter
    const login = await fetch(`${providerUrl}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'u42', password: 'e2e-pw-42', tenant_id: TENANT, org_id: ORG }) })
    if (!login.ok) throw new Error(`login ${login.status}: ${await login.text()}`)
    bearer = ((await login.json()) as { access_token: string }).access_token
    const listControl = await fetch(`${providerUrl}/api/v1/auth/embed/visual-preview-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embed_token: await mint('item-1'), action: 'list' }),
    })
    if (!listControl.ok || ((await listControl.json()) as { files?: unknown[] }).files?.length !== 10) {
      throw new Error(`real provider list failed: ${listControl.status}`)
    }

    vite = spawn(path.join(WEB, 'node_modules/.bin/vite'), ['--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
      cwd: WEB, env: { ...process.env, VITE_API_URL: relayUrl, VITE_PORT: String(webPort) },
    })
    vite.stderr?.on('data', (data) => logs.push(String(data)))
    await healthy(`${webUrl}/plm-embed/bom-review`, vite)
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true })
  })

  afterAll(async () => {
    async function stop(child: ChildProcess | null): Promise<void> {
      if (!child || child.exitCode !== null || child.signalCode !== null) return
      await new Promise<void>((resolve, reject) => {
        const force = setTimeout(() => child.kill('SIGKILL'), 3000)
        const deadline = setTimeout(() => finish(new Error('Owned child did not exit')), 8000)
        const exited = () => finish()
        const finish = (error?: Error) => {
          clearTimeout(force); clearTimeout(deadline)
          child.removeListener('exit', exited)
          if (error) reject(error); else resolve()
        }
        child.once('exit', exited)
        child.kill('SIGTERM')
      })
    }
    const results = await Promise.allSettled([browser?.close(), stop(vite), stop(provider)])
    relay?.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      if (!relay) return resolve()
      relay.close(error => error ? reject(error) : resolve())
    })
    const childrenExited = [vite, provider].every(child => !child || child.exitCode !== null || child.signalCode !== null)
    if (dir && childrenExited) fs.rmSync(dir, { recursive: true, force: true })
    const cleanup = childrenExited && (!dir || !fs.existsSync(dir)) && results.every(result => result.status === 'fulfilled')
    const output = process.env.PLM_VISUAL_BROWSER_OUTPUT
    if (output) {
      fs.mkdirSync(output, { recursive: true })
      fs.writeFileSync(path.join(output, 'cleanup.json'), JSON.stringify({ cleanup, childrenExited,
        processes: [vite, provider].map(child => child ? { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode } : null),
      }, null, 2))
    }
    vi.unstubAllEnvs()
    if (!cleanup) throw new Error('Visual browser resources were not fully cleaned up')
  })

  it('browser login, real parent embed, twenty version-bound raster loops, refresh and deny controls', async () => {
    const page = await browser!.newPage()
    const imageTypes: string[] = []
    page.on('response', (response) => {
      if (response.url().endsWith('/api/plm-embed/visual-preview/image') && response.status() === 200) {
        imageTypes.push(response.headers()['content-type']?.split(';', 1)[0] || '')
      }
    })
    try {
      await page.goto(`${providerUrl}/login?next=%2Fworkspace`)
      await page.locator('#tenant-id').fill(TENANT)
      await page.locator('#org-id').fill(ORG)
      await page.locator('#username').fill('u42')
      await page.locator('#password').fill('e2e-pw-42')
      await page.locator('#submit').click()
      await browserExpect(page).toHaveURL(`${providerUrl}/workspace`)
      for (const [partIndex, partId] of PARTS.entries()) {
        await page.locator('[data-tab="bom"]').click()
        await page.locator('#item-type').selectOption('Part')
        await page.locator('#item-id').fill(partId)
        await page.locator('#metasheet-review-button').click()
        await browserExpect(page.locator('#metasheet-review-output')).not.toContainText('Authorizing', { timeout: 30000 })
        const frame = page.frameLocator('#metasheet-bom-review-frame')
        const selector = frame.getByTestId('plm-visual-preview-select')
        await browserExpect(selector.locator('option')).toHaveCount(10, { timeout: 15000 })
        for (let index = 0; index < 10; index++) {
          await selector.selectOption(String(index))
          await page.waitForTimeout(6100)
          await frame.getByRole('button', { name: '预览' }).click()
          const image = frame.getByTestId('markup-image')
          try { await browserExpect(image).toBeVisible() }
          catch (error) { console.log('failed preview', partIndex, index, await frame.locator('body').innerText()); throw error }
          const dimensions = await image.evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight])
          expect(dimensions).toEqual([5 + index, 7 + partIndex])
          if (index === 9) await browserExpect(frame.getByTestId('markup-tool-pin')).toBeEnabled()
          else await browserExpect(frame.getByTestId('markup-tool-pin')).toBeDisabled()
          const name = await image.getAttribute('alt')
          expect(name).toBe(`part-${partIndex + 1}-revision-${String(index).padStart(2, '0')}.${index % 2 ? 'jpg' : 'png'}`)
        }
        if (partIndex === 0) {
          await page.locator('#metasheet-reauthorize-button').click()
          await browserExpect(frame.getByTestId('markup-image')).toHaveCount(0)
          await page.reload()
          await browserExpect(page.locator('#metasheet-bom-review-frame')).toHaveCount(0)
        } else {
          await page.locator('#clear-session-button').click()
          await browserExpect(page).toHaveURL(`${providerUrl}/login`)
          await browserExpect(page.locator('#metasheet-bom-review-frame')).toHaveCount(0)
        }
      }
      expect(imageTypes).toHaveLength(20)
      expect(imageTypes.filter((type) => type === 'image/png')).toHaveLength(10)
      expect(imageTypes.filter((type) => type === 'image/jpeg')).toHaveLength(10)
      expect(registry.used.size).toBeGreaterThanOrEqual(24)
      const token = await mint('item-1')
      const first = await fetch(`${relayUrl}/api/plm-embed/visual-preview/files`, { method: 'POST', headers: { 'X-PLM-Embed-Token': token } })
      expect(first.status).toBe(200)
      const replay = await fetch(`${relayUrl}/api/plm-embed/visual-preview/files`, { method: 'POST', headers: { 'X-PLM-Embed-Token': token } })
      expect(replay.status).toBe(401)
      const wrongPart = await fetch(`${relayUrl}/api/plm-embed/visual-preview/image`, {
        method: 'POST', headers: { 'X-PLM-Embed-Token': await mint('item-1'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: 'visual-file-2-00', version_id: 'visual-version-2-00' }),
      })
      expect(wrongPart.status).toBe(200)
      expect((await wrongPart.json()).data.render).toBe('unavailable')
      const fresh = await mint('item-1')
      for (const [claims, status] of [
        [{ exp: Math.floor(Date.now() / 1000) - 1 }, 401],
        // The source gate rejects foreign tenants uniformly before connect/NX.
        [{ tenant_id: 'other-tenant' }, 503],
        [{ embed_origin: 'https://not-allowed.example' }, 403],
      ] as const) {
        const usedBefore = registry.used.size
        const rejected = await fetch(`${relayUrl}/api/plm-embed/visual-preview/files`, {
          method: 'POST', headers: { 'X-PLM-Embed-Token': signedWith(fresh, claims) },
        })
        expect(rejected.status).toBe(status)
        expect(registry.used.size).toBe(usedBefore)
      }
      const revoked = await mint('item-1')
      const jti = (JSON.parse(Buffer.from(revoked.split('.')[1], 'base64url').toString()) as { jti: string }).jti
      const statement = 'import sqlite3,sys,datetime\nwith sqlite3.connect(sys.argv[1]) as db: db.execute("INSERT INTO auth_token_revocations (id,tenant_id,token_typ,jti,revoked_before,revoked_at,revoked_by_user_id,expires_at) VALUES (?,?,?,?,?,?,?,?)", (1,"default","embed",sys.argv[2],int(datetime.datetime.now().timestamp())+121,datetime.datetime.now().isoformat(),42,(datetime.datetime.now()+datetime.timedelta(hours=1)).isoformat()))'
      const revoke = spawnSync(PYTHON, ['-c', statement, identityDb, jti], { encoding: 'utf8' })
      if (revoke.status !== 0) throw new Error(`revocation fixture failed: ${revoke.stderr}`)
      const denied = await fetch(`${providerUrl}/api/v1/auth/embed/visual-preview-session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embed_token: revoked, action: 'list' }),
      })
      expect(denied.status).toBe(401)
    } finally { await page.close() }
  })

  it('four persisted tools survive reload for a second reviewer and stale writes stay read-only', async () => {
    const first = await browser!.newContext()
    const second = await browser!.newContext()
    const page = await first.newPage()
    const other = await second.newPage()
    const events: string[] = []
    const output = process.env.PLM_VISUAL_BROWSER_OUTPUT
    for (const [label, target] of [['first', page], ['second', other]] as const) {
      target.on('response', (response) => {
        if (response.url().includes('/api/plm-embed/discussion/')) events.push(`${label}:discussion:${response.request().method()}:${response.status()}`)
      })
    }
    async function openReviewer(target: typeof page, userId: number, login = true) {
      if (login) {
      await target.goto(`${providerUrl}/login?next=%2Fworkspace`)
      await target.locator('#tenant-id').fill(TENANT)
      await target.locator('#org-id').fill(ORG)
      await target.locator('#username').fill(`u${userId}`)
      await target.locator('#password').fill(`e2e-pw-${userId}`)
      await target.locator('#submit').click()
      await browserExpect(target).toHaveURL(`${providerUrl}/workspace`)
      }
      await target.locator('[data-tab="bom"]').click()
      await target.locator('#item-type').selectOption('Part')
      await target.locator('#item-id').fill('item-1')
      await target.locator('#metasheet-review-button').click()
      const frame = target.frameLocator('#metasheet-bom-review-frame')
      await browserExpect(frame.getByTestId('plm-visual-preview-select').locator('option')).toHaveCount(10)
      await frame.getByTestId('plm-visual-preview-select').selectOption('9')
      await target.waitForTimeout(6100)
      await frame.getByRole('button', { name: '预览', exact: true }).click()
      await browserExpect(frame.getByTestId('markup-image')).toBeVisible()
      await browserExpect(frame.getByTestId('markup-tool-pin')).toBeEnabled()
      // Initial Discussion loading shares the parent's mint budget with preview.
      // A deliberate next action waits for its refill; writes never auto-retry.
      await target.waitForTimeout(6100)
      return frame
    }
    function dbRows() {
      const script = 'import sqlite3,sys,json\nwith sqlite3.connect(sys.argv[1]) as db: print(json.dumps(db.execute("SELECT c.body,m.markup_type,m.geometry,m.file_version,m.preview_checksum,m.created_by_id,c.thread_id FROM meta_discussion_markups m JOIN meta_discussion_comments c ON c.id=m.comment_id WHERE c.body LIKE ? ORDER BY c.body", ("visual-v1-%",)).fetchall()))'
      const result = spawnSync(PYTHON, ['-c', script, productDb], { encoding: 'utf8' })
      if (result.status !== 0) throw new Error(`markup fixture query failed: ${result.stderr}`)
      return JSON.parse(result.stdout) as Array<[string, string, string, string, string, number, string]>
    }
    try {
      const frame = await openReviewer(page, 42)
      for (const tool of ['pin', 'rectangle', 'arrow', 'callout'] as const) {
        await frame.getByTestId(`markup-tool-${tool}`).click()
        const stage = frame.getByTestId('markup-stage')
        await stage.scrollIntoViewIfNeeded()
        events.push(`gesture:${tool}`)
        if (tool === 'pin') {
          await stage.focus()
          await page.keyboard.press('ArrowRight')
          await page.keyboard.press('Enter')
        } else {
          const box = await stage.boundingBox()
          if (!box) throw new Error('visible canvas has no bounding box')
          await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3)
          await page.mouse.down()
          await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7)
          await page.mouse.up()
        }
        await browserExpect(frame.getByTestId('plm-visual-draft-attached')).toBeVisible()
        await frame.getByTestId('plm-discussion-create-input').fill(`visual-v1-${tool}${tool === 'callout' ? ' '+ '长文本审阅说明。'.repeat(20) : ''}`)
        const response = page.waitForResponse((r) => r.url().endsWith('/api/plm-embed/discussion/threads') && r.request().method() === 'POST')
        await frame.getByTestId('plm-discussion-create-submit').click()
        expect((await response).status()).toBe(200)
        await browserExpect(frame.getByTestId('plm-visual-draft-attached')).toHaveCount(0)
        events.push(`persisted:${tool}`)
        await page.waitForTimeout(6100)
      }
      const before = dbRows()
      expect(before).toHaveLength(4)
      expect(new Set(before.map((row) => row[1]))).toEqual(new Set(['pin', 'rectangle', 'arrow', 'callout']))
      for (const row of before) { expect(row[3]).toBe('visual-version-1-09'); expect(row[4]).toMatch(/^[a-f0-9]{64}$/); expect(row[5]).toBe(42) }
      expect(JSON.parse(before.find((row) => row[1] === 'pin')![2])).toEqual({ x: 0.51, y: 0.5 })
      const reviewer = await openReviewer(other, 43)
      for (const row of before) {
        const detail = reviewer.getByTestId(`plm-discussion-load-detail-${row[6]}`)
        await browserExpect(detail).toBeVisible()
        await detail.click()
        await browserExpect(detail).toHaveCount(0)
        await other.waitForTimeout(6100)
      }
      await browserExpect(reviewer.getByTestId('markup-option')).toHaveCount(4)
      const bodies = await reviewer.getByTestId('markup-option').allTextContents()
      for (const row of before) expect(bodies.some((body) => body.includes(row[0]))).toBe(true)
      expect(dbRows()).toEqual(before)
      events.push('second-reviewer:loaded-identical-persisted-markups')
      await other.reload()
      const reloaded = await openReviewer(other, 43, false)
      for (const row of before) {
        const detail = reloaded.getByTestId(`plm-discussion-load-detail-${row[6]}`)
        await browserExpect(detail).toBeVisible()
        await detail.click()
        await browserExpect(detail).toHaveCount(0)
        await other.waitForTimeout(6100)
      }
      await browserExpect(reloaded.getByTestId('markup-option')).toHaveCount(4)
      expect(dbRows()).toEqual(before)
      events.push('reload:four-normalized-overlays-from-provider')

      await reviewer.getByTestId('markup-option').first().focus()
      await other.keyboard.press('ArrowDown')
      await browserExpect(reviewer.getByTestId('markup-option').nth(1)).toHaveAttribute('aria-selected', 'true')
      if (output) {
        fs.mkdirSync(output, { recursive: true })
        await other.locator('#metasheet-bom-review-frame').evaluate((element) => element.scrollIntoView({ block: 'center' }))
        await reviewer.getByTestId('markup-stage').evaluate((element) => element.scrollIntoView({ block: 'center' }))
        await other.screenshot({ path: path.join(output, 'visual-desktop.png') })
        await other.setViewportSize({ width: 390, height: 844 })
        await other.emulateMedia({ reducedMotion: 'reduce' })
        await other.locator('#metasheet-bom-review-frame').evaluate((element) => element.scrollIntoView({ block: 'center' }))
        await reviewer.getByTestId('markup-stage').evaluate((element) => element.scrollIntoView({ block: 'center' }))
        expect((await reviewer.getByTestId('markup-stage').boundingBox())!.width).toBeGreaterThan(180)
        await other.screenshot({ path: path.join(output, 'visual-narrow.png') })
        const visualLayout = await reviewer.getByTestId('plm-visual-markup').evaluate((element) => {
          const width = document.documentElement.clientWidth
          return Array.from(element.querySelectorAll('button, [role="option"]')).map((control) => {
            const box = control.getBoundingClientRect()
            return { left: box.left, right: box.right, width }
          })
        })
        expect(visualLayout.every((box) => box.left >= -1 && box.right <= box.width + 1)).toBe(true)
        await other.setViewportSize({ width: 1280, height: 900 })
        await reviewer.locator('html').evaluate((element) => { element.style.zoom = '2' })
        // Chrome defers ResizeObserver delivery for an offscreen iframe. Bring
        // the actual raster into view before assessing its fitted geometry.
        await other.locator('#metasheet-bom-review-frame').evaluate((element) => element.scrollIntoView({ block: 'center' }))
        await reviewer.getByTestId('markup-stage').evaluate((element) => element.scrollIntoView({ block: 'center' }))
        const zoomGeometry = () => reviewer.getByTestId('markup-stage').evaluate((element) => {
          const stage = element.getBoundingClientRect()
          const content = element.querySelector('.content')!.getBoundingClientRect()
          const image = element.querySelector('img')!
          // A height-limited stage may letterbox the raster. Assert its actual
          // natural aspect ratio, centered fit, and bounds at CSS zoom 200%.
          const scale = Math.min(stage.width / image.naturalWidth, stage.height / image.naturalHeight)
          return {
            stage: stage.toJSON(), content: content.toJSON(),
            naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
            fit: stage.width > 0 && image.naturalWidth > 0
              && Math.abs(content.width - image.naturalWidth * scale) <= 2
              && Math.abs(content.height - image.naturalHeight * scale) <= 2
              && Math.abs(content.left + content.width / 2 - stage.left - stage.width / 2) <= 2
              && Math.abs(content.top + content.height / 2 - stage.top - stage.height / 2) <= 2,
          }
        })
        try {
          await browserExpect.poll(async () => (await zoomGeometry()).fit).toBe(true)
        } finally {
          fs.writeFileSync(path.join(output, 'visual-css-zoom-geometry.json'), JSON.stringify(await zoomGeometry(), null, 2))
        }
        await reviewer.getByTestId('markup-stage').evaluate((element) => element.scrollIntoView({ block: 'center' }))
        await other.screenshot({ path: path.join(output, 'visual-css-zoom-200.png') })
        await reviewer.locator('html').evaluate((element) => { element.style.zoom = '' })
        events.push('screenshots:desktop-narrow-long-text-keyboard-reduced-motion-css200percent')
      }

      // Change actual provider state after raster loading; the cached position
      // must fail at the provider and cannot migrate itself onto another version.
      const mutate = spawnSync(PYTHON, ['-c', 'import sqlite3,sys\nwith sqlite3.connect(sys.argv[1]) as db: db.execute("UPDATE meta_item_versions SET is_current=0 WHERE id=?", ("visual-version-1-09",))', productDb], { encoding: 'utf8' })
      if (mutate.status !== 0) throw new Error(mutate.stderr)
      await frame.getByTestId('markup-tool-pin').click()
      await frame.getByTestId('markup-stage').focus()
      await page.keyboard.press('Enter')
      await frame.getByTestId('plm-discussion-create-input').fill('visual-v1-stale-rejected')
      const staleResponse = page.waitForResponse((r) => r.url().endsWith('/api/plm-embed/discussion/threads') && r.request().method() === 'POST')
      await frame.getByTestId('plm-discussion-create-submit').click()
      expect((await staleResponse).status()).toBe(422)
      await browserExpect(frame.getByTestId('plm-visual-stale')).toBeVisible()
      await browserExpect(frame.getByTestId('markup-tool-pin')).toBeDisabled()
      expect(dbRows()).toEqual(before)
      events.push('stale:422-no-insert-readonly')
      if (output) {
        await page.screenshot({ path: path.join(output, 'stale-readonly.png'), fullPage: true })
        fs.writeFileSync(path.join(output, 'markup-verification.json'), JSON.stringify({ events, rows: before, browser: browser!.version(), fixture: 'three-private-SQLite-authorities-and-synthetic-rasters', redis: 'Map substitute; real NX separately verified' }, null, 2))
      }
    } finally {
      if (output) {
        fs.mkdirSync(output, { recursive: true })
        const secondDiscussionError = await other.frameLocator('#metasheet-bom-review-frame')
          .getByTestId('plm-discussion-error').allTextContents().catch(() => ['review frame unavailable'])
        fs.writeFileSync(path.join(output, 'markup-progress.json'), JSON.stringify({ events, secondDiscussionError }, null, 2))
        await page.screenshot({ path: path.join(output, 'markup-final-state.png'), fullPage: true }).catch(() => {})
        await other.screenshot({ path: path.join(output, 'second-reviewer-final-state.png'), fullPage: true }).catch(() => {})
      }
      // Restore only this owned fixture for independent following cases.
      spawnSync(PYTHON, ['-c', 'import sqlite3,sys\nwith sqlite3.connect(sys.argv[1]) as db: db.execute("UPDATE meta_item_versions SET is_current=1 WHERE id=?", ("visual-version-1-09",))', productDb])
      await first.close(); await second.close()
    }
  })

  it('workspace sign-out clears the UI cookie and returns to login', async () => {
    const page = await browser!.newPage()
    try {
      await page.goto(`${providerUrl}/login?next=%2Fworkspace`)
      await page.locator('#tenant-id').fill(TENANT)
      await page.locator('#org-id').fill(ORG)
      await page.locator('#username').fill('u42')
      await page.locator('#password').fill('e2e-pw-42')
      await page.locator('#submit').click()
      await browserExpect(page).toHaveURL(`${providerUrl}/workspace`)
      const externalLogoutRequests: string[] = []
      await page.route('https://external.invalid/**', async route => {
        if (route.request().url().endsWith('/auth/logout')) externalLogoutRequests.push(route.request().url())
        await route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': providerUrl,
          'Access-Control-Allow-Headers': 'Content-Type,X-Yuantus-UI-Request', 'Access-Control-Allow-Methods': 'POST,OPTIONS' }, body: '{}' })
      })
      await page.locator('#api-base').fill('https://external.invalid/api')
      await page.evaluate(() => {
        localStorage.setItem('yuantus.workspace.apiBase', 'https://external.invalid/api')
        localStorage.setItem('yuantus.workbench.apiBase', 'https://external.invalid/api')
      })
      const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/logout'))
      await page.locator('#clear-session-button').click()
      const response = await responsePromise
      expect(response.url()).toBe(`${providerUrl}/api/v1/auth/logout`)
      expect(response.status()).toBe(204)
      expect(externalLogoutRequests).toEqual([])
      await browserExpect(page).toHaveURL(`${providerUrl}/login`)
      expect((await page.context().cookies(providerUrl)).some((cookie) => cookie.name === 'yuantus_ui_session')).toBe(false)
    } finally { await page.close() }
  })
})
