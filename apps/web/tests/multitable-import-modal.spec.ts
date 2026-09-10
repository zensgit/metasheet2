import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import MetaImportModal from '../src/multitable/components/MetaImportModal.vue'

const { mockListLinkOptions } = vi.hoisted(() => ({
  mockListLinkOptions: vi.fn(),
}))

vi.mock('../src/multitable/api/client', () => ({
  multitableClient: {
    listLinkOptions: mockListLinkOptions,
  },
}))

async function flushUi() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

describe('MetaImportModal', () => {
  beforeEach(() => {
    mockListLinkOptions.mockReset()
    useLocale().setLocale('en')
    window.localStorage.clear()
  })

  it('shows failed rows and retries only the failed subset', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const importCalls: Array<Array<Record<string, unknown>>> = []

    const Harness = defineComponent({
      setup() {
        const visible = ref(true)
        const importing = ref(false)
        const result = ref<any>(null)

        return {
          visible,
          importing,
          result,
          onClose: vi.fn(),
          onImport(payload: { records: Array<Record<string, unknown>>; rowIndexes: number[] }) {
            importCalls.push(payload.records)
            result.value = {
              attempted: payload.records.length,
              succeeded: 1,
              failed: 1,
              firstError: 'Invalid select option',
              failures: [{ index: 1, rowIndex: 1, message: 'Invalid select option', retryable: true }],
            }
            importing.value = false
          },
        }
      },
      render() {
        return h(MetaImportModal, {
          visible: this.visible,
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_status', name: 'Status', type: 'select', options: [{ value: 'Open' }] },
          ],
          fieldResolvers: {},
          importing: this.importing,
          result: this.result,
          onClose: this.onClose,
          onImport: this.onImport,
        })
      },
    })

    const app = createApp(Harness)
    app.mount(container)
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Name\tStatus\nAlpha\tOpen\nBeta\tBadValue'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Import'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    expect(importCalls).toHaveLength(1)
    expect(importCalls[0]).toEqual([
      { fld_name: 'Alpha', fld_status: 'Open' },
      { fld_name: 'Beta', fld_status: 'BadValue' },
    ])
    expect(document.body.textContent).toContain('1 imported, 1 failed')
    expect(document.body.textContent).toContain('Review the failed rows below')

    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Retry failed rows'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    expect(importCalls).toHaveLength(2)
    expect(importCalls[1]).toEqual([{ fld_name: 'Beta', fld_status: 'BadValue' }])

    app.unmount()
    container.remove()
  })

  it('emits cancel-import instead of close while importing', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const closeSpy = vi.fn()
    const cancelSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaImportModal, {
          visible: true,
          fields: [{ id: 'fld_owner', name: 'Owner', type: 'link', property: { refKind: 'user', foreignSheetId: 'sheet_people' } }],
          importing: true,
          onClose: closeSpy,
          onCancelImport: cancelSpy,
          onImport: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    ;(document.body.querySelector('.meta-import__close') as HTMLButtonElement)?.click()
    await flushUi()
    expect(closeSpy).not.toHaveBeenCalled()
    expect(cancelSpy).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('Cancel import')

    app.unmount()
    container.remove()
  })

  it('uses generic duplicate copy in the result view', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaImportModal, {
          visible: true,
          fields: [{ id: 'fld_name', name: 'Name', type: 'string' }],
          importing: false,
          result: {
            attempted: 2,
            succeeded: 1,
            failed: 0,
            skipped: 1,
            firstError: null,
            failures: [
              { index: 1, rowIndex: 1, fieldId: 'fld_name', skipped: true, message: 'Skipped duplicate row because Name already exists: alpha' },
            ],
          },
          onClose: vi.fn(),
          onImport: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    expect(document.body.textContent).toContain('Some rows were skipped as duplicates.')
    expect(document.body.textContent).not.toContain('current primary import field')

    app.unmount()
    container.remove()
  })

  it('filters readonly fields out of import mapping options', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaImportModal, {
          visible: true,
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
            { id: 'fld_locked', name: 'Locked', type: 'string', property: { readonly: true } },
            { id: 'fld_formula', name: 'Score', type: 'formula' },
          ],
          importing: false,
          result: null,
          onClose: vi.fn(),
          onImport: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Title\tLocked\nAlpha\tSecret'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    const mappingOptions = Array.from(document.body.querySelectorAll('.meta-import__field-select option'))
      .map((option) => option.textContent?.trim() ?? '')
      .filter(Boolean)

    expect(mappingOptions).toContain('Title')
    expect(mappingOptions).not.toContain('Locked')
    expect(mappingOptions).not.toContain('Score')

    app.unmount()
    container.remove()
  })

  it('renders zh-CN import chrome while preserving imported headers, field names, and cells raw', async () => {
    useLocale().setLocale('zh-CN')
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaImportModal, {
          visible: true,
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_status', name: 'Status', type: 'select', options: [{ value: 'Open' }] },
          ],
          importing: false,
          result: null,
          onClose: vi.fn(),
          onImport: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    const initialText = document.body.textContent ?? ''
    expect(initialText).toContain('导入记录')
    expect(initialText).toContain('粘贴来自 Excel 或 Google Sheets 的制表符分隔数据')
    expect(initialText).toContain('选择 CSV/TSV/Excel 文件，或拖到这里')
    expect(initialText).not.toContain('Import Records')
    expect(document.body.querySelector<HTMLTextAreaElement>('.meta-import__textarea')?.getAttribute('placeholder')).toBe('姓名\t年龄\t邮箱\n张三\t30\tzhangsan@example.com')

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Name\tStatus\nAlpha\tOpen'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    const previewText = document.body.textContent ?? ''
    expect(previewText).toContain('已识别 1 条记录。请将列映射到字段：')
    expect(previewText).toContain('导入 1 条记录')
    expect(previewText).toContain('(跳过)')
    expect(previewText).toContain('Name')
    expect(previewText).toContain('Status')
    expect(previewText).toContain('Alpha')
    expect(previewText).toContain('Open')
    expect(previewText).not.toContain('Map columns to fields')
    expect(previewText).not.toContain('Import 1 record(s)')

    app.unmount()
    container.remove()
  })

  it('localizes zh-CN result repair chrome while preserving backend failure text raw', async () => {
    useLocale().setLocale('zh-CN')
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaImportModal, {
          visible: true,
          fields: [{ id: 'fld_owner', name: 'Owner', type: 'link', property: { refKind: 'user', foreignSheetId: 'sheet_people' } }],
          importing: false,
          result: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            firstError: 'Backend raw failure',
            failures: [{ rowIndex: 0, fieldId: 'fld_owner', retryable: false, message: 'Backend raw failure' }],
          },
          onClose: vi.fn(),
          onImport: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    const text = document.body.textContent ?? ''
    expect(text).toContain('0 条已导入，1 条失败')
    expect(text).toContain('请检查下方失败行，并返回映射以修正源数据。')
    expect(text).toContain('修正第 2 行')
    expect(text).toContain('选择人员...')
    expect(text).toContain('Backend raw failure')
    expect(text).not.toContain('Review the failed rows below')
    expect(text).not.toContain('Choose people')

    app.unmount()
    container.remove()
  })

  it('emits dirty state and confirms before closing an unsaved import draft', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const closeSpy = vi.fn()
    const dirtySpy = vi.fn()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    const app = createApp({
      render() {
        return h(MetaImportModal, {
          visible: true,
          fields: [{ id: 'fld_name', name: 'Name', type: 'string' }],
          importing: false,
          result: null,
          onClose: closeSpy,
          onImport: vi.fn(),
          'onUpdate:dirty': dirtySpy,
        })
      },
    })

    app.mount(container)
    await flushUi()

    expect(dirtySpy).toHaveBeenLastCalledWith(false)

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Name\nAlice'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    expect(dirtySpy).toHaveBeenLastCalledWith(true)

    ;(document.body.querySelector('.meta-import__close') as HTMLButtonElement)?.click()
    await flushUi()

    expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved import changes?')
    expect(closeSpy).not.toHaveBeenCalled()

    app.unmount()
    container.remove()
  })

  it('lets users repair people ambiguity inline and retry', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const importCalls: Array<{ records: Array<Record<string, unknown>>; failures: Array<{ rowIndex: number; message: string }> }> = []

    const Harness = defineComponent({
      setup() {
        const visible = ref(true)
        const importing = ref(false)
        const result = ref<any>(null)
        const fieldResolvers = {
          fld_owner: async (rawValue: string) => {
            if (rawValue === 'owner@example.com') return ['rec_owner_1']
            throw new Error('Multiple people match "Owner". Use email for an exact match.')
          },
        }

        return {
          visible,
          importing,
          result,
          fieldResolvers,
          onClose: vi.fn(),
          onImport(payload: { records: Array<Record<string, unknown>>; failures: Array<{ rowIndex: number; message: string }> }) {
            importCalls.push({ records: payload.records, failures: payload.failures })
            result.value = {
              attempted: payload.records.length + payload.failures.length,
              succeeded: payload.records.length,
              failed: payload.failures.length,
              firstError: payload.failures[0]?.message ?? null,
              failures: payload.failures,
            }
            importing.value = false
          },
        }
      },
      render() {
        return h(MetaImportModal, {
          visible: this.visible,
          fields: [{ id: 'fld_owner', name: 'Owner', type: 'link', property: { refKind: 'user', foreignSheetId: 'sheet_people' } }],
          fieldResolvers: this.fieldResolvers,
          importing: this.importing,
          result: this.result,
          onClose: this.onClose,
          onImport: this.onImport,
        })
      },
    })

    const app = createApp(Harness)
    app.mount(container)
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Owner\nOwner'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()
    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Import'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    const fixInput = document.body.querySelector('.meta-import__fix-input') as HTMLInputElement
    fixInput.value = 'owner@example.com'
    fixInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Apply fixes and retry'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    expect(importCalls).toHaveLength(2)
    expect(importCalls[1]?.records).toEqual([{ fld_owner: ['rec_owner_1'] }])
    expect(importCalls[1]?.failures).toEqual([])

    app.unmount()
    container.remove()
  })

  it('lets users repair people ambiguity via picker', async () => {
    mockListLinkOptions.mockResolvedValue({
      field: { id: 'fld_owner', name: 'Owner', type: 'link', property: { refKind: 'user', foreignSheetId: 'sheet_people', limitSingleRecord: true } },
      targetSheet: { id: 'sheet_people', baseId: 'base_1', name: 'People' },
      selected: [],
      records: [{ id: 'rec_owner_1', display: 'Owner Person' }],
      page: { offset: 0, limit: 50, total: 1, hasMore: false },
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const importCalls: Array<{ records: Array<Record<string, unknown>>; failures: Array<{ rowIndex: number; message: string }> }> = []

    const Harness = defineComponent({
      setup() {
        const visible = ref(true)
        const importing = ref(false)
        const result = ref<any>(null)
        const fieldResolvers = {
          fld_owner: async () => {
            throw new Error('Multiple people match "Owner". Use email for an exact match.')
          },
        }

        return {
          visible,
          importing,
          result,
          fieldResolvers,
          onClose: vi.fn(),
          onImport(payload: { records: Array<Record<string, unknown>>; failures: Array<{ rowIndex: number; message: string }> }) {
            importCalls.push({ records: payload.records, failures: payload.failures })
            result.value = {
              attempted: payload.records.length + payload.failures.length,
              succeeded: payload.records.length,
              failed: payload.failures.length,
              firstError: payload.failures[0]?.message ?? null,
              failures: payload.failures,
            }
            importing.value = false
          },
        }
      },
      render() {
        return h(MetaImportModal, {
          visible: this.visible,
          fields: [{ id: 'fld_owner', name: 'Owner', type: 'link', property: { refKind: 'user', foreignSheetId: 'sheet_people', limitSingleRecord: true } }],
          fieldResolvers: this.fieldResolvers,
          importing: this.importing,
          result: this.result,
          onClose: this.onClose,
          onImport: this.onImport,
        })
      },
    })

    const app = createApp(Harness)
    app.mount(container)
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Owner\nOwner'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()
    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Import'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    Array.from(document.body.querySelectorAll('.meta-import__fix-picker-row .meta-import__btn'))
      .find((button) => button.textContent?.includes('Choose person') || button.textContent?.includes('Choose people') || button.textContent?.includes('Select person'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    expect(mockListLinkOptions).toHaveBeenCalledWith('fld_owner', expect.objectContaining({
      search: 'Owner',
      limit: 50,
      offset: 0,
    }))

    ;(document.body.querySelector('.meta-link-picker__item input[type="checkbox"]') as HTMLInputElement)?.click()
    await flushUi()
    ;(document.body.querySelector('.meta-link-picker__confirm') as HTMLButtonElement)?.click()
    await flushUi()

    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Apply fixes and retry'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    expect(importCalls).toHaveLength(2)
    expect(importCalls[1]?.records).toEqual([{ fld_owner: ['rec_owner_1'] }])
    expect(importCalls[1]?.failures).toEqual([])

    app.unmount()
    container.remove()
  })

  it('blocks preview import until invalid mappings are reconciled after field drift', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const Harness = defineComponent({
      setup() {
        const fields = ref([{ id: 'fld_name', name: 'Name', type: 'string' }])
        return { fields }
      },
      render() {
        return h(MetaImportModal, {
          visible: true,
          fields: this.fields,
          importing: false,
          result: null,
          // Create-missing-fields is ON here so the test also pins the sentinel semantics: a drifted
          // REAL mapping is still cleared by reconcile, and the create option stays available as the
          // recovery path (reconcile must not silently promote the column to "create a new field").
          canCreateFields: true,
          onClose: vi.fn(),
          onImport: vi.fn(),
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Name\nAlpha'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    expect((document.body.querySelector('.meta-import__field-select') as HTMLSelectElement | null)?.value).toBe('fld_name')

    vm.fields = [{ id: 'fld_name', name: 'Name Formula', type: 'formula' }]
    await flushUi()

    expect(document.body.textContent).toContain('Name Formula is no longer an importable field. Reconcile the draft before importing.')
    const importButton = Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Import 1 record')) as HTMLButtonElement | undefined
    expect(importButton?.disabled).toBe(true)

    Array.from(document.body.querySelectorAll('.meta-import__warning .meta-import__btn-inline'))
      .find((button) => button.textContent?.includes('Reconcile draft'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    expect(document.body.querySelector('.meta-import__warning')).toBeNull()
    expect((document.body.querySelector('.meta-import__field-select') as HTMLSelectElement | null)?.value).toBe('')
    expect(Array.from(document.body.querySelectorAll('.meta-import__field-select option')).map((option) => option.getAttribute('value')))
      .toContain('__create__')
    expect(document.body.textContent).toContain('1 column(s) do not exist in the target sheet and were skipped.')

    app.unmount()
    container.remove()
  })

  it('supports generic linked-record picker repair and retry', async () => {
    mockListLinkOptions.mockResolvedValue({
      field: { id: 'fld_vendor', name: 'Vendor', type: 'link', property: { foreignSheetId: 'sheet_vendors', limitSingleRecord: true } },
      targetSheet: { id: 'sheet_vendors', baseId: 'base_1', name: 'Vendors' },
      selected: [],
      records: [{ id: 'rec_vendor_1', display: 'Acme Supply' }],
      page: { offset: 0, limit: 50, total: 1, hasMore: false },
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const importCalls: Array<{ records: Array<Record<string, unknown>>; failures: Array<{ rowIndex: number; message: string }> }> = []

    const Harness = defineComponent({
      setup() {
        const visible = ref(true)
        const importing = ref(false)
        const result = ref<any>(null)
        const fieldResolvers = {
          fld_vendor: async () => {
            throw new Error('Multiple linked records match "Vendor". Use a more specific value or repair it with the picker.')
          },
        }

        return {
          visible,
          importing,
          result,
          fieldResolvers,
          onClose: vi.fn(),
          onImport(payload: { records: Array<Record<string, unknown>>; failures: Array<{ rowIndex: number; message: string }> }) {
            importCalls.push({ records: payload.records, failures: payload.failures })
            result.value = {
              attempted: payload.records.length + payload.failures.length,
              succeeded: payload.records.length,
              failed: payload.failures.length,
              firstError: payload.failures[0]?.message ?? null,
              failures: payload.failures,
            }
            importing.value = false
          },
        }
      },
      render() {
        return h(MetaImportModal, {
          visible: this.visible,
          fields: [{ id: 'fld_vendor', name: 'Vendor', type: 'link', property: { foreignSheetId: 'sheet_vendors', limitSingleRecord: true } }],
          fieldResolvers: this.fieldResolvers,
          importing: this.importing,
          result: this.result,
          onClose: this.onClose,
          onImport: this.onImport,
        })
      },
    })

    const app = createApp(Harness)
    app.mount(container)
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Vendor\nVendor'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()
    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Import'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    Array.from(document.body.querySelectorAll('.meta-import__fix-picker-row .meta-import__btn'))
      .find((button) => button.textContent?.includes('Choose linked records'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    expect(mockListLinkOptions).toHaveBeenCalledWith('fld_vendor', expect.objectContaining({
      search: 'Vendor',
      limit: 50,
      offset: 0,
    }))

    ;(document.body.querySelector('.meta-link-picker__item input[type="checkbox"]') as HTMLInputElement)?.click()
    await flushUi()
    ;(document.body.querySelector('.meta-link-picker__confirm') as HTMLButtonElement)?.click()
    await flushUi()

    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Apply fixes and retry'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    expect(importCalls).toHaveLength(2)
    expect(importCalls[1]?.records).toEqual([{ fld_vendor: ['rec_vendor_1'] }])
    expect(importCalls[1]?.failures).toEqual([])

    app.unmount()
    container.remove()
  })

  it('preserves non-problem mapped columns when a picker repair is reconciled after field drift', async () => {
    mockListLinkOptions.mockResolvedValue({
      field: { id: 'fld_owner', name: 'Owner', type: 'link', property: { refKind: 'user', foreignSheetId: 'sheet_people', limitSingleRecord: true } },
      targetSheet: { id: 'sheet_people', baseId: 'base_1', name: 'People' },
      selected: [],
      records: [{ id: 'rec_owner_1', display: 'Owner Person' }],
      page: { offset: 0, limit: 50, total: 1, hasMore: false },
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const importCalls: Array<{ records: Array<Record<string, unknown>>; failures: Array<{ rowIndex: number; message: string }> }> = []

    const Harness = defineComponent({
      setup() {
        const visible = ref(true)
        const importing = ref(false)
        const result = ref<any>(null)
        const fields = ref<any[]>([
          { id: 'fld_title', name: 'Title', type: 'string' },
          { id: 'fld_owner', name: 'Owner', type: 'link', property: { refKind: 'user', foreignSheetId: 'sheet_people', limitSingleRecord: true } },
        ])
        const fieldResolvers = {
          fld_owner: async () => {
            throw new Error('Multiple people match "Owner". Use email for an exact match.')
          },
        }

        return {
          visible,
          importing,
          result,
          fields,
          fieldResolvers,
          onClose: vi.fn(),
          onImport(payload: { records: Array<Record<string, unknown>>; failures: Array<{ rowIndex: number; message: string }> }) {
            importCalls.push({ records: payload.records, failures: payload.failures })
            result.value = {
              attempted: payload.records.length + payload.failures.length,
              succeeded: payload.records.length,
              failed: payload.failures.length,
              firstError: payload.failures[0]?.message ?? null,
              failures: payload.failures,
            }
            importing.value = false
          },
        }
      },
      render() {
        return h(MetaImportModal, {
          visible: this.visible,
          fields: this.fields,
          fieldResolvers: this.fieldResolvers,
          importing: this.importing,
          result: this.result,
          onClose: this.onClose,
          onImport: this.onImport,
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Title\tOwner\nAlpha\tOwner'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Import'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    Array.from(document.body.querySelectorAll('.meta-import__fix-picker-row .meta-import__btn'))
      .find((button) => button.textContent?.includes('Choose person') || button.textContent?.includes('Choose people') || button.textContent?.includes('Select person'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    ;(document.body.querySelector('.meta-link-picker__item input[type="checkbox"]') as HTMLInputElement)?.click()
    await flushUi()
    ;(document.body.querySelector('.meta-link-picker__confirm') as HTMLButtonElement)?.click()
    await flushUi()

    vm.fields = [
      { id: 'fld_title', name: 'Title', type: 'string' },
      { id: 'fld_owner', name: 'Owner Repair', type: 'string', property: {} },
    ]
    await flushUi()

    expect(document.body.textContent).toContain('A selected linked-record repair for Owner Repair is no longer valid because the field changed type.')

    Array.from(document.body.querySelectorAll('.meta-import__warning .meta-import__btn-inline'))
      .find((button) => button.textContent?.includes('Reconcile draft'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Apply fixes and retry'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    expect(importCalls).toHaveLength(2)
    expect(importCalls[1]?.records).toEqual([{ fld_title: 'Alpha', fld_owner: 'Owner Person' }])
    expect(importCalls[1]?.failures).toEqual([])

    app.unmount()
    container.remove()
  })

  it('re-enables zh people repair after reconciling a stale selected repair', async () => {
    useLocale().setLocale('zh')
    mockListLinkOptions.mockResolvedValue({
      // LEGACY link-backed person (type='link' + refKind:user) — the picker-repair flow this test
      // validates is a LINK-picker affordance (recordIds). A NATIVE type='person' field is no longer
      // picker-repairable via the link record picker (design 2026-06-16), so this test uses the legacy
      // storage shape it was always exercising.
      field: { id: 'fld_owner', name: '负责人', type: 'link', property: { refKind: 'user', foreignSheetId: 'sheet_people', limitSingleRecord: true } },
      targetSheet: { id: 'sheet_people', baseId: 'base_1', name: '人员' },
      selected: [],
      records: [{ id: 'rec_owner_1', display: '张三' }],
      page: { offset: 0, limit: 50, total: 1, hasMore: false },
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const importCalls: Array<{ records: Array<Record<string, unknown>>; failures: Array<{ rowIndex: number; message: string }> }> = []

    const Harness = defineComponent({
      setup() {
        const visible = ref(true)
        const importing = ref(false)
        const result = ref<any>(null)
        const fields = ref<any[]>([
          { id: 'fld_title', name: '标题', type: 'string' },
          { id: 'fld_owner', name: '负责人', type: 'link', property: { refKind: 'user', foreignSheetId: 'sheet_people', limitSingleRecord: true } },
        ])
        const fieldResolvers = {
          fld_owner: async () => {
            throw new Error('Multiple people match "负责人". Use email for an exact match.')
          },
        }

        return {
          visible,
          importing,
          result,
          fields,
          fieldResolvers,
          onClose: vi.fn(),
          onImport(payload: { records: Array<Record<string, unknown>>; failures: Array<{ rowIndex: number; message: string }> }) {
            importCalls.push({ records: payload.records, failures: payload.failures })
            result.value = {
              attempted: payload.records.length + payload.failures.length,
              succeeded: payload.records.length,
              failed: payload.failures.length,
              firstError: payload.failures[0]?.message ?? null,
              failures: payload.failures,
            }
            importing.value = false
          },
        }
      },
      render() {
        return h(MetaImportModal, {
          visible: this.visible,
          fields: this.fields,
          fieldResolvers: this.fieldResolvers,
          importing: this.importing,
          result: this.result,
          onClose: this.onClose,
          onImport: this.onImport,
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = '标题\t负责人\nAlpha\tOwner'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('导入'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    Array.from(document.body.querySelectorAll('.meta-import__fix-picker-row .meta-import__btn'))
      .find((button) => button.textContent?.includes('选择人员'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    ;(document.body.querySelector('.meta-link-picker__item input[type="checkbox"]') as HTMLInputElement)?.click()
    await flushUi()
    ;(document.body.querySelector('.meta-link-picker__confirm') as HTMLButtonElement)?.click()
    await flushUi()

    vm.fields = [
      { id: 'fld_title', name: '标题', type: 'string' },
      { id: 'fld_owner', name: '负责人文本', type: 'string', property: {} },
    ]
    await flushUi()

    expect(document.body.textContent).toContain('为 负责人文本 选择的关联记录修复项已失效，因为该字段类型已变更。请先修复草稿再导入。')
    const applyButtonBefore = Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('应用修正并重试')) as HTMLButtonElement | undefined
    expect(applyButtonBefore?.disabled).toBe(true)

    Array.from(document.body.querySelectorAll('.meta-import__warning .meta-import__btn-inline'))
      .find((button) => button.textContent?.includes('修复草稿'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    expect(document.body.querySelector('.meta-import__warning')).toBeNull()
    const applyButtonAfter = Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('应用修正并重试')) as HTMLButtonElement | undefined
    expect(applyButtonAfter?.disabled).toBe(false)

    applyButtonAfter?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    expect(importCalls).toHaveLength(2)
    expect(importCalls[1]?.records).toEqual([{ fld_title: 'Alpha', fld_owner: '张三' }])
    expect(importCalls[1]?.failures).toEqual([])

    app.unmount()
    container.remove()
  })

  it('restores a persisted import draft when reopened for the same sheet', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const Harness = defineComponent({
      setup() {
        const visible = ref(true)
        return {
          visible,
          onClose: vi.fn(),
          onImport: vi.fn(),
        }
      },
      render() {
        return h(MetaImportModal, {
          visible: this.visible,
          sheetId: 'sheet_ops',
          fields: [{ id: 'fld_name', name: 'Name', type: 'string' }],
          importing: false,
          result: null,
          canCreateFields: true,
          onClose: this.onClose,
          onImport: this.onImport,
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as { visible: boolean }
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Name\tWarehouse\nAlice\tA1'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    const selectsBefore = Array.from(document.body.querySelectorAll('.meta-import__field-select')) as HTMLSelectElement[]
    expect(selectsBefore[0]?.value).toBe('fld_name')
    // The create-field sentinel is part of the draft: it must survive the round-trip, otherwise the
    // recovered draft silently drops the column.
    expect(selectsBefore[1]?.value).toBe('__create__')
    const stored = window.localStorage.getItem('metasheet:multitable:import-draft:sheet_ops') ?? ''
    expect(stored).toContain('Alice')
    expect(stored).toContain('__create__')

    vm.visible = false
    await flushUi()
    vm.visible = true
    await flushUi()

    expect(document.body.textContent).toContain('Recovered your previous import draft for this sheet.')
    const selectsAfter = Array.from(document.body.querySelectorAll('.meta-import__field-select')) as HTMLSelectElement[]
    expect(selectsAfter[0]?.value).toBe('fld_name')
    expect(selectsAfter[1]?.value).toBe('__create__')
    expect(document.body.textContent).toContain('1 record(s) detected')
    expect(document.body.textContent).toContain('1 column(s) will be created as new text fields.')

    app.unmount()
    container.remove()
  })

  it('defaults unmatched headers to "create field" and enables import when the caller can manage fields', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaImportModal, {
          visible: true,
          fields: [{ id: 'fld_name', name: 'Name', type: 'string' }],
          importing: false,
          result: null,
          canCreateFields: true,
          onClose: vi.fn(),
          onImport: vi.fn(),
        })
      },
    })
    app.mount(container)
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Warehouse\tBatch\nA1\tB1'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    const selects = Array.from(document.body.querySelectorAll('.meta-import__field-select')) as HTMLSelectElement[]
    expect(selects.map((select) => select.value)).toEqual(['__create__', '__create__'])
    expect(document.body.textContent).toContain('Create field "Warehouse" (text)')
    expect(document.body.textContent).toContain('2 column(s) will be created as new text fields.')
    expect(document.body.textContent).not.toContain('do not exist in the target sheet')

    const importButton = Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Import 1 record')) as HTMLButtonElement | undefined
    expect(importButton?.disabled).toBe(false)

    app.unmount()
    container.remove()
  })

  it('keeps unmatched headers on skip and says so when the caller cannot manage fields', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaImportModal, {
          visible: true,
          sheetId: 'sheet_ops',
          fields: [{ id: 'fld_name', name: 'Name', type: 'string' }],
          importing: false,
          result: null,
          canCreateFields: false,
          onClose: vi.fn(),
          onImport: vi.fn(),
        })
      },
    })
    app.mount(container)
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Warehouse\tBatch\nA1\tB1'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    const selects = Array.from(document.body.querySelectorAll('.meta-import__field-select')) as HTMLSelectElement[]
    expect(selects.map((select) => select.value)).toEqual(['', ''])
    // The sentinel must not even be RECORDED without the capability: a persisted "create this column"
    // intent would be resurrected the moment the prop or the permission flips.
    const draft = JSON.parse(window.localStorage.getItem('metasheet:multitable:import-draft:sheet_ops') ?? '{}')
    expect(Object.values(draft.fieldMapping ?? {})).toEqual(['', ''])
    expect(Array.from(document.body.querySelectorAll('.meta-import__field-select option')).map((option) => option.getAttribute('value')))
      .not.toContain('__create__')
    expect(document.body.textContent).toContain('2 column(s) do not exist in the target sheet and were skipped.')

    const importButton = Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Import 1 record')) as HTMLButtonElement | undefined
    expect(importButton?.disabled).toBe(true)

    app.unmount()
    container.remove()
  })

  it('runs the paste path through the shared matcher: trims field names and never double-maps one field', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaImportModal, {
          visible: true,
          sheetId: 'sheet_ops',
          // Trailing space in the stored field name: the old inline paste matcher compared
          // `field.name.toLowerCase()` WITHOUT trimming, so this column silently fell through to
          // "skip" on paste while the .xlsx path matched it.
          fields: [{ id: 'fld_wh', name: 'Warehouse ', type: 'string' }],
          importing: false,
          result: null,
          canCreateFields: true,
          onClose: vi.fn(),
          onImport: vi.fn(),
        })
      },
    })
    app.mount(container)
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    // Two headers that normalize to the SAME field name. The old paste matcher had no usedFieldIds
    // set, so both columns bound to fld_wh and the second column's values overwrote the first.
    textarea.value = 'Warehouse\twarehouse\nA1\tB1'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    const selects = Array.from(document.body.querySelectorAll('.meta-import__field-select')) as HTMLSelectElement[]
    expect(selects.map((select) => select.value)).toEqual(['fld_wh', '__create__'])
    expect(document.body.textContent).toContain('1 column(s) will be created as new text fields.')

    app.unmount()
    container.remove()
  })

  it('strips create-field sentinels when the manage-fields permission is revoked mid-session', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const Harness = defineComponent({
      setup() {
        const canCreateFields = ref(true)
        return { canCreateFields }
      },
      render() {
        return h(MetaImportModal, {
          visible: true,
          sheetId: 'sheet_ops',
          fields: [{ id: 'fld_name', name: 'Name', type: 'string' }],
          importing: false,
          result: null,
          canCreateFields: this.canCreateFields,
          onClose: vi.fn(),
          onImport: vi.fn(),
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Name\tWarehouse\nAlpha\tA1'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    expect(JSON.parse(window.localStorage.getItem('metasheet:multitable:import-draft:sheet_ops') ?? '{}').fieldMapping)
      .toEqual({ 0: 'fld_name', 1: '__create__' })

    vm.canCreateFields = false
    await flushUi()

    const selects = Array.from(document.body.querySelectorAll('.meta-import__field-select')) as HTMLSelectElement[]
    expect(selects[1]?.value).toBe('')
    expect(JSON.parse(window.localStorage.getItem('metasheet:multitable:import-draft:sheet_ops') ?? '{}').fieldMapping)
      .toEqual({ 0: 'fld_name', 1: '' })
    expect(document.body.textContent).toContain('the "create new field" columns were switched to skip')

    app.unmount()
    container.remove()
  })

  it('keeps the create-field sentinel when a draft is reconciled after field drift', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const Harness = defineComponent({
      setup() {
        const fields = ref([{ id: 'fld_name', name: 'Name', type: 'string' }])
        return { fields }
      },
      render() {
        return h(MetaImportModal, {
          visible: true,
          fields: this.fields,
          importing: false,
          result: null,
          canCreateFields: true,
          onClose: vi.fn(),
          onImport: vi.fn(),
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Name\tWarehouse\nAlpha\tA1'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    vm.fields = [{ id: 'fld_name', name: 'Name Formula', type: 'formula' }]
    await flushUi()

    Array.from(document.body.querySelectorAll('.meta-import__warning .meta-import__btn-inline'))
      .find((button) => button.textContent?.includes('Reconcile draft'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    const selects = Array.from(document.body.querySelectorAll('.meta-import__field-select')) as HTMLSelectElement[]
    expect(selects[0]?.value).toBe('')
    expect(selects[1]?.value).toBe('__create__')
    expect(document.body.textContent).toContain('1 column(s) will be created as new text fields.')

    app.unmount()
    container.remove()
  })

  it('degrades a restored create-field sentinel to skip when the manage-fields permission is gone', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    window.localStorage.setItem('metasheet:multitable:import-draft:sheet_ops', JSON.stringify({
      version: 1,
      rawText: 'Name\tWarehouse\nAlice\tA1',
      parsedHeaders: ['Name', 'Warehouse'],
      parsedRows: [['Alice', 'A1']],
      fieldMapping: { 0: 'fld_name', 1: '__create__' },
      manualFieldOverrides: {},
      manualOverrideSummaries: {},
      step: 'preview',
    }))

    const Harness = defineComponent({
      setup() {
        // The draft is only restored on a false → true `visible` transition (same as production,
        // where the workbench mounts the modal hidden).
        const visible = ref(false)
        return { visible }
      },
      render() {
        return h(MetaImportModal, {
          visible: this.visible,
          sheetId: 'sheet_ops',
          fields: [{ id: 'fld_name', name: 'Name', type: 'string' }],
          importing: false,
          result: null,
          canCreateFields: false,
          onClose: vi.fn(),
          onImport: vi.fn(),
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any
    await flushUi()
    vm.visible = true
    await flushUi()

    const selects = Array.from(document.body.querySelectorAll('.meta-import__field-select')) as HTMLSelectElement[]
    expect(selects[0]?.value).toBe('fld_name')
    expect(selects[1]?.value).toBe('')
    // The degrade is DURABLE: the re-persisted draft must no longer carry the sentinel, otherwise the
    // dropped intent comes back on the next open.
    const rewritten = JSON.parse(window.localStorage.getItem('metasheet:multitable:import-draft:sheet_ops') ?? '{}')
    expect(rewritten.fieldMapping).toEqual({ 0: 'fld_name', 1: '' })
    expect(document.body.textContent).toContain('the "create new field" columns were switched to skip')
    // A dropped sentinel is NOT a draft issue — the reconcile banner must not appear for it.
    expect(document.body.textContent).not.toContain('Reconcile draft')

    app.unmount()
    container.remove()
  })

  it('carries create-field requests and placeholder-keyed values in the import payload', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const importCalls: any[] = []

    const app = createApp({
      render() {
        return h(MetaImportModal, {
          visible: true,
          fields: [{ id: 'fld_name', name: 'Name', type: 'string' }],
          importing: false,
          result: null,
          canCreateFields: true,
          onClose: vi.fn(),
          onImport: (payload: any) => { importCalls.push(payload) },
        })
      },
    })
    app.mount(container)
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Name\tWarehouse\nAlpha\tA1'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Import 1 record'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    expect(importCalls).toHaveLength(1)
    expect(importCalls[0].createFields).toEqual([{ header: 'Warehouse', columnIndex: 1 }])
    expect(importCalls[0].records).toEqual([{ fld_name: 'Alpha', '__create__:1': 'A1' }])

    app.unmount()
    container.remove()
  })

  it('rebinds the sentinel to the created field id so a re-import cannot create it twice', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const importCalls: any[] = []

    const Harness = defineComponent({
      setup() {
        const fields = ref([{ id: 'fld_name', name: 'Name', type: 'string' }])
        const createdFieldColumns = ref<Record<number, string> | null>(null)
        const result = ref<any>(null)
        return { fields, createdFieldColumns, result }
      },
      render() {
        return h(MetaImportModal, {
          visible: true,
          fields: this.fields,
          importing: false,
          result: this.result,
          canCreateFields: true,
          createdFieldColumns: this.createdFieldColumns,
          onClose: vi.fn(),
          onImport: (payload: any) => {
            importCalls.push(payload)
            // Partial failure keeps the modal open on the result step, which is the path back to
            // mapping where a second import attempt could otherwise re-create the same field.
            this.result = {
              attempted: 1,
              succeeded: 0,
              failed: 1,
              firstError: 'Temporary outage',
              failures: [{ index: 0, rowIndex: 0, message: 'Temporary outage', retryable: true }],
            }
          },
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Name\tWarehouse\nAlpha\tA1'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Import 1 record'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    // The caller reports back what it created; the modal must stop asking for a create.
    vm.fields = [
      { id: 'fld_name', name: 'Name', type: 'string' },
      { id: 'fld_new', name: 'Warehouse', type: 'string' },
    ]
    vm.createdFieldColumns = { 1: 'fld_new' }
    await flushUi()

    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Back to mapping'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    const selects = Array.from(document.body.querySelectorAll('.meta-import__field-select')) as HTMLSelectElement[]
    expect(selects[1]?.value).toBe('fld_new')

    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Import 1 record'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    expect(importCalls).toHaveLength(2)
    expect(importCalls[1].createFields).toBeUndefined()
    expect(importCalls[1].records).toEqual([{ fld_name: 'Alpha', fld_new: 'A1' }])

    app.unmount()
    container.remove()
  })

  it('returns to mapping without importing when the caller reports a create-field failure', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const Harness = defineComponent({
      setup() {
        const createFieldsError = ref<string | null>(null)
        return { createFieldsError }
      },
      render() {
        return h(MetaImportModal, {
          visible: true,
          fields: [{ id: 'fld_name', name: 'Name', type: 'string' }],
          importing: false,
          result: null,
          canCreateFields: true,
          createFieldsError: this.createFieldsError,
          onClose: vi.fn(),
          onImport: vi.fn(),
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Name\tWarehouse\nAlpha\tA1'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Import 1 record'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()
    expect(document.body.querySelector('.meta-import__spinner')).not.toBeNull()

    vm.createFieldsError = 'Failed to create field "Warehouse": Forbidden No records were imported.'
    await flushUi()

    expect(document.body.querySelector('.meta-import__spinner')).toBeNull()
    expect(document.body.querySelector('.meta-import__create-error')?.textContent)
      .toContain('Failed to create field "Warehouse"')
    const importButton = Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Import 1 record')) as HTMLButtonElement | undefined
    expect(importButton?.disabled).toBe(false)

    app.unmount()
    container.remove()
  })
})
