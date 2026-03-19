import { buildPlmCollaborativePermissions } from './plmCollaborativePermissions'

export type PlmWorkbenchTeamViewKind = 'documents' | 'cad' | 'approvals' | 'workbench' | 'audit'

export type PlmWorkbenchTeamViewState =
  | null
  | boolean
  | number
  | string
  | PlmWorkbenchTeamViewState[]
  | { [key: string]: PlmWorkbenchTeamViewState }

export interface PlmWorkbenchTeamViewRowLike {
  id: string
  tenant_id: string
  owner_user_id: string
  scope: string
  kind: string
  name: string
  name_key: string
  is_default?: boolean | number | string | null
  state: unknown
  archived_at?: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

function readString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
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

function parseStoredState(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed) return {}

  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return value
  }
}

function sanitizeJsonValue(value: unknown): PlmWorkbenchTeamViewState {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return value.toString()

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJsonValue(entry))
  }

  if (value && typeof value === 'object') {
    const normalized: Record<string, PlmWorkbenchTeamViewState> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (
        typeof entry === 'undefined' ||
        typeof entry === 'function' ||
        typeof entry === 'symbol'
      ) {
        continue
      }
      normalized[key] = sanitizeJsonValue(entry)
    }
    return normalized
  }

  return {}
}

export function normalizePlmWorkbenchTeamViewKind(value: unknown): PlmWorkbenchTeamViewKind | null {
  const normalized = readString(value).toLowerCase()
  if (
    normalized === 'documents'
    || normalized === 'cad'
    || normalized === 'approvals'
    || normalized === 'workbench'
    || normalized === 'audit'
  ) {
    return normalized
  }
  return null
}

export function normalizePlmWorkbenchTeamViewName(value: string) {
  return value.trim()
}

export function normalizePlmWorkbenchTeamViewNameKey(value: string) {
  return normalizePlmWorkbenchTeamViewName(value).toLocaleLowerCase()
}

export function buildPlmWorkbenchTeamViewDuplicateName(
  sourceName: string,
  existingNames: string[],
) {
  const baseName = normalizePlmWorkbenchTeamViewName(sourceName) || '团队视图'
  const existingKeys = new Set(
    existingNames
      .map((entry) => normalizePlmWorkbenchTeamViewNameKey(entry))
      .filter(Boolean),
  )

  const primaryCandidate = `${baseName}（副本）`
  if (!existingKeys.has(normalizePlmWorkbenchTeamViewNameKey(primaryCandidate))) {
    return primaryCandidate
  }

  let index = 2
  while (index < 1000) {
    const candidate = `${baseName}（副本 ${index}）`
    if (!existingKeys.has(normalizePlmWorkbenchTeamViewNameKey(candidate))) {
      return candidate
    }
    index += 1
  }

  return `${baseName}（副本 ${Date.now()}）`
}

export function normalizePlmWorkbenchTeamViewState(value: unknown): PlmWorkbenchTeamViewState {
  return sanitizeJsonValue(parseStoredState(value))
}

export function normalizePlmWorkbenchTeamViewDefaultFlag(value: unknown) {
  return readBoolean(value)
}

export function buildPlmWorkbenchTeamViewValues(input: {
  tenantId: string
  ownerUserId: string
  kind: PlmWorkbenchTeamViewKind
  name: string
  state: unknown
  isDefault?: boolean
}) {
  const normalizedName = normalizePlmWorkbenchTeamViewName(input.name)
  const normalizedState = normalizePlmWorkbenchTeamViewState(input.state)

  return {
    tenant_id: input.tenantId,
    owner_user_id: input.ownerUserId,
    scope: 'team',
    kind: input.kind,
    name: normalizedName,
    name_key: normalizePlmWorkbenchTeamViewNameKey(normalizedName),
    is_default: Boolean(input.isDefault),
    state: JSON.stringify(normalizedState),
  }
}

export function mapPlmWorkbenchTeamViewRow(
  row: PlmWorkbenchTeamViewRowLike,
  currentUserId?: string | null,
) {
  const archivedAt =
    row.archived_at instanceof Date
      ? row.archived_at.toISOString()
      : typeof row.archived_at === 'string' && row.archived_at
        ? row.archived_at
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
    kind: normalizePlmWorkbenchTeamViewKind(row.kind) ?? 'documents',
    scope: 'team' as const,
    name: row.name,
    ownerUserId: row.owner_user_id,
    canManage: permissions.canManage,
    permissions,
    isDefault,
    isArchived,
    state: normalizePlmWorkbenchTeamViewState(row.state),
    archivedAt,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  }
}
