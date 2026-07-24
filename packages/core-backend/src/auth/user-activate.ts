/**
 * T3 — promote pending_activation → activated (design lock Rev 4.2 §2.3 / §6).
 *
 * Single durable transaction: status + is_active + optional password + optional
 * memberships. Rejects inactive directory sources for SSO-shaped activates.
 */

import * as bcrypt from 'bcryptjs'
import { transaction } from '../db/pg'
import { getBcryptSaltRounds } from '../security/auth-runtime-config'
import { claimLoginAlias } from './login-alias-service'
import { buildUnusablePasswordHash } from './user-activation'

export type ActivateMode = 'temp_password' | 'sso' | 'admin_no_password'

export type ActivateUserInput = {
  userId: string
  mode: ActivateMode
  adminUserId?: string
  /** When mode=temp_password; generated if omitted. */
  temporaryPassword?: string
  orgId?: string | null
  enableDingTalkGrant?: boolean
  /** SSO: directory account that must be active + linked to this user. */
  directoryAccountId?: string | null
}

export type ActivateUserResult = {
  userId: string
  activationStatus: 'activated'
  isActive: true
  temporaryPassword?: string
  localPasswordSet: boolean
}

function throwCoded(message: string, code: string): never {
  const err = new Error(message)
  ;(err as Error & { code?: string }).code = code
  throw err
}

/**
 * Activate a pending user. All durable writes in one transaction.
 */
export async function activatePendingUser(input: ActivateUserInput): Promise<ActivateUserResult> {
  const userId = String(input.userId || '').trim()
  if (!userId) throwCoded('userId is required', 'ACTIVATE_USER_REQUIRED')

  let temporaryPassword: string | undefined
  let passwordHash: string | null = null
  let localPasswordSet = false
  let mustChangePassword = false

  if (input.mode === 'temp_password') {
    temporaryPassword = input.temporaryPassword?.trim() || generateTempPassword()
    passwordHash = await bcrypt.hash(temporaryPassword, getBcryptSaltRounds())
    localPasswordSet = true
    mustChangePassword = true
  } else if (input.mode === 'sso') {
    // SSO activate: unusable local password; login via DingTalk after grant.
    passwordHash = await buildUnusablePasswordHash()
    localPasswordSet = false
    mustChangePassword = false
  } else {
    passwordHash = await buildUnusablePasswordHash()
    localPasswordSet = false
  }

  await transaction(async (client) => {
    const locked = await client.query(
      `SELECT id, email, username, mobile, activation_status, is_active
         FROM users
        WHERE id = $1
        FOR UPDATE`,
      [userId],
    )
    const user = locked.rows[0] as
      | {
          id: string
          email: string | null
          username: string | null
          mobile: string | null
          activation_status: string
          is_active: boolean
        }
      | undefined
    if (!user) throwCoded('User not found', 'ACTIVATE_USER_NOT_FOUND')
    if (user.activation_status !== 'pending_activation') {
      throwCoded(
        'User is not pending_activation',
        'ACTIVATE_NOT_PENDING',
      )
    }

    if (input.mode === 'sso' || input.directoryAccountId) {
      await assertDirectorySourceActiveForActivate(client, {
        userId,
        directoryAccountId: input.directoryAccountId ?? null,
      })
    }

    const updated = await client.query(
      `UPDATE users
          SET activation_status = 'activated',
              is_active = TRUE,
              password_hash = COALESCE($2, password_hash),
              local_password_set = $3,
              must_change_password = $4,
              updated_at = NOW()
        WHERE id = $1
          AND activation_status = 'pending_activation'
        RETURNING id`,
      [userId, passwordHash, localPasswordSet, mustChangePassword],
    )
    if (!updated.rows[0]) {
      throwCoded('Activation race: user no longer pending', 'ACTIVATE_RACE')
    }

    // Active membership for current org when provided.
    if (input.orgId) {
      // `user_orgs` is (user_id, org_id, is_active, created_at) with PK (user_id, org_id) — there
      // is no `updated_at`. Writing one raised `42703` and aborted this transaction, which is why
      // the "schema variance" fallback underneath could never help: once a statement fails inside
      // a transaction, Postgres rejects every later statement with `25P02`, the fallback
      // included. The net effect was that activating a pending user WITH an org — the ordinary
      // case — could not succeed at all; it died at COMMIT. Writing the real shape is the fix,
      // and the fallback goes with it: a second guess at the schema is not a substitute for
      // matching it.
      await client.query(
        `INSERT INTO user_orgs (user_id, org_id, is_active, created_at)
         VALUES ($1, $2, TRUE, NOW())
         ON CONFLICT (user_id, org_id) DO UPDATE
           SET is_active = TRUE`,
        [userId, input.orgId],
      )
    }

    if (input.enableDingTalkGrant === true) {
      // The DingTalk grant lives in `user_external_auth_grants` — the table `dingtalk-oauth.ts`
      // reads to decide whether a login is allowed. This wrote `user_external_identities
      // .grant_enabled`, a column no migration creates, inside a `.catch`: activation reported
      // success while the person was never actually granted DingTalk login. Same upsert shape the
      // OAuth bind path uses.
      //
      // The swallow is gone with it. Inside a transaction a failed statement poisons the
      // connection, so catching the rejection does not make the failure harmless — it only moves
      // the error to whichever innocent statement runs next, as `25P02`.
      await client.query(
        `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by, created_at, updated_at)
         VALUES ('dingtalk', $1, TRUE, $2, NOW(), NOW())
         ON CONFLICT (provider, local_user_id)
         DO UPDATE SET enabled = TRUE, granted_by = EXCLUDED.granted_by, updated_at = NOW()`,
        [userId, `activate:${input.adminUserId ?? 'system'}`],
      )
    }

    // Alias claims are MANDATORY inside the same transaction as activation.
    // No client opt-out: post-commit / optional claim left "activated + password issued
    // but cannot log in" under AUTH_LOGIN_USE_ALIASES. Fail closed → full activate rollback.
    const fields: Array<{ raw: string | null; kind: 'email' | 'username' | 'mobile' }> = [
      { raw: user.email, kind: 'email' },
      { raw: user.username, kind: 'username' },
      { raw: user.mobile, kind: 'mobile' },
    ]
    let claimedAny = false
    for (const field of fields) {
      if (!field.raw || !String(field.raw).trim()) continue
      const claimed = await claimLoginAlias({
        userId,
        rawValue: field.raw,
        kind: field.kind,
        source: 't3_activate',
        client,
      })
      if (claimed.ok === false) {
        // Never echo claim.message (may contain raw PostgreSQL text). Map codes only:
        // CONFLICT / REQUIRED → client 409; WRITE_FAILED → 500 ACTIVATE_ALIAS_FAILED.
        if (claimed.code === 'ALIAS_CONFLICT') {
          throwCoded(
            `Login alias for ${field.kind} is already claimed by another account`,
            'ACTIVATE_ALIAS_CONFLICT',
          )
        }
        if (claimed.code === 'ALIAS_EMPTY') {
          throwCoded(
            `Login alias for ${field.kind} is empty after normalization`,
            'ACTIVATE_ALIAS_REQUIRED',
          )
        }
        throwCoded(
          'Failed to claim login alias during activation',
          'ACTIVATE_ALIAS_FAILED',
        )
      }
      claimedAny = true
    }
    if (!claimedAny) {
      throwCoded(
        'Activation requires at least one claimable login identifier (email, username, or mobile)',
        'ACTIVATE_ALIAS_REQUIRED',
      )
    }
  })

  return {
    userId,
    activationStatus: 'activated',
    isActive: true,
    temporaryPassword,
    localPasswordSet,
  }
}

async function assertDirectorySourceActiveForActivate(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  options: { userId: string; directoryAccountId: string | null },
): Promise<void> {
  // Closed set: linked directory account must be active; integration active.
  const sql = options.directoryAccountId
    ? `SELECT da.id, da.is_active AS account_active, di.status AS integration_status,
              l.local_user_id, l.link_status
         FROM directory_accounts da
         JOIN directory_integrations di ON di.id = da.integration_id
         LEFT JOIN directory_account_links l ON l.directory_account_id = da.id
        WHERE da.id = $1
        LIMIT 1`
    : `SELECT da.id, da.is_active AS account_active, di.status AS integration_status,
              l.local_user_id, l.link_status
         FROM directory_account_links l
         JOIN directory_accounts da ON da.id = l.directory_account_id
         JOIN directory_integrations di ON di.id = da.integration_id
        WHERE l.local_user_id = $1
          AND COALESCE(l.link_status, 'linked') = 'linked'
        LIMIT 1`

  const params = options.directoryAccountId
    ? [options.directoryAccountId]
    : [options.userId]
  const result = await client.query(sql, params)
  const row = result.rows[0] as
    | {
        account_active: boolean
        integration_status: string
        local_user_id: string | null
        link_status: string | null
      }
    | undefined

  if (!row) {
    throwCoded('No linked active directory account for activation', 'ACTIVATE_SOURCE_MISSING')
  }
  if (row.account_active === false) {
    throwCoded('Directory account is inactive; cannot activate', 'ACTIVATE_SOURCE_INACTIVE')
  }
  if (String(row.integration_status || '').toLowerCase() !== 'active') {
    throwCoded('Directory integration is not active; cannot activate', 'ACTIVATE_INTEGRATION_INACTIVE')
  }
  if (row.local_user_id && row.local_user_id !== options.userId) {
    throwCoded('Directory link points to a different user', 'ACTIVATE_LINK_MISMATCH')
  }
}

function generateTempPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#'
  let out = 'Tmp#'
  for (let i = 0; i < 12; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return out
}
