import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  useLocale().setLocale('en')
})

const TITLE_FIELD: MetaField = { id: 'title', name: 'Title', type: 'string' }

type GridProps = Record<string, unknown>

function mountGrid(props: GridProps) {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    setup() {
      return () => h(MetaGridTable, {
        rows: [],
        visibleFields: [TITLE_FIELD],
        sortRules: [],
        loading: false,
        currentPage: 1,
        totalPages: 1,
        startIndex: 0,
        canEdit: true,
        canDelete: true,
        canBulkEdit: true,
        enableMultiSelect: true,
        searchText: '',
        rowDensity: 'normal',
        canComment: true,
        ...props,
      })
    },
  })
  app.mount(container)
  return container
}

describe('MetaGridTable i18n', () => {
  it('localizes the empty-records state and grid aria in zh-CN', () => {
    useLocale().setLocale('zh-CN')
    const root = mountGrid({ rows: [] })
    const text = root.textContent ?? ''
    expect(text).toContain('暂无记录')
    expect(text).toContain('点击')
    expect(text).toContain('+ 新建记录')
    expect(text).toContain('添加第一行')
    expect(root.querySelector('[role="grid"]')?.getAttribute('aria-label')).toBe('数据表格')
    expect(text).not.toContain('No records yet')
  })

  it('preserves the English empty state when locale is en', () => {
    useLocale().setLocale('en')
    const root = mountGrid({ rows: [] })
    const text = root.textContent ?? ''
    expect(text).toContain('No records yet')
    expect(text).toContain('+ New Record')
    expect(text).not.toContain('暂无记录')
    expect(root.querySelector('[role="grid"]')?.getAttribute('aria-label')).toBe('Data grid')
  })

  it('localizes the no-search-match empty state in zh-CN', () => {
    useLocale().setLocale('zh-CN')
    const root = mountGrid({ rows: [], searchText: 'abc' })
    const text = root.textContent ?? ''
    expect(text).toContain('没有匹配的记录')
    expect(text).toContain('试试其他搜索词')
    expect(text).not.toContain('No matching records')
  })

  it('localizes the bulk action bar after selecting a row in zh-CN', async () => {
    useLocale().setLocale('zh-CN')
    const rows: MetaRecord[] = [{ id: 'r1', version: 1, data: { title: 'Hello' } }]
    const root = mountGrid({ rows })
    const rowCheckbox = root.querySelector('tbody tr .meta-grid__check-col input') as HTMLInputElement | null
    expect(rowCheckbox).toBeTruthy()
    expect(rowCheckbox!.disabled).toBe(false)
    rowCheckbox!.checked = true
    rowCheckbox!.dispatchEvent(new Event('change'))
    await nextTick()

    const bar = root.querySelector('.meta-grid__bulk-bar') as HTMLElement | null
    expect(bar).toBeTruthy()
    const text = bar!.textContent ?? ''
    expect(text).toContain('已选择 1 条')
    expect(text).toContain('设置字段')
    expect(text).toContain('清空字段')
    expect(text).toContain('删除所选')
    expect(text).toContain('清除')
    expect(bar!.querySelector('[aria-label="删除所选记录"]')).toBeTruthy()
    expect(bar!.querySelector('[aria-label="清除选择"]')).toBeTruthy()
    expect(text).not.toContain('selected')
  })

  it('localizes pagination and loading chrome in zh-CN', () => {
    useLocale().setLocale('zh-CN')
    const root = mountGrid({ rows: [], totalPages: 2, currentPage: 1, loading: true })
    const text = root.textContent ?? ''
    expect(text).toContain('上一页')
    expect(text).toContain('下一页')
    expect(root.querySelector('.meta-grid__loading')?.getAttribute('aria-label')).toBe('正在加载数据')
    expect(text).not.toContain('Prev')
    expect(text).not.toContain('Loading data')
  })

  it('localizes only the synthetic (No value) group — never user field/group data', () => {
    useLocale().setLocale('zh-CN')
    const statusField: MetaField = { id: 'status', name: 'Status', type: 'select' }
    const rows: MetaRecord[] = [
      { id: 'r1', version: 1, data: { title: 'A', status: 'Needs Review' } },
      { id: 'r2', version: 1, data: { title: 'B', status: '' } },
    ]
    const root = mountGrid({
      rows,
      visibleFields: [TITLE_FIELD, statusField],
      groupField: statusField,
    })
    const text = root.textContent ?? ''
    // field name + real group value stay exactly as authored
    expect(text).toContain('Status')
    expect(text).toContain('Needs Review')
    // only the synthetic fallback group label is localized
    expect(text).toContain('(无值)')
    expect(text).not.toContain('(No value)')
  })
})
