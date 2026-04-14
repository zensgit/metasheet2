/**
 * Automation Condition Engine — V1
 * Simple condition evaluation for "if/then" logic on record data.
 * No nested groups for V1 — flat condition list with AND/OR logic.
 */

export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'greater_than'
  | 'less_than'
  | 'is_empty'
  | 'is_not_empty'
  | 'in'
  | 'not_in'

export interface AutomationCondition {
  fieldId: string
  operator: ConditionOperator
  value?: unknown
}

export interface ConditionGroup {
  logic: 'and' | 'or'
  conditions: AutomationCondition[]
}

/**
 * Evaluate a single condition against a field value.
 */
export function evaluateCondition(
  condition: AutomationCondition,
  recordData: Record<string, unknown>,
): boolean {
  const fieldValue = recordData[condition.fieldId]

  switch (condition.operator) {
    case 'equals':
      return fieldValue === condition.value

    case 'not_equals':
      return fieldValue !== condition.value

    case 'contains': {
      if (typeof fieldValue === 'string' && typeof condition.value === 'string') {
        return fieldValue.includes(condition.value)
      }
      if (Array.isArray(fieldValue)) {
        return fieldValue.includes(condition.value)
      }
      return false
    }

    case 'not_contains': {
      if (typeof fieldValue === 'string' && typeof condition.value === 'string') {
        return !fieldValue.includes(condition.value)
      }
      if (Array.isArray(fieldValue)) {
        return !fieldValue.includes(condition.value)
      }
      return true
    }

    case 'greater_than': {
      if (typeof fieldValue === 'number' && typeof condition.value === 'number') {
        return fieldValue > condition.value
      }
      if (typeof fieldValue === 'string' && typeof condition.value === 'string') {
        return fieldValue > condition.value
      }
      return false
    }

    case 'less_than': {
      if (typeof fieldValue === 'number' && typeof condition.value === 'number') {
        return fieldValue < condition.value
      }
      if (typeof fieldValue === 'string' && typeof condition.value === 'string') {
        return fieldValue < condition.value
      }
      return false
    }

    case 'is_empty':
      return fieldValue === null || fieldValue === undefined || fieldValue === ''

    case 'is_not_empty':
      return fieldValue !== null && fieldValue !== undefined && fieldValue !== ''

    case 'in': {
      if (!Array.isArray(condition.value)) return false
      return (condition.value as unknown[]).includes(fieldValue)
    }

    case 'not_in': {
      if (!Array.isArray(condition.value)) return true
      return !(condition.value as unknown[]).includes(fieldValue)
    }

    default:
      return false
  }
}

/**
 * Evaluate a condition group against record data.
 * AND: all conditions must pass.
 * OR: at least one condition must pass.
 */
export function evaluateConditions(
  conditionGroup: ConditionGroup,
  recordData: Record<string, unknown>,
): boolean {
  const { logic, conditions } = conditionGroup

  if (!conditions || conditions.length === 0) {
    return true // no conditions means always pass
  }

  if (logic === 'and') {
    return conditions.every((c) => evaluateCondition(c, recordData))
  }

  // logic === 'or'
  return conditions.some((c) => evaluateCondition(c, recordData))
}
