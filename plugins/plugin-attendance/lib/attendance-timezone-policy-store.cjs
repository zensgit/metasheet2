'use strict'

// D1 persistence only. Trusted server adapters supply query/transaction and an
// explicit org-scoped management authorizer; this module is not an HTTP gate.
class AttendanceTimezonePolicyError extends Error {
  constructor(code, status) {
    super(code)
    this.name = 'AttendanceTimezonePolicyError'
    this.code = code
    this.status = status
  }
}

function fail(code, status = 422) {
  throw new AttendanceTimezonePolicyError('ATTENDANCE_TIMEZONE_' + code, status)
}
function identifier(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()) fail('INVALID_REFERENCE')
}
function version(value, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) fail('INVALID_REVISION')
}
function instant(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('INVALID_INSTANT')
}
function zone(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()) fail('INVALID_ZONE')
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0))
  } catch (_error) { fail('INVALID_ZONE') }
}
function policy(row) {
  if (!row) return { enabled: false, version: 0 }
  if (typeof row.enabled !== 'boolean') fail('INVALID_ENABLED')
  version(row.version)
  return { enabled: row.enabled, version: row.version }
}
function override(row, orgId, userId) {
  zone(row.timezone)
  version(row.version)
  identifier(row.id)
  instant(row.effective_from)
  if (row.effective_to !== null) instant(row.effective_to)
  if (row.effective_to && row.effective_to <= row.effective_from) fail('INVALID_INTERVAL')
  return {
    orgId, userId, referenceId: row.id, timezone: row.timezone, version: row.version,
    effectiveFrom: row.effective_from, effectiveTo: row.effective_to,
  }
}
async function protect(work) {
  try { return await work() } catch (error) {
    if (error instanceof AttendanceTimezonePolicyError) throw error
    if (['ATTENDANCE_TRIP_PARTIAL_SHIFT','ATTENDANCE_TRIP_STARTED_SHIFT_CHANGED','ATTENDANCE_TRIP_WORK_DATE_CONTEXT_CONFLICT'].includes(error?.code)) {
      throw new AttendanceTimezonePolicyError(error.code,409)
    }
    if (error && error.code === '23503') fail('MEMBER_REQUIRED', 403)
    if (error && ['23P01', '23505', '40001', '40P01'].includes(error.code)) fail('CONFIG_CONFLICT', 409)
    if (error && error.code === '23514') fail('INVALID_CONFIGURATION')
    fail('STORE_UNAVAILABLE', 503)
  }
}

// Canonical D2 writes must take this same lock before policy/member/target locks.
// JSON tuple encoding is unambiguous even for org identifiers containing ':'.
function attendanceTimezoneOrgLockKey(orgId) {
  identifier(orgId)
  return JSON.stringify(['attendance-timezone-policy-v1', orgId])
}
async function lockAttendanceTimezoneOrg(query, orgId) {
  await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [attendanceTimezoneOrgLockKey(orgId)])
}

function createAttendanceTimezonePolicyStore({ query, transaction, authorizeManage, prepareTripSourceChange }) {
  if (![query, transaction, authorizeManage].every(item => typeof item === 'function')) {
    fail('INVALID_ADAPTER')
  }
  async function rows(q, text, values) {
    const result = await q(text, values)
    if (!result || !Array.isArray(result.rows)) fail('STORE_UNAVAILABLE', 503)
    return result.rows
  }
  async function member(q, orgId, userId, lock = false) {
    const found = await rows(q,
      'SELECT u.id FROM users u JOIN user_orgs uo ON uo.user_id = u.id '
      + 'WHERE u.id = $1 AND uo.org_id = $2 AND u.is_active = true AND uo.is_active = true'
      + (lock ? ' FOR UPDATE OF u, uo' : ''), [userId, orgId])
    if (found.length !== 1) fail('MEMBER_REQUIRED', 403)
  }
  async function readPolicyWith(q, orgId, lock = false) {
    const found = await rows(q, 'SELECT enabled, version FROM attendance_timezone_policies WHERE org_id = $1'
      + (lock ? ' FOR UPDATE' : ''), [orgId])
    if (found.length > 1) fail('MULTIPLE_POLICIES', 409)
    return policy(found[0])
  }
  async function audit(q, orgId, actorId, action, referenceId, revision) {
    await q('INSERT INTO attendance_timezone_policy_audit (org_id, actor_id, action, reference_id, version) '
      + 'VALUES ($1, $2, $3, $4, $5)', [orgId, actorId, action, referenceId, revision])
  }
  async function write(input, work) {
    identifier(input.orgId)
    identifier(input.actorId)
    return protect(() => transaction(async q => {
      await lockAttendanceTimezoneOrg(q, input.orgId)
      if (await authorizeManage({ orgId: input.orgId, actorId: input.actorId, query: q }) !== true) {
        fail('FORBIDDEN', 403)
      }
      let verifyTripChange = async () => {}
      if (typeof prepareTripSourceChange === 'function') {
        verifyTripChange = await prepareTripSourceChange({query:q,orgId:input.orgId,userIds:input.userId ? [input.userId] : null})
        if (typeof verifyTripChange !== 'function') fail('TRIP_GUARD_UNAVAILABLE',503)
      } else {
        // D1-only schema installations have no trip authority yet. Once D3 is
        // present an affected trip requires the trusted runtime boundary reader.
        const schema = await rows(q,"SELECT to_regclass('attendance_business_trip_arrangements') IS NOT NULL AS present",[])
        if (schema.length !== 1 || typeof schema[0].present !== 'boolean') fail('STORE_UNAVAILABLE',503)
        if (schema[0].present === true) {
          const trips = await rows(q,`SELECT request_id FROM attendance_business_trip_arrangements
            WHERE org_id=$1 AND effective_end_at > now() AND start_at < effective_end_at
            AND ($2::text[] IS NULL OR user_id::text=ANY($2::text[])) LIMIT 1`,
          [input.orgId,input.userId ? [input.userId] : null])
          if (trips.length) fail('TRIP_GUARD_UNAVAILABLE',503)
        }
      }
      await member(q, input.orgId, input.actorId, true)
      const result = await work(q)
      await verifyTripChange()
      return result
    }))
  }
  return {
    readPolicy({ orgId }) {
      identifier(orgId)
      return protect(() => readPolicyWith(query, orgId))
    },
    readDefault({ orgId }) {
      identifier(orgId)
      return protect(async () => {
        const found = await rows(query,
          'SELECT id, timezone, timezone_version FROM attendance_rules WHERE org_id = $1 AND is_default = true',
          [orgId])
        if (!found.length) fail('DEFAULT_REQUIRED')
        if (found.length > 1) fail('MULTIPLE_DEFAULTS', 409)
        const row = found[0]
        identifier(row.id)
        zone(row.timezone)
        version(row.timezone_version)
        return { orgId, referenceId: row.id, timezone: row.timezone, version: row.timezone_version }
      })
    },
    readEmployeeOverride({ orgId, userId, at }) {
      identifier(orgId)
      identifier(userId)
      instant(at)
      return protect(async () => {
        await member(query, orgId, userId)
        const found = await rows(query,
          'SELECT id, timezone, version, effective_from, effective_to FROM attendance_employee_timezone_overrides '
          + 'WHERE org_id = $1 AND user_id = $2 AND effective_from <= $3 '
          + 'AND (effective_to IS NULL OR $3 < effective_to)', [orgId, userId, at])
        if (found.length > 1) fail('MULTIPLE_EMPLOYEE_OVERRIDES', 409)
        return found.length ? override(found[0], orgId, userId) : null
      })
    },
    setPolicy(input) {
      if (typeof input.enabled !== 'boolean') fail('INVALID_ENABLED')
      version(input.expectedVersion, true)
      return write(input, async q => {
        const current = await readPolicyWith(q, input.orgId, true)
        if (current.version !== input.expectedVersion) fail('CONFIG_CHANGED', 409)
        const found = await rows(q,
          'INSERT INTO attendance_timezone_policies (org_id, enabled, version, updated_by) VALUES ($1, $2, 1, $3) '
          + 'ON CONFLICT (org_id) DO UPDATE SET enabled = EXCLUDED.enabled, version = attendance_timezone_policies.version + 1, '
          + 'updated_by = EXCLUDED.updated_by, updated_at = now() WHERE attendance_timezone_policies.version = $4 '
          + 'RETURNING enabled, version', [input.orgId, input.enabled, input.actorId, input.expectedVersion])
        if (found.length !== 1) fail('CONFIG_CHANGED', 409)
        const result = policy(found[0])
        await audit(q, input.orgId, input.actorId, 'policy_set', input.orgId, result.version)
        return result
      })
    },
    createEmployeeOverride(input) {
      identifier(input.userId)
      zone(input.timezone)
      instant(input.effectiveFrom)
      if (input.effectiveTo !== null) instant(input.effectiveTo)
      if (input.effectiveTo && input.effectiveTo <= input.effectiveFrom) fail('INVALID_INTERVAL')
      version(input.expectedPolicyVersion, true)
      return write(input, async q => {
        const current = await readPolicyWith(q, input.orgId, true)
        if (current.version !== input.expectedPolicyVersion) fail('CONFIG_CHANGED', 409)
        await member(q, input.orgId, input.userId, true)
        const found = await rows(q,
          'INSERT INTO attendance_employee_timezone_overrides '
          + '(org_id, user_id, timezone, effective_from, effective_to, created_by, updated_by) '
          + 'VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id, timezone, version, effective_from, effective_to',
          [input.orgId, input.userId, input.timezone, input.effectiveFrom, input.effectiveTo, input.actorId])
        const result = override(found[0], input.orgId, input.userId)
        await audit(q, input.orgId, input.actorId, 'override_created', result.referenceId, result.version)
        return result
      })
    },
    closeEmployeeOverride(input) {
      identifier(input.userId)
      identifier(input.referenceId)
      instant(input.endAt)
      version(input.expectedVersion)
      return write(input, async q => {
        await readPolicyWith(q, input.orgId, true)
        await member(q, input.orgId, input.userId, true)
        const found = await rows(q,
          'SELECT id, timezone, version, effective_from, effective_to FROM attendance_employee_timezone_overrides '
          + 'WHERE id = $1 AND org_id = $2 AND user_id = $3 FOR UPDATE',
          [input.referenceId, input.orgId, input.userId])
        if (found.length !== 1) fail('OVERRIDE_REQUIRED', 404)
        const current = override(found[0], input.orgId, input.userId)
        if (current.version !== input.expectedVersion) fail('CONFIG_CHANGED', 409)
        if (input.endAt <= current.effectiveFrom
          || (current.effectiveTo && input.endAt > current.effectiveTo)) fail('INVALID_INTERVAL')
        const updated = await rows(q,
          'UPDATE attendance_employee_timezone_overrides SET effective_to = $1, version = version + 1, '
          + 'updated_by = $2, updated_at = now() WHERE id = $3 AND org_id = $4 AND user_id = $5 AND version = $6 '
          + 'RETURNING id, timezone, version, effective_from, effective_to',
          [input.endAt, input.actorId, input.referenceId, input.orgId, input.userId, input.expectedVersion])
        if (updated.length !== 1) fail('CONFIG_CHANGED', 409)
        const result = override(updated[0], input.orgId, input.userId)
        await audit(q, input.orgId, input.actorId, 'override_closed', result.referenceId, result.version)
        return result
      })
    },
  }
}

module.exports = {
  AttendanceTimezonePolicyError,
  attendanceTimezoneOrgLockKey,
  lockAttendanceTimezoneOrg,
  createAttendanceTimezonePolicyStore,
}
