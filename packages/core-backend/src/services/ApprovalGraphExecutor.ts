import type {
  ApprovalAssigneeResolutionMetadata,
  ApprovalAssigneeSource,
  ApprovalAutoApprovalReason,
  ApprovalEdge,
  ApprovalMode,
  ApprovalNode,
  ApprovalNodeConfig,
  ConditionBranch,
  ConditionRule,
  FormField,
  FormFieldVisibilityRule,
  FormSchema,
  HandlerMode,
  HandlerNodeConfig,
  ParallelNodeConfig,
  RuntimeGraph,
} from '../types/approval-product'
import { ServiceError } from './ApprovalBridgeService'
import {
  approvalConditionFormulaHasCaptureProneIdentity,
  approvalConditionFormulaHasDynamicDependency,
  evaluateApprovalConditionFormula,
  type RequesterFormulaContext,
} from './ApprovalConditionFormula'
import { isValidIsoCalendarDate } from '../utils/calendar-date'
import { applySequentialQueueMetadata } from './approval-sequential-mode'

export interface ApprovalGraphAssignment {
  assignmentType: 'user' | 'role'
  assigneeId: string
  nodeKey: string
  sourceStep: number
  metadata?: ApprovalAssigneeResolutionMetadata
}

export interface ApprovalGraphAssignmentResolverInput {
  nodeKey: string
  sourceStep: number
  config: ApprovalNodeConfig
}

export type ApprovalGraphAssignmentResolver = (input: ApprovalGraphAssignmentResolverInput) => ApprovalGraphAssignment[]

export interface ApprovalCcEvent {
  nodeKey: string
  targetType: 'user' | 'role'
  targetId: string
}

export interface ApprovalGraphAutoApprovalEvent {
  nodeKey: string
  sourceStep: number
  approvalMode: ApprovalMode
  reason: ApprovalAutoApprovalReason
  metadata?: Record<string, unknown>
}

/**
 * Per-branch runtime state tracked in `approval_instances.metadata.parallelBranchStates`
 * while an instance is inside a parallel-gateway region.
 *
 * The executor is stateless — the route service passes the current map in and
 * receives an updated map back on each resolution.
 */
export interface ParallelBranchState {
  edgeKey: string
  /** Current frontier inside this branch. `null` once the branch has reached the join node. */
  currentNodeKey: string | null
  complete: boolean
}

export interface ParallelInstanceState {
  parallelNodeKey: string
  joinNodeKey: string
  joinMode: 'all' | 'any'
  branches: Record<string, ParallelBranchState>
}

type BranchAdvance =
  | {
      kind: 'pending-approval'
      approvalNodeKey: string
      assignments: ApprovalGraphAssignment[]
      ccEvents: ApprovalCcEvent[]
      autoApprovalEvents: ApprovalGraphAutoApprovalEvent[]
    }
  | {
      kind: 'reached-join'
      ccEvents: ApprovalCcEvent[]
      autoApprovalEvents: ApprovalGraphAutoApprovalEvent[]
    }

export interface ApprovalGraphResolution {
  status: 'pending' | 'approved'
  currentNodeKey: string | null
  /**
   * Parallel gateway frontier. For non-parallel state this is either omitted
   * or equals `[currentNodeKey]`. When the resolution lands the instance
   * inside a parallel region, every still-pending branch's current approval
   * node is listed here; consumers can use length ≥ 2 as the "in parallel"
   * signal without peeking into metadata.
   */
  currentNodeKeys?: string[]
  currentStep: number | null
  totalSteps: number
  assignments: ApprovalGraphAssignment[]
  ccEvents: ApprovalCcEvent[]
  autoApprovalEvents: ApprovalGraphAutoApprovalEvent[]
  /**
   * Aggregation mode of the node that was just resolved away from (by `resolveAfterApprove`).
   * `null` for `resolveInitialState`, `resolveReturnToNode`, and non-approval advancement paths.
   * Any-mode resolution carries `'any'`; all-mode carries `'all'` only when aggregation is complete
   * (the route short-circuits incomplete all-mode before calling `resolveAfterApprove`).
   */
  aggregateMode: ApprovalMode | null
  /**
   * Indicates that the previous node's aggregation requirement is satisfied and resolution advanced.
   * Always `true` when `resolveAfterApprove` returns (incomplete aggregation never reaches here).
   * `false` from the other entry points that do not represent an aggregation completion event.
   */
  aggregateComplete: boolean
  /**
   * When the resolution enters a parallel region, carries the initial branch
   * state map the route should persist to `metadata.parallelBranchStates`.
   * When the resolution leaves a parallel region (join-all complete), carries
   * the final state map so the caller can archive it before clearing metadata.
   */
  parallelState?: ParallelInstanceState
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isApprovalNodeConfig(config: unknown): config is ApprovalNodeConfig {
  if (!isRecord(config)) return false
  // Lock-4 F4-A (OD-L4-1(a)) gate A-2 — an `auto_approve` node's assignee resolution is SKIPPED
  // entirely (the caller short-circuits BEFORE `resolveAssignmentsForApprovalNode`), so an
  // absent/empty `assigneeSources` and no legacy `assigneeIds` pair is a structurally VALID approval
  // config for this one `approvalType` value ONLY — never for 'manual'/absent, which still require
  // one via the `hasLegacyAssignees || assigneeSources` check below. Without this arm this guard
  // would reject a legitimately-published auto_approve node before the short-circuit is ever
  // reached, throwing "has invalid config" instead of advancing.
  if (config.approvalType === 'auto_approve') return true
  const hasLegacyAssignees = (config.assigneeType === 'user' || config.assigneeType === 'role')
    && Array.isArray(config.assigneeIds)
  return hasLegacyAssignees || Array.isArray(config.assigneeSources)
}

function isConditionBranch(value: unknown): value is ConditionBranch {
  return isRecord(value)
    && typeof value.edgeKey === 'string'
    && Array.isArray(value.rules)
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim().length > 0)
}

function isParallelNodeConfig(config: unknown): config is ParallelNodeConfig {
  return isRecord(config)
    && isNonEmptyStringArray(config.branches)
    && (config.branches as string[]).length >= 2
    && typeof config.joinNodeKey === 'string'
    && config.joinNodeKey.trim().length > 0
    && (config.joinMode === 'all' || config.joinMode === 'any')
}

// Lock-3 §1.1 — a normalized handler config always carries an `assigneeSources` array (empty arrays
// are rejected at authoring, so a runtime handler node always has ≥1 source). Structural only: the
// normalize choke (ApprovalProductService) owns the seven-member registry + prohibition gates.
function isHandlerNodeConfig(config: unknown): config is HandlerNodeConfig {
  return isRecord(config) && Array.isArray(config.assigneeSources)
}

/**
 * Lock-3 §1.1 — handler aggregation mode. Fails CLOSED from line one (unlike `normalizeApprovalMode`,
 * which silently maps any unrecognized mode to `'single'`): only the two evidenced values survive;
 * anything else — including a hand-malformed runtime graph — collapses to `'all'`, the stronger
 * guarantee. Absent ≡ `'all'`. Authoring already rejects out-of-set values (APPROVAL_HANDLER_MODE_INVALID),
 * so this is the runtime backstop, never the primary gate.
 */
function normalizeHandlerMode(value: unknown): HandlerMode {
  return value === 'any' ? 'any' : 'all'
}

function looksLikeComparableDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:$|[T\s].*)/.test(value)
}

function normalizeComparableValue(value: unknown): number | string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.getTime()
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return ''
    const numeric = Number(trimmed)
    if (Number.isFinite(numeric) && trimmed === String(numeric)) {
      return numeric
    }
    const epoch = Date.parse(trimmed)
    if (!Number.isNaN(epoch) && looksLikeComparableDateString(trimmed)) {
      return epoch
    }
    return trimmed
  }
  return null
}

// Lock-7B §0.2 — the ONE type-agnostic emptiness predicate, reused VERBATIM (holes and all: `0`,
// `false`, a whitespace-only string, `{}` are all non-empty) by the required-at-node handler-submit
// check (`ApprovalProductService.ts`) so create-time and node-time never disagree about the same
// value. Exported so that reuse is an import, never a second definition.
export function isEmptyValue(value: unknown): boolean {
  return value === null
    || value === undefined
    || value === ''
    || (Array.isArray(value) && value.length === 0)
}

// Lock-8 L8-B (approval-lock8-field-vocabulary-20260817.md §1.2, OD-L8-4/OD-L8-5/OD-L8-8): the
// granularity enum `date_range.props.dateType` declares. Exactly D-2's two shipped value contracts
// are reused — 'date' compares as the strict lexicographic civil-date string
// (`isValidIsoCalendarDate`); 'date_half_day' and 'date_minute' BOTH compare as Date.parse-able
// instants (§1.2: "each arm reuses D-2's shipped value contract rather than inventing a third" —
// the corpus's 3-way granularity enum maps onto our 2 value contracts, not a third).
export const DATE_RANGE_DATE_TYPES = new Set(['date', 'date_half_day', 'date_minute'])

function isDateRangeEndpointValid(dateType: unknown, value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (dateType === 'date') return isValidIsoCalendarDate(value)
  if (dateType === 'date_half_day' || dateType === 'date_minute') {
    return !Number.isNaN(Date.parse(value))
  }
  // Fail closed: an absent/off-enum dateType (should never survive publish, §1.2's props gate)
  // accepts nothing — never falls through to the permissive instant branch.
  return false
}

/** -1 / 0 / 1 per the arm's own comparison rule (lexicographic for 'date', epoch otherwise). */
function compareDateRangeEndpoints(dateType: unknown, a: string, b: string): number {
  if (dateType === 'date') {
    return a < b ? -1 : a > b ? 1 : 0
  }
  const left = Date.parse(a)
  const right = Date.parse(b)
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Lock-8 L8-B OD-L8-5(a) — a visibility/condition rule's `fieldId` may reference a field's whole
 * value directly, OR — for a `date_range` field ONLY — one of its two endpoints via the dotted
 * address `${fieldId}.start` / `${fieldId}.end` (extending the shipped `{fieldId.columnId}` detail
 * formula-token grammar — `conditionEdit.ts` FE / `ApprovalConditionFormula.ts` BE — to visibility).
 * A bare reference to a date_range field's own id is REFUSED: "never as one comparable value" — a
 * range is not a scalar. Every other type keeps the plain whole-field form; `null` on any
 * unresolvable input (unknown field, malformed address, non-date_range base for a dotted suffix,
 * or a bare date_range id) — callers treat that identically to "field not found" (fail-closed).
 */
export interface VisibilityFieldReference {
  field: FormField
  endpoint?: 'start' | 'end'
}

export function resolveVisibilityFieldReference(
  rawFieldId: string,
  fields: readonly FormField[],
): VisibilityFieldReference | null {
  const fieldMap = new Map(fields.map((field) => [field.id, field]))
  const direct = fieldMap.get(rawFieldId)
  if (direct) {
    // Lock-8 L8-A (§1.1, MS-8): `explanation` carries no value at all — refused as a bare
    // reference the same way date_range's WHOLE value is, and with no endpoint fallback (it has
    // none). A saved graph can never legitimately reach this branch (publish already denies it,
    // ApprovalProductService.ts), but this runtime resolver stays defensive independent of that.
    return direct.type === 'date_range' || direct.type === 'explanation' ? null : { field: direct }
  }
  const dot = rawFieldId.lastIndexOf('.')
  if (dot <= 0 || dot === rawFieldId.length - 1) return null
  const suffix = rawFieldId.slice(dot + 1)
  if (suffix !== 'start' && suffix !== 'end') return null
  const base = fieldMap.get(rawFieldId.slice(0, dot))
  if (!base || base.type !== 'date_range') return null
  return { field: base, endpoint: suffix }
}

/** Read the value a resolved visibility reference points at (whole field, or one date_range endpoint). */
export function readVisibilityReferenceValue(
  reference: VisibilityFieldReference,
  formData: Record<string, unknown>,
): unknown {
  const raw = formData[reference.field.id]
  if (!reference.endpoint) return raw
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)[reference.endpoint]
    : undefined
}

function evaluateVisibilityRule(
  rule: FormFieldVisibilityRule,
  formData: Record<string, unknown>,
  fields: readonly FormField[],
): boolean {
  const reference = resolveVisibilityFieldReference(rule.fieldId, fields)
  const value = reference ? readVisibilityReferenceValue(reference, formData) : undefined
  switch (rule.operator) {
    case 'eq':
      return value === rule.value
    case 'neq':
      return value !== rule.value
    case 'in':
      return Array.isArray(rule.values)
        ? (Array.isArray(value)
          ? value.some((entry) => rule.values!.includes(entry))
          : rule.values.includes(value))
        : false
    case 'isEmpty':
      return isEmptyValue(value)
    case 'notEmpty':
      return !isEmptyValue(value)
    default:
      return false
  }
}

function buildVisibilityLookup(formSchema: FormSchema, formData: Record<string, unknown>): Map<string, boolean> {
  const fieldMap = new Map(formSchema.fields.map((field) => [field.id, field]))
  const cache = new Map<string, boolean>()
  const stack = new Set<string>()

  const isVisible = (fieldId: string): boolean => {
    if (cache.has(fieldId)) {
      return cache.get(fieldId) as boolean
    }

    const field = fieldMap.get(fieldId)
    if (!field) {
      cache.set(fieldId, false)
      return false
    }

    if (!field.visibilityRule) {
      cache.set(fieldId, true)
      return true
    }

    if (stack.has(fieldId)) {
      cache.set(fieldId, false)
      return false
    }

    // OD-L8-5(a): the dependency's OWN visibility is checked against its BASE field id — a dotted
    // `${id}.start`/`${id}.end` endpoint address resolves to the date_range field itself for this
    // purpose (there is no separate "endpoint field" to recurse into). An unresolvable address
    // (never published, but defensive against a stale/older graph) is treated as "not visible",
    // matching the pre-existing missing-field fail-closed behavior below.
    const reference = resolveVisibilityFieldReference(field.visibilityRule.fieldId, formSchema.fields)
    stack.add(fieldId)
    const dependentFieldVisible = reference ? isVisible(reference.field.id) : false
    stack.delete(fieldId)

    const visible = dependentFieldVisible
      ? evaluateVisibilityRule(field.visibilityRule, formData, formSchema.fields)
      : false
    cache.set(fieldId, visible)
    return visible
  }

  for (const field of formSchema.fields) {
    isVisible(field.id)
  }

  return cache
}

export function getVisibleFormFieldIds(formSchema: FormSchema, formData: Record<string, unknown>): Set<string> {
  const visibility = buildVisibilityLookup(formSchema, formData)
  return new Set(formSchema.fields
    .filter((field) => visibility.get(field.id) !== false)
    .map((field) => field.id))
}

export function pruneHiddenFormData(
  formSchema: FormSchema,
  formData: Record<string, unknown>,
): Record<string, unknown> {
  const visibleFieldIds = getVisibleFormFieldIds(formSchema, formData)
  const detailColumnsById = new Map(
    formSchema.fields
      .filter((field): field is FormField & { columns: FormField[] } => field.type === 'detail' && Array.isArray(field.columns))
      .map((field) => [field.id, field.columns]),
  )
  return Object.fromEntries(
    Object.entries(formData)
      .filter(([fieldId]) => visibleFieldIds.has(fieldId))
      .map(([fieldId, value]) => {
        const columns = detailColumnsById.get(fieldId)
        if (columns && Array.isArray(value)) {
          // detail: drop hidden / unknown cells per row (a sub-field visibilityRule is evaluated
          // against that row), recursing through the same prune so behavior matches top-level.
          const subSchema: FormSchema = { fields: columns }
          return [fieldId, value.map((row) => (isRecord(row) ? pruneHiddenFormData(subSchema, row) : row))]
        }
        return [fieldId, value]
      }),
  )
}

/**
 * Lock-1 §K6 precondition (named by the K3 slice sequencing): the executor's approval-mode
 * normalizer must fail CLOSED. The previous arm silently mapped ANY unrecognized mode to
 * `'single'` — for contract-valid data the gap was unreachable (the authoring choke rejects
 * unknown modes, and `asRuntimeGraph` re-normalizes every STORED graph through that same choke on
 * each dispatch), but deploy skew around any future mode would degrade it silently to
 * first-approver-wins with no error and no audit signal —
 * the precise inverse of the S7 governing precedent.
 *
 * Enumerated legitimate inputs (widen-only: every value a re-normalized stored graph can carry):
 *   - `undefined` — the absent default, ≡ `'single'` (the shipped contract; the service-side
 *     normalizer emits the key only when set, and `single` is the documented absent default);
 *   - the five shipped members `'single' | 'all' | 'any' | 'threshold' | 'sequential'` — pass
 *     through unchanged.
 * ANYTHING else (an unknown string, `null`, a non-string) throws a typed error instead of running
 * as `'single'`. `null` is deliberately in the reject set: the authoring choke has always rejected
 * it (`typeof null !== 'string'`), so no legitimately stored graph carries it. The raw value is
 * deliberately NOT echoed into the message (values-free; the node key — template-authored — is).
 */
function normalizeApprovalMode(value: unknown, nodeKey: string): ApprovalMode {
  if (value === undefined) return 'single'
  if (value === 'all' || value === 'any' || value === 'single' || value === 'threshold' || value === 'sequential') return value
  throw new ServiceError(
    `Approval node ${nodeKey} has an unsupported approval mode`,
    400,
    'APPROVAL_MODE_UNSUPPORTED',
    { nodeKey },
  )
}

function evaluateRule(rule: ConditionRule, formData: Record<string, unknown>): boolean {
  const formValue = formData[rule.fieldId]

  switch (rule.operator) {
    case 'isEmpty':
      return isEmptyValue(formValue)
    case 'eq':
      return formValue === rule.value
    case 'neq':
      return formValue !== rule.value
    case 'in':
      if (Array.isArray(rule.value)) {
        const allowedValues = rule.value as unknown[]
        if (Array.isArray(formValue)) {
          return formValue.some((entry) => allowedValues.includes(entry))
        }
        return allowedValues.includes(formValue)
      }
      if (Array.isArray(formValue)) {
        return formValue.includes(rule.value)
      }
      return false
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const left = normalizeComparableValue(formValue)
      const right = normalizeComparableValue(rule.value)
      if (left === null || right === null) return false
      if (rule.operator === 'gt') return left > right
      if (rule.operator === 'gte') return left >= right
      if (rule.operator === 'lt') return left < right
      return left <= right
    }
    default:
      return false
  }
}

export interface ApprovalFormValidationOptions {
  /**
   * The attachment runtime is default-OFF. Keep the pre-feature string/object contract while it is
   * disabled; only the enabled production path accepts the staged attachment-id array.
   */
  attachmentValueMode?: 'legacy' | 'ids'
}

// Lock-7 L7-C — exported so the handler field-write path (applyHandlerFieldWrites) re-runs the SAME
// per-value validators against the FROZEN version schema (create-path validation, one function). This
// inherits Lock-8 MS-3's fail-open default verbatim (`default: return null` below) — asserted, not
// fixed, by Lock-7 G-6.
export function validateFieldType(
  field: FormField,
  value: unknown,
  options: ApprovalFormValidationOptions,
): string | null {
  if (value === undefined || value === null) {
    return null
  }

  switch (field.type) {
    case 'text':
    case 'textarea':
      return typeof value === 'string' || isRecord(value) ? null : `${field.id} must be a string`
    case 'user': {
      const selection = field.props?.selection === 'multi' ? 'multi' : 'single'
      if (selection === 'multi' && !Array.isArray(value)) {
        return `${field.id} must be an array of users`
      }
      const values = Array.isArray(value) ? value : [value]
      if (selection === 'single' && values.length !== 1) {
        return `${field.id} must contain exactly one user`
      }
      // Preserve the field-derived routing door: a blank scalar is an empty anchor, not a
      // malformed principal. The create-time routing guard returns the established values-free
      // APPROVAL_FORM_ROUTING_FIELD_EMPTY response for that case.
      if (values.length === 1 && typeof values[0] === 'string' && values[0].trim().length === 0) {
        return null
      }
      const ids: string[] = []
      for (const entry of values) {
        const id = typeof entry === 'string'
          ? entry.trim()
          : isRecord(entry) && typeof entry.id === 'string'
            ? entry.id.trim()
            : ''
        if (!id) return `${field.id} must contain only user ids or objects with an id`
        ids.push(id)
      }
      if (new Set(ids).size !== ids.length) return `${field.id} must not contain duplicate users`
      if (typeof field.props?.maxSelections === 'number' && ids.length > field.props.maxSelections) {
        return `${field.id} exceeds the configured user selection limit`
      }
      return null
    }
    case 'attachment':
      if (options.attachmentValueMode !== 'ids') {
        return typeof value === 'string' || isRecord(value) ? null : `${field.id} must be a string`
      }
      // #4195 §4.4/§8: an attachment field's submitted value IS the ordered array of staged
      // approval_attachments.id strings (frozen verbatim into form_snapshot at create; the create
      // txn then binds exactly these ids or fails whole). Anything else is rejected fail-closed —
      // the legacy string/record acceptance predated the ratified array-of-ids contract and could
      // freeze an uninterpretable value into the immutable snapshot.
      return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim().length > 0)
        ? null
        : `${field.id} must be an array of attachment ids`
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${field.id} must be a number`
      return Number.isInteger(value) && !Number.isSafeInteger(value)
        ? `${field.id} must be a lossless number`
        : null
    case 'date':
      // Date-ONLY (floating civil date): exactly one real calendar string `YYYY-MM-DD`
      // (leap-year validated, lexically — never via Date.parse, which would smuggle in
      // locale strings, datetime suffixes, and instant semantics). No trim: the form
      // transport passes values through untouched, so padded variants are rejected.
      return typeof value === 'string' && isValidIsoCalendarDate(value)
        ? null
        : `${field.id} must be a date value`
    case 'datetime':
      // Instant semantics (unchanged): any Date.parse-able string or a valid Date object.
      if (typeof value === 'string') {
        return Number.isNaN(Date.parse(value.trim())) ? `${field.id} must be a date value` : null
      }
      return value instanceof Date && !Number.isNaN(value.getTime())
        ? null
        : `${field.id} must be a date value`
    case 'select':
      if (typeof value !== 'string') return `${field.id} must be a string`
      if (field.options?.length && !field.options.some((option) => option.value === value)) {
        return `${field.id} must be one of the configured options`
      }
      return null
    case 'multi-select':
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
        return `${field.id} must be an array of strings`
      }
      if (field.options?.length && value.some((entry) => !field.options!.some((option) => option.value === entry))) {
        return `${field.id} must contain only configured options`
      }
      return null
    case 'department': {
      if (!Array.isArray(value)) {
        return `${field.id} must be an array of departments`
      }
      // Optional array-valued controls submit [] after the user clears them. Required fields are
      // rejected by validateApprovalFormData's shared isEmptyValue gate before reaching this arm.
      if (value.length === 0) return null
      const ids: string[] = []
      for (const entry of value) {
        if (
          !isRecord(entry)
          || Object.keys(entry).length !== 1
          || typeof entry.id !== 'string'
          || !entry.id.trim()
        ) {
          return `${field.id} must contain only exact { id } department values`
        }
        ids.push(entry.id.trim())
      }
      if (new Set(ids).size !== ids.length) {
        return `${field.id} must not contain duplicate departments`
      }
      if (field.props?.selection === 'single' && ids.length !== 1) {
        return `${field.id} must contain exactly one department`
      }
      if (typeof field.props?.maxSelections === 'number' && ids.length > field.props.maxSelections) {
        return `${field.id} exceeds the configured department selection limit`
      }
      return null
    }
    case 'record-link': {
      // FWB-0 Layer 2 structural shape only (sync): exactly one `{ recordId: non-blank string }`.
      // No arrays, free-text ids, or extra keys (incl. target base/sheet overrides). Filler read
      // authorization is an async check outside this function (assembleCreationContext).
      const parsed = parseRecordLinkFormValue(value)
      return parsed.ok
        ? null
        : `${field.id} must be exactly { recordId } (single non-blank string; no free-text id, no multi-value)`
    }
    case 'date_range': {
      // Lock-8 L8-B MS-3: structural shape is exactly `{ start, end }`, both non-blank strings
      // valid for the field's declared `dateType` granularity — no arrays, no extra keys. `dateType`
      // is required-with-no-absent-default at publish (§1.2); a value validated against a missing
      // or off-enum dateType is rejected here too (`isDateRangeEndpointValid` fails closed).
      if (!isRecord(value)) return `${field.id} must be an object`
      const keys = Object.keys(value)
      if (keys.length !== 2 || !keys.includes('start') || !keys.includes('end')) {
        return `${field.id} must be exactly { start, end }`
      }
      const dateType = field.props?.dateType
      if (!isDateRangeEndpointValid(dateType, value.start) || !isDateRangeEndpointValid(dateType, value.end)) {
        return `${field.id} start and end must be valid dates for the declared date type`
      }
      return null
    }
    // Lock-8 L8-A (§1.1, MS-3): explanation accepts NO submitted value — an explicit arm, not the
    // fall-through `default: return null` above (which would make the type fail-OPEN: any value
    // silently accepted). This function only reaches here when `value !== undefined && value !==
    // null` (the early return above already lets an absent/unset value through) — so this arm ONLY
    // fires when a client actually submitted something for a field that must carry nothing.
    case 'explanation':
      return `${field.id} does not accept a submitted value`
    default:
      return null
  }
}

/**
 * FWB-0 Layer 2 — structural parse for a record-link form value.
 * Legal shape is exactly one object `{ recordId: non-blank string }` (trimmed).
 * Rejects arrays, free-text, empty ids, and extra keys (no target override smuggling).
 */
export function parseRecordLinkFormValue(
  value: unknown,
): { ok: true; recordId: string } | { ok: false } {
  if (!isRecord(value)) return { ok: false }
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== 'recordId') return { ok: false }
  const recordId = typeof value.recordId === 'string' ? value.recordId.trim() : ''
  if (!recordId) return { ok: false }
  return { ok: true, recordId }
}

/**
 * FWB-0 Layer 2 — rewrite every valid top-level record-link value to the canonical
 * `{ recordId: trimmed }` shape in-place. Does NOT loosen structural validation: invalid
 * values are left untouched (validateApprovalFormData already rejects them). Call after
 * successful validation and before graph execution / form_snapshot persistence so a value
 * authorized as `rec-1` is never frozen as `{ recordId: '  rec-1  ' }`.
 */
export function canonicalizeRecordLinkFormData(
  formSchema: FormSchema,
  formData: Record<string, unknown>,
): void {
  for (const field of formSchema.fields ?? []) {
    if (field.type !== 'record-link') continue
    const raw = formData[field.id]
    if (raw === undefined || raw === null) continue
    const parsed = parseRecordLinkFormValue(raw)
    if (!parsed.ok) continue
    formData[field.id] = { recordId: parsed.recordId }
  }
}

function getFieldPropNumber(field: FormField, key: string): number | null {
  const raw = field.props?.[key]
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function getFieldPropString(field: FormField, key: string): string | null {
  const raw = field.props?.[key]
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
}

// Lock-7 L7-C — exported for applyHandlerFieldWrites (see validateFieldType above). MS-3 fail-open
// default (`default: return []`) is inherited and asserted by G-6, not fixed here.
export function validateFieldConstraints(field: FormField, value: unknown): string[] {
  if (value === undefined || value === null) {
    return []
  }

  switch (field.type) {
    case 'text':
    case 'textarea': {
      if (typeof value !== 'string') return []
      const errors: string[] = []
      const minLength = getFieldPropNumber(field, 'minLength')
      const maxLength = getFieldPropNumber(field, 'maxLength')
      const pattern = getFieldPropString(field, 'pattern')

      if (minLength !== null && value.length < minLength) {
        errors.push(`${field.id} must be at least ${minLength} characters`)
      }
      if (maxLength !== null && value.length > maxLength) {
        errors.push(`${field.id} must be at most ${maxLength} characters`)
      }
      if (pattern) {
        try {
          if (!new RegExp(pattern).test(value)) {
            errors.push(`${field.id} does not match the required pattern`)
          }
        } catch {
          // Ignore invalid admin-configured regex patterns here and treat them as non-enforced.
        }
      }
      return errors
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return []
      const errors: string[] = []
      const min = getFieldPropNumber(field, 'min')
      const max = getFieldPropNumber(field, 'max')

      if (min !== null && value < min) {
        errors.push(`${field.id} must be at least ${min}`)
      }
      if (max !== null && value > max) {
        errors.push(`${field.id} must be at most ${max}`)
      }
      return errors
    }
    case 'date': {
      // Date-ONLY min/max: compare validated `YYYY-MM-DD` calendar strings directly
      // (lexicographic order IS chronological order for fixed-width ISO dates) — no epoch
      // conversion, so the result is identical in every timezone. The VALUE is already
      // type-validated before constraints run; a defensively re-checked invalid value and
      // admin-configured min/max props that are not themselves valid calendar dates are
      // treated as non-enforced (same precedent as an invalid `pattern` regex above).
      if (typeof value !== 'string' || !isValidIsoCalendarDate(value)) return []
      const errors: string[] = []
      const min = getFieldPropString(field, 'min')
      const max = getFieldPropString(field, 'max')
      if (min && isValidIsoCalendarDate(min) && value < min) {
        errors.push(`${field.id} must be on or after ${min}`)
      }
      if (max && isValidIsoCalendarDate(max) && value > max) {
        errors.push(`${field.id} must be on or before ${max}`)
      }
      return errors
    }
    case 'datetime': {
      // Instant semantics (unchanged): normalize both sides to comparable epochs.
      const valueComparable = normalizeComparableValue(value)
      if (valueComparable === null) return []

      const errors: string[] = []
      const min = getFieldPropString(field, 'min')
      const max = getFieldPropString(field, 'max')
      const minComparable = min ? normalizeComparableValue(min) : null
      const maxComparable = max ? normalizeComparableValue(max) : null

      if (typeof valueComparable === 'number' && typeof minComparable === 'number' && valueComparable < minComparable) {
        errors.push(`${field.id} must be on or after ${min}`)
      }
      if (typeof valueComparable === 'number' && typeof maxComparable === 'number' && valueComparable > maxComparable) {
        errors.push(`${field.id} must be on or before ${max}`)
      }
      return errors
    }
    case 'date_range': {
      // Lock-8 L8-B B-1: `start <= end`, the ONE cross-endpoint check. Values-free (Lock-5 §2.4 /
      // §2.3): the message carries the field id ONLY — never either endpoint — because this array
      // is serialized verbatim into `ServiceError.details` and returned to the client
      // (ApprovalProductService.ts submit path). The shape was already type-validated by
      // `validateFieldType` before constraints run; a malformed value here is silently skipped
      // (same non-enforced precedent as an invalid `pattern`/min/max above) rather than duplicating
      // that check.
      if (!isRecord(value) || typeof value.start !== 'string' || typeof value.end !== 'string') return []
      const dateType = field.props?.dateType
      if (!isDateRangeEndpointValid(dateType, value.start) || !isDateRangeEndpointValid(dateType, value.end)) {
        return []
      }
      return compareDateRangeEndpoints(dateType, value.start, value.end) > 0
        ? [`${field.id} start must not be after end`]
        : []
    }
    default:
      return []
  }
}

// Submit-time validation of a detail (明细) value: an array of row objects. Each row's cells
// are validated against the frozen `columns` with the SAME leaf validators as top-level
// fields; per-row `visibilityRule` decides which cells are required; messages are row-addressed
// (`items[1].qty is required`). Unknown cells are dropped by pruneHiddenFormData before this
// runs, matching the top-level prune-then-validate behavior.
//
// Attachment top-level-only (flag-ON / attachmentValueMode:'ids'): an attachment-typed leaf inside
// a detail group is rejected. Flag-OFF / legacy mode keeps detail-leaf attachment values
// legacy-valid (string/record) for byte compatibility with pre-feature snapshots.
// Lock-7 L7-C — exported for applyHandlerFieldWrites: a `detail` field write re-runs this against the
// frozen sub-schema (per-row visibility + required, same as create).
export function validateDetailFieldValue(
  field: FormField,
  value: unknown,
  options: ApprovalFormValidationOptions,
): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return [`${field.id} must be a list`]
  const errors: string[] = []
  if (field.minRows !== undefined && value.length < field.minRows) {
    errors.push(`${field.id} requires at least ${field.minRows} row(s)`)
  }
  if (field.maxRows !== undefined && value.length > field.maxRows) {
    errors.push(`${field.id} allows at most ${field.maxRows} row(s)`)
  }
  const columns = field.columns ?? []
  // Control 2 of "both controls" when attachments are ON: attachment leaves are top-level only.
  if (options.attachmentValueMode === 'ids') {
    for (const column of columns) {
      if (column.type === 'attachment') {
        errors.push(`${field.id}.${column.id} attachment fields are not allowed inside detail rows`)
      }
    }
    if (errors.length > 0) return errors
  }
  const subSchema: FormSchema = { fields: columns }
  value.forEach((row, rowIndex) => {
    const prefix = `${field.id}[${rowIndex}]`
    if (!isRecord(row)) {
      errors.push(`${prefix} must be an object`)
      return
    }
    const visibleSubIds = getVisibleFormFieldIds(subSchema, row)
    for (const column of columns) {
      if (!visibleSubIds.has(column.id)) continue
      const cell = row[column.id]
      if (column.required && isEmptyValue(cell)) {
        errors.push(`${prefix}.${column.id} is required`)
        continue
      }
      const typeError = validateFieldType(column, cell, options)
      if (typeError) {
        errors.push(`${prefix}.${typeError}`)
        continue
      }
      errors.push(...validateFieldConstraints(column, cell).map((error) => `${prefix}.${error}`))
    }
  })
  return errors
}

export function validateApprovalFormData(
  formSchema: FormSchema,
  formData: Record<string, unknown>,
  options: ApprovalFormValidationOptions = {},
): string[] {
  const errors: string[] = []
  const visibleFieldIds = getVisibleFormFieldIds(formSchema, formData)

  for (const field of formSchema.fields) {
    if (!visibleFieldIds.has(field.id)) {
      continue
    }
    const value = formData[field.id]
    if (field.required && isEmptyValue(value)) {
      errors.push(`${field.id} is required`)
      continue
    }
    if (field.type === 'detail') {
      errors.push(...validateDetailFieldValue(field, value, options))
      continue
    }
    const typeError = validateFieldType(field, value, options)
    if (typeError) {
      errors.push(typeError)
      continue
    }
    errors.push(...validateFieldConstraints(field, value))
  }

  return errors
}

export class ApprovalGraphExecutor {
  private readonly nodeMap = new Map<string, ApprovalNode>()
  private readonly outgoingEdges = new Map<string, ApprovalEdge[]>()
  private readonly approvalNodeOrder: string[]
  // Lock-3 §1.4 / OD-L3-5(b): handler nodes in graph order, for the SEPARATE handler ordinal used
  // ONLY as `approval_assignments.source_step` — so each handler seat gets a distinct, stable ordinal
  // WITHOUT touching `approvalNodeOrder`, `stepIndexForNode`, or `totalSteps` (all byte-identical).
  private readonly handlerNodeOrder: string[]

  constructor(
    private readonly runtimeGraph: RuntimeGraph,
    private readonly formData: Record<string, unknown>,
    private readonly options: {
      assignmentResolver?: ApprovalGraphAssignmentResolver
      designatedFallbackResolver?: ApprovalGraphAssignmentResolver
      requesterContext?: RequesterFormulaContext | null
    } = {},
  ) {
    for (const node of runtimeGraph.nodes) {
      this.nodeMap.set(node.key, node)
    }
    for (const edge of runtimeGraph.edges) {
      const existing = this.outgoingEdges.get(edge.source) || []
      existing.push(edge)
      this.outgoingEdges.set(edge.source, existing)
    }
    this.approvalNodeOrder = runtimeGraph.nodes
      .filter((node) => node.type === 'approval')
      .map((node) => node.key)
    this.handlerNodeOrder = runtimeGraph.nodes
      .filter((node) => node.type === 'handler')
      .map((node) => node.key)
  }

  get totalSteps(): number {
    return this.approvalNodeOrder.length
  }

  resolveInitialState(): ApprovalGraphResolution {
    const start = this.runtimeGraph.nodes.find((node) => node.type === 'start')
    if (!start) {
      throw new Error('Runtime graph must contain a start node')
    }
    return this.resolveFromNode(start.key, { aggregateMode: null, aggregateComplete: false })
  }

  resolveAfterApprove(currentNodeKey: string): ApprovalGraphResolution {
    // The caller (ApprovalProductService) only reaches `resolveAfterApprove` after aggregation
    // is satisfied for the current node. For 'any' mode that is on the first approver; for 'all'
    // it is after the last approver; 'single' always satisfies on the sole approver. The resolution
    // therefore carries `aggregateComplete: true` along with the current node's approval mode so
    // downstream audit writers can distinguish `'any'` first-wins from `'all'` last-wins.
    const aggregateMode = this.getApprovalMode(currentNodeKey)
    const completionContext = { aggregateMode, aggregateComplete: true as const }
    const next = this.firstTargetForNode(currentNodeKey)
    if (!next) {
      return {
        status: 'approved',
        currentNodeKey: null,
        currentStep: this.totalSteps,
        totalSteps: this.totalSteps,
        assignments: [],
        ccEvents: [],
        autoApprovalEvents: [],
        aggregateMode,
        aggregateComplete: true,
      }
    }
    return this.resolveFromNode(next, completionContext)
  }

  /**
   * Lock-3 §2.2 — advance PAST a handler node once its aggregation (会签 all / 或签 first) is
   * satisfied. A handler completes by SUBMISSION, not approval, and is NOT a counted approval step,
   * so the resolution carries NO aggregate mode (`null`) — the caller writes an `action:'handle'`
   * audit row, never an `approve`. Structurally identical to `resolveAfterApprove`'s advance but keyed
   * on a handler node (whose config `getApprovalNodeConfig` would reject).
   */
  resolveAfterHandle(currentNodeKey: string): ApprovalGraphResolution {
    const next = this.firstTargetForNode(currentNodeKey)
    if (!next) {
      return {
        status: 'approved',
        currentNodeKey: null,
        currentStep: this.totalSteps,
        totalSteps: this.totalSteps,
        assignments: [],
        ccEvents: [],
        autoApprovalEvents: [],
        aggregateMode: null,
        aggregateComplete: true,
      }
    }
    return this.resolveFromNode(next, { aggregateMode: null, aggregateComplete: true })
  }

  /**
   * Advances a single branch inside a parallel-gateway region after one of its
   * approval nodes has finished aggregating (会签 last approver, 或签 first
   * approver, or single-approver completion). Returns either:
   *
   *   - `{ status: 'pending', currentNodeKey: parallelNodeKey, parallelState }`
   *     if the branch moved to another approval node in the same branch OR
   *     reached the join node while siblings remain pending. The route layer
   *     persists the updated `parallelState` into `metadata.parallelBranchStates`.
   *   - A post-join resolution (`resolveFromNode(joinNodeKey)`) once the
   *     join condition is met. `joinMode='all'` waits for every branch;
   *     `joinMode='any'` advances as soon as this branch reaches the join.
   *     In both cases `parallelState` carries the final archived state map.
   */
  resolveAfterApproveInParallel(
    branchNodeKey: string,
    currentState: ParallelInstanceState,
  ): ApprovalGraphResolution {
    const branch = Object.values(currentState.branches).find(
      (entry) => entry.currentNodeKey === branchNodeKey,
    )
    if (!branch) {
      throw new Error(`Parallel branch with current node ${branchNodeKey} not found in state`)
    }
    const aggregateMode = this.getApprovalMode(branchNodeKey)

    // Walk the branch forward one "advance step" — stop either at the next
    // pending approval node (still inside the branch) or at the join node.
    const advance = this.resolveBranchAdvance(branchNodeKey, currentState.joinNodeKey)
    const updatedBranches: Record<string, ParallelBranchState> = { ...currentState.branches }
    const branchEntryKey = Object.keys(currentState.branches).find(
      (key) => currentState.branches[key].currentNodeKey === branchNodeKey,
    )!

    if (advance.kind === 'pending-approval') {
      updatedBranches[branchEntryKey] = {
        edgeKey: branch.edgeKey,
        currentNodeKey: advance.approvalNodeKey,
        complete: false,
      }
      const updatedState: ParallelInstanceState = {
        ...currentState,
        branches: updatedBranches,
      }
      const pendingBranches = Object.values(updatedState.branches).filter((entry) => !entry.complete)
      return {
        status: 'pending',
        currentNodeKey: currentState.parallelNodeKey,
        currentNodeKeys: pendingBranches.map((entry) => entry.currentNodeKey!).filter((key): key is string => Boolean(key)),
        currentStep: this.stepIndexForNode(advance.approvalNodeKey) || this.totalSteps,
        totalSteps: this.totalSteps,
        assignments: advance.assignments,
        ccEvents: advance.ccEvents,
        autoApprovalEvents: advance.autoApprovalEvents,
        aggregateMode,
        aggregateComplete: true,
        parallelState: updatedState,
      }
    }

    // Branch reached the join node. Mark it complete and decide whether the
    // parallel region as a whole can advance.
    updatedBranches[branchEntryKey] = {
      edgeKey: branch.edgeKey,
      currentNodeKey: null,
      complete: true,
    }
    const updatedState: ParallelInstanceState = {
      ...currentState,
      branches: updatedBranches,
    }
    const allComplete = Object.values(updatedState.branches).every((entry) => entry.complete)
    const joinSatisfied = currentState.joinMode === 'any' || allComplete

    if (!joinSatisfied) {
      // Still waiting on siblings; keep the instance pending with fewer active branches.
      const pendingBranches = Object.values(updatedState.branches).filter((entry) => !entry.complete)
      return {
        status: 'pending',
        currentNodeKey: currentState.parallelNodeKey,
        currentNodeKeys: pendingBranches.map((entry) => entry.currentNodeKey!).filter((key): key is string => Boolean(key)),
        currentStep: this.stepIndexForNode(pendingBranches[0]?.currentNodeKey ?? '') || this.totalSteps,
        totalSteps: this.totalSteps,
        assignments: [],
        ccEvents: advance.ccEvents,
        autoApprovalEvents: advance.autoApprovalEvents,
        aggregateMode,
        aggregateComplete: true,
        parallelState: updatedState,
      }
    }

    // Join condition satisfied — advance past the join node. For join-any the
    // route layer cancels sibling branch assignments before inserting the
    // post-join assignments returned here.
    const postJoin = this.resolveFromNode(currentState.joinNodeKey, {
      aggregateMode,
      aggregateComplete: true,
    })
    return {
      ...postJoin,
      ccEvents: [...advance.ccEvents, ...postJoin.ccEvents],
      autoApprovalEvents: [...advance.autoApprovalEvents, ...postJoin.autoApprovalEvents],
      parallelState: updatedState,
    }
  }

  getApprovalMode(nodeKey: string): ApprovalMode {
    return normalizeApprovalMode(this.getApprovalNodeConfig(nodeKey).approvalMode, nodeKey)
  }

  // Lock-3 §2.2 — handler aggregation mode, fail-closed to `'all'` (see `normalizeHandlerMode`).
  getHandlerMode(nodeKey: string): HandlerMode {
    return normalizeHandlerMode(this.getHandlerNodeConfig(nodeKey).handlerMode)
  }

  /**
   * T2-4 N-of-M threshold for a `'threshold'`-mode node: the number of DISTINCT approver
   * identities required to resolve the node APPROVED. Defaults to 1 if absent/invalid — a
   * published threshold graph always carries a publish-validated positive integer, so the
   * fallback only guards against a hand-malformed runtime graph (never resolves on zero).
   */
  getApprovalThreshold(nodeKey: string): number {
    const threshold = this.getApprovalNodeConfig(nodeKey).approvalThreshold
    return typeof threshold === 'number' && Number.isInteger(threshold) && threshold >= 1 ? threshold : 1
  }

  getApprovalNodeAssigneeIds(nodeKey: string): string[] {
    return [...(this.getApprovalNodeConfig(nodeKey).assigneeIds ?? [])]
  }

  resolveReturnToNode(targetNodeKey: string): ApprovalGraphResolution {
    this.getApprovalNodeConfig(targetNodeKey)
    return this.resolveFromNode(targetNodeKey, { aggregateMode: null, aggregateComplete: false })
  }

  listVisitedApprovalNodeKeysUntil(currentNodeKey: string): string[] {
    this.getApprovalNodeConfig(currentNodeKey)

    const start = this.runtimeGraph.nodes.find((node) => node.type === 'start')
    if (!start) {
      throw new Error('Runtime graph must contain a start node')
    }

    const visited = new Set<string>()
    const approvalTrail: string[] = []
    let nextNodeKey: string | null = start.key

    while (nextNodeKey) {
      if (visited.has(nextNodeKey)) {
        throw new Error(`Runtime graph contains a cycle near ${nextNodeKey}`)
      }
      visited.add(nextNodeKey)

      const node = this.nodeMap.get(nextNodeKey)
      if (!node) {
        throw new Error(`Runtime graph references unknown node ${nextNodeKey}`)
      }

      if (node.type === 'start') {
        nextNodeKey = this.firstTargetForNode(node.key)
        continue
      }

      if (node.type === 'condition') {
        nextNodeKey = this.resolveConditionTarget(node)
        continue
      }

      if (node.type === 'cc') {
        nextNodeKey = this.firstTargetForNode(node.key)
        continue
      }

      // Lock-3 R-3: a handler is a NON-approval node — it never joins the return-target trail. WITHOUT
      // this arm an unhandled type leaves `nextNodeKey` unchanged and the next iteration throws
      // `cycle near X` — loud but MISATTRIBUTED (the return would report a phantom cycle). Pass through
      // to the next node exactly as `cc` does; a handler is never itself a legal return target.
      if (node.type === 'handler') {
        nextNodeKey = this.firstTargetForNode(node.key)
        continue
      }

      if (node.type === 'approval') {
        approvalTrail.push(node.key)
        if (node.key === currentNodeKey) {
          return approvalTrail
        }
        nextNodeKey = this.firstTargetForNode(node.key)
        continue
      }

      if (node.type === 'parallel') {
        // Return-to-node inside a parallel region is deferred to a follow-up
        // wave; the caller (dispatch route) rejects `return` when the
        // instance is in parallel state before reaching here. The linear
        // walker skips over the parallel fork and resumes at the join node.
        const parallelConfig = isParallelNodeConfig(node.config) ? node.config : null
        if (!parallelConfig) {
          throw new Error(`Parallel node ${node.key} has invalid config`)
        }
        nextNodeKey = parallelConfig.joinNodeKey
        continue
      }

      if (node.type === 'end') {
        break
      }
    }

    throw new Error(`Approval node ${currentNodeKey} is not reachable from runtime start`)
  }

  buildTransferAssignments(currentNodeKey: string, targetUserId: string): ApprovalGraphAssignment[] {
    // Lock-3 §1.4: a transfer at a HANDLER node carries the disjoint handler ordinal; an approval-node
    // transfer keeps the unchanged approval step index (byte-identical to before this slice).
    const currentStep = this.sourceStepForNode(currentNodeKey)
    return [{
      assignmentType: 'user',
      assigneeId: targetUserId,
      nodeKey: currentNodeKey,
      sourceStep: currentStep,
    }]
  }

  /**
   * P1-B add_sign (加签) — build active co-signer rows at the actor's current
   * approval node. The returned rows are stamped `{ addedBy, addSign: true }`
   * (and deliberately carry NO `resolvedFrom`), so:
   *   - 会签/all-mode completion auto-extends from the LIVE active-assignment
   *     count (no shadow counter; see `ApprovalProductService.dispatchAction`).
   *   - `reduce_sign` can later identify exactly these rows for removal.
   *   - `assertNoActiveAssignmentConflicts` treats them as static (no resolver
   *     fan-out), skipping the dynamic-conflict SELECT — correct, since
   *     targets are explicit user IDs.
   *
   * The metadata shape differs from `ApprovalAssigneeResolutionMetadata`, so the
   * return type is a LOCAL shape (not `ApprovalGraphAssignment`) passed straight
   * to `insertAssignments` (whose `metadata?: unknown` param accepts it). This
   * keeps `ApprovalGraphAssignment.metadata` typed as resolution-only and the
   * `isDynamicallyResolvedAssignment` guard intact.
   */
  buildAddSignAssignments(
    currentNodeKey: string,
    targetUserIds: string[],
    addedBy: string,
  ): Array<{
    assignmentType: 'user'
    assigneeId: string
    nodeKey: string
    sourceStep: number
    metadata: { addedBy: string; addSign: true }
  }> {
    const currentStep = this.stepIndexForNode(currentNodeKey)
    return targetUserIds.map((assigneeId) => ({
      assignmentType: 'user' as const,
      assigneeId,
      nodeKey: currentNodeKey,
      sourceStep: currentStep,
      metadata: { addedBy, addSign: true as const },
    }))
  }

  private resolveFromNode(
    nodeKey: string,
    context: { aggregateMode: ApprovalMode | null; aggregateComplete: boolean },
  ): ApprovalGraphResolution {
    const ccEvents: ApprovalCcEvent[] = []
    const autoApprovalEvents: ApprovalGraphAutoApprovalEvent[] = []
    // Cycle guard: a main-path loop made purely of condition/cc nodes (with no
    // approval/parallel/end node to return at) would otherwise spin this walker
    // forever — hanging the worker thread at instance creation
    // (`resolveInitialState`) or during dispatch while it holds the
    // `approval_instances` row lock. Publish-time validation only checks
    // parallel branches for cycles, so this runtime guard mirrors the other
    // three walkers (`resolveBranchAdvance`, `listVisitedApprovalNodeKeysUntil`)
    // and fails fast instead of looping.
    const visited = new Set<string>()
    let currentKey: string | null = nodeKey

    while (currentKey) {
      if (visited.has(currentKey)) {
        throw new Error(`Runtime graph contains a cycle near ${currentKey}`)
      }
      visited.add(currentKey)

      const node = this.nodeMap.get(currentKey)
      if (!node) {
        throw new Error(`Runtime graph references unknown node ${currentKey}`)
      }

      if (node.type === 'start') {
        currentKey = this.firstTargetForNode(node.key)
        continue
      }

      if (node.type === 'condition') {
        currentKey = this.resolveConditionTarget(node)
        continue
      }

      if (node.type === 'cc') {
        const ccConfig = node.config as unknown as Record<string, unknown>
        const targetIds = ccConfig.targetIds
        const targetType = ccConfig.targetType
        if (!isNonEmptyStringArray(targetIds) || (targetType !== 'user' && targetType !== 'role')) {
          throw new Error(`CC node ${node.key} has invalid config`)
        }
        for (const targetId of targetIds) {
          ccEvents.push({
            nodeKey: node.key,
            targetType,
            targetId,
          })
        }
        currentKey = this.firstTargetForNode(node.key)
        continue
      }

      if (node.type === 'approval') {
        const approvalConfig = isApprovalNodeConfig(node.config) ? node.config : null
        if (!approvalConfig) {
          throw new Error(`Approval node ${node.key} has invalid config`)
        }
        const sourceStep = this.stepIndexForNode(node.key)
        const approvalMode = normalizeApprovalMode(approvalConfig.approvalMode, node.key)
        // Lock-4 F4-A (OD-L4-1(a)) gate A-2 — an `auto_approve` node SKIPS assignee resolution
        // entirely (RATIFIED verbatim: "Assignee resolution is SKIPPED, so an empty source list is
        // legal here and only here") and advances immediately, mirroring the shipped
        // `emptyAssigneePolicy:'auto-approve'` arm immediately below — same push shape, no
        // `metadata`, so `actorIdForAutoApprovalEvent` (ApprovalProductService.ts) falls through to
        // the shipped `system:auto-approval` sentinel and the event carries NO `originalApprover`
        // (RATIFIED: "The event records NO originalApprover"). Placed BEFORE
        // `resolveAssignmentsForApprovalNode` — resolving first would re-trigger the (unrelated)
        // empty-assignee 400 this node is exempt from.
        //
        // ONLY site 1 (`resolveFromNode`, this walker — covers both initial resolution and the
        // after-approve tail-call, see correction C-1 in the design brief) is edited. Site 2
        // (`resolveBranchAdvance`, reached only from inside a `parallel` branch) is deliberately NOT
        // touched: `validateApprovalTypePlacement` (ApprovalProductService.ts) publish-rejects any
        // non-'manual' `approvalType` inside a parallel region (A-1), so that branch path can never
        // carry one — the asymmetry against F4-B's "both sites" requirement is intentional, not an
        // omission.
        if (approvalConfig.approvalType === 'auto_approve') {
          autoApprovalEvents.push({
            nodeKey: node.key,
            sourceStep,
            approvalMode,
            reason: 'auto-node-approve',
          })
          currentKey = this.firstTargetForNode(node.key)
          continue
        }
        const assignments = this.resolveAssignmentsForApprovalNode(node.key, approvalConfig, sourceStep)
        if (assignments.length === 0) {
          // Lock-4 §3 F4-B, gate B-1 (EXECUTOR SITE 1 of 2 — inside `resolveFromNode`, which
          // `resolveAfterApprove` tail-calls, so this arm covers BOTH initial resolution AND
          // after-approve re-entry). See `resolveBranchAdvance` below for site 2 of 2, reachable only
          // through a parallel branch's second node.
          if (approvalConfig.emptyAssigneePolicy === 'designated') {
            const fallbackAssignments = this.resolveDesignatedFallbackAssignments(node.key, approvalConfig, sourceStep)
            if (fallbackAssignments.length > 0) {
              return {
                status: 'pending',
                currentNodeKey: node.key,
                currentStep: sourceStep,
                totalSteps: this.totalSteps,
                assignments: fallbackAssignments,
                ccEvents,
                autoApprovalEvents,
                aggregateMode: context.aggregateMode,
                aggregateComplete: context.aggregateComplete,
              }
            }
            // Gate B-2 (locked): "never chaining to 'auto-approve', never falling back to a manager,
            // never retrying" — an empty designated set falls straight through to the terminal throw.
          } else if (approvalConfig.emptyAssigneePolicy === 'auto-approve') {
            autoApprovalEvents.push({
              nodeKey: node.key,
              sourceStep,
              approvalMode,
              reason: 'empty-assignee',
            })
            currentKey = this.firstTargetForNode(node.key)
            continue
          }
          throw new ServiceError(
            `Approval node ${node.key} has no assignees`,
            400,
            'APPROVAL_ASSIGNEE_EMPTY',
            { nodeKey: node.key },
          )
        }
        return {
          status: 'pending',
          currentNodeKey: node.key,
          currentStep: sourceStep,
          totalSteps: this.totalSteps,
          assignments,
          ccEvents,
          autoApprovalEvents,
          aggregateMode: context.aggregateMode,
          aggregateComplete: context.aggregateComplete,
        }
      }

      // Lock-3 §2.2 R-4: a handler PAUSES the instance exactly as an approval node does — resolve its
      // roster from the FROZEN snapshot (same `assignmentResolver`), insert assignments, wait. It differs
      // in what may then happen (submit-only; §2.2 is in the route dispatch). NO auto-pass arm: a handler
      // carries no empty-assignee/fallback key (§1.2), so an empty RESOLUTION at dispatch is the shipped
      // APPROVAL_ASSIGNEE_EMPTY 400 — never a silent skip of 财务打款/盖章. `source_step` uses the SEPARATE
      // handler ordinal (§1.4 / OD-L3-5b); the display `currentStep` is approval steps completed so far
      // (a handler is not a counted step — `totalSteps` unchanged, G-4).
      if (node.type === 'handler') {
        const handlerConfig = isHandlerNodeConfig(node.config) ? node.config : null
        if (!handlerConfig) {
          throw new Error(`Handler node ${node.key} has invalid config`)
        }
        const sourceStep = this.handlerSourceStepForNode(node.key)
        const assignments = this.resolveAssignmentsForHandlerNode(node.key, handlerConfig, sourceStep)
        if (assignments.length === 0) {
          throw new ServiceError(
            `Handler node ${node.key} has no assignees`,
            400,
            'APPROVAL_ASSIGNEE_EMPTY',
            { nodeKey: node.key },
          )
        }
        return {
          status: 'pending',
          currentNodeKey: node.key,
          currentStep: this.approvalStepsCompletedBefore(node.key),
          totalSteps: this.totalSteps,
          assignments,
          ccEvents,
          autoApprovalEvents,
          aggregateMode: context.aggregateMode,
          aggregateComplete: context.aggregateComplete,
        }
      }

      if (node.type === 'parallel') {
        const parallelConfig = isParallelNodeConfig(node.config) ? node.config : null
        if (!parallelConfig) {
          throw new Error(`Parallel node ${node.key} has invalid config`)
        }

        const branchStates: Record<string, ParallelBranchState> = {}
        const branchAssignments: ApprovalGraphAssignment[] = []
        const branchAdvances: Array<{ edgeKey: string; advance: BranchAdvance }> = []

        for (const edgeKey of parallelConfig.branches) {
          const branchStartNode = this.targetForEdge(edgeKey)
          if (!branchStartNode) {
            throw new Error(`Parallel branch edge ${edgeKey} has no target`)
          }
          const advance = this.resolveBranchAdvance(
            { fromNodeKey: branchStartNode, includeStartNode: true },
            parallelConfig.joinNodeKey,
          )
          branchAdvances.push({ edgeKey, advance })
        }

        const anyAutoCompleteWinner = parallelConfig.joinMode === 'any'
          ? branchAdvances.find((entry) => entry.advance.kind === 'reached-join')
          : undefined
        if (anyAutoCompleteWinner) {
          // A branch with only cc / auto-approval work reached the join
          // immediately. Under join-any that branch wins before sibling
          // approval assignments are created.
          const postJoin = this.resolveFromNode(parallelConfig.joinNodeKey, context)
          return {
            ...postJoin,
            ccEvents: [
              ...ccEvents,
              ...anyAutoCompleteWinner.advance.ccEvents,
              ...postJoin.ccEvents,
            ],
            autoApprovalEvents: [
              ...autoApprovalEvents,
              ...anyAutoCompleteWinner.advance.autoApprovalEvents,
              ...postJoin.autoApprovalEvents,
            ],
          }
        }

        for (const { edgeKey, advance } of branchAdvances) {
          ccEvents.push(...advance.ccEvents)
          autoApprovalEvents.push(...advance.autoApprovalEvents)
          if (advance.kind === 'pending-approval') {
            branchStates[edgeKey] = {
              edgeKey,
              currentNodeKey: advance.approvalNodeKey,
              complete: false,
            }
            branchAssignments.push(...advance.assignments)
          } else {
            branchStates[edgeKey] = {
              edgeKey,
              currentNodeKey: null,
              complete: true,
            }
          }
        }

        const allBranchesAutoComplete = Object.values(branchStates).every((entry) => entry.complete)
        if (allBranchesAutoComplete) {
          // Every branch fast-forwarded through auto-approvals / cc to the join
          // node. Continue walking past the join node directly.
          const postJoin = this.resolveFromNode(parallelConfig.joinNodeKey, context)
          return {
            ...postJoin,
            ccEvents: [...ccEvents, ...postJoin.ccEvents],
            autoApprovalEvents: [...autoApprovalEvents, ...postJoin.autoApprovalEvents],
          }
        }

        const pendingBranches = Object.values(branchStates).filter((entry) => !entry.complete)
        const firstBranchFrontier = pendingBranches[0]?.currentNodeKey ?? parallelConfig.joinNodeKey
        return {
          status: 'pending',
          currentNodeKey: node.key,
          currentNodeKeys: pendingBranches.map((entry) => entry.currentNodeKey!).filter((key): key is string => Boolean(key)),
          currentStep: this.stepIndexForNode(firstBranchFrontier) || this.totalSteps,
          totalSteps: this.totalSteps,
          assignments: branchAssignments,
          ccEvents,
          autoApprovalEvents,
          aggregateMode: context.aggregateMode,
          aggregateComplete: context.aggregateComplete,
          parallelState: {
            parallelNodeKey: node.key,
            joinNodeKey: parallelConfig.joinNodeKey,
            joinMode: parallelConfig.joinMode,
            branches: branchStates,
          },
        }
      }

      if (node.type === 'end') {
        return {
          status: 'approved',
          currentNodeKey: null,
          currentStep: this.totalSteps,
          totalSteps: this.totalSteps,
          assignments: [],
          ccEvents,
          autoApprovalEvents,
          aggregateMode: context.aggregateMode,
          aggregateComplete: context.aggregateComplete,
        }
      }

      throw new Error(`Unsupported node type ${node.type}`)
    }

    return {
      status: 'approved',
      currentNodeKey: null,
      currentStep: this.totalSteps,
      totalSteps: this.totalSteps,
      assignments: [],
      ccEvents,
      autoApprovalEvents,
      aggregateMode: context.aggregateMode,
      aggregateComplete: context.aggregateComplete,
    }
  }

  private resolveConditionTarget(node: ApprovalNode): string | null {
    const config = node.config as unknown as Record<string, unknown>
    const rawBranches = config.branches
    const branches = Array.isArray(rawBranches)
      ? rawBranches.filter(isConditionBranch)
      : []

    for (const branch of branches) {
      // Defense-in-depth for LEGACY stored graphs: a rules-mode branch with ZERO rules must NOT
      // match — `[].every(...)` is vacuously true, which would make the branch capture ALL traffic
      // (first-match-wins) and dead-code the default edge. Authoring + create/update/publish now
      // reject this shape (`validateConditionBranchRules`), so from valid graphs this is
      // unreachable; for a pre-existing stored graph the branch is skipped and routing falls
      // through to later branches / the default edge (the intended "else" mechanism).
      if (!branch.formula && branch.rules.length === 0) continue
      // Legacy stored formulas must not silently change a fail-closed evaluation into a
      // default-route approval. New authoring rejects both shapes; old rows fail closed
      // here so an absent optional field/requester context cannot be treated as no-match.
      if (
        branch.formula
        && (
          !approvalConditionFormulaHasDynamicDependency(branch.formula.expression)
          || approvalConditionFormulaHasCaptureProneIdentity(branch.formula.expression)
        )
      ) {
        throw new ServiceError(
          'Stored condition formula is unsafe for routing',
          409,
          'APPROVAL_CONDITION_FORMULA_CAPTURE_PRONE',
        )
      }
      const result = branch.formula
        ? evaluateApprovalConditionFormula(branch.formula.expression, this.formData, this.options.requesterContext ?? null)
        : (() => {
            const conjunction = branch.conjunction === 'or' ? 'or' : 'and'
            return conjunction === 'or'
              ? branch.rules.some((rule) => evaluateRule(rule, this.formData))
              : branch.rules.every((rule) => evaluateRule(rule, this.formData))
          })()
      if (result) {
        return this.targetForEdge(branch.edgeKey)
      }
    }

    const defaultEdgeKey = config.defaultEdgeKey
    if (typeof defaultEdgeKey === 'string' && defaultEdgeKey.trim()) {
      return this.targetForEdge(defaultEdgeKey)
    }

    return this.firstTargetForNode(node.key)
  }

  private firstTargetForNode(nodeKey: string): string | null {
    const edge = this.outgoingEdges.get(nodeKey)?.[0]
    return edge?.target || null
  }

  /**
   * Walks a single parallel branch until it either hits the next pending
   * approval node (branch still active) or reaches the join node (branch
   * complete for join-all purposes). CC and auto-approval events encountered
   * in between are collected for the caller to persist.
   *
   * The `from` argument has two shapes so both fan-out (from the parallel
   * node into a branch-start via edge traversal) and post-approval advance
   * (from the approver's own branch-local approval node) can share this
   * walker.
   *   - `{ fromNodeKey, includeStartNode: true }`: the walker starts ON
   *     `fromNodeKey` — used by the fan-out path where the edge target is
   *     the branch's first business node.
   *   - `fromNodeKey` as a string (equivalent to `includeStartNode: false`):
   *     the walker starts on the node AFTER `fromNodeKey` — used by the
   *     post-approval advance path where the caller already processed the
   *     branch's current approval.
   */
  private resolveBranchAdvance(
    from: string | { fromNodeKey: string; includeStartNode: boolean },
    joinNodeKey: string,
  ): BranchAdvance {
    const ccEvents: ApprovalCcEvent[] = []
    const autoApprovalEvents: ApprovalGraphAutoApprovalEvent[] = []
    const visited = new Set<string>()

    const startNodeKey = typeof from === 'string' ? from : from.fromNodeKey
    const includeStart = typeof from === 'string' ? false : from.includeStartNode
    let currentKey: string | null = includeStart ? startNodeKey : this.firstTargetForNode(startNodeKey)

    while (currentKey) {
      if (visited.has(currentKey)) {
        throw new Error(`Parallel branch contains a cycle near ${currentKey}`)
      }
      visited.add(currentKey)

      if (currentKey === joinNodeKey) {
        return { kind: 'reached-join', ccEvents, autoApprovalEvents }
      }

      const node = this.nodeMap.get(currentKey)
      if (!node) {
        throw new Error(`Runtime graph references unknown node ${currentKey}`)
      }

      if (node.type === 'condition') {
        currentKey = this.resolveConditionTarget(node)
        continue
      }

      if (node.type === 'cc') {
        const ccConfig = node.config as unknown as Record<string, unknown>
        const targetIds = ccConfig.targetIds
        const targetType = ccConfig.targetType
        if (!isNonEmptyStringArray(targetIds) || (targetType !== 'user' && targetType !== 'role')) {
          throw new Error(`CC node ${node.key} has invalid config`)
        }
        for (const targetId of targetIds) {
          ccEvents.push({
            nodeKey: node.key,
            targetType,
            targetId,
          })
        }
        currentKey = this.firstTargetForNode(node.key)
        continue
      }

      if (node.type === 'approval') {
        const approvalConfig = isApprovalNodeConfig(node.config) ? node.config : null
        if (!approvalConfig) {
          throw new Error(`Approval node ${node.key} has invalid config`)
        }
        const sourceStep = this.stepIndexForNode(node.key)
        const approvalMode = normalizeApprovalMode(approvalConfig.approvalMode, node.key)
        const assignments = this.resolveAssignmentsForApprovalNode(node.key, approvalConfig, sourceStep)
        if (assignments.length === 0) {
          // Lock-4 §3 F4-B, gate B-1 (EXECUTOR SITE 2 of 2 — inside `resolveBranchAdvance`, reachable
          // ONLY through a parallel branch's second node via `resolveAfterApproveInParallel`; NOT
          // reached by `resolveAfterApprove`, which tail-calls `resolveFromNode` = site 1 above). A
          // one-sided edit here without site 1 (or vice versa) is the classic half-wired defect —
          // gate B-3 pins both arms as independently mutation-discriminating.
          if (approvalConfig.emptyAssigneePolicy === 'designated') {
            const fallbackAssignments = this.resolveDesignatedFallbackAssignments(node.key, approvalConfig, sourceStep)
            if (fallbackAssignments.length > 0) {
              return {
                kind: 'pending-approval',
                approvalNodeKey: node.key,
                assignments: fallbackAssignments,
                ccEvents,
                autoApprovalEvents,
              }
            }
            // Gate B-2 (locked): never chains to 'auto-approve', never falls back further — falls
            // straight through to the terminal APPROVAL_ASSIGNEE_EMPTY throw below.
          } else if (approvalConfig.emptyAssigneePolicy === 'auto-approve') {
            autoApprovalEvents.push({
              nodeKey: node.key,
              sourceStep,
              approvalMode,
              reason: 'empty-assignee',
            })
            currentKey = this.firstTargetForNode(node.key)
            continue
          }
          throw new ServiceError(
            `Approval node ${node.key} has no assignees`,
            400,
            'APPROVAL_ASSIGNEE_EMPTY',
            { nodeKey: node.key },
          )
        }
        return {
          kind: 'pending-approval',
          approvalNodeKey: node.key,
          assignments,
          ccEvents,
          autoApprovalEvents,
        }
      }

      if (node.type === 'parallel') {
        throw new Error(`Nested parallel nodes are not supported in v1 (at ${node.key})`)
      }

      // Lock-3 §1.3 R-5 (CONFIRM-EXCLUDE): a handler inside a parallel region is a PUBLISH-time 400
      // (validateHandlerNodePlacement). This throw is the deliberately-RETAINED second door — if a
      // pre-gate stored graph somehow carried one, it fails loudly here rather than colliding at runtime
      // with a sibling branch's assignee (§1.4). Widening handlers into parallel regions is OD-L3-1(b)
      // and must FIRST extend collectAllBranchAssignees + the fingerprint gate, not just delete a check.
      if (node.type === 'handler') {
        throw new Error(`Handler nodes are not supported inside a parallel region in v1 (at ${node.key})`)
      }

      if (node.type === 'end') {
        throw new Error(`Parallel branch terminated at an end node before reaching join ${joinNodeKey}`)
      }

      if (node.type === 'start') {
        throw new Error(`Parallel branch walker unexpectedly hit start node ${node.key}`)
      }

      throw new Error(`Unsupported node type ${node.type}`)
    }

    throw new Error(`Parallel branch starting from ${startNodeKey} did not reach join ${joinNodeKey}`)
  }

  private targetForEdge(edgeKey: string): string | null {
    const edge = this.runtimeGraph.edges.find((entry) => entry.key === edgeKey)
    return edge?.target || null
  }

  private stepIndexForNode(nodeKey: string): number {
    const index = this.approvalNodeOrder.indexOf(nodeKey)
    return index >= 0 ? index + 1 : 0
  }

  /**
   * Lock-3 §1.4 / OD-L3-5(b) — the SEPARATE handler ordinal used ONLY as `approval_assignments.source_step`.
   * `stepIndexForNode` returns `0` for every node absent from `approvalNodeOrder`, so with option (a) all
   * handler seats would collide in one `source_step = 0` bucket (which AttendanceDecisionTrace groups on).
   * Instead each handler node gets a distinct ordinal in a range DISJOINT from approval step indices
   * (`0` and `[1..totalSteps]`): `totalSteps + 1 + handlerIndex`. Stable within a frozen runtime graph.
   * `stepIndexForNode` and `totalSteps` stay byte-identical (G-4). A non-handler key falls back to
   * `totalSteps + 1` (never used in practice — the callers gate on node type).
   */
  private handlerSourceStepForNode(nodeKey: string): number {
    const index = this.handlerNodeOrder.indexOf(nodeKey)
    return this.totalSteps + 1 + (index >= 0 ? index : 0)
  }

  // Lock-3 §1.4 — the source_step an assignment at `nodeKey` carries: the SEPARATE handler ordinal for a
  // handler node, else the unchanged approval step index. Used by `buildTransferAssignments` so a handler
  // transfer seat (§2.2) also lands in the disjoint handler bucket rather than the `source_step = 0` one.
  private sourceStepForNode(nodeKey: string): number {
    return this.nodeMap.get(nodeKey)?.type === 'handler'
      ? this.handlerSourceStepForNode(nodeKey)
      : this.stepIndexForNode(nodeKey)
  }

  // Lock-3 §2.2 — display progress while PAUSED at a handler: how many approval steps are already behind
  // it. A handler is not a counted step, so this stays in `[0..totalSteps]` and never reads as ">M".
  private approvalStepsCompletedBefore(nodeKey: string): number {
    let count = 0
    for (const node of this.runtimeGraph.nodes) {
      if (node.key === nodeKey) break
      if (node.type === 'approval') count += 1
    }
    return count
  }

  private getApprovalNodeConfig(nodeKey: string): ApprovalNodeConfig {
    const node = this.nodeMap.get(nodeKey)
    if (!node || node.type !== 'approval') {
      throw new Error(`Approval node ${nodeKey} is not registered in the runtime graph`)
    }
    const approvalConfig = isApprovalNodeConfig(node.config) ? node.config : null
    if (!approvalConfig) {
      throw new Error(`Approval node ${node.key} has invalid config`)
    }
    return approvalConfig
  }

  // Lock-3 §2.2 R-8 — handler config accessor (the approval accessor throws for a handler key). Used by
  // the route dispatch's `handle` arm to read `handlerMode` / `opinionRequired`.
  getHandlerNodeConfig(nodeKey: string): HandlerNodeConfig {
    const node = this.nodeMap.get(nodeKey)
    if (!node || node.type !== 'handler') {
      throw new Error(`Handler node ${nodeKey} is not registered in the runtime graph`)
    }
    const handlerConfig = isHandlerNodeConfig(node.config) ? node.config : null
    if (!handlerConfig) {
      throw new Error(`Handler node ${node.key} has invalid config`)
    }
    return handlerConfig
  }

  /**
   * Lock-3 §2.2 R-9 — resolve a handler node's seats through the SAME frozen-snapshot
   * `assignmentResolver` the approval nodes use (a PURE function over the create-time snapshot — no live
   * directory read at dispatch). The handler config's `assigneeSources` is the only assignee carrier, so
   * the resolver input shape is identical; threshold reachability is approval-only and never runs here.
   */
  private resolveAssignmentsForHandlerNode(
    nodeKey: string,
    handlerConfig: HandlerNodeConfig,
    sourceStep: number,
  ): ApprovalGraphAssignment[] {
    if (this.options.assignmentResolver) {
      return this.options.assignmentResolver({ nodeKey, sourceStep, config: handlerConfig as unknown as ApprovalNodeConfig })
    }
    // No resolver injected (unit-level executor without the service resolver): a handler carries no
    // legacy assigneeIds pair, so there is nothing to resolve statically — fail closed to empty, which
    // the PAUSE arm turns into APPROVAL_ASSIGNEE_EMPTY.
    return []
  }

  private resolveAssignmentsForApprovalNode(
    nodeKey: string,
    approvalConfig: ApprovalNodeConfig,
    sourceStep: number,
  ): ApprovalGraphAssignment[] {
    const assignments: ApprovalGraphAssignment[] = this.options.assignmentResolver
      ? this.options.assignmentResolver({ nodeKey, sourceStep, config: approvalConfig })
      : (approvalConfig.assigneeIds ?? []).map((assigneeId) => ({
          assignmentType: approvalConfig.assigneeType === 'role' ? 'role' : 'user',
          assigneeId,
          nodeKey,
          sourceStep,
        }))
    this.assertThresholdReachable(nodeKey, approvalConfig, assignments)
    return applySequentialQueueMetadata(assignments, normalizeApprovalMode(approvalConfig.approvalMode, nodeKey))
  }

  /**
   * Lock-4 §3 F4-B (docs/development/approval-lock4-flow-policies-20260817.md, OD-L4-3(a)) — resolves
   * `emptyAssigneePolicy: 'designated'`'s target set. Quoting the lock: "Fallback is exactly ONE
   * non-recursive step (locked)." This method is called ONLY from the two empty-assignee branches
   * below (never recursively, never from itself) — the caller is solely responsible for terminating
   * at `APPROVAL_ASSIGNEE_EMPTY` when this returns `[]`; it must NEVER be chained into another
   * `emptyAssigneePolicy` arm, retried, or substituted with a manager lookup ("转审批管理员 is
   * expressed by designating the admin ... there is NO reverse admin lookup").
   *
   * The designated set is routed through the SAME `assignmentResolver` (→ `resolveApprovalAssignees`)
   * that `static_user`/`static_role` sources already use — built as a synthetic one-off
   * `ApprovalNodeConfig` carrying only `assigneeSources`, never hand-built — so delegation
   * substitution and the `seen` dedup collapse apply identically to a designated fallback as to any
   * other static source.
   *
   * PROVENANCE DISCLOSURE: because of the above, a dispatched fallback assignment's
   * `metadata.resolvedFrom.kind` reads `'static_user'`/`'static_role'` — describing HOW the fallback
   * itself resolved, not that this seat exists because the node's real primary source (which may be
   * an entirely different kind, e.g. `manager_at_level`) came back empty. Checked against both known
   * `resolvedFrom` readers: `ApprovalProductService.isDynamicallyResolvedAssignment` only tests
   * presence (any resolver-produced `resolvedFrom`, any kind, routes through the active-assignment
   * conflict check — correct here too), and `AttendanceDecisionTrace.classifyApproverAssignmentMetadata`
   * special-cases only `direct_manager`/`dept_head`/`manager_at_level`, so a fallback seat falls
   * through to its generic 'static'/'unknown' bucket rather than being mislabeled as one of those
   * three. Net effect: no consumer is misled into naming a mechanism that didn't fire, but the
   * decision trace also cannot yet say "this seat exists because the designated fallback fired" —
   * a real but narrow observability gap, not a correctness defect. Not fixed here (no new metadata
   * shape is in the ratified Lock-4 §3 text); flag if a future consumer needs to distinguish it.
   *
   * GATE B-2: production callers inject a designated-only resolver whose eligibility input is
   * frozen at instance creation and read from internal instance metadata on later activations. It
   * removes user ids that were deactivated and roles that had no active members at that boundary,
   * while the existing resolver still owns delegation, metadata, and deduplication. Ordinary static
   * sources do not use that filter. A unit-level executor without the service injection retains the
   * direct fallback below so this class stays independently testable.
   */
  private resolveDesignatedFallbackAssignments(
    nodeKey: string,
    approvalConfig: ApprovalNodeConfig,
    sourceStep: number,
  ): ApprovalGraphAssignment[] {
    const fallback = approvalConfig.emptyAssigneeFallback
    const userIds = fallback?.userIds ?? []
    const roleIds = fallback?.roleIds ?? []
    if (userIds.length === 0 && roleIds.length === 0) return []
    const fallbackSources: ApprovalAssigneeSource[] = [
      ...(userIds.length > 0 ? [{ kind: 'static_user' as const, userIds }] : []),
      ...(roleIds.length > 0 ? [{ kind: 'static_role' as const, roleIds }] : []),
    ]
    const fallbackResolver = this.options.designatedFallbackResolver ?? this.options.assignmentResolver
    const fallbackAssignments: ApprovalGraphAssignment[] = fallbackResolver
      ? fallbackResolver({ nodeKey, sourceStep, config: { assigneeSources: fallbackSources } })
      // No resolver injected (unit-level executor without the service resolver, mirroring
      // `resolveAssignmentsForApprovalNode`'s own no-resolver branch immediately above): no
      // delegation substitution is available at this layer either way, so build directly.
      : fallbackSources.flatMap((source): ApprovalGraphAssignment[] => {
          if (source.kind === 'static_user') {
            return source.userIds.map((assigneeId) => ({ assignmentType: 'user' as const, assigneeId, nodeKey, sourceStep }))
          }
          if (source.kind === 'static_role') {
            return source.roleIds.map((assigneeId) => ({ assignmentType: 'role' as const, assigneeId, nodeKey, sourceStep }))
          }
          return []
        })
    // T2-4 threshold reachability applies to the FALLBACK set too — `resolveAssignmentsForApprovalNode`
    // (the primary-source path) already runs this check, but this method bypasses that caller
    // entirely, so it must re-run it here on its OWN result. Without this, a threshold node whose
    // DYNAMIC primary source (e.g. `manager_at_level`) resolves empty and falls to a 'designated'
    // fallback smaller than the node's threshold would dispatch a permanently-unreachable node — the
    // exact "3-of-2" failure mode `assertThresholdReachable`'s own doc comment describes. A no-op for
    // site 2 (`resolveBranchAdvance`): threshold mode is publish-time rejected inside a parallel
    // region, so `normalizeApprovalMode(...) !== 'threshold'` always holds there.
    this.assertThresholdReachable(nodeKey, approvalConfig, fallbackAssignments)
    return applySequentialQueueMetadata(
      fallbackAssignments,
      normalizeApprovalMode(approvalConfig.approvalMode, nodeKey),
    )
  }

  /**
   * T2-4 N-of-M (门槛会签) fail-closed reachability check, run at the SAME concrete-assignment
   * point where the empty-assignee policy fails closed (see `resolveAssignmentsForApprovalNode`
   * callers). Publish-time validation only bounds `N <= M` for fully-static USER lists, where the
   * distinct count is author-known; DYNAMIC / ROLE / manager sources resolve M at runtime, so the
   * resolved set is re-checked here.
   *
   * A threshold node resolves APPROVED once N DISTINCT approver identities approve. Each resolved
   * assignment slot is consumed by at most one approval (`deactivateActorAssignmentsAtNode`), so
   * the distinct resolvable slots are an upper bound on the reachable distinct-approver count. If
   * `N > distinct slots` the node could NEVER reach APPROVED: it would exhaust its assignments with
   * the threshold still unmet and silently fall through to the completion path (a 3-of-2). Fail
   * closed at resolution instead. Empty sets are intentionally skipped — the caller's
   * `emptyAssigneePolicy` (auto-approve / reject) owns that case.
   */
  private assertThresholdReachable(
    nodeKey: string,
    approvalConfig: ApprovalNodeConfig,
    assignments: ApprovalGraphAssignment[],
  ): void {
    if (normalizeApprovalMode(approvalConfig.approvalMode, nodeKey) !== 'threshold') return
    if (assignments.length === 0) return
    const threshold = this.getApprovalThreshold(nodeKey)
    const distinctSlots = new Set(
      assignments.map((assignment) => `${assignment.assignmentType}:${assignment.assigneeId}`),
    ).size
    if (threshold > distinctSlots) {
      throw new ServiceError(
        `Approval node ${nodeKey} requires ${threshold} distinct approver(s) but only ${distinctSlots} resolvable approver slot(s) were produced`,
        422,
        'APPROVAL_THRESHOLD_UNREACHABLE',
        { nodeKey, threshold, resolvedApproverCount: distinctSlots },
      )
    }
  }
}
