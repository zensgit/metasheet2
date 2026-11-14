/// <reference lib="dom" />
// C1/S2 first slice — C01 real-browser case (evidence D §7 C01: real host + browser).
//
// Actual Chromium -> the actual Vue MetaAutomationIntegrationPreview with the production MultitableApiClient
// (apiFetch, the stored session token) -> a same-origin Vite proxy -> the actual MetaSheetServer (real login
// JWT, real route mount, the AutomationService-owned preview runtime, the host fetch that refuses and counts)
// -> a fully migrated PostgreSQL database that this file creates in the launcher-owned cluster and drops.
//
// Runs only inside scripts/ops/run-stock-preparation-yida-browser-ci.mjs (Linux user/net/PID namespaces,
// loopback only): the native network isolation is asserted before Chromium starts, and Chromium routes
// abort anything that is not the owned UI origin. No request or response is fulfilled or rewritten.
// Synthetic fixtures only: no customer data, no DingTalk/YiDa call, no send, approval or write-back.
import { randomBytes, randomUUID } from 'node:crypto'
import { promises as fsPromises } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Browser, BrowserContext, Page, Response as BrowserResponse } from '@playwright/test'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Plugin, ViteDevServer } from '../../../../apps/web/node_modules/vite'
import type { YidaHostBoundaryHarness } from '../utils/yida-host-boundary-server'

it('sentinel: the synthetic preview browser proof requires EXPECT_DB=1 and a dedicated DATABASE_URL', () => {
  expect(process.env.EXPECT_DB).toBe('1')
  expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})
const databaseSuite = process.env.EXPECT_DB === '1' && process.env.DATABASE_URL ? describe : describe.skip

const root = path.resolve(__dirname, '..', '..', '..', '..')
const backendRoot = path.join(root, 'packages', 'core-backend')
const webRoot = path.join(root, 'apps', 'web')
const htmlPath = '/__synthetic-integration-preview-browser'
const FLAG = 'AUTOMATION_SYNTHETIC_INTEGRATION_PREVIEW_ENABLED'
const VALUE_MARKERS = /SYN-DRW|SYN-LINE|SYN-SPEC|合成部件|SYN-MAT/
// The same exclusions as the plugin-tests "Run DB migrations" step: legacy files that do not replay on an
// empty database (see the MIGRATION_EXCLUDE comment there). Everything else migrates exactly as in CI.
const MIGRATION_EXCLUDE = '008_plugin_infrastructure.sql,048_create_event_bus_tables.sql,049_create_bpmn_workflow_tables.sql,'
  + '042a_core_model_views.sql,20250924140000_create_gantt_tables.ts,20250925_create_view_tables.sql'
const SAVED_ENV_KEYS = ['DATABASE_URL', 'MIGRATION_EXCLUDE', 'LOG_LEVEL', FLAG] as const

type ApiRequest = { method: string; path: string; body: unknown; correctSession: boolean; tenantHeader: string | null; otherScopeHeaders: boolean }
type StorageProbe = { writes: string[]; localKeys: string[]; sessionLength: number; indexedDbNames: string[]; cacheNames: string[] }

function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error('SYNTHETIC_PREVIEW_BROWSER_' + code)
}

databaseSuite('C01 real browser — Chromium drives MetaAutomationIntegrationPreview against the actual host', () => {
  const savedEnv = new Map<string, string | undefined>(SAVED_ENV_KEYS.map((key) => [key, process.env[key]]))
  const databaseName = `synthetic_preview_browser_${randomBytes(6).toString('hex')}`
  const sheetId = `sheet_synthetic_browser_${randomUUID().replace(/-/g, '')}`
  const ruleId = `atr_synthetic_browser_${randomUUID().replace(/-/g, '')}`
  const catalogPath = `/api/multitable/sheets/${sheetId}/automations/integration-preview/catalog`
  const previewPath = `/api/multitable/sheets/${sheetId}/automations/${ruleId}/integration-preview`
  let admin: Pool | undefined
  let databaseCreated = false
  let hostPoolOpened = false
  let h: YidaHostBoundaryHarness | undefined
  let vite: ViteDevServer | undefined
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  let page: Page | undefined
  let uiOrigin = ''
  let violations: string[] = []
  let requests: ApiRequest[] = []
  let pageErrors = 0

  async function businessCounts(): Promise<Record<string, number>> {
    const counts: Record<string, number> = { ...(await h!.yidaTableCounts()) }
    for (const table of ['meta_records', 'automation_rules', 'meta_sheets', 'multitable_automation_jobs', 'meta_automation_outbox']) {
      const exists = (await h!.pool.query('SELECT to_regclass($1) AS name', [table])).rows[0]?.name
      if (exists) counts[table] = Number((await h!.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n)
    }
    return counts
  }
  async function summaryRows() {
    return (await h!.pool.query('SELECT * FROM multitable_automation_executions WHERE rule_id = $1 ORDER BY triggered_at', [ruleId])).rows
  }
  async function storageProbe(): Promise<StorageProbe> {
    return page!.evaluate(async () => {
      const probe = window as unknown as { __syntheticStorageWrites?: string[] }
      const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : []
      const cacheNames = typeof caches === 'undefined' ? [] : await caches.keys()
      return {
        writes: [...(probe.__syntheticStorageWrites ?? ['RECORDER_MISSING'])],
        localKeys: Object.keys(localStorage).sort(),
        sessionLength: sessionStorage.length,
        indexedDbNames: databases.map((entry) => String(entry.name)),
        cacheNames,
      }
    })
  }
  function expectNoBrowserStorage(probe: StorageProbe) {
    // auth_token is the synthetic session installed by this harness before the page loaded.
    expect(probe).toEqual({ writes: [], localKeys: ['auth_token'], sessionLength: 0, indexedDbNames: [], cacheNames: [] })
  }
  async function settled() {
    await page!.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  }
  function waitApi(method: string, apiPath: string): Promise<BrowserResponse> {
    return page!.waitForResponse((response) => response.request().method() === method
      && new URL(response.url()).pathname === apiPath, { timeout: 20000 })
  }
  async function openHarness(): Promise<BrowserResponse> {
    check(browser && h, 'HARNESS_NOT_READY')
    violations = []
    requests = []
    pageErrors = 0
    context = await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: 'zh-CN', serviceWorkers: 'block' })
    // Harness setup only: the synthetic session token, then a recorder of every later storage write.
    await context.addInitScript(({ authToken, ownedOrigin }) => {
      if (location.origin !== ownedOrigin) return
      localStorage.setItem('auth_token', authToken)
      const writes: string[] = []
      Object.defineProperty(window, '__syntheticStorageWrites', { value: writes })
      const proto = Storage.prototype
      for (const method of ['setItem', 'removeItem', 'clear'] as const) {
        const original = proto[method] as (...args: unknown[]) => unknown
        Object.defineProperty(proto, method, {
          configurable: true,
          writable: true,
          value(this: Storage, ...args: unknown[]) {
            writes.push(`${this === localStorage ? 'localStorage' : 'sessionStorage'}.${method}:${String(args[0] ?? '')}`)
            return original.apply(this, args)
          },
        })
      }
      const open = indexedDB.open.bind(indexedDB)
      Object.defineProperty(indexedDB, 'open', {
        configurable: true,
        value: (name: string, version?: number) => { writes.push(`indexedDB.open:${name}`); return open(name, version) },
      })
    }, { authToken: h.admin.token, ownedOrigin: uiOrigin })
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (url.origin !== uiOrigin) {
        violations.push('EXTERNAL_REQUEST')
        await route.abort('blockedbyclient')
        return
      }
      await route.continue()
    })
    context.on('request', (request) => {
      const url = new URL(request.url())
      if (!url.pathname.startsWith('/api/')) return
      const headers = request.headers()
      requests.push({
        method: request.method(),
        path: url.pathname + url.search,
        body: request.postData() === null ? null : request.postDataJSON(),
        correctSession: headers.authorization === `Bearer ${h!.admin.token}`,
        // The production SDK derives x-tenant-id from the token's own claim; the route never reads it
        // (it uses the verified JWT tenant). Recorded only to prove the browser sent no other tenant.
        tenantHeader: headers['x-tenant-id'] ?? null,
        otherScopeHeaders: ['x-workspace-id', 'x-owner-id'].some((key) => Object.hasOwn(headers, key)),
      })
    })
    context.on('requestfailed', () => { violations.push('REQUEST_FAILED') })
    page = await context.newPage()
    page.on('pageerror', () => { pageErrors += 1 })
    const catalog = waitApi('GET', catalogPath)
    await page.goto(uiOrigin + htmlPath, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => document.body.dataset.previewHarnessReady === '1')
    return catalog
  }

  beforeAll(async () => {
    // 1. A dedicated database in the launcher-owned cluster, so no other launcher file shares its schema.
    const base = new URL(process.env.DATABASE_URL!)
    check(base.hostname === '127.0.0.1' || base.hostname === 'localhost', 'LOOPBACK_DATABASE_REQUIRED')
    check(/^synthetic_preview_browser_[a-f0-9]{12}$/u.test(databaseName), 'DATABASE_NAME')
    admin = new Pool({ connectionString: base.toString(), max: 1 })
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    databaseCreated = true
    const scoped = new URL(base.toString())
    scoped.pathname = '/' + databaseName
    process.env.DATABASE_URL = scoped.toString()
    process.env.LOG_LEVEL = 'error'
    delete process.env[FLAG]

    // 2. Every migration, through the production migrator and provider (the db:migrate path).
    process.env.MIGRATION_EXCLUDE = MIGRATION_EXCLUDE
    const { Migrator } = await import('kysely')
    const { db } = await import('../../src/db/db')
    hostPoolOpened = true
    const { createCoreBackendMigrationProvider } = await import('../../src/db/migration-provider')
    const migrator = new Migrator({
      db,
      allowUnorderedMigrations: true,
      provider: createCoreBackendMigrationProvider({ fsImpl: fsPromises, pathImpl: path, runtimeDir: path.join(backendRoot, 'src', 'db') }),
    })
    const migrated = await migrator.migrateToLatest()
    // Only repository migration file names and statuses are named; the database error stays private.
    const failedMigrations = (migrated.results ?? []).filter((row) => row.status !== 'Success').map((row) => `${row.migrationName}:${row.status}`)
    if (migrated.error || failedMigrations.length > 0 || (migrated.results ?? []).length === 0) {
      throw new Error(`SYNTHETIC_PREVIEW_BROWSER_MIGRATION_FAILED ${failedMigrations.slice(0, 3).join(',')}`)
    }

    // 3. The actual MetaSheetServer with real logins (switch OFF at boot) and the seeded synthetic rule.
    const { bootYidaHostBoundaryServer } = await import('../utils/yida-host-boundary-server')
    h = await bootYidaHostBoundaryServer()
    await h.pool.query('INSERT INTO meta_sheets (id, name) VALUES ($1, $2)', [sheetId, 'Synthetic browser preview sheet'])
    await h.pool.query(`INSERT INTO automation_rules (id, sheet_id, name, trigger_type, trigger_config, action_type, action_config, enabled, created_by)
      VALUES ($1, $2, 'Synthetic browser preview rule', 'record.created', '{}'::jsonb, 'send_webhook', '{}'::jsonb, false, $3)`, [ruleId, sheetId, h.admin.id])
    const address = h.server.getAddress()
    check(address && typeof address !== 'string', 'HOST_ADDRESS')
    const apiOrigin = `http://127.0.0.1:${address.port}`

    // 4. The actual Vue panel from apps/web, served by Vite with /api proxied unchanged to the host.
    const webRequire = createRequire(path.join(webRoot, 'package.json'))
    const { createServer } = await import(pathToFileURL(webRequire.resolve('vite')).href) as typeof import('../../../../apps/web/node_modules/vite')
    const { default: vue } = await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-vue')).href) as { default: () => Plugin }
    const { chromium } = await import(pathToFileURL(webRequire.resolve('@playwright/test')).href) as typeof import('@playwright/test')
    const cacheDir = path.join(root, 'tmp', 'synthetic-preview-browser', randomUUID(), 'cache')
    await mkdir(cacheDir, { recursive: true })
    const escaped = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c')
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head>
      <body><div id="app"></div><script type="module">
      import {createApp,h,ref,onMounted} from 'vue';
      import Preview from '/src/multitable/components/MetaAutomationIntegrationPreview.vue';
      import {MultitableApiClient} from '/src/multitable/api/client.ts';
      const client = new MultitableApiClient();
      createApp({setup(){
        const visible = ref(true), mounted = ref(true);
        onMounted(() => { document.body.dataset.previewHarnessReady = '1'; });
        return () => h('main', [
          h('button', {'data-testid':'harness-close', onClick: () => { visible.value = false; }}, 'close drawer'),
          h('button', {'data-testid':'harness-open', onClick: () => { visible.value = true; }}, 'open drawer'),
          h('button', {'data-testid':'harness-unmount', onClick: () => { mounted.value = false; }}, 'unmount'),
          mounted.value
            ? h(Preview, {visible: visible.value, sheetId: ${escaped(sheetId)}, rules: [{id: ${escaped(ruleId)}, name: 'Synthetic browser preview rule'}], client})
            : h('p', {'data-testid':'harness-unmounted'}, 'unmounted'),
        ]);
      }}).mount('#app');
      </script></body></html>`
    vite = await createServer({
      root: webRoot,
      configFile: false,
      envFile: false,
      cacheDir,
      define: { 'import.meta.env.VITE_API_URL': '""', 'import.meta.env.VITE_API_BASE': '""' },
      plugins: [vue(), {
        name: 'synthetic-integration-preview-browser',
        configureServer(server) {
          server.middlewares.use(htmlPath, async (_request, response, next) => {
            try {
              response.setHeader('Content-Type', 'text/html; charset=utf-8')
              response.end(await server.transformIndexHtml(htmlPath, html))
            } catch { next(new Error('SYNTHETIC_PREVIEW_BROWSER_HARNESS_FAILED')) }
          })
        },
      } as Plugin],
      optimizeDeps: { include: ['vue'] },
      server: { host: '127.0.0.1', port: 0, hmr: false, proxy: { '/api': { target: apiOrigin, changeOrigin: false, proxyTimeout: 15000 } } },
    })
    const httpServer = vite.httpServer
    check(httpServer, 'UI_SERVER')
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject)
      void Promise.resolve(httpServer.listen(0, '127.0.0.1', () => { httpServer.removeListener('error', reject); resolve() })).catch(reject)
    })
    const uiAddress = httpServer.address()
    check(uiAddress && typeof uiAddress !== 'string', 'UI_ADDRESS')
    uiOrigin = `http://127.0.0.1:${uiAddress.port}`

    // 5. Native isolation first (installed only by the launcher's capability-free worker), then Chromium.
    const nativeIsolation = webRequire(path.join(root, 'scripts/ops/lib/stock-preparation-browser-network-isolation.cjs')) as
      { assertBrowserNetworkIsolation(): unknown }
    nativeIsolation.assertBrowserNetworkIsolation()
    const { browserFromOwner } = webRequire(path.join(root, 'scripts/ops/lib/stock-preparation-yida-browser-candidate.cjs')) as {
      browserFromOwner(root: string, env: NodeJS.ProcessEnv): { executablePath: string; version: string } | undefined
    }
    const candidate = browserFromOwner(root, process.env)
    browser = await chromium.launch({ headless: true, executablePath: candidate?.executablePath ?? chromium.executablePath() })
    if (candidate) check(browser.version() === candidate.version, 'PINNED_BROWSER_VERSION')
  }, 300000)

  afterEach(async () => {
    try {
      expect(violations).toEqual([])
      expect(pageErrors).toBe(0)
      expect(requests.every((request) => request.correctSession && !request.otherScopeHeaders
        && (request.tenantHeader === null || request.tenantHeader === h!.tenantId))).toBe(true)
    } finally {
      await context?.close()
      context = undefined
      page = undefined
    }
  }, 30000)

  afterAll(async () => {
    try {
      await context?.close().catch(() => undefined)
      await browser?.close().catch(() => undefined)
      ;(vite?.httpServer as { closeAllConnections?(): void } | undefined)?.closeAllConnections?.()
      await vite?.close().catch(() => undefined)
      if (h) {
        await h.pool.query('DELETE FROM multitable_automation_executions WHERE rule_id = $1', [ruleId]).catch(() => undefined)
        await h.cleanup()
      } else if (hostPoolOpened) {
        // The host never booted: end the migration's pool (the host's own pool) before the database is dropped.
        const { poolManager } = await import('../../src/integration/db/connection-pool')
        const internal = poolManager.get().getInternalPool() as Pool & { ending?: boolean }
        if (internal.ending !== true) await internal.end().catch(() => undefined)
      }
    } finally {
      try {
        if (admin && databaseCreated) await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
      } finally {
        await admin?.end().catch(() => undefined)
        for (const [key, value] of savedEnv) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
    }
  }, 120000)

  it('switch OFF: the real panel asks once, the host answers the fixed 404, nothing renders and nothing is written', async () => {
    delete process.env[FLAG]
    const before = await businessCounts()
    const catalog = await openHarness()
    expect(catalog.status()).toBe(404)
    expect((await catalog.allHeaders())['cache-control']).toBe('no-store')
    expect((await catalog.json() as { error?: { code?: string } }).error?.code).toBe('INTEGRATION_PREVIEW_DISABLED')
    await settled()
    expect(await page!.locator('[data-integration-preview]').count()).toBe(0)
    expect(requests.map((request) => [request.method, request.path])).toEqual([['GET', catalogPath]])
    expect(h!.fetchCalls()).toBe(0)
    expect(await businessCounts()).toEqual(before)
    expect(await summaryRows()).toHaveLength(0)
    expectNoBrowserStorage(await storageProbe())
  }, 60000)

  it('C01: Chromium runs the synthetic preview end to end; zero business network, zero business rows, no browser storage, digest equals the pure compiler', async () => {
    process.env[FLAG] = 'true'
    const before = await businessCounts()
    const catalog = await openHarness()
    expect(catalog.status()).toBe(200)
    await page!.locator('[data-integration-preview]').waitFor()
    // No send / approve / submit affordance anywhere in the rendered panel.
    expect((await page!.locator('[data-integration-preview] button').allInnerTexts()).join(' ')).not.toMatch(/发送|批准|提交|send|approve|submit/i)
    expect(await page!.locator('[data-integration-preview-rule]').inputValue()).toBe(ruleId)
    expect(await page!.locator('[data-integration-preview-fixture]').inputValue()).toBe('synthetic-materials.two-page.v1')
    expect(await page!.locator('[data-integration-preview-preset]').inputValue()).toBe('yida-material-v3.original.v1')

    const answered = waitApi('POST', previewPath)
    await page!.locator('[data-integration-preview-run]').click()
    const response = await answered
    expect(response.status()).toBe(200)
    expect((await response.allHeaders())['cache-control']).toBe('no-store')
    const body = await response.json() as {
      canSend: boolean; canApply: boolean; tokenIssued: boolean; externalWriteAttempted: boolean
      summary: { outcome: string; counts: { pages: number; rows: number } }
      preview: { planDigest: string; rowCount: number; rows: Array<{ fields: Record<string, unknown> }> }
    }
    expect(body).toMatchObject({ ok: true, synthetic: true, canSend: false, canApply: false, tokenIssued: false, externalWriteAttempted: false })
    expect(body.summary.outcome).toBe('OK')
    expect(body.summary.counts).toMatchObject({ pages: 2, rows: 3 })
    expect(body.preview.rowCount).toBe(3)

    // What the browser rendered is the host's answer: row count, digest and the synthetic values.
    await page!.locator('[data-integration-preview-result]').waitFor()
    expect(await page!.locator('[data-integration-preview-row]').count()).toBe(body.preview.rowCount)
    expect(await page!.locator('[data-integration-preview-summary] [title]').getAttribute('title')).toBe(body.preview.planDigest)
    expect(await page!.locator('[data-integration-preview-rows]').innerText()).toMatch(VALUE_MARKERS)
    expect(await page!.locator('[data-integration-preview-no-send]').count()).toBe(1)

    // The browser's request was exactly the three fixed ids on the preview endpoint, after one catalog read.
    expect(requests.map((request) => [request.method, request.path])).toEqual([['GET', catalogPath], ['POST', previewPath]])
    expect(requests[1].body).toEqual({ planId: 'plm-material-to-yida-preview.v1', fixtureId: 'synthetic-materials.two-page.v1', mappingPresetId: 'yida-material-v3.original.v1' })

    // Digest parity: the same synthetic rows through the pure compiler directly.
    const { syntheticMaterialFixture, syntheticYidaMappingPreset } = await import('../../src/integration/automation-operation-catalog')
    const lib = path.join(root, 'plugins', 'plugin-integration-core', 'lib', 'yida-draft-compiler.mjs')
    const { compileYidaLocalDraft } = await import(pathToFileURL(lib).href)
    const presetRules = syntheticYidaMappingPreset('yida-material-v3.original.v1')
    const rows = syntheticMaterialFixture('synthetic-materials.two-page.v1').pages.flatMap((entry) => entry.rows)
    const direct = compileYidaLocalDraft({ config: { ...JSON.parse(JSON.stringify(presetRules.rules)), target: { ...presetRules.target } }, rowsText: JSON.stringify(rows), allocation: { mode: 'original' } })
    expect(body.preview.planDigest).toBe(direct.planDigest)

    // Zero business network (the host fetch refuses and counts; Chromium reached no other origin), zero
    // business rows (records, rules, jobs, outbox and every integration_yida_* table unchanged), exactly one
    // values-free summary row, nothing in browser storage.
    expect(h!.fetchCalls()).toBe(0)
    expect(await businessCounts()).toEqual(before)
    const stored = await summaryRows()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ triggered_by: 'integration_preview', status: 'success', trigger_event: null, rule_snapshot: null, initiated_by: h!.admin.id })
    expect(JSON.stringify(stored[0])).not.toMatch(VALUE_MARKERS)
    expectNoBrowserStorage(await storageProbe())

    // Drawer closed: the result leaves the DOM; reopened (catalog 200 again): no stale result before a run.
    await page!.getByTestId('harness-close').click()
    await settled()
    expect(await page!.locator('[data-integration-preview]').count()).toBe(0)
    expect(await page!.locator('body').innerText()).not.toMatch(VALUE_MARKERS)
    const reopened = waitApi('GET', catalogPath)
    await page!.getByTestId('harness-open').click()
    expect((await reopened).status()).toBe(200)
    await page!.locator('[data-integration-preview]').waitFor()
    await settled()
    expect(await page!.locator('[data-integration-preview-result]').count()).toBe(0)
    expect(await page!.locator('body').innerText()).not.toMatch(VALUE_MARKERS)

    // Unmount: nothing left behind, still nothing stored, still one summary row and zero business network.
    await page!.getByTestId('harness-unmount').click()
    await page!.getByTestId('harness-unmounted').waitFor()
    expect(await page!.locator('body').innerText()).not.toMatch(VALUE_MARKERS)
    expect(requests.map((request) => [request.method, request.path])).toEqual([['GET', catalogPath], ['POST', previewPath], ['GET', catalogPath]])
    expectNoBrowserStorage(await storageProbe())
    expect(await summaryRows()).toHaveLength(1)
    expect(await businessCounts()).toEqual(before)
    expect(h!.fetchCalls()).toBe(0)
  }, 90000)
})
