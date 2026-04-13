/**
 * MetricsStreamService
 * Real-time metrics streaming over WebSocket (Socket.IO namespace /metrics-stream).
 *
 * Clients subscribe to metric groups via `metrics:subscribe` and receive
 * delta-compressed updates on `metrics:update` / `system:update`.
 *
 * Feature flag: ENABLE_METRICS_STREAM (default: false)
 * Interval:     METRICS_STREAM_INTERVAL_MS (default: 5000)
 */

import type { Server as HttpServer } from 'http'
import { Server as SocketServer } from 'socket.io'
import type { Socket, Namespace } from 'socket.io'
import { registry, metrics as metricsStreamSelfMetrics } from '../metrics/metrics'
import { Logger } from '../core/logger'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MetricGroup = 'http' | 'rpc' | 'cache' | 'events' | 'messages' | 'system' | 'all'

const VALID_GROUPS: ReadonlySet<MetricGroup> = new Set([
  'http', 'rpc', 'cache', 'events', 'messages', 'system', 'all',
])

/** Prefix mapping from group name to Prometheus metric name prefixes. */
const GROUP_PREFIXES: Record<Exclude<MetricGroup, 'all' | 'system'>, string[]> = {
  http: ['http_'],
  rpc: ['metasheet_rpc_'],
  cache: ['cache_', 'redis_'],
  events: ['metasheet_events_'],
  messages: ['metasheet_messages_', 'metasheet_dlq_', 'metasheet_delayed_'],
}

interface MetricDelta {
  name: string
  value: number
  labels: Record<string, string>
  delta: number
}

interface MetricsUpdatePayload {
  group: string
  metrics: MetricDelta[]
  timestamp: number
}

interface SystemUpdatePayload {
  cpuUsage: NodeJS.CpuUsage
  memoryUsage: NodeJS.MemoryUsage
  uptime: number
  timestamp: number
}

/** Per-client tracking state. */
interface ClientState {
  groups: Set<MetricGroup>
  /** How many un-acknowledged pushes this client has. */
  pendingAcks: number
  /** Whether we paused sending due to backpressure. */
  paused: boolean
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Maximum un-acknowledged pushes before pausing a client. */
const MAX_PENDING_ACKS = 5

export class MetricsStreamService {
  private logger = new Logger('MetricsStreamService')
  private nsp: Namespace | null = null
  private io: SocketServer | null = null
  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private intervalMs: number
  private enabled: boolean

  /** Previous snapshot keyed by metric name + serialised labels. */
  private previousSnapshot = new Map<string, number>()
  /** Per-socket client state. */
  private clients = new Map<string, ClientState>()

  constructor() {
    this.enabled = process.env.ENABLE_METRICS_STREAM === 'true'
    this.intervalMs = parseInt(process.env.METRICS_STREAM_INTERVAL_MS ?? '5000', 10)
    if (Number.isNaN(this.intervalMs) || this.intervalMs < 500) {
      this.intervalMs = 5000
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  initialize(httpServer: HttpServer): void {
    if (!this.enabled) {
      this.logger.info('MetricsStreamService disabled (ENABLE_METRICS_STREAM != true)')
      return
    }

    // Create a separate Socket.IO server sharing the same HTTP server
    // but on the /metrics-stream namespace.
    this.io = new SocketServer(httpServer, {
      cors: { origin: '*', methods: ['GET', 'POST'] },
    })
    this.nsp = this.io.of('/metrics-stream')

    this.nsp.on('connection', (socket: Socket) => {
      this.handleConnection(socket)
    })

    // Start collection interval
    this.intervalHandle = setInterval(() => {
      this.tick().catch((err) => {
        this.logger.error('Metrics stream tick error', err as Error)
        metricsStreamSelfMetrics.metricsStreamErrorsTotal.inc()
      })
    }, this.intervalMs)

    this.logger.info(
      `MetricsStreamService initialized (interval=${this.intervalMs}ms)`,
    )
  }

  async shutdown(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }

    if (this.nsp) {
      // Disconnect all clients on this namespace
      const sockets = await this.nsp.fetchSockets()
      for (const s of sockets) {
        s.disconnect(true)
      }
    }

    if (this.io) {
      // Only close the namespace, not the shared server (CollabService owns that)
      this.nsp?.removeAllListeners()
    }

    this.clients.clear()
    this.previousSnapshot.clear()
    this.logger.info('MetricsStreamService shut down')
  }

  // -----------------------------------------------------------------------
  // Connection handling
  // -----------------------------------------------------------------------

  private handleConnection(socket: Socket): void {
    const state: ClientState = { groups: new Set(), pendingAcks: 0, paused: false }
    this.clients.set(socket.id, state)
    metricsStreamSelfMetrics.metricsStreamClients.inc()
    this.logger.debug(`Metrics stream client connected: ${socket.id}`)

    socket.on('metrics:subscribe', (payload: unknown) => {
      this.handleSubscribe(socket, state, payload)
    })

    socket.on('metrics:ack', () => {
      this.handleAck(state)
    })

    socket.on('disconnect', () => {
      this.clients.delete(socket.id)
      metricsStreamSelfMetrics.metricsStreamClients.dec()
      this.logger.debug(`Metrics stream client disconnected: ${socket.id}`)
    })
  }

  private handleSubscribe(socket: Socket, state: ClientState, payload: unknown): void {
    const groups = Array.isArray(payload) ? payload : [payload]
    for (const g of groups) {
      if (typeof g === 'string' && VALID_GROUPS.has(g as MetricGroup)) {
        state.groups.add(g as MetricGroup)
      }
    }
    socket.emit('metrics:subscribed', { groups: [...state.groups] })
    this.logger.debug(`Client ${socket.id} subscribed to: ${[...state.groups].join(', ')}`)
  }

  private handleAck(state: ClientState): void {
    if (state.pendingAcks > 0) state.pendingAcks--
    if (state.paused && state.pendingAcks < MAX_PENDING_ACKS) {
      state.paused = false
    }
  }

  // -----------------------------------------------------------------------
  // Tick: collect, compute deltas, push
  // -----------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (!this.nsp) return

    // Collect current values from Prometheus registry
    const jsonMetrics = await registry.getMetricsAsJSON()
    const currentSnapshot = new Map<string, number>()
    const allDeltas: MetricDelta[] = []

    for (const metric of jsonMetrics) {
      const name = metric.name
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const values: any[] = (metric as any).values ?? []
      for (const v of values) {
        const labels: Record<string, string> = v.labels ?? {}
        const key = `${name}|${JSON.stringify(labels)}`
        const numValue = typeof v.value === 'number' ? v.value : 0
        currentSnapshot.set(key, numValue)

        const prev = this.previousSnapshot.get(key) ?? 0
        const delta = numValue - prev
        if (delta !== 0) {
          allDeltas.push({ name, value: numValue, labels, delta })
        }
      }
    }

    this.previousSnapshot = currentSnapshot

    // Build system payload
    const systemPayload: SystemUpdatePayload = {
      cpuUsage: process.cpuUsage(),
      memoryUsage: process.memoryUsage(),
      uptime: process.uptime(),
      timestamp: Date.now(),
    }

    // Push to each subscribed client
    const sockets = await this.nsp.fetchSockets()
    for (const remote of sockets) {
      const state = this.clients.get(remote.id)
      if (!state || state.groups.size === 0) continue

      // Backpressure check
      if (state.paused) continue
      if (state.pendingAcks >= MAX_PENDING_ACKS) {
        state.paused = true
        this.logger.debug(`Pausing metrics stream for client ${remote.id} (backpressure)`)
        continue
      }

      const wantsAll = state.groups.has('all')

      // Group-based filtering
      if (wantsAll || state.groups.has('system')) {
        remote.emit('system:update', systemPayload)
      }

      // Metric deltas by group
      const groupsToSend = wantsAll
        ? (Object.keys(GROUP_PREFIXES) as Array<keyof typeof GROUP_PREFIXES>)
        : ([...state.groups].filter((g) => g !== 'all' && g !== 'system') as Array<keyof typeof GROUP_PREFIXES>)

      for (const group of groupsToSend) {
        const prefixes = GROUP_PREFIXES[group]
        if (!prefixes) continue
        const filtered = allDeltas.filter((d) =>
          prefixes.some((p) => d.name.startsWith(p)),
        )
        if (filtered.length === 0) continue
        const payload: MetricsUpdatePayload = {
          group,
          metrics: filtered,
          timestamp: Date.now(),
        }
        remote.emit('metrics:update', payload)
        metricsStreamSelfMetrics.metricsStreamPushesTotal.inc()
      }

      state.pendingAcks++
    }
  }
}
