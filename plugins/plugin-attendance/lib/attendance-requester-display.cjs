'use strict'

const UNKNOWN_USER = 'Unknown user'

function displayName(value) {
  return typeof value === 'string' && value.trim() ? value : UNKNOWN_USER
}

// A genuine name may equal the ID; an email used as an ID fallback is not a label.
function profileName(profile, userId) {
  if (typeof profile?.name === 'string' && profile.name.trim()) return profile.name
  if (typeof profile?.email === 'string' && profile.email.trim() && profile.email !== userId) return profile.email
  return UNKNOWN_USER
}

async function query(client, sql, parameters) {
  try {
    return await client.query(sql, parameters)
  } catch (original) {
    const error = new Error('ATTENDANCE_REQUESTER_DISPLAY_READ_FAILED')
    // Preserve the existing transaction runner's serialization/deadlock retry.
    if (original?.code === '40001' || original?.code === '40P01') error.code = original.code
    throw error
  }
}

async function forCreate(client, { userId, orgId, actorId, actorName }) {
  if (userId === actorId) return displayName(actorName)
  // Original authorization precedes this read; never display a foreign profile.
  const rows = await query(client,
    `SELECT u.name, u.email FROM users u
       JOIN user_orgs o ON o.user_id = u.id
      WHERE u.id = $1 AND o.org_id = $2 AND o.is_active = true
      LIMIT 1`, [userId, orgId])
  return displayName(profileName(rows[0], userId))
}

function contradicts(value, expected) {
  return typeof value === 'string' && value.trim() && value !== expected
}

async function forPendingEdit(client, input) {
  if (!input.approvalId) return forCreate(client, input)
  const rows = await query(client,
    'SELECT requester_snapshot, org_id FROM approval_instances WHERE id = $1',
    [input.approvalId])
  if (!rows.length) return forCreate(client, input)
  const row = rows[0]
  const snapshot = row.requester_snapshot
  // A malformed old snapshot is not an absent approval: neutralize only its name.
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
      || contradicts(snapshot.id, input.userId)
      || (input.orgId && (contradicts(snapshot.orgId, input.orgId) || contradicts(row.org_id, input.orgId)))) {
    return UNKNOWN_USER
  }
  return displayName(snapshot.name)
}

module.exports = { displayName, profileName, forCreate, forPendingEdit }
