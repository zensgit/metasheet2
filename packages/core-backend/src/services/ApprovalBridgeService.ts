/**
 * ApprovalBridgeService
 *
 * Phase 1 bridges PLM approvals into the unified approval backend while
 * keeping PLM as the source of truth.
 */

import { Logger } from '../core/logger'
import { pool } from '../db/pg'
import {
  createPlmApprovalInstanceId,
  toPlatformApprovalBridgeRecord,
  type PlmApprovalBridgeSource,
} from '../federation/plm-approval-bridge'
import type {
  ApprovalActionRequest,
  ApprovalAssignmentRow,
  ApprovalBridgePlmAdapter,
  ApprovalInstanceRow,
  ApprovalQueryOptions,
  PlmSyncOptions,
  UnifiedApprovalDTO,
  UnifiedApprovalHistoryDTO,
} from './approval-bridge-types'
import { APPROVAL_ERROR_CODES } from './approval-bridge-types'

const logger = new Logger('ApprovalBridgeService')
const PLM_SYNC_CONCURRENCY = 5
const PLM_SYNC_UPSTREAM_PAGE_SIZE = 50
const PLM_SYNC_MAX_WINDOW = 500

type ApprovalRecordRow = {
  id: string | number
  action: string
  actor_id: string | null
  actor_name: string | null
  comment: string | null
  from_status: string | null
  to_status: string
  metadata: Record<string, unknown> | null
  occurred_at: Date | string
}

type PlmApprovalFetch = {
  id: string
  title: string
  status: string
  request_type: string
  version?: number
  product_id?: string
  product_number?: string
  product_name?: string
  requester_id: string
  requester_name: string
  created_at: string
  updated_at?: string
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

function toOccurredAt(...values: Array<Date | string | null | undefined>): string | null {
  for (const value of values) {
    const iso = toIsoString(value)
    if (iso) return iso
  }
  return null
}

function isPlmId(id: string): boolean {
  return id.startsWith('plm:')
}

function extractExternalId(id: string): string {
  return id.replace(/^plm:/, '')
}

function normalizeSourceVersion(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10)
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed
    }
  }

  return null
}

function compareHistoryDescending(
  left: Pick<UnifiedApprovalHistoryDTO, 'occurredAt' | 'id'>,
  right: Pick<UnifiedApprovalHistoryDTO, 'occurredAt' | 'id'>,
): number {
  const leftRawTime = left.occurredAt ? new Date(left.occurredAt).getTime() : Number.NEGATIVE_INFINITY
  const rightRawTime = right.occurredAt ? new Date(right.occurredAt).getTime() : Number.NEGATIVE_INFINITY
  const leftTime = Number.isNaN(leftRawTime) ? Number.NEGATIVE_INFINITY : leftRawTime
  const rightTime = Number.isNaN(rightRawTime) ? Number.NEGATIVE_INFINITY : rightRawTime

  if (leftTime !== rightTime) {
    return rightTime - leftTime
  }

  return String(right.id).localeCompare(String(left.id))
}

function toUnifiedDTO(
  row: ApprovalInstanceRow,
  assignments: ApprovalAssignmentRow[] = [],
): UnifiedApprovalDTO {
  return {
    id: row.id,
    sourceSystem: row.source_system,
    externalApprovalId: row.external_approval_id,
    workflowKey: row.workflow_key,
    businessKey: row.business_key,
    title: row.title,
    status: row.status,
    requester: row.requester_snapshot || null,
    subject: row.subject_snapshot || null,
    policy: row.policy_snapshot || null,
    currentStep: row.current_step,
    totalSteps: row.total_steps,
    templateId: row.template_id,
    templateVersionId: row.template_version_id,
    publishedDefinitionId: row.published_definition_id,
    requestNo: row.request_no,
    formSnapshot: row.form_snapshot || null,
    currentNodeKey: row.current_node_key,
    assignments: assignments.map((assignment) => ({
      id: assignment.id,
      type: assignment.assignment_type,
      assigneeId: assignment.assignee_id,
      sourceStep: assignment.source_step,
      nodeKey: assignment.node_key,
      isActive: assignment.is_active,
      metadata: assignment.metadata || {},
    })),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function toBridgeSource(raw: {
  id: string
  title: string
  status: string
  request_type: string
  version?: number
  product_id?: string
  product_number?: string
  product_name?: string
  requester_id: string
  requester_name: string
  created_at: string
  updated_at?: string
}): PlmApprovalBridgeSource {
  return {
    id: raw.id,
    title: raw.title,
    status: raw.status,
    type: raw.request_type,
    product_id: raw.product_id,
    product_number: raw.product_number,
    product_name: raw.product_name,
    requester_id: raw.requester_id,
    requester_name: raw.requester_name,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    version: raw.version,
  }
}

export class ApprovalBridgeService {
  constructor(private readonly plmAdapter: ApprovalBridgePlmAdapter | null = null) {}

  hasPlmAdapter(): boolean {
    return this.plmAdapter !== null
  }

  async syncPlmApprovals(options?: PlmSyncOptions): Promise<{
    synced: number
    errors: Array<{ externalId: string; error: string }>
  }> {
    if (!pool) throw new Error('Database not available')

    const approvals = await this.fetchPlmApprovalWindow(options)

    let synced = 0
    const errors: Array<{ externalId: string; error: string }> = []

    const syncResults = await this.runInBatches(approvals, PLM_SYNC_CONCURRENCY, async (approval) => {
      await this.upsertPlmMirror(toBridgeSource(approval))
      return approval.id
    })

    syncResults.forEach((settledResult, index) => {
      if (settledResult.status === 'fulfilled') {
        synced += 1
      } else {
        const approval = approvals[index]
        errors.push({
          externalId: String(approval.id),
          error: settledResult.reason instanceof Error ? settledResult.reason.message : String(settledResult.reason),
        })
      }
    })

    return { synced, errors }
  }

  async listApprovals(options?: ApprovalQueryOptions): Promise<{
    data: UnifiedApprovalDTO[]
    total: number
  }> {
    if (!pool) throw new Error('Database not available')

    const conditions: string[] = []
    const params: unknown[] = []
    let paramIndex = 1

    if (options?.sourceSystem) {
      conditions.push(`source_system = $${paramIndex++}`)
      params.push(options.sourceSystem)
    }
    if (options?.status) {
      conditions.push(`status = $${paramIndex++}`)
      params.push(options.status)
    }
    if (options?.workflowKey) {
      conditions.push(`workflow_key = $${paramIndex++}`)
      params.push(options.workflowKey)
    }
    if (options?.businessKey) {
      conditions.push(`business_key = $${paramIndex++}`)
      params.push(options.businessKey)
    }
    if (options?.assignee) {
      conditions.push(
        `id IN (
          SELECT instance_id
          FROM approval_assignments
          WHERE assignee_id = $${paramIndex++}
            AND is_active = TRUE
        )`,
      )
      params.push(options.assignee)
    }
    if (options?.search) {
      conditions.push(`(COALESCE(request_no, '') ILIKE $${paramIndex} OR COALESCE(title, '') ILIKE $${paramIndex})`)
      params.push(`%${options.search}%`)
      paramIndex += 1
    }
    if (options?.tab && options.actorId) {
      const actorRoles = options.actorRoles && options.actorRoles.length > 0 ? options.actorRoles : ['__none__']
      const actorIdParam = paramIndex++
      params.push(options.actorId)
      const actorRolesParam = paramIndex++
      params.push(actorRoles)
      conditions.push(`COALESCE(source_system, 'platform') = 'platform'`)

      if (options.tab === 'pending') {
        conditions.push(`status = 'pending'`)
        conditions.push(
          `id IN (
            SELECT instance_id
            FROM approval_assignments
            WHERE is_active = TRUE
              AND (
                (assignment_type = 'user' AND assignee_id = $${actorIdParam})
                OR (assignment_type = 'role' AND assignee_id = ANY($${actorRolesParam}))
              )
          )`,
        )
      } else if (options.tab === 'mine') {
        conditions.push(`requester_snapshot->>'id' = $${actorIdParam}`)
      } else if (options.tab === 'cc') {
        conditions.push(
          `id IN (
            SELECT instance_id
            FROM approval_records
            WHERE action = 'cc'
              AND (
                (metadata->>'targetType' = 'user' AND metadata->>'targetId' = $${actorIdParam})
                OR (metadata->>'targetType' = 'role' AND metadata->>'targetId' = ANY($${actorRolesParam}))
              )
          )`,
        )
      } else if (options.tab === 'completed') {
        conditions.push(`status <> 'pending'`)
        conditions.push(
          `(
            requester_snapshot->>'id' = $${actorIdParam}
            OR id IN (
              SELECT instance_id FROM approval_records WHERE actor_id = $${actorIdParam}
            )
            OR id IN (
              SELECT instance_id
              FROM approval_records
              WHERE action = 'cc'
                AND (
                  (metadata->>'targetType' = 'user' AND metadata->>'targetId' = $${actorIdParam})
                  OR (metadata->>'targetType' = 'role' AND metadata->>'targetId' = ANY($${actorRolesParam}))
                )
            )
            OR id IN (
              SELECT instance_id
              FROM approval_assignments
              WHERE (assignment_type = 'user' AND assignee_id = $${actorIdParam})
                 OR (assignment_type = 'role' AND assignee_id = ANY($${actorRolesParam}))
            )
          )`,
        )
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = options?.limit ?? 50
    const offset = options?.offset ?? 0

    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM approval_instances ${whereClause}`,
      params,
    )
    const total = parseInt(countResult.rows[0]?.count || '0', 10)

    const instancesResult = await pool.query<ApprovalInstanceRow>(
      `SELECT * FROM approval_instances ${whereClause}
       ORDER BY COALESCE(source_updated_at, updated_at) DESC, updated_at DESC, id DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset],
    )

    const assignmentsByInstance = await this.loadAssignments(instancesResult.rows.map((row) => row.id))

    return {
      data: instancesResult.rows.map((row) => toUnifiedDTO(row, assignmentsByInstance.get(row.id) || [])),
      total,
    }
  }

  async getApproval(id: string): Promise<UnifiedApprovalDTO | null> {
    if (!pool) throw new Error('Database not available')

    if (isPlmId(id)) {
      try {
        await this.refreshPlmInstance(id)
      } catch (error) {
        logger.warn(
          `PLM approval refresh failed for ${id}: ${error instanceof Error ? error.message : String(error)}`,
        )
        await this.markSyncError(id, error)
      }
    }

    const row = await this.loadApprovalInstance(id)
    if (!row) return null

    const assignmentsByInstance = await this.loadAssignments([id])
    return toUnifiedDTO(row, assignmentsByInstance.get(id) || [])
  }

  async getApprovalHistory(id: string): Promise<UnifiedApprovalHistoryDTO[]> {
    if (isPlmId(id)) {
      return this.getPlmHistory(id)
    }

    return this.loadLocalHistory(id)
  }

  async dispatchAction(
    id: string,
    request: ApprovalActionRequest,
    actor: { userId: string; userName?: string; ip?: string | null; userAgent?: string | null },
  ): Promise<UnifiedApprovalDTO> {
    if (!pool) throw new Error('Database not available')

    if (isPlmId(id)) {
      try {
        await this.refreshPlmInstance(id)
      } catch (error) {
        logger.warn(
          `PLM approval refresh before action failed for ${id}: ${error instanceof Error ? error.message : String(error)}`,
        )
        await this.markSyncError(id, error)
      }
    }
    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      const lockedResult = await client.query<ApprovalInstanceRow>(
        `SELECT * FROM approval_instances
         WHERE id = $1
         FOR UPDATE`,
        [id],
      )
      const instance = lockedResult.rows[0]
      if (!instance) {
        throw new ServiceError('Approval not found', 404, APPROVAL_ERROR_CODES.APPROVAL_NOT_FOUND)
      }

      if (instance.status !== 'pending') {
        throw new ServiceError(
          `Cannot ${request.action}: current status is ${instance.status}`,
          409,
          APPROVAL_ERROR_CODES.INVALID_STATUS_TRANSITION,
        )
      }

      const rejectCommentRequired = instance.policy_snapshot?.rejectCommentRequired !== false
      if (request.action === 'reject' && rejectCommentRequired && !request.comment?.trim()) {
        throw new ServiceError(
          'Rejection comment is required',
          400,
          APPROVAL_ERROR_CODES.REJECT_COMMENT_REQUIRED,
        )
      }

      if (instance.source_system === 'plm') {
        await this.dispatchPlmAction(id, this.resolvePlmSourceVersion(instance), request)
      }

      const nextStatus = request.action === 'approve' ? 'approved' : 'rejected'
      const nextVersion = instance.version + 1

      const updateResult = await client.query(
        `UPDATE approval_instances
         SET status = $1,
             version = $2,
             sync_status = 'ok',
             sync_error = NULL,
             last_synced_at = now(),
             updated_at = now()
         WHERE id = $3
           AND version = $4
           AND status = $5`,
        [nextStatus, nextVersion, id, instance.version, instance.status],
      )

      if (updateResult.rowCount !== 1) {
        const latest = await this.loadApprovalInstance(id)
        throw new ServiceError(
          latest
            ? `Cannot ${request.action}: current status is ${latest.status}`
            : 'Approval changed during processing',
          409,
          APPROVAL_ERROR_CODES.INVALID_STATUS_TRANSITION,
          latest
            ? {
                currentVersion: latest.version,
                currentStatus: latest.status,
              }
            : undefined,
        )
      }

      await client.query(
        `UPDATE approval_assignments
         SET is_active = FALSE,
             updated_at = now()
         WHERE instance_id = $1 AND is_active = TRUE`,
        [id],
      )

      await client.query(
        `INSERT INTO approval_records
         (instance_id, action, actor_id, actor_name, comment, from_status, to_status, from_version, to_version, metadata, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          id,
          request.action,
          actor.userId,
          actor.userName || null,
          request.comment || null,
          instance.status,
          nextStatus,
          instance.version,
          nextVersion,
          JSON.stringify({ sourceSystem: instance.source_system }),
          actor.ip || null,
          actor.userAgent || null,
        ],
      )

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    const updated = await this.getApproval(id)
    if (!updated) {
      throw new ServiceError('Approval not found after action', 404, APPROVAL_ERROR_CODES.APPROVAL_NOT_FOUND)
    }
    return updated
  }

  private async fetchPlmApprovalWindow(options?: PlmSyncOptions): Promise<PlmApprovalFetch[]> {
    const plmAdapter = this.requirePlmAdapter()
    const requestedCount = Math.max(0, options?.limit ?? 50)
    if (requestedCount === 0) {
      return []
    }

    const requestedWindow = Math.min(
      PLM_SYNC_MAX_WINDOW,
      Math.max(0, options?.offset ?? 0) + requestedCount,
    )
    const approvals: PlmApprovalFetch[] = []
    let totalCount: number | null = null

    for (let pageOffset = 0; pageOffset < requestedWindow; pageOffset += PLM_SYNC_UPSTREAM_PAGE_SIZE) {
      const result = await plmAdapter.getApprovals({
        status: options?.status,
        productId: options?.productId,
        requesterId: options?.requesterId,
        limit: PLM_SYNC_UPSTREAM_PAGE_SIZE,
        offset: pageOffset,
      })

      if (result.error) {
        throw new ServiceError(
          'Failed to fetch PLM approvals',
          502,
          APPROVAL_ERROR_CODES.SOURCE_ACTION_FAILED,
          { upstream: String(result.error) },
        )
      }

      if (typeof result.metadata?.totalCount === 'number') {
        totalCount = result.metadata.totalCount
      }
      approvals.push(...result.data)

      if (result.data.length < PLM_SYNC_UPSTREAM_PAGE_SIZE) {
        break
      }

      if (totalCount !== null && pageOffset + result.data.length >= totalCount) {
        break
      }
    }

    return approvals.slice(0, requestedWindow)
  }

  private requirePlmAdapter(): ApprovalBridgePlmAdapter {
    if (!this.plmAdapter) {
      throw new ServiceError(
        'PLM approval bridge is not configured',
        503,
        'PLM_APPROVAL_BRIDGE_UNAVAILABLE',
      )
    }

    return this.plmAdapter
  }

  private async runInBatches<TItem, TResult>(
    items: TItem[],
    batchSize: number,
    task: (item: TItem) => Promise<TResult>,
  ): Promise<Array<PromiseSettledResult<TResult>>> {
    const results: Array<PromiseSettledResult<TResult>> = []

    for (let index = 0; index < items.length; index += batchSize) {
      const batch = items.slice(index, index + batchSize)
      results.push(...(await Promise.allSettled(batch.map(task))))
    }

    return results
  }

  private async loadApprovalInstance(id: string): Promise<ApprovalInstanceRow | null> {
    if (!pool) throw new Error('Database not available')

    const result = await pool.query<ApprovalInstanceRow>(
      'SELECT * FROM approval_instances WHERE id = $1',
      [id],
    )

    return result.rows[0] || null
  }

  private async loadAssignments(instanceIds: string[]): Promise<Map<string, ApprovalAssignmentRow[]>> {
    const assignmentsByInstance = new Map<string, ApprovalAssignmentRow[]>()

    if (!pool || instanceIds.length === 0) {
      return assignmentsByInstance
    }

    const result = await pool.query<ApprovalAssignmentRow>(
      `SELECT * FROM approval_assignments
       WHERE instance_id = ANY($1)
       ORDER BY created_at ASC`,
      [instanceIds],
    )

    for (const row of result.rows) {
      const existing = assignmentsByInstance.get(row.instance_id) || []
      existing.push(row)
      assignmentsByInstance.set(row.instance_id, existing)
    }

    return assignmentsByInstance
  }

  private async loadLocalHistory(id: string): Promise<UnifiedApprovalHistoryDTO[]> {
    if (!pool) {
      return []
    }

    const result = await pool.query<ApprovalRecordRow>(
      `SELECT id, action, actor_id, actor_name, comment, from_status, to_status, metadata, occurred_at
       FROM approval_records
       WHERE instance_id = $1
       ORDER BY occurred_at DESC`,
      [id],
    )

    return result.rows.map((row) => ({
      id: String(row.id),
      action: row.action,
      actorId: row.actor_id,
      actorName: row.actor_name,
      comment: row.comment,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      occurredAt: toOccurredAt(row.occurred_at),
      metadata: row.metadata || {},
    }))
  }

  private resolvePlmSourceVersion(instance: ApprovalInstanceRow): number {
    const sourceVersion =
      normalizeSourceVersion(instance.metadata?.source_version) ??
      normalizeSourceVersion(instance.metadata?.sourceVersion)

    if (sourceVersion !== null) {
      return sourceVersion
    }

    throw new ServiceError(
      'PLM source version is unavailable',
      502,
      APPROVAL_ERROR_CODES.SOURCE_ACTION_FAILED,
      { approvalId: instance.id },
    )
  }

  private async upsertPlmMirror(source: PlmApprovalBridgeSource): Promise<void> {
    if (!pool) throw new Error('Database not available')

    const bridge = toPlatformApprovalBridgeRecord(source)
    const instanceId = createPlmApprovalInstanceId(bridge.externalApprovalId)
    const sourceUpdatedAt = source.updated_at || source.created_at || null

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      await client.query(
        `INSERT INTO approval_instances
         (id, status, version, source_system, external_approval_id, workflow_key, business_key, title,
          requester_snapshot, subject_snapshot, policy_snapshot, metadata,
          current_step, total_steps, source_updated_at, last_synced_at, sync_status, sync_error, created_at, updated_at)
         VALUES ($1, $2, 0, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, 0, $12, now(), 'ok', NULL, now(), now())
         ON CONFLICT (source_system, external_approval_id) WHERE external_approval_id IS NOT NULL
         DO UPDATE SET
           status = EXCLUDED.status,
           workflow_key = EXCLUDED.workflow_key,
           business_key = EXCLUDED.business_key,
           title = EXCLUDED.title,
           requester_snapshot = EXCLUDED.requester_snapshot,
           subject_snapshot = EXCLUDED.subject_snapshot,
           policy_snapshot = EXCLUDED.policy_snapshot,
           metadata = EXCLUDED.metadata,
           source_updated_at = EXCLUDED.source_updated_at,
           last_synced_at = now(),
           sync_status = 'ok',
           sync_error = NULL,
           updated_at = now()`,
        [
          instanceId,
          bridge.status,
          bridge.externalSystem,
          bridge.externalApprovalId,
          bridge.workflowKey,
          bridge.businessKey,
          bridge.title,
          JSON.stringify(bridge.requester),
          JSON.stringify(bridge.subject),
          JSON.stringify(bridge.policy),
          JSON.stringify(bridge.metadata),
          sourceUpdatedAt,
        ],
      )

      await client.query(
        `INSERT INTO approval_assignments
         (instance_id, assignment_type, assignee_id, source_step, is_active, metadata)
         VALUES ($1, 'source_queue', 'plm:source-owned', 0, $2, $3)
         ON CONFLICT (instance_id, assignment_type, assignee_id, source_step)
         DO UPDATE SET is_active = EXCLUDED.is_active, metadata = EXCLUDED.metadata, updated_at = now()`,
        [
          instanceId,
          bridge.status === 'pending',
          JSON.stringify({ sourceSystem: 'plm' }),
        ],
      )

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      await this.markSyncError(instanceId, error)
      throw error
    } finally {
      client.release()
    }
  }

  private async refreshPlmInstance(id: string): Promise<void> {
    const externalApprovalId = extractExternalId(id)
    const result = await this.requirePlmAdapter().getApprovalById(externalApprovalId)

    if (result.error) {
      throw new ServiceError(
        'Failed to refresh PLM approval',
        502,
        APPROVAL_ERROR_CODES.SOURCE_ACTION_FAILED,
        { upstream: String(result.error) },
      )
    }

    const approval = result.data[0]
    if (!approval) {
      return
    }

    await this.upsertPlmMirror(toBridgeSource(approval))
  }

  private async getPlmHistory(id: string): Promise<UnifiedApprovalHistoryDTO[]> {
    const result = await this.requirePlmAdapter().getApprovalHistory(extractExternalId(id))

    if (result.error) {
      throw new ServiceError(
        'Failed to fetch PLM approval history',
        502,
        APPROVAL_ERROR_CODES.SOURCE_ACTION_FAILED,
        { upstream: String(result.error) },
      )
    }

    const sourceHistory = result.data.map((entry) => ({
      id: String(entry.id),
      action: entry.status === 'approved'
        ? 'approve'
        : entry.status === 'rejected'
          ? 'reject'
          : String(entry.status || 'unknown'),
      actorId: entry.user_id == null ? null : String(entry.user_id),
      actorName: null,
      comment: entry.comment || null,
      fromStatus: null,
      toStatus: entry.status || 'unknown',
      occurredAt: toOccurredAt(entry.approved_at, entry.created_at),
      metadata: {
        ecoId: entry.eco_id,
        stageId: entry.stage_id,
        approvalType: entry.approval_type,
        requiredRole: entry.required_role,
      },
    }))

    const localHistory = await this.loadLocalHistory(id)

    return [...sourceHistory, ...localHistory].sort(compareHistoryDescending)
  }

  private async dispatchPlmAction(id: string, version: number, request: ApprovalActionRequest): Promise<void> {
    const externalApprovalId = extractExternalId(id)
    const result = request.action === 'approve'
      ? await this.requirePlmAdapter().approveApproval(externalApprovalId, version, request.comment)
      : await this.requirePlmAdapter().rejectApproval(externalApprovalId, version, request.comment || '')

    if (result.error) {
      throw new ServiceError(
        `PLM ${request.action} failed`,
        502,
        APPROVAL_ERROR_CODES.SOURCE_ACTION_FAILED,
        { upstream: String(result.error) },
      )
    }
  }

  private async markSyncError(id: string, error: unknown): Promise<void> {
    if (!pool) return

    await pool.query(
      `UPDATE approval_instances
       SET sync_status = 'error',
           sync_error = $1,
           last_synced_at = now(),
           updated_at = now()
       WHERE id = $2`,
      [error instanceof Error ? error.message : String(error), id],
    )
  }
}

export class ServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ServiceError'
  }
}
