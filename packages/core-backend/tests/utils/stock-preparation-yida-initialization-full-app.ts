/// <reference lib="dom" />
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import type { Browser, Request, Response } from '@playwright/test'
import type { Logger, PreviewServer } from '../../../../apps/web/node_modules/vite'
import type { YidaInitializationState } from '../../../../apps/web/src/services/integration/yidaInitialization'
import { ownerOffDraftBody } from './stock-preparation-yida-owner-off-full-app'
import { createDryRunStatusWindow, createMembersOffWindow, createProjectSheetsOffWindow } from './stock-preparation-main-migration-contract'
import { createYidaAutomationDefaultOffBrowserWindow, runYidaAutomationDefaultOffBrowser } from './yida-automation-default-off-browser'
import { createYidaAuthorizedBrowserWindow, runYidaAuthorizedBrowser, type YidaAuthorizedBrowserInput } from './yida-automation-authorized-browser'

export interface YidaInitializationBrowserInput {
  apiOrigin: string
  identifier: string
  password: string
  scratchDir: string
  tenantId: string
  ownerId: string
  commandId: string
  projectNo: 'SYN-YIDA-PREVIEW'
  compiledWeb: { buildRoot: string; wrapperConfig: string; emittedFiles: Array<{ path: string; bytes: number; sha256: string }> }
}
export const initializationEndpoint = '/api/integration/yida-owner-send/initialization'
export const initializationBrowserPhases = Object.freeze(['SETUP', 'LOGIN', 'BOARD', 'PANEL', 'READY_GET', 'POST',
  'MANUAL_GET', 'RELOAD', 'RELOAD_GET', 'FINISH', 'CLOSE', 'OTHER'] as const)
type InitializationBrowserPhase = typeof initializationBrowserPhases[number]
const browserFailurePhases = new WeakMap<object, InitializationBrowserPhase>()
export function createInitializationBrowserFailureScope() {
  let phase: InitializationBrowserPhase = 'SETUP'
  return {
    enter(value: unknown) {
      phase = typeof value === 'string' && initializationBrowserPhases.includes(value as InitializationBrowserPhase)
        ? value as InitializationBrowserPhase : 'OTHER'
    },
    failure(): Error {
      const error = new Error('APP_BROWSER_YIDA_INIT_FAILED')
      browserFailurePhases.set(error, phase)
      return error
    },
  }
}
/** WeakMap identity reads do not inspect a foreign Error/proxy/getter. */
export function initializationBrowserFailure(error: unknown) {
  return { stage: 'yida-initialization-browser-failed' as const, diagnostic: 'APP_BROWSER_YIDA_INIT_FAILED' as const,
    phase: browserFailurePhases.get(error as object) ?? 'OTHER' }
}
export const initializationMaterial = () => ({ appKey: ' synthetic-full-app-app-key ',
  appSecret: ' synthetic-full-app-app-secret ', systemToken: ' synthetic-full-app-system-token ',
  userId: 'synthetic-full-app-executor' })
export function initializationBody(commandId: string) {
  return { commandId, material: initializationMaterial(), draft: ownerOffDraftBody(), attestation: {
    kind: 'owner-reviewed-target', reviewRef: 'synthetic-full-app-review', organizationId: 'synthetic-full-app-organization',
    executionIdentity: initializationMaterial().userId,
  } }
}

/** App.vue -> usePlugins uses this one public catalog GET on full reload.
 * It carries no session/scope steering and has no relationship to owner IO. */
export function assertFixedPublicPluginRequest(origin: string, request: Pick<Request, 'url' | 'method' | 'headers' | 'postData'>) {
  const target = new URL(request.url()), headers = request.headers()
  assert(target.origin === origin && target.pathname === '/api/plugins' && !target.search && !target.hash
    && !target.username && !target.password && request.method() === 'GET' && request.postData() === null
    && !('authorization' in headers) && !('x-tenant-id' in headers) && !('x-workspace-id' in headers),
  'APP_BROWSER_YIDA_INIT_PUBLIC_PLUGIN_REQUEST_INVALID')
}

/** LoginView's forced feature inference uses actual apiFetch/authHeaders:
 * checked session Bearer plus its tenant hint, never a workspace selector. */
export function assertFixedAuthenticatedPluginRequest(origin: string, expectedToken: string, expectedTenant: string,
  request: Pick<Request, 'url' | 'method' | 'headers' | 'postData'>) {
  const target = new URL(request.url()), headers = request.headers()
  assert(target.origin === origin && target.pathname === '/api/plugins' && !target.search && !target.hash
    && !target.username && !target.password && request.method() === 'GET' && request.postData() === null
    && expectedToken && expectedTenant && headers.authorization === 'Bearer ' + expectedToken
    && headers['x-tenant-id'] === expectedTenant && !('x-workspace-id' in headers),
  'APP_BROWSER_YIDA_INIT_AUTHENTICATED_PLUGIN_REQUEST_INVALID')
}

/** Fixed private request capability. No general write or HTTP principal claim. */
export function createInitializationRequestWindow(origin: string, token: () => string, commandId: string) {
  let armed: 'GET' | 'POST' | undefined
  const counts = { gets: 0, posts: 0 }
  return {
    counts,
    arm(method: 'GET' | 'POST') {
      assert(!armed && (method !== 'POST' || (counts.gets === 1 && counts.posts === 0)), 'APP_BROWSER_YIDA_INIT_ARM_INVALID')
      armed = method
    },
    accept(request: Pick<Request, 'url' | 'method' | 'headers' | 'postDataJSON' | 'postData'>) {
      const target = new URL(request.url()), method = request.method(), headers = request.headers()
      assert(target.origin === origin && target.pathname === initializationEndpoint && !target.search && !target.hash
        && method === armed && (method === 'GET' || method === 'POST'), 'APP_BROWSER_YIDA_INIT_REQUEST_DENIED')
      assert(token() && headers.authorization === 'Bearer ' + token()
        && !('x-tenant-id' in headers) && !('x-workspace-id' in headers), 'APP_BROWSER_YIDA_INIT_PRINCIPAL_HEADERS_INVALID')
      assert(method === 'GET' ? request.postData() === null
        : /^application\/json(?:\s*;|$)/iu.test(headers['content-type'] ?? '')
          && isDeepStrictEqual(request.postDataJSON(), initializationBody(commandId)), 'APP_BROWSER_YIDA_INIT_BODY_INVALID')
      armed = undefined
      if (method === 'GET') counts.gets += 1; else counts.posts += 1
    },
    verify() { assert(!armed && counts.gets === 3 && counts.posts === 1, 'APP_BROWSER_YIDA_INIT_JOURNEY_INCOMPLETE') },
  }
}

function data(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'APP_BROWSER_YIDA_INIT_OBJECT_REQUIRED')
  return value as Record<string, unknown>
}
function validateState(value: unknown, commandId: string, initialized: boolean, reused: boolean): YidaInitializationState {
  const state = data(value)
  assert.deepEqual(Object.keys(state).sort(), ['canSend', 'commandId', 'draft', 'externalWriteAttempted', 'status', 'tokenIssued'])
  assert(state.commandId === commandId && state.status === (initialized ? 'initialized' : 'ready')
    && state.canSend === false && state.tokenIssued === false && state.externalWriteAttempted === false,
  'APP_BROWSER_YIDA_INIT_STATE_INVALID')
  if (!initialized) assert.equal(state.draft, null, 'APP_BROWSER_YIDA_INIT_EMPTY_SLOT_REQUIRED')
  else {
    const draft = data(state.draft)
    assert.deepEqual(Object.keys(draft).sort(), ['canApply', 'canSend', 'externalWriteAttempted', 'identityKind',
      'operationId', 'reused', 'rowCount', 'rows', 'status', 'targetRef', 'tokenIssued'])
    assert(draft.status === 'unverified' && draft.identityKind === 'local-unverified' && draft.canSend === false
      && draft.canApply === false && draft.tokenIssued === false && draft.externalWriteAttempted === false
      && draft.reused === reused && draft.rowCount === 2 && Array.isArray(draft.rows) && draft.rows.length === 2,
    'APP_BROWSER_YIDA_INIT_DRAFT_INVALID')
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
    assert(typeof draft.operationId === 'string' && uuid.test(draft.operationId)
      && typeof draft.targetRef === 'string' && uuid.test(draft.targetRef), 'APP_BROWSER_YIDA_INIT_HANDLES_INVALID')
    const keys = draft.rows.map((value, index) => {
      const row = data(value)
      assert.deepEqual(Object.keys(row).sort(), ['index', 'rowKey'])
      assert(row.index === index && typeof row.rowKey === 'string' && uuid.test(row.rowKey), 'APP_BROWSER_YIDA_INIT_ROW_INVALID')
      return row.rowKey
    })
    assert.equal(new Set(keys).size, 2, 'APP_BROWSER_YIDA_INIT_ROWS_DISTINCT_REQUIRED')
  }
  return state as unknown as YidaInitializationState
}

/** A fresh process/context drives index.html -> main.ts -> App/router/Pinia ->
 * actual project board -> actual initialization panel. The original OFF window
 * has already ended. All routes continue to the real migrated synthetic host. */
export async function runYidaInitializationFullApp(input: YidaInitializationBrowserInput, root: string) {
  const observed = await runYidaBrowser(input, root)
  assert(observed.kind === 'initialization', 'APP_BROWSER_YIDA_INIT_RESULT_REQUIRED')
  const { kind: _kind, ...result } = observed
  return result
}

/** Same real login/bundle/firewall shell, separate fresh browser context. This
 * test-only entry cannot initialize material or substitute a client session. */
export async function runYidaAuthorizationFullApp(input: Omit<YidaInitializationBrowserInput, 'projectNo'>,
  root: string, authorized: YidaAuthorizedBrowserInput) {
  try {
    const observed = await runYidaBrowser({ ...input, projectNo: 'DEMO-P1' }, root, authorized)
    assert(observed.kind === 'authorized', 'APP_BROWSER_YIDA_AUTH_RESULT_REQUIRED')
    const { kind: _kind, ...result } = observed
    return result
  } catch (error) {
    console.error('YIDA_AUTO_AUTH_SHELL_FAILURE ' + JSON.stringify(initializationBrowserFailure(error)))
    throw error
  }
}

async function runYidaBrowser(input: Omit<YidaInitializationBrowserInput, 'projectNo'> & { projectNo: 'SYN-YIDA-PREVIEW' | 'DEMO-P1' },
  root: string, authorized?: YidaAuthorizedBrowserInput) {
  const failureScope = createInitializationBrowserFailureScope()
  const api = new URL(input.apiOrigin)
  assert(api.origin === input.apiOrigin && api.protocol === 'http:' && api.hostname === '127.0.0.1'
    && api.port && !api.username && !api.password, 'APP_BROWSER_YIDA_INIT_LOCAL_HOST_REQUIRED')
  assert(input.identifier && input.password && input.tenantId && input.ownerId && input.commandId
    && input.projectNo === (authorized ? 'DEMO-P1' : 'SYN-YIDA-PREVIEW'), 'APP_BROWSER_YIDA_INIT_SYNTHETIC_INPUT_REQUIRED')
  const scratch = await realpath(input.scratchDir), ownedTmp = await realpath(path.join(root, 'tmp'))
  assert(scratch === input.scratchDir && path.dirname(scratch) === ownedTmp
    && /^stock-preparation-plm-full-app-[a-f0-9-]{36}$/u.test(path.basename(scratch)), 'APP_BROWSER_YIDA_INIT_SCRATCH_REQUIRED')
  const relative = path.relative(root, scratch).replaceAll('\\', '/')
  assert(input.compiledWeb.buildRoot === relative + '/build/web/dist'
    && input.compiledWeb.wrapperConfig === relative + '/build/web/vite.config.mjs', 'APP_BROWSER_YIDA_INIT_BUNDLE_OWNER_REQUIRED')
  const bundleRoot = path.join(root, input.compiledWeb.buildRoot)
  for (const entry of [bundleRoot, path.join(root, input.compiledWeb.wrapperConfig)]) assert.equal(await realpath(entry), entry)
  const bundles = new Map<string, { bytes: number; sha256: string }>()
  for (const file of input.compiledWeb.emittedFiles) {
    assert(file.path.startsWith(input.compiledWeb.buildRoot + '/') && !file.path.includes('\\')
      && !file.path.split('/').some(part => !part || part === '.' || part === '..')
      && /^[a-f0-9]{64}$/u.test(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes >= 0,
    'APP_BROWSER_YIDA_INIT_BUNDLE_DESCRIPTOR_INVALID')
    const key = '/' + file.path.slice(input.compiledWeb.buildRoot.length + 1)
    assert(!bundles.has(key), 'APP_BROWSER_YIDA_INIT_BUNDLE_DUPLICATED'); bundles.set(key, file)
  }
  assert(bundles.has('/index.html') && bundles.size > 1, 'APP_BROWSER_YIDA_INIT_BUNDLE_ENTRY_REQUIRED')
  const browserScratch = await mkdtemp(path.join(scratch, 'yida-initialization-browser-'))
  const emptyEnvDir = path.join(browserScratch, 'empty-env'), cacheDir = path.join(browserScratch, 'vite-cache')
  await mkdir(emptyEnvDir); await mkdir(cacheDir)
  assert.equal((await readdir(emptyEnvDir)).length, 0)
  const webRoot = path.join(root, 'apps/web'), requireWeb = createRequire(path.join(webRoot, 'package.json'))
  const vitePackage = requireWeb('vite/package.json') as { exports: { '.': { import: { default: string } } } }
  const viteEntry = path.resolve(path.dirname(requireWeb.resolve('vite/package.json')), vitePackage.exports['.'].import.default)
  const { preview } = await import(pathToFileURL(viteEntry).href) as typeof import('../../../../apps/web/node_modules/vite')
  const { chromium } = requireWeb('@playwright/test') as typeof import('@playwright/test')
  let vite: PreviewServer | undefined, browser: Browser | undefined, closing = false
  let token = '', privateControlsCleared = false
  let rejectLogin: ((error: Error) => void) | undefined
  const faults: string[] = [], pending = new Set<Promise<void>>(), served = new Set<string>()
  const counts = { loginSubmissions: 0, loginResponses: 0, initializationGets: 0, initializationPosts: 0,
    initializationResponses: 0, reloads: 0, boardResponses: 0, bundleDocuments: 0,
    externalRequests: 0, forbiddenRequests: 0, responseStubs: 0, storageInjections: 0 }
  const note = (code: string) => { if (!closing && faults.length < 16) faults.push(code) }
  const logger: Logger = { hasWarned: false, info() {}, warn() { note('VITE_WARNING') }, warnOnce() { note('VITE_WARNING') },
    error() { note('VITE_ERROR') }, clearScreen() {}, hasErrorLogged() { return false } }
  const saved = new Map<string, string | undefined>()
  for (const key of [...Object.keys(process.env).filter(key => /^VITE_/iu.test(key)), 'METASHEET_ENV_DIR']) {
    saved.set(key, process.env[key]); delete process.env[key]
  }
  process.env.METASHEET_ENV_DIR = emptyEnvDir
  try {
    try {
      vite = await preview({ root: webRoot, base: '/', mode: 'production',
        configFile: path.join(root, input.compiledWeb.wrapperConfig), envFile: false, envDir: emptyEnvDir,
        cacheDir, customLogger: logger, define: { 'import.meta.env.VITE_API_URL': '""', 'import.meta.env.VITE_API_BASE': '""' },
        build: { outDir: bundleRoot }, preview: { host: '127.0.0.1', port: 0, strictPort: true, open: false, cors: false,
          proxy: { '/api': { target: input.apiOrigin, changeOrigin: false, ws: true },
            '/socket.io': { target: input.apiOrigin, changeOrigin: false, ws: true } } } })
      assert(vite.config.isProduction && vite.config.mode === 'production', 'APP_BROWSER_YIDA_INIT_PRODUCTION_REQUIRED')
    } finally {
      for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    }
    const address = vite.httpServer?.address()
    assert(address && typeof address !== 'string' && address.port > 0, 'APP_BROWSER_YIDA_INIT_LISTENER_REQUIRED')
    const uiOrigin = `http://127.0.0.1:${address.port}`
    let projectProbePhase = 'LOGIN'
    const projectSheetsOff = createProjectSheetsOffWindow({ origin: uiOrigin, tenantId: input.tenantId,
      token: () => token, phase: () => projectProbePhase, projectNo: () => input.projectNo,
      allowedPhases: ['LOGIN', 'BOARD', 'RELOAD'] })
    const membersOff = createMembersOffWindow({ origin: uiOrigin, tenantId: input.tenantId,
      token: () => token, phase: () => projectProbePhase, allowedPhases: ['LOGIN', 'BOARD', 'RELOAD'] })
    const dryRunStatus = createDryRunStatusWindow({ origin: uiOrigin, tenantId: input.tenantId,
      token: () => token, phase: () => projectProbePhase, projectNo: () => input.projectNo,
      allowedPhases: ['BOARD', 'RELOAD'] })
    const native = createRequire(import.meta.url)(path.join(root, 'scripts/ops/lib/stock-preparation-browser-network-isolation.cjs')) as
      { assertBrowserNetworkIsolation(): unknown }
    native.assertBrowserNetworkIsolation()
    const authority = createRequire(import.meta.url)(path.join(root, 'scripts/ops/lib/stock-preparation-plm-namespace-scope.cjs')) as {
      installedBrowserCandidate(): { executablePath: string; version: string } | undefined
    }
    const candidate = authority.installedBrowserCandidate()
    browser = await chromium.launch({ headless: true, executablePath: candidate?.executablePath ?? chromium.executablePath() })
    if (candidate) assert.equal(browser.version(), candidate.version, 'APP_BROWSER_YIDA_INIT_PINNED_BROWSER_VERSION_REQUIRED')
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', serviceWorkers: 'block' })
    const window = createInitializationRequestWindow(uiOrigin, () => token, input.commandId)
    const automaticOff = createYidaAutomationDefaultOffBrowserWindow(uiOrigin, () => token, input.ownerId)
    const automaticOn = authorized ? createYidaAuthorizedBrowserWindow(uiOrigin, () => token, authorized) : undefined
    const boardPath = '/api/integration/stock-preparation/projects/' + input.projectNo + '/board'
    const scopeQuery = '?' + new URLSearchParams({ tenantId: input.tenantId })
    const ordinaryReads = new Set(['/api/auth/me', '/api/todo/count', '/api/approvals/admin/capability',
      '/api/platform/apps/stock-preparation', '/api/integration/hub/overview'])
    let loginArmed = false
    let releaseLogin!: () => void
    const verifiedLogin = new Promise<void>((resolve, reject) => { releaseLogin = resolve; rejectLogin = reject })
    void verifiedLogin.catch(() => undefined)
    await context.route('**/*', async route => {
      try {
        const request = route.request(), url = new URL(request.url()), method = request.method(), headers = request.headers()
        if (url.origin !== uiOrigin) counts.externalRequests += 1
        assert(url.origin === uiOrigin && !url.username && !url.password, 'APP_BROWSER_YIDA_INIT_ORIGIN_DENIED')
        if (automaticOn?.candidate(request)) {
          automaticOn.accept(request)
          if (await automaticOn.reconciliation.dropCommittedResponse(route)) return
        } else if (automaticOff.candidate(request)) {
          automaticOff.accept(request)
        } else if (membersOff.isCandidate(request)) {
          await verifiedLogin
          membersOff.accept(request)
        } else if (projectSheetsOff.isCandidate(request)) {
          await verifiedLogin
          projectSheetsOff.accept(request)
        } else if (dryRunStatus.isCandidate(request)) {
          await verifiedLogin
          dryRunStatus.accept(request)
        } else if (url.pathname === initializationEndpoint) {
          window.accept(request)
          if (method === 'GET') counts.initializationGets += 1; else counts.initializationPosts += 1
        } else if (url.pathname.startsWith('/api/')) {
          if (url.pathname === '/api/auth/login') {
            assert(loginArmed && counts.loginSubmissions === 0 && method === 'POST' && !url.search
              && isDeepStrictEqual(request.postDataJSON(), { identifier: input.identifier, password: input.password }),
            'APP_BROWSER_YIDA_INIT_LOGIN_REQUEST_INVALID')
            loginArmed = false; counts.loginSubmissions += 1
          } else if (url.pathname === '/api/auth/dingtalk/launch') {
            assert(method === 'GET' && url.search === '?probe=1' && request.postData() === null)
          } else if (url.pathname === '/api/plugins') {
            if ('authorization' in headers) {
              await verifiedLogin
              assertFixedAuthenticatedPluginRequest(uiOrigin, token, input.tenantId, request)
            } else {
              assertFixedPublicPluginRequest(uiOrigin, request)
            }
          } else {
            // The shell can request immediately after the real login response.
            // Hold its original request until that response's actual principal
            // has been checked; do not inject or fabricate a session token.
            await verifiedLogin
            assert(token && headers.authorization === 'Bearer ' + token, 'APP_BROWSER_YIDA_INIT_SESSION_REQUIRED')
            const allowed = method === 'GET' && request.postData() === null && (ordinaryReads.has(url.pathname) && !url.search
              || url.pathname === boardPath && url.search === scopeQuery
              || url.pathname === '/api/integration/stock-preparation/handoff'
                && url.search === '?' + new URLSearchParams({ tenantId: input.tenantId, projectNo: input.projectNo })
              || url.pathname === '/api/integration/stock-preparation/operator/projects'
                && [scopeQuery, scopeQuery + '&includePullTargets=1'].includes(url.search))
              || method === 'DELETE' && url.pathname === '/api/method-probe' && !url.search && request.postData() === null
            assert(allowed, 'APP_BROWSER_YIDA_INIT_SHELL_REQUEST_DENIED')
          }
        } else if (url.pathname === '/socket.io/') {
          assert(method === 'GET', 'APP_BROWSER_YIDA_INIT_SOCKET_HTTP_DENIED')
        } else {
          assert(method === 'GET' && (request.resourceType() === 'document'
            ? ['/login', '/stock-prep'].includes(url.pathname) : bundles.has(decodeURIComponent(url.pathname))),
          'APP_BROWSER_YIDA_INIT_ASSET_DENIED')
        }
        await route.continue()
      } catch { counts.forbiddenRequests += 1; note('REQUEST_DENIED'); await route.abort('blockedbyclient') }
    })
    assert(typeof context.routeWebSocket === 'function', 'APP_BROWSER_YIDA_INIT_WS_FIREWALL_REQUIRED')
    await context.routeWebSocket('**/*', socket => {
      const url = new URL(socket.url())
      if (url.origin !== uiOrigin.replace(/^http:/u, 'ws:') || url.pathname !== '/socket.io/') {
        counts.forbiddenRequests += 1; note('WEBSOCKET_DENIED'); void socket.close({ code: 1008, reason: 'APP_BROWSER_YIDA_INIT_DENIED' }); return
      }
      socket.connectToServer()
    })
    context.on('requestfailed', request => {
      try { if (automaticOn?.reconciliation.expectedFailure(request)) return } catch { note('RECONCILIATION_FAULT_MISMATCH') }
      note('REQUEST_FAILED')
    })
    context.on('response', response => {
      const task = (async () => {
        const url = new URL(response.url())
        // The explicit UI journey reads the actual Response in full. Merely
        // seeing an event or matching a URL is never body-completion evidence.
        if (automaticOn?.candidate(response.request())) {
          assert(automaticOn.matched(response.request()), 'APP_BROWSER_YIDA_AUTH_RESPONSE_IDENTITY_REQUIRED')
          return
        }
        if (automaticOff.candidate(response.request())) {
          await automaticOff.response(response); return
        }
        if (membersOff.isCandidate(response.request())) {
          membersOff.response(response.request(), response.status(), await response.json())
          return
        }
        if (projectSheetsOff.isCandidate(response.request())) {
          projectSheetsOff.response(response.request(), response.status(), await response.json())
          return
        }
        if (dryRunStatus.isCandidate(response.request())) {
          dryRunStatus.response(response.request(), response.status(), await response.json())
          return
        }
        assert.equal(response.status(), 200 + (url.pathname === initializationEndpoint && response.request().method() === 'POST' ? 1 : 0),
          'APP_BROWSER_YIDA_INIT_HTTP_STATUS_INVALID')
        if (!url.pathname.startsWith('/api/') && url.pathname !== '/socket.io/') {
          const key = response.request().resourceType() === 'document' ? '/index.html' : decodeURIComponent(url.pathname)
          const expected = bundles.get(key), bytes = await response.body()
          assert(expected && bytes.length === expected.bytes && createHash('sha256').update(bytes).digest('hex') === expected.sha256,
            'APP_BROWSER_YIDA_INIT_SERVED_BUNDLE_CHANGED')
          served.add(key); if (key === '/index.html') counts.bundleDocuments += 1
        }
        if (url.pathname === initializationEndpoint) counts.initializationResponses += 1
        if (url.pathname === boardPath) counts.boardResponses += 1
      })().catch(() => note('RESPONSE_INVALID'))
      pending.add(task); void task.finally(() => pending.delete(task))
    })
    const page = await context.newPage()
    page.on('pageerror', () => note('PAGE_ERROR')); page.on('console', event => {
      if (event.type() !== 'error') return
      try { if (automaticOn?.reconciliation.consoleFailure(event.location().url, event.text())) return }
      catch { note('RECONCILIATION_CONSOLE_MISMATCH') }
      try { if (automaticOff.consoleRefusal(event.location().url, event.text())) return }
      catch { note('AUTOMATION_OFF_CONSOLE_INVALID'); return }
      try { if (membersOff.consoleRefusal(event.location().url, event.text())) return }
      catch { note('MEMBERS_OFF_CONSOLE_INVALID'); return }
      try { if (projectSheetsOff.consoleRefusal(event.location().url, event.text())) return }
      catch { note('PROJECT_SHEETS_OFF_CONSOLE_INVALID'); return }
      try { if (dryRunStatus.consoleRefusal(event.location().url, event.text())) return }
      catch { note('DRY_RUN_STATUS_CONSOLE_INVALID'); return }
      note('CONSOLE_ERROR')
    })
    const settled = async () => { await page.waitForLoadState('networkidle'); while (pending.size) await Promise.all([...pending]); assert.equal(faults.length, 0, 'APP_BROWSER_YIDA_INIT_TRANSPORT_FAILED') }
    const wait = (pathname: string, method = 'GET') => page.waitForResponse(response => {
      const url = new URL(response.url()); return url.origin === uiOrigin && url.pathname === pathname && response.request().method() === method
    })
    const body = async (response: Response, status = 200) => {
      assert.equal(response.status(), status, 'APP_BROWSER_YIDA_INIT_EXPLICIT_STATUS_INVALID')
      const envelope = data(await response.json()); assert.equal(envelope.ok, true, 'APP_BROWSER_YIDA_INIT_ENVELOPE_INVALID'); return envelope.data
    }
    const target = '/stock-prep?executionScope=tenant&tab=project-board'
    failureScope.enter('LOGIN')
    await page.goto(uiOrigin + '/login?redirect=' + encodeURIComponent(target))
    await page.locator('.login-form input[autocomplete="username"]').waitFor()
    assert(await page.evaluate(() => !localStorage.getItem('auth_token') && !localStorage.getItem('jwt')), 'APP_BROWSER_YIDA_INIT_FRESH_CONTEXT_REQUIRED')
    const login = wait('/api/auth/login', 'POST')
    await page.locator('.login-form input[autocomplete="username"]').fill(input.identifier)
    await page.locator('.login-form input[autocomplete="current-password"]').fill(input.password)
    loginArmed = true
    await page.locator('.login-form button[type="submit"]').click()
    const session = data(await (await login).json()), loggedIn = data(session.data), user = data(loggedIn.user)
    assert(session.success === true && typeof loggedIn.token === 'string' && loggedIn.token
      && user.id === input.ownerId && user.tenantId === input.tenantId, 'APP_BROWSER_YIDA_INIT_LOGIN_PRINCIPAL_INVALID')
    token = loggedIn.token as string; counts.loginResponses += 1; releaseLogin()
    await page.waitForURL(url => url.origin === uiOrigin && url.pathname === '/stock-prep' && url.search === target.slice('/stock-prep'.length))
    failureScope.enter('BOARD')
    projectProbePhase = 'BOARD'
    await page.getByTestId('stock-prep-project-board-input').waitFor(); await settled()
    const board = wait(boardPath)
    await page.getByTestId('stock-prep-project-board-input').fill(input.projectNo)
    await page.getByTestId('stock-prep-project-board-open').click()
    const boardData = data(await body(await board))
    assert(boardData.projectNo === input.projectNo && boardData.tenantId === input.tenantId
      && boardData.pullTargetReady === true && boardData.pulledRowCount === 1 && boardData.activePulledRowCount === 0,
    'APP_BROWSER_YIDA_INIT_REAL_BOARD_INVALID')
    await page.locator('[data-testid="stock-prep-panel"][data-active="project-board"]').waitFor()
    if (authorized && automaticOn) {
      assert.equal(data(boardData.fillTarget).sheetId, authorized.rule.sheetId)
      const authorization = await runYidaAuthorizedBrowser(page, automaticOn, authorized, uiOrigin, settled, async () => {
        assert.equal(counts.reloads, 0)
        failureScope.enter('RELOAD'); projectProbePhase = 'RELOAD'
        const sessionAfterReload = wait('/api/auth/me'), boardAfterReload = wait(boardPath)
        await page.reload(); counts.reloads++
        const restoredSession = data(await (await sessionAfterReload).json())
        const restoredUser = data(data(restoredSession.data).user)
        assert(restoredUser.id === input.ownerId && restoredUser.tenantId === input.tenantId,
          'APP_BROWSER_YIDA_AUTH_RELOAD_PRINCIPAL_CHANGED')
        const restoredBoard = data(await body(await boardAfterReload))
        assert(restoredBoard.projectNo === input.projectNo && restoredBoard.tenantId === input.tenantId
          && data(restoredBoard.fillTarget).sheetId === authorized.rule.sheetId,
        'APP_BROWSER_YIDA_AUTH_RELOAD_BOARD_CHANGED')
        await page.getByTestId('stock-prep-project-board-title').filter({ hasText: input.projectNo }).waitFor()
        await settled()
      })
      projectSheetsOff.verify(); membersOff.verify(); dryRunStatus.verify(); await settled()
      assert(counts.loginSubmissions === 1 && counts.loginResponses === 1 && counts.bundleDocuments === 2
        && counts.initializationGets === 0 && counts.initializationPosts === 0 && counts.reloads === 1)
      return { kind: 'authorized' as const, status: 'passed' as const, authorization, counts, evidence: { realPasswordLogin: true,
        freshBrowserContext: true, productionBundle: true, servedBundleBytesVerified: true, matchingProjectBoard: true,
        realPageReloadSamePrincipal: true } }
    }
    const openPanel = async () => {
      await page.getByTestId('stock-prep-project-board-title').filter({ hasText: input.projectNo }).waitFor()
      await page.getByTestId('stock-prep-project-board-yida').click()
      await page.getByTestId('sp-yida-preview-mode').selectOption('protocol')
      await page.getByTestId('sp-yida-protocol-example-primary').click()
      await page.getByTestId('sp-yida-run').click()
      await page.getByTestId('sp-yida-initialization-open').click()
      await page.getByTestId('stock-prep-yida-initialization-panel').waitFor()
      await settled()
      assert.equal(await page.getByTestId('stock-prep-yida-owner-send-panel').count(), 0)
    }
    failureScope.enter('PANEL'); await openPanel()
    assert.equal(counts.initializationGets + counts.initializationPosts, 0, 'APP_BROWSER_YIDA_INIT_OPENING_MUST_BE_QUIET')
    const observe = async (initialized: boolean) => {
      window.arm('GET'); const response = wait(initializationEndpoint)
      await page.getByTestId('sp-yida-init-refresh').click()
      const state = validateState(await body(await response), input.commandId, initialized, initialized)
      await page.getByTestId(initialized ? 'sp-yida-init-initialized' : 'sp-yida-init-ready').waitFor(); await settled(); return state
    }
    failureScope.enter('READY_GET'); await observe(false)
    assert(await page.getByTestId('sp-yida-init-submit').isDisabled(), 'APP_BROWSER_YIDA_INIT_EXPLICIT_INPUT_REQUIRED')
    failureScope.enter('POST')
    for (const [key, value] of Object.entries(initializationMaterial())) await page.getByTestId('sp-yida-init-' + key).fill(value)
    await page.getByTestId('sp-yida-init-review').fill('synthetic-full-app-review')
    await page.getByTestId('sp-yida-init-organization').fill('synthetic-full-app-organization')
    await page.getByTestId('sp-yida-init-ack').check()
    window.arm('POST'); const response = wait(initializationEndpoint, 'POST')
    await page.getByTestId('sp-yida-init-submit').click()
    const initialized = validateState(await body(await response, 201), input.commandId, true, false)
    await page.getByTestId('sp-yida-init-initialized').waitFor(); await settled()
    const assertCleared = async () => {
      for (const key of ['appKey', 'appSecret', 'systemToken', 'userId', 'review', 'organization']) assert.equal(await page.getByTestId('sp-yida-init-' + key).count(), 0)
      const storage = await page.evaluate(() => JSON.stringify([Object.keys(localStorage).map(key => [key, localStorage.getItem(key)]),
        Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)])]))
      for (const value of Object.values(initializationMaterial())) assert(!storage.includes(value), 'APP_BROWSER_YIDA_INIT_PRIVATE_STORAGE_LEAK')
      privateControlsCleared = true
    }
    await assertCleared()
    failureScope.enter('MANUAL_GET'); const recovered = await observe(true)
    assert.deepEqual({ ...recovered.draft, reused: false }, initialized.draft, 'APP_BROWSER_YIDA_INIT_GET_CHANGED_DRAFT')
    failureScope.enter('RELOAD'); const sessionAfterReload = wait('/api/auth/me')
    projectProbePhase = 'RELOAD'
    await page.reload(); counts.reloads += 1
    const reloaded = data(await (await sessionAfterReload).json()), reloadedUser = data(data(reloaded.data).user)
    assert(reloadedUser.id === input.ownerId && reloadedUser.tenantId === input.tenantId, 'APP_BROWSER_YIDA_INIT_RELOAD_PRINCIPAL_CHANGED')
    await openPanel()
    failureScope.enter('RELOAD_GET'); const afterReload = await observe(true)
    assert.deepEqual(afterReload, recovered, 'APP_BROWSER_YIDA_INIT_RELOAD_CHANGED_DRAFT'); await assertCleared()
    failureScope.enter('FINISH'); window.verify(); await settled()
    projectSheetsOff.verify()
    membersOff.verify()
    dryRunStatus.verify()
    assert(counts.loginSubmissions === 1 && counts.loginResponses === 1 && counts.initializationResponses === 4
      && counts.boardResponses >= 2 && counts.bundleDocuments === 2 && [...served].filter(key => key.endsWith('.js')).length >= 2
      && [...served].some(key => key.endsWith('.css')), 'APP_BROWSER_YIDA_INIT_FULL_JOURNEY_REQUIRED')
    // The original init checks above remain unchanged. The separate new window
    // uses this SAME real page/session and its actual board's target handle.
    const fillTarget = data(boardData.fillTarget)
    assert(typeof fillTarget.sheetId === 'string' && fillTarget.sheetId)
    automaticOff.configure(fillTarget.sheetId, afterReload)
    const automationOff = await runYidaAutomationDefaultOffBrowser(page, automaticOff, settled)
    return { kind: 'initialization' as const, status: 'passed' as const, state: initialized, evidence: { realPasswordLogin: true, freshBrowserContext: true,
      productionBundle: true, servedBundleBytesVerified: true, realProjectBoardNavigation: true, actualInitializationPanel: true,
      openingNoInitializationRequests: true, explicitEmptySlotGet: true, realSdkPost201: true, manualGetSameDraft: true,
      reloadSamePrincipalAndDraft: true, privateControlsCleared, defaultOff: true, tokenIssued: false, externalWriteAttempted: false }, counts, automationOff }
  } catch {
    // Never forward Playwright call logs, filled values, URL, JWT or DB handles.
    if (authorized) console.error('YIDA_AUTO_AUTH_SHELL_COUNTS ' + JSON.stringify({
      ...initializationBrowserFailure(failureScope.failure()), counts, faults: [...faults] }))
    rejectLogin?.(new Error('APP_BROWSER_YIDA_INIT_LOGIN_FAILED'))
    throw failureScope.failure()
  } finally {
    closing = true
    rejectLogin?.(new Error('APP_BROWSER_YIDA_INIT_CLOSED'))
    failureScope.enter('CLOSE')
    try {
      try { await browser?.close() } finally { await vite?.close() }
    } catch { throw failureScope.failure() }
  }
}
