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
  let listGeneration = 0
  let detailGeneration = 0
  let pinnedGeneration = 0

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
    const generation = ++listGeneration
    lastBaseId = baseId
    lastFilters = { ...filters }
    loading.value = true
    loadingMore.value = false
    error.value = null
    invalidateDetail()
    nextCursor.value = null
    searchTruncated.value = false
    try {
      const res = await client.listHistoryEvents(baseId, clientParams(filters))
      if (generation !== listGeneration) return
      batches.value = res.batches
      nextCursor.value = res.nextCursor
      searchTruncated.value = res.searchTruncated
    } catch (err) {
      if (generation !== listGeneration) return
      error.value = err instanceof Error ? err.message : 'Failed to load history'
      batches.value = []
      nextCursor.value = null
      searchTruncated.value = false
    } finally {
      if (generation === listGeneration) loading.value = false
    }
  }

  // T2b "load more": fetch the next cursor page and APPEND. Never throws — on failure it stops paging
  // (clears the cursor) and keeps the batches already shown, so a click can't leak an unhandled rejection.
  async function loadMore(): Promise<void> {
    if (!nextCursor.value || !lastBaseId || loadingMore.value) return
    const generation = listGeneration
    const baseId = lastBaseId
    const filters = lastFilters
    const cursor = nextCursor.value
    loadingMore.value = true
    try {
      const res = await client.listHistoryEvents(baseId, clientParams(filters, cursor))
      if (generation !== listGeneration) return
      batches.value = [...batches.value, ...res.batches]
      nextCursor.value = res.nextCursor
      searchTruncated.value = res.searchTruncated
    } catch {
      if (generation === listGeneration) nextCursor.value = null
    } finally {
      if (generation === listGeneration) loadingMore.value = false
    }
  }

  function invalidateList(): void {
    listGeneration += 1
    lastBaseId = ''
    lastFilters = {}
    batches.value = []
    loading.value = false
    loadingMore.value = false
    error.value = null
    nextCursor.value = null
    searchTruncated.value = false
  }

  function invalidateDetail(): void {
    detailGeneration += 1
    expandedId.value = null
    detail.value = null
    detailLoading.value = false
  }

  async function toggle(baseId: string, batchId: string): Promise<void> {
    if (expandedId.value === batchId) {
      invalidateDetail()
      return
    }
    const generation = ++detailGeneration
    expandedId.value = batchId
    detail.value = null
    detailLoading.value = true
    try {
      const loadedDetail = await client.getHistoryBatch(baseId, batchId)
      if (generation !== detailGeneration) return
      detail.value = loadedDetail
    } catch {
      if (generation === detailGeneration) detail.value = null
    } finally {
      if (generation === detailGeneration) detailLoading.value = false
    }
  }


  // W3-5b: an INDEPENDENT batch-detail fetch for a commit toast's "view in history" deep-link — decoupled
  // from the per-row expandedId/detail pair above so a manual row click elsewhere never clobbers (or is
  // clobbered by) the pinned banner, and the pinned banner keeps showing even after the user expands/
  // collapses unrelated rows. Same never-throw contract as toggle(): a failure surfaces via a null
  // pinnedDetail, never an unhandled rejection.
  const pinnedDetail = ref<HistoryBatchDetail | null>(null)
  const pinnedLoading = ref(false)

  async function loadPinned(baseId: string, batchId: string): Promise<void> {
    const generation = ++pinnedGeneration
    pinnedLoading.value = true
    pinnedDetail.value = null
    try {
      const loadedDetail = await client.getHistoryBatch(baseId, batchId)
      if (generation !== pinnedGeneration) return
      pinnedDetail.value = loadedDetail
    } catch {
      if (generation === pinnedGeneration) pinnedDetail.value = null
    } finally {
      if (generation === pinnedGeneration) pinnedLoading.value = false
    }
  }
  function clearPinned(): void {
    pinnedGeneration += 1
    pinnedDetail.value = null
    pinnedLoading.value = false
  }

  return {
    batches, loading, loadingMore, error, nextCursor, searchTruncated, expandedId, detail, detailLoading, load, loadMore, invalidateList, invalidateDetail, toggle,
    // W3-5b pinned-batch banner (deep-link display, independent of the paged list / row-expansion state)
    pinnedDetail, pinnedLoading, loadPinned, clearPinned,
  }
}
