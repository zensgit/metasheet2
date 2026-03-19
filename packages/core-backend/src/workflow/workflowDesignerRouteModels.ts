import type { WorkflowDefinition } from './WorkflowDesigner'
import {
  getWorkflowDraftRole,
  hasWorkflowDraftAccess,
  toWorkflowDraftRecord,
  type WorkflowDefinitionRowLike,
} from './workflowDesignerDrafts'

export interface WorkflowDesignerNodeLibraryRowLike {
  id: string
  node_type: string
  display_name: string
  category: string
  description: string | null
  properties_schema: string | null
  default_properties: string | null
  validation_rules: string | null
  visual_config: string | null
  is_active: boolean
  created_at: Date
  updated_at: Date
}

export interface WorkflowDesignerTemplateRowLike {
  id: string
  name: string
  description: string | null
  category: string
  template_definition: string | null
  required_variables: string | null
  optional_variables: string | null
  tags: string | null
  is_public: boolean
  is_featured: boolean
  usage_count: number
  created_by: string
  created_at: Date
  updated_at: Date
}

export interface WorkflowDesignerTemplateListItem {
  id: string
  name: string
  description: string
  category: string
  template_definition: WorkflowDefinition | Record<string, unknown>
  required_variables: string[]
  optional_variables: string[]
  tags: string[]
  is_public: boolean
  is_featured: boolean
  usage_count: number
  created_by: string
  created_at: Date
  updated_at: Date
  source: 'builtin' | 'database'
}

export interface WorkflowDesignerListFilters {
  category?: string
  status?: string
  search?: string
  sortBy?: 'updated_at' | 'created_at' | 'name'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface WorkflowDesignerTemplateFilters {
  category?: string
  featured?: boolean
  search?: string
  source?: 'all' | 'builtin' | 'database'
  sortBy?: 'usage_count' | 'name' | 'updated_at'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface WorkflowDesignerPagedResult<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.name === 'string' && Array.isArray(record.nodes) && Array.isArray(record.edges)
}

function parseJsonStringArray(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : []
  } catch {
    return []
  }
}

export function mapWorkflowDesignerNodeLibraryRow(row: WorkflowDesignerNodeLibraryRowLike) {
  return {
    ...row,
    properties_schema: parseJsonObject(row.properties_schema),
    default_properties: parseJsonObject(row.default_properties),
    validation_rules: parseJsonObject(row.validation_rules),
    visual_config: parseJsonObject(row.visual_config),
  }
}

function splitTemplateVariables(template: WorkflowDefinition) {
  const entries = Object.entries(template.variables ?? {})
  return {
    required: entries
      .filter(([, definition]) => Boolean(definition?.required))
      .map(([name]) => name),
    optional: entries
      .filter(([, definition]) => !definition?.required)
      .map(([name]) => name),
  }
}

export function mapBuiltinWorkflowTemplate(template: WorkflowDefinition): WorkflowDesignerTemplateListItem {
  const variables = splitTemplateVariables(template)

  return {
    id: template.id ?? template.name,
    name: template.name,
    description: template.description ?? '',
    category: template.category ?? 'general',
    template_definition: template,
    required_variables: variables.required,
    optional_variables: variables.optional,
    tags: template.tags ?? [],
    is_public: true,
    is_featured: true,
    usage_count: 0,
    created_by: 'system',
    created_at: new Date(0),
    updated_at: new Date(0),
    source: 'builtin',
  }
}

export function mapWorkflowDesignerTemplateRow(row: WorkflowDesignerTemplateRowLike): WorkflowDesignerTemplateListItem {
  const templateDefinition = parseJsonObject(row.template_definition)
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    category: row.category,
    template_definition: templateDefinition,
    required_variables: parseJsonStringArray(row.required_variables),
    optional_variables: parseJsonStringArray(row.optional_variables),
    tags: parseJsonStringArray(row.tags),
    is_public: row.is_public,
    is_featured: row.is_featured,
    usage_count: row.usage_count,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source: 'database',
  }
}

export function extractWorkflowTemplateDefinition(template: WorkflowDesignerTemplateListItem): WorkflowDefinition | null {
  return isWorkflowDefinition(template.template_definition) ? template.template_definition : null
}

export function buildDuplicatedWorkflowName(name: string): string {
  const baseName = name.trim() || 'Untitled workflow'
  const match = baseName.match(/^(.*?)(?: Copy(?: (\d+))?)$/)

  if (!match) return `${baseName} Copy`

  const stem = match[1]?.trim() || 'Untitled workflow'
  const nextIndex = Number.parseInt(match[2] ?? '1', 10) + 1
  return `${stem} Copy ${nextIndex}`
}

export function buildWorkflowDesignerTemplateItems(input: {
  builtinTemplates: WorkflowDefinition[]
  databaseTemplates?: WorkflowDesignerTemplateRowLike[]
  filters?: WorkflowDesignerTemplateFilters
}): WorkflowDesignerPagedResult<WorkflowDesignerTemplateListItem> {
  const builtin = input.builtinTemplates.map(mapBuiltinWorkflowTemplate)
  const database = (input.databaseTemplates ?? []).map(mapWorkflowDesignerTemplateRow)
  const merged = new Map<string, WorkflowDesignerTemplateListItem>()
  const category = input.filters?.category
  const featured = input.filters?.featured
  const search = typeof input.filters?.search === 'string'
    ? input.filters.search.trim().toLowerCase()
    : ''
  const source = input.filters?.source ?? 'all'
  const sortBy = input.filters?.sortBy ?? 'usage_count'
  const sortOrder = input.filters?.sortOrder ?? 'desc'
  const limit = input.filters?.limit ?? 50
  const offset = input.filters?.offset ?? 0

  for (const template of builtin) {
    merged.set(template.id, template)
  }

  for (const template of database) {
    merged.set(template.id, template)
  }

  const filtered = Array.from(merged.values())
    .filter((template) => !category || template.category === category)
    .filter((template) => !featured || template.is_featured)
    .filter((template) => source === 'all' || template.source === source)
    .filter((template) => {
      if (!search) return true
      return [
        template.name,
        template.description,
        ...template.tags,
      ].some((value) => value.toLowerCase().includes(search))
    })
    .sort((left, right) => {
      let comparison = 0

      if (sortBy === 'name') {
        comparison = left.name.localeCompare(right.name)
      } else if (sortBy === 'updated_at') {
        comparison = left.updated_at.getTime() - right.updated_at.getTime()
      } else {
        comparison = left.usage_count - right.usage_count
        if (comparison === 0) {
          comparison = left.name.localeCompare(right.name)
        }
      }

      return sortOrder === 'asc' ? comparison : -comparison
    })

  return {
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
    limit,
    offset,
  }
}

export function buildWorkflowDraftListItems(input: {
  rows: WorkflowDefinitionRowLike[]
  userId?: string | null
  filters?: WorkflowDesignerListFilters
}): WorkflowDesignerPagedResult<{
  id: string
  name: string
  description: string
  category: string | null
  status: string
  created_at: Date
  updated_at: Date
  role: ReturnType<typeof getWorkflowDraftRole>
}> {
  const category = input.filters?.category
  const status = input.filters?.status
  const search = typeof input.filters?.search === 'string'
    ? input.filters.search.trim().toLowerCase()
    : ''
  const sortBy = input.filters?.sortBy ?? 'updated_at'
  const sortOrder = input.filters?.sortOrder ?? 'desc'
  const limit = input.filters?.limit ?? 50
  const offset = input.filters?.offset ?? 0

  const filtered = input.rows
    .map((row) => toWorkflowDraftRecord(row))
    .filter((workflow) => hasWorkflowDraftAccess(workflow, input.userId))
    .filter((workflow) => !category || workflow.category === category)
    .filter((workflow) => !status || workflow.status === status)
    .filter((workflow) => {
      if (!search) return true
      return workflow.name.toLowerCase().includes(search) || workflow.description.toLowerCase().includes(search)
    })
    .sort((left, right) => {
      let comparison = 0

      if (sortBy === 'name') {
        comparison = left.name.localeCompare(right.name)
      } else if (sortBy === 'created_at') {
        comparison = left.createdAt.getTime() - right.createdAt.getTime()
      } else {
        comparison = left.updatedAt.getTime() - right.updatedAt.getTime()
      }

      return sortOrder === 'asc' ? comparison : -comparison
    })
    .map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      category: workflow.category ?? null,
      status: workflow.status,
      created_at: workflow.createdAt,
      updated_at: workflow.updatedAt,
      role: getWorkflowDraftRole(workflow, input.userId),
    }))

  return {
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
    limit,
    offset,
  }
}
