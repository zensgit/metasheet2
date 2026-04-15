/**
 * Redis client singleton (ioredis).
 *
 * Usage:
 *   import { getRedisClient } from '../db/redis'
 *   const redis = await getRedisClient()
 *
 * Configuration:
 *   REDIS_URL  — full connection string (default: redis://localhost:6379)
 *
 * The client is lazily created on first call and reused thereafter.
 * Returns `null` if the REDIS_URL is empty or connection fails, so
 * callers can gracefully fall back to in-memory alternatives.
 */

import Redis from 'ioredis'

let client: Redis | null = null
let connectionAttempted = false

export async function getRedisClient(): Promise<Redis | null> {
  if (client) return client
  if (connectionAttempted) return null // already failed once

  const url = process.env.REDIS_URL
  if (!url) return null

  connectionAttempted = true
  try {
    const redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableReadyCheck: true,
    })

    redis.on('error', (err) => {
      console.error('[redis] connection error:', err.message)
    })

    await redis.connect()
    client = redis
    return client
  } catch (err) {
    console.warn(
      '[redis] failed to connect:',
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

/**
 * Disconnect and clear the singleton (useful in tests / graceful shutdown).
 */
export async function closeRedisClient(): Promise<void> {
  if (client) {
    await client.quit()
    client = null
  }
  connectionAttempted = false
}
