import type { Request, Response, Router } from 'express'
import { z } from 'zod'

import {
  RecoveryArchiveCatalogError,
  type RecoveryArchiveCatalogEntry,
  type RecoveryArchiveCatalogPage,
} from '../multitable/recovery-archive-catalog'
import type { EvaluatePlanAuthorization } from '../multitable/exact-anchor-recovery-execute'
import {
  RecoveryArchivePreviewError,
  type RecoveryArchivePreviewResult,
  type RecoveryArchivePreviewScope,
} from '../multitable/recovery-archive-preview'
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
const PREVIEW_SCOPE_SCHEMA = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('whole_sheet') }).strict(),
  z.object({
    kind: z.literal('selected_records'),
    recordIds: z.array(z.string().trim().min(1)).min(1),
  }).strict(),
  z.object({
    kind: z.literal('selected_fields'),
    recordIds: z.array(z.string().trim().min(1)).min(1),
    fieldIds: z.array(z.string().trim().min(1)).min(1),
  }).strict(),
])
const PREVIEW_BODY_SCHEMA = z.object({
  generationId: z.string().uuid(),
  mode: z.enum(['revert', 'reset']),
  scope: PREVIEW_SCOPE_SCHEMA,
}).strict()
const JOB_ID_SCHEMA = z.string().uuid()
const GENERATION_ID_SCHEMA = z.string().uuid()
const CATALOG_QUERY_SCHEMA = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.string().regex(/^[1-9][0-9]{0,2}$/).optional(),
}).strict()

export interface RecoveryArchiveRestoreOwnerContext {
  readonly workspaceId: string
  readonly baseId: string
  readonly sheetId: string
  readonly actorId: string
  readonly recheckAuthority: (query: RecoveryArchiveRestoreJobQuery) => Promise<boolean>
  readonly evaluatePlanAuthorization: EvaluatePlanAuthorization
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
  readonly preview?: (
    context: RecoveryArchiveRestoreOwnerContext,
    input: {
      readonly generationId: string
      readonly mode: 'revert' | 'reset'
      readonly scope: RecoveryArchivePreviewScope
    },
  ) => Promise<RecoveryArchivePreviewResult>
  readonly listCatalog?: (
    context: RecoveryArchiveRestoreOwnerContext,
    input: { readonly cursor?: string; readonly limit?: number },
  ) => Promise<RecoveryArchiveCatalogPage>
  readonly readCatalog?: (
    context: RecoveryArchiveRestoreOwnerContext,
    generationId: string,
  ) => Promise<RecoveryArchiveCatalogEntry>
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
  router.post('/sheets/:sheetId/recovery-archive/preview', async (req, res) => {
    const parsed = PREVIEW_BODY_SCHEMA.safeParse(req.body ?? {})
    if (!parsed.success || !hasNoQuery(req)) return sendValidationError(res)
    const context = await resolveContext(req, res, dependencies)
    if (!context) return
    if (!dependencies.service.preview) {
      return sendError(res, 503, 'RECOVERY_ARCHIVE_RUNTIME_UNAVAILABLE')
    }
    try {
      const result = await dependencies.service.preview(context, {
        generationId: parsed.data.generationId,
        mode: parsed.data.mode,
        scope: parsed.data.scope as RecoveryArchivePreviewScope,
      })
      return res.json({ ok: true, data: projectPreview(result) })
    } catch (error) {
      return sendServiceError(res, error)
    }
  })

  router.get('/sheets/:sheetId/recovery-archive/catalog', async (req, res) => {
    const parsed = CATALOG_QUERY_SCHEMA.safeParse(req.query)
    if (!parsed.success) return sendValidationError(res)
    const limit = parsed.data.limit === undefined ? undefined : Number(parsed.data.limit)
    if (limit !== undefined && limit > 100) return sendValidationError(res)
    const context = await resolveContext(req, res, dependencies)
    if (!context) return
    if (!dependencies.service.listCatalog) {
      return sendError(res, 503, 'RECOVERY_ARCHIVE_RUNTIME_UNAVAILABLE')
    }
    try {
      const page = await dependencies.service.listCatalog(context, {
        ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
        ...(limit === undefined ? {} : { limit }),
      })
      return res.json({
        ok: true,
        data: {
          entries: page.entries.map(projectCatalogEntry),
          nextCursor: page.nextCursor,
        },
      })
    } catch (error) {
      return sendServiceError(res, error)
    }
  })

  router.get('/sheets/:sheetId/recovery-archive/catalog/:generationId', async (req, res) => {
    const generationId = parseGenerationId(req)
    if (!generationId || !hasNoQuery(req)) return sendValidationError(res)
    const context = await resolveContext(req, res, dependencies)
    if (!context) return
    if (!dependencies.service.readCatalog) {
      return sendError(res, 503, 'RECOVERY_ARCHIVE_RUNTIME_UNAVAILABLE')
    }
    try {
      const entry = await dependencies.service.readCatalog(context, generationId)
      return res.json({ ok: true, data: projectCatalogEntry(entry) })
    } catch (error) {
      return sendServiceError(res, error)
    }
  })

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

function parseGenerationId(req: Request): string | null {
  const parsed = GENERATION_ID_SCHEMA.safeParse(req.params.generationId)
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

function projectPreview(result: RecoveryArchivePreviewResult) {
  return {
    generationId: result.generationId,
    mode: result.mode,
    scopeKind: result.scopeKind,
    executionKind: result.executionKind,
    executable: result.executable,
    blockedReason: result.blockedReason,
    previewIdentity: result.previewIdentity,
    summary: result.summary,
  }
}

function projectCatalogEntry(entry: RecoveryArchiveCatalogEntry) {
  return {
    generationId: entry.generationId,
    recoveryPointAt: entry.recoveryPointAt,
    archivedAt: entry.archivedAt,
    expiresAt: entry.expiresAt,
    anchorSeq: entry.anchorSeq,
    coverageRowCount: entry.coverageRowCount,
    superseded: entry.superseded,
  }
}

function sendValidationError(res: Response) {
  return sendError(res, 400, 'VALIDATION_ERROR')
}

function sendServiceError(res: Response, error: unknown) {
  if (error instanceof RecoveryArchivePreviewError) {
    switch (error.code) {
      case 'RECOVERY_ARCHIVE_PREVIEW_INVALID_INPUT':
        return sendValidationError(res)
      case 'RECOVERY_ARCHIVE_PREVIEW_AUTHORITY_DENIED':
        return sendError(res, 403, error.code)
      case 'RECOVERY_ARCHIVE_PREVIEW_NOT_FOUND':
        return sendError(res, 404, error.code)
      case 'RECOVERY_ARCHIVE_PREVIEW_DISABLED':
      case 'RECOVERY_ARCHIVE_PREVIEW_RUNTIME_UNAVAILABLE':
      case 'RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID':
        return sendError(res, 503, error.code)
    }
  }
  if (error instanceof RecoveryArchiveCatalogError) {
    switch (error.code) {
      case 'RECOVERY_ARCHIVE_CATALOG_INVALID_INPUT':
        return sendValidationError(res)
      case 'RECOVERY_ARCHIVE_CATALOG_AUTHORITY_DENIED':
        return sendError(res, 403, error.code)
      case 'RECOVERY_ARCHIVE_CATALOG_NOT_FOUND':
        return sendError(res, 404, error.code)
      case 'RECOVERY_ARCHIVE_CATALOG_DISABLED':
      case 'RECOVERY_ARCHIVE_CATALOG_PERSISTENCE_INVALID':
        return sendError(res, 503, error.code)
    }
  }
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
  const message = messageForErrorCode(code)
  return res.status(status).json({ ok: false, error: { code, message } })
}

function messageForErrorCode(code: string): string {
  switch (code) {
    case 'VALIDATION_ERROR':
      return 'Request shape is invalid.'
    case 'UNAUTHENTICATED':
      return 'Authentication required.'
    case 'FORBIDDEN':
    case 'RECOVERY_ARCHIVE_PREVIEW_AUTHORITY_DENIED':
    case 'RECOVERY_ARCHIVE_RESTORE_JOB_AUTHORITY_DENIED':
    case 'RECOVERY_ARCHIVE_CATALOG_AUTHORITY_DENIED':
      return 'Insufficient permissions.'
    case 'NOT_FOUND':
    case 'RECOVERY_ARCHIVE_RESTORE_JOB_NOT_FOUND':
      return 'Recovery job not found.'
    case 'RECOVERY_ARCHIVE_CATALOG_NOT_FOUND':
    case 'RECOVERY_ARCHIVE_PREVIEW_NOT_FOUND':
      return 'Recovery point not found.'
    case 'RECOVERY_ARCHIVE_PREVIEW_DISABLED':
    case 'RECOVERY_ARCHIVE_CATALOG_DISABLED':
      return 'Archive recovery is disabled.'
    case 'RECOVERY_ARCHIVE_PREVIEW_RUNTIME_UNAVAILABLE':
    case 'RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID':
    case 'RECOVERY_ARCHIVE_CATALOG_PERSISTENCE_INVALID':
      return 'Archive recovery catalog is unavailable.'
    case 'RECOVERY_ARCHIVE_RUNTIME_UNAVAILABLE':
      return 'Archive recovery runtime is unavailable.'
    case 'RECOVERY_ARCHIVE_SCOPE_UNAVAILABLE':
      return 'Archive recovery scope is unavailable.'
    case 'INTERNAL_ERROR':
      return 'Archive recovery request failed.'
    default:
      return 'Recovery job state no longer permits this operation.'
  }
}
