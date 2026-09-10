/**
 * Pure L4 certificate-template and issuance policy. Persistence, serial
 * allocation, rendering, routes, and feature flags stay outside this module.
 */
import { createHash } from 'node:crypto'

const ABSOLUTE_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/
const CERTIFICATE_TEXT_MAX = 512
const CERTIFICATE_PARAMETER_NAME_MAX = 128
const CERTIFICATE_PARAMETER_VALUE_MAX = 2_048
const CERTIFICATE_TEMPLATE_TEXT_MAX = 16 * 1_024
const CERTIFICATE_TEMPLATE_PARAMETER_MAX = 64
const CERTIFICATE_ISSUANCE_KEYS = [
  'certificateId',
  'effectKey',
  'issuedAt',
  'orgId',
  'parameters',
  'templateRevisionId',
  'templateText',
  'userId',
] as const

export const ELEARNING_CERTIFICATE_ISSUE_DOMAIN =
  'elearning.certificate.issue.v1' as const
export const ELEARNING_CERTIFICATE_ISSUE_HASH_VERSION = 1 as const

export type ElearningCertificatePolicyErrorCode =
  | 'invalid_input'
  | 'invalid_issued_at'
  | 'invalid_parameters'
  | 'invalid_template'

export class ElearningCertificatePolicyError extends Error {
  constructor(readonly code: ElearningCertificatePolicyErrorCode) {
    super(code)
    this.name = 'ElearningCertificatePolicyError'
  }
}

export interface ElearningCertificateIssueCommand {
  readonly certificateId: string
  readonly effectKey: string
  readonly issuedAt: string
  readonly orgId: string
  readonly parameterSnapshot: Readonly<Record<string, string>>
  readonly requestHash: string
  readonly requestHashVersion: typeof ELEARNING_CERTIFICATE_ISSUE_HASH_VERSION
  readonly templateRevisionId: string
  readonly userId: string
}

function fail(code: ElearningCertificatePolicyErrorCode): never {
  throw new ElearningCertificatePolicyError(code)
}

function assertSupportedText(
  value: string,
  code: ElearningCertificatePolicyErrorCode,
): void {
  for (let index = 0; index < value.length; index += 1) {
    const point = value.charCodeAt(index)
    if (point === 0) fail(code)
    if (point >= 0xd800 && point <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) fail(code)
      index += 1
    } else if (point >= 0xdc00 && point <= 0xdfff) {
      fail(code)
    }
  }
}

function requireText(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_input')
  const text = value.trim()
  if (text === '' || text.length > CERTIFICATE_TEXT_MAX) fail('invalid_input')
  assertSupportedText(text, 'invalid_input')
  return text
}

function requireTemplateText(value: unknown): string {
  if (typeof value !== 'string' || value.length > CERTIFICATE_TEMPLATE_TEXT_MAX) {
    fail('invalid_template')
  }
  assertSupportedText(value, 'invalid_template')
  return value
}

function requireParameterName(value: string): string {
  if (
    value === ''
    || value !== value.trim()
    || value.length > CERTIFICATE_PARAMETER_NAME_MAX
  ) fail('invalid_template')
  assertSupportedText(value, 'invalid_template')
  return value
}

function normalizeIssuedAt(value: unknown): string {
  if (typeof value !== 'string' || !ABSOLUTE_TIMESTAMP_RE.test(value)) {
    fail('invalid_issued_at')
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) fail('invalid_issued_at')
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0'] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  if (
    month < 1 || month > 12
    || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23 || minute > 59 || second > 59
  ) fail('invalid_issued_at')
  const instant = new Date(value)
  if (Number.isNaN(instant.getTime())) fail('invalid_issued_at')
  return instant.toISOString()
}

function readOwnKeys(
  value: object,
  code: ElearningCertificatePolicyErrorCode,
): string[] {
  let keys: PropertyKey[]
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    fail(code)
  }
  try {
    if (
      keys.some((key) => (
        typeof key !== 'string'
        || !Object.prototype.propertyIsEnumerable.call(value, key)
      ))
    ) fail(code)
  } catch (error) {
    if (error instanceof ElearningCertificatePolicyError) throw error
    fail(code)
  }
  return keys as string[]
}

function readIssueInput(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid_input')
  }
  const keys = readOwnKeys(input, 'invalid_input').sort()
  if (
    keys.length !== CERTIFICATE_ISSUANCE_KEYS.length
    || keys.some((key, index) => key !== CERTIFICATE_ISSUANCE_KEYS[index])
  ) fail('invalid_input')
  const values: Record<string, unknown> = {}
  try {
    for (const key of CERTIFICATE_ISSUANCE_KEYS) {
      values[key] = (input as Record<string, unknown>)[key]
    }
  } catch {
    fail('invalid_input')
  }
  return values
}

/** Return each valid #parameter# name once, in first-appearance order. */
export function parseElearningCertificateTemplateParameters(
  input: unknown,
): readonly string[] {
  const templateText = requireTemplateText(input)
  const names: string[] = []
  const seen = new Set<string>()
  let cursor = 0
  while (cursor < templateText.length) {
    const open = templateText.indexOf('#', cursor)
    if (open === -1) break
    const close = templateText.indexOf('#', open + 1)
    if (close === -1) fail('invalid_template')
    const name = requireParameterName(templateText.slice(open + 1, close))
    if (!seen.has(name)) {
      if (names.length >= CERTIFICATE_TEMPLATE_PARAMETER_MAX) fail('invalid_template')
      seen.add(name)
      names.push(name)
    }
    cursor = close + 1
  }
  return Object.freeze(names)
}

function normalizeParameterSnapshot(
  input: unknown,
  expectedNames: readonly string[],
): Readonly<Record<string, string>> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid_parameters')
  }
  let prototype: object | null
  try {
    prototype = Object.getPrototypeOf(input)
  } catch {
    fail('invalid_parameters')
  }
  if (prototype !== Object.prototype && prototype !== null) fail('invalid_parameters')

  const keys = readOwnKeys(input, 'invalid_parameters').sort()
  const expected = [...expectedNames].sort()
  if (
    keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])
  ) fail('invalid_parameters')

  const snapshot = Object.create(null) as Record<string, string>
  try {
    for (const key of keys) {
      const raw = (input as Record<string, unknown>)[key]
      if (typeof raw !== 'string') fail('invalid_parameters')
      const value = raw.trim()
      if (value === '' || value.length > CERTIFICATE_PARAMETER_VALUE_MAX) {
        fail('invalid_parameters')
      }
      assertSupportedText(value, 'invalid_parameters')
      Object.defineProperty(snapshot, key, {
        enumerable: true,
        value,
      })
    }
  } catch (error) {
    if (error instanceof ElearningCertificatePolicyError) throw error
    fail('invalid_parameters')
  }
  return Object.freeze(snapshot)
}

export function normalizeElearningCertificateIssue(
  input: unknown,
): ElearningCertificateIssueCommand {
  const values = readIssueInput(input)
  const certificateId = requireText(values.certificateId)
  const effectKey = requireText(values.effectKey)
  const issuedAt = normalizeIssuedAt(values.issuedAt)
  const orgId = requireText(values.orgId)
  const templateRevisionId = requireText(values.templateRevisionId)
  const templateText = requireTemplateText(values.templateText)
  const userId = requireText(values.userId)
  const parameterNames = parseElearningCertificateTemplateParameters(templateText)
  const parameterSnapshot = normalizeParameterSnapshot(values.parameters, parameterNames)
  const canonicalPayload = JSON.stringify({
    certificateId,
    domain: ELEARNING_CERTIFICATE_ISSUE_DOMAIN,
    effectKey,
    issuedAt,
    orgId,
    parameterSnapshot,
    templateRevisionId,
    templateText,
    userId,
    version: ELEARNING_CERTIFICATE_ISSUE_HASH_VERSION,
  })
  const requestHash = createHash('sha256').update(canonicalPayload, 'utf8').digest('hex')

  return Object.freeze({
    certificateId,
    effectKey,
    issuedAt,
    orgId,
    parameterSnapshot,
    requestHash,
    requestHashVersion: ELEARNING_CERTIFICATE_ISSUE_HASH_VERSION,
    templateRevisionId,
    userId,
  })
}
