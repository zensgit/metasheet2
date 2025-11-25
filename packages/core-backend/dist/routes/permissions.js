import { Router } from 'express';
import { rbacGuard } from '../rbac/rbac';
import { auditLog } from '../audit/audit';
import { pool } from '../db/pg';
import { listUserPermissions, invalidateUserPerms, getPermCacheStatus } from '../rbac/service';
// 简易内存权限映射：userId -> Set(perms)
const userPerms = new Map();
export function permissionsRouter() {
    const r = Router();
    r.get('/api/permissions', rbacGuard('permissions', 'read'), async (req, res) => {
        const userId = req.query.userId || req.user?.id;
        if (!userId)
            return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'userId required' } });
        if (pool) {
            const perms = await listUserPermissions(userId);
            return res.json({ ok: true, data: { userId, permissions: perms } });
        }
        const perms = Array.from(userPerms.get(userId) || new Set());
        return res.json({ ok: true, data: { userId, permissions: perms } });
    });
    r.post('/api/permissions/grant', rbacGuard('permissions', 'write'), async (req, res) => {
        const { userId, permission } = req.body || {};
        if (!userId || !permission)
            return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'userId and permission required' } });
        if (pool) {
            await pool.query('INSERT INTO user_permissions(user_id, permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, permission]);
            await auditLog({ actorId: req.user?.id, actorType: 'user', action: 'grant', resourceType: 'permission', resourceId: `${userId}:${permission}`, meta: { userId, permission } });
            invalidateUserPerms(userId);
            const perms = await listUserPermissions(userId);
            return res.json({ ok: true, data: { userId, permissions: perms } });
        }
        const set = userPerms.get(userId) || new Set();
        set.add(permission);
        userPerms.set(userId, set);
        await auditLog({ actorId: req.user?.id, actorType: 'user', action: 'grant', resourceType: 'permission', resourceId: `${userId}:${permission}`, meta: { userId, permission } });
        return res.json({ ok: true, data: { userId, permissions: Array.from(set) } });
    });
    r.post('/api/permissions/revoke', rbacGuard('permissions', 'write'), async (req, res) => {
        const { userId, permission } = req.body || {};
        if (!userId || !permission)
            return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'userId and permission required' } });
        if (pool) {
            await pool.query('DELETE FROM user_permissions WHERE user_id=$1 AND permission_code=$2', [userId, permission]);
            await auditLog({ actorId: req.user?.id, actorType: 'user', action: 'revoke', resourceType: 'permission', resourceId: `${userId}:${permission}`, meta: { userId, permission } });
            invalidateUserPerms(userId);
            const perms = await listUserPermissions(userId);
            return res.json({ ok: true, data: { userId, permissions: perms } });
        }
        const set = userPerms.get(userId) || new Set();
        set.delete(permission);
        userPerms.set(userId, set);
        await auditLog({ actorId: req.user?.id, actorType: 'user', action: 'revoke', resourceType: 'permission', resourceId: `${userId}:${permission}`, meta: { userId, permission } });
        return res.json({ ok: true, data: { userId, permissions: Array.from(set) } });
    });
    r.get('/api/permissions/cache-status', rbacGuard('permissions', 'read'), (req, res) => {
        return res.json({ ok: true, data: getPermCacheStatus() });
    });
    return r;
}
//# sourceMappingURL=permissions.js.map