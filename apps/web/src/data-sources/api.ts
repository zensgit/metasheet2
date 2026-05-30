// Typed client for the generic external data-source connector API.
import { apiGet, apiFetch } from '../utils/api'
import type {
  CreateDataSourcePayload,
  DataSourceDetail,
  DataSourceListItem,
  DataSourceTestResult,
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
