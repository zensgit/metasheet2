"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
exports.getConfig = getConfig;
exports.sanitizeConfig = sanitizeConfig;
const zod_1 = require("zod");
const logger_1 = require("../core/logger");
const eventemitter3_1 = require("eventemitter3");
const logger = new logger_1.Logger('Config');
const bus = new eventemitter3_1.EventEmitter();
const ServerSchema = zod_1.z.object({
    host: zod_1.z.string().default('0.0.0.0'),
    port: zod_1.z.coerce.number().default(8900),
    env: zod_1.z.string().default(process.env.NODE_ENV || 'development')
});
const DbSchema = zod_1.z.object({
    url: zod_1.z.string().optional(),
    poolMax: zod_1.z.coerce.number().default(10),
    idleTimeoutMs: zod_1.z.coerce.number().default(30000),
    connTimeoutMs: zod_1.z.coerce.number().default(5000)
});
const JwtSchema = zod_1.z.object({
    secret: zod_1.z.string().default('dev-secret')
});
const WsSchema = zod_1.z.object({
    redisEnabled: zod_1.z.enum(['true', 'false']).default('false')
});
const AuthSchema = zod_1.z.object({
    kanbanAuthRequired: zod_1.z.enum(['true', 'false']).default('false')
});
const FeatureFlagsSchema = zod_1.z.object({
    useKyselyDB: zod_1.z.enum(['true', 'false']).default(process.env.NODE_ENV === 'test' ? 'true' : 'false'),
    kanbanDB: zod_1.z.enum(['true', 'false']).default(process.env.NODE_ENV === 'test' ? 'true' : 'false'),
    workflowEnabled: zod_1.z.enum(['true', 'false']).default('false')
});
const RootSchema = zod_1.z.object({
    server: ServerSchema,
    db: DbSchema,
    jwt: JwtSchema,
    ws: WsSchema,
    auth: AuthSchema,
    featureFlags: FeatureFlagsSchema,
    telemetry: zod_1.z.object({
        enabled: zod_1.z.enum(['true', 'false']).default('false'),
        jaegerEndpoint: zod_1.z.string().optional(),
        prometheusPort: zod_1.z.coerce.number().default(9090),
        autoInstrumentation: zod_1.z.enum(['true', 'false']).default('true'),
        metricsEnabled: zod_1.z.enum(['true', 'false']).default('true'),
        tracingEnabled: zod_1.z.enum(['true', 'false']).default('true'),
        samplingRate: zod_1.z.coerce.number().default(1.0)
    }).default({ enabled: 'false', prometheusPort: 9090, autoInstrumentation: 'true', metricsEnabled: 'true', tracingEnabled: 'true', samplingRate: 1.0 })
});
let cached;
function loadConfig() {
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
function getConfig() {
    return cached || loadConfig();
}
function sanitizeConfig(cfg) {
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