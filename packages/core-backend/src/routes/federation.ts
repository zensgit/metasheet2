/**
 * Federation Routes
 *
 * REST API endpoints for federated data operations across PLM, Athena, and MetaSheet.
 * Provides unified access to external systems with proper error handling and metrics.
 *
 * @see PROGRESSIVE_FEDERATION_PLAN.md Phase 5
 */

import type { Request, Response } from 'express'
import { Router } from 'express'
import type { Injector } from '@wendellhu/redi'
import { z } from 'zod'
import { rbacGuard } from '../rbac/rbac'
import { auditLog } from '../audit/audit'
import { IAthenaAdapter, IPLMAdapter, IConfigService } from '../di/identifiers'
import type { BOMItem as AdapterBOMItem, PLMProduct as AdapterPLMProduct } from '../data-adapters/PLMAdapter'
import type { AthenaDocument as AdapterAthenaDocument, DocumentVersion as AdapterDocumentVersion } from '../data-adapters/AthenaAdapter'
import {
  getAdapterMetrics,
  recordCrossSystemOperation,
  startCrossSystemTimer,
} from '../metrics/adapter-metrics'

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface FederatedSystem {
  id: string
  name: string
  type: 'plm' | 'athena' | 'metasheet'
  status: 'connected' | 'disconnected' | 'error'
  lastHealthCheck?: Date
  capabilities: string[]
  baseUrl?: string
  authType?: 'bearer' | 'oauth2' | 'apikey'
}

interface CrossSystemOperation {
  id: string
  flow: string
  sourceSystem: string
  targetSystem: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  startedAt: Date
  completedAt?: Date
  error?: string
}

// ─────────────────────────────────────────────────────────────
// In-memory state (would be persisted in production)
// ─────────────────────────────────────────────────────────────

const defaultPlmBaseUrl = process.env.PLM_BASE_URL || 'http://127.0.0.1:7910'
const defaultAthenaBaseUrl = process.env.ATHENA_BASE_URL || process.env.ATHENA_URL || 'http://localhost:8002'
const defaultAthenaAuthType: FederatedSystem['authType'] = (
  process.env.ATHENA_API_TOKEN ||
  process.env.ATHENA_AUTH_TOKEN ||
  process.env.ATHENA_TOKEN
) ? 'bearer' : 'oauth2'

const federatedSystems: Map<string, FederatedSystem> = new Map([
  ['metasheet', {
    id: 'metasheet',
    name: 'MetaSheet V2',
    type: 'metasheet',
    status: 'connected',
    capabilities: ['spreadsheet', 'collaboration', 'workflow', 'audit']
  }],
  ['plm', {
    id: 'plm',
    name: 'Yuantus PLM',
    type: 'plm',
    status: 'connected',
    capabilities: getDefaultCapabilities('plm'),
    baseUrl: defaultPlmBaseUrl,
    authType: 'bearer',
  }],
  ['athena', {
    id: 'athena',
    name: 'Athena ECM',
    type: 'athena',
    status: 'connected',
    capabilities: getDefaultCapabilities('athena'),
    baseUrl: defaultAthenaBaseUrl,
    authType: defaultAthenaAuthType,
  }],
])

const pendingOperations: Map<string, CrossSystemOperation> = new Map()

// ─────────────────────────────────────────────────────────────
// Zod Schemas
// ─────────────────────────────────────────────────────────────

const RegisterSystemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['plm', 'athena']),
  baseUrl: z.string().url(),
  credentials: z.object({
    type: z.enum(['bearer', 'oauth2', 'apikey']),
    token: z.string().optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    apiKey: z.string().optional(),
  }),
  capabilities: z.array(z.string()).optional(),
})

const UpdateSystemSchema = z.object({
  name: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  credentials: z.object({
    type: z.enum(['bearer', 'oauth2', 'apikey']),
    token: z.string().optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    apiKey: z.string().optional(),
  }).optional(),
  capabilities: z.array(z.string()).optional(),
  status: z.enum(['connected', 'disconnected', 'error']).optional(),
})

type FederatedCredentials = z.infer<typeof RegisterSystemSchema>['credentials']

const PLMQuerySchema = z.object({
  operation: z.enum([
    'products',
    'bom',
    'documents',
    'approvals',
    'bom_compare',
    'bom_compare_schema',
    'substitutes',
    'where_used',
    'cad_properties',
    'cad_view_state',
    'cad_review',
    'cad_history',
    'cad_diff',
    'cad_mesh_stats',
  ]),
  productId: z.string().optional(),
  itemId: z.string().optional(),
  bomLineId: z.string().optional(),
  fileId: z.string().optional(),
  otherFileId: z.string().optional(),
  leftId: z.string().optional(),
  rightId: z.string().optional(),
  leftType: z.enum(['item', 'version']).optional(),
  rightType: z.enum(['item', 'version']).optional(),
  lineKey: z.string().optional(),
  compareMode: z.string().optional(),
  maxLevels: z.number().min(-1).max(100).optional(),
  includeSubstitutes: z.boolean().optional(),
  includeEffectivity: z.boolean().optional(),
  includeRelationshipProps: z.union([z.array(z.string()), z.string()]).optional(),
  effectiveAt: z.string().optional(),
  recursive: z.boolean().optional(),
  filters: z.record(z.unknown()).optional(),
  pagination: z.object({
    limit: z.number().min(1).max(1000).default(100),
    offset: z.number().min(0).default(0),
  }).optional(),
})

const PLMMutationSchema = z.object({
  operation: z.enum([
    'substitutes_add',
    'substitutes_remove',
    'cad_properties_update',
    'cad_view_state_update',
    'cad_review_update',
  ]),
  bomLineId: z.string().optional(),
  substituteItemId: z.string().optional(),
  substituteId: z.string().optional(),
  fileId: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
  properties: z.record(z.unknown()).optional(),
  filters: z.record(z.unknown()).optional(),
})

const AthenaQuerySchema = z.object({
  operation: z.enum(['documents', 'search', 'preview', 'versions', 'workflow']),
  documentId: z.string().optional(),
  folderId: z.string().optional(),
  query: z.string().optional(),
  filters: z.record(z.unknown()).optional(),
  pagination: z.object({
    limit: z.number().min(1).max(1000).default(100),
    offset: z.number().min(0).default(0),
  }).optional(),
})

const CrossSystemSaveSchema = z.object({
  sourceSystem: z.string(),
  targetSystem: z.string(),
  documentId: z.string(),
  content: z.string(), // Base64 encoded
  metadata: z.object({
    fileName: z.string(),
    mimeType: z.string().optional(),
    expectedVersion: z.string().optional(),
    conflictStrategy: z.enum(['fail', 'merge', 'force']).default('fail'),
    comment: z.string().optional(),
  }),
})

const ImportFromPLMSchema = z.object({
  productId: z.string(),
  includeDocuments: z.boolean().default(true),
  includeBOM: z.boolean().default(false),
  targetFolderId: z.string().optional(),
})

const ExportToAthenaSchema = z.object({
  spreadsheetId: z.string(),
  targetFolderId: z.string(),
  fileName: z.string(),
  format: z.enum(['xlsx', 'csv', 'pdf']).default('xlsx'),
  includeComments: z.boolean().default(false),
})

// ─────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────

export function federationRouter(injector?: Injector): Router {
  const router = Router()
  const plmAdapter = injector ? injector.get(IPLMAdapter) : null
  const athenaAdapter = injector ? injector.get(IAthenaAdapter) : null
  const configService = injector ? injector.get(IConfigService) : null

  const persistConfigValue = async (key: string, value: string | number | boolean | null): Promise<void> => {
    if (!configService) return
    try {
      await configService.set(key, value)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[Federation] Failed to persist config '${key}': ${message}`)
    }
  }

  const reconnectAdapter = async (
    adapter: { isConnected: () => boolean; disconnect: () => Promise<void>; connect: () => Promise<void> },
    system: FederatedSystem
  ): Promise<void> => {
    try {
      if (adapter.isConnected()) {
        await adapter.disconnect()
      }
      await adapter.connect()
      if (adapter.isConnected()) {
        system.status = 'connected'
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[Federation] Failed to reconnect ${system.id}: ${message}`)
      system.status = 'error'
    }
  }

  const applyFederatedSystemConfig = async (
    system: FederatedSystem,
    baseUrl?: string,
    credentials?: FederatedCredentials
  ): Promise<void> => {
    const updates: Promise<void>[] = []
    const authType = credentials?.type

    if (system.type === 'plm') {
      if (baseUrl) updates.push(persistConfigValue('plm.url', baseUrl))
      if ((authType === 'bearer' || authType === 'oauth2') && credentials?.token) {
        updates.push(persistConfigValue('plm.apiToken', credentials.token))
      }
      if (authType === 'apikey' && credentials?.apiKey) {
        updates.push(persistConfigValue('plm.apiKey', credentials.apiKey))
      }
      if (authType === 'oauth2') {
        if (credentials?.clientId) updates.push(persistConfigValue('plm.clientId', credentials.clientId))
        if (credentials?.clientSecret) updates.push(persistConfigValue('plm.clientSecret', credentials.clientSecret))
      }
    }

    if (system.type === 'athena') {
      if (baseUrl) updates.push(persistConfigValue('athena.url', baseUrl))
      if ((authType === 'bearer' || authType === 'oauth2') && credentials?.token) {
        updates.push(persistConfigValue('athena.apiToken', credentials.token))
      }
      if (authType === 'apikey' && credentials?.apiKey) {
        updates.push(persistConfigValue('athena.apiKey', credentials.apiKey))
      }
      if (authType === 'oauth2') {
        if (credentials?.clientId) updates.push(persistConfigValue('athena.keycloak.clientId', credentials.clientId))
        if (credentials?.clientSecret) updates.push(persistConfigValue('athena.keycloak.clientSecret', credentials.clientSecret))
      }
    }

    if (updates.length > 0) {
      await Promise.all(updates)
    }

    if (system.type === 'plm' && plmAdapter) {
      await reconnectAdapter(plmAdapter, system)
    } else if (system.type === 'athena' && athenaAdapter) {
      await reconnectAdapter(athenaAdapter, system)
    }
  }

  const ensurePlmAdapter = async () => {
    if (!plmAdapter) return null
    if (!plmAdapter.isConnected()) {
      await plmAdapter.connect()
    }
    return plmAdapter
  }

  const ensureAthenaAdapter = async () => {
    if (!athenaAdapter) return null
    if (!athenaAdapter.isConnected()) {
      await athenaAdapter.connect()
    }
    return athenaAdapter
  }

  const toNumberParam = (value: unknown): number | undefined => {
    if (Array.isArray(value)) value = value[0]
    if (value === undefined || value === null || value === '') return undefined
    const num = Number(value)
    return Number.isFinite(num) ? num : undefined
  }

  const toStringParam = (value: unknown): string | undefined => {
    if (Array.isArray(value)) value = value[0]
    if (value === undefined || value === null) return undefined
    const str = String(value).trim()
    return str.length > 0 ? str : undefined
  }

  const toBoolParam = (value: unknown): boolean | undefined => {
    if (Array.isArray(value)) value = value[0]
    if (value === undefined || value === null || value === '') return undefined
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase()
      if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true
      if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false
    }
    return undefined
  }

  const resolveAdapterError = (error: unknown, fallbackMessage: string) => {
    const status = (error as { response?: { status?: number } })?.response?.status
    const statusCode = typeof status === 'number' ? status : 502
    const message = error instanceof Error ? error.message : fallbackMessage
    let code = 'PLM_ERROR'
    if (statusCode === 401) {
      code = 'PLM_UNAUTHORIZED'
    } else if (statusCode === 403) {
      code = 'PLM_FORBIDDEN'
    } else if (statusCode === 404) {
      code = 'PLM_NOT_FOUND'
    } else if (statusCode >= 500) {
      code = 'PLM_UPSTREAM'
    }
    return { statusCode, code, message }
  }

  const sendAdapterError = (
    res: Response,
    error: unknown,
    fallbackMessage: string,
    metrics: ReturnType<typeof getAdapterMetrics>,
    method: string,
    endpoint: string,
    startTime: number
  ): boolean => {
    if (!error) return false
    const resolved = resolveAdapterError(error, fallbackMessage)
    metrics.recordRequest(
      { adapter: 'plm', method, endpoint, status: String(resolved.statusCode) },
      Date.now() - startTime
    )
    res.status(resolved.statusCode).json({
      ok: false,
      error: {
        code: resolved.code,
        message: resolved.message,
      },
    })
    return true
  }

  const toStringArrayParam = (value: unknown): string[] | undefined => {
    if (Array.isArray(value)) {
      const items = value.map((item) => String(item).trim()).filter(Boolean)
      return items.length > 0 ? items : undefined
    }
    if (typeof value === 'string') {
      const items = value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
      return items.length > 0 ? items : undefined
    }
    return undefined
  }

  const resolvePlmListOptions = (req: Request) => {
    const limit = toNumberParam(req.query.limit)
    const offset = toNumberParam(req.query.offset ?? req.query.skip)
    const status = toStringParam(req.query.status ?? req.query.state)
    const search = toStringParam(req.query.search ?? req.query.q)
    const itemType = toStringParam(req.query.itemType ?? req.query.item_type)
    return { limit, offset, status, search, itemType }
  }

  const handlePlmProductsList = async (req: Request, res: Response) => {
    const metrics = getAdapterMetrics()
    const startTime = Date.now()

    try {
      const { limit, offset, status, search, itemType } = resolvePlmListOptions(req)
      const adapter = await ensurePlmAdapter()
      const resolvedLimit = limit ?? 100
      const resolvedOffset = offset ?? 0

      if (adapter) {
        const result = await adapter.getProducts({
          limit,
          offset,
          status,
          search,
          itemType,
        })
        if (sendAdapterError(res, result.error, 'Failed to list products', metrics, 'GET', '/products', startTime)) {
          return
        }
        const items = result.data.map((product: PLMProductWire) => mapPLMProduct(product))

        metrics.recordRequest(
          { adapter: 'plm', method: 'GET', endpoint: '/products', status: '200' },
          Date.now() - startTime
        )

        return res.json({
          ok: true,
          data: {
            items,
            total: result.metadata?.totalCount ?? items.length,
            limit: resolvedLimit,
            offset: resolvedOffset,
          },
        })
      }

      metrics.recordRequest(
        { adapter: 'plm', method: 'GET', endpoint: '/products', status: '200' },
        Date.now() - startTime
      )

      const mockData = getMockPLMData('products', undefined, {
        limit: resolvedLimit,
        offset: resolvedOffset,
      })

      return res.json({
        ok: true,
        data: mockData,
      })
    } catch (error) {
      if (sendAdapterError(res, error, 'Failed to list products', metrics, 'GET', '/products', startTime)) {
        return
      }
      metrics.recordRequest(
        { adapter: 'plm', method: 'GET', endpoint: '/products', status: '500' },
        Date.now() - startTime
      )

      return res.status(500).json({
        ok: false,
        error: {
          code: 'PLM_ERROR',
          message: error instanceof Error ? error.message : 'Failed to list products',
        },
      })
    }
  }

  const handlePlmProductDetail = async (req: Request, res: Response) => {
    const metrics = getAdapterMetrics()
    const startTime = Date.now()

    try {
      const productId = req.params.id
      const itemType = toStringParam(req.query.itemType ?? req.query.item_type)
      const adapter = await ensurePlmAdapter()

      if (adapter) {
        const product = await adapter.getProductById(productId, itemType ? { itemType } : undefined)
        if (!product) {
          return res.status(404).json({
            ok: false,
            error: {
              code: 'NOT_FOUND',
              message: `Product '${productId}' not found`,
            },
          })
        }

        metrics.recordRequest(
          { adapter: 'plm', method: 'GET', endpoint: '/products/:id', status: '200' },
          Date.now() - startTime
        )

        return res.json({
          ok: true,
          data: mapPLMProduct(product),
        })
      }

      metrics.recordRequest(
        { adapter: 'plm', method: 'GET', endpoint: '/products/:id', status: '200' },
        Date.now() - startTime
      )

      return res.json({
        ok: true,
        data: {
          id: productId,
          name: `Product ${productId}`,
          partNumber: `PN-${productId}`,
          status: 'released',
          revision: 'A',
          createdAt: new Date().toISOString(),
        },
      })
    } catch (error) {
      if (sendAdapterError(res, error, 'Failed to get product', metrics, 'GET', '/products/:id', startTime)) {
        return
      }
      metrics.recordRequest(
        { adapter: 'plm', method: 'GET', endpoint: '/products/:id', status: '500' },
        Date.now() - startTime
      )

      return res.status(500).json({
        ok: false,
        error: {
          code: 'PLM_ERROR',
          message: error instanceof Error ? error.message : 'Failed to get product',
        },
      })
    }
  }

  const handlePlmProductBom = async (req: Request, res: Response) => {
    const metrics = getAdapterMetrics()
    const startTime = Date.now()

    try {
      const productId = req.params.id
      const depthValue = toNumberParam(req.query.depth)
      const depth = typeof depthValue === 'number' ? Math.max(1, Math.floor(depthValue)) : undefined
      const effectiveAt = toStringParam(req.query.effective_at ?? req.query.effectiveAt)
      const adapter = await ensurePlmAdapter()
      const fallbackItems = getMockPlmBomItems(productId)

      metrics.recordRequest(
        { adapter: 'plm', method: 'GET', endpoint: '/products/:id/bom', status: '200' },
        Date.now() - startTime
      )

      if (adapter) {
        const result = await adapter.getProductBOM(productId, { depth, effectiveAt })
        if (sendAdapterError(res, result.error, 'Failed to get BOM', metrics, 'GET', '/products/:id/bom', startTime)) {
          return
        }
        return res.json({
          ok: true,
          data: {
            productId,
            items: result.data,
            totalItems: result.metadata?.totalCount ?? result.data.length,
          },
        })
      }

      return res.json({
        ok: true,
        data: {
          productId,
          items: fallbackItems,
          totalItems: fallbackItems.length,
        },
      })
    } catch (error) {
      if (sendAdapterError(res, error, 'Failed to get BOM', metrics, 'GET', '/products/:id/bom', startTime)) {
        return
      }
      metrics.recordRequest(
        { adapter: 'plm', method: 'GET', endpoint: '/products/:id/bom', status: '500' },
        Date.now() - startTime
      )

      return res.status(500).json({
        ok: false,
        error: {
          code: 'PLM_ERROR',
          message: error instanceof Error ? error.message : 'Failed to get BOM',
        },
      })
    }
  }

  // ─────────────────────────────────────────────────────────
  // System Management
  // ─────────────────────────────────────────────────────────

  /**
   * GET /api/federation/systems
   * List all federated systems and their status
   */
  router.get(
    '/api/federation/systems',
    rbacGuard('federation', 'read'),
    async (_req: Request, res: Response) => {
      try {
        const systems = Array.from(federatedSystems.values())
        return res.json({
          ok: true,
          data: {
            items: systems,
            total: systems.length,
          },
        })
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: error instanceof Error ? error.message : 'Failed to list systems',
          },
        })
      }
    }
  )

  /**
   * POST /api/federation/systems
   * Register a new federated system (PLM or Athena)
   */
  router.post(
    '/api/federation/systems',
    rbacGuard('federation', 'write'),
    async (req: Request, res: Response) => {
      const parse = RegisterSystemSchema.safeParse(req.body)
      if (!parse.success) {
        return res.status(400).json({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parse.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          },
        })
      }

      try {
        const { id, name, type, baseUrl, credentials, capabilities } = parse.data

        if (federatedSystems.has(id)) {
          return res.status(409).json({
            ok: false,
            error: { code: 'CONFLICT', message: `System '${id}' already registered` },
          })
        }

        const system: FederatedSystem = {
          id,
          name,
          type,
          status: 'disconnected',
          capabilities: capabilities || getDefaultCapabilities(type),
          baseUrl,
          authType: credentials.type,
        }

        federatedSystems.set(id, system)

        await auditLog({
          actorId: req.user?.id?.toString(),
          actorType: 'user',
          action: 'create',
          resourceType: 'federated_system',
          resourceId: id,
          meta: { name, type },
        })

        await applyFederatedSystemConfig(system, baseUrl, credentials)

        return res.status(201).json({
          ok: true,
          data: system,
        })
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: error instanceof Error ? error.message : 'Failed to register system',
          },
        })
      }
    }
  )

  /**
   * PATCH /api/federation/systems/:id
   * Update a federated system configuration
   */
  router.patch(
    '/api/federation/systems/:id',
    rbacGuard('federation', 'write'),
    async (req: Request, res: Response) => {
      const parse = UpdateSystemSchema.safeParse(req.body)
      if (!parse.success) {
        return res.status(400).json({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parse.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          },
        })
      }

      try {
        const system = federatedSystems.get(req.params.id)
        if (!system) {
          return res.status(404).json({
            ok: false,
            error: { code: 'NOT_FOUND', message: `System '${req.params.id}' not found` },
          })
        }

        const { name, baseUrl, credentials, capabilities, status } = parse.data

        if (name) system.name = name
        if (baseUrl) system.baseUrl = baseUrl
        if (capabilities) system.capabilities = capabilities
        if (status) system.status = status
        if (credentials?.type) system.authType = credentials.type

        if (baseUrl || credentials) {
          await applyFederatedSystemConfig(system, baseUrl, credentials)
        }

        await auditLog({
          actorId: req.user?.id?.toString(),
          actorType: 'user',
          action: 'update',
          resourceType: 'federated_system',
          resourceId: system.id,
          meta: { name: system.name, type: system.type },
        })

        return res.json({ ok: true, data: system })
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: error instanceof Error ? error.message : 'Failed to update system',
          },
        })
      }
    }
  )

  /**
   * GET /api/federation/systems/:id/health
   * Check health of a federated system
   */
  router.get(
    '/api/federation/systems/:id/health',
    rbacGuard('federation', 'read'),
    async (req: Request, res: Response) => {
      try {
        const system = federatedSystems.get(req.params.id)
        if (!system) {
          return res.status(404).json({
            ok: false,
            error: { code: 'NOT_FOUND', message: `System '${req.params.id}' not found` },
          })
        }

        const startTime = Date.now()
        let isHealthy = system.status !== 'error'
        if (system.type === 'plm') {
          const adapter = await ensurePlmAdapter()
          if (adapter?.healthCheck) {
            isHealthy = await adapter.healthCheck()
          }
        }
        const latency = Date.now() - startTime

        // Update last health check
        system.lastHealthCheck = new Date()

        return res.json({
          ok: true,
          data: {
            systemId: system.id,
            status: isHealthy ? 'healthy' : 'unhealthy',
            latencyMs: latency,
            lastCheck: system.lastHealthCheck,
            capabilities: system.capabilities,
          },
        })
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: error instanceof Error ? error.message : 'Health check failed',
          },
        })
      }
    }
  )

  /**
   * POST /api/federation/systems/:id/connect
   * Connect to a federated system
   */
  router.post(
    '/api/federation/systems/:id/connect',
    rbacGuard('federation', 'write'),
    async (req: Request, res: Response) => {
      try {
        const system = federatedSystems.get(req.params.id)
        if (!system) {
          return res.status(404).json({
            ok: false,
            error: { code: 'NOT_FOUND', message: `System '${req.params.id}' not found` },
          })
        }

        // Simulate connection (in production, would use actual adapter)
        system.status = 'connected'
        system.lastHealthCheck = new Date()

        await auditLog({
          actorId: req.user?.id?.toString(),
          actorType: 'user',
          action: 'connect',
          resourceType: 'federated_system',
          resourceId: system.id,
        })

        return res.json({
          ok: true,
          data: {
            systemId: system.id,
            status: system.status,
            connectedAt: system.lastHealthCheck,
          },
        })
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: error instanceof Error ? error.message : 'Connection failed',
          },
        })
      }
    }
  )

  /**
   * POST /api/federation/systems/:id/disconnect
   * Disconnect from a federated system
   */
  router.post(
    '/api/federation/systems/:id/disconnect',
    rbacGuard('federation', 'write'),
    async (req: Request, res: Response) => {
      try {
        const system = federatedSystems.get(req.params.id)
        if (!system) {
          return res.status(404).json({
            ok: false,
            error: { code: 'NOT_FOUND', message: `System '${req.params.id}' not found` },
          })
        }

        system.status = 'disconnected'

        await auditLog({
          actorId: req.user?.id?.toString(),
          actorType: 'user',
          action: 'disconnect',
          resourceType: 'federated_system',
          resourceId: system.id,
        })

        return res.json({
          ok: true,
          data: {
            systemId: system.id,
            status: system.status,
          },
        })
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: error instanceof Error ? error.message : 'Disconnect failed',
          },
        })
      }
    }
  )

  // ─────────────────────────────────────────────────────────
  // PLM Operations
  // ─────────────────────────────────────────────────────────

  /**
   * GET /api/plm/products
   * Alias for PLM product list (legacy frontend compatibility)
   */
  router.get(
    '/api/plm/products',
    rbacGuard('federation', 'read'),
    handlePlmProductsList
  )

  /**
   * GET /api/plm/products/:id/bom
   * Alias for PLM product BOM (legacy frontend compatibility)
   */
  router.get(
    '/api/plm/products/:id/bom',
    rbacGuard('federation', 'read'),
    handlePlmProductBom
  )

  /**
   * GET /api/plm/products/:id
   * Alias for PLM product detail (legacy frontend compatibility)
   */
  router.get(
    '/api/plm/products/:id',
    rbacGuard('federation', 'read'),
    handlePlmProductDetail
  )

  /**
   * POST /api/federation/plm/query
   * Query PLM system for products, BOMs, documents, or approvals
   */
  router.post(
    '/api/federation/plm/query',
    rbacGuard('federation', 'read'),
    async (req: Request, res: Response) => {
      const parse = PLMQuerySchema.safeParse(req.body)
      if (!parse.success) {
        return res.status(400).json({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parse.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          },
        })
      }

      const metrics = getAdapterMetrics()
      const startTime = Date.now()

      try {
        const {
          operation,
          productId,
          itemId,
          bomLineId,
          fileId,
          otherFileId,
          leftId,
          rightId,
          leftType,
          rightType,
          lineKey,
          compareMode,
          maxLevels,
          includeSubstitutes,
          includeEffectivity,
          includeRelationshipProps,
          effectiveAt,
          recursive,
          pagination,
          filters,
        } = parse.data
        const filterParams = (filters && typeof filters === 'object' && !Array.isArray(filters)) ? filters : {}
        const adapter = await ensurePlmAdapter()

        if (adapter) {
          if (operation === 'products') {
            const search =
              typeof filters?.query === 'string'
                ? filters?.query
                : typeof filters?.search === 'string'
                  ? filters?.search
                  : undefined
            const itemType =
              typeof filters?.itemType === 'string'
                ? filters?.itemType
                : typeof filters?.item_type === 'string'
                  ? filters?.item_type
                  : undefined

            const result = await adapter.getProducts({
              limit: pagination?.limit,
              offset: pagination?.offset,
              status: typeof filters?.status === 'string' ? filters?.status : undefined,
              search,
              itemType,
            })
            if (sendAdapterError(res, result.error, 'Failed to query products', metrics, 'POST', `/plm/${operation}`, startTime)) {
              return
            }

            const items = result.data.map((product: PLMProductWire) => mapPLMProduct(product))

            metrics.recordRequest(
              { adapter: 'plm', method: 'POST', endpoint: `/plm/${operation}`, status: '200' },
              Date.now() - startTime
            )

            return res.json({
              ok: true,
              data: {
                items,
                total: result.metadata?.totalCount ?? items.length,
                limit: pagination?.limit ?? 100,
                offset: pagination?.offset ?? 0,
              },
            })
          }

          if (operation === 'bom' && productId) {
            const depthValue = toNumberParam(filterParams.depth ?? filterParams.max_levels ?? filterParams.maxLevels)
            const depth = typeof depthValue === 'number' ? Math.max(1, Math.floor(depthValue)) : undefined
            const resolvedEffectiveAt = effectiveAt || toStringParam(filterParams.effective_at ?? filterParams.effectiveAt)
            const result = await adapter.getProductBOM(productId, { depth, effectiveAt: resolvedEffectiveAt })
            if (sendAdapterError(res, result.error, 'Failed to query BOM', metrics, 'POST', `/plm/${operation}`, startTime)) {
              return
            }

            metrics.recordRequest(
              { adapter: 'plm', method: 'POST', endpoint: `/plm/${operation}`, status: '200' },
              Date.now() - startTime
            )

            return res.json({
              ok: true,
              data: {
                productId,
                items: result.data,
                total: result.metadata?.totalCount ?? result.data.length,
              },
            })
          }

          if (operation === 'documents') {
            const resolvedProductId = productId
              || toStringParam(filterParams.product_id ?? filterParams.productId)
            if (!resolvedProductId) {
              return res.status(400).json({
                ok: false,
                error: {
                  code: 'VALIDATION_ERROR',
                  message: 'productId is required for documents',
                },
              })
            }

            const role = toStringParam(filterParams.role ?? filterParams.file_role ?? filterParams.fileRole)
            const includeMetadata =
              toBoolParam(filterParams.include_metadata ?? filterParams.includeMetadata)
              ?? true

            const result = await adapter.getProductDocuments(resolvedProductId, {
              limit: pagination?.limit,
              offset: pagination?.offset,
              role,
              includeMetadata,
            })
            if (sendAdapterError(res, result.error, 'Failed to query documents', metrics, 'POST', `/plm/${operation}`, startTime)) {
              return
            }

            metrics.recordRequest(
              { adapter: 'plm', method: 'POST', endpoint: `/plm/${operation}`, status: '200' },
              Date.now() - startTime
            )

            return res.json({
              ok: true,
              data: {
                productId: resolvedProductId,
                items: result.data,
                total: result.metadata?.totalCount ?? result.data.length,
                limit: pagination?.limit ?? 100,
                offset: pagination?.offset ?? 0,
              },
            })
          }

          if (operation === 'approvals') {
            const resolvedProductId = productId
              || toStringParam(filterParams.product_id ?? filterParams.productId)
            const status = toStringParam(filterParams.status ?? filterParams.state)
            const requesterId = toStringParam(
              filterParams.requester_id ?? filterParams.requesterId ?? filterParams.created_by_id ?? filterParams.createdById
            )

            const result = await adapter.getApprovals({
              productId: resolvedProductId,
              status,
              requesterId,
              limit: pagination?.limit,
              offset: pagination?.offset,
            })
            if (sendAdapterError(res, result.error, 'Failed to query approvals', metrics, 'POST', `/plm/${operation}`, startTime)) {
              return
            }

            metrics.recordRequest(
              { adapter: 'plm', method: 'POST', endpoint: `/plm/${operation}`, status: '200' },
              Date.now() - startTime
            )

            return res.json({
              ok: true,
              data: {
                items: result.data,
                total: result.metadata?.totalCount ?? result.data.length,
                limit: pagination?.limit ?? 100,
                offset: pagination?.offset ?? 0,
              },
            })
          }

          if (operation === 'cad_properties') {
            const resolvedFileId = fileId
              || toStringParam(filterParams.file_id ?? filterParams.fileId ?? filterParams.document_id ?? filterParams.documentId ?? filterParams.id)
            if (!resolvedFileId) {
              return res.status(400).json({
                ok: false,
                error: {
                  code: 'VALIDATION_ERROR',
                  message: 'fileId is required for cad_properties',
                },
              })
            }

            const result = await adapter.getCadProperties(resolvedFileId)
            if (sendAdapterError(res, result.error, 'Failed to query CAD properties', metrics, 'POST', `/plm/${operation}`, startTime)) {
              return
            }

            metrics.recordRequest(
              { adapter: 'plm', method: 'POST', endpoint: `/plm/${operation}`, status: '200' },
              Date.now() - startTime
            )

            return res.json({
              ok: true,
              data: result.data[0] ?? {
                file_id: resolvedFileId,
                properties: {},
              },
            })
          }

          if (operation === 'cad_view_state') {
            const resolvedFileId = fileId
              || toStringParam(filterParams.file_id ?? filterParams.fileId ?? filterParams.document_id ?? filterParams.documentId ?? filterParams.id)
            if (!resolvedFileId) {
              return res.status(400).json({
                ok: false,
                error: {
                  code: 'VALIDATION_ERROR',
                  message: 'fileId is required for cad_view_state',
                },
              })
            }

            const result = await adapter.getCadViewState(resolvedFileId)
            if (sendAdapterError(res, result.error, 'Failed to query CAD view state', metrics, 'POST', `/plm/${operation}`, startTime)) {
              return
            }

            metrics.recordRequest(
              { adapter: 'plm', method: 'POST', endpoint: `/plm/${operation}`, status: '200' },
              Date.now() - startTime
            )

            return res.json({
              ok: true,
              data: result.data[0] ?? {
                file_id: resolvedFileId,
                hidden_entity_ids: [],
                notes: [],
              },
            })
          }

          if (operation === 'cad_review') {
            const resolvedFileId = fileId
              || toStringParam(filterParams.file_id ?? filterParams.fileId ?? filterParams.document_id ?? filterParams.documentId ?? filterParams.id)
            if (!resolvedFileId) {
              return res.status(400).json({
                ok: false,
                error: {
                  code: 'VALIDATION_ERROR',
                  message: 'fileId is required for cad_review',
                },
              })
            }

            const result = await adapter.getCadReview(resolvedFileId)
            if (sendAdapterError(res, result.error, 'Failed to query CAD review', metrics, 'POST', `/plm/${operation}`, startTime)) {
              return
            }

            metrics.recordRequest(
              { adapter: 'plm', method: 'POST', endpoint: `/plm/${operation}`, status: '200' },
              Date.now() - startTime
            )

            return res.json({
              ok: true,
              data: result.data[0] ?? {
                file_id: resolvedFileId,
                state: null,
              },
            })
          }

          if (operation === 'cad_history') {
            const resolvedFileId = fileId
              || toStringParam(filterParams.file_id ?? filterParams.fileId ?? filterParams.document_id ?? filterParams.documentId ?? filterParams.id)
            if (!resolvedFileId) {
              return res.status(400).json({
                ok: false,
                error: {
                  code: 'VALIDATION_ERROR',
                  message: 'fileId is required for cad_history',
                },
              })
            }

            const result = await adapter.getCadHistory(resolvedFileId)
            if (sendAdapterError(res, result.error, 'Failed to query CAD history', metrics, 'POST', `/plm/${operation}`, startTime)) {
              return
            }

            metrics.recordRequest(
              { adapter: 'plm', method: 'POST', endpoint: `/plm/${operation}`, status: '200' },
              Date.now() - startTime
            )

            return res.json({
              ok: true,
              data: result.data[0] ?? {
                file_id: resolvedFileId,
                entries: [],
              },
            })
          }

          if (operation === 'cad_diff') {
            const resolvedFileId = fileId
              || toStringParam(filterParams.file_id ?? filterParams.fileId ?? filterParams.document_id ?? filterParams.documentId ?? filterParams.id)
            const resolvedOtherId = otherFileId
              || toStringParam(filterParams.other_id ?? filterParams.otherId ?? filterParams.other_file_id ?? filterParams.otherFileId)
            if (!resolvedFileId || !resolvedOtherId) {
              return res.status(400).json({
                ok: false,
                error: {
                  code: 'VALIDATION_ERROR',
                  message: 'fileId and otherFileId are required for cad_diff',
                },
              })
            }

            const result = await adapter.getCadDiff(resolvedFileId, resolvedOtherId)
            if (sendAdapterError(res, result.error, 'Failed to query CAD diff', metrics, 'POST', `/plm/${operation}`, startTime)) {
              return
            }

            metrics.recordRequest(
              { adapter: 'plm', method: 'POST', endpoint: `/plm/${operation}`, status: '200' },
              Date.now() - startTime
            )

            return res.json({
              ok: true,
              data: result.data[0] ?? {
                file_id: resolvedFileId,
                other_file_id: resolvedOtherId,
                properties: {},
                cad_document_schema_version: {},
              },
            })
          }

          if (operation === 'cad_mesh_stats') {
            const resolvedFileId = fileId
              || toStringParam(filterParams.file_id ?? filterParams.fileId ?? filterParams.document_id ?? filterParams.documentId ?? filterParams.id)
            if (!resolvedFileId) {
              return res.status(400).json({
                ok: false,
                error: {
                  code: 'VALIDATION_ERROR',
                  message: 'fileId is required for cad_mesh_stats',
                },
              })
            }

            const result = await adapter.getCadMeshStats(resolvedFileId)
            if (sendAdapterError(res, result.error, 'Failed to query CAD mesh stats', metrics, 'POST', `/plm/${operation}`, startTime)) {
              return
            }

            metrics.recordRequest(
              { adapter: 'plm', method: 'POST', endpoint: `/plm/${operation}`, status: '200' },
              Date.now() - startTime
            )

            return res.json({
              ok: true,
              data: result.data[0] ?? {
                file_id: resolvedFileId,
                stats: {},
              },
            })
          }

          if (operation === 'where_used') {
            const resolvedItemId = itemId
              || productId
              || toStringParam(filterParams.item_id ?? filterParams.itemId ?? filterParams.component_id ?? filterParams.componentId)
            if (!resolvedItemId) {
              return res.status(400).json({
                ok: false,
                error: {
                  code: 'VALIDATION_ERROR',
                  message: 'itemId is required for where_used',
                },
              })
            }

            const resolvedRecursive = typeof recursive === 'boolean'
              ? recursive
              : toBoolParam(filterParams.recursive)
            const resolvedMaxLevels = typeof maxLevels === 'number'
              ? maxLevels
              : toNumberParam(filterParams.max_levels ?? filterParams.maxLevels)

            const result = await adapter.getWhereUsed(resolvedItemId, {
              recursive: resolvedRecursive,
              maxLevels: resolvedMaxLevels,
            })
            if (sendAdapterError(res, result.error, 'Failed to query where-used', metrics, 'POST', `/plm/${operation}`, startTime)) {
              return
            }

            metrics.recordRequest(
              { adapter: 'plm', method: 'POST', endpoint: `/plm/${operation}`, status: '200' },
              Date.now() - startTime
            )

            return res.json({
              ok: true,
              data: result.data[0] ?? {
                item_id: resolvedItemId,
                count: 0,
                parents: [],
              },
            })
          }

          if (operation === 'substitutes') {
            const resolvedBomLineId = bomLineId
              || toStringParam(filterParams.bom_line_id ?? filterParams.bomLineId ?? filterParams.line_id ?? filterParams.lineId)
            if (!resolvedBomLineId) {
              return res.status(400).json({
                ok: false,
                error: {
                  code: 'VALIDATION_ERROR',
                  message: 'bomLineId is required for substitutes',
                },
              })
            }

            const result = await adapter.getBomSubstitutes(resolvedBomLineId)
            if (sendAdapterError(res, result.error, 'Failed to query substitutes', metrics, 'POST', `/plm/${operation}`, startTime)) {
              return
            }

            metrics.recordRequest(
              { adapter: 'plm', method: 'POST', endpoint: `/plm/${operation}`, status: '200' },
              Date.now() - startTime
            )

            return res.json({
              ok: true,
              data: result.data[0] ?? {
                bom_line_id: resolvedBomLineId,
                count: 0,
                substitutes: [],
              },
            })
          }

          if (operation === 'bom_compare_schema') {
            const result = await adapter.getBomCompareSchema()
            if (sendAdapterError(res, result.error, 'Failed to query BOM compare schema', metrics, 'POST', `/plm/${operation}`, startTime)) {
              return
            }

            metrics.recordRequest(
              { adapter: 'plm', method: 'POST', endpoint: `/plm/${operation}`, status: '200' },
              Date.now() - startTime
            )

            return res.json({
              ok: true,
              data: result.data[0] ?? {
                line_fields: [],
                compare_modes: [],
                line_key_options: [],
                defaults: {},
              },
            })
          }

          if (operation === 'bom_compare') {
            const resolvedLeftId = leftId || toStringParam(filterParams.left_id ?? filterParams.leftId)
            const resolvedRightId = rightId || toStringParam(filterParams.right_id ?? filterParams.rightId)
            if (!resolvedLeftId || !resolvedRightId) {
              return res.status(400).json({
                ok: false,
                error: {
                  code: 'VALIDATION_ERROR',
                  message: 'leftId and rightId are required for bom_compare',
                },
              })
            }

            const resolvedLeftType = (leftType || toStringParam(filterParams.left_type ?? filterParams.leftType) || 'item').toLowerCase()
            const resolvedRightType = (rightType || toStringParam(filterParams.right_type ?? filterParams.rightType) || 'item').toLowerCase()

            const resolvedLineKey = lineKey || toStringParam(filterParams.line_key ?? filterParams.lineKey)
            const resolvedCompareMode = compareMode || toStringParam(filterParams.compare_mode ?? filterParams.compareMode)
            const resolvedMaxLevels = typeof maxLevels === 'number'
              ? maxLevels
              : toNumberParam(filterParams.max_levels ?? filterParams.maxLevels)
            const resolvedIncludeSubstitutes = typeof includeSubstitutes === 'boolean'
              ? includeSubstitutes
              : toBoolParam(filterParams.include_substitutes ?? filterParams.includeSubstitutes)
            const resolvedIncludeEffectivity = typeof includeEffectivity === 'boolean'
              ? includeEffectivity
              : toBoolParam(filterParams.include_effectivity ?? filterParams.includeEffectivity)
            const resolvedRelProps = toStringArrayParam(
              includeRelationshipProps ?? filterParams.include_relationship_props ?? filterParams.includeRelationshipProps
            )
            const resolvedEffectiveAt = effectiveAt || toStringParam(filterParams.effective_at ?? filterParams.effectiveAt)

            const result = await adapter.getBomCompare({
              leftId: resolvedLeftId,
              rightId: resolvedRightId,
              leftType: resolvedLeftType === 'version' ? 'version' : 'item',
              rightType: resolvedRightType === 'version' ? 'version' : 'item',
              lineKey: resolvedLineKey,
              compareMode: resolvedCompareMode,
              maxLevels: resolvedMaxLevels,
              includeSubstitutes: resolvedIncludeSubstitutes,
              includeEffectivity: resolvedIncludeEffectivity,
              includeRelationshipProps: resolvedRelProps,
              effectiveAt: resolvedEffectiveAt,
            })
            if (sendAdapterError(res, result.error, 'Failed to query BOM compare', metrics, 'POST', `/plm/${operation}`, startTime)) {
              return
            }

            metrics.recordRequest(
              { adapter: 'plm', method: 'POST', endpoint: `/plm/${operation}`, status: '200' },
              Date.now() - startTime
            )

            return res.json({
              ok: true,
              data: result.data[0] ?? {
                summary: { added: 0, removed: 0, changed: 0, changed_major: 0, changed_minor: 0, changed_info: 0 },
                added: [],
                removed: [],
                changed: [],
              },
            })
          }
        }

        metrics.recordRequest(
          { adapter: 'plm', method: 'POST', endpoint: `/plm/${operation}`, status: '200' },
          Date.now() - startTime
        )

        const mockData = getMockPLMData(operation, productId, pagination, {
          itemId,
          bomLineId,
          fileId,
          otherFileId,
          leftId,
          rightId,
        })

        return res.json({
          ok: true,
          data: mockData,
        })
      } catch (error) {
        if (sendAdapterError(res, error, 'PLM query failed', metrics, 'POST', '/plm/query', startTime)) {
          return
        }
        metrics.recordRequest(
          { adapter: 'plm', method: 'POST', endpoint: `/plm/query`, status: '500' },
          Date.now() - startTime
        )
        metrics.recordError({ adapter: 'plm', error_code: 'QUERY_FAILED', operation: 'query' })

        return res.status(500).json({
          ok: false,
          error: {
            code: 'PLM_QUERY_FAILED',
            message: error instanceof Error ? error.message : 'PLM query failed',
          },
        })
      }
    }
  )

  /**
   * POST /api/federation/plm/mutate
   * Execute write operations against PLM (e.g., BOM substitutes)
   */
  router.post(
    '/api/federation/plm/mutate',
    rbacGuard('federation', 'write'),
    async (req: Request, res: Response) => {
      const parse = PLMMutationSchema.safeParse(req.body)
      if (!parse.success) {
        return res.status(400).json({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parse.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          },
        })
      }

      const metrics = getAdapterMetrics()
      const startTime = Date.now()

      try {
        const {
          operation,
          bomLineId,
          substituteItemId,
          substituteId,
          fileId,
          payload,
          properties,
          filters,
        } = parse.data

        const filterParams = (filters && typeof filters === 'object' && !Array.isArray(filters)) ? filters : {}
        const adapter = await ensurePlmAdapter()
        if (!adapter) {
          return res.status(503).json({
            ok: false,
            error: {
              code: 'PLM_UNAVAILABLE',
              message: 'PLM adapter not configured',
            },
          })
        }

        if (operation === 'cad_properties_update') {
          const resolvedFileId = fileId
            || toStringParam(filterParams.file_id ?? filterParams.fileId ?? filterParams.document_id ?? filterParams.documentId ?? filterParams.id)
          if (!resolvedFileId) {
            return res.status(400).json({
              ok: false,
              error: {
                code: 'VALIDATION_ERROR',
                message: 'fileId is required for cad_properties_update',
              },
            })
          }
          const resolvedPayload = payload && typeof payload === 'object' ? payload : null
          if (!resolvedPayload) {
            return res.status(400).json({
              ok: false,
              error: {
                code: 'VALIDATION_ERROR',
                message: 'payload is required for cad_properties_update',
              },
            })
          }

          const result = await adapter.updateCadProperties(resolvedFileId, resolvedPayload)
          if (sendAdapterError(res, result.error, 'Failed to update CAD properties', metrics, 'POST', `/plm/${operation}`, startTime)) {
            return
          }

          metrics.recordRequest(
            { adapter: 'plm', method: 'POST', endpoint: `/plm/${operation}`, status: '200' },
            Date.now() - startTime
          )

          return res.json({
            ok: true,
            data: result.data[0] ?? {
              file_id: resolvedFileId,
              properties: {},
            },
          })
        }

        if (operation === 'cad_view_state_update') {
          const resolvedFileId = fileId
            || toStringParam(filterParams.file_id ?? filterParams.fileId ?? filterParams.document_id ?? filterParams.documentId ?? filterParams.id)
          if (!resolvedFileId) {
            return res.status(400).json({
              ok: false,
              error: {
                code: 'VALIDATION_ERROR',
                message: 'fileId is required for cad_view_state_update',
              },
            })
          }
          const resolvedPayload = payload && typeof payload === 'object' ? payload : null
          if (!resolvedPayload) {
            return res.status(400).json({
              ok: false,
              error: {
                code: 'VALIDATION_ERROR',
                message: 'payload is required for cad_view_state_update',
              },
            })
          }

          const result = await adapter.updateCadViewState(resolvedFileId, resolvedPayload)
          if (sendAdapterError(res, result.error, 'Failed to update CAD view state', metrics, 'POST', `/plm/${operation}`, startTime)) {
            return
          }

          metrics.recordRequest(
            { adapter: 'plm', method: 'POST', endpoint: `/plm/${operation}`, status: '200' },
            Date.now() - startTime
          )

          return res.json({
            ok: true,
            data: result.data[0] ?? {
              file_id: resolvedFileId,
              hidden_entity_ids: [],
              notes: [],
            },
          })
        }

        if (operation === 'cad_review_update') {
          const resolvedFileId = fileId
            || toStringParam(filterParams.file_id ?? filterParams.fileId ?? filterParams.document_id ?? filterParams.documentId ?? filterParams.id)
          if (!resolvedFileId) {
            return res.status(400).json({
              ok: false,
              error: {
                code: 'VALIDATION_ERROR',
                message: 'fileId is required for cad_review_update',
              },
            })
          }
          const resolvedPayload = payload && typeof payload === 'object' ? payload : null
          if (!resolvedPayload) {
            return res.status(400).json({
              ok: false,
              error: {
                code: 'VALIDATION_ERROR',
                message: 'payload is required for cad_review_update',
              },
            })
          }

          const result = await adapter.updateCadReview(resolvedFileId, resolvedPayload)
          if (sendAdapterError(res, result.error, 'Failed to update CAD review', metrics, 'POST', `/plm/${operation}`, startTime)) {
            return
          }

          metrics.recordRequest(
            { adapter: 'plm', method: 'POST', endpoint: `/plm/${operation}`, status: '200' },
            Date.now() - startTime
          )

          return res.json({
            ok: true,
            data: result.data[0] ?? { file_id: resolvedFileId },
          })
        }

        if (operation === 'substitutes_add') {
          const resolvedBomLineId = bomLineId
            || toStringParam(filterParams.bom_line_id ?? filterParams.bomLineId ?? filterParams.line_id ?? filterParams.lineId)
          const resolvedSubstituteItemId = substituteItemId
            || toStringParam(filterParams.substitute_item_id ?? filterParams.substituteItemId ?? filterParams.item_id)
          if (!resolvedBomLineId || !resolvedSubstituteItemId) {
            return res.status(400).json({
              ok: false,
              error: {
                code: 'VALIDATION_ERROR',
                message: 'bomLineId and substituteItemId are required',
              },
            })
          }

          const result = await adapter.addBomSubstitute(
            resolvedBomLineId,
            resolvedSubstituteItemId,
            properties && typeof properties === 'object' ? properties : undefined
          )
          if (sendAdapterError(res, result.error, 'Failed to add BOM substitute', metrics, 'POST', `/plm/${operation}`, startTime)) {
            return
          }

          metrics.recordRequest(
            { adapter: 'plm', method: 'POST', endpoint: `/plm/${operation}`, status: '200' },
            Date.now() - startTime
          )

          return res.json({
            ok: true,
            data: result.data[0] ?? {
              ok: true,
              substitute_id: '',
              bom_line_id: resolvedBomLineId,
              substitute_item_id: resolvedSubstituteItemId,
            },
          })
        }

        if (operation === 'substitutes_remove') {
          const resolvedBomLineId = bomLineId
            || toStringParam(filterParams.bom_line_id ?? filterParams.bomLineId ?? filterParams.line_id ?? filterParams.lineId)
          const resolvedSubstituteId = substituteId
            || toStringParam(filterParams.substitute_id ?? filterParams.substituteId ?? filterParams.id)
          if (!resolvedBomLineId || !resolvedSubstituteId) {
            return res.status(400).json({
              ok: false,
              error: {
                code: 'VALIDATION_ERROR',
                message: 'bomLineId and substituteId are required',
              },
            })
          }

          const result = await adapter.removeBomSubstitute(resolvedBomLineId, resolvedSubstituteId)
          if (sendAdapterError(res, result.error, 'Failed to remove BOM substitute', metrics, 'POST', `/plm/${operation}`, startTime)) {
            return
          }

          metrics.recordRequest(
            { adapter: 'plm', method: 'POST', endpoint: `/plm/${operation}`, status: '200' },
            Date.now() - startTime
          )

          return res.json({
            ok: true,
            data: result.data[0] ?? { ok: true, substitute_id: resolvedSubstituteId },
          })
        }

        return res.status(400).json({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: `Unsupported operation: ${operation}`,
          },
        })
      } catch (error) {
        if (sendAdapterError(res, error, 'PLM mutation failed', metrics, 'POST', '/plm/mutate', startTime)) {
          return
        }
        metrics.recordRequest(
          { adapter: 'plm', method: 'POST', endpoint: '/plm/mutate', status: '500' },
          Date.now() - startTime
        )
        metrics.recordError({ adapter: 'plm', error_code: 'MUTATION_FAILED', operation: 'mutate' })

        return res.status(500).json({
          ok: false,
          error: {
            code: 'PLM_MUTATION_FAILED',
            message: error instanceof Error ? error.message : 'PLM mutation failed',
          },
        })
      }
    }
  )

  /**
   * GET /api/federation/plm/products/:id
   * Get a specific product from PLM
   */
  router.get(
    '/api/federation/plm/products/:id',
    rbacGuard('federation', 'read'),
    handlePlmProductDetail
  )

  /**
   * GET /api/federation/plm/products/:id/bom
   * Get BOM (Bill of Materials) for a product
   */
  router.get(
    '/api/federation/plm/products/:id/bom',
    rbacGuard('federation', 'read'),
    handlePlmProductBom
  )

  // ─────────────────────────────────────────────────────────
  // Athena Operations
  // ─────────────────────────────────────────────────────────

  /**
   * POST /api/federation/athena/query
   * Query Athena ECM for documents, search results, or workflow tasks
   */
  router.post(
    '/api/federation/athena/query',
    rbacGuard('federation', 'read'),
    async (req: Request, res: Response) => {
      const parse = AthenaQuerySchema.safeParse(req.body)
      if (!parse.success) {
        return res.status(400).json({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parse.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          },
        })
      }

      const metrics = getAdapterMetrics()
      const startTime = Date.now()

      try {
        const { operation, documentId, folderId, query, filters, pagination } = parse.data
        const adapter = await ensureAthenaAdapter()
        const limit = pagination?.limit ?? 100
        const offset = pagination?.offset ?? 0

        metrics.recordRequest(
          { adapter: 'athena', method: 'POST', endpoint: `/athena/${operation}`, status: '200' },
          Date.now() - startTime
        )

        if (adapter) {
          const filterParams = (filters && typeof filters === 'object' && !Array.isArray(filters)) ? filters : {}

          if (operation === 'documents' || operation === 'search') {
            const searchParams = {
              query: query ?? (typeof filterParams.query === 'string' ? filterParams.query : ''),
              folder_id: folderId ?? (typeof filterParams.folder_id === 'string' ? filterParams.folder_id : undefined),
              type: typeof filterParams.type === 'string' ? filterParams.type : undefined,
              status: typeof filterParams.status === 'string' ? filterParams.status : undefined,
              created_by: typeof filterParams.created_by === 'string' ? filterParams.created_by : undefined,
              created_after: typeof filterParams.created_after === 'string' ? filterParams.created_after : undefined,
              created_before: typeof filterParams.created_before === 'string' ? filterParams.created_before : undefined,
              limit,
              offset,
            }

            const result = await adapter.searchDocuments(searchParams)
            const items: Array<ReturnType<typeof mapAthenaDocument>> = result.data
              .map((doc: AdapterAthenaDocument) => mapAthenaDocument(doc))
            const total = result.metadata?.totalCount ?? items.length

            if (operation === 'documents') {
              return res.json({
                ok: true,
                data: {
                  items,
                  total,
                  limit,
                  offset,
                },
              })
            }

            const results = items.map((doc: ReturnType<typeof mapAthenaDocument>, index: number) => ({
              id: doc.id,
              name: doc.name,
              score: 1 - index * 0.01,
            }))

            return res.json({
              ok: true,
              data: {
                query: searchParams.query || '',
                results,
                total,
              },
            })
          }

          if (operation === 'versions') {
            if (!documentId) {
              return res.status(400).json({
                ok: false,
                error: {
                  code: 'VALIDATION_ERROR',
                  message: 'documentId is required for versions',
                },
              })
            }

            const result = await adapter.getVersionHistory(documentId)
            const versions = result.data.map((version: AdapterDocumentVersion, index: number) => ({
              label: version.version,
              createdAt: version.created_at,
              createdBy: version.created_by,
              current: index === result.data.length - 1,
            }))

            return res.json({
              ok: true,
              data: {
                documentId,
                versions,
              },
            })
          }

          return res.status(501).json({
            ok: false,
            error: {
              code: 'ATHENA_OPERATION_UNSUPPORTED',
              message: `Operation '${operation}' is not supported`,
            },
          })
        }

        // Mock Athena query response
        const mockData = getMockAthenaData(operation, documentId, query, pagination)

        return res.json({
          ok: true,
          data: mockData,
        })
      } catch (error) {
        metrics.recordRequest(
          { adapter: 'athena', method: 'POST', endpoint: `/athena/query`, status: '500' },
          Date.now() - startTime
        )
        metrics.recordError({ adapter: 'athena', error_code: 'QUERY_FAILED', operation: 'query' })

        return res.status(500).json({
          ok: false,
          error: {
            code: 'ATHENA_QUERY_FAILED',
            message: error instanceof Error ? error.message : 'Athena query failed',
          },
        })
      }
    }
  )

  /**
   * GET /api/federation/athena/documents/:id
   * Get document metadata from Athena
   */
  router.get(
    '/api/federation/athena/documents/:id',
    rbacGuard('federation', 'read'),
    async (req: Request, res: Response) => {
      const metrics = getAdapterMetrics()
      const startTime = Date.now()

      try {
        const documentId = req.params.id
        const adapter = await ensureAthenaAdapter()

        metrics.recordRequest(
          { adapter: 'athena', method: 'GET', endpoint: '/documents/:id', status: '200' },
          Date.now() - startTime
        )

        if (adapter) {
          const document = await adapter.getDocument(documentId)
          if (!document) {
            return res.status(404).json({
              ok: false,
              error: {
                code: 'NOT_FOUND',
                message: `Document '${documentId}' not found`,
              },
            })
          }

          return res.json({
            ok: true,
            data: mapAthenaDocument(document),
          })
        }

        // Mock response
        return res.json({
          ok: true,
          data: {
            id: documentId,
            name: `Document ${documentId}.xlsx`,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            size: 15360,
            version: '1.0',
            createdAt: new Date().toISOString(),
            modifiedAt: new Date().toISOString(),
            locked: false,
          },
        })
      } catch (error) {
        metrics.recordRequest(
          { adapter: 'athena', method: 'GET', endpoint: '/documents/:id', status: '500' },
          Date.now() - startTime
        )

        return res.status(500).json({
          ok: false,
          error: {
            code: 'ATHENA_ERROR',
            message: error instanceof Error ? error.message : 'Failed to get document',
          },
        })
      }
    }
  )

  /**
   * GET /api/federation/athena/documents/:id/versions
   * Get version history from Athena
   */
  router.get(
    '/api/federation/athena/documents/:id/versions',
    rbacGuard('federation', 'read'),
    async (req: Request, res: Response) => {
      const metrics = getAdapterMetrics()
      const startTime = Date.now()

      try {
        const documentId = req.params.id
        const adapter = await ensureAthenaAdapter()

        metrics.recordRequest(
          { adapter: 'athena', method: 'GET', endpoint: '/documents/:id/versions', status: '200' },
          Date.now() - startTime
        )

        if (adapter) {
          const result = await adapter.getVersionHistory(documentId)
          const versions = result.data.map((version: AdapterDocumentVersion, index: number) => ({
            label: version.version,
            createdAt: version.created_at,
            createdBy: version.created_by,
            current: index === result.data.length - 1,
          }))

          return res.json({
            ok: true,
            data: {
              documentId,
              versions,
            },
          })
        }

        // Mock versions response
        return res.json({
          ok: true,
          data: {
            documentId,
            versions: [
              { label: '1.0', createdAt: new Date(Date.now() - 86400000).toISOString(), createdBy: 'user1' },
              { label: '1.1', createdAt: new Date(Date.now() - 43200000).toISOString(), createdBy: 'user2' },
              { label: '2.0', createdAt: new Date().toISOString(), createdBy: 'user1', current: true },
            ],
          },
        })
      } catch (error) {
        metrics.recordRequest(
          { adapter: 'athena', method: 'GET', endpoint: '/documents/:id/versions', status: '500' },
          Date.now() - startTime
        )

        return res.status(500).json({
          ok: false,
          error: {
            code: 'ATHENA_ERROR',
            message: error instanceof Error ? error.message : 'Failed to get versions',
          },
        })
      }
    }
  )

  // ─────────────────────────────────────────────────────────
  // Cross-System Operations
  // ─────────────────────────────────────────────────────────

  /**
   * POST /api/federation/cross-system/save
   * Save content from one system to another (e.g., MetaSheet -> Athena)
   */
  router.post(
    '/api/federation/cross-system/save',
    rbacGuard('federation', 'write'),
    async (req: Request, res: Response) => {
      const parse = CrossSystemSaveSchema.safeParse(req.body)
      if (!parse.success) {
        return res.status(400).json({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parse.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          },
        })
      }

      const { sourceSystem, targetSystem, documentId, metadata } = parse.data
      const finish = startCrossSystemTimer(
        `${sourceSystem}_to_${targetSystem}_save`,
        sourceSystem,
        targetSystem
      )

      try {
        // Create operation record
        const operationId = `op-${Date.now()}`
        const operation: CrossSystemOperation = {
          id: operationId,
          flow: `${sourceSystem}_to_${targetSystem}_save`,
          sourceSystem,
          targetSystem,
          status: 'in_progress',
          startedAt: new Date(),
        }
        pendingOperations.set(operationId, operation)

        // Simulate save operation (in production, would use actual adapters)
        await new Promise((resolve) => setTimeout(resolve, 100))

        // Complete operation
        operation.status = 'completed'
        operation.completedAt = new Date()
        finish('success')

        await auditLog({
          actorId: req.user?.id?.toString(),
          actorType: 'user',
          action: 'cross_system_save',
          resourceType: 'document',
          resourceId: documentId,
          meta: {
            sourceSystem,
            targetSystem,
            fileName: metadata.fileName,
          },
        })

        return res.json({
          ok: true,
          data: {
            operationId,
            status: 'completed',
            documentId,
            newVersion: '2.0',
            savedAt: operation.completedAt,
          },
        })
      } catch (error) {
        finish('failure')

        return res.status(500).json({
          ok: false,
          error: {
            code: 'CROSS_SYSTEM_SAVE_FAILED',
            message: error instanceof Error ? error.message : 'Cross-system save failed',
          },
        })
      }
    }
  )

  /**
   * POST /api/federation/import/plm
   * Import data from PLM into MetaSheet
   */
  router.post(
    '/api/federation/import/plm',
    rbacGuard('federation', 'write'),
    async (req: Request, res: Response) => {
      const parse = ImportFromPLMSchema.safeParse(req.body)
      if (!parse.success) {
        return res.status(400).json({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parse.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          },
        })
      }

      const { productId, includeDocuments, includeBOM } = parse.data
      const finish = startCrossSystemTimer('plm_import', 'plm', 'metasheet')

      try {
        // Simulate import operation
        await new Promise((resolve) => setTimeout(resolve, 200))

        const importedItems: string[] = ['product_metadata']
        if (includeBOM) importedItems.push('bom_data')
        if (includeDocuments) importedItems.push('documents')

        finish('success')

        await auditLog({
          actorId: req.user?.id?.toString(),
          actorType: 'user',
          action: 'import_from_plm',
          resourceType: 'product',
          resourceId: productId,
          meta: { importedItems },
        })

        return res.json({
          ok: true,
          data: {
            productId,
            importedItems,
            spreadsheetId: `ss-${Date.now()}`,
            createdAt: new Date().toISOString(),
          },
        })
      } catch (error) {
        finish('failure')

        return res.status(500).json({
          ok: false,
          error: {
            code: 'PLM_IMPORT_FAILED',
            message: error instanceof Error ? error.message : 'PLM import failed',
          },
        })
      }
    }
  )

  /**
   * POST /api/federation/export/athena
   * Export MetaSheet spreadsheet to Athena ECM
   */
  router.post(
    '/api/federation/export/athena',
    rbacGuard('federation', 'write'),
    async (req: Request, res: Response) => {
      const parse = ExportToAthenaSchema.safeParse(req.body)
      if (!parse.success) {
        return res.status(400).json({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parse.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          },
        })
      }

      const { spreadsheetId, targetFolderId, fileName, format } = parse.data
      const finish = startCrossSystemTimer('athena_export', 'metasheet', 'athena')

      try {
        // Simulate export operation
        await new Promise((resolve) => setTimeout(resolve, 150))

        finish('success')

        const documentId = `doc-${Date.now()}`

        await auditLog({
          actorId: req.user?.id?.toString(),
          actorType: 'user',
          action: 'export_to_athena',
          resourceType: 'spreadsheet',
          resourceId: spreadsheetId,
          meta: { documentId, targetFolderId, fileName, format },
        })

        return res.json({
          ok: true,
          data: {
            spreadsheetId,
            documentId,
            fileName: `${fileName}.${format}`,
            folderId: targetFolderId,
            exportedAt: new Date().toISOString(),
          },
        })
      } catch (error) {
        finish('failure')

        return res.status(500).json({
          ok: false,
          error: {
            code: 'ATHENA_EXPORT_FAILED',
            message: error instanceof Error ? error.message : 'Athena export failed',
          },
        })
      }
    }
  )

  /**
   * GET /api/federation/operations
   * List recent cross-system operations
   */
  router.get(
    '/api/federation/operations',
    rbacGuard('federation', 'read'),
    async (_req: Request, res: Response) => {
      try {
        const operations = Array.from(pendingOperations.values())
          .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
          .slice(0, 100)

        return res.json({
          ok: true,
          data: {
            items: operations,
            total: operations.length,
          },
        })
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: error instanceof Error ? error.message : 'Failed to list operations',
          },
        })
      }
    }
  )

  /**
   * GET /api/federation/metrics
   * Get federation metrics summary
   */
  router.get(
    '/api/federation/metrics',
    rbacGuard('federation', 'read'),
    async (_req: Request, res: Response) => {
      try {
        const metrics = getAdapterMetrics()
        const metricsText = await metrics.getMetrics()

        // Parse for summary
        const summary = {
          timestamp: new Date().toISOString(),
          systems: {
            plm: { requests: 0, errors: 0 },
            athena: { requests: 0, errors: 0 },
          },
          crossSystem: {
            operations: pendingOperations.size,
            successRate: 0,
          },
        }

        // Simple regex parsing for demo
        const plmRequestMatch = metricsText.match(/federation_request_total\{[^}]*adapter="plm"[^}]*\}\s+(\d+)/)
        const athenaRequestMatch = metricsText.match(/federation_request_total\{[^}]*adapter="athena"[^}]*\}\s+(\d+)/)

        if (plmRequestMatch) summary.systems.plm.requests = parseInt(plmRequestMatch[1], 10)
        if (athenaRequestMatch) summary.systems.athena.requests = parseInt(athenaRequestMatch[1], 10)

        return res.json({
          ok: true,
          data: summary,
        })
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: error instanceof Error ? error.message : 'Failed to get metrics',
          },
        })
      }
    }
  )

  return router
}

// ─────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────

function getDefaultCapabilities(type: 'plm' | 'athena'): string[] {
  if (type === 'plm') {
    return [
      'products',
      'bom',
      'documents',
      'approvals',
      'drawings',
      'where_used',
      'bom_compare',
      'bom_compare_schema',
      'substitutes',
      'substitutes_add',
      'substitutes_remove',
      'cad_properties',
      'cad_view_state',
      'cad_review',
      'cad_history',
      'cad_diff',
      'cad_mesh_stats',
      'cad_properties_update',
      'cad_view_state_update',
      'cad_review_update',
    ]
  }
  return ['documents', 'search', 'preview', 'versions', 'workflow', 'collaboration']
}

type PLMProductWire = AdapterPLMProduct & {
  partNumber?: string
  revision?: string
  createdAt?: string
  updatedAt?: string
  itemType?: string
  properties?: Record<string, unknown>
}

function mapPLMProduct(product: PLMProductWire) {
  const partNumber = product.partNumber || product.code || ''
  const revision = product.revision || product.version || ''
  const createdAt = product.createdAt || product.created_at
  const updatedAt = product.updatedAt || product.updated_at

  return {
    id: product.id,
    name: product.name,
    partNumber,
    status: product.status,
    revision,
    createdAt,
    updatedAt,
    code: product.code,
    version: product.version,
    description: product.description,
    itemType: product.itemType,
    properties: product.properties,
  }
}

type AthenaDocumentWire = AdapterAthenaDocument & {
  mimeType?: string
  mime_type?: string
  file_size?: number
  contentType?: string
  currentVersionLabel?: string
  createdAt?: string
  modifiedAt?: string
  updatedAt?: string
  locked?: boolean
}

function mapAthenaDocument(document: AthenaDocumentWire) {
  const mimeType = document.mimeType || document.mime_type || document.contentType || document.type || 'application/octet-stream'
  const size = typeof document.size === 'number' ? document.size : (document.file_size ?? 0)
  const createdAt = document.createdAt || document.created_at
  const modifiedAt = document.modifiedAt || document.updatedAt || document.updated_at
  const locked = typeof document.locked === 'boolean'
    ? document.locked
    : Boolean(document.checked_out_by || document.checked_out_at)

  return {
    id: document.id,
    name: document.name,
    mimeType,
    size,
    version: document.version || document.currentVersionLabel,
    createdAt,
    modifiedAt,
    locked,
  }
}

function getMockPlmBomItems(productId: string): AdapterBOMItem[] {
  return [
    {
      id: 'rel-001',
      product_id: productId,
      parent_item_id: productId,
      component_id: 'comp-001',
      component_code: 'COMP-001',
      component_name: 'Component A',
      quantity: 2,
      unit: 'EA',
      level: 1,
      sequence: 10,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 'rel-001-1',
      product_id: productId,
      parent_item_id: 'comp-001',
      component_id: 'comp-001-1',
      component_code: 'COMP-001A',
      component_name: 'Subcomponent A1',
      quantity: 4,
      unit: 'EA',
      level: 2,
      sequence: 11,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 'rel-002',
      product_id: productId,
      parent_item_id: productId,
      component_id: 'comp-002',
      component_code: 'COMP-002',
      component_name: 'Component B',
      quantity: 1,
      unit: 'EA',
      level: 1,
      sequence: 20,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 'rel-003',
      product_id: productId,
      parent_item_id: productId,
      component_id: 'mat-001',
      component_code: 'MAT-001',
      component_name: 'Material X',
      quantity: 0.5,
      unit: 'KG',
      level: 1,
      sequence: 30,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ]
}

function getMockPLMData(
  operation: string,
  productId?: string,
  pagination?: { limit: number; offset: number },
  options?: { itemId?: string; bomLineId?: string; fileId?: string; otherFileId?: string; leftId?: string; rightId?: string }
): unknown {
  const limit = pagination?.limit || 10
  const offset = pagination?.offset || 0

  switch (operation) {
    case 'products':
      return {
        items: Array.from({ length: Math.min(limit, 5) }, (_, i) => ({
          id: `prod-${offset + i + 1}`,
          name: `Product ${offset + i + 1}`,
          partNumber: `PN-${1000 + offset + i}`,
          status: 'released',
        })),
        total: 50,
        limit,
        offset,
      }
    case 'bom':
      {
        const rootId = productId || 'prod-1'
        const items = getMockPlmBomItems(rootId)
        return {
          productId: rootId,
          items,
          total: items.length,
        }
      }
    case 'where_used':
      {
        const itemId = options?.itemId || productId || 'comp-001'
        return {
          item_id: itemId,
          count: 0,
          parents: [],
        }
      }
    case 'substitutes':
      {
        const bomLineId = options?.bomLineId || 'bom-line-001'
        return {
          bom_line_id: bomLineId,
          count: 0,
          substitutes: [],
        }
      }
    case 'bom_compare':
      {
        const left = options?.leftId || 'prod-left'
        const right = options?.rightId || 'prod-right'
        return {
          summary: { added: 0, removed: 0, changed: 0, changed_major: 0, changed_minor: 0, changed_info: 0 },
          added: [],
          removed: [],
          changed: [],
          left_id: left,
          right_id: right,
        }
      }
    case 'bom_compare_schema':
      return {
        line_fields: [
          { field: 'quantity', severity: 'major', normalized: 'float', description: 'BOM quantity on the relationship line.' },
          { field: 'uom', severity: 'major', normalized: 'upper-case string', description: 'Unit of measure for the BOM quantity.' },
          { field: 'find_num', severity: 'minor', normalized: 'trimmed string', description: 'BOM position/find number.' },
          { field: 'refdes', severity: 'minor', normalized: 'sorted unique list', description: 'Reference designator(s) for BOM line.' },
          { field: 'effectivity_from', severity: 'major', normalized: 'ISO datetime string', description: 'Effectivity start datetime (ISO).' },
          { field: 'effectivity_to', severity: 'major', normalized: 'ISO datetime string', description: 'Effectivity end datetime (ISO).' },
          { field: 'effectivities', severity: 'major', normalized: 'sorted tuples (type,start,end,payload)', description: 'Expanded effectivity records attached to the line.' },
          { field: 'substitutes', severity: 'minor', normalized: 'sorted tuples (item_id,rank,note)', description: 'Substitute items for the BOM line.' },
        ],
        compare_modes: [
          { mode: 'only_product', line_key: 'child_config', include_relationship_props: [], aggregate_quantities: false, aliases: ['only'], description: 'Compare by parent/child config only.' },
          { mode: 'summarized', line_key: 'child_config', include_relationship_props: ['quantity', 'uom'], aggregate_quantities: true, aliases: ['summary'], description: 'Aggregate quantities for identical children.' },
          { mode: 'num_qty', line_key: 'child_config_find_num_qty', include_relationship_props: ['quantity', 'uom', 'find_num'], aggregate_quantities: false, aliases: ['numqty'], description: 'Compare by child config + find_num + quantity.' },
          { mode: 'by_position', line_key: 'child_config_find_num', include_relationship_props: ['quantity', 'uom', 'find_num'], aggregate_quantities: false, aliases: ['by_pos', 'position'], description: 'Compare by child config + find_num.' },
          { mode: 'by_reference', line_key: 'child_config_refdes', include_relationship_props: ['quantity', 'uom', 'refdes'], aggregate_quantities: false, aliases: ['by_ref', 'reference'], description: 'Compare by child config + refdes.' },
        ],
        line_key_options: [
          'child_config',
          'child_id',
          'relationship_id',
          'child_config_find_num',
          'child_config_refdes',
          'child_config_find_refdes',
          'child_id_find_num',
          'child_id_refdes',
          'child_id_find_refdes',
          'child_config_find_num_qty',
          'child_id_find_num_qty',
          'line_full',
        ],
        defaults: {
          max_levels: 10,
          line_key: 'child_config',
          include_substitutes: false,
          include_effectivity: false,
        },
      }
    case 'documents':
      return {
        productId: productId || 'prod-1',
        items: [
          { id: 'doc-1', name: 'Spec.pdf', type: 'specification' },
          { id: 'doc-2', name: 'Drawing.dwg', type: 'drawing' },
        ],
        total: 2,
      }
    case 'approvals':
      return {
        items: [
          { id: 'apr-1', productId: 'prod-1', status: 'pending', requester: 'user1' },
        ],
        total: 1,
      }
    case 'cad_properties':
      return {
        file_id: options?.fileId || 'file-001',
        properties: {
          material: 'AL-6061',
          finish: 'anodized',
          weight_kg: 1.2,
        },
        updated_at: new Date().toISOString(),
        source: 'mock',
      }
    case 'cad_view_state':
      return {
        file_id: options?.fileId || 'file-001',
        hidden_entity_ids: [12, 19],
        notes: [
          { entity_id: 12, note: 'check hole position', color: '#FFB020' },
        ],
        updated_at: new Date().toISOString(),
        source: 'mock',
      }
    case 'cad_review':
      return {
        file_id: options?.fileId || 'file-001',
        state: 'approved',
        note: 'dimensions ok',
        reviewed_at: new Date().toISOString(),
        reviewed_by_id: 42,
      }
    case 'cad_history':
      return {
        file_id: options?.fileId || 'file-001',
        entries: [
          { id: 'chg-1', action: 'properties_updated', payload: { material: 'AL-6061' }, created_at: new Date().toISOString() },
        ],
      }
    case 'cad_diff':
      return {
        file_id: options?.fileId || 'file-001',
        other_file_id: options?.otherFileId || 'file-002',
        properties: {
          added: { finish: 'anodized' },
          removed: { coating: 'none' },
          changed: { weight_kg: { from: 1.1, to: 1.2 } },
        },
        cad_document_schema_version: {
          left: 1,
          right: 2,
        },
      }
    case 'cad_mesh_stats':
      return {
        file_id: options?.fileId || 'file-001',
        stats: {
          triangles: 102400,
          vertices: 51200,
          watertight: true,
        },
      }
    default:
      return { items: [], total: 0 }
  }
}

function getMockAthenaData(
  operation: string,
  documentId?: string,
  query?: string,
  pagination?: { limit: number; offset: number }
): unknown {
  const limit = pagination?.limit || 10
  const offset = pagination?.offset || 0

  switch (operation) {
    case 'documents':
      return {
        items: Array.from({ length: Math.min(limit, 5) }, (_, i) => ({
          id: `doc-${offset + i + 1}`,
          name: `Document ${offset + i + 1}.xlsx`,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: 10240 + i * 1000,
        })),
        total: 100,
        limit,
        offset,
      }
    case 'search':
      return {
        query: query || '',
        results: [
          { id: 'doc-1', name: 'Report Q1.xlsx', score: 0.95 },
          { id: 'doc-2', name: 'Report Q2.xlsx', score: 0.85 },
        ],
        total: 2,
      }
    case 'preview':
      return {
        documentId: documentId || 'doc-1',
        previewUrl: `/preview/${documentId || 'doc-1'}`,
        thumbnailUrl: `/thumbnail/${documentId || 'doc-1'}`,
      }
    case 'versions':
      return {
        documentId: documentId || 'doc-1',
        versions: [
          { label: '1.0', createdAt: new Date().toISOString() },
          { label: '2.0', createdAt: new Date().toISOString(), current: true },
        ],
      }
    case 'workflow':
      return {
        tasks: [
          { id: 'task-1', documentId: 'doc-1', type: 'review', assignee: 'user1' },
        ],
        total: 1,
      }
    default:
      return { items: [], total: 0 }
  }
}

export { federationRouter as default }
