import { randomUUID } from 'crypto'
import type { Kysely } from 'kysely'
import type { EventBus } from '../integration/events/event-bus'
import { Logger } from '../core/logger'
import { matchesTrigger, TRIGGER_TYPE_BY_EVENT, type AutomationTriggerType } from './automation-triggers'
import type { ConditionGroup } from './automation-conditions'
import { AutomationExecutor, type AutomationRule as ExecutorRule, type AutomationExecution, type AutomationDeps } from './automation-executor'
import type { AutomationAction } from './automation-actions'
import type { AutomationTrigger } from './automation-triggers'
import {
  AutomationScheduler,
  type AutomationSchedulerLeaderOptions,
  type AutomationSchedulerRuntimeOptions,
} from './automation-scheduler'
import { RedisLeaderLock, type RedisLeaderLockClient } from './redis-leader-lock'
import { getRedisClient } from '../db/redis'
import { randomBytes } from 'crypto'
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

const VALID_ACTION_TYPES = new Set([
  'notify',
  'update_field',
  'update_record',
  'create_record',
  'send_webhook',
  'send_notification',
  'send_email',
  'send_dingtalk_group_message',
  'send_dingtalk_person_message',
  'lock_record',
])

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function validateSendEmailConfig(config: Record<string, unknown>): string | null {
  const recipients = normalizeStringList(config.recipients)
  const subjectTemplate = typeof config.subjectTemplate === 'string' ? config.subjectTemplate.trim() : ''
  const bodyTemplate = typeof config.bodyTemplate === 'string' ? config.bodyTemplate.trim() : ''
  if (!recipients.length) return 'send_email requires at least one recipient'
  if (!subjectTemplate) return 'send_email subjectTemplate is required'
  if (!bodyTemplate) return 'send_email bodyTemplate is required'
  return null
}

function validateSendEmailActionConfigs(
  actionType: string,
  actionConfig: Record<string, unknown>,
  actions: AutomationAction[] | null | undefined,
): string | null {
  if (actionType === 'send_email') {
    const error = validateSendEmailConfig(actionConfig)
    if (error) return error
  }
  for (const action of actions ?? []) {
    if (action.type !== 'send_email') continue
    const error = validateSendEmailConfig(action.config)
    if (error) return error
  }
  return null
}

function hasDingTalkGroupAction(actionType: unknown, actions: AutomationAction[] | null | undefined): boolean {
  return actionType === 'send_dingtalk_group_message'
    || (actions ?? []).some((action) => action.type === 'send_dingtalk_group_message')
}

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

/**
 * Resolve the scheduler leader-lock options based on environment flags and
 * Redis availability. Returns `null` when the feature flag is disabled or
 * Redis cannot be reached — the scheduler then behaves exactly as before
 * (every process runs its own timers).
 *
 * Feature flag: `ENABLE_SCHEDULER_LEADER_LOCK=true` (default false).
 */
export async function resolveAutomationSchedulerLeaderOptions(): Promise<AutomationSchedulerLeaderOptions | null> {
  if (process.env.ENABLE_SCHEDULER_LEADER_LOCK !== 'true') return null
  const redis = await getRedisClient()
  if (!redis) return null
  const client = redis as unknown as RedisLeaderLockClient
  const leaderLock = new RedisLeaderLock({ client })
  const ownerId = `scheduler:${process.pid}:${randomBytes(4).toString('hex')}`
  const ttlMs = Number(process.env.SCHEDULER_LEADER_LOCK_TTL_MS) > 0
    ? Number(process.env.SCHEDULER_LEADER_LOCK_TTL_MS)
    : 30_000
  return { leaderLock, ownerId, ttlMs }
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

  constructor(
    eventBus: EventBus,
    db: Kysely<Database>,
    queryFn: AutomationQueryFn,
    fetchFn?: typeof fetch,
    schedulerLeaderOptions: AutomationSchedulerLeaderOptions | null = null,
    schedulerRuntime: AutomationSchedulerRuntimeOptions = {},
    notificationService?: AutomationDeps['notificationService'],
  ) {
    this.eventBus = eventBus
    this.db = db
    this.queryFn = queryFn

    const deps: AutomationDeps = {
      eventBus,
      queryFn,
      fetchFn,
      notificationService,
    }
    this.executor = new AutomationExecutor(deps)
    this.logService = new AutomationLogService()
    this.scheduler = new AutomationScheduler(
      async (rule) => {
        await this.executeRule(rule, { _triggeredBy: 'schedule' })
      },
      schedulerLeaderOptions,
      schedulerRuntime,
    )
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
    if (!VALID_TRIGGER_TYPES.has(input.triggerType)) {
      throw new AutomationRuleValidationError(`Invalid trigger_type: ${input.triggerType}`)
    }
    if (!VALID_ACTION_TYPES.has(input.actionType)) {
      throw new AutomationRuleValidationError(`Invalid action_type: ${input.actionType}`)
    }
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
    const sendEmailValidationError = validateSendEmailActionConfigs(input.actionType, actionConfig, actions)
    if (sendEmailValidationError) throw new AutomationRuleValidationError(sendEmailValidationError)
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
    if (input.triggerType !== undefined && !VALID_TRIGGER_TYPES.has(input.triggerType)) {
      throw new AutomationRuleValidationError(`Invalid trigger_type: ${input.triggerType}`)
    }
    if (input.actionType !== undefined && !VALID_ACTION_TYPES.has(input.actionType)) {
      throw new AutomationRuleValidationError(`Invalid action_type: ${input.actionType}`)
    }
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
      const defaultGroupFailureAlert = !hasDingTalkGroupAction(existing.action_type, existing.actions ?? null)
        && hasDingTalkGroupAction(nextActionType, nextActions)
      const normalizedDingTalkInputs = normalizeDingTalkAutomationActionInputs(nextActionType, nextActionConfig, nextActions, {
        defaultGroupFailureAlert,
      })
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
      const sendEmailValidationError = validateSendEmailActionConfigs(
        nextActionType,
        normalizedNextActionConfig,
        normalizedNextActions,
      )
      if (sendEmailValidationError) throw new AutomationRuleValidationError(sendEmailValidationError)
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
   *
   * When a scheduler leader-lock is configured, we `await` the initial
   * election verdict before registering rules so non-leaders never create
   * duplicate timers between startup and the first `isLeader` decision.
   */
  async loadAndRegisterAllScheduled(): Promise<void> {
    await this.scheduler.ready

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

// ── Route helpers ────────────────────────────────────────────────────────

export type SerializedAutomationRule = {
  id: string
  sheetId: string
  name: string
  triggerType: string
  triggerConfig: Record<string, unknown>
  trigger: { type: string; config: Record<string, unknown> }
  conditions: ConditionGroup | undefined
  actions: AutomationAction[] | undefined
  actionType: string
  actionConfig: Record<string, unknown>
  enabled: boolean
  createdAt: string
  updatedAt: string
  createdBy: string | undefined
}

/**
 * Serialize a persisted automation rule for HTTP responses.
 *
 * Shape preserved verbatim from the legacy `univer-meta.ts` route.
 */
export function serializeAutomationRule(rule: AutomationRule): SerializedAutomationRule {
  const triggerConfig = rule.trigger_config ?? {}
  const actionConfig = rule.action_config ?? {}
  return {
    id: rule.id,
    sheetId: rule.sheet_id,
    name: rule.name ?? '',
    triggerType: rule.trigger_type,
    triggerConfig,
    trigger: {
      type: rule.trigger_type,
      config: triggerConfig,
    },
    conditions: rule.conditions ?? undefined,
    actions: rule.actions ?? undefined,
    actionType: rule.action_type,
    actionConfig,
    enabled: rule.enabled,
    createdAt: rule.created_at,
    updatedAt: rule.updated_at,
    createdBy: rule.created_by ?? undefined,
  }
}

/**
 * Clamp a DingTalk delivery `limit` query parameter to `[1, 200]`,
 * defaulting to 50 when the value is missing or non-numeric.
 */
export function parseDingTalkAutomationDeliveryLimit(value: unknown): number {
  const raw = typeof value === 'string' ? Number(value) : undefined
  return Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw as number), 1), 200) : 50
}

/**
 * Parse an optional delivery `recordId` query parameter.
 */
export function parseDingTalkAutomationDeliveryRecordId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Parse a `POST /sheets/:sheetId/automations` request body into a
 * `CreateRuleInput`. Throws `AutomationRuleValidationError` for invalid
 * trigger / action types.
 */
export function parseCreateRuleInput(
  body: Record<string, unknown> | undefined,
  createdBy: string | null,
): CreateRuleInput {
  const name = typeof body?.name === 'string' ? body.name : null
  const triggerType = typeof body?.triggerType === 'string' ? body.triggerType : ''
  const triggerConfig = body?.triggerConfig && typeof body.triggerConfig === 'object'
    ? body.triggerConfig as Record<string, unknown>
    : {}
  let actions: unknown[] | null = Array.isArray(body?.actions) ? body!.actions as unknown[] : null
  const firstAction = actions?.find(
    (item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item),
  )
  let actionType = typeof body?.actionType === 'string' ? body.actionType : ''
  let actionConfig: Record<string, unknown> = body?.actionConfig && typeof body.actionConfig === 'object'
    ? body.actionConfig as Record<string, unknown>
    : {}
  if (!actionType && typeof firstAction?.type === 'string') actionType = firstAction.type
  if (
    Object.keys(actionConfig).length === 0 &&
    firstAction?.config &&
    typeof firstAction.config === 'object' &&
    !Array.isArray(firstAction.config)
  ) {
    actionConfig = firstAction.config as Record<string, unknown>
  }
  const enabled = typeof body?.enabled === 'boolean' ? body.enabled : true

  if (!VALID_TRIGGER_TYPES.has(triggerType)) {
    throw new AutomationRuleValidationError(`Invalid trigger_type: ${triggerType}`)
  }
  if (!VALID_ACTION_TYPES.has(actionType)) {
    throw new AutomationRuleValidationError(`Invalid action_type: ${actionType}`)
  }

  const conditions = body?.conditions && typeof body.conditions === 'object'
    ? body.conditions as ConditionGroup
    : null

  return {
    name,
    triggerType,
    triggerConfig,
    actionType,
    actionConfig,
    enabled,
    createdBy,
    conditions,
    actions: actions as AutomationAction[] | null,
  }
}

/**
 * Parse a `PATCH /sheets/:sheetId/automations/:ruleId` request body into an
 * `UpdateRuleInput`. Returns `null` when the body has no recognised
 * fields (route should respond with `400 VALIDATION_ERROR: No fields to
 * update`). Throws `AutomationRuleValidationError` for invalid trigger /
 * action types.
 */
export function parseUpdateRuleInput(body: Record<string, unknown> | undefined): UpdateRuleInput | null {
  const input: UpdateRuleInput = {}
  let touched = false

  if (typeof body?.name === 'string') {
    input.name = body.name
    touched = true
  }
  if (typeof body?.triggerType === 'string') {
    if (!VALID_TRIGGER_TYPES.has(body.triggerType)) {
      throw new AutomationRuleValidationError(`Invalid trigger_type: ${body.triggerType}`)
    }
    input.triggerType = body.triggerType
    touched = true
  }
  if (body?.triggerConfig && typeof body.triggerConfig === 'object') {
    input.triggerConfig = body.triggerConfig as Record<string, unknown>
    touched = true
  }
  if (typeof body?.actionType === 'string') {
    if (!VALID_ACTION_TYPES.has(body.actionType)) {
      throw new AutomationRuleValidationError(`Invalid action_type: ${body.actionType}`)
    }
    input.actionType = body.actionType
    touched = true
  }
  if (body?.actionConfig && typeof body.actionConfig === 'object') {
    input.actionConfig = body.actionConfig as Record<string, unknown>
    touched = true
  }
  if (typeof body?.enabled === 'boolean') {
    input.enabled = body.enabled
    touched = true
  }
  if (body?.conditions !== undefined) {
    input.conditions = body.conditions ? (body.conditions as ConditionGroup) : null
    touched = true
  }
  if (body?.actions !== undefined) {
    input.actions = Array.isArray(body.actions) ? (body.actions as AutomationAction[]) : null
    touched = true
  }

  return touched ? input : null
}

/**
 * Run the route-side DingTalk pre-flight: normalize + config + link
 * validation. Returns a copy of `input` with normalized `actionConfig` /
 * `actions` so the rule is persisted in canonical form. Throws
 * `AutomationRuleValidationError` on any validation failure.
 *
 * This keeps the route as the link-validation boundary (the persistence
 * layer must not see a request that references a cross-sheet view).
 */
export async function preflightDingTalkAutomationCreate(
  queryFn: AutomationQueryFn,
  sheetId: string,
  input: CreateRuleInput,
): Promise<CreateRuleInput> {
  const normalized = normalizeDingTalkAutomationActionInputs(
    input.actionType,
    input.actionConfig ?? {},
    input.actions ?? null,
  )
  const actionConfig = normalized.actionConfig && typeof normalized.actionConfig === 'object'
    ? normalized.actionConfig as Record<string, unknown>
    : input.actionConfig ?? {}
  const actions = Array.isArray(normalized.actions)
    ? normalized.actions as AutomationAction[]
    : input.actions ?? null

  const configErr = validateDingTalkAutomationActionConfigs(input.actionType, actionConfig, actions)
  if (configErr) throw new AutomationRuleValidationError(configErr)

  const linkErr = await validateDingTalkAutomationLinks(
    queryFn,
    sheetId,
    input.actionType,
    actionConfig,
    actions,
  )
  if (linkErr) throw new AutomationRuleValidationError(linkErr)

  return { ...input, actionConfig, actions }
}

/**
 * PATCH-time DingTalk pre-flight. Only runs when the update touches
 * `actionType`, `actionConfig`, or `actions` — otherwise no link validation
 * is needed. When triggered, falls back to the existing rule's values for
 * fields the request did not provide. Returns a copy of `input` with
 * normalized values where they were provided. Returns `null` when the
 * existing rule is missing or belongs to a different sheet.
 */
export async function preflightDingTalkAutomationUpdate(
  queryFn: AutomationQueryFn,
  sheetId: string,
  ruleId: string,
  input: UpdateRuleInput,
  service: Pick<AutomationService, 'getRule'>,
): Promise<UpdateRuleInput | null> {
  const touchesAction =
    input.actionType !== undefined ||
    input.actionConfig !== undefined ||
    input.actions !== undefined
  if (!touchesAction) return input

  const existing = await service.getRule(ruleId)
  if (!existing || existing.sheet_id !== sheetId) return null

  const nextActionType = input.actionType ?? existing.action_type
  const nextActionConfig = input.actionConfig ?? existing.action_config
  const nextActions: AutomationAction[] | null = input.actions !== undefined ? input.actions : existing.actions ?? null
  const defaultGroupFailureAlert = !hasDingTalkGroupAction(existing.action_type, existing.actions ?? null)
    && hasDingTalkGroupAction(nextActionType, nextActions)

  const normalized = normalizeDingTalkAutomationActionInputs(nextActionType, nextActionConfig, nextActions, {
    defaultGroupFailureAlert,
  })
  const normalizedActionConfig = normalized.actionConfig && typeof normalized.actionConfig === 'object'
    ? normalized.actionConfig as Record<string, unknown>
    : nextActionConfig
  const normalizedActions = Array.isArray(normalized.actions)
    ? normalized.actions as AutomationAction[]
    : nextActions

  const configErr = validateDingTalkAutomationActionConfigs(
    nextActionType,
    normalizedActionConfig,
    normalizedActions,
  )
  if (configErr) throw new AutomationRuleValidationError(configErr)

  const linkErr = await validateDingTalkAutomationLinks(
    queryFn,
    sheetId,
    nextActionType,
    normalizedActionConfig,
    normalizedActions,
  )
  if (linkErr) throw new AutomationRuleValidationError(linkErr)

  const out: UpdateRuleInput = { ...input }
  if (input.actionConfig !== undefined) out.actionConfig = normalizedActionConfig
  if (input.actions !== undefined) out.actions = Array.isArray(input.actions) ? normalizedActions : null
  return out
}
