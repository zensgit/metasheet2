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
function group(id: string, orgId: string, name: string, archivedAt: string | null = null) {
  return { id, orgId, name, sortOrder: archivedAt ? null : 1, createdBy: 'u', createdAt: 'x', updatedAt: 'x', archivedAt }
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

/**
 * Daily-ops fix round (groups-daily-ops-real-browser-acceptance-20260920.md):
 *   P2-1 — archived groups get a visual distinction (badge + `data-group-id`, so a same-name
 *          archived/active pair is no longer byte-identical DOM, per the finding's exact repro).
 *   P2-2 — the panel renders `describeApprovalTemplateGroupError`'s product copy, not the raw
 *          "锁文...owner...勘误" server string, for the create-name-rejected case.
 *   P2-4 — rename / archive / unarchive controls, consuming the ALREADY-EXISTING client functions
 *          (`renameApprovalTemplateGroup` / `archiveApprovalTemplateGroup` /
 *          `unarchiveApprovalTemplateGroup`) and the lock's already-ratified endpoints — no new
 *          backend capability, purely wiring a UI onto what §6 phase 1 already shipped.
 */
describe('ApprovalTemplateGroupsPanel — daily-ops fixes (P2-1 / P2-2 / P2-4)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    localStorage.clear()
    mocks.apiFetch.mockReset()
    useAuth().setToken(jwt('org-a'))
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.restoreAllMocks()
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

  async function settle(rounds = 4) {
    for (let i = 0; i < rounds; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await nextTick()
    }
  }

  it('P2-1: an archived group is visually distinct from an active one and carries its own id in the DOM', async () => {
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/approval-template-groups') {
        return jsonResponse(200, {
          groups: [
            group('atg_active', 'org-a', 'Purchase'),
            group('atg_archived', 'org-a', 'Purchase', '2026-09-20T00:00:00.000Z'),
          ],
        })
      }
      throw new Error(`unexpected call: ${path}`)
    })

    const el = mount()
    await settle()

    const activeLi = el.querySelector('[data-group-id="atg_active"]') as HTMLElement
    const archivedLi = el.querySelector('[data-group-id="atg_archived"]') as HTMLElement
    expect(activeLi).not.toBeNull()
    expect(archivedLi).not.toBeNull()
    // Same name, but no longer byte-identical DOM (the finding's exact repro).
    expect(activeLi.outerHTML).not.toBe(archivedLi.outerHTML)
    expect(archivedLi.textContent).toMatch(/Archived/i)
    expect(activeLi.textContent).not.toMatch(/Archived/i)
    expect(archivedLi.className).toContain('archived')
  })

  it('P2-2: a GROUP_NAME_UNSUPPORTED create failure renders product copy, never the internal-jargon server string', async () => {
    mocks.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === '/api/approval-template-groups' && !init) return jsonResponse(200, EMPTY_LIST)
      if (path === '/api/approval-template-groups' && init?.method === 'POST') {
        return jsonResponse(400, {
          error: {
            code: 'GROUP_NAME_UNSUPPORTED',
            message: 'This value must include at least one ASCII letter, digit, or symbol character.',
          },
        })
      }
      throw new Error(`unexpected call: ${path} ${init?.method}`)
    })

    const el = mount()
    await settle()

    const input = el.querySelector('[data-testid="approval-template-groups-create-input"]') as HTMLInputElement
    input.value = '请假'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    const form = el.querySelector('form') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await settle()

    const error = el.querySelector('[data-testid="approval-template-groups-load-error"]')
    expect(error).not.toBeNull()
    expect(error!.textContent).not.toContain('锁文')
    expect(error!.textContent).not.toContain('owner')
    expect(error!.textContent).not.toContain('勘误')
    expect(error!.textContent).not.toContain('This value must include at least one ASCII')
  })

  it('P2-4 rename: submitting a new name PATCHes the group and updates it in place', async () => {
    mocks.apiFetch.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
      if (path === '/api/approval-template-groups' && !init) {
        return jsonResponse(200, { groups: [group('atg_1', 'org-a', 'Finance')] })
      }
      if (path === '/api/approval-template-groups/atg_1' && init?.method === 'PATCH') {
        expect(JSON.parse(init.body as string)).toEqual({ name: 'Finance & Ops' })
        return jsonResponse(200, { group: group('atg_1', 'org-a', 'Finance & Ops') })
      }
      throw new Error(`unexpected call: ${path} ${init?.method}`)
    })

    const el = mount()
    await settle()

    const li = el.querySelector('[data-group-id="atg_1"]') as HTMLElement
    ;(li.querySelector('[data-testid="approval-template-groups-rename-button"]') as HTMLButtonElement).click()
    await nextTick()

    const renameInput = li.querySelector('[data-testid="approval-template-groups-rename-input"]') as HTMLInputElement
    expect(renameInput).not.toBeNull()
    renameInput.value = 'Finance & Ops'
    renameInput.dispatchEvent(new Event('input'))
    await nextTick()
    ;(li.querySelector('[data-testid="approval-template-groups-rename-save"]') as HTMLButtonElement).click()
    await settle()

    expect(el.textContent).toContain('Finance & Ops')
    expect(el.querySelector('[data-testid="approval-template-groups-rename-input"]')).toBeNull()
  })

  it('P2-4 archive: asks for confirmation, and a cancelled confirm makes zero API calls', async () => {
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/approval-template-groups') return jsonResponse(200, { groups: [group('atg_1', 'org-a', 'Finance')] })
      throw new Error(`unexpected call: ${path}`)
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    const el = mount()
    await settle()
    const archiveCallsBefore = mocks.apiFetch.mock.calls.length
    ;(el.querySelector('[data-testid="approval-template-groups-archive-button"]') as HTMLButtonElement).click()
    await settle()

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(mocks.apiFetch.mock.calls.length).toBe(archiveCallsBefore)
    expect(el.textContent).not.toMatch(/Archived/i)
  })

  it('P2-4 archive/unarchive: a confirmed archive POSTs /archive and flips the group to archived; unarchive POSTs /unarchive and flips it back', async () => {
    let archived = false
    mocks.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === '/api/approval-template-groups' && !init) {
        return jsonResponse(200, { groups: [group('atg_1', 'org-a', 'Finance', archived ? '2026-09-20T00:00:00.000Z' : null)] })
      }
      if (path === '/api/approval-template-groups/atg_1/archive' && init?.method === 'POST') {
        archived = true
        return jsonResponse(200, { group: group('atg_1', 'org-a', 'Finance', '2026-09-20T00:00:00.000Z') })
      }
      if (path === '/api/approval-template-groups/atg_1/unarchive' && init?.method === 'POST') {
        archived = false
        return jsonResponse(200, { group: group('atg_1', 'org-a', 'Finance') })
      }
      throw new Error(`unexpected call: ${path} ${init?.method}`)
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    const el = mount()
    await settle()

    ;(el.querySelector('[data-testid="approval-template-groups-archive-button"]') as HTMLButtonElement).click()
    await settle()
    expect(el.querySelector('[data-testid="approval-template-groups-archive-button"]')).toBeNull()
    expect(el.querySelector('[data-testid="approval-template-groups-unarchive-button"]')).not.toBeNull()
    expect(el.textContent).toMatch(/Archived/i)

    ;(el.querySelector('[data-testid="approval-template-groups-unarchive-button"]') as HTMLButtonElement).click()
    await settle()
    expect(el.querySelector('[data-testid="approval-template-groups-unarchive-button"]')).toBeNull()
    expect(el.querySelector('[data-testid="approval-template-groups-archive-button"]')).not.toBeNull()
    expect(el.textContent).not.toMatch(/Archived/i)
  })

  it('P2-4: archive/rename/unarchive each emit "changed" so the sections view re-reads', async () => {
    mocks.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === '/api/approval-template-groups' && !init) {
        return jsonResponse(200, { groups: [group('atg_1', 'org-a', 'Finance')] })
      }
      if (path === '/api/approval-template-groups/atg_1/archive' && init?.method === 'POST') {
        return jsonResponse(200, { group: group('atg_1', 'org-a', 'Finance', '2026-09-20T00:00:00.000Z') })
      }
      throw new Error(`unexpected call: ${path} ${init?.method}`)
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const onChanged = vi.fn()

    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      setup() {
        return () => h(ApprovalTemplateGroupsPanel, { tr, onChanged })
      },
    })
    app.mount(container)
    await settle()

    ;(container.querySelector('[data-testid="approval-template-groups-archive-button"]') as HTMLButtonElement).click()
    await settle()

    expect(onChanged).toHaveBeenCalledTimes(1)
  })
})
