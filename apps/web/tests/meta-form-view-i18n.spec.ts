import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaFormView from '../src/multitable/components/MetaFormView.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

// Mount/teardown follows the canonical meta-cell-editor-i18n.spec.ts pattern
// (createApp + container + app?.unmount() + container?.remove() + locale reset).

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
const BOOL_FIELD: MetaField = { id: 'done', name: 'Done', type: 'boolean' }
const ATTACHMENT_FIELD: MetaField = {
  id: 'files',
  name: 'Files',
  type: 'attachment' as MetaField['type'],
  property: { maxFiles: 5 } as unknown as MetaField['property'],
}

function mountForm(extraProps: Record<string, unknown> = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    setup() {
      return () => h(MetaFormView, {
        fields: [TITLE_FIELD],
        loading: false,
        ...extraProps,
      })
    },
  })
  app.mount(container)
  return container
}

describe('MetaFormView i18n — top-level chrome', () => {
  it('zh-CN renders the loading banner', () => {
    useLocale().setLocale('zh-CN')
    const root = mountForm({ loading: true })
    expect(root.textContent ?? '').toContain('正在加载...')
    expect(root.textContent ?? '').not.toContain('Loading...')
  })

  it('zh-CN renders the read-only banner', () => {
    useLocale().setLocale('zh-CN')
    const root = mountForm({ readOnly: true })
    expect(root.textContent ?? '').toContain('此表单为只读')
    expect(root.textContent ?? '').not.toContain('This form is read-only')
  })

  it('en preserves the loading + read-only banners (regression)', () => {
    useLocale().setLocale('en')
    let root = mountForm({ loading: true })
    expect(root.textContent ?? '').toContain('Loading...')
    app?.unmount(); app = null; container?.remove(); container = null

    root = mountForm({ readOnly: true })
    expect(root.textContent ?? '').toContain('This form is read-only')
  })
})

describe('MetaFormView i18n — M1 submit/reset chain', () => {
  it('zh-CN submit shows 创建 when creating (no record) and 保存 when editing', () => {
    useLocale().setLocale('zh-CN')
    // No record -> create
    let root = mountForm()
    expect(root.textContent ?? '').toContain('创建')
    expect(root.textContent ?? '').not.toContain('Create')

    app?.unmount(); app = null; container?.remove(); container = null

    // With record -> save + reset
    const record: MetaRecord = { id: 'r1', version: 1, data: {} }
    root = mountForm({ record })
    const text = root.textContent ?? ''
    expect(text).toContain('保存')
    expect(text).toContain('重置')
    expect(text).not.toContain('Save')
    expect(text).not.toContain('Reset')
  })

  it('zh-CN submit shows 正在保存... when submitting=true', () => {
    useLocale().setLocale('zh-CN')
    const record: MetaRecord = { id: 'r1', version: 1, data: {} }
    const root = mountForm({ record, submitting: true })
    expect(root.textContent ?? '').toContain('正在保存...')
    expect(root.textContent ?? '').not.toContain('Saving...')
  })

  it('en submit/reset chain preserved exactly', () => {
    useLocale().setLocale('en')
    const record: MetaRecord = { id: 'r1', version: 1, data: {} }
    const root = mountForm({ record, submitting: true })
    expect(root.textContent ?? '').toContain('Saving...')

    app?.unmount(); app = null; container?.remove(); container = null

    const root2 = mountForm({ record })
    const text = root2.textContent ?? ''
    expect(text).toContain('Save')
    expect(text).toContain('Reset')
  })
})

describe('MetaFormView i18n — field placeholders + Yes/No (T3A2 reuse)', () => {
  it('zh-CN barcode/location/Yes-No all source from meta-core-labels', () => {
    useLocale().setLocale('zh-CN')
    const root = mountForm({
      fields: [BARCODE_FIELD, LOCATION_FIELD, BOOL_FIELD],
      record: { id: 'r1', version: 1, data: { done: true } } as MetaRecord,
    })
    const placeholders = Array.from(root.querySelectorAll<HTMLInputElement>('input'))
      .map((el) => el.getAttribute('placeholder'))
      .filter(Boolean)
    expect(placeholders).toContain('扫描或输入条码')
    expect(placeholders).toContain('输入地址')
    // boolean true → 是
    expect(root.textContent ?? '').toContain('是')
    expect(root.textContent ?? '').not.toContain('Yes')
  })
})

describe('MetaFormView i18n — attachment chrome (F-T3B-B add mode)', () => {
  it('zh-CN multi-file attachment chrome (添加文件 / 全部清除)', () => {
    useLocale().setLocale('zh-CN')
    const root = mountForm({
      fields: [ATTACHMENT_FIELD],
      record: { id: 'r1', version: 1, data: { files: ['existing-1'] } } as MetaRecord,
    })
    const text = root.textContent ?? ''
    expect(text).toContain('添加文件')   // attachmentActionHint mode='add' multi-file
    expect(text).toContain('全部清除')   // cell.clearAll (T3A2 reuse)
    expect(text).not.toContain('Add files')
  })

  it('en attachment chrome preserved', () => {
    useLocale().setLocale('en')
    const root = mountForm({
      fields: [ATTACHMENT_FIELD],
      record: { id: 'r1', version: 1, data: { files: ['existing-1'] } } as MetaRecord,
    })
    const text = root.textContent ?? ''
    expect(text).toContain('Add files')
    expect(text).toContain('Clear all')
  })
})

describe('MetaFormView i18n — validation + native confirm', () => {
  it("zh-CN requiredField validation shows '{field.name} 为必填项' with raw field name", async () => {
    useLocale().setLocale('zh-CN')
    const requiredField: MetaField = { id: 'q', name: 'Q', type: 'string', required: true } as MetaField
    const root = mountForm({ fields: [requiredField] })
    const form = root.querySelector('form') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    expect(root.textContent ?? '').toContain('Q 为必填项')
    expect(root.textContent ?? '').not.toContain('Q is required')
  })

  it("zh-CN native confirm uses localized text for resetForm discard prompt", async () => {
    useLocale().setLocale('zh-CN')
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    try {
      const record: MetaRecord = { id: 'r1', version: 1, data: { t: 'original' } }
      const root = mountForm({ record })
      const titleInput = root.querySelector<HTMLInputElement>('input[type="text"]')!
      titleInput.value = 'changed'
      titleInput.dispatchEvent(new Event('input'))
      await new Promise((r) => setTimeout(r, 0))
      const resetBtn = Array.from(root.querySelectorAll('button'))
        .find((b) => b.textContent?.trim() === '重置') as HTMLButtonElement
      expect(resetBtn).toBeTruthy()
      resetBtn.click()
      expect(confirmSpy).toHaveBeenCalledWith('放弃未保存的更改吗？')
    } finally {
      confirmSpy.mockRestore()
    }
  })
})

describe('MetaFormView i18n — URL/email/phone format examples stay raw (user data)', () => {
  it('preserves https://example.com / name@example.com / +86 138 0000 0000 in zh-CN', () => {
    useLocale().setLocale('zh-CN')
    const fields: MetaField[] = [
      { id: 'u', name: 'URL', type: 'url' as MetaField['type'] },
      { id: 'e', name: 'Email', type: 'email' as MetaField['type'] },
      { id: 'p', name: 'Phone', type: 'phone' as MetaField['type'] },
    ]
    const root = mountForm({ fields })
    const placeholders = Array.from(root.querySelectorAll<HTMLInputElement>('input'))
      .map((el) => el.getAttribute('placeholder'))
      .filter(Boolean)
    expect(placeholders).toContain('https://example.com')
    expect(placeholders).toContain('name@example.com')
    expect(placeholders).toContain('+86 138 0000 0000')
  })
})
