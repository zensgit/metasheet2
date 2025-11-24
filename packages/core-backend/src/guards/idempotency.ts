/**
 * Idempotency Key & Rate Limiting for SafetyGuard
 *
 * Prevents duplicate operation executions and provides rate limiting
 * for confirmation endpoints.
 */

import type { Request, Response, NextFunction } from 'express';
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

// In-memory stores (in production, use Redis)
const idempotencyStore = new Map<string, IdempotencyEntry>();
const rateLimitStore = new Map<string, RateLimitEntry>();

let idempotencyConfig = DEFAULT_IDEMPOTENCY_CONFIG;
let rateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG;

// Cleanup interval
let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * Initialize idempotency and rate limiting
 */
export function initIdempotency(
  config: Partial<IdempotencyConfig> = {}
): void {
  idempotencyConfig = { ...DEFAULT_IDEMPOTENCY_CONFIG, ...config };

  // Start cleanup interval
  if (!cleanupInterval) {
    cleanupInterval = setInterval(() => {
      cleanupExpiredEntries();
    }, 60000); // Every minute
  }

  logger.info('Idempotency service initialized', {
    context: 'SafetyGuardIdempotency',
    enabled: idempotencyConfig.enabled,
    ttlSeconds: idempotencyConfig.ttlSeconds
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
  const now = new Date();
  let idempotencyCleaned = 0;
  let rateLimitCleaned = 0;

  // Cleanup idempotency entries
  for (const [key, entry] of idempotencyStore) {
    if (now > entry.expiresAt) {
      idempotencyStore.delete(key);
      idempotencyCleaned++;
    }
  }

  // Cleanup rate limit entries
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
      remainingIdempotency: idempotencyStore.size,
      remainingRateLimit: rateLimitStore.size
    });
  }
}

/**
 * Generate idempotency cache key
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

    // Check if we have a cached response
    const cachedEntry = idempotencyStore.get(cacheKey);

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
      // Store response in cache
      const expiresAt = new Date(
        Date.now() + idempotencyConfig.ttlSeconds * 1000
      );

      idempotencyStore.set(cacheKey, {
        response: {
          statusCode: res.statusCode,
          body
        },
        createdAt: new Date(),
        expiresAt
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
export function getIdempotencyStats(): {
  idempotencyEntries: number;
  rateLimitEntries: number;
  config: {
    idempotency: IdempotencyConfig;
    rateLimit: RateLimitConfig;
  };
} {
  return {
    idempotencyEntries: idempotencyStore.size,
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
export function clearIdempotencyStore(): void {
  idempotencyStore.clear();
  rateLimitStore.clear();
  logger.info('Idempotency and rate limit stores cleared', {
    context: 'SafetyGuardIdempotency'
  });
}

/**
 * Destroy the service
 */
export function destroyIdempotency(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  idempotencyStore.clear();
  rateLimitStore.clear();
  logger.info('Idempotency service destroyed', {
    context: 'SafetyGuardIdempotency'
  });
}
