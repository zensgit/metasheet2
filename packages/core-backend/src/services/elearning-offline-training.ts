import { createHash, createHmac } from 'node:crypto'

export const ELEARNING_OFFLINE_QR_VERSION = 'elearning.offline.qr.v1' as const
export const ELEARNING_OFFLINE_REQUEST_HASH_VERSION = 1 as const
export const ELEARNING_OFFLINE_QR_TTL_SECONDS = 60 as const

const MAX_TARGETS = 100
const MAX_MEMBERS = 10_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const PUBLISH_KEYS = new Set(['attendanceMode', 'location', 'memberUserIds', 'requestId', 'targets', 'title'])
const TARGET_KEYS = new Set([
  'checkInClosesAt',
  'checkInOpensAt',
  'checkOutClosesAt',
  'checkOutOpensAt',
  'endsAt',
  'startsAt',
  'title',
])
const ISSUE_KEYS = new Set(['action', 'requestId', 'targetId', 'trainingId'])
const ATTEND_KEYS = new Set(['requestId', 'token'])
const STATUS_KEYS = new Set(['reason', 'requestId', 'status'])
const OPAQUE_QR_RE = /^[A-Za-z0-9_-]{43}$/

export type ElearningOfflineAttendanceAction = 'check_in' | 'check_out'
export type ElearningOfflineAttendanceMode = 'training' | 'session'
export type ElearningOfflineTrainingStatus = 'active' | 'archived' | 'withdrawn'
export type ElearningOfflineErrorCode =
  | 'check_in_required'
  | 'conflict'
  | 'disabled'
  | 'expired'
  | 'forbidden'
  | 'invalid_input'
  | 'invalid_token'
  | 'not_found'
  | 'unavailable'
  | 'window_closed'
  | 'window_not_open'

export class ElearningOfflineError extends Error {
  constructor(readonly code: ElearningOfflineErrorCode) {
    super(code)
    this.name = 'ElearningOfflineError'
  }
}

export interface ElearningOfflineTargetCommand {
  title: string
  startsAt: string
  endsAt: string
  checkInOpensAt: string
  checkInClosesAt: string
  checkOutOpensAt: string
  checkOutClosesAt: string
}

export interface PublishElearningOfflineTrainingCommand {
  requestId: string
  title: string
  location: string
  attendanceMode: ElearningOfflineAttendanceMode
  targets: ElearningOfflineTargetCommand[]
  memberUserIds: string[]
}

export interface IssueElearningOfflineQrCommand {
  requestId: string
  trainingId: string
  targetId: string
  action: ElearningOfflineAttendanceAction
}

export interface RecordElearningOfflineAttendanceCommand {
  requestId: string
  token: string
}

export interface SetElearningOfflineTrainingStatusCommand {
  requestId: string
  status: ElearningOfflineTrainingStatus
  reason: string
}

function fail(code: ElearningOfflineErrorCode): never {
  throw new ElearningOfflineError(code)
}

function object(value: unknown, keys: ReadonlySet<string>): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid_input')
  let actual: PropertyKey[]
  try {
    actual = Reflect.ownKeys(value)
  } catch {
    fail('invalid_input')
  }
  if (
    actual.length !== keys.size
    || actual.some((key) => (
      typeof key !== 'string'
      || !keys.has(key)
      || !Object.prototype.propertyIsEnumerable.call(value, key)
    ))
  ) fail('invalid_input')
  return value as Record<string, unknown>
}

function denseArray(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) fail('invalid_input')
  if (Reflect.ownKeys(value).length !== value.length + 1) fail('invalid_input')
  return value.map((entry, index) => {
    if (!Object.prototype.hasOwnProperty.call(value, index)) fail('invalid_input')
    return entry
  })
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') fail('invalid_input')
  const normalized = value.trim()
  if (normalized === '' || normalized.length > max || normalized.includes('\0')) fail('invalid_input')
  return normalized
}

export function normalizeElearningOfflineUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

export function normalizeElearningOfflineInstant(value: unknown): string {
  if (typeof value !== 'string' || !INSTANT_RE.test(value)) fail('invalid_input')
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) fail('invalid_input')
  return value
}

function action(value: unknown): ElearningOfflineAttendanceAction {
  if (value !== 'check_in' && value !== 'check_out') fail('invalid_input')
  return value
}

function target(value: unknown): ElearningOfflineTargetCommand {
  const row = object(value, TARGET_KEYS)
  const startsAt = normalizeElearningOfflineInstant(row.startsAt)
  const endsAt = normalizeElearningOfflineInstant(row.endsAt)
  const checkInOpensAt = normalizeElearningOfflineInstant(row.checkInOpensAt)
  const checkInClosesAt = normalizeElearningOfflineInstant(row.checkInClosesAt)
  const checkOutOpensAt = normalizeElearningOfflineInstant(row.checkOutOpensAt)
  const checkOutClosesAt = normalizeElearningOfflineInstant(row.checkOutClosesAt)
  if (
    Date.parse(endsAt) <= Date.parse(startsAt)
    || Date.parse(checkInClosesAt) <= Date.parse(checkInOpensAt)
    || Date.parse(checkOutClosesAt) <= Date.parse(checkOutOpensAt)
    || Date.parse(checkOutOpensAt) < Date.parse(checkInOpensAt)
    || Date.parse(checkOutClosesAt) < Date.parse(checkInClosesAt)
  ) fail('invalid_input')
  return {
    title: text(row.title, 200),
    startsAt,
    endsAt,
    checkInOpensAt,
    checkInClosesAt,
    checkOutOpensAt,
    checkOutClosesAt,
  }
}

export function normalizePublishElearningOfflineTraining(
  value: unknown,
): PublishElearningOfflineTrainingCommand {
  const row = object(value, PUBLISH_KEYS)
  if (row.attendanceMode !== 'training' && row.attendanceMode !== 'session') fail('invalid_input')
  const targets = denseArray(row.targets, MAX_TARGETS).map(target)
  if (row.attendanceMode === 'training' && targets.length !== 1) fail('invalid_input')
  const memberUserIds = denseArray(row.memberUserIds, MAX_MEMBERS)
    .map(normalizeElearningOfflineUuid)
    .sort()
  if (new Set(memberUserIds).size !== memberUserIds.length) fail('invalid_input')
  return {
    requestId: normalizeElearningOfflineUuid(row.requestId),
    title: text(row.title, 200),
    location: text(row.location, 500),
    attendanceMode: row.attendanceMode,
    targets,
    memberUserIds,
  }
}

export function normalizeIssueElearningOfflineQr(value: unknown): IssueElearningOfflineQrCommand {
  const row = object(value, ISSUE_KEYS)
  return {
    requestId: normalizeElearningOfflineUuid(row.requestId),
    trainingId: normalizeElearningOfflineUuid(row.trainingId),
    targetId: normalizeElearningOfflineUuid(row.targetId),
    action: action(row.action),
  }
}

export function normalizeRecordElearningOfflineAttendance(
  value: unknown,
): RecordElearningOfflineAttendanceCommand {
  const row = object(value, ATTEND_KEYS)
  return {
    requestId: normalizeElearningOfflineUuid(row.requestId),
    token: text(row.token, 8192),
  }
}

export function normalizeSetElearningOfflineTrainingStatus(
  value: unknown,
): SetElearningOfflineTrainingStatusCommand {
  const row = object(value, STATUS_KEYS)
  if (row.status !== 'active' && row.status !== 'archived' && row.status !== 'withdrawn') {
    fail('invalid_input')
  }
  return {
    requestId: normalizeElearningOfflineUuid(row.requestId),
    status: row.status,
    reason: text(row.reason, 500),
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function hashElearningOfflineRequest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(`elearning.offline.${domain}.v${ELEARNING_OFFLINE_REQUEST_HASH_VERSION}\0`)
    .update(canonical(value))
    .digest('hex')
}

function secret(value: unknown): Buffer {
  if (typeof value !== 'string') fail('unavailable')
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength < 32 || bytes.byteLength > 1024) fail('unavailable')
  return bytes
}

export function createElearningOfflineQrToken(
  challengeIdInput: unknown,
  secretInput: unknown,
): string {
  const challengeId = normalizeElearningOfflineUuid(challengeIdInput)
  return createHmac('sha256', secret(secretInput))
    .update(`${ELEARNING_OFFLINE_QR_VERSION}\0${challengeId}`)
    .digest('base64url')
}

export function digestElearningOfflineQrToken(tokenInput: unknown): string {
  if (typeof tokenInput !== 'string' || !OPAQUE_QR_RE.test(tokenInput)) fail('invalid_token')
  const decoded = Buffer.from(tokenInput, 'base64url')
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== tokenInput) fail('invalid_token')
  return createHash('sha256').update(tokenInput).digest('hex')
}
