import { buildPlmCollaborativePermissions } from './plmCollaborativePermissions'

export type PlmTeamFilterPresetKind = 'bom' | 'where-used'

export interface PlmTeamFilterPresetState {
  field: string
  value: string
  group: string
}

export interface PlmTeamFilterPresetRowLike {
  id: string
  tenant_id: string
  owner_user_id: string
  scope: string
  kind: string
  name: string
  name_key: string
  is_default?: boolean | number | string | null
  archived_at?: Date | string | null
  state: unknown
  created_at: Date | string
  updated_at: Date | string
}

export const DEFAULT_PLM_TEAM_FILTER_PRESET_STATE: PlmTeamFilterPresetState = {
  field: 'all',
  value: '',
  group: '',
}

function readString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function parseStoredState(value: unknown) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as unknown
    } catch {
      return {}
    }
  }
  return value
}

function readBoolean(value: unknown) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === 'true' || normalized === '1' || normalized === 't'
  }
  return false
}

export function normalizePlmTeamFilterPresetKind(value: unknown): PlmTeamFilterPresetKind | null {
  const normalized = readString(value).toLowerCase()
  if (normalized === 'bom' || normalized === 'where-used') {
    return normalized
  }
  return null
}

export function normalizePlmTeamFilterPresetName(value: string) {
  return value.trim()
}

export function normalizePlmTeamFilterPresetNameKey(value: string) {
  return normalizePlmTeamFilterPresetName(value).toLocaleLowerCase()
}

export function buildPlmTeamFilterPresetDuplicateName(
  sourceName: string,
  existingNames: string[],
) {
  const baseName = normalizePlmTeamFilterPresetName(sourceName) || '团队预设'
  const existingKeys = new Set(
    existingNames
      .map((entry) => normalizePlmTeamFilterPresetNameKey(entry))
      .filter(Boolean),
  )

  const primaryCandidate = `${baseName}（副本）`
  if (!existingKeys.has(normalizePlmTeamFilterPresetNameKey(primaryCandidate))) {
    return primaryCandidate
  }

  let index = 2
  while (index < 1000) {
    const candidate = `${baseName}（副本 ${index}）`
    if (!existingKeys.has(normalizePlmTeamFilterPresetNameKey(candidate))) {
      return candidate
    }
    index += 1
  }

  return `${baseName}（副本 ${Date.now()}）`
}

export function normalizePlmTeamFilterPresetState(value: unknown): PlmTeamFilterPresetState {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const field = readString(record.field)
  const presetValue = readString(record.value)
  const group = readString(record.group)

  return {
    field: field || DEFAULT_PLM_TEAM_FILTER_PRESET_STATE.field,
    value: presetValue,
    group,
  }
}

export function buildPlmTeamFilterPresetValues(input: {
  tenantId: string
  ownerUserId: string
  kind: PlmTeamFilterPresetKind
  name: string
  state: unknown
}) {
  const normalizedName = normalizePlmTeamFilterPresetName(input.name)
  const normalizedState = normalizePlmTeamFilterPresetState(input.state)

  return {
    tenant_id: input.tenantId,
    owner_user_id: input.ownerUserId,
    scope: 'team',
    kind: input.kind,
    name: normalizedName,
    name_key: normalizePlmTeamFilterPresetNameKey(normalizedName),
    state: JSON.stringify(normalizedState),
  }
}

export function mapPlmTeamFilterPresetRow(
  row: PlmTeamFilterPresetRowLike,
  currentUserId?: string | null,
) {
  const archivedAt = row.archived_at
    ? row.archived_at instanceof Date
      ? row.archived_at.toISOString()
      : String(row.archived_at)
    : undefined

  const isDefault = readBoolean(row.is_default)
  const isArchived = Boolean(archivedAt)
  const permissions = buildPlmCollaborativePermissions({
    ownerUserId: row.owner_user_id,
    currentUserId,
    isArchived,
    isDefault,
  })

  return {
    id: row.id,
    kind: normalizePlmTeamFilterPresetKind(row.kind) ?? 'bom',
    scope: 'team' as const,
    name: row.name,
    ownerUserId: row.owner_user_id,
    canManage: permissions.canManage,
    permissions,
    isDefault,
    isArchived,
    state: normalizePlmTeamFilterPresetState(parseStoredState(row.state)),
    archivedAt,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  }
}
