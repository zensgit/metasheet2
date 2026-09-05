import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'

const searchSpy = vi.fn()
vi.mock('../src/approvals/api', () => ({
  searchApprovalDirectoryDepartments: (...args: unknown[]) => searchSpy(...args),
}))

import ApprovalDepartmentPicker from '../src/approvals/components/ApprovalDepartmentPicker.vue'

const ElSelect = defineComponent({
  name: 'ElSelect',
  props: {
    modelValue: { type: [String, Array], default: undefined },
    multiple: Boolean,
    remoteMethod: { type: Function, default: undefined },
  },
  emits: ['update:modelValue', 'visible-change'],
  render() {
    return h('div', { 'data-testid': 'select-stub' }, [
      h('button', {
        'data-testid': 'open-stub',
        onClick: () => this.$emit('visible-change', true),
      }, 'open'),
      h('select', {
        'data-testid': 'value-stub',
        multiple: this.multiple,
        onChange: (event: Event) => {
          const select = event.target as HTMLSelectElement
          const value = this.multiple
            ? Array.from(select.selectedOptions).map((option) => option.value)
            : select.value
          this.$emit('update:modelValue', value)
        },
      }, this.$slots.default?.()),
    ])
  },
})

const ElOption = defineComponent({
  name: 'ElOption',
  props: { label: String, value: String, disabled: Boolean },
  render() {
    return h('option', { value: this.value, disabled: this.disabled }, this.label)
  },
})

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('ApprovalDepartmentPicker', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    searchSpy.mockReset()
    searchSpy.mockResolvedValue({ departments: [] })
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
  })

  async function mountPicker(props: Record<string, unknown> = {}) {
    const updates: unknown[] = []
    const Host = defineComponent({
      setup() {
        return () => h(ApprovalDepartmentPicker, {
          ...props,
          'onUpdate:modelValue': (value: unknown) => updates.push(value),
        })
      },
    })
    app = createApp(Host)
    app.component('ElSelect', ElSelect)
    app.component('ElOption', ElOption)
    app.mount(container!)
    await flushUi()
    return updates
  }

  it('renders authoritative labels and emits only exact {id} values', async () => {
    searchSpy.mockResolvedValue({
      departments: [
        { id: 'dept-a', name: '产品部', fullPath: '总部 / 产品部', hasChildren: false },
        { id: 'dept-b', name: '财务部', fullPath: '总部 / 财务部', hasChildren: false },
      ],
    })
    const updates = await mountPicker({ selection: 'multi', display: 'full_path' })
    expect(Array.from(container!.querySelectorAll('option')).map((option) => option.textContent))
      .toEqual(['总部 / 产品部', '总部 / 财务部'])

    const select = container!.querySelector('[data-testid="value-stub"]') as HTMLSelectElement
    for (const option of Array.from(select.options)) option.selected = true
    select.dispatchEvent(new Event('change'))
    await flushUi()
    expect(updates).toEqual([[{ id: 'dept-a' }, { id: 'dept-b' }]])
  })

  it('never renders an unresolved selected department id and keeps it unselectable', async () => {
    await mountPicker({ modelValue: [{ id: 'department-secret-id' }] })
    const option = container!.querySelector('option') as HTMLOptionElement
    expect(option.textContent).toBe('部门 1')
    expect(option.textContent).not.toContain('department-secret-id')
    expect(option.value).toBe('department-secret-id')
    expect(option.disabled).toBe(true)
  })

  it('applies requester-department default once and still emits only {id}', async () => {
    searchSpy.mockResolvedValue({
      departments: [{ id: 'dept-a', name: '产品部', fullPath: '总部 / 产品部', hasChildren: false }],
      requesterDepartmentId: 'dept-a',
    })
    const updates = await mountPicker({ defaultMode: 'requester_department' })
    expect(updates).toEqual([[{ id: 'dept-a' }]])

    const open = container!.querySelector('[data-testid="open-stub"]') as HTMLButtonElement
    open.click()
    await flushUi()
    expect(updates).toHaveLength(1)
  })

  it('enforces maxSelections before emitting a multi-value update', async () => {
    searchSpy.mockResolvedValue({
      departments: [
        { id: 'dept-a', name: '产品部', fullPath: '总部 / 产品部', hasChildren: false },
        { id: 'dept-b', name: '财务部', fullPath: '总部 / 财务部', hasChildren: false },
      ],
    })
    const updates = await mountPicker({ selection: 'multi', maxSelections: 1 })
    const select = container!.querySelector('[data-testid="value-stub"]') as HTMLSelectElement
    for (const option of Array.from(select.options)) option.selected = true
    select.dispatchEvent(new Event('change'))
    await flushUi()
    expect(updates).toEqual([[{ id: 'dept-a' }]])
  })

  it('browses roots and children while keeping an intermediate department selectable', async () => {
    searchSpy
      .mockResolvedValueOnce({ departments: [] })
      .mockResolvedValueOnce({
        departments: [{ id: 'dept-root', name: '总部', fullPath: '总部', hasChildren: true }],
      })
      .mockResolvedValueOnce({
        departments: [{
          id: 'dept-child',
          name: '产品部',
          fullPath: '总部 / 产品部',
          parentId: 'dept-root',
          hasChildren: false,
        }],
      })
    const updates = await mountPicker()
    ;(container!.querySelector('[data-testid="approval-department-tree-mode"]') as HTMLButtonElement).click()
    await flushUi()
    expect(searchSpy).toHaveBeenLastCalledWith('', 50, null)

    const rootButtons = Array.from(container!.querySelectorAll('[data-testid="approval-department-tree"] button')) as HTMLButtonElement[]
    const rootSelect = rootButtons.find((button) => button.textContent?.trim() === '总部')!
    rootSelect.click()
    await flushUi()
    expect(updates).toEqual([[{ id: 'dept-root' }]])

    const childButton = rootButtons.find((button) => button.textContent?.trim() === '下级')!
    childButton.click()
    await flushUi()
    expect(searchSpy).toHaveBeenLastCalledWith('', 50, 'dept-root')
    expect(container!.textContent).toContain('产品部')
  })
})
