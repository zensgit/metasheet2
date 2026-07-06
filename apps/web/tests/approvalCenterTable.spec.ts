/**
 * UF-5 (ui-foundation-design-lock-20260706.md §6): ApprovalCenterTable.vue is the shared table
 * body ApprovalCenterView's four tabs (待我处理/我发起的/抄送我的/已完成) all render, replacing
 * four near-identical ~90-line `<el-table>` blocks. This spec exercises the component directly
 * (not through ApprovalCenterView) — column rendering from `rows`, event re-emission, the four
 * per-tab difference props (`showSelection` / `selectable` / `showWaitColumn` / `actions` slot),
 * and the empty state.
 *
 * Uses the same Element Plus registry-stub pattern as `approval-center.spec.ts` (ElTableColumn
 * children register their `#default="{ row }"` slot into a shared registry; ElTable then walks
 * `data` × registry to emit real per-row markup) so scoped-slot content is genuinely exercised
 * rather than just counting placeholder divs. `StatusTag` is left un-stubbed — it is
 * Element-Plus-free (see components/status/StatusTag.vue) and resolves via ApprovalCenterTable's
 * own local import regardless of what is globally registered.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createApp,
  defineComponent,
  h,
  inject,
  nextTick,
  provide,
  reactive,
  type App as VueApp,
  type Slot,
} from 'vue'
import type { UnifiedApprovalDTO } from '../src/types/approval'

type ColumnRegistryEntry = {
  key: string
  type?: string
  prop?: string
  label?: string
  defaultSlot?: Slot
}
type ColumnRegistry = {
  columns: ColumnRegistryEntry[]
  register: (entry: ColumnRegistryEntry) => void
}
const COLUMN_REGISTRY_KEY = Symbol('el-table-columns')

const ElTable = defineComponent({
  name: 'ElTable',
  props: {
    data: Array,
    loading: Boolean,
    size: String,
    stripe: Boolean,
    highlightCurrentRow: Boolean,
    maxHeight: [String, Number],
    rowKey: [String, Function],
  },
  emits: ['row-click', 'selection-change'],
  setup(props, { slots, emit }) {
    const registry = reactive<ColumnRegistry>({
      columns: [],
      register(entry) {
        registry.columns.push(entry)
      },
    })
    provide(COLUMN_REGISTRY_KEY, registry)
    return () => {
      const columnInstances = slots.default?.() ?? []
      const rows = (props.data as UnifiedApprovalDTO[] | undefined) ?? []
      if (rows.length === 0) {
        return h('div', { 'data-el-table': 'true' }, [
          h('div', { style: 'display:none' }, columnInstances),
          h('div', { 'data-el-table-empty': 'true' }, slots.empty?.()),
        ])
      }
      return h('div', { 'data-el-table': 'true' }, [
        h('div', { style: 'display:none' }, columnInstances),
        ...rows.map((row, i) =>
          h(
            'div',
            {
              'data-el-row': (row?.id as string | undefined) ?? String(i),
              key: (row?.id as string | undefined) ?? String(i),
              onClick: () => emit('row-click', row),
            },
            registry.columns.map((col) =>
              h(
                'div',
                { 'data-el-cell': col.type === 'selection' ? 'selection' : (col.prop || col.label || col.key) },
                // Real el-table auto-renders `row[prop]` for a column with a bare `prop` and no
                // scoped `#default` slot (e.g. `requestNo` below) — replicate that fallback.
                col.defaultSlot ? col.defaultSlot({ row }) : (col.prop ? String((row as any)[col.prop] ?? '') : null),
              ),
            ),
          ),
        ),
        h('button', {
          type: 'button',
          'data-testid': 'test-select-all-rows',
          onClick: () => emit('selection-change', rows),
        }, 'select-all'),
      ])
    }
  },
})

let columnSeq = 0
const ElTableColumn = defineComponent({
  name: 'ElTableColumn',
  props: {
    prop: String,
    label: String,
    width: [String, Number],
    minWidth: [String, Number],
    fixed: String,
    type: String,
    selectable: Function,
  },
  setup(props, { slots }) {
    const registry = inject<ColumnRegistry | null>(COLUMN_REGISTRY_KEY, null)
    if (registry) {
      registry.register({
        key: `col-${columnSeq++}`,
        type: props.type,
        prop: props.prop,
        label: props.label,
        defaultSlot: slots.default,
      })
    }
    return () => null
  },
})

const ElEmpty = defineComponent({
  name: 'ElEmpty',
  props: { description: String, imageSize: Number },
  render() {
    return h('div', { 'data-el-empty': 'true' }, this.description)
  },
})

const stubDirective = { mounted() {}, updated() {} }

async function flushUi(cycles = 3): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function buildRow(overrides: Partial<UnifiedApprovalDTO> = {}): UnifiedApprovalDTO {
  return {
    id: 'apv_1',
    sourceSystem: 'platform',
    externalApprovalId: null,
    workflowKey: null,
    businessKey: null,
    title: '出差报销',
    status: 'pending',
    requester: { name: '张三' } as any,
    subject: null,
    policy: null,
    currentStep: null,
    totalSteps: null,
    requestNo: 'AP-100001',
    createdAt: '2026-04-10T08:00:00Z',
    ...overrides,
  } as UnifiedApprovalDTO
}

describe('ApprovalCenterTable', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    columnSeq = 0
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  async function mountTable(
    props: Record<string, unknown>,
    slots: Record<string, (scope: any) => unknown> = {},
  ) {
    const { default: ApprovalCenterTable } = await import('../src/views/approval/ApprovalCenterTable.vue')
    const Host = defineComponent({
      setup() {
        return () => h(ApprovalCenterTable as any, props, slots)
      },
    })
    app = createApp(Host)
    app.component('ElTable', ElTable)
    app.component('ElTableColumn', ElTableColumn)
    app.component('ElEmpty', ElEmpty)
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
    return app
  }

  it('renders columns from rows (requestNo/title/requester/status/createdAt)', async () => {
    const rows = [buildRow()]
    await mountTable({
      rows,
      loading: false,
      emptyText: '暂无待处理审批',
      summaryLineFor: () => '',
    })

    const row = container!.querySelector('[data-el-row="apv_1"]')!
    expect(row.querySelector('[data-el-cell="requestNo"]')?.textContent).toContain('AP-100001')
    expect(row.querySelector('[data-el-cell="标题"]')?.textContent).toContain('出差报销')
    expect(row.querySelector('[data-el-cell="发起人"]')?.textContent).toContain('张三')
    expect(row.querySelector('[data-el-cell="发起时间"]')?.textContent?.trim().length).toBeGreaterThan(0)

    // StatusTag is real (Element-Plus-free) — asserts through its own data attributes.
    const statusTag = row.querySelector('[data-el-cell="状态"] .ms-status-tag')
    expect(statusTag?.getAttribute('data-domain')).toBe('approvalInstance')
    expect(statusTag?.getAttribute('data-status')).toBe('pending')

    // No selection column, no 已等待 column, no 操作 column by default.
    expect(row.querySelector('[data-el-cell="selection"]')).toBeNull()
    expect(row.querySelector('[data-el-cell="已等待"]')).toBeNull()
    expect(container!.querySelector('[data-el-cell="操作"]')).toBeNull()
  })

  it('renders the B2-01 row-summary line only when summaryLineFor returns non-empty', async () => {
    const rows = [buildRow()]
    await mountTable({
      rows,
      loading: false,
      emptyText: 'empty',
      summaryLineFor: (row: UnifiedApprovalDTO) => (row.id === 'apv_1' ? '请假类型：年假' : ''),
    })
    const summary = container!.querySelector('[data-el-cell="标题"] .approval-center__row-summary')
    expect(summary?.textContent?.trim()).toBe('请假类型：年假')
  })

  it('emits row-click with the clicked row', async () => {
    const rows = [buildRow(), buildRow({ id: 'apv_2', requestNo: 'AP-100002' })]
    let clicked: UnifiedApprovalDTO | null = null
    // Vue maps an `onRowClick` prop key to a listener for the `row-click` emit.
    await mountTable({
      rows,
      loading: false,
      emptyText: 'empty',
      summaryLineFor: () => '',
      onRowClick: (row: UnifiedApprovalDTO) => { clicked = row },
    })

    ;(container!.querySelector('[data-el-row="apv_2"]') as HTMLElement).click()
    await flushUi()
    expect(clicked).not.toBeNull()
    expect((clicked as unknown as UnifiedApprovalDTO).id).toBe('apv_2')
  })

  it('emits selection-change with the raw row set (unfiltered — caller applies its own predicate)', async () => {
    const rows = [buildRow(), buildRow({ id: 'apv_2' })]
    let selected: UnifiedApprovalDTO[] | null = null
    await mountTable({
      rows,
      loading: false,
      emptyText: 'empty',
      summaryLineFor: () => '',
      showSelection: true,
      selectable: (row: UnifiedApprovalDTO) => row.id === 'apv_1',
      onSelectionChange: (r: UnifiedApprovalDTO[]) => { selected = r },
    })

    ;(container!.querySelector('[data-testid="test-select-all-rows"]') as HTMLElement).click()
    await flushUi()
    expect(selected).not.toBeNull()
    expect((selected as unknown as UnifiedApprovalDTO[]).map((r) => r.id)).toEqual(['apv_1', 'apv_2'])
  })

  it('showSelection renders the selection column (pending-tab shape)', async () => {
    const rows = [buildRow()]
    await mountTable({
      rows,
      loading: false,
      emptyText: 'empty',
      summaryLineFor: () => '',
      showSelection: true,
      selectable: () => true,
    })
    expect(container!.querySelector('[data-el-cell="selection"]')).not.toBeNull()
  })

  it('showWaitColumn renders the 已等待 column with severity class + step progress (pending-tab shape)', async () => {
    const rows = [buildRow({
      createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      currentStep: 2,
      totalSteps: 3,
    })]
    await mountTable({
      rows,
      loading: false,
      emptyText: 'empty',
      summaryLineFor: () => '',
      showWaitColumn: true,
    })
    const cell = container!.querySelector('[data-el-cell="已等待"]')
    expect(cell?.textContent).toContain('8 天')
    expect(cell?.textContent).toContain('第 2/3 步')
    expect(cell?.querySelector('.approval-center__wait--urgent')).toBeTruthy()
  })

  it('the actions slot renders the 操作 column; omitting the slot omits the column (cc/completed-tab shape)', async () => {
    const rows = [buildRow()]
    await mountTable(
      { rows, loading: false, emptyText: 'empty', summaryLineFor: () => '' },
      { actions: ({ row }: { row: UnifiedApprovalDTO }) => h('button', { 'data-testid': `act-${row.id}` }, '通过') },
    )
    expect(container!.querySelector('[data-el-cell="操作"] [data-testid="act-apv_1"]')).not.toBeNull()

    if (app) app.unmount()
    container!.innerHTML = ''
    await mountTable({ rows, loading: false, emptyText: 'empty', summaryLineFor: () => '' })
    expect(container!.querySelector('[data-el-cell="操作"]')).toBeNull()
  })

  it('renders the empty state via el-empty with the caller-supplied emptyText', async () => {
    await mountTable({
      rows: [],
      loading: false,
      emptyText: '暂无我发起的审批',
      summaryLineFor: () => '',
    })
    const empty = container!.querySelector('[data-el-table-empty] [data-el-empty]')
    expect(empty?.textContent).toBe('暂无我发起的审批')
  })
})
