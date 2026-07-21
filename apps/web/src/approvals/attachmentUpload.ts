/**
 * Approval attachment upload — client-side pre-validation + upload client (#4195 v1).
 *
 * MIRRORS the server predicate (`approval-attachment-validation.ts`) — the server remains authoritative
 * (rejects with 422 values-free codes); this mirror only saves a round-trip. Per the "mock is not the
 * contract" rule the two vocabularies are pinned by `CLIENT_ATTACHMENT_RULES_VERSION`: bump it in BOTH
 * files in the same change or the parity spec goes red.
 *
 * Ratified v1: 20 MB/file · 10 files/field · 50 MB/submission; MIME allowlist PDF/JPEG/PNG/TXT/CSV with
 * extension⇄MIME agreement. WIRED (#4342): `ApprovalNewView` consumes this client behind the
 * `approvalAttachments` feature flag (the backend's `APPROVAL_ATTACHMENTS_ENABLED`, D5 default OFF) —
 * flag ON replaces the B2-28 honest-disable placeholder with the real uploader; flag OFF keeps the
 * placeholder + submit-time strip byte-identical.
 */
import { apiFetch } from '../utils/api'

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
 * Transport. Every attachment call goes through the app's own `apiFetch`, NOT a bare `fetch`: the app
 * authenticates with a Bearer token from storage (`authHeaders()`), so a bare `fetch` — even with
 * `credentials: 'include'` — arrives WITHOUT the token and is rejected 401 by the router's
 * `authenticate` guard. `apiFetch` also leaves `Content-Type` unset for a `FormData` body, which
 * multipart parsing requires (a hand-set JSON content-type would break the upload). Injectable so
 * tests can drive the transport directly.
 */
export type AttachmentFetcher = (path: string, init?: RequestInit) => Promise<Response>

/**
 * Upload one file; the server re-validates (authoritative) and returns the attachment id. The body is
 * the lock's `{ templateId, fieldId }` — the owning ORG is derived server-side from the authenticated
 * principal, never sent by the client (a client org_id would be a cross-tenant attribution forgery).
 */
export async function uploadApprovalAttachment(
  file: File,
  templateId: string,
  fieldId: string,
  fetcher: AttachmentFetcher = apiFetch,
): Promise<UploadedAttachment> {
  const pre = preValidateAttachments([{ name: file.name, type: file.type, size: file.size }])
  if (pre.length > 0) throw new Error(`attachment rejected: ${pre[0].code}`)
  const form = new FormData()
  form.append('templateId', templateId)
  form.append('fieldId', fieldId)
  form.append('file', file)
  const res = await fetcher('/api/approval/attachments', { method: 'POST', body: form })
  if (res.status === 201) return (await res.json()) as UploadedAttachment
  // Server maps type rejects → 415 and cap rejects → 413 (§5/G3); 422 remains for infected/other.
  if (res.status === 415 || res.status === 413 || res.status === 422) {
    const body = (await res.json().catch(() => ({}))) as { rejected?: Array<{ code: string }> }
    throw new Error(`attachment rejected: ${body.rejected?.[0]?.code ?? 'rejected'}`)
  }
  throw new Error(`attachment upload failed: ${res.status}`)
}

/**
 * §4.3 — retract a STAGED (still-unbound) upload. The server soft-deletes the row and enqueues the
 * durable blob-purge intent in one statement; it never blob-deletes inline, so this returning is not
 * a promise that the blob is gone yet — only that it is doomed and will be purged by the worker.
 *
 * A `404` is the server's single values-free answer for "not yours / already bound / already gone /
 * never existed" (no oracle). The caller treats it as SUCCESS for the purpose of dropping the id from
 * the form: the id is, by any of those readings, not a staged upload this user can still submit — so
 * leaving it in the payload could only make the submission fail closed later.
 */
export async function deleteApprovalAttachment(
  attachmentId: string,
  fetcher: AttachmentFetcher = apiFetch,
): Promise<void> {
  const res = await fetcher(`/api/approval/attachments/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' })
  if (res.status === 204 || res.status === 404) return
  throw new Error(`attachment delete failed: ${res.status}`)
}

export interface AttachmentRefResult {
  id: string
  stale?: boolean
  tombstone?: boolean
  fieldId?: string
  fileName?: string
  sizeBytes?: number
  mimeType?: string
  downloadUrl?: string
}

/**
 * §8 batched reference resolution. Omit `instanceId` for the uploader-scoped DRAFT STALE-CHECK (G13);
 * pass it for BOUND metadata on a submitted instance (authorized by the same visibility + hidden-field
 * predicates the byte path uses). Returns `[]` for an empty id list without a round-trip.
 */
export async function fetchApprovalAttachmentRefs(
  ids: readonly string[],
  instanceId?: string,
  fetcher: AttachmentFetcher = apiFetch,
): Promise<AttachmentRefResult[]> {
  const wanted = ids.filter((id) => typeof id === 'string' && id.length > 0)
  if (wanted.length === 0) return []
  const res = await fetcher('/api/approval/attachments/refs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(instanceId ? { ids: wanted, instanceId } : { ids: wanted }),
  })
  if (!res.ok) throw new Error(`attachment refs failed: ${res.status}`)
  // Fail-closed: a 200 with missing/malformed `attachments`, or a PARTIAL set that omits any
  // requested id, is treated as a hard error — never silently degraded to "no attachments".
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new Error('attachment refs failed: malformed_response')
  }
  const attachments = (body as { attachments?: unknown } | null)?.attachments
  if (!Array.isArray(attachments)) {
    throw new Error('attachment refs failed: malformed_response')
  }
  const byId = new Map<string, AttachmentRefResult>()
  for (const entry of attachments) {
    if (!entry || typeof entry !== 'object') {
      throw new Error('attachment refs failed: malformed_response')
    }
    const id = (entry as AttachmentRefResult).id
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('attachment refs failed: malformed_response')
    }
    byId.set(id, entry as AttachmentRefResult)
  }
  const ordered: AttachmentRefResult[] = []
  for (const id of wanted) {
    const entry = byId.get(id)
    if (!entry) throw new Error('attachment refs failed: partial_response')
    ordered.push(entry)
  }
  return ordered
}

/**
 * Upload every file in a multi-file selection atomically at the returned draft-state boundary: if
 * ANY authoritative server upload fails, no partial attachment-id list is returned to the form.
 * Previously-successful uploads from THIS selection are retracted via DELETE when reachable. A
 * successful compensation soft-deletes the row and creates a durable purge intent in one statement;
 * a failed compensation remains an unbound, TTL/GC-eligible orphan. Physical blob deletion is
 * always eventual. Earlier files staged by a prior pick are left alone.
 */
export async function uploadApprovalAttachmentsAtomic(
  files: readonly File[],
  templateId: string,
  fieldId: string,
  fetcher: AttachmentFetcher = apiFetch,
): Promise<UploadedAttachment[]> {
  const uploaded: UploadedAttachment[] = []
  try {
    for (const file of files) {
      uploaded.push(await uploadApprovalAttachment(file, templateId, fieldId, fetcher))
    }
    return uploaded
  } catch (error) {
    // Compensate in reverse so a later retry cannot see a half-applied selection.
    for (const item of [...uploaded].reverse()) {
      await deleteApprovalAttachment(item.id, fetcher).catch(() => {
        // Best-effort: the failed selection returns no ids to the form. A transient DELETE failure
        // can leave an unbound server-side orphan, which the TTL/reconciler must collect.
      })
    }
    throw error
  }
}
