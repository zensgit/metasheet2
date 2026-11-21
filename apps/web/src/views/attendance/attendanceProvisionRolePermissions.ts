/**
 * Legacy global fallback permission lists for the mounted AttendanceView.
 * Used only when a platform administrator hits an unavailable (404)
 * attendance-admin role assign or unassign endpoint. Modern assign still
 * sends the template id and lets the server apply ATTENDANCE_ROLE_TEMPLATES.
 *
 * One list for every active fallback path. Permissions match
 * packages/core-backend/src/routes/attendance-admin.ts
 * ATTENDANCE_ROLE_TEMPLATES.
 */
export const ATTENDANCE_PROVISION_ROLES = ['employee', 'approver', 'importer', 'admin'] as const

export type AttendanceProvisionRole = (typeof ATTENDANCE_PROVISION_ROLES)[number]

export const ATTENDANCE_PROVISION_ROLE_PERMISSIONS: Record<AttendanceProvisionRole, readonly string[]> = {
  employee: ['attendance:read', 'attendance:write'],
  approver: ['attendance:read', 'attendance:approve'],
  importer: ['attendance:read', 'attendance:import'],
  admin: ['attendance:read', 'attendance:write', 'attendance:approve', 'attendance:import', 'attendance:admin'],
}
