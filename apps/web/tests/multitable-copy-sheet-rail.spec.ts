/**
 * 复制数据表 S1 — rail surfaces (ADR docs/development/multitable-copy-sheet-with-data-adr-20260926.md
 * CS-2 entry ①, CS-14 badges), mounted on the REAL MetaSheetViewRail.
 *
 *   - Entry ① 「复制数据表」 renders ONLY with the server-derived `canCopySheet` bit, ONLY on the selected
 *     row (single-sheet bit, like canDeleteSheet), never while that row is being renamed; click emits
 *     `copy-sheet(activeId)` and nothing else.
 *   - Badges come ONLY from the server's `copiedFrom` via the api client's single adapter: 「快照副本」 for
 *     any copy, plus 「不随 PLM 刷新」 for the exact 'plugin-managed' kind; absent / malformed -> nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaSheetViewRail from '../src/multitable/components/MetaSheetViewRail.vue'
import type { MetaSheet, MetaView } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

const SHEETS: MetaSheet[] = [
  { id: 's1', name: 'Sales' },
  { id: 's2', name: 'Inventory' },
]
const VIEWS: MetaView[] = [{ id: 'v1', sheetId: 's1', name: 'Grid view', type: 'grid' }]

const mounted: Array<{ app: App<Element>; container: HTMLDivElement }> = []

function mountRail(props: Record<string, unknown>): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    setup: () => () => h(MetaSheetViewRail, {
      sheets: SHEETS,
      views: VIEWS,
      activeSheetId: 's1',
      activeViewId: 'v1',
      ...props,
    }),
  })
  app.mount(container)
  mounted.push({ app, container })
  return container
}

afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!
    m.app.unmount()
    m.container.remove()
  }
  useLocale().setLocale('en')
})

async function flush(): Promise<void> {
  await Promise.resolve()
  await nextTick()
}

const copyButtons = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLButtonElement>('[data-testid="rail-sheet-copy"]'))
const rowOf = (root: HTMLElement, sheetName: string) => Array.from(root.querySelectorAll<HTMLElement>('.meta-view-rail__sheet-row'))
  .find((row) => row.querySelector('.meta-view-rail__sheet-name')?.textContent === sheetName)!

describe('复制数据表 entry ① on the rail (canCopySheet-gated, selected sheet only)', () => {
  it('is hidden when canCopySheet is absent or false — even for a schema manager who can delete', () => {
    expect(copyButtons(mountRail({ canManageFields: true, canDeleteSheet: true })).length).toBe(0)
    expect(copyButtons(mountRail({ canManageFields: true, canDeleteSheet: true, canCopySheet: false })).length).toBe(0)
  })

  it('canCopySheet=true renders exactly one button, inside the ACTIVE row only', () => {
    const root = mountRail({ canCopySheet: true, activeSheetId: 's2' })
    const buttons = copyButtons(root)
    expect(buttons.length).toBe(1)
    expect(buttons[0].closest('.meta-view-rail__sheet-row')).toBe(rowOf(root, 'Inventory'))
    expect(rowOf(root, 'Sales').querySelector('[data-testid="rail-sheet-copy"]')).toBeNull()
  })

  it('click emits copy-sheet(activeId) and nothing else (no select/rename/delete)', () => {
    const onCopySheet = vi.fn()
    const onSelectSheet = vi.fn()
    const onRenameSheet = vi.fn()
    const onDeleteSheet = vi.fn()
    const root = mountRail({ canCopySheet: true, canDeleteSheet: true, canManageFields: true, onCopySheet, onSelectSheet, onRenameSheet, onDeleteSheet })
    copyButtons(root)[0].click()
    expect(onCopySheet).toHaveBeenCalledTimes(1)
    expect(onCopySheet).toHaveBeenCalledWith('s1')
    expect(onSelectSheet).not.toHaveBeenCalled()
    expect(onRenameSheet).not.toHaveBeenCalled()
    expect(onDeleteSheet).not.toHaveBeenCalled()
  })

  it('is hidden while the active row is being renamed and returns after cancel', async () => {
    const root = mountRail({ canCopySheet: true, canManageFields: true })
    ;(root.querySelector('[data-testid="rail-sheet-rename"]') as HTMLButtonElement).click()
    await flush()
    expect(copyButtons(root).length).toBe(0)
    ;(root.querySelector('[data-testid="rail-sheet-rename-cancel"]') as HTMLButtonElement).click()
    await flush()
    expect(copyButtons(root).length).toBe(1)
  })

  it('zh / en title + aria-label come from the rail label table', async () => {
    const root = mountRail({ canCopySheet: true })
    expect(copyButtons(root)[0].getAttribute('aria-label')).toBe('Copy table')
    useLocale().setLocale('zh-CN')
    await flush()
    expect(copyButtons(root)[0].getAttribute('title')).toBe('复制数据表')
    expect(copyButtons(root)[0].getAttribute('aria-label')).toBe('复制数据表')
  })
})

describe('快照副本 / 不随 PLM 刷新 badges (server copiedFrom only)', () => {
  const badgeTexts = (row: HTMLElement) => ({
    snapshot: row.querySelector('[data-testid="rail-sheet-copy-badge"]')?.textContent ?? null,
    noPlm: row.querySelector('[data-testid="rail-sheet-no-plm-refresh-badge"]')?.textContent ?? null,
  })

  it('user copy -> 快照副本 only; plugin-managed copy -> both; plain sheet -> none (zh)', () => {
    useLocale().setLocale('zh-CN')
    const sheets: MetaSheet[] = [
      { id: 'plain', name: '订单' },
      { id: 'user_copy', name: '订单 副本', copiedFrom: { kind: 'user', at: '2026-09-27T00:00:00Z' } },
      { id: 'plm_copy', name: '备料 副本', copiedFrom: { kind: 'plugin-managed', at: '2026-09-27T00:00:00Z' } },
    ]
    const root = mountRail({ sheets, activeSheetId: 'plain' })
    expect(badgeTexts(rowOf(root, '订单'))).toEqual({ snapshot: null, noPlm: null })
    expect(badgeTexts(rowOf(root, '订单 副本'))).toEqual({ snapshot: '快照副本', noPlm: null })
    expect(badgeTexts(rowOf(root, '备料 副本'))).toEqual({ snapshot: '快照副本', noPlm: '不随 PLM 刷新' })
  })

  it('malformed provenance renders no badge (fails closed)', () => {
    const sheets = [
      { id: 'a', name: 'A', copiedFrom: null },
      { id: 'b', name: 'B', copiedFrom: { kind: '' } },
      { id: 'c', name: 'C', copiedFrom: 'plugin-managed' },
      { id: 'd', name: 'D', copiedFrom: { at: '2026-09-27T00:00:00Z' } },
    ] as unknown as MetaSheet[]
    const root = mountRail({ sheets, activeSheetId: 'a' })
    expect(root.querySelectorAll('[data-testid="rail-sheet-copy-badge"]').length).toBe(0)
    expect(root.querySelectorAll('[data-testid="rail-sheet-no-plm-refresh-badge"]').length).toBe(0)
  })

  it('en labels, and badges sit next to the sheet name inside the treeitem', () => {
    const sheets: MetaSheet[] = [{ id: 'plm_copy', name: 'Prep copy', copiedFrom: { kind: 'plugin-managed' } }]
    const root = mountRail({ sheets, activeSheetId: 'plm_copy' })
    const node = root.querySelector('[data-testid="rail-sheet-node"]') as HTMLElement
    expect(node.querySelector('[data-testid="rail-sheet-copy-badge"]')?.textContent).toBe('Snapshot copy')
    expect(node.querySelector('[data-testid="rail-sheet-no-plm-refresh-badge"]')?.textContent).toBe('Not refreshed from PLM')
  })
})
