"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.permissionsRouter = permissionsRouter;
const express_1 = require("express");
const rbac_1 = require("../rbac/rbac");
const audit_1 = require("../audit/audit");
const pg_1 = require("../db/pg");
const service_1 = require("../rbac/service");
// 简易内存权限映射：userId -> Set(perms)
const userPerms = new Map();
function permissionsRouter() {
    const r = (0, express_1.Router)();
    r.get('/api/permissions', (0, rbac_1.rbacGuard)('permissions', 'read'), async (req, res) => {
        const userId = req.query.userId || req.user?.id;
        if (!userId)
            return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'userId required' } });
        if (pg_1.pool) {
            const perms = await (0, service_1.listUserPermissions)(userId);
            return res.json({ ok: true, data: { userId, permissions: perms } });
        }
        const perms = Array.from(userPerms.get(userId) || new Set());
        return res.json({ ok: true, data: { userId, permissions: perms } });
    });
    r.post('/api/permissions/grant', (0, rbac_1.rbacGuard)('permissions', 'write'), async (req, res) => {
        const { userId, permission } = req.body || {};
        if (!userId || !permission)
            return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'userId and permission required' } });
        if (pg_1.pool) {
            await pg_1.pool.query('INSERT INTO user_permissions(user_id, permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, permission]);
            await (0, audit_1.auditLog)({ actorId: req.user?.id, actorType: 'user', action: 'grant', resourceType: 'permission', resourceId: `${userId}:${permission}`, meta: { userId, permission } });
            (0, service_1.invalidateUserPerms)(userId);
            const perms = await (0, service_1.listUserPermissions)(userId);
            return res.json({ ok: true, data: { userId, permissions: perms } });
        }
        const set = userPerms.get(userId) || new Set();
        set.add(permission);
        userPerms.set(userId, set);
        await (0, audit_1.auditLog)({ actorId: req.user?.id, actorType: 'user', action: 'grant', resourceType: 'permission', resourceId: `${userId}:${permission}`, meta: { userId, permission } });
        return res.json({ ok: true, data: { userId, permissions: Array.from(set) } });
    });
    r.post('/api/permissions/revoke', (0, rbac_1.rbacGuard)('permissions', 'write'), async (req, res) => {
        const { userId, permission } = req.body || {};
        if (!userId || !permission)
            return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'userId and permission required' } });
        if (pg_1.pool) {
            await pg_1.pool.query('DELETE FROM user_permissions WHERE user_id=$1 AND permission_code=$2', [userId, permission]);
            await (0, audit_1.auditLog)({ actorId: req.user?.id, actorType: 'user', action: 'revoke', resourceType: 'permission', resourceId: `${userId}:${permission}`, meta: { userId, permission } });
            (0, service_1.invalidateUserPerms)(userId);
            const perms = await (0, service_1.listUserPermissions)(userId);
            return res.json({ ok: true, data: { userId, permissions: perms } });
        }
        const set = userPerms.get(userId) || new Set();
        set.delete(permission);
        userPerms.set(userId, set);
        await (0, audit_1.auditLog)({ actorId: req.user?.id, actorType: 'user', action: 'revoke', resourceType: 'permission', resourceId: `${userId}:${permission}`, meta: { userId, permission } });
        return res.json({ ok: true, data: { userId, permissions: Array.from(set) } });
    });
    r.get('/api/permissions/cache-status', (0, rbac_1.rbacGuard)('permissions', 'read'), (req, res) => {
        return res.json({ ok: true, data: (0, service_1.getPermCacheStatus)() });
    });
    return r;
}
//# sourceMappingURL=permissions.js.map