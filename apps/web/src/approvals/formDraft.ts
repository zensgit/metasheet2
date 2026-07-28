import type { FormSchema } from '../types/approval'

// G-B2-14 (benchmark §7.2) — 填单草稿自动保存/恢复. PURE logic module (no .vue / EP import) so it
// runs under the approval-web-guard vitest gate. Storage is INJECTED (any Storage-shaped object)
// — the view passes window.localStorage; tests pass an in-memory fake. Server-side drafts are
// explicitly out of scope at this stage (benchmark note).
//
// Fail-safe discipline: every entry point swallows storage/parse failures (quota, privacy mode,
// corrupted JSON) — a broken draft layer must NEVER break the form itself. The schema signature
// guards drift: a template whose field set/types changed since the draft was written treats the
// draft as absent (and best-effort removes it) instead of restoring stale shapes.

export interface StoredFormDraft {
  signature: string
  savedAt: string
  data: Record<string, unknown>
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** One draft per user+template. */
export function formDraftKey(userId: string, templateId: string): string {
  return `approval-form-draft:${userId}:${templateId}`
}

/** Drift guard: field ids + types, order-independent. Attachment fields are excluded — they are
 *  never draft-persisted (no working uploader; refs would be meaningless across sessions).
 *  FWB-0 Layer 2: record-link pins (baseId+sheetId) are part of the signature so a repinned
 *  target invalidates drafts that still hold a prior recordId for the old sheet. */
export function formSchemaSignature(schema: FormSchema): string {
  return (schema.fields ?? [])
    .filter((field) => field.type !== 'attachment')
    .map((field) => {
      if (field.type === 'record-link') {
        const baseId = typeof field.props?.baseId === 'string' ? field.props.baseId.trim() : ''
        const sheetId = typeof field.props?.sheetId === 'string' ? field.props.sheetId.trim() : ''
        return `${field.id}:record-link:${baseId}:${sheetId}`
      }
      return `${field.id}:${field.type}`
    })
    .sort()
    .join('|')
}

/** Persist a draft. `data` should already exclude attachment fields (caller strips). Empty-ish
 *  data (no meaningful value) clears instead of saving — an untouched form leaves no residue. */
export function saveFormDraft(
  storage: StorageLike,
  key: string,
  signature: string,
  data: Record<string, unknown>,
): void {
  try {
    const meaningful = Object.values(data).some(
      (value) => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0),
    )
    if (!meaningful) {
      storage.removeItem(key)
      return
    }
    const draft: StoredFormDraft = { signature, savedAt: new Date().toISOString(), data }
    storage.setItem(key, JSON.stringify(draft))
  } catch {
    // quota / privacy mode — drafting silently unavailable.
  }
}

/** Load a draft matching the CURRENT schema signature; anything else → null (+ best-effort GC). */
export function loadFormDraft(
  storage: StorageLike,
  key: string,
  expectedSignature: string,
): Record<string, unknown> | null {
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredFormDraft> | null
    if (
      !parsed
      || typeof parsed !== 'object'
      || parsed.signature !== expectedSignature
      || !parsed.data
      || typeof parsed.data !== 'object'
      || Array.isArray(parsed.data)
    ) {
      try {
        storage.removeItem(key)
      } catch {
        /* best-effort GC */
      }
      return null
    }
    return parsed.data as Record<string, unknown>
  } catch {
    return null
  }
}

export function clearFormDraft(storage: StorageLike, key: string): void {
  try {
    storage.removeItem(key)
  } catch {
    /* fail-safe */
  }
}
