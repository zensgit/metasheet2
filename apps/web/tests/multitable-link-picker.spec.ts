import { describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, computed } from 'vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import MetaLinkPicker from '../src/multitable/components/MetaLinkPicker.vue'

const { mockListLinkOptions } = vi.hoisted(() => ({
  mockListLinkOptions: vi.fn(),
}))

vi.mock('../src/multitable/api/client', () => ({
  multitableClient: {
    listLinkOptions: mockListLinkOptions,
  },
}))

const linkField = {
  id: 'fld_vendor',
  name: 'Vendor',
  type: 'link',
}

const flushPromises = async () => {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

describe('MetaLinkPicker', () => {
  it('shows current selections and resets them after cancel', async () => {
    mockListLinkOptions.mockResolvedValue({
      field: linkField,
      targetSheet: { id: 'sheet_vendors', baseId: 'base_1', name: 'Vendors' },
      selected: [{ id: 'vendor_1', display: 'Acme Supply' }],
      records: [
        { id: 'vendor_1', display: 'Acme Supply' },
        { id: 'vendor_2', display: 'Beacon Labs' },
      ],
      page: { offset: 0, limit: 50, total: 2, hasMore: false },
    })

    const container = document.createElement('div')
    document.body.appendChild(container)

    const Harness = defineComponent({
      setup() {
        const visible = ref(false)
        const currentValue = ref(['vendor_1'])
        return {
          visible,
          currentValue,
          onClose: () => {
            visible.value = false
          },
        }
      },
      render() {
        return h(MetaLinkPicker, {
          visible: this.visible,
          field: linkField,
          currentValue: this.currentValue,
          onClose: this.onClose,
          onConfirm: vi.fn(),
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any

    vm.visible = true
    await flushPromises()

    expect(container.textContent).toContain('1 selected')
    expect(container.textContent).toContain('Acme Supply')

    const checkbox = container.querySelector('.meta-link-picker__item input[type="checkbox"]') as HTMLInputElement | null
    expect(checkbox).toBeTruthy()
    checkbox?.click()
    await nextTick()

    expect(container.textContent).toContain('0 selected')

    const close = container.querySelector('.meta-link-picker__close') as HTMLButtonElement | null
    expect(close).toBeTruthy()
    close?.click()
    await nextTick()

    expect(container.querySelector('.meta-link-picker')).toBeNull()

    vm.visible = true
    await flushPromises()

    expect(container.textContent).toContain('1 selected')
    expect(container.textContent).toContain('Acme Supply')

    app.unmount()
    container.remove()
  })

  it('clears the outer value when selection is cleared and confirmed', async () => {
    mockListLinkOptions.mockResolvedValue({
      field: linkField,
      targetSheet: { id: 'sheet_vendors', baseId: 'base_1', name: 'Vendors' },
      selected: [{ id: 'vendor_1', display: 'Acme Supply' }],
      records: [
        { id: 'vendor_1', display: 'Acme Supply' },
        { id: 'vendor_2', display: 'Beacon Labs' },
      ],
      page: { offset: 0, limit: 50, total: 2, hasMore: false },
    })

    const container = document.createElement('div')
    document.body.appendChild(container)

    const Harness = defineComponent({
      setup() {
        const visible = ref(false)
        const currentValue = ref(['vendor_1'])
        const outerValueText = computed(() => currentValue.value.length ? currentValue.value.join(', ') : '(empty)')
        return {
          visible,
          currentValue,
          outerValueText,
          onClose: () => {
            visible.value = false
          },
          onConfirm: (payload: { recordIds: string[] }) => {
            currentValue.value = payload.recordIds
            visible.value = false
          },
        }
      },
      render() {
        return h('div', {}, [
          h('div', { class: 'outer-value' }, this.outerValueText),
          h(MetaLinkPicker, {
            visible: this.visible,
            field: linkField,
            currentValue: this.currentValue,
            onClose: this.onClose,
            onConfirm: this.onConfirm,
          }),
        ])
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any
    vm.visible = true
    await flushPromises()

    expect(container.textContent).toContain('vendor_1')

    const checkbox = container.querySelector('.meta-link-picker__item input[type="checkbox"]') as HTMLInputElement | null
    expect(checkbox).toBeTruthy()
    checkbox?.click()
    await nextTick()

    const confirm = container.querySelector('.meta-link-picker__confirm') as HTMLButtonElement | null
    expect(confirm).toBeTruthy()
    confirm?.click()
    await flushPromises()

    expect(container.textContent).toContain('(empty)')
    expect(container.querySelector('.meta-link-picker')).toBeNull()

    app.unmount()
    container.remove()
  })
})

describe('MetaGridTable link search', () => {
  it('matches search text against linked record summaries', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaGridTable, {
          rows: [
            { id: 'rec_1', version: 1, data: { fld_title: 'PO-1001', fld_vendor: ['vendor_1'] } },
          ],
          visibleFields: [
            { id: 'fld_title', name: 'Order Title', type: 'string' },
            { id: 'fld_vendor', name: 'Vendor', type: 'link' },
          ],
          sortRules: [],
          loading: false,
          currentPage: 1,
          totalPages: 1,
          startIndex: 0,
          selectedRecordId: null,
          canEdit: false,
          canDelete: false,
          columnWidths: {},
          linkSummaries: {
            rec_1: {
              fld_vendor: [{ id: 'vendor_1', display: 'Acme Supply' }],
            },
          },
          enableMultiSelect: false,
          searchText: 'acme',
          rowDensity: 'normal',
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect(container.textContent).toContain('Acme Supply')
    expect(container.querySelectorAll('tbody tr.meta-grid__row')).toHaveLength(1)
    expect(container.textContent).not.toContain('vendor_1')

    app.unmount()
    container.remove()
  })
})
