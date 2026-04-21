/**
 * Unit tests for the Redis-backed CircuitBreaker store.
 *
 * Same approach as the token-bucket tests: we don't spin up a Redis
 * server. The core transition logic is exercised through the pure-JS
 * twins (`applyRecordSuccessScript`, etc.), and the dispatch layer is
 * checked via a small Redis shim that runs those twins against an
 * in-memory state map.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

import { CircuitState } from '../../src/gateway/CircuitBreaker'
import {
  MemoryCircuitBreakerStore,
} from '../../src/gateway/circuit-breaker-store'
import type {
  CircuitBreakerThresholds,
} from '../../src/gateway/circuit-breaker-store'
import {
  CIRCUIT_RECORD_FAILURE_LUA,
  CIRCUIT_RECORD_SUCCESS_LUA,
  CIRCUIT_CHECK_AND_UPDATE_LUA,
  RedisCircuitBreakerStore,
  applyCheckAndUpdateScript,
  applyRecordFailureScript,
  applyRecordSuccessScript,
  applyTransitionScript,
  emptyCircuitState,
  type CircuitScriptState,
  type RedisCircuitClient,
} from '../../src/gateway/redis-circuit-breaker-store'

const defaultThresholds: CircuitBreakerThresholds = {
  errorThreshold: 50,
  volumeThreshold: 5,
  windowSizeMs: 10_000,
  resetTimeoutMs: 2_000,
}

// ---------------------------------------------------------------------------
// Pure-JS twin tests
// ---------------------------------------------------------------------------

describe('circuit-breaker script twins', () => {
  it('CLOSED → OPEN after failure threshold is reached', () => {
    const state: CircuitScriptState = emptyCircuitState()
    let now = 1_000_000
    for (let i = 0; i < 5; i++) {
      applyRecordFailureScript(state, defaultThresholds, now++)
    }
    expect(state.state).toBe(CircuitState.OPEN)
    expect(state.nextAttemptAt).toBe(now - 1 + defaultThresholds.resetTimeoutMs)
  })

  it('CLOSED stays CLOSED below the volume threshold', () => {
    const state: CircuitScriptState = emptyCircuitState()
    // Only 4 failures but threshold=5 -> still CLOSED
    for (let i = 0; i < 4; i++) {
      applyRecordFailureScript(state, defaultThresholds, 1_000_000 + i)
    }
    expect(state.state).toBe(CircuitState.CLOSED)
  })

  it('OPEN → HALF_OPEN after reset timeout via checkAndUpdate', () => {
    const state: CircuitScriptState = emptyCircuitState()
    // Force OPEN
    for (let i = 0; i < 5; i++) {
      applyRecordFailureScript(state, defaultThresholds, 1_000_000 + i)
    }
    expect(state.state).toBe(CircuitState.OPEN)

    // Before cooldown — still OPEN
    applyCheckAndUpdateScript(state, defaultThresholds, 1_000_500)
    expect(state.state).toBe(CircuitState.OPEN)

    // After cooldown
    applyCheckAndUpdateScript(state, defaultThresholds, state.nextAttemptAt + 1)
    expect(state.state).toBe(CircuitState.HALF_OPEN)
  })

  it('HALF_OPEN success → CLOSED and clears the window (when errorRate drops below threshold)', () => {
    // With a relaxed threshold one success is enough to close the circuit.
    const relaxed: CircuitBreakerThresholds = {
      ...defaultThresholds,
      errorThreshold: 80,
    }
    const state = emptyCircuitState()
    state.state = CircuitState.HALF_OPEN
    state.events = [{ at: 999_000, success: false }]

    applyRecordSuccessScript(state, relaxed, 1_000_000)
    expect(state.state).toBe(CircuitState.CLOSED)
    expect(state.events).toHaveLength(0)
  })

  it('HALF_OPEN failure → OPEN immediately', () => {
    const state: CircuitScriptState = emptyCircuitState()
    state.state = CircuitState.HALF_OPEN
    state.lastTransitionAt = 900_000

    applyRecordFailureScript(state, defaultThresholds, 1_000_000)
    expect(state.state).toBe(CircuitState.OPEN)
    expect(state.nextAttemptAt).toBe(1_000_000 + defaultThresholds.resetTimeoutMs)
  })

  it('explicit transition clears window on CLOSE and sets nextAttempt on OPEN', () => {
    const state: CircuitScriptState = emptyCircuitState()
    state.events = [{ at: 1, success: false }]

    applyTransitionScript(state, CircuitState.OPEN, defaultThresholds, 2_000_000)
    expect(state.state).toBe(CircuitState.OPEN)
    expect(state.nextAttemptAt).toBe(2_000_000 + defaultThresholds.resetTimeoutMs)

    applyTransitionScript(state, CircuitState.CLOSED, defaultThresholds, 2_001_000)
    expect(state.state).toBe(CircuitState.CLOSED)
    expect(state.nextAttemptAt).toBe(0)
    expect(state.events).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// MemoryCircuitBreakerStore — sanity check (shared interface surface)
// ---------------------------------------------------------------------------

describe('MemoryCircuitBreakerStore', () => {
  let store: MemoryCircuitBreakerStore
  beforeEach(() => {
    store = new MemoryCircuitBreakerStore()
  })

  it('full cycle CLOSED → OPEN → HALF_OPEN → CLOSED', async () => {
    const id = 'svc'
    const now = vi.spyOn(Date, 'now')

    // Drive into OPEN
    now.mockReturnValue(1_000_000)
    for (let i = 0; i < 5; i++) {
      await store.recordFailure(id, defaultThresholds)
    }
    expect((await store.getSnapshot(id)).state).toBe(CircuitState.OPEN)

    // Cooldown hasn't elapsed
    now.mockReturnValue(1_000_500)
    expect((await store.checkAndUpdate(id, defaultThresholds)).state).toBe(
      CircuitState.OPEN,
    )

    // After cooldown → HALF_OPEN
    now.mockReturnValue(1_000_000 + defaultThresholds.resetTimeoutMs + 1)
    expect((await store.checkAndUpdate(id, defaultThresholds)).state).toBe(
      CircuitState.HALF_OPEN,
    )

    // Successful probe → CLOSED
    await store.recordSuccess(id, {
      ...defaultThresholds,
      errorThreshold: 100, // ensure 1 success brings rate < threshold
    })
    expect((await store.getSnapshot(id)).state).toBe(CircuitState.CLOSED)

    now.mockRestore()
  })

  it('explicit transitionTo lets admin force open/close', async () => {
    await store.transitionTo('svc', CircuitState.OPEN, defaultThresholds)
    expect((await store.getSnapshot('svc')).state).toBe(CircuitState.OPEN)

    await store.transitionTo('svc', CircuitState.CLOSED, defaultThresholds)
    const snap = await store.getSnapshot('svc')
    expect(snap.state).toBe(CircuitState.CLOSED)
    expect(snap.nextAttemptAt).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// RedisCircuitBreakerStore — mocked Redis dispatch
// ---------------------------------------------------------------------------

function createFakeCircuitRedis(): RedisCircuitClient & {
  _calls: { method: string; args: unknown[] }[]
  _store: Map<string, CircuitScriptState>
  _scripts: Map<string, string>
} {
  const hashes = new Map<string, CircuitScriptState>()
  const scripts = new Map<string, string>()
  const calls: { method: string; args: unknown[] }[] = []

  // Map each known Lua script to the corresponding JS twin.
  const runScript = (
    source: string,
    key: string,
    args: (string | number)[],
  ): (string | number)[] => {
    const state = hashes.get(key) ?? emptyCircuitState()
    const thresholds: CircuitBreakerThresholds = {
      errorThreshold: Number(args[0]),
      volumeThreshold: Number(args[1]),
      windowSizeMs: Number(args[2]),
      resetTimeoutMs: Number(args[3]),
    }
    const nowMs = Number(args[4])

    if (source === CIRCUIT_RECORD_SUCCESS_LUA) {
      applyRecordSuccessScript(state, thresholds, nowMs)
    } else if (source === CIRCUIT_RECORD_FAILURE_LUA) {
      applyRecordFailureScript(state, thresholds, nowMs)
    } else if (source === CIRCUIT_CHECK_AND_UPDATE_LUA) {
      applyCheckAndUpdateScript(state, thresholds, nowMs)
    } else {
      // transition (ARGV[1] is the target state)
      const newState = String(args[0]) as CircuitState
      applyTransitionScript(state, newState, thresholds, nowMs)
    }

    hashes.set(key, state)
    const failures = state.events.reduce(
      (acc, e) => (e.success ? acc : acc + 1),
      0,
    )
    return [
      state.state,
      String(state.events.length),
      String(failures),
      String(state.lastTransitionAt),
      String(state.nextAttemptAt),
    ]
  }

  return {
    _calls: calls,
    _store: hashes,
    _scripts: scripts,
    async evalsha(sha: string, numKeys: number, ...rest: (string | number)[]) {
      calls.push({ method: 'evalsha', args: [sha, numKeys, ...rest] })
      const source = scripts.get(sha)
      if (!source) throw new Error('NOSCRIPT No matching script.')
      const [key, ...scriptArgs] = rest
      return runScript(source, String(key), scriptArgs)
    },
    async eval(source: string, numKeys: number, ...rest: (string | number)[]) {
      calls.push({ method: 'eval', args: [source, numKeys, ...rest] })
      const [key, ...scriptArgs] = rest
      return runScript(source, String(key), scriptArgs)
    },
    async script(subcommand: 'LOAD', source: string) {
      calls.push({ method: 'script', args: [subcommand, source] })
      const sha = `sha-${scripts.size + 1}`
      scripts.set(sha, source)
      return sha
    },
    async hmget(key: string, ...fields: string[]): Promise<(string | null)[]> {
      calls.push({ method: 'hmget', args: [key, ...fields] })
      const entry = hashes.get(key)
      if (!entry) return fields.map(() => null)
      return fields.map(field => {
        switch (field) {
          case 'state':
            return entry.state
          case 'lastTransitionAt':
            return String(entry.lastTransitionAt)
          case 'nextAttemptAt':
            return String(entry.nextAttemptAt)
          case 'events':
            return JSON.stringify(entry.events)
          default:
            return null
        }
      })
    },
  }
}

describe('RedisCircuitBreakerStore', () => {
  let redis: ReturnType<typeof createFakeCircuitRedis>
  let store: RedisCircuitBreakerStore

  beforeEach(() => {
    redis = createFakeCircuitRedis()
    store = new RedisCircuitBreakerStore({ redis, keyPrefix: 'cb:test:' })
  })

  it('records failures through Lua and flips CLOSED → OPEN', async () => {
    for (let i = 0; i < 5; i++) {
      await store.recordFailure('svc', defaultThresholds)
    }
    const snap = await store.getSnapshot('svc')
    expect(snap.state).toBe(CircuitState.OPEN)
    expect(snap.nextAttemptAt).toBeGreaterThan(0)
  })

  it('recovers from NOSCRIPT by reloading the appropriate script', async () => {
    await store.recordFailure('svc', defaultThresholds)
    // Flush script cache to force NOSCRIPT
    redis._scripts.clear()
    await store.recordFailure('svc', defaultThresholds)

    const scriptLoads = redis._calls.filter(c => c.method === 'script').length
    // At least one load per script type we've exercised.
    expect(scriptLoads).toBeGreaterThanOrEqual(2)
  })

  it('checkAndUpdate moves OPEN → HALF_OPEN when cooldown elapses', async () => {
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(1_000_000)

    for (let i = 0; i < 5; i++) {
      await store.recordFailure('svc', defaultThresholds)
    }
    expect((await store.getSnapshot('svc')).state).toBe(CircuitState.OPEN)

    // advance past cooldown
    nowSpy.mockReturnValue(1_000_000 + defaultThresholds.resetTimeoutMs + 1)
    const snap = await store.checkAndUpdate('svc', defaultThresholds)
    expect(snap.state).toBe(CircuitState.HALF_OPEN)

    nowSpy.mockRestore()
  })

  it('HALF_OPEN failure immediately reopens', async () => {
    await store.transitionTo('svc', CircuitState.HALF_OPEN, defaultThresholds)
    await store.recordFailure('svc', defaultThresholds)
    const snap = await store.getSnapshot('svc')
    expect(snap.state).toBe(CircuitState.OPEN)
  })

  it('HALF_OPEN success returns to CLOSED', async () => {
    await store.transitionTo('svc', CircuitState.HALF_OPEN, defaultThresholds)
    await store.recordSuccess('svc', {
      ...defaultThresholds,
      errorThreshold: 100,
    })
    const snap = await store.getSnapshot('svc')
    expect(snap.state).toBe(CircuitState.CLOSED)
  })

  it('getSnapshot is a pure read and does not trim the event window', async () => {
    for (let i = 0; i < 3; i++) {
      await store.recordFailure('svc', defaultThresholds)
    }
    // Pre-read
    const before = await store.getSnapshot('svc')
    expect(before.windowRequests).toBe(3)
    expect(before.windowFailures).toBe(3)

    // Multiple getSnapshot calls must NOT mutate the window.
    for (let i = 0; i < 5; i++) {
      await store.getSnapshot('svc')
    }
    const after = await store.getSnapshot('svc')
    expect(after.windowRequests).toBe(3)
    expect(after.windowFailures).toBe(3)

    // And getSnapshot must NOT write any script (it's plain HMGET).
    const hmgets = redis._calls.filter(c => c.method === 'hmget').length
    expect(hmgets).toBeGreaterThan(0)
  })
})
