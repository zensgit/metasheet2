'use strict'

const { AttendanceTimezonePolicyError, createAttendanceTimezonePolicyStore } = require('./attendance-timezone-policy-store.cjs')

function registerAttendanceTimezonePolicyRoutes({ addRoute, withPermission, resolveActor, db, authorizeManage, prepareTimezoneSourceChange, previewTimezonePolicyChange, HttpError }) {
  async function read(req, res, employee) {
    const actor = resolveActor(req, res)
    if (!actor) return
    try {
      const data = await db.transaction(async trx => {
        const query = async (text, values) => ({ rows: await trx.query(text, values) })
        const members = await query(
          'SELECT u.id FROM users u JOIN user_orgs uo ON uo.user_id = u.id '
            + 'WHERE u.id = $1 AND uo.org_id = $2 AND u.is_active = true AND uo.is_active = true',
          [actor.userId, actor.orgId],
        )
        if (members.rows.length !== 1) throw new AttendanceTimezonePolicyError('ATTENDANCE_TIMEZONE_MEMBER_REQUIRED', 403)
        const store = createAttendanceTimezonePolicyStore({
          query, transaction: work => work(query), authorizeManage: async () => false,
        })
        if (employee) {
          const override = await store.readEmployeeOverride({
            orgId: actor.orgId, userId: req.params.userId, at: new Date(),
          })
          return { override }
        }
        const policy = await store.readPolicy({ orgId: actor.orgId })
        const systemDefault = await store.readDefault({ orgId: actor.orgId })
        return { ...policy, systemDefault }
      })
      res.json({ ok: true, data })
    } catch (error) {
      const known = error instanceof AttendanceTimezonePolicyError
      res.status(known ? error.status : 503).json({
        ok: false,
        error: { code: known ? error.code : 'ATTENDANCE_TIMEZONE_STORE_UNAVAILABLE' },
      })
    }
  }

  function invalid() { throw new AttendanceTimezonePolicyError('ATTENDANCE_TIMEZONE_INVALID_INPUT', 400) }
  function fields(body, required) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || required.some(key => !Object.hasOwn(body, key))
      || Object.keys(body).some(key => !required.includes(key) && key !== 'businessEffectiveDate')) invalid()
    return body
  }
  function revision(value, zero = false) {
    if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) invalid()
    return value
  }
  function timestamp(value) {
    if (typeof value !== 'string') invalid()
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
    if (!match) invalid()
    const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
    const calendar = new Date(0)
    calendar.setUTCFullYear(year, month - 1, day)
    calendar.setUTCHours(hour, minute, second, 0)
    if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1
      || calendar.getUTCDate() !== day || calendar.getUTCHours() !== hour
      || calendar.getUTCMinutes() !== minute || calendar.getUTCSeconds() !== second) invalid()
    const date = new Date(value)
    if (!Number.isFinite(date.getTime())) invalid()
    return date
  }
  async function write(req, res, action) {
    const actor = resolveActor(req, res)
    if (!actor) return
    try {
      let input
      if (action === 'policy') {
        const body = fields(req.body, ['enabled', 'expectedVersion'])
        if (typeof body.enabled !== 'boolean') invalid()
        input = { enabled: body.enabled, expectedVersion: revision(body.expectedVersion, true) }
      } else if (action === 'create') {
        const body = fields(req.body, ['timezone', 'effectiveFrom', 'effectiveTo', 'expectedPolicyVersion'])
        input = { userId: req.params.userId, timezone: body.timezone,
          effectiveFrom: timestamp(body.effectiveFrom),
          effectiveTo: body.effectiveTo === null ? null : timestamp(body.effectiveTo),
          expectedPolicyVersion: revision(body.expectedPolicyVersion, true) }
      } else {
        const body = fields(req.body, ['endAt', 'expectedVersion'])
        input = { userId: req.params.userId, referenceId: req.params.referenceId,
          endAt: timestamp(body.endAt), expectedVersion: revision(body.expectedVersion) }
      }
      if (typeof authorizeManage !== 'function' || typeof prepareTimezoneSourceChange !== 'function') {
        throw new AttendanceTimezonePolicyError('ATTENDANCE_TIMEZONE_WRITE_GUARD_UNAVAILABLE', 503)
      }
      const data = await db.transaction(async trx => {
        const query = async (text, values) => ({ rows: await trx.query(text, values) })
        const store = createAttendanceTimezonePolicyStore({
          query, transaction: work => work(query),
          authorizeManage: async authorization => {
            if (await authorizeManage({ ...authorization, trx }) !== true) return false
            // Enablement needs a valid organization fallback; disabling remains
            // available when that default is missing or invalid.
            if (action === 'policy' && input.enabled === true) {
              await store.readDefault({ orgId: actor.orgId })
            }
            return true
          },
          prepareTripSourceChange: source => prepareTimezoneSourceChange({
            ...source, trx, businessEffectiveDate:req.body?.businessEffectiveDate,sourceActorId:actor.userId, mutation: action === 'policy'
              ? { kind: 'policy', enabled: input.enabled, expectedVersion: input.expectedVersion }
              : action === 'create'
                ? { kind: 'employee_override_create', ...input }
                : { kind: 'employee_override_close', ...input },
          }),
        })
        const owned = { ...input, orgId: actor.orgId, actorId: actor.userId }
        return action === 'policy' ? store.setPolicy(owned)
          : action === 'create' ? store.createEmployeeOverride(owned) : store.closeEmployeeOverride(owned)
      })
      res.status(action === 'create' ? 201 : 200).json({ ok: true, data })
    } catch (error) {
      const known = error instanceof AttendanceTimezonePolicyError
      res.status(known ? error.status : 503).json({ ok: false,
        error: { code: known ? error.code : 'ATTENDANCE_TIMEZONE_STORE_UNAVAILABLE' } })
    }
  }

  async function preview(req, res) {
    const actor = resolveActor(req, res)
    if (!actor) return
    try {
      const body = fields(req.body, ['enabled', 'expectedVersion'])
      if (typeof body.enabled !== 'boolean') invalid()
      const input = { enabled: body.enabled, expectedVersion: revision(body.expectedVersion, true) }
      if (typeof authorizeManage !== 'function' || typeof previewTimezonePolicyChange !== 'function') {
        throw new AttendanceTimezonePolicyError('ATTENDANCE_TIMEZONE_PREVIEW_UNAVAILABLE', 503)
      }
      const data = await db.transaction(async trx => {
        // Read-only mode also rejects accidental DML in a trusted preview port.
        await trx.query('SET TRANSACTION READ ONLY')
        const query = async (text, values) => ({ rows: await trx.query(text, values) })
        if (await authorizeManage({ query, trx, orgId: actor.orgId, actorId: actor.userId }) !== true) {
          throw new AttendanceTimezonePolicyError('ATTENDANCE_TIMEZONE_FORBIDDEN', 403)
        }
        const result = await previewTimezonePolicyChange(trx, { orgId: actor.orgId, ...input })
        const keys = ['currentVersion', 'proposedEnabled', 'evaluatedUsers', 'affectedUsers', 'conflictingUsers', 'conflictCounts']
        const counts = ['startedContext', 'tripContext', 'invalidTargetContext']
        if (!result || typeof result !== 'object' || Array.isArray(result)
          || Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))
          || result.currentVersion !== input.expectedVersion || result.proposedEnabled !== input.enabled
          || !Number.isSafeInteger(result.evaluatedUsers) || result.evaluatedUsers < 0
          || ['affectedUsers', 'conflictingUsers'].some(key => !Number.isSafeInteger(result[key])
            || result[key] < 0 || result[key] > result.evaluatedUsers)
          || !result.conflictCounts || typeof result.conflictCounts !== 'object' || Array.isArray(result.conflictCounts)
          || Object.keys(result.conflictCounts).length !== counts.length
          || counts.some(key => !Number.isSafeInteger(result.conflictCounts[key])
            || result.conflictCounts[key] < 0 || result.conflictCounts[key] > result.evaluatedUsers)
          || counts.reduce((sum, key) => sum + result.conflictCounts[key], 0) !== result.conflictingUsers) {
          throw new AttendanceTimezonePolicyError('ATTENDANCE_TIMEZONE_PREVIEW_UNAVAILABLE', 503)
        }
        return result
      })
      res.json({ ok: true, data })
    } catch (error) {
      const known = error instanceof AttendanceTimezonePolicyError
        || (typeof HttpError === 'function' && error instanceof HttpError
          && /^[A-Z][A-Z0-9_]{1,95}$/.test(error.code)
          && [400, 403, 409, 422, 503].includes(error.status))
      res.status(known ? error.status : 503).json({ ok: false,
        error: { code: known ? error.code : 'ATTENDANCE_TIMEZONE_PREVIEW_UNAVAILABLE' } })
    }
  }

  addRoute('GET', '/api/attendance/timezone-policy',
    withPermission('attendance:admin', (req, res) => read(req, res, false)))
  addRoute('GET', '/api/attendance/timezone-policy/employees/:userId',
    withPermission('attendance:admin', (req, res) => read(req, res, true)))
  addRoute('POST', '/api/attendance/timezone-policy/preview',
    withPermission('attendance:admin', preview))
  addRoute('PUT', '/api/attendance/timezone-policy',
    withPermission('attendance:admin', (req, res) => write(req, res, 'policy')))
  addRoute('POST', '/api/attendance/timezone-policy/employees/:userId',
    withPermission('attendance:admin', (req, res) => write(req, res, 'create')))
  addRoute('POST', '/api/attendance/timezone-policy/employees/:userId/:referenceId/close',
    withPermission('attendance:admin', (req, res) => write(req, res, 'close')))
}

module.exports = { registerAttendanceTimezonePolicyRoutes }
