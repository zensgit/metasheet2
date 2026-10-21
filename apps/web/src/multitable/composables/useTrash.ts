// Current deleted-record list + restore for a sheet. UI actions never throw: server refusals and
// malformed restore replies stay visible as errors rather than becoming a local success state.
import { ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { MetaDeletedRecord } from '../types'
import { MultitableApiClient, multitableClient } from '../api/client'

const SELECTED_PAGE_SIZE = 100

export function useTrash(client?: MultitableApiClient) {
  const api = client ?? multitableClient
  const { isZh } = useLocale()
  const records = ref<MetaDeletedRecord[]>([])
  const total = ref(0)
  const loading = ref(false)
  const loadingMore = ref(false)
  const error = ref<string | null>(null)
  const restoringIds = ref<string[]>([])
  let generation = 0
  let nextRestoreToken = 0
  const restoreTokens = new Map<string, number>()

  const t = (zh: string, en: string) => (isZh.value ? zh : en)

  const isCurrent = (token: number) => token === generation

  function begin(): number {
    generation += 1
    loading.value = true
    error.value = null
    return generation
  }

  function finish(token: number): void {
    if (isCurrent(token)) loading.value = false
  }

  async function load(sheetId: string, params?: { limit?: number; offset?: number }): Promise<MetaDeletedRecord[]> {
    if (!sheetId) return records.value
    const token = begin()
    try {
      const res = await api.listDeletedRecords(sheetId, params)
      if (!isCurrent(token)) return records.value
      records.value = res.records
      total.value = res.total
      return res.records
    } catch (e: unknown) {
      if (!isCurrent(token)) return records.value
      error.value = (e as { message?: string })?.message ?? t('加载已删除的记录失败', 'Failed to load deleted records')
      return records.value
    } finally {
      finish(token)
    }
  }

  async function loadMore(sheetId: string): Promise<MetaDeletedRecord[]> {
    if (!sheetId || loading.value || loadingMore.value || restoreTokens.size > 0 || records.value.length >= total.value) return records.value
    const offset = records.value.length
    const token = ++generation
    loadingMore.value = true
    error.value = null
    try {
      const res = await api.listDeletedRecords(sheetId, { limit: SELECTED_PAGE_SIZE, offset })
      if (!isCurrent(token)) return records.value
      records.value = [...records.value, ...res.records]
      total.value = res.total
      return records.value
    } catch (e: unknown) {
      if (isCurrent(token)) {
        error.value = (e as { message?: string })?.message ?? t('加载已删除的记录失败', 'Failed to load deleted records')
      }
      return records.value
    } finally {
      if (isCurrent(token)) loadingMore.value = false
    }
  }

  // A history selection is not a recovery snapshot. Find its record in the CURRENT server list before
  // allowing confirmation; page until found or the server's reported total is exhausted.
  async function loadSelected(sheetId: string, recordId: string): Promise<boolean> {
    if (!sheetId || !recordId) return false
    const token = begin()
    records.value = []
    total.value = 0
    let offset = 0
    try {
      while (isCurrent(token)) {
        const res = await api.listDeletedRecords(sheetId, { limit: SELECTED_PAGE_SIZE, offset })
        if (!isCurrent(token)) return false
        records.value = [...records.value, ...res.records]
        total.value = res.total
        if (res.records.some((record) => record.recordId === recordId)) return true
        offset += res.records.length
        if (res.records.length === 0 || offset >= res.total) return false
      }
      return false
    } catch (e: unknown) {
      if (isCurrent(token)) {
        error.value = (e as { message?: string })?.message ?? t('加载已删除的记录失败', 'Failed to load deleted records')
      }
      return false
    } finally {
      finish(token)
    }
  }

  // Returns true only when the API confirms the requested record id on the expected current sheet.
  async function restore(recordId: string, sheetId: string): Promise<boolean> {
    if (!recordId || !sheetId || loading.value || loadingMore.value || restoreTokens.has(recordId)) return false
    const operationGeneration = generation
    const restoreToken = ++nextRestoreToken
    restoreTokens.set(recordId, restoreToken)
    restoringIds.value = [...restoreTokens.keys()]
    error.value = null
    try {
      const result = await api.restoreDeletedRecord(recordId)
      if (result.restored !== recordId || result.sheetId !== sheetId) {
        throw new Error(t('恢复结果与当前已删除记录不匹配', 'Restore response did not match the current deleted record'))
      }
      if (!isCurrent(operationGeneration) || restoreTokens.get(recordId) !== restoreToken) return false
      records.value = records.value.filter((record) => record.recordId !== recordId)
      total.value = Math.max(0, total.value - 1)
      return true
    } catch (e: unknown) {
      if (isCurrent(operationGeneration) && restoreTokens.get(recordId) === restoreToken) {
        error.value = (e as { message?: string })?.message ?? t('恢复记录失败', 'Failed to restore the record')
      }
      return false
    } finally {
      if (restoreTokens.get(recordId) === restoreToken) {
        restoreTokens.delete(recordId)
        restoringIds.value = [...restoreTokens.keys()]
      }
    }
  }

  function reset(): void {
    generation += 1
    restoreTokens.clear()
    records.value = []
    total.value = 0
    loading.value = false
    loadingMore.value = false
    error.value = null
    restoringIds.value = []
  }

  return { records, total, loading, loadingMore, error, restoringIds, load, loadMore, loadSelected, restore, reset }
}
