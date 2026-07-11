import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaGalleryView from '../src/multitable/components/MetaGalleryView.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c batch6: MetaGalleryView's pagination prev/next controls migrated from bespoke <button> to
// the shared MtButton primitive (ghost, token-styled); the class `meta-gallery__page-btn` is unique, so
// its bespoke hex CSS was removed. The create-btn (toolbar) and empty-action controls are explicitly
// NOT touched here — both are the soft-tinted (#ecf5ff bg / #2563eb text) "create" pattern named in the
// T2 tail lock, gated on an owner variant decision. Behavior-preservation proof: prev/next stay native,
// keyboard-operable <button>s; the :disabled bindings survive; clicking still emits the SAME payload.

const fields: MetaField[] = [
  { id: 'fld_title', name: 'Title', type: 'string' },
]

const rows: MetaRecord[] = [
  { id: 'rec_1', version: 1, data: { fld_title: 'Row 1' } },
]

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.meta-gallery').length).toBe(0) // residue guard
  useLocale().setLocale('en')
})

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const app = createApp({
    render: () => h(MetaGalleryView, { rows, fields, loading: false, currentPage: 1, totalPages: 3, ...props }),
  })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

const pageBtns = (r: HTMLElement) => Array.from(r.querySelectorAll('.meta-gallery__page-btn')) as HTMLButtonElement[]

describe('MetaGalleryView — MtButton migration (UI-P2-1c batch6)', () => {
  it('renders prev/next pagination as native <button>s only when totalPages > 1', () => {
    expect(pageBtns(mount({ totalPages: 1 })).length).toBe(0) // v-if="totalPages > 1" preserved
    const btns = pageBtns(mount({ currentPage: 2, totalPages: 3 }))
    expect(btns.length).toBe(2)
    for (const b of btns) expect(b.tagName).toBe('BUTTON') // keyboard-operable, not a bare div
  })

  it(':disabled bindings survive migration (prev disabled at page 1, next disabled at last page)', () => {
    const first = pageBtns(mount({ currentPage: 1, totalPages: 3 }))
    expect(first[0]!.disabled).toBe(true) // currentPage <= 1
    expect(first[1]!.disabled).toBe(false)

    const last = pageBtns(mount({ currentPage: 3, totalPages: 3 }))
    expect(last[0]!.disabled).toBe(false)
    expect(last[1]!.disabled).toBe(true) // currentPage >= totalPages
  })

  it('clicking prev/next emits `go-to-page` with the SAME payload (unchanged handler)', () => {
    const onGoToPage = vi.fn()
    const root = mount({ currentPage: 2, totalPages: 3, onGoToPage })
    const [prev, next] = pageBtns(root)
    prev!.click()
    next!.click()
    expect(onGoToPage).toHaveBeenNthCalledWith(1, 1) // currentPage - 1
    expect(onGoToPage).toHaveBeenNthCalledWith(2, 3) // currentPage + 1
  })

  it('leaves create-btn/empty-action bespoke (not migrated — T2 soft-tinted create, owner-gated)', () => {
    const root = mount({ canCreate: true, rows: [] })
    const createBtn = root.querySelector('.meta-gallery__create-btn')
    const emptyAction = root.querySelector('.meta-gallery__empty-action')
    expect(createBtn).not.toBeNull()
    expect(emptyAction).not.toBeNull()
    // Bespoke controls keep their own hardcoded-hex CSS class (no MtButton wrapper attributes).
    expect(createBtn!.className.trim()).toBe('meta-gallery__create-btn')
    expect(emptyAction!.className.trim()).toBe('meta-gallery__empty-action')
  })
})
