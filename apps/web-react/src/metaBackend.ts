import {
  createMetaSheetClient,
  type MetaViewResponse,
  type ViewOption,
} from '../../../packages/openapi/dist-sdk/client.ts'
import { DEV_TOKEN_KEY, type StorageLike } from './metaStorage'

export type ErrorScope = 'token' | 'views' | 'data'

export type LastErrorInfo = {
  scope: ErrorScope
  message: string
  status?: number
  url?: string
  at: string
}

export type HttpError = Error & { status?: number; url?: string }

type FetchLike = typeof globalThis.fetch

interface MetaBackendClientOptions {
  baseUrl: string
  sheetId: string
  viewId?: string
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

  async function refreshDevToken() {
    if (!storage) {
      throw new Error('Storage unavailable')
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

    return refreshDevToken()
  }

  const client = createMetaSheetClient({
    baseUrl: options.baseUrl,
    fetch: fetchImpl,
    getToken: () => ensureDevToken(),
    refreshToken: () => refreshDevToken(),
  })

  async function fetchMetaView(): Promise<MetaViewResponse> {
    const data = await client.getUniverMetaView({
      sheetId: options.sheetId,
      viewId: options.viewId,
    })

    return {
      ok: true,
      data,
    }
  }

  async function fetchViews(): Promise<ViewOption[]> {
    return client.listUniverMetaViews({
      sheetId: options.sheetId,
    })
  }

  return {
    ensureDevToken,
    fetchMetaView,
    fetchViews,
  }
}
