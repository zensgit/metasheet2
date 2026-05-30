// Typed client for the generic external data-source connector API (UI-1: list / create / delete).
import { apiGet, apiFetch } from '../utils/api'
import type { CreateDataSourcePayload, DataSourceListItem } from './types'

interface ListEnvelope {
  ok: boolean
  data?: { items?: DataSourceListItem[]; total?: number }
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

export async function createDataSource(payload: CreateDataSourcePayload): Promise<void> {
  const res = await apiFetch('/api/data-sources', { method: 'POST', body: JSON.stringify(payload) })
  if (!res.ok) {
    throw new Error(await errorFrom(res, 'Failed to create data source'))
  }
}

export async function deleteDataSource(id: string): Promise<void> {
  const res = await apiFetch(`/api/data-sources/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) {
    throw new Error(await errorFrom(res, 'Failed to delete data source'))
  }
}
