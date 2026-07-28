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

/**
 * Transaction client surface used by alias writers.
 * Kept structurally loose so directory-sync / admin / OAuth transaction clients assign cleanly.
 */
export type AliasQueryClient = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> | unknown[] }>
}

/** Safe client-facing codes for activated-user identifier writers (never raw PG text). */
export type LoginAliasWriterErrorCode = 'ALIAS_CONFLICT' | 'ALIAS_WRITE_FAILED'

export type ClaimedLoginAlias = {
  kind: LoginAliasKind
  normalized: string
}

export type ClaimNonEmptyLoginAliasesResult =
  | { ok: true; claimed: ClaimedLoginAlias[] }
  | {
      ok: false
      code: LoginAliasWriterErrorCode
      kind?: LoginAliasKind
      /** Fixed safe message — never re-export claimLoginAlias/driver text. */
      message: string
    }

const ALIAS_CONFLICT_MESSAGE = 'A login identifier is already claimed by another account'
const ALIAS_WRITE_FAILED_MESSAGE = 'Failed to claim login alias'

/** Thrown by writer paths so outer transactions roll back without leaking PG text. */
export class LoginAliasClaimError extends Error {
  readonly code: LoginAliasWriterErrorCode
  readonly kind?: LoginAliasKind

  constructor(code: LoginAliasWriterErrorCode, kind?: LoginAliasKind) {
    super(code === 'ALIAS_CONFLICT' ? ALIAS_CONFLICT_MESSAGE : ALIAS_WRITE_FAILED_MESSAGE)
    this.name = 'LoginAliasClaimError'
    this.code = code
    this.kind = kind
  }
}

function mapClaimFailure(
  claimed: { ok: false; code: string; message: string },
  kind: LoginAliasKind,
): Extract<ClaimNonEmptyLoginAliasesResult, { ok: false }> {
  // Never echo claimed.message — claimLoginAlias may attach raw PostgreSQL/driver text on WRITE_FAILED.
  if (claimed.code === 'ALIAS_CONFLICT' || claimed.code === 'ALIAS_EMPTY') {
    // ALIAS_EMPTY after we already normalized non-empty is treated as conflict/unusable claim.
    return {
      ok: false,
      code: 'ALIAS_CONFLICT',
      kind,
      message: ALIAS_CONFLICT_MESSAGE,
    }
  }
  return {
    ok: false,
    code: 'ALIAS_WRITE_FAILED',
    kind,
    message: ALIAS_WRITE_FAILED_MESSAGE,
  }
}

/**
 * Fail-closed transactional helper for activated-user / identifier writers.
 *
 * Claims every non-empty email / username / mobile through `normalizeLoginIdentifier` +
 * `claimLoginAlias` on the caller's transaction client. Empty / un-normalizable fields are
 * skipped. Conflicts and write failures return fixed safe messages only (no raw PG text).
 *
 * Callers MUST pass `client` from an open transaction so a conflict rolls back the user write.
 */
export async function claimNonEmptyLoginAliases(options: {
  userId: string
  email?: string | null
  username?: string | null
  mobile?: string | null
  source?: string
  client: AliasQueryClient
}): Promise<ClaimNonEmptyLoginAliasesResult> {
  const fields: Array<{ raw: string | null | undefined; kind: LoginAliasKind }> = [
    { raw: options.email, kind: 'email' },
    { raw: options.username, kind: 'username' },
    { raw: options.mobile, kind: 'mobile' },
  ]
  const claimed: ClaimedLoginAlias[] = []
  for (const field of fields) {
    if (field.raw == null || !String(field.raw).trim()) continue
    const normalized = normalizeLoginIdentifier(field.raw)
    if (!normalized) continue
    const result = await claimLoginAlias({
      userId: options.userId,
      rawValue: field.raw,
      kind: field.kind,
      source: options.source ?? 'writer_claim',
      client: options.client,
    })
    if (result.ok === false) {
      return mapClaimFailure(result, field.kind)
    }
    claimed.push({ kind: field.kind, normalized: result.normalized })
  }
  return { ok: true, claimed }
}

/**
 * Same as claimNonEmptyLoginAliases but throws LoginAliasClaimError (safe message / code).
 * Intended for in-transaction writer hooks where failure must abort the unit of work.
 */
export async function claimNonEmptyLoginAliasesOrThrow(options: {
  userId: string
  email?: string | null
  username?: string | null
  mobile?: string | null
  source?: string
  client: AliasQueryClient
}): Promise<ClaimedLoginAlias[]> {
  const result = await claimNonEmptyLoginAliases(options)
  if (result.ok === false) {
    throw new LoginAliasClaimError(result.code, result.kind)
  }
  return result.claimed
}

/**
 * Profile mobile identifier change (same transaction as users.mobile UPDATE):
 * 1) claim the new mobile when normalized value is non-empty and differs from prior
 * 2) run `afterNewClaim` (caller performs the profile row replace / CAS)
 * 3) retire the prior mobile alias only if owned by this user and normalized values differ
 *
 * A conflict or afterNewClaim failure leaves the transaction to roll back — no partial retire.
 */
export async function applyMobileLoginAliasChange(options: {
  userId: string
  previousMobile?: string | null
  nextMobile?: string | null
  source?: string
  client: AliasQueryClient
  afterNewClaim: () => Promise<void>
}): Promise<ClaimNonEmptyLoginAliasesResult & { retiredNormalized: string | null }> {
  const previousNormalized = options.previousMobile
    ? normalizeLoginIdentifier(options.previousMobile)
    : null
  const nextNormalized = options.nextMobile
    ? normalizeLoginIdentifier(options.nextMobile)
    : null

  const claimed: ClaimedLoginAlias[] = []
  if (nextNormalized && nextNormalized !== previousNormalized && options.nextMobile) {
    const result = await claimLoginAlias({
      userId: options.userId,
      rawValue: options.nextMobile,
      kind: 'mobile',
      source: options.source ?? 'profile_mobile',
      client: options.client,
    })
    if (result.ok === false) {
      return { ...mapClaimFailure(result, 'mobile'), retiredNormalized: null }
    }
    claimed.push({ kind: 'mobile', normalized: result.normalized })
  }

  await options.afterNewClaim()

  let retiredNormalized: string | null = null
  if (previousNormalized && previousNormalized !== nextNormalized) {
    // Only delete an alias owned by this user; never touch another principal's row.
    await options.client.query(
      `DELETE FROM user_login_aliases
        WHERE user_id = $1
          AND kind = 'mobile'
          AND normalized_value = $2`,
      [options.userId, previousNormalized],
    )
    retiredNormalized = previousNormalized
  }

  return { ok: true, claimed, retiredNormalized }
}

export async function applyMobileLoginAliasChangeOrThrow(options: {
  userId: string
  previousMobile?: string | null
  nextMobile?: string | null
  source?: string
  client: AliasQueryClient
  afterNewClaim: () => Promise<void>
}): Promise<{ claimed: ClaimedLoginAlias[]; retiredNormalized: string | null }> {
  const result = await applyMobileLoginAliasChange(options)
  if (result.ok === false) {
    throw new LoginAliasClaimError(result.code, result.kind)
  }
  return { claimed: result.claimed, retiredNormalized: result.retiredNormalized }
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
  const runQuery = async (
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }> => {
    if (options.client) {
      const result = await options.client.query(sql, params)
      return { rows: result.rows as Array<Record<string, unknown>> }
    }
    const result = await query<Record<string, unknown>>(sql, params)
    return { rows: result.rows }
  }
  try {
    await runQuery(
      `INSERT INTO user_login_aliases (user_id, kind, normalized_value, source)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (normalized_value) DO NOTHING`,
      [options.userId, kind, normalized, options.source ?? 'claim'],
    )
    const check = await runQuery(
      `SELECT user_id FROM user_login_aliases WHERE normalized_value = $1`,
      [normalized],
    )
    const ownerId = check.rows[0]?.user_id
    if (ownerId == null) {
      return { ok: false, code: 'ALIAS_CONFLICT', message: 'Normalized identifier already claimed' }
    }
    if (String(ownerId) !== options.userId) {
      return { ok: false, code: 'ALIAS_CONFLICT', message: 'Normalized identifier already claimed' }
    }
    return { ok: true, normalized }
  } catch (error) {
    return {
      ok: false,
      code: 'ALIAS_WRITE_FAILED',
      // Intentionally may include driver text for server logs; writers must map via
      // claimNonEmptyLoginAliases / LoginAliasClaimError and never echo this to clients.
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
