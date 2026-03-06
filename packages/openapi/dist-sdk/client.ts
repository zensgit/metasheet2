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

function createHttpError(message: string, status?: number, url?: string) {
  const error = new Error(message) as HttpError
  error.status = status
  error.url = url
  return error
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
