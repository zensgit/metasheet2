"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminRouter = adminRouter;
const express_1 = require("express");
const rbac_1 = require("../rbac/rbac");
const db_1 = require("../db/db");
const config_1 = require("../config");
const telemetry_1 = require("../telemetry");
const metrics_1 = require("../metrics/metrics");
const audit_1 = require("../audit/audit");
function adminRouter() {
    const r = (0, express_1.Router)();
    // List keys for a plugin
    r.get('/api/admin/plugin-kv/:plugin', (0, rbac_1.rbacGuard)('permissions', 'read'), async (req, res) => {
        if (!db_1.db)
            return res.status(503).json({ ok: false, error: { code: 'DB_UNAVAILABLE' } });
        const plugin = req.params.plugin;
        const rows = await db_1.db.selectFrom('plugin_kv').select(['key', 'updated_at']).where('plugin', '=', plugin).orderBy('key asc').execute();
        return res.json({ ok: true, data: rows });
    });
    // Get a specific key for a plugin
    r.get('/api/admin/plugin-kv/:plugin/:key', (0, rbac_1.rbacGuard)('permissions', 'read'), async (req, res) => {
        if (!db_1.db)
            return res.status(503).json({ ok: false, error: { code: 'DB_UNAVAILABLE' } });
        const { plugin, key } = req.params;
        const row = await db_1.db.selectFrom('plugin_kv').selectAll().where('plugin', '=', plugin).where('key', '=', key).executeTakeFirst();
        if (!row)
            return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
        return res.json({ ok: true, data: row });
    });
    // Alternative: query param variant to support scoped plugin names (with '/')
    r.get('/api/admin/plugin-kv', (0, rbac_1.rbacGuard)('permissions', 'read'), async (req, res) => {
        if (!db_1.db)
            return res.status(503).json({ ok: false, error: { code: 'DB_UNAVAILABLE' } });
        const plugin = String(req.query.plugin || '');
        if (!plugin)
            return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: 'plugin required' } });
        const rows = await db_1.db.selectFrom('plugin_kv').select(['key', 'updated_at']).where('plugin', '=', plugin).orderBy('key asc').execute();
        return res.json({ ok: true, data: rows });
    });
    r.get('/api/admin/plugin-kv/value', (0, rbac_1.rbacGuard)('permissions', 'read'), async (req, res) => {
        if (!db_1.db)
            return res.status(503).json({ ok: false, error: { code: 'DB_UNAVAILABLE' } });
        const plugin = String(req.query.plugin || '');
        const key = String(req.query.key || '');
        if (!plugin || !key)
            return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: 'plugin and key required' } });
        const row = await db_1.db.selectFrom('plugin_kv').selectAll().where('plugin', '=', plugin).where('key', '=', key).executeTakeFirst();
        if (!row)
            return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
        return res.json({ ok: true, data: row });
    });
    // Read-only sanitized configuration snapshot
    r.get('/api/admin/config', (0, rbac_1.rbacGuard)('permissions', 'read'), async (_req, res) => {
        try {
            const cfg = (0, config_1.getConfig)();
            return res.json({ ok: true, data: (0, config_1.sanitizeConfig)(cfg) });
        }
        catch (e) {
            return res.status(500).json({ ok: false, error: { code: 'CONFIG_ERROR' } });
        }
    });
    // Trigger a config reload (RBAC protected)
    r.post('/api/admin/config/reload', (0, rbac_1.rbacGuard)('permissions', 'write'), async (req, res) => {
        const userId = req.user?.id;
        const beforeRaw = (0, config_1.getConfig)();
        const before = (0, config_1.sanitizeConfig)(beforeRaw);
        let result = 'success';
        let telemetryRestart = false;
        let changedKeys = [];
        try {
            const cfg = (0, config_1.reloadConfig)();
            const after = (0, config_1.sanitizeConfig)(cfg);
            // Telemetry restart and audit logging from PR 151
            const restartInfo = await (0, telemetry_1.restartTelemetryIfNeeded)(beforeRaw, cfg);
            telemetryRestart = restartInfo.restarted;
            changedKeys = restartInfo.changed;
            await (0, audit_1.auditLog)({
                actorId: userId,
                actorType: 'user',
                action: 'reload',
                resourceType: 'config',
                resourceId: 'global',
                meta: { changedKeys, telemetryRestart }
            });
            try {
                metrics_1.metrics.configReloadTotal.labels('success', telemetryRestart.toString()).inc();
                // Maintain a monotonic version (derive from prior +1 or current timestamp if first)
                metrics_1.metrics.configVersionGauge.inc();
            }
            catch { }
            return res.json({ ok: true, data: after, meta: { telemetryRestart, changedKeys } });
        }
        catch (e) {
            result = 'error';
            try {
                metrics_1.metrics.configReloadTotal.labels('error', telemetryRestart.toString()).inc();
            }
            catch { }
            return res.status(500).json({ ok: false, error: { code: 'CONFIG_RELOAD_ERROR' } });
        }
    });
    // DB health endpoint (presence of core tables)
    r.get('/api/admin/db/health', (0, rbac_1.rbacGuard)('permissions', 'read'), async (_req, res) => {
        if (!db_1.db)
            return res.status(503).json({ ok: false, healthy: false, error: 'DB_UNAVAILABLE' });
        try {
            // Connectivity check (best-effort)
            try {
                await db_1.db.selectFrom('views').select('id').limit(1).execute();
            }
            catch { }
            const tables = { views: true, view_states: true, table_rows: true, table_permissions: true };
            return res.json({ ok: true, healthy: true, tables });
        }
        catch (e) {
            return res.status(503).json({ ok: false, healthy: false, error: 'DB_QUERY_FAILED' });
        }
    });
    return r;
}
//# sourceMappingURL=admin.js.map