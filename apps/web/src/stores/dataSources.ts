// External data-source connector store (UI-1: list / create / delete). Edit is deferred to UI-2 —
// it needs omit-blank-not-empty credential handling + PUT deep-merge, which warrant their own slice.
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { createDataSource, deleteDataSource, listDataSources } from '../data-sources/api'
import type { CreateDataSourcePayload, DataSourceListItem } from '../data-sources/types'

export const useDataSourcesStore = defineStore('dataSources', () => {
  const items = ref<DataSourceListItem[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchAll(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      items.value = await listDataSources()
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load data sources'
    } finally {
      loading.value = false
    }
  }

  /** Create then refresh. Returns true on success; on failure sets `error` and returns false. */
  async function create(payload: CreateDataSourcePayload): Promise<boolean> {
    error.value = null
    try {
      await createDataSource(payload)
      await fetchAll()
      return true
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to create data source'
      return false
    }
  }

  /** Delete then refresh. Returns true on success; on failure sets `error` and returns false. */
  async function remove(id: string): Promise<boolean> {
    error.value = null
    try {
      await deleteDataSource(id)
      await fetchAll()
      return true
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to delete data source'
      return false
    }
  }

  return { items, loading, error, fetchAll, create, remove }
})
