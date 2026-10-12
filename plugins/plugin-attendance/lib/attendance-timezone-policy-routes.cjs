'use strict'

const { AttendanceTimezonePolicyError, createAttendanceTimezonePolicyStore } = require('./attendance-timezone-policy-store.cjs')

function registerAttendanceTimezonePolicyRoutes({ addRoute, withPermission, resolveActor, db }) {
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

  addRoute('GET', '/api/attendance/timezone-policy',
    withPermission('attendance:admin', (req, res) => read(req, res, false)))
  addRoute('GET', '/api/attendance/timezone-policy/employees/:userId',
    withPermission('attendance:admin', (req, res) => read(req, res, true)))
}

module.exports = { registerAttendanceTimezonePolicyRoutes }
