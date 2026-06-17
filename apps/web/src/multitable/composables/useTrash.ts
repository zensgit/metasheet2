// #15 recycle bin — deleted-records list + restore for a sheet. Mirrors useNotificationInbox: a list +
// loading/error state + a per-record restore action. UI-facing actions NEVER throw — failure (e.g. a 409
// id-occupied conflict or a 403) surfaces via `error` and resolves, so a click can't leak an unhandled
// rejection. Locale-reactive labels via useLocale (inline zh/en for this module's own strings).
import { ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { MetaDeletedRecord } from '../types'
import { MultitableApiClient, multitableClient } from '../api/client'

export function useTrash(client?: MultitableApiClient) {
  const api = client ?? multitableClient
  const { isZh } = useLocale()
  const records = ref<MetaDeletedRecord[]>([])
  const total = ref(0)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const restoringIds = ref<string[]>([])

  const t = (zh: string, en: string) => (isZh.value ? zh : en)

  async function load(sheetId: string, params?: { limit?: number; offset?: number }): Promise<MetaDeletedRecord[]> {
    if (!sheetId) return records.value
    loading.value = true
    error.value = null
    try {
      const res = await api.listDeletedRecords(sheetId, params)
      records.value = res.records
      total.value = res.total
      return res.records
    } catch (e: unknown) {
      error.value = (e as { message?: string })?.message ?? t('加载回收站失败', 'Failed to load the recycle bin')
      return records.value
    } finally {
      loading.value = false
    }
  }

  // Returns true on success. Never throws — a 409 (id occupied) / 403 surfaces via `error`.
  async function restore(recordId: string): Promise<boolean> {
    if (!recordId || restoringIds.value.includes(recordId)) return false
    restoringIds.value = [...restoringIds.value, recordId]
    error.value = null
    try {
      await api.restoreDeletedRecord(recordId)
      records.value = records.value.filter((r) => r.recordId !== recordId)
      total.value = Math.max(0, total.value - 1)
      return true
    } catch (e: unknown) {
      error.value = (e as { message?: string })?.message ?? t('恢复记录失败', 'Failed to restore the record')
      return false
    } finally {
      restoringIds.value = restoringIds.value.filter((id) => id !== recordId)
    }
  }

  return { records, total, loading, error, restoringIds, load, restore }
}
