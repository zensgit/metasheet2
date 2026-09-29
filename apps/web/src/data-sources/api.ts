// Typed client for the generic external data-source connector API.
import { apiGet, apiFetch } from '../utils/api'
import { DATA_SOURCE_LOAD_STATES } from './types'
import type {
  CreateDataSourcePayload,
  DataSourceDetail,
  DataSourceDraftTestResult,
  DataSourceListItem,
  DataSourceLoadFailedItem,
  DataSourceLoadState,
  DataSourceSchemaInfo,
  DataSourceSelectPayload,
  DataSourceSelectResult,
  DataSourceTableInfo,
  DataSourceTestResult,
  RotateDataSourceCredentialsPayload,
  RotateDataSourceCredentialsResult,
  UpdateDataSourcePayload,
} from './types'

interface ListEnvelope {
  ok: boolean
  data?: { items?: DataSourceListItem[]; total?: number; loadFailed?: unknown }
}

interface RotateEnvelope {
  ok?: boolean
  data?: { restartRequired?: unknown }
}

interface DetailEnvelope {
  ok: boolean
  data?: DataSourceDetail
}

interface TestEnvelope {
  ok: boolean
  data?: DataSourceTestResult
}

interface DraftTestEnvelope {
  ok: boolean
  data?: DataSourceDraftTestResult
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
  error?: { code?: string; message?: string; details?: { referenceCount?: number } }
}

/** Read the backend's structured error message off a non-ok Response, falling back to status text. */
async function errorFrom(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as ErrorEnvelope | null
  return body?.error?.message || `${fallback} (${res.status} ${res.statusText})`
}

export interface ListDataSourcesOptions {
  /**
   * Receives the SAME response's `data.loadFailed` sibling (sources that exist but the server could
   * not load), already validated. Opt-in on purpose: the return value stays `data.items` only, so a
   * caller that treats every returned entry as a usable source (the workbench bridge picker) can
   * never be handed a load-failed one.
   */
  onLoadFailed?: (entries: DataSourceLoadFailedItem[]) => void
}

/**
 * Keep the well-formed load-failed entries (an object with a non-empty string id). A state this UI
 * does not know is shown as `load_failed` — still listed (a source must never be invisible), but
 * with the "ask an administrator" badge and no re-seal action: only a KNOWN credential failure is
 * offered one.
 */
export function parseLoadFailedEntries(raw: unknown): DataSourceLoadFailedItem[] {
  if (!Array.isArray(raw)) return []
  const out: DataSourceLoadFailedItem[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.id !== 'string' || e.id.length === 0) continue
    const loadState: DataSourceLoadState = (DATA_SOURCE_LOAD_STATES as readonly string[]).includes(e.loadState as string)
      ? e.loadState as DataSourceLoadState
      : 'load_failed'
    out.push({
      id: e.id,
      name: typeof e.name === 'string' && e.name.length > 0 ? e.name : e.id,
      type: typeof e.type === 'string' ? e.type : '',
      loadState,
      ownerId: typeof e.ownerId === 'string' ? e.ownerId : null,
    })
  }
  return out
}

export async function listDataSources(options: ListDataSourcesOptions = {}): Promise<DataSourceListItem[]> {
  const res = await apiGet<ListEnvelope>('/api/data-sources')
  options.onLoadFailed?.(parseLoadFailedEntries(res.data?.loadFailed))
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

/**
 * Rotate credentials — and, for a source the server could not load (`credentials_unreadable`), the
 * same call re-seals it in place. `restartRequired` is true only when the server saved the
 * credentials but can bring the source live only after a restart.
 */
export async function rotateDataSourceCredentials(
  id: string,
  payload: RotateDataSourceCredentialsPayload,
): Promise<RotateDataSourceCredentialsResult> {
  const res = await apiFetch(`/api/data-sources/${encodeURIComponent(id)}/credentials`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    throw new Error(await errorFrom(res, 'Failed to update data source credentials'))
  }
  const body = (await res.json().catch(() => null)) as RotateEnvelope | null
  return { restartRequired: body?.data?.restartRequired === true }
}

/**
 * Delete a source. The referential guard answers 409 with a coded body, so this reads the envelope
 * itself instead of `errorFrom`: the thrown Error carries the server's `code` and
 * `details.referenceCount` as own properties, which is what lets deleteRefusalCopy say something
 * true in the operator's language rather than echoing English prose about an internal table.
 *
 * Duck-typed properties (not a subclass) on purpose — the same convention as
 * approvals/memberActionErrorCopy, and it survives module mocking in tests.
 */
export async function deleteDataSource(id: string): Promise<void> {
  const res = await apiFetch(`/api/data-sources/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ErrorEnvelope | null
    const message = body?.error?.message || `Failed to delete data source (${res.status} ${res.statusText})`
    const error = new Error(message)
    if (body?.error?.code) Object.assign(error, { code: body.error.code })
    if (typeof body?.error?.details?.referenceCount === 'number') {
      Object.assign(error, { referenceCount: body.error.details.referenceCount })
    }
    throw error
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

/**
 * test-before-save: POST the create-shaped payload to the ephemeral connection-test endpoint. No
 * source is persisted; the response is result-only (the backend never echoes the submitted config).
 */
export async function testDataSourceDraftConnection(
  payload: CreateDataSourcePayload,
): Promise<DataSourceDraftTestResult> {
  const res = await apiFetch('/api/data-sources/test', { method: 'POST', body: JSON.stringify(payload) })
  if (!res.ok) {
    throw new Error(await errorFrom(res, 'Failed to test connection'))
  }
  const body = await res.json() as DraftTestEnvelope
  if (!body.data) {
    throw new Error('Failed to test connection: empty response')
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
