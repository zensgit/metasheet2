/**
 * R-66 ① (owner ruling 2026-10-28「管理员也不能删 PLM 行」): a PLM row of a stock-preparation template sheet cannot be
 * deleted by anyone. The server marks such a row through the existing per-row channel — `rowActions.canDelete:
 * false` + `deleteBlockedReason: 'plm_row'` (GET /view rowActionOverrides, GET /records/:id, form context). The
 * record inspector keeps the delete entry VISIBLE but DISABLED with the reason inline (a disabled button's tooltip
 * is unreliable) and emits nothing; the route refuses anyway. Every other row is unchanged: deletable rows keep the
 * live entry, rows the actor cannot delete for any other reason keep no entry at all.
 *
 * The reason text is read through `workbenchLabel` (the SAME helper the component calls); its zh copy is the
 * server's RECORD_DELETE_REFUSED_PLM_ROW message verbatim (pinned below).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaRecordInspector from '../src/multitable/components/MetaRecordInspector.vue'
import type { MetaField, MetaRecord, MetaRowActions } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'
import { workbenchLabel } from '../src/multitable/utils/workbench-labels'

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}
async function openKebabMenu(root: HTMLElement) {
  root.querySelector<HTMLButtonElement>('[data-testid="record-inspector-menu"]')?.click()
  await flushUi()
}

const FIELDS = [{ id: 'fld_key', name: 'Key', type: 'string', property: {} }] as unknown as MetaField[]
const RECORD = { id: 'rec_plm', version: 1, data: { fld_key: 'K-1' } } as unknown as MetaRecord

let mounted: App | null = null

function mountInspector(rowActions: MetaRowActions | null, onDelete: () => void): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  mounted = createApp({
    render() {
      return h(MetaRecordInspector, {
        visible: true,
        record: RECORD,
        fields: FIELDS,
        canEdit: true,
        canComment: false,
        canDelete: true,
        rowActions,
        onDelete,
      })
    },
  })
  mounted.mount(container)
  return container
}

const liveDelete = () => [...document.querySelectorAll<HTMLButtonElement>('.meta-record-drawer__btn--danger')]
  .find((el) => el.getAttribute('data-testid') !== 'record-inspector-delete-blocked') ?? null
const blockedDelete = () => document.querySelector<HTMLButtonElement>('[data-testid="record-inspector-delete-blocked"]')
const blockedReason = () => document.querySelector('[data-testid="record-inspector-delete-blocked-reason"]')

afterEach(() => {
  mounted?.unmount()
  mounted = null
  document.body.innerHTML = ''
  useLocale().setLocale('en')
  vi.restoreAllMocks()
})

describe('MetaRecordInspector delete entry on a PLM row (rowActions.deleteBlockedReason)', () => {
  it('a PLM row: the entry is visible, disabled, shows the reason inline, and a click emits nothing', async () => {
    const onDelete = vi.fn()
    const container = mountInspector({ canEdit: true, canDelete: false, canComment: false, deleteBlockedReason: 'plm_row' }, onDelete)
    await openKebabMenu(container)
    const reason = workbenchLabel('notice.plmRowDeleteBlocked', false)
    const btn = blockedDelete()
    expect(btn).not.toBeNull()
    expect(btn!.disabled).toBe(true)
    expect(btn!.getAttribute('title')).toBe(reason)
    expect((blockedReason()?.textContent ?? '').trim()).toBe(reason)
    expect(liveDelete()).toBeNull()
    btn!.click()
    btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('zh: the reason is the server refusal copy verbatim', async () => {
    useLocale().setLocale('zh-CN')
    const container = mountInspector({ canEdit: true, canDelete: false, canComment: false, deleteBlockedReason: 'plm_row' }, vi.fn())
    await openKebabMenu(container)
    expect((blockedReason()?.textContent ?? '').trim()).toBe('这一行由备料插件（PLM 拉取）维护，不能删除；请在 PLM 里处理后重新拉取。')
  })

  it('a deletable row: unchanged — the live entry emits delete, no blocked entry', async () => {
    const onDelete = vi.fn()
    const container = mountInspector({ canEdit: true, canDelete: true, canComment: false }, onDelete)
    await openKebabMenu(container)
    expect(blockedDelete()).toBeNull()
    const btn = liveDelete()
    expect(btn).not.toBeNull()
    btn!.click()
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('a row the actor cannot delete for another reason (no deleteBlockedReason): no delete entry at all, as before', async () => {
    const container = mountInspector({ canEdit: true, canDelete: false, canComment: false }, vi.fn())
    await openKebabMenu(container)
    expect(blockedDelete()).toBeNull()
    expect(liveDelete()).toBeNull()
  })
})
