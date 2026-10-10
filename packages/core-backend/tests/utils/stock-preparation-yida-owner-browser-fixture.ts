/// <reference lib="dom" />

// Isolated real Vue owner or parent preview panel, not the full Workbench/login/product bundle.
// Vite proxies all API requests to the caller's actual JWT/core/PG listener.
// Chromium routes enforce the origin firewall and test-local request association
// admission; they never fulfill or change API requests/responses.
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Browser, BrowserContext, Page, Request as BrowserRequest, Response as BrowserResponse } from '@playwright/test'
import type { Plugin, ViteDevServer } from '../../../../apps/web/node_modules/vite'
import type { Data, Input } from './stock-preparation-yida-owner-http-fixture'

const root = path.resolve(__dirname, '..', '..', '..', '..')
const webRoot = path.join(root, 'apps/web'), prefix = '/api/integration/yida-owner-send'
const htmlPath = '/__synthetic-yida-owner-browser'
const diagnosticErrorCodes: readonly string[] = [
  'UNAUTHORIZED', 'NOT_FOUND', 'YIDA_OWNER_HTTP_INPUT', 'YIDA_OWNER_HTTP_DENIED', 'YIDA_OWNER_HTTP_UNAVAILABLE',
  'YIDA_OWNER_RUNTIME_INPUT', 'YIDA_OWNER_RUNTIME_DISABLED', 'YIDA_OWNER_RUNTIME_INACTIVE', 'YIDA_OWNER_RUNTIME_UNAVAILABLE',
  'YIDA_OWNER_RUNTIME_CANCELLED', 'YIDA_SEND_APPROVAL_INPUT', 'YIDA_SEND_APPROVAL_NOT_FOUND', 'YIDA_SEND_APPROVAL_CONFLICT',
  'YIDA_SEND_APPROVAL_EXPIRED', 'YIDA_SEND_APPROVAL_REVOKED', 'YIDA_SEND_APPROVAL_CANCELLED', 'YIDA_SEND_APPROVAL_UNAVAILABLE',
  'YIDA_OWNER_RESPONSE_INVALID', 'YIDA_OWNER_INPUT_INVALID', 'YIDA_OWNER_SESSION_CHANGED', 'YIDA_OWNER_CANCELLED', 'YIDA_OWNER_UNAVAILABLE',
  'YIDA_INITIALIZATION_INPUT', 'YIDA_INITIALIZATION_DENIED', 'YIDA_INITIALIZATION_CONFLICT',
  'YIDA_INITIALIZATION_INACTIVE', 'YIDA_INITIALIZATION_CANCELLED', 'YIDA_INITIALIZATION_UNAVAILABLE',
  'YIDA_INITIALIZATION_RESPONSE_INVALID', 'YIDA_INITIALIZATION_INPUT_INVALID',
  'YIDA_INITIALIZATION_STATE_UNCONFIRMED', 'YIDA_INITIALIZATION_SESSION_CHANGED',
]
export type ApiRequest = { method: string; path: string; body: unknown; correctSession: boolean; scopeHeaders: boolean }
type Gate = { reached: Promise<void>; open: Promise<void>; enter(): void; release(): void; status: number | null; bytes: number }
type CapturedApiResponse = { request: BrowserRequest; status: number; headers: IncomingMessage['headers']; bodyBytes: Buffer }
type ApiObservation = Promise<BrowserResponse> & { cancel(): void; readonly bound: boolean }
type ApiDiagnostic = {
  ordinal: number
  operation: 'draft' | 'preview' | 'approval' | 'submission' | 'observation' | 'revocation' | 'initialization' | 'other'
  pathTemplate: '/drafts' | '/preview' | '/approvals' | '/submissions' | '/approvals/:grant' | '/approvals/:grant/revoke' | '/initialization' | 'other'
  method: 'GET' | 'POST' | 'other'; requestObserved: boolean; nativeConfirmed: boolean
  upstreamStatus: number | null; upstreamBodyBytes: number | null; upstreamContentLength: number | 'invalid' | null
  upstreamContentTypeJson: boolean | null; upstreamComplete: boolean | null
  upstreamTransferEncoding: 'none' | 'chunked' | 'identity' | 'other' | null
  upstreamContentEncoding: 'none' | 'identity' | 'gzip' | 'deflate' | 'br' | 'other' | null
  downstreamFinished: boolean; downstreamCloseBeforeFinish: boolean; downstreamDestroyed: boolean | null
  browserFailure: 'none' | 'aborted' | 'unknown'; hasResponse: boolean; requestFinished: boolean
  settlement: 'pending' | 'resolved' | 'failed' | 'cancelled' | 'closed' | 'timeout'; elapsedMs: number
  phaseElapsedMs: { request: number | null; native: number | null; upstreamHeaders: number | null; upstreamEnd: number | null;
    browserResponse: number | null; browserFinished: number | null; browserFailed: number | null;
    downstreamFinish: number | null; downstreamClose: number | null; settled: number | null }
}
const diagnosticPathTemplates: Record<ApiDiagnostic['operation'], ApiDiagnostic['pathTemplate']> = {
  draft: '/drafts', preview: '/preview', approval: '/approvals', submission: '/submissions', observation: '/approvals/:grant',
  revocation: '/approvals/:grant/revoke', initialization: '/initialization', other: 'other',
}
const responseBodies = new WeakMap<BrowserResponse, CapturedApiResponse>()
function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error('YIDA_OWNER_BROWSER_' + code)
}
function gate(): Gate {
  let enter!: () => void, release!: () => void
  const reached = new Promise<void>(resolve => { enter = resolve }), open = new Promise<void>(resolve => { release = resolve })
  return { reached, open, enter, release, status: null, bytes: 0 }
}
function diagnosticOperation(fullPath: string): ApiDiagnostic['operation'] {
  if (fullPath === prefix + '/initialization') return 'initialization'
  if (fullPath === prefix + '/drafts') return 'draft'
  if (fullPath === prefix + '/preview') return 'preview'
  if (fullPath === prefix + '/approvals') return 'approval'
  if (fullPath === prefix + '/submissions') return 'submission'
  if (fullPath.startsWith(prefix + '/approvals/')) return fullPath.endsWith('/revoke') ? 'revocation' : 'observation'
  return 'other'
}
// Private bytes belong to the actual Request, never to a historical URL cache.
// Transport completion does not assert that Vue accepted/applied the response.
function createYidaOwnerResponseCapture() {
  type Observer = { method: string; fullPath: string; request?: BrowserRequest; response?: BrowserResponse;
    capture?: CapturedApiResponse; finished: boolean; resolve(response: BrowserResponse): void; reject(error: Error): void;
    timeout?: ReturnType<typeof setTimeout>; diagnostic: { value: ApiDiagnostic; startedAt: number; endedAt?: number } }
  const waiting = new Set<Observer>(), active = new Map<BrowserRequest, Observer>()
  const diagnosticRows: Observer['diagnostic'][] = [], diagnosticRequests = new WeakMap<BrowserRequest, Observer['diagnostic']>()
  let closed = false
  function elapsed(diagnostic: Observer['diagnostic'], at = Date.now()) {
    return Math.min(86400000, Math.max(0, at - diagnostic.startedAt))
  }
  function phase(diagnostic: Observer['diagnostic'], key: keyof ApiDiagnostic['phaseElapsedMs']) {
    diagnostic.value.phaseElapsedMs[key] = elapsed(diagnostic)
  }
  function fail(observer: Observer, code: string) {
    if (observer.diagnostic.value.settlement === 'pending') {
      observer.diagnostic.endedAt = Date.now()
      phase(observer.diagnostic, 'settled')
      observer.diagnostic.value.settlement = code === 'OBSERVER_CANCELLED' ? 'cancelled' : code === 'OBSERVER_CLOSED' ? 'closed'
        : code === 'ACTUAL_RESPONSE_TIMEOUT' ? 'timeout' : 'failed'
    }
    waiting.delete(observer)
    if (observer.request) active.delete(observer.request)
    clearTimeout(observer.timeout)
    observer.reject(new Error('YIDA_OWNER_BROWSER_' + code))
  }
  function complete(observer: Observer) {
    if (!observer.finished || !observer.response || !observer.capture) return
    if (observer.response.request() !== observer.request || observer.capture.request !== observer.request) {
      fail(observer, 'REQUEST_CAPTURE_MISMATCH'); return
    }
    active.delete(observer.request!)
    clearTimeout(observer.timeout)
    responseBodies.set(observer.response, observer.capture)
    observer.diagnostic.endedAt = Date.now(); observer.diagnostic.value.settlement = 'resolved'
    phase(observer.diagnostic, 'settled')
    observer.resolve(observer.response)
  }
  return {
    observe(method: string, fullPath: string): ApiObservation {
      check(!closed, 'RESPONSE_CAPTURE_CLOSED')
      check(![...waiting, ...active.values()].some(item => item.method === method && item.fullPath === fullPath), 'ONE_ACTIVE_OBSERVER_REQUIRED')
      let resolve!: Observer['resolve'], reject!: Observer['reject']
      const promise = new Promise<BrowserResponse>((yes, no) => { resolve = yes; reject = no })
      const operation = diagnosticOperation(fullPath)
      const diagnostic: Observer['diagnostic'] = { startedAt: Date.now(), value: {
        ordinal: diagnosticRows.length + 1, operation, pathTemplate: diagnosticPathTemplates[operation],
        method: method === 'GET' || method === 'POST' ? method : 'other',
        requestObserved: false, nativeConfirmed: false, upstreamStatus: null, upstreamBodyBytes: null, upstreamContentLength: null,
        upstreamContentTypeJson: null, upstreamComplete: null, upstreamTransferEncoding: null, upstreamContentEncoding: null,
        downstreamFinished: false, downstreamCloseBeforeFinish: false, downstreamDestroyed: null,
        browserFailure: 'none', hasResponse: false, requestFinished: false, settlement: 'pending', elapsedMs: 0,
        phaseElapsedMs: { request: null, native: null, upstreamHeaders: null, upstreamEnd: null, browserResponse: null,
          browserFinished: null, browserFailed: null, downstreamFinish: null, downstreamClose: null, settled: null },
      } }
      diagnosticRows.push(diagnostic)
      const observer: Observer = { method, fullPath, finished: false, resolve, reject, diagnostic }
      waiting.add(observer)
      observer.timeout = setTimeout(() => fail(observer, 'ACTUAL_RESPONSE_TIMEOUT'), 20000)
      // Abort/cleanup can precede the caller's await, but must still reject it.
      void promise.catch(() => {})
      return Object.defineProperties(promise, {
        cancel: { value: () => fail(observer, 'OBSERVER_CANCELLED') },
        bound: { get: () => observer.request !== undefined },
      }) as ApiObservation
    },
    requested(request: BrowserRequest) {
      const url = new URL(request.url()), fullPath = url.pathname + url.search
      const observer = [...waiting].find(item => item.method === request.method() && item.fullPath === fullPath)
      if (!observer) return
      waiting.delete(observer); observer.request = request; active.set(request, observer)
      observer.diagnostic.startedAt = Date.now(); observer.diagnostic.value.requestObserved = true
      phase(observer.diagnostic, 'request')
      diagnosticRequests.set(request, observer.diagnostic)
    },
    nativeConfirmed(request: BrowserRequest) {
      const diagnostic = diagnosticRequests.get(request)
      if (diagnostic) { diagnostic.value.nativeConfirmed = true; phase(diagnostic, 'native') }
    },
    upstream(request: BrowserRequest, status: number, headers: IncomingMessage['headers'], complete: boolean, bodyBytes?: number) {
      const diagnostic = diagnosticRequests.get(request)
      if (!diagnostic) return
      const length = headers['content-length']
      diagnostic.value.upstreamStatus = status
      diagnostic.value.upstreamBodyBytes = bodyBytes ?? null
      diagnostic.value.upstreamContentLength = length === undefined ? null
        : typeof length === 'string' && /^[0-9]+$/u.test(length) && Number.isSafeInteger(Number(length)) ? Number(length) : 'invalid'
      const contentType = headers['content-type'], transfer = headers['transfer-encoding']?.toLowerCase().trim()
      const encoding = headers['content-encoding']?.toLowerCase().trim()
      diagnostic.value.upstreamContentTypeJson = typeof contentType === 'string' && /^application\/json(?:\s*;|$)/iu.test(contentType)
      diagnostic.value.upstreamTransferEncoding = transfer === undefined ? 'none' : transfer === 'chunked' || transfer === 'identity' ? transfer : 'other'
      diagnostic.value.upstreamContentEncoding = encoding === undefined ? 'none'
        : encoding === 'identity' || encoding === 'gzip' || encoding === 'deflate' || encoding === 'br' ? encoding : 'other'
      diagnostic.value.upstreamComplete = complete
      phase(diagnostic, bodyBytes === undefined ? 'upstreamHeaders' : 'upstreamEnd')
    },
    upstreamBytes(request: BrowserRequest, bodyBytes: number) {
      const diagnostic = diagnosticRequests.get(request)
      if (diagnostic) diagnostic.value.upstreamBodyBytes = bodyBytes
    },
    downstream(request: BrowserRequest, event: 'finish' | 'close', destroyed: boolean) {
      const diagnostic = diagnosticRequests.get(request)
      if (!diagnostic) return
      diagnostic.value.downstreamDestroyed = destroyed
      if (event === 'finish') { diagnostic.value.downstreamFinished = true; phase(diagnostic, 'downstreamFinish') }
      else { diagnostic.value.downstreamCloseBeforeFinish = !diagnostic.value.downstreamFinished; phase(diagnostic, 'downstreamClose') }
    },
    browserFailed(request: BrowserRequest, failure: 'aborted' | 'unknown') {
      const diagnostic = diagnosticRequests.get(request)
      if (diagnostic) { diagnostic.value.browserFailure = failure; phase(diagnostic, 'browserFailed') }
    },
    captured(request: BrowserRequest, status: number, headers: IncomingMessage['headers'], bodyBytes: Buffer) {
      const observer = active.get(request)
      if (!observer) return
      observer.capture = { request, status, headers, bodyBytes }; complete(observer)
    },
    responded(response: BrowserResponse) {
      const diagnostic = diagnosticRequests.get(response.request())
      if (diagnostic) { diagnostic.value.hasResponse = true; phase(diagnostic, 'browserResponse') }
      const observer = active.get(response.request())
      if (observer) { observer.response = response; complete(observer) }
    },
    finished(request: BrowserRequest) {
      const diagnostic = diagnosticRequests.get(request)
      if (diagnostic) { diagnostic.value.requestFinished = true; phase(diagnostic, 'browserFinished') }
      const observer = active.get(request)
      if (observer) { observer.finished = true; complete(observer) }
    },
    failed(request: BrowserRequest, code = 'ACTUAL_REQUEST_FAILED') {
      const observer = active.get(request)
      if (observer) fail(observer, code)
    },
    close() { closed = true; for (const observer of [...waiting, ...active.values()]) fail(observer, 'OBSERVER_CLOSED') },
    diagnostics(): ApiDiagnostic[] {
      return diagnosticRows.map(row => ({ ...row.value,
        phaseElapsedMs: { ...row.value.phaseElapsedMs }, elapsedMs: elapsed(row, row.endedAt ?? Date.now()),
      }))
    },
  }
}
function createBrowserRequestBridge(failed: (request: BrowserRequest, code: string) => void, poisoned: () => void) {
  let arrival = Promise.resolve(), closed = false
  let current: { request: BrowserRequest; release(): void } | undefined
  function poison(request: BrowserRequest, code: string) {
    closed = true; failed(request, code); poisoned(); current?.release(); current = undefined
  }
  return {
    async forward(request: BrowserRequest, proceed: () => Promise<void>, abort: () => Promise<void>) {
      const previous = arrival
      let release!: () => void
      const arrived = new Promise<void>(resolve => { release = resolve })
      arrival = previous.then(() => arrived)
      await previous
      if (closed) { release(); await abort(); return }
      current = { request, release }
      const timeout = setTimeout(() => {
        if (current?.request === request) poison(request, 'PROXY_REQUEST_BIND_TIMEOUT')
      }, 10000)
      try { await proceed(); await arrived }
      catch {
        if (current?.request === request) poison(request, 'PROXY_UNCONFIRMED_REQUEST_FAILED')
        else failed(request, 'ACTUAL_REQUEST_FAILED')
        release()
      } finally { clearTimeout(timeout); if (current?.request === request) current = undefined }
    },
    accepted(request: IncomingMessage): BrowserRequest | undefined {
      const next = current, url = next && new URL(next.request.url())
      if (closed || !next) return
      if (next.request.method() !== request.method || url!.pathname + url!.search !== request.url) {
        poison(next.request, 'PROXY_REQUEST_CAPTURE_MISMATCH'); return
      }
      current = undefined; next.release()
      return next.request
    },
    failed(request: BrowserRequest) {
      // A continued A may still arrive after its browser abort. Never release
      // B into that ambiguity: poison this fixture until cleanup instead.
      if (current?.request === request) poison(request, 'PROXY_UNCONFIRMED_REQUEST_FAILED')
    },
    close() { closed = true; current?.release(); current = undefined },
  }
}
export async function realBrowserJson(response: BrowserResponse, status: number): Promise<Data> {
  check(response.status() === status, 'HTTP_STATUS')
  check((await response.allHeaders())['cache-control'] === 'no-store', 'NO_STORE_REQUIRED')
  const capture = responseBodies.get(response)
  check(capture && capture.request === response.request(), 'ACTUAL_REQUEST_CAPTURE_REQUIRED')
  check(capture.status === response.status() && capture.headers['cache-control'] === 'no-store', 'ACTUAL_CAPTURE_METADATA_REQUIRED')
  // This is the unchanged Buffer passed to response.end for this same request.
  // Chromium's Network.getResponseBody is not a second source of body evidence.
  try { return JSON.parse(capture.bodyBytes.toString('utf8')) as Data }
  catch { throw new Error('YIDA_OWNER_BROWSER_ACTUAL_CAPTURE_JSON_REQUIRED') }
}
export async function realBrowserData(response: BrowserResponse, status: number): Promise<Data> {
  const body = await realBrowserJson(response, status)
  check(body.ok === true && body.data && typeof body.data === 'object', 'REAL_HTTP_DATA_REQUIRED')
  return body.data as Data
}

export async function createYidaOwnerBrowserFixture(input: {
  apiOrigin: string; ownerToken: string; otherToken: string; draftInput: Input; mode?: 'owner' | 'parent'
}) {
  const api = new URL(input.apiOrigin)
  check(api.protocol === 'http:' && api.hostname === '127.0.0.1' && api.origin === input.apiOrigin
    && api.username + api.password === '', 'OWNED_API_ORIGIN_REQUIRED')
  check(input.ownerToken !== input.otherToken, 'DISTINCT_SYNTHETIC_AUTH_REQUIRED')
  const cacheDir = path.join(root, 'tmp', 'yida-owner-browser', randomUUID(), 'cache')
  await mkdir(cacheDir, { recursive: true })
  const webRequire = createRequire(path.join(webRoot, 'package.json'))
  const { createServer } = await import(pathToFileURL(webRequire.resolve('vite')).href) as typeof import('../../../../apps/web/node_modules/vite')
  const { default: vue } = await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-vue')).href) as { default: () => Plugin }
  const { chromium } = await import(pathToFileURL(webRequire.resolve('@playwright/test')).href) as typeof import('@playwright/test')
  let vite: ViteDevServer | undefined, browser: Browser | undefined, context: BrowserContext | undefined, page: Page | undefined
  let nextGate: { method: string; path: string; gate: Gate } | undefined
  const captures = createYidaOwnerResponseCapture(), proxyRequests = new WeakMap<IncomingMessage, BrowserRequest>()
  const bridge = createBrowserRequestBridge((request, code) => captures.failed(request, code), () => captures.close())
  let expectedToken = input.ownerToken, pageErrors = 0, abortedApiRequests = 0
  const requests: ApiRequest[] = [], violations: string[] = [], gates: Gate[] = [], pending = new Set<Promise<void>>()
  const escaped = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c')
  const parent = input.mode === 'parent'
  const componentImport = parent
    ? "import ParentPanel from '/src/components/integration/stockPreparation/StockPreparationYidaPreviewPanel.vue';"
    : "import OwnerPanel from '/src/components/integration/stockPreparation/StockPreparationYidaOwnerSendPanel.vue';"
  const componentSetup = parent
    // The actual parent owns all configuration, local compilation and child props.
    ? "onMounted(()=>{document.body.dataset.ownerHarnessReady='1';});return()=>h(ParentPanel);"
    : `const draftInput=ref(${escaped(input.draftInput)}), editor=ref(JSON.stringify(draftInput.value));
      const switchSession=()=>{notifyAuthPrincipalChange();localStorage.setItem('auth_token',${escaped(input.otherToken)});};
      onMounted(()=>{document.body.dataset.ownerHarnessReady='1';});
      return()=>h('main',[
        h('p',{'data-testid':'owner-harness-scope'},'合成会话认证初始化；真实 Owner 面板与真实 SDK。'),
        h('textarea',{'data-testid':'owner-harness-input',value:editor.value,onInput:event=>{editor.value=event.target.value;}}),
        h('button',{'data-testid':'owner-harness-apply',onClick:()=>{draftInput.value=JSON.parse(editor.value);}},'应用合成配置'),
        h('button',{'data-testid':'owner-harness-session',onClick:switchSession},'切换合成会话'),
        h(OwnerPanel,{draftInput:draftInput.value}),
      ]);`
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head>
    <body><div id="app"></div><script type="module">
    import {createApp,h,ref,onMounted} from 'vue';
    ${componentImport}
    import {notifyAuthPrincipalChange} from '/src/composables/authPrincipal.ts';
    createApp({setup(){${componentSetup}}}).mount('#app');
    </script></body></html>`
  async function cleanup() {
    captures.close(); bridge.close()
    for (const held of gates) held.release()
    await Promise.allSettled([...pending])
    await context?.close(); context = undefined
    await browser?.close(); browser = undefined
    // This fixture explicitly creates a plain HTTP/1 server; Vite's broader
    // HttpServer type also includes HTTP/2, which lacks this existing method.
    ;(vite?.httpServer as { closeAllConnections(): void } | undefined)?.closeAllConnections()
    await vite?.close(); vite = undefined
  }
  try {
    vite = await createServer({ root: webRoot, configFile: false, envFile: false, cacheDir,
      define: { 'import.meta.env.VITE_API_URL': '""', 'import.meta.env.VITE_API_BASE': '""' },
      plugins: [vue(), { name: 'synthetic-yida-owner-real-http-browser', configureServer(server) {
        server.middlewares.use(htmlPath, async (_request, response, next) => {
          try { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(await server.transformIndexHtml(htmlPath, html)) }
          catch { next(new Error('YIDA_OWNER_BROWSER_HARNESS_FAILED')) }
        })
      } } as Plugin],
      optimizeDeps: { include: ['vue'] },
      server: { host: '127.0.0.1', port: 0, hmr: false, proxy: { [prefix]: {
        target: input.apiOrigin, changeOrigin: false, selfHandleResponse: true, proxyTimeout: 15000,
        configure(proxy) {
          proxy.on('proxyReq', (outgoing, request) => {
            const actual = bridge.accepted(request)
            if (!actual) {
              violations.push('UNBOUND_PROXY_REQUEST'); outgoing.destroy(); return
            }
            proxyRequests.set(request, actual)
            captures.nativeConfirmed(actual)
          })
          proxy.on('error', (_error, request) => {
            const actual = proxyRequests.get(request)
            if (actual) captures.failed(actual, 'UPSTREAM_REQUEST_FAILED')
          })
          proxy.on('proxyRes', (upstream, request, response) => {
            const actual = proxyRequests.get(request)
            if (!actual) { violations.push('UNBOUND_PROXY_RESPONSE'); response.destroy(); return }
            captures.upstream(actual, upstream.statusCode ?? 0, upstream.headers, upstream.complete)
            response.once('finish', () => captures.downstream(actual, 'finish', response.destroyed))
            response.once('close', () => captures.downstream(actual, 'close', response.destroyed))
            const held = nextGate && nextGate.method === request.method && nextGate.path === request.url?.split('?')[0]
              ? nextGate.gate : undefined
            if (held) nextGate = undefined
            const chunks: Buffer[] = []
            let upstreamBytes = 0
            upstream.on('data', chunk => {
              const bytes = Buffer.from(chunk); chunks.push(bytes); upstreamBytes += bytes.length
              captures.upstreamBytes(actual, upstreamBytes)
            })
            upstream.once('error', () => { captures.failed(actual, 'UPSTREAM_RESPONSE_FAILED'); violations.push('UPSTREAM_RESPONSE_FAILED'); response.destroy() })
            upstream.once('aborted', () => { captures.failed(actual, 'UPSTREAM_RESPONSE_ABORTED'); response.destroy() })
            upstream.once('end', () => {
              const original = Buffer.concat(chunks)
              captures.upstream(actual, upstream.statusCode ?? 0, upstream.headers, upstream.complete, original.length)
              // Only delay bytes already returned by the actual JWT/router/core.
              // No fabricated envelope, status, payload, headers or authority.
              const deliver = (async () => {
                if (held) {
                  held.status = upstream.statusCode ?? 0; held.bytes = original.length
                  held.enter(); await held.open
                }
                if (response.destroyed || response.writableEnded) { captures.failed(actual); return }
                captures.captured(actual, upstream.statusCode ?? 0, upstream.headers, original)
                response.writeHead(upstream.statusCode ?? 0, upstream.headers)
                response.end(original)
              })()
              pending.add(deliver)
              void deliver.catch(() => { captures.failed(actual, 'UPSTREAM_DELIVERY_FAILED'); violations.push('UPSTREAM_DELIVERY_FAILED'); response.destroy() }).finally(() => pending.delete(deliver))
            })
          })
        },
      } } },
    })
    const server = vite.httpServer
    check(server, 'OWNED_UI_SERVER_REQUIRED')
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      void Promise.resolve(server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })).catch(reject)
    })
    const address = server.address()
    check(address && typeof address !== 'string', 'OWNED_UI_ADDRESS_REQUIRED')
    const origin = `http://127.0.0.1:${address.port}`
    // No page/Node hook is accepted as native isolation. The private launcher
    // installs this actual kernel guard only in its capability-free worker.
    const nativeIsolation = webRequire(path.join(root, 'scripts/ops/lib/stock-preparation-browser-network-isolation.cjs')) as
      { assertBrowserNetworkIsolation(): unknown }
    nativeIsolation.assertBrowserNetworkIsolation()
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() })
    context = await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: 'zh-CN', serviceWorkers: 'block' })
    await context.addInitScript(({ authToken, ownedOrigin }) => {
      if (location.origin === ownedOrigin) localStorage.setItem('auth_token', authToken)
    }, { authToken: input.ownerToken, ownedOrigin: origin })
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url())
      if (url.origin !== origin) { violations.push('EXTERNAL_REQUEST'); await route.abort('blockedbyclient'); return }
      if (!url.pathname.startsWith(prefix)) { await route.continue(); return }
      // Only one request may be between Chromium route.continue and proxyReq.
      // This binds the real Request using memory only, with no wire identifier.
      await bridge.forward(request, () => route.continue(), () => route.abort('aborted'))
    })
    context.on('request', request => {
      const target = new URL(request.url())
      if (!target.pathname.startsWith('/api/')) return
      captures.requested(request)
      const headers = request.headers()
      if (!target.pathname.startsWith(prefix) || target.search) violations.push('UNEXPECTED_API')
      requests.push({ method: request.method(), path: target.pathname, body: request.postData() === null ? null : request.postDataJSON(),
        correctSession: headers.authorization === `Bearer ${expectedToken}`,
        scopeHeaders: ['x-tenant-id', 'x-workspace-id', 'x-owner-id'].some(key => Object.hasOwn(headers, key)) })
    })
    context.on('requestfailed', request => {
      captures.browserFailed(request, request.failure()?.errorText.includes('ERR_ABORTED') ? 'aborted' : 'unknown')
      captures.failed(request)
      bridge.failed(request)
      if (new URL(request.url()).pathname.startsWith(prefix) && request.failure()?.errorText.includes('ERR_ABORTED')) abortedApiRequests++
      else violations.push('REQUEST_FAILED')
    })
    context.on('response', response => captures.responded(response))
    context.on('requestfinished', request => captures.finished(request))
    page = await context.newPage()
    page.on('pageerror', () => { pageErrors++ })
    await page.goto(origin + htmlPath, { waitUntil: 'networkidle' })
    await page.getByTestId(parent ? 'stock-prep-yida-preview-panel' : 'stock-prep-yida-owner-send-panel').waitFor()
    await page.waitForFunction(() => document.body.dataset.ownerHarnessReady === '1')
    return {
      page, requests, violations, cleanup, cacheDir,
      responseDiagnostics: () => captures.diagnostics(),
      async pageDiagnostic() {
        try {
          return await page!.evaluate(allowedCodes => {
            const present = (id: string) => document.querySelector(`[data-testid="${id}"]`) !== null
            const disabled = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)?.disabled ?? null
            const rawCode = document.querySelector('[data-testid="sp-yida-owner-error"]')?.textContent?.trim() ?? ''
            // Read only the actual dev Vue busy ref; no instance identifiers,
            // payloads, commands, auth state or other setup values are retained.
            const owner = document.querySelector('[data-testid="stock-prep-yida-owner-send-panel"]') as
              (HTMLElement & { __vueParentComponent?: { setupState?: { busy?: unknown } } }) | null
            const rawBusy = owner?.__vueParentComponent?.setupState?.busy
            const busy = typeof rawBusy === 'boolean' ? rawBusy
              : rawBusy && typeof rawBusy === 'object' && 'value' in rawBusy && typeof rawBusy.value === 'boolean' ? rawBusy.value : null
            return { available: true, errorCode: rawCode === '' ? 'none' : allowedCodes.includes(rawCode) ? rawCode : 'unknown', busy,
              phases: { owner: !!owner, draft: present('sp-yida-owner-draft'), confirmation: present('sp-yida-owner-confirmation'),
                grant: present('sp-yida-owner-grant'), frozen: present('sp-yida-owner-frozen'), acknowledged: present('sp-yida-owner-acknowledged'),
                disabled: present('sp-yida-owner-disabled') },
              controlsDisabled: { save: disabled('sp-yida-owner-save'), preview: disabled('sp-yida-owner-preview'),
                approve: disabled('sp-yida-owner-approve'), submit: disabled('sp-yida-owner-submit'), refresh: disabled('sp-yida-owner-refresh') },
            }
          }, diagnosticErrorCodes)
        } catch { return { available: false, errorCode: 'unavailable', busy: null, phases: null, controlsDisabled: null } }
      },
      get pageErrors() { return pageErrors }, get abortedApiRequests() { return abortedApiRequests },
      async settled() { await page!.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))) },
      waitApi(method: string, suffix: string) {
        return captures.observe(method, prefix + suffix)
      },
      delayNext(method: string, suffix: string) {
        check(!nextGate, 'ONLY_ONE_DELAY_REQUIRED')
        const held = gate(); gates.push(held); nextGate = { method, path: prefix + suffix, gate: held }
        return held
      },
      async reached(held: Gate, expectedStatus: 200 | 201 = 200) {
        let timeout: ReturnType<typeof setTimeout> | undefined
        try { await Promise.race([held.reached, new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('YIDA_OWNER_BROWSER_ACTUAL_RESPONSE_TIMEOUT')), 10000)
        })]) } finally { clearTimeout(timeout) }
        check(held.status === expectedStatus && held.bytes > 0, 'ACTUAL_SUCCESS_RESPONSE_REQUIRED')
      },
      async applyInput(value: Input) {
        await page!.getByTestId('owner-harness-input').fill(JSON.stringify(value))
        await page!.getByTestId('owner-harness-apply').click()
      },
      async switchSession() {
        expectedToken = input.otherToken
        await page!.getByTestId('owner-harness-session').click()
      },
    }
  } catch (error) { await cleanup(); throw error }
}
export type YidaOwnerBrowserFixture = Awaited<ReturnType<typeof createYidaOwnerBrowserFixture>>
