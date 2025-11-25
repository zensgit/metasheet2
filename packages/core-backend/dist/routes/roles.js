import { Router } from 'express';
import { rbacGuard } from '../rbac/rbac';
import { auditLog } from '../audit/audit';
import { pool } from '../db/pg';
// 简易内存存储占位
const roles = new Map();
export function rolesRouter() {
    const r = Router();
    r.get('/api/roles', rbacGuard('roles', 'read'), async (req, res) => {
        const page = Math.max(parseInt(req.query.page || '1', 10), 1);
        const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '50', 10), 1), 200);
        const offset = (page - 1) * pageSize;
        if (pool) {
            const count = await pool.query('SELECT COUNT(*)::int AS c FROM roles');
            const total = count.rows[0]?.c || 0;
            const { rows } = await pool.query('SELECT id, name, created_at, updated_at FROM roles ORDER BY id ASC LIMIT $1 OFFSET $2', [pageSize, offset]);
            return res.json({ ok: true, data: { items: rows, page, pageSize, total } });
        }
        const arr = Array.from(roles.values());
        const total = arr.length;
        const items = arr.slice(offset, offset + pageSize);
        return res.json({ ok: true, data: { items, page, pageSize, total } });
    });
    r.post('/api/roles', rbacGuard('roles', 'write'), async (req, res) => {
        const id = req.body?.id || `role_${Date.now()}`;
        const name = req.body?.name || 'unnamed';
        const perms = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
        if (pool) {
            await pool.query('INSERT INTO roles(id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [id, name]);
            for (const p of perms) {
                await pool.query('INSERT INTO role_permissions(role_id, permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, p]);
            }
            await auditLog({ actorId: req.user?.id, actorType: 'user', action: 'create', resourceType: 'role', resourceId: id, meta: { name, permissions: perms } });
            const { rows } = await pool.query('SELECT id, name, created_at, updated_at FROM roles WHERE id=$1', [id]);
            return res.json({ ok: true, data: rows[0] });
        }
        roles.set(id, { id, name, permissions: perms });
        await auditLog({ actorId: req.user?.id, actorType: 'user', action: 'create', resourceType: 'role', resourceId: id, meta: { name, permissions: perms } });
        return res.json({ ok: true, data: roles.get(id) });
    });
    r.put('/api/roles/:id', rbacGuard('roles', 'write'), async (req, res) => {
        const id = req.params.id;
        if (pool) {
            const { rows } = await pool.query('SELECT id, name FROM roles WHERE id=$1', [id]);
            if (!rows.length)
                return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Role not found' } });
            const before = rows[0];
            const name = req.body?.name ?? before.name;
            await pool.query('UPDATE roles SET name=$1, updated_at=now() WHERE id=$2', [name, id]);
            await auditLog({ actorId: req.user?.id, actorType: 'user', action: 'update', resourceType: 'role', resourceId: id, meta: { before, after: { id, name } } });
            return res.json({ ok: true, data: { id, name } });
        }
        const before = roles.get(id);
        if (!before)
            return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Role not found' } });
        const next = { ...before, ...req.body };
        roles.set(id, next);
        await auditLog({ actorId: req.user?.id, actorType: 'user', action: 'update', resourceType: 'role', resourceId: id, meta: { before, after: next } });
        return res.json({ ok: true, data: next });
    });
    r.delete('/api/roles/:id', rbacGuard('roles', 'write'), async (req, res) => {
        const id = req.params.id;
        if (pool) {
            const { rows } = await pool.query('SELECT id, name FROM roles WHERE id=$1', [id]);
            const before = rows[0] || null;
            await pool.query('DELETE FROM roles WHERE id=$1', [id]);
            await auditLog({ actorId: req.user?.id, actorType: 'user', action: 'delete', resourceType: 'role', resourceId: id, meta: { before } });
            return res.json({ ok: true, data: { id } });
        }
        const before = roles.get(id);
        roles.delete(id);
        await auditLog({ actorId: req.user?.id, actorType: 'user', action: 'delete', resourceType: 'role', resourceId: id, meta: { before } });
        return res.json({ ok: true, data: { id } });
    });
    return r;
}
//# sourceMappingURL=roles.js.map