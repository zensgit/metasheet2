/**
 * Race-safe org quota reservation for elearning media.
 * Transaction + pg_advisory_xact_lock; counts uploading|probing|ready only.
 */
export interface ElearningMediaQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningMediaDb extends ElearningMediaQueryable {
  transaction<T>(handler: (tx: ElearningMediaQueryable) => Promise<T>): Promise<T>
}

export const ELEARNING_MEDIA_ACTIVE_STATUSES = ['uploading', 'probing', 'ready'] as const

export type ElearningMediaStatus = 'uploading' | 'probing' | 'ready' | 'rejected'

export class ElearningMediaQuotaError extends Error {
  readonly code = 'org_quota_exceeded' as const
  constructor() {
    super('org_quota_exceeded')
    this.name = 'ElearningMediaQuotaError'
  }
}

export interface ElearningMediaInsertRow {
  id: string
  orgId: string
  storageKey: string
  mimeType: string
  magicMimeType: string
  sizeBytes: number
  sha256: string
  createdBy: string
}

export function elearningMediaQuotaLockKey(orgId: string): string {
  return `elearning-media-quota:${orgId}`
}

function asUsedBytes(raw: unknown): bigint {
  if (typeof raw === 'bigint') {
    if (raw < 0n) throw new Error('elearning_media_quota_sum_unavailable')
    return raw
  }
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw < 0) {
      throw new Error('elearning_media_quota_sum_unavailable')
    }
    return BigInt(raw)
  }
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (/^\d+$/.test(text)) return BigInt(text)
  }
  throw new Error('elearning_media_quota_sum_unavailable')
}

export async function reserveElearningMediaQuotaAndInsert(
  db: ElearningMediaDb,
  row: ElearningMediaInsertRow,
  orgQuotaBytes: number,
): Promise<void> {
  if (!Number.isSafeInteger(orgQuotaBytes) || orgQuotaBytes <= 0) {
    throw new RangeError('orgQuotaBytes must be a positive safe integer')
  }
  if (!Number.isSafeInteger(row.sizeBytes) || row.sizeBytes <= 0) {
    throw new RangeError('sizeBytes must be a positive safe integer')
  }
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [elearningMediaQuotaLockKey(row.orgId)])
    const usedRes = await tx.query(
      `SELECT COALESCE(SUM(size_bytes), 0)::text AS used
         FROM elearning_media
        WHERE org_id = $1
          AND status IN ('uploading', 'probing', 'ready')`,
      [row.orgId],
    )
    const used = asUsedBytes(usedRes.rows[0]?.used)
    if (used + BigInt(row.sizeBytes) > BigInt(orgQuotaBytes)) {
      throw new ElearningMediaQuotaError()
    }
    await tx.query(
      `INSERT INTO elearning_media (
         id, org_id, storage_key, mime_type, magic_mime_type, size_bytes, sha256, duration_ms, status, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 'uploading', $8)`,
      [
        row.id,
        row.orgId,
        row.storageKey,
        row.mimeType,
        row.magicMimeType,
        row.sizeBytes,
        row.sha256,
        row.createdBy,
      ],
    )
  })
}

export async function updateElearningMediaStatus(
  db: ElearningMediaQueryable,
  input: {
    orgId: string
    id: string
    fromStatus: ElearningMediaStatus
    toStatus: ElearningMediaStatus
    durationMs: number | null
  },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE elearning_media
        SET status = $1,
            duration_ms = $2,
            updated_at = now()
      WHERE org_id = $3
        AND id = $4
        AND status = $5`,
    [input.toStatus, input.durationMs, input.orgId, input.id, input.fromStatus],
  )
  return (result.rowCount ?? 0) > 0
}
