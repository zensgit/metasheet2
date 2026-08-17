/* eslint-disable vue/one-component-per-file, vue/require-default-prop */
/**
 * F0 extraction (docs/development/approval-form-builder-parity-delta-design-20260811.md §5 F0,
 * Gate F0). Proves the current three-region form-design shell — now
 * `ApprovalFormInlineEditor.vue` — is a synchronous, same-DOM-position child of
 * `TemplateAuthoringView.vue`, that record-link catalog state/loading/retry/validation stay
 * parent-owned (the child never creates a second catalog owner or reads values back from the
 * DOM), and pins the component's props/events contract shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, inject, nextTick, provide, ref, type App as VueApp } from 'vue'
import TemplateAuthoringView from '../src/views/approval/TemplateAuthoringView.vue'
import ApprovalFormInlineEditor from '../src/approvals/components/ApprovalFormInlineEditor.vue'
import type { ApprovalTemplateDetailDTO } from '../src/types/approval'
import { createEmptyFieldDraft, type FieldAuthoringDraft } from '../src/approvals/templateAuthoring'

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

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  ElMessageBox: { confirm: vi.fn().mockResolvedValue(undefined) },
}))

// Gate F0 #2: record-link catalog fetch is the ONE thing the parent owns end-to-end. Control it
// deterministically instead of letting the real MultitableApiClient hit the network.
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
        'data-testid': (this.$attrs as any)?.['data-testid'],
        onChange: (event: Event) => this.$emit('update:modelValue', (event.target as HTMLInputElement).checked),
      }),
      this.$slots.default?.(),
    ])
  },
})

// Detail-column probe (FIX 3, PR #4939 gate fix round): unlike the generic no-op ElTableColumn
// stub used elsewhere in this repo's approval specs (which never renders scoped-slot content),
// this pair actually iterates `data` and invokes each column's `#default="{ row, $index }"` slot
// per row — required so the 明细 (detail) column table's per-row 删除 button is a real, clickable
// DOM node, making `@remove-detail-column` observably load-bearing (not just a static assertion).
const ELEMENT_TABLE_DATA = Symbol('element-table-data-stub')

const ElTable = defineComponent({
  name: 'ElTable',
  props: { data: { type: Array, default: () => [] } },
  setup(props, { slots, attrs }) {
    provide(ELEMENT_TABLE_DATA, computed(() => (props.data ?? []) as unknown[]))
    return () => h('div', { 'data-testid': (attrs as any)?.['data-testid'] }, slots.default?.())
  },
})

const ElTableColumn = defineComponent({
  name: 'ElTableColumn',
  props: { label: String },
  setup(_props, { slots }) {
    const rows = inject(ELEMENT_TABLE_DATA, computed(() => [] as unknown[]))
    return () => h(
      'div',
      rows.value.map((row, $index) => h('div', { key: $index }, slots.default?.({ row, $index }))),
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

// Unlike the generic `passthrough` helper, ElCard renders BOTH its `#header` slot and its
// default slot — TemplateAuthoringView.vue's undo/redo/add-field toolbar lives in `#header`, and
// scenario (a) below needs it in the DOM to prove it stayed outside the extracted child.
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

// `handleSave` -> `persistDraft` -> `validate` -> `ensureRecordLinkCatalog(true)` is a deeper
// await chain (it also retries the catalog fetch itself when not yet loaded) than the plain
// `flushUi` rounds above are sized for; give it more rounds so no fetch is left in-flight before
// the next assertion (an in-flight retry, if raced against, would make a subsequent explicit
// retry click a no-op via `ensureRecordLinkCatalog`'s own `loading` guard).
async function flushDeep() {
  for (let i = 0; i < 20; i += 1) {
    await nextTick()
    await Promise.resolve()
  }
}

function setInput(testId: string, value: string) {
  const input = container!.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input'))
}

describe('ApprovalFormInlineEditor extraction (F0, Gate F0)', () => {
  beforeEach(() => {
    routeParams = {}
    canManageTemplates.value = true
    approvalCanvasV2.value = false
    createTemplateSpy.mockReset()
    updateTemplateSpy.mockReset()
    getTemplateSpy.mockReset()
    listBasesSpy.mockReset()
    listSheetsSpy.mockReset()
    createTemplateSpy.mockImplementation(async (payload) => ({
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

  it('(a) the child renders synchronously in-place — no lazy boundary, no remount, one instance', async () => {
    await mountView()

    // Present immediately after the initial mount flush (no extra tick needed beyond the
    // standard nextTick/microtask drain every mounted test already performs).
    const designers = container!.querySelectorAll('[data-testid="approval-form-designer"]')
    expect(designers.length).toBe(1)
    const designer = designers[0] as HTMLElement

    // Rendered by the child, in the same subtree.
    expect(designer.querySelector('[data-testid="approval-field-palette"]')).not.toBeNull()
    expect(designer.querySelector('[data-testid="approval-form-preview"]')).not.toBeNull()

    // Still parent-owned and OUTSIDE the child's subtree (Gate F0 boundary: header toolbar stays
    // in TemplateAuthoringView.vue).
    const undoButton = container!.querySelector('[data-testid="approval-form-undo"]')
    expect(undoButton).not.toBeNull()
    expect(designer.contains(undoButton)).toBe(false)

    // Editing a field property (direct v-model on the shared FieldAuthoringDraft object) is
    // reflected without any remount: the palette/preview stay the SAME element instances.
    const before = container!.querySelector('[data-testid="approval-form-designer"]')
    setInput('approval-template-name', '差旅审批')
    await flushUi()
    const after = container!.querySelector('[data-testid="approval-form-designer"]')
    expect(after).toBe(before)
  })

  it('(b) record-link catalog failure blocks save; a successful retry supplies the parent-owned validation state', async () => {
    listBasesSpy.mockRejectedValue(new Error('network down'))
    listSheetsSpy.mockRejectedValue(new Error('network down'))

    await mountView()
    setInput('approval-template-key', 'rl_demo')
    setInput('approval-template-name', '关联记录演示')

    // Add a record-link field through the CHILD's palette click (exercises the real
    // add-field-of-type emit path, not a direct draft mutation).
    const palette = container!.querySelector('[data-testid="approval-field-palette-record-link"]') as HTMLButtonElement
    expect(palette).not.toBeNull()
    palette.click()
    await flushUi()

    // The catalog fetch was triggered by adding the record-link field and failed — the CHILD
    // renders the parent-owned error + retry affordance (never a second fetch owner).
    expect(listBasesSpy).toHaveBeenCalledTimes(1)
    expect(container!.querySelector('[data-testid="approval-record-link-catalog-error"]')).not.toBeNull()
    const retryButton = container!.querySelector('[data-testid="approval-record-link-catalog-retry"]') as HTMLButtonElement
    expect(retryButton).not.toBeNull()

    // Save is blocked: the record-link field has no chosen target (the failed catalog offered no
    // options to pick from), which is the unconditional "must choose a target" guard. `validate()`
    // also retries the catalog fetch itself (still failing, since the mock is unchanged) — drain
    // that fully before proceeding so no fetch is left in-flight.
    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushDeep()
    expect(createTemplateSpy).not.toHaveBeenCalled()
    const summary = container!.querySelector('[data-testid="approval-template-validation-summary"]')
    expect(summary?.textContent).toContain('关联记录')
    expect(summary?.textContent).toContain('目标')

    // Retry succeeds: swap the mock to resolve, then click the CHILD's retry button. The parent's
    // retryRecordLinkCatalog owns the refetch; the child only emitted the intent. Re-query the
    // button fresh here rather than reusing the reference captured above: `validate()`'s own
    // catalog retry (still failing, above) transiently clears `recordLinkCatalogError` to '' and
    // then resets it, which unmounts/remounts this `v-if="recordLinkCatalogError"` block — the
    // earlier reference is now a detached node.
    listBasesSpy.mockResolvedValue({ bases: [{ id: 'base_1', name: '销售空间' }] })
    listSheetsSpy.mockResolvedValue({ sheets: [{ id: 'sheet_1', name: '订单表', baseId: 'base_1' }] })
    const liveRetryButton = container!.querySelector('[data-testid="approval-record-link-catalog-retry"]') as HTMLButtonElement
    expect(liveRetryButton).not.toBeNull()
    liveRetryButton.click()
    await flushDeep()

    expect(container!.querySelector('[data-testid="approval-record-link-catalog-error"]')).toBeNull()

    // The parent-owned catalog state now flows back down as fresh options in the SAME child.
    const baseSelect = container!.querySelector('[data-testid="approval-record-link-base-select"]') as HTMLSelectElement
    expect(baseSelect.textContent).toContain('销售空间')

    // Choosing the now-available target through the child's controls updates the parent draft
    // (direct field mutation via the record-link-base/sheet-change emits) and unblocks save.
    baseSelect.value = 'base_1'
    baseSelect.dispatchEvent(new Event('change'))
    await flushUi()
    const sheetSelect = container!.querySelector('[data-testid="approval-record-link-sheet-select"]') as HTMLSelectElement
    expect(sheetSelect.textContent).toContain('订单表')
    sheetSelect.value = 'sheet_1'
    sheetSelect.dispatchEvent(new Event('change'))
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()
    expect(createTemplateSpy).toHaveBeenCalledTimes(1)
  })

  it('(c) props/events contract shape — standalone mount, no parent involved', async () => {
    const fields: FieldAuthoringDraft[] = [
      { ...createEmptyFieldDraft(1), localId: 'f1', id: 'field_1', label: '字段一' },
    ]
    const paletteGroups = [{
      id: 'text',
      label: '文本',
      entries: [{ type: 'text', label: '文本', mark: 'A' }, { type: 'record-link', label: '关联记录', mark: '链' }],
    }]
    const labels: Record<string, string> = {
      text: '文本', textarea: '多行文本', number: '数字', date: '日期', datetime: '日期时间',
      select: '单选', 'multi-select': '多选', user: '人员', detail: '明细', 'record-link': '关联记录',
    }

    const onAddFieldOfType = vi.fn()
    const onSelectFieldFocus = vi.fn()
    const onMoveField = vi.fn()
    const onRemoveField = vi.fn()
    const onRetryRecordLinkCatalog = vi.fn()

    const standaloneContainer = document.createElement('div')
    document.body.appendChild(standaloneContainer)
    const standaloneApp = createApp({
      render() {
        return h(ApprovalFormInlineEditor, {
          fields,
          readOnly: false,
          templateName: '独立挂载测试',
          formFieldFocusLocalId: null,
          fieldPaletteGroups: paletteGroups,
          fieldPaletteLabels: labels,
          detailLeafTypeOptions: [],
          recordLinkCatalogError: '',
          recordLinkCatalogLoading: false,
          recordLinkCatalogLoaded: true,
          recordLinkBaseOptionsFor: () => [],
          recordLinkSheetOptionsFor: () => [],
          visibilityFieldOptions: () => [],
          onAddFieldOfType,
          onSelectFieldFocus,
          onMoveField,
          onRemoveField,
          onRetryRecordLinkCatalog,
        })
      },
    })
    installStubs(standaloneApp)
    standaloneApp.mount(standaloneContainer)
    await nextTick()

    // Props: fields shape drove the inspector row for the sole field.
    expect(standaloneContainer.querySelector('[data-testid="approval-template-field-row"]')).not.toBeNull()
    expect(standaloneContainer.querySelector('[data-testid="approval-form-preview-row-f1"]')).not.toBeNull()

    // Emits: each interaction forwards the exact typed payload, positionally, with no
    // transformation — the contract the parent's listeners rely on.
    ;(standaloneContainer.querySelector('[data-testid="approval-field-palette-record-link"]') as HTMLButtonElement).click()
    expect(onAddFieldOfType).toHaveBeenCalledWith('record-link')

    ;(standaloneContainer.querySelector('[data-testid="approval-form-preview-row-f1"]') as HTMLButtonElement).click()
    expect(onSelectFieldFocus).toHaveBeenCalledWith('f1')

    const moveButtons = standaloneContainer.querySelectorAll('[data-testid="approval-template-field-row"] button')
    // 上移 is disabled (index 0); 删除 is disabled (last field) — both wired but inert here.
    expect(moveButtons.length).toBeGreaterThan(0)

    standaloneApp.unmount()
    standaloneContainer.remove()
  })

  // FIX 3 (PR #4939 gate fix round): the remaining 10 of 14 parent listeners on the
  // `<ApprovalFormInlineEditor>` tag were not load-bearing — deleting any of them left every test
  // above green. Each case below mounts the REAL PARENT (mountView(), not the standalone child
  // harness in (c) above) and drives the child's DOM so the emit reaches the parent's actual
  // `@listener="handler"` binding; the assertion only holds if that specific binding fired.

  function previewRows(): HTMLElement[] {
    return Array.from(container!.querySelectorAll('.template-authoring__form-preview-row'))
  }
  function previewRowTestIds(): (string | null)[] {
    return previewRows().map((el) => el.getAttribute('data-testid'))
  }
  function focusedFieldRow(): HTMLElement {
    return container!.querySelector(
      '[data-testid="approval-template-field-row"][data-selected="true"]',
    ) as HTMLElement
  }

  it('(d) move-field reorders the preview list in both directions (上移/下移)', async () => {
    await mountView()
    const before = previewRowTestIds()
    expect(before.length).toBe(1)

    // Add a second field — it lands last and is auto-focused (structural push + focusFormFieldRow).
    ;(container!.querySelector('[data-testid="approval-field-palette-text"]') as HTMLButtonElement).click()
    await flushUi()
    const afterAdd = previewRowTestIds()
    expect(afterAdd).toEqual([before[0], expect.any(String)])
    const newFieldTestId = afterAdd[1]

    // 上移: the focused (new) field's toolbar button at index 0 within its own row.
    const toolbarButtons = () => focusedFieldRow().querySelectorAll('.template-authoring__item-toolbar button')
    const upButton = toolbarButtons()[0] as HTMLButtonElement
    expect(upButton.disabled).toBe(false)
    upButton.click()
    await flushUi()
    expect(previewRowTestIds()).toEqual([newFieldTestId, before[0]])

    // 下移: same focused row (key-stable across the reorder), move back down.
    const downButton = toolbarButtons()[1] as HTMLButtonElement
    expect(downButton.disabled).toBe(false)
    downButton.click()
    await flushUi()
    expect(previewRowTestIds()).toEqual([before[0], newFieldTestId])
  })

  it('(e) native drag-and-drop reorders fields via field-drag-start + field-drop', async () => {
    await mountView()
    ;(container!.querySelector('[data-testid="approval-field-palette-text"]') as HTMLButtonElement).click()
    await flushUi()
    const before = previewRowTestIds()
    expect(before.length).toBe(2)

    const rows = previewRows()
    rows[0].dispatchEvent(new Event('dragstart'))
    rows[1].dispatchEvent(new Event('drop'))
    await flushUi()

    expect(previewRowTestIds()).toEqual([before[1], before[0]])
  })

  it('(f) palette drag-and-drop onto the stage adds the dragged type via palette-drag-start + preview-drop', async () => {
    await mountView()
    expect(previewRowTestIds().length).toBe(1)

    const paletteChip = container!.querySelector('[data-testid="approval-field-palette-record-link"]') as HTMLButtonElement
    paletteChip.dispatchEvent(new Event('dragstart'))
    const stage = container!.querySelector('.template-authoring__form-preview-stage') as HTMLElement
    stage.dispatchEvent(new Event('drop'))
    await flushUi()

    const rows = previewRows()
    expect(rows.length).toBe(2)
    expect(rows[1].querySelector('.template-authoring__form-preview-type')?.textContent).toBe('关联记录')
  })

  it('(g) remove-field deletes the field and shrinks the preview list', async () => {
    await mountView()
    ;(container!.querySelector('[data-testid="approval-field-palette-text"]') as HTMLButtonElement).click()
    await flushUi()
    expect(previewRowTestIds().length).toBe(2)

    const removeButton = focusedFieldRow().querySelectorAll('.template-authoring__item-toolbar button')[2] as HTMLButtonElement
    expect(removeButton.disabled).toBe(false)
    removeButton.click()
    await flushUi()

    expect(previewRowTestIds().length).toBe(1)
  })

  it('(h) select-field-focus moves the selected/focused row without reordering fields', async () => {
    await mountView()
    ;(container!.querySelector('[data-testid="approval-field-palette-text"]') as HTMLButtonElement).click()
    await flushUi()
    const order = previewRowTestIds()
    const originalRowTestId = order[0]
    const newRowLocalId = order[1]!.replace('approval-form-preview-row-', '')
    // Sanity: the newly-added field (not the original) is currently focused.
    expect(focusedFieldRow().getAttribute('data-field-local-id')).toBe(newRowLocalId)

    // Click the ORIGINAL preview row to move selection back onto it.
    ;(previewRows()[0] as HTMLButtonElement).click()
    await flushUi()

    // Field order is untouched (select-field-focus never pushes to the structural history stack).
    expect(previewRowTestIds()).toEqual(order)
    // Focus moved to the field behind the clicked row (data-field-local-id ties the preview row
    // clicked to the inspector row now marked data-selected="true").
    const originalLocalId = originalRowTestId!.replace('approval-form-preview-row-', '')
    expect(focusedFieldRow().getAttribute('data-field-local-id')).toBe(originalLocalId)
  })

  it('(i) add-detail-column / remove-detail-column mutate the field detail-column list', async () => {
    await mountView()
    ;(container!.querySelector('[data-testid="approval-field-palette-detail"]') as HTMLButtonElement).click()
    await flushUi()

    // addFieldOfType seeds exactly ONE detail column by default (parent-owned, unrelated to
    // add-detail-column/remove-detail-column — this is just the starting state).
    const detailConfig = () => container!.querySelector('[data-testid="approval-detail-config"]') as HTMLElement
    expect(detailConfig()).not.toBeNull()
    const columnDeleteButtons = () => detailConfig().querySelectorAll('.template-authoring__detail-table button')
    expect(columnDeleteButtons().length).toBe(1)

    // add-detail-column: "添加子字段" appends a second column.
    const addColumnButton = detailConfig().querySelector('[data-testid="approval-detail-add-column"]') as HTMLButtonElement
    addColumnButton.click()
    await flushUi()
    expect(columnDeleteButtons().length).toBe(2)

    // remove-detail-column: the first row's own 删除 button drops the count back to one.
    ;(columnDeleteButtons()[0] as HTMLButtonElement).click()
    await flushUi()
    expect(columnDeleteButtons().length).toBe(1)
  })

  it('(j) invalidate-record-link-deps clears a stale visibility dependency when the depended-on field is retyped to record-link', async () => {
    await mountView()
    ;(container!.querySelector('[data-testid="approval-field-palette-text"]') as HTMLButtonElement).click()
    await flushUi()

    // The newly-added field is focused; give it a visibility rule depending on the ORIGINAL
    // (create-mode default, index-1) field — still type='text' at this point, an eligible
    // dependency (non-empty id, not record-link/detail). Read the option's value rather than
    // hardcoding the default field's auto-generated id.
    const dependentRow = focusedFieldRow()
    const dependsSelect = dependentRow.querySelector('[data-testid="approval-field-visibility-depends"]') as HTMLSelectElement
    const dependencyOption = dependsSelect.querySelector('option:not([value=""])') as HTMLOptionElement
    expect(dependencyOption).not.toBeNull()
    const dependencyValue = dependencyOption.value
    dependsSelect.value = dependencyValue
    dependsSelect.dispatchEvent(new Event('change'))
    await flushUi()
    expect(dependsSelect.value).toBe(dependencyValue)
    // Ground-truth signal for the underlying `field.visibility.dependsOnFieldId` model value: the
    // operator select only renders `v-if="field.visibility.dependsOnFieldId"`. (NOT the native
    // <select>'s own `.value` getter after the option disappears below — a <select> whose model
    // value no longer matches any <option> silently coerces `.value` to '' even though the
    // underlying reactive string is untouched, which would make this assertion pass whether or
    // not invalidateStaleRecordLinkDependencies actually ran — a false-positive verified while
    // authoring this test.)
    const operatorSelect = () => dependentRow.querySelector('[data-testid="approval-field-visibility-operator"]')
    expect(operatorSelect()).not.toBeNull()

    // Retype the ORIGINAL field (the dependency target) to record-link — the other field row
    // (not the one just focused/dependent).
    const allRows = Array.from(container!.querySelectorAll('[data-testid="approval-template-field-row"]'))
    const targetRow = allRows.find((row) => row !== dependentRow) as HTMLElement
    const typeSelect = targetRow.querySelector('[data-testid="approval-field-type"]') as HTMLSelectElement
    typeSelect.value = 'record-link'
    typeSelect.dispatchEvent(new Event('change'))
    await flushUi()

    // The dependent field's stale visibility rule was cleared by the parent's
    // invalidateStaleRecordLinkDependencies (server would fail-close on an illegal dependency):
    // the operator select's v-if condition (`field.visibility.dependsOnFieldId`) is now falsy.
    expect(operatorSelect()).toBeNull()
  })

  // -------------------------------------------------------------------------
  // L8-C (approval-lock8-field-vocabulary-20260817.md §1.3, OD-L8-6): the formatted-number
  // props config block. Every control here is TYPED and WRITE-THROUGH (M7: no inert/disabled-
  // theater controls) — this test proves that mechanically, by driving the real DOM controls and
  // reading the value back off the real createTemplate payload, not by asserting the markup shape
  // alone.
  // -------------------------------------------------------------------------
  it('(k) L8-C: the number-props config block is type-selected, its three controls are typed (not inert), and their values reach the create payload', async () => {
    await mountView()
    setInput('approval-template-key', 'num_l8c')
    setInput('approval-template-name', 'L8C数字')

    // The default create-mode field starts as `text` — the block is absent until retyped.
    expect(container!.querySelector('[data-testid="approval-number-format-config"]')).toBeNull()

    const typeSelect = container!.querySelector('[data-testid="approval-field-type"]') as HTMLSelectElement
    expect(typeSelect).not.toBeNull()
    typeSelect.value = 'number'
    typeSelect.dispatchEvent(new Event('change'))
    await flushUi()

    // Presence is type-selected: appears now, for a `number` field (matching the OTHER type-gated
    // blocks in this component — select/detail/record-link — never rendered as always-on chrome).
    expect(container!.querySelector('[data-testid="approval-number-format-config"]')).not.toBeNull()

    const currencySelect = container!.querySelector('[data-testid="approval-number-currency-select"]') as HTMLSelectElement
    const thousandsToggle = container!.querySelector('[data-testid="approval-number-thousands-toggle"]') as HTMLInputElement
    const uppercaseToggle = container!.querySelector('[data-testid="approval-number-uppercase-toggle"]') as HTMLInputElement
    expect(currencySelect).not.toBeNull()
    expect(thousandsToggle).not.toBeNull()
    expect(uppercaseToggle).not.toBeNull()
    expect(thousandsToggle.type).toBe('checkbox')
    expect(uppercaseToggle.type).toBe('checkbox')

    currencySelect.value = '¥'
    currencySelect.dispatchEvent(new Event('change'))
    thousandsToggle.checked = true
    thousandsToggle.dispatchEvent(new Event('change'))
    uppercaseToggle.checked = true
    uppercaseToggle.dispatchEvent(new Event('change'))
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()
    expect(createTemplateSpy).toHaveBeenCalledTimes(1)
    const payload = createTemplateSpy.mock.calls[0][0]
    const field = payload.formSchema.fields[0]
    expect(field.type).toBe('number')
    // Every control's value made it through — proof the controls WRITE, not merely render
    // (M7's "no inert/disabled-theater controls" applied mechanically).
    expect(field.props).toEqual({ currencySymbol: '¥', thousandsSeparator: true, uppercaseCny: true })
  })

  it('(l) L8-C: unchecking the toggles / clearing the currency select removes the keys (editor-authoritative, not resurrected)', async () => {
    await mountView()
    setInput('approval-template-key', 'num_l8c_clear')
    setInput('approval-template-name', 'L8C清空')

    const typeSelect = container!.querySelector('[data-testid="approval-field-type"]') as HTMLSelectElement
    typeSelect.value = 'number'
    typeSelect.dispatchEvent(new Event('change'))
    await flushUi()

    const currencySelect = container!.querySelector('[data-testid="approval-number-currency-select"]') as HTMLSelectElement
    const thousandsToggle = container!.querySelector('[data-testid="approval-number-thousands-toggle"]') as HTMLInputElement
    const uppercaseToggle = container!.querySelector('[data-testid="approval-number-uppercase-toggle"]') as HTMLInputElement
    currencySelect.value = '¥'
    currencySelect.dispatchEvent(new Event('change'))
    thousandsToggle.checked = true
    thousandsToggle.dispatchEvent(new Event('change'))
    uppercaseToggle.checked = true
    uppercaseToggle.dispatchEvent(new Event('change'))
    await flushUi()

    // Clear all three back to their unset state.
    currencySelect.value = ''
    currencySelect.dispatchEvent(new Event('change'))
    thousandsToggle.checked = false
    thousandsToggle.dispatchEvent(new Event('change'))
    uppercaseToggle.checked = false
    uppercaseToggle.dispatchEvent(new Event('change'))
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()
    expect(createTemplateSpy).toHaveBeenCalledTimes(1)
    const field = createTemplateSpy.mock.calls[0][0].formSchema.fields[0]
    expect(field.props).toBeUndefined()
  })

  it('(m) L8-C gate M-2: the rendered number-props block never renders 金额/money/exact — mechanical sweep, positive control 格式化数字 IS found', async () => {
    await mountView()
    const typeSelect = container!.querySelector('[data-testid="approval-field-type"]') as HTMLSelectElement
    typeSelect.value = 'number'
    typeSelect.dispatchEvent(new Event('change'))
    await flushUi()

    const block = container!.querySelector('[data-testid="approval-number-format-config"]') as HTMLElement
    expect(block).not.toBeNull()
    const text = block.textContent ?? ''
    for (const forbidden of ['金额', 'money', 'Money', 'MONEY', 'exact', 'Exact']) {
      expect(text, `must not render "${forbidden}"`).not.toContain(forbidden)
    }
    // Positive control: the sweep DOES find the mandated replacement copy — not passing over an
    // empty string set (Lock-8 gate M-2).
    expect(text).toContain('格式化数字')
  })
})
