import { apiFetch } from '../utils/api'
import { ElearningApiError } from './elearning'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CANONICAL_ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const STABLE_ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,62}$/
const PG_INT4_MAX = 2_147_483_647

export interface ElearningPortalNavigationItem {
  label: string
  href: string
}

export interface ElearningPortalSettings {
  revisionId: string | null
  version: number
  siteName: string | null
  tagline: string | null
  bannerUrl: string | null
  navigation: ElearningPortalNavigationItem[]
  createdAt: string | null
}

export interface ElearningPortalPublishInput {
  requestId: string
  siteName: string
  tagline: string | null
  bannerUrl: string | null
  navigation: ElearningPortalNavigationItem[]
}

export interface ElearningPortalPublishResult extends ElearningPortalSettings {
  duplicate: boolean
}

export interface ElearningPortalRequestIdTracker {
  forPublish(input: Omit<ElearningPortalPublishInput, 'requestId'>): string
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

function requireText(value: unknown, status: number, max: number): string {
  if (
    typeof value !== 'string'
    || value.trim() !== value
    || value === ''
    || value.length > max
    || value.includes('\0')
  ) failShape(status)
  return value
}

function normalizeText(value: string, max: number, nullable = false): string | null {
  const text = value.trim()
  if (nullable && text === '') return null
  if (text === '' || text.length > max || text.includes('\0')) fail('invalid_input', 400)
  return text
}

function requireCanonicalTimestamp(value: unknown, status: number): string {
  const text = requireText(value, status, 64)
  const date = new Date(text)
  if (
    !CANONICAL_ISO_INSTANT_RE.test(text)
    || Number.isNaN(date.getTime())
    || date.toISOString() !== text
  ) failShape(status)
  return text
}

function requireInt(value: unknown, status: number, min: number): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < min
    || value > PG_INT4_MAX
  ) failShape(status)
  return value
}

function internalHref(value: unknown, status: number): string {
  const href = requireText(value, status, 512)
  if (!/^\/(?!\/)[^\s\\]*$/.test(href)) failShape(status)
  return href
}

function inputInternalHref(value: string): string {
  const href = value.trim()
  if (href.length > 512 || !/^\/(?!\/)[^\s\\]*$/.test(href)) fail('invalid_input', 400)
  return href
}

function canonicalBanner(value: unknown, status: number): string | null {
  if (value === null) return null
  const candidate = requireText(value, status, 512)
  if (/^\/(?!\/)[^\s\\]*$/.test(candidate)) return candidate
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    failShape(status)
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.href !== candidate
  ) failShape(status)
  return candidate
}

function inputBanner(value: string | null): string | null {
  const candidate = value === null ? null : normalizeText(value, 512, true)
  if (candidate === null) return null
  try {
    return canonicalBanner(candidate, 400)
  } catch {
    fail('invalid_input', 400)
  }
}

function parseNavigation(value: unknown, status: number): ElearningPortalNavigationItem[] {
  if (!Array.isArray(value) || value.length > 8) failShape(status)
  const seen = new Set<string>()
  return value.map((candidate) => {
    if (!isPlainObject(candidate) || !exactKeys(candidate, ['label', 'href'])) failShape(status)
    const item = {
      label: requireText(candidate.label, status, 40),
      href: internalHref(candidate.href, status),
    }
    if (seen.has(item.href)) failShape(status)
    seen.add(item.href)
    return item
  })
}

function normalizePublishInput(
  input: Omit<ElearningPortalPublishInput, 'requestId'>,
): Omit<ElearningPortalPublishInput, 'requestId'> {
  if (!isPlainObject(input) || !exactKeys(input, [
    'siteName', 'tagline', 'bannerUrl', 'navigation',
  ]) || !Array.isArray(input.navigation) || input.navigation.length > 8) {
    fail('invalid_input', 400)
  }
  const seen = new Set<string>()
  const navigation = input.navigation.map((candidate) => {
    if (!isPlainObject(candidate) || !exactKeys(candidate, ['label', 'href'])) {
      fail('invalid_input', 400)
    }
    const href = inputInternalHref(candidate.href)
    if (seen.has(href)) fail('invalid_input', 400)
    seen.add(href)
    return {
      label: normalizeText(candidate.label, 40) as string,
      href,
    }
  })
  return {
    siteName: normalizeText(input.siteName, 80) as string,
    tagline: input.tagline === null ? null : normalizeText(input.tagline, 160, true),
    bannerUrl: inputBanner(input.bannerUrl),
    navigation,
  }
}

function parseSettings(
  value: unknown,
  status: number,
  withDuplicate: boolean,
): ElearningPortalSettings | ElearningPortalPublishResult {
  const keys = [
    'revisionId', 'version', 'siteName', 'tagline', 'bannerUrl', 'navigation', 'createdAt',
  ]
  if (withDuplicate) keys.push('duplicate')
  if (!isPlainObject(value) || !exactKeys(value, keys)) failShape(status)
  const revisionId = value.revisionId === null ? null : requireUuid(value.revisionId, status)
  const version = requireInt(value.version, status, 0)
  const siteName = value.siteName === null ? null : requireText(value.siteName, status, 80)
  const tagline = value.tagline === null ? null : requireText(value.tagline, status, 160)
  const bannerUrl = canonicalBanner(value.bannerUrl, status)
  const navigation = parseNavigation(value.navigation, status)
  const createdAt = value.createdAt === null
    ? null
    : requireCanonicalTimestamp(value.createdAt, status)
  if (revisionId === null) {
    if (
      version !== 0 || siteName !== null || tagline !== null || bannerUrl !== null
      || navigation.length !== 0 || createdAt !== null
    ) failShape(status)
  } else if (version < 1 || siteName === null || createdAt === null) {
    failShape(status)
  }
  const settings = {
    revisionId,
    version,
    siteName,
    tagline,
    bannerUrl,
    navigation,
    createdAt,
  }
  if (!withDuplicate) return settings
  if (typeof value.duplicate !== 'boolean') failShape(status)
  return { ...settings, duplicate: value.duplicate }
}

function readErrorCode(payload: unknown): string {
  if (!isPlainObject(payload) || typeof payload.error !== 'string') return 'request_failed'
  const code = payload.error.trim()
  if (code === 'ORG_CONTEXT_REQUIRED') return code
  return STABLE_ERROR_CODE_RE.test(code) ? code : 'request_failed'
}

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
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

export async function getElearningPortalSettings(): Promise<ElearningPortalSettings> {
  return parseSettings(
    await requestJson('/api/elearning/portal'),
    200,
    false,
  ) as ElearningPortalSettings
}

export async function publishElearningPortalSettings(
  input: ElearningPortalPublishInput,
): Promise<ElearningPortalPublishResult> {
  if (!isPlainObject(input) || !exactKeys(input, [
    'requestId', 'siteName', 'tagline', 'bannerUrl', 'navigation',
  ])) fail('invalid_input', 400)
  const requestId = requireInputUuid(input.requestId)
  const normalized = normalizePublishInput({
    siteName: input.siteName,
    tagline: input.tagline,
    bannerUrl: input.bannerUrl,
    navigation: input.navigation,
  })
  return parseSettings(
    await requestJson('/api/elearning/admin/portal', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, ...normalized }),
    }),
    200,
    true,
  ) as ElearningPortalPublishResult
}

function defaultRequestId(): string {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    fail('request_failed', 0)
  }
  return crypto.randomUUID()
}

export function createElearningPortalRequestIdTracker(
  generate: () => string = defaultRequestId,
): ElearningPortalRequestIdTracker {
  let current: { fingerprint: string; requestId: string } | null = null
  return {
    forPublish(input) {
      const normalized = normalizePublishInput(input)
      const fingerprint = JSON.stringify(normalized)
      if (current?.fingerprint === fingerprint) return current.requestId
      const requestId = requireInputUuid(generate())
      current = { fingerprint, requestId }
      return requestId
    },
  }
}
