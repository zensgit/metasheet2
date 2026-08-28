import type { Request, Response, Router } from 'express'
import { z } from 'zod'

import {
  RecoveryArchiveRestoreJobError,
  type RecoveryArchiveRestoreJobQuery,
  type RecoveryArchiveRestoreJobSnapshot,
} from '../multitable/recovery-archive-restore-jobs'
import type { RecoveryArchiveRestorePlan } from '../multitable/recovery-archive-restore-plan'

const EMPTY_BODY_SCHEMA = z.object({}).strict()
const ACCEPT_BODY_SCHEMA = z.object({
  previewIdentity: z.string().trim().min(1),
  plan: z.record(z.unknown()),
}).strict()
const JOB_ID_SCHEMA = z.string().uuid()

export interface RecoveryArchiveRestoreOwnerContext {
  readonly workspaceId: string
  readonly baseId: string
  readonly sheetId: string
  readonly actorId: string
  readonly recheckAuthority: (query: RecoveryArchiveRestoreJobQuery) => Promise<boolean>
}

export type RecoveryArchiveRestoreOwnerContextResolution =
  | { readonly ok: true; readonly context: RecoveryArchiveRestoreOwnerContext }
  | {
      readonly ok: false
      readonly status: 401 | 403 | 404 | 503
      readonly code:
        | 'UNAUTHENTICATED'
        | 'FORBIDDEN'
        | 'NOT_FOUND'
        | 'RECOVERY_ARCHIVE_SCOPE_UNAVAILABLE'
    }

export interface RecoveryArchiveRestoreOwnerService {
  readonly accept?: (
    context: RecoveryArchiveRestoreOwnerContext,
    input: { readonly token: string; readonly plan: RecoveryArchiveRestorePlan },
  ) => Promise<RecoveryArchiveRestoreJobSnapshot>
  readonly read: (
    context: RecoveryArchiveRestoreOwnerContext,
    jobId: string,
  ) => Promise<RecoveryArchiveRestoreJobSnapshot>
  readonly resume: (
    context: RecoveryArchiveRestoreOwnerContext,
    jobId: string,
  ) => Promise<RecoveryArchiveRestoreJobSnapshot>
  readonly cancel?: (
    context: RecoveryArchiveRestoreOwnerContext,
    jobId: string,
  ) => Promise<RecoveryArchiveRestoreJobSnapshot>
}

export interface RecoveryArchiveRestoreOwnerRouteDependencies {
  readonly resolveContext: (
    req: Request,
    sheetId: string,
  ) => Promise<RecoveryArchiveRestoreOwnerContextResolution>
  readonly service: RecoveryArchiveRestoreOwnerService
}

export function registerRecoveryArchiveRestoreOwnerRoutes(
  router: Router,
  dependencies: RecoveryArchiveRestoreOwnerRouteDependencies,
): void {
  router.post('/sheets/:sheetId/recovery-archive/jobs/accept', async (req, res) => {
    const parsed = ACCEPT_BODY_SCHEMA.safeParse(req.body ?? {})
    if (!parsed.success || !hasNoQuery(req)) return sendValidationError(res)
    const context = await resolveContext(req, res, dependencies)
    if (!context) return
    if (!dependencies.service.accept) {
      return sendError(res, 503, 'RECOVERY_ARCHIVE_RUNTIME_UNAVAILABLE')
    }
    try {
      const snapshot = await dependencies.service.accept(context, {
        token: parsed.data.previewIdentity,
        plan: parsed.data.plan as unknown as RecoveryArchiveRestorePlan,
      })
      return res.status(202).json({ ok: true, data: projectSnapshot(snapshot) })
    } catch (error) {
      return sendServiceError(res, error)
    }
  })

  router.get('/sheets/:sheetId/recovery-archive/jobs/:jobId', async (req, res) => {
    const jobId = parseJobId(req)
    if (!jobId || !hasNoQuery(req)) return sendValidationError(res)
    const context = await resolveContext(req, res, dependencies)
    if (!context) return
    try {
      const snapshot = await dependencies.service.read(context, jobId)
      return res.json({ ok: true, data: projectSnapshot(snapshot) })
    } catch (error) {
      return sendServiceError(res, error)
    }
  })

  router.post('/sheets/:sheetId/recovery-archive/jobs/:jobId/resume', async (req, res) => {
    const jobId = parseJobId(req)
    if (!jobId || !hasNoQuery(req) || !EMPTY_BODY_SCHEMA.safeParse(req.body ?? {}).success) {
      return sendValidationError(res)
    }
    const context = await resolveContext(req, res, dependencies)
    if (!context) return
    try {
      const snapshot = await dependencies.service.resume(context, jobId)
      return res.json({ ok: true, data: projectSnapshot(snapshot) })
    } catch (error) {
      return sendServiceError(res, error)
    }
  })

  router.post('/sheets/:sheetId/recovery-archive/jobs/:jobId/cancel', async (req, res) => {
    const jobId = parseJobId(req)
    if (!jobId || !hasNoQuery(req) || !EMPTY_BODY_SCHEMA.safeParse(req.body ?? {}).success) {
      return sendValidationError(res)
    }
    const context = await resolveContext(req, res, dependencies)
    if (!context) return
    if (!dependencies.service.cancel) {
      return sendError(res, 503, 'RECOVERY_ARCHIVE_RUNTIME_UNAVAILABLE')
    }
    try {
      const snapshot = await dependencies.service.cancel(context, jobId)
      return res.json({ ok: true, data: projectSnapshot(snapshot) })
    } catch (error) {
      return sendServiceError(res, error)
    }
  })
}

function parseJobId(req: Request): string | null {
  const parsed = JOB_ID_SCHEMA.safeParse(req.params.jobId)
  return parsed.success ? parsed.data : null
}

function hasNoQuery(req: Request): boolean {
  return Object.keys(req.query).length === 0
}

async function resolveContext(
  req: Request,
  res: Response,
  dependencies: RecoveryArchiveRestoreOwnerRouteDependencies,
): Promise<RecoveryArchiveRestoreOwnerContext | null> {
  const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
  if (!sheetId) {
    sendValidationError(res)
    return null
  }
  try {
    const resolved = await dependencies.resolveContext(req, sheetId)
    if (resolved.ok === true) return resolved.context
    sendError(res, resolved.status, resolved.code)
    return null
  } catch {
    sendError(res, 500, 'INTERNAL_ERROR')
    return null
  }
}

function projectSnapshot(snapshot: RecoveryArchiveRestoreJobSnapshot) {
  return {
    jobId: snapshot.id,
    state: snapshot.state,
    totalCount: snapshot.totalCount,
    completedCount: snapshot.completedCount,
    resumeDeadline: snapshot.resumeDeadline,
    terminalAt: snapshot.terminalAt,
    rowVersion: snapshot.rowVersion,
  }
}

function sendValidationError(res: Response) {
  return sendError(res, 400, 'VALIDATION_ERROR')
}

function sendServiceError(res: Response, error: unknown) {
  if (!(error instanceof RecoveryArchiveRestoreJobError)) {
    return sendError(res, 500, 'INTERNAL_ERROR')
  }
  switch (error.code) {
    case 'RECOVERY_ARCHIVE_RESTORE_JOB_NOT_FOUND':
      return sendError(res, 404, error.code)
    case 'RECOVERY_ARCHIVE_RESTORE_JOB_AUTHORITY_DENIED':
      return sendError(res, 403, error.code)
    case 'RECOVERY_ARCHIVE_RESTORE_JOB_PERSISTENCE_INVALID':
      return sendError(res, 503, error.code)
    case 'RECOVERY_ARCHIVE_RESTORE_JOB_INVALID_INPUT':
      return sendError(res, 400, error.code)
    default:
      return sendError(res, 409, error.code)
  }
}

function sendError(res: Response, status: number, code: string) {
  const message = code === 'VALIDATION_ERROR'
    ? 'Request shape is invalid.'
    : code === 'UNAUTHENTICATED'
      ? 'Authentication required.'
      : code === 'FORBIDDEN' || code === 'RECOVERY_ARCHIVE_RESTORE_JOB_AUTHORITY_DENIED'
        ? 'Insufficient permissions.'
        : code === 'NOT_FOUND' || code === 'RECOVERY_ARCHIVE_RESTORE_JOB_NOT_FOUND'
          ? 'Recovery job not found.'
          : code === 'RECOVERY_ARCHIVE_RUNTIME_UNAVAILABLE'
            ? 'Archive recovery runtime is unavailable.'
            : code === 'RECOVERY_ARCHIVE_SCOPE_UNAVAILABLE'
              ? 'Archive recovery scope is unavailable.'
              : code === 'INTERNAL_ERROR'
                ? 'Archive recovery request failed.'
                : 'Recovery job state no longer permits this operation.'
  return res.status(status).json({ ok: false, error: { code, message } })
}
