/**
 * Data Sources REST API Routes
 *
 * Provides API endpoints for managing external data source connections
 * including PostgreSQL and HTTP/REST APIs.
 *
 * V2 Features:
 * - Zod schema validation for all requests
 * - Support for connection pooling and health checks
 * - Secure credential handling (never exposed in responses)
 */

import type { Request, Response } from 'express'
import { Router } from 'express'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import { rbacGuard } from '../rbac/rbac'
import { auditLog } from '../audit/audit'
import {
  c6WriteTargetQueryDisabledMessage,
  DATA_SOURCE_C6_WRITE_TARGET_QUERY_DISABLED_CODE,
  DataSourceManager,
  isGenericQueryDisabledConfig,
  SUPPORTED_DATA_SOURCE_TYPES
} from '../data-adapters/DataSourceManager'
import type { DataSourceConfig, QueryOptions } from '../data-adapters/BaseAdapter'
import { DATA_SOURCE_DEFAULT_LIMIT, DATA_SOURCE_MAX_ROWS } from '../data-adapters/BaseAdapter'

// Zod schemas for request validation
const ConnectionConfigSchema = z.record(z.union([z.string(), z.number(), z.boolean()]))

const DataSourceCreateSchema = z.object({
  id: z.string().min(1, 'ID is required'),
  name: z.string().min(1, 'Name is required'),
  type: z.enum(SUPPORTED_DATA_SOURCE_TYPES, {
    errorMap: () => ({ message: 'Unsupported data source type' })
  }),
  connection: ConnectionConfigSchema,
  options: z.object({
    autoConnect: z.boolean().optional(),
    timeout: z.number().optional(),
    retryAttempts: z.number().optional(),
    // Read-only is the default; set false to permit write SQL via /query.
    readOnly: z.boolean().optional(),
    // C6 external-write target marker. When set, raw /query is disabled even if readOnly=false.
    c6WriteTarget: z.boolean().optional(),
    genericQueryDisabled: z.boolean().optional()
  }).optional(),
  credentials: z.object({
    username: z.string().optional(),
    password: z.string().optional(),
    apiKey: z.string().optional(),
    token: z.string().optional()
  }).optional(),
  poolConfig: z.object({
    min: z.number().min(0).optional(),
    max: z.number().min(1).optional(),
    idleTimeout: z.number().optional(),
    acquireTimeout: z.number().optional()
  }).optional()
})

const DataSourceUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  connection: ConnectionConfigSchema.optional(),
  options: z.object({
    autoConnect: z.boolean().optional(),
    timeout: z.number().optional(),
    retryAttempts: z.number().optional(),
    // Read-only is the default; set false to permit write SQL via /query.
    readOnly: z.boolean().optional(),
    // C6 external-write target marker. When set, raw /query is disabled even if readOnly=false.
    c6WriteTarget: z.boolean().optional(),
    genericQueryDisabled: z.boolean().optional()
  }).optional(),
  poolConfig: z.object({
    min: z.number().min(0).optional(),
    max: z.number().min(1).optional(),
    idleTimeout: z.number().optional(),
    acquireTimeout: z.number().optional()
  }).optional()
})

const DataSourceCredentialsUpdateSchema = z.object({
  credentials: z.object({
    username: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
    token: z.string().min(1).optional()
  }).strict()
}).strict()

const QuerySchema = z.object({
  sql: z.string().min(1, 'SQL query is required'),
  params: z.array(z.unknown()).optional()
})

const SelectSchema = z.object({
  table: z.string().min(1, 'Table name is required'),
  select: z.array(z.string()).optional(),
  where: z.record(z.unknown()).optional(),
  orderBy: z.array(z.object({
    column: z.string(),
    direction: z.enum(['asc', 'desc'])
  })).optional(),
  limit: z.number().int().min(1).max(DATA_SOURCE_MAX_ROWS).optional(),
  offset: z.number().int().min(0).optional()
})

// Singleton instance (can be replaced with dependency injection)
let dataSourceManager: DataSourceManager | null = null

function getManager(): DataSourceManager {
  if (!dataSourceManager) {
    dataSourceManager = new DataSourceManager()
  }
  return dataSourceManager
}

export function getDataSourceManager(): DataSourceManager {
  return getManager()
}

/**
 * Bind the shared DataSourceManager singleton to the database and load
 * persisted sources (A0). Call once at startup; route handlers then see a
 * db-backed manager via getManager().
 */
export async function initializeDataSourceManager<DB>(db: Kysely<DB>): Promise<DataSourceManager> {
  const manager = getManager()
  // DataSourceManager is schema-agnostic (Kysely<unknown>); erase the concrete
  // Database schema type at this boundary (Kysely is invariant in its schema).
  await manager.initialize(db as unknown as Kysely<unknown>)
  return manager
}

/**
 * Resolve the authenticated user id for ownership scoping (A0.1).
 * Precedence matches correlation.ts: id, then userId, then sub.
 */
function resolveUserId(req: Request): string | undefined {
  const u = req.user
  if (!u) return undefined
  const raw = u.id ?? u.userId ?? u.sub
  return raw != null ? String(raw) : undefined
}

/**
 * Conservative read-only SQL classifier for the raw /query path on read-only
 * SQL sources. Allows a single statement starting with SELECT / WITH / EXPLAIN
 * / SHOW; rejects multiple statements and SELECT ... INTO.
 *
 * Best-effort application-layer gate, NOT a sandbox: it does NOT catch
 * data-modifying CTEs (e.g. WITH t AS (DELETE ... RETURNING) SELECT ...) and
 * over-rejects a query led by a comment. The real read-only guarantee must
 * come from connecting the data source with a read-only database account.
 */
export function isReadOnlySql(raw: string): boolean {
  const sql = raw.trim().replace(/;\s*$/, '') // drop a single trailing semicolon
  if (sql.includes(';')) return false // no multiple statements
  if (/\binto\b/i.test(sql)) return false // reject SELECT ... INTO
  return /^\s*(select|with|explain|show)\b/i.test(sql)
}

// Helper to sanitize config for response (remove credentials)
function sanitizeConfig(config: DataSourceConfig): Omit<DataSourceConfig, 'credentials'> & { hasCredentials: boolean } {
  const { credentials, ...rest } = config
  return {
    ...rest,
    hasCredentials: !!credentials && Object.keys(credentials).length > 0
  }
}

export function dataSourcesRouter(): Router {
  const router = Router()

  /**
   * GET /api/data-sources
   * List all configured data sources
   */
  router.get('/api/data-sources', rbacGuard('data_sources', 'read'), async (req: Request, res: Response) => {
    try {
      const userId = resolveUserId(req)
      if (!userId) {
        return res.status(401).json({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Authentication required' }
        })
      }
      const manager = getManager()
      const sources = manager.listDataSources({ ownerId: userId })
      return res.json({
        ok: true,
        data: {
          items: sources,
          total: sources.length
        }
      })
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Failed to list data sources'
        }
      })
    }
  })

  /**
   * GET /api/data-sources/health
   * Get health status of the caller's data sources
   *
   * Keep this route before /api/data-sources/:id. Otherwise Express treats
   * "health" as a data-source id and the endpoint becomes unreachable.
   */
  router.get('/api/data-sources/health', rbacGuard('data_sources', 'read'), async (req: Request, res: Response) => {
    try {
      const userId = resolveUserId(req)
      if (!userId) {
        return res.status(401).json({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Authentication required' }
        })
      }

      const manager = getManager()
      const healthMap = await manager.healthCheck({ ownerId: userId })

      const health: Array<{
        id: string
        connected: boolean
        responsive: boolean
        latency?: number
      }> = []

      healthMap.forEach((status, id) => {
        health.push({ id, ...status })
      })

      return res.json({
        ok: true,
        data: {
          items: health,
          timestamp: new Date().toISOString()
        }
      })
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Health check failed'
        }
      })
    }
  })

  /**
   * GET /api/data-sources/:id
   * Get details of a specific data source
   */
  router.get('/api/data-sources/:id', rbacGuard('data_sources', 'read'), async (req: Request, res: Response) => {
    try {
      const manager = getManager()
      manager.assertAccess(req.params.id, resolveUserId(req))
      const adapter = manager.getDataSource(req.params.id)
      const config = adapter.getConfig()

      return res.json({
        ok: true,
        data: {
          ...sanitizeConfig(config),
          connected: adapter.isConnected()
        }
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        return res.status(404).json({
          ok: false,
          error: { code: 'NOT_FOUND', message: `Data source '${req.params.id}' not found` }
        })
      }
      return res.status(500).json({
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Failed to get data source'
        }
      })
    }
  })

  /**
   * POST /api/data-sources
   * Create a new data source configuration
   */
  router.post('/api/data-sources', rbacGuard('data_sources', 'write'), async (req: Request, res: Response) => {
    const parse = DataSourceCreateSchema.safeParse(req.body)
    if (!parse.success) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: parse.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ')
        }
      })
    }

    try {
      const userId = resolveUserId(req)
      if (!userId) {
        return res.status(401).json({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Authentication required' }
        })
      }
      const manager = getManager()
      const config = parse.data as DataSourceConfig
      // A0.1: own the source; workspace_id stays null (no clean workspace
      // context on req — workspace-shared access is a follow-up).
      const adapter = await manager.addDataSource(config, { ownerId: userId })

      await auditLog({
        actorId: req.user?.id?.toString(),
        actorType: 'user',
        action: 'create',
        resourceType: 'data_source',
        resourceId: config.id,
        meta: { name: config.name, type: config.type }
      })

      return res.status(201).json({
        ok: true,
        data: {
          ...sanitizeConfig(config),
          connected: adapter.isConnected()
        }
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('already exists')) {
        return res.status(409).json({
          ok: false,
          error: { code: 'CONFLICT', message: error.message }
        })
      }
      return res.status(500).json({
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Failed to create data source'
        }
      })
    }
  })

  /**
   * PUT /api/data-sources/:id
   * Update data source configuration (requires reconnect)
   */
  router.put('/api/data-sources/:id', rbacGuard('data_sources', 'write'), async (req: Request, res: Response) => {
    const parse = DataSourceUpdateSchema.safeParse(req.body)
    if (!parse.success) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: parse.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ')
        }
      })
    }

    try {
      const manager = getManager()
      const id = req.params.id
      manager.assertAccess(id, resolveUserId(req))

      const existing = manager.getDataSource(id)
      const oldConfig = existing.getConfig()
      const scope = manager.getScope(id)

      const newConfig: DataSourceConfig = {
        ...oldConfig,
        ...parse.data,
        // Deep-merge nested config: a partial update must NOT wipe sibling keys. For `connection`
        // this is security-sensitive — an edit UI that re-sends connection with only {host,port,
        // database} would otherwise drop encrypt / trustServerCertificate / tlsMinVersion / tlsCiphers
        // / legacyTls / timeouts (weakening cert validation or breaking legacy TLS). Removing a
        // connection key requires an explicit delete, not a partial PUT.
        connection: { ...oldConfig.connection, ...parse.data.connection },
        options: { ...oldConfig.options, ...parse.data.options },
        poolConfig: { ...oldConfig.poolConfig, ...parse.data.poolConfig },
        id // Preserve original ID
      }

      // Atomic update: persists first, swaps the adapter only on success, and
      // preserves ownership. A failed update leaves the original source intact.
      const adapter = await manager.updateDataSource(id, newConfig, {
        ownerId: scope?.ownerId ?? resolveUserId(req)!,
        workspaceId: scope?.workspaceId ?? undefined
      })

      await auditLog({
        actorId: req.user?.id?.toString(),
        actorType: 'user',
        action: 'update',
        resourceType: 'data_source',
        resourceId: id,
        meta: {
          before: sanitizeConfig(oldConfig),
          after: sanitizeConfig(newConfig)
        }
      })

      return res.json({
        ok: true,
        data: {
          ...sanitizeConfig(newConfig),
          connected: adapter.isConnected()
        }
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        return res.status(404).json({
          ok: false,
          error: { code: 'NOT_FOUND', message: `Data source '${req.params.id}' not found` }
        })
      }
      return res.status(500).json({
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Failed to update data source'
        }
      })
    }
  })

  /**
   * PUT /api/data-sources/:id/credentials
   * Rotate write-only credentials. Non-secret config updates stay on PUT /:id.
   */
  router.put('/api/data-sources/:id/credentials', rbacGuard('data_sources', 'write'), async (req: Request, res: Response) => {
    const parse = DataSourceCredentialsUpdateSchema.safeParse(req.body)
    if (!parse.success) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: parse.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ')
        }
      })
    }
    const changedCredentialKeys = Object.keys(parse.data.credentials)
    if (changedCredentialKeys.length === 0) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'credentials: at least one credential field is required'
        }
      })
    }

    try {
      const manager = getManager()
      const id = req.params.id
      manager.assertAccess(id, resolveUserId(req))

      const existing = manager.getDataSource(id)
      const oldConfig = existing.getConfig()
      const scope = manager.getScope(id)

      const newConfig: DataSourceConfig = {
        ...oldConfig,
        credentials: {
          ...oldConfig.credentials,
          ...parse.data.credentials
        },
        id
      }

      const adapter = await manager.updateDataSource(id, newConfig, {
        ownerId: scope?.ownerId ?? resolveUserId(req)!,
        workspaceId: scope?.workspaceId ?? undefined
      })

      await auditLog({
        actorId: req.user?.id?.toString(),
        actorType: 'user',
        action: 'update_credentials',
        resourceType: 'data_source',
        resourceId: id,
        meta: {
          changedCredentialKeys,
          before: sanitizeConfig(oldConfig),
          after: sanitizeConfig(newConfig)
        }
      })

      return res.json({
        ok: true,
        data: {
          ...sanitizeConfig(newConfig),
          connected: adapter.isConnected()
        }
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        return res.status(404).json({
          ok: false,
          error: { code: 'NOT_FOUND', message: `Data source '${req.params.id}' not found` }
        })
      }
      return res.status(500).json({
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Failed to update data source credentials'
        }
      })
    }
  })

  /**
   * DELETE /api/data-sources/:id
   * Remove a data source configuration
   */
  router.delete('/api/data-sources/:id', rbacGuard('data_sources', 'write'), async (req: Request, res: Response) => {
    try {
      const manager = getManager()
      const id = req.params.id
      manager.assertAccess(id, resolveUserId(req))

      // Get config before removal for audit
      const adapter = manager.getDataSource(id)
      const config = adapter.getConfig()

      await manager.removeDataSource(id)

      await auditLog({
        actorId: req.user?.id?.toString(),
        actorType: 'user',
        action: 'delete',
        resourceType: 'data_source',
        resourceId: id,
        meta: sanitizeConfig(config)
      })

      return res.json({
        ok: true,
        data: { id, removed: true }
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        return res.status(404).json({
          ok: false,
          error: { code: 'NOT_FOUND', message: `Data source '${req.params.id}' not found` }
        })
      }
      return res.status(500).json({
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Failed to remove data source'
        }
      })
    }
  })

  /**
   * POST /api/data-sources/:id/connect
   * Establish connection to data source
   */
  router.post('/api/data-sources/:id/connect', rbacGuard('data_sources', 'write'), async (req: Request, res: Response) => {
    try {
      const manager = getManager()
      const id = req.params.id
      manager.assertAccess(id, resolveUserId(req))

      await manager.connectDataSource(id)
      const adapter = manager.getDataSource(id)

      return res.json({
        ok: true,
        data: {
          id,
          connected: adapter.isConnected()
        }
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        return res.status(404).json({
          ok: false,
          error: { code: 'NOT_FOUND', message: `Data source '${req.params.id}' not found` }
        })
      }
      return res.status(500).json({
        ok: false,
        error: {
          code: 'CONNECTION_ERROR',
          message: error instanceof Error ? error.message : 'Failed to connect'
        }
      })
    }
  })

  /**
   * POST /api/data-sources/:id/disconnect
   * Close connection to data source
   */
  router.post('/api/data-sources/:id/disconnect', rbacGuard('data_sources', 'write'), async (req: Request, res: Response) => {
    try {
      const manager = getManager()
      const id = req.params.id
      manager.assertAccess(id, resolveUserId(req))

      await manager.disconnectDataSource(id)

      return res.json({
        ok: true,
        data: { id, connected: false }
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        return res.status(404).json({
          ok: false,
          error: { code: 'NOT_FOUND', message: `Data source '${req.params.id}' not found` }
        })
      }
      return res.status(500).json({
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Failed to disconnect'
        }
      })
    }
  })

  /**
   * GET /api/data-sources/:id/test
   * Test connection to data source
   */
  router.get('/api/data-sources/:id/test', rbacGuard('data_sources', 'read'), async (req: Request, res: Response) => {
    try {
      const manager = getManager()
      const id = req.params.id
      manager.assertAccess(id, resolveUserId(req))
      const startTime = Date.now()

      const result = await manager.testConnection(id)
      const latency = Date.now() - startTime

      // A3: keep request-layer ok:true (a completed test is a successful request); the connection
      // outcome is data.success, with a redacted cause in data.error.message on failure.
      return res.json({
        ok: true,
        data: {
          id,
          success: result.success,
          latency: `${latency}ms`,
          ...(result.error ? { error: { message: result.error } } : {})
        }
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        return res.status(404).json({
          ok: false,
          error: { code: 'NOT_FOUND', message: `Data source '${req.params.id}' not found` }
        })
      }
      return res.status(500).json({
        ok: false,
        error: {
          code: 'TEST_FAILED',
          message: error instanceof Error ? error.message : 'Connection test failed'
        }
      })
    }
  })

  /**
   * POST /api/data-sources/:id/query
   * Execute raw SQL query (with caution)
   */
  router.post('/api/data-sources/:id/query', rbacGuard('data_sources', 'execute'), async (req: Request, res: Response) => {
    const parse = QuerySchema.safeParse(req.body)
    if (!parse.success) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: parse.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ')
        }
      })
    }

    try {
      const manager = getManager()
      manager.assertAccess(req.params.id, resolveUserId(req))
      const { sql, params } = parse.data

      // A-RO: enforce read-only at the raw query path. SQL sources get a
      // SELECT-only classifier; non-SQL sources have the raw path disabled
      // entirely when read-only (a SQL classifier doesn't apply to them).
      const adapter = manager.getDataSource(req.params.id)
      if (isGenericQueryDisabledConfig(adapter.getConfig())) {
        return res.status(403).json({
          ok: false,
          error: {
            code: DATA_SOURCE_C6_WRITE_TARGET_QUERY_DISABLED_CODE,
            message: c6WriteTargetQueryDisabledMessage(req.params.id)
          }
        })
      }
      if (adapter.isReadOnly()) {
        if (!adapter.isSqlDialect()) {
          return res.status(403).json({
            ok: false,
            error: { code: 'READ_ONLY', message: 'Data source is read-only; the raw query endpoint is disabled for non-SQL sources' }
          })
        }
        if (!isReadOnlySql(sql)) {
          return res.status(403).json({
            ok: false,
            error: { code: 'READ_ONLY', message: 'Data source is read-only; only read-only SQL (SELECT/WITH/EXPLAIN/SHOW) is permitted' }
          })
        }
      }

      const result = await manager.query(req.params.id, sql, params as (string | number | boolean | null | Date | Buffer)[])

      // A5: raw /query runs arbitrary SQL, so it cannot be safely auto-bounded (rewriting SQL is
      // unsafe; rejecting no-LIMIT would break legitimately WHERE-bounded queries). It is therefore
      // a non-large-export channel — surface a best-effort warning + audit annotation when no
      // row-COUNT limiter is present, so a caller does not unknowingly pull an unbounded set.
      // Only LIMIT / TOP / FETCH actually cap the row count; a bare OFFSET only SKIPS rows and still
      // returns the rest of the table, so it must NOT count as a bound. Use /select (hard-capped at
      // DATA_SOURCE_MAX_ROWS) for bounded structured reads.
      const unbounded = !/\b(?:LIMIT|TOP|FETCH)\b/i.test(sql)
      const warning = unbounded
        ? `Query has no row-count limit (LIMIT/TOP/FETCH); raw /query is not a large-table export channel — add an explicit row bound (a bare OFFSET does not cap rows), or use /select (capped at ${DATA_SOURCE_MAX_ROWS} rows).`
        : undefined

      await auditLog({
        actorId: req.user?.id?.toString(),
        actorType: 'user',
        action: 'query',
        resourceType: 'data_source',
        resourceId: req.params.id,
        meta: { sql: sql.substring(0, 200), rowCount: result.data.length, ...(unbounded ? { unbounded: true } : {}) }
      })

      return res.json({
        ok: true,
        data: result,
        ...(warning ? { warning } : {})
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        return res.status(404).json({
          ok: false,
          error: { code: 'NOT_FOUND', message: `Data source '${req.params.id}' not found` }
        })
      }
      return res.status(500).json({
        ok: false,
        error: {
          code: 'QUERY_ERROR',
          message: error instanceof Error ? error.message : 'Query execution failed'
        }
      })
    }
  })

  /**
   * POST /api/data-sources/:id/select
   * Execute a select query with builder options
   */
  router.post('/api/data-sources/:id/select', rbacGuard('data_sources', 'read'), async (req: Request, res: Response) => {
    const parse = SelectSchema.safeParse(req.body)
    if (!parse.success) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: parse.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ')
        }
      })
    }

    try {
      const manager = getManager()
      manager.assertAccess(req.params.id, resolveUserId(req))
      const { table, ...options } = parse.data

      // A5: apply the friendly default row limit at the API entry when the caller omits one, so a
      // bare /select never pulls an unbounded result set. over-max is already rejected 400 by
      // SelectSchema (max DATA_SOURCE_MAX_ROWS); the adapter still enforces the hard ceiling as a
      // defense-in-depth backstop for callers that bypass this route.
      if (options.limit === undefined) {
        options.limit = DATA_SOURCE_DEFAULT_LIMIT
      }

      // Cast options to proper QueryOptions type
      const result = await manager.select(req.params.id, table, options as QueryOptions)

      return res.json({
        ok: true,
        data: result
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        return res.status(404).json({
          ok: false,
          error: { code: 'NOT_FOUND', message: `Data source '${req.params.id}' not found` }
        })
      }
      return res.status(500).json({
        ok: false,
        error: {
          code: 'SELECT_ERROR',
          message: error instanceof Error ? error.message : 'Select query failed'
        }
      })
    }
  })

  /**
   * GET /api/data-sources/:id/schema
   * Get schema information from data source
   */
  router.get('/api/data-sources/:id/schema', rbacGuard('data_sources', 'read'), async (req: Request, res: Response) => {
    try {
      const manager = getManager()
      manager.assertAccess(req.params.id, resolveUserId(req))
      const adapter = manager.getDataSource(req.params.id)

      if (!adapter.isConnected()) {
        await manager.connectDataSource(req.params.id)
      }

      const schema = await adapter.getSchema(req.query.schema as string | undefined)

      return res.json({
        ok: true,
        data: schema
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        return res.status(404).json({
          ok: false,
          error: { code: 'NOT_FOUND', message: `Data source '${req.params.id}' not found` }
        })
      }
      return res.status(500).json({
        ok: false,
        error: {
          code: 'SCHEMA_ERROR',
          message: error instanceof Error ? error.message : 'Failed to get schema'
        }
      })
    }
  })

  /**
   * GET /api/data-sources/:id/tables/:table
   * Get table information from data source
   */
  router.get('/api/data-sources/:id/tables/:table', rbacGuard('data_sources', 'read'), async (req: Request, res: Response) => {
    try {
      const manager = getManager()
      manager.assertAccess(req.params.id, resolveUserId(req))
      const adapter = manager.getDataSource(req.params.id)

      if (!adapter.isConnected()) {
        await manager.connectDataSource(req.params.id)
      }

      const tableInfo = await adapter.getTableInfo(req.params.table, req.query.schema as string | undefined)

      return res.json({
        ok: true,
        data: tableInfo
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        return res.status(404).json({
          ok: false,
          error: { code: 'NOT_FOUND', message: error.message }
        })
      }
      return res.status(500).json({
        ok: false,
        error: {
          code: 'TABLE_INFO_ERROR',
          message: error instanceof Error ? error.message : 'Failed to get table info'
        }
      })
    }
  })

  return router
}

// Export for testing and direct usage
export { getManager, dataSourceManager }
