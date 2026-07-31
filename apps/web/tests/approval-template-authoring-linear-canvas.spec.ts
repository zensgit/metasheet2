/* eslint-disable vue/one-component-per-file, vue/require-default-prop */
/**
 * C1 unified canvas — the production Canvas V2 surface serves a LINEAR step draft through the same
 * `buildApprovalGraph` adapter it already uses for a preserved complex graph.
 *
 * Each test is written to FAIL for a specific regression rather than to exercise the happy path:
 *  - the toggle/canvas appear for a linear draft, and the step cards are the structured fallback;
 *  - flag OFF (and an unsupported template) keep every canvas surface absent;
 *  - merely opening/selecting leaves the draft clean and the payload byte-identical;
 *  - inspector edits land on the SAME `ApprovalStepDraft` the step cards read (not a shadow copy);
 *  - every legal edge carries a keyboard-accessible `+` menu whose choices come from the command
 *    predicate, and the first insertion promotes to `preservedGraph` without flattening config;
 *  - the canvas cannot delete a linear draft's only approval step;
 *  - a complex graph round-trips exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import TemplateAuthoringView from '../src/views/approval/TemplateAuthoringView.vue'
import type { ApprovalTemplateDetailDTO } from '../src/types/approval'

const pushSpy = vi.fn().mockResolvedValue(undefined)
const replaceSpy = vi.fn().mockResolvedValue(undefined)
let routeParams: Record<string, string> = {}

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: pushSpy, replace: replaceSpy, back: vi.fn() }),
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

const approvalCanvasV2 = ref(true)
vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    features: computed(() => ({ approvalCanvasV2: approvalCanvasV2.value })),
  }),
}))

// Real role/user options so the multi-select pickers have selectable <option>s (the ids write path
// goes through the picker, not a raw-text field).
const directoryRoles = ref([{ id: 'role_legal', name: '法务' }, { id: 'role_finance', name: '财务' }])
vi.mock('../src/approvals/useApprovalDirectory', () => ({
  useApprovalDirectory: () => ({
    users: ref([{ id: 'u_alice', name: 'Alice', email: 'alice@example.com' }]),
    roles: directoryRoles,
    formulaRoles: ref([]),
    usersLoading: ref(false),
    rolesLoading: ref(false),
    formulaRolesLoading: ref(false),
    statusMessage: ref(''),
    searchUsers: vi.fn().mockResolvedValue(undefined),
    loadRoles: vi.fn().mockResolvedValue(undefined),
    loadFormulaRoles: vi.fn().mockResolvedValue(undefined),
    ensureUserOptionVisible: vi.fn(),
    ensureRoleOptionVisible: vi.fn(),
    formatUserLabel: (user: { id: string }) => user.id,
    formatRoleLabel: (role: { id: string }) => role.id,
  }),
}))

const createTemplateSpy = vi.fn()
const updateTemplateSpy = vi.fn()
const publishTemplateSpy = vi.fn()
const getTemplateSpy = vi.fn()
const getTemplateFormAuthoringContextSpy = vi.fn().mockImplementation(async (id: string) => ({
  templateId: id,
  identityHistory: { complete: true, persistentIds: [] },
  referenceInventory: { complete: true, references: [] },
}))
const dryRunApprovalConditionFormulaSpy = vi.fn()

vi.mock('../src/approvals/api', () => ({
  createTemplate: (payload: unknown) => createTemplateSpy(payload),
  updateTemplate: (id: string, payload: unknown) => updateTemplateSpy(id, payload),
  publishTemplate: (id: string, payload: unknown) => publishTemplateSpy(id, payload),
  getTemplate: (id: string) => getTemplateSpy(id),
  getTemplateFormAuthoringContext: (id: string) => getTemplateFormAuthoringContextSpy(id),
  dryRunApprovalConditionFormula: (payload: unknown) => dryRunApprovalConditionFormulaSpy(payload),
}))

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  ElMessageBox: { confirm: vi.fn().mockResolvedValue(undefined) },
}))

const ElButton = defineComponent({
  name: 'ElButton',
  props: { disabled: Boolean, loading: Boolean, type: String, text: Boolean, size: String },
  emits: ['click'],
  render() {
    return h('button', {
      type: 'button',
      disabled: this.disabled || this.loading,
      'data-testid': (this.$attrs as any)?.['data-testid'],
      title: (this.$attrs as any)?.title,
      'aria-label': (this.$attrs as any)?.['aria-label'],
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

const ElInputNumber = defineComponent({
  name: 'ElInputNumber',
  props: { modelValue: Number, disabled: Boolean, min: Number, max: Number, step: Number },
  emits: ['update:modelValue'],
  render() {
    return h('input', {
      type: 'number',
      value: this.modelValue ?? '',
      disabled: this.disabled,
      'data-testid': (this.$attrs as any)?.['data-testid'],
      onInput: (event: Event) => this.$emit('update:modelValue', Number((event.target as HTMLInputElement).value)),
    })
  },
})

/**
 * Mirrors el-select's contract: a `multiple` select emits an ARRAY, a single one emits the value.
 * A multi-select's bound value is exposed as `data-model` because a bare `<select multiple>` cannot
 * render an incoming array as `selectedOptions` (the real el-select renders its own chips) — reading
 * the attribute is what the component was HANDED, so a read-back assertion stays load-bearing.
 */
const ElSelect = defineComponent({
  name: 'ElSelect',
  props: { modelValue: [String, Array], disabled: Boolean, multiple: Boolean },
  emits: ['update:modelValue', 'change'],
  render() {
    return h('select', {
      multiple: this.multiple,
      value: this.multiple ? undefined : (this.modelValue ?? ''),
      disabled: this.disabled,
      'data-model': JSON.stringify(this.modelValue ?? null),
      'data-testid': (this.$attrs as any)?.['data-testid'],
      onChange: (event: Event) => {
        const select = event.target as HTMLSelectElement
        const payload = this.multiple
          ? Array.from(select.selectedOptions).map((option) => option.value)
          : select.value
        this.$emit('update:modelValue', payload)
        this.$emit('change', payload)
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

function installStubs(app: VueApp<Element>) {
  app.directive('loading', {})
  app.component('ElButton', ElButton)
  app.component('ElButtonGroup', passthrough('ElButtonGroup'))
  app.component('ElTooltip', passthrough('ElTooltip'))
  app.component('ElInput', ElInput)
  app.component('ElInputNumber', ElInputNumber)
  app.component('ElSelect', ElSelect)
  app.component('ElOption', ElOption)
  app.component('ElCheckbox', ElCheckbox)
  app.component('ElAlert', ElAlert)
  app.component('ElDialog', ElDialog)
  app.component('ElCard', passthrough('ElCard', 'section'))
  app.component('ElForm', passthrough('ElForm', 'form'))
  app.component('ElFormItem', passthrough('ElFormItem', 'label'))
  app.component('ElIcon', passthrough('ElIcon', 'span'))
  app.component('ElCollapse', passthrough('ElCollapse'))
  app.component('ElCollapseItem', passthrough('ElCollapseItem'))
  app.component('ElTable', passthrough('ElTable'))
  app.component('ElTableColumn', passthrough('ElTableColumn'))
}

const LINEAR_STEP_1_CONFIG = {
  assigneeSources: [{ kind: 'direct_manager' }],
  approvalMode: 'single',
  emptyAssigneePolicy: 'error',
}
const LINEAR_STEP_2_CONFIG = {
  assigneeSources: [{ kind: 'static_role', roleIds: ['role_legal'] }],
  approvalMode: 'all',
  emptyAssigneePolicy: 'auto-approve',
  autoApprovalPolicy: { mergeWithRequester: true },
  fieldPermissions: [{ fieldId: 'amount', access: 'hidden' }],
}

/** A plain LINEAR template: `steps` is the carrier, there is no `preservedGraph`. */
function buildLinearGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      { key: 'approval_1', type: 'approval', name: '直属上级', config: { ...LINEAR_STEP_1_CONFIG } },
      { key: 'approval_2', type: 'approval', name: '法务复核', config: { ...LINEAR_STEP_2_CONFIG } },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
      { key: 'edge-approval_1-approval_2', source: 'approval_1', target: 'approval_2' },
      { key: 'edge-approval_2-end', source: 'approval_2', target: 'end' },
    ],
  }
}

function buildSingleStepLinearGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      { key: 'approval_1', type: 'approval', name: '直属上级', config: { ...LINEAR_STEP_1_CONFIG } },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
      { key: 'edge-approval_1-end', source: 'approval_1', target: 'end' },
    ],
  }
}

/** A preserved COMPLEX graph (condition + cc) — the shape the canvas already served before C1. */
function buildComplexGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      {
        key: 'cond_1',
        type: 'condition',
        name: '金额判断',
        config: {
          branches: [{ edgeKey: 'e-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }], conjunction: 'and' }],
          defaultEdgeKey: 'e-low',
        },
      },
      { key: 'approval_high', type: 'approval', name: '高额审批', config: { ...LINEAR_STEP_1_CONFIG } },
      { key: 'cc_1', type: 'cc', name: '抄送财务', config: { targetType: 'role', targetIds: ['role_finance'] } },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'e-start-c', source: 'start', target: 'cond_1' },
      { key: 'e-high', source: 'cond_1', target: 'approval_high' },
      { key: 'e-low', source: 'cond_1', target: 'cc_1' },
      { key: 'e-high-cc', source: 'approval_high', target: 'cc_1' },
      { key: 'e-cc-end', source: 'cc_1', target: 'end' },
    ],
  }
}

function buildParallelGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      {
        key: 'parallel_1',
        type: 'parallel',
        name: '并行会签',
        config: { branches: ['e-fork-a', 'e-fork-b'], joinMode: 'all', joinNodeKey: 'join_1' },
      },
      { key: 'approval_a', type: 'approval', name: '财务审批', config: { ...LINEAR_STEP_1_CONFIG } },
      { key: 'approval_b', type: 'approval', name: '法务审批', config: { ...LINEAR_STEP_2_CONFIG } },
      { key: 'join_1', type: 'approval', name: '负责人复核', config: { ...LINEAR_STEP_1_CONFIG } },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'e-start-p', source: 'start', target: 'parallel_1' },
      { key: 'e-fork-a', source: 'parallel_1', target: 'approval_a' },
      { key: 'e-fork-b', source: 'parallel_1', target: 'approval_b' },
      { key: 'e-a-join', source: 'approval_a', target: 'join_1' },
      { key: 'e-b-join', source: 'approval_b', target: 'join_1' },
      { key: 'e-join-end', source: 'join_1', target: 'end' },
    ],
  }
}

function buildTemplate(overrides: Partial<ApprovalTemplateDetailDTO> = {}): ApprovalTemplateDetailDTO {
  return {
    id: 'tpl_linear_canvas',
    key: 'expense',
    name: '费用审批',
    description: null,
    category: null,
    visibilityScope: { type: 'all', ids: [] },
    slaHours: null,
    status: 'draft',
    activeVersionId: null,
    latestVersionId: 'ver_1',
    createdAt: '2026-07-28T00:00:00Z',
    updatedAt: '2026-07-28T00:00:00Z',
    formSchema: {
      fields: [
        { id: 'amount', type: 'number', label: '金额', required: true },
        { id: 'reviewer', type: 'user', label: '审批人' },
      ],
    },
    approvalGraph: buildLinearGraph() as any,
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

function unmountView() {
  app?.unmount()
  container?.remove()
  app = null
  container = null
}

async function flushUi() {
  for (let i = 0; i < 6; i += 1) {
    await nextTick()
    await Promise.resolve()
  }
}

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return container!.querySelector(selector) as T | null
}
function all(selector: string): HTMLElement[] {
  return Array.from(container!.querySelectorAll(selector)) as HTMLElement[]
}
function click(testId: string) {
  const button = q<HTMLButtonElement>(`[data-testid="${testId}"]`)
  expect(button, testId).not.toBeNull()
  button!.click()
}
function selectValue(testId: string, value: string, scope = '') {
  const select = q<HTMLSelectElement>(`${scope}[data-testid="${testId}"]`)
  expect(select, testId).not.toBeNull()
  select!.value = value
  select!.dispatchEvent(new Event('change'))
}
function clickCanvasNode(nodeKey: string) {
  const node = q(`[data-testid="approval-canvas-node"][data-canvas-node="${nodeKey}"]`)
  expect(node, `canvas node ${nodeKey}`).not.toBeNull()
  node!.click()
}
async function openEdgeInsertMenu(edgeKey: string) {
  click(`approval-canvas-edge-insert-${edgeKey}`)
  await flushUi()
  expect(q(`[data-testid="approval-canvas-edge-menu-${edgeKey}"]`)).not.toBeNull()
}
/** Step cards use `v-show`, so "hidden" means display:none rather than removal. */
function visibleStepRows(): HTMLElement[] {
  return all('[data-testid="approval-template-step-row"]').filter((row) => row.style.display !== 'none')
}
async function saveDraft() {
  click('approval-template-save-button')
  await flushUi()
}
function lastUpdatePayload(): any {
  return updateTemplateSpy.mock.calls.at(-1)?.[1]
}

describe('C1 unified canvas — linear step drafts on the production Canvas V2 surface', () => {
  beforeEach(() => {
    routeParams = {}
    canManageTemplates.value = true
    approvalCanvasV2.value = true
    createTemplateSpy.mockReset()
    updateTemplateSpy.mockReset()
    publishTemplateSpy.mockReset()
    getTemplateSpy.mockReset()
    dryRunApprovalConditionFormulaSpy.mockReset()
    pushSpy.mockClear()
    replaceSpy.mockClear()
    // Echo the payload back so a save re-hydrates from what it just sent (as the real API does).
    updateTemplateSpy.mockImplementation(async (id, payload) => ({ ...buildTemplate({ id }), ...payload }))
    getTemplateSpy.mockResolvedValue(buildTemplate())
  })

  afterEach(() => {
    unmountView()
  })

  it('defaults a linear draft to the canvas and retains the auxiliary structured editor', async () => {
    routeParams = { id: 'tpl_linear_toggle' }
    await mountView()
    await flushUi()

    // C2: Canvas V2 is the default flow surface while the flag is ON.
    expect(q('[data-testid="approval-graph-view-toggle"]')).not.toBeNull()
    expect(q('[data-testid="approval-canvas-workspace"]')).not.toBeNull()
    // start → approval_1 → approval_2 → end, exactly the graph `buildApprovalGraph` derives.
    // Compared as a set: paint order is the layout's business, node identity is the adapter's.
    expect(all('[data-testid="approval-canvas-node"]').map((node) => node.dataset.canvasNode).sort())
      .toEqual(['approval_1', 'approval_2', 'end', 'start'])
    expect(all('[data-testid="approval-canvas-edge"]')).toHaveLength(3)
    // A valid linear chain raises no structural warning.
    expect(q('[data-testid="approval-canvas-validity"]')).toBeNull()
    // The structured list is swapped out, not duplicated — and a linear draft never renders the
    // complex read-only list.
    expect(visibleStepRows()).toHaveLength(0)
    expect(q('[data-testid="approval-template-step-spine"]')).toBeNull()
    expect(q('[data-testid="approval-graph-readonly-list"]')).toBeNull()

    // …and 辅助编辑模式 brings the same cards back (the accessibility fallback stays reachable).
    click('approval-view-list')
    await flushUi()
    expect(q('[data-testid="approval-canvas-workspace"]')).toBeNull()
    expect(visibleStepRows()).toHaveLength(2)
    expect(q('[data-testid="approval-template-step-spine"]')).not.toBeNull()
  })

  it('renders one keyboard-accessible plus per legal edge and removes in-card insertion buttons', async () => {
    routeParams = { id: 'tpl_edge_insert_controls' }
    await mountView()
    await flushUi()

    const insertionControls = all('[data-testid^="approval-canvas-edge-insert-"]')
    expect(insertionControls).toHaveLength(buildLinearGraph().edges.length)
    for (const control of insertionControls) {
      expect(control.tagName).toBe('BUTTON')
      expect(control.getAttribute('aria-haspopup')).toBe('menu')
      expect(control.getAttribute('aria-label')).toMatch(/^在「.+」之后插入节点$/)
    }
    expect(q('[data-testid^="approval-canvas-insert-"]')).toBeNull()
    expect(q('[data-testid^="approval-canvas-insert-condition-"]')).toBeNull()
    expect(q('[data-testid^="approval-canvas-insert-parallel-"]')).toBeNull()

    await openEdgeInsertMenu('edge-approval_1-approval_2')
    expect(all('[role="menuitem"]').map((item) => item.textContent?.trim()))
      .toEqual(['审批', '抄送', '条件分支', '并行分支'])
    const firstOption = q<HTMLButtonElement>('[role="menuitem"]')
    expect(document.activeElement).toBe(firstOption)

    // Native buttons map Enter/Space to click in the browser; Esc is explicitly handled and returns
    // focus to the originating edge control.
    firstOption!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushUi()
    expect(q('[data-testid="approval-canvas-edge-menu-edge-approval_1-approval_2"]')).toBeNull()
    expect(document.activeElement).toBe(q('[data-testid="approval-canvas-edge-insert-edge-approval_1-approval_2"]'))
  })

  it('filters nested parallel from branch-edge menus while retaining legal node types', async () => {
    routeParams = { id: 'tpl_parallel_edge_insert' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildParallelGraph() as any }))
    await mountView()
    await flushUi()

    expect(all('[data-testid^="approval-canvas-edge-insert-"]')).toHaveLength(buildParallelGraph().edges.length)
    await openEdgeInsertMenu('e-fork-a')
    expect(q('[data-testid="approval-canvas-edge-option-e-fork-a-approval"]')).not.toBeNull()
    expect(q('[data-testid="approval-canvas-edge-option-e-fork-a-cc"]')).not.toBeNull()
    expect(q('[data-testid="approval-canvas-edge-option-e-fork-a-condition"]')).not.toBeNull()
    expect(q('[data-testid="approval-canvas-edge-option-e-fork-a-parallel"]')).toBeNull()

    // Outside the branch interval, parallel remains a legal positive control.
    click('approval-canvas-edge-insert-e-start-p')
    await flushUi()
    expect(q('[data-testid="approval-canvas-edge-option-e-start-p-parallel"]')).not.toBeNull()
  })

  it('switches directly between the form and flow workspaces while Canvas V2 is enabled', async () => {
    routeParams = { id: 'tpl_canvas_mode_switch' }
    await mountView()
    await flushUi()

    click('approval-template-section-fields')
    await flushUi()
    const modeSwitch = q('[data-testid="approval-authoring-mode-switch"]')
    expect(modeSwitch).not.toBeNull()
    expect(modeSwitch?.getAttribute('role')).toBe('group')
    expect(q('[data-testid="approval-authoring-mode-form"]')?.getAttribute('aria-pressed')).toBe('true')

    click('approval-authoring-mode-flow')
    await flushUi()
    expect(q('[data-testid="approval-authoring-mode-flow"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(q('[data-testid="approval-canvas-workspace"]')).not.toBeNull()

    click('approval-authoring-mode-form')
    await flushUi()
    expect(q('[data-testid="approval-authoring-mode-form"]')?.getAttribute('aria-pressed')).toBe('true')
    const fieldsPanel = q('[data-testid="approval-template-add-field"]')?.closest('.template-authoring__panel') as HTMLElement | null
    const flowPanel = q('[data-testid="approval-canvas-workspace"]')?.closest('.template-authoring__panel') as HTMLElement | null
    expect(fieldsPanel?.style.display).not.toBe('none')
    expect(flowPanel?.style.display).toBe('none')
  })

  it('remeasures the canvas viewport when the hidden flow section becomes visible', async () => {
    routeParams = { id: 'tpl_canvas_viewport_reveal' }
    await mountView()
    await flushUi()

    const viewport = q<HTMLElement>('.template-authoring__canvas-viewport')
    expect(viewport).not.toBeNull()
    Object.defineProperties(viewport!, {
      clientWidth: { configurable: true, value: 640 },
      clientHeight: { configurable: true, value: 480 },
    })

    click('approval-template-section-flow')
    await flushUi()

    const minimapWindow = q<SVGRectElement>('[data-testid="approval-canvas-minimap-window"]')
    expect(Number(minimapWindow?.getAttribute('width'))).toBeGreaterThan(0)
    expect(Number(minimapWindow?.getAttribute('height'))).toBeGreaterThan(0)
  })

  it('keeps every canvas surface absent for a linear draft while the flag is off', async () => {
    approvalCanvasV2.value = false
    routeParams = { id: 'tpl_linear_flag_off' }
    await mountView()
    await flushUi()

    expect(q('[data-testid="approval-graph-view-toggle"]')).toBeNull()
    expect(q('[data-testid="approval-authoring-mode-switch"]')).toBeNull()
    expect(q('[data-testid="approval-canvas-workspace"]')).toBeNull()
    expect(q('[data-testid="approval-template-undo"]')).toBeNull()
    expect(q('[data-testid="approval-template-redo"]')).toBeNull()
    expect(q('[data-testid="approval-graph-canvas"]')).toBeNull()
    expect(visibleStepRows()).toHaveLength(2)
    expect(q('[data-testid="approval-template-step-spine"]')).not.toBeNull()
  })

  it('keeps edge insertion inert in read-only mode', async () => {
    canManageTemplates.value = false
    routeParams = { id: 'tpl_edge_insert_readonly' }
    await mountView()
    await flushUi()

    expect(q('[data-testid="approval-canvas-workspace"]')).not.toBeNull()
    expect(q('[data-testid^="approval-canvas-edge-insert-"]')).toBeNull()
    expect(all('[data-testid="approval-canvas-edge"]').length).toBeGreaterThan(0)
  })

  it('keeps the canvas absent for an UNSUPPORTED template even with the flag on (fail-closed)', async () => {
    routeParams = { id: 'tpl_linear_unsupported' }
    getTemplateSpy.mockResolvedValue(buildTemplate({
      // An attachment field makes the whole template un-authorable: its `steps` projection is not a
      // faithful carrier, so no structural surface may be offered for it.
      formSchema: { fields: [{ id: 'file', type: 'attachment', label: '附件' }] } as any,
    }))
    await mountView()
    await flushUi()

    expect(q('[data-testid="approval-graph-view-toggle"]')).toBeNull()
    expect(q('[data-testid="approval-canvas-workspace"]')).toBeNull()
  })

  it('opening and selecting on the linear canvas leaves the draft clean and the payload identical', async () => {
    routeParams = { id: 'tpl_linear_viewonly' }

    // Baseline: load → save, no canvas interaction at all.
    await mountView()
    await flushUi()
    await saveDraft()
    const baseline = lastUpdatePayload()
    // Requirement: an untouched linear template round-trips its graph verbatim.
    expect(baseline.approvalGraph).toEqual(buildLinearGraph())
    unmountView()

    updateTemplateSpy.mockClear()
    await mountView()
    await flushUi()
    click('approval-view-canvas')
    await flushUi()
    clickCanvasNode('approval_2')
    await flushUi()
    // The inspector is open on a real step node…
    expect(q('[data-testid="approval-canvas-inspector"]')?.getAttribute('data-inspector-node')).toBe('approval_2')
    // …and NOTHING was written: the dirty baseline still matches.
    const saveState = q('.template-authoring__save-state')!
    expect(saveState.classList.contains('template-authoring__save-state--dirty')).toBe(false)
    expect(saveState.textContent?.trim()).toBe('已保存')

    click('approval-canvas-inspector-close')
    await flushUi()
    click('approval-view-list')
    await flushUi()
    await saveDraft()
    expect(lastUpdatePayload()).toEqual(baseline)
  })

  it('linear inspector edits write through to the step carrier the step cards read', async () => {
    routeParams = { id: 'tpl_linear_inspector' }
    await mountView()
    await flushUi()
    click('approval-view-canvas')
    await flushUi()
    clickCanvasNode('approval_1')
    await flushUi()

    const inspector = '[data-testid="approval-canvas-inspector"] '
    expect(q(`${inspector}[data-testid="approval-node-editor"]`)).not.toBeNull()
    // Seeded FROM the step (single / error / merge off), not from a blank shadow default.
    expect(q<HTMLSelectElement>(`${inspector}[data-testid="approval-node-source-kind"]`)!.value).toBe('direct_manager')
    expect(q<HTMLSelectElement>(`${inspector}[data-testid="approval-node-mode"]`)!.value).toBe('single')
    expect(q<HTMLSelectElement>(`${inspector}[data-testid="approval-node-empty-policy"]`)!.value).toBe('error')

    selectValue('approval-node-source-kind', 'manager_at_level', inspector)
    await flushUi()
    const level = q<HTMLInputElement>(`${inspector}[data-testid="approval-node-source-level"]`)!
    level.value = '3'
    level.dispatchEvent(new Event('input'))
    selectValue('approval-node-mode', 'all', inspector)
    selectValue('approval-node-empty-policy', 'auto-approve', inspector)
    const merge = q<HTMLInputElement>(`${inspector}[data-testid="approval-node-merge-with-requester"]`)!
    merge.checked = true
    merge.dispatchEvent(new Event('change'))
    selectValue('approval-node-field-access-amount', 'hidden', inspector)
    await flushUi()

    // Same carrier, not a copy: the STEP CARD controls now read the inspector's values, and the
    // draft is still LINEAR (no promotion, no complex read-only list).
    click('approval-view-list')
    await flushUi()
    expect(q('[data-testid="approval-graph-readonly-list"]')).toBeNull()
    const stepCard = all('[data-testid="approval-template-step-row"]')[0]
    expect((stepCard.querySelector('[data-testid="approval-step-source-kind"]') as HTMLSelectElement).value).toBe('manager_at_level')
    expect((stepCard.querySelector('[data-testid="approval-step-level"]') as HTMLInputElement).value).toBe('3')
    expect((stepCard.querySelector('[data-testid="approval-step-merge-with-requester"]') as HTMLInputElement).checked).toBe(true)
    expect((stepCard.querySelector('[data-testid="approval-step-field-access-amount"]') as HTMLSelectElement).value).toBe('hidden')

    await saveDraft()
    const node = lastUpdatePayload().approvalGraph.nodes.find((n: any) => n.key === 'approval_1')
    expect(node.config).toEqual({
      assigneeSources: [{ kind: 'manager_at_level', level: 3 }],
      approvalMode: 'all',
      emptyAssigneePolicy: 'auto-approve',
      autoApprovalPolicy: { mergeWithRequester: true },
      fieldPermissions: [{ fieldId: 'amount', access: 'hidden' }],
    })
    // The untouched sibling step is unaffected — the write targeted one carrier.
    expect(lastUpdatePayload().approvalGraph.nodes.find((n: any) => n.key === 'approval_2').config)
      .toEqual(LINEAR_STEP_2_CONFIG)
  })

  it('linear inspector role picker writes the step idsText carrier', async () => {
    routeParams = { id: 'tpl_linear_ids' }
    await mountView()
    await flushUi()
    click('approval-view-canvas')
    await flushUi()
    clickCanvasNode('approval_2')
    await flushUi()

    const inspector = '[data-testid="approval-canvas-inspector"] '
    const picker = q<HTMLSelectElement>(`${inspector}[data-testid="approval-node-source-role-picker"]`)!
    expect(picker).not.toBeNull()
    // Seeded from the step's own idsText carrier (hydrated as `role_legal`), not from an empty copy.
    expect(picker.getAttribute('data-model')).toBe(JSON.stringify(['role_legal']))
    for (const option of Array.from(picker.options)) option.selected = option.value === 'role_finance'
    picker.dispatchEvent(new Event('change'))
    await flushUi()

    click('approval-view-list')
    await flushUi()
    const stepCard = all('[data-testid="approval-template-step-row"]')[1]
    const listPicker = stepCard.querySelector('[data-testid="approval-step-role-picker"]') as HTMLSelectElement
    expect(listPicker.getAttribute('data-model')).toBe(JSON.stringify(['role_finance']))

    await saveDraft()
    expect(lastUpdatePayload().approvalGraph.nodes.find((n: any) => n.key === 'approval_2').config.assigneeSources)
      .toEqual([{ kind: 'static_role', roleIds: ['role_finance'] }])
  })

  it('the first structural canvas edit promotes the linear draft, preserving graph and config', async () => {
    routeParams = { id: 'tpl_linear_promote' }
    await mountView()
    await flushUi()
    click('approval-view-canvas')
    await flushUi()
    expect(q('[data-testid="approval-graph-readonly-list"]')).toBeNull()

    await openEdgeInsertMenu('edge-approval_1-approval_2')
    click('approval-canvas-edge-option-edge-approval_1-approval_2-approval')
    await flushUi()

    // Promoted: the canvas grew by one node and the structured view is now the graph node list.
    expect(all('[data-testid="approval-canvas-node"]')).toHaveLength(5)
    const selectedNode = q('[data-testid="approval-canvas-node"].is-selected')
    const insertedNodeKey = selectedNode?.getAttribute('data-canvas-node')
    expect(insertedNodeKey).not.toBeNull()
    expect(q('[data-testid="approval-canvas-inspector"]')?.getAttribute('data-inspector-type')).toBe('approval')

    click('approval-template-undo')
    await flushUi()
    expect(all('[data-testid="approval-canvas-node"]')).toHaveLength(4)
    expect(q(`[data-canvas-node="${insertedNodeKey}"]`)).toBeNull()

    click('approval-template-redo')
    await flushUi()
    expect(all('[data-testid="approval-canvas-node"]')).toHaveLength(5)
    expect(q(`[data-canvas-node="${insertedNodeKey}"]`)?.classList.contains('is-selected')).toBe(true)
    click('approval-view-list')
    await flushUi()
    expect(q('[data-testid="approval-graph-readonly-list"]')).not.toBeNull()
    expect(visibleStepRows()).toHaveLength(0)

    await saveDraft()
    const graph = lastUpdatePayload().approvalGraph
    const inserted = graph.nodes.find((n: any) => !['start', 'approval_1', 'approval_2', 'end'].includes(n.key))
    expect(inserted?.type).toBe('approval')
    // Every pre-existing node keeps its key, name and config — promotion preserved the EFFECTIVE
    // graph the linear steps produced, including step 2's mode / policy / merge / field permissions.
    for (const original of buildLinearGraph().nodes) {
      const preserved = graph.nodes.find((n: any) => n.key === original.key)
      expect(preserved, original.key).toBeTruthy()
      expect(preserved.name).toBe(original.name)
      expect(preserved.config).toEqual(original.config)
    }
    // …and it is wired in on the chain, not dangling.
    const targetOf = (source: string) => graph.edges.find((edge: any) => edge.source === source)?.target
    expect(targetOf('start')).toBe('approval_1')
    expect(targetOf('approval_1')).toBe(inserted.key)
    expect(targetOf(inserted.key)).toBe('approval_2')
    expect(targetOf('approval_2')).toBe('end')
  })

  it('never offers a canvas delete for the last approval before or after graph promotion', async () => {
    routeParams = { id: 'tpl_linear_last_step' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildSingleStepLinearGraph() as any }))
    await mountView()
    await flushUi()
    click('approval-view-canvas')
    await flushUi()
    // The step card disables 删除 at one step; the canvas must not become the bypass that promotes
    // an approver-less start→end graph.
    expect(q('[data-testid="approval-canvas-remove-approval_1"]')).toBeNull()
    unmountView()

    // Two steps → removable again (positive control: this is not a blanket disable).
    getTemplateSpy.mockResolvedValue(buildTemplate())
    await mountView()
    await flushUi()
    click('approval-view-canvas')
    await flushUi()
    expect(q('[data-testid="approval-canvas-remove-approval_1"]')).not.toBeNull()

    // The delete promotes the draft to preservedGraph. The remaining approval must retain the same
    // floor after that carrier transition; otherwise a second click can create start→end.
    click('approval-canvas-remove-approval_1')
    await flushUi()
    expect(all('[data-testid="approval-canvas-node"]')).toHaveLength(3)
    expect(q('[data-testid="approval-canvas-remove-approval_2"]')).toBeNull()
  })

  it('leaves the preserved complex graph round-trip unchanged', async () => {
    routeParams = { id: 'tpl_complex_roundtrip' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildComplexGraph() as any }))
    await mountView()
    await flushUi()

    // Canvas V2 is canvas-first for both linear and preserved complex graphs.
    expect(q('[data-testid="approval-canvas-workspace"]')).not.toBeNull()
    expect(q('[data-testid="approval-graph-readonly-list"]')).toBeNull()
    expect(visibleStepRows()).toHaveLength(0)

    // The accessible structured fallback remains available until equivalence is proven.
    click('approval-view-list')
    await flushUi()
    expect(q('[data-testid="approval-graph-readonly-list"]')).not.toBeNull()
    expect(visibleStepRows()).toHaveLength(0)

    click('approval-view-canvas')
    await flushUi()
    clickCanvasNode('cond_1')
    await flushUi()
    expect(q('[data-testid="approval-canvas-inspector"]')?.getAttribute('data-inspector-type')).toBe('condition')
    clickCanvasNode('approval_high')
    await flushUi()
    expect(q('[data-testid="approval-canvas-inspector"] [data-testid="approval-node-editor"]')).not.toBeNull()

    await saveDraft()
    expect(lastUpdatePayload().approvalGraph).toEqual(buildComplexGraph())
  })
})
