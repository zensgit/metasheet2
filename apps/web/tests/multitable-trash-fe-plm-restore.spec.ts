/**
 * R-66 (owner ruling 2026-10-28「管理员也不能删 PLM 行」): restoring a deleted PLM row of a stock-preparation template
 * sheet is refused while a live row already holds its key (two rows with one key would hold every later pull) or
 * when the key column cannot be resolved. The trash list marks such rows with `restoreBlocked`; TrashModal shows the
 * Restore button DISABLED with the reason inline (display only — the restore route decides). Every other row keeps
 * today's Restore → Confirm flow.
 *
 * Mounted through the shared mount-behind-flow harness (TrashModal falls back to the multitableClient singleton).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import TrashModal from '../src/multitable/components/TrashModal.vue'
import { useLocale } from '../src/composables/useLocale'
import { workbenchLabel } from '../src/multitable/utils/workbench-labels'
import {
  cleanupBehindFlowMounts,
  flushBehindFlow,
  mountBehindFlow,
  patchMultitableClient,
} from './helpers/mount-behind-flow'
import type { MetaDeletedRecord } from '../src/multitable/types'

function rec(id: string, restoreBlocked?: MetaDeletedRecord['restoreBlocked']): MetaDeletedRecord {
  return {
    recordId: id, sheetId: 's1', data: { name: `Record ${id}` }, originalVersion: 1, createdBy: null, deletedBy: 'u1',
    deletedAt: '2026-10-28T00:00:00Z', ...(restoreBlocked ? { restoreBlocked } : {}),
  }
}

let restorePatch: { restore: () => void } | null = null

afterEach(() => {
  cleanupBehindFlowMounts()
  restorePatch?.restore()
  restorePatch = null
  useLocale().setLocale('en')
})

async function mountWith(records: MetaDeletedRecord[]) {
  const listDeletedRecords = vi.fn().mockResolvedValue({ records, total: records.length })
  const restoreDeletedRecord = vi.fn().mockResolvedValue({ restored: records[0]?.recordId, sheetId: 's1' })
  restorePatch = patchMultitableClient({ listDeletedRecords, restoreDeletedRecord })
  const mount = mountBehindFlow(TrashModal, { open: true, sheetId: 's1', fields: [{ id: 'name', name: 'Name', type: 'string', order: 0 }] })
  await flushBehindFlow()
  return { ...mount, restoreDeletedRecord }
}

const rowsOf = (container: Element) => Array.from(container.querySelectorAll('.meta-trash__row'))

describe('TrashModal restore of a deleted PLM row (R-66, restoreBlocked)', () => {
  it('plm_key_active: Restore is disabled with the reason inline; clicking it asks nothing and restores nothing', async () => {
    const { container, restoreDeletedRecord } = await mountWith([rec('r_live', 'plm_key_active')])
    const [row] = rowsOf(container)
    const btn = row.querySelector<HTMLButtonElement>('[data-test="trash-restore"]')!
    const reason = workbenchLabel('notice.plmRowRestoreBlocked', false)
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('title')).toBe(reason)
    expect((row.querySelector('[data-test="trash-restore-blocked-reason"]')?.textContent ?? '').trim()).toBe(reason)
    btn.click()
    await flushBehindFlow()
    expect(row.querySelector('[data-test="trash-restore-confirm"]')).toBeNull()
    expect(restoreDeletedRecord).not.toHaveBeenCalled()
  })

  it('plm_key_unresolved: disabled with the key-column reason; zh copy = the server copy', async () => {
    useLocale().setLocale('zh')
    const { container } = await mountWith([rec('r_unres', 'plm_key_unresolved')])
    const [row] = rowsOf(container)
    expect(row.querySelector<HTMLButtonElement>('[data-test="trash-restore"]')!.disabled).toBe(true)
    expect((row.querySelector('[data-test="trash-restore-blocked-reason"]')?.textContent ?? '').trim())
      .toBe('这张表由备料插件维护，但识别不出唯一键列，为安全起见不能删除 / 恢复行。')
  })

  it('zh plm_key_active copy = the server RECORD_RESTORE_REFUSED_PLM_KEY_ACTIVE message', async () => {
    useLocale().setLocale('zh')
    const { container } = await mountWith([rec('r_live', 'plm_key_active')])
    expect((rowsOf(container)[0].querySelector('[data-test="trash-restore-blocked-reason"]')?.textContent ?? '').trim())
      .toBe('表里已有同一唯一键的有效行，这条已删除的 PLM 行不能恢复（恢复会造成同键两行，拉取会被卡住）。')
  })

  it('a row without restoreBlocked keeps the Restore → Confirm flow (unchanged)', async () => {
    const { container, restoreDeletedRecord } = await mountWith([rec('r_free'), rec('r_live', 'plm_key_active')])
    const [free, blocked] = rowsOf(container)
    expect(free.querySelector('[data-test="trash-restore-blocked-reason"]')).toBeNull()
    expect(blocked.querySelector('[data-test="trash-restore-blocked-reason"]')).not.toBeNull()
    const btn = free.querySelector<HTMLButtonElement>('[data-test="trash-restore"]')!
    expect(btn.disabled).toBe(false)
    btn.click()
    await flushBehindFlow()
    container.querySelector<HTMLButtonElement>('[data-test="trash-restore-confirm"]')!.click()
    await flushBehindFlow()
    expect(restoreDeletedRecord).toHaveBeenCalledTimes(1)
    expect(restoreDeletedRecord.mock.calls[0][0]).toBe('r_free')
  })
})
