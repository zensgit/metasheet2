import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App as VueApp } from 'vue'
import { useAuth } from '../src/composables/useAuth'
import ApprovalTemplateGroupsPanel from '../src/views/approval/ApprovalTemplateGroupsPanel.vue'

/**
 * A-2 scope item 4 (approval form grouping design lock v2.13 §4 acceptance J, 2026-09-18):
 * exercises the panel's own SESSION_ORG_REQUIRED → SessionOrgSwitcher → retry loop end to end,
 * through the real `useSessionOrg`/`useAuth` composables (only the shared `apiFetch` module is
 * mocked — same seam `useSessionOrg.spec.ts` establishes) rather than mocking the composable
 * itself, so the mutation below actually exercises the panel's own branch.
 */
const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('../src/utils/api', () => ({ apiFetch: mocks.apiFetch, getApiBase: () => '' }))

const tr = (en: string, _zh: string) => en

const jwt = (org: string) =>
  `header.${btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

const EMPTY_LIST = { groups: [] }
function group(id: string, orgId: string, name: string) {
  return { id, orgId, name, sortOrder: 1, createdBy: 'u', createdAt: 'x', updatedAt: 'x', archivedAt: null }
}

describe('ApprovalTemplateGroupsPanel — acceptance J (design lock v2.13 §4)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    localStorage.clear()
    mocks.apiFetch.mockReset()
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  function mount() {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      setup() {
        return () => h(ApprovalTemplateGroupsPanel, { tr })
      },
    })
    app.mount(container)
    return container
  }

  // Drains both the microtask queue (the api.ts await chain: apiFetch -> response.json() ->
  // caller unwrap) and Vue's render scheduler, across several macrotask turns — a fixed count of
  // `nextTick()` alone was empirically one or two turns short of the full chain settling.
  async function settle(rounds = 4) {
    for (let i = 0; i < rounds; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await nextTick()
    }
  }

  it('single-org member: list loads clean on mount, the selector is never shown, and no session-org call is ever made', async () => {
    useAuth().setToken(jwt('org-a'))
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/approval-template-groups') {
        return jsonResponse(200, { groups: [group('atg_1', 'org-a', 'Finance')] })
      }
      throw new Error(`unexpected call: ${path}`)
    })

    const el = mount()
    await settle()

    expect(el.querySelector('[data-testid="session-org-switcher"]')).toBeNull()
    expect(el.textContent).toContain('Finance')
    expect(mocks.apiFetch.mock.calls.some(([path]) => String(path).startsWith('/api/auth/session-org'))).toBe(false)
  })

  it('a 403 SESSION_ORG_REQUIRED on create shows the switcher; selecting an org retries the SAME create and gets 201', async () => {
    useAuth().setToken(jwt('org-a'))
    let createAttempts = 0
    mocks.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === '/api/approval-template-groups' && !init) {
        return jsonResponse(200, EMPTY_LIST)
      }
      if (path === '/api/approval-template-groups' && init?.method === 'POST') {
        createAttempts += 1
        if (createAttempts === 1) {
          return jsonResponse(403, { error: { code: 'SESSION_ORG_REQUIRED', message: 'An authenticated session organization is required' } })
        }
        return jsonResponse(201, { group: group('atg_2', 'org-b', 'Ops') })
      }
      if (path === '/api/auth/session-orgs') {
        return jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: null } })
      }
      if (path === '/api/auth/session-org' && init?.method === 'POST') {
        return jsonResponse(200, { success: true, data: { currentOrgId: 'org-b', token: jwt('org-b') } })
      }
      throw new Error(`unexpected call: ${path} ${init?.method}`)
    })

    const el = mount()
    await settle()

    const input = el.querySelector('[data-testid="approval-template-groups-create-input"]') as HTMLInputElement
    input.value = 'Ops'
    input.dispatchEvent(new Event('input'))
    await nextTick()

    const form = el.querySelector('form') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await settle()

    // 403 blocked the create — the switcher is now up, and the group never rendered.
    expect(el.querySelector('[data-testid="session-org-switcher"]')).not.toBeNull()
    expect(el.textContent).not.toContain('Ops')

    const select = el.querySelector('select[name="sessionOrgId"]') as HTMLSelectElement
    select.value = 'org-b'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await settle(6)

    expect(createAttempts).toBe(2)
    expect(el.querySelector('[data-testid="session-org-switcher"]')).toBeNull()
    expect(el.textContent).toContain('Ops')
  })

  it('a 403 SESSION_ORG_REQUIRED on the initial mount-time list load shows the switcher; selecting an org retries the SAME list load', async () => {
    // Distinct from the create-flow case above: this drives the `loadGroups()` catch branch
    // specifically (mount-time GET), which that test's mock never 403s on (its GET always
    // resolves 200 with an empty list) — so a mutation only on `loadGroups`'s branch would pass
    // every other case in this file untouched. This case is what gives that branch discriminating
    // power.
    useAuth().setToken(jwt('org-a'))
    let listAttempts = 0
    mocks.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === '/api/approval-template-groups' && !init) {
        listAttempts += 1
        if (listAttempts === 1) {
          return jsonResponse(403, { error: { code: 'SESSION_ORG_REQUIRED', message: 'An authenticated session organization is required' } })
        }
        return jsonResponse(200, { groups: [group('atg_3', 'org-b', 'Legal')] })
      }
      if (path === '/api/auth/session-orgs') {
        return jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: null } })
      }
      if (path === '/api/auth/session-org' && init?.method === 'POST') {
        return jsonResponse(200, { success: true, data: { currentOrgId: 'org-b', token: jwt('org-b') } })
      }
      throw new Error(`unexpected call: ${path} ${init?.method}`)
    })

    const el = mount()
    await settle()

    expect(listAttempts).toBe(1)
    expect(el.querySelector('[data-testid="session-org-switcher"]')).not.toBeNull()
    expect(el.textContent).not.toContain('Legal')

    const select = el.querySelector('select[name="sessionOrgId"]') as HTMLSelectElement
    select.value = 'org-b'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await settle(6)

    expect(listAttempts).toBe(2)
    expect(el.querySelector('[data-testid="session-org-switcher"]')).toBeNull()
    expect(el.textContent).toContain('Legal')
  })
})
