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

export async function markInviteAccepted(inviteToken: string, options: {
  consumedBy: string
}): Promise<InviteLedgerEntry | null> {
  try {
    const result = await query<InviteLedgerRow>(
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
    const row = result.rows[0]
    return row ? mapInviteLedgerRow(row) : null
  } catch (error) {
    if (isDatabaseSchemaError(error)) return null
    throw error
  }
}
