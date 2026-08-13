import { describe, expect, it } from 'vitest'
import {
  parseAttendanceGroupEffectivePolicyEnvelopeV1,
  ATTENDANCE_GROUP_EFFECTIVE_POLICY_CALCULATION_POSTURES_V1,
  ATTENDANCE_GROUP_EFFECTIVE_POLICY_CONFLICT_CODES_V1,
  ATTENDANCE_GROUP_EFFECTIVE_POLICY_DOMAINS_V1,
  ATTENDANCE_GROUP_EFFECTIVE_POLICY_DOMAIN_SUMMARY_KEYS_V1,
  ATTENDANCE_GROUP_EFFECTIVE_POLICY_GROUP_TYPES_V1,
  ATTENDANCE_GROUP_EFFECTIVE_POLICY_SOURCE_LABELS_V1,
  ATTENDANCE_GROUP_FIXED_SCHEDULE_STATES_V1,
  attendanceGroupEffectivePolicyCalculationPostureText,
  attendanceGroupEffectivePolicyConflictCodeText,
  attendanceGroupEffectivePolicyDomainText,
  attendanceGroupEffectivePolicyGroupTypeText,
  attendanceGroupEffectivePolicyNeutralMemberLabel,
  attendanceGroupEffectivePolicySourceLabelText,
  attendanceGroupFixedScheduleStateText,
  isAttendanceGroupEffectivePolicyCalculationPostureV1,
  isAttendanceGroupEffectivePolicyConflictCodeV1,
  isAttendanceGroupEffectivePolicyDomainV1,
  isAttendanceGroupEffectivePolicyGroupTypeV1,
  isAttendanceGroupEffectivePolicySourceLabelV1,
  isAttendanceGroupFixedScheduleStateV1,
  parseAttendanceGroupEffectivePolicyEditorRefV1,
  resolveAttendanceGroupEffectivePolicyEditorNavigationV1,
  type AttendanceGroupEffectivePolicyCalculationPostureV1,
  type AttendanceGroupEffectivePolicyConflictCodeV1,
  type AttendanceGroupEffectivePolicyDomainV1,
  type AttendanceGroupEffectivePolicyGroupTypeV1,
  type AttendanceGroupEffectivePolicySourceLabelV1,
  type AttendanceGroupFixedScheduleStateV1,
} from '../src/views/attendance/attendanceGroupEffectivePolicyLabels'
import { ATTENDANCE_GROUP_ROUTE_DEFAULT_RETURN_TO } from '../src/router/attendanceGroupContextRoute'

const tr = (en: string, zh: string): string => `${en}|${zh}`

const GROUP_ID = '11111111-2222-4333-8444-555555555555'

describe('attendanceGroupEffectivePolicyLabels — §5.5 exhaustive display maps', () => {
  it('maps every AttendanceGroupEffectivePolicySourceLabelV1 member to exact bilingual text', () => {
    const expected: Record<AttendanceGroupEffectivePolicySourceLabelV1, string> = {
      effective: 'Effective|生效中',
      org_inherited: 'Org default|继承组织默认',
      preview_only: 'Preview only|仅预览',
      needs_configuration: 'Needs configuration|待配置',
      conflict_action_required: 'Conflict — action required|存在冲突，需处理',
    }
    for (const value of ATTENDANCE_GROUP_EFFECTIVE_POLICY_SOURCE_LABELS_V1) {
      expect(attendanceGroupEffectivePolicySourceLabelText(value, tr)).toBe(expected[value])
    }
    expect(ATTENDANCE_GROUP_EFFECTIVE_POLICY_SOURCE_LABELS_V1).toHaveLength(5)
  })

  it('maps every AttendanceGroupEffectivePolicyDomainV1 member (all 8, including basics) to exact text', () => {
    const expected: Record<AttendanceGroupEffectivePolicyDomainV1, string> = {
      basics: 'Basics|基本信息',
      membership: 'Membership|成员',
      schedule: 'Schedule|排班',
      segments: 'Segments|时段',
      flex: 'Flexible hours|弹性工时',
      rules: 'Rules|规则',
      punch_method: 'Punch method|打卡方式',
      request_posture: 'Request posture|申请策略',
    }
    for (const value of ATTENDANCE_GROUP_EFFECTIVE_POLICY_DOMAINS_V1) {
      expect(attendanceGroupEffectivePolicyDomainText(value, tr)).toBe(expected[value])
    }
    expect(ATTENDANCE_GROUP_EFFECTIVE_POLICY_DOMAINS_V1).toHaveLength(8)
    expect(ATTENDANCE_GROUP_EFFECTIVE_POLICY_DOMAINS_V1).toContain('basics')
  })

  it('maps every AttendanceGroupEffectivePolicyConflictCodeV1 member (all 7) to exact text', () => {
    const expected: Record<AttendanceGroupEffectivePolicyConflictCodeV1, string> = {
      CALCULATION_GROUP_MEMBERSHIP_OVERLAP: 'Overlapping calculation-group membership|存在重叠的核算组成员关系',
      FIXED_SCHEDULE_CONFIGURATION_CHANGED: 'Fixed-schedule configuration changed|固定排班配置已变更',
      FIXED_SCHEDULE_PENDING_APPLY: 'Fixed-schedule change pending apply|固定排班变更待应用',
      FIXED_SCHEDULE_UNPUBLISHED_MANAGED_ROW: 'Fixed-schedule has unpublished managed rows|固定排班存在未发布的托管行',
      SCHEDULE_STRATEGY_INCOMPLETE: 'Schedule strategy incomplete|排班策略未配置完整',
      RULE_SOURCE_MISSING: 'Rule source missing|缺少规则来源',
      TIMEZONE_MISSING: 'Timezone missing|缺少时区',
    }
    for (const value of ATTENDANCE_GROUP_EFFECTIVE_POLICY_CONFLICT_CODES_V1) {
      expect(attendanceGroupEffectivePolicyConflictCodeText(value, tr)).toBe(expected[value])
    }
    expect(ATTENDANCE_GROUP_EFFECTIVE_POLICY_CONFLICT_CODES_V1).toHaveLength(7)
  })

  it('maps every AttendanceGroupEffectivePolicyGroupTypeV1 member (all 3) to exact text', () => {
    const expected: Record<AttendanceGroupEffectivePolicyGroupTypeV1, string> = {
      fixed_shift: 'Fixed shift|固定班',
      scheduled_shift: 'Scheduled shift|排班制',
      free_time: 'Free time|自由工时',
    }
    for (const value of ATTENDANCE_GROUP_EFFECTIVE_POLICY_GROUP_TYPES_V1) {
      expect(attendanceGroupEffectivePolicyGroupTypeText(value, tr)).toBe(expected[value])
    }
    expect(ATTENDANCE_GROUP_EFFECTIVE_POLICY_GROUP_TYPES_V1).toHaveLength(3)
  })

  it('maps every AttendanceGroupEffectivePolicyCalculationPostureV1 member (all 5) to exact text', () => {
    const expected: Record<AttendanceGroupEffectivePolicyCalculationPostureV1, string> = {
      legacy: 'Legacy|存量口径',
      shadow: 'Shadow|影子运行',
      eligible: 'Eligible|具备切换资格',
      authoritative: 'Authoritative|权威口径',
      suspended: 'Suspended|已暂停',
    }
    for (const value of ATTENDANCE_GROUP_EFFECTIVE_POLICY_CALCULATION_POSTURES_V1) {
      expect(attendanceGroupEffectivePolicyCalculationPostureText(value, tr)).toBe(expected[value])
    }
    expect(ATTENDANCE_GROUP_EFFECTIVE_POLICY_CALCULATION_POSTURES_V1).toHaveLength(5)
  })

  it('maps every AttendanceGroupFixedScheduleStateV1 member (all 4) to exact text', () => {
    const expected: Record<AttendanceGroupFixedScheduleStateV1, string> = {
      not_configured: 'Not configured|未配置',
      pending_apply: 'Pending apply|待应用',
      effective: 'Effective|生效中',
      configuration_changed: 'Configuration changed|配置已变更',
    }
    for (const value of ATTENDANCE_GROUP_FIXED_SCHEDULE_STATES_V1) {
      expect(attendanceGroupFixedScheduleStateText(value, tr)).toBe(expected[value])
    }
    expect(ATTENDANCE_GROUP_FIXED_SCHEDULE_STATES_V1).toHaveLength(4)
  })

  it('maps every domain-summary response key to its closed domain enum value, and covers 7 of the 8 domains (basics excluded)', () => {
    expect(ATTENDANCE_GROUP_EFFECTIVE_POLICY_DOMAIN_SUMMARY_KEYS_V1).toEqual({
      membership: 'membership',
      schedule: 'schedule',
      segments: 'segments',
      flex: 'flex',
      rules: 'rules',
      punchMethod: 'punch_method',
      requestPosture: 'request_posture',
    })
    expect(Object.keys(ATTENDANCE_GROUP_EFFECTIVE_POLICY_DOMAIN_SUMMARY_KEYS_V1)).toHaveLength(7)
  })

  it('emits exact bilingual text for both neutral member-label kinds (R7)', () => {
    expect(attendanceGroupEffectivePolicyNeutralMemberLabel('unknown', tr)).toBe('Unknown member|未知成员')
    expect(attendanceGroupEffectivePolicyNeutralMemberLabel('deleted', tr)).toBe('Deleted member|已删除成员')
  })
})

describe('attendanceGroupEffectivePolicyLabels — runtime guards fail closed', () => {
  it.each([
    ['isAttendanceGroupEffectivePolicySourceLabelV1', isAttendanceGroupEffectivePolicySourceLabelV1, 'effective', 'bogus'],
    ['isAttendanceGroupEffectivePolicyDomainV1', isAttendanceGroupEffectivePolicyDomainV1, 'basics', 'BASICS'],
    [
      'isAttendanceGroupEffectivePolicyConflictCodeV1',
      isAttendanceGroupEffectivePolicyConflictCodeV1,
      'TIMEZONE_MISSING',
      'timezone_missing',
    ],
    ['isAttendanceGroupEffectivePolicyGroupTypeV1', isAttendanceGroupEffectivePolicyGroupTypeV1, 'fixed_shift', 'flexible'],
    [
      'isAttendanceGroupEffectivePolicyCalculationPostureV1',
      isAttendanceGroupEffectivePolicyCalculationPostureV1,
      'legacy',
      'rollback',
    ],
    ['isAttendanceGroupFixedScheduleStateV1', isAttendanceGroupFixedScheduleStateV1, 'effective', 'active'],
  ] as const)('%s accepts every canonical member and rejects an unrecognized one', (_name, guard, valid, invalid) => {
    expect(guard(valid)).toBe(true)
    expect(guard(invalid)).toBe(false)
    expect(guard(undefined)).toBe(false)
    expect(guard(null)).toBe(false)
    expect(guard(42)).toBe(false)
  })
})

describe('attendanceGroupEffectivePolicyLabels — editorRef closed-table parse (W6-R8)', () => {
  it('parses a valid group_stage ref', () => {
    expect(parseAttendanceGroupEffectivePolicyEditorRefV1({ kind: 'group_stage', stage: 'people' })).toEqual({
      kind: 'group_stage',
      stage: 'people',
    })
  })

  it('parses a valid group_context_route ref with and without surface', () => {
    expect(
      parseAttendanceGroupEffectivePolicyEditorRefV1({ kind: 'group_context_route', step: 'schedule', surface: 'assignments' }),
    ).toEqual({ kind: 'group_context_route', step: 'schedule', surface: 'assignments' })
    expect(parseAttendanceGroupEffectivePolicyEditorRefV1({ kind: 'group_context_route', step: 'calendar' })).toEqual({
      kind: 'group_context_route',
      step: 'calendar',
    })
  })

  it.each([
    [null],
    [undefined],
    ['not-an-object'],
    [{}],
    [{ kind: 'group_stage', stage: 'archived' }],
    [{ kind: 'group_stage' }],
    [{ kind: 'group_context_route', step: 'shifts' }],
    [{ kind: 'group_context_route', step: 'rules', surface: 'assignments' }],
    [{ kind: 'wat', stage: 'people' }],
  ])('rejects a malformed or out-of-table editorRef: %j', (value) => {
    expect(parseAttendanceGroupEffectivePolicyEditorRefV1(value)).toBeNull()
  })
})

describe('attendanceGroupEffectivePolicyLabels — editorRef navigation resolver', () => {
  const context = { groupId: GROUP_ID, returnTo: '/attendance?tab=admin&section=attendance-admin-groups' }

  it('resolves every group_stage ref to the existing groups-list section, not a fabricated deep link', () => {
    for (const stage of ['basics', 'people', 'schedule', 'policies'] as const) {
      expect(resolveAttendanceGroupEffectivePolicyEditorNavigationV1({ kind: 'group_stage', stage }, context)).toEqual({
        kind: 'group-list',
        href: ATTENDANCE_GROUP_ROUTE_DEFAULT_RETURN_TO,
      })
    }
  })

  it('resolves a group_context_route ref through the existing #4711 href builder', () => {
    const result = resolveAttendanceGroupEffectivePolicyEditorNavigationV1(
      { kind: 'group_context_route', step: 'rules', surface: 'rule-sets' },
      context,
    )
    expect(result?.kind).toBe('route')
    expect(result?.href).toBe(
      `/attendance/admin/groups/${GROUP_ID}/rules?surface=rule-sets&returnTo=${encodeURIComponent(context.returnTo)}`,
    )
  })

  it('resolves a group_context_route ref with no surface (calendar step)', () => {
    const result = resolveAttendanceGroupEffectivePolicyEditorNavigationV1(
      { kind: 'group_context_route', step: 'calendar' },
      context,
    )
    expect(result?.kind).toBe('route')
    expect(result?.href).toBe(`/attendance/admin/groups/${GROUP_ID}/calendar?returnTo=${encodeURIComponent(context.returnTo)}`)
  })
})

describe('attendanceGroupEffectivePolicyLabels — envelope narrowing', () => {
  it('narrows a well-formed { ok: true, data } envelope', () => {
    const raw = { ok: true, data: { groupId: GROUP_ID, groupType: 'fixed_shift' } }
    expect(parseAttendanceGroupEffectivePolicyEnvelopeV1(raw)).toEqual(raw.data)
  })

  it.each([
    [null],
    [undefined],
    ['not-an-object'],
    [{}],
    [{ ok: false, error: { code: 'FORBIDDEN' } }],
    [{ ok: true }],
    [{ ok: true, data: null }],
    [{ ok: true, data: {} }],
    [{ ok: true, data: { groupId: '' } }],
    [{ ok: true, data: { groupId: 42 } }],
  ])('rejects a malformed envelope: %j', (value) => {
    expect(parseAttendanceGroupEffectivePolicyEnvelopeV1(value)).toBeNull()
  })
})
