import { describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import MetaPersonPicker from '../src/multitable/components/MetaPersonPicker.vue'

// Native person (人员) picker — MEMBER-SCOPED by construction (sources from
// listSheetPermissionCandidates, NOT a global org directory) and emits userId[] (NOT recordIds).

const { mockListCandidates } = vi.hoisted(() => ({ mockListCandidates: vi.fn() }))

vi.mock('../src/multitable/api/client', () => ({
  multitableClient: { listSheetPermissionCandidates: mockListCandidates },
}))

const candidates = {
  items: [
    { subjectType: 'user', subjectId: 'u1', label: 'Alice', subtitle: 'alice@x.test', isActive: true },
    { subjectType: 'user', subjectId: 'u2', label: 'Bob', subtitle: 'bob@x.test', isActive: true },
    // non-user + inactive entries must be filtered out of the member roster
    { subjectType: 'role', subjectId: 'role_x', label: 'Editor', subtitle: null, isActive: true },
    { subjectType: 'user', subjectId: 'u_inactive', label: 'Ghost', subtitle: null, isActive: false },
  ],
  total: 4,
  limit: 100,
  query: '',
}

async function flush() {
  await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick()
}

function mount(field: Record<string, unknown>, currentValue: unknown, onConfirm = vi.fn()) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const Harness = defineComponent({
    setup() {
      const visible = ref(false)
      return { visible, onClose: () => { visible.value = false } }
    },
    render() {
      return h(MetaPersonPicker, {
        visible: this.visible,
        field,
        sheetId: 'sheet_1',
        currentValue,
        onClose: this.onClose,
        onConfirm,
      })
    },
  })
  const app = createApp(Harness)
  const vm = app.mount(container) as any
  return { container, app, vm, onConfirm }
}

describe('MetaPersonPicker (member-scoped)', () => {
  it('lists ONLY active user candidates (member-scoped; roles + inactive filtered out)', async () => {
    mockListCandidates.mockResolvedValue(candidates)
    const { container, app, vm } = mount({ id: 'f', name: 'Owner', type: 'person', property: { limitSingleRecord: false } }, [])
    vm.visible = true
    await flush()
    const rows = container.querySelectorAll('[data-test="person-picker-member"]')
    expect(rows.length).toBe(2) // u1 + u2 only
    expect(container.textContent).toContain('Alice')
    expect(container.textContent).toContain('Bob')
    expect(container.textContent).not.toContain('Editor')
    expect(container.textContent).not.toContain('Ghost')
    app.unmount(); container.remove()
  })

  it('emits userId[] (NOT recordIds) on confirm — multi when limitSingleRecord:false', async () => {
    mockListCandidates.mockResolvedValue(candidates)
    const onConfirm = vi.fn()
    const { container, app, vm } = mount({ id: 'f', name: 'Owner', type: 'person', property: { limitSingleRecord: false } }, [], onConfirm)
    vm.visible = true
    await flush()
    const boxes = Array.from(container.querySelectorAll('[data-test="person-picker-member"] input[type="checkbox"]')) as HTMLInputElement[]
    boxes[0]?.click(); boxes[1]?.click()
    await nextTick()
    ;(container.querySelector('[data-test="person-picker-confirm"]') as HTMLButtonElement)?.click()
    expect(onConfirm).toHaveBeenCalledWith({
      userIds: ['u1', 'u2'],
      summaries: [{ id: 'u1', display: 'Alice' }, { id: 'u2', display: 'Bob' }],
    })
    app.unmount(); container.remove()
  })

  it('single-select replaces the prior pick when limitSingleRecord is true (default)', async () => {
    mockListCandidates.mockResolvedValue(candidates)
    const onConfirm = vi.fn()
    // limitSingleRecord omitted → defaults to TRUE (single person)
    const { container, app, vm } = mount({ id: 'f', name: 'Owner', type: 'person' }, ['u1'], onConfirm)
    vm.visible = true
    await flush()
    const boxes = Array.from(container.querySelectorAll('[data-test="person-picker-member"] input[type="checkbox"]')) as HTMLInputElement[]
    // pick u2 → should REPLACE u1 (single select)
    boxes[1]?.click()
    await nextTick()
    ;(container.querySelector('[data-test="person-picker-confirm"]') as HTMLButtonElement)?.click()
    expect(onConfirm).toHaveBeenCalledWith({
      userIds: ['u2'],
      summaries: [{ id: 'u2', display: 'Bob' }],
    })
    app.unmount(); container.remove()
  })
})
