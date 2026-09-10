import { apiFetch } from '../utils/api'
import { ElearningApiError } from './elearning'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CANONICAL_ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const STABLE_ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,62}$/
const MAX_TEXT = 512
const MAX_TEMPLATE = 16 * 1024
const MAX_BACKGROUND_URL = 2_048
const MAX_PARAMETERS = 64

export interface ElearningCertificateTemplate {
  certificateId: string
  revisionId: string
  version: number
  name: string
  templateText: string
  backgroundImageUrl: string | null
  placeholders: string[]
  createdAt: string
}

export interface ElearningCertificateTemplatePublishInput {
  requestId: string
  certificateId: string
  name: string
  templateText: string
  backgroundImageUrl: string | null
}

export interface ElearningCertificateIssue {
  issueId: string
  certificateId: string
  templateRevisionId: string
  templateName: string
  serialNumber: string
  parameters: Record<string, string>
  backgroundImageUrl: string | null
  issuedAt: string
}

export interface ElearningCertificateIssueInput {
  requestId: string
  certificateId: string
  userId: string
  parameters: Record<string, string>
}

function fail(code: string, status: number): never {
  throw new ElearningApiError(code, status)
}

function failShape(status: number): never {
  fail('invalid_response', status)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function requireUuid(value: unknown, status: number): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) failShape(status)
  return value.toLowerCase()
}

function requireInputUuid(value: string): string {
  if (!UUID_RE.test(value)) fail('invalid_input', 400)
  return value.toLowerCase()
}

function requireStoredText(value: unknown, status: number): string {
  if (typeof value !== 'string' || value === '' || value !== value.trim()) {
    failShape(status)
  }
  return value
}

function requireInputText(value: string, max = MAX_TEXT): string {
  const text = value.trim()
  if (
    text === ''
    || text.length > max
    || text.includes('\0')
    || /[\ud800-\udfff]/u.test(text)
  ) fail('invalid_input', 400)
  return text
}

function requireTemplateText(value: string): string {
  if (
    value.length > MAX_TEMPLATE
    || value.includes('\0')
    || /[\ud800-\udfff]/u.test(value)
  ) fail('invalid_input', 400)
  parseTemplatePlaceholderNames(value)
  return value
}

function parseTemplatePlaceholderNames(value: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  let cursor = 0
  while (cursor < value.length) {
    const open = value.indexOf('#', cursor)
    if (open === -1) break
    const close = value.indexOf('#', open + 1)
    if (close === -1) fail('invalid_input', 400)
    const name = value.slice(open + 1, close)
    if (
      name === ''
      || name !== name.trim()
      || name.length > 128
      || /[\0\ud800-\udfff]/u.test(name)
    ) fail('invalid_input', 400)
    if (!seen.has(name)) {
      if (names.length >= MAX_PARAMETERS) fail('invalid_input', 400)
      names.push(name)
      seen.add(name)
    }
    cursor = close + 1
  }
  return names
}

function requireTimestamp(value: unknown, status: number): string {
  const text = requireStoredText(value, status)
  const date = new Date(text)
  if (
    !CANONICAL_ISO_INSTANT_RE.test(text)
    || Number.isNaN(date.getTime())
    || date.toISOString() !== text
  ) failShape(status)
  return text
}

function requireVersion(value: unknown, status: number): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 1
    || value > 2_147_483_647
  ) failShape(status)
  return value
}

function requireBackgroundUrl(value: unknown, status: number): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > MAX_BACKGROUND_URL) failShape(status)
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:'
      || url.username !== ''
      || url.password !== ''
      || url.hash !== ''
      || url.toString() !== value
    ) failShape(status)
    return value
  } catch (error) {
    if (error instanceof ElearningApiError) throw error
    failShape(status)
  }
}

function requireInputBackgroundUrl(value: string | null): string | null {
  if (value === null) return null
  const text = value.trim()
  if (text === '' || text.length > MAX_BACKGROUND_URL) fail('invalid_input', 400)
  try {
    const url = new URL(text)
    if (
      url.protocol !== 'https:'
      || url.username !== ''
      || url.password !== ''
      || url.hash !== ''
      || url.toString() !== text
    ) fail('invalid_input', 400)
    return text
  } catch (error) {
    if (error instanceof ElearningApiError) throw error
    fail('invalid_input', 400)
  }
}

function parsePlaceholders(value: unknown, status: number): string[] {
  if (!Array.isArray(value) || value.length > MAX_PARAMETERS) failShape(status)
  const result = value.map((item) => requireStoredText(item, status))
  if (new Set(result).size !== result.length) failShape(status)
  return result
}

function parseParameters(value: unknown, status: number): Record<string, string> {
  if (!isPlainObject(value)) failShape(status)
  const keys = Object.keys(value).sort()
  if (keys.length > MAX_PARAMETERS) failShape(status)
  const result = Object.create(null) as Record<string, string>
  for (const key of keys) {
    if (key === '' || key !== key.trim()) failShape(status)
    Object.defineProperty(result, key, {
      enumerable: true,
      value: requireStoredText(value[key], status),
    })
  }
  return result
}

function normalizeInputParameters(value: Record<string, string>): Record<string, string> {
  if (!isPlainObject(value)) fail('invalid_input', 400)
  const keys = Object.keys(value).sort()
  if (keys.length > MAX_PARAMETERS) fail('invalid_input', 400)
  const result = Object.create(null) as Record<string, string>
  for (const key of keys) {
    if (
      key === ''
      || key !== key.trim()
      || key.length > 128
      || /[\0\ud800-\udfff]/u.test(key)
    ) fail('invalid_input', 400)
    Object.defineProperty(result, key, {
      enumerable: true,
      value: requireInputText(value[key] ?? '', 2_048),
    })
  }
  return result
}

function parseTemplate(value: unknown, status: number): ElearningCertificateTemplate {
  if (!isPlainObject(value) || !exactKeys(value, [
    'certificateId',
    'revisionId',
    'version',
    'name',
    'templateText',
    'backgroundImageUrl',
    'placeholders',
    'createdAt',
  ])) failShape(status)
  const templateText = typeof value.templateText === 'string'
    ? value.templateText
    : failShape(status)
  if (templateText.length > MAX_TEMPLATE) failShape(status)
  const placeholders = parsePlaceholders(value.placeholders, status)
  let expectedPlaceholders: string[]
  try {
    expectedPlaceholders = parseTemplatePlaceholderNames(templateText)
  } catch {
    failShape(status)
  }
  if (
    placeholders.length !== expectedPlaceholders.length
    || placeholders.some((name, index) => name !== expectedPlaceholders[index])
  ) failShape(status)
  return {
    certificateId: requireStoredText(value.certificateId, status),
    revisionId: requireUuid(value.revisionId, status),
    version: requireVersion(value.version, status),
    name: requireStoredText(value.name, status),
    templateText,
    backgroundImageUrl: requireBackgroundUrl(value.backgroundImageUrl, status),
    placeholders,
    createdAt: requireTimestamp(value.createdAt, status),
  }
}

function parseIssue(value: unknown, status: number): ElearningCertificateIssue {
  if (!isPlainObject(value) || !exactKeys(value, [
    'issueId',
    'certificateId',
    'templateRevisionId',
    'templateName',
    'serialNumber',
    'parameters',
    'backgroundImageUrl',
    'issuedAt',
  ])) failShape(status)
  return {
    issueId: requireUuid(value.issueId, status),
    certificateId: requireStoredText(value.certificateId, status),
    templateRevisionId: requireUuid(value.templateRevisionId, status),
    templateName: requireStoredText(value.templateName, status),
    serialNumber: requireUuid(value.serialNumber, status),
    parameters: parseParameters(value.parameters, status),
    backgroundImageUrl: requireBackgroundUrl(value.backgroundImageUrl, status),
    issuedAt: requireTimestamp(value.issuedAt, status),
  }
}

function readErrorCode(payload: unknown): string {
  if (!isPlainObject(payload) || typeof payload.error !== 'string') return 'request_failed'
  const code = payload.error.trim()
  if (code === 'ORG_CONTEXT_REQUIRED') return code
  return STABLE_ERROR_CODE_RE.test(code) ? code : 'request_failed'
}

async function requestJson(path: string, init: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await apiFetch(path, init)
  } catch {
    fail('network_error', 0)
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }
  if (response.status !== 200) fail(readErrorCode(payload), response.status)
  return payload
}

export async function listElearningCertificateTemplates(): Promise<ElearningCertificateTemplate[]> {
  const payload = await requestJson('/api/elearning/admin/certificate-templates', {
    method: 'GET',
  })
  if (!isPlainObject(payload) || !exactKeys(payload, ['items']) || !Array.isArray(payload.items)) {
    failShape(200)
  }
  return payload.items.map((item) => parseTemplate(item, 200))
}

export async function publishElearningCertificateTemplate(
  input: ElearningCertificateTemplatePublishInput,
): Promise<ElearningCertificateTemplate> {
  return parseTemplate(await requestJson('/api/elearning/admin/certificate-templates', {
    method: 'POST',
    body: JSON.stringify({
      requestId: requireInputUuid(input.requestId),
      certificateId: requireInputText(input.certificateId),
      name: requireInputText(input.name),
      templateText: requireTemplateText(input.templateText),
      backgroundImageUrl: requireInputBackgroundUrl(input.backgroundImageUrl),
    }),
  }), 200)
}

export async function issueElearningCertificate(
  input: ElearningCertificateIssueInput,
): Promise<ElearningCertificateIssue> {
  const parameters = normalizeInputParameters(input.parameters)
  return parseIssue(await requestJson('/api/elearning/admin/certificate-issues', {
    method: 'POST',
    body: JSON.stringify({
      requestId: requireInputUuid(input.requestId),
      certificateId: requireInputText(input.certificateId),
      userId: requireInputText(input.userId),
      parameters,
    }),
  }), 200)
}

export async function listMyElearningCertificates(): Promise<ElearningCertificateIssue[]> {
  const payload = await requestJson('/api/elearning/certificates', { method: 'GET' })
  if (!isPlainObject(payload) || !exactKeys(payload, ['items']) || !Array.isArray(payload.items)) {
    failShape(200)
  }
  return payload.items.map((item) => parseIssue(item, 200))
}
