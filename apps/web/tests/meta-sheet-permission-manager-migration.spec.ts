import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import MetaSheetPermissionManager from '../src/multitable/components/MetaSheetPermissionManager.vue'

// UI-P2-1c T1 batch-6 (multitable-ui-p2-1c-tail-resolution-designlock-20260707.md §2-T1, RATIFIED):
// the header close-× (`.meta-sheet-perm__close`) was migrated from a bespoke <button>&times;</button>
// to the shared MtIconButton primitive — the &times; glyph passes through MtIconButton's default-slot
// icon fallback (glyph char preserved, size token-normalized to the icon control, consistent with the
// existing glyph-MtIconButton controls already on main). Behavior-preservation proof: it stays a native,
// keyboard-operable <button>, keeps the SAME class (selector stability), and clicking it still calls the
// SAME requestClose() → emit('close') as before migration. The explicit `type="button"` attribute was
// dropped — DOM-behavior-equivalent, because MtButton (which MtIconButton wraps) hardcodes
// `type="button"` on its native <button> unconditionally (verified by reading MtButton.vue's template).
// This is the only sharer of `.meta-sheet-perm__close` (single button, single file) — its bespoke CSS
// was removed outright, no double-styling risk.
//
// Honest visual delta (not "zero visual change"): the glyph shrinks from 24px to MtIconButton's 14px
// icon-font size, and the control becomes a 32×32 box (was a borderless, unsized inline glyph).
//
// RED LINE: this file has 18 other raw <button>s (tab switch, save/apply/copy/remove/grant actions
// across sheet/field/view permission rows) — every one of them is TEXT-labeled (Save/Remove/Grant/tab
// names), NOT a × glyph, and NONE of them were touched. The `.meta-sheet-perm__tab` tab-switch button
// (pure local `activeTab` ref, no API/permission logic) is exercised below as a POSITIVE CONTROL to
// prove an untouched button still behaves exactly as before and that this harness can actually observe
// these controls.

const mounts: Array<{ app: VueApp<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.meta-sheet-perm').length).toBe(0) // residue guard
})

async function flushUi(cycles = 4) {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function makeClient() {
  return {
    listSheetPermissions: vi.fn().mockResolvedValue({ items: [] }),
    listSheetPermissionCandidates: vi.fn().mockResolvedValue({ items: [] }),
    updateSheetPermission: vi.fn().mockResolvedValue({}),
    updateFieldPermission: vi.fn().mockResolvedValue({}),
    updateViewPermission: vi.fn().mockResolvedValue({}),
  }
}

async function mountManager(opts: { onClose?: () => void } = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const onClose = opts.onClose ?? vi.fn()
  const client = makeClient()
  const app = createApp(MetaSheetPermissionManager, {
    visible: true,
    sheetId: 'sheet_orders',
    client,
    fields: [],
    views: [],
    fieldPermissionEntries: [],
    viewPermissionEntries: [],
    onClose,
    onUpdated: vi.fn(),
  })
  app.mount(container)
  await flushUi()
  mounts.push({ app, container })
  return { container, onClose, client }
}

describe('MetaSheetPermissionManager — header close-× MtIconButton migration (UI-P2-1c T1 batch-6)', () => {
  it('renders the header close-× as a native <button> (MtIconButton) keeping the class + glyph', async () => {
    const { container } = await mountManager()
    const btn = container.querySelector('.meta-sheet-perm__close') as HTMLButtonElement
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('meta-sheet-perm__close')).toBe(true)
    expect(btn.textContent?.trim()).toBe('×') // × glyph char preserved (size token-normalized)
    // the explicit type="button" attribute was dropped during migration — DOM-behavior-equivalent,
    // because MtButton (which MtIconButton wraps) hardcodes type="button" on its native <button>.
    expect(btn.getAttribute('type')).toBe('button')
  })

  it('clicking the header close-× emits `close` (unchanged — same requestClose() as before migration)', async () => {
    const { container, onClose } = await mountManager()
    const btn = container.querySelector('.meta-sheet-perm__close') as HTMLButtonElement
    btn.click()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith()
  })

  it('POSITIVE CONTROL: the untouched Field Permissions tab still switches activeTab exactly as before', async () => {
    const { container } = await mountManager()
    const tabs = Array.from(container.querySelectorAll('.meta-sheet-perm__tab')) as HTMLButtonElement[]
    expect(tabs.length).toBeGreaterThan(1) // sanity: harness can see the untouched tabs
    const fieldsTab = tabs.find((tab) => tab.getAttribute('aria-selected') === 'false')
    expect(fieldsTab).toBeTruthy() // not the already-active sheet tab
    expect(fieldsTab!.tagName).toBe('BUTTON') // still a raw <button>, NOT migrated

    fieldsTab!.click()
    await flushUi()

    expect(fieldsTab!.getAttribute('aria-selected')).toBe('true')
    expect(fieldsTab!.classList.contains('meta-sheet-perm__tab--active')).toBe(true)
  })
})
