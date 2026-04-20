/**
 * Redis-backed CircuitBreaker store (Sprint 6 / Redis runtime).
 *
 * State layout per circuit (`{prefix}{id}`):
 *   HASH fields:
 *     state             'CLOSED' | 'OPEN' | 'HALF_OPEN'
 *     lastTransitionAt  epoch-ms
 *     nextAttemptAt     epoch-ms (0 when not OPEN)
 *     events            JSON array of { at, success } within the window
 *
 * Storing the event window as JSON inside the hash keeps the Lua scripts
 * self-contained; capacity is bounded by `volumeThreshold`-order values
 * so the payload stays small. This mirrors the in-process rolling window
 * the existing CircuitBreaker maintains.
 *
 * Every mutating call goes through a Lua script so record + transition
 * happens atomically across replicas.
 */

import { CircuitState } from './CircuitBreaker'
import type {
  CircuitBreakerSnapshot,
  CircuitBreakerStore,
  CircuitBreakerThresholds,
} from './circuit-breaker-store'

// ---------------------------------------------------------------------------
// Lua helpers reused by all scripts.
// ---------------------------------------------------------------------------

const LUA_HEADER = `
local key = KEYS[1]

local function load_state()
  local data = redis.call('HMGET', key, 'state', 'lastTransitionAt', 'nextAttemptAt', 'events')
  local state = data[1] or 'CLOSED'
  local lastAt = tonumber(data[2]) or 0
  local nextAt = tonumber(data[3]) or 0
  local events = data[4]
  return state, lastAt, nextAt, events
end

local function save_state(state, lastAt, nextAt, events)
  redis.call('HMSET', key, 'state', state, 'lastTransitionAt', lastAt, 'nextAttemptAt', nextAt, 'events', events)
end
`

// ---------------------------------------------------------------------------
// Public Lua sources (exported for inspection / tests).
//
// recordSuccess / recordFailure take (errorThreshold, volumeThreshold,
// windowSizeMs, resetTimeoutMs, nowMs, ttlSeconds) as ARGV.
// ---------------------------------------------------------------------------

export const CIRCUIT_RECORD_SUCCESS_LUA = (
  LUA_HEADER +
  `
local errorThreshold = tonumber(ARGV[1])
local _volume = tonumber(ARGV[2]) -- unused on success path, kept for symmetry
local windowSizeMs = tonumber(ARGV[3])
local _reset = tonumber(ARGV[4])
local nowMs = tonumber(ARGV[5])
local ttlSeconds = tonumber(ARGV[6])

local state, lastAt, nextAt, events = load_state()
if lastAt == 0 then lastAt = nowMs end

-- append + trim window
local list = cjson.decode(events or '[]')
local cutoff = nowMs - windowSizeMs
local kept = {}
for _, ev in ipairs(list) do
  if ev.at >= cutoff then table.insert(kept, ev) end
end
table.insert(kept, { at = nowMs, success = true })

if state == 'HALF_OPEN' then
  local total = #kept
  local failures = 0
  for _, ev in ipairs(kept) do
    if not ev.success then failures = failures + 1 end
  end
  local rate = 0
  if total > 0 then rate = (failures / total) * 100 end
  if rate < errorThreshold then
    state = 'CLOSED'
    lastAt = nowMs
    nextAt = 0
    kept = {} -- fresh window
  end
end

save_state(state, lastAt, nextAt, cjson.encode(kept))
redis.call('EXPIRE', key, ttlSeconds)

local total = #kept
local failures = 0
for _, ev in ipairs(kept) do
  if not ev.success then failures = failures + 1 end
end
return { state, tostring(total), tostring(failures), tostring(lastAt), tostring(nextAt) }
`
).trim()

export const CIRCUIT_RECORD_FAILURE_LUA = (
  LUA_HEADER +
  `
local errorThreshold = tonumber(ARGV[1])
local volume = tonumber(ARGV[2])
local windowSizeMs = tonumber(ARGV[3])
local resetTimeoutMs = tonumber(ARGV[4])
local nowMs = tonumber(ARGV[5])
local ttlSeconds = tonumber(ARGV[6])

local state, lastAt, nextAt, events = load_state()
if lastAt == 0 then lastAt = nowMs end

local list = cjson.decode(events or '[]')
local cutoff = nowMs - windowSizeMs
local kept = {}
for _, ev in ipairs(list) do
  if ev.at >= cutoff then table.insert(kept, ev) end
end
table.insert(kept, { at = nowMs, success = false })

if state == 'HALF_OPEN' then
  state = 'OPEN'
  lastAt = nowMs
  nextAt = nowMs + resetTimeoutMs
elseif state == 'CLOSED' then
  local total = #kept
  local failures = 0
  for _, ev in ipairs(kept) do
    if not ev.success then failures = failures + 1 end
  end
  local rate = 0
  if total > 0 then rate = (failures / total) * 100 end
  if total >= volume and rate >= errorThreshold then
    state = 'OPEN'
    lastAt = nowMs
    nextAt = nowMs + resetTimeoutMs
  end
end

save_state(state, lastAt, nextAt, cjson.encode(kept))
redis.call('EXPIRE', key, ttlSeconds)

local total = #kept
local failures = 0
for _, ev in ipairs(kept) do
  if not ev.success then failures = failures + 1 end
end
return { state, tostring(total), tostring(failures), tostring(lastAt), tostring(nextAt) }
`
).trim()

export const CIRCUIT_CHECK_AND_UPDATE_LUA = (
  LUA_HEADER +
  `
local windowSizeMs = tonumber(ARGV[3])
local nowMs = tonumber(ARGV[5])
local ttlSeconds = tonumber(ARGV[6])

local state, lastAt, nextAt, events = load_state()
if lastAt == 0 then lastAt = nowMs end

local list = cjson.decode(events or '[]')
local cutoff = nowMs - windowSizeMs
local kept = {}
for _, ev in ipairs(list) do
  if ev.at >= cutoff then table.insert(kept, ev) end
end

if state == 'OPEN' and nextAt > 0 and nowMs >= nextAt then
  state = 'HALF_OPEN'
  lastAt = nowMs
  nextAt = 0
end

save_state(state, lastAt, nextAt, cjson.encode(kept))
redis.call('EXPIRE', key, ttlSeconds)

local total = #kept
local failures = 0
for _, ev in ipairs(kept) do
  if not ev.success then failures = failures + 1 end
end
return { state, tostring(total), tostring(failures), tostring(lastAt), tostring(nextAt) }
`
).trim()

export const CIRCUIT_TRANSITION_LUA = (
  LUA_HEADER +
  `
local newState = ARGV[1]
local resetTimeoutMs = tonumber(ARGV[4])
local nowMs = tonumber(ARGV[5])
local ttlSeconds = tonumber(ARGV[6])

local state, lastAt, nextAt, events = load_state()
if state == newState then
  local list = cjson.decode(events or '[]')
  local total = #list
  local failures = 0
  for _, ev in ipairs(list) do
    if not ev.success then failures = failures + 1 end
  end
  return { state, tostring(total), tostring(failures), tostring(lastAt), tostring(nextAt) }
end

state = newState
lastAt = nowMs
if newState == 'OPEN' then
  nextAt = nowMs + resetTimeoutMs
else
  nextAt = 0
end

local keptStr = '[]'
if newState == 'CLOSED' then
  keptStr = '[]'
elseif events ~= nil then
  keptStr = events
end

save_state(state, lastAt, nextAt, keptStr)
redis.call('EXPIRE', key, ttlSeconds)

local list = cjson.decode(keptStr)
local total = #list
local failures = 0
for _, ev in ipairs(list) do
  if not ev.success then failures = failures + 1 end
end
return { state, tostring(total), tostring(failures), tostring(lastAt), tostring(nextAt) }
`
).trim()

// ---------------------------------------------------------------------------
// Pure-JS twins used by unit tests (and to sanity-check the Lua above).
// Each helper mutates a plain object mirroring the Redis hash layout.
// ---------------------------------------------------------------------------

export interface CircuitScriptState {
  state: CircuitState
  lastTransitionAt: number
  nextAttemptAt: number
  events: { at: number; success: boolean }[]
}

export function emptyCircuitState(): CircuitScriptState {
  return {
    state: CircuitState.CLOSED,
    lastTransitionAt: 0,
    nextAttemptAt: 0,
    events: [],
  }
}

function trim(state: CircuitScriptState, windowSizeMs: number, nowMs: number): void {
  const cutoff = nowMs - windowSizeMs
  if (state.events.length === 0) return
  state.events = state.events.filter(ev => ev.at >= cutoff)
}

function windowStats(state: CircuitScriptState): {
  totalRequests: number
  failures: number
  errorRate: number
} {
  const totalRequests = state.events.length
  const failures = state.events.reduce(
    (acc, ev) => (ev.success ? acc : acc + 1),
    0,
  )
  const errorRate = totalRequests > 0 ? (failures / totalRequests) * 100 : 0
  return { totalRequests, failures, errorRate }
}

export function applyRecordSuccessScript(
  state: CircuitScriptState,
  thresholds: CircuitBreakerThresholds,
  nowMs: number,
): CircuitScriptState {
  if (state.lastTransitionAt === 0) state.lastTransitionAt = nowMs
  trim(state, thresholds.windowSizeMs, nowMs)
  state.events.push({ at: nowMs, success: true })

  if (state.state === CircuitState.HALF_OPEN) {
    const { errorRate } = windowStats(state)
    if (errorRate < thresholds.errorThreshold) {
      state.state = CircuitState.CLOSED
      state.lastTransitionAt = nowMs
      state.nextAttemptAt = 0
      state.events = []
    }
  }
  return state
}

export function applyRecordFailureScript(
  state: CircuitScriptState,
  thresholds: CircuitBreakerThresholds,
  nowMs: number,
): CircuitScriptState {
  if (state.lastTransitionAt === 0) state.lastTransitionAt = nowMs
  trim(state, thresholds.windowSizeMs, nowMs)
  state.events.push({ at: nowMs, success: false })

  if (state.state === CircuitState.HALF_OPEN) {
    state.state = CircuitState.OPEN
    state.lastTransitionAt = nowMs
    state.nextAttemptAt = nowMs + thresholds.resetTimeoutMs
  } else if (state.state === CircuitState.CLOSED) {
    const { totalRequests, errorRate } = windowStats(state)
    if (
      totalRequests >= thresholds.volumeThreshold &&
      errorRate >= thresholds.errorThreshold
    ) {
      state.state = CircuitState.OPEN
      state.lastTransitionAt = nowMs
      state.nextAttemptAt = nowMs + thresholds.resetTimeoutMs
    }
  }
  return state
}

export function applyCheckAndUpdateScript(
  state: CircuitScriptState,
  thresholds: CircuitBreakerThresholds,
  nowMs: number,
): CircuitScriptState {
  if (state.lastTransitionAt === 0) state.lastTransitionAt = nowMs
  trim(state, thresholds.windowSizeMs, nowMs)
  if (
    state.state === CircuitState.OPEN &&
    state.nextAttemptAt > 0 &&
    nowMs >= state.nextAttemptAt
  ) {
    state.state = CircuitState.HALF_OPEN
    state.lastTransitionAt = nowMs
    state.nextAttemptAt = 0
  }
  return state
}

export function applyTransitionScript(
  state: CircuitScriptState,
  newState: CircuitState,
  thresholds: CircuitBreakerThresholds,
  nowMs: number,
): CircuitScriptState {
  if (state.state === newState) return state
  state.state = newState
  state.lastTransitionAt = nowMs
  state.nextAttemptAt =
    newState === CircuitState.OPEN ? nowMs + thresholds.resetTimeoutMs : 0
  if (newState === CircuitState.CLOSED) state.events = []
  return state
}

// ---------------------------------------------------------------------------
// Redis client shape — narrow enough for ioredis + a test shim.
// ---------------------------------------------------------------------------

export interface RedisCircuitClient {
  evalsha(
    sha1: string,
    numKeys: number,
    ...keysAndArgs: (string | number)[]
  ): Promise<unknown>
  eval(
    script: string,
    numKeys: number,
    ...keysAndArgs: (string | number)[]
  ): Promise<unknown>
  script(subcommand: 'LOAD', script: string): Promise<string>
  /** Read a set of hash fields. Must return one entry per field, or null. */
  hmget(key: string, ...fields: string[]): Promise<(string | null)[]>
}

export interface RedisCircuitBreakerStoreOptions {
  redis: RedisCircuitClient
  /** Prefix applied to every circuit key. Default: `cb:`. */
  keyPrefix?: string
  /** TTL (seconds) applied whenever the hash is touched. Default: 3600. */
  ttlSeconds?: number
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function parseSnapshot(raw: unknown): CircuitBreakerSnapshot {
  if (!Array.isArray(raw) || raw.length < 5) {
    throw new Error(
      `[RedisCircuitBreakerStore] unexpected Lua result: ${JSON.stringify(raw)}`,
    )
  }
  const stateStr = String(raw[0])
  const state: CircuitState =
    stateStr === CircuitState.OPEN
      ? CircuitState.OPEN
      : stateStr === CircuitState.HALF_OPEN
        ? CircuitState.HALF_OPEN
        : CircuitState.CLOSED
  return {
    state,
    windowRequests: Number(String(raw[1])),
    windowFailures: Number(String(raw[2])),
    lastTransitionAt: Number(String(raw[3])),
    nextAttemptAt: Number(String(raw[4])),
  }
}

function isNoScriptError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /NOSCRIPT/i.test(message)
}

export class RedisCircuitBreakerStore implements CircuitBreakerStore {
  private readonly redis: RedisCircuitClient
  private readonly keyPrefix: string
  private readonly ttlSeconds: number
  private shaCache: Record<string, string | null> = {
    success: null,
    failure: null,
    check: null,
    transition: null,
  }

  constructor(options: RedisCircuitBreakerStoreOptions) {
    this.redis = options.redis
    this.keyPrefix = options.keyPrefix ?? 'cb:'
    this.ttlSeconds = options.ttlSeconds ?? 3600
  }

  async getSnapshot(id: string): Promise<CircuitBreakerSnapshot> {
    // Pure read: HMGET the hash and decode locally. No Lua, no trimming,
    // no state transitions — `getSnapshot` must not mutate the circuit
    // (the MemoryCircuitBreakerStore contract is also read-only).
    const redisKey = this.keyPrefix + id
    const fields = await this.redis.hmget(
      redisKey,
      'state',
      'lastTransitionAt',
      'nextAttemptAt',
      'events',
    )
    const [stateRaw, lastAtRaw, nextAtRaw, eventsRaw] = fields
    const stateStr = stateRaw ?? CircuitState.CLOSED
    const state: CircuitState =
      stateStr === CircuitState.OPEN
        ? CircuitState.OPEN
        : stateStr === CircuitState.HALF_OPEN
          ? CircuitState.HALF_OPEN
          : CircuitState.CLOSED

    let windowRequests = 0
    let windowFailures = 0
    if (eventsRaw) {
      try {
        const list = JSON.parse(eventsRaw) as { at: number; success: boolean }[]
        windowRequests = list.length
        windowFailures = list.reduce(
          (acc, ev) => (ev.success ? acc : acc + 1),
          0,
        )
      } catch {
        // Corrupt payload — treat as empty window rather than crash.
      }
    }

    return {
      state,
      windowRequests,
      windowFailures,
      lastTransitionAt: Number(lastAtRaw ?? 0) || 0,
      nextAttemptAt: Number(nextAtRaw ?? 0) || 0,
    }
  }

  async recordSuccess(
    id: string,
    thresholds: CircuitBreakerThresholds,
  ): Promise<CircuitBreakerSnapshot> {
    return this.run('success', CIRCUIT_RECORD_SUCCESS_LUA, id, [
      thresholds.errorThreshold,
      thresholds.volumeThreshold,
      thresholds.windowSizeMs,
      thresholds.resetTimeoutMs,
      Math.floor(Date.now()),
      this.ttlSeconds,
    ])
  }

  async recordFailure(
    id: string,
    thresholds: CircuitBreakerThresholds,
  ): Promise<CircuitBreakerSnapshot> {
    return this.run('failure', CIRCUIT_RECORD_FAILURE_LUA, id, [
      thresholds.errorThreshold,
      thresholds.volumeThreshold,
      thresholds.windowSizeMs,
      thresholds.resetTimeoutMs,
      Math.floor(Date.now()),
      this.ttlSeconds,
    ])
  }

  async transitionTo(
    id: string,
    state: CircuitState,
    thresholds: CircuitBreakerThresholds,
  ): Promise<CircuitBreakerSnapshot> {
    return this.run('transition', CIRCUIT_TRANSITION_LUA, id, [
      state,
      thresholds.volumeThreshold,
      thresholds.windowSizeMs,
      thresholds.resetTimeoutMs,
      Math.floor(Date.now()),
      this.ttlSeconds,
    ])
  }

  async checkAndUpdate(
    id: string,
    thresholds: CircuitBreakerThresholds,
  ): Promise<CircuitBreakerSnapshot> {
    return this.run('check', CIRCUIT_CHECK_AND_UPDATE_LUA, id, [
      thresholds.errorThreshold,
      thresholds.volumeThreshold,
      thresholds.windowSizeMs,
      thresholds.resetTimeoutMs,
      Math.floor(Date.now()),
      this.ttlSeconds,
    ])
  }

  private async run(
    slot: keyof typeof this.shaCache,
    source: string,
    id: string,
    args: (string | number)[],
  ): Promise<CircuitBreakerSnapshot> {
    const redisKey = this.keyPrefix + id

    const cached = this.shaCache[slot]
    if (cached) {
      try {
        const raw = await this.redis.evalsha(cached, 1, redisKey, ...args)
        return parseSnapshot(raw)
      } catch (err) {
        if (!isNoScriptError(err)) throw err
        this.shaCache[slot] = null
      }
    }

    try {
      const sha = await this.redis.script('LOAD', source)
      this.shaCache[slot] = sha
      const raw = await this.redis.evalsha(sha, 1, redisKey, ...args)
      return parseSnapshot(raw)
    } catch {
      const raw = await this.redis.eval(source, 1, redisKey, ...args)
      return parseSnapshot(raw)
    }
  }
}
