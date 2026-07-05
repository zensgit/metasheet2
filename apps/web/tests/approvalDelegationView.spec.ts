import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, inject, nextTick, provide, reactive, type App as VueApp, type Slot } from 'vue'
import type { DelegationRecord } from '../src/approvals/delegations'

// B2-05 — DelegationSettingsView (admin 委托设置) MOUNTED-component coverage. Neither
// approvalDelegationForm.spec.ts nor approvalDelegationRoute.spec.ts (the only pre-existing specs
// naming this view) actually mount it — they test the pure form-validation helpers and the router
// source text respectively. This is the first mounted harness for this view, added because B2-05
// is a rendering + confirm-dialog behavior change (status tag per state, confirm-before-disable),
// which needs an actual mount to assert on.
//
// ElTable/ElTableColumn use the same "column registry via provide/inject" stub proven in
// approvalMetricsTopnReport.spec.ts, since the status/操作 columns render via scoped slots the
// simpler count-only ElTable stub (approvalMetricsView.spec.ts's style) can't exercise.

const canManageTemplates = { value: true }
vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({ canManageTemplates }),
}))

const listDelegationsSpy = vi.fn()
const disableDelegationSpy = vi.fn().mockResolvedValue(undefined)
const createDelegationSpy = vi.fn()
vi.mock('../src/approvals/delegations', async () => {
  const actual = await vi.importActual<typeof import('../src/approvals/delegations')>('../src/approvals/delegations')
  return {
    ...actual,
    listDelegations: (opts?: unknown) => listDelegationsSpy(opts),
    disableDelegation: (id: string) => disableDelegationSpy(id),
    createDelegation: (payload: unknown) => createDelegationSpy(payload),
  }
})

const confirmSpy = vi.fn().mockResolvedValue(undefined)
const messageErrorSpy = vi.fn()
vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), warning: vi.fn(), error: (...a: unknown[]) => messageErrorSpy(...a) },
  ElMessageBox: { confirm: (...a: unknown[]) => confirmSpy(...a) },
}))

type ColumnRegistryEntry = { key: string; prop?: string; label?: string; defaultSlot?: Slot }
type ColumnRegistry = { columns: ColumnRegistryEntry[]; register: (entry: ColumnRegistryEntry) => void }
const COLUMN_REGISTRY_KEY = Symbol('delegation-table-columns')
let columnSeq = 0

const ElTable = defineComponent({
  name: 'ElTable',
  props: { data: { type: Array, default: () => [] }, emptyText: String },
  setup(props, { slots }) {
    const registry = reactive<ColumnRegistry>({ columns: [], register(entry) { registry.columns.push(entry) } })
    provide(COLUMN_REGISTRY_KEY, registry)
    return () => {
      const columnInstances = slots.default?.() ?? []
      const rows = (props.data as DelegationRecord[] | undefined) ?? []
      return h('div', { 'data-el-table': 'true' }, [
        h('div', { style: 'display:none' }, columnInstances),
        ...rows.map((row, index) =>
          h('div', { 'data-el-row': String(index) },
            registry.columns.map((column) =>
              h('div', { 'data-el-cell': column.prop || column.label || column.key },
                column.defaultSlot ? column.defaultSlot({ row }) : String((row as never)[column.prop ?? ''] ?? ''),
              ),
            ),
          ),
        ),
      ])
    }
  },
})

const ElTableColumn = defineComponent({
  name: 'ElTableColumn',
  props: { prop: String, label: String, width: [String, Number] },
  setup(props, { slots }) {
    const registry = inject<ColumnRegistry | null>(COLUMN_REGISTRY_KEY, null)
    if (registry) registry.register({ key: `col-${columnSeq++}`, prop: props.prop, label: props.label, defaultSlot: slots.default })
    return () => null
  },
})

const ElTag = defineComponent({
  name: 'ElTag',
  props: { type: String, size: String },
  render() {
    return h('span', { 'data-el-tag-type': this.type || 'default' }, this.$slots.default?.())
  },
})

const ElButton = defineComponent({
  name: 'ElButton',
  props: { type: String, text: Boolean, size: String, disabled: Boolean, loading: Boolean },
  emits: ['click'],
  render() {
    return h('button', {
      type: 'button',
      disabled: this.disabled || this.loading,
      'data-testid': (this.$attrs as any)?.['data-testid'],
      onClick: (e: Event) => this.$emit('click', e),
    }, this.$slots.default?.())
  },
})

const ElSwitch = defineComponent({
  name: 'ElSwitch',
  props: { modelValue: Boolean },
  emits: ['update:modelValue', 'change'],
  render() {
    return h('input', {
      type: 'checkbox',
      'data-testid': (this.$attrs as any)?.['data-testid'],
      checked: this.modelValue,
      onChange: (e: Event) => {
        const checked = (e.target as HTMLInputElement).checked
        this.$emit('update:modelValue', checked)
        this.$emit('change', checked)
      },
    })
  },
})

const ElAlert = defineComponent({
  name: 'ElAlert',
  props: { title: String },
  render() { return h('div', { 'data-el-alert': 'true' }, this.title) },
})

// The 新建委托 dialog's contents never render in these tests (dialogOpen stays false — see
// ElDialog below), but Vue's compiled render function resolves EVERY tag referenced in the
// template on each pass regardless of whether that branch/slot actually runs, so these still need
// registering to avoid "Failed to resolve component" console noise. Purely cosmetic passthroughs.
function passthrough(name: string, tag = 'div') {
  return defineComponent({
    name,
    render() { return h(tag, {}, this.$slots.default?.()) },
  })
}
const ElForm = passthrough('ElForm', 'form')
const ElFormItem = passthrough('ElFormItem', 'label')
const ElInput = passthrough('ElInput', 'input')
const ElSelect = passthrough('ElSelect', 'select')
const ElOption = passthrough('ElOption', 'option')
const ElDatePicker = passthrough('ElDatePicker', 'input')

// Visibility-gated, matching the real component: content only renders while open (the 新建委托
// dialog is never opened in these tests, so its inner ElForm/ElInput/etc. never need stubs).
const ElDialog = defineComponent({
  name: 'ElDialog',
  props: { modelValue: Boolean, title: String, width: String },
  emits: ['update:modelValue'],
  render() {
    if (!this.modelValue) return null
    return h('div', { 'data-el-dialog': 'true' }, [this.$slots.default?.(), this.$slots.footer?.()])
  },
})

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const HOUR = 60 * 60 * 1000
function fixtureRow(overrides: Partial<DelegationRecord> = {}): DelegationRecord {
  const now = Date.now()
  return {
    id: 'd-1',
    delegatorUserId: 'alice',
    delegateeUserId: 'bob',
    scope: 'all',
    scopeTemplateId: null,
    startAt: new Date(now - HOUR).toISOString(),
    endAt: new Date(now + HOUR).toISOString(),
    active: true,
    ...overrides,
  }
}

describe('DelegationSettingsView (admin 委托设置) — B2-05 status tag + disable confirm', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    canManageTemplates.value = true
    listDelegationsSpy.mockReset()
    disableDelegationSpy.mockReset().mockResolvedValue(undefined)
    createDelegationSpy.mockReset()
    confirmSpy.mockReset().mockResolvedValue(undefined)
    messageErrorSpy.mockReset()
    columnSeq = 0
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
  })

  async function mountView(rows: DelegationRecord[]) {
    listDelegationsSpy.mockResolvedValue(rows)
    const { default: DelegationSettingsView } = await import('../src/views/approval/DelegationSettingsView.vue')
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(DelegationSettingsView)
    app.component('ElTable', ElTable)
    app.component('ElTableColumn', ElTableColumn)
    app.component('ElTag', ElTag)
    app.component('ElButton', ElButton)
    app.component('ElSwitch', ElSwitch)
    app.component('ElAlert', ElAlert)
    app.component('ElDialog', ElDialog)
    app.component('ElForm', ElForm)
    app.component('ElFormItem', ElFormItem)
    app.component('ElInput', ElInput)
    app.component('ElSelect', ElSelect)
    app.component('ElOption', ElOption)
    app.component('ElDatePicker', ElDatePicker)
    app.directive('loading', {})
    app.mount(container)
    await flushUi()
  }

  function statusCell(rowIndex: number): HTMLElement {
    return container!.querySelector(`[data-el-row="${rowIndex}"] [data-el-cell="状态"]`) as HTMLElement
  }

  it('renders the correct status tag TYPE + label for 未开始 / 生效中 / 已过期 / 已停用', async () => {
    const rows = [
      fixtureRow({ id: 'not-started', startAt: new Date(Date.now() + HOUR).toISOString(), endAt: new Date(Date.now() + 2 * HOUR).toISOString() }),
      fixtureRow({ id: 'active', startAt: new Date(Date.now() - HOUR).toISOString(), endAt: new Date(Date.now() + 200 * HOUR).toISOString() }),
      fixtureRow({ id: 'expired', startAt: new Date(Date.now() - 2 * HOUR).toISOString(), endAt: new Date(Date.now() - HOUR).toISOString() }),
      fixtureRow({ id: 'disabled', active: false }),
    ]
    await mountView(rows)

    const expectations: Array<[number, string, string]> = [
      [0, '未开始', 'info'],
      [1, '生效中', 'success'],
      [2, '已过期', 'warning'],
      [3, '已停用', 'danger'],
    ]
    for (const [index, label, tagType] of expectations) {
      const cell = statusCell(index)
      expect(cell.textContent, `row ${index} label`).toContain(label)
      expect(cell.querySelector('[data-el-tag-type]')?.getAttribute('data-el-tag-type'), `row ${index} tag type`).toBe(tagType)
    }
  })

  it('shows the 即将到期 hint only for a 生效中 row expiring within 72h, not for other states', async () => {
    const rows = [
      fixtureRow({ id: 'expiring-soon', startAt: new Date(Date.now() - HOUR).toISOString(), endAt: new Date(Date.now() + HOUR).toISOString() }),
      fixtureRow({ id: 'not-expiring', startAt: new Date(Date.now() - HOUR).toISOString(), endAt: new Date(Date.now() + 200 * HOUR).toISOString() }),
      fixtureRow({ id: 'disabled-but-in-window', active: false }),
    ]
    await mountView(rows)

    expect(statusCell(0).textContent).toContain('即将到期')
    expect(statusCell(1).textContent).not.toContain('即将到期')
    expect(statusCell(2).textContent).not.toContain('即将到期')
  })

  it('asks for confirmation before disabling; confirming calls disableDelegation and reloads', async () => {
    await mountView([fixtureRow({ id: 'd-1', active: true })])
    listDelegationsSpy.mockResolvedValue([]) // the reload after disable

    const disableButton = container!.querySelector('[data-testid="delegation-disable"]') as HTMLButtonElement
    expect(disableButton).not.toBeNull()
    disableButton.click()
    await flushUi()

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy.mock.calls[0]?.[0]).toContain('停用后该委托立即失效，进行中的转交不受影响')
    expect(disableDelegationSpy).toHaveBeenCalledWith('d-1')
    expect(listDelegationsSpy).toHaveBeenCalledTimes(2) // initial load + post-disable reload
  })

  it('cancelling the confirm dialog calls NO api (disableDelegation never runs)', async () => {
    confirmSpy.mockRejectedValue(new Error('cancel'))
    await mountView([fixtureRow({ id: 'd-1', active: true })])

    const disableButton = container!.querySelector('[data-testid="delegation-disable"]') as HTMLButtonElement
    disableButton.click()
    await flushUi()

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(disableDelegationSpy).not.toHaveBeenCalled()
    expect(listDelegationsSpy).toHaveBeenCalledTimes(1) // no reload — disable never ran
  })
})
