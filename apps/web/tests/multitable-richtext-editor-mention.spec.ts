import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import MetaRichLongTextEditor from '../src/multitable/components/cells/MetaRichLongTextEditor.vue'
import type { MetaCommentMentionSuggestion } from '../src/multitable/types'
import { metaCoreLabel } from '../src/multitable/utils/meta-core-labels'

// B5 — MetaRichLongTextEditor mention behaviour at the COMPONENT level.
//
// These mount the real editor and drive the real contenteditable Selection/Range
// in jsdom (set a collapsed caret after typed "@query", dispatch input) so the
// detection→popover→select→chip-insert path is exercised end to end — NOT a
// hand-built chip. The visual caret/keyboard-nav final polish is browser-gated;
// here we pin the testable orchestration + the host gate.

const SUGGESTIONS: MetaCommentMentionSuggestion[] = [
  { id: 'user_jamie', label: 'Jamie', subtitle: 'jamie@x.com' },
  { id: 'user_jordan', label: 'Jordan' },
]

/** Type `text` into the editable (as a single text node) and place a collapsed
 *  caret at its end, so the component's getSelection()-based detection sees it. */
function typeInto(editable: HTMLElement, text: string): void {
  editable.textContent = text
  const node = editable.firstChild!
  const sel = window.getSelection()!
  const range = document.createRange()
  range.setStart(node, text.length)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
  editable.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('MetaRichLongTextEditor — B5 mention popover + host gate', () => {
  let container: HTMLDivElement | null = null

  afterEach(() => {
    container?.remove()
    container = null
  })

  function mount(props: Record<string, unknown>) {
    container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({ setup: () => () => h(MetaRichLongTextEditor, props) })
    app.mount(container)
    return { app }
  }

  it('shows the mention popover after typing "@query" when candidates are fed', async () => {
    mount({ modelValue: '', mentionSuggestions: SUGGESTIONS })
    await nextTick()
    const editable = container!.querySelector('[data-test="rich-longtext-editor"]') as HTMLElement
    editable.focus()
    typeInto(editable, '@ja')
    await nextTick()

    const popover = container!.querySelector('[data-test="rich-longtext-mention-popover"]')
    expect(popover).not.toBeNull()
    const options = container!.querySelectorAll('[data-test="rich-longtext-mention-option"]')
    expect(options.length).toBe(1)
    expect(options[0].textContent).toContain('Jamie')
  })

  it('HOST GATE: no popover when NO candidates are fed (the MetaFormView/anon path)', async () => {
    // MetaFormView passes no mentionSuggestions → mentionEnabled is false → the
    // member directory is never surfaced to an anonymous public submitter.
    mount({ modelValue: '' })
    await nextTick()
    const editable = container!.querySelector('[data-test="rich-longtext-editor"]') as HTMLElement
    editable.focus()
    typeInto(editable, '@ja')
    await nextTick()

    expect(container!.querySelector('[data-test="rich-longtext-mention-popover"]')).toBeNull()
  })

  it('selecting a suggestion inserts a chip and emits a value carrying data-mention-id', async () => {
    const emitted: string[] = []
    mount({
      modelValue: '',
      mentionSuggestions: SUGGESTIONS,
      'onUpdate:modelValue': (v: string) => emitted.push(v),
    })
    await nextTick()
    const editable = container!.querySelector('[data-test="rich-longtext-editor"]') as HTMLElement
    editable.focus()
    typeInto(editable, 'hi @jo')
    await nextTick()

    const option = container!.querySelector('[data-test="rich-longtext-mention-option"]') as HTMLButtonElement
    expect(option.textContent).toContain('Jordan')
    // mousedown (the component binds @mousedown.prevent so the editable keeps focus).
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await nextTick()

    // The popover closes after select.
    expect(container!.querySelector('[data-test="rich-longtext-mention-popover"]')).toBeNull()
    // A chip span is now in the editable DOM.
    expect(editable.querySelector('span[data-mention-id="user_jordan"]')).not.toBeNull()
    // The emitted (sanitized) value carries the chip id + label, and the typed "@jo"
    // run was replaced (no literal "@jo" left before the chip).
    const last = emitted[emitted.length - 1]
    expect(last).toContain('data-mention-id="user_jordan"')
    expect(last).toContain('@Jordan')
    expect(last).not.toContain('@jo<')
  })

  it('a bad query (space after @) does not show the popover', async () => {
    mount({ modelValue: '', mentionSuggestions: SUGGESTIONS })
    await nextTick()
    const editable = container!.querySelector('[data-test="rich-longtext-editor"]') as HTMLElement
    editable.focus()
    typeInto(editable, '@jamie done')
    await nextTick()
    expect(container!.querySelector('[data-test="rich-longtext-mention-popover"]')).toBeNull()
  })
})

// #5795 — the candidate endpoint is search-required, so the workbench feeds a SEARCH function instead of
// a preloaded roster. The editor queries it as the user types and renders `requiresQuery` as a prompt.
describe('MetaRichLongTextEditor — #5795 server-side mention search', () => {
  let container: HTMLDivElement | null = null

  afterEach(() => {
    container?.remove()
    container = null
  })

  function mount(props: Record<string, unknown>) {
    container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({ setup: () => () => h(MetaRichLongTextEditor, props) })
    app.mount(container)
  }

  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 220))
    await nextTick()
    await nextTick()
  }

  const fakeSearch = () => vi.fn(async (q: string) => (q
    ? { items: [{ id: 'u_fake_rt', label: 'Fake Richtext', subtitle: 'fake.rt@example.invalid' }], requiresQuery: false, hasMore: false }
    : { items: [], requiresQuery: true, hasMore: false }))

  it('a bare @ asks with an empty term and shows the type-to-search hint (search alone enables the popover)', async () => {
    const search = fakeSearch()
    mount({ modelValue: '', mentionSearch: search, isZh: true })
    await nextTick()
    const editable = container!.querySelector('[data-test="rich-longtext-editor"]') as HTMLElement
    editable.focus()
    typeInto(editable, '@')
    await settle()

    expect(search).toHaveBeenCalledWith('')
    expect(container!.querySelector('[data-test="rich-longtext-mention-popover"]')).not.toBeNull()
    const hint = container!.querySelector('[data-test="rich-longtext-mention-search-required"]')
    expect(hint).not.toBeNull()
    expect(hint!.textContent).toBe(metaCoreLabel('mention.typeToSearch', true))
    expect(container!.querySelectorAll('[data-test="rich-longtext-mention-option"]')).toHaveLength(0)
  })

  it('a real term shows the server answer (email-only match kept) and selecting it inserts the chip', async () => {
    const search = fakeSearch()
    const emitted: string[] = []
    mount({ modelValue: '', mentionSearch: search, 'onUpdate:modelValue': (v: string) => emitted.push(v) })
    await nextTick()
    const editable = container!.querySelector('[data-test="rich-longtext-editor"]') as HTMLElement
    editable.focus()
    typeInto(editable, 'hi @example')
    await settle()

    expect(search).toHaveBeenLastCalledWith('example')
    expect(container!.querySelector('[data-test="rich-longtext-mention-search-required"]')).toBeNull()
    const option = container!.querySelector('[data-test="rich-longtext-mention-option"]') as HTMLButtonElement
    expect(option.textContent).toContain('Fake Richtext')
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await nextTick()
    expect(editable.querySelector('span[data-mention-id="u_fake_rt"]')).not.toBeNull()
    expect(emitted[emitted.length - 1]).toContain('data-mention-id="u_fake_rt"')
  })

  it('erasing back to a bare @ never shows the answer for the previous term while the new ask is pending', async () => {
    const search = vi.fn((q: string) => (q
      ? Promise.resolve({ items: [{ id: 'u_prev_rt', label: 'Fake Previous' }], requiresQuery: false, hasMore: false })
      : new Promise(() => {}))) // the term-less ask never settles in this test
    mount({ modelValue: '', mentionSearch: search, isZh: false })
    await nextTick()
    const editable = container!.querySelector('[data-test="rich-longtext-editor"]') as HTMLElement
    editable.focus()
    typeInto(editable, '@fa')
    await settle()
    expect(container!.querySelector('[data-test="rich-longtext-mention-option"]')!.textContent).toContain('Fake Previous')

    typeInto(editable, '@')
    await settle()

    expect(search).toHaveBeenLastCalledWith('')
    expect(container!.querySelectorAll('[data-test="rich-longtext-mention-option"]')).toHaveLength(0)
  })

  // Refuter round (#5795 consumer regression): the prompt-only popover must not hijack the caret keys,
  // and must not outlive the caret leaving the `@` run (a caret move fires no `input`).
  const key = (editable: HTMLElement, type: 'keydown' | 'keyup', k: string) => {
    const event = new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true })
    editable.dispatchEvent(event)
    return event
  }
  const placeCaret = (editable: HTMLElement, offset: number) => {
    const range = document.createRange()
    range.setStart(editable.firstChild!, offset)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
  }
  const popover = () => container!.querySelector('[data-test="rich-longtext-mention-popover"]')
  const prompt = () => container!.querySelector('[data-test="rich-longtext-mention-search-required"]')

  it('prompt only (bare @): ArrowUp / ArrowDown are NOT default-prevented, so they still move the caret', async () => {
    mount({ modelValue: '', mentionSearch: fakeSearch() })
    await nextTick()
    const editable = container!.querySelector('[data-test="rich-longtext-editor"]') as HTMLElement
    editable.focus()
    typeInto(editable, 'line one @')
    await settle()
    expect(prompt()).not.toBeNull()

    expect(key(editable, 'keydown', 'ArrowDown').defaultPrevented).toBe(false)
    expect(key(editable, 'keydown', 'ArrowUp').defaultPrevented).toBe(false)
  })

  it('with real options showing, ArrowDown is still consumed by the list (navigation unchanged)', async () => {
    mount({ modelValue: '', mentionSuggestions: SUGGESTIONS, mentionSearch: fakeSearch() })
    await nextTick()
    const editable = container!.querySelector('[data-test="rich-longtext-editor"]') as HTMLElement
    editable.focus()
    typeInto(editable, '@j')
    await settle()
    const options = () => Array.from(container!.querySelectorAll('[data-test="rich-longtext-mention-option"]'))
    expect(options().length).toBeGreaterThan(1)
    expect(options()[0].getAttribute('aria-selected')).toBe('true')

    expect(key(editable, 'keydown', 'ArrowDown').defaultPrevented).toBe(true)
    key(editable, 'keyup', 'ArrowDown')
    await nextTick()
    expect(options()[1].getAttribute('aria-selected')).toBe('true')
  })

  it('moving the caret out of the @ run with an arrow key closes the prompt, and the next Esc cancels the edit', async () => {
    const onCancel = vi.fn()
    mount({ modelValue: '', mentionSearch: fakeSearch(), onCancel })
    await nextTick()
    const editable = container!.querySelector('[data-test="rich-longtext-editor"]') as HTMLElement
    editable.focus()
    typeInto(editable, 'x @')
    await settle()
    expect(popover()).not.toBeNull()

    placeCaret(editable, 0)
    key(editable, 'keydown', 'ArrowLeft')
    key(editable, 'keyup', 'ArrowLeft')
    await settle()
    expect(popover()).toBeNull()

    key(editable, 'keydown', 'Escape')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('a vertical arrow that moved the caret out of the @ run closes the prompt on keyup', async () => {
    mount({ modelValue: '', mentionSearch: fakeSearch() })
    await nextTick()
    const editable = container!.querySelector('[data-test="rich-longtext-editor"]') as HTMLElement
    editable.focus()
    typeInto(editable, 'x @')
    await settle()
    expect(prompt()).not.toBeNull()

    key(editable, 'keydown', 'ArrowUp')
    placeCaret(editable, 0) // where the browser's default ArrowUp would have put the caret
    key(editable, 'keyup', 'ArrowUp')
    await settle()
    expect(popover()).toBeNull()
  })

  it('placing the caret elsewhere with the mouse closes the prompt', async () => {
    mount({ modelValue: '', mentionSearch: fakeSearch() })
    await nextTick()
    const editable = container!.querySelector('[data-test="rich-longtext-editor"]') as HTMLElement
    editable.focus()
    typeInto(editable, 'x @')
    await settle()
    expect(prompt()).not.toBeNull()

    placeCaret(editable, 1)
    editable.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await settle()
    expect(popover()).toBeNull()
  })

  it('a caret move never OPENS a suggester: walking back into existing "@jo" text asks nothing', async () => {
    const search = fakeSearch()
    mount({ modelValue: '', mentionSearch: search })
    await nextTick()
    const editable = container!.querySelector('[data-test="rich-longtext-editor"]') as HTMLElement
    editable.focus()
    typeInto(editable, 'hi @jo more')
    await settle()
    expect(popover()).toBeNull()
    expect(search).not.toHaveBeenCalled()

    placeCaret(editable, 'hi @jo'.length)
    key(editable, 'keydown', 'ArrowLeft')
    key(editable, 'keyup', 'ArrowLeft')
    editable.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await settle()
    expect(popover()).toBeNull()
    expect(search).not.toHaveBeenCalled()
  })

  it('HOST GATE still holds: neither candidates nor a search ⇒ no popover and nothing is asked', async () => {
    mount({ modelValue: '' })
    await nextTick()
    const editable = container!.querySelector('[data-test="rich-longtext-editor"]') as HTMLElement
    editable.focus()
    typeInto(editable, '@')
    await settle()
    expect(container!.querySelector('[data-test="rich-longtext-mention-popover"]')).toBeNull()
    expect(container!.querySelector('[data-test="rich-longtext-mention-search-required"]')).toBeNull()
  })
})

describe('MetaRichLongTextEditor — B5 aria labels come from the typed label module (i18n strict-zero)', () => {
  // Before this fix the toolbar/content aria labels were unconditional Chinese
  // consts (`const ariaToolbar = '富文本格式工具栏'`) — an English-locale screen
  // reader read Chinese. They must now come from meta-core-labels (richText.*)
  // in BOTH locales; equality with the module output per locale pins that (a
  // hardcoded string in the component would fail one of the two locales).
  let container: HTMLDivElement | null = null

  afterEach(() => {
    container?.remove()
    container = null
  })

  function mount(props: Record<string, unknown>) {
    container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({ setup: () => () => h(MetaRichLongTextEditor, props) })
    app.mount(container)
  }

  for (const isZh of [true, false]) {
    it(`renders module-sourced, non-empty toolbar + content aria labels (isZh=${isZh})`, async () => {
      mount({ modelValue: '', isZh })
      await nextTick()

      const toolbar = container!.querySelector('.meta-rich-editor__toolbar[role="toolbar"]')
      const editable = container!.querySelector('[data-test="rich-longtext-editor"]')
      expect(toolbar).not.toBeNull()
      expect(editable).not.toBeNull()

      const toolbarAria = toolbar!.getAttribute('aria-label')
      const contentAria = editable!.getAttribute('aria-label')
      expect(toolbarAria).toBe(metaCoreLabel('richText.toolbarAria', isZh))
      expect(contentAria).toBe(metaCoreLabel('richText.contentAria', isZh))
      expect((toolbarAria ?? '').trim().length).toBeGreaterThan(0)
      expect((contentAria ?? '').trim().length).toBeGreaterThan(0)
      if (!isZh) {
        // The original B5 bug: unconditional Chinese in an English locale.
        expect(toolbarAria).not.toMatch(/[一-鿿]/)
        expect(contentAria).not.toMatch(/[一-鿿]/)
      }
    })
  }
})
