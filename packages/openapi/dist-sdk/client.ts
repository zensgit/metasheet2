export type FetchLike = typeof globalThis.fetch

export interface RequestResult<T = unknown> {
  status: number
  etag?: string
  url?: string
  json: T
}

export interface ClientOptions {
  baseUrl: string
  getToken: () => Promise<string> | string
  refreshToken?: () => Promise<string> | string
  fetch?: FetchLike
}

interface HttpError extends Error {
  status?: number
  url?: string
}

export interface MetaField {
  id: string
  name: string
  type: 'string' | 'number' | 'boolean' | 'formula' | 'select' | 'link' | 'lookup' | 'rollup'
  order?: number
  property?: {
    options?: Array<{ value: string; label?: string; color?: string }>
  }
}

export interface MetaRecord {
  id: string
  data: Record<string, unknown>
}

export interface MetaViewData {
  fields: MetaField[]
  rows: MetaRecord[]
}

export interface ViewOption {
  id: string
  name: string
  type?: string
  sheetId?: string
}

export interface MetaViewResponse {
  ok: boolean
  data?: MetaViewData
  error?: {
    message?: string
  }
}

export interface MetaViewsResponse {
  ok: boolean
  data?: {
    views: ViewOption[]
  }
  error?: {
    message?: string
  }
}

export interface UniverMetaViewParams {
  sheetId: string
  viewId?: string
}

export interface UniverMetaViewsParams {
  sheetId: string
}

export interface ApprovalInstance {
  id: string
  status: string
  version: number
  created_at?: string
  updated_at?: string
}

export interface ApprovalRecord {
  action: string
  actor_id: string
  actor_name?: string | null
  comment?: string | null
  created_at?: string
  from_status?: string | null
  from_version?: number | null
  id?: string
  instance_id?: string
  metadata?: Record<string, unknown>
  occurred_at?: string
  reason?: string | null
  to_status?: string
  to_version?: number
}

export interface ApprovalActionPayload {
  comment?: string
  metadata?: Record<string, unknown>
}

export interface ApprovalRejectPayload extends ApprovalActionPayload {
  reason: string
}

export interface PendingApprovalsParams {
  limit?: number
  offset?: number
}

export interface PendingApprovalsResponse {
  data: ApprovalInstance[]
  degraded?: boolean
  limit?: number
  offset?: number
  total: number
}

export interface ApprovalHistoryResponse {
  data: ApprovalRecord[]
  degraded?: boolean
  total: number
}

export interface ApprovalActionResponse {
  degraded?: boolean
  id: string
  ok?: boolean
  status?: string
  success?: boolean
  version?: number
}

function createHttpError(message: string, status?: number, url?: string) {
  const error = new Error(message) as HttpError
  error.status = status
  error.url = url
  return error
}

function encodePathSegment(value: string) {
  return encodeURIComponent(value)
}

function toQueryString(params: Record<string, string | undefined>) {
  const search = new URLSearchParams()

  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      search.set(key, value)
    }
  })

  const query = search.toString()
  return query ? `?${query}` : ''
}

function getErrorMessage(payload: unknown, status: number) {
  if (payload && typeof payload === 'object') {
    const error = (payload as { error?: unknown }).error
    if (typeof error === 'string') {
      return error
    }
    if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
      return (error as { message: string }).message
    }
    if (typeof (payload as { message?: unknown }).message === 'string') {
      return (payload as { message: string }).message
    }
  }

  return `HTTP ${status}`
}

function unwrapResponse<T>(response: RequestResult<T>) {
  if (response.status >= 400) {
    throw createHttpError(getErrorMessage(response.json, response.status), response.status, response.url)
  }

  return response.json
}

export function createClient(opts: ClientOptions) {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis)

  async function send<T = unknown>(
    method: string,
    path: string,
    token: string,
    body?: unknown,
    ifMatch?: string,
  ): Promise<RequestResult<T>> {
    const url = opts.baseUrl + path
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    }

    if (ifMatch) headers['if-match'] = ifMatch
    const res = await f(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const etag = res.headers.get('etag') || undefined
    const json = (await res.json().catch(() => undefined)) as T
    return { status: res.status, etag, url: res.url || url, json }
  }

  async function request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    ifMatch?: string,
  ): Promise<RequestResult<T>> {
    const token = await opts.getToken()
    let response = await send<T>(method, path, token, body, ifMatch)

    if (response.status === 401 && opts.refreshToken) {
      const refreshedToken = await opts.refreshToken()
      response = await send<T>(method, path, refreshedToken, body, ifMatch)
    }

    return response
  }

  async function requestWithRetry<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    etag?: string,
    retries = 1,
  ): Promise<RequestResult<T>> {
    const r = await request<T>(method, path, body, etag)
    if (r.status === 409 && retries > 0) {
      // refresh ETag then retry once
      const g = await request('GET', path.replace(/\/(approve|reject|return|revoke)$/, ''))
      return request<T>(method, path, body, g.etag)
    }
    return r
  }

  return { request, requestWithRetry }
}

export function createMetaSheetClient(opts: ClientOptions) {
  const client = createClient(opts)

  async function getUniverMetaView(params: UniverMetaViewParams): Promise<MetaViewData> {
    const response = await client.request<MetaViewResponse>(
      'GET',
      `/api/univer-meta/view${toQueryString({
        sheetId: params.sheetId,
        viewId: params.viewId,
      })}`,
    )

    if (!response.json?.ok || !response.json.data) {
      throw createHttpError(
        response.json?.error?.message || `HTTP ${response.status}`,
        response.status,
        response.url,
      )
    }

    return response.json.data
  }

  async function listUniverMetaViews(params: UniverMetaViewsParams): Promise<ViewOption[]> {
    const response = await client.request<MetaViewsResponse>(
      'GET',
      `/api/univer-meta/views${toQueryString({
        sheetId: params.sheetId,
      })}`,
    )

    if (!response.json?.ok || !response.json.data) {
      throw createHttpError(
        response.json?.error?.message || `HTTP ${response.status}`,
        response.status,
        response.url,
      )
    }

    return response.json.data.views
  }

  return {
    ...client,
    getUniverMetaView,
    listUniverMetaViews,
  }
}

export function createApprovalsClient(opts: ClientOptions) {
  const client = createClient(opts)

  async function getApproval(id: string): Promise<ApprovalInstance> {
    const response = await client.request<ApprovalInstance>(
      'GET',
      `/api/approvals/${encodePathSegment(id)}`,
    )

    return unwrapResponse(response)
  }

  async function listPendingApprovals(params: PendingApprovalsParams = {}): Promise<PendingApprovalsResponse> {
    const response = await client.request<PendingApprovalsResponse>(
      'GET',
      `/api/approvals/pending${toQueryString({
        limit: typeof params.limit === 'number' ? String(params.limit) : undefined,
        offset: typeof params.offset === 'number' ? String(params.offset) : undefined,
      })}`,
    )

    return unwrapResponse(response)
  }

  async function getApprovalHistory(id: string): Promise<ApprovalHistoryResponse> {
    const response = await client.request<ApprovalHistoryResponse>(
      'GET',
      `/api/approvals/${encodePathSegment(id)}/history`,
    )

    return unwrapResponse(response)
  }

  async function approveApproval(id: string, payload: ApprovalActionPayload = {}): Promise<ApprovalActionResponse> {
    const response = await client.request<ApprovalActionResponse>(
      'POST',
      `/api/approvals/${encodePathSegment(id)}/approve`,
      payload,
    )
    const json = unwrapResponse(response)

    if (json && typeof json === 'object' && ('success' in json || 'ok' in json)) {
      if (json.success === false || json.ok === false) {
        throw createHttpError(getErrorMessage(json, response.status), response.status, response.url)
      }
    }

    return json
  }

  async function rejectApproval(id: string, payload: ApprovalRejectPayload): Promise<ApprovalActionResponse> {
    const response = await client.request<ApprovalActionResponse>(
      'POST',
      `/api/approvals/${encodePathSegment(id)}/reject`,
      payload,
    )
    const json = unwrapResponse(response)

    if (json && typeof json === 'object' && ('success' in json || 'ok' in json)) {
      if (json.success === false || json.ok === false) {
        throw createHttpError(getErrorMessage(json, response.status), response.status, response.url)
      }
    }

    return json
  }

  return {
    ...client,
    approveApproval,
    getApproval,
    getApprovalHistory,
    listPendingApprovals,
    rejectApproval,
  }
}
