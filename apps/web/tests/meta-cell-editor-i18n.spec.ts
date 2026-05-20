import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaCellEditor from '../src/multitable/components/cells/MetaCellEditor.vue'
import type { MetaField } from '../src/multitable/types'
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

function mountEditor(field: MetaField, modelValue: unknown, extraProps: Record<string, unknown> = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    setup() {
      return () => h(MetaCellEditor, {
        field,
        modelValue,
        ...extraProps,
      })
    },
  })
  app.mount(container)
  return container
}

describe('MetaCellEditor i18n — boolean', () => {
  it('renders Yes/No in English', () => {
    useLocale().setLocale('en')
    const field: MetaField = { id: 'done', name: 'Done', type: 'boolean' }
    expect((mountEditor(field, true)).textContent).toContain('Yes')
    app?.unmount(); app = null; container?.remove(); container = null
    expect((mountEditor(field, false)).textContent).toContain('No')
  })

  it('renders 是/否 in zh-CN', () => {
    useLocale().setLocale('zh-CN')
    const field: MetaField = { id: 'done', name: 'Done', type: 'boolean' }
    const trueRoot = mountEditor(field, true)
    expect(trueRoot.textContent).toContain('是')
    expect(trueRoot.textContent).not.toContain('Yes')
    app?.unmount(); app = null; container?.remove(); container = null
    const falseRoot = mountEditor(field, false)
    expect(falseRoot.textContent).toContain('否')
    expect(falseRoot.textContent).not.toContain('No')
  })
})

describe('MetaCellEditor i18n — static placeholders', () => {
  it('localizes the barcode placeholder', () => {
    const field: MetaField = { id: 'sku', name: 'SKU', type: 'barcode' as MetaField['type'] }

    useLocale().setLocale('zh-CN')
    let root = mountEditor(field, '')
    let input = root.querySelector('input') as HTMLInputElement
    expect(input.getAttribute('placeholder')).toBe('扫描或输入条码')

    app?.unmount(); app = null; container?.remove(); container = null

    useLocale().setLocale('en')
    root = mountEditor(field, '')
    input = root.querySelector('input') as HTMLInputElement
    expect(input.getAttribute('placeholder')).toBe('Scan or enter barcode')
  })

  it('localizes the location placeholder', () => {
    const field: MetaField = { id: 'addr', name: 'Address', type: 'location' as MetaField['type'] }
    useLocale().setLocale('zh-CN')
    const root = mountEditor(field, '')
    expect((root.querySelector('input') as HTMLInputElement).getAttribute('placeholder')).toBe('输入地址')
  })

  it('preserves untranslated format examples for url/email/phone (user-data formats, not UI chrome)', () => {
    useLocale().setLocale('zh-CN')
    const urlField: MetaField = { id: 'u', name: 'URL', type: 'url' as MetaField['type'] }
    const emailField: MetaField = { id: 'e', name: 'Email', type: 'email' as MetaField['type'] }
    const phoneField: MetaField = { id: 'p', name: 'Phone', type: 'phone' as MetaField['type'] }

    expect((mountEditor(urlField, '').querySelector('input') as HTMLInputElement).getAttribute('placeholder')).toBe('https://example.com')
    app?.unmount(); app = null; container?.remove(); container = null

    expect((mountEditor(emailField, '').querySelector('input') as HTMLInputElement).getAttribute('placeholder')).toBe('name@example.com')
    app?.unmount(); app = null; container?.remove(); container = null

    expect((mountEditor(phoneField, '').querySelector('input') as HTMLInputElement).getAttribute('placeholder')).toBe('+86 138 0000 0000')
  })
})

describe('MetaCellEditor i18n — rating clear', () => {
  it('renders the rating clear button localized when value > 0', () => {
    const field: MetaField = { id: 'rate', name: 'Rate', type: 'rating' as MetaField['type'] }

    useLocale().setLocale('zh-CN')
    let root = mountEditor(field, 3)
    let clearBtn = root.querySelector('.meta-cell-editor__rating-clear') as HTMLButtonElement
    expect(clearBtn?.textContent?.trim()).toBe('清除')

    app?.unmount(); app = null; container?.remove(); container = null

    useLocale().setLocale('en')
    root = mountEditor(field, 3)
    clearBtn = root.querySelector('.meta-cell-editor__rating-clear') as HTMLButtonElement
    expect(clearBtn?.textContent?.trim()).toBe('Clear')
  })
})

describe('MetaCellEditor i18n — attachment chrome', () => {
  const multiField: MetaField = {
    id: 'files',
    name: 'Files',
    type: 'attachment' as MetaField['type'],
    property: { maxFiles: 5 } as unknown as MetaField['property'],
  }
  const singleField: MetaField = {
    id: 'avatar',
    name: 'Avatar',
    type: 'attachment' as MetaField['type'],
    property: { maxFiles: 1 } as unknown as MetaField['property'],
  }

  it('multi-file empty: zh shows 拖拽文件或点击选择 + 全部清除 + 无附件', () => {
    useLocale().setLocale('zh-CN')
    const root = mountEditor(multiField, [])
    const text = root.textContent ?? ''
    expect(text).toContain('拖拽文件或点击选择')   // attachmentActionHint multi
    expect(text).toContain('全部清除')             // cell.clearAll
    expect(text).toContain('无附件')               // cell.noAttachments via MetaAttachmentList empty-label
    expect(text).not.toContain('Drop files or click to browse')
    expect(text).not.toContain('No attachments')
  })

  it('single-file empty: zh shows 上传文件 (action hint variant 3)', () => {
    useLocale().setLocale('zh-CN')
    const root = mountEditor(singleField, null)
    expect(root.textContent ?? '').toContain('上传文件')
    expect(root.textContent ?? '').not.toContain('Upload a file')
  })

  it('single-file with existing: zh shows 上传新文件以替换当前文件 (action hint variant 2)', () => {
    useLocale().setLocale('zh-CN')
    const root = mountEditor(singleField, ['attach-1'], {
      attachmentSummaries: [
        { id: 'attach-1', filename: 'a.png', mimeType: 'image/png', size: 0, url: '', thumbnailUrl: null, uploadedAt: '' },
      ],
    })
    expect(root.textContent ?? '').toContain('上传新文件以替换当前文件')
    expect(root.textContent ?? '').not.toContain('Upload a new file to replace the current one')
  })

  it('multi-file empty in en preserves the original English chrome', () => {
    useLocale().setLocale('en')
    const root = mountEditor(multiField, [])
    const text = root.textContent ?? ''
    expect(text).toContain('Drop files or click to browse')
    expect(text).toContain('Clear all')
    expect(text).toContain('No attachments')
    expect(text).not.toContain('拖拽文件或点击选择')
  })
})

describe('MetaCellEditor i18n — user-data preservation', () => {
  it('select option values stay exactly as authored (user data)', () => {
    useLocale().setLocale('zh-CN')
    const field: MetaField = {
      id: 'status',
      name: 'Status',
      type: 'select',
      options: [{ value: 'todo' }, { value: 'done' }],
    }
    const root = mountEditor(field, 'todo')
    const options = Array.from(root.querySelectorAll('option')).map((o) => o.textContent?.trim())
    expect(options).toContain('todo')
    expect(options).toContain('done')
    // never translated
    expect(options).not.toContain('待办')
    expect(options).not.toContain('已完成')
  })
})
