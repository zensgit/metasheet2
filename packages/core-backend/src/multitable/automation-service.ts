import type { EventBus } from '../integration/events/event-bus'
import { patchRecord, type MultitableRecordsQueryFn } from './records'
import { Logger } from '../core/logger'
import { matchesTrigger, TRIGGER_TYPE_BY_EVENT, type AutomationTriggerType } from './automation-triggers'
import type { ConditionGroup } from './automation-conditions'
import { AutomationExecutor, type AutomationRule as ExecutorRule, type AutomationExecution, type AutomationDeps } from './automation-executor'
import type { AutomationAction } from './automation-actions'
import type { AutomationTrigger } from './automation-triggers'
import { AutomationScheduler } from './automation-scheduler'
import { AutomationLogService } from './automation-log-service'

const logger = new Logger('AutomationService')

const MAX_AUTOMATION_DEPTH = 3

const VALID_TRIGGER_TYPES = new Set([
  'record.created',
  'record.updated',
  'record.deleted',
  'field.changed',
  'field.value_changed',
  'schedule.cron',
  'schedule.interval',
  'webhook.received',
])

/**
 * Legacy DB-shaped rule (from automation_rules table).
 * Kept for backward compatibility with existing CRUD routes.
 */
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
  // V1 extended fields (nullable for backward compat)
  conditions?: ConditionGroup | null
  actions?: AutomationAction[] | null
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
  _triggeredBy?: string
}

/**
 * Convert a legacy DB rule to the executor rule format.
 */
function toExecutorRule(rule: AutomationRule): ExecutorRule {
  const trigger: AutomationTrigger = {
    type: rule.trigger_type as AutomationTriggerType,
    config: rule.trigger_config ?? {},
  }

  // V1 rules can have multiple actions via the `actions` column,
  // or fall back to single action from legacy columns.
  const actions: AutomationAction[] = rule.actions && rule.actions.length > 0
    ? rule.actions
    : [{ type: rule.action_type as AutomationAction['type'], config: rule.action_config ?? {} }]

  return {
    id: rule.id,
    name: rule.name ?? '',
    sheetId: rule.sheet_id,
    trigger,
    conditions: rule.conditions ?? undefined,
    actions,
    enabled: rule.enabled,
    createdBy: rule.created_by ?? '',
    createdAt: rule.created_at,
    updatedAt: rule.updated_at,
  }
}

export class AutomationService {
  private eventBus: EventBus
  private query: AutomationQueryFn
  private subscriptionIds: string[] = []
  private executor: AutomationExecutor
  private scheduler: AutomationScheduler
  private logService: AutomationLogService

  constructor(eventBus: EventBus, query: AutomationQueryFn, fetchFn?: typeof fetch) {
    this.eventBus = eventBus
    this.query = query

    const deps: AutomationDeps = {
      eventBus,
      queryFn: query,
      fetchFn,
    }
    this.executor = new AutomationExecutor(deps)
    this.logService = new AutomationLogService()
    this.scheduler = new AutomationScheduler(async (rule) => {
      await this.executeRule(rule, { _triggeredBy: 'schedule' })
    })
  }

  /** Expose log service for routes */
  get logs(): AutomationLogService {
    return this.logService
  }

  /** Expose executor for manual test runs */
  get exec(): AutomationExecutor {
    return this.executor
  }

  init(): void {
    const events = [
      'multitable.record.created',
      'multitable.record.updated',
      'multitable.record.deleted',
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

    logger.info('AutomationService initialized (V1)')
  }

  /**
   * Register all scheduled rules from a given sheet.
   */
  async registerScheduledRules(sheetId: string): Promise<void> {
    const rules = await this.loadEnabledRules(sheetId)
    for (const rule of rules) {
      if (rule.trigger_type === 'schedule.cron' || rule.trigger_type === 'schedule.interval') {
        this.scheduler.register(toExecutorRule(rule))
      }
    }
  }

  /**
   * Register a single rule for scheduling (called on rule create/update).
   */
  registerSchedule(rule: AutomationRule): void {
    const execRule = toExecutorRule(rule)
    if (execRule.trigger.type === 'schedule.cron' || execRule.trigger.type === 'schedule.interval') {
      this.scheduler.register(execRule)
    }
  }

  /**
   * Unregister a rule from the scheduler.
   */
  unregisterSchedule(ruleId: string): void {
    this.scheduler.unregister(ruleId)
  }

  shutdown(): void {
    for (const id of this.subscriptionIds) {
      this.eventBus.unsubscribe(id)
    }
    this.subscriptionIds = []
    this.scheduler.destroy()
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
      const execRule = toExecutorRule(rule)

      if (!matchesTrigger(execRule.trigger, triggerType, payload)) continue

      try {
        await this.executeRule(execRule, payload)
      } catch (err) {
        logger.error(
          `Automation rule ${rule.id} action failed`,
          err instanceof Error ? err : undefined,
        )
      }
    }
  }

  /**
   * Execute a rule via the V1 executor and log the result.
   */
  async executeRule(rule: ExecutorRule, triggerEvent: unknown): Promise<AutomationExecution> {
    const execution = await this.executor.execute(rule, triggerEvent)
    this.logService.record(execution)
    return execution
  }

  /**
   * Manual test run: execute a rule immediately with synthetic event.
   */
  async testRun(ruleId: string, sheetId: string): Promise<AutomationExecution> {
    const rules = await this.loadEnabledRules(sheetId)
    const rule = rules.find((r) => r.id === ruleId)
    if (!rule) {
      throw new Error(`Rule ${ruleId} not found or not enabled`)
    }
    const execRule = toExecutorRule(rule)
    const syntheticEvent: AutomationEventPayload = {
      sheetId,
      recordId: 'test_record',
      data: {},
      actorId: 'system',
      _triggeredBy: 'manual_test',
    }
    return this.executeRule(execRule, syntheticEvent)
  }

  async loadEnabledRules(sheetId: string): Promise<AutomationRule[]> {
    const result = await this.query(
      `SELECT id, sheet_id, name, trigger_type, trigger_config, action_type, action_config, enabled, created_at, updated_at, created_by, conditions, actions
       FROM automation_rules
       WHERE sheet_id = $1 AND enabled = true
       ORDER BY created_at ASC`,
      [sheetId],
    )
    return result.rows as AutomationRule[]
  }
}
