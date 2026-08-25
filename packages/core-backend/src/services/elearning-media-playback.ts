/**
 * V0.1 protected playback: short-lived HMAC ticket + server-side recheck.
 * Single HTTP byte range only. Storage keys never enter tokens or public results.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  assertElearningMediaByteRange,
  assertElearningMediaStorageKey,
  ELEARNING_MEDIA_RANGE_MAX_BYTES,
} from './elearning-media-storage'
import {
  ElearningCourseAccessError,
  resolveElearningCourseAccess,
} from './elearning-course-access'

export const ELEARNING_MEDIA_PLAYBACK_TOKEN_VERSION = 1 as const
export const ELEARNING_MEDIA_PLAYBACK_TYP = 'elearning.media.playback' as const
export const ELEARNING_MEDIA_PLAYBACK_TTL_MAX_SECONDS = 600 as const
export const ELEARNING_MEDIA_PLAYBACK_SECRET_ENV = 'ELEARNING_MEDIA_PLAYBACK_SIGNING_SECRET' as const
export const ELEARNING_MEDIA_PLAYBACK_SECRET_MIN_LENGTH = 32 as const

export const ELEARNING_MEDIA_PLAYBACK_CLAIM_KEYS = [
  'v',
  'typ',
  'org',
  'sub',
  'item',
  'media',
  'jti',
  'iat',
  'exp',
] as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_CANON_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

const WEAK_PLAYBACK_SECRETS = new Set([
  'test',
  'dev-secret',
  'dev-secret-key',
  'fallback-development-secret-change-in-production',
  'change-me',
  'change-me-in-production',
  'your-secret-key-here',
  'your-dev-secret-key-here',
])

export type ElearningPlaybackErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'assignment_unavailable'
  | 'course_withdrawn'
  | 'unsupported_item'
  | 'unavailable'
  | 'invalid_token'
  | 'token_expired'
  | 'invalid_range'
  | 'unsatisfiable_range'

export class ElearningPlaybackError extends Error {
  constructor(readonly code: ElearningPlaybackErrorCode) {
    super(code)
    this.name = 'ElearningPlaybackError'
  }
}

export interface ElearningPlaybackQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningPlaybackDb extends ElearningPlaybackQueryable {
  transaction<T>(
    handler: (tx: ElearningPlaybackQueryable) => Promise<T>,
  ): Promise<T>
}

export interface ElearningMediaPlaybackClaims {
  v: typeof ELEARNING_MEDIA_PLAYBACK_TOKEN_VERSION
  typ: typeof ELEARNING_MEDIA_PLAYBACK_TYP
  org: string
  sub: string
  item: string
  media: string
  jti: string
  iat: number
  exp: number
}

export interface ElearningMediaPlaybackTicket {
  token: string
  expiresAt: string
  ttlSeconds: number
  itemId: string
  mediaId: string
}

export interface ElearningPlaybackByteRange {
  start: number
  end: number
  size: number
  length: number
  complete: boolean
  absent: boolean
  httpStatus: 200 | 206
  contentRange: string | null
}

export interface ElearningMediaPlaybackAuthorization {
  storageKey: string
  mimeType: string
  sizeBytes: number
  range: ElearningPlaybackByteRange
}

export interface IssueElearningMediaPlaybackInput {
  orgId: string
  userId: string
  itemId: string
  playbackSigningSecret: unknown
  jwtSecret?: unknown
  ttlSeconds?: number
  now?: Date
}

export interface AuthorizeElearningMediaPlaybackInput {
  token: unknown
  orgId: string
  userId: string
  rangeHeader?: unknown
  playbackSigningSecret: unknown
  jwtSecret?: unknown
  now?: Date
}

function fail(code: ElearningPlaybackErrorCode): never {
  throw new ElearningPlaybackError(code)
}

function requireActor(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_input')
  const trimmed = value.trim()
  if (trimmed === '') fail('invalid_input')
  return trimmed
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value
}

function asSafeInt(value: unknown): number | null {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null
    return Number(value)
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null
    return value
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (!/^\d+$/.test(text)) return null
    const parsed = Number(text)
    if (!Number.isSafeInteger(parsed)) return null
    return parsed
  }
  return null
}

function unixSeconds(now: Date): number {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) fail('invalid_input')
  const seconds = Math.floor(now.getTime() / 1000)
  if (!Number.isSafeInteger(seconds) || seconds < 0) fail('invalid_input')
  return seconds
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  if (a.length !== b.length) {
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

function timingSafeBufferEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) {
    timingSafeEqual(left, left)
    return false
  }
  return timingSafeEqual(left, right)
}

export function requireElearningMediaPlaybackSigningSecret(
  playbackSigningSecret: unknown,
  jwtSecret?: unknown,
): string {
  if (typeof playbackSigningSecret !== 'string') fail('unavailable')
  const secret = playbackSigningSecret.trim()
  if (secret.length < ELEARNING_MEDIA_PLAYBACK_SECRET_MIN_LENGTH) fail('unavailable')
  if (WEAK_PLAYBACK_SECRETS.has(secret)) fail('unavailable')
  if (typeof jwtSecret === 'string') {
    const jwt = jwtSecret.trim()
    if (jwt !== '' && timingSafeStringEqual(secret, jwt)) fail('unavailable')
  }
  return secret
}

export function readElearningMediaPlaybackSigningSecret(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return requireElearningMediaPlaybackSigningSecret(
    env[ELEARNING_MEDIA_PLAYBACK_SECRET_ENV],
    env.JWT_SECRET,
  )
}

function serializePlaybackClaims(claims: ElearningMediaPlaybackClaims): string {
  return JSON.stringify({
    v: claims.v,
    typ: claims.typ,
    org: claims.org,
    sub: claims.sub,
    item: claims.item,
    media: claims.media,
    jti: claims.jti,
    iat: claims.iat,
    exp: claims.exp,
  })
}

function decodeBase64Url(text: string): Buffer | null {
  if (!BASE64URL_RE.test(text)) return null
  const buf = Buffer.from(text, 'base64url')
  if (buf.length === 0 || buf.toString('base64url') !== text) return null
  return buf
}

function signPayload(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64, 'ascii').digest().toString('base64url')
}

export function signElearningMediaPlaybackToken(
  claims: ElearningMediaPlaybackClaims,
  playbackSigningSecret: unknown,
  jwtSecret?: unknown,
): string {
  const secret = requireElearningMediaPlaybackSigningSecret(
    playbackSigningSecret,
    jwtSecret,
  )
  const payloadB64 = Buffer.from(
    serializePlaybackClaims(claims),
    'utf8',
  ).toString('base64url')
  return `${payloadB64}.${signPayload(payloadB64, secret)}`
}

function parseExactClaims(payloadUtf8: string): ElearningMediaPlaybackClaims {
  let parsed: unknown
  try {
    parsed = JSON.parse(payloadUtf8)
  } catch {
    fail('invalid_token')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('invalid_token')
  const row = parsed as Record<string, unknown>
  const keys = Object.keys(row)
  if (keys.length !== ELEARNING_MEDIA_PLAYBACK_CLAIM_KEYS.length) fail('invalid_token')
  for (let i = 0; i < ELEARNING_MEDIA_PLAYBACK_CLAIM_KEYS.length; i += 1) {
    if (keys[i] !== ELEARNING_MEDIA_PLAYBACK_CLAIM_KEYS[i]) fail('invalid_token')
  }
  if (row.v !== ELEARNING_MEDIA_PLAYBACK_TOKEN_VERSION) fail('invalid_token')
  if (row.typ !== ELEARNING_MEDIA_PLAYBACK_TYP) fail('invalid_token')
  const org = asText(row.org)
  const sub = asText(row.sub)
  const item = asText(row.item)
  const media = asText(row.media)
  const jti = asText(row.jti)
  const iat = asSafeInt(row.iat)
  const exp = asSafeInt(row.exp)
  if (!org || org.trim() !== org || org === '') fail('invalid_token')
  if (!sub || sub.trim() !== sub || sub === '') fail('invalid_token')
  if (!item || !UUID_CANON_RE.test(item) || !media || !UUID_CANON_RE.test(media) || !jti || !UUID_CANON_RE.test(jti)) {
    fail('invalid_token')
  }
  if (iat === null || exp === null || iat < 0 || exp <= iat) fail('invalid_token')
  const ttl = exp - iat
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > ELEARNING_MEDIA_PLAYBACK_TTL_MAX_SECONDS) {
    fail('invalid_token')
  }
  const claims: ElearningMediaPlaybackClaims = {
    v: ELEARNING_MEDIA_PLAYBACK_TOKEN_VERSION,
    typ: ELEARNING_MEDIA_PLAYBACK_TYP,
    org,
    sub,
    item,
    media,
    jti,
    iat,
    exp,
  }
  if (serializePlaybackClaims(claims) !== payloadUtf8) fail('invalid_token')
  return claims
}

export function verifyElearningMediaPlaybackToken(
  token: unknown,
  playbackSigningSecret: unknown,
  jwtSecret?: unknown,
  now: Date = new Date(),
): ElearningMediaPlaybackClaims {
  const secret = requireElearningMediaPlaybackSigningSecret(
    playbackSigningSecret,
    jwtSecret,
  )
  if (typeof token !== 'string' || token.trim() === '') fail('invalid_input')
  const parts = token.split('.')
  if (parts.length !== 2) fail('invalid_token')
  const payloadB64 = parts[0]
  const signatureB64 = parts[1]
  const payloadBuf = decodeBase64Url(payloadB64)
  const signatureBuf = decodeBase64Url(signatureB64)
  const expected = createHmac('sha256', secret).update(payloadB64, 'ascii').digest()
  if (!payloadBuf || !signatureBuf || !timingSafeBufferEqual(expected, signatureBuf)) {
    fail('invalid_token')
  }
  const claims = parseExactClaims(payloadBuf.toString('utf8'))
  const nowSec = unixSeconds(now)
  if (nowSec < claims.iat) fail('invalid_token')
  if (nowSec >= claims.exp) fail('token_expired')
  return claims
}

function parseBytePos(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null
  if (raw.length > 1 && raw.startsWith('0')) return null
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0 || String(value) !== raw) return null
  return value
}

function capAuthorizedSpan(
  start: number,
  end: number,
  fromSuffix: boolean,
): { start: number; end: number } {
  const span = end - start + 1
  if (!Number.isSafeInteger(span) || span <= ELEARNING_MEDIA_RANGE_MAX_BYTES) {
    return { start, end }
  }
  if (fromSuffix) {
    return { start: end - ELEARNING_MEDIA_RANGE_MAX_BYTES + 1, end }
  }
  return { start, end: start + ELEARNING_MEDIA_RANGE_MAX_BYTES - 1 }
}

function toAuthorizedRange(
  start: number,
  end: number,
  size: number,
  absent: boolean,
): ElearningPlaybackByteRange {
  const range = assertElearningMediaByteRange(start, end)
  const length = range.end - range.start + 1
  if (length > ELEARNING_MEDIA_RANGE_MAX_BYTES) fail('invalid_range')
  const complete = range.start === 0 && range.end === size - 1
  const httpStatus: 200 | 206 = absent && complete ? 200 : 206
  return {
    start: range.start,
    end: range.end,
    size,
    length,
    complete,
    absent,
    httpStatus,
    contentRange: httpStatus === 206 ? `bytes ${range.start}-${range.end}/${size}` : null,
  }
}

export function parseElearningMediaHttpByteRange(
  rangeHeader: unknown,
  sizeBytes: number,
): ElearningPlaybackByteRange {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) fail('invalid_input')
  if (rangeHeader === undefined || rangeHeader === null) {
    const end = Math.min(sizeBytes - 1, ELEARNING_MEDIA_RANGE_MAX_BYTES - 1)
    return toAuthorizedRange(0, end, sizeBytes, true)
  }
  if (typeof rangeHeader !== 'string') fail('invalid_range')
  const header = rangeHeader.trim()
  if (header === '' || header.includes(',')) fail('invalid_range')
  const match = /^bytes=(?:(\d+)-(\d+)?|-(\d+))$/.exec(header)
  if (!match) fail('invalid_range')

  let start: number
  let end: number
  let fromSuffix = false
  if (match[3] !== undefined) {
    const suffix = parseBytePos(match[3])
    if (suffix === null) fail('invalid_range')
    if (suffix === 0) fail('unsatisfiable_range')
    fromSuffix = true
    if (suffix >= sizeBytes) {
      start = 0
      end = sizeBytes - 1
    } else {
      start = sizeBytes - suffix
      end = sizeBytes - 1
    }
  } else {
    const parsedStart = parseBytePos(match[1])
    if (parsedStart === null) fail('invalid_range')
    start = parsedStart
    if (match[2] !== undefined) {
      const parsedEnd = parseBytePos(match[2])
      if (parsedEnd === null) fail('invalid_range')
      if (start > parsedEnd) fail('unsatisfiable_range')
      end = parsedEnd
    } else {
      end = sizeBytes - 1
    }
    if (start >= sizeBytes) fail('unsatisfiable_range')
    if (end >= sizeBytes) end = sizeBytes - 1
  }

  const capped = capAuthorizedSpan(start, end, fromSuffix)
  return toAuthorizedRange(capped.start, capped.end, sizeBytes, false)
}

interface PlayableMedia {
  itemId: string
  versionId: string
  mediaId: string
  storageKey: string
  mimeType: string
  sizeBytes: number
}

async function loadPlayableMedia(
  db: ElearningPlaybackQueryable,
  orgId: string,
  itemId: string,
): Promise<PlayableMedia> {
  const result = await db.query(
    `/* elearning-playback:load-item */
     SELECT
       i.id,
       i.course_version_id,
       i.item_type,
       i.media_id,
       v.status AS version_status,
       c.status AS course_status,
       m.status AS media_status,
       m.storage_key,
       m.mime_type,
       m.size_bytes
     FROM elearning_course_version_items i
     JOIN elearning_course_versions v
       ON v.org_id = i.org_id AND v.id = i.course_version_id
     JOIN elearning_courses c
       ON c.org_id = v.org_id AND c.id = v.course_id
     LEFT JOIN elearning_media m
       ON m.org_id = i.org_id AND m.id = i.media_id
     WHERE i.org_id = $1 AND i.id = $2
     FOR SHARE OF i, v, c`,
    [orgId, itemId],
  )
  const row = result.rows[0]
  if (!row) fail('not_found')
  if (asText(row.course_status) === 'withdrawn') fail('course_withdrawn')
  const versionStatus = asText(row.version_status)
  if (versionStatus !== 'published' && versionStatus !== 'retired') fail('unsupported_item')
  if (asText(row.item_type) !== 'video') fail('unsupported_item')
  if (asText(row.media_status) !== 'ready') fail('unsupported_item')
  const loadedId = asText(row.id)
  const versionId = asText(row.course_version_id)
  const mediaId = asText(row.media_id)
  const mimeType = asText(row.mime_type)
  const sizeBytes = asSafeInt(row.size_bytes)
  if (!loadedId || !versionId || !mediaId || !mimeType || mimeType.trim() === '') fail('unavailable')
  if (sizeBytes === null || sizeBytes < 1) fail('unsupported_item')
  const rawKey = asText(row.storage_key)
  if (!rawKey) fail('unavailable')
  let storageKey: string
  try {
    storageKey = assertElearningMediaStorageKey(rawKey)
  } catch {
    fail('unavailable')
  }
  return {
    itemId: loadedId,
    versionId,
    mediaId,
    storageKey,
    mimeType,
    sizeBytes,
  }
}

async function requireCourseAccess(
  db: ElearningPlaybackQueryable,
  orgId: string,
  userId: string,
  versionId: string,
): Promise<void> {
  try {
    await resolveElearningCourseAccess(db, {
      orgId,
      userId,
      courseVersionId: versionId,
    })
  } catch (error) {
    if (!(error instanceof ElearningCourseAccessError)) fail('unavailable')
    if (error.code === 'withdrawn') fail('course_withdrawn')
    if (error.code === 'unsupported_version') fail('unsupported_item')
    if (error.code === 'denied') fail('assignment_unavailable')
    fail('unavailable')
  }
}

export async function issueElearningMediaPlaybackTicket(
  db: ElearningPlaybackDb,
  input: IssueElearningMediaPlaybackInput,
): Promise<ElearningMediaPlaybackTicket> {
  const secret = requireElearningMediaPlaybackSigningSecret(
    input.playbackSigningSecret,
    input.jwtSecret,
  )
  const orgId = requireActor(input.orgId)
  const userId = requireActor(input.userId)
  const itemId = requireUuid(input.itemId)
  const ttlSeconds = input.ttlSeconds === undefined
    ? ELEARNING_MEDIA_PLAYBACK_TTL_MAX_SECONDS
    : input.ttlSeconds
  if (
    typeof ttlSeconds !== 'number'
    || !Number.isSafeInteger(ttlSeconds)
    || ttlSeconds < 1
    || ttlSeconds > ELEARNING_MEDIA_PLAYBACK_TTL_MAX_SECONDS
  ) {
    fail('invalid_input')
  }
  const now = input.now ?? new Date()
  const iat = unixSeconds(now)
  return db.transaction(async (tx) => {
    const playable = await loadPlayableMedia(tx, orgId, itemId)
    await requireCourseAccess(tx, orgId, userId, playable.versionId)
    const claims: ElearningMediaPlaybackClaims = {
      v: ELEARNING_MEDIA_PLAYBACK_TOKEN_VERSION,
      typ: ELEARNING_MEDIA_PLAYBACK_TYP,
      org: orgId,
      sub: userId,
      item: playable.itemId,
      media: playable.mediaId,
      jti: randomUUID(),
      iat,
      exp: iat + ttlSeconds,
    }
    return {
      token: signElearningMediaPlaybackToken(claims, secret, input.jwtSecret),
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      ttlSeconds,
      itemId: playable.itemId,
      mediaId: playable.mediaId,
    }
  })
}

export async function authorizeElearningMediaPlayback(
  db: ElearningPlaybackDb,
  input: AuthorizeElearningMediaPlaybackInput,
): Promise<ElearningMediaPlaybackAuthorization> {
  const orgId = requireActor(input.orgId)
  const userId = requireActor(input.userId)
  const claims = verifyElearningMediaPlaybackToken(
    input.token,
    input.playbackSigningSecret,
    input.jwtSecret,
    input.now ?? new Date(),
  )
  if (!timingSafeStringEqual(claims.org, orgId) || !timingSafeStringEqual(claims.sub, userId)) {
    fail('invalid_token')
  }
  return db.transaction(async (tx) => {
    const playable = await loadPlayableMedia(tx, claims.org, claims.item)
    if (!timingSafeStringEqual(playable.mediaId, claims.media))
      fail('not_found')
    await requireCourseAccess(tx, claims.org, claims.sub, playable.versionId)
    const range = parseElearningMediaHttpByteRange(
      input.rangeHeader,
      playable.sizeBytes,
    )
    return {
      storageKey: playable.storageKey,
      mimeType: playable.mimeType,
      sizeBytes: playable.sizeBytes,
      range,
    }
  })
}
