/**
 * Automation Executor — V1
 * Core execution pipeline: evaluate conditions, run actions in sequence.
 */

import { randomUUID } from 'crypto'
import { recordRecordRevision, recordVersionMarker } from './record-history-service'
import { branchChildStepKey, topLevelStepKey } from './automation-step-key'
import { deriveRuleActionSetFingerprint } from './automation-rule-fingerprint'
import { claimExecutionAction, isClassAExecutionClaimEnabled } from './automation-execution-ledger'
import { deriveActionKey } from './automation-action-idempotency'
import {
  classifyFetchError,
  classifyOutboundResult,
  claimOutboundIntent,
  isClassBOutboundEnabled,
  outboundReasonClass,
  recordOutboundOutcome,
  type OutboundAttemptResult,
  type OutboundIntentIdentity,
  type OutboundOutcome,
} from './automation-outbound-intent'
import type { TransactionalQueryable } from './pg-transaction-guard'
import { Logger } from '../core/logger'
import { withAutomationEventId } from './automation-event-dedup'
import { enqueueRecordEventIfDurable, emitRecordEventIfLegacy } from './automation-producer-emit'
import { isDurableDeliveryEnabled } from './automation-durable-delivery'
import { produceAutomationEvent } from './automation-durable-activation'
import { isFwbWritebackEnabled, normalizeFwbMappings } from './approval-fwb-activation'
import { executeWriteApprovalFormValues, type FwbRecordWriteSeam } from './approval-fwb-write-action'
import type { FwbGateChecks } from './approval-fwb-permission-gates'
import { redactString } from './automation-log-redact'
import { computeActionFingerprint } from './automation-suspension-service'
import type { ConditionBranchResumeCursor } from './automation-resume-cursor'
import { isRichLongTextProperty, normalizeJson, sanitizeRichLongText } from './field-codecs'
import { ensureRecordNotLocked } from './record-lock'
import { fenceWriterEntry, isWriterFenceEnabled } from './canonical-sheet-fence'
import {
  assertTransactionalQuery,
  captureSideDoorInboundTombstones,
  insertSideDoorTrashRow,
  isSideDoorDeleteTrashEnabled,
  resolveSheetBaseIdForTrash,
} from './side-door-delete-trash'
import { resolveCrossBaseWriteAuthority } from './cross-base-write-authority'
import { publishMultitableSheetRealtime } from './realtime-publish'
import { MemoryRateLimitStore, type RateLimitStore } from '../middleware/rate-limiter'
import {
  DingTalkBusinessError,
  DingTalkRequestError,
  fetchDingTalkAppAccessToken,
  sendDingTalkInteractiveApprovalCard,
  isDingTalkOutcomeUnknown,
  sendDingTalkWorkNotification,
  sendDingTalkWorkNotificationActionCard,
} from '../integrations/dingtalk/client'
import { resolveDingTalkInteractiveCardStreamConfig } from '../integrations/dingtalk/interactive-card-stream'
import { readDingTalkMessageConfigFromRuntime } from '../integrations/dingtalk/work-notification-settings'
import {
  resolveApprovalCardLinkSecret,
  resolveApprovalCardLinkSecretForIntegration,
  resolveApprovalCardPublicAppUrl,
} from '../integrations/dingtalk/approval-card-config'
import {
  insertDingTalkApprovalCardDelivery,
  markDingTalkApprovalCardDeliverySendFailed,
  markDingTalkApprovalCardDeliverySendOutcomeUnknown,
  markDingTalkApprovalCardDeliverySent,
} from '../integrations/dingtalk/approval-card-deliveries'
import { createHmac } from 'crypto'
import type { EventBus } from '../integration/events/event-bus'
import {
  buildDingTalkMarkdown,
  buildSignedDingTalkWebhookUrl,
  normalizeDingTalkRobotSecret,
  normalizeDingTalkRobotWebhookUrl,
  validateDingTalkRobotResponse,
} from '../integrations/dingtalk/robot'
import {
  decryptDingTalkDestinationSecret,
  decryptDingTalkDestinationWebhookUrl,
} from './dingtalk-group-destinations'
import type {
  AutomationAction,
  AutomationActionType,
  SendEmailConfig,
  SendDingTalkGroupMessageConfig,
  SendDingTalkPersonMessageConfig,
} from './automation-actions'
import type { ConditionGroup } from './automation-conditions'
import { evaluateConditions } from './automation-conditions'
import type { AutomationTrigger } from './automation-triggers'
import type { Notification, NotificationResult, NotificationService } from '../types/plugin'
import { WebhookService } from './webhook-service'

const logger = new Logger('AutomationExecutor')

const DEFAULT_WEBHOOK_TIMEOUT_MS = 5_000
const DEFAULT_MAX_WEBHOOK_RETRIES = 2
// DingTalk group/person dispatch keeps its fixed timeout (unchanged by rank-6).
const WEBHOOK_TIMEOUT_MS = DEFAULT_WEBHOOK_TIMEOUT_MS

/**
 * send_webhook timeout, env-overridable via AUTOMATION_WEBHOOK_TIMEOUT_MS.
 * Bounded [1s, 30s]; a bad value falls back to the default (mirrors the
 * webhook-service delivery timeout posture).
 */
function webhookTimeoutMs(): number {
  const raw = process.env.AUTOMATION_WEBHOOK_TIMEOUT_MS
  if (raw === undefined) return DEFAULT_WEBHOOK_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_WEBHOOK_TIMEOUT_MS
  return Math.min(Math.max(parsed, 1_000), 30_000)
}

/**
 * send_webhook bounded retry count, env-overridable via
 * AUTOMATION_WEBHOOK_MAX_RETRIES. Bounded [0, 5]; bad value → default.
 */
function maxWebhookRetries(): number {
  const raw = process.env.AUTOMATION_WEBHOOK_MAX_RETRIES
  if (raw === undefined) return DEFAULT_MAX_WEBHOOK_RETRIES
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_WEBHOOK_RETRIES
  return Math.min(parsed, 5)
}
const DINGTALK_PERSON_BATCH_SIZE = 100
const DINGTALK_FAILURE_ALERT_CONTENT_LIMIT = 1_000
// DingTalk group/person message limits: robot markdown title tops out around
// 128 chars and markdown body around 20000 chars upstream. A rendered
// template that exceeds either would otherwise be rejected (or silently
// mangled) by DingTalk outright; truncate with an ellipsis so delivery still
// goes through instead of failing on oversized input.
const DINGTALK_MESSAGE_TITLE_MAX_LENGTH = 128
const DINGTALK_MESSAGE_BODY_MAX_LENGTH = 20_000
const SAFE_PARALLEL_BRANCH_KEY = /^[A-Za-z0-9_-]{1,64}$/
const MAX_PARALLEL_BRANCHES = 10
const MAX_PARALLEL_BRANCH_ACTIONS = 20
const PARALLEL_BRANCH_RUNTIME_ACTION_TYPES = new Set<AutomationActionType>(['update_record', 'send_notification'])

type RuntimeParallelBranch = {
  key: string
  label?: string
  actions: AutomationAction[]
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJsonSafely(response: Response): Promise<unknown> {
  return response.json().catch(() => null)
}

export function lookupTemplateValue(path: string, data: Record<string, unknown>): unknown {
  const segments = path.split('.').filter(Boolean)
  let current: unknown = data
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

export function renderTemplateValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

export function renderAutomationTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) =>
    renderTemplateValue(lookupTemplateValue(key, data)),
  )
}

function validateParallelBranchRuntimeConfig(config: unknown): { branches: RuntimeParallelBranch[] } | { error: string } {
  if (!isPlainRecord(config)) {
    return { error: 'parallel_branch config must be an object' }
  }
  if (config.joinMode !== 'all') {
    return { error: 'parallel_branch requires joinMode all and non-empty branches' }
  }
  if (!Array.isArray(config.branches) || config.branches.length === 0) {
    return { error: 'parallel_branch requires joinMode all and non-empty branches' }
  }
  if (config.branches.length > MAX_PARALLEL_BRANCHES) {
    return { error: `parallel_branch.branches exceeds max ${MAX_PARALLEL_BRANCHES}` }
  }

  const seen = new Set<string>()
  const branches: RuntimeParallelBranch[] = []
  let totalActions = 0
  for (const [branchIndex, branch] of config.branches.entries()) {
    const branchPath = `parallel_branch.branches[${branchIndex}]`
    if (!isPlainRecord(branch)) {
      return { error: `${branchPath} must be an object` }
    }
    if (typeof branch.key !== 'string' || !SAFE_PARALLEL_BRANCH_KEY.test(branch.key)) {
      return { error: `${branchPath}.key must be a safe non-empty string` }
    }
    if (seen.has(branch.key)) {
      return { error: `${branchPath}.key must be unique` }
    }
    seen.add(branch.key)
    if (branch.label !== undefined && typeof branch.label !== 'string') {
      return { error: `${branchPath}.label must be a string` }
    }
    const label = typeof branch.label === 'string' ? branch.label : undefined
    if (!Array.isArray(branch.actions) || branch.actions.length === 0) {
      return { error: `${branchPath}.actions must be a non-empty array` }
    }
    totalActions += branch.actions.length
    if (totalActions > MAX_PARALLEL_BRANCH_ACTIONS) {
      return { error: `parallel_branch.branches total actions exceeds max ${MAX_PARALLEL_BRANCH_ACTIONS}` }
    }

    const actions: AutomationAction[] = []
    for (const [actionIndex, branchAction] of branch.actions.entries()) {
      const actionPath = `${branchPath}.actions[${actionIndex}]`
      if (!isPlainRecord(branchAction) || typeof branchAction.type !== 'string') {
        return { error: `${actionPath}.type is invalid` }
      }
      if (!PARALLEL_BRANCH_RUNTIME_ACTION_TYPES.has(branchAction.type as AutomationActionType)) {
        return { error: `${branchPath}.actions cannot contain ${branchAction.type} in A6-3-4` }
      }
      actions.push({
        type: branchAction.type as AutomationActionType,
        config: isPlainRecord(branchAction.config) ? branchAction.config : {},
      })
    }

    branches.push({
      key: branch.key,
      ...(label ? { label } : {}),
      actions,
    })
  }

  return { branches }
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

export function truncateDingTalkMessageText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  if (maxLength <= 1) return value.slice(0, maxLength)
  return `${value.slice(0, maxLength - 1)}…`
}

/**
 * Assemble the message body + its 快捷入口 link block within DingTalk's body limit.
 * The link block is the actionable part of the message, so it gets its budget first
 * and the rendered body absorbs the truncation — truncating the assembled string
 * instead would silently drop the links whenever a template body ran long.
 */
export function composeDingTalkBodyWithLinks(renderedBody: string, linkLines: string[]): string {
  const linkSection = linkLines.length > 0 ? ['**快捷入口**', ...linkLines].join('\n') : ''
  const separatorLength = linkSection && renderedBody ? 2 : 0
  const bodyBudget = Math.max(0, DINGTALK_MESSAGE_BODY_MAX_LENGTH - linkSection.length - separatorLength)
  return [truncateDingTalkMessageText(renderedBody, bodyBudget), linkSection]
    .filter(Boolean)
    .join('\n\n')
}

function redactDingTalkFailureAlertText(value: unknown): string {
  // Delegate to the shared automation-log redactor (single source of truth —
  // covers Bearer/JWT/SEC/access_token/DingTalk-robot-webhook and more); keep
  // only the DingTalk alert-specific length cap here.
  return redactString(value).slice(0, DINGTALK_FAILURE_ALERT_CONTENT_LIMIT)
}

function mergeFailureAlertOutput(
  output: unknown,
  failureAlert: Record<string, unknown>,
): Record<string, unknown> {
  const base = output && typeof output === 'object' && !Array.isArray(output)
    ? output as Record<string, unknown>
    : {}
  return {
    ...base,
    failureAlert,
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
    /** `outcome_unknown` (PR #4046 Phase B): send threw with the transport's outcome-unknown marker — maybe delivered, never auto-resent. */
    status?: 'success' | 'failed' | 'skipped' | 'outcome_unknown'
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
  /** A6-1 opt-in: 'workflow_job_v1' persists one job per action; undefined/'legacy' = no jobs. */
  executionMode?: string
}

/**
 * A6-1 per-action job lifecycle hooks. The job-persisting path supplies these so
 * one C1 job row is written around each action; the legacy path passes none → no jobs.
 *
 * Fail-closed contract: these run OUTSIDE the inner per-action try/catch, so a thrown
 * hook propagates to execute()'s outer catch and fails the EXECUTION (opt-in durable
 * provenance), instead of being swallowed into a failed STEP result.
 */
export interface ActionJobLifecycle {
  /** Before any condition/action side effects — persist a visible parent execution row. */
  onExecutionStarted?(execution: AutomationExecution): Promise<void>
  /** Before the action's side effect runs — create the job as `running` (observable on crash). */
  onStart(stepIndex: number, action: AutomationAction, meta?: ActionJobLifecycleMeta): Promise<void>
  /** After the action settled — update the job to resolved/failed. */
  onSettled(stepIndex: number, action: AutomationAction, result: AutomationStepResult, meta?: ActionJobLifecycleMeta): Promise<void>
  /** A fail-stop-skipped action — record a terminal `skipped` job. */
  onSkipped(stepIndex: number, action: AutomationAction, meta?: ActionJobLifecycleMeta): Promise<void>
  /**
   * A6-2: a `wait_for_callback` step in an opted-in rule — persist the suspension row
   * + a `suspended` C1 job, then the executor STOPS (the tail runs on admin resume).
   * Optional: legacy rules supply no lifecycle, so a legacy `wait_for_callback` fails closed (D7).
   */
  onSuspend?(stepIndex: number, action: AutomationAction): Promise<void>
  /**
   * A6-3-3: a `wait_for_callback` inside the SELECTED `condition_branch` — persist the
   * branch suspension row + a `suspended` branch-child C1 job (via the resume cursor),
   * then the executor STOPS. The branch tail + top-level tail run on admin resume.
   * Optional: absent → branch-local wait fails closed.
   */
  onSuspendBranch?(cursor: ConditionBranchResumeCursor, action: AutomationAction): Promise<void>
  /**
   * W6-1: `start_approval` in an opted-in rule — create one approval, persist the
   * approval bridge + a `suspended` C1 job, then STOP. Completion resumes from W5.
   */
  onStartApproval?(
    stepIndex: number,
    action: AutomationAction,
    context: ExecutionContext,
  ): Promise<{ suspended: boolean; result?: AutomationStepResult }>
}

export interface ActionJobLifecycleMeta {
  /** Stable C1 step key. Defaults to the top-level step index. */
  stepKey?: string
  /** Deterministic job id. Defaults to `${executionId}:job:${stepIndex}`. */
  jobId?: string
  /** Explicit graph edge. Defaults to the previous top-level job. */
  upstreamJobId?: string | null
}

/** Builds the per-execution job lifecycle once the executionId is known (service-supplied for opt-in rules). */
export type ActionJobLifecycleFactory = (executionId: string) => ActionJobLifecycle

/** Snapshot schema version stamped on every execution row (A1 run-governance). */
export const AUTOMATION_EXECUTION_SCHEMA_VERSION = 1

export interface AutomationExecution {
  id: string
  ruleId: string
  triggeredBy: string
  triggeredAt: string
  status: 'running' | 'success' | 'failed' | 'skipped'
  steps: AutomationStepResult[]
  error?: string
  duration?: number
  // ── A1 run-governance snapshot (persisted; secret-shaped values redacted at write) ──
  /** Sheet the rule belongs to. */
  sheetId?: string
  /** The triggering event captured at execution time. */
  triggerEvent?: unknown
  /** The rule as it was at execution time (diagnosis / future retry source). */
  ruleSnapshot?: AutomationRule
  /**
   * #4196 §4: the §2.1 action-set fingerprint over the RAW config, captured at execution time. A retry
   * compares the current rule's fingerprint to THIS to refuse a config-changed rule (409 RULE_CHANGED). NOT
   * re-derived from ruleSnapshot (which is redacted → would diverge from the raw Class-A claim identity); a
   * values-free sha256, safe to persist un-redacted.
   */
  ruleActionFingerprint?: string
  /** When the execution finished (cleaner provenance anchor than duration alone). */
  finishedAt?: string
  /** Forward-compat tag for the snapshot shape. */
  schemaVersion?: number
  // ── A5 retry provenance (set by AutomationService.retryExecution; plain ids, not redacted) ──
  /** The original execution id this run re-ran (only on a retry-created execution). */
  rerunOfExecutionId?: string
  /** The admin user id that initiated the retry (only on a retry-created execution). */
  initiatedBy?: string
}

export interface AutomationStepResult {
  actionType: AutomationActionType
  status: 'success' | 'failed' | 'skipped'
  output?: unknown
  error?: string
  durationMs?: number
  /**
   * #4196 Class-A at-most-once marker. Set true ONLY when a Class-A action was SKIPPED because its
   * (rootExecutionId, actionKey) claim was already held by a prior apply — i.e. a retry/replay hit a
   * duplicate. The step still reports `status:'success'` so the execution proceeds, but NO mutation,
   * NO revision, and NO downstream effect ran. Distinguishable so callers/tests can assert the skip.
   */
  alreadyApplied?: boolean
}

/**
 * #4196 Class-A action identity threaded to the four Class-A executors so each can claim its
 * (lineage-root, structural-path, action-type, config) tuple in the SAME transaction as its mutation.
 * Absent (undefined) ⇒ no claim (e.g. the ad-hoc single-action dispatch, which is not a replayable
 * execution action). `structuralPath` is the executor's canonical step-key (automation-step-key.ts);
 * `rootExecutionId` is the execution lineage root (the original execution's id; a retry threads it).
 */
export interface ClassAActionIdentity {
  structuralPath: string
  rootExecutionId: string
}

export interface ExecutionContext {
  executionId: string
  ruleId: string
  sheetId: string
  recordId: string
  recordData: Record<string, unknown>
  ruleCreatedBy: string
  actorId?: string | null
  triggerEvent: unknown
  /**
   * #4196 execution lineage root — the id of the FIRST execution in this retry lineage (defaults to the
   * execution's own id when there is no parent; a retry threads the original root through
   * AutomationService). Class-A claims key on this so a retry of the SAME action is a duplicate. Optional
   * for back-compat: builders that omit it fall back to `executionId` at the claim call site.
   */
  rootExecutionId?: string
}

// ── Dependencies interface for action executors ───────────────────────────

/**
 * Cross-base write QUOTA configuration. Caps the RATE of AUTHORIZED cross-base automation writes per
 * TARGET base inside a rolling window. Optional on AutomationDeps: when omitted the executor uses a
 * process-global default (env-configurable, see CROSS_BASE_WRITE_QUOTA_*). Same-base writes are never
 * counted (the gate short-circuits same-base before the quota), so this is zero-regression.
 */
export interface CrossBaseWriteQuotaConfig {
  /** Max authorized cross-base writes allowed per target base within `windowMs`. */
  limit: number
  /** Rolling window length in milliseconds. */
  windowMs: number
  /**
   * Counter store. Reuses the rate-limiter `RateLimitStore` (increment-then-check) primitive. Inject a
   * private `MemoryRateLimitStore` in tests so a low limit cannot perturb the process-global default.
   * Omit to share the executor's default singleton store.
   */
  store?: RateLimitStore
}

// ── Cross-base write quota defaults (process-global; env-configurable) ─────
// Defensible generous default: 60 authorized cross-base writes per target base per 60s. Tuned to protect
// a target base from an automation storm while never tripping legitimate human-paced or modest-fan-out
// automation. CAVEAT: the default store is IN-PROCESS, so under N replicas the effective ceiling is
// ~limit×N. The shared Redis-backed RateLimitStore exists (rate-limiter.ts) if a cluster-wide cap is ever
// required; that is out of scope for v1.
const DEFAULT_CROSS_BASE_WRITE_QUOTA_LIMIT = 60
const DEFAULT_CROSS_BASE_WRITE_QUOTA_WINDOW_MS = 60_000

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** Resolve the process-global default quota from env once (re-read per call is cheap and test-friendly). */
function defaultCrossBaseWriteQuota(): { limit: number; windowMs: number } {
  return {
    limit: readPositiveIntEnv('CROSS_BASE_WRITE_QUOTA_LIMIT', DEFAULT_CROSS_BASE_WRITE_QUOTA_LIMIT),
    windowMs: readPositiveIntEnv('CROSS_BASE_WRITE_QUOTA_WINDOW_MS', DEFAULT_CROSS_BASE_WRITE_QUOTA_WINDOW_MS),
  }
}

// Module-level default counter store. A SINGLETON so cross-base write accounting is independent of how
// many AutomationExecutor instances exist (a per-instance Map would reset on every re-construction and
// silently defeat the guardrail). `unref`'d cleanup timer prunes expired windows.
const defaultCrossBaseWriteQuotaStore = new MemoryRateLimitStore(DEFAULT_CROSS_BASE_WRITE_QUOTA_WINDOW_MS)

/**
 * Shared per-target-base cross-base write quota — the SAME discipline (increment-then-check, keyed by the
 * resolved target base, env-tunable via CROSS_BASE_WRITE_QUOTA_*) and the SAME default counter store as the
 * automation executor's gate, exposed for the C2 mirror write-through op's base-A leg (#3440 Lock B: quota
 * is caller-composed, keyed to base A, never applied to the base-B leg). Sharing the store means automation
 * writes and mirror-op writes draw from ONE per-base budget in-process, which is the point of the guardrail
 * (protect the target base), not an accident. Returns true when the write is within quota. Fail-open ONLY on
 * a counter-store error (store failure, not actor failure — mirrors checkCrossBaseWriteQuota).
 */
/**
 * Test-only: clear the shared cross-base write quota counters (the `_map` getter exists for exactly this).
 * Lets a real-DB golden assert an absolute limit boundary without prior-test accumulation on the process-
 * global singleton. Never called by runtime code.
 */
export function __resetSharedCrossBaseWriteQuotaForTest(): void {
  defaultCrossBaseWriteQuotaStore._map.clear()
}

export async function consumeSharedCrossBaseWriteQuota(
  targetBaseId: string,
  override?: { limit?: number; windowMs?: number; store?: RateLimitStore },
): Promise<boolean> {
  const def = defaultCrossBaseWriteQuota()
  const limit = override?.limit ?? def.limit
  const windowMs = override?.windowMs ?? def.windowMs
  const store = override?.store ?? defaultCrossBaseWriteQuotaStore
  const key = `crossbase-write-quota:${targetBaseId}`
  let count: number
  try {
    count = (await store.increment(key, windowMs)).count
  } catch (err) {
    logger.warn('Cross-base write quota store error; allowing this write', {
      targetBaseId,
      error: err instanceof Error ? err.message : String(err),
    })
    return true
  }
  return count <= limit
}

export interface AutomationDeps {
  eventBus: EventBus
  queryFn: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>
  transaction?: <T>(
    handler: (client: { query: AutomationDeps['queryFn'] }) => Promise<T>,
  ) => Promise<T>
  fetchFn?: typeof fetch
  notificationService?: Pick<NotificationService, 'send'>
  /** Optional cross-base write quota override (limit/window/store). Omit → process-global default. */
  crossBaseWriteQuota?: CrossBaseWriteQuotaConfig
  /** FWB activation (§11 Q6): the four-gate set re-checked at execute time. OMITTED ⇒ DEFAULT-DENY —
   *  a wiring that forgets to bind gates can never silently allow (fail-closed, kills default-allow). */
  fwbGateChecks?: FwbGateChecks
}

/** FWB fail-closed default: every gate denies. Production binds real checks at AutomationService
 *  construction; only a test seam should ever see this deny-all set actually reject. */
const DEFAULT_DENY_FWB_GATES: FwbGateChecks = {
  isAdmin: async () => false,
  canManageSheetAccess: async () => false,
  canReadTemplate: async () => false,
  canWriteSheet: async () => false,
  hasRecordedConfirmation: async () => false,
}

// ②b cross-base write-gate verdict. `crossBase: false` → same-base, no gate (zero regression).
// `crossBase: true` → cross-base; `ok` discriminates allowed vs the fail-closed rejection (with reason).
export type CrossBaseWriteGate =
  | { crossBase: false }
  | { crossBase: true; ok: true }
  | { crossBase: true; ok: false; error: string }

// ── Executor class ────────────────────────────────────────────────────────

export class AutomationExecutor {
  private deps: AutomationDeps
  /** Resolved cross-base write quota (injected override or process-global default). */
  private readonly crossBaseQuotaLimit: number
  private readonly crossBaseQuotaWindowMs: number
  private readonly crossBaseQuotaStore: RateLimitStore

  constructor(deps: AutomationDeps) {
    this.deps = deps
    const override = deps.crossBaseWriteQuota
    const def = defaultCrossBaseWriteQuota()
    this.crossBaseQuotaLimit = override?.limit ?? def.limit
    this.crossBaseQuotaWindowMs = override?.windowMs ?? def.windowMs
    // Injected store wins (test isolation); else the module-level singleton default.
    this.crossBaseQuotaStore = override?.store ?? defaultCrossBaseWriteQuotaStore
  }

  /**
   * Execute a rule against a trigger event.
   * Returns an execution record with step results.
   */
  async execute(
    rule: AutomationRule,
    triggerEvent: unknown,
    jobLifecycleFactory?: ActionJobLifecycleFactory,
    rootExecutionId?: string,
  ): Promise<AutomationExecution> {
    const executionId = `axe_${randomUUID()}`
    // A6-1: opt-in rules get a per-action job lifecycle bound to this executionId. The factory
    // is supplied by the service ONLY for 'workflow_job_v1' rules → legacy rules never write jobs.
    const jobLifecycle = jobLifecycleFactory ? jobLifecycleFactory(executionId) : undefined
    const startTime = Date.now()
    const execution: AutomationExecution = {
      id: executionId,
      ruleId: rule.id,
      triggeredBy: (triggerEvent as Record<string, unknown>)?._triggeredBy as string ?? 'event',
      triggeredAt: new Date().toISOString(),
      status: 'running',
      steps: [],
      // A1 run-governance snapshot — secret-shaped values redacted at persist
      // time in AutomationLogService.record(), not here.
      sheetId: rule.sheetId,
      triggerEvent,
      ruleSnapshot: rule,
      // #4196 §4: the RAW-config §2.1 fingerprint (the Class-A claim identity) captured before any redaction.
      ruleActionFingerprint: deriveRuleActionSetFingerprint(rule.actions).hash,
      schemaVersion: AUTOMATION_EXECUTION_SCHEMA_VERSION,
    }

    // A6-1: opt-in job persistence needs a visible parent execution before any
    // job row/action side effect. If this write fails, no action has run yet.
    if (jobLifecycle?.onExecutionStarted) await jobLifecycle.onExecutionStarted(execution)

    // Build execution context from trigger event
    const payload = triggerEvent as Record<string, unknown>
    const context: ExecutionContext = {
      executionId,
      ruleId: rule.id,
      sheetId: rule.sheetId,
      recordId: (payload?.recordId as string) ?? '',
      recordData: (payload?.data as Record<string, unknown>) ?? (payload?.changes as Record<string, unknown>) ?? {},
      ruleCreatedBy: rule.createdBy,
      actorId: (payload?.actorId as string) ?? null,
      triggerEvent,
      // #4196: the lineage root. A retry threads the original execution's root in; a first run has no
      // parent, so it defaults to its own id. Class-A claims key on this (retry of the same action → dup).
      rootExecutionId: rootExecutionId ?? executionId,
    }

    // Evaluate conditions
    if (rule.conditions) {
      const conditionsPassed = evaluateConditions(rule.conditions, context.recordData)
      if (!conditionsPassed) {
        execution.status = 'skipped'
        execution.duration = Date.now() - startTime
        execution.finishedAt = new Date().toISOString()
        return execution
      }
    }

    // Execute actions in sequence
    try {
      const { suspended } = await this.executeActions(rule.actions, context, execution.steps, jobLifecycle)
      if (suspended) {
        // A6-2 (D2): paused waiting on an external callback. Leave status 'running' (the suspended
        // state lives out-of-band in the C1 job + suspension table) and do NOT stamp finishedAt —
        // it is not finished. The tail runs on admin resume via continueExecution().
        execution.duration = Date.now() - startTime
        return execution
      }

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
    execution.finishedAt = new Date().toISOString()
    return execution
  }

  /**
   * A6-2 resume: continue a suspended execution from the step AFTER the wait
   * (`suspendIndex + 1`). The caller (AutomationSuspensionService) has already
   * claimed the token, re-loaded the CURRENT rule, verified the action fingerprint
   * (D4b), and re-derived `context` (current record + redacted trigger event, D4).
   *
   * `execution` carries the persisted prior steps `[0..suspendIndex-1]` (all succeeded —
   * a failure would have fail-stopped before the wait). We settle the wait step
   * (`suspendIndex`) to success — pushing its legacy step result so the steps array stays
   * index-aligned, and settling the `suspended` C1 job → `resolved` via onSettled — then
   * run the tail. A tail that throws settles the execution `failed` (D8: no auto-retry).
   */
  async continueExecution(
    execution: AutomationExecution,
    rule: AutomationRule,
    context: ExecutionContext,
    suspendIndex: number,
    jobLifecycle?: ActionJobLifecycle,
    settledStepResult?: AutomationStepResult,
  ): Promise<AutomationExecution> {
    const startTime = Date.now()
    execution.status = 'running'

    try {
      // Settle the wait step (INSIDE the try, B3): a legacy 'success' result (keeps steps
      // index-aligned, D2) + flip its `suspended` C1 job → `resolved` (success→resolved via the
      // bridge in onSettled). If this settle throws (e.g. a DB error), it now fails the execution
      // terminally below — NOT a bubbled 500 that leaves the token consumed and the tail unrun.
      const waitAction = rule.actions[suspendIndex]
      const waitResult: AutomationStepResult = settledStepResult ?? {
        actionType: waitAction.type,
        status: 'success',
        durationMs: 0,
      }
      execution.steps.push(waitResult)
      if (jobLifecycle) await jobLifecycle.onSettled(suspendIndex, waitAction, waitResult)

      const { suspended } = await this.executeActions(
        rule.actions, context, execution.steps, jobLifecycle, suspendIndex + 1,
      )
      if (suspended) {
        // A sequential second wait in the tail — suspend again (leave 'running', new suspension row).
        execution.duration = (execution.duration ?? 0) + (Date.now() - startTime)
        return execution
      }

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

    execution.duration = (execution.duration ?? 0) + (Date.now() - startTime)
    execution.finishedAt = new Date().toISOString()
    return execution
  }

  /**
   * A6-3-3 branch-local resume. The caller (resumeExecution) has claimed the single-use token,
   * re-loaded the CURRENT rule, verified BOTH the top-level fingerprint AND the selected-branch
   * fingerprint (drift guard, before the claim), and re-derived `context`. Order (scope-gate §4.3):
   *   1. settle the suspended branch wait child job → resolved (by branch step_key);
   *   2. run the branch tail (`branchActions[branchActionIndex+1..]`) under branch job keys;
   *   3. settle the parent condition_branch job + push its step result;
   *   4. continue the top-level tail after the parent.
   * A second wait inside the branch tail re-suspends (execution stays `running`, new suspension
   * row). Any failure or thrown settle leaves the execution terminal `failed` (B3; no 500 with the
   * token consumed and the tail unrun).
   */
  async continueBranchExecution(
    execution: AutomationExecution,
    rule: AutomationRule,
    context: ExecutionContext,
    cursor: ConditionBranchResumeCursor,
    jobLifecycle: ActionJobLifecycle,
  ): Promise<AutomationExecution> {
    const startTime = Date.now()
    execution.status = 'running'

    try {
      const parentAction = rule.actions[cursor.parentStepIndex]
      const config = (parentAction?.config ?? {}) as {
        branches?: Array<{ key?: unknown; actions?: AutomationAction[] }>
        defaultBranch?: { key?: unknown; actions?: AutomationAction[] } | null
      }
      const candidates = [
        ...(Array.isArray(config.branches) ? config.branches : []),
        ...(config.defaultBranch ? [config.defaultBranch] : []),
      ]
      const branch = candidates.find((candidate) => candidate.key === cursor.branchKey)
      // Guarded upstream by the branch fingerprint check; defensive fail-closed if it drifted.
      if (!parentAction || parentAction.type !== 'condition_branch' || !branch || !Array.isArray(branch.actions)) {
        throw new Error('A6-3-3 resume: selected branch is no longer present in the current rule')
      }
      const branchActions = branch.actions
      const waitAction = branchActions[cursor.branchActionIndex]

      // 1. Settle the suspended branch wait child job → resolved (keeps the C1 branch lineage clean).
      const waitResult: AutomationStepResult = {
        actionType: waitAction?.type ?? 'wait_for_callback',
        status: 'success',
        durationMs: 0,
      }
      await jobLifecycle.onSettled(
        cursor.parentStepIndex,
        waitAction ?? parentAction,
        waitResult,
        { stepKey: cursor.stepKey, jobId: cursor.branchJobId, upstreamJobId: cursor.upstreamJobId },
      )

      // 2. Run the branch tail under branch job keys.
      let upstreamJobId: string | null = cursor.branchJobId
      let branchFailed = false
      let branchError: string | undefined
      let branchSuspendedAgain = false
      let failedAtBranchIndex = -1
      for (let i = cursor.branchActionIndex + 1; i < branchActions.length; i++) {
        const branchAction = branchActions[i]
        const stepKey = branchChildStepKey(cursor.parentStepIndex, 'branch', cursor.branchKey, i)
        const jobId = `${context.executionId}:job:${cursor.parentStepIndex}:branch:${cursor.branchKey}:${i}`
        const meta = { stepKey, jobId, upstreamJobId }

        if (branchAction.type === 'wait_for_callback') {
          if (!jobLifecycle.onSuspendBranch) {
            branchFailed = true
            branchError = 'branch-local wait_for_callback requires execution_mode workflow_job_v1'
            failedAtBranchIndex = i
            break
          }
          await jobLifecycle.onSuspendBranch(
            {
              kind: 'condition_branch',
              parentStepIndex: cursor.parentStepIndex,
              branchKey: cursor.branchKey,
              branchActionIndex: i,
              stepKey,
              parentJobId: cursor.parentJobId,
              branchJobId: jobId,
              upstreamJobId,
              branchActionFingerprint: cursor.branchActionFingerprint,
            },
            branchAction,
          )
          branchSuspendedAgain = true
          break
        }
        if (
          branchAction.type === 'condition_branch' ||
          branchAction.type === 'parallel_branch' ||
          branchAction.type === 'start_approval'
        ) {
          branchFailed = true
          branchError = `${branchAction.type} is not supported inside a condition_branch`
          failedAtBranchIndex = i
          break
        }

        await jobLifecycle.onStart(cursor.parentStepIndex, branchAction, meta)
        const branchActionResult = await this.executeSingleAction(branchAction, context, {
          structuralPath: stepKey,
          rootExecutionId: context.rootExecutionId ?? context.executionId,
        })
        await jobLifecycle.onSettled(cursor.parentStepIndex, branchAction, branchActionResult, meta)
        upstreamJobId = jobId
        if (branchActionResult.status === 'failed') {
          branchFailed = true
          branchError = branchActionResult.error ?? `Branch action ${i} failed`
          failedAtBranchIndex = i
          break
        }
      }

      if (branchSuspendedAgain) {
        execution.duration = (execution.duration ?? 0) + (Date.now() - startTime)
        return execution
      }

      // On branch-tail failure, fail-stop the REMAINING selected-branch actions as `skipped` C1
      // jobs (branch keys), mirroring the initial executeConditionBranch — keeps the branch job
      // plane complete instead of leaving downstream branch work invisible.
      if (branchFailed && failedAtBranchIndex >= 0) {
        for (let j = failedAtBranchIndex + 1; j < branchActions.length; j++) {
          const skippedStepKey = branchChildStepKey(cursor.parentStepIndex, 'branch', cursor.branchKey, j)
          const skippedJobId = `${context.executionId}:job:${cursor.parentStepIndex}:branch:${cursor.branchKey}:${j}`
          await jobLifecycle.onSkipped(cursor.parentStepIndex, branchActions[j], {
            stepKey: skippedStepKey,
            jobId: skippedJobId,
            upstreamJobId,
          })
          upstreamJobId = skippedJobId
        }
      }

      // 3. Settle the parent condition_branch job + push its step result.
      const parentStepResult: AutomationStepResult = branchFailed
        ? {
            actionType: 'condition_branch',
            status: 'failed',
            error: branchError ?? 'Branch tail failed',
            output: { selectedBranchKey: cursor.branchKey },
            durationMs: 0,
          }
        : {
            actionType: 'condition_branch',
            status: 'success',
            output: { selectedBranchKey: cursor.branchKey, matched: true },
            durationMs: 0,
          }
      execution.steps.push(parentStepResult)
      await jobLifecycle.onSettled(cursor.parentStepIndex, parentAction, parentStepResult, {
        jobId: cursor.parentJobId,
        stepKey: topLevelStepKey(cursor.parentStepIndex),
      })

      // 4. Top-level tail: continue on success; on failure, fail-stop the remaining top-level
      // actions as `skipped` (job plane + legacy steps), mirroring executeActions' parent-failure skip.
      if (!branchFailed) {
        const { suspended } = await this.executeActions(
          rule.actions, context, execution.steps, jobLifecycle, cursor.parentStepIndex + 1,
        )
        if (suspended) {
          execution.duration = (execution.duration ?? 0) + (Date.now() - startTime)
          return execution
        }
      } else {
        for (let k = cursor.parentStepIndex + 1; k < rule.actions.length; k++) {
          await jobLifecycle.onSkipped(k, rule.actions[k])
          execution.steps.push({ actionType: rule.actions[k].type, status: 'skipped', durationMs: 0 })
        }
      }

      const hasFailed = execution.steps.some((step) => step.status === 'failed')
      const allSkipped = execution.steps.length > 0 && execution.steps.every((step) => step.status === 'skipped')
      execution.status = hasFailed ? 'failed' : allSkipped ? 'skipped' : 'success'
      if (hasFailed) {
        execution.error = execution.steps.find((step) => step.status === 'failed')?.error ?? 'Action failed'
      }
    } catch (err) {
      execution.status = 'failed'
      execution.error = err instanceof Error ? err.message : String(err)
    }

    execution.duration = (execution.duration ?? 0) + (Date.now() - startTime)
    execution.finishedAt = new Date().toISOString()
    return execution
  }

  /**
   * Execute actions in sequence. Stop on first failure.
   */
  private async executeActions(
    actions: AutomationAction[],
    context: ExecutionContext,
    results: AutomationStepResult[],
    jobLifecycle?: ActionJobLifecycle,
    startIndex = 0,
  ): Promise<{ suspended: boolean }> {
    let nextTopLevelUpstreamJobId: string | null | undefined

    for (let index = startIndex; index < actions.length; index++) {
      const action = actions[index]
      const topLevelMeta = nextTopLevelUpstreamJobId !== undefined
        ? { upstreamJobId: nextTopLevelUpstreamJobId }
        : undefined
      nextTopLevelUpstreamJobId = undefined

      // A6-2 suspend point: a `wait_for_callback` in an opted-in rule suspends here.
      if (action.type === 'wait_for_callback') {
        if (jobLifecycle?.onSuspend) {
          // Persist the suspension + a `suspended` C1 job (D2 out-of-band), then STOP. No legacy
          // step result is pushed for the wait yet — it settles to `success` on resume (D2).
          await jobLifecycle.onSuspend(index, action)
          return { suspended: true }
        }
        // D7 fail-closed: a legacy rule (no job plane) cannot suspend → fail the step + skip the rest.
        results.push({
          actionType: 'wait_for_callback',
          status: 'failed',
          error: 'wait_for_callback requires execution_mode workflow_job_v1',
          durationMs: 0,
        })
        for (let i = index + 1; i < actions.length; i++) {
          results.push({ actionType: actions[i].type, status: 'skipped', durationMs: 0 })
        }
        return { suspended: false }
      }

      // W6-1 approval bridge. The completion event, not an admin token, resumes the tail.
      if (action.type === 'start_approval') {
        if (jobLifecycle?.onStartApproval) {
          const approvalResult = await jobLifecycle.onStartApproval(index, action, context)
          if (approvalResult.suspended) return { suspended: true }
          const result = approvalResult.result ?? {
            actionType: 'start_approval',
            status: 'success',
            durationMs: 0,
          }
          results.push(result)
          if (result.status === 'failed') {
            for (let i = index + 1; i < actions.length; i++) {
              await jobLifecycle.onSkipped(i, actions[i])
              results.push({ actionType: actions[i].type, status: 'skipped', durationMs: 0 })
            }
            break
          }
          continue
        }
        results.push({
          actionType: 'start_approval',
          status: 'failed',
          error: 'start_approval requires execution_mode workflow_job_v1',
          durationMs: 0,
        })
        for (let i = index + 1; i < actions.length; i++) {
          results.push({ actionType: actions[i].type, status: 'skipped', durationMs: 0 })
        }
        return { suspended: false }
      }

      // A6-3-1 exclusive branch. It requires the persisted job plane so nested
      // branch jobs can be observed as C1 jobs; legacy/off-path rules fail closed.
      if (action.type === 'condition_branch') {
        if (!jobLifecycle) {
          results.push({
            actionType: 'condition_branch',
            status: 'failed',
            error: 'condition_branch requires execution_mode workflow_job_v1',
            durationMs: 0,
          })
          for (let i = index + 1; i < actions.length; i++) {
            results.push({ actionType: actions[i].type, status: 'skipped', durationMs: 0 })
          }
          return { suspended: false }
        }

        await jobLifecycle.onStart(index, action, topLevelMeta)
        const branchResult = await this.executeConditionBranch(index, action, context, jobLifecycle)
        if (branchResult.suspended) {
          // A6-3-3 branch-local wait: the branch persisted its suspended child + the
          // suspension row. The parent condition_branch job stays `running`; admin resume
          // settles it after the branch tail. Stop the execution here.
          return { suspended: true }
        }
        const branchStepResult = branchResult.result
        if (!branchStepResult) {
          throw new Error('condition_branch returned neither a suspension nor a result')
        }
        results.push(branchStepResult)
        await jobLifecycle.onSettled(index, action, branchStepResult)

        if (branchStepResult.status === 'failed') {
          for (let i = index + 1; i < actions.length; i++) {
            await jobLifecycle.onSkipped(i, actions[i])
            results.push({ actionType: actions[i].type, status: 'skipped', durationMs: 0 })
          }
          break
        }

        nextTopLevelUpstreamJobId = branchResult.lastJobId
        continue
      }

      // A6-3-4 / W3-1 parallel branch. V1 is graph-shaped fan-out + join-all:
      // every branch is attempted, the parent join job settles only after every
      // branch is terminal, and the next top-level action upstreams from the
      // parent join job (not an arbitrary child).
      if (action.type === 'parallel_branch') {
        if (!jobLifecycle) {
          results.push({
            actionType: 'parallel_branch',
            status: 'failed',
            error: 'parallel_branch requires execution_mode workflow_job_v1',
            durationMs: 0,
          })
          for (let i = index + 1; i < actions.length; i++) {
            results.push({ actionType: actions[i].type, status: 'skipped', durationMs: 0 })
          }
          return { suspended: false }
        }

        await jobLifecycle.onStart(index, action, topLevelMeta)
        const parallelResult = await this.executeParallelBranch(index, action, context, jobLifecycle)
        results.push(parallelResult.result)
        await jobLifecycle.onSettled(index, action, parallelResult.result)

        if (parallelResult.result.status === 'failed') {
          for (let i = index + 1; i < actions.length; i++) {
            await jobLifecycle.onSkipped(i, actions[i])
            results.push({ actionType: actions[i].type, status: 'skipped', durationMs: 0 })
          }
          break
        }

        nextTopLevelUpstreamJobId = parallelResult.joinJobId
        continue
      }

      // A6-1 fail-closed: onStart runs BEFORE the inner try, so a job-create failure propagates
      // to execute()'s outer catch (execution fails) — and the action's side effect never runs.
      if (jobLifecycle) await jobLifecycle.onStart(index, action, topLevelMeta)
      // #4196 Class-A identity — the SAME canonical top-level step-key the job/fingerprint plane uses.
      const result = await this.executeSingleAction(action, context, {
        structuralPath: topLevelStepKey(index),
        rootExecutionId: context.rootExecutionId ?? context.executionId,
      })

      results.push(result)

      // A6-1 fail-closed: onSettled runs AFTER the inner try/catch (+durationMs +dingtalk) — i.e.
      // OUTSIDE it — so a job-UPDATE failure propagates to execute()'s outer catch (execution
      // fails) rather than being swallowed into a failed step. The action's side effect already
      // ran by here, so this is the "must not pretend the action didn't run" case.
      if (jobLifecycle) await jobLifecycle.onSettled(index, action, result)

      // Stop on failure
      if (result.status === 'failed') {
        // Mark remaining actions as skipped
        for (let i = results.length; i < actions.length; i++) {
          if (jobLifecycle) await jobLifecycle.onSkipped(i, actions[i])
          results.push({
            actionType: actions[i].type,
            status: 'skipped',
            durationMs: 0,
          })
        }
        break
      }
    }

    return { suspended: false }
  }

  private async executeParallelBranch(
    stepIndex: number,
    action: AutomationAction,
    context: ExecutionContext,
    jobLifecycle: ActionJobLifecycle,
  ): Promise<{ result: AutomationStepResult; joinJobId: string }> {
    const startMs = Date.now()
    const parentJobId = `${context.executionId}:job:${stepIndex}`
    const validation = validateParallelBranchRuntimeConfig(action.config)
    const childJobIds: string[] = []
    const resolvedBranchKeys: string[] = []
    const failedBranchKeys: string[] = []
    const skippedBranchKeys: string[] = []
    const branchStatuses: Record<string, 'resolved' | 'failed' | 'skipped'> = {}
    const branchLabels: Record<string, string> = {}

    if ('error' in validation) {
      return {
        joinJobId: parentJobId,
        result: {
          actionType: 'parallel_branch',
          status: 'failed',
          error: validation.error,
          durationMs: Date.now() - startMs,
        },
      }
    }

    const branches = validation.branches
    for (const branch of branches) {
      const branchKey = branch.key
      const branchLabel = branch.label
      const branchActions = branch.actions

      if (branchLabel) branchLabels[branchKey] = branchLabel

      let upstreamJobId: string | null = parentJobId
      let branchFailed = false
      for (let actionIndex = 0; actionIndex < branchActions.length; actionIndex++) {
        const branchAction = branchActions[actionIndex]
        const stepKey = branchChildStepKey(stepIndex, 'parallel', branchKey, actionIndex)
        const jobId = `${context.executionId}:job:${stepIndex}:parallel:${branchKey}:${actionIndex}`
        const meta = { stepKey, jobId, upstreamJobId }
        childJobIds.push(jobId)

        await jobLifecycle.onStart(stepIndex, branchAction, meta)
        const branchActionResult = await this.executeSingleAction(branchAction, context, {
          structuralPath: stepKey,
          rootExecutionId: context.rootExecutionId ?? context.executionId,
        })
        await jobLifecycle.onSettled(stepIndex, branchAction, branchActionResult, meta)

        upstreamJobId = jobId

        if (branchActionResult.status === 'failed') {
          branchFailed = true
          for (let skippedIndex = actionIndex + 1; skippedIndex < branchActions.length; skippedIndex++) {
            const skippedAction = branchActions[skippedIndex]
            const skippedStepKey = branchChildStepKey(stepIndex, 'parallel', branchKey, skippedIndex)
            const skippedJobId = `${context.executionId}:job:${stepIndex}:parallel:${branchKey}:${skippedIndex}`
            await jobLifecycle.onSkipped(stepIndex, skippedAction, {
              stepKey: skippedStepKey,
              jobId: skippedJobId,
              upstreamJobId,
            })
            childJobIds.push(skippedJobId)
            upstreamJobId = skippedJobId
          }
          failedBranchKeys.push(branchKey)
          branchStatuses[branchKey] = 'failed'
          break
        }
      }

      if (!branchFailed) {
        resolvedBranchKeys.push(branchKey)
        branchStatuses[branchKey] = 'resolved'
      }
    }

    const output: Record<string, unknown> = {
      joinMode: 'all',
      branchCount: branches.length,
      childJobIds,
      resolvedBranchKeys,
      failedBranchKeys,
      skippedBranchKeys,
      branchStatuses,
    }
    if (Object.keys(branchLabels).length > 0) output.branchLabels = branchLabels

    return {
      joinJobId: parentJobId,
      result: {
        actionType: 'parallel_branch',
        status: failedBranchKeys.length > 0 ? 'failed' : 'success',
        ...(failedBranchKeys.length > 0 ? { error: `parallel_branch failed branches: ${failedBranchKeys.join(', ')}` } : {}),
        output,
        durationMs: Date.now() - startMs,
      },
    }
  }

  private async executeConditionBranch(
    stepIndex: number,
    action: AutomationAction,
    context: ExecutionContext,
    jobLifecycle: ActionJobLifecycle,
  ): Promise<{
    // A6-3-3: `suspended` is set when a branch-local `wait_for_callback` suspended the
    // execution mid-branch; `cursor` then carries the resume position. Otherwise `result`
    // is the settled condition_branch step result (one is always present).
    suspended?: boolean
    result?: AutomationStepResult
    lastJobId: string
    cursor?: ConditionBranchResumeCursor
  }> {
    const startMs = Date.now()
    const parentJobId = `${context.executionId}:job:${stepIndex}`
    const config = action.config as {
      branches?: Array<{
        key?: unknown
        label?: unknown
        conditions?: ConditionGroup
        actions?: AutomationAction[]
      }>
      defaultBranch?: {
        key?: unknown
        label?: unknown
        actions?: AutomationAction[]
      } | null
    }
    const branches = Array.isArray(config.branches) ? config.branches : []
    let selected: typeof branches[number] | null = null
    let matched = false

    try {
      for (const branch of branches) {
        if (branch.conditions && evaluateConditions(branch.conditions, context.recordData)) {
          selected = branch
          matched = true
          break
        }
      }
    } catch (error) {
      return {
        lastJobId: parentJobId,
        result: {
          actionType: 'condition_branch',
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startMs,
        },
      }
    }

    if (!selected && config.defaultBranch) {
      selected = config.defaultBranch
    }

    const selectedBranchKey = typeof selected?.key === 'string' ? selected.key : null
    const selectedBranchLabel = typeof selected?.label === 'string' ? selected.label : undefined
    const branchActions = Array.isArray(selected?.actions) ? selected.actions : []
    const output: Record<string, unknown> = {
      selectedBranchKey,
      matched,
    }
    if (selectedBranchLabel) output.selectedBranchLabel = selectedBranchLabel

    if (!selected || branchActions.length === 0) {
      return {
        lastJobId: parentJobId,
        result: {
          actionType: 'condition_branch',
          status: 'success',
          output,
          durationMs: Date.now() - startMs,
        },
      }
    }

    if (!selectedBranchKey) {
      return {
        lastJobId: parentJobId,
        result: {
          actionType: 'condition_branch',
          status: 'failed',
          error: 'condition_branch selected branch key is invalid',
          output,
          durationMs: Date.now() - startMs,
        },
      }
    }

    let upstreamJobId: string | null = parentJobId
    let lastJobId = parentJobId
    for (let actionIndex = 0; actionIndex < branchActions.length; actionIndex++) {
      const branchAction = branchActions[actionIndex]
      const stepKey = `${stepIndex}.branch.${selectedBranchKey}.${actionIndex}`
      const jobId = `${context.executionId}:job:${stepIndex}:branch:${selectedBranchKey}:${actionIndex}`
      const meta = { stepKey, jobId, upstreamJobId }

      if (branchAction.type === 'wait_for_callback') {
        // A6-3-3 branch-local suspend. Fail closed if no resume capability (shouldn't happen:
        // condition_branch already requires workflow_job_v1, which supplies onSuspendBranch).
        if (!jobLifecycle.onSuspendBranch) {
          return {
            lastJobId,
            result: {
              actionType: 'condition_branch',
              status: 'failed',
              error: 'branch-local wait_for_callback requires execution_mode workflow_job_v1',
              output,
              durationMs: Date.now() - startMs,
            },
          }
        }
        const cursor: ConditionBranchResumeCursor = {
          kind: 'condition_branch',
          parentStepIndex: stepIndex,
          branchKey: selectedBranchKey,
          branchActionIndex: actionIndex,
          stepKey,
          parentJobId,
          branchJobId: jobId,
          upstreamJobId,
          branchActionFingerprint: computeActionFingerprint(branchActions),
        }
        // Persists the branch suspension row + a `suspended` branch-child C1 job, then STOP.
        // The parent condition_branch job stays `running`; resume settles it (scope-gate §4.3).
        await jobLifecycle.onSuspendBranch(cursor, branchAction)
        return { suspended: true, cursor, lastJobId }
      }

      if (branchAction.type === 'condition_branch') {
        const failed: AutomationStepResult = {
          actionType: 'condition_branch',
          status: 'failed',
          error: 'Nested condition_branch is not supported in A6-3-1',
          output,
          durationMs: Date.now() - startMs,
        }
        return { result: failed, lastJobId }
      }

      await jobLifecycle.onStart(stepIndex, branchAction, meta)
      const branchActionResult = await this.executeSingleAction(branchAction, context, {
        structuralPath: stepKey,
        rootExecutionId: context.rootExecutionId ?? context.executionId,
      })
      await jobLifecycle.onSettled(stepIndex, branchAction, branchActionResult, meta)
      lastJobId = jobId
      upstreamJobId = jobId

      if (branchActionResult.status === 'failed') {
        for (let skippedIndex = actionIndex + 1; skippedIndex < branchActions.length; skippedIndex++) {
          const skippedAction = branchActions[skippedIndex]
          const skippedStepKey = `${stepIndex}.branch.${selectedBranchKey}.${skippedIndex}`
          const skippedJobId = `${context.executionId}:job:${stepIndex}:branch:${selectedBranchKey}:${skippedIndex}`
          await jobLifecycle.onSkipped(stepIndex, skippedAction, {
            stepKey: skippedStepKey,
            jobId: skippedJobId,
            upstreamJobId,
          })
          upstreamJobId = skippedJobId
          lastJobId = skippedJobId
        }
        return {
          lastJobId,
          result: {
            actionType: 'condition_branch',
            status: 'failed',
            error: branchActionResult.error ?? `Branch action ${actionIndex} failed`,
            output,
            durationMs: Date.now() - startMs,
          },
        }
      }
    }

    return {
      lastJobId,
      result: {
        actionType: 'condition_branch',
        status: 'success',
        output,
        durationMs: Date.now() - startMs,
      },
    }
  }

  /**
   * B1-a1: run a SINGLE action with a caller-built context, reusing the exact
   * per-action dispatch (`executeSingleAction`) — same handlers, same audit
   * hooks — as the rule-triggered path, WITHOUT the rule-execution/job shell.
   * Used by the button/run route so a button click is NOT a parallel execution
   * path. The CALLER is responsible for dispatch-time authorization (visibility
   * != executability — re-evaluate the underlying action's own gate as the
   * actor, server-side) and for writing the audit row.
   */
  async runSingleAction(
    action: AutomationAction,
    context: ExecutionContext,
  ): Promise<AutomationStepResult> {
    // #4196: NO Class-A claim here (identity undefined). A single ad-hoc action dispatch (a button
    // click / run route) is not a replayable EXECUTION action — it has no execution lineage root and no
    // retry semantics, so there is nothing to dedup against. Claiming here would need a lineage root that
    // does not exist for this path.
    return this.executeSingleAction(action, context, undefined)
  }

  /**
   * FWB activation — `write_approval_form_values` (FWB0 lock, RATIFIED). Writes the approved instance's
   * immutable `form_snapshot` (D4 — values NEVER ride the event payload or action config) into the rule's
   * OWN sheet as a NEW record (D2), atomically with the FWB idempotency claim, the create revision and the
   * chained durable outbox row (D9: ONE transaction). Preconditions fail closed with zero writes:
   * flag OFF → skipped; durable chain OFF → failed (no half-durable path, D10); no rule-execution identity
   * (ad-hoc dispatch) → failed (D11); no transaction seam → failed (the withTransaction autocommit
   * fallback would silently break the four-way atomicity). Gates default to DENY when unbound.
   */
  private async executeWriteApprovalFormValuesAction(
    config: Record<string, unknown>,
    context: ExecutionContext,
    identity?: ClassAActionIdentity,
  ): Promise<AutomationStepResult> {
    const actionType = 'write_approval_form_values'
    try {
      if (!isFwbWritebackEnabled()) {
        return { actionType, status: 'skipped', output: { reason: 'APPROVAL_FWB_WRITEBACK_ENABLED is OFF' } }
      }
      if (!isDurableDeliveryEnabled()) {
        return {
          actionType,
          status: 'failed',
          error: 'write_approval_form_values requires AUTOMATION_DURABLE_DELIVERY_ENABLED=true — FWB rides the durable chain (FWB0 D9/D10); a half-durable write would silently drop its chained event',
        }
      }
      if (!identity) {
        return {
          actionType,
          status: 'failed',
          error: 'write_approval_form_values requires the rule-execution identity (structural path + lineage root) — ad-hoc single-action dispatch is out of contract (FWB0 D11)',
        }
      }
      if (!this.deps.transaction) {
        return {
          actionType,
          status: 'failed',
          error: 'write_approval_form_values requires the transaction seam — the autocommit fallback cannot honour claim+record+revision+outbox atomicity (FWB0 D9)',
        }
      }
      const trig = (context.triggerEvent && typeof context.triggerEvent === 'object' ? context.triggerEvent : {}) as Record<string, unknown>
      const approval = (trig.approval && typeof trig.approval === 'object' ? trig.approval : {}) as Record<string, unknown>
      const instanceId = typeof approval.instanceId === 'string' ? approval.instanceId.trim() : ''
      const templateId = typeof approval.templateId === 'string' ? approval.templateId.trim() : ''
      const baseEventId = typeof trig.eventId === 'string' && trig.eventId.trim()
        ? trig.eventId.trim()
        : (typeof trig._eventId === 'string' ? trig._eventId.trim() : '')
      if (!instanceId || !templateId || !baseEventId) {
        return { actionType, status: 'failed', error: 'write_approval_form_values requires an approval completion event carrying instanceId + templateId + a stable eventId' }
      }
      // D1 hard gate: writeback fires on APPROVED completions only — regardless of the rule's outcome filter.
      const transition = (trig.transition && typeof trig.transition === 'object' ? trig.transition : {}) as Record<string, unknown>
      const outcome = typeof transition.toStatus === 'string' && transition.toStatus
        ? transition.toStatus
        : (typeof trig.eventType === 'string' && trig.eventType.startsWith('approval.') ? trig.eventType.slice('approval.'.length) : '')
      if (outcome !== 'approved') {
        return { actionType, status: 'skipped', output: { reason: 'fwb_outcome_not_approved' } }
      }
      const normalized = normalizeFwbMappings((config as { mappings?: unknown }).mappings)
      if (!normalized.ok) {
        return { actionType, status: 'failed', error: `fwb_rejected:mapping_config:${(normalized as { issue: string }).issue}` }
      }
      const gates = this.deps.fwbGateChecks ?? DEFAULT_DENY_FWB_GATES
      // Per-action identity: the SAME §2.1 derivation Class-A uses — structuralPath keeps two
      // byte-identical FWB actions in one rule distinct (config-hash identity would collapse them).
      const actionKey = deriveActionKey({ structuralPath: identity.structuralPath, actionType, canonicalConfig: config })
      const fwbEventId = `${baseEventId}::fwb::${identity.structuralPath}`
      const automationDepth = (typeof trig._automationDepth === 'number' ? trig._automationDepth : 0) + 1

      const result = await this.withTransaction(context.sheetId, async (query) => {
        // D4: the immutable form snapshot is the ONLY value source, read server-side inside the txn.
        const snapRes = await query('SELECT form_snapshot FROM approval_instances WHERE id = $1', [instanceId])
        const snapRow = snapRes.rows[0] as { form_snapshot?: unknown } | undefined
        if (!snapRow) throw new Error('fwb_rejected:instance_not_found')
        const rawSnap = snapRow.form_snapshot
        const formValues = (rawSnap && typeof rawSnap === 'object' && !Array.isArray(rawSnap)
          ? rawSnap
          : (() => { try { return JSON.parse(String(rawSnap ?? '{}')) as Record<string, unknown> } catch { return {} } })()) as Record<string, unknown>
        const trx = { query, isTransaction: true } as unknown as TransactionalQueryable
        const seam: FwbRecordWriteSeam = {
          createRecordWithRevision: async (t, targetSheetId, values) => {
            const recordId = `rec_${randomUUID()}`
            await t.query(
              'INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1, $2, $3::jsonb, 1)',
              [recordId, targetSheetId, JSON.stringify(values)],
            )
            // Same revision contract as executeCreateRecord (OD-2 source names the write entry point;
            // the write identity is the rule CREATOR — §2.2: system completions carry no human actor).
            await recordRecordRevision(t.query as AutomationDeps['queryFn'], {
              sheetId: targetSheetId,
              recordId,
              version: 1,
              action: 'create',
              source: 'automation',
              actorId: context.ruleCreatedBy ?? null,
              changedFieldIds: Object.keys(values),
              patch: values,
              snapshot: values,
            })
            return recordId
          },
          enqueueOutbox: async (t, event) => {
            await produceAutomationEvent(
              { query: t.query, isTransaction: true } as unknown as TransactionalQueryable,
              { eventType: event.eventType, eventId: event.eventId, payload: event.payload, automationDepth: event.automationDepth },
            )
          },
        }
        return executeWriteApprovalFormValues(trx, {
          claimId: `fwb_${randomUUID()}`,
          instanceId,
          ruleId: context.ruleId,
          actionKey,
          gateSubject: {
            configurerUserId: context.ruleCreatedBy,
            ruleId: context.ruleId,
            sourceTemplateId: templateId,
            targetSheetId: context.sheetId,
          },
          mappings: normalized.mappings,
          formValues,
          eventId: fwbEventId,
          automationDepth,
        }, gates, seam)
      })

      if (result.status === 'applied') {
        return { actionType, status: 'success', output: { recordId: result.recordId, sheetId: context.sheetId } }
      }
      if (result.status === 'already_applied') {
        return { actionType, status: 'success', alreadyApplied: true, output: { alreadyApplied: true } }
      }
      if (result.reason === 'permission_gates') {
        return { actionType, status: 'failed', error: `fwb_rejected:permission_gates:${(result.failedGates ?? []).join(',')}` }
      }
      return { actionType, status: 'failed', error: 'fwb_rejected:mapping' }
    } catch (err) {
      return { actionType, status: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
  }

  private async executeSingleAction(
    action: AutomationAction,
    context: ExecutionContext,
    // #4196 Class-A identity. Every rule-driven call site passes its canonical step-key; the ad-hoc
    // single-action dispatch (runSingleAction) passes undefined → no claim. The four Class-A methods
    // claim-then-skip-on-duplicate; every other action ignores it.
    identity?: ClassAActionIdentity,
  ): Promise<AutomationStepResult> {
    const startMs = Date.now()
    let result: AutomationStepResult

    try {
      switch (action.type) {
        case 'update_record':
          result = await this.executeUpdateRecord(action.config, context, identity)
          break
        case 'create_record':
          result = await this.executeCreateRecord(action.config, context, identity)
          break
        case 'delete_record':
          result = await this.executeDeleteRecord(action.config, context, identity)
          break
        case 'send_webhook':
          // #4196 Class-B: thread the execution identity so send_webhook can take the two-phase
          // intent/outcome path when AUTOMATION_CLASSB_OUTBOUND_ENABLED is ON (flag OFF ⇒ identity ignored,
          // byte-identical). The other four send_* actions are a clearly-flagged follow-up (see PR body).
          result = await this.executeSendWebhook(action.config, context, identity)
          break
        case 'send_notification':
          result = await this.executeSendNotification(action.config, context)
          break
        case 'send_email':
          // #4196 Class-B follow-up: thread the execution identity so send_email can take the two-phase
          // intent/outcome path when AUTOMATION_CLASSB_OUTBOUND_ENABLED is ON (flag OFF ⇒ identity ignored,
          // byte-identical legacy send). The typed `config` is the same runtime object used for the §2.1
          // action-key, exactly as send_webhook passes its raw config.
          result = await this.executeSendEmail(action.config as unknown as SendEmailConfig, context, identity)
          break
        case 'send_dingtalk_group_message':
          result = await this.executeSendDingTalkGroupMessage(action.config as unknown as SendDingTalkGroupMessageConfig, context)
          break
        case 'send_dingtalk_person_message':
          result = await this.executeSendDingTalkPersonMessage(action.config as unknown as SendDingTalkPersonMessageConfig, context)
          break
        case 'send_dingtalk_approval_card':
          // #4196 Class-B follow-up: thread the raw config + execution identity so the approval card can take
          // the two-phase intent/outcome path when the flag is ON (flag OFF ⇒ both ignored, byte-identical).
          result = await this.executeSendDingTalkApprovalCard(context, action.config, identity)
          break
        case 'lock_record':
          result = await this.executeLockRecord(action.config, context, identity)
          break
        case 'start_approval':
          result = {
            actionType: 'start_approval',
            status: 'failed',
            error: 'start_approval requires execution_mode workflow_job_v1',
          }
          break
        case 'write_approval_form_values':
          // FWB activation (FWB0 lock): approval form-writeback into the rule's own sheet. Flag-gated
          // (skip while OFF), durable-chain-required, identity-required (D11), transaction-seam-required
          // (D9) — every precondition fails closed with zero writes.
          result = await this.executeWriteApprovalFormValuesAction(action.config, context, identity)
          break
        case 'record_click':
          // B1 button field — executor-owned INERT action. Records an auditable
          // click with ZERO business side effect (no record write, no outbound,
          // no job). The audit row is written by the caller (button/run route);
          // here we only return a succeeded step so the click runs through the
          // SAME dispatch as every other action (no parallel path).
          result = { actionType: 'record_click', status: 'success' }
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

    if (action.type === 'send_dingtalk_group_message' && result.status === 'failed') {
      let failureAlert: Record<string, unknown>
      try {
        failureAlert = await this.notifyRuleCreatorOfDingTalkGroupFailure(result, context)
      } catch (error) {
        failureAlert = {
          status: 'failed',
          reason: redactDingTalkFailureAlertText(error instanceof Error ? error.message : String(error)),
        }
      }
      result.output = mergeFailureAlertOutput(result.output, failureAlert)
    }

    return result
  }

  private async notifyRuleCreatorOfDingTalkGroupFailure(
    failedStep: AutomationStepResult,
    context: ExecutionContext,
  ): Promise<Record<string, unknown>> {
    const ruleCreatorId = typeof context.ruleCreatedBy === 'string' ? context.ruleCreatedBy.trim() : ''
    const subject = 'MetaSheet DingTalk group delivery failed'
    const content = [
      'A DingTalk group automation message failed.',
      `Rule: ${context.ruleId}`,
      `Sheet: ${context.sheetId}`,
      context.recordId ? `Record: ${context.recordId}` : '',
      `Error: ${redactDingTalkFailureAlertText(failedStep.error ?? 'Unknown DingTalk group delivery failure')}`,
    ].filter(Boolean).join('\n')

    if (!ruleCreatorId) {
      return { status: 'skipped', reason: 'missing_rule_creator' }
    }

    const recipientResult = await this.deps.queryFn(
      // DT-OPS-04: the rule creator's userid is only meaningful inside their own corp, so
      // carry the integration they are bound under and notify them with its credentials.
      `SELECT u.id AS local_user_id,
              linked.external_user_id AS dingtalk_user_id,
              linked.integration_id AS integration_id
         FROM users u
         LEFT JOIN LATERAL (
           SELECT a.external_user_id, a.integration_id::text AS integration_id
             FROM directory_account_links l
             JOIN directory_accounts a ON a.id = l.directory_account_id
            WHERE l.local_user_id = u.id
              AND l.link_status = 'linked'
              AND a.provider = 'dingtalk'
              AND a.is_active = TRUE
            ORDER BY a.updated_at DESC
            LIMIT 1
         ) linked ON TRUE
        WHERE u.id = $1
          AND u.is_active = TRUE
        LIMIT 1`,
      [ruleCreatorId],
    )
    const row = (recipientResult.rows[0] ?? null) as Record<string, unknown> | null
    const dingtalkUserId = typeof row?.dingtalk_user_id === 'string' ? row.dingtalk_user_id.trim() : ''
    const ruleCreatorIntegrationId = typeof row?.integration_id === 'string' ? row.integration_id.trim() : ''

    if (!row || !dingtalkUserId) {
      await recordDingTalkPersonDeliverySafely(this.deps.queryFn, {
        localUserId: ruleCreatorId,
        sourceType: 'automation',
        subject,
        content,
        success: false,
        status: 'skipped',
        errorMessage: 'Rule creator DingTalk account is not linked or user is inactive',
        automationRuleId: context.ruleId,
        recordId: context.recordId,
        initiatedBy: context.actorId ?? null,
      })
      return { status: 'skipped', reason: 'rule_creator_not_linked' }
    }

    try {
      const messageConfig = await readDingTalkMessageConfigFromRuntime(ruleCreatorIntegrationId || undefined)
      const accessToken = await fetchDingTalkAppAccessToken(messageConfig, { fetchFn: this.deps.fetchFn })
      const result = await sendDingTalkWorkNotification(
        accessToken,
        {
          userIds: [dingtalkUserId],
          title: subject,
          content,
        },
        messageConfig,
        { fetchFn: this.deps.fetchFn },
      )
      await recordDingTalkPersonDeliverySafely(this.deps.queryFn, {
        localUserId: ruleCreatorId,
        dingtalkUserId,
        sourceType: 'automation',
        subject,
        content,
        success: true,
        status: 'success',
        httpStatus: 200,
        responseBody: stringifyResponseBody(result.raw),
        automationRuleId: context.ruleId,
        recordId: context.recordId,
        initiatedBy: context.actorId ?? null,
      })
      return { status: 'success', notifiedUsers: 1 }
    } catch (error) {
      const httpStatus = error instanceof DingTalkRequestError ? error.statusCode : error instanceof DingTalkBusinessError ? 200 : null
      const responseBody = error instanceof DingTalkRequestError
        ? stringifyResponseBody(error.responseBody)
        : error instanceof DingTalkBusinessError
          ? stringifyResponseBody(error.responseBody)
          : null
      const errorMessage = redactDingTalkFailureAlertText(error instanceof Error ? error.message : String(error))
      // PR #4046 Phase B: an outcome-unknown send (transport marker) is recorded as the DISTINCT
      // `outcome_unknown` telemetry state — the alert may well have reached the rule creator; it
      // is never auto-resent and must not read as a definite failure.
      await recordDingTalkPersonDeliverySafely(this.deps.queryFn, {
        localUserId: ruleCreatorId,
        dingtalkUserId,
        sourceType: 'automation',
        subject,
        content,
        success: false,
        status: isDingTalkOutcomeUnknown(error) ? 'outcome_unknown' : 'failed',
        httpStatus,
        responseBody,
        errorMessage,
        automationRuleId: context.ruleId,
        recordId: context.recordId,
        initiatedBy: context.actorId ?? null,
      })
      return { status: 'failed', reason: errorMessage }
    }
  }

  // ── ②b cross-base write-gate (shared by create_record + update_record) ────

  /**
   * Resolve a record sheet's base_id via the executor's queryFn. Returns `undefined` for a missing OR
   * SOFT-DELETED sheet (caller treats as an unresolvable target → fail-closed), `null` for a legacy/null
   * base. NIT-1: the `deleted_at IS NULL` filter ensures a soft-deleted target sheet resolves to "no row"
   * so a cross-base write into a logically-deleted sheet cannot resolve a target base (mirrors the REST
   * record-create guard at record-service.ts). The state is unreachable today (sheets are hard-deleted)
   * but this hardens against a future sheet-soft-delete feature.
   */
  private async resolveSheetBaseId(
    sheetId: string,
    queryFn: AutomationDeps['queryFn'],
  ): Promise<string | null | undefined> {
    const res = await queryFn('SELECT base_id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL', [sheetId])
    const row = (res.rows as Array<{ base_id?: unknown }>)[0]
    if (!row) return undefined
    return typeof row.base_id === 'string' ? row.base_id : null
  }

  /**
   * ②b write-gate: decide whether a record-mutating action's resolved target sheet is a CROSS-BASE
   * write, and if so enforce the governed contract. Same-base (target sheet base === trigger base,
   * null-aware) → `{ crossBase: false }` with NO new gate (zero regression). Cross-base → ALL of:
   *   1. an explicit `targetBaseId` is provided AND `targetBaseId === target sheet's actual base_id`
   *      (claim == truth; mirrors the §2a.2 link wall's `claimed === actualForeignBaseId`). A cross-base
   *      write WITHOUT `targetBaseId`, or with a mismatched one → reject (closes the §1.3 ungated hole).
   *   2. `resolveBaseWritable(context.actorId, queryFn, targetBaseId)` is true — the EFFECTIVE ACTOR is
   *      the TRIGGER actor (RATIFIED decision 2); a null actorId (e.g. scheduled trigger) fails this
   *      because `resolveBaseWritable` is fail-closed on no userId. NO fallback to the rule owner.
   * Returns a discriminated result; on any rejection the caller records a FAILED step (never a write).
   *
   * The trigger base is `context.sheetId`'s base. Note the same-base happy path still issues ONE base
   * lookup per side; that is read-only and cannot fail the write — a missing trigger sheet base and a
   * missing target sheet base both normalize to null and (null === null) stays same-base.
   */
  private async evaluateCrossBaseWrite(
    targetSheetId: string,
    declaredTargetBaseId: string | undefined,
    context: ExecutionContext,
  ): Promise<CrossBaseWriteGate> {
    // Thin adapter: unpack the automation `ExecutionContext` (trigger sheet + trigger actor) and delegate to
    // the context-agnostic gate below. Record-mutating actions (update/create/delete/lock) route here.
    return this.evaluateCrossBaseWriteGate(
      this.deps.queryFn,
      context.actorId ?? null,
      context.sheetId,
      targetSheetId,
      declaredTargetBaseId,
    )
  }

  /**
   * ②b write-gate, CONTEXT-AGNOSTIC "new shape" (queryFn, actorId, triggerSheetId, targetSheetId,
   * declaredTargetBaseId). The record-mutating executors delegate here via `evaluateCrossBaseWrite`, and the
   * T3-5 approval cross-base resultWriteback backwrite calls it directly on the SAME executor instance so it
   * shares the per-target-base write QUOTA (Q5) with update/create/delete/lock. Behaviour is unchanged from
   * the pre-T3-5 method; only the trigger sheet/actor + queryFn are now explicit params instead of `context`.
   */
  async evaluateCrossBaseWriteGate(
    queryFn: AutomationDeps['queryFn'],
    actorId: string | null,
    triggerSheetId: string,
    targetSheetId: string,
    declaredTargetBaseId: string | undefined,
  ): Promise<CrossBaseWriteGate> {
    // Fast-path: a write to the SAME sheet as the trigger, with no explicit cross-base `targetBaseId`,
    // is DEFINITIONALLY same-base — a sheet cannot exist in two bases — so skip the base lookups
    // entirely. This keeps a legitimate same-sheet write from fail-closing when the sheet row is
    // momentarily unresolvable (e.g. an executor whose queryFn doesn't model meta_sheets), while leaving
    // the cross-base path FULLY gated: a DIFFERENT target sheet (the §1.3 create-to-another-base vector)
    // OR any explicit `targetBaseId` claim still resolves the bases and enforces the contract below.
    const declaredBaseClaim = typeof declaredTargetBaseId === 'string' && declaredTargetBaseId.trim()
      ? declaredTargetBaseId.trim()
      : null
    if (targetSheetId === triggerSheetId && declaredBaseClaim === null) {
      return { crossBase: false }
    }

    // NIT-1: check the RAW three-state result of the TARGET sheet lookup BEFORE the `?? null` collapse.
    // `undefined` = the target sheet is missing or SOFT-DELETED (resolveSheetBaseId filters deleted_at) →
    // the write target is unresolvable → fail-closed. This must precede the `?? null` normalization, else
    // a soft-deleted target (undefined → null) would collapse against a legacy-null trigger base
    // (null === null → same-base) and silently SKIP the gate. Treating it as a cross-base rejection keeps
    // legitimate legacy-null-base SAME-BASE writes (both sides null, both rows present) unaffected.
    const rawTargetBaseId = await this.resolveSheetBaseId(targetSheetId, queryFn)
    if (rawTargetBaseId === undefined) {
      return {
        crossBase: true,
        ok: false,
        error: `Cross-base write target sheet ${targetSheetId} is missing or soft-deleted (no resolvable base)`,
      }
    }

    const triggerBaseId = (await this.resolveSheetBaseId(triggerSheetId, queryFn)) ?? null
    const targetBaseId = rawTargetBaseId ?? null

    // Same-base (null-aware, mirrors `baseIdsAreCrossBase` = strict `!==`): null-vs-null and
    // same-set are same-base; a null/legacy base vs a set base is cross-base.
    if (triggerBaseId === targetBaseId) return { crossBase: false }

    // Cross-base AUTHORITY decision — claim==truth then base-write — via the shared, context-agnostic primitive
    // (C1: `resolveCrossBaseWriteAuthority`, the SAME primitive the cross-base mirror write-through consumes; see
    // the design-lock §3/§10). The primitive returns a structured reason; this adapter maps it back to the EXACT,
    // unchanged `CrossBaseWriteGate` error strings (order preserved: claim before writable). (`declaredBaseClaim`
    // computed at the top, reused here.)
    const claimed = declaredBaseClaim
    const authority = await resolveCrossBaseWriteAuthority({
      actorId,
      targetBaseId,
      declaredBaseClaim: claimed,
      queryFn,
    })
    if ('reason' in authority) {
      if (authority.reason === 'claim_mismatch') {
        return {
          crossBase: true,
          ok: false,
          error: `Cross-base write requires an explicit targetBaseId equal to the target sheet's base: target sheet ${targetSheetId} base=${targetBaseId ?? 'null'}, declared=${claimed ?? 'null'}`,
        }
      }
      // reason === 'not_writable' — trigger-actor lacks base-write (fail-closed: null actor → false).
      return {
        crossBase: true,
        ok: false,
        error: `Cross-base write denied: trigger actor lacks base-write on ${targetBaseId}`,
      }
    }

    // Per-target-base write QUOTA — the LAST gate before an authorized cross-base write. Caps the RATE of
    // authorized cross-base writes per target base within a rolling window to protect a target base from
    // an automation storm. Same-base writes never reach here (the early returns above short-circuit
    // same-base), so this is zero-regression. Increment-then-check: limit N → N writes allowed, the N+1th
    // rejected fail-closed (step `failed`, NO row), mirroring the rejections above. The counter is keyed
    // by the resolved TARGET base, so each base has an isolated budget. NOTE: for update_record the
    // lock/addressing checks run AFTER this point, so a blocked-by-lock or not-found update still consumes
    // a slot — intentional: this throttles authorized cross-base WRITE ATTEMPTS, the right unit for DB
    // protection.
    const quotaReject = await this.checkCrossBaseWriteQuota(targetBaseId)
    if (quotaReject) return quotaReject

    return { crossBase: true, ok: true }
  }

  /**
   * Increment-and-check the per-target-base cross-base write quota. Returns a fail-closed
   * `CrossBaseWriteGate` rejection when the target base has exceeded its limit within the window, else
   * `null` (allowed). Reuses the rate-limiter `RateLimitStore` (memory/Redis) increment primitive.
   */
  private async checkCrossBaseWriteQuota(
    targetBaseId: string,
  ): Promise<Extract<CrossBaseWriteGate, { ok: false }> | null> {
    const key = `crossbase-write-quota:${targetBaseId}`
    let count: number
    try {
      const res = await this.crossBaseQuotaStore.increment(key, this.crossBaseQuotaWindowMs)
      count = res.count
    } catch (err) {
      // A counter-store failure must NOT silently disable the guardrail (fail-open) nor wrongly block a
      // legitimate write. The memory store cannot throw; a Redis store could. Log and ALLOW this single
      // write (the store, not the actor, failed) — consistent with the rate-limiter middleware, which
      // falls back rather than 429-ing on store error.
      logger.warn('Cross-base write quota store error; allowing this write', {
        targetBaseId,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    }
    if (count > this.crossBaseQuotaLimit) {
      return {
        crossBase: true,
        ok: false,
        error: `Cross-base write quota exceeded for target base ${targetBaseId}: limit ${this.crossBaseQuotaLimit} per ${this.crossBaseQuotaWindowMs}ms`,
      }
    }
    return null
  }

  // ── Individual action executors ─────────────────────────────────────────

  /**
   * Sanitize rich-`longText` values in an automation write payload (§5).
   *
   * The automation `update_record` / `create_record` actions write `meta_records.data`
   * via a BARE `data || $1::jsonb` SQL — they bypass the 5 record-write validators. A
   * rich-`longText` value set by an action (its config may template trigger/record data,
   * so the content is NOT trusted) would otherwise be stored as raw HTML = stored XSS the
   * write sanitizer never saw. The "inert by construction" storage invariant the FE render
   * lane trusts must hold at EVERY user-content write boundary, not just the 5 validators.
   *
   * Loads the TARGET sheet's longText fields, and for any payload key whose field is rich,
   * runs `sanitizeRichLongText` in place. Mutates and returns the same object.
   */
  private async sanitizeRichLongTextInWritePayload(
    sheetId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const keys = Object.keys(payload)
    if (keys.length === 0) return payload
    const res = await this.deps.queryFn(
      `SELECT id, property FROM meta_fields
       WHERE sheet_id = $1 AND type = 'longText' AND id = ANY($2::text[])`,
      [sheetId, keys],
    )
    for (const row of res.rows as Array<{ id?: unknown; property?: unknown }>) {
      const fieldId = typeof row.id === 'string' ? row.id : String(row.id ?? '')
      if (!fieldId || !isRichLongTextProperty(row.property)) continue
      const value = payload[fieldId]
      if (typeof value === 'string') {
        payload[fieldId] = sanitizeRichLongText(value)
      }
    }
    return payload
  }

  /**
   * C1 — publish a real-time invalidation for an automation record write to the EFFECTIVE sheet's
   * room (target sheet for cross-base, trigger sheet for same-base). Same gated audience as a REST
   * write to that sheet already reaches (relative invariance — origin base does not change who is in
   * the target room). For a CROSS-BASE write the trigger `actorId` is omitted so a trigger-base
   * principal is not surfaced to the target base's subscribers; same-base passes it through (the
   * UI "who changed" / self-echo hint). Best-effort: never fails the authorized write.
   */
  private publishRecordRealtime(
    kind: 'record-updated' | 'record-created' | 'record-deleted',
    sheetId: string,
    recordId: string,
    crossBase: boolean,
    context: ExecutionContext,
  ): void {
    try {
      publishMultitableSheetRealtime({
        spreadsheetId: sheetId,
        source: 'multitable',
        kind,
        recordId,
        actorId: crossBase ? undefined : (context.actorId ?? undefined),
      })
    } catch {
      // publishMultitableSheetRealtime already swallows its own errors; this is belt-and-suspenders.
    }
  }

  private async executeUpdateRecord(
    config: Record<string, unknown>,
    context: ExecutionContext,
    identity?: ClassAActionIdentity,
  ): Promise<AutomationStepResult> {
    const fields = config.fields as Record<string, unknown> | undefined
    if (!fields || Object.keys(fields).length === 0) {
      return { actionType: 'update_record', status: 'failed', error: 'No fields specified' }
    }

    const patch = Object.fromEntries(Object.entries(fields))

    // ②b cross-base addressing. The resolved target sheet is `config.targetSheetId ?? context.sheetId`.
    // For a CROSS-BASE update, `targetSheetId` + `targetRecordId` are REQUIRED (the trigger record is not
    // in the target base) — the lock-check AND the write both retarget to the TARGET record. For a
    // SAME-BASE update they default to the trigger record (unchanged, back-compat).
    const targetSheetId = (config.targetSheetId as string) || context.sheetId
    const declaredTargetBaseId = typeof config.targetBaseId === 'string' ? config.targetBaseId : undefined

    try {
      const gate = await this.evaluateCrossBaseWrite(targetSheetId, declaredTargetBaseId, context)
      let effectiveSheetId = context.sheetId
      let effectiveRecordId = context.recordId
      if (gate.crossBase) {
        if (gate.ok === false) {
          return { actionType: 'update_record', status: 'failed', error: gate.error }
        }
        // Cross-base requires the full explicit target triple (§2.4 / decision 5). The executor is the
        // last line of defense even if rule-save validation were bypassed.
        const targetRecordId = typeof config.targetRecordId === 'string' ? config.targetRecordId : ''
        if (!config.targetSheetId || !targetRecordId) {
          return {
            actionType: 'update_record',
            status: 'failed',
            error: 'Cross-base update_record requires targetBaseId + targetSheetId + targetRecordId',
          }
        }
        effectiveSheetId = targetSheetId
        effectiveRecordId = targetRecordId
      }

      // rich-longText write-path defense: this bare UPDATE bypasses the 5 record-write
      // validators, so sanitize any rich-longText value in the patch against the TARGET
      // sheet's field config before it reaches the DB (inert-by-construction at every writer). A
      // read-only field-config lookup — never touches `meta_records` — so it stays OUTSIDE the
      // transaction below (same placement as before this slice).
      await this.sanitizeRichLongTextInWritePayload(effectiveSheetId, patch)

      // P1#2c REPLACE — build the chaining-event payload ONCE (stable `_eventId`) so the same-txn durable
      // enqueue (flag ON, inside the txn below) and the legacy post-commit emit (flag OFF) share one identity.
      const chainEventPayload = withAutomationEventId({
        sheetId: effectiveSheetId,
        recordId: effectiveRecordId,
        changes: fields,
        actorId: context.actorId,
        _automationDepth: ((context.triggerEvent as Record<string, unknown>)?._automationDepth as number ?? 0) + 1,
      })

      // W0 slice ③ (D-1c design-lock, RATIFIED 2026-07-13, §0.5 OD-1..OD-3, §0/§7a site A3): the
      // lock-check, the UPDATE, and the revision INSERT now all run inside ONE transaction — mirrors
      // D-1's `executeDeleteRecord` fix just above (`withTransaction` is the SAME helper; its
      // production wiring — `AutomationService`'s constructor hard-wires `deps.transaction` to a real
      // `poolManager.get().transaction(...)` — is re-verified for THIS slice by the atomicity golden,
      // not assumed from D-1). A failed revision INSERT rolls the UPDATE back too — no half-write (an
      // updated `meta_records` row with no matching `meta_record_revisions` row) is possible.
      const txResult = await this.withTransaction(effectiveSheetId, async (query) => {
        // #4196 Class-A claim — FIRST statement, SAME transaction as the mutation+revision below. A
        // duplicate (retry/replay) short-circuits: return the already-applied success and skip the UPDATE
        // and its revision entirely. The (no-op) transaction still commits cleanly.
        if (await this.claimClassAOrSkip(query, identity, 'update_record', config) === 'duplicate') {
          return this.alreadyAppliedResult('update_record')
        }
        // Record-lock guard (rank-8 review B1; decisions d/e/f). An automation acting on behalf of its
        // actor is NOT implicitly the locker/owner — overwriting a locked record is blocked. To write
        // through a lock the rule must first run a `lock_record{locked:false}` action (decision f). The
        // step fails honestly so it surfaces in the execution log. ②b LOCK-REDIRECT: the SELECT below
        // and the UPDATE further down BOTH read `effectiveSheetId`/`effectiveRecordId` so a cross-base
        // update checks the TARGET record's lock (not the trigger record's) — lock priority over base-write.
        const lockRes = await query(
          'SELECT locked, locked_by, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2',
          [effectiveRecordId, effectiveSheetId],
        )
        const lockRow = lockRes.rows[0] as
          | { locked?: unknown; locked_by?: unknown; created_by?: unknown }
          | undefined
        // ②b claim==truth for the record: a cross-base update must address a record that ACTUALLY lives in
        // `targetSheetId`. If the lock SELECT found no row, the targetRecordId does not exist in
        // targetSheetId → fail-closed (decision 4: never a silent no-op success). Same-base keeps its
        // pre-②b leniency (a missing trigger record yields a 0-row UPDATE reported as success) to avoid
        // any behavior regression.
        if (gate.crossBase && !lockRow) {
          // #4196 atomicity: THROW (not return) so this transaction — and the Class-A claim taken above —
          // ROLLS BACK. A non-throwing `return {failed}` would COMMIT the claim for an action that never
          // mutated, so a legitimate retry would skip as a FALSE duplicate (a lost update — the exact hazard
          // this ledger exists to prevent). The method's outer catch reports the identical failed result.
          // Consistent with the lock-conflict check just below, which already throws to roll back.
          throw new Error(
            `Cross-base update_record target record not found in target sheet: ${effectiveRecordId} ∉ ${effectiveSheetId}`,
          )
        }
        if (lockRow) {
          ensureRecordNotLocked(context.actorId ?? null, lockRow, () => new Error('Record is locked'))
        }

        // RETURNING version, data: the FULL post-merge row becomes the revision snapshot (NOT the
        // patch — D-1c §4.2's merge trap: a naive `snapshot: patch` truncates every multi-field
        // record; `reconstructRecordsAtT` reads `snapshot` as the full record, record-reconstructor.ts:63).
        // xbase-write-gated: routes through evaluateCrossBaseWrite (gate computed above) — a cross-base
        // update is rejected before this UPDATE unless claim==truth + trigger-actor base-write.
        // lock-guarded: automation update_record (B1) — ensureRecordNotLocked enforced just above.
        // revision-emitted: D-1c slice ③ (A3) — recordRecordRevision(action:'update') @2258.
        const updateRes = await query(
          `UPDATE meta_records
           SET data = COALESCE(data, '{}'::jsonb) || $1::jsonb,
               version = version + 1,
               updated_at = NOW()
           WHERE id = $2 AND sheet_id = $3
           RETURNING version, data`,
          [JSON.stringify(patch), effectiveRecordId, effectiveSheetId],
        )
        const updatedRow = updateRes.rows[0] as { version?: unknown; data?: unknown } | undefined
        // W0 slice ③ zero-row fail-closed (same class as slices ①/②, applied to fit THIS lane's
        // pre-existing contract). The lock SELECT above takes NO row lock (no `FOR UPDATE` —
        // unchanged from before this slice), so a concurrent DELETE of this exact record between that
        // SELECT and this UPDATE is reachable; under READ COMMITTED the UPDATE then resumes against
        // zero rows. The documented pre-existing same-base contract for THAT case (and for a
        // never-existed record) is a 0-row UPDATE reported as SUCCESS (the comment above, unchanged
        // since ②b) — D-1's sibling `executeDeleteRecord` fix preserves the identical leniency for
        // delete ("same-base automation delete of a missing record keeps its 0-row success — and
        // fabricates NO revision", multitable-d1-delete-revision-parity-realdb.test.ts). Slice ③ must
        // not regress that contract, so this guard fails closed on the REVISION only — it does not
        // throw or change the action's reported status: no row ⇒ fabricate NO revision for a record
        // this UPDATE never touched. Writing one anyway would persist forever
        // (`meta_record_revisions.record_id` carries no FK, migration zzzz20260430172000) and could
        // resurrect a deleted record via `reconstructRecordsAtT`.
        if (updatedRow) {
          const nextVersion = Number(updatedRow.version)
          // source='automation' (OD-2 — names the write entry point, not the auth identity).
          // actorId=context.actorId ?? null (OD-3 — the automation actor when present; NEVER a
          // fabricated system actor for an actor-less trigger, e.g. a schedule).
          await recordRecordRevision(query, {
            sheetId: effectiveSheetId,
            recordId: effectiveRecordId,
            version: Number.isFinite(nextVersion) ? nextVersion : 0,
            action: 'update',
            source: 'automation',
            actorId: context.actorId ?? null,
            changedFieldIds: Object.keys(patch),
            patch,
            snapshot: normalizeJson(updatedRow.data),
          })
        }
        // P1#2c REPLACE: same-transaction durable enqueue on the SUCCESS path (flag ON) — atomic with the
        // UPDATE + revision (any throw above rolls it back; the duplicate-claim early-return above skips it,
        // exactly as it skips the legacy emit). Unconditional on `updatedRow` to mirror the legacy emit
        // 1:1 (the 0-row same-base leniency still emitted). Flag OFF ⇒ no-op (legacy emit below fires).
        await enqueueRecordEventIfDurable(
          { query, isTransaction: true } as unknown as TransactionalQueryable,
          'multitable.record.updated',
          chainEventPayload,
        )
        return null
      })
      if (txResult) return txResult

      // P1#2c REPLACE: flag OFF ⇒ legacy post-commit emit (byte-identical); flag ON ⇒ SUPPRESSED (the
      // same-txn enqueue above is the delivery path — keep-both would double-deliver the webhook sink).
      emitRecordEventIfLegacy(this.deps.eventBus, 'multitable.record.updated', chainEventPayload)

      // C1 real-time fan-out: invalidate the EFFECTIVE sheet's room (target for cross-base, trigger for
      // same-base) so its gated subscribers see the change live — automation writes were previously
      // invisible to the real-time layer (closeout §5). Same audience/gate as a REST write to that sheet
      // (relative invariance). actorId is omitted for cross-base so a trigger-base actor id is not
      // surfaced to the target base's subscribers.
      this.publishRecordRealtime('record-updated', effectiveSheetId, effectiveRecordId, gate.crossBase, context)

      return { actionType: 'update_record', status: 'success', output: { updatedFields: Object.keys(fields) } }
    } catch (err) {
      return { actionType: 'update_record', status: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
  }

  private async executeDeleteRecord(
    config: Record<string, unknown>,
    context: ExecutionContext,
    identity?: ClassAActionIdentity,
  ): Promise<AutomationStepResult> {
    // Phase C2a cross-base addressing — MIRRORS executeUpdateRecord. The resolved target sheet is
    // `config.targetSheetId ?? context.sheetId`. For a CROSS-BASE delete, `targetSheetId` +
    // `targetRecordId` are REQUIRED (the trigger record is not in the target base); for a SAME-BASE
    // delete they default to the trigger record (back-compat). A delete is a WRITE for abuse-accounting,
    // so it routes through the SAME `evaluateCrossBaseWrite` gate (same base-writable check, claim==truth,
    // shared per-target-base quota bucket).
    const targetSheetId = (config.targetSheetId as string) || context.sheetId
    const declaredTargetBaseId = typeof config.targetBaseId === 'string' ? config.targetBaseId : undefined

    try {
      const gate = await this.evaluateCrossBaseWrite(targetSheetId, declaredTargetBaseId, context)
      let effectiveSheetId = context.sheetId
      let effectiveRecordId = context.recordId
      if (gate.crossBase) {
        if (gate.ok === false) {
          return { actionType: 'delete_record', status: 'failed', error: gate.error }
        }
        // Cross-base requires the full explicit target triple (mirrors update). The executor is the last
        // line of defense even if rule-save validation were bypassed.
        const targetRecordId = typeof config.targetRecordId === 'string' ? config.targetRecordId : ''
        if (!config.targetSheetId || !targetRecordId) {
          return {
            actionType: 'delete_record',
            status: 'failed',
            error: 'Cross-base delete_record requires targetBaseId + targetSheetId + targetRecordId',
          }
        }
        effectiveSheetId = targetSheetId
        effectiveRecordId = targetRecordId
      }

      // P1#2c REPLACE — build the chaining-event payload ONCE (stable `_eventId`) so the same-txn durable
      // enqueue (flag ON, inside the txn below) and the legacy post-commit emit (flag OFF) share one identity.
      const chainEventPayload = withAutomationEventId({
        sheetId: effectiveSheetId,
        recordId: effectiveRecordId,
        actorId: context.actorId,
        _automationDepth: ((context.triggerEvent as Record<string, unknown>)?._automationDepth as number ?? 0) + 1,
      })

      const step = await this.withTransaction(effectiveSheetId, async (query) => {
        // #4196 Class-A claim — FIRST statement, SAME transaction as the delete+revision below. A
        // duplicate (retry/replay) short-circuits: return the already-applied success and skip the DELETE,
        // link cleanup, tombstones and revision entirely. The (no-op) transaction still commits cleanly.
        if (await this.claimClassAOrSkip(query, identity, 'delete_record', config) === 'duplicate') {
          return this.alreadyAppliedResult('delete_record')
        }
        // Record-lock guard: you cannot delete a record locked by someone you can't unlock. The SELECT and
        // the DELETE below BOTH read `effectiveSheetId`/`effectiveRecordId`, so a cross-base delete checks
        // the TARGET record's lock (not the trigger record's) — lock priority over base-write.
        //
        // D-1: lock the row and capture version+data inside the SAME transaction as the hard delete and
        // delete revision. Without the delete revision, point-in-time reconstruction kept treating
        // automation-deleted records as alive forever.
        // D-2: created_at/updated_at ride along on the SELECT that is already happening (zero extra
        // queries) — the trash row preserves the record's original timestamps through a restore.
        const lockRes = await query(
          `SELECT locked, locked_by, created_by, version, data, created_at, updated_at
             FROM meta_records
            WHERE id = $1 AND sheet_id = $2
            FOR UPDATE`,
          [effectiveRecordId, effectiveSheetId],
        )
        const lockRow = lockRes.rows[0] as
          | {
              locked?: unknown
              locked_by?: unknown
              created_by?: unknown
              version?: unknown
              data?: unknown
              created_at?: Date | string | null
              updated_at?: Date | string | null
            }
          | undefined
        // ②b claim==truth for the record: a cross-base delete must address a record that ACTUALLY lives in
        // `targetSheetId`. No row → the targetRecordId does not exist there → fail-closed (never a silent
        // no-op success). Same-base keeps its leniency (a missing trigger record yields a 0-row DELETE
        // reported as success) to avoid any behavior regression vs the other same-base sinks.
        if (gate.crossBase && !lockRow) {
          // #4196 atomicity: THROW (not return) so this transaction — and the Class-A claim taken above —
          // ROLLS BACK. A non-throwing `return {failed}` would COMMIT the claim for an action that never
          // deleted anything, so a legitimate retry would skip as a FALSE duplicate (the exact hazard this
          // ledger exists to prevent). The method's outer catch reports the identical failed result.
          // Consistent with the lock-conflict check just below, which already throws to roll back.
          throw new Error(
            `Cross-base delete_record target record not found in target sheet: ${effectiveRecordId} ∉ ${effectiveSheetId}`,
          )
        }
        if (lockRow) {
          ensureRecordNotLocked(context.actorId ?? null, lockRow, () => new Error('Record is locked'))
        }

        // D-2 (side-door delete recoverability, #4004; default OFF ⇒ every `sideDoorTrash` branch below is
        // dead and this method behaves byte-identically to D-1, §1.9). §1.2 anchor: ONE pre-generated uuid
        // becomes the delete revision's id, the trash row's delete_revision_id and the tombstones'
        // source_revision_id — so restore can NAME this deletion's captured inbound edges.
        const sideDoorTrash = isSideDoorDeleteTrashEnabled()
        const deleteRevisionId = randomUUID()

        // OD-7 LAYER 3 (review P2-1), BEFORE any write. `withTransaction` SILENTLY falls back to a
        // non-transactional `queryFn` when `deps.transaction` is absent (:2429-2436), so an executor
        // constructed without it would otherwise run this destructive reordered path with no transaction,
        // no error, and — as the review proved — no failing test. Now it fails closed: the step reports
        // `failed` and nothing is destroyed. Independent of the entry wiring; pinned by golden G16.
        if (sideDoorTrash) await assertTransactionalQuery(query, 'automation')

        // §1.3: capture the INBOUND edges BEFORE the links DELETE below destroys both directions. No-op
        // unless BOTH the D-2 flag and the capture flag are on (§1.5 nesting). Over-cap ⇒
        // TombstoneCaptureCapExceededError propagates out of withTransaction to this method's catch ⇒ step
        // `failed`, whole txn rolled back, record NOT deleted (fail-closed, §1.4 / golden G7). Skipped when
        // there is no row: a same-base delete of a missing record must not anchor tombstones to a delete
        // revision that will never be written.
        if (lockRow) {
          await captureSideDoorInboundTombstones(query, {
            sheetId: effectiveSheetId,
            recordId: effectiveRecordId,
            sourceRevisionId: deleteRevisionId,
          })
        }

        // Clean up links FIRST (mirrors the same-base delete sinks `records.deleteRecord` /
        // `RecordService.deleteRecord`): the FK cascade only covers the `record_id` side, so the
        // `foreign_record_id` side must be deleted explicitly or it dangles. (This statement touches
        // meta_links, NOT meta_records, so the cross-base write-guard regex does not match it.)
        await query(
          'DELETE FROM meta_links WHERE record_id = $1 OR foreign_record_id = $1',
          [effectiveRecordId],
        )

        if (lockRow) {
          const version = Number(lockRow.version ?? 1)
          const serverVersion = Number.isFinite(version) ? version : 1
          await recordRecordRevision(query, {
            sheetId: effectiveSheetId,
            recordId: effectiveRecordId,
            version: serverVersion,
            action: 'delete',
            source: 'automation',
            actorId: context.actorId ?? null,
            changedFieldIds: [],
            patch: {},
            // §1.9: flag-off passes NO id, so recordRecordRevision self-generates exactly as it does today.
            ...(sideDoorTrash ? { id: deleteRevisionId } : {}),
            snapshot: normalizeJson(lockRow.data),
          })

          if (sideDoorTrash) {
            // OD-8 target-base semantics: the trash row (and its base_id) resolve against the sheet the
            // record ACTUALLY lives in (`effectiveSheetId`), NOT the trigger's base — so a cross-base
            // delete surfaces in the TARGET base's recycle bin and restore re-fires target-base events.
            // Fail-closed on a missing trash schema (§1.8): no 42P01/42703 swallow — the error propagates
            // to the catch below, the step fails, and the txn rolls the delete back (golden G11).
            const baseId = await resolveSheetBaseIdForTrash(query, effectiveSheetId)
            await insertSideDoorTrashRow(query, {
              recordId: effectiveRecordId,
              sheetId: effectiveSheetId,
              baseId,
              snapshot: normalizeJson(lockRow.data),
              originalVersion: serverVersion,
              createdBy: typeof lockRow.created_by === 'string' ? lockRow.created_by : null,
              deletedBy: context.actorId ?? null, // OD-5
              originalCreatedAt: lockRow.created_at ?? null,
              originalUpdatedAt: lockRow.updated_at ?? null,
              deleteRevisionId,
            })
          }
        }

        // HARD delete — the system has NO soft-delete for records: `meta_records` has no `deleted_at`
        // column and both same-base delete sinks (`records.ts`, `record-service.ts`) hard-`DELETE`. A
        // soft-delete here would target a non-existent column AND would be a silent no-op (no read path
        // filters `deleted_at`). So this mirrors the proven sinks. No `version = version + 1` (the row is
        // gone); `sheet_id` scoping matches the update template.
        // xbase-write-gated: routes through evaluateCrossBaseWrite (gate computed above) — a cross-base
        // delete is rejected before this DELETE unless claim==truth + trigger-actor base-write.
        // lock-guarded: automation delete_record (C2a) — ensureRecordNotLocked enforced just above.
        // revision-emitted: automation delete_record, D-1 — recordRecordRevision(action:'delete') @2365.
        await query(
          'DELETE FROM meta_records WHERE id = $1 AND sheet_id = $2',
          [effectiveRecordId, effectiveSheetId],
        )

        // P1#2c REPLACE: same-transaction durable enqueue on the SUCCESS path (flag ON) — atomic with the
        // link cleanup + revision + DELETE (any throw above rolls it back; the duplicate-claim early-return
        // above skips it, exactly as it skips the legacy emit). Unconditional on `lockRow` to mirror the
        // legacy emit 1:1 (the 0-row same-base leniency still emitted). Flag OFF ⇒ no-op.
        await enqueueRecordEventIfDurable(
          { query, isTransaction: true } as unknown as TransactionalQueryable,
          'multitable.record.deleted',
          chainEventPayload,
        )
        return null
      })
      if (step) return step

      // P1#2c REPLACE (mirrors the updated/created sites + the same-base delete sink's event shape): flag
      // OFF ⇒ legacy post-commit emit (byte-identical); flag ON ⇒ SUPPRESSED (the same-txn enqueue above is
      // the delivery path). C1 real-time invalidation fan-out to the target base's room stays OUT of this
      // lock — this only carries the domain event; no cross-room publish is wired here.
      emitRecordEventIfLegacy(this.deps.eventBus, 'multitable.record.deleted', chainEventPayload)

      // C1 real-time fan-out (see executeUpdateRecord) — invalidate the effective sheet's room.
      this.publishRecordRealtime('record-deleted', effectiveSheetId, effectiveRecordId, gate.crossBase, context)

      return { actionType: 'delete_record', status: 'success', output: { recordId: effectiveRecordId, sheetId: effectiveSheetId } }
    } catch (err) {
      return { actionType: 'delete_record', status: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * W0-1 L4-cov-services: every automation record write runs through here, so this is the single seam
   * where the canonical per-sheet write fence (L4) covers the AUTOMATION writer class. Fence-FIRST inside
   * the transaction (advisory xact lock ⇒ meaningful only txn-scoped), then the durable-block check —
   * `fenceWriterEntry` is flag-gated (`MULTITABLE_ENABLE_WRITER_FENCE`), so with the flag OFF this is
   * byte-identical to the pre-L4cov behaviour. A `SheetWriterBlockedError` thrown here propagates to each
   * action's catch and fails the step honestly (surfaces in the execution log; automation retry semantics
   * apply) — an automation write must never land inside a recovery's applying window.
   *
   * FAIL-CLOSED (mirrors the L6-a H3 precedent): with the fence flag ON but NO transaction seam available,
   * an advisory xact lock taken on the bare autocommit `queryFn` would evaporate immediately — the fence
   * guarantee cannot hold. That configuration throws instead of degrading silently. Production always has
   * the seam (`AutomationService` hard-wires `deps.transaction` to a real `poolManager.get().transaction`).
   */
  private async withTransaction<T>(
    sheetId: string,
    handler: (query: AutomationDeps['queryFn']) => Promise<T>,
  ): Promise<T> {
    if (this.deps.transaction) {
      return this.deps.transaction(async ({ query }) => {
        await fenceWriterEntry(query, sheetId) // L4 fence-first; no-op when the fence flag is OFF
        return handler(query)
      })
    }
    if (isWriterFenceEnabled()) {
      throw new Error(
        'MULTITABLE_ENABLE_WRITER_FENCE is on but this AutomationExecutor has no transaction seam — the canonical write fence cannot be honoured (fail-closed, no silent unfenced write)',
      )
    }
    return handler(this.deps.queryFn)
  }

  /**
   * #4196 Class-A claim gate. Active ONLY when (a) the runtime flag is ON AND (b) `deps.transaction` is
   * present — a REAL transaction. Condition (b) is not optional: `claimExecutionAction` runs
   * `assertInTransaction` (a `pg_current_xact_id()` probe), which THROWS on the autocommit `queryFn`
   * fallback `withTransaction` uses when `deps.transaction` is absent (many unit tests). Gating on it keeps
   * every legacy/autocommit path unchanged. When this returns false the caller runs its original body.
   */
  private classAClaimActive(): boolean {
    return isClassAExecutionClaimEnabled() && this.deps.transaction != null
  }

  /**
   * #4196: the FIRST statement inside a Class-A method's `withTransaction` callback. Claims the action's
   * (rootExecutionId, actionKey) tuple in THIS transaction. Returns 'proceed' when the gate is inactive or
   * no identity is supplied (no claim — byte-identical legacy path) OR the claim was won ('claimed'); returns
   * 'duplicate' when a prior apply already holds the claim, in which case the caller returns
   * {@link alreadyAppliedResult} and skips its mutation entirely. `config` is passed RAW — `deriveActionKey`
   * canonicalizes it (deep key-sort + sha256) internally, so the key matches the §4 fingerprint's per-action
   * identity exactly. `query` is `withTransaction`'s transactional query fn; wrapped as a
   * TransactionalQueryable so the ledger's DB-level xid probe runs against the SAME ongoing transaction.
   */
  private async claimClassAOrSkip(
    query: AutomationDeps['queryFn'],
    identity: ClassAActionIdentity | undefined,
    actionType: AutomationActionType,
    config: unknown,
  ): Promise<'proceed' | 'duplicate'> {
    if (!this.classAClaimActive() || !identity) return 'proceed'
    const outcome = await claimExecutionAction(
      { query, isTransaction: true } as unknown as TransactionalQueryable,
      {
        kind: 'execution',
        rootExecutionId: identity.rootExecutionId,
        actionKey: deriveActionKey({ structuralPath: identity.structuralPath, actionType, canonicalConfig: config }),
        actionType,
      },
    )
    return outcome === 'duplicate' ? 'duplicate' : 'proceed'
  }

  /**
   * #4196: the step result for a Class-A action skipped as a duplicate claim. Looks like a success (so the
   * execution proceeds past it) but carries `alreadyApplied:true` — NO mutation, NO revision, NO event/
   * realtime fan-out ran (those all sit AFTER the `withTransaction` early-return in each Class-A method).
   */
  private alreadyAppliedResult(actionType: AutomationActionType): AutomationStepResult {
    return { actionType, status: 'success', alreadyApplied: true, output: { alreadyApplied: true } }
  }

  private async executeCreateRecord(
    config: Record<string, unknown>,
    context: ExecutionContext,
    identity?: ClassAActionIdentity,
  ): Promise<AutomationStepResult> {
    const targetSheetId = (config.sheetId as string) || context.sheetId
    const declaredTargetBaseId = typeof config.targetBaseId === 'string' ? config.targetBaseId : undefined
    const data = (config.data as Record<string, unknown>) ?? {}
    const recordId = `rec_${randomUUID()}`

    try {
      // ②b write-gate (closes the §1.3 ungated hole). Pre-②b this method did a BARE INSERT to
      // `config.sheetId ?? context.sheetId` with ZERO permission check, so an automation could create a
      // record in ANY base's sheet ungated. Now a CROSS-BASE create (target sheet base ≠ trigger base)
      // demands an explicit consistent `targetBaseId` (claim == truth) + trigger-actor base-write;
      // a SAME-BASE create is unchanged (no gate).
      const gate = await this.evaluateCrossBaseWrite(targetSheetId, declaredTargetBaseId, context)
      if (gate.crossBase && gate.ok === false) {
        return { actionType: 'create_record', status: 'failed', error: gate.error }
      }

      // rich-longText write-path defense: this bare INSERT bypasses the 5 record-write
      // validators, so sanitize any rich-longText value in `data` against the target sheet's
      // field config before it reaches the DB (inert-by-construction at every writer).
      await this.sanitizeRichLongTextInWritePayload(targetSheetId, data)

      // P1#2c REPLACE — build the chaining-event payload ONCE (stable `_eventId`) so the same-txn durable
      // enqueue (flag ON, inside the txn below) and the legacy post-commit emit (flag OFF) share one identity.
      const chainEventPayload = withAutomationEventId({
        sheetId: targetSheetId,
        recordId,
        data,
        actorId: context.actorId,
        _automationDepth: ((context.triggerEvent as Record<string, unknown>)?._automationDepth as number ?? 0) + 1,
      })

      // W0 slice ③ (D-1c design-lock, RATIFIED 2026-07-13, §0.5 OD-1..OD-3, §0/§7a site A4): the
      // INSERT and its birth revision now run inside ONE transaction — mirrors `executeUpdateRecord`
      // above / D-1's `executeDeleteRecord`. A failed revision INSERT rolls back the record INSERT: the
      // record and its create revision either both exist or neither does — closing §0's corrected risk
      // (a record created via an uncaptured path is invisible-forever to `reconstructRecordsAtT`, so a
      // later Reset-to-T cannot distinguish "created after T" from "created before T but uncaptured" and
      // destroys it unconditionally). No zero-row guard is added here (unlike the UPDATE branch above):
      // a bare INSERT ... RETURNING with no ON CONFLICT clause cannot return zero rows without the
      // statement itself throwing — there is no "concurrently deleted" analogue for a row that does not
      // exist yet (mirrors slice ①'s form-submit CREATE branch and slice ②'s plugin `createRecord`,
      // neither of which added one).
      // xbase-write-gated: routes through evaluateCrossBaseWrite (gate computed above) — a cross-base
      // create is rejected before this INSERT unless claim==truth + trigger-actor base-write. This is
      // the §1.3 create-to-another-base vector the gate closes. revision-emitted: D-1c slice ③ (A4) — recordRecordRevision(action:'create') below, same txn.
      const skipped = await this.withTransaction(targetSheetId, async (query) => {
        // #4196 Class-A claim — FIRST statement, SAME transaction as the INSERT+revision below. A duplicate
        // (retry/replay) short-circuits: skip the INSERT and its birth revision entirely. The (no-op)
        // transaction still commits cleanly; the caller returns the already-applied success below.
        if (await this.claimClassAOrSkip(query, identity, 'create_record', config) === 'duplicate') {
          return 'duplicate' as const
        }
        // xbase-write-gated: routes through evaluateCrossBaseWrite (gate computed above) — a cross-base
        // create is rejected before this INSERT unless claim==truth + trigger-actor base-write (§1.3 vector).
        // revision-emitted: D-1c slice ③ (A4) — recordRecordRevision(action:'create') below, same txn.
        await query(
          `INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1, $2, $3::jsonb, 1)`,
          [recordId, targetSheetId, JSON.stringify(data)],
        )
        // source='automation' (OD-2). actorId=context.actorId ?? null (OD-3 — the automation actor
        // when present; never a fabricated system actor). snapshot=data: a create's `data` IS the
        // submitted patch (`reconstructRecordsAtT` reads `snapshot` as the full record,
        // record-reconstructor.ts:63 — for a create that IS the whole row, not a re-read from the DB).
        await recordRecordRevision(query, {
          sheetId: targetSheetId,
          recordId,
          version: 1,
          action: 'create',
          source: 'automation',
          actorId: context.actorId ?? null,
          changedFieldIds: Object.keys(data),
          patch: data,
          snapshot: data,
        })
        // P1#2c REPLACE: same-transaction durable enqueue on the SUCCESS path (flag ON) — atomic with the
        // INSERT + birth revision (a revision throw rolls it back; the duplicate-claim early-return above
        // skips it, exactly as the caller below skips the legacy emit). Flag OFF ⇒ no-op.
        await enqueueRecordEventIfDurable(
          { query, isTransaction: true } as unknown as TransactionalQueryable,
          'multitable.record.created',
          chainEventPayload,
        )
        return null
      })
      // #4196: a duplicate claim skipped the INSERT/revision — report the already-applied success and
      // emit NO create event and NO real-time fan-out (a replay must produce zero downstream effect).
      if (skipped === 'duplicate') return this.alreadyAppliedResult('create_record')

      // P1#2c REPLACE: flag OFF ⇒ legacy post-commit emit (byte-identical); flag ON ⇒ SUPPRESSED (the
      // same-txn enqueue above is the delivery path — keep-both would double-deliver the webhook sink).
      emitRecordEventIfLegacy(this.deps.eventBus, 'multitable.record.created', chainEventPayload)

      // C1 real-time fan-out (see executeUpdateRecord) — invalidate the target sheet's room.
      this.publishRecordRealtime('record-created', targetSheetId, recordId, gate.crossBase, context)

      return { actionType: 'create_record', status: 'success', output: { recordId, sheetId: targetSheetId } }
    } catch (err) {
      return { actionType: 'create_record', status: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
  }

  private async executeSendWebhook(
    config: Record<string, unknown>,
    context: ExecutionContext,
    // #4196 Class-B identity. Present on every rule-driven call; undefined for the ad-hoc single-action
    // dispatch (runSingleAction — no execution lineage, so no intent). Ignored entirely when the flag is OFF.
    identity?: ClassAActionIdentity,
  ): Promise<AutomationStepResult> {
    const url = config.url as string | undefined
    if (!url) {
      return { actionType: 'send_webhook', status: 'failed', error: 'Webhook URL is required' }
    }

    const method = (config.method as string) ?? 'POST'
    const headers = { ...((config.headers as Record<string, string>) ?? {}) }
    if (!headers['Content-Type']) {
      headers['Content-Type'] = 'application/json'
    }

    const body = config.body ?? {
      ruleId: context.sheetId,
      recordId: context.recordId,
      data: context.recordData,
      triggeredAt: new Date().toISOString(),
    }
    // Serialize once so the signature is computed over exactly the bytes sent.
    const bodyStr = JSON.stringify(body)

    // Share the webhook-service security posture: HMAC-SHA256 sign the body and
    // stamp a timestamp when a secret is configured, using the same header names
    // and algorithm so a single receiver verifier works for both dispatch paths.
    const secret = typeof config.secret === 'string' ? config.secret : undefined
    if (secret) {
      headers['X-Webhook-Signature'] = WebhookService.signPayload(bodyStr, secret)
      if (!headers['X-Webhook-Timestamp']) {
        headers['X-Webhook-Timestamp'] = new Date().toISOString()
      }
    }

    const fetchFn = this.deps.fetchFn ?? globalThis.fetch
    const timeoutMs = webhookTimeoutMs()

    // #4196 Class-B two-phase (flag ON + identity present). Intent (Tx A) commits BEFORE the send; a prior
    // `sent`/`outcome_unknown` short-circuits with NO network call. When the flag is OFF (or there is no
    // execution identity — the runSingleAction ad-hoc path) this is skipped and the legacy retry loop below
    // runs BYTE-IDENTICAL to pre-slice.
    const outboundId = this.classBOutboundIdentity(identity, 'send_webhook', config)
    if (outboundId) {
      return this.executeSendWebhookTwoPhase(outboundId, { url, method, headers, bodyStr, fetchFn, timeoutMs })
    }

    const retries = maxWebhookRetries()

    let lastError: string | undefined
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), timeoutMs)

        const response = await fetchFn(url, {
          method,
          headers,
          body: bodyStr,
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
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
      }
    }

    // Surface the failure in the step result (never silent) — the executor lifts
    // a failed step into the execution log + marks the run failed.
    logger.warn(
      `send_webhook to ${redactString(url)} failed after ${retries + 1} attempts: ${lastError}`,
    )
    return {
      actionType: 'send_webhook',
      status: 'failed',
      error: `Webhook failed after ${retries + 1} attempts: ${lastError}`,
    }
  }

  /**
   * #4196 Class-B gate: an outbound intent identity is present ONLY when the flag is ON AND the caller
   * supplied a class-A execution identity (a rule-driven dispatch with a lineage root). Unlike class-A this
   * does NOT require `deps.transaction` — the intent row is its own commit (Tx A) via the autocommit
   * `queryFn`, with no DB mutation to co-commit. `config` is passed RAW to `deriveActionKey` so the outbound
   * key is the SAME §2.1 identity as the class-A claim / §4 fingerprint.
   */
  private classBOutboundIdentity(
    identity: ClassAActionIdentity | undefined,
    actionType: AutomationActionType,
    config: unknown,
  ): OutboundIntentIdentity | null {
    if (!isClassBOutboundEnabled() || !identity) return null
    return {
      kind: 'execution',
      rootExecutionId: identity.rootExecutionId,
      actionKey: deriveActionKey({ structuralPath: identity.structuralPath, actionType, canonicalConfig: config }),
    }
  }

  /**
   * #4196 Class-B two-phase send for send_webhook. Tx A (claim) already decided we may attempt; here we
   * attempt EXACTLY ONCE — a send is at-most-once on this path, so there is NO in-call resend on an ambiguous
   * failure (that would be the duplicate external effect `outcome_unknown` exists to forbid). Classify the
   * single attempt, record the outcome (Tx B, guarded single-writer), and map to a step result:
   *   - sent            → success;
   *   - failed          → failed (definite pre-dispatch non-delivery; a later retry re-attempts via Tx A);
   *   - outcome_unknown  → a FAILED-shaped step naming outcome_unknown (operator-visible; NEVER auto-resent).
   */
  private async executeSendWebhookTwoPhase(
    outboundId: OutboundIntentIdentity,
    req: {
      url: string
      method: string
      headers: Record<string, string>
      bodyStr: string
      fetchFn: typeof fetch
      timeoutMs: number
    },
  ): Promise<AutomationStepResult> {
    // Tx A — intent committed BEFORE the network call. A prior sent/unknown short-circuits with no send.
    const decision = await claimOutboundIntent(this.deps.queryFn, outboundId)
    if (decision === 'skip_sent' || decision === 'skip_unknown') {
      // Success-shaped, alreadyApplied — no second delivery for an already-sent or ambiguous prior attempt.
      return this.alreadyAppliedResult('send_webhook')
    }

    // decision is 'proceed' | 'retry_failed' → attempt ONCE.
    let attempt: OutboundAttemptResult
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), req.timeoutMs)
    try {
      const response = await req.fetchFn(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.bodyStr,
        signal: controller.signal,
      })
      attempt = { kind: 'response', status: response.status }
    } catch (err) {
      attempt = classifyFetchError(err)
    } finally {
      clearTimeout(timeout)
    }

    const outcome = classifyOutboundResult(attempt)
    const reason = outboundReasonClass(attempt) // bounded, redacted class — never a body/URL/token
    // Tx B — record the terminal outcome (guarded `status='pending'`, single-writer).
    await recordOutboundOutcome(this.deps.queryFn, outboundId, outcome, reason)

    if (outcome === 'sent') {
      return {
        actionType: 'send_webhook',
        status: 'success',
        output: { outcome: 'sent', httpStatus: attempt.kind === 'response' ? attempt.status : null },
      }
    }
    if (outcome === 'failed') {
      // Definite non-delivery (nothing left the client) — retryable; the run is marked failed.
      return {
        actionType: 'send_webhook',
        status: 'failed',
        error: `send_webhook definite non-delivery (${reason}); eligible for retry`,
        output: { outcome: 'failed', reason },
      }
    }
    // outcome_unknown — the send MAY have happened; surfaced as failed so the run does NOT silently succeed,
    // and NEVER auto-resent (a retry consults the intent row and skips).
    logger.warn(`send_webhook to ${redactString(req.url)} → outcome_unknown (${reason}); recorded, not auto-resent`)
    return {
      actionType: 'send_webhook',
      status: 'failed',
      error: `send_webhook outcome_unknown (${reason}); recorded, not auto-resent`,
      output: { outcome: 'outcome_unknown', reason },
    }
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
      // Emit notification event — CollabService or other handler picks this up.
      //
      // B1-S1 D0-A SCOPE NOTE: the DURABLE notification write does NOT live here. A
      // button's durable Notification-Center delivery is a route-level dedicated
      // side-effect transaction (see routes/multitable-button.ts) so it composes
      // with the run's dedup + audit as one all-or-nothing unit. The automation-RULE
      // path stays eventBus-only here — adding durable writes / member-filter / dedup
      // to the shared executor would expand automation's behavior surface, which is
      // out of scope for a button slice.
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

  private async executeSendEmail(
    config: SendEmailConfig,
    context: ExecutionContext,
    // #4196 Class-B identity. Present on every rule-driven call; undefined for the ad-hoc single-action
    // dispatch (runSingleAction). Ignored entirely when AUTOMATION_CLASSB_OUTBOUND_ENABLED is OFF.
    identity?: ClassAActionIdentity,
  ): Promise<AutomationStepResult> {
    const recipients = Array.from(new Set(
      (Array.isArray(config.recipients) ? config.recipients : [])
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ))
    const subjectTemplate = typeof config.subjectTemplate === 'string' ? config.subjectTemplate.trim() : ''
    const bodyTemplate = typeof config.bodyTemplate === 'string' ? config.bodyTemplate.trim() : ''

    if (!recipients.length) {
      return { actionType: 'send_email', status: 'failed', error: 'send_email requires at least one recipient' }
    }
    if (!subjectTemplate) {
      return { actionType: 'send_email', status: 'failed', error: 'send_email subjectTemplate is required' }
    }
    if (!bodyTemplate) {
      return { actionType: 'send_email', status: 'failed', error: 'send_email bodyTemplate is required' }
    }
    if (!this.deps.notificationService) {
      return { actionType: 'send_email', status: 'failed', error: 'NotificationService is not configured for send_email automation action' }
    }

    // Non-null after the guard above; captured so the two-phase helper shares the exact instance.
    const notificationService = this.deps.notificationService
    const templateData: Record<string, unknown> = {
      sheetId: context.sheetId,
      recordId: context.recordId,
      actorId: context.actorId ?? '',
      record: context.recordData,
    }
    const subject = renderAutomationTemplate(subjectTemplate, templateData).trim()
    const content = renderAutomationTemplate(bodyTemplate, templateData).trim()

    const notification: Notification = {
      channel: 'email',
      subject,
      content,
      recipients: recipients.map((recipient) => ({ id: recipient, type: 'email' })),
      metadata: {
        source: 'automation',
        actionType: 'send_email',
        ruleId: context.ruleId,
        sheetId: context.sheetId,
        recordId: context.recordId,
        actorId: context.actorId ?? null,
      },
    }

    // #4196 Class-B two-phase (flag ON + identity present). Intent (Tx A) commits BEFORE the send; a prior
    // `sent`/`outcome_unknown` short-circuits with NO send. Flag OFF (or no execution identity — the
    // runSingleAction ad-hoc path) ⇒ the legacy send below runs BYTE-IDENTICAL to pre-slice (no intent
    // row, no classification, no outcome write).
    const outboundId = this.classBOutboundIdentity(identity, 'send_email', config)
    if (outboundId) {
      return this.executeSendEmailTwoPhase(outboundId, notificationService, notification, recipients.length)
    }

    const result = await notificationService.send(notification)

    if (result.status === 'failed') {
      return {
        actionType: 'send_email',
        status: 'failed',
        error: result.failedReason ?? 'NotificationService email send failed',
        output: result,
      }
    }

    return {
      actionType: 'send_email',
      status: 'success',
      output: {
        notificationId: result.id,
        notificationStatus: result.status,
        recipientCount: recipients.length,
      },
    }
  }

  /**
   * #4196 Class-B two-phase send for send_email. Tx A (claim) already decided we may attempt; here we attempt
   * EXACTLY ONCE (at-most-once — no in-call resend on an ambiguous failure), classify, record the outcome
   * (Tx B, guarded single-writer), and map to a step result.
   *
   * CLASSIFICATION (fail-closed, see the PR body): `NotificationService.send()` catches every transport
   * error internally and returns `{ status:'failed', failedReason:<REDACTED string> }` (or throws, rarely).
   * It NEVER surfaces the socket-level error code that would distinguish DEFINITE pre-dispatch non-delivery
   * (DNS / connection-refused / TLS handshake = nothing left the client) from post-dispatch loss (timeout /
   * reset after the DATA phase = the message MAY have been delivered). So `classifyOutboundResult` /
   * `classifyFetchError` are INAPPLICABLE here (there is no HTTP status and no undici code to read). Because
   * pre-dispatch non-delivery CANNOT be proven, a failed/thrown send maps to `outcome_unknown`, NEVER a plain
   * `failed` — a plain `failed` is retryable and a resend would risk a DUPLICATE email. Only a non-failed
   * result is `sent`. There is therefore no `failed` (retryable) terminal state on this path by construction.
   */
  private async executeSendEmailTwoPhase(
    outboundId: OutboundIntentIdentity,
    notificationService: Pick<NotificationService, 'send'>,
    notification: Notification,
    recipientCount: number,
  ): Promise<AutomationStepResult> {
    // Tx A — intent committed BEFORE the send. A prior sent/unknown short-circuits with no send.
    const decision = await claimOutboundIntent(this.deps.queryFn, outboundId)
    if (decision === 'skip_sent' || decision === 'skip_unknown') {
      return this.alreadyAppliedResult('send_email')
    }

    // decision is 'proceed' | 'retry_failed' → attempt ONCE.
    let outcome: OutboundOutcome
    let reason: string
    let sendResult: NotificationResult | null = null
    try {
      sendResult = await notificationService.send(notification)
      // Fail-closed mapping (see the method doc): only a non-failed result proves the send left the client;
      // a 'failed' result carries a REDACTED reason with no socket code, so it is un-provable as pre-dispatch
      // non-delivery ⇒ outcome_unknown (never a false `failed` that would permit a resend / duplicate email).
      outcome = sendResult.status === 'failed' ? 'outcome_unknown' : 'sent'
      reason = sendResult.status === 'failed' ? 'email_send_failed' : 'sent'
    } catch {
      // send() is not expected to throw (it catches internally), but a throw is equally un-provable as
      // pre-dispatch non-delivery ⇒ fail closed to outcome_unknown, never plain failed.
      outcome = 'outcome_unknown'
      reason = 'email_send_threw'
    }

    // Tx B — record the terminal outcome (guarded `status='pending'`, single-writer).
    await recordOutboundOutcome(this.deps.queryFn, outboundId, outcome, reason)

    if (outcome === 'sent') {
      return {
        actionType: 'send_email',
        status: 'success',
        output: {
          outcome: 'sent',
          notificationId: sendResult?.id,
          notificationStatus: sendResult?.status,
          recipientCount,
        },
      }
    }
    // outcome_unknown — the email MAY have been delivered; surfaced as failed so the run does NOT silently
    // succeed, and NEVER auto-resent (a retry consults the intent row and skips).
    return {
      actionType: 'send_email',
      status: 'failed',
      error: `send_email outcome_unknown (${reason}); recorded, not auto-resent`,
      output: {
        outcome: 'outcome_unknown',
        reason,
        ...(sendResult ? { notificationStatus: sendResult.status, failedReason: sendResult.failedReason } : {}),
      },
    }
  }

  /**
   * A-2b (one-tap lock #3594, owner-ratified): approval-card delivery.
   * - Only meaningful on approval.task_created rules: the recipient is FIXED from the trigger
   *   event's assignee (rule authors cannot supply users — no misdelivery surface).
   * - Ledger-first: the dingtalk_approval_card_deliveries row is written BEFORE the send (the
   *   callback/decision-page anchor), task_id recorded on success, send_status/send_error make a
   *   failed send traceable. Unbound recipients get a `skipped` row on the person-delivery
   *   telemetry (no card row — nothing to anchor) and NEVER a guessed mapping.
   * - The deep link carries ONLY the delivery id + an HMAC token (values-free): the decision page
   *   resolves everything server-side through the card-delivery wrapper (§4/§5), never raw /actions.
   */
  private async executeSendDingTalkApprovalCard(
    context: ExecutionContext,
    // #4196 Class-B follow-up. `config` (raw action config) feeds the §2.1 action-key; `identity` is the
    // execution lineage. Both are ignored when AUTOMATION_CLASSB_OUTBOUND_ENABLED is OFF (byte-identical).
    config: unknown,
    identity?: ClassAActionIdentity,
  ): Promise<AutomationStepResult> {
    const actionType = 'send_dingtalk_approval_card' as const
    const event = context.triggerEvent as {
      eventType?: unknown
      approval?: { instanceId?: unknown; requestNo?: unknown; templateId?: unknown }
      task?: { nodeKey?: unknown; entryEpoch?: unknown; assigneeUserId?: unknown; sourceStep?: unknown }
    } | null
    const instanceId = typeof event?.approval?.instanceId === 'string' ? event.approval.instanceId : ''
    const nodeKey = typeof event?.task?.nodeKey === 'string' ? event.task.nodeKey : ''
    const assigneeUserId = typeof event?.task?.assigneeUserId === 'string' ? event.task.assigneeUserId : ''
    if (event?.eventType !== 'approval.task_created' || !instanceId || !nodeKey || !assigneeUserId) {
      return { actionType, status: 'failed', error: 'send_dingtalk_approval_card requires an approval.task_created trigger event' }
    }

    // CFG-1: env first, stored directory-integration config as fallback (same-source with the
    // wrapper's verify — see approval-card-config.ts). Empty still fail-closes the send.
    const baseUrl = await resolveApprovalCardPublicAppUrl(this.deps.queryFn)
    if (!baseUrl) {
      return { actionType, status: 'failed', error: 'PUBLIC_APP_URL or APP_BASE_URL (or the stored approval-card public app URL) is required for the approval decision link' }
    }

    // Instance metadata for the card summary — ids/title/request_no only, NO form values.
    const instanceResult = await this.deps.queryFn(
      `SELECT title, request_no FROM approval_instances WHERE id = $1`,
      [instanceId],
    )
    const instanceRow = (instanceResult.rows[0] ?? null) as { title?: string | null; request_no?: string | null } | null
    if (!instanceRow) {
      return { actionType, status: 'failed', error: 'Approval instance not found for the pending-task event' }
    }
    const approvalTitle = typeof instanceRow.title === 'string' && instanceRow.title.trim() ? instanceRow.title.trim() : '审批待办'
    const requestNo = typeof instanceRow.request_no === 'string' ? instanceRow.request_no.trim() : ''

    // Recipient mapping: same directory-link lateral the person-message action uses; fail-closed.
    const recipientResult = await this.deps.queryFn(
      `SELECT u.id AS local_user_id,
              u.is_active AS local_user_active,
              linked.external_user_id AS dingtalk_user_id,
              linked.integration_id AS integration_id
         FROM users u
         LEFT JOIN LATERAL (
           SELECT a.external_user_id, a.integration_id::text AS integration_id
             FROM directory_account_links l
             JOIN directory_accounts a ON a.id = l.directory_account_id
            WHERE l.local_user_id = u.id
              AND l.link_status = 'linked'
              AND a.provider = 'dingtalk'
              AND a.is_active = TRUE
            ORDER BY a.updated_at DESC
            LIMIT 1
         ) linked ON TRUE
        WHERE u.id = $1`,
      [assigneeUserId],
    )
    const recipientRow = (recipientResult.rows[0] ?? null) as { local_user_active?: boolean; dingtalk_user_id?: string | null; integration_id?: string | null } | null
    const dingtalkUserId = typeof recipientRow?.dingtalk_user_id === 'string' ? recipientRow.dingtalk_user_id.trim() : ''
    // DT-OPS-04: send the card with the assignee's own corp credentials. DT-R2 closed the
    // remainder: the integration is persisted on the delivery row (integration_id) so the
    // approve/reject callback resolves the SAME corp's secret; the deep-link token is signed
    // with that integration's secret below (env override unchanged).
    const assigneeIntegrationId = typeof recipientRow?.integration_id === 'string' ? recipientRow.integration_id.trim() : ''
    if (!recipientRow || recipientRow.local_user_active !== true || !dingtalkUserId) {
      await recordDingTalkPersonDeliverySafely(this.deps.queryFn, {
        localUserId: assigneeUserId,
        sourceType: 'automation',
        subject: `审批待办：${approvalTitle}`,
        content: '(approval card skipped)',
        success: false,
        status: 'skipped',
        errorMessage: 'DingTalk account is not linked or user is inactive',
        automationRuleId: context.ruleId,
        recordId: context.recordId,
        initiatedBy: context.actorId ?? null,
      })
      return { actionType, status: 'failed', error: 'Recipient has no linked, active DingTalk account (skipped — mappings are never guessed)' }
    }

    // DT-R2 same-source signing: the deep-link token is signed with the ASSIGNEE integration's
    // secret (env `APPROVAL_CARD_LINK_SECRET` still wins) and the integration is persisted on
    // the delivery row, so the wrapper's verify resolves the identical source. No cross-corp
    // fallback: a missing per-corp secret fail-closes the send BEFORE any ledger row is written.
    const linkSecret = assigneeIntegrationId
      ? await resolveApprovalCardLinkSecretForIntegration(assigneeIntegrationId, this.deps.queryFn)
      : await resolveApprovalCardLinkSecret(this.deps.queryFn)
    if (!linkSecret) {
      return {
        actionType,
        status: 'failed',
        error: assigneeIntegrationId
          ? `APPROVAL_CARD_LINK_SECRET (env) or a stored approval-card link secret on the assignee's DingTalk integration (${assigneeIntegrationId}) is required for signed approval decision links`
          : 'APPROVAL_CARD_LINK_SECRET (env or stored approval-card link secret) is required for signed approval decision links',
      }
    }
    const interactiveCardConfig = resolveDingTalkInteractiveCardStreamConfig()
    // P1-2 cross-corp SEND gate: the interactive card is dispatched via the GLOBAL Stream app's
    // OWN credentials (robotCode = its clientId), so it may only go to a recipient in the Stream
    // app's OWN corp. Gate on flag-enabled AND the Stream app being bound to a directory
    // integration AND that binding matching the recipient's integration. Any mismatch — a
    // recipient in a different corp, an unbound Stream app, or a recipient with no integration —
    // falls through to the per-corp OA `work_notice_action_card` (the doc's "other corps
    // auto-fallback to OA"), never a card sent through the wrong corp's app.
    const streamIntegrationId = interactiveCardConfig.enabled === true ? interactiveCardConfig.integrationId : ''
    const useInteractiveCard =
      interactiveCardConfig.enabled === true
      && streamIntegrationId.length > 0
      && assigneeIntegrationId.length > 0
      && assigneeIntegrationId === streamIntegrationId

    // Ledger FIRST — the row is the only legitimate delivery → instance anchor.
    const entryEpochRaw = event.task?.entryEpoch
    const sourceStepRaw = event.task?.sourceStep
    if (typeof entryEpochRaw !== 'number') {
      // Review P3-1: a card with no node-entry epoch is dead-on-arrival under the strict binding
      // (never actionable). Surface it (values-free: ids + node only) instead of shipping silently.
      logger.warn('DingTalk approval card sent with no node-entry epoch — will not be actionable (fail-closed)', {
        instanceId,
        nodeKey,
        ruleId: context.ruleId,
      })
    }
    // #4196 Class-B two-phase (flag ON + identity present). Claim the outbound intent (Tx A) BEFORE the
    // card-delivery row is inserted, so a replay that already `sent` (or is ambiguously `outcome_unknown`)
    // short-circuits with NO card row and NO send. This sits AFTER every validation early-return above (those
    // are DEFINITE pre-send failures that must NOT leave a phantom `pending` intent that a later replay would
    // fail-close to unknown). Flag OFF (or the ad-hoc no-identity path) ⇒ outboundId null ⇒ everything below,
    // including the existing card-delivery ledger, is BYTE-IDENTICAL to pre-slice.
    const outboundId = this.classBOutboundIdentity(identity, 'send_dingtalk_approval_card', config)
    if (outboundId) {
      const decision = await claimOutboundIntent(this.deps.queryFn, outboundId)
      if (decision === 'skip_sent' || decision === 'skip_unknown') {
        return this.alreadyAppliedResult('send_dingtalk_approval_card')
      }
    }

    const delivery = await insertDingTalkApprovalCardDelivery(this.deps.queryFn, {
      instanceId,
      nodeKey,
      recipientUserId: assigneeUserId,
      recipientDingTalkUserId: dingtalkUserId,
      deliveryKind: useInteractiveCard ? 'interactive_card' : 'work_notice_action_card',
      integrationId: assigneeIntegrationId || null,
      // P1-1: persist the node-entry epoch this card is sent for so the action wrapper + the engine's
      // in-txn binding can bind the card to the SAME round's active assignment (closes same-node
      // re-entry). Review P3-1: under the STRICT binding a NULL epoch is NOT actionable (fail-closed
      // dead-on-arrival), so a null here means this card will never be clickable — warn (values-free)
      // rather than silently ship a dead card. Expected only for pre-epoch/legacy task events.
      entryEpoch: typeof entryEpochRaw === 'number' ? entryEpochRaw : null,
    })

    const token = createHmac('sha256', linkSecret).update(delivery.id).digest('hex').slice(0, 32)
    const decisionUrl = buildAppLink(baseUrl, '/m/approval-decision', { d: delivery.id, t: token })
    const markdownLines = [
      `### 审批待办：${approvalTitle}`,
      requestNo ? `- 编号：${requestNo}` : '',
      `- 节点：${nodeKey}${typeof sourceStepRaw === 'number' ? `（第 ${sourceStepRaw} 步）` : ''}`,
      '',
      '请点击下方按钮处理。',
    ].filter(Boolean)

    // #4196 Class-B: tracks whether the DingTalk send call RETURNED (the card was delivered). Used in the
    // catch to distinguish a post-send bookkeeping failure (markSent / Tx-B throw AFTER a successful send —
    // must never be recorded as a retryable `failed` that would resend a delivered card) from a send failure.
    let sendReturned = false
    try {
      const result = await (async () => {
        if (useInteractiveCard) {
          const accessToken = await fetchDingTalkAppAccessToken(
            {
              appKey: interactiveCardConfig.clientId,
              appSecret: interactiveCardConfig.clientSecret,
            },
            { fetchFn: this.deps.fetchFn },
          )
          return sendDingTalkInteractiveApprovalCard(
            accessToken,
            {
              userId: dingtalkUserId,
              robotCode: interactiveCardConfig.clientId,
              cardTemplateId: interactiveCardConfig.templateId,
              outTrackId: delivery.id,
              title: `审批待办：${approvalTitle}`,
              requestNo,
              nodeName: nodeKey,
              statusText: '等待你处理',
              rejectUrl: decisionUrl,
            },
            {},
            { fetchFn: this.deps.fetchFn },
          )
        }

        const messageConfig = await readDingTalkMessageConfigFromRuntime(assigneeIntegrationId || undefined)
        const accessToken = await fetchDingTalkAppAccessToken(messageConfig, { fetchFn: this.deps.fetchFn })
        return sendDingTalkWorkNotificationActionCard(
          accessToken,
          {
            userIds: [dingtalkUserId],
            title: `审批待办：${approvalTitle}`,
            markdown: markdownLines.join('\n'),
            singleTitle: '查看并处理',
            singleUrl: decisionUrl,
          },
          messageConfig,
          { fetchFn: this.deps.fetchFn },
        )
      })()
      // The send RETURNED → the card was delivered. #4196 Class-B: record the terminal `sent` outcome
      // (Tx B) BEFORE the card-ledger mark, so a subsequent bookkeeping failure (markSent throw) lands in
      // the catch with the intent ALREADY `sent` and cannot be mis-recorded as a retryable `failed`. Guarded
      // WHERE status='pending' (single-writer); reason is a bounded, values-free class.
      sendReturned = true
      if (outboundId) await recordOutboundOutcome(this.deps.queryFn, outboundId, 'sent', 'dingtalk_card_sent')
      await markDingTalkApprovalCardDeliverySent(this.deps.queryFn, delivery.id, result.taskId ?? null)
      return {
        actionType,
        status: 'success',
        output: {
          deliveryId: delivery.id,
          instanceId,
          nodeKey,
          entryEpoch: typeof entryEpochRaw === 'number' ? entryEpochRaw : null,
          recipientUserId: assigneeUserId,
          deliveryKind: useInteractiveCard ? 'interactive_card' : 'work_notice_action_card',
          taskId: result.taskId ?? null,
        },
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      // PR #4046 Phase B (owner doctrine): a send whose outcome is unknowable (transport marker —
      // network error/timeout/5xx/malformed 2xx) records the DISTINCT `outcome_unknown` ledger
      // state, never plain `failed`, and is NEVER auto-resent — the card may well have reached
      // the recipient. There is no task_id for a lost response, so DingTalk's async-send result
      // query cannot reconcile it automatically; reconciliation is manual/ops via this state.
      const outcomeUnknown = isDingTalkOutcomeUnknown(error)
      // DT-HARDEN-06: if the ledger row cannot be flipped out of `pending`, the card is
      // fail-closed but invisible — no sweeper, no admin listing. Swallowing that
      // silently (`.catch(() => null)`) hid the only signal an operator would ever get.
      // The send failure is still what we report; the bookkeeping failure is surfaced.
      let ledgerError: string | null = null
      try {
        if (outcomeUnknown) {
          await markDingTalkApprovalCardDeliverySendOutcomeUnknown(this.deps.queryFn, delivery.id, errorMessage)
        } else {
          await markDingTalkApprovalCardDeliverySendFailed(this.deps.queryFn, delivery.id, errorMessage)
        }
      } catch (markError) {
        ledgerError = markError instanceof Error ? markError.message : String(markError)
        logger.error(
          `DingTalk approval-card delivery ${delivery.id} is stuck pending: failed to record the send ${outcomeUnknown ? 'outcome-unknown state' : 'failure'}`,
          markError instanceof Error ? markError : new Error(ledgerError),
        )
      }
      // #4196 Class-B outcome (Tx B), recorded AFTER the existing card-ledger mark so that ledger's behavior
      // is byte-identical when the flag is OFF. Mapping:
      //   - sendReturned → the send DID return (only a post-send bookkeeping write threw): record `sent`,
      //     NEVER a retryable `failed` (a resend would DUPLICATE a delivered card). Guarded WHERE
      //     status='pending', so if the success path already flipped it to `sent` this is a no-op.
      //   - else, REUSE the transport's own send-tier signal (`isDingTalkOutcomeUnknown`, computed above —
      //     we do NOT re-run classifyFetchError on a result the DingTalk transport already interpreted):
      //     ambiguous ⇒ outcome_unknown (the card may have reached the recipient; never auto-resent);
      //     definite (HTTP 429 / non-5xx / business error — nothing delivered) ⇒ failed (re-attemptable).
      if (outboundId) {
        await recordOutboundOutcome(
          this.deps.queryFn,
          outboundId,
          sendReturned ? 'sent' : outcomeUnknown ? 'outcome_unknown' : 'failed',
          sendReturned ? 'dingtalk_card_sent' : outcomeUnknown ? 'dingtalk_send_outcome_unknown' : 'dingtalk_send_failed',
        )
      }
      return {
        actionType,
        status: 'failed',
        error: errorMessage,
        output: {
          deliveryId: delivery.id,
          ...(outcomeUnknown ? { deliveryOutcomeUnknown: true } : {}),
          ...(ledgerError ? { deliveryLedgerError: ledgerError, deliveryStuckPending: true } : {}),
        },
      }
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
    const renderedTitle = truncateDingTalkMessageText(
      renderAutomationTemplate(titleTemplate, templateData).trim(),
      DINGTALK_MESSAGE_TITLE_MAX_LENGTH,
    )
    const renderedBody = renderAutomationTemplate(bodyTemplate, templateData).trim()
    const bodyWithLinks = composeDingTalkBodyWithLinks(renderedBody, linkLines)

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
      // DT-OPS-04: carry the integration the recipient is actually bound under. A
      // DingTalk userid is only meaningful inside its own corp, so the credentials used
      // to notify them must come from that integration — not from whichever integration
      // happens to sort first as "latest active".
      `SELECT u.id AS local_user_id,
              u.is_active AS local_user_active,
              linked.external_user_id AS dingtalk_user_id,
              linked.integration_id AS integration_id
         FROM users u
         LEFT JOIN LATERAL (
           SELECT a.external_user_id, a.integration_id::text AS integration_id
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

    const recipientMap = new Map<string, { localUserId: string; dingtalkUserId: string; integrationId: string }>()
    for (const row of recipientsResult.rows as Array<Record<string, unknown>>) {
      const localUserId = typeof row.local_user_id === 'string' ? row.local_user_id.trim() : ''
      const dingtalkUserId = typeof row.dingtalk_user_id === 'string' ? row.dingtalk_user_id.trim() : ''
      const integrationId = typeof row.integration_id === 'string' ? row.integration_id.trim() : ''
      const isActive = row.local_user_active === true
      if (!localUserId || !isActive || !dingtalkUserId || recipientMap.has(localUserId)) continue
      recipientMap.set(localUserId, { localUserId, dingtalkUserId, integrationId })
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
      .filter((entry): entry is { localUserId: string; dingtalkUserId: string; integrationId: string } => Boolean(entry))
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

    // DT-OPS-04: a DingTalk userid only means anything inside its own corp, so each
    // recipient must be notified with the credentials of the integration they are bound
    // under. Recipients are grouped by integration and each group is sent with its own
    // token — never refused. A rule whose audience spans two corps is a legitimate rule
    // (a member group can hold both), and failing it would also abort the unrelated
    // actions that follow it in `executeActions`, which fail-stops.
    const recipientsByIntegration = new Map<string, typeof resolvedRecipients>()
    for (const recipient of resolvedRecipients) {
      const group = recipientsByIntegration.get(recipient.integrationId) ?? []
      group.push(recipient)
      recipientsByIntegration.set(recipient.integrationId, group)
    }

    const batches = Array.from(recipientsByIntegration.entries()).flatMap(
      ([integrationId, recipients]) =>
        chunkItems(recipients, DINGTALK_PERSON_BATCH_SIZE).map((batch) => ({ integrationId, batch })),
    )

    // DT-HARDEN-06: recipients whose batch already reached DingTalk. A later batch
    // throwing must not re-mark them failed — that used to write BOTH a success and a
    // failed delivery row for the same recipient in the same send attempt.
    const sentRecipients = new Set<(typeof resolvedRecipients)[number]>()
    // PR #4046 Phase B: the batch whose send call is IN FLIGHT when an error is thrown. Only
    // these recipients can have an UNKNOWN outcome (the send was attempted and the response was
    // lost); recipients of batches never reached have a KNOWN outcome (not sent) and stay
    // `failed`. Cleared after each successful batch; null while no send is in flight (so a
    // token-fetch/config failure — no send attempted — marks nobody outcome_unknown).
    let inFlightSendBatch: (typeof resolvedRecipients) | null = null

    try {
      let responseCount = 0
      // One token per integration, fetched once and reused across that integration's batches.
      type ResolvedCredentials = { messageConfig: Awaited<ReturnType<typeof readDingTalkMessageConfigFromRuntime>>; accessToken: string }
      const configCache = new Map<string, ResolvedCredentials>()

      for (const { integrationId, batch } of batches) {
        let credentials = configCache.get(integrationId)
        if (!credentials) {
          // Env-first resolution is preserved inside readDingTalkMessageConfigFromRuntime, so
          // an env-configured deployment keeps its bootstrap behavior; only the stored-config
          // path stops falling back to "latest active integration".
          const messageConfig = await readDingTalkMessageConfigFromRuntime(integrationId)
          const accessToken = await fetchDingTalkAppAccessToken(messageConfig, { fetchFn: this.deps.fetchFn })
          credentials = { messageConfig, accessToken }
          configCache.set(integrationId, credentials)
        }

        inFlightSendBatch = batch
        const result = await sendDingTalkWorkNotification(
          credentials.accessToken,
          {
            userIds: batch.map((recipient) => recipient.dingtalkUserId),
            title: renderedTitle,
            content: bodyWithLinks,
          },
          credentials.messageConfig,
          { fetchFn: this.deps.fetchFn },
        )
        inFlightSendBatch = null
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
        for (const recipient of batch) sentRecipients.add(recipient)
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
          integrationCount: recipientsByIntegration.size,
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

      // DT-HARDEN-06: only recipients whose batch never reached DingTalk are failures.
      // Recipients from earlier successful batches keep their success row — the send
      // did happen for them, and a partial failure is a partial result, not a total one.
      const unsentRecipients = resolvedRecipients.filter((recipient) => !sentRecipients.has(recipient))

      // PR #4046 Phase B: when the thrown error carries the transport's outcome-unknown marker,
      // the recipients of the batch that was IN FLIGHT get the DISTINCT `outcome_unknown` state
      // (the message may well have reached them — never auto-resent, reconciliation is
      // manual/ops). Recipients of batches never attempted have a KNOWN outcome and stay
      // `failed`, exactly as before.
      const outcomeUnknown = isDingTalkOutcomeUnknown(error)
      const outcomeUnknownRecipients = outcomeUnknown && inFlightSendBatch
        ? new Set<(typeof resolvedRecipients)[number]>(inFlightSendBatch)
        : new Set<(typeof resolvedRecipients)[number]>()

      await Promise.all(unsentRecipients.map((recipient) => recordDingTalkPersonDeliverySafely(this.deps.queryFn, {
        localUserId: recipient.localUserId,
        dingtalkUserId: recipient.dingtalkUserId,
        sourceType: 'automation',
        subject: renderedTitle,
        content: bodyWithLinks,
        success: false,
        status: outcomeUnknownRecipients.has(recipient) ? 'outcome_unknown' : 'failed',
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
        output: {
          notifiedUsers: sentRecipients.size,
          failedRecipientCount: unsentRecipients.length - outcomeUnknownRecipients.size,
          batchCount: batches.length,
          ...(outcomeUnknownRecipients.size > 0
            ? { deliveryOutcomeUnknown: true, outcomeUnknownRecipientCount: outcomeUnknownRecipients.size }
            : {}),
        },
      }
    }
  }

  private async executeLockRecord(
    config: Record<string, unknown>,
    context: ExecutionContext,
    identity?: ClassAActionIdentity,
  ): Promise<AutomationStepResult> {
    const locked = config.locked !== false // default to true (decision f: config.locked === false → unlock)

    // Phase C2b cross-base addressing — MIRRORS executeUpdateRecord. Locking a record in ANOTHER base is a
    // denial-of-edit on foreign data, gated by the SAME `evaluateCrossBaseWrite` primitive as a cross-base
    // write (base:write, not base:admin — lock is an edit-class affordance). The gate's same-base fast-path
    // (`targetSheetId === context.sheetId && no targetBaseId`) returns `{crossBase:false}` with NO base
    // lookups, so a same-base lock/unlock is BYTE-IDENTICAL to the pre-C2 behavior (it still writes the
    // trigger record). A cross-base lock REQUIRES the full target triple + claim==truth (the target record
    // must actually live in the target sheet). Lock is lock-MGMT (it sets the lock columns), so unlike
    // update/delete it does NOT call ensureRecordNotLocked.
    const targetSheetId = (config.targetSheetId as string) || context.sheetId
    const declaredTargetBaseId = typeof config.targetBaseId === 'string' ? config.targetBaseId : undefined

    try {
      const gate = await this.evaluateCrossBaseWrite(targetSheetId, declaredTargetBaseId, context)
      let effectiveSheetId = context.sheetId
      let effectiveRecordId = context.recordId
      if (gate.crossBase) {
        if (gate.ok === false) {
          return { actionType: 'lock_record', status: 'failed', error: gate.error }
        }
        const targetRecordId = typeof config.targetRecordId === 'string' ? config.targetRecordId : ''
        if (!config.targetSheetId || !targetRecordId) {
          return {
            actionType: 'lock_record',
            status: 'failed',
            error: 'Cross-base lock_record requires targetBaseId + targetSheetId + targetRecordId',
          }
        }
        effectiveSheetId = targetSheetId
        effectiveRecordId = targetRecordId

        // ②b claim==truth for the record: a cross-base lock must address a record that ACTUALLY lives in
        // `targetSheetId`. No row → fail-closed (never lock a phantom / silently no-op). Same-base skips
        // this SELECT entirely (fast-path), preserving byte-identical back-compat.
        const existsRes = await this.deps.queryFn(
          'SELECT 1 FROM meta_records WHERE id = $1 AND sheet_id = $2',
          [effectiveRecordId, effectiveSheetId],
        )
        if (!existsRes.rows[0]) {
          return {
            actionType: 'lock_record',
            status: 'failed',
            error: `Cross-base lock_record target record not found in target sheet: ${effectiveRecordId} ∉ ${effectiveSheetId}`,
          }
        }
      }

      if (locked) {
        const lockedBy = typeof context.actorId === 'string' && context.actorId.trim() ? context.actorId : 'system'
        // W0-1: write a lock marker at the new version so the contiguity precheck reads this legitimate
        // non-data version bump as a marker, not an uncaptured-write hole. Bump + marker are atomic inside
        // withTransaction (mirrors the HTTP lock path) — a transient error between the two must not leave
        // a durable version hole that fail-closed-refuses revert/reset until C6. The three disposition
        // markers live INSIDE the callback: each structural guard scans a fixed window above the SQL line.
        const skipped = await this.withTransaction(effectiveSheetId, async (query) => {
          // #4196 Class-A claim — FIRST statement, SAME transaction as the lock UPDATE+marker below. A
          // duplicate (retry/replay) short-circuits: skip the version bump and the lock marker entirely.
          if (await this.claimClassAOrSkip(query, identity, 'lock_record', config) === 'duplicate') {
            return 'duplicate' as const
          }
          // xbase-write-gated: routes through evaluateCrossBaseWrite (gate above) — cross-base lock rejected unless claim==truth + base-write.
          // lock-mgmt: LOCK action — sets the lock columns themselves (not a data edit of a locked row).
          // revision-exempt: lock/unlock metadata-only — no `data` column touched, not a user-content edit.
          const upd = await query(
            `UPDATE meta_records
             SET locked = true, locked_by = $1, locked_at = NOW(), version = version + 1, updated_at = NOW()
             WHERE id = $2 AND sheet_id = $3 RETURNING version`,
            [lockedBy, effectiveRecordId, effectiveSheetId],
          )
          const newVersion = Number((upd.rows[0] as { version?: unknown } | undefined)?.version)
          if (Number.isFinite(newVersion)) await recordVersionMarker(query, { sheetId: effectiveSheetId, recordId: effectiveRecordId, version: newVersion, kind: 'lock', actorId: typeof context.actorId === 'string' ? context.actorId : null })
          return null
        })
        if (skipped === 'duplicate') return this.alreadyAppliedResult('lock_record')
      } else {
        // W0-1: write an unlock marker at the new version — legitimate non-data bump, not a hole. Bump +
        // marker are atomic inside withTransaction (mirrors the HTTP unlock path) — no durable version hole.
        // Disposition markers live INSIDE the callback (fixed guard scan windows above the SQL line).
        const skipped = await this.withTransaction(effectiveSheetId, async (query) => {
          // #4196 Class-A claim — FIRST statement, SAME transaction as the unlock UPDATE+marker below. A
          // duplicate (retry/replay) short-circuits: skip the version bump and the unlock marker entirely.
          if (await this.claimClassAOrSkip(query, identity, 'lock_record', config) === 'duplicate') {
            return 'duplicate' as const
          }
          // xbase-write-gated: routes through evaluateCrossBaseWrite (gate above) — cross-base unlock rejected unless claim==truth + base-write.
          // lock-mgmt: UNLOCK action — clears the lock columns (decision f: automation may unlock).
          // revision-exempt: lock/unlock metadata-only — no `data` column touched, not a user-content edit.
          const upd = await query(
            `UPDATE meta_records
             SET locked = false, locked_by = NULL, locked_at = NULL, version = version + 1, updated_at = NOW()
             WHERE id = $1 AND sheet_id = $2 RETURNING version`,
            [effectiveRecordId, effectiveSheetId],
          )
          const newVersion = Number((upd.rows[0] as { version?: unknown } | undefined)?.version)
          if (Number.isFinite(newVersion)) await recordVersionMarker(query, { sheetId: effectiveSheetId, recordId: effectiveRecordId, version: newVersion, kind: 'unlock', actorId: typeof context.actorId === 'string' ? context.actorId : null })
          return null
        })
        if (skipped === 'duplicate') return this.alreadyAppliedResult('lock_record')
      }

      return {
        actionType: 'lock_record',
        status: 'success',
        output: { locked, recordId: effectiveRecordId },
      }
    } catch (err) {
      // Failures surface honestly in the automation execution log instead of crashing the run.
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
    const renderedTitle = truncateDingTalkMessageText(
      renderAutomationTemplate(titleTemplate, templateData).trim(),
      DINGTALK_MESSAGE_TITLE_MAX_LENGTH,
    )
    const renderedBody = renderAutomationTemplate(bodyTemplate, templateData).trim()
    const bodyWithLinks = composeDingTalkBodyWithLinks(renderedBody, linkLines)
    const orderedDestinations = destinationIds
      .map((id) => destinationsById.get(id))
      .filter((destination): destination is NonNullable<typeof destination> => Boolean(destination))
    const successfulDestinations: Array<{ id: string; name: string }> = []
    const failedDestinations: Array<{ id: string; name: string; error: string }> = []
    const runtimeWebhookByDestinationId = new Map<string, { webhookUrl: string; secret?: string }>()

    for (const destination of orderedDestinations) {
      try {
        // DT-HARDEN-03: destinations are stored encrypted; decrypt before URL
        // validation and HMAC signing. Reading the raw column here would feed an
        // `enc:` blob to normalizeDingTalkRobotWebhookUrl and fail every send.
        runtimeWebhookByDestinationId.set(destination.id, {
          webhookUrl: normalizeDingTalkRobotWebhookUrl(
            decryptDingTalkDestinationWebhookUrl(destination.webhook_url),
          ),
          secret: normalizeDingTalkRobotSecret(decryptDingTalkDestinationSecret(destination.secret)),
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
