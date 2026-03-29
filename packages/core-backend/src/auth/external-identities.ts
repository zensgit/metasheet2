import { query } from '../db/pg'
import { isDatabaseSchemaError } from '../utils/database-errors'

export type ExternalIdentityProvider = 'dingtalk'

type ExternalIdentityRow = {
  id: string
  provider: string
  external_key: string
  provider_user_id: string | null
  provider_union_id: string | null
  provider_open_id: string | null
  corp_id: string | null
  local_user_id: string
  profile: Record<string, unknown> | string | null
  bound_by: string | null
  last_login_at: string | Date | null
  created_at: string | Date
  updated_at: string | Date
}

export type UserExternalIdentity = {
  id: string
  provider: string
  externalKey: string
  providerUserId: string | null
  providerUnionId: string | null
  providerOpenId: string | null
  corpId: string | null
  userId: string
  profile: Record<string, unknown>
  boundBy: string | null
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

export type UpsertExternalIdentityInput = {
  provider: ExternalIdentityProvider
  externalKey: string
  providerUserId?: string | null
  providerUnionId?: string | null
  providerOpenId?: string | null
  corpId?: string | null
  userId: string
  profile?: Record<string, unknown>
  boundBy?: string | null
}

function toIso(value: string | Date | null | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseProfile(value: ExternalIdentityRow['profile']): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
  return typeof value === 'object' ? value : {}
}

function mapRow(row: ExternalIdentityRow): UserExternalIdentity {
  return {
    id: row.id,
    provider: row.provider,
    externalKey: row.external_key,
    providerUserId: normalizeText(row.provider_user_id),
    providerUnionId: normalizeText(row.provider_union_id),
    providerOpenId: normalizeText(row.provider_open_id),
    corpId: normalizeText(row.corp_id),
    userId: row.local_user_id,
    profile: parseProfile(row.profile),
    boundBy: normalizeText(row.bound_by),
    lastLoginAt: toIso(row.last_login_at),
    createdAt: toIso(row.created_at) || new Date().toISOString(),
    updatedAt: toIso(row.updated_at) || new Date().toISOString(),
  }
}

export function buildDingTalkExternalKey(input: {
  corpId?: string | null
  userId?: string | null
  unionId?: string | null
  openId?: string | null
}): string | null {
  const corpId = normalizeText(input.corpId)
  const userId = normalizeText(input.userId)
  const unionId = normalizeText(input.unionId)
  const openId = normalizeText(input.openId)

  if (corpId && userId) return `dingtalk:${corpId}:${userId}`
  if (unionId) return `dingtalk-union:${unionId}`
  if (openId) return `dingtalk-open:${openId}`
  if (userId) return `dingtalk-user:${userId}`
  return null
}

export function buildDingTalkCandidateKeys(input: {
  corpId?: string | null
  userId?: string | null
  unionId?: string | null
  openId?: string | null
}): string[] {
  const keys = [
    buildDingTalkExternalKey(input),
    normalizeText(input.unionId) ? `dingtalk-union:${normalizeText(input.unionId)}` : null,
    normalizeText(input.openId) ? `dingtalk-open:${normalizeText(input.openId)}` : null,
    normalizeText(input.userId) ? `dingtalk-user:${normalizeText(input.userId)}` : null,
  ]

  return Array.from(new Set(keys.filter((value): value is string => Boolean(value))))
}

export async function findExternalIdentityByProviderAndKey(
  provider: ExternalIdentityProvider,
  externalKey: string,
): Promise<UserExternalIdentity | null> {
  try {
    const result = await query<ExternalIdentityRow>(
      `SELECT id, provider, external_key, provider_user_id, provider_union_id, provider_open_id, corp_id,
              local_user_id, profile, bound_by, last_login_at, created_at, updated_at
       FROM user_external_identities
       WHERE provider = $1 AND external_key = $2
       LIMIT 1`,
      [provider, externalKey],
    )
    const row = result.rows[0]
    return row ? mapRow(row) : null
  } catch (error) {
    if (isDatabaseSchemaError(error)) return null
    throw error
  }
}

async function findExternalIdentityByProviderUnionId(
  provider: ExternalIdentityProvider,
  unionId: string,
): Promise<UserExternalIdentity | null> {
  try {
    const result = await query<ExternalIdentityRow>(
      `SELECT id, provider, external_key, provider_user_id, provider_union_id, provider_open_id, corp_id,
              local_user_id, profile, bound_by, last_login_at, created_at, updated_at
       FROM user_external_identities
       WHERE provider = $1
         AND provider_union_id = $2
       ORDER BY updated_at DESC
       LIMIT 1`,
      [provider, unionId],
    )
    const row = result.rows[0]
    return row ? mapRow(row) : null
  } catch (error) {
    if (isDatabaseSchemaError(error)) return null
    throw error
  }
}

async function findExternalIdentityByProviderOpenId(
  provider: ExternalIdentityProvider,
  openId: string,
): Promise<UserExternalIdentity | null> {
  try {
    const result = await query<ExternalIdentityRow>(
      `SELECT id, provider, external_key, provider_user_id, provider_union_id, provider_open_id, corp_id,
              local_user_id, profile, bound_by, last_login_at, created_at, updated_at
       FROM user_external_identities
       WHERE provider = $1
         AND provider_open_id = $2
       ORDER BY updated_at DESC
       LIMIT 1`,
      [provider, openId],
    )
    const row = result.rows[0]
    return row ? mapRow(row) : null
  } catch (error) {
    if (isDatabaseSchemaError(error)) return null
    throw error
  }
}

async function findExternalIdentityByProviderUserId(
  provider: ExternalIdentityProvider,
  userId: string,
  corpId?: string | null,
): Promise<UserExternalIdentity | null> {
  const normalizedCorpId = normalizeText(corpId)

  try {
    const result = normalizedCorpId
      ? await query<ExternalIdentityRow>(
        `SELECT id, provider, external_key, provider_user_id, provider_union_id, provider_open_id, corp_id,
                local_user_id, profile, bound_by, last_login_at, created_at, updated_at
         FROM user_external_identities
         WHERE provider = $1
           AND corp_id = $2
           AND provider_user_id = $3
         ORDER BY updated_at DESC
         LIMIT 1`,
        [provider, normalizedCorpId, userId],
      )
      : await query<ExternalIdentityRow>(
        `SELECT id, provider, external_key, provider_user_id, provider_union_id, provider_open_id, corp_id,
                local_user_id, profile, bound_by, last_login_at, created_at, updated_at
         FROM user_external_identities
         WHERE provider = $1
           AND provider_user_id = $2
         ORDER BY updated_at DESC
         LIMIT 1`,
        [provider, userId],
      )
    const row = result.rows[0]
    return row ? mapRow(row) : null
  } catch (error) {
    if (isDatabaseSchemaError(error)) return null
    throw error
  }
}

export async function findDingTalkExternalIdentity(input: {
  corpId?: string | null
  userId?: string | null
  unionId?: string | null
  openId?: string | null
}): Promise<UserExternalIdentity | null> {
  const keys = buildDingTalkCandidateKeys(input)
  for (const key of keys) {
    const match = await findExternalIdentityByProviderAndKey('dingtalk', key)
    if (match) return match
  }

  const unionId = normalizeText(input.unionId)
  if (unionId) {
    const match = await findExternalIdentityByProviderUnionId('dingtalk', unionId)
    if (match) return match
  }

  const openId = normalizeText(input.openId)
  if (openId) {
    const match = await findExternalIdentityByProviderOpenId('dingtalk', openId)
    if (match) return match
  }

  const userId = normalizeText(input.userId)
  if (userId) {
    const match = await findExternalIdentityByProviderUserId('dingtalk', userId, input.corpId)
    if (match) return match
  }

  return null
}

export async function listUserExternalIdentities(
  userId: string,
  provider?: ExternalIdentityProvider,
): Promise<UserExternalIdentity[]> {
  const providerFilter = provider ? 'AND provider = $2' : ''
  const params = provider ? [userId, provider] : [userId]

  try {
    const result = await query<ExternalIdentityRow>(
      `SELECT id, provider, external_key, provider_user_id, provider_union_id, provider_open_id, corp_id,
              local_user_id, profile, bound_by, last_login_at, created_at, updated_at
       FROM user_external_identities
       WHERE local_user_id = $1
       ${providerFilter}
       ORDER BY created_at ASC`,
      params,
    )
    return result.rows.map(mapRow)
  } catch (error) {
    if (isDatabaseSchemaError(error)) return []
    throw error
  }
}

export async function upsertExternalIdentity(input: UpsertExternalIdentityInput): Promise<UserExternalIdentity | null> {
  try {
    const result = await query<ExternalIdentityRow>(
      `INSERT INTO user_external_identities (
         provider,
         external_key,
         provider_user_id,
         provider_union_id,
         provider_open_id,
         corp_id,
         local_user_id,
         profile,
         bound_by,
         last_login_at,
         created_at,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, NOW(), NOW(), NOW())
       ON CONFLICT (provider, external_key) DO UPDATE
       SET provider_user_id = EXCLUDED.provider_user_id,
           provider_union_id = EXCLUDED.provider_union_id,
           provider_open_id = EXCLUDED.provider_open_id,
           corp_id = EXCLUDED.corp_id,
           local_user_id = EXCLUDED.local_user_id,
           profile = EXCLUDED.profile,
           bound_by = COALESCE(EXCLUDED.bound_by, user_external_identities.bound_by),
           last_login_at = NOW(),
           updated_at = NOW()
       RETURNING id, provider, external_key, provider_user_id, provider_union_id, provider_open_id, corp_id,
                 local_user_id, profile, bound_by, last_login_at, created_at, updated_at`,
      [
        input.provider,
        input.externalKey,
        normalizeText(input.providerUserId),
        normalizeText(input.providerUnionId),
        normalizeText(input.providerOpenId),
        normalizeText(input.corpId),
        input.userId,
        JSON.stringify(input.profile || {}),
        normalizeText(input.boundBy),
      ],
    )
    const row = result.rows[0]
    return row ? mapRow(row) : null
  } catch (error) {
    if (isDatabaseSchemaError(error)) return null
    throw error
  }
}

export async function touchExternalIdentityLogin(identityId: string): Promise<void> {
  try {
    await query(
      `UPDATE user_external_identities
       SET last_login_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [identityId],
    )
  } catch (error) {
    if (isDatabaseSchemaError(error)) return
    throw error
  }
}

export async function deleteUserExternalIdentity(
  userId: string,
  provider: ExternalIdentityProvider,
  bindingId: string,
): Promise<UserExternalIdentity | null> {
  try {
    const result = await query<ExternalIdentityRow>(
      `DELETE FROM user_external_identities
       WHERE id = $1
         AND provider = $2
         AND local_user_id = $3
       RETURNING id, provider, external_key, provider_user_id, provider_union_id, provider_open_id, corp_id,
                 local_user_id, profile, bound_by, last_login_at, created_at, updated_at`,
      [bindingId, provider, userId],
    )
    const row = result.rows[0]
    return row ? mapRow(row) : null
  } catch (error) {
    if (isDatabaseSchemaError(error)) return null
    throw error
  }
}
