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
  | 'webhook.received'

export const ALL_TRIGGER_TYPES: AutomationTriggerType[] = [
  'record.created',
  'record.updated',
  'record.deleted',
  'field.value_changed',
  'schedule.cron',
  'schedule.interval',
  'webhook.received',
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

/** Config shape for webhook.received */
export interface WebhookReceivedConfig {
  secret?: string
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
