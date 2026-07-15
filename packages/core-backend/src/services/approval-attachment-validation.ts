/**
 * Approval attachments — slice ①: upload validation core (#4195 lock, reject-by-default).
 *
 * Ratified v1 limits: **20 MB/file · 10 files/field · 50 MB/submission**; **MIME allowlist NARROWED to
 * PDF, JPEG, PNG, TXT, CSV** (D6 — Office/ZIP/archives deferred until AV scanning; NOT v1). Both the MIME
 * type AND the file extension must be allowlisted and AGREE (a .exe claiming application/pdf is rejected —
 * extension⇄MIME cross-check), reject-by-default for anything unknown. Pure and synchronous; the storage
 * provider, tables and routes are later slices. No callers yet.
 */
export const APPROVAL_ATTACHMENT_LIMITS = Object.freeze({
  maxFileBytes: 20 * 1024 * 1024,
  maxFilesPerField: 10,
  maxSubmissionBytes: 50 * 1024 * 1024,
})

/** v1 allowlist (D6): canonical MIME → the extensions it may carry. */
const V1_ALLOWLIST: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'text/plain': ['txt'],
  'text/csv': ['csv'],
})

export interface AttachmentUploadCandidate {
  fileName: string
  mimeType: string
  sizeBytes: number
}

export type AttachmentRejectCode =
  | 'file_too_large'
  | 'too_many_files'
  | 'submission_too_large'
  | 'mime_not_allowed'
  | 'extension_not_allowed'
  | 'extension_mime_mismatch'
  | 'invalid_size'

export type AttachmentValidationResult =
  | { ok: true }
  | { ok: false; rejected: Array<{ fileName: string; code: AttachmentRejectCode }> }

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

/** Validate one field's upload batch, all-or-nothing reject-by-default. */
export function validateApprovalAttachments(files: readonly AttachmentUploadCandidate[]): AttachmentValidationResult {
  const rejected: Array<{ fileName: string; code: AttachmentRejectCode }> = []
  if (files.length > APPROVAL_ATTACHMENT_LIMITS.maxFilesPerField) {
    return { ok: false, rejected: [{ fileName: `(${files.length} files)`, code: 'too_many_files' }] }
  }
  let total = 0
  for (const f of files) {
    if (!Number.isSafeInteger(f.sizeBytes) || f.sizeBytes <= 0) {
      rejected.push({ fileName: f.fileName, code: 'invalid_size' })
      continue
    }
    total += f.sizeBytes
    if (f.sizeBytes > APPROVAL_ATTACHMENT_LIMITS.maxFileBytes) rejected.push({ fileName: f.fileName, code: 'file_too_large' })
    const mime = (f.mimeType ?? '').toLowerCase().trim()
    const allowedExts = V1_ALLOWLIST[mime]
    const ext = extOf(f.fileName ?? '')
    const extKnown = Object.values(V1_ALLOWLIST).some((xs) => xs.includes(ext))
    if (!allowedExts) rejected.push({ fileName: f.fileName, code: 'mime_not_allowed' })
    else if (!extKnown) rejected.push({ fileName: f.fileName, code: 'extension_not_allowed' })
    else if (!allowedExts.includes(ext)) rejected.push({ fileName: f.fileName, code: 'extension_mime_mismatch' })
  }
  if (total > APPROVAL_ATTACHMENT_LIMITS.maxSubmissionBytes) {
    rejected.push({ fileName: '(submission)', code: 'submission_too_large' })
  }
  return rejected.length > 0 ? { ok: false, rejected } : { ok: true }
}
