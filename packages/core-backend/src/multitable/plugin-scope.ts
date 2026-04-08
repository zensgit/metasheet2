import type { MultitableAPI } from '../types/plugin'

export class MultitableProjectNamespaceError extends Error {
  code = 'MULTITABLE_PROJECT_NAMESPACE_FORBIDDEN'

  constructor(pluginName: string, projectId: string) {
    super(`Plugin ${pluginName} cannot access multitable projectId ${projectId}`)
    this.name = 'MultitableProjectNamespaceError'
  }
}

export function getPluginProjectNamespaces(pluginName: string): string[] {
  const raw = typeof pluginName === 'string' ? pluginName.trim() : ''
  if (!raw) return []

  const namespaces = new Set<string>([raw])
  if (raw.startsWith('plugin-') && raw.length > 'plugin-'.length) {
    namespaces.add(raw.slice('plugin-'.length))
  }
  return Array.from(namespaces)
}

export function assertProjectIdAllowedForPlugin(pluginName: string, projectId: string): void {
  if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    throw new MultitableProjectNamespaceError(pluginName, String(projectId))
  }

  const suffix = projectId.split(':').pop()?.trim() ?? ''
  const allowedNamespaces = getPluginProjectNamespaces(pluginName)
  if (!suffix || !allowedNamespaces.includes(suffix)) {
    throw new MultitableProjectNamespaceError(pluginName, projectId)
  }
}

export function createPluginScopedMultitableApi(
  multitable: MultitableAPI,
  pluginName: string,
): MultitableAPI {
  return {
    provisioning: {
      getObjectSheetId: (projectId, objectId) => {
        assertProjectIdAllowedForPlugin(pluginName, projectId)
        return multitable.provisioning.getObjectSheetId(projectId, objectId)
      },
      getFieldId: (projectId, objectId, fieldId) => {
        assertProjectIdAllowedForPlugin(pluginName, projectId)
        return multitable.provisioning.getFieldId(projectId, objectId, fieldId)
      },
      ensureObject: async (input) => {
        assertProjectIdAllowedForPlugin(pluginName, input.projectId)
        return multitable.provisioning.ensureObject(input)
      },
      ensureView: async (input) => {
        assertProjectIdAllowedForPlugin(pluginName, input.projectId)
        return multitable.provisioning.ensureView(input)
      },
    },
    records: multitable.records,
  }
}
