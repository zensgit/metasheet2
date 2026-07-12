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
// UI-P2-1c T1 batch-5 (multitable-ui-p2-1c-tail-resolution-designlock-20260707.md §2-T1, RATIFIED):
// the header close-× (`.meta-link-picker__close`) was additionally migrated from a bespoke
// <button>&times;</button> to the shared MtIconButton primitive — the &times; glyph passes through
// MtIconButton's default-slot icon fallback (glyph char preserved, size token-normalized to the icon
// control, consistent with the existing glyph-MtIconButton controls already on main). Behavior-
// preservation proof: it stays a native, keyboard-operable <button>, keeps the SAME aria-label
// (`lp('linkPicker.close')`), and clicking it still emits the SAME `close` event with no payload
// (identical to the footer cancel button's handler). This is the only sharer of
// `.meta-link-picker__close` (single button, single file) — its bespoke CSS was removed outright,
// no double-styling risk.
//
// NOT migrated (classifier — verified against the handler, not the label): the per-chip
// `.meta-link-picker__chip-remove` × glyph button (`@click="removeSelected(item.id)"`) is a
// remove-selected-item control, not a close/dismiss — it stays a bespoke native <button>, out of
// T1 scope. The positive-control test below proves it (a) still removes just that chip, (b) does
// NOT emit `close`, and (c) is unaffected by the close-× migration.

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
const chipRemoveBtns = () => Array.from(document.querySelectorAll('.meta-link-picker__chip-remove')) as HTMLButtonElement[]

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

  it('renders the header close-× as a native <button> (MtIconButton) keeping the class + aria-label + glyph', async () => {
    mockListLinkOptions.mockResolvedValue({ selected: [], records: [], page: { offset: 0, limit: 50, total: 0, hasMore: false } })
    const { visible } = mount()
    visible.value = true
    await flushPromises()
    const btn = closeBtn()
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('meta-link-picker__close')).toBe(true)
    expect(btn.getAttribute('aria-label')).toBe('Close link picker')
    expect(btn.textContent?.trim()).toBe('×') // × glyph char preserved (size token-normalized)
  })

  it('clicking the header close-× emits `close` (unchanged — same emit as the footer cancel button)', async () => {
    mockListLinkOptions.mockResolvedValue({ selected: [], records: [], page: { offset: 0, limit: 50, total: 0, hasMore: false } })
    const onClose = vi.fn()
    const { visible } = mount({}, { onClose })
    visible.value = true
    await flushPromises()
    closeBtn().click()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith()
  })

  it('positive control: the per-chip remove-× is NOT the close-× — it stays a bespoke <button>, removes only that chip, and does NOT emit `close`', async () => {
    mockListLinkOptions.mockResolvedValue({
      selected: [
        { id: 'vendor_1', display: 'Acme Supply' },
        { id: 'vendor_2', display: 'Beacon Labs' },
      ],
      records: [],
      page: { offset: 0, limit: 50, total: 0, hasMore: false },
    })
    const onClose = vi.fn()
    const { container, visible } = mount({ currentValue: ['vendor_1', 'vendor_2'] }, { onClose })
    visible.value = true
    await flushPromises()

    const chips = chipRemoveBtns()
    expect(chips.length).toBe(2)
    chips.forEach((btn) => expect(btn.tagName).toBe('BUTTON'))

    chips[0].click()
    await nextTick()

    // exactly one chip removed, the close handler was never invoked by this click
    expect(chipRemoveBtns().length).toBe(1)
    expect(onClose).not.toHaveBeenCalled()
    // dialog itself is untouched by the removal — still mounted, close-× still present and functional
    expect(container.querySelector('.meta-link-picker__close')).toBeTruthy()
    closeBtn().click()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
