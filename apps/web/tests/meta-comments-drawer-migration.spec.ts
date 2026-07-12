// UI-P2-1c T1 batch-4 (multitable-ui-p2-1c-tail-resolution-designlock-20260707.md §2-T1, RATIFIED,
// "各 manager header" remainder): MetaCommentsDrawer's header close-× (`.meta-comments-drawer__close`)
// was migrated from a bespoke <button>&times;</button> to the shared MtIconButton primitive — the
// &times; glyph passes through MtIconButton's default-slot icon fallback (glyph char preserved, size
// token-normalized to the icon control). Behavior-preservation proof: it stays a native, keyboard-
// operable <button>, and clicking it still fires the SAME `emit('close')` (no aria-label existed
// pre-migration — none was invented). This is the only sharer of `.meta-comments-drawer__close` — its
// bespoke CSS was removed outright, no double-styling risk.
//
// Scope discipline: MetaCommentsDrawer has ~10 buttons total (reply / edit / delete / resolve / retry /
// reply-cancel / edit-cancel / reactions / composer-submit / the inbox RouterLink / the header close-×).
// Only the header close-× is a true dismiss (`emit('close')`, closes the whole drawer) — every other
// control mutates/navigates a specific comment or the composer and was NOT touched. This spec mounts
// with a real vue-router (MetaCommentsDrawer renders a <RouterLink> in its header) — same setup as the
// pre-existing `multitable-comments-drawer.spec.ts`.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import MetaCommentsDrawer from '../src/multitable/components/MetaCommentsDrawer.vue'
import { useLocale } from '../src/composables/useLocale'

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: defineComponent({ render: () => h('div') }) },
      {
        path: '/multitable/comments/inbox',
        name: 'multitable-comment-inbox',
        component: defineComponent({ render: () => h('div') }),
      },
    ],
  })
}

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  useLocale().setLocale('en')
})

async function mount(props: Record<string, unknown>): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const router = makeRouter()
  const app = createApp({ render: () => h(MetaCommentsDrawer, props) })
  app.use(router)
  await router.push('/')
  await router.isReady()
  app.mount(container)
  mounts.push({ app, container })
  await flushUi()
  return container
}

const baseProps = () => ({
  visible: true,
  comments: [],
  loading: false,
  canComment: true,
  canResolve: true,
  draft: '',
})

describe('MetaCommentsDrawer — close-× MtIconButton migration (UI-P2-1c T1 batch-4)', () => {
  it('renders the header close-× as a native <button> (MtIconButton) keeping the class + glyph', async () => {
    const container = await mount(baseProps())
    const btn = container.querySelector('.meta-comments-drawer__close') as HTMLButtonElement
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('meta-comments-drawer__close')).toBe(true)
    expect(btn.textContent?.trim()).toBe('×') // × glyph char preserved (size token-normalized)
  })

  it('clicking the header close-× emits `close` (unchanged — same emit(\'close\'))', async () => {
    const onClose = vi.fn()
    const container = await mount({ ...baseProps(), onClose })
    const btn = container.querySelector('.meta-comments-drawer__close') as HTMLButtonElement
    btn.click()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith()
  })

  it('does not touch the inbox RouterLink or any per-comment action button (scope discipline)', async () => {
    const container = await mount({
      ...baseProps(),
      comments: [
        {
          id: 'c1', spreadsheetId: 'sheet_1', rowId: 'row_1', targetFieldId: null, mentions: [],
          authorId: 'user_1', authorName: 'Amy Wong', content: 'hello', resolved: false,
          createdAt: '2026-04-01T09:00:00.000Z',
        } as any,
      ],
      currentUserId: 'user_1',
    })
    // The inbox link stays a real <a> (RouterLink), not migrated to MtButton/MtIconButton.
    expect(container.querySelector('.meta-comments-drawer__inbox-link')?.tagName).toBe('A')
    // Reply/edit/delete/resolve stay bespoke <button class="meta-comments-drawer__reply|__resolve">.
    expect(container.querySelector('.meta-comments-drawer__reply')).not.toBeNull()
  })
})
