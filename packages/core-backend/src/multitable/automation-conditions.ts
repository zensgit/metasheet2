/**
 * Automation Condition Engine
 *
 * Evaluates record predicates for "if/then" automation rules. The evaluator
 * accepts both the older backend `logic: 'and' | 'or'` shape and the current
 * frontend `conjunction: 'AND' | 'OR'` shape, then recurses through nested
 * groups when API clients send them.
 */

export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'greater_than'
  | 'less_than'
  | 'greater_or_equal'
  | 'less_or_equal'
  | 'is_empty'
  | 'is_not_empty'
  | 'in'
  | 'not_in'

export interface AutomationCondition {
  fieldId: string
  operator: ConditionOperator
  value?: unknown
}

export type AutomationConditionNode = AutomationCondition | ConditionGroup

export interface ConditionGroup {
  logic?: 'and' | 'or'
  conjunction?: 'AND' | 'OR' | 'and' | 'or'
  conditions: AutomationConditionNode[]
}

function isConditionGroup(node: AutomationConditionNode): node is ConditionGroup {
  return typeof (node as ConditionGroup).conditions !== 'undefined'
}

function resolveGroupLogic(conditionGroup: ConditionGroup): 'and' | 'or' {
  const logic = conditionGroup.logic?.toLowerCase()
  if (logic === 'and' || logic === 'or') return logic

  const conjunction = conditionGroup.conjunction?.toLowerCase()
  if (conjunction === 'and' || conjunction === 'or') return conjunction

  return 'and'
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

    case 'greater_or_equal': {
      if (typeof fieldValue === 'number' && typeof condition.value === 'number') {
        return fieldValue >= condition.value
      }
      if (typeof fieldValue === 'string' && typeof condition.value === 'string') {
        return fieldValue >= condition.value
      }
      return false
    }

    case 'less_or_equal': {
      if (typeof fieldValue === 'number' && typeof condition.value === 'number') {
        return fieldValue <= condition.value
      }
      if (typeof fieldValue === 'string' && typeof condition.value === 'string') {
        return fieldValue <= condition.value
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

function evaluateConditionNode(
  node: AutomationConditionNode,
  recordData: Record<string, unknown>,
): boolean {
  return isConditionGroup(node)
    ? evaluateConditions(node, recordData)
    : evaluateCondition(node, recordData)
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
  const { conditions } = conditionGroup

  if (!conditions || conditions.length === 0) {
    return true // no conditions means always pass
  }

  const logic = resolveGroupLogic(conditionGroup)
  if (logic === 'and') {
    return conditions.every((c) => evaluateConditionNode(c, recordData))
  }

  // logic === 'or'
  return conditions.some((c) => evaluateConditionNode(c, recordData))
}
