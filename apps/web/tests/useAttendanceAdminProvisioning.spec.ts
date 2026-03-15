import { nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '../src/utils/api'
import {
  parseAttendanceAdminUserIdList,
  useAttendanceAdminProvisioning,
} from '../src/views/attendance/useAttendanceAdminProvisioning'

vi.mock('../src/utils/api', () => ({
  apiFetch: vi.fn(),
}))

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response
}

const tr = (en: string, _zh: string) => en

describe('useAttendanceAdminProvisioning', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('parses unique UUID user ids and reports invalid values', () => {
    const validA = '11111111-1111-4111-8111-111111111111'
    const validB = '22222222-2222-4222-8222-222222222222'
    expect(
      parseAttendanceAdminUserIdList(`${validA}\n${validA}, invalid-id ; ${validB}`),
    ).toEqual({
      valid: [validA, validB],
      invalid: ['invalid-id'],
    })
  })

  it('falls back to the legacy permissions endpoint when access snapshot is unavailable', async () => {
    const validUserId = '11111111-1111-4111-8111-111111111111'
    const adminForbidden = ref(false)
    const provisioning = useAttendanceAdminProvisioning({ adminForbidden, tr })
    const apiFetchMock = vi.mocked(apiFetch)

    apiFetchMock.mockImplementation(async (path: string) => {
      const url = String(path)
      if (url === `/api/attendance-admin/users/${encodeURIComponent(validUserId)}/access`) {
        return jsonResponse(404, {
          ok: false,
          error: { message: 'not found' },
        })
      }
      if (url === `/api/permissions/user/${encodeURIComponent(validUserId)}`) {
        return jsonResponse(200, {
          userId: validUserId,
          permissions: ['attendance:read', 'attendance:approve'],
          isAdmin: true,
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    provisioning.provisionForm.userId = validUserId
    await provisioning.loadProvisioningUser()

    expect(provisioning.provisionPermissions.value).toEqual(['attendance:read', 'attendance:approve'])
    expect(provisioning.provisionUserIsAdmin.value).toBe(true)
    expect(provisioning.provisionRoles.value).toEqual([])
    expect(provisioning.provisionStatusKind.value).toBe('info')
    expect(provisioning.provisionStatusMessage.value).toContain('Loaded 2 permission')
    expect(adminForbidden.value).toBe(false)
  })

  it('normalizes batch preview payload and clears stale preview rows after input changes', async () => {
    const validA = '11111111-1111-4111-8111-111111111111'
    const validB = '22222222-2222-4222-8222-222222222222'
    const adminForbidden = ref(false)
    const provisioning = useAttendanceAdminProvisioning({ adminForbidden, tr })
    const apiFetchMock = vi.mocked(apiFetch)

    apiFetchMock.mockResolvedValue(
      jsonResponse(200, {
        ok: true,
        data: {
          requested: 2,
          items: [
            { id: validA, email: 'a@example.com', name: 'Alice', is_active: true },
            { id: validA, email: 'a@example.com', name: 'Alice', is_active: true },
            { id: validB, email: 'b@example.com', name: 'Bob', is_active: false },
          ],
          missingUserIds: [validB, validB],
          inactiveUserIds: [validB],
          affectedUserIds: [validA],
          unchangedUserIds: [validB],
        },
      }),
    )

    provisioning.provisionBatchUserIdsText.value = `${validA}\n${validB}`
    await provisioning.previewProvisionBatchUsers()

    expect(provisioning.provisionBatchPreviewRequested.value).toBe(2)
    expect(provisioning.provisionBatchPreviewItems.value).toEqual([
      { id: validA, email: 'a@example.com', name: 'Alice', is_active: true },
      { id: validB, email: 'b@example.com', name: 'Bob', is_active: false },
    ])
    expect(provisioning.provisionBatchPreviewMissingIds.value).toEqual([validB])
    expect(provisioning.provisionBatchPreviewInactiveIds.value).toEqual([validB])
    expect(provisioning.provisionBatchAffectedIds.value).toEqual([validA])
    expect(provisioning.provisionBatchUnchangedIds.value).toEqual([validB])

    provisioning.provisionBatchRole.value = 'admin'
    await nextTick()

    expect(provisioning.provisionBatchPreviewRequested.value).toBe(0)
    expect(provisioning.provisionBatchPreviewItems.value).toEqual([])
    expect(provisioning.provisionBatchPreviewMissingIds.value).toEqual([])
    expect(provisioning.provisionBatchPreviewInactiveIds.value).toEqual([])
    expect(provisioning.provisionBatchAffectedIds.value).toEqual([])
    expect(provisioning.provisionBatchUnchangedIds.value).toEqual([])
    expect(adminForbidden.value).toBe(false)
  })
})
