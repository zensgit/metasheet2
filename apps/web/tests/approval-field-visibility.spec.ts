import { describe, expect, it } from 'vitest'

import {
  describeFieldVisibilityRule,
  getVisibleFormFields,
  pruneHiddenFormData,
} from '../src/approvals/fieldVisibility'
import {
  CONDITION_VALUE_COPY_EN,
  CONDITION_VALUE_COPY_ZH,
  conditionValueIssueMessage,
  parseConditionListText,
  parseConditionNumber,
  sameConditionList,
  visibilityOperatorsFor,
  visibilityRuleValueIssues,
} from '../src/approvals/conditionValueTyping'
import type { FormSchema } from '../src/types/approval'

const formSchema: FormSchema = {
  fields: [
    {
      id: 'showDetails',
      type: 'select',
      label: '是否补充说明',
      required: true,
      options: [
        { label: '是', value: 'yes' },
        { label: '否', value: 'no' },
      ],
    },
    {
      id: 'details',
      type: 'textarea',
      label: '补充说明',
      required: true,
      visibilityRule: {
        fieldId: 'showDetails',
        operator: 'eq',
        value: 'yes',
      },
    },
  ],
}

describe('approval field visibility helper', () => {
  it('hides dependent fields until the rule is satisfied', () => {
    expect(getVisibleFormFields(formSchema, { showDetails: 'no' }).map((field) => field.id)).toEqual(['showDetails'])
    expect(getVisibleFormFields(formSchema, { showDetails: 'yes' }).map((field) => field.id)).toEqual(['showDetails', 'details'])
  })

  it('prunes hidden values before submission', () => {
    expect(pruneHiddenFormData(formSchema, {
      showDetails: 'no',
      details: 'stale hidden text',
    })).toEqual({
      showDetails: 'no',
    })
  })

  it('renders a readable rule summary', () => {
    // R-43 (B): the stored option VALUE (`yes`) renders as its option NAME (`是`).
    expect(describeFieldVisibilityRule(formSchema.fields[1], formSchema)).toBe(
      '当 是否补充说明 等于 是 时显示',
    )
  })
})

// R-43 (B) — condition values by field type. The editors store the type the (unchanged) evaluator
// compares against; these pin the summary names, the evaluator semantics the "front-end only" fix
// relies on, and the pure typing helpers.
describe('R-43 (B) visibility summary shows option names', () => {
  const withRule = (rule: FormSchema['fields'][number]['visibilityRule'], options = formSchema.fields[0].options): FormSchema => ({
    fields: [
      { ...formSchema.fields[0], options },
      { ...formSchema.fields[1], visibilityRule: rule },
    ],
  })

  it('in: every value renders as its option name, joined with 、', () => {
    const schema = withRule({ fieldId: 'showDetails', operator: 'in', values: ['yes', 'no'] })
    expect(describeFieldVisibilityRule(schema.fields[1], schema)).toBe('当 是否补充说明 属于 是、否 时显示')
  })

  it('a value no current option carries falls back to the raw value, marked; a field with no options stays unmarked', () => {
    const marked = withRule({ fieldId: 'showDetails', operator: 'eq', value: 'gone' })
    expect(describeFieldVisibilityRule(marked.fields[1], marked)).toBe('当 是否补充说明 等于 gone（不在当前选项中） 时显示')
    const noOptions = withRule({ fieldId: 'showDetails', operator: 'eq', value: 'gone' }, [])
    expect(describeFieldVisibilityRule(noOptions.fields[1], noOptions)).toBe('当 是否补充说明 等于 gone 时显示')
  })

  it('a renamed option shows the new name while the stored value is unchanged', () => {
    const renamed = withRule({ fieldId: 'showDetails', operator: 'eq', value: 'yes' }, [
      { label: '需要', value: 'yes' },
      { label: '否', value: 'no' },
    ])
    expect(describeFieldVisibilityRule(renamed.fields[1], renamed)).toBe('当 是否补充说明 等于 需要 时显示')
    expect(renamed.fields[1].visibilityRule).toEqual({ fieldId: 'showDetails', operator: 'eq', value: 'yes' })
  })
})

describe('R-43 (B) evaluator semantics the typed editors rely on (unchanged evaluator)', () => {
  const typed: FormSchema = {
    fields: [
      { id: 'kind', type: 'select', label: '类型', options: [{ label: '出差', value: 'opt_a' }, { label: '其他', value: 'opt_b' }] },
      { id: 'tags', type: 'multi-select', label: '标签', options: [{ label: '加急', value: 'opt_a' }, { label: '普通', value: 'opt_b' }] },
      { id: 'amount', type: 'number', label: '金额' },
      { id: 'byKind', type: 'text', label: 'A', visibilityRule: { fieldId: 'kind', operator: 'eq', value: 'opt_a' } },
      { id: 'byTags', type: 'text', label: 'B', visibilityRule: { fieldId: 'tags', operator: 'in', values: ['opt_a'] } },
      { id: 'byAmount', type: 'text', label: 'C', visibilityRule: { fieldId: 'amount', operator: 'eq', value: 5000 } },
      { id: 'byAmountText', type: 'text', label: 'D', visibilityRule: { fieldId: 'amount', operator: 'eq', value: '5000' } },
    ],
  }
  const visible = (data: Record<string, unknown>) => getVisibleFormFields(typed, data).map((field) => field.id)

  it('single select eq matches the option VALUE, never its name', () => {
    expect(visible({ kind: 'opt_a' })).toContain('byKind')
    expect(visible({ kind: '出差' })).not.toContain('byKind')
  })

  it('multi select in matches when any picked value is listed', () => {
    expect(visible({ tags: ['opt_b', 'opt_a'] })).toContain('byTags')
    expect(visible({ tags: ['opt_b'] })).not.toContain('byTags')
  })

  it('number eq matches a NUMBER rule value; a numeric STRING rule value never matches', () => {
    expect(visible({ amount: 5000 })).toContain('byAmount')
    expect(visible({ amount: 5000 })).not.toContain('byAmountText')
  })
})

describe('R-43 (B) conditionValueTyping helpers', () => {
  const single = { type: 'select' as const, options: [{ label: '甲', value: 'opt_a' }, { label: '乙', value: 'opt_b' }] }
  const multi = { type: 'multi-select' as const, options: single.options }
  const number = { type: 'number' as const, options: [] }
  const text = { type: 'text' as const, options: [] }

  it('multi select offers only the operators that can take effect', () => {
    expect(visibilityOperatorsFor('option-multi')).toEqual(['in', 'isEmpty', 'notEmpty'])
    for (const kind of ['option-single', 'number', 'text'] as const) {
      expect(visibilityOperatorsFor(kind)).toEqual(['eq', 'neq', 'in', 'isEmpty', 'notEmpty'])
    }
  })

  it('visibilityRuleValueIssues marks rules that can never take effect (and nothing else)', () => {
    expect(visibilityRuleValueIssues({ operator: 'eq', value: 'opt_a' }, multi)).toEqual(['operator-not-effective'])
    expect(visibilityRuleValueIssues({ operator: 'eq', value: 'opt_gone' }, single)).toEqual(['value-not-option'])
    expect(visibilityRuleValueIssues({ operator: 'eq', value: '' }, single)).toEqual([])
    expect(visibilityRuleValueIssues({ operator: 'eq', value: 'opt_a' }, single)).toEqual([])
    expect(visibilityRuleValueIssues({ operator: 'in', values: ['opt_a', 'opt_gone'] }, multi)).toEqual(['value-not-option'])
    expect(visibilityRuleValueIssues({ operator: 'eq', value: '5000' }, number)).toEqual(['not-number'])
    expect(visibilityRuleValueIssues({ operator: 'eq', value: 5000 }, number)).toEqual([])
    expect(visibilityRuleValueIssues({ operator: 'in', values: [1, 'x'] }, number)).toEqual(['not-number'])
    expect(visibilityRuleValueIssues({ operator: 'eq', value: 'anything' }, text)).toEqual([])
    expect(visibilityRuleValueIssues({ operator: 'eq', value: 'opt_gone' }, null)).toEqual([])
    expect(visibilityRuleValueIssues({ operator: 'notEmpty' }, multi)).toEqual([])
    // Gate r1 F1: eq/neq compare ONE value — a stored list never (eq) / always (neq) matches.
    expect(visibilityRuleValueIssues({ operator: 'eq', value: ['a', 'b'] }, text)).toEqual(['list-not-scalar'])
    expect(visibilityRuleValueIssues({ operator: 'neq', value: [1] }, number)).toEqual(['list-not-scalar'])
    expect(visibilityRuleValueIssues({ operator: 'eq', value: ['opt_a'] }, single)).toEqual(['list-not-scalar'])
    expect(visibilityRuleValueIssues({ operator: 'in', values: ['opt_a'] }, single)).toEqual([])
    // Gate r2 P3-b: an EMPTY list under eq/neq is marked the same way on every kind.
    for (const operator of ['eq', 'neq'] as const) {
      expect(visibilityRuleValueIssues({ operator, value: [] }, single)).toEqual(['list-not-scalar'])
      expect(visibilityRuleValueIssues({ operator, value: [] }, text)).toEqual(['list-not-scalar'])
      expect(visibilityRuleValueIssues({ operator, value: [] }, number)).toEqual(['list-not-scalar'])
    }
    expect(visibilityRuleValueIssues({ operator: 'in', values: [] }, text)).toEqual([])
    // Gate r2 F2-1: a non-string value on a TEXT-type dependency never matches `===` / `includes`
    // (e.g. a number left behind when the dependency was retyped number → text).
    expect(visibilityRuleValueIssues({ operator: 'eq', value: 5 }, text)).toEqual(['not-text'])
    expect(visibilityRuleValueIssues({ operator: 'neq', value: 5 }, text)).toEqual(['not-text'])
    expect(visibilityRuleValueIssues({ operator: 'in', values: [1, 2] }, text)).toEqual(['not-text'])
    expect(visibilityRuleValueIssues({ operator: 'eq', value: 20260101 }, { type: 'date' as const, options: [] })).toEqual(['not-text'])
    expect(visibilityRuleValueIssues({ operator: 'eq', value: '5' }, text)).toEqual([])
    expect(visibilityRuleValueIssues({ operator: 'eq', value: null }, text)).toEqual([])
    expect(visibilityRuleValueIssues({ operator: 'in', values: ['1', '2'] }, text)).toEqual([])
  })

  it('parseConditionNumber / parseConditionListText / sameConditionList', () => {
    expect(parseConditionNumber(' 12 ')).toBe(12)
    expect(parseConditionNumber('1e3')).toBe(1000)
    expect(parseConditionNumber('')).toBeNull()
    expect(parseConditionNumber('1,000')).toBeNull()
    expect(parseConditionNumber(Number.NaN)).toBeNull()
    expect(parseConditionListText('1\n\n x \n2', 'number')).toEqual([1, 'x', 2])
    expect(parseConditionListText(' a \nb', 'text')).toEqual(['a', 'b'])
    expect(sameConditionList([1, 'a'], [1, 'a'])).toBe(true)
    expect(sameConditionList([1], ['1'])).toBe(false)
  })

  it('copy tables: same keys; en has no CJK; zh issue copy is Chinese; copy is values-free', () => {
    const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/
    expect(Object.keys(CONDITION_VALUE_COPY_EN).sort()).toEqual(Object.keys(CONDITION_VALUE_COPY_ZH).sort())
    for (const [key, value] of Object.entries(CONDITION_VALUE_COPY_EN)) {
      const rendered = typeof value === 'function' ? value(2) : value
      expect(CJK.test(rendered), key).toBe(false)
      expect(rendered).not.toContain('opt_')
    }
    for (const issue of ['operator-not-effective', 'value-not-option', 'in-not-list', 'list-not-scalar', 'not-number', 'not-text', 'not-date'] as const) {
      expect(CJK.test(conditionValueIssueMessage(issue, true))).toBe(true)
      expect(CJK.test(conditionValueIssueMessage(issue, false))).toBe(false)
    }
    expect(CONDITION_VALUE_COPY_ZH.staleListHint(2)).toContain('2')
    // Gate r3 F3-1: the stored-value note's prefix is values-free (the value renders outside it).
    expect(CJK.test(CONDITION_VALUE_COPY_ZH.storedValuePrefix)).toBe(true)
    expect(CONDITION_VALUE_COPY_ZH.storedValuePrefix).not.toMatch(/\d/)
    expect(CONDITION_VALUE_COPY_EN.storedValuePrefix).not.toMatch(/\d/)
    expect(CONDITION_VALUE_COPY_ZH.issueNotDate).not.toMatch(/\d/)
    expect(CONDITION_VALUE_COPY_EN.issueNotDate).not.toMatch(/\d/)
    // Gate r1 P3-4: a multi-select eq never matches but neq ALWAYS matches — the copy says both.
    expect(CONDITION_VALUE_COPY_ZH.issueOperatorNotEffective).toContain('永远成立')
    expect(CONDITION_VALUE_COPY_EN.issueOperatorNotEffective).toContain('always matches')
  })
})
