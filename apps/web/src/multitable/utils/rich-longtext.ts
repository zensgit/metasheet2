// Rich-`longText` client-side sanitizer + plain-text projection (§5 / §7 of the
// multitable rich-text design-lock, 2026-06-14).
//
// THIS MODULE IS THE SINGLE SOURCE OF TRUTH for the front-end allow-list. The
// render component, its specs, and any other FE consumer import the SAME config
// from here — never re-declare the allow-list inline (that would let a render
// surface ship a looser policy than the tests assert: wire-vs-fixture drift).
//
// Defense-in-depth (§2.2): the SERVER already sanitizes rich-`longText` on write
// (`sanitizeRichLongText`, sanitize-html) so the stored value is inert by
// construction. This client pass re-sanitizes on EVERY render because the
// browser's HTML parser can mutate server-clean markup on re-parse (mutation-XSS
// / mXSS). Client re-sanitize is therefore load-bearing, not optional.
//
// The allow-list here MUST stay in lock-step with the server's
// `RICH_LONGTEXT_SANITIZE_OPTIONS` (packages/core-backend/.../field-codecs.ts).

import DOMPurify, { type Config as DOMPurifyConfig } from 'dompurify'
import type { MetaField } from '../types'

/**
 * Allowed tags (§5) — inline marks, links, lists, headings, block text.
 * Identical set to the server allow-list.
 */
export const RICH_LONGTEXT_ALLOWED_TAGS = [
  'b', 'strong', 'i', 'em', 'u', 's',
  'a',
  'ul', 'ol', 'li',
  'h1', 'h2', 'h3',
  'p', 'br', 'blockquote', 'code', 'pre',
] as const

/**
 * Allowed attributes (§5): `href` on `<a>` only. `rel`/`target` are FORCED by the
 * post-sanitize hook below (never user-controlled) but must be allow-listed or
 * DOMPurify would strip them right after the hook adds them.
 */
export const RICH_LONGTEXT_ALLOWED_ATTR = ['href', 'rel', 'target'] as const

/**
 * Tags dropped WITH their contents (no inner-text leak). DOMPurify already drops
 * most of these with content, but listing them in FORBID_TAGS + KEEP_CONTENT:false
 * makes the policy explicit and matches the server's `nonTextTags`.
 */
export const RICH_LONGTEXT_FORBID_TAGS = [
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'svg', 'noscript', 'textarea', 'title',
] as const

/**
 * Protocol allow-list (§5): `http`, `https`, `mailto` only. DOMPurify decodes
 * entity-encoded protocols (e.g. `&#106;avascript:`) BEFORE testing this regexp,
 * so `javascript:` is rejected whether plain or encoded. `//evil.com`
 * (protocol-relative) and `data:` are rejected too — the regexp requires one of
 * the three schemes at the very start.
 */
export const RICH_LONGTEXT_ALLOWED_URI_REGEXP = /^(?:https?|mailto):/i

/**
 * The DOMPurify config object passed on EVERY sanitize. Frozen so a consumer
 * cannot mutate the shared policy at runtime.
 */
export const RICH_LONGTEXT_SANITIZE_CONFIG: Readonly<DOMPurifyConfig> = Object.freeze({
  ALLOWED_TAGS: [...RICH_LONGTEXT_ALLOWED_TAGS],
  ALLOWED_ATTR: [...RICH_LONGTEXT_ALLOWED_ATTR],
  FORBID_TAGS: [...RICH_LONGTEXT_FORBID_TAGS],
  // Drop these tags WITH their inner content (mirror the server `nonTextTags`) so a
  // `<noscript>…`-style mXSS payload can't leak its inner text. This is scoped to the
  // forbidden set ONLY — keeping global KEEP_CONTENT at its default (true) so the text
  // INSIDE allowed tags (e.g. `<strong>hi</strong>`) is preserved, and text around a
  // non-allowed wrapper (e.g. an unwrapped `<div>`) is kept too.
  FORBID_CONTENTS: [...RICH_LONGTEXT_FORBID_TAGS],
  ALLOWED_URI_REGEXP: RICH_LONGTEXT_ALLOWED_URI_REGEXP,
  // No CSS / data-URIs / unknown protocols anywhere.
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  // Return a string (not a DOM node).
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
  // Defense against template-injection style breakouts.
  SAFE_FOR_TEMPLATES: false,
})

let linkHookInstalled = false

/**
 * Install (once) the post-sanitize hook that FORCES `rel="noopener noreferrer"`
 * and `target="_blank"` on every surviving `<a>`. This runs after DOMPurify has
 * already stripped any unsafe href (protocol not in the allow-list), so the
 * forced attributes only ever land on links DOMPurify kept. Anchors whose href
 * was rejected are left without href — harmless, inert text-bearing anchors.
 */
function ensureLinkHardeningHook(): void {
  if (linkHookInstalled) return
  // `afterSanitizeAttributes` fires per-node after attribute filtering.
  DOMPurify.addHook('afterSanitizeAttributes', (node: Element) => {
    if (node.nodeName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('rel', 'noopener noreferrer')
      node.setAttribute('target', '_blank')
    }
  })
  linkHookInstalled = true
}

/**
 * Sanitize a rich-`longText` HTML string against the §5 allow-list, returning
 * allow-list-clean HTML safe to bind with `v-html`. Pure relative to the shared
 * config; runs on every call (mXSS defense — see module header).
 *
 * Coerces non-string input to '' so a malformed value can never reach `v-html`.
 */
export function sanitizeRichLongTextHtml(value: unknown): string {
  if (typeof value !== 'string' || value === '') return ''
  ensureLinkHardeningHook()
  // The cfg has no RETURN_DOM* flag, so this overload of sanitize returns a string.
  return DOMPurify.sanitize(value, RICH_LONGTEXT_SANITIZE_CONFIG)
}

/**
 * Unified FE plain-text projection (§7): strip ALL tags from a (possibly rich)
 * `longText` value down to its text content, so the grid cell shows readable text
 * (never `<p>…</p>`). Uses DOMPurify with an empty tag allow-list — the same
 * decode-then-strip approach the server projection (`richLongTextToPlainText`)
 * uses, kept symmetric. Safe on plain (non-rich) values too: they have no tags,
 * so the value is returned effectively unchanged (entities decoded).
 *
 * NOTE: the server owns the export and (deferred) search projections (#2598:
 * `univer-meta.ts` export, `query-service.ts` search). This FE helper's sole
 * consumer is the grid-cell display projection — see the design reconciliation
 * note in the PR. One helper, here, for the FE render lane.
 */
export function richLongTextToPlainTextFE(value: unknown): string {
  if (typeof value !== 'string' || value === '') return ''
  const stripped = DOMPurify.sanitize(value, {
    ALLOWED_TAGS: [],
    ALLOWED_ATTR: [],
    KEEP_CONTENT: true,
  })
  // Collapse residual whitespace introduced by block-tag removal so the grid cell
  // reads as a single clean line of text.
  return stripped.replace(/\s+/g, ' ').trim()
}

/**
 * Strict predicate: is this field a RICH `longText` (`property.rich === true`)?
 * Mirrors the server's `isRichLongTextProperty` so every FE gate (renderer,
 * editor, drawer, form) opts in identically. Anything other than the literal
 * boolean `true` → not rich (today's plain behavior, unchanged).
 */
export function isRichLongTextField(field: Pick<MetaField, 'type' | 'property'>): boolean {
  return (
    field.type === 'longText' &&
    !!field.property &&
    typeof field.property === 'object' &&
    (field.property as Record<string, unknown>).rich === true
  )
}
