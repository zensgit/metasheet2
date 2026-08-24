/**
 * E-learning V0.1 named-pilot HTTP surface: assignment, watch, playback ticket, exams,
 * composite course publish, learner assigned-course list.
 *
 * Unmounted factory. Registers nothing unless master+CONTENT+ASSIGNMENT+MEDIA are exact 'true'.
 * Exam, publish, and learner-list routes additionally recheck ASSESSMENT. Identity,
 * authoritative org, then RBAC run before JSON/service. Learner/actor/org are injected —
 * never taken from the client. Publish uses a dedicated 1 MiB JSON parser; a body just
 * over that limit is a values-free 413. Other JSON routes stay at 16 KiB. Learner GET
 * has no JSON parser. Errors are values-free. Ticket/exam JSON never includes storage
 * keys or paper secrets.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { json, Router } from 'express'

import {
  isElearningExamSurfaceEnabled,
  isElearningWatchSurfaceEnabled,
} from '../elearning/feature-flags'
import {
  ElearningCoursePublishError,
  publishElearningCourse,
  type ElearningCoursePublishDb,
  type ElearningCoursePublishErrorCode,
  type PublishElearningCourseInput,
} from '../services/elearning-course-publish'
import {
  assignElearningDirect,
  ElearningDirectAssignmentError,
  type ElearningDirectAssignmentDb,
  type ElearningDirectAssignmentErrorCode,
} from '../services/elearning-direct-assignment'
import {
  ElearningExamError,
  startElearningExam,
  submitElearningExam,
  type ElearningExamDb,
  type ElearningExamErrorCode,
} from '../services/elearning-exam'
import {
  ElearningLearnerCoursesError,
  listElearningLearnerCourses,
  type ElearningLearnerCoursesErrorCode,
  type ElearningLearnerCoursesQueryable,
} from '../services/elearning-learner-courses'
import {
  ELEARNING_MEDIA_PLAYBACK_SECRET_ENV,
  ElearningPlaybackError,
  issueElearningMediaPlaybackTicket,
  type ElearningPlaybackErrorCode,
  type ElearningPlaybackQueryable,
} from '../services/elearning-media-playback'
import {
  ElearningWatchError,
  recordElearningHeartbeat,
  startElearningWatch,
  type ElearningWatchDb,
  type ElearningWatchErrorCode,
} from '../services/elearning-watch-progress'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ASSIGN_KEYS = new Set(['targetUserId', 'courseVersionId', 'sourceKey', 'deadline'])
const HEARTBEAT_KEYS = new Set(['sequence', 'positionMs', 'playing'])
const SUBMIT_KEYS = new Set(['answers'])
const PUBLISH_KEYS = new Set(['requestId', 'title', 'mediaId', 'passScore', 'maxAttempts', 'questions'])
const EMPTY_KEYS = new Set<string>()

const ASSIGNMENT_STATUS: Record<ElearningDirectAssignmentErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  target_unavailable: 409,
  course_unavailable: 409,
  conflict: 409,
  unavailable: 503,
}

const WATCH_STATUS: Record<ElearningWatchErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  assignment_unavailable: 403,
  course_withdrawn: 409,
  unsupported_item: 400,
  unsupported_policy: 400,
  conflict: 409,
  sequence_gap: 409,
  session_inactive: 409,
  unavailable: 503,
}

const PLAYBACK_STATUS: Record<ElearningPlaybackErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  assignment_unavailable: 403,
  course_withdrawn: 409,
  unsupported_item: 400,
  unavailable: 503,
  invalid_token: 401,
  token_expired: 401,
  invalid_range: 400,
  unsatisfiable_range: 416,
}

const EXAM_STATUS: Record<ElearningExamErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  assignment_unavailable: 403,
  course_withdrawn: 409,
  unsupported_item: 400,
  prerequisite_incomplete: 409,
  max_attempts: 409,
  conflict: 409,
  unavailable: 503,
}

const PUBLISH_STATUS: Record<ElearningCoursePublishErrorCode, number> = {
  invalid_input: 400,
  media_unavailable: 409,
  conflict: 409,
  unavailable: 503,
}

const LEARNER_STATUS: Record<ElearningLearnerCoursesErrorCode, number> = {
  invalid_input: 400,
  unavailable: 503,
}

const jsonParser = json({ limit: 16 * 1024 })
const publishJsonParser = json({ limit: 1024 * 1024 })

export interface ElearningPilotRouteDeps {
  db: ElearningDirectAssignmentDb
    & ElearningWatchDb
    & ElearningPlaybackQueryable
    & ElearningExamDb
    & ElearningCoursePublishDb
    & ElearningLearnerCoursesQueryable
  viewerId(req: Request): string | null
  orgId(req: Request): string | null
  /** Production wiring: rbacGuard('elearning','admin'). Injected in tests. */
  adminGuard: RequestHandler
  /** Production wiring: rbacGuard('elearning','read'). Injected in tests. */
  readGuard: RequestHandler
  env?: NodeJS.ProcessEnv
  assignElearningDirect?: typeof assignElearningDirect
  startElearningWatch?: typeof startElearningWatch
  recordElearningHeartbeat?: typeof recordElearningHeartbeat
  issueElearningMediaPlaybackTicket?: typeof issueElearningMediaPlaybackTicket
  startElearningExam?: typeof startElearningExam
  submitElearningExam?: typeof submitElearningExam
  publishElearningCourse?: typeof publishElearningCourse
  listElearningLearnerCourses?: typeof listElearningLearnerCourses
}

function envOf(deps: ElearningPilotRouteDeps): NodeJS.ProcessEnv {
  return deps.env ?? process.env
}

function parseJson(req: Request, res: Response, next: NextFunction): void {
  jsonParser(req, res, (error?: unknown) => {
    if (!error) return next()
    res.status(400).json({ error: 'invalid_input' })
  })
}

function parsePublishJson(req: Request, res: Response, next: NextFunction): void {
  publishJsonParser(req, res, (error?: unknown) => {
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

function readObject(body: unknown): Record<string, unknown> | null {
  if (body === undefined) return {}
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  return body as Record<string, unknown>
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(body).some((key) => !allowed.has(key))
}

function readRequiredString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value.trim() === '') return null
  return value
}

function readUuid(value: unknown): string | null {
  if (typeof value !== 'string' || !UUID_RE.test(value)) return null
  return value
}

function uuidParam(req: Request, name: string): string | null {
  const value = (req.params as Record<string, unknown>)[name]
  return readUuid(value)
}

function invalid(res: Response): void {
  res.status(400).json({ error: 'invalid_input' })
}

export function createElearningPilotRouter(deps: ElearningPilotRouteDeps): Router | null {
  if (!isElearningWatchSurfaceEnabled(envOf(deps))) return null

  const assignDirect = deps.assignElearningDirect ?? assignElearningDirect
  const startWatch = deps.startElearningWatch ?? startElearningWatch
  const heartbeat = deps.recordElearningHeartbeat ?? recordElearningHeartbeat
  const issuePlayback = deps.issueElearningMediaPlaybackTicket ?? issueElearningMediaPlaybackTicket
  const startExam = deps.startElearningExam ?? startElearningExam
  const submitExam = deps.submitElearningExam ?? submitElearningExam
  const publishCourse = deps.publishElearningCourse ?? publishElearningCourse
  const listLearnerCourses = deps.listElearningLearnerCourses ?? listElearningLearnerCourses
  const router = Router()

  const asyncHandler =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response): void => {
      void fn(req, res).catch(() => {
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' })
      })
    }

  const requireWatchFlags = (_req: Request, res: Response, next: NextFunction): void => {
    if (!isElearningWatchSurfaceEnabled(envOf(deps))) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    next()
  }

  const requireExamFlags = (_req: Request, res: Response, next: NextFunction): void => {
    if (!isElearningExamSurfaceEnabled(envOf(deps))) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    next()
  }

  const requireIdentity = (req: Request, res: Response, next: NextFunction): void => {
    if (!deps.viewerId(req)) {
      res.status(401).json({ error: 'unauthenticated' })
      return
    }
    next()
  }

  const requireOrg = (req: Request, res: Response, next: NextFunction): void => {
    if (!deps.orgId(req)) {
      res.status(403).json({ error: 'ORG_CONTEXT_REQUIRED' })
      return
    }
    next()
  }

  const gate = (
    guard: RequestHandler,
    surface: 'watch' | 'exam' = 'watch',
    parser: RequestHandler | null = parseJson,
  ): RequestHandler[] => [
    surface === 'exam' ? requireExamFlags : requireWatchFlags,
    requireIdentity,
    requireOrg,
    guard,
    ...(parser ? [parser] : []),
  ]

  const recheck = (
    req: Request,
    res: Response,
    surface: 'watch' | 'exam' = 'watch',
  ): { actorId: string; orgId: string } | null => {
    const enabled = surface === 'exam'
      ? isElearningExamSurfaceEnabled(envOf(deps))
      : isElearningWatchSurfaceEnabled(envOf(deps))
    if (!enabled) {
      res.status(404).json({ error: 'not_found' })
      return null
    }
    const actorId = deps.viewerId(req)
    if (!actorId) {
      res.status(401).json({ error: 'unauthenticated' })
      return null
    }
    const orgId = deps.orgId(req)
    if (!orgId) {
      res.status(403).json({ error: 'ORG_CONTEXT_REQUIRED' })
      return null
    }
    return { actorId, orgId }
  }

  router.post(
    '/api/elearning/assignments/direct',
    ...gate(deps.adminGuard),
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = recheck(req, res)
      if (!ctx) return
      const body = readObject(req.body)
      if (!body || rejectUnknownKeys(body, ASSIGN_KEYS)) {
        invalid(res)
        return
      }
      const targetUserId = readRequiredString(body.targetUserId)
      const courseVersionId = readUuid(body.courseVersionId)
      const sourceKey = readRequiredString(body.sourceKey)
      if (!targetUserId || !courseVersionId || !sourceKey) {
        invalid(res)
        return
      }
      let deadline: string | null | undefined
      if (Object.prototype.hasOwnProperty.call(body, 'deadline')) {
        const rawDeadline = body.deadline
        if (typeof rawDeadline === 'string') {
          deadline = rawDeadline
        } else if (rawDeadline === null) {
          deadline = null
        } else {
          invalid(res)
          return
        }
      }
      try {
        const result = await assignDirect(deps.db, {
          orgId: ctx.orgId,
          actorId: ctx.actorId,
          targetUserId,
          courseVersionId,
          sourceKey,
          deadline,
        })
        res.status(201).json(result)
      } catch (error) {
        if (error instanceof ElearningDirectAssignmentError) {
          res.status(ASSIGNMENT_STATUS[error.code]).json({ error: error.code })
          return
        }
        res.status(500).json({ error: 'internal_error' })
      }
    }),
  )

  router.post(
    '/api/elearning/watch/items/:itemId/start',
    ...gate(deps.readGuard),
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = recheck(req, res)
      if (!ctx) return
      const itemId = uuidParam(req, 'itemId')
      const body = readObject(req.body)
      if (!itemId || !body || rejectUnknownKeys(body, EMPTY_KEYS)) {
        invalid(res)
        return
      }
      try {
        const result = await startWatch(deps.db, {
          orgId: ctx.orgId,
          userId: ctx.actorId,
          itemId,
        })
        res.status(200).json(result)
      } catch (error) {
        if (error instanceof ElearningWatchError) {
          res.status(WATCH_STATUS[error.code]).json({ error: error.code })
          return
        }
        res.status(500).json({ error: 'internal_error' })
      }
    }),
  )

  router.post(
    '/api/elearning/watch/sessions/:sessionId/heartbeat',
    ...gate(deps.readGuard),
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = recheck(req, res)
      if (!ctx) return
      const sessionId = uuidParam(req, 'sessionId')
      const body = readObject(req.body)
      if (!sessionId || !body || rejectUnknownKeys(body, HEARTBEAT_KEYS)) {
        invalid(res)
        return
      }
      const sequence = body.sequence
      const positionMs = body.positionMs
      const playing = body.playing
      if (
        typeof sequence !== 'number' ||
        !Number.isSafeInteger(sequence) ||
        sequence < 1 ||
        typeof positionMs !== 'number' ||
        !Number.isSafeInteger(positionMs) ||
        positionMs < 0 ||
        (playing !== true && playing !== false)
      ) {
        invalid(res)
        return
      }
      try {
        const result = await heartbeat(deps.db, {
          sessionId,
          orgId: ctx.orgId,
          userId: ctx.actorId,
          sequence,
          positionMs,
          playing,
        })
        res.status(200).json(result)
      } catch (error) {
        if (error instanceof ElearningWatchError) {
          res.status(WATCH_STATUS[error.code]).json({ error: error.code })
          return
        }
        res.status(500).json({ error: 'internal_error' })
      }
    }),
  )

  router.post(
    '/api/elearning/watch/items/:itemId/playback-ticket',
    ...gate(deps.readGuard),
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = recheck(req, res)
      if (!ctx) return
      const itemId = uuidParam(req, 'itemId')
      const body = readObject(req.body)
      if (!itemId || !body || rejectUnknownKeys(body, EMPTY_KEYS)) {
        invalid(res)
        return
      }
      try {
        const env = envOf(deps)
        const result = await issuePlayback(deps.db, {
          orgId: ctx.orgId,
          userId: ctx.actorId,
          itemId,
          playbackSigningSecret: env[ELEARNING_MEDIA_PLAYBACK_SECRET_ENV],
          jwtSecret: env.JWT_SECRET,
        })
        res.status(200).json(result)
      } catch (error) {
        if (error instanceof ElearningPlaybackError) {
          res.status(PLAYBACK_STATUS[error.code]).json({ error: error.code })
          return
        }
        res.status(500).json({ error: 'internal_error' })
      }
    }),
  )

  router.post(
    '/api/elearning/exams/items/:itemId/start',
    ...gate(deps.readGuard, 'exam'),
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = recheck(req, res, 'exam')
      if (!ctx) return
      const itemId = uuidParam(req, 'itemId')
      const body = readObject(req.body)
      if (!itemId || !body || rejectUnknownKeys(body, EMPTY_KEYS)) {
        invalid(res)
        return
      }
      try {
        const result = await startExam(deps.db, {
          orgId: ctx.orgId,
          userId: ctx.actorId,
          itemId,
        })
        res.status(200).json(result)
      } catch (error) {
        if (error instanceof ElearningExamError) {
          res.status(EXAM_STATUS[error.code]).json({ error: error.code })
          return
        }
        res.status(500).json({ error: 'internal_error' })
      }
    }),
  )

  router.post(
    '/api/elearning/exams/attempts/:attemptId/submit',
    ...gate(deps.readGuard, 'exam'),
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = recheck(req, res, 'exam')
      if (!ctx) return
      const attemptId = uuidParam(req, 'attemptId')
      const body = readObject(req.body)
      if (!attemptId || !body || rejectUnknownKeys(body, SUBMIT_KEYS)) {
        invalid(res)
        return
      }
      if (!Object.prototype.hasOwnProperty.call(body, 'answers')) {
        invalid(res)
        return
      }
      try {
        const result = await submitExam(deps.db, {
          orgId: ctx.orgId,
          userId: ctx.actorId,
          attemptId,
          answers: body.answers,
        })
        res.status(200).json(result)
      } catch (error) {
        if (error instanceof ElearningExamError) {
          res.status(EXAM_STATUS[error.code]).json({ error: error.code })
          return
        }
        res.status(500).json({ error: 'internal_error' })
      }
    }),
  )

  router.post(
    '/api/elearning/courses/publish',
    ...gate(deps.adminGuard, 'exam', parsePublishJson),
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = recheck(req, res, 'exam')
      if (!ctx) return
      const body = readObject(req.body)
      if (!body || rejectUnknownKeys(body, PUBLISH_KEYS)) {
        invalid(res)
        return
      }
      try {
        const result = await publishCourse(deps.db, {
          orgId: ctx.orgId,
          actorId: ctx.actorId,
          requestId: body.requestId,
          title: body.title,
          mediaId: body.mediaId,
          passScore: body.passScore,
          maxAttempts: body.maxAttempts,
          questions: body.questions,
        } as PublishElearningCourseInput)
        res.status(201).json(result)
      } catch (error) {
        if (error instanceof ElearningCoursePublishError) {
          res.status(PUBLISH_STATUS[error.code]).json({ error: error.code })
          return
        }
        res.status(500).json({ error: 'internal_error' })
      }
    }),
  )

  router.get(
    '/api/elearning/me/courses',
    ...gate(deps.readGuard, 'exam', null),
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = recheck(req, res, 'exam')
      if (!ctx) return
      try {
        const result = await listLearnerCourses(deps.db, {
          orgId: ctx.orgId,
          userId: ctx.actorId,
        })
        res.status(200).json({ courses: result })
      } catch (error) {
        if (error instanceof ElearningLearnerCoursesError) {
          res.status(LEARNER_STATUS[error.code]).json({ error: error.code })
          return
        }
        res.status(500).json({ error: 'internal_error' })
      }
    }),
  )

  return router
}
