import { Router } from 'express'
import { z, ZodError } from 'zod'
import { authenticate } from '../middleware/auth'
import type { PlmPersonalBomWriteBindingService } from '../services/PlmPersonalBomWriteBindingService'
import {
  personalBomWriteActor,
  personalBomWriteOwnerId,
  rejectPersonalBomWriteCredential,
} from '../services/plm-personal-bom-write-http'
import { PlmPersonalBomWriteError } from '../services/plm-personal-bom-write-wire'

const CALLER_IDENTITY_KEYS = [
  'owner',
  'ownerId',
  'subject',
  'subjectId',
  'origin',
  'tenant',
  'tenantId',
  'nativePerson',
  'native_person',
] as const

function rejectsCallerIdentity(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  return CALLER_IDENTITY_KEYS.some((key) => Object.prototype.hasOwnProperty.call(body, key))
}

export function createPlmPersonalBomWriteBindingsRouter(
  service: PlmPersonalBomWriteBindingService,
): Router {
  const router = Router()
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })
  router.use((req, res, next) => {
    if (rejectPersonalBomWriteCredential(req)) {
      res.status(401).json({ ok: false, error: { code: 'PLM_BOM_WRITE_UNAUTHORIZED' } })
      return
    }
    next()
  }, authenticate)
  router.use((req, res, next) => {
    try {
      personalBomWriteOwnerId(req)
      next()
    } catch (error) {
      next(error)
    }
  })

  router.get('/', async (req, res, next) => {
    try {
      res.json({ ok: true, data: await service.list(personalBomWriteActor(req)) })
    } catch (error) {
      next(error)
    }
  })

  router.get('/management-url', async (req, res, next) => {
    try {
      const dataSourceId = req.query.dataSourceId
      if (typeof dataSourceId !== 'string' || dataSourceId.length < 1) {
        throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
      }
      const url = await service.managementUrl(personalBomWriteActor(req), dataSourceId)
      res.json({ ok: true, data: { url } })
    } catch (error) {
      next(error)
    }
  })

  router.post('/', async (req, res, next) => {
    try {
      if (rejectsCallerIdentity(req.body)) throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
      res.status(201).json({ ok: true, data: await service.bind(personalBomWriteActor(req), req.body) })
    } catch (error) {
      next(error)
    }
  })

  router.post('/retired-revocations/retry', async (req, res, next) => {
    try {
      z.object({}).strict().parse(req.body ?? {})
      await service.retryRetiredRevocations(personalBomWriteOwnerId(req))
      res.json({ ok: true })
    } catch (error) {
      next(error)
    }
  })

  router.delete('/:id', async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id)
      res.json({ ok: true, data: await service.unbind(personalBomWriteOwnerId(req), id) })
    } catch (error) {
      next(error)
    }
  })

  router.use(
    (
      error: unknown,
      _req: import('express').Request,
      res: import('express').Response,
      _next: import('express').NextFunction,
    ) => {
      const known = error instanceof PlmPersonalBomWriteError
      res.status(known ? error.status : error instanceof ZodError ? 422 : 503).json({
        ok: false,
        error: {
          code: known
            ? error.code
            : error instanceof ZodError
              ? 'PLM_BOM_WRITE_INVALID'
              : 'PLM_BOM_WRITE_UNAVAILABLE',
        },
      })
    },
  )
  return router
}
