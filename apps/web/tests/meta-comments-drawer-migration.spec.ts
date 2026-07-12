import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import MetaCommentsDrawer from '../src/multitable/components/MetaCommentsDrawer.vue'

// UI-P2-1c T1 batch-6 (multitable-ui-p2-1c-tail-resolution-designlock-20260707.md §2-T1, RATIFIED):
// the header close-× (`.meta-comments-drawer__close`) was migrated from a bespoke <button>&times;</button>
// to the shared MtIconButton primitive — the &times; glyph passes through MtIconButton's default-slot
// icon fallback (glyph char preserved, size token-normalized to the icon control, consistent with the
// existing glyph-MtIconButton controls already on main). Behavior-preservation proof: it stays a native,
// keyboard-operable <button>, keeps the SAME class (selector stability), and clicking it still calls the
// SAME emit('close') — identical to before migration. This is the only sharer of
// `.meta-comments-drawer__close` (single button, single file) — its bespoke CSS was removed outright, no
// double-styling risk.
//
// Honest visual delta (not "zero visual change"): the glyph shrinks from 18px to MtIconButton's 14px
// icon-font size, and the control becomes a 32×32 box (was a borderless, unsized inline glyph).
//
// The header also has an "Inbox" RouterLink (untouched, not a button) and a badge. The reply/edit/delete/
// resolve/retry/reply-cancel buttons in the body are all TEXT-labeled (not × glyphs) and are NOT part of
// this migration — `.meta-comments-drawer__retry` (emit('retry')) is exercised below as a positive
// control to prove an untouched button still behaves exactly as before and that this test harness can
// actually observe these buttons.

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.meta-comments-drawer').length).toBe(0) // residue guard
})

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: defineComponent({ render: () => h('div') }) },
      { path: '/multitable/comments/inbox', name: 'multitable-comment-inbox', component: defineComponent({ render: () => h('div') }) },
    ],
  })
}

type MountOpts = {
  onClose?: () => void
  onRetry?: () => void
  error?: string | null
}

async function mountDrawer(opts: MountOpts = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const router = makeRouter()

  const onClose = opts.onClose ?? vi.fn()
  const onRetry = opts.onRetry ?? vi.fn()

  const app = createApp(defineComponent({
    render() {
      return h(MetaCommentsDrawer, {
        visible: true,
        comments: [],
        loading: false,
        canComment: true,
        canResolve: true,
        draft: '',
        error: opts.error ?? null,
        onClose,
        onRetry,
        onResolve: vi.fn(),
        'onUpdate:draft': vi.fn(),
        onSubmit: vi.fn(),
      })
    },
  }))

  app.use(router)
  await router.push('/')
  await router.isReady()
  app.mount(container)
  await flushUi()
  mounts.push({ app: app as App<Element>, container })
  return { container, onClose, onRetry }
}

describe('MetaCommentsDrawer — header close-× MtIconButton migration (UI-P2-1c T1 batch-6)', () => {
  it('renders the header close-× as a native <button> (MtIconButton) keeping the class + glyph', async () => {
    const { container } = await mountDrawer()
    const btn = container.querySelector('.meta-comments-drawer__close') as HTMLButtonElement
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('meta-comments-drawer__close')).toBe(true)
    expect(btn.textContent?.trim()).toBe('×') // × glyph char preserved (size token-normalized)
  })

  it('clicking the header close-× emits `close` (unchanged — same emit(\'close\') as before migration)', async () => {
    const { container, onClose } = await mountDrawer()
    const btn = container.querySelector('.meta-comments-drawer__close') as HTMLButtonElement
    btn.click()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith()
  })

  it('POSITIVE CONTROL: the untouched retry button still emits `retry` exactly as before', async () => {
    const { container, onRetry } = await mountDrawer({ error: 'Something went wrong' })
    const retryBtn = container.querySelector('.meta-comments-drawer__retry') as HTMLButtonElement
    expect(retryBtn).toBeTruthy()
    expect(retryBtn.tagName).toBe('BUTTON') // still a raw <button>, NOT migrated
    retryBtn.click()
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry).toHaveBeenCalledWith()
  })
})
