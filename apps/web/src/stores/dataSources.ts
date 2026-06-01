// External data-source connector store (UI-1..UI-4: list / create / update / credential rotation / delete / test).
import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  createDataSource,
  deleteDataSource,
  getDataSource,
  getDataSourceSchema,
  getDataSourceTableInfo,
  listDataSources,
  previewDataSourceRows,
  rotateDataSourceCredentials,
  testDataSourceConnection,
  updateDataSource,
} from '../data-sources/api'
import type {
  CreateDataSourcePayload,
  DataSourceDetail,
  DataSourceListItem,
  DataSourceSchemaInfo,
  DataSourceSelectPayload,
  DataSourceSelectResult,
  DataSourceTableInfo,
  DataSourceTestResult,
  RotateDataSourceCredentialsPayload,
  UpdateDataSourcePayload,
} from '../data-sources/types'

function tableDetailKey(id: string, table: string, schema?: string): string {
  return `${id}:${schema ? `${schema}.` : ''}${table}`
}

export const useDataSourcesStore = defineStore('dataSources', () => {
  const items = ref<DataSourceListItem[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const testing = ref<Record<string, boolean>>({})
  const testResults = ref<Record<string, DataSourceTestResult>>({})
  const schemaLoading = ref<Record<string, boolean>>({})
  const tableInfoLoading = ref<Record<string, boolean>>({})
  const previewLoading = ref<Record<string, boolean>>({})
  const schemas = ref<Record<string, DataSourceSchemaInfo>>({})
  const tableDetails = ref<Record<string, DataSourceTableInfo>>({})
  const schemaErrors = ref<Record<string, string>>({})
  const previewResults = ref<Record<string, DataSourceSelectResult>>({})
  const previewErrors = ref<Record<string, string>>({})

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

  async function loadDetail(id: string): Promise<DataSourceDetail | null> {
    error.value = null
    try {
      return await getDataSource(id)
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load data source'
      return null
    }
  }

  /** Update non-secret config then refresh. Credential rotation is not part of UI-3. */
  async function update(id: string, payload: UpdateDataSourcePayload): Promise<boolean> {
    error.value = null
    try {
      await updateDataSource(id, payload)
      const remainingResults = { ...testResults.value }
      delete remainingResults[id]
      testResults.value = remainingResults
      await fetchAll()
      return true
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to update data source'
      return false
    }
  }

  /** Rotate write-only credentials then refresh. Blank fields are omitted by the payload builder. */
  async function rotateCredentials(id: string, payload: RotateDataSourceCredentialsPayload): Promise<boolean> {
    error.value = null
    try {
      await rotateDataSourceCredentials(id, payload)
      const remainingResults = { ...testResults.value }
      delete remainingResults[id]
      testResults.value = remainingResults
      await fetchAll()
      return true
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to update data source credentials'
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

  function isSchemaLoading(id: string): boolean {
    return schemaLoading.value[id] === true
  }

  function isPreviewLoading(id: string): boolean {
    return previewLoading.value[id] === true
  }

  function isTableInfoLoading(key: string): boolean {
    return tableInfoLoading.value[key] === true
  }

  function clearPreviewError(id: string): void {
    previewErrors.value = { ...previewErrors.value, [id]: '' }
  }

  async function loadSchema(id: string): Promise<DataSourceSchemaInfo | null> {
    schemaErrors.value = { ...schemaErrors.value, [id]: '' }
    clearPreviewError(id)
    schemaLoading.value = { ...schemaLoading.value, [id]: true }
    try {
      const schema = await getDataSourceSchema(id)
      schemas.value = { ...schemas.value, [id]: schema }
      return schema
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load data source schema'
      schemaErrors.value = { ...schemaErrors.value, [id]: message }
      previewErrors.value = { ...previewErrors.value, [id]: message }
      return null
    } finally {
      const remaining = { ...schemaLoading.value }
      delete remaining[id]
      schemaLoading.value = remaining
    }
  }

  async function loadTableInfo(id: string, table: string, schema?: string): Promise<DataSourceTableInfo | null> {
    const key = tableDetailKey(id, table, schema)
    schemaErrors.value = { ...schemaErrors.value, [id]: '' }
    tableInfoLoading.value = { ...tableInfoLoading.value, [key]: true }
    try {
      const detail = await getDataSourceTableInfo(id, table, schema)
      tableDetails.value = { ...tableDetails.value, [key]: detail }
      return detail
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load data source table info'
      schemaErrors.value = { ...schemaErrors.value, [id]: message }
      return null
    } finally {
      const remaining = { ...tableInfoLoading.value }
      delete remaining[key]
      tableInfoLoading.value = remaining
    }
  }

  async function previewRows(id: string, payload: DataSourceSelectPayload): Promise<DataSourceSelectResult | null> {
    clearPreviewError(id)
    previewLoading.value = { ...previewLoading.value, [id]: true }
    try {
      const result = await previewDataSourceRows(id, payload)
      previewResults.value = { ...previewResults.value, [id]: result }
      return result
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to preview data source rows'
      previewErrors.value = { ...previewErrors.value, [id]: message }
      return null
    } finally {
      const remaining = { ...previewLoading.value }
      delete remaining[id]
      previewLoading.value = remaining
    }
  }

  return {
    items,
    loading,
    error,
    testing,
    testResults,
    schemaLoading,
    tableInfoLoading,
    previewLoading,
    schemas,
    tableDetails,
    schemaErrors,
    previewResults,
    previewErrors,
    isTesting,
    isSchemaLoading,
    isTableInfoLoading,
    isPreviewLoading,
    clearPreviewError,
    tableDetailKey,
    fetchAll,
    create,
    loadDetail,
    update,
    rotateCredentials,
    remove,
    testConnection,
    loadSchema,
    loadTableInfo,
    previewRows,
  }
})
