// Conditional read-deny rule types + the operator-per-field-type allowlist for the authoring UI.
//
// This MIRRORS the backend evaluator `permission-rule-evaluator.ts` (OPS_BY_TYPE / RuleOperator). The
// backend is authoritative — it re-validates every PUT through parseConditionalRules and evaluates
// per-type at read time. This copy exists only so the authoring UI can filter the operator picker to
// the operators the backend will actually honor for a field type (offering an unsupported operator
// would author a rule that fails closed at evaluation). Keep the two in sync; a unit test asserts the
// shapes match the backend allowlist.

export type RuleOperator =
  | 'eq'
  | 'neq'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'contains'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'before'
  | 'after'
  | 'hasAny'
  | 'hasNone'

export interface ConditionalRuleDTO {
  id: string
  fieldId: string
  operator: RuleOperator
  value?: unknown
  effect: 'deny_read'
}

const TEXT_OPS: RuleOperator[] = ['eq', 'neq', 'isEmpty', 'isNotEmpty', 'contains']
const NUM_OPS: RuleOperator[] = ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'isEmpty', 'isNotEmpty']
const BOOL_OPS: RuleOperator[] = ['eq', 'neq']
const DATE_OPS: RuleOperator[] = ['eq', 'neq', 'before', 'after', 'isEmpty', 'isNotEmpty']
const ARRAY_OPS: RuleOperator[] = ['hasAny', 'hasNone', 'isEmpty', 'isNotEmpty']

// Keyed by the FE MetaFieldType. Types absent here cannot carry a rule (the field picker hides them).
const OPS_BY_FE_TYPE: Record<string, RuleOperator[]> = {
  string: TEXT_OPS,
  longText: TEXT_OPS,
  select: TEXT_OPS,
  url: TEXT_OPS,
  email: TEXT_OPS,
  phone: TEXT_OPS,
  number: NUM_OPS,
  currency: NUM_OPS,
  percent: NUM_OPS,
  rating: NUM_OPS,
  duration: NUM_OPS,
  autoNumber: NUM_OPS,
  boolean: BOOL_OPS,
  date: DATE_OPS,
  dateTime: DATE_OPS,
  createdTime: DATE_OPS,
  modifiedTime: DATE_OPS,
  multiSelect: ARRAY_OPS,
  person: ARRAY_OPS,
}

/** Operators the backend will honor for this FE field type; empty (= rule not authorable) for unknowns. */
export function operatorsForFieldType(type: string | undefined): RuleOperator[] {
  return type ? [...(OPS_BY_FE_TYPE[type] ?? [])] : []
}

/** Whether a field type can carry a conditional rule (has at least one valid operator). */
export function fieldTypeSupportsRule(type: string | undefined): boolean {
  return operatorsForFieldType(type).length > 0
}

/** Operators that take no value input (the value box is hidden for these). */
export function operatorTakesNoValue(op: RuleOperator): boolean {
  return op === 'isEmpty' || op === 'isNotEmpty'
}

const NUMERIC_FE_TYPES = new Set(['number', 'currency', 'percent', 'rating', 'duration', 'autoNumber'])
const ARRAY_FE_TYPES = new Set(['multiSelect', 'person'])

/**
 * Coerce the raw text the author typed into the value shape the evaluator compares against:
 * empty-operators carry no value; numeric fields → a number (NaN guarded back to the raw string so the
 * rule still round-trips and the user can fix it); array fields with hasAny/hasNone → a string[] split on
 * commas; everything else stays a string.
 */
export function coerceRuleValue(fieldType: string | undefined, op: RuleOperator, raw: string): unknown {
  if (operatorTakesNoValue(op)) return undefined
  if (fieldType && NUMERIC_FE_TYPES.has(fieldType)) {
    const n = Number(raw)
    return raw.trim() !== '' && Number.isFinite(n) ? n : raw
  }
  if (fieldType && ARRAY_FE_TYPES.has(fieldType) && (op === 'hasAny' || op === 'hasNone')) {
    return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  }
  return raw
}
