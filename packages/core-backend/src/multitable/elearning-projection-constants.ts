import { createHash } from 'node:crypto'

export const ELEARNING_PROJECTION_SYSTEM_KIND = 'elearning_projection' as const
export const ELEARNING_STATS_MULTITABLE_SHEETS_TABLE =
  'elearning_stats_multitable_sheets' as const
export const ELEARNING_PROJECTION_SYSTEM_OWNER = 'system:elearning-projection' as const

const DENIED_KEYS = [
  'canCreateRecord',
  'canEditRecord',
  'canDeleteRecord',
  'canManageFields',
  'canManageSheetAccess',
  'canComment',
  'canManageAutomation',
  'canSendNotification',
] as const

function identityDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)
}

function normalizedOrgId(orgId: string): string {
  return orgId.trim()
}

export function deriveElearningProjectionBaseId(orgId: string): string {
  return `base_el_stats_${identityDigest(normalizedOrgId(orgId))}`
}

export function deriveElearningProjectionSheetId(orgId: string): string {
  return `sht_el_stats_${identityDigest(normalizedOrgId(orgId))}`
}

export function deriveElearningProjectionRecordId(
  orgId: string,
  departmentId: string,
  statsDate: string,
): string {
  return `rec_el_stats_${identityDigest([
    normalizedOrgId(orgId),
    departmentId.toLowerCase(),
    statsDate,
  ].join('\u0000'))}`
}

export function deriveElearningProjectionFieldId(orgId: string, key: string): string {
  return `fld_el_stats_${identityDigest(`${normalizedOrgId(orgId)}\u0000${key}`)}`
}

export function hasElearningProjectionAdminAuthority(
  permissions: readonly string[],
  isAdminRole: boolean,
): boolean {
  return isAdminRole
    || permissions.includes('elearning:admin')
    || permissions.includes('elearning:*')
    || permissions.includes('*:*')
}

/**
 * The projection is a read model: eligible administrators may read, export,
 * and arrange views/charts, but nobody receives a record/schema/automation
 * write capability through the ordinary multitable surface.
 */
export function restrictElearningProjectionCapabilities<
  T extends { canRead: boolean; canExport: boolean; canManageViews: boolean },
>(
  capabilities: T,
  isProjectionSheet: boolean,
  isAuthorized: boolean,
): T {
  if (!isProjectionSheet) return capabilities
  const restricted: Record<string, unknown> = { ...capabilities }
  restricted.canRead = isAuthorized
  restricted.canExport = isAuthorized
  restricted.canManageViews = isAuthorized
  for (const key of DENIED_KEYS) {
    if (key in restricted) restricted[key] = false
  }
  return restricted as T
}
