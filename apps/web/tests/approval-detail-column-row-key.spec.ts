/* eslint-disable vue/one-component-per-file, vue/require-default-prop */
/**
 * Owner-reported live authoring bug (2026-08-24), reproduced against the REAL
 * `TemplateAuthoringView.vue` + `ApprovalFormInlineEditor.vue` (明细/detail sub-field editor),
 * not a re-implementation of either.
 *
 * TWO defects, found in the same read of `apps/web/src/approvals/components/
 * ApprovalFormInlineEditor.vue` (the sub-field `<el-table :data="field.detailColumns">`, no
 * `row-key`) and `apps/web/src/views/approval/TemplateAuthoringView.vue` (`addDetailColumn` /
 * `removeDetailColumn`, ~:3624-3630):
 *
 *  1. Missing `row-key`. Element Plus keys each `<tr>`/`<td>` by the row's POSITIONAL INDEX when
 *     no `row-key` is supplied (`element-plus` table-body `render-helper.js` `getKeyOfRow`).
 *     `addDetailColumn`/`removeDetailColumn` REPLACE `field.detailColumns` wholesale, so deleting
 *     a row shifts every later row's screen position. If the author is focused mid-edit on a
 *     LATER select sub-field's 选项 textarea and deletes an EARLIER row, Vue's keyed
 *     reconciliation reuses that SAME focused DOM node in place for whichever row now lands at
 *     that position (same index-key, same input-vs-span `v-if` branch — proven here by giving
 *     that landing row `type: 'select'` too, so the branch does not toggle away from `<input>`
 *     and destroy/recreate it). The author keeps typing into the SAME on-screen box, but it now
 *     writes a DIFFERENT sub-field's `optionsText`; verified independently against real Vue
 *     reactivity (no Element Plus stub) and against `element-plus@2.11.8`'s own
 *     `getKeyOfRow`/`rowRender` source before writing this file.
 *  2. Collision-prone id generation. `addDetailColumn` calls
 *     `createEmptyDetailColumnDraft(field.detailColumns.length + 1)`, which assumes ids stay
 *     densely packed `col_1..col_N`. Deleting a MIDDLE column then adding another recomputes an
 *     id an existing SURVIVING column already holds (`[col_1, col_2, col_3]` -> delete `col_2` ->
 *     `[col_1, col_3]` (length 2) -> `length + 1` = "col_3", already taken) -> save-blocking
 *     `子字段 id 不能重复`.
 *
 * Both fixes stay inside the "protected baseline" the F1 design lock froze
 * (`approval-form-builder-parity-delta-design-20260811.md` §"Protected baseline, not an F1 edit
 * target", pinned byte-for-byte by `approval-form-authoring-adapter.test.ts`):
 * `createEmptyDetailColumnDraft`'s own single-argument output, and the literal
 * `createEmptyDetailColumnDraft(field.detailColumns.length + 1)` call-site expression, are left
 * untouched — the fix only patches the CONSTRUCTED draft object before it is pushed.
 *
 * Mount scaffold: copied from `approval-form-inline-editor-extract.spec.ts` (router/permissions/
 * featureFlags/api/element-plus mocks, the same stub component set) with ONE upgrade —
 * `ElTable`/`ElTableColumn` here implement REAL Element Plus row/cell key derivation (`row-key`
 * prop, string or function, else positional index) instead of that file's simpler always-$index
 * stub, because that is the exact mechanism defect 1 lives in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, inject, nextTick, provide, ref, type App as VueApp, type Slot } from 'vue'
import TemplateAuthoringView from '../src/views/approval/TemplateAuthoringView.vue'
import type { ApprovalTemplateDetailDTO } from '../src/types/approval'

const pushSpy = vi.fn().mockResolvedValue(undefined)
const replaceSpy = vi.fn().mockResolvedValue(undefined)
let routeParams: Record<string, string> = {}

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({
      push: pushSpy,
      replace: replaceSpy,
      back: vi.fn(),
    }),
    useRoute: () => ({
      params: routeParams,
      query: {},
      path: routeParams.id ? `/approval-templates/${routeParams.id}/edit` : '/approval-templates/new',
      meta: {},
    }),
  }
})

const canManageTemplates = ref(true)
vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({
    canManageTemplates,
    canRead: ref(true),
    canWrite: ref(true),
    canAct: ref(true),
  }),
}))

const approvalCanvasV2 = ref(false)
vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    features: computed(() => ({ approvalCanvasV2: approvalCanvasV2.value })),
  }),
}))

const createTemplateSpy = vi.fn()
const updateTemplateSpy = vi.fn()
const getTemplateSpy = vi.fn()

vi.mock('../src/approvals/api', () => ({
  createTemplate: (payload: unknown) => createTemplateSpy(payload),
  updateTemplate: (id: string, payload: unknown) => updateTemplateSpy(id, payload),
  publishTemplate: vi.fn(),
  getTemplate: (id: string) => getTemplateSpy(id),
  dryRunApprovalConditionFormula: vi.fn(),
}))

// `vi.hoisted` so this fn exists before the (also hoisted) `vi.mock` factory below runs,
// regardless of module-resolution order (a plain top-level `const` here raced the hoisted
// factory and hit a TDZ error against 'element-plus' specifically, unlike the sibling mocks
// above whose referenced consts happened to resolve later).
const { elMessageError } = vi.hoisted(() => ({ elMessageError: vi.fn() }))
vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), warning: vi.fn(), error: elMessageError },
  ElMessageBox: { confirm: vi.fn().mockResolvedValue(undefined) },
}))

const listBasesSpy = vi.fn()
const listSheetsSpy = vi.fn()
vi.mock('../src/multitable/api/client', () => ({
  multitableClient: {
    listBases: (...args: unknown[]) => listBasesSpy(...args),
    listSheets: (...args: unknown[]) => listSheetsSpy(...args),
  },
}))

const ElButton = defineComponent({
  name: 'ElButton',
  props: { disabled: Boolean, loading: Boolean, type: String, text: Boolean, link: Boolean, size: String },
  emits: ['click'],
  render() {
    return h('button', {
      type: 'button',
      disabled: this.disabled || this.loading,
      'data-testid': (this.$attrs as any)?.['data-testid'],
      onClick: (event: Event) => this.$emit('click', event),
    }, this.$slots.default?.())
  },
})

const ElInput = defineComponent({
  name: 'ElInput',
  props: { modelValue: [String, Number], disabled: Boolean, type: String, rows: Number, placeholder: String, size: String },
  emits: ['update:modelValue'],
  render() {
    return h('input', {
      value: this.modelValue ?? '',
      disabled: this.disabled,
      'data-testid': (this.$attrs as any)?.['data-testid'],
      onInput: (event: Event) => this.$emit('update:modelValue', (event.target as HTMLInputElement).value),
    })
  },
})

const ElSelect = defineComponent({
  name: 'ElSelect',
  props: { modelValue: [String, Array], disabled: Boolean },
  emits: ['update:modelValue', 'change', 'visible-change'],
  render() {
    return h('select', {
      value: this.modelValue ?? '',
      disabled: this.disabled,
      'data-testid': (this.$attrs as any)?.['data-testid'],
      onChange: (event: Event) => {
        const value = (event.target as HTMLSelectElement).value
        this.$emit('update:modelValue', value)
        this.$emit('change', value)
      },
    }, this.$slots.default?.())
  },
})

const ElOption = defineComponent({
  name: 'ElOption',
  props: { label: String, value: String },
  render() {
    return h('option', { value: this.value }, this.label)
  },
})

const ElCheckbox = defineComponent({
  name: 'ElCheckbox',
  inheritAttrs: false,
  props: { modelValue: Boolean, disabled: Boolean },
  emits: ['update:modelValue'],
  render() {
    return h('label', [
      h('input', {
        type: 'checkbox',
        checked: this.modelValue,
        disabled: this.disabled,
        onChange: (event: Event) => this.$emit('update:modelValue', (event.target as HTMLInputElement).checked),
      }),
      this.$slots.default?.(),
    ])
  },
})

// ---------------------------------------------------------------------------------------------
// ElTable / ElTableColumn — the ONE upgrade over the sibling F0 extraction spec's stub. Faithful
// to element-plus@2.11.8's real `getKeyOfRow` (components/table/src/table-body/render-helper.js):
// `row-key` (function or string prop path) if supplied, else the row's positional index. Each
// column independently iterates the shared row list (mirroring how `<el-table-column>` actually
// renders — one `renderCell` per row, per column) and keys its own per-row wrapper div with that
// SAME derivation, so Vue's keyed reconciliation decides whether to move a DOM node by identity
// (row-key present) or reuse it by position (row-key absent) exactly like the real component.
// ---------------------------------------------------------------------------------------------
type RowKeyFn = (row: any, index: number) => string | number
const TABLE_CONTEXT_KEY = Symbol('el-table-context-stub')
interface TableContext {
  rows: () => any[]
  keyOf: RowKeyFn
}

const ElTable = defineComponent({
  name: 'ElTable',
  props: { data: { type: Array, default: () => [] }, rowKey: [String, Function] },
  setup(props, { slots, attrs }) {
    const keyOf: RowKeyFn = (row, index) => {
      const rk = props.rowKey as unknown
      if (typeof rk === 'function') return (rk as (row: any) => string | number)(row)
      if (typeof rk === 'string' && rk) return (row as Record<string, unknown>)[rk] as string
      // FAITHFUL to real Element Plus: absent row-key -> positional index key (getKeyOfRow).
      return index
    }
    provide<TableContext>(TABLE_CONTEXT_KEY, { rows: () => (props.data ?? []) as any[], keyOf })
    return () => h('div', { 'data-testid': (attrs as any)?.['data-testid'] }, slots.default?.())
  },
})

const ElTableColumn = defineComponent({
  name: 'ElTableColumn',
  props: { label: String },
  setup(props, { slots }) {
    const ctx = inject<TableContext>(TABLE_CONTEXT_KEY)!
    return () => h(
      'div',
      { 'data-el-column': props.label },
      ctx.rows().map((row, index) => {
        const key = ctx.keyOf(row, index)
        return h(
          'div',
          { key, 'data-el-row-key': String(key), 'data-el-row-index': String(index) },
          (slots.default as Slot | undefined)?.({ row, $index: index }),
        )
      }),
    )
  },
})

const passthrough = (name: string, tag = 'div') => defineComponent({
  name,
  render() {
    return h(tag, { 'data-testid': (this.$attrs as any)?.['data-testid'] }, this.$slots.default?.())
  },
})

const ElAlert = defineComponent({
  name: 'ElAlert',
  props: { title: String, description: String },
  render() {
    return h('div', { 'data-testid': (this.$attrs as any)?.['data-testid'] }, [
      h('strong', this.title),
      this.description ? h('p', this.description) : null,
      this.$slots.default?.(),
    ])
  },
})

const ElDialog = defineComponent({
  name: 'ElDialog',
  props: { modelValue: Boolean, title: String, width: String },
  emits: ['update:modelValue'],
  render() {
    if (!this.modelValue) return null
    return h('div', { 'data-testid': (this.$attrs as any)?.['data-testid'] }, [this.$slots.default?.(), this.$slots.footer?.()])
  },
})

const ElCard = defineComponent({
  name: 'ElCard',
  render() {
    return h('section', { 'data-testid': (this.$attrs as any)?.['data-testid'] }, [
      this.$slots.header?.(),
      this.$slots.default?.(),
    ])
  },
})

function installStubs(app: VueApp<Element>) {
  app.directive('loading', {})
  app.component('ElButton', ElButton)
  app.component('ElInput', ElInput)
  app.component('ElInputNumber', passthrough('ElInputNumber', 'input'))
  app.component('ElSelect', ElSelect)
  app.component('ElOption', ElOption)
  app.component('ElCheckbox', ElCheckbox)
  app.component('ElAlert', ElAlert)
  app.component('ElDialog', ElDialog)
  app.component('ElTable', ElTable)
  app.component('ElTableColumn', ElTableColumn)
  app.component('ElCard', ElCard)
  app.component('ElForm', passthrough('ElForm', 'form'))
  app.component('ElFormItem', passthrough('ElFormItem', 'label'))
  app.component('ElIcon', passthrough('ElIcon', 'span'))
  app.component('ElCollapse', passthrough('ElCollapse'))
  app.component('ElCollapseItem', passthrough('ElCollapseItem'))
}

function buildTemplate(overrides: Partial<ApprovalTemplateDetailDTO> = {}): ApprovalTemplateDetailDTO {
  return {
    id: 'tpl_1',
    key: 'expense',
    name: '费用审批',
    description: null,
    category: null,
    visibilityScope: { type: 'all', ids: [] },
    slaHours: null,
    status: 'draft',
    activeVersionId: null,
    latestVersionId: 'ver_1',
    createdAt: '2026-06-04T00:00:00Z',
    updatedAt: '2026-06-04T00:00:00Z',
    formSchema: {
      fields: [{ id: 'amount', type: 'number', label: '金额', required: true }],
    },
    approvalGraph: {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          name: '审批人 1',
          config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' },
        },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
        { key: 'edge-approval_1-end', source: 'approval_1', target: 'end' },
      ],
    },
    ...overrides,
  }
}

let container: HTMLDivElement | null = null
let app: VueApp<Element> | null = null

async function mountView() {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(TemplateAuthoringView)
  installStubs(app)
  app.mount(container)
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

async function flushUi() {
  for (let i = 0; i < 6; i += 1) {
    await nextTick()
    await Promise.resolve()
  }
}

function setInput(testId: string, value: string) {
  const input = container!.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input'))
}

function detailConfig(): HTMLElement {
  return container!.querySelector('[data-testid="approval-detail-config"]') as HTMLElement
}

/** Per-row wrapper divs rendered by the ElTableColumn stub for one 明细 table column, in current
 * DOM order (current on-screen position, NOT a stable row identity). */
function columnRowWrappers(label: string): HTMLElement[] {
  return Array.from(detailConfig().querySelectorAll(`[data-el-column="${label}"] > div`)) as HTMLElement[]
}

function setRowType(index: number, type: string) {
  const select = columnRowWrappers('类型')[index]!.querySelector('select') as HTMLSelectElement
  select.value = type
  select.dispatchEvent(new Event('change'))
}

function setRowLabel(index: number, label: string) {
  const input = columnRowWrappers('名称')[index]!.querySelector('input') as HTMLInputElement
  input.value = label
  input.dispatchEvent(new Event('input'))
}

function clickRowDelete(index: number) {
  const button = columnRowWrappers('操作')[index]!.querySelector('button') as HTMLButtonElement
  button.click()
}

function clickAddDetailColumn() {
  (detailConfig().querySelector('[data-testid="approval-detail-add-column"]') as HTMLButtonElement).click()
}

function validationListText(): string[] {
  return Array.from(container!.querySelectorAll('li')).map((li) => li.textContent ?? '')
}

async function addDetailFieldAndFillBasics() {
  await mountView()
  ;(container!.querySelector('[data-testid="approval-field-palette-detail"]') as HTMLButtonElement).click()
  await flushUi()
  setInput('approval-template-key', 'detail_row_key_repro')
  setInput('approval-template-name', '明细子字段行键回归')
  await flushUi()
}

async function clickSave() {
  ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
  await flushUi()
}

describe('approval detail sub-field editor — row-key + id-collision (owner-reported, 2026-08-24)', () => {
  beforeEach(() => {
    routeParams = {}
    canManageTemplates.value = true
    approvalCanvasV2.value = false
    createTemplateSpy.mockReset()
    updateTemplateSpy.mockReset()
    getTemplateSpy.mockReset()
    listBasesSpy.mockReset()
    listSheetsSpy.mockReset()
    elMessageError.mockReset()
    // Save is driven to completion in every test here (not just up to the validation-error
    // list), so a create call that clears validation must resolve — otherwise `persistDraft`'s
    // catch path reaches for `ApprovalApiError`, which this file's api mock does not export.
    createTemplateSpy.mockImplementation(async (payload: { key: string; name: string; formSchema: unknown; approvalGraph: unknown }) => ({
      ...buildTemplate({ id: 'tpl_created' }),
      key: payload.key,
      name: payload.name,
      formSchema: payload.formSchema,
      approvalGraph: payload.approvalGraph,
    }))
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
  })

  it('defect 1: deleting an earlier sub-field does not redirect a still-focused LATER select sub-field\'s typed 选项 into a sibling row', async () => {
    await addDetailFieldAndFillBasics()

    // Rows at this point: [0] auto-created first column (text). Add three more via 添加子字段.
    clickAddDetailColumn() // -> index 1
    await flushUi()
    clickAddDetailColumn() // -> index 2
    await flushUi()
    clickAddDetailColumn() // -> index 3
    await flushUi()
    expect(columnRowWrappers('名称').length).toBe(4)

    // index 1 ("B"): a plain middle row, deleted below — not the row under test, not select-typed
    // (so its 选项 cell stays a <span>, matching the real "delete a field you didn't configure").
    setRowLabel(1, 'B-plain-middle')

    // index 2 ("C"): the field the author actually configures — switch to select and label it
    // distinctively so the save-validation error text unambiguously names it.
    setRowType(2, 'select')
    await flushUi()
    setRowLabel(2, 'C-target-select')

    // index 3 ("D"): ALSO select-typed (empty options) — this is what makes the reproduction
    // exact rather than a mere focus-loss: without this, deleting B would toggle C's landing
    // position's v-if branch from <input> to <span> (D would otherwise be a plain text field) and
    // Vue would just destroy/recreate the node, losing focus outright instead of misdirecting it.
    setRowType(3, 'select')
    await flushUi()
    setRowLabel(3, 'D-sibling-select')

    // Positive-control fuel (re-anchored 2026-08-25 — see the save assertions below): D carries a
    // MALFORMED option ('broken:' — empty value) typed at setup time, before any delete/shift, so
    // it is unambiguously D's own content. The malformed-option check survives B0's minimal save
    // set; the EMPTINESS check the control originally leaned on does not.
    const dOptionsInput = columnRowWrappers('选项')[3]!.querySelector('input') as HTMLInputElement
    expect(dOptionsInput).not.toBeNull()
    dOptionsInput.value = 'broken:'
    dOptionsInput.dispatchEvent(new Event('input'))
    await flushUi()

    // Focus C's OWN 选项 input while it is still safely at position 2 (no deletes have happened
    // yet, so "position 2" and "row C" still coincide regardless of row-key).
    const cOptionsInput = columnRowWrappers('选项')[2]!.querySelector('input') as HTMLInputElement
    expect(cOptionsInput).not.toBeNull()
    cOptionsInput.focus()
    expect(document.activeElement).toBe(cOptionsInput)

    // Delete B (index 1) — a middle row, before C, shifting C from index 2 -> 1 and D from
    // index 3 -> 2.
    clickRowDelete(1)
    await flushUi()
    expect(columnRowWrappers('名称').length).toBe(3)

    // The author, still looking at / focused on the SAME on-screen box, types the options they
    // believe belong to C.
    const stillFocused = document.activeElement as HTMLInputElement
    stillFocused.value = 'opt:1'
    stillFocused.dispatchEvent(new Event('input'))
    await flushUi()

    // C's OWN cell, found fresh by CURRENT position (index 1, where C now sits) must show what
    // was typed — not stay empty because the still-focused node silently rebound to D.
    const cCellNow = columnRowWrappers('选项')[1]!.querySelector('input') as HTMLInputElement
    expect(cCellNow.value).toBe('opt:1')

    // Save must NOT fail C at all — the exact owner-reported symptom.
    //
    // RE-ANCHORED POSITIVE CONTROL (2026-08-25). The original control asserted D — never
    // configured — fails save with 需要至少一个选项. #5143's owner-approved B0 deliberately
    // demoted that EMPTINESS check to publish-only (the backend does not reject it at
    // create/update), so at save it can no longer fire for anyone and the old control went
    // vacuous-red. The control now leans on D's malformed option planted at setup, which stays
    // save-blocking in B0's minimal set. Discrimination is preserved in BOTH directions: with a
    // broken row-key, the 'opt:1' typed above lands on D instead of C, HEALING D's malformed
    // text — this assertion then reds (measured, not assumed), alongside the primary DOM
    // assertion above.
    await clickSave()
    const errors = validationListText()
    expect(errors.some((line) => line.includes('C-target-select'))).toBe(false)
    // D's own malformed option must still be D's: present, save-blocking, and attributed to D.
    expect(errors.some((line) => line.includes('D-sibling-select') && line.includes('选项 label/value 不能为空'))).toBe(true)
  })

  it('defect 2: deleting a middle sub-field then adding another never reproduces an existing id (save-blocking "子字段 id 不能重复" does not fire)', async () => {
    await addDetailFieldAndFillBasics()

    // [0] auto col1, add two more via 添加子字段 -> 3 total.
    clickAddDetailColumn()
    await flushUi()
    clickAddDetailColumn()
    await flushUi()
    expect(columnRowWrappers('名称').length).toBe(3)

    // Delete the MIDDLE column (index 1).
    clickRowDelete(1)
    await flushUi()
    expect(columnRowWrappers('名称').length).toBe(2)

    // Add another — this is exactly the sequence that recomputes an id a surviving column
    // already holds under the un-fixed `length + 1` scheme.
    clickAddDetailColumn()
    await flushUi()
    expect(columnRowWrappers('名称').length).toBe(3)

    await clickSave()
    const errors = validationListText()
    expect(errors.some((line) => line.includes('子字段 id 不能重复'))).toBe(false)
  })

  it('validation-level positive control: a select sub-field whose options were typed (no delete/shift involved) never trips the save-blocking "需要至少一个选项" guard', async () => {
    await addDetailFieldAndFillBasics()

    // The single auto-created column: switch to select and type valid options directly, with no
    // add/delete cycle involved at all — isolates the validator itself from the row-key mechanism
    // exercised by the defect-1 test above.
    setRowType(0, 'select')
    await flushUi()
    setRowLabel(0, 'only-select-field')
    const optionsInput = columnRowWrappers('选项')[0]!.querySelector('input') as HTMLInputElement
    optionsInput.value = 'A:1\nB:2'
    optionsInput.dispatchEvent(new Event('input'))
    await flushUi()

    await clickSave()
    const errors = validationListText()
    expect(errors.some((line) => line.includes('only-select-field') && line.includes('需要至少一个选项'))).toBe(false)
  })
})
