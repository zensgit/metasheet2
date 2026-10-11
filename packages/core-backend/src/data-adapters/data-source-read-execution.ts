import { AsyncLocalStorage } from 'node:async_hooks'

export type DataSourceReadIOKind = 'connect' | 'query'

export interface DataSourceReadExecutionOptions {
  adapter: object
  signal: AbortSignal
  beforeIO(kind: DataSourceReadIOKind): Promise<void>
  afterIO(): Promise<void>
}

interface ReadExecution extends DataSourceReadExecutionOptions {
  active: boolean
  failure?: Error
}

// Host-only capability: never attach this state to an adapter, pool, config or plugin facade.
// Async children retain the closed context, so a detached continuation cannot escape its scope.
const executions = new AsyncLocalStorage<ReadExecution>()
const executionErrors = new WeakSet<Error>()

function controlError(code: string): Error {
  const error = Object.assign(new Error(code), { code })
  executionErrors.add(error)
  return error
}

function fail(execution: ReadExecution, error: Error): never {
  execution.failure ??= error
  executionErrors.add(execution.failure)
  throw execution.failure
}

function assertCurrent(execution: ReadExecution, adapter: object): void {
  if (execution.failure) throw execution.failure
  if (!execution.active) fail(execution, controlError('DATA_SOURCE_READ_EXECUTION_CLOSED'))
  if (execution.adapter !== adapter) fail(execution, controlError('DATA_SOURCE_READ_EXECUTION_ADAPTER_MISMATCH'))
  if (execution.signal.aborted) fail(execution, controlError('DATA_SOURCE_READ_EXECUTION_ABORTED'))
}

/** Includes trusted host checkpoint errors without changing their authority error identity. */
export function isDataSourceReadExecutionError(error: unknown): error is Error {
  return error instanceof Error && executionErrors.has(error)
}

export async function withDataSourceReadExecution<T>(
  options: DataSourceReadExecutionOptions,
  work: () => Promise<T>,
): Promise<T> {
  const outer = executions.getStore()
  if (outer) fail(outer, controlError('DATA_SOURCE_READ_EXECUTION_NESTED'))

  const execution: ReadExecution = { ...options, active: true }
  return executions.run(execution, async () => {
    try {
      assertCurrent(execution, options.adapter)
      const result = await work()
      assertCurrent(execution, options.adapter)
      return result
    } finally {
      execution.active = false
    }
  })
}

/** Client-vending operations have no guarded native boundary and are unavailable in a read scope. */
export function assertDataSourceReadOperationAllowed(adapter: object): void {
  const execution = executions.getStore()
  if (!execution) return
  assertCurrent(execution, adapter)
  fail(execution, controlError('DATA_SOURCE_READ_EXECUTION_OPERATION_UNSUPPORTED'))
}

export async function runDataSourceReadIO<T>(
  adapter: object,
  kind: DataSourceReadIOKind,
  work: (signal?: AbortSignal) => Promise<T>,
  cancel?: () => void,
): Promise<T> {
  const execution = executions.getStore()
  if (!execution) return work()

  assertCurrent(execution, adapter)
  try {
    await execution.beforeIO(kind)
  } catch (error) {
    fail(execution, error instanceof Error ? error : controlError('DATA_SOURCE_READ_EXECUTION_CHECKPOINT_FAILED'))
  }
  assertCurrent(execution, adapter)

  // The callback may only cancel this particular request. Never cancel/end/close a shared pool.
  const onAbort = () => {
    if (!cancel) return
    try { cancel() } catch { /* cancellation remains best effort; the scope still fails closed */ }
  }
  execution.signal.addEventListener('abort', onAbort, { once: true })
  let result: T
  try {
    assertCurrent(execution, adapter)
    result = await work(execution.signal)
  } catch (error) {
    assertCurrent(execution, adapter)
    fail(execution, isDataSourceReadExecutionError(error)
      ? error
      : controlError('DATA_SOURCE_READ_EXECUTION_IO_FAILED'))
  } finally {
    execution.signal.removeEventListener('abort', onAbort)
  }

  assertCurrent(execution, adapter)
  try {
    await execution.afterIO()
  } catch (error) {
    fail(execution, error instanceof Error ? error : controlError('DATA_SOURCE_READ_EXECUTION_CHECKPOINT_FAILED'))
  }
  assertCurrent(execution, adapter)
  return result
}
