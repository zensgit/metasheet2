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
  // Only available in non-production
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not available in production' })
  }

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

// Mount fallback test routes at /internal/test/*
router.use('/test', fallbackTestRouter)

export default router
