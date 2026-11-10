/**
 * Legacy global fallback permission lists used by AttendanceView when
 * `/api/attendance-admin/users/:id/roles/assign` is unavailable (404) for a
 * platform admin. Modern assign uses the server ATTENDANCE_ROLE_TEMPLATES.
 *
 * Keep `admin` aligned with packages/core-backend/src/routes/attendance-admin.ts
 * `ATTENDANCE_ROLE_TEMPLATES.admin.permissions`.
 */
export type AttendanceProvisionFallbackRole = 'employee' | 'approver' | 'admin'

export const ATTENDANCE_PROVISION_ROLE_PERMISSIONS: Record<AttendanceProvisionFallbackRole, readonly string[]> = {
  employee: ['attendance:read', 'attendance:write'],
  approver: ['attendance:read', 'attendance:approve'],
  admin: ['attendance:read', 'attendance:write', 'attendance:approve', 'attendance:import', 'attendance:admin'],
}
