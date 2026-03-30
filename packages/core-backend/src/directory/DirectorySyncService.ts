import { query } from '../db/pg'
import { isDatabaseSchemaError } from '../utils/database-errors'

export type SyncStatus = 'idle' | 'running' | 'failed' | 'completed'

export type DirectorySyncStatusRecord = {
  lastSyncAt: string | null
  nextSyncAt: string | null
  status: SyncStatus
  hasAlert: boolean
  alertMessage: string | null
  alertAcknowledgedAt: string | null
  alertAcknowledgedBy: string | null
}

export type SyncHistoryRecord = {
  id: string
  status: SyncStatus
  message: string | null
  syncedCount: number
  failedCount: number
  createdAt: string
}

type SyncStatusRow = {
  last_sync_at: string | null
  next_sync_at: string | null
  status: SyncStatus
  has_alert: boolean
  alert_message: string | null
  alert_acknowledged_at: string | null
  alert_acknowledged_by: string | null
}

type SyncHistoryRow = {
  id: string
  status: SyncStatus
  message: string | null
  synced_count: number
  failed_count: number
  created_at: string
}

const DEFAULT_SYNC_STATUS: DirectorySyncStatusRecord = {
  lastSyncAt: null,
  nextSyncAt: null,
  status: 'idle',
  hasAlert: false,
  alertMessage: null,
  alertAcknowledgedAt: null,
  alertAcknowledgedBy: null,
}

function mapStatusRow(row: SyncStatusRow): DirectorySyncStatusRecord {
  return {
    lastSyncAt: row.last_sync_at,
    nextSyncAt: row.next_sync_at,
    status: row.status,
    hasAlert: Boolean(row.has_alert),
    alertMessage: row.alert_message,
    alertAcknowledgedAt: row.alert_acknowledged_at,
    alertAcknowledgedBy: row.alert_acknowledged_by,
  }
}

function mapHistoryRow(row: SyncHistoryRow): SyncHistoryRecord {
  return {
    id: row.id,
    status: row.status,
    message: row.message,
    syncedCount: Number(row.synced_count || 0),
    failedCount: Number(row.failed_count || 0),
    createdAt: row.created_at,
  }
}

export async function getDirectorySyncStatus(): Promise<DirectorySyncStatusRecord> {
  try {
    const result = await query<SyncStatusRow>(
      `SELECT last_sync_at, next_sync_at, status, has_alert, alert_message, alert_acknowledged_at, alert_acknowledged_by
       FROM directory_sync_status
       ORDER BY last_sync_at DESC NULLS LAST
       LIMIT 1`,
    )
    const row = result.rows[0]
    return row ? mapStatusRow(row) : { ...DEFAULT_SYNC_STATUS }
  } catch (error) {
    if (isDatabaseSchemaError(error)) {
      return { ...DEFAULT_SYNC_STATUS }
    }
    throw error
  }
}

export async function acknowledgeAlert(userId: string): Promise<DirectorySyncStatusRecord> {
  try {
    const result = await query<SyncStatusRow>(
      `UPDATE directory_sync_status
       SET has_alert = false,
           alert_acknowledged_at = NOW(),
           alert_acknowledged_by = $1
       WHERE has_alert = true
       RETURNING last_sync_at, next_sync_at, status, has_alert, alert_message, alert_acknowledged_at, alert_acknowledged_by`,
      [userId],
    )
    const row = result.rows[0]
    return row ? mapStatusRow(row) : { ...DEFAULT_SYNC_STATUS }
  } catch (error) {
    if (isDatabaseSchemaError(error)) {
      return { ...DEFAULT_SYNC_STATUS }
    }
    throw error
  }
}

export async function recordSyncRun(result: {
  status: SyncStatus
  message?: string
  syncedCount?: number
  failedCount?: number
}): Promise<void> {
  const hasAlert = result.status === 'failed'
  const alertMessage = hasAlert ? (result.message ?? 'Sync failed') : null

  try {
    await query(
      `INSERT INTO directory_sync_history (status, message, synced_count, failed_count, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [result.status, result.message ?? null, result.syncedCount ?? 0, result.failedCount ?? 0],
    )

    await query(
      `UPDATE directory_sync_status
       SET last_sync_at = NOW(),
           status = $1,
           has_alert = $2,
           alert_message = $3,
           alert_acknowledged_at = CASE WHEN $2 THEN NULL ELSE alert_acknowledged_at END,
           alert_acknowledged_by = CASE WHEN $2 THEN NULL ELSE alert_acknowledged_by END`,
      [result.status, hasAlert, alertMessage],
    )
  } catch (error) {
    if (isDatabaseSchemaError(error)) {
      return
    }
    throw error
  }
}

export async function getDirectorySyncHistory(options: {
  page: number
  pageSize: number
}): Promise<{ items: SyncHistoryRecord[]; total: number }> {
  const { page, pageSize } = options
  const offset = (page - 1) * pageSize

  try {
    const countResult = await query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM directory_sync_history`,
    )
    const total = countResult.rows[0]?.c ?? 0

    const result = await query<SyncHistoryRow>(
      `SELECT id, status, message, synced_count, failed_count, created_at
       FROM directory_sync_history
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [pageSize, offset],
    )

    return {
      items: result.rows.map(mapHistoryRow),
      total,
    }
  } catch (error) {
    if (isDatabaseSchemaError(error)) {
      return { items: [], total: 0 }
    }
    throw error
  }
}
