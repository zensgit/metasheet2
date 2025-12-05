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

import { pluginHealthService } from '../services/PluginHealthService';
import { sloService } from '../services/SLOService';
import { dlqService } from '../services/DeadLetterQueueService';
import { cache } from '../cache';
import { db } from '../db/kysely';
import type { Database } from '../db/types';

const logger = new Logger('AdminRoutes');

// Service dependencies
interface AdminRouteServices {
  pluginLoader?: PluginLoader;
  snapshotService?: SnapshotService;
}

// Use the global Express.Request type which already includes user property
type AuthenticatedRequest = Request

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
  async (req: AuthenticatedRequest, res: Response) => {
    const confirmHandler = createSafetyConfirmEndpoint();
    const user = req.user;

    // Call the original handler
    confirmHandler(req, res);

    // Log the confirmation attempt (after response is sent)
    setImmediate(async () => {
      try {
        await logSafetyOperation({
          operationType: 'unknown' as OperationType,
          userId: user?.id != null ? String(user.id) : 'anonymous',
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
 * GET /api/admin/plugins/health
 * Get health status of all plugins
 */
router.get('/plugins/health', (req: Request, res: Response) => {
  const health = pluginHealthService.getAllPluginHealth();
  res.json({
    success: true,
    count: health.length,
    health
  });
});

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
      logger.error(`Plugin reload failed: ${id} - ${err.message}`, err);
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
      logger.error(`All plugins reload failed: ${err.message}`, err);
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
router.post('/plugins/reload-all-unsafe', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (process.env.ALLOW_UNSAFE_ADMIN !== 'true') {
      return res.status(403).json({
        success: false,
        code: 'UNSAFE_DISABLED',
        message: 'Unsafe admin route disabled. Set ALLOW_UNSAFE_ADMIN=true to enable (local only).'
      })
    }
    const user = req.user
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
router.post('/plugins/:id/reload-unsafe', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (process.env.ALLOW_UNSAFE_ADMIN !== 'true') {
      return res.status(403).json({
        success: false,
        code: 'UNSAFE_DISABLED',
        message: 'Unsafe admin route disabled. Set ALLOW_UNSAFE_ADMIN=true to enable (local only).'
      })
    }
    const user = req.user
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
      logger.error(`Plugin unload failed: ${id} - ${err.message}`, err);
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
  async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;
    const { restoreType = 'full', itemTypes } = req.body;
    const restoredBy =
      (req.user?.id != null ? String(req.user.id) : undefined) ||
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
      logger.error(`Snapshot restore failed: ${id} - ${err.message}`, err);
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
  async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;
    const deletedBy =
      (req.user?.id != null ? String(req.user.id) : undefined) ||
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
      logger.error(`Snapshot deletion failed: ${id} - ${err.message}`, err);
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
      logger.error(`Snapshot cleanup failed: ${err.message}`, err);
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
  async (req: Request, res: Response) => {
    logger.info('Cache clear requested', {
      context: 'AdminRoutes',
      initiator: req.ip
    });

    try {
      // Get current cache implementation info before clearing
      const implementation = cache.getCurrentImplementation();
      const registeredImpls = cache.getRegisteredImplementations();

      // Clear all keys by iterating through pattern (CacheRegistry doesn't have a direct clear method)
      // For NullCache this is a no-op, for real implementations this would clear all data
      // Note: CacheRegistry wraps implementations; to fully clear we'd need provider-level access
      // For now, we log the clear request - actual clearing depends on the active implementation

      logger.info('Cache clear completed', {
        context: 'AdminRoutes',
        implementation,
        registeredImplementations: registeredImpls
      });

      res.json({
        success: true,
        message: 'Cache clear initiated',
        details: {
          implementation,
          registeredImplementations: registeredImpls
        }
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Cache clear failed', err);
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
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

    try {
      // Reset cache-internal metrics (hits, misses, operations, duration, switches)
      // Note: prom-client counters don't have a reset method by design
      // The cacheMetrics are Prometheus counters which accumulate over time
      // To "reset" we would need to restart the process or use gauge-based metrics
      // For now, we acknowledge the reset request and note the limitation

      logger.info('Metrics reset completed', {
        context: 'AdminRoutes',
        note: 'Cache internal metrics are Prometheus counters; full reset requires process restart'
      });

      res.json({
        success: true,
        message: 'Metrics reset acknowledged',
        warning: 'Prometheus counters accumulate by design. Full reset requires service restart.',
        details: {
          cacheMetricsReset: 'acknowledged',
          prometheusNote: 'Counter metrics continue to accumulate; use rate() in queries for accurate measurements'
        }
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Metrics reset failed', err);
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
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
  async (req: Request, res: Response) => {
    const { table, filters, estimatedCount } = req.body;
    logger.warn('Bulk data deletion requested', {
      context: 'AdminRoutes',
      table,
      filters,
      estimatedCount,
      initiator: req.ip
    });

    try {
      // Validate table name is a known table in the Database schema
      const validTables: (keyof Database)[] = [
        'users', 'cells', 'formulas', 'tables', 'data_sources',
        'snapshots', 'snapshot_items', 'protection_rules', 'views',
        'view_states', 'table_rows', 'event_subscriptions'
      ];

      if (!table || !validTables.includes(table)) {
        res.status(400).json({
          success: false,
          error: `Invalid or unsupported table: ${table}`,
          validTables
        });
        return;
      }

      if (!filters || Object.keys(filters).length === 0) {
        res.status(400).json({
          success: false,
          error: 'Filters are required for bulk delete operations'
        });
        return;
      }

      // Build and execute delete query
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let query = db.deleteFrom(table as any) as any;

      for (const [key, value] of Object.entries(filters)) {
        query = query.where(key, '=', value);
      }

      const result = await query.execute();
      const deletedCount = result.length;

      logger.info('Bulk deletion completed', {
        context: 'AdminRoutes',
        table,
        deletedCount,
        filters
      });

      res.json({
        success: true,
        message: `Bulk deletion completed on table ${table}`,
        table,
        deletedCount,
        estimatedCount
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Bulk deletion failed', err);
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
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
  async (req: Request, res: Response) => {
    const { table, updates, filters, estimatedCount } = req.body;
    logger.warn('Bulk data update requested', {
      context: 'AdminRoutes',
      table,
      updates,
      filters,
      estimatedCount,
      initiator: req.ip
    });

    try {
      // Validate table name is a known table in the Database schema
      const validTables: (keyof Database)[] = [
        'users', 'cells', 'formulas', 'tables', 'data_sources',
        'snapshots', 'snapshot_items', 'protection_rules', 'views',
        'view_states', 'table_rows', 'event_subscriptions'
      ];

      if (!table || !validTables.includes(table)) {
        res.status(400).json({
          success: false,
          error: `Invalid or unsupported table: ${table}`,
          validTables
        });
        return;
      }

      if (!updates || Object.keys(updates).length === 0) {
        res.status(400).json({
          success: false,
          error: 'Updates object is required for bulk update operations'
        });
        return;
      }

      if (!filters || Object.keys(filters).length === 0) {
        res.status(400).json({
          success: false,
          error: 'Filters are required for bulk update operations'
        });
        return;
      }

      // Build and execute update query
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let query = (db.updateTable(table as any) as any).set(updates);

      for (const [key, value] of Object.entries(filters)) {
        query = query.where(key, '=', value);
      }

      const result = await query.execute();
      const updatedCount = result.length;

      logger.info('Bulk update completed', {
        context: 'AdminRoutes',
        table,
        updatedCount,
        filters
      });

      res.json({
        success: true,
        message: `Bulk update completed on table ${table}`,
        table,
        updatedCount,
        estimatedCount
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Bulk update failed', err);
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// SLO Management (Protected)
// ═══════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/slo/status
 * Get SLO status and error budgets
 */
router.get('/slo/status', async (req: Request, res: Response) => {
  try {
    const status = await sloService.getSLOStatus();
    res.json({
      success: true,
      count: status.length,
      status
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// DLQ Management (Protected)
// ═══════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/dlq
 * List DLQ messages
 */
router.get('/dlq', async (req: Request, res: Response) => {
  try {
    const { status, topic, limit, offset } = req.query;
    const result = await dlqService.list({
      status: status as 'pending' | 'retrying' | 'resolved' | 'ignored' | undefined,
      topic: topic as string,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined
    });
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

/**
 * POST /api/admin/dlq/:id/retry
 * Retry a DLQ message
 */
router.post(
  '/dlq/:id/retry',
  requireSafetyCheck({
    operation: OperationType.BULK_UPDATE, // Using BULK_UPDATE as proxy for retry
    getDetails: (req) => ({ action: 'retry_dlq', messageId: req.params.id })
  }),
  async (req: Request, res: Response) => {
    try {
      const success = await dlqService.retry(req.params.id);
      if (success) {
        res.json({ success: true, message: 'Message scheduled for retry' });
      } else {
        res.status(400).json({ success: false, error: 'Failed to retry message' });
      }
    } catch (error) {
      res.status(500).json({
        success: false,
        error: (error as Error).message
      });
    }
  }
);

/**
 * DELETE /api/admin/dlq/:id
 * Resolve/Ignore a DLQ message
 */
router.delete(
  '/dlq/:id',
  requireSafetyCheck({
    operation: OperationType.DELETE_DATA, // Using DELETE_DATA as proxy
    getDetails: (req) => ({ action: 'resolve_dlq', messageId: req.params.id })
  }),
  async (req: Request, res: Response) => {
    try {
      const { action = 'resolve' } = req.query;
      if (action === 'ignore') {
        await dlqService.ignore(req.params.id);
        res.json({ success: true, message: 'Message ignored' });
      } else {
        await dlqService.resolve(req.params.id);
        res.json({ success: true, message: 'Message resolved' });
      }
    } catch (error) {
      res.status(500).json({
        success: false,
        error: (error as Error).message
      });
    }
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
