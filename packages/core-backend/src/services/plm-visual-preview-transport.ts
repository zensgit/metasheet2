/** Native's existing preview capability protocol, without adapter or service credentials.
 * Callers keep their own source/person admission before minting a capability.
 */
import { createHash } from 'node:crypto'
import { embedPublicKeysByKid } from '../auth/embed-config'
import type { EmbedTokenClaims } from '../auth/embed-token-verify'
import { consumeVisualPreviewJti, verifyVisualPreviewToken, type VisualPreviewDescriptor } from '../auth/visual-preview-token'

export interface VisualPreviewFile { file_id: string; version_id: string; filename: string; version_is_current: boolean }
export interface VisualPreviewFileList { files: VisualPreviewFile[]; has_more?: boolean }
export type VisualPreviewImage =
  | { render: 'unavailable' }
  | { render: 'available'; bytes: Buffer; mediaType: 'image/png' | 'image/jpeg'; descriptor: VisualPreviewDescriptor }

async function readVisualBytes(response: Response, limit: number): Promise<Buffer> {
  if (!response.body || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw new Error('Visual preview unavailable')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) { await reader.cancel(); throw new Error('Visual preview unavailable') }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

export async function fetchNativeVisualPreviewJson(baseUrl: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/api/v1/auth/embed/visual-preview-session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok || response.headers.get('content-type')?.split(';', 1)[0].trim() !== 'application/json') {
    await response.body?.cancel()
    throw new Error('Visual preview unavailable')
  }
  const payload: unknown = JSON.parse((await readVisualBytes(response, 64 * 1024)).toString('utf8'))
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid preview response')
  return payload as Record<string, unknown>
}

export async function redeemNativeVisualPreview(baseUrl: string, capability: Record<string, unknown>,
  embed: EmbedTokenClaims, fileId: string, versionId: string, origin: string): Promise<VisualPreviewImage> {
  if (capability.render !== 'available' || typeof capability.preview_token !== 'string') return { render: 'unavailable' }
  const { claims, descriptor } = verifyVisualPreviewToken(capability.preview_token, {
    publicKeysByKid: embedPublicKeysByKid(), embed, fileId, versionId, origin,
  })
  for (const key of ['file_id', 'version_id', 'checksum', 'preview_checksum', 'media_type', 'width', 'height', 'page', 'version_is_current'] as const) {
    if (capability[key] !== claims[key]) return { render: 'unavailable' }
  }
  if (!await consumeVisualPreviewJti(claims)) return { render: 'unavailable' }
  const response = await fetch(`${baseUrl}/api/v1/auth/embed/visual-preview-session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preview_token: capability.preview_token, origin }),
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  })
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim()
  if (!response.ok || mediaType !== claims.media_type) {
    await response.body?.cancel()
    return { render: 'unavailable' }
  }
  const bytes = await readVisualBytes(response, 8 * 1024 * 1024)
  const validMagic = mediaType === 'image/png'
    ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
  if (!validMagic || createHash('sha256').update(bytes).digest('hex') !== claims.preview_checksum
    || claims.exp <= Math.floor(Date.now() / 1000)) return { render: 'unavailable' }
  return { render: 'available', bytes, mediaType: claims.media_type, descriptor }
}
