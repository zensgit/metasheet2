// 客户反馈 2026-09-24 #4b（自动化条件按字段类型编辑），裁定见 PR #6074 — the pure value contract shared by the
// rule-level condition rows and the condition_branch rows (automation-condition-values.ts), the typed
// build seam of conditionBranchAuthoring.ts, and the per-type operator / boolean labels.
import { afterEach, describe, expect, it } from 'vitest'
import {
  PENDING_CONDITION_OPERATOR,
  buildConditionLeafForSave,
  coerceConditionValue,
  conditionFieldDisplayType,
  conditionValueWidget,
  isConditionLeafComplete,
  isLegacyPersonLinkConditionField,
  parseDateConditionValue,
  parseDateTimeConditionValue,
  type ConditionFieldLike,
} from '../src/multitable/utils/automation-condition-values'
import {
  buildConditionBranchConfig,
  conditionBranchUnsupportedReason,
  parseConditionBranchDraft,
} from '../src/multitable/utils/conditionBranchAuthoring'
import {
  automationConditionOperatorLabel,
  automationLabel,
} from '../src/multitable/utils/meta-automation-labels'
import { resetBusinessTimezone, setBusinessTimezone } from '../src/multitable/utils/business-timezone'
import type { AutomationCondition, ConditionOperator } from '../src/multitable/types'

const F = {
  num: { id: 'fld_num', name: 'Score', type: 'number' },
  cur: { id: 'fld_cur', name: 'Price', type: 'currency' },
  bool: { id: 'fld_bool', name: 'Done', type: 'boolean' },
  date: { id: 'fld_date', name: 'Due', type: 'date' },
  dt: { id: 'fld_dt', name: 'Start', type: 'dateTime' },
  dtKtm: { id: 'fld_dt_ktm', name: 'Start (Kathmandu)', type: 'dateTime', property: { timezone: 'Asia/Kathmandu' } },
  dtLegacyUtc: { id: 'fld_dt_utc', name: 'Start (legacy UTC marker)', type: 'dateTime', property: { timezone: 'UTC' } },
  person: { id: 'fld_person', name: 'Owner', type: 'person' },
  link: { id: 'fld_link', name: 'Project', type: 'link' },
  sel: { id: 'fld_sel', name: 'Status', type: 'select', options: [{ value: 'todo' }, { value: 'done' }] },
  text: { id: 'fld_text', name: 'Name', type: 'string' },
} satisfies Record<string, ConditionFieldLike>

const FIELDS: ConditionFieldLike[] = Object.values(F)

function cond(fieldId: string, operator: ConditionOperator, value?: unknown): AutomationCondition {
  return value === undefined ? { fieldId, operator } : { fieldId, operator, value }
}

afterEach(() => resetBusinessTimezone())

describe('coerceConditionValue — the saved shape per field type', () => {
  it('number-like fields save a number (single) / numbers (in list); junk is incomplete, never NaN / null', () => {
    expect(coerceConditionValue(cond('x', 'equals', '42.5'), F.num)).toEqual({ ok: true, value: 42.5 })
    expect(coerceConditionValue(cond('x', 'greater_than', ' -3 '), F.cur)).toEqual({ ok: true, value: -3 })
    expect(coerceConditionValue(cond('x', 'equals', 7), F.num)).toEqual({ ok: true, value: 7 })
    expect(coerceConditionValue(cond('x', 'in', '1, 2.5,-3'), F.num)).toEqual({ ok: true, value: [1, 2.5, -3] })
    expect(coerceConditionValue(cond('x', 'equals', 'abc'), F.num)).toEqual({ ok: false })
    expect(coerceConditionValue(cond('x', 'equals', ''), F.num)).toEqual({ ok: false })
    expect(coerceConditionValue(cond('x', 'in', '1, nope'), F.num)).toEqual({ ok: false })
  })

  it('checkbox fields save a boolean; the legacy string spellings map to it', () => {
    expect(coerceConditionValue(cond('x', 'equals', true), F.bool)).toEqual({ ok: true, value: true })
    expect(coerceConditionValue(cond('x', 'equals', 'false'), F.bool)).toEqual({ ok: true, value: false })
    expect(coerceConditionValue(cond('x', 'not_in', ['true', false]), F.bool)).toEqual({ ok: true, value: [true, false] })
    expect(coerceConditionValue(cond('x', 'equals', '是'), F.bool)).toEqual({ ok: false })
  })

  it('checkbox fields: every spelling the backend reads as a boolean (any case, trimmed) saves a real boolean', () => {
    // A9-be (#6107) isBooleanConditionValue / booleanKeyOf accept 'true' / 'false' in any case with spaces
    // around them. The editor must read the same spellings, or a legacy 'TRUE' blocks the save of a rule the
    // backend accepts.
    expect(coerceConditionValue(cond('x', 'equals', 'TRUE'), F.bool)).toEqual({ ok: true, value: true })
    expect(coerceConditionValue(cond('x', 'equals', ' true '), F.bool)).toEqual({ ok: true, value: true })
    expect(coerceConditionValue(cond('x', 'not_equals', 'False'), F.bool)).toEqual({ ok: true, value: false })
    expect(coerceConditionValue(cond('x', 'in', ['TRUE', ' False ']), F.bool)).toEqual({ ok: true, value: [true, false] })
    expect(coerceConditionValue(cond('x', 'in', 'true, FALSE'), F.bool)).toEqual({ ok: true, value: [true, false] })
    // Still only those two words: anything else is incomplete, never guessed.
    expect(coerceConditionValue(cond('x', 'equals', 'yes'), F.bool)).toEqual({ ok: false })
    expect(coerceConditionValue(cond('x', 'equals', '1'), F.bool)).toEqual({ ok: false })
    expect(coerceConditionValue(cond('x', 'equals', 1), F.bool)).toEqual({ ok: false })
    expect(coerceConditionValue(cond('x', 'equals', ' '), F.bool)).toEqual({ ok: false })
  })

  it("date fields save 'YYYY-MM-DD' (floating day, no zone math)", () => {
    expect(coerceConditionValue(cond('x', 'equals', '2026-05-11'), F.date)).toEqual({ ok: true, value: '2026-05-11' })
    expect(coerceConditionValue(cond('x', 'less_than', '2026/5/1'), F.date)).toEqual({ ok: true, value: '2026-05-01' })
    expect(coerceConditionValue(cond('x', 'equals', '2026年9月24日'), F.date)).toEqual({ ok: true, value: '2026-09-24' })
    expect(coerceConditionValue(cond('x', 'in', '2026-05-11, 2026-05-12'), F.date)).toEqual({ ok: true, value: ['2026-05-11', '2026-05-12'] })
    expect(coerceConditionValue(cond('x', 'equals', '5'), F.date)).toEqual({ ok: false }) // not year-first
    expect(coerceConditionValue(cond('x', 'equals', '2026-02-30'), F.date)).toEqual({ ok: false })
    // A zone-less value is the day as written, whatever zone it is read in.
    expect(parseDateConditionValue('2026-05-11T23:30', 'Asia/Shanghai')).toBe('2026-05-11')
    expect(parseDateConditionValue('2026-05-11T23:30', 'America/New_York')).toBe('2026-05-11')
  })

  it("date fields: a value that NAMES its zone is the day of that instant in the field's zone — the day the evaluator reads", () => {
    // Business zone Asia/Shanghai (UTC+8). A9-be dayKeyOf buckets a zoned value with getZonedParts in the
    // field's zone, so it reads '…-23T16:00:00.000Z' as the 24th; saving the day as written ('…-23') would move
    // the rule by a day on an untouched load → save.
    expect(coerceConditionValue(cond('x', 'less_than', '2026-09-23T16:00:00.000Z'), F.date)).toEqual({ ok: true, value: '2026-09-24' })
    expect(coerceConditionValue(cond('x', 'equals', '2026-09-23T15:59:59Z'), F.date)).toEqual({ ok: true, value: '2026-09-23' })
    expect(coerceConditionValue(cond('x', 'equals', '2026-09-24T00:30:00+09:00'), F.date)).toEqual({ ok: true, value: '2026-09-23' }) // 23:30 in Shanghai
    // The explicit-marker fallback of the same grammar (`GMT` / `UTC` / a spaced offset) names an instant too.
    expect(coerceConditionValue(cond('x', 'equals', '2026-09-23 16:00 GMT'), F.date)).toEqual({ ok: true, value: '2026-09-24' })
    expect(coerceConditionValue(cond('x', 'equals', '2026/09/23 16:00 +0000'), F.date)).toEqual({ ok: true, value: '2026-09-24' })
    expect(coerceConditionValue(cond('x', 'in', ['2026-09-23T16:00:00.000Z', '2026-09-25']), F.date)).toEqual({ ok: true, value: ['2026-09-24', '2026-09-25'] })
    // The field's own zone wins over the business zone (America/New_York is UTC-4 in September) …
    const dateNy: ConditionFieldLike = { id: 'fld_date_ny', name: 'Due (NY)', type: 'date', property: { timezone: 'America/New_York' } }
    expect(coerceConditionValue(cond('x', 'less_than', '2026-09-23T16:00:00.000Z'), dateNy)).toEqual({ ok: true, value: '2026-09-23' })
    // … and the server-provided business zone is honoured.
    setBusinessTimezone('Pacific/Auckland') // UTC+12 on 2026-09-23
    expect(coerceConditionValue(cond('x', 'less_than', '2026-09-23T11:00:00.000Z'), F.date)).toEqual({ ok: true, value: '2026-09-23' })
    expect(coerceConditionValue(cond('x', 'less_than', '2026-09-23T12:00:00.000Z'), F.date)).toEqual({ ok: true, value: '2026-09-24' })
    resetBusinessTimezone()
    // The rewrite is idempotent: the saved day comes back unchanged on the next save.
    expect(coerceConditionValue(cond('x', 'less_than', '2026-09-24'), F.date)).toEqual({ ok: true, value: '2026-09-24' })
    // A zoned value that names no real instant is incomplete (save blocked) — never read "as written".
    expect(coerceConditionValue(cond('x', 'equals', '2026-09-23T25:00:00Z'), F.date)).toEqual({ ok: false })
    expect(parseDateConditionValue('2026-09-23T16:00:00.000Z', 'Asia/Shanghai')).toBe('2026-09-24')
    expect(parseDateConditionValue('2026-09-23T16:00:00.000Z', 'UTC')).toBe('2026-09-23')
  })

  it('date-time fields save a UTC ISO instant; a zone-less wall clock is read in the BUSINESS timezone', () => {
    // Default business zone Asia/Shanghai (UTC+8): 09:30 wall clock = 01:30Z.
    expect(coerceConditionValue(cond('x', 'greater_than', '2026-09-24 09:30'), F.dt)).toEqual({ ok: true, value: '2026-09-24T01:30:00.000Z' })
    // The legacy <input type="datetime-local"> spelling is a wall clock too.
    expect(coerceConditionValue(cond('x', 'equals', '2026-09-24T09:30'), F.dt)).toEqual({ ok: true, value: '2026-09-24T01:30:00.000Z' })
    // A field-level zone wins (Asia/Kathmandu is UTC+05:45); the backend's 'UTC' stamp is the "unset" marker.
    expect(coerceConditionValue(cond('x', 'equals', '2026-09-24 09:30'), F.dtKtm)).toEqual({ ok: true, value: '2026-09-24T03:45:00.000Z' })
    expect(coerceConditionValue(cond('x', 'equals', '2026-09-24 09:30'), F.dtLegacyUtc)).toEqual({ ok: true, value: '2026-09-24T01:30:00.000Z' })
    // The server-provided business zone is honoured.
    setBusinessTimezone('Europe/London') // BST, UTC+1 in September
    expect(coerceConditionValue(cond('x', 'equals', '2026-09-24 09:30'), F.dt)).toEqual({ ok: true, value: '2026-09-24T08:30:00.000Z' })
    resetBusinessTimezone()
    // An instant that already names its zone keeps it; a stored UTC ISO string comes back byte-identical.
    expect(coerceConditionValue(cond('x', 'equals', '2026-09-24T09:30:00+09:00'), F.dt)).toEqual({ ok: true, value: '2026-09-24T00:30:00.000Z' })
    expect(coerceConditionValue(cond('x', 'equals', '2026-09-24T01:30:00Z'), F.dt)).toEqual({ ok: true, value: '2026-09-24T01:30:00Z' })
    // A bare date (no time) and junk are incomplete — never silently midnight.
    expect(coerceConditionValue(cond('x', 'equals', '2026-09-24'), F.dt)).toEqual({ ok: false })
    expect(coerceConditionValue(cond('x', 'equals', 'tomorrow'), F.dt)).toEqual({ ok: false })
    expect(parseDateTimeConditionValue('2026-09-24 25:00', 'Asia/Shanghai')).toBeNull()
  })

  it('person / link save ONE id string for equals / not_equals (the shape the backend validates) and an id array for in / not_in', () => {
    expect(coerceConditionValue(cond('x', 'equals', 'u1'), F.person)).toEqual({ ok: true, value: 'u1' }) // already the shape: unchanged
    expect(coerceConditionValue(cond('x', 'equals', ['u1']), F.person)).toEqual({ ok: true, value: 'u1' }) // a picker's one-element list
    expect(coerceConditionValue(cond('x', 'not_equals', ' rec_1 '), F.link)).toEqual({ ok: true, value: 'rec_1' })
    expect(coerceConditionValue(cond('x', 'equals', ['u1', 'u2']), F.person)).toEqual({ ok: false }) // two ids are not one id
    expect(coerceConditionValue(cond('x', 'equals', []), F.person)).toEqual({ ok: false })
    expect(coerceConditionValue(cond('x', 'equals', ''), F.link)).toEqual({ ok: false })
    expect(coerceConditionValue(cond('x', 'in', 'u1, u2'), F.person)).toEqual({ ok: true, value: ['u1', 'u2'] })
    expect(coerceConditionValue(cond('x', 'not_in', ['rec_1', 'rec_2']), F.link)).toEqual({ ok: true, value: ['rec_1', 'rec_2'] })
    expect(coerceConditionValue(cond('x', 'in', [{ id: 'u1' }]), F.link)).toEqual({ ok: false })
    expect(coerceConditionValue(cond('x', 'in', []), F.person)).toEqual({ ok: false })
  })

  it('select / text save a trimmed string; lists split on commas; a vanished field keeps the value as typed', () => {
    expect(coerceConditionValue(cond('x', 'equals', ' done '), F.sel)).toEqual({ ok: true, value: 'done' })
    expect(coerceConditionValue(cond('x', 'in', ['todo', 'done']), F.sel)).toEqual({ ok: true, value: ['todo', 'done'] })
    expect(coerceConditionValue(cond('x', 'contains', ' vip '), F.text)).toEqual({ ok: true, value: 'vip' })
    expect(coerceConditionValue(cond('x', 'in', 'a, b'), F.text)).toEqual({ ok: true, value: ['a', 'b'] })
    expect(coerceConditionValue(cond('x', 'equals', '   '), F.text)).toEqual({ ok: false })
    expect(coerceConditionValue(cond('x', 'equals', '42'), undefined)).toEqual({ ok: true, value: '42' })
  })
})

describe('isConditionLeafComplete / the pending blank row', () => {
  it('a blank row (no field, pending operator) is incomplete; the pending operator is not a real operator', () => {
    expect(PENDING_CONDITION_OPERATOR).toBe('')
    expect(isConditionLeafComplete({ fieldId: '', operator: PENDING_CONDITION_OPERATOR, value: '' }, undefined)).toBe(false)
    expect(isConditionLeafComplete({ fieldId: 'fld_num', operator: PENDING_CONDITION_OPERATOR, value: 5 }, F.num)).toBe(false)
    expect(isConditionLeafComplete(cond('fld_num', 'is_empty'), F.num)).toBe(true)
    expect(isConditionLeafComplete(cond('fld_num', 'equals', '5'), F.num)).toBe(true)
    expect(isConditionLeafComplete(cond('fld_num', 'equals', '5x'), F.num)).toBe(false)
  })

  it('picks the typed widget per field type', () => {
    expect(conditionValueWidget(F.num, 'equals')).toBe('number')
    expect(conditionValueWidget(F.bool, 'equals')).toBe('boolean')
    expect(conditionValueWidget(F.bool, 'in')).toBe('booleanMultiSelect')
    expect(conditionValueWidget(F.date, 'less_than')).toBe('date')
    expect(conditionValueWidget(F.dt, 'greater_than')).toBe('dateTime')
    expect(conditionValueWidget(F.sel, 'equals')).toBe('select')
    expect(conditionValueWidget(F.sel, 'in')).toBe('multiSelect')
    expect(conditionValueWidget(F.person, 'equals')).toBe('person')
    expect(conditionValueWidget(F.link, 'in')).toBe('link')
    expect(conditionValueWidget(F.text, 'contains')).toBe('text')
    expect(conditionValueWidget(null, 'equals')).toBe('text')
  })

  it('a LEGACY link-backed person keeps the record picker (people-sheet record ids) but is presented as a person', () => {
    const legacyPerson: ConditionFieldLike = { id: 'fld_owner', name: '负责人', type: 'link', property: { refKind: 'user', foreignSheetId: 'sheet_people' } }
    expect(isLegacyPersonLinkConditionField(legacyPerson)).toBe(true)
    expect(isLegacyPersonLinkConditionField(F.link)).toBe(false)
    expect(isLegacyPersonLinkConditionField(F.person)).toBe(false)
    expect(conditionValueWidget(legacyPerson, 'in')).toBe('link')
    expect(conditionFieldDisplayType(legacyPerson)).toBe('person')
    expect(conditionFieldDisplayType(F.link)).toBe('link')
    expect(conditionFieldDisplayType(F.person)).toBe('person')
    // Its `in` value is a list of record ids like any link.
    expect(coerceConditionValue(cond('x', 'in', ['rec_zhang', 'rec_li']), legacyPerson)).toEqual({ ok: true, value: ['rec_zhang', 'rec_li'] })
  })
})

describe('buildConditionLeafForSave', () => {
  it('coerces the value and keeps every other key; a non-coercible value is left as-is (never invented)', () => {
    expect(buildConditionLeafForSave({ fieldId: 'fld_num', operator: 'equals', value: '5', note: 'x' } as AutomationCondition, F.num))
      .toEqual({ fieldId: 'fld_num', operator: 'equals', value: 5, note: 'x' })
    const junk = cond('fld_num', 'equals', 'abc')
    expect(buildConditionLeafForSave(junk, F.num)).toBe(junk)
    const unary = { fieldId: 'fld_num', operator: 'is_empty', value: 'left over' } as AutomationCondition
    expect(buildConditionLeafForSave(unary, F.num)).toBe(unary)
  })
})

describe('condition_branch build seam with fields (typed branch values)', () => {
  const typedConfig = {
    branches: [{
      key: 'big',
      label: 'Big order',
      conditions: {
        conjunction: 'AND',
        conditions: [
          { fieldId: 'fld_num', operator: 'greater_than', value: 100 },
          { fieldId: 'fld_bool', operator: 'equals', value: true },
          { fieldId: 'fld_date', operator: 'less_than', value: '2026-12-31' },
          { fieldId: 'fld_dt', operator: 'greater_or_equal', value: '2026-09-24T01:30:00Z' },
          { fieldId: 'fld_person', operator: 'in', value: ['u1', 'u2'] },
          { fieldId: 'fld_link', operator: 'equals', value: 'rec_1' },
          { fieldId: 'fld_sel', operator: 'equals', value: 'done' },
          { fieldId: 'fld_text', operator: 'is_not_empty' },
        ],
      },
      actions: [{ type: 'update_record', config: { fields: { fld_text: 'vip' } } }],
    }],
  }

  it('values already in their typed shape round-trip byte-identically (the invariant holds with fields)', () => {
    expect(conditionBranchUnsupportedReason(typedConfig)).toBeNull()
    const draft = parseConditionBranchDraft(typedConfig)
    expect(buildConditionBranchConfig(draft, { fields: FIELDS })).toEqual(typedConfig)
    expect(JSON.stringify(buildConditionBranchConfig(draft, { fields: FIELDS }))).toBe(JSON.stringify(typedConfig))
  })

  it('legacy branch values saved as strings by the old text box are saved in their typed shape', () => {
    const legacy = {
      branches: [{
        key: 'b1',
        conditions: {
          conjunction: 'OR',
          conditions: [
            { fieldId: 'fld_num', operator: 'equals', value: '5' },
            { fieldId: 'fld_bool', operator: 'equals', value: 'true' },
            { fieldId: 'fld_dt', operator: 'greater_than', value: '2026-09-24T09:30' },
            { fieldId: 'fld_person', operator: 'equals', value: 'u1' },
            { fieldId: 'fld_num', operator: 'in', value: ['1', '2'] },
            { fieldId: 'fld_date', operator: 'less_than', value: '2026-09-23T16:00:00.000Z' },
            { fieldId: 'fld_bool', operator: 'not_equals', value: ' FALSE ' },
          ],
        },
        actions: [],
      }],
    }
    const built = buildConditionBranchConfig(parseConditionBranchDraft(legacy), { fields: FIELDS })
    expect((built.branches as Array<{ conditions: unknown }>)[0].conditions).toEqual({
      conjunction: 'OR',
      conditions: [
        { fieldId: 'fld_num', operator: 'equals', value: 5 },
        { fieldId: 'fld_bool', operator: 'equals', value: true },
        { fieldId: 'fld_dt', operator: 'greater_than', value: '2026-09-24T01:30:00.000Z' },
        { fieldId: 'fld_person', operator: 'equals', value: 'u1' }, // a single id is already the saved shape
        { fieldId: 'fld_num', operator: 'in', value: [1, 2] },
        // A zoned instant on a date field → its day in the field's zone (Asia/Shanghai), the day the evaluator reads.
        { fieldId: 'fld_date', operator: 'less_than', value: '2026-09-24' },
        // Any-case / padded boolean spelling (what the backend reads as false) → a real boolean.
        { fieldId: 'fld_bool', operator: 'not_equals', value: false },
      ],
    })
  })

  it('without fields the seam is the untouched pure A6-3-2a round-trip (verbatim rows)', () => {
    const legacy = { branches: [{ key: 'b1', conditions: { conjunction: 'AND', conditions: [{ fieldId: 'fld_num', operator: 'equals', value: '5' }] }, actions: [] }] }
    expect(buildConditionBranchConfig(parseConditionBranchDraft(legacy))).toEqual(legacy)
  })

  it('parse hands the editor COPIES of the rows — editing a draft row never mutates the loaded config', () => {
    const config = { branches: [{ key: 'b1', conditions: { conjunction: 'AND', conditions: [{ fieldId: 'fld_num', operator: 'equals', value: 1 }] }, actions: [] }] }
    const draft = parseConditionBranchDraft(config)
    draft.branches[0].conditions[0].value = 2
    expect(config.branches[0].conditions.conditions[0].value).toBe(1)
  })
})

describe('labels: per-type operators and checkbox values', () => {
  it('date / date-time ordering operators read 晚于 / 早于 (after / before); codes and other types are unchanged', () => {
    expect(automationConditionOperatorLabel('greater_than', true, 'date')).toBe('晚于')
    expect(automationConditionOperatorLabel('less_than', true, 'dateTime')).toBe('早于')
    expect(automationConditionOperatorLabel('greater_or_equal', true, 'createdTime')).toBe('不早于')
    expect(automationConditionOperatorLabel('less_or_equal', true, 'modifiedTime')).toBe('不晚于')
    expect(automationConditionOperatorLabel('greater_than', false, 'date')).toBe('After')
    expect(automationConditionOperatorLabel('less_than', false, 'dateTime')).toBe('Before')
    expect(automationConditionOperatorLabel('equals', true, 'date')).toBe('等于')
    expect(automationConditionOperatorLabel('greater_than', true, 'number')).toBe('大于')
    expect(automationConditionOperatorLabel('greater_than', true)).toBe('大于')
  })

  it('checkbox values are 是 / 否 (Yes / No) and a field-less row asks for a field first', () => {
    expect(automationLabel('condition.booleanTrue', true)).toBe('是')
    expect(automationLabel('condition.booleanFalse', true)).toBe('否')
    expect(automationLabel('condition.booleanTrue', false)).toBe('Yes')
    expect(automationLabel('condition.booleanFalse', false)).toBe('No')
    expect(automationLabel('condition.selectFieldFirst', true)).toBe('请先选择字段')
  })
})
