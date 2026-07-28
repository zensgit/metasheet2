/**
 * Approval attachments — slice ①: upload validation core (#4195 lock, reject-by-default).
 *
 * Ratified v1 limits: **20 MB/file · 10 files/field · 50 MB/submission**; **MIME allowlist NARROWED to
 * PDF, JPEG, PNG, TXT, CSV** (D6 — Office/ZIP/archives deferred until AV scanning; NOT v1). Both the MIME
 * type AND the file extension must be allowlisted and AGREE (a .exe claiming application/pdf is rejected —
 * extension⇄MIME cross-check), reject-by-default for anything unknown. When the raw bytes are available
 * the declared MIME is also cross-checked against the content SIGNATURE (G3): a body whose magic bytes
 * disagree with the declared type — a JPEG uploaded as image/png, a PDF renamed .csv — is rejected.
 * Pure and synchronous; the storage provider, tables and routes are later slices.
 */
import { sniffImageContentType } from './imageMagicBytes'

/** Declared types that carry a detectable magic-byte signature; a byte body MUST match if provided (G3). */
const SIGNATURE_BEARING_MIMES: ReadonlySet<string> = new Set(['application/pdf', 'image/jpeg', 'image/png'])

/**
 * Detect a content type from leading bytes: the shared image sniffer (`imageMagicBytes.ts`) plus PDF's
 * `%PDF` header. Returns undefined for content with no recognized binary signature (e.g. plain text).
 */
function detectContentSignature(content: Buffer): string | undefined {
  const image = sniffImageContentType(content)
  if (image) return image
  if (content.length >= 4 && content[0] === 0x25 && content[1] === 0x50 && content[2] === 0x44 && content[3] === 0x46) {
    return 'application/pdf' // "%PDF"
  }
  return undefined
}

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
  /** the raw upload bytes, when available — enables the content-signature cross-check (G3). */
  content?: Buffer
}

export type AttachmentRejectCode =
  | 'file_too_large'
  | 'too_many_files'
  | 'submission_too_large'
  | 'mime_not_allowed'
  | 'extension_not_allowed'
  | 'extension_mime_mismatch'
  | 'content_mime_mismatch'
  | 'invalid_size'

export type AttachmentValidationResult =
  | { ok: true }
  | { ok: false; rejected: Array<{ fileName: string; code: AttachmentRejectCode }> }

/** Cap / count rejects → HTTP 413 (§5 / G3). */
const CAP_REJECT_CODES: ReadonlySet<AttachmentRejectCode> = new Set([
  'file_too_large',
  'too_many_files',
  'submission_too_large',
])

/** Type / signature rejects → HTTP 415 (§5 / G3). */
const TYPE_REJECT_CODES: ReadonlySet<AttachmentRejectCode> = new Set([
  'mime_not_allowed',
  'extension_not_allowed',
  'extension_mime_mismatch',
  'content_mime_mismatch',
])

/**
 * Map validation reject codes to the lock's HTTP semantics. Cap codes win over type codes when both
 * appear in one batch (size/count is a 413 regardless of type). Unknown codes fall through to 400.
 */
export function httpStatusForAttachmentRejects(
  rejected: ReadonlyArray<{ code: string }>,
): 400 | 413 | 415 {
  if (rejected.some((entry) => CAP_REJECT_CODES.has(entry.code as AttachmentRejectCode))) return 413
  if (rejected.some((entry) => TYPE_REJECT_CODES.has(entry.code as AttachmentRejectCode))) return 415
  return 400
}

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
    // Object.hasOwn guard: a plain-object lookup keyed by attacker-controlled `mime` (e.g.
    // 'constructor' or '__proto__') would otherwise resolve an INHERITED Object.prototype
    // member — truthy but not an array — and `allowedExts.includes(ext)` below would throw
    // an uncaught TypeError (request-crashing DoS). Only own properties may resolve.
    const allowedExts = Object.hasOwn(V1_ALLOWLIST, mime) ? V1_ALLOWLIST[mime] : undefined
    const ext = extOf(f.fileName ?? '')
    const extKnown = Object.values(V1_ALLOWLIST).some((xs) => xs.includes(ext))
    if (!allowedExts) rejected.push({ fileName: f.fileName, code: 'mime_not_allowed' })
    else if (!extKnown) rejected.push({ fileName: f.fileName, code: 'extension_not_allowed' })
    else if (!allowedExts.includes(ext)) rejected.push({ fileName: f.fileName, code: 'extension_mime_mismatch' })
    else if (f.content) {
      // G3 content-signature cross-check (only for a mime/ext-agreeing allowlisted file): the declared
      // type must match the magic bytes. A detected type that disagrees, OR a claimed signature-bearing
      // binary whose bytes carry no matching signature, is rejected — a forged content-type sails past a
      // name/header-only check but not this one.
      const detected = detectContentSignature(f.content)
      if (detected !== undefined) {
        if (detected !== mime) rejected.push({ fileName: f.fileName, code: 'content_mime_mismatch' })
      } else if (SIGNATURE_BEARING_MIMES.has(mime)) {
        rejected.push({ fileName: f.fileName, code: 'content_mime_mismatch' })
      }
    }
  }
  if (total > APPROVAL_ATTACHMENT_LIMITS.maxSubmissionBytes) {
    rejected.push({ fileName: '(submission)', code: 'submission_too_large' })
  }
  return rejected.length > 0 ? { ok: false, rejected } : { ok: true }
}
