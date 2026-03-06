export type FetchLike = typeof globalThis.fetch

export interface RequestResult<T = unknown> {
  status: number
  etag?: string
  json: T
}

export interface ClientOptions {
  baseUrl: string
  getToken: () => Promise<string> | string
  fetch?: FetchLike
}

export function createClient(opts: ClientOptions) {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis)

  async function request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    ifMatch?: string,
  ): Promise<RequestResult<T>> {
    const token = await opts.getToken()
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    }

    if (ifMatch) headers['if-match'] = ifMatch
    const res = await f(opts.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const etag = res.headers.get('etag') || undefined
    const json = (await res.json().catch(() => undefined)) as T
    return { status: res.status, etag, json }
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
