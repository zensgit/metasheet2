import { z } from 'zod'
import { Logger } from '../core/logger'

const logger = new Logger('Config')

const ServerSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().default(8900),
  env: z.string().default(process.env.NODE_ENV || 'development')
})

const DbSchema = z.object({
  url: z.string().optional(),
  poolMax: z.coerce.number().default(10),
  idleTimeoutMs: z.coerce.number().default(30000),
  connTimeoutMs: z.coerce.number().default(5000)
})

const JwtSchema = z.object({
  secret: z.string().default('dev-secret')
})

const WsSchema = z.object({
  redisEnabled: z.enum(['true', 'false']).default('false')
})

const AuthSchema = z.object({
  kanbanAuthRequired: z.enum(['true', 'false']).default('false')
})

const FeatureFlagsSchema = z.object({
  useKyselyDB: z.enum(['true', 'false']).default(process.env.NODE_ENV === 'test' ? 'true' : 'false'),
  kanbanDB: z.enum(['true', 'false']).default(process.env.NODE_ENV === 'test' ? 'true' : 'false'),
  workflowEnabled: z.enum(['true', 'false']).default('false')
})

const RootSchema = z.object({
  server: ServerSchema,
  db: DbSchema,
  jwt: JwtSchema,
  ws: WsSchema,
  auth: AuthSchema,
  featureFlags: FeatureFlagsSchema,
  telemetry: z.object({
    enabled: z.enum(['true','false']).default('false'),
    jaegerEndpoint: z.string().optional(),
    prometheusPort: z.coerce.number().default(9090),
    autoInstrumentation: z.enum(['true','false']).default('true'),
    metricsEnabled: z.enum(['true','false']).default('true'),
    tracingEnabled: z.enum(['true','false']).default('true'),
    samplingRate: z.coerce.number().default(1.0)
  }).default({ enabled: 'false', prometheusPort: 9090, autoInstrumentation: 'true', metricsEnabled: 'true', tracingEnabled: 'true', samplingRate: 1.0 })
})

export type AppConfig = z.infer<typeof RootSchema>

let cached: AppConfig | undefined

export function loadConfig(): AppConfig {
  const cfg: AppConfig = RootSchema.parse({
    server: { host: process.env.HOST, port: process.env.PORT, env: process.env.NODE_ENV },
    db: { url: process.env.DATABASE_URL, poolMax: process.env.PGPOOL_MAX, idleTimeoutMs: process.env.PG_IDLE_TIMEOUT_MS, connTimeoutMs: process.env.PG_CONN_TIMEOUT_MS },
    jwt: { secret: process.env.JWT_SECRET },
    ws: { redisEnabled: process.env.WS_REDIS_ENABLED as 'true' | 'false' | undefined },
    auth: { kanbanAuthRequired: process.env.KANBAN_AUTH_REQUIRED as 'true' | 'false' | undefined },
    featureFlags: {
      useKyselyDB: process.env.USE_KYSELY as 'true' | 'false' | undefined,
      kanbanDB: process.env.KANBAN_DB as 'true' | 'false' | undefined,
      workflowEnabled: process.env.WORKFLOW_ENABLED as 'true' | 'false' | undefined
    },
    telemetry: {
      enabled: process.env.OTEL_ENABLED as 'true' | 'false' | undefined,
      jaegerEndpoint: process.env.JAEGER_ENDPOINT,
      prometheusPort: process.env.PROMETHEUS_PORT,
      autoInstrumentation: process.env.TELEMETRY_AUTO_INSTRUMENT as 'true' | 'false' | undefined,
      metricsEnabled: process.env.TELEMETRY_METRICS as 'true' | 'false' | undefined,
      tracingEnabled: process.env.TELEMETRY_TRACING as 'true' | 'false' | undefined,
      samplingRate: process.env.TELEMETRY_SAMPLING_RATE
    }
  })
  cached = cfg
  if (process.env.CONFIG_LOG_ENABLED === 'true') {
    logger.info('Loaded configuration (sanitized)', sanitizeConfig(cfg))
  }
  return cfg
}

export function getConfig(): AppConfig {
  return cached || loadConfig()
}

/**
 * Reload configuration from environment variables
 * Forces a fresh parse of all config values
 */
export function reloadConfig(): AppConfig {
  cached = undefined
  return loadConfig()
}

export function sanitizeConfig(cfg: AppConfig) {
  return {
    server: cfg.server,
    db: { url: cfg.db.url ? '<configured>' : '<empty>', poolMax: cfg.db.poolMax, idleTimeoutMs: cfg.db.idleTimeoutMs, connTimeoutMs: cfg.db.connTimeoutMs },
    jwt: { secret: '<redacted>' },
    ws: cfg.ws,
    auth: cfg.auth,
    featureFlags: cfg.featureFlags,
    telemetry: { ...cfg.telemetry, jaegerEndpoint: cfg.telemetry.jaegerEndpoint ? '<configured>' : '<empty>' }
  }
}
