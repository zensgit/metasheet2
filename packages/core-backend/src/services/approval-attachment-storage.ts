/**
 * Approval attachments — storage provider (server-side keys, containment-first) + auth-proxied
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
 *   - Production (NODE_ENV=production + flag ON) requires a non-local S3-compatible provider (O3); local
 *     FS is dev/test only and fail-closes uploads with a values-free 503 when used in production.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import * as path from 'node:path'

import type { ReconcilerBlob } from './approval-attachment-reconciler'
import { S3ApprovalAttachmentStore } from './approval-attachment-s3-store'

const MIME_EXT: Readonly<Record<string, string>> = Object.freeze({
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'text/plain': 'txt',
  'text/csv': 'csv',
})

/** Unbypassable approval-owned prefix — reconciler and server write path both enforce this partition. */
export const APPROVAL_ATTACHMENT_KEY_PREFIX = 'approval/'

/** Server-side key derivation — validated mime decides the extension; the client filename is IGNORED. */
export function deriveStorageKey(validatedMime: string, now: () => Date = () => new Date()): string {
  const ext = MIME_EXT[validatedMime]
  if (!ext) throw new RangeError(`deriveStorageKey: mime "${validatedMime}" is not in the v1 allowlist`)
  const d = now()
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  return `${APPROVAL_ATTACHMENT_KEY_PREFIX}${ym}/${randomUUID()}.${ext}`
}

export interface ApprovalAttachmentStore {
  put(storageKey: string, content: Buffer): Promise<void>
  get(storageKey: string): Promise<Buffer>
  /** idempotent: deleting a missing blob returns false, never throws. */
  delete(storageKey: string): Promise<boolean>
}

/** Optional list capability for the bucket reconciler (G15). Prefix-scoped implementations only. */
export interface ApprovalAttachmentStoreListable {
  list(): Promise<ReconcilerBlob[]>
}

export type ApprovalAttachmentStoreKind = 'local' | 's3' | 'unavailable'

export interface ResolvedApprovalAttachmentStore {
  kind: ApprovalAttachmentStoreKind
  /** Ready store, or null when production fail-closed (local/missing/misconfigured). */
  store: (ApprovalAttachmentStore & Partial<ApprovalAttachmentStoreListable>) | null
  /** Values-free reason when store is null (never credentials / endpoints / keys). */
  unavailableReason?: 'local_in_production' | 'missing' | 'misconfigured'
}

/** Local-FS store with fail-closed containment. S3-compatible impl is production; local is dev/test only. */
export class LocalFsApprovalAttachmentStore implements ApprovalAttachmentStore, ApprovalAttachmentStoreListable {
  constructor(private readonly rootDir: string) {
    if (typeof rootDir !== 'string' || rootDir.trim() === '') throw new RangeError('rootDir required')
  }

  /** Resolve a key inside the root; ANY escape (.., absolute, drive, weird encodings) throws. */
  private contain(storageKey: string): string {
    if (typeof storageKey !== 'string' || storageKey.trim() === '' || storageKey.includes('\0')) {
      throw new RangeError('invalid storage key')
    }
    if (!storageKey.startsWith(APPROVAL_ATTACHMENT_KEY_PREFIX)) {
      throw new RangeError('storage key outside approval prefix — refused')
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

  /** Prefix-scoped walk under `approval/` only — never enumerates non-approval siblings. */
  async list(): Promise<ReconcilerBlob[]> {
    const root = path.resolve(this.rootDir)
    const prefixDir = path.join(root, APPROVAL_ATTACHMENT_KEY_PREFIX.replace(/\/$/, ''))
    const out: ReconcilerBlob[] = []
    const now = Date.now()
    async function walk(dir: string, relBase: string): Promise<void> {
      let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
      try {
        entries = await readdir(dir, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
        throw err
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name)
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          await walk(abs, rel)
        } else if (entry.isFile()) {
          const st = await stat(abs)
          const ageMs = Math.max(0, now - st.mtimeMs)
          out.push({ key: `${APPROVAL_ATTACHMENT_KEY_PREFIX}${rel}`.replace(/\/{2,}/g, '/'), ageMs })
        }
      }
    }
    await walk(prefixDir, '')
    return out
  }
}

/**
 * Resolve the approval attachment store from env (O3).
 *
 *   - `APPROVAL_ATTACHMENT_STORAGE_PROVIDER=s3` → S3-compatible (requires bucket; optional endpoint/region)
 *   - `local` or unset → LocalFs under `APPROVAL_ATTACHMENT_LOCAL_ROOT` (dev/test)
 *   - Production (`NODE_ENV=production`) with local/missing/misconfigured S3 → fail-closed (`store: null`)
 *
 * Never logs credentials, endpoints, bucket names, keys, or raw provider errors.
 */
export function resolveApprovalAttachmentStore(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedApprovalAttachmentStore {
  const isProd = String(env.NODE_ENV ?? '').trim().toLowerCase() === 'production'
  const provider = String(env.APPROVAL_ATTACHMENT_STORAGE_PROVIDER ?? 'local').trim().toLowerCase()

  if (provider === 's3') {
    const bucket = String(env.APPROVAL_ATTACHMENT_S3_BUCKET ?? '').trim()
    if (!bucket) {
      return { kind: 'unavailable', store: null, unavailableReason: 'misconfigured' }
    }
    try {
      const accessKeyId = String(env.APPROVAL_ATTACHMENT_S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID ?? '').trim()
      const secretAccessKey = String(env.APPROVAL_ATTACHMENT_S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY ?? '').trim()
      const sessionToken = String(env.APPROVAL_ATTACHMENT_S3_SESSION_TOKEN ?? env.AWS_SESSION_TOKEN ?? '').trim() || undefined
      const endpoint = String(env.APPROVAL_ATTACHMENT_S3_ENDPOINT ?? '').trim() || undefined
      const region = String(env.APPROVAL_ATTACHMENT_S3_REGION ?? env.AWS_REGION ?? 'us-east-1').trim()
      const forcePathStyle = String(env.APPROVAL_ATTACHMENT_S3_FORCE_PATH_STYLE ?? 'true').trim().toLowerCase() !== 'false'
      const store = new S3ApprovalAttachmentStore({
        bucket,
        region,
        endpoint,
        forcePathStyle,
        keyPrefix: APPROVAL_ATTACHMENT_KEY_PREFIX,
        credentials: accessKeyId && secretAccessKey
          ? { accessKeyId, secretAccessKey, sessionToken }
          : undefined,
      })
      return { kind: 's3', store }
    } catch {
      return { kind: 'unavailable', store: null, unavailableReason: 'misconfigured' }
    }
  }

  if (provider !== 'local' && provider !== '') {
    return { kind: 'unavailable', store: null, unavailableReason: 'misconfigured' }
  }

  // Local FS — allowed only outside production.
  if (isProd) {
    return { kind: 'unavailable', store: null, unavailableReason: 'local_in_production' }
  }
  const root = String(env.APPROVAL_ATTACHMENT_LOCAL_ROOT ?? '').trim()
    || path.join(process.cwd(), 'uploads', 'approval-attachments')
  try {
    return { kind: 'local', store: new LocalFsApprovalAttachmentStore(root) }
  } catch {
    return { kind: 'unavailable', store: null, unavailableReason: 'misconfigured' }
  }
}

export interface AttachmentRowForAuth {
  status: 'unbound' | 'bound' | 'deleted'
  uploaderId: string
  instanceId: string | null
  /** the attachment field's id in the template form schema — the key the hidden-redaction gate reads (G7). */
  fieldId: string
}

export interface DownloadAuthChecks {
  /** is the viewer a participant (initiator/approver/cc) of the instance? */
  isInstanceParticipant(viewerId: string, instanceId: string): Promise<boolean>
  /**
   * Does the instance's ACTIVE node(s) mark `fieldId` as `access:'hidden'`? (§4.2 gate 2 / G7.)
   * The production wiring MUST back this with the SAME `collectHiddenFieldIds(...)` the snapshot
   * redaction uses (`approval-form-redaction.ts`), keyed on the instance's active node(s) — never a
   * re-derived hidden decision — so the byte path and the echoed snapshot cannot drift on "hidden".
   */
  isFieldHiddenAtActiveNode(instanceId: string, fieldId: string): Promise<boolean>
}

export type DownloadAuthResult =
  | { ok: true }
  | { ok: false; code: 'gone' | 'not_uploader' | 'not_participant' | 'hidden' }

/**
 * Recomputed on EVERY download; fail-closed on error. Two gates in order (§4.2):
 *   1. instance-visibility (uploader while unbound; instance participant once bound);
 *   2. hidden-field redaction — a field the snapshot would hide serves NO bytes to ANYONE (G7).
 * The `deleted → gone` lifecycle signal is emitted LAST, so an unauthorized outsider always gets the
 * same authorization denial and never a 404→410 existence/lifecycle oracle (P2 #3 moves it here / G6).
 */
export async function authorizeAttachmentDownload(
  row: AttachmentRowForAuth,
  viewerId: string,
  checks: DownloadAuthChecks,
): Promise<DownloadAuthResult> {
  // Gate 1: instance-visibility. Evaluated BEFORE any deleted/gone signal so an unauthorized outsider
  // always gets the same authorization denial (→ 404) and never a 404→410 existence/lifecycle oracle
  // (G6). Unbound (no instance) is uploader-only; bound/cascade-deleted uses the participant predicate.
  let authorized: boolean
  let denyCode: 'not_uploader' | 'not_participant'
  if (!row.instanceId) {
    authorized = row.uploaderId === viewerId // pre-submit: only the uploader
    denyCode = 'not_uploader'
  } else {
    denyCode = 'not_participant'
    try {
      authorized = await checks.isInstanceParticipant(viewerId, row.instanceId)
    } catch {
      authorized = false // fail-closed
    }
  }
  if (!authorized) return { ok: false, code: denyCode }
  // Gate 2 (G7): even an authorized participant gets NO bytes for a field hidden at the active node —
  // the byte path inherits the snapshot's redaction. Bound rows only (unbound has no active node).
  // Fail-closed: if we cannot confirm not-hidden, refuse.
  if (row.instanceId) {
    let hidden = true
    try {
      hidden = await checks.isFieldHiddenAtActiveNode(row.instanceId, row.fieldId)
    } catch {
      hidden = true // fail-closed: an ACL/graph-load failure must never leak a byte a hidden field would strip
    }
    if (hidden) return { ok: false, code: 'hidden' }
  }
  // Gate 3: lifecycle. Only an AUTHORIZED viewer reaches this — they see the deleted tombstone (410);
  // an outsider was already denied at gate 1, so the deleted state is never an oracle for them (G6).
  if (row.status === 'deleted') return { ok: false, code: 'gone' }
  return { ok: true }
}
