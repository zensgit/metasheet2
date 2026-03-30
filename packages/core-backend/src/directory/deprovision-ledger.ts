import { query } from '../db/pg'
import { isDatabaseSchemaError } from '../utils/database-errors'

export type DeprovisionStatus = 'executed' | 'rolled-back'

export type DeprovisionRecord = {
  id: string
  targetUserId: string
  performedBy: string
  reason: string | null
  userSnapshot: Record<string, unknown>
  status: DeprovisionStatus
  rolledBackBy: string | null
  rolledBackAt: string | null
  createdAt: string
  updatedAt: string
}

type DeprovisionRow = {
  id: string
  target_user_id: string
  performed_by: string
  reason: string | null
  user_snapshot: Record<string, unknown>
  status: DeprovisionStatus
  rolled_back_by: string | null
  rolled_back_at: string | null
  created_at: string
  updated_at: string
}

function mapRow(row: DeprovisionRow): DeprovisionRecord {
  return {
    id: row.id,
    targetUserId: row.target_user_id,
    performedBy: row.performed_by,
    reason: row.reason,
    userSnapshot: row.user_snapshot ?? {},
    status: row.status,
    rolledBackBy: row.rolled_back_by,
    rolledBackAt: row.rolled_back_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function recordDeprovision(options: {
  userId: string
  targetUserId: string
  reason: string
  snapshot: Record<string, unknown>
}): Promise<DeprovisionRecord | null> {
  try {
    const result = await query<DeprovisionRow>(
      `INSERT INTO deprovision_ledger (target_user_id, performed_by, reason, user_snapshot, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, 'executed', NOW(), NOW())
       RETURNING id, target_user_id, performed_by, reason, user_snapshot, status, rolled_back_by, rolled_back_at, created_at, updated_at`,
      [options.targetUserId, options.userId, options.reason, JSON.stringify(options.snapshot)],
    )
    const row = result.rows[0]
    return row ? mapRow(row) : null
  } catch (error) {
    if (isDatabaseSchemaError(error)) {
      return null
    }
    throw error
  }
}

export async function listDeprovisions(options: {
  page: number
  pageSize: number
  q?: string
}): Promise<{ items: DeprovisionRecord[]; total: number }> {
  const { page, pageSize, q } = options
  const offset = (page - 1) * pageSize

  try {
    const conditions: string[] = []
    const values: unknown[] = []
    let paramIndex = 1

    if (q && q.trim()) {
      conditions.push(`(dl.target_user_id::text ILIKE $${paramIndex} OR dl.reason ILIKE $${paramIndex} OR dl.performed_by::text ILIKE $${paramIndex})`)
      values.push(`%${q.trim()}%`)
      paramIndex++
    }

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const countResult = await query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM deprovision_ledger dl ${whereSql}`,
      values,
    )
    const total = countResult.rows[0]?.c ?? 0

    values.push(pageSize, offset)
    const result = await query<DeprovisionRow>(
      `SELECT id, target_user_id, performed_by, reason, user_snapshot, status, rolled_back_by, rolled_back_at, created_at, updated_at
       FROM deprovision_ledger dl
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      values,
    )

    return {
      items: result.rows.map(mapRow),
      total,
    }
  } catch (error) {
    if (isDatabaseSchemaError(error)) {
      return { items: [], total: 0 }
    }
    throw error
  }
}

export async function getDeprovision(id: string): Promise<DeprovisionRecord | null> {
  try {
    const result = await query<DeprovisionRow>(
      `SELECT id, target_user_id, performed_by, reason, user_snapshot, status, rolled_back_by, rolled_back_at, created_at, updated_at
       FROM deprovision_ledger
       WHERE id = $1`,
      [id],
    )
    const row = result.rows[0]
    return row ? mapRow(row) : null
  } catch (error) {
    if (isDatabaseSchemaError(error)) {
      return null
    }
    throw error
  }
}

export async function rollbackDeprovision(
  id: string,
  adminUserId: string,
): Promise<{ record: DeprovisionRecord | null; snapshot: Record<string, unknown> | null }> {
  try {
    const result = await query<DeprovisionRow>(
      `UPDATE deprovision_ledger
       SET status = 'rolled-back',
           rolled_back_by = $2,
           rolled_back_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
         AND status = 'executed'
       RETURNING id, target_user_id, performed_by, reason, user_snapshot, status, rolled_back_by, rolled_back_at, created_at, updated_at`,
      [id, adminUserId],
    )
    const row = result.rows[0]
    if (!row) {
      return { record: null, snapshot: null }
    }
    const record = mapRow(row)
    return { record, snapshot: record.userSnapshot }
  } catch (error) {
    if (isDatabaseSchemaError(error)) {
      return { record: null, snapshot: null }
    }
    throw error
  }
}
