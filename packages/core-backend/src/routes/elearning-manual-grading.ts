import {
  json,
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express'

import { isElearningAssessmentSurfaceEnabled } from '../elearning/feature-flags'
import {
  ElearningAdminAccessError,
  type ElearningAdminAccessErrorCode,
} from '../services/elearning-admin-access'
import {
  ELEARNING_MANUAL_GRADE_COMMENT_MAX,
  ElearningManualGradingError,
  submitElearningManualGrade,
  type ElearningManualGradingDb,
} from '../services/elearning-manual-grading'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MANUAL_GRADE_KEYS = new Set([
  'requestId',
  'questionRevisionId',
  'score',
  'comment',
])
const jsonParser = json({ limit: 16 * 1024 })

const GRADING_ERROR_STATUS: Record<
  ElearningManualGradingError['code'],
  number
> = {
  invalid_input: 400,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
}

const ADMIN_ACCESS_STATUS: Record<ElearningAdminAccessErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  forbidden: 403,
  scope_required: 403,
  target_out_of_scope: 403,
  unavailable: 503,
}

export interface ElearningManualGradingRouteDeps {
  db: ElearningManualGradingDb
  env?: NodeJS.ProcessEnv
  gradeGuard: RequestHandler
  viewerId(req: Request): string | null
  orgId(req: Request): string | null
  isGlobalAdmin(req: Request): boolean
  submitElearningManualGrade?: typeof submitElearningManualGrade
}

function parseJson(req: Request, res: Response, next: NextFunction): void {
  jsonParser(req, res, (error?: unknown) => {
    if (!error) return next()
    if (!req.readableEnded) req.resume()
    const parseError = error as { status?: unknown; type?: unknown }
    if (parseError.status === 413 || parseError.type === 'entity.too.large') {
      res.status(413).json({ error: 'payload_too_large' })
      return
    }
    res.status(400).json({ error: 'invalid_input' })
  })
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function hasExactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value)
  return keys.length === MANUAL_GRADE_KEYS.size
    && keys.every((key) => MANUAL_GRADE_KEYS.has(key))
}

function uuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value)
    ? value.toLowerCase()
    : null
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof ElearningManualGradingError) {
    res.status(GRADING_ERROR_STATUS[error.code]).json({ error: error.code })
    return
  }
  if (error instanceof ElearningAdminAccessError) {
    res.status(ADMIN_ACCESS_STATUS[error.code]).json({ error: error.code })
    return
  }
  res.status(500).json({ error: 'internal_error' })
}

export function createElearningManualGradingRouter(
  deps: ElearningManualGradingRouteDeps,
): Router | null {
  if (!isElearningAssessmentSurfaceEnabled(deps.env ?? process.env)) return null

  const submit = deps.submitElearningManualGrade ?? submitElearningManualGrade
  const router = Router()
  const requireAssessment = (
    _req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (!isElearningAssessmentSurfaceEnabled(deps.env ?? process.env)) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    next()
  }
  const requireIdentity = (
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (!deps.viewerId(req)) {
      res.status(401).json({ error: 'unauthenticated' })
      return
    }
    next()
  }
  const requireOrg = (
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
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

  router.post(
    '/api/elearning/assessment/attempts/:attemptId/manual-grades',
    requireAssessment,
    requireIdentity,
    requireOrg,
    deps.gradeGuard,
    parseJson,
    run(async (req, res) => {
      const actorId = deps.viewerId(req)
      const orgId = deps.orgId(req)
      const attemptId = uuid(
        (req.params as Record<string, unknown>).attemptId,
      )
      const body = readObject(req.body)
      if (!actorId || !orgId || !attemptId || !body || !hasExactKeys(body)) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      const requestId = uuid(body.requestId)
      const questionRevisionId = uuid(body.questionRevisionId)
      if (
        !requestId
        || !questionRevisionId
        || typeof body.score !== 'number'
        || !Number.isFinite(body.score)
        || !Number.isSafeInteger(body.score)
        || body.score < 0
        || !(body.comment === null || typeof body.comment === 'string')
        || (typeof body.comment === 'string'
          && body.comment.length > ELEARNING_MANUAL_GRADE_COMMENT_MAX)
      ) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      try {
        const result = await submit(deps.db, {
          orgId,
          actorId,
          isGlobalAdmin: deps.isGlobalAdmin(req),
          attemptId,
          questionRevisionId,
          requestId,
          score: body.score,
          comment: body.comment,
        })
        res.status(200).json({
          attemptId: result.attemptId,
          questionRevisionId: result.questionRevisionId,
          score: result.score,
          maxScore: result.maxScore,
          status: result.status,
          gradedQuestions: result.gradedQuestions,
          manualQuestions: result.manualQuestions,
          autoScore: result.autoScore,
          manualScore: result.manualScore,
          totalScore: result.totalScore,
          passed: result.passed,
          duplicate: result.duplicate,
        })
      } catch (error) {
        sendError(res, error)
      }
    }),
  )

  return router
}
