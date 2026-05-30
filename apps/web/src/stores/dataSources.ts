// External data-source connector store (UI-1/UI-2: list / create / delete / test). Edit is deferred —
// it needs omit-blank-not-empty credential handling + PUT deep-merge, which warrant their own slice.
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { createDataSource, deleteDataSource, listDataSources, testDataSourceConnection } from '../data-sources/api'
import type { CreateDataSourcePayload, DataSourceListItem, DataSourceTestResult } from '../data-sources/types'

export const useDataSourcesStore = defineStore('dataSources', () => {
  const items = ref<DataSourceListItem[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const testing = ref<Record<string, boolean>>({})
  const testResults = ref<Record<string, DataSourceTestResult>>({})

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
      const remainingResults = { ...testResults.value }
      delete remainingResults[id]
      testResults.value = remainingResults
      await fetchAll()
      return true
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to delete data source'
      return false
    }
  }

  function isTesting(id: string): boolean {
    return testing.value[id] === true
  }

  async function testConnection(id: string): Promise<boolean> {
    error.value = null
    testing.value = { ...testing.value, [id]: true }
    try {
      const result = await testDataSourceConnection(id)
      testResults.value = { ...testResults.value, [id]: result }
      await fetchAll()
      return result.success
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to test data source'
      return false
    } finally {
      const remaining = { ...testing.value }
      delete remaining[id]
      testing.value = remaining
    }
  }

  return { items, loading, error, testing, testResults, isTesting, fetchAll, create, remove, testConnection }
})
