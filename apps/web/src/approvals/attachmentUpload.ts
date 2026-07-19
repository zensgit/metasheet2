/**
 * Approval attachment upload — client-side pre-validation + upload client (#4195 v1).
 *
 * MIRRORS the server predicate (`approval-attachment-validation.ts`) — the server remains authoritative
 * (rejects with 422 values-free codes); this mirror only saves a round-trip. Per the "mock is not the
 * contract" rule the two vocabularies are pinned by `CLIENT_ATTACHMENT_RULES_VERSION`: bump it in BOTH
 * files in the same change or the parity spec goes red.
 *
 * Ratified v1: 20 MB/file · 10 files/field · 50 MB/submission; MIME allowlist PDF/JPEG/PNG/TXT/CSV with
 * extension⇄MIME agreement. Feature-gated by `VITE_APPROVAL_ATTACHMENTS_ENABLED` (default OFF) — when
 * OFF, ApprovalNewView keeps the B2-28 honest-disable stopgap byte-equivalent.
 */
export const CLIENT_ATTACHMENT_RULES_VERSION = 'v1-20-10-50-pdf-jpeg-png-txt-csv'

export const CLIENT_ATTACHMENT_LIMITS = Object.freeze({
  maxFileBytes: 20 * 1024 * 1024,
  maxFilesPerField: 10,
  maxSubmissionBytes: 50 * 1024 * 1024,
})

/**
 * Master frontend gate — must stay default OFF. Only the exact string `'true'` enables the real
 * uploader; any other value (including unset) preserves B2-28 honest-disable.
 */
export function isApprovalAttachmentsEnabled(
  env: { VITE_APPROVAL_ATTACHMENTS_ENABLED?: string } = import.meta.env as {
    VITE_APPROVAL_ATTACHMENTS_ENABLED?: string
  },
): boolean {
  return String(env.VITE_APPROVAL_ATTACHMENTS_ENABLED ?? '').trim().toLowerCase() === 'true'
}

const ALLOW: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'text/plain': ['txt'],
  'text/csv': ['csv'],
})

export interface ClientReject {
  fileName: string
  code: 'file_too_large' | 'too_many_files' | 'submission_too_large' | 'mime_not_allowed' | 'extension_not_allowed' | 'extension_mime_mismatch' | 'invalid_size'
}

/** Same all-or-nothing semantics as the server; returns [] when acceptable. */
export function preValidateAttachments(files: ReadonlyArray<{ name: string; type: string; size: number }>): ClientReject[] {
  const rejected: ClientReject[] = []
  if (files.length > CLIENT_ATTACHMENT_LIMITS.maxFilesPerField) {
    return [{ fileName: `(${files.length} files)`, code: 'too_many_files' }]
  }
  let total = 0
  for (const f of files) {
    if (!Number.isFinite(f.size) || f.size <= 0) {
      rejected.push({ fileName: f.name, code: 'invalid_size' })
      continue
    }
    total += f.size
    if (f.size > CLIENT_ATTACHMENT_LIMITS.maxFileBytes) rejected.push({ fileName: f.name, code: 'file_too_large' })
    const mime = (f.type ?? '').toLowerCase().trim()
    const i = f.name.lastIndexOf('.')
    const ext = i < 0 ? '' : f.name.slice(i + 1).toLowerCase()
    // Own-property guard (server parity): a plain-object `ALLOW[mime]` lookup keyed by an
    // attacker-controlled `mime` ('constructor' / '__proto__') would otherwise resolve an INHERITED
    // Object.prototype member — truthy, not an array — and `allowed.includes(ext)` would throw an
    // uncaught TypeError. Only own properties may resolve; anything else rejects as mime_not_allowed.
    // `Object.prototype.hasOwnProperty.call` keeps the check ES2020-compatible for this package's lib target.
    const allowed = Object.prototype.hasOwnProperty.call(ALLOW, mime) ? ALLOW[mime] : undefined
    const extKnown = Object.values(ALLOW).some((xs) => xs.includes(ext))
    if (!allowed) rejected.push({ fileName: f.name, code: 'mime_not_allowed' })
    else if (!extKnown) rejected.push({ fileName: f.name, code: 'extension_not_allowed' })
    else if (!allowed.includes(ext)) rejected.push({ fileName: f.name, code: 'extension_mime_mismatch' })
  }
  if (total > CLIENT_ATTACHMENT_LIMITS.maxSubmissionBytes) rejected.push({ fileName: '(submission)', code: 'submission_too_large' })
  return rejected
}

export interface UploadedAttachment {
  id: string
  sizeBytes: number
  /** Client-side display only — never sent as a storage key. */
  fileName?: string
}

/**
 * Auth-proxied download URL — attachment id only. Never embeds storage keys or object-store URLs.
 */
/** Auth-proxied download URL — ratified lock §4.2 path (plural `approvals`). */
export function approvalAttachmentDownloadUrl(attachmentId: string): string {
  return `/api/approvals/attachments/${encodeURIComponent(attachmentId)}/download`
}

/** Metadata URL for detail/tombstone resolution (no storage keys). */
export function approvalAttachmentMetaUrl(attachmentId: string): string {
  return `/api/approvals/attachments/${encodeURIComponent(attachmentId)}`
}

export const ATTACHMENT_TOMBSTONE_LABEL = '附件已删除'

export interface AttachmentMetaDto {
  id: string
  fileName?: string
  status?: string
  tombstone?: boolean
}

/** Resolve frozen attachment refs for detail display — tombstone when deleted/missing/infected. */
export async function resolveAttachmentMeta(
  attachmentId: string,
  fetcher: typeof fetch = fetch,
): Promise<AttachmentMetaDto> {
  try {
    const res = await fetcher(approvalAttachmentMetaUrl(attachmentId), { credentials: 'include' })
    if (res.status === 200) {
      const body = (await res.json()) as AttachmentMetaDto
      return {
        id: attachmentId,
        fileName: body.fileName,
        status: body.tombstone ? 'deleted' : body.status,
        tombstone: Boolean(body.tombstone),
      }
    }
    if (res.status === 410) return { id: attachmentId, tombstone: true, status: 'deleted' }
    return { id: attachmentId, tombstone: true, status: 'missing' }
  } catch {
    return { id: attachmentId, tombstone: true, status: 'missing' }
  }
}

/** Display label for a resolved ref — never exposes storage keys. */
export function attachmentDisplayLabel(meta: AttachmentMetaDto | undefined, index: number): string {
  if (!meta || meta.tombstone || meta.status === 'deleted' || meta.status === 'missing') {
    return ATTACHMENT_TOMBSTONE_LABEL
  }
  return meta.fileName?.trim() || `附件${index + 1}`
}

/**
 * G13 — probe whether an unbound draft attachment id still resolves for the uploader.
 * 200 = live; 404/410 = stale (GC-swept or deleted).
 */
export async function probeAttachmentAlive(
  attachmentId: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetcher(approvalAttachmentMetaUrl(attachmentId), { credentials: 'include' })
    return res.status === 200
  } catch {
    return false
  }
}

/**
 * Upload one file; the server re-validates (authoritative) and returns the attachment id. The body is
 * the lock's `{ templateId, fieldId }` — the owning ORG is derived server-side from the authenticated
 * principal, never sent by the client (a client org_id would be a cross-tenant attribution forgery).
 */
export async function uploadApprovalAttachment(
  file: File,
  templateId: string,
  fieldId: string,
  fetcher: typeof fetch = fetch,
): Promise<UploadedAttachment> {
  const pre = preValidateAttachments([{ name: file.name, type: file.type, size: file.size }])
  if (pre.length > 0) throw new Error(`attachment rejected: ${pre[0].code}`)
  const form = new FormData()
  form.append('templateId', templateId)
  form.append('fieldId', fieldId)
  form.append('file', file)
  // Wire path matches ratified lock §4.1: `/api/approvals/attachments` (plural).
  const res = await fetcher('/api/approvals/attachments', { method: 'POST', body: form, credentials: 'include' })
  if (res.status === 201) {
    const body = (await res.json()) as UploadedAttachment
    return { id: body.id, sizeBytes: body.sizeBytes, fileName: file.name }
  }
  if (res.status === 422) {
    const body = (await res.json().catch(() => ({}))) as { rejected?: Array<{ code: string }> }
    throw new Error(`attachment rejected: ${body.rejected?.[0]?.code ?? 'rejected'}`)
  }
  if (res.status === 503) throw new Error('attachment upload failed: storage_unavailable')
  throw new Error(`attachment upload failed: ${res.status}`)
}

/**
 * Unbound delete — uploader-only. Bound rows are refused server-side (cascade only).
 * Safe to call when removing a draft ref; 404 is treated as already-gone success for UX.
 */
export async function deleteApprovalAttachment(
  attachmentId: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const res = await fetcher(`/api/approvals/attachments/${encodeURIComponent(attachmentId)}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (res.status === 204 || res.status === 404) return
  if (res.status === 503) throw new Error('attachment delete failed: storage_unavailable')
  throw new Error(`attachment delete failed: ${res.status}`)
}

/**
 * Drop attachment ids that no longer resolve (GC-swept unbound drafts — G13).
 * `probe` returns true when the id is still live (HEAD/download 200/410-with-auth), false when gone.
 * Stale ids are removed; the caller surfaces them to the user.
 */
export async function dropStaleAttachmentIds(
  ids: readonly string[],
  probe: (id: string) => Promise<boolean>,
): Promise<{ live: string[]; stale: string[] }> {
  const live: string[] = []
  const stale: string[] = []
  for (const id of ids) {
    try {
      if (await probe(id)) live.push(id)
      else stale.push(id)
    } catch {
      stale.push(id)
    }
  }
  return { live, stale }
}

/** Human-readable reject message for UX (values-free codes only). */
export function attachmentRejectMessage(code: string): string {
  switch (code) {
    case 'file_too_large':
      return '单个附件不能超过 20 MB'
    case 'too_many_files':
      return '单个附件字段最多 10 个文件'
    case 'submission_too_large':
      return '全部附件合计不能超过 50 MB'
    case 'mime_not_allowed':
    case 'extension_not_allowed':
    case 'extension_mime_mismatch':
    case 'content_mime_mismatch':
      return '不支持的文件类型（仅 PDF / JPEG / PNG / TXT / CSV）'
    case 'storage_unavailable':
      return '附件存储暂不可用，请稍后重试'
    default:
      return '附件上传失败'
  }
}
