import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, inject, nextTick, provide, reactive, type App as VueApp, type Slot } from 'vue'
import type { DelegationRecord } from '../src/approvals/delegations'
import { useLocale } from '../src/composables/useLocale'

// B2-05 — MyDelegationView (self-service 我的委托) MOUNTED-component coverage. Neither
// myDelegationForm.spec.ts nor myDelegationRoute.spec.ts (the only pre-existing specs naming this
// view) actually mount it — they test the pure form-validation helpers and the router source text
// respectively. This is the first mounted harness for this view, mirroring
// approvalDelegationView.spec.ts (the admin 委托设置 counterpart) since B2-05 changes both views
// identically (shared DelegationRecord shape + shared delegationStatus helper).

const listOwnDelegationsSpy = vi.fn()
const disableOwnDelegationSpy = vi.fn().mockResolvedValue(undefined)
const createOwnDelegationSpy = vi.fn()
vi.mock('../src/approvals/delegations', async () => {
  const actual = await vi.importActual<typeof import('../src/approvals/delegations')>('../src/approvals/delegations')
  return {
    ...actual,
    listOwnDelegations: () => listOwnDelegationsSpy(),
    disableOwnDelegation: (id: string) => disableOwnDelegationSpy(id),
    createOwnDelegation: (payload: unknown) => createOwnDelegationSpy(payload),
  }
})

const confirmSpy = vi.fn().mockResolvedValue(undefined)
const messageErrorSpy = vi.fn()
vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), warning: vi.fn(), error: (...a: unknown[]) => messageErrorSpy(...a) },
  ElMessageBox: { confirm: (...a: unknown[]) => confirmSpy(...a) },
}))

// B3-04 D-2 — the 新建委托 dialog's delegatee field now uses the real ApprovalUserPicker
// (participant directory), replacing the manual free-text id input. `vi.importActual` keeps every
// other export (listDelegations, createDelegation, ...) real.
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
const COLUMN_REGISTRY_KEY = Symbol('my-delegation-table-columns')
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
    delegatorUserId: '__me__',
    delegateeUserId: 'bob',
    scope: 'all',
    scopeTemplateId: null,
    startAt: new Date(now - HOUR).toISOString(),
    endAt: new Date(now + HOUR).toISOString(),
    active: true,
    ...overrides,
  }
}

describe('MyDelegationView (self-service 我的委托) — B2-05 status tag + disable confirm', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    // UF-3: the status cell is now locale-aware (<StatusTag domain="delegation">, via
    // useLocale()/isZh) rather than the previous hardcoded-Chinese-always
    // `delegationDisplayStatus().status` literal. This suite's fixtures/assertions are Chinese,
    // so pin the locale explicitly rather than relying on jsdom's default `navigator.language`.
    useLocale().setLocale('zh-CN')

    listOwnDelegationsSpy.mockReset()
    disableOwnDelegationSpy.mockReset().mockResolvedValue(undefined)
    createOwnDelegationSpy.mockReset()
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
    listOwnDelegationsSpy.mockResolvedValue(rows)
    const { default: MyDelegationView } = await import('../src/views/approval/MyDelegationView.vue')
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(MyDelegationView)
    app.component('ElTable', ElTable)
    app.component('ElTableColumn', ElTableColumn)
    app.component('ElTag', ElTag)
    app.component('ElButton', ElButton)
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

  it('asks for confirmation before disabling; confirming calls disableOwnDelegation and reloads', async () => {
    await mountView([fixtureRow({ id: 'd-1', active: true })])
    listOwnDelegationsSpy.mockResolvedValue([]) // the reload after disable

    const disableButton = container!.querySelector('[data-testid="my-delegation-disable"]') as HTMLButtonElement
    expect(disableButton).not.toBeNull()
    disableButton.click()
    await flushUi()

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy.mock.calls[0]?.[0]).toContain('停用后该委托立即失效，进行中的转交不受影响')
    expect(disableOwnDelegationSpy).toHaveBeenCalledWith('d-1')
    expect(listOwnDelegationsSpy).toHaveBeenCalledTimes(2) // initial load + post-disable reload
  })

  it('cancelling the confirm dialog calls NO api (disableOwnDelegation never runs)', async () => {
    confirmSpy.mockRejectedValue(new Error('cancel'))
    await mountView([fixtureRow({ id: 'd-1', active: true })])

    const disableButton = container!.querySelector('[data-testid="my-delegation-disable"]') as HTMLButtonElement
    disableButton.click()
    await flushUi()

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(disableOwnDelegationSpy).not.toHaveBeenCalled()
    expect(listOwnDelegationsSpy).toHaveBeenCalledTimes(1) // no reload — disable never ran
  })

  // ---------------------------------------------------------------------------
  // B3-04 D-2 — the 新建委托 dialog's delegatee field now uses the real ApprovalUserPicker
  // instead of a manual free-text id input.
  // ---------------------------------------------------------------------------
  it('the 新建委托 dialog renders the real ApprovalUserPicker for the delegatee field', async () => {
    await mountView([])

    const newButton = container!.querySelector('[data-testid="my-delegation-new"]') as HTMLButtonElement
    newButton.click()
    await flushUi()

    expect(container!.querySelector('[data-testid="approval-user-picker"]')).toBeTruthy()
  })

  it('static tripwire: the view source contains no hardcoded fake-people literals', () => {
    const src = readFileSync(join(__dirname, '../src/views/approval/MyDelegationView.vue'), 'utf8')
    for (const fakeName of ['张三', '李四', '王五', '赵六']) {
      expect(src, `should not contain fake fixture name "${fakeName}"`).not.toContain(fakeName)
    }
  })
})
