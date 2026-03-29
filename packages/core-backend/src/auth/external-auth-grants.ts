import { query } from '../db/pg'
import { isDatabaseSchemaError } from '../utils/database-errors'

export type ExternalAuthGrantProvider = 'dingtalk'

type ExternalAuthGrantRow = {
  id: string
  provider: string
  local_user_id: string
  enabled: boolean
  granted_by: string | null
  created_at: string | Date
  updated_at: string | Date
}

export type UserExternalAuthGrant = {
  id: string
  provider: ExternalAuthGrantProvider
  userId: string
  enabled: boolean
  grantedBy: string | null
  createdAt: string
  updatedAt: string
}

type UpsertUserExternalAuthGrantInput = {
  provider: ExternalAuthGrantProvider
  userId: string
  enabled: boolean
  grantedBy?: string | null
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function toIso(value: string | Date | null | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function mapRow(row: ExternalAuthGrantRow): UserExternalAuthGrant {
  return {
    id: row.id,
    provider: row.provider as ExternalAuthGrantProvider,
    userId: row.local_user_id,
    enabled: row.enabled === true,
    grantedBy: normalizeText(row.granted_by),
    createdAt: toIso(row.created_at) || new Date().toISOString(),
    updatedAt: toIso(row.updated_at) || new Date().toISOString(),
  }
}

export async function getUserExternalAuthGrant(
  userId: string,
  provider: ExternalAuthGrantProvider,
): Promise<UserExternalAuthGrant | null> {
  try {
    const result = await query<ExternalAuthGrantRow>(
      `SELECT id, provider, local_user_id, enabled, granted_by, created_at, updated_at
       FROM user_external_auth_grants
       WHERE local_user_id = $1 AND provider = $2
       LIMIT 1`,
      [userId, provider],
    )
    const row = result.rows[0]
    return row ? mapRow(row) : null
  } catch (error) {
    if (isDatabaseSchemaError(error)) return null
    throw error
  }
}

export async function isUserExternalAuthEnabled(
  userId: string,
  provider: ExternalAuthGrantProvider,
): Promise<boolean> {
  const grant = await getUserExternalAuthGrant(userId, provider)
  return grant?.enabled === true
}

export async function upsertUserExternalAuthGrant(
  input: UpsertUserExternalAuthGrantInput,
): Promise<UserExternalAuthGrant | null> {
  try {
    const result = await query<ExternalAuthGrantRow>(
      `INSERT INTO user_external_auth_grants (
         provider,
         local_user_id,
         enabled,
         granted_by,
         created_at,
         updated_at
       )
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (provider, local_user_id) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           granted_by = EXCLUDED.granted_by,
           updated_at = NOW()
       RETURNING id, provider, local_user_id, enabled, granted_by, created_at, updated_at`,
      [
        input.provider,
        input.userId,
        input.enabled,
        normalizeText(input.grantedBy),
      ],
    )
    const row = result.rows[0]
    return row ? mapRow(row) : null
  } catch (error) {
    if (isDatabaseSchemaError(error)) return null
    throw error
  }
}
