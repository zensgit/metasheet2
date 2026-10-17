/// <reference lib="dom" />

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import type { Browser, Page, Request as BrowserRequest, Response as BrowserResponse } from '@playwright/test'
// Vite is a web-workspace dependency at both type-check and runtime boundaries.
import type { Plugin, ViteDevServer } from '../../../../apps/web/node_modules/vite'
import type { ReadBudget, ReadPreview, ReadSelector, ReadRecordCondition, ReadScheduleDefinition, ReadRetryContext, ReadRetryRef } from '../../src/integration/automation-read-contracts'

export interface AutomationReadBrowserAcceptanceInput {
  /** The caller's already-running owned-loopback JWT/RBAC/real-DB fixture. */
  apiOrigin: string
  ownerToken: string
  otherToken: string
  sheetId: string
  projectNo: string
  expectedRuleId: string
  /** Optional actual Editor/composable/public CRUD path; no candidate is injected. */
  authoring?: { intervalSeconds?: string; afterSave(ruleId: string): Promise<void> }
  /** After explicit activation, use the actual record producer, not direct
   * submit/source IO. Return its queued request before the shared worker step. */
  recordActivation?: { triggerType: 'record.created' | 'record.updated'; afterActivate(activationId: string, grantId: string): Promise<{ requestId: string }> }
  /** Start the actual scheduler only after the DOM's real explicit consent.
   * The optional type is an assertion, never a replacement for real options. */
  scheduleActivation?: { expectedTriggerType?: ReadScheduleDefinition['triggerType'];
    afterActivate(activationId: string, grantId: string): Promise<{ requestId: string }> }
  /** Explicit opt-in: afterSubmit must finish the manual parent as unknown.
   * The actual DOM then consents to one new-budget child, which this callback
   * executes through the caller's real runtime, never a fake response. */
  manualLinkedRetry?: { afterRetry(requestId: string, grantId: string, parentRequestId: string): Promise<void> }
  /** Date-only counterpart: afterActivate still returns the real queued parent;
   * afterSubmit finishes its native attempt as unknown before DOM retry consent. */
  dateLinkedRetry?: { afterRetry(requestId: string, grantId: string, parentRequestId: string): Promise<void> }
  /** Only a child under this repository's tmp/ or artifacts/ is accepted. */
  cacheDir: string
  /** Optional synthetic-only UI evidence, retained under repository artifacts/. */
  screenshotDir?: string
  /** Called after real manual HTTP 202 or automatic producer admission has been
   * observed as queued, never a replacement for the production producer. */
  afterSubmit(requestId: string, grantId: string): Promise<void>
  /** Revoke the real owner's live authority before the next explicit observation. */
  beforeDenial(): Promise<void>
  /** Restore that live authority and stop the actual runtime, not management. */
  beforeHistoryOnly(): Promise<void>
  /** Real native-driver counter, used to prove metadata is source-IO-free. */
  observeCounters(): Promise<{ nativeReads: number }>
}

export interface AutomationReadBrowserAcceptanceResult {
  grantId: string
  requestId: string
  preview: ReadPreview
  authoredRuleId?: string
  publicCrud?: { creates: number; updates: number; reads: number; defaultTenantHint: true }
  recordActivation?: { activationId: string; activationPosts: number; automaticPurpose: true }
  scheduleActivation?: { activationId: string; activationPosts: number; automaticPurpose: true; dateFieldConsent?: true }
  linkedRetry?: { parentRequestId: string; parentGrantId: string; retryPosts: 1; dateLinkedRetryConsent?: true }
  screenshots?: { consent: string; preview: string; retryConsent?: string }
  /** Owner-control traffic only; optional public CRUD is reported separately. */
  counts: {
    apiGets: number
    apiPosts: number
    grantPosts: number
    submitPosts: number
    revokePosts: number
    ownerDeniedGets: number
    nonOwnerPosts: number
    unexpectedRequests: number
    pageErrors: number
  }
  evidence: {
    realChromium: true
    realComponent: true
    realApiProxy: true
    mountNoRequests: true
    explicitGrantBeforeSubmit: true
    selectedRuleBound: true
    readonlyPreview: true
    metadataRefreshNoSourceReads: true
    /** Applies to owner-control calls; ordinary apiFetch retains its tenant hint. */
    noScopeHeaders: true
    sessionCleared: true
    otherOwnerEmpty: true
    revokedOwnerDenied: true
    stoppedRuntimeManagement: true
  }
}

type OptionsPage = {
  items: Array<{ selector: ReadSelector; ruleName: string; budget: ReadBudget; allowedTriggers: string[];
    recordActivationEligible: boolean; recordTriggerType: 'record.created' | 'record.updated' | null;
    recordRuleRevision: string | null; recordCondition: ReadRecordCondition | null; scheduleActivationEligible: boolean;
    scheduleRuleRevision: string | null; scheduleDefinition: ReadScheduleDefinition | null }>
  nextCursor: string | null
}
type RequestDetail = { requestId: string; status: string; result: ReadPreview | null }
const prefix = '/api/integration/automation-read'
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const webRoot = path.join(repositoryRoot, 'apps', 'web')
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

// Only errors constructed from our fixed, values-free observations may retain
// their detail through the higher-level load diagnostic. Never forward an
// arbitrary browser/transport exception just because its message looks similar.
class BrowserObservationError extends Error {}
type BrowserRouteKind = 'options' | 'grant_list' | 'request_list' | 'grant_detail' | 'request_detail'
  | 'schedule_activation' | 'record_activation' | 'retry_context' | 'retry' | 'revoke' | 'rule' | 'pattern' | 'other'
type BrowserSession = 'owner' | 'other' | 'none'
type BrowserMethod = 'GET' | 'POST' | 'PATCH' | 'other'
function browserMethod(method: string): BrowserMethod {
  return method === 'GET' || method === 'POST' || method === 'PATCH' ? method : 'other'
}
function browserRouteKind(route: string | RegExp): BrowserRouteKind {
  if (typeof route !== 'string') return 'pattern'
  if (route === `${prefix}/options`) return 'options'
  if (route === `${prefix}/grants`) return 'grant_list'
  if (route === `${prefix}/requests`) return 'request_list'
  if (route === `${prefix}/schedule-activations`) return 'schedule_activation'
  if (route === `${prefix}/record-activations`) return 'record_activation'
  if (new RegExp(`^${prefix}/requests/[a-f0-9-]{36}/retry-context$`).test(route)) return 'retry_context'
  if (new RegExp(`^${prefix}/requests/[a-f0-9-]{36}/retry$`).test(route)) return 'retry'
  if (new RegExp(`^${prefix}/grants/[a-f0-9-]{36}/revoke$`).test(route)) return 'revoke'
  if (new RegExp(`^${prefix}/grants/[a-f0-9-]{36}$`).test(route)) return 'grant_detail'
  if (new RegExp(`^${prefix}/requests/[a-f0-9-]{36}$`).test(route)) return 'request_detail'
  if (/^\/api\/multitable\/sheets\/[^/]+\/automations(?:\/[^/]+)?$/u.test(route)) return 'rule'
  return 'other'
}
class BrowserRequestResponseError extends BrowserObservationError {
  constructor(readonly reason: 'BROWSER_HTTP_RESPONSE_NULL' | 'BROWSER_HTTP_RESPONSE_IDENTITY_MISMATCH',
    readonly method: BrowserMethod, readonly kind: BrowserRouteKind, readonly session: BrowserSession,
    readonly failure: 'aborted' | 'other' | 'none', readonly elapsedMs: number,
    readonly pageClosed: boolean, readonly responseObserved: boolean, readonly responseStatus: number | null) {
    super(`${reason}_${method}_${kind}_${session}_${failure}`)
  }
}

function ownedCachePath(value: string): string {
  const resolved = path.resolve(value)
  const relative = path.relative(repositoryRoot, resolved)
  const parts = relative.split(path.sep)
  assert(!relative.startsWith('..') && !path.isAbsolute(relative)
    && ['tmp', 'artifacts'].includes(parts[0]) && parts.length >= 2 && parts[1], 'BROWSER_CACHE_SCOPE')
  return resolved
}

async function responseData<T>(response: BrowserResponse, expectedStatus = 200): Promise<T> {
  assert.equal(response.status(), expectedStatus, 'BROWSER_HTTP_STATUS')
  let envelope: { ok?: unknown; data?: T }
  try { envelope = await response.json() as { ok?: unknown; data?: T } }
  catch (error) {
    // Never echo transport exception text, URLs, bodies, headers or tokens.
    const missing = error instanceof Error && /No data found for resource|No resource with given identifier/iu.test(error.message)
    throw new Error(missing ? 'BROWSER_BODY_NOT_RETAINED' : 'BROWSER_BODY_UNREADABLE')
  }
  assert(envelope && typeof envelope === 'object' && !Array.isArray(envelope)
    && isDeepStrictEqual(Object.keys(envelope).sort(), ['data', 'ok'])
    && envelope.ok === true && envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data),
  'BROWSER_HTTP_ENVELOPE')
  return envelope.data
}

function waitApiRequest(page: Page, method: string, pathname: string | RegExp, token: string,
  session: BrowserSession, observedStatus: (request: BrowserRequest) => number | undefined): Promise<BrowserResponse> {
  // Bind the next request issued by this operation's real session, not a late
  // response from the same URL in the preceding account/operation. Tokens stay
  // in memory and are only compared, never included in diagnostics.
  const pending = page.waitForRequest(request => request.method() === method
    && (typeof pathname === 'string' ? new URL(request.url()).pathname === pathname : pathname.test(new URL(request.url()).pathname))
    && request.headers().authorization === `Bearer ${token}`).then(async request => {
    const started = performance.now()
    const response = await request.response()
    if (!response || response.request() !== request) {
      // These are separate hard refusals. Classify only fixed observations;
      // retain neither this request nor any transport-provided text in errors.
      const failure = request.failure()
      const status = observedStatus(request)
      throw new BrowserRequestResponseError(response ? 'BROWSER_HTTP_RESPONSE_IDENTITY_MISMATCH' : 'BROWSER_HTTP_RESPONSE_NULL',
        browserMethod(request.method()), browserRouteKind(new URL(request.url()).pathname), session,
        !failure ? 'none' : failure.errorText === 'net::ERR_ABORTED' ? 'aborted' : 'other',
        Math.round(performance.now() - started), page.isClosed(), status !== undefined,
        status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null)
    }
    return response
  })
  // An earlier UI assertion may fail before this is awaited. Keep teardown from
  // producing an unhandled rejection, while preserving the actual wait's failure.
  void pending.catch(() => {})
  return pending
}

async function painted(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

/**
 * Real Chromium -> actual owner panel + transport -> isolated Vite proxy -> the
 * caller's actual JWT/RBAC/ledger/runtime. No route fulfils, component-state
 * injection, fake API response, source stub or token decoder authorizes a step.
 * Only synthetic tokens/props enter this browser. No HAR or browser traces are
 * written. Optional screenshots contain only the synthetic panel and are kept
 * under the caller's repository artifacts directory; never real customer data.
 * Optional authoring mounts the actual Editor without its optional unrelated
 * directory-picker client. Its emitted payload goes unchanged through the real
 * composable + default public API client. This is not Manager/app navigation.
 * A bounded native Response.clone() observer concurrently drains successful
 * own-origin API responses. It changes the observed stream's lifecycle, not its
 * bytes or the original Response returned to production. CDP body/status, DOM
 * completion and unexpected-request failures remain independent hard checks.
 */
export async function runAutomationReadBrowserAcceptance(
  input: AutomationReadBrowserAcceptanceInput,
): Promise<AutomationReadBrowserAcceptanceResult> {
  const api = new URL(input.apiOrigin)
  assert(api.protocol === 'http:' && api.hostname === '127.0.0.1'
    && api.origin === input.apiOrigin && api.username + api.password === '', 'BROWSER_API_OWNED_LOOPBACK')
  assert(input.ownerToken && input.otherToken && input.ownerToken !== input.otherToken, 'BROWSER_DISTINCT_SESSIONS')
  assert(!(input.recordActivation && input.scheduleActivation), 'BROWSER_SINGLE_ACTIVATION_FAMILY')
  assert(!(input.manualLinkedRetry && (input.recordActivation || input.scheduleActivation)), 'BROWSER_RETRY_MANUAL_ONLY')
  assert(!(input.manualLinkedRetry && input.dateLinkedRetry), 'BROWSER_SINGLE_RETRY_FAMILY')
  assert(!input.dateLinkedRetry || (!input.recordActivation
    && input.scheduleActivation?.expectedTriggerType === 'schedule.date_field'), 'BROWSER_RETRY_DATE_ACTIVATION_REQUIRED')
  const activationHook = input.recordActivation ?? input.scheduleActivation
  const activationFamily = input.scheduleActivation ? 'schedule' : 'record'
  const linkedRetryHook = input.manualLinkedRetry ?? input.dateLinkedRetry
  const cacheParent = ownedCachePath(input.cacheDir)
  await mkdir(cacheParent, { recursive: true })
  // Resolve the parent before creating the disposable child: a symlink/junction
  // must not redirect Vite or cleanup outside the allowed repository subtree.
  const canonicalParent = ownedCachePath(await realpath(cacheParent))
  const cacheDir = await mkdtemp(path.join(canonicalParent, 'automation-read-browser-'))
  assert.equal(path.dirname(cacheDir), canonicalParent, 'BROWSER_CACHE_CHILD')
  let screenshots: AutomationReadBrowserAcceptanceResult['screenshots']
  if (input.screenshotDir) {
    const parent = ownedCachePath(input.screenshotDir)
    assert.equal(path.relative(repositoryRoot, parent).split(path.sep)[0], 'artifacts', 'BROWSER_SCREENSHOT_SCOPE')
    await mkdir(parent, { recursive: true })
    const canonical = ownedCachePath(await realpath(parent))
    assert.equal(path.relative(repositoryRoot, canonical).split(path.sep)[0], 'artifacts', 'BROWSER_SCREENSHOT_REAL_SCOPE')
    const child = await mkdtemp(path.join(canonical, 'owner-cron-'))
    assert.equal(path.dirname(child), canonical, 'BROWSER_SCREENSHOT_CHILD')
    screenshots = { consent: path.join(child, 'consent.png'), preview: path.join(child, 'preview.png'),
      ...(input.dateLinkedRetry ? { retryConsent: path.join(child, 'retry-consent.png') } : {}) }
  }
  const webRequire = createRequire(path.join(webRoot, 'package.json'))
  let vite: ViteDevServer | undefined
  let browser: Browser | undefined
  const unexpected: string[] = []
  let apiGets = 0
  let pageErrors = 0
  let ownerDeniedGets = 0
  const posts: Array<{ path: string; body: unknown; nonOwner: boolean }> = []
  const crud: Array<{ method: string; body: unknown; tenantHint: boolean }> = []
  const rulesPath = `/api/multitable/sheets/${encodeURIComponent(input.sheetId)}/automations`
  let selectedRuleId = input.expectedRuleId
  let retryParentRequestId: string | undefined
  let linkedRetry: AutomationReadBrowserAcceptanceResult['linkedRetry']
  const transportFacts: Array<{ kind: string; status: number }> = []
  const failureFacts: Array<{ kind: string; session: string; cause: string }> = []
  const requestResponseStatuses = new WeakMap<BrowserRequest, number>()
  const htmlPath = '/__automation-read-owner-acceptance'
  const props = JSON.stringify({ sheetId: input.sheetId, projectNo: input.projectNo }).replaceAll('<', '\\u003c')
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">
    <style>body{margin:16px;font-family:system-ui,sans-serif}input,button,select{max-width:100%;box-sizing:border-box}</style>
    </head><body><div id="app"></div><script type="module">
    import {createApp,h,ref} from 'vue'; import '/src/styles/tokens.css';
    import Panel from '/src/components/integration/stockPreparation/StockPreparationAutomationReadPanel.vue';
    ${input.authoring ? `
    import Editor from '/src/multitable/components/MetaAutomationRuleEditor.vue';
    import {useMultitableAutomations} from '/src/multitable/composables/useMultitableAutomations.ts';
    import {MultitableApiClient} from '/src/multitable/api/client.ts';
    import ElementPlus from 'element-plus'; import 'element-plus/dist/index.css';
    const context=${props};
    createApp({setup(){
      const {rules,loadRules,createRule,updateRule,error}=useMultitableAutomations(new MultitableApiClient());
      const visible=ref(false),editing=ref(null),savedId=ref('');
      async function save(payload){
        try{
          if(editing.value?.id) await updateRule(context.sheetId,editing.value.id,payload);
          else {await createRule(context.sheetId,payload);savedId.value=rules.value[0].id;}
          visible.value=false;editing.value=null;
        }catch{}
      }
      async function edit(){
        await loadRules(context.sheetId);
        editing.value=rules.value.find(rule=>rule.id===savedId.value)??null;
        if(editing.value) visible.value=true;
      }
      return()=>h('div',[
        h('button',{'data-testid':'acceptance-new-rule',onClick:()=>{editing.value=null;visible.value=true;}},'New rule'),
        h('button',{'data-testid':'acceptance-edit-rule',disabled:!savedId.value,onClick:edit},'Edit saved rule'),
        h('div',{'data-testid':'acceptance-saved-rule','data-rule-id':savedId.value},error.value?'Save failed':''),
        h(Editor,{visible:visible.value,sheetId:context.sheetId,fields:[],rule:editing.value,
          onSave:save,onClose:()=>{visible.value=false;}}),h(Panel,context)]);
    }}).use(ElementPlus).mount('#app');` : `createApp({render:()=>h(Panel,${props})}).mount('#app');`}
    </script></body></html>`

  const nativeReads = async (): Promise<number> => {
    const current = (await input.observeCounters()).nativeReads
    assert(Number.isSafeInteger(current) && current >= 0, 'BROWSER_NATIVE_COUNTER')
    return current
  }
  const unchangedReads = async (before: number): Promise<void> => {
    assert.equal(await nativeReads(), before, 'BROWSER_METADATA_SOURCE_IO')
  }

  try {
    const { createServer } = await import(pathToFileURL(webRequire.resolve('vite')).href) as typeof import('../../../../apps/web/node_modules/vite')
    const { default: vue } = await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-vue')).href) as { default: () => Plugin }
    const { chromium } = await import(pathToFileURL(webRequire.resolve('@playwright/test')).href) as typeof import('@playwright/test')
    vite = await createServer({
      root: webRoot, configFile: false, envFile: false, cacheDir,
      define: { 'import.meta.env.VITE_API_URL': '""', 'import.meta.env.VITE_API_BASE': '""' },
      plugins: [vue(), {
        name: 'automation-read-real-owner-browser-acceptance',
        configureServer(server) {
          server.middlewares.use(htmlPath, async (_request, response, next) => {
            try {
              response.setHeader('Content-Type', 'text/html; charset=utf-8')
              response.end(await server.transformIndexHtml(htmlPath, html))
            } catch {
              next(new Error('BROWSER_OWNER_HTML_FAILED'))
            }
          })
        },
      }],
      optimizeDeps: { include: ['vue'] },
      server: { host: '127.0.0.1', port: 0, hmr: false,
        proxy: { '/api': { target: input.apiOrigin, changeOrigin: false } } },
    })
    const server = vite.httpServer
    assert(server, 'BROWSER_UI_SERVER')
    // Vite.listen substitutes its default for zero; the public HTTP wrapper
    // initializes Vite while retaining an actual ephemeral loopback port.
    await new Promise<void>((resolve, reject) => {
      const failed = () => reject(new Error('BROWSER_UI_LISTEN_FAILED'))
      server.once('error', failed)
      try {
        void Promise.resolve(server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', failed)
          resolve()
        })).catch(failed)
      } catch {
        server.removeListener('error', failed)
        failed()
      }
    })
    const address = server.address()
    assert(address && typeof address !== 'string', 'BROWSER_UI_ADDRESS')
    const origin = `http://127.0.0.1:${address.port}`
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() })
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', serviceWorkers: 'block' })
    let currentToken = input.ownerToken
    let denialExpected = false
    const deniedStreams = new Set<BrowserRequest>()
    await context.addInitScript(({ token, allowedOrigin }) => {
      if (location.origin === allowedOrigin) localStorage.setItem('auth_token', token)
    }, { token: input.ownerToken, allowedOrigin: origin })
    await context.addInitScript(() => {
      // Diagnostic observation only. Keep the native abort and all refusal
      // assertions; never retain a URL/token/response body or arbitrary stack.
      const trace: Array<{ at: number; cause: string; line: number }> = []
      Object.defineProperty(window, '__automationReadAbortTrace', { value: trace })
      const abort = AbortController.prototype.abort
      AbortController.prototype.abort = function (reason?: unknown) {
        const stack = String(new Error().stack ?? '')
        const cause = ['checkExternalSession', 'checkSession', 'onStorage', 'reset', 'fail', 'dispose']
          .find(name => new RegExp(`\\bat ${name}\\b`).test(stack)) ?? 'other'
        const line = Number(/\/services\/integration\/automationRead\.ts:(\d+):\d+/u.exec(stack)?.[1] ?? 0)
        if (trace.length >= 32) trace.shift()
        trace.push({ at: Math.round(performance.now()), cause, line })
        return Reflect.apply(abort, this, [reason])
      }
    })
    await context.addInitScript(({ allowedOrigin }) => {
      // With Chromium request interception, a fully consumed native reader can
      // still report ERR_ABORTED/CDP body-missing without a page abort/navigation.
      // A separate native clone reader stabilizes the observation lifecycle in
      // the synthetic diagnostic. This is NOT a fallback body or a retry: keep
      // the original fetch/Response and every CDP/requestfailed check unchanged.
      const nativeFetch = window.fetch
      const pending = new Set<Promise<void>>()
      const failures: string[] = []
      const maxResponses = 128
      const maxConcurrent = 8
      const maxResponseBytes = 1024 * 1024
      const maxTotalBytes = 8 * maxResponseBytes
      let eligible = 0
      let completed = 0
      let bytes = 0
      let draining = false
      const fail = (code: string) => { if (failures.length < 4) failures.push(code) }
      const observe = async (response: Response): Promise<void> => {
        const copy = response.clone()
        if (!copy.body) return
        const reader = copy.body.getReader()
        let timer: number | undefined
        let readBytes = 0
        const deadline = new Promise<never>((_resolve, reject) => {
          timer = window.setTimeout(() => reject(new Error('CLONE_TIMEOUT')), 15_000)
        })
        try {
          for (;;) {
            const chunk = await Promise.race([reader.read(), deadline])
            if (chunk.done) break
            const size = chunk.value.byteLength
            if (size > maxResponseBytes - readBytes || size > maxTotalBytes - bytes) {
              fail('BYTE_LIMIT')
              throw new Error('CLONE_BYTE_LIMIT')
            }
            readBytes += size
            bytes += size
            // Count and discard chunks; do not decode/store/forward any body.
          }
        } catch {
          fail('READ_FAILED')
          // Cancelling this tee branch never aborts the original fetch. The
          // cancellation promise can await the original branch; READ_FAILED
          // already makes the acceptance fail, so cleanup cannot turn it green.
          void reader.cancel().catch(() => { fail('CANCEL_FAILED') })
        } finally {
          window.clearTimeout(timer)
          reader.releaseLock()
        }
      }
      window.fetch = async function (request: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const response = await Reflect.apply(nativeFetch, this, [request, init]) as Response
        const url = new URL(response.url)
        if (url.origin === allowedOrigin && url.pathname.startsWith('/api/')
          && response.status >= 200 && response.status < 300) {
          eligible += 1
          if (draining || eligible > maxResponses || pending.size >= maxConcurrent) fail('COUNT_LIMIT')
          else {
            const observation = observe(response).catch(() => { fail('OBSERVATION_FAILED') }).finally(() => {
              completed += 1
              pending.delete(observation)
            })
            pending.add(observation)
          }
        }
        // In particular, do not clone/read any refused 401/403 private body.
        return response
      }
      Object.defineProperty(window, '__automationReadDrainClones', { value: async () => {
        draining = true
        while (pending.size) await Promise.all([...pending])
        return { eligible, completed, bytes, active: pending.size, failures: [...failures] }
      } })
    }, { allowedOrigin: origin })
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue()
      unexpected.push('EXTERNAL_REQUEST')
      return route.abort('blockedbyclient')
    })
    context.on('requestfailed', request => {
      // The real client intentionally refuses/aborts an observed 403 body. Only
      // that exact, already-observed request is exempt; all other aborts fail.
      if (!deniedStreams.has(request)) {
        unexpected.push('REQUEST_FAILED')
        const pathname = new URL(request.url()).pathname
        const kind = pathname === `${prefix}/options` ? 'options' : pathname === `${prefix}/grants` ? 'grants'
          : pathname === `${prefix}/requests` ? 'requests' : pathname.startsWith(prefix) ? 'detail' : 'ui'
        const authorization = request.headers().authorization
        const session = authorization === `Bearer ${input.ownerToken}` ? 'owner'
          : authorization === `Bearer ${input.otherToken}` ? 'other' : 'none'
        failureFacts.push({ kind, session, cause: request.failure()?.errorText === 'net::ERR_ABORTED' ? 'aborted' : 'other' })
      }
    })
    context.on('request', request => {
      const url = new URL(request.url())
      if (url.origin !== origin) unexpected.push('UNEXPECTED_ORIGIN')
      if (!url.pathname.startsWith('/api/')) return
      const method = request.method()
      const isCrud = Boolean(input.authoring) && (url.pathname === rulesPath || url.pathname.startsWith(rulesPath + '/'))
      const known = url.pathname === `${prefix}/options`
        || url.pathname === `${prefix}/grants` || url.pathname === `${prefix}/requests`
        || url.pathname === `${prefix}/record-activations` || url.pathname === `${prefix}/schedule-activations`
        || new RegExp(`^${prefix}/(?:grants|requests)/[a-f0-9-]{36}$`).test(url.pathname)
        || new RegExp(`^${prefix}/grants/[a-f0-9-]{36}/revoke$`).test(url.pathname)
      const knownRetry = Boolean(linkedRetryHook && retryParentRequestId)
        && ((method === 'GET' && url.pathname === `${prefix}/requests/${retryParentRequestId}/retry-context`)
          || (method === 'POST' && url.pathname === `${prefix}/requests/${retryParentRequestId}/retry`))
      if (!(known && ['GET', 'POST'].includes(method))
        && !knownRetry
        && !(isCrud && ['GET', 'POST', 'PATCH'].includes(method))) unexpected.push('UNEXPECTED_API')
      const headers = request.headers()
      if (headers.authorization !== `Bearer ${currentToken}`) unexpected.push('WRONG_SESSION')
      if (headers.cookie) unexpected.push('COOKIE_AUTHORITY')
      for (const name of Object.keys(headers)) {
        const normalized = name.toLowerCase().replace(/^x-/, '').replaceAll(/[-_]/g, '')
        if (['tenantid', 'workspaceid', 'orgid', 'actorid', 'ownerid', 'userid', 'projectno'].includes(normalized)
          && !(isCrud && name.toLowerCase() === 'x-tenant-id')) {
          unexpected.push('SCOPE_HEADER')
        }
      }
      if (isCrud) crud.push({ method, body: method === 'GET' ? undefined : request.postDataJSON(), tenantHint: Boolean(headers['x-tenant-id']) })
      else if (method === 'GET') apiGets += 1
      else posts.push({ path: url.pathname, body: request.postDataJSON(), nonOwner: currentToken === input.otherToken })
    })
    context.on('response', response => {
      const url = new URL(response.url())
      if (!url.pathname.startsWith('/api/')) {
        if (response.status() >= 400) unexpected.push('UI_HTTP_STATUS')
        return
      }
      const kind = url.pathname === `${prefix}/options` ? 'options'
        : url.pathname === `${prefix}/grants` ? 'grants'
          : url.pathname === `${prefix}/requests` ? 'requests' : 'detail'
      transportFacts.push({ kind, status: response.status() })
      requestResponseStatuses.set(response.request(), response.status())
      if (denialExpected && currentToken === input.ownerToken && response.status() === 403
        && response.request().method() === 'GET') {
        deniedStreams.add(response.request())
        ownerDeniedGets += 1
      } else if (![200, 201, 202].includes(response.status())) unexpected.push('API_HTTP_STATUS')
    })
    const page = await context.newPage()
    let mainNavigations = 0
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) mainNavigations++ })
    page.setDefaultTimeout(20_000)
    const sessionKind = (token: string): BrowserSession => token === input.ownerToken ? 'owner'
      : token === input.otherToken ? 'other' : 'none'
    const observedFailure = async (error: unknown, method: string, pathname: string | RegExp,
      session: BrowserSession, status: number | null): Promise<never> => {
      const requestError = error instanceof BrowserRequestResponseError ? error : undefined
      const reason = requestError?.reason ?? (error instanceof Error
        && ['BROWSER_BODY_NOT_RETAINED', 'BROWSER_BODY_UNREADABLE', 'BROWSER_HTTP_STATUS', 'BROWSER_HTTP_ENVELOPE'].includes(error.message)
        ? error.message : 'BROWSER_RESPONSE_WAIT_FAILED')
      // Reuse the existing captures, only after the actual wait has failed.
      // Keep a bounded tail and numeric counts, never URLs, bodies, headers,
      // tokens, arbitrary failure messages/stacks or request identities.
      const trace = await page.evaluate(() => ({
        aborted: (window as unknown as { __automationReadAbortTrace: Array<{ at: number; cause: string; line: number }> }).__automationReadAbortTrace,
        uiError: !!document.querySelector('[data-testid="automation-read-error"]'),
        busy: (document.querySelector('[data-testid="automation-read-load"]') as HTMLButtonElement | null)?.disabled ?? null,
      })).catch(() => ({ aborted: [], uiError: false, busy: null }))
      const count = (value: number) => Math.min(128, Math.max(0, Number.isSafeInteger(value) ? value : 0))
      const aborts = Array.isArray(trace.aborted) ? trace.aborted : []
      const facts = {
        denialExpected, mainNavigations: count(mainNavigations), pageErrors: count(pageErrors),
        pageClosed: requestError?.pageClosed ?? page.isClosed(), requestElapsedMs: requestError?.elapsedMs ?? null,
        responseObserved: requestError?.responseObserved ?? (status !== null), responseStatus: requestError?.responseStatus ?? status,
        transportCount: count(transportFacts.length), failureCount: count(failureFacts.length),
        abortedFailures: count(failureFacts.filter(fact => fact.cause === 'aborted').length),
        abortTraceCount: count(aborts.length), abortTraceSaturated: aborts.length >= 32,
        transport: transportFacts.slice(-8).map(fact => ({
          kind: ['options', 'grants', 'requests', 'detail'].includes(fact.kind) ? fact.kind : 'other',
          status: Number.isInteger(fact.status) && fact.status >= 100 && fact.status <= 599 ? fact.status : 0,
        })),
        failures: failureFacts.slice(-8).map(fact => ({
          kind: ['options', 'grants', 'requests', 'detail', 'ui'].includes(fact.kind) ? fact.kind : 'other',
          session: fact.session === 'owner' || fact.session === 'other' ? fact.session : 'none',
          cause: fact.cause === 'aborted' ? 'aborted' : 'other',
        })),
        aborts: aborts.slice(-8).map(fact => ({
          at: Number.isSafeInteger(fact.at) && fact.at >= 0 ? fact.at : 0,
          line: Number.isSafeInteger(fact.line) && fact.line >= 0 ? fact.line : 0,
          cause: ['checkExternalSession', 'checkSession', 'onStorage', 'reset', 'fail', 'dispose'].includes(fact.cause) ? fact.cause : 'other',
        })),
        overflow: transportFacts.length > 128 || failureFacts.length > 128 || aborts.length > 128 || mainNavigations > 128 || pageErrors > 128,
        uiError: trace.uiError === true, busy: trace.busy === null ? null : trace.busy === true,
      }
      throw new BrowserObservationError(`${reason}_${requestError?.method ?? browserMethod(method)}_${requestError?.kind ?? browserRouteKind(pathname)}_${requestError?.session ?? session}_${requestError?.failure ?? 'none'}_${status ?? 0}_FACTS_${JSON.stringify(facts)}`)
    }
    const waitApi = (page: Page, method: string, pathname: string): Promise<BrowserResponse> => {
      const session = sessionKind(currentToken)
      const pending = waitApiRequest(page, method, pathname, currentToken, session, request => requestResponseStatuses.get(request))
        .catch(error => observedFailure(error, method, pathname, session, null))
      void pending.catch(() => {})
      return pending
    }
    const waitData = <T>(method: string, pathname: string | RegExp, status = 200): Promise<T> => {
      // Start reading this actual response as soon as its headers arrive. A
      // serialized UI may have fully consumed/released an early response before
      // its third request resolves; do not defer CDP body retrieval until then.
      // The same eager observation applies to detail/mutation responses: a
      // locator.click() can finish after the page consumed its small response.
      // This changes only observer timing, not the native fetch or abort checks.
      const session = sessionKind(currentToken)
      let observedStatus: number | null = null
      const pending = waitApiRequest(page, method, pathname, currentToken, session, request => requestResponseStatuses.get(request)).then(response => {
        observedStatus = response.status()
        return responseData<T>(response, status)
      }).catch(error => observedFailure(error, method, pathname, session, observedStatus))
      void pending.catch(() => {})
      return pending
    }
    page.on('pageerror', () => { pageErrors += 1 })
    const beforeMountReads = await nativeReads()
    await page.goto(`${origin}${htmlPath}`)
    await page.getByTestId('automation-read-panel').waitFor()
    await painted(page)
    assert.equal(apiGets + posts.length, 0, 'BROWSER_MOUNT_REQUEST')
    assert.equal(crud.length, 0, 'BROWSER_EDITOR_MOUNT_REQUEST')
    await unchangedReads(beforeMountReads)

    if (input.authoring) {
      await page.getByTestId('acceptance-new-rule').click()
      await painted(page)
      assert.equal(pageErrors, 0, 'BROWSER_EDITOR_OPEN_ERRORS')
      const nameInput = page.locator('input[data-field="name"], [data-field="name"] input')
      await nameInput.fill('Synthetic DOM-authored readonly rule')
      if (input.authoring.intervalSeconds !== undefined) {
        assert(input.scheduleActivation, 'BROWSER_INTERVAL_REQUIRES_AUTOMATIC_CONSENT')
        await page.locator('[data-field="triggerType"]').click()
        await page.locator('[data-value="schedule.interval"]:visible').click()
        await page.locator('input[data-field="intervalSeconds"], [data-field="intervalSeconds"] input').fill(input.authoring.intervalSeconds)
      }
      await page.locator('[data-action-index="0"] .meta-rule-editor__action-header .el-select').click()
      await page.locator('[data-value="integration_read_preview"]:visible').click()
      const manual = page.locator('[data-field="automationReadAllowManual"] input[type="checkbox"]')
      await manual.waitFor({ state: 'attached' })
      // The read action starts non-manual. Authoring the rule does not grant IO.
      assert.equal(await manual.isChecked(), false, 'BROWSER_EDITOR_MANUAL_DEFAULT')
      const config = page.locator('[data-action-index="0"] [data-field="actionConfigSection"]')
      if (!(await page.locator('[data-field="automationReadAllowManual"]').isVisible())) await config.locator('.el-collapse-item__header').click()
      if (input.authoring.intervalSeconds === undefined) await page.locator('[data-field="automationReadAllowManual"]').click()
      assert.equal(await manual.isChecked(), input.authoring.intervalSeconds === undefined, 'BROWSER_EDITOR_MANUAL_EXPLICIT')
      assert.equal(await page.locator('[data-action="add-action"]').isDisabled(), true, 'BROWSER_EDITOR_NO_MIXED_ACTION')
      assert.equal(crud.length, 0, 'BROWSER_EDITOR_IMPLICIT_SAVE')
      const createdResponse = waitData<{ rule: { id: string; actionType: string; actionConfig: unknown } }>('POST', rulesPath)
      await page.locator('[data-action="save"]').click()
      const created = await createdResponse
      assert(created.rule.id.startsWith('atr_') && uuidPattern.test(created.rule.id.slice(4)), 'BROWSER_EDITOR_CREATED_RULE_ID')
      selectedRuleId = created.rule.id
      await page.locator(`[data-testid="acceptance-saved-rule"][data-rule-id="${selectedRuleId}"]`).waitFor({ state: 'attached' })
      await page.locator('.meta-rule-editor').waitFor({ state: 'detached' })
      const listedResponse = waitData<{ rules: Array<{ id: string }> }>('GET', rulesPath)
      await page.getByTestId('acceptance-edit-rule').click()
      const listed = await listedResponse
      assert(listed.rules.some(rule => rule.id === selectedRuleId), 'BROWSER_EDITOR_PUBLIC_READBACK')
      await nameInput.waitFor()
      assert.equal(await manual.isChecked(), input.authoring.intervalSeconds === undefined, 'BROWSER_EDITOR_MANUAL_ROUNDTRIP')
      if (input.authoring.intervalSeconds !== undefined) assert.equal(
        await page.locator('input[data-field="intervalSeconds"], [data-field="intervalSeconds"] input').inputValue(),
        input.authoring.intervalSeconds, 'BROWSER_INTERVAL_EXACT_ROUNDTRIP')
      assert.equal(await page.locator('[data-action="test"]').isDisabled(), true, 'BROWSER_EDITOR_GENERIC_TEST_DISABLED')
      await nameInput.fill('Synthetic DOM-authored readonly rule updated')
      const patchedResponse = waitData<{ rule: { id: string; name: string; actionConfig: unknown } }>('PATCH', rulesPath + '/' + selectedRuleId)
      await page.locator('[data-action="save"]').click()
      const patched = await patchedResponse
      assert.equal(patched.rule.id, selectedRuleId, 'BROWSER_EDITOR_PATCH_ID')
      assert.equal(patched.rule.name, 'Synthetic DOM-authored readonly rule updated', 'BROWSER_EDITOR_PATCH_NAME')
      await page.locator('.meta-rule-editor').waitFor({ state: 'detached' })
      assert.equal(crud.filter(call => call.method === 'POST').length, 1, 'BROWSER_EDITOR_ONE_CREATE')
      assert.equal(crud.filter(call => call.method === 'PATCH').length, 1, 'BROWSER_EDITOR_ONE_UPDATE')
      assert.equal(crud.filter(call => call.method === 'GET').length, 1, 'BROWSER_EDITOR_ONE_READBACK')
      for (const call of crud.filter(call => call.method !== 'GET')) {
        const body = call.body as Record<string, unknown>
        assert.equal(body.actionType, 'integration_read_preview', 'BROWSER_EDITOR_ACTION_TYPE')
        const fixed = { operation: 'plm.stock-preparation.diff-preview.v1', allowManual: input.authoring.intervalSeconds === undefined }
        assert(isDeepStrictEqual(body.actionConfig, fixed), 'BROWSER_EDITOR_CLOSED_CONFIG')
        assert(isDeepStrictEqual(body.actions, [{ type: 'integration_read_preview', config: fixed }]), 'BROWSER_EDITOR_SINGLE_ACTION')
        if (input.authoring.intervalSeconds !== undefined) {
          assert.equal(body.triggerType, 'schedule.interval', 'BROWSER_INTERVAL_REAL_SAVE_TYPE')
          // This case deliberately selects 1.501 seconds: the actual Editor's
          // integer-part conversion must persist exactly 1501 milliseconds.
          assert.equal(input.authoring.intervalSeconds, '1.501', 'BROWSER_INTERVAL_SELECTED_SECONDS')
          assert(isDeepStrictEqual(body.triggerConfig, { intervalMs: 1501 }), 'BROWSER_INTERVAL_REAL_SAVE_CONFIG')
        }
      }
      assert(crud.every(call => call.tenantHint), 'BROWSER_EDITOR_DEFAULT_CLIENT_TENANT_HINT')
      assert.equal(apiGets + posts.length, 0, 'BROWSER_EDITOR_NO_OWNER_EXECUTION')
      await unchangedReads(beforeMountReads)
      await input.authoring.afterSave(selectedRuleId)
    }

    const panelSettled = async (control: 'automation-read-load' | 'automation-read-refresh-history'): Promise<void> => {
      // CDP retaining the body does not prove the page's fetch reader/parser and
      // Vue run() finally have finished. Observe the real rendered busy state
      // before changing sessions; never sleep, reissue a request or exempt aborts.
      try {
        await page.waitForFunction(testId => {
          const button = document.querySelector(`[data-testid="${testId}"]`)
          return button instanceof HTMLButtonElement && !button.disabled
        }, control)
      } catch { throw new Error('BROWSER_PANEL_OPERATION_NOT_SETTLED') }
      assert.equal(await page.getByTestId('automation-read-error').count(), 0, 'BROWSER_PANEL_OPERATION_ERROR')
    }
    const load = async (phase: 'initial' | 'other' | 'restored'): Promise<{ options: OptionsPage; grants: { items: unknown[] }; requests: { items: unknown[] } }> => {
      const factsStart = transportFacts.length
      const options = waitData<OptionsPage>('GET', `${prefix}/options`)
      const grants = waitData<{ items: unknown[] }>('GET', `${prefix}/grants`)
      const requests = waitData<{ items: unknown[] }>('GET', `${prefix}/requests`)
      try {
        await page.getByTestId('automation-read-load').click()
        const [optionsPage, grantPage, requestPage] = await Promise.all([options, grants, requests])
        await panelSettled('automation-read-load')
        await page.getByTestId('automation-read-option').waitFor()
        return { options: optionsPage, grants: grantPage, requests: requestPage }
      } catch (error) {
        // If the actual client refuses one response it may abort sibling body
        // streams. Report transport facts rather than letting CDP's missing-body
        // exception hide the first refusal. Never retry or echo error bodies.
        if (error instanceof BrowserObservationError) {
          // The shared wait already attached bounded, allowlisted facts. Keep
          // that first refusal intact rather than recapturing sibling failures.
          throw new BrowserObservationError(`BROWSER_LOAD_RESPONSE_FAILURE_${phase}_${error.message}`)
        }
        const statuses = transportFacts.slice(factsStart).map(fact => `${fact.kind}${fact.status}`).join('_')
        const reason = error instanceof Error && ['BROWSER_BODY_NOT_RETAINED', 'BROWSER_BODY_UNREADABLE',
          'BROWSER_HTTP_STATUS', 'BROWSER_HTTP_ENVELOPE', 'BROWSER_PANEL_OPERATION_NOT_SETTLED',
          'BROWSER_PANEL_OPERATION_ERROR'].includes(error.message) ? error.message : 'BROWSER_LOAD_WAIT_FAILED'
        const failures = failureFacts.map(fact => `${fact.kind}_${fact.session}_${fact.cause}`).join('_')
        const renderedError = await page.getByTestId('automation-read-error').isVisible().catch(() => false)
        const abortTrace = await page.evaluate(() => (window as unknown as {
          __automationReadAbortTrace: Array<{ at: number; cause: string; line: number }>
        }).__automationReadAbortTrace).catch(() => [])
        throw new Error(`BROWSER_LOAD_RESPONSE_FAILURE_${phase}_${statuses || 'NONE'}_${reason}_FAILED_${failures || 'NONE'}_UIERROR_${Number(renderedError)}_ABORTS_${JSON.stringify(abortTrace)}`)
      }
    }
    const initial = await load('initial')
    const option = initial.options.items.find(item => item.selector.ruleId === selectedRuleId)
    assert.equal(await page.getByTestId('automation-read-mode').inputValue(), 'manual', 'BROWSER_MANUAL_MODE_DEFAULT')
    let grantId: string, requestId: string
    let activationId: string | undefined
    let activationGrantId: string | undefined
    let dateFieldConsent = false
    let dateConsentLabel: string | undefined
    let confirmedDateOrigin: ReadRetryContext['dateScheduleOrigin']
    const beforeRetryPosts = activationHook ? 1 : 2
    const beforeRevokePosts = beforeRetryPosts + (linkedRetryHook ? 1 : 0)
    if (activationHook) {
      const expectedEligibility = activationFamily === 'record' ? option?.recordActivationEligible : option?.scheduleActivationEligible
      const otherEligibility = activationFamily === 'record' ? option?.scheduleActivationEligible : option?.recordActivationEligible
      assert(option && expectedEligibility === true && otherEligibility === false && option.allowedTriggers.includes(activationFamily)
        && !option.allowedTriggers.includes('manual'), 'BROWSER_AUTOMATIC_ONLY_OPTION_REQUIRED')
      await page.getByTestId('automation-read-mode').selectOption(activationFamily)
      await page.getByTestId('automation-read-option').selectOption(option.selector.ruleId)
      if (input.recordActivation) {
        assert.equal(option.recordTriggerType, input.recordActivation.triggerType, 'BROWSER_EXACT_RECORD_TRIGGER_OPTION')
        assert(typeof option.recordRuleRevision === 'string' && uuidPattern.test(option.recordRuleRevision), 'BROWSER_RECORD_REVISION_OPTION')
        assert.equal(await page.getByTestId('automation-read-record-trigger').getAttribute('data-record-trigger-type'),
          input.recordActivation.triggerType, 'BROWSER_EXACT_RECORD_TRIGGER_CONSENT')
        assert(option.recordCondition !== null, 'BROWSER_RECORD_CONDITION_OPTION')
        assert.equal(await page.getByTestId('automation-read-record-condition').getAttribute('data-record-condition-mode'),
          option.recordCondition.mode, 'BROWSER_RECORD_CONDITION_DISPLAY')
      }
      if (input.scheduleActivation) {
        assert(typeof option.scheduleRuleRevision === 'string' && uuidPattern.test(option.scheduleRuleRevision), 'BROWSER_SCHEDULE_REVISION_OPTION')
        assert(option.scheduleDefinition !== null, 'BROWSER_SCHEDULE_DEFINITION_OPTION')
        if (input.scheduleActivation.expectedTriggerType !== undefined) {
          assert.equal(option.scheduleDefinition.triggerType, input.scheduleActivation.expectedTriggerType,
            'BROWSER_SCHEDULE_EXPECTED_TRIGGER_OPTION')
        }
        assert.equal(await page.getByTestId('automation-read-schedule-definition').getAttribute('data-schedule-trigger-type'),
          option.scheduleDefinition.triggerType, 'BROWSER_SCHEDULE_EXACT_TYPE_CONSENT')
        if (option.scheduleDefinition.triggerType === 'schedule.date_field') {
          const { config, dateField } = option.scheduleDefinition
          assert(isDeepStrictEqual(Object.keys(option.scheduleDefinition).sort(), ['config', 'dateField', 'triggerType'])
            && isDeepStrictEqual(Object.keys(dateField).sort(), ['fieldId', 'fieldType', 'schemaRevision'])
            && dateField.fieldId === config.dateFieldId
            && (dateField.fieldType === 'date' || dateField.fieldType === 'dateTime')
            && uuidPattern.test(dateField.schemaRevision), 'BROWSER_DATE_CLOSED_CONFIRMATION_OPTION')
          assert(isDeepStrictEqual(Object.keys(config).sort(), ['dateFieldId', 'direction', 'offsetDays',
            ...(['timeOfDay', 'timezone', 'effectiveAt', 'scanIntervalMs'] as const).filter(key => Object.hasOwn(config, key))].sort())
            && Number.isSafeInteger(config.offsetDays) && config.offsetDays >= 0 && config.offsetDays <= 36_500
            && (config.direction === 'before' || config.direction === 'after'), 'BROWSER_DATE_CLOSED_CONFIG_OPTION')
          // The real browser context uses zh-CN; compare independent expected
          // text against visible DOM, not Vue state or the production formatter.
          dateConsentLabel = `schedule.date_field · ${dateField.fieldId} (${dateField.fieldType}) · ${config.direction === 'before' ? '提前' : '延后'} ${config.offsetDays} 天 · ${config.timeOfDay ?? '09:00'} ${config.timezone ?? 'UTC'} · schema=${dateField.schemaRevision}`
            + (config.effectiveAt === undefined ? '' : ` · effectiveAt=${config.effectiveAt}`)
            + (config.scanIntervalMs === undefined ? '' : ` · scanIntervalMs=${config.scanIntervalMs} (旧参数，不改变每日调度)`)
          assert.equal(await page.getByTestId('automation-read-schedule-definition').isVisible(), true, 'BROWSER_DATE_DEFINITION_VISIBLE')
          assert((await page.getByTestId('automation-read-schedule-definition').innerText()).trim() === dateConsentLabel,
            'BROWSER_DATE_EXACT_DEFINITION_DOM')
          assert.equal(await page.getByTestId('automation-read-schedule-revision').isVisible(), true, 'BROWSER_DATE_REVISION_VISIBLE')
          assert((await page.getByTestId('automation-read-schedule-revision').innerText()).trim()
            === `本次确认规则版本：${option.scheduleRuleRevision}`, 'BROWSER_DATE_REVISION_DOM')
          const scope = await page.getByTestId('automation-read-schedule-scope').innerText()
          assert(await page.getByTestId('automation-read-schedule-scope').isVisible()
            && scope.includes('仅支持无条件的 schedule.date_field')
            && scope.includes('每条合格记录的每个到期时点各消耗一次固定项目的读取预算')
            && scope.includes('项目绝不从记录内容推导')
            && scope.includes('只读结果不写业务表、不外发、不授予手动执行权限'), 'BROWSER_DATE_FIXED_PROJECT_SCOPE_DOM')
          assert((await page.getByTestId('automation-read-schedule-confirm').locator('..').innerText()).trim()
            === '我已核对日期字段、类型、schema 版本、偏移、时间及时区，明确同意每条合格到期记录分别消耗上述固定项目预算，仅生成只读预览。',
          'BROWSER_DATE_EXPLICIT_CONFIRMATION_DOM')
          assert((await page.getByTestId('automation-read-project').innerText()).trim() === input.projectNo,
            'BROWSER_DATE_FIXED_PROJECT_DOM')
        }
      }
      assert.equal(posts.length, 0, 'BROWSER_RECORD_SELECTION_MUTATION')
      assert.equal(await page.getByTestId(`automation-read-${activationFamily}-confirm`).isChecked(), false, 'BROWSER_AUTOMATIC_CONSENT_DEFAULT')
      assert.equal(await page.getByTestId(`automation-read-activate-${activationFamily}`).isDisabled(), true, 'BROWSER_AUTOMATIC_CONFIRM_REQUIRED')
      assert.equal(await page.getByTestId('automation-read-create-grant').count(), 0, 'BROWSER_RECORD_NO_MANUAL_GRANT')
      assert.equal(await page.getByTestId('automation-read-submit').count(), 0, 'BROWSER_RECORD_NO_IMPLICIT_SUBMIT')
      await page.getByTestId('automation-read-executions').fill('1')
      await page.getByTestId('automation-read-ttl').fill('15')
      await page.getByTestId(`automation-read-${activationFamily}-confirm`).check()
      assert.equal(posts.length, 0, 'BROWSER_RECORD_CONFIRM_IMPLICIT_MUTATION')
      if (screenshots) await page.getByTestId('automation-read-panel').screenshot({ path: screenshots.consent })
      const activated = waitData<{ activationId: string; grantId: string }>('POST', `${prefix}/${activationFamily}-activations`, 201)
      // Arm before POST: the real panel may issue detail immediately after its
      // own 201 parser completes, before our CDP reader returns the pair.
      const automaticGrant = waitData<{ grantId: string; purpose: string; status: string; selector: ReadSelector;
        projects: string[]; triggers: string[]; budget: ReadBudget; expiresAt: string; maxExecutions: number; usedExecutions: number }>(
        'GET', new RegExp(`^${prefix}/grants/[a-f0-9-]{36}$`))
      await page.getByTestId(`automation-read-activate-${activationFamily}`).click()
      const pair = await activated
      assert(isDeepStrictEqual(Object.keys(pair).sort(), ['activationId', 'grantId'])
        && uuidPattern.test(pair.activationId) && uuidPattern.test(pair.grantId), 'BROWSER_RECORD_ACTIVATION_PAIR')
      activationId = pair.activationId; grantId = pair.grantId; activationGrantId = pair.grantId
      await page.locator(`[data-testid="automation-read-activation-receipt"][data-activation-id="${activationId}"][data-grant-id="${grantId}"]`).waitFor()
      assert.equal(await page.getByTestId('automation-read-activation-receipt').getAttribute('data-activation-family'), activationFamily,
        'BROWSER_ACTIVATION_RECEIPT_FAMILY')
      await page.locator(`[data-testid="automation-read-current-grant"][data-grant-id="${grantId}"]`).waitFor()
      const persisted = await automaticGrant
      await panelSettled('automation-read-load')
      assert.equal(posts.length, 1, 'BROWSER_RECORD_SINGLE_ACTIVATION')
      assert.equal(posts[0].path, `${prefix}/${activationFamily}-activations`, 'BROWSER_AUTOMATIC_ACTIVATION_ROUTE')
      const body = posts[0].body as Record<string, unknown>
      const expectedBodyKeys = ['activationKey', 'expectedRuleRevision', 'budget', 'expiresAt', 'maxExecutions', 'projectNo', 'selector',
        ...(input.recordActivation ? ['expectedRecordCondition'] : []),
        ...(input.scheduleActivation && option.scheduleDefinition?.triggerType === 'schedule.date_field' ? ['expectedDateField'] : [])].sort()
      assert(isDeepStrictEqual(Object.keys(body).sort(), expectedBodyKeys)
        && typeof body.activationKey === 'string' && uuidPattern.test(body.activationKey)
        && isDeepStrictEqual(body.selector, option.selector) && body.projectNo === input.projectNo
        && body.maxExecutions === 1, 'BROWSER_RECORD_CLOSED_ACTIVATION_BODY')
      if (input.recordActivation) assert.equal(body.expectedRuleRevision, option.recordRuleRevision, 'BROWSER_RECORD_REVISION_CONSENT')
      if (input.recordActivation) assert(isDeepStrictEqual(body.expectedRecordCondition, option.recordCondition), 'BROWSER_RECORD_CONDITION_CONSENT')
      if (input.scheduleActivation) assert.equal(body.expectedRuleRevision, option.scheduleRuleRevision, 'BROWSER_SCHEDULE_REVISION_CONSENT')
      if (input.scheduleActivation && option.scheduleDefinition?.triggerType === 'schedule.date_field') {
        assert(isDeepStrictEqual(body.expectedDateField, option.scheduleDefinition.dateField), 'BROWSER_DATE_EXACT_FIELD_CONSENT_POST')
        assert(dateConsentLabel !== undefined
          && await page.getByTestId('automation-read-receipt-schedule-definition').isVisible()
          && (await page.getByTestId('automation-read-receipt-schedule-definition').innerText()).trim() === dateConsentLabel,
        'BROWSER_DATE_FROZEN_DEFINITION_RECEIPT')
        assert(await page.getByTestId('automation-read-receipt-schedule-revision').isVisible()
          && (await page.getByTestId('automation-read-receipt-schedule-revision').innerText()).trim()
            === `批准时规则版本：${option.scheduleRuleRevision}`, 'BROWSER_DATE_FROZEN_REVISION_RECEIPT')
        // Preserve the real options and the independently checked activation
        // command/DOM receipt for comparison with the later historical context.
        confirmedDateOrigin = structuredClone({ definition: option.scheduleDefinition, ruleRevision: option.scheduleRuleRevision! })
        dateFieldConsent = true
      }
      const approvedBudget = body.budget as ReadBudget
      assert(isDeepStrictEqual(Object.keys(approvedBudget).sort(), ['maxPages', 'maxReadCount', 'maxRows', 'timeoutMs']), 'BROWSER_RECORD_CLOSED_BUDGET')
      for (const key of ['maxRows', 'maxPages', 'maxReadCount', 'timeoutMs'] as const) {
        assert(Number.isSafeInteger(approvedBudget[key]) && approvedBudget[key] > 0
          && approvedBudget[key] <= option.budget[key], 'BROWSER_RECORD_FINITE_BUDGET')
      }
      assert(typeof body.expiresAt === 'string' && Number.isFinite(Date.parse(body.expiresAt))
        && new Date(body.expiresAt).toISOString() === body.expiresAt && Date.parse(body.expiresAt) > Date.now()
        && Date.parse(body.expiresAt) <= Date.now() + 16 * 60_000, 'BROWSER_RECORD_FINITE_EXPIRY')
      assert(persisted.grantId === grantId && persisted.purpose === 'automatic' && persisted.status === 'active'
        && isDeepStrictEqual(persisted.selector, option.selector) && isDeepStrictEqual(persisted.projects, [input.projectNo])
        && isDeepStrictEqual(persisted.triggers, [activationFamily]) && isDeepStrictEqual(persisted.budget, approvedBudget)
        && persisted.expiresAt === body.expiresAt && persisted.maxExecutions === 1 && persisted.usedExecutions === 0,
      'BROWSER_RECORD_AUTOMATIC_PURPOSE')
      await page.getByTestId('automation-read-current-grant-purpose').filter({ hasText: /Automatic (?:record|schedule) authorization|自动/u }).waitFor()
      assert.equal(await page.getByTestId('automation-read-submit').isDisabled(), true, 'BROWSER_RECORD_NO_MANUAL_START')
      assert.equal(await page.getByTestId(`automation-read-activate-${activationFamily}`).isDisabled(), true, 'BROWSER_AUTOMATIC_CONSENT_SPENT')
      await page.getByTestId('automation-read-new-activation').waitFor()
      await unchangedReads(beforeMountReads)
      const produced = await activationHook.afterActivate(activationId, grantId)
      assert(uuidPattern.test(produced.requestId), 'BROWSER_RECORD_PRODUCED_REQUEST')
      requestId = produced.requestId
      await unchangedReads(beforeMountReads)
      const grantsAfterRecord = waitData<{ items: Array<{ grantId: string; purpose: string }> }>('GET', `${prefix}/grants`)
      const requestsAfterRecord = waitData<{ items: Array<{ requestId: string; status: string }> }>('GET', `${prefix}/requests`)
      await page.getByTestId('automation-read-refresh-history').click()
      const [grantHistory, requestHistory] = await Promise.all([grantsAfterRecord, requestsAfterRecord])
      await panelSettled('automation-read-refresh-history')
      assert(grantHistory.items.some(item => item.grantId === grantId && item.purpose === 'automatic')
        && requestHistory.items.some(item => item.requestId === requestId && item.status === 'queued'), 'BROWSER_RECORD_QUEUED_HISTORY')
      const queued = waitData<RequestDetail>('GET', `${prefix}/requests/${requestId}`)
      await page.locator(`[data-testid="automation-read-open-request"][data-request-id="${requestId}"]`).click()
      const queuedDetail = await queued
      assert(queuedDetail.requestId === requestId && queuedDetail.status === 'queued' && queuedDetail.result === null,
        'BROWSER_RECORD_QUEUED_DETAIL')
      await page.locator(`[data-testid="automation-read-current-request"][data-request-id="${requestId}"]`).waitFor()
      await panelSettled('automation-read-load')
      assert.equal(posts.length, 1, 'BROWSER_RECORD_NO_BROWSER_SUBMIT')
      await unchangedReads(beforeMountReads)
    } else {
      assert(option?.allowedTriggers.includes('manual'), 'BROWSER_MANUAL_OPTION_REQUIRED')
      await page.getByTestId('automation-read-option').selectOption(option.selector.ruleId)
      assert.equal(posts.length, 0, 'BROWSER_SELECTION_MUTATION')
      assert.equal(await page.getByTestId('automation-read-create-grant').isDisabled(), true, 'BROWSER_GRANT_CONFIRM_REQUIRED')
      await page.getByTestId('automation-read-executions').fill('1')
      await page.getByTestId('automation-read-ttl').fill('15')
      await page.getByTestId('automation-read-grant-confirm').check()
      assert.equal(posts.length, 0, 'BROWSER_CONFIRM_IMPLICIT_MUTATION')
      const granted = waitData<{ grantId: string }>('POST', `${prefix}/grants`, 201)
      await page.getByTestId('automation-read-create-grant').click()
      const grantedData = await granted
      grantId = grantedData.grantId
      assert(uuidPattern.test(grantId), 'BROWSER_GRANT_ID')
      await page.locator(`[data-testid="automation-read-current-grant"][data-grant-id="${grantId}"]`).waitFor()
      assert.equal(posts.length, 1, 'BROWSER_GRANT_SEPARATE_FROM_SUBMIT')
      const grantBody = posts[0].body as Record<string, unknown>
      assert(isDeepStrictEqual(grantBody.selector, option.selector)
        && isDeepStrictEqual(grantBody.projects, [input.projectNo])
        && isDeepStrictEqual(grantBody.triggers, ['manual'])
        && grantBody.maxExecutions === 1 && Object.keys(grantBody).length === 6, 'BROWSER_FINITE_GRANT_BODY')
      const grantedBudget = grantBody.budget as ReadBudget
      for (const key of ['maxRows', 'maxPages', 'maxReadCount', 'timeoutMs'] as const) {
        assert(Number.isSafeInteger(grantedBudget[key]) && grantedBudget[key] > 0
          && grantedBudget[key] <= option.budget[key], 'BROWSER_FINITE_GRANT_BUDGET')
      }
      assert(typeof grantBody.expiresAt === 'string' && Number.isFinite(Date.parse(grantBody.expiresAt))
        && Date.parse(grantBody.expiresAt) > Date.now()
        && Date.parse(grantBody.expiresAt) <= Date.now() + 16 * 60_000, 'BROWSER_FINITE_GRANT_EXPIRY')
      // The caller also has its original eligible fixture rule. Switching the
      // visible selection must not silently execute this newly-created grant's
      // different rule; exercise the real DOM fix without creating another run.
      const alternate = initial.options.items.find(item => item.selector.ruleId !== selectedRuleId
        && item.allowedTriggers.includes('manual'))
      assert(alternate, 'BROWSER_ALTERNATE_RULE_REQUIRED')
      await page.getByTestId('automation-read-option').selectOption(alternate.selector.ruleId)
      assert.equal(await page.getByTestId('automation-read-submit').isDisabled(), true, 'BROWSER_DIFFERENT_SELECTED_RULE_START')
      await page.getByTestId('automation-read-current-grant-rule').filter({ hasText: option.ruleName }).waitFor()
      assert.equal(posts.length, 1, 'BROWSER_RULE_SWITCH_MUTATION')
      await page.getByTestId('automation-read-option').selectOption(option.selector.ruleId)
      assert.equal(await page.getByTestId('automation-read-submit').isEnabled(), true, 'BROWSER_MATCHING_SELECTED_RULE_START')
      await unchangedReads(beforeMountReads)
      const submitted = waitData<{ requestId: string; status: string }>('POST', `${prefix}/requests`, 202)
      await page.getByTestId('automation-read-submit').click()
      const submittedData = await submitted
      assert(uuidPattern.test(submittedData.requestId) && submittedData.status === 'queued', 'BROWSER_ENQUEUED_REQUEST')
      requestId = submittedData.requestId
      await page.getByTestId('automation-read-current-request').waitFor()
      assert.equal(posts.length, 2, 'BROWSER_SINGLE_MANUAL_SUBMIT')
      const submitBody = posts[1].body as Record<string, unknown>
      assert(submitBody.grantId === grantId && submitBody.projectNo === input.projectNo
        && typeof submitBody.invocationId === 'string' && uuidPattern.test(submitBody.invocationId)
        && Object.keys(submitBody).length === 3, 'BROWSER_SUBMIT_NARROW_BODY')
      await unchangedReads(beforeMountReads)
    }
    await input.afterSubmit(requestId, grantId)
    let afterDispatchReads = await nativeReads()
    assert(afterDispatchReads > beforeMountReads, 'BROWSER_NATIVE_SOURCE_NOT_EXECUTED')
    if (linkedRetryHook) {
      const parentRequestId = requestId, parentGrantId = grantId
      if (input.dateLinkedRetry) assert(parentGrantId === activationGrantId && dateFieldConsent && confirmedDateOrigin,
        'BROWSER_DATE_RETRY_DIRECT_ACTIVATION_PARENT')
      retryParentRequestId = parentRequestId
      const parentResponse = waitData<RequestDetail>('GET', `${prefix}/requests/${parentRequestId}`)
      await page.getByTestId('automation-read-refresh-request').click()
      const parent = await parentResponse
      assert(isDeepStrictEqual(Object.keys(parent).sort(), ['requestId', 'result', 'status'])
        && parent.requestId === parentRequestId && parent.status === 'outcome_unknown' && parent.result === null,
      'BROWSER_RETRY_PARENT_UNKNOWN')
      await page.getByTestId('automation-read-status').filter({ hasText: 'outcome_unknown' }).waitFor()
      await panelSettled('automation-read-load')
      assert.equal(await page.getByTestId('automation-read-result').count(), 0, 'BROWSER_UNKNOWN_NOT_PREVIEW')
      const observedResponse = waitData<ReadRetryContext>('GET', `${prefix}/requests/${parentRequestId}/retry-context`)
      await page.getByTestId('automation-read-load-retry').click()
      const observed = await observedResponse
      assert(isDeepStrictEqual(Object.keys(observed).sort(),
        [...(input.dateLinkedRetry ? ['dateScheduleOrigin'] : []), 'grant', 'nextAttempt', 'request'])
        && isDeepStrictEqual(Object.keys(observed.request).sort(),
          ['createdAt', 'finishedAt', 'grantId', 'projectNo', 'requestId', 'startedAt', 'status', 'trigger'])
        && isDeepStrictEqual(Object.keys(observed.grant).sort(),
          ['budget', 'createdAt', 'expiresAt', 'grantId', 'maxExecutions', 'projects', 'purpose', 'selector', 'status', 'triggers', 'updatedAt', 'usedExecutions']),
      'BROWSER_RETRY_CONTEXT_CLOSED')
      assert(observed.request.requestId === parentRequestId && observed.request.grantId === parentGrantId
        && observed.request.status === 'outcome_unknown' && observed.request.trigger === (input.dateLinkedRetry ? 'schedule' : 'manual')
        && observed.request.projectNo === input.projectNo && observed.grant.grantId === parentGrantId
        && observed.grant.purpose === (input.dateLinkedRetry ? 'automatic' : 'standalone') && observed.grant.maxExecutions === 1
        && observed.grant.usedExecutions === 1 && observed.nextAttempt === null
        && isDeepStrictEqual(observed.grant.selector, option!.selector)
        && isDeepStrictEqual(observed.grant.projects, [input.projectNo])
        && isDeepStrictEqual(observed.grant.triggers, [input.dateLinkedRetry ? 'schedule' : 'manual'])
        && isDeepStrictEqual(observed.grant.budget, (posts[0].body as { budget: ReadBudget }).budget),
      'BROWSER_RETRY_ORIGINAL_SCOPE')
      await page.locator(`[data-testid="automation-read-retry-context"][data-parent-request-id="${parentRequestId}"]`).waitFor()
      await panelSettled('automation-read-load')
      assert((await page.getByTestId('automation-read-retry-project').innerText()).includes(input.projectNo),
        'BROWSER_RETRY_PROJECT_DISPLAY')
      const displayedSelector = await page.getByTestId('automation-read-retry-selector').innerText()
      for (const value of Object.values(observed.grant.selector)) assert(displayedSelector.includes(value), 'BROWSER_RETRY_SELECTOR_DISPLAY')
      if (input.dateLinkedRetry) {
        const origin = observed.dateScheduleOrigin
        assert(origin && isDeepStrictEqual(Object.keys(origin).sort(), ['definition', 'ruleRevision'])
          && isDeepStrictEqual(origin, confirmedDateOrigin), 'BROWSER_DATE_RETRY_ORIGINAL_DEFINITION')
        const activationBody = posts[0].body as Record<string, unknown>
        assert(origin.ruleRevision === activationBody.expectedRuleRevision
          && isDeepStrictEqual(origin.definition.dateField, activationBody.expectedDateField), 'BROWSER_DATE_RETRY_ACTIVATION_CONFIRMATION')
        assert.equal(await page.getByTestId('automation-read-retry-date-definition').isVisible(), true, 'BROWSER_DATE_RETRY_DEFINITION_VISIBLE')
        assert(dateConsentLabel !== undefined
          && (await page.getByTestId('automation-read-retry-date-definition').innerText()).trim() === `原日期定义：${dateConsentLabel}`,
        'BROWSER_DATE_RETRY_EXACT_DEFINITION_DOM')
        assert.equal(await page.getByTestId('automation-read-retry-date-config').isVisible(), true, 'BROWSER_DATE_RETRY_CONFIG_VISIBLE')
        assert.equal((await page.getByTestId('automation-read-retry-date-config').locator('code').innerText()).trim(),
          JSON.stringify(origin.definition.config), 'BROWSER_DATE_RETRY_EXACT_CONFIG_DOM')
        assert.equal(await page.getByTestId('automation-read-retry-date-revision').isVisible(), true, 'BROWSER_DATE_RETRY_REVISION_VISIBLE')
        assert.equal((await page.getByTestId('automation-read-retry-date-revision').innerText()).trim(),
          `原规则版本：${origin.ruleRevision}`, 'BROWSER_DATE_RETRY_EXACT_REVISION_DOM')
        const dateWarning = await page.getByTestId('automation-read-retry-date-warning').innerText()
        assert(dateWarning.includes('仅按原固定项目重新读取一次')
          && dateWarning.includes('不重新扫描或判断记录日期') && dateWarning.includes('不恢复原计划、期限或次数')
          && dateWarning.includes('原读取可能已经发生或仍在进行') && dateWarning.includes('新预算不补发或重置来源的一次性读取许可')
          && dateWarning.includes('实际再次读取仍需另一份独立有效许可') && dateWarning.includes('日期子尝试不能继续延链重试'),
        'BROWSER_DATE_RETRY_NEW_READ_WARNING')
        assert.equal(await page.getByTestId('automation-read-retry-date-warning').isVisible(), true, 'BROWSER_DATE_RETRY_WARNING_VISIBLE')
        assert.equal(posts.filter(post => post.path === `${prefix}/grants` || post.path === `${prefix}/requests`).length, 0,
          'BROWSER_DATE_RETRY_NO_MANUAL_MUTATIONS')
      }
      const warning = await page.getByTestId('automation-read-retry-warning').innerText()
      assert(/先前读取可能已经发生|earlier read may have occurred/u.test(warning)
        && /取消不保证|cancellation does not guarantee/u.test(warning)
        && /新预算|new budget/u.test(warning), 'BROWSER_RETRY_NEW_READ_WARNING')
      assert.equal(await page.getByTestId('automation-read-retry-confirm').isChecked(), false, 'BROWSER_RETRY_CONSENT_DEFAULT')
      assert.equal(await page.getByTestId('automation-read-retry').isDisabled(), true, 'BROWSER_RETRY_CONSENT_REQUIRED')
      assert.equal(posts.length, beforeRetryPosts, 'BROWSER_RETRY_CONTEXT_NO_POST')
      for (const key of ['maxRows', 'maxPages', 'maxReadCount', 'timeoutMs'] as const) {
        assert.equal(await page.getByTestId(`automation-read-retry-budget-${key}`).inputValue(),
          String(observed.grant.budget[key]), 'BROWSER_RETRY_REFERENCE_BUDGET')
      }
      await page.getByTestId('automation-read-retry-ttl').fill('15')
      await page.getByTestId('automation-read-retry-confirm').check()
      assert.equal(posts.length, beforeRetryPosts, 'BROWSER_RETRY_CONFIRM_NO_POST')
      if (screenshots?.retryConsent) await page.getByTestId('automation-read-panel').screenshot({ path: screenshots.retryConsent })
      await unchangedReads(afterDispatchReads)
      const submittedRetry = waitData<ReadRetryRef>('POST', `${prefix}/requests/${parentRequestId}/retry`, 202)
      await page.getByTestId('automation-read-retry').click()
      const child = await submittedRetry
      assert(isDeepStrictEqual(Object.keys(child).sort(), ['grantId', 'parentRequestId', 'requestId', 'status'])
        && child.parentRequestId === parentRequestId && uuidPattern.test(child.requestId) && uuidPattern.test(child.grantId)
        && child.requestId !== parentRequestId && child.grantId !== parentGrantId && child.status === 'queued',
      'BROWSER_RETRY_CHILD_RECEIPT')
      await page.locator(`[data-testid="automation-read-retry-receipt"][data-parent-request-id="${parentRequestId}"][data-request-id="${child.requestId}"][data-grant-id="${child.grantId}"]`).waitFor()
      await page.locator(`[data-testid="automation-read-current-request"][data-request-id="${child.requestId}"]`).waitFor()
      await panelSettled('automation-read-load')
      const retryPosts = posts.filter(post => post.path === `${prefix}/requests/${parentRequestId}/retry`)
      assert.equal(retryPosts.length, 1, 'BROWSER_RETRY_ONE_CHILD_POST')
      assert.equal(posts.length, beforeRevokePosts, 'BROWSER_RETRY_NO_EXTRA_POST')
      const body = retryPosts[0].body as Record<string, unknown>
      assert(isDeepStrictEqual(Object.keys(body).sort(), ['acknowledgeNewRead', 'budget', 'expiresAt', 'retryKey'])
        && body.acknowledgeNewRead === true && typeof body.retryKey === 'string' && uuidPattern.test(body.retryKey)
        && isDeepStrictEqual(body.budget, observed.grant.budget), 'BROWSER_RETRY_CLOSED_COMMAND')
      assert(typeof body.expiresAt === 'string' && Number.isFinite(Date.parse(body.expiresAt))
        && new Date(body.expiresAt).toISOString() === body.expiresAt && Date.parse(body.expiresAt) > Date.now()
        && Date.parse(body.expiresAt) <= Date.now() + 16 * 60_000, 'BROWSER_RETRY_FINITE_NEW_EXPIRY')
      await unchangedReads(afterDispatchReads)
      linkedRetry = { parentRequestId, parentGrantId, retryPosts: 1,
        ...(input.dateLinkedRetry ? { dateLinkedRetryConsent: true as const } : {}) }
      requestId = child.requestId; grantId = child.grantId
      await linkedRetryHook.afterRetry(requestId, grantId, parentRequestId)
      const afterRetryReads = await nativeReads()
      assert(afterRetryReads > afterDispatchReads, 'BROWSER_RETRY_NEW_NATIVE_READ')
      afterDispatchReads = afterRetryReads
    }
    const refresh = waitData<RequestDetail>('GET', `${prefix}/requests/${requestId}`)
    await page.getByTestId('automation-read-refresh-request').click()
    const detail = await refresh
    assert(detail.requestId === requestId && detail.status === 'succeeded' && detail.result, 'BROWSER_PREVIEW_SUCCEEDED')
    const preview = detail.result
    assert(preview.status === 'ready' && preview.canApply === false
      && isDeepStrictEqual(preview.counts, { add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }), 'BROWSER_READONLY_PREVIEW')
    await page.getByTestId('automation-read-result').filter({ hasText: 'ready' })
      .filter({ hasText: '1 / 0 / 0 / 0 / 0' }).filter({ hasText: 'canApply: false' }).waitFor()
    if (screenshots) await page.getByTestId('automation-read-panel').screenshot({ path: screenshots.preview })
    await unchangedReads(afterDispatchReads)
    const historyGrants = waitData<{ items: Array<{ grantId: string; purpose: string }> }>('GET', `${prefix}/grants`)
    const historyRequests = waitData('GET', `${prefix}/requests`)
    await page.getByTestId('automation-read-refresh-history').click()
    const [sharedGrantHistory] = await Promise.all([historyGrants, historyRequests])
    if (activationHook) {
      assert(sharedGrantHistory.items.some(item => item.grantId === activationGrantId && item.purpose === 'automatic'), 'BROWSER_RECORD_HISTORY_PURPOSE')
    }
    if (linkedRetry) assert(sharedGrantHistory.items.some(item => item.grantId === grantId && item.purpose === 'retry'),
      'BROWSER_RETRY_HISTORY_PURPOSE')
    await panelSettled('automation-read-refresh-history')
    await painted(page)
    assert.equal(posts.length, beforeRevokePosts, 'BROWSER_HISTORY_MUTATION')
    await unchangedReads(afterDispatchReads)

    // Change only real session storage, never Vue state. The focus/storage path
    // is the application's existing cross-tab session boundary.
    const beforeSwitchRequests = apiGets + posts.length
    await page.evaluate(() => {
      localStorage.removeItem('auth_token')
      window.dispatchEvent(new Event('focus'))
    })
    await page.getByTestId('automation-read-result').waitFor({ state: 'detached' })
    await painted(page)
    assert(!(await page.locator('body').innerText()).includes(grantId)
      && !(await page.locator('body').innerText()).includes(requestId), 'BROWSER_LOGOUT_PRIVATE_STATE')
    if (activationId) assert(!(await page.locator('body').innerText()).includes(activationId), 'BROWSER_LOGOUT_ACTIVATION_STATE')
    assert.equal(await page.locator(`[data-grant-id="${grantId}"], [data-request-id="${requestId}"]`).count(), 0,
      'BROWSER_LOGOUT_PRIVATE_DOM')
    if (linkedRetry) assert.equal(await page.locator(`[data-grant-id="${linkedRetry.parentGrantId}"], [data-request-id="${linkedRetry.parentRequestId}"], [data-parent-request-id="${linkedRetry.parentRequestId}"]`).count(), 0,
      'BROWSER_LOGOUT_RETRY_PARENT_DOM')
    assert.equal(await page.locator('[data-testid="automation-read-option"], [data-testid="automation-read-current-grant"], '
      + '[data-testid="automation-read-current-request"], [data-testid="automation-read-grant-row"], '
      + '[data-testid="automation-read-request-row"], [data-testid="automation-read-activation-receipt"], '
      + '[data-testid="automation-read-retry-context"], [data-testid="automation-read-retry-recovery"], '
      + '[data-testid="automation-read-retry-receipt"]').count(), 0, 'BROWSER_LOGOUT_SELECTION_HISTORY_CLEARED')
    assert.equal(apiGets + posts.length, beforeSwitchRequests, 'BROWSER_LOGOUT_REQUEST')
    currentToken = input.otherToken
    await page.evaluate(token => {
      localStorage.setItem('auth_token', token)
      window.dispatchEvent(new Event('focus'))
    }, input.otherToken)
    await painted(page)
    assert.equal(apiGets + posts.length, beforeSwitchRequests, 'BROWSER_SWITCH_REQUEST')
    const other = await load('other')
    assert(other.options.items.length === 0 && other.grants.items.length === 0
      && other.requests.items.length === 0, 'BROWSER_NONOWNER_PRIVATE_HISTORY')
    assert(!(await page.locator('body').innerText()).includes(grantId)
      && !(await page.locator('body').innerText()).includes(requestId), 'BROWSER_SWITCH_PRIVATE_STATE')
    assert.equal(await page.locator(`[data-grant-id="${grantId}"], [data-request-id="${requestId}"]`).count(), 0,
      'BROWSER_SWITCH_PRIVATE_DOM')
    assert.equal(posts.filter(post => post.nonOwner).length, 0, 'BROWSER_NONOWNER_MUTATION')
    await unchangedReads(afterDispatchReads)

    currentToken = input.ownerToken
    await page.evaluate(token => {
      localStorage.setItem('auth_token', token)
      window.dispatchEvent(new Event('focus'))
    }, input.ownerToken)
    await load('restored')
    const restored = waitData<RequestDetail>('GET', `${prefix}/requests/${requestId}`)
    await page.locator(`[data-testid="automation-read-open-request"][data-request-id="${requestId}"]`).click()
    await restored
    await page.getByTestId('automation-read-result').waitFor()
    await input.beforeDenial()
    denialExpected = true
    const refusal = waitApi(page, 'GET', `${prefix}/requests/${requestId}`)
    await page.getByTestId('automation-read-refresh-request').click()
    const denied = await refusal
    assert.equal(denied.status(), 403, 'BROWSER_REVOKED_OWNER_STATUS')
    // The production client deliberately aborts at 401/403 before consuming a
    // potentially private error body. Do not require CDP to retain that aborted
    // stream; the real status and cleared UI are the browser contract here.
    await page.getByTestId('automation-read-error').waitFor()
    await page.getByTestId('automation-read-result').waitFor({ state: 'detached' })
    await painted(page)
    assert.equal(await page.locator(`[data-grant-id="${grantId}"], [data-request-id="${requestId}"]`).count(), 0,
      'BROWSER_REVOKED_OWNER_PRIVATE_DOM')
    await unchangedReads(afterDispatchReads)
    assert.equal(posts.length, beforeRevokePosts, 'BROWSER_OBSERVATION_NOT_EXECUTION')
    assert.equal(ownerDeniedGets, 1, 'BROWSER_REVOKED_OWNER_REFUSAL_COUNT')

    // The caller restores live owner/admin authority but stops the actual
    // execution runtime. Observation/revocation remains reachable without an
    // options call or recreating an execution-capable UI context.
    await input.beforeHistoryOnly()
    const optionsBeforeStop = transportFacts.filter(fact => fact.kind === 'options').length
    const stoppedGrants = waitData<{ items: Array<{ grantId: string; purpose: string }> }>('GET', `${prefix}/grants`)
    const stoppedRequests = waitData<{ items: Array<{ requestId: string }> }>('GET', `${prefix}/requests`)
    await page.getByTestId('automation-read-history-only').click()
    const [grantHistory, requestHistory] = await Promise.all([stoppedGrants, stoppedRequests])
    assert(grantHistory.items.some(item => item.grantId === grantId)
      && requestHistory.items.some(item => item.requestId === requestId), 'BROWSER_STOPPED_HISTORY_REQUIRED')
    if (activationHook) {
      assert(grantHistory.items.some(item => item.grantId === activationGrantId && item.purpose === 'automatic'), 'BROWSER_RECORD_STOPPED_HISTORY_PURPOSE')
    }
    assert.equal(await page.getByTestId('automation-read-option').count(), 0, 'BROWSER_STOPPED_NO_OPTIONS_UI')
    const stoppedGrant = waitData<{ grantId: string; status: string; purpose: string; triggers: string[];
      projects: string[]; maxExecutions: number; usedExecutions: number }>('GET', `${prefix}/grants/${grantId}`)
    await page.locator(`[data-testid="automation-read-open-grant"][data-grant-id="${grantId}"]`).click()
    const restoredGrant = await stoppedGrant
    assert(restoredGrant.grantId === grantId && restoredGrant.status === 'active', 'BROWSER_STOPPED_GRANT_VISIBLE')
    if (activationHook && !linkedRetry) assert.equal(restoredGrant.purpose, 'automatic', 'BROWSER_RECORD_STOPPED_DETAIL_PURPOSE')
    if (linkedRetry) assert.equal(restoredGrant.purpose, 'retry', 'BROWSER_RETRY_STOPPED_DETAIL_PURPOSE')
    if (input.dateLinkedRetry) assert(isDeepStrictEqual(restoredGrant.triggers, ['schedule'])
      && isDeepStrictEqual(restoredGrant.projects, [input.projectNo]) && restoredGrant.maxExecutions === 1
      && restoredGrant.usedExecutions === 1, 'BROWSER_DATE_RETRY_CHILD_GRANT_SCOPE')
    assert.equal(await page.getByTestId('automation-read-submit').isDisabled(), true, 'BROWSER_STOPPED_START_DISABLED')
    const revokeResponse = waitData<{ grantId: string; status: string }>('POST', `${prefix}/grants/${grantId}/revoke`)
    await page.getByTestId('automation-read-revoke').click()
    const revoked = await revokeResponse
    assert(revoked.grantId === grantId && revoked.status === 'revoked', 'BROWSER_STOPPED_GRANT_REVOKED')
    await page.getByTestId('automation-read-current-grant').filter({ hasText: 'revoked' }).waitFor()
    await painted(page)
    assert.equal(transportFacts.filter(fact => fact.kind === 'options').length, optionsBeforeStop,
      'BROWSER_STOPPED_IMPLICIT_OPTIONS')
    assert.equal(posts.length, beforeRevokePosts + 1, 'BROWSER_STOPPED_ONLY_REVOCATION')
    if (activationHook) {
      assert.equal(posts.filter(post => post.path === `${prefix}/grants` || post.path === `${prefix}/requests`).length, 0,
        'BROWSER_RECORD_NO_MANUAL_MUTATIONS')
      assert.equal(posts.filter(post => post.path === `${prefix}/${activationFamily}-activations`).length, 1, 'BROWSER_AUTOMATIC_ONE_CONSENT_POST')
      assert.equal(posts.filter(post => post.path === `${prefix}/${activationFamily === 'record' ? 'schedule' : 'record'}-activations`).length, 0,
        'BROWSER_AUTOMATIC_NO_CROSS_FAMILY_POST')
    }
    await unchangedReads(afterDispatchReads)
    const cloneObservation = await page.evaluate(async () => {
      const drain = (window as unknown as {
        __automationReadDrainClones(): Promise<{
          eligible: number; completed: number; bytes: number; active: number; failures: string[]
        }>
      }).__automationReadDrainClones
      if (typeof drain !== 'function') throw new Error('BROWSER_CLONE_OBSERVER_MISSING')
      return await drain()
    })
    // Finish all successful native observations before checking the independent
    // transport failures and before closing the browser. No clone body is used
    // as evidence in place of responseData's actual CDP envelope assertions.
    assert.deepEqual(cloneObservation.failures, [], 'BROWSER_CLONE_OBSERVATION_FAILED')
    assert.equal(cloneObservation.active, 0, 'BROWSER_CLONE_OBSERVATION_PENDING')
    assert.equal(cloneObservation.completed, cloneObservation.eligible, 'BROWSER_CLONE_OBSERVATION_INCOMPLETE')
    assert.equal(cloneObservation.eligible, transportFacts.filter(fact => fact.status >= 200 && fact.status < 300).length,
      'BROWSER_CLONE_OBSERVATION_COVERAGE')
    assert(cloneObservation.eligible > 0 && cloneObservation.eligible <= 128
      && cloneObservation.bytes > 0 && cloneObservation.bytes <= 8 * 1024 * 1024, 'BROWSER_CLONE_OBSERVATION_BOUNDS')
    assert.equal(pageErrors, 0, 'BROWSER_PAGE_ERRORS')
    assert.equal(unexpected.length, 0, `BROWSER_UNEXPECTED_${unexpected[0] ?? 'NONE'}`)
    return {
      grantId, requestId, preview,
      ...(linkedRetry ? { linkedRetry } : {}),
      ...(screenshots ? { screenshots } : {}),
      ...(activationId && input.recordActivation ? { recordActivation: { activationId,
        activationPosts: posts.filter(post => post.path === `${prefix}/record-activations`).length, automaticPurpose: true as const } } : {}),
      ...(activationId && input.scheduleActivation ? { scheduleActivation: { activationId,
        activationPosts: posts.filter(post => post.path === `${prefix}/schedule-activations`).length, automaticPurpose: true as const,
        ...(dateFieldConsent ? { dateFieldConsent: true as const } : {}) } } : {}),
      ...(input.authoring ? { authoredRuleId: selectedRuleId, publicCrud: {
        creates: crud.filter(call => call.method === 'POST').length,
        updates: crud.filter(call => call.method === 'PATCH').length,
        reads: crud.filter(call => call.method === 'GET').length, defaultTenantHint: true as const,
      } } : {}),
      counts: { apiGets, apiPosts: posts.length,
        grantPosts: posts.filter(post => post.path === `${prefix}/grants`).length,
        submitPosts: posts.filter(post => post.path === `${prefix}/requests`).length,
        revokePosts: posts.filter(post => post.path === `${prefix}/grants/${grantId}/revoke`).length,
        ownerDeniedGets, nonOwnerPosts: posts.filter(post => post.nonOwner).length,
        unexpectedRequests: unexpected.length, pageErrors },
      evidence: { realChromium: true, realComponent: true, realApiProxy: true,
        mountNoRequests: true, explicitGrantBeforeSubmit: true, selectedRuleBound: true, readonlyPreview: true,
        metadataRefreshNoSourceReads: true, noScopeHeaders: true, sessionCleared: true,
        otherOwnerEmpty: true, revokedOwnerDenied: true, stoppedRuntimeManagement: true },
    }
  } finally {
    try { await browser?.close() }
    finally {
      try { await vite?.close() }
      finally {
        const cleanupTarget = ownedCachePath(await realpath(cacheDir))
        assert(path.dirname(cleanupTarget) === canonicalParent
          && path.basename(cleanupTarget).startsWith('automation-read-browser-'), 'BROWSER_CACHE_CLEANUP_SCOPE')
        await rm(cleanupTarget, { recursive: true, force: true })
      }
    }
  }
}
