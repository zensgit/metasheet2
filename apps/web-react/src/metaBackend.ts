import type { MetaField, MetaRecord } from './metaWorkbook'
import { DEV_TOKEN_KEY, type StorageLike } from './metaStorage'
import type { ViewOption } from './viewFilters'

export type ErrorScope = 'token' | 'views' | 'data'

export type LastErrorInfo = {
  scope: ErrorScope
  message: string
  status?: number
  url?: string
  at: string
}

export type HttpError = Error & { status?: number; url?: string }

export type MetaViewResponse = {
  ok: boolean
  data?: {
    fields: MetaField[]
    rows: MetaRecord[]
  }
  error?: {
    message?: string
  }
}

export type MetaViewsResponse = {
  ok: boolean
  data?: {
    views: ViewOption[]
  }
  error?: {
    message?: string
  }
}

type FetchLike = typeof globalThis.fetch

interface MetaBackendClientOptions {
  backendUrl: string
  viewsUrl: string
  fetch?: FetchLike
  storage?: StorageLike | null
  tokenKey?: string
}

function resolveStorage(storage?: StorageLike | null) {
  if (storage) {
    return storage
  }

  if (typeof window === 'undefined') {
    return null
  }

  return window.localStorage
}

export function attachHttpInfo(error: Error, status?: number, url?: string) {
  const target = error as HttpError

  if (typeof status === 'number') {
    target.status = status
  }

  if (url) {
    target.url = url
  }

  return target
}

export function buildLastErrorInfo(scope: ErrorScope, err: unknown, now = new Date()): LastErrorInfo {
  const error = err instanceof Error ? err : new Error('Unknown error')
  const details = error as HttpError

  return {
    scope,
    message: error.message,
    status: details.status,
    url: details.url,
    at: now.toLocaleTimeString(),
  }
}

export function createMetaBackendClient(options: MetaBackendClientOptions) {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const storage = resolveStorage(options.storage)
  const tokenKey = options.tokenKey ?? DEV_TOKEN_KEY

  async function ensureDevToken(forceRefresh = false) {
    if (!storage) {
      throw new Error('Storage unavailable')
    }

    if (!forceRefresh) {
      const cached = storage.getItem(tokenKey)
      if (cached) {
        return cached
      }
    }

    const res = await fetchImpl('/api/auth/dev-token')
    if (!res.ok) {
      throw attachHttpInfo(new Error(`HTTP ${res.status}`), res.status, res.url)
    }

    const payload = (await res.json()) as { token?: string }
    if (!payload.token) {
      throw attachHttpInfo(new Error('Missing dev token'), res.status, res.url)
    }

    storage.setItem(tokenKey, payload.token)
    return payload.token
  }

  async function fetchWithAuth(url: string) {
    try {
      const token = await ensureDevToken()
      let res = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (res.status === 401) {
        const refreshed = await ensureDevToken(true)
        res = await fetchImpl(url, {
          headers: {
            Authorization: `Bearer ${refreshed}`,
          },
        })
      }

      if (!res.ok) {
        throw attachHttpInfo(new Error(`HTTP ${res.status}`), res.status, res.url || url)
      }

      return res
    } catch (err) {
      if (err instanceof Error) {
        const httpErr = err as HttpError
        if (!httpErr.url) {
          httpErr.url = url
        }
      }

      throw err
    }
  }

  async function fetchMetaView() {
    const res = await fetchWithAuth(options.backendUrl)
    const payload = (await res.json()) as MetaViewResponse

    if (!payload.ok || !payload.data) {
      throw new Error(payload.error?.message || 'Backend response not ok')
    }

    return payload
  }

  async function fetchViews() {
    const res = await fetchWithAuth(options.viewsUrl)
    const payload = (await res.json()) as MetaViewsResponse

    if (!payload.ok || !payload.data) {
      throw new Error(payload.error?.message || 'Backend response not ok')
    }

    return payload.data.views
  }

  return {
    ensureDevToken,
    fetchWithAuth,
    fetchMetaView,
    fetchViews,
  }
}
