import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaGalleryView from '../src/multitable/components/MetaGalleryView.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c batch6: MetaGalleryView's pagination prev/next controls migrated from bespoke <button> to
// the shared MtButton primitive (ghost, token-styled); the class `meta-gallery__page-btn` is unique, so
// its bespoke hex CSS was removed. Behavior-preservation proof: prev/next stay native,
// keyboard-operable <button>s; the :disabled bindings survive; clicking still emits the SAME payload.
//
// UI-P2-1c T2 (multitable-ui-p2-1c-tail-lock #3866 §2-T2, RATIFIED): create-btn (toolbar) and
// empty-action, both formerly the soft-tinted (#ecf5ff bg / #2563eb text / #c7ddff border) "create"
// pattern, now migrate onto the new MtButton `plain` variant. Byte-equivalence proof: same v-if="canCreate"
// gate, same @click="emit('create-record', {})" handler/payload, same class name kept on the element
// (selector stability) — only the rendering primitive + CSS ownership changed.

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

  it('renders create-btn/empty-action as native <button>s via MtButton plain (T2 migration)', () => {
    const root = mount({ canCreate: true, rows: [] })
    const createBtn = root.querySelector('.meta-gallery__create-btn') as HTMLButtonElement
    const emptyAction = root.querySelector('.meta-gallery__empty-action') as HTMLButtonElement
    expect(createBtn).not.toBeNull()
    expect(emptyAction).not.toBeNull()
    expect(createBtn.tagName).toBe('BUTTON')
    expect(emptyAction.tagName).toBe('BUTTON')
    // MtButton's own variant class rides alongside the original selector-stability class.
    expect(createBtn.classList.contains('mt-button--plain')).toBe(true)
    expect(emptyAction.classList.contains('mt-button--plain')).toBe(true)
    expect(createBtn.classList.contains('meta-gallery__create-btn')).toBe(true)
    expect(emptyAction.classList.contains('meta-gallery__empty-action')).toBe(true)
  })

  it('create-btn only renders when canCreate is true (v-if preserved)', () => {
    expect(mount({ canCreate: false, rows: [] }).querySelector('.meta-gallery__create-btn')).toBeNull()
    expect(mount({ canCreate: true, rows: [] }).querySelector('.meta-gallery__create-btn')).not.toBeNull()
  })

  it('empty-action only renders when canCreate is true AND rows is empty (v-if preserved)', () => {
    expect(mount({ canCreate: true, rows }).querySelector('.meta-gallery__empty-action')).toBeNull()
    expect(mount({ canCreate: false, rows: [] }).querySelector('.meta-gallery__empty-action')).toBeNull()
    expect(mount({ canCreate: true, rows: [] }).querySelector('.meta-gallery__empty-action')).not.toBeNull()
  })

  it('clicking create-btn emits `create-record` with the SAME payload (unchanged handler)', () => {
    const onCreateRecord = vi.fn()
    const root = mount({ canCreate: true, rows: [], onCreateRecord })
    ;(root.querySelector('.meta-gallery__create-btn') as HTMLButtonElement).click()
    expect(onCreateRecord).toHaveBeenCalledTimes(1)
    expect(onCreateRecord).toHaveBeenCalledWith({})
  })

  it('clicking empty-action emits `create-record` with the SAME payload (unchanged handler)', () => {
    const onCreateRecord = vi.fn()
    const root = mount({ canCreate: true, rows: [], onCreateRecord })
    ;(root.querySelector('.meta-gallery__empty-action') as HTMLButtonElement).click()
    expect(onCreateRecord).toHaveBeenCalledTimes(1)
    expect(onCreateRecord).toHaveBeenCalledWith({})
  })

  it('create-btn/empty-action carry no bespoke hardcoded-hex inline style (token-only via MtButton)', () => {
    const root = mount({ canCreate: true, rows: [] })
    const createBtn = root.querySelector('.meta-gallery__create-btn') as HTMLButtonElement
    const emptyAction = root.querySelector('.meta-gallery__empty-action') as HTMLButtonElement
    expect(createBtn.getAttribute('style')).toBeNull()
    expect(emptyAction.getAttribute('style')).toBeNull()
  })
})
