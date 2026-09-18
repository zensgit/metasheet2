import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Called only by the owned synthetic database driver, while its production HTTP router is alive.
export async function verifyManualArchiveBrowser(backendOrigin) {
  const target = new URL(backendOrigin)
  assert.equal(target.hostname, '127.0.0.1')
  assert.equal(target.protocol, 'http:')
  const repo = fileURLToPath(new URL('../../../', import.meta.url))
  const web = join(repo, 'apps/web')
  const requireWeb = createRequire(join(web, 'package.json'))
  const requireRoot = createRequire(join(repo, 'package.json'))
  const { createServer } = await import(pathToFileURL(requireWeb.resolve('vite')).href)
  const { default: vue } = await import(pathToFileURL(requireWeb.resolve('@vitejs/plugin-vue')).href)
  const { chromium } = requireRoot('@playwright/test')
  const cache = await mkdtemp(join(tmpdir(), 'tm-manual-browser-cache-'))
  let server
  let browser
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic archive acceptance</title></head>
<body><div id="app"></div><script type="module">
import { createApp, h } from 'vue';
import 'element-plus/dist/index.css';
import '/src/styles/tokens.css';
import RecoveryArchiveModal from '/src/multitable/components/RecoveryArchiveModal.vue';
import { MultitableApiClient } from '/src/multitable/api/client.ts';
const client = new MultitableApiClient({ fetchFn: (url, init={}) => fetch(url, {...init, headers: {...init.headers, authorization:'Bearer synthetic-manual-owner'}}) });
const wire = name => (...args) => client[name](...args);
createApp({render:()=>h(RecoveryArchiveModal, {
visible:true, sheetId:'no-genesis', sheetName:'Synthetic Projects', isZh:false,
fields:[{id:'manual-source-field',name:'Synthetic'}], selectedRecordIds:[],
captureArchive:wire('captureRecoveryArchive'),readCapture:wire('readRecoveryArchiveCapture'),
listCatalog:wire('listRecoveryArchiveCatalog'),listJobs:wire('listRecoveryArchiveJobs'),
previewArchive:wire('previewRecoveryArchive'),executeArchive:wire('executeRecoveryArchive'),
acceptJob:wire('acceptRecoveryArchiveJob'),readJob:wire('readRecoveryArchiveJob'),
resumeJob:wire('resumeRecoveryArchiveJob'),cancelJob:wire('cancelRecoveryArchiveJob'),
})}).mount('#app');
</script><style>body{font:14px system-ui;margin:0}*{box-sizing:border-box}</style></body></html>`
  try {
    server = await createServer({ root: web, configFile: false, cacheDir: cache,
      plugins: [vue(), { name: 'owned-manual-archive-browser-harness', configureServer(vite) {
        vite.middlewares.use('/__manual_archive', async (_req, res, next) => {
          try { res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/__manual_archive', html)) }
          catch (error) { next(error) }
        })
      } }], server: { host: '127.0.0.1', port: 0, hmr: false,
        proxy: { '/api': { target: target.origin } } }, logLevel: 'error' })
    await server.listen()
    const address = server.httpServer.address()
    assert.ok(address && typeof address !== 'string')
    browser = await chromium.launch({ headless: true })
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } })
      const errors = []
      const forbiddenWrites = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('request', request => {
        if (request.method() !== 'GET' && /\/recovery-archive\/(execute|jobs)(?:\/|$)/.test(new URL(request.url()).pathname)) forbiddenWrites.push(request.url())
      })
      await page.goto(`http://127.0.0.1:${address.port}/__manual_archive`)
      const submit = page.locator('[data-test="manual-archive-submit"]')
      await submit.waitFor()
      assert.equal(await submit.isDisabled(), true)
      await page.locator('[data-test="manual-archive-confirm"]').check()
      const responsePromise = page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname.endsWith('/recovery-archive/captures'))
      await submit.click()
      const response = await responsePromise
      assert.equal(response.status(), 200)
      const captured = await response.json()
      assert.equal(captured.data.state, 'recoverable')
      assert.deepEqual(Object.keys(captured.data).sort(), ['generationId', 'requestId', 'state'])
      await page.getByText('Archive available for recovery', { exact: true }).waitFor()
      await page.reload()
      await page.getByText('Archive available for recovery', { exact: true }).waitFor()
      await page.locator(`[data-test="archive-recovery-entry-${captured.data.generationId}"]`).click()
      const previewPromise = page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname.endsWith('/recovery-archive/preview'))
      await page.locator('[data-test="archive-recovery-request-preview"]').click()
      const previewResponse = await previewPromise
      assert.equal(previewResponse.status(), 200)
      const preview = await previewResponse.json()
      assert.equal(preview.data.generationId, captured.data.generationId)
      assert.equal(preview.data.blockedReason, 'no_changes')
      assert.equal(preview.data.executable, false)
      assert.equal(await page.locator('[data-test="archive-recovery-execute"]').count(), 0)
      assert.deepEqual(forbiddenWrites, [])
      assert.deepEqual(errors, [])
      assert.equal(await page.locator('[role="dialog"]').evaluate(element => element.scrollWidth > element.clientWidth), false)
      await page.screenshot({ path: join(tmpdir(), `tm-manual-http-browser-${width}.png`), fullPage: true })
      await page.close()
      console.log(`PASS: Chromium ${width} production component/client -> HTTP capture/reload/catalog/preview; no restore request`)
    }
  } catch (error) {
    for (const context of browser?.contexts() ?? []) {
      for (const page of context.pages()) {
        await page.screenshot({ path: join(tmpdir(), 'tm-manual-http-browser-failure.png'), fullPage: true }).catch(() => {})
        await writeFile(join(tmpdir(), 'tm-manual-http-browser-failure.txt'), await page.locator('body').innerText()).catch(() => {})
      }
    }
    throw error
  } finally {
    try { if (browser) await browser.close() } finally {
      try { if (server) await server.close() } finally { await rm(cache, { recursive: true, force: true }) }
    }
  }
  console.log('CLEAN: owned browser, Vite listener and cache closed/removed')
}
