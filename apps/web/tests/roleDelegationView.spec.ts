import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import RoleDelegationView from '../src/views/RoleDelegationView.vue'

const apiFetchMock = vi.fn()

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

async function flushUi(cycles = 16): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function waitForCondition(predicate: () => boolean, attempts = 40): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    await flushUi(2)
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('Condition not reached in time')
}

function createJsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(text))
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`)
  }
  return button
}

describe('RoleDelegationView', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    apiFetchMock.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  it('clears stale selected member group after searching to an empty result set', async () => {
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          actorId: 'admin-1',
          isPlatformAdmin: true,
          delegableNamespaces: [],
          roleCatalog: [],
          scopeAssignments: [],
          groupAssignments: [],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: { items: [] },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [{
            id: 'group-1',
            name: '制造中心',
            description: '制造中心成员集',
            createdBy: 'admin-1',
            updatedBy: 'admin-1',
            createdAt: '2026-04-09T00:00:00.000Z',
            updatedAt: '2026-04-09T00:00:00.000Z',
            memberCount: 1,
          }],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          item: {
            id: 'group-1',
            name: '制造中心',
            description: '制造中心成员集',
            createdBy: 'admin-1',
            updatedBy: 'admin-1',
            createdAt: '2026-04-09T00:00:00.000Z',
            updatedAt: '2026-04-09T00:00:00.000Z',
            memberCount: 1,
            members: [],
          },
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [{
            id: 'user-1',
            email: 'alpha@example.com',
            name: 'Alpha',
            role: 'user',
            is_active: true,
          }],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          actorId: 'admin-1',
          isPlatformAdmin: true,
          delegableNamespaces: [],
          roleCatalog: [],
          scopeAssignments: [],
          groupAssignments: [],
          user: {
            id: 'user-1',
            email: 'alpha@example.com',
            name: 'Alpha',
            role: 'user',
            is_active: true,
          },
          roles: [],
          memberGroups: [],
          delegableRoles: [],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          actorId: 'admin-1',
          user: {
            id: 'user-1',
            email: 'alpha@example.com',
            name: 'Alpha',
            role: 'user',
            is_active: true,
          },
          adminNamespaces: [],
          scopeAssignments: [],
          groupAssignments: [],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          item: {
            id: 'group-1',
            name: '制造中心',
            description: '制造中心成员集',
            createdBy: 'admin-1',
            updatedBy: 'admin-1',
            createdAt: '2026-04-09T00:00:00.000Z',
            updatedAt: '2026-04-09T00:00:00.000Z',
            memberCount: 1,
            members: [],
          },
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: { items: [] },
      }))

    app = createApp(RoleDelegationView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await waitForCondition(() => apiFetchMock.mock.calls.length >= 8)

    const searchInput = container?.querySelector('input[placeholder="搜索成员集"]')
    expect(searchInput).toBeTruthy()
    ;(searchInput as HTMLInputElement).value = 'does-not-exist'
    searchInput?.dispatchEvent(new Event('input'))
    await flushUi()

    findButtonByText(container!, '查询成员集').click()
    await waitForCondition(() => apiFetchMock.mock.calls.length >= 9)

    const assignButton = findButtonByText(container!, '将当前成员加入成员集')
    expect(assignButton.disabled).toBe(true)
    expect(container?.textContent).not.toContain('制造中心成员集')
  })
})
