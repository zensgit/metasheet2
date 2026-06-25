import { randomUUID } from 'crypto'
import type { Kysely } from 'kysely'
import type { EventBus } from '../integration/events/event-bus'
import { Logger } from '../core/logger'
import { matchesTrigger, TRIGGER_TYPE_BY_EVENT, type AutomationTriggerType } from './automation-triggers'
import { ensureRecordNotLocked } from './record-lock'
import { publishMultitableSheetRealtime } from './realtime-publish'
import {
  ConditionGroupValidationError,
  normalizeConditionGroupInput,
  validateConditionGroupAgainstFields,
  type AutomationConditionField,
  type ConditionGroup,
} from './automation-conditions'
import { AutomationExecutor, type AutomationRule as ExecutorRule, type AutomationExecution, type AutomationDeps, type ExecutionContext, type ActionJobLifecycle, type AutomationStepResult } from './automation-executor'
import { ALL_ACTION_TYPES, type AutomationAction } from './automation-actions'
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
import { AutomationJobService } from './automation-job-service'
import { AutomationSuspensionService, computeActionFingerprint } from './automation-suspension-service'
import { AutomationApprovalBridgeService, type AutomationApprovalBridgeRow } from './automation-approval-bridge-service'
import type { ApprovalCompletionEventV1 } from '../services/ApprovalCompletionEvent'
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
  'form.submitted',
])

const LEGACY_ACTION_TYPES = [
  'notify',
  'update_field',
] as const

const VALID_ACTION_TYPES = new Set<string>([
  ...LEGACY_ACTION_TYPES,
  ...ALL_ACTION_TYPES,
])
const CANONICAL_ACTION_TYPES = new Set<string>(ALL_ACTION_TYPES)
const SAFE_BRANCH_KEY = /^[A-Za-z0-9_-]{1,64}$/
const PARALLEL_BRANCH_ACTION_TYPES = new Set(['update_record', 'send_notification'])
const MAX_PARALLEL_BRANCHES = 10
const MAX_PARALLEL_BRANCH_ACTIONS = 20

// A6-1 opt-in (#2130 runtime): a rule may persist one C1 WorkflowJob row per action.
// `null`/`'legacy'` both mean the legacy fire-and-forget path (no job rows); only
// `'workflow_job_v1'` switches on persistence (executor gate: `persistJobs === 'workflow_job_v1'`).
const VALID_EXECUTION_MODES = new Set(['legacy', 'workflow_job_v1'])

/**
 * Validate the A6-1 `execution_mode` opt-in flag. Lives in the service (not the route
 * parser) because `createRule`/`updateRule` are the unbypassable persistence boundary —
 * a direct service caller must not be able to write a junk mode. `undefined`/`null` →
 * `null` (off); a recognized string passes through; anything else is rejected so the
 * caller never silently falls back to a default. Throws `AutomationRuleValidationError`.
 */
function normalizeExecutionMode(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && VALID_EXECUTION_MODES.has(value)) return value
  throw new AutomationRuleValidationError(`Invalid execution_mode: ${String(value)}`)
}

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

function validateStartApprovalConfig(config: Record<string, unknown>, path: string): string | null {
  const templateId = typeof config.templateId === 'string' ? config.templateId.trim() : ''
  if (!templateId) return `${path}.templateId is required`
  const mapping = isRecord(config.formDataMapping) ? config.formDataMapping : null
  if (!mapping || Object.keys(mapping).length === 0) return `${path}.formDataMapping is required`
  for (const [key, value] of Object.entries(mapping)) {
    if (!key.trim() || typeof value !== 'string' || value.trim().length === 0) {
      return `${path}.formDataMapping entries must be non-empty strings`
    }
  }
  if (config.requester !== undefined) {
    if (!isRecord(config.requester)) return `${path}.requester must be an object`
    const mode = config.requester.mode
    if (mode !== undefined && mode !== 'trigger_actor' && mode !== 'rule_creator') {
      return `${path}.requester.mode must be trigger_actor or rule_creator`
    }
  }
  // W7-1 approval-result backwrite: a DECLARED, FIXED outcome→field mapping. The admin picks WHICH
  // source field receives `outcome` / `approver` / `completedAt` — NOT a free template expression — so
  // the write path stays values-constrained (values come from the completion event, never user strings).
  // Optional; ≥1 field if present. The mapping is part of the action config, so it is covered by the
  // resume-time action-fingerprint drift guard (cannot be swapped after the approval suspends).
  if (config.resultWriteback !== undefined) {
    if (!isRecord(config.resultWriteback)) return `${path}.resultWriteback must be an object`
    const fields = ['statusField', 'approverField', 'completedAtField'] as const
    let mapped = 0
    for (const field of fields) {
      const value = config.resultWriteback[field]
      if (value === undefined) continue
      if (typeof value !== 'string' || value.trim().length === 0) return `${path}.resultWriteback.${field} must be a non-empty string`
      mapped += 1
    }
    if (mapped === 0) return `${path}.resultWriteback must map at least one of statusField/approverField/completedAtField`
  }
  return null
}

function validateStartApprovalActionConfigs(
  actionType: string,
  actionConfig: Record<string, unknown>,
  actions: AutomationAction[] | null | undefined,
): string | null {
  if (actionType === 'start_approval') {
    const error = validateStartApprovalConfig(actionConfig, 'actionConfig')
    if (error) return error
  }
  for (const [index, action] of (actions ?? []).entries()) {
    if (action.type !== 'start_approval') continue
    const error = validateStartApprovalConfig(action.config, `actions[${index}].config`)
    if (error) return error
  }
  return null
}

function parseConditionGroupInput(value: unknown): ConditionGroup {
  try {
    return normalizeConditionGroupInput(value)
  } catch (error) {
    if (error instanceof ConditionGroupValidationError) {
      throw new AutomationRuleValidationError(error.message)
    }
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * ②b cross-base write SHAPE validation at rule-save time (fail-closed before any run). This validates
 * ADDRESSING SHAPE only — the actual base-write AUTHORITY + claim==truth are re-checked per run in the
 * executor write-gate (`evaluateCrossBaseWrite`). When a record-mutating action declares a non-empty
 * `targetBaseId` (opting into cross-base):
 *  - `update_record` MUST also carry a non-empty `targetSheetId` AND `targetRecordId` (the trigger
 *    record is not in the target base, so the update has no record to address otherwise — §2.4).
 *  - `create_record` needs nothing more (its `sheetId` is the target sheet).
 * A malformed cross-base config → rejected at save. (Same-base actions — no `targetBaseId` — pass.)
 */
function validateCrossBaseWriteConfig(config: Record<string, unknown>, actionType: string, path: string): string | null {
  if (actionType !== 'update_record') return null
  const targetBaseId = typeof config.targetBaseId === 'string' ? config.targetBaseId.trim() : ''
  if (!targetBaseId) return null // same-base (or no opt-in) — nothing to validate
  const targetSheetId = typeof config.targetSheetId === 'string' ? config.targetSheetId.trim() : ''
  const targetRecordId = typeof config.targetRecordId === 'string' ? config.targetRecordId.trim() : ''
  if (!targetSheetId || !targetRecordId) {
    return `${path}: cross-base update_record requires targetSheetId and targetRecordId when targetBaseId is set`
  }
  return null
}

function validateCrossBaseWriteActionConfigs(
  actionType: string,
  actionConfig: Record<string, unknown>,
  actions: AutomationAction[] | null | undefined,
): string | null {
  const topLevel = validateCrossBaseWriteConfig(actionConfig, actionType, 'actionConfig')
  if (topLevel) return topLevel
  for (const [index, action] of (actions ?? []).entries()) {
    const error = validateCrossBaseWriteConfig(action.config, action.type, `actions[${index}].config`)
    if (error) return error
  }
  return null
}

function validateActionObject(action: unknown, path: string): AutomationAction {
  if (!isRecord(action)) {
    throw new AutomationRuleValidationError(`${path} must be an object`)
  }
  if (typeof action.type !== 'string' || !CANONICAL_ACTION_TYPES.has(action.type)) {
    throw new AutomationRuleValidationError(`${path}.type is invalid`)
  }
  const config = isRecord(action.config) ? action.config : {}
  return { type: action.type as AutomationAction['type'], config }
}

function readBranchActions(value: unknown, path: string): AutomationAction[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new AutomationRuleValidationError(`${path} must be an array`)
  }
  return value.map((action, index) => validateActionObject(action, `${path}[${index}]`))
}

function validateConditionBranchConfig(config: unknown, path: string): AutomationAction[] {
  if (!isRecord(config)) {
    throw new AutomationRuleValidationError(`${path} must be an object`)
  }
  if (!Array.isArray(config.branches) || config.branches.length === 0) {
    throw new AutomationRuleValidationError(`${path}.branches must be a non-empty array`)
  }

  const seen = new Set<string>()
  const nestedActions: AutomationAction[] = []
  for (const [index, branch] of config.branches.entries()) {
    const branchPath = `${path}.branches[${index}]`
    if (!isRecord(branch)) {
      throw new AutomationRuleValidationError(`${branchPath} must be an object`)
    }
    if (typeof branch.key !== 'string' || !SAFE_BRANCH_KEY.test(branch.key)) {
      throw new AutomationRuleValidationError(`${branchPath}.key must be a safe non-empty string`)
    }
    if (seen.has(branch.key)) {
      throw new AutomationRuleValidationError(`${branchPath}.key must be unique`)
    }
    seen.add(branch.key)
    parseConditionGroupInput(branch.conditions)
    const actions = readBranchActions(branch.actions, `${branchPath}.actions`)
    for (const nested of actions) {
      if (nested.type === 'condition_branch') {
        throw new AutomationRuleValidationError(`${branchPath}.actions cannot contain nested condition_branch in A6-3-1`)
      }
      if (nested.type === 'parallel_branch') {
        throw new AutomationRuleValidationError(`${branchPath}.actions cannot contain parallel_branch until a later nested-DAG slice`)
      }
      // A6-3-3: branch-local wait_for_callback is allowed — condition_branch already forces
      // workflow_job_v1 at the rule level, so the wait is only reachable in an opted-in rule.
      if (nested.type === 'start_approval') {
        throw new AutomationRuleValidationError(`${branchPath}.actions cannot contain start_approval (branch-local start_approval is not yet supported)`)
      }
    }
    nestedActions.push(...actions)
  }

  if (config.defaultBranch !== undefined && config.defaultBranch !== null) {
    const defaultPath = `${path}.defaultBranch`
    if (!isRecord(config.defaultBranch)) {
      throw new AutomationRuleValidationError(`${defaultPath} must be an object`)
    }
    if (typeof config.defaultBranch.key !== 'string' || !SAFE_BRANCH_KEY.test(config.defaultBranch.key)) {
      throw new AutomationRuleValidationError(`${defaultPath}.key must be a safe non-empty string`)
    }
    if (seen.has(config.defaultBranch.key)) {
      throw new AutomationRuleValidationError(`${defaultPath}.key must be unique`)
    }
    const actions = readBranchActions(config.defaultBranch.actions, `${defaultPath}.actions`)
    for (const nested of actions) {
      if (nested.type === 'condition_branch') {
        throw new AutomationRuleValidationError(`${defaultPath}.actions cannot contain nested condition_branch in A6-3-1`)
      }
      if (nested.type === 'parallel_branch') {
        throw new AutomationRuleValidationError(`${defaultPath}.actions cannot contain parallel_branch until a later nested-DAG slice`)
      }
      // A6-3-3: branch-local wait_for_callback is allowed (see branches loop above).
      if (nested.type === 'start_approval') {
        throw new AutomationRuleValidationError(`${defaultPath}.actions cannot contain start_approval (branch-local start_approval is not yet supported)`)
      }
    }
    nestedActions.push(...actions)
  }

  return nestedActions
}

function validateParallelBranchConfig(config: unknown, path: string): AutomationAction[] {
  if (!isRecord(config)) {
    throw new AutomationRuleValidationError(`${path} must be an object`)
  }
  if (config.joinMode !== 'all') {
    throw new AutomationRuleValidationError(`${path}.joinMode must be all`)
  }
  if (!Array.isArray(config.branches) || config.branches.length === 0) {
    throw new AutomationRuleValidationError(`${path}.branches must be a non-empty array`)
  }
  if (config.branches.length > MAX_PARALLEL_BRANCHES) {
    throw new AutomationRuleValidationError(`${path}.branches exceeds max ${MAX_PARALLEL_BRANCHES}`)
  }

  const seen = new Set<string>()
  const nestedActions: AutomationAction[] = []
  let totalActions = 0
  for (const [index, branch] of config.branches.entries()) {
    const branchPath = `${path}.branches[${index}]`
    if (!isRecord(branch)) {
      throw new AutomationRuleValidationError(`${branchPath} must be an object`)
    }
    if (typeof branch.key !== 'string' || !SAFE_BRANCH_KEY.test(branch.key)) {
      throw new AutomationRuleValidationError(`${branchPath}.key must be a safe non-empty string`)
    }
    if (seen.has(branch.key)) {
      throw new AutomationRuleValidationError(`${branchPath}.key must be unique`)
    }
    seen.add(branch.key)
    if (branch.label !== undefined && typeof branch.label !== 'string') {
      throw new AutomationRuleValidationError(`${branchPath}.label must be a string`)
    }

    const actions = readBranchActions(branch.actions, `${branchPath}.actions`)
    if (actions.length === 0) {
      throw new AutomationRuleValidationError(`${branchPath}.actions must be a non-empty array`)
    }
    totalActions += actions.length
    if (totalActions > MAX_PARALLEL_BRANCH_ACTIONS) {
      throw new AutomationRuleValidationError(`${path}.branches total actions exceeds max ${MAX_PARALLEL_BRANCH_ACTIONS}`)
    }
    for (const nested of actions) {
      if (!PARALLEL_BRANCH_ACTION_TYPES.has(nested.type)) {
        throw new AutomationRuleValidationError(`${branchPath}.actions cannot contain ${nested.type} in A6-3-4`)
      }
    }
    nestedActions.push(...actions)
  }

  return nestedActions
}

function collectNestedAutomationActions(
  actionType: string,
  actionConfig: Record<string, unknown>,
  actions: AutomationAction[] | null | undefined,
  executionMode: string | null,
): AutomationAction[] {
  const collected: AutomationAction[] = []
  const requiresWorkflowJobMode = actionType === 'condition_branch'
    || actionType === 'start_approval'
    || actionType === 'parallel_branch'

  if (actionType === 'condition_branch') {
    collected.push(...validateConditionBranchConfig(actionConfig, 'actionConfig'))
  }
  if (actionType === 'parallel_branch') {
    collected.push(...validateParallelBranchConfig(actionConfig, 'actionConfig'))
  }

  for (const [index, action] of (actions ?? []).entries()) {
    const current = validateActionObject(action, `actions[${index}]`)
    if (current.type === 'condition_branch') {
      collected.push(...validateConditionBranchConfig(current.config, `actions[${index}].config`))
    }
    if (current.type === 'parallel_branch') {
      collected.push(...validateParallelBranchConfig(current.config, `actions[${index}].config`))
    }
    collected.push(current)
  }

  const hasWorkflowAction = requiresWorkflowJobMode
    || collected.some((action) => (
      action.type === 'condition_branch'
      || action.type === 'start_approval'
      || action.type === 'parallel_branch'
    ))
  if (hasWorkflowAction && executionMode !== 'workflow_job_v1') {
    throw new AutomationRuleValidationError('condition_branch/start_approval/parallel_branch requires execution_mode workflow_job_v1')
  }

  return collected
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
  // A6-1 opt-in (nullable; NULL/'legacy' = no job rows, 'workflow_job_v1' = persist jobs)
  execution_mode?: string | null
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

function serializeAutomationConditionFieldRows(rows: unknown[]): AutomationConditionField[] {
  return rows
    .map((row) => {
      if (!row || typeof row !== 'object') return null
      const record = row as Record<string, unknown>
      const id = typeof record.id === 'string' ? record.id : ''
      const type = typeof record.type === 'string' ? record.type : ''
      const property = Object.prototype.hasOwnProperty.call(record, 'property') ? record.property : undefined
      return id && type ? { id, type, ...(property !== undefined ? { property } : {}) } : null
    })
    .filter((field): field is AutomationConditionField => !!field)
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
  // A6-1 opt-in; validated by normalizeExecutionMode in createRule (not here).
  executionMode?: string | null
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
  // A6-1 opt-in; validated by normalizeExecutionMode in updateRule (not here).
  executionMode?: string | null
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
    executionMode: rule.execution_mode ?? undefined,
  }
}

/**
 * A5 retry fail-closed guard (A4-D7): the stored trigger_event must be a NON-EMPTY
 * plain object. Reject null/undefined, arrays, and `{}` — otherwise the executor's
 * `recordId ?? '' / recordData ?? {}` fallback would silently retry with empty
 * context (e.g. send_webhook firing with no record, update_record on an empty id).
 * `recordId` is NOT required: a scheduler trigger is legitimately `{ _triggeredBy:
 * 'schedule' }` (record-less but valid).
 */
function isRetryableStoredTriggerEvent(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).length > 0
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
  private jobService: AutomationJobService
  private suspensionService: AutomationSuspensionService
  private approvalBridgeService: AutomationApprovalBridgeService
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
    this.jobService = new AutomationJobService()
    this.suspensionService = new AutomationSuspensionService(this.jobService)
    this.approvalBridgeService = new AutomationApprovalBridgeService(this.jobService)
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

  get jobs(): AutomationJobService {
    return this.jobService
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
      'multitable.form.submitted',
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

    for (const eventType of ['approval.approved', 'approval.rejected', 'approval.revoked', 'approval.cancelled']) {
      const id = this.eventBus.subscribe<ApprovalCompletionEventV1>(
        eventType,
        (payload) => {
          this.handleApprovalCompletionEvent(payload).catch((err) => {
            logger.error(`Automation approval bridge handler error for ${eventType}`, err instanceof Error ? err : undefined)
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
    const executionMode = normalizeExecutionMode(input.executionMode)
    const actionsForValidation = collectNestedAutomationActions(input.actionType, actionConfig, actions, executionMode)
    const actionConfigValidationError = validateDingTalkAutomationActionConfigs(input.actionType, actionConfig, actionsForValidation)
    if (actionConfigValidationError) throw new AutomationRuleValidationError(actionConfigValidationError)
    const sendEmailValidationError = validateSendEmailActionConfigs(input.actionType, actionConfig, actionsForValidation)
    if (sendEmailValidationError) throw new AutomationRuleValidationError(sendEmailValidationError)
    const startApprovalValidationError = validateStartApprovalActionConfigs(input.actionType, actionConfig, actionsForValidation)
    if (startApprovalValidationError) throw new AutomationRuleValidationError(startApprovalValidationError)
    const crossBaseWriteValidationError = validateCrossBaseWriteActionConfigs(input.actionType, actionConfig, actionsForValidation)
    if (crossBaseWriteValidationError) throw new AutomationRuleValidationError(crossBaseWriteValidationError)
    const linkValidationError = await validateDingTalkAutomationLinks(
      this.queryFn,
      sheetId,
      input.actionType,
      actionConfig,
      actionsForValidation,
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
      execution_mode: executionMode,
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
      execution_mode: executionMode,
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
    const shouldValidateActions = input.actionType !== undefined
      || input.actionConfig !== undefined
      || input.actions !== undefined
      || input.executionMode !== undefined
    let normalizedActionConfigForUpdate: Record<string, unknown> | undefined
    let normalizedActionsForUpdate: AutomationAction[] | null | undefined
    let normalizedExecutionModeForUpdate: string | null | undefined

    if (shouldValidateActions) {
      const existing = await this.getRule(ruleId)
      if (!existing || existing.sheet_id !== sheetId) return null

      const nextActionType = input.actionType ?? existing.action_type
      const nextActionConfig = input.actionConfig ?? existing.action_config
      const nextActions = input.actions !== undefined ? input.actions : existing.actions ?? null
      const nextExecutionMode = input.executionMode !== undefined
        ? normalizeExecutionMode(input.executionMode)
        : existing.execution_mode ?? null
      const normalizedDingTalkInputs = normalizeDingTalkAutomationActionInputs(nextActionType, nextActionConfig, nextActions)
      const normalizedNextActionConfig = normalizedDingTalkInputs.actionConfig && typeof normalizedDingTalkInputs.actionConfig === 'object'
        ? normalizedDingTalkInputs.actionConfig as Record<string, unknown>
        : nextActionConfig
      const normalizedNextActions = Array.isArray(normalizedDingTalkInputs.actions)
        ? normalizedDingTalkInputs.actions as AutomationAction[]
        : nextActions
      const actionsForValidation = collectNestedAutomationActions(
        nextActionType,
        normalizedNextActionConfig,
        normalizedNextActions,
        nextExecutionMode,
      )
      const actionConfigValidationError = validateDingTalkAutomationActionConfigs(
        nextActionType,
        normalizedNextActionConfig,
        actionsForValidation,
      )
      if (actionConfigValidationError) throw new AutomationRuleValidationError(actionConfigValidationError)
      const sendEmailValidationError = validateSendEmailActionConfigs(
        nextActionType,
        normalizedNextActionConfig,
        actionsForValidation,
      )
      if (sendEmailValidationError) throw new AutomationRuleValidationError(sendEmailValidationError)
      const startApprovalValidationError = validateStartApprovalActionConfigs(
        nextActionType,
        normalizedNextActionConfig,
        actionsForValidation,
      )
      if (startApprovalValidationError) throw new AutomationRuleValidationError(startApprovalValidationError)
      const crossBaseWriteValidationError = validateCrossBaseWriteActionConfigs(
        nextActionType,
        normalizedNextActionConfig,
        actionsForValidation,
      )
      if (crossBaseWriteValidationError) throw new AutomationRuleValidationError(crossBaseWriteValidationError)
      const linkValidationError = await validateDingTalkAutomationLinks(
        this.queryFn,
        sheetId,
        nextActionType,
        normalizedNextActionConfig,
        actionsForValidation,
      )
      if (linkValidationError) throw new AutomationRuleValidationError(linkValidationError)

      if (input.actionConfig !== undefined) normalizedActionConfigForUpdate = normalizedNextActionConfig
      if (input.actions !== undefined) normalizedActionsForUpdate = Array.isArray(input.actions) ? normalizedNextActions : null
      if (input.executionMode !== undefined) normalizedExecutionModeForUpdate = nextExecutionMode
    }

    if (input.name !== undefined) updates.name = input.name
    if (input.triggerType !== undefined) updates.trigger_type = input.triggerType
    if (input.triggerConfig !== undefined) updates.trigger_config = JSON.stringify(input.triggerConfig)
    if (input.actionType !== undefined) updates.action_type = input.actionType
    if (input.actionConfig !== undefined) updates.action_config = JSON.stringify(normalizedActionConfigForUpdate ?? input.actionConfig)
    if (input.enabled !== undefined) updates.enabled = input.enabled
    if (input.conditions !== undefined) updates.conditions = input.conditions ? JSON.stringify(input.conditions) : null
    if (input.actions !== undefined) updates.actions = normalizedActionsForUpdate ? JSON.stringify(normalizedActionsForUpdate) : null
    if (input.executionMode !== undefined) updates.execution_mode = normalizedExecutionModeForUpdate ?? normalizeExecutionMode(input.executionMode)

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
  async executeRule(
    rule: ExecutorRule,
    triggerEvent: unknown,
    retryMeta?: { rerunOfExecutionId: string; initiatedBy: string; rootExecutionId?: string },
  ): Promise<AutomationExecution> {
    const persistJobs = rule.executionMode === 'workflow_job_v1'
    // A6-1: ONLY opted-in rules ('workflow_job_v1') get a per-action job lifecycle. Legacy rules
    // pass no factory → executor writes zero job rows (opt-out path is byte-identical to today).
    // This is the single place the path is chosen, so a retry of an opt-in rule also writes jobs.
    const jobLifecycleFactory = persistJobs
      ? (executionId: string) => this.buildJobLifecycle(executionId, rule, triggerEvent, retryMeta?.rootExecutionId)
      : undefined
    const execution = await this.executor.execute(rule, triggerEvent, jobLifecycleFactory)
    if (retryMeta) {
      // A5: stamp retry provenance onto the NEW execution before persistence.
      execution.rerunOfExecutionId = retryMeta.rerunOfExecutionId
      execution.initiatedBy = retryMeta.initiatedBy
    }
    try {
      if (persistJobs) {
        await this.logService.updateRecordedExecution(execution)
      } else {
        await this.logService.record(execution)
      }
    } catch (err) {
      logger.error('Automation execution log persistence failed', err instanceof Error ? err : undefined)
    }
    return execution
  }

  private buildJobLifecycle(
    executionId: string,
    rule: ExecutorRule,
    triggerEvent: unknown,
    rootExecutionId?: string,
  ): ActionJobLifecycle {
    return {
      onExecutionStarted: (execution: AutomationExecution) => this.logService.record(execution),
      ...this.jobService.lifecycleFor(executionId, { id: rule.id, sheetId: rule.sheetId }),
      // A6-2: a wait_for_callback step persists the suspension + suspended job, then the executor stops.
      onSuspend: (stepIndex: number, action: AutomationAction): Promise<void> =>
        this.suspensionService
          .create({
            executionId,
            rule: { id: rule.id, sheetId: rule.sheetId, actions: rule.actions },
            recordId: ((triggerEvent as Record<string, unknown>)?.recordId as string) ?? '',
            triggerEvent,
            stepIndex,
            action,
          })
          .then(() => undefined),
      // A6-3-3: a branch-local wait_for_callback persists the branch suspension (with cursor)
      // + a suspended branch-child job, then the executor stops; resume continues the branch tail.
      onSuspendBranch: (cursor, action: AutomationAction): Promise<void> =>
        this.suspensionService
          .createBranchLocal({
            executionId,
            rule: { id: rule.id, sheetId: rule.sheetId, actions: rule.actions },
            recordId: ((triggerEvent as Record<string, unknown>)?.recordId as string) ?? '',
            triggerEvent,
            cursor,
            action,
          })
          .then(() => undefined),
      // W6-1: create one approval, then either suspend pending completion or continue immediately
      // if the approval auto-completed during createApproval().
      onStartApproval: async (stepIndex: number, action: AutomationAction, context: ExecutionContext) => {
        const result = await this.approvalBridgeService.startApproval({
          execution: { id: executionId, rootExecutionId },
          rule: { id: rule.id, sheetId: rule.sheetId, actions: rule.actions, createdBy: rule.createdBy },
          context,
          stepIndex,
          action,
        })
        if (result.suspended) return { suspended: true }
        return { suspended: false, result: result.result }
      },
    }
  }

  /**
   * A5 — whole-execution retry. Re-runs a failed/skipped execution using the
   * CURRENT enabled rule (live credentials) + the original STORED trigger_event,
   * producing a NEW execution linked by `rerun_of_execution_id`. The original run
   * is immutable. Returns a discriminated result (mirrors `requireRecordReadable`)
   * so the route maps precise status codes (A4 design-lock #2039, D1/D2/D7).
   *
   * NOTE (A4-D1 / known limitation): the stored trigger_event is REDACTED — A1
   * scrubs secret-shaped values (incl. inside the record `data` map) before
   * persist. Retry credentials come from the current rule, never the snapshot;
   * but a record field that was secret-shaped will replay as `<redacted>` into
   * conditions/actions. Documented in the A5 verification doc; raw-secret storage
   * was explicitly rejected.
   */
  async retryExecution(
    executionId: string,
    initiatedBy: string,
  ): Promise<{ execution: AutomationExecution } | { status: number; code: string; message: string }> {
    const original = await this.logService.getById(executionId)
    if (!original) {
      return { status: 404, code: 'NOT_FOUND', message: `Execution ${executionId} not found` }
    }
    if (original.status !== 'failed' && original.status !== 'skipped') {
      return {
        status: 409,
        code: 'NOT_RETRYABLE',
        message: `Only failed/skipped executions can be retried (got ${original.status})`,
      }
    }
    if (!isRetryableStoredTriggerEvent(original.triggerEvent)) {
      // Fail closed (A4-D7): null/undefined, array, or empty `{}` cannot rebuild context.
      return { status: 409, code: 'MISSING_TRIGGER_EVENT', message: 'Original execution has no usable stored trigger event to retry' }
    }
    const lineageIds = await this.collectExecutionLineageIds(original)
    const rootExecutionId = lineageIds.at(-1) ?? original.id
    if (await this.approvalBridgeService.hasCreatedApprovalForAnyExecution(lineageIds)) {
      return {
        status: 409,
        code: 'START_APPROVAL_ALREADY_CREATED',
        message: 'Executions that already created an approval cannot be whole-execution retried in W6-1',
      }
    }
    const rule = await this.getRule(original.ruleId)
    if (!rule || !rule.enabled) {
      return { status: 409, code: 'RULE_MISSING_OR_DISABLED', message: `Rule ${original.ruleId} is missing or disabled; cannot retry` }
    }
    const execRule = toExecutorRule(rule)
    const execution = await this.executeRule(execRule, original.triggerEvent, {
      rerunOfExecutionId: original.id,
      initiatedBy,
      rootExecutionId,
    })
    return { execution }
  }

  private async collectExecutionLineageIds(execution: AutomationExecution): Promise<string[]> {
    const ids: string[] = []
    const seen = new Set<string>()
    let current: AutomationExecution | null = execution
    for (let depth = 0; current && depth < 16; depth++) {
      if (seen.has(current.id)) break
      seen.add(current.id)
      ids.push(current.id)
      const parentId = current.rerunOfExecutionId
      if (!parentId || seen.has(parentId)) break
      current = await this.logService.getById(parentId)
    }
    return ids
  }

  /**
   * A6-2 — resume a suspended execution (admin-gated). Mirrors {@link retryExecution}'s
   * discriminated result so the route maps precise status codes. Re-derives context from the
   * CURRENT rule + a re-fetched record + the stored (redacted) trigger event (D4); guards
   * rule-drift via the action fingerprint (D4b); claims the token single-use (D8); then
   * continues the tail from the step AFTER the wait. Validation failures (404/409) do NOT
   * consume the token — the claim is the last gate before continuing.
   */
  async resumeExecution(
    resumeToken: string,
    initiatedBy: string,
  ): Promise<{ execution: AutomationExecution } | { status: number; code: string; message: string }> {
    const suspension = await this.suspensionService.findByToken(resumeToken)
    if (!suspension) {
      return { status: 404, code: 'NOT_FOUND', message: 'Unknown resume token' }
    }
    if (suspension.status !== 'pending') {
      return { status: 409, code: 'ALREADY_RESUMED', message: `Suspension is ${suspension.status}, not resumable` }
    }
    // A6-3-3 resume-cursor gate — fail closed BEFORE any token claim:
    // - `invalid`: a non-null but malformed / unknown cursor must NEVER fall back to the
    //   top-level step_index path (that is the corrupt-branch-cursor fail-open we close).
    // - `condition_branch`: branch-aware resume lands in the next slice; until then fail
    //   closed rather than mis-resume a branch suspension via the top-level path.
    if (suspension.resumeCursor.kind === 'invalid') {
      return { status: 409, code: 'SUSPENSION_CURSOR_INVALID', message: 'Suspension resume cursor is invalid; cannot resume safely' }
    }
    const resumeCursor = suspension.resumeCursor // top_level | { condition_branch, cursor }
    // Re-load the CURRENT rule (D4); fail closed if missing/disabled (T7).
    const rule = await this.getRule(suspension.ruleId)
    if (!rule || !rule.enabled) {
      return { status: 409, code: 'RULE_MISSING_OR_DISABLED', message: `Rule ${suspension.ruleId} is missing or disabled; cannot resume` }
    }
    const execRule = toExecutorRule(rule)
    // D4b rule-drift guard: step_index is only valid against the suspend-time action array.
    const currentFp = computeActionFingerprint(execRule.actions)
    if (currentFp.count !== suspension.actionFingerprint.count || currentFp.hash !== suspension.actionFingerprint.hash) {
      return { status: 409, code: 'RULE_CHANGED', message: 'Rule actions changed since suspend; cannot resume safely' }
    }
    // A6-3-3 branch drift guard (still BEFORE the claim): the selected branch must still exist and
    // its action sequence must match the suspend-time fingerprint, else resume could re-enter the
    // wrong branch position. The top-level fingerprint above only covers top-level action types.
    if (resumeCursor.kind === 'condition_branch') {
      const branchCursor = resumeCursor.cursor
      const parentAction = execRule.actions[branchCursor.parentStepIndex]
      const parentConfig = (parentAction?.config ?? {}) as {
        branches?: Array<{ key?: unknown; actions?: AutomationAction[] }>
        defaultBranch?: { key?: unknown; actions?: AutomationAction[] } | null
      }
      const branch = [
        ...(Array.isArray(parentConfig.branches) ? parentConfig.branches : []),
        ...(parentConfig.defaultBranch ? [parentConfig.defaultBranch] : []),
      ].find((candidate) => candidate.key === branchCursor.branchKey)
      if (!parentAction || parentAction.type !== 'condition_branch' || !branch || !Array.isArray(branch.actions)) {
        return { status: 409, code: 'RULE_CHANGED', message: 'Selected branch no longer exists; cannot resume safely' }
      }
      const branchFp = computeActionFingerprint(branch.actions)
      if (
        branchFp.count !== branchCursor.branchActionFingerprint.count ||
        branchFp.hash !== branchCursor.branchActionFingerprint.hash
      ) {
        return { status: 409, code: 'RULE_CHANGED', message: 'Selected branch actions changed since suspend; cannot resume safely' }
      }
      // Semantic-corruption guard (still BEFORE the claim). The branch fingerprint only hashes branch
      // action TYPES, so a structurally-valid cursor whose branchActionIndex points at a NON-wait action
      // (with tampered ids) would otherwise pass and let continueBranchExecution settle that non-wait
      // action as the suspended wait. The cursor must (a) point at a branch-local wait_for_callback, and
      // (b) carry the deterministic ids for this execution + branch position (stepKey / parentJobId /
      // branchJobId / upstreamJobId are pure functions of executionId + parentStepIndex + branchKey +
      // branchActionIndex). Any mismatch fails closed.
      if (branch.actions[branchCursor.branchActionIndex]?.type !== 'wait_for_callback') {
        return { status: 409, code: 'SUSPENSION_CURSOR_INVALID', message: 'Resume cursor does not point at a branch-local wait; cannot resume safely' }
      }
      const expectedStepKey = `${branchCursor.parentStepIndex}.branch.${branchCursor.branchKey}.${branchCursor.branchActionIndex}`
      const expectedParentJobId = `${suspension.executionId}:job:${branchCursor.parentStepIndex}`
      const expectedBranchJobId = `${suspension.executionId}:job:${branchCursor.parentStepIndex}:branch:${branchCursor.branchKey}:${branchCursor.branchActionIndex}`
      const expectedUpstreamJobId = branchCursor.branchActionIndex === 0
        ? expectedParentJobId
        : `${suspension.executionId}:job:${branchCursor.parentStepIndex}:branch:${branchCursor.branchKey}:${branchCursor.branchActionIndex - 1}`
      if (
        branchCursor.stepKey !== expectedStepKey ||
        branchCursor.parentJobId !== expectedParentJobId ||
        branchCursor.branchJobId !== expectedBranchJobId ||
        branchCursor.upstreamJobId !== expectedUpstreamJobId
      ) {
        return { status: 409, code: 'SUSPENSION_CURSOR_INVALID', message: 'Resume cursor ids are inconsistent with the branch position; cannot resume safely' }
      }
    }
    // Re-fetch the live record (D4); fail closed if it was deleted during the wait (T9).
    let recordData: Record<string, unknown> = {}
    if (suspension.recordId) {
      const rec = await this.queryFn(
        `SELECT data FROM meta_records WHERE id = $1 AND sheet_id = $2`,
        [suspension.recordId, suspension.sheetId ?? execRule.sheetId],
      )
      const row = (rec.rows[0] ?? null) as { data?: Record<string, unknown> } | null
      if (!row) {
        return { status: 404, code: 'RECORD_GONE', message: 'Record no longer exists; cannot resume' }
      }
      recordData = (row.data as Record<string, unknown>) ?? {}
    }
    // B3: read the execution BEFORE claiming — a missing/unreadable execution must NOT consume the
    // single-use token (it stays `pending`, recoverable). ALL validation precedes the claim.
    const execution = await this.logService.getById(suspension.executionId)
    if (!execution) {
      return { status: 409, code: 'EXECUTION_GONE', message: 'Suspended execution record is missing; cannot resume' }
    }
    // Single-use claim (D8) — the LAST gate; a concurrent resume loses here. After the claim the tail
    // runs and ANY failure settles the execution to a terminal `failed` (continueExecution catches it),
    // never a 500 with the token consumed and the tail unrun.
    const claimed = await this.suspensionService.claim(resumeToken)
    if (!claimed) {
      return { status: 409, code: 'ALREADY_RESUMED', message: 'Suspension was already resumed' }
    }
    execution.initiatedBy = initiatedBy
    // Re-derived context (D4): current record data + stored (redacted) trigger event.
    const triggerEvent = suspension.triggerEvent ?? {}
    const context: ExecutionContext = {
      executionId: execution.id,
      ruleId: execRule.id,
      sheetId: execRule.sheetId,
      recordId: suspension.recordId ?? '',
      recordData,
      ruleCreatedBy: execRule.createdBy,
      actorId: ((triggerEvent as Record<string, unknown>)?.actorId as string) ?? null,
      triggerEvent,
    }
    const lineageIds = await this.collectExecutionLineageIds(execution)
    const rootExecutionId = lineageIds.at(-1) ?? execution.id
    const jobLifecycle = this.buildJobLifecycle(execution.id, execRule, triggerEvent, rootExecutionId)
    const continued = resumeCursor.kind === 'condition_branch'
      ? await this.executor.continueBranchExecution(execution, execRule, context, resumeCursor.cursor, jobLifecycle)
      : await this.executor.continueExecution(execution, execRule, context, suspension.stepIndex, jobLifecycle)
    try {
      await this.logService.updateRecordedExecution(continued)
    } catch (err) {
      logger.error('Resume execution log persistence failed', err instanceof Error ? err : undefined)
    }
    return { execution: continued }
  }

  async handleApprovalCompletionEvent(event: ApprovalCompletionEventV1): Promise<void> {
    if (event.version !== 1 || event.source !== 'approval-product') return
    if (!['approval.approved', 'approval.rejected', 'approval.revoked', 'approval.cancelled'].includes(event.eventType)) return

    const bridge = await this.approvalBridgeService.claimCompletion(event)
    if (!bridge) return

    const execution = await this.logService.getById(bridge.executionId)
    if (!execution) {
      logger.error(`start_approval bridge ${bridge.id} references missing execution ${bridge.executionId}`)
      return
    }

    const rule = await this.getRule(bridge.ruleId)
    if (!rule || !rule.enabled) {
      await this.failApprovalBridgeExecution(execution, bridge, `Rule ${bridge.ruleId} is missing or disabled; cannot resume approval bridge`)
      return
    }
    const execRule = toExecutorRule(rule)
    const currentFp = computeActionFingerprint(execRule.actions)
    if (currentFp.count !== bridge.actionFingerprint.count || currentFp.hash !== bridge.actionFingerprint.hash) {
      await this.failApprovalBridgeExecution(execution, bridge, 'Rule actions changed since start_approval suspended; cannot resume safely')
      return
    }

    const result = this.approvalCompletionStepResult(event)
    if (event.transition.toStatus !== 'approved') {
      await this.failApprovalBridgeExecution(execution, bridge, result.error ?? `Approval completed with ${event.transition.toStatus}`, result)
      return
    }

    let recordData: Record<string, unknown> = {}
    if (bridge.recordId) {
      const rec = await this.queryFn(
        `SELECT data FROM meta_records WHERE id = $1 AND sheet_id = $2`,
        [bridge.recordId, bridge.sheetId ?? execRule.sheetId],
      )
      const row = (rec.rows[0] ?? null) as { data?: Record<string, unknown> } | null
      if (!row) {
        await this.failApprovalBridgeExecution(execution, bridge, 'Record no longer exists; cannot resume approval bridge')
        return
      }
      recordData = (row.data as Record<string, unknown>) ?? {}
    }

    // W7-1: declared approval-result backwrite to the SOURCE record (fixed mapping, values from the
    // event, through the lock guard). Best-effort — a locked/missing record logs + skips rather than
    // crashing the resume, so the automation's remaining actions still run.
    try {
      const backwritten = await this.writeApprovalResultBack(bridge, execRule.actions[bridge.stepIndex]?.config ?? {}, event)
      // W7-1a: merge the backwrite into the resume snapshot so the TAIL actions (send_webhook /
      // update_record / ...) see the just-written result, not the pre-approval record.
      if (backwritten) recordData = { ...recordData, ...backwritten }
    } catch (err) {
      logger.warn(`approval-result backwrite skipped for bridge ${bridge.id}: ${err instanceof Error ? err.message : String(err)}`)
    }

    const triggerEvent = bridge.triggerEvent ?? {}
    const context: ExecutionContext = {
      executionId: execution.id,
      ruleId: execRule.id,
      sheetId: execRule.sheetId,
      recordId: bridge.recordId ?? '',
      recordData,
      ruleCreatedBy: execRule.createdBy,
      actorId: event.actor?.id ?? event.requester.id ?? null,
      triggerEvent,
    }
    const continued = await this.executor.continueExecution(
      execution,
      execRule,
      context,
      bridge.stepIndex,
      this.buildJobLifecycle(execution.id, execRule, triggerEvent, bridge.rootExecutionId),
      result,
    )
    try {
      await this.logService.updateRecordedExecution(continued)
    } catch (err) {
      logger.error('Approval bridge execution log persistence failed', err instanceof Error ? err : undefined)
    }
  }

  private approvalCompletionStepResult(event: ApprovalCompletionEventV1): AutomationStepResult {
    const output = {
      approvalInstanceId: event.approval.instanceId,
      requestNo: event.approval.requestNo,
      templateId: event.approval.templateId,
      publishedDefinitionId: event.approval.publishedDefinitionId,
      outcome: event.transition.toStatus,
      eventId: event.eventId,
    }
    if (event.transition.toStatus === 'approved') {
      return { actionType: 'start_approval', status: 'success', output, durationMs: 0 }
    }
    return {
      actionType: 'start_approval',
      status: 'failed',
      output,
      error: `Approval completed with ${event.transition.toStatus}`,
      durationMs: 0,
    }
  }

  /**
   * W7-1 approval-result backwrite: write the DECLARED fixed outcome→field mapping (from the
   * start_approval action's `resultWriteback`) onto the SOURCE record, using values from the completion
   * event ONLY (never user-templated strings — that keeps the write path values-constrained, the whole
   * reason this was gated). Goes through the record lock guard (B1: an automation does not implicitly own
   * a lock). Null-safe: `approver` is null on auto/system approval (the field is written null, not
   * crashed). Same-base only (the source record that started the approval). Approval-only is enforced by
   * the caller (runs in the approved branch); rejection backwrite is a named follow-up.
   */
  private async writeApprovalResultBack(
    bridge: AutomationApprovalBridgeRow,
    startApprovalConfig: Record<string, unknown>,
    event: ApprovalCompletionEventV1,
  ): Promise<Record<string, unknown> | null> {
    const writeback = isRecord(startApprovalConfig.resultWriteback) ? startApprovalConfig.resultWriteback : null
    if (!writeback || !bridge.recordId || !bridge.sheetId) return null
    const patch: Record<string, unknown> = {}
    if (typeof writeback.statusField === 'string') patch[writeback.statusField] = event.transition.toStatus
    if (typeof writeback.approverField === 'string') patch[writeback.approverField] = event.actor?.id ?? null
    if (typeof writeback.completedAtField === 'string') patch[writeback.completedAtField] = event.occurredAt
    if (Object.keys(patch).length === 0) return null

    const lockRes = await this.queryFn(
      'SELECT locked, locked_by, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2',
      [bridge.recordId, bridge.sheetId],
    )
    const lockRow = lockRes.rows[0] as { locked?: unknown; locked_by?: unknown; created_by?: unknown } | undefined
    if (!lockRow) return null // record gone — the resume's own missing-record path already handled it
    ensureRecordNotLocked(event.actor?.id ?? null, lockRow, () => new Error('source record is locked'))
    // rich-longText SAFE: patch carries ONLY system outcome values (status enum / approver id / ISO
    // timestamp), never user-supplied longText — classified SAFE in the rich-longText write-sink guard.
    // lock-guarded: the backwrite respects the source record lock via ensureRecordNotLocked just above (B1).
    await this.queryFn(
      `UPDATE meta_records
       SET data = COALESCE(data, '{}'::jsonb) || $1::jsonb, version = version + 1, updated_at = NOW()
       WHERE id = $2 AND sheet_id = $3`,
      [JSON.stringify(patch), bridge.recordId, bridge.sheetId],
    )

    // W7-1a parity: emit the chaining event + realtime fan-out, matching update_record, so UI /
    // subscribers / downstream record.updated automations see the backwrite live. Depth-guarded
    // (inherits the trigger's _automationDepth + 1) so a backwrite-driven cascade can't run away.
    const actorId = event.actor?.id ?? null
    const automationDepth = (((bridge.triggerEvent as Record<string, unknown> | null)?._automationDepth as number) ?? 0) + 1
    this.eventBus.emit('multitable.record.updated', {
      sheetId: bridge.sheetId,
      recordId: bridge.recordId,
      changes: patch,
      actorId,
      _automationDepth: automationDepth,
    })
    try {
      publishMultitableSheetRealtime({
        spreadsheetId: bridge.sheetId,
        source: 'multitable',
        kind: 'record-updated',
        recordId: bridge.recordId,
        actorId: actorId ?? undefined,
      })
    } catch {
      // publishMultitableSheetRealtime swallows its own errors; belt-and-suspenders.
    }
    return patch
  }

  private async failApprovalBridgeExecution(
    execution: AutomationExecution,
    bridge: AutomationApprovalBridgeRow,
    message: string,
    result?: AutomationStepResult,
  ): Promise<void> {
    const rule = await this.getRule(bridge.ruleId)
    const execRule = rule ? toExecutorRule(rule) : null
    const action = execRule?.actions[bridge.stepIndex] ?? { type: 'start_approval', config: {} } as AutomationAction
    const failedResult = result ?? {
      actionType: 'start_approval',
      status: 'failed',
      error: message,
      durationMs: 0,
    }
    execution.status = 'failed'
    execution.error = failedResult.error ?? message
    execution.steps.push(failedResult)
    const skippedTail = execRule?.actions.slice(bridge.stepIndex + 1) ?? []
    for (const action of skippedTail) {
      execution.steps.push({ actionType: action.type, status: 'skipped', durationMs: 0 })
    }
    execution.finishedAt = new Date().toISOString()
    const lifecycle = this.jobService.lifecycleFor(execution.id, { id: bridge.ruleId, sheetId: bridge.sheetId ?? undefined })
    try {
      await lifecycle.onSettled(bridge.stepIndex, action, failedResult)
      for (let offset = 0; offset < skippedTail.length; offset++) {
        await lifecycle.onSkipped(bridge.stepIndex + 1 + offset, skippedTail[offset])
      }
    } catch (err) {
      logger.error('Approval bridge job settle failed', err instanceof Error ? err : undefined)
    }
    try {
      await this.logService.updateRecordedExecution(execution)
    } catch (err) {
      logger.error('Approval bridge failed-execution persistence failed', err instanceof Error ? err : undefined)
    }
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
      execution_mode: (row.execution_mode as string) ?? null,
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
  executionMode: string | null
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
    executionMode: rule.execution_mode ?? null,
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
  const actions: unknown[] | null = Array.isArray(body?.actions) ? body!.actions as unknown[] : null
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

  const conditions = body?.conditions === undefined || body.conditions === null
    ? null
    : parseConditionGroupInput(body.conditions)

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
    // Forwarded raw; createRule's normalizeExecutionMode validates/rejects (single source).
    executionMode: body?.executionMode as string | null | undefined,
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
    input.conditions = body.conditions === null ? null : parseConditionGroupInput(body.conditions)
    touched = true
  }
  if (body?.actions !== undefined) {
    input.actions = Array.isArray(body.actions) ? (body.actions as AutomationAction[]) : null
    touched = true
  }
  if (body?.executionMode !== undefined) {
    // Forwarded raw (incl. explicit null = reset to off); updateRule's
    // normalizeExecutionMode validates/rejects (single source).
    input.executionMode = body.executionMode as string | null
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
 * Validate automation conditions against the sheet's current fields. The
 * route parser only validates JSON shape; this preflight closes the API gap
 * where direct clients could persist unknown fields, unsupported operators, or
 * frontend-incompatible scalar value types.
 */
export async function preflightAutomationConditionFields(
  queryFn: AutomationQueryFn,
  sheetId: string,
  conditions: ConditionGroup | null | undefined,
): Promise<void> {
  if (!conditions) return

  const fieldRes = await queryFn(
    'SELECT id, type, property FROM meta_fields WHERE sheet_id = $1',
    [sheetId],
  )
  try {
    validateConditionGroupAgainstFields(
      conditions,
      serializeAutomationConditionFieldRows(fieldRes.rows),
    )
  } catch (error) {
    if (error instanceof ConditionGroupValidationError) {
      throw new AutomationRuleValidationError(error.message)
    }
    throw error
  }
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

  const normalized = normalizeDingTalkAutomationActionInputs(nextActionType, nextActionConfig, nextActions)
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
