import { getAccessPreset, listAccessPresets, type AccessPresetProductMode } from './access-presets'

export type PermissionTemplateProductMode = AccessPresetProductMode

export interface PermissionTemplateDefinition {
  id: string
  name: string
  description: string
  productMode: PermissionTemplateProductMode
  permissions: string[]
  presetId: string | null
  roleId: string | null
}

const PERMISSION_TEMPLATES: PermissionTemplateDefinition[] = listAccessPresets().map((preset) => ({
  id: preset.id,
  name: preset.name,
  description: preset.description,
  productMode: preset.productMode,
  permissions: [...preset.permissions],
  presetId: preset.id,
  roleId: preset.roleId || null,
}))

export function listPermissionTemplates(mode?: string): PermissionTemplateDefinition[] {
  return PERMISSION_TEMPLATES
    .filter((template) => !mode || template.productMode === mode)
    .map((template) => ({
      ...template,
      permissions: [...template.permissions],
    }))
}

export function getPermissionTemplate(templateId?: string | null): PermissionTemplateDefinition | null {
  if (!templateId) return null
  return PERMISSION_TEMPLATES.find((template) => template.id === templateId) || null
}

export function getPermissionTemplateForPreset(presetId?: string | null): PermissionTemplateDefinition | null {
  const preset = getAccessPreset(presetId)
  if (!preset) return null
  return getPermissionTemplate(preset.id)
}
