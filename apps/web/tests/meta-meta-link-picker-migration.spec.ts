import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import MetaLinkPicker from '../src/multitable/components/MetaLinkPicker.vue'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c: MetaLinkPicker's two footer action controls (cancel / confirm) were migrated from
// bespoke <button>s to the shared MtButton primitive (confirm = variant="primary", the filled
// blue action; cancel = default ghost). Behavior-preservation proof: both stay native,
// keyboard-operable <button>s carrying their original selector classes; the cancel @click still
// emits `close`; and clicking confirm still invokes onConfirm and emits `confirm` with the SAME
// { recordIds, summaries } payload as before. This picker renders its own overlay inline (no
// Teleport), but the residue guard still queries `document` for robustness.
//
// UI-P2-1c T1 batch-3: the header close-× (`.meta-link-picker__close`) was ALSO migrated, from a
// bespoke <button>&times;</button> to the shared MtIconButton primitive (T1 design-lock recommendation:
// keep the &times; glyph, only collapse padding/hover/focus-ring onto tokens — token-normalized, not
// zero-visual-change; see #4130/#4133 wording precedent). It stays a native, keyboard-operable
// <button>, keeps the SAME aria-label (`lp('linkPicker.close')`) and the SAME @click="emit('close')"
// (no payload). `.meta-link-picker__close` is the sole sharer of that class in this file — its
// bespoke CSS was removed outright (no double-styling risk).
// Left untouched per the classifier: the chip-remove × glyphs (`@click="removeSelected(id)"` — a
// "remove this chip" action, not a dismiss/close) and the Clear/Load-more buttons stay bespoke.

const { mockListLinkOptions } = vi.hoisted(() => ({ mockListLinkOptions: vi.fn() }))
vi.mock('../src/multitable/api/client', () => ({
  multitableClient: { listLinkOptions: mockListLinkOptions },
}))

const linkField = { id: 'fld_vendor', name: 'Vendor', type: 'link' }

async function flushPromises() {
  await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick()
}

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.meta-link-picker__overlay').length).toBe(0) // residue guard
  useLocale().setLocale('en')
  mockListLinkOptions.mockReset()
})

// Reactive `visible` ref so flipping false->true fires the picker's watcher (which loads records);
// the watcher is NOT `immediate`, so records only appear once we drive visible.
function mount(extraProps: Record<string, unknown> = {}, handlers: Record<string, unknown> = {}) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const visible = ref(false)
  const Harness = defineComponent({
    setup: () => () => h(MetaLinkPicker, { visible: visible.value, field: linkField, ...extraProps, ...handlers }),
  })
  const app = createApp(Harness)
  app.mount(container)
  mounts.push({ app, container })
  return { container, visible }
}

const cancelBtn = () => document.querySelector('.meta-link-picker__cancel') as HTMLButtonElement
const confirmBtn = () => document.querySelector('.meta-link-picker__confirm') as HTMLButtonElement
const closeBtn = () => document.querySelector('.meta-link-picker__close') as HTMLButtonElement

describe('MetaLinkPicker — MtButton migration (UI-P2-1c)', () => {
  it('renders footer cancel + confirm as native <button>s (keyboard-operable, classes preserved)', async () => {
    mockListLinkOptions.mockResolvedValue({ selected: [], records: [], page: { offset: 0, limit: 50, total: 0, hasMore: false } })
    const { visible } = mount()
    visible.value = true
    await flushPromises()
    expect(cancelBtn()).toBeTruthy()
    expect(confirmBtn()).toBeTruthy()
    expect(cancelBtn().tagName).toBe('BUTTON')
    expect(confirmBtn().tagName).toBe('BUTTON')
  })

  it('clicking cancel emits `close` (handler unchanged from pre-migration)', async () => {
    mockListLinkOptions.mockResolvedValue({ selected: [], records: [], page: { offset: 0, limit: 50, total: 0, hasMore: false } })
    const onClose = vi.fn()
    const { visible } = mount({}, { onClose })
    visible.value = true
    await flushPromises()
    cancelBtn().click()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('selecting a record then clicking confirm emits `confirm` with the same { recordIds, summaries } payload', async () => {
    mockListLinkOptions.mockResolvedValue({
      field: linkField,
      selected: [],
      records: [
        { id: 'vendor_1', display: 'Acme Supply' },
        { id: 'vendor_2', display: 'Beacon Labs' },
      ],
      page: { offset: 0, limit: 50, total: 2, hasMore: false },
    })
    const onConfirm = vi.fn()
    const { container, visible } = mount({}, { onConfirm })
    visible.value = true
    await flushPromises()

    const checkbox = container.querySelector('.meta-link-picker__item input[type="checkbox"]') as HTMLInputElement
    expect(checkbox).toBeTruthy()
    checkbox.click()
    await nextTick()

    confirmBtn().click()
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith({
      recordIds: ['vendor_1'],
      summaries: [{ id: 'vendor_1', display: 'Acme Supply' }],
    })
  })

  it('T1 batch-3: renders the header close-× as a native <button> (MtIconButton) keeping class + aria-label + glyph', async () => {
    useLocale().setLocale('en')
    mockListLinkOptions.mockResolvedValue({ selected: [], records: [], page: { offset: 0, limit: 50, total: 0, hasMore: false } })
    const { visible } = mount()
    visible.value = true
    await flushPromises()
    const btn = closeBtn()
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('meta-link-picker__close')).toBe(true)
    expect(btn.getAttribute('aria-label')).toBe('Close link picker')
    expect(btn.textContent?.trim()).toBe('×')
  })

  it('T1 batch-3: renders the localized (zh) aria-label unchanged on the close-×', async () => {
    useLocale().setLocale('zh')
    mockListLinkOptions.mockResolvedValue({ selected: [], records: [], page: { offset: 0, limit: 50, total: 0, hasMore: false } })
    const { visible } = mount()
    visible.value = true
    await flushPromises()
    expect(closeBtn().getAttribute('aria-label')).toBe('关闭关联记录选择器')
  })

  it('T1 batch-3: clicking the header close-× emits `close` with no payload (unchanged from pre-migration @click="emit(\'close\')")', async () => {
    mockListLinkOptions.mockResolvedValue({ selected: [], records: [], page: { offset: 0, limit: 50, total: 0, hasMore: false } })
    const onClose = vi.fn()
    const { visible } = mount({}, { onClose })
    visible.value = true
    await flushPromises()
    closeBtn().click()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith()
  })
})
