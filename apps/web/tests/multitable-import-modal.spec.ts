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

    const textarea = document.body.querySelector('.meta-import__textarea') as HTMLTextAreaElement | null
    expect(textarea).not.toBeNull()
    textarea!.value = 'Name\tStatus\nAlpha\tOpen\nBeta\tBadValue'
    textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement | null)?.click()
    await flushUi()

    const previewButtons = Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn')) as HTMLButtonElement[]
    previewButtons.find((button) => button.textContent?.includes('Import'))?.click()
    await flushUi()

    expect(importCalls).toHaveLength(1)
    expect(importCalls[0]).toEqual([
      { fld_name: 'Alpha', fld_status: 'Open' },
      { fld_name: 'Beta', fld_status: 'BadValue' },
    ])
    expect(document.body.textContent).toContain('Review the failed rows below')
    expect(document.body.textContent).toContain('1 imported, 1 failed')
    expect(document.body.textContent).toContain('Row 3')
    expect(document.body.textContent).toContain('Beta | BadValue')

    const retryButton = Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Retry failed rows')) as HTMLButtonElement | undefined
    retryButton?.click()
    await flushUi()

    expect(importCalls).toHaveLength(2)
    expect(importCalls[1]).toEqual([
      { fld_name: 'Beta', fld_status: 'BadValue' },
    ])

    app.unmount()
    container.remove()
  })

  it('hides retry and blocks close while importing or when failures need manual fixes', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const closeSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaImportModal, {
          visible: true,
          fields: [{ id: 'fld_owner', name: 'Owner', type: 'link', property: { refKind: 'user', foreignSheetId: 'sheet_people' } }],
          importing: true,
          result: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            firstError: 'Owner has multiple matches. Use email for an exact match.',
            failures: [{ index: 0, rowIndex: 0, message: 'Owner has multiple matches. Use email for an exact match.', retryable: false }],
          },
          onClose: closeSpy,
          onImport: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    expect(document.body.querySelector('.meta-import__close')?.getAttribute('disabled')).not.toBeNull()
    ;(document.body.querySelector('.meta-import__close') as HTMLButtonElement | null)?.click()
    await flushUi()
    expect(closeSpy).not.toHaveBeenCalled()

    app.unmount()
    container.remove()

    const resultContainer = document.createElement('div')
    document.body.appendChild(resultContainer)
    const resultApp = createApp({
      render() {
        return h(MetaImportModal, {
          visible: true,
          fields: [{ id: 'fld_owner', name: 'Owner', type: 'link', property: { refKind: 'user', foreignSheetId: 'sheet_people' } }],
          importing: false,
          result: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            firstError: 'Owner has multiple matches. Use email for an exact match.',
            failures: [{ index: 0, rowIndex: 0, message: 'Owner has multiple matches. Use email for an exact match.', retryable: false }],
          },
          onClose: vi.fn(),
          onImport: vi.fn(),
        })
      },
    })

    resultApp.mount(resultContainer)
    await flushUi()

    expect(document.body.textContent).toContain('return to mapping to fix the source data')
    const retryButton = Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Retry failed rows'))
    expect(retryButton).toBeUndefined()

    resultApp.unmount()
    resultContainer.remove()
  })

  it('lets users repair failed rows inline and retry with the corrected value', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const importCalls: Array<{
      records: Array<Record<string, unknown>>
      failures: Array<{ rowIndex: number; message: string }>
    }> = []

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
            if (payload.failures.length > 0) {
              result.value = {
                attempted: payload.records.length + payload.failures.length,
                succeeded: payload.records.length,
                failed: payload.failures.length,
                firstError: payload.failures[0]?.message ?? null,
                failures: payload.failures,
              }
            } else {
              result.value = {
                attempted: payload.records.length,
                succeeded: payload.records.length,
                failed: 0,
                firstError: null,
                failures: [],
              }
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

    const importButton = Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Import')) as HTMLButtonElement | undefined
    importButton?.click()
    await flushUi()

    expect(importCalls).toHaveLength(1)
    expect(document.body.textContent).toContain('Use an exact email address or person record ID for this field.')

    const fixInput = document.body.querySelector('.meta-import__fix-input') as HTMLInputElement | null
    expect(fixInput).not.toBeNull()
    fixInput!.value = 'owner@example.com'
    fixInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    const applyFixesButton = Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Apply fixes and retry')) as HTMLButtonElement | undefined
    applyFixesButton?.click()
    await flushUi()

    expect(importCalls).toHaveLength(2)
    expect(importCalls[1]?.records).toEqual([{ fld_owner: ['rec_owner_1'] }])
    expect(importCalls[1]?.failures).toEqual([])

    app.unmount()
    container.remove()
  })

  it('lets users repair people ambiguity via picker and retry with selected record ids', async () => {
    mockListLinkOptions.mockResolvedValue({
      field: { id: 'fld_owner', name: 'Owner', type: 'link', property: { refKind: 'user', foreignSheetId: 'sheet_people', limitSingleRecord: true } },
      targetSheet: { id: 'sheet_people', baseId: 'base_1', name: 'People' },
      selected: [],
      records: [{ id: 'rec_owner_1', display: 'Owner Person' }],
      page: { offset: 0, limit: 50, total: 1, hasMore: false },
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const importCalls: Array<{
      records: Array<Record<string, unknown>>
      failures: Array<{ rowIndex: number; message: string }>
    }> = []

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

    const importButton = Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Import')) as HTMLButtonElement | undefined
    importButton?.click()
    await flushUi()

    expect(importCalls).toHaveLength(1)
    const pickerButton = Array.from(document.body.querySelectorAll('.meta-import__fix-picker-row .meta-import__btn'))
      .find((button) => button.textContent?.includes('Select person')) as HTMLButtonElement | undefined
    expect(pickerButton).toBeTruthy()
    pickerButton?.click()
    await flushUi()

    expect(mockListLinkOptions).toHaveBeenCalledWith('fld_owner', expect.objectContaining({
      search: 'Owner',
      limit: 50,
      offset: 0,
    }))
    expect((document.body.querySelector('.meta-link-picker__input') as HTMLInputElement | null)?.value).toBe('Owner')

    const checkbox = document.body.querySelector('.meta-link-picker__item input[type="checkbox"]') as HTMLInputElement | null
    checkbox?.click()
    await flushUi()

    ;(document.body.querySelector('.meta-link-picker__confirm') as HTMLButtonElement | null)?.click()
    await flushUi()

    expect(document.body.textContent).toContain('Owner Person')

    const applyFixesButton = Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Apply fixes and retry')) as HTMLButtonElement | undefined
    applyFixesButton?.click()
    await flushUi()

    expect(importCalls).toHaveLength(2)
    expect(importCalls[1]?.records).toEqual([{ fld_owner: ['rec_owner_1'] }])
    expect(importCalls[1]?.failures).toEqual([])

    app.unmount()
    container.remove()
  })

  it('preserves manual-fix failures when retrying transient rows', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const importSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaImportModal, {
          visible: true,
          fields: [{ id: 'fld_name', name: 'Name', type: 'string' }],
          importing: false,
          result: {
            attempted: 2,
            succeeded: 0,
            failed: 2,
            firstError: 'Temporary import failure',
            failures: [
              { index: 0, rowIndex: 0, message: 'Temporary import failure', retryable: true },
              { rowIndex: 1, message: 'Owner has multiple matches. Use email for an exact match.', retryable: false, fieldId: 'fld_name', fieldName: 'Name' },
            ],
          },
          onClose: vi.fn(),
          onImport: importSpy,
        })
      },
    })

    app.mount(container)
    await flushUi()

    const state = (document.body.querySelector('.meta-import-modal') as any)?.__vueParentComponent
    expect(state).toBeTruthy()

    const retryButton = Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Retry failed rows')) as HTMLButtonElement | undefined
    retryButton?.click()
    await flushUi()

    expect(importSpy).toHaveBeenCalledWith({
      records: [],
      rowIndexes: [],
      failures: [
        { rowIndex: 1, message: 'Owner has multiple matches. Use email for an exact match.', retryable: false, fieldId: 'fld_name', fieldName: 'Name' },
      ],
    })

    app.unmount()
    container.remove()
  })

  it('tracks upstream field renames in preview mapping without stale warnings', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const Harness = defineComponent({
      setup() {
        const fields = ref([
          { id: 'fld_name', name: 'Name', type: 'string' },
        ])
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

    vm.fields = [{ id: 'fld_name', name: 'Title', type: 'string' }]
    await flushUi()

    const select = document.body.querySelector('.meta-import__field-select') as HTMLSelectElement | null
    expect(select?.value).toBe('fld_name')
    expect(select?.selectedOptions[0]?.textContent).toBe('Title')
    expect(document.body.querySelector('.meta-import__warning')).toBeNull()

    app.unmount()
    container.remove()
  })

  it('blocks preview import until invalid mappings are reconciled after background field drift', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const Harness = defineComponent({
      setup() {
        const fields = ref([
          { id: 'fld_name', name: 'Name', type: 'string' },
        ])
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

    const reconcileButton = Array.from(document.body.querySelectorAll('.meta-import__warning .meta-import__btn-inline'))
      .find((button) => button.textContent?.includes('Reconcile draft')) as HTMLButtonElement | undefined
    reconcileButton?.click()
    await flushUi()

    expect(document.body.querySelector('.meta-import__warning')).toBeNull()
    expect((document.body.querySelector('.meta-import__field-select') as HTMLSelectElement | null)?.value).toBe('')
    expect(importButton?.disabled).toBe(true)

    app.unmount()
    container.remove()
  })

  it('blocks manual-fix retry until invalid people repairs are reconciled after field type drift', async () => {
    mockListLinkOptions.mockResolvedValue({
      field: { id: 'fld_owner', name: 'Owner', type: 'link', property: { refKind: 'user', foreignSheetId: 'sheet_people', limitSingleRecord: true } },
      targetSheet: { id: 'sheet_people', baseId: 'base_1', name: 'People' },
      selected: [],
      records: [{ id: 'rec_owner_1', display: 'Owner Person' }],
      page: { offset: 0, limit: 50, total: 1, hasMore: false },
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const importCalls: Array<{
      records: Array<Record<string, unknown>>
      failures: Array<{ rowIndex: number; message: string }>
    }> = []

    const Harness = defineComponent({
      setup() {
        const visible = ref(true)
        const fields = ref([{ id: 'fld_owner', name: 'Owner', type: 'link', property: { refKind: 'user', foreignSheetId: 'sheet_people', limitSingleRecord: true } }])
        const importing = ref(false)
        const result = ref<any>(null)

        const fieldResolvers = {
          fld_owner: async () => {
            throw new Error('Multiple people match "Owner". Use email for an exact match.')
          },
        }

        return {
          visible,
          fields,
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
    textarea.value = 'Owner\nOwner'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    ;(document.body.querySelector('.meta-import__btn--primary') as HTMLButtonElement)?.click()
    await flushUi()

    const importButton = Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Import')) as HTMLButtonElement | undefined
    importButton?.click()
    await flushUi()

    const pickerButton = Array.from(document.body.querySelectorAll('.meta-import__fix-picker-row .meta-import__btn'))
      .find((button) => button.textContent?.includes('Select person')) as HTMLButtonElement | undefined
    pickerButton?.click()
    await flushUi()

    ;(document.body.querySelector('.meta-link-picker__item input[type="checkbox"]') as HTMLInputElement | null)?.click()
    await flushUi()
    ;(document.body.querySelector('.meta-link-picker__confirm') as HTMLButtonElement | null)?.click()
    await flushUi()

    vm.fields = [{ id: 'fld_owner', name: 'Owner Text', type: 'string' }]
    await flushUi()

    expect(document.body.textContent).toContain('A selected people repair for Owner Text is no longer valid because the field changed type. Reconcile the draft before importing.')
    const applyFixesButton = Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Apply fixes and retry')) as HTMLButtonElement | undefined
    expect(applyFixesButton?.disabled).toBe(true)

    const reconcileButton = Array.from(document.body.querySelectorAll('.meta-import__warning .meta-import__btn-inline'))
      .find((button) => button.textContent?.includes('Reconcile draft')) as HTMLButtonElement | undefined
    reconcileButton?.click()
    await flushUi()

    expect(document.body.querySelector('.meta-import__warning')).toBeNull()
    const retryAfterReconcile = Array.from(document.body.querySelectorAll('.meta-import__actions .meta-import__btn'))
      .find((button) => button.textContent?.includes('Apply fixes and retry')) as HTMLButtonElement | undefined
    expect(retryAfterReconcile?.disabled).toBe(false)
    retryAfterReconcile?.click()
    await flushUi()

    expect(importCalls).toHaveLength(2)
    expect(importCalls[1]?.records).toEqual([{ fld_owner: 'Owner Person' }])
    expect(importCalls[1]?.failures).toEqual([])

    app.unmount()
    container.remove()
  })
})
