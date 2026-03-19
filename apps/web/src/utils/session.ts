export type UserSessionRecord = {
  id: string
  userId: string
  issuedAt: string
  expiresAt: string
  lastSeenAt: string
  revokedAt: string | null
  revokedBy: string | null
  revokeReason: string | null
  ipAddress: string | null
  userAgent: string | null
  createdAt: string
  updatedAt: string
}

function toSessionValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toTrimmedSessionValue(value: unknown): string {
  return toSessionValue(value).trim()
}

function toNullableSessionValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function parseUserSessionRecord(item: unknown): UserSessionRecord | null {
  if (!item || typeof item !== 'object') return null
  const record = item as Record<string, unknown>
  const id = toTrimmedSessionValue(record.id)
  if (!id) return null

  return {
    id,
    userId: toSessionValue(record.userId || record.user_id),
    issuedAt: toSessionValue(record.issuedAt || record.issued_at),
    expiresAt: toSessionValue(record.expiresAt || record.expires_at),
    lastSeenAt: toSessionValue(record.lastSeenAt || record.last_seen_at),
    revokedAt: toNullableSessionValue(record.revokedAt || record.revoked_at),
    revokedBy: toNullableSessionValue(record.revokedBy || record.revoked_by),
    revokeReason: toNullableSessionValue(record.revokeReason || record.revoke_reason),
    ipAddress: toNullableSessionValue(record.ipAddress || record.ip_address),
    userAgent: toNullableSessionValue(record.userAgent || record.user_agent),
    createdAt: toSessionValue(record.createdAt || record.created_at),
    updatedAt: toSessionValue(record.updatedAt || record.updated_at),
  }
}
