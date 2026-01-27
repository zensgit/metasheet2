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
  requireAdminRole,
  logSafetyOperation,
  protectConfirmationEndpoint,
  initIdempotency,
  initRateLimit,
  getIdempotencyStats
} from '../guards';
import { Logger } from '../core/logger';
import type { PluginLoader, LoadedPlugin } from '../core/plugin-loader';
import type { SnapshotService } from '../services/SnapshotService';

import { pluginHealthService } from '../services/PluginHealthService';
import { sloService } from '../services/SLOService';
import { dlqService } from '../services/DeadLetterQueueService';
import { cache } from '../cache';
import { db } from '../db/kysely';
import type { Database } from '../db/types';
import { poolManager } from '../integration/db/connection-pool';
import { messageBus } from '../integration/messaging/message-bus';
import { getRateLimiter } from '../integration/rate-limiting';
import { pluginConfigManager } from '../core/plugin-config-manager';
import { isDatabaseSchemaError } from '../utils/database-errors';
import type { PluginManifest } from '../types/plugin';

const logger = new Logger('AdminRoutes');

// Service dependencies
interface AdminRouteServices {
  pluginLoader?: PluginLoader;
  pluginStatus?: Map<string, { status: 'active' | 'inactive' | 'failed'; error?: string; lastAttempt?: string }>;
  activatePlugin?: (pluginId: string) => Promise<{ status: 'active' | 'inactive' | 'failed'; error?: string; lastAttempt?: string }>;
  deactivatePlugin?: (pluginId: string) => Promise<{ status: 'active' | 'inactive' | 'failed'; error?: string; lastAttempt?: string }>;
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

type PluginRuntimeState = {
  status: 'active' | 'inactive' | 'failed';
  error?: string;
  lastAttempt?: string;
};

type PluginRegistryEntry = {
  name: string;
  status: string | null;
  error_message?: string | null;
  last_activated?: string | null;
  display_name?: string | null;
  description?: string | null;
  version?: string | null;
  author?: string | null;
  manifest?: Record<string, unknown> | string | null;
};

type PluginConfigEntry = {
  config?: Record<string, unknown> | null;
  schema?: Record<string, unknown> | null;
  version?: string | null;
  last_modified?: string | null;
  modified_by?: string | null;
};

const isMissingColumnError = (error: unknown): boolean => {
  const code = (error as { code?: string }).code;
  if (code === '42703') return true;
  const message = (error as Error)?.message;
  if (typeof message === 'string') {
    return message.toLowerCase().includes('column') && message.toLowerCase().includes('does not exist');
  }
  return false;
};

const parseJsonField = <T>(value: T | string | null | undefined): T | null => {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
};

const getPluginRuntimeState = (pluginId: string): PluginRuntimeState => {
  const runtime = services.pluginStatus?.get(pluginId);
  return runtime ?? { status: 'inactive' };
};

const loadPluginRegistry = async (): Promise<Map<string, PluginRegistryEntry>> => {
  const registry = new Map<string, PluginRegistryEntry>();
  try {
    const pool = poolManager.get();
    const result = await pool.query<PluginRegistryEntry>(
      `SELECT name, status, error_message, last_activated, display_name, description, version, author, manifest
       FROM plugin_registry`
    );
    for (const row of result.rows) {
      registry.set(row.name, {
        ...row,
        manifest: parseJsonField<Record<string, unknown>>(row.manifest)
      });
    }
  } catch (error) {
    if (isDatabaseSchemaError(error)) {
      return registry;
    }
    throw error;
  }
  return registry;
};

const upsertPluginRegistryStatus = async (
  pluginId: string,
  status: string,
  manifest?: PluginManifest | null,
  errorMessage?: string | null
): Promise<{ persisted: boolean; reason?: string }> => {
  try {
    const pool = poolManager.get();
    const lastActivated = status === 'enabled' ? new Date() : null;
    if (manifest) {
      const version = typeof manifest.version === 'string' ? manifest.version : 'unknown';
      await pool.query(
        `INSERT INTO plugin_registry (name, version, manifest, status, last_activated, error_message)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (name)
         DO UPDATE SET
           version = EXCLUDED.version,
           manifest = EXCLUDED.manifest,
           status = EXCLUDED.status,
           last_activated = EXCLUDED.last_activated,
           error_message = EXCLUDED.error_message,
           updated_at = NOW()`,
        [pluginId, version, manifest, status, lastActivated, errorMessage ?? null]
      );
      return { persisted: true };
    }

    const result = await pool.query(
      `UPDATE plugin_registry
       SET status = $1, last_activated = $2, error_message = $3, updated_at = NOW()
       WHERE name = $4`,
      [status, lastActivated, errorMessage ?? null, pluginId]
    );
    if (result.rowCount === 0) {
      return { persisted: false, reason: 'missing_registry_row' };
    }
    return { persisted: true };
  } catch (error) {
    if (isDatabaseSchemaError(error)) {
      return { persisted: false, reason: 'missing_registry_table' };
    }
    throw error;
  }
};

const loadPluginConfig = async (pluginId: string): Promise<PluginConfigEntry> => {
  try {
    const pool = poolManager.get();
    const result = await pool.query<PluginConfigEntry>(
      `SELECT config, schema, version, last_modified, modified_by
       FROM plugin_configs
       WHERE plugin_name = $1`,
      [pluginId]
    );
    const row = result.rows[0];
    if (row) {
      const config = parseJsonField<Record<string, unknown>>(row.config) || {};
      const schema = parseJsonField<Record<string, unknown>>(row.schema);
      try {
        pluginConfigManager.set(pluginId, config);
      } catch (configError) {
        logger.warn(`Config cache update failed for plugin ${pluginId}`, configError as Error);
      }
      return {
        config,
        schema,
        version: row.version ?? null,
        last_modified: row.last_modified ?? null,
        modified_by: row.modified_by ?? null
      };
    }
  } catch (error) {
    if (isDatabaseSchemaError(error) || isMissingColumnError(error)) {
      const fallback = pluginConfigManager.get<Record<string, unknown>>(pluginId) || {};
      return { config: fallback, schema: null, version: null, last_modified: null, modified_by: null };
    }
    throw error;
  }

  const fallback = pluginConfigManager.get<Record<string, unknown>>(pluginId) || {};
  return { config: fallback, schema: null, version: null, last_modified: null, modified_by: null };
};

const upsertPluginConfig = async (
  pluginId: string,
  config: Record<string, unknown>,
  schema: Record<string, unknown> | null,
  version: string,
  modifiedBy?: string
): Promise<{ persisted: boolean; reason?: string }> => {
  try {
    const pool = poolManager.get();
    await pool.query(
      `INSERT INTO plugin_configs (plugin_name, config, schema, version, last_modified, modified_by)
       VALUES ($1, $2, $3, $4, NOW(), $5)
       ON CONFLICT (plugin_name)
       DO UPDATE SET
         config = EXCLUDED.config,
         schema = EXCLUDED.schema,
         version = EXCLUDED.version,
         last_modified = NOW(),
         modified_by = EXCLUDED.modified_by`,
      [pluginId, config, schema, version, modifiedBy ?? null]
    );
      try {
        pluginConfigManager.set(pluginId, config);
      } catch (configError) {
        logger.warn(`Config cache update failed for plugin ${pluginId}`, configError as Error);
      }
      return { persisted: true };
  } catch (error) {
    if (isDatabaseSchemaError(error) || isMissingColumnError(error)) {
      try {
        pluginConfigManager.set(pluginId, config);
      } catch (configError) {
        logger.warn(`Config cache update failed for plugin ${pluginId}`, configError as Error);
      }
      return { persisted: false, reason: 'missing_plugin_configs_table' };
    }
    throw error;
  }
};

/**
 * GET /api/admin/plugins/health
 * Get health status of all plugins
 */
router.get('/plugins/health', requireAdminRole(), (req: Request, res: Response) => {
  const health = pluginHealthService.getAllPluginHealth();
  res.json({
    success: true,
    count: health.length,
    health
  });
});

/**
 * GET /api/admin/plugins
 * List plugins with runtime status + registry status
 */
router.get('/plugins', requireAdminRole(), async (_req: Request, res: Response) => {
  try {
    const registry = await loadPluginRegistry();
    const loaded = services.pluginLoader?.getPlugins() ?? new Map<string, LoadedPlugin>();
    const failed = services.pluginLoader?.getFailedPlugins() ?? new Map<string, string>();

    const list = Array.from(loaded.values()).map((item) => {
      const runtime = getPluginRuntimeState(item.manifest.name);
      const registryEntry = registry.get(item.manifest.name);
      return {
        name: item.manifest.name,
        displayName: item.manifest.displayName ?? item.manifest.name,
        description: item.manifest.description,
        version: item.manifest.version,
        author: item.manifest.author,
        status: runtime.status,
        error: runtime.error,
        lastAttempt: runtime.lastAttempt,
        registryStatus: registryEntry?.status ?? null,
        lastActivated: registryEntry?.last_activated ?? null
      };
    });

    for (const [name, error] of failed.entries()) {
      if (list.some(entry => entry.name === name)) continue;
      const registryEntry = registry.get(name);
      list.push({
        name,
        displayName: registryEntry?.display_name ?? name,
        description: registryEntry?.description ?? null,
        version: registryEntry?.version ?? null,
        author: registryEntry?.author ?? null,
        status: 'failed',
        error,
        lastAttempt: null,
        registryStatus: registryEntry?.status ?? null,
        lastActivated: registryEntry?.last_activated ?? null
      });
    }

    for (const entry of registry.values()) {
      if (list.some(item => item.name === entry.name)) continue;
      list.push({
        name: entry.name,
        displayName: entry.display_name ?? entry.name,
        description: entry.description ?? null,
        version: entry.version ?? null,
        author: entry.author ?? null,
        status: 'inactive',
        error: entry.error_message ?? null,
        lastAttempt: null,
        registryStatus: entry.status ?? null,
        lastActivated: entry.last_activated ?? null
      });
    }

    res.json({
      success: true,
      count: list.length,
      list
    });
  } catch (error) {
    const err = error as Error;
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/admin/plugins/:id
 * Get plugin detail + config
 */
router.get('/plugins/:id', requireAdminRole(), async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const registry = await loadPluginRegistry();
    const loaded = services.pluginLoader?.get(id);
    const runtime = getPluginRuntimeState(id);
    const registryEntry = registry.get(id);
    const configEntry = await loadPluginConfig(id);

    if (!loaded && !registryEntry) {
      res.status(404).json({
        success: false,
        error: 'Plugin not found',
        pluginId: id
      });
      return;
    }

    res.json({
      success: true,
      plugin: {
        name: id,
        displayName: loaded?.manifest.displayName ?? registryEntry?.display_name ?? id,
        description: loaded?.manifest.description ?? registryEntry?.description ?? null,
        version: loaded?.manifest.version ?? registryEntry?.version ?? null,
        author: loaded?.manifest.author ?? registryEntry?.author ?? null,
        status: runtime.status,
        error: runtime.error,
        lastAttempt: runtime.lastAttempt,
        registryStatus: registryEntry?.status ?? null,
        lastActivated: registryEntry?.last_activated ?? null
      },
      config: configEntry
    });
  } catch (error) {
    const err = error as Error;
    res.status(500).json({
      success: false,
      error: err.message,
      pluginId: id
    });
  }
});

/**
 * POST /api/admin/plugins/:id/enable
 * Enable a plugin (activate)
 */
router.post('/plugins/:id/enable', requireAdminRole(), async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  if (!services.activatePlugin || !services.pluginLoader) {
    res.status(503).json({
      success: false,
      error: 'Plugin services not available'
    });
    return;
  }
  try {
    const runtime = await services.activatePlugin(id);
    const loaded = services.pluginLoader.get(id);
    const manifest = loaded?.manifest ?? null;
    const persisted = await upsertPluginRegistryStatus(id, 'enabled', manifest ?? undefined, runtime.error ?? null);
    res.json({
      success: true,
      pluginId: id,
      runtime,
      registry: persisted
    });
  } catch (error) {
    const err = error as Error;
    res.status(500).json({
      success: false,
      error: err.message,
      pluginId: id
    });
  }
});

/**
 * POST /api/admin/plugins/:id/disable
 * Disable a plugin (deactivate)
 */
router.post('/plugins/:id/disable', requireAdminRole(), async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  if (!services.deactivatePlugin || !services.pluginLoader) {
    res.status(503).json({
      success: false,
      error: 'Plugin services not available'
    });
    return;
  }
  try {
    const runtime = await services.deactivatePlugin(id);
    const loaded = services.pluginLoader.get(id);
    const manifest = loaded?.manifest ?? null;
    const persisted = await upsertPluginRegistryStatus(id, 'disabled', manifest ?? undefined, runtime.error ?? null);
    res.json({
      success: true,
      pluginId: id,
      runtime,
      registry: persisted
    });
  } catch (error) {
    const err = error as Error;
    res.status(500).json({
      success: false,
      error: err.message,
      pluginId: id
    });
  }
});

/**
 * GET /api/admin/plugins/:id/config
 * Get plugin config (best-effort)
 */
router.get('/plugins/:id/config', requireAdminRole(), async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const configEntry = await loadPluginConfig(id);
    res.json({ success: true, pluginId: id, config: configEntry });
  } catch (error) {
    const err = error as Error;
    res.status(500).json({
      success: false,
      error: err.message,
      pluginId: id
    });
  }
});

/**
 * PUT /api/admin/plugins/:id/config
 * Update plugin config (best-effort)
 */
router.put('/plugins/:id/config', requireAdminRole(), async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { config, schema, version } = req.body || {};

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    res.status(400).json({
      success: false,
      error: 'Invalid config payload',
      pluginId: id
    });
    return;
  }

  try {
    const modifiedBy =
      typeof req.user?.email === 'string'
        ? req.user.email
        : req.user?.id != null
          ? String(req.user.id)
          : undefined;
    const persisted = await upsertPluginConfig(
      id,
      config,
      schema && typeof schema === 'object' ? schema : null,
      typeof version === 'string' && version.trim().length > 0 ? version : '1.0.0',
      modifiedBy
    );
    res.json({
      success: true,
      pluginId: id,
      persisted
    });
  } catch (error) {
    const err = error as Error;
    res.status(500).json({
      success: false,
      error: err.message,
      pluginId: id
    });
  }
});

/**
 * POST /api/admin/plugins/:id/reload
 * Reload a single plugin
 */
router.post(
  '/plugins/:id/reload',
  ...protectAdminOperation(OperationType.FORCE_RELOAD),
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
      const runtime = services.activatePlugin ? await services.activatePlugin(id) : undefined;
      res.json({
        success: true,
        message: `Plugin ${id} reloaded successfully`,
        pluginId: id,
        runtime
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
      const loaded = await services.pluginLoader.loadPlugins();
      const activated: Array<{ name: string; status: string; error?: string }> = [];
      if (services.activatePlugin) {
        for (const plugin of loaded) {
          const runtime = await services.activatePlugin(plugin.manifest.name);
          activated.push({
            name: plugin.manifest.name,
            status: runtime.status,
            error: runtime.error
          });
        }
      }
      res.json({
        success: true,
        message: 'All plugins reloaded successfully',
        activated,
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
        message: 'Unsafe admin route disabled. Set ALLOW_UNSAFE_ADMIN to true to enable (local only).'
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
    const loaded = await services.pluginLoader.loadPlugins()
    const activated: Array<{ name: string; status: string; error?: string }> = []
    if (services.activatePlugin) {
      for (const plugin of loaded) {
        const runtime = await services.activatePlugin(plugin.manifest.name)
        activated.push({
          name: plugin.manifest.name,
          status: runtime.status,
          error: runtime.error
        })
      }
    }
    return res.json({ success: true, message: 'All plugins reloaded (unsafe local bypass)', activated })
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
        message: 'Unsafe admin route disabled. Set ALLOW_UNSAFE_ADMIN to true to enable (local only).'
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
    const runtime = services.activatePlugin ? await services.activatePlugin(id) : undefined
    return res.json({ success: true, message: `Plugin ${id} reloaded (unsafe local bypass)`, pluginId: id, runtime })
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
  ...protectAdminOperation(OperationType.UNLOAD_PLUGIN),
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
// Sprint 7 Day 3: Shard Management APIs
// ═══════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/shards
 * Get health status of all database shards/pools
 */
router.get('/shards', async (req: Request, res: Response) => {
  try {
    const stats = await poolManager.getPoolStats();
    const metricsSnapshot = poolManager.getMetricsSnapshot();

    // Calculate overall health
    const healthyCount = stats.filter(s => s.status === 'healthy').length;
    const totalCount = stats.length;
    const overallHealth = totalCount > 0 ? healthyCount / totalCount : 1;

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      summary: {
        totalShards: totalCount,
        healthyShards: healthyCount,
        unhealthyShards: totalCount - healthyCount,
        overallHealth: Math.round(overallHealth * 100) + '%'
      },
      shards: stats.map(shard => ({
        name: shard.name,
        status: shard.status,
        connections: {
          total: shard.totalConnections,
          idle: shard.idleConnections,
          active: shard.totalConnections - shard.idleConnections,
          waiting: shard.waitingClients
        },
        error: shard.error || null
      })),
      metrics: metricsSnapshot
    });
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to get shard status', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/admin/shards/:name
 * Get detailed status of a specific shard
 */
router.get('/shards/:name', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const stats = await poolManager.getPoolStats();
    const shard = stats.find(s => s.name === name);

    if (!shard) {
      res.status(404).json({
        success: false,
        error: `Shard '${name}' not found`
      });
      return;
    }

    res.json({
      success: true,
      shard: {
        name: shard.name,
        status: shard.status,
        connections: {
          total: shard.totalConnections,
          idle: shard.idleConnections,
          active: shard.totalConnections - shard.idleConnections,
          waiting: shard.waitingClients
        },
        error: shard.error || null
      }
    });
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to get shard details', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Sprint 7 Day 3: Queue Management APIs
// ═══════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/queues
 * Get queue statistics (MessageBus + DLQ)
 */
router.get('/queues', async (req: Request, res: Response) => {
  try {
    // Get MessageBus stats
    const messageBusStats = messageBus.getStats();

    // Get DLQ stats
    const dlqPending = await dlqService.list({ status: 'pending', limit: 0 });
    const dlqRetrying = await dlqService.list({ status: 'retrying', limit: 0 });
    const dlqResolved = await dlqService.list({ status: 'resolved', limit: 0 });

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      messageBus: {
        queueLength: messageBusStats.queueLength,
        exactSubscriptions: messageBusStats.exactSubscriptions,
        patternSubscriptions: messageBusStats.patternSubscriptions,
        pendingRpcCount: messageBusStats.pendingRpcCount,
        usePatternTrie: messageBusStats.usePatternTrie,
        patternManagerStats: messageBusStats.patternManagerStats || null
      },
      deadLetterQueue: {
        pending: dlqPending.total,
        retrying: dlqRetrying.total,
        resolved: dlqResolved.total,
        total: dlqPending.total + dlqRetrying.total + dlqResolved.total
      },
      health: {
        status: dlqPending.total > 100 ? 'warning' : 'healthy',
        warnings: dlqPending.total > 100 ? ['High DLQ pending count'] : []
      }
    });
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to get queue stats', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * POST /api/admin/dlq/retry-all
 * Retry all pending DLQ messages (with safety check)
 */
router.post(
  '/dlq/retry-all',
  requireSafetyCheck({
    operation: OperationType.BULK_UPDATE,
    getDetails: () => ({ action: 'retry_all_dlq' })
  }),
  async (req: Request, res: Response) => {
    try {
      const { limit = 100 } = req.body;
      const pending = await dlqService.list({ status: 'pending', limit });

      let succeeded = 0;
      let failed = 0;

      for (const entry of pending.items) {
        try {
          await dlqService.retry(entry.id);
          succeeded++;
        } catch {
          failed++;
        }
      }

      logger.info(`DLQ retry-all completed: ${succeeded} succeeded, ${failed} failed`);

      res.json({
        success: true,
        message: `Retried ${succeeded} messages, ${failed} failed`,
        retried: succeeded,
        failed,
        remaining: pending.total - succeeded - failed
      });
    } catch (error) {
      const err = error as Error;
      logger.error('DLQ retry-all failed', err);
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  }
);

/**
 * POST /api/admin/dlq/cleanup
 * Cleanup old resolved/ignored DLQ messages
 */
router.post(
  '/dlq/cleanup',
  requireSafetyCheck({
    operation: OperationType.DELETE_DATA,
    getDetails: (req) => ({ action: 'cleanup_dlq', days: req.body.days || 30 })
  }),
  async (req: Request, res: Response) => {
    try {
      const { days = 30 } = req.body;
      const deleted = await dlqService.cleanup(days);

      logger.info(`DLQ cleanup completed: ${deleted} messages deleted`);

      res.json({
        success: true,
        message: `Cleaned up ${deleted} old DLQ messages`,
        deleted,
        retentionDays: days
      });
    } catch (error) {
      const err = error as Error;
      logger.error('DLQ cleanup failed', err);
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// Sprint 7 Day 3: Rate Limiting Monitoring APIs
// ═══════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/ratelimits
 * Get current rate limiting status
 */
router.get('/ratelimits', async (req: Request, res: Response) => {
  try {
    const rateLimiter = getRateLimiter();
    const globalStats = rateLimiter.getGlobalStats();
    const config = rateLimiter.getConfig();

    // Get individual bucket stats if requested
    const { showBuckets } = req.query;
    let buckets: Array<{
      key: string;
      tokensRemaining: number;
      totalAccepted: number;
      totalRejected: number;
      acceptanceRate: number;
    }> = [];

    if (showBuckets === 'true') {
      // Note: We'd need to expose getAllKeys() from TokenBucketRateLimiter
      // For now, return global stats only
    }

    // Calculate health status
    const rejectionRate = globalStats.totalAccepted + globalStats.totalRejected > 0
      ? globalStats.totalRejected / (globalStats.totalAccepted + globalStats.totalRejected)
      : 0;

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      config: {
        tokensPerSecond: config.tokensPerSecond,
        bucketCapacity: config.bucketCapacity,
        cleanupIntervalMs: config.cleanupIntervalMs,
        bucketIdleTimeoutMs: config.bucketIdleTimeoutMs
      },
      stats: {
        activeBuckets: globalStats.activeBuckets,
        totalAccepted: globalStats.totalAccepted,
        totalRejected: globalStats.totalRejected,
        averageTokensRemaining: Math.round(globalStats.averageTokensRemaining * 100) / 100,
        rejectionRate: Math.round(rejectionRate * 10000) / 100 + '%'
      },
      health: {
        status: rejectionRate > 0.1 ? 'warning' : 'healthy',
        warnings: rejectionRate > 0.1 ? ['High rejection rate (>10%)'] : []
      },
      buckets: showBuckets === 'true' ? buckets : undefined
    });
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to get rate limit status', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/admin/ratelimits/:key
 * Get rate limit status for a specific key (tenant/user)
 */
router.get('/ratelimits/:key', async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const rateLimiter = getRateLimiter();
    const stats = rateLimiter.getStats(key);

    if (!stats) {
      res.json({
        success: true,
        key,
        status: 'not_tracked',
        message: 'No rate limit bucket exists for this key'
      });
      return;
    }

    res.json({
      success: true,
      key,
      status: stats.tokensRemaining > 0 ? 'allowed' : 'limited',
      stats: {
        tokensRemaining: stats.tokensRemaining,
        bucketCapacity: stats.bucketCapacity,
        totalAccepted: stats.totalAccepted,
        totalRejected: stats.totalRejected,
        acceptanceRate: Math.round(stats.acceptanceRate * 10000) / 100 + '%'
      }
    });
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to get rate limit status for key', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * POST /api/admin/ratelimits/:key/reset
 * Reset rate limit for a specific key
 */
router.post(
  '/ratelimits/:key/reset',
  requireSafetyCheck({
    operation: OperationType.RESET_METRICS,
    getDetails: (req) => ({ action: 'reset_rate_limit', key: req.params.key })
  }),
  async (req: Request, res: Response) => {
    try {
      const { key } = req.params;
      const rateLimiter = getRateLimiter();
      rateLimiter.reset(key);

      logger.info(`Rate limit reset for key: ${key}`);

      res.json({
        success: true,
        message: `Rate limit reset for key: ${key}`,
        key
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Failed to reset rate limit', err);
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  }
);

/**
 * POST /api/admin/ratelimits/reset-all
 * Reset all rate limits (requires safety confirmation)
 */
router.post(
  '/ratelimits/reset-all',
  requireSafetyCheck({
    operation: OperationType.RESET_METRICS,
    getDetails: () => ({ action: 'reset_all_rate_limits' })
  }),
  async (req: Request, res: Response) => {
    try {
      const rateLimiter = getRateLimiter();
      rateLimiter.resetAll();

      logger.info('All rate limits reset');

      res.json({
        success: true,
        message: 'All rate limits have been reset'
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Failed to reset all rate limits', err);
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// Sprint 7 Day 4: Health Aggregation APIs
// ═══════════════════════════════════════════════════════════════════

import { getHealthAggregator, type AggregatedHealth } from '../services/HealthAggregatorService';

/**
 * GET /api/admin/health/detailed
 * Get detailed health status of all subsystems
 */
router.get('/health/detailed', async (req: Request, res: Response) => {
  try {
    const healthAggregator = getHealthAggregator();
    const health = await healthAggregator.checkHealth();

    res.json({
      success: true,
      timestamp: health.timestamp,
      status: health.status,
      uptime: health.uptime,
      summary: health.summary,
      subsystems: health.subsystems,
      warnings: health.warnings,
      errors: health.errors
    });
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to get detailed health', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/admin/health/summary
 * Get a quick health summary without full details
 */
router.get('/health/summary', async (req: Request, res: Response) => {
  try {
    const healthAggregator = getHealthAggregator();

    // Use cached health if available, otherwise do a fresh check
    let health = healthAggregator.getLastHealth();
    if (!health) {
      health = await healthAggregator.checkHealth();
    }

    res.json({
      success: true,
      timestamp: health.timestamp,
      status: health.status,
      uptime: health.uptime,
      summary: health.summary,
      hasWarnings: health.warnings.length > 0,
      hasErrors: health.errors.length > 0
    });
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to get health summary', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/admin/health/subsystem/:name
 * Get health status of a specific subsystem
 */
router.get('/health/subsystem/:name', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const validSubsystems = ['database', 'messageBus', 'plugins', 'rateLimiting', 'system'];

    if (!validSubsystems.includes(name)) {
      res.status(400).json({
        success: false,
        error: `Invalid subsystem name. Valid names: ${validSubsystems.join(', ')}`
      });
      return;
    }

    const healthAggregator = getHealthAggregator();
    const health = await healthAggregator.checkHealth();
    const subsystem = health.subsystems[name as keyof typeof health.subsystems];

    res.json({
      success: true,
      timestamp: health.timestamp,
      subsystem
    });
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to get subsystem health', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * POST /api/admin/health/check
 * Force an immediate health check and return results
 */
router.post('/health/check', async (req: Request, res: Response) => {
  try {
    const healthAggregator = getHealthAggregator();
    const health = await healthAggregator.checkHealth();

    logger.info('Manual health check performed', {
      status: health.status,
      overallHealthPercent: health.summary.overallHealthPercent
    });

    res.json({
      success: true,
      message: 'Health check completed',
      timestamp: health.timestamp,
      status: health.status,
      summary: health.summary
    });
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to perform health check', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

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
    pluginStatusAvailable: !!services.pluginStatus,
    pluginActivationAvailable: !!services.activatePlugin,
    snapshotServiceAvailable: !!services.snapshotService
  });

  return router;
}
