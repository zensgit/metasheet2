import { apiFetch, getApiBase } from '../../utils/api'
import { parseVisualPreviewDescriptorHeader, type VisualPreviewDescriptor } from './plmVisualMarkup'

export interface VisualPreviewFile { file_id: string; version_id: string; filename: string; version_is_current: boolean }
export interface VisualPreviewList { files: VisualPreviewFile[]; hasMore: boolean }
export type VisualPreviewResult =
  | { render: 'available'; blob: Blob; descriptor: VisualPreviewDescriptor }
  | { render: 'unavailable' }

const BASE = '/api/plm-embed/visual-preview'
const MAX_BYTES = 8 * 1024 * 1024

export class VisualPreviewAccessError extends Error {
  readonly reason: 'denied' | 'offline'
  constructor(reason: 'denied' | 'offline') { super(reason); this.reason = reason }
}

function managedPath(sourceId: string): string {
  if (!sourceId || sourceId !== sourceId.trim()
    || new URL(getApiBase(), window.location.origin).origin !== window.location.origin) {
    throw new VisualPreviewAccessError('denied')
  }
  return '/api/plm/managed-login/sources/' + encodeURIComponent(sourceId) + '/discussion'
}

function unavailable(error: unknown): void {
  if (error instanceof VisualPreviewAccessError) throw error
  if (navigator.onLine === false) throw new VisualPreviewAccessError('offline')
}

function checkAccess(response: Response): void {
  if ([401, 403, 404].includes(response.status)) throw new VisualPreviewAccessError('denied')
}

export async function listVisualPreviewFiles(token: string, signal?: AbortSignal, managedSourceId?: string): Promise<VisualPreviewList | null> {
  try {
    const managed = managedSourceId !== undefined
    const response = await apiFetch(managed ? managedPath(managedSourceId) : `${BASE}/files`, {
      method: 'POST', headers: { 'X-PLM-Embed-Token': token, ...(managed ? { 'Content-Type': 'application/json' } : {}) },
      ...(managed ? { credentials: 'include' as const, body: JSON.stringify({ operation: 'preview-files' }) } : {}),
      suppressUnauthorizedRedirect: true, signal,
    })
    checkAccess(response)
    const payload = await response.json()
    if (!response.ok || payload?.ok !== true || !Array.isArray(payload.data?.files)) return null
    const files = payload.data.files as VisualPreviewFile[]
    if (!files.every((file) => typeof file.file_id === 'string' && file.file_id
      && typeof file.version_id === 'string' && file.version_id && typeof file.filename === 'string')) return null
    return { files: files.map((file) => ({ ...file, version_is_current: file.version_is_current === true })), hasMore: payload.data.has_more === true }
  } catch (error) { unavailable(error); return null }
}

export async function loadVisualPreview(token: string, file: VisualPreviewFile, partId: string, signal?: AbortSignal, managedSourceId?: string): Promise<VisualPreviewResult> {
  try {
    const managed = managedSourceId !== undefined
    const response = await apiFetch(managed ? managedPath(managedSourceId) : `${BASE}/image`, {
      method: 'POST',
      headers: { 'X-PLM-Embed-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(managed ? { operation: 'preview-image', fileId: file.file_id, versionId: file.version_id }
        : { file_id: file.file_id, version_id: file.version_id }),
      ...(managed ? { credentials: 'include' as const } : {}),
      suppressUnauthorizedRedirect: true, signal,
    })
    checkAccess(response)
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim()
    const descriptor = parseVisualPreviewDescriptorHeader(response.headers.get('X-PLM-Preview-Descriptor'))
    if (!response.ok || (mediaType !== 'image/png' && mediaType !== 'image/jpeg') || !response.body
      || !descriptor || descriptor.part_id !== partId || descriptor.file_id !== file.file_id || descriptor.file_version !== file.version_id) {
      await response.body?.cancel()
      return { render: 'unavailable' }
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) { await reader.cancel(); return { render: 'unavailable' } }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const validMagic = mediaType === 'image/png'
      ? [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
      : [255, 216, 255].every((byte, index) => bytes[index] === byte)
    return validMagic ? { render: 'available', blob: new Blob([bytes], { type: mediaType }), descriptor } : { render: 'unavailable' }
  } catch (error) { unavailable(error); return { render: 'unavailable' } }
}
