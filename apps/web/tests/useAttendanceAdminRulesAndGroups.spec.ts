import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import {
  buildRuleSetPreviewRecommendations,
  summarizeRuleSetPreviewResult,
  useAttendanceAdminRulesAndGroups,
} from '../src/views/attendance/useAttendanceAdminRulesAndGroups'

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
  it('summarizes preview rows and generates productized recommendations', () => {
    const result = {
      ruleSetId: 'rs-1',
      totalEvents: 2,
      config: {},
      notes: [],
      preview: [
        {
          userId: 'user-1',
          workDate: '2026-03-20',
          firstInAt: '2026-03-20T09:05:00.000Z',
          lastOutAt: null,
          workMinutes: 475,
          lateMinutes: 5,
          earlyLeaveMinutes: 0,
          status: 'late',
          isWorkingDay: true,
        },
        {
          userId: 'user-2',
          workDate: '2026-03-22',
          firstInAt: '2026-03-22T09:00:00.000Z',
          lastOutAt: '2026-03-22T17:53:00.000Z',
          workMinutes: 470,
          lateMinutes: 0,
          earlyLeaveMinutes: 7,
          status: 'early_leave',
          isWorkingDay: false,
        },
      ],
    }

    const summary = summarizeRuleSetPreviewResult(result)
    expect(summary).toMatchObject({
      totalRows: 2,
      cleanRows: 0,
      flaggedRows: 2,
      lateRows: 1,
      earlyLeaveRows: 1,
      missingCheckOutRows: 1,
      nonWorkingDayRows: 1,
      abnormalStatusRows: 2,
      totalLateMinutes: 5,
      totalEarlyLeaveMinutes: 7,
      averageWorkMinutes: 473,
    })

    const recommendations = buildRuleSetPreviewRecommendations(result, {
      source: 'csv',
      timezone: 'Asia/Shanghai',
      workStartTime: '09:00',
      workEndTime: '18:00',
      lateGraceMinutes: 10,
      earlyGraceMinutes: 10,
      workingDays: '1, 2, 3, 4, 5',
    })
    expect(recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'raiseLateGrace', suggestedMinutes: 15, affectedRows: 1 }),
      expect.objectContaining({ key: 'raiseEarlyGrace', suggestedMinutes: 17, affectedRows: 1 }),
      expect.objectContaining({ key: 'reviewWorkingDays', affectedRows: 1 }),
      expect.objectContaining({ key: 'reviewMissingPunches', affectedRows: 1 }),
      expect.objectContaining({ key: 'reviewAbnormalStatuses', affectedRows: 2 }),
    ]))
  })

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

  it('requires a rule set name before saving', async () => {
    const options = createOptions()
    const rules = useAttendanceAdminRulesAndGroups(options)
    rules.ruleSetForm.name = '   '
    rules.ruleSetForm.config = '{"source":"csv"}'

    await rules.saveRuleSet()

    expect(options.apiFetch).not.toHaveBeenCalled()
    expect(options.setStatus).toHaveBeenCalledWith('Rule set name is required', 'error')
  })

  it('auto-generates a group code from the name when the code is blank', async () => {
    const apiFetch = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/attendance/groups' && init?.method === 'POST') {
        return jsonResponse(200, { ok: true, data: { id: 'group-1' } })
      }
      if (input === '/api/attendance/groups?orgId=org-1') {
        return jsonResponse(200, { ok: true, data: { items: [] } })
      }
      throw new Error(`Unexpected request: ${input}`)
    })
    const options = createOptions({ apiFetch })
    const rules = useAttendanceAdminRulesAndGroups(options)
    rules.attendanceGroupForm.name = 'Operations Team'
    rules.attendanceGroupForm.code = ''

    await rules.saveAttendanceGroup()

    const [, init] = apiFetch.mock.calls[0]!
    expect(JSON.parse(String(init?.body || '{}'))).toMatchObject({
      code: 'operations_team',
      name: 'Operations Team',
      timezone: 'Asia/Shanghai',
      orgId: 'org-1',
    })
    expect(options.setStatus).toHaveBeenCalledWith('Attendance group saved.')
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

  it('syncs builder fields from rule set config and writes them back into JSON', () => {
    const rules = useAttendanceAdminRulesAndGroups(createOptions())
    rules.ruleSetForm.config = JSON.stringify({
      source: 'csv',
      rule: {
        timezone: 'Asia/Shanghai',
        workStartTime: '09:00',
        workEndTime: '18:00',
        workingDays: [1, 2, 3, 4, 5],
        policy: 'keep',
      },
      custom: { keep: true },
    })

    const synced = rules.syncRuleBuilderFromRuleSetConfig()
    expect(synced).toBe(true)
    expect(rules.ruleBuilderSource.value).toBe('csv')
    expect(rules.ruleBuilderTimezone.value).toBe('Asia/Shanghai')
    expect(rules.ruleBuilderWorkStartTime.value).toBe('09:00')
    expect(rules.ruleBuilderWorkEndTime.value).toBe('18:00')
    expect(rules.ruleBuilderWorkingDays.value).toBe('1, 2, 3, 4, 5')

    rules.ruleBuilderSource.value = 'api'
    rules.ruleBuilderTimezone.value = 'UTC'
    rules.ruleBuilderWorkStartTime.value = '08:30'
    rules.ruleBuilderWorkEndTime.value = '17:30'
    rules.ruleBuilderWorkingDays.value = '1, 3, 5'

    const next = rules.applyRuleBuilderToRuleSetConfig()
    expect(next).toMatchObject({
      source: 'api',
      custom: { keep: true },
      rule: {
        timezone: 'UTC',
        workStartTime: '08:30',
        workEndTime: '17:30',
        workingDays: [1, 3, 5],
        policy: 'keep',
      },
    })
    expect(JSON.parse(rules.ruleSetForm.config)).toMatchObject(next)
  })

  it('previews a rule set and normalizes the response payload', async () => {
    const apiFetch = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/attendance/rule-sets/preview' && init?.method === 'POST') {
        return jsonResponse(200, {
          ok: true,
          data: {
            ruleSetId: 'rs-1',
            totalEvents: 1,
            preview: [
              {
                userId: 'user-1',
                workDate: '2026-03-20',
                firstInAt: '2026-03-20T01:00:00.000Z',
                lastOutAt: null,
                workMinutes: '480',
                lateMinutes: '3',
                earlyLeaveMinutes: 0,
                status: 'normal',
                isWorkingDay: true,
                source: { mode: 'basic' },
              },
            ],
            config: {
              source: 'csv',
              rule: { timezone: 'Asia/Shanghai' },
            },
            notes: ['Preview ready', 42],
          },
        })
      }
      throw new Error(`Unexpected request: ${input}`)
    })
    const options = createOptions({ apiFetch })
    const rules = useAttendanceAdminRulesAndGroups(options)
    rules.ruleSetEditingId.value = 'rs-1'
    rules.ruleSetForm.config = JSON.stringify({
      source: 'csv',
      rule: { timezone: 'Asia/Shanghai' },
    })
    rules.ruleSetPreviewEventsText.value = JSON.stringify([
      {
        eventType: 'check_in',
        occurredAt: '2026-03-20T01:00:00.000Z',
        userId: 'user-1',
      },
    ])

    const result = await rules.previewRuleSet()

    expect(apiFetch).toHaveBeenCalledTimes(1)
    const [, init] = apiFetch.mock.calls[0]!
    expect(JSON.parse(String(init?.body || '{}'))).toMatchObject({
      ruleSetId: 'rs-1',
      config: {
        source: 'csv',
        rule: { timezone: 'Asia/Shanghai' },
      },
      events: [
        {
          eventType: 'check_in',
          occurredAt: '2026-03-20T01:00:00.000Z',
          userId: 'user-1',
        },
      ],
    })
    expect(result).toEqual(
      expect.objectContaining({
        ruleSetId: 'rs-1',
        totalEvents: 1,
        notes: ['Preview ready', '42'],
      }),
    )
    expect(result?.preview[0]).toEqual(
      expect.objectContaining({
        userId: 'user-1',
        workDate: '2026-03-20',
        workMinutes: 480,
        lateMinutes: 3,
        earlyLeaveMinutes: 0,
        status: 'normal',
        isWorkingDay: true,
      }),
    )
    expect(options.setStatus).toHaveBeenCalledWith('Rule set preview loaded.')
    expect(rules.ruleSetPreviewResult.value).toEqual(result)
  })

  it('summarizes preview output and builds actionable recommendations', () => {
    const previewResult = {
      ruleSetId: 'rs-ops',
      totalEvents: 4,
      preview: [
        {
          userId: 'user-1',
          workDate: '2026-03-21',
          firstInAt: '2026-03-21T01:20:00.000Z',
          lastOutAt: '2026-03-21T10:00:00.000Z',
          workMinutes: 460,
          lateMinutes: 20,
          earlyLeaveMinutes: 0,
          status: 'late',
          isWorkingDay: true,
        },
        {
          userId: 'user-2',
          workDate: '2026-03-22',
          firstInAt: '2026-03-22T01:00:00.000Z',
          lastOutAt: null,
          workMinutes: 240,
          lateMinutes: 0,
          earlyLeaveMinutes: 30,
          status: 'partial',
          isWorkingDay: false,
        },
      ],
      config: {},
      notes: [],
    }

    const summary = summarizeRuleSetPreviewResult(previewResult)
    expect(summary).toEqual({
      totalRows: 2,
      cleanRows: 0,
      flaggedRows: 2,
      lateRows: 1,
      earlyLeaveRows: 1,
      missingCheckInRows: 0,
      missingCheckOutRows: 1,
      nonWorkingDayRows: 1,
      abnormalStatusRows: 2,
      totalLateMinutes: 20,
      totalEarlyLeaveMinutes: 30,
      averageWorkMinutes: 350,
    })

    const recommendations = buildRuleSetPreviewRecommendations(previewResult, {
      source: 'csv',
      timezone: 'Asia/Shanghai',
      workStartTime: '09:00',
      workEndTime: '18:00',
      lateGraceMinutes: 10,
      earlyGraceMinutes: 10,
      workingDays: '1, 2, 3, 4, 5',
    })

    expect(recommendations).toEqual([
      expect.objectContaining({ key: 'raiseLateGrace', affectedRows: 1, suggestedMinutes: 30 }),
      expect.objectContaining({ key: 'raiseEarlyGrace', affectedRows: 1, suggestedMinutes: 40 }),
      expect.objectContaining({ key: 'reviewWorkingDays', affectedRows: 1 }),
      expect.objectContaining({ key: 'reviewMissingPunches', affectedRows: 1, severity: 'critical' }),
      expect.objectContaining({ key: 'reviewAbnormalStatuses', affectedRows: 2 }),
    ])
  })

  it('loads template version details when opening a stored version', async () => {
    const apiFetch = vi.fn(async (input: string) => {
      if (input === '/api/attendance/rule-templates') {
        return jsonResponse(200, {
          ok: true,
          data: {
            system: [],
            library: [],
            versions: [
              {
                id: 'version-1',
                version: 2,
                itemCount: 1,
                createdAt: '2026-03-18T08:00:00.000Z',
                createdBy: 'tester',
              },
            ],
          },
        })
      }
      if (input === '/api/attendance/rule-templates/versions/version-1') {
        return jsonResponse(200, {
          ok: true,
          data: {
            id: 'version-1',
            version: 2,
            itemCount: 1,
            createdAt: '2026-03-18T08:00:00.000Z',
            createdBy: 'tester',
            templates: [
              {
                id: 'tpl-1',
                name: 'Standard Weekday',
                rules: [],
              },
            ],
          },
        })
      }
      throw new Error(`Unexpected request: ${input}`)
    })
    const options = createOptions({ apiFetch })
    const rules = useAttendanceAdminRulesAndGroups(options)

    await rules.loadRuleTemplates()
    await rules.openRuleTemplateVersion('version-1')

    expect(apiFetch).toHaveBeenNthCalledWith(1, '/api/attendance/rule-templates')
    expect(apiFetch).toHaveBeenNthCalledWith(2, '/api/attendance/rule-templates/versions/version-1')
    expect(rules.selectedRuleTemplateVersion.value?.id).toBe('version-1')
    expect(rules.selectedRuleTemplateVersion.value?.templates).toEqual([
      expect.objectContaining({ id: 'tpl-1', name: 'Standard Weekday' }),
    ])
    expect(rules.ruleTemplateVersionLoading.value).toBe(false)
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
