/**
 * E-learning V0.1 named-pilot runtime: flag-gated assignment + watch + exam +
 * publish + learner-list HTTP mount.
 * Synchronous. Zero routes unless master+CONTENT+ASSIGNMENT+MEDIA are exact 'true'.
 * JWT identity wraps /api/elearning; inner full-path router then applies
 * authoritative org, RBAC, JSON, service. No startup DB I/O.
 * Playback tickets use dedicated ELEARNING_MEDIA_PLAYBACK_SIGNING_SECRET.
 */
import type { Request, RequestHandler } from 'express'
import { Router, type Router as ExpressRouter } from 'express'

import { isElearningWatchSurfaceEnabled } from '../elearning/feature-flags'
import { authenticate } from '../middleware/auth'
import { rbacGuard } from '../rbac/rbac'
import { createElearningPilotRouter } from '../routes/elearning-pilot'
import {
  publishElearningCourse,
  type ElearningCoursePublishDb,
  type ElearningCoursePublishResult,
  type PublishElearningCourseInput,
} from './elearning-course-publish'
import type {
  AssignElearningDirectInput,
  ElearningDirectAssignmentDb,
  ElearningDirectAssignmentResult,
} from './elearning-direct-assignment'
import {
  startElearningExam,
  submitElearningExam,
  type ElearningExamDb,
  type ElearningExamStartResult,
  type ElearningExamSubmitResult,
  type StartElearningExamInput,
  type SubmitElearningExamInput,
} from './elearning-exam'
import {
  listElearningLearnerCourses,
  type ElearningLearnerCourse,
  type ElearningLearnerCoursesQueryable,
  type ListElearningLearnerCoursesInput,
} from './elearning-learner-courses'
import {
  ELEARNING_MEDIA_PLAYBACK_SECRET_ENV,
  issueElearningMediaPlaybackTicket,
  type ElearningMediaPlaybackTicket,
  type ElearningPlaybackQueryable,
  type IssueElearningMediaPlaybackInput,
} from './elearning-media-playback'
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
  db: ElearningDirectAssignmentDb
    & ElearningWatchDb
    & ElearningPlaybackQueryable
    & ElearningExamDb
    & ElearningCoursePublishDb
    & ElearningLearnerCoursesQueryable
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
  issueElearningMediaPlaybackTicket?: (
    db: ElearningPlaybackQueryable,
    input: IssueElearningMediaPlaybackInput,
  ) => Promise<ElearningMediaPlaybackTicket>
  startElearningExam?: (
    db: ElearningExamDb,
    input: StartElearningExamInput,
  ) => Promise<ElearningExamStartResult>
  submitElearningExam?: (
    db: ElearningExamDb,
    input: SubmitElearningExamInput,
  ) => Promise<ElearningExamSubmitResult>
  publishElearningCourse?: (
    db: ElearningCoursePublishDb,
    input: PublishElearningCourseInput,
  ) => Promise<ElearningCoursePublishResult>
  listElearningLearnerCourses?: (
    db: ElearningLearnerCoursesQueryable,
    input: ListElearningLearnerCoursesInput,
  ) => Promise<ElearningLearnerCourse[]>
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

  const issuePlayback = opts.issueElearningMediaPlaybackTicket ?? ((
    db: ElearningPlaybackQueryable,
    input: IssueElearningMediaPlaybackInput,
  ) => issueElearningMediaPlaybackTicket(db, {
    orgId: input.orgId,
    userId: input.userId,
    itemId: input.itemId,
    playbackSigningSecret: env[ELEARNING_MEDIA_PLAYBACK_SECRET_ENV],
    jwtSecret: env.JWT_SECRET,
  }))

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
    issueElearningMediaPlaybackTicket: issuePlayback,
    startElearningExam: opts.startElearningExam ?? startElearningExam,
    submitElearningExam: opts.submitElearningExam ?? submitElearningExam,
    publishElearningCourse: opts.publishElearningCourse ?? publishElearningCourse,
    listElearningLearnerCourses: opts.listElearningLearnerCourses ?? listElearningLearnerCourses,
  })
  if (!inner) return null

  const router = Router()
  router.use('/api/elearning', opts.authenticate ?? authenticate)
  router.use(inner)
  return { router }
}
