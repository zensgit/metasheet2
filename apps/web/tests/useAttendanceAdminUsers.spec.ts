import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useAttendanceAdminUsers, type AttendanceAdminUserSearchItem } from '../src/views/attendance/useAttendanceAdminUsers'

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response
}

describe('useAttendanceAdminUsers', () => {
  it('loads admin users and preserves the currently selected value in the list', async () => {
    const apiFetch = vi.fn().mockResolvedValue(jsonResponse(200, {
      ok: true,
      data: {
        items: [
          {
            id: 'user-1',
            email: 'alice@example.com',
            name: 'Alice',
            role: 'user',
            is_active: true,
            is_admin: false,
            last_login_at: null,
            created_at: '2026-03-20T00:00:00.000Z',
          },
        ],
      },
    }))

    const users = useAttendanceAdminUsers({ apiFetch, tr: (en: string) => en })
    users.searchQuery.value = 'alice'

    await users.loadUsers()

    expect(apiFetch).toHaveBeenCalledWith('/api/admin/users?q=alice')
    expect(users.users.value).toHaveLength(1)
    expect(users.formatUserLabel(users.users.value[0] as AttendanceAdminUserSearchItem)).toBe('Alice · alice@example.com')
  })

  it('keeps working when a user has no email (#6344: the server answers null for the optional email)', async () => {
    const apiFetch = vi.fn().mockResolvedValue(jsonResponse(200, {
      ok: true,
      data: {
        items: [
          { id: 'user-2', email: null, name: 'Bob', role: 'user', is_active: true, is_admin: false, last_login_at: null, created_at: '2026-10-08T00:00:00.000Z' },
          { id: 'user-3', email: null, name: null, role: 'user', is_active: true, is_admin: false, last_login_at: null, created_at: '2026-10-08T00:00:00.000Z' },
          { id: 'user-4', email: 'carol@example.com', name: null, employeeNo: 'E4', role: 'user', is_active: true, is_admin: false, last_login_at: null, created_at: '2026-10-08T00:00:00.000Z' },
        ],
      },
    }))

    const users = useAttendanceAdminUsers({ apiFetch, tr: (en: string) => en })
    await users.loadUsers()

    expect(users.statusMessage.value).toBe('')
    expect(users.users.value.map((user) => user.email)).toEqual(['', '', 'carol@example.com'])
    const labels = users.users.value.map((user) => users.formatUserLabel(user as AttendanceAdminUserSearchItem))
    expect(labels).toEqual(['Bob · user-2', 'Unnamed employee · ID: user-3', 'carol@example.com · E4 · user-4'])
    // The formatter is null-safe on its own too (an item that bypassed the loader).
    expect(users.formatUserLabel({ id: 'user-5', email: null as unknown as string, name: 'Dan', role: 'user', is_active: true, is_admin: false, last_login_at: null, created_at: '' })).toBe('Dan · user-5')
  })

  it('distinguishes genuine blank identities, supplied name=id and retained technical placeholders', () => {
    const directory = useAttendanceAdminUsers({ tr: (en) => en })
    const user: AttendanceAdminUserSearchItem = {
      id: 'opaque-person', name: null, email: '', role: 'user', created_at: '2026-01-01',
      is_active: true, is_admin: false, last_login_at: null,
    }
    expect(directory.formatUserLabel(user)).toBe('Unnamed employee · ID: opaque-person')
    expect(directory.formatUserLabel({ ...user, name: 'opaque-person' })).toBe('opaque-person')
    expect(directory.formatUserLabel({ ...user, name: '  ', email: '  ' })).toBe('Unnamed employee · ID: opaque-person')
    expect(directory.formatUserLabel({ ...user, name: 'Alice', email: 'alice@example.com' })).toBe('Alice · alice@example.com')
    expect(directory.formatUserLabel({ ...user, name: null, email: user.id, role: '', created_at: '' })).toBe('Current value: opaque-person')
  })

  it.each(['org', 'global'] as const)('rejects a late JSON directory response after %s scope A-B-A', async (scope) => {
    const orgId = ref('org-A')
    const globalScope = ref(false)
    let resolve!: (value: unknown) => void
    const body = new Promise<unknown>((yes) => { resolve = yes })
    const directory = useAttendanceAdminUsers({
      orgId, globalScope, endpoint: '/api/attendance-admin/users/search',
      apiFetch: vi.fn().mockResolvedValue({ ...jsonResponse(200, {}), json: () => body }),
    })
    const loading = directory.loadUsers('Alice')
    await Promise.resolve()
    if (scope === 'org') { orgId.value = 'org-B'; orgId.value = 'org-A' }
    else { globalScope.value = true; globalScope.value = false }
    resolve({ ok: true, data: { items: [{ id: 'old-person', name: 'Old Alice', email: '' }] } })
    await loading
    expect(directory.users.value).toEqual([])
    expect(directory.loading.value).toBe(false)
    expect(directory.statusMessage.value).toBe('')
  })

  it('injects the current value as a selectable placeholder when it is not part of the results', async () => {
    const apiFetch = vi.fn().mockResolvedValue(jsonResponse(200, {
      ok: true,
      data: {
        items: [],
      },
    }))

    const users = useAttendanceAdminUsers({ apiFetch, tr: (en: string) => en })
    users.ensureSelectedUserVisible('user-99')

    expect(users.users.value[0]).toMatchObject({
      id: 'user-99',
      email: 'user-99',
    })
    expect(users.formatUserLabel(users.users.value[0] as AttendanceAdminUserSearchItem)).toBe('Current value: user-99')
  })

  it('reports admin permission failures without throwing', async () => {
    const adminForbidden = ref(false)
    const apiFetch = vi.fn().mockResolvedValue(jsonResponse(403, { ok: false }))

    const users = useAttendanceAdminUsers({ apiFetch, adminForbidden, tr: (en: string) => en })
    await users.loadUsers()

    expect(adminForbidden.value).toBe(true)
    expect(users.statusMessage.value).toBe('Admin permissions required')
  })

  it('fails closed without an org and follows the reactive org for attendance-scoped search', async () => {
    const apiFetch = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, data: { items: [] } }))
    const orgId = ref<string | undefined>(undefined)
    const users = useAttendanceAdminUsers({
      apiFetch,
      endpoint: '/api/attendance-admin/users/search',
      orgId,
      tr: (en: string) => en,
    })

    await users.loadUsers('alice')
    expect(apiFetch).not.toHaveBeenCalled()
    expect(users.statusMessage.value).toBe('Select an organization first')

    orgId.value = 'org-a'
    await users.loadUsers('alice')
    expect(apiFetch).toHaveBeenCalledWith('/api/attendance-admin/users/search?q=alice&orgId=org-a')
  })

  it('uses explicit global scope only when the caller identifies a platform administrator', async () => {
    const apiFetch = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, data: { items: [] } }))
    const globalScope = ref(true)
    const users = useAttendanceAdminUsers({
      apiFetch,
      endpoint: '/api/attendance-admin/users/search',
      globalScope,
      tr: (en: string) => en,
    })

    await users.loadUsers('alice')

    expect(apiFetch).toHaveBeenCalledWith('/api/attendance-admin/users/search?q=alice&scope=global')
  })
})
