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
const EMPTY_VALUE_OPERATORS = new Set<ConditionOperator>(['is_empty', 'is_not_empty'])
const EQUALITY_OPERATORS = new Set<ConditionOperator>([
  'equals',
  'not_equals',
  'in',
  'not_in',
  'is_empty',
  'is_not_empty',
])
const TEXT_OPERATORS = new Set<ConditionOperator>([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'in',
  'not_in',
  'is_empty',
  'is_not_empty',
])
const COMPARABLE_OPERATORS = new Set<ConditionOperator>([
  'equals',
  'not_equals',
  'greater_than',
  'less_than',
  'greater_or_equal',
  'less_or_equal',
  'in',
  'not_in',
  'is_empty',
  'is_not_empty',
])
const MULTI_VALUE_OPERATORS = new Set<ConditionOperator>([
  'contains',
  'not_contains',
  'in',
  'not_in',
  'is_empty',
  'is_not_empty',
])

export interface AutomationCondition {
  fieldId: string
  operator: ConditionOperator
  value?: unknown
}

export type AutomationConditionField = {
  id: string
  type: string
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

function allowedOperatorsForFieldType(fieldType: string): ReadonlySet<ConditionOperator> {
  switch (fieldType) {
    case 'number':
    case 'currency':
    case 'percent':
    case 'rating':
    case 'date':
    case 'dateTime':
    case 'createdTime':
    case 'modifiedTime':
    case 'autoNumber':
      return COMPARABLE_OPERATORS
    case 'boolean':
    case 'select':
    case 'person':
    case 'user':
    case 'link':
    case 'lookup':
    case 'rollup':
    case 'createdBy':
    case 'modifiedBy':
      return EQUALITY_OPERATORS
    case 'multiSelect':
      return MULTI_VALUE_OPERATORS
    case 'attachment':
      return EMPTY_VALUE_OPERATORS
    default:
      return TEXT_OPERATORS
  }
}

function expectedValueKindForFieldType(fieldType: string): 'number' | 'boolean' | 'string' | null {
  switch (fieldType) {
    case 'number':
    case 'currency':
    case 'percent':
    case 'rating':
    case 'autoNumber':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'attachment':
      return null
    default:
      return 'string'
  }
}

function assertNumericValue(value: unknown, path: string, allowNumericString: boolean): void {
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (allowNumericString && typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed && Number.isFinite(Number(trimmed))) return
  }
  throw new ConditionGroupValidationError(`${path} must be a number`)
}

function assertConditionValueType(
  condition: AutomationCondition,
  fieldType: string,
  path: string,
): void {
  if (!VALUE_REQUIRED_OPERATORS.has(condition.operator)) return

  const expectedKind = expectedValueKindForFieldType(fieldType)
  if (!expectedKind) return

  const isArrayOperator = ARRAY_VALUE_OPERATORS.has(condition.operator)
  if (isArrayOperator && !Array.isArray(condition.value)) {
    throw new ConditionGroupValidationError(`${path}.value must be an array for ${condition.operator}`)
  }
  const values: unknown[] = isArrayOperator ? condition.value as unknown[] : [condition.value]
  if (isArrayOperator && values.length === 0) {
    throw new ConditionGroupValidationError(`${path}.value must not be empty for ${condition.operator}`)
  }

  values.forEach((value, index) => {
    const valuePath = isArrayOperator ? `${path}.value[${index}]` : `${path}.value`
    if (expectedKind === 'number') {
      assertNumericValue(value, valuePath, isArrayOperator)
      return
    }
    if (expectedKind === 'boolean') {
      if (typeof value !== 'boolean') {
        throw new ConditionGroupValidationError(`${valuePath} must be a boolean`)
      }
      return
    }
    if (typeof value !== 'string') {
      throw new ConditionGroupValidationError(`${valuePath} must be a string`)
    }
  })
}

function validateConditionNodeAgainstFields(
  node: AutomationConditionNode,
  fieldsById: Map<string, AutomationConditionField>,
  path: string,
): void {
  if (isConditionGroup(node)) {
    node.conditions.forEach((condition, index) =>
      validateConditionNodeAgainstFields(condition, fieldsById, `${path}.conditions[${index}]`),
    )
    return
  }

  const field = fieldsById.get(node.fieldId)
  if (!field) {
    throw new ConditionGroupValidationError(`${path}.fieldId does not exist on sheet: ${node.fieldId}`)
  }

  const allowedOperators = allowedOperatorsForFieldType(field.type)
  if (!allowedOperators.has(node.operator)) {
    throw new ConditionGroupValidationError(
      `${path}.operator ${node.operator} is not supported for field type ${field.type}`,
    )
  }

  assertConditionValueType(node, field.type, path)
}

export function validateConditionGroupAgainstFields(
  conditionGroup: ConditionGroup | null | undefined,
  fields: AutomationConditionField[],
  path = 'conditions',
): void {
  if (!conditionGroup) return
  const fieldsById = new Map(fields.map((field) => [field.id, field]))
  conditionGroup.conditions.forEach((condition, index) =>
    validateConditionNodeAgainstFields(condition, fieldsById, `${path}.conditions[${index}]`),
  )
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
