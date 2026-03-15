import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useAttendanceAdminRulesAndGroups } from '../src/views/attendance/useAttendanceAdminRulesAndGroups'

const tr = (en: string, _zh: string) => en

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response
}

function createOptions(overrides: Partial<Parameters<typeof useAttendanceAdminRulesAndGroups>[0]> = {}) {
  const adminForbidden = ref(false)
  const setStatus = vi.fn()
  return {
    adminForbidden,
    apiFetch: vi.fn(),
    confirm: vi.fn(() => true),
    defaultTimezone: 'Asia/Shanghai',
    getOrgId: () => 'org-1',
    setStatus,
    tr,
    ...overrides,
  }
}

describe('useAttendanceAdminRulesAndGroups', () => {
  it('loads rule sets and resolves display names', async () => {
    const apiFetch = vi.fn(async (input: string) => {
      if (input === '/api/attendance/rule-sets?orgId=org-1') {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: 'rs-1', name: 'Default rule', version: 1, scope: 'org', isDefault: true },
            ],
          },
        })
      }
      throw new Error(`Unexpected request: ${input}`)
    })
    const rules = useAttendanceAdminRulesAndGroups(createOptions({ apiFetch }))

    await rules.loadRuleSets()

    expect(rules.ruleSets.value).toHaveLength(1)
    expect(rules.resolveRuleSetName('rs-1')).toBe('Default rule')
    expect(rules.resolveRuleSetName('')).toBe('Default')
  })

  it('saves a rule set with parsed JSON config and reloads the list', async () => {
    const apiFetch = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/attendance/rule-sets' && init?.method === 'POST') {
        return jsonResponse(200, { ok: true, data: { id: 'rs-1' } })
      }
      if (input === '/api/attendance/rule-sets?orgId=org-1') {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: 'rs-1', name: 'Ops rule', version: 2, scope: 'org', isDefault: false },
            ],
          },
        })
      }
      throw new Error(`Unexpected request: ${input}`)
    })
    const options = createOptions({ apiFetch })
    const rules = useAttendanceAdminRulesAndGroups(options)
    rules.ruleSetForm.name = 'Ops rule'
    rules.ruleSetForm.version = 2
    rules.ruleSetForm.config = '{"source":"csv"}'

    await rules.saveRuleSet()

    const [, init] = apiFetch.mock.calls[0]!
    const payload = JSON.parse(String(init?.body || '{}'))
    expect(payload).toMatchObject({
      name: 'Ops rule',
      version: 2,
      scope: 'org',
      orgId: 'org-1',
      config: { source: 'csv' },
    })
    expect(rules.ruleSets.value[0]?.name).toBe('Ops rule')
    expect(options.setStatus).toHaveBeenCalledWith('Rule set saved.')
  })

  it('validates rule template library schema before saving', async () => {
    const apiFetch = vi.fn()
    const options = createOptions({ apiFetch })
    const rules = useAttendanceAdminRulesAndGroups(options)
    rules.ruleTemplateLibraryText.value = JSON.stringify([{ name: '', rules: 'bad' }])

    await rules.saveRuleTemplates()

    expect(apiFetch).not.toHaveBeenCalled()
    expect(options.setStatus).toHaveBeenCalledWith(expect.stringContaining('Template schema errors:'), 'error')
  })

  it('loads groups, manages members, and keeps the selected group synced', async () => {
    const apiFetch = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/attendance/groups?orgId=org-1') {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: 'group-a', name: 'A Team', timezone: 'Asia/Shanghai' },
            ],
          },
        })
      }
      if (input === '/api/attendance/groups/group-a/members' && !init?.method) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: 'member-1', groupId: 'group-a', userId: 'user-1' },
            ],
          },
        })
      }
      if (input === '/api/attendance/groups/group-a/members' && init?.method === 'POST') {
        return jsonResponse(200, { ok: true, data: {} })
      }
      if (input === '/api/attendance/groups/group-a/members/user-1' && init?.method === 'DELETE') {
        return jsonResponse(200, { ok: true, data: {} })
      }
      throw new Error(`Unexpected request: ${input}`)
    })
    const options = createOptions({ apiFetch })
    const rules = useAttendanceAdminRulesAndGroups(options)

    await rules.loadAttendanceGroups()
    expect(rules.attendanceGroupMemberGroupId.value).toBe('group-a')

    await rules.loadAttendanceGroupMembers()
    expect(rules.attendanceGroupMembers.value).toHaveLength(1)

    rules.attendanceGroupMemberUserIds.value = 'user-2 user-3'
    await rules.addAttendanceGroupMembers()
    const [, addInit] = apiFetch.mock.calls[2]!
    expect(JSON.parse(String(addInit?.body || '{}')).userIds).toEqual(['user-2', 'user-3'])
    expect(rules.attendanceGroupMemberUserIds.value).toBe('')

    await rules.removeAttendanceGroupMember('user-1')
    expect(options.setStatus).toHaveBeenCalledWith('Group member removed.')
  })

  it('marks admin forbidden when protected endpoints return 403', async () => {
    const adminForbidden = ref(false)
    const apiFetch = vi.fn(async () => jsonResponse(403, {
      ok: false,
      error: { message: 'denied' },
    }))
    const rules = useAttendanceAdminRulesAndGroups(createOptions({ adminForbidden, apiFetch }))

    await rules.loadRuleTemplates()

    expect(adminForbidden.value).toBe(true)
  })
})
