import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import SheetTrashModal from '../src/multitable/components/SheetTrashModal.vue'
import { useLocale } from '../src/composables/useLocale'
import type { DeletedSheet, DeletedSheetPage } from '../src/multitable/api/client'

const sheet = (id = 's1', baseId = 'b1'): DeletedSheet => ({ id, baseId, name: `Table ${id}`, description: null, deletedAt: '2026-09-14T08:00:00.000Z' })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function flush() { for (let i = 0; i < 12; i++) { await Promise.resolve(); await nextTick() } }
const q = (id: string) => document.body.querySelector(`[data-test="${id}"]`) as HTMLElement | null
async function click(id: string) { expect(q(id)).not.toBeNull(); q(id)!.click(); await flush() }

describe('sheet recycle bin', () => {
  let app: App | undefined
  let host: HTMLElement
  let state: { open: boolean; baseId: string }
  let list: ReturnType<typeof vi.fn>
  let restore: ReturnType<typeof vi.fn>
  let restored: ReturnType<typeof vi.fn>
  beforeEach(() => {
    useLocale().setLocale('en')
    list = vi.fn().mockResolvedValue({ sheets: [sheet()], nextCursor: null })
    restore = vi.fn().mockResolvedValue({ restored: 's1', sheet: sheet() })
    restored = vi.fn()
    state = reactive({ open: true, baseId: 'b1' })
    host = document.createElement('div'); document.body.appendChild(host)
  })
  afterEach(() => { app?.unmount(); host.remove(); document.body.innerHTML = ''; vi.restoreAllMocks() })
  async function mount() {
    app = createApp({ render: () => h(SheetTrashModal, { ...state, client: { listDeletedSheets: list, restoreSheet: restore }, onRestored: restored, onClose: () => { state.open = false } }) })
    app.mount(host); await flush()
  }

  it('lists deleted TABLES, names and local deletion times, not record trash', async () => {
    await mount()
    expect(list).toHaveBeenCalledWith('b1', { limit: 20 })
    expect(q('sheet-trash-row')?.textContent).toContain('Table s1')
    expect(q('sheet-trash-row')?.querySelector('time')?.getAttribute('datetime')).toBe(sheet().deletedAt)
    expect(q('sheet-trash-restore')?.textContent).toBe('Restore table')
    expect(restore).not.toHaveBeenCalled()
  })

  it('requires explicit confirmation; cancel does not restore; success removes only the restored table', async () => {
    list.mockResolvedValue({ sheets: [sheet(), sheet('s2')], nextCursor: null })
    await mount(); await click('sheet-trash-restore')
    expect(q('sheet-trash-row')?.textContent).toContain('retained records, fields and views')
    expect(restore).not.toHaveBeenCalled()
    await click('sheet-trash-cancel')
    expect(restore).not.toHaveBeenCalled()
    await click('sheet-trash-restore'); await click('sheet-trash-confirm')
    expect(restore.mock.calls).toEqual([['s1']])
    expect(restored.mock.calls).toEqual([[{ baseId: 'b1', sheetId: 's1' }]])
    expect(document.querySelectorAll('[data-test="sheet-trash-row"]')).toHaveLength(1)
    expect(q('sheet-trash-row')?.textContent).toContain('Table s2')
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Restored table')
  })

  it.each(['FORBIDDEN', 'NOT_FOUND', 'RECOVERY_IN_PROGRESS'])('keeps the row and shows a safe error on %s', async (code) => {
    restore.mockRejectedValue(Object.assign(new Error('secret-hostile-server-message'), { code }))
    await mount(); await click('sheet-trash-restore'); await click('sheet-trash-confirm')
    expect(restored).not.toHaveBeenCalled()
    expect(q('sheet-trash-row')).not.toBeNull()
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('secret-hostile')
  })

  it('does not report success for a mismatched restore response', async () => {
    restore.mockResolvedValue({ restored: 'other', sheet: sheet('other') })
    await mount(); await click('sheet-trash-restore'); await click('sheet-trash-confirm')
    expect(restored).not.toHaveBeenCalled(); expect(q('sheet-trash-row')).not.toBeNull()
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('loads more with the returned cursor and deduplicates overlapping pages', async () => {
    list.mockResolvedValueOnce({ sheets: [sheet()], nextCursor: 'opaque' })
      .mockResolvedValueOnce({ sheets: [sheet(), sheet('s2')], nextCursor: null })
    await mount(); await click('sheet-trash-more')
    expect(list).toHaveBeenLastCalledWith('b1', { limit: 20, cursor: 'opaque' })
    expect(document.querySelectorAll('[data-test="sheet-trash-row"]')).toHaveLength(2)
    expect(q('sheet-trash-more')).toBeNull()
  })

  it('suspends restore confirmation while a page is loading', async () => {
    const page = deferred<DeletedSheetPage>()
    list.mockResolvedValueOnce({ sheets: [sheet()], nextCursor: 'next' }).mockReturnValueOnce(page.promise)
    await mount(); await click('sheet-trash-restore'); await click('sheet-trash-more')
    expect((q('sheet-trash-confirm') as HTMLButtonElement).disabled).toBe(true)
    await click('sheet-trash-confirm')
    expect(restore).not.toHaveBeenCalled()
    page.resolve({ sheets: [sheet('s2')], nextCursor: null }); await flush()
    await click('sheet-trash-confirm')
    expect(restore.mock.calls).toEqual([['s1']])
    expect(q('sheet-trash-row')?.textContent).toContain('Table s2')
  })

  it('retries a failed next page without dropping loaded rows or its cursor', async () => {
    list.mockResolvedValueOnce({ sheets: [sheet()], nextCursor: 'next' })
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce({ sheets: [sheet('s2')], nextCursor: null })
    await mount(); await click('sheet-trash-more'); await click('sheet-trash-retry')
    expect(list).toHaveBeenLastCalledWith('b1', { limit: 20, cursor: 'next' })
    expect(document.querySelectorAll('[data-test="sheet-trash-row"]')).toHaveLength(2)
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('uses list-specific permission copy and rejects a restore for another base', async () => {
    list.mockRejectedValueOnce(Object.assign(new Error('hostile'), { code: 'FORBIDDEN' }))
      .mockResolvedValueOnce({ sheets: [sheet()], nextCursor: null })
    await mount()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('You do not have permission to view this recycle bin.')
    await click('sheet-trash-retry')
    restore.mockResolvedValue({ restored: 's1', sheet: sheet('s1', 'b2') })
    await click('sheet-trash-restore'); await click('sheet-trash-confirm')
    expect(restored).not.toHaveBeenCalled()
    expect(q('sheet-trash-row')).not.toBeNull()
  })

  it('shows empty/error separately and can retry a failed list', async () => {
    list.mockRejectedValueOnce(new Error('server')).mockResolvedValueOnce({ sheets: [], nextCursor: null })
    await mount()
    expect(q('sheet-trash-empty')).toBeNull()
    await click('sheet-trash-retry')
    expect(q('sheet-trash-empty')?.textContent).toBe('No deleted tables')
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('ignores a delayed list from the previous base', async () => {
    const old = deferred<DeletedSheetPage>()
    list.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ sheets: [sheet('s2', 'b2')], nextCursor: null })
    await mount(); state.baseId = 'b2'; await flush()
    old.resolve({ sheets: [sheet()], nextCursor: 'old' }); await flush()
    expect(q('sheet-trash-row')?.textContent).toContain('Table s2')
    expect(document.body.textContent).not.toContain('Table s1')
    expect(q('sheet-trash-more')).toBeNull()
  })

  it('ignores old restore completion after a base switch and blocks double submission', async () => {
    const old = deferred<{ restored: string; sheet: DeletedSheet }>()
    restore.mockReturnValueOnce(old.promise)
    await mount(); await click('sheet-trash-restore'); await click('sheet-trash-confirm'); await click('sheet-trash-confirm')
    expect(restore).toHaveBeenCalledTimes(1)
    list.mockResolvedValue({ sheets: [sheet('s2', 'b2')], nextCursor: null })
    state.baseId = 'b2'; await flush()
    old.resolve({ restored: 's1', sheet: sheet() }); await flush()
    expect(restored).not.toHaveBeenCalled()
    expect(q('sheet-trash-row')?.textContent).toContain('Table s2')
  })

  it('does not fetch when closed or base is absent', async () => {
    state.open = false; await mount(); expect(list).not.toHaveBeenCalled()
    state.baseId = ''; state.open = true; await flush(); expect(list).not.toHaveBeenCalled()
  })

  it('does not repopulate a reopened same-base dialog from an earlier list', async () => {
    const old = deferred<DeletedSheetPage>()
    list.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ sheets: [sheet('s2')], nextCursor: null })
    await mount(); state.open = false; await flush(); state.open = true; await flush()
    old.resolve({ sheets: [sheet()], nextCursor: 'stale' }); await flush()
    expect(q('sheet-trash-row')?.textContent).toContain('Table s2')
    expect(document.body.textContent).not.toContain('Table s1')
    expect(q('sheet-trash-more')).toBeNull()
  })

  it('does not emit an earlier restore into a reopened same-base dialog', async () => {
    const old = deferred<{ restored: string; sheet: DeletedSheet }>()
    restore.mockReturnValueOnce(old.promise)
    await mount(); await click('sheet-trash-restore'); await click('sheet-trash-confirm')
    state.open = false; await flush(); state.open = true; await flush()
    old.resolve({ restored: 's1', sheet: sheet() }); await flush()
    expect(restored).not.toHaveBeenCalled()
    expect(q('sheet-trash-row')?.textContent).toContain('Table s1')
  })
})
