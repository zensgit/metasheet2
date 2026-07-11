import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, inject, nextTick, provide, reactive, type App as VueApp, type Slot } from 'vue'
import type { DelegationRecord } from '../src/approvals/delegations'
import { useLocale } from '../src/composables/useLocale'

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

// B3-04-tail — the 新建委托 dialog's 委托人/被委托人 fields now use the real ApprovalUserPicker
// (participant directory), replacing the manual free-text id inputs. Mirrors the mock
// myDelegationView.spec.ts uses for its (delegatee-only) picker. `vi.importActual` keeps every
// other export of `../src/approvals/api` real.
const searchApprovalDirectoryUsersSpy = vi.fn().mockResolvedValue([])
vi.mock('../src/approvals/api', async () => {
  const actual = await vi.importActual<typeof import('../src/approvals/api')>('../src/approvals/api')
  return {
    ...actual,
    searchApprovalDirectoryUsers: (...args: unknown[]) => searchApprovalDirectoryUsersSpy(...args),
  }
})

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

// B3-04-tail — unlike the other dialog fields (never interacted with pre-tail, since the dialog
// itself was never opened by this spec), the new ApprovalUserPicker call sites need a REAL v-model
// round trip to prove "selection writes the id into the form model" end-to-end, so ElSelect/
// ElOption/ElDatePicker are upgraded here from inert passthroughs to minimal interactive stubs
// (native <select>/<option>/<input> with actual value + change/input wiring). This also makes the
// pre-existing 范围 (scope) select interactive, which is a strict capability superset — no
// existing assertion in this file exercises it, so behavior for them is unchanged.
const ElSelect = defineComponent({
  name: 'ElSelect',
  props: { modelValue: { type: [String, Number], default: undefined } },
  emits: ['update:modelValue', 'visible-change'],
  render() {
    const attrs = this.$attrs as Record<string, unknown>
    return h('select', {
      'data-testid': attrs['data-testid'],
      value: this.modelValue ?? '',
      onChange: (e: Event) => {
        const v = (e.target as HTMLSelectElement).value
        this.$emit('update:modelValue', v || null)
      },
    }, this.$slots.default?.())
  },
})
const ElOption = defineComponent({
  name: 'ElOption',
  props: { label: String, value: { type: [String, Number], default: undefined } },
  render() {
    return h('option', { value: this.value }, this.label)
  },
})
const ElDatePicker = defineComponent({
  name: 'ElDatePicker',
  props: { modelValue: String },
  emits: ['update:modelValue'],
  render() {
    return h('input', {
      value: this.modelValue ?? '',
      onInput: (e: Event) => this.$emit('update:modelValue', (e.target as HTMLInputElement).value),
    })
  },
})

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
    // UF-3: the status cell is now locale-aware (<StatusTag domain="delegation">, via
    // useLocale()/isZh) rather than the previous hardcoded-Chinese-always
    // `delegationDisplayStatus().status` literal. This suite's fixtures/assertions are Chinese,
    // so pin the locale explicitly rather than relying on jsdom's default `navigator.language`.
    useLocale().setLocale('zh-CN')

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
      // UF-3: the status cell now renders <StatusTag domain="delegation"> (not `<el-tag>`) —
      // select its tone by `data-tone` instead of the ElTag test stub's `data-el-tag-type`.
      expect(cell.querySelector('[data-tone]')?.getAttribute('data-tone'), `row ${index} tag type`).toBe(tagType)
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

  // ---------------------------------------------------------------------------
  // B3-04-tail — the 新建委托 dialog's 委托人/被委托人 fields now use the real ApprovalUserPicker
  // instead of manual free-text id inputs (mirrors MyDelegationView's B3-04 D-2 delegatee field;
  // this admin view additionally makes the delegator field pickable, since an admin may
  // legitimately pick ANY user as delegator).
  // ---------------------------------------------------------------------------
  it('the 新建委托 dialog renders TWO distinct real ApprovalUserPickers (delegator + delegatee), not manual id inputs', async () => {
    await mountView([])

    const newButton = container!.querySelector('[data-testid="delegation-new"]') as HTMLButtonElement
    newButton.click()
    await flushUi()

    const delegator = container!.querySelector('[data-testid="delegation-delegator"]')
    const delegatee = container!.querySelector('[data-testid="delegation-delegatee"]')
    expect(delegator).not.toBeNull()
    expect(delegatee).not.toBeNull()
    expect(delegator).not.toBe(delegatee)
    // The old manual inputs were plain <input> elements; the picker's root is the (stubbed)
    // <select> — this distinguishes "picker swapped in" from "same testid, still a text input".
    expect(delegator!.tagName).toBe('SELECT')
    expect(delegatee!.tagName).toBe('SELECT')
  })

  it('picking a delegator/delegatee writes the id into the form model; submit sends the unchanged CreateDelegationPayload shape (ids, not names)', async () => {
    const users = [
      { id: 'alice-id', name: 'Alice', email: 'alice@example.com' },
      { id: 'bob-id', name: 'Bob', email: 'bob@example.com' },
    ]
    searchApprovalDirectoryUsersSpy.mockResolvedValue(users)
    await mountView([])

    const newButton = container!.querySelector('[data-testid="delegation-new"]') as HTMLButtonElement
    newButton.click()
    await flushUi()

    const delegatorSelect = container!.querySelector('[data-testid="delegation-delegator"]') as HTMLSelectElement
    const delegateeSelect = container!.querySelector('[data-testid="delegation-delegatee"]') as HTMLSelectElement

    delegatorSelect.value = 'alice-id'
    delegatorSelect.dispatchEvent(new Event('change'))
    await flushUi()

    delegateeSelect.value = 'bob-id'
    delegateeSelect.dispatchEvent(new Event('change'))
    await flushUi()

    // Scope stays the default ('all'), so only the start/end date pickers remain to fill — they
    // are the only plain <input> elements left inside the dialog (the pickers render as <select>).
    const dateInputs = container!.querySelectorAll('[data-el-dialog] input') as NodeListOf<HTMLInputElement>
    expect(dateInputs.length).toBe(2)
    const startAt = '2026-07-01T09:00'
    const endAt = '2026-07-02T09:00'
    dateInputs[0].value = startAt
    dateInputs[0].dispatchEvent(new Event('input'))
    dateInputs[1].value = endAt
    dateInputs[1].dispatchEvent(new Event('input'))
    await flushUi()

    const submitButton = container!.querySelector('[data-testid="delegation-submit"]') as HTMLButtonElement
    submitButton.click()
    await flushUi()

    expect(createDelegationSpy).toHaveBeenCalledTimes(1)
    expect(createDelegationSpy).toHaveBeenCalledWith({
      delegatorUserId: 'alice-id',
      delegateeUserId: 'bob-id',
      scope: 'all',
      scopeTemplateId: null,
      startAt: new Date(startAt).toISOString(),
      endAt: new Date(endAt).toISOString(),
    })
  })
})
