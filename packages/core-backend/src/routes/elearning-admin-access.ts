import { json, Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express'

import { isElearningAssignmentSurfaceEnabled } from '../elearning/feature-flags'
import {
  ElearningAdminAccessError,
  replaceElearningAdminScopes,
  replaceElearningObjectAcl,
  type ElearningAdminAccessDb,
} from '../services/elearning-admin-access'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ADMIN_SCOPE_KEYS = new Set(['reason', 'scopes'])
const COLLABORATOR_KEYS = new Set(['reason', 'actions'])
const jsonParser = json({ limit: 16 * 1024 })

const ERROR_STATUS: Record<ElearningAdminAccessError['code'], number> = {
  invalid_input: 400,
  not_found: 404,
  forbidden: 403,
  scope_required: 403,
  target_out_of_scope: 403,
  unavailable: 503,
}

export interface ElearningAdminAccessRouteDeps {
  db: ElearningAdminAccessDb
  env?: NodeJS.ProcessEnv
  adminGuard: RequestHandler
  writeGuard: RequestHandler
  viewerId(req: Request): string | null
  orgId(req: Request): string | null
  isGlobalAdmin(req: Request): boolean
  replaceElearningAdminScopes?: typeof replaceElearningAdminScopes
  replaceElearningObjectAcl?: typeof replaceElearningObjectAcl
}

function normalizeStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

/**
 * Uses only the authentication middleware's hydrated role/permission fields.
 * Raw token `perms` claims are deliberately excluded.
 */
export function isElearningGlobalAdminRequest(req: Request): boolean {
  if (req.user?.role === 'admin') return true
  if (normalizeStrings(req.user?.roles).includes('admin')) return true
  const permissions = normalizeStrings(req.user?.permissions)
  return permissions.some((permission) => (
    permission === 'elearning:admin'
    || permission === 'elearning:*'
    || permission === '*:*'
  ))
}

function parseJson(req: Request, res: Response, next: NextFunction): void {
  jsonParser(req, res, (error?: unknown) => {
    if (!error) return next()
    res.status(400).json({ error: 'invalid_input' })
  })
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function hasExactKeys(
  body: Record<string, unknown>,
  required: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(body)
  return keys.length === required.size && keys.every((key) => required.has(key))
}

function uuidParam(req: Request, name: string): string | null {
  const value = (req.params as Record<string, unknown>)[name]
  return typeof value === 'string' && UUID_RE.test(value) ? value.toLowerCase() : null
}

function textParam(req: Request, name: string): string | null {
  const value = (req.params as Record<string, unknown>)[name]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof ElearningAdminAccessError) {
    res.status(ERROR_STATUS[error.code]).json({ error: error.code })
    return
  }
  res.status(500).json({ error: 'internal_error' })
}

export function createElearningAdminAccessRouter(
  deps: ElearningAdminAccessRouteDeps,
): Router | null {
  const env = deps.env ?? process.env
  if (!isElearningAssignmentSurfaceEnabled(env)) return null

  const replaceScopes = deps.replaceElearningAdminScopes ?? replaceElearningAdminScopes
  const replaceAcl = deps.replaceElearningObjectAcl ?? replaceElearningObjectAcl
  const router = Router()

  const requireAssignment = (
    _req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (!isElearningAssignmentSurfaceEnabled(deps.env ?? process.env)) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    next()
  }

  const requireContext = (
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
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

  const run = (
    handler: (req: Request, res: Response) => Promise<void>,
  ): RequestHandler => (req, res): void => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' })
    })
  }

  router.put(
    '/api/elearning/admin-scopes/:userId',
    requireAssignment,
    requireContext,
    deps.adminGuard,
    parseJson,
    run(async (req, res) => {
      const actorId = deps.viewerId(req)
      const orgId = deps.orgId(req)
      const targetUserId = textParam(req, 'userId')
      const body = readObject(req.body)
      if (!actorId || !orgId || !targetUserId || !body || !hasExactKeys(body, ADMIN_SCOPE_KEYS)) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      try {
        const value = await replaceScopes(deps.db, {
          orgId,
          actorId,
          targetUserId,
          reason: body.reason as string,
          scopes: body.scopes,
        })
        res.status(200).json(value)
      } catch (error) {
        sendError(res, error)
      }
    }),
  )

  const collaborator = (objectType: 'course' | 'training_plan'): RequestHandler => run(
    async (req, res) => {
      const actorId = deps.viewerId(req)
      const orgId = deps.orgId(req)
      const objectId = uuidParam(req, objectType === 'course' ? 'courseId' : 'planId')
      const granteeUserId = textParam(req, 'userId')
      const body = readObject(req.body)
      if (!actorId || !orgId || !objectId || !granteeUserId || !body
        || !hasExactKeys(body, COLLABORATOR_KEYS)) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      try {
        const value = await replaceAcl(deps.db, {
          orgId,
          actorId,
          isGlobalAdmin: deps.isGlobalAdmin(req),
          object: objectType === 'course'
            ? { courseId: objectId }
            : { trainingPlanId: objectId },
          granteeUserId,
          reason: body.reason as string,
          actions: body.actions,
        })
        res.status(200).json(value)
      } catch (error) {
        sendError(res, error)
      }
    },
  )

  router.put(
    '/api/elearning/courses/:courseId/collaborators/:userId',
    requireAssignment,
    requireContext,
    deps.writeGuard,
    parseJson,
    collaborator('course'),
  )
  router.put(
    '/api/elearning/training-plans/:planId/collaborators/:userId',
    requireAssignment,
    requireContext,
    deps.writeGuard,
    parseJson,
    collaborator('training_plan'),
  )

  return router
}
