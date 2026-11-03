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

function mount(
  field: Record<string, unknown>,
  currentValue: unknown,
  onConfirm = vi.fn(),
  // #5781 follow-up: the display names the OPENER already holds for `currentValue`. Omitted by the
  // pre-existing cases, which therefore still pin the raw-id fallback for an opener with no cache.
  currentSummaries?: Array<{ id: string; display: string; inactive?: boolean }>,
) {
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
        currentSummaries,
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

  // #5781: the directory endpoint is now SEARCH-REQUIRED (it no longer answers a term-less call with
  // the deployment-wide roster) and CAPPED. The picker opens with an empty search box, so the very
  // first call it makes gets `requiresQuery` — that must read as a prompt, never as "no members" and
  // never as a load failure.
  describe('#5781 bounded directory', () => {
    const emptyLabels = { en: 'No members found', zh: '未找到成员' }

    it('renders the "type to search" prompt (NOT the empty-result message) when the server requires a term', async () => {
      mockListDirectory.mockResolvedValue({ items: [], total: 0, query: '', hasMore: false, requiresQuery: true, minQueryLength: 1 })
      const { container, app, vm } = mount({ id: 'f', name: 'Owner', type: 'person' }, [])
      vm.visible = true
      await flush()
      expect(container.querySelector('[data-test="person-picker-search-required"]')).not.toBeNull()
      expect(container.querySelectorAll('[data-test="person-picker-member"]').length).toBe(0)
      expect(container.textContent).not.toContain(emptyLabels.en)
      expect(container.textContent).not.toContain(emptyLabels.zh)
      expect(container.querySelector('.meta-person-picker__error')).toBeNull()
      app.unmount(); container.remove()
    })

    it('renders the truncation hint when the answer hit the server ceiling', async () => {
      mockListDirectory.mockResolvedValue({ ...directory, hasMore: true, requiresQuery: false, minQueryLength: 1 })
      const { container, app, vm } = mount({ id: 'f', name: 'Owner', type: 'person' }, [])
      vm.visible = true
      await flush()
      expect(container.querySelector('[data-test="person-picker-truncated"]')).not.toBeNull()
      expect(container.querySelectorAll('[data-test="person-picker-member"]').length).toBe(2)
      app.unmount(); container.remove()
    })

    it('shows neither hint for a normal bounded answer', async () => {
      mockListDirectory.mockResolvedValue({ ...directory, hasMore: false, requiresQuery: false, minQueryLength: 1 })
      const { container, app, vm } = mount({ id: 'f', name: 'Owner', type: 'person' }, [])
      vm.visible = true
      await flush()
      expect(container.querySelector('[data-test="person-picker-search-required"]')).toBeNull()
      expect(container.querySelector('[data-test="person-picker-truncated"]')).toBeNull()
      expect(container.querySelectorAll('[data-test="person-picker-member"]').length).toBe(2)
      app.unmount(); container.remove()
    })

    it('a genuinely empty MATCH still shows the empty-result message (prompt and empty stay distinct)', async () => {
      mockListDirectory.mockResolvedValue({ items: [], total: 0, query: 'zz', hasMore: false, requiresQuery: false, minQueryLength: 1 })
      const { container, app, vm } = mount({ id: 'f', name: 'Owner', type: 'person' }, [])
      vm.visible = true
      await flush()
      expect(container.querySelector('[data-test="person-picker-search-required"]')).toBeNull()
      expect(container.querySelector('.meta-person-picker__empty')).not.toBeNull()
      app.unmount(); container.remove()
    })
  })

  // #5781 FOLLOW-UP: display names for ALREADY-ASSIGNED people.
  //
  // Before #5781 the term-less open call returned the whole directory, so every active assignee was
  // in `items` and the picker learned its name as a SIDE EFFECT of that dump. With the dump gone the
  // fetch answers `items: []`, so the raw-id placeholder the picker seeds on open would survive into
  // the "Selected" chip AND into the summaries echoed back on confirm (which the workbench writes
  // straight into the grid cell + drawer, where it shows until the next full refetch). The opener
  // therefore hands over the summaries it ALREADY has — no new server capability, nothing the client
  // could not already display.
  describe('#5781 follow-up: known displays for pre-selected people', () => {
    const requiresQueryResponse = { items: [], total: 0, query: '', hasMore: false, requiresQuery: true, minQueryLength: 1 }

    it('renders the opener-supplied display for a pre-selected person (NOT the raw userId) when the server requires a term', async () => {
      mockListDirectory.mockResolvedValue(requiresQueryResponse)
      const { container, app, vm } = mount(
        { id: 'f', name: 'Owner', type: 'person' },
        ['u1'],
        vi.fn(),
        [{ id: 'u1', display: 'Alice Fake' }],
      )
      vm.visible = true
      await flush()
      const chip = container.querySelector('.meta-person-picker__chip')
      expect(chip?.textContent).toContain('Alice Fake')
      expect(chip?.textContent).not.toContain('u1')
      app.unmount(); container.remove()
    })

    it('echoes the known display on confirm, so the grid cell does not regress to a raw userId', async () => {
      mockListDirectory.mockResolvedValue(requiresQueryResponse)
      const onConfirm = vi.fn()
      const { container, app, vm } = mount(
        { id: 'f', name: 'Owner', type: 'person', property: { limitSingleRecord: false } },
        ['u1', 'u2'],
        onConfirm,
        [{ id: 'u1', display: 'Alice Fake' }, { id: 'u2', display: 'Bob Fake' }],
      )
      vm.visible = true
      await flush()
      ;(container.querySelector('[data-test="person-picker-confirm"]') as HTMLButtonElement)?.click()
      expect(onConfirm).toHaveBeenCalledWith({
        userIds: ['u1', 'u2'],
        summaries: [{ id: 'u1', display: 'Alice Fake' }, { id: 'u2', display: 'Bob Fake' }],
      })
      app.unmount(); container.remove()
    })

    it('carries the 2c-S4 inactive cue through a confirm (a stored deactivated assignee is not laundered into "active")', async () => {
      mockListDirectory.mockResolvedValue(requiresQueryResponse)
      const onConfirm = vi.fn()
      const { container, app, vm } = mount(
        { id: 'f', name: 'Owner', type: 'person' },
        ['u_left'],
        onConfirm,
        [{ id: 'u_left', display: 'Carol Fake', inactive: true }],
      )
      vm.visible = true
      await flush()
      ;(container.querySelector('[data-test="person-picker-confirm"]') as HTMLButtonElement)?.click()
      expect(onConfirm).toHaveBeenCalledWith({
        userIds: ['u_left'],
        summaries: [{ id: 'u_left', display: 'Carol Fake', inactive: true }],
      })
      app.unmount(); container.remove()
    })

    it('an opener-supplied RAW-ID placeholder is not pinned — a later directory answer still upgrades it', async () => {
      // The opener may itself only know `{ id, display: id }` (never-hydrated cell). That must stay a
      // fallback, not a fact, or a searched-for name could never replace it.
      mockListDirectory.mockResolvedValue(directory)
      const onConfirm = vi.fn()
      const { container, app, vm } = mount(
        { id: 'f', name: 'Owner', type: 'person' },
        ['u1'],
        onConfirm,
        [{ id: 'u1', display: 'u1' }],
      )
      vm.visible = true
      await flush()
      ;(container.querySelector('[data-test="person-picker-confirm"]') as HTMLButtonElement)?.click()
      expect(onConfirm).toHaveBeenCalledWith({ userIds: ['u1'], summaries: [{ id: 'u1', display: 'Alice' }] })
      app.unmount(); container.remove()
    })

    it('an opener that passes nothing keeps the raw-id fallback (the 2c-S3 no-silent-drop invariant is untouched)', async () => {
      mockListDirectory.mockResolvedValue(requiresQueryResponse)
      const onConfirm = vi.fn()
      const { container, app, vm } = mount({ id: 'f', name: 'Owner', type: 'person' }, ['u_gone'], onConfirm)
      vm.visible = true
      await flush()
      ;(container.querySelector('[data-test="person-picker-confirm"]') as HTMLButtonElement)?.click()
      expect(onConfirm).toHaveBeenCalledWith({ userIds: ['u_gone'], summaries: [{ id: 'u_gone', display: 'u_gone' }] })
      app.unmount(); container.remove()
    })

    it('a stale summary for a person NO LONGER in the value is not resurrected (chips follow currentValue only)', async () => {
      mockListDirectory.mockResolvedValue(requiresQueryResponse)
      const onConfirm = vi.fn()
      const { container, app, vm } = mount(
        { id: 'f', name: 'Owner', type: 'person', property: { limitSingleRecord: false } },
        ['u1'],
        onConfirm,
        [{ id: 'u1', display: 'Alice Fake' }, { id: 'u_removed', display: 'Dave Fake' }],
      )
      vm.visible = true
      await flush()
      expect(container.textContent).not.toContain('Dave Fake')
      ;(container.querySelector('[data-test="person-picker-confirm"]') as HTMLButtonElement)?.click()
      expect(onConfirm).toHaveBeenCalledWith({ userIds: ['u1'], summaries: [{ id: 'u1', display: 'Alice Fake' }] })
      app.unmount(); container.remove()
    })
  })

})
