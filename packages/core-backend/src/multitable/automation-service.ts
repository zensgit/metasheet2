import type { EventBus } from '../integration/events/event-bus'
import { patchRecord, type MultitableRecordsQueryFn } from './records'
import { Logger } from '../core/logger'

const logger = new Logger('AutomationService')

const MAX_AUTOMATION_DEPTH = 3

const VALID_TRIGGER_TYPES = new Set([
  'record.created',
  'record.updated',
  'field.changed',
])

const TRIGGER_TYPE_BY_EVENT: Record<string, string> = {
  'multitable.record.created': 'record.created',
  'multitable.record.updated': 'record.updated',
}

export type AutomationRule = {
  id: string
  sheet_id: string
  name: string | null
  trigger_type: string
  trigger_config: Record<string, unknown>
  action_type: string
  action_config: Record<string, unknown>
  enabled: boolean
  created_at: string
  updated_at: string
  created_by: string | null
}

export type AutomationQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export type AutomationEventPayload = {
  sheetId: string
  recordId: string
  data?: Record<string, unknown>
  changes?: Record<string, unknown>
  actorId?: string | null
  _automationDepth?: number
}

export class AutomationService {
  private eventBus: EventBus
  private query: AutomationQueryFn
  private subscriptionIds: string[] = []

  constructor(eventBus: EventBus, query: AutomationQueryFn) {
    this.eventBus = eventBus
    this.query = query
  }

  init(): void {
    const events = [
      'multitable.record.created',
      'multitable.record.updated',
    ]

    for (const eventType of events) {
      const id = this.eventBus.subscribe<AutomationEventPayload>(
        eventType,
        (payload) => {
          this.handleEvent(eventType, payload).catch((err) => {
            logger.error(`Automation handler error for ${eventType}`, err instanceof Error ? err : undefined)
          })
        },
      )
      this.subscriptionIds.push(id)
    }

    logger.info('AutomationService initialized')
  }

  shutdown(): void {
    for (const id of this.subscriptionIds) {
      this.eventBus.unsubscribe(id)
    }
    this.subscriptionIds = []
    logger.info('AutomationService shut down')
  }

  async handleEvent(eventType: string, payload: AutomationEventPayload): Promise<void> {
    const depth = typeof payload._automationDepth === 'number' ? payload._automationDepth : 0
    if (depth >= MAX_AUTOMATION_DEPTH) {
      logger.warn(`Automation recursion guard triggered (depth=${depth}) for ${eventType} on sheet ${payload.sheetId}`)
      return
    }

    const { sheetId, recordId } = payload
    if (!sheetId || !recordId) return

    const rules = await this.loadEnabledRules(sheetId)
    if (rules.length === 0) return

    const triggerType = TRIGGER_TYPE_BY_EVENT[eventType]
    if (!triggerType) return

    for (const rule of rules) {
      if (!this.matchesTrigger(rule, triggerType, payload)) continue

      try {
        await this.executeAction(rule, payload, depth)
      } catch (err) {
        logger.error(
          `Automation rule ${rule.id} action failed`,
          err instanceof Error ? err : undefined,
        )
      }
    }
  }

  private matchesTrigger(
    rule: AutomationRule,
    triggerType: string,
    payload: AutomationEventPayload,
  ): boolean {
    if (rule.trigger_type === 'field.changed') {
      // field.changed triggers on record.updated events only
      if (triggerType !== 'record.updated') return false
      const fieldId = typeof rule.trigger_config?.fieldId === 'string'
        ? rule.trigger_config.fieldId
        : null
      if (!fieldId) return false
      const changes = payload.changes ?? payload.data ?? {}
      return fieldId in changes
    }

    return rule.trigger_type === triggerType
  }

  private async executeAction(
    rule: AutomationRule,
    payload: AutomationEventPayload,
    depth: number,
  ): Promise<void> {
    switch (rule.action_type) {
      case 'notify': {
        this.eventBus.emit('automation.notify', {
          ruleId: rule.id,
          sheetId: payload.sheetId,
          recordId: payload.recordId,
          actorId: payload.actorId,
          ...rule.action_config,
          _automationDepth: depth + 1,
        })
        break
      }
      case 'update_field': {
        const targetFieldId = typeof rule.action_config?.fieldId === 'string'
          ? rule.action_config.fieldId
          : null
        const value = rule.action_config?.value
        if (!targetFieldId) {
          logger.warn(`Automation rule ${rule.id}: update_field action missing fieldId`)
          return
        }

        await patchRecord({
          query: this.query,
          sheetId: payload.sheetId,
          recordId: payload.recordId,
          changes: { [targetFieldId]: value },
        })

        // Emit follow-up event with incremented depth for chaining
        this.eventBus.emit('multitable.record.updated', {
          sheetId: payload.sheetId,
          recordId: payload.recordId,
          changes: { [targetFieldId]: value },
          actorId: payload.actorId,
          _automationDepth: depth + 1,
        })
        break
      }
      default:
        logger.warn(`Automation rule ${rule.id}: unknown action_type '${rule.action_type}'`)
    }
  }

  async loadEnabledRules(sheetId: string): Promise<AutomationRule[]> {
    const result = await this.query(
      `SELECT id, sheet_id, name, trigger_type, trigger_config, action_type, action_config, enabled, created_at, updated_at, created_by
       FROM automation_rules
       WHERE sheet_id = $1 AND enabled = true
       ORDER BY created_at ASC`,
      [sheetId],
    )
    return result.rows as AutomationRule[]
  }
}
