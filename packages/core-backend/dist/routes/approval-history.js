"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.approvalHistoryRouter = approvalHistoryRouter;
const express_1 = require("express");
const pg_1 = require("../db/pg");
function approvalHistoryRouter() {
    const r = (0, express_1.Router)();
    r.get('/api/approvals/:id/history', async (req, res) => {
        const id = req.params.id;
        if (pg_1.pool) {
            const page = Math.max(parseInt(req.query.page || '1', 10), 1);
            const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '50', 10), 1), 200);
            const offset = (page - 1) * pageSize;
            const countRes = await pg_1.pool.query('SELECT COUNT(*)::int AS c FROM approval_records WHERE instance_id = $1', [id]);
            const total = countRes.rows[0]?.c || 0;
            const { rows } = await pg_1.pool.query(`SELECT occurred_at, actor_id, action, comment, from_status, to_status, version
         FROM approval_records
         WHERE instance_id = $1
         ORDER BY occurred_at DESC
         LIMIT $2 OFFSET $3`, [id, pageSize, offset]);
            return res.json({ ok: true, data: { items: rows, page, pageSize, total } });
        }
        else {
            // fallback：从审计日志读取
            return res.status(503).json({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'DB not configured' } });
        }
    });
    return r;
}
//# sourceMappingURL=approval-history.js.map