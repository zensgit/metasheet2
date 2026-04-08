import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
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
          onClose: this.onClose,
          onImport: this.onImport,
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as { visible: boolean }
    await flushUi()

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement
    textarea.value = 'Name\nAlice'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    expect((document.body.querySelector('.meta-import__field-select') as HTMLSelectElement | null)?.value).toBe('fld_name')
    expect(window.localStorage.getItem('metasheet:multitable:import-draft:sheet_ops')).toContain('Alice')

    vm.visible = false
    await flushUi()
    vm.visible = true
    await flushUi()

    expect(document.body.textContent).toContain('Recovered your previous import draft for this sheet.')
    expect((document.body.querySelector('.meta-import__field-select') as HTMLSelectElement | null)?.value).toBe('fld_name')
    expect(document.body.textContent).toContain('1 record(s) detected')

    app.unmount()
    container.remove()
  })
})
