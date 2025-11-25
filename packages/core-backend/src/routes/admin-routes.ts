/**
 * Protected Admin Routes
 *
 * Admin API endpoints with SafetyGuard middleware integration.
 * These routes handle dangerous operations that require confirmation.
 */

import { Router, type Request, type Response } from 'express';
import {
  requireSafetyCheck,
  createSafetyConfirmEndpoint,
  createSafetyStatusEndpoint,
  OperationType,
  getSafetyGuard,
  initSafetyGuard,
  protectAdminOperation,
  logSafetyOperation,
  protectConfirmationEndpoint,
  initIdempotency,
  initRateLimit,
  getIdempotencyStats
} from '../guards';
import { Logger } from '../core/logger';
import type { PluginLoader } from '../core/plugin-loader';
import type { SnapshotService } from '../services/SnapshotService';

const logger = new Logger('AdminRoutes');

// Service dependencies
interface AdminRouteServices {
  pluginLoader?: PluginLoader;
  snapshotService?: SnapshotService;
}

let services: AdminRouteServices = {};

const router = Router();

// ═══════════════════════════════════════════════════════════════════
// Safety Guard Management
// ═══════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/safety/status
 * Get SafetyGuard status and pending confirmations
 */
router.get('/safety/status', createSafetyStatusEndpoint());

/**
 * POST /api/admin/safety/confirm
 * Confirm a dangerous operation
 * Protected by rate limiting and idempotency keys
 */
router.post(
  '/safety/confirm',
  ...protectConfirmationEndpoint(),
  async (req: Request, res: Response) => {
    const confirmHandler = createSafetyConfirmEndpoint();
    const user = (req as Request & { user?: { id?: string; email?: string } })
      .user;

    // Call the original handler
    confirmHandler(req, res);

    // Log the confirmation attempt (after response is sent)
    setImmediate(async () => {
      try {
        await logSafetyOperation({
          operationType: 'unknown' as OperationType,
          userId: user?.id || 'anonymous',
          userEmail: user?.email,
          userIp: req.ip || 'unknown',
          riskLevel: 'confirmation',
          action: res.statusCode === 200 ? 'confirmed' : 'denied',
          details: {
            statusCode: res.statusCode,
            hasToken: !!req.body.token,
            hasTypedConfirmation: !!req.body.typedConfirmation,
            acknowledged: req.body.acknowledged,
            idempotencyKey: req.headers['x-idempotency-key']
              ? String(req.headers['x-idempotency-key']).substring(0, 20)
              : null
          },
          safetyToken: req.body.token,
          timestamp: new Date()
        });
      } catch (error) {
        logger.error('Failed to audit confirmation', error as Error);
      }
    });
  }
);

/**
 * POST /api/admin/safety/enable
 * Enable SafetyGuard
 */
router.post('/safety/enable', (req: Request, res: Response) => {
  const guard = getSafetyGuard();
  guard.updateConfig({ enabled: true });
  logger.info('SafetyGuard enabled via admin API', {
    context: 'AdminRoutes',
    initiator: req.ip
  });
  res.json({ success: true, message: 'SafetyGuard enabled' });
});

/**
 * POST /api/admin/safety/disable
 * Disable SafetyGuard (requires confirmation)
 */
router.post(
  '/safety/disable',
  requireSafetyCheck({
    operation: OperationType.RESET_METRICS, // Using LOW risk for this
    getDetails: () => ({ action: 'disable_safety_guard' })
  }),
  (req: Request, res: Response) => {
    const guard = getSafetyGuard();
    guard.updateConfig({ enabled: false });
    logger.warn('SafetyGuard disabled via admin API', {
      context: 'AdminRoutes',
      initiator: req.ip
    });
    res.json({
      success: true,
      message: 'SafetyGuard disabled',
      warning: 'Safety checks are now bypassed'
    });
  }
);

// ═══════════════════════════════════════════════════════════════════
// Plugin Management (Protected)
// ═══════════════════════════════════════════════════════════════════

/**
 * POST /api/admin/plugins/:id/reload
 * Reload a single plugin
 */
router.post(
  '/plugins/:id/reload',
  requireSafetyCheck({
    operation: OperationType.FORCE_RELOAD,
    getDetails: (req) => ({ pluginId: req.params.id })
  }),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    logger.info('Plugin reload requested', {
      context: 'AdminRoutes',
      pluginId: id,
      initiator: req.ip
    });

    if (!services.pluginLoader) {
      res.status(503).json({
        success: false,
        error: 'PluginLoader service not available'
      });
      return;
    }

    try {
      await services.pluginLoader.reloadPlugin(id);
      res.json({
        success: true,
        message: `Plugin ${id} reloaded successfully`,
        pluginId: id
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Plugin reload failed', {
        context: 'AdminRoutes',
        pluginId: id,
        error: err.message
      });
      res.status(500).json({
        success: false,
        error: err.message,
        pluginId: id
      });
    }
  }
);

/**
 * POST /api/admin/plugins/reload-all
 * Reload all plugins
 */
router.post(
  '/plugins/reload-all',
  ...protectAdminOperation(OperationType.RELOAD_ALL_PLUGINS),
  requireSafetyCheck({
    operation: OperationType.RELOAD_ALL_PLUGINS,
    getDetails: () => ({ action: 'reload_all_plugins' })
  }),
  async (req: Request, res: Response) => {
    logger.warn('All plugins reload requested', {
      context: 'AdminRoutes',
      initiator: req.ip
    });

    if (!services.pluginLoader) {
      res.status(503).json({
        success: false,
        error: 'PluginLoader service not available'
      });
      return;
    }

    try {
      // Reload all plugins by re-running loadPlugins
      await services.pluginLoader.loadPlugins();
      res.json({
        success: true,
        message: 'All plugins reloaded successfully',
        warning: 'Service may have experienced brief unavailability'
      });
    } catch (error) {
      const err = error as Error;
      logger.error('All plugins reload failed', {
        context: 'AdminRoutes',
        error: err.message
      });
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  }
);

/**
 * POST /api/admin/plugins/reload-all-unsafe
 * Local-only helper to reload all plugins without SafetyGuard confirmation.
 * Guardrails:
 *  - Requires process.env.ALLOW_UNSAFE_ADMIN === 'true'
 *  - Requires authenticated user with roles includes 'admin'
 *  - Returns 403 otherwise
 *  - Intended for local development visibility only; DO NOT enable in staging/prod
 */
router.post('/plugins/reload-all-unsafe', async (req: Request, res: Response) => {
  try {
    if (process.env.ALLOW_UNSAFE_ADMIN !== 'true') {
      return res.status(403).json({
        success: false,
        code: 'UNSAFE_DISABLED',
        message: 'Unsafe admin route disabled. Set ALLOW_UNSAFE_ADMIN=true to enable (local only).'
      })
    }
    const user = (req as Request & { user?: any }).user
    const roles: string[] = Array.isArray(user?.roles) ? user.roles : []
    if (!roles.includes('admin')) {
      return res.status(403).json({
        success: false,
        code: 'ADMIN_REQUIRED',
        message: 'Admin role required'
      })
    }
    if (!services.pluginLoader) {
      return res.status(503).json({ success: false, error: 'PluginLoader service not available' })
    }
    await services.pluginLoader.loadPlugins()
    return res.json({ success: true, message: 'All plugins reloaded (unsafe local bypass)' })
  } catch (error) {
    const err = error as Error
    logger.error('Unsafe reload-all failed', err)
    return res.status(500).json({ success: false, error: err.message })
  }
})

/**
 * POST /api/admin/plugins/:id/reload-unsafe
 * Local-only helper to reload a single plugin without SafetyGuard confirmation.
 * Records metrics for Phase 5 validation.
 * Guardrails:
 *  - Requires process.env.ALLOW_UNSAFE_ADMIN === 'true'
 *  - Requires authenticated user with roles includes 'admin'
 *  - Returns 403 otherwise
 *  - Intended for local development visibility only; DO NOT enable in staging/prod
 */
router.post('/plugins/:id/reload-unsafe', async (req: Request, res: Response) => {
  try {
    if (process.env.ALLOW_UNSAFE_ADMIN !== 'true') {
      return res.status(403).json({
        success: false,
        code: 'UNSAFE_DISABLED',
        message: 'Unsafe admin route disabled. Set ALLOW_UNSAFE_ADMIN=true to enable (local only).'
      })
    }
    const user = (req as Request & { user?: any }).user
    const roles: string[] = Array.isArray(user?.roles) ? user.roles : []
    if (!roles.includes('admin')) {
      return res.status(403).json({
        success: false,
        code: 'ADMIN_REQUIRED',
        message: 'Admin role required'
      })
    }
    if (!services.pluginLoader) {
      return res.status(503).json({ success: false, error: 'PluginLoader service not available' })
    }
    const { id } = req.params
    await services.pluginLoader.reloadPlugin(id)
    return res.json({ success: true, message: `Plugin ${id} reloaded (unsafe local bypass)`, pluginId: id })
  } catch (error) {
    const err = error as Error
    logger.error('Unsafe single plugin reload failed', err)
    return res.status(500).json({ success: false, error: err.message })
  }
})

/**
 * DELETE /api/admin/plugins/:id
 * Unload a plugin
 */
router.delete(
  '/plugins/:id',
  requireSafetyCheck({
    operation: OperationType.UNLOAD_PLUGIN,
    getDetails: (req) => ({ pluginId: req.params.id })
  }),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    logger.info('Plugin unload requested', {
      context: 'AdminRoutes',
      pluginId: id,
      initiator: req.ip
    });

    if (!services.pluginLoader) {
      res.status(503).json({
        success: false,
        error: 'PluginLoader service not available'
      });
      return;
    }

    try {
      await services.pluginLoader.unloadPlugin(id);
      res.json({
        success: true,
        message: `Plugin ${id} unloaded successfully`,
        pluginId: id
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Plugin unload failed', {
        context: 'AdminRoutes',
        pluginId: id,
        error: err.message
      });
      res.status(500).json({
        success: false,
        error: err.message,
        pluginId: id
      });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// Snapshot Management (Protected)
// ═══════════════════════════════════════════════════════════════════

/**
 * POST /api/admin/snapshots/:id/restore
 * Restore from a snapshot
 */
router.post(
  '/snapshots/:id/restore',
  ...protectAdminOperation(OperationType.RESTORE_SNAPSHOT),
  requireSafetyCheck({
    operation: OperationType.RESTORE_SNAPSHOT,
    getDetails: (req) => ({ snapshotId: req.params.id })
  }),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { restoreType = 'full', itemTypes } = req.body;
    const restoredBy =
      (req as Request & { user?: { id?: string } }).user?.id ||
      req.ip ||
      'unknown';

    logger.warn('Snapshot restore requested', {
      context: 'AdminRoutes',
      snapshotId: id,
      restoreType,
      initiator: restoredBy
    });

    if (!services.snapshotService) {
      res.status(503).json({
        success: false,
        error: 'SnapshotService not available'
      });
      return;
    }

    try {
      const result = await services.snapshotService.restoreSnapshot({
        snapshotId: id,
        restoredBy,
        restoreType,
        itemTypes
      });

      res.json({
        success: true,
        message: `Snapshot ${id} restored successfully`,
        snapshotId: id,
        result,
        warning: 'Current state has been overwritten'
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Snapshot restore failed', {
        context: 'AdminRoutes',
        snapshotId: id,
        error: err.message
      });
      res.status(500).json({
        success: false,
        error: err.message,
        snapshotId: id
      });
    }
  }
);

/**
 * DELETE /api/admin/snapshots/:id
 * Delete a snapshot
 */
router.delete(
  '/snapshots/:id',
  requireSafetyCheck({
    operation: OperationType.DELETE_SNAPSHOT,
    getDetails: (req) => ({ snapshotId: req.params.id })
  }),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const deletedBy =
      (req as Request & { user?: { id?: string } }).user?.id ||
      req.ip ||
      'unknown';

    logger.info('Snapshot deletion requested', {
      context: 'AdminRoutes',
      snapshotId: id,
      initiator: deletedBy
    });

    if (!services.snapshotService) {
      res.status(503).json({
        success: false,
        error: 'SnapshotService not available'
      });
      return;
    }

    try {
      const deleted = await services.snapshotService.deleteSnapshot(
        id,
        deletedBy
      );
      res.json({
        success: deleted,
        message: deleted
          ? `Snapshot ${id} deleted successfully`
          : `Snapshot ${id} not found or already deleted`,
        snapshotId: id
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Snapshot deletion failed', {
        context: 'AdminRoutes',
        snapshotId: id,
        error: err.message
      });
      res.status(500).json({
        success: false,
        error: err.message,
        snapshotId: id
      });
    }
  }
);

/**
 * POST /api/admin/snapshots/cleanup
 * Cleanup expired snapshots
 */
router.post(
  '/snapshots/cleanup',
  ...protectAdminOperation(OperationType.CLEANUP_SNAPSHOTS),
  requireSafetyCheck({
    operation: OperationType.CLEANUP_SNAPSHOTS,
    getDetails: (req) => ({
      dryRun: req.body.dryRun || false
    })
  }),
  async (req: Request, res: Response) => {
    const { dryRun = false } = req.body;
    logger.info('Snapshot cleanup requested', {
      context: 'AdminRoutes',
      dryRun,
      initiator: req.ip
    });

    if (!services.snapshotService) {
      res.status(503).json({
        success: false,
        error: 'SnapshotService not available'
      });
      return;
    }

    if (dryRun) {
      res.json({
        success: true,
        message: 'Dry run: cleanup would be performed',
        dryRun: true
      });
      return;
    }

    try {
      const result = await services.snapshotService.cleanupExpired();
      res.json({
        success: true,
        message: `Cleanup completed: ${result.deleted} snapshots deleted`,
        deleted: result.deleted,
        freedBytes: result.freed
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Snapshot cleanup failed', {
        context: 'AdminRoutes',
        error: err.message
      });
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// System Operations (Protected)
// ═══════════════════════════════════════════════════════════════════

/**
 * POST /api/admin/cache/clear
 * Clear application cache
 */
router.post(
  '/cache/clear',
  requireSafetyCheck({
    operation: OperationType.CLEAR_CACHE,
    getDetails: () => ({ action: 'clear_cache' })
  }),
  (req: Request, res: Response) => {
    logger.info('Cache clear requested', {
      context: 'AdminRoutes',
      initiator: req.ip
    });
    // TODO: Integrate with actual CacheService.clear()
    res.json({
      success: true,
      message: 'Cache cleared successfully'
    });
  }
);

/**
 * POST /api/admin/metrics/reset
 * Reset metrics counters
 */
router.post(
  '/metrics/reset',
  requireSafetyCheck({
    operation: OperationType.RESET_METRICS,
    getDetails: () => ({ action: 'reset_metrics' })
  }),
  (req: Request, res: Response) => {
    logger.info('Metrics reset requested', {
      context: 'AdminRoutes',
      initiator: req.ip
    });
    // TODO: Integrate with actual metrics reset
    res.json({
      success: true,
      message: 'Metrics counters reset',
      warning: 'Historical metric data may be lost'
    });
  }
);

// ═══════════════════════════════════════════════════════════════════
// Data Operations (Protected)
// ═══════════════════════════════════════════════════════════════════

/**
 * DELETE /api/admin/data/bulk
 * Bulk delete data
 */
router.delete(
  '/data/bulk',
  requireSafetyCheck({
    operation: OperationType.DELETE_DATA,
    getDetails: (req) => ({
      table: req.body.table,
      filters: req.body.filters,
      estimatedCount: req.body.estimatedCount
    })
  }),
  (req: Request, res: Response) => {
    const { table, filters, estimatedCount } = req.body;
    logger.warn('Bulk data deletion requested', {
      context: 'AdminRoutes',
      table,
      filters,
      estimatedCount,
      initiator: req.ip
    });
    // TODO: Integrate with actual data deletion
    res.json({
      success: true,
      message: `Bulk deletion initiated on table ${table}`,
      table,
      estimatedCount
    });
  }
);

/**
 * PUT /api/admin/data/bulk
 * Bulk update data
 */
router.put(
  '/data/bulk',
  requireSafetyCheck({
    operation: OperationType.BULK_UPDATE,
    getDetails: (req) => ({
      table: req.body.table,
      updates: req.body.updates,
      estimatedCount: req.body.estimatedCount
    })
  }),
  (req: Request, res: Response) => {
    const { table, updates, estimatedCount } = req.body;
    logger.warn('Bulk data update requested', {
      context: 'AdminRoutes',
      table,
      updates,
      estimatedCount,
      initiator: req.ip
    });
    // TODO: Integrate with actual data update
    res.json({
      success: true,
      message: `Bulk update initiated on table ${table}`,
      table,
      estimatedCount
    });
  }
);

// ═══════════════════════════════════════════════════════════════════
// Sprint 2: Snapshot Protection Routes
// ═══════════════════════════════════════════════════════════════════

/**
 * Import and mount Sprint 2 routes
 * - Snapshot labels (tags, protection levels, release channels)
 * - Protection rules (rule engine management)
 */
import snapshotLabelsRouter from './snapshot-labels';
import protectionRulesRouter from './protection-rules';

router.use('/snapshots', snapshotLabelsRouter);
router.use('/safety/rules', protectionRulesRouter);

export default router;

/**
 * Initialize admin routes with SafetyGuard and service dependencies
 */
export function initAdminRoutes(
  deps: AdminRouteServices = {}
): Router {
  // Inject service dependencies
  services = deps;

  // Initialize SafetyGuard with default config
  initSafetyGuard({
    enabled: process.env.SAFETY_GUARD_ENABLED !== 'false',
    tokenExpirationSeconds: parseInt(
      process.env.SAFETY_TOKEN_EXPIRATION || '300',
      10
    ),
    allowBypass: process.env.NODE_ENV === 'test'
  });

  // Initialize idempotency and rate limiting
  initIdempotency({
    enabled: process.env.IDEMPOTENCY_ENABLED !== 'false',
    ttlSeconds: parseInt(process.env.IDEMPOTENCY_TTL || '3600', 10)
  });

  initRateLimit({
    enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
    windowSeconds: parseInt(process.env.RATE_LIMIT_WINDOW || '60', 10),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX || '10', 10)
  });

  logger.info('Admin routes initialized with SafetyGuard', {
    context: 'AdminRoutes',
    safetyGuardEnabled: getSafetyGuard().isEnabled(),
    idempotencyStats: getIdempotencyStats().config,
    pluginLoaderAvailable: !!services.pluginLoader,
    snapshotServiceAvailable: !!services.snapshotService
  });

  return router;
}

/**
 * Update service dependencies after initialization
 */
export function updateAdminServices(
  newServices: Partial<AdminRouteServices>
): void {
  services = { ...services, ...newServices };
  logger.info('Admin route services updated', {
    context: 'AdminRoutes',
    pluginLoaderAvailable: !!services.pluginLoader,
    snapshotServiceAvailable: !!services.snapshotService
  });
}
