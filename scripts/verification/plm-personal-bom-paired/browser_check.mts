import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

/** Real Chromium + actual Vue components + owned Meta HTTP; no network response fixtures. */
export async function verifyBrowser(input: { metaCheckout: string; metaBase: string; jwt: string; grant: string; customerEntry?: boolean; disableWrites: () => Promise<void> }) {
  const web = input.metaCheckout + '/apps/web'
  const require = createRequire(web + '/package.json')
  const { createServer } = await import(require.resolve('vite'))
  const { default: vue } = await import(require.resolve('@vitejs/plugin-vue'))
  const { chromium } = require('@playwright/test')
  if (input.customerEntry) {
    const claims = JSON.parse(Buffer.from(input.jwt.split('.')[1], 'base64url').toString())
    assert.equal(claims.role, 'user')
    assert(Array.isArray(claims.perms) && !claims.perms.includes('integration:write'))
  }
  let browser: any
  const requests: { path: string; method: string; key: string | undefined; ifMatch: string | undefined; body: unknown }[] = []
  const entryPath = input.customerEntry ? '/plm/bom-review' : '/__paired_browser'
  const entryHtml = input.customerEntry
    ? '<div id="app"></div><script type="module">import {createApp,h} from "vue";import {createRouter,createWebHistory,RouterView} from "vue-router";import {appRoutes} from "/src/router/appRoutes.ts";const route=appRoutes.find(r=>r.path==="/plm/bom-review");if(!route)throw new Error("customer BOM route missing");const router=createRouter({history:createWebHistory(),routes:[route]});const app=createApp({render:()=>h(RouterView)});app.use(router);await router.isReady();app.mount("#app")</script>'
    : '<div id="app"></div><script type="module">import {createApp,h} from "vue";import Panel from "/src/components/plm/PlmBomReviewPanel.vue";createApp({render:()=>h(Panel,{dataSourceId:"source-1",ecoIntentEnabled:true})}).mount("#app")</script>'
  const vite = await createServer({
    configFile: false, root: web, envDir: process.cwd(), cacheDir: process.cwd() + '/vite-cache', logLevel: 'error',
    resolve: { alias: { '@': web + '/src' } },
    plugins: [vue(), {
      name: 'owned-personal-bom-browser-harness',
      configureServer(server: any) {
        server.middlewares.use(entryPath, async (_req: unknown, res: any) => {
          res.setHeader('Content-Type', 'text/html')
          res.end(await server.transformIndexHtml(entryPath, entryHtml))
        })
      },
    }],
    server: { host: '127.0.0.1', port: 0, strictPort: true, proxy: { '/api': input.metaBase } },
  })
  try {
    await vite.listen()
    const address = vite.httpServer!.address() as { port: number }
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext()
    await context.addInitScript((jwt: string) => localStorage.setItem('auth_token', jwt), input.jwt)
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors: string[] = []
    page.on('pageerror', (error: Error) => errors.push(error.message))
    page.on('request', (request: any) => {
      const path = new URL(request.url()).pathname
      if (path.startsWith('/api/')) requests.push({ path, method: request.method(), key: request.headers()['idempotency-key'], ifMatch: request.headers()['if-match'], body: request.postDataJSON() })
    })
    await page.goto(`http://127.0.0.1:${address.port}${entryPath}${input.customerEntry ? '?dataSourceId=source-1&partId=part' : ''}`)
    await page.getByTestId('plm-bom-review-panel').waitFor()
    if (input.customerEntry) {
      await page.locator('[data-testid="plm-bom-review-state"][data-state="table"]').waitFor()
      assert.equal(await page.getByTestId('plm-bom-review-part-input').inputValue(), 'part')
      assert(requests.some(r => r.method === 'GET' && r.path.endsWith('/part/context')))
      assert(requests.every(r => r.method === 'GET'), 'customer deep link may read, never mutate')
    } else assert.equal(requests.length, 0, 'manual panel mount must not fetch/write PLM')
    await page.getByTestId('plm-bom-write-bindings-open').click()
    await page.getByTestId('plm-bom-write-grant').fill(input.grant)
    await page.getByTestId('plm-bom-write-connection-id').fill('personal-fixture')
    const bindResponse = page.waitForResponse((r: any) => new URL(r.url()).pathname === '/api/me/plm-bom-write-bindings' && r.request().method() === 'POST')
    await page.getByTestId('plm-bom-write-bind').click()
    assert.equal((await bindResponse).status(), 201)
    assert.equal(await page.getByTestId('plm-bom-write-grant').inputValue(), '')
    await page.getByTestId('plm-bom-write-binding-row').waitFor()
    assert.equal(new URL(await page.getByTestId('plm-bom-write-management-link').getAttribute('href')).hash, '#bom-write')
    const mutation = (kind: string) => requests.filter(r => kind === 'line' ? r.method === 'PATCH' : r.method === 'POST' && r.path.endsWith('/eco-intent'))
    async function load(part: string) {
      await page.getByTestId('plm-bom-review-part-input').fill(part)
      await page.getByTestId('plm-bom-review-load').click()
      await page.locator('[data-testid="plm-bom-review-state"][data-state="table"]').waitFor()
    }
    async function storage() { return page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('metasheet.plm.bom-write-pending.v1.')))) }
    await load('part')
    await page.getByTestId('plm-bom-review-quantity-input').fill('8')
    const lineResponse = page.waitForResponse((r: any) => r.request().method() === 'PATCH')
    await page.getByTestId('plm-bom-review-save').click()
    assert.equal((await lineResponse).status(), 503)
    await page.getByTestId('plm-bom-write-retry').waitFor()
    const lineBefore = await storage()
    assert.equal(Object.keys(lineBefore).length, 1)
    assert(!JSON.stringify(lineBefore).includes(input.grant))
    assert(!JSON.stringify(lineBefore).includes(input.jwt))
    await page.reload(); await page.getByTestId('plm-bom-review-panel').waitFor()
    assert.equal(mutation('line').length, 1, 'refresh cannot resend write')
    assert.deepEqual(await storage(), lineBefore)
    await load('part')
    await page.getByTestId('plm-bom-review-quantity-input').fill('9')
    const retryResponse = page.waitForResponse((r: any) => r.request().method() === 'PATCH')
    await page.getByTestId('plm-bom-write-retry').click()
    assert.equal((await retryResponse).status(), 200)
    await page.getByTestId('plm-bom-write-retry').waitFor({ state: 'detached' })
    assert.equal(mutation('line').length, 2)
    assert(mutation('line')[0].ifMatch, 'actual read projection supplies If-Match')
    assert.equal(mutation('line')[0].ifMatch, mutation('line')[1].ifMatch)
    assert.equal(mutation('line')[0].key, mutation('line')[1].key)
    assert.deepEqual(mutation('line')[0].body, mutation('line')[1].body)
    assert.equal(Object.keys(await storage()).length, 0)
    // A new explicit edit after an accepted replay needs the new source ETag.
    await page.getByTestId('plm-bom-review-quantity-input').fill('10')
    const secondEdit = page.waitForResponse((r: any) => r.request().method() === 'PATCH')
    await page.getByTestId('plm-bom-review-save').click()
    assert.equal((await secondEdit).status(), 200, 'separate new edit must use refreshed native ETag')
    await page.getByTestId('plm-bom-review-line-message').filter({ hasText: '写回成功' }).waitFor()
    assert.equal(mutation('line').length, 3)
    assert.notEqual(mutation('line')[2].key, mutation('line')[0].key)
    assert.notEqual(mutation('line')[2].ifMatch, mutation('line')[0].ifMatch)
    assert.equal(Object.keys(await storage()).length, 0)
    await load('locked-part')
    const ecoResponse = page.waitForResponse((r: any) => new URL(r.url()).pathname.endsWith('/eco-intent'))
    await page.getByTestId('plm-bom-review-eco-intent-cta').click()
    assert.equal((await ecoResponse).status(), 503)
    await page.getByTestId('plm-bom-write-retry').waitFor()
    const ecoBefore = await storage()
    assert(!JSON.stringify(ecoBefore).includes(input.grant))
    assert(!JSON.stringify(ecoBefore).includes(input.jwt))
    await page.reload(); await page.getByTestId('plm-bom-review-panel').waitFor()
    assert.equal(mutation('eco').length, 1)
    assert.deepEqual(await storage(), ecoBefore)
    await load('locked-part')
    const ecoRetry = page.waitForResponse((r: any) => new URL(r.url()).pathname.endsWith('/eco-intent'))
    await page.getByTestId('plm-bom-write-retry').click()
    assert.equal((await ecoRetry).status(), 200)
    await page.getByTestId('plm-bom-write-retry').waitFor({ state: 'detached' })
    assert.equal(mutation('eco').length, 2)
    assert.equal(mutation('eco')[0].key, mutation('eco')[1].key)
    assert.equal(Object.keys(await storage()).length, 0)
    await input.disableWrites()
    await page.getByTestId('plm-bom-write-bindings-open').click()
    await page.getByTestId('plm-bom-write-unbind').waitFor()
    const unbound = page.waitForResponse((r: any) => r.request().method() === 'DELETE')
    await page.getByTestId('plm-bom-write-unbind').click()
    assert.equal((await unbound).status(), 200)
    assert.equal(errors.length, 0, errors.join('\n'))
    await context.close()
    return { actual_chromium: true, actual_vue_components: true, actual_customer_route: input.customerEntry === true, ordinary_meta_without_integration_write: input.customerEntry === true, whole_main_bootstrap: false, network_fixtures: false, line_requests: 3, eco_requests: 2, consecutive_distinct_edits_with_fresh_etag: true, both_refreshes_no_automatic_write: true, same_frozen_body_and_key: true, grant_input_cleared: true, no_grant_in_pending_storage: true, no_login_jwt_in_pending_storage: true, pending_removed_only_after_receipt: true, unbind_status: 200, disabled_feature_cleanup: true }
  } finally {
    if (browser) await browser.close()
    await vite.close()
  }
}
