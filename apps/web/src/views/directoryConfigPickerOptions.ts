/**
 * Candidate lists for the directory-sync integration form pickers (member-group default
 * roles / default plugin namespaces). The pickers must never offer a value the backend
 * would reject or silently drop, so the two filters below mirror the backend rules
 * exactly; keep them in lock-step when those rules change:
 *
 * - Roles: `assertDirectoryProjectedGovernanceConfigValid`
 *   (packages/core-backend/src/directory/directory-sync.ts) rejects `admin` and every
 *   role id `deriveDelegatedAdminNamespace` maps to a namespace
 *   (packages/core-backend/src/rbac/namespace-admission.ts), and rejects ids that are not
 *   in `roles` — the candidates therefore come from the platform role catalog
 *   (`GET /api/admin/roles`, the same read the role and user management pages use).
 * - Namespaces: `normalizeMemberGroupDefaultNamespaces` (directory-sync.ts) silently drops
 *   anything `isNamespaceAdmissionControlledResource` (namespace-admission.ts) refuses:
 *   empty, `*`, and the NON_NAMESPACED_PERMISSION_RESOURCES set. There is no backend list
 *   endpoint for namespaces, so candidates are derived from the role catalog the same two
 *   ways the backend derives a role's namespaces (`deriveGrantNamespaces`): the resource
 *   half of each permission code, and the delegated-admin role-id suffix.
 */
import { presentRoleTitle } from './builtinCatalogPresentation'

export type DirectoryPickerOption = {
  value: string
  label: string
  detail?: string
  keywords?: string
}

export type DirectoryRoleCatalogItem = {
  id: string
  name: string
  permissions: string[]
}

const PLATFORM_ADMIN_ROLE_ID = 'admin'
const DELEGATED_ADMIN_ROLE_SUFFIX = '_admin'

// Mirror of NON_NAMESPACED_PERMISSION_RESOURCES in
// packages/core-backend/src/rbac/namespace-admission.ts.
export const NON_ADMISSION_CONTROLLED_NAMESPACES: ReadonlySet<string> = new Set([
  'admin',
  'approvals',
  'audit',
  'auth',
  'cache',
  'comments',
  'demo',
  'events',
  'files',
  'health',
  'meta',
  'metrics',
  'multitable',
  'notification',
  'notifications',
  'permission',
  'permissions',
  'role',
  'roles',
  'session',
  'sessions',
  'snapshot',
  'snapshots',
  'spreadsheet',
  'spreadsheets',
  'workflow',
])

// Display names only (the namespace itself is always shown next to it). Each name is the
// one the product already uses for that surface: 考勤 (App.vue nav), 备料 / 在线学习
// (builtinCatalogPresentation.ts permission and role titles), 任务 (App.vue nav).
const PLUGIN_NAMESPACE_LABELS: ReadonlyMap<string, string> = new Map([
  ['attendance', '考勤'],
  ['stock-prep', '备料'],
  ['elearning', '在线学习'],
  ['tasks', '任务'],
])

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim()
}

/** Mirrors `isNamespaceAdmissionControlledResource`. */
export function isAdmissionControlledNamespace(value: unknown): boolean {
  const namespace = normalizeString(value)
  if (!namespace || namespace === '*') return false
  return !NON_ADMISSION_CONTROLLED_NAMESPACES.has(namespace)
}

/** Mirrors `deriveDelegatedAdminNamespace`. */
function deriveDelegatedAdminNamespace(roleId: string): string | null {
  const normalizedRoleId = normalizeString(roleId)
  if (!normalizedRoleId || normalizedRoleId === PLATFORM_ADMIN_ROLE_ID) return null
  if (!normalizedRoleId.endsWith(DELEGATED_ADMIN_ROLE_SUFFIX)) return null
  const namespace = normalizedRoleId.slice(0, -DELEGATED_ADMIN_ROLE_SUFFIX.length).trim()
  return namespace || null
}

/** True when the backend refuses the role as a projected member-group default role. */
export function isRoleRejectedAsMemberGroupDefault(roleId: unknown): boolean {
  const normalizedRoleId = normalizeString(roleId)
  if (!normalizedRoleId) return true
  return normalizedRoleId === PLATFORM_ADMIN_ROLE_ID || deriveDelegatedAdminNamespace(normalizedRoleId) !== null
}

/** Mirrors `derivePermissionResource` + `derivePermissionNamespace`. */
function derivePermissionNamespace(permissionCode: unknown): string | null {
  const code = normalizeString(permissionCode)
  if (!code || code === '*:*') return null
  const separatorIndex = code.indexOf(':')
  if (separatorIndex <= 0) return null
  const resource = code.slice(0, separatorIndex).trim()
  return isAdmissionControlledNamespace(resource) ? resource : null
}

export function readPluginNamespaceLabel(namespace: string): string {
  return PLUGIN_NAMESPACE_LABELS.get(namespace) ?? namespace
}

export function normalizeDirectoryRoleCatalog(items: unknown): DirectoryRoleCatalogItem[] {
  if (!Array.isArray(items)) return []
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const id = normalizeString(record.id)
    if (!id) return []
    return [{
      id,
      name: typeof record.name === 'string' ? record.name : id,
      permissions: Array.isArray(record.permissions)
        ? record.permissions.filter((code): code is string => typeof code === 'string')
        : [],
    }]
  })
}

export function buildMemberGroupRoleOptions(catalog: DirectoryRoleCatalogItem[]): DirectoryPickerOption[] {
  const seen = new Set<string>()
  const options: DirectoryPickerOption[] = []
  for (const role of catalog) {
    const id = normalizeString(role.id)
    if (!id || seen.has(id) || isRoleRejectedAsMemberGroupDefault(id)) continue
    seen.add(id)
    const title = presentRoleTitle({ id, name: role.name }) || id
    options.push({ value: id, label: title, detail: id, keywords: `${title} ${role.name} ${id}` })
  }
  return options
}

export function buildMemberGroupNamespaceOptions(catalog: DirectoryRoleCatalogItem[]): DirectoryPickerOption[] {
  const namespaces = new Set<string>()
  for (const role of catalog) {
    const delegatedNamespace = deriveDelegatedAdminNamespace(role.id)
    if (delegatedNamespace && isAdmissionControlledNamespace(delegatedNamespace)) {
      namespaces.add(delegatedNamespace)
    }
    for (const permission of role.permissions) {
      const namespace = derivePermissionNamespace(permission)
      if (namespace) namespaces.add(namespace)
    }
  }
  return Array.from(namespaces)
    .sort((left, right) => left.localeCompare(right))
    .map((namespace) => {
      const label = readPluginNamespaceLabel(namespace)
      return { value: namespace, label, detail: namespace, keywords: `${label} ${namespace}` }
    })
}
