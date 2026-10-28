/**
 * 客户问题 2026-10-27（4b）：点通知 / 评论深链 / URL #recordId 定位一条记录后，表格要把目标行滚进可视区。
 * MetaGridTable 对外暴露 scrollToRecord(recordId)：按行序号 × 行高（分组视图按 groupedItemOffsets）算偏移，
 * 把目标行滚到可视区中间；本来就整行可见、或是冻结行时不动；不在已加载的行里时返回 false。
 *
 * jsdom 没有布局：clientHeight 用 defineProperty 给出，行高走密度兜底值（normal = 36px），
 * 表头高度走默认值 37px，scrollHeight 为 0（不做上限）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

type GridHandle = { scrollToRecord: (recordId: string) => boolean }

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  useLocale().setLocale('en')
})

const FIELDS: MetaField[] = [
  { id: 'title', name: 'Title', type: 'string' },
  { id: 'score', name: 'Score', type: 'number' },
]
const GROUP_FIELD: MetaField = { id: 'group', name: 'Group', type: 'string' }

const ROW_HEIGHT = 36
const HEADER_HEIGHT = 37

function makeRows(n: number): MetaRecord[] {
  const rows: MetaRecord[] = []
  for (let i = 0; i < n; i++) {
    rows.push({ id: `r${i}`, version: 1, data: { title: `Row ${i}`, score: i, group: `Group ${i % 30}` } })
  }
  return rows
}

function mountGrid(rows: MetaRecord[], props: Record<string, unknown> = {}): { root: HTMLDivElement; grid: () => GridHandle } {
  container = document.createElement('div')
  document.body.appendChild(container)
  const gridRef = ref<GridHandle | null>(null)
  app = createApp({
    setup() {
      return () => h(MetaGridTable, {
        ref: gridRef,
        rows,
        visibleFields: FIELDS,
        sortRules: [],
        loading: false,
        currentPage: 1,
        totalPages: 1,
        startIndex: 0,
        canEdit: true,
        canDelete: true,
        searchText: '',
        rowDensity: 'normal',
        ...props,
      })
    },
  })
  app.mount(container)
  return { root: container, grid: () => gridRef.value! }
}

async function setViewport(root: HTMLDivElement, clientHeight: number): Promise<HTMLElement> {
  const wrap = root.querySelector('.meta-grid__table-wrap') as HTMLElement
  Object.defineProperty(wrap, 'clientHeight', { value: clientHeight, configurable: true })
  window.dispatchEvent(new Event('resize'))
  await nextTick()
  return wrap
}

function selectedRow(root: HTMLDivElement): HTMLElement | null {
  return root.querySelector<HTMLElement>('tbody tr.meta-grid__row--selected')
}

function rowNumberText(row: HTMLElement | null): string | undefined {
  return row?.querySelector('.meta-grid__row-num span')?.textContent?.trim()
}

// 目标行居中时的 scrollTop（与实现同一公式；冻结行占位 pinned 默认 0）。
function centeredScrollTop(rowIndex: number, viewport: number, pinned = 0): number {
  const visibleBody = viewport - HEADER_HEIGHT - pinned
  return Math.max(0, Math.round(rowIndex * ROW_HEIGHT - pinned - (visibleBody - ROW_HEIGHT) / 2))
}

describe('MetaGridTable scrollToRecord (customer issue 2026-10-27 4b)', () => {
  it('scrolls a far-down row of a virtualized flat grid to the middle and mounts it', async () => {
    const { root, grid } = mountGrid(makeRows(2000), { selectedRecordId: 'r1000' })
    const wrap = await setViewport(root, 600)
    // 起始窗口里没有第 1001 行。
    expect(selectedRow(root)).toBeNull()

    expect(grid().scrollToRecord('r1000')).toBe(true)
    await nextTick()

    expect(wrap.scrollTop).toBe(centeredScrollTop(1000, 600))
    const row = selectedRow(root)
    expect(row).toBeTruthy()
    expect(rowNumberText(row)).toBe('1001')
    // 仍然是虚拟滚动（没有把 2000 行全部渲染出来）。
    expect(root.querySelectorAll('tbody tr.meta-grid__row').length).toBeLessThan(200)
  })

  it('does not move the grid when the row is already fully visible', async () => {
    // 钉住「整行已可见就不滚动」。不能拿最顶上的行测——去掉这条判断后，居中公式算出的负值也会被夹到 0。
    // 先滚到 r1000（居中），再定位同屏的 r995：整行可见，scrollTop 应保持不变；
    // 去掉可见判断时会把 r995 重新居中（scrollTop 变成 centeredScrollTop(995, 600)），这条用例变红。
    const { root, grid } = mountGrid(makeRows(2000), { selectedRecordId: 'r995' })
    const wrap = await setViewport(root, 600)
    expect(grid().scrollToRecord('r1000')).toBe(true)
    await nextTick()
    const before = wrap.scrollTop
    expect(before).toBe(centeredScrollTop(1000, 600))
    expect(centeredScrollTop(995, 600)).not.toBe(before)

    expect(grid().scrollToRecord('r995')).toBe(true)
    await nextTick()

    expect(wrap.scrollTop).toBe(before)
    expect(rowNumberText(selectedRow(root))).toBe('996')
  })

  it('returns false and does not scroll for a record that is not among the loaded rows', async () => {
    const { root, grid } = mountGrid(makeRows(2000))
    const wrap = await setViewport(root, 600)

    expect(grid().scrollToRecord('rec_not_loaded')).toBe(false)
    expect(wrap.scrollTop).toBe(0)
  })

  it('also scrolls a small, non-virtualized grid', async () => {
    const { root, grid } = mountGrid(makeRows(40), { selectedRecordId: 'r35' })
    const wrap = await setViewport(root, 300)
    // 40 行低于虚拟滚动门槛，全部渲染。
    expect(root.querySelectorAll('tbody tr.meta-grid__row').length).toBe(40)

    expect(grid().scrollToRecord('r35')).toBe(true)
    expect(wrap.scrollTop).toBe(centeredScrollTop(35, 300))
  })

  it('accounts for frozen top rows and leaves a frozen target row where it is', async () => {
    const { root, grid } = mountGrid(makeRows(2000), { frozenTopRowCount: 3, selectedRecordId: 'r800' })
    const wrap = await setViewport(root, 600)

    expect(grid().scrollToRecord('r800')).toBe(true)
    await nextTick()
    expect(wrap.scrollTop).toBe(centeredScrollTop(800, 600, 3 * ROW_HEIGHT))
    expect(rowNumberText(selectedRow(root))).toBe('801')

    // 冻结行一直贴在表头下面：定位它不滚动。
    const before = wrap.scrollTop
    expect(grid().scrollToRecord('r1')).toBe(true)
    expect(wrap.scrollTop).toBe(before)
  })

  it('scrolls a far-down row of a virtualized grouped grid into the mounted window', async () => {
    // r2970 是「Group 0」组里的第 100 行，不在起始窗口里（无论分组排在第几）。
    const { root, grid } = mountGrid(makeRows(3000), { groupField: GROUP_FIELD, selectedRecordId: 'r2970' })
    const wrap = await setViewport(root, 600)
    expect(selectedRow(root)).toBeNull()

    expect(grid().scrollToRecord('r2970')).toBe(true)
    await nextTick()

    expect(wrap.scrollTop).toBeGreaterThan(0)
    expect(selectedRow(root)).toBeTruthy()
    expect(root.querySelectorAll('tbody tr.meta-grid__row').length).toBeLessThan(200)
  })
})
