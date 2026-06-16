import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import MetaRichLongTextEditor from '../src/multitable/components/cells/MetaRichLongTextEditor.vue'
import type { MetaCommentMentionSuggestion } from '../src/multitable/types'

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
