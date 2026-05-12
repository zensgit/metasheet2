import { describe, expect, it } from 'vitest'

import {
  evaluateCondition,
  evaluateConditions,
  normalizeConditionGroupInput,
  validateConditionGroupAgainstFields,
  type ConditionGroup,
} from '../../src/multitable/automation-conditions'

describe('multitable automation conditions', () => {
  it('evaluates backend logic=and groups', () => {
    const group: ConditionGroup = {
      logic: 'and',
      conditions: [
        { fieldId: 'status', operator: 'equals', value: 'Ready' },
        { fieldId: 'priority', operator: 'greater_or_equal', value: 2 },
      ],
    }

    expect(evaluateConditions(group, { status: 'Ready', priority: 2 })).toBe(true)
    expect(evaluateConditions(group, { status: 'Ready', priority: 1 })).toBe(false)
  })

  it('evaluates frontend conjunction=AND groups as AND, not OR', () => {
    const group: ConditionGroup = {
      conjunction: 'AND',
      conditions: [
        { fieldId: 'stage', operator: 'equals', value: 'Won' },
        { fieldId: 'amount', operator: 'greater_than', value: 1000 },
      ],
    }

    expect(evaluateConditions(group, { stage: 'Won', amount: 1500 })).toBe(true)
    expect(evaluateConditions(group, { stage: 'Won', amount: 500 })).toBe(false)
  })

  it('evaluates frontend conjunction=OR groups', () => {
    const group: ConditionGroup = {
      conjunction: 'OR',
      conditions: [
        { fieldId: 'stage', operator: 'equals', value: 'Won' },
        { fieldId: 'amount', operator: 'greater_than', value: 1000 },
      ],
    }

    expect(evaluateConditions(group, { stage: 'Lost', amount: 1500 })).toBe(true)
    expect(evaluateConditions(group, { stage: 'Lost', amount: 500 })).toBe(false)
  })

  it('evaluates nested groups recursively', () => {
    const group: ConditionGroup = {
      conjunction: 'AND',
      conditions: [
        { fieldId: 'status', operator: 'is_not_empty' },
        {
          conjunction: 'OR',
          conditions: [
            { fieldId: 'owner', operator: 'equals', value: 'Alice' },
            {
              logic: 'and',
              conditions: [
                { fieldId: 'priority', operator: 'greater_or_equal', value: 3 },
                { fieldId: 'blocked', operator: 'not_equals', value: true },
              ],
            },
          ],
        },
      ],
    }

    expect(evaluateConditions(group, {
      status: 'Open',
      owner: 'Bob',
      priority: 3,
      blocked: false,
    })).toBe(true)
    expect(evaluateConditions(group, {
      status: 'Open',
      owner: 'Bob',
      priority: 3,
      blocked: true,
    })).toBe(false)
  })

  it('supports inclusive comparison operators for frontend payloads', () => {
    expect(evaluateCondition(
      { fieldId: 'score', operator: 'greater_or_equal', value: 10 },
      { score: 10 },
    )).toBe(true)
    expect(evaluateCondition(
      { fieldId: 'score', operator: 'less_or_equal', value: 10 },
      { score: 11 },
    )).toBe(false)
    expect(evaluateCondition(
      { fieldId: 'name', operator: 'less_or_equal', value: 'm' },
      { name: 'alpha' },
    )).toBe(true)
  })

  it('normalizes nested condition groups from untrusted route payloads', () => {
    const group = normalizeConditionGroupInput({
      conjunction: 'and',
      conditions: [
        { fieldId: ' status ', operator: 'is_not_empty' },
        {
          logic: 'OR',
          conditions: [
            { fieldId: 'owner', operator: 'equals', value: 'Alice' },
            { fieldId: 'score', operator: 'in', value: [1, 2, 3] },
          ],
        },
      ],
    })

    expect(group).toEqual({
      conjunction: 'AND',
      conditions: [
        { fieldId: 'status', operator: 'is_not_empty' },
        {
          logic: 'or',
          conditions: [
            { fieldId: 'owner', operator: 'equals', value: 'Alice' },
            { fieldId: 'score', operator: 'in', value: [1, 2, 3] },
          ],
        },
      ],
    })
  })

  it('rejects invalid route condition payloads', () => {
    expect(() => normalizeConditionGroupInput({ conjunction: 'X', conditions: [] }))
      .toThrow('conditions.conjunction must be "AND" or "OR"')
    expect(() => normalizeConditionGroupInput({
      conjunction: 'AND',
      conditions: [{ fieldId: 'status', operator: 'missing' }],
    })).toThrow('conditions.conditions[0].operator is invalid')
    expect(() => normalizeConditionGroupInput({
      conjunction: 'AND',
      conditions: [{ fieldId: 'status', operator: 'in', value: 'Ready' }],
    })).toThrow('conditions.conditions[0].value must be an array for in')
  })

  it('validates condition operators and scalar values against field types', () => {
    const fields = [
      { id: 'status', type: 'string' },
      { id: 'score', type: 'number' },
      { id: 'done', type: 'boolean' },
      { id: 'files', type: 'attachment' },
    ]

    expect(() => validateConditionGroupAgainstFields({
      conjunction: 'AND',
      conditions: [
        { fieldId: 'status', operator: 'contains', value: 'Ready' },
        { fieldId: 'score', operator: 'greater_or_equal', value: 3 },
        { fieldId: 'done', operator: 'equals', value: false },
        { fieldId: 'files', operator: 'is_not_empty' },
      ],
    }, fields)).not.toThrow()

    expect(() => validateConditionGroupAgainstFields({
      conjunction: 'AND',
      conditions: [{ fieldId: 'score', operator: 'contains', value: '3' }],
    }, fields)).toThrow('conditions.conditions[0].operator contains is not supported for field type number')

    expect(() => validateConditionGroupAgainstFields({
      conjunction: 'AND',
      conditions: [{ fieldId: 'score', operator: 'greater_than', value: '3' }],
    }, fields)).toThrow('conditions.conditions[0].value must be a number')

    expect(() => validateConditionGroupAgainstFields({
      conjunction: 'AND',
      conditions: [{ fieldId: 'done', operator: 'equals', value: 'false' }],
    }, fields)).toThrow('conditions.conditions[0].value must be a boolean')

    expect(() => validateConditionGroupAgainstFields({
      conjunction: 'AND',
      conditions: [{ fieldId: 'files', operator: 'equals', value: 'file_1' }],
    }, fields)).toThrow('conditions.conditions[0].operator equals is not supported for field type attachment')
  })

  it('reports unknown fields and nested validation paths', () => {
    const fields = [{ id: 'score', type: 'number' }]

    expect(() => validateConditionGroupAgainstFields({
      conjunction: 'AND',
      conditions: [{ fieldId: 'missing', operator: 'equals', value: 'x' }],
    }, fields)).toThrow('conditions.conditions[0].fieldId does not exist on sheet: missing')

    expect(() => validateConditionGroupAgainstFields({
      conjunction: 'AND',
      conditions: [{
        conjunction: 'OR',
        conditions: [{ fieldId: 'score', operator: 'in', value: [] }],
      }],
    }, fields)).toThrow('conditions.conditions[0].conditions[0].value must not be empty for in')
  })

  it('validates select and multiSelect condition values against configured options', () => {
    const fields = [
      {
        id: 'status',
        type: 'select',
        property: { options: [{ value: 'Ready' }, { value: 'Blocked' }] },
      },
      {
        id: 'tags',
        type: 'multiSelect',
        property: { options: [{ value: 'VIP' }, { value: 'Internal' }] },
      },
    ]

    expect(() => validateConditionGroupAgainstFields({
      conjunction: 'AND',
      conditions: [
        { fieldId: 'status', operator: 'equals', value: 'Ready' },
        { fieldId: 'status', operator: 'in', value: ['Ready', 'Blocked'] },
        { fieldId: 'tags', operator: 'contains', value: 'VIP' },
        { fieldId: 'tags', operator: 'not_in', value: ['Internal'] },
      ],
    }, fields)).not.toThrow()

    expect(() => validateConditionGroupAgainstFields({
      conjunction: 'AND',
      conditions: [{ fieldId: 'status', operator: 'equals', value: 'Done' }],
    }, fields)).toThrow('conditions.conditions[0].value is not a configured option for field status: Done')

    expect(() => validateConditionGroupAgainstFields({
      conjunction: 'AND',
      conditions: [{ fieldId: 'tags', operator: 'not_in', value: ['VIP', 'External'] }],
    }, fields)).toThrow('conditions.conditions[0].value[1] is not a configured option for field tags: External')
  })

  it('keeps select-like fields without configured options backward compatible', () => {
    const fields = [
      { id: 'status', type: 'select', property: { options: [] } },
      { id: 'tags', type: 'multiSelect', property: {} },
    ]

    expect(() => validateConditionGroupAgainstFields({
      conjunction: 'AND',
      conditions: [
        { fieldId: 'status', operator: 'equals', value: 'Legacy status' },
        { fieldId: 'tags', operator: 'in', value: ['Legacy tag'] },
      ],
    }, fields)).not.toThrow()
  })
})
