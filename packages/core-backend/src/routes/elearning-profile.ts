import { Router, type Request, type RequestHandler, type Response } from 'express'

import { isElearningCreditSurfaceEnabled } from '../services/elearning-credit-ledger'
import {
  ELEARNING_LEARNING_PROFILE_PAGE_MAX,
  ElearningLearningProfileError,
  getElearningLearningProfile,
  type ElearningLearningProfileDb,
  type ElearningLearningProfileResult,
} from '../services/elearning-learning-profile'

const QUERY_KEYS = new Set(['cursor', 'limit'])

export interface ElearningProfileRouteDeps {
  db: ElearningLearningProfileDb
  env?: NodeJS.ProcessEnv
  readGuard: RequestHandler
  viewerId(req: Request): string | null
  orgId(req: Request): string | null
  getElearningLearningProfile?: typeof getElearningLearningProfile
}

function queryText(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '' || value.length > 512) {
    return null
  }
  return value
}

function queryLimit(value: unknown): number | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed <= ELEARNING_LEARNING_PROFILE_PAGE_MAX
    ? parsed
    : null
}

function dto(result: ElearningLearningProfileResult) {
  return {
    userId: result.userId,
    summary: {
      completedCourses: result.summary.completedCourses,
      assessmentCourses: result.summary.assessmentCourses,
      contentCourses: result.summary.contentCourses,
    },
    courses: result.courses.map((course) => course.kind === 'assessment'
      ? {
          courseId: course.courseId,
          courseVersionId: course.courseVersionId,
          title: course.title,
          kind: course.kind,
          completedAt: course.completedAt,
          exams: course.exams.map((exam) => ({
            itemId: exam.itemId,
            earnedScore: exam.earnedScore,
            totalScore: exam.totalScore,
            passedAt: exam.passedAt,
          })),
        }
      : {
          courseId: course.courseId,
          courseVersionId: course.courseVersionId,
          title: course.title,
          kind: course.kind,
          completedAt: course.completedAt,
        }),
    nextCursor: result.nextCursor,
  }
}

function sendError(res: Response, error: unknown): void {
  if (!(error instanceof ElearningLearningProfileError)) {
    res.status(500).json({ error: 'internal_error' })
    return
  }
  const status = error.code === 'invalid_input'
    ? 400
    : error.code === 'forbidden'
      ? 403
      : 503
  res.status(status).json({ error: error.code })
}

export function createElearningProfileRouter(
  deps: ElearningProfileRouteDeps,
): Router | null {
  if (!isElearningCreditSurfaceEnabled(deps.env ?? process.env)) return null
  const router = Router()
  const readProfile = deps.getElearningLearningProfile
    ?? getElearningLearningProfile

  router.get(
    '/api/elearning/profile',
    (req, res, next) => {
      const userId = deps.viewerId(req)
      if (!userId) {
        res.status(401).json({ error: 'unauthenticated' })
        return
      }
      if (!deps.orgId(req)) {
        res.status(403).json({ error: 'ORG_CONTEXT_REQUIRED' })
        return
      }
      next()
    },
    deps.readGuard,
    (req, res): void => {
      void (async () => {
        const query = req.query as Record<string, unknown>
        if (Object.keys(query).some((key) => !QUERY_KEYS.has(key))) {
          res.status(400).json({ error: 'invalid_input' })
          return
        }
        const cursor = queryText(query.cursor)
        const limit = queryLimit(query.limit)
        const orgId = deps.orgId(req)
        const userId = deps.viewerId(req)
        if (cursor === null || limit === null || !orgId || !userId) {
          res.status(400).json({ error: 'invalid_input' })
          return
        }
        try {
          const result = await readProfile(deps.db, {
            orgId,
            userId,
            ...(cursor === undefined ? {} : { cursor }),
            ...(limit === undefined ? {} : { limit }),
          })
          res.status(200).json(dto(result))
        } catch (error) {
          sendError(res, error)
        }
      })().catch(() => {
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' })
      })
    },
  )

  return router
}
