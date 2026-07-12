import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import MetaPersonPicker from '../src/multitable/components/MetaPersonPicker.vue'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c: MetaPersonPicker's two footer action controls (cancel / confirm) were migrated from
// bespoke <button>s to the shared MtButton primitive (confirm = variant="primary", matching the
// #409eff filled-blue precedent landed for MetaBulkEditDialog in #3826). Behavior-preservation
// proof: they stay native, keyboard-operable <button>s; clicking cancel still emits `close`; and
// clicking confirm still emits `confirm` with the SAME { userIds, summaries } payload as the
// pre-migration onConfirm. The `watch(() => props.visible, …)` is non-immediate, so mounting with
// visible:true does NOT trigger loadMembers() — no directory API to stub, selection stays empty.
// The dialog is an inline v-if overlay (not teleported), but we query `document` for robustness.
//
// UI-P2-1c T1 batch-5 (multitable-ui-p2-1c-tail-resolution-designlock-20260707.md §2-T1, RATIFIED):
// the header close-× (`.meta-person-picker__close`) was additionally migrated from a bespoke
// <button>&times;</button> to the shared MtIconButton primitive — the &times; glyph passes through
// MtIconButton's default-slot icon fallback (glyph char preserved, size token-normalized to the icon
// control, consistent with the existing glyph-MtIconButton controls already on main). Behavior-
// preservation proof: it stays a native, keyboard-operable <button>, keeps the SAME aria-label
// (`pp('personPicker.close')`), and clicking it still emits the SAME `close` event with no payload
// (identical to the footer cancel button's handler). This is the only sharer of
// `.meta-person-picker__close` (single button, single file) — its bespoke CSS was removed outright,
// no double-styling risk.
//
// NOT migrated (classifier — verified against the handler, not the label): the per-chip
// `.meta-person-picker__chip-remove` × glyph button (`@click="removeSelected(item.id)"`) is a
// remove-selected-item control, not a close/dismiss — it stays a bespoke native <button>, out of
// T1 scope. The positive-control test below proves it (a) still removes just that chip, (b) does
// NOT emit `close`, and (c) is unaffected by the close-× migration.

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.meta-person-picker__overlay').length).toBe(0) // residue guard
  useLocale().setLocale('en')
})

function mount(props: Record<string, unknown>, handlers: Record<string, unknown> = {}) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const app = createApp({ setup: () => () => h(MetaPersonPicker, { ...props, ...handlers }) })
  app.mount(container)
  mounts.push({ app, container })
}

// Reactive `visible` ref so flipping false->true fires the non-immediate `watch(() => props.visible)`,
// which is what actually populates `selected`/`summaryById` from `currentValue` — needed to render a
// selected chip (and its chip-remove ×) for the positive-control test below.
function mountWithVisibleToggle(extraProps: Record<string, unknown> = {}, handlers: Record<string, unknown> = {}) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const visible = ref(false)
  const Harness = defineComponent({
    setup: () => () => h(MetaPersonPicker, { visible: visible.value, sheetId: 's1', ...extraProps, ...handlers }),
  })
  const app = createApp(Harness)
  app.mount(container)
  mounts.push({ app, container })
  return { container, visible }
}

const baseProps = () => ({ visible: true, sheetId: 's1' })
const closeBtn = () => document.querySelector('.meta-person-picker__close') as HTMLButtonElement
const cancelBtn = () => document.querySelector('.meta-person-picker__cancel') as HTMLButtonElement
const confirmBtn = () => document.querySelector('.meta-person-picker__confirm') as HTMLButtonElement
const chipRemoveBtns = () => Array.from(document.querySelectorAll('.meta-person-picker__chip-remove')) as HTMLButtonElement[]

describe('MetaPersonPicker — MtButton migration (UI-P2-1c)', () => {
  it('renders cancel + confirm as native, enabled <button>s (keyboard-operable, not bare divs)', () => {
    mount(baseProps())
    expect(cancelBtn().tagName).toBe('BUTTON')
    expect(confirmBtn().tagName).toBe('BUTTON')
    // no :disabled binding on either footer control — both are active on initial mount
    expect(cancelBtn().disabled).toBe(false)
    expect(confirmBtn().disabled).toBe(false)
    // data-test hook survives the migration (existing person-picker suite queries it)
    expect(confirmBtn().getAttribute('data-test')).toBe('person-picker-confirm')
  })

  it('clicking cancel emits `close` (unchanged from pre-migration @click="emit(\'close\')")', () => {
    const onClose = vi.fn()
    mount(baseProps(), { onClose })
    cancelBtn().click()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clicking confirm emits `confirm` with the same { userIds, summaries } payload (onConfirm intact)', () => {
    const onConfirm = vi.fn()
    mount(baseProps(), { onConfirm })
    confirmBtn().click()
    expect(onConfirm).toHaveBeenCalledTimes(1)
    // selection empty (loadMembers never ran) → onConfirm emits empty arrays, exactly as before
    expect(onConfirm).toHaveBeenCalledWith({ userIds: [], summaries: [] })
  })

  it('renders the header close-× as a native <button> (MtIconButton) keeping the class + aria-label + glyph', () => {
    mount(baseProps())
    const btn = closeBtn()
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('meta-person-picker__close')).toBe(true)
    expect(btn.getAttribute('aria-label')).toBe('Close people picker')
    expect(btn.textContent?.trim()).toBe('×') // × glyph char preserved (size token-normalized)
  })

  it('renders the localized (zh) aria-label unchanged', () => {
    useLocale().setLocale('zh')
    mount(baseProps())
    expect(closeBtn().getAttribute('aria-label')).toBe('关闭人员选择器')
  })

  it('clicking the header close-× emits `close` (unchanged — same emit as the footer cancel button)', () => {
    const onClose = vi.fn()
    mount(baseProps(), { onClose })
    closeBtn().click()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith()
  })

  it('positive control: the per-chip remove-× is NOT the close-× — it stays a bespoke <button>, removes only that chip, and does NOT emit `close`', async () => {
    const onClose = vi.fn()
    const { visible, container } = mountWithVisibleToggle({ currentValue: ['u1', 'u2'] }, { onClose })
    visible.value = true
    await nextTick()

    const chips = chipRemoveBtns()
    expect(chips.length).toBe(2) // both stored ids rendered as chips (populated via the visible-toggle watcher)
    chips.forEach((btn) => expect(btn.tagName).toBe('BUTTON'))

    chips[0].click()
    await nextTick()

    // exactly one chip removed, the close handler was never invoked by this click
    expect(chipRemoveBtns().length).toBe(1)
    expect(onClose).not.toHaveBeenCalled()
    // dialog itself is untouched by the removal — still mounted, close-× still present and functional
    expect(container.querySelector('.meta-person-picker__close')).toBeTruthy()
    closeBtn().click()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
