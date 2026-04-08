import type { MultitableAPI } from '../types/plugin'

export type MultitableScopeQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export type ClaimPluginObjectScopeInput = {
  pluginName: string
  projectId: string
  objectId: string
  sheetId: string
}

export type AssertPluginSheetScopeInput = {
  pluginName: string
  sheetId: string
}

export type AssertPluginObjectScopeInput = {
  pluginName: string
  projectId: string
  objectId: string
}

export type MultitableScopeHooks = {
  ensureObjectInScope?: (
    input: Parameters<MultitableAPI['provisioning']['ensureObject']>[0] & { pluginName: string }
  ) => ReturnType<MultitableAPI['provisioning']['ensureObject']>
  assertObjectScope?: (input: AssertPluginObjectScopeInput) => Promise<void>
  claimObjectScope?: (input: ClaimPluginObjectScopeInput) => Promise<void>
  assertSheetScope?: (input: AssertPluginSheetScopeInput) => Promise<void>
}

export class MultitableProjectNamespaceError extends Error {
  code = 'MULTITABLE_PROJECT_NAMESPACE_FORBIDDEN'

  constructor(pluginName: string, projectId: string) {
    super(`Plugin ${pluginName} cannot access multitable projectId ${projectId}`)
    this.name = 'MultitableProjectNamespaceError'
  }
}

export class MultitableObjectScopeError extends Error {
  code = 'MULTITABLE_OBJECT_SCOPE_FORBIDDEN'

  constructor(pluginName: string, projectId: string, objectId: string, ownerPluginName: string) {
    super(
      `Plugin ${pluginName} cannot claim multitable object ${projectId}/${objectId}; owned by ${ownerPluginName}`,
    )
    this.name = 'MultitableObjectScopeError'
  }
}

export class MultitableSheetScopeError extends Error {
  code = 'MULTITABLE_SHEET_SCOPE_FORBIDDEN'

  constructor(pluginName: string, sheetId: string, ownerPluginName: string) {
    super(`Plugin ${pluginName} cannot access multitable sheet ${sheetId}; owned by ${ownerPluginName}`)
    this.name = 'MultitableSheetScopeError'
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

export async function claimPluginObjectScope(
  query: MultitableScopeQueryFn,
  input: ClaimPluginObjectScopeInput,
): Promise<void> {
  await query(
    `INSERT INTO plugin_multitable_object_registry (sheet_id, project_id, object_id, plugin_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, object_id) DO UPDATE SET
       updated_at = now()
     WHERE plugin_multitable_object_registry.sheet_id = EXCLUDED.sheet_id
       AND plugin_multitable_object_registry.plugin_name = EXCLUDED.plugin_name`,
    [input.sheetId, input.projectId, input.objectId, input.pluginName],
  )

  const result = await query(
    `SELECT sheet_id, plugin_name
     FROM plugin_multitable_object_registry
     WHERE project_id = $1 AND object_id = $2`,
    [input.projectId, input.objectId],
  )
  const row = (result.rows as Array<{ sheet_id?: unknown; plugin_name?: unknown }>)[0]
  if (!row) {
    throw new MultitableObjectScopeError(input.pluginName, input.projectId, input.objectId, 'unknown')
  }

  const ownerPluginName = typeof row.plugin_name === 'string' ? row.plugin_name : ''
  const ownedSheetId = typeof row.sheet_id === 'string' ? row.sheet_id : ''
  if (ownerPluginName !== input.pluginName || ownedSheetId !== input.sheetId) {
    throw new MultitableObjectScopeError(
      input.pluginName,
      input.projectId,
      input.objectId,
      ownerPluginName || 'unknown',
    )
  }
}

export async function assertPluginOwnsSheet(
  query: MultitableScopeQueryFn,
  input: AssertPluginSheetScopeInput,
): Promise<boolean> {
  const result = await query(
    `SELECT plugin_name
     FROM plugin_multitable_object_registry
     WHERE sheet_id = $1`,
    [input.sheetId],
  )
  const row = (result.rows as Array<{ plugin_name?: unknown }>)[0]
  if (!row) return false

  const ownerPluginName = typeof row.plugin_name === 'string' ? row.plugin_name : ''
  if (ownerPluginName && ownerPluginName !== input.pluginName) {
    throw new MultitableSheetScopeError(input.pluginName, input.sheetId, ownerPluginName)
  }
  return true
}

export async function assertPluginOwnsObject(
  query: MultitableScopeQueryFn,
  input: AssertPluginObjectScopeInput,
): Promise<boolean> {
  const result = await query(
    `SELECT sheet_id, plugin_name
     FROM plugin_multitable_object_registry
     WHERE project_id = $1 AND object_id = $2`,
    [input.projectId, input.objectId],
  )
  const row = (result.rows as Array<{ sheet_id?: unknown; plugin_name?: unknown }>)[0]
  if (!row) return false

  const ownerPluginName = typeof row.plugin_name === 'string' ? row.plugin_name : ''
  if (ownerPluginName && ownerPluginName !== input.pluginName) {
    throw new MultitableObjectScopeError(
      input.pluginName,
      input.projectId,
      input.objectId,
      ownerPluginName,
    )
  }
  return true
}

export function createPluginScopedMultitableApi(
  multitable: MultitableAPI,
  pluginName: string,
  hooks: MultitableScopeHooks = {},
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
      findObjectSheet: async (input) => {
        assertProjectIdAllowedForPlugin(pluginName, input.projectId)
        return multitable.provisioning.findObjectSheet(input)
      },
      resolveFieldIds: async (input) => {
        assertProjectIdAllowedForPlugin(pluginName, input.projectId)
        return multitable.provisioning.resolveFieldIds(input)
      },
      ensureObject: async (input) => {
        assertProjectIdAllowedForPlugin(pluginName, input.projectId)
        if (hooks.ensureObjectInScope) {
          return hooks.ensureObjectInScope({
            pluginName,
            ...input,
          })
        }
        await hooks.assertObjectScope?.({
          pluginName,
          projectId: input.projectId,
          objectId: input.descriptor.id,
        })
        const result = await multitable.provisioning.ensureObject(input)
        await hooks.claimObjectScope?.({
          pluginName,
          projectId: input.projectId,
          objectId: input.descriptor.id,
          sheetId: result.sheet.id,
        })
        return result
      },
      ensureView: async (input) => {
        assertProjectIdAllowedForPlugin(pluginName, input.projectId)
        await hooks.assertSheetScope?.({ pluginName, sheetId: input.sheetId })
        return multitable.provisioning.ensureView(input)
      },
    },
    records: {
      listRecords: async (input) => {
        await hooks.assertSheetScope?.({ pluginName, sheetId: input.sheetId })
        return multitable.records.listRecords(input)
      },
      queryRecords: async (input) => {
        await hooks.assertSheetScope?.({ pluginName, sheetId: input.sheetId })
        return multitable.records.queryRecords(input)
      },
      createRecord: async (input) => {
        await hooks.assertSheetScope?.({ pluginName, sheetId: input.sheetId })
        return multitable.records.createRecord(input)
      },
      getRecord: async (input) => {
        await hooks.assertSheetScope?.({ pluginName, sheetId: input.sheetId })
        return multitable.records.getRecord(input)
      },
      patchRecord: async (input) => {
        await hooks.assertSheetScope?.({ pluginName, sheetId: input.sheetId })
        return multitable.records.patchRecord(input)
      },
      deleteRecord: async (input) => {
        await hooks.assertSheetScope?.({ pluginName, sheetId: input.sheetId })
        return multitable.records.deleteRecord(input)
      },
    },
  }
}
