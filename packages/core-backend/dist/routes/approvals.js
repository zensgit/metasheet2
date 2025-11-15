"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.approvalsRouter = approvalsRouter;
const express_1 = require("express");
const metrics_1 = require("../metrics/metrics");
const audit_1 = require("../audit/audit");
const pg_1 = require("../db/pg");
// 简化的内存存储用于演示乐观锁协议
const instances = new Map();
instances.set('demo-1', { id: 'demo-1', status: 'PENDING', version: 0 });
function approvalsRouter() {
    const r = (0, express_1.Router)();
    r.get('/api/approvals/:id', async (req, res) => {
        if (pg_1.pool) {
            const { rows } = await pg_1.pool.query('SELECT id, status, version FROM approval_instances WHERE id = $1', [req.params.id]);
            if (!rows.length)
                return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Instance not found' } });
            return res.json({ ok: true, data: rows[0] });
        }
        else {
            const inst = instances.get(req.params.id);
            if (!inst)
                return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Instance not found' } });
            return res.json({ ok: true, data: inst });
        }
    });
    async function transition(req, res, action, newStatus) {
        const reqVersion = Number(req.body?.version);
        if (!Number.isInteger(reqVersion)) {
            return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'version required' } });
        }
        if (pg_1.pool) {
            // 单条语句的原子更新 + 返回旧/新值
            try {
                const { rows } = await pg_1.pool.query(`WITH cur AS (
             SELECT id, status, version FROM approval_instances WHERE id = $1
           ), upd AS (
             UPDATE approval_instances a
             SET status = $2, version = cur.version + 1
             FROM cur
             WHERE a.id = cur.id AND cur.version = $3
             RETURNING a.id, a.version, $2::text AS to_status, cur.status AS from_status, cur.version AS prev_version
           )
           SELECT * FROM upd`, [req.params.id, newStatus, reqVersion]);
                if (!rows.length) {
                    // 区分不存在与版本冲突
                    const v = await pg_1.pool.query('SELECT version FROM approval_instances WHERE id=$1', [req.params.id]);
                    if (v.rows.length) {
                        metrics_1.metrics.approvalActions.inc({ action, result: 'conflict' });
                        metrics_1.metrics.approvalConflict.inc({ action });
                        return res.status(409).json({ ok: false, error: { code: 'APPROVAL_VERSION_CONFLICT', message: 'Approval instance version mismatch', currentVersion: v.rows[0].version } });
                    }
                    return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Instance not found' } });
                }
                const row = rows[0];
                await pg_1.pool.query('INSERT INTO approval_records(instance_id, action, actor_id, comment, from_status, to_status, version) VALUES ($1,$2,$3,$4,$5,$6,$7)', [row.id, action, req.user?.id || null, req.body?.comment || null, row.from_status, row.to_status, row.version]);
                metrics_1.metrics.approvalActions.inc({ action, result: 'success' });
                await (0, audit_1.auditLog)({
                    actorId: req.user?.id,
                    actorType: 'user',
                    action,
                    resourceType: 'approval',
                    resourceId: row.id,
                    ip: req.ip,
                    userAgent: req.headers['user-agent'],
                    meta: { from: row.from_status, to: row.to_status, prevVersion: row.prev_version, newVersion: row.version }
                });
                return res.json({ ok: true, data: { id: row.id, status: row.to_status, version: row.version, prevVersion: row.prev_version } });
            }
            catch (e) {
                return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: `${action} failed` } });
            }
        }
        else {
            // 内存 fallback（开发场景）
            const inst = instances.get(req.params.id);
            if (!inst)
                return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Instance not found' } });
            if (inst.version !== reqVersion) {
                metrics_1.metrics.approvalActions.inc({ action, result: 'conflict' });
                metrics_1.metrics.approvalConflict.inc({ action });
                return res.status(409).json({ ok: false, error: { code: 'APPROVAL_VERSION_CONFLICT', message: 'Approval instance version mismatch', currentVersion: inst.version } });
            }
            inst.status = newStatus;
            inst.version += 1;
            metrics_1.metrics.approvalActions.inc({ action, result: 'success' });
            await (0, audit_1.auditLog)({
                actorId: req.user?.id,
                actorType: 'user',
                action,
                resourceType: 'approval',
                resourceId: inst.id,
                ip: req.ip,
                userAgent: req.headers['user-agent'],
                meta: { from: 'PENDING', to: newStatus, prevVersion: reqVersion, newVersion: inst.version }
            });
            return res.json({ ok: true, data: inst });
        }
    }
    r.post('/api/approvals/:id/approve', async (req, res) => transition(req, res, 'approve', 'APPROVED'));
    r.post('/api/approvals/:id/reject', async (req, res) => transition(req, res, 'reject', 'REJECTED'));
    r.post('/api/approvals/:id/return', async (req, res) => transition(req, res, 'return', 'RETURNED'));
    r.post('/api/approvals/:id/revoke', async (req, res) => transition(req, res, 'revoke', 'REVOKED'));
    return r;
}
//# sourceMappingURL=approvals.js.map