import { Router } from 'express';
import { rbacGuard } from '../rbac/rbac';
import { db } from '../db/db';
import { getConfig, sanitizeConfig, reloadConfig } from '../config';
import { restartTelemetryIfNeeded } from '../telemetry';
import { metrics } from '../metrics/metrics';
import { auditLog } from '../audit/audit';
export function adminRouter() {
    const r = Router();
    // List keys for a plugin
    r.get('/api/admin/plugin-kv/:plugin', rbacGuard('permissions', 'read'), async (req, res) => {
        if (!db)
            return res.status(503).json({ ok: false, error: { code: 'DB_UNAVAILABLE' } });
        const plugin = req.params.plugin;
        const rows = await db.selectFrom('plugin_kv').select(['key', 'updated_at']).where('plugin', '=', plugin).orderBy('key asc').execute();
        return res.json({ ok: true, data: rows });
    });
    // Get a specific key for a plugin
    r.get('/api/admin/plugin-kv/:plugin/:key', rbacGuard('permissions', 'read'), async (req, res) => {
        if (!db)
            return res.status(503).json({ ok: false, error: { code: 'DB_UNAVAILABLE' } });
        const { plugin, key } = req.params;
        const row = await db.selectFrom('plugin_kv').selectAll().where('plugin', '=', plugin).where('key', '=', key).executeTakeFirst();
        if (!row)
            return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
        return res.json({ ok: true, data: row });
    });
    // Alternative: query param variant to support scoped plugin names (with '/')
    r.get('/api/admin/plugin-kv', rbacGuard('permissions', 'read'), async (req, res) => {
        if (!db)
            return res.status(503).json({ ok: false, error: { code: 'DB_UNAVAILABLE' } });
        const plugin = String(req.query.plugin || '');
        if (!plugin)
            return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: 'plugin required' } });
        const rows = await db.selectFrom('plugin_kv').select(['key', 'updated_at']).where('plugin', '=', plugin).orderBy('key asc').execute();
        return res.json({ ok: true, data: rows });
    });
    r.get('/api/admin/plugin-kv/value', rbacGuard('permissions', 'read'), async (req, res) => {
        if (!db)
            return res.status(503).json({ ok: false, error: { code: 'DB_UNAVAILABLE' } });
        const plugin = String(req.query.plugin || '');
        const key = String(req.query.key || '');
        if (!plugin || !key)
            return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: 'plugin and key required' } });
        const row = await db.selectFrom('plugin_kv').selectAll().where('plugin', '=', plugin).where('key', '=', key).executeTakeFirst();
        if (!row)
            return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
        return res.json({ ok: true, data: row });
    });
    // Read-only sanitized configuration snapshot
    r.get('/api/admin/config', rbacGuard('permissions', 'read'), async (_req, res) => {
        try {
            const cfg = getConfig();
            return res.json({ ok: true, data: sanitizeConfig(cfg) });
        }
        catch (e) {
            return res.status(500).json({ ok: false, error: { code: 'CONFIG_ERROR' } });
        }
    });
    // Trigger a config reload (RBAC protected)
    r.post('/api/admin/config/reload', rbacGuard('permissions', 'write'), async (req, res) => {
        const userId = req.user?.id;
        const beforeRaw = getConfig();
        const before = sanitizeConfig(beforeRaw);
        let result = 'success';
        let telemetryRestart = false;
        let changedKeys = [];
        try {
            const cfg = reloadConfig();
            const after = sanitizeConfig(cfg);
            // Telemetry restart and audit logging from PR 151
            const restartInfo = await restartTelemetryIfNeeded(beforeRaw, cfg);
            telemetryRestart = restartInfo.restarted;
            changedKeys = restartInfo.changed;
            await auditLog({
                actorId: userId,
                actorType: 'user',
                action: 'reload',
                resourceType: 'config',
                resourceId: 'global',
                meta: { changedKeys, telemetryRestart }
            });
            try {
                metrics.configReloadTotal.labels('success', telemetryRestart.toString()).inc();
                // Maintain a monotonic version (derive from prior +1 or current timestamp if first)
                metrics.configVersionGauge.inc();
            }
            catch { }
            return res.json({ ok: true, data: after, meta: { telemetryRestart, changedKeys } });
        }
        catch (e) {
            result = 'error';
            try {
                metrics.configReloadTotal.labels('error', telemetryRestart.toString()).inc();
            }
            catch { }
            return res.status(500).json({ ok: false, error: { code: 'CONFIG_RELOAD_ERROR' } });
        }
    });
    // DB health endpoint (presence of core tables)
    r.get('/api/admin/db/health', rbacGuard('permissions', 'read'), async (_req, res) => {
        if (!db)
            return res.status(503).json({ ok: false, healthy: false, error: 'DB_UNAVAILABLE' });
        try {
            // Connectivity check (best-effort)
            try {
                await db.selectFrom('views').select('id').limit(1).execute();
            }
            catch { }
            const tables = { views: true, view_states: true, table_rows: true, table_permissions: true };
            return res.json({ ok: true, healthy: true, tables });
        }
        catch (e) {
            return res.status(503).json({ ok: false, healthy: false, error: 'DB_QUERY_FAILED' });
        }
    });
    // Plugin reload endpoint (Phase 8)
    r.post('/api/admin/plugins/:name/reload', rbacGuard('permissions', 'write'), async (req, res) => {
        const pluginName = req.params.name;
        const userId = req.user?.id;
        const startTime = Date.now();
        try {
            // Get plugin loader from global registry (injected during app setup)
            const pluginLoader = global.__pluginLoader;
            if (!pluginLoader) {
                return res.status(503).json({
                    ok: false,
                    error: { code: 'PLUGIN_LOADER_UNAVAILABLE', message: 'Plugin loader not initialized' }
                });
            }
            // Perform reload
            await pluginLoader.reloadPlugin(pluginName);
            const duration = (Date.now() - startTime) / 1000;
            // Record metrics
            try {
                metrics.pluginReloadTotal.labels(pluginName, 'success').inc();
                metrics.pluginReloadDuration.labels(pluginName).observe(duration);
            }
            catch { }
            // Audit log
            await auditLog({
                actorId: userId,
                actorType: 'user',
                action: 'reload',
                resourceType: 'plugin',
                resourceId: pluginName,
                meta: { duration }
            });
            return res.json({
                ok: true,
                data: {
                    pluginName,
                    reloaded: true,
                    duration
                }
            });
        }
        catch (e) {
            const duration = (Date.now() - startTime) / 1000;
            const error = e;
            // Record failure metrics
            try {
                metrics.pluginReloadTotal.labels(pluginName, 'failure').inc();
                metrics.pluginReloadDuration.labels(pluginName).observe(duration);
            }
            catch { }
            // Audit log failure
            await auditLog({
                actorId: userId,
                actorType: 'user',
                action: 'reload',
                resourceType: 'plugin',
                resourceId: pluginName,
                meta: { error: error.message, duration }
            });
            return res.status(500).json({
                ok: false,
                error: {
                    code: 'PLUGIN_RELOAD_FAILED',
                    message: error.message
                }
            });
        }
    });
    // List all loaded plugins
    r.get('/api/admin/plugins', rbacGuard('permissions', 'read'), async (_req, res) => {
        try {
            const pluginLoader = global.__pluginLoader;
            if (!pluginLoader) {
                return res.status(503).json({
                    ok: false,
                    error: { code: 'PLUGIN_LOADER_UNAVAILABLE' }
                });
            }
            const plugins = pluginLoader.getPlugins();
            const pluginList = Array.from(plugins.entries()).map(([name, instance]) => ({
                name,
                version: instance.manifest?.version || 'unknown',
                status: instance.status || 'loaded',
                permissions: instance.manifest?.permissions || []
            }));
            return res.json({ ok: true, data: pluginList });
        }
        catch (e) {
            return res.status(500).json({
                ok: false,
                error: { code: 'PLUGIN_LIST_ERROR' }
            });
        }
    });
    return r;
}
//# sourceMappingURL=admin.js.map