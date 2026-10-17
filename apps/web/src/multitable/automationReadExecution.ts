import type { AutomationReadRequestRef } from '../services/integration/automationRead'
import type { AutomationRunView } from './types'

const labels = {
  queued: ['已排队，未完成', 'Queued, not complete'], running: ['正在运行', 'Running'],
  succeeded: ['只读预览完成', 'Read-only preview complete'], blocked: ['已阻止执行', 'Execution blocked'],
  failed: ['执行失败', 'Execution failed'], cancelled: ['已取消', 'Cancelled'],
  outcome_unknown: ['结果未知，不会自动重做', 'Outcome unknown; no automatic rerun'],
} as const

function invalid(): never { throw new Error('Invalid read-preview execution response') }

/** GET and view boundary: only own data properties, never free-form payloads. */
export function closedAutomationReadExecution(value: unknown): AutomationReadRequestRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Reflect.ownKeys(value).length !== 2) invalid()
  const request = Object.getOwnPropertyDescriptor(value, 'requestId')
  const status = Object.getOwnPropertyDescriptor(value, 'status')
  if (!request?.enumerable || !status?.enumerable || !Object.hasOwn(request, 'value') || !Object.hasOwn(status, 'value')
    || typeof request.value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request.value)
    || typeof status.value !== 'string' || !Object.hasOwn(labels, status.value)) invalid()
  return { requestId: request.value, status: status.value as AutomationReadRequestRef['status'] }
}

/** Preserve old run fields; narrow only the newly optional read reference. */
export function normalizeAutomationRunReadReference(run: AutomationRunView): AutomationRunView {
  const descriptor = Object.getOwnPropertyDescriptor(run, 'integrationRead')
  if (!descriptor) {
    if ('integrationRead' in run) invalid()
    return run
  }
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
  if (descriptor.value === undefined) return run
  return { ...run, integrationRead: closedAutomationReadExecution(descriptor.value) }
}

export function automationReadExecutionStatusLabel(status: AutomationReadRequestRef['status'], isZh: boolean): string {
  return labels[status][isZh ? 0 : 1]
}
