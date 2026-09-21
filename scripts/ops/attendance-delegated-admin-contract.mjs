export class AttendanceDelegatedAdminContractError extends Error {
  constructor(code) {
    super(code)
    this.name = 'AttendanceDelegatedAdminContractError'
    this.code = code
  }
}

export function assertDelegatedAttendanceAdminIdentity({ user, features, expectedTenantId }) {
  const role = String(user?.role || '').trim().toLowerCase()
  const permissions = Array.isArray(user?.permissions) ? user.permissions : []
  const tenantId = String(user?.tenantId || '').trim()

  if (!expectedTenantId || tenantId !== expectedTenantId) {
    throw new AttendanceDelegatedAdminContractError('DELEGATED_ADMIN_TENANT_MISMATCH')
  }
  if (role === 'admin') {
    throw new AttendanceDelegatedAdminContractError('PLATFORM_ADMIN_NOT_ALLOWED')
  }
  if (!permissions.includes('attendance:admin')) {
    throw new AttendanceDelegatedAdminContractError('DELEGATED_ATTENDANCE_ADMIN_REQUIRED')
  }
  if (features?.attendanceAdmin !== true) {
    throw new AttendanceDelegatedAdminContractError('ATTENDANCE_ADMIN_FEATURE_REQUIRED')
  }
}
