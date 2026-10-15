import { Router } from 'express'
import jwt from 'jsonwebtoken'
import { z, ZodError } from 'zod'
import { authenticate } from '../middleware/auth'
import type { PlmPersonalApprovalBindingService } from '../services/PlmPersonalApprovalBindingService'
import {
  PlmPersonalApprovalError,
  requirePlmApprovalCard,
} from '../services/plm-personal-approval-wire'
export function createPlmApprovalBindingsRouter(
  service: PlmPersonalApprovalBindingService,
): Router {
  const router = Router()
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      requirePlmApprovalCard()
      next()
    } catch {
      res.status(404).json({ ok: false, error: { code: 'PLM_CARD_DISABLED' } })
    }
  })
  // Explicit login bearer guard, independently of the global gate's API-token exceptions.
  router.use((req, res, next) => {
    const value = req.headers.authorization ?? ''
    const payload = jwt.decode(value.slice(7))
    // Decode only to reject non-login families; authenticate below still verifies signature/session.
    const purposeBound = !payload || typeof payload !== 'object' || ['type', 'typ', 'aud'].some((key) => Object.hasOwn(payload, key))
    if (purposeBound || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) || req.apiTokenId) {
      res.status(401).json({ ok: false, error: { code: 'PLM_CARD_UNAUTHORIZED' } })
      return
    }
    next()
  }, authenticate)
  router.use((req, res, next) => {
    if (!req.user?.id) {
      res.status(401).json({ ok: false, error: { code: 'PLM_CARD_UNAUTHORIZED' } })
      return
    }
    next()
  })
  const empty = z.object({}).strict(),
    id = z.string().uuid()
  router.get('/', async (req, res, next) => {
    try {
      res.json({ ok: true, data: await service.list(String(req.user!.id)) })
    } catch (e) {
      next(e)
    }
  })
  router.post('/', async (req, res, next) => {
    try {
      res.status(201).json({ ok: true, data: await service.bind(String(req.user!.id), req.body) })
    } catch (e) {
      next(e)
    }
  })
  router.delete('/:id', async (req, res, next) => {
    try {
      await service.unbind(String(req.user!.id), id.parse(req.params.id))
      res.sendStatus(204)
    } catch (e) {
      next(e)
    }
  })
  router.post('/:id/sync', async (req, res, next) => {
    try {
      empty.parse(req.body)
      res.json({
        ok: true,
        data: await service.sync(String(req.user!.id), id.parse(req.params.id)),
      })
    } catch (e) {
      next(e)
    }
  })
  router.post('/:id/reconcile', async (req, res, next) => {
    try {
      empty.parse(req.body)
      res.json({
        ok: true,
        data: await service.reconcile(String(req.user!.id), id.parse(req.params.id)),
      })
    } catch (e) {
      next(e)
    }
  })
  router.use(
    (
      error: unknown,
      _req: import('express').Request,
      res: import('express').Response,
      _next: import('express').NextFunction,
    ) => {
      const known = error instanceof PlmPersonalApprovalError
      res
        .status(known ? error.status : error instanceof ZodError ? 422 : 503)
        .json({
          ok: false,
          error: {
            code: known
              ? error.code
              : error instanceof ZodError
                ? 'PLM_CARD_INVALID_INPUT'
                : 'PLM_PROVIDER_UNAVAILABLE',
          },
        })
    },
  )
  return router
}
