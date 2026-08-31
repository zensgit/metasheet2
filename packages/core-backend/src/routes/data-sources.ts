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
  DATA_SOURCE_FORCE_DELETE_ADMIN_ONLY_CODE,
  DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS_CODE,
  DataSourceManager,
  isGenericQueryDisabledConfig,
  SUPPORTED_DATA_SOURCE_TYPES
} from '../data-adapters/DataSourceManager'
import type { DataSourceActorContext } from '../data-adapters/DataSourceManager'
import type { DataSourceConfig, QueryOptions } from '../data-adapters/BaseAdapter'
import {
  attemptsToClearK3Marker,
  K3_DESTINATION_MARKER_IMMUTABLE,
  K3_DESTINATION_MARKER_IMMUTABLE_MESSAGE,
} from '../data-adapters/k3-destination-write-fence'
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
    genericQueryDisabled: z.boolean().optional(),
    // G-4 DESTINATION MARKER. A durable, positive attestation that this source's destination IS the
    // customer K3 database. When true, DataSourceManager refuses EVERY write to it permanently
    // (insert/update/delete/copyData/raw query), no flag can re-enable it. This schema strips unknown
    // option keys, so the marker must be declared here to be settable and to survive persistence;
    // it can only ever make a source MORE restricted (a K3 write is banned by G-4), never less.
    k3Destination: z.boolean().optional(),
    // PLMAdapter runtime options for persisted Yuantus PLM sources.
    apiMode: z.string().optional(),
    tenantId: z.string().optional(),
    orgId: z.string().optional(),
    itemType: z.string().optional()
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
}).superRefine((data, ctx) => {
  // sqlserver: MSSQLAdapter.resolveServerAndPort() already requires connection.host OR
  // connection.server and throws a clear error if both are absent — but only at connect() time.
  // POST /api/data-sources never auto-connects (addDataSource always calls
  // addDataSourceInternal(config, false), regardless of options.autoConnect), so a config missing
  // both today persists successfully and only fails the first time something actually connects
  // (next /select, /query, /test, or a server restart replaying persisted sources). Reject it here
  // instead — this cannot reject any config that would otherwise have worked: it is EXACTLY the
  // adapter's own requirement, just checked earlier.
  if (data.type === 'sqlserver') {
    const host = data.connection?.host
    const server = data.connection?.server
    const hasHost = typeof host === 'string' && host.trim().length > 0
    const hasServer = typeof server === 'string' && server.trim().length > 0
    if (!hasHost && !hasServer) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['connection', 'host'],
        message: 'connection.host (or connection.server) is required for a sqlserver data source'
      })
    }
  }
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
    genericQueryDisabled: z.boolean().optional(),
    // G-4 DESTINATION MARKER. A durable, positive attestation that this source's destination IS the
    // customer K3 database. When true, DataSourceManager refuses EVERY write to it permanently
    // (insert/update/delete/copyData/raw query), no flag can re-enable it. This schema strips unknown
    // option keys, so the marker must be declared here to be settable and to survive persistence;
    // it can only ever make a source MORE restricted (a K3 write is banned by G-4), never less.
    k3Destination: z.boolean().optional(),
    // PLMAdapter runtime options for persisted Yuantus PLM sources.
    apiMode: z.string().optional(),
    tenantId: z.string().optional(),
    orgId: z.string().optional(),
    itemType: z.string().optional()
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
 * Resolve the MANAGEMENT actor for this request (the authority model).
 *
 * `platformAdmin` mirrors the rbac global-admin bypass's request-user check
 * (rbac.ts requestUserIsAdmin: role === 'admin' or roles includes 'admin') —
 * the exact tier that already passes every `data_sources:*` rbacGuard on
 * these routes without a table lookup. jwtAuthMiddleware refreshes role data
 * per request, so req.user is the authoritative in-request source. A DB-role
 * admin whose token lacks the admin claim does NOT get the management bypass
 * here (conservative direction: no extra grants beyond the request's claims).
 *
 * Used on MANAGEMENT surfaces only (list/get/test/connect/disconnect/update/
 * rotate/delete). Data-plane routes (/query /select /schema /tables) keep
 * passing the bare user id, which the manager scopes owner-only: management
 * of a connection is not silent access to the customer data behind it.
 */
function resolveActor(req: Request): DataSourceActorContext {
  const u = req.user
  const roles = Array.isArray(u?.roles) ? u.roles.map((r) => String(r ?? '').trim()) : []
  return {
    userId: resolveUserId(req),
    platformAdmin: !!u && (u.role === 'admin' || roles.includes('admin'))
  }
}

/** True when a platform admin is acting on a source owned by someone else. */
function isCrossOwnerAdminAction(actor: DataSourceActorContext, ownerId: string | undefined): boolean {
  return actor.platformAdmin === true && ownerId !== undefined && ownerId !== actor.userId
}

/**
 * Audit a platform admin's action on ANOTHER owner's source (actor + owner,
 * values-free). Owner self-service paths intentionally emit nothing extra
 * here — their audit behavior is unchanged.
 */
async function auditCrossOwnerAdminAction(
  req: Request,
  action: string,
  resourceId: string,
  ownerId: string | undefined,
  extraMeta?: Record<string, unknown>
): Promise<void> {
  await auditLog({
    actorId: req.user?.id?.toString(),
    actorType: 'user',
    action,
    resourceType: 'data_source',
    resourceId,
    meta: { ownerId, crossOwnerAdmin: true, ...extraMeta }
  })
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
      // Authority model: owners see their own sources; platform admins see
      // every source (management metadata only — never credentials).
      const sources = manager.listDataSources({ actor: resolveActor(req) })
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
      // Same actor scoping as the listing: owners see their own, admins see all.
      const healthMap = await manager.healthCheck({ actor: resolveActor(req) })

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
      const actor = resolveActor(req)
      manager.assertAccess(req.params.id, actor)
      const adapter = manager.getDataSource(req.params.id)
      const config = adapter.getConfig()
      const ownerId = manager.getScope(req.params.id)?.ownerId

      if (isCrossOwnerAdminAction(actor, ownerId)) {
        await auditCrossOwnerAdminAction(req, 'read', req.params.id, ownerId)
      }

      return res.json({
        ok: true,
        data: {
          ...sanitizeConfig(config),
          ownerId,
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
   * POST /api/data-sources/test
   * test-before-save (design-lock 2026-06-17): ephemeral connection test for the create /
   * credential-rotation form. Accepts the create-payload shape, runs a transient connection test
   * via DataSourceManager.testEphemeralConnection (persists nothing, registers nothing), and returns
   * a RESULT-ONLY body — it never echoes back the submitted config / connection / credentials.
   * rbac `write`: supplying arbitrary connection params + actively dialing out is a write-tier
   * capability (matches create, and narrows the caller set vs `read`).
   * Route placement: `/test` is single-segment and there is no bare `POST /:id`, so it cannot collide
   * with the two-segment `/:id/*` routes; it is grouped with create for clarity.
   */
  router.post('/api/data-sources/test', rbacGuard('data_sources', 'write'), async (req: Request, res: Response) => {
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
      const result = await manager.testEphemeralConnection(config)
      // Audit the dial-out attempt (values-free: id/name/type + outcome only — never connection/creds).
      // This is a write-tier capability that connects to an arbitrary host, so it leaves a probe trail.
      await auditLog({
        actorId: req.user?.id?.toString(),
        actorType: 'user',
        action: 'test',
        resourceType: 'data_source',
        resourceId: config.id,
        meta: { name: config.name, type: config.type, success: result.success },
      })
      // RESULT-ONLY surface (design-lock 钉子②): success / latency / redacted error — NEVER echo the
      // submitted config, connection, or credentials back to the caller.
      return res.json({
        ok: true,
        data: {
          success: result.success,
          ...(typeof result.latency === 'number' ? { latency: `${result.latency}ms` } : {}),
          ...(result.error ? { error: { message: result.error } } : {})
        }
      })
    } catch (error) {
      // Defensive: the Zod enum rejects unknown types with a 400 before the helper runs; this maps the
      // helper's "unsupported type" throw (a registered type with no adapter) to 400 too, not a 500.
      if (error instanceof Error && error.message.toLowerCase().includes('unsupported data source type')) {
        return res.status(400).json({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: error.message }
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
      const actor = resolveActor(req)
      manager.assertAccess(id, actor)

      const existing = manager.getDataSource(id)
      const oldConfig = existing.getConfig()
      const scope = manager.getScope(id)

      // G-4 MARKER DURABILITY (P1). The k3Destination marker is set-once: a config edit may not clear
      // or unset it. This is the #5401 config-edit vector — {options:{k3Destination:false}} would
      // deep-merge and silently drop the marker, contradicting the non-overridable guarantee. Refuse
      // with a coded error (the manager also force-preserves it as a belt-and-suspenders net).
      if (attemptsToClearK3Marker(oldConfig.options, parse.data.options)) {
        return res.status(403).json({
          ok: false,
          error: { code: K3_DESTINATION_MARKER_IMMUTABLE, message: K3_DESTINATION_MARKER_IMMUTABLE_MESSAGE }
        })
      }

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
      // preserves ownership — an admin editing another owner's source must
      // NOT become its owner. A failed update leaves the original intact.
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
          ownerId: scope?.ownerId,
          ...(isCrossOwnerAdminAction(actor, scope?.ownerId) ? { crossOwnerAdmin: true } : {}),
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
      const actor = resolveActor(req)
      manager.assertAccess(id, actor)

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

      // Rotation stays WRITE-ONLY for every tier: an admin can set new
      // credentials but no response surface ever returns credential values.
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
          ownerId: scope?.ownerId,
          ...(isCrossOwnerAdminAction(actor, scope?.ownerId) ? { crossOwnerAdmin: true } : {}),
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
   * Remove a data source configuration.
   *
   * Referential guard: a source referenced by any
   * integration_external_systems.config->>'dataSourceId' refuses deletion
   * with a coded 409 naming the reference COUNT (never the referencing
   * config), so an external system's binding cannot be silently dangled.
   * `?force=true` (platform-admin only) breaks the reference deliberately
   * and is audited as such. The check is server-side, before removal.
   */
  router.delete('/api/data-sources/:id', rbacGuard('data_sources', 'write'), async (req: Request, res: Response) => {
    try {
      const manager = getManager()
      const id = req.params.id
      const actor = resolveActor(req)
      // Access first: a non-owner non-admin gets the uniform 404 before any
      // referential detail (force=true included) can leak existence.
      manager.assertAccess(id, actor)

      // Get config before removal for audit
      const adapter = manager.getDataSource(id)
      const config = adapter.getConfig()
      const ownerId = manager.getScope(id)?.ownerId

      const referenceCount = await manager.countExternalSystemReferences(id)
      const forceRequested = String(req.query.force ?? '') === 'true'
      const forcedReferenceBreak = referenceCount > 0 && forceRequested
      if (referenceCount > 0) {
        if (forceRequested && actor.platformAdmin !== true) {
          return res.status(403).json({
            ok: false,
            error: {
              code: DATA_SOURCE_FORCE_DELETE_ADMIN_ONLY_CODE,
              message: `force=true is restricted to platform admins; data source '${id}' remains referenced by ${referenceCount} external system(s)`
            }
          })
        }
        if (!forceRequested) {
          return res.status(409).json({
            ok: false,
            error: {
              code: DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS_CODE,
              message: `Data source '${id}' is referenced by ${referenceCount} external system(s) (integration_external_systems.config.dataSourceId) and deleting it would leave dangling references. A platform admin may repeat the request with force=true to break the reference deliberately.`,
              details: { referenceCount }
            }
          })
        }
      }

      await manager.removeDataSource(id)

      await auditLog({
        actorId: req.user?.id?.toString(),
        actorType: 'user',
        action: 'delete',
        resourceType: 'data_source',
        resourceId: id,
        meta: {
          ...sanitizeConfig(config),
          ownerId,
          ...(isCrossOwnerAdminAction(actor, ownerId) ? { crossOwnerAdmin: true } : {}),
          ...(forcedReferenceBreak ? { forcedReferenceBreak: true, referenceCount } : {})
        }
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
      const actor = resolveActor(req)
      manager.assertAccess(id, actor)

      const connectOwnerId = manager.getScope(id)?.ownerId
      if (isCrossOwnerAdminAction(actor, connectOwnerId)) {
        await auditCrossOwnerAdminAction(req, 'connect', id, connectOwnerId)
      }

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
      const actor = resolveActor(req)
      manager.assertAccess(id, actor)

      const disconnectOwnerId = manager.getScope(id)?.ownerId
      if (isCrossOwnerAdminAction(actor, disconnectOwnerId)) {
        await auditCrossOwnerAdminAction(req, 'disconnect', id, disconnectOwnerId)
      }

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
      const actor = resolveActor(req)
      manager.assertAccess(id, actor)
      const startTime = Date.now()

      const result = await manager.testConnection(id)
      const latency = Date.now() - startTime

      const testOwnerId = manager.getScope(id)?.ownerId
      if (isCrossOwnerAdminAction(actor, testOwnerId)) {
        await auditCrossOwnerAdminAction(req, 'test', id, testOwnerId, { success: result.success })
      }

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
      // DATA PLANE: deliberately the bare-user-id (owner-only) actor shape.
      // Managing a connection (test/fix/rotate/delete) is an admin capability;
      // reading the customer data BEHIND it is not — an admin gets the same
      // uniform 404 as any non-owner on /query, /select, /schema and /tables.
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
      // DATA PLANE: owner-only on purpose (see /query above).
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
      // DATA PLANE: owner-only on purpose (see /query above).
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
      // DATA PLANE: owner-only on purpose (see /query above).
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
