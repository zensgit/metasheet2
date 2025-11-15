"use strict";
/**
 * 配置管理
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConfig = getConfig;
exports.sanitizeConfig = sanitizeConfig;
function getConfig() {
    return {
        db: {
            url: process.env.DATABASE_URL || '',
            poolMax: parseInt(process.env.PGPOOL_MAX || '10', 10),
            idleTimeoutMs: parseInt(process.env.PGPOOL_IDLE_TIMEOUT || '10000', 10),
            connTimeoutMs: parseInt(process.env.PGPOOL_CONN_TIMEOUT || '5000', 10)
        },
        server: {
            port: parseInt(process.env.PORT || '8900', 10),
            host: process.env.HOST || '127.0.0.1'
        },
        auth: {
            jwtSecret: process.env.JWT_SECRET || 'dev-secret',
            jwtPublicKey: process.env.JWT_PUBLIC_KEY,
            kanbanAuthRequired: process.env.KANBAN_AUTH_REQUIRED === 'true'
        },
        ws: {
            redisEnabled: process.env.WS_REDIS_ENABLED || 'false'
        },
        kanban: {
            authRequired: process.env.KANBAN_AUTH_REQUIRED === 'true'
        }
    };
}
/**
 * Sanitize config for external exposure (remove secrets)
 */
function sanitizeConfig(cfg) {
    return {
        db: {
            poolMax: cfg.db.poolMax,
            idleTimeoutMs: cfg.db.idleTimeoutMs,
            connTimeoutMs: cfg.db.connTimeoutMs
        },
        server: {
            port: cfg.server.port,
            host: cfg.server.host
        },
        auth: {
            kanbanAuthRequired: cfg.auth.kanbanAuthRequired
        },
        ws: {
            redisEnabled: cfg.ws.redisEnabled
        },
        kanban: {
            authRequired: cfg.kanban.authRequired
        }
    };
}
//# sourceMappingURL=config.js.map