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
type HistoryFilters = { sheetId?: string; actorId?: string; source?: string; action?: string }
type HistoryClient = Pick<typeof multitableClient, 'listHistoryEvents' | 'getHistoryBatch'>

export function useHistoryCenter(client: HistoryClient = multitableClient) {
  const batches = ref<HistoryBatchSummary[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const expandedId = ref<string | null>(null)
  const detail = ref<HistoryBatchDetail | null>(null)
  const detailLoading = ref(false)

  async function load(baseId: string, filters: HistoryFilters = {}): Promise<void> {
    if (!baseId) return
    loading.value = true
    error.value = null
    expandedId.value = null
    detail.value = null
    try {
      const res = await client.listHistoryEvents(baseId, {
        sheetId: filters.sheetId || undefined,
        actorId: filters.actorId || undefined,
        source: filters.source || undefined,
        action: filters.action || undefined,
        limit: 100,
      })
      batches.value = res.batches
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to load history'
      batches.value = []
    } finally {
      loading.value = false
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

  return { batches, loading, error, expandedId, detail, detailLoading, load, toggle }
}
