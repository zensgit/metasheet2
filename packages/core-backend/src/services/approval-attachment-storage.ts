/**
 * Approval attachments — slice ④: storage provider (server-side keys, containment-first) + auth-proxied
 * download gate (#4195: object storage provider, 上传/鉴权代理下载; mirrors the F3-hardened
 * LocalStorageProvider doctrine: server-generated keys, path containment, no client-supplied paths).
 *
 *   - Keys are SERVER-GENERATED (`approval/<yyyy-mm>/<uuid>.<ext>`) — a client filename NEVER becomes a
 *     storage path (its extension is re-derived from the ALREADY-VALIDATED mime, not the client string).
 *   - `LocalFsApprovalAttachmentStore` resolves every key against its root and REFUSES any resolution that
 *     escapes it (fail-closed containment — defense in depth even though keys are server-made).
 *   - Download is AUTH-PROXIED: `authorizeAttachmentDownload` recomputes the viewer's right on EVERY
 *     download (uploader while unbound; instance participant once bound; deleted → gone), fail-closed on
 *     error. The route slice streams the blob only after this returns ok — no signed public URLs in v1.
 *
 * No callers yet — routes + form-freeze land in the next slice behind the attachment flag.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'

const MIME_EXT: Readonly<Record<string, string>> = Object.freeze({
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'text/plain': 'txt',
  'text/csv': 'csv',
})

/** Server-side key derivation — validated mime decides the extension; the client filename is IGNORED. */
export function deriveStorageKey(validatedMime: string, now: () => Date = () => new Date()): string {
  const ext = MIME_EXT[validatedMime]
  if (!ext) throw new RangeError(`deriveStorageKey: mime "${validatedMime}" is not in the v1 allowlist`)
  const d = now()
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  return `approval/${ym}/${randomUUID()}.${ext}`
}

export interface ApprovalAttachmentStore {
  put(storageKey: string, content: Buffer): Promise<void>
  get(storageKey: string): Promise<Buffer>
  /** idempotent: deleting a missing blob returns false, never throws. */
  delete(storageKey: string): Promise<boolean>
}

/** Local-FS store with fail-closed containment. S3-compatible impl lands with ops config (same interface). */
export class LocalFsApprovalAttachmentStore implements ApprovalAttachmentStore {
  constructor(private readonly rootDir: string) {
    if (typeof rootDir !== 'string' || rootDir.trim() === '') throw new RangeError('rootDir required')
  }

  /** Resolve a key inside the root; ANY escape (.., absolute, drive, weird encodings) throws. */
  private contain(storageKey: string): string {
    if (typeof storageKey !== 'string' || storageKey.trim() === '' || storageKey.includes('\0')) {
      throw new RangeError('invalid storage key')
    }
    const root = path.resolve(this.rootDir)
    const resolved = path.resolve(root, storageKey)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new RangeError('storage key escapes the attachment root — refused')
    }
    return resolved
  }

  async put(storageKey: string, content: Buffer): Promise<void> {
    const p = this.contain(storageKey)
    await mkdir(path.dirname(p), { recursive: true })
    await writeFile(p, content, { flag: 'wx' }) // never overwrite an existing blob (keys are unique by construction)
  }

  async get(storageKey: string): Promise<Buffer> {
    return readFile(this.contain(storageKey))
  }

  async delete(storageKey: string): Promise<boolean> {
    try {
      await rm(this.contain(storageKey))
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    }
  }
}

export interface AttachmentRowForAuth {
  status: 'unbound' | 'bound' | 'deleted'
  uploaderId: string
  instanceId: string | null
}

export interface DownloadAuthChecks {
  /** is the viewer a participant (initiator/approver/cc) of the instance? */
  isInstanceParticipant(viewerId: string, instanceId: string): Promise<boolean>
}

export type DownloadAuthResult = { ok: true } | { ok: false; code: 'gone' | 'not_uploader' | 'not_participant' }

/** Recomputed on EVERY download; fail-closed on error. */
export async function authorizeAttachmentDownload(
  row: AttachmentRowForAuth,
  viewerId: string,
  checks: DownloadAuthChecks,
): Promise<DownloadAuthResult> {
  if (row.status === 'deleted') return { ok: false, code: 'gone' }
  if (row.status === 'unbound') {
    return row.uploaderId === viewerId ? { ok: true } : { ok: false, code: 'not_uploader' } // pre-submit: only the uploader
  }
  // bound: any instance participant
  if (!row.instanceId) return { ok: false, code: 'not_participant' } // defensive: bound-without-instance is barred by the DB CHECK
  let participant = false
  try {
    participant = await checks.isInstanceParticipant(viewerId, row.instanceId)
  } catch {
    participant = false // fail-closed
  }
  return participant ? { ok: true } : { ok: false, code: 'not_participant' }
}
