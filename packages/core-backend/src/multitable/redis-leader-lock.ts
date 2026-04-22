/**
 * Redis-backed single-leader election helper.
 *
 * Pattern:
 *   SET <key> <ownerId> NX PX <ttlMs>    — acquire (atomic)
 *   GET + compare + PEXPIRE (Lua)        — renew only if still owner
 *   GET + compare + DEL (Lua)            — release only if still owner
 *   GET + compare                        — read-only ownership check
 *
 * The wire format is deliberately minimal: one string value per lock key.
 * The same helper is consumed by `AutomationScheduler` to ensure that in a
 * multi-process deployment only one replica runs the interval timers for a
 * given rule set. Implementations must tolerate Redis outages gracefully —
 * a failed `acquire` returns `false` (not-leader) so the caller keeps
 * functioning with no active timers rather than crashing.
 *
 * A pure-JS twin (`MemoryLeaderLockClient`) is exported so tests can run
 * deterministically without a real Redis instance. It mirrors the
 * `SET NX PX` / matching-owner semantics exactly.
 */

// ---------------------------------------------------------------------------
// Client surface — narrow enough for ioredis with a single unknown-cast and
// for our in-memory test twin.
// ---------------------------------------------------------------------------

export interface RedisLeaderLockClient {
  /**
   * SET key value with optional NX (not-exists) + PX (expiry in ms). The
   * return type matches ioredis: 'OK' on success, null when NX failed.
   */
  set(
    key: string,
    value: string,
    ...args: (string | number)[]
  ): Promise<string | null>
  get(key: string): Promise<string | null>
  eval(
    script: string,
    numKeys: number,
    ...keysAndArgs: (string | number)[]
  ): Promise<unknown>
}

// Lua scripts: the GET-compare-then-act pattern must be atomic, otherwise a
// TTL-expiry between `GET` and the follow-up PEXPIRE/DEL could let us revive
// a lock that's already been re-acquired by another owner.

/** KEYS[1]=lockKey, ARGV[1]=ownerId, ARGV[2]=ttlMs */
export const LEADER_RENEW_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
else
  return 0
end
`.trim()

/** KEYS[1]=lockKey, ARGV[1]=ownerId */
export const LEADER_RELEASE_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`.trim()

// ---------------------------------------------------------------------------
// Pure-JS twin used by unit tests and by callers that want a zero-dependency
// single-process fallback.
// ---------------------------------------------------------------------------

interface MemoryLockEntry {
  value: string
  expireAt: number
}

export class MemoryLeaderLockClient implements RedisLeaderLockClient {
  private store: Map<string, MemoryLockEntry>
  private nowFn: () => number

  constructor(
    store: Map<string, MemoryLockEntry> = new Map(),
    nowFn: () => number = () => Date.now(),
  ) {
    this.store = store
    this.nowFn = nowFn
  }

  private isExpired(entry: MemoryLockEntry): boolean {
    return entry.expireAt > 0 && this.nowFn() >= entry.expireAt
  }

  async set(
    key: string,
    value: string,
    ...args: (string | number)[]
  ): Promise<string | null> {
    // Parse the flags we actually care about (NX, PX <ms>).
    let nx = false
    let pxMs = 0
    for (let i = 0; i < args.length; i++) {
      const arg = String(args[i]).toUpperCase()
      if (arg === 'NX') nx = true
      else if (arg === 'PX') {
        pxMs = Number(args[i + 1])
        i++
      }
    }

    const existing = this.store.get(key)
    if (existing && !this.isExpired(existing) && nx) {
      return null
    }

    const expireAt = pxMs > 0 ? this.nowFn() + pxMs : 0
    this.store.set(key, { value, expireAt })
    return 'OK'
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key)
    if (!entry) return null
    if (this.isExpired(entry)) {
      this.store.delete(key)
      return null
    }
    return entry.value
  }

  async eval(
    script: string,
    _numKeys: number,
    ...keysAndArgs: (string | number)[]
  ): Promise<unknown> {
    const [keyRaw, ...argsRaw] = keysAndArgs
    const key = String(keyRaw)
    const args = argsRaw.map(String)

    // Only the two scripts defined above need to be understood by the twin.
    if (script === LEADER_RENEW_LUA) {
      const owner = args[0]
      const ttlMs = Number(args[1])
      const entry = this.store.get(key)
      if (!entry || this.isExpired(entry) || entry.value !== owner) return 0
      entry.expireAt = ttlMs > 0 ? this.nowFn() + ttlMs : 0
      this.store.set(key, entry)
      return 1
    }
    if (script === LEADER_RELEASE_LUA) {
      const owner = args[0]
      const entry = this.store.get(key)
      if (!entry || this.isExpired(entry) || entry.value !== owner) return 0
      this.store.delete(key)
      return 1
    }

    throw new Error('[MemoryLeaderLockClient] unknown script')
  }
}

// ---------------------------------------------------------------------------
// Public helper: a thin object around a `RedisLeaderLockClient`. It only
// speaks in terms of lockKey + ownerId so callers never have to juggle the
// SET flags themselves.
// ---------------------------------------------------------------------------

export interface RedisLeaderLockOptions {
  client: RedisLeaderLockClient
}

export class RedisLeaderLock {
  private readonly client: RedisLeaderLockClient

  constructor(options: RedisLeaderLockOptions) {
    this.client = options.client
  }

  /**
   * Attempt to claim the lock atomically via SET NX PX.
   * Returns `true` when this process is now the holder, `false` when
   * another process already holds it (or when the Redis call fails).
   */
  async acquire(lockKey: string, ownerId: string, ttlMs: number): Promise<boolean> {
    if (ttlMs <= 0) return false
    try {
      const result = await this.client.set(lockKey, ownerId, 'NX', 'PX', ttlMs)
      return result === 'OK'
    } catch {
      return false
    }
  }

  /**
   * Extend the lock's TTL if — and only if — the current value matches
   * `ownerId`. Returns `true` when the TTL was refreshed, `false` when the
   * lock is held by someone else / has expired / Redis is unreachable.
   */
  async renew(lockKey: string, ownerId: string, ttlMs: number): Promise<boolean> {
    if (ttlMs <= 0) return false
    try {
      const res = await this.client.eval(LEADER_RENEW_LUA, 1, lockKey, ownerId, ttlMs)
      return Number(res) === 1
    } catch {
      return false
    }
  }

  /**
   * Release the lock if the caller still holds it. Matches the standard
   * "owner-scoped DEL" pattern so a stale client can't wipe a lock that has
   * rolled over to a new leader.
   */
  async release(lockKey: string, ownerId: string): Promise<boolean> {
    try {
      const res = await this.client.eval(LEADER_RELEASE_LUA, 1, lockKey, ownerId)
      return Number(res) === 1
    } catch {
      return false
    }
  }

  /**
   * Read-only ownership check. Returns `true` when the given owner matches
   * the value currently stored under `lockKey`.
   */
  async isHeldBy(lockKey: string, ownerId: string): Promise<boolean> {
    try {
      const value = await this.client.get(lockKey)
      return value === ownerId
    } catch {
      return false
    }
  }
}
