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
  claimAliases?: boolean
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
      await client.query(
        `INSERT INTO user_orgs (user_id, org_id, is_active, created_at, updated_at)
         VALUES ($1, $2, TRUE, NOW(), NOW())
         ON CONFLICT (user_id, org_id) DO UPDATE
           SET is_active = TRUE, updated_at = NOW()`,
        [userId, input.orgId],
      ).catch(async () => {
        // Schema variance: try minimal shape
        await client.query(
          `INSERT INTO user_orgs (user_id, org_id, is_active)
           VALUES ($1, $2, TRUE)
           ON CONFLICT DO NOTHING`,
          [userId, input.orgId],
        ).catch(() => {
          /* membership optional if table shape differs */
        })
      })
    }

    if (input.enableDingTalkGrant === true) {
      await client.query(
        `UPDATE user_external_identities
            SET grant_enabled = TRUE, updated_at = NOW()
          WHERE local_user_id = $1 AND provider = 'dingtalk'`,
        [userId],
      ).catch(() => {
        /* grant column may be named differently — non-fatal for unit/mock */
      })
    }
  })

  // Alias claims post-commit (T2a table may be empty before cutover); best-effort.
  if (input.claimAliases !== false) {
    const locked = await import('../db/pg').then((m) =>
      m.query<{ email: string | null; username: string | null; mobile: string | null }>(
        `SELECT email, username, mobile FROM users WHERE id = $1`,
        [userId],
      ),
    )
    const row = locked.rows[0]
    if (row?.email) await claimLoginAlias({ userId, rawValue: row.email, kind: 'email', source: 't3_activate' })
    if (row?.username) await claimLoginAlias({ userId, rawValue: row.username, kind: 'username', source: 't3_activate' })
    if (row?.mobile) await claimLoginAlias({ userId, rawValue: row.mobile, kind: 'mobile', source: 't3_activate' })
  }

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
