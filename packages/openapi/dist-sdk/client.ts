export type FetchLike = typeof fetch

export interface ClientOptions {
  baseUrl: string
  getToken: () => Promise<string> | string
  fetch?: FetchLike
}

export function createClient(opts: ClientOptions) {
  const f = opts.fetch || fetch

  async function request(method: string, path: string, body?: any, ifMatch?: string) {
    const token = await opts.getToken()
    const headers: any = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
    if (ifMatch) headers['if-match'] = ifMatch
    const res = await f(opts.baseUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
    const etag = res.headers.get('etag') || undefined
    const json = await res.json().catch(() => ({}))
    return { status: res.status, etag, json }
  }

  async function requestWithRetry(method: string, path: string, body?: any, etag?: string, retries = 1) {
    const r = await request(method, path, body, etag)
    if (r.status === 409 && retries > 0) {
      // refresh ETag then retry once
      const g = await request('GET', path.replace(/\/(approve|reject|return|revoke)$/,'') )
      return request(method, path, body, g.etag)
    }
    return r
  }

  return { request, requestWithRetry }
}

