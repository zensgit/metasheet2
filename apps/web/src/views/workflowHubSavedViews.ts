import type { WorkflowHubRouteState } from './workflowHubQueryState'

const WORKFLOW_HUB_SAVED_VIEWS_KEY = 'metasheet_workflow_hub_saved_views'
const WORKFLOW_HUB_SAVED_VIEWS_LIMIT = 8

export interface WorkflowHubSavedView {
  id: string
  name: string
  state: WorkflowHubRouteState
  updatedAt: string
}

function getStorage(storage?: Storage | null) {
  if (storage !== undefined) return storage
  return typeof localStorage !== 'undefined' ? localStorage : null
}

function isWorkflowHubRouteState(value: unknown): value is WorkflowHubRouteState {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.workflowSearch === 'string'
    && (record.workflowStatus === '' || record.workflowStatus === 'draft' || record.workflowStatus === 'published' || record.workflowStatus === 'archived')
    && (record.workflowSortBy === 'updated_at' || record.workflowSortBy === 'created_at' || record.workflowSortBy === 'name')
    && typeof record.workflowOffset === 'number'
    && typeof record.templateSearch === 'string'
    && (record.templateSource === 'all' || record.templateSource === 'builtin' || record.templateSource === 'database')
    && (record.templateSortBy === 'usage_count' || record.templateSortBy === 'name' || record.templateSortBy === 'updated_at')
    && typeof record.templateOffset === 'number'
}

function isWorkflowHubSavedView(value: unknown): value is WorkflowHubSavedView {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && typeof record.name === 'string'
    && typeof record.updatedAt === 'string'
    && isWorkflowHubRouteState(record.state)
}

export function readWorkflowHubSavedViews(storage?: Storage | null): WorkflowHubSavedView[] {
  const target = getStorage(storage)
  if (!target) return []

  try {
    const raw = target.getItem(WORKFLOW_HUB_SAVED_VIEWS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? parsed.filter(isWorkflowHubSavedView).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      : []
  } catch {
    return []
  }
}

function writeWorkflowHubSavedViews(items: readonly WorkflowHubSavedView[], storage?: Storage | null) {
  const target = getStorage(storage)
  if (!target) return
  target.setItem(WORKFLOW_HUB_SAVED_VIEWS_KEY, JSON.stringify(items.slice(0, WORKFLOW_HUB_SAVED_VIEWS_LIMIT)))
}

function normalizeViewName(name: string) {
  return name.trim().toLocaleLowerCase()
}

function generateSavedViewId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `workflow-view-${crypto.randomUUID()}`
  }

  return `workflow-view-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function saveWorkflowHubSavedView(
  name: string,
  state: WorkflowHubRouteState,
  storage?: Storage | null,
): WorkflowHubSavedView[] {
  const trimmedName = name.trim()
  if (!trimmedName) {
    return readWorkflowHubSavedViews(storage)
  }

  const now = new Date().toISOString()
  const current = readWorkflowHubSavedViews(storage)
  const existing = current.find((item) => normalizeViewName(item.name) === normalizeViewName(trimmedName))

  const nextEntry: WorkflowHubSavedView = {
    id: existing?.id ?? generateSavedViewId(),
    name: trimmedName,
    state,
    updatedAt: now,
  }

  const next = [nextEntry, ...current.filter((item) => item.id !== nextEntry.id)].slice(0, WORKFLOW_HUB_SAVED_VIEWS_LIMIT)
  writeWorkflowHubSavedViews(next, storage)
  return next
}

export function deleteWorkflowHubSavedView(id: string, storage?: Storage | null): WorkflowHubSavedView[] {
  const next = readWorkflowHubSavedViews(storage).filter((item) => item.id !== id)
  writeWorkflowHubSavedViews(next, storage)
  return next
}
