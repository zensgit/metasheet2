import { createHash } from 'node:crypto'
import { types } from 'node:util'

// Descriptions only, never authorization capabilities. The future core authority
// must independently resolve owner, tenant, live material and database budgets.
export const YIDA_AUTOMATION_MAX_EXECUTIONS = 10
export const YIDA_AUTOMATION_MAX_TTL_MS = 900000
export type YidaAutomationTrigger = 'manual' | 'schedule.interval'
type Data = Record<string, unknown>
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const DIGEST = /^[0-9a-f]{64}$/u

export class YidaAutomationContractError extends Error {
  constructor() {
    super('YIDA_AUTOMATION_INPUT_INVALID')
    this.name = 'YidaAutomationContractError'
  }
}
function reject(): never { throw new YidaAutomationContractError() }

function data(input: unknown, keys: readonly string[]): Data {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)) reject()
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) reject()
  const descriptors = Object.getOwnPropertyDescriptors(input)
  const supplied = Reflect.ownKeys(descriptors)
  if (supplied.length !== keys.length || supplied.some(key => typeof key !== 'string' || !keys.includes(key))) reject()
  return Object.fromEntries(keys.map(key => {
    const property = descriptors[key]
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) reject()
    return [key, property.value]
  }))
}
function list(input: unknown, maximum: number): readonly unknown[] {
  if (!input || typeof input !== 'object' || types.isProxy(input) || !Array.isArray(input)
    || Object.getPrototypeOf(input) !== Array.prototype) reject()
  const descriptors = Object.getOwnPropertyDescriptors(input)
  const length: unknown = Object.getOwnPropertyDescriptor(input, 'length')?.value
  if (typeof length !== 'number') reject()
  if (!Number.isSafeInteger(length) || length < 1 || length > maximum
    || Reflect.ownKeys(descriptors).length !== length + 1) reject()
  return Object.freeze(Array.from({ length }, (_, index) => {
    const property = descriptors[String(index)]
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) reject()
    return property.value
  }))
}
function id(input: unknown): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > 128
    || input.trim() !== input || /[\u0000-\u001f\u007f]/u.test(input)) reject()
  return input
}
function uuid(input: unknown): string {
  const result = id(input)
  if (!UUID.test(result)) reject()
  return result
}
function positive(input: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1 || input > maximum) reject()
  return input
}
function uniqueIds(input: unknown): readonly string[] {
  const values = list(input, YIDA_AUTOMATION_MAX_EXECUTIONS).map(id)
  if (new Set(values).size !== values.length) reject()
  return Object.freeze(values)
}
function triggers(input: unknown): readonly YidaAutomationTrigger[] {
  const values = list(input, 2)
  if (values.some(value => value !== 'manual' && value !== 'schedule.interval')
    || new Set(values).size !== values.length) reject()
  // A single representation prevents consent replays differing by set order.
  return Object.freeze([...values].sort()) as readonly YidaAutomationTrigger[]
}

export type YidaAutomationAuthorizationInput = Readonly<{
  confirmationId: string
  ruleId: string
  expectedRuleRevision: string
  actionId: string
  projectNo: string
  operationId: string
  rowKeys: readonly string[]
  allowedTriggers: readonly YidaAutomationTrigger[]
  maxExecutions: number
  maxTotalRows: number
  ttlMs: number
}>

/** Capture client consent references, not material digests or a scope assertion.
 * No defaults: omission cannot silently approve ten rows or a 15-minute window. */
export function checkedYidaAutomationAuthorization(input: unknown): YidaAutomationAuthorizationInput {
  const row = data(input, ['confirmationId', 'ruleId', 'expectedRuleRevision', 'actionId', 'projectNo',
    'operationId', 'rowKeys', 'allowedTriggers', 'maxExecutions', 'ttlMs'])
  const rowKeys = uniqueIds(row.rowKeys)
  const maxExecutions = positive(row.maxExecutions, YIDA_AUTOMATION_MAX_EXECUTIONS)
  if (rowKeys.length > maxExecutions) reject()
  return Object.freeze({
    confirmationId: id(row.confirmationId), ruleId: id(row.ruleId),
    expectedRuleRevision: uuid(row.expectedRuleRevision), actionId: id(row.actionId),
    projectNo: id(row.projectNo), operationId: id(row.operationId), rowKeys,
    allowedTriggers: triggers(row.allowedTriggers), maxExecutions, maxTotalRows: rowKeys.length,
    ttlMs: positive(row.ttlMs, YIDA_AUTOMATION_MAX_TTL_MS),
  })
}

export function checkedYidaAutomationRequest(input: unknown): Readonly<{ requestKey: string }> {
  return Object.freeze({ requestKey: id(data(input, ['requestKey']).requestKey) })
}

export type YidaAutomationOccurrence = Readonly<{
  grantId: string; activationId: string; ruleId: string; ruleRevision: string; actionId: string
  triggerType: YidaAutomationTrigger; occurrenceKey: string
}>

/** Host-only canonical description. A matching hash is not a scheduler proof or
 * an execution handle: callers must still verify the real producer and grant.
 * Worker wall-clock time, attempts and lease fences are deliberately not keys. */
export function captureYidaAutomationOccurrence(input: unknown): YidaAutomationOccurrence {
  const common = ['grantId', 'activationId', 'ruleId', 'ruleRevision', 'actionId', 'triggerType']
  // Do not read input.triggerType: it may be a getter or Proxy. First capture
  // data-only descriptors, then validate the exact branch shape.
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)) reject()
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) reject()
  const descriptor = Object.getOwnPropertyDescriptor(input, 'triggerType')
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) reject()
  const triggerType = descriptor.value
  if (triggerType !== 'manual' && triggerType !== 'schedule.interval') reject()
  const row = data(input, [...common, ...(triggerType === 'manual' ? ['requestKey']
    : ['scheduledAtMs', 'anchorMs', 'intervalMs', 'scheduleDefinitionDigest'])])
  const identity = { grantId: uuid(row.grantId), activationId: uuid(row.activationId),
    ruleId: id(row.ruleId), ruleRevision: uuid(row.ruleRevision), actionId: id(row.actionId) }
  let payload: readonly unknown[]
  if (triggerType === 'manual') {
    payload = [id(row.requestKey)]
  } else {
    const scheduled = positive(row.scheduledAtMs), anchor = positive(row.anchorMs)
    const interval = positive(row.intervalMs)
    if (scheduled < anchor || (scheduled - anchor) % interval !== 0
      || scheduled > 8640000000000000 || anchor > 8640000000000000
      || typeof row.scheduleDefinitionDigest !== 'string' || !DIGEST.test(row.scheduleDefinitionDigest)) reject()
    payload = [scheduled, anchor, interval, row.scheduleDefinitionDigest]
  }
  // Explicit fixed-order tuple, not JSON.stringify on caller-controlled data.
  const occurrenceKey = createHash('sha256').update(JSON.stringify(['yida-automation-occurrence/v1',
    identity.grantId, identity.activationId, identity.ruleId, identity.ruleRevision, identity.actionId,
    triggerType, ...payload])).digest('hex')
  return Object.freeze({ ...identity, triggerType, occurrenceKey })
}
