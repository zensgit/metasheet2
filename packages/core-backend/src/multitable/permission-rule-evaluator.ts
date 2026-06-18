/**
 * #18 phase-2 — conditional permission rules: PURE parser + evaluator (slice 2b-S1).
 *
 * UNWIRED ON PURPOSE. This module has no DB, no IO, and is NOT yet called by any route or by the
 * #18 read-deny enforcement seam. A later slice (2b-S2) integrates `evaluateRecordDenied` into the
 * existing per-record read-deny set under adversarial review. Keeping the evaluator pure + exhaustively
 * unit-tested first is the safety discipline for this security arc.
 *
 * Model: a conditional read-deny rule DENIES READ of any record whose field value satisfies the
 * predicate. Rules combine with OR — a record matched by ANY active deny_read rule is denied.
 *
 * FAIL-CLOSED invariant (the core security property): a rule that cannot be evaluated safely —
 * missing/deleted field, operator not allowed for the field type, malformed rule value, or a predicate
 * that throws — DENIES. For a deny-read rule, "when in doubt, hide" is the safe direction. The evaluator
 * NEVER fails open (never lets a broken rule silently grant read).
 *
 * No side-channel leak: the returned `reason` names only the rule id — never the record's predicate
 * field VALUE — so an error/telemetry surface cannot exfiltrate a hidden value.
 */

export type RuleEffect = 'deny_read'

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

export interface ConditionalRule {
  id: string
  fieldId: string
  operator: RuleOperator
  value?: unknown
  effect: RuleEffect
}

export interface FieldMeta {
  id: string
  type: string
  /** A field flagged deleted is treated as missing (fail-closed). */
  deleted?: boolean
}

export interface EvalRecord {
  data: Record<string, unknown>
}

export interface EvalResult {
  denied: boolean
  /** Only ever a rule id (`rule:<id>`); never the record's field value. */
  reason?: string
}

// ── field type → allowed operators (allowlist; a type/op pair not listed fails closed) ──
const TEXT_OPS: RuleOperator[] = ['eq', 'neq', 'isEmpty', 'isNotEmpty', 'contains']
const NUM_OPS: RuleOperator[] = ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'isEmpty', 'isNotEmpty']
const BOOL_OPS: RuleOperator[] = ['eq', 'neq']
const DATE_OPS: RuleOperator[] = ['eq', 'neq', 'before', 'after', 'isEmpty', 'isNotEmpty']
const ARRAY_OPS: RuleOperator[] = ['hasAny', 'hasNone', 'isEmpty', 'isNotEmpty']

const OPS_BY_TYPE: Record<string, RuleOperator[]> = {
  // text-like (the FE field type for plain single-line text is `string`; `text`/`singleLineText` are
  // accepted aliases so a rule authored against either naming evaluates rather than failing closed)
  text: TEXT_OPS,
  string: TEXT_OPS,
  singleLineText: TEXT_OPS,
  longText: TEXT_OPS,
  select: TEXT_OPS,
  url: TEXT_OPS,
  email: TEXT_OPS,
  phone: TEXT_OPS,
  // numeric
  number: NUM_OPS,
  currency: NUM_OPS,
  percent: NUM_OPS,
  rating: NUM_OPS,
  duration: NUM_OPS,
  autoNumber: NUM_OPS,
  // boolean
  boolean: BOOL_OPS,
  checkbox: BOOL_OPS,
  // date-like
  date: DATE_OPS,
  dateTime: DATE_OPS,
  createdTime: DATE_OPS,
  modifiedTime: DATE_OPS,
  // array-like
  multiSelect: ARRAY_OPS,
  person: ARRAY_OPS,
  user: ARRAY_OPS,
}

/**
 * The canonical operator allowlist for a field type (the authoring UI mirrors this to filter the
 * operator picker). An unknown field type → empty list (no operator is valid → any rule on it would
 * fail closed at evaluation). Returned as a fresh array so callers can't mutate the internal map.
 */
export function operatorsForFieldType(type: string): RuleOperator[] {
  return [...(OPS_BY_TYPE[type] ?? [])]
}

const ALL_OPERATORS: ReadonlySet<RuleOperator> = new Set<RuleOperator>([
  ...TEXT_OPS,
  ...NUM_OPS,
  ...DATE_OPS,
  ...ARRAY_OPS,
])

export interface ParsedRulesResult {
  rules: ConditionalRule[]
  rejected: Array<{ raw: unknown; reason: string }>
}

/**
 * Parse + validate raw rule JSON into typed rules. Structurally-invalid rules are REJECTED here (at
 * author time) and never reach the evaluator. Author-time rejection (bad shape / unknown operator /
 * unsupported effect) is distinct from runtime fail-closed: a structurally-valid rule whose field is
 * later deleted parses fine here and denies at evaluation.
 */
export function parseConditionalRules(raw: unknown): ParsedRulesResult {
  const rules: ConditionalRule[] = []
  const rejected: Array<{ raw: unknown; reason: string }> = []
  if (!Array.isArray(raw)) {
    return { rules, rejected: raw == null ? [] : [{ raw, reason: 'rules payload is not an array' }] }
  }
  for (const r of raw) {
    if (r == null || typeof r !== 'object' || Array.isArray(r)) {
      rejected.push({ raw: r, reason: 'rule is not an object' })
      continue
    }
    const obj = r as Record<string, unknown>
    const id = typeof obj.id === 'string' && obj.id.trim().length > 0 ? obj.id.trim() : null
    const fieldId = typeof obj.fieldId === 'string' && obj.fieldId.trim().length > 0 ? obj.fieldId.trim() : null
    if (!id) {
      rejected.push({ raw: r, reason: 'missing id' })
      continue
    }
    if (!fieldId) {
      rejected.push({ raw: r, reason: 'missing fieldId' })
      continue
    }
    if (obj.effect !== 'deny_read') {
      rejected.push({ raw: r, reason: 'unsupported effect (only deny_read in 2b-S1)' })
      continue
    }
    if (typeof obj.operator !== 'string' || !ALL_OPERATORS.has(obj.operator as RuleOperator)) {
      rejected.push({ raw: r, reason: 'unknown operator' })
      continue
    }
    rules.push({ id, fieldId, operator: obj.operator as RuleOperator, value: obj.value, effect: 'deny_read' })
  }
  return { rules, rejected }
}

// ── 2b-S4: content-keyed parse cache ────────────────────────────────────────
// parseConditionalRules is PURE over `raw`, so memoizing by the raw JSON is staleness-free: a rule
// change yields a different key (automatic miss → re-parse), and field changes don't affect parsing
// (fields are evaluated separately). This saves re-parsing identical rule sets across the many read
// surfaces WITHOUT caching DB reads — caching the rules/fields query results would risk stale =
// wrong access, which is unacceptable for a permission feature. Bounded LRU; the freshness guarantee
// stays with the per-read DB load of the rules.
const RULE_PARSE_CACHE = new Map<string, ParsedRulesResult>()
const RULE_PARSE_CACHE_MAX = 256

export function parseConditionalRulesCached(raw: unknown): ParsedRulesResult {
  let key: string | null
  try {
    key = JSON.stringify(raw ?? null)
  } catch {
    key = null // unstringifiable (cycles) → bypass the cache, never throw
  }
  if (key === null) return parseConditionalRules(raw)
  const hit = RULE_PARSE_CACHE.get(key)
  if (hit) {
    RULE_PARSE_CACHE.delete(key)
    RULE_PARSE_CACHE.set(key, hit) // LRU bump
    return hit
  }
  const parsed = parseConditionalRules(raw)
  RULE_PARSE_CACHE.set(key, parsed)
  if (RULE_PARSE_CACHE.size > RULE_PARSE_CACHE_MAX) {
    const oldest = RULE_PARSE_CACHE.keys().next().value
    if (oldest !== undefined) RULE_PARSE_CACHE.delete(oldest)
  }
  return parsed
}

/** Test hook: clear the 2b-S4 parse cache. */
export function _clearConditionalRuleParseCache(): void {
  RULE_PARSE_CACHE.clear()
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true
  if (typeof v === 'string') return v.trim().length === 0
  if (Array.isArray(v)) return v.length === 0
  return false
}

function asNumberOrThrow(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  throw new Error('not a finite number')
}

function asStringOrThrow(v: unknown): string {
  if (typeof v === 'string') return v
  throw new Error('not a string')
}

function asArrayOrThrow(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  throw new Error('not an array')
}

/** Date comparison on canonical strings via Date.parse; throws on an unparseable side. */
function dateMs(v: unknown): number {
  const s = asStringOrThrow(v)
  const ms = Date.parse(s)
  if (Number.isNaN(ms)) throw new Error('unparseable date')
  return ms
}

/**
 * Returns true if the predicate MATCHES (⇒ this rule denies the record). Throws on a genuinely
 * un-evaluable predicate (wrong-typed record value or rule value for the operator); the caller catches
 * and fails closed (denies). Empty checks never throw — an absent value is a well-defined empty.
 */
function predicateMatches(op: RuleOperator, recordValue: unknown, ruleValue: unknown): boolean {
  switch (op) {
    case 'isEmpty':
      return isEmptyValue(recordValue)
    case 'isNotEmpty':
      return !isEmptyValue(recordValue)
    case 'eq':
      // String/number/boolean equality with a type-matched rule value; mismatched types throw → deny.
      if (typeof ruleValue === 'number') return asNumberOrThrow(recordValue) === ruleValue
      if (typeof ruleValue === 'boolean') {
        if (typeof recordValue !== 'boolean') throw new Error('not a boolean')
        return recordValue === ruleValue
      }
      return asStringOrThrow(recordValue) === asStringOrThrow(ruleValue)
    case 'neq':
      return !predicateMatches('eq', recordValue, ruleValue)
    case 'contains':
      return asStringOrThrow(recordValue).includes(asStringOrThrow(ruleValue))
    case 'gt':
      return asNumberOrThrow(recordValue) > asNumberOrThrow(ruleValue)
    case 'lt':
      return asNumberOrThrow(recordValue) < asNumberOrThrow(ruleValue)
    case 'gte':
      return asNumberOrThrow(recordValue) >= asNumberOrThrow(ruleValue)
    case 'lte':
      return asNumberOrThrow(recordValue) <= asNumberOrThrow(ruleValue)
    case 'before':
      return dateMs(recordValue) < dateMs(ruleValue)
    case 'after':
      return dateMs(recordValue) > dateMs(ruleValue)
    case 'hasAny': {
      const rec = asArrayOrThrow(recordValue)
      const want = asArrayOrThrow(ruleValue)
      return rec.some((x) => want.includes(x))
    }
    case 'hasNone': {
      const rec = asArrayOrThrow(recordValue)
      const want = asArrayOrThrow(ruleValue)
      return !rec.some((x) => want.includes(x))
    }
    default:
      // Unreachable for a parsed rule, but fail closed if it ever happens.
      throw new Error('unhandled operator')
  }
}

/**
 * Evaluate whether a record is read-denied by ANY conditional rule. PURE — no DB/IO. Fail-closed:
 * a rule referencing a missing/deleted field, an operator not allowed for the field type, or a
 * predicate that throws on a malformed value DENIES. Returns `{ denied:true, reason:'rule:<id>' }`
 * on the first denying rule (reason carries no record value).
 */
export function evaluateRecordDenied(
  record: EvalRecord,
  rules: ConditionalRule[],
  fieldsById: Record<string, FieldMeta | undefined>,
): EvalResult {
  for (const rule of rules) {
    let denied: boolean
    try {
      const field = fieldsById[rule.fieldId]
      if (!field || field.deleted === true) {
        denied = true // fail-closed: missing / deleted field
      } else {
        const allowed = OPS_BY_TYPE[field.type]
        if (!allowed || !allowed.includes(rule.operator)) {
          denied = true // fail-closed: operator not allowed for this field type
        } else {
          denied = predicateMatches(rule.operator, record.data[rule.fieldId], rule.value)
        }
      }
    } catch {
      denied = true // fail-closed: any thrown predicate (malformed value) denies
    }
    if (denied) return { denied: true, reason: `rule:${rule.id}` }
  }
  return { denied: false }
}
