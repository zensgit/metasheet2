import {
  listWorkflowDrafts,
  listWorkflowTemplates,
  loadWorkflowTemplate,
  type WorkflowDesignerTemplateDetail,
  type WorkflowDesignerTemplateQuery,
  type WorkflowDesignerWorkflowQuery,
} from './workflowDesignerPersistence'

const DEFAULT_CATALOG_CACHE_TTL_MS = 30_000

interface CacheEntry<T> {
  expiresAt: number
  value?: T
  promise?: Promise<T>
}

const workflowDraftCache = new Map<string, CacheEntry<Awaited<ReturnType<typeof listWorkflowDrafts>>>>()
const workflowTemplateCache = new Map<string, CacheEntry<Awaited<ReturnType<typeof listWorkflowTemplates>>>>()
const workflowTemplateDetailCache = new Map<string, CacheEntry<WorkflowDesignerTemplateDetail>>()

function normalizeRecord(input: Record<string, unknown>) {
  return Object.entries(input)
    .filter(([, value]) => value !== undefined && value !== '')
    .sort(([left], [right]) => left.localeCompare(right))
}

function buildCacheKey(input: Record<string, unknown>) {
  return JSON.stringify(normalizeRecord(input))
}

function isFresh<T>(entry: CacheEntry<T> | undefined, now: number) {
  return Boolean(entry?.value) && Boolean(entry?.expiresAt && entry.expiresAt > now)
}

async function resolveCached<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  loader: () => Promise<T>,
  force = false,
  ttlMs = DEFAULT_CATALOG_CACHE_TTL_MS,
): Promise<T> {
  const now = Date.now()
  const existing = cache.get(key)

  if (!force && isFresh(existing, now)) {
    return existing!.value as T
  }

  if (!force && existing?.promise) {
    return existing.promise
  }

  const pending = loader()
    .then((value) => {
      cache.set(key, {
        value,
        expiresAt: Date.now() + ttlMs,
      })
      return value
    })
    .catch((error) => {
      cache.delete(key)
      throw error
    })

  cache.set(key, {
    value: existing?.value,
    expiresAt: existing?.expiresAt ?? 0,
    promise: pending,
  })

  return pending
}

export async function listWorkflowDraftsCached(
  query: WorkflowDesignerWorkflowQuery = {},
  options: { force?: boolean; ttlMs?: number } = {},
) {
  const key = buildCacheKey(query as Record<string, unknown>)
  return resolveCached(
    workflowDraftCache,
    key,
    () => listWorkflowDrafts(query),
    options.force,
    options.ttlMs,
  )
}

export async function listWorkflowTemplatesCached(
  query: WorkflowDesignerTemplateQuery = {},
  options: { force?: boolean; ttlMs?: number } = {},
) {
  const key = buildCacheKey(query as Record<string, unknown>)
  return resolveCached(
    workflowTemplateCache,
    key,
    () => listWorkflowTemplates(query),
    options.force,
    options.ttlMs,
  )
}

export async function loadWorkflowTemplateCached(
  templateId: string,
  options: { force?: boolean; ttlMs?: number } = {},
) {
  return resolveCached(
    workflowTemplateDetailCache,
    templateId,
    () => loadWorkflowTemplate(templateId),
    options.force,
    options.ttlMs,
  )
}

export function invalidateWorkflowDraftCatalogCache() {
  workflowDraftCache.clear()
}

export function invalidateWorkflowTemplateCatalogCache() {
  workflowTemplateCache.clear()
}

export function invalidateWorkflowTemplateDetailCache(templateId?: string) {
  if (templateId) {
    workflowTemplateDetailCache.delete(templateId)
    return
  }
  workflowTemplateDetailCache.clear()
}

export function resetWorkflowDesignerCatalogCache() {
  workflowDraftCache.clear()
  workflowTemplateCache.clear()
  workflowTemplateDetailCache.clear()
}
