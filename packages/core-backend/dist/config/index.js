import { z } from 'zod';
import { Logger } from '../core/logger';
import { EventEmitter } from 'eventemitter3';
const logger = new Logger('Config');
const bus = new EventEmitter();
const ServerSchema = z.object({
    host: z.string().default('0.0.0.0'),
    port: z.coerce.number().default(8900),
    env: z.string().default(process.env.NODE_ENV || 'development')
});
const DbSchema = z.object({
    url: z.string().optional(),
    poolMax: z.coerce.number().default(10),
    idleTimeoutMs: z.coerce.number().default(30000),
    connTimeoutMs: z.coerce.number().default(5000)
});
const JwtSchema = z.object({
    secret: z.string().default('dev-secret')
});
const WsSchema = z.object({
    redisEnabled: z.enum(['true', 'false']).default('false')
});
const AuthSchema = z.object({
    kanbanAuthRequired: z.enum(['true', 'false']).default('false')
});
const FeatureFlagsSchema = z.object({
    useKyselyDB: z.enum(['true', 'false']).default(process.env.NODE_ENV === 'test' ? 'true' : 'false'),
    kanbanDB: z.enum(['true', 'false']).default(process.env.NODE_ENV === 'test' ? 'true' : 'false'),
    workflowEnabled: z.enum(['true', 'false']).default('false')
});
const RootSchema = z.object({
    server: ServerSchema,
    db: DbSchema,
    jwt: JwtSchema,
    ws: WsSchema,
    auth: AuthSchema,
    featureFlags: FeatureFlagsSchema,
    telemetry: z.object({
        enabled: z.enum(['true', 'false']).default('false'),
        jaegerEndpoint: z.string().optional(),
        prometheusPort: z.coerce.number().default(9090),
        autoInstrumentation: z.enum(['true', 'false']).default('true'),
        metricsEnabled: z.enum(['true', 'false']).default('true'),
        tracingEnabled: z.enum(['true', 'false']).default('true'),
        samplingRate: z.coerce.number().default(1.0)
    }).default({ enabled: 'false', prometheusPort: 9090, autoInstrumentation: 'true', metricsEnabled: 'true', tracingEnabled: 'true', samplingRate: 1.0 })
});
let cached;
export function loadConfig() {
    const cfg = RootSchema.parse({
        server: { host: process.env.HOST, port: process.env.PORT, env: process.env.NODE_ENV },
        db: { url: process.env.DATABASE_URL, poolMax: process.env.PGPOOL_MAX, idleTimeoutMs: process.env.PG_IDLE_TIMEOUT_MS, connTimeoutMs: process.env.PG_CONN_TIMEOUT_MS },
        jwt: { secret: process.env.JWT_SECRET },
        ws: { redisEnabled: process.env.WS_REDIS_ENABLED },
        auth: { kanbanAuthRequired: process.env.KANBAN_AUTH_REQUIRED },
        featureFlags: {
            useKyselyDB: process.env.USE_KYSELY,
            kanbanDB: process.env.KANBAN_DB,
            workflowEnabled: process.env.WORKFLOW_ENABLED
        },
        telemetry: {
            enabled: process.env.OTEL_ENABLED,
            jaegerEndpoint: process.env.JAEGER_ENDPOINT,
            prometheusPort: process.env.PROMETHEUS_PORT,
            autoInstrumentation: process.env.TELEMETRY_AUTO_INSTRUMENT,
            metricsEnabled: process.env.TELEMETRY_METRICS,
            tracingEnabled: process.env.TELEMETRY_TRACING,
            samplingRate: process.env.TELEMETRY_SAMPLING_RATE
        }
    });
    cached = cfg;
    if (process.env.CONFIG_LOG_ENABLED === 'true') {
        logger.info('Loaded configuration (sanitized)', sanitizeConfig(cfg));
    }
    return cfg;
}
export function getConfig() {
    return cached || loadConfig();
}
export function sanitizeConfig(cfg) {
    return {
        server: cfg.server,
        db: { url: cfg.db.url ? '<configured>' : '<empty>', poolMax: cfg.db.poolMax, idleTimeoutMs: cfg.db.idleTimeoutMs, connTimeoutMs: cfg.db.connTimeoutMs },
        jwt: { secret: '<redacted>' },
        ws: cfg.ws,
        auth: cfg.auth,
        featureFlags: cfg.featureFlags,
        telemetry: { ...cfg.telemetry, jaegerEndpoint: cfg.telemetry.jaegerEndpoint ? '<configured>' : '<empty>' }
    };
}
//# sourceMappingURL=index.js.map