import { Router, type NextFunction, type Request, type Response } from 'express'
import jwt from 'jsonwebtoken'
import { ZodError } from 'zod'
import { authenticate } from '../middleware/auth'
import {
  EcoCollaborationSnapshotError,
  EcoCollaborationSnapshotService,
  type EcoCollaborationSnapshotDependencies,
} from '../multitable/plm-collaboration-snapshot-service'
import { EcoCollaborationSourceError } from '../multitable/plm-collaboration-snapshot-wire'
import { ReadinessCollaborationSourceError } from '../multitable/plm-collaboration-readiness-wire'

export function createPlmCollaborationSnapshotsRouter(deps: EcoCollaborationSnapshotDependencies): Router {
  const router = Router()
  const service = new EcoCollaborationSnapshotService(deps)
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    const value = req.headers.authorization ?? ''
    const payload = jwt.decode(value.slice(7))
    if (
      !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) ||
      req.apiTokenId ||
      !payload ||
      typeof payload !== 'object' ||
      ['type', 'typ', 'aud'].some((key) => Object.hasOwn(payload, key))
    ) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED' } })
      return
    }
    next()
  }, authenticate)
  router.use((req, res, next) => {
    if (!req.user?.id) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED' } })
      return
    }
    next()
  })
  const actorOf = (req: Request) => String(req.user?.id)
  router.post('/preview', async (req, res, next) => {
    try {
      res.json({ ok: true, data: await service.preview(actorOf(req), req.body) })
    } catch (error) {
      next(error)
    }
  })
  router.post('/confirm', async (req, res, next) => {
    try {
      res.json({ ok: true, data: await service.confirm(actorOf(req), req.body) })
    } catch (error) {
      next(error)
    }
  })
  router.get('/:id', async (req, res, next) => {
    try {
      res.json({ ok: true, data: await service.get(actorOf(req), String(req.params.id), req.query) })
    } catch (error) {
      next(error)
    }
  })
  router.post('/:id/refresh', async (req, res, next) => {
    try {
      res.json({ ok: true, data: await service.refresh(actorOf(req), String(req.params.id), req.body ?? null) })
    } catch (error) {
      next(error)
    }
  })
  router.post('/:id/disable', async (req, res, next) => {
    try {
      res.json({ ok: true, data: await service.disable(actorOf(req), String(req.params.id), req.body ?? null) })
    } catch (error) {
      next(error)
    }
  })
  router.use((
    error: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    res.setHeader('Cache-Control', 'no-store')
    const known = error instanceof EcoCollaborationSnapshotError
      || error instanceof EcoCollaborationSourceError
      || error instanceof ReadinessCollaborationSourceError
    res.status(known ? error.status : error instanceof ZodError ? 422 : 503).json({
      ok: false,
      error: {
        code: known
          ? error.code
          : error instanceof ZodError
            ? 'ECO_REQUEST_INVALID'
            : 'ECO_RUNTIME_UNAVAILABLE',
      },
    })
  })
  return router
}
