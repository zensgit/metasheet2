import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaCommentReactions from '../src/multitable/components/MetaCommentReactions.vue'
import type { MultitableCommentReaction } from '../src/multitable/types'

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount(); app = null
  container?.remove(); container = null
})

function mount(props: Record<string, unknown>) {
  const events: Array<{ type: string; commentId: string; emoji: string }> = []
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    setup() {
      return () => h(MetaCommentReactions, {
        commentId: 'c1',
        ...props,
        onReact: (commentId: string, emoji: string) => events.push({ type: 'react', commentId, emoji }),
        onUnreact: (commentId: string, emoji: string) => events.push({ type: 'unreact', commentId, emoji }),
      })
    },
  })
  app.mount(container)
  return { events, root: container }
}

// jsdom CSS attribute selectors don't reliably match astral-plane emoji, so we
// locate elements by class + emoji text content instead of [data-test="…👍"].
function chip(root: HTMLElement, emoji: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('.meta-comment-reactions__chip'))
    .find((el) => el.querySelector('.meta-comment-reactions__emoji')?.textContent === emoji)
}
function paletteItem(root: HTMLElement, emoji: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('.meta-comment-reactions__palette-item'))
    .find((el) => el.textContent === emoji)
}
const palette = (root: HTMLElement) => root.querySelector('.meta-comment-reactions__palette')
const addBtn = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('.meta-comment-reactions__add')!

const reactions = (over: Partial<MultitableCommentReaction>[] = []): MultitableCommentReaction[] =>
  over.map((o) => ({ emoji: '👍', count: 1, reactedByMe: false, ...o }))

describe('MetaCommentReactions', () => {
  it('renders a chip per reaction with count and a reactedByMe highlight', () => {
    const { root } = mount({ reactions: [
      { emoji: '👍', count: 3, reactedByMe: true },
      { emoji: '❤️', count: 1, reactedByMe: false },
    ] })
    const mine = chip(root, '👍')!
    const other = chip(root, '❤️')!
    expect(mine).toBeTruthy()
    expect(mine.textContent).toContain('3')
    expect(mine.getAttribute('data-reacted')).toBe('true')
    expect(mine.classList.contains('meta-comment-reactions__chip--mine')).toBe(true)
    expect(mine.getAttribute('aria-pressed')).toBe('true')
    expect(other.getAttribute('data-reacted')).toBe('false')
    expect(other.classList.contains('meta-comment-reactions__chip--mine')).toBe(false)
  })

  it('clicking a not-yet-reacted chip emits react; clicking my own emits unreact', () => {
    const { events, root } = mount({ reactions: [
      { emoji: '👍', count: 1, reactedByMe: false },
      { emoji: '❤️', count: 2, reactedByMe: true },
    ] })
    chip(root, '👍')!.click()
    chip(root, '❤️')!.click()
    expect(events).toEqual([
      { type: 'react', commentId: 'c1', emoji: '👍' },
      { type: 'unreact', commentId: 'c1', emoji: '❤️' },
    ])
  })

  it('opens the palette and emits react for a picked emoji, then closes', async () => {
    const { events, root } = mount({ reactions: [] })
    expect(palette(root)).toBeNull()
    addBtn(root).click()
    await nextTick()
    expect(palette(root)).toBeTruthy()
    paletteItem(root, '🎉')!.click()
    expect(events).toEqual([{ type: 'react', commentId: 'c1', emoji: '🎉' }])
    await nextTick()
    expect(palette(root)).toBeNull()
  })

  it('disables a chip whose toggle is in flight (pendingKeys)', () => {
    const { events, root } = mount({
      reactions: reactions([{ emoji: '👍', count: 1, reactedByMe: true }]),
      pendingKeys: ['c1:👍'],
    })
    const c = chip(root, '👍')!
    expect(c.disabled).toBe(true)
    c.click()
    expect(events).toEqual([])
  })

  it('renders no chips for an empty reactions list but still shows the add button', () => {
    const { root } = mount({ reactions: [] })
    expect(root.querySelectorAll('.meta-comment-reactions__chip').length).toBe(0)
    expect(addBtn(root)).toBeTruthy()
  })

  it('read-only viewer (canReact=false) sees counts but no picker and cannot toggle', () => {
    const { events, root } = mount({
      reactions: [{ emoji: '👍', count: 5, reactedByMe: false }],
      canReact: false,
    })
    const c = chip(root, '👍')!
    expect(c).toBeTruthy()
    expect(c.textContent).toContain('5') // count still visible
    expect(c.disabled).toBe(true) // not interactive
    expect(root.querySelector('.meta-comment-reactions__add')).toBeNull() // no picker
    c.click()
    expect(events).toEqual([]) // disabled → no emit
  })
})
