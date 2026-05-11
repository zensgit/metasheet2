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

const VALID_CONDITION_OPERATORS = new Set<ConditionOperator>([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'greater_than',
  'less_than',
  'greater_or_equal',
  'less_or_equal',
  'is_empty',
  'is_not_empty',
  'in',
  'not_in',
])

const VALUE_REQUIRED_OPERATORS = new Set<ConditionOperator>([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'greater_than',
  'less_than',
  'greater_or_equal',
  'less_or_equal',
  'in',
  'not_in',
])

const ARRAY_VALUE_OPERATORS = new Set<ConditionOperator>(['in', 'not_in'])
const MAX_CONDITION_GROUP_DEPTH = 5

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

export class ConditionGroupValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConditionGroupValidationError'
  }
}

function isConditionGroup(node: AutomationConditionNode): node is ConditionGroup {
  return typeof (node as ConditionGroup).conditions !== 'undefined'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function resolveGroupLogic(conditionGroup: ConditionGroup): 'and' | 'or' {
  const logic = conditionGroup.logic?.toLowerCase()
  if (logic === 'and' || logic === 'or') return logic

  const conjunction = conditionGroup.conjunction?.toLowerCase()
  if (conjunction === 'and' || conjunction === 'or') return conjunction

  return 'and'
}

function normalizeLogicToken(value: unknown, path: string): 'and' | 'or' | null {
  if (value === undefined) return null
  if (typeof value !== 'string') {
    throw new ConditionGroupValidationError(`${path} must be "and" or "or"`)
  }
  const normalized = value.toLowerCase()
  if (normalized === 'and' || normalized === 'or') return normalized
  throw new ConditionGroupValidationError(`${path} must be "and" or "or"`)
}

function normalizeConjunctionToken(value: unknown, path: string): 'AND' | 'OR' | null {
  if (value === undefined) return null
  if (typeof value !== 'string') {
    throw new ConditionGroupValidationError(`${path} must be "AND" or "OR"`)
  }
  const normalized = value.toUpperCase()
  if (normalized === 'AND' || normalized === 'OR') return normalized
  throw new ConditionGroupValidationError(`${path} must be "AND" or "OR"`)
}

function normalizeConditionLeaf(value: unknown, path: string): AutomationCondition {
  if (!isPlainObject(value)) {
    throw new ConditionGroupValidationError(`${path} must be an object`)
  }

  const fieldId = typeof value.fieldId === 'string' ? value.fieldId.trim() : ''
  if (!fieldId) {
    throw new ConditionGroupValidationError(`${path}.fieldId is required`)
  }

  const operator = value.operator
  if (typeof operator !== 'string' || !VALID_CONDITION_OPERATORS.has(operator as ConditionOperator)) {
    throw new ConditionGroupValidationError(`${path}.operator is invalid`)
  }

  const normalizedOperator = operator as ConditionOperator
  if (VALUE_REQUIRED_OPERATORS.has(normalizedOperator) && value.value === undefined) {
    throw new ConditionGroupValidationError(`${path}.value is required for ${normalizedOperator}`)
  }
  if (ARRAY_VALUE_OPERATORS.has(normalizedOperator) && !Array.isArray(value.value)) {
    throw new ConditionGroupValidationError(`${path}.value must be an array for ${normalizedOperator}`)
  }

  const condition: AutomationCondition = { fieldId, operator: normalizedOperator }
  if (value.value !== undefined) condition.value = value.value
  return condition
}

function normalizeConditionNodeInput(
  value: unknown,
  path: string,
  depth: number,
): AutomationConditionNode {
  if (isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, 'conditions')) {
    return normalizeConditionGroupInput(value, path, depth)
  }
  return normalizeConditionLeaf(value, path)
}

export function normalizeConditionGroupInput(
  value: unknown,
  path = 'conditions',
  depth = 0,
): ConditionGroup {
  if (depth > MAX_CONDITION_GROUP_DEPTH) {
    throw new ConditionGroupValidationError(`${path} exceeds maximum nesting depth ${MAX_CONDITION_GROUP_DEPTH}`)
  }
  if (!isPlainObject(value)) {
    throw new ConditionGroupValidationError(`${path} must be an object`)
  }

  const logic = normalizeLogicToken(value.logic, `${path}.logic`)
  const conjunction = normalizeConjunctionToken(value.conjunction, `${path}.conjunction`)
  if (!logic && !conjunction) {
    throw new ConditionGroupValidationError(`${path}.logic or ${path}.conjunction is required`)
  }
  if (logic && conjunction && logic !== conjunction.toLowerCase()) {
    throw new ConditionGroupValidationError(`${path}.logic and ${path}.conjunction must agree`)
  }
  if (!Array.isArray(value.conditions)) {
    throw new ConditionGroupValidationError(`${path}.conditions must be an array`)
  }

  const conditions = value.conditions.map((condition, index) =>
    normalizeConditionNodeInput(condition, `${path}.conditions[${index}]`, depth + 1),
  )

  if (conjunction) return { conjunction, conditions }
  return { logic: logic ?? 'and', conditions }
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
