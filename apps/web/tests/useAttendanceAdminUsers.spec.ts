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
})
