import { ref } from 'vue'
import { multitableClient } from '../api/client'
import type { HistoryBatchSummary, HistoryBatchDetail } from '../types'

/**
 * Global History & Point-in-Time Restore — T2/T3 read-only history center data.
 *
 * Loads permission-filtered change batches (the backend already applies LOCK-3; the FE renders what it is
 * given and never reconstructs hidden rows) and lazily loads a batch's detail on expand. `load`/`toggle`
 * NEVER throw — a failure surfaces via `error` / a null detail, so a click can't leak an unhandled
 * rejection. The client is injectable for testing.
 */
type HistoryFilters = { sheetId?: string; actorId?: string; source?: string; action?: string; from?: string; to?: string; fieldId?: string; search?: string }
type HistoryClient = Pick<typeof multitableClient, 'listHistoryEvents' | 'getHistoryBatch'>

export function useHistoryCenter(client: HistoryClient = multitableClient) {
  const batches = ref<HistoryBatchSummary[]>([])
  const loading = ref(false)
  const loadingMore = ref(false)
  const error = ref<string | null>(null)
  const nextCursor = ref<string | null>(null) // T2b cursor: present → another page is reachable
  const searchTruncated = ref(false) // T2b: search hit the candidate cap → results + total are bounded
  const expandedId = ref<string | null>(null)
  const detail = ref<HistoryBatchDetail | null>(null)
  const detailLoading = ref(false)
  // Remembered for loadMore so the next page reuses the SAME filter set (a cursor is only valid for its filters).
  let lastBaseId = ''
  let lastFilters: HistoryFilters = {}

  const clientParams = (filters: HistoryFilters, cursor?: string) => ({
    sheetId: filters.sheetId || undefined,
    actorId: filters.actorId || undefined,
    source: filters.source || undefined,
    action: filters.action || undefined,
    from: filters.from || undefined,
    to: filters.to || undefined,
    fieldId: filters.fieldId || undefined,
    q: filters.search || undefined,
    cursor,
    limit: 100,
  })

  async function load(baseId: string, filters: HistoryFilters = {}): Promise<void> {
    if (!baseId) return
    lastBaseId = baseId
    lastFilters = filters
    loading.value = true
    error.value = null
    expandedId.value = null
    detail.value = null
    nextCursor.value = null
    searchTruncated.value = false
    try {
      const res = await client.listHistoryEvents(baseId, clientParams(filters))
      batches.value = res.batches
      nextCursor.value = res.nextCursor
      searchTruncated.value = res.searchTruncated
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to load history'
      batches.value = []
      nextCursor.value = null
      searchTruncated.value = false
    } finally {
      loading.value = false
    }
  }

  // T2b "load more": fetch the next cursor page and APPEND. Never throws — on failure it stops paging
  // (clears the cursor) and keeps the batches already shown, so a click can't leak an unhandled rejection.
  async function loadMore(): Promise<void> {
    if (!nextCursor.value || !lastBaseId || loadingMore.value) return
    loadingMore.value = true
    try {
      const res = await client.listHistoryEvents(lastBaseId, clientParams(lastFilters, nextCursor.value))
      batches.value = [...batches.value, ...res.batches]
      nextCursor.value = res.nextCursor
      searchTruncated.value = res.searchTruncated
    } catch {
      nextCursor.value = null
    } finally {
      loadingMore.value = false
    }
  }

  async function toggle(baseId: string, batchId: string): Promise<void> {
    if (expandedId.value === batchId) {
      expandedId.value = null
      return
    }
    expandedId.value = batchId
    detail.value = null
    detailLoading.value = true
    try {
      detail.value = await client.getHistoryBatch(baseId, batchId)
    } catch {
      detail.value = null
    } finally {
      detailLoading.value = false
    }
  }

  return { batches, loading, loadingMore, error, nextCursor, searchTruncated, expandedId, detail, detailLoading, load, loadMore, toggle }
}
