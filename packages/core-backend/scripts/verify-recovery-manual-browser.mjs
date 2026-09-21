import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Retain synthetic screenshots outside the disposable database fixture directory.
const screenshotRoot = tmpdir()

// Called only by the owned synthetic database driver, while its production HTTP router is alive.
export async function verifyManualArchiveBrowser(backendOrigin, syntheticEdit, kind = 'scalar', bearer = 'synthetic-manual-owner', login) {
  assert.ok(['scalar', 'attachment', 'workbench', 'application'].includes(kind))
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
  const application = kind === 'application'
  const workbench = kind === 'workbench' || application
  if (application) {
    assert.match(login?.identifier ?? '', /^tm-[a-f0-9-]+@example\.invalid$/)
    assert.match(login?.password ?? '', /^[a-f0-9]{64}$/)
    assert.equal(typeof login?.actorId, 'string')
  }
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
createApp({render:()=>h(MultitableWorkbench,{baseId:'b',sheetId:'no-genesis',viewId:new URLSearchParams(location.search).get('view')||'manual-browser-grid',
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
      resolve: { alias: { '@': join(web, 'src') } },
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
        const path = new URL(request.url()).pathname
        if (path.startsWith('/api/')) {
          const kind = request.failure()?.errorText === 'net::ERR_ABORTED' ? 'ABORTED' : 'TRANSPORT'
          apiFailures.push(`API_REQUEST_FAILED_${kind}:${request.method()}:${path}`)
        }
      })
      page.on('response', response => {
        const path = new URL(response.url()).pathname
        if (path.startsWith('/api/') && !response.ok()) apiFailures.push(`API_STATUS_${response.status()}:${path}`)
      })
      page.on('request', request => {
        if (request.method() !== 'GET' && /\/recovery-archive\/(execute|jobs)(?:\/|$)/.test(new URL(request.url()).pathname)) forbiddenWrites.push(request.url())
      })
      const browserOrigin = `http://127.0.0.1:${address.port}`
      const gridPath = '/multitable/no-genesis/manual-browser-grid?baseId=b'
      await page.goto(application ? `${browserOrigin}/login?redirect=${encodeURIComponent(gridPath)}` : `${browserOrigin}/__manual_archive`)
      if (application) {
        assert.equal(await page.evaluate(() => localStorage.getItem('auth_token')), null)
        await page.locator('input[autocomplete="username"]').fill(login.identifier)
        await page.locator('input[autocomplete="current-password"]').fill(login.password)
        const [loggedIn] = await Promise.all([
          page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/auth/login'),
          page.locator('.login-submit').click(),
        ])
        assert.equal(loggedIn.status(), 200)
        assert.equal((await loggedIn.json()).data.user.id, login.actorId)
        await page.waitForURL(url => url.pathname === '/multitable/no-genesis/manual-browser-grid')
      }
      const openWorkbenchArchive = async () => {
        if (!application) await page.locator('html[data-workbench-ready="true"]').waitFor()
        await page.locator('.meta-grid__row').first().waitFor()
        const layout = await page.evaluate(() => ({
          viewport: window.innerWidth,
          document: document.documentElement.scrollWidth,
          containers: ['.mt-workbench__actions', '.meta-toolbar', '.meta-toolbar__left', '.meta-toolbar__right', '.mt-workbench__capability-banner'].map(selector => {
            const element = document.querySelector(selector)
            const bounds = element?.getBoundingClientRect()
            return { selector, left: bounds?.left, right: bounds?.right }
          }),
        }))
        assert.ok(layout.document <= layout.viewport + 1, `Workbench horizontal overflow: ${JSON.stringify(layout)}`)
        // The isolated Workbench owns page overflow; App's shell clips its outlet.
        if (width === 390 && !application) {
          const nowrap = await page.addStyleTag({ content: '.mt-workbench__actions,.meta-toolbar,.meta-toolbar__left,.meta-toolbar__right{flex-wrap:nowrap!important}' })
          try {
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
              'Removing toolbar wrapping must reproduce whole-page overflow')
          } finally { await nowrap.evaluate(element => element.remove()) }
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
        }
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
      const verifyRestored = await syntheticEdit(workbench ? async () => {
        await page.getByRole('dialog', { name: 'Archive recovery', exact: true }).getByRole('button', { name: 'Close archive recovery', exact: true }).click()
        await page.getByRole('gridcell', { name: 'Synthetic files', exact: true }).dblclick()
        const deleted = await Promise.all([
          ...['manual-second-attachment', 'manual-live-attachment'].map(id => page.waitForResponse(response =>
            response.request().method() === 'DELETE' && new URL(response.url()).pathname === `/api/multitable/attachments/${id}`)),
          page.locator('.meta-cell-editor__clear-btn').click(),
        ])
        for (const response of deleted.slice(0, 2)) assert.equal(response.status(), 200)
        await page.waitForFunction(() => document.querySelectorAll('.meta-grid__row .meta-attachment-list__item').length === 0)
      } : undefined)
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
      await page.screenshot({ path: join(screenshotRoot, `tm-manual-http-browser-${kind}-${width}.png`), fullPage: true })
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
        const download = await downloadEvent
        assert.equal(await download.failure(), null)
        const downloadPath = await download.path()
        assert.ok(downloadPath, 'Browser must persist the restored attachment download')
        const attachmentId = decodeURIComponent(new URL(downloaded.url()).pathname.split('/').at(-1))
        assert.equal(attachmentId, 'manual-live-attachment')
        const expectedBytes = Buffer.from(`synthetic-${attachmentId}`)
        assert.deepEqual(await readFile(downloadPath), expectedBytes, 'Saved browser download must equal archived source bytes')
        await page.goto(application ? `${browserOrigin}/multitable/no-genesis/manual-browser-gallery?baseId=b`
          : `${browserOrigin}/__manual_archive?view=manual-browser-gallery`)
        if (!application) await page.locator('html[data-workbench-ready="true"]').waitFor()
        const cover = page.locator('.meta-gallery__cover-image')
        await cover.waitFor()
        await page.waitForFunction(() => {
          const image = document.querySelector('.meta-gallery__cover-image')
          return image instanceof HTMLImageElement && image.complete && image.naturalWidth === 1 && image.src.startsWith('blob:')
        })
        for (const [size, height] of [['small', 108], ['large', 176], ['medium', 132]]) {
          const [persisted] = await Promise.all([
            page.waitForResponse(response => response.request().method() === 'PATCH'
              && new URL(response.url()).pathname.endsWith('/views/manual-browser-gallery')),
            page.locator('.meta-gallery__toolbar-field').filter({ hasText: 'Card size' }).locator('select').selectOption(size),
          ])
          assert.equal(persisted.status(), 200)
          await page.waitForFunction(({ size, height }) => {
            const element = document.querySelector(`.meta-gallery__card--${size} .meta-gallery__cover`)
            return element && Math.abs(element.getBoundingClientRect().height - height) <= 1
          }, { size, height })
        }
        const naturalHeight = await page.addStyleTag({ content: '.meta-gallery__cover{height:auto!important;min-height:132px!important}' })
        try {
          assert.ok(await page.locator('.meta-gallery__cover').evaluate(element => element.getBoundingClientRect().height > 176),
            'Removing fixed cover height must reproduce intrinsic-image expansion')
        } finally { await naturalHeight.evaluate(element => element.remove()) }
        assert.ok(await page.locator('.meta-gallery__cover').evaluate(element => Math.abs(element.getBoundingClientRect().height - 132) <= 1))
        await page.screenshot({ path: join(screenshotRoot, `tm-restored-gallery-${width}.png`), fullPage: true })
        console.log(`PASS: Chromium ${width} restored gallery cover authenticated and decoded original PNG`)
        assert.deepEqual(errors, [])
        assert.deepEqual(apiFailures, [])
      }
      await page.close()
      console.log(`PASS: Chromium ${width} ${kind} production component/client -> HTTP capture/reload/catalog/preview/confirmed restore; one explicit restore request, ${workbench ? 'real cell-editor two-attachment deletion and empty-to-two grid restore' : 'one refresh event'} and database/history readback`)
    }
  } catch (error) {
    for (const context of browser?.contexts() ?? []) {
      for (const page of context.pages()) {
        await page.screenshot({ path: join(screenshotRoot, 'tm-manual-http-browser-failure.png'), fullPage: true }).catch(() => {})
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
