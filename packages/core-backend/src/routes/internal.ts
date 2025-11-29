// @ts-nocheck
import { Router, Request, Response } from 'express'
import { cacheRegistry } from '../../core/cache/CacheRegistry'
import fallbackTestRouter from './fallback-test'

/**
 * Internal API routes for debugging and monitoring
 *
 * These endpoints are intended for development and staging environments only.
 * They provide runtime inspection of system state.
 *
 * **Security**: These endpoints should NOT be exposed in production.
 *
 * @example
 * ```typescript
 * // In src/index.ts
 * import internalRouter from './routes/internal'
 * app.use('/internal', internalRouter)
 * ```
 */
const router = Router()

// Simple in-memory rate limiter for internal routes (opt-in)
type Counter = { count: number; resetAt: number }
const rlStore = new Map<string, Counter>()
const RL_WINDOW_MS = parseInt(process.env.INTERNAL_RATE_LIMIT_WINDOW_MS || '60000', 10)
const RL_MAX = parseInt(process.env.INTERNAL_RATE_LIMIT_MAX || '120', 10)

function internalRateLimit(req: Request, res: Response): boolean {
  // Disabled by default if max <= 0
  if (RL_MAX <= 0) return true
  const token = (req.header('x-internal-token') as string) || ''
  const key = token || req.ip || 'anon'
  const now = Date.now()
  const cur = rlStore.get(key)
  if (!cur || now >= cur.resetAt) {
    rlStore.set(key, { count: 1, resetAt: now + RL_WINDOW_MS })
    return true
  }
  if (cur.count >= RL_MAX) {
    const retrySec = Math.max(1, Math.ceil((cur.resetAt - now) / 1000))
    res.setHeader('Retry-After', String(retrySec))
    res.status(429).json({ error: 'Too Many Requests' })
    return false
  }
  cur.count += 1
  return true
}

function requireInternalAuth(req: Request, res: Response): boolean {
  // Hide entirely in production
  if (process.env.NODE_ENV === 'production') {
    res.status(404).json({ error: 'Not available in production' })
    return false
  }
  // Optional header/token guard
  const required = process.env.INTERNAL_API_TOKEN
  if (required) {
    const token = req.header('x-internal-token') || req.query.token
    if (!token || token !== required) {
      res.status(401).json({ error: 'Unauthorized' })
      return false
    }
  }
  return true
}

/**
 * GET /internal/cache - Cache status endpoint
 *
 * Returns current cache implementation and statistics.
 *
 * **Access**: Dev/staging only (returns 404 in production)
 *
 * **Response**:
 * ```json
 * {
 *   "enabled": false,
 *   "implName": "NullCache",
 *   "registeredAt": "2025-11-03T04:00:00.000Z",
 *   "recentStats": {
 *     "hits": 0,
 *     "misses": 0,
 *     "errors": 0,
 *     "hitRate": 0
 *   }
 * }
 * ```
 *
 * @example
 * ```bash
 * curl http://localhost:8900/internal/cache
 * ```
 */
router.get('/cache', (req: Request, res: Response) => {
  if (!requireInternalAuth(req, res)) return
  if (!internalRateLimit(req, res)) return

  const status = cacheRegistry.getStatus()

  res.json({
    enabled: status.enabled,
    implName: status.implName,
    registeredAt: status.stats.registeredAt,
    recentStats: {
      hits: status.stats.hits,
      misses: status.stats.misses,
      errors: status.stats.errors,
      hitRate: status.stats.hits + status.stats.misses > 0
        ? status.stats.hits / (status.stats.hits + status.stats.misses)
        : 0
    }
  })
})

/**
 * GET /internal/config - Non-sensitive runtime config snapshot
 *
 * Returns selected environment flags without secrets.
 * Hidden in production environments.
 */
router.get('/config', (req: Request, res: Response) => {
  if (!requireInternalAuth(req, res)) return
  if (!internalRateLimit(req, res)) return

  const flags = {
    FEATURE_CACHE: process.env.FEATURE_CACHE === 'true',
    ENABLE_FALLBACK_TEST: process.env.ENABLE_FALLBACK_TEST === 'true',
    ALLOW_UNSAFE_ADMIN: process.env.ALLOW_UNSAFE_ADMIN === 'true',
    COUNT_CACHE_MISS_AS_FALLBACK: process.env.COUNT_CACHE_MISS_AS_FALLBACK === 'true',
    METRICS_PATH: '/metrics/prom'
  }
  res.json({ env: flags })
})

// Mount fallback test routes at /internal/test/*
router.use(
  '/test',
  (req, res, next) => { if (!requireInternalAuth(req, res)) return; if (!internalRateLimit(req, res)) return; next() },
  fallbackTestRouter
)

export default router
