import crypto from 'node:crypto'
import { verifyEmbedToken, type EmbedTokenClaims } from './embed-token-verify'
import { consumeEmbedJti } from './embed-jti-store'

export interface VisualPreviewDescriptor {
  schema_version: 1
  part_id: string
  file_id: string
  file_version: string
  content_checksum: string
  preview_checksum: string
  page: 0
  preview_width: number
  preview_height: number
  version_is_current: boolean
}

export interface VisualPreviewClaims extends EmbedTokenClaims {
  sub: string
  tenant_id: string
  org_id: string
  feature_key: 'bom_multitable'
  embed_origin: string
  aud: 'metasheet2.visual-preview'
  typ: 'visual_preview'
  jti: string
  iat: number
  exp: number
  embed_jti: string
  embed_iat: number
  file_id: string
  version_id: string
  checksum: string
  preview_checksum: string
  media_type: 'image/png' | 'image/jpeg'
  width: number
  height: number
  page: 0
  version_is_current: boolean
}

export class VisualPreviewTokenError extends Error {}

const SHA256 = /^[a-f0-9]{64}$/
const MAX_PIXELS = 16_000_000

function identifier(value: unknown, max = 128): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value
}

function fail(): never { throw new VisualPreviewTokenError('invalid visual preview capability') }

function sha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value)
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

export function verifyVisualPreviewToken(token: string, options: {
  publicKeysByKid: Record<string, string>
  embed: EmbedTokenClaims
  fileId: string
  versionId: string
  origin: string
  now?: number
}): { claims: VisualPreviewClaims; descriptor: VisualPreviewDescriptor } {
  if (token.length > 16_384) fail()
  const segments = token.split('.')
  if (segments.length !== 3 || segments.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)
    || Buffer.from(part, 'base64url').toString('base64url') !== part)) fail()
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const claims = verifyEmbedToken(token, {
    publicKeysByKid: options.publicKeysByKid, audience: 'metasheet2.visual-preview',
    expectedTyp: 'visual_preview', now,
  })
  const { embed } = options
  for (const key of ['sub', 'tenant_id', 'org_id', 'part_id', 'embed_origin'] as const) {
    if (!identifier(claims[key], key === 'embed_origin' ? 2048 : 128) || claims[key] !== embed[key]) fail()
  }
  const sub = claims.sub
  if (typeof sub !== 'string' || !/^[1-9][0-9]*$/.test(sub) || !Number.isSafeInteger(Number(sub))) fail()
  if (claims.embed_origin !== options.origin || claims.feature_key !== 'bom_multitable' || embed.feature_key !== 'bom_multitable') fail()
  if (!identifier(claims.jti, 64) || !identifier(embed.jti, 64) || claims.embed_jti !== embed.jti || claims.embed_iat !== embed.iat) fail()
  const embedIat = embed.iat
  const embedExp = embed.exp
  const iat = claims.iat
  const exp = claims.exp
  if (!safeInteger(embedIat)) fail()
  if (!safeInteger(embedExp)) fail()
  if (!safeInteger(iat)) fail()
  if (!safeInteger(exp)) fail()
  if (exp <= now || iat > now + 120 || exp <= iat || exp - iat > 120 || exp > embedExp) fail()
  if (!identifier(claims.file_id) || claims.file_id !== options.fileId) fail()
  if (!identifier(claims.version_id) || claims.version_id !== options.versionId) fail()
  if (!sha256(claims.checksum) || !sha256(claims.preview_checksum)) fail()
  if (claims.media_type !== 'image/png' && claims.media_type !== 'image/jpeg') fail()
  if (typeof claims.version_is_current !== 'boolean' || claims.page !== 0) fail()
  const width = claims.width
  const height = claims.height
  if (!safeInteger(width)) fail()
  if (!safeInteger(height)) fail()
  if (width < 1 || height < 1 || width > MAX_PIXELS || height > MAX_PIXELS || width * height > MAX_PIXELS) fail()
  const verified = claims as VisualPreviewClaims
  return { claims: verified, descriptor: {
    schema_version: 1, part_id: verified.part_id, file_id: verified.file_id,
    file_version: verified.version_id, content_checksum: verified.checksum,
    preview_checksum: verified.preview_checksum, page: 0,
    preview_width: verified.width, preview_height: verified.height, version_is_current: verified.version_is_current,
  } }
}

export function visualPreviewJtiKey(claims: VisualPreviewClaims): string {
  const material = JSON.stringify([
    claims.aud, claims.tenant_id, claims.org_id, claims.sub, claims.part_id,
    claims.file_id, claims.version_id, claims.jti,
  ])
  return `plm-visual-preview:jti:${crypto.createHash('sha256').update(material).digest('hex')}`
}

export async function consumeVisualPreviewJti(claims: VisualPreviewClaims): Promise<boolean> {
  const ttl = claims.exp - Math.floor(Date.now() / 1000)
  if (ttl < 1 || ttl > 120) return false
  // Same shared Redis SET EX NX primitive, a separate preview namespace, no memory fallback.
  return consumeEmbedJti(visualPreviewJtiKey(claims), ttl)
}
