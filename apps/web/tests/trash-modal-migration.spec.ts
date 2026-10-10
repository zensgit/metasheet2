// UI-P2-1c T4 (docs/development/multitable-ui-p2-1c-tail-resolution-designlock-20260707.md §2-T4,
// RATIFIED) — TrashModal's two GENERIC action controls are migrated:
//   - `.meta-trash__close` (header ×) → MtIconButton
//   - `.meta-trash__cancel` (in-row "Cancel", exits the restore-confirmation state) → MtButton
//
// Red line (design-lock §2-T4): TrashModal is a delete-adjacent component (recycle-bin restore).
// `.meta-trash__restore` — BOTH the row-trigger "Restore" button AND the in-row "Confirm" button —
// is the actual restore (undo-delete) action and is explicitly NOT migrated here; only the header
// close and the confirmation Cancel (which just clears local `confirmingId` state, no API call) are
// "generic action buttons" in the T4 sense. This spec asserts the untouched buttons stay untouched
// (still native <button>, no MtButton class) alongside proving the migrated ones.
//
// This is TrashModal's first DOM-mount spec — it previously had only composable-level coverage
// (`multitable-trash-fe.spec.ts` tests `useTrash()` directly, never mounts <TrashModal>). It uses
// the UI-P2-1c T4 harness (`tests/helpers/mount-behind-flow.ts`) for BOTH mock shapes it documents:
// TrashModal's `useTrash()` call takes no `client` prop at all and falls back to the shared
// `multitableClient` singleton, so this spec exercises the harness's `patchMultitableClient()` path
// (not `createRoutedApiClient()`, which is exercised by the sibling
// `meta-form-share-manager-migration.spec.ts` for a `client`-PROP manager) — driving TrashModal from
// its initial loading state to its post-load, button-bearing phase with zero business-logic changes.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import TrashModal from '../src/multitable/components/TrashModal.vue'
import { useLocale } from '../src/composables/useLocale'
import {
  cleanupBehindFlowMounts,
  flushBehindFlow,
  mountBehindFlow,
  patchMultitableClient,
} from './helpers/mount-behind-flow'
import type { MetaDeletedRecord } from '../src/multitable/types'

function rec(id: string): MetaDeletedRecord {
  return { recordId: id, sheetId: 's1', data: { name: `Record ${id}` }, originalVersion: 1, createdBy: null, deletedBy: 'u1', deletedAt: '2026-07-01T00:00:00Z' }
}

let restorePatch: { restore: () => void } | null = null

afterEach(() => {
  cleanupBehindFlowMounts()
  restorePatch?.restore()
  restorePatch = null
  useLocale().setLocale('en')
})

function patchTrashClient(overrides: { listDeletedRecords?: ReturnType<typeof vi.fn>; restoreDeletedRecord?: ReturnType<typeof vi.fn> } = {}) {
  const listDeletedRecords = overrides.listDeletedRecords ?? vi.fn().mockResolvedValue({ records: [rec('r1'), rec('r2')], total: 2 })
  const restoreDeletedRecord = overrides.restoreDeletedRecord ?? vi.fn().mockResolvedValue({ restored: 'r1', sheetId: 's1' })
  restorePatch = patchMultitableClient({ listDeletedRecords, restoreDeletedRecord })
  return { listDeletedRecords, restoreDeletedRecord }
}

async function mountLoaded(props: Record<string, unknown> = {}) {
  const mount = mountBehindFlow(TrashModal, { open: true, sheetId: 's1', ...props })
  await flushBehindFlow()
  return mount
}

describe('TrashModal — header close-× MtIconButton migration (UI-P2-1c T4)', () => {
  it('renders the close control as a native <button> (MtIconButton) keeping the class + aria-label', async () => {
    useLocale().setLocale('en')
    patchTrashClient()
    const { container } = await mountLoaded()
    const btn = container.querySelector('.meta-trash__close') as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.getAttribute('aria-label')).toBe('Close')
    expect(btn.textContent?.trim()).toBe('×')
  })

  it('renders the localized (zh) aria-label unchanged', async () => {
    useLocale().setLocale('zh')
    patchTrashClient()
    const { container } = await mountLoaded()
    expect((container.querySelector('.meta-trash__close') as HTMLButtonElement).getAttribute('aria-label')).toBe('关闭')
  })

  it('clicking close emits `close` with no payload (unchanged from the pre-migration @click)', async () => {
    useLocale().setLocale('en')
    patchTrashClient()
    const onClose = vi.fn()
    const { container } = await mountLoaded({ onClose })
    ;(container.querySelector('.meta-trash__close') as HTMLButtonElement).click()
    await nextTick()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith()
  })
})

describe('TrashModal — confirmation Cancel MtButton migration (UI-P2-1c T4)', () => {
  it('shows the Cancel control only after entering restore-confirmation state, as a native <button> (MtButton)', async () => {
    useLocale().setLocale('en')
    patchTrashClient()
    const { container } = await mountLoaded()

    expect(container.querySelector('.meta-trash__cancel')).toBeNull()
    ;(container.querySelector('[data-test="trash-restore"]') as HTMLButtonElement).click()
    await nextTick()

    const cancelBtn = container.querySelector('.meta-trash__cancel') as HTMLButtonElement
    expect(cancelBtn).toBeTruthy()
    expect(cancelBtn.tagName).toBe('BUTTON')
    expect(cancelBtn.textContent?.trim()).toBe('Cancel')
  })

  it('clicking Cancel exits confirmation state WITHOUT calling restore (unchanged from pre-migration @click)', async () => {
    useLocale().setLocale('en')
    const { restoreDeletedRecord } = patchTrashClient()
    const { container } = await mountLoaded()

    ;(container.querySelector('[data-test="trash-restore"]') as HTMLButtonElement).click()
    await nextTick()
    ;(container.querySelector('.meta-trash__cancel') as HTMLButtonElement).click()
    await nextTick()

    expect(container.querySelector('.meta-trash__cancel')).toBeNull()
    expect(container.querySelector('[data-test="trash-restore"]')).toBeTruthy()
    expect(restoreDeletedRecord).not.toHaveBeenCalled()
  })

  it('renders the localized (zh) Cancel label unchanged', async () => {
    useLocale().setLocale('zh')
    patchTrashClient()
    const { container } = await mountLoaded()
    ;(container.querySelector('[data-test="trash-restore"]') as HTMLButtonElement).click()
    await nextTick()
    expect((container.querySelector('.meta-trash__cancel') as HTMLButtonElement).textContent?.trim()).toBe('取消')
  })
})

describe('TrashModal — red line: restore/confirm-restore stay untouched native buttons (UI-P2-1c T4)', () => {
  it('the row "Restore" trigger is still a bespoke native <button>, not an MtButton', async () => {
    useLocale().setLocale('en')
    patchTrashClient()
    const { container } = await mountLoaded()
    const restoreBtn = container.querySelector('[data-test="trash-restore"]') as HTMLButtonElement
    expect(restoreBtn.tagName).toBe('BUTTON')
    expect(restoreBtn.classList.contains('mt-button')).toBe(false)
  })

  it('the in-row "Confirm" restore button is still a bespoke native <button>, and clicking it still calls restore', async () => {
    useLocale().setLocale('en')
    const { restoreDeletedRecord } = patchTrashClient()
    const { container } = await mountLoaded()

    ;(container.querySelector('[data-test="trash-restore"]') as HTMLButtonElement).click()
    await nextTick()
    const confirmBtn = container.querySelector('[data-test="trash-restore-confirm"]') as HTMLButtonElement
    expect(confirmBtn.classList.contains('mt-button')).toBe(false)

    confirmBtn.click()
    await flushBehindFlow()
    expect(restoreDeletedRecord).toHaveBeenCalledWith('r1')
  })
})

describe('TrashModal — deleted-record recovery details', () => {
  it('uses the Deleted records label, renders only caller-visible before-side fields, and emits a sheet-qualified restore', async () => {
    useLocale().setLocale('en')
    const { restoreDeletedRecord } = patchTrashClient({
      listDeletedRecords: vi.fn().mockResolvedValue({
        records: [{ ...rec('r1'), data: { title: 'Visible title', hidden: 'must not render' } }], total: 1,
      }),
    })
    const onRestored = vi.fn()
    const { container } = await mountLoaded({
      fields: [
        { id: 'title', name: 'Title', type: 'text', order: 0 },
        { id: 'visible_missing', name: 'Visible missing', type: 'text', order: 1 },
      ],
      onRestored,
    })
    expect(container.querySelector('.meta-trash__title')?.textContent).toContain('Deleted records')
    const details = container.querySelector('[data-test="trash-record-details"]')?.textContent ?? ''
    expect(details).toContain('Title')
    expect(details).toContain('Visible title')
    expect(container.querySelector('dt[title="Title"]')).toBeTruthy()
    expect(container.querySelector('dd[title="Visible title"]')).toBeTruthy()
    expect(details).not.toContain('must not render')
    expect(container.querySelector('[data-test="trash-record-details-partial"]')?.textContent).toContain('Some visible')
    expect(container.querySelector('[data-test="trash-current-scope"]')?.textContent).toContain('Current recoverable')
    container.querySelector<HTMLButtonElement>('[data-test="trash-restore"]')!.click()
    await nextTick()
    container.querySelector<HTMLButtonElement>('[data-test="trash-restore-confirm"]')!.click()
    await flushBehindFlow()
    expect(restoreDeletedRecord).toHaveBeenCalledWith('r1')
    expect(onRestored).toHaveBeenCalledWith({ sheetId: 's1', recordId: 'r1' })
  })

  it('offers Load more for older current deleted records and appends them', async () => {
    useLocale().setLocale('en')
    let resolveMore: ((value: { records: MetaDeletedRecord[]; total: number }) => void) | undefined
    const { listDeletedRecords } = patchTrashClient({
      listDeletedRecords: vi.fn()
        .mockResolvedValueOnce({ records: [rec('newer')], total: 2 })
        .mockImplementationOnce(() => new Promise((resolve) => { resolveMore = resolve })),
    })
    const { container } = await mountLoaded()
    const more = container.querySelector<HTMLButtonElement>('[data-test="trash-load-more"]')
    expect(more?.textContent).toContain('Load more')
    more!.click()
    await nextTick()
    expect(more?.disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>('[data-test="trash-restore"]')?.disabled).toBe(true)
    resolveMore!({ records: [rec('older')], total: 2 })
    await flushBehindFlow()
    expect(listDeletedRecords).toHaveBeenNthCalledWith(2, 's1', { limit: 100, offset: 1 })
    expect([...container.querySelectorAll('[data-test="trash-record-title"]')].map((node) => node.getAttribute('title'))).toEqual(['newer', 'older'])
  })

  it('disables Load more while a restore is pending', async () => {
    useLocale().setLocale('en')
    let resolveRestore: ((value: { restored: string; sheetId: string }) => void) | undefined
    patchTrashClient({
      listDeletedRecords: vi.fn().mockResolvedValue({ records: [rec('r1')], total: 2 }),
      restoreDeletedRecord: vi.fn().mockImplementation(() => new Promise((resolve) => { resolveRestore = resolve })),
    })
    const { container } = await mountLoaded()
    container.querySelector<HTMLButtonElement>('[data-test="trash-restore"]')!.click()
    await nextTick()
    container.querySelector<HTMLButtonElement>('[data-test="trash-restore-confirm"]')!.click()
    await nextTick()
    expect(container.querySelector<HTMLButtonElement>('[data-test="trash-load-more"]')?.disabled).toBe(true)
    resolveRestore!({ restored: 'r1', sheetId: 's1' })
    await flushBehindFlow()
  })

  it('moves a selected history record to the top only after finding it in the current server list', async () => {
    useLocale().setLocale('en')
    const { listDeletedRecords } = patchTrashClient({
      listDeletedRecords: vi.fn().mockResolvedValue({ records: [rec('r1'), rec('r2')], total: 2 }),
    })
    const { container } = await mountLoaded({ selectedRecordId: 'r2' })
    const titles = [...container.querySelectorAll('[data-test="trash-record-title"]')].map((node) => node.getAttribute('title'))
    expect(titles).toEqual(['r2', 'r1'])
    expect(listDeletedRecords).toHaveBeenCalledWith('s1', { limit: 100, offset: 0 })
  })

  it('does not emit a restore after a close/reopen or unmount invalidates its pending operation', async () => {
    useLocale().setLocale('en')
    let resolveRestore: ((value: { restored: string; sheetId: string }) => void) | undefined
    patchTrashClient({
      restoreDeletedRecord: vi.fn().mockImplementation(() => new Promise((resolve) => { resolveRestore = resolve })),
    })
    const open = ref(true)
    const onRestored = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp(defineComponent({
      setup: () => () => h(TrashModal, { open: open.value, sheetId: 's1', onRestored }),
    }))
    try {
      app.mount(container)
      await flushBehindFlow()
      container.querySelector<HTMLButtonElement>('[data-test="trash-restore"]')!.click()
      await nextTick()
      container.querySelector<HTMLButtonElement>('[data-test="trash-restore-confirm"]')!.click()
      open.value = false
      await nextTick()
      open.value = true
      await flushBehindFlow()
      resolveRestore!({ restored: 'r1', sheetId: 's1' })
      await flushBehindFlow()
      expect(onRestored).not.toHaveBeenCalled()

      container.querySelector<HTMLButtonElement>('[data-test="trash-restore"]')!.click()
      await nextTick()
      container.querySelector<HTMLButtonElement>('[data-test="trash-restore-confirm"]')!.click()
      app.unmount()
      resolveRestore!({ restored: 'r1', sheetId: 's1' })
      await flushBehindFlow()
      expect(onRestored).not.toHaveBeenCalled()
    } finally {
      app.unmount()
      container.remove()
    }
  })
})
