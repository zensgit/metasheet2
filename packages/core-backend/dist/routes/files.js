"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.filesRouter = filesRouter;
const express_1 = require("express");
const rbac_1 = require("../rbac/rbac");
const audit_1 = require("../audit/audit");
const pg_1 = require("../db/pg");
function filesRouter() {
    const r = (0, express_1.Router)();
    r.post('/api/files/upload', (0, rbac_1.rbacGuard)('files', 'write'), async (req, res) => {
        const id = `file_${Date.now()}`;
        const url = req.body?.url || null;
        const ownerId = req.user?.id || null;
        if (pg_1.pool) {
            await pg_1.pool.query('INSERT INTO files(id, url, owner_id, meta) VALUES ($1,$2,$3,$4)', [id, url, ownerId, JSON.stringify({})]);
        }
        await (0, audit_1.auditLog)({ actorId: ownerId || undefined, actorType: 'user', action: 'upload', resourceType: 'file', resourceId: id, meta: { url } });
        return res.json({ ok: true, data: { id, url } });
    });
    r.get('/api/files/:id', (0, rbac_1.rbacGuard)('files', 'read'), async (req, res) => {
        if (pg_1.pool) {
            const { rows } = await pg_1.pool.query('SELECT id, url, owner_id, meta, created_at FROM files WHERE id=$1', [req.params.id]);
            if (!rows.length)
                return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'File not found' } });
            await (0, audit_1.auditLog)({ actorId: req.user?.id, actorType: 'user', action: 'read', resourceType: 'file', resourceId: req.params.id });
            return res.json({ ok: true, data: rows[0] });
        }
        await (0, audit_1.auditLog)({ actorId: req.user?.id, actorType: 'user', action: 'read', resourceType: 'file', resourceId: req.params.id });
        return res.json({ ok: true, data: { id: req.params.id, url: `http://localhost:${process.env.PORT || 8900}/files/${req.params.id}` } });
    });
    return r;
}
//# sourceMappingURL=files.js.map