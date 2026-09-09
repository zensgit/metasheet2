import { apiFetch } from '../utils/api'

export const ELEARNING_WATCH_HEARTBEAT_INTERVAL_MS = 1000
export const ELEARNING_MEDIA_PLAYBACK_PATH = '/api/elearning/media/playback'
export const ELEARNING_PAPER_DOMAIN = 'elearning.exam.paper.v1' as const
export const ELEARNING_PAPER_VERSION = 1 as const
export const ELEARNING_PAPER_VERSION_MIXED = 2 as const
export const ELEARNING_SHORT_ANSWER_MAX_CHARS = 10_000 as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256_RE = /^[a-f0-9]{64}$/
const FORBIDDEN_KEYS = new Set([
  'answerKey',
  'answer_key',
  'correct',
  'explanation',
  'storageKey',
  'storage_key',
])
const QUESTION_TYPES = ['single_choice', 'multiple_choice', 'true_false'] as const
const EXAM_QUESTION_TYPES = [...QUESTION_TYPES, 'short_answer'] as const
const WATCH_STATUSES = ['in_progress', 'completed'] as const
const VIDEO_LIST_STATUSES = ['not_started', 'in_progress', 'completed'] as const
const ATTEMPT_STATUSES = [
  'started',
  'submitted',
  'awaiting_manual',
  'graded',
  'expired',
] as const
const CAPABILITY_KEYS = [
  'content',
  'assignment',
  'assessment',
  'incentive',
  'analytics',
  'media',
  'enrollment',
] as const
const STABLE_ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,62}$/
const CANONICAL_ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export type ElearningQuestionType = (typeof QUESTION_TYPES)[number]
export type ElearningExamQuestionType = (typeof EXAM_QUESTION_TYPES)[number]
export type ElearningExamAnswer = string[] | string
export type ElearningExamAnswers = Record<string, ElearningExamAnswer>
export type ElearningWatchStatus = (typeof WATCH_STATUSES)[number]
export type ElearningLearnerVideoStatus = (typeof VIDEO_LIST_STATUSES)[number]
export type ElearningLearnerAttemptStatus = (typeof ATTEMPT_STATUSES)[number]
export type ElearningCapabilityKey = (typeof CAPABILITY_KEYS)[number]

export interface ElearningCapabilityFlags {
  content: boolean
  assignment: boolean
  assessment: boolean
  incentive: boolean
  analytics: boolean
  media: boolean
  enrollment: boolean
}

export interface ElearningCapabilities {
  enabled: boolean
  capabilities: ElearningCapabilityFlags
}

export class ElearningApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status: number) {
    super(code)
    this.name = 'ElearningApiError'
    this.code = code
    this.status = status
  }
}

export interface ElearningMediaUploadResult {
  id: string
  status: 'ready'
  durationMs: number
  sizeBytes: number
  sha256: string
}

interface ElearningMediaUploadRejected {
  id: string
  status: 'rejected'
  durationMs: null
  sizeBytes: number
  sha256: string
}

type ElearningMediaUploadWire = ElearningMediaUploadResult | ElearningMediaUploadRejected

export interface ElearningPublishOption {
  id: string
  text: string
}

export interface ElearningPublishQuestion {
  questionType: ElearningQuestionType
  prompt: string
  options: ElearningPublishOption[]
  correctOptionIds: string[]
  points: number
}

export interface ElearningCoursePublishRequest {
  requestId: string
  title: string
  mediaId: string
  passScore: number
  maxAttempts: number
  questions: ElearningPublishQuestion[]
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

export interface ElearningDirectAssignmentRequest {
  targetUserId: string
  courseVersionId: string
  sourceKey: string
  deadline?: string
}

export interface ElearningDirectAssignmentResult {
  assignmentId: string
  memberId: string
  duplicate: boolean
}

export interface ElearningLearnerAssignment {
  deadline: string | null
  assignedAt: string
}

export interface ElearningLearnerEnrollment {
  status: 'enrolled'
  enrolledAt: string
}

export interface ElearningCourseEnrollmentResult {
  enrollmentId: string
  courseId: string
  courseVersionId: string
  status: 'enrolled'
  enrolledAt: string
}

export interface ElearningLearnerVideo {
  itemId: string
  durationMs: number
  status: ElearningLearnerVideoStatus
  effectiveMs: number
  maxPositionMs: number
  completedAt: string | null
}

export interface ElearningLearnerLatestAttempt {
  attemptId: string
  attemptNo: number
  status: ElearningLearnerAttemptStatus
  autoScore: number | null
  totalScore: number | null
  passed: boolean | null
  startedAt: string
  submittedAt: string | null
  gradedAt: string | null
}

export interface ElearningLearnerExam {
  itemId: string
  latestAttempt: ElearningLearnerLatestAttempt | null
}

export interface ElearningLearnerAssessmentCourse {
  courseId: string
  courseVersionId: string
  title: string
  access: {
    kind: 'assignment' | 'visibility'
    required: boolean
  }
  assignment: ElearningLearnerAssignment | null
  enrollment: ElearningLearnerEnrollment | null
  video: ElearningLearnerVideo
  exam: ElearningLearnerExam
  completed: boolean
}

export interface ElearningLearnerContentItem {
  itemId: string
  itemType: 'article' | 'external_link'
  title: string
  status: 'not_started' | 'completed'
  completedAt: string | null
}

export interface ElearningLearnerContentCourse {
  courseId: string
  courseVersionId: string
  title: string
  access: {
    kind: 'assignment' | 'visibility'
    required: boolean
  }
  assignment: ElearningLearnerAssignment | null
  enrollment: ElearningLearnerEnrollment | null
  items: ElearningLearnerContentItem[]
  completed: boolean
}

export type ElearningLearnerCourse =
  | ElearningLearnerAssessmentCourse
  | ElearningLearnerContentCourse

export interface ElearningLearnerCourseList {
  courses: ElearningLearnerCourse[]
}

export interface ElearningWatchState {
  sessionId: string | null
  status: ElearningWatchStatus
  lastSequence: number
  lastClientPositionMs: number
  effectiveMs: number
  maxPositionMs: number
  durationMs: number
  creditedMs: number
  duplicate: boolean
  challenge?: ElearningWatchChallenge | null
}

export interface ElearningWatchChallenge {
  challengeId: string
  deadlineAt: string
  ordinal: number
  status: 'challenged' | 'paused'
  promptVersion: 'raster-position-v2'
  imagePngBase64: string
  imageWidth: 360
  imageHeight: 260
  options: Array<{
    optionId: string
    x: number
    y: number
    width: number
    height: number
  }>
}

export interface ElearningHeartbeatRequest {
  sequence: number
  positionMs: number
  playing: boolean
}

export interface ElearningPlaybackTicket {
  token: string
  expiresAt: string
  ttlSeconds: number
  itemId: string
  mediaId: string
}

export interface ElearningPublicOption {
  id: string
  text: string
}

export interface ElearningPublicQuestion {
  position: number
  questionRevisionId: string
  questionType: ElearningExamQuestionType
  prompt: string
  options: ElearningPublicOption[]
  points: number
}

export interface ElearningPublicPaper {
  domain: typeof ELEARNING_PAPER_DOMAIN
  version:
    | typeof ELEARNING_PAPER_VERSION
    | typeof ELEARNING_PAPER_VERSION_MIXED
  questions: ElearningPublicQuestion[]
}

export interface ElearningExamStartResult {
  attemptId: string
  attemptNo: number
  status: 'started'
  paper: ElearningPublicPaper
  answers: ElearningExamAnswers
  deadlineAt: string | null
  duplicate: boolean
}

export interface ElearningExamGradedSubmitResult {
  attemptId: string
  attemptNo: number
  status: 'graded'
  autoScore: number
  totalScore: number
  passed: boolean
  duplicate: boolean
}

export interface ElearningExamAwaitingManualSubmitResult {
  attemptId: string
  attemptNo: number
  status: 'awaiting_manual'
  autoScore: number
  totalScore: number
  passed: null
  duplicate: boolean
}

export type ElearningExamSubmitResult =
  | ElearningExamGradedSubmitResult
  | ElearningExamAwaitingManualSubmitResult

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(row)
  if (actual.length !== keys.length) return false
  return keys.every((key) => Object.prototype.hasOwnProperty.call(row, key))
}

function hasForbiddenKeys(value: unknown): boolean {
  const walk = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(walk)
    if (!isPlainObject(node)) return false
    for (const [key, child] of Object.entries(node)) {
      if (FORBIDDEN_KEYS.has(key)) return true
      if (walk(child)) return true
    }
    return false
  }
  return walk(value)
}

function fail(code: string, status: number): never {
  throw new ElearningApiError(code, status)
}

function failShape(status: number): never {
  fail('invalid_response', status)
}

function requireUuid(value: unknown, status: number): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) failShape(status)
  return value.toLowerCase()
}

function requireNonEmptyString(value: unknown, status: number): string {
  if (typeof value !== 'string' || value.trim() === '') failShape(status)
  return value
}

function requireSafeInt(value: unknown, status: number, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) failShape(status)
  return value
}

function requireFiniteNumber(value: unknown, status: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) failShape(status)
  return value
}

function requireBoolean(value: unknown, status: number): boolean {
  if (value !== true && value !== false) failShape(status)
  return value
}

function requireNullableFinite(value: unknown, status: number): number | null {
  if (value === null) return null
  return requireFiniteNumber(value, status)
}

function requireNullableBoolean(value: unknown, status: number): boolean | null {
  if (value === null) return null
  return requireBoolean(value, status)
}

function isQuestionType(value: unknown): value is ElearningQuestionType {
  return value === 'single_choice' || value === 'multiple_choice' || value === 'true_false'
}

function isExamQuestionType(value: unknown): value is ElearningExamQuestionType {
  return isQuestionType(value) || value === 'short_answer'
}

function readErrorCode(payload: unknown): string {
  if (isPlainObject(payload) && typeof payload.error === 'string') {
    const code = payload.error.trim()
    if (STABLE_ERROR_CODE_RE.test(code)) return code
  }
  return 'request_failed'
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

async function requestJson(
  path: string,
  expectedStatus: number,
  init: RequestInit,
): Promise<unknown> {
  let response: Response
  try {
    response = await apiFetch(path, init)
  } catch {
    fail('network_error', 0)
  }
  const payload = await readPayload(response)
  if (response.status !== expectedStatus) {
    fail(readErrorCode(payload), response.status)
  }
  if (hasForbiddenKeys(payload)) failShape(response.status)
  return payload
}

function postJson(path: string, expectedStatus: number, body: Record<string, unknown>) {
  return requestJson(path, expectedStatus, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

function putJson(path: string, expectedStatus: number, body: Record<string, unknown>) {
  return requestJson(path, expectedStatus, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

function parseOption(value: unknown, status: number): ElearningPublicOption {
  if (!isPlainObject(value) || !exactKeys(value, ['id', 'text'])) failShape(status)
  return {
    id: requireNonEmptyString(value.id, status),
    text: requireNonEmptyString(value.text, status),
  }
}

function parsePublicQuestion(value: unknown, status: number): ElearningPublicQuestion {
  if (!isPlainObject(value) || !exactKeys(value, [
    'position',
    'questionRevisionId',
    'questionType',
    'prompt',
    'options',
    'points',
  ])) {
    failShape(status)
  }
  if (!isExamQuestionType(value.questionType) || !Array.isArray(value.options)) {
    failShape(status)
  }
  if (
    value.questionType === 'short_answer'
      ? value.options.length !== 0
      : value.options.length < 1
  ) {
    failShape(status)
  }
  return {
    position: requireSafeInt(value.position, status, 1),
    questionRevisionId: requireUuid(value.questionRevisionId, status),
    questionType: value.questionType,
    prompt: requireNonEmptyString(value.prompt, status),
    options: value.options.map((option) => parseOption(option, status)),
    points: requireSafeInt(value.points, status, 0),
  }
}

function parsePublicPaper(value: unknown, status: number): ElearningPublicPaper {
  if (!isPlainObject(value) || !exactKeys(value, ['domain', 'version', 'questions'])) failShape(status)
  if (
    value.domain !== ELEARNING_PAPER_DOMAIN
    || (
      value.version !== ELEARNING_PAPER_VERSION
      && value.version !== ELEARNING_PAPER_VERSION_MIXED
    )
  ) {
    failShape(status)
  }
  if (!Array.isArray(value.questions) || value.questions.length < 1) failShape(status)
  const questions = value.questions.map((question) => parsePublicQuestion(question, status))
  const hasShortAnswer = questions.some(
    (question) => question.questionType === 'short_answer',
  )
  if (
    (value.version === ELEARNING_PAPER_VERSION && hasShortAnswer)
    || (value.version === ELEARNING_PAPER_VERSION_MIXED && !hasShortAnswer)
  ) {
    failShape(status)
  }
  return {
    domain: ELEARNING_PAPER_DOMAIN,
    version: value.version,
    questions,
  }
}

function parseOwnAnswers(
  value: unknown,
  paper: ElearningPublicPaper,
  status: number,
): ElearningExamAnswers {
  if (!isPlainObject(value)) failShape(status)
  const expected = paper.questions.map((question) => question.questionRevisionId)
  if (!exactKeys(value, expected)) failShape(status)
  const answers: ElearningExamAnswers = {}
  for (const question of paper.questions) {
    const selected = value[question.questionRevisionId]
    if (question.questionType === 'short_answer') {
      if (
        typeof selected !== 'string'
        || selected.length > ELEARNING_SHORT_ANSWER_MAX_CHARS
      ) {
        failShape(status)
      }
      answers[question.questionRevisionId] = selected
      continue
    }
    if (!Array.isArray(selected)) failShape(status)
    const optionIds = new Set(question.options.map((option) => option.id))
    const seen = new Set<string>()
    const list: string[] = []
    for (const entry of selected) {
      if (typeof entry !== 'string' || entry.trim() === '' || !optionIds.has(entry) || seen.has(entry)) {
        failShape(status)
      }
      seen.add(entry)
      list.push(entry)
    }
    answers[question.questionRevisionId] = list
  }
  return answers
}

function parseExamStartResult(value: unknown, status: number): ElearningExamStartResult {
  if (!isPlainObject(value) || !exactKeys(value, [
    'attemptId',
    'attemptNo',
    'status',
    'paper',
    'answers',
    'deadlineAt',
    'duplicate',
  ])) {
    failShape(status)
  }
  if (value.status !== 'started') failShape(status)
  const paper = parsePublicPaper(value.paper, status)
  return {
    attemptId: requireUuid(value.attemptId, status),
    attemptNo: requireSafeInt(value.attemptNo, status, 1),
    status: 'started',
    paper,
    answers: parseOwnAnswers(value.answers, paper, status),
    deadlineAt: requireNullableCanonicalIsoInstant(value.deadlineAt, status),
    duplicate: requireBoolean(value.duplicate, status),
  }
}

function parseWatchState(value: unknown, status: number): ElearningWatchState {
  if (!isPlainObject(value)) failShape(status)
  const baseKeys = [
    'sessionId',
    'status',
    'lastSequence',
    'lastClientPositionMs',
    'effectiveMs',
    'maxPositionMs',
    'durationMs',
    'creditedMs',
    'duplicate',
  ] as const
  const challengeKeys = [...baseKeys, 'challenge'] as const
  const challengeIncluded = exactKeys(value, challengeKeys)
  if (!challengeIncluded && !exactKeys(value, baseKeys)) failShape(status)
  if (value.status !== 'in_progress' && value.status !== 'completed') failShape(status)
  const sessionId = value.sessionId === null ? null : requireUuid(value.sessionId, status)
  const result: ElearningWatchState = {
    sessionId,
    status: value.status,
    lastSequence: requireSafeInt(value.lastSequence, status, 0),
    lastClientPositionMs: requireSafeInt(value.lastClientPositionMs, status, 0),
    effectiveMs: requireSafeInt(value.effectiveMs, status, 0),
    maxPositionMs: requireSafeInt(value.maxPositionMs, status, 0),
    durationMs: requireSafeInt(value.durationMs, status, 0),
    creditedMs: requireSafeInt(value.creditedMs, status, 0),
    duplicate: requireBoolean(value.duplicate, status),
  }
  if (challengeIncluded) {
    if (value.challenge === null) {
      result.challenge = null
    } else {
      if (!isPlainObject(value.challenge) || !exactKeys(value.challenge, [
        'challengeId',
        'deadlineAt',
        'ordinal',
        'status',
        'promptVersion',
        'imagePngBase64',
        'imageWidth',
        'imageHeight',
        'options',
      ])) failShape(status)
      if (value.challenge.status !== 'challenged' && value.challenge.status !== 'paused') {
        failShape(status)
      }
      if (
        value.challenge.promptVersion !== 'raster-position-v2'
        || value.challenge.imageWidth !== 360
        || value.challenge.imageHeight !== 260
        || typeof value.challenge.imagePngBase64 !== 'string'
        || value.challenge.imagePngBase64.length === 0
        || value.challenge.imagePngBase64.length > 88_000
        || !/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value.challenge.imagePngBase64)
        || value.challenge.imagePngBase64.length % 4 !== 0
        || !Array.isArray(value.challenge.options)
        || value.challenge.options.length !== 6
      ) failShape(status)
      const options = value.challenge.options.map((option) => {
        if (!isPlainObject(option) || !exactKeys(option, [
          'optionId', 'x', 'y', 'width', 'height',
        ])) failShape(status)
        const x = requireSafeInt(option.x, status, 0)
        const y = requireSafeInt(option.y, status, 0)
        const width = requireSafeInt(option.width, status, 1)
        const height = requireSafeInt(option.height, status, 1)
        if (x + width > 360 || y + height > 260) failShape(status)
        return {
          optionId: requireUuid(option.optionId, status),
          x,
          y,
          width,
          height,
        }
      })
      const optionIds = options.map((option) => option.optionId)
      if (new Set(optionIds).size !== 6) failShape(status)
      for (let left = 0; left < options.length; left += 1) {
        for (let right = left + 1; right < options.length; right += 1) {
          const a = options[left]!
          const b = options[right]!
          if (a.x < b.x + b.width && b.x < a.x + a.width
            && a.y < b.y + b.height && b.y < a.y + a.height) failShape(status)
        }
      }
      result.challenge = {
        challengeId: requireUuid(value.challenge.challengeId, status),
        deadlineAt: requireCanonicalIsoInstant(value.challenge.deadlineAt, status),
        ordinal: requireSafeInt(value.challenge.ordinal, status, 1),
        status: value.challenge.status,
        promptVersion: value.challenge.promptVersion,
        imagePngBase64: value.challenge.imagePngBase64,
        imageWidth: value.challenge.imageWidth,
        imageHeight: value.challenge.imageHeight,
        options,
      }
    }
  }
  if (result.status === 'completed' && result.challenge) failShape(status)
  return result
}

function isLearnerVideoStatus(value: unknown): value is ElearningLearnerVideoStatus {
  return value === 'not_started' || value === 'in_progress' || value === 'completed'
}

function isLearnerAttemptStatus(value: unknown): value is ElearningLearnerAttemptStatus {
  return value === 'started'
    || value === 'submitted'
    || value === 'awaiting_manual'
    || value === 'graded'
    || value === 'expired'
}

function requireCanonicalIsoInstant(value: unknown, status: number): string {
  const text = requireNonEmptyString(value, status)
  const date = new Date(text)
  if (
    !CANONICAL_ISO_INSTANT_RE.test(text)
    || Number.isNaN(date.getTime())
    || date.toISOString() !== text
  ) failShape(status)
  return text
}

function requireNullableCanonicalIsoInstant(value: unknown, status: number): string | null {
  if (value === null) return null
  return requireCanonicalIsoInstant(value, status)
}

function parseLatestAttempt(value: unknown, status: number): ElearningLearnerLatestAttempt | null {
  if (value === null) return null
  if (!isPlainObject(value) || !exactKeys(value, [
    'attemptId',
    'attemptNo',
    'status',
    'autoScore',
    'totalScore',
    'passed',
    'startedAt',
    'submittedAt',
    'gradedAt',
  ])) {
    failShape(status)
  }
  if (!isLearnerAttemptStatus(value.status)) failShape(status)
  return {
    attemptId: requireUuid(value.attemptId, status),
    attemptNo: requireSafeInt(value.attemptNo, status, 1),
    status: value.status,
    autoScore: requireNullableFinite(value.autoScore, status),
    totalScore: requireNullableFinite(value.totalScore, status),
    passed: requireNullableBoolean(value.passed, status),
    startedAt: requireCanonicalIsoInstant(value.startedAt, status),
    submittedAt: requireNullableCanonicalIsoInstant(value.submittedAt, status),
    gradedAt: requireNullableCanonicalIsoInstant(value.gradedAt, status),
  }
}

function parseLearnerVideo(value: unknown, status: number): ElearningLearnerVideo {
  if (!isPlainObject(value) || !exactKeys(value, [
    'itemId',
    'durationMs',
    'status',
    'effectiveMs',
    'maxPositionMs',
    'completedAt',
  ])) {
    failShape(status)
  }
  if (!isLearnerVideoStatus(value.status)) failShape(status)
  return {
    itemId: requireUuid(value.itemId, status),
    durationMs: requireSafeInt(value.durationMs, status, 1),
    status: value.status,
    effectiveMs: requireSafeInt(value.effectiveMs, status, 0),
    maxPositionMs: requireSafeInt(value.maxPositionMs, status, 0),
    completedAt: requireNullableCanonicalIsoInstant(value.completedAt, status),
  }
}

function parseCapabilities(value: unknown, status: number): ElearningCapabilities {
  if (!isPlainObject(value) || !exactKeys(value, ['enabled', 'capabilities'])) failShape(status)
  if (!isPlainObject(value.capabilities) || !exactKeys(value.capabilities, CAPABILITY_KEYS)) {
    failShape(status)
  }
  return {
    enabled: requireBoolean(value.enabled, status),
    capabilities: {
      content: requireBoolean(value.capabilities.content, status),
      assignment: requireBoolean(value.capabilities.assignment, status),
      assessment: requireBoolean(value.capabilities.assessment, status),
      incentive: requireBoolean(value.capabilities.incentive, status),
      analytics: requireBoolean(value.capabilities.analytics, status),
      media: requireBoolean(value.capabilities.media, status),
      enrollment: requireBoolean(value.capabilities.enrollment, status),
    },
  }
}

export function isElearningV01Ready(payload: ElearningCapabilities): boolean {
  return (
    payload.enabled === true
    && payload.capabilities.content === true
    && payload.capabilities.assignment === true
    && payload.capabilities.assessment === true
    && payload.capabilities.media === true
  )
}

export function isElearningLearnerReady(payload: ElearningCapabilities): boolean {
  return (
    payload.enabled === true
    && payload.capabilities.content === true
    && payload.capabilities.assessment === true
    && payload.capabilities.media === true
  )
}

export function isElearningContentReady(payload: ElearningCapabilities): boolean {
  return payload.enabled === true && payload.capabilities.content === true
}

export async function getElearningCapabilities(): Promise<ElearningCapabilities> {
  const payload = await requestJson('/api/elearning/capabilities', 200, { method: 'GET' })
  return parseCapabilities(payload, 200)
}

function parseLearnerCourseBase(
  value: Record<string, unknown>,
  status: number,
): Pick<
  ElearningLearnerAssessmentCourse,
  'courseId' | 'courseVersionId' | 'title' | 'access' | 'assignment' | 'enrollment'
> {
  if (!isPlainObject(value.access) || !exactKeys(value.access, ['kind', 'required'])) {
    failShape(status)
  }
  if (value.access.kind !== 'assignment' && value.access.kind !== 'visibility') failShape(status)
  const accessKind = value.access.kind
  const required = requireBoolean(value.access.required, status)
  if ((accessKind === 'assignment') !== required) failShape(status)
  if (value.assignment !== null && (
    !isPlainObject(value.assignment)
    || !exactKeys(value.assignment, ['deadline', 'assignedAt'])
  )) failShape(status)
  if ((accessKind === 'assignment') !== (value.assignment !== null)) failShape(status)
  if (value.enrollment !== null && (
    !isPlainObject(value.enrollment)
    || !exactKeys(value.enrollment, ['status', 'enrolledAt'])
    || value.enrollment.status !== 'enrolled'
  )) failShape(status)
  const deadline = value.assignment?.deadline
  return {
    courseId: requireUuid(value.courseId, status),
    courseVersionId: requireUuid(value.courseVersionId, status),
    title: requireNonEmptyString(value.title, status),
    access: { kind: accessKind, required },
    assignment: value.assignment === null
      ? null
      : {
          deadline: requireNullableCanonicalIsoInstant(deadline, status),
          assignedAt: requireCanonicalIsoInstant(value.assignment.assignedAt, status),
        },
    enrollment: value.enrollment === null
      ? null
      : {
          status: 'enrolled',
          enrolledAt: requireCanonicalIsoInstant(value.enrollment.enrolledAt, status),
        },
  }
}

function parseLearnerContentItem(value: unknown, status: number): ElearningLearnerContentItem {
  if (!isPlainObject(value) || !exactKeys(value, [
    'itemId',
    'itemType',
    'title',
    'status',
    'completedAt',
  ])) failShape(status)
  if (value.itemType !== 'article' && value.itemType !== 'external_link') failShape(status)
  if (value.status !== 'not_started' && value.status !== 'completed') failShape(status)
  const completedAt = requireNullableCanonicalIsoInstant(value.completedAt, status)
  if ((value.status === 'completed') !== (completedAt !== null)) failShape(status)
  return {
    itemId: requireUuid(value.itemId, status),
    itemType: value.itemType,
    title: requireNonEmptyString(value.title, status),
    status: value.status,
    completedAt,
  }
}

function parseLearnerAssessmentCourse(
  value: Record<string, unknown>,
  status: number,
): ElearningLearnerAssessmentCourse {
  if (!isPlainObject(value.exam) || !exactKeys(value.exam, ['itemId', 'latestAttempt'])) {
    failShape(status)
  }
  const base = parseLearnerCourseBase(value, status)
  const video = parseLearnerVideo(value.video, status)
  if ((video.status === 'completed') !== (video.completedAt !== null)) failShape(status)
  return {
    ...base,
    video,
    exam: {
      itemId: requireUuid(value.exam.itemId, status),
      latestAttempt: parseLatestAttempt(value.exam.latestAttempt, status),
    },
    completed: requireBoolean(value.completed, status),
  }
}

function parseLearnerContentCourse(
  value: Record<string, unknown>,
  status: number,
): ElearningLearnerContentCourse {
  if (!Array.isArray(value.items) || value.items.length < 1) failShape(status)
  const base = parseLearnerCourseBase(value, status)
  const items = value.items.map((item) => parseLearnerContentItem(item, status))
  const itemIds = new Set(items.map((item) => item.itemId))
  if (itemIds.size !== items.length) failShape(status)
  const completed = requireBoolean(value.completed, status)
  if (completed !== items.every((item) => item.status === 'completed')) failShape(status)
  return { ...base, items, completed }
}

function parseLearnerCourse(value: unknown, status: number): ElearningLearnerCourse {
  if (!isPlainObject(value)) failShape(status)
  const assessmentKeys = [
    'courseId',
    'courseVersionId',
    'title',
    'access',
    'assignment',
    'enrollment',
    'video',
    'exam',
    'completed',
  ] as const
  const contentKeys = [
    'courseId',
    'courseVersionId',
    'title',
    'access',
    'assignment',
    'enrollment',
    'items',
    'completed',
  ] as const
  if (exactKeys(value, assessmentKeys)) return parseLearnerAssessmentCourse(value, status)
  if (exactKeys(value, contentKeys)) return parseLearnerContentCourse(value, status)
  failShape(status)
}

export function isElearningAssessmentCourse(
  course: ElearningLearnerCourse,
): course is ElearningLearnerAssessmentCourse {
  return 'video' in course
}

export function elearningPlaybackSourceUrl(token: string): string {
  return `${ELEARNING_MEDIA_PLAYBACK_PATH}?token=${encodeURIComponent(token)}`
}

function parseMediaUploadWire(value: unknown, status: number): ElearningMediaUploadWire {
  if (!isPlainObject(value) || !exactKeys(value, ['id', 'status', 'durationMs', 'sizeBytes', 'sha256'])) {
    failShape(status)
  }
  if (value.status !== 'ready' && value.status !== 'rejected') failShape(status)
  if (typeof value.sha256 !== 'string' || !SHA256_RE.test(value.sha256)) failShape(status)
  const id = requireUuid(value.id, status)
  const sizeBytes = requireSafeInt(value.sizeBytes, status, 1)
  if (value.status === 'rejected') {
    if (value.durationMs !== null) failShape(status)
    return { id, status: 'rejected', durationMs: null, sizeBytes, sha256: value.sha256 }
  }
  return {
    id,
    status: 'ready',
    durationMs: requireSafeInt(value.durationMs, status, 1),
    sizeBytes,
    sha256: value.sha256,
  }
}

export async function uploadElearningMedia(file: File): Promise<ElearningMediaUploadResult> {
  const form = new FormData()
  form.append('file', file)
  const payload = await requestJson('/api/elearning/media', 201, {
    method: 'POST',
    body: form,
  })
  const wire = parseMediaUploadWire(payload, 201)
  if (wire.status === 'rejected') fail('rejected', 201)
  return wire
}

export async function publishElearningCourse(
  input: ElearningCoursePublishRequest,
): Promise<ElearningCoursePublishResult> {
  const payload = await postJson('/api/elearning/courses/publish', 201, {
    requestId: input.requestId,
    title: input.title,
    mediaId: input.mediaId,
    passScore: input.passScore,
    maxAttempts: input.maxAttempts,
    questions: input.questions,
  })
  if (!isPlainObject(payload) || !exactKeys(payload, [
    'courseId',
    'courseVersionId',
    'videoItemId',
    'examItemId',
    'examId',
    'status',
    'questionCount',
    'totalScore',
  ])) {
    failShape(201)
  }
  if (payload.status !== 'published') failShape(201)
  return {
    courseId: requireUuid(payload.courseId, 201),
    courseVersionId: requireUuid(payload.courseVersionId, 201),
    videoItemId: requireUuid(payload.videoItemId, 201),
    examItemId: requireUuid(payload.examItemId, 201),
    examId: requireUuid(payload.examId, 201),
    status: 'published',
    questionCount: requireSafeInt(payload.questionCount, 201, 1),
    totalScore: requireSafeInt(payload.totalScore, 201, 1),
  }
}

export async function assignElearningDirect(
  input: ElearningDirectAssignmentRequest,
): Promise<ElearningDirectAssignmentResult> {
  const body: Record<string, unknown> = {
    targetUserId: input.targetUserId,
    courseVersionId: input.courseVersionId,
    sourceKey: input.sourceKey,
  }
  if (input.deadline !== undefined) body.deadline = input.deadline
  const payload = await postJson('/api/elearning/assignments/direct', 201, body)
  if (!isPlainObject(payload) || !exactKeys(payload, ['assignmentId', 'memberId', 'duplicate'])) {
    failShape(201)
  }
  return {
    assignmentId: requireUuid(payload.assignmentId, 201),
    memberId: requireUuid(payload.memberId, 201),
    duplicate: requireBoolean(payload.duplicate, 201),
  }
}

export async function listMyElearningCourses(): Promise<ElearningLearnerCourseList> {
  const payload = await requestJson('/api/elearning/me/courses', 200, { method: 'GET' })
  if (!isPlainObject(payload) || !exactKeys(payload, ['courses']) || !Array.isArray(payload.courses)) {
    failShape(200)
  }
  return {
    courses: payload.courses.map((course) => parseLearnerCourse(course, 200)),
  }
}

export async function enrollElearningCourse(
  courseId: string,
  requestId: string,
): Promise<ElearningCourseEnrollmentResult> {
  const expectedCourseId = requireUuid(courseId, 0)
  const payload = await postJson(
    `/api/elearning/me/courses/${encodeURIComponent(expectedCourseId)}/enrollments`,
    201,
    { requestId },
  )
  if (!isPlainObject(payload) || !exactKeys(payload, [
    'enrollmentId',
    'courseId',
    'courseVersionId',
    'status',
    'enrolledAt',
  ])) failShape(201)
  if (payload.status !== 'enrolled') failShape(201)
  const canonicalCourseId = requireUuid(payload.courseId, 201)
  if (canonicalCourseId !== expectedCourseId) failShape(201)
  return {
    enrollmentId: requireUuid(payload.enrollmentId, 201),
    courseId: canonicalCourseId,
    courseVersionId: requireUuid(payload.courseVersionId, 201),
    status: 'enrolled',
    enrolledAt: requireCanonicalIsoInstant(payload.enrolledAt, 201),
  }
}

export async function startElearningWatch(itemId: string): Promise<ElearningWatchState> {
  const payload = await postJson(`/api/elearning/watch/items/${encodeURIComponent(itemId)}/start`, 200, {})
  return parseWatchState(payload, 200)
}

export async function issueElearningPlaybackTicket(itemId: string): Promise<ElearningPlaybackTicket> {
  const payload = await postJson(
    `/api/elearning/watch/items/${encodeURIComponent(itemId)}/playback-ticket`,
    200,
    {},
  )
  if (!isPlainObject(payload) || !exactKeys(payload, ['token', 'expiresAt', 'ttlSeconds', 'itemId', 'mediaId'])) {
    failShape(200)
  }
  return {
    token: requireNonEmptyString(payload.token, 200),
    expiresAt: requireCanonicalIsoInstant(payload.expiresAt, 200),
    ttlSeconds: requireSafeInt(payload.ttlSeconds, 200, 1),
    itemId: requireUuid(payload.itemId, 200),
    mediaId: requireUuid(payload.mediaId, 200),
  }
}

export async function sendElearningHeartbeat(
  sessionId: string,
  input: ElearningHeartbeatRequest,
): Promise<ElearningWatchState> {
  const payload = await postJson(
    `/api/elearning/watch/sessions/${encodeURIComponent(sessionId)}/heartbeat`,
    200,
    {
      sequence: input.sequence,
      positionMs: input.positionMs,
      playing: input.playing,
    },
  )
  return parseWatchState(payload, 200)
}

export async function acknowledgeElearningWatchChallenge(
  sessionId: string,
  challengeId: string,
  requestId: string,
  selections: readonly [string, string],
): Promise<ElearningWatchState> {
  const payload = await postJson(
    `/api/elearning/watch/sessions/${encodeURIComponent(sessionId)}`
      + `/challenges/${encodeURIComponent(challengeId)}/ack`,
    200,
    { requestId, selections },
  )
  return parseWatchState(payload, 200)
}

export async function startElearningExam(itemId: string): Promise<ElearningExamStartResult> {
  const payload = await postJson(`/api/elearning/exams/items/${encodeURIComponent(itemId)}/start`, 200, {})
  return parseExamStartResult(payload, 200)
}

export async function saveElearningExamAnswers(
  attemptId: string,
  answers: ElearningExamAnswers,
): Promise<ElearningExamStartResult> {
  const payload = await putJson(
    `/api/elearning/exams/attempts/${encodeURIComponent(attemptId)}/answers`,
    200,
    { answers },
  )
  return parseExamStartResult(payload, 200)
}

export async function submitElearningExam(
  attemptId: string,
  answers: ElearningExamAnswers,
): Promise<ElearningExamSubmitResult> {
  const payload = await postJson(
    `/api/elearning/exams/attempts/${encodeURIComponent(attemptId)}/submit`,
    200,
    { answers },
  )
  if (!isPlainObject(payload) || !exactKeys(payload, [
    'attemptId',
    'attemptNo',
    'status',
    'autoScore',
    'totalScore',
    'passed',
    'duplicate',
  ])) {
    failShape(200)
  }
  const common = {
    attemptId: requireUuid(payload.attemptId, 200),
    attemptNo: requireSafeInt(payload.attemptNo, 200, 1),
    autoScore: requireFiniteNumber(payload.autoScore, 200),
    totalScore: requireFiniteNumber(payload.totalScore, 200),
    duplicate: requireBoolean(payload.duplicate, 200),
  }
  if (payload.status === 'graded') {
    return {
      ...common,
      status: 'graded',
      passed: requireBoolean(payload.passed, 200),
    }
  }
  if (payload.status === 'awaiting_manual' && payload.passed === null) {
    return {
      ...common,
      status: 'awaiting_manual',
      passed: null,
    }
  }
  failShape(200)
}

export const ELEARNING_QUESTION_TYPES = QUESTION_TYPES
export const ELEARNING_WATCH_STATUS = WATCH_STATUSES
export const ELEARNING_ATTEMPT_STATUS = ATTEMPT_STATUSES
