/**
 * PROPOSED (H-3, 2026-09-22) — candidate mitigations for user-supplied regex in
 * the formula engine. NOT ratified: `formula/engine.ts` is a runtime-contract
 * "frozen core" (see `multitable/formula-engine.ts` dryRun note) and every export
 * here changes an observable formula behaviour, so the owner decides whether and
 * which of these land. See docs/development/input-regex-redos-census-*.md.
 *
 * Background: REGEXMATCH / REGEXEXTRACT / REGEXREPLACE compile a caller-authored
 * string into `new RegExp(...)`, and SUBSTITUTE compiled arg-2 into a regex too.
 * A 57-character formula expression froze an unrelated tenant's request for ~55s
 * on the shared single-threaded event loop (measured; see verification MD).
 */

/**
 * Excel / Google-Sheets SUBSTITUTE is a LITERAL text replacement, not a regex
 * one. `split(old).join(new)` is O(n), matches the spec exactly, and removes the
 * ReDoS vector entirely — arg-2 never reaches a regex engine.
 *
 * Excel semantics preserved: an empty `old_text` returns `text` unchanged.
 */
export function substituteLiteral(text: string, oldText: string, newText: string): string {
  if (oldText === '') return text
  return text.split(oldText).join(newText)
}
