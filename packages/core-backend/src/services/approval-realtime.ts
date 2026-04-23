import type { Injector } from '@wendellhu/redi'
import { ICollabService, type ICollabService as CollabServicePort, type ILogger } from '../di/identifiers'
import { pool } from '../db/pg'
import { buildAuthenticatedUserRoom } from './CollabService'

export type ApprovalCountSourceSystem = 'all' | 'platform' | 'plm'

export interface ApprovalCounts {
  count: number
  unreadCount: number
}

export interface ApprovalCountsUpdatedPayload extends ApprovalCounts {
  sourceSystem: ApprovalCountSourceSystem
  countsBySourceSystem: Record<ApprovalCountSourceSystem, ApprovalCounts>
  reason: string
  updatedAt: string
}

export type ApprovalCountQuery = <T = { count: string; unread_count: string }>(
  sql: string,
  params: unknown[],
) => Promise<{ rows: T[] }>

export async function computeApprovalPendingCounts(
  query: ApprovalCountQuery,
  input: {
    userId: string
    roles?: string[]
    sourceSystem?: ApprovalCountSourceSystem
  },
): Promise<ApprovalCounts> {
  const sourceSystem = input.sourceSystem === 'platform' || input.sourceSystem === 'plm'
    ? input.sourceSystem
    : null
  const roles = input.roles?.filter((role) => role.trim().length > 0) ?? []
  const actorRolesParam = roles.length > 0 ? roles : ['__none__']
  const conditions = [
    `a.is_active = TRUE`,
    `i.status = 'pending'`,
    `(
      (a.assignment_type = 'user' AND a.assignee_id = $1)
      OR (a.assignment_type = 'role' AND a.assignee_id = ANY($2))
    )`,
  ]
  const params: unknown[] = [input.userId, actorRolesParam]

  if (sourceSystem) {
    conditions.push(`COALESCE(i.source_system, 'platform') = $${params.length + 1}`)
    params.push(sourceSystem)
  }

  const result = await query<{ count: string | number; unread_count: string | number }>(
    `SELECT COUNT(DISTINCT a.instance_id)::text AS count,
            COUNT(DISTINCT a.instance_id) FILTER (WHERE r.instance_id IS NULL)::text AS unread_count
     FROM approval_assignments a
     INNER JOIN approval_instances i ON i.id = a.instance_id
     LEFT JOIN approval_reads r ON r.instance_id = a.instance_id AND r.user_id = $1
     WHERE ${conditions.join(' AND ')}`,
    params,
  )

  return {
    count: Number.parseInt(String(result.rows[0]?.count ?? '0'), 10),
    unreadCount: Number.parseInt(String(result.rows[0]?.unread_count ?? '0'), 10),
  }
}

export async function buildApprovalCountsUpdatedPayload(
  input: {
    userId: string
    roles?: string[]
    reason: string
    query?: ApprovalCountQuery
  },
): Promise<ApprovalCountsUpdatedPayload | null> {
  const query = input.query ?? pool?.query.bind(pool)
  if (!query) return null

  const [all, platform, plm] = await Promise.all([
    computeApprovalPendingCounts(query, { userId: input.userId, roles: input.roles, sourceSystem: 'all' }),
    computeApprovalPendingCounts(query, { userId: input.userId, roles: input.roles, sourceSystem: 'platform' }),
    computeApprovalPendingCounts(query, { userId: input.userId, roles: input.roles, sourceSystem: 'plm' }),
  ])

  return {
    ...all,
    sourceSystem: 'all',
    countsBySourceSystem: { all, platform, plm },
    reason: input.reason,
    updatedAt: new Date().toISOString(),
  }
}

export async function publishApprovalCountsUpdate(
  input: {
    injector?: Injector
    collabService?: Pick<CollabServicePort, 'broadcastTo'>
    logger?: Pick<ILogger, 'warn'>
    userId: string
    roles?: string[]
    reason: string
    query?: ApprovalCountQuery
  },
): Promise<void> {
  try {
    const collabService = input.collabService ?? input.injector?.get(ICollabService)
    if (!collabService) return
    const payload = await buildApprovalCountsUpdatedPayload(input)
    if (!payload) return
    collabService.broadcastTo(buildAuthenticatedUserRoom(input.userId), 'approval:counts-updated', payload)
  } catch (error) {
    input.logger?.warn(
      'Failed to publish approval count update',
      error instanceof Error ? error : undefined,
    )
  }
}
