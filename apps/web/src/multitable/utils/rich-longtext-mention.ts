// B5 — longText in-cell @mention (people) seams.
//
// The @-trigger detection and chip-insert for the rich-`longText` editor are
// NET-NEW contenteditable code (the comment composer's <textarea>+string mechanic
// does NOT transfer to a DOM + Selection/Range surface). To keep the orchestration
// unit-testable in jsdom — and to avoid the documented false-green trap where a
// test asserts a hand-built chip while the real input→selection→insert path is
// never exercised — the load-bearing pieces live here as small INJECTABLE seams:
//
//   - detectMentionQuery: parse the active "@query" the caret is typing.
//   - buildMentionChip:   construct the chip <span> via createElement/textContent
//                         (NEVER innerHTML — a member label may contain markup).
//   - insertMentionChipAtRange: splice the chip at a real DOM Range (insertNode,
//                         NOT execCommand — execCommand no-ops in jsdom).
//
// SECURITY: the chip is `<span data-mention-id="id">@Label</span>`. The id +
// textContent reconstruct EXACTLY the comment token `@[label](id)` so a future
// shared server-side mention parser (the deferred notify slice) is trivial. The
// span + data-mention-id pair is allow-listed IDENTICALLY on both sanitizers
// (rich-longtext.ts client / field-codecs.ts server); the chip survives sanitize,
// a forged `<span data-mention-id onclick=…>` is stripped of the handler.

import type { MetaCommentMentionSuggestion } from '../types'

/** Stable data attribute that marks a people-mention chip span. */
export const MENTION_CHIP_ATTR = 'data-mention-id'

/**
 * The active "@query" the caret is typing, if any. Mirrors the comment composer's
 * `/(?:^|\s)@([^\s@]*)$/` so the trigger rule (start-of-text or after whitespace,
 * then `@`, then a run of non-space/non-@ chars up to the caret) is IDENTICAL
 * across both mention surfaces.
 *
 * @param textBeforeCaret the plain text from the start of the editable up to the
 *        caret (the caller derives this from the live Selection/Range).
 * @returns `{ query, atOffset }` where `atOffset` is the index of the `@` within
 *          `textBeforeCaret`, or `null` when the caret is not in a mention query.
 */
export function detectMentionQuery(
  textBeforeCaret: string,
): { query: string; atOffset: number } | null {
  const match = textBeforeCaret.match(/(?:^|\s)@([^\s@]*)$/)
  if (!match) return null
  const query = match[1] ?? ''
  // The `@` sits just before the captured query; its absolute offset is the end of
  // the whole match minus the query length minus 1 (the `@` itself).
  const atOffset = match.index! + match[0].length - query.length - 1
  return { query, atOffset }
}

/**
 * Filter the candidate list against a query, excluding nothing (the longText editor
 * has no "already selected" set — a record may mention the same person twice).
 * Case-insensitive label/id substring match, capped, mirroring the composer.
 */
export function filterMentionSuggestions(
  suggestions: readonly MetaCommentMentionSuggestion[],
  query: string,
  limit = 6,
): MetaCommentMentionSuggestion[] {
  const q = query.trim().toLowerCase()
  if (!q) return suggestions.slice(0, limit)
  return suggestions
    .filter((s) => s.label.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
    .slice(0, limit)
}

/**
 * Build the mention chip DOM node for a suggestion. Uses `textContent` (NOT
 * innerHTML) so a hostile display label (`<img onerror=…>`) is inserted as inert
 * text, never live markup, into the author's contenteditable. The chip is
 * contentEditable=false so the caret treats it as an atomic unit (a single
 * Backspace deletes the whole chip, the caret can't land inside it).
 */
export function buildMentionChip(
  doc: Document,
  suggestion: MetaCommentMentionSuggestion,
): HTMLSpanElement {
  const chip = doc.createElement('span')
  chip.setAttribute(MENTION_CHIP_ATTR, suggestion.id)
  chip.setAttribute('contenteditable', 'false')
  chip.className = 'meta-rich-editor__mention'
  // `@` + the exact label → reconstructs `@[label](id)` with the id attribute.
  chip.textContent = `@${suggestion.label}`
  return chip
}

/**
 * Insert a mention chip at the caret, replacing the typed "@query" run. Operates on
 * a REAL DOM Range via `insertNode` (execCommand is a no-op in jsdom and would
 * false-green the test). The caret Range is assumed collapsed at the end of the
 * typed query inside a Text node; `queryLength` = chars to delete back from the
 * caret (the `@` plus the query, e.g. `@ja` → 3).
 *
 * Returns the inserted chip so the caller can place the caret after it.
 */
export function insertMentionChipAtRange(
  doc: Document,
  range: Range,
  suggestion: MetaCommentMentionSuggestion,
  queryLength: number,
): HTMLSpanElement {
  // Delete the `@query` text the user typed so it is replaced by the chip.
  if (queryLength > 0) {
    const start = Math.max(0, range.startOffset - queryLength)
    range.setStart(range.startContainer, start)
    range.deleteContents()
  }
  const chip = buildMentionChip(doc, suggestion)
  range.insertNode(chip)
  // A trailing space after the chip so the caret leaves the atomic chip and the
  // next keystroke is normal text (and a fresh `@` can start a new mention).
  const space = doc.createTextNode(' ')
  if (chip.parentNode) chip.parentNode.insertBefore(space, chip.nextSibling)
  // Collapse the caret just after the trailing space.
  range.setStartAfter(space)
  range.collapse(true)
  return chip
}
