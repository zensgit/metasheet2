/**
 * R-66 ① (owner ruling 2026-10-28「管理员也不能删 PLM 行」): MetaGridTable's bulk delete on a stock-preparation sheet.
 * The server marks PLM rows through `rowActionOverrides` (`canDelete: false` + `deleteBlockedReason: 'plm_row'`).
 *  - a mixed selection: the bulk delete emits ONLY the deletable rows and says why the PLM rows were skipped;
 *  - a selection of only PLM rows: the delete button is hidden (nothing would be deleted), the reason is shown;
 *  - a selection with no PLM row: unchanged (button shown, no reason) — including a write-own skip, which has no
 *    `deleteBlockedReason` and keeps today's silent skip.
 * The grid binds no contextmenu handler, so there is no right-click delete to cover.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import { useMultitableGrid } from '../src/multitable/composables/useMultitableGrid'
import { MultitableApiClient } from '../src/multitable/api/client'
import type { MetaField, MetaRowActions } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'
import { workbenchLabel } from '../src/multitable/utils/workbench-labels'

const fields: MetaField[] = [{ id: 'fld_key', name: 'Key', type: 'string', property: {} }]
const rows = [
  { id: 'rec_plm_1', data: { fld_key: 'K-1' }, version: 1 },
  { id: 'rec_plm_2', data: { fld_key: 'K-2' }, version: 1 },
  { id: 'rec_hand', data: { fld_key: '' }, version: 1 },
]
const PLM: MetaRowActions = { canEdit: true, canDelete: false, canComment: true, deleteBlockedReason: 'plm_row' }

let app: App | null = null

function mount(rowActionOverrides: Record<string, MetaRowActions> | undefined, onBulkDelete: (ids: string[]) => void) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    render() {
      return h(MetaGridTable, {
        rows,
        visibleFields: fields,
        sortRules: [],
        loading: false,
        currentPage: 1,
        totalPages: 1,
        startIndex: 0,
        canEdit: true,
        canDelete: true,
        canBulkEdit: true,
        canComment: true,
        enableMultiSelect: true,
        rowActionOverrides,
        'onBulk-delete': onBulkDelete,
      })
    },
  })
  app.mount(container)
  return container
}

async function select(container: HTMLElement, ids: string[]) {
  const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('tbody .meta-grid__check-col input[type=checkbox]'))
  for (const id of ids) boxes[rows.findIndex((row) => row.id === id)]?.click()
  await nextTick()
}

const deleteButton = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('.meta-grid__bulk-btn--danger')
const skippedReason = (container: HTMLElement) => container.querySelector('[data-testid="grid-bulk-delete-plm-skipped"]')

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ''
  useLocale().setLocale('en')
  vi.restoreAllMocks()
})

describe('MetaGridTable bulk delete with PLM rows (R-66)', () => {
  it('a mixed selection: only the deletable row is emitted, and the skip reason is shown', async () => {
    const onBulkDelete = vi.fn()
    const container = mount({ rec_plm_1: PLM, rec_plm_2: PLM }, onBulkDelete)
    await select(container, ['rec_plm_1', 'rec_plm_2', 'rec_hand'])
    expect((skippedReason(container)?.textContent ?? '').trim()).toBe(workbenchLabel('notice.plmRowDeleteBlocked', false))
    const btn = deleteButton(container)
    expect(btn).not.toBeNull()
    btn!.click()
    expect(onBulkDelete).toHaveBeenCalledTimes(1)
    expect(onBulkDelete).toHaveBeenCalledWith(['rec_hand'])
  })

  it('only PLM rows selected: the delete button is hidden and the reason is shown (zh copy = server copy)', async () => {
    useLocale().setLocale('zh-CN')
    const onBulkDelete = vi.fn()
    const container = mount({ rec_plm_1: PLM, rec_plm_2: PLM }, onBulkDelete)
    await select(container, ['rec_plm_1', 'rec_plm_2'])
    expect(deleteButton(container)).toBeNull()
    expect((skippedReason(container)?.textContent ?? '').trim()).toBe('这一行由备料插件（PLM 拉取）维护，不能删除；请在 PLM 里处理后重新拉取。')
    expect(onBulkDelete).not.toHaveBeenCalled()
  })

  it('no PLM row in the selection: unchanged — button shown, no reason, every row emitted', async () => {
    const onBulkDelete = vi.fn()
    const container = mount(undefined, onBulkDelete)
    await select(container, ['rec_plm_1', 'rec_hand'])
    expect(skippedReason(container)).toBeNull()
    deleteButton(container)!.click()
    expect(onBulkDelete).toHaveBeenCalledWith(['rec_plm_1', 'rec_hand'])
  })

  it('the grid composable refuses a PLM row before any request and says why; other refusals keep the generic text', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 }))
    const grid = useMultitableGrid({ sheetId: ref(''), viewId: ref(''), client: new MultitableApiClient({ fetchFn }) })
    grid.rows.value = [{ id: 'rec_plm_1', version: 1, data: { fld_key: 'K-1' } }, { id: 'rec_own', version: 1, data: {} }]
    grid.rowActions.value = { canEdit: true, canDelete: true, canComment: true }
    grid.rowActionOverrides.value = { rec_plm_1: PLM, rec_own: { canEdit: true, canDelete: false, canComment: true } }
    await expect(grid.deleteRecord('rec_plm_1')).resolves.toBe(false)
    expect(grid.error.value).toBe(workbenchLabel('notice.plmRowDeleteBlocked', false))
    await expect(grid.deleteRecord('rec_own')).resolves.toBe(false)
    expect(grid.error.value).toBe('Record deletion is not allowed for this row.')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('a non-PLM skip (write-own: canDelete false, no reason) keeps today\'s silent skip and the button', async () => {
    const onBulkDelete = vi.fn()
    const container = mount({ rec_plm_1: { canEdit: true, canDelete: false, canComment: true } }, onBulkDelete)
    await select(container, ['rec_plm_1'])
    expect(skippedReason(container)).toBeNull()
    expect(deleteButton(container)).not.toBeNull()
  })
})
