import type { PlmAuditRouteState } from './plmAuditQueryState'

const PLM_AUDIT_SAVED_VIEWS_KEY = 'metasheet_plm_audit_saved_views'
const PLM_AUDIT_SAVED_VIEWS_LIMIT = 8

export interface PlmAuditSavedView {
  id: string
  name: string
  state: PlmAuditRouteState
  updatedAt: string
}

function getStorage(storage?: Storage | null) {
  if (storage !== undefined) return storage
  return typeof localStorage !== 'undefined' ? localStorage : null
}

function isPlmAuditRouteState(value: unknown): value is PlmAuditRouteState {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.page === 'number'
    && typeof record.q === 'string'
    && typeof record.actorId === 'string'
    && typeof record.kind === 'string'
    && (
      record.action === ''
      || record.action === 'archive'
      || record.action === 'restore'
      || record.action === 'delete'
      || record.action === 'set-default'
      || record.action === 'clear-default'
    )
    && (
      record.resourceType === ''
      || record.resourceType === 'plm-team-preset-batch'
      || record.resourceType === 'plm-team-view-batch'
      || record.resourceType === 'plm-team-view-default'
    )
    && typeof record.from === 'string'
    && typeof record.to === 'string'
    && typeof record.windowMinutes === 'number'
    && (record.teamViewId === undefined || typeof record.teamViewId === 'string')
    && (record.sceneId === undefined || typeof record.sceneId === 'string')
    && (record.sceneName === undefined || typeof record.sceneName === 'string')
    && (record.sceneOwnerUserId === undefined || typeof record.sceneOwnerUserId === 'string')
    && (record.sceneRecommendationReason === undefined || typeof record.sceneRecommendationReason === 'string')
    && (record.sceneRecommendationSourceLabel === undefined || typeof record.sceneRecommendationSourceLabel === 'string')
    && (record.returnToPlmPath === undefined || typeof record.returnToPlmPath === 'string')
}

function normalizePlmAuditRouteState(state: PlmAuditRouteState): PlmAuditRouteState {
  return {
    ...state,
    teamViewId: state.teamViewId || '',
    sceneId: state.sceneId || '',
    sceneName: state.sceneName || '',
    sceneOwnerUserId: state.sceneOwnerUserId || '',
    sceneRecommendationReason: state.sceneRecommendationReason || '',
    sceneRecommendationSourceLabel: state.sceneRecommendationSourceLabel || '',
    returnToPlmPath: state.returnToPlmPath || '',
  }
}

function isPlmAuditSavedView(value: unknown): value is PlmAuditSavedView {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && typeof record.name === 'string'
    && typeof record.updatedAt === 'string'
    && isPlmAuditRouteState(record.state)
}

function normalizeViewName(name: string) {
  return name.trim().toLocaleLowerCase()
}

function generateSavedViewId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `plm-audit-view-${crypto.randomUUID()}`
  }

  return `plm-audit-view-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function writePlmAuditSavedViews(items: readonly PlmAuditSavedView[], storage?: Storage | null) {
  const target = getStorage(storage)
  if (!target) return
  target.setItem(PLM_AUDIT_SAVED_VIEWS_KEY, JSON.stringify(items.slice(0, PLM_AUDIT_SAVED_VIEWS_LIMIT)))
}

export function readPlmAuditSavedViews(storage?: Storage | null): PlmAuditSavedView[] {
  const target = getStorage(storage)
  if (!target) return []

  try {
    const raw = target.getItem(PLM_AUDIT_SAVED_VIEWS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? parsed
        .filter(isPlmAuditSavedView)
        .map((item) => ({
          ...item,
          state: normalizePlmAuditRouteState(item.state),
        }))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      : []
  } catch {
    return []
  }
}

export function savePlmAuditSavedView(name: string, state: PlmAuditRouteState, storage?: Storage | null): PlmAuditSavedView[] {
  const trimmedName = name.trim()
  if (!trimmedName) {
    return readPlmAuditSavedViews(storage)
  }

  const now = new Date().toISOString()
  const current = readPlmAuditSavedViews(storage)
  const existing = current.find((item) => normalizeViewName(item.name) === normalizeViewName(trimmedName))

  const nextEntry: PlmAuditSavedView = {
    id: existing?.id ?? generateSavedViewId(),
    name: trimmedName,
    state: normalizePlmAuditRouteState(state),
    updatedAt: now,
  }

  const next = [nextEntry, ...current.filter((item) => item.id !== nextEntry.id)].slice(0, PLM_AUDIT_SAVED_VIEWS_LIMIT)
  writePlmAuditSavedViews(next, storage)
  return next
}

export function deletePlmAuditSavedView(id: string, storage?: Storage | null): PlmAuditSavedView[] {
  const next = readPlmAuditSavedViews(storage).filter((item) => item.id !== id)
  writePlmAuditSavedViews(next, storage)
  return next
}
