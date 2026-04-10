export type PluginRoleKind = 'viewer' | 'operator' | 'admin'

export type PluginRoleSeed = {
  id: string
  name: string
  permissions: string[]
  legacyRole: 'user' | 'admin'
}

export type BuildPluginRoleSeedsOptions = {
  pluginId: string
  displayName: string
  includeViewer?: boolean
  includeOperator?: boolean
  includeAdmin?: boolean
  viewerActions?: string[]
  operatorActions?: string[]
  adminActions?: string[]
}

function normalizePluginId(pluginId: string): string {
  return pluginId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function normalizePermissionNamespace(pluginId: string): string {
  return normalizePluginId(pluginId).replace(/_/g, '-')
}

export function buildPluginRoleId(pluginId: string, kind: PluginRoleKind): string {
  const normalized = normalizePluginId(pluginId)
  if (!normalized) throw new Error('pluginId is required')
  return `${normalized}_${kind}`
}

export function buildPluginPermissionCode(pluginId: string, action: string): string {
  const namespace = normalizePermissionNamespace(pluginId)
  const normalizedAction = action.trim().toLowerCase()
  if (!namespace || !normalizedAction) throw new Error('pluginId and action are required')
  return `${namespace}:${normalizedAction}`
}

export function buildPluginRoleSeeds(options: BuildPluginRoleSeedsOptions): PluginRoleSeed[] {
  const pluginId = normalizePluginId(options.pluginId)
  const displayName = options.displayName.trim()
  if (!pluginId) throw new Error('pluginId is required')
  if (!displayName) throw new Error('displayName is required')

  const includeViewer = options.includeViewer !== false
  const includeOperator = options.includeOperator !== false
  const includeAdmin = options.includeAdmin !== false

  const seeds: PluginRoleSeed[] = []
  const viewerActions = options.viewerActions?.length ? options.viewerActions : ['read']
  const operatorActions = options.operatorActions?.length ? options.operatorActions : ['read', 'write']
  const adminActions = options.adminActions?.length ? options.adminActions : ['read', 'write', 'admin']

  if (includeViewer) {
    seeds.push({
      id: buildPluginRoleId(pluginId, 'viewer'),
      name: `${displayName} Viewer`,
      permissions: viewerActions.map((action) => buildPluginPermissionCode(pluginId, action)),
      legacyRole: 'user',
    })
  }

  if (includeOperator) {
    seeds.push({
      id: buildPluginRoleId(pluginId, 'operator'),
      name: `${displayName} Operator`,
      permissions: operatorActions.map((action) => buildPluginPermissionCode(pluginId, action)),
      legacyRole: 'user',
    })
  }

  if (includeAdmin) {
    seeds.push({
      id: buildPluginRoleId(pluginId, 'admin'),
      name: `${displayName} Admin`,
      permissions: adminActions.map((action) => buildPluginPermissionCode(pluginId, action)),
      legacyRole: 'user',
    })
  }

  return seeds
}
