import { describe, expect, it } from 'vitest'
import {
  detectMentionQuery,
  filterMentionSuggestions,
  buildMentionChip,
  insertMentionChipAtRange,
  MENTION_CHIP_ATTR,
} from '../src/multitable/utils/rich-longtext-mention'
import { sanitizeRichLongTextHtml } from '../src/multitable/utils/rich-longtext'
import type { MetaCommentMentionSuggestion } from '../src/multitable/types'

// B5 — longText in-cell @mention seams.
//
// These exercise the REAL detection + Range-based insert seams (NOT a hand-built
// chip, NOT execCommand) so the selection→insert path is genuinely tested in jsdom
// — directly addressing the documented wire-vs-fixture / jsdom-false-green blind
// spot. The same `sanitizeRichLongTextHtml` the render lane ships is used for the
// chip-survives / forged-chip-stripped canaries (no parallel DOMPurify call).

const SUGGESTIONS: MetaCommentMentionSuggestion[] = [
  { id: 'user_jamie', label: 'Jamie', subtitle: 'jamie@x.com' },
  { id: 'user_jordan', label: 'Jordan' },
  { id: 'user_alex', label: 'Alex' },
]

describe('detectMentionQuery — @-trigger rule (identical to the comment composer)', () => {
  it('detects a query at start-of-text', () => {
    expect(detectMentionQuery('@ja')).toEqual({ query: 'ja', atOffset: 0 })
  })

  it('detects a query after whitespace', () => {
    expect(detectMentionQuery('hello @jo')).toEqual({ query: 'jo', atOffset: 6 })
  })

  it('detects a bare @ (empty query) for the full list', () => {
    expect(detectMentionQuery('hi @')).toEqual({ query: '', atOffset: 3 })
  })

  it('returns null when @ is glued to a preceding word (email-like, NOT a mention)', () => {
    expect(detectMentionQuery('mail@example')).toBeNull()
  })

  it('returns null when there is a space inside the query (mention already ended)', () => {
    expect(detectMentionQuery('@jamie done')).toBeNull()
  })

  it('returns null with no @ at all', () => {
    expect(detectMentionQuery('plain text')).toBeNull()
  })
})

describe('filterMentionSuggestions — case-insensitive label/id match, capped', () => {
  it('narrows by label substring', () => {
    const out = filterMentionSuggestions(SUGGESTIONS, 'jo')
    expect(out.map((s) => s.id)).toEqual(['user_jordan'])
  })

  it('narrows by id substring', () => {
    const out = filterMentionSuggestions(SUGGESTIONS, 'alex')
    expect(out.map((s) => s.id)).toEqual(['user_alex'])
  })

  it('matches the j-prefix across two members (case-insensitive)', () => {
    const out = filterMentionSuggestions(SUGGESTIONS, 'J')
    expect(out.map((s) => s.id).sort()).toEqual(['user_jamie', 'user_jordan'])
  })

  it('returns the full (capped) list for an empty query', () => {
    const out = filterMentionSuggestions(SUGGESTIONS, '')
    expect(out).toHaveLength(3)
  })

  it('caps the result list', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `u${i}`, label: `User${i}` }))
    expect(filterMentionSuggestions(many, '', 6)).toHaveLength(6)
  })
})

describe('buildMentionChip — DOM construction is textContent-safe (no innerHTML)', () => {
  it('builds <span data-mention-id="id">@Label</span>', () => {
    const chip = buildMentionChip(document, SUGGESTIONS[0])
    expect(chip.tagName).toBe('SPAN')
    expect(chip.getAttribute(MENTION_CHIP_ATTR)).toBe('user_jamie')
    expect(chip.textContent).toBe('@Jamie')
    expect(chip.getAttribute('contenteditable')).toBe('false')
  })

  it('inserts a hostile display label as INERT TEXT (never live markup) — self-XSS defense', () => {
    const hostile: MetaCommentMentionSuggestion = { id: 'u_evil', label: '<img src=x onerror=alert(1)>' }
    const chip = buildMentionChip(document, hostile)
    // The label is the chip's textContent, so the markup is escaped — there is no
    // real <img> child element in the chip.
    expect(chip.querySelector('img')).toBeNull()
    expect(chip.textContent).toBe('@<img src=x onerror=alert(1)>')
    expect(chip.innerHTML).not.toContain('<img')
  })
})

describe('insertMentionChipAtRange — REAL Range insert (insertNode, not execCommand)', () => {
  function mountEditable(text: string): { root: HTMLDivElement; textNode: Text } {
    const root = document.createElement('div')
    root.setAttribute('contenteditable', 'true')
    const textNode = document.createTextNode(text)
    root.appendChild(textNode)
    document.body.appendChild(root)
    return { root, textNode }
  }

  it('replaces the typed "@query" with a chip at the caret', () => {
    const { root, textNode } = mountEditable('hi @ja')
    const range = document.createRange()
    // Caret collapsed at the end of "hi @ja" (offset 6).
    range.setStart(textNode, 6)
    range.collapse(true)

    // queryLength = '@ja'.length = 3 (the `@` + the 2-char query).
    const chip = insertMentionChipAtRange(document, range, SUGGESTIONS[0], 3)

    expect(chip.getAttribute(MENTION_CHIP_ATTR)).toBe('user_jamie')
    expect(chip.textContent).toBe('@Jamie')
    // The typed "@ja" text is gone, replaced by the chip span; "hi " survives. The
    // trailing space the seam inserts may serialize as a non-breaking space in
    // jsdom's contenteditable; normalize it so the assertion checks the real shape.
    expect(root.textContent?.replace(/ /g, ' ')).toBe('hi @Jamie ')
    expect(root.querySelector(`span[${MENTION_CHIP_ATTR}="user_jamie"]`)).not.toBeNull()
    root.remove()
  })

  it('produces HTML whose chip SURVIVES the shared sanitizer round-trip', () => {
    const { root, textNode } = mountEditable('@')
    const range = document.createRange()
    range.setStart(textNode, 1)
    range.collapse(true)
    insertMentionChipAtRange(document, range, SUGGESTIONS[1], 1)

    const sanitized = sanitizeRichLongTextHtml(root.innerHTML)
    expect(sanitized).toContain(`data-mention-id="user_jordan"`)
    expect(sanitized).toContain('@Jordan')
    expect(sanitized).toContain('<span')
    root.remove()
  })
})

describe('chip survives / forged chip stripped — FE sanitizer canaries (lock-step with server)', () => {
  it('a REAL mention chip survives sanitize UNCHANGED (allow-list works)', () => {
    const out = sanitizeRichLongTextHtml('<span data-mention-id="user_jamie">@Jamie</span>')
    expect(out).toContain('data-mention-id="user_jamie"')
    expect(out).toContain('@Jamie')
    expect(out).toContain('<span')
  })

  it('a FORGED chip with an onclick handler is STRIPPED of the handler (id kept inert)', () => {
    const out = sanitizeRichLongTextHtml('<span data-mention-id="u1" onclick="alert(1)">x</span>')
    expect(out.toLowerCase()).not.toContain('onclick')
    expect(out).not.toContain('alert(1)')
    expect(out).not.toMatch(/\son\w+\s*=/)
    // The inert id is harmless; the dangerous attribute is gone.
    expect(out).toContain('data-mention-id="u1"')
  })

  it('a FORGED chip with a style attribute is STRIPPED of the style', () => {
    const out = sanitizeRichLongTextHtml('<span data-mention-id="u1" style="position:fixed;top:0">x</span>')
    expect(out.toLowerCase()).not.toContain('style=')
    expect(out).toContain('data-mention-id="u1"')
  })

  it('data-mention-id is scoped to <span> ONLY — stripped from other tags (matches server scoping)', () => {
    // DOMPurify ALLOWED_ATTR is global; the post-sanitize hook strips the attr from
    // non-span nodes so a <b data-mention-id> can never masquerade as a chip.
    const out = sanitizeRichLongTextHtml('<b data-mention-id="u1">bold</b>')
    expect(out).not.toContain('data-mention-id')
    expect(out).toContain('<b>bold</b>')
  })

  it('arbitrary OTHER data-* attributes are still rejected (ALLOW_DATA_ATTR stays false)', () => {
    const out = sanitizeRichLongTextHtml('<span data-evil="1" data-mention-id="u1">x</span>')
    expect(out).not.toContain('data-evil')
    expect(out).toContain('data-mention-id="u1"')
  })

  it('a malformed data-mention-id VALUE (js-protocol / spaces) is rejected, not kept', () => {
    // The keep-hook re-validates the id against RICH_LONGTEXT_MENTION_ID_REGEXP, so a
    // crafted value can never ride through even though the attr name is allow-listed.
    const js = sanitizeRichLongTextHtml('<span data-mention-id="javascript:alert(1)">x</span>')
    expect(js).not.toContain('data-mention-id')
    expect(js.toLowerCase()).not.toContain('javascript:')
    const spaced = sanitizeRichLongTextHtml('<span data-mention-id="a b c">x</span>')
    expect(spaced).not.toContain('data-mention-id')
  })
})
