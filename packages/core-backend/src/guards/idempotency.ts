/**
 * Idempotency Key & Rate Limiting for SafetyGuard
 *
 * Prevents duplicate operation executions and provides rate limiting
 * for confirmation endpoints.
 *
 * Supports Redis-backed storage for cluster-safe idempotency with
 * automatic fallback to in-memory when Redis is unavailable.
 * Feature flag: IDEMPOTENCY_STORE=redis|memory (default: memory)
 */

import type { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import { Logger } from '../core/logger';
import * as metrics from './safety-metrics';

const logger = new Logger('SafetyGuardIdempotency');

interface IdempotencyEntry {
  response: {
    statusCode: number;
    body: unknown;
  };
  createdAt: Date;
  expiresAt: Date;
}

interface RateLimitEntry {
  count: number;
  resetAt: Date;
}

interface IdempotencyConfig {
  enabled: boolean;
  ttlSeconds: number; // How long to cache responses
  maxKeyLength: number;
}

interface RateLimitConfig {
  enabled: boolean;
  windowSeconds: number;
  maxRequests: number;
}

const DEFAULT_IDEMPOTENCY_CONFIG: IdempotencyConfig = {
  enabled: true,
  ttlSeconds: 3600, // 1 hour
  maxKeyLength: 255
};

const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  enabled: true,
  windowSeconds: 60, // 1 minute
  maxRequests: 10 // 10 requests per minute per user
};

// ---------------------------------------------------------------------------
// Idempotency Store abstraction
// ---------------------------------------------------------------------------

interface IdempotencyStore {
  get(key: string): Promise<IdempotencyEntry | undefined>;
  set(key: string, entry: IdempotencyEntry, ttlSeconds: number): Promise<void>;
  clear(): Promise<void>;
  size(): Promise<number>;
}

/**
 * In-memory idempotency store (original implementation).
 */
class MemoryIdempotencyStore implements IdempotencyStore {
  private store = new Map<string, IdempotencyEntry>();

  async get(key: string): Promise<IdempotencyEntry | undefined> {
    const entry = this.store.get(key);
    if (entry && new Date() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async set(key: string, entry: IdempotencyEntry, _ttlSeconds: number): Promise<void> {
    this.store.set(key, entry);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  async size(): Promise<number> {
    return this.store.size;
  }

  /** Purge expired entries – called periodically */
  cleanup(): number {
    const now = new Date();
    let cleaned = 0;
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
        cleaned++;
      }
    }
    return cleaned;
  }
}

/**
 * Redis-backed idempotency store.
 *
 * Key format: `idem:{userId}:{idempotencyKey}` (managed by caller via
 * the composite cache key).  Stores serialised response JSON with EX TTL.
 *
 * On any Redis error the store silently falls back to the in-memory store
 * so that requests are never blocked by a Redis outage.
 */
export class RedisIdempotencyStore implements IdempotencyStore {
  private redis: Redis;
  private connected = false;
  private fallback: MemoryIdempotencyStore;
  private static readonly KEY_PREFIX = 'idem:';

  constructor(redis: Redis, fallback: MemoryIdempotencyStore) {
    this.redis = redis;
    this.fallback = fallback;

    // Track connection state
    this.redis.on('connect', () => { this.connected = true; });
    this.redis.on('ready', () => { this.connected = true; });
    this.redis.on('error', () => { this.connected = false; });
    this.redis.on('end', () => { this.connected = false; });
    this.redis.on('close', () => { this.connected = false; });

    // If client is already ready (e.g. shared connection)
    if ((this.redis as unknown as { status: string }).status === 'ready') {
      this.connected = true;
    }
  }

  private redisKey(key: string): string {
    return `${RedisIdempotencyStore.KEY_PREFIX}${key}`;
  }

  async get(key: string): Promise<IdempotencyEntry | undefined> {
    if (!this.connected) {
      return this.fallback.get(key);
    }
    try {
      const raw = await this.redis.get(this.redisKey(key));
      if (!raw) {
        // Also check fallback for entries stored during a previous outage
        return this.fallback.get(key);
      }
      const parsed = JSON.parse(raw);
      return {
        response: parsed.response,
        createdAt: new Date(parsed.createdAt),
        expiresAt: new Date(parsed.expiresAt)
      };
    } catch (err) {
      logger.warn('Redis idempotency GET failed, falling back to memory', {
        context: 'SafetyGuardIdempotency',
        error: err instanceof Error ? err.message : String(err)
      });
      return this.fallback.get(key);
    }
  }

  async set(key: string, entry: IdempotencyEntry, ttlSeconds: number): Promise<void> {
    // Always write to memory fallback so it's available if Redis drops
    await this.fallback.set(key, entry, ttlSeconds);

    if (!this.connected) {
      return;
    }
    try {
      const payload = JSON.stringify({
        response: entry.response,
        createdAt: entry.createdAt.toISOString(),
        expiresAt: entry.expiresAt.toISOString()
      });
      await this.redis.set(this.redisKey(key), payload, 'EX', ttlSeconds);
    } catch (err) {
      logger.warn('Redis idempotency SET failed, entry stored in memory only', {
        context: 'SafetyGuardIdempotency',
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  async clear(): Promise<void> {
    await this.fallback.clear();
    // We intentionally do NOT flush Redis keys globally – clearing is
    // only used in tests or local resets.
  }

  async size(): Promise<number> {
    // Approximate – return memory fallback size (Redis key count is expensive)
    return this.fallback.size();
  }
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const memoryStore = new MemoryIdempotencyStore();
let activeStore: IdempotencyStore = memoryStore;
const rateLimitStore = new Map<string, RateLimitEntry>();

let idempotencyConfig = DEFAULT_IDEMPOTENCY_CONFIG;
let rateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG;

// Cleanup interval
let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * Initialize idempotency and rate limiting.
 *
 * When `IDEMPOTENCY_STORE=redis` and a valid `REDIS_URL` is set, a
 * {@link RedisIdempotencyStore} is created.  Otherwise the default
 * in-memory store is used.
 */
export function initIdempotency(
  config: Partial<IdempotencyConfig> = {},
  redisClient?: Redis
): void {
  idempotencyConfig = { ...DEFAULT_IDEMPOTENCY_CONFIG, ...config };

  // Determine store backend
  const storeType = process.env.IDEMPOTENCY_STORE || 'memory';

  if (storeType === 'redis') {
    const redis = redisClient ?? (process.env.REDIS_URL ? new Redis(process.env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 1 }) : null);
    if (redis) {
      activeStore = new RedisIdempotencyStore(redis, memoryStore);
      logger.info('Idempotency store: Redis (with memory fallback)', {
        context: 'SafetyGuardIdempotency'
      });
    } else {
      logger.warn('IDEMPOTENCY_STORE=redis but no REDIS_URL; using memory store', {
        context: 'SafetyGuardIdempotency'
      });
      activeStore = memoryStore;
    }
  } else {
    activeStore = memoryStore;
  }

  // Start cleanup interval
  if (!cleanupInterval) {
    cleanupInterval = setInterval(() => {
      cleanupExpiredEntries();
    }, 60000); // Every minute
  }

  logger.info('Idempotency service initialized', {
    context: 'SafetyGuardIdempotency',
    enabled: idempotencyConfig.enabled,
    ttlSeconds: idempotencyConfig.ttlSeconds,
    store: storeType
  });
}

/**
 * Initialize rate limiting
 */
export function initRateLimit(config: Partial<RateLimitConfig> = {}): void {
  rateLimitConfig = { ...DEFAULT_RATE_LIMIT_CONFIG, ...config };

  logger.info('Rate limiting initialized', {
    context: 'SafetyGuardIdempotency',
    enabled: rateLimitConfig.enabled,
    windowSeconds: rateLimitConfig.windowSeconds,
    maxRequests: rateLimitConfig.maxRequests
  });
}

/**
 * Cleanup expired entries
 */
function cleanupExpiredEntries(): void {
  let rateLimitCleaned = 0;

  // Cleanup in-memory idempotency entries
  const idempotencyCleaned = memoryStore.cleanup();

  // Cleanup rate limit entries
  const now = new Date();
  for (const [key, entry] of rateLimitStore) {
    if (now > entry.resetAt) {
      rateLimitStore.delete(key);
      rateLimitCleaned++;
    }
  }

  if (idempotencyCleaned > 0 || rateLimitCleaned > 0) {
    logger.debug('Cleaned up expired entries', {
      context: 'SafetyGuardIdempotency',
      idempotencyCleaned,
      rateLimitCleaned,
      remainingRateLimit: rateLimitStore.size
    });
  }
}

/**
 * Generate idempotency cache key.
 * Format: `{userId}:{idempotencyKey}` — the Redis store adds its own prefix.
 */
function generateCacheKey(userId: string, idempotencyKey: string): string {
  return `${userId}:${idempotencyKey}`;
}

/**
 * Middleware to enforce idempotency keys
 *
 * Usage:
 * ```
 * router.post('/safety/confirm', requireIdempotency(), handler)
 * ```
 */
export function requireIdempotency() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!idempotencyConfig.enabled) {
      next();
      return;
    }

    const idempotencyKey = req.headers['x-idempotency-key'] as string;

    // Idempotency key is optional but recommended
    if (!idempotencyKey) {
      // Allow request but log warning
      logger.debug('Request without idempotency key', {
        context: 'SafetyGuardIdempotency',
        path: req.path,
        method: req.method
      });
      next();
      return;
    }

    // Validate key length
    if (idempotencyKey.length > idempotencyConfig.maxKeyLength) {
      res.status(400).json({
        error: 'ValidationError',
        code: 'IDEMPOTENCY_KEY_TOO_LONG',
        message: `Idempotency key must be at most ${idempotencyConfig.maxKeyLength} characters`
      });
      return;
    }

    const user = (req as Request & { user?: { id?: string } }).user;
    const userId = user?.id || req.ip || 'anonymous';
    const cacheKey = generateCacheKey(userId, idempotencyKey);

    // Async lookup against the active store (Redis or memory)
    activeStore.get(cacheKey).then((cachedEntry) => {
      if (cachedEntry && new Date() <= cachedEntry.expiresAt) {
        logger.info('Returning cached idempotent response', {
          context: 'SafetyGuardIdempotency',
          userId,
          keyPrefix: idempotencyKey.substring(0, 20),
          statusCode: cachedEntry.response.statusCode
        });

        metrics.recordIdempotencyHit();

        // Return cached response with indicator header
        res.set('X-Idempotency-Replayed', 'true');
        res.status(cachedEntry.response.statusCode).json(cachedEntry.response.body);
        return;
      }

      metrics.recordIdempotencyMiss();

      // Capture the response for caching
      const originalJson = res.json.bind(res);
      res.json = (body: unknown) => {
        // Store response in cache (fire-and-forget)
        const expiresAt = new Date(
          Date.now() + idempotencyConfig.ttlSeconds * 1000
        );

        activeStore.set(cacheKey, {
          response: {
            statusCode: res.statusCode,
            body
          },
          createdAt: new Date(),
          expiresAt
        }, idempotencyConfig.ttlSeconds).catch((err) => {
          logger.warn('Failed to cache idempotency response', {
            context: 'SafetyGuardIdempotency',
            error: err instanceof Error ? err.message : String(err)
          });
        });

        logger.debug('Cached response for idempotency key', {
          context: 'SafetyGuardIdempotency',
          userId,
          keyPrefix: idempotencyKey.substring(0, 20),
          statusCode: res.statusCode,
          expiresIn: idempotencyConfig.ttlSeconds
        });

        return originalJson(body);
      };

      next();
    }).catch((err) => {
      // On store error, proceed without idempotency rather than blocking
      logger.warn('Idempotency store lookup failed, proceeding without cache', {
        context: 'SafetyGuardIdempotency',
        error: err instanceof Error ? err.message : String(err)
      });
      next();
    });
  };
}

/**
 * Middleware to enforce rate limits
 *
 * Usage:
 * ```
 * router.post('/safety/confirm', requireRateLimit(), handler)
 * ```
 */
export function requireRateLimit() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!rateLimitConfig.enabled) {
      next();
      return;
    }

    const user = (req as Request & { user?: { id?: string } }).user;
    const userId = user?.id || req.ip || 'anonymous';
    const now = new Date();

    // Get or create rate limit entry
    let entry = rateLimitStore.get(userId);

    if (!entry || now > entry.resetAt) {
      // Create new window
      entry = {
        count: 0,
        resetAt: new Date(now.getTime() + rateLimitConfig.windowSeconds * 1000)
      };
      rateLimitStore.set(userId, entry);
    }

    // Check if limit exceeded
    if (entry.count >= rateLimitConfig.maxRequests) {
      const retryAfter = Math.ceil(
        (entry.resetAt.getTime() - now.getTime()) / 1000
      );

      logger.warn('Rate limit exceeded', {
        context: 'SafetyGuardIdempotency',
        userId,
        count: entry.count,
        maxRequests: rateLimitConfig.maxRequests,
        retryAfter
      });

      metrics.recordRateLimitExceeded();

      res.set('Retry-After', String(retryAfter));
      res.status(429).json({
        error: 'RateLimitExceeded',
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please try again later.',
        retryAfter,
        resetAt: entry.resetAt.toISOString()
      });
      return;
    }

    // Increment counter
    entry.count++;

    // Add rate limit headers
    res.set('X-RateLimit-Limit', String(rateLimitConfig.maxRequests));
    res.set(
      'X-RateLimit-Remaining',
      String(rateLimitConfig.maxRequests - entry.count)
    );
    res.set('X-RateLimit-Reset', String(Math.ceil(entry.resetAt.getTime() / 1000)));

    next();
  };
}

/**
 * Combined middleware for idempotency + rate limiting
 */
export function protectConfirmationEndpoint() {
  return [requireRateLimit(), requireIdempotency()];
}

/**
 * Get current stats
 */
export async function getIdempotencyStats(): Promise<{
  idempotencyEntries: number;
  rateLimitEntries: number;
  config: {
    idempotency: IdempotencyConfig;
    rateLimit: RateLimitConfig;
  };
}> {
  return {
    idempotencyEntries: await activeStore.size(),
    rateLimitEntries: rateLimitStore.size,
    config: {
      idempotency: idempotencyConfig,
      rateLimit: rateLimitConfig
    }
  };
}

/**
 * Clear all entries (for testing)
 */
export async function clearIdempotencyStore(): Promise<void> {
  await activeStore.clear();
  rateLimitStore.clear();
  logger.info('Idempotency and rate limit stores cleared', {
    context: 'SafetyGuardIdempotency'
  });
}

/**
 * Destroy the service
 */
export async function destroyIdempotency(): Promise<void> {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  await activeStore.clear();
  rateLimitStore.clear();
  activeStore = memoryStore;
  logger.info('Idempotency service destroyed', {
    context: 'SafetyGuardIdempotency'
  });
}

/**
 * Get the currently active idempotency store (exposed for testing).
 */
export function getActiveStore(): IdempotencyStore {
  return activeStore;
}
