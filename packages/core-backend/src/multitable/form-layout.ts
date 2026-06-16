// Public-form LOGIC layer (A4: multi-page/section · URL-prefill · post-submit
// redirect · thank-you customization). Canonical normalizer + the SAFE
// form-context projection, shared by the PATCH write path and the GET
// /form-context read path so the two surfaces can never drift.
//
// WHERE it lives: A4 config is stored under `view.config.formLayout`, a key
// SEPARATE from `view.config.publicForm` (access-control: token/allowlist/
// expiry). Presentation/logic (pages, prefill, redirect, confirmation) and
// access-control are unrelated concerns; keeping them apart keeps sanitizer
// ownership clean and avoids entangling a public-renderable blob with secrets.
//
// SECURITY (this module is the chokepoint for three controls):
//   1. Pages are RENDER-time grouping only. They never gate validation or
//      submission — the form view validates ALL visible fields regardless of
//      page. A page model is presentation, never a security boundary.
//   2. Prefill is CLIENT-seeding convenience. `prefillableFieldIds` is an
//      author allowlist of fields a share-link may pre-populate; it is NOT
//      authorization. The backend submit masking is unchanged and remains the
//      sole gate on what a field may persist.
//   3. The post-submit redirect URL is author-controlled config rendered on a
//      PUBLIC, unauthenticated page. `sanitizeFormRedirectUrl` rejects every
//      non-`http(s)` scheme (javascript:/data:/...) and protocol-relative /
//      backslash-obfuscated targets, accepting ONLY a same-origin relative
//      path (open-redirect / stored-XSS defense). Validated at persist time
//      here AND again before navigation on the client.
//   4. The thank-you confirmation text is author DATA. It is rendered as plain
//      text interpolation on the client (never v-html); this module only
//      length-bounds it.
//
// The SAFE projection (`projectPublicFormLayout`) returns ONLY the four
// presentational sub-objects. It is what the anonymous form-context echoes —
// it must never carry `publicForm` (publicToken / allowedUserIds) or any other
// view.config key. Whitelist by construction, never blacklist.

export type FormPage = {
  id: string
  title?: string
  description?: string
  fieldIds: string[]
}

export type FormPrefillConfig = {
  // Author allowlist of fields a share link may pre-populate via query params.
  prefillableFieldIds: string[]
}

export type FormRedirectConfig = {
  // A validated same-origin relative path (always starts with a single '/').
  url: string
}

export type FormConfirmationConfig = {
  title?: string
  body?: string
}

export type FormLayoutConfig = {
  pages?: FormPage[]
  prefill?: FormPrefillConfig
  redirect?: FormRedirectConfig
  confirmation?: FormConfirmationConfig
}

// Bounds (defensive — author data on a public surface, never trust length).
const MAX_PAGES = 50
const MAX_FIELDS_PER_PAGE = 500
const MAX_PREFILLABLE = 500
const MAX_TITLE_LEN = 200
const MAX_DESCRIPTION_LEN = 2000
const MAX_REDIRECT_LEN = 2048
const MAX_CONFIRMATION_TITLE_LEN = 200
const MAX_CONFIRMATION_BODY_LEN = 5000

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function cleanString(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, maxLen)
}

function cleanStringIdArray(value: unknown, maxLen: number): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= maxLen) break
  }
  return out
}

/**
 * Validate an author-supplied post-submit redirect target. Returns the
 * canonical same-origin relative path, or `null` when unsafe / absent.
 *
 * SAFE policy (open-redirect / stored-XSS defense on a public unauthenticated
 * page): accept ONLY a same-origin relative path. A relative path:
 *   - starts with a single '/',
 *   - is NOT protocol-relative ('//host') nor a backslash-obfuscated variant
 *     ('/\', '\/', '\\'), which browsers can resolve to a foreign origin,
 *   - contains no control / whitespace characters (defeats `java\tscript:`
 *     and newline-smuggling tricks),
 *   - contains no scheme (a ':' before the first '/' or '?'), so absolute
 *     `http(s):` / `javascript:` / `data:` targets are all rejected.
 *
 * Cross-origin absolute http(s) via an author allowlist is the SAFE-deferred
 * fork (see ownerDeferred): not enabled here.
 */
export function sanitizeFormRedirectUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (!raw || raw.length > MAX_REDIRECT_LEN) return null
  // Reject any control / whitespace char anywhere (tab/newline scheme-smuggling
  // like `java\tscript:`, plus any Unicode whitespace).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f]/.test(raw) || /\s/.test(raw)) return null
  // Normalize backslashes the way browsers do, then reject protocol-relative
  // and backslash forms outright.
  if (raw.includes('\\')) return null
  if (!raw.startsWith('/')) return null
  if (raw.startsWith('//')) return null
  // No scheme allowed: a ':' appearing before the path is delimited (before any
  // '/', '?', '#') would mean an absolute/opaque URL slipped through. Since the
  // value already starts with '/', the only ':' risk is inside the path/query,
  // which is benign for a same-origin navigation. Still, hard-reject a ':' in
  // the first path segment to be conservative against parser quirks.
  const firstSegmentEnd = (() => {
    const slash = raw.indexOf('/', 1)
    const query = raw.indexOf('?')
    const hash = raw.indexOf('#')
    const candidates = [slash, query, hash].filter((index) => index >= 0)
    return candidates.length ? Math.min(...candidates) : raw.length
  })()
  if (raw.slice(0, firstSegmentEnd).includes(':')) return null
  return raw
}

function sanitizeFormPages(input: unknown): FormPage[] | undefined {
  if (!Array.isArray(input)) return undefined
  const pages: FormPage[] = []
  const seenIds = new Set<string>()
  for (const candidate of input) {
    if (!isPlainObject(candidate)) continue
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
    if (!id || seenIds.has(id)) continue
    seenIds.add(id)
    const page: FormPage = {
      id,
      fieldIds: cleanStringIdArray(candidate.fieldIds, MAX_FIELDS_PER_PAGE),
    }
    const title = cleanString(candidate.title, MAX_TITLE_LEN)
    if (title) page.title = title
    const description = cleanString(candidate.description, MAX_DESCRIPTION_LEN)
    if (description) page.description = description
    pages.push(page)
    if (pages.length >= MAX_PAGES) break
  }
  return pages.length ? pages : undefined
}

function sanitizeFormPrefill(input: unknown): FormPrefillConfig | undefined {
  if (!isPlainObject(input)) return undefined
  const prefillableFieldIds = cleanStringIdArray(input.prefillableFieldIds, MAX_PREFILLABLE)
  if (!prefillableFieldIds.length) return undefined
  return { prefillableFieldIds }
}

function sanitizeFormRedirect(input: unknown): FormRedirectConfig | undefined {
  if (!isPlainObject(input)) return undefined
  const url = sanitizeFormRedirectUrl(input.url)
  if (!url) return undefined
  return { url }
}

function sanitizeFormConfirmation(input: unknown): FormConfirmationConfig | undefined {
  if (!isPlainObject(input)) return undefined
  const confirmation: FormConfirmationConfig = {}
  const title = cleanString(input.title, MAX_CONFIRMATION_TITLE_LEN)
  if (title) confirmation.title = title
  const body = cleanString(input.body, MAX_CONFIRMATION_BODY_LEN)
  if (body) confirmation.body = body
  return title || body ? confirmation : undefined
}

/**
 * Normalize an untrusted `formLayout` candidate into a canonical, bounded shape,
 * or `null` when it is absent / fully empty. A redirect with an unsafe URL is
 * dropped (the rest of the layout still persists). Mirrors the
 * `sanitizeFieldVisibilityRule` discipline: a single normalizer shared by the
 * read-serialize and write paths.
 */
export function sanitizeFormLayout(input: unknown): FormLayoutConfig | null {
  if (!isPlainObject(input)) return null
  const layout: FormLayoutConfig = {}
  const pages = sanitizeFormPages(input.pages)
  if (pages) layout.pages = pages
  const prefill = sanitizeFormPrefill(input.prefill)
  if (prefill) layout.prefill = prefill
  const redirect = sanitizeFormRedirect(input.redirect)
  if (redirect) layout.redirect = redirect
  const confirmation = sanitizeFormConfirmation(input.confirmation)
  if (confirmation) layout.confirmation = confirmation
  return Object.keys(layout).length ? layout : null
}

/**
 * Merge a sanitized `formLayout` into a view config object. Absent / empty
 * candidate ⇒ the `formLayout` key is omitted (so a view without A4 config
 * round-trips clean, with no noise key). Mirrors `withFieldVisibilityRule`.
 */
export function withFormLayout(
  config: Record<string, unknown>,
  rawLayout: unknown,
): Record<string, unknown> {
  const layout = sanitizeFormLayout(rawLayout)
  if (!layout) {
    if ('formLayout' in config) {
      const { formLayout: _omit, ...rest } = config
      return rest
    }
    return config
  }
  return { ...config, formLayout: layout }
}

/**
 * SAFE projection for the anonymous form-context echo. Reads `view.config`
 * and returns ONLY the sanitized presentational form-layout sub-objects.
 *
 * By construction this can NEVER carry `view.config.publicForm`
 * (publicToken / allowedUserIds) or any other view-config key to an anonymous
 * caller — it is a whitelist, not a `delete publicForm` blacklist. Returns
 * `null` when there is no usable layout (so the form-context omits the key and
 * the renderer falls back to today's flat single-page form).
 */
export function projectPublicFormLayout(config: unknown): FormLayoutConfig | null {
  if (!isPlainObject(config)) return null
  return sanitizeFormLayout(config.formLayout)
}
