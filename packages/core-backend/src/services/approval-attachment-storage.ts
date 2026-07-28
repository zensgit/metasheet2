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
 * WIRED (approval-attachment-runtime.ts): the flag-gated routes consume the store + download gate;
 * production resolves NO local store (O3 fail-close 503) — local-FS is dev/test only.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import * as path from 'node:path'

const MIME_EXT: Readonly<Record<string, string>> = Object.freeze({
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'text/plain': 'txt',
  'text/csv': 'csv',
})

/**
 * The unbypassable approval scope prefix (§7 owner-P1). `StorageService` is a SHARED substrate
 * (multitable, files and approvals all live behind it), so the reconciler's "delete an object with no
 * row" rule is only safe if approval objects — and ONLY approval objects — occupy a known partition of
 * it. Every approval key is derived under this prefix and the object-store adapter refuses any key
 * outside it on read, write AND delete, so the partition holds in both directions.
 */
export const APPROVAL_STORAGE_PREFIX = 'approval-attachments/'

/** Server-side key derivation — validated mime decides the extension; the client filename is IGNORED. */
export function deriveStorageKey(validatedMime: string, now: () => Date = () => new Date()): string {
  const ext = MIME_EXT[validatedMime]
  if (!ext) throw new RangeError(`deriveStorageKey: mime "${validatedMime}" is not in the v1 allowlist`)
  const d = now()
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  return `${APPROVAL_STORAGE_PREFIX}${ym}/${randomUUID()}.${ext}`
}

export interface ApprovalAttachmentStore {
  put(storageKey: string, content: Buffer): Promise<void>
  get(storageKey: string): Promise<Buffer>
  /** idempotent: deleting a missing blob returns false, never throws. */
  delete(storageKey: string): Promise<boolean>
  /**
   * Optional G15 listing seam. Production local-fs and object-store implementations always provide
   * it; the boot probe requires it when present so put→get→list→delete is proven end-to-end.
   */
  list?(now?: () => number): Promise<Array<{ key: string; ageMs: number }>>
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

  /**
   * Enumerate every blob under the root WITH its age (mtime-based) — the reconciler's `listBlobs` seam
   * (§7/G15). Scope containment is structural: the walk starts at (and can never leave) this store's
   * root, which the boot wiring dedicates to approval attachments — the reconciler therefore can never
   * see (let alone enqueue) another product's blobs. A missing root lists as empty (nothing uploaded yet).
   */
  async list(now: () => number = () => Date.now()): Promise<Array<{ key: string; ageMs: number }>> {
    const root = path.resolve(this.rootDir)
    const out: Array<{ key: string; ageMs: number }> = []
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
        throw err
      }
      for (const entry of entries) {
        const p = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(p)
        } else if (entry.isFile()) {
          const s = await stat(p)
          out.push({ key: path.relative(root, p).split(path.sep).join('/'), ageMs: Math.max(0, now() - s.mtimeMs) })
        }
      }
    }
    await walk(root)
    return out
  }
}

/**
 * The subset of the repository's `StorageProvider` (services/StorageService.ts) an approval attachment
 * store needs — the THREE key-addressed methods, and nothing else. The approval pipeline deliberately
 * consumes only these: `downloadByKey` is the cross-process-reliable read the lock mandates (§4.2),
 * `deleteByKey` the idempotent ENOENT-as-success delete the purge worker mandates (§7), and
 * `uploadByKey` the symmetric write that lets the server own the whole key (no client string in a
 * path, everything under the approval scope prefix).
 *
 * Structural, not nominal: any S3-compatible provider implementing the exported `StorageProvider`
 * interface satisfies it, and so does `StorageServiceImpl`. This is what "reuse the blob substrate"
 * (§2) means concretely — the approval line adds NO transport of its own.
 */
export interface KeyAddressedObjectStore {
  uploadByKey(storageKey: string, content: Buffer, contentType?: string): Promise<void>
  downloadByKey(storageKey: string): Promise<Buffer>
  deleteByKey(storageKey: string): Promise<void>
}

/** Mandatory approval-prefix listing seam for the G15 reconciler. */
export interface ListableObjectStore {
  listApprovalBlobs(now?: () => number): Promise<Array<{ key: string; ageMs: number }>>
}

/**
 * Production store: an `ApprovalAttachmentStore` backed by the SHARED `StorageService` substrate
 * (§2 reuse verdict) — the object-store provider is injected, so an S3-compatible deployment rides
 * the same code path with zero approval-side transport code. The adapter adds exactly one approval
 * invariant on top of the substrate: every key is forced under the approval scope prefix, the
 * unbypassable partition the reconciler's scope containment rests on (§7 owner-P1).
 */
export class ObjectStoreApprovalAttachmentStore implements ApprovalAttachmentStore {
  constructor(
    private readonly provider: KeyAddressedObjectStore & ListableObjectStore,
    /** the dedicated approval prefix — every key MUST live under it, on write AND on read/delete. */
    private readonly prefix: string = APPROVAL_STORAGE_PREFIX,
  ) {
    if (typeof prefix !== 'string' || !prefix.endsWith('/')) throw new RangeError('prefix must end with "/"')
  }

  /**
   * Scope partition (§7): refuse any key that is not under the approval prefix — on EVERY operation,
   * not just write. A non-approval object therefore can never be written into the approval scope and
   * an approval operation can never reach out of it, which is what makes the prefix an unbypassable
   * partition of a shared store rather than a naming convention.
   */
  private scoped(storageKey: string): string {
    if (typeof storageKey !== 'string' || storageKey.includes('\0') || !storageKey.startsWith(this.prefix)) {
      throw new RangeError('storage key is outside the approval attachment scope — refused')
    }
    if (storageKey.includes('..')) throw new RangeError('storage key traversal — refused')
    return storageKey
  }

  async put(storageKey: string, content: Buffer): Promise<void> {
    await this.provider.uploadByKey(this.scoped(storageKey), content)
  }

  async get(storageKey: string): Promise<Buffer> {
    return this.provider.downloadByKey(this.scoped(storageKey))
  }

  /**
   * `deleteByKey` is ENOENT-as-success by the substrate's own contract (it resolves for an
   * already-gone key), so the purge worker's "missing blob is terminal-success" holds without this
   * adapter inspecting any error code. It cannot distinguish deleted-now from already-gone, and the
   * drain treats both identically, so `true` is returned for both.
   */
  async delete(storageKey: string): Promise<boolean> {
    await this.provider.deleteByKey(this.scoped(storageKey))
    return true
  }

  /** G15 reconciler seam; production boot accepts no object store without it. */
  async list(now: () => number = () => Date.now()): Promise<Array<{ key: string; ageMs: number }>> {
    return this.provider.listApprovalBlobs(now)
  }

  /** Object-store construction requires the G15 listing capability. */
  canList(): boolean {
    return true
  }
}

export interface AttachmentRowForAuth {
  status: 'unbound' | 'bound' | 'deleted'
  uploaderId: string
  instanceId: string | null
  /** the attachment field's id in the template form schema — the key the hidden-redaction gate reads (G7). */
  fieldId: string
  /**
   * Org that owns the durable row (server-derived at upload). Bound list/download pin the viewer to
   * this org so a cross-org stale membership cannot read another tenant's bytes (no existence oracle).
   */
  orgId: string
  /** §6 scan seam — only `infected` is refused; unscanned/clean pass (default-OFF pass-through). */
  scanState?: string | null
}

export interface DownloadAuthChecks {
  /**
   * Is the viewer a participant (initiator/approver/cc/admin) of the instance, PINNED to the
   * attachment's org? Cross-org stale relations must fail closed as not_participant.
   */
  isInstanceParticipant(viewerId: string, instanceId: string, orgId: string): Promise<boolean>
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
  | { ok: false; code: 'gone' | 'not_uploader' | 'not_participant' | 'hidden' | 'cross_org' | 'infected' }

/**
 * Recomputed on EVERY download; fail-closed on error. Gates in order (§4.2 + org pin + §6):
 *   0. org pin — viewer's org must match the row's org (cross-org → same 404 as not_participant);
 *   1. instance-visibility (uploader while unbound; org-pinned participant once bound);
 *   2. hidden-field redaction — a field the snapshot would hide serves NO bytes to ANYONE (G7);
 *   3. lifecycle + scan — deleted/infected tombstones only after authorization (G6 no oracle).
 */
export async function authorizeAttachmentDownload(
  row: AttachmentRowForAuth,
  viewerId: string,
  viewerOrgId: string,
  checks: DownloadAuthChecks,
): Promise<DownloadAuthResult> {
  // Gate 0: org pin. A missing/mismatched org is an authorization denial, never a lifecycle signal.
  if (!viewerOrgId || !row.orgId || viewerOrgId !== row.orgId) {
    return { ok: false, code: 'cross_org' }
  }
  // Gate 1: instance-visibility. Evaluated BEFORE any deleted/gone/infected signal so an unauthorized
  // outsider always gets the same authorization denial (→ 404) and never a lifecycle oracle (G6).
  // Unbound (no instance) is uploader-only; bound/cascade-deleted uses the org-pinned participant predicate.
  let authorized: boolean
  let denyCode: 'not_uploader' | 'not_participant'
  if (!row.instanceId) {
    authorized = row.uploaderId === viewerId // pre-submit: only the uploader
    denyCode = 'not_uploader'
  } else {
    denyCode = 'not_participant'
    try {
      authorized = await checks.isInstanceParticipant(viewerId, row.instanceId, row.orgId)
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
  // Gate 3: lifecycle + scan. Only an AUTHORIZED viewer reaches this — they see the tombstone (410);
  // an outsider was already denied at gate 0/1, so deleted/infected is never an oracle for them (G6).
  if (row.status === 'deleted') return { ok: false, code: 'gone' }
  if (row.scanState === 'infected') return { ok: false, code: 'infected' }
  return { ok: true }
}
