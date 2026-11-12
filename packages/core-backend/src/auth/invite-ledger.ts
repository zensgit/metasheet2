import { query } from '../db/pg'
import { isDatabaseSchemaError } from '../utils/database-errors'

export type InviteLedgerStatus = 'pending' | 'accepted' | 'revoked' | 'expired'
export type InviteLedgerProductMode = 'platform' | 'attendance' | 'plm-workbench'

export interface InviteLedgerEntry {
  id: string
  userId: string
  email: string
  presetId: string | null
  productMode: InviteLedgerProductMode
  roleId: string | null
  invitedBy: string | null
  inviteToken: string
  status: InviteLedgerStatus
  acceptedAt: string | null
  consumedBy: string | null
  lastSentAt: string
  createdAt: string
  updatedAt: string
}

type InviteLedgerRow = {
  id: string
  user_id: string
  email: string
  preset_id: string | null
  product_mode: InviteLedgerProductMode
  role_id: string | null
  invited_by: string | null
  invite_token: string
  status: InviteLedgerStatus
  accepted_at: string | Date | null
  consumed_by: string | null
  last_sent_at: string | Date
  created_at: string | Date
  updated_at: string | Date
}

function normalizeTimestamp(value: string | Date | null): string | null {
  if (!value) return null
  return new Date(value).toISOString()
}

function mapInviteLedgerRow(row: InviteLedgerRow): InviteLedgerEntry {
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    presetId: row.preset_id,
    productMode: row.product_mode,
    roleId: row.role_id,
    invitedBy: row.invited_by,
    inviteToken: row.invite_token,
    status: row.status,
    acceptedAt: normalizeTimestamp(row.accepted_at),
    consumedBy: row.consumed_by,
    lastSentAt: normalizeTimestamp(row.last_sent_at) || new Date(0).toISOString(),
    createdAt: normalizeTimestamp(row.created_at) || new Date(0).toISOString(),
    updatedAt: normalizeTimestamp(row.updated_at) || new Date(0).toISOString(),
  }
}

export async function recordInvite(options: {
  userId: string
  email: string
  presetId?: string | null
  productMode: InviteLedgerProductMode
  roleId?: string | null
  invitedBy?: string | null
  inviteToken: string
}): Promise<InviteLedgerEntry | null> {
  try {
    const result = await query<InviteLedgerRow>(
      `INSERT INTO user_invites (
         user_id, email, preset_id, product_mode, role_id, invited_by, invite_token, status, accepted_at, consumed_by, last_sent_at, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NULL, NULL, NOW(), NOW(), NOW())
       RETURNING id, user_id, email, preset_id, product_mode, role_id, invited_by, invite_token, status, accepted_at, consumed_by, last_sent_at, created_at, updated_at`,
      [
        options.userId,
        options.email,
        options.presetId || null,
        options.productMode,
        options.roleId || null,
        options.invitedBy || null,
        options.inviteToken,
      ],
    )

    const row = result.rows[0]
    return row ? mapInviteLedgerRow(row) : null
  } catch (error) {
    if (isDatabaseSchemaError(error)) return null
    throw error
  }
}

export const INVITE_NOT_PENDING = 'INVITE_NOT_PENDING'

/**
 * Whether the ledger holds this exact token on a pending row. An invite token is usable only while
 * that is true: a revoked row, an accepted row, or a row whose token has been replaced by a later one
 * all answer false, and so does a ledger that cannot be read because its schema is missing.
 */
export async function isInviteTokenPending(inviteToken: string): Promise<boolean> {
  try {
    const result = await query<{ pending: boolean }>(
      `SELECT TRUE AS pending
       FROM user_invites
       WHERE invite_token = $1
         AND status = 'pending'
       LIMIT 1`,
      [inviteToken],
    )
    return result.rows.length > 0
  } catch (error) {
    if (isDatabaseSchemaError(error)) return false
    throw error
  }
}

export const INVITE_ACCOUNT_ALREADY_ONBOARDED = 'INVITE_ACCOUNT_ALREADY_ONBOARDED'
export const INVITE_RESEND_CONFLICT = 'INVITE_RESEND_CONFLICT'

/**
 * SQL condition: the account an invite row belongs to has completed its first sign-in. That is so
 * once the account has a recorded sign-in, or once any invite for it has been accepted. An account
 * in that state is not sent another invite.
 *
 * `inviteRow` is the name the enclosing statement gives the `user_invites` row (a fixed identifier
 * written at the call site, never request data). The read and the write of a resend both use this one
 * condition.
 */
export function inviteAccountOnboardedSql(inviteRow: 'inv' | 'user_invites'): string {
  return `(
    EXISTS (
      SELECT 1 FROM users onboarded_user
      WHERE onboarded_user.id = ${inviteRow}.user_id
        AND onboarded_user.last_login_at IS NOT NULL
    )
    OR EXISTS (
      SELECT 1 FROM user_invites accepted_invite
      WHERE accepted_invite.user_id = ${inviteRow}.user_id
        AND accepted_invite.status = 'accepted'
    )
  )`
}

type InviteLedgerQueryClient = {
  query: <T extends InviteLedgerRow = InviteLedgerRow>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: T[] }>
}

/**
 * Mark invite accepted. Pass `client` to run inside an open transaction
 * (e.g. invite/accept user UPDATE + ledger consume must commit together).
 */
export async function markInviteAccepted(inviteToken: string, options: {
  consumedBy: string
  client?: InviteLedgerQueryClient
}): Promise<InviteLedgerEntry | null> {
  try {
    const run = options.client
      ? options.client.query.bind(options.client)
      : query
    const result = await run(
      `UPDATE user_invites
       SET status = 'accepted',
           accepted_at = NOW(),
           consumed_by = $2,
           updated_at = NOW()
       WHERE invite_token = $1
         AND status = 'pending'
       RETURNING id, user_id, email, preset_id, product_mode, role_id, invited_by, invite_token, status, accepted_at, consumed_by, last_sent_at, created_at, updated_at`,
      [inviteToken, options.consumedBy],
    )
    const row = result.rows[0] as InviteLedgerRow | undefined
    return row ? mapInviteLedgerRow(row) : null
  } catch (error) {
    if (isDatabaseSchemaError(error)) return null
    throw error
  }
}
