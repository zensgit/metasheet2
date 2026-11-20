import { randomBytes } from 'node:crypto'
import * as bcrypt from 'bcryptjs'
import { PlatformActorAuthorityLost } from '../admin/platform-actor-authority'
import { transaction } from '../db/pg'
import { getBcryptSaltRounds } from '../security/auth-runtime-config'
import { verifyInviteToken } from './invite-tokens'
import { hasActiveAdminWithPasswordAlias, isAuthLoginAliasCutoverEnabled } from './login-alias-service'
import { normalizeLoginIdentifier } from './login-identifier'
import { validatePassword } from './password-policy'

export class ManualDeliveryConflict extends Error {}

export async function deliverInviteManually(inviteId: string, actorId: string) {
  return transaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    const located = await client.query('SELECT user_id FROM user_invites WHERE id = $1', [inviteId])
    const userId = located.rows[0]?.user_id
    if (!userId || !actorId || userId === actorId) throw new ManualDeliveryConflict()

    const target = await client.query(
      `SELECT email, updated_at FROM users WHERE id = $1
         AND is_active AND activation_status = 'activated' AND local_password_set
         AND password_hash ~ '^\\$2[aby]\\$[0-9]{2}\\$[./A-Za-z0-9]{53}$'
         AND deleted_at IS NULL AND purged_at IS NULL AND last_login_at IS NULL
       FOR UPDATE`, [userId],
    )
    const user = target.rows[0]
    if (!user?.email?.trim()) throw new ManualDeliveryConflict()
    const invites = await client.query(
      `SELECT id, email, invite_token, status, accepted_at, consumed_by
       FROM user_invites WHERE user_id = $1 FOR UPDATE`, [userId],
    )
    const invite = invites.rows[0]
    if (invites.rows.length !== 1 || invite.id !== inviteId || invite.email !== user.email
      || invite.status !== 'pending' || invite.accepted_at !== null || invite.consumed_by !== null) {
      throw new ManualDeliveryConflict()
    }
    const actor = await client.query(
      `SELECT u.id FROM users u JOIN user_roles membership ON membership.user_id = u.id
       WHERE u.id = $1 AND u.is_active AND u.activation_status = 'activated'
         AND u.deleted_at IS NULL AND u.purged_at IS NULL AND membership.role_id = 'admin'
       FOR SHARE OF u, membership`, [actorId],
    )
    if (!actor.rows[0]) throw new PlatformActorAuthorityLost()
    const token = verifyInviteToken(invite.invite_token)
    const updated = user.updated_at == null ? NaN : new Date(user.updated_at).getTime()
    if (!token || token.email !== user.email || token.userId !== userId
      || !Number.isFinite(token.exp) || !token.iat || !Number.isFinite(token.iat)
      || !Number.isFinite(updated) || updated > (token.iat + 1) * 1000) throw new ManualDeliveryConflict()

    const sessions = await client.query('SELECT 1 FROM user_sessions WHERE user_id = $1 LIMIT 1', [userId])
    if (sessions.rows.length) throw new ManualDeliveryConflict()
    const email: string = user.email.trim()
    const aliases = isAuthLoginAliasCutoverEnabled()
    if (aliases && !await hasActiveAdminWithPasswordAlias(client)) throw new ManualDeliveryConflict()
    const matches = aliases
      ? await client.query('SELECT user_id AS id FROM user_login_aliases WHERE normalized_value = $1 LIMIT 2',
        [normalizeLoginIdentifier(email)])
      : await client.query(
        `SELECT id FROM users WHERE lower(email) = $1 OR lower(username) = $1
           OR regexp_replace(mobile, '\\s+', '', 'g') = $2 LIMIT 2`, [email.toLowerCase(), email.replace(/\s+/g, '')],
      )
    if (matches.rows.length !== 1 || matches.rows[0].id !== userId) throw new ManualDeliveryConflict()

    let temporaryPassword: string
    do {
      temporaryPassword = `Tmp-${randomBytes(18).toString('base64url')}9A`
    } while (!validatePassword(temporaryPassword).valid)
    const hash = await bcrypt.hash(temporaryPassword, getBcryptSaltRounds())
    const delivered = await client.query(
      `UPDATE user_invites SET status = 'manual_delivery', updated_at = NOW()
       WHERE id = $1 AND status = 'pending' RETURNING id`, [inviteId],
    )
    if (!delivered.rows[0]) throw new ManualDeliveryConflict()
    const changed = await client.query(
      `UPDATE users SET password_hash = $2, must_change_password = TRUE,
         access_generation = access_generation + 1, updated_at = NOW() WHERE id = $1 RETURNING id`, [userId, hash],
    )
    if (!changed.rows[0]) throw new ManualDeliveryConflict()
    const audit = await client.query(
      `INSERT INTO audit_logs (event_type, event_category, resource_type, resource_id, action, action_details, created_at)
       VALUES ('UPDATE', 'USER', 'user-invite', $1, 'manual_delivery', jsonb_build_object('adminUserId', $2::text), clock_timestamp())
       RETURNING id`, [inviteId, actorId],
    )
    if (!audit.rows[0]) throw new Error('INVITE_AUDIT_FAILED')
    return { loginIdentifier: user.email as string, temporaryPassword }
  })
}
