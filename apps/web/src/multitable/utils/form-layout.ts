// Public-form LOGIC layer (A4) — frontend resolvers. Pure, jsdom-trivial
// functions mirroring the backend `form-layout.ts` discipline, in the same
// style as `field-visibility.ts`.
//
// Three concerns:
//   1. PAGE resolution — group the form's visible fields into ordered render
//      pages. RENDER-ONLY: pages never gate validation (the form view keeps
//      validating ALL visible fields). A field referenced by a page but no
//      longer visible is dropped; any visible field NOT assigned to any page
//      falls into a trailing default page so it never silently disappears
//      (mirrors the visibility-rule dangling-dependency discipline).
//   2. PREFILL parsing — read `?prefill_<fieldId>=...` query params into a
//      fieldId-keyed seed map, filtered by the author `prefillableFieldIds`
//      allowlist. CLIENT convenience only; the backend submit masking is the
//      sole authorization gate. Read-only / system / non-allowlisted fields
//      are never seeded (the caller additionally enforces read-only/system).
//   3. REDIRECT safety — re-validate the (already persist-validated) redirect
//      URL before navigation: accept ONLY a same-origin relative path; reject
//      every scheme (javascript:/data:/http(s):) + protocol-relative +
//      backslash-obfuscated + whitespace-smuggled target. Defense-in-depth on
//      a public, unauthenticated page.

import type { FormLayoutConfig, MetaField } from '../types'

export interface ResolvedFormPage {
  id: string
  title?: string
  description?: string
  fields: MetaField[]
}

const DEFAULT_PAGE_ID = '__default__'

/**
 * Resolve the ordered render pages for a form, given the author layout and the
 * already-computed list of currently-visible fields (post field-permission /
 * conditional-visibility filtering — the form view owns that list).
 *
 * No layout / no pages ⇒ a SINGLE implicit page holding every visible field
 * (exactly today's flat form — backward compatible). With pages: each page
 * keeps only the visible fields it references, in the page's declared order;
 * any visible field not claimed by a page is appended to a trailing default
 * page. Empty pages (all their fields hidden/deleted) are dropped.
 */
export function resolveFormPages(
  layout: FormLayoutConfig | null | undefined,
  visibleFields: MetaField[],
): ResolvedFormPage[] {
  const pages = layout?.pages
  if (!pages || pages.length === 0) {
    return [{ id: DEFAULT_PAGE_ID, fields: visibleFields }]
  }

  const visibleById = new Map(visibleFields.map((field) => [field.id, field]))
  const claimed = new Set<string>()
  const resolved: ResolvedFormPage[] = []

  for (const page of pages) {
    const fields: MetaField[] = []
    for (const fieldId of page.fieldIds ?? []) {
      if (claimed.has(fieldId)) continue // a field belongs to the first page that claims it
      const field = visibleById.get(fieldId)
      if (!field) continue // deleted / hidden / not-visible ⇒ drop the dangling ref
      claimed.add(fieldId)
      fields.push(field)
    }
    if (fields.length === 0) continue // skip a page left empty after filtering
    resolved.push({
      id: page.id,
      ...(page.title ? { title: page.title } : {}),
      ...(page.description ? { description: page.description } : {}),
      fields,
    })
  }

  // Any visible field not assigned to a page ⇒ trailing default page (never
  // silently disappears).
  const leftover = visibleFields.filter((field) => !claimed.has(field.id))
  if (leftover.length > 0) {
    resolved.push({ id: DEFAULT_PAGE_ID, fields: leftover })
  }

  // Defensive: if every page filtered to empty AND there were no leftovers
  // (impossible unless visibleFields is empty), still return a single page so
  // the renderer always has something.
  if (resolved.length === 0) {
    return [{ id: DEFAULT_PAGE_ID, fields: visibleFields }]
  }
  return resolved
}

const PREFILL_PREFIX = 'prefill_'

/**
 * Parse `?prefill_<fieldId>=value` query params into a fieldId-keyed seed map,
 * keeping ONLY fields named in the author `prefillableFieldIds` allowlist.
 * Unknown / non-allowlisted params are ignored. The caller is still
 * responsible for not seeding read-only / system fields and for create-mode
 * gating; this is the address+allowlist layer only.
 *
 * `query` accepts the vue-router query shape (string | string[] | null per
 * key); array values take the first string entry.
 */
export function parsePrefillQuery(
  query: Record<string, unknown> | null | undefined,
  layout: FormLayoutConfig | null | undefined,
): Record<string, string> {
  const allowlist = layout?.prefill?.prefillableFieldIds
  if (!query || !allowlist || allowlist.length === 0) return {}
  const allowed = new Set(allowlist)
  const out: Record<string, string> = {}
  for (const [key, rawValue] of Object.entries(query)) {
    if (!key.startsWith(PREFILL_PREFIX)) continue
    const fieldId = key.slice(PREFILL_PREFIX.length)
    if (!fieldId || !allowed.has(fieldId)) continue
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue
    if (typeof value !== 'string') continue
    out[fieldId] = value
  }
  return out
}

/**
 * Re-validate an author-configured post-submit redirect URL before navigation.
 * Returns the safe same-origin relative path, or `null` when unsafe / absent.
 * Mirrors the backend `sanitizeFormRedirectUrl` policy exactly so the two
 * layers agree (the backend already rejected unsafe URLs at persist time; this
 * is defense-in-depth on the public page).
 */
export function safeRedirectPath(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (!raw || raw.length > 2048) return null
  // Reject control / whitespace (defeats `java\tscript:` and newline smuggling).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f]/.test(raw) || /\s/.test(raw)) return null
  if (raw.includes('\\')) return null
  if (!raw.startsWith('/')) return null
  if (raw.startsWith('//')) return null
  // No scheme in the first path segment (rejects parser-quirk smuggling).
  const slash = raw.indexOf('/', 1)
  const query = raw.indexOf('?')
  const hash = raw.indexOf('#')
  const ends = [slash, query, hash].filter((index) => index >= 0)
  const firstSegmentEnd = ends.length ? Math.min(...ends) : raw.length
  if (raw.slice(0, firstSegmentEnd).includes(':')) return null
  return raw
}
