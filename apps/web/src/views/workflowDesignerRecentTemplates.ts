import type { WorkflowDesignerTemplateDetail, WorkflowDesignerTemplateListItem } from './workflowDesignerPersistence'

const RECENT_WORKFLOW_TEMPLATES_KEY = 'metasheet_workflow_recent_templates'
const RECENT_WORKFLOW_TEMPLATES_LIMIT = 6

export interface RecentWorkflowTemplateItem {
  id: string
  name: string
  description: string
  category: string
  source: 'builtin' | 'database'
  usedAt: string
}

function getStorage(storage?: Storage | null) {
  if (storage !== undefined) return storage
  return typeof localStorage !== 'undefined' ? localStorage : null
}

function isRecentWorkflowTemplateItem(value: unknown): value is RecentWorkflowTemplateItem {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && typeof record.name === 'string'
    && typeof record.description === 'string'
    && typeof record.category === 'string'
    && (record.source === 'builtin' || record.source === 'database')
    && typeof record.usedAt === 'string'
}

export function readRecentWorkflowTemplates(storage?: Storage | null): RecentWorkflowTemplateItem[] {
  const target = getStorage(storage)
  if (!target) return []

  try {
    const raw = target.getItem(RECENT_WORKFLOW_TEMPLATES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? parsed.filter(isRecentWorkflowTemplateItem).sort((left, right) => right.usedAt.localeCompare(left.usedAt))
      : []
  } catch {
    return []
  }
}

export function writeRecentWorkflowTemplates(items: readonly RecentWorkflowTemplateItem[], storage?: Storage | null) {
  const target = getStorage(storage)
  if (!target) return
  target.setItem(RECENT_WORKFLOW_TEMPLATES_KEY, JSON.stringify(items.slice(0, RECENT_WORKFLOW_TEMPLATES_LIMIT)))
}

export function rememberRecentWorkflowTemplate(
  template: Pick<RecentWorkflowTemplateItem, 'id' | 'name' | 'description' | 'category' | 'source'>,
  storage?: Storage | null,
): RecentWorkflowTemplateItem[] {
  const nextEntry: RecentWorkflowTemplateItem = {
    ...template,
    usedAt: new Date().toISOString(),
  }

  const current = readRecentWorkflowTemplates(storage).filter((entry) => entry.id !== template.id)
  const next = [nextEntry, ...current].slice(0, RECENT_WORKFLOW_TEMPLATES_LIMIT)
  writeRecentWorkflowTemplates(next, storage)
  return next
}

export function buildRecentWorkflowTemplateItem(
  template: WorkflowDesignerTemplateListItem | WorkflowDesignerTemplateDetail,
): Pick<RecentWorkflowTemplateItem, 'id' | 'name' | 'description' | 'category' | 'source'> {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    category: template.category,
    source: template.source,
  }
}
