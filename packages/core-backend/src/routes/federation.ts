import type { Request, Response } from 'express'
import { Router } from 'express'
import type { Injector } from '@wendellhu/redi'
import { IPLMAdapter } from '../di/identifiers'
import { Logger } from '../core/logger'

const logger = new Logger('FederationPLMRouter')

interface PLMQueryOptions {
  limit?: number
  offset?: number
  status?: string
  search?: string
  itemType?: string
}

interface PLMDocumentsOptions {
  limit?: number
  offset?: number
  role?: string
  includeMetadata?: boolean
}

interface PLMApprovalsOptions {
  status?: string
  limit?: number
  offset?: number
  productId?: string
  requesterId?: string
}

const parseNumber = (value: unknown, fallback: number): number => {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const toString = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim()) return value.trim()
  return undefined
}

const toBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true
    if (value.toLowerCase() === 'false') return false
  }
  return undefined
}

export function federationRouter(injector?: Injector): Router {
  const router = Router()
  const plmAdapter = injector ? injector.get(IPLMAdapter) : null

  const ensurePlm = async () => {
    if (!plmAdapter) {
      throw new Error('PLM adapter not available')
    }
    if (!plmAdapter.isConnected()) {
      await plmAdapter.connect()
    }
    return plmAdapter
  }

  router.get('/api/federation/plm/products', async (req: Request, res: Response) => {
    try {
      const adapter = await ensurePlm()
      const limit = parseNumber(req.query.limit, 20)
      const offset = parseNumber(req.query.offset, 0)
      const options: PLMQueryOptions = {
        limit,
        offset,
        status: toString(req.query.status),
        search: toString(req.query.search ?? req.query.q),
        itemType: toString(req.query.itemType),
      }
      const result = await adapter.getProducts(options)
      const total = result.metadata?.totalCount ?? result.data.length
      res.json({ data: result.data, total, limit, offset })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Failed to fetch PLM products', error as Error)
      res.status(500).json({ error: message })
    }
  })

  router.get('/api/federation/plm/products/:id', async (req: Request, res: Response) => {
    try {
      const adapter = await ensurePlm()
      const itemType = toString(req.query.itemType)
      const product = await adapter.getProductById(req.params.id, { itemType })
      if (!product) {
        return res.status(404).json({ error: 'Product not found' })
      }
      res.json({ data: product })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Failed to fetch PLM product detail', error as Error)
      res.status(500).json({ error: message })
    }
  })

  router.get('/api/federation/plm/products/:id/bom', async (req: Request, res: Response) => {
    try {
      const adapter = await ensurePlm()
      const result = await adapter.getProductBOM(req.params.id)
      const total = result.metadata?.totalCount ?? result.data.length
      res.json({ data: result.data, total })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Failed to fetch PLM BOM', error as Error)
      res.status(500).json({ error: message })
    }
  })

  router.post('/api/federation/plm/query', async (req: Request, res: Response) => {
    try {
      const adapter = await ensurePlm()
      const body = req.body ?? {}
      const operation = toString(body.operation)
      if (!operation) {
        return res.status(400).json({ error: 'operation is required' })
      }

      if (operation === 'products') {
        const options: PLMQueryOptions = {
          limit: parseNumber(body.limit ?? body?.pagination?.limit, 20),
          offset: parseNumber(body.offset ?? body?.pagination?.offset, 0),
          status: toString(body.status),
          search: toString(body.search),
          itemType: toString(body.itemType),
        }
        const result = await adapter.getProducts(options)
        const total = result.metadata?.totalCount ?? result.data.length
        return res.json({ data: result.data, total, limit: options.limit, offset: options.offset })
      }

      if (operation === 'bom') {
        const productId = toString(body.productId ?? body.itemId)
        if (!productId) {
          return res.status(400).json({ error: 'productId is required for bom' })
        }
        const result = await adapter.getProductBOM(productId)
        const total = result.metadata?.totalCount ?? result.data.length
        return res.json({ data: result.data, total })
      }

      if (operation === 'documents') {
        const productId = toString(body.productId ?? body.itemId)
        if (!productId) {
          return res.status(400).json({ error: 'productId is required for documents' })
        }
        const options: PLMDocumentsOptions = {
          limit: parseNumber(body.limit ?? body?.pagination?.limit, 100),
          offset: parseNumber(body.offset ?? body?.pagination?.offset, 0),
          role: toString(body.role),
          includeMetadata: toBoolean(body.includeMetadata),
        }
        const result = await adapter.getProductDocuments(productId, options)
        const total = result.metadata?.totalCount ?? result.data.length
        return res.json({ data: result.data, total, limit: options.limit, offset: options.offset })
      }

      if (operation === 'approvals') {
        const options: PLMApprovalsOptions = {
          status: toString(body.status),
          limit: parseNumber(body.limit ?? body?.pagination?.limit, 100),
          offset: parseNumber(body.offset ?? body?.pagination?.offset, 0),
          productId: toString(body.productId),
          requesterId: toString(body.requesterId),
        }
        const result = await adapter.getApprovals(options)
        const total = result.metadata?.totalCount ?? result.data.length
        return res.json({ data: result.data, total, limit: options.limit, offset: options.offset })
      }

      if (operation === 'where_used') {
        const itemId = toString(body.itemId ?? body.productId)
        if (!itemId) {
          return res.status(400).json({ error: 'itemId is required for where_used' })
        }
        const result = await adapter.getWhereUsed(itemId, {
          recursive: toBoolean(body.recursive),
          maxLevels: parseNumber(body.maxLevels ?? body.max_levels, 5),
        })
        const payload = result.data[0] ?? { item_id: itemId, count: 0, parents: [] }
        return res.json({ data: payload })
      }

      if (operation === 'bom_compare') {
        const leftId = toString(body.leftId)
        const rightId = toString(body.rightId)
        if (!leftId || !rightId) {
          return res.status(400).json({ error: 'leftId and rightId are required for bom_compare' })
        }
        const includePropsRaw = body.includeRelationshipProps
        const includeRelationshipProps = Array.isArray(includePropsRaw)
          ? includePropsRaw.map((value) => String(value))
          : typeof includePropsRaw === 'string'
            ? includePropsRaw.split(',').map((value) => value.trim()).filter(Boolean)
            : undefined
        const result = await adapter.getBomCompare({
          leftId,
          rightId,
          leftType: toString(body.leftType) as 'item' | 'version' | undefined,
          rightType: toString(body.rightType) as 'item' | 'version' | undefined,
          maxLevels: parseNumber(body.maxLevels ?? body.max_levels, 10),
          lineKey: toString(body.lineKey ?? body.line_key),
          compareMode: toString(body.compareMode ?? body.compare_mode),
          includeChildFields: toBoolean(body.includeChildFields ?? body.include_child_fields),
          includeSubstitutes: toBoolean(body.includeSubstitutes ?? body.include_substitutes),
          includeEffectivity: toBoolean(body.includeEffectivity ?? body.include_effectivity),
          includeRelationshipProps,
          effectiveAt: toString(body.effectiveAt ?? body.effective_at),
        })
        const payload = result.data[0] ?? { summary: { added: 0, removed: 0, changed: 0 }, added: [], removed: [], changed: [] }
        return res.json({ data: payload })
      }

      if (operation === 'substitutes') {
        const bomLineId = toString(body.bomLineId ?? body.bom_line_id)
        if (!bomLineId) {
          return res.status(400).json({ error: 'bomLineId is required for substitutes' })
        }
        const result = await adapter.getBomSubstitutes(bomLineId)
        const payload = result.data[0] ?? { bom_line_id: bomLineId, count: 0, substitutes: [] }
        return res.json({ data: payload })
      }

      return res.status(400).json({ error: `Unsupported operation: ${operation}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Failed to handle PLM query', error as Error)
      res.status(500).json({ error: message })
    }
  })

  return router
}
