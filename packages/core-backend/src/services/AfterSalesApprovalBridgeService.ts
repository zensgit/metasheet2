import { randomUUID } from 'crypto'

import { Logger } from '../core/logger'
import { pool } from '../db/pg'
import type {
  ApprovalActionRequest,
  UnifiedApprovalDTO,
} from './approval-bridge-types'
import { ApprovalBridgeService } from './ApprovalBridgeService'

const logger = new Logger('AfterSalesApprovalBridgeService')
// After-sales talks about a "bridge" because that is the plugin-facing command
// vocabulary. approval_instances stores the same identifier in workflow_key to
// stay aligned with the wider unified approval schema and ApprovalBridgeService.
// For after-sales v1 these names intentionally point to the same stable value.
export const REFUND_WORKFLOW_KEY = 'after-sales-refund'
const DEFAULT_ASSIGNMENT_ROLES = ['finance', 'supervisor'] as const

/**
 * Closed subject surface for after-sales refund plugin/callbacks.
 * Mirrors AfterSalesRefundApprovalCommand.subject field names only — never an
 * open index signature. Project each named field; never spread dto.subject
 * (legacy subject_snapshot may carry recordId / formSnapshot / nested extras).
 */
export interface AfterSalesRefundSubjectSummary {
  projectId: string | null
  ticketId: string | null
  ticketNo: string | null
  title: string | null
  refundAmount: number | null
  currency: string | null
}

/**
 * Narrow plugin/callback surface for after-sales refund approvals.
 *
 * Plugin-after-sales only consumes id/status/subject (plus stable bridge metadata).
 * Never forward a full UnifiedApprovalDTO (formSnapshot / formSchema / record-link
 * ids) into plugin returns or onDecision/onApproved/onRejected callbacks — those
 * would leak authorized linked record ids once after-sales uses template forms.
 * Normal HTTP approval action responses stay on UnifiedApprovalDTO unchanged.
 */
export interface AfterSalesApprovalSummary {
  id: string
  sourceSystem: string
  workflowKey: string | null
  businessKey: string | null
  title: string | null
  status: string
  subject: AfterSalesRefundSubjectSummary | null
  currentStep: number | null
  totalSteps: number | null
  updatedAt: string
}

function optionalTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function optionalFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/**
 * Project subject_snapshot / dto.subject to the closed refund subject summary.
 * Field-by-field only — never Object.assign / spread (blocks recordId leaks).
 * Currency defaults to 'CNY' when a subject object is present but currency is
 * missing/blank (parity with normalizeCommand submit path).
 */
export function toAfterSalesRefundSubjectSummary(
  subject: unknown,
): AfterSalesRefundSubjectSummary | null {
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)) return null
  const raw = subject as Record<string, unknown>
  const currencyRaw = optionalTrimmedString(raw.currency)
  return {
    projectId: optionalTrimmedString(raw.projectId),
    ticketId: optionalTrimmedString(raw.ticketId),
    ticketNo: optionalTrimmedString(raw.ticketNo),
    title: optionalTrimmedString(raw.title),
    refundAmount: optionalFiniteNumber(raw.refundAmount),
    // Present subject object → currency defaults to CNY when absent (command parity).
    currency: currencyRaw ?? 'CNY',
  }
}

/**
 * Project a UnifiedApprovalDTO down to the explicit after-sales summary.
 * Drops formSnapshot, formSchema, assignments, requester, policy, and every
 * other field that is not on AfterSalesApprovalSummary. Subject is closed.
 */
export function toAfterSalesApprovalSummary(
  dto: UnifiedApprovalDTO,
): AfterSalesApprovalSummary {
  return {
    id: dto.id,
    sourceSystem: dto.sourceSystem,
    workflowKey: dto.workflowKey ?? null,
    businessKey: dto.businessKey ?? null,
    title: dto.title ?? null,
    status: dto.status,
    subject: toAfterSalesRefundSubjectSummary(dto.subject),
    currentStep: dto.currentStep ?? null,
    totalSteps: dto.totalSteps ?? null,
    updatedAt: dto.updatedAt,
  }
}

/**
 * Explicit no-viewer sentinel for internal bridge loads.
 * Pass this (not an omitted argument) so callers cannot confuse "no viewer" with
 * "use ambient viewer authority" or invent a synthetic actor.
 */
export const AFTER_SALES_NO_VIEWER: null = null

type QueryResultLike<T = unknown> = {
  rows: T[]
  rowCount?: number | null
}

type Queryable = {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResultLike<T>>
}

type TransactionClient = Queryable & {
  release(): void
}

type TransactionPool = Queryable & {
  connect(): Promise<TransactionClient>
}

export interface AfterSalesRefundApprovalCommand {
  bridge: string
  sourceSystem: 'after-sales'
  topic: string
  title: string
  businessKey: string
  requester: {
    id: string
    name?: string
  }
  subject: {
    projectId: string
    ticketId: string
    ticketNo: string
    title: string
    refundAmount: number
    currency?: string
  }
  policy?: Record<string, unknown>
  metadata?: Record<string, unknown>
  assignmentRoles?: string[]
}

export interface AfterSalesRefundApprovalQueryInput {
  approvalId?: string
  businessKey?: string
  ticketId?: string
  projectId?: string
}

export interface AfterSalesRefundApprovalDecisionInput extends AfterSalesRefundApprovalQueryInput {
  action: 'approve' | 'reject'
  actorId: string
  actorName?: string
  comment?: string
  ip?: string | null
  userAgent?: string | null
}

export interface AfterSalesRefundApprovalCallbacks {
  onDecision?: (
    approval: AfterSalesApprovalSummary,
    decision: AfterSalesRefundApprovalDecisionInput,
  ) => Promise<void> | void
  onApproved?: (
    approval: AfterSalesApprovalSummary,
    decision: AfterSalesRefundApprovalDecisionInput,
  ) => Promise<void> | void
  onRejected?: (
    approval: AfterSalesApprovalSummary,
    decision: AfterSalesRefundApprovalDecisionInput,
  ) => Promise<void> | void
}

export interface AfterSalesRefundApprovalSubmitResult {
  created: boolean
  approvalId: string
  approval: AfterSalesApprovalSummary
}

export interface AfterSalesRefundApprovalDecisionResult {
  approvalId: string
  approval: AfterSalesApprovalSummary
  decision: 'approved' | 'rejected'
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`)
  }
  return value.trim()
}

function requiredNumber(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be a finite number`)
  }
  return parsed
}

function normalizeAssignmentRoles(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_ASSIGNMENT_ROLES]
  }
  const roles = value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
  return roles.length > 0 ? Array.from(new Set(roles)) : [...DEFAULT_ASSIGNMENT_ROLES]
}

function normalizeSelectorValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeDecisionInput(
  input: AfterSalesRefundApprovalDecisionInput,
): AfterSalesRefundApprovalDecisionInput {
  return {
    approvalId: normalizeSelectorValue(input?.approvalId),
    businessKey: normalizeSelectorValue(input?.businessKey),
    ticketId: normalizeSelectorValue(input?.ticketId),
    projectId: normalizeSelectorValue(input?.projectId),
    action: input?.action,
    actorId: requiredString(input?.actorId, 'actorId'),
    actorName: normalizeSelectorValue(input?.actorName),
    comment: normalizeSelectorValue(input?.comment),
    ip: normalizeSelectorValue(input?.ip ?? undefined) || null,
    userAgent: normalizeSelectorValue(input?.userAgent ?? undefined) || null,
  }
}

function normalizeQueryInput(
  input: string | AfterSalesRefundApprovalQueryInput,
): AfterSalesRefundApprovalQueryInput {
  if (typeof input === 'string') {
    const value = input.trim()
    return value.length > 0 ? { ticketId: value } : {}
  }

  return {
    approvalId: normalizeSelectorValue(input?.approvalId),
    businessKey: normalizeSelectorValue(input?.businessKey),
    ticketId: normalizeSelectorValue(input?.ticketId),
    projectId: normalizeSelectorValue(input?.projectId),
  }
}

function buildRefundApprovalLookupQuery(
  input: string | AfterSalesRefundApprovalQueryInput,
): { sql: string; params: unknown[] } | null {
  if (typeof input === 'string') {
    const value = input.trim()
    if (!value) {
      return null
    }

    return {
      sql: `SELECT id
            FROM approval_instances
            WHERE workflow_key = $1
              AND (
                id = $2
                OR business_key = $2
                OR subject_snapshot->>'ticketId' = $2
                OR metadata->>'ticketId' = $2
              )
            ORDER BY created_at DESC
            LIMIT 1`,
      params: [REFUND_WORKFLOW_KEY, value],
    }
  }

  const query = normalizeQueryInput(input)

  if (query.approvalId) {
    return {
      sql: `SELECT id
            FROM approval_instances
            WHERE workflow_key = $1
              AND id = $2
            ORDER BY created_at DESC
            LIMIT 1`,
      params: [REFUND_WORKFLOW_KEY, query.approvalId],
    }
  }

  const conditions: string[] = []
  const params: unknown[] = [REFUND_WORKFLOW_KEY]
  let paramIndex = 2

  if (query.businessKey) {
    conditions.push(`business_key = $${paramIndex++}`)
    params.push(query.businessKey)
  }

  if (query.ticketId) {
    const ticketParam = `$${paramIndex++}`
    conditions.push(`(subject_snapshot->>'ticketId' = ${ticketParam} OR metadata->>'ticketId' = ${ticketParam})`)
    params.push(query.ticketId)
  }

  if (query.projectId) {
    conditions.push(`subject_snapshot->>'projectId' = $${paramIndex++}`)
    params.push(query.projectId)
  }

  if (conditions.length === 0) {
    return null
  }

  return {
    sql: `SELECT id
          FROM approval_instances
          WHERE workflow_key = $1
            AND ${conditions.join(' AND ')}
          ORDER BY created_at DESC
          LIMIT 1`,
    params,
  }
}

function normalizeCommand(input: AfterSalesRefundApprovalCommand): AfterSalesRefundApprovalCommand {
  const bridge = requiredString(input?.bridge, 'bridge')
  if (bridge !== REFUND_WORKFLOW_KEY) {
    throw new Error(`Unsupported bridge: ${bridge}`)
  }

  return {
    bridge,
    sourceSystem: 'after-sales',
    topic: requiredString(input?.topic, 'topic'),
    title: requiredString(input?.title, 'title'),
    businessKey: requiredString(input?.businessKey, 'businessKey'),
    requester: {
      id: requiredString(input?.requester?.id, 'requester.id'),
      name: typeof input?.requester?.name === 'string' && input.requester.name.trim()
        ? input.requester.name.trim()
        : undefined,
    },
    subject: {
      projectId: requiredString(input?.subject?.projectId, 'subject.projectId'),
      ticketId: requiredString(input?.subject?.ticketId, 'subject.ticketId'),
      ticketNo: requiredString(input?.subject?.ticketNo, 'subject.ticketNo'),
      title: requiredString(input?.subject?.title, 'subject.title'),
      refundAmount: requiredNumber(input?.subject?.refundAmount, 'subject.refundAmount'),
      currency: typeof input?.subject?.currency === 'string' && input.subject.currency.trim()
        ? input.subject.currency.trim()
        : 'CNY',
    },
    policy: input?.policy && typeof input.policy === 'object' ? input.policy : {},
    metadata: input?.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    assignmentRoles: normalizeAssignmentRoles(input?.assignmentRoles),
  }
}

export class AfterSalesApprovalBridgeService {
  constructor(
    private readonly db: TransactionPool | null = pool as unknown as TransactionPool | null,
    private readonly approvalBridge: ApprovalBridgeService = new ApprovalBridgeService(null),
    private readonly callbacks: AfterSalesRefundApprovalCallbacks = {},
  ) {}

  /**
   * Internal no-viewer load of the full DTO, then project to the narrow plugin summary.
   * Always passes AFTER_SALES_NO_VIEWER explicitly (never omit viewerUserId).
   */
  private async loadApprovalSummaryForPlugin(
    approvalId: string,
  ): Promise<AfterSalesApprovalSummary | null> {
    // Explicit null: internal plugin path has no authenticated viewer and must not invent one.
    const full = await this.approvalBridge.getApproval(approvalId, AFTER_SALES_NO_VIEWER)
    if (!full) return null
    return toAfterSalesApprovalSummary(full)
  }

  async getRefundApproval(
    input: string | AfterSalesRefundApprovalQueryInput,
  ): Promise<AfterSalesApprovalSummary | null> {
    const approvalId = await this.lookupRefundApprovalId(input)
    if (!approvalId) {
      return null
    }

    return this.loadApprovalSummaryForPlugin(approvalId)
  }

  private async lookupRefundApprovalId(
    input: string | AfterSalesRefundApprovalQueryInput,
  ): Promise<string | null> {
    if (!this.db) {
      throw new Error('Database not available')
    }

    const lookup = buildRefundApprovalLookupQuery(input)
    if (!lookup) {
      return null
    }

    const result = await this.db.query<{ id: string }>(lookup.sql, lookup.params)
    return result.rows[0]?.id ?? null
  }

  async submitRefundApprovalDecision(
    rawInput: AfterSalesRefundApprovalDecisionInput,
  ): Promise<AfterSalesRefundApprovalDecisionResult> {
    if (!this.db) {
      throw new Error('Database not available')
    }

    const input = normalizeDecisionInput(rawInput)
    if (input.action !== 'approve' && input.action !== 'reject') {
      throw new Error(`Unsupported action: ${String(input.action)}`)
    }

    const approvalId = await this.lookupRefundApprovalId(input)
    if (!approvalId) {
      throw new Error('Refund approval not found')
    }

    // dispatchAction returns the full HTTP UnifiedApprovalDTO (unchanged for normal action
    // responses). Plugin/callback paths only receive the narrow summary projection.
    const updatedApproval = await this.approvalBridge.dispatchAction(
      approvalId,
      {
        action: input.action,
        comment: input.comment,
      } as ApprovalActionRequest,
      {
        userId: input.actorId,
        userName: input.actorName,
        ip: input.ip,
        userAgent: input.userAgent,
      },
    )
    const summary = toAfterSalesApprovalSummary(updatedApproval)

    if (this.callbacks.onDecision) {
      await this.callbacks.onDecision(summary, input)
    }

    const callback = summary.status === 'approved'
      ? this.callbacks.onApproved
      : this.callbacks.onRejected
    if (callback) {
      await callback(summary, input)
    }

    return {
      approvalId: summary.id,
      approval: summary,
      decision: summary.status === 'approved' ? 'approved' : 'rejected',
    }
  }

  async submitRefundApproval(
    rawCommand: AfterSalesRefundApprovalCommand,
  ): Promise<AfterSalesRefundApprovalSubmitResult> {
    if (!this.db) {
      throw new Error('Database not available')
    }

    const command = normalizeCommand(rawCommand)
    const existing = await this.db.query<{ id: string }>(
      `SELECT id
       FROM approval_instances
       WHERE workflow_key = $1
         AND business_key = $2
         AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 1`,
      [REFUND_WORKFLOW_KEY, command.businessKey],
    )
    const existingId = existing.rows[0]?.id
    if (existingId) {
      const approval = await this.loadApprovalSummaryForPlugin(existingId)
      if (!approval) {
        throw new Error('Existing refund approval could not be loaded')
      }
      return {
        created: false,
        approvalId: existingId,
        approval,
      }
    }

    const approvalId = `afs:${randomUUID()}`

    await this.runInTransaction(async (trx) => {
      await trx.query(
        `INSERT INTO approval_instances
         (id, status, version, source_system, external_approval_id, workflow_key, business_key, title,
          requester_snapshot, subject_snapshot, policy_snapshot, metadata,
          current_step, total_steps, source_updated_at, last_synced_at, sync_status, sync_error, created_at, updated_at)
         VALUES ($1, 'pending', 0, $2, NULL, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, 1, $10, NULL, now(), 'ok', NULL, now(), now())`,
        [
          approvalId,
          command.sourceSystem,
          REFUND_WORKFLOW_KEY,
          command.businessKey,
          command.title,
          JSON.stringify(command.requester),
          JSON.stringify(command.subject),
          JSON.stringify(command.policy || {}),
          JSON.stringify({
            ...command.metadata,
            bridge: command.bridge,
            topic: command.topic,
          }),
          command.assignmentRoles?.length || DEFAULT_ASSIGNMENT_ROLES.length,
        ],
      )

      for (const [index, role] of (command.assignmentRoles || DEFAULT_ASSIGNMENT_ROLES).entries()) {
        const metadata = JSON.stringify({
          sourceSystem: command.sourceSystem,
          workflowKey: REFUND_WORKFLOW_KEY,
        })
        const nodeKey = `refund:${index + 1}:${role}`

        const updated = await trx.query(
          `UPDATE approval_assignments
           SET source_step = $3,
               node_key = $4,
               is_active = TRUE,
               metadata = $5::jsonb,
               updated_at = now()
           WHERE instance_id = $1
             AND assignment_type = 'role'
             AND assignee_id = $2
             AND is_active = TRUE`,
          [
            approvalId,
            role,
            index + 1,
            nodeKey,
            metadata,
          ],
        )

        if ((updated.rowCount ?? 0) > 0) continue

        await trx.query(
          `INSERT INTO approval_assignments
           (instance_id, assignment_type, assignee_id, source_step, node_key, is_active, metadata)
           VALUES ($1, 'role', $2, $3, $4, TRUE, $5::jsonb)`,
          [approvalId, role, index + 1, nodeKey, metadata],
        )
      }
    })

    const approval = await this.loadApprovalSummaryForPlugin(approvalId)
    if (!approval) {
      logger.error(`Created refund approval ${approvalId} but failed to load it back`)
      throw new Error('Approval created but could not be loaded')
    }

    return {
      created: true,
      approvalId,
      approval,
    }
  }

  private async runInTransaction<T>(callback: (trx: TransactionClient) => Promise<T>): Promise<T> {
    const client = await this.db!.connect()
    try {
      await client.query('BEGIN')
      const result = await callback(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}
