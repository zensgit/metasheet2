import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaRecordDrawer from '../src/multitable/components/MetaRecordDrawer.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

// Canonical mount/teardown shape per meta-cell-editor-i18n.spec.ts:
//   createApp + container + app?.unmount() + container?.remove() + locale reset.

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  useLocale().setLocale('en')
})

const TITLE_FIELD: MetaField = { id: 't', name: 'Title', type: 'string' }
const BARCODE_FIELD: MetaField = { id: 'sku', name: 'SKU', type: 'barcode' as MetaField['type'] }
const LOCATION_FIELD: MetaField = { id: 'addr', name: 'Address', type: 'location' as MetaField['type'] }
const ATTACHMENT_FIELD: MetaField = {
  id: 'files',
  name: 'Files',
  type: 'attachment' as MetaField['type'],
  property: { maxFiles: 5 } as unknown as MetaField['property'],
}

const BASE_RECORD: MetaRecord = { id: 'r1', version: 1, data: {} }

function mountDrawer(extraProps: Record<string, unknown> = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    setup() {
      return () => h(MetaRecordDrawer, {
        visible: true,
        record: BASE_RECORD,
        fields: [TITLE_FIELD],
        canEdit: true,
        canComment: true,
        canDelete: true,
        recordIds: ['r1'],
        ...extraProps,
      })
    },
  })
  app.mount(container)
  return container
}

describe('MetaRecordDrawer i18n — header / actions / tabs chrome', () => {
  it('renders zh-CN header chrome (title, close, tabsAria, tabs, delete)', () => {
    useLocale().setLocale('zh-CN')
    const root = mountDrawer()
    const text = root.textContent ?? ''
    expect(text).toContain('记录详情')   // record.title
    expect(text).toContain('详情')       // record.details tab
    expect(text).toContain('历史')       // record.history tab
    expect(text).toContain('删除')       // record.delete
    expect(text).not.toContain('Record Detail')
    expect(text).not.toContain('>Details<')
    // attribute-level
    expect(root.querySelector('.meta-record-drawer__close')?.getAttribute('aria-label')).toBe('关闭记录抽屉')
    expect(root.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('记录抽屉分区')
  })

  it('renders English header chrome when locale is en (regression)', () => {
    useLocale().setLocale('en')
    const root = mountDrawer()
    const text = root.textContent ?? ''
    expect(text).toContain('Record Detail')
    expect(text).toContain('Details')
    expect(text).toContain('History')
    expect(text).toContain('Delete')
    expect(text).not.toContain('记录详情')
    expect(root.querySelector('.meta-record-drawer__close')?.getAttribute('aria-label')).toBe('Close record drawer')
    expect(root.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Record drawer sections')
  })
})

describe('MetaRecordDrawer i18n — empty + history states', () => {
  it('zh-CN renders the empty placeholder when no record is selected', () => {
    useLocale().setLocale('zh-CN')
    const root = mountDrawer({ record: null })
    expect(root.textContent ?? '').toContain('未选择记录')
    expect(root.textContent ?? '').not.toContain('No record selected')
  })

  it('en preserves the empty placeholder string (regression)', () => {
    useLocale().setLocale('en')
    const root = mountDrawer({ record: null })
    expect(root.textContent ?? '').toContain('No record selected')
  })

  it('zh-CN renders historyUnavailable when apiClient is absent (canLoadHistory false)', async () => {
    useLocale().setLocale('zh-CN')
    // Activate the History tab via direct DOM click; canLoadHistory is false
    // because apiClient is not supplied, so the unavailable state should show.
    const root = mountDrawer()
    const historyTab = Array.from(root.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === '历史') as HTMLButtonElement | undefined
    expect(historyTab).toBeTruthy()
    historyTab?.click()
    await new Promise((r) => setTimeout(r, 0))
    const text = root.textContent ?? ''
    expect(text).toContain('此记录的历史不可用。')
    expect(text).not.toContain('History unavailable for this record')
  })
})

describe('MetaRecordDrawer i18n — field-editor placeholders (T3A2 cross-module reuse)', () => {
  it('zh-CN barcode + location placeholders come from meta-core-labels (no duplication)', () => {
    useLocale().setLocale('zh-CN')
    const root = mountDrawer({
      fields: [BARCODE_FIELD, LOCATION_FIELD],
    })
    const inputs = Array.from(root.querySelectorAll<HTMLInputElement>('input'))
    const placeholders = inputs.map((el) => el.getAttribute('placeholder')).filter(Boolean)
    expect(placeholders).toContain('扫描或输入条码')   // cell.barcodePlaceholder (T3A2)
    expect(placeholders).toContain('输入地址')         // cell.locationPlaceholder (T3A2)
  })

  it('en placeholders preserved exactly (T3A2 backward compat)', () => {
    useLocale().setLocale('en')
    const root = mountDrawer({
      fields: [BARCODE_FIELD, LOCATION_FIELD],
    })
    const placeholders = Array.from(root.querySelectorAll<HTMLInputElement>('input'))
      .map((el) => el.getAttribute('placeholder'))
      .filter(Boolean)
    expect(placeholders).toContain('Scan or enter barcode')
    expect(placeholders).toContain('Enter address')
  })
})

describe('MetaRecordDrawer i18n — attachment chrome (F-T3B-B: mode=add reuse)', () => {
  it("zh-CN multi-file attachment shows 添加文件 + 全部清除 via the T3A2 helper mode='add'", () => {
    useLocale().setLocale('zh-CN')
    const root = mountDrawer({
      fields: [ATTACHMENT_FIELD],
      record: { id: 'r1', version: 1, data: { files: ['existing-1'] } } as MetaRecord,
    })
    const text = root.textContent ?? ''
    expect(text).toContain('添加文件')   // attachmentActionHint mode='add' multi-file
    expect(text).toContain('全部清除')   // cell.clearAll (T3A2 reuse)
    expect(text).not.toContain('Add files')
    expect(text).not.toContain('Clear all')
  })

  it('en attachment chrome preserved (Add files + Clear all)', () => {
    useLocale().setLocale('en')
    const root = mountDrawer({
      fields: [ATTACHMENT_FIELD],
      record: { id: 'r1', version: 1, data: { files: ['existing-1'] } } as MetaRecord,
    })
    const text = root.textContent ?? ''
    expect(text).toContain('Add files')
    expect(text).toContain('Clear all')
  })
})

describe('MetaRecordDrawer i18n — user-data preservation', () => {
  it('field names stay exactly as authored (never translated, even in zh-CN)', () => {
    useLocale().setLocale('zh-CN')
    const root = mountDrawer({
      fields: [{ id: 'status', name: 'Status', type: 'select', options: [{ value: 'todo' }, { value: 'done' }] }],
      record: { id: 'r1', version: 1, data: { status: 'todo' } } as MetaRecord,
    })
    const text = root.textContent ?? ''
    expect(text).toContain('Status')   // field name raw
    // option values also stay raw
    const optionTexts = Array.from(root.querySelectorAll('option')).map((o) => o.textContent?.trim())
    expect(optionTexts).toContain('todo')
    expect(optionTexts).toContain('done')
    expect(optionTexts).not.toContain('待办')
  })
})
