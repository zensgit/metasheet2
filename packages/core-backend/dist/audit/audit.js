import { Logger } from '../core/logger';
import { pool } from '../db/pg';
const logger = new Logger('Audit');
export async function auditLog(params) {
    // 尝试落库；若未配置数据库则退化为日志
    try {
        if (pool) {
            await pool.query(`INSERT INTO operation_audit_logs
         (actor_id, actor_type, action, resource_type, resource_id, request_id, ip, user_agent, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
                params.actorId || null,
                params.actorType,
                params.action,
                params.resourceType,
                params.resourceId || null,
                params.requestId || null,
                params.ip || null,
                params.userAgent || null,
                JSON.stringify(params.meta || {})
            ]);
            return;
        }
    }
    catch (e) {
        // 落库失败则记录日志并继续
        logger.warn('audit insert failed, fallback to log');
    }
    logger.info('audit', params);
}
//# sourceMappingURL=audit.js.map