// P3-3 — server-backed replacement for the storage side of `formDraft.ts`. The schema-drift
// signature (`formSchemaSignature`), the "one (user, template) slot" keying concept, and every
// fail-safe SEMANTIC (never throw, empty-ish data clears instead of writing, a signature mismatch
// returns null + best-effort GC) are UNCHANGED from `formDraft.ts` — only the STORAGE MEDIUM moved
// from an injected `Storage`-shaped object (today `window.localStorage`) to the server, which is
// what makes the draft cross-device and listable in a drafts inbox. `formSchemaSignature` itself
// stays in `formDraft.ts` and is still computed by the caller (unchanged) — this module never
// re-derives it.
//
// FAIL-SAFE DISCIPLINE (contract §4 D): every exported function here swallows every failure
// (network error, non-2xx, malformed JSON) exactly like `formDraft.ts` swallows storage
// quota/privacy-mode/parse failures — a broken server draft layer must never break the form itself,
// and never surfaces as a visible error to the user.
import { apiFetch } from '../utils/api'

export type ServerFormDraftFetcher = (path: string, init?: RequestInit) => Promise<Response>

function draftPath(templateId: string): string {
  return `/api/approvals/form-drafts/${encodeURIComponent(templateId)}`
}

function isMeaningful(data: Record<string, unknown>): boolean {
  return Object.values(data).some(
    (value) => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0),
  )
}

/** Gate2 P3-F: `typeof x === 'object'` alone is not "a genuine record" — it is ALSO true for
 *  `null` (a JS quirk) and for arrays, so a naive check needs two extra disjuncts to rule those
 *  out. `loadFormDraftServer` previously spelled that out as separate `||` terms in each of two
 *  places (once for `draft`, once for `draft.data`) — six terms total, five of which turned out to
 *  be non-load-bearing under mutation (each was either implied by another term for every value
 *  `unknown` JSON can actually produce, or converged on the same final observable result via the
 *  function's own outer `catch`). Collapsing both call sites onto ONE named predicate removes the
 *  duplication without dropping any of the three genuinely distinct questions this function needs
 *  answered: is `draft` itself a real object, does its signature match, and is `draft.data` a real
 *  object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Persist a draft, or delete it when `data` carries no meaningful value — same decision
 *  `formDraft.ts`'s `saveFormDraft` makes for localStorage (:54-60), now deciding PUT vs DELETE
 *  instead of setItem vs removeItem. Never throws. */
export async function saveFormDraftServer(
  templateId: string,
  signature: string,
  data: Record<string, unknown>,
  fetcher: ServerFormDraftFetcher = apiFetch,
): Promise<void> {
  try {
    if (!isMeaningful(data)) {
      await fetcher(draftPath(templateId), { method: 'DELETE' })
      return
    }
    await fetcher(draftPath(templateId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature, data }),
    })
  } catch {
    // network failure / server error — drafting silently unavailable (mirrors formDraft.ts's
    // quota/privacy-mode swallow).
  }
}

/** Load a draft matching the CURRENT schema signature; anything else -> null (+ best-effort GC),
 *  mirroring `formDraft.ts`'s `loadFormDraft` (:69-97) exactly, one layer up. Never throws. */
export async function loadFormDraftServer(
  templateId: string,
  expectedSignature: string,
  fetcher: ServerFormDraftFetcher = apiFetch,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetcher(draftPath(templateId), { method: 'GET' })
    if (!res.ok) return null
    const body = (await res.json().catch(() => null)) as
      | { data?: { draft?: { signature?: unknown; data?: unknown } | null } }
      | null
    const draft = body?.data?.draft
    // Gate2 P3-F: three checks, not six — `isPlainObject`'s own comment covers why the five raw
    // terms this replaced were redundant AMONG THEMSELVES. Of these three, two are independently
    // load-bearing under mutation: the signature comparison (the actual drift guard), and
    // `isPlainObject(draft.data)` (a matching signature with non-object `data` — e.g. an array —
    // must still be rejected; see the spec's "MALFORMED" test). The leading `isPlainObject(draft)`
    // is NOT independently load-bearing for any value real JSON can produce: `draft` is either
    // `null`/`undefined` (then `draft.signature` below would throw, caught by this function's own
    // outer `catch`, landing on the identical "return null, no GC" outcome) or some non-object
    // primitive (then `draft.signature` reads as `undefined`, which the signature-mismatch term
    // already catches). It stays anyway — not for that boolean contribution, but because it is what
    // lets TypeScript narrow `draft` to `Record<string, unknown>` for the two property accesses
    // that follow, without scattering `?.`/`any` through the rest of this function for a
    // distinction no runtime test could ever tell apart from those two terms.
    if (!isPlainObject(draft) || draft.signature !== expectedSignature || !isPlainObject(draft.data)) {
      if (isPlainObject(draft)) {
        // best-effort GC of a stale/mismatched/malformed draft, fire-and-forget (mirrors
        // formDraft.ts's best-effort removeItem on drift). THIS `isPlainObject(draft)` check IS
        // independently load-bearing (unlike its twin above): gating on it rather than truthy
        // `draft` is what stops a wasted DELETE when `draft` was never a real object to begin with
        // — a bare string/number/null `draft` reaches this branch via the signature-mismatch term
        // above (see: "a `draft` that is a bare string" / "NO-DRAFT" in the spec), and only this
        // check tells "nothing was there to clean up" apart from "there was a stale draft".
        fetcher(draftPath(templateId), { method: 'DELETE' }).catch(() => {})
      }
      return null
    }
    return draft.data as Record<string, unknown>
  } catch {
    return null
  }
}

export async function clearFormDraftServer(
  templateId: string,
  fetcher: ServerFormDraftFetcher = apiFetch,
): Promise<void> {
  try {
    await fetcher(draftPath(templateId), { method: 'DELETE' })
  } catch {
    /* fail-safe, mirrors formDraft.ts's clearFormDraft */
  }
}

export interface ServerFormDraftListEntry {
  templateId: string
  signature: string
  savedAt: string
}

/** Drafts-inbox listing (contract §0 "多草稿与草稿箱入口" — the list endpoint; no UI is wired to
 *  it in this slice, see the PR body). Never throws — an empty list on any failure. */
export async function listFormDraftsServer(
  fetcher: ServerFormDraftFetcher = apiFetch,
): Promise<ServerFormDraftListEntry[]> {
  try {
    const res = await fetcher('/api/approvals/form-drafts', { method: 'GET' })
    if (!res.ok) return []
    const body = (await res.json().catch(() => null)) as
      | { data?: { drafts?: Array<{ templateId?: unknown; signature?: unknown; savedAt?: unknown }> } }
      | null
    const drafts = body?.data?.drafts
    if (!Array.isArray(drafts)) return []
    return drafts.filter(
      (entry): entry is ServerFormDraftListEntry =>
        typeof entry?.templateId === 'string' && typeof entry?.signature === 'string' && typeof entry?.savedAt === 'string',
    )
  } catch {
    return []
  }
}
