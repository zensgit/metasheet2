import express, { Router, type RequestHandler, type ErrorRequestHandler } from 'express'
import { ZodError } from 'zod'
import { poolManager } from '../integration/db/connection-pool'
import { apiTokenAuth, requireScope } from '../middleware/api-token-auth'
import { apiTokenWriteRateLimit } from '../middleware/rate-limiter'
import { oapiScopeGuard } from '../middleware/oapi-scope-guard'
import { buildOapiAuditContext, oapiWriteAuditBoundary } from '../multitable/oapi-write-audit'
import { receivePlmRecordEvent } from '../multitable/plm-record-ingress-service'
import {
  isPlmRecordIngressEnabled,
  parsePlmRecordEvent,
  PlmIngressError,
} from '../multitable/plm-record-ingress-wire'

const safe =
  (handler: RequestHandler): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next)
  }
const requirePlmApiToken: RequestHandler = (req, res, next) => {
  // apiTokenAuth/requireScope pass JWT callers through; this dedicated route requires mst_ identity.
  if (!req.apiTokenId || !req.apiTokenUserId) {
    res.status(401).json({ error: { code: 'invalid_token' } })
    return
  }
  next()
}
const errors: ErrorRequestHandler = (err, _req, res, _next) => {
  const status =
    err instanceof PlmIngressError
      ? err.status
      : err instanceof ZodError
        ? 400
        : err?.type === 'entity.too.large'
          ? 413
          : err instanceof SyntaxError
            ? 400
            : 503
  const code =
    err instanceof PlmIngressError
      ? err.code
      : status === 400
        ? 'invalid_payload'
        : status === 413
          ? 'payload_too_large'
          : 'ingress_unavailable'
  res.status(status).json({ error: { code } })
}
// Mount before the application's larger JSON parser; never consumes other endpoints' bodies.
export function createPlmRecordIngressBodyParser(): Router | null {
  if (!isPlmRecordIngressEnabled()) return null
  const router = Router()
  router.use(express.json({ limit: '512kb' }), errors)
  return router
}
export function createPlmRecordIngressRouter(): Router | null {
  if (!isPlmRecordIngressEnabled()) return null
  const router = Router()
  router.post(
    '/plm-record-ingress',
    safe(apiTokenAuth),
    requirePlmApiToken,
    oapiWriteAuditBoundary('upsert', 'records:write'),
    apiTokenWriteRateLimit,
    requireScope('records:write'),
    safe(async (req, res, next) => {
      if (!isPlmRecordIngressEnabled()) throw new PlmIngressError(503, 'ingress_unavailable')
      const event = parsePlmRecordEvent(req.body)
      const binding = (
        await poolManager
          .get()
          .query(
            'SELECT sheet_id FROM meta_plm_record_bindings WHERE id=$1 AND token_id=$2 AND creator_id=$3 AND enabled=true',
            [event.binding_id, req.apiTokenId, req.apiTokenUserId],
          )
      ).rows[0]
      if (!binding) throw new PlmIngressError(403, 'binding_unavailable')
      // Server-resolved target only; the strict wire rejects caller sheet/field IDs.
      req.params.sheetId = binding.sheet_id
      next()
    }),
    safe(oapiScopeGuard),
    safe(async (req, res) => {
      const audit = buildOapiAuditContext(req, 'upsert', 'records:write')
      if (!audit) throw new PlmIngressError(401, 'invalid_token')
      const receipt = await receivePlmRecordEvent(poolManager.get(), req.body, audit)
      res.json(receipt)
    }),
  )
  router.use(errors)
  return router
}
