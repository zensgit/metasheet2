import { Router } from 'express'
import jwt from 'jsonwebtoken'
import { z, ZodError } from 'zod'
import { authenticate } from '../middleware/auth'
import { PlmManagedSnapshotShareFlow } from '../services/plm-managed-snapshot-share-flow'
import { ManagedCompanionRefusal } from '../services/plm-managed-companion'
import {
  PlmBomReviewService,
  type BomReviewDependencies,
} from '../multitable/plm-bom-review-service'
import {
  BomReviewError,
  requireBomReview,
} from '../multitable/plm-bom-review-wire'
export function createPlmBomReviewsRouter(deps: BomReviewDependencies): Router {
  const router = Router(),
    service = new PlmBomReviewService(deps)
  const shares = new PlmManagedSnapshotShareFlow(deps)
  router.get('/managed-share/targets', authenticate, async (req, res, next) => {
    res.set('Cache-Control', 'no-store')
    try { res.json(await shares.targets(req)) } catch (error) { next(error) }
  })
  router.post('/managed-share/start', authenticate, async (req, res, next) => {
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer')
    try { res.json(await shares.start(req, res)) } catch (error) { next(error) }
  })
  router.post('/managed-share/complete', authenticate, async (req, res, next) => {
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer')
    try { res.json(await shares.complete(req)) } catch (error) { next(error) }
  })
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      requireBomReview()
    } catch (e) {
      next(e)
      return
    }
    const value = req.headers.authorization ?? '',
      payload = jwt.decode(value.slice(7))
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
  const listInput = z
    .object({
      dataSourceId: z.string().min(1).max(128),
      partId: z.string().min(1).max(128),
    })
    .strict()
  const id = z.string().uuid()
  router.post('/change-events', async (req,res,next) => {
    try { res.json({ ok: true,data: await service.receiveChange(String(req.user!.id),req.body) }) }
    catch (e) { next(e) }
  })
  router.get('/:id/change-listener', async (req,res,next) => {
    try { res.json({ ok: true,data: await service.changeListener(String(req.user!.id),id.parse(req.params.id)) }) }
    catch (e) { next(e) }
  })
  router.post('/:id/change-listener', async (req,res,next) => {
    try { res.json({ ok: true,data: await service.changeListener(String(req.user!.id),id.parse(req.params.id),req.body ?? null) }) }
    catch (e) { next(e) }
  })
  router.get('/bases', async (req, res, next) => {
    try {
      res.json({ ok: true, data: await service.bases(String(req.user!.id)) })
    } catch (e) {
      next(e)
    }
  })
  router.post('/preview', async (req, res, next) => {
    try {
      res.json({
        ok: true,
        data: await service.preview(String(req.user!.id), req.body),
      })
    } catch (e) {
      next(e)
    }
  })
  router.post('/', async (req, res, next) => {
    try {
      res.json({
        ok: true,
        data: await service.create(String(req.user!.id), req.body),
      })
    } catch (e) {
      next(e)
    }
  })
  router.get('/', async (req, res, next) => {
    try {
      const q = listInput.parse(req.query)
      res.json({
        ok: true,
        data: await service.list(
          String(req.user!.id),
          q.dataSourceId,
          q.partId,
        ),
      })
    } catch (e) {
      next(e)
    }
  })
  router.get('/:id/notifications', async (req, res, next) => {
    try {
      res.json({ ok: true, data: await service.notifications(String(req.user!.id), id.parse(req.params.id)) })
    } catch (e) { next(e) }
  })
  router.get('/:id/notification-recipients', async (req, res, next) => {
    try {
      const { q } = z.object({ q: z.string().trim().min(1).max(128) }).strict().parse(req.query)
      res.json({ ok: true, data: await service.notificationRecipients(String(req.user!.id), id.parse(req.params.id), q) })
    } catch (e) { next(e) }
  })
  router.get('/:id/completion-webhooks', async (req,res,next) => {
    try { res.json({ ok: true,data: await service.completionWebhooks(String(req.user!.id),id.parse(req.params.id)) }) }
    catch (e) { next(e) }
  })
  router.get('/:id/completion-webhook-destinations', async (req,res,next) => {
    try { res.json({ ok: true,data: await service.completionWebhookDestinations(String(req.user!.id),id.parse(req.params.id)) }) }
    catch (e) { next(e) }
  })
  router.post('/:id/completion-webhooks', async (req,res,next) => {
    try { res.json({ ok: true,data: await service.completionWebhooks(String(req.user!.id),id.parse(req.params.id),req.body ?? null) }) }
    catch (e) { next(e) }
  })
  for (const action of ['refresh', 'disable', 'notifications'] as const)
    router.post(`/:id/${action}`, async (req, res, next) => {
      try {
        res.json({
          ok: true,
          data: await service[action].call(service,
            String(req.user!.id),
            id.parse(req.params.id),
            req.body ?? null,
          ),
        })
      } catch (e) {
        next(e)
      }
    })
  router.use(
    (
      e: unknown,
      _req: import('express').Request,
      res: import('express').Response,
      _next: import('express').NextFunction,
    ) => {
      const known = e instanceof BomReviewError || e instanceof ManagedCompanionRefusal
      res.status(known ? e.status : e instanceof ZodError ? 400 : 503).json({
        ok: false,
        error: {
          code: known
            ? e.code
            : e instanceof ZodError
              ? 'INVALID_REQUEST'
              : 'RUNTIME_UNAVAILABLE',
        },
      })
    },
  )
  return router
}
