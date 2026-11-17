import { createHash } from 'node:crypto'
import { FEISHU_ENDPOINTS, feishuEndpointUrl, type FeishuBrand } from './endpoints'
import {
  FeishuCredentialError,
  FeishuIncompleteResponseError,
  isFeishuTokenInvalidError,
  readFeishuCode,
} from './errors'
import { requestFeishuJson } from './transport'

/**
 * Tenant access tokens for a self-built application.
 *
 *  - Minted at the token endpoint with client credentials (read tier, so a transient failure is retried
 *    by the transport). The answer must carry a non-empty `access_token` and a positive `expires_in`.
 *  - Cached in process memory only, keyed by connection, application and a short fingerprint of the
 *    secret, so a rotated secret never reuses a token minted for the old one. A token, a secret and a
 *    request body are never logged, stored or put in an error.
 *  - One mint at a time per key: concurrent callers wait for the same result.
 *  - A token is replaced once its remaining life falls below max(5 minutes, 10% of its lifetime).
 *  - A connection is minted for at most once every few seconds in a process (plus a short random
 *    spread): a refused token that triggers a re-mint cannot be amplified by many callers or replicas
 *    into a storm of mint requests. The interval is a wait, not a refusal.
 *  - `mintFresh` (the verification path) bypasses all of that: it neither reads, writes nor evicts the
 *    cache, joins no mint in progress, and takes no part in the interval.
 *
 * `withTenantToken` is the client layer's wrapper for an authenticated call. When the call fails with a
 * code that says the token itself was refused, it evicts that token, mints once and replays the SAME
 * call once. A logical call is replayed at most once, and one run (a pull, a verification) may re-mint at
 * most `maxRemintsPerRun` times in total; beyond that the failure is a FeishuCredentialError, so a token
 * that keeps being revoked is not chased indefinitely.
 */
export const FEISHU_TOKEN_LIMITS = Object.freeze({
  refreshFloorMs: 300_000,
  refreshFraction: 0.1,
  minMintIntervalMs: 5_000,
  mintJitterMaxMs: 1_000,
  maxRemintsPerRun: 3,
})

export interface FeishuTenantTokenCredentials {
  connectionId: string
  appId: string
  appSecret: string
  brand?: FeishuBrand
}

export interface FeishuFreshToken {
  accessToken: string
  expiresInSeconds: number
}

export interface FeishuTokenRunBudget {
  remints: number
}

export function createFeishuTokenRunBudget(): FeishuTokenRunBudget {
  return { remints: 0 }
}

export interface FeishuTenantTokenServiceOptions {
  fetchFn?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  /** Per-attempt timeout and back-off hooks handed to the transport. */
  transport?: {
    timeoutMs?: number
    sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<boolean>
    random?: () => number
  }
}

export interface FeishuTenantTokenService {
  getToken(credentials: FeishuTenantTokenCredentials): Promise<string>
  mintFresh(credentials: FeishuTenantTokenCredentials): Promise<FeishuFreshToken>
  /** Drops the cached token for these credentials; with `failedToken`, only if that is the token cached. */
  evict(credentials: FeishuTenantTokenCredentials, failedToken?: string): void
  withTenantToken<T>(
    credentials: FeishuTenantTokenCredentials,
    call: (accessToken: string) => Promise<T>,
    budget?: FeishuTokenRunBudget,
  ): Promise<T>
  clear(): void
}

interface CachedToken {
  connectionId: string
  token: string
  expiresAt: number
  lifetimeMs: number
}

function secretFingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16)
}

/** Connection, application and secret fingerprint, joined by a character no identifier can contain. */
function cacheKey(credentials: FeishuTenantTokenCredentials): string {
  return [credentials.connectionId, credentials.appId, secretFingerprint(credentials.appSecret)].join('\n')
}

export function createFeishuTenantTokenService(options: FeishuTenantTokenServiceOptions = {}): FeishuTenantTokenService {
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const random = options.random ?? Math.random

  const cache = new Map<string, CachedToken>()
  const inflight = new Map<string, Promise<string>>()
  const lastMintSlot = new Map<string, number>()

  async function mint(credentials: FeishuTenantTokenCredentials): Promise<FeishuFreshToken> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: credentials.appId,
      client_secret: credentials.appSecret,
    }).toString()
    const payload = await requestFeishuJson({
      url: feishuEndpointUrl(credentials.brand ?? 'feishu', FEISHU_ENDPOINTS.tenantAccessToken),
      init: { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
      kind: 'read',
      envelope: 'oauth',
      fetchFn: options.fetchFn,
      timeoutMs: options.transport?.timeoutMs,
      sleep: options.transport?.sleep,
      random: options.transport?.random,
    })
    const code = readFeishuCode(payload)
    const accessToken = payload.access_token
    if (typeof accessToken !== 'string' || accessToken.length === 0) throw new FeishuIncompleteResponseError('access_token_missing', code)
    const expiresIn = payload.expires_in
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new FeishuIncompleteResponseError('expires_in_missing', code)
    }
    return { accessToken, expiresInSeconds: expiresIn }
  }

  function needsRefresh(entry: CachedToken): boolean {
    const remaining = entry.expiresAt - now()
    return remaining < Math.max(FEISHU_TOKEN_LIMITS.refreshFloorMs, entry.lifetimeMs * FEISHU_TOKEN_LIMITS.refreshFraction)
  }

  /** Reserves this connection's next mint slot and waits for it; slots are at least the interval apart. */
  async function waitForMintSlot(connectionId: string): Promise<void> {
    const last = lastMintSlot.get(connectionId)
    const jitter = Math.trunc(random() * FEISHU_TOKEN_LIMITS.mintJitterMaxMs)
    const current = now()
    const slot = last === undefined ? current : Math.max(current, last + FEISHU_TOKEN_LIMITS.minMintIntervalMs + jitter)
    lastMintSlot.set(connectionId, slot)
    const wait = slot - current
    if (wait > 0) await sleep(wait)
  }

  async function mintAndCache(credentials: FeishuTenantTokenCredentials, key: string): Promise<string> {
    await waitForMintSlot(credentials.connectionId)
    const minted = await mint(credentials)
    // A rotated secret has a new key; the entries of the old fingerprint are of no further use.
    for (const [otherKey, entry] of cache) {
      if (entry.connectionId === credentials.connectionId && otherKey !== key) cache.delete(otherKey)
    }
    const lifetimeMs = minted.expiresInSeconds * 1000
    cache.set(key, {
      connectionId: credentials.connectionId,
      token: minted.accessToken,
      expiresAt: now() + lifetimeMs,
      lifetimeMs,
    })
    return minted.accessToken
  }

  function getToken(credentials: FeishuTenantTokenCredentials): Promise<string> {
    const key = cacheKey(credentials)
    const hit = cache.get(key)
    if (hit !== undefined && !needsRefresh(hit)) return Promise.resolve(hit.token)
    const running = inflight.get(key)
    if (running !== undefined) return running
    const started = mintAndCache(credentials, key).finally(() => {
      inflight.delete(key)
    })
    inflight.set(key, started)
    return started
  }

  function evict(credentials: FeishuTenantTokenCredentials, failedToken?: string): void {
    const key = cacheKey(credentials)
    const entry = cache.get(key)
    if (entry === undefined) return
    if (failedToken === undefined || entry.token === failedToken) cache.delete(key)
  }

  async function withTenantToken<T>(
    credentials: FeishuTenantTokenCredentials,
    call: (accessToken: string) => Promise<T>,
    budget: FeishuTokenRunBudget = createFeishuTokenRunBudget(),
  ): Promise<T> {
    const token = await getToken(credentials)
    try {
      return await call(token)
    } catch (error) {
      if (!isFeishuTokenInvalidError(error)) throw error
      if (budget.remints >= FEISHU_TOKEN_LIMITS.maxRemintsPerRun) throw new FeishuCredentialError()
      budget.remints += 1
      evict(credentials, token)
      const fresh = await getToken(credentials)
      return await call(fresh)
    }
  }

  return {
    getToken,
    mintFresh: mint,
    evict,
    withTenantToken,
    clear() {
      cache.clear()
      inflight.clear()
      lastMintSlot.clear()
    },
  }
}

/** The process-wide service the clients and the verification route use. */
export const feishuTenantTokens: FeishuTenantTokenService = createFeishuTenantTokenService()
