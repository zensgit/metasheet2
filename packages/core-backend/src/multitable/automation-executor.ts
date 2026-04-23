/**
 * Automation Executor — V1
 * Core execution pipeline: evaluate conditions, run actions in sequence.
 */

import { randomUUID } from 'crypto'
import { Logger } from '../core/logger'
import {
  DingTalkBusinessError,
  DingTalkRequestError,
  fetchDingTalkAppAccessToken,
  readDingTalkMessageConfig,
  sendDingTalkWorkNotification,
} from '../integrations/dingtalk/client'
import type { EventBus } from '../integration/events/event-bus'
import {
  buildDingTalkMarkdown,
  buildSignedDingTalkWebhookUrl,
  normalizeDingTalkRobotSecret,
  normalizeDingTalkRobotWebhookUrl,
  validateDingTalkRobotResponse,
} from '../integrations/dingtalk/robot'
import type {
  AutomationAction,
  AutomationActionType,
  SendDingTalkGroupMessageConfig,
  SendDingTalkPersonMessageConfig,
} from './automation-actions'
import type { ConditionGroup } from './automation-conditions'
import { evaluateConditions } from './automation-conditions'
import type { AutomationTrigger } from './automation-triggers'

const logger = new Logger('AutomationExecutor')

const WEBHOOK_TIMEOUT_MS = 5_000
const MAX_WEBHOOK_RETRIES = 2
const DINGTALK_PERSON_BATCH_SIZE = 100

function readJsonSafely(response: Response): Promise<unknown> {
  return response.json().catch(() => null)
}

function lookupTemplateValue(path: string, data: Record<string, unknown>): unknown {
  const segments = path.split('.').filter(Boolean)
  let current: unknown = data
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function renderTemplateValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function renderAutomationTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) =>
    renderTemplateValue(lookupTemplateValue(key, data)),
  )
}

function normalizeUserIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(
    value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter(Boolean),
  ))
}

function normalizeIdScalar(value: unknown, objectKeys: string[]): string[] {
  if (typeof value === 'string') {
    return value
      .split(/[\n,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return [String(value)]
  }
  if (typeof value === 'object' && value && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    for (const key of objectKeys) {
      const candidate = record[key]
      if (typeof candidate === 'string' && candidate.trim()) return [candidate.trim()]
      if (typeof candidate === 'number' && Number.isFinite(candidate)) return [String(candidate)]
    }
  }
  return []
}

function normalizeUserIdScalar(value: unknown): string[] {
  return normalizeIdScalar(value, ['localUserId', 'userId', 'id', 'value'])
}

function normalizeMemberGroupIdScalar(value: unknown): string[] {
  return normalizeIdScalar(value, ['memberGroupId', 'groupId', 'subjectId', 'id', 'value'])
}

function normalizeGroupDestinationIdScalar(value: unknown): string[] {
  return normalizeIdScalar(value, ['destinationId', 'groupDestinationId', 'id', 'value'])
}

function normalizeUserIdsFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(
      value.flatMap((entry) => normalizeUserIdsFromUnknown(entry)),
    ))
  }
  return normalizeUserIdScalar(value)
}

function normalizeMemberGroupIdsFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(
      value.flatMap((entry) => normalizeMemberGroupIdsFromUnknown(entry)),
    ))
  }
  return normalizeMemberGroupIdScalar(value)
}

function normalizeGroupDestinationIdsFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(
      value.flatMap((entry) => normalizeGroupDestinationIdsFromUnknown(entry)),
    ))
  }
  return normalizeGroupDestinationIdScalar(value)
}

function normalizeRecipientFieldPath(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.replace(/^record\./, '')
}

function normalizeRecipientFieldPaths(primary: unknown, additional: unknown): string[] {
  const values = [
    primary,
    ...(Array.isArray(additional) ? additional : [additional]),
  ]

  return Array.from(new Set(
    values
      .flatMap((value) => {
        if (typeof value !== 'string') return []
        return value
          .split(/[\n,]+/)
          .map((entry) => normalizeRecipientFieldPath(entry))
          .filter(Boolean)
      }),
  ))
}

function resolveRecipientUserIdsFromRecord(recordData: Record<string, unknown>, fieldPaths: unknown[]): string[] {
  return Array.from(new Set(
    fieldPaths.flatMap((fieldPath) => {
      const normalizedPath = normalizeRecipientFieldPath(fieldPath)
      if (!normalizedPath) return []
      return normalizeUserIdsFromUnknown(lookupTemplateValue(normalizedPath, recordData))
    }),
  ))
}

function resolveRecipientMemberGroupIdsFromRecord(recordData: Record<string, unknown>, fieldPaths: unknown[]): string[] {
  return Array.from(new Set(
    fieldPaths.flatMap((fieldPath) => {
      const normalizedPath = normalizeRecipientFieldPath(fieldPath)
      if (!normalizedPath) return []
      return normalizeMemberGroupIdsFromUnknown(lookupTemplateValue(normalizedPath, recordData))
    }),
  ))
}

function resolveGroupDestinationIdsFromRecord(recordData: Record<string, unknown>, fieldPaths: unknown[]): string[] {
  return Array.from(new Set(
    fieldPaths.flatMap((fieldPath) => {
      const normalizedPath = normalizeRecipientFieldPath(fieldPath)
      if (!normalizedPath) return []
      return normalizeGroupDestinationIdsFromUnknown(lookupTemplateValue(normalizedPath, recordData))
    }),
  ))
}

function chunkItems<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return []
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

function stringifyResponseBody(payload: unknown, fallback: string | null = null): string | null {
  if (payload === null || payload === undefined) return fallback
  try {
    return JSON.stringify(payload)
  } catch {
    return fallback
  }
}

function parseViewConfig(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null
    } catch {
      return null
    }
  }
  return typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
}

function parsePublicFormExpiryMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value instanceof Date) return value.getTime()
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed)
    return Number.isFinite(numeric) ? numeric : null
  }
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

function resolveAutomationAppBaseUrl(): string | null {
  const raw = process.env.PUBLIC_APP_URL?.trim() || process.env.APP_BASE_URL?.trim() || ''
  if (!raw) return null
  return raw.endsWith('/') ? raw : `${raw}/`
}

function buildAppLink(baseUrl: string, path: string, search?: Record<string, string>): string {
  const url = new URL(path.replace(/^\//, ''), baseUrl)
  for (const [key, value] of Object.entries(search ?? {})) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}

function normalizePublicFormAccessMode(value: unknown): 'public' | 'dingtalk' | 'dingtalk_granted' {
  return value === 'dingtalk' || value === 'dingtalk_granted' ? value : 'public'
}

function countStringIds(value: unknown): number {
  if (!Array.isArray(value)) return 0
  return new Set(
    value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean),
  ).size
}

function describeLocalAllowlistCount(userCount: number, memberGroupCount: number): string {
  const parts: string[] = []
  if (userCount > 0) parts.push(`${userCount} 个本地用户`)
  if (memberGroupCount > 0) parts.push(`${memberGroupCount} 个本地成员组`)
  return parts.join('、')
}

function describeDingTalkPublicFormRuntimeLines(publicForm: Record<string, unknown>): string[] {
  const accessMode = normalizePublicFormAccessMode(publicForm.accessMode)
  if (accessMode === 'public') {
    return ['- 表单访问：任何获得链接的人可填写']
  }

  const userCount = countStringIds(publicForm.allowedUserIds)
  const memberGroupCount = countStringIds(publicForm.allowedMemberGroupIds)
  const modeLabel = accessMode === 'dingtalk_granted'
    ? '钉钉登录 + 本地授权'
    : '钉钉登录 + 绑定本地用户'
  if (userCount === 0 && memberGroupCount === 0) {
    const audience = accessMode === 'dingtalk_granted'
      ? '所有已授权钉钉的本地用户可填写'
      : '所有已绑定钉钉的本地用户可填写'
    return [
      `- 表单访问：${modeLabel}`,
      `- 允许范围：${audience}`,
    ]
  }

  return [
    `- 表单访问：${modeLabel}`,
    `- 允许范围：${describeLocalAllowlistCount(userCount, memberGroupCount)}通过钉钉校验后可填写`,
  ]
}

function describeDingTalkInternalViewRuntimeLines(): string[] {
  return ['- 处理权限：需登录系统并具备该表格/视图访问权限']
}

async function recordDingTalkGroupDelivery(
  queryFn: AutomationDeps['queryFn'],
  input: {
    destinationId: string
    sourceType: 'automation' | 'manual_test'
    subject: string
    content: string
    success: boolean
    httpStatus?: number | null
    responseBody?: string | null
    errorMessage?: string | null
    automationRuleId?: string | null
    recordId?: string | null
    initiatedBy?: string | null
  },
): Promise<void> {
  await queryFn(
    `INSERT INTO dingtalk_group_deliveries (
       id, destination_id, source_type, subject, content, success,
       http_status, response_body, error_message, automation_rule_id,
       record_id, initiated_by, delivered_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10,
       $11, $12, $13
     )`,
    [
      randomUUID(),
      input.destinationId,
      input.sourceType,
      input.subject,
      input.content,
      input.success,
      input.httpStatus ?? null,
      input.responseBody ?? null,
      input.errorMessage ?? null,
      input.automationRuleId ?? null,
      input.recordId ?? null,
      input.initiatedBy ?? null,
      input.success ? new Date().toISOString() : null,
    ],
  )
}

async function recordDingTalkGroupDeliverySafely(
  queryFn: AutomationDeps['queryFn'],
  input: Parameters<typeof recordDingTalkGroupDelivery>[1],
): Promise<void> {
  try {
    await recordDingTalkGroupDelivery(queryFn, input)
  } catch (error) {
    logger.warn('Failed to persist DingTalk group delivery history', {
      error: error instanceof Error ? error.message : String(error),
      destinationId: input.destinationId,
      sourceType: input.sourceType,
    })
  }
}

async function recordDingTalkPersonDelivery(
  queryFn: AutomationDeps['queryFn'],
  input: {
    localUserId: string
    dingtalkUserId?: string | null
    sourceType: 'automation'
    subject: string
    content: string
    success: boolean
    status?: 'success' | 'failed' | 'skipped'
    httpStatus?: number | null
    responseBody?: string | null
    errorMessage?: string | null
    automationRuleId?: string | null
    recordId?: string | null
    initiatedBy?: string | null
  },
): Promise<void> {
  await queryFn(
    `INSERT INTO dingtalk_person_deliveries (
       id, local_user_id, dingtalk_user_id, source_type, subject, content, success,
       status, http_status, response_body, error_message, automation_rule_id,
       record_id, initiated_by, delivered_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11, $12,
       $13, $14, $15
     )`,
    [
      randomUUID(),
      input.localUserId,
      input.dingtalkUserId ?? null,
      input.sourceType,
      input.subject,
      input.content,
      input.success,
      input.status ?? (input.success ? 'success' : 'failed'),
      input.httpStatus ?? null,
      input.responseBody ?? null,
      input.errorMessage ?? null,
      input.automationRuleId ?? null,
      input.recordId ?? null,
      input.initiatedBy ?? null,
      input.success ? new Date().toISOString() : null,
    ],
  )
}

async function recordDingTalkPersonDeliverySafely(
  queryFn: AutomationDeps['queryFn'],
  input: Parameters<typeof recordDingTalkPersonDelivery>[1],
): Promise<void> {
  try {
    await recordDingTalkPersonDelivery(queryFn, input)
  } catch (error) {
    logger.warn('Failed to persist DingTalk person delivery history', {
      error: error instanceof Error ? error.message : String(error),
      localUserId: input.localUserId,
      sourceType: input.sourceType,
    })
  }
}

// ── Types ─────────────────────────────────────────────────────────────────

export interface AutomationRule {
  id: string
  name: string
  sheetId: string
  trigger: AutomationTrigger
  conditions?: ConditionGroup
  actions: AutomationAction[]
  enabled: boolean
  createdBy: string
  createdAt: string
  updatedAt?: string
}

export interface AutomationExecution {
  id: string
  ruleId: string
  triggeredBy: string
  triggeredAt: string
  status: 'running' | 'success' | 'failed' | 'skipped'
  steps: AutomationStepResult[]
  error?: string
  duration?: number
}

export interface AutomationStepResult {
  actionType: AutomationActionType
  status: 'success' | 'failed' | 'skipped'
  output?: unknown
  error?: string
  durationMs?: number
}

export interface ExecutionContext {
  ruleId: string
  sheetId: string
  recordId: string
  recordData: Record<string, unknown>
  ruleCreatedBy: string
  actorId?: string | null
  triggerEvent: unknown
}

// ── Dependencies interface for action executors ───────────────────────────

export interface AutomationDeps {
  eventBus: EventBus
  queryFn: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>
  fetchFn?: typeof fetch
}

// ── Executor class ────────────────────────────────────────────────────────

export class AutomationExecutor {
  private deps: AutomationDeps

  constructor(deps: AutomationDeps) {
    this.deps = deps
  }

  /**
   * Execute a rule against a trigger event.
   * Returns an execution record with step results.
   */
  async execute(rule: AutomationRule, triggerEvent: unknown): Promise<AutomationExecution> {
    const executionId = `axe_${randomUUID()}`
    const startTime = Date.now()
    const execution: AutomationExecution = {
      id: executionId,
      ruleId: rule.id,
      triggeredBy: (triggerEvent as Record<string, unknown>)?._triggeredBy as string ?? 'event',
      triggeredAt: new Date().toISOString(),
      status: 'running',
      steps: [],
    }

    // Build execution context from trigger event
    const payload = triggerEvent as Record<string, unknown>
    const context: ExecutionContext = {
      ruleId: rule.id,
      sheetId: rule.sheetId,
      recordId: (payload?.recordId as string) ?? '',
      recordData: (payload?.data as Record<string, unknown>) ?? (payload?.changes as Record<string, unknown>) ?? {},
      ruleCreatedBy: rule.createdBy,
      actorId: (payload?.actorId as string) ?? null,
      triggerEvent,
    }

    // Evaluate conditions
    if (rule.conditions && rule.conditions.conditions.length > 0) {
      const conditionsPassed = evaluateConditions(rule.conditions, context.recordData)
      if (!conditionsPassed) {
        execution.status = 'skipped'
        execution.duration = Date.now() - startTime
        return execution
      }
    }

    // Execute actions in sequence
    try {
      execution.steps = await this.executeActions(rule.actions, context)

      const hasFailed = execution.steps.some((s) => s.status === 'failed')
      const allSkipped = execution.steps.length > 0 && execution.steps.every((s) => s.status === 'skipped')
      execution.status = hasFailed ? 'failed' : allSkipped ? 'skipped' : 'success'
      if (hasFailed) {
        const failedStep = execution.steps.find((s) => s.status === 'failed')
        execution.error = failedStep?.error ?? 'Action failed'
      }
    } catch (err) {
      execution.status = 'failed'
      execution.error = err instanceof Error ? err.message : String(err)
    }

    execution.duration = Date.now() - startTime
    return execution
  }

  /**
   * Execute actions in sequence. Stop on first failure.
   */
  private async executeActions(
    actions: AutomationAction[],
    context: ExecutionContext,
  ): Promise<AutomationStepResult[]> {
    const results: AutomationStepResult[] = []

    for (const action of actions) {
      const startMs = Date.now()
      let result: AutomationStepResult

      try {
        switch (action.type) {
          case 'update_record':
            result = await this.executeUpdateRecord(action.config, context)
            break
          case 'create_record':
            result = await this.executeCreateRecord(action.config, context)
            break
          case 'send_webhook':
            result = await this.executeSendWebhook(action.config, context)
            break
          case 'send_notification':
            result = await this.executeSendNotification(action.config, context)
            break
          case 'send_dingtalk_group_message':
            result = await this.executeSendDingTalkGroupMessage(action.config as unknown as SendDingTalkGroupMessageConfig, context)
            break
          case 'send_dingtalk_person_message':
            result = await this.executeSendDingTalkPersonMessage(action.config as unknown as SendDingTalkPersonMessageConfig, context)
            break
          case 'lock_record':
            result = await this.executeLockRecord(action.config, context)
            break
          default:
            result = {
              actionType: action.type,
              status: 'failed',
              error: `Unknown action type: ${action.type}`,
            }
        }
      } catch (err) {
        result = {
          actionType: action.type,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        }
      }

      result.durationMs = Date.now() - startMs
      results.push(result)

      // Stop on failure
      if (result.status === 'failed') {
        // Mark remaining actions as skipped
        for (let i = results.length; i < actions.length; i++) {
          results.push({
            actionType: actions[i].type,
            status: 'skipped',
            durationMs: 0,
          })
        }
        break
      }
    }

    return results
  }

  // ── Individual action executors ─────────────────────────────────────────

  private async executeUpdateRecord(
    config: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<AutomationStepResult> {
    const fields = config.fields as Record<string, unknown> | undefined
    if (!fields || Object.keys(fields).length === 0) {
      return { actionType: 'update_record', status: 'failed', error: 'No fields specified' }
    }

    // Build SET clause
    const entries = Object.entries(fields)
    const sets: string[] = []
    const params: unknown[] = []
    let idx = 1
    for (const [key, val] of entries) {
      sets.push(`data = jsonb_set(COALESCE(data, '{}'), $${idx}::text[], $${idx + 1}::jsonb)`)
      params.push(`{${key}}`, JSON.stringify(val))
      idx += 2
    }
    params.push(context.recordId, context.sheetId)

    try {
      await this.deps.queryFn(
        `UPDATE meta_records SET ${sets.join(', ')}, version = version + 1, updated_at = NOW()
         WHERE id = $${idx} AND sheet_id = $${idx + 1}`,
        params,
      )

      // Emit event for chaining
      this.deps.eventBus.emit('multitable.record.updated', {
        sheetId: context.sheetId,
        recordId: context.recordId,
        changes: fields,
        actorId: context.actorId,
        _automationDepth: ((context.triggerEvent as Record<string, unknown>)?._automationDepth as number ?? 0) + 1,
      })

      return { actionType: 'update_record', status: 'success', output: { updatedFields: Object.keys(fields) } }
    } catch (err) {
      return { actionType: 'update_record', status: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
  }

  private async executeCreateRecord(
    config: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<AutomationStepResult> {
    const targetSheetId = (config.sheetId as string) || context.sheetId
    const data = (config.data as Record<string, unknown>) ?? {}
    const recordId = `rec_${randomUUID()}`

    try {
      await this.deps.queryFn(
        `INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1, $2, $3::jsonb, 1)`,
        [recordId, targetSheetId, JSON.stringify(data)],
      )

      this.deps.eventBus.emit('multitable.record.created', {
        sheetId: targetSheetId,
        recordId,
        data,
        actorId: context.actorId,
        _automationDepth: ((context.triggerEvent as Record<string, unknown>)?._automationDepth as number ?? 0) + 1,
      })

      return { actionType: 'create_record', status: 'success', output: { recordId, sheetId: targetSheetId } }
    } catch (err) {
      return { actionType: 'create_record', status: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
  }

  private async executeSendWebhook(
    config: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<AutomationStepResult> {
    const url = config.url as string | undefined
    if (!url) {
      return { actionType: 'send_webhook', status: 'failed', error: 'Webhook URL is required' }
    }

    const method = (config.method as string) ?? 'POST'
    const headers = (config.headers as Record<string, string>) ?? {}
    if (!headers['Content-Type']) {
      headers['Content-Type'] = 'application/json'
    }

    const body = config.body ?? {
      ruleId: context.sheetId,
      recordId: context.recordId,
      data: context.recordData,
      triggeredAt: new Date().toISOString(),
    }

    const fetchFn = this.deps.fetchFn ?? globalThis.fetch

    let lastError: string | undefined
    for (let attempt = 0; attempt <= MAX_WEBHOOK_RETRIES; attempt++) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS)

        const response = await fetchFn(url, {
          method,
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        clearTimeout(timeout)

        if (response.ok) {
          return {
            actionType: 'send_webhook',
            status: 'success',
            output: { httpStatus: response.status, attempt: attempt + 1 },
          }
        }

        lastError = `HTTP ${response.status}`
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }

      // Wait before retry (simple exponential backoff)
      if (attempt < MAX_WEBHOOK_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
      }
    }

    return { actionType: 'send_webhook', status: 'failed', error: `Webhook failed after ${MAX_WEBHOOK_RETRIES + 1} attempts: ${lastError}` }
  }

  private async executeSendNotification(
    config: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<AutomationStepResult> {
    const userIds = config.userIds as string[] | undefined
    const message = config.message as string | undefined

    if (!userIds || userIds.length === 0) {
      return { actionType: 'send_notification', status: 'failed', error: 'No user IDs specified' }
    }
    if (!message) {
      return { actionType: 'send_notification', status: 'failed', error: 'Notification message is required' }
    }

    try {
      // Emit notification event — CollabService or other handler picks this up
      this.deps.eventBus.emit('automation.notification', {
        userIds,
        message,
        sheetId: context.sheetId,
        recordId: context.recordId,
        actorId: context.actorId,
      })

      return {
        actionType: 'send_notification',
        status: 'success',
        output: { notifiedUsers: userIds.length },
      }
    } catch (err) {
      return { actionType: 'send_notification', status: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
  }

  private async executeSendDingTalkPersonMessage(
    config: SendDingTalkPersonMessageConfig,
    context: ExecutionContext,
  ): Promise<AutomationStepResult> {
    const staticUserIds = normalizeUserIds(config.userIds)
    const staticMemberGroupIds = normalizeUserIds(config.memberGroupIds)
    const recipientFieldPaths = normalizeRecipientFieldPaths(config.userIdFieldPath, config.userIdFieldPaths)
    const memberGroupRecipientFieldPaths = normalizeRecipientFieldPaths(config.memberGroupIdFieldPath, config.memberGroupIdFieldPaths)
    const recordUserIds = resolveRecipientUserIdsFromRecord(context.recordData, recipientFieldPaths)
    const recordMemberGroupIds = resolveRecipientMemberGroupIdsFromRecord(context.recordData, memberGroupRecipientFieldPaths)
    const memberGroupIds = Array.from(new Set([...staticMemberGroupIds, ...recordMemberGroupIds]))
    const titleTemplate = typeof config.titleTemplate === 'string' ? config.titleTemplate.trim() : ''
    const bodyTemplate = typeof config.bodyTemplate === 'string' ? config.bodyTemplate.trim() : ''
    const publicFormViewId = typeof config.publicFormViewId === 'string' ? config.publicFormViewId.trim() : ''
    const internalViewId = typeof config.internalViewId === 'string' ? config.internalViewId.trim() : ''
    if (!titleTemplate) {
      return { actionType: 'send_dingtalk_person_message', status: 'failed', error: 'DingTalk title template is required' }
    }
    if (!bodyTemplate) {
      return { actionType: 'send_dingtalk_person_message', status: 'failed', error: 'DingTalk body template is required' }
    }

    let baseUrl: string | null = null
    const linkLines: string[] = []
    if (publicFormViewId || internalViewId) {
      baseUrl = resolveAutomationAppBaseUrl()
      if (!baseUrl) {
        return {
          actionType: 'send_dingtalk_person_message',
          status: 'failed',
          error: 'PUBLIC_APP_URL or APP_BASE_URL is required for DingTalk automation links',
        }
      }
    }

    if (publicFormViewId && baseUrl) {
      const publicViewResult = await this.deps.queryFn(
        `SELECT id, sheet_id, config
           FROM meta_views
          WHERE id = $1 AND sheet_id = $2 AND type = 'form'`,
        [publicFormViewId, context.sheetId],
      )
      const publicView = (publicViewResult.rows[0] ?? null) as {
        id: string
        sheet_id: string
        config: unknown
      } | null
      if (!publicView) {
        return { actionType: 'send_dingtalk_person_message', status: 'failed', error: 'Public form view not found' }
      }

      const viewConfig = parseViewConfig(publicView.config)
      const publicForm = viewConfig?.publicForm
      const publicFormRecord = publicForm && typeof publicForm === 'object' && !Array.isArray(publicForm)
        ? publicForm as Record<string, unknown>
        : null
      const publicToken = publicFormRecord
        ? typeof publicFormRecord.publicToken === 'string'
          ? publicFormRecord.publicToken.trim()
          : ''
        : ''
      const enabled = publicFormRecord
        ? publicFormRecord.enabled === true
        : false

      if (!publicFormRecord || !enabled || !publicToken) {
        return {
          actionType: 'send_dingtalk_person_message',
          status: 'failed',
          error: 'Selected public form view is not shared',
        }
      }
      const expiryMs = parsePublicFormExpiryMs(
        publicFormRecord.expiresAt ?? publicFormRecord.expiresOn,
      )
      if (expiryMs !== null && Date.now() >= expiryMs) {
        return {
          actionType: 'send_dingtalk_person_message',
          status: 'failed',
          error: 'Selected public form view has expired',
        }
      }

      linkLines.push(`- [填写入口](${buildAppLink(baseUrl, `/multitable/public-form/${context.sheetId}/${publicFormViewId}`, { publicToken })})`)
      linkLines.push(...describeDingTalkPublicFormRuntimeLines(publicFormRecord))
    }

    if (internalViewId && baseUrl) {
      const internalViewResult = await this.deps.queryFn(
        `SELECT id
           FROM meta_views
          WHERE id = $1 AND sheet_id = $2`,
        [internalViewId, context.sheetId],
      )
      if (!internalViewResult.rows[0]) {
        return { actionType: 'send_dingtalk_person_message', status: 'failed', error: 'Internal view not found' }
      }
      linkLines.push(`- [处理入口](${buildAppLink(baseUrl, `/multitable/${context.sheetId}/${internalViewId}`, { recordId: context.recordId })})`)
      linkLines.push(...describeDingTalkInternalViewRuntimeLines())
    }

    const templateData: Record<string, unknown> = {
      sheetId: context.sheetId,
      recordId: context.recordId,
      actorId: context.actorId ?? '',
      record: context.recordData,
    }
    const renderedTitle = renderAutomationTemplate(titleTemplate, templateData).trim()
    const renderedBody = renderAutomationTemplate(bodyTemplate, templateData).trim()
    const bodyWithLinks = [
      renderedBody,
      linkLines.length > 0 ? ['**快捷入口**', ...linkLines].join('\n') : '',
    ].filter(Boolean).join('\n\n')

    let memberGroupUserIds: string[] = []
    if (memberGroupIds.length > 0) {
      const existingGroupsResult = await this.deps.queryFn(
        'SELECT id::text AS id FROM platform_member_groups WHERE id::text = ANY($1::text[])',
        [memberGroupIds],
      )
      const existingGroupIds = new Set(
        (existingGroupsResult.rows as Array<Record<string, unknown>>)
          .map((row) => (typeof row.id === 'string' ? row.id.trim() : ''))
          .filter(Boolean),
      )
      const missingGroupIds = memberGroupIds.filter((groupId) => !existingGroupIds.has(groupId))
      if (missingGroupIds.length > 0) {
        return {
          actionType: 'send_dingtalk_person_message',
          status: 'failed',
          error: `Member groups not found: ${missingGroupIds.join(', ')}`,
        }
      }

      const memberGroupRecipientsResult = await this.deps.queryFn(
        `SELECT DISTINCT gm.user_id::text AS local_user_id
           FROM platform_member_group_members gm
           JOIN users u ON u.id = gm.user_id
          WHERE gm.group_id::text = ANY($1::text[])
            AND u.is_active = TRUE`,
        [memberGroupIds],
      )
      memberGroupUserIds = Array.from(new Set(
        (memberGroupRecipientsResult.rows as Array<Record<string, unknown>>)
          .map((row) => (typeof row.local_user_id === 'string' ? row.local_user_id.trim() : ''))
          .filter(Boolean),
      ))
    }

    const userIds = Array.from(new Set([...staticUserIds, ...memberGroupUserIds, ...recordUserIds]))
    if (userIds.length === 0) {
      if (memberGroupIds.length > 0) {
        if (memberGroupRecipientFieldPaths.length > 0) {
          return {
            actionType: 'send_dingtalk_person_message',
            status: 'failed',
            error: `No local userIds resolved from member group record field paths: ${memberGroupRecipientFieldPaths.join(', ')}`,
          }
        }
        return {
          actionType: 'send_dingtalk_person_message',
          status: 'failed',
          error: `No local userIds resolved from member groups: ${memberGroupIds.join(', ')}`,
        }
      }
      if (recipientFieldPaths.length > 0) {
        return {
          actionType: 'send_dingtalk_person_message',
          status: 'failed',
          error: `No local userIds resolved from record field paths: ${recipientFieldPaths.join(', ')}`,
        }
      }
      if (memberGroupRecipientFieldPaths.length > 0) {
        return {
          actionType: 'send_dingtalk_person_message',
          status: 'failed',
          error: `No local userIds resolved from member group record field paths: ${memberGroupRecipientFieldPaths.join(', ')}`,
        }
      }
      return {
        actionType: 'send_dingtalk_person_message',
        status: 'failed',
        error: 'At least one local userId, memberGroupId, record recipient field path, or member group record field path is required',
      }
    }

    const recipientsResult = await this.deps.queryFn(
      `SELECT u.id AS local_user_id,
              u.is_active AS local_user_active,
              linked.external_user_id AS dingtalk_user_id
         FROM users u
         LEFT JOIN LATERAL (
           SELECT a.external_user_id
             FROM directory_account_links l
             JOIN directory_accounts a ON a.id = l.directory_account_id
            WHERE l.local_user_id = u.id
              AND l.link_status = 'linked'
              AND a.provider = 'dingtalk'
              AND a.is_active = TRUE
            ORDER BY a.updated_at DESC
            LIMIT 1
         ) linked ON TRUE
        WHERE u.id = ANY($1::text[])`,
      [userIds],
    )

    const recipientMap = new Map<string, { localUserId: string; dingtalkUserId: string }>()
    for (const row of recipientsResult.rows as Array<Record<string, unknown>>) {
      const localUserId = typeof row.local_user_id === 'string' ? row.local_user_id.trim() : ''
      const dingtalkUserId = typeof row.dingtalk_user_id === 'string' ? row.dingtalk_user_id.trim() : ''
      const isActive = row.local_user_active === true
      if (!localUserId || !isActive || !dingtalkUserId || recipientMap.has(localUserId)) continue
      recipientMap.set(localUserId, { localUserId, dingtalkUserId })
    }

    const missingUserIds = userIds.filter((userId) => !recipientMap.has(userId))
    if (missingUserIds.length > 0) {
      await Promise.all(missingUserIds.map((userId) => recordDingTalkPersonDeliverySafely(this.deps.queryFn, {
        localUserId: userId,
        sourceType: 'automation',
        subject: renderedTitle,
        content: bodyWithLinks,
        success: false,
        status: 'skipped',
        errorMessage: 'DingTalk account is not linked or user is inactive',
        automationRuleId: context.ruleId,
        recordId: context.recordId,
        initiatedBy: context.actorId ?? null,
      })))
    }

    const resolvedRecipients = userIds
      .map((userId) => recipientMap.get(userId))
      .filter((entry): entry is { localUserId: string; dingtalkUserId: string } => Boolean(entry))
    if (resolvedRecipients.length === 0) {
      return {
        actionType: 'send_dingtalk_person_message',
        status: 'skipped',
        error: `DingTalk account not linked for users: ${missingUserIds.join(', ')}`,
        output: {
          notifiedUsers: 0,
          skippedRecipientCount: missingUserIds.length,
          skippedUserIds: missingUserIds,
        },
      }
    }
    const batches = chunkItems(resolvedRecipients, DINGTALK_PERSON_BATCH_SIZE)

    try {
      const messageConfig = readDingTalkMessageConfig()
      const accessToken = await fetchDingTalkAppAccessToken(messageConfig, { fetchFn: this.deps.fetchFn })
      let responseCount = 0

      for (const batch of batches) {
        const result = await sendDingTalkWorkNotification(
          accessToken,
          {
            userIds: batch.map((recipient) => recipient.dingtalkUserId),
            title: renderedTitle,
            content: bodyWithLinks,
          },
          messageConfig,
          { fetchFn: this.deps.fetchFn },
        )
        const responseBody = stringifyResponseBody(result.raw)
        responseCount += 1

        await Promise.all(batch.map((recipient) => recordDingTalkPersonDeliverySafely(this.deps.queryFn, {
          localUserId: recipient.localUserId,
          dingtalkUserId: recipient.dingtalkUserId,
          sourceType: 'automation',
          subject: renderedTitle,
          content: bodyWithLinks,
          success: true,
          status: 'success',
          httpStatus: 200,
          responseBody,
          automationRuleId: context.ruleId,
          recordId: context.recordId,
          initiatedBy: context.actorId ?? null,
        })))
      }

      return {
        actionType: 'send_dingtalk_person_message',
        status: 'success',
        output: {
          notifiedUsers: resolvedRecipients.length,
          staticRecipientCount: staticUserIds.length,
          memberGroupRecipientCount: memberGroupUserIds.length,
          dynamicRecipientCount: recordUserIds.length,
          dynamicMemberGroupRecipientCount: recordMemberGroupIds.length,
          skippedRecipientCount: missingUserIds.length,
          skippedUserIds: missingUserIds,
          memberGroupIds,
          recipientFieldPath: recipientFieldPaths[0] ?? null,
          recipientFieldPaths,
          memberGroupRecipientFieldPath: memberGroupRecipientFieldPaths[0] ?? null,
          memberGroupRecipientFieldPaths,
          batchCount: batches.length,
          linkCount: linkLines.length,
          responseCount,
        },
      }
    } catch (error) {
      const httpStatus = error instanceof DingTalkRequestError ? error.statusCode : error instanceof DingTalkBusinessError ? 200 : null
      const responseBody = error instanceof DingTalkRequestError
        ? stringifyResponseBody(error.responseBody)
        : error instanceof DingTalkBusinessError
          ? stringifyResponseBody(error.responseBody)
          : null
      const errorMessage = error instanceof Error ? error.message : String(error)

      await Promise.all(resolvedRecipients.map((recipient) => recordDingTalkPersonDeliverySafely(this.deps.queryFn, {
        localUserId: recipient.localUserId,
        dingtalkUserId: recipient.dingtalkUserId,
        sourceType: 'automation',
        subject: renderedTitle,
        content: bodyWithLinks,
        success: false,
        status: 'failed',
        httpStatus,
        responseBody,
        errorMessage,
        automationRuleId: context.ruleId,
        recordId: context.recordId,
        initiatedBy: context.actorId ?? null,
      })))

      return {
        actionType: 'send_dingtalk_person_message',
        status: 'failed',
        error: errorMessage,
      }
    }
  }

  private async executeLockRecord(
    config: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<AutomationStepResult> {
    const locked = config.locked !== false // default to true

    try {
      await this.deps.queryFn(
        `UPDATE meta_records SET locked = $1, version = version + 1, updated_at = NOW()
         WHERE id = $2 AND sheet_id = $3`,
        [locked, context.recordId, context.sheetId],
      )

      return {
        actionType: 'lock_record',
        status: 'success',
        output: { locked, recordId: context.recordId },
      }
    } catch (err) {
      return { actionType: 'lock_record', status: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
  }

  private async executeSendDingTalkGroupMessage(
    config: SendDingTalkGroupMessageConfig,
    context: ExecutionContext,
  ): Promise<AutomationStepResult> {
    const staticDestinationIds = Array.from(new Set([
      ...(Array.isArray(config.destinationIds)
        ? config.destinationIds
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter(Boolean)
        : []),
      ...(typeof config.destinationId === 'string' && config.destinationId.trim()
        ? [config.destinationId.trim()]
        : []),
    ]))
    const destinationFieldPaths = normalizeRecipientFieldPaths(config.destinationIdFieldPath, config.destinationIdFieldPaths)
    const recordDestinationIds = resolveGroupDestinationIdsFromRecord(context.recordData, destinationFieldPaths)
    const destinationIds = Array.from(new Set([...staticDestinationIds, ...recordDestinationIds]))
    const titleTemplate = typeof config.titleTemplate === 'string' ? config.titleTemplate.trim() : ''
    const bodyTemplate = typeof config.bodyTemplate === 'string' ? config.bodyTemplate.trim() : ''
    const publicFormViewId = typeof config.publicFormViewId === 'string' ? config.publicFormViewId.trim() : ''
    const internalViewId = typeof config.internalViewId === 'string' ? config.internalViewId.trim() : ''

    if (!destinationIds.length) {
      if (destinationFieldPaths.length > 0) {
        return {
          actionType: 'send_dingtalk_group_message',
          status: 'failed',
          error: `No DingTalk destinationIds resolved from record field paths: ${destinationFieldPaths.join(', ')}`,
        }
      }
      return { actionType: 'send_dingtalk_group_message', status: 'failed', error: 'At least one DingTalk destination or record destination field path is required' }
    }
    if (!titleTemplate) {
      return { actionType: 'send_dingtalk_group_message', status: 'failed', error: 'DingTalk title template is required' }
    }
    if (!bodyTemplate) {
      return { actionType: 'send_dingtalk_group_message', status: 'failed', error: 'DingTalk body template is required' }
    }

    const destinationResult = await this.deps.queryFn(
      `SELECT id, name, webhook_url, secret, enabled
         FROM dingtalk_group_destinations dg
        WHERE id = ANY($1)
          AND (
            sheet_id = $2
            OR (sheet_id IS NULL AND org_id IS NULL AND created_by = $3)
            OR (
              sheet_id IS NULL
              AND org_id IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM user_orgs uo
                WHERE uo.user_id = $3
                  AND uo.org_id = dg.org_id
                  AND uo.is_active = true
              )
            )
          )`,
      [destinationIds, context.sheetId, context.ruleCreatedBy],
    )
    const destinations = destinationResult.rows as Array<{
      id: string
      name: string
      webhook_url: string
      secret: string | null
      enabled: boolean
    }>
    const destinationsById = new Map(destinations.map((destination) => [destination.id, destination]))
    const missingDestinationIds = destinationIds.filter((id) => !destinationsById.has(id))
    if (missingDestinationIds.length) {
      return {
        actionType: 'send_dingtalk_group_message',
        status: 'failed',
        error: `DingTalk destinations not found: ${missingDestinationIds.join(', ')}`,
      }
    }
    const disabledDestinations = destinationIds
      .map((id) => destinationsById.get(id))
      .filter((destination): destination is NonNullable<typeof destination> => Boolean(destination) && destination.enabled !== true)
    if (disabledDestinations.length) {
      return {
        actionType: 'send_dingtalk_group_message',
        status: 'failed',
        error: `DingTalk destinations are disabled: ${disabledDestinations.map((destination) => destination.name || destination.id).join(', ')}`,
      }
    }

    let baseUrl: string | null = null
    const linkLines: string[] = []
    if (publicFormViewId || internalViewId) {
      baseUrl = resolveAutomationAppBaseUrl()
      if (!baseUrl) {
        return {
          actionType: 'send_dingtalk_group_message',
          status: 'failed',
          error: 'PUBLIC_APP_URL or APP_BASE_URL is required for DingTalk automation links',
        }
      }
    }

    if (publicFormViewId && baseUrl) {
      const publicViewResult = await this.deps.queryFn(
        `SELECT id, sheet_id, config
           FROM meta_views
          WHERE id = $1 AND sheet_id = $2 AND type = 'form'`,
        [publicFormViewId, context.sheetId],
      )
      const publicView = (publicViewResult.rows[0] ?? null) as {
        id: string
        sheet_id: string
        config: unknown
      } | null
      if (!publicView) {
        return { actionType: 'send_dingtalk_group_message', status: 'failed', error: 'Public form view not found' }
      }

      const viewConfig = parseViewConfig(publicView.config)
      const publicForm = viewConfig?.publicForm
      const publicFormRecord = publicForm && typeof publicForm === 'object' && !Array.isArray(publicForm)
        ? publicForm as Record<string, unknown>
        : null
      const publicToken = publicFormRecord
        ? typeof publicFormRecord.publicToken === 'string'
          ? publicFormRecord.publicToken.trim()
          : ''
        : ''
      const enabled = publicFormRecord
        ? publicFormRecord.enabled === true
        : false

      if (!publicFormRecord || !enabled || !publicToken) {
        return {
          actionType: 'send_dingtalk_group_message',
          status: 'failed',
          error: 'Selected public form view is not shared',
        }
      }
      const expiryMs = parsePublicFormExpiryMs(
        publicFormRecord.expiresAt ?? publicFormRecord.expiresOn,
      )
      if (expiryMs !== null && Date.now() >= expiryMs) {
        return {
          actionType: 'send_dingtalk_group_message',
          status: 'failed',
          error: 'Selected public form view has expired',
        }
      }

      linkLines.push(`- [填写入口](${buildAppLink(baseUrl, `/multitable/public-form/${context.sheetId}/${publicFormViewId}`, { publicToken })})`)
      linkLines.push(...describeDingTalkPublicFormRuntimeLines(publicFormRecord))
    }

    if (internalViewId && baseUrl) {
      const internalViewResult = await this.deps.queryFn(
        `SELECT id
           FROM meta_views
          WHERE id = $1 AND sheet_id = $2`,
        [internalViewId, context.sheetId],
      )
      if (!internalViewResult.rows[0]) {
        return { actionType: 'send_dingtalk_group_message', status: 'failed', error: 'Internal view not found' }
      }
      linkLines.push(`- [处理入口](${buildAppLink(baseUrl, `/multitable/${context.sheetId}/${internalViewId}`, { recordId: context.recordId })})`)
      linkLines.push(...describeDingTalkInternalViewRuntimeLines())
    }

    const templateData: Record<string, unknown> = {
      sheetId: context.sheetId,
      recordId: context.recordId,
      actorId: context.actorId ?? '',
      record: context.recordData,
    }
    const renderedTitle = renderAutomationTemplate(titleTemplate, templateData).trim()
    const renderedBody = renderAutomationTemplate(bodyTemplate, templateData).trim()
    const bodyWithLinks = [
      renderedBody,
      linkLines.length > 0 ? ['**快捷入口**', ...linkLines].join('\n') : '',
    ].filter(Boolean).join('\n\n')
    const orderedDestinations = destinationIds
      .map((id) => destinationsById.get(id))
      .filter((destination): destination is NonNullable<typeof destination> => Boolean(destination))
    const successfulDestinations: Array<{ id: string; name: string }> = []
    const failedDestinations: Array<{ id: string; name: string; error: string }> = []
    const runtimeWebhookByDestinationId = new Map<string, { webhookUrl: string; secret?: string }>()

    for (const destination of orderedDestinations) {
      try {
        runtimeWebhookByDestinationId.set(destination.id, {
          webhookUrl: normalizeDingTalkRobotWebhookUrl(destination.webhook_url),
          secret: normalizeDingTalkRobotSecret(destination.secret ?? undefined),
        })
      } catch (err) {
        failedDestinations.push({
          id: destination.id,
          name: destination.name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (failedDestinations.length) {
      await Promise.all(failedDestinations.map((destination) =>
        recordDingTalkGroupDeliverySafely(this.deps.queryFn, {
          destinationId: destination.id,
          sourceType: 'automation',
          subject: renderedTitle,
          content: bodyWithLinks,
          success: false,
          httpStatus: null,
          responseBody: null,
          errorMessage: destination.error,
          automationRuleId: context.ruleId,
          recordId: context.recordId,
          initiatedBy: context.actorId ?? null,
        }),
      ))
      return {
        actionType: 'send_dingtalk_group_message',
        status: 'failed',
        error: `${failedDestinations.length} of ${orderedDestinations.length} DingTalk destinations failed validation: ${failedDestinations.map((destination) => `${destination.name} (${destination.error})`).join('; ')}`,
        output: {
          staticDestinationCount: staticDestinationIds.length,
          dynamicDestinationCount: recordDestinationIds.length,
          destinationIds: orderedDestinations.map((destination) => destination.id),
          destinationNames: orderedDestinations.map((destination) => destination.name),
          destinationFieldPath: destinationFieldPaths[0] ?? null,
          destinationFieldPaths,
          sentCount: 0,
          failedDestinationIds: failedDestinations.map((destination) => destination.id),
          linkCount: linkLines.length,
        },
      }
    }

    for (const destination of orderedDestinations) {
      let deliveryRecorded = false
      let responseStatus: number | null = null
      let responseBody: string | null = null
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS)
      try {
        const runtimeWebhook = runtimeWebhookByDestinationId.get(destination.id)
        if (!runtimeWebhook) {
          throw new Error(`DingTalk destination ${destination.name || destination.id} was not validated before send`)
        }
        const response = await (this.deps.fetchFn ?? globalThis.fetch)(
          buildSignedDingTalkWebhookUrl(runtimeWebhook.webhookUrl, runtimeWebhook.secret),
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'MetaSheet-Automation-DingTalk/1.0',
            },
            body: JSON.stringify(buildDingTalkMarkdown(renderedTitle, bodyWithLinks)),
            signal: controller.signal,
          },
        )
        const parsed = await readJsonSafely(response)
        responseStatus = response.status
        responseBody = parsed ? JSON.stringify(parsed) : response.statusText || null
        if (!response.ok) {
          const errorMessage = `DingTalk request failed with HTTP ${response.status}`
          deliveryRecorded = true
          await recordDingTalkGroupDeliverySafely(this.deps.queryFn, {
            destinationId: destination.id,
            sourceType: 'automation',
            subject: renderedTitle,
            content: bodyWithLinks,
            success: false,
            httpStatus: response.status,
            responseBody,
            errorMessage,
            automationRuleId: context.ruleId,
            recordId: context.recordId,
            initiatedBy: context.actorId ?? null,
          })
          failedDestinations.push({ id: destination.id, name: destination.name, error: errorMessage })
          continue
        }
        try {
          validateDingTalkRobotResponse(parsed)
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err)
          deliveryRecorded = true
          await recordDingTalkGroupDeliverySafely(this.deps.queryFn, {
            destinationId: destination.id,
            sourceType: 'automation',
            subject: renderedTitle,
            content: bodyWithLinks,
            success: false,
            httpStatus: response.status,
            responseBody,
            errorMessage,
            automationRuleId: context.ruleId,
            recordId: context.recordId,
            initiatedBy: context.actorId ?? null,
          })
          failedDestinations.push({ id: destination.id, name: destination.name, error: errorMessage })
          continue
        }
        deliveryRecorded = true
        await recordDingTalkGroupDeliverySafely(this.deps.queryFn, {
          destinationId: destination.id,
          sourceType: 'automation',
          subject: renderedTitle,
          content: bodyWithLinks,
          success: true,
          httpStatus: response.status,
          responseBody,
          automationRuleId: context.ruleId,
          recordId: context.recordId,
          initiatedBy: context.actorId ?? null,
        })
        successfulDestinations.push({ id: destination.id, name: destination.name })
      } catch (err) {
        if (!deliveryRecorded) {
          await recordDingTalkGroupDeliverySafely(this.deps.queryFn, {
            destinationId: destination.id,
            sourceType: 'automation',
            subject: renderedTitle,
            content: bodyWithLinks,
            success: false,
            httpStatus: responseStatus,
            responseBody,
            errorMessage: err instanceof Error ? err.message : String(err),
            automationRuleId: context.ruleId,
            recordId: context.recordId,
            initiatedBy: context.actorId ?? null,
          })
        }
        failedDestinations.push({
          id: destination.id,
          name: destination.name,
          error: err instanceof Error ? err.message : String(err),
        })
      } finally {
        clearTimeout(timeout)
      }
    }

    if (failedDestinations.length) {
      return {
        actionType: 'send_dingtalk_group_message',
        status: 'failed',
        error: `${failedDestinations.length} of ${orderedDestinations.length} DingTalk destinations failed: ${failedDestinations.map((destination) => `${destination.name} (${destination.error})`).join('; ')}`,
        output: {
          staticDestinationCount: staticDestinationIds.length,
          dynamicDestinationCount: recordDestinationIds.length,
          destinationIds: orderedDestinations.map((destination) => destination.id),
          destinationNames: orderedDestinations.map((destination) => destination.name),
          destinationFieldPath: destinationFieldPaths[0] ?? null,
          destinationFieldPaths,
          sentCount: successfulDestinations.length,
          failedDestinationIds: failedDestinations.map((destination) => destination.id),
          linkCount: linkLines.length,
        },
      }
    }

    return {
      actionType: 'send_dingtalk_group_message',
      status: 'success',
      output: {
        destinationId: successfulDestinations[0]?.id,
        destinationName: successfulDestinations[0]?.name,
        staticDestinationCount: staticDestinationIds.length,
        dynamicDestinationCount: recordDestinationIds.length,
        destinationIds: successfulDestinations.map((destination) => destination.id),
        destinationNames: successfulDestinations.map((destination) => destination.name),
        destinationFieldPath: destinationFieldPaths[0] ?? null,
        destinationFieldPaths,
        sentCount: successfulDestinations.length,
        linkCount: linkLines.length,
      },
    }
  }
}
