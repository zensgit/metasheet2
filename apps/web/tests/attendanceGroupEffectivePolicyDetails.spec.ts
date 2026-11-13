import { describe, expect, it } from 'vitest'
import { attendanceGroupEffectivePolicyDetails } from '../src/views/attendance/attendanceGroupEffectivePolicyDetails'

const locales = [
  {
    locale: 'English',
    tr: (en: string, _zh: string) => en,
    schedule: 'Schedule strategy',
    flex: 'Flex mode',
    rules: 'Rule source',
    punch: 'Punch source',
    overtime: 'Overtime',
    makeupPunch: 'Makeup punch',
    outdoor: 'Outdoor',
    inherited: 'Inherited from organization',
    unrecognized: 'Unrecognized',
    notProvided: 'Not provided',
  },
  {
    locale: 'Chinese',
    tr: (_en: string, zh: string) => zh,
    schedule: '排班策略',
    flex: '弹性模式',
    rules: '规则来源',
    punch: '打卡来源',
    overtime: '加班',
    makeupPunch: '补卡',
    outdoor: '外勤',
    inherited: '继承组织默认',
    unrecognized: '未识别',
    notProvided: '未提供',
  },
]

describe.each(locales)('attendanceGroupEffectivePolicyDetails ($locale)', (text) => {
  const tr = text.tr

  it.each([
    ['fixed_shift', 'Fixed shift', '固定班'],
    ['scheduled_shift', 'Scheduled shift', '排班制'],
    ['free_time', 'Free time', '自由工时'],
  ])('renders schedule strategy %s', (strategy, en, zh) => {
    expect(attendanceGroupEffectivePolicyDetails('schedule', { strategy }, tr)).toEqual([
      { key: 'strategy', label: text.schedule, value: tr(en, zh) },
    ])
  })

  it.each([
    ['strict', 'Strict', '严格工时'],
    ['flex_required_duration', 'Required duration', '固定时长弹性'],
  ])('renders flex mode %s', (mode, en, zh) => {
    expect(attendanceGroupEffectivePolicyDetails('flex', { mode }, tr)).toEqual([
      { key: 'mode', label: text.flex, value: tr(en, zh) },
    ])
  })

  it.each([{}, { mode: undefined }])('keeps absent optional mode neutral: %j', (summary) => {
    expect(attendanceGroupEffectivePolicyDetails('flex', summary, tr)).toEqual([
      { key: 'mode', label: text.flex, value: text.notProvided },
    ])
  })

  it.each([
    ['org_default', 'Organization default rule', '组织默认规则'],
    ['group_rule_set', 'Group rule set', '组规则集'],
  ])('renders rule source %s', (source, en, zh) => {
    expect(attendanceGroupEffectivePolicyDetails('rules', { source }, tr)).toEqual([
      { key: 'source', label: text.rules, value: tr(en, zh) },
    ])
  })

  it('renders only organization inheritance for punch and all request postures', () => {
    expect(attendanceGroupEffectivePolicyDetails('punchMethod', { source: 'org_inherited' }, tr)).toEqual([
      { key: 'source', label: text.punch, value: text.inherited },
    ])
    expect(attendanceGroupEffectivePolicyDetails('requestPosture', {
      overtime: 'org_inherited',
      makeupPunch: 'org_inherited',
      outdoor: 'org_inherited',
    }, tr)).toEqual([
      { key: 'overtime', label: text.overtime, value: text.inherited },
      { key: 'makeupPunch', label: text.makeupPunch, value: text.inherited },
      { key: 'outdoor', label: text.outdoor, value: text.inherited },
    ])
  })

  it.each([null, 'private-mode-value', 'fixed_shift', '', 0, false, {}, []].map((mode) => ({ mode })))(
    'rejects invalid optional mode without fallback or raw echo: %j',
    ({ mode }) => {
      expect(attendanceGroupEffectivePolicyDetails('flex', { mode }, tr)).toEqual([
        { key: 'mode', label: text.flex, value: text.unrecognized },
      ])
    },
  )

  it.each([undefined, null, 'private-enum-value', '', '__proto__', 'toString', 0, false, {}, []].map((value) => ({ value })))(
    'rejects missing or invalid required fields without raw echo: %j',
    ({ value }) => {
      expect(attendanceGroupEffectivePolicyDetails('schedule', { strategy: value }, tr)).toEqual([
        { key: 'strategy', label: text.schedule, value: text.unrecognized },
      ])
      expect(attendanceGroupEffectivePolicyDetails('rules', { source: value }, tr)).toEqual([
        { key: 'source', label: text.rules, value: text.unrecognized },
      ])
      expect(attendanceGroupEffectivePolicyDetails('punchMethod', { source: value }, tr)).toEqual([
        { key: 'source', label: text.punch, value: text.unrecognized },
      ])
      expect(attendanceGroupEffectivePolicyDetails('requestPosture', {
        overtime: value,
        makeupPunch: value,
        outdoor: value,
      }, tr)).toEqual([
        { key: 'overtime', label: text.overtime, value: text.unrecognized },
        { key: 'makeupPunch', label: text.makeupPunch, value: text.unrecognized },
        { key: 'outdoor', label: text.outdoor, value: text.unrecognized },
      ])
    },
  )

  it.each(['effective', 'preview_only', 'needs_configuration', 'conflict_action_required', 'org_default', 'group_rule_set'])(
    'does not accept another valid source label or rule source as inheritance: %s',
    (source) => {
      expect(attendanceGroupEffectivePolicyDetails('punchMethod', { source }, tr)).toEqual([
        { key: 'source', label: text.punch, value: text.unrecognized },
      ])
      expect(attendanceGroupEffectivePolicyDetails('requestPosture', {
        overtime: source,
        makeupPunch: source,
        outdoor: source,
      }, tr)).toEqual([
        { key: 'overtime', label: text.overtime, value: text.unrecognized },
        { key: 'makeupPunch', label: text.makeupPunch, value: text.unrecognized },
        { key: 'outdoor', label: text.outdoor, value: text.unrecognized },
      ])
    },
  )

  it.each(['overtime', 'makeupPunch', 'outdoor'] as const)(
    'validates %s independently of its siblings',
    (field) => {
      for (const value of [undefined, null, 'private-posture-value']) {
        const summary: Record<string, unknown> = {
          overtime: 'org_inherited',
          makeupPunch: 'org_inherited',
          outdoor: 'org_inherited',
        }
        if (value === undefined) delete summary[field]
        else summary[field] = value
        expect(attendanceGroupEffectivePolicyDetails('requestPosture', summary, tr)).toEqual([
          { key: 'overtime', label: text.overtime, value: field === 'overtime' ? text.unrecognized : text.inherited },
          { key: 'makeupPunch', label: text.makeupPunch, value: field === 'makeupPunch' ? text.unrecognized : text.inherited },
          { key: 'outdoor', label: text.outdoor, value: field === 'outdoor' ? text.unrecognized : text.inherited },
        ])
      }
    },
  )

  it.each([
    undefined, null, [], 'private-summary-value', 0, false,
    Object.assign([], { strategy: 'fixed_shift', mode: 'strict', source: 'org_inherited' }),
  ].map((summary) => ({ summary })))('handles non-object or array summaries without reading their fields: %j', ({ summary }) => {
    expect(attendanceGroupEffectivePolicyDetails('schedule', summary, tr)).toEqual([
      { key: 'strategy', label: text.schedule, value: text.unrecognized },
    ])
    expect(attendanceGroupEffectivePolicyDetails('flex', summary, tr)).toEqual([
      { key: 'mode', label: text.flex, value: text.notProvided },
    ])
    expect(attendanceGroupEffectivePolicyDetails('rules', summary, tr)).toEqual([
      { key: 'source', label: text.rules, value: text.unrecognized },
    ])
    expect(attendanceGroupEffectivePolicyDetails('punchMethod', summary, tr)).toEqual([
      { key: 'source', label: text.punch, value: text.unrecognized },
    ])
    expect(attendanceGroupEffectivePolicyDetails('requestPosture', summary, tr)).toEqual([
      { key: 'overtime', label: text.overtime, value: text.unrecognized },
      { key: 'makeupPunch', label: text.makeupPunch, value: text.unrecognized },
      { key: 'outdoor', label: text.outdoor, value: text.unrecognized },
    ])
  })

  it('ignores private fields, identifiers, labels and states without mutating input', () => {
    const summary = Object.freeze({
      strategy: 'fixed_shift',
      mode: 'flex_required_duration',
      source: 'org_default',
      overtime: 'org_inherited',
      makeupPunch: 'org_inherited',
      outdoor: 'org_inherited',
      groupId: 'private-group-id',
      ruleSetId: 'private-rule-id',
      authorityCode: 'private-authority-code',
      appKey: 'private-app-key',
      raw: { mode: 'strict' },
      label: 'conflict_action_required',
      state: 'effective',
    })
    expect(attendanceGroupEffectivePolicyDetails('schedule', summary, tr)).toEqual([
      { key: 'strategy', label: text.schedule, value: tr('Fixed shift', '固定班') },
    ])
    expect(attendanceGroupEffectivePolicyDetails('flex', summary, tr)).toEqual([
      { key: 'mode', label: text.flex, value: tr('Required duration', '固定时长弹性') },
    ])
    expect(attendanceGroupEffectivePolicyDetails('rules', summary, tr)).toEqual([
      { key: 'source', label: text.rules, value: tr('Organization default rule', '组织默认规则') },
    ])
    expect(attendanceGroupEffectivePolicyDetails('punchMethod', summary, tr)).toEqual([
      { key: 'source', label: text.punch, value: text.unrecognized },
    ])
    expect(attendanceGroupEffectivePolicyDetails('requestPosture', summary, tr)).toEqual([
      { key: 'overtime', label: text.overtime, value: text.inherited },
      { key: 'makeupPunch', label: text.makeupPunch, value: text.inherited },
      { key: 'outdoor', label: text.outdoor, value: text.inherited },
    ])
    expect(attendanceGroupEffectivePolicyDetails('rules', { source: 'org_inherited' }, tr)).toEqual([
      { key: 'source', label: text.rules, value: text.unrecognized },
    ])
    expect(attendanceGroupEffectivePolicyDetails('schedule', { groupType: 'fixed_shift' }, tr)).toEqual([
      { key: 'strategy', label: text.schedule, value: text.unrecognized },
    ])
  })

  it.each(['membership', 'segments'] as const)('returns no detail rows for %s', (key) => {
    for (const summary of [null, [], {}, {
      strategy: 'fixed_shift',
      mode: 'strict',
      source: 'org_inherited',
      overtime: 'org_inherited',
      makeupPunch: 'org_inherited',
      outdoor: 'org_inherited',
      raw: 'private-summary-value',
    }]) {
      expect(attendanceGroupEffectivePolicyDetails(key, summary, tr)).toEqual([])
    }
  })
})
