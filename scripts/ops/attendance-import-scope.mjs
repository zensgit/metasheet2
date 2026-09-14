// Rollback is session-scoped, unlike import reads which accept an explicit orgId.
export function requireImportSessionOrg(body, expectedOrgId) {
  const user = body?.data?.user
  const tenantId = typeof user?.tenantId === 'string' ? user.tenantId.trim() : null
  const raw = user?.orgId ?? user?.workspaceId ?? tenantId
  const orgId = typeof raw === 'string' && raw.trim()
    ? raw
    : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : null
  if (body?.success !== true || !orgId || (expectedOrgId !== undefined && orgId !== expectedOrgId)) {
    throw new Error('ATTENDANCE_IMPORT_SESSION_ORG_MISMATCH')
  }
  return orgId
}
