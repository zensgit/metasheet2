/**
 * S2 (运行内传值) — the per-run value store of the synthetic integration preview.
 *
 * One store per run. It only holds a finite JSON domain projected onto the columns the catalog declares;
 * every published value is deep-frozen. Nothing here persists: there is no snapshot, no resume and no
 * cross-run sharing. A handle is minted by THIS store and recognised only by THIS store (a private
 * WeakMap), so a handle from another run or another tenant, a handle-shaped plain object or a string id
 * cannot resolve. Only a step that the fixed plan declares BEFORE the consumer, and that already
 * succeeded, can be referenced; only allowlisted consumers can read it, and only declared columns.
 *
 * What this store is NOT: it is not the place values get redacted for logs. Raw values never leave the
 * run through it — the host builds every persisted/logged summary from enums and counts
 * (integration/automation-synthetic-preview.ts) and never from what this store holds.
 *
 * `dispose()` drops every value reference and revokes every handle. It does not claim to securely erase
 * JavaScript heap memory.
 */

export type RunValueStoreErrorCode =
  | 'RUN_VALUE_INPUT'
  | 'RUN_VALUE_UNDECLARED'
  | 'RUN_VALUE_DUPLICATE'
  | 'RUN_VALUE_FOREIGN_REF'
  | 'RUN_VALUE_FORWARD_REF'
  | 'RUN_VALUE_CONSUMER_DENIED'
  | 'RUN_VALUE_DISPOSED'

const ownErrors = new WeakSet<object>()
export class RunValueStoreError extends Error {
  readonly code: RunValueStoreErrorCode
  constructor(code: RunValueStoreErrorCode) {
    super(code)
    this.name = 'RunValueStoreError'
    this.code = code
    ownErrors.add(this)
  }
}
export function isRunValueStoreError(error: unknown): error is RunValueStoreError {
  return typeof error === 'object' && error !== null && ownErrors.has(error)
}

export type RunValueScope = Readonly<{ runId: string; tenantId: string }>

/** One declared output of one plan step. */
export type RunValueOutputDeclaration = Readonly<{
  stepId: string
  output: string
  columns: readonly string[]
  consumers: readonly string[]
}>

/** The consumer side of the fixed plan: which step consumes, as which consumer, from which output. */
export type StepInputRef = Readonly<{
  fromStep: string
  output: string
  columns: readonly string[]
}>

export type RunValueRef = Readonly<{ readonly kind: 'run-value-ref' }>

export type RunValueRow = Readonly<Record<string, string | number | boolean | null>>
export type FrozenRunValueRows = readonly RunValueRow[]

export interface RunValueStore {
  /** Publish the output of a successful step. Allowed once per declared output, before dispose. */
  publish(stepId: string, output: string, rows: unknown): RunValueRef
  /** Resolve a store-minted handle for `consumer` running as plan step `consumerStepId`. */
  resolveForConsumer(handle: unknown, ref: StepInputRef, consumer: string, consumerStepId: string, scope: RunValueScope): FrozenRunValueRows
  /** Values-free counts: how many outputs and rows are currently held. */
  counts(): Readonly<{ outputs: number; rows: number }>
  dispose(): void
  readonly disposed: boolean
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_ROWS = 10_000
const MAX_STRING = 1024 * 1024

function fail(code: RunValueStoreErrorCode): never {
  throw new RunValueStoreError(code)
}

function canonicalString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255
}

/** Copy one row onto exactly the declared columns. Every value must be a finite JSON scalar. */
function projectRow(value: unknown, columns: readonly string[]): RunValueRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('RUN_VALUE_INPUT')
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) fail('RUN_VALUE_INPUT')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.length !== columns.length) fail('RUN_VALUE_INPUT')
  const out: Record<string, string | number | boolean | null> = Object.create(null)
  for (const key of keys) {
    if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key) || !columns.includes(key)) fail('RUN_VALUE_INPUT')
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail('RUN_VALUE_INPUT')
    const entry = descriptor.value as unknown
    if (entry === null) out[key] = null
    else if (typeof entry === 'boolean') out[key] = entry
    else if (typeof entry === 'number') {
      if (!Number.isFinite(entry) || Object.is(entry, -0)) fail('RUN_VALUE_INPUT')
      out[key] = entry
    } else if (typeof entry === 'string') {
      if (entry.length > MAX_STRING) fail('RUN_VALUE_INPUT')
      out[key] = entry
    } else fail('RUN_VALUE_INPUT')
  }
  return Object.freeze(out)
}

/**
 * @param scope run id + tenant the store belongs to.
 * @param plan  ordered step ids of the fixed plan and the outputs they declare.
 */
export function createRunValueStore(
  scope: RunValueScope,
  plan: Readonly<{ stepOrder: readonly string[]; outputs: readonly RunValueOutputDeclaration[] }>,
): RunValueStore {
  if (!scope || !canonicalString(scope.runId) || !canonicalString(scope.tenantId)) fail('RUN_VALUE_INPUT')
  const fixedScope = Object.freeze({ runId: scope.runId, tenantId: scope.tenantId })
  const stepOrder = Object.freeze([...plan.stepOrder])
  const declarations = new Map<string, RunValueOutputDeclaration>()
  for (const declaration of plan.outputs) {
    declarations.set(`${declaration.stepId}\u0000${declaration.output}`, Object.freeze({
      stepId: declaration.stepId,
      output: declaration.output,
      columns: Object.freeze([...declaration.columns]),
      consumers: Object.freeze([...declaration.consumers]),
    }))
  }
  // Handle -> slot. Only handles minted here are keys; nothing else can be looked up.
  const handles = new WeakMap<object, { key: string; runId: string; tenantId: string }>()
  const values = new Map<string, FrozenRunValueRows>()
  let disposed = false

  const store: RunValueStore = {
    publish(stepId, output, rows) {
      if (disposed) fail('RUN_VALUE_DISPOSED')
      const key = `${stepId}\u0000${output}`
      const declaration = declarations.get(key)
      if (!declaration) fail('RUN_VALUE_UNDECLARED')
      if (values.has(key)) fail('RUN_VALUE_DUPLICATE')
      if (!Array.isArray(rows) || rows.length > MAX_ROWS || Object.getPrototypeOf(rows) !== Array.prototype) fail('RUN_VALUE_INPUT')
      const frozen = Object.freeze(rows.map((row) => projectRow(row, declaration.columns)))
      values.set(key, frozen)
      const handle: RunValueRef = Object.freeze(Object.create(null, { kind: { value: 'run-value-ref', enumerable: true } }))
      handles.set(handle, { key, runId: fixedScope.runId, tenantId: fixedScope.tenantId })
      return handle
    },

    resolveForConsumer(handle, ref, consumer, consumerStepId, requestScope) {
      if (disposed) fail('RUN_VALUE_DISPOSED')
      const slot = handle && typeof handle === 'object' ? handles.get(handle) : undefined
      // A handle from another store (another run / tenant), a forged object or a string id.
      if (!slot) fail('RUN_VALUE_FOREIGN_REF')
      if (!requestScope || slot.runId !== requestScope.runId || slot.tenantId !== requestScope.tenantId
        || requestScope.runId !== fixedScope.runId || requestScope.tenantId !== fixedScope.tenantId) {
        fail('RUN_VALUE_FOREIGN_REF')
      }
      if (!ref || typeof ref !== 'object') fail('RUN_VALUE_INPUT')
      const key = `${ref.fromStep}\u0000${ref.output}`
      if (slot.key !== key) fail('RUN_VALUE_FOREIGN_REF')
      const declaration = declarations.get(key)
      if (!declaration) fail('RUN_VALUE_UNDECLARED')
      // Only an EARLIER step of the fixed plan can be referenced.
      const producerIndex = stepOrder.indexOf(ref.fromStep)
      const consumerIndex = stepOrder.indexOf(consumerStepId)
      if (producerIndex < 0 || consumerIndex < 0 || producerIndex >= consumerIndex) fail('RUN_VALUE_FORWARD_REF')
      if (!declaration.consumers.includes(consumer)) fail('RUN_VALUE_CONSUMER_DENIED')
      if (!Array.isArray(ref.columns) || ref.columns.length === 0) fail('RUN_VALUE_INPUT')
      for (const column of ref.columns) {
        if (typeof column !== 'string' || FORBIDDEN_KEYS.has(column) || !declaration.columns.includes(column)) fail('RUN_VALUE_UNDECLARED')
      }
      const rows = values.get(key)
      // Declared but not (yet) published: the producing step has not succeeded.
      if (!rows) fail('RUN_VALUE_FORWARD_REF')
      const columns = [...ref.columns]
      return Object.freeze(rows.map((row) => {
        const projected: Record<string, string | number | boolean | null> = {}
        for (const column of columns) projected[column] = row[column]
        return Object.freeze(projected)
      }))
    },

    counts() {
      let rowCount = 0
      for (const rows of values.values()) rowCount += rows.length
      return Object.freeze({ outputs: values.size, rows: rowCount })
    },

    dispose() {
      disposed = true
      values.clear()
    },

    get disposed() {
      return disposed
    },
  }
  return Object.freeze(store)
}
