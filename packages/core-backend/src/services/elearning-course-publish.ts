/**
 * Transactional V0.1 composite course publish (one video + one exam).
 * Uses existing tables and trigger-required draft→publish ordering.
 * Public results and errors are values-free.
 */
import { createHash, randomUUID } from 'node:crypto'
import { ELEARNING_MEDIA_MIME } from './elearning-media-validation'
import {
  ELEARNING_WATCH_POLICY_VERSION,
  ELEARNING_WATCH_THRESHOLD_BPS,
} from './elearning-watch-progress'

export const ELEARNING_COURSE_PUBLISH_ACTOR_MAX = 256
export const ELEARNING_COURSE_PUBLISH_REQUEST_DOMAIN = 'elearning.course.publish.request.v1' as const
export const ELEARNING_COURSE_PUBLISH_REQUEST_HASH_VERSION = 1 as const
export const ELEARNING_COURSE_PUBLISH_TITLE_MAX = 200
export const ELEARNING_COURSE_PUBLISH_PROMPT_MAX = 2000
export const ELEARNING_COURSE_PUBLISH_OPTION_ID_MAX = 64
export const ELEARNING_COURSE_PUBLISH_OPTION_TEXT_MAX = 500
export const ELEARNING_COURSE_PUBLISH_EXPLANATION_MAX = 2000
export const ELEARNING_COURSE_PUBLISH_QUESTION_MAX = 50
export const ELEARNING_COURSE_PUBLISH_OPTION_MAX = 20
const PG_INT32_MAX = 2147483647

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const QUESTION_TYPES = ['single_choice', 'multiple_choice', 'true_false'] as const
const INPUT_KEYS = [
  'orgId',
  'actorId',
  'requestId',
  'title',
  'mediaId',
  'passScore',
  'maxAttempts',
  'questions',
] as const
const QUESTION_KEYS = ['questionType', 'prompt', 'options', 'correctOptionIds', 'points'] as const
const QUESTION_OPTIONAL_KEYS = ['explanation'] as const
const OPTION_KEYS = ['id', 'text'] as const

export type ElearningCoursePublishErrorCode =
  | 'invalid_input'
  | 'media_unavailable'
  | 'conflict'
  | 'unavailable'

export type ElearningCoursePublishQuestionType = (typeof QUESTION_TYPES)[number]

export class ElearningCoursePublishError extends Error {
  constructor(readonly code: ElearningCoursePublishErrorCode) {
    super(code)
    this.name = 'ElearningCoursePublishError'
  }
}

export interface ElearningCoursePublishQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningCoursePublishDb {
  transaction<T>(handler: (tx: ElearningCoursePublishQueryable) => Promise<T>): Promise<T>
}

export interface PublishElearningCourseOption {
  id: string
  text: string
}

export interface PublishElearningCourseQuestion {
  questionType: ElearningCoursePublishQuestionType
  prompt: string
  options: PublishElearningCourseOption[]
  correctOptionIds: string[]
  points: number
  explanation?: string | null
}

export interface PublishElearningCourseInput {
  orgId: string
  actorId: string
  requestId: string
  title: string
  mediaId: string
  passScore: number
  maxAttempts: number
  questions: PublishElearningCourseQuestion[]
}

export interface ElearningCoursePublishResult {
  courseId: string
  courseVersionId: string
  videoItemId: string
  examItemId: string
  examId: string
  status: 'published'
  questionCount: number
  totalScore: number
}

interface CanonicalOption {
  id: string
  text: string
}

interface CanonicalQuestion {
  questionType: ElearningCoursePublishQuestionType
  prompt: string
  options: CanonicalOption[]
  correctOptionIds: string[]
  points: number
  explanation: string | null
}

interface CanonicalInput {
  orgId: string
  actorId: string
  requestId: string
  title: string
  mediaId: string
  passScore: number
  maxAttempts: number
  questions: CanonicalQuestion[]
  totalScore: number
}

export function elearningCoursePublishLockKey(orgId: string, requestId: string): string {
  return `elearning-publish:${orgId}:${requestId}`
}

function fail(code: ElearningCoursePublishErrorCode): never {
  throw new ElearningCoursePublishError(code)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireExactKeys(
  row: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(row)) {
    if (!allowed.has(key)) fail('invalid_input')
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) fail('invalid_input')
  }
}

function requireBoundedText(value: unknown, max: number): string {
  if (typeof value !== 'string') fail('invalid_input')
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > max) fail('invalid_input')
  return trimmed
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

function asSafeInt(value: unknown): number | null {
  if (typeof value === 'bigint') {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) return null
    return Number(value)
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return null
    return value
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (!/^-?\d+$/.test(text)) return null
    const parsed = Number(text)
    if (!Number.isSafeInteger(parsed)) return null
    return parsed
  }
  return null
}

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value
}

function deepSortedJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, walk((v as Record<string, unknown>)[k])]),
      )
    }
    return v
  }
  return JSON.stringify(walk(value))
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return value
  }
  return null
}

const COURSE_PUBLISH_REQUEST_SOURCE_KEY_UNIQ =
  'elearning_course_publish_requests_org_source_key_uniq'

function isSourceKeyUniqueViolation(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === '23505'
    && (error as { constraint?: unknown }).constraint === COURSE_PUBLISH_REQUEST_SOURCE_KEY_UNIQ,
  )
}

function isQuestionType(value: unknown): value is ElearningCoursePublishQuestionType {
  return value === 'single_choice' || value === 'multiple_choice' || value === 'true_false'
}

function uniqueIds(ids: string[]): string[] | null {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) return null
    seen.add(id)
  }
  return ids
}

function canonicalizeQuestion(input: unknown): CanonicalQuestion {
  if (!isPlainObject(input)) fail('invalid_input')
  requireExactKeys(input, QUESTION_KEYS, QUESTION_OPTIONAL_KEYS)
  if (!isQuestionType(input.questionType)) fail('invalid_input')
  const prompt = requireBoundedText(input.prompt, ELEARNING_COURSE_PUBLISH_PROMPT_MAX)
  const points = asSafeInt(input.points)
  if (points === null || points < 1 || points > PG_INT32_MAX) fail('invalid_input')
  if (!Array.isArray(input.options) || input.options.length > ELEARNING_COURSE_PUBLISH_OPTION_MAX) {
    fail('invalid_input')
  }
  if (input.questionType === 'true_false') {
    if (input.options.length !== 2) fail('invalid_input')
  } else if (input.options.length < 2) {
    fail('invalid_input')
  }
  const options: CanonicalOption[] = []
  const optionIds = new Set<string>()
  for (const raw of input.options) {
    if (!isPlainObject(raw)) fail('invalid_input')
    requireExactKeys(raw, OPTION_KEYS)
    const id = requireBoundedText(raw.id, ELEARNING_COURSE_PUBLISH_OPTION_ID_MAX)
    const text = requireBoundedText(raw.text, ELEARNING_COURSE_PUBLISH_OPTION_TEXT_MAX)
    if (optionIds.has(id)) fail('invalid_input')
    optionIds.add(id)
    options.push({ id, text })
  }
  if (!Array.isArray(input.correctOptionIds) || input.correctOptionIds.length < 1) fail('invalid_input')
  const correctRaw: string[] = []
  for (const entry of input.correctOptionIds) {
    if (typeof entry !== 'string') fail('invalid_input')
    const id = entry.trim()
    if (id === '' || !optionIds.has(id)) fail('invalid_input')
    correctRaw.push(id)
  }
  const correct = uniqueIds(correctRaw)
  if (!correct) fail('invalid_input')
  if (input.questionType === 'multiple_choice') {
    if (correct.length < 1) fail('invalid_input')
  } else if (correct.length !== 1) {
    fail('invalid_input')
  }
  let explanation: string | null = null
  if (input.explanation != null) {
    explanation = requireBoundedText(input.explanation, ELEARNING_COURSE_PUBLISH_EXPLANATION_MAX)
  }
  return {
    questionType: input.questionType,
    prompt,
    options,
    correctOptionIds: [...correct].sort(),
    points,
    explanation,
  }
}

export function canonicalizeElearningCoursePublishInput(input: unknown): CanonicalInput {
  if (!isPlainObject(input)) fail('invalid_input')
  requireExactKeys(input, INPUT_KEYS)
  const orgId = requireBoundedText(input.orgId, ELEARNING_COURSE_PUBLISH_ACTOR_MAX)
  const actorId = requireBoundedText(input.actorId, ELEARNING_COURSE_PUBLISH_ACTOR_MAX)
  const requestId = requireUuid(input.requestId)
  const title = requireBoundedText(input.title, ELEARNING_COURSE_PUBLISH_TITLE_MAX)
  const mediaId = requireUuid(input.mediaId)
  const passScore = asFiniteNumber(input.passScore)
  if (passScore === null || passScore < 0) fail('invalid_input')
  const maxAttempts = asSafeInt(input.maxAttempts)
  if (maxAttempts === null || maxAttempts < 1 || maxAttempts > PG_INT32_MAX) fail('invalid_input')
  if (!Array.isArray(input.questions)
    || input.questions.length < 1
    || input.questions.length > ELEARNING_COURSE_PUBLISH_QUESTION_MAX) {
    fail('invalid_input')
  }
  const questions = input.questions.map(canonicalizeQuestion)
  const totalScore = questions.reduce((sum, question) => sum + question.points, 0)
  if (!Number.isSafeInteger(totalScore) || totalScore < 1) fail('invalid_input')
  if (!(passScore <= totalScore)) fail('invalid_input')
  return {
    orgId,
    actorId,
    requestId,
    title,
    mediaId,
    passScore,
    maxAttempts,
    questions,
    totalScore,
  }
}

function canonicalizeElearningCoursePublishRequestV1(input: CanonicalInput): string {
  return deepSortedJson({
    domain: 'elearning.course.publish.request.v1',
    maxAttempts: input.maxAttempts,
    mediaId: input.mediaId,
    passScore: input.passScore,
    questions: input.questions,
    title: input.title,
    version: 1,
  })
}

export function canonicalizeElearningCoursePublishRequest(input: CanonicalInput): string {
  return canonicalizeElearningCoursePublishRequestV1(input)
}

export function hashElearningCoursePublishRequestAtVersion(
  input: CanonicalInput,
  version: number,
): string {
  if (version === 1) {
    return createHash('sha256')
      .update(canonicalizeElearningCoursePublishRequestV1(input), 'utf8')
      .digest('hex')
  }
  fail('unavailable')
}

export function hashElearningCoursePublishRequest(input: CanonicalInput): string {
  return hashElearningCoursePublishRequestAtVersion(
    input,
    ELEARNING_COURSE_PUBLISH_REQUEST_HASH_VERSION,
  )
}

function publicResult(row: Omit<ElearningCoursePublishResult, 'status'>): ElearningCoursePublishResult {
  return {
    courseId: row.courseId,
    courseVersionId: row.courseVersionId,
    videoItemId: row.videoItemId,
    examItemId: row.examItemId,
    examId: row.examId,
    status: 'published',
    questionCount: row.questionCount,
    totalScore: row.totalScore,
  }
}

function publicResultFromRequest(row: Record<string, unknown>): ElearningCoursePublishResult {
  const courseId = asText(row.course_id)
  const courseVersionId = asText(row.course_version_id)
  const videoItemId = asText(row.video_item_id)
  const examItemId = asText(row.exam_item_id)
  const examId = asText(row.exam_id)
  const questionCount = asSafeInt(row.question_count)
  const totalScore = asSafeInt(row.total_score)
  if (
    !courseId
    || !courseVersionId
    || !videoItemId
    || !examItemId
    || !examId
    || questionCount === null
    || totalScore === null
  ) {
    fail('unavailable')
  }
  return publicResult({
    courseId,
    courseVersionId,
    videoItemId,
    examItemId,
    examId,
    questionCount,
    totalScore,
  })
}

export async function publishElearningCourse(
  db: ElearningCoursePublishDb,
  input: PublishElearningCourseInput,
): Promise<ElearningCoursePublishResult> {
  const canonical = canonicalizeElearningCoursePublishInput(input)
  const requestHash = hashElearningCoursePublishRequest(canonical)
  const courseId = randomUUID()
  const courseVersionId = randomUUID()
  const examId = randomUUID()
  const videoItemId = randomUUID()
  const examItemId = randomUUID()
  const requestRowId = randomUUID()
  const questionRows = canonical.questions.map((question, index) => ({
    question,
    position: index + 1,
    questionId: randomUUID(),
    revisionId: randomUUID(),
  }))

  return db.transaction(async (tx) => {
    try {
      await tx.query(
        `/* elearning-publish:lock */
         SELECT pg_advisory_xact_lock(hashtext($1))`,
        [elearningCoursePublishLockKey(canonical.orgId, canonical.requestId)],
      )

      const existing = await tx.query(
        `/* elearning-publish:load-request */
         SELECT course_id, course_version_id, video_item_id, exam_item_id, exam_id,
                question_count, total_score, request_hash, request_hash_version
           FROM elearning_course_publish_requests
          WHERE org_id = $1 AND source_key = $2
          FOR UPDATE`,
        [canonical.orgId, canonical.requestId],
      )
      const existingRow = existing.rows[0]
      if (existingRow) {
        const existingHash = asText(existingRow.request_hash)
        const storedVersion = asSafeInt(existingRow.request_hash_version)
        if (!existingHash || storedVersion === null) fail('unavailable')
        if (hashElearningCoursePublishRequestAtVersion(canonical, storedVersion) !== existingHash) {
          fail('conflict')
        }
        return publicResultFromRequest(existingRow)
      }

      const media = await tx.query(
        `/* elearning-publish:load-media */
         SELECT id
           FROM elearning_media
          WHERE org_id = $1
            AND id = $2
            AND status = 'ready'
            AND mime_type = $3
            AND magic_mime_type = $3
            AND duration_ms IS NOT NULL
            AND duration_ms > 0
          FOR SHARE`,
        [canonical.orgId, canonical.mediaId, ELEARNING_MEDIA_MIME],
      )
      if (!media.rows[0]) fail('media_unavailable')

      await tx.query(
        `/* elearning-publish:insert-course */
         INSERT INTO elearning_courses (id, org_id, title, status, created_by)
         VALUES ($1, $2, $3, 'active', $4)`,
        [courseId, canonical.orgId, canonical.title, canonical.actorId],
      )
      await tx.query(
        `/* elearning-publish:insert-version */
         INSERT INTO elearning_course_versions
           (id, org_id, course_id, version, status, title, created_by)
         VALUES ($1, $2, $3, 1, 'draft', $4, $5)`,
        [courseVersionId, canonical.orgId, courseId, canonical.title, canonical.actorId],
      )
      await tx.query(
        `/* elearning-publish:insert-exam */
         INSERT INTO elearning_exams
           (id, org_id, title, status, pass_score, max_attempts, created_by)
         VALUES ($1, $2, $3, 'draft', $4, $5, $6)`,
        [
          examId,
          canonical.orgId,
          canonical.title,
          canonical.passScore,
          canonical.maxAttempts,
          canonical.actorId,
        ],
      )

      for (const row of questionRows) {
        await tx.query(
          `/* elearning-publish:insert-question */
           INSERT INTO elearning_questions (id, org_id, created_by)
           VALUES ($1, $2, $3)`,
          [row.questionId, canonical.orgId, canonical.actorId],
        )
        await tx.query(
          `/* elearning-publish:insert-revision */
           INSERT INTO elearning_question_revisions (
             id, org_id, question_id, revision, question_type, prompt, options,
             answer_key, explanation, points, created_by
           ) VALUES ($1, $2, $3, 1, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`,
          [
            row.revisionId,
            canonical.orgId,
            row.questionId,
            row.question.questionType,
            row.question.prompt,
            JSON.stringify(row.question.options),
            JSON.stringify({ correct: row.question.correctOptionIds }),
            row.question.explanation,
            row.question.points,
            canonical.actorId,
          ],
        )
        await tx.query(
          `/* elearning-publish:insert-exam-question */
           INSERT INTO elearning_exam_questions
             (org_id, exam_id, question_revision_id, position, points)
           VALUES ($1, $2, $3, $4, $5)`,
          [canonical.orgId, examId, row.revisionId, row.position, row.question.points],
        )
      }

      await tx.query(
        `/* elearning-publish:insert-video-item */
         INSERT INTO elearning_course_version_items (
           id, org_id, course_version_id, item_type, position, media_id, exam_id,
           completion_policy_version, completion_threshold_bps
         ) VALUES ($1, $2, $3, 'video', 1, $4, NULL, $5, $6)`,
        [
          videoItemId,
          canonical.orgId,
          courseVersionId,
          canonical.mediaId,
          ELEARNING_WATCH_POLICY_VERSION,
          ELEARNING_WATCH_THRESHOLD_BPS,
        ],
      )
      await tx.query(
        `/* elearning-publish:insert-exam-item */
         INSERT INTO elearning_course_version_items (
           id, org_id, course_version_id, item_type, position, media_id, exam_id,
           completion_policy_version, completion_threshold_bps
         ) VALUES ($1, $2, $3, 'exam', 2, NULL, $4, NULL, NULL)`,
        [examItemId, canonical.orgId, courseVersionId, examId],
      )

      const publishedExam = await tx.query(
        `/* elearning-publish:publish-exam */
         UPDATE elearning_exams
            SET status = 'published', updated_at = now()
          WHERE org_id = $1 AND id = $2 AND status = 'draft'`,
        [canonical.orgId, examId],
      )
      if ((publishedExam.rowCount ?? 0) !== 1) fail('unavailable')

      const publishedVersion = await tx.query(
        `/* elearning-publish:publish-version */
         UPDATE elearning_course_versions
            SET status = 'published', updated_at = now()
          WHERE org_id = $1 AND id = $2 AND status = 'draft'`,
        [canonical.orgId, courseVersionId],
      )
      if ((publishedVersion.rowCount ?? 0) !== 1) fail('unavailable')

      const pointers = await tx.query(
        `/* elearning-publish:set-pointers */
         UPDATE elearning_courses
            SET active_version_id = $1,
                latest_version_id = $1,
                updated_at = now()
          WHERE org_id = $2
            AND id = $3
            AND active_version_id IS NULL
            AND latest_version_id IS NULL`,
        [courseVersionId, canonical.orgId, courseId],
      )
      if ((pointers.rowCount ?? 0) !== 1) fail('unavailable')

      await tx.query(
        `/* elearning-publish:insert-request */
         INSERT INTO elearning_course_publish_requests (
           id, org_id, source_key, request_hash, request_hash_version,
           course_id, course_version_id, video_item_id, exam_item_id, exam_id,
           question_count, total_score
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          requestRowId,
          canonical.orgId,
          canonical.requestId,
          requestHash,
          ELEARNING_COURSE_PUBLISH_REQUEST_HASH_VERSION,
          courseId,
          courseVersionId,
          videoItemId,
          examItemId,
          examId,
          canonical.questions.length,
          canonical.totalScore,
        ],
      )

      return publicResult({
        courseId,
        courseVersionId,
        videoItemId,
        examItemId,
        examId,
        questionCount: canonical.questions.length,
        totalScore: canonical.totalScore,
      })
    } catch (error) {
      if (error instanceof ElearningCoursePublishError) throw error
      if (isSourceKeyUniqueViolation(error)) fail('conflict')
      fail('unavailable')
    }
  })
}
