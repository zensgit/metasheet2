/// <reference lib="dom" />

import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import type { Browser, BrowserContext, Page, Response as BrowserResponse } from '@playwright/test'
// Vite belongs to the web workspace; resolve its types there as well as runtime.
import type { Plugin, ViteDevServer } from '../../../../apps/web/node_modules/vite'
import type { SourcePlanReadPlan } from '../../../../apps/web/src/services/integration/stockPreparation/sourcePlanDraft'
import type {
  SourcePlanActivation,
  SourcePlanVersion,
  SourcePlanVersionList,
} from '../../../../apps/web/src/services/integration/stockPreparation/sourcePlanVersions'

export interface StockPreparationReadPlanBrowserAcceptanceInput {
  apiOrigin: string
  tenantId: string
  systemId: string
  ownerToken: string
  otherToken: string
  readPlan: SourcePlanReadPlan
  /** Caller seeds only its owned real target rows; the browser still uses the actual API. */
  preparePopulatedTarget(versionId: string): Promise<{
    assertUnchanged(token: string): Promise<void>
    cleanup(): Promise<void>
  }>
  /** The caller owns these directories and their eventual cleanup. */
  cacheDir: string
  artifactDir?: string
}

export interface StockPreparationReadPlanBrowserAcceptanceResult {
  createdVersionId: string
  createdContentKey: string
  /** Exact synthetic download, handed to the next owner's import without reconstruction. */
  portableReviewJson: string
  /** Opaque synthetic handle used only by the parent DB assertion, never evidence/screenshots. */
  preview: { token: string; plannedAdd: number }
  populatedPreview: { token: string; counts: Record<string, number> }
  counts: {
    sourceBindingGets: number
    managementGets: number
    managementPosts: number
    deniedManagementGets: number
    nonOwnerPosts: number
    canceledActions: number
    unexpectedRequests: number
    pageErrors: number
    businessPreviewPosts: number
  }
  evidence: {
    realChromium: true
    realComponent: true
    realApiProxy: true
    managementScopeHeadersAbsent: true
    noImplicitSourceCalls: true
    reloadPersisted: true
    approvalDidNotActivate: true
    activationGenerations: [2, 3, 4]
    nonOwnerDenied: true
    unvalidatedApprovalBlocked: true
    explicitSampleConfirmed: true
    sampleScreenshot: boolean
    desktopScreenshot: boolean
    narrowScreenshot: boolean
    previewDidNotSync: true
    populatedTargetPreviewDidNotWrite: true
    previewScreenshot: boolean
  }
}

export interface StockPreparationReadPlanReuseInput {
  apiOrigin: string
  tenantId: string
  systemId: string
  ownerToken: string
  portableReviewJson: string
  readPlan: SourcePlanReadPlan
  cacheDir: string
  artifactDir: string
}

const bindingPath = '/api/integration/stock-preparation/source-binding'
const plansPath = '/api/integration/stock-preparation/read-plan-configs'
const actionId = 'plm.stock-preparation.pull-bom.v1'
const previewPath = `/api/integration/table-actions/${actionId}/dry-run`
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const webRoot = path.join(repositoryRoot, 'apps', 'web')

function ownedArtifactPath(value: string): string {
  const resolved = path.resolve(value)
  const relative = path.relative(repositoryRoot, resolved)
  assert(!relative.startsWith('..') && !path.isAbsolute(relative), 'BROWSER_ARTIFACT_OUTSIDE_REPOSITORY')
  assert(['tmp', 'artifacts'].includes(relative.split(path.sep)[0]), 'BROWSER_ARTIFACT_DIRECTORY_REQUIRED')
  return resolved
}

async function responseData<T>(response: BrowserResponse, status = 200): Promise<T> {
  assert.equal(response.status(), status, 'BROWSER_HTTP_STATUS')
  const envelope = await response.json() as { ok?: unknown; data?: T }
  assert.equal(envelope.ok, true, 'BROWSER_HTTP_ENVELOPE')
  assert(envelope.data && typeof envelope.data === 'object', 'BROWSER_HTTP_DATA')
  return envelope.data
}

/**
 * Real Chromium -> actual Vue panel/services/apiFetch -> this Vite proxy -> caller's
 * existing MetaSheetServer. The sole browser route handler is an origin firewall.
 * This helper creates no backend fixture, response replacement, or component state.
 */
export async function runStockPreparationReadPlanBrowserAcceptance(
  input: StockPreparationReadPlanBrowserAcceptanceInput,
): Promise<StockPreparationReadPlanBrowserAcceptanceResult> {
  const apiUrl = new URL(input.apiOrigin)
  assert.equal(apiUrl.protocol, 'http:', 'BROWSER_API_PROTOCOL')
  assert.equal(apiUrl.hostname, '127.0.0.1', 'BROWSER_API_LOOPBACK')
  assert.equal(apiUrl.origin, input.apiOrigin, 'BROWSER_API_ORIGIN_ONLY')
  assert.equal(apiUrl.username + apiUrl.password, '', 'BROWSER_API_NO_CREDENTIALS')
  assert(input.ownerToken && input.otherToken && input.ownerToken !== input.otherToken, 'BROWSER_DISTINCT_SESSIONS')
  const cacheDir = ownedArtifactPath(input.cacheDir)
  const artifactDir = input.artifactDir ? ownedArtifactPath(input.artifactDir) : undefined
  await mkdir(cacheDir, { recursive: true })
  if (artifactDir) await mkdir(artifactDir, { recursive: true })

  const webRequire = createRequire(path.join(webRoot, 'package.json'))
  const { createServer } = await import(pathToFileURL(webRequire.resolve('vite')).href) as typeof import('../../../../apps/web/node_modules/vite')
  const { default: vue } = await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-vue')).href) as { default: () => Plugin }
  const { chromium } = await import(pathToFileURL(webRequire.resolve('@playwright/test')).href) as typeof import('@playwright/test')
  let vite: ViteDevServer | undefined
  let browser: Browser | undefined
  const unexpected: string[] = []
  let pageErrors = 0
  let sourceBindingGets = 0
  let managementGets = 0
  let deniedManagementGets = 0
  let canceledActions = 0
  let businessPreviewPosts = 0
  const posts: Array<{ operation: string; body: unknown; nonOwner: boolean }> = []
  const apiResponses: number[] = []
  const htmlPath = '/__stock-preparation-read-plan-acceptance'
  // Props are data, escaped so they cannot terminate the HTML module script.
  const scopeJson = JSON.stringify({ tenantId: input.tenantId, workspaceId: null }).replaceAll('<', '\\u003c')
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="icon" href="data:,">
    <style>body{margin:16px;font-family:system-ui,sans-serif}input,button,select{max-width:100%;box-sizing:border-box}</style>
    </head><body data-stock-prep-synced="0"><div id="app"></div><script type="module">
    import { createApp, h } from 'vue';
    import '/src/styles/tokens.css';
    import Panel from '/src/components/integration/stockPreparation/StockPreparationSourceBindingPanel.vue';
    import ProjectPanel from '/src/components/integration/stockPreparation/StockPreparationProjectSyncPanel.vue';
    const scope=${scopeJson};
    let syncedEvents=0;
    createApp({render:()=>h('main',[
      h(Panel,{scope}),
      h(ProjectPanel,{scope,projectNo:'SYN-VALIDATION',onSynced:()=>{
        document.body.dataset.stockPrepSynced=String(++syncedEvents);
      }}),
    ])}).mount('#app');
    </script></body></html>`

  try {
    vite = await createServer({
      root: webRoot,
      configFile: false,
      envFile: false,
      cacheDir,
      // The application uses same-origin apiFetch in this isolated UI, even if the
      // caller has unrelated VITE_API_* environment settings. No .env is loaded.
      define: { 'import.meta.env.VITE_API_URL': '""', 'import.meta.env.VITE_API_BASE': '""' },
      plugins: [vue(), {
        name: 'stock-preparation-real-host-browser-acceptance',
        configureServer(server) {
          server.middlewares.use(htmlPath, async (_request, response, next) => {
            try {
              response.setHeader('Content-Type', 'text/html; charset=utf-8')
              response.end(await server.transformIndexHtml(htmlPath, html))
            } catch {
              next(new Error('BROWSER_HARNESS_HTML_FAILED'))
            }
          })
        },
      }],
      optimizeDeps: { include: ['vue'] },
      server: {
        host: '127.0.0.1', port: 0, hmr: false,
        proxy: { '/api': { target: input.apiOrigin, changeOrigin: false } },
      },
    })
    const httpServer = vite.httpServer
    assert(httpServer, 'BROWSER_UI_HTTP_SERVER')
    // Vite 5's server.listen() replaces a configured zero with its default port.
    // Its public httpServer.listen wrapper still initializes plugins/optimization
    // before delegating to Node; call that wrapper with the literal ephemeral port.
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      httpServer.once('error', onError)
      try {
        void Promise.resolve(httpServer.listen(0, '127.0.0.1', () => {
          httpServer.removeListener('error', onError)
          resolve()
        })).catch(onError)
      } catch (error) {
        httpServer.removeListener('error', onError)
        reject(error)
      }
    })
    const address = httpServer.address()
    assert(address && typeof address !== 'string', 'BROWSER_UI_ADDRESS')
    const uiOrigin = `http://127.0.0.1:${address.port}`
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() })

    const contextFor = async (token: string, nonOwner: boolean): Promise<BrowserContext> => {
      assert(browser, 'BROWSER_NOT_STARTED')
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', serviceWorkers: 'block' })
      await context.addInitScript(({ authToken, origin }) => {
        if (location.origin !== origin) return
        localStorage.setItem('auth_token', authToken)
        localStorage.setItem('metasheet_locale', 'zh-CN')
      }, { authToken: token, origin: uiOrigin })
      await context.route('**/*', async (route) => {
        if (new URL(route.request().url()).origin === uiOrigin) return route.continue()
        unexpected.push('EXTERNAL_REQUEST')
        return route.abort('blockedbyclient')
      })
      context.on('page', (page) => page.on('pageerror', () => { pageErrors += 1 }))
      context.on('requestfailed', () => unexpected.push('REQUEST_FAILED'))
      context.on('request', (request) => {
        const target = new URL(request.url())
        if (target.origin !== uiOrigin) unexpected.push('UNEXPECTED_ORIGIN')
        if (!target.pathname.startsWith('/api/')) return
        const method = request.method()
        if (target.pathname === previewPath && method === 'POST') {
          businessPreviewPosts += 1
          if (nonOwner) unexpected.push('NONOWNER_PREVIEW_NOT_REQUESTED')
          if (target.search !== `?${new URLSearchParams({ tenantId: input.tenantId })}`) unexpected.push('PREVIEW_SCOPE')
          if (request.headers().authorization !== `Bearer ${token}`) unexpected.push('PREVIEW_SESSION')
          if (!isDeepStrictEqual(request.postDataJSON(), {
            parameters: { projectNo: 'SYN-VALIDATION' }, includeMissingComponents: true,
          })) unexpected.push('PREVIEW_BODY')
          return
        }
        if (target.pathname === bindingPath && method === 'GET') {
          sourceBindingGets += 1
          if (target.searchParams.get('tenantId') !== input.tenantId) unexpected.push('BINDING_SCOPE')
          return
        }
        const management = target.pathname === plansPath
          || new RegExp(`^${plansPath}/[A-Za-z0-9_-]+/(approve|activate|validate|confirm-sample)$`).test(target.pathname)
          || target.pathname === `${plansPath}/deactivate`
        if (!management || !['GET', 'POST'].includes(method)) {
          unexpected.push('UNEXPECTED_API_REQUEST')
          return
        }
        const headers = request.headers()
        if ('x-tenant-id' in headers || 'x-workspace-id' in headers) unexpected.push('MANAGEMENT_SCOPE_HEADER')
        if (headers.authorization !== `Bearer ${token}`) unexpected.push('MANAGEMENT_SESSION')
        if (method === 'GET') {
          managementGets += 1
          if (target.pathname !== plansPath || target.searchParams.get('managementScope') !== 'tenant'
            || target.searchParams.get('systemId') !== input.systemId) unexpected.push('MANAGEMENT_QUERY')
        } else {
          const operation = target.pathname === plansPath ? 'save' : target.pathname.split('/').at(-1)!
          posts.push({ operation, body: request.postDataJSON(), nonOwner })
        }
      })
      context.on('response', (response) => {
        const pathname = new URL(response.url()).pathname
        if (!pathname.startsWith('/api/')) {
          if (response.status() >= 400) unexpected.push('UI_HTTP_STATUS')
          return
        }
        apiResponses.push(response.status())
        if (response.ok()) return
        if (nonOwner && pathname === plansPath && response.request().method() === 'GET' && response.status() === 403) {
          deniedManagementGets += 1
        } else unexpected.push('UNEXPECTED_API_STATUS')
      })
      return context
    }

    const waitApi = (page: Page, method: 'GET' | 'POST', pathname: string): Promise<BrowserResponse> => {
      const pending = page.waitForResponse((response) => response.request().method() === method
        && new URL(response.url()).pathname === pathname)
      // Keep the original rejecting promise for the awaited assertion. If a
      // preceding UI assertion fails, browser teardown must not orphan this wait.
      void pending.catch(() => {})
      return pending
    }

    const navigate = async (page: Page, reload = false): Promise<void> => {
      const metadata = waitApi(page, 'GET', bindingPath)
      if (reload) await page.reload()
      else await page.goto(`${uiOrigin}${htmlPath}`)
      const binding = await responseData<{ eligibleSources: unknown[] }>(await metadata)
      assert(Array.isArray(binding.eligibleSources), 'BROWSER_BINDING_METADATA')
      await page.getByTestId('stock-prep-source-current').waitFor()
      assert.equal(await page.getByTestId('stock-prep-source-plan-draft').count(), 1, 'BROWSER_REAL_ADMIN_CONTROLS')
      assert.equal(posts.length, reload ? 6 : 0, 'BROWSER_MOUNT_IMPLICIT_POST')
    }

    const loadPlans = async (page: Page): Promise<SourcePlanVersionList> => {
      await page.getByTestId('stock-prep-source-plan-draft-summary').click()
      await page.getByTestId('stock-prep-plan-management-toggle').check()
      await page.getByTestId('stock-prep-plan-system').fill(input.systemId)
      const response = waitApi(page, 'GET', plansPath)
      await page.getByTestId('stock-prep-plan-refresh').click()
      const data = await responseData<SourcePlanVersionList>(await response)
      await page.getByTestId('stock-prep-plan-activation').waitFor()
      return data
    }

    const confirmedAction = async (page: Page, action: 'approve' | 'activate' | 'deactivate', versionId: string, generation: number): Promise<SourcePlanVersion | SourcePlanActivation> => {
      const button = page.getByTestId(`stock-prep-plan-${action}`)
      const before = posts.length
      await button.click()
      await page.getByTestId('stock-prep-plan-confirm').waitFor()
      assert.equal(posts.length, before, 'BROWSER_PRECONFIRM_POST')
      assert((await page.getByTestId('stock-prep-plan-confirm').innerText()).includes(versionId), 'BROWSER_CONFIRM_VERSION')
      if (action !== 'approve') {
        assert((await page.getByTestId('stock-prep-plan-confirm-generation').innerText()).includes(String(generation)), 'BROWSER_CONFIRM_GENERATION')
      }
      await page.getByTestId('stock-prep-plan-confirm-cancel').click()
      await page.getByTestId('stock-prep-plan-confirm').waitFor({ state: 'detached' })
      assert.equal(posts.length, before, 'BROWSER_CANCEL_POST')
      canceledActions += 1
      await button.click()
      await page.getByTestId('stock-prep-plan-confirm').waitFor()
      assert.equal(posts.length, before, 'BROWSER_RECONFIRM_POST')
      const pathname = action === 'deactivate' ? `${plansPath}/deactivate` : `${plansPath}/${versionId}/${action}`
      const mutation = waitApi(page, 'POST', pathname)
      const readback = waitApi(page, 'GET', plansPath)
      await page.getByTestId('stock-prep-plan-confirm-submit').click()
      const data = await responseData<SourcePlanVersion | SourcePlanActivation>(await mutation)
      const state = await responseData<SourcePlanVersionList>(await readback)
      assert.equal(posts.length, before + 1, 'BROWSER_CONFIRM_POST_COUNT')
      const post = posts.at(-1)!
      assert.equal(post.operation, action, 'BROWSER_CONFIRM_POST_OPERATION')
      assert(isDeepStrictEqual(post.body, { managementScope: 'tenant', systemId: input.systemId,
        ...(action === 'approve' ? {} : { expectedGeneration: generation }),
      }), 'BROWSER_CONFIRM_POST_BODY')
      if (action === 'approve') {
        assert('id' in data, 'BROWSER_APPROVAL_RESPONSE_VERSION')
        assert.equal(data.id, versionId, 'BROWSER_APPROVAL_RESPONSE_ID')
        assert.equal(data.status, 'approved', 'BROWSER_APPROVAL_RESPONSE_STATUS')
        assert.equal(state.versions.find((row) => row.id === versionId)?.status, 'approved', 'BROWSER_APPROVED_READBACK')
        assert.equal(state.activation?.status, 'disabled', 'BROWSER_APPROVAL_IMPLICIT_ACTIVATION')
        assert.equal(state.activation?.generation, generation, 'BROWSER_APPROVAL_CHANGED_GENERATION')
        await page.getByTestId(`stock-prep-plan-version-${versionId}`).locator('..').filter({ hasText: '已审批' }).waitFor()
      } else {
        assert('versionId' in data, 'BROWSER_ACTIVATION_RESPONSE')
        assert.equal(data.versionId, versionId, 'BROWSER_ACTIVATION_RESPONSE_VERSION')
        assert.equal(data.status, action === 'activate' ? 'active' : 'disabled', 'BROWSER_ACTIVATION_RESPONSE_STATUS')
        assert.equal(data.generation, generation + 1, 'BROWSER_ACTIVATION_RESPONSE_GENERATION')
        assert.equal(state.activation?.versionId, versionId, 'BROWSER_ACTIVATION_READBACK_VERSION')
        assert.equal(state.activation?.status, action === 'activate' ? 'active' : 'disabled', 'BROWSER_ACTIVATION_READBACK_STATUS')
        assert.equal(state.activation?.generation, generation + 1, 'BROWSER_ACTIVATION_READBACK_GENERATION')
        await page.getByTestId('stock-prep-plan-activation').filter({ hasText: action === 'activate' ? '已激活' : '已停用' }).waitFor()
      }
      return data
    }

    const ownerContext = await contextFor(input.ownerToken, false)
    const page = await ownerContext.newPage()
    page.setDefaultTimeout(15000)
    await navigate(page)
    const initial = await loadPlans(page)
    assert.equal(initial.versions.length, 1, 'BROWSER_INITIAL_VERSION_COUNT')
    assert.equal(initial.versions[0].status, 'approved', 'BROWSER_INITIAL_APPROVED_VERSION')
    assert.equal(initial.activation?.status, 'disabled', 'BROWSER_INITIAL_DISABLED_ACTIVATION')
    assert.equal(initial.activation?.generation, 2, 'BROWSER_INITIAL_GENERATION')
    assert.equal(posts.length, 0, 'BROWSER_LIST_IMPLICIT_POST')

    // Upload through the real input/FileReader/compiler; no Node frontend runtime
    // import and no page.evaluate mutation of component state is involved.
    await page.getByTestId('stock-prep-source-plan-draft-import').setInputFiles({
      name: 'synthetic-read-plan.review.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'stock-preparation-plm-role-draft',
        status: 'confirm-required', validation: 'structure-only', readPlan: input.readPlan })),
    })
    await page.waitForFunction((expected) => (document.querySelector('[data-testid="stock-prep-source-plan-draft-input-part-nameField"]') as HTMLInputElement | null)?.value === expected, input.readPlan.part.nameField)
    await page.getByTestId('stock-prep-source-plan-draft-preview').click()
    await page.getByTestId('stock-prep-source-plan-draft-json').waitFor()
    assert.equal(await page.getByTestId('stock-prep-source-plan-draft-issues').count(), 0, 'BROWSER_IMPORTED_PLAN_ISSUES')
    assert.equal(posts.length, 0, 'BROWSER_IMPORT_IMPLICIT_POST')
    const save = waitApi(page, 'POST', plansPath)
    const savedReadback = waitApi(page, 'GET', plansPath)
    await page.getByTestId('stock-prep-plan-save').click()
    const created = await responseData<SourcePlanVersion>(await save, 201)
    const savedState = await responseData<SourcePlanVersionList>(await savedReadback)
    assert.equal(created.status, 'draft', 'BROWSER_SAVED_DRAFT')
    assert(created.id !== initial.versions[0].id, 'BROWSER_DISTINCT_DRAFT')
    assert.equal(savedState.versions.length, 2, 'BROWSER_SAVED_VERSION_COUNT')
    assert.equal(savedState.activation?.generation, 2, 'BROWSER_SAVE_CHANGED_GENERATION')
    assert.equal(savedState.activation?.status, 'disabled', 'BROWSER_SAVE_IMPLICIT_ACTIVATION')
    assert(isDeepStrictEqual(created.config.readPlan, input.readPlan), 'BROWSER_SAVED_READ_PLAN')
    assert.equal(posts.length, 1, 'BROWSER_SAVE_POST_COUNT')
    assert.equal(posts[0].operation, 'save', 'BROWSER_SAVE_POST_OPERATION')
    assert(isDeepStrictEqual(posts[0].body, { managementScope: 'tenant', config: {
      schemaVersion: 1, actionId, systemId: input.systemId, readPlan: input.readPlan,
    } }), 'BROWSER_SAVE_POST_BODY')
    await page.getByTestId(`stock-prep-plan-version-${created.id}`).check()
    assert.equal(await page.getByTestId('stock-prep-plan-approve').isDisabled(), true, 'BROWSER_UNVALIDATED_APPROVAL_BLOCKED')
    await page.getByTestId('stock-prep-plan-project').fill('SYN-VALIDATION')
    const validationResponse = waitApi(page, 'POST', `${plansPath}/${created.id}/validate`)
    await page.getByTestId('stock-prep-plan-validate').click()
    const measured = await responseData<{ validation: { validationId: string; status: string }; sample: { totalRows: number; rows: Array<Record<string, unknown>> } }>(await validationResponse)
    assert.equal(measured.validation.status, 'passed', 'BROWSER_REAL_SOURCE_VALIDATED')
    assert.equal(measured.sample.totalRows, 3, 'BROWSER_COMPLETE_SAMPLE_COUNT')
    assert.equal(measured.sample.rows[0].sourceVersion, 'P1', 'BROWSER_SAMPLE_MATERIAL_VERSION')
    assert.equal(measured.sample.rows[0].orderBomVersion, 'B2', 'BROWSER_SAMPLE_ORDER_VERSION')
    assert(measured.sample.rows.slice(1).every(row => !Object.hasOwn(row, 'orderBomVersion')), 'BROWSER_NO_CHILD_ORDER_VERSION_INHERITANCE')
    await page.getByTestId('stock-prep-plan-sample').filter({ hasText: 'SYN-CHILD' }).waitFor()
    assert.equal(await page.getByTestId('stock-prep-plan-sample-0-sourceVersion').innerText(), 'P1')
    assert.equal(await page.getByTestId('stock-prep-plan-sample-0-orderBomVersion').innerText(), 'B2')
    assert.equal(await page.getByTestId('stock-prep-plan-approve').isDisabled(), true, 'BROWSER_UNCONFIRMED_APPROVAL_BLOCKED')
    if (artifactDir) {
      // These three rows are generated in the owned disposable PostgreSQL fixture,
      // not customer samples. Capture the new UI state before confirmation clears it.
      await page.getByTestId('stock-prep-plan-validation').screenshot({ path: path.join(artifactDir, 'stock-preparation-validation-sample.png') })
      await page.setViewportSize({ width: 390, height: 844 })
      const sampleLayout = await page.locator('.stock-prep-source__sample-scroll').evaluate((element) => {
        const table = element.querySelector('table')!
        element.scrollLeft = element.scrollWidth
        const result = { viewportWidth: element.clientWidth, contentWidth: element.scrollWidth,
          tableWidth: table.getBoundingClientRect().width, scrolled: element.scrollLeft > 0 }
        element.scrollLeft = 0
        return result
      })
      expect(sampleLayout.viewportWidth).toBeLessThanOrEqual(390)
      expect(sampleLayout.contentWidth).toBeGreaterThan(sampleLayout.viewportWidth)
      expect(sampleLayout.tableWidth).toBeGreaterThanOrEqual(1100)
      expect(sampleLayout.scrolled).toBe(true)
      await page.getByTestId('stock-prep-plan-validation').screenshot({ path: path.join(artifactDir, 'stock-preparation-validation-sample-narrow.png') })
      await page.setViewportSize({ width: 1280, height: 900 })
    }
    const confirmationResponse = waitApi(page, 'POST', `${plansPath}/${created.id}/confirm-sample`)
    await page.getByTestId('stock-prep-plan-confirm-sample').click()
    const confirmed = await responseData<{ validationId: string; status: string }>(await confirmationResponse)
    assert.equal(confirmed.validationId, measured.validation.validationId, 'BROWSER_EXACT_SAMPLE_CONFIRMED')
    assert.equal(confirmed.status, 'confirmed', 'BROWSER_CONFIRMATION_STATUS')
    assert.equal(posts.length, 3, 'BROWSER_EXPLICIT_SOURCE_READ_AND_CONFIRM_ONLY')
    assert.deepEqual(posts[1].body, { managementScope: 'tenant', systemId: input.systemId, projectNo: 'SYN-VALIDATION' })
    assert.deepEqual(posts[2].body, { managementScope: 'tenant', systemId: input.systemId, validationId: measured.validation.validationId })
    await confirmedAction(page, 'approve', created.id, 2)
    await confirmedAction(page, 'activate', created.id, 2)

    // Ready and canApply=true is deliberate: a broken "preview" wired to the
    // sync runner must not escape detection because the fixture naturally fails.
    assert.equal(businessPreviewPosts, 0, 'BROWSER_IMPLICIT_BUSINESS_PREVIEW')
    const previewResponse = waitApi(page, 'POST', previewPath)
    await page.getByTestId('stock-prep-project-preview-run').click()
    const preview = await responseData<{
      status: string; canApply: boolean; dryRunToken: string;
      counts: { add: number; update: number; skip: number; inactive: number; manual_confirm: number };
    }>(await previewResponse)
    assert.equal(preview.status, 'ready', 'BROWSER_PREVIEW_READY')
    assert.equal(preview.canApply, true, 'BROWSER_READY_PLAN_CAN_APPLY')
    assert.equal(typeof preview.dryRunToken, 'string', 'BROWSER_REAL_PREVIEW_TOKEN')
    assert(preview.dryRunToken.length > 0, 'BROWSER_NONEMPTY_PREVIEW_TOKEN')
    assert.deepEqual(preview.counts, { add: 3, update: 0, skip: 0, inactive: 0, manual_confirm: 0 })
    // Fail on a sync verdict directly, not merely a missing-preview timeout, if
    // this button is ever miswired to the existing write-capable sync runner.
    await page.waitForFunction(() => document.querySelector('[data-testid="stock-prep-project-preview"]')
      || document.querySelector('[data-testid="stock-prep-project-sync-verdict"]'))
    assert.equal(await page.getByTestId('stock-prep-project-sync-verdict').count(), 0, 'BROWSER_PREVIEW_DID_NOT_SYNC')
    const previewPanel = page.getByTestId('stock-prep-project-preview')
    await previewPanel.filter({ has: page.getByTestId('stock-prep-project-preview-counts') }).waitFor()
    assert.equal(await previewPanel.getAttribute('data-status'), 'ready', 'BROWSER_PREVIEW_DOM_STATUS')
    assert.match(await page.getByTestId('stock-prep-project-preview-counts').innerText(),
      /计划新增\s+3\s*·\s*计划更新\s+0\s*·\s*计划跳过\s+0\s*·\s*计划停用\s+0\s*·\s*待人工确认\s+0/,
      'BROWSER_CONFIGURED_LAYOUT_COUNTS')
    assert.equal(await page.getByTestId('stock-prep-project-sync-verdict').count(), 0, 'BROWSER_PREVIEW_DID_NOT_SYNC')
    assert(!(await page.locator('body').innerText()).includes(preview.dryRunToken), 'BROWSER_PREVIEW_TOKEN_NOT_RENDERED')
    assert.equal(businessPreviewPosts, 1, 'BROWSER_PREVIEW_EXPLICIT_SINGLE_CALL')
    if (artifactDir) {
      await previewPanel.screenshot({ path: path.join(artifactDir, 'stock-preparation-business-preview.png') })
      await page.getByTestId('stock-prep-project-sync').screenshot({ path: path.join(artifactDir, 'stock-preparation-business-preview-panel.png') })
      await page.setViewportSize({ width: 390, height: 844 })
      await previewPanel.screenshot({ path: path.join(artifactDir, 'stock-preparation-business-preview-narrow.png') })
      await page.getByTestId('stock-prep-project-sync').screenshot({ path: path.join(artifactDir, 'stock-preparation-business-preview-panel-narrow.png') })
      await page.setViewportSize({ width: 1280, height: 900 })
    }

    // A populated real target must produce a change plan, not repeat an add-only
    // plan. The fixed oracle is independent of the production mapper/planner.
    const populatedTarget = await input.preparePopulatedTarget(created.id)
    let populatedPreview: { token: string; counts: Record<string, number> }
    try {
      const postsBefore = posts.length
      const populatedResponse = waitApi(page, 'POST', previewPath)
      await page.getByTestId('stock-prep-project-preview-run').click()
      const measuredPreview = await responseData<{
        status: string; canApply: boolean; dryRunToken: string; counts: Record<string, number>;
      }>(await populatedResponse)
      assert.equal(measuredPreview.status, 'ready', 'BROWSER_POPULATED_PREVIEW_READY')
      assert.equal(measuredPreview.canApply, true, 'BROWSER_POPULATED_PREVIEW_CAN_APPLY')
      assert.equal(typeof measuredPreview.dryRunToken, 'string', 'BROWSER_POPULATED_PREVIEW_TOKEN')
      assert(measuredPreview.dryRunToken.length > 0, 'BROWSER_POPULATED_PREVIEW_NONEMPTY_TOKEN')
      assert.notEqual(measuredPreview.dryRunToken, preview.dryRunToken, 'BROWSER_POPULATED_FRESH_TOKEN')
      assert.deepEqual(measuredPreview.counts, { add: 1, update: 1, skip: 1, inactive: 1, manual_confirm: 0 },
        'BROWSER_POPULATED_FIXED_DIFF_ORACLE')
      await page.getByTestId('stock-prep-project-preview-counts').filter({ hasText:
        /计划新增\s+1\s*·\s*计划更新\s+1\s*·\s*计划跳过\s+1\s*·\s*计划停用\s+1\s*·\s*待人工确认\s+0/,
      }).waitFor()
      assert.equal(await previewPanel.getAttribute('data-status'), 'ready', 'BROWSER_POPULATED_DOM_READY')
      assert.equal(await page.getByTestId('stock-prep-project-sync-verdict').count(), 0, 'BROWSER_POPULATED_DID_NOT_SYNC')
      assert.equal(await page.locator('body').getAttribute('data-stock-prep-synced'), '0', 'BROWSER_NO_SYNCED_EVENT')
      assert(!(await page.locator('body').innerText()).includes(measuredPreview.dryRunToken), 'BROWSER_POPULATED_TOKEN_NOT_RENDERED')
      assert.equal(posts.length, postsBefore, 'BROWSER_POPULATED_NO_MANAGEMENT_POST')
      assert.equal(businessPreviewPosts, 2, 'BROWSER_POPULATED_EXPLICIT_SINGLE_CALL')
      assert.equal(unexpected.length, 0, 'BROWSER_POPULATED_NO_APPLY_ARCHIVE_RECONCILE_JOB')
      await populatedTarget.assertUnchanged(measuredPreview.dryRunToken)
      if (artifactDir) await previewPanel.screenshot({ path: path.join(artifactDir, 'stock-preparation-populated-target-preview.png') })
      populatedPreview = { token: measuredPreview.dryRunToken, counts: measuredPreview.counts }
    } finally {
      await populatedTarget.cleanup()
    }

    // Capture only the metadata management controls. The imported schema draft
    // and immutable config detail are deliberately outside the PNG viewport.
    if (artifactDir) {
      await page.getByTestId('stock-prep-plan-management').screenshot({ path: path.join(artifactDir, 'stock-preparation-read-plan-desktop.png') })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.getByTestId('stock-prep-plan-management').screenshot({ path: path.join(artifactDir, 'stock-preparation-read-plan-narrow.png') })
      await page.setViewportSize({ width: 1280, height: 900 })
    }
    await confirmedAction(page, 'deactivate', created.id, 3)
    await navigate(page, true)
    const persisted = await loadPlans(page)
    assert.equal(persisted.versions.length, 2, 'BROWSER_RELOAD_VERSION_COUNT')
    assert.equal(persisted.versions.find((row) => row.id === created.id)?.status, 'approved', 'BROWSER_RELOAD_APPROVAL')
    assert.equal(persisted.activation?.versionId, created.id, 'BROWSER_RELOAD_ACTIVATION_VERSION')
    assert.equal(persisted.activation?.status, 'disabled', 'BROWSER_RELOAD_DISABLED')
    assert.equal(persisted.activation?.generation, 4, 'BROWSER_RELOAD_GENERATION')
    const persistedVersion = persisted.versions.find((row) => row.id === created.id)
    assert.equal(persistedVersion?.contentKey, created.contentKey, 'BROWSER_VERSION_CONTENT_KEY_CHANGED')
    assert.equal(isDeepStrictEqual(persistedVersion?.config, created.config), true, 'BROWSER_VERSION_CONFIG_CHANGED')
    const reloadedActivation = page.getByTestId('stock-prep-plan-activation')
    await reloadedActivation.filter({ hasText: created.id }).filter({ hasText: '已停用' })
      .filter({ hasText: /激活指针代次\s+4(?!\d)/ }).waitFor()
    await page.getByTestId(`stock-prep-plan-version-${created.id}`).locator('..').filter({ hasText: '已审批' }).waitFor()
    assert.equal(posts.length, 6, 'BROWSER_RELOAD_IMPLICIT_POST')

    // Start from the version read back after a real reload, not a reconstructed
    // fixture envelope. The exact downloaded bytes are reused by another owner.
    await page.getByTestId(`stock-prep-plan-version-${created.id}`).check()
    await page.getByTestId('stock-prep-plan-copy-draft').click()
    await page.getByTestId('stock-prep-plan-copy-confirm-cancel').click()
    assert.equal(posts.length, 6, 'BROWSER_COPY_CANCEL_NO_POST')
    await page.getByTestId('stock-prep-plan-copy-draft').click()
    await page.getByTestId('stock-prep-plan-copy-confirm-submit').click()
    await page.getByTestId('stock-prep-source-plan-draft-preview').click()
    const downloadPending = page.waitForEvent('download')
    await page.getByTestId('stock-prep-source-plan-draft-download').click()
    const stream = await (await downloadPending).createReadStream()
    assert(stream, 'BROWSER_PORTABLE_DOWNLOAD_STREAM')
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    const portableReviewJson = Buffer.concat(chunks).toString('utf8')
    assert.deepEqual(JSON.parse(portableReviewJson), { schemaVersion: 1, kind: 'stock-preparation-plm-role-draft',
      status: 'confirm-required', validation: 'structure-only', readPlan: created.config.readPlan })
    for (const handle of [input.systemId, input.tenantId, input.ownerToken, created.id, created.contentKey, measured.validation.validationId]) {
      assert(!portableReviewJson.includes(handle), 'BROWSER_PORTABLE_AUTHORITY_EXCLUDED')
    }
    assert.equal(posts.length, 6, 'BROWSER_COPY_DOWNLOAD_NO_POST')

    const otherContext = await contextFor(input.otherToken, true)
    const otherPage = await otherContext.newPage()
    otherPage.setDefaultTimeout(15000)
    const otherMetadata = waitApi(otherPage, 'GET', bindingPath)
    await otherPage.goto(`${uiOrigin}${htmlPath}`)
    await responseData(await otherMetadata)
    await otherPage.getByTestId('stock-prep-source-plan-draft-summary').click()
    await otherPage.getByTestId('stock-prep-plan-management-toggle').check()
    await otherPage.getByTestId('stock-prep-plan-system').fill(input.systemId)
    const refusal = waitApi(otherPage, 'GET', plansPath)
    await otherPage.getByTestId('stock-prep-plan-refresh').click()
    const denied = await refusal
    assert.equal(denied.status(), 403, 'BROWSER_NONOWNER_STATUS')
    const deniedPayload = await denied.json() as { ok?: unknown }
    assert.equal(deniedPayload.ok, false, 'BROWSER_NONOWNER_ENVELOPE')
    await otherPage.getByTestId('stock-prep-plan-error').filter({ hasText: 'HTTP 403' }).waitFor()
    assert.equal(await otherPage.getByTestId('stock-prep-plan-versions').count(), 0, 'BROWSER_NONOWNER_VERSIONS_EXPOSED')
    assert.equal(await otherPage.getByTestId('stock-prep-plan-save').isDisabled(), true, 'BROWSER_NONOWNER_SAVE_AVAILABLE')
    assert.equal(posts.filter((row) => row.nonOwner).length, 0, 'BROWSER_NONOWNER_POST')
    assert.equal(deniedManagementGets, 1, 'BROWSER_NONOWNER_REFUSAL_COUNT')
    assert.equal(pageErrors, 0, 'BROWSER_PAGE_ERRORS')
    assert.equal(unexpected.length, 0, `BROWSER_UNEXPECTED_NETWORK_${unexpected[0] ?? 'NONE'}`)
    assert(apiResponses.every((status) => [200, 201, 403].includes(status)), 'BROWSER_UNEXPECTED_HTTP_STATUS')
    assert.equal(sourceBindingGets, 3, 'BROWSER_METADATA_GET_COUNT')
    assert.equal(managementGets, 7, 'BROWSER_MANAGEMENT_GET_COUNT')
    assert.equal(posts.length, 6, 'BROWSER_TOTAL_POST_COUNT')
    assert.equal(businessPreviewPosts, 2, 'BROWSER_PREVIEW_NOT_REPEATED_BY_RELOAD')
    return {
      createdVersionId: created.id,
      createdContentKey: created.contentKey,
      portableReviewJson,
      preview: { token: preview.dryRunToken, plannedAdd: preview.counts.add },
      populatedPreview,
      counts: { sourceBindingGets, managementGets, managementPosts: posts.length, deniedManagementGets,
        nonOwnerPosts: 0, canceledActions, unexpectedRequests: unexpected.length, pageErrors, businessPreviewPosts },
      evidence: { realChromium: true, realComponent: true, realApiProxy: true,
        managementScopeHeadersAbsent: true, noImplicitSourceCalls: true, reloadPersisted: true,
        approvalDidNotActivate: true, activationGenerations: [2, 3, 4], nonOwnerDenied: true,
        unvalidatedApprovalBlocked: true, explicitSampleConfirmed: true, sampleScreenshot: Boolean(artifactDir),
        desktopScreenshot: Boolean(artifactDir), narrowScreenshot: Boolean(artifactDir),
        previewDidNotSync: true, populatedTargetPreviewDidNotWrite: true, previewScreenshot: Boolean(artifactDir) },
    }
  } finally {
    try { await browser?.close() }
    finally { await vite?.close() }
  }
}

/** A different real owner imports the first browser's exact download and edits roles in the UI. */
export async function runStockPreparationReadPlanReuseAcceptance(input: StockPreparationReadPlanReuseInput): Promise<{
  versionId: string; validationId: string; token: string; generation: number; posts: number;
}> {
  const api = new URL(input.apiOrigin)
  assert.equal(api.protocol, 'http:')
  assert.equal(api.hostname, '127.0.0.1')
  assert.equal(api.origin, input.apiOrigin)
  assert.equal(api.username + api.password, '')
  const cacheDir = ownedArtifactPath(input.cacheDir)
  const artifactDir = ownedArtifactPath(input.artifactDir)
  await mkdir(cacheDir, { recursive: true })
  await mkdir(artifactDir, { recursive: true })
  const webRequire = createRequire(path.join(webRoot, 'package.json'))
  const { createServer } = await import(pathToFileURL(webRequire.resolve('vite')).href) as typeof import('../../../../apps/web/node_modules/vite')
  const { default: vue } = await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-vue')).href) as { default: () => Plugin }
  const { chromium } = await import('@playwright/test')
  let browser: Browser | undefined
  let vite: ViteDevServer | undefined
  const unexpected: string[] = []
  const posted: Array<{ path: string; body: Record<string, unknown> }> = []
  const htmlPath = '/__stock-preparation-reuse-acceptance'
  const scopeJson = JSON.stringify({ tenantId: input.tenantId, workspaceId: null }).replaceAll('<', '\\u003c')
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head><body><div id="app"></div><script type="module">
    import {createApp,h} from 'vue'; import '/src/styles/tokens.css';
    import Source from '/src/components/integration/stockPreparation/StockPreparationSourceBindingPanel.vue';
    import Project from '/src/components/integration/stockPreparation/StockPreparationProjectSyncPanel.vue';
    const scope=${scopeJson};createApp({render:()=>h('main',[h(Source,{scope}),h(Project,{scope,projectNo:'SYN-REUSE'})])}).mount('#app');
    </script></body></html>`
  try {
    const plugins: Plugin[] = [vue()]
    plugins.push({ name: 'stock-preparation-second-owner-real-host', configureServer(server) {
      server.middlewares.use(htmlPath, async (_request, response, next) => {
        try { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(await server.transformIndexHtml(htmlPath, html)) }
        catch { next(new Error('BROWSER_REUSE_HTML_FAILED')) }
      })
    } })
    vite = await createServer({ root: webRoot, configFile: false, envFile: false, cacheDir, plugins,
      define: { 'import.meta.env.VITE_API_URL': '""', 'import.meta.env.VITE_API_BASE': '""' },
      optimizeDeps: { include: ['vue'] }, server: { host: '127.0.0.1', port: 0, hmr: false,
        proxy: { '/api': { target: input.apiOrigin, changeOrigin: false } } } })
    const server = vite.httpServer
    assert(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      void Promise.resolve(server.listen(0, '127.0.0.1', resolve)).catch(reject)
    })
    const address = server.address()
    assert(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() })
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', serviceWorkers: 'block' })
    await context.addInitScript(({ token, allowed }) => {
      if (location.origin !== allowed) return
      localStorage.setItem('auth_token', token); localStorage.setItem('metasheet_locale', 'zh-CN')
    }, { token: input.ownerToken, allowed: origin })
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue()
      unexpected.push('EXTERNAL_REQUEST'); return route.abort('blockedbyclient')
    })
    context.on('requestfailed', () => unexpected.push('REQUEST_FAILED'))
    context.on('request', request => {
      const url = new URL(request.url())
      if (!url.pathname.startsWith('/api/')) return
      const headers = request.headers()
      if (headers.authorization !== `Bearer ${input.ownerToken}`) unexpected.push('WRONG_SESSION')
      if (url.pathname === bindingPath && request.method() === 'GET') return
      if (url.pathname === previewPath && request.method() === 'POST') {
        if (url.search !== `?${new URLSearchParams({ tenantId: input.tenantId })}`) unexpected.push('PREVIEW_SCOPE')
        posted.push({ path: url.pathname, body: request.postDataJSON() }); return
      }
      if (url.pathname !== plansPath && !new RegExp(`^${plansPath}/[A-Za-z0-9_-]+/(validate|confirm-sample|approve|activate)$`).test(url.pathname)) {
        unexpected.push('UNEXPECTED_API'); return
      }
      if ('x-tenant-id' in headers || 'x-workspace-id' in headers) unexpected.push('MANAGEMENT_SCOPE_HEADER')
      if (request.method() === 'POST') posted.push({ path: url.pathname, body: request.postDataJSON() })
      else if (request.method() !== 'GET' || url.searchParams.get('systemId') !== input.systemId) unexpected.push('MANAGEMENT_QUERY')
    })
    context.on('response', response => { if (response.status() >= 400) unexpected.push('HTTP_REFUSAL') })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    page.on('pageerror', () => unexpected.push('PAGE_ERROR'))
    const wait = (method: string, path: string) => {
      const promise = page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === path)
      void promise.catch(() => {})
      return promise
    }
    const metadata = wait('GET', bindingPath)
    await page.goto(`${origin}${htmlPath}`)
    await responseData(await metadata)
    await page.getByTestId('stock-prep-source-plan-draft-summary').click()
    await page.getByTestId('stock-prep-source-plan-draft-import').setInputFiles({
      name: 'owner-a-review.json', mimeType: 'application/json', buffer: Buffer.from(input.portableReviewJson),
    })
    const originalPlan = JSON.parse(input.portableReviewJson).readPlan as SourcePlanReadPlan
    await page.waitForFunction(expected => (document.querySelector('[data-testid="stock-prep-source-plan-draft-input-part-nameField"]') as HTMLInputElement)?.value === expected,
      originalPlan.part.nameField)
    assert.equal(posted.length, 0, 'BROWSER_REUSE_IMPORT_HAS_NO_AUTHORITY')
    for (const role of ['pathExAttr', 'pathInfo', 'orderHead', 'orderDetail', 'part', 'bomHead', 'bomDetail'] as const) {
      for (const [key, value] of Object.entries(input.readPlan[role])) {
        await page.getByTestId(`stock-prep-source-plan-draft-input-${role}-${key}`).fill(String(value))
      }
    }
    await page.getByTestId('stock-prep-source-plan-draft-preview').click()
    await page.getByTestId('stock-prep-source-plan-draft-json').waitFor()
    const local = JSON.parse(await page.getByTestId('stock-prep-source-plan-draft-json').innerText())
    assert.deepEqual(local, { schemaVersion: 1, kind: 'stock-preparation-plm-role-draft', status: 'confirm-required', validation: 'structure-only', readPlan: input.readPlan })
    await page.getByTestId('stock-prep-plan-management-toggle').check()
    await page.getByTestId('stock-prep-plan-system').fill(input.systemId)
    const list = wait('GET', plansPath)
    await page.getByTestId('stock-prep-plan-refresh').click()
    const initial = await responseData<SourcePlanVersionList>(await list)
    assert.equal(initial.versions.length, 0)
    const save = wait('POST', plansPath)
    const savedList = wait('GET', plansPath)
    await page.getByTestId('stock-prep-plan-save').click()
    const version = await responseData<SourcePlanVersion>(await save, 201)
    const savedVersions = await responseData<SourcePlanVersionList>(await savedList)
    assert.equal(version.status, 'draft')
    // Save returns the immutable version; list decorates it with receipt state.
    assert.equal(savedVersions.versions.find(row => row.id === version.id)?.validation, null)
    assert.equal(version.validationId, null)
    assert.deepEqual(version.config, { schemaVersion: 1, actionId, systemId: input.systemId, readPlan: input.readPlan })
    assert.deepEqual(posted[0], { path: plansPath, body: { managementScope: 'tenant', config: version.config } })
    await page.getByTestId(`stock-prep-plan-version-${version.id}`).check()
    assert.equal(await page.getByTestId('stock-prep-plan-approve').isDisabled(), true)
    await page.getByTestId('stock-prep-plan-project').fill('SYN-REUSE')
    const measuredResponse = wait('POST', `${plansPath}/${version.id}/validate`)
    await page.getByTestId('stock-prep-plan-validate').click()
    const measured = await responseData<{ validation: { validationId: string }; sample: { rows: Array<Record<string, unknown>>; totalRows: number } }>(await measuredResponse)
    assert.equal(measured.sample.totalRows, 2)
    assert.deepEqual(measured.sample.rows.map(row => ({ id: row.componentSourceId, quantity: row.totalQuantity,
      materialVersion: row.sourceVersion, ...(Object.hasOwn(row, 'orderBomVersion') ? { orderVersion: row.orderBomVersion } : {}) })), [
      { id: 'REUSE-ROOT', quantity: 4, materialVersion: 'P9', orderVersion: 'B7' },
      { id: 'REUSE-CHILD', quantity: 20, materialVersion: 'P3' },
    ])
    await page.getByTestId('stock-prep-plan-sample-0-orderBomVersion').filter({ hasText: 'B7' }).waitFor()
    assert.equal(await page.getByTestId('stock-prep-plan-sample-0-sourceVersion').innerText(), 'P9')
    assert.equal(await page.getByTestId('stock-prep-plan-sample-1-totalQuantity').innerText(), '20')
    assert.equal(await page.getByTestId('stock-prep-plan-approve').isDisabled(), true)
    await page.getByTestId('stock-prep-plan-validation').screenshot({ path: path.join(artifactDir, 'second-owner-sample.png') })
    const confirm = wait('POST', `${plansPath}/${version.id}/confirm-sample`)
    await page.getByTestId('stock-prep-plan-confirm-sample').click()
    await responseData(await confirm)
    let activatedGeneration = 0
    for (const operation of ['approve', 'activate']) {
      await page.getByTestId(`stock-prep-plan-${operation}`).click()
      const response = wait('POST', `${plansPath}/${version.id}/${operation}`)
      const refreshed = wait('GET', plansPath)
      await page.getByTestId('stock-prep-plan-confirm-submit').click()
      await responseData(await response)
      const current = await responseData<SourcePlanVersionList>(await refreshed)
      if (operation === 'activate') {
        assert.equal(current.activation?.status, 'active')
        assert.equal(current.activation?.versionId, version.id)
        assert.equal(current.activation?.systemId, input.systemId)
        activatedGeneration = current.activation!.generation
      }
    }
    const previewResponse = wait('POST', previewPath)
    await page.getByTestId('stock-prep-project-preview-run').click()
    const preview = await responseData<{ status: string; canApply: boolean; dryRunToken: string; counts: Record<string, number> }>(await previewResponse)
    assert.equal(preview.status, 'ready')
    assert.equal(preview.canApply, true)
    assert.deepEqual(preview.counts, { add: 2, update: 0, skip: 0, inactive: 0, manual_confirm: 0 })
    await page.getByTestId('stock-prep-project-preview').filter({ hasText: '计划新增 2' }).waitFor()
    assert.equal(await page.getByTestId('stock-prep-project-sync-verdict').count(), 0)
    assert.equal(unexpected.length, 0, `BROWSER_REUSE_UNEXPECTED_${unexpected[0] ?? 'NONE'}`)
    assert.equal(posted.length, 6)
    assert.deepEqual(posted.slice(1, 4).map(row => row.body), [
      { managementScope: 'tenant', systemId: input.systemId, projectNo: 'SYN-REUSE' },
      { managementScope: 'tenant', systemId: input.systemId, validationId: measured.validation.validationId },
      { managementScope: 'tenant', systemId: input.systemId },
    ])
    assert.deepEqual(posted[4].body, { managementScope: 'tenant', systemId: input.systemId, expectedGeneration: initial.activation?.generation ?? 0 })
    assert.deepEqual(posted[5].body, { parameters: { projectNo: 'SYN-REUSE' }, includeMissingComponents: true })
    return { versionId: version.id, validationId: measured.validation.validationId, token: preview.dryRunToken,
      generation: activatedGeneration, posts: posted.length }
  } finally {
    try { await browser?.close() } finally { await vite?.close() }
  }
}
