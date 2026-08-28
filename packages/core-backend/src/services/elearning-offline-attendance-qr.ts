import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ElearningOfflineAttendanceAction } from './elearning-offline-attendance-policy'

/**
 * Pure L6 dynamic-QR authenticity envelope. Verification only proves that the
 * server issued a context-bound challenge. Attendance state still belongs to
 * elearning-offline-attendance-policy and its future transactional adapter.
 */

export const ELEARNING_OFFLINE_ATTENDANCE_QR_VERSION =
  'elearning.offline.attendance.qr.v1' as const

const MAX_KEY_LENGTH = 512
const MAX_NONCE_LENGTH = 128
const MIN_NONCE_LENGTH = 16
const MIN_SECRET_BYTES = 32
const MAX_SECRET_BYTES = 1024
const MAX_TOKEN_LENGTH = 8192
const MAX_PAYLOAD_BYTES = 4096

const CLAIM_KEYS = [
  'action',
  'expiresAt',
  'issuedAt',
  'nonce',
  'orgId',
  'policyRevision',
  'targetKey',
  'trainingKey',
  'version',
] as const
const EXPECTED_KEYS = [
  'action',
  'maxTtlSeconds',
  'now',
  'orgId',
  'policyRevision',
  'targetKey',
  'trainingKey',
] as const

export type ElearningOfflineAttendanceQrErrorCode =
  | 'context_mismatch'
  | 'expired'
  | 'invalid_input'
  | 'invalid_secret'
  | 'invalid_token'
  | 'not_yet_valid'
  | 'ttl_exceeded'

export class ElearningOfflineAttendanceQrError extends Error {
  constructor(readonly code: ElearningOfflineAttendanceQrErrorCode) {
    super(code)
    this.name = 'ElearningOfflineAttendanceQrError'
  }
}

export interface ElearningOfflineAttendanceQrClaims {
  readonly action: ElearningOfflineAttendanceAction
  readonly expiresAt: string
  readonly issuedAt: string
  readonly nonce: string
  readonly orgId: string
  readonly policyRevision: string
  readonly targetKey: string
  readonly trainingKey: string
  readonly version: typeof ELEARNING_OFFLINE_ATTENDANCE_QR_VERSION
}

export interface ElearningOfflineAttendanceQrExpectedContext {
  readonly action: ElearningOfflineAttendanceAction
  readonly maxTtlSeconds: number
  readonly now: string
  readonly orgId: string
  readonly policyRevision: string
  readonly targetKey: string
  readonly trainingKey: string
}

function fail(code: ElearningOfflineAttendanceQrErrorCode): never {
  throw new ElearningOfflineAttendanceQrError(code)
}

function readExactObject(
  input: unknown,
  expectedKeys: readonly string[],
  code: 'invalid_input' | 'invalid_token',
): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(code)
  try {
    const keys = Reflect.ownKeys(input)
    if (keys.some((key) => (
      typeof key !== 'string'
      || !Object.prototype.propertyIsEnumerable.call(input, key)
    ))) fail(code)
    const sorted = (keys as string[]).sort()
    if (
      sorted.length !== expectedKeys.length
      || sorted.some((key, index) => key !== expectedKeys[index])
    ) fail(code)
    const values: Record<string, unknown> = {}
    for (const key of expectedKeys) values[key] = (input as Record<string, unknown>)[key]
    return values
  } catch (error) {
    if (error instanceof ElearningOfflineAttendanceQrError) throw error
    fail(code)
  }
}

function requireKey(
  value: unknown,
  code: 'invalid_input' | 'invalid_token',
): string {
  if (typeof value !== 'string') fail(code)
  const text = value.trim()
  if (text === '' || text.length > MAX_KEY_LENGTH || text.includes('\0')) fail(code)
  for (let index = 0; index < text.length; index += 1) {
    const point = text.charCodeAt(index)
    if (point >= 0xd800 && point <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) fail(code)
      index += 1
    } else if (point >= 0xdc00 && point <= 0xdfff) {
      fail(code)
    }
  }
  return text
}

function requireInstant(
  value: unknown,
  code: 'invalid_input' | 'invalid_token',
): string {
  if (typeof value !== 'string' || !/^\d{4}-/.test(value)) fail(code)
  const instant = Date.parse(value)
  if (!Number.isFinite(instant)) fail(code)
  try {
    if (new Date(instant).toISOString() !== value) fail(code)
  } catch {
    fail(code)
  }
  return value
}

function requireAction(
  value: unknown,
  code: 'invalid_input' | 'invalid_token',
): ElearningOfflineAttendanceAction {
  if (value !== 'check_in' && value !== 'check_out') fail(code)
  return value
}

function requireMaxTtlSeconds(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 1
    || value > Math.floor(Number.MAX_SAFE_INTEGER / 1000)
  ) fail('invalid_input')
  return value
}

function requireSecret(input: unknown): Buffer {
  if (!(input instanceof Uint8Array)) fail('invalid_secret')
  if (input.byteLength < MIN_SECRET_BYTES || input.byteLength > MAX_SECRET_BYTES) {
    fail('invalid_secret')
  }
  return Buffer.from(input)
}

function normalizeClaims(
  input: unknown,
  code: 'invalid_input' | 'invalid_token',
): ElearningOfflineAttendanceQrClaims {
  const values = readExactObject(input, CLAIM_KEYS, code)
  if (values.version !== ELEARNING_OFFLINE_ATTENDANCE_QR_VERSION) fail(code)
  const action = requireAction(values.action, code)
  const issuedAt = requireInstant(values.issuedAt, code)
  const expiresAt = requireInstant(values.expiresAt, code)
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) fail(code)
  const nonce = requireKey(values.nonce, code)
  if (
    nonce.length < MIN_NONCE_LENGTH
    || nonce.length > MAX_NONCE_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(nonce)
  ) fail(code)
  return Object.freeze({
    action,
    expiresAt,
    issuedAt,
    nonce,
    orgId: requireKey(values.orgId, code),
    policyRevision: requireKey(values.policyRevision, code),
    targetKey: requireKey(values.targetKey, code),
    trainingKey: requireKey(values.trainingKey, code),
    version: ELEARNING_OFFLINE_ATTENDANCE_QR_VERSION,
  })
}

function assertTtl(
  claims: ElearningOfflineAttendanceQrClaims,
  maxTtlSeconds: number,
): void {
  if (Date.parse(claims.expiresAt) - Date.parse(claims.issuedAt) > maxTtlSeconds * 1000) {
    fail('ttl_exceeded')
  }
}

function signPayload(payloadSegment: string, secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(payloadSegment, 'utf8').digest()
}

function decodeBase64Url(
  segment: string,
  maxBytes: number,
): Buffer {
  if (segment === '' || !/^[A-Za-z0-9_-]+$/.test(segment)) fail('invalid_token')
  try {
    const decoded = Buffer.from(segment, 'base64url')
    if (decoded.byteLength > maxBytes || decoded.toString('base64url') !== segment) {
      fail('invalid_token')
    }
    return decoded
  } catch (error) {
    if (error instanceof ElearningOfflineAttendanceQrError) throw error
    fail('invalid_token')
  }
}

export function signElearningOfflineAttendanceQrToken(
  claimsInput: unknown,
  secretInput: unknown,
  maxTtlSecondsInput: unknown,
): string {
  const claims = normalizeClaims(claimsInput, 'invalid_input')
  const secret = requireSecret(secretInput)
  const maxTtlSeconds = requireMaxTtlSeconds(maxTtlSecondsInput)
  assertTtl(claims, maxTtlSeconds)
  const payloadSegment = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  const signatureSegment = signPayload(payloadSegment, secret).toString('base64url')
  return `${payloadSegment}.${signatureSegment}`
}

export function verifyElearningOfflineAttendanceQrToken(
  tokenInput: unknown,
  secretInput: unknown,
  expectedInput: unknown,
): ElearningOfflineAttendanceQrClaims {
  if (
    typeof tokenInput !== 'string'
    || tokenInput.length === 0
    || tokenInput.length > MAX_TOKEN_LENGTH
  ) fail('invalid_token')
  const parts = tokenInput.split('.')
  if (parts.length !== 2) fail('invalid_token')
  const [payloadSegment, signatureSegment] = parts
  const secret = requireSecret(secretInput)
  const actualSignature = decodeBase64Url(signatureSegment as string, 32)
  if (actualSignature.byteLength !== 32) fail('invalid_token')
  const expectedSignature = signPayload(payloadSegment as string, secret)
  if (!timingSafeEqual(actualSignature, expectedSignature)) fail('invalid_token')

  const payload = decodeBase64Url(payloadSegment as string, MAX_PAYLOAD_BYTES)
  const payloadText = payload.toString('utf8')
  if (!Buffer.from(payloadText, 'utf8').equals(payload)) fail('invalid_token')
  let parsed: unknown
  try {
    parsed = JSON.parse(payloadText)
  } catch {
    fail('invalid_token')
  }
  const claims = normalizeClaims(parsed, 'invalid_token')
  const expected = readExactObject(expectedInput, EXPECTED_KEYS, 'invalid_input')
  const action = requireAction(expected.action, 'invalid_input')
  const now = requireInstant(expected.now, 'invalid_input')
  const maxTtlSeconds = requireMaxTtlSeconds(expected.maxTtlSeconds)
  assertTtl(claims, maxTtlSeconds)
  if (
    claims.action !== action
    || claims.orgId !== requireKey(expected.orgId, 'invalid_input')
    || claims.policyRevision !== requireKey(expected.policyRevision, 'invalid_input')
    || claims.targetKey !== requireKey(expected.targetKey, 'invalid_input')
    || claims.trainingKey !== requireKey(expected.trainingKey, 'invalid_input')
  ) fail('context_mismatch')

  const nowMs = Date.parse(now)
  if (nowMs < Date.parse(claims.issuedAt)) fail('not_yet_valid')
  if (nowMs >= Date.parse(claims.expiresAt)) fail('expired')
  return claims
}
