import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

import { expandHistoryFilters } from './verify-attendance-locale-zh-smoke.mjs'
import { AcceptanceTenantError, verifyAcceptanceTokenTenant } from './ops/attendance-acceptance-preflight.mjs'

// GATE-5097 P2-2(b): the pre-existing coverage for expandHistoryFilters() (in
// scripts/ops/attendance-locale-zh-workflow-contract.test.mjs) only asserts the SOURCE TEXT of
// this file — it proves the function is called in the right order, not that it does what it
// claims. The reviewer's mutation M4 (neuter the click so the disclosure never actually opens,
// while leaving every pinned string intact) survived that pin: 5/5 pass. These tests drive the
// real exported function against a stub Playwright-shaped `page`, asserting the DISCLOSURE STATE
// changes — not text — so M4 cannot survive here.

/**
 * A minimal stand-in for the <details data-attendance-history-filters> DOM node
 * expandHistoryFilters() reads/mutates via page.locator(...).evaluate(...).
 */
function createHistoryFiltersNode({ open = false, summaryText = '日期 / 组织 / 用户筛选' } = {}) {
  return {
    open,
    summaryText,
    hasAttribute(name) {
      return name === 'open' ? this.open : false
    },
  }
}

/**
 * A stub `page` implementing just enough of Playwright's Locator API surface for
 * expandHistoryFilters(): page.locator(selector) -> { waitFor, evaluate, locator(selector) },
 * and a nested summary locator -> { first, textContent, click }. `opensOnClick` lets a test
 * simulate a summary click that does NOT actually open the disclosure (covers the "click didn't
 * work" throw path).
 */
function createStubPage(node, { opensOnClick = true } = {}) {
  const calls = { waitFor: 0, click: 0 }
  const summaryLocator = {
    first() {
      return summaryLocator
    },
    async textContent() {
      return node.summaryText
    },
    async click() {
      calls.click += 1
      if (opensOnClick) node.open = true
    },
  }
  const detailsLocator = {
    async waitFor() {
      calls.waitFor += 1
    },
    async evaluate(fn) {
      return fn(node)
    },
    locator(selector) {
      assert.equal(selector, 'summary')
      return summaryLocator
    },
  }
  const page = {
    locator(selector) {
      assert.equal(selector, '[data-attendance-history-filters]')
      return detailsLocator
    },
  }
  return { page, calls }
}

test('expandHistoryFilters opens a closed disclosure with the correct zh label', async () => {
  const node = createHistoryFiltersNode({ open: false })
  const { page, calls } = createStubPage(node)

  await expandHistoryFilters(page, 1000)

  assert.equal(node.open, true, 'the stub <details> node must end up open')
  assert.equal(calls.click, 1, 'must click the summary exactly once')
})

test('expandHistoryFilters is a no-op (does not click) when the disclosure is already open', async () => {
  const node = createHistoryFiltersNode({ open: true })
  const { page, calls } = createStubPage(node)

  await expandHistoryFilters(page, 1000)

  assert.equal(node.open, true)
  assert.equal(calls.click, 0, 'must not click an already-open disclosure')
})

// GATE-5097 M4: the reviewer's mutation left the summary click a no-op — the disclosure state
// never flips to open even though the click handler runs. This is exactly that scenario,
// expressed as a fixture instead of a source edit: expandHistoryFilters must throw, not return
// successfully having done nothing.
test('expandHistoryFilters throws if clicking the summary does not actually open the disclosure (kills M4)', async () => {
  const node = createHistoryFiltersNode({ open: false })
  const { page } = createStubPage(node, { opensOnClick: false })

  await assert.rejects(
    () => expandHistoryFilters(page, 1000),
    /Expected \[data-attendance-history-filters\] to be open after clicking its summary/,
  )
  assert.equal(node.open, false)
})

// GATE-5097 NIT-3: a zh-locale smoke must not open the disclosure by data attribute alone while
// staying blind to its accessible name regressing to English or empty.
test('expandHistoryFilters throws if the summary label is not the zh label (kills a silent en/blank regression)', async () => {
  const node = createHistoryFiltersNode({ open: false, summaryText: 'Date / Org / User filters' })
  const { page, calls } = createStubPage(node)

  await assert.rejects(
    () => expandHistoryFilters(page, 1000),
    /Expected the history-filters <summary> to carry its zh label/,
  )
  assert.equal(calls.click, 0, 'must fail before ever clicking a mislabelled summary')
  assert.equal(node.open, false)
})

test('expandHistoryFilters throws on an empty summary label', async () => {
  const node = createHistoryFiltersNode({ open: false, summaryText: '' })
  const { page } = createStubPage(node)

  await assert.rejects(() => expandHistoryFilters(page, 1000))
})

const localeSource = readFileSync(new URL('./verify-attendance-locale-zh-smoke.mjs', import.meta.url), 'utf8')
  .split('\nconst currentFile =')[0]
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')
const expectedTenant = 'fixture-org'
const initialToken = 'synthetic-initial-token'
const replacementToken = 'synthetic-replacement-token'
const verifiedTenant = { success: true, data: { user: { tenantId: expectedTenant } } }

// Execute the actual auth lifecycle and run() barrier. All IO is in memory; the
// browser stub stops at launch, before any locale or holiday actions can run.
function createAuthFixture({ bound = true, initial = true, initialStatus = 200, replacementStatus = 200, authPayload, authUnavailable = false, proof = () => verifiedTenant, refreshStatus = 200 } = {}) {
  const env = {
    AUTH_TOKEN: initial ? initialToken : '',
    LOGIN_EMAIL: 'fixture@example.test',
    LOGIN_PASSWORD: 'synthetic-password',
    API_BASE: 'https://locale.invalid/api',
    ...(bound ? { AUTH_EXPECTED_TENANT_ID: expectedTenant } : {}),
  }
  const evidence = { requests: [], proofs: [], actions: 0, logs: [] }
  let context
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname
    evidence.requests.push({ pathname, ...options })
    let status = 200
    let payload
    if (options.redirect === 'error') {
      const candidate = options.headers.Authorization.slice('Bearer '.length)
      evidence.proofs.push({ candidate, effective: vm.runInContext('authToken', context) })
      payload = await proof(candidate, evidence.proofs.length)
      status = payload?.httpStatus ?? 200
    } else if (pathname === '/api/auth/me') {
      if (authUnavailable) throw new Error('synthetic auth transport failure')
      status = options.headers.Authorization === `Bearer ${initialToken}` ? initialStatus : replacementStatus
      payload = authPayload === undefined ? { ...verifiedTenant, success: status === 200 } : authPayload
    } else {
      assert.ok(['/api/auth/login', '/api/auth/refresh-token'].includes(pathname))
      status = pathname === '/api/auth/refresh-token' ? refreshStatus : 200
      payload = { success: status === 200, data: { token: replacementToken } }
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload),
      json: async () => {
        if (payload === 'malformed-json') throw new SyntaxError('synthetic malformed JSON')
        return payload
      },
    }
  }
  context = vm.createContext({
    process: { env }, URL, URLSearchParams,
    console: { log: message => evidence.logs.push(message) },
    fetch: fetchImpl,
    AcceptanceTenantError,
    verifyAcceptanceTokenTenant: (base, candidate) => verifyAcceptanceTokenTenant(base, candidate, { env, fetchImpl }),
    path: { join: (...parts) => parts.join('/') },
    chromium: { launch: async () => { evidence.actions++; throw new Error('FIXTURE_BROWSER_REACHED') } },
  })
  vm.runInContext(localeSource, context)
  vm.runInContext('ensureDir = async () => {}; writeSummaryJson = async () => {}', context)
  return {
    evidence,
    token: () => vm.runInContext('authToken', context),
    run: () => vm.runInContext('run()', context),
    resolve: () => vm.runInContext('resolveAuthToken()', context),
  }
}

const invalidProofs = [
  ['missing tenant', () => ({ success: true, data: { user: {} } })],
  ['wrong tenant', () => ({ success: true, data: { user: { tenantId: 'other-org' } } })],
  ['unsuccessful envelope', () => ({ ...verifiedTenant, success: false })],
  ['missing success envelope', () => ({ data: verifiedTenant.data })],
  ['malformed envelope', () => null],
  ['malformed JSON', () => 'malformed-json'],
  ['HTTP failure', () => ({ ...verifiedTenant, httpStatus: 503 })],
  ['unavailable proof', () => { throw new Error('synthetic transport failure') }],
]

for (const stage of ['initial', 'refresh', 'login', 'final']) {
  for (const [name, invalidProof] of invalidProofs) {
    test(`bound ${stage} token refuses ${name} without actions or permissive fallback`, async () => {
      const fixture = createAuthFixture({
        initial: stage !== 'login',
        initialStatus: stage === 'refresh' ? 401 : 200,
        proof: (_candidate, count) => stage === 'final' && count === 1 ? verifiedTenant : invalidProof(),
      })
      await assert.rejects(fixture.run(), { message: 'ACCEPTANCE_TENANT_UNVERIFIED' })
      assert.equal(fixture.evidence.actions, 0)
      assert.equal(fixture.token(), stage === 'login' ? '' : initialToken)
      assert.deepEqual(fixture.evidence.proofs.map(item => item.candidate),
        stage === 'final' ? [initialToken, initialToken] : [stage === 'initial' ? initialToken : replacementToken])
      const replacements = fixture.evidence.requests.filter(item => item.pathname !== '/api/auth/me')
      assert.deepEqual(replacements.map(item => item.pathname),
        stage === 'refresh' ? ['/api/auth/refresh-token'] : stage === 'login' ? ['/api/auth/login'] : [])
      assert.doesNotMatch(fixture.evidence.logs.join('\n'), /other-org|fixture-org|synthetic-(?:initial|replacement)-token|synthetic transport failure/)
    })
  }
}

test('bound initial token is verified and rechecked before browser launch', async () => {
  const fixture = createAuthFixture()
  await assert.rejects(fixture.run(), /FIXTURE_BROWSER_REACHED/)
  assert.equal(fixture.evidence.actions, 1)
  assert.deepEqual(fixture.evidence.proofs, [
    { candidate: initialToken, effective: initialToken },
    { candidate: initialToken, effective: initialToken },
  ])
})

for (const initialStatus of [401, 403]) {
  test(`bound initial ${initialStatus} refreshes, verifies before adoption and rechecks the effective replacement`, async () => {
    const fixture = createAuthFixture({ initialStatus })
    await assert.rejects(fixture.run(), /FIXTURE_BROWSER_REACHED/)
    assert.equal(fixture.token(), replacementToken)
    assert.equal(fixture.evidence.actions, 1)
    assert.deepEqual(fixture.evidence.proofs, [
      { candidate: replacementToken, effective: initialToken },
      { candidate: replacementToken, effective: replacementToken },
    ])
    const refresh = fixture.evidence.requests.find(item => item.pathname === '/api/auth/refresh-token')
    assert.deepEqual(JSON.parse(refresh.body), { token: initialToken })
    assert.equal(fixture.evidence.requests.some(item => item.pathname === '/api/auth/login'), false)
  })
}

for (const initial of [false, true]) {
  test(`bound ${initial ? 'refresh failure fallback' : 'password login'} includes tenant and verifies before adoption`, async () => {
    const fixture = createAuthFixture({ initial, initialStatus: 401, refreshStatus: 401 })
    await assert.rejects(fixture.run(), /FIXTURE_BROWSER_REACHED/)
    assert.equal(fixture.token(), replacementToken)
    assert.equal(fixture.evidence.actions, 1)
    assert.deepEqual(fixture.evidence.proofs, [
      { candidate: replacementToken, effective: initial ? initialToken : '' },
      { candidate: replacementToken, effective: replacementToken },
    ])
    const login = fixture.evidence.requests.find(item => item.pathname === '/api/auth/login')
    assert.deepEqual(JSON.parse(login.body), {
      email: 'fixture@example.test', password: 'synthetic-password', tenantId: expectedTenant,
    })
  })
}

test('bound final proof of an adopted refresh replacement still blocks browser launch', async () => {
  const fixture = createAuthFixture({ initialStatus: 401, proof: (_candidate, count) => count === 1 ? verifiedTenant : null })
  await assert.rejects(fixture.run(), { message: 'ACCEPTANCE_TENANT_UNVERIFIED' })
  assert.equal(fixture.token(), replacementToken)
  assert.equal(fixture.evidence.actions, 0)
  assert.deepEqual(fixture.evidence.proofs.map(item => item.candidate), [replacementToken, replacementToken])
})

test('bound initial inconclusive auth response cannot fall back', async () => {
  const fixture = createAuthFixture({ initialStatus: 503 })
  await assert.rejects(fixture.resolve(), { message: 'ACCEPTANCE_TENANT_UNVERIFIED' })
  assert.equal(fixture.token(), initialToken)
  assert.equal(fixture.evidence.requests.some(item => item.pathname !== '/api/auth/me'), false)
})

for (const [name, authPayload] of [
  ['unsuccessful envelope', { ...verifiedTenant, success: false }],
  ['missing success', { data: verifiedTenant.data }],
  ['missing tenant', { success: true, data: { user: {} } }],
  ['wrong tenant', { success: true, data: { user: { tenantId: 'other-org' } } }],
  ['malformed envelope', null],
]) {
  test(`bound first auth response refuses ${name} even when later proofs would pass`, async () => {
    const fixture = createAuthFixture({ authPayload })
    await assert.rejects(fixture.run(), { message: 'ACCEPTANCE_TENANT_UNVERIFIED' })
    assert.equal(fixture.evidence.actions, 0)
    assert.equal(fixture.token(), initialToken)
    assert.equal(fixture.evidence.requests.length, 1)
    assert.deepEqual(fixture.evidence.proofs, [])
  })
}

for (const initial of [true, false]) {
  for (const replacementStatus of [401, 403]) {
    test(`bound ${initial ? 'refresh' : 'login'} replacement ${replacementStatus} is terminal before adoption`, async () => {
      const fixture = createAuthFixture({ initial, initialStatus: 401, replacementStatus })
      await assert.rejects(fixture.run(), { message: 'ACCEPTANCE_TENANT_UNVERIFIED' })
      assert.equal(fixture.token(), initial ? initialToken : '')
      assert.equal(fixture.evidence.actions, 0)
      assert.deepEqual(fixture.evidence.requests.filter(item => item.pathname !== '/api/auth/me').map(item => item.pathname),
        [initial ? '/api/auth/refresh-token' : '/api/auth/login'])
    })
  }
}

test('bound auth transport failure propagates a values-free error without fallback', async () => {
  const fixture = createAuthFixture({ authUnavailable: true })
  await assert.rejects(fixture.run(), { message: 'ACCEPTANCE_TENANT_UNVERIFIED' })
  assert.equal(fixture.evidence.actions, 0)
  assert.equal(fixture.evidence.requests.length, 1)
  assert.doesNotMatch(fixture.evidence.logs.join('\n'), /synthetic auth transport failure/)
})

test('unbound initial inconclusive validation retains its token without strict proof', async () => {
  const fixture = createAuthFixture({ bound: false, initialStatus: 503 })
  assert.equal(await fixture.resolve(), 'token')
  assert.equal(fixture.token(), initialToken)
  assert.deepEqual(fixture.evidence.proofs, [])
})

test('unbound refresh retains permissive HTTP-200 tenant-neutral validation', async () => {
  const fixture = createAuthFixture({ bound: false, initialStatus: 401 })
  assert.equal(await fixture.resolve(), 'refresh')
  assert.equal(fixture.token(), replacementToken)
  assert.deepEqual(fixture.evidence.proofs, [])
})

test('unbound login payload stays tenant-neutral', async () => {
  const fixture = createAuthFixture({ bound: false, initial: false })
  assert.equal(await fixture.resolve(), 'login')
  const login = fixture.evidence.requests.find(item => item.pathname === '/api/auth/login')
  assert.deepEqual(JSON.parse(login.body), { email: 'fixture@example.test', password: 'synthetic-password' })
  assert.deepEqual(fixture.evidence.proofs, [])
})

for (const initial of [true, false]) {
  test(`unbound ${initial ? 'refresh' : 'login'} still accepts inconclusive replacement validation`, async () => {
    const fixture = createAuthFixture({ bound: false, initial, initialStatus: 401, replacementStatus: 503 })
    assert.equal(await fixture.resolve(), initial ? 'refresh' : 'login')
    assert.equal(fixture.token(), replacementToken)
    assert.deepEqual(fixture.evidence.proofs, [])
  })
}

test('unbound auth transport failure retains the existing token', async () => {
  const fixture = createAuthFixture({ bound: false, authUnavailable: true })
  assert.equal(await fixture.resolve(), 'token')
  assert.equal(fixture.token(), initialToken)
  assert.deepEqual(fixture.evidence.proofs, [])
})
