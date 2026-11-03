'use strict'

const { AttendanceTimezonePolicyError } = require('./attendance-timezone-policy-store.cjs')

function registerAttendanceTimezoneTargetRoutes({
  addRoute, withPermission, resolveActor, db, authorizeManage, readTargetTimezoneContext, HttpError,
}) {
  function fail(code, status = 400) { throw new AttendanceTimezonePolicyError(code, status) }
  async function read(req, res, employee) {
    const actor = resolveActor(req, res)
    if (!actor) return
    try {
      const query = req.query
      if (!query || typeof query !== 'object' || Array.isArray(query)
        || Object.keys(query).length !== 1 || typeof query.workDate !== 'string'
        || !/^\d{4}-\d{2}-\d{2}$/.test(query.workDate)) {
        fail('ATTENDANCE_TIMEZONE_TARGET_INVALID')
      }
      const midnight = new Date(query.workDate + 'T00:00:00.000Z')
      if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== query.workDate) {
        fail('ATTENDANCE_TIMEZONE_TARGET_INVALID')
      }
      const userId = employee ? req.params.userId : actor.userId
      if (typeof userId !== 'string' || !userId) fail('ATTENDANCE_TIMEZONE_TARGET_INVALID')
      if (typeof readTargetTimezoneContext !== 'function'
        || (employee && typeof authorizeManage !== 'function')) {
        fail('ATTENDANCE_TIMEZONE_RUNTIME_UNAVAILABLE', 503)
      }
      const data = await db.transaction(async trx => {
        const members = await trx.query(
          'SELECT u.id FROM users u JOIN user_orgs uo ON uo.user_id=u.id '
            + 'WHERE u.id=$1 AND uo.org_id=$2 AND u.is_active=true AND uo.is_active=true',
          [actor.userId, actor.orgId],
        )
        if (members.length !== 1) fail('ATTENDANCE_TIMEZONE_MEMBER_REQUIRED', 403)
        if (employee && await authorizeManage({
          trx, query: async (text, values) => ({ rows: await trx.query(text, values) }),
          orgId: actor.orgId, actorId: actor.userId,
        }) !== true) {
          fail('ATTENDANCE_TIMEZONE_PERMISSION_DENIED', 403)
        }
        const target = await readTargetTimezoneContext(trx, { orgId: actor.orgId, userId, workDate: query.workDate })
        if (!target || target.orgId !== actor.orgId || target.userId !== userId
          || target.workDate !== query.workDate || typeof target.timezone !== 'string'
          || typeof target.contextFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(target.contextFingerprint)
          || typeof target.frozen !== 'boolean' || typeof target.isWorkingDay !== 'boolean'
          || !(target.referenceId === null || typeof target.referenceId === 'string')
          || !target.rule || typeof target.rule !== 'object' || Array.isArray(target.rule)
          || !(target.provenance === null || (typeof target.provenance === 'object' && !Array.isArray(target.provenance)))) {
          fail('ATTENDANCE_TIMEZONE_TARGET_UNAVAILABLE', 503)
        }
        try { new Intl.DateTimeFormat('en-US', { timeZone: target.timezone }) } catch {
          fail('ATTENDANCE_TIMEZONE_TARGET_UNAVAILABLE', 503)
        }
        const startAt = target.window?.startAt
        const endAt = target.window?.endAt
        if (!(startAt instanceof Date) || !(endAt instanceof Date)
          || !Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) || endAt <= startAt) {
          fail('ATTENDANCE_TIMEZONE_TARGET_UNAVAILABLE', 503)
        }
        return {
          orgId: actor.orgId, userId, workDate: target.workDate, timezone: target.timezone,
          contextFingerprint: target.contextFingerprint, frozen: target.frozen,
          referenceId: target.referenceId, provenance: target.provenance,
          window: { startAt: startAt.toISOString(), endAt: endAt.toISOString() },
          rule: target.rule, isWorkingDay: target.isWorkingDay,
        }
      })
      res.json({ ok: true, data })
    } catch (error) {
      const known = error instanceof AttendanceTimezonePolicyError
        || (typeof HttpError === 'function' && error instanceof HttpError
          && /^[A-Z][A-Z0-9_]{1,95}$/.test(error.code)
          && [400, 403, 409, 422, 503].includes(error.status))
      res.status(known ? error.status : 503).json({ ok: false,
        error: { code: known ? error.code : 'ATTENDANCE_TIMEZONE_TARGET_UNAVAILABLE' } })
    }
  }

  addRoute('GET', '/api/attendance/timezone-context/me',
    withPermission('attendance:read', (req, res) => read(req, res, false)))
  addRoute('GET', '/api/attendance/timezone-context/employees/:userId',
    withPermission('attendance:admin', (req, res) => read(req, res, true)))
}

module.exports = { registerAttendanceTimezoneTargetRoutes }
