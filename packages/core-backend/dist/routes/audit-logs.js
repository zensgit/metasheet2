import { Router } from 'express';
import { pool } from '../db/pg';
import { z } from 'zod';
import { rbacGuard } from '../rbac/rbac';
export function auditLogsRouter() {
    const r = Router();
    r.get('/api/audit-logs', rbacGuard('audit', 'read'), async (req, res) => {
        if (!pool)
            return res.status(503).json({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'DB not configured' } });
        const schema = z.object({
            actorId: z.string().optional(),
            resourceType: z.string().optional(),
            resourceId: z.string().optional(),
            action: z.string().optional(),
            from: z.string().datetime().optional(),
            to: z.string().datetime().optional(),
            page: z.string().regex(/^\d+$/).default('1'),
            pageSize: z.string().regex(/^\d+$/).default('50'),
            format: z.enum(['csv', 'ndjson']).optional(),
            limit: z.string().regex(/^\d+$/).optional()
        });
        const parsed = schema.safeParse(req.query);
        if (!parsed.success) {
            return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map(i => i.message).join('; ') } });
        }
        const q = parsed.data;
        const page = Math.max(parseInt(q.page, 10), 1);
        const pageSizeRaw = Math.max(parseInt(q.pageSize, 10), 1);
        const pageSize = Math.min(pageSizeRaw, 500);
        const offset = (page - 1) * pageSize;
        const maxExport = Math.min(parseInt(q.limit || '10000', 10), 100000);
        const where = [];
        const params = [];
        const push = (cond, val) => { params.push(val); where.push(cond.replace('$n', `$${params.length}`)); };
        if (q.actorId)
            push('actor_id = $n', q.actorId);
        if (q.resourceType)
            push('resource_type = $n', q.resourceType);
        if (q.resourceId)
            push('resource_id = $n', q.resourceId);
        if (q.action)
            push('action = $n', q.action);
        if (q.from)
            push('occurred_at >= $n', q.from);
        if (q.to)
            push('occurred_at <= $n', q.to);
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        if (q.format === 'csv' || q.format === 'ndjson') {
            const limit = maxExport;
            const sql = `SELECT id, occurred_at, actor_id, actor_type, action, resource_type, resource_id, request_id, ip, user_agent, meta
                   FROM operation_audit_logs ${whereSql}
                   ORDER BY occurred_at DESC
                   LIMIT ${limit}`;
            const { rows } = await pool.query(sql, params);
            if (q.format === 'csv') {
                res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                res.setHeader('Content-Disposition', 'attachment; filename="audit-logs.csv"');
                res.write('id,occurred_at,actor_id,actor_type,action,resource_type,resource_id,request_id,ip,user_agent,meta\n');
                for (const r of rows) {
                    const line = [
                        r.id,
                        r.occurred_at.toISOString?.() || r.occurred_at,
                        r.actor_id || '',
                        r.actor_type || '',
                        r.action || '',
                        r.resource_type || '',
                        r.resource_id || '',
                        r.request_id || '',
                        r.ip || '',
                        (r.user_agent || '').replace(/[\n\r]/g, ' '),
                        JSON.stringify(r.meta || {})
                    ].map(v => {
                        const s = String(v);
                        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
                    }).join(',');
                    res.write(line + '\n');
                }
                return res.end();
            }
            else {
                res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
                for (const r of rows) {
                    res.write(JSON.stringify(r) + '\n');
                }
                return res.end();
            }
        }
        const countSql = `SELECT COUNT(*)::int AS c FROM operation_audit_logs ${whereSql}`;
        const countRes = await pool.query(countSql, params);
        const total = countRes.rows[0]?.c || 0;
        const sql = `SELECT id, occurred_at, actor_id, actor_type, action, resource_type, resource_id, request_id, ip, user_agent, meta
                 FROM operation_audit_logs ${whereSql}
                 ORDER BY occurred_at DESC
                 LIMIT ${pageSize} OFFSET ${offset}`;
        const { rows } = await pool.query(sql, params);
        return res.json({ ok: true, data: { items: rows, page, pageSize, total } });
    });
    return r;
}
//# sourceMappingURL=audit-logs.js.map