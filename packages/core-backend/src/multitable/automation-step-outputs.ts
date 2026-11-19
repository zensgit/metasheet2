/**
 * iPaaS S-line S2-a — step outputs as a LIBRARY (ADR adr-ipaas-steps-s1-s4-20261116 §5.1–§5.3, §5.6, §4.8).
 *
 * Nothing in src imports this module yet: the executor wiring, the save gate, any switch read and every
 * persisted surface belong to later slices (S3-a1 / S3-a2). What is here:
 *
 *  1. `deriveStepOutputPlan` — validates an already-parsed rule-step description (top-level order, type,
 *     optional `stepKey`, stamped `output.columns`, references to earlier outputs) and derives the plan:
 *     producers in top-level order, their declared columns, and each producer's consumer allowlist = the
 *     steps of the static reference graph that reference it. Second layer behind the save-time 400.
 *  2. `createRunValueStoreFromRule` — an ADDED construction path for the per-run value store. It builds a
 *     store with `createRunValueStore` (automation-run-values.ts) from the derived plan and adds the §5.6
 *     caps on top. Every guarantee of that store is kept because every value goes through it: finite JSON
 *     scalars on the declared columns only, publish once, deep-frozen, store-private handles, only an
 *     earlier and successful step can be referenced, only allowlisted consumers read, `dispose()` revokes.
 *     The synthetic slice's fixed plan and its construction path are not touched.
 *  3. `parseStepOutputReference` — the strict, newly written resolver grammar (does NOT reuse
 *     `lookupTemplateValue`): whole-value `{{steps.<key>.output.count}}` / `{{steps.<key>.output.first.<col>}}`
 *     only. The `row.` root is S4-d's and is refused here as a syntax error.
 *  4. `requireBusinessKey` / `isUsableBusinessKey` — the bound for a resolved scalar used as a business key.
 *  5. `runWithStepOutputs` — the execution-scoped registry (a module-private table keyed by execution id).
 *     The store is never an enumerable member of any context object; it is disposed in `finally`.
 *  6. `buildStepOutput` — the closed `step.output` contract, built only from enums and counts.
 *
 * Errors are `RunValueStoreError` with the code as the whole message: no reference text, no value.
 * "No truncation" is the single rule: over a cap the publish fails and nothing is stored.
 */
import {
  createRunValueStore,
  projectRow,
  RunValueStoreError,
  type FrozenRunValueRows,
  type RunValueRef,
  type RunValueScope,
  type RunValueStoreErrorCode,
} from './automation-run-values'

// ── Caps (ADR §5.6, T-layer defaults; every one has a "remove it and it goes red" test) ───────────────
/** Rows in one published step output (core's own count; the store's hard limit of 10 000 stays). */
export const STEP_OUTPUT_MAX_ROWS = 100
/** UTF-8 bytes of one output's canonical JSON (rows in declared column order). */
export const STEP_OUTPUT_MAX_BYTES = 1024 * 1024
/** UTF-8 bytes of all outputs published in one execution. */
export const EXECUTION_STEP_OUTPUTS_MAX_BYTES = 4 * 1024 * 1024
/** Steps carrying a `stepKey` in one rule. */
export const STEP_KEY_MAX_PER_RULE = 8
/** Characters of a business key after trimming (mirrors the configured-read key bound). */
export const STEP_BUSINESS_KEY_MAX_LENGTH = 128

/** Only these action types may carry a `stepKey` / produce a referable output (ADR §5.1). */
export const STEP_OUTPUT_PRODUCER_TYPES = Object.freeze(['call_connection', 'transform_records'] as const)

const STEP_KEY_SHAPE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/
const COLUMN_SHAPE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const ACTION_TYPE_SHAPE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const RESERVED_NAMES: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor'])
/** reference := 'steps.' stepKey '.output.' ( 'count' | 'first.' column ), whole value, no whitespace. */
const REFERENCE_SHAPE = /^\{\{steps\.([A-Za-z][A-Za-z0-9_]{0,31})\.output\.(?:(count)|first\.([A-Za-z_][A-Za-z0-9_]{0,63}))\}\}$/
const REFERENCE_MAX_LENGTH = 128
const OUTPUT_NAME = 'output'

function fail(code: RunValueStoreErrorCode): never {
  throw new RunValueStoreError(code)
}

function isStepKey(value: unknown): value is string {
  return typeof value === 'string' && STEP_KEY_SHAPE.test(value) && !RESERVED_NAMES.has(value)
}

function isColumnName(value: unknown): value is string {
  return typeof value === 'string' && COLUMN_SHAPE.test(value) && !RESERVED_NAMES.has(value)
}

/** Own enumerable DATA properties of a plain object, restricted to `allowed`; null when anything else. */
function plainRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return null
  const out: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) return null
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null
    out[key] = descriptor.value
  }
  return out
}

/** Elements of a dense, plain array read as data descriptors; null when anything else. */
function plainArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null
  const out: unknown[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null
    out.push(descriptor.value)
  }
  return out
}

function has(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

// ── Reference grammar ─────────────────────────────────────────────────────────────────────────────────
export type StepOutputReference = Readonly<
  | { stepKey: string; selector: 'count' }
  | { stepKey: string; selector: 'first'; column: string }
>

/** The structured row-set reference (same shape family as the synthetic slice's StepInputRef). */
export type StepRowSetReference = Readonly<{ fromStep: string }>

/** Parse one whole-value binding. Anything else — including the `row.` root — is RUN_VALUE_REF_SYNTAX. */
export function parseStepOutputReference(text: unknown): StepOutputReference {
  if (typeof text !== 'string' || text.length > REFERENCE_MAX_LENGTH) fail('RUN_VALUE_REF_SYNTAX')
  const match = REFERENCE_SHAPE.exec(text)
  if (!match) fail('RUN_VALUE_REF_SYNTAX')
  const stepKey = match[1]
  if (RESERVED_NAMES.has(stepKey)) fail('RUN_VALUE_REF_SYNTAX')
  if (match[2] === 'count') return Object.freeze({ stepKey, selector: 'count' as const })
  const column = match[3]
  if (RESERVED_NAMES.has(column)) fail('RUN_VALUE_REF_SYNTAX')
  return Object.freeze({ stepKey, selector: 'first' as const, column })
}

function parseRowSetReference(value: unknown): StepRowSetReference {
  const record = plainRecord(value, ['fromStep'])
  if (!record || !has(record, 'fromStep') || !isStepKey(record.fromStep)) fail('RUN_VALUE_REF_SYNTAX')
  return Object.freeze({ fromStep: record.fromStep })
}

// ── Plan derivation ───────────────────────────────────────────────────────────────────────────────────
/** One top-level step of an already-parsed rule, as the save gate hands it over. */
export type StepOutputRuleStep = Readonly<{
  type: string
  stepKey?: string
  output?: Readonly<{ columns: readonly string[] }>
  /** Whole-value scalar bindings this step makes (e.g. `call_connection.inputs.key`). */
  scalarRefs?: readonly string[]
  /** Structured row-set references this step makes (e.g. `transform_records.source`). */
  rowRefs?: readonly StepRowSetReference[]
}>
export type StepOutputRuleDescription = Readonly<{ steps: readonly StepOutputRuleStep[] }>

export type StepOutputProducer = Readonly<{
  stepKey: string
  /** Top-level position of the producing step. */
  position: number
  columns: readonly string[]
  /** Top-level positions of the steps that reference this output (the consumer allowlist). */
  consumers: readonly number[]
}>
export type StepOutputPlan = Readonly<{ stepCount: number; producers: readonly StepOutputProducer[] }>

const STEP_DESCRIPTION_KEYS = Object.freeze(['type', 'stepKey', 'output', 'scalarRefs', 'rowRefs'])
const derivedPlans = new WeakSet<object>()

function parseColumns(value: unknown): readonly string[] {
  const output = plainRecord(value, ['columns'])
  if (!output || !has(output, 'columns')) fail('RUN_VALUE_COLUMN_INVALID')
  const columns = plainArray(output.columns)
  if (!columns || columns.length === 0) fail('RUN_VALUE_COLUMN_INVALID')
  const seen = new Set<string>()
  for (const column of columns) {
    if (!isColumnName(column) || seen.has(column)) fail('RUN_VALUE_COLUMN_INVALID')
    seen.add(column)
  }
  return Object.freeze([...seen])
}

export function deriveStepOutputPlan(rule: StepOutputRuleDescription): StepOutputPlan {
  const top = plainRecord(rule, ['steps'])
  if (!top || !has(top, 'steps')) fail('RUN_VALUE_INPUT')
  const steps = plainArray(top.steps)
  if (!steps) fail('RUN_VALUE_INPUT')

  type Parsed = { position: number; stepKey: string | null; columns: readonly string[] | null; scalarRefs: unknown; rowRefs: unknown }
  const parsed: Parsed[] = steps.map((raw, position) => {
    const step = plainRecord(raw, STEP_DESCRIPTION_KEYS)
    if (!step || typeof step.type !== 'string' || !ACTION_TYPE_SHAPE.test(step.type)) fail('RUN_VALUE_INPUT')
    const producerType = (STEP_OUTPUT_PRODUCER_TYPES as readonly string[]).includes(step.type)
    let stepKey: string | null = null
    if (has(step, 'stepKey')) {
      if (!producerType || !isStepKey(step.stepKey)) fail('RUN_VALUE_STEP_KEY_INVALID')
      stepKey = step.stepKey
    }
    let columns: readonly string[] | null = null
    if (has(step, 'output')) {
      if (!producerType) fail('RUN_VALUE_INPUT')
      columns = parseColumns(step.output)
    }
    if (stepKey !== null && columns === null) fail('RUN_VALUE_COLUMN_INVALID')
    return { position, stepKey, columns, scalarRefs: step.scalarRefs, rowRefs: step.rowRefs }
  })

  const keyed = parsed.filter((step) => step.stepKey !== null)
  if (keyed.length > STEP_KEY_MAX_PER_RULE) fail('RUN_VALUE_PLAN_TOO_LARGE')
  const byKey = new Map<string, { position: number; columns: readonly string[]; consumers: Set<number> }>()
  for (const step of keyed) {
    if (byKey.has(step.stepKey as string)) fail('RUN_VALUE_STEP_KEY_DUPLICATE')
    byKey.set(step.stepKey as string, { position: step.position, columns: step.columns as readonly string[], consumers: new Set() })
  }

  const link = (consumer: number, stepKey: string, column: string | null) => {
    const producer = byKey.get(stepKey)
    if (!producer) fail('RUN_VALUE_REF_UNKNOWN')
    if (producer.position === consumer) fail('RUN_VALUE_REF_SELF')
    if (producer.position > consumer) fail('RUN_VALUE_FORWARD_REF')
    if (column !== null && !producer.columns.includes(column)) fail('RUN_VALUE_REF_UNKNOWN')
    producer.consumers.add(consumer)
  }
  for (const step of parsed) {
    if (step.scalarRefs !== undefined) {
      const refs = plainArray(step.scalarRefs)
      if (!refs) fail('RUN_VALUE_INPUT')
      for (const text of refs) {
        const ref = parseStepOutputReference(text)
        link(step.position, ref.stepKey, ref.selector === 'first' ? ref.column : null)
      }
    }
    if (step.rowRefs !== undefined) {
      const refs = plainArray(step.rowRefs)
      if (!refs) fail('RUN_VALUE_INPUT')
      for (const raw of refs) link(step.position, parseRowSetReference(raw).fromStep, null)
    }
  }

  const producers = keyed.map((step) => {
    const entry = byKey.get(step.stepKey as string)!
    return Object.freeze({
      stepKey: step.stepKey as string,
      position: step.position,
      columns: entry.columns,
      consumers: Object.freeze([...entry.consumers].sort((a, b) => a - b)),
    })
  })
  const plan: StepOutputPlan = Object.freeze({ stepCount: parsed.length, producers: Object.freeze(producers) })
  derivedPlans.add(plan)
  return plan
}

// ── The rule-derived store ────────────────────────────────────────────────────────────────────────────
export type RunValueScalar = string | number | boolean | null

export interface RuleRunValueStore {
  /** Publish a successful producer's rows. Over a §5.6 cap: RUN_VALUE_OUTPUT_TOO_LARGE, nothing stored. */
  publish(stepKey: string, rows: unknown): RunValueRef
  /** Resolve a whole-value scalar reference for the step at top-level position `consumerPosition`. */
  resolveScalar(handle: unknown, reference: unknown, consumerPosition: number, scope: RunValueScope): RunValueScalar
  /** Resolve a `{ fromStep }` row-set reference: all declared columns, deep-frozen. */
  resolveRows(handle: unknown, reference: unknown, consumerPosition: number, scope: RunValueScope): FrozenRunValueRows
  /** Values-free counts. */
  counts(): Readonly<{ outputs: number; rows: number; bytes: number }>
  dispose(): void
  readonly disposed: boolean
}

/** Positional ids can never collide with a stepKey (a stepKey must start with a letter). */
function positionId(position: number): string {
  return `#${position}`
}

export function createRunValueStoreFromRule(scope: RunValueScope, plan: StepOutputPlan): RuleRunValueStore {
  if (!plan || typeof plan !== 'object' || !derivedPlans.has(plan)) fail('RUN_VALUE_INPUT')
  const stepCount = plan.stepCount
  const producers = new Map<string, StepOutputProducer>()
  for (const producer of plan.producers) producers.set(producer.stepKey, producer)
  const inner = createRunValueStore(scope, {
    stepOrder: Array.from({ length: stepCount }, (_, position) => positionId(position)),
    outputs: plan.producers.map((producer) => ({
      stepId: positionId(producer.position),
      output: OUTPUT_NAME,
      columns: producer.columns,
      consumers: producer.consumers.map(positionId),
    })),
  })
  let totalBytes = 0

  const consumerId = (position: unknown): string => {
    if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 0 || position >= stepCount) fail('RUN_VALUE_INPUT')
    return positionId(position)
  }
  const producerFor = (stepKey: string, consumerPosition: number): StepOutputProducer => {
    const producer = producers.get(stepKey)
    if (!producer) fail('RUN_VALUE_REF_UNKNOWN')
    if (producer.position === consumerPosition) fail('RUN_VALUE_REF_SELF')
    return producer
  }

  const store: RuleRunValueStore = {
    publish(stepKey, rows) {
      if (inner.disposed) fail('RUN_VALUE_DISPOSED')
      const producer = typeof stepKey === 'string' ? producers.get(stepKey) : undefined
      if (!producer) fail('RUN_VALUE_UNDECLARED')
      const list = plainArray(rows)
      if (!list) fail('RUN_VALUE_INPUT')
      if (list.length > STEP_OUTPUT_MAX_ROWS) fail('RUN_VALUE_OUTPUT_TOO_LARGE')
      // Canonical copy: projected by the store's own rule, keys in declared column order.
      const canonical = list.map((row) => {
        const projected = projectRow(row, producer.columns)
        const ordered: Record<string, RunValueScalar> = Object.create(null)
        for (const column of producer.columns) ordered[column] = projected[column]
        return ordered
      })
      const bytes = Buffer.byteLength(JSON.stringify(canonical), 'utf8')
      if (bytes > STEP_OUTPUT_MAX_BYTES) fail('RUN_VALUE_OUTPUT_TOO_LARGE')
      if (totalBytes + bytes > EXECUTION_STEP_OUTPUTS_MAX_BYTES) fail('RUN_VALUE_OUTPUT_TOO_LARGE')
      const handle = inner.publish(positionId(producer.position), OUTPUT_NAME, canonical)
      totalBytes += bytes
      return handle
    },

    resolveScalar(handle, reference, consumerPosition, requestScope) {
      if (inner.disposed) fail('RUN_VALUE_DISPOSED')
      const ref = parseStepOutputReference(reference)
      const consumer = consumerId(consumerPosition)
      const producer = producerFor(ref.stepKey, consumerPosition)
      const rows = inner.resolveForConsumer(handle, {
        fromStep: positionId(producer.position),
        output: OUTPUT_NAME,
        columns: ref.selector === 'count' ? producer.columns : [ref.column],
      }, consumer, consumer, requestScope)
      if (ref.selector === 'count') return rows.length
      if (rows.length !== 1) fail('RUN_VALUE_FIRST_NOT_SINGLE')
      const row = rows[0]
      if (!Object.prototype.hasOwnProperty.call(row, ref.column)) fail('RUN_VALUE_UNDECLARED')
      return row[ref.column]
    },

    resolveRows(handle, reference, consumerPosition, requestScope) {
      if (inner.disposed) fail('RUN_VALUE_DISPOSED')
      const ref = parseRowSetReference(reference)
      const consumer = consumerId(consumerPosition)
      const producer = producerFor(ref.fromStep, consumerPosition)
      return inner.resolveForConsumer(handle, {
        fromStep: positionId(producer.position),
        output: OUTPUT_NAME,
        columns: producer.columns,
      }, consumer, consumer, requestScope)
    },

    counts() {
      const { outputs, rows } = inner.counts()
      return Object.freeze({ outputs, rows, bytes: inner.disposed ? 0 : totalBytes })
    },

    dispose() {
      inner.dispose()
      totalBytes = 0
    },

    get disposed() {
      return inner.disposed
    },
  }
  return Object.freeze(store)
}

// ── Business key (ADR §5.6; mirrors the configured-read key bound) ────────────────────────────────────
/** A string (trimmed: 1..128 chars, no control characters) or a finite number. null/boolean/'' are not. */
export function isUsableBusinessKey(value: unknown): value is string | number {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'string') return false
  const raw = value.trim()
  if (raw.length === 0 || raw.length > STEP_BUSINESS_KEY_MAX_LENGTH) return false
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

/** The value unchanged (original type) when usable; RUN_VALUE_KEY_UNUSABLE otherwise. */
export function requireBusinessKey(value: unknown): string | number {
  if (!isUsableBusinessKey(value)) fail('RUN_VALUE_KEY_UNUSABLE')
  return value
}

// ── Execution-scoped registry (module-private; never an enumerable member of a context object) ────────
const executions = new Map<string, Readonly<{ tenantId: string; store: RuleRunValueStore }>>()

/**
 * One store per execution: created and registered on entry, disposed and unregistered in `finally` —
 * on success, on a returned failure and on a throw alike. A second open of a live execution id is refused.
 */
export async function runWithStepOutputs<T>(
  scope: RunValueScope,
  plan: StepOutputPlan,
  fn: (store: RuleRunValueStore) => T | Promise<T>,
): Promise<T> {
  const store = createRunValueStoreFromRule(scope, plan)
  const runId = scope.runId
  const tenantId = scope.tenantId
  if (executions.has(runId)) {
    store.dispose()
    fail('RUN_VALUE_INPUT')
  }
  executions.set(runId, Object.freeze({ tenantId, store }))
  try {
    return await fn(store)
  } finally {
    store.dispose()
    if (executions.get(runId)?.store === store) executions.delete(runId)
  }
}

/** The live store of an execution, only for the same execution id AND tenant; undefined otherwise. */
export function stepOutputsForExecution(scope: RunValueScope): RuleRunValueStore | undefined {
  if (!scope || typeof scope.runId !== 'string' || typeof scope.tenantId !== 'string') return undefined
  const entry = executions.get(scope.runId)
  return entry && entry.tenantId === scope.tenantId ? entry.store : undefined
}

/** Values-free: how many executions currently hold a store. */
export function activeStepOutputExecutionCount(): number {
  return executions.size
}

// ── step.output (ADR §4.8 v5): closed key set, closed outcome / reason, built from enums and counts ───
export const STEP_OUTPUT_OUTCOMES = Object.freeze(['completed', 'skipped', 'not_started', 'failed'] as const)
export type StepOutputOutcome = (typeof STEP_OUTPUT_OUTCOMES)[number]

/** Every reason of the §4.8 table and the outcome it implies. `parity_violation` was removed in v5. */
export const STEP_OUTPUT_REASON_OUTCOME = Object.freeze({
  ok: 'completed',
  action_disabled: 'skipped',
  rule_sheet_unregistered: 'skipped',
  principal_unauthorized: 'skipped',
  operation_not_found: 'skipped',
  operation_not_approved: 'skipped',
  operation_changed: 'skipped',
  kind_not_admitted: 'skipped',
  mode_not_admitted: 'skipped',
  columns_not_admitted: 'skipped',
  system_unavailable: 'skipped',
  system_overrides_request: 'skipped',
  read_authorization_required: 'skipped',
  write_gate_refused: 'skipped',
  adapter_refused: 'skipped',
  busy: 'skipped',
  config_invalid: 'not_started',
  port_inactive: 'not_started',
  authority_unavailable: 'not_started',
  input_unresolved: 'not_started',
  row_unavailable: 'not_started',
  timeout: 'failed',
  shutdown: 'failed',
  redirect_refused: 'failed',
  origin_refused: 'failed',
  request_not_allowed: 'failed',
  source_error: 'failed',
  row_cap_reached: 'failed',
  source_incomplete: 'failed',
  output_not_scalar: 'failed',
  output_too_large: 'failed',
  transform_failed: 'failed',
  yida_plan_rejected: 'failed',
  draft_refused: 'failed',
} as const satisfies Record<string, StepOutputOutcome>)
export type StepOutputReason = keyof typeof STEP_OUTPUT_REASON_OUTCOME

/** `operation.kind` closed set of ADR §4.1. */
export const STEP_OUTPUT_OPERATION_KINDS = Object.freeze(['read_source_config', 'write_target_config'] as const)
export type StepOutputOperationKind = (typeof STEP_OUTPUT_OPERATION_KINDS)[number]

export type StepOutput = Readonly<{
  outcome: StepOutputOutcome
  reason: StepOutputReason
  operation: Readonly<{ kind: StepOutputOperationKind; configId: string }>
  counts: Readonly<{ rows: number; columns: number; bytes: number }>
  capReached: boolean
  complete: boolean
  durationMs: number
  /** A code already clamped into a closed set by the evidence side; never a raw adapter code or text. */
  errorClass?: string
}>

/**
 * Which reason S3-a2 maps each store / resolver code to (type only; S2-a does no mapping at runtime).
 * The constraint makes tsc refuse a reason outside the §4.8 table.
 */
type ReasonMap<T extends Partial<Record<RunValueStoreErrorCode, StepOutputReason>>> = T
export type RunValueErrorReasonMap = ReasonMap<{
  RUN_VALUE_FIRST_NOT_SINGLE: 'input_unresolved'
  RUN_VALUE_KEY_UNUSABLE: 'input_unresolved'
  // Runtime reference failures.
  RUN_VALUE_REF_SYNTAX: 'input_unresolved'
  RUN_VALUE_REF_UNKNOWN: 'input_unresolved'
  RUN_VALUE_REF_SELF: 'input_unresolved'
  RUN_VALUE_FORWARD_REF: 'input_unresolved'
  RUN_VALUE_FOREIGN_REF: 'input_unresolved'
  RUN_VALUE_UNDECLARED: 'input_unresolved'
  RUN_VALUE_CONSUMER_DENIED: 'input_unresolved'
  RUN_VALUE_DISPOSED: 'input_unresolved'
  // Publication.
  RUN_VALUE_INPUT: 'output_not_scalar'
  RUN_VALUE_OUTPUT_TOO_LARGE: 'output_too_large'
}>

const STEP_OUTPUT_KEYS = Object.freeze(['outcome', 'reason', 'operation', 'counts', 'capReached', 'complete', 'durationMs', 'errorClass'])
const STEP_OUTPUT_REQUIRED = Object.freeze(['outcome', 'reason', 'operation', 'counts', 'capReached', 'complete', 'durationMs'])
const CONFIG_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const ERROR_CLASS_SHAPE = /^[A-Z][A-Z0-9_]{0,63}$/

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export type StepOutputInput = Readonly<{
  outcome: StepOutputOutcome
  reason: StepOutputReason
  operation: Readonly<{ kind: StepOutputOperationKind; configId: string }>
  counts: Readonly<{ rows: number; columns: number; bytes: number }>
  capReached: boolean
  complete: boolean
  durationMs: number
  errorClass?: string
}>

/**
 * The only constructor of `step.output`. Every field is named, checked and copied; one extra key anywhere
 * is refused, so a raw result spread into the argument cannot pass. Refusals are RUN_VALUE_INPUT.
 */
export function buildStepOutput(input: StepOutputInput): StepOutput {
  const top = plainRecord(input, STEP_OUTPUT_KEYS)
  if (!top || !STEP_OUTPUT_REQUIRED.every((key) => has(top, key))) fail('RUN_VALUE_INPUT')
  const reason = top.reason
  if (typeof reason !== 'string' || !Object.prototype.hasOwnProperty.call(STEP_OUTPUT_REASON_OUTCOME, reason)) fail('RUN_VALUE_INPUT')
  const outcome = top.outcome
  if (typeof outcome !== 'string' || !(STEP_OUTPUT_OUTCOMES as readonly string[]).includes(outcome)) fail('RUN_VALUE_INPUT')
  if (STEP_OUTPUT_REASON_OUTCOME[reason as StepOutputReason] !== outcome) fail('RUN_VALUE_INPUT')

  const operation = plainRecord(top.operation, ['kind', 'configId'])
  if (!operation || !has(operation, 'kind') || !has(operation, 'configId')) fail('RUN_VALUE_INPUT')
  if (typeof operation.kind !== 'string' || !(STEP_OUTPUT_OPERATION_KINDS as readonly string[]).includes(operation.kind)) fail('RUN_VALUE_INPUT')
  if (typeof operation.configId !== 'string' || !CONFIG_ID_SHAPE.test(operation.configId)) fail('RUN_VALUE_INPUT')

  const counts = plainRecord(top.counts, ['rows', 'columns', 'bytes'])
  if (!counts || !isCount(counts.rows) || !isCount(counts.columns) || !isCount(counts.bytes)) fail('RUN_VALUE_INPUT')
  if (typeof top.capReached !== 'boolean' || typeof top.complete !== 'boolean' || !isCount(top.durationMs)) fail('RUN_VALUE_INPUT')

  const built: {
    -readonly [K in keyof StepOutput]: StepOutput[K]
  } = {
    outcome: outcome as StepOutputOutcome,
    reason: reason as StepOutputReason,
    operation: Object.freeze({ kind: operation.kind as StepOutputOperationKind, configId: operation.configId }),
    counts: Object.freeze({ rows: counts.rows, columns: counts.columns, bytes: counts.bytes }),
    capReached: top.capReached,
    complete: top.complete,
    durationMs: top.durationMs,
  }
  if (has(top, 'errorClass')) {
    if (outcome === 'completed' || typeof top.errorClass !== 'string' || !ERROR_CLASS_SHAPE.test(top.errorClass)) fail('RUN_VALUE_INPUT')
    built.errorClass = top.errorClass
  }
  return Object.freeze(built)
}
