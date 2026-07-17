/**
 * Approval attachment upload — client-side pre-validation + upload client (#4195 v1).
 *
 * MIRRORS the server predicate (`approval-attachment-validation.ts`) — the server remains authoritative
 * (rejects with 422 values-free codes); this mirror only saves a round-trip. Per the "mock is not the
 * contract" rule the two vocabularies are pinned by `CLIENT_ATTACHMENT_RULES_VERSION`: bump it in BOTH
 * files in the same change or the parity spec goes red.
 *
 * Ratified v1: 20 MB/file · 10 files/field · 50 MB/submission; MIME allowlist PDF/JPEG/PNG/TXT/CSV with
 * extension⇄MIME agreement. The UPLOAD CONTROL stays detached from ApprovalNewView until the backend
 * pipeline (#4342) lands and `APPROVAL_ATTACHMENTS_ENABLED` exists — B2-28's honest-disable stopgap is
 * removed only in that wiring change.
 */
export const CLIENT_ATTACHMENT_RULES_VERSION = 'v1-20-10-50-pdf-jpeg-png-txt-csv'

export const CLIENT_ATTACHMENT_LIMITS = Object.freeze({
  maxFileBytes: 20 * 1024 * 1024,
  maxFilesPerField: 10,
  maxSubmissionBytes: 50 * 1024 * 1024,
})

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
    // Object.hasOwn guard (server parity): a plain-object `ALLOW[mime]` lookup keyed by an
    // attacker-controlled `mime` ('constructor' / '__proto__') would otherwise resolve an INHERITED
    // Object.prototype member — truthy, not an array — and `allowed.includes(ext)` would throw an
    // uncaught TypeError. Only own properties may resolve; anything else rejects as mime_not_allowed.
    const allowed = Object.hasOwn(ALLOW, mime) ? ALLOW[mime] : undefined
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
  const res = await fetcher('/api/approval/attachments', { method: 'POST', body: form, credentials: 'include' })
  if (res.status === 201) return (await res.json()) as UploadedAttachment
  if (res.status === 422) {
    const body = (await res.json().catch(() => ({}))) as { rejected?: Array<{ code: string }> }
    throw new Error(`attachment rejected: ${body.rejected?.[0]?.code ?? 'rejected'}`)
  }
  throw new Error(`attachment upload failed: ${res.status}`)
}
