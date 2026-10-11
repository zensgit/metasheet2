/**
 * Automation Trigger Types — V1
 * Defines all supported trigger types and their configuration shapes.
 */

export type AutomationTriggerType =
  | 'record.created'
  | 'record.updated'
  | 'record.deleted'
  | 'field.value_changed'
  | 'schedule.cron'
  | 'schedule.interval'
  | 'schedule.date_field'
  | 'webhook.received'
  | 'form.submitted'
  | 'approval.completed'
  | 'approval.task_created'

export const ALL_TRIGGER_TYPES: AutomationTriggerType[] = [
  'record.created',
  'record.updated',
  'record.deleted',
  'field.value_changed',
  'schedule.cron',
  'schedule.interval',
  'schedule.date_field',
  'webhook.received',
  'form.submitted',
  'approval.completed',
  'approval.task_created',
]

/** Config shape for field.value_changed */
export interface FieldValueChangedConfig {
  fieldId: string
  condition?: 'any' | 'equals' | 'changed_to'
  value?: unknown
}

/** Config shape for schedule.cron */
export interface ScheduleCronConfig {
  expression: string
  timezone?: string
}

/** Config shape for schedule.interval */
export interface ScheduleIntervalConfig {
  intervalMs: number
  startAt?: string
}

export const MIN_SCHEDULE_INTERVAL_MS = 1000
export const MAX_SCHEDULE_INTERVAL_MS = 2 ** 31 - 1

/** Read intervals are exact authoring contracts. Ordinary intervals retain
 * existing extra keys, but must never hit Node's invalid-delay clamp. */
export function scheduleIntervalMs(config: unknown, closed = false): number | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null
  if (closed && ((Object.getPrototypeOf(config) !== Object.prototype && Object.getPrototypeOf(config) !== null)
    || Reflect.ownKeys(config).length !== 1 || !Object.hasOwn(config, 'intervalMs'))) return null
  const descriptor = Object.getOwnPropertyDescriptor(config, 'intervalMs')
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null
  const value: unknown = descriptor.value
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= MIN_SCHEDULE_INTERVAL_MS && value <= MAX_SCHEDULE_INTERVAL_MS ? value : null
}

/** Config shape for webhook.received */
export interface WebhookReceivedConfig {
  secret?: string
}

/**
 * Config shape for approval.completed (T1-3).
 * Routing is by REQUIRED approval templateId (cross-sheet; the completion event carries no sheet/record).
 * `outcomes` filters which terminal outcomes fire the rule; omitted = approved only. Dispatch does NOT go
 * through matchesTrigger/TRIGGER_TYPE_BY_EVENT — approval completions are routed by a dedicated
 * template-keyed path in AutomationService (they are not multitable record events).
 */
export interface ApprovalCompletedConfig {
  templateId: string
  outcomes?: Array<'approved' | 'rejected' | 'revoked' | 'cancelled'>
}

/**
 * Config shape for approval.task_created (A-2a, one-tap lock #3594 implementation decision).
 * Same template-keyed dedicated dispatch path as approval.completed — one event per NEW actionable
 * assignment/recipient; NOT a multitable record event. templateId is REQUIRED; a pending event whose
 * instance carries no templateId is v1 out-of-contract (debug log, no match).
 */
export interface ApprovalTaskCreatedConfig {
  templateId: string
}

export interface AutomationTrigger {
  type: AutomationTriggerType
  config: Record<string, unknown>
}

/**
 * Map from EventBus event names to trigger types.
 */
export const TRIGGER_TYPE_BY_EVENT: Record<string, AutomationTriggerType> = {
  'multitable.record.created': 'record.created',
  'multitable.record.updated': 'record.updated',
  'multitable.record.deleted': 'record.deleted',
  'multitable.form.submitted': 'form.submitted',
}

/**
 * Check if a trigger matches an incoming event.
 */
export function matchesTrigger(
  trigger: AutomationTrigger,
  eventTriggerType: AutomationTriggerType,
  payload: { data?: Record<string, unknown>; changes?: Record<string, unknown> },
): boolean {
  if (trigger.type === 'field.value_changed') {
    // field.value_changed only fires on record.updated events
    if (eventTriggerType !== 'record.updated') return false
    const config = trigger.config as Partial<FieldValueChangedConfig>
    const fieldId = config.fieldId
    if (!fieldId) return false
    const changes = payload.changes ?? payload.data ?? {}
    if (!(fieldId in changes)) return false

    if (config.condition === 'equals' && config.value !== undefined) {
      return changes[fieldId] === config.value
    }
    if (config.condition === 'changed_to' && config.value !== undefined) {
      return changes[fieldId] === config.value
    }
    // 'any' or unspecified — field just needs to be present in changes
    return true
  }

  return trigger.type === eventTriggerType
}
