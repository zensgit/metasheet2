/**
 * Product-module browser proof for the managed auth writer interlock.
 * Imports the real web modules through Vite. The Set-Cookie timing is a
 * cooperating-writer proof on one browser profile, not an XSS boundary
 * and not a product-server call.
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const webRoot = join(repo, 'apps/web')
const node = process.execPath
const webRequire = createRequire(join(webRoot, 'package.json'))
const { chromium } = webRequire('@playwright/test')
const { createServer: createVite } = webRequire('vite')
const vuePlugin = webRequire('@vitejs/plugin-vue')
const vue = vuePlugin.default || vuePlugin

const DESTINATION = '/plm/bom-review?managed=ready'
const PROOF_PAGE = `<!doctype html>
<meta name="referrer" content="no-referrer">
<script type="module">
import { completeManagedBrowserBridge } from '/src/services/plm/plmManagedCompanion.ts'
import { syncMutationOpen } from '/src/composables/authIdentityLock.ts'
import { useAuth } from '/src/composables/useAuth.ts'
import { apiFetch } from '/src/utils/api.ts'
import { useFeatureFlags } from '/src/stores/featureFlags.ts'
window.__plm = { completeManagedBrowserBridge, syncMutationOpen, useAuth, apiFetch, useFeatureFlags }
window.__ready = true
</script>`

function jwt(org) {
  const body = Buffer.from(JSON.stringify({
    userId: 'actor',
    tenantId: org,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url')
  return `header.${body}.signature`
}

function cookieHeader(req) {
  return String(req.headers.cookie || '')
}

function hasSession(req) {
  return cookieHeader(req).split(';').some((part) => part.trim() === 'ms_plm_managed_session=person-A')
}

const state = {
  holdComplete: false,
  held: null,
  completePosts: 0,
  logoutPosts: 0,
  currentGets: 0,
  logoutStatus: 200,
  holdMe: false,
  heldMe: null,
  devTokenPosts: 0,
}

function json(res, status, body, extraHeaders) {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders }
  res.writeHead(status, headers)
  res.end(JSON.stringify(body))
}

function releaseComplete(body) {
  const res = state.held
  state.held = null
  state.holdComplete = false
  if (!res) throw new Error('no held complete body')
  res.end(JSON.stringify(body))
}

function releaseMe(body) {
  const res = state.heldMe
  state.heldMe = null
  state.holdMe = false
  if (!res) throw new Error('no held me body')
  res.end(JSON.stringify(body))
}

function handleApi(req, res) {
  const url = new URL(req.url || '/', 'http://loopback')
  if (req.method === 'POST' && url.pathname === '/api/plm/managed-login/complete') {
    state.completePosts += 1
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'set-cookie': 'ms_plm_managed_session=person-A; HttpOnly; Path=/; SameSite=Lax',
    })
    res.flushHeaders()
    if (state.holdComplete) {
      state.held = res
      return
    }
    res.end(JSON.stringify({ ok: true, destination: DESTINATION }))
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/plm/managed-login/logout') {
    state.logoutPosts += 1
    if (state.logoutStatus !== 200) {
      json(res, state.logoutStatus, { ok: false, error: { code: 'REVOKE_DOWN' } })
      return
    }
    json(res, 200, { ok: true, revoked: true }, {
      'set-cookie': 'ms_plm_managed_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
    })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/plm/managed-login/current') {
    state.currentGets += 1
    if (!hasSession(req)) {
      json(res, 401, { success: false, error: { code: 'PLM_MANAGED_SESSION_REQUIRED' } })
      return
    }
    json(res, 200, {
      success: true,
      data: {
        user: { id: 'person-A', tenantId: 'tenant-a', role: 'user', permissions: [] },
        managedSession: {
          mode: 'managed-cookie',
          userId: 'person-A',
          tenantId: 'tenant-a',
          sessionId: 'session-a',
          revision: 1,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/auth/dev-token') {
    state.devTokenPosts += 1
    json(res, 200, { token: 'dev-from-server' })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    if (state.holdMe) {
      state.heldMe = res
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.flushHeaders()
      return
    }
    json(res, 200, { success: true, data: { user: { id: 'actor' }, features: { plm: false, attendance: false, workflow: false } } })
    return
  }
  if (url.pathname === '/api/attendance/records') {
    json(res, 401, { success: false })
    return
  }
  if (url.pathname === '/api/plugins') {
    json(res, 200, { list: [] })
    return
  }
  json(res, 404, { ok: false })
}

async function waitFor(predicate, label) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 8000) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

async function openProof(page, origin) {
  await page.goto(`${origin}/proof`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__ready === true)
}

async function resetOrigin(context, page) {
  await context.clearCookies()
  if (page && !page.isClosed()) {
    await page.evaluate(() => {
      localStorage.clear()
    }).catch(() => undefined)
  }
  state.holdComplete = false
  state.held = null
  state.holdMe = false
  state.heldMe = null
  state.logoutStatus = 200
}

const results = []
function record(name, detail) {
  results.push({ name, ...detail })
}

const cleanupObserved = { browserClosed: false, serverClosed: false, viteClosed: false }

async function main() {
  const envDir = mkdtempSync(join(tmpdir(), 'plm-b2c-vite-env-'))
  const vite = await createVite({
    configFile: false,
    root: webRoot,
    envDir,
    appType: 'custom',
    logLevel: 'error',
    plugins: [vue()],
    resolve: { alias: { '@': join(webRoot, 'src') } },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false },
  })
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://loopback')
    if (url.pathname === '/proof' || url.pathname === '/login') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(url.pathname === '/proof' ? PROOF_PAGE : '<!doctype html><title>login</title>')
      return
    }
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res)
      return
    }
    vite.middlewares(req, res, () => {
      res.statusCode = 404
      res.end('not found')
    })
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const port = server.address().port
  const origin = `http://127.0.0.1:${port}`
  process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/Users/chouhua/Library/Caches/ms-playwright'
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  let page = await context.newPage()
  try {
    await page.goto(`${origin}/proof`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__ready === true)

    state.holdComplete = true
    const startedPosts = state.completePosts
    const completePromise = page.evaluate(async () => {
      window.__depthDuringFetch = null
      const original = window.fetch
      window.fetch = async (...args) => {
        const url = String(args[0])
        if (url.includes('/complete')) window.__depthDuringFetch = window.__plm.syncMutationOpen()
        return original(...args)
      }
      return await window.__plm.completeManagedBrowserBridge('code', 'state')
    })
    await waitFor(() => state.held !== null, 'same-tab complete headers')
    const during = await page.evaluate(async () => {
      let bare = ''
      try { window.__plm.useAuth().setToken('bare-token') } catch (error) { bare = error instanceof Error ? error.message : String(error) }
      window.__publish = window.__plm.useAuth().commitOrdinaryAuthTransition(() => {
        window.__plm.useAuth().setToken('person-b-token')
      })
      await new Promise((resolve) => setTimeout(resolve, 40))
      return {
        bare,
        tokenDuring: localStorage.getItem('auth_token'),
        depthDuringFetch: window.__depthDuringFetch,
        pending: localStorage.getItem('metasheet_managed_complete_pending'),
      }
    })
    const cookieDuring = (await context.cookies()).some((cookie) => cookie.name === 'ms_plm_managed_session' && cookie.value === 'person-A')
    if (during.tokenDuring !== null || !during.bare.includes('AUTH_IDENTITY_LOCK_REQUIRED') || during.depthDuringFetch !== false || !cookieDuring || during.pending !== '1') {
      throw new Error(`same-tab overlap failed ${JSON.stringify({ during, cookieDuring })}`)
    }
    releaseComplete({ ok: true, destination: DESTINATION })
    const completed = await completePromise
    await page.evaluate(() => window.__publish)
    const after = await page.evaluate(() => ({
      token: localStorage.getItem('auth_token'),
      marker: localStorage.getItem('metasheet_managed_probe'),
      pending: localStorage.getItem('metasheet_managed_complete_pending'),
    }))
    const cookieAfterPublish = (await context.cookies()).some((cookie) => cookie.name === 'ms_plm_managed_session' && cookie.value === 'person-A')
    record('same-tab', {
      completePosts: state.completePosts - startedPosts,
      completed,
      during,
      after,
      cookieDuring,
      cookieAfterPublish,
      logoutPosts: state.logoutPosts,
    })
    if (completed.stale !== false || after.token !== 'person-b-token' || after.marker !== null || after.pending !== null || cookieAfterPublish || state.logoutPosts < 1) {
      throw new Error(`same-tab publish did not revoke A before writing B ${JSON.stringify(after)}`)
    }

    await resetOrigin(context, page)
    state.completePosts = 0
    state.logoutPosts = 0
    const pageB = await context.newPage()
    await pageB.goto(`${origin}/proof`, { waitUntil: 'domcontentloaded' })
    await pageB.waitForFunction(() => window.__ready === true)
    state.holdComplete = true
    const twoTabComplete = page.evaluate(() => window.__plm.completeManagedBrowserBridge('code', 'state-b'))
    await waitFor(() => state.held !== null, 'two-tab complete headers')
    const otherTab = await pageB.evaluate(async () => {
      window.__publish = window.__plm.useAuth().commitOrdinaryAuthTransition(() => {
        window.__plm.useAuth().setToken('tab-b-token')
      })
      await new Promise((resolve) => setTimeout(resolve, 40))
      return localStorage.getItem('auth_token')
    })
    if (otherTab !== null) throw new Error('two-tab writer landed while complete held the lock')
    releaseComplete({ ok: true, destination: DESTINATION })
    const twoCompleted = await twoTabComplete
    await pageB.evaluate(() => window.__publish)
    const twoAfter = await page.evaluate(() => localStorage.getItem('auth_token'))
    const twoCookie = (await context.cookies()).some((cookie) => cookie.name === 'ms_plm_managed_session' && cookie.value === 'person-A')
    record('two-tab', { otherTabDuring: otherTab, completed: twoCompleted, tokenAfter: twoAfter, logoutPosts: state.logoutPosts, cookieAfter: twoCookie })
    if (twoAfter !== 'tab-b-token' || twoCookie) throw new Error('two-tab queued writer did not revoke A before writing B')
    await pageB.close()

    await resetOrigin(context, page)
    state.logoutPosts = 0
    state.currentGets = 0
    state.holdComplete = false
    await page.evaluate(async () => {
      const completed = await window.__plm.completeManagedBrowserBridge('code', 'state-login')
      if (completed.stale || !completed.destination) throw new Error('complete did not publish A')
      const auth = window.__plm.useAuth()
      await auth.commitOrdinaryAuthTransition(() => { auth.setToken('ordinary-b') })
      await auth.commitClearedOrdinaryAuth()
      const current = await fetch('/api/plm/managed-login/current', { credentials: 'include' })
      return { status: current.status }
    }).then((current) => {
      record('login-logout-current', { ...current, logoutPosts: state.logoutPosts, currentGets: state.currentGets })
      if (current.status !== 401) throw new Error(`GET current revived managed A with status ${current.status}`)
    })
    const cookiesAfterLogout = await context.cookies()
    if (cookiesAfterLogout.some((cookie) => cookie.name === 'ms_plm_managed_session' && cookie.value === 'person-A')) {
      throw new Error('managed cookie survived ordinary B logout')
    }

    const bare = await context.newPage()
    await bare.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'locks', { configurable: true, get() { return undefined } })
    })
    await bare.goto(`${origin}/proof`, { waitUntil: 'domcontentloaded' })
    await bare.waitForFunction(() => window.__ready === true)
    const postsBeforeUnsupported = state.completePosts
    const unsupported = await bare.evaluate(async () => {
      try {
        await window.__plm.completeManagedBrowserBridge('code', 'state-nolock')
        return 'adopted'
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })
    const unsupportedStorage = await bare.evaluate(() => ({
      pending: localStorage.getItem('metasheet_managed_complete_pending'),
      marker: localStorage.getItem('metasheet_managed_probe'),
    }))
    record('unsupported-locks', { unsupported, posts: state.completePosts - postsBeforeUnsupported, ...unsupportedStorage })
    if (!unsupported.includes('AUTH_IDENTITY_LOCK_UNAVAILABLE') || state.completePosts !== postsBeforeUnsupported || unsupportedStorage.pending || unsupportedStorage.marker) {
      throw new Error(`unsupported locks did not fail closed ${unsupported}`)
    }
    await bare.close()

    await resetOrigin(context, page)
    const postsBeforeStorage = state.completePosts
    const storageFail = await page.evaluate(async () => {
      const original = localStorage.setItem.bind(localStorage)
      localStorage.setItem = (key, value) => {
        if (key === 'metasheet_managed_complete_pending') throw new Error('quota')
        return original(key, value)
      }
      try {
        await window.__plm.completeManagedBrowserBridge('code', 'state-quota')
        return 'adopted'
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })
    record('storage-fail', { storageFail, posts: state.completePosts - postsBeforeStorage })
    if (!storageFail.includes('AUTH_IDENTITY_PENDING_STORAGE') || state.completePosts !== postsBeforeStorage) {
      throw new Error(`storage failure still posted complete ${storageFail}`)
    }
    await openProof(page, origin)

    await resetOrigin(context, page)
    state.logoutStatus = 503
    const revoke = await page.evaluate(async () => {
      localStorage.setItem('metasheet_managed_probe', '1')
      localStorage.setItem('auth_token', 'kept-b')
      localStorage.setItem('jwt', 'kept-b')
      try {
        await window.__plm.useAuth().commitOrdinaryAuthTransition(() => {
          window.__plm.useAuth().setToken('replacement')
        })
        return { error: '', token: localStorage.getItem('auth_token'), marker: localStorage.getItem('metasheet_managed_probe') }
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          token: localStorage.getItem('auth_token'),
          marker: localStorage.getItem('metasheet_managed_probe'),
        }
      }
    })
    record('revoke-outage', revoke)
    if (revoke.token !== 'kept-b' || revoke.marker !== '1' || !revoke.error) throw new Error(`revoke outage published ${JSON.stringify(revoke)}`)
    state.logoutStatus = 200

    await resetOrigin(context, page)
    state.holdComplete = true
    const cancelPosts = state.completePosts
    const cancelPromise = page.evaluate(() => window.__plm.completeManagedBrowserBridge('code', 'state-cancel')).catch((error) => String(error))
    await waitFor(() => state.held !== null, 'cancel complete headers')
    const pendingBeforeClose = await page.evaluate(() => localStorage.getItem('metasheet_managed_complete_pending'))
    const cookieBeforeCloseAt = Date.now()
    let cookieBeforeClose = false
    while (!cookieBeforeClose) {
      if (Date.now() - cookieBeforeCloseAt > 8000) throw new Error('cancel complete did not install the cookie before the tab closed')
      const cookies = await context.cookies()
      cookieBeforeClose = cookies.some((cookie) => cookie.name === 'ms_plm_managed_session' && cookie.value === 'person-A')
      if (!cookieBeforeClose) await new Promise((resolve) => setTimeout(resolve, 15))
    }
    await page.close()
    try { state.held.end(JSON.stringify({ ok: true, destination: DESTINATION })) } catch { /* The closed tab may already have aborted the socket. */ }
    state.held = null
    state.holdComplete = false
    await cancelPromise.catch(() => undefined)
    page = await context.newPage()
    await openProof(page, origin)
    const recovered = await page.evaluate(async () => {
      await window.__plm.useAuth().commitOrdinaryAuthTransition(() => {
        window.__plm.useAuth().setToken('recovered-b')
      })
      const current = await fetch('/api/plm/managed-login/current', { credentials: 'include' })
      return {
        pending: localStorage.getItem('metasheet_managed_complete_pending'),
        token: localStorage.getItem('auth_token'),
        current: current.status,
      }
    })
    const cookieAfterRecovery = (await context.cookies()).some((cookie) => cookie.name === 'ms_plm_managed_session' && cookie.value === 'person-A')
    record('cancel-crash-pending', { pendingBeforeClose, cookieBeforeClose, recovered, cookieAfterRecovery, completePosts: state.completePosts - cancelPosts })
    if (pendingBeforeClose !== '1' || !cookieBeforeClose || cookieAfterRecovery || recovered.pending !== null || recovered.token !== 'recovered-b' || recovered.current !== 401) {
      throw new Error(`crash pending recovery failed ${JSON.stringify({ pendingBeforeClose, cookieBeforeClose, recovered, cookieAfterRecovery })}`)
    }

    await resetOrigin(context, page)
    const org = await page.evaluate(async (nextOrg) => {
      const auth = window.__plm.useAuth()
      const body = btoa(JSON.stringify({ userId: 'actor', tenantId: 'org-a', exp: Math.floor(Date.now() / 1000) + 3600 })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
      const current = `header.${body}.signature`
      const nextBody = btoa(JSON.stringify({ userId: 'actor', tenantId: 'org-b', exp: Math.floor(Date.now() / 1000) + 3600 })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
      const next = `header.${nextBody}.signature`
      await auth.commitOrdinaryAuthTransition(() => { auth.setToken(current) })
      const original = localStorage.setItem.bind(localStorage)
      localStorage.setItem = (key, value) => {
        if (key === 'jwt' && value === next) throw new Error('jwt failed')
        return original(key, value)
      }
      const applied = await auth.commitExplicitSessionOrg(next, 'org-b', current)
      return { applied, authToken: localStorage.getItem('auth_token'), jwt: localStorage.getItem('jwt'), expected: current, nextOrg }
    }, 'org-b')
    record('org-rollback', org)
    if (org.applied !== false || org.authToken !== org.expected || org.jwt !== org.expected) throw new Error(`org rollback failed ${JSON.stringify(org)}`)

    await resetOrigin(context, page)
    const dev = await page.evaluate(async () => {
      const writes = []
      let later = false
      const original = localStorage.setItem.bind(localStorage)
      localStorage.setItem = (key, value) => {
        if (key === 'auth_token') queueMicrotask(() => { later = true })
        writes.push(`${key}:${later ? 'later' : 'same-turn'}`)
        return original(key, value)
      }
      const token = await window.__plm.useAuth().refreshDevToken()
      return {
        token,
        authToken: localStorage.getItem('auth_token'),
        jwt: localStorage.getItem('jwt'),
        devToken: localStorage.getItem('devToken'),
        devWrite: writes.find((entry) => entry.startsWith('devToken:')) || '',
      }
    })
    record('dev-refresh', dev)
    if (dev.token !== 'dev-from-server' || dev.devToken !== 'dev-from-server' || dev.devWrite !== 'devToken:same-turn') {
      throw new Error(`dev refresh split the writes ${JSON.stringify(dev)}`)
    }

    await resetOrigin(context, page)
    state.logoutStatus = 503
    const denied = await page.evaluate(async () => {
      localStorage.setItem('metasheet_managed_probe', '1')
      localStorage.setItem('auth_token', 'person-b')
      localStorage.setItem('jwt', 'person-b')
      let thrown = ''
      try {
        await window.__plm.apiFetch('/api/attendance/records')
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error)
      }
      return {
        thrown,
        path: window.location.pathname,
        token: localStorage.getItem('auth_token'),
        marker: localStorage.getItem('metasheet_managed_probe'),
      }
    })
    record('api-401-revoke-outage', denied)
    if (denied.path !== '/proof' || denied.token !== 'person-b' || denied.marker !== '1') throw new Error(`401 navigated during revoke outage ${JSON.stringify(denied)}`)
    state.logoutStatus = 200
    await resetOrigin(context, page)
    await page.evaluate(() => { localStorage.setItem('auth_token', 'expired'); localStorage.setItem('jwt', 'expired') })
    const navigated = page.waitForURL(/\/login/, { timeout: 8000 })
    await page.evaluate(() => window.__plm.apiFetch('/api/attendance/records')).catch(() => undefined)
    await navigated
    const cleared = await page.evaluate(() => localStorage.getItem('auth_token'))
    record('api-401-clears', { cleared, url: page.url() })
    if (cleared !== null || !page.url().includes('/login')) throw new Error('401 did not clear and leave the protected page')

    page = await context.newPage()
    await openProof(page, origin)
    state.holdMe = true
    const lateStarted = page.evaluate(async () => {
      const auth = window.__plm.useAuth()
      const encode = (org) => {
        const body = btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: Math.floor(Date.now() / 1000) + 3600 })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
        return `header.${body}.signature`
      }
      await auth.commitOrdinaryAuthTransition(() => { auth.setToken(encode('org-a')) })
      const features = await window.__plm.useFeatureFlags().loadProductFeatures(true)
      return { plm: features.plm === true }
    })
    await waitFor(() => state.heldMe !== null, 'late feature me headers')
    await page.evaluate(async () => {
      const auth = window.__plm.useAuth()
      const body = btoa(JSON.stringify({ userId: 'actor', tenantId: 'org-b', exp: Math.floor(Date.now() / 1000) + 3600 })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
      await auth.commitOrdinaryAuthTransition(() => { auth.setToken(`header.${body}.signature`) })
    })
    releaseMe({
      success: true,
      data: { user: { id: 'actor', tenantId: 'org-a' }, features: { plm: true, attendance: false, workflow: false } },
    })
    const late = await lateStarted
    record('late-features', late)
    if (late.plm !== false) throw new Error('late feature payload was adopted')

    const controlPage = await context.newPage()
    await openProof(controlPage, origin)
    state.holdMe = true
    const controlStarted = controlPage.evaluate(async () => {
      const auth = window.__plm.useAuth()
      const body = btoa(JSON.stringify({ userId: 'actor', tenantId: 'org-a', exp: Math.floor(Date.now() / 1000) + 3600 })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
      await auth.commitOrdinaryAuthTransition(() => { auth.setToken(`header.${body}.signature`) })
      const features = await window.__plm.useFeatureFlags().loadProductFeatures(true)
      return { plm: features.plm === true }
    })
    await waitFor(() => state.heldMe !== null, 'stable feature me headers')
    releaseMe({
      success: true,
      data: { user: { id: 'actor', tenantId: 'org-a' }, features: { plm: true, attendance: false, workflow: false } },
    })
    const control = await controlStarted
    record('late-features-stable-adopts', control)
    if (control.plm !== true) throw new Error('stable me payload was not adopted; the drop check would be vacuous')
    await controlPage.close()

    const browserVersion = browser.version()
    const proof = {
      ok: true,
      kind: 'product-module-browser-proof',
      node,
      playwright: webRequire('@playwright/test/package.json').version,
      browser: browserVersion,
      scenarios: results,
      limits: [
        'Cooperating normal-app writers on one browser profile only.',
        'Web Locks are not an XSS boundary.',
        'The complete endpoint is a controlled header-then-body harness, not the product server.',
        'Set-Cookie is still applied before the response body is read.',
      ],
    }
    const encoded = JSON.stringify(proof)
    proof.sha256 = createHash('sha256').update(encoded).digest('hex')
    const finalText = `${JSON.stringify(proof, null, 2)}\n`
    const artifactDir = join(repo, 'artifacts/plm-managed-auth-writer-interlock-20261018')
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync('/tmp/plm-b2c-interlock-product-proof-20261018.json', finalText)
    writeFileSync(join(artifactDir, 'product-proof.json'), finalText)
    return proof
  } finally {
    await browser.close()
    cleanupObserved.browserClosed = !browser.isConnected()
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
    cleanupObserved.serverClosed = !server.listening
    await vite.close()
    cleanupObserved.viteClosed = !vite.httpServer?.listening
    rmSync(envDir, { recursive: true, force: true })
  }
}

const started = Date.now()
main().then((proof) => {
  const cleanup = {
    ...cleanupObserved,
    ok: proof.ok === true,
    elapsedMs: Date.now() - started,
  }
  const text = `${JSON.stringify(cleanup, null, 2)}\n`
  writeFileSync('/tmp/plm-b2c-interlock-product-cleanup-20261018.json', text)
  writeFileSync(join(repo, 'artifacts/plm-managed-auth-writer-interlock-20261018/cleanup.json'), text)
  process.stdout.write(text)
}).catch(async (error) => {
  const failure = { ok: false, error: error instanceof Error ? error.message : String(error), scenarios: results }
  writeFileSync('/tmp/plm-b2c-interlock-product-proof-20261018.json', `${JSON.stringify(failure, null, 2)}\n`)
  process.stderr.write(`${failure.error}\n`)
  process.exitCode = 1
})
