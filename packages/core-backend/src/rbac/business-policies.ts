/** A policy names one actual JWT-protected route and its guard layer, not its handler outcome. */
export const BUSINESS_GUARD_POLICIES = {
  'attendance.decision-trace': {
    method: 'GET', path: '/api/attendance/decision-trace', mode: 'single', permissions: ['attendance:read'],
  },
  'approval-templates.list': {
    method: 'GET', path: '/api/approval-templates', mode: 'single', permissions: ['approvals:read'],
  },
  'approval-templates.directory.roles': {
    method: 'GET', path: '/api/approval-templates/directory/roles', mode: 'any',
    permissions: ['approval-templates:manage', 'approvals:admin-templates'],
  },
} as const

export function findBusinessGuardPolicy(id: string) {
  return Object.prototype.hasOwnProperty.call(BUSINESS_GUARD_POLICIES, id)
    ? BUSINESS_GUARD_POLICIES[id as keyof typeof BUSINESS_GUARD_POLICIES]
    : undefined
}

/** These routes have no static RBAC code guard. They are resource policies in their own right. */
export const BUSINESS_RESOURCE_POLICIES = {
  'multitable.context.sheet': { method: 'GET', path: '/api/multitable/context', resource: 'sheet' },
  'multitable.context.view-access': { method: 'GET', path: '/api/multitable/context', resource: 'view' },
  'multitable.record.field-read': { method: 'GET', path: '/api/multitable/records/:recordId', resource: 'field' },
  'multitable.record.read': { method: 'GET', path: '/api/multitable/records/:recordId', resource: 'record' },
} as const

export function findBusinessResourcePolicy(id: string) {
  return Object.prototype.hasOwnProperty.call(BUSINESS_RESOURCE_POLICIES, id)
    ? BUSINESS_RESOURCE_POLICIES[id as keyof typeof BUSINESS_RESOURCE_POLICIES]
    : undefined
}
