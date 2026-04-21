import { randomUUID } from 'crypto'
import type { Kysely } from 'kysely'
import type { EventBus } from '../integration/events/event-bus'
import { Logger } from '../core/logger'
import { matchesTrigger, TRIGGER_TYPE_BY_EVENT, type AutomationTriggerType } from './automation-triggers'
import type { ConditionGroup } from './automation-conditions'
import { AutomationExecutor, type AutomationRule as ExecutorRule, type AutomationExecution, type AutomationDeps } from './automation-executor'
import type { AutomationAction } from './automation-actions'
import type { AutomationTrigger } from './automation-triggers'
import { AutomationScheduler } from './automation-scheduler'
import { AutomationLogService } from './automation-log-service'
import {
  normalizeDingTalkAutomationActionInputs,
  validateDingTalkAutomationActionConfigs,
  validateDingTalkAutomationLinks,
} from './dingtalk-automation-link-validation'
import type { Database } from '../db/types'

const logger = new Logger('AutomationService')

const MAX_AUTOMATION_DEPTH = 3

export class AutomationRuleValidationError extends Error {
  readonly code = 'VALIDATION_ERROR'

  constructor(message: string) {
    super(message)
    this.name = 'AutomationRuleValidationError'
  }
}

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

/** Input for creating a rule */
export interface CreateRuleInput {
  name?: string | null
  triggerType: string
  triggerConfig?: Record<string, unknown>
  actionType: string
  actionConfig?: Record<string, unknown>
  enabled?: boolean
  createdBy?: string | null
  conditions?: ConditionGroup | null
  actions?: AutomationAction[] | null
}

/** Input for updating a rule */
export interface UpdateRuleInput {
  name?: string | null
  triggerType?: string
  triggerConfig?: Record<string, unknown>
  actionType?: string
  actionConfig?: Record<string, unknown>
  enabled?: boolean
  conditions?: ConditionGroup | null
  actions?: AutomationAction[] | null
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

let sharedAutomationService: AutomationService | null = null

export function setAutomationServiceInstance(service: AutomationService | null): void {
  sharedAutomationService = service
}

export function getAutomationServiceInstance(): AutomationService | null {
  return sharedAutomationService
}

export class AutomationService {
  private eventBus: EventBus
  private db: Kysely<Database>
  private subscriptionIds: string[] = []
  private executor: AutomationExecutor
  private scheduler: AutomationScheduler
  private logService: AutomationLogService
  /** Kept for backward-compat with raw SQL in executor actions */
  private queryFn: AutomationQueryFn

  constructor(eventBus: EventBus, db: Kysely<Database>, queryFn: AutomationQueryFn, fetchFn?: typeof fetch) {
    this.eventBus = eventBus
    this.db = db
    this.queryFn = queryFn

    const deps: AutomationDeps = {
      eventBus,
      queryFn,
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

  // ── Rule CRUD (Kysely) ──────────────────────────────────────────────────

  /**
   * Create a new automation rule persisted to PostgreSQL.
   */
  async createRule(sheetId: string, input: CreateRuleInput): Promise<AutomationRule> {
    const ruleId = `atr_${randomUUID()}`
    const now = new Date().toISOString()
    const normalizedDingTalkInputs = normalizeDingTalkAutomationActionInputs(
      input.actionType,
      input.actionConfig ?? {},
      input.actions ?? null,
    )
    const actionConfig = normalizedDingTalkInputs.actionConfig && typeof normalizedDingTalkInputs.actionConfig === 'object'
      ? normalizedDingTalkInputs.actionConfig as Record<string, unknown>
      : input.actionConfig ?? {}
    const actions = Array.isArray(normalizedDingTalkInputs.actions)
      ? normalizedDingTalkInputs.actions as AutomationAction[]
      : input.actions ?? null
    const actionConfigValidationError = validateDingTalkAutomationActionConfigs(input.actionType, actionConfig, actions)
    if (actionConfigValidationError) throw new AutomationRuleValidationError(actionConfigValidationError)
    const linkValidationError = await validateDingTalkAutomationLinks(
      this.queryFn,
      sheetId,
      input.actionType,
      actionConfig,
      actions,
    )
    if (linkValidationError) throw new AutomationRuleValidationError(linkValidationError)

    const row = {
      id: ruleId,
      sheet_id: sheetId,
      name: input.name ?? null,
      trigger_type: input.triggerType,
      trigger_config: JSON.stringify(input.triggerConfig ?? {}),
      action_type: input.actionType,
      action_config: JSON.stringify(actionConfig),
      enabled: input.enabled ?? true,
      created_by: input.createdBy ?? null,
      conditions: input.conditions ? JSON.stringify(input.conditions) : null,
      actions: actions ? JSON.stringify(actions) : null,
    }

    await this.db
      .insertInto('automation_rules')
      .values(row as never)
      .execute()

    const rule: AutomationRule = {
      id: ruleId,
      sheet_id: sheetId,
      name: input.name ?? null,
      trigger_type: input.triggerType,
      trigger_config: input.triggerConfig ?? {},
      action_type: input.actionType,
      action_config: actionConfig,
      enabled: input.enabled ?? true,
      created_at: now,
      updated_at: now,
      created_by: input.createdBy ?? null,
      conditions: input.conditions ?? null,
      actions,
    }

    this.registerSchedule(rule)
    return rule
  }

  /**
   * Get a single automation rule by ID.
   */
  async getRule(ruleId: string): Promise<AutomationRule | null> {
    const row = await this.db
      .selectFrom('automation_rules')
      .selectAll()
      .where('id', '=', ruleId)
      .executeTakeFirst()

    if (!row) return null
    return this.mapRow(row)
  }

  /**
   * List all automation rules for a sheet.
   */
  async listRules(sheetId: string): Promise<AutomationRule[]> {
    const rows = await this.db
      .selectFrom('automation_rules')
      .selectAll()
      .where('sheet_id', '=', sheetId)
      .orderBy('created_at', 'asc')
      .execute()

    return rows.map((r) => this.mapRow(r))
  }

  /**
   * Update an existing automation rule.
   * Returns the updated rule, or null if not found.
   */
  async updateRule(ruleId: string, sheetId: string, input: UpdateRuleInput): Promise<AutomationRule | null> {
    const updates: Record<string, unknown> = {}
    const shouldValidateActions = input.actionType !== undefined || input.actionConfig !== undefined || input.actions !== undefined
    let normalizedActionConfigForUpdate: Record<string, unknown> | undefined
    let normalizedActionsForUpdate: AutomationAction[] | null | undefined

    if (shouldValidateActions) {
      const existing = await this.getRule(ruleId)
      if (!existing || existing.sheet_id !== sheetId) return null

      const nextActionType = input.actionType ?? existing.action_type
      const nextActionConfig = input.actionConfig ?? existing.action_config
      const nextActions = input.actions !== undefined ? input.actions : existing.actions ?? null
      const normalizedDingTalkInputs = normalizeDingTalkAutomationActionInputs(nextActionType, nextActionConfig, nextActions)
      const normalizedNextActionConfig = normalizedDingTalkInputs.actionConfig && typeof normalizedDingTalkInputs.actionConfig === 'object'
        ? normalizedDingTalkInputs.actionConfig as Record<string, unknown>
        : nextActionConfig
      const normalizedNextActions = Array.isArray(normalizedDingTalkInputs.actions)
        ? normalizedDingTalkInputs.actions as AutomationAction[]
        : nextActions
      const actionConfigValidationError = validateDingTalkAutomationActionConfigs(
        nextActionType,
        normalizedNextActionConfig,
        normalizedNextActions,
      )
      if (actionConfigValidationError) throw new AutomationRuleValidationError(actionConfigValidationError)
      const linkValidationError = await validateDingTalkAutomationLinks(
        this.queryFn,
        sheetId,
        nextActionType,
        normalizedNextActionConfig,
        normalizedNextActions,
      )
      if (linkValidationError) throw new AutomationRuleValidationError(linkValidationError)

      if (input.actionConfig !== undefined) normalizedActionConfigForUpdate = normalizedNextActionConfig
      if (input.actions !== undefined) normalizedActionsForUpdate = Array.isArray(input.actions) ? normalizedNextActions : null
    }

    if (input.name !== undefined) updates.name = input.name
    if (input.triggerType !== undefined) updates.trigger_type = input.triggerType
    if (input.triggerConfig !== undefined) updates.trigger_config = JSON.stringify(input.triggerConfig)
    if (input.actionType !== undefined) updates.action_type = input.actionType
    if (input.actionConfig !== undefined) updates.action_config = JSON.stringify(normalizedActionConfigForUpdate ?? input.actionConfig)
    if (input.enabled !== undefined) updates.enabled = input.enabled
    if (input.conditions !== undefined) updates.conditions = input.conditions ? JSON.stringify(input.conditions) : null
    if (input.actions !== undefined) updates.actions = normalizedActionsForUpdate ? JSON.stringify(normalizedActionsForUpdate) : null

    if (Object.keys(updates).length === 0) return this.getRule(ruleId)

    updates.updated_at = new Date().toISOString()

    const result = await this.db
      .updateTable('automation_rules')
      .set(updates as never)
      .where('id', '=', ruleId)
      .where('sheet_id', '=', sheetId)
      .returningAll()
      .execute()

    if (result.length === 0) return null

    const rule = this.mapRow(result[0])

    // Re-register with scheduler if trigger changed
    this.unregisterSchedule(ruleId)
    if (rule.enabled) this.registerSchedule(rule)

    return rule
  }

  /**
   * Delete an automation rule.
   * Returns true if deleted, false if not found.
   */
  async deleteRule(ruleId: string, sheetId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('automation_rules')
      .where('id', '=', ruleId)
      .where('sheet_id', '=', sheetId)
      .execute()

    const deleted = result.length > 0 && Number(result[0].numDeletedRows) > 0
    if (deleted) {
      this.unregisterSchedule(ruleId)
    }
    return deleted
  }

  /**
   * Enable or disable a rule.
   */
  async setRuleEnabled(ruleId: string, enabled: boolean): Promise<AutomationRule | null> {
    const result = await this.db
      .updateTable('automation_rules')
      .set({ enabled, updated_at: new Date().toISOString() } as never)
      .where('id', '=', ruleId)
      .returningAll()
      .execute()

    if (result.length === 0) return null

    const rule = this.mapRow(result[0])

    if (enabled) {
      this.registerSchedule(rule)
    } else {
      this.unregisterSchedule(ruleId)
    }

    return rule
  }

  // ── Schedule registration ───────────────────────────────────────────────

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
   * Load all enabled rules across all sheets and register scheduled ones.
   * Called on startup.
   */
  async loadAndRegisterAllScheduled(): Promise<void> {
    const rows = await this.db
      .selectFrom('automation_rules')
      .selectAll()
      .where('enabled', '=', true)
      .where('trigger_type', 'in', ['schedule.cron', 'schedule.interval'])
      .execute()

    for (const row of rows) {
      const rule = this.mapRow(row)
      this.scheduler.register(toExecutorRule(rule))
    }

    if (rows.length > 0) {
      logger.info(`Registered ${rows.length} scheduled automation rule(s) on startup`)
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
    const rule = await this.getRule(ruleId)
    if (!rule || !rule.enabled) {
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

  /**
   * Load enabled rules for a sheet (Kysely).
   */
  async loadEnabledRules(sheetId: string): Promise<AutomationRule[]> {
    const rows = await this.db
      .selectFrom('automation_rules')
      .selectAll()
      .where('sheet_id', '=', sheetId)
      .where('enabled', '=', true)
      .orderBy('created_at', 'asc')
      .execute()

    return rows.map((r) => this.mapRow(r))
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private mapRow(row: Record<string, unknown>): AutomationRule {
    return {
      id: row.id as string,
      sheet_id: row.sheet_id as string,
      name: (row.name as string) ?? null,
      trigger_type: row.trigger_type as string,
      trigger_config: (row.trigger_config as Record<string, unknown>) ?? {},
      action_type: row.action_type as string,
      action_config: (row.action_config as Record<string, unknown>) ?? {},
      enabled: row.enabled as boolean,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ''),
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? ''),
      created_by: (row.created_by as string) ?? null,
      conditions: (row.conditions as ConditionGroup) ?? null,
      actions: (row.actions as AutomationAction[]) ?? null,
    }
  }
}
