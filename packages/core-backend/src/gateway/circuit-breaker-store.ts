/**
 * Pluggable storage backend for CircuitBreaker.
 *
 * The existing in-process `CircuitBreaker` uses a private field for state
 * and a `RequestRecord[]` rolling window. Both are lost on process restart
 * and cannot be shared between API-gateway replicas. This store abstracts
 * "what state am I in? how many failures have I seen lately?" so callers
 * can opt into a Redis-backed, cluster-wide circuit.
 *
 * The interface is deliberately "smart": record-methods take the CB
 * thresholds and perform the record + maybe-transition step atomically in
 * Lua. Otherwise multiple replicas could race and disagree about state.
 */

import { CircuitState } from './CircuitBreaker'

export interface CircuitBreakerThresholds {
  /** Error percentage that triggers CLOSED -> OPEN. */
  errorThreshold: number
  /** Minimum requests required before errorThreshold is evaluated. */
  volumeThreshold: number
  /** Rolling window size in milliseconds. */
  windowSizeMs: number
  /** Cooldown in ms before OPEN is eligible to transition to HALF_OPEN. */
  resetTimeoutMs: number
}

export interface CircuitBreakerSnapshot {
  state: CircuitState
  /** Total requests observed within the rolling window. */
  windowRequests: number
  /** Failed requests observed within the rolling window. */
  windowFailures: number
  /** Epoch-ms of the last state transition. */
  lastTransitionAt: number
  /** Epoch-ms when OPEN is eligible to become HALF_OPEN (0 when N/A). */
  nextAttemptAt: number
}

export interface CircuitBreakerStore {
  /**
   * Read the current snapshot for the circuit. Implementations should
   * lazily initialize an empty (CLOSED) entry when none exists.
   */
  getSnapshot(id: string): Promise<CircuitBreakerSnapshot>

  /**
   * Record a successful request and return the resulting snapshot.
   * Must atomically transition HALF_OPEN → CLOSED when the error rate
   * within the window drops below the threshold.
   */
  recordSuccess(
    id: string,
    thresholds: CircuitBreakerThresholds,
  ): Promise<CircuitBreakerSnapshot>

  /**
   * Record a failed request and return the resulting snapshot.
   * Must atomically transition:
   *  - CLOSED → OPEN when the window meets volume & error thresholds.
   *  - HALF_OPEN → OPEN on any failure.
   */
  recordFailure(
    id: string,
    thresholds: CircuitBreakerThresholds,
  ): Promise<CircuitBreakerSnapshot>

  /**
   * Explicitly move to a new state (admin actions: `reset`, `forceOpen`).
   */
  transitionTo(
    id: string,
    state: CircuitState,
    thresholds: CircuitBreakerThresholds,
  ): Promise<CircuitBreakerSnapshot>

  /**
   * Convenience: read snapshot and, if the breaker is OPEN and the
   * cooldown has elapsed, atomically move it to HALF_OPEN.
   *
   * Used on the hot path at the start of `execute()`.
   */
  checkAndUpdate(
    id: string,
    thresholds: CircuitBreakerThresholds,
  ): Promise<CircuitBreakerSnapshot>
}

// ---------------------------------------------------------------------------
// In-memory implementation — equivalent to the behaviour already inlined
// in `CircuitBreaker` for the default case, but accessible via the store
// interface so tests and alternate backends share the same contract.
// ---------------------------------------------------------------------------

interface MemoryEntry {
  state: CircuitState
  /** Per-request log within the rolling window. */
  events: { at: number; success: boolean }[]
  lastTransitionAt: number
  nextAttemptAt: number
}

export class MemoryCircuitBreakerStore implements CircuitBreakerStore {
  private readonly entries = new Map<string, MemoryEntry>()

  async getSnapshot(id: string): Promise<CircuitBreakerSnapshot> {
    const entry = this.getOrCreate(id)
    return this.snapshot(entry)
  }

  async recordSuccess(
    id: string,
    thresholds: CircuitBreakerThresholds,
  ): Promise<CircuitBreakerSnapshot> {
    const nowMs = Math.floor(Date.now())
    const entry = this.getOrCreate(id)
    this.trimWindow(entry, thresholds.windowSizeMs, nowMs)
    entry.events.push({ at: nowMs, success: true })

    if (entry.state === CircuitState.HALF_OPEN) {
      const { errorRate } = this.windowStats(entry)
      if (errorRate < thresholds.errorThreshold) {
        this.setState(entry, CircuitState.CLOSED, thresholds, nowMs)
      }
    }

    return this.snapshot(entry)
  }

  async recordFailure(
    id: string,
    thresholds: CircuitBreakerThresholds,
  ): Promise<CircuitBreakerSnapshot> {
    const nowMs = Math.floor(Date.now())
    const entry = this.getOrCreate(id)
    this.trimWindow(entry, thresholds.windowSizeMs, nowMs)
    entry.events.push({ at: nowMs, success: false })

    if (entry.state === CircuitState.HALF_OPEN) {
      // Any failure during probe re-opens the circuit.
      this.setState(entry, CircuitState.OPEN, thresholds, nowMs)
    } else if (entry.state === CircuitState.CLOSED) {
      const { totalRequests, errorRate } = this.windowStats(entry)
      if (
        totalRequests >= thresholds.volumeThreshold &&
        errorRate >= thresholds.errorThreshold
      ) {
        this.setState(entry, CircuitState.OPEN, thresholds, nowMs)
      }
    }

    return this.snapshot(entry)
  }

  async transitionTo(
    id: string,
    state: CircuitState,
    thresholds: CircuitBreakerThresholds,
  ): Promise<CircuitBreakerSnapshot> {
    const nowMs = Math.floor(Date.now())
    const entry = this.getOrCreate(id)
    this.setState(entry, state, thresholds, nowMs)
    return this.snapshot(entry)
  }

  async checkAndUpdate(
    id: string,
    thresholds: CircuitBreakerThresholds,
  ): Promise<CircuitBreakerSnapshot> {
    const nowMs = Math.floor(Date.now())
    const entry = this.getOrCreate(id)
    this.trimWindow(entry, thresholds.windowSizeMs, nowMs)

    if (
      entry.state === CircuitState.OPEN &&
      entry.nextAttemptAt > 0 &&
      nowMs >= entry.nextAttemptAt
    ) {
      this.setState(entry, CircuitState.HALF_OPEN, thresholds, nowMs)
    }

    return this.snapshot(entry)
  }

  /** Test hook — forget all circuits. */
  reset(): void {
    this.entries.clear()
  }

  private getOrCreate(id: string): MemoryEntry {
    let entry = this.entries.get(id)
    if (!entry) {
      entry = {
        state: CircuitState.CLOSED,
        events: [],
        lastTransitionAt: Math.floor(Date.now()),
        nextAttemptAt: 0,
      }
      this.entries.set(id, entry)
    }
    return entry
  }

  private trimWindow(entry: MemoryEntry, windowSizeMs: number, nowMs: number): void {
    const cutoff = nowMs - windowSizeMs
    if (entry.events.length === 0 || entry.events[0].at >= cutoff) return
    entry.events = entry.events.filter(e => e.at >= cutoff)
  }

  private windowStats(entry: MemoryEntry): {
    totalRequests: number
    failures: number
    errorRate: number
  } {
    const totalRequests = entry.events.length
    const failures = entry.events.reduce(
      (acc, e) => (e.success ? acc : acc + 1),
      0,
    )
    const errorRate = totalRequests > 0 ? (failures / totalRequests) * 100 : 0
    return { totalRequests, failures, errorRate }
  }

  private setState(
    entry: MemoryEntry,
    state: CircuitState,
    thresholds: CircuitBreakerThresholds,
    nowMs: number,
  ): void {
    if (entry.state === state) return
    entry.state = state
    entry.lastTransitionAt = nowMs
    entry.nextAttemptAt =
      state === CircuitState.OPEN ? nowMs + thresholds.resetTimeoutMs : 0
    if (state === CircuitState.CLOSED) {
      // Fresh window on close so past failures don't immediately re-open.
      entry.events = []
    }
  }

  private snapshot(entry: MemoryEntry): CircuitBreakerSnapshot {
    const { totalRequests, failures } = this.windowStats(entry)
    return {
      state: entry.state,
      windowRequests: totalRequests,
      windowFailures: failures,
      lastTransitionAt: entry.lastTransitionAt,
      nextAttemptAt: entry.nextAttemptAt,
    }
  }
}
