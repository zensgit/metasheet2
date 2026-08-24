/**
 * E-learning V0.1 named-pilot runtime: flag-gated assignment + watch HTTP mount.
 * Synchronous. Zero routes unless master+CONTENT+ASSIGNMENT+MEDIA are exact 'true'.
 * JWT identity wraps /api/elearning; inner full-path router then applies
 * authoritative org, RBAC, 16 KiB JSON, service. No startup DB I/O.
 */
import type { Request, RequestHandler } from 'express'
import { Router, type Router as ExpressRouter } from 'express'

import { isElearningWatchSurfaceEnabled } from '../elearning/feature-flags'
import { authenticate } from '../middleware/auth'
import { rbacGuard } from '../rbac/rbac'
import { createElearningPilotRouter } from '../routes/elearning-pilot'
import type {
  AssignElearningDirectInput,
  ElearningDirectAssignmentDb,
  ElearningDirectAssignmentResult,
} from './elearning-direct-assignment'
import type {
  ElearningWatchDb,
  ElearningWatchState,
  RecordElearningHeartbeatInput,
  StartElearningWatchInput,
} from './elearning-watch-progress'

export interface ElearningPilotRuntime {
  router: ExpressRouter
}

export interface ElearningPilotRuntimeOptions {
  db: ElearningDirectAssignmentDb & ElearningWatchDb
  env?: NodeJS.ProcessEnv
  authenticate?: RequestHandler
  adminGuard?: RequestHandler
  readGuard?: RequestHandler
  viewerId?: (req: Request) => string | null
  orgId?: (req: Request) => string | null
  assignElearningDirect?: (
    db: ElearningDirectAssignmentDb,
    input: AssignElearningDirectInput,
  ) => Promise<ElearningDirectAssignmentResult>
  startElearningWatch?: (
    db: ElearningWatchDb,
    input: StartElearningWatchInput,
  ) => Promise<ElearningWatchState>
  recordElearningHeartbeat?: (
    db: ElearningWatchDb,
    input: RecordElearningHeartbeatInput,
  ) => Promise<ElearningWatchState>
}

function viewerId(req: Request): string | null {
  const candidate = req.user?.id ?? req.user?.userId ?? (req.user as { sub?: unknown } | undefined)?.sub
  return typeof candidate === 'string' && candidate.trim()
    ? candidate.trim()
    : candidate != null && typeof candidate === 'number' && Number.isFinite(candidate)
      ? String(candidate)
      : null
}

/** Authoritative org: JWT-bound req.authenticatedTenantId only. */
function orgId(req: Request): string | null {
  const tenant = req.authenticatedTenantId
  return typeof tenant === 'string' && tenant.trim() ? tenant.trim() : null
}

export function createElearningPilotRuntime(
  opts: ElearningPilotRuntimeOptions,
): ElearningPilotRuntime | null {
  const env = opts.env ?? process.env
  if (!isElearningWatchSurfaceEnabled(env)) return null

  const inner = createElearningPilotRouter({
    db: opts.db,
    viewerId: opts.viewerId ?? viewerId,
    orgId: opts.orgId ?? orgId,
    adminGuard: opts.adminGuard ?? rbacGuard('elearning', 'admin'),
    readGuard: opts.readGuard ?? rbacGuard('elearning', 'read'),
    env,
    assignElearningDirect: opts.assignElearningDirect,
    startElearningWatch: opts.startElearningWatch,
    recordElearningHeartbeat: opts.recordElearningHeartbeat,
  })
  if (!inner) return null

  const router = Router()
  router.use('/api/elearning', opts.authenticate ?? authenticate)
  router.use(inner)
  return { router }
}
