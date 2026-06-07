import crypto from 'node:crypto'
import { getRedisClient } from '../db/redis'

/**
 * PLM-COLLAB P3-D2 slice B (B1): the shared single-use store for embed-token `jti` consumption.
 *
 * Backed by the shared Redis (cross-instance), so a replay of a still-valid embed token is rejected
 * regardless of which instance handles it. There is deliberately NO in-memory fallback: a
 * per-instance memory store would not stop a replay that lands on a different instance, which would
 * defeat single-use. When the shared store is unavailable the consume throws and the caller MUST
 * fail closed (503), never fail open.
 *
 * Operational caveat (inherited from db/redis.ts): getRedisClient() memoizes a *startup* connection
 * failure as a permanent null, so if Redis is down at the first call the embed path stays
 * fail-closed (503) until the process restarts. After a successful first connect, ioredis recovers
 * from transient drops on its own (a drop just throws on the in-flight SET -> a single 503).
 */
export class EmbedJtiStoreUnavailableError extends Error {
  constructor(message = 'embed jti store unavailable') {
    super(message)
    this.name = 'EmbedJtiStoreUnavailableError'
  }
}

/**
 * Hash the SCOPED key so a bare jti never lands in Redis, and a jti can only be consumed within the
 * exact (aud, feature_key, tenant_id, part_id) scope it was minted for (no cross-scope collision).
 */
export function embedJtiKey(scope: {
  aud: string
  feature_key: string
  tenant_id: string
  part_id: string
  jti: string
}): string {
  const material = [scope.aud, scope.feature_key, scope.tenant_id, scope.part_id, scope.jti].join('|')
  const digest = crypto.createHash('sha256').update(material).digest('hex')
  return `plm-embed:jti:${digest}`
}

/**
 * Atomically consume the key. Returns true if it was newly consumed (first use), false if it was
 * already present (a replay). Throws EmbedJtiStoreUnavailableError when the shared store is
 * unavailable -- the caller fails closed.
 */
export async function consumeEmbedJti(key: string, ttlSeconds: number): Promise<boolean> {
  const redis = await getRedisClient()
  if (!redis) throw new EmbedJtiStoreUnavailableError()
  const ttl = Math.max(1, Math.floor(ttlSeconds))
  let result: string | null
  try {
    // SET key 1 EX <ttl> NX -> 'OK' when newly set (first use), null when the key already exists (replay)
    result = await redis.set(key, '1', 'EX', ttl, 'NX')
  } catch {
    throw new EmbedJtiStoreUnavailableError('embed jti store consume failed')
  }
  return result === 'OK'
}
