import type { AutomationIntegrationActor } from './automation-live-authority'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import type { TransactionalQueryable } from '../multitable/pg-transaction-guard'
import type { RoutingManifest } from '../multitable/automation-routing-manifest'
import { isValidIanaTimeZone } from '../multitable/automation-timezone'
import type { AutomationReadRecordConditionEvent, AutomationReadRecordConditionResult } from './automation-read-record-conditions'

export const AUTOMATION_READ_EVENT = 'integration.read-preview.requested'
export const AUTOMATION_READ_CONSUMER = 'integration-read-preview'
export type ReadTrigger = 'manual' | 'schedule' | 'record'
export type ReadRequestStatus = 'queued' | 'running' | 'succeeded' | 'blocked'
  | 'failed' | 'cancelled' | 'outcome_unknown'
export type ReadBudget = { maxRows: number; maxPages: number; maxReadCount: number; timeoutMs: number }
export type ReadSelector = { ruleId: string; actionId: string; systemId: string; targetId: string }
/** Host-minted private identity, never a client selector or credentials revision. */
export type ReadSourceReference = Readonly<{
  connectionId: string
  connectionIncarnation: string
}>
export type ReadPreview = {
  status: 'not_found' | 'large_bom_bounded' | 'ready' | 'manual_confirm_required'
  counts: { add: number; update: number; skip: number; inactive: number; manual_confirm: number }
  canApply: false
}
export type ReadGrantInput = {
  selector: ReadSelector
  projects: string[]
  triggers: ReadTrigger[]
  budget: ReadBudget
  expiresAt: string
  maxExecutions: number
}
/** Explicit one-new-read consent; no reusable grant, trigger or selector input. */
export type ReadRetryInput = {
  retryKey: string
  budget: ReadBudget
  expiresAt: string
  acknowledgeNewRead: true
}
export type ReadRetryRef = {
  parentRequestId: string
  grantId: string
  requestId: string
  status: ReadRequestStatus
}
/** Observation only. This does not promise that another read remains eligible. */
export type ReadRetryContext = {
  request: ReadRequestSummary
  grant: ReadGrantDetail
  nextAttempt: { requestId: string; grantId: string } | null
  /** Frozen public definition only; no record value, occurrence or private proof. */
  dateScheduleOrigin?: ReadDateScheduleOrigin
}
/** Closed owner consent/precondition description, not condition values or authority. */
export type ReadRecordCondition = Readonly<{ mode: 'unconditional' }
  | { mode: 'saved_conditions'; schemaRevision: string; businessTimeZone: string }>
/** Explicit new, automatic-only authorization; never upgrades an existing grant. */
export type ReadRecordActivationInput = {
  activationKey: string
  /** Concurrency precondition from owner discovery, never execution authority. */
  expectedRuleRevision: string
  expectedRecordCondition: ReadRecordCondition
  selector: ReadSelector
  projectNo: string
  budget: ReadBudget
  expiresAt: string
  maxExecutions: number
}
export type ReadRecordActivationRef = { activationId: string; grantId: string }
export type ReadDateFieldConfirmation = Readonly<{
  fieldId: string; fieldType: 'date' | 'dateTime'; schemaRevision: string
}>
export type ReadDateScheduleConfig = Readonly<{
  dateFieldId: string; offsetDays: number; direction: 'before' | 'after'
  timeOfDay?: string; timezone?: string; effectiveAt?: string; scanIntervalMs?: number
}>
export type ReadScheduleDefinition = Readonly<
  { triggerType: 'schedule.cron'; config: Readonly<{ expression?: string; cron?: string; timezone?: string }> }
  | { triggerType: 'schedule.interval'; intervalMs: number; anchorMs: number }
  | { triggerType: 'schedule.date_field'; config: ReadDateScheduleConfig; dateField: ReadDateFieldConfirmation }
>
export type ReadDateScheduleOrigin = Readonly<{
  definition: Extract<ReadScheduleDefinition, { triggerType: 'schedule.date_field' }>
  ruleRevision: string
}>
/** Separate explicit schedule authorization; record/standalone grants never upgrade. */
export type ReadScheduleActivationInput = {
  activationKey: string
  /** Owner-observed rule revision, including its persisted creation-time phase. */
  expectedRuleRevision: string
  /** Required ONLY for a new date-field consent. Never inferred for old clients. */
  expectedDateField?: ReadDateFieldConfirmation
  selector: ReadSelector
  projectNo: string
  budget: ReadBudget
  expiresAt: string
  maxExecutions: number
}
export type ReadScheduleActivationRef = { activationId: string; grantId: string }
/** Host plan, not authorization or callback wall-clock time. */
export type ReadScheduleOccurrence = Readonly<
  { ruleId: string; scheduledAtMs: number; triggerType?: 'schedule.cron' }
  | { ruleId: string; scheduledAtMs: number; triggerType: 'schedule.interval'; intervalMs: number; anchorMs: number }
  /** A host wake only; per-record occurrence must be recomputed behind current read authority. */
  | { ruleId: string; scheduledAtMs: number; triggerType: 'schedule.date_field' }
>
/** Host-private claimed delivery identity, not a caller-supplied event payload. */
export type ReadRecordDelivery = { outboxId: string; eventId: string; fence: string; attempts: number }
/** Owner-facing projections. No execution fence, authority digest or original
 * Connection identity belongs in these JSON contracts. */
export type ReadGrantDetail = ReadGrantInput & {
  grantId: string
  purpose: 'standalone' | 'automatic' | 'retry'
  status: 'active' | 'revoked'
  usedExecutions: number
  createdAt: string
  updatedAt: string
}
export type ReadRequestSummary = {
  requestId: string
  grantId: string
  status: ReadRequestStatus
  projectNo: string
  trigger: ReadTrigger
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}
export type ReadPageInput = { limit?: number; after?: string }
export type ReadRequestPageInput = ReadPageInput & { grantId?: string }
export type ReadPage<T> = { items: T[]; nextCursor: string | null }

/**
 * HOST-PRIVATE dependency contract, NOT a public authorization DTO or plugin API.
 * Implementation must lock and derive the complete rule incarnation/creator,
 * source revisions + frozen active receipt, target identity/mapping incarnation
 * and ALL row/field read permissions. key is a digest of those locked facts, not
 * a caller-supplied version string. No source IO is permitted in these callbacks.
 * Current actor/admin is independently checked by the ledger in the same trx.
 * sourceReference is captured from the actually locked original Connection and
 * its DB-minted incarnation (canonical lower-case UUID), not a client field,
 * current-system hint, credentials validation revision or guessed backfill.
 * Ordinary config/owner updates preserve that incarnation; delete/recreation
 * and soft-delete revival must mint a different one at the database boundary.
 * allowedTriggers is derived from the locked, fixed single-operation rule
 * policy, not requested trigger types. Manual is never an implicit bypass.
 * The ledger requires both requested and persisted grant triggers to remain a
 * subset on every execution authorization; the policy also belongs in key.
 *
 * Observation receives ONLY the persisted original source reference, never the
 * mutable system selector. It must lock that exact Connection incarnation and
 * check its CURRENT owner/tenant/private/live scope, then return the reference
 * it actually verified. Blindly echoing the input does not implement this port.
 * It must not resolve the current system binding, adopt a historical owner, or
 * require the historical version to remain active/old credentials revision to
 * remain unchanged merely to view history. Missing original identity denies.
 *
 * The controlled private host runtime composes real metadata authority and a
 * single-attempt dispatcher consumer with checks at each source IO boundary.
 * A synthetic callback proves ledger state transitions ONLY, not real authority.
 */
export type ReadExecutionProof = {
  actorId: string; tenantId: string; workspaceId: null; key: string; budget: ReadBudget; sourceReference: ReadSourceReference
  allowedTriggers: readonly ReadTrigger[]
}
export interface AutomationReadAuthorityPort {
  lockExecution(trx: Queryable, actor: AutomationIntegrationActor, selector: ReadSelector): Promise<ReadExecutionProof>
  /** Optional only for ordinary-only hosts. Record execution must require all three; never fall back. */
  lockRecordExecution?(trx: Queryable, actor: AutomationIntegrationActor, selector: ReadSelector): Promise<ReadExecutionProof>
  evaluateRecordConditions?(trx: Queryable, proof: ReadExecutionProof,
    event: AutomationReadRecordConditionEvent): Promise<AutomationReadRecordConditionResult>
  recordConditionFor?(proof: ReadExecutionProof): ReadRecordCondition
  lockObservation(trx: Queryable, actor: AutomationIntegrationActor, sourceReference: ReadSourceReference): Promise<
    AutomationIntegrationActor & { sourceReference: ReadSourceReference }
  >
}

export interface AutomationReadLedgerDependencies {
  transaction<T>(work: (trx: TransactionalQueryable) => Promise<T>): Promise<T>
  authority: AutomationReadAuthorityPort
  // Explicit host injection: producer and consumer must use the same versioned
  // manifest. Observation-only callers never enqueue or authorize execution.
  manifest: RoutingManifest
}

export class AutomationReadLedgerError extends Error {
  constructor(readonly code: 'AUTOMATION_READ_INPUT_INVALID' | 'AUTOMATION_READ_DENIED'
    | 'AUTOMATION_READ_SCOPE_CHANGED' | 'AUTOMATION_READ_BUDGET_EXHAUSTED'
    | 'AUTOMATION_READ_IDEMPOTENCY_CONFLICT' | 'AUTOMATION_READ_ROUTING_UNAVAILABLE'
    | 'AUTOMATION_READ_FENCE_LOST' | 'AUTOMATION_READ_TRANSACTION_REQUIRED' | 'AUTOMATION_READ_UNAVAILABLE') {
    super(code)
    this.name = 'AutomationReadLedgerError'
  }
}

export function readInput(condition: unknown): asserts condition {
  if (!condition) throw new AutomationReadLedgerError('AUTOMATION_READ_INPUT_INVALID')
}
export function canonicalReadId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255
    && value === value.trim()
    // eslint-disable-next-line no-control-regex -- Scope/opaque identities reject embedded controls.
    && !/[\u0000-\u001f\u007f]/u.test(value)
}
/** Read each own data descriptor once; neither consent hooks nor provider serializers run. */
export function checkedReadRecordCondition(value: unknown): ReadRecordCondition {
  try {
    readInput(value !== null && typeof value === 'object' && !Array.isArray(value)
      && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
    const keys = Reflect.ownKeys(value)
    const own = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      readInput(descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value'))
      return descriptor.value
    }
    const mode = own('mode')
    if (mode === 'unconditional') {
      readInput(keys.length === 1)
      return Object.freeze({ mode })
    }
    readInput(mode === 'saved_conditions' && keys.length === 3)
    const schemaRevision = own('schemaRevision'), businessTimeZone = own('businessTimeZone')
    readInput(typeof schemaRevision === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(schemaRevision))
    readInput(typeof businessTimeZone === 'string' && businessTimeZone.length > 0 && businessTimeZone.length <= 128
      && businessTimeZone === businessTimeZone.trim() && isValidIanaTimeZone(businessTimeZone))
    return Object.freeze({ mode, schemaRevision, businessTimeZone })
  } catch {
    throw new AutomationReadLedgerError('AUTOMATION_READ_INPUT_INVALID')
  }
}
/** Exact private identity. Never call getters/toJSON or retain provider objects. */
export function checkedReadSourceReference(value: unknown): ReadSourceReference {
  readInput(value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Reflect.ownKeys(value).length === 2)
  const idDescriptor = Object.getOwnPropertyDescriptor(value, 'connectionId')
  const incarnationDescriptor = Object.getOwnPropertyDescriptor(value, 'connectionIncarnation')
  readInput(idDescriptor?.enumerable === true && Object.hasOwn(idDescriptor, 'value')
    && incarnationDescriptor?.enumerable === true && Object.hasOwn(incarnationDescriptor, 'value'))
  const connectionId: unknown = idDescriptor.value
  const connectionIncarnation: unknown = incarnationDescriptor.value
  readInput(canonicalReadId(connectionId) && typeof connectionIncarnation === 'string'
    && connectionIncarnation.length === 36
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(connectionIncarnation))
  return Object.freeze({ connectionId, connectionIncarnation })
}
/** Closed, detached trigger policy/request data; never invoke array hooks. */
export function checkedReadTriggers(value: unknown): readonly ReadTrigger[] {
  try {
    readInput(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
      && value.length > 0 && value.length <= 3 && Reflect.ownKeys(value).length === value.length + 1)
    const result: ReadTrigger[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      readInput(descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value'))
      const trigger: unknown = descriptor.value
      readInput(trigger === 'manual' || trigger === 'schedule' || trigger === 'record')
      readInput(!result.includes(trigger))
      result.push(trigger)
    }
    return Object.freeze(result)
  } catch {
    throw new AutomationReadLedgerError('AUTOMATION_READ_INPUT_INVALID')
  }
}
export function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
export function checkedReadSelector(value: unknown): ReadSelector {
  readInput(exactObject(value, ['ruleId', 'actionId', 'systemId', 'targetId']))
  for (const item of Object.values(value)) readInput(canonicalReadId(item))
  return { ruleId: value.ruleId as string, actionId: value.actionId as string,
    systemId: value.systemId as string, targetId: value.targetId as string }
}
export function checkedReadBudget(value: unknown): ReadBudget {
  readInput(exactObject(value, ['maxRows', 'maxPages', 'maxReadCount', 'timeoutMs']))
  for (const item of Object.values(value)) readInput(Number.isSafeInteger(item) && Number(item) > 0 && Number(item) <= 2147483647)
  return { maxRows: Number(value.maxRows), maxPages: Number(value.maxPages),
    maxReadCount: Number(value.maxReadCount), timeoutMs: Number(value.timeoutMs) }
}
export function checkedReadPreview(value: unknown): ReadPreview {
  readInput(exactObject(value, ['status', 'counts', 'canApply']))
  const { status, counts, canApply } = value
  readInput(canApply === false && typeof status === 'string'
    && ['not_found', 'large_bom_bounded', 'ready', 'manual_confirm_required'].includes(status))
  readInput(exactObject(counts, ['add', 'update', 'skip', 'inactive', 'manual_confirm']))
  const { add, update, skip, inactive, manual_confirm } = counts
  for (const count of [add, update, skip, inactive, manual_confirm]) readInput(Number.isSafeInteger(count) && Number(count) >= 0)
  // Never serialize the provider's object: custom toJSON/prototypes may change
  // its shape AFTER validation. Copy only the captured validated primitives.
  return { status: status as ReadPreview['status'], canApply: false, counts: {
    add: add as number, update: update as number, skip: skip as number,
    inactive: inactive as number, manual_confirm: manual_confirm as number,
  } }
}
