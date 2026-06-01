// Typed client for the generic external data-source connector API.
import { apiGet, apiFetch } from '../utils/api'
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
} from './types'

interface ListEnvelope {
  ok: boolean
  data?: { items?: DataSourceListItem[]; total?: number }
}

interface DetailEnvelope {
  ok: boolean
  data?: DataSourceDetail
}

interface TestEnvelope {
  ok: boolean
  data?: DataSourceTestResult
}

interface SchemaEnvelope {
  ok: boolean
  data?: DataSourceSchemaInfo
}

interface TableInfoEnvelope {
  ok: boolean
  data?: DataSourceTableInfo
}

interface SelectEnvelope {
  ok: boolean
  data?: DataSourceSelectResult
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string }
}

/** Read the backend's structured error message off a non-ok Response, falling back to status text. */
async function errorFrom(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as ErrorEnvelope | null
  return body?.error?.message || `${fallback} (${res.status} ${res.statusText})`
}

export async function listDataSources(): Promise<DataSourceListItem[]> {
  const res = await apiGet<ListEnvelope>('/api/data-sources')
  return res.data?.items ?? []
}

export async function getDataSource(id: string): Promise<DataSourceDetail> {
  const res = await apiGet<DetailEnvelope>(`/api/data-sources/${encodeURIComponent(id)}`)
  if (!res.data) {
    throw new Error('Failed to load data source: empty response')
  }
  return res.data
}

export async function createDataSource(payload: CreateDataSourcePayload): Promise<void> {
  const res = await apiFetch('/api/data-sources', { method: 'POST', body: JSON.stringify(payload) })
  if (!res.ok) {
    throw new Error(await errorFrom(res, 'Failed to create data source'))
  }
}

export async function updateDataSource(id: string, payload: UpdateDataSourcePayload): Promise<void> {
  const res = await apiFetch(`/api/data-sources/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    throw new Error(await errorFrom(res, 'Failed to update data source'))
  }
}

export async function rotateDataSourceCredentials(
  id: string,
  payload: RotateDataSourceCredentialsPayload,
): Promise<void> {
  const res = await apiFetch(`/api/data-sources/${encodeURIComponent(id)}/credentials`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    throw new Error(await errorFrom(res, 'Failed to update data source credentials'))
  }
}

export async function deleteDataSource(id: string): Promise<void> {
  const res = await apiFetch(`/api/data-sources/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) {
    throw new Error(await errorFrom(res, 'Failed to delete data source'))
  }
}

export async function testDataSourceConnection(id: string): Promise<DataSourceTestResult> {
  const res = await apiFetch(`/api/data-sources/${encodeURIComponent(id)}/test`)
  if (!res.ok) {
    throw new Error(await errorFrom(res, 'Failed to test data source'))
  }
  const body = await res.json() as TestEnvelope
  if (!body.data) {
    throw new Error('Failed to test data source: empty response')
  }
  return body.data
}

export async function getDataSourceSchema(id: string): Promise<DataSourceSchemaInfo> {
  const res = await apiFetch(`/api/data-sources/${encodeURIComponent(id)}/schema`)
  if (!res.ok) {
    throw new Error(await errorFrom(res, 'Failed to load data source schema'))
  }
  const body = await res.json() as SchemaEnvelope
  if (!body.data) {
    throw new Error('Failed to load data source schema: empty response')
  }
  return body.data
}

export async function getDataSourceTableInfo(
  id: string,
  table: string,
  schema?: string,
): Promise<DataSourceTableInfo> {
  const params = new URLSearchParams()
  if (schema) params.set('schema', schema)
  const query = params.toString()
  const res = await apiFetch(
    `/api/data-sources/${encodeURIComponent(id)}/tables/${encodeURIComponent(table)}${query ? `?${query}` : ''}`,
  )
  if (!res.ok) {
    throw new Error(await errorFrom(res, 'Failed to load data source table info'))
  }
  const body = await res.json() as TableInfoEnvelope
  if (!body.data) {
    throw new Error('Failed to load data source table info: empty response')
  }
  return body.data
}

export async function previewDataSourceRows(
  id: string,
  payload: DataSourceSelectPayload,
): Promise<DataSourceSelectResult> {
  const res = await apiFetch(`/api/data-sources/${encodeURIComponent(id)}/select`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    throw new Error(await errorFrom(res, 'Failed to preview data source rows'))
  }
  const body = await res.json() as SelectEnvelope
  if (!body.data) {
    throw new Error('Failed to preview data source rows: empty response')
  }
  return body.data
}
