/**
 * Data Sources REST API Routes
 *
 * Provides API endpoints for managing external data source connections
 * including PostgreSQL, MySQL, MongoDB, HTTP/REST APIs, etc.
 *
 * V2 Features:
 * - Zod schema validation for all requests
 * - Support for connection pooling and health checks
 * - Secure credential handling (never exposed in responses)
 */

import type { Request, Response } from 'express'
import { Router } from 'express'
import { z } from 'zod'
import { rbacGuard } from '../rbac/rbac'
import { auditLog } from '../audit/audit'
import { DataSourceManager } from '../data-adapters/DataSourceManager'
import type { DataSourceConfig, QueryOptions } from '../data-adapters/BaseAdapter'

// Zod schemas for request validation
const ConnectionConfigSchema = z.record(z.union([z.string(), z.number(), z.boolean()]))

const DataSourceCreateSchema = z.object({
  id: z.string().min(1, 'ID is required'),
  name: z.string().min(1, 'Name is required'),
  type: z.enum(['postgresql', 'postgres', 'mysql', 'mongodb', 'http', 'redis', 'elasticsearch'], {
    errorMap: () => ({ message: 'Unsupported data source type' })
  }),
  connection: ConnectionConfigSchema,
  options: z.object({
    autoConnect: z.boolean().optional(),
    timeout: z.number().optional(),
    retryAttempts: z.number().optional()
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
    retryAttempts: z.number().optional()
  }).optional(),
  poolConfig: z.object({
    min: z.number().min(0).optional(),
    max: z.number().min(1).optional(),
    idleTimeout: z.number().optional(),
    acquireTimeout: z.number().optional()
  }).optional()
})

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
  limit: z.number().min(1).max(10000).optional(),
  offset: z.number().min(0).optional()
})

// Singleton instance (can be replaced with dependency injection)
let dataSourceManager: DataSourceManager | null = null

function getManager(): DataSourceManager {
  if (!dataSourceManager) {
    dataSourceManager = new DataSourceManager()
  }
  return dataSourceManager
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
  router.get('/api/data-sources', rbacGuard('data_sources', 'read'), async (_req: Request, res: Response) => {
    try {
      const manager = getManager()
      const sources = manager.listDataSources()
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
   * GET /api/data-sources/:id
   * Get details of a specific data source
   */
  router.get('/api/data-sources/:id', rbacGuard('data_sources', 'read'), async (req: Request, res: Response) => {
    try {
      const manager = getManager()
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
      const manager = getManager()
      const config = parse.data as DataSourceConfig
      const adapter = await manager.addDataSource(config)

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

      // Get existing config
      const existing = manager.getDataSource(id)
      const oldConfig = existing.getConfig()

      // Remove and re-add with updated config
      await manager.removeDataSource(id)

      const newConfig: DataSourceConfig = {
        ...oldConfig,
        ...parse.data,
        id // Preserve original ID
      }

      const adapter = await manager.addDataSource(newConfig)

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
   * DELETE /api/data-sources/:id
   * Remove a data source configuration
   */
  router.delete('/api/data-sources/:id', rbacGuard('data_sources', 'write'), async (req: Request, res: Response) => {
    try {
      const manager = getManager()
      const id = req.params.id

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
      const startTime = Date.now()

      const success = await manager.testConnection(id)
      const latency = Date.now() - startTime

      return res.json({
        ok: true,
        data: {
          id,
          success,
          latency: `${latency}ms`
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
   * GET /api/data-sources/health
   * Get health status of all data sources
   */
  router.get('/api/data-sources/health', rbacGuard('data_sources', 'read'), async (_req: Request, res: Response) => {
    try {
      const manager = getManager()
      const healthMap = await manager.healthCheck()

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
      const { sql, params } = parse.data

      const result = await manager.query(req.params.id, sql, params as (string | number | boolean | null | Date | Buffer)[])

      await auditLog({
        actorId: req.user?.id?.toString(),
        actorType: 'user',
        action: 'query',
        resourceType: 'data_source',
        resourceId: req.params.id,
        meta: { sql: sql.substring(0, 200), rowCount: result.data.length }
      })

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
      const { table, ...options } = parse.data

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
