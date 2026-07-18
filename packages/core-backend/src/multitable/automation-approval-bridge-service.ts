/**
 * Automation Approval Bridge Service — W6-1 start_approval runtime.
 *
 * Owns the durable linkage between one automation job and one approval-product
 * instance. It deliberately does not execute the automation tail; AutomationService
 * claims bridge completion and calls AutomationExecutor.continueExecution().
 */

import { randomUUID } from 'crypto'
import { sql } from 'kysely'
import { db } from '../db/db'
import { query } from '../db/pg'
import { isDurableDeliveryEnabled } from './automation-durable-delivery'
import { toJsonValue } from '../db/type-helpers'
import { ServiceError } from '../services/ApprovalBridgeService'
import { ApprovalProductService } from '../services/ApprovalProductService'
import type { ApprovalCompletionEventV1, ApprovalCompletionOutcome } from '../services/ApprovalCompletionEvent'
import type { UnifiedApprovalDTO } from '../services/approval-bridge-types'
import { isAdmin } from '../rbac/service'
import { filterPermissionCodesByNamespaceAdmission } from '../rbac/namespace-admission'
import { redactValue } from './automation-log-redact'
import { AutomationJobService } from './automation-job-service'
import { computeActionFingerprint, type ActionFingerprint } from './automation-suspension-service'
import {
  lookupTemplateValue,
  renderAutomationTemplate,
  type AutomationExecution,
  type AutomationStepResult,
  type ExecutionContext,
} from './automation-executor'
import type { AutomationAction, StartApprovalConfig } from './automation-actions'

// P2 durable-delivery P1#1: `in_progress` (completion claimed, continuation running — holds a lease + fence)
// and `dead_letter` (continuation crashed past the attempt ceiling — terminal) are the reclaimable-lease
// additions. They exist ONLY on the flag-ON path; flag OFF still flips pending→resumed terminally.
type BridgeStatus = 'creating' | 'pending' | 'in_progress' | 'resumed' | 'failed' | 'dead_letter'

/** Reclaimable-lease knobs for the flag-ON completion claim (mirror S6 EVENT_DELIVERY_LEASE_MS + dispatcher). */
const BRIDGE_COMPLETION_LEASE_MS = 60_000
export const BRIDGE_COMPLETION_MAX_ATTEMPTS = 8

export interface AutomationApprovalBridgeRow {
  id: string
  executionId: string
  rootExecutionId: string
  ruleId: string
  sheetId: string | null
  recordId: string | null
  stepIndex: number
  approvalInstanceId: string | null
  approvalRequestNo: string | null
  approvalTemplateId: string
  approvalPublishedDefinitionId: string | null
  idempotencyKey: string
  status: BridgeStatus
  outcome: string | null
  /** P1#1 lease token (bigint as string; '0' on the flag-OFF path). The completion handler passes it to
   *  `markBridgeResumed` for the fence-CAS terminal write so a reclaimed zombie can never overwrite it. */
  fence: string
  actionFingerprint: ActionFingerprint
  triggerEvent: unknown
}

/**
 * Discriminated completion-claim result (done/busy split — sink-recoverability audit 2026-07-17).
 * `claimed` = THIS caller owns the bridge (fresh or reclaimed; legacy terminal-early also maps here);
 * `none` = nothing to do (no bridge for the approval / already terminal / just poisoned) — skip is correct;
 * `busy` = ANOTHER worker holds a LIVE lease — the caller must fail retryably, NEVER resolve `done` (a
 * crashed holder's continuation would be dropped forever) and NEVER run (a live holder would double-drive).
 */
export type ApprovalBridgeClaimResult =
  | { kind: 'claimed'; row: AutomationApprovalBridgeRow }
  | { kind: 'none' }
  | { kind: 'busy' }

export interface StartApprovalBridgeResult {
  suspended: boolean
  result?: AutomationStepResult
  approval: Pick<UnifiedApprovalDTO, 'id' | 'requestNo' | 'templateId' | 'publishedDefinitionId' | 'status'>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeStartApprovalConfig(config: Record<string, unknown>): StartApprovalConfig {
  const templateId = normalizeString(config.templateId)
  if (!templateId) {
    throw new ServiceError('start_approval.templateId is required', 400, 'VALIDATION_ERROR')
  }
  const rawMapping = isRecord(config.formDataMapping) ? config.formDataMapping : null
  if (!rawMapping || Object.keys(rawMapping).length === 0) {
    throw new ServiceError('start_approval.formDataMapping is required', 400, 'VALIDATION_ERROR')
  }
  const formDataMapping: Record<string, string> = {}
  for (const [key, value] of Object.entries(rawMapping)) {
    const fieldId = key.trim()
    const expression = normalizeString(value)
    if (!fieldId || !expression) {
      throw new ServiceError('start_approval.formDataMapping entries must be non-empty strings', 400, 'VALIDATION_ERROR')
    }
    formDataMapping[fieldId] = expression
  }
  const requesterRaw = isRecord(config.requester) ? config.requester : undefined
  const mode = requesterRaw?.mode === 'rule_creator' ? 'rule_creator' : 'trigger_actor'
  return {
    templateId,
    formDataMapping,
    requester: { mode },
  }
}

export function hasPermissionCode(permissionCodes: string[], permissionCode: string): boolean {
  if (permissionCodes.includes(permissionCode) || permissionCodes.includes('*:*')) return true
  const resource = permissionCode.split(':')[0]
  return resource ? permissionCodes.includes(`${resource}:*`) : false
}

export async function listRbacPermissionCodes(userId: string): Promise<string[]> {
  const result = await query<{ code: string }>(
    `SELECT DISTINCT permission_code AS code FROM (
       SELECT up.permission_code
         FROM user_permissions up
        WHERE up.user_id = $1
       UNION ALL
       SELECT rp.permission_code
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
        WHERE ur.user_id = $1
     ) t`,
    [userId],
  )
  return filterPermissionCodesByNamespaceAdmission(
    userId,
    result.rows.map((row) => row.code),
  )
}

function rootIdFor(execution: Pick<AutomationExecution, 'id' | 'rerunOfExecutionId'> & { rootExecutionId?: string }): string {
  return execution.rootExecutionId || execution.rerunOfExecutionId || execution.id
}

function buildTemplateData(context: ExecutionContext): Record<string, unknown> {
  return {
    ...context.recordData,
    record: context.recordData,
    trigger: context.triggerEvent,
    sheetId: context.sheetId,
    recordId: context.recordId,
    actorId: context.actorId,
    ruleId: context.ruleId,
    executionId: context.executionId,
  }
}

function renderMappedValue(expression: string, data: Record<string, unknown>): unknown {
  if (expression.includes('{{')) return renderAutomationTemplate(expression, data)
  const lookedUp = lookupTemplateValue(expression, data)
  return lookedUp === undefined ? '' : lookedUp
}

function buildFormData(mapping: Record<string, string>, context: ExecutionContext): Record<string, unknown> {
  const data = buildTemplateData(context)
  return Object.fromEntries(
    Object.entries(mapping).map(([fieldId, expression]) => [fieldId, renderMappedValue(expression, data)]),
  )
}

function isTerminalApprovalStatus(status: string): status is ApprovalCompletionOutcome {
  return status === 'approved' || status === 'rejected' || status === 'revoked' || status === 'cancelled'
}

function stepResultForApproval(approval: Pick<UnifiedApprovalDTO, 'id' | 'requestNo' | 'templateId' | 'publishedDefinitionId' | 'status'>): AutomationStepResult {
  const output = {
    approvalInstanceId: approval.id,
    requestNo: approval.requestNo ?? null,
    templateId: approval.templateId ?? null,
    publishedDefinitionId: approval.publishedDefinitionId ?? null,
    outcome: approval.status,
  }
  if (approval.status === 'approved') {
    return { actionType: 'start_approval', status: 'success', output, durationMs: 0 }
  }
  return {
    actionType: 'start_approval',
    status: 'failed',
    output,
    error: `Approval completed with ${approval.status}`,
    durationMs: 0,
  }
}

export class AutomationApprovalBridgeService {
  constructor(
    private readonly jobService: AutomationJobService,
    private readonly approvalProductService: ApprovalProductService = new ApprovalProductService(),
  ) {}

  async hasCreatedApprovalForAnyExecution(executionIds: string[]): Promise<boolean> {
    const ids = Array.from(new Set(executionIds.filter(Boolean)))
    if (ids.length === 0) return false
    const row = await db
      .selectFrom('multitable_automation_approval_bridges')
      .select('id')
      .where((eb) => eb.or([
        eb('execution_id', 'in', ids),
        eb('root_execution_id', 'in', ids),
      ]))
      .where('approval_instance_id', 'is not', null)
      .executeTakeFirst()
    return row != null
  }

  async startApproval(input: {
    execution: Pick<AutomationExecution, 'id' | 'rerunOfExecutionId'> & { rootExecutionId?: string }
    rule: { id: string; sheetId?: string; actions: ReadonlyArray<AutomationAction>; createdBy?: string }
    context: ExecutionContext
    stepIndex: number
    action: AutomationAction
  }): Promise<StartApprovalBridgeResult> {
    const config = normalizeStartApprovalConfig(input.action.config)
    const rootExecutionId = rootIdFor(input.execution)
    const idempotencyKey = `start_approval:${rootExecutionId}:${input.stepIndex}:${config.templateId}`

    const existing = await db
      .selectFrom('multitable_automation_approval_bridges')
      .select(['id', 'approval_instance_id', 'status'])
      .where('idempotency_key', '=', idempotencyKey)
      .where((eb) => eb.or([
        eb('status', '<>', 'failed'),
        eb('approval_instance_id', 'is not', null),
      ]))
      .executeTakeFirst()
    if (existing) {
      throw new ServiceError('start_approval already created an approval for this execution step', 409, 'START_APPROVAL_DUPLICATE')
    }

    const actor = await this.loadAuthorizedActor(config, input.context, input.rule.createdBy ?? '')
    const formData = buildFormData(config.formDataMapping, input.context)
    const bridgeId = `aab_${randomUUID()}`
    const fingerprint = computeActionFingerprint(input.rule.actions)

    await db
      .insertInto('multitable_automation_approval_bridges')
      .values({
        id: bridgeId,
        execution_id: input.execution.id,
        root_execution_id: rootExecutionId,
        rule_id: input.rule.id,
        sheet_id: input.rule.sheetId ?? null,
        record_id: input.context.recordId || null,
        step_index: input.stepIndex,
        approval_instance_id: null,
        approval_request_no: null,
        approval_template_id: config.templateId,
        approval_published_definition_id: null,
        idempotency_key: idempotencyKey,
        status: 'creating',
        outcome: null,
        action_fingerprint: toJsonValue(fingerprint) as never,
        trigger_event: input.context.triggerEvent == null ? null : (toJsonValue(redactValue(input.context.triggerEvent)) as never),
      })
      .execute()

    let approval: UnifiedApprovalDTO
    try {
      approval = await this.approvalProductService.createApproval(
        { templateId: config.templateId, formData },
        actor,
      )
    } catch (error) {
      await this.markBridgeFailed(bridgeId)
      throw error
    }

    const terminal = isTerminalApprovalStatus(approval.status)
    const result = terminal ? stepResultForApproval(approval) : undefined

    await db
      .updateTable('multitable_automation_approval_bridges')
      .set({
        approval_instance_id: approval.id,
        approval_request_no: approval.requestNo ?? null,
        approval_published_definition_id: approval.publishedDefinitionId ?? null,
        status: terminal ? 'resumed' : 'pending',
        outcome: terminal ? approval.status : null,
        completed_at: terminal ? new Date().toISOString() : null,
        resumed_at: terminal ? new Date().toISOString() : null,
      } as never)
      .where('id', '=', bridgeId)
      .execute()

    try {
      await db.transaction().execute(async (trx) => {
        if (terminal && result) {
          await this.jobService.writeSettledJob(
            input.execution.id,
            { id: input.rule.id, sheetId: input.rule.sheetId },
            input.stepIndex,
            input.action,
            result,
            trx,
          )
        } else {
          await this.jobService.writeSuspendedJob(
            input.execution.id,
            { id: input.rule.id, sheetId: input.rule.sheetId },
            input.stepIndex,
            input.action,
            trx,
          )
        }
      })
    } catch (error) {
      await this.markBridgeFailed(bridgeId)
      throw error
    }

    return {
      suspended: !terminal,
      ...(result ? { result } : {}),
      approval: {
        id: approval.id,
        requestNo: approval.requestNo,
        templateId: approval.templateId,
        publishedDefinitionId: approval.publishedDefinitionId,
        status: approval.status,
      },
    }
  }

  /**
   * Claim the completion of a suspended bridge so exactly one worker resumes it.
   *
   * Flag OFF (legacy, byte-identical): atomically flip `pending → resumed` (TERMINAL) and return the row. The
   * caller runs the continuation AFTER this terminal write — the window the P1 finding is about.
   *
   * Flag ON (P1#1 recoverable lease): flip `pending → in_progress` with a lease + `fence`+1 (a FRESH claim), or
   * RECLAIM an EXPIRED `in_progress` lease left by a crashed worker (`fence`+1, `attempts`+1). A row still under
   * a LIVE lease, or already terminal, returns null (skip — another worker owns it / it is done). A crashed
   * worker whose reclaim would exceed `BRIDGE_COMPLETION_MAX_ATTEMPTS` is DEAD-LETTERED at claim (bounded — no
   * infinite reclaim of a continuation that always crashes) and returns null. The caller runs the continuation
   * and then calls `markBridgeResumed(id, fence)` (fence-CAS) — NO terminal-early write.
   */
  async claimCompletion(
    event: ApprovalCompletionEventV1,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<ApprovalBridgeClaimResult> {
    const approvalId = event.approval.instanceId

    if (!isDurableDeliveryEnabled(env)) {
      // LEGACY terminal-early path — byte-identical to the pre-P1#1 behavior (never 'busy').
      const claimed = await db
        .updateTable('multitable_automation_approval_bridges')
        .set({
          status: 'resumed',
          outcome: event.transition.toStatus,
          completed_at: event.occurredAt,
          resumed_at: new Date().toISOString(),
        } as never)
        .where('approval_instance_id', '=', approvalId)
        .where('status', '=', 'pending')
        .returningAll()
        .executeTakeFirst()
      return claimed ? { kind: 'claimed', row: this.mapRow(claimed as Record<string, unknown>) } : { kind: 'none' }
    }

    // FLAG-ON reclaimable-lease path. Raw SQL for the fence-CAS + lease arithmetic (mirrors S6 event_fires).
    const leaseMs = BRIDGE_COMPLETION_LEASE_MS
    // 1) FRESH claim: pending → in_progress, lease + fence 1 + attempts 1. Records outcome/completed_at now
    //    (idempotent — the same completion event carries the same outcome on any redelivery).
    const fresh = await sql<Record<string, unknown>>`
      UPDATE multitable_automation_approval_bridges
      SET status = 'in_progress', lease_expires_at = now() + ${leaseMs} * interval '1 millisecond',
          fence = fence + 1, attempts = attempts + 1,
          outcome = ${event.transition.toStatus}, completed_at = ${event.occurredAt}
      WHERE approval_instance_id = ${approvalId} AND status = 'pending'
      RETURNING *
    `.execute(db)
    if (fresh.rows.length > 0) return { kind: 'claimed', row: this.mapRow(fresh.rows[0]) }

    // 2) POISON at reclaim: an EXPIRED in_progress that has already exhausted its attempts → dead_letter
    //    (terminal, lease cleared). Returns null (skip) — the work will not be retried again.
    const poisoned = await sql<{ id: string }>`
      UPDATE multitable_automation_approval_bridges
      SET status = 'dead_letter', lease_expires_at = NULL
      WHERE approval_instance_id = ${approvalId} AND status = 'in_progress'
        AND lease_expires_at < now() AND attempts >= ${BRIDGE_COMPLETION_MAX_ATTEMPTS}
      RETURNING id
    `.execute(db)
    if (poisoned.rows.length > 0) return { kind: 'none' }

    // 3) RECLAIM an EXPIRED in_progress lease (crashed worker): fence+1, attempts+1, new lease. Concurrent
    //    reclaimers race — exactly one matches (the winner's new future lease makes the loser's `< now()`
    //    predicate false → 0 rows). A LIVE lease or an already-terminal row matches nothing → null (skip).
    const reclaim = await sql<Record<string, unknown>>`
      UPDATE multitable_automation_approval_bridges
      SET fence = fence + 1, attempts = attempts + 1, lease_expires_at = now() + ${leaseMs} * interval '1 millisecond'
      WHERE approval_instance_id = ${approvalId} AND status = 'in_progress'
        AND lease_expires_at < now() AND attempts < ${BRIDGE_COMPLETION_MAX_ATTEMPTS}
      RETURNING *
    `.execute(db)
    if (reclaim.rows.length > 0) return { kind: 'claimed', row: this.mapRow(reclaim.rows[0]) }
    // Neither claimed, poisoned, nor reclaimed: classify (done/busy split — sink audit 2026-07-17). NO row
    // for this approval (the dominant case — most approvals have no automation bridge) or a TERMINAL row
    // (resumed / failed / dead_letter — the completion is consumed) → 'none' (skip is correct). A LIVE
    // in_progress lease → 'busy' (the caller fails retryably rather than resolving the delivery `done` and
    // dropping a crashed holder's continuation). A racing `pending` (appeared between the fresh UPDATE and
    // this SELECT) is also 'busy' — fail-closed toward retry; the redelivery claims it.
    const row = await sql<{ status: string }>`
      SELECT status FROM multitable_automation_approval_bridges WHERE approval_instance_id = ${approvalId}
    `.execute(db)
    const status = row.rows[0]?.status
    if (status === undefined || status === 'resumed' || status === 'failed' || status === 'dead_letter') {
      return { kind: 'none' }
    }
    return { kind: 'busy' }
  }

  /**
   * P1#1: the TERMINAL write, done AFTER the continuation completes (success OR a deterministic failure —
   * both "consumed the completion", mirroring the legacy `resumed` meaning). fence-CAS: a reclaimed zombie
   * whose fence is stale matches 0 rows, so it can never overwrite the live owner's terminal state
   * (single-writer). Returns true when THIS caller (holding `fence`) won the terminal write.
   */
  async markBridgeResumed(id: string, fence: string): Promise<boolean> {
    const res = await sql`
      UPDATE multitable_automation_approval_bridges
      SET status = 'resumed', lease_expires_at = NULL, resumed_at = now()
      WHERE id = ${id} AND fence = ${fence}::bigint AND status = 'in_progress'
    `.execute(db)
    return Number(res.numAffectedRows ?? 0) === 1
  }

  private async markBridgeFailed(id: string): Promise<void> {
    await db
      .updateTable('multitable_automation_approval_bridges')
      .set({ status: 'failed' } as never)
      .where('id', '=', id)
      .execute()
  }

  private async loadAuthorizedActor(
    config: StartApprovalConfig,
    context: ExecutionContext,
    ruleCreatedBy: string,
  ): Promise<{
    userId: string
    userName?: string
    email?: string
    department?: string
    departmentIds?: string[]
    roles?: string[]
    permissions?: string[]
  }> {
    const preferred = config.requester?.mode === 'rule_creator'
      ? ruleCreatedBy
      : (context.actorId || ruleCreatedBy)
    const userId = normalizeString(preferred)
    if (!userId) {
      throw new ServiceError('start_approval requester could not be resolved', 400, 'START_APPROVAL_REQUESTER_REQUIRED')
    }

    const userResult = await query<{
      id: string
      email: string | null
      username: string | null
      name: string | null
      role: string | null
      is_active: boolean | null
    }>(
      `SELECT id, email, username, name, role, is_active
         FROM users
        WHERE id = $1
        LIMIT 1`,
      [userId],
    )
    const user = userResult.rows[0]
    if (!user || user.is_active === false) {
      throw new ServiceError('start_approval requester user not found or inactive', 404, 'START_APPROVAL_REQUESTER_NOT_FOUND')
    }

    const permissions = await listRbacPermissionCodes(userId)
    const roles = await this.loadUserRoles(userId, user.role)
    const allowed = await isAdmin(userId)
      || hasPermissionCode(permissions, 'approvals:write')
    if (!allowed) {
      throw new ServiceError('start_approval requester lacks approvals:write', 403, 'START_APPROVAL_PERMISSION_DENIED')
    }

    return {
      userId,
      userName: user.name ?? user.username ?? user.email ?? userId,
      email: user.email ?? undefined,
      roles,
      permissions,
    }
  }

  private async loadUserRoles(userId: string, legacyRole: string | null): Promise<string[]> {
    const roles = new Set<string>()
    if (legacyRole && legacyRole.trim()) roles.add(legacyRole.trim())
    try {
      const result = await query<{ role_id: string }>(
        `SELECT role_id FROM user_roles WHERE user_id = $1`,
        [userId],
      )
      for (const row of result.rows) {
        if (row.role_id && row.role_id.trim()) roles.add(row.role_id.trim())
      }
    } catch {
      // Older/degraded deployments may not have user_roles; legacy users.role still applies.
    }
    return Array.from(roles)
  }

  private mapRow(row: Record<string, unknown>): AutomationApprovalBridgeRow {
    const fpRaw = typeof row.action_fingerprint === 'string'
      ? JSON.parse(row.action_fingerprint)
      : (row.action_fingerprint ?? {})
    const fp = (fpRaw && typeof fpRaw === 'object' ? fpRaw : {}) as Record<string, unknown>
    return {
      id: row.id as string,
      executionId: row.execution_id as string,
      rootExecutionId: row.root_execution_id as string,
      ruleId: row.rule_id as string,
      sheetId: (row.sheet_id as string) ?? null,
      recordId: (row.record_id as string) ?? null,
      stepIndex: Number(row.step_index),
      approvalInstanceId: (row.approval_instance_id as string) ?? null,
      approvalRequestNo: (row.approval_request_no as string) ?? null,
      approvalTemplateId: row.approval_template_id as string,
      approvalPublishedDefinitionId: (row.approval_published_definition_id as string) ?? null,
      idempotencyKey: row.idempotency_key as string,
      status: row.status as BridgeStatus,
      outcome: (row.outcome as string) ?? null,
      fence: String(row.fence ?? '0'),
      actionFingerprint: { count: Number(fp.count ?? 0), hash: String(fp.hash ?? '') },
      triggerEvent: typeof row.trigger_event === 'string' ? JSON.parse(row.trigger_event) : (row.trigger_event ?? null),
    }
  }
}
