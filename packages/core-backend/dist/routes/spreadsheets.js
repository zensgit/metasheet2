"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.spreadsheetsRouter = spreadsheetsRouter;
const express_1 = require("express");
const rbac_1 = require("../rbac/rbac");
const audit_1 = require("../audit/audit");
const pg_1 = require("../db/pg");
const zod_1 = require("zod");
// 简易内存表
const sheets = new Map();
function spreadsheetsRouter() {
    const r = (0, express_1.Router)();
    r.get('/api/spreadsheets', (0, rbac_1.rbacGuard)('spreadsheets', 'read'), async (req, res) => {
        const page = Math.max(parseInt(req.query.page || '1', 10), 1);
        const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '50', 10), 1), 200);
        const offset = (page - 1) * pageSize;
        if (pg_1.pool) {
            const count = await pg_1.pool.query('SELECT COUNT(*)::int AS c FROM spreadsheets WHERE deleted_at IS NULL');
            const total = count.rows[0]?.c || 0;
            const { rows } = await pg_1.pool.query('SELECT id, name, owner_id, created_at, updated_at FROM spreadsheets WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT $1 OFFSET $2', [pageSize, offset]);
            return res.json({ ok: true, data: { items: rows, page, pageSize, total } });
        }
        const arr = Array.from(sheets.values()).filter(s => !s.deleted);
        const total = arr.length;
        const items = arr.slice(offset, offset + pageSize);
        return res.json({ ok: true, data: { items, page, pageSize, total } });
    });
    r.post('/api/spreadsheets', (0, rbac_1.rbacGuard)('spreadsheets', 'write'), async (req, res) => {
        const schema = zod_1.z.object({ id: zod_1.z.string().optional(), name: zod_1.z.string().min(1), ownerId: zod_1.z.string().optional() });
        const parse = schema.safeParse(req.body);
        if (!parse.success)
            return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parse.error.message } });
        const id = parse.data.id || `sheet_${Date.now()}`;
        const name = parse.data.name;
        const ownerId = parse.data.ownerId || req.user?.id;
        if (pg_1.pool) {
            await pg_1.pool.query('INSERT INTO spreadsheets(id, name, owner_id) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING', [id, name, ownerId]);
            await (0, audit_1.auditLog)({ actorId: req.user?.id, actorType: 'user', action: 'create', resourceType: 'spreadsheet', resourceId: id, meta: { name, ownerId } });
            const { rows } = await pg_1.pool.query('SELECT id, name, owner_id, created_at, updated_at FROM spreadsheets WHERE id=$1', [id]);
            return res.json({ ok: true, data: rows[0] });
        }
        const sheet = { id, name };
        sheets.set(id, sheet);
        await (0, audit_1.auditLog)({ actorId: req.user?.id, actorType: 'user', action: 'create', resourceType: 'spreadsheet', resourceId: id, meta: { name } });
        return res.json({ ok: true, data: sheet });
    });
    r.put('/api/spreadsheets/:id', (0, rbac_1.rbacGuard)('spreadsheets', 'write'), async (req, res) => {
        const id = req.params.id;
        if (pg_1.pool) {
            const { rows } = await pg_1.pool.query('SELECT id, name, owner_id FROM spreadsheets WHERE id=$1 AND deleted_at IS NULL', [id]);
            if (!rows.length)
                return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Sheet not found' } });
            const before = rows[0];
            const name = req.body?.name ?? before.name;
            await pg_1.pool.query('UPDATE spreadsheets SET name=$1, updated_at=now() WHERE id=$2', [name, id]);
            await (0, audit_1.auditLog)({ actorId: req.user?.id, actorType: 'user', action: 'update', resourceType: 'spreadsheet', resourceId: id, meta: { before, after: { id, name, owner_id: before.owner_id } } });
            return res.json({ ok: true, data: { id, name, owner_id: before.owner_id } });
        }
        const before = sheets.get(id);
        if (!before)
            return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Sheet not found' } });
        const next = { ...before, ...req.body };
        sheets.set(id, next);
        await (0, audit_1.auditLog)({ actorId: req.user?.id, actorType: 'user', action: 'update', resourceType: 'spreadsheet', resourceId: id, meta: { before, after: next } });
        return res.json({ ok: true, data: next });
    });
    r.delete('/api/spreadsheets/:id', (0, rbac_1.rbacGuard)('spreadsheets', 'write'), async (req, res) => {
        const id = req.params.id;
        if (pg_1.pool) {
            const { rows } = await pg_1.pool.query('SELECT id, name FROM spreadsheets WHERE id=$1 AND deleted_at IS NULL', [id]);
            if (!rows.length)
                return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Sheet not found' } });
            const before = rows[0];
            await pg_1.pool.query('UPDATE spreadsheets SET deleted_at=now() WHERE id=$1', [id]);
            await (0, audit_1.auditLog)({ actorId: req.user?.id, actorType: 'user', action: 'delete', resourceType: 'spreadsheet', resourceId: id, meta: { before } });
            return res.json({ ok: true, data: { id } });
        }
        const before = sheets.get(id);
        if (!before)
            return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Sheet not found' } });
        sheets.set(id, { ...before, deleted: true });
        await (0, audit_1.auditLog)({ actorId: req.user?.id, actorType: 'user', action: 'delete', resourceType: 'spreadsheet', resourceId: id, meta: { before } });
        return res.json({ ok: true, data: { id } });
    });
    return r;
}
//# sourceMappingURL=spreadsheets.js.map