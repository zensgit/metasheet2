import {
  json,
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express'

import { isElearningContentSurfaceEnabled } from '../elearning/feature-flags'
import {
  ElearningPortalSettingsError,
  getActiveElearningPortalSettings,
  publishElearningPortalSettings,
  type ElearningPortalDb,
  type ElearningPortalSettings,
} from '../services/elearning-portal-settings'

const PUBLISH_KEYS = new Set([
  'requestId',
  'siteName',
  'tagline',
  'bannerUrl',
  'navigation',
])
const jsonParser = json({ limit: 16 * 1024 })

export interface ElearningPortalRouteDeps {
  db: ElearningPortalDb
  env?: NodeJS.ProcessEnv
  readGuard: RequestHandler
  adminGuard: RequestHandler
  viewerId(req: Request): string | null
  orgId(req: Request): string | null
  getActiveElearningPortalSettings?: typeof getActiveElearningPortalSettings
  publishElearningPortalSettings?: typeof publishElearningPortalSettings
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function exactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.size && actual.every((key) => keys.has(key))
}

function parseJson(req: Request, res: Response, next: NextFunction): void {
  jsonParser(req, res, (error?: unknown) => {
    if (!error) return next()
    res.status(400).json({ error: 'invalid_input' })
  })
}

function requireContext(deps: ElearningPortalRouteDeps): RequestHandler {
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

function requireContent(deps: ElearningPortalRouteDeps): RequestHandler {
  return (_req, res, next): void => {
    if (!isElearningContentSurfaceEnabled(deps.env ?? process.env)) {
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
  if (error instanceof ElearningPortalSettingsError) {
    const status = error.code === 'invalid_input'
      ? 400
      : error.code === 'conflict'
        ? 409
        : 503
    res.status(status).json({ error: error.code })
    return
  }
  res.status(500).json({ error: 'internal_error' })
}

function portalDto(settings: ElearningPortalSettings) {
  return {
    revisionId: settings.revisionId,
    version: settings.version,
    siteName: settings.siteName,
    tagline: settings.tagline,
    bannerUrl: settings.bannerUrl,
    navigation: settings.navigation.map((item) => ({
      label: item.label,
      href: item.href,
    })),
    createdAt: settings.createdAt,
  }
}

export function createElearningPortalRouter(
  deps: ElearningPortalRouteDeps,
): Router | null {
  if (!isElearningContentSurfaceEnabled(deps.env ?? process.env)) return null

  const router = Router()
  const context = requireContext(deps)
  const content = requireContent(deps)
  const getSettings = deps.getActiveElearningPortalSettings
    ?? getActiveElearningPortalSettings
  const publishSettings = deps.publishElearningPortalSettings
    ?? publishElearningPortalSettings

  router.get(
    '/api/elearning/portal',
    context,
    content,
    deps.readGuard,
    run(async (req, res) => {
      const orgId = deps.orgId(req)
      if (!orgId) {
        res.status(403).json({ error: 'ORG_CONTEXT_REQUIRED' })
        return
      }
      try {
        res.status(200).json(portalDto(await getSettings(deps.db, orgId)))
      } catch (error) {
        sendError(res, error)
      }
    }),
  )

  router.put(
    '/api/elearning/admin/portal',
    context,
    content,
    deps.adminGuard,
    parseJson,
    run(async (req, res) => {
      const orgId = deps.orgId(req)
      const actorId = deps.viewerId(req)
      if (!orgId) {
        res.status(403).json({ error: 'ORG_CONTEXT_REQUIRED' })
        return
      }
      if (!actorId) {
        res.status(401).json({ error: 'unauthenticated' })
        return
      }
      const body = readObject(req.body)
      if (!body || !exactKeys(body, PUBLISH_KEYS)) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      try {
        const result = await publishSettings(deps.db, {
          orgId,
          actorId,
          requestId: body.requestId as string,
          siteName: body.siteName,
          tagline: body.tagline,
          bannerUrl: body.bannerUrl,
          navigation: body.navigation,
        })
        res.status(200).json({ ...portalDto(result), duplicate: result.duplicate })
      } catch (error) {
        sendError(res, error)
      }
    }),
  )

  return router
}
