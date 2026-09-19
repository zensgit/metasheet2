import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Called only by the owned synthetic database driver, while its production HTTP router is alive.
export async function verifyManualArchiveBrowser(backendOrigin, syntheticEdit, kind = 'scalar', bearer = 'synthetic-manual-owner') {
  assert.ok(['scalar', 'attachment', 'workbench'].includes(kind))
  assert.equal(typeof bearer, 'string')
  assert.match(bearer, /^[A-Za-z0-9_.-]+$/)
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
  const workbench = kind === 'workbench'
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic archive acceptance</title></head>
<body><div id="app"></div><script type="module">
import { createApp, h } from 'vue';
import 'element-plus/dist/index.css';
import '/src/styles/tokens.css';
${workbench ? `import MultitableWorkbench from '/src/multitable/views/MultitableWorkbench.vue';
import ElementPlus from 'element-plus';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
localStorage.setItem('auth_token', ${JSON.stringify(bearer)});
const router = createRouter({history:createWebHistory(),routes:[{path:'/:pathMatch(.*)*',component:{render:()=>null}}]});
createApp({render:()=>h(MultitableWorkbench,{baseId:'b',sheetId:'no-genesis',viewId:'manual-browser-grid',
onReady:()=>{document.documentElement.dataset.workbenchReady='true'}})})
.use(createPinia()).use(ElementPlus).use(router).mount('#app');` : `
import RecoveryArchiveModal from '/src/multitable/components/RecoveryArchiveModal.vue';
import { MultitableApiClient } from '/src/multitable/api/client.ts';
const client = new MultitableApiClient({ fetchFn: (url, init={}) => fetch(url, {...init, headers: {...init.headers, authorization:${JSON.stringify(`Bearer ${bearer}`)}}}) });
const wire = name => (...args) => client[name](...args);
createApp({render:()=>h(RecoveryArchiveModal, {
visible:true, sheetId:'no-genesis', sheetName:'Synthetic Projects', isZh:false,
fields:[{id:'manual-source-field',name:'Synthetic'},{id:'manual-attachment-field',name:'Synthetic files'}], selectedRecordIds:[],
onExecuted:()=>{document.documentElement.dataset.archiveExecuted=String(Number(document.documentElement.dataset.archiveExecuted||0)+1)},
captureArchive:wire('captureRecoveryArchive'),readCapture:wire('readRecoveryArchiveCapture'),
listCatalog:wire('listRecoveryArchiveCatalog'),listJobs:wire('listRecoveryArchiveJobs'),
previewArchive:wire('previewRecoveryArchive'),executeArchive:wire('executeRecoveryArchive'),
acceptJob:wire('acceptRecoveryArchiveJob'),readJob:wire('readRecoveryArchiveJob'),
resumeJob:wire('resumeRecoveryArchiveJob'),cancelJob:wire('cancelRecoveryArchiveJob'),
})}).mount('#app');`}
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
      const apiFailures = []
      const forbiddenWrites = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('requestfailed', request => {
        if (new URL(request.url()).pathname.startsWith('/api/')) apiFailures.push('API_REQUEST_FAILED')
      })
      page.on('response', response => {
        const path = new URL(response.url()).pathname
        if (path.startsWith('/api/') && !response.ok()) apiFailures.push(`API_STATUS_${response.status()}:${path}`)
      })
      page.on('request', request => {
        if (request.method() !== 'GET' && /\/recovery-archive\/(execute|jobs)(?:\/|$)/.test(new URL(request.url()).pathname)) forbiddenWrites.push(request.url())
      })
      await page.goto(`http://127.0.0.1:${address.port}/__manual_archive`)
      const openWorkbenchArchive = async () => {
        await page.locator('html[data-workbench-ready="true"]').waitFor()
        await page.locator('.meta-grid__row').first().waitFor()
        await page.locator('[data-action="open-archive-recovery"]').click()
      }
      if (workbench) await openWorkbenchArchive()
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
      if (workbench) await openWorkbenchArchive()
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
      const verifyRestored = await syntheticEdit()
      if (workbench) {
        await page.reload()
        await openWorkbenchArchive()
        assert.equal(await page.locator('.meta-grid__row .meta-attachment-list__item').count(), 0)
        await page.locator(`[data-test="archive-recovery-entry-${captured.data.generationId}"]`).click()
      }
      const changedPreviewPromise = page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname.endsWith('/recovery-archive/preview'))
      await page.locator('[data-test="archive-recovery-request-preview"]').click()
      const changedPreviewResponse = await changedPreviewPromise
      assert.equal(changedPreviewResponse.status(), 200)
      const changedPreview = await changedPreviewResponse.json()
      assert.equal(changedPreview.data.executable, true)
      assert.equal(changedPreview.data.summary.effectiveWriteCount, 1)
      const execute = page.locator('[data-test="archive-recovery-execute"]')
      await execute.waitFor()
      assert.equal(await execute.isDisabled(), true)
      assert.deepEqual(forbiddenWrites, [], 'preview must not execute a recovery')
      await page.locator('[data-test="archive-recovery-confirm-input"]').check()
      const executePromise = page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname.endsWith('/recovery-archive/execute'))
      await execute.click()
      const executeResponse = await executePromise
      assert.equal(executeResponse.status(), 200)
      const executed = await executeResponse.json()
      assert.equal(executed.data.revertedCount, 1)
      assert.equal(executed.data.resurrectedCount, 0)
      assert.equal(executed.data.deletedCount, 0)
      await page.locator('[data-test="archive-recovery-result"]').waitFor()
      if (workbench) {
        await page.locator('.meta-grid__row .meta-attachment-list__item').nth(1).waitFor({ state: 'attached' })
        assert.equal(await page.locator('.meta-grid__row .meta-attachment-list__item').count(), 2)
      } else {
        assert.equal(await page.locator('html').getAttribute('data-archive-executed'), '1')
      }
      assert.equal(await execute.isDisabled(), true)
      assert.equal(forbiddenWrites.length, 1)
      assert.ok(new URL(forbiddenWrites[0]).pathname.endsWith('/recovery-archive/execute'))
      await verifyRestored()
      assert.deepEqual(errors, [])
      assert.deepEqual(apiFailures, [])
      assert.equal(await page.getByRole('dialog', { name: 'Archive recovery', exact: true }).evaluate(element => element.scrollWidth > element.clientWidth), false)
      await page.locator('[data-test="archive-recovery-result"]').scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(tmpdir(), `tm-manual-http-browser-${kind}-${width}.png`), fullPage: true })
      if (workbench) {
        await page.getByRole('dialog', { name: 'Archive recovery', exact: true }).getByRole('button', { name: 'Close archive recovery', exact: true }).click()
        const thumbnail = page.locator('.meta-grid__row .meta-attachment-list__thumb')
        await thumbnail.waitFor()
        await page.waitForFunction(() => {
          const image = document.querySelector('.meta-grid__row .meta-attachment-list__thumb')
          return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
        })
        assert.match(await thumbnail.getAttribute('src'), /^blob:/)
        await page.locator('.meta-grid__row .meta-attachment-list__card--preview').click()
        await page.locator('.meta-attachment-list__lightbox-image').waitFor()
        await page.waitForFunction(() => {
          const image = document.querySelector('.meta-attachment-list__lightbox-image')
          return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
        })
        assert.equal(await page.locator('.meta-attachment-list__lightbox-image').evaluate(image => image.naturalWidth), 1)
        await page.getByRole('button', { name: 'Close attachment preview', exact: true }).click()
        const attachmentResponse = page.context().waitForEvent('response', {
          predicate: response => response.request().method() === 'GET'
            && new URL(response.url()).pathname.startsWith('/api/multitable/attachments/'),
        })
        const downloadEvent = page.waitForEvent('download')
        await page.locator('.meta-grid__row [data-attachment-download]').first().click()
        const downloaded = await attachmentResponse
        assert.equal(downloaded.status(), 200, 'Workbench attachment click must authenticate through the real browser')
        assert.equal(await (await downloadEvent).failure(), null)
        assert.deepEqual(errors, [])
        assert.deepEqual(apiFailures, [])
      }
      await page.close()
      console.log(`PASS: Chromium ${width} ${kind} production component/client -> HTTP capture/reload/catalog/preview/confirmed restore; one explicit restore request, ${workbench ? 'empty-to-two attachment grid refresh' : 'one refresh event'} and database/history readback`)
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
