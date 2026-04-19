/**
 * Automation Executor — V1
 * Core execution pipeline: evaluate conditions, run actions in sequence.
 */

import { randomUUID } from 'crypto'
import { Logger } from '../core/logger'
import type { EventBus } from '../integration/events/event-bus'
import {
  buildDingTalkMarkdown,
  buildSignedDingTalkWebhookUrl,
  validateDingTalkRobotResponse,
} from '../integrations/dingtalk/robot'
import type {
  AutomationAction,
  AutomationActionType,
  SendDingTalkGroupMessageConfig,
} from './automation-actions'
import type { ConditionGroup } from './automation-conditions'
import { evaluateConditions } from './automation-conditions'
import type { AutomationTrigger } from './automation-triggers'

const logger = new Logger('AutomationExecutor')

const WEBHOOK_TIMEOUT_MS = 5_000
const MAX_WEBHOOK_RETRIES = 2

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
  sheetId: string
  recordId: string
  recordData: Record<string, unknown>
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
      sheetId: rule.sheetId,
      recordId: (payload?.recordId as string) ?? '',
      recordData: (payload?.data as Record<string, unknown>) ?? (payload?.changes as Record<string, unknown>) ?? {},
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
      execution.status = hasFailed ? 'failed' : 'success'
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
    const destinationId = typeof config.destinationId === 'string' ? config.destinationId.trim() : ''
    const titleTemplate = typeof config.titleTemplate === 'string' ? config.titleTemplate.trim() : ''
    const bodyTemplate = typeof config.bodyTemplate === 'string' ? config.bodyTemplate.trim() : ''
    const publicFormViewId = typeof config.publicFormViewId === 'string' ? config.publicFormViewId.trim() : ''
    const internalViewId = typeof config.internalViewId === 'string' ? config.internalViewId.trim() : ''

    if (!destinationId) {
      return { actionType: 'send_dingtalk_group_message', status: 'failed', error: 'DingTalk destination is required' }
    }
    if (!titleTemplate) {
      return { actionType: 'send_dingtalk_group_message', status: 'failed', error: 'DingTalk title template is required' }
    }
    if (!bodyTemplate) {
      return { actionType: 'send_dingtalk_group_message', status: 'failed', error: 'DingTalk body template is required' }
    }

    const destinationResult = await this.deps.queryFn(
      `SELECT id, name, webhook_url, secret, enabled
         FROM dingtalk_group_destinations
        WHERE id = $1`,
      [destinationId],
    )
    const destination = (destinationResult.rows[0] ?? null) as {
      id: string
      name: string
      webhook_url: string
      secret: string | null
      enabled: boolean
    } | null

    if (!destination) {
      return { actionType: 'send_dingtalk_group_message', status: 'failed', error: 'DingTalk destination not found' }
    }
    if (destination.enabled !== true) {
      return { actionType: 'send_dingtalk_group_message', status: 'failed', error: 'DingTalk destination is disabled' }
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
          WHERE id = $1 AND sheet_id = $2`,
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
      const publicToken = publicForm && typeof publicForm === 'object' && !Array.isArray(publicForm)
        ? typeof (publicForm as Record<string, unknown>).publicToken === 'string'
          ? ((publicForm as Record<string, unknown>).publicToken as string).trim()
          : ''
        : ''
      const enabled = publicForm && typeof publicForm === 'object' && !Array.isArray(publicForm)
        ? (publicForm as Record<string, unknown>).enabled === true
        : false

      if (!enabled || !publicToken) {
        return {
          actionType: 'send_dingtalk_group_message',
          status: 'failed',
          error: 'Selected public form view is not shared',
        }
      }

      linkLines.push(`- [填写入口](${buildAppLink(baseUrl, `/multitable/public-form/${context.sheetId}/${publicFormViewId}`, { publicToken })})`)
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

    try {
      const response = await (this.deps.fetchFn ?? globalThis.fetch)(
        buildSignedDingTalkWebhookUrl(destination.webhook_url, destination.secret ?? undefined),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'MetaSheet-Automation-DingTalk/1.0',
          },
          body: JSON.stringify(buildDingTalkMarkdown(renderedTitle, bodyWithLinks)),
        },
      )
      const parsed = await readJsonSafely(response)
      if (!response.ok) {
        return {
          actionType: 'send_dingtalk_group_message',
          status: 'failed',
          error: `DingTalk request failed with HTTP ${response.status}`,
        }
      }
      validateDingTalkRobotResponse(parsed)
      return {
        actionType: 'send_dingtalk_group_message',
        status: 'success',
        output: {
          destinationId: destination.id,
          destinationName: destination.name,
          linkCount: linkLines.length,
        },
      }
    } catch (err) {
      return {
        actionType: 'send_dingtalk_group_message',
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
}
