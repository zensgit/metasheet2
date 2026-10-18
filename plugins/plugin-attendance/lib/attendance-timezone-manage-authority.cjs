'use strict'

// Match the existing attendance DB permission semantics inside the write transaction.
// Token role claims, users.is_admin alone and RBAC_BYPASS are not grants here.
async function authorizeAttendanceTimezoneManage({ query, orgId, actorId }) {
  const result = await query(`SELECT (
      EXISTS(SELECT 1 FROM user_roles WHERE user_id=u.id AND role_id='admin') OR
      EXISTS(SELECT 1 FROM user_permissions WHERE user_id=u.id AND permission_code='attendance:admin') OR
      EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id
        WHERE ur.user_id=u.id AND rp.permission_code='attendance:admin')
    ) AS allowed
    FROM users u JOIN user_orgs uo ON uo.user_id=u.id
    WHERE u.id=$1 AND uo.org_id=$2 AND u.is_active=true AND uo.is_active=true`,[actorId,orgId])
  if (!result || !Array.isArray(result.rows)) throw new Error('ATTENDANCE_TIMEZONE_STORE_UNAVAILABLE')
  return result.rows.length === 1 && result.rows[0].allowed === true
}

module.exports = { authorizeAttendanceTimezoneManage }
