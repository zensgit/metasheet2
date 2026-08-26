import {
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
  ELEARNING_MANUAL_GRADING_PAGE_DEFAULT,
  ELEARNING_MANUAL_GRADING_PAGE_MAX,
  ELEARNING_MANUAL_GRADING_PAGE_SIZE_DEFAULT,
  ELEARNING_MANUAL_GRADING_PAGE_SIZE_MAX,
  ElearningManualGradingReadError,
  getElearningManualGradingDetail,
  listElearningManualGradingQueue,
  type ElearningManualGradingReadDb,
  type ElearningManualGradingReadErrorCode,
  type ElearningManualGradingQuestionDetail,
  type ElearningManualGradingQueueItem,
} from '../services/elearning-manual-grading-read'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PAGE_QUERY_KEYS = new Set(['page', 'pageSize'])

const READ_ERROR_STATUS: Record<ElearningManualGradingReadErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
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

export interface ElearningManualGradingReadRouteDeps {
  db: ElearningManualGradingReadDb
  env?: NodeJS.ProcessEnv
  gradeGuard: RequestHandler
  viewerId(req: Request): string | null
  orgId(req: Request): string | null
  isGlobalAdmin(req: Request): boolean
  listElearningManualGradingQueue?: typeof listElearningManualGradingQueue
  getElearningManualGradingDetail?: typeof getElearningManualGradingDetail
}

function uuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value)
    ? value.toLowerCase()
    : null
}

function positiveQueryInt(
  value: unknown,
  fallback: number,
  max: number,
): number | null {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed <= max ? parsed : null
}

function pagination(req: Request): { page: number; pageSize: number } | null {
  const query = req.query as Record<string, unknown>
  if (Object.keys(query).some((key) => !PAGE_QUERY_KEYS.has(key))) return null
  const page = positiveQueryInt(
    query.page,
    ELEARNING_MANUAL_GRADING_PAGE_DEFAULT,
    ELEARNING_MANUAL_GRADING_PAGE_MAX,
  )
  const pageSize = positiveQueryInt(
    query.pageSize,
    ELEARNING_MANUAL_GRADING_PAGE_SIZE_DEFAULT,
    ELEARNING_MANUAL_GRADING_PAGE_SIZE_MAX,
  )
  return page === null || pageSize === null ? null : { page, pageSize }
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof ElearningManualGradingReadError) {
    res.status(READ_ERROR_STATUS[error.code]).json({ error: error.code })
    return
  }
  if (error instanceof ElearningAdminAccessError) {
    res.status(ADMIN_ACCESS_STATUS[error.code]).json({ error: error.code })
    return
  }
  res.status(500).json({ error: 'internal_error' })
}

function queueItem(item: ElearningManualGradingQueueItem) {
  return {
    attemptId: item.attemptId,
    userId: item.userId,
    examId: item.examId,
    examTitle: item.examTitle,
    courseId: item.courseId,
    courseTitle: item.courseTitle,
    attemptNo: item.attemptNo,
    submittedAt: item.submittedAt,
    autoScore: item.autoScore,
    manualScore: item.manualScore,
    paperMaxScore: item.paperMaxScore,
    gradedQuestions: item.gradedQuestions,
    manualQuestions: item.manualQuestions,
  }
}

function questionDetail(question: ElearningManualGradingQuestionDetail) {
  return {
    questionRevisionId: question.questionRevisionId,
    position: question.position,
    prompt: question.prompt,
    points: question.points,
    learnerAnswer: question.learnerAnswer,
    grade: question.grade
      ? {
          score: question.grade.score,
          maxScore: question.grade.maxScore,
          comment: question.grade.comment,
          graderId: question.grade.graderId,
          gradedAt: question.grade.gradedAt,
        }
      : null,
  }
}

export function createElearningManualGradingReadRouter(
  deps: ElearningManualGradingReadRouteDeps,
): Router | null {
  if (!isElearningAssessmentSurfaceEnabled(deps.env ?? process.env)) return null

  const list =
    deps.listElearningManualGradingQueue ?? listElearningManualGradingQueue
  const get =
    deps.getElearningManualGradingDetail ?? getElearningManualGradingDetail
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

  router.get(
    '/api/elearning/assessment/manual-grading/attempts',
    requireAssessment,
    requireIdentity,
    requireOrg,
    deps.gradeGuard,
    run(async (req, res) => {
      const actorId = deps.viewerId(req)
      const orgId = deps.orgId(req)
      const page = pagination(req)
      if (!actorId || !orgId || !page) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      try {
        const result = await list(deps.db, {
          orgId,
          actorId,
          isGlobalAdmin: deps.isGlobalAdmin(req),
          page: page.page,
          pageSize: page.pageSize,
        })
        res.status(200).json({
          items: result.items.map(queueItem),
          page: result.page,
          pageSize: result.pageSize,
          hasMore: result.hasMore,
        })
      } catch (error) {
        sendError(res, error)
      }
    }),
  )

  router.get(
    '/api/elearning/assessment/manual-grading/attempts/:attemptId',
    requireAssessment,
    requireIdentity,
    requireOrg,
    deps.gradeGuard,
    run(async (req, res) => {
      const actorId = deps.viewerId(req)
      const orgId = deps.orgId(req)
      const attemptId = uuid(
        (req.params as Record<string, unknown>).attemptId,
      )
      if (!actorId || !orgId || !attemptId) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      try {
        const result = await get(deps.db, {
          orgId,
          actorId,
          isGlobalAdmin: deps.isGlobalAdmin(req),
          attemptId,
        })
        res.status(200).json({
          attemptId: result.attemptId,
          userId: result.userId,
          examId: result.examId,
          examTitle: result.examTitle,
          courseId: result.courseId,
          courseTitle: result.courseTitle,
          attemptNo: result.attemptNo,
          status: result.status,
          submittedAt: result.submittedAt,
          autoScore: result.autoScore,
          manualScore: result.manualScore,
          paperMaxScore: result.paperMaxScore,
          passScore: result.passScore,
          gradedQuestions: result.gradedQuestions,
          manualQuestions: result.manualQuestions,
          questions: result.questions.map(questionDetail),
        })
      } catch (error) {
        sendError(res, error)
      }
    }),
  )

  return router
}
