/**
 * Approval attachment REFERENCE resolution — B3-07 §8 (#4195).
 *
 * The frozen `form_snapshot` stores an attachment field's value as an ordered array of
 * `approval_attachments.id` strings — references, never blobs and never live pointers. This module is
 * the ONE pure resolver used by the responsive approval detail surface to turn those frozen ids into
 * something a reader can see on desktop and mobile. Pure + Element-Plus-free so it runs under the
 * approval-web-guard vitest gate. A distinct history renderer is not claimed here.
 *
 * Two hard rules it exists to enforce:
 *
 *   1. **Resolve BY THE FROZEN ID, never by re-deriving.** An id whose row is gone or soft-deleted
 *      renders as a TOMBSTONE, never as a different file — a post-submit mutation of the underlying
 *      storage can therefore never silently change what a reader sees (§8, G5).
 *   2. **Never fabricate metadata.** A ref the server did not return metadata for renders as a
 *      tombstone with no name and no size — this module never invents a filename, a byte count or a
 *      download link for something it could not resolve. (An unresolved ref is a fact to surface, not
 *      a blank to fill in.)
 *
 * The server (`POST /api/approval/attachments/refs`) remains authoritative for BOTH visibility and
 * hiddenness: it omits refs on a field hidden at the active node exactly as the snapshot echo strips
 * them, so a ref that is simply absent from the response is rendered as nothing at all — not as a
 * tombstone, which would leak the existence of a hidden field's attachment.
 */

export interface AttachmentRefMetadata {
  id: string
  tombstone?: boolean
  fieldId?: string
  fileName?: string
  sizeBytes?: number
  mimeType?: string
  downloadUrl?: string
}

export interface ResolvedAttachmentRef {
  id: string
  /** true ⇒ the row is gone/soft-deleted: show the tombstone, never a name, size or link. */
  tombstone: boolean
  /** present only for a resolved ref — never synthesised from the id. */
  fileName?: string
  sizeBytes?: number
  downloadUrl?: string
}

/** A form field carrying an attachment id array, plus its resolved refs — the render unit. */
export interface AttachmentFieldDisplay {
  fieldId: string
  label: string
  refs: ResolvedAttachmentRef[]
}

interface SchemaLike {
  fields?: ReadonlyArray<{ id?: unknown; type?: unknown; label?: unknown } | null | undefined> | null
}

/** True only for a non-blank string id — the same shape the server's `[!-~]` guard accepts. */
function isRefId(value: unknown): value is string {
  return typeof value === 'string' && /[!-~]/.test(value)
}

/**
 * Every attachment id referenced by the snapshot, in schema order then array order, de-duplicated.
 * Only `attachment`-typed fields are read, and only array values — a malformed value contributes
 * nothing rather than being coerced into a bogus id.
 */
export function collectAttachmentRefIds(
  formSchema: SchemaLike | null | undefined,
  formSnapshot: Readonly<Record<string, unknown>> | null | undefined,
): string[] {
  const snapshot = formSnapshot ?? {}
  const out: string[] = []
  const seen = new Set<string>()
  for (const field of formSchema?.fields ?? []) {
    if (!field || field.type !== 'attachment' || typeof field.id !== 'string') continue
    const value = snapshot[field.id]
    if (!Array.isArray(value)) continue
    for (const id of value) {
      if (!isRefId(id) || seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

/**
 * Build the per-field display units for a submitted instance. `metadata` is what the server resolved
 * (keyed by id); an id the server omitted entirely is HIDDEN (§8 redaction inheritance) and is dropped,
 * while an id the server returned as `tombstone` is surfaced as a tombstone. A field left with no
 * renderable ref produces no display unit at all.
 */
export function resolveAttachmentFields(
  formSchema: SchemaLike | null | undefined,
  formSnapshot: Readonly<Record<string, unknown>> | null | undefined,
  metadata: ReadonlyArray<AttachmentRefMetadata>,
): AttachmentFieldDisplay[] {
  const snapshot = formSnapshot ?? {}
  const byId = new Map(metadata.map((entry) => [entry.id, entry]))
  const result: AttachmentFieldDisplay[] = []
  for (const field of formSchema?.fields ?? []) {
    if (!field || field.type !== 'attachment' || typeof field.id !== 'string') continue
    const value = snapshot[field.id]
    if (!Array.isArray(value)) continue
    const refs: ResolvedAttachmentRef[] = []
    for (const id of value) {
      if (!isRefId(id)) continue
      const entry = byId.get(id)
      if (!entry) continue // hidden at the active node (server omitted it) ⇒ render nothing
      if (entry.tombstone || !entry.fileName) {
        // Never fabricate: an unresolved/deleted ref gets the tombstone and NO name/size/link.
        refs.push({ id, tombstone: true })
        continue
      }
      refs.push({
        id,
        tombstone: false,
        fileName: entry.fileName,
        ...(typeof entry.sizeBytes === 'number' && Number.isFinite(entry.sizeBytes) ? { sizeBytes: entry.sizeBytes } : {}),
        // Only the approval-scoped proxied URL is ever rendered; a raw storage url is never accepted.
        ...(typeof entry.downloadUrl === 'string' && entry.downloadUrl.startsWith('/api/approval/attachments/')
          ? { downloadUrl: entry.downloadUrl }
          : {}),
      })
    }
    if (refs.length === 0) continue
    const label = typeof field.label === 'string' && field.label.length > 0 ? field.label : field.id
    result.push({ fieldId: field.id, label, refs })
  }
  return result
}

/** Human byte size for display. Values-free by construction — it only formats a number it was given. */
export function formatAttachmentSize(sizeBytes: number | undefined): string {
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes < 0) return ''
  if (sizeBytes < 1024) return `${sizeBytes} B`
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
}

export interface StaleDraftScan {
  /** the draft data with every stale attachment ref removed (fields left empty are set to `[]`). */
  data: Record<string, unknown>
  /** the ids that were dropped — non-empty ⇒ tell the user their staged files expired. */
  staleIds: string[]
}

/**
 * G13 / O2 — **stale draft-reference detection on restore.**
 *
 * A saved draft can hold ids of still-`unbound` uploads, and those rows are GC-swept once they pass
 * the ratified 7-day retention TTL. Restoring such a draft unmodified would carry a DANGLING id into
 * a create-instance, where the bind fails closed and the whole submission is rejected with nothing
 * the user can act on. So on restore the caller asks the server which ids are still live
 * (`POST /api/approval/attachments/refs` with `{ ids }`, uploader-scoped) and passes the stale set
 * here: every stale id is DROPPED from the restored draft and returned so the caller can tell the
 * user, rather than silently keeping a dead reference or resolving it to a deleted blob.
 *
 * Fail-closed on shape: a non-array value under an attachment field is replaced with `[]` — a
 * malformed persisted value is never carried into a submission half-interpreted.
 */
export function dropStaleAttachmentRefs(
  formSchema: SchemaLike | null | undefined,
  draftData: Readonly<Record<string, unknown>> | null | undefined,
  staleIds: Iterable<string>,
): StaleDraftScan {
  const data: Record<string, unknown> = { ...(draftData ?? {}) }
  const stale = new Set(staleIds)
  const dropped: string[] = []
  for (const field of formSchema?.fields ?? []) {
    if (!field || field.type !== 'attachment' || typeof field.id !== 'string') continue
    if (!Object.prototype.hasOwnProperty.call(data, field.id)) continue
    const value = data[field.id]
    if (!Array.isArray(value)) {
      data[field.id] = []
      continue
    }
    const kept: string[] = []
    for (const id of value) {
      if (!isRefId(id)) continue
      if (stale.has(id)) dropped.push(id)
      else kept.push(id)
    }
    data[field.id] = kept
  }
  return { data, staleIds: dropped }
}
