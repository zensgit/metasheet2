/* eslint-disable vue/one-component-per-file, vue/require-default-prop */
/**
 * Canvas V2 Slice A — selection opens the right-side inspector; edits write through the SAME
 * draft handlers as structured-list mode; delete clears selection; read-only blocks mutation.
 * Also pins child-owned scoped styles (parent scoped CSS cannot reach the extracted editor).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import TemplateAuthoringView from '../src/views/approval/TemplateAuthoringView.vue'
import type { ApprovalTemplateDetailDTO } from '../src/types/approval'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHILD_EDITOR_SOURCE = readFileSync(
  join(HERE, '../src/approvals/components/ApprovalGraphNodeConfigEditor.vue'),
  'utf8',
)
const PARENT_AUTHORING_SOURCE = readFileSync(
  join(HERE, '../src/views/approval/TemplateAuthoringView.vue'),
  'utf8',
)
const FLOW_CANVAS_SOURCE = readFileSync(
  join(HERE, '../src/approvals/components/ApprovalFlowCanvas.vue'),
  'utf8',
)

const pushSpy = vi.fn().mockResolvedValue(undefined)
const replaceSpy = vi.fn().mockResolvedValue(undefined)
let routeParams: Record<string, string> = {}
const routeVersion = ref(0)
const reactiveRouteParams = new Proxy({} as Record<string, string>, {
  get: (_target, key: string) => {
    void routeVersion.value
    return routeParams[key]
  },
})

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
      params: reactiveRouteParams,
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

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    features: ref({ approvalCanvasV2: true }),
  }),
}))

const createTemplateSpy = vi.fn()
const updateTemplateSpy = vi.fn()
const publishTemplateSpy = vi.fn()
const getTemplateSpy = vi.fn()
const dryRunApprovalConditionFormulaSpy = vi.fn()

vi.mock('../src/approvals/api', () => ({
  createTemplate: (payload: unknown) => createTemplateSpy(payload),
  updateTemplate: (id: string, payload: unknown) => updateTemplateSpy(id, payload),
  publishTemplate: (id: string, payload: unknown) => publishTemplateSpy(id, payload),
  getTemplate: (id: string) => getTemplateSpy(id),
  dryRunApprovalConditionFormula: (payload: unknown) => dryRunApprovalConditionFormulaSpy(payload),
}))

vi.mock('element-plus', () => ({
  ElMessage: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
  ElMessageBox: {
    confirm: vi.fn().mockResolvedValue(undefined),
  },
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

const ElSelect = defineComponent({
  name: 'ElSelect',
  props: { modelValue: [String, Array], disabled: Boolean },
  emits: ['update:modelValue', 'change'],
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

const passthrough = (name: string, tag = 'div') => defineComponent({
  name,
  render() {
    return h(tag, {
      'data-testid': (this.$attrs as any)?.['data-testid'],
    }, this.$slots.default?.())
  },
})

const ElAlert = defineComponent({
  name: 'ElAlert',
  props: { title: String, description: String },
  render() {
    return h('div', {
      'data-testid': (this.$attrs as any)?.['data-testid'],
    }, [
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
    return h('div', {
      'data-testid': (this.$attrs as any)?.['data-testid'],
    }, [this.$slots.default?.(), this.$slots.footer?.()])
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

function buildTemplate(overrides: Partial<ApprovalTemplateDetailDTO> = {}): ApprovalTemplateDetailDTO {
  return {
    id: 'tpl_canvas_inspector',
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
      fields: [
        { id: 'amount', type: 'number', label: '金额', required: true },
        { id: 'reviewer', type: 'user', label: '审批人' },
      ],
    },
    approvalGraph: {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          name: '审批人 1',
          config: {
            assigneeSources: [{ kind: 'direct_manager' }],
            approvalMode: 'single',
            emptyAssigneePolicy: 'error',
          },
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

/** Complex graph covering approval + condition + parallel + cc for inspector type routing. */
function buildMixedGraph() {
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
      {
        key: 'approval_high',
        type: 'approval',
        name: '高额审批',
        config: {
          assigneeSources: [{ kind: 'dept_head' }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
        },
      },
      {
        key: 'cc_1',
        type: 'cc',
        name: '抄送财务',
        config: { targetType: 'user', targetIds: ['u_finance'] },
      },
      {
        key: 'fork_1',
        type: 'parallel',
        name: '并行审批',
        config: { branches: ['e-fork-a', 'e-fork-b'], joinMode: 'all', joinNodeKey: 'join_1' },
      },
      {
        key: 'app_a',
        type: 'approval',
        name: '分支 A',
        config: {
          assigneeSources: [{ kind: 'requester' }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
        },
      },
      {
        key: 'app_b',
        type: 'approval',
        name: '分支 B',
        config: {
          assigneeSources: [{ kind: 'static_role', roleIds: ['legal'] }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
        },
      },
      {
        key: 'join_1',
        type: 'approval',
        name: '汇聚',
        config: {
          assigneeSources: [{ kind: 'direct_manager' }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
        },
      },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'e-start-c', source: 'start', target: 'cond_1' },
      { key: 'e-high', source: 'cond_1', target: 'approval_high' },
      { key: 'e-low', source: 'cond_1', target: 'cc_1' },
      { key: 'e-high-cc', source: 'approval_high', target: 'cc_1' },
      { key: 'e-cc-fork', source: 'cc_1', target: 'fork_1' },
      { key: 'e-fork-a', source: 'fork_1', target: 'app_a' },
      { key: 'e-fork-b', source: 'fork_1', target: 'app_b' },
      { key: 'e-a-join', source: 'app_a', target: 'join_1' },
      { key: 'e-b-join', source: 'app_b', target: 'join_1' },
      { key: 'e-join-end', source: 'join_1', target: 'end' },
    ],
  }
}

function buildLinearReorderGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      { key: 'app_a', type: 'approval', name: '审批 A', config: { assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'cc_b', type: 'cc', name: '抄送 B', config: { targetType: 'user', targetIds: ['u_finance'] } },
      { key: 'app_c', type: 'approval', name: '审批 C', config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'e-start-a', source: 'start', target: 'app_a' },
      { key: 'e-a-b', source: 'app_a', target: 'cc_b' },
      { key: 'e-b-c', source: 'cc_b', target: 'app_c' },
      { key: 'e-c-end', source: 'app_c', target: 'end' },
    ],
  }
}

function buildBranchReorderGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      {
        key: 'cond_1',
        type: 'condition',
        name: '金额判断',
        config: {
          branches: [
            { edgeKey: 'e-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }], conjunction: 'and' },
            { edgeKey: 'e-medium', rules: [{ fieldId: 'amount', operator: 'gte', value: 500 }], conjunction: 'and' },
          ],
          defaultEdgeKey: 'e-default',
        },
      },
      { key: 'high_a', type: 'approval', name: '高额初审', config: { assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'high_b', type: 'approval', name: '高额复审', config: { assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'medium', type: 'approval', name: '中额审批', config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'fallback', type: 'cc', name: '默认抄送', config: { targetType: 'role', targetIds: ['finance'] } },
      { key: 'merge', type: 'cc', name: '条件汇合', config: { targetType: 'role', targetIds: ['audit'] } },
      { key: 'fork_1', type: 'parallel', name: '并行审批', config: { branches: ['e-fork-a', 'e-fork-b'], joinMode: 'all', joinNodeKey: 'join_1' } },
      { key: 'app_a', type: 'approval', name: '分支 A', config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'app_b', type: 'approval', name: '分支 B', config: { assigneeSources: [{ kind: 'static_role', roleIds: ['legal'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'join_1', type: 'approval', name: '汇聚', config: { assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'e-start-c', source: 'start', target: 'cond_1' },
      { key: 'e-high', source: 'cond_1', target: 'high_a' },
      { key: 'e-high-a-b', source: 'high_a', target: 'high_b' },
      { key: 'e-high-merge', source: 'high_b', target: 'merge' },
      { key: 'e-medium', source: 'cond_1', target: 'medium' },
      { key: 'e-medium-merge', source: 'medium', target: 'merge' },
      { key: 'e-default', source: 'cond_1', target: 'fallback' },
      { key: 'e-default-merge', source: 'fallback', target: 'merge' },
      { key: 'e-merge-fork', source: 'merge', target: 'fork_1' },
      { key: 'e-fork-a', source: 'fork_1', target: 'app_a' },
      { key: 'e-fork-b', source: 'fork_1', target: 'app_b' },
      { key: 'e-a-join', source: 'app_a', target: 'join_1' },
      { key: 'e-b-join', source: 'app_b', target: 'join_1' },
      { key: 'e-join-end', source: 'join_1', target: 'end' },
    ],
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

function clickCanvasNode(nodeKey: string) {
  const node = container!.querySelector(`[data-testid="approval-canvas-node"][data-canvas-node="${nodeKey}"]`) as HTMLElement | null
  expect(node, `canvas node ${nodeKey}`).not.toBeNull()
  node!.click()
}

function createDragDataTransfer(): DataTransfer {
  const data = new Map<string, string>()
  return {
    dropEffect: 'none',
    effectAllowed: 'uninitialized',
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [],
    clearData: (format?: string) => {
      if (format) data.delete(format)
      else data.clear()
    },
    getData: (format: string) => data.get(format) ?? '',
    setData: (format: string, value: string) => { data.set(format, value) },
    setDragImage: vi.fn(),
  }
}

function createDragEvent(type: 'dragstart' | 'dragend' | 'drop', dataTransfer: DataTransfer): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  return event
}

describe('Canvas V2 Slice A — canvas inspector', () => {
  beforeEach(() => {
    routeParams = {}
    routeVersion.value = 0
    canManageTemplates.value = true
    createTemplateSpy.mockReset()
    updateTemplateSpy.mockReset()
    publishTemplateSpy.mockReset()
    getTemplateSpy.mockReset()
    dryRunApprovalConditionFormulaSpy.mockReset()
    pushSpy.mockClear()
    replaceSpy.mockClear()
    updateTemplateSpy.mockImplementation(async (id, payload) => ({
      ...buildTemplate({ id }),
      ...payload,
    }))
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
  })

  it('selecting approval/condition/cc/parallel nodes opens the matching right-side inspector', async () => {
    routeParams = { id: 'tpl_inspector_types' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildMixedGraph() as any }))
    await mountView()
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-view-canvas"]') as HTMLButtonElement).click()
    await flushUi()

    expect(container!.querySelector('[data-testid="approval-canvas-workspace"]')).not.toBeNull()
    expect(container!.querySelector('[data-testid="approval-canvas-inspector"]')).toBeNull()

    clickCanvasNode('approval_high')
    await flushUi()
    let inspector = container!.querySelector('[data-testid="approval-canvas-inspector"]') as HTMLElement
    expect(inspector).not.toBeNull()
    expect(inspector.getAttribute('data-inspector-node')).toBe('approval_high')
    expect(inspector.getAttribute('data-inspector-type')).toBe('approval')
    expect(inspector.querySelector('[data-testid="approval-node-editor"]')).not.toBeNull()
    expect(inspector.querySelector('[data-testid="approval-node-source-kind"]')).not.toBeNull()

    clickCanvasNode('cond_1')
    await flushUi()
    inspector = container!.querySelector('[data-testid="approval-canvas-inspector"]') as HTMLElement
    expect(inspector.getAttribute('data-inspector-node')).toBe('cond_1')
    expect(inspector.getAttribute('data-inspector-type')).toBe('condition')
    expect(inspector.querySelector('[data-testid="approval-condition-editor"]')).not.toBeNull()

    clickCanvasNode('cc_1')
    await flushUi()
    inspector = container!.querySelector('[data-testid="approval-canvas-inspector"]') as HTMLElement
    expect(inspector.getAttribute('data-inspector-node')).toBe('cc_1')
    expect(inspector.getAttribute('data-inspector-type')).toBe('cc')
    expect(inspector.querySelector('[data-testid="approval-cc-editor"]')).not.toBeNull()

    clickCanvasNode('fork_1')
    await flushUi()
    inspector = container!.querySelector('[data-testid="approval-canvas-inspector"]') as HTMLElement
    expect(inspector.getAttribute('data-inspector-node')).toBe('fork_1')
    expect(inspector.getAttribute('data-inspector-type')).toBe('parallel')
    expect(inspector.querySelector('[data-testid="approval-parallel-editor"]')).not.toBeNull()
    expect(inspector.querySelector('[data-testid="approval-parallel-join-mode"]')).not.toBeNull()
  })

  it('opens the inspector from the keyboard-accessible node selector', async () => {
    routeParams = { id: 'tpl_inspector_keyboard' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildMixedGraph() as any }))
    await mountView()
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-view-canvas"]') as HTMLButtonElement).click()
    await flushUi()

    const node = container!.querySelector(
      '[data-canvas-node="cond_1"] [data-testid="approval-canvas-node-select"]',
    ) as HTMLElement
    expect(node.getAttribute('role')).toBe('button')
    expect(node.tabIndex).toBe(0)
    expect(node.getAttribute('aria-label')).toContain('金额判断')

    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushUi()

    const inspector = container!.querySelector('[data-testid="approval-canvas-inspector"]') as HTMLElement
    expect(inspector?.getAttribute('data-inspector-node')).toBe('cond_1')
    expect(node.getAttribute('aria-pressed')).toBe('true')
  })

  it('renders navigation controls and persists semantic drag/drop plus Alt+Arrow reorder', async () => {
    routeParams = { id: 'tpl_canvas_navigation' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildLinearReorderGraph() as any }))
    await mountView()
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-view-canvas"]') as HTMLButtonElement).click()
    await flushUi()

    expect(container!.querySelector('[data-testid="approval-canvas-toolbar"]')).not.toBeNull()
    expect(container!.querySelector('[data-testid="approval-canvas-minimap"]')).not.toBeNull()
    const zoomLabel = container!.querySelector('[data-testid="approval-canvas-zoom-label"]') as HTMLButtonElement
    expect(zoomLabel.textContent).toContain('100%')
    expect(zoomLabel.getAttribute('aria-label')).toBe('重置画布缩放为 100%')

    ;(container!.querySelector('[data-testid="approval-canvas-zoom-in"]') as HTMLButtonElement).click()
    await flushUi()
    expect(container!.querySelector('[data-testid="approval-canvas-zoom-label"]')?.textContent).toContain('125%')

    const surface = container!.querySelector('[data-testid="approval-graph-canvas"]') as HTMLElement
    expect(surface.style.transform).toBe('scale(1.25)')

    const node = container!.querySelector('[data-canvas-node="cc_b"]') as HTMLElement
    const dataTransfer = createDragDataTransfer()
    node.dispatchEvent(createDragEvent('dragstart', dataTransfer))
    await flushUi()
    const dropTarget = container!.querySelector('[data-testid="approval-canvas-move-target-e-start-a"]') as HTMLButtonElement
    expect(dropTarget).not.toBeNull()
    dropTarget.dispatchEvent(createDragEvent('drop', dataTransfer))
    await flushUi()

    const movedNode = container!.querySelector('[data-canvas-node="cc_b"]') as HTMLElement
    const appA = container!.querySelector('[data-canvas-node="app_a"]') as HTMLElement
    expect(Number.parseFloat(movedNode.style.top)).toBeLessThan(Number.parseFloat(appA.style.top))

    ;(container!.querySelector('[data-testid="approval-template-undo"]') as HTMLButtonElement).click()
    await flushUi()
    expect(Number.parseFloat((container!.querySelector('[data-canvas-node="cc_b"]') as HTMLElement).style.top))
      .toBeGreaterThan(Number.parseFloat((container!.querySelector('[data-canvas-node="app_a"]') as HTMLElement).style.top))

    ;(container!.querySelector('[data-testid="approval-template-redo"]') as HTMLButtonElement).click()
    await flushUi()
    expect(Number.parseFloat((container!.querySelector('[data-canvas-node="cc_b"]') as HTMLElement).style.top))
      .toBeLessThan(Number.parseFloat((container!.querySelector('[data-canvas-node="app_a"]') as HTMLElement).style.top))

    const selector = container!.querySelector(
      '[data-canvas-node="cc_b"] [data-testid="approval-canvas-node-select"]',
    ) as HTMLElement
    selector.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))
    await flushUi()
    expect(Number.parseFloat(movedNode.style.top)).toBeGreaterThan(Number.parseFloat(appA.style.top))

    zoomLabel.click()
    await flushUi()
    expect(surface.style.transform).toBe('scale(1)')

    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()
    const payload = updateTemplateSpy.mock.calls.at(-1)?.[1] as any
    expect(payload.approvalGraph.edges).toEqual(buildLinearReorderGraph().edges)
  })

  it('keeps every legal edge slot highlighted and rejects outside or expired node drops without a write', async () => {
    routeParams = { id: 'tpl_canvas_drag_reject' }
    const graph = buildLinearReorderGraph()
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: graph as any }))
    await mountView()
    await flushUi()

    const node = container!.querySelector('[data-canvas-node="cc_b"]') as HTMLElement
    const outsideTransfer = createDragDataTransfer()
    node.dispatchEvent(createDragEvent('dragstart', outsideTransfer))
    await flushUi()

    const targets = Array.from(container!.querySelectorAll('[data-testid^="approval-canvas-move-target-"]'))
    expect(targets.map((target) => target.getAttribute('data-testid')).sort()).toEqual([
      'approval-canvas-move-target-e-c-end',
      'approval-canvas-move-target-e-start-a',
    ])
    expect(targets.every((target) => target.getAttribute('data-drag-active') === 'true')).toBe(true)
    targets[0].dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }))
    await flushUi()
    expect(container!.querySelectorAll('[data-testid^="approval-canvas-move-target-"]')).toHaveLength(2)

    node.dispatchEvent(createDragEvent('dragend', outsideTransfer))
    await flushUi()
    const liveRegion = container!.querySelector('[data-testid="approval-canvas-live-message"]') as HTMLElement
    expect(liveRegion.textContent).toBe('该位置不能放置此节点')
    expect(liveRegion.textContent).not.toMatch(/cc_b|e-start-a/)

    const currentNode = container!.querySelector('[data-canvas-node="cc_b"]') as HTMLElement
    const activeTransfer = createDragDataTransfer()
    currentNode.dispatchEvent(createDragEvent('dragstart', activeTransfer))
    await flushUi()
    const legalTarget = container!.querySelector(
      '[data-testid="approval-canvas-move-target-e-start-a"]',
    ) as HTMLElement
    expect(legalTarget).not.toBeNull()
    const expiredTransfer = createDragDataTransfer()
    expiredTransfer.setData('application/x-metasheet-approval-canvas-node', '{"token":0}')
    legalTarget.dispatchEvent(createDragEvent('drop', expiredTransfer))
    await flushUi()
    expect(liveRegion.textContent).toBe('该位置不能放置此节点')

    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()
    const payload = updateTemplateSpy.mock.calls.at(-1)?.[1] as any
    expect(payload.approvalGraph.edges).toEqual(graph.edges)
  })

  it('does not expose a cross-region node drop slot and announces the rejected release', async () => {
    routeParams = { id: 'tpl_canvas_cross_region' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildBranchReorderGraph() as any }))
    await mountView()
    await flushUi()

    const node = container!.querySelector('[data-canvas-node="high_a"]') as HTMLElement
    const dataTransfer = createDragDataTransfer()
    node.dispatchEvent(createDragEvent('dragstart', dataTransfer))
    await flushUi()

    expect(container!.querySelector('[data-testid="approval-canvas-move-target-e-high-merge"]')).not.toBeNull()
    expect(container!.querySelector('[data-testid="approval-canvas-move-target-e-medium-merge"]')).toBeNull()
    expect(container!.querySelector('[data-testid="approval-canvas-move-target-e-default-merge"]')).toBeNull()

    node.dispatchEvent(createDragEvent('dragend', dataTransfer))
    await flushUi()
    const message = container!.querySelector('[data-testid="approval-canvas-live-message"]')?.textContent ?? ''
    expect(message).toBe('该位置不能放置此节点')
    expect(message).not.toMatch(/high_a|e-medium/)
  })

  it('reorders condition priority and parallel branches by handle drag with keyboard-equivalent commands', async () => {
    routeParams = { id: 'tpl_canvas_branch_reorder' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildBranchReorderGraph() as any }))
    await mountView()
    await flushUi()

    clickCanvasNode('cond_1')
    await flushUi()
    let panel = container!.querySelector('[data-testid="approval-canvas-branch-reorder"]') as HTMLElement
    expect(panel.textContent).toContain('条件分支优先级')
    expect(panel.textContent).toContain('优先级 1')
    expect(panel.textContent).toContain('优先级 2')
    expect(panel.textContent).not.toMatch(/e-high|e-medium|e-default/)
    expect(panel.querySelectorAll('[draggable="true"]')).toHaveLength(2)
    expect(Array.from(panel.querySelectorAll('[draggable="true"]')).every((element) =>
      element.matches('[data-testid^="approval-canvas-branch-handle-"]'))).toBe(true)

    let dataTransfer = createDragDataTransfer()
    ;(panel.querySelector('[data-testid="approval-canvas-branch-handle-e-high"]') as HTMLElement)
      .dispatchEvent(createDragEvent('dragstart', dataTransfer))
    ;(panel.querySelector('[data-testid="approval-canvas-branch-row-e-medium"]') as HTMLElement)
      .dispatchEvent(createDragEvent('drop', dataTransfer))
    await flushUi()

    const branchOrder = (host: HTMLElement) => Array.from(
      host.querySelectorAll<HTMLElement>('[data-testid^="approval-canvas-branch-row-"]'),
    ).map((row) => row.dataset.testid!.replace('approval-canvas-branch-row-', ''))
    panel = container!.querySelector('[data-testid="approval-canvas-branch-reorder"]') as HTMLElement
    expect(branchOrder(panel)).toEqual(['e-medium', 'e-high'])
    ;(container!.querySelector('[data-testid="approval-template-undo"]') as HTMLButtonElement).click()
    await flushUi()
    panel = container!.querySelector('[data-testid="approval-canvas-branch-reorder"]') as HTMLElement
    expect(branchOrder(panel)).toEqual(['e-high', 'e-medium'])
    ;(container!.querySelector('[data-testid="approval-template-redo"]') as HTMLButtonElement).click()
    await flushUi()
    panel = container!.querySelector('[data-testid="approval-canvas-branch-reorder"]') as HTMLElement
    expect(branchOrder(panel)).toEqual(['e-medium', 'e-high'])

    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()
    let payload = updateTemplateSpy.mock.calls.at(-1)?.[1] as any
    let condition = payload.approvalGraph.nodes.find((candidate: any) => candidate.key === 'cond_1')
    expect(condition.config.branches.map((branch: any) => branch.edgeKey)).toEqual(['e-medium', 'e-high'])
    expect(condition.config.defaultEdgeKey).toBe('e-default')

    panel = container!.querySelector('[data-testid="approval-canvas-branch-reorder"]') as HTMLElement
    ;(panel.querySelector('[data-testid="approval-canvas-branch-handle-e-high"]') as HTMLElement)
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }))
    await flushUi()
    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()
    payload = updateTemplateSpy.mock.calls.at(-1)?.[1] as any
    condition = payload.approvalGraph.nodes.find((candidate: any) => candidate.key === 'cond_1')
    expect(condition.config.branches.map((branch: any) => branch.edgeKey)).toEqual(['e-high', 'e-medium'])

    clickCanvasNode('fork_1')
    await flushUi()
    panel = container!.querySelector('[data-testid="approval-canvas-branch-reorder"]') as HTMLElement
    expect(panel.textContent).toContain('并行分支顺序')
    dataTransfer = createDragDataTransfer()
    ;(panel.querySelector('[data-testid="approval-canvas-branch-handle-e-fork-b"]') as HTMLElement)
      .dispatchEvent(createDragEvent('dragstart', dataTransfer))
    ;(panel.querySelector('[data-testid="approval-canvas-branch-row-e-fork-a"]') as HTMLElement)
      .dispatchEvent(createDragEvent('drop', dataTransfer))
    await flushUi()

    panel = container!.querySelector('[data-testid="approval-canvas-branch-reorder"]') as HTMLElement
    expect(branchOrder(panel)).toEqual(['e-fork-b', 'e-fork-a'])
    ;(container!.querySelector('[data-testid="approval-template-undo"]') as HTMLButtonElement).click()
    await flushUi()
    panel = container!.querySelector('[data-testid="approval-canvas-branch-reorder"]') as HTMLElement
    expect(branchOrder(panel)).toEqual(['e-fork-a', 'e-fork-b'])
    ;(container!.querySelector('[data-testid="approval-template-redo"]') as HTMLButtonElement).click()
    await flushUi()
    panel = container!.querySelector('[data-testid="approval-canvas-branch-reorder"]') as HTMLElement
    expect(branchOrder(panel)).toEqual(['e-fork-b', 'e-fork-a'])

    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()
    payload = updateTemplateSpy.mock.calls.at(-1)?.[1] as any
    let parallel = payload.approvalGraph.nodes.find((candidate: any) => candidate.key === 'fork_1')
    expect(parallel.config.branches).toEqual(['e-fork-b', 'e-fork-a'])
    expect(parallel.config.joinMode).toBe('all')
    expect(parallel.config.joinNodeKey).toBe('join_1')

    panel = container!.querySelector('[data-testid="approval-canvas-branch-reorder"]') as HTMLElement
    ;(panel.querySelector('[data-testid="approval-canvas-branch-handle-e-fork-b"]') as HTMLElement)
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))
    await flushUi()
    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()
    payload = updateTemplateSpy.mock.calls.at(-1)?.[1] as any
    parallel = payload.approvalGraph.nodes.find((candidate: any) => candidate.key === 'fork_1')
    expect(parallel.config.branches).toEqual(['e-fork-a', 'e-fork-b'])
  })

  it('shows business labels instead of internal topology keys in the inspector', async () => {
    routeParams = { id: 'tpl_inspector_labels' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildMixedGraph() as any }))
    await mountView()
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-view-canvas"]') as HTMLButtonElement).click()
    await flushUi()

    clickCanvasNode('cond_1')
    await flushUi()
    let inspector = container!.querySelector('[data-testid="approval-canvas-inspector"]') as HTMLElement
    expect(inspector.textContent).toContain('金额')
    expect(inspector.textContent).toContain('抄送财务')
    expect(inspector.textContent).not.toContain('e-high')
    expect(inspector.textContent).not.toContain('e-low')

    clickCanvasNode('fork_1')
    await flushUi()
    inspector = container!.querySelector('[data-testid="approval-canvas-inspector"]') as HTMLElement
    expect(inspector.textContent).toContain('分支 A')
    expect(inspector.textContent).toContain('分支 B')
    expect(inspector.textContent).toContain('汇聚')
    expect(inspector.textContent).not.toContain('e-fork-a')
    expect(inspector.textContent).not.toContain('e-fork-b')
    expect(inspector.textContent).not.toContain('join_1')

    clickCanvasNode('app_b')
    await flushUi()
    inspector = container!.querySelector('[data-testid="approval-canvas-inspector"]') as HTMLElement
    expect(inspector.textContent).not.toContain('legal')
    expect(inspector.textContent).not.toContain('amount')
    expect(inspector.textContent).not.toMatch(/JSON/i)
    expect(inspector.querySelector('[data-testid="approval-node-source-ids-text"]')).toBeNull()
  })

  it('uses a business type label when the selected node has no display name', async () => {
    routeParams = { id: 'tpl_inspector_unnamed' }
    const graph = buildMixedGraph()
    const ccNode = graph.nodes.find((node) => node.key === 'cc_1')!
    ccNode.name = ''
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: graph as any }))
    await mountView()
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-view-canvas"]') as HTMLButtonElement).click()
    await flushUi()
    clickCanvasNode('cc_1')
    await flushUi()

    const inspector = container!.querySelector('[data-testid="approval-canvas-inspector"]') as HTMLElement
    expect(inspector.textContent).toContain('抄送')
    expect(inspector.textContent).not.toContain('cc_1')
  })

  it('records inspector edits with focus-preserving shortcuts and clears redo on a divergent edit', async () => {
    routeParams = { id: 'tpl_inspector_edit' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildMixedGraph() as any }))
    await mountView()
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-view-canvas"]') as HTMLButtonElement).click()
    await flushUi()
    clickCanvasNode('fork_1')
    await flushUi()

    const joinMode = container!.querySelector(
      '[data-testid="approval-canvas-inspector"] [data-testid="approval-parallel-join-mode"]',
    ) as HTMLSelectElement
    expect(joinMode).not.toBeNull()
    expect(joinMode.disabled).toBe(false)
    const undo = container!.querySelector('[data-testid="approval-template-undo"]') as HTMLButtonElement
    const redo = container!.querySelector('[data-testid="approval-template-redo"]') as HTMLButtonElement
    expect(undo.title).toBe('撤销（Cmd/Ctrl+Z）')
    expect(undo.disabled).toBe(true)
    expect(redo.disabled).toBe(true)
    joinMode.value = 'any'
    joinMode.dispatchEvent(new Event('change'))
    await flushUi()
    expect(undo.disabled).toBe(false)

    joinMode.focus()
    const editableShortcut = new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
    })
    joinMode.dispatchEvent(editableShortcut)
    await flushUi()
    expect(editableShortcut.defaultPrevented).toBe(false)
    expect(joinMode.value).toBe('any')

    const undoShortcut = new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
    })
    window.dispatchEvent(undoShortcut)
    await flushUi()
    expect(undoShortcut.defaultPrevented).toBe(true)
    let restoredJoinMode = container!.querySelector(
      '[data-testid="approval-canvas-inspector"] [data-testid="approval-parallel-join-mode"]',
    ) as HTMLSelectElement
    expect(restoredJoinMode.value).toBe('all')
    expect(document.activeElement).toBe(restoredJoinMode)
    expect(redo.disabled).toBe(false)

    const redoShortcut = new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
    })
    window.dispatchEvent(redoShortcut)
    await flushUi()
    expect(redoShortcut.defaultPrevented).toBe(true)
    restoredJoinMode = container!.querySelector(
      '[data-testid="approval-canvas-inspector"] [data-testid="approval-parallel-join-mode"]',
    ) as HTMLSelectElement
    expect(restoredJoinMode.value).toBe('any')

    undo.click()
    await flushUi()
    restoredJoinMode = container!.querySelector(
      '[data-testid="approval-canvas-inspector"] [data-testid="approval-parallel-join-mode"]',
    ) as HTMLSelectElement
    restoredJoinMode.value = 'any'
    restoredJoinMode.dispatchEvent(new Event('change'))
    await flushUi()
    expect(redo.disabled).toBe(true)

    // Switching to list keeps a still-valid selection; the list surface shows the same draft value.
    ;(container!.querySelector('[data-testid="approval-view-list"]') as HTMLButtonElement).click()
    await flushUi()
    const listJoin = container!.querySelector('[data-testid="approval-parallel-join-mode"]') as HTMLSelectElement
    expect(listJoin.value).toBe('any')

    ;(container!.querySelector('[data-testid="approval-view-canvas"]') as HTMLButtonElement).click()
    await flushUi()
    // Selection preserved across list/canvas while the node still exists.
    const inspector = container!.querySelector('[data-testid="approval-canvas-inspector"]') as HTMLElement
    expect(inspector?.getAttribute('data-inspector-node')).toBe('fork_1')
    expect(
      (inspector.querySelector('[data-testid="approval-parallel-join-mode"]') as HTMLSelectElement).value,
    ).toBe('any')

    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()
    expect(updateTemplateSpy).toHaveBeenCalledTimes(1)
    const payload = updateTemplateSpy.mock.calls[0]?.[1] as any
    const parallel = payload.approvalGraph.nodes.find((n: any) => n.key === 'fork_1')
    expect(parallel.config.joinMode).toBe('any')
    // Topology preserved — branches/joinNodeKey untouched.
    expect(parallel.config.branches).toEqual(['e-fork-a', 'e-fork-b'])
    expect(parallel.config.joinNodeKey).toBe('join_1')
  })

  it('clears both history stacks when the mounted editor loads a different template', async () => {
    routeParams = { id: 'tpl_history_first' }
    getTemplateSpy.mockImplementation(async (id: string) => buildTemplate({
      id,
      approvalGraph: buildMixedGraph() as any,
    }))
    await mountView()
    await flushUi()

    clickCanvasNode('fork_1')
    await flushUi()
    const joinMode = container!.querySelector(
      '[data-testid="approval-canvas-inspector"] [data-testid="approval-parallel-join-mode"]',
    ) as HTMLSelectElement
    joinMode.value = 'any'
    joinMode.dispatchEvent(new Event('change'))
    await flushUi()
    expect((container!.querySelector('[data-testid="approval-template-undo"]') as HTMLButtonElement).disabled).toBe(false)

    routeParams = { id: 'tpl_history_second' }
    routeVersion.value += 1
    await flushUi()
    expect(getTemplateSpy).toHaveBeenLastCalledWith('tpl_history_second')
    expect((container!.querySelector('[data-testid="approval-template-undo"]') as HTMLButtonElement).disabled).toBe(true)
    expect((container!.querySelector('[data-testid="approval-template-redo"]') as HTMLButtonElement).disabled).toBe(true)

    const staleUndo = new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
    })
    window.dispatchEvent(staleUndo)
    expect(staleUndo.defaultPrevented).toBe(false)
  })

  it('records deletion and restores the deleted node selection through undo/redo', async () => {
    routeParams = { id: 'tpl_inspector_delete' }
    // Must be a COMPLEX graph (cc) so the canvas toggle mounts. Keep a second approval so
    // approval_mid is both a linear mid-chain node (1 in / 1 out) and legally removable under
    // the authoring floor that preserves at least one approval after deletion.
    getTemplateSpy.mockResolvedValue(buildTemplate({
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: '发起', config: {} },
          {
            key: 'approval_first',
            type: 'approval',
            name: '首轮审批',
            config: {
              assigneeSources: [{ kind: 'requester' }],
              approvalMode: 'single',
              emptyAssigneePolicy: 'error',
            },
          },
          {
            key: 'approval_mid',
            type: 'approval',
            name: '中间审批',
            config: {
              assigneeSources: [{ kind: 'direct_manager' }],
              approvalMode: 'single',
              emptyAssigneePolicy: 'error',
            },
          },
          {
            key: 'cc_1',
            type: 'cc',
            name: '抄送',
            config: { targetType: 'role', targetIds: ['finance'] },
          },
          { key: 'end', type: 'end', name: '结束', config: {} },
        ],
        edges: [
          { key: 'e-s-f', source: 'start', target: 'approval_first' },
          { key: 'e-f-m', source: 'approval_first', target: 'approval_mid' },
          { key: 'e-m-c', source: 'approval_mid', target: 'cc_1' },
          { key: 'e-c-e', source: 'cc_1', target: 'end' },
        ],
      },
    }))
    await mountView()
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-view-canvas"]') as HTMLButtonElement).click()
    await flushUi()
    clickCanvasNode('approval_mid')
    await flushUi()
    expect(container!.querySelector('[data-testid="approval-canvas-inspector"]')).not.toBeNull()

    ;(container!.querySelector('[data-testid="approval-canvas-remove-approval_mid"]') as HTMLButtonElement).click()
    await flushUi()
    expect(container!.querySelector('[data-canvas-node="approval_mid"]')).toBeNull()
    expect(container!.querySelector('[data-canvas-node="approval_first"]')?.classList.contains('is-selected')).toBe(true)

    ;(container!.querySelector('[data-testid="approval-template-undo"]') as HTMLButtonElement).click()
    await flushUi()
    expect(container!.querySelector('[data-canvas-node="approval_mid"]')?.classList.contains('is-selected')).toBe(true)
    expect(container!.querySelector('[data-testid="approval-canvas-inspector"]')?.getAttribute('data-inspector-node'))
      .toBe('approval_mid')

    ;(container!.querySelector('[data-testid="approval-template-redo"]') as HTMLButtonElement).click()
    await flushUi()
    expect(container!.querySelector('[data-canvas-node="approval_mid"]')).toBeNull()
    expect(container!.querySelector('[data-canvas-node="approval_first"]')?.classList.contains('is-selected')).toBe(true)
  })

  it('read-only mode renders inspector details but disables mutation controls', async () => {
    routeParams = { id: 'tpl_inspector_readonly' }
    // Load while manage is allowed (onMounted early-returns when canManageTemplates is false),
    // then flip to read-only so the inspector still mounts with disabled controls.
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildMixedGraph() as any }))
    await mountView()
    await flushUi()
    canManageTemplates.value = false
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-view-canvas"]') as HTMLButtonElement).click()
    await flushUi()
    clickCanvasNode('fork_1')
    await flushUi()

    const inspector = container!.querySelector('[data-testid="approval-canvas-inspector"]') as HTMLElement
    expect(inspector).not.toBeNull()
    expect(inspector.querySelector('[data-testid="approval-parallel-editor"]')).not.toBeNull()
    const joinMode = inspector.querySelector('[data-testid="approval-parallel-join-mode"]') as HTMLSelectElement
    expect(joinMode.disabled).toBe(true)
    expect(container!.querySelector('[data-testid="approval-template-undo"]')).toBeNull()
    expect(container!.querySelector('[data-testid="approval-template-redo"]')).toBeNull()
    expect(inspector.querySelector('[data-testid="approval-canvas-branch-reorder"]')).toBeNull()
    expect(container!.querySelector('[data-testid^="approval-canvas-branch-handle-"]')).toBeNull()

    clickCanvasNode('approval_high')
    await flushUi()
    const sourceKind = container!.querySelector(
      '[data-testid="approval-canvas-inspector"] [data-testid="approval-node-source-kind"]',
    ) as HTMLSelectElement
    expect(sourceKind).not.toBeNull()
    expect(sourceKind.disabled).toBe(true)
  })

  it('inspector close button clears selection and closes the panel', async () => {
    routeParams = { id: 'tpl_inspector_close' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildMixedGraph() as any }))
    await mountView()
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-view-canvas"]') as HTMLButtonElement).click()
    await flushUi()
    clickCanvasNode('cond_1')
    await flushUi()
    expect(container!.querySelector('[data-testid="approval-canvas-inspector"]')).not.toBeNull()
    expect(
      container!.querySelector('[data-testid="approval-canvas-node"][data-canvas-node="cond_1"]')
        ?.classList.contains('is-selected'),
    ).toBe(true)

    ;(container!.querySelector('[data-testid="approval-canvas-inspector-close"]') as HTMLButtonElement).click()
    await flushUi()
    expect(container!.querySelector('[data-testid="approval-canvas-inspector"]')).toBeNull()
    expect(
      container!.querySelector('[data-testid="approval-canvas-node"][data-canvas-node="cond_1"]')
        ?.classList.contains('is-selected'),
    ).toBe(false)
  })

  it('narrow canvas selection scrolls the stacked inspector below the sticky step rail', async () => {
    const originalMatchMedia = window.matchMedia
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    const scrollIntoViewSpy = vi.fn()
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewSpy,
    })

    try {
      routeParams = { id: 'tpl_inspector_mobile_scroll' }
      getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildMixedGraph() as any }))
      await mountView()
      await flushUi()

      ;(container!.querySelector('[data-testid="approval-view-canvas"]') as HTMLButtonElement).click()
      await flushUi()
      clickCanvasNode('cond_1')
      await flushUi()

      expect(scrollIntoViewSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
      // E2 extraction: the canvas workspace (incl. this scroll-margin-top) now lives in the
      // child ApprovalFlowCanvas.vue, not the parent — see the ownership check further below.
      expect(FLOW_CANVAS_SOURCE).toMatch(
        /\.template-authoring__canvas-inspector\s*\{[\s\S]*?scroll-margin-top:\s*164px/,
      )
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia,
      })
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        value: originalScrollIntoView,
      })
    }
  })

  it('child-owned condition styles apply in list and canvas inspector (scoped CSS ownership)', async () => {
    // Source contract: condition layout rules live on the extracted child, not only the parent.
    // (Parent scoped CSS cannot style the child's markup; this guards against regressing that.)
    expect(CHILD_EDITOR_SOURCE).toMatch(/\.template-authoring__condition-branch\s*\{[\s\S]*?border:\s*1px dashed/)
    expect(CHILD_EDITOR_SOURCE).toMatch(/\.template-authoring__condition-branch-head\s*\{[\s\S]*?flex-wrap:\s*wrap/)
    expect(CHILD_EDITOR_SOURCE).toMatch(/\.template-authoring__condition-rule\s*\{[\s\S]*?flex-wrap:\s*wrap/)
    expect(CHILD_EDITOR_SOURCE).toMatch(/\.template-authoring__node-summary\s*\{/)
    expect(CHILD_EDITOR_SOURCE).toMatch(/\.template-authoring__grid\s*\{/)
    // Parent no longer owns the G-2 condition rules (moved to the child SFC).
    expect(PARENT_AUTHORING_SOURCE).not.toMatch(/\.template-authoring__condition-branch\s*\{/)
    // Desktop inspector is wide enough for ms-w-360 controls (~400px). E2 extraction: the whole
    // canvas workspace (incl. the inspector shell) moved to ApprovalFlowCanvas.vue.
    expect(FLOW_CANVAS_SOURCE).toMatch(/\.template-authoring__canvas-inspector\s*\{[\s\S]*?width:\s*400px/)
    expect(PARENT_AUTHORING_SOURCE).not.toMatch(/\.template-authoring__canvas-workspace\s*\{/)

    routeParams = { id: 'tpl_inspector_styles' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildMixedGraph() as any }))
    await mountView()
    await flushUi()

    // Canvas V2 is canvas-first; switch to the retained structured fallback to verify its styles.
    ;(container!.querySelector('[data-testid="approval-view-list"]') as HTMLButtonElement).click()
    await flushUi()
    const listBranch = container!.querySelector(
      '[data-testid="approval-graph-readonly-list"] .template-authoring__condition-branch',
    ) as HTMLElement | null
    expect(listBranch).not.toBeNull()
    const listBranchStyle = getComputedStyle(listBranch!)
    const listHead = listBranch!.querySelector('.template-authoring__condition-branch-head') as HTMLElement
    const listHeadStyle = getComputedStyle(listHead)
    const listRule = listBranch!.querySelector('.template-authoring__condition-rule') as HTMLElement | null
    // Prefer computed-style proof when jsdom/Vite injects scoped CSS; fall back to class presence.
    const listBorderApplied =
      listBranchStyle.borderTopStyle === 'dashed'
      || listBranchStyle.borderStyle === 'dashed'
      || listBranchStyle.getPropertyValue('border-top-style') === 'dashed'
    if (listBorderApplied) {
      expect(listBorderApplied).toBe(true)
      expect(listHeadStyle.flexWrap === 'wrap' || listHeadStyle.getPropertyValue('flex-wrap') === 'wrap').toBe(true)
      if (listRule) {
        const ruleStyle = getComputedStyle(listRule)
        expect(ruleStyle.flexWrap === 'wrap' || ruleStyle.getPropertyValue('flex-wrap') === 'wrap').toBe(true)
      }
    } else {
      // jsdom did not apply scoped CSS — source contract above is the ownership proof;
      // still assert the markup + class contract that the styles target.
      expect(listBranch!.classList.contains('template-authoring__condition-branch')).toBe(true)
      expect(listHead.classList.contains('template-authoring__condition-branch-head')).toBe(true)
    }

    ;(container!.querySelector('[data-testid="approval-view-canvas"]') as HTMLButtonElement).click()
    await flushUi()
    clickCanvasNode('cond_1')
    await flushUi()
    const inspectorBranch = container!.querySelector(
      '[data-testid="approval-canvas-inspector"] .template-authoring__condition-branch',
    ) as HTMLElement | null
    expect(inspectorBranch).not.toBeNull()
    const inspectorBranchStyle = getComputedStyle(inspectorBranch!)
    const inspectorBorderApplied =
      inspectorBranchStyle.borderTopStyle === 'dashed'
      || inspectorBranchStyle.borderStyle === 'dashed'
      || inspectorBranchStyle.getPropertyValue('border-top-style') === 'dashed'
    if (inspectorBorderApplied) {
      expect(inspectorBorderApplied).toBe(true)
      const head = inspectorBranch!.querySelector('.template-authoring__condition-branch-head') as HTMLElement
      expect(getComputedStyle(head).flexWrap === 'wrap' || getComputedStyle(head).getPropertyValue('flex-wrap') === 'wrap').toBe(true)
    } else {
      expect(inspectorBranch!.classList.contains('template-authoring__condition-branch')).toBe(true)
    }
  })
})
