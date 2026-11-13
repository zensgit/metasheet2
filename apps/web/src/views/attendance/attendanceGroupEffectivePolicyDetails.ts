import {
  attendanceGroupEffectivePolicyGroupTypeText,
  attendanceGroupEffectivePolicySourceLabelText,
  isAttendanceGroupEffectivePolicyGroupTypeV1,
  type AttendanceGroupEffectivePolicyDomainSummaryKeyV1,
  type TranslateFn,
} from './attendanceGroupEffectivePolicyLabels'

// W6 summary-fidelity lock (2026-10-26): format only existing canonical detail enums.
export function attendanceGroupEffectivePolicyDetails(
  key: AttendanceGroupEffectivePolicyDomainSummaryKeyV1,
  summary: unknown,
  tr: TranslateFn,
): readonly { readonly key: string; readonly label: string; readonly value: string }[] {
  const fields: Record<string, unknown> = summary !== null && typeof summary === 'object' && !Array.isArray(summary)
    ? summary as Record<string, unknown>
    : {}
  const unrecognized = tr('Unrecognized', '未识别')
  const inherited = (value: unknown): string => value === 'org_inherited'
    ? attendanceGroupEffectivePolicySourceLabelText('org_inherited', tr)
    : unrecognized

  switch (key) {
    case 'schedule':
      return [{
        key: 'strategy',
        label: tr('Schedule strategy', '排班策略'),
        value: isAttendanceGroupEffectivePolicyGroupTypeV1(fields.strategy)
          ? attendanceGroupEffectivePolicyGroupTypeText(fields.strategy, tr)
          : unrecognized,
      }]
    case 'flex':
      return [{
        key: 'mode',
        label: tr('Flex mode', '弹性模式'),
        value: fields.mode === undefined
          ? tr('Not provided', '未提供')
          : fields.mode === 'strict'
            ? tr('Strict', '严格工时')
            : fields.mode === 'flex_required_duration'
              ? tr('Required duration', '固定时长弹性')
              : unrecognized,
      }]
    case 'rules':
      return [{
        key: 'source',
        label: tr('Rule source', '规则来源'),
        value: fields.source === 'org_default'
          ? tr('Organization default rule', '组织默认规则')
          : fields.source === 'group_rule_set'
            ? tr('Group rule set', '组规则集')
            : unrecognized,
      }]
    case 'punchMethod':
      return [{
        key: 'source',
        label: tr('Punch source', '打卡来源'),
        value: inherited(fields.source),
      }]
    case 'requestPosture':
      return [
        { key: 'overtime', label: tr('Overtime', '加班'), value: inherited(fields.overtime) },
        { key: 'makeupPunch', label: tr('Makeup punch', '补卡'), value: inherited(fields.makeupPunch) },
        { key: 'outdoor', label: tr('Outdoor', '外勤'), value: inherited(fields.outdoor) },
      ]
    case 'membership':
    case 'segments':
      return []
  }
}
