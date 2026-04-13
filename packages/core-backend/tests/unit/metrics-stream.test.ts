import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock prom-client before importing the service (metrics.ts imports it at
// module level).  We return a lightweight fake registry that satisfies
// `getMetricsAsJSON()`.
// ---------------------------------------------------------------------------

const fakeMetricsJSON = [
  { name: 'http_requests_total', values: [{ value: 100, labels: { method: 'GET', status: '200' } }] },
  { name: 'http_requests_total', values: [{ value: 5, labels: { method: 'POST', status: '500' } }] },
  { name: 'cache_hits_total', values: [{ value: 42, labels: { impl: 'redis', key_pattern: '*' } }] },
  { name: 'metasheet_events_emitted_total', values: [{ value: 10, labels: {} }] },
  { name: 'metasheet_messages_processed_total', values: [{ value: 7, labels: {} }] },
  { name: 'metasheet_rpc_timeouts_total', values: [{ value: 3, labels: {} }] },
]

vi.mock('prom-client', () => {
  const makeFakeMetric = () => ({
    inc: vi.fn(),
    dec: vi.fn(),
    set: vi.fn(),
    observe: vi.fn(),
    startTimer: vi.fn(() => vi.fn()),
    labels: vi.fn().mockReturnThis(),
  })
  const fakeRegistry = {
    registerMetric: vi.fn(),
    getMetricsAsJSON: vi.fn(async () => fakeMetricsJSON),
    metrics: vi.fn(async () => ''),
    contentType: 'text/plain',
  }
  return {
    default: {
      Registry: vi.fn(() => fakeRegistry),
      Counter: vi.fn(() => makeFakeMetric()),
      Gauge: vi.fn(() => makeFakeMetric()),
      Histogram: vi.fn(() => makeFakeMetric()),
      Summary: vi.fn(() => makeFakeMetric()),
      collectDefaultMetrics: vi.fn(),
    },
    Registry: vi.fn(() => fakeRegistry),
    Counter: vi.fn(() => makeFakeMetric()),
    Gauge: vi.fn(() => makeFakeMetric()),
    Histogram: vi.fn(() => makeFakeMetric()),
    Summary: vi.fn(() => makeFakeMetric()),
    collectDefaultMetrics: vi.fn(),
  }
})

// Mock winston to keep Logger quiet
vi.mock('winston', () => {
  const format = {
    combine: vi.fn(),
    timestamp: vi.fn(),
    printf: vi.fn(),
    colorize: vi.fn(),
    json: vi.fn(),
    simple: vi.fn(),
    errors: vi.fn(),
  }
  return {
    default: {
      createLogger: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      })),
      format,
      transports: { Console: vi.fn() },
    },
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
    format,
    transports: { Console: vi.fn() },
  }
})

// ---------------------------------------------------------------------------
// Minimal Socket.IO mock
// ---------------------------------------------------------------------------

function createMockSocket(id: string) {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  return {
    id,
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const arr = handlers.get(event) ?? []
      arr.push(handler)
      handlers.set(event, arr)
    }),
    disconnect: vi.fn(),
    // helper to fire an event from the test side
    _fire(event: string, ...args: unknown[]) {
      for (const h of handlers.get(event) ?? []) h(...args)
    },
    _handlers: handlers,
  }
}

type MockSocket = ReturnType<typeof createMockSocket>

function createMockNamespace() {
  const connHandlers: ((socket: MockSocket) => void)[] = []
  const sockets: MockSocket[] = []

  return {
    on: vi.fn((event: string, handler: (socket: MockSocket) => void) => {
      if (event === 'connection') connHandlers.push(handler)
    }),
    fetchSockets: vi.fn(async () =>
      sockets.map((s) => ({ id: s.id, emit: s.emit, disconnect: s.disconnect })),
    ),
    removeAllListeners: vi.fn(),
    // test helpers
    _simulateConnection(socket: MockSocket) {
      sockets.push(socket)
      for (const h of connHandlers) h(socket)
    },
    _sockets: sockets,
  }
}

type MockNamespace = ReturnType<typeof createMockNamespace>

// We patch the Server constructor used by MetricsStreamService
vi.mock('socket.io', () => {
  let nsp: MockNamespace | null = null
  return {
    Server: vi.fn(() => ({
      of: vi.fn((_path: string) => {
        nsp = createMockNamespace()
        return nsp
      }),
      // expose for test access
      get __nsp() { return nsp },
    })),
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

import { MetricsStreamService } from '../../src/services/MetricsStreamService'

describe('MetricsStreamService', () => {
  let service: MetricsStreamService
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockServer: any

  beforeEach(() => {
    vi.useFakeTimers()
    process.env.ENABLE_METRICS_STREAM = 'true'
    process.env.METRICS_STREAM_INTERVAL_MS = '1000'

    service = new MetricsStreamService()
    mockServer = {} as unknown // fake HttpServer; Server constructor is mocked
    service.initialize(mockServer)
  })

  afterEach(async () => {
    await service.shutdown()
    vi.useRealTimers()
    delete process.env.ENABLE_METRICS_STREAM
    delete process.env.METRICS_STREAM_INTERVAL_MS
  })

  function getNsp(): MockNamespace {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const io = (service as any).io
    return io.__nsp as MockNamespace
  }

  // -----------------------------------------------------------------------
  // Subscription
  // -----------------------------------------------------------------------

  it('should accept subscription to specific groups', () => {
    const nsp = getNsp()
    const socket = createMockSocket('s1')
    nsp._simulateConnection(socket)

    // Trigger subscribe
    socket._fire('metrics:subscribe', ['http', 'cache'])

    expect(socket.emit).toHaveBeenCalledWith('metrics:subscribed', {
      groups: expect.arrayContaining(['http', 'cache']),
    })
  })

  it('should ignore invalid groups', () => {
    const nsp = getNsp()
    const socket = createMockSocket('s2')
    nsp._simulateConnection(socket)

    socket._fire('metrics:subscribe', ['http', 'invalid_group'])

    expect(socket.emit).toHaveBeenCalledWith('metrics:subscribed', {
      groups: ['http'],
    })
  })

  // -----------------------------------------------------------------------
  // Delta computation
  // -----------------------------------------------------------------------

  it('should only send changed metrics on subsequent ticks', async () => {
    const nsp = getNsp()
    const socket = createMockSocket('s3')
    nsp._simulateConnection(socket)
    socket._fire('metrics:subscribe', ['http'])

    // First tick: all http deltas (everything is new -> delta != 0)
    await vi.advanceTimersByTimeAsync(1000)

    const firstCalls = socket.emit.mock.calls.filter(
      (c: unknown[]) => c[0] === 'metrics:update',
    )
    expect(firstCalls.length).toBeGreaterThanOrEqual(1)
    const firstPayload = firstCalls[0][1]
    expect(firstPayload.group).toBe('http')
    expect(firstPayload.metrics.length).toBeGreaterThan(0)

    // Reset emit history
    socket.emit.mockClear()

    // Second tick with same metric values -> no http deltas expected
    await vi.advanceTimersByTimeAsync(1000)

    const secondCalls = socket.emit.mock.calls.filter(
      (c: unknown[]) => c[0] === 'metrics:update',
    )
    // No deltas because nothing changed
    expect(secondCalls.length).toBe(0)
  })

  // -----------------------------------------------------------------------
  // Backpressure
  // -----------------------------------------------------------------------

  it('should pause sending when client has too many unacknowledged pushes', async () => {
    const nsp = getNsp()
    const socket = createMockSocket('s4')
    nsp._simulateConnection(socket)
    socket._fire('metrics:subscribe', ['all'])

    // Advance through enough ticks to exceed MAX_PENDING_ACKS (5)
    // We need the metric values to change each tick for pushes to happen.
    // Since the mock always returns the same values, deltas are 0 after
    // the first tick. Override getMetricsAsJSON to return incrementing values.
    const { registry: reg } = await import('../../src/metrics/metrics')
    let counter = 100
    ;(reg.getMetricsAsJSON as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      counter += 10
      return [
        { name: 'http_requests_total', values: [{ value: counter, labels: { method: 'GET', status: '200' } }] },
      ]
    })

    // 6 ticks without any ack -> should eventually pause
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(1000)
    }

    // After 5 unacked, client should be paused; 6th tick should NOT produce a push
    const updateCalls = socket.emit.mock.calls.filter(
      (c: unknown[]) => c[0] === 'metrics:update',
    )
    // First 5 ticks produce pushes, 6th is paused -> at most 5 pushes
    expect(updateCalls.length).toBeLessThanOrEqual(5)

    // Send ack -> should resume
    socket._fire('metrics:ack')
    socket.emit.mockClear()
    await vi.advanceTimersByTimeAsync(1000)

    const resumed = socket.emit.mock.calls.filter(
      (c: unknown[]) => c[0] === 'metrics:update',
    )
    expect(resumed.length).toBeGreaterThanOrEqual(1)
  })

  // -----------------------------------------------------------------------
  // Cleanup on disconnect
  // -----------------------------------------------------------------------

  it('should clean up client state on disconnect', () => {
    const nsp = getNsp()
    const socket = createMockSocket('s5')
    nsp._simulateConnection(socket)
    socket._fire('metrics:subscribe', ['http'])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((service as any).clients.size).toBe(1)

    socket._fire('disconnect')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((service as any).clients.size).toBe(0)
  })

  // -----------------------------------------------------------------------
  // Feature flag disabled
  // -----------------------------------------------------------------------

  it('should not initialize when feature flag is disabled', () => {
    const disabled = new MetricsStreamService()
    // Override env for this instance — already constructed with ENABLE=true; make a fresh one
    delete process.env.ENABLE_METRICS_STREAM
    const svc = new MetricsStreamService()
    svc.initialize(mockServer)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((svc as any).nsp).toBeNull()
    // cleanup
    void disabled.shutdown()
    void svc.shutdown()
  })
})
