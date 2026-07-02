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
