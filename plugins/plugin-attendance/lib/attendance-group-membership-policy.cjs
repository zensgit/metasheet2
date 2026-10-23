'use strict'

class AttendanceGroupMembershipPolicyError extends Error {
  constructor(code, status) {
    super(code)
    this.name = 'AttendanceGroupMembershipPolicyError'
    this.code = code
    this.status = status
  }
}
function fail(code, status) { throw new AttendanceGroupMembershipPolicyError(code, status) }
async function rows(trx, sql, values) {
  const result = await trx.query(sql, values)
  return Array.isArray(result) ? result : result.rows
}
function orgLockKey(orgId) { return JSON.stringify(['attendance-timezone-policy-v1', orgId]) }
async function lockOrg(trx, orgId) {
  await rows(trx, 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [orgLockKey(orgId)])
}
function policy(orgId, row) {
  if (!row) return { orgId, allowMultipleGroups: false, version: 0 }
  if (typeof row.allow_multiple_groups !== 'boolean' || !Number.isSafeInteger(row.version) || row.version < 0) {
    fail('ATTENDANCE_GROUP_MEMBERSHIP_POLICY_UNAVAILABLE', 503)
  }
  return { orgId, allowMultipleGroups: row.allow_multiple_groups, version: row.version }
}
async function readPolicy(trx, orgId) {
  const result = await rows(trx,
    'SELECT allow_multiple_groups, version FROM attendance_management_group_policies WHERE org_id = $1', [orgId])
  return policy(orgId, result[0])
}
// The no-op row write is also a SERIALIZABLE snapshot fence. Advisory locks alone
// cannot stop a transaction whose snapshot predates a committed policy transition.
async function lockPolicy(trx, orgId) {
  await lockOrg(trx, orgId)
  const result = await rows(trx, `
    INSERT INTO attendance_management_group_policies (org_id, allow_multiple_groups, version)
    VALUES ($1, false, 0)
    ON CONFLICT (org_id) DO UPDATE SET org_id = EXCLUDED.org_id
    RETURNING allow_multiple_groups, version`, [orgId])
  if (result.length !== 1) fail('ATTENDANCE_GROUP_MEMBERSHIP_POLICY_UNAVAILABLE', 503)
  return policy(orgId, result[0])
}
function parsePolicyInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 2
    || !Object.hasOwn(body, 'allowMultipleGroups') || !Object.hasOwn(body, 'expectedVersion')
    || typeof body.allowMultipleGroups !== 'boolean'
    || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) {
    fail('ATTENDANCE_GROUP_MEMBERSHIP_POLICY_INVALID_INPUT', 400)
  }
  return body
}
async function setPolicy(trx, orgId, input) {
  parsePolicyInput(input)
  const current = await lockPolicy(trx, orgId)
  if (current.version !== input.expectedVersion) fail('ATTENDANCE_GROUP_MEMBERSHIP_POLICY_VERSION_CONFLICT', 409)
  if (current.allowMultipleGroups === input.allowMultipleGroups) return current
  if (current.version === Number.MAX_SAFE_INTEGER) fail('ATTENDANCE_GROUP_MEMBERSHIP_POLICY_UNAVAILABLE', 503)
  const result = await rows(trx, `
    UPDATE attendance_management_group_policies
       SET allow_multiple_groups = $2, version = version + 1, updated_at = now()
     WHERE org_id = $1 RETURNING allow_multiple_groups, version`, [orgId, input.allowMultipleGroups])
  return policy(orgId, result[0])
}

// All production writers validate group IDs as UUIDs. PostgreSQL UUID equality
// is case-insensitive; user_id is text and must retain its exact casing.
function groupKey(groupId) { return groupId.toLowerCase() }
function assignmentKey(orgId, members) {
  return JSON.stringify([orgId, members.map(member => [member.userId, groupKey(member.groupId)]).sort()])
}
const preparedAdmissions = new WeakMap()
async function assertCanAddMembers(trx, orgId, members) {
  if (!members.length) return
  const current = await lockPolicy(trx, orgId)
  const userIds = [...new Set(members.map(member => member.userId))].sort()
  for (const userId of userIds) {
    await rows(trx, 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [JSON.stringify(['attendance-management-group-member-v1', orgId, userId])])
  }
  // Read all memberships for each subject, including legacy multiple rows.
  const existing = await rows(trx,
    'SELECT group_id::text AS group_id, user_id FROM attendance_group_members WHERE org_id = $1 AND user_id = ANY($2::text[])',
    [orgId, userIds])
  if (!current.allowMultipleGroups) {
    const groupsByUser = new Map(userIds.map(userId => [userId, new Set()]))
    for (const row of existing) groupsByUser.get(row.user_id)?.add(groupKey(row.group_id))
    // Check the entire proposed batch before the first member INSERT.
    for (const member of members) {
      const groups = groupsByUser.get(member.userId)
      const groupId = groupKey(member.groupId)
      if (groups.has(groupId)) continue
      if (groups.size > 0) fail('ATTENDANCE_MULTIPLE_GROUPS_DISABLED', 409)
      groups.add(groupId)
    }
  }
}
async function prepareAdmission(trx, orgId, members) {
  if (!members.length) return
  await assertCanAddMembers(trx, orgId, members)
  const transaction = await rows(trx, 'SELECT txid_current()::text AS transaction_id', [])
  const transactionId = transaction[0]?.transaction_id
  if (typeof transactionId !== 'string') fail('ATTENDANCE_GROUP_MEMBERSHIP_TRANSACTION_REQUIRED', 503)
  preparedAdmissions.set(trx, { key: assignmentKey(orgId, members), transactionId })
}
// Immutable effect phase verifies a precondition capability, never rereads policy.
async function requireAdmission(trx, orgId, members) {
  if (!members.length) return
  const prepared = preparedAdmissions.get(trx)
  const transaction = await rows(trx, 'SELECT txid_current()::text AS transaction_id', [])
  if (!prepared || prepared.key !== assignmentKey(orgId, members)
    || prepared.transactionId !== transaction[0]?.transaction_id) {
    fail('ATTENDANCE_GROUP_MEMBERSHIP_PRECONDITION_REQUIRED', 409)
  }
}

function registerGroupMembershipPolicyRoutes({ addRoute, withPermission, resolveActor, db, authorizeManage }) {
  for (const method of ['GET', 'POST']) {
    addRoute(method, '/api/attendance/group-membership-policy', withPermission('attendance:admin', async (req, res) => {
      const actor = resolveActor(req, res)
      if (!actor) return
      try {
        const input = method === 'POST' ? parsePolicyInput(req.body) : null
        const data = await db.transaction(async trx => {
          const query = async (sql, values) => ({ rows: await rows(trx, sql, values) })
          if (await authorizeManage({ query, orgId: actor.orgId, actorId: actor.userId }) !== true) {
            fail('ATTENDANCE_GROUP_MEMBERSHIP_POLICY_FORBIDDEN', 403)
          }
          return input ? setPolicy(trx, actor.orgId, input) : readPolicy(trx, actor.orgId)
        })
        res.json({ ok: true, data })
      } catch (error) {
        const known = error instanceof AttendanceGroupMembershipPolicyError
        res.status(known ? error.status : 503).json({ ok: false, error: {
          code: known ? error.code : 'ATTENDANCE_GROUP_MEMBERSHIP_POLICY_UNAVAILABLE',
        } })
      }
    }))
  }
}

module.exports = {
  AttendanceGroupMembershipPolicyError, orgLockKey, lockOrg, readPolicy, setPolicy, parsePolicyInput,
  assertCanAddMembers, prepareAdmission, requireAdmission, registerGroupMembershipPolicyRoutes,
}
