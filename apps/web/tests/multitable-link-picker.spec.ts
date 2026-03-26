import { describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
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

const personField = {
  id: 'fld_owner',
  name: 'Owner',
  type: 'link',
  property: {
    refKind: 'user',
    limitSingleRecord: true,
  },
}

async function flushPromises() {
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
        return {
          visible,
          currentValue,
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
          h('div', { class: 'outer-value' }, this.currentValue.length ? this.currentValue.join(', ') : '(empty)'),
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

  it('replaces the previous selection for person-style single select links', async () => {
    mockListLinkOptions.mockResolvedValue({
      field: personField,
      targetSheet: { id: 'sheet_people', baseId: 'base_1', name: 'People' },
      selected: [{ id: 'user_1', display: 'Amy' }],
      records: [
        { id: 'user_1', display: 'Amy' },
        { id: 'user_2', display: 'Jamie' },
      ],
      page: { offset: 0, limit: 50, total: 2, hasMore: false },
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const onConfirm = vi.fn()

    const Harness = defineComponent({
      setup() {
        const visible = ref(false)
        return {
          visible,
          onClose: () => {
            visible.value = false
          },
        }
      },
      render() {
        return h(MetaLinkPicker, {
          visible: this.visible,
          field: personField,
          currentValue: ['user_1'],
          onClose: this.onClose,
          onConfirm,
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any
    vm.visible = true
    await flushPromises()

    const checkboxes = Array.from(container.querySelectorAll('.meta-link-picker__item input[type="checkbox"]')) as HTMLInputElement[]
    expect(checkboxes).toHaveLength(2)
    checkboxes[1]?.click()
    await nextTick()

    expect(container.textContent).toContain('1 selected')
    const confirm = container.querySelector('.meta-link-picker__confirm') as HTMLButtonElement | null
    confirm?.click()

    expect(onConfirm).toHaveBeenCalledWith({
      recordIds: ['user_2'],
      summaries: [{ id: 'user_2', display: 'Jamie' }],
    })

    app.unmount()
    container.remove()
  })
})
