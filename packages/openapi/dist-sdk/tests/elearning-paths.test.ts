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
type ExamAnswers = components['schemas']['ElearningExamSubmitRequest']
type ElearningError = components['schemas']['ElearningError']

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
] as const

const here = dirname(fileURLToPath(import.meta.url))

type JsonSchema = {
  $ref?: string
  properties?: Record<string, JsonSchema>
  items?: JsonSchema | JsonSchema[]
  additionalProperties?: JsonSchema | boolean
  allOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  anyOf?: JsonSchema[]
}

function isForbiddenLearnerKey(key: string): boolean {
  return FORBIDDEN_LEARNER_KEYS.has(key)
    || (/signing/i.test(key) && /(secret|key|material)/i.test(key))
}

function collectForbiddenKeys(
  schemas: Record<string, JsonSchema>,
  schema: JsonSchema | undefined,
  seen = new Set<string>(),
): string[] {
  if (!schema) return []
  if (schema.$ref) {
    const name = schema.$ref.replace('#/components/schemas/', '')
    if (seen.has(name)) return []
    seen.add(name)
    return collectForbiddenKeys(schemas, schemas[name], seen)
  }
  const hits: string[] = []
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    if (isForbiddenLearnerKey(key)) hits.push(key)
    hits.push(...collectForbiddenKeys(schemas, child, seen))
  }
  const items = schema.items
  for (const item of items ? (Array.isArray(items) ? items : [items]) : []) {
    hits.push(...collectForbiddenKeys(schemas, item, seen))
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    hits.push(...collectForbiddenKeys(schemas, schema.additionalProperties, seen))
  }
  for (const part of [...(schema.allOf ?? []), ...(schema.oneOf ?? []), ...(schema.anyOf ?? [])]) {
    hits.push(...collectForbiddenKeys(schemas, part, seen))
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
    expectTypeOf<paths['/api/elearning/media']['post']>().not.toBeNever()
    expectTypeOf<paths['/api/elearning/courses/publish']['post']>().not.toBeNever()
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
  })

  it('binds success bodies to the live DTOs', () => {
    expectTypeOf<
      paths['/api/elearning/capabilities']['get']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<Capabilities>()
    expectTypeOf<
      paths['/api/elearning/media']['post']['responses']['201']['content']['application/json']
    >().toEqualTypeOf<MediaUpload>()
    expectTypeOf<
      paths['/api/elearning/courses/publish']['post']['responses']['201']['content']['application/json']
    >().toEqualTypeOf<PublishResult>()
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
        name: 'PUT /api/elearning/exams/attempts/{attemptId}/answers 200',
        keys: collectForbiddenKeys(schemas, jsonSchemaAt(doc, '/api/elearning/exams/attempts/{attemptId}/answers', 'put', '200')),
      },
      {
        name: 'POST /api/elearning/exams/attempts/{attemptId}/submit 200',
        keys: collectForbiddenKeys(schemas, jsonSchemaAt(doc, '/api/elearning/exams/attempts/{attemptId}/submit', 'post', '200')),
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
