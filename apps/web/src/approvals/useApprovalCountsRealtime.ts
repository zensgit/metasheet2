import { onBeforeUnmount, onMounted } from 'vue'
import { io, type Socket } from 'socket.io-client'
import { useAuth } from '../composables/useAuth'
import { getApiBase } from '../utils/api'

export type ApprovalCountSourceSystem = 'all' | 'platform' | 'plm'

export interface ApprovalCounts {
  count: number
  unreadCount: number
}

export interface ApprovalCountsUpdatedPayload extends ApprovalCounts {
  sourceSystem?: ApprovalCountSourceSystem
  countsBySourceSystem?: Partial<Record<ApprovalCountSourceSystem, ApprovalCounts>>
  reason?: string
  updatedAt?: string
}

interface UseApprovalCountsRealtimeOptions {
  onCountsUpdated: (payload: ApprovalCountsUpdatedPayload) => void
}

function stripApiSuffix(pathname: string): string {
  if (pathname === '/api') return '/'
  if (pathname.endsWith('/api')) return pathname.slice(0, -4) || '/'
  return pathname
}

export function resolveApprovalCountsRealtimeBaseUrl(apiBase = getApiBase()): string {
  const fallbackOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8900'
  const url = new URL(apiBase, fallbackOrigin)
  url.pathname = stripApiSuffix(url.pathname)
  return url.toString().replace(/\/$/, '')
}

function normalizeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function normalizeCounts(value: unknown): ApprovalCounts | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const count = normalizeCount(record.count)
  const unreadCount = normalizeCount(record.unreadCount)
  if (count === null || unreadCount === null) return null
  return { count, unreadCount }
}

function normalizePayload(payload: unknown): ApprovalCountsUpdatedPayload | null {
  const root = normalizeCounts(payload)
  if (!root || !payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  const rawBySource = record.countsBySourceSystem && typeof record.countsBySourceSystem === 'object'
    ? record.countsBySourceSystem as Record<string, unknown>
    : {}
  const countsBySourceSystem: Partial<Record<ApprovalCountSourceSystem, ApprovalCounts>> = {}
  for (const source of ['all', 'platform', 'plm'] as const) {
    const counts = normalizeCounts(rawBySource[source])
    if (counts) countsBySourceSystem[source] = counts
  }
  return {
    ...root,
    sourceSystem: record.sourceSystem === 'platform' || record.sourceSystem === 'plm' ? record.sourceSystem : 'all',
    countsBySourceSystem,
    reason: typeof record.reason === 'string' ? record.reason : undefined,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : undefined,
  }
}

export function useApprovalCountsRealtime(options: UseApprovalCountsRealtimeOptions) {
  const auth = useAuth()
  let socket: Socket | null = null
  let disconnected = false
  let connectionPromise: Promise<Socket | null> | null = null

  function cleanupSocket() {
    socket?.disconnect()
    socket = null
    connectionPromise = null
  }

  async function ensureSocket(): Promise<Socket | null> {
    if (socket) return socket
    if (connectionPromise) return connectionPromise

    connectionPromise = (async () => {
      try {
        const token = auth.getToken()
        if (disconnected || !token) return null

        const nextSocket = io(resolveApprovalCountsRealtimeBaseUrl(), {
          path: '/socket.io',
          transports: ['websocket', 'polling'],
          auth: { token },
        })

        nextSocket.on('approval:counts-updated', (payload: unknown) => {
          const normalized = normalizePayload(payload)
          if (normalized) options.onCountsUpdated(normalized)
        })

        socket = nextSocket
        return nextSocket
      } finally {
        connectionPromise = null
      }
    })()

    return connectionPromise
  }

  onMounted(() => {
    if (import.meta.env.MODE !== 'test') void ensureSocket()
  })

  onBeforeUnmount(() => {
    disconnected = true
    cleanupSocket()
  })

  return {
    reconnect: ensureSocket,
    disconnect: cleanupSocket,
  }
}
