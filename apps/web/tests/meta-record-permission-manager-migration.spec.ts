import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import MetaRecordPermissionManager from '../src/multitable/components/MetaRecordPermissionManager.vue'

// UI-P2-1c T1 batch-6 (multitable-ui-p2-1c-tail-resolution-designlock-20260707.md §2-T1, RATIFIED):
// the header close-× (`.meta-record-perm__close`) was migrated from a bespoke <button>&times;</button>
// to the shared MtIconButton primitive — the &times; glyph passes through MtIconButton's default-slot
// icon fallback (glyph char preserved, size token-normalized to the icon control, consistent with the
// existing glyph-MtIconButton controls already on main). Behavior-preservation proof: it stays a native,
// keyboard-operable <button>, keeps the SAME class (selector stability), and clicking it still calls the
// SAME requestClose() → emit('close') as before migration. The explicit `type="button"` attribute was
// dropped — DOM-behavior-equivalent, because MtButton (which MtIconButton wraps) hardcodes
// `type="button"` on its native <button> unconditionally (verified by reading MtButton.vue's template).
// This is the only sharer of `.meta-record-perm__close` (single button, single file) — its bespoke CSS
// was removed outright, no double-styling risk.
//
// Honest visual delta (not "zero visual change"): the glyph shrinks from 24px to MtIconButton's 14px
// icon-font size, and the control becomes a 32×32 box (was a borderless, unsized inline glyph).
//
// RED LINE: this file's other raw <button>s (save/remove/grant actions across permission rows) are all
// TEXT-labeled (Save/Remove/Grant), NOT × glyphs, and NONE were touched. The `.meta-record-perm__action`
// "Remove" button (client.deleteRecordPermission + emit('updated')) is exercised below as a POSITIVE
// CONTROL, seeded via a mocked client, to prove an untouched button still behaves exactly as before and
// that this harness can actually observe these controls.

const mounts: Array<{ app: VueApp<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.meta-record-perm').length).toBe(0) // residue guard
})

async function flushUi(cycles = 4) {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function makeClient(overrides?: {
  listRecordPermissions?: ReturnType<typeof vi.fn>
  deleteRecordPermission?: ReturnType<typeof vi.fn>
}) {
  return {
    listRecordPermissions: overrides?.listRecordPermissions ?? vi.fn().mockResolvedValue([]),
    listSheetPermissions: vi.fn().mockResolvedValue({ items: [] }),
    listSheetPermissionCandidates: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 20, query: '' }),
    updateRecordPermission: vi.fn().mockResolvedValue(undefined),
    deleteRecordPermission: overrides?.deleteRecordPermission ?? vi.fn().mockResolvedValue(undefined),
  }
}

async function mountManager(opts: { onClose?: () => void; client?: ReturnType<typeof makeClient> } = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const onClose = opts.onClose ?? vi.fn()
  const client = opts.client ?? makeClient()
  const onUpdated = vi.fn()
  const app = createApp(MetaRecordPermissionManager, {
    visible: true,
    sheetId: 'sheet_1',
    recordId: 'record_1',
    client,
    onClose,
    onUpdated,
  })
  app.mount(container)
  await flushUi()
  mounts.push({ app, container })
  return { container, onClose, client, onUpdated }
}

describe('MetaRecordPermissionManager — header close-× MtIconButton migration (UI-P2-1c T1 batch-6)', () => {
  it('renders the header close-× as a native <button> (MtIconButton) keeping the class + glyph', async () => {
    const { container } = await mountManager()
    const btn = container.querySelector('.meta-record-perm__close') as HTMLButtonElement
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('meta-record-perm__close')).toBe(true)
    expect(btn.textContent?.trim()).toBe('×') // × glyph char preserved (size token-normalized)
    // the explicit type="button" attribute was dropped during migration — DOM-behavior-equivalent,
    // because MtButton (which MtIconButton wraps) hardcodes type="button" on its native <button>.
    expect(btn.getAttribute('type')).toBe('button')
  })

  it('clicking the header close-× emits `close` (unchanged — same requestClose() as before migration)', async () => {
    const { container, onClose } = await mountManager()
    const btn = container.querySelector('.meta-record-perm__close') as HTMLButtonElement
    btn.click()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith()
  })

  it('POSITIVE CONTROL: the untouched Remove button still calls deleteRecordPermission + emits `updated`', async () => {
    const deleteRecordPermission = vi.fn().mockResolvedValue(undefined)
    const client = makeClient({
      listRecordPermissions: vi.fn().mockResolvedValue([
        {
          id: 'perm_1',
          sheetId: 'sheet_1',
          recordId: 'record_1',
          subjectType: 'user',
          subjectId: 'user_alice',
          accessLevel: 'write',
          label: 'Alice',
          subtitle: 'alice@example.com',
          isActive: true,
        },
      ]),
      deleteRecordPermission,
    })

    const { container, onUpdated } = await mountManager({ client })

    const removeBtn = container.querySelector('.meta-record-perm__action--danger') as HTMLButtonElement
    expect(removeBtn).toBeTruthy()
    expect(removeBtn.tagName).toBe('BUTTON') // still a raw <button>, NOT migrated
    expect(removeBtn.textContent?.trim()).toBe('Remove')

    removeBtn.click()
    await flushUi()

    expect(deleteRecordPermission).toHaveBeenCalledTimes(1)
    expect(deleteRecordPermission).toHaveBeenCalledWith('sheet_1', 'record_1', 'perm_1')
    expect(onUpdated).toHaveBeenCalledTimes(1)
  })
})
