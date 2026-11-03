import { describe, expect, it } from 'vitest'

import {
  summarizeConditionBranch,
  summarizeConditionNode,
  summarizeConditionRule,
} from '../src/approvals/conditionSummary'
import { CONDITION_RULE_OPERATORS } from '../src/approvals/conditionEdit'
import type { ConditionRule, FormSchema } from '../src/types/approval'

// G-B2-19 — readable condition summaries. Pure-logic matrix: every operator in the runtime
// vocabulary, 且/或 joining, formula mode, label fallback, value formatting, never-throw.

const SCHEMA: FormSchema = {
  fields: [
    { id: 'amount', type: 'number', label: '金额' },
    { id: 'status', type: 'select', label: '状态' },
    { id: 'urgent', type: 'switch', label: '加急' },
  ],
} as FormSchema

describe('summarizeConditionRule', () => {
  it('covers EVERY runtime operator (vocabulary lockstep with conditionEdit)', () => {
    const rendered = CONDITION_RULE_OPERATORS.map((operator) =>
      summarizeConditionRule({ fieldId: 'amount', operator, value: 5000 } as ConditionRule, SCHEMA),
    )
    expect(rendered).toEqual([
      '金额 = 5000',
      '金额 ≠ 5000',
      '金额 > 5000',
      '金额 ≥ 5000',
      '金额 < 5000',
      '金额 ≤ 5000',
      '金额 属于 5000',
      '金额 为空', // isEmpty ignores value
    ])
  })

  it('formats values by type: string quoted, boolean 是/否, array joined', () => {
    expect(summarizeConditionRule({ fieldId: 'status', operator: 'eq', value: 'approved' }, SCHEMA))
      .toBe('状态 = 「approved」')
    expect(summarizeConditionRule({ fieldId: 'urgent', operator: 'eq', value: true }, SCHEMA))
      .toBe('加急 = 是')
    expect(summarizeConditionRule({ fieldId: 'status', operator: 'in', value: ['a', 'b'] }, SCHEMA))
      .toBe('状态 属于 「a」、「b」')
  })

  it('falls back honestly: unknown field → raw id; no schema → raw id; unknown operator → raw op; never throws', () => {
    expect(summarizeConditionRule({ fieldId: 'ghost', operator: 'gt', value: 1 }, SCHEMA)).toBe('ghost > 1')
    expect(summarizeConditionRule({ fieldId: 'amount', operator: 'gt', value: 1 }, null)).toBe('amount > 1')
    expect(summarizeConditionRule({ fieldId: 'amount', operator: 'between' as never, value: 1 }, SCHEMA)).toBe('金额 between 1')
    expect(summarizeConditionRule({ fieldId: 'amount', operator: 'eq', value: { odd: true } } as ConditionRule, SCHEMA))
      .toBe('金额 = {"odd":true}')
  })
})

describe('summarizeConditionBranch', () => {
  it('joins rules with 且 (and, the default) and 或 (or)', () => {
    const rules: ConditionRule[] = [
      { fieldId: 'amount', operator: 'gt', value: 5000 },
      { fieldId: 'urgent', operator: 'eq', value: true },
    ]
    expect(summarizeConditionBranch({ edgeKey: 'e1', rules }, SCHEMA)).toBe('金额 > 5000 且 加急 = 是')
    expect(summarizeConditionBranch({ edgeKey: 'e1', rules, conjunction: 'or' }, SCHEMA)).toBe('金额 > 5000 或 加急 = 是')
  })

  it('formula mode shows the expression verbatim; empty branch is honest', () => {
    expect(summarizeConditionBranch({ edgeKey: 'e1', rules: [], formula: { expression: 'amount * 2 > 100' } }, SCHEMA))
      .toBe('公式：amount * 2 > 100')
    expect(summarizeConditionBranch({ edgeKey: 'e1', rules: [] }, SCHEMA)).toBe('（无规则）')
  })
})

describe('summarizeConditionNode', () => {
  it('one line per branch (predicate leads, edge key stays as provenance) + default fall-through', () => {
    const lines = summarizeConditionNode(
      {
        branches: [
          { edgeKey: 'edge_1', rules: [{ fieldId: 'amount', operator: 'gt', value: 5000 }] },
          { edgeKey: 'edge_2', rules: [] },
        ],
        defaultEdgeKey: 'edge_3',
      },
      SCHEMA,
    )
    expect(lines).toEqual([
      '分支「金额 > 5000」→ edge_1',
      '分支「（无规则）」→ edge_2',
      '默认分支 → edge_3',
    ])
  })

  it('empty/absent branches → only the default line (or nothing at all); never throws', () => {
    expect(summarizeConditionNode({ branches: [] }, SCHEMA)).toEqual([])
    expect(summarizeConditionNode({ branches: [], defaultEdgeKey: 'e9' }, SCHEMA)).toEqual(['默认分支 → e9'])
  })
})

// R-43 (B): select / multi-select rule values are opaque option VALUES — the summary renders the
// option NAME (both the author-side branch headers and the member-side flow preview read this).
describe('R-43 (B) option names in condition summaries', () => {
  const OPTION_SCHEMA = {
    fields: [
      { id: 'kind', type: 'select', label: '类型', options: [{ label: '出差', value: 'opt_trip' }, { label: '其他', value: 'opt_other' }] },
      { id: 'tags', type: 'multi-select', label: '标签', options: [{ label: '加急', value: 'opt_urgent' }, { label: '普通', value: 'opt_normal' }] },
    ],
  } as FormSchema

  it('eq on a select renders the option name (zh and en; names are data, not translated)', () => {
    expect(summarizeConditionRule({ fieldId: 'kind', operator: 'eq', value: 'opt_trip' }, OPTION_SCHEMA)).toBe('类型 = 「出差」')
    expect(summarizeConditionRule({ fieldId: 'kind', operator: 'eq', value: 'opt_trip' }, OPTION_SCHEMA, false)).toBe('类型 = "出差"')
  })

  it('in renders every value as its name (select and multi-select)', () => {
    expect(summarizeConditionRule({ fieldId: 'kind', operator: 'in', value: ['opt_trip', 'opt_other'] }, OPTION_SCHEMA))
      .toBe('类型 属于 「出差」、「其他」')
    expect(summarizeConditionRule({ fieldId: 'tags', operator: 'in', value: ['opt_urgent', 'opt_normal'] }, OPTION_SCHEMA, false))
      .toBe('标签 in "加急", "普通"')
  })

  it('a value no current option carries falls back to the raw value, marked (zh and en)', () => {
    expect(summarizeConditionRule({ fieldId: 'kind', operator: 'eq', value: 'opt_gone' }, OPTION_SCHEMA)).toBe('类型 = 「opt_gone」（不在当前选项中）')
    expect(summarizeConditionRule({ fieldId: 'kind', operator: 'eq', value: 'opt_gone' }, OPTION_SCHEMA, false)).toBe('类型 = "opt_gone" (not a current option)')
  })

  it('a renamed option shows the new name; the rule value is unchanged', () => {
    const renamed = {
      fields: [{ id: 'kind', type: 'select', label: '类型', options: [{ label: '差旅', value: 'opt_trip' }] }],
    } as FormSchema
    const rule = { fieldId: 'kind', operator: 'eq' as const, value: 'opt_trip' }
    expect(summarizeConditionRule(rule, renamed)).toBe('类型 = 「差旅」')
    expect(rule.value).toBe('opt_trip')
  })
})
