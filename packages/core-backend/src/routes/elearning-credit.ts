import {
  json,
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express'

import { isElearningCreditSurfaceEnabled } from '../services/elearning-credit-ledger'
import {
  ElearningCreditAdjustmentError,
  type ElearningCreditAdjustmentResult,
} from '../services/elearning-credit-adjustment'
import { adjustElearningCreditPostgres } from '../services/elearning-credit-adjustment-postgres'
import {
  ELEARNING_CREDIT_WALLET_PAGE_MAX,
  ElearningCreditSurfaceError,
  getElearningCreditWallet,
  listElearningCreditRules,
  publishElearningCreditRule,
  type ElearningCreditRule,
  type ElearningCreditSurfaceDb,
  type ElearningCreditWalletItem,
} from '../services/elearning-credit-surface'

const RULE_KEYS = new Set(['behavior', 'dailyCap', 'points', 'requestId', 'timeZone'])
const ADJUSTMENT_KEYS = new Set(['points', 'reason', 'requestId', 'userId'])
const WALLET_KEYS = new Set(['cursor', 'limit'])
const ADMIN_WALLET_KEYS = new Set(['cursor', 'limit', 'userId'])
const jsonParser = json({ limit: 16 * 1024 })

const ERROR_STATUS: Record<ElearningCreditSurfaceError['code'], number> = {
  invalid_input: 400,
  conflict: 409,
  not_found: 404,
  unavailable: 503,
}

const ADJUSTMENT_ERROR_STATUS: Record<ElearningCreditAdjustmentError['code'], number> = {
  disabled: 404,
  invalid_input: 400,
  conflict: 409,
  not_found: 404,
  unavailable: 503,
}

export interface ElearningCreditRouteDeps {
  db: ElearningCreditSurfaceDb
  env?: NodeJS.ProcessEnv
  readGuard: RequestHandler
  adminGuard: RequestHandler
  viewerId(req: Request): string | null
  orgId(req: Request): string | null
  publishElearningCreditRule?: typeof publishElearningCreditRule
  listElearningCreditRules?: typeof listElearningCreditRules
  getElearningCreditWallet?: typeof getElearningCreditWallet
  adjustElearningCredit?: typeof adjustElearningCreditPostgres
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(value)
  return keys.length === allowed.size && keys.every((key) => allowed.has(key))
}

function parseJson(req: Request, res: Response, next: NextFunction): void {
  jsonParser(req, res, (error?: unknown) => {
    if (!error) return next()
    res.status(400).json({ error: 'invalid_input' })
  })
}

function requireContext(
  deps: ElearningCreditRouteDeps,
): RequestHandler {
  return (req, res, next): void => {
    if (!deps.viewerId(req)) {
      res.status(401).json({ error: 'unauthenticated' })
      return
    }
    if (!deps.orgId(req)) {
      res.status(403).json({ error: 'ORG_CONTEXT_REQUIRED' })
      return
    }
    next()
  }
}

function requireCredit(
  deps: ElearningCreditRouteDeps,
): RequestHandler {
  return (_req, res, next): void => {
    if (!isElearningCreditSurfaceEnabled(deps.env ?? process.env)) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    next()
  }
}

function run(
  handler: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res): void => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' })
    })
  }
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof ElearningCreditAdjustmentError) {
    res.status(ADJUSTMENT_ERROR_STATUS[error.code]).json({ error: error.code })
    return
  }
  if (error instanceof ElearningCreditSurfaceError) {
    res.status(ERROR_STATUS[error.code]).json({ error: error.code })
    return
  }
  res.status(500).json({ error: 'internal_error' })
}

function adjustmentDto(result: ElearningCreditAdjustmentResult) {
  return {
    adjustmentId: result.adjustmentId,
    userId: result.userId,
    points: result.points,
    balancePoints: result.balancePoints,
    createdAt: result.createdAt,
  }
}

function ruleDto(rule: ElearningCreditRule) {
  return {
    behavior: rule.behavior,
    ruleId: rule.ruleId,
    version: rule.version,
    points: rule.points,
    dailyCap: rule.dailyCap,
    timeZone: rule.timeZone,
    createdAt: rule.createdAt,
  }
}

function walletItemDto(item: ElearningCreditWalletItem) {
  return {
    decisionId: item.decisionId,
    behavior: item.behavior,
    awardedPoints: item.awardedPoints,
    status: item.status,
    occurredAt: item.occurredAt,
    createdAt: item.createdAt,
  }
}

function queryObject(req: Request): Record<string, unknown> {
  return req.query as Record<string, unknown>
}

function queryText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && text.length <= 512 ? text : null
}

function queryLimit(value: unknown): number | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed <= ELEARNING_CREDIT_WALLET_PAGE_MAX
    ? parsed
    : null
}

function walletQuery(
  req: Request,
  admin: boolean,
): { cursor?: string; limit?: number; userId?: string } | null {
  const query = queryObject(req)
  const allowed = admin ? ADMIN_WALLET_KEYS : WALLET_KEYS
  if (Object.keys(query).some((key) => !allowed.has(key))) return null
  const limit = queryLimit(query.limit)
  if (limit === null) return null
  const cursor = query.cursor === undefined ? undefined : queryText(query.cursor)
  if (query.cursor !== undefined && cursor === null) return null
  const userId = admin ? queryText(query.userId) : undefined
  if (admin && !userId) return null
  return {
    ...(cursor ? { cursor } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(userId ? { userId } : {}),
  }
}

export function createElearningCreditRouter(
  deps: ElearningCreditRouteDeps,
): Router | null {
  if (!isElearningCreditSurfaceEnabled(deps.env ?? process.env)) return null
  const router = Router()
  const gate = requireCredit(deps)
  const context = requireContext(deps)
  const publish = deps.publishElearningCreditRule ?? publishElearningCreditRule
  const list = deps.listElearningCreditRules ?? listElearningCreditRules
  const getWallet = deps.getElearningCreditWallet ?? getElearningCreditWallet
  const adjustCredit = deps.adjustElearningCredit ?? adjustElearningCreditPostgres

  router.get(
    '/api/elearning/admin/credit-rules',
    gate,
    context,
    deps.adminGuard,
    run(async (req, res) => {
      const orgId = deps.orgId(req)
      if (!orgId) {
        res.status(403).json({ error: 'ORG_CONTEXT_REQUIRED' })
        return
      }
      try {
        const rules = await list(deps.db, orgId)
        res.status(200).json({ items: rules.map(ruleDto) })
      } catch (error) {
        sendError(res, error)
      }
    }),
  )

  router.post(
    '/api/elearning/admin/credit-rules',
    gate,
    context,
    deps.adminGuard,
    parseJson,
    run(async (req, res) => {
      const actorId = deps.viewerId(req)
      const orgId = deps.orgId(req)
      const body = readObject(req.body)
      if (!actorId || !orgId || !body || !exactKeys(body, RULE_KEYS)) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      try {
        const result = await publish(deps.db, {
          orgId,
          actorId,
          requestId: body.requestId as string,
          behavior: body.behavior,
          points: body.points,
          dailyCap: body.dailyCap,
          timeZone: body.timeZone,
        })
        res.status(200).json(ruleDto(result))
      } catch (error) {
        sendError(res, error)
      }
    }),
  )

  router.post(
    '/api/elearning/admin/credits/adjustments',
    gate,
    context,
    deps.adminGuard,
    parseJson,
    run(async (req, res) => {
      const actorId = deps.viewerId(req)
      const orgId = deps.orgId(req)
      const body = readObject(req.body)
      if (!actorId || !orgId || !body || !exactKeys(body, ADJUSTMENT_KEYS)) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      try {
        const result = await adjustCredit(deps.db, {
          orgId,
          actorId,
          requestId: body.requestId,
          userId: body.userId,
          points: body.points,
          reason: body.reason,
        }, deps.env ?? process.env)
        res.status(200).json(adjustmentDto(result))
      } catch (error) {
        sendError(res, error)
      }
    }),
  )

  const wallet = (admin: boolean): RequestHandler => run(async (req, res) => {
    const orgId = deps.orgId(req)
    const viewerId = deps.viewerId(req)
    const query = walletQuery(req, admin)
    if (!orgId || !viewerId || !query) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }
    try {
      const result = await getWallet(deps.db, {
        orgId,
        userId: admin ? query.userId! : viewerId,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      })
      res.status(200).json({
        userId: result.userId,
        balancePoints: result.balancePoints,
        items: result.items.map(walletItemDto),
        nextCursor: result.nextCursor,
      })
    } catch (error) {
      sendError(res, error)
    }
  })

  router.get(
    '/api/elearning/credits/wallet',
    gate,
    context,
    deps.readGuard,
    wallet(false),
  )
  router.get(
    '/api/elearning/admin/credits/wallet',
    gate,
    context,
    deps.adminGuard,
    wallet(true),
  )

  return router
}
