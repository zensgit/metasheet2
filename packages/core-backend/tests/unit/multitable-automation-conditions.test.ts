import { describe, expect, it } from 'vitest'

import {
  evaluateCondition,
  evaluateConditions,
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
})
