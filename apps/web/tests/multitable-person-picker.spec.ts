import { describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import MetaPersonPicker from '../src/multitable/components/MetaPersonPicker.vue'

// Native person (人员) picker — sources the field's assignable member-group DIRECTORY
// (listPersonFieldDirectory, 2c-S3) = exactly the active, member-group-scoped set the write validator
// accepts (display parity). Emits userId[] (NOT recordIds). Stored chips render independently of the
// offered list, so a stored value missing from the directory is never silently dropped (2c-S3 invariant).

const { mockListDirectory } = vi.hoisted(() => ({ mockListDirectory: vi.fn() }))

vi.mock('../src/multitable/api/client', () => ({
  multitableClient: { listPersonFieldDirectory: mockListDirectory },
}))

// The endpoint already returns ACTIVE, member-group-scoped users only — the picker no longer filters.
const directory = {
  items: [
    { userId: 'u1', name: 'Alice', email: 'alice@x.test' },
    { userId: 'u2', name: 'Bob', email: 'bob@x.test' },
  ],
  total: 2,
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
  const vm = app.mount(container) as unknown as { visible: boolean }
  return { container, app, vm, onConfirm }
}

describe('MetaPersonPicker (field member-group directory)', () => {
  it('lists the field directory members (pre-filtered active + member-group-scoped by the endpoint)', async () => {
    mockListDirectory.mockResolvedValue(directory)
    const { container, app, vm } = mount({ id: 'f', name: 'Owner', type: 'person', property: { limitSingleRecord: false } }, [])
    vm.visible = true
    await flush()
    const rows = container.querySelectorAll('[data-test="person-picker-member"]')
    expect(rows.length).toBe(2)
    expect(container.textContent).toContain('Alice')
    expect(container.textContent).toContain('Bob')
    app.unmount(); container.remove()
  })

  it('calls the field-aware directory endpoint with sheetId + the field id', async () => {
    mockListDirectory.mockResolvedValue(directory)
    const { container, app, vm } = mount({ id: 'fld_owner', name: 'Owner', type: 'person', property: { limitSingleRecord: false } }, [])
    vm.visible = true
    await flush()
    expect(mockListDirectory).toHaveBeenCalledWith('sheet_1', 'fld_owner', expect.anything())
    app.unmount(); container.remove()
  })

  it('emits userId[] (NOT recordIds) on confirm — multi when limitSingleRecord:false', async () => {
    mockListDirectory.mockResolvedValue(directory)
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
    mockListDirectory.mockResolvedValue(directory)
    const onConfirm = vi.fn()
    const { container, app, vm } = mount({ id: 'f', name: 'Owner', type: 'person' }, ['u1'], onConfirm)
    vm.visible = true
    await flush()
    const boxes = Array.from(container.querySelectorAll('[data-test="person-picker-member"] input[type="checkbox"]')) as HTMLInputElement[]
    boxes[1]?.click() // pick u2 → REPLACE u1
    await nextTick()
    ;(container.querySelector('[data-test="person-picker-confirm"]') as HTMLButtonElement)?.click()
    expect(onConfirm).toHaveBeenCalledWith({
      userIds: ['u2'],
      summaries: [{ id: 'u2', display: 'Bob' }],
    })
    app.unmount(); container.remove()
  })

  // 2c-S3 invariant: a stored value NOT in the current directory (inactive / out-of-restriction) is
  // preserved — kept as a selected chip and emitted on confirm, never silently dropped (display = S4).
  it('preserves a stored value missing from the directory (no silent drop)', async () => {
    mockListDirectory.mockResolvedValue(directory) // directory = u1, u2 only — u_gone is NOT offered
    const onConfirm = vi.fn()
    const { container, app, vm } = mount({ id: 'f', name: 'Owner', type: 'person', property: { limitSingleRecord: false } }, ['u_gone'], onConfirm)
    vm.visible = true
    await flush()
    ;(container.querySelector('[data-test="person-picker-confirm"]') as HTMLButtonElement)?.click()
    expect(onConfirm).toHaveBeenCalledWith({
      userIds: ['u_gone'],
      summaries: [{ id: 'u_gone', display: 'u_gone' }],
    })
    app.unmount(); container.remove()
  })

  // 2c-S4: a preserved stored chip that's absent from the assignable directory is VISUALLY MARKED
  // historical (muted + title) so the user sees it's kept-but-not-reassignable; an in-directory chip is not.
  it('marks a stored chip absent from the directory as historical; leaves an in-directory chip unmarked', async () => {
    mockListDirectory.mockResolvedValue(directory) // u1, u2 offered — u_gone is NOT
    const { container, app, vm } = mount({ id: 'f', name: 'Owner', type: 'person', property: { limitSingleRecord: false } }, ['u_gone', 'u1'], vi.fn())
    vm.visible = true
    await flush()
    const chips = Array.from(container.querySelectorAll('.meta-person-picker__chip')) as HTMLElement[]
    const historical = chips.filter((c) => c.getAttribute('data-historical') === 'true')
    expect(historical).toHaveLength(1) // only u_gone
    const hist = historical[0]
    expect(hist.classList.contains('meta-person-picker__chip--historical')).toBe(true)
    expect(hist.getAttribute('title')).toBeTruthy() // i18n personPicker.historicalMember resolves
    expect(hist.textContent).toContain('u_gone') // still rendered — never dropped (2c-S3b invariant held)
    const inDir = chips.find((c) => (c.textContent ?? '').includes('Alice'))
    expect(inDir?.getAttribute('data-historical')).toBeNull() // u1 is assignable → not marked
    app.unmount(); container.remove()
  })

  // Guard: with no directory loaded (unsaved field, no id) we cannot know the assignable set, so NO chip
  // is marked historical (avoids false positives) — the stored chip still renders.
  it('does not mark chips historical when the directory has not loaded (unsaved field)', async () => {
    mockListDirectory.mockResolvedValue(directory)
    const { container, app, vm } = mount({ name: 'Owner', type: 'person', property: { limitSingleRecord: false } }, ['u_gone'], vi.fn())
    vm.visible = true
    await flush()
    const chips = Array.from(container.querySelectorAll('.meta-person-picker__chip')) as HTMLElement[]
    expect(chips).toHaveLength(1)
    expect(chips[0].getAttribute('data-historical')).toBeNull()
    app.unmount(); container.remove()
  })
})
