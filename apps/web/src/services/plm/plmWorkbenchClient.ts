import { apiFetch } from '../../utils/api'
import type {
  PlmApprovalsTeamViewState,
  PlmCollaborativePermissions,
  PlmDocumentsTeamViewState,
  PlmTeamFilterPreset,
  PlmTeamFilterPresetKind,
  PlmTeamFilterPresetState,
  PlmWorkbenchViewQueryState,
  PlmWorkbenchTeamView,
  PlmWorkbenchTeamViewKind,
  PlmWorkbenchTeamViewStateByKind,
} from '../../views/plm/plmPanelModels'

interface Envelope<T> {
  success?: boolean
  data?: T
  error?: string | { message?: string }
}

function extractErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback
  const record = payload as Record<string, unknown>

  if (typeof record.error === 'string' && record.error.trim()) return record.error
  if (record.error && typeof record.error === 'object') {
    const nested = record.error as Record<string, unknown>
    if (typeof nested.message === 'string' && nested.message.trim()) return nested.message
  }
  return fallback
}

function normalizeState(value: unknown): PlmTeamFilterPresetState {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const field = typeof record.field === 'string' && record.field.trim() ? record.field.trim() : 'all'
  const presetValue = typeof record.value === 'string' ? record.value.trim() : ''
  const group = typeof record.group === 'string' ? record.group.trim() : ''

  return {
    field,
    value: presetValue,
    group,
  }
}

function normalizeCollaborativePermissions(
  value: unknown,
  fallback: PlmCollaborativePermissions,
): PlmCollaborativePermissions {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    canManage: typeof record.canManage === 'boolean' ? record.canManage : fallback.canManage,
    canApply: typeof record.canApply === 'boolean' ? record.canApply : fallback.canApply,
    canDuplicate: typeof record.canDuplicate === 'boolean' ? record.canDuplicate : fallback.canDuplicate,
    canShare: typeof record.canShare === 'boolean' ? record.canShare : fallback.canShare,
    canDelete: typeof record.canDelete === 'boolean' ? record.canDelete : fallback.canDelete,
    canArchive: typeof record.canArchive === 'boolean' ? record.canArchive : fallback.canArchive,
    canRestore: typeof record.canRestore === 'boolean' ? record.canRestore : fallback.canRestore,
    canRename: typeof record.canRename === 'boolean' ? record.canRename : fallback.canRename,
    canTransfer: typeof record.canTransfer === 'boolean' ? record.canTransfer : fallback.canTransfer,
    canSetDefault: typeof record.canSetDefault === 'boolean' ? record.canSetDefault : fallback.canSetDefault,
    canClearDefault: typeof record.canClearDefault === 'boolean' ? record.canClearDefault : fallback.canClearDefault,
  }
}

function mapTeamPreset(item: unknown): PlmTeamFilterPreset {
  const record = item && typeof item === 'object' ? item as Record<string, unknown> : {}
  const isArchived = Boolean(record.isArchived)
  const isDefault = Boolean(record.isDefault)
  const canManage = Boolean(record.canManage)
  const permissions = normalizeCollaborativePermissions(record.permissions, {
    canManage,
    canApply: !isArchived,
    canDuplicate: true,
    canShare: canManage && !isArchived,
    canDelete: canManage,
    canArchive: canManage && !isArchived,
    canRestore: canManage && isArchived,
    canRename: canManage && !isArchived,
    canTransfer: canManage && !isArchived,
    canSetDefault: canManage && !isArchived && !isDefault,
    canClearDefault: canManage && !isArchived && isDefault,
  })

  return {
    id: typeof record.id === 'string' ? record.id : '',
    kind: record.kind === 'where-used' ? 'where-used' : 'bom',
    scope: 'team',
    name: typeof record.name === 'string' ? record.name : '',
    ownerUserId: typeof record.ownerUserId === 'string' ? record.ownerUserId : '',
    canManage,
    permissions,
    isDefault,
    isArchived,
    state: normalizeState(record.state),
    archivedAt: typeof record.archivedAt === 'string' ? record.archivedAt : undefined,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : undefined,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : undefined,
  }
}

function normalizeBooleanStateMap(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object') return {}
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, boolean>>((acc, [key, entry]) => {
    acc[key] = Boolean(entry)
    return acc
  }, {})
}

function normalizeStringStateMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, entry]) => {
    if (typeof entry === 'string' && entry.trim()) {
      acc[key] = entry.trim()
      return acc
    }
    if (typeof entry === 'number' || typeof entry === 'boolean') {
      acc[key] = String(entry)
    }
    return acc
  }, {})
}

function normalizeDocumentColumns(value: unknown): PlmDocumentsTeamViewState['columns'] {
  return normalizeBooleanStateMap(value)
}

function normalizeApprovalsColumns(value: unknown): PlmApprovalsTeamViewState['columns'] {
  return normalizeBooleanStateMap(value)
}

function normalizeAuditWindowMinutes(value: unknown) {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : NaN

  if (Number.isFinite(numeric) && numeric <= 60) return 60
  if (Number.isFinite(numeric) && numeric <= 180) return 180
  if (Number.isFinite(numeric) && numeric <= 720) return 720
  return 1440
}

function normalizeTeamViewState<Kind extends PlmWorkbenchTeamViewKind>(
  kind: Kind,
  value: unknown,
): PlmWorkbenchTeamViewStateByKind[Kind] {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}

  if (kind === 'documents') {
    const sortKey = typeof record.sortKey === 'string' ? record.sortKey.trim() : ''
    const sortDir = typeof record.sortDir === 'string' ? record.sortDir.trim() : ''
    return {
      role: typeof record.role === 'string' ? record.role.trim() : '',
      filter: typeof record.filter === 'string' ? record.filter.trim() : '',
      sortKey:
        sortKey === 'created'
        || sortKey === 'name'
        || sortKey === 'type'
        || sortKey === 'revision'
        || sortKey === 'role'
        || sortKey === 'mime'
        || sortKey === 'size'
          ? sortKey
          : 'updated',
      sortDir: sortDir === 'asc' ? 'asc' : 'desc',
      columns: normalizeDocumentColumns(record.columns),
    } as PlmWorkbenchTeamViewStateByKind[Kind]
  }

  if (kind === 'cad') {
    return {
      fileId: typeof record.fileId === 'string' ? record.fileId.trim() : '',
      otherFileId: typeof record.otherFileId === 'string' ? record.otherFileId.trim() : '',
      reviewState: typeof record.reviewState === 'string' ? record.reviewState.trim() : '',
      reviewNote: typeof record.reviewNote === 'string' ? record.reviewNote.trim() : '',
    } as PlmWorkbenchTeamViewStateByKind[Kind]
  }

  if (kind === 'workbench') {
    return {
      query: normalizeStringStateMap(record.query),
    } as PlmWorkbenchViewQueryState as PlmWorkbenchTeamViewStateByKind[Kind]
  }

  if (kind === 'audit') {
    const action = typeof record.action === 'string' ? record.action.trim().toLowerCase() : ''
    const resourceType = typeof record.resourceType === 'string' ? record.resourceType.trim().toLowerCase() : ''
    return {
      page:
        typeof record.page === 'number' && Number.isFinite(record.page) && record.page > 0
          ? Math.trunc(record.page)
          : typeof record.page === 'string' && Number.parseInt(record.page, 10) > 0
            ? Number.parseInt(record.page, 10)
            : 1,
      q: typeof record.q === 'string' ? record.q.trim() : '',
      actorId: typeof record.actorId === 'string' ? record.actorId.trim() : '',
      kind: typeof record.kind === 'string' ? record.kind.trim() : '',
      action:
        action === 'archive' || action === 'restore' || action === 'delete'
          ? action
          : '',
      resourceType:
        resourceType === 'plm-team-preset-batch' || resourceType === 'plm-team-view-batch'
          ? resourceType
          : '',
      from: typeof record.from === 'string' ? record.from.trim() : '',
      to: typeof record.to === 'string' ? record.to.trim() : '',
      windowMinutes: normalizeAuditWindowMinutes(record.windowMinutes),
    } as PlmWorkbenchTeamViewStateByKind[Kind]
  }

  const status = typeof record.status === 'string' ? record.status.trim().toLowerCase() : ''
  const sortKey = typeof record.sortKey === 'string' ? record.sortKey.trim() : ''
  const sortDir = typeof record.sortDir === 'string' ? record.sortDir.trim() : ''

  return {
    status: status === 'pending' || status === 'approved' || status === 'rejected' ? status : 'all',
    filter: typeof record.filter === 'string' ? record.filter.trim() : '',
    comment: typeof record.comment === 'string' ? record.comment.trim() : '',
    sortKey:
      sortKey === 'title'
      || sortKey === 'status'
      || sortKey === 'requester'
      || sortKey === 'product'
        ? sortKey
        : 'created',
    sortDir: sortDir === 'asc' ? 'asc' : 'desc',
    columns: normalizeApprovalsColumns(record.columns),
  } as PlmWorkbenchTeamViewStateByKind[Kind]
}

function mapTeamView<Kind extends PlmWorkbenchTeamViewKind>(
  kind: Kind,
  item: unknown,
): PlmWorkbenchTeamView<Kind> {
  const record = item && typeof item === 'object' ? item as Record<string, unknown> : {}
  const isArchived = Boolean(record.isArchived)
  const isDefault = Boolean(record.isDefault)
  const canManage = Boolean(record.canManage)
  const permissions = normalizeCollaborativePermissions(record.permissions, {
    canManage,
    canApply: !isArchived,
    canDuplicate: true,
    canShare: canManage && !isArchived,
    canDelete: canManage,
    canArchive: canManage && !isArchived,
    canRestore: canManage && isArchived,
    canRename: canManage && !isArchived,
    canTransfer: canManage && !isArchived,
    canSetDefault: canManage && !isArchived && !isDefault,
    canClearDefault: canManage && !isArchived && isDefault,
  })

  return {
    id: typeof record.id === 'string' ? record.id : '',
    kind,
    scope: 'team',
    name: typeof record.name === 'string' ? record.name : '',
    ownerUserId: typeof record.ownerUserId === 'string' ? record.ownerUserId : '',
    canManage,
    permissions,
    isDefault,
    isArchived,
    state: normalizeTeamViewState(kind, record.state),
    archivedAt: typeof record.archivedAt === 'string' ? record.archivedAt : undefined,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : undefined,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : undefined,
  }
}

async function requestJson<T = unknown>(path: string, options?: RequestInit): Promise<Envelope<T>> {
  const response = await apiFetch(path, options)
  const payload = await response.json().catch(() => ({})) as Envelope<T>

  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, `API error: ${response.status}`))
  }

  if (payload.success === false) {
    throw new Error(extractErrorMessage(payload, '请求失败'))
  }

  return payload
}

export async function listPlmTeamFilterPresets(kind: PlmTeamFilterPresetKind) {
  const payload = await requestJson<unknown[]>(`/api/plm-workbench/filter-presets/team?kind=${encodeURIComponent(kind)}`)
  const items = Array.isArray(payload.data) ? payload.data.map(mapTeamPreset).filter((item) => item.id && item.name) : []
  return { items }
}

export async function savePlmTeamFilterPreset(
  kind: PlmTeamFilterPresetKind,
  name: string,
  state: PlmTeamFilterPresetState,
): Promise<PlmTeamFilterPreset> {
  const payload = await requestJson<unknown>('/api/plm-workbench/filter-presets/team', {
    method: 'POST',
    body: JSON.stringify({
      kind,
      name,
      state,
    }),
  })

  return mapTeamPreset(payload.data)
}

export async function renamePlmTeamFilterPreset(
  presetId: string,
  name: string,
): Promise<PlmTeamFilterPreset> {
  const payload = await requestJson<unknown>(`/api/plm-workbench/filter-presets/team/${presetId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  })

  return mapTeamPreset(payload.data)
}

export async function duplicatePlmTeamFilterPreset(
  presetId: string,
  name?: string,
): Promise<PlmTeamFilterPreset> {
  const payload = await requestJson<unknown>(`/api/plm-workbench/filter-presets/team/${presetId}/duplicate`, {
    method: 'POST',
    body: JSON.stringify(name ? { name } : {}),
  })

  return mapTeamPreset(payload.data)
}

export async function transferPlmTeamFilterPreset(
  presetId: string,
  ownerUserId: string,
): Promise<PlmTeamFilterPreset> {
  const payload = await requestJson<unknown>(`/api/plm-workbench/filter-presets/team/${presetId}/transfer`, {
    method: 'POST',
    body: JSON.stringify({ ownerUserId }),
  })

  return mapTeamPreset(payload.data)
}

export async function deletePlmTeamFilterPreset(presetId: string) {
  const payload = await requestJson<{ id?: string; message?: string }>(`/api/plm-workbench/filter-presets/team/${presetId}`, {
    method: 'DELETE',
  })

  return {
    id: payload.data?.id || presetId,
    message: payload.data?.message || 'PLM team preset deleted successfully',
  }
}

export async function setPlmTeamFilterPresetDefault(presetId: string): Promise<PlmTeamFilterPreset> {
  const payload = await requestJson<unknown>(`/api/plm-workbench/filter-presets/team/${presetId}/default`, {
    method: 'POST',
  })

  return mapTeamPreset(payload.data)
}

export async function clearPlmTeamFilterPresetDefault(presetId: string): Promise<PlmTeamFilterPreset> {
  const payload = await requestJson<unknown>(`/api/plm-workbench/filter-presets/team/${presetId}/default`, {
    method: 'DELETE',
  })

  return mapTeamPreset(payload.data)
}

export async function archivePlmTeamFilterPreset(presetId: string): Promise<PlmTeamFilterPreset> {
  const payload = await requestJson<unknown>(`/api/plm-workbench/filter-presets/team/${presetId}/archive`, {
    method: 'POST',
  })

  return mapTeamPreset(payload.data)
}

export async function restorePlmTeamFilterPreset(presetId: string): Promise<PlmTeamFilterPreset> {
  const payload = await requestJson<unknown>(`/api/plm-workbench/filter-presets/team/${presetId}/restore`, {
    method: 'POST',
  })

  return mapTeamPreset(payload.data)
}

export type PlmTeamFilterPresetBatchAction = 'archive' | 'restore' | 'delete'

export type PlmTeamFilterPresetBatchResult = {
  action: PlmTeamFilterPresetBatchAction
  processedIds: string[]
  skippedIds: string[]
  items: PlmTeamFilterPreset[]
}

export async function batchPlmTeamFilterPresets(
  action: PlmTeamFilterPresetBatchAction,
  ids: string[],
): Promise<PlmTeamFilterPresetBatchResult> {
  const payload = await requestJson<{
    action?: string
    processedIds?: string[]
    skippedIds?: string[]
    items?: unknown[]
  }>('/api/plm-workbench/filter-presets/team/batch', {
    method: 'POST',
    body: JSON.stringify({
      action,
      ids,
    }),
  })

  return {
    action,
    processedIds: Array.isArray(payload.data?.processedIds) ? payload.data.processedIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0) : [],
    skippedIds: Array.isArray(payload.data?.skippedIds) ? payload.data.skippedIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0) : [],
    items: Array.isArray(payload.data?.items) ? payload.data.items.map(mapTeamPreset).filter((item) => item.id && item.name) : [],
  }
}

export async function listPlmWorkbenchTeamViews<Kind extends PlmWorkbenchTeamViewKind>(kind: Kind) {
  const payload = await requestJson<unknown[]>(`/api/plm-workbench/views/team?kind=${encodeURIComponent(kind)}`)
  const items = Array.isArray(payload.data) ? payload.data.map((item) => mapTeamView(kind, item)).filter((item) => item.id && item.name) : []
  return { items }
}

export async function savePlmWorkbenchTeamView<Kind extends PlmWorkbenchTeamViewKind>(
  kind: Kind,
  name: string,
  state: PlmWorkbenchTeamViewStateByKind[Kind],
): Promise<PlmWorkbenchTeamView<Kind>> {
  const payload = await requestJson<unknown>('/api/plm-workbench/views/team', {
    method: 'POST',
    body: JSON.stringify({
      kind,
      name,
      state,
    }),
  })

  return mapTeamView(kind, payload.data)
}

export async function deletePlmWorkbenchTeamView(viewId: string) {
  const payload = await requestJson<{ id?: string; message?: string }>(`/api/plm-workbench/views/team/${viewId}`, {
    method: 'DELETE',
  })

  return {
    id: payload.data?.id || viewId,
    message: payload.data?.message || 'PLM team view deleted successfully',
  }
}

export async function renamePlmWorkbenchTeamView<Kind extends PlmWorkbenchTeamViewKind>(
  kind: Kind,
  viewId: string,
  name: string,
): Promise<PlmWorkbenchTeamView<Kind>> {
  const payload = await requestJson<unknown>(`/api/plm-workbench/views/team/${viewId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  })

  return mapTeamView(kind, payload.data)
}

export async function duplicatePlmWorkbenchTeamView<Kind extends PlmWorkbenchTeamViewKind>(
  kind: Kind,
  viewId: string,
  name?: string,
): Promise<PlmWorkbenchTeamView<Kind>> {
  const payload = await requestJson<unknown>(`/api/plm-workbench/views/team/${viewId}/duplicate`, {
    method: 'POST',
    body: JSON.stringify(name ? { name } : {}),
  })

  return mapTeamView(kind, payload.data)
}

export async function transferPlmWorkbenchTeamView<Kind extends PlmWorkbenchTeamViewKind>(
  kind: Kind,
  viewId: string,
  ownerUserId: string,
): Promise<PlmWorkbenchTeamView<Kind>> {
  const payload = await requestJson<unknown>(`/api/plm-workbench/views/team/${viewId}/transfer`, {
    method: 'POST',
    body: JSON.stringify({ ownerUserId }),
  })

  return mapTeamView(kind, payload.data)
}

export async function setPlmWorkbenchTeamViewDefault<Kind extends PlmWorkbenchTeamViewKind>(
  kind: Kind,
  viewId: string,
): Promise<PlmWorkbenchTeamView<Kind>> {
  const payload = await requestJson<unknown>(`/api/plm-workbench/views/team/${viewId}/default`, {
    method: 'POST',
  })

  return mapTeamView(kind, payload.data)
}

export async function clearPlmWorkbenchTeamViewDefault<Kind extends PlmWorkbenchTeamViewKind>(
  kind: Kind,
  viewId: string,
): Promise<PlmWorkbenchTeamView<Kind>> {
  const payload = await requestJson<unknown>(`/api/plm-workbench/views/team/${viewId}/default`, {
    method: 'DELETE',
  })

  return mapTeamView(kind, payload.data)
}

export async function archivePlmWorkbenchTeamView<Kind extends PlmWorkbenchTeamViewKind>(
  kind: Kind,
  viewId: string,
): Promise<PlmWorkbenchTeamView<Kind>> {
  const payload = await requestJson<unknown>(`/api/plm-workbench/views/team/${viewId}/archive`, {
    method: 'POST',
  })

  return mapTeamView(kind, payload.data)
}

export async function restorePlmWorkbenchTeamView<Kind extends PlmWorkbenchTeamViewKind>(
  kind: Kind,
  viewId: string,
): Promise<PlmWorkbenchTeamView<Kind>> {
  const payload = await requestJson<unknown>(`/api/plm-workbench/views/team/${viewId}/restore`, {
    method: 'POST',
  })

  return mapTeamView(kind, payload.data)
}

export type PlmWorkbenchTeamViewBatchAction = 'archive' | 'restore' | 'delete'

export type PlmWorkbenchTeamViewBatchResult<
  Kind extends PlmWorkbenchTeamViewKind = PlmWorkbenchTeamViewKind,
> = {
  action: PlmWorkbenchTeamViewBatchAction
  processedIds: string[]
  skippedIds: string[]
  items: PlmWorkbenchTeamView<Kind>[]
}

export async function batchPlmWorkbenchTeamViews<Kind extends PlmWorkbenchTeamViewKind>(
  kind: Kind,
  action: PlmWorkbenchTeamViewBatchAction,
  ids: string[],
): Promise<PlmWorkbenchTeamViewBatchResult<Kind>> {
  const payload = await requestJson<{
    action?: string
    processedIds?: string[]
    skippedIds?: string[]
    items?: unknown[]
  }>('/api/plm-workbench/views/team/batch', {
    method: 'POST',
    body: JSON.stringify({
      action,
      ids,
    }),
  })

  return {
    action,
    processedIds: Array.isArray(payload.data?.processedIds)
      ? payload.data.processedIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : [],
    skippedIds: Array.isArray(payload.data?.skippedIds)
      ? payload.data.skippedIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : [],
    items: Array.isArray(payload.data?.items)
      ? payload.data.items
        .map((item) => mapTeamView(kind, item))
        .filter((item) => item.id && item.name)
      : [],
  }
}

export type PlmCollaborativeAuditResourceType = 'plm-team-preset-batch' | 'plm-team-view-batch'
export type PlmCollaborativeAuditAction = 'archive' | 'restore' | 'delete'

export interface PlmCollaborativeAuditFilters {
  page?: number
  pageSize?: number
  q?: string
  actorId?: string
  action?: PlmCollaborativeAuditAction | ''
  resourceType?: PlmCollaborativeAuditResourceType | ''
  kind?: string
  from?: string
  to?: string
}

export interface PlmCollaborativeAuditLogMeta {
  tenantId?: string
  ownerUserId?: string
  audit?: string
  requestedIds?: string[]
  processedIds?: string[]
  skippedIds?: string[]
  processedKinds?: string[]
  requestedTotal?: number
  processedTotal?: number
  skippedTotal?: number
}

export interface PlmCollaborativeAuditLogItem {
  id: string
  actorId: string
  actorType: string
  action: string
  resourceType: PlmCollaborativeAuditResourceType | ''
  resourceId: string
  requestId: string
  ip: string
  userAgent: string
  occurredAt: string
  meta: PlmCollaborativeAuditLogMeta
}

export interface PlmCollaborativeAuditSummaryRow {
  action?: string
  resourceType?: PlmCollaborativeAuditResourceType
  total: number
}

function buildPlmCollaborativeAuditSearch(params: PlmCollaborativeAuditFilters) {
  const search = new URLSearchParams()
  if (typeof params.page === 'number') search.set('page', String(params.page))
  if (typeof params.pageSize === 'number') search.set('pageSize', String(params.pageSize))
  if (params.q?.trim()) search.set('q', params.q.trim())
  if (params.actorId?.trim()) search.set('actorId', params.actorId.trim())
  if (params.action?.trim()) search.set('action', params.action.trim())
  if (params.resourceType?.trim()) search.set('resourceType', params.resourceType.trim())
  if (params.kind?.trim()) search.set('kind', params.kind.trim())
  if (params.from?.trim()) search.set('from', params.from.trim())
  if (params.to?.trim()) search.set('to', params.to.trim())
  return search
}

function mapPlmCollaborativeAuditMeta(value: unknown): PlmCollaborativeAuditLogMeta {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const toStringArray = (entry: unknown) =>
    Array.isArray(entry)
      ? entry.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : []

  return {
    tenantId: typeof record.tenantId === 'string' ? record.tenantId : undefined,
    ownerUserId: typeof record.ownerUserId === 'string' ? record.ownerUserId : undefined,
    audit: typeof record.audit === 'string' ? record.audit : undefined,
    requestedIds: toStringArray(record.requestedIds),
    processedIds: toStringArray(record.processedIds),
    skippedIds: toStringArray(record.skippedIds),
    processedKinds: toStringArray(record.processedKinds),
    requestedTotal: typeof record.requestedTotal === 'number' ? record.requestedTotal : undefined,
    processedTotal: typeof record.processedTotal === 'number' ? record.processedTotal : undefined,
    skippedTotal: typeof record.skippedTotal === 'number' ? record.skippedTotal : undefined,
  }
}

function mapPlmCollaborativeAuditLogItem(value: unknown): PlmCollaborativeAuditLogItem {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const resourceType =
    record.resourceType === 'plm-team-preset-batch' || record.resourceType === 'plm-team-view-batch'
      ? record.resourceType
      : ''

  return {
    id: typeof record.id === 'string' ? record.id : '',
    actorId: typeof record.actorId === 'string' ? record.actorId : '',
    actorType: typeof record.actorType === 'string' ? record.actorType : '',
    action: typeof record.action === 'string' ? record.action : '',
    resourceType,
    resourceId: typeof record.resourceId === 'string' ? record.resourceId : '',
    requestId: typeof record.requestId === 'string' ? record.requestId : '',
    ip: typeof record.ip === 'string' ? record.ip : '',
    userAgent: typeof record.userAgent === 'string' ? record.userAgent : '',
    occurredAt: typeof record.occurredAt === 'string' ? record.occurredAt : '',
    meta: mapPlmCollaborativeAuditMeta(record.meta),
  }
}

export async function listPlmCollaborativeAuditLogs(params: PlmCollaborativeAuditFilters) {
  const search = buildPlmCollaborativeAuditSearch({
    ...params,
    page: params.page ?? 1,
    pageSize: params.pageSize ?? 50,
  })

  const payload = await requestJson<{
    items?: unknown[]
    page?: number
    pageSize?: number
    total?: number
  }>(`/api/plm-workbench/audit-logs?${search.toString()}`)

  return {
    items: Array.isArray(payload.data?.items)
      ? payload.data.items.map(mapPlmCollaborativeAuditLogItem).filter((item) => item.id && item.action)
      : [],
    page: typeof payload.data?.page === 'number' ? payload.data.page : Number(search.get('page') || 1),
    pageSize: typeof payload.data?.pageSize === 'number' ? payload.data.pageSize : Number(search.get('pageSize') || 50),
    total: typeof payload.data?.total === 'number' ? payload.data.total : 0,
  }
}

export async function exportPlmCollaborativeAuditLogsCsv(params: PlmCollaborativeAuditFilters & { limit?: number }) {
  const search = buildPlmCollaborativeAuditSearch(params)
  if (typeof params.limit === 'number') search.set('limit', String(params.limit))

  const response = await apiFetch(`/api/plm-workbench/audit-logs/export.csv?${search.toString()}`, {
    headers: {
      Accept: 'text/csv',
    },
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text.slice(0, 200) || `Export failed (HTTP ${response.status})`)
  }

  const csvText = await response.text()
  const disposition = response.headers.get('content-disposition') || ''
  const filename = disposition.match(/filename="?([^";]+)"?/)?.[1] || 'plm-collaborative-audit.csv'
  return {
    filename,
    csvText,
  }
}

export async function getPlmCollaborativeAuditSummary(params?: {
  windowMinutes?: number
  limit?: number
}) {
  const search = new URLSearchParams()
  if (typeof params?.windowMinutes === 'number') search.set('windowMinutes', String(params.windowMinutes))
  if (typeof params?.limit === 'number') search.set('limit', String(params.limit))

  const suffix = search.toString()
  const payload = await requestJson<{
    windowMinutes?: number
    actions?: Array<{ action?: string; total?: number }>
    resourceTypes?: Array<{ resourceType?: string; total?: number }>
  }>(`/api/plm-workbench/audit-logs/summary${suffix ? `?${suffix}` : ''}`)

  return {
    windowMinutes: typeof payload.data?.windowMinutes === 'number' ? payload.data.windowMinutes : 60,
    actions: Array.isArray(payload.data?.actions)
      ? payload.data.actions.map((row) => ({
        action: typeof row.action === 'string' ? row.action : '',
        total: typeof row.total === 'number' ? row.total : 0,
      }))
      : [],
    resourceTypes: Array.isArray(payload.data?.resourceTypes)
      ? payload.data.resourceTypes
        .map((row) => ({
          resourceType:
            row.resourceType === 'plm-team-preset-batch' || row.resourceType === 'plm-team-view-batch'
              ? row.resourceType
              : undefined,
          total: typeof row.total === 'number' ? row.total : 0,
        }))
        .filter((row): row is { resourceType: PlmCollaborativeAuditResourceType; total: number } => Boolean(row.resourceType))
      : [],
  }
}
