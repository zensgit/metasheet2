import { apiFetch } from '../utils/api'
import { ElearningApiError } from './elearning'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ERROR_CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,62}$/
const CANONICAL_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const OPAQUE_QR_RE = /^[A-Za-z0-9_-]{43}$/
const OFFLINE_ATTENDANCE_HASH_PREFIX = '#offline-attendance='
const FORBIDDEN_RESPONSE_KEYS = new Set([
  'actorId',
  'challengeId',
  'decisionHash',
  'digest',
  'orgId',
  'requestHash',
  'secret',
])

export type ElearningOfflineAttendanceAction = 'check_in' | 'check_out'
export type ElearningOfflineAttendanceMode = 'training' | 'session'
export type ElearningOfflineRegistrationAction = 'cancel' | 'register'
export type ElearningOfflineTrainingStatus = 'active' | 'archived' | 'withdrawn'

export interface ElearningOfflineTargetCommand {
  title: string
  startsAt: string
  endsAt: string
  checkInOpensAt: string
  checkInClosesAt: string
  checkOutOpensAt: string
  checkOutClosesAt: string
}

export interface ElearningOfflineTarget extends ElearningOfflineTargetCommand {
  targetId: string
  position: number
}

export interface ElearningOfflinePublishResult {
  trainingId: string
  revisionId: string
  title: string
  location: string
  attendanceMode: ElearningOfflineAttendanceMode
  targets: ElearningOfflineTarget[]
  memberCount: number
  registrationEnabled: boolean
  createdAt: string
  duplicate: boolean
}

export interface ElearningOfflineQrResult {
  trainingId: string
  revisionId: string
  targetId: string
  action: ElearningOfflineAttendanceAction
  token: string
  issuedAt: string
  expiresAt: string
  duplicate: boolean
}

export interface ElearningOfflineLearnerTarget extends ElearningOfflineTarget {
  attendanceStatus: 'checked_in' | 'checked_out' | 'not_checked_in'
  checkedInAt: string | null
  checkedOutAt: string | null
}

export interface ElearningOfflineLearnerTraining {
  trainingId: string
  revisionId: string
  title: string
  location: string
  attendanceMode: ElearningOfflineAttendanceMode
  status: 'active' | 'archived'
  registrationEnabled: boolean
  registrationStatus: 'not_registered' | 'registered'
  targets: ElearningOfflineLearnerTarget[]
  completionStatus: 'completed' | 'in_progress'
}

export interface ElearningOfflineRegistrationResult {
  trainingId: string
  revisionId: string
  action: ElearningOfflineRegistrationAction
  status: 'cancelled' | 'registered'
  changedAt: string
  duplicate: boolean
}

export interface ElearningOfflineRegistrationListItem {
  userId: string
  status: 'cancelled' | 'not_registered' | 'registered'
  changedAt: string | null
}

export interface ElearningOfflineAttendanceResult {
  eventId: string
  trainingId: string
  revisionId: string
  targetId: string
  action: ElearningOfflineAttendanceAction
  occurredAt: string
  targetStatus: 'checked_in' | 'checked_out'
  completionStatus: 'completed' | 'in_progress'
  completedTargetCount: number
  totalTargetCount: number
  duplicate: boolean
}

export interface ElearningOfflineTrainingStatusResult {
  trainingId: string
  status: ElearningOfflineTrainingStatus
  reason: string
  changedAt: string
  duplicate: boolean
}

export interface ElearningOfflineRequestIds {
  forPublish(input: Omit<PublishElearningOfflineInput, 'requestId'>): string
  settlePublish(input: Omit<PublishElearningOfflineInput, 'requestId'>): void
  forQr(trainingId: string, targetId: string, action: ElearningOfflineAttendanceAction): string
  settleQr(trainingId: string, targetId: string, action: ElearningOfflineAttendanceAction): void
  forAttendance(token: string): string
  settleAttendance(token: string): void
  forStatus(trainingId: string, status: ElearningOfflineTrainingStatus, reason: string): string
  settleStatus(trainingId: string, status: ElearningOfflineTrainingStatus, reason: string): void
  forRegistration(trainingId: string, action: ElearningOfflineRegistrationAction): string
  settleRegistration(trainingId: string, action: ElearningOfflineRegistrationAction): void
}

export interface PublishElearningOfflineInput {
  requestId: string
  title: string
  location: string
  attendanceMode: ElearningOfflineAttendanceMode
  registrationEnabled: boolean
  targets: ElearningOfflineTargetCommand[]
  memberUserIds: string[]
}

function fail(code: string, status: number): never {
  throw new ElearningApiError(code, status)
}

function failShape(status: number): never {
  fail('invalid_response', status)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function hasForbiddenResponseKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenResponseKey)
  if (!isObject(value)) return false
  return Object.entries(value).some(([key, child]) => (
    FORBIDDEN_RESPONSE_KEYS.has(key) || hasForbiddenResponseKey(child)
  ))
}

function uuid(value: unknown, status: number): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) failShape(status)
  return value.toLowerCase()
}

function text(value: unknown, status: number, max: number): string {
  if (
    typeof value !== 'string'
    || value.trim() === ''
    || value.length > max
    || value.includes('\0')
  ) failShape(status)
  return value
}

function canonicalInstant(value: unknown, status: number): string {
  if (typeof value !== 'string' || !CANONICAL_INSTANT_RE.test(value)) failShape(status)
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) failShape(status)
  return value
}

function opaqueQrToken(value: unknown, status: number): string {
  if (typeof value !== 'string' || !OPAQUE_QR_RE.test(value)) failShape(status)
  return value
}

function nullableInstant(value: unknown, status: number): string | null {
  return value === null ? null : canonicalInstant(value, status)
}

function bool(value: unknown, status: number): boolean {
  if (value !== true && value !== false) failShape(status)
  return value
}

function integer(value: unknown, status: number, min: number, max: number): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < min
    || value > max
  ) failShape(status)
  return value
}

function mode(value: unknown, status: number): ElearningOfflineAttendanceMode {
  if (value !== 'training' && value !== 'session') failShape(status)
  return value
}

function action(value: unknown, status: number): ElearningOfflineAttendanceAction {
  if (value !== 'check_in' && value !== 'check_out') failShape(status)
  return value
}

function trainingStatus(value: unknown, status: number): ElearningOfflineTrainingStatus {
  if (value !== 'active' && value !== 'archived' && value !== 'withdrawn') failShape(status)
  return value
}

function parseTarget(value: unknown, status: number): ElearningOfflineTarget {
  if (!isObject(value) || !exactKeys(value, [
    'targetId',
    'position',
    'title',
    'startsAt',
    'endsAt',
    'checkInOpensAt',
    'checkInClosesAt',
    'checkOutOpensAt',
    'checkOutClosesAt',
  ])) failShape(status)
  const startsAt = canonicalInstant(value.startsAt, status)
  const endsAt = canonicalInstant(value.endsAt, status)
  const checkInOpensAt = canonicalInstant(value.checkInOpensAt, status)
  const checkInClosesAt = canonicalInstant(value.checkInClosesAt, status)
  const checkOutOpensAt = canonicalInstant(value.checkOutOpensAt, status)
  const checkOutClosesAt = canonicalInstant(value.checkOutClosesAt, status)
  if (
    Date.parse(endsAt) <= Date.parse(startsAt)
    || Date.parse(checkInClosesAt) <= Date.parse(checkInOpensAt)
    || Date.parse(checkOutClosesAt) <= Date.parse(checkOutOpensAt)
    || Date.parse(checkOutOpensAt) < Date.parse(checkInOpensAt)
    || Date.parse(checkOutClosesAt) < Date.parse(checkInClosesAt)
  ) failShape(status)
  return {
    targetId: uuid(value.targetId, status),
    position: integer(value.position, status, 1, 100),
    title: text(value.title, status, 200),
    startsAt,
    endsAt,
    checkInOpensAt,
    checkInClosesAt,
    checkOutOpensAt,
    checkOutClosesAt,
  }
}

function parseTargetList(value: unknown, status: number): ElearningOfflineTarget[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) failShape(status)
  const targets = value.map((entry) => parseTarget(entry, status))
  const ids = new Set<string>()
  for (const [index, target] of targets.entries()) {
    if (target.position !== index + 1 || ids.has(target.targetId)) failShape(status)
    ids.add(target.targetId)
  }
  return targets
}

function parseError(payload: unknown): string {
  if (isObject(payload) && exactKeys(payload, ['error']) && typeof payload.error === 'string') {
    const code = payload.error.trim()
    if (ERROR_CODE_RE.test(code)) return code
  }
  return 'request_failed'
}

async function requestJson(
  path: string,
  method: 'GET' | 'POST',
  expectedStatuses: readonly number[],
  body?: object,
): Promise<{ payload: unknown; status: number }> {
  let response: Response
  try {
    response = await apiFetch(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch {
    fail('network_error', 0)
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }
  if (!expectedStatuses.includes(response.status)) fail(parseError(payload), response.status)
  if (hasForbiddenResponseKey(payload)) failShape(response.status)
  return { payload, status: response.status }
}

function newRequestId(): string {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    fail('request_failed', 0)
  }
  return crypto.randomUUID()
}

export function createElearningOfflineAttendanceLink(tokenInput: unknown, originInput: unknown): string {
  const token = opaqueQrToken(tokenInput, 0)
  if (typeof originInput !== 'string') failShape(0)
  let url: URL
  try {
    url = new URL('/learn', originInput)
  } catch {
    failShape(0)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') failShape(0)
  url.hash = `${OFFLINE_ATTENDANCE_HASH_PREFIX.slice(1)}${token}`
  return url.toString()
}

export function readElearningOfflineAttendanceToken(hashInput: unknown): string | null {
  if (typeof hashInput !== 'string' || !hashInput.startsWith(OFFLINE_ATTENDANCE_HASH_PREFIX)) {
    return null
  }
  const token = hashInput.slice(OFFLINE_ATTENDANCE_HASH_PREFIX.length)
  return OPAQUE_QR_RE.test(token) ? token : null
}

function normalizedPublishIdentity(input: Omit<PublishElearningOfflineInput, 'requestId'>): string {
  return JSON.stringify([
    'publish',
    input.title.trim(),
    input.location.trim(),
    input.attendanceMode,
    input.registrationEnabled,
    input.targets.map((target) => [
      target.title.trim(),
      target.startsAt,
      target.endsAt,
      target.checkInOpensAt,
      target.checkInClosesAt,
      target.checkOutOpensAt,
      target.checkOutClosesAt,
    ]),
    [...input.memberUserIds].map((id) => id.toLowerCase()).sort(),
  ])
}

export function createElearningOfflineRequestIds(): ElearningOfflineRequestIds {
  const ids = new Map<string, string>()
  const publishIdentity = (input: Omit<PublishElearningOfflineInput, 'requestId'>): string => (
    normalizedPublishIdentity(input)
  )
  const qrIdentity = (
    trainingId: string,
    targetId: string,
    attendanceAction: ElearningOfflineAttendanceAction,
  ): string => JSON.stringify(['qr', trainingId.toLowerCase(), targetId.toLowerCase(), attendanceAction])
  const attendanceIdentity = (token: string): string => JSON.stringify(['attendance', token.trim()])
  const statusIdentity = (
    trainingId: string,
    nextStatus: ElearningOfflineTrainingStatus,
    reason: string,
  ): string => JSON.stringify(['status', trainingId.toLowerCase(), nextStatus, reason.trim()])
  const registrationIdentity = (
    trainingId: string,
    registrationAction: ElearningOfflineRegistrationAction,
  ): string => JSON.stringify(['registration', trainingId.toLowerCase(), registrationAction])
  const forIdentity = (identity: string): string => {
    const existing = ids.get(identity)
    if (existing) return existing
    const created = newRequestId()
    ids.set(identity, created)
    return created
  }
  return {
    forPublish: (input) => forIdentity(publishIdentity(input)),
    settlePublish: (input) => ids.delete(publishIdentity(input)),
    forQr: (trainingId, targetId, attendanceAction) => (
      forIdentity(qrIdentity(trainingId, targetId, attendanceAction))
    ),
    settleQr: (trainingId, targetId, attendanceAction) => {
      ids.delete(qrIdentity(trainingId, targetId, attendanceAction))
    },
    forAttendance: (token) => forIdentity(attendanceIdentity(token)),
    settleAttendance: (token) => ids.delete(attendanceIdentity(token)),
    forStatus: (trainingId, nextStatus, reason) => (
      forIdentity(statusIdentity(trainingId, nextStatus, reason))
    ),
    settleStatus: (trainingId, nextStatus, reason) => {
      ids.delete(statusIdentity(trainingId, nextStatus, reason))
    },
    forRegistration: (trainingId, registrationAction) => (
      forIdentity(registrationIdentity(trainingId, registrationAction))
    ),
    settleRegistration: (trainingId, registrationAction) => {
      ids.delete(registrationIdentity(trainingId, registrationAction))
    },
  }
}

export async function publishElearningOfflineTraining(
  input: PublishElearningOfflineInput,
): Promise<ElearningOfflinePublishResult> {
  const { payload, status } = await requestJson(
    '/api/elearning/admin/offline-trainings',
    'POST',
    [200, 201],
    input,
  )
  if (!isObject(payload) || !exactKeys(payload, [
    'trainingId',
    'revisionId',
    'title',
    'location',
    'attendanceMode',
    'targets',
    'memberCount',
    'registrationEnabled',
    'createdAt',
    'duplicate',
  ])) failShape(status)
  const targets = parseTargetList(payload.targets, status)
  const attendanceMode = mode(payload.attendanceMode, status)
  if (attendanceMode === 'training' && targets.length !== 1) failShape(status)
  return {
    trainingId: uuid(payload.trainingId, status),
    revisionId: uuid(payload.revisionId, status),
    title: text(payload.title, status, 200),
    location: text(payload.location, status, 500),
    attendanceMode,
    targets,
    memberCount: integer(payload.memberCount, status, 1, 10_000),
    registrationEnabled: bool(payload.registrationEnabled, status),
    createdAt: canonicalInstant(payload.createdAt, status),
    duplicate: bool(payload.duplicate, status),
  }
}

export async function issueElearningOfflineQr(input: {
  requestId: string
  trainingId: string
  targetId: string
  action: ElearningOfflineAttendanceAction
}): Promise<ElearningOfflineQrResult> {
  const { payload, status } = await requestJson(
    `/api/elearning/admin/offline-trainings/${encodeURIComponent(input.trainingId)}/targets/${encodeURIComponent(input.targetId)}/qr`,
    'POST',
    [200, 201],
    { requestId: input.requestId, action: input.action },
  )
  if (!isObject(payload) || !exactKeys(payload, [
    'trainingId',
    'revisionId',
    'targetId',
    'action',
    'token',
    'issuedAt',
    'expiresAt',
    'duplicate',
  ])) failShape(status)
  const issuedAt = canonicalInstant(payload.issuedAt, status)
  const expiresAt = canonicalInstant(payload.expiresAt, status)
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) failShape(status)
  const result: ElearningOfflineQrResult = {
    trainingId: uuid(payload.trainingId, status),
    revisionId: uuid(payload.revisionId, status),
    targetId: uuid(payload.targetId, status),
    action: action(payload.action, status),
    token: opaqueQrToken(payload.token, status),
    issuedAt,
    expiresAt,
    duplicate: bool(payload.duplicate, status),
  }
  if (
    result.trainingId !== input.trainingId.toLowerCase()
    || result.targetId !== input.targetId.toLowerCase()
    || result.action !== input.action
  ) failShape(status)
  return result
}

export async function setElearningOfflineTrainingStatus(input: {
  requestId: string
  trainingId: string
  status: ElearningOfflineTrainingStatus
  reason: string
}): Promise<ElearningOfflineTrainingStatusResult> {
  const { payload, status } = await requestJson(
    `/api/elearning/admin/offline-trainings/${encodeURIComponent(input.trainingId)}/status`,
    'POST',
    [200],
    { requestId: input.requestId, status: input.status, reason: input.reason },
  )
  if (!isObject(payload) || !exactKeys(payload, [
    'trainingId',
    'status',
    'reason',
    'changedAt',
    'duplicate',
  ])) failShape(status)
  const result: ElearningOfflineTrainingStatusResult = {
    trainingId: uuid(payload.trainingId, status),
    status: trainingStatus(payload.status, status),
    reason: text(payload.reason, status, 500),
    changedAt: canonicalInstant(payload.changedAt, status),
    duplicate: bool(payload.duplicate, status),
  }
  if (result.trainingId !== input.trainingId.toLowerCase() || result.status !== input.status) {
    failShape(status)
  }
  return result
}

export async function listMyElearningOfflineTrainings(): Promise<{
  trainings: ElearningOfflineLearnerTraining[]
}> {
  const { payload, status } = await requestJson('/api/elearning/me/offline-trainings', 'GET', [200])
  if (!isObject(payload) || !exactKeys(payload, ['trainings']) || !Array.isArray(payload.trainings)) {
    failShape(status)
  }
  const trainings = payload.trainings.map((entry): ElearningOfflineLearnerTraining => {
    if (!isObject(entry) || !exactKeys(entry, [
      'trainingId',
      'revisionId',
      'title',
      'location',
      'attendanceMode',
      'status',
      'registrationEnabled',
      'registrationStatus',
      'targets',
      'completionStatus',
    ]) || (entry.status !== 'active' && entry.status !== 'archived')) failShape(status)
    if (entry.completionStatus !== 'completed' && entry.completionStatus !== 'in_progress') {
      failShape(status)
    }
    const registrationEnabled = bool(entry.registrationEnabled, status)
    if (
      entry.registrationStatus !== 'not_registered'
      && entry.registrationStatus !== 'registered'
    ) failShape(status)
    if (!registrationEnabled && entry.registrationStatus !== 'not_registered') failShape(status)
    if (!Array.isArray(entry.targets) || entry.targets.length === 0 || entry.targets.length > 100) {
      failShape(status)
    }
    const ids = new Set<string>()
    const targets = entry.targets.map((targetValue, index): ElearningOfflineLearnerTarget => {
      if (!isObject(targetValue) || !exactKeys(targetValue, [
        'targetId',
        'position',
        'title',
        'startsAt',
        'endsAt',
        'checkInOpensAt',
        'checkInClosesAt',
        'checkOutOpensAt',
        'checkOutClosesAt',
        'attendanceStatus',
        'checkedInAt',
        'checkedOutAt',
      ])) failShape(status)
      const base = parseTarget({
        targetId: targetValue.targetId,
        position: targetValue.position,
        title: targetValue.title,
        startsAt: targetValue.startsAt,
        endsAt: targetValue.endsAt,
        checkInOpensAt: targetValue.checkInOpensAt,
        checkInClosesAt: targetValue.checkInClosesAt,
        checkOutOpensAt: targetValue.checkOutOpensAt,
        checkOutClosesAt: targetValue.checkOutClosesAt,
      }, status)
      if (base.position !== index + 1 || ids.has(base.targetId)) failShape(status)
      ids.add(base.targetId)
      const checkedInAt = nullableInstant(targetValue.checkedInAt, status)
      const checkedOutAt = nullableInstant(targetValue.checkedOutAt, status)
      if (
        (targetValue.attendanceStatus === 'not_checked_in' && (checkedInAt !== null || checkedOutAt !== null))
        || (targetValue.attendanceStatus === 'checked_in' && (checkedInAt === null || checkedOutAt !== null))
        || (targetValue.attendanceStatus === 'checked_out' && (checkedInAt === null || checkedOutAt === null))
        || (
          targetValue.attendanceStatus !== 'not_checked_in'
          && targetValue.attendanceStatus !== 'checked_in'
          && targetValue.attendanceStatus !== 'checked_out'
        )
      ) failShape(status)
      return {
        ...base,
        attendanceStatus: targetValue.attendanceStatus,
        checkedInAt,
        checkedOutAt,
      }
    })
    const allCompleted = targets.every((target) => target.attendanceStatus === 'checked_out')
    if ((entry.completionStatus === 'completed') !== allCompleted) failShape(status)
    return {
      trainingId: uuid(entry.trainingId, status),
      revisionId: uuid(entry.revisionId, status),
      title: text(entry.title, status, 200),
      location: text(entry.location, status, 500),
      attendanceMode: mode(entry.attendanceMode, status),
      status: entry.status,
      registrationEnabled,
      registrationStatus: entry.registrationStatus,
      targets,
      completionStatus: entry.completionStatus,
    }
  })
  if (new Set(trainings.map((training) => training.trainingId)).size !== trainings.length) {
    failShape(status)
  }
  return { trainings }
}

export async function changeElearningOfflineRegistration(input: {
  requestId: string
  trainingId: string
  action: ElearningOfflineRegistrationAction
}): Promise<ElearningOfflineRegistrationResult> {
  const { payload, status } = await requestJson(
    `/api/elearning/me/offline-trainings/${encodeURIComponent(input.trainingId)}/registration`,
    'POST',
    [200, 201],
    { requestId: input.requestId, action: input.action },
  )
  if (!isObject(payload) || !exactKeys(payload, [
    'trainingId',
    'revisionId',
    'action',
    'status',
    'changedAt',
    'duplicate',
  ])) failShape(status)
  if (payload.action !== 'register' && payload.action !== 'cancel') failShape(status)
  if (payload.status !== 'registered' && payload.status !== 'cancelled') failShape(status)
  const result: ElearningOfflineRegistrationResult = {
    trainingId: uuid(payload.trainingId, status),
    revisionId: uuid(payload.revisionId, status),
    action: payload.action,
    status: payload.status,
    changedAt: canonicalInstant(payload.changedAt, status),
    duplicate: bool(payload.duplicate, status),
  }
  if (
    result.trainingId !== input.trainingId.toLowerCase()
    || result.action !== input.action
    || (result.action === 'register') !== (result.status === 'registered')
  ) failShape(status)
  return result
}

export async function listElearningOfflineRegistrations(input: {
  trainingId: string
  after?: string
  limit?: number
}): Promise<{ items: ElearningOfflineRegistrationListItem[]; nextCursor: string | null }> {
  const query = new URLSearchParams()
  if (input.after !== undefined) query.set('after', input.after)
  query.set('limit', String(input.limit ?? 50))
  const { payload, status } = await requestJson(
    `/api/elearning/admin/offline-trainings/${encodeURIComponent(input.trainingId)}/registrations?${query}`,
    'GET',
    [200],
  )
  if (!isObject(payload) || !exactKeys(payload, ['items', 'nextCursor']) || !Array.isArray(payload.items)) {
    failShape(status)
  }
  const requestedAfter = input.after === undefined ? null : uuid(input.after, status)
  const seen = new Set<string>()
  let previous = ''
  const items = payload.items.map((entry): ElearningOfflineRegistrationListItem => {
    if (!isObject(entry) || !exactKeys(entry, ['userId', 'status', 'changedAt'])) failShape(status)
    const userId = uuid(entry.userId, status)
    if (
      (entry.status !== 'cancelled'
        && entry.status !== 'not_registered'
        && entry.status !== 'registered')
      || seen.has(userId)
      || (requestedAfter !== null && userId <= requestedAfter)
      || (previous !== '' && userId <= previous)
    ) failShape(status)
    const changedAt = nullableInstant(entry.changedAt, status)
    if ((entry.status === 'not_registered') !== (changedAt === null)) failShape(status)
    seen.add(userId)
    previous = userId
    return { userId, status: entry.status, changedAt }
  })
  const nextCursor = payload.nextCursor === null ? null : uuid(payload.nextCursor, status)
  if (nextCursor !== null && (items.length === 0 || nextCursor !== items[items.length - 1]?.userId)) {
    failShape(status)
  }
  return { items, nextCursor }
}

export async function probeElearningOfflineTraining(): Promise<boolean> {
  try {
    await listMyElearningOfflineTrainings()
    return true
  } catch (error) {
    if (error instanceof ElearningApiError && error.status === 404) return false
    throw error
  }
}

export async function recordElearningOfflineAttendance(input: {
  requestId: string
  token: string
}): Promise<ElearningOfflineAttendanceResult> {
  const { payload, status } = await requestJson(
    '/api/elearning/me/offline-attendance',
    'POST',
    [200],
    input,
  )
  if (!isObject(payload) || !exactKeys(payload, [
    'eventId',
    'trainingId',
    'revisionId',
    'targetId',
    'action',
    'occurredAt',
    'targetStatus',
    'completionStatus',
    'completedTargetCount',
    'totalTargetCount',
    'duplicate',
  ])) failShape(status)
  const parsedAction = action(payload.action, status)
  const targetStatus = payload.targetStatus === 'checked_in' || payload.targetStatus === 'checked_out'
    ? payload.targetStatus
    : failShape(status)
  const completionStatus = payload.completionStatus === 'completed'
    || payload.completionStatus === 'in_progress'
    ? payload.completionStatus
    : failShape(status)
  if (
    (parsedAction === 'check_in' && targetStatus !== 'checked_in')
    || (parsedAction === 'check_out' && targetStatus !== 'checked_out')
  ) failShape(status)
  const totalTargetCount = integer(payload.totalTargetCount, status, 1, 100)
  const completedTargetCount = integer(payload.completedTargetCount, status, 0, totalTargetCount)
  if ((completionStatus === 'completed') !== (completedTargetCount === totalTargetCount)) {
    failShape(status)
  }
  return {
    eventId: uuid(payload.eventId, status),
    trainingId: uuid(payload.trainingId, status),
    revisionId: uuid(payload.revisionId, status),
    targetId: uuid(payload.targetId, status),
    action: parsedAction,
    occurredAt: canonicalInstant(payload.occurredAt, status),
    targetStatus,
    completionStatus,
    completedTargetCount,
    totalTargetCount,
    duplicate: bool(payload.duplicate, status),
  }
}
