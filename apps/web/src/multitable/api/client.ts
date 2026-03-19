/**
 * MultitableApiClient — typed wrapper for all /api/multitable/* endpoints.
 * Uses apiFetch from project utils; accepts optional fetchFn for tests.
 */
import type {
  MetaBase,
  MetaSheet,
  MetaField,
  MetaView,
  MetaViewData,
  MetaContext,
  MetaRecord,
  MetaRecordContext,
  MetaFormContext,
  PatchResult,
  FormSubmitResult,
  LinkOptionsData,
  RecordSummaryPage,
  CreateBaseInput,
  CreateSheetInput,
  CreateFieldInput,
  MetaPreparedPersonField,
  UpdateFieldInput,
  CreateViewInput,
  UpdateViewInput,
  CreateRecordInput,
  PatchRecordsInput,
  FormSubmitInput,
  MultitableComment,
  MetaAttachment,
} from '../types'
import { apiFetch } from '../../utils/api'

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

type ApiErrorPayload = {
  code?: string
  message?: string
  fieldErrors?: Record<string, string>
  serverVersion?: number
}

function defaultFetchFn(): FetchFn {
  return apiFetch
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  return entries.length ? `?${entries.join('&')}` : ''
}

async function parseJson<T>(res: Response): Promise<T> {
  const raw = await res.text()
  const body = raw ? safeParseJson(raw) : null
  if (!res.ok) {
    const payload = (body?.error ?? {}) as ApiErrorPayload
    const error = new Error(firstFieldError(payload.fieldErrors) ?? payload.message ?? `API ${res.status}`) as Error & {
      status?: number
      code?: string
      fieldErrors?: Record<string, string>
      serverVersion?: number
    }
    error.name = 'MultitableApiError'
    error.status = res.status
    error.code = payload.code
    error.fieldErrors = payload.fieldErrors
    error.serverVersion = payload.serverVersion
    throw error
  }
  if (res.status === 204 || !raw.trim()) return undefined as T
  return (body?.data ?? body) as T
}

function safeParseJson(raw: string): any {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function firstFieldError(fieldErrors?: Record<string, string>): string | null {
  if (!fieldErrors) return null
  const first = Object.values(fieldErrors).find((msg) => typeof msg === 'string' && msg.trim())
  return first ?? null
}

function normalizeCommentsList(payload: { comments?: MultitableComment[]; items?: MultitableComment[] } | null | undefined): {
  comments: MultitableComment[]
} {
  if (!payload) return { comments: [] }
  if (Array.isArray(payload.comments)) return { comments: payload.comments }
  if (Array.isArray(payload.items)) return { comments: payload.items }
  return { comments: [] }
}

export class MultitableApiClient {
  private fetch: FetchFn

  constructor(opts?: { fetchFn?: FetchFn }) {
    this.fetch = opts?.fetchFn ?? defaultFetchFn()
  }

  // --- Bases ---
  async listBases(): Promise<{ bases: MetaBase[] }> {
    const res = await this.fetch('/api/multitable/bases')
    return parseJson(res)
  }

  async createBase(input: CreateBaseInput): Promise<{ base: MetaBase }> {
    const res = await this.fetch('/api/multitable/bases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return parseJson(res)
  }

  // --- Context ---
  async loadContext(params: { baseId?: string; sheetId?: string; viewId?: string }): Promise<MetaContext> {
    const res = await this.fetch(`/api/multitable/context${qs(params)}`)
    return parseJson(res)
  }

  // --- Sheets ---
  async listSheets(): Promise<{ sheets: MetaSheet[] }> {
    const res = await this.fetch('/api/multitable/sheets')
    return parseJson(res)
  }

  async createSheet(input: CreateSheetInput): Promise<{ sheet: MetaSheet & { seeded?: boolean } }> {
    const res = await this.fetch('/api/multitable/sheets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return parseJson(res)
  }

  // --- Fields ---
  async listFields(sheetId: string): Promise<{ fields: MetaField[] }> {
    const res = await this.fetch(`/api/multitable/fields${qs({ sheetId })}`)
    return parseJson(res)
  }

  async createField(input: CreateFieldInput): Promise<{ field: MetaField }> {
    const res = await this.fetch('/api/multitable/fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return parseJson(res)
  }

  async preparePersonField(sheetId: string): Promise<MetaPreparedPersonField> {
    const res = await this.fetch('/api/multitable/person-fields/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheetId }),
    })
    return parseJson(res)
  }

  async updateField(fieldId: string, input: UpdateFieldInput): Promise<{ field: MetaField }> {
    const res = await this.fetch(`/api/multitable/fields/${fieldId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return parseJson(res)
  }

  async deleteField(fieldId: string): Promise<{ deleted: string }> {
    const res = await this.fetch(`/api/multitable/fields/${fieldId}`, { method: 'DELETE' })
    return parseJson(res)
  }

  // --- Views ---
  async listViews(sheetId: string): Promise<{ views: MetaView[] }> {
    const res = await this.fetch(`/api/multitable/views${qs({ sheetId })}`)
    return parseJson(res)
  }

  async createView(input: CreateViewInput): Promise<{ view: MetaView }> {
    const res = await this.fetch('/api/multitable/views', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return parseJson(res)
  }

  async updateView(viewId: string, input: UpdateViewInput): Promise<{ view: MetaView }> {
    const res = await this.fetch(`/api/multitable/views/${viewId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return parseJson(res)
  }

  async deleteView(viewId: string): Promise<{ deleted: string }> {
    const res = await this.fetch(`/api/multitable/views/${viewId}`, { method: 'DELETE' })
    return parseJson(res)
  }

  // --- View data (grid) ---
  async loadView(params: {
    sheetId?: string
    viewId?: string
    seed?: boolean
    limit?: number
    offset?: number
    includeLinkSummaries?: boolean
    search?: string
  }): Promise<MetaViewData> {
    const res = await this.fetch(`/api/multitable/view${qs(params as Record<string, string | number | boolean | undefined>)}`)
    return parseJson(res)
  }

  // --- Form context ---
  async loadFormContext(params: { sheetId?: string; viewId?: string; recordId?: string }): Promise<MetaFormContext> {
    const res = await this.fetch(`/api/multitable/form-context${qs(params)}`)
    return parseJson(res)
  }

  // --- Records ---
  async getRecord(recordId: string, params?: { sheetId?: string; viewId?: string }): Promise<MetaRecordContext> {
    const res = await this.fetch(`/api/multitable/records/${recordId}${qs(params ?? {})}`)
    return parseJson(res)
  }

  async createRecord(input: CreateRecordInput): Promise<{ record: MetaRecord }> {
    const res = await this.fetch('/api/multitable/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return parseJson(res)
  }

  async deleteRecord(recordId: string, expectedVersion?: number): Promise<{ deleted: string }> {
    const res = await this.fetch(`/api/multitable/records/${recordId}${qs({ expectedVersion })}`, { method: 'DELETE' })
    return parseJson(res)
  }

  async patchRecords(input: PatchRecordsInput): Promise<PatchResult> {
    const res = await this.fetch('/api/multitable/patch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return parseJson(res)
  }

  // --- Form submit ---
  async submitForm(viewId: string, input: FormSubmitInput): Promise<FormSubmitResult> {
    const res = await this.fetch(`/api/multitable/views/${viewId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return parseJson(res)
  }

  // --- Link options ---
  async listLinkOptions(fieldId: string, params?: {
    recordId?: string; search?: string; limit?: number; offset?: number
  }): Promise<LinkOptionsData> {
    const res = await this.fetch(`/api/multitable/fields/${fieldId}/link-options${qs(params ?? {})}`)
    return parseJson(res)
  }

  // --- Record summaries ---
  async listRecordSummaries(params: {
    sheetId: string; displayFieldId?: string; search?: string; limit?: number; offset?: number
  }): Promise<RecordSummaryPage> {
    const res = await this.fetch(`/api/multitable/records-summary${qs(params as Record<string, string | number | boolean | undefined>)}`)
    return parseJson(res)
  }

  // --- Attachments ---
  async uploadAttachment(file: File, opts?: { sheetId?: string; recordId?: string; fieldId?: string }): Promise<MetaAttachment> {
    const formData = new FormData()
    formData.append('file', file)
    if (opts?.sheetId) formData.append('sheetId', opts.sheetId)
    if (opts?.recordId) formData.append('recordId', opts.recordId)
    if (opts?.fieldId) formData.append('fieldId', opts.fieldId)
    const res = await this.fetch('/api/multitable/attachments', {
      method: 'POST',
      body: formData,
    })
    const data = await parseJson<MetaAttachment | { attachment: MetaAttachment }>(res)
    return 'attachment' in data ? data.attachment : data
  }

  async deleteAttachment(attachmentId: string): Promise<{ deleted: string }> {
    const res = await this.fetch(`/api/multitable/attachments/${attachmentId}`, { method: 'DELETE' })
    return parseJson(res)
  }

  // --- Comments (uses /api/comments) ---
  async listComments(params: { containerId: string; targetId: string }): Promise<{ comments: MultitableComment[] }> {
    const res = await this.fetch(`/api/comments${qs(params)}`)
    const data = await parseJson<{ comments?: MultitableComment[]; items?: MultitableComment[] }>(res)
    return normalizeCommentsList(data)
  }

  async createComment(input: { containerId: string; targetId: string; content: string }): Promise<{ comment: MultitableComment }> {
    const res = await this.fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return parseJson(res)
  }

  async resolveComment(commentId: string): Promise<void> {
    const res = await this.fetch(`/api/comments/${commentId}/resolve`, { method: 'POST' })
    return parseJson(res)
  }
}

/** Singleton client for production usage */
export const multitableClient = new MultitableApiClient()
