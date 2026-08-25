/**
 * E-learning HTTP surface: scope, assignment, watch, playback ticket, exams,
 * composite course publish, and learner available-course list.
 *
 * Unmounted factory. Registers nothing unless master+CONTENT are exact 'true'.
 * Every route rechecks its independent capability flags. Identity,
 * authoritative org, then RBAC run before JSON/service. Learner/actor/org are injected —
 * never taken from the client. Publish uses a dedicated 1 MiB JSON parser; a body just
 * over that limit is a values-free 413. Other JSON routes stay at 16 KiB. Learner GET
 * has no JSON parser. Errors are values-free. Ticket/exam JSON never includes storage
 * keys or paper secrets.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { json, Router } from 'express'

import {
  isElearningAssignmentSurfaceEnabled,
  isElearningContentSurfaceEnabled,
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
  assignElearningBatch,
  ElearningBatchAssignmentError,
  type ElearningBatchAssignmentDb,
  type ElearningBatchAssignmentErrorCode,
} from '../services/elearning-batch-assignment'
import {
  listElearningAssignmentProgress,
  revokeElearningAssignmentMember,
  ElearningAssignmentLifecycleError,
  type ElearningAssignmentLifecycleDb,
  type ElearningAssignmentLifecycleErrorCode,
} from '../services/elearning-assignment-lifecycle'
import {
  assignElearningDirect,
  ElearningDirectAssignmentError,
  type ElearningDirectAssignmentDb,
  type ElearningDirectAssignmentErrorCode,
} from '../services/elearning-direct-assignment'
import {
  ElearningExamError,
  saveElearningExamAnswers,
  startElearningExam,
  submitElearningExam,
  type ElearningExamDb,
  type ElearningExamErrorCode,
} from '../services/elearning-exam'
import {
  ElearningLearnerCoursesError,
  listElearningLearnerCourses,
  type ElearningLearnerCoursesDb,
  type ElearningLearnerCoursesErrorCode,
} from '../services/elearning-learner-courses'
import {
  ELEARNING_MEDIA_PLAYBACK_SECRET_ENV,
  ElearningPlaybackError,
  issueElearningMediaPlaybackTicket,
  type ElearningPlaybackErrorCode,
  type ElearningPlaybackDb,
} from '../services/elearning-media-playback'
import {
  ElearningScopeError,
  setElearningCourseScope,
  type ElearningScopeDb,
  type ElearningScopeErrorCode,
} from '../services/elearning-scope'
import {
  ElearningWatchError,
  recordElearningHeartbeat,
  startElearningWatch,
  type ElearningWatchDb,
  type ElearningWatchErrorCode,
} from '../services/elearning-watch-progress'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ASSIGN_KEYS = new Set([
  'targetUserId',
  'courseVersionId',
  'sourceKey',
  'deadline',
])
const BATCH_ASSIGN_KEYS = new Set([
  'courseVersionId',
  'sourceKey',
  'deadline',
  'rules',
])
const HEARTBEAT_KEYS = new Set(['sequence', 'positionMs', 'playing'])
const SUBMIT_KEYS = new Set(['answers'])
const PUBLISH_KEYS = new Set([
  'requestId',
  'title',
  'mediaId',
  'passScore',
  'maxAttempts',
  'questions',
])
const SCOPE_KEYS = new Set(['reason', 'rules'])
const REVOKE_KEYS = new Set(['reason'])
const EMPTY_KEYS = new Set<string>()

const ASSIGNMENT_STATUS: Record<ElearningDirectAssignmentErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  target_unavailable: 409,
  course_unavailable: 409,
  conflict: 409,
  unavailable: 503,
}

const BATCH_ASSIGNMENT_STATUS: Record<ElearningBatchAssignmentErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  course_unavailable: 409,
  subject_not_found: 422,
  unsupported_subject: 422,
  empty_audience: 422,
  audience_too_large: 422,
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

const SCOPE_STATUS: Record<ElearningScopeErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  subject_not_found: 404,
  unsupported_subject: 422,
  unavailable: 503,
}

const LIFECYCLE_STATUS: Record<ElearningAssignmentLifecycleErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
}

const jsonParser = json({ limit: 16 * 1024 })
const publishJsonParser = json({ limit: 1024 * 1024 })

export interface ElearningPilotRouteDeps {
  db: ElearningDirectAssignmentDb &
    ElearningBatchAssignmentDb &
    ElearningWatchDb &
    ElearningPlaybackDb &
    ElearningExamDb &
    ElearningCoursePublishDb &
    ElearningLearnerCoursesDb &
    ElearningScopeDb &
    ElearningAssignmentLifecycleDb
  viewerId(req: Request): string | null
  orgId(req: Request): string | null
  /** Production wiring: rbacGuard('elearning','admin'). Injected in tests. */
  adminGuard: RequestHandler
  /** Production wiring: rbacGuardAny(['elearning:read', 'elearning:write', 'elearning:admin']). Injected in tests. */
  readGuard: RequestHandler
  env?: NodeJS.ProcessEnv
  assignElearningDirect?: typeof assignElearningDirect
  assignElearningBatch?: typeof assignElearningBatch
  listElearningAssignmentProgress?: typeof listElearningAssignmentProgress
  revokeElearningAssignmentMember?: typeof revokeElearningAssignmentMember
  startElearningWatch?: typeof startElearningWatch
  recordElearningHeartbeat?: typeof recordElearningHeartbeat
  issueElearningMediaPlaybackTicket?: typeof issueElearningMediaPlaybackTicket
  startElearningExam?: typeof startElearningExam
  saveElearningExamAnswers?: typeof saveElearningExamAnswers
  submitElearningExam?: typeof submitElearningExam
  publishElearningCourse?: typeof publishElearningCourse
  listElearningLearnerCourses?: typeof listElearningLearnerCourses
  setElearningCourseScope?: typeof setElearningCourseScope
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

function parsePublishJson(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
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

function rejectUnknownKeys(
  body: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
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

function readQueryValue(
  query: Request['query'],
  name: string,
): string | undefined | null {
  if (!Object.prototype.hasOwnProperty.call(query, name)) return undefined
  const value = query[name]
  if (typeof value !== 'string') return null
  return value
}

function invalid(res: Response): void {
  res.status(400).json({ error: 'invalid_input' })
}

export function createElearningPilotRouter(
  deps: ElearningPilotRouteDeps,
): Router | null {
  if (!isElearningContentSurfaceEnabled(envOf(deps))) return null

  const assignDirect = deps.assignElearningDirect ?? assignElearningDirect
  const assignBatch = deps.assignElearningBatch ?? assignElearningBatch
  const listProgress =
    deps.listElearningAssignmentProgress ?? listElearningAssignmentProgress
  const revokeMember =
    deps.revokeElearningAssignmentMember ?? revokeElearningAssignmentMember
  const startWatch = deps.startElearningWatch ?? startElearningWatch
  const heartbeat = deps.recordElearningHeartbeat ?? recordElearningHeartbeat
  const issuePlayback = deps.issueElearningMediaPlaybackTicket ?? issueElearningMediaPlaybackTicket
  const startExam = deps.startElearningExam ?? startElearningExam
  const saveExamAnswers = deps.saveElearningExamAnswers ?? saveElearningExamAnswers
  const submitExam = deps.submitElearningExam ?? submitElearningExam
  const publishCourse = deps.publishElearningCourse ?? publishElearningCourse
  const listLearnerCourses =
    deps.listElearningLearnerCourses ?? listElearningLearnerCourses
  const setCourseScope = deps.setElearningCourseScope ?? setElearningCourseScope
  const router = Router()

  const asyncHandler =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response): void => {
      void fn(req, res).catch(() => {
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' })
      })
    }

  const requireWatchFlags = (
    _req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (!isElearningWatchSurfaceEnabled(envOf(deps))) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    next()
  }

  const requireContentFlags = (
    _req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (!isElearningContentSurfaceEnabled(envOf(deps))) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    next()
  }

  const requireAssignmentFlags = (
    _req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (!isElearningAssignmentSurfaceEnabled(envOf(deps))) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    next()
  }

  const requireExamFlags = (
    _req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (!isElearningExamSurfaceEnabled(envOf(deps))) {
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

  const gate = (
    guard: RequestHandler,
    surface: 'content' | 'assignment' | 'watch' | 'exam' = 'watch',
    parser: RequestHandler | null = parseJson,
  ): RequestHandler[] => [
    surface === 'content'
      ? requireContentFlags
      : surface === 'assignment'
        ? requireAssignmentFlags
        : surface === 'exam'
          ? requireExamFlags
          : requireWatchFlags,
    requireIdentity,
    requireOrg,
    guard,
    ...(parser ? [parser] : []),
  ]

  const recheck = (
    req: Request,
    res: Response,
    surface: 'content' | 'assignment' | 'watch' | 'exam' = 'watch',
  ): { actorId: string; orgId: string } | null => {
    const enabled =
      surface === 'content'
        ? isElearningContentSurfaceEnabled(envOf(deps))
        : surface === 'assignment'
          ? isElearningAssignmentSurfaceEnabled(envOf(deps))
          : surface === 'exam'
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
    ...gate(deps.adminGuard, 'assignment'),
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = recheck(req, res, 'assignment')
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
    '/api/elearning/assignments/batch',
    ...gate(deps.adminGuard, 'assignment'),
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = recheck(req, res, 'assignment')
      if (!ctx) return
      const body = readObject(req.body)
      if (
        !body
        || rejectUnknownKeys(body, BATCH_ASSIGN_KEYS)
        || !Object.prototype.hasOwnProperty.call(body, 'rules')
      ) {
        invalid(res)
        return
      }
      const courseVersionId = readUuid(body.courseVersionId)
      const sourceKey = readRequiredString(body.sourceKey)
      if (!courseVersionId || !sourceKey) {
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
        const result = await assignBatch(deps.db, {
          orgId: ctx.orgId,
          actorId: ctx.actorId,
          courseVersionId,
          sourceKey,
          deadline,
          rules: body.rules,
        })
        res.status(201).json(result)
      } catch (error) {
        if (error instanceof ElearningBatchAssignmentError) {
          res.status(BATCH_ASSIGNMENT_STATUS[error.code]).json({ error: error.code })
          return
        }
        res.status(500).json({ error: 'internal_error' })
      }
    }),
  )

  router.get(
    '/api/elearning/assignments/:assignmentId',
    ...gate(deps.adminGuard, 'assignment', null),
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = recheck(req, res, 'assignment')
      if (!ctx) return
      const assignmentId = uuidParam(req, 'assignmentId')
      if (!assignmentId) {
        invalid(res)
        return
      }
      const rawCursor = readQueryValue(req.query, 'cursor')
      if (rawCursor === null) {
        invalid(res)
        return
      }
      let cursor: string | undefined
      if (rawCursor !== undefined) {
        const parsed = readUuid(rawCursor)
        if (!parsed) {
          invalid(res)
          return
        }
        cursor = parsed
      }
      const rawLimit = readQueryValue(req.query, 'limit')
      if (rawLimit === null) {
        invalid(res)
        return
      }
      let limit: number | undefined
      if (rawLimit !== undefined) {
        if (!/^[1-9]\d*$/.test(rawLimit)) {
          invalid(res)
          return
        }
        const parsed = Number(rawLimit)
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
          invalid(res)
          return
        }
        limit = parsed
      }
      try {
        const result = await listProgress(deps.db, {
          orgId: ctx.orgId,
          assignmentId,
          cursor,
          limit,
        })
        res.status(200).json(result)
      } catch (error) {
        if (error instanceof ElearningAssignmentLifecycleError) {
          res.status(LIFECYCLE_STATUS[error.code]).json({ error: error.code })
          return
        }
        res.status(500).json({ error: 'internal_error' })
      }
    }),
  )

  router.put(
    '/api/elearning/assignments/:assignmentId/members/:memberId/revocation',
    ...gate(deps.adminGuard, 'assignment'),
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = recheck(req, res, 'assignment')
      if (!ctx) return
      const assignmentId = uuidParam(req, 'assignmentId')
      const memberId = uuidParam(req, 'memberId')
      const body = readObject(req.body)
      if (
        !assignmentId
        || !memberId
        || !body
        || rejectUnknownKeys(body, REVOKE_KEYS)
        || !Object.prototype.hasOwnProperty.call(body, 'reason')
      ) {
        invalid(res)
        return
      }
      if (typeof body.reason !== 'string') {
        invalid(res)
        return
      }
      try {
        const result = await revokeMember(deps.db, {
          orgId: ctx.orgId,
          actorId: ctx.actorId,
          assignmentId,
          memberId,
          reason: body.reason,
        })
        res.status(200).json(result)
      } catch (error) {
        if (error instanceof ElearningAssignmentLifecycleError) {
          res.status(LIFECYCLE_STATUS[error.code]).json({ error: error.code })
          return
        }
        res.status(500).json({ error: 'internal_error' })
      }
    }),
  )

  router.put(
    '/api/elearning/courses/:courseId/scope',
    ...gate(deps.adminGuard, 'content'),
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = recheck(req, res, 'content')
      if (!ctx) return
      const courseId = uuidParam(req, 'courseId')
      const body = readObject(req.body)
      if (
        !courseId ||
        !body ||
        rejectUnknownKeys(body, SCOPE_KEYS) ||
        !Object.prototype.hasOwnProperty.call(body, 'reason') ||
        !Object.prototype.hasOwnProperty.call(body, 'rules')
      ) {
        invalid(res)
        return
      }
      try {
        const result = await setCourseScope(deps.db, {
          orgId: ctx.orgId,
          actorId: ctx.actorId,
          courseId,
          reason: body.reason as string,
          rules: body.rules as never,
        })
        res.status(200).json(result)
      } catch (error) {
        if (error instanceof ElearningScopeError) {
          res.status(SCOPE_STATUS[error.code]).json({ error: error.code })
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

  router.put(
    '/api/elearning/exams/attempts/:attemptId/answers',
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
        const result = await saveExamAnswers(deps.db, {
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
