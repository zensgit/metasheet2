import { apiFetch } from '../utils/api'
import { ElearningApiError } from './elearning'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256_RE = /^[a-f0-9]{64}$/
const STABLE_ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,62}$/
const CANONICAL_ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export type ElearningContentItemType = 'article' | 'external_link'

export interface ElearningContentRevisionDraft {
  itemType: ElearningContentItemType
  title: string
  articleHtml: string | null
  externalUrl: string | null
}

export interface ElearningContentRevisionRequest extends ElearningContentRevisionDraft {
  requestId: string
}

export interface ElearningContentRevisionResult extends ElearningContentRevisionDraft {
  contentRevisionId: string
  contentDigest: string
}

export interface ElearningContentPublishItem {
  itemType: ElearningContentItemType
  contentRevisionId: string
}

export interface ElearningContentPublishRequest {
  requestId: string
  title: string
  items: ElearningContentPublishItem[]
}

export interface ElearningContentPublishedItem extends ElearningContentPublishItem {
  itemId: string
  position: number
}

export interface ElearningContentPublishResult {
  courseId: string
  courseVersionId: string
  status: 'published'
  itemCount: number
  items: ElearningContentPublishedItem[]
}

export interface ElearningContentOpenResult extends ElearningContentRevisionDraft {
  itemId: string
  status: 'completed'
  completedAt: string
  assurance: 'weak_server_recorded_open' | 'weak_server_recorded_launch'
}

export interface ElearningContentRequestIdTracker {
  forRevision(slotId: string, draft: ElearningContentRevisionDraft): string
  forPublish(input: Omit<ElearningContentPublishRequest, 'requestId'>): string
  forOpen(itemId: string): string
}

function fail(code: string, status: number): never {
  throw new ElearningApiError(code, status)
}

function failInput(): never {
  fail('invalid_input', 400)
}

function failShape(status: number): never {
  fail('invalid_response', status)
}

function failForStatus(status: number): never {
  if (status === 400) failInput()
  failShape(status)
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
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    failForStatus(status)
  }
  return value.toLowerCase()
}

function requireText(value: unknown, status: number, max: number): string {
  if (
    typeof value !== 'string'
    || value.trim() === ''
    || value.length > max
    || value.includes('\0')
  ) {
    failForStatus(status)
  }
  return value
}

function requireItemType(value: unknown, status: number): ElearningContentItemType {
  if (value !== 'article' && value !== 'external_link') {
    failForStatus(status)
  }
  return value
}

function requireHttpsUrl(value: unknown, status: number): string {
  const source = requireText(value, status, 2_048)
  let url: URL
  try {
    url = new URL(source)
  } catch {
    failForStatus(status)
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    failForStatus(status)
  }
  return source
}

function validateRevisionDraft(
  value: ElearningContentRevisionDraft,
  status: number,
): ElearningContentRevisionDraft {
  if (!isPlainObject(value) || !exactKeys(value, [
    'itemType',
    'title',
    'articleHtml',
    'externalUrl',
  ])) {
    failForStatus(status)
  }
  const itemType = requireItemType(value.itemType, status)
  const title = requireText(value.title, status, 200)
  if (itemType === 'article') {
    if (value.externalUrl !== null) failForStatus(status)
    return {
      itemType,
      title,
      articleHtml: requireText(value.articleHtml, status, 1_000_000),
      externalUrl: null,
    }
  }
  if (value.articleHtml !== null) failForStatus(status)
  return {
    itemType,
    title,
    articleHtml: null,
    externalUrl: requireHttpsUrl(value.externalUrl, status),
  }
}

function readErrorCode(payload: unknown): string {
  if (isPlainObject(payload) && typeof payload.error === 'string') {
    const code = payload.error.trim()
    if (STABLE_ERROR_CODE_RE.test(code)) return code
  }
  return 'request_failed'
}

async function requestJson(
  path: string,
  expectedStatus: number,
  body: Record<string, unknown>,
): Promise<unknown> {
  let response: Response
  try {
    response = await apiFetch(path, {
      method: 'POST',
      body: JSON.stringify(body),
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
  if (response.status !== expectedStatus) fail(readErrorCode(payload), response.status)
  return payload
}

function parseRevision(value: unknown, status: number): ElearningContentRevisionResult {
  if (!isPlainObject(value) || !exactKeys(value, [
    'articleHtml',
    'contentDigest',
    'contentRevisionId',
    'externalUrl',
    'itemType',
    'title',
  ])) failShape(status)
  const revision = validateRevisionDraft({
    itemType: value.itemType as ElearningContentItemType,
    title: value.title as string,
    articleHtml: value.articleHtml as string | null,
    externalUrl: value.externalUrl as string | null,
  }, status)
  if (typeof value.contentDigest !== 'string' || !SHA256_RE.test(value.contentDigest)) {
    failShape(status)
  }
  return {
    ...revision,
    contentRevisionId: requireUuid(value.contentRevisionId, status),
    contentDigest: value.contentDigest,
  }
}

function parsePublishedItem(value: unknown, status: number): ElearningContentPublishedItem {
  if (!isPlainObject(value) || !exactKeys(value, [
    'itemId',
    'itemType',
    'contentRevisionId',
    'position',
  ])) failShape(status)
  if (typeof value.position !== 'number' || !Number.isSafeInteger(value.position) || value.position < 1) {
    failShape(status)
  }
  return {
    itemId: requireUuid(value.itemId, status),
    itemType: requireItemType(value.itemType, status),
    contentRevisionId: requireUuid(value.contentRevisionId, status),
    position: value.position,
  }
}

function parsePublish(value: unknown, status: number): ElearningContentPublishResult {
  if (!isPlainObject(value) || !exactKeys(value, [
    'courseId',
    'courseVersionId',
    'status',
    'itemCount',
    'items',
  ])) failShape(status)
  if (value.status !== 'published' || !Array.isArray(value.items) || value.items.length < 1) {
    failShape(status)
  }
  const items = value.items.map((item) => parsePublishedItem(item, status))
  if (
    value.itemCount !== items.length
    || items.some((item, index) => item.position !== index + 1)
    || new Set(items.map((item) => item.itemId)).size !== items.length
    || new Set(items.map((item) => item.contentRevisionId)).size !== items.length
  ) failShape(status)
  return {
    courseId: requireUuid(value.courseId, status),
    courseVersionId: requireUuid(value.courseVersionId, status),
    status: 'published',
    itemCount: items.length,
    items,
  }
}

function parseOpen(value: unknown, status: number): ElearningContentOpenResult {
  if (!isPlainObject(value) || !exactKeys(value, [
    'itemId',
    'itemType',
    'title',
    'articleHtml',
    'externalUrl',
    'status',
    'completedAt',
    'assurance',
  ])) failShape(status)
  if (value.status !== 'completed') failShape(status)
  const revision = validateRevisionDraft({
    itemType: value.itemType as ElearningContentItemType,
    title: value.title as string,
    articleHtml: value.articleHtml as string | null,
    externalUrl: value.externalUrl as string | null,
  }, status)
  const expectedAssurance = revision.itemType === 'article'
    ? 'weak_server_recorded_open'
    : 'weak_server_recorded_launch'
  if (value.assurance !== expectedAssurance) failShape(status)
  const completedAt = requireText(value.completedAt, status, 64)
  const completedDate = new Date(completedAt)
  if (
    !CANONICAL_ISO_INSTANT_RE.test(completedAt)
    || Number.isNaN(completedDate.getTime())
    || completedDate.toISOString() !== completedAt
  ) failShape(status)
  return {
    ...revision,
    itemId: requireUuid(value.itemId, status),
    status: 'completed',
    completedAt,
    assurance: expectedAssurance,
  }
}

export async function createElearningContentRevision(
  input: ElearningContentRevisionRequest,
): Promise<ElearningContentRevisionResult> {
  if (!isPlainObject(input) || !exactKeys(input, [
    'requestId',
    'itemType',
    'title',
    'articleHtml',
    'externalUrl',
  ])) failInput()
  const requestId = requireUuid(input.requestId, 400)
  const revision = validateRevisionDraft({
    itemType: input.itemType,
    title: input.title,
    articleHtml: input.articleHtml,
    externalUrl: input.externalUrl,
  }, 400)
  const payload = await requestJson('/api/elearning/admin/content-revisions', 201, {
    requestId,
    ...revision,
  })
  return parseRevision(payload, 201)
}

export async function publishElearningContentCourse(
  input: ElearningContentPublishRequest,
): Promise<ElearningContentPublishResult> {
  if (!isPlainObject(input) || !exactKeys(input, ['requestId', 'title', 'items'])) failInput()
  const requestId = requireUuid(input.requestId, 400)
  const title = requireText(input.title, 400, 200)
  if (!Array.isArray(input.items) || input.items.length < 1) failInput()
  const items = input.items.map((item) => {
    if (!isPlainObject(item) || !exactKeys(item, ['itemType', 'contentRevisionId'])) failInput()
    return {
      itemType: requireItemType(item.itemType, 400),
      contentRevisionId: requireUuid(item.contentRevisionId, 400),
    }
  })
  if (new Set(items.map((item) => item.contentRevisionId)).size !== items.length) failInput()
  const payload = await requestJson('/api/elearning/admin/courses/content/publish', 201, {
    requestId,
    title,
    items,
  })
  return parsePublish(payload, 201)
}

export async function openElearningContentItem(
  itemId: string,
  requestId: string,
): Promise<ElearningContentOpenResult> {
  const canonicalItemId = requireUuid(itemId, 400)
  const canonicalRequestId = requireUuid(requestId, 400)
  const payload = await requestJson(
    `/api/elearning/me/course-items/${encodeURIComponent(canonicalItemId)}/open`,
    200,
    { requestId: canonicalRequestId },
  )
  const result = parseOpen(payload, 200)
  if (result.itemId !== canonicalItemId) failShape(200)
  return result
}

function defaultRequestId(): string {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    fail('request_failed', 0)
  }
  return crypto.randomUUID()
}

export function createElearningContentRequestIdTracker(
  generate: () => string = defaultRequestId,
): ElearningContentRequestIdTracker {
  const slots = new Map<string, { fingerprint: string; requestId: string }>()
  const idFor = (slot: string, fingerprint: string): string => {
    const existing = slots.get(slot)
    if (existing?.fingerprint === fingerprint) return existing.requestId
    const requestId = requireUuid(generate(), 400)
    slots.set(slot, { fingerprint, requestId })
    return requestId
  }
  return {
    forRevision(slotId, draft) {
      if (slotId.trim() === '') failInput()
      return idFor(`revision:${slotId}`, JSON.stringify([
        draft.itemType,
        draft.title,
        draft.articleHtml,
        draft.externalUrl,
      ]))
    },
    forPublish(input) {
      return idFor('publish', JSON.stringify([
        input.title,
        input.items.map((item) => [item.itemType, item.contentRevisionId]),
      ]))
    },
    forOpen(itemId) {
      const canonicalItemId = requireUuid(itemId, 400)
      return idFor(`open:${canonicalItemId}`, canonicalItemId)
    },
  }
}
