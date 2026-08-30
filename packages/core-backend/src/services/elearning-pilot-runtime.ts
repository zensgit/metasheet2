/**
 * E-learning runtime: flag-gated scope + assignment + watch + exam + publish
 * + learner-list HTTP mount.
 * Synchronous. Zero routes unless master plus CONTENT or INCENTIVE are exact
 * 'true'; each route rechecks its independent capability gate.
 * JWT identity wraps /api/elearning; inner full-path router then applies
 * authoritative org, RBAC, JSON, service. No startup DB I/O.
 * Playback tickets use dedicated ELEARNING_MEDIA_PLAYBACK_SIGNING_SECRET.
 */
import type { Request, RequestHandler } from 'express'
import { Router, type Router as ExpressRouter } from 'express'

import { isElearningContentSurfaceEnabled } from '../elearning/feature-flags'
import { authenticate } from '../middleware/auth'
import { rbacGuard, rbacGuardAny } from '../rbac/rbac'
import { createElearningCreditRouter } from '../routes/elearning-credit'
import { createElearningContentRouter } from '../routes/elearning-content'
import { createElearningPilotRouter } from '../routes/elearning-pilot'
import { isElearningGlobalAdminRequest } from '../routes/elearning-admin-access'
import type { ElearningAdminAccessDb } from './elearning-admin-access'
import type { ElearningAssessmentCatalogDb } from './elearning-assessment-catalog'
import type {
  ElearningBatchAssignmentDb,
  ElearningBatchAssignmentResult,
} from './elearning-batch-assignment'
import {
  publishElearningCourse,
  type ElearningCoursePublishDb,
  type ElearningCoursePublishResult,
  type PublishElearningCourseInput,
} from './elearning-course-publish'
import {
  publishElearningContentCourse,
  type ElearningContentCoursePublishDb,
  type ElearningContentCoursePublishResult,
  type PublishElearningContentCourseInput,
} from './elearning-content-course-publish'
import {
  storeElearningContentRevision,
  type CreateElearningContentRevisionInput,
  type ElearningContentRevisionDb,
} from './elearning-content-revision-postgres'
import { isElearningCreditSurfaceEnabled } from './elearning-credit-ledger'
import type { adjustElearningCreditPostgres } from './elearning-credit-adjustment-postgres'
import type {
  issueElearningCertificate,
  listActiveElearningCertificateTemplates,
  listMyElearningCertificates,
  publishElearningCertificateTemplate,
} from './elearning-certificate-surface'
import type {
  getElearningCreditWallet,
  listElearningCreditRules,
  publishElearningCreditRule,
  ElearningCreditSurfaceDb,
} from './elearning-credit-surface'
import type {
  getActiveElearningTitleSnapshot,
  publishElearningTitleSnapshot,
} from './elearning-title-surface'
import type {
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
  getElearningExamReview,
  type ElearningExamReviewResult,
  type GetElearningExamReviewInput,
} from './elearning-exam-review'
import {
  listElearningLearnerCourses,
  type ElearningLearnerCourse,
  type ElearningLearnerCoursesDb,
  type ListElearningLearnerCoursesInput,
} from './elearning-learner-courses'
import {
  ELEARNING_MEDIA_PLAYBACK_SECRET_ENV,
  issueElearningMediaPlaybackTicket,
  type ElearningMediaPlaybackTicket,
  type ElearningPlaybackDb,
  type IssueElearningMediaPlaybackInput,
} from './elearning-media-playback'
import type { ElearningPaperExamDb } from './elearning-paper-exam'
import {
  submitElearningManualGrade,
  type ElearningManualGradeInput,
  type ElearningManualGradeResult,
  type ElearningManualGradingDb,
} from './elearning-manual-grading'
import {
  getElearningManualGradingDetail,
  listElearningManualGradingQueue,
  type ElearningManualGradingDetail,
  type ElearningManualGradingQueueResult,
  type ElearningManualGradingReadDb,
  type GetElearningManualGradingDetailInput,
  type ListElearningManualGradingQueueInput,
} from './elearning-manual-grading-read'
import {
  recordElearningOpenCompletion,
  type ElearningOpenCompletionDb,
  type ElearningOpenCompletionResult,
  type RecordElearningOpenCompletionInput,
} from './elearning-open-completion-postgres'
import type {
  ElearningWatchDb,
  ElearningWatchState,
  RecordElearningHeartbeatInput,
  StartElearningWatchInput,
} from './elearning-watch-progress'
import {
  type ElearningScopeDb,
  type SetElearningCourseScopeResult,
} from './elearning-scope'
import {
  getElearningTrainingPlan,
  publishElearningTrainingPlan,
  type ElearningTrainingPlan,
  type ElearningTrainingPlanDb,
  type ElearningTrainingPlanPublishResult,
  type GetElearningTrainingPlanInput,
  type PublishElearningTrainingPlanInput,
} from './elearning-training-plan'
import {
  type ElearningTrainingPlanAssignmentDb,
  type ElearningTrainingPlanAssignmentResult,
} from './elearning-training-plan-assignment'
import {
  type ElearningTrainingPlanRevocationDb,
  type ElearningTrainingPlanRevocationResult,
} from './elearning-training-plan-revocation'
import {
  assignElearningTrainingPlanAuthorized,
  revokeElearningTrainingPlanAssignmentAuthorized,
  setElearningCourseScopeAuthorized,
  type AssignElearningBatchAuthorizedInput,
  type AssignElearningDirectAuthorizedInput,
  type AssignElearningTrainingPlanAuthorizedInput,
  type ElearningAdminOperationDb,
  type RevokeElearningTrainingPlanAssignmentAuthorizedInput,
  type SetElearningCourseScopeAuthorizedInput,
} from './elearning-admin-operations'

export interface ElearningPilotRuntime {
  router: ExpressRouter
}

export interface ElearningPilotRuntimeOptions {
  db: ElearningDirectAssignmentDb &
    ElearningBatchAssignmentDb &
    ElearningWatchDb &
    ElearningPlaybackDb &
    ElearningExamDb &
    ElearningCoursePublishDb &
    ElearningContentRevisionDb &
    ElearningContentCoursePublishDb &
    ElearningOpenCompletionDb &
    ElearningLearnerCoursesDb &
    ElearningScopeDb &
    ElearningTrainingPlanDb &
    ElearningTrainingPlanAssignmentDb &
    ElearningTrainingPlanRevocationDb &
    ElearningAdminAccessDb &
    ElearningAdminOperationDb &
    ElearningAssessmentCatalogDb &
    ElearningPaperExamDb &
    ElearningManualGradingDb &
    ElearningManualGradingReadDb &
    ElearningCreditSurfaceDb
  env?: NodeJS.ProcessEnv
  authenticate?: RequestHandler
  adminGuard?: RequestHandler
  readGuard?: RequestHandler
  writeGuard?: RequestHandler
  gradeGuard?: RequestHandler
  viewerId?: (req: Request) => string | null
  orgId?: (req: Request) => string | null
  isGlobalAdmin?: (req: Request) => boolean
  assignElearningDirect?: (
    db: ElearningDirectAssignmentDb,
    input: AssignElearningDirectAuthorizedInput,
  ) => Promise<ElearningDirectAssignmentResult>
  assignElearningBatch?: (
    db: ElearningBatchAssignmentDb,
    input: AssignElearningBatchAuthorizedInput,
  ) => Promise<ElearningBatchAssignmentResult>
  startElearningWatch?: (
    db: ElearningWatchDb,
    input: StartElearningWatchInput,
  ) => Promise<ElearningWatchState>
  recordElearningHeartbeat?: (
    db: ElearningWatchDb,
    input: RecordElearningHeartbeatInput,
  ) => Promise<ElearningWatchState>
  issueElearningMediaPlaybackTicket?: (
    db: ElearningPlaybackDb,
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
  getElearningExamReview?: (
    db: ElearningExamDb,
    input: GetElearningExamReviewInput,
  ) => Promise<ElearningExamReviewResult>
  submitElearningManualGrade?: (
    db: ElearningManualGradingDb,
    input: ElearningManualGradeInput,
  ) => Promise<ElearningManualGradeResult>
  listElearningManualGradingQueue?: (
    db: ElearningManualGradingReadDb,
    input: ListElearningManualGradingQueueInput,
  ) => Promise<ElearningManualGradingQueueResult>
  getElearningManualGradingDetail?: (
    db: ElearningManualGradingReadDb,
    input: GetElearningManualGradingDetailInput,
  ) => Promise<ElearningManualGradingDetail>
  publishElearningCourse?: (
    db: ElearningCoursePublishDb,
    input: PublishElearningCourseInput,
  ) => Promise<ElearningCoursePublishResult>
  storeElearningContentRevision?: (
    db: ElearningContentRevisionDb,
    input: CreateElearningContentRevisionInput,
  ) => ReturnType<typeof storeElearningContentRevision>
  publishElearningContentCourse?: (
    db: ElearningContentCoursePublishDb,
    input: PublishElearningContentCourseInput,
  ) => Promise<ElearningContentCoursePublishResult>
  recordElearningOpenCompletion?: (
    db: ElearningOpenCompletionDb,
    input: RecordElearningOpenCompletionInput,
  ) => Promise<ElearningOpenCompletionResult>
  listElearningLearnerCourses?: (
    db: ElearningLearnerCoursesDb,
    input: ListElearningLearnerCoursesInput,
  ) => Promise<ElearningLearnerCourse[]>
  setElearningCourseScope?: (
    db: ElearningScopeDb,
    input: SetElearningCourseScopeAuthorizedInput,
  ) => Promise<SetElearningCourseScopeResult>
  publishElearningTrainingPlan?: (
    db: ElearningTrainingPlanDb,
    input: PublishElearningTrainingPlanInput,
  ) => Promise<ElearningTrainingPlanPublishResult>
  getElearningTrainingPlan?: (
    db: ElearningTrainingPlanDb,
    input: GetElearningTrainingPlanInput,
  ) => Promise<ElearningTrainingPlan>
  assignElearningTrainingPlan?: (
    db: ElearningTrainingPlanAssignmentDb,
    input: AssignElearningTrainingPlanAuthorizedInput,
  ) => Promise<ElearningTrainingPlanAssignmentResult>
  revokeElearningTrainingPlanAssignment?: (
    db: ElearningTrainingPlanRevocationDb,
    input: RevokeElearningTrainingPlanAssignmentAuthorizedInput,
  ) => Promise<ElearningTrainingPlanRevocationResult>
  publishElearningCreditRule?: typeof publishElearningCreditRule
  listElearningCreditRules?: typeof listElearningCreditRules
  getElearningCreditWallet?: typeof getElearningCreditWallet
  adjustElearningCredit?: typeof adjustElearningCreditPostgres
  getActiveElearningTitleSnapshot?: typeof getActiveElearningTitleSnapshot
  publishElearningTitleSnapshot?: typeof publishElearningTitleSnapshot
  listActiveElearningCertificateTemplates?: typeof listActiveElearningCertificateTemplates
  publishElearningCertificateTemplate?: typeof publishElearningCertificateTemplate
  issueElearningCertificate?: typeof issueElearningCertificate
  listMyElearningCertificates?: typeof listMyElearningCertificates
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
  const contentEnabled = isElearningContentSurfaceEnabled(env)
  const creditEnabled = isElearningCreditSurfaceEnabled(env)
  if (!contentEnabled && !creditEnabled) return null

  const issuePlayback =
    opts.issueElearningMediaPlaybackTicket ??
    ((db: ElearningPlaybackDb, input: IssueElearningMediaPlaybackInput) =>
      issueElearningMediaPlaybackTicket(db, {
        orgId: input.orgId,
        userId: input.userId,
        itemId: input.itemId,
        playbackSigningSecret: env[ELEARNING_MEDIA_PLAYBACK_SECRET_ENV],
        jwtSecret: env.JWT_SECRET,
      }))

  const submitExam =
    opts.submitElearningExam
    ?? ((db: ElearningExamDb, input: SubmitElearningExamInput) =>
      submitElearningExam(db, input, { env }))
  const submitManualGrade =
    opts.submitElearningManualGrade
    ?? ((db: ElearningManualGradingDb, input: ElearningManualGradeInput) =>
      submitElearningManualGrade(db, input, { env }))

  const content = contentEnabled ? createElearningContentRouter({
    db: opts.db,
    env,
    viewerId: opts.viewerId ?? viewerId,
    orgId: opts.orgId ?? orgId,
    adminGuard: opts.adminGuard ?? rbacGuard('elearning', 'admin'),
    readGuard: opts.readGuard
      ?? rbacGuardAny(['elearning:read', 'elearning:write', 'elearning:admin']),
    storeElearningContentRevision:
      opts.storeElearningContentRevision ?? storeElearningContentRevision,
    publishElearningContentCourse:
      opts.publishElearningContentCourse ?? publishElearningContentCourse,
    recordElearningOpenCompletion:
      opts.recordElearningOpenCompletion ?? recordElearningOpenCompletion,
  }) : null

  const inner = contentEnabled ? createElearningPilotRouter({
    db: opts.db,
    viewerId: opts.viewerId ?? viewerId,
    orgId: opts.orgId ?? orgId,
    adminGuard: opts.adminGuard ?? rbacGuard('elearning', 'admin'),
    readGuard: opts.readGuard ?? rbacGuardAny(['elearning:read', 'elearning:write', 'elearning:admin']),
    writeGuard: opts.writeGuard ?? rbacGuardAny(['elearning:write', 'elearning:admin']),
    gradeGuard: opts.gradeGuard ?? rbacGuardAny(['elearning:grade', 'elearning:admin']),
    isGlobalAdmin: opts.isGlobalAdmin ?? isElearningGlobalAdminRequest,
    env,
    assignElearningDirect: opts.assignElearningDirect,
    assignElearningBatch: opts.assignElearningBatch,
    startElearningWatch: opts.startElearningWatch,
    recordElearningHeartbeat: opts.recordElearningHeartbeat,
    issueElearningMediaPlaybackTicket: issuePlayback,
    startElearningExam: opts.startElearningExam ?? startElearningExam,
    submitElearningExam: submitExam,
    getElearningExamReview:
      opts.getElearningExamReview ?? getElearningExamReview,
    submitElearningManualGrade: submitManualGrade,
    listElearningManualGradingQueue:
      opts.listElearningManualGradingQueue ?? listElearningManualGradingQueue,
    getElearningManualGradingDetail:
      opts.getElearningManualGradingDetail ?? getElearningManualGradingDetail,
    publishElearningCourse:
      opts.publishElearningCourse ?? publishElearningCourse,
    listElearningLearnerCourses:
      opts.listElearningLearnerCourses ?? listElearningLearnerCourses,
    setElearningCourseScope:
      opts.setElearningCourseScope ?? setElearningCourseScopeAuthorized,
    publishElearningTrainingPlan:
      opts.publishElearningTrainingPlan ?? publishElearningTrainingPlan,
    getElearningTrainingPlan:
      opts.getElearningTrainingPlan ?? getElearningTrainingPlan,
    assignElearningTrainingPlan:
      opts.assignElearningTrainingPlan ?? assignElearningTrainingPlanAuthorized,
    revokeElearningTrainingPlanAssignment:
      opts.revokeElearningTrainingPlanAssignment
      ?? revokeElearningTrainingPlanAssignmentAuthorized,
  }) : null
  const credit = creditEnabled ? createElearningCreditRouter({
    db: opts.db,
    env,
    viewerId: opts.viewerId ?? viewerId,
    orgId: opts.orgId ?? orgId,
    readGuard: opts.readGuard
      ?? rbacGuardAny(['elearning:read', 'elearning:write', 'elearning:admin']),
    adminGuard: opts.adminGuard ?? rbacGuard('elearning', 'admin'),
    publishElearningCreditRule: opts.publishElearningCreditRule,
    listElearningCreditRules: opts.listElearningCreditRules,
    getElearningCreditWallet: opts.getElearningCreditWallet,
    adjustElearningCredit: opts.adjustElearningCredit,
    getActiveElearningTitleSnapshot: opts.getActiveElearningTitleSnapshot,
    publishElearningTitleSnapshot: opts.publishElearningTitleSnapshot,
    listActiveElearningCertificateTemplates:
      opts.listActiveElearningCertificateTemplates,
    publishElearningCertificateTemplate:
      opts.publishElearningCertificateTemplate,
    issueElearningCertificate: opts.issueElearningCertificate,
    listMyElearningCertificates: opts.listMyElearningCertificates,
  }) : null
  if (!inner && !credit) return null

  const router = Router()
  router.use('/api/elearning', opts.authenticate ?? authenticate)
  if (content) router.use(content)
  if (inner) router.use(inner)
  if (credit) router.use(credit)
  return { router }
}
