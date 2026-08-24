import { apiFetch } from '../utils/api'

export const ELEARNING_WATCH_HEARTBEAT_INTERVAL_MS = 1000
export const ELEARNING_MEDIA_PLAYBACK_PATH = '/api/elearning/media/playback'
export const ELEARNING_PAPER_DOMAIN = 'elearning.exam.paper.v1' as const
export const ELEARNING_PAPER_VERSION = 1 as const

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
const WATCH_STATUSES = ['in_progress', 'completed'] as const
const VIDEO_LIST_STATUSES = ['not_started', 'in_progress', 'completed'] as const
const ATTEMPT_STATUSES = ['started', 'submitted', 'graded', 'expired'] as const
const CAPABILITY_KEYS = ['content', 'assignment', 'assessment', 'incentive', 'analytics', 'media'] as const
const STABLE_ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,62}$/

export type ElearningQuestionType = (typeof QUESTION_TYPES)[number]
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
  durationMs: number | null
  sizeBytes: number
  sha256: string
}

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

export interface ElearningLearnerCourse {
  courseId: string
  courseVersionId: string
  title: string
  assignment: ElearningLearnerAssignment
  video: ElearningLearnerVideo
  exam: ElearningLearnerExam
  completed: boolean
}

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
  questionType: ElearningQuestionType
  prompt: string
  options: ElearningPublicOption[]
  points: number
}

export interface ElearningPublicPaper {
  domain: typeof ELEARNING_PAPER_DOMAIN
  version: typeof ELEARNING_PAPER_VERSION
  questions: ElearningPublicQuestion[]
}

export interface ElearningExamStartResult {
  attemptId: string
  attemptNo: number
  status: 'started'
  paper: ElearningPublicPaper
  duplicate: boolean
}

export interface ElearningExamSubmitResult {
  attemptId: string
  attemptNo: number
  status: 'graded'
  autoScore: number
  totalScore: number
  passed: boolean
  duplicate: boolean
}

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
  if (!isQuestionType(value.questionType) || !Array.isArray(value.options) || value.options.length < 1) {
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
  if (value.domain !== ELEARNING_PAPER_DOMAIN || value.version !== ELEARNING_PAPER_VERSION) {
    failShape(status)
  }
  if (!Array.isArray(value.questions) || value.questions.length < 1) failShape(status)
  return {
    domain: ELEARNING_PAPER_DOMAIN,
    version: ELEARNING_PAPER_VERSION,
    questions: value.questions.map((question) => parsePublicQuestion(question, status)),
  }
}

function parseWatchState(value: unknown, status: number): ElearningWatchState {
  if (!isPlainObject(value) || !exactKeys(value, [
    'sessionId',
    'status',
    'lastSequence',
    'lastClientPositionMs',
    'effectiveMs',
    'maxPositionMs',
    'durationMs',
    'creditedMs',
    'duplicate',
  ])) {
    failShape(status)
  }
  if (value.status !== 'in_progress' && value.status !== 'completed') failShape(status)
  const sessionId = value.sessionId === null ? null : requireUuid(value.sessionId, status)
  return {
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
}

function isLearnerVideoStatus(value: unknown): value is ElearningLearnerVideoStatus {
  return value === 'not_started' || value === 'in_progress' || value === 'completed'
}

function isLearnerAttemptStatus(value: unknown): value is ElearningLearnerAttemptStatus {
  return value === 'started' || value === 'submitted' || value === 'graded' || value === 'expired'
}

function requireNullableString(value: unknown, status: number): string | null {
  if (value === null) return null
  return requireNonEmptyString(value, status)
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
    startedAt: requireNonEmptyString(value.startedAt, status),
    submittedAt: requireNullableString(value.submittedAt, status),
    gradedAt: requireNullableString(value.gradedAt, status),
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
    completedAt: requireNullableString(value.completedAt, status),
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

export async function getElearningCapabilities(): Promise<ElearningCapabilities> {
  const payload = await requestJson('/api/elearning/capabilities', 200, { method: 'GET' })
  return parseCapabilities(payload, 200)
}

function parseLearnerCourse(value: unknown, status: number): ElearningLearnerCourse {
  if (!isPlainObject(value) || !exactKeys(value, [
    'courseId',
    'courseVersionId',
    'title',
    'assignment',
    'video',
    'exam',
    'completed',
  ])) {
    failShape(status)
  }
  if (!isPlainObject(value.assignment) || !exactKeys(value.assignment, ['deadline', 'assignedAt'])) {
    failShape(status)
  }
  if (!isPlainObject(value.exam) || !exactKeys(value.exam, ['itemId', 'latestAttempt'])) failShape(status)
  const deadline = value.assignment.deadline
  if (deadline !== null && typeof deadline !== 'string') failShape(status)
  return {
    courseId: requireUuid(value.courseId, status),
    courseVersionId: requireUuid(value.courseVersionId, status),
    title: requireNonEmptyString(value.title, status),
    assignment: {
      deadline,
      assignedAt: requireNonEmptyString(value.assignment.assignedAt, status),
    },
    video: parseLearnerVideo(value.video, status),
    exam: {
      itemId: requireUuid(value.exam.itemId, status),
      latestAttempt: parseLatestAttempt(value.exam.latestAttempt, status),
    },
    completed: requireBoolean(value.completed, status),
  }
}

export function elearningPlaybackSourceUrl(token: string): string {
  return `${ELEARNING_MEDIA_PLAYBACK_PATH}?token=${encodeURIComponent(token)}`
}

export async function uploadElearningMedia(file: File): Promise<ElearningMediaUploadResult> {
  const form = new FormData()
  form.append('file', file)
  const payload = await requestJson('/api/elearning/media', 201, {
    method: 'POST',
    body: form,
  })
  if (!isPlainObject(payload) || !exactKeys(payload, ['id', 'status', 'durationMs', 'sizeBytes', 'sha256'])) {
    failShape(201)
  }
  if (payload.status !== 'ready') fail('rejected', 201)
  if (typeof payload.sha256 !== 'string' || !SHA256_RE.test(payload.sha256)) failShape(201)
  const durationMs = payload.durationMs === null ? null : requireSafeInt(payload.durationMs, 201, 0)
  return {
    id: requireUuid(payload.id, 201),
    status: 'ready',
    durationMs,
    sizeBytes: requireSafeInt(payload.sizeBytes, 201, 0),
    sha256: payload.sha256,
  }
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
    expiresAt: requireNonEmptyString(payload.expiresAt, 200),
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

export async function startElearningExam(itemId: string): Promise<ElearningExamStartResult> {
  const payload = await postJson(`/api/elearning/exams/items/${encodeURIComponent(itemId)}/start`, 200, {})
  if (!isPlainObject(payload) || !exactKeys(payload, ['attemptId', 'attemptNo', 'status', 'paper', 'duplicate'])) {
    failShape(200)
  }
  if (payload.status !== 'started') failShape(200)
  return {
    attemptId: requireUuid(payload.attemptId, 200),
    attemptNo: requireSafeInt(payload.attemptNo, 200, 1),
    status: 'started',
    paper: parsePublicPaper(payload.paper, 200),
    duplicate: requireBoolean(payload.duplicate, 200),
  }
}

export async function submitElearningExam(
  attemptId: string,
  answers: Record<string, string[]>,
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
  if (payload.status !== 'graded') failShape(200)
  return {
    attemptId: requireUuid(payload.attemptId, 200),
    attemptNo: requireSafeInt(payload.attemptNo, 200, 1),
    status: 'graded',
    autoScore: requireFiniteNumber(payload.autoScore, 200),
    totalScore: requireFiniteNumber(payload.totalScore, 200),
    passed: requireBoolean(payload.passed, 200),
    duplicate: requireBoolean(payload.duplicate, 200),
  }
}

export const ELEARNING_QUESTION_TYPES = QUESTION_TYPES
export const ELEARNING_WATCH_STATUS = WATCH_STATUSES
export const ELEARNING_ATTEMPT_STATUS = ATTEMPT_STATUSES
