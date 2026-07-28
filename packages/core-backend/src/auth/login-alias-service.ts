/**
 * T2a/T2b — user_login_aliases claim, backfill, and cutover gate (design lock Rev 4.2 §4).
 *
 * T2a: backfill uncontested values; write collision report; Auth still uses OR-column login.
 * T2b: after admin-alias readiness, AUTH_LOGIN_USE_ALIASES=1 (or explicit enable) switches
 * Auth to alias-only reads permanently for that process/deployment.
 */

import { query } from '../db/pg'
import {
  inferLoginAliasKind,
  normalizeLoginIdentifier,
  type LoginAliasKind,
} from './login-identifier'

export type LoginAliasRow = {
  id: string
  user_id: string
  kind: LoginAliasKind
  normalized_value: string
}

export type AliasCollision = {
  normalizedValue: string
  kind: LoginAliasKind
  candidateUserIds: string[]
  reason: string
}

export type BackfillResult = {
  inserted: number
  collisions: number
  skippedEmpty: number
}

/** Env cutover switch for T2b (default off until ready). */
export function isAuthLoginAliasCutoverEnabled(): boolean {
  return ['true', '1', 'yes'].includes(
    String(process.env.AUTH_LOGIN_USE_ALIASES ?? '').trim().toLowerCase(),
  )
}

export async function findUserIdByLoginAlias(rawIdentifier: string): Promise<string | null> {
  const normalized = normalizeLoginIdentifier(rawIdentifier)
  if (!normalized) return null
  const result = await query<{ user_id: string }>(
    `SELECT user_id FROM user_login_aliases WHERE normalized_value = $1 LIMIT 2`,
    [normalized],
  )
  if (result.rows.length !== 1) return null
  return result.rows[0].user_id
}

type AliasQueryClient = {
  query: <T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: T[] }>
}

export async function claimLoginAlias(options: {
  userId: string
  rawValue: string
  kind?: LoginAliasKind
  source?: string
  /** When set, runs inside caller's transaction (T3 activate must claim before commit). */
  client?: AliasQueryClient
}): Promise<{ ok: true; normalized: string } | { ok: false; code: string; message: string }> {
  const normalized = normalizeLoginIdentifier(options.rawValue)
  if (!normalized) {
    return { ok: false, code: 'ALIAS_EMPTY', message: 'Identifier is empty after normalization' }
  }
  const kind = options.kind ?? inferLoginAliasKind(options.rawValue)
  const runQuery = async <T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }> => {
    if (options.client) {
      return options.client.query<T>(sql, params)
    }
    return query<T>(sql, params)
  }
  try {
    await runQuery(
      `INSERT INTO user_login_aliases (user_id, kind, normalized_value, source)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (normalized_value) DO NOTHING`,
      [options.userId, kind, normalized, options.source ?? 'claim'],
    )
    const check = await runQuery<{ user_id: string }>(
      `SELECT user_id FROM user_login_aliases WHERE normalized_value = $1`,
      [normalized],
    )
    if (!check.rows[0]) {
      return { ok: false, code: 'ALIAS_CONFLICT', message: 'Normalized identifier already claimed' }
    }
    if (check.rows[0].user_id !== options.userId) {
      return { ok: false, code: 'ALIAS_CONFLICT', message: 'Normalized identifier already claimed' }
    }
    return { ok: true, normalized }
  } catch (error) {
    return {
      ok: false,
      code: 'ALIAS_WRITE_FAILED',
      message: error instanceof Error ? error.message : 'alias write failed',
    }
  }
}

type Candidate = { userId: string; kind: LoginAliasKind; raw: string; normalized: string }

/**
 * Scan users.email / username / mobile, insert only globally unique ownership;
 * multi-owner or cross-kind clashes go to collision report.
 */
export async function backfillUserLoginAliases(): Promise<BackfillResult> {
  const users = await query<{
    id: string
    email: string | null
    username: string | null
    mobile: string | null
  }>(`SELECT id, email, username, mobile FROM users`)

  const byNormalized = new Map<string, Candidate[]>()
  let skippedEmpty = 0

  for (const row of users.rows) {
    const fields: Array<{ kind: LoginAliasKind; raw: string | null }> = [
      { kind: 'email', raw: row.email },
      { kind: 'username', raw: row.username },
      { kind: 'mobile', raw: row.mobile },
    ]
    for (const field of fields) {
      if (!field.raw || !String(field.raw).trim()) {
        skippedEmpty += 1
        continue
      }
      const normalized = normalizeLoginIdentifier(field.raw)
      if (!normalized) {
        skippedEmpty += 1
        continue
      }
      const list = byNormalized.get(normalized) ?? []
      list.push({ userId: row.id, kind: field.kind, raw: field.raw, normalized })
      byNormalized.set(normalized, list)
    }
  }

  let inserted = 0
  let collisions = 0

  for (const [normalized, candidates] of byNormalized) {
    const distinctUsers = [...new Set(candidates.map((c) => c.userId))]
    if (distinctUsers.length !== 1) {
      collisions += 1
      await recordCollision({
        normalizedValue: normalized,
        kind: candidates[0].kind,
        candidateUserIds: distinctUsers,
        reason: 'multiple_users_claim_same_normalized_value',
      })
      continue
    }
    // Single user may have email+username both normalize to same value — still one alias row.
    const owner = candidates[0]
    try {
      const result = await query(
        `INSERT INTO user_login_aliases (user_id, kind, normalized_value, source)
         VALUES ($1, $2, $3, 't2a_backfill')
         ON CONFLICT (normalized_value) DO NOTHING
         RETURNING id`,
        [owner.userId, owner.kind, normalized],
      )
      if (result.rows[0]) inserted += 1
    } catch {
      collisions += 1
      await recordCollision({
        normalizedValue: normalized,
        kind: owner.kind,
        candidateUserIds: [owner.userId],
        reason: 'insert_failed',
      })
    }
  }

  return { inserted, collisions, skippedEmpty }
}

async function recordCollision(c: AliasCollision): Promise<void> {
  await query(
    `INSERT INTO user_login_alias_collision_report
       (normalized_value, kind, candidate_user_ids, reason)
     VALUES ($1, $2, $3::text[], $4)`,
    [c.normalizedValue, c.kind, c.candidateUserIds, c.reason],
  )
}

/**
 * T2b gate: at least one **platform** admin with a usable local password AND a login alias.
 *
 * Mirrors `rbac/service.isAdmin`: only `user_roles.role_id = 'admin'` counts.
 * Does NOT treat attendance_admin / crm_admin / name LIKE '%admin%' as platform admin
 * (those would false-green cutover while real platform admins still lack aliases).
 * Usable password: local_password_set, non-empty password_hash, activated + is_active.
 */
export async function hasActiveAdminWithPasswordAlias(): Promise<boolean> {
  const result = await query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM users u
       JOIN user_login_aliases a ON a.user_id = u.id
       JOIN user_roles ur ON ur.user_id = u.id AND ur.role_id = 'admin'
      WHERE u.is_active = TRUE
        AND COALESCE(u.local_password_set, TRUE) = TRUE
        AND COALESCE(u.activation_status, 'activated') = 'activated'
        AND u.password_hash IS NOT NULL
        AND length(trim(u.password_hash)) > 0
        AND u.password_hash NOT LIKE 'unusable:%'`,
  )
  return (result.rows[0]?.n ?? 0) > 0
}

/**
 * Assert T2b cutover is allowed. Throws if env requests aliases but gate fails.
 */
export async function assertAliasCutoverAllowed(): Promise<void> {
  if (!isAuthLoginAliasCutoverEnabled()) return
  const ok = await hasActiveAdminWithPasswordAlias()
  if (!ok) {
    const err = new Error(
      'AUTH_LOGIN_USE_ALIASES is enabled but no active platform admin has a usable password login alias; refusing cutover',
    )
    ;(err as Error & { code?: string }).code = 'ALIAS_CUTOVER_BLOCKED'
    throw err
  }
}
