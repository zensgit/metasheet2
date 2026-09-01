import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, expectTypeOf, it } from 'vitest'

import type { components, paths } from '../index.js'

type Capabilities = components['schemas']['ElearningCapabilities']
type Flags = components['schemas']['ElearningCapabilityFlags']
type MediaUpload = components['schemas']['ElearningMediaUploadResult']
type PublishRequest = components['schemas']['ElearningCoursePublishRequest']
type PublishResult = components['schemas']['ElearningCoursePublishResult']
type QuestionBankCreateRequest = components['schemas']['ElearningQuestionBankCreateRequest']
type QuestionBankResult = components['schemas']['ElearningQuestionBankResult']
type QuestionBankListResult = components['schemas']['ElearningQuestionBankListResult']
type QuestionBankQuestionsResult = components['schemas']['ElearningQuestionBankQuestionsResult']
type QuestionWriteRequest = components['schemas']['ElearningQuestionWriteRequest']
type QuestionRevisionResult = components['schemas']['ElearningQuestionRevisionResult']
type QuestionImportResult = components['schemas']['ElearningQuestionImportResult']
type FixedPaperPublishRequest = components['schemas']['ElearningFixedPaperPublishRequest']
type FixedPaperResult = components['schemas']['ElearningFixedPaperResult']
type PaperExamPublishRequest = components['schemas']['ElearningPaperExamPublishRequest']
type PaperExamResult = components['schemas']['ElearningPaperExamResult']
type AssignRequest = components['schemas']['ElearningDirectAssignmentRequest']
type AssignResult = components['schemas']['ElearningDirectAssignmentResult']
type AssignmentProgress = components['schemas']['ElearningAssignmentProgressResult']
type AssignmentMember = components['schemas']['ElearningAssignmentProgressMember']
type AssignmentRevokeRequest = components['schemas']['ElearningAssignmentRevocationRequest']
type AssignmentRevokeResult = components['schemas']['ElearningAssignmentRevocationResult']
type TrainingPlanPublishRequest = components['schemas']['ElearningTrainingPlanPublishRequest']
type TrainingPlanPublishResult = components['schemas']['ElearningTrainingPlanPublishResult']
type TrainingPlanAssignmentRequest = components['schemas']['ElearningTrainingPlanAssignmentRequest']
type TrainingPlanAssignmentResult = components['schemas']['ElearningTrainingPlanAssignmentResult']
type TrainingPlanRevocationResult = components['schemas']['ElearningTrainingPlanRevocationResult']
type TrainingPlan = components['schemas']['ElearningTrainingPlan']
type AdminScopeReplaceRequest = components['schemas']['ElearningAdminScopeReplaceRequest']
type AdminScopeReplaceResult = components['schemas']['ElearningAdminScopeReplaceResult']
type ObjectAclReplaceRequest = components['schemas']['ElearningObjectAclReplaceRequest']
type ObjectAclReplaceResult = components['schemas']['ElearningObjectAclReplaceResult']
type LearnerList = components['schemas']['ElearningLearnerCourseList']
type WatchState = components['schemas']['ElearningWatchState']
type Heartbeat = components['schemas']['ElearningHeartbeatRequest']
type Ticket = components['schemas']['ElearningPlaybackTicket']
type PublicPaper = components['schemas']['ElearningPublicPaper']
type PublicQuestion = components['schemas']['ElearningPublicQuestion']
type ExamStart = components['schemas']['ElearningExamStartResult']
type ExamSubmit = components['schemas']['ElearningExamSubmitResult']
type ExamReview = components['schemas']['ElearningExamReviewResult']
type ExamReviewQuestion = components['schemas']['ElearningExamReviewQuestion']
type ExamAnswers = components['schemas']['ElearningExamSubmitRequest']
type ElearningError = components['schemas']['ElearningError']
type CreditAdjustmentRequest = components['schemas']['ElearningCreditAdjustmentRequest']
type CreditAdjustmentResult = components['schemas']['ElearningCreditAdjustmentResult']
type CreditAutomaticBehavior = components['schemas']['ElearningCreditAutomaticBehavior']
type CreditAutomaticWalletItem = components['schemas']['ElearningCreditAutomaticWalletItem']
type CreditManualWalletItem = components['schemas']['ElearningCreditManualWalletItem']
type CreditWalletItem = components['schemas']['ElearningCreditWalletItem']
type CreditWallet = components['schemas']['ElearningCreditWallet']
type LearningProfile = components['schemas']['ElearningLearningProfile']
type LearningProfileCourse = components['schemas']['ElearningLearningProfileCourse']
type TitleRow = components['schemas']['ElearningTitleRow']
type TitlePublishRequest = components['schemas']['ElearningTitlePublishRequest']
type TitleSnapshot = components['schemas']['ElearningTitleSnapshot']
type CertificateTemplatePublishRequest = components['schemas']['ElearningCertificateTemplatePublishRequest']
type CertificateTemplate = components['schemas']['ElearningCertificateTemplate']
type CertificateTemplateList = components['schemas']['ElearningCertificateTemplateList']
type CertificateIssueRequest = components['schemas']['ElearningCertificateIssueRequest']
type CertificateIssue = components['schemas']['ElearningCertificateIssue']
type CertificateIssueList = components['schemas']['ElearningCertificateIssueList']
type ContentRevisionRequest = components['schemas']['ElearningContentRevisionRequest']
type ContentRevisionResult = components['schemas']['ElearningContentRevision']
type ContentCoursePublishRequest = components['schemas']['ElearningContentCoursePublishRequest']
type ContentCoursePublishResult = components['schemas']['ElearningContentCoursePublishResult']
type OpenCompletionRequest = components['schemas']['ElearningOpenCompletionRequest']
type OpenCompletionResult = components['schemas']['ElearningOpenCompletionResult']
type LearnerAssessmentCourse = components['schemas']['ElearningLearnerAssessmentCourse']
type LearnerContentCourse = components['schemas']['ElearningLearnerContentCourse']
type LearnerContentItem = components['schemas']['ElearningLearnerContentItem']
type LearnerCourse = components['schemas']['ElearningLearnerCourse']
type PortalNavigationItem = components['schemas']['ElearningPortalNavigationItem']
type PortalEmptySettings = components['schemas']['ElearningPortalEmptySettings']
type PortalActiveSettings = components['schemas']['ElearningPortalActiveSettings']
type PortalSettings = components['schemas']['ElearningPortalSettings']
type PortalPublishRequest = components['schemas']['ElearningPortalPublishRequest']
type PortalPublishResult = components['schemas']['ElearningPortalPublishResult']
type PracticeMode = components['schemas']['ElearningPracticeMode']
type PracticeSetCreateRequest = components['schemas']['ElearningPracticeSetCreateRequest']
type PracticeSetCreateResult = components['schemas']['ElearningPracticeSetCreateResult']
type PracticeSetList = components['schemas']['ElearningPracticeSetList']
type PracticeQuestion = components['schemas']['ElearningPracticeQuestion']
type PracticeSessionStartRequest = components['schemas']['ElearningPracticeSessionStartRequest']
type PracticeSessionStartResult = components['schemas']['ElearningPracticeSessionStartResult']
type PracticeAnswerRequest = components['schemas']['ElearningPracticeAnswerRequest']
type PracticeAnswerResult = components['schemas']['ElearningPracticeAnswerResult']
type PracticeWrongQuestionList = components['schemas']['ElearningPracticeWrongQuestionList']
type AnalyticsExportCreateRequest = components['schemas']['ElearningAnalyticsExportCreateRequest']
type AnalyticsExportResult = components['schemas']['ElearningAnalyticsExportResult']
type OfflineTrainingPublishRequest = components['schemas']['ElearningOfflineTrainingPublishRequest']
type OfflineTrainingPublishResult = components['schemas']['ElearningOfflineTrainingPublishResult']
type OfflineQrIssueRequest = components['schemas']['ElearningOfflineQrIssueRequest']
type OfflineQrResult = components['schemas']['ElearningOfflineQrResult']
type OfflineAttendanceRequest = components['schemas']['ElearningOfflineAttendanceRequest']
type OfflineAttendanceResult = components['schemas']['ElearningOfflineAttendanceResult']
type OfflineLearnerTrainingList = components['schemas']['ElearningOfflineLearnerTrainingList']

const FORBIDDEN_LEARNER_KEYS = new Set([
  'answerKey',
  'answer_key',
  'correct',
  'correctOptionIds',
  'explanation',
  'storageKey',
  'storage_key',
  'signingSecret',
  'signing_secret',
  'signingKey',
  'signing_key',
  'signingMaterial',
  'signing_material',
  'paperSnapshot',
  'paper_snapshot',
])

const LEARNER_OUTPUT_ROOTS = [
  'ElearningExamStartResult',
  'ElearningPublicPaper',
  'ElearningPublicQuestion',
  'ElearningExamSubmitResult',
  'ElearningPlaybackTicket',
  'ElearningMediaUploadResult',
  'ElearningLearnerCourseList',
  'ElearningAssignmentProgressResult',
  'ElearningAssignmentProgressMember',
  'ElearningAssignmentRevocationResult',
  'ElearningPracticeSessionStartResult',
  'ElearningPracticeWrongQuestionList',
  'ElearningOfflineLearnerTrainingList',
] as const

const here = dirname(fileURLToPath(import.meta.url))

type JsonSchema = {
  $ref?: string
  type?: string
  format?: string
  description?: string
  required?: string[]
  enum?: unknown[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  maxProperties?: number
  uniqueItems?: boolean
  not?: JsonSchema
  properties?: Record<string, JsonSchema>
  items?: JsonSchema | JsonSchema[]
  maxItems?: number
  additionalProperties?: JsonSchema | boolean
  allOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  anyOf?: JsonSchema[]
  discriminator?: {
    propertyName?: string
    mapping?: Record<string, string>
  }
}

function isForbiddenLearnerKey(key: string): boolean {
  return FORBIDDEN_LEARNER_KEYS.has(key)
    || (/signing/i.test(key) && /(secret|key|material)/i.test(key))
}

function collectForbiddenKeys(
  schemas: Record<string, JsonSchema>,
  schema: JsonSchema | undefined,
  seen = new Set<string>(),
  allowedKeys = new Set<string>(),
): string[] {
  if (!schema) return []
  if (schema.$ref) {
    const name = schema.$ref.replace('#/components/schemas/', '')
    if (seen.has(name)) return []
    seen.add(name)
    return collectForbiddenKeys(schemas, schemas[name], seen, allowedKeys)
  }
  const hits: string[] = []
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    if (isForbiddenLearnerKey(key) && !allowedKeys.has(key)) hits.push(key)
    hits.push(...collectForbiddenKeys(schemas, child, seen, allowedKeys))
  }
  const items = schema.items
  for (const item of items ? (Array.isArray(items) ? items : [items]) : []) {
    hits.push(...collectForbiddenKeys(schemas, item, seen, allowedKeys))
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    hits.push(...collectForbiddenKeys(schemas, schema.additionalProperties, seen, allowedKeys))
  }
  for (const part of [...(schema.allOf ?? []), ...(schema.oneOf ?? []), ...(schema.anyOf ?? [])]) {
    hits.push(...collectForbiddenKeys(schemas, part, seen, allowedKeys))
  }
  return hits
}

function jsonSchemaAt(
  doc: { paths?: Record<string, any>; components?: { schemas?: Record<string, JsonSchema> } },
  path: string,
  method: string,
  status: string,
): JsonSchema {
  const schema = doc.paths?.[path]?.[method]?.responses?.[status]?.content?.['application/json']?.schema
  if (!schema) throw new Error(`missing ${method.toUpperCase()} ${path} ${status} JSON schema`)
  return schema
}

describe('elearning V0.1 OpenAPI paths', () => {
  it('exposes the live named-pilot routes in generated SDK types', () => {
    expectTypeOf<paths['/api/elearning/capabilities']['get']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/admin/credit-titles']['get']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/admin/credit-titles']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/admin/certificate-templates']['get']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/admin/certificate-templates']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/admin/certificate-issues']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/certificates']['get']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/portal']['get']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/admin/portal']['put']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/admin/credits/adjustments']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/admin/content-revisions']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/admin/courses/content/publish']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/me/course-items/{itemId}/open']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/admin/practice-sets']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/me/practice-sets']['get']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/me/practice-sessions']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/me/practice-sessions/{sessionId}/answers']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/me/practice-sets/{practiceSetId}/wrong-questions']['get']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/admin/analytics/exports']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/admin/analytics/exports/{exportId}']['get']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/admin/analytics/exports/{exportId}/download']['get']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/media']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/courses/publish']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/assessment/question-banks']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/assessment/question-banks']['get']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/assessment/question-banks/{bankId}/questions']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/assessment/question-banks/{bankId}/questions']['get']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/assessment/questions/{questionId}/revisions']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/assessment/question-banks/{bankId}/import']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/assessment/papers']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/assessment/exams']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/assignments/direct']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/assignments/{assignmentId}']['get']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/assignments/{assignmentId}/members/{memberId}/revocation']['put']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/training-plans/publish']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/training-plans/{planId}']['get']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/training-plans/{planId}/assign']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/training-plan-assignments/{planAssignmentId}/revocation']['put']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/admin-scopes/{userId}']['put']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/courses/{courseId}/collaborators/{userId}']['put']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/training-plans/{planId}/collaborators/{userId}']['put']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/me/courses']['get']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/watch/items/{itemId}/start']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/watch/sessions/{sessionId}/heartbeat']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/watch/items/{itemId}/playback-ticket']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/media/playback']['get']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/exams/items/{itemId}/start']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/exams/attempts/{attemptId}/answers']['put']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/exams/attempts/{attemptId}/submit']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/exams/attempts/{attemptId}/review']['get']>().not.toBeNever()
  })

  it('binds success bodies to the live DTOs', () => {
    expectTypeOf<
      paths['/api/elearning/capabilities']['get']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<Capabilities>()
    expectTypeOf<
      paths['/api/elearning/admin/credit-titles']['get']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<TitleSnapshot>()
    expectTypeOf<
      paths['/api/elearning/admin/credit-titles']['post']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<TitleSnapshot>()
    expectTypeOf<
      paths['/api/elearning/admin/certificate-templates']['get']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<CertificateTemplateList>()
    expectTypeOf<
      paths['/api/elearning/admin/certificate-templates']['post']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<CertificateTemplate>()
    expectTypeOf<
      paths['/api/elearning/admin/certificate-issues']['post']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<CertificateIssue>()
    expectTypeOf<
      paths['/api/elearning/certificates']['get']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<CertificateIssueList>()
    expectTypeOf<
      paths['/api/elearning/portal']['get']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<PortalSettings>()
    expectTypeOf<
      paths['/api/elearning/admin/portal']['put']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<PortalPublishResult>()
    expectTypeOf<
      paths['/api/elearning/admin/credits/adjustments']['post']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<CreditAdjustmentResult>()
    expectTypeOf<
      paths['/api/elearning/admin/content-revisions']['post']['responses']['201']['content']['application/json']
    >().toEqualTypeOf<ContentRevisionResult>()
    expectTypeOf<
      paths['/api/elearning/admin/courses/content/publish']['post']['responses']['201']['content']['application/json']
    >().toEqualTypeOf<ContentCoursePublishResult>()
    expectTypeOf<
      paths['/api/elearning/me/course-items/{itemId}/open']['post']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<OpenCompletionResult>()
    expectTypeOf<
      paths['/api/elearning/admin/practice-sets']['post']['responses']['201']['content']['application/json']
    >().toEqualTypeOf<PracticeSetCreateResult>()
    expectTypeOf<
      paths['/api/elearning/me/practice-sets']['get']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<PracticeSetList>()
    expectTypeOf<
      paths['/api/elearning/me/practice-sessions']['post']['responses']['201']['content']['application/json']
    >().toEqualTypeOf<PracticeSessionStartResult>()
    expectTypeOf<
      paths['/api/elearning/me/practice-sessions/{sessionId}/answers']['post']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<PracticeAnswerResult>()
    expectTypeOf<
      paths['/api/elearning/me/practice-sets/{practiceSetId}/wrong-questions']['get']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<PracticeWrongQuestionList>()
    expectTypeOf<
      paths['/api/elearning/media']['post']['responses']['201']['content']['application/json']
    >().toEqualTypeOf<MediaUpload>()
    expectTypeOf<
      paths['/api/elearning/courses/publish']['post']['responses']['201']['content']['application/json']
    >().toEqualTypeOf<PublishResult>()
    expectTypeOf<
      paths['/api/elearning/assessment/question-banks']['post']['responses']['201']['content']['application/json']
    >().toEqualTypeOf<QuestionBankResult>()
    expectTypeOf<
      paths['/api/elearning/assessment/question-banks']['get']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<QuestionBankListResult>()
    expectTypeOf<
      paths['/api/elearning/assessment/question-banks/{bankId}/questions']['post']['responses']['201']['content']['application/json']
    >().toEqualTypeOf<QuestionRevisionResult>()
    expectTypeOf<
      paths['/api/elearning/assessment/question-banks/{bankId}/questions']['get']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<QuestionBankQuestionsResult>()
    expectTypeOf<
      paths['/api/elearning/assessment/questions/{questionId}/revisions']['post']['responses']['201']['content']['application/json']
    >().toEqualTypeOf<QuestionRevisionResult>()
    expectTypeOf<
      paths['/api/elearning/assessment/question-banks/{bankId}/import']['post']['responses']['201']['content']['application/json']
    >().toEqualTypeOf<QuestionImportResult>()
    expectTypeOf<
      paths['/api/elearning/assessment/papers']['post']['responses']['201']['content']['application/json']
    >().toEqualTypeOf<FixedPaperResult>()
    expectTypeOf<
      paths['/api/elearning/assessment/exams']['post']['responses']['201']['content']['application/json']
    >().toEqualTypeOf<PaperExamResult>()
    expectTypeOf<
      paths['/api/elearning/assignments/direct']['post']['responses']['201']['content']['application/json']
    >().toEqualTypeOf<AssignResult>()
    expectTypeOf<
      paths['/api/elearning/assignments/{assignmentId}']['get']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<AssignmentProgress>()
    expectTypeOf<
      paths['/api/elearning/assignments/{assignmentId}/members/{memberId}/revocation']['put']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<AssignmentRevokeResult>()
    expectTypeOf<
      paths['/api/elearning/training-plans/publish']['post']['responses']['201']['content']['application/json']
    >().toEqualTypeOf<TrainingPlanPublishResult>()
    expectTypeOf<
      paths['/api/elearning/training-plans/{planId}']['get']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<TrainingPlan>()
    expectTypeOf<
      paths['/api/elearning/training-plans/{planId}/assign']['post']['responses']['201']['content']['application/json']
    >().toEqualTypeOf<TrainingPlanAssignmentResult>()
    expectTypeOf<
      paths['/api/elearning/training-plan-assignments/{planAssignmentId}/revocation']['put']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<TrainingPlanRevocationResult>()
    expectTypeOf<
      paths['/api/elearning/admin-scopes/{userId}']['put']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<AdminScopeReplaceResult>()
    expectTypeOf<
      paths['/api/elearning/courses/{courseId}/collaborators/{userId}']['put']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<ObjectAclReplaceResult>()
    expectTypeOf<
      paths['/api/elearning/training-plans/{planId}/collaborators/{userId}']['put']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<ObjectAclReplaceResult>()
    expectTypeOf<
      paths['/api/elearning/me/courses']['get']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<LearnerList>()
    expectTypeOf<
      paths['/api/elearning/watch/items/{itemId}/start']['post']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<WatchState>()
    expectTypeOf<
      paths['/api/elearning/watch/sessions/{sessionId}/heartbeat']['post']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<WatchState>()
    expectTypeOf<
      paths['/api/elearning/watch/items/{itemId}/playback-ticket']['post']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<Ticket>()
    expectTypeOf<
      paths['/api/elearning/exams/items/{itemId}/start']['post']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<ExamStart>()
    expectTypeOf<
      paths['/api/elearning/exams/attempts/{attemptId}/answers']['put']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<ExamStart>()
    expectTypeOf<
      paths['/api/elearning/exams/attempts/{attemptId}/submit']['post']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<ExamSubmit>()
    expectTypeOf<
      paths['/api/elearning/exams/attempts/{attemptId}/review']['get']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<ExamReview>()
    expectTypeOf<
      paths['/api/elearning/admin/analytics/exports']['post']['responses']['202']['content']['application/json']
    >().toEqualTypeOf<AnalyticsExportResult>()
    expectTypeOf<
      paths['/api/elearning/admin/analytics/exports/{exportId}']['get']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<AnalyticsExportResult>()
  })

  it('keeps aggregate export commands and status results closed and values-free', () => {
    expectTypeOf<AnalyticsExportCreateRequest>().toEqualTypeOf<{
      requestId: string
      departmentId: string
      periodStart: string
      periodEnd: string
    }>()
    expectTypeOf<AnalyticsExportResult>().toEqualTypeOf<{
      exportId: string
      departmentId: string
      periodStart: string
      periodEnd: string
      status: 'pending' | 'running' | 'succeeded' | 'failed' | 'expired'
      expiresAt: string
      completedAt: string | null
      errorCode: string | null
      duplicate: boolean
    }>()
    expectTypeOf<
      paths['/api/elearning/admin/analytics/exports/{exportId}/download']['get']['responses']['200']['content']['text/csv']
    >().toEqualTypeOf<string>()

    const doc = JSON.parse(readFileSync(join(here, '..', '..', 'dist', 'openapi.json'), 'utf8')) as {
      paths?: Record<string, any>
      components?: { schemas?: Record<string, JsonSchema> }
    }
    const schemas = doc.components?.schemas ?? {}
    const create = doc.paths?.['/api/elearning/admin/analytics/exports']?.post
    const read = doc.paths?.['/api/elearning/admin/analytics/exports/{exportId}']?.get
    const download = doc.paths?.['/api/elearning/admin/analytics/exports/{exportId}/download']?.get

    expect(create?.security).toEqual([{ bearerAuth: [] }])
    expect(create?.description).toContain('elearning:admin')
    expect(create?.description).toContain('server-derived')
    expect(create?.description).not.toMatch(/storageKey|fileSha|fileSize|querySnapshot|actorId|orgId/)
    expect(create?.requestBody?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/ElearningAnalyticsExportCreateRequest' })
    expect(create?.responses?.['202']?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/ElearningAnalyticsExportResult' })
    expect(read?.responses?.['200']?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/ElearningAnalyticsExportResult' })
    expect(download?.responses?.['200']?.content?.['text/csv']?.schema)
      .toEqual({ type: 'string', format: 'binary' })
    for (const operation of [create, read, download]) {
      expect(operation?.security).toEqual([{ bearerAuth: [] }])
      expect(JSON.stringify(operation?.responses ?? {})).not.toContain('detail')
    }

    expect(schemas.ElearningAnalyticsExportCreateRequest).toMatchObject({
      additionalProperties: false,
      required: ['requestId', 'departmentId', 'periodStart', 'periodEnd'],
    })
    expect(Object.keys(schemas.ElearningAnalyticsExportCreateRequest?.properties ?? {}).sort())
      .toEqual(['departmentId', 'periodEnd', 'periodStart', 'requestId'])
    expect(schemas.ElearningAnalyticsExportResult).toMatchObject({
      additionalProperties: false,
      required: [
        'exportId', 'departmentId', 'periodStart', 'periodEnd', 'status',
        'expiresAt', 'completedAt', 'errorCode', 'duplicate',
      ],
    })
    expect(Object.keys(schemas.ElearningAnalyticsExportResult?.properties ?? {}).sort())
      .toEqual([
        'completedAt', 'departmentId', 'duplicate', 'errorCode', 'expiresAt',
        'exportId', 'periodEnd', 'periodStart', 'status',
      ])
    expect(JSON.stringify(schemas.ElearningAnalyticsExportResult)).not.toMatch(
      /storageKey|fileSha|fileSize|querySnapshot|snapshot|orgId|actorId|answer|trace|grade/,
    )
  })

  it('documents playback Range 200/206/416 without a JSON success body', () => {
    expectTypeOf<
      paths['/api/elearning/media/playback']['get']['responses']['200']['content']['video/mp4']
    >().toEqualTypeOf<string>()
    expectTypeOf<
      paths['/api/elearning/media/playback']['get']['responses']['206']['content']['video/mp4']
    >().toEqualTypeOf<string>()
    expectTypeOf<
      paths['/api/elearning/media/playback']['get']['responses']['416']['content']['application/json']
    >().toMatchTypeOf<ElearningError>()
  })

  it('keeps capability flags closed and includes parked incentive/analytics keys', () => {
    expectTypeOf<Flags>().toEqualTypeOf<{
      content: boolean
      assignment: boolean
      assessment: boolean
      incentive: boolean
      analytics: boolean
      media: boolean
    }>()
    expectTypeOf<Capabilities>().toEqualTypeOf<{
      enabled: boolean
      capabilities: Flags
    }>()
  })

  it('keeps manual adjustment and wallet history contracts closed and discriminated', () => {
    expectTypeOf<CreditAdjustmentRequest>().toEqualTypeOf<{
      requestId: string
      userId: string
      points: number
      reason: string
    }>()
    expectTypeOf<
      NonNullable<paths['/api/elearning/admin/credits/adjustments']['post']['requestBody']>['content']['application/json']
    >().toEqualTypeOf<CreditAdjustmentRequest>()
    expectTypeOf<CreditAdjustmentResult>().toEqualTypeOf<{
      adjustmentId: string
      userId: string
      points: number
      balancePoints: number
      createdAt: string
    }>()
    expectTypeOf<CreditWalletItem>()
      .toEqualTypeOf<CreditAutomaticWalletItem | CreditManualWalletItem>()
    expectTypeOf<Extract<CreditAutomaticBehavior, 'manual_adjust'>>().toBeNever()
    expectTypeOf<CreditAutomaticWalletItem>().toEqualTypeOf<{
      decisionId: string
      behavior: CreditAutomaticBehavior
      awardedPoints: number
      status: 'awarded' | 'capped' | 'exhausted'
      occurredAt: string
      createdAt: string
    }>()
    expectTypeOf<CreditManualWalletItem>().toEqualTypeOf<{
      decisionId: string
      behavior: 'manual_adjust'
      awardedPoints: number
      status: 'adjusted'
      occurredAt: string
      createdAt: string
    }>()
    expectTypeOf<CreditWallet>().toEqualTypeOf<{
      userId: string
      balancePoints: number
      currentTitle: TitleRow | null
      items: CreditWalletItem[]
      nextCursor: string | null
    }>()

    const doc = JSON.parse(readFileSync(join(here, '..', '..', 'dist', 'openapi.json'), 'utf8')) as {
      paths?: Record<string, any>
      components?: { schemas?: Record<string, JsonSchema> }
    }
    const schemas = doc.components?.schemas ?? {}
    const operation = doc.paths?.['/api/elearning/admin/credits/adjustments']?.post
    expect(operation?.security).toEqual([{ bearerAuth: [] }])
    expect(operation?.description).toContain('elearning:admin')
    expect(operation?.description).toContain('ELEARNING_ENABLED')
    expect(operation?.description).toContain('ELEARNING_INCENTIVE_ENABLED')
    expect(operation?.description).toContain('exact literal `true`')
    expect(operation?.description).toContain('Organization and actor are derived')
    expect(operation?.requestBody?.content?.['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/ElearningCreditAdjustmentRequest',
    })
    expect(operation?.responses?.['200']?.content?.['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/ElearningCreditAdjustmentResult',
    })
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
      '200', '400', '401', '403', '404', '409', '503',
    ])
    for (const status of ['400', '403', '404', '409', '503']) {
      expect(operation?.responses?.[status]?.$ref)
        .toBe('#/components/responses/ElearningError')
    }

    const request = schemas.ElearningCreditAdjustmentRequest
    expect(request?.additionalProperties).toBe(false)
    expect(request?.required).toEqual(['requestId', 'userId', 'points', 'reason'])
    expect(Object.keys(request?.properties ?? {}).sort()).toEqual([
      'points', 'reason', 'requestId', 'userId',
    ])
    expect(request?.properties?.points).toMatchObject({
      type: 'integer',
      format: 'int32',
      minimum: -2147483647,
      maximum: 2147483647,
      not: { enum: [0] },
    })

    const result = schemas.ElearningCreditAdjustmentResult
    expect(result?.additionalProperties).toBe(false)
    expect(result?.required).toEqual([
      'adjustmentId', 'userId', 'points', 'balancePoints', 'createdAt',
    ])
    expect(Object.keys(result?.properties ?? {}).sort()).toEqual([
      'adjustmentId', 'balancePoints', 'createdAt', 'points', 'userId',
    ])
    expect(result?.properties?.points).toMatchObject({
      minimum: -2147483647,
      maximum: 2147483647,
      not: { enum: [0] },
    })
    expect(result?.properties?.balancePoints).toMatchObject({
      minimum: 0,
      maximum: 2147483647,
    })

    expect(schemas.ElearningCreditAutomaticBehavior?.enum).toEqual([
      'login',
      'complete_course',
      'complete_plan',
      'pass_exam',
      'submit_survey',
      'complete_map',
      'complete_offline',
    ])
    expect(schemas.ElearningCreditAutomaticBehavior?.enum).not.toContain('manual_adjust')
    expect(schemas.ElearningCreditAutomaticWalletItem).toMatchObject({
      additionalProperties: false,
      description: expect.stringContaining('rule-backed'),
      required: ['decisionId', 'behavior', 'awardedPoints', 'status', 'occurredAt', 'createdAt'],
      properties: {
        behavior: { $ref: '#/components/schemas/ElearningCreditAutomaticBehavior' },
        awardedPoints: { minimum: 0, maximum: 2147483647 },
        status: { enum: ['awarded', 'capped', 'exhausted'] },
      },
    })
    expect(schemas.ElearningCreditManualWalletItem).toMatchObject({
      additionalProperties: false,
      description: expect.stringContaining('nonzero signed int4'),
      required: ['decisionId', 'behavior', 'awardedPoints', 'status', 'occurredAt', 'createdAt'],
      properties: {
        behavior: { enum: ['manual_adjust'] },
        awardedPoints: {
          minimum: -2147483647,
          maximum: 2147483647,
          not: { enum: [0] },
        },
        status: { enum: ['adjusted'] },
      },
    })
    expect(schemas.ElearningCreditWalletItem).toEqual({
      oneOf: [
        { $ref: '#/components/schemas/ElearningCreditAutomaticWalletItem' },
        { $ref: '#/components/schemas/ElearningCreditManualWalletItem' },
      ],
      discriminator: {
        propertyName: 'behavior',
        mapping: {
          login: '#/components/schemas/ElearningCreditAutomaticWalletItem',
          complete_course: '#/components/schemas/ElearningCreditAutomaticWalletItem',
          complete_plan: '#/components/schemas/ElearningCreditAutomaticWalletItem',
          pass_exam: '#/components/schemas/ElearningCreditAutomaticWalletItem',
          submit_survey: '#/components/schemas/ElearningCreditAutomaticWalletItem',
          complete_map: '#/components/schemas/ElearningCreditAutomaticWalletItem',
          complete_offline: '#/components/schemas/ElearningCreditAutomaticWalletItem',
          manual_adjust: '#/components/schemas/ElearningCreditManualWalletItem',
        },
      },
    })
    expect(schemas.ElearningCreditWallet?.properties?.balancePoints).toMatchObject({
      minimum: 0,
      maximum: 2147483647,
    })
    expect(schemas.ElearningCreditWallet).toMatchObject({
      additionalProperties: false,
      required: ['userId', 'balancePoints', 'currentTitle', 'items', 'nextCursor'],
      properties: {
        currentTitle: {
          oneOf: [
            { $ref: '#/components/schemas/ElearningTitleRow' },
            { type: 'null' },
          ],
        },
      },
    })
  })

  it('keeps title configuration and wallet title DTOs closed and server-authoritative', () => {
    expectTypeOf<TitleRow>().toEqualTypeOf<{
      id: string
      name: string
      threshold: number
    }>()
    expectTypeOf<TitlePublishRequest>().toEqualTypeOf<{
      requestId: string
      titles: TitleRow[]
    }>()
    expectTypeOf<TitleSnapshot>().toEqualTypeOf<{
      revisionId: string | null
      version: number
      titles: TitleRow[]
      createdAt: string | null
    }>()
    expectTypeOf<
      NonNullable<paths['/api/elearning/admin/credit-titles']['post']['requestBody']>['content']['application/json']
    >().toEqualTypeOf<TitlePublishRequest>()

    const doc = JSON.parse(readFileSync(join(here, '..', '..', 'dist', 'openapi.json'), 'utf8')) as {
      paths?: Record<string, any>
      components?: { schemas?: Record<string, JsonSchema> }
    }
    const schemas = doc.components?.schemas ?? {}
    const operation = doc.paths?.['/api/elearning/admin/credit-titles']
    for (const method of ['get', 'post']) {
      expect(operation?.[method]?.security).toEqual([{ bearerAuth: [] }])
      expect(operation?.[method]?.description).toContain('elearning:admin')
      expect(operation?.[method]?.responses?.['200']?.content?.['application/json']?.schema)
        .toEqual({ $ref: '#/components/schemas/ElearningTitleSnapshot' })
    }
    expect(operation?.get?.description).toContain('server-derived')
    expect(operation?.post?.description).toContain('server-derived')
    expect(operation?.post?.requestBody?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/ElearningTitlePublishRequest' })
    expect(Object.keys(operation?.post?.responses ?? {}).sort())
      .toEqual(['200', '400', '401', '403', '404', '409', '503'])

    expect(schemas.ElearningTitleRow).toMatchObject({
      additionalProperties: false,
      required: ['id', 'name', 'threshold'],
      properties: {
        threshold: {
          type: 'integer',
          format: 'int32',
          minimum: 0,
          maximum: 2147483647,
        },
      },
    })
    expect(schemas.ElearningTitlePublishRequest).toMatchObject({
      additionalProperties: false,
      required: ['requestId', 'titles'],
      properties: {
        titles: {
          type: 'array',
          maxItems: 100,
          items: { $ref: '#/components/schemas/ElearningTitleRow' },
        },
      },
    })
    expect(schemas.ElearningTitleSnapshot).toMatchObject({
      additionalProperties: false,
      required: ['revisionId', 'version', 'titles', 'createdAt'],
      properties: {
        revisionId: {
          oneOf: [
            { $ref: '#/components/schemas/ElearningUuid' },
            { type: 'null' },
          ],
        },
        version: { minimum: 0, maximum: 2147483647 },
        titles: {
          type: 'array',
          maxItems: 100,
          items: { $ref: '#/components/schemas/ElearningTitleRow' },
        },
        createdAt: {
          oneOf: [
            { type: 'string', format: 'date-time' },
            { type: 'null' },
          ],
        },
      },
    })
  })

  it('keeps the learner learning profile session-owned, paginated, and structurally closed', () => {
    expectTypeOf<
      paths['/api/elearning/profile']['get']['responses'][200]['content']['application/json']
    >().toEqualTypeOf<LearningProfile>()
    expectTypeOf<LearningProfile['courses'][number]>().toEqualTypeOf<LearningProfileCourse>()

    const doc = JSON.parse(readFileSync(join(here, '..', '..', 'dist', 'openapi.json'), 'utf8')) as {
      paths?: Record<string, any>
      components?: { schemas?: Record<string, JsonSchema> }
    }
    const schemas = doc.components?.schemas ?? {}
    const path = doc.paths?.['/api/elearning/profile']?.get
    expect(path?.operationId).toBe('getMyElearningLearningProfile')
    expect(path?.security).toEqual([{ bearerAuth: [] }])
    expect(path?.requestBody).toBeUndefined()
    expect(path?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'cursor', in: 'query', required: false }),
      expect.objectContaining({ name: 'limit', in: 'query', required: false }),
    ]))
    expect(path?.responses?.['200']?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/ElearningLearningProfile' })

    expect(schemas.ElearningLearningProfile).toMatchObject({
      additionalProperties: false,
      required: ['userId', 'summary', 'courses', 'nextCursor'],
      properties: {
        summary: { $ref: '#/components/schemas/ElearningLearningProfileSummary' },
        courses: {
          type: 'array',
          items: { $ref: '#/components/schemas/ElearningLearningProfileCourse' },
        },
      },
    })
    expect(schemas.ElearningLearningProfileSummary).toMatchObject({
      additionalProperties: false,
      required: ['completedCourses', 'assessmentCourses', 'contentCourses'],
    })
    expect(schemas.ElearningLearningProfileCourse).toEqual({
      oneOf: [
        { $ref: '#/components/schemas/ElearningLearningProfileAssessmentCourse' },
        { $ref: '#/components/schemas/ElearningLearningProfileContentCourse' },
      ],
      discriminator: {
        propertyName: 'kind',
        mapping: {
          assessment: '#/components/schemas/ElearningLearningProfileAssessmentCourse',
          content: '#/components/schemas/ElearningLearningProfileContentCourse',
        },
      },
    })
    expect(schemas.ElearningLearningProfileAssessmentCourse).toMatchObject({
      additionalProperties: false,
      required: ['courseId', 'courseVersionId', 'title', 'kind', 'completedAt', 'exams'],
      properties: {
        kind: { enum: ['assessment'] },
        exams: {
          type: 'array',
          minItems: 1,
          items: { $ref: '#/components/schemas/ElearningLearningProfileExam' },
        },
      },
    })
    expect(schemas.ElearningLearningProfileContentCourse).toMatchObject({
      additionalProperties: false,
      required: ['courseId', 'courseVersionId', 'title', 'kind', 'completedAt'],
      properties: { kind: { enum: ['content'] } },
    })
    expect(schemas.ElearningLearningProfileExam).toMatchObject({
      additionalProperties: false,
      required: ['itemId', 'earnedScore', 'totalScore', 'passedAt'],
      properties: {
        earnedScore: { type: 'number', minimum: 0 },
        totalScore: { type: 'number', minimum: 0 },
      },
    })
    expect(JSON.stringify(schemas.ElearningLearningProfile)).not.toMatch(
      /answers|paperSnapshot|grading|eventDigest|requestHash|actorId/,
    )
  })

  it('keeps portal presentation reads and idempotent admin publication closed', () => {
    expectTypeOf<PortalNavigationItem>().toEqualTypeOf<{
      label: string
      href: string
    }>()
    expectTypeOf<PortalEmptySettings>().toEqualTypeOf<{
      revisionId: null
      version: 0
      siteName: null
      tagline: null
      bannerUrl: null
      navigation: PortalNavigationItem[]
      createdAt: null
    }>()
    expectTypeOf<PortalActiveSettings>().toEqualTypeOf<{
      revisionId: string
      version: number
      siteName: string
      tagline: string | null
      bannerUrl: string | null
      navigation: PortalNavigationItem[]
      createdAt: string
    }>()
    expectTypeOf<PortalSettings>().toEqualTypeOf<
      PortalEmptySettings | PortalActiveSettings
    >()
    expectTypeOf<PortalPublishRequest>().toEqualTypeOf<{
      requestId: string
      siteName: string
      tagline: string | null
      bannerUrl: string | null
      navigation: PortalNavigationItem[]
    }>()
    expectTypeOf<PortalPublishResult>().toEqualTypeOf<{
      revisionId: string
      version: number
      siteName: string
      tagline: string | null
      bannerUrl: string | null
      navigation: PortalNavigationItem[]
      createdAt: string
      duplicate: boolean
    }>()

    const doc = JSON.parse(readFileSync(join(here, '..', '..', 'dist', 'openapi.json'), 'utf8')) as {
      paths?: Record<string, any>
      components?: { schemas?: Record<string, JsonSchema> }
    }
    const schemas = doc.components?.schemas ?? {}
    const read = doc.paths?.['/api/elearning/portal']?.get
    const publish = doc.paths?.['/api/elearning/admin/portal']?.put
    expect(read?.operationId).toBe('getElearningPortalSettings')
    expect(read?.security).toEqual([{ bearerAuth: [] }])
    expect(read?.requestBody).toBeUndefined()
    expect(read?.responses?.['200']?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/ElearningPortalSettings' })
    expect(publish?.operationId).toBe('publishElearningPortalSettings')
    expect(publish?.security).toEqual([{ bearerAuth: [] }])
    expect(publish?.requestBody?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/ElearningPortalPublishRequest' })
    expect(publish?.responses?.['200']?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/ElearningPortalPublishResult' })

    expect(schemas.ElearningPortalSettings).toEqual({
      oneOf: [
        { $ref: '#/components/schemas/ElearningPortalEmptySettings' },
        { $ref: '#/components/schemas/ElearningPortalActiveSettings' },
      ],
    })
    expect(schemas.ElearningPortalEmptySettings).toMatchObject({
      additionalProperties: false,
      required: ['revisionId', 'version', 'siteName', 'tagline', 'bannerUrl', 'navigation', 'createdAt'],
      properties: {
        revisionId: { type: 'null' },
        version: { type: 'integer', format: 'int32', enum: [0] },
        siteName: { type: 'null' },
        createdAt: { type: 'null' },
      },
    })
    expect(schemas.ElearningPortalActiveSettings).toMatchObject({
      additionalProperties: false,
      required: ['revisionId', 'version', 'siteName', 'tagline', 'bannerUrl', 'navigation', 'createdAt'],
      properties: {
        revisionId: { $ref: '#/components/schemas/ElearningUuid' },
        version: { type: 'integer', format: 'int32', minimum: 1, maximum: 2147483647 },
        navigation: {
          type: 'array',
          maxItems: 8,
          items: { $ref: '#/components/schemas/ElearningPortalNavigationItem' },
        },
      },
    })
    expect(schemas.ElearningPortalPublishRequest).toMatchObject({
      additionalProperties: false,
      required: ['requestId', 'siteName', 'tagline', 'bannerUrl', 'navigation'],
    })
    expect(Object.keys(schemas.ElearningPortalPublishRequest?.properties ?? {}).sort())
      .toEqual(['bannerUrl', 'navigation', 'requestId', 'siteName', 'tagline'])
    expect(schemas.ElearningPortalPublishResult).toMatchObject({
      additionalProperties: false,
      required: [
        'revisionId', 'version', 'siteName', 'tagline', 'bannerUrl',
        'navigation', 'createdAt', 'duplicate',
      ],
    })
    expect(JSON.stringify({ read, publish, schemas: {
      settings: schemas.ElearningPortalSettings,
      request: schemas.ElearningPortalPublishRequest,
      result: schemas.ElearningPortalPublishResult,
    } })).not.toMatch(/orgId|actorId|requestHash|answerKey|paperSnapshot/)
  })

  it('keeps certificate template, issue, and learner DTOs closed without artifact claims', () => {
    expectTypeOf<CertificateTemplatePublishRequest>().toEqualTypeOf<{
      requestId: string
      certificateId: string
      name: string
      templateText: string
      backgroundImageUrl: string | null
    }>()
    expectTypeOf<CertificateTemplate>().toEqualTypeOf<{
      certificateId: string
      revisionId: string
      version: number
      name: string
      templateText: string
      backgroundImageUrl: string | null
      placeholders: string[]
      createdAt: string
    }>()
    expectTypeOf<CertificateTemplateList>().toEqualTypeOf<{
      items: CertificateTemplate[]
    }>()
    expectTypeOf<CertificateIssueRequest>().toEqualTypeOf<{
      requestId: string
      certificateId: string
      userId: string
      parameters: Record<string, string>
    }>()
    expectTypeOf<CertificateIssue>().toEqualTypeOf<{
      issueId: string
      certificateId: string
      templateRevisionId: string
      templateName: string
      serialNumber: string
      parameters: Record<string, string>
      backgroundImageUrl: string | null
      issuedAt: string
    }>()
    expectTypeOf<CertificateIssueList>().toEqualTypeOf<{
      items: CertificateIssue[]
    }>()
    expectTypeOf<
      NonNullable<paths['/api/elearning/admin/certificate-templates']['post']['requestBody']>['content']['application/json']
    >().toEqualTypeOf<CertificateTemplatePublishRequest>()
    expectTypeOf<
      NonNullable<paths['/api/elearning/admin/certificate-issues']['post']['requestBody']>['content']['application/json']
    >().toEqualTypeOf<CertificateIssueRequest>()

    const doc = JSON.parse(readFileSync(join(here, '..', '..', 'dist', 'openapi.json'), 'utf8')) as {
      paths?: Record<string, any>
      components?: { schemas?: Record<string, JsonSchema> }
    }
    const schemas = doc.components?.schemas ?? {}
    const templatePath = doc.paths?.['/api/elearning/admin/certificate-templates']
    const issueOperation = doc.paths?.['/api/elearning/admin/certificate-issues']?.post
    const learnerOperation = doc.paths?.['/api/elearning/certificates']?.get

    for (const operation of [templatePath?.get, templatePath?.post, issueOperation]) {
      expect(operation?.security).toEqual([{ bearerAuth: [] }])
      expect(operation?.description).toContain('ELEARNING_ENABLED')
      expect(operation?.description).toContain('ELEARNING_INCENTIVE_ENABLED')
      expect(operation?.description).toContain('elearning:admin')
    }
    expect(templatePath?.get?.description).toContain('server-derived')
    expect(templatePath?.post?.description).toContain('server-derived')
    expect(issueOperation?.description).toContain('server-derived')
    expect(learnerOperation?.description).toContain('server-derived')
    expect(learnerOperation?.security).toEqual([{ bearerAuth: [] }])
    expect(learnerOperation?.description).toContain('learner identity')

    expect(templatePath?.get?.responses?.['200']?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/ElearningCertificateTemplateList' })
    expect(templatePath?.post?.requestBody?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/ElearningCertificateTemplatePublishRequest' })
    expect(templatePath?.post?.responses?.['200']?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/ElearningCertificateTemplate' })
    expect(issueOperation?.requestBody?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/ElearningCertificateIssueRequest' })
    expect(issueOperation?.responses?.['200']?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/ElearningCertificateIssue' })
    expect(learnerOperation?.responses?.['200']?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/ElearningCertificateIssueList' })
    expect(Object.keys(templatePath?.post?.responses ?? {}).sort())
      .toEqual(['200', '400', '401', '403', '404', '409', '503'])
    expect(Object.keys(issueOperation?.responses ?? {}).sort())
      .toEqual(['200', '400', '401', '403', '404', '409', '503'])

    expect(schemas.ElearningCertificateTemplatePublishRequest).toMatchObject({
      additionalProperties: false,
      required: ['requestId', 'certificateId', 'name', 'templateText', 'backgroundImageUrl'],
      properties: {
        templateText: { type: 'string', maxLength: 16384 },
        backgroundImageUrl: {
          oneOf: [
            { type: 'string', format: 'uri', maxLength: 2048 },
            { type: 'null' },
          ],
        },
      },
    })
    expect(Object.keys(schemas.ElearningCertificateTemplatePublishRequest?.properties ?? {}).sort())
      .toEqual(['backgroundImageUrl', 'certificateId', 'name', 'requestId', 'templateText'])
    expect(schemas.ElearningCertificateTemplate).toMatchObject({
      additionalProperties: false,
      required: [
        'certificateId', 'revisionId', 'version', 'name', 'templateText',
        'backgroundImageUrl', 'placeholders', 'createdAt',
      ],
      description: expect.stringContaining('not a rendered or downloadable artifact'),
      properties: {
        version: { type: 'integer', format: 'int32', minimum: 1, maximum: 2147483647 },
        placeholders: { type: 'array', maxItems: 64, uniqueItems: true },
      },
    })
    expect(Object.keys(schemas.ElearningCertificateTemplate?.properties ?? {}).sort())
      .toEqual([
        'backgroundImageUrl', 'certificateId', 'createdAt', 'name', 'placeholders',
        'revisionId', 'templateText', 'version',
      ])
    expect(schemas.ElearningCertificateIssueRequest).toMatchObject({
      additionalProperties: false,
      required: ['requestId', 'certificateId', 'userId', 'parameters'],
      properties: {
        parameters: {
          type: 'object',
          maxProperties: 64,
          additionalProperties: { type: 'string', minLength: 1, maxLength: 2048 },
        },
      },
    })
    expect(Object.keys(schemas.ElearningCertificateIssueRequest?.properties ?? {}).sort())
      .toEqual(['certificateId', 'parameters', 'requestId', 'userId'])
    expect(schemas.ElearningCertificateIssue).toMatchObject({
      additionalProperties: false,
      required: [
        'issueId', 'certificateId', 'templateRevisionId', 'templateName',
        'serialNumber', 'parameters', 'backgroundImageUrl', 'issuedAt',
      ],
      description: expect.stringContaining('no PDF, render, image-generation, or download payload'),
    })
    expect(Object.keys(schemas.ElearningCertificateIssue?.properties ?? {}).sort())
      .toEqual([
        'backgroundImageUrl', 'certificateId', 'issueId', 'issuedAt', 'parameters',
        'serialNumber', 'templateName', 'templateRevisionId',
      ])
    expect(schemas.ElearningCertificateTemplateList).toMatchObject({
      additionalProperties: false,
      required: ['items'],
      properties: {
        items: { type: 'array', items: { $ref: '#/components/schemas/ElearningCertificateTemplate' } },
      },
    })
    expect(schemas.ElearningCertificateIssueList).toMatchObject({
      additionalProperties: false,
      required: ['items'],
      properties: {
        items: { type: 'array', items: { $ref: '#/components/schemas/ElearningCertificateIssue' } },
      },
    })

    const certificateDescriptions = [
      templatePath?.get?.description,
      templatePath?.post?.description,
      issueOperation?.description,
      learnerOperation?.description,
    ].join('\n').toLowerCase()
    expect(certificateDescriptions).toContain('pdf')
    expect(certificateDescriptions).toContain('download')
    expect(Object.keys(doc.paths ?? {}).filter((path) => (
      path.includes('certificate') && /(pdf|render|download)/i.test(path)
    ))).toEqual([])
  })

  it('keeps content authoring, publishing, opening, and learner course shapes closed', () => {
    expectTypeOf<ContentRevisionRequest>().toEqualTypeOf<
      | {
          requestId: string
          itemType: 'article'
          title: string
          articleHtml: string
          externalUrl: null
        }
      | {
          requestId: string
          itemType: 'external_link'
          title: string
          articleHtml: null
          externalUrl: string
        }
    >()
    expectTypeOf<ContentRevisionResult>().toEqualTypeOf<
      | {
          contentRevisionId: string
          itemType: 'article'
          title: string
          articleHtml: string
          externalUrl: null
          contentDigest: string
        }
      | {
          contentRevisionId: string
          itemType: 'external_link'
          title: string
          articleHtml: null
          externalUrl: string
          contentDigest: string
        }
    >()
    expectTypeOf<ContentCoursePublishRequest>().toEqualTypeOf<{
      requestId: string
      title: string
      items: Array<{
        itemType: 'article' | 'external_link'
        contentRevisionId: string
      }>
    }>()
    expectTypeOf<ContentCoursePublishResult>().toEqualTypeOf<{
      courseId: string
      courseVersionId: string
      status: 'published'
      itemCount: number
      items: Array<{
        itemId: string
        itemType: 'article' | 'external_link'
        contentRevisionId: string
        position: number
      }>
    }>()
    expectTypeOf<OpenCompletionRequest>().toEqualTypeOf<{ requestId: string }>()
    expectTypeOf<OpenCompletionResult>().toEqualTypeOf<
      | {
          itemId: string
          itemType: 'article'
          title: string
          articleHtml: string
          externalUrl: null
          status: 'completed'
          completedAt: string
          assurance: 'weak_server_recorded_open'
        }
      | {
          itemId: string
          itemType: 'external_link'
          title: string
          articleHtml: null
          externalUrl: string
          status: 'completed'
          completedAt: string
          assurance: 'weak_server_recorded_launch'
        }
    >()
    expectTypeOf<LearnerCourse>()
      .toEqualTypeOf<LearnerAssessmentCourse | LearnerContentCourse>()
    expectTypeOf<LearnerContentCourse>().toEqualTypeOf<{
      courseId: string
      courseVersionId: string
      title: string
      access: components['schemas']['ElearningLearnerAccess']
      assignment: components['schemas']['ElearningLearnerAssignment'] | null
      items: LearnerContentItem[]
      completed: boolean
    }>()
    expectTypeOf<LearnerContentItem>().toEqualTypeOf<
      | {
          itemId: string
          itemType: 'article' | 'external_link'
          title: string
          status: 'not_started'
          completedAt: null
        }
      | {
          itemId: string
          itemType: 'article' | 'external_link'
          title: string
          status: 'completed'
          completedAt: string
        }
    >()

    expectTypeOf<
      NonNullable<paths['/api/elearning/admin/content-revisions']['post']['requestBody']>['content']['application/json']
    >().toEqualTypeOf<ContentRevisionRequest>()
    expectTypeOf<
      NonNullable<paths['/api/elearning/admin/courses/content/publish']['post']['requestBody']>['content']['application/json']
    >().toEqualTypeOf<ContentCoursePublishRequest>()
    expectTypeOf<
      NonNullable<paths['/api/elearning/me/course-items/{itemId}/open']['post']['requestBody']>['content']['application/json']
    >().toEqualTypeOf<OpenCompletionRequest>()

    const doc = JSON.parse(readFileSync(join(here, '..', '..', 'dist', 'openapi.json'), 'utf8')) as {
      paths?: Record<string, any>
      components?: { schemas?: Record<string, JsonSchema> }
    }
    const schemas = doc.components?.schemas ?? {}
    const expectedOperations = [
      ['/api/elearning/admin/content-revisions', '201'],
      ['/api/elearning/admin/courses/content/publish', '201'],
      ['/api/elearning/me/course-items/{itemId}/open', '200'],
    ] as const
    for (const [path, success] of expectedOperations) {
      const operation = doc.paths?.[path]?.post
      expect(operation?.security).toEqual([{ bearerAuth: [] }])
      expect(operation?.description).toContain('ELEARNING_ENABLED')
      expect(operation?.description).toContain('ELEARNING_CONTENT_ENABLED')
      expect(operation?.description).toContain('server')
      expect(operation?.responses?.[success]?.content?.['application/json']?.schema?.$ref)
        .toMatch(/^#\/components\/schemas\/Elearning/)
    }

    expect(schemas.ElearningContentRevisionRequest?.oneOf).toEqual([
      { $ref: '#/components/schemas/ElearningContentArticleRevisionRequest' },
      { $ref: '#/components/schemas/ElearningContentExternalLinkRevisionRequest' },
    ])
    for (const name of [
      'ElearningContentArticleRevisionRequest',
      'ElearningContentExternalLinkRevisionRequest',
      'ElearningContentArticleRevision',
      'ElearningContentExternalLinkRevision',
      'ElearningContentCoursePublishRequest',
      'ElearningContentCoursePublishResult',
      'ElearningOpenCompletionRequest',
      'ElearningContentArticleOpenResult',
      'ElearningContentExternalLinkOpenResult',
      'ElearningLearnerAssessmentCourse',
      'ElearningLearnerContentCourse',
      'ElearningLearnerContentItemNotStarted',
      'ElearningLearnerContentItemCompleted',
    ]) expect(schemas[name]?.additionalProperties).toBe(false)

    expect(schemas.ElearningContentArticleRevisionRequest?.required).toEqual([
      'requestId', 'itemType', 'title', 'articleHtml', 'externalUrl',
    ])
    expect(schemas.ElearningContentArticleRevisionRequest?.properties?.externalUrl)
      .toMatchObject({ nullable: true, enum: [null] })
    expect(schemas.ElearningContentExternalLinkRevisionRequest?.properties?.articleHtml)
      .toMatchObject({ nullable: true, enum: [null] })
    expect(schemas.ElearningContentExternalLinkRevisionRequest?.properties?.externalUrl)
      .toMatchObject({ type: 'string', format: 'uri', pattern: '^https://' })
    expect(schemas.ElearningContentCoursePublishRequest?.properties?.items)
      .toMatchObject({ minItems: 1, maxItems: 10000 })
    expect(schemas.ElearningOpenCompletionResult?.oneOf).toEqual([
      { $ref: '#/components/schemas/ElearningContentArticleOpenResult' },
      { $ref: '#/components/schemas/ElearningContentExternalLinkOpenResult' },
    ])
    expect(schemas.ElearningLearnerCourse?.oneOf).toEqual([
      { $ref: '#/components/schemas/ElearningLearnerAssessmentCourse' },
      { $ref: '#/components/schemas/ElearningLearnerContentCourse' },
    ])
    expect(schemas.ElearningLearnerContentItem?.oneOf).toEqual([
      { $ref: '#/components/schemas/ElearningLearnerContentItemNotStarted' },
      { $ref: '#/components/schemas/ElearningLearnerContentItemCompleted' },
    ])
    expect(schemas.ElearningLearnerContentItemNotStarted?.properties?.completedAt)
      .toMatchObject({ nullable: true, enum: [null] })
    expect(schemas.ElearningLearnerContentItemCompleted?.properties?.completedAt)
      .toMatchObject({ type: 'string', format: 'date-time' })
    expect(schemas.ElearningLearnerAssessmentCourse?.properties?.items).toBeUndefined()
    expect(schemas.ElearningLearnerContentCourse?.properties?.video).toBeUndefined()
    expect(schemas.ElearningLearnerContentCourse?.properties?.exam).toBeUndefined()
  })

  it('keeps L3 assessment admin requests and responses closed', () => {
    expectTypeOf<QuestionBankCreateRequest>().toEqualTypeOf<{ title: string }>()
    expectTypeOf<QuestionBankResult>().toEqualTypeOf<{ bankId: string }>()
    expectTypeOf<QuestionBankListResult>().toEqualTypeOf<{
      items: Array<{
        bankId: string
        title: string
        questionCount: number
        createdAt: string
        updatedAt: string
      }>
      page: number
      pageSize: number
      total: number
    }>()
    expectTypeOf<QuestionBankQuestionsResult>().toEqualTypeOf<{
      bank: { bankId: string; title: string }
      items: Array<{
        questionId: string
        questionRevisionId: string
        revision: number
        questionType: components['schemas']['ElearningQuestionType']
        prompt: string
        options: components['schemas']['ElearningPublishOption'][]
        correctOptionIds: string[]
        points: number
        explanation: string | null
        createdAt: string
      }>
      page: number
      pageSize: number
      total: number
    }>()
    expectTypeOf<QuestionWriteRequest>().toEqualTypeOf<{
      question: components['schemas']['ElearningPublishQuestion']
    }>()
    expectTypeOf<QuestionRevisionResult>().toEqualTypeOf<{
      questionId: string
      questionRevisionId: string
      revision: number
    }>()
    expectTypeOf<QuestionImportResult>().toEqualTypeOf<{ importedCount: number }>()
    expectTypeOf<FixedPaperPublishRequest>().toEqualTypeOf<{
      title: string
      items: Array<{ questionRevisionId: string; points: number }>
    }>()
    expectTypeOf<FixedPaperResult>().toEqualTypeOf<{
      paperId: string
      status: 'published'
      itemCount: number
      totalPoints: number
    }>()
    expectTypeOf<PaperExamPublishRequest>().toEqualTypeOf<{
      paperId: string
      title: string
      passScore: number
      maxAttempts: number
      windowStartsAt: string | null
      windowEndsAt: string | null
      durationSeconds: number | null
      shuffleQuestions: boolean
      shuffleOptions: boolean
      disclosurePolicy:
        | 'no_review'
        | 'correctness_after_submit'
        | 'wrong_items_after_submit'
        | 'correctness_after_window'
    }>()
    expectTypeOf<PaperExamResult>().toEqualTypeOf<{
      examId: string
      paperId: string
      status: 'published'
      totalPoints: number
    }>()

    const doc = JSON.parse(readFileSync(join(here, '..', '..', 'dist', 'openapi.json'), 'utf8')) as {
      components?: { schemas?: Record<string, JsonSchema> }
    }
    expect(
      doc.components?.schemas?.ElearningFixedPaperPublishRequest
        ?.properties?.items?.maxItems,
    ).toBe(200)
  })

  it('keeps delegated administration and collaboration DTOs closed', () => {
    expectTypeOf<AdminScopeReplaceRequest>().toEqualTypeOf<{
      reason: string
      scopes: Array<{ departmentId: string; includeChildren: boolean }>
    }>()
    expectTypeOf<AdminScopeReplaceResult>().toEqualTypeOf<{
      targetUserId: string
      scopeCount: number
      duplicate: boolean
    }>()
    expectTypeOf<ObjectAclReplaceRequest>().toEqualTypeOf<{
      reason: string
      actions: Array<'assign' | 'scope' | 'track'>
    }>()
    expectTypeOf<ObjectAclReplaceResult>().toEqualTypeOf<{
      objectType: 'course' | 'training_plan'
      objectId: string
      granteeUserId: string
      actions: Array<'assign' | 'scope' | 'track'>
      duplicate: boolean
    }>()
  })

  it('does not leak answer keys, paper snapshots, or storage keys on learner DTOs', () => {
    expectTypeOf<PublicPaper>().toEqualTypeOf<{
      domain: 'elearning.exam.paper.v1'
      version: 1
      questions: PublicQuestion[]
    }>()
    expectTypeOf<PublicQuestion>().toEqualTypeOf<{
      position: number
      questionRevisionId: string
      questionType: 'single_choice' | 'multiple_choice' | 'true_false'
      prompt: string
      options: components['schemas']['ElearningPublicOption'][]
      points: number
    }>()
    expectTypeOf<ExamStart>().toEqualTypeOf<{
      attemptId: string
      attemptNo: number
      status: 'started'
      paper: PublicPaper
      answers: { [key: string]: string[] }
      deadlineAt: string | null
      duplicate: boolean
    }>()
    expectTypeOf<ExamSubmit>().toEqualTypeOf<{
      attemptId: string
      attemptNo: number
      status: 'graded'
      autoScore: number
      totalScore: number
      passed: boolean
      duplicate: boolean
    }>()
    expectTypeOf<ExamReviewQuestion>().toEqualTypeOf<{
      position: number
      questionRevisionId: string
      questionType: 'single_choice' | 'multiple_choice' | 'true_false'
      prompt: string
      options: components['schemas']['ElearningPublicOption'][]
      points: number
      selected: string[]
      correct: boolean
      awarded: number
    }>()
    expectTypeOf<ExamReview>().toEqualTypeOf<{
      attemptId: string
      attemptNo: number
      status: 'graded'
      disclosurePolicy: 'correctness_after_submit' | 'wrong_items_after_submit' | 'correctness_after_window'
      autoScore: number
      totalScore: number
      passed: boolean
      questions: ExamReviewQuestion[]
    }>()
    expectTypeOf<Ticket>().toEqualTypeOf<{
      token: string
      expiresAt: string
      ttlSeconds: number
      itemId: string
      mediaId: string
    }>()
    expectTypeOf<MediaUpload>().toEqualTypeOf<{
      id: string
      status: 'ready' | 'rejected'
      durationMs: number | null
      sizeBytes: number
      sha256: string
    }>()
    expectTypeOf<LearnerList>().toEqualTypeOf<{
      courses: components['schemas']['ElearningLearnerCourse'][]
    }>()
    expectTypeOf<AssignmentMember>().toEqualTypeOf<{
      memberId: string
      userId: string
      source: 'manual' | 'rule' | 'import'
      assignedAt: string
      revokedAt: string | null
      overdue: boolean
      videoStatus: 'not_started' | 'in_progress' | 'completed'
      examStatus: 'not_started' | 'started' | 'submitted' | 'graded' | 'expired'
      passed: boolean
      courseStatus: 'not_started' | 'in_progress' | 'completed'
    }>()
    expectTypeOf<AssignmentProgress>().toEqualTypeOf<{
      assignmentId: string
      courseVersionId: string
      deadline: string | null
      members: AssignmentMember[]
      nextCursor: string | null
    }>()
    expectTypeOf<AssignmentRevokeRequest>().toEqualTypeOf<{
      reason: string
    }>()
    expectTypeOf<AssignmentRevokeResult>().toEqualTypeOf<{
      assignmentId: string
      memberId: string
      revoked: true
      duplicate: boolean
    }>()
    expectTypeOf<TrainingPlanPublishResult>().toEqualTypeOf<{
      planId: string
      planVersionId: string
      status: 'published'
      itemCount: number
      duplicate: boolean
    }>()
    expectTypeOf<TrainingPlanAssignmentResult>().toEqualTypeOf<{
      planAssignmentId: string
      planVersionId: string
      assignmentCount: number
      memberCount: number
      duplicate: boolean
    }>()
    expectTypeOf<TrainingPlanRevocationResult>().toEqualTypeOf<{
      planAssignmentId: string
      revoked: true
      revokedMemberCount: number
      duplicate: boolean
    }>()
    expectTypeOf<TrainingPlan>().toEqualTypeOf<{
      planId: string
      title: string
      status: 'active' | 'archived'
      activeVersion: {
        planVersionId: string
        version: number
        status: 'published'
        items: Array<{
          courseVersionId: string
          position: number
          required: boolean
        }>
      }
    }>()

    const doc = JSON.parse(readFileSync(join(here, '..', '..', 'dist', 'openapi.json'), 'utf8')) as {
      paths?: Record<string, any>
      components?: { schemas?: Record<string, JsonSchema> }
    }
    const schemas = doc.components?.schemas ?? {}
    const leaks = [
      ...LEARNER_OUTPUT_ROOTS.map((name) => ({ name, keys: collectForbiddenKeys(schemas, schemas[name]) })),
      {
        name: 'POST /api/elearning/exams/items/{itemId}/start 200',
        keys: collectForbiddenKeys(schemas, jsonSchemaAt(doc, '/api/elearning/exams/items/{itemId}/start', 'post', '200')),
      },
      {
        name: 'POST /api/elearning/assessment/question-banks/{bankId}/questions 201',
        keys: collectForbiddenKeys(
          schemas,
          jsonSchemaAt(
            doc,
            '/api/elearning/assessment/question-banks/{bankId}/questions',
            'post',
            '201',
          ),
        ),
      },
      {
        name: 'POST /api/elearning/assessment/questions/{questionId}/revisions 201',
        keys: collectForbiddenKeys(
          schemas,
          jsonSchemaAt(
            doc,
            '/api/elearning/assessment/questions/{questionId}/revisions',
            'post',
            '201',
          ),
        ),
      },
      {
        name: 'POST /api/elearning/assessment/question-banks/{bankId}/import 201',
        keys: collectForbiddenKeys(
          schemas,
          jsonSchemaAt(
            doc,
            '/api/elearning/assessment/question-banks/{bankId}/import',
            'post',
            '201',
          ),
        ),
      },
      {
        name: 'POST /api/elearning/assessment/papers 201',
        keys: collectForbiddenKeys(
          schemas,
          jsonSchemaAt(doc, '/api/elearning/assessment/papers', 'post', '201'),
        ),
      },
      {
        name: 'POST /api/elearning/assessment/exams 201',
        keys: collectForbiddenKeys(
          schemas,
          jsonSchemaAt(doc, '/api/elearning/assessment/exams', 'post', '201'),
        ),
      },
      {
        name: 'PUT /api/elearning/exams/attempts/{attemptId}/answers 200',
        keys: collectForbiddenKeys(schemas, jsonSchemaAt(doc, '/api/elearning/exams/attempts/{attemptId}/answers', 'put', '200')),
      },
      {
        name: 'POST /api/elearning/exams/attempts/{attemptId}/submit 200',
        keys: collectForbiddenKeys(schemas, jsonSchemaAt(doc, '/api/elearning/exams/attempts/{attemptId}/submit', 'post', '200')),
      },
      {
        name: 'GET /api/elearning/exams/attempts/{attemptId}/review 200',
        keys: collectForbiddenKeys(
          schemas,
          jsonSchemaAt(doc, '/api/elearning/exams/attempts/{attemptId}/review', 'get', '200'),
          new Set<string>(),
          new Set(['correct']),
        ),
      },
      {
        name: 'POST /api/elearning/watch/items/{itemId}/playback-ticket 200',
        keys: collectForbiddenKeys(schemas, jsonSchemaAt(doc, '/api/elearning/watch/items/{itemId}/playback-ticket', 'post', '200')),
      },
      {
        name: 'POST /api/elearning/media 201',
        keys: collectForbiddenKeys(schemas, jsonSchemaAt(doc, '/api/elearning/media', 'post', '201')),
      },
      {
        name: 'GET /api/elearning/me/courses 200',
        keys: collectForbiddenKeys(schemas, jsonSchemaAt(doc, '/api/elearning/me/courses', 'get', '200')),
      },
      {
        name: 'GET /api/elearning/assignments/{assignmentId} 200',
        keys: collectForbiddenKeys(schemas, jsonSchemaAt(doc, '/api/elearning/assignments/{assignmentId}', 'get', '200')),
      },
      {
        name: 'PUT /api/elearning/assignments/{assignmentId}/members/{memberId}/revocation 200',
        keys: collectForbiddenKeys(
          schemas,
          jsonSchemaAt(doc, '/api/elearning/assignments/{assignmentId}/members/{memberId}/revocation', 'put', '200'),
        ),
      },
    ].filter((row) => row.keys.length > 0)
    expect(leaks).toEqual([])

    // Admin publish request may contain correctOptionIds; it is not a learner-output deny root.
    expectTypeOf<PublishRequest['questions'][number]>().toMatchTypeOf<{
      correctOptionIds: string[]
    }>()
    expect(collectForbiddenKeys(schemas, schemas.ElearningCoursePublishRequest)).toEqual(
      expect.arrayContaining(['correctOptionIds', 'explanation']),
    )
    expect(LEARNER_OUTPUT_ROOTS).not.toContain('ElearningCoursePublishRequest')
  })

  it('keeps objective practice paths, DTOs, and learner outputs closed', () => {
    expectTypeOf<PracticeMode>().toEqualTypeOf<'sequential' | 'random' | 'wrong_book'>()
    expectTypeOf<PracticeSetCreateRequest>().toEqualTypeOf<{
      paperId: string
      requestId: string
      title: string
    }>()
    expectTypeOf<PracticeSetCreateResult>().toEqualTypeOf<{
      practiceSetId: string
      paperId: string
      title: string
      status: 'active'
      createdAt: string
      duplicate: boolean
    }>()
    expectTypeOf<PracticeQuestion>().toEqualTypeOf<{
      questionId: string
      questionRevisionId: string
      questionType: 'single_choice' | 'multiple_choice' | 'true_false'
      prompt: string
      options: Array<{ id: string; text: string }>
      points: number
      position: number
    }>()
    expectTypeOf<PracticeSessionStartRequest>().toEqualTypeOf<{
      mode: PracticeMode
      practiceSetId: string
      requestId: string
    }>()
    expectTypeOf<PracticeSessionStartResult>().toEqualTypeOf<{
      sessionId: string
      practiceSetId: string
      mode: PracticeMode
      questions: PracticeQuestion[]
      createdAt: string
      duplicate: boolean
    }>()
    expectTypeOf<PracticeAnswerRequest>().toEqualTypeOf<{
      questionRevisionId: string
      requestId: string
      selectedOptionIds: string[]
    }>()
    expectTypeOf<PracticeAnswerResult>().toEqualTypeOf<{
      answerId: string
      sessionId: string
      questionRevisionId: string
      correct: boolean
      wrongState: 'wrong' | 'resolved' | 'unchanged'
      createdAt: string
      duplicate: boolean
    }>()
    expectTypeOf<PracticeWrongQuestionList>().toEqualTypeOf<{
      practiceSetId: string
      questions: PracticeQuestion[]
    }>()
    expectTypeOf<
      NonNullable<paths['/api/elearning/admin/practice-sets']['post']['requestBody']>['content']['application/json']
    >().toEqualTypeOf<PracticeSetCreateRequest>()
    expectTypeOf<
      NonNullable<paths['/api/elearning/me/practice-sessions']['post']['requestBody']>['content']['application/json']
    >().toEqualTypeOf<PracticeSessionStartRequest>()
    expectTypeOf<
      NonNullable<paths['/api/elearning/me/practice-sessions/{sessionId}/answers']['post']['requestBody']>['content']['application/json']
    >().toEqualTypeOf<PracticeAnswerRequest>()

    const doc = JSON.parse(readFileSync(join(here, '..', '..', 'dist', 'openapi.json'), 'utf8')) as {
      paths?: Record<string, any>
      components?: { schemas?: Record<string, JsonSchema> }
    }
    const schemas = doc.components?.schemas ?? {}
    const operations = [
      ['/api/elearning/admin/practice-sets', 'post', '201'],
      ['/api/elearning/me/practice-sets', 'get', '200'],
      ['/api/elearning/me/practice-sessions', 'post', '201'],
      ['/api/elearning/me/practice-sessions/{sessionId}/answers', 'post', '200'],
      ['/api/elearning/me/practice-sets/{practiceSetId}/wrong-questions', 'get', '200'],
    ] as const
    for (const [path, method, success] of operations) {
      const operation = doc.paths?.[path]?.[method]
      expect(operation?.security).toEqual([{ bearerAuth: [] }])
      expect(operation?.description).toMatch(/ASSESSMENT/)
      expect(operation?.responses?.[success]?.content?.['application/json']?.schema?.$ref)
        .toMatch(/^#\/components\/schemas\/ElearningPractice/)
    }
    for (const name of [
      'ElearningPracticeSetCreateRequest',
      'ElearningPracticeSet',
      'ElearningPracticeSetCreateResult',
      'ElearningPracticeSetList',
      'ElearningPracticeQuestion',
      'ElearningPracticeSessionStartRequest',
      'ElearningPracticeSessionStartResult',
      'ElearningPracticeAnswerRequest',
      'ElearningPracticeAnswerResult',
      'ElearningPracticeWrongQuestionList',
    ]) expect(schemas[name]?.additionalProperties).toBe(false)
    expect(schemas.ElearningPracticeMode?.enum).toEqual(['sequential', 'random', 'wrong_book'])
    expect(schemas.ElearningPracticeAnswerResult?.properties?.wrongState?.enum)
      .toEqual(['wrong', 'resolved', 'unchanged'])
    expect(schemas.ElearningPracticeQuestion?.properties?.questionType?.$ref)
      .toBe('#/components/schemas/ElearningObjectiveQuestionType')
    expect(schemas.ElearningPracticeQuestion?.properties?.answerKey).toBeUndefined()
    expect(schemas.ElearningPracticeQuestion?.properties?.correctOptionIds).toBeUndefined()
    expect(schemas.ElearningPracticeQuestion?.properties?.explanation).toBeUndefined()
    expect(collectForbiddenKeys(
      schemas,
      jsonSchemaAt(doc, '/api/elearning/me/practice-sessions', 'post', '201'),
    )).toEqual([])
    expect(collectForbiddenKeys(
      schemas,
      jsonSchemaAt(
        doc,
        '/api/elearning/me/practice-sets/{practiceSetId}/wrong-questions',
        'get',
        '200',
      ),
    )).toEqual([])
    expect(collectForbiddenKeys(
      schemas,
      jsonSchemaAt(doc, '/api/elearning/me/practice-sessions/{sessionId}/answers', 'post', '200'),
      new Set<string>(),
      new Set(['correct']),
    )).toEqual([])
  })

  it('documents closed L6 offline-training publish, QR, attendance, and learner-list contracts', () => {
    expectTypeOf<paths['/api/elearning/admin/offline-trainings']['post']>().not.toBeNever()
    expectTypeOf<
      paths['/api/elearning/admin/offline-trainings/{trainingId}/targets/{targetId}/qr']['post']
    >().not.toBeNever()
    expectTypeOf<paths['/api/elearning/me/offline-attendance']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/me/offline-trainings']['get']>().not.toBeNever()
    expectTypeOf<OfflineTrainingPublishRequest>().toEqualTypeOf<{
      requestId: string
      title: string
      location: string
      attendanceMode: 'training' | 'session'
      targets: Array<{
        title: string
        startsAt: string
        endsAt: string
        checkInOpensAt: string
        checkInClosesAt: string
        checkOutOpensAt: string
        checkOutClosesAt: string
      }>
      memberUserIds: string[]
    }>()
    expectTypeOf<OfflineTrainingPublishResult>().toEqualTypeOf<{
      trainingId: string
      revisionId: string
      title: string
      location: string
      attendanceMode: 'training' | 'session'
      targets: Array<{
        targetId: string
        position: number
        title: string
        startsAt: string
        endsAt: string
        checkInOpensAt: string
        checkInClosesAt: string
        checkOutOpensAt: string
        checkOutClosesAt: string
      }>
      memberCount: number
      createdAt: string
      duplicate: boolean
    }>()
    expectTypeOf<OfflineQrIssueRequest>().toEqualTypeOf<{
      requestId: string
      action: 'check_in' | 'check_out'
    }>()
    expectTypeOf<OfflineQrResult>().toEqualTypeOf<{
      trainingId: string
      revisionId: string
      targetId: string
      action: 'check_in' | 'check_out'
      token: string
      issuedAt: string
      expiresAt: string
      duplicate: boolean
    }>()
    expectTypeOf<OfflineAttendanceRequest>().toEqualTypeOf<{
      requestId: string
      token: string
    }>()
    expectTypeOf<OfflineAttendanceResult>().toEqualTypeOf<{
      eventId: string
      trainingId: string
      revisionId: string
      targetId: string
      action: 'check_in' | 'check_out'
      occurredAt: string
      targetStatus: 'checked_in' | 'checked_out'
      completionStatus: 'completed' | 'in_progress'
      completedTargetCount: number
      totalTargetCount: number
      duplicate: boolean
    }>()
    expectTypeOf<OfflineLearnerTrainingList>().toEqualTypeOf<{
      trainings: Array<{
        trainingId: string
        revisionId: string
        title: string
        location: string
        attendanceMode: 'training' | 'session'
        status: 'active' | 'archived'
        targets: Array<{
          targetId: string
          position: number
          title: string
          startsAt: string
          endsAt: string
          checkInOpensAt: string
          checkInClosesAt: string
          checkOutOpensAt: string
          checkOutClosesAt: string
          attendanceStatus: 'not_checked_in' | 'checked_in' | 'checked_out'
          checkedInAt: string | null
          checkedOutAt: string | null
        }>
        completionStatus: 'completed' | 'in_progress'
      }>
    }>()

    const doc = JSON.parse(readFileSync(join(here, '..', '..', 'dist', 'openapi.json'), 'utf8')) as {
      paths?: Record<string, any>
      components?: { schemas?: Record<string, JsonSchema> }
    }
    const schemas = doc.components?.schemas ?? {}
    const operations = [
      ['/api/elearning/admin/offline-trainings', 'post'],
      ['/api/elearning/admin/offline-trainings/{trainingId}/targets/{targetId}/qr', 'post'],
      ['/api/elearning/me/offline-attendance', 'post'],
      ['/api/elearning/me/offline-trainings', 'get'],
    ] as const
    for (const [path, method] of operations) {
      const operation = doc.paths?.[path]?.[method]
      expect(operation?.security).toEqual([{ bearerAuth: [] }])
      expect(operation?.description).toMatch(/server-derived|server verifies|assigned training/)
      expect(JSON.stringify(operation?.responses ?? {})).not.toContain('detail')
    }
    expect(doc.paths?.['/api/elearning/admin/offline-trainings']?.post?.description)
      .toContain('ELEARNING_OFFLINE_TRAINING_ENABLED=true')
    expect(doc.paths?.['/api/elearning/admin/offline-trainings']?.post?.description)
      .toContain('elearning:admin')
    expect(doc.paths?.['/api/elearning/admin/offline-trainings']?.post?.requestBody?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/ElearningOfflineTrainingPublishRequest' })
    expect(doc.paths?.['/api/elearning/me/offline-attendance']?.post?.responses?.['200']?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/ElearningOfflineAttendanceResult' })
    expect(doc.paths?.['/api/elearning/me/offline-trainings']?.get?.responses?.['200']?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/ElearningOfflineLearnerTrainingList' })

    for (const name of [
      'ElearningOfflineTargetCommand',
      'ElearningOfflineTrainingPublishRequest',
      'ElearningOfflineTarget',
      'ElearningOfflineTrainingPublishResult',
      'ElearningOfflineQrIssueRequest',
      'ElearningOfflineQrResult',
      'ElearningOfflineAttendanceRequest',
      'ElearningOfflineAttendanceResult',
      'ElearningOfflineLearnerTarget',
      'ElearningOfflineLearnerTraining',
      'ElearningOfflineLearnerTrainingList',
    ]) expect(schemas[name]?.additionalProperties).toBe(false)
    expect(Object.keys(schemas.ElearningOfflineTrainingPublishRequest?.properties ?? {}).sort())
      .toEqual(['attendanceMode', 'location', 'memberUserIds', 'requestId', 'targets', 'title'])
    expect(Object.keys(schemas.ElearningOfflineQrIssueRequest?.properties ?? {}).sort())
      .toEqual(['action', 'requestId'])
    expect(Object.keys(schemas.ElearningOfflineAttendanceRequest?.properties ?? {}).sort())
      .toEqual(['requestId', 'token'])
    expect(schemas.ElearningOfflineTrainingPublishRequest?.properties?.memberUserIds)
      .toMatchObject({ minItems: 1, maxItems: 10000, uniqueItems: true })
    expect(schemas.ElearningOfflineTrainingPublishRequest?.oneOf).toHaveLength(2)
    expect(schemas.ElearningOfflineTrainingPublishRequest?.oneOf?.map((variant) => ({
      mode: variant.properties?.attendanceMode?.enum,
      minItems: variant.properties?.targets?.minItems,
      maxItems: variant.properties?.targets?.maxItems,
    }))).toEqual([
      { mode: ['training'], minItems: 1, maxItems: 1 },
      { mode: ['session'], minItems: 1, maxItems: 100 },
    ])
    expect(schemas.ElearningOfflineAttendanceMode?.enum).toEqual(['training', 'session'])
    expect(schemas.ElearningOfflineAttendanceAction?.enum).toEqual(['check_in', 'check_out'])
    expect(collectForbiddenKeys(
      schemas,
      jsonSchemaAt(doc, '/api/elearning/me/offline-trainings', 'get', '200'),
    )).toEqual([])
    expect(JSON.stringify(schemas.ElearningOfflineLearnerTrainingList)).not.toMatch(
      /orgId|actorId|challengeId|decisionHash|requestHash|signingSecret|signingKey/,
    )
  })

  it('keeps write and heartbeat request objects closed', () => {
    expectTypeOf<AssignRequest>().toMatchTypeOf<{
      targetUserId: string
      courseVersionId: string
      sourceKey: string
      deadline?: string | null
    }>()
    expectTypeOf<Heartbeat>().toEqualTypeOf<{
      sequence: number
      positionMs: number
      playing: boolean
    }>()
    expectTypeOf<ExamAnswers>().toEqualTypeOf<{
      answers: {
        [key: string]: string[]
      }
    }>()
    expectTypeOf<
      NonNullable<paths['/api/elearning/exams/attempts/{attemptId}/answers']['put']['requestBody']>['content']['application/json']
    >().toEqualTypeOf<ExamAnswers>()
    expectTypeOf<LearnerList>().toEqualTypeOf<{
      courses: components['schemas']['ElearningLearnerCourse'][]
    }>()
    expectTypeOf<PublishResult['status']>().toEqualTypeOf<'published'>()
    expectTypeOf<TrainingPlanPublishRequest>().toEqualTypeOf<{
      requestId: string
      title: string
      items: Array<{ courseVersionId: string; required: boolean }>
    }>()
    expectTypeOf<TrainingPlanAssignmentRequest>().toEqualTypeOf<{
      sourceKey: string
      deadline?: string | null
      rules: components['schemas']['ElearningScopeRule'][]
    }>()
  })
})
