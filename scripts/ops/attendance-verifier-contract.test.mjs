import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import * as preflight from './attendance-acceptance-preflight.mjs'

import { selectAttendanceAdminWorkspaceSection } from './attendance-admin-navigation.mjs'
import { buildAttendanceAdminDirectoryRequests } from './attendance-smoke-api.mjs'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const hiddenQuickJumpSelector = '[data-admin-quick-jump="true"]'
const visibleQuickJumpSelector = `${hiddenQuickJumpSelector}:visible`

function createAdminPage({ workspaceVisible }) {
  const state = {
    workspaceVisible,
    taskActionVisible: !workspaceVisible,
    quickJumpVisible: workspaceVisible,
  }
  const events = []

  const workspace = {
    first: () => workspace,
    isVisible: async () => state.workspaceVisible,
    waitFor: async ({ state: expected }) => {
      assert.equal(expected, 'visible')
      assert.equal(state.workspaceVisible, true)
      events.push('workspace.visible')
    },
  }
  const taskAction = {
    first: () => taskAction,
    waitFor: async ({ state: expected }) => {
      assert.equal(expected, 'visible')
      assert.equal(state.taskActionVisible, true)
      events.push('task-action.visible')
    },
    click: async () => {
      state.workspaceVisible = true
      state.quickJumpVisible = true
      events.push('task-action.click')
    },
  }
  const visibleQuickJump = {
    first: () => visibleQuickJump,
    waitFor: async ({ state: expected }) => {
      assert.equal(expected, 'visible')
      assert.equal(state.quickJumpVisible, true)
      events.push('quick-jump.visible')
    },
    selectOption: async (sectionId) => {
      assert.equal(state.quickJumpVisible, true)
      events.push(`quick-jump.select:${sectionId}`)
    },
  }
  const hiddenQuickJump = {
    first: () => hiddenQuickJump,
    waitFor: async () => {
      throw new Error('hidden quick jump must not be used')
    },
    selectOption: async () => {
      throw new Error('hidden quick jump must not be selected')
    },
  }

  return {
    events,
    page: {
      locator(selector) {
        if (selector === '[data-admin-section-workspace="true"]') return workspace
        if (selector === 'button[data-admin-task-action]:visible') return taskAction
        if (selector === visibleQuickJumpSelector) return visibleQuickJump
        if (selector === hiddenQuickJumpSelector) return hiddenQuickJump
        throw new Error(`unexpected selector: ${selector}`)
      },
    },
  }
}

test('leaves an already-visible admin workspace alone and selects through its visible quick jump', async () => {
  const fixture = createAdminPage({ workspaceVisible: true })

  await selectAttendanceAdminWorkspaceSection(fixture.page, 'attendance-admin-import', 1000)

  assert.deepEqual(fixture.events, [
    'quick-jump.visible',
    'quick-jump.select:attendance-admin-import',
  ])
})

test('opens task-home workspace before selecting a section and never uses its hidden quick jump', async () => {
  const fixture = createAdminPage({ workspaceVisible: false })

  await selectAttendanceAdminWorkspaceSection(fixture.page, 'attendance-admin-user-access', 1000)

  assert.deepEqual(fixture.events, [
    'task-action.visible',
    'task-action.click',
    'workspace.visible',
    'quick-jump.visible',
    'quick-jump.select:attendance-admin-user-access',
  ])
})

test('does not swallow an unexpected task-home navigation error', async () => {
  const fixture = createAdminPage({ workspaceVisible: false })
  fixture.page.locator = (selector) => {
    if (selector === 'button[data-admin-task-action]:visible') {
      return {
        first: () => ({
          waitFor: async () => {
            throw new Error('synthetic navigation failure')
          },
        }),
      }
    }
    if (selector === '[data-admin-section-workspace="true"]') {
      return {
        first: () => ({ isVisible: async () => false }),
      }
    }
    throw new Error(`unexpected selector: ${selector}`)
  }

  await assert.rejects(
    selectAttendanceAdminWorkspaceSection(fixture.page, 'attendance-admin-import', 1000),
    /synthetic navigation failure/,
  )
})

test('builds global scope only for attendance-admin directory calls', () => {
  const requests = buildAttendanceAdminDirectoryRequests(
    'admin@example.test',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  )
  const search = new URL(requests.searchPath, 'https://verifier.invalid')

  assert.equal(search.pathname, '/attendance-admin/users/search')
  assert.equal(search.searchParams.get('q'), 'admin@example.test')
  assert.equal(search.searchParams.get('pageSize'), '5')
  assert.equal(search.searchParams.get('scope'), 'global')
  assert.equal(search.searchParams.has('orgId'), false)
  assert.equal(requests.batchResolve.path, '/attendance-admin/users/batch/resolve')
  assert.deepEqual(JSON.parse(requests.batchResolve.init.body), {
    userIds: [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ],
    scope: 'global',
  })
})

test('both Playwright verifiers use the shared visible-workspace navigation helper', () => {
  for (const relativePath of [
    'scripts/verify-attendance-production-flow.mjs',
    'scripts/verify-attendance-full-flow.mjs',
  ]) {
    const source = readFileSync(path.join(repoRoot, relativePath), 'utf8')
    assert.match(source, /import \{ selectAttendanceAdminWorkspaceSection \} from '\.\/ops\/attendance-admin-navigation\.mjs'/)
    assert.match(source, /await selectAttendanceAdminWorkspaceSection\(page, sectionId, /)
  }
})

function actualFunction(source, name) {
  const start = source.indexOf(`async function ${name}(`)
  assert.ok(start >= 0, name)
  const end = source.indexOf('\n}', start)
  assert.ok(end > start, name)
  return source.slice(start, end + 2)
}

const consumers = ['scripts/ops/attendance-smoke-api.mjs', 'scripts/verify-attendance-production-flow.mjs', 'scripts/verify-attendance-full-flow.mjs']
const apiBase = 'https://acceptance.invalid/api'
const initialToken = 'synthetic-existing-token-only'
const nextToken = 'synthetic-refreshed-token-only'

function consumerFixture(file, { payload, refreshAvailable = true }) {
  const source = readFileSync(path.join(repoRoot, file), 'utf8')
  const evidence = { actions: 0, proofTokens: [] }
  const action = () => { evidence.actions++; throw new Error('ACCEPTANCE_ACTION_REACHED') }
  const refresh = async () => ({ ok: refreshAvailable, status: refreshAvailable ? 200 : 401, text: async () => JSON.stringify({ success: refreshAvailable, data: { token: nextToken } }) })
  const context = vm.createContext({
    apiBase, token: initialToken, apiBaseEnv: apiBase, webUrl: 'https://acceptance.invalid/attendance',
    log() {}, logInfo() {}, logWarn() {}, normalizeUrl: value => value, normalizeWebAttendanceUrl: value => value,
    deriveApiBase: () => apiBase, deriveApiBaseFromWebUrl: () => apiBase, decodeJwtPayload: () => ({ userId: 'fixture-user' }),
    fetch: refresh, fetchWithRetry: refresh, apiFetch: action, apiGetJson: action, parseFeatures: action, featuresJson: '',
    AcceptanceTenantError: preflight.AcceptanceTenantError,
    verifyAcceptanceTokenTenant: (base, candidate) => preflight.verifyAcceptanceTokenTenant(base, candidate, {
      env: { AUTH_EXPECTED_TENANT_ID: 'fixture-org' },
      fetchImpl: async (_url, options) => {
        evidence.proofTokens.push(options.headers.Authorization)
        return { status: 200, json: async () => payload }
      },
    }),
  })
  vm.runInContext(`${actualFunction(source, 'refreshAuthToken')}\n${actualFunction(source, 'run')}`, context)
  return { evidence, context, refresh: () => vm.runInContext('refreshAuthToken(apiBase)', context), run: () => vm.runInContext('run()', context) }
}

for (const file of consumers) {
  for (const [name, payload] of [
    ['missing tenant', { success: true, data: { user: {} } }],
    ['wrong tenant', { success: true, data: { user: { tenantId: 'wrong-org' } } }],
    ['unsuccessful envelope', { success: false }],
    ['malformed envelope', null],
  ]) {
    test(`${file} refuses ${name} before refreshed-token adoption or any action`, async () => {
      const fixture = consumerFixture(file, { payload })
      await assert.rejects(fixture.run(), /ACCEPTANCE_TENANT_UNVERIFIED/)
      assert.equal(fixture.context.token, initialToken)
      assert.equal(fixture.evidence.actions, 0)
      assert.deepEqual(fixture.evidence.proofTokens, [`Bearer ${nextToken}`])
    })
  }
  test(`${file} verifies unchanged token when refresh is unavailable`, async () => {
    const fixture = consumerFixture(file, { payload: { success: true, data: { user: {} } }, refreshAvailable: false })
    await assert.rejects(fixture.run(), /ACCEPTANCE_TENANT_UNVERIFIED/)
    assert.equal(fixture.evidence.actions, 0)
    assert.deepEqual(fixture.evidence.proofTokens, [`Bearer ${initialToken}`])
  })
  test(`${file} accepts only a verified refreshed token and rechecks before actions`, async () => {
    const fixture = consumerFixture(file, { payload: { success: true, data: { user: { tenantId: 'fixture-org' } } } })
    await assert.rejects(fixture.run(), /ACCEPTANCE_ACTION_REACHED/)
    assert.equal(fixture.context.token, nextToken)
    assert.deepEqual(fixture.evidence.proofTokens, [`Bearer ${nextToken}`, `Bearer ${nextToken}`])
    assert.equal(fixture.evidence.actions, 1)
  })
}

test('full-flow feature fallback never swallows a refreshed-token tenant failure', async () => {
  const fixture = consumerFixture(consumers[2], { payload: { success: true, data: { user: { tenantId: 'fixture-org' } } } })
  fixture.context.parseFeatures = () => null
  fixture.context.fetchAuthMeFeatures = async () => { throw new preflight.AcceptanceTenantError() }
  await assert.rejects(fixture.run(), /ACCEPTANCE_TENANT_UNVERIFIED/)
  assert.equal(fixture.evidence.actions, 0)
})

for (const name of ['fetchAuthMeFeatures', 'resolveRecoveryUserId']) {
  test(`full-flow ${name} stops on token proof failure instead of retrying or returning a fallback`, async () => {
    const source = readFileSync(path.join(repoRoot, consumers[2]), 'utf8')
    let calls = 0
    const context = vm.createContext({
      token: initialToken, apiBase, normalizeUrl: value => value, authMeRetries: 2, authMeTimeoutMs: 100,
      AcceptanceTenantError: preflight.AcceptanceTenantError,
      fetch: async () => { calls++; return { ok: false, status: 401, text: async () => '{}', json: async () => ({}) } },
      refreshAuthToken: async () => { throw new preflight.AcceptanceTenantError() },
    })
    vm.runInContext(actualFunction(source, name), context)
    await assert.rejects(vm.runInContext(`${name}(apiBase)`, context), /ACCEPTANCE_TENANT_UNVERIFIED/)
    assert.equal(calls, 1)
  })
}
