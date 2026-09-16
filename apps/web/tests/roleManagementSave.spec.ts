/**
 * 角色管理页 — 保存后的核对与并发令牌。
 *
 * The page re-reads the role catalog after a save and compares the PERSISTED permission set
 * with the one it submitted, because the backend used to answer `ok: true` while writing
 * nothing. Two ways that reconciliation can lie, both pinned here:
 *   - it must not report 「不一致」 when the RE-READ is what failed (the write said ok, the
 *     comparison then ran against the stale pre-save array and always disagreed) — a
 *     cry-wolf message teaches admins to ignore the one signal this page added;
 *   - it must still report 「不一致」 when the re-read SUCCEEDS and really disagrees.
 * Plus the mid-air-collision token: the grid is submitted together with the `updatedAt` it
 * was loaded with, and a 409 answer reloads instead of offering to replay a stale draft.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import RoleManagementView from '../src/views/RoleManagementView.vue'

const apiFetchMock = vi.fn()

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

async function flushUi(cycles = 8): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

const PERMISSIONS = [
  { code: 'stock-prep:read', name: '备料查看', description: null },
  { code: 'stock-prep:write', name: '备料写入', description: null },
]

function roleCatalog(permissions: string[], updatedAt: string | null = '2026-09-16T01:02:03.000Z') {
  return {
    ok: true,
    data: {
      items: [{ id: 'role-1', name: '备料角色', permissions, memberCount: 2, updatedAt }],
      total: 1,
    },
  }
}

type Call = { url: string; init?: { method?: string; body?: string } }

function recordedCalls(): Call[] {
  return apiFetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init: init as Call['init'] }))
}

function savedBody(): Record<string, unknown> {
  const write = recordedCalls().find((call) => call.init?.method === 'PUT' || call.init?.method === 'POST')
  if (!write?.init?.body) throw new Error('no write call recorded')
  return JSON.parse(write.init.body) as Record<string, unknown>
}

let container: HTMLElement | null = null
let app: App<Element> | null = null

function statusText(): string {
  return container?.querySelector('.admin-page__status')?.textContent?.trim() || ''
}

function clickRole(): void {
  const item = container?.querySelector('.admin-page__item') as HTMLButtonElement | null
  if (!item) throw new Error('role list item not found')
  item.click()
}

function clickSave(): void {
  const save = container?.querySelector('.admin-page__footer .admin-page__button') as HTMLButtonElement | null
  if (!save) throw new Error('save button not found')
  save.click()
}

function togglePermission(code: string): void {
  const labels = Array.from(container?.querySelectorAll('.admin-page__checkbox') || [])
  const label = labels.find((candidate) => candidate.textContent?.includes(code))
  const input = label?.querySelector('input') as HTMLInputElement | null
  if (!input) throw new Error(`checkbox for ${code} not found`)
  input.checked = !input.checked
  input.dispatchEvent(new Event('change'))
}

async function mountView(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(RoleManagementView)
  app.mount(container)
  await flushUi()
}

beforeEach(() => {
  apiFetchMock.mockReset()
})

afterEach(() => {
  if (app) app.unmount()
  app = null
  container?.remove()
  container = null
})

describe('RoleManagementView — save reconciliation', () => {
  it('does NOT claim a permission mismatch when it is the post-save RELOAD that failed', async () => {
    let rolesReads = 0
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/permissions') return jsonResponse({ ok: true, data: PERMISSIONS })
      if (url === '/api/admin/roles') {
        rolesReads += 1
        // First read seeds the page; the post-save read fails (transient 500).
        return rolesReads === 1
          ? jsonResponse(roleCatalog(['stock-prep:read']))
          : jsonResponse({ ok: false, error: { message: '加载角色失败' } }, 500)
      }
      if (init?.method === 'PUT') {
        return jsonResponse({ ok: true, data: { id: 'role-1', name: '备料角色', permissions: ['stock-prep:read', 'stock-prep:write'] } })
      }
      throw new Error(`unexpected call ${url}`)
    })

    await mountView()
    clickRole()
    await flushUi()
    togglePermission('stock-prep:write')
    await flushUi()
    clickSave()
    await flushUi()

    expect(statusText()).toBe('已保存，但无法重新加载角色目录以核对，请刷新确认')
    // the old message asserted a data loss that never happened.
    expect(statusText()).not.toContain('不一致')
  })

  it('STILL reports a mismatch when the reload SUCCEEDS and the persisted set disagrees', async () => {
    let rolesReads = 0
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/permissions') return jsonResponse({ ok: true, data: PERMISSIONS })
      if (url === '/api/admin/roles') {
        rolesReads += 1
        // The server silently dropped the submitted set — the defect this page watches for.
        return jsonResponse(roleCatalog(['stock-prep:read']))
      }
      if (init?.method === 'PUT') {
        return jsonResponse({ ok: true, data: { id: 'role-1', name: '备料角色' } })
      }
      throw new Error(`unexpected call ${url}`)
    })

    await mountView()
    clickRole()
    await flushUi()
    togglePermission('stock-prep:write')
    await flushUi()
    clickSave()
    await flushUi()

    expect(rolesReads).toBe(2)
    expect(statusText()).toContain('不一致')
  })

  it('submits the concurrency token the grid was loaded with', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/permissions') return jsonResponse({ ok: true, data: PERMISSIONS })
      if (url === '/api/admin/roles') return jsonResponse(roleCatalog(['stock-prep:read']))
      if (init?.method === 'PUT') {
        return jsonResponse({ ok: true, data: { id: 'role-1', name: '备料角色', permissions: ['stock-prep:read', 'stock-prep:write'] } })
      }
      throw new Error(`unexpected call ${url}`)
    })

    await mountView()
    clickRole()
    await flushUi()
    togglePermission('stock-prep:write')
    await flushUi()
    clickSave()
    await flushUi()

    expect(savedBody().expectedUpdatedAt).toBe('2026-09-16T01:02:03.000Z')
    // and the set as LOADED, which catches a writer that never touches roles.updated_at.
    expect(savedBody().expectedPermissions).toEqual(['stock-prep:read'])
  })

  it('a 409 ROLE_MODIFIED reloads the grid instead of replaying the stale draft', async () => {
    let rolesReads = 0
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/permissions') return jsonResponse({ ok: true, data: PERMISSIONS })
      if (url === '/api/admin/roles') {
        rolesReads += 1
        return jsonResponse(roleCatalog(rolesReads === 1 ? ['stock-prep:read'] : [], '2026-09-16T02:00:00.000Z'))
      }
      if (init?.method === 'PUT') {
        return jsonResponse({
          ok: false,
          error: { code: 'ROLE_MODIFIED', message: 'This role changed since it was loaded; reload it and re-apply the change' },
        }, 409)
      }
      throw new Error(`unexpected call ${url}`)
    })

    await mountView()
    clickRole()
    await flushUi()
    togglePermission('stock-prep:write')
    await flushUi()
    clickSave()
    await flushUi()

    expect(rolesReads).toBe(2)
    expect(statusText()).toBe('该角色已被其他人修改，已重新加载最新权限，请确认后再保存')
    // the raw server sentence must not be what the admin reads.
    expect(statusText()).not.toContain('This role changed')
  })

  it('a clean save still reports success', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/permissions') return jsonResponse({ ok: true, data: PERMISSIONS })
      if (url === '/api/admin/roles') {
        const permissions = recordedCalls().some((call) => call.init?.method === 'PUT')
          ? ['stock-prep:read', 'stock-prep:write']
          : ['stock-prep:read']
        return jsonResponse(roleCatalog(permissions))
      }
      if (init?.method === 'PUT') {
        return jsonResponse({ ok: true, data: { id: 'role-1', name: '备料角色', permissions: ['stock-prep:read', 'stock-prep:write'] } })
      }
      throw new Error(`unexpected call ${url}`)
    })

    await mountView()
    clickRole()
    await flushUi()
    togglePermission('stock-prep:write')
    await flushUi()
    clickSave()
    await flushUi()

    expect(statusText()).toBe('角色已更新')
  })
})
