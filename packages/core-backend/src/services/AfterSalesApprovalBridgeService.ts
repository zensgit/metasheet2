import { randomUUID } from 'crypto'

import { Logger } from '../core/logger'
import { pool } from '../db/pg'
import { ApprovalBridgeService } from './ApprovalBridgeService'

const logger = new Logger('AfterSalesApprovalBridgeService')
export const REFUND_WORKFLOW_KEY = 'after-sales-refund'
const DEFAULT_ASSIGNMENT_ROLES = ['finance', 'supervisor'] as const

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

export interface AfterSalesRefundApprovalSubmitResult {
  created: boolean
  approvalId: string
  approval: Awaited<ReturnType<ApprovalBridgeService['getApproval']>>
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
  ) {}

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
      const approval = await this.approvalBridge.getApproval(existingId)
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
        await trx.query(
          `INSERT INTO approval_assignments
           (instance_id, assignment_type, assignee_id, source_step, is_active, metadata)
           VALUES ($1, 'role', $2, $3, TRUE, $4::jsonb)
           ON CONFLICT (instance_id, assignment_type, assignee_id, source_step)
           DO UPDATE SET is_active = TRUE, metadata = EXCLUDED.metadata, updated_at = now()`,
          [
            approvalId,
            role,
            index + 1,
            JSON.stringify({
              sourceSystem: command.sourceSystem,
              workflowKey: REFUND_WORKFLOW_KEY,
            }),
          ],
        )
      }
    })

    const approval = await this.approvalBridge.getApproval(approvalId)
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
