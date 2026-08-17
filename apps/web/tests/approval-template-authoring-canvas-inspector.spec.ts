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
import { createApp, defineComponent, h, nextTick, provide, reactive, ref, type App as VueApp } from 'vue'
import TemplateAuthoringView from '../src/views/approval/TemplateAuthoringView.vue'
import type { ApprovalNode, ApprovalTemplateDetailDTO } from '../src/types/approval'
// Lock-0 P1-A (docs/development/approval-lock0-d0-interaction-delta-20260817.md) — direct-mount
// harness for the registry-driven gates (A-1 positive control, A-2, A-3, A-4), which need a
// custom registry the full TemplateAuthoringView mount cannot be handed (its call sites are out
// of scope for this slice — see the PR description).
import ApprovalCanvasNodeInspectorDirect from '../src/approvals/components/ApprovalCanvasNodeInspector.vue'
import ApprovalGraphNodeConfigEditorDirect from '../src/approvals/components/ApprovalGraphNodeConfigEditor.vue'
import { APPROVAL_NODE_CONFIG_EDITOR_KEY, type ApprovalNodeConfigEditorApi } from '../src/approvals/nodeConfigEditorContext'
import {
  APPROVAL_ASSIGNEE_SOURCE_LABELS,
  DEFAULT_APPROVAL_CAPABILITY_REGISTRY,
  assigneeSourceRoster,
  type ApprovalCapabilityRegistry,
} from '../src/approvals/approvalCapabilityRegistry'
import {
  FIELD_PERMISSION_READONLY_HINT,
  FIELD_PERMISSION_ROUTING_HINT,
} from '../src/approvals/fieldPermissionHonestyCopy'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHILD_EDITOR_SOURCE = readFileSync(
  join(HERE, '../src/approvals/components/ApprovalGraphNodeConfigEditor.vue'),
  'utf8',
)
const PARENT_AUTHORING_SOURCE = readFileSync(
  join(HERE, '../src/views/approval/TemplateAuthoringView.vue'),
  'utf8',
)
const CANVAS_INSPECTOR_SHELL_SOURCE = readFileSync(
  join(HERE, '../src/approvals/components/ApprovalCanvasNodeInspector.vue'),
  'utf8',
)

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

describe('Canvas V2 Slice A — canvas inspector', () => {
  beforeEach(() => {
    routeParams = {}
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
    expect(inspector.querySelector('[data-testid="approval-node-source-roster"]')).not.toBeNull()
    expect(
      (inspector.querySelector('[data-testid="approval-node-source-kind-dept_head"]') as HTMLInputElement).checked,
    ).toBe(true)

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
    const dragStart = new Event('dragstart', { bubbles: true, cancelable: true })
    Object.defineProperty(dragStart, 'dataTransfer', {
      value: { setData: vi.fn(), effectAllowed: '' },
    })
    node.dispatchEvent(dragStart)
    await flushUi()
    const dropTarget = container!.querySelector('[data-testid="approval-canvas-move-target-e-start-a"]') as HTMLButtonElement
    expect(dropTarget).not.toBeNull()
    dropTarget.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }))
    await flushUi()

    const movedNode = container!.querySelector('[data-canvas-node="cc_b"]') as HTMLElement
    const appA = container!.querySelector('[data-canvas-node="app_a"]') as HTMLElement
    expect(Number.parseFloat(movedNode.style.top)).toBeLessThan(Number.parseFloat(appA.style.top))

    const selector = movedNode.querySelector('[data-testid="approval-canvas-node-select"]') as HTMLElement
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

  it('a representative inspector edit writes through to the existing draft save payload', async () => {
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
    joinMode.value = 'any'
    joinMode.dispatchEvent(new Event('change'))
    await flushUi()

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

  it('deleting the selected node clears selection and closes the inspector', async () => {
    routeParams = { id: 'tpl_inspector_delete' }
    // Must be a COMPLEX graph (cc) so the canvas toggle mounts; approval_mid is a linear
    // mid-chain approval (1 in / 1 out) so removeLinearNode + the canvas remove button apply.
    getTemplateSpy.mockResolvedValue(buildTemplate({
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: '发起', config: {} },
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
          { key: 'e-s-m', source: 'start', target: 'approval_mid' },
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
    expect(container!.querySelector('[data-testid="approval-canvas-inspector"]')).toBeNull()
    expect(container!.querySelector('[data-canvas-node="approval_mid"]')).toBeNull()
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

    clickCanvasNode('approval_high')
    await flushUi()
    const sourceKind = container!.querySelector(
      '[data-testid="approval-canvas-inspector"] [data-testid="approval-node-source-kind-dept_head"]',
    ) as HTMLInputElement
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
      // PR4: inspector chrome (incl. scroll-margin) lives on ApprovalCanvasNodeInspector.
      expect(CANVAS_INSPECTOR_SHELL_SOURCE).toMatch(
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
    // Desktop inspector shell is wide enough for ms-w-360 controls (~400px) — PR4 extract.
    expect(CANVAS_INSPECTOR_SHELL_SOURCE).toMatch(/\.template-authoring__canvas-inspector\s*\{[\s\S]*?width:\s*400px/)

    routeParams = { id: 'tpl_inspector_styles' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildMixedGraph() as any }))
    await mountView()
    await flushUi()

    // Canvas is the ordinary-user default; switch to the retained accessible list surface.
    ;(container!.querySelector('[data-testid="approval-view-list"]') as HTMLButtonElement).click()
    await flushUi()

    // List surface: condition branch must receive child-owned dashed border + wrap head.
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

  // ── Lock-0 P1-A acceptance gates (docs/development/approval-lock0-d0-interaction-delta-20260817.md) ──

  it('A-1/A-2: the shipped registry renders exactly 审批人设置/表单权限 on an approval node, each tab showing ONLY its own content; no Save/Cancel/Apply control', async () => {
    routeParams = { id: 'tpl_a1_a2' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildMixedGraph() as any }))
    await mountView()
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-view-canvas"]') as HTMLButtonElement).click()
    await flushUi()
    clickCanvasNode('approval_high')
    await flushUi()

    const inspector = container!.querySelector('[data-testid="approval-canvas-inspector"]') as HTMLElement
    const tablist = inspector.querySelector('[data-testid="approval-canvas-inspector-tablist"]') as HTMLElement
    expect(tablist).not.toBeNull()
    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]')) as HTMLElement[]
    expect(tabs.map((tab) => tab.textContent)).toEqual(['审批人设置', '表单权限'])

    // A-1 "per-tab content matches the L0-1 table" — not just tab labels: the CONTENT visibility
    // actually follows the active tab. `v-show` only toggles `style.display` (deliberately, so it
    // never removes tab-order/a11y-tree content the way `v-if` would), so jsdom's inline-style
    // reflection is the correct place to assert this rather than DOM presence.
    const assigneeSection = inspector.querySelector('[data-testid="approval-node-section-assignee"]') as HTMLElement
    const fieldPermSection = inspector.querySelector(
      '[data-testid="approval-node-section-field-permissions"]',
    ) as HTMLElement
    expect(assigneeSection).not.toBeNull()
    expect(fieldPermSection).not.toBeNull()
    expect(assigneeSection.style.display).not.toBe('none')
    expect(fieldPermSection.style.display).toBe('none')

    ;(container!.querySelector('[data-testid="approval-canvas-inspector-tab-fieldPermissions"]') as HTMLButtonElement).click()
    await flushUi()
    expect(assigneeSection.style.display).toBe('none')
    expect(fieldPermSection.style.display).not.toBe('none')

    // A-2: no 操作权限 tab/content with the shipped (Lock-5-absent) registry.
    expect(inspector.querySelector('[data-testid="approval-canvas-inspector-tab-operations"]')).toBeNull()
    expect(inspector.querySelector('[data-testid="approval-node-section-operations"]')).toBeNull()
    expect(inspector.textContent).not.toContain('操作权限')

    // A-8 (negative half): no Save/Cancel/Apply control anywhere in the inspector — tabs are
    // presentation only. Each label checked individually — `not.toEqual(arrayContaining([...]))`
    // only fails if ALL three are present, so it would pass a real Save button by itself.
    expect(inspector.querySelector('[data-testid*="save"]')).toBeNull()
    expect(inspector.querySelector('[data-testid*="cancel"]')).toBeNull()
    expect(inspector.querySelector('[data-testid*="apply"]')).toBeNull()
    const buttonLabels = Array.from(inspector.querySelectorAll('button')).map((btn) => btn.textContent?.trim())
    expect(buttonLabels).not.toContain('保存')
    expect(buttonLabels).not.toContain('取消')
    expect(buttonLabels).not.toContain('应用')
  })

  it('D1/D2: the configured-summary echo uses the RATIFIED §10.3 label, not the pre-D1 incidental wording (dept_head/requester)', async () => {
    routeParams = { id: 'tpl_d1_echo' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildMixedGraph() as any }))
    await mountView()
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-view-canvas"]') as HTMLButtonElement).click()
    await flushUi()

    // approval_high: dept_head. D1 supersedes the incidental "部门主管" with "部门负责人".
    clickCanvasNode('approval_high')
    await flushUi()
    const deptHeadRadio = container!.querySelector(
      '[data-testid="approval-node-source-kind-dept_head"]',
    )!.closest('label')
    expect(deptHeadRadio?.textContent).toContain('部门负责人')
    const deptHeadEcho = container!.querySelector('[data-testid="approval-node-source-configured-summary"]')
    expect(deptHeadEcho?.textContent).toBe('已配置：部门负责人')
    expect(deptHeadEcho?.textContent).not.toContain('部门主管')

    // app_a: requester. D1 supersedes the incidental "发起人" with "发起人本人".
    clickCanvasNode('app_a')
    await flushUi()
    const requesterEcho = container!.querySelector('[data-testid="approval-node-source-configured-summary"]')
    expect(requesterEcho?.textContent).toBe('已配置：发起人本人')
    expect(requesterEcho?.textContent).not.toBe('已配置：发起人')
  })

  // Gate P2-2 fix: the D1/D2 test above pins only 2/8 labels (dept_head/requester) via the rendered
  // echo. Probe 5 in the gate review reverted `static_user`/`form_field_user` to their pre-D1
  // wording and the whole required lane stayed 99/99 green — the other six labels had zero
  // coverage. This is an exact-object-equality pin of ALL EIGHT, written out literally from
  // docs/development/approval-lock0-d0-interaction-delta-20260817.md §4's ratification record (the
  // "iterate the exported table" mechanical assertion, not per-kind spot checks), so any single
  // label reverting to pre-D1 wording (or drifting to anything else) reds here regardless of
  // whether it happens to be one of the two kinds the D1/D2 test exercises.
  it('D1 (P2-2): all nine assignee-source labels equal the ratified map by exact object equality', () => {
    const RATIFIED_APPROVAL_ASSIGNEE_SOURCE_LABELS: Record<string, string> = {
      static_user: '指定成员',
      static_role: '指定角色',
      requester: '发起人本人',
      form_field_user: '表单中的成员字段',
      direct_manager: '直属上级',
      dept_head: '部门负责人',
      continuous_managers: '连续多级上级',
      manager_at_level: '指定层级上级',
      // Lock-1 §K2 (RATIFIED 2026-08-17) — the 提交人自选 registry row, admitted in the SAME
      // slice that lands scope validation + the submit-time chooser (Lock-1 §2.3 table).
      requester_choice: '提交人自选',
    }
    expect(APPROVAL_ASSIGNEE_SOURCE_LABELS).toEqual(RATIFIED_APPROVAL_ASSIGNEE_SOURCE_LABELS)
    // Also pin the count so a stray 10th entry (which would still satisfy `toEqual` on the keys
    // above via structural superset checks in some matcher semantics) cannot slip through unnoticed.
    expect(Object.keys(APPROVAL_ASSIGNEE_SOURCE_LABELS)).toHaveLength(9)
  })

  it('A-7: no scrim/overlay-mask element with the inspector mounted and visible', async () => {
    routeParams = { id: 'tpl_a7' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildMixedGraph() as any }))
    await mountView()
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-view-canvas"]') as HTMLButtonElement).click()
    await flushUi()
    clickCanvasNode('approval_high')
    await flushUi()

    // Positive control first: the inspector really is mounted and visible.
    const inspector = container!.querySelector('[data-testid="approval-canvas-inspector"]') as HTMLElement
    expect(inspector).not.toBeNull()
    expect(inspector.style.display).not.toBe('none')

    // No scrim/overlay-mask anywhere in the mounted tree (parent §5: "scrim-free flat boundary").
    expect(container!.querySelector('.scrim')).toBeNull()
    expect(container!.querySelector('[class*="scrim"]')).toBeNull()
    expect(container!.querySelector('[class*="overlay-mask"]')).toBeNull()
    expect(container!.querySelector('[data-testid*="scrim"]')).toBeNull()
    expect(container!.querySelector('.el-overlay')).toBeNull()
  })

  it('A-8: a field edit + tab switch yields the same undo state as the same edit without a switch; the counter can move (positive control, not vacuous)', async () => {
    async function measureUndoDisabledAfterFieldEdit(withTabSwitch: boolean): Promise<boolean> {
      routeParams = { id: `tpl_a8_${withTabSwitch}` }
      getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildMixedGraph() as any }))
      await mountView()
      await flushUi()
      ;(container!.querySelector('[data-testid="approval-view-canvas"]') as HTMLButtonElement).click()
      await flushUi()
      clickCanvasNode('approval_high')
      await flushUi()
      ;(container!.querySelector('[data-testid="approval-node-source-kind-requester"]') as HTMLInputElement).click()
      await flushUi()
      if (withTabSwitch) {
        ;(
          container!.querySelector('[data-testid="approval-canvas-inspector-tab-fieldPermissions"]') as HTMLButtonElement
        ).click()
        await flushUi()
      }
      const disabled = (container!.querySelector('[data-testid="approval-canvas-undo"]') as HTMLButtonElement).disabled
      app?.unmount()
      container?.remove()
      app = null
      container = null
      return disabled
    }

    const withoutSwitch = await measureUndoDisabledAfterFieldEdit(false)
    const withSwitch = await measureUndoDisabledAfterFieldEdit(true)
    // Load-bearing assertion for A-8: tab switching adds ZERO undo-history entries relative to the
    // same edit without switching (parent §5 lines 204-206 / delta §1 L0-1: "switching tabs is
    // presentation state producing zero history entries").
    //
    // NOTE ON THE LITERAL "exactly one undo entry" WORDING (delta §3 A-8): at this baseline BOTH
    // measurements are `true` (undo stays disabled) — an inspector field edit does not push its
    // own history entry at all yet (config edits are merged onto the next topology snapshot via
    // `mergeLiveNodeConfigsOntoTopology`; `reseedCanvasHistoryFromDraft` only runs on load/save,
    // never on a field edit — see `approval-authoring-history.test.ts`'s "inspector map edits
    // survive move/undo" cases for the same fact from the history-module side). That gap predates
    // this slice and its fix (a push-on-commit call inside the setter functions) lives in
    // TemplateAuthoringView.vue, out of scope here. This test asserts what P1-A actually changed
    // (equality — tabs add nothing) plus a positive control below (the counter demonstrably CAN
    // move), not the unmet "exactly one" literal.
    expect(withSwitch).toBe(withoutSwitch)

    routeParams = { id: 'tpl_a8_positive_control' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildMixedGraph() as any }))
    await mountView()
    await flushUi()
    ;(container!.querySelector('[data-testid="approval-view-canvas"]') as HTMLButtonElement).click()
    await flushUi()
    clickCanvasNode('approval_high')
    await flushUi()
    expect((container!.querySelector('[data-testid="approval-canvas-undo"]') as HTMLButtonElement).disabled).toBe(true)
    ;(container!.querySelector('[data-testid="approval-canvas-insert-approval_high"]') as HTMLButtonElement)?.click()
    await flushUi()
    expect((container!.querySelector('[data-testid="approval-canvas-undo"]') as HTMLButtonElement).disabled).toBe(false)
  })

  // Gate P1-1 fix regression (full mount, real `setApprovalSourceKind` — not the test stub). The
  // review's "Link A" reproduced this exact fixture: select static_role (roleIds:['legal']) →
  // traversal onto requester → traversal back → the pre-fix `setApprovalSourceKind` replaced
  // `assigneeSources[0]` wholesale, so the role picker went blank, the echo read
  // "已配置：指定角色（未选择）", undo stayed disabled (no recovery), and Save failed validation. A
  // radiogroup arrow keypress and a `.click()` on the target radio fire the SAME `@change` handler
  // (native radiogroup commit-on-arrow semantics — see the gate review's "Link B"); jsdom implements
  // no radiogroup arrow-key semantics at all, so `.click()` is the correct jsdom-safe stand-in for
  // "arrow onto this radio" here — the real keyboard mechanism is covered separately by the
  // real-browser check (verification/approval-inspector-keyboard.spec.ts).
  it('P1-1 regression: roster kind-switch caches and restores the outgoing payload — traversal away and back does not destroy configured roleIds, and Save succeeds with the original JSON intact', async () => {
    routeParams = { id: 'tpl_p1_1_regression' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildMixedGraph() as any }))
    await mountView()
    await flushUi()
    ;(container!.querySelector('[data-testid="approval-view-canvas"]') as HTMLButtonElement).click()
    await flushUi()

    // app_b: static_role, roleIds:['legal'] — the exact gate Link A fixture.
    clickCanvasNode('app_b')
    await flushUi()
    expect(
      (container!.querySelector('[data-testid="approval-node-source-kind-static_role"]') as HTMLInputElement).checked,
    ).toBe(true)
    const rolePicker = container!.querySelector('[data-testid="approval-node-source-role-picker"]') as HTMLSelectElement
    expect(rolePicker.value).toBe('legal')
    let echo = container!.querySelector('[data-testid="approval-node-source-configured-summary"]')
    expect(echo?.textContent).toBe('已配置：指定角色（1 个）')

    // Traverse ONE step onto requester.
    ;(container!.querySelector('[data-testid="approval-node-source-kind-requester"]') as HTMLInputElement).click()
    await flushUi()
    echo = container!.querySelector('[data-testid="approval-node-source-configured-summary"]')
    expect(echo?.textContent).toBe('已配置：发起人本人')

    // Traverse back onto static_role.
    ;(container!.querySelector('[data-testid="approval-node-source-kind-static_role"]') as HTMLInputElement).click()
    await flushUi()

    // FIX-1 assertion: the payload is RESTORED, not stripped to "（未选择）" — this is the line
    // that must go red if `setApprovalSourceKind` regresses to lossy (unconditionally building a
    // fresh empty-payload object per kind, ignoring any cache).
    expect(
      (container!.querySelector('[data-testid="approval-node-source-kind-static_role"]') as HTMLInputElement).checked,
    ).toBe(true)
    const rolePickerAfter = container!.querySelector('[data-testid="approval-node-source-role-picker"]') as HTMLSelectElement
    expect(rolePickerAfter.value).toBe('legal')
    echo = container!.querySelector('[data-testid="approval-node-source-configured-summary"]')
    expect(echo?.textContent).toBe('已配置：指定角色（1 个）')
    expect(echo?.textContent).not.toBe('已配置：指定角色（未选择）')

    // Save succeeds with the original JSON intact — the gate's decisive "Save failed validation"
    // symptom must NOT reproduce.
    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()
    expect(updateTemplateSpy).toHaveBeenCalledTimes(1)
    const payload = updateTemplateSpy.mock.calls[0]?.[1] as any
    const appB = payload.approvalGraph.nodes.find((n: any) => n.key === 'app_b')
    expect(appB.config.assigneeSources[0]).toEqual({ kind: 'static_role', roleIds: ['legal'] })
  })

  it('A-9: readonly field-permission honesty copy is byte-identical to the linear editor; editable/hidden do not render it', async () => {
    routeParams = { id: 'tpl_a9' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildMixedGraph() as any }))
    await mountView()
    await flushUi()
    ;(container!.querySelector('[data-testid="approval-view-canvas"]') as HTMLButtonElement).click()
    await flushUi()
    clickCanvasNode('approval_high')
    await flushUi()
    ;(container!.querySelector('[data-testid="approval-canvas-inspector-tab-fieldPermissions"]') as HTMLButtonElement).click()
    await flushUi()

    const access = container!.querySelector('[data-testid="approval-node-field-access-amount"]') as HTMLSelectElement
    expect(access).not.toBeNull()
    expect(container!.querySelector('[data-testid="approval-node-field-readonly-hint"]')).toBeNull()

    access.value = 'readonly'
    access.dispatchEvent(new Event('change'))
    await flushUi()
    const hint = container!.querySelector('[data-testid="approval-node-field-readonly-hint"]') as HTMLElement
    expect(hint).not.toBeNull()
    expect(hint.textContent).toBe(FIELD_PERMISSION_READONLY_HINT)
    expect(hint.textContent).toBe('只读将在后续版本（T1-4b）生效，当前保存但暂不强制')
    // Gate A-9/probe-6a fix: `.toContain` is a SUBSTRING check — APPENDING drift to the linear
    // editor's hint (e.g. "…暂不强制。详见发布说明") still contains the original text as a prefix,
    // so it stayed green (probe 6a: 115/115). Anchor to the linear span's own data-testid and read
    // its exact text out of source, then assert EQUALITY against the canvas hint — an append on
    // either side now reds because the two strings genuinely differ.
    const linearReadonlyHintMatch = PARENT_AUTHORING_SOURCE.match(
      /data-testid="approval-step-field-readonly-hint"\s*>([^<]*)<\/span>/,
    )
    expect(linearReadonlyHintMatch).not.toBeNull()
    expect(linearReadonlyHintMatch![1]).toBe(hint.textContent)

    access.value = 'hidden'
    access.dispatchEvent(new Event('change'))
    await flushUi()
    expect(container!.querySelector('[data-testid="approval-node-field-readonly-hint"]')).toBeNull()

    access.value = 'editable'
    access.dispatchEvent(new Event('change'))
    await flushUi()
    expect(container!.querySelector('[data-testid="approval-node-field-readonly-hint"]')).toBeNull()
  })

  it('D5 (P2-1): the routing-hint string is pinned by anchored exact equality (not substring), and the hint now actually renders on a complex graph via the graph-wide computed', async () => {
    // Source string pin, same anchored-equality treatment as the A-9 readonly-hint fix above — a
    // substring `.toContain` stays green if the linear copy is extended on one side only.
    expect(FIELD_PERMISSION_ROUTING_HINT).toBe('该字段被审批人来源引用；隐藏仅影响回显，不影响审批人解析')
    const linearRoutingHintMatch = PARENT_AUTHORING_SOURCE.match(
      /data-testid="approval-step-field-routing-hint"\s*>([^<]*)<\/span>/,
    )
    expect(linearRoutingHintMatch).not.toBeNull()
    expect(linearRoutingHintMatch![1]).toBe(FIELD_PERMISSION_ROUTING_HINT)

    // Gate P2-1 fix (DOM assertion): `routingDriverFieldIds` is now a graph-wide computed (unions
    // `draft.steps` + `draft.approvalNodeEdits`) wired through the provide() object. The review's
    // probe 12 showed the PR's originally-claimed "one-line" `routingDriverFieldIds,` pass-through
    // did NOT work — it pointed at the linear-only computed, which is structurally empty (`draft.
    // steps.length === 0`) whenever the canvas inspector is mounted at all (a complex graph). This
    // reproduces that probe end-to-end and asserts it now renders.
    routeParams = { id: 'tpl_d5_routing_hint' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildMixedGraph() as any }))
    await mountView()
    await flushUi()
    ;(container!.querySelector('[data-testid="approval-view-canvas"]') as HTMLButtonElement).click()
    await flushUi()

    // app_a: switch its assignee source to form_field_user → reviewer (a real routing driver).
    clickCanvasNode('app_a')
    await flushUi()
    ;(container!.querySelector('[data-testid="approval-node-source-kind-form_field_user"]') as HTMLInputElement).click()
    await flushUi()
    const fieldPicker = container!.querySelector('[data-testid="approval-node-source-field"]') as HTMLSelectElement
    expect(fieldPicker).not.toBeNull()
    fieldPicker.value = 'reviewer'
    fieldPicker.dispatchEvent(new Event('change'))
    await flushUi()

    // A DIFFERENT node (join_1) hides that same field — proving the graph-wide computed covers
    // "ANY node's source", not just the node currently being edited (the linear editor's own
    // semantics — see routingDriverFieldIds's comment in TemplateAuthoringView.vue).
    clickCanvasNode('join_1')
    await flushUi()
    ;(container!.querySelector('[data-testid="approval-canvas-inspector-tab-fieldPermissions"]') as HTMLButtonElement).click()
    await flushUi()
    const reviewerAccess = container!.querySelector('[data-testid="approval-node-field-access-reviewer"]') as HTMLSelectElement
    expect(reviewerAccess).not.toBeNull()
    reviewerAccess.value = 'hidden'
    reviewerAccess.dispatchEvent(new Event('change'))
    await flushUi()

    const routingHint = container!.querySelector('[data-testid="approval-node-field-routing-hint"]') as HTMLElement
    expect(routingHint).not.toBeNull()
    expect(routingHint.textContent).toBe(FIELD_PERMISSION_ROUTING_HINT)

    // Positive control: hiding a field NO source references renders no routing hint (proves the
    // condition is value-selected, not a blanket "any hidden field" regression).
    const amountAccess = container!.querySelector('[data-testid="approval-node-field-access-amount"]') as HTMLSelectElement
    expect(amountAccess).not.toBeNull()
    amountAccess.value = 'hidden'
    amountAccess.dispatchEvent(new Event('change'))
    await flushUi()
    expect(container!.querySelectorAll('[data-testid="approval-node-field-routing-hint"]')).toHaveLength(1)
  })

  it('A-11: tab strip uses the tablist roving-tabindex pattern; every tab is keyboard reachable', async () => {
    routeParams = { id: 'tpl_a11' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildMixedGraph() as any }))
    await mountView()
    await flushUi()
    ;(container!.querySelector('[data-testid="approval-view-canvas"]') as HTMLButtonElement).click()
    await flushUi()
    clickCanvasNode('approval_high')
    await flushUi()

    const tab1 = container!.querySelector('[data-testid="approval-canvas-inspector-tab-assignee"]') as HTMLElement
    const tab2 = container!.querySelector('[data-testid="approval-canvas-inspector-tab-fieldPermissions"]') as HTMLElement
    expect(tab1.getAttribute('role')).toBe('tab')
    expect(tab2.getAttribute('role')).toBe('tab')
    expect(tab1.tabIndex).toBe(0)
    expect(tab2.tabIndex).toBe(-1)
    expect(tab1.getAttribute('aria-selected')).toBe('true')
    expect(tab2.getAttribute('aria-selected')).toBe('false')

    tab1.focus()
    tab1.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    await flushUi()
    expect(tab2.getAttribute('aria-selected')).toBe('true')
    expect(tab1.getAttribute('aria-selected')).toBe('false')
    expect(tab2.tabIndex).toBe(0)
    expect(tab1.tabIndex).toBe(-1)
    expect(document.activeElement).toBe(tab2)

    tab2.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
    await flushUi()
    expect(tab1.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tab1)

    // Visible focus ring — CSS source contract (jsdom does not compute real focus rendering; the
    // existing spec's "child-owned condition styles" test uses the same source-regex convention).
    expect(CANVAS_INSPECTOR_SHELL_SOURCE).toMatch(
      /\.template-authoring__canvas-inspector-tab:focus-visible\s*\{[\s\S]*?outline:/,
    )
  })

  it('A-12: tab strip Left/Right stays within the strip; the toolbar Left/Right stays within itself; boundaries hold in both directions', async () => {
    routeParams = { id: 'tpl_a12' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildMixedGraph() as any }))
    await mountView()
    await flushUi()
    ;(container!.querySelector('[data-testid="approval-view-canvas"]') as HTMLButtonElement).click()
    await flushUi()
    clickCanvasNode('approval_high')
    await flushUi()

    const inspector = container!.querySelector('[data-testid="approval-canvas-inspector"]') as HTMLElement
    const toolbar = inspector.querySelector('[data-testid="approval-canvas-inspector-topology"]') as HTMLElement
    expect(toolbar.getAttribute('role')).toBe('toolbar')
    const toolbarButton = toolbar.querySelector('[data-testid="approval-canvas-insert-approval_high"]') as HTMLButtonElement
    expect(toolbarButton).not.toBeNull()

    const tab1 = container!.querySelector('[data-testid="approval-canvas-inspector-tab-assignee"]') as HTMLElement

    // Boundary 1: ArrowRight/ArrowLeft focused on a TOOLBAR control never reaches the tablist.
    toolbarButton.focus()
    toolbarButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    await flushUi()
    expect(tab1.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(toolbarButton)

    toolbarButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
    await flushUi()
    expect(tab1.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(toolbarButton)

    // Boundary 2: ArrowRight/ArrowLeft focused on the TABLIST never reaches/affects the toolbar —
    // the toolbar button's tabIndex is never rewritten by the tablist's roving-tabindex logic.
    const tab2 = container!.querySelector('[data-testid="approval-canvas-inspector-tab-fieldPermissions"]') as HTMLElement
    tab1.focus()
    tab1.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    await flushUi()
    expect(toolbarButton.tabIndex).toBe(0)
    expect(document.activeElement).not.toBe(toolbarButton)

    tab2.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
    await flushUi()
    expect(toolbarButton.tabIndex).toBe(0)
    expect(document.activeElement).not.toBe(toolbarButton)

    // `Tab` moves between the two widgets in DOM order: only ONE tab is ever in the Tab sequence
    // at a time (roving tabindex), so native Tab from the toolbar's last button lands on the
    // tablist's single active tab rather than a stale one.
    const tabsInSequence = [tab1, tab2].filter((tab) => tab.tabIndex === 0)
    expect(tabsInSequence).toHaveLength(1)
  })
})

// ── Lock-0 P1-A — registry-driven gates (direct component mount) ──────────────────────────────
// A-1 positive control, A-2, A-3, A-4 need a registry the full TemplateAuthoringView mount cannot
// be handed without editing that file's call sites (out of scope for this slice — the shell and
// the config editor each take an optional `registry` prop precisely so this is possible without
// touching it). This harness provides the SAME `APPROVAL_NODE_CONFIG_EDITOR_KEY` context
// TemplateAuthoringView.vue provides in production, with a minimal stub implementation.
describe('Lock-0 P1-A — registry-driven tab membership + roster (direct mount)', () => {
  function makeApprovalNode(key: string): ApprovalNode {
    return { key, type: 'approval', name: key, config: {} }
  }

  function createStubConfigApi(
    seed: Record<string, { assigneeSources: Array<Record<string, unknown>>; fieldPermissions?: Array<{ fieldId: string; access: string }> }>,
  ): ApprovalNodeConfigEditorApi {
    // Reactive so a sub-form edit (e.g. the K2 requester_choice scope switch) re-renders the
    // mounted component the same way the production draft model does.
    const edits: Record<string, { nodeKey: string; assigneeSources: Array<Record<string, unknown>>; fieldPermissions: Array<{ fieldId: string; access: string }> }> = reactive({})
    for (const [key, value] of Object.entries(seed)) {
      edits[key] = {
        nodeKey: key,
        assigneeSources: value.assigneeSources.map((s) => ({ ...s })),
        fieldPermissions: (value.fieldPermissions ?? []).map((p) => ({ ...p })),
      }
    }
    return {
      readOnly: false,
      conditionEditFor: () => undefined,
      parallelEditFor: () => undefined,
      ccEditFor: () => undefined,
      approvalNodeEditFor: (nodeKey: string) => edits[nodeKey] as any,
      conditionFieldOptions: [],
      userFields: [{ id: 'reviewer', label: '审批人字段' }],
      conditionFormulaInsertOptions: [],
      fieldPermissionFields: [{ id: 'amount', label: '金额' }],
      conditionOperatorLabel: () => '',
      liveBranchSummary: () => '',
      conditionRuleValueText: () => '',
      setConditionRuleValue: () => {},
      addConditionRule: () => {},
      removeConditionRule: () => {},
      setConditionBranchPredicateMode: () => {},
      insertConditionFormulaToken: () => {},
      insertConditionFormulaFunction: () => {},
      insertConditionFormulaRoleMembership: () => {},
      conditionFormulaDryRunResult: () => '',
      conditionFormulaDryRunLoading: () => false,
      dryRunConditionFormula: () => {},
      conditionOutgoingEdgeKeys: () => [],
      conditionEdgeLabel: () => '',
      graphEdgeTargetLabel: () => '',
      graphNodeLabel: (key: string) => key,
      parallelJoinModeLabel: () => '',
      ccTargetTypeLabel: () => '用户',
      setCcTargetIds: () => {},
      syncCcOptions: () => {},
      approvalSourceKind: (nodeKey: string) => (edits[nodeKey]?.assigneeSources[0]?.kind as any) ?? 'requester',
      setApprovalSourceKind: (nodeKey: string, kind: any) => {
        const edit = edits[nodeKey]
        if (!edit) return
        const next: Record<string, unknown> =
          kind === 'static_user' ? { kind, userIds: [] }
            : kind === 'static_role' ? { kind, roleIds: [] }
              : kind === 'form_field_user' ? { kind, fieldId: '' }
                : kind === 'continuous_managers' ? { kind, levels: 1 }
                  : kind === 'manager_at_level' ? { kind, level: 1 }
                    : { kind }
        edit.assigneeSources = [next, ...edit.assigneeSources.slice(1)]
      },
      syncApprovalNodeOptions: () => {},
      approvalSourceIds: (nodeKey: string) => {
        const source = edits[nodeKey]?.assigneeSources[0]
        return (source?.userIds as string[]) ?? (source?.roleIds as string[]) ?? []
      },
      setApprovalSourceIdsFromPicker: (nodeKey: string, ids: string[]) => {
        const source = edits[nodeKey]?.assigneeSources[0]
        if (!source) return
        if (source.kind === 'static_user') source.userIds = ids
        else if (source.kind === 'static_role') source.roleIds = ids
      },
      approvalSourceFieldId: (nodeKey: string) => (edits[nodeKey]?.assigneeSources[0]?.fieldId as string) ?? '',
      setApprovalSourceFieldId: (nodeKey: string, fieldId: string) => {
        const source = edits[nodeKey]?.assigneeSources[0]
        if (source && source.kind === 'form_field_user') source.fieldId = fieldId
      },
      approvalSourceLevel: (nodeKey: string) => {
        const source = edits[nodeKey]?.assigneeSources[0]
        return (source?.level as number) ?? (source?.levels as number) ?? 1
      },
      setApprovalSourceLevel: (nodeKey: string, value: number) => {
        const source = edits[nodeKey]?.assigneeSources[0]
        if (!source) return
        if (source.kind === 'manager_at_level') source.level = value
        else if (source.kind === 'continuous_managers') source.levels = value
      },
      approvalSourceIsPlaceholder: () => false,
      approvalNodeMode: () => 'single',
      setApprovalNodeMode: () => {},
      approvalNodeEmptyPolicy: () => 'error',
      setApprovalNodeEmptyPolicy: () => {},
      approvalNodeMergeWithRequester: () => false,
      setApprovalNodeMergeWithRequester: () => {},
      approvalNodeFieldAccess: (nodeKey: string, fieldId: string) =>
        (edits[nodeKey]?.fieldPermissions.find((p) => p.fieldId === fieldId)?.access as any) ?? 'editable',
      setApprovalNodeFieldAccess: (nodeKey: string, fieldId: string, access: any) => {
        const edit = edits[nodeKey]
        if (!edit) return
        edit.fieldPermissions = edit.fieldPermissions.filter((p) => p.fieldId !== fieldId)
        if (access !== 'editable') edit.fieldPermissions.push({ fieldId, access })
      },
      nodeConfigSummary: () => [],
      onUserSearch: () => {},
      directoryUsers: [],
      directoryUsersLoading: false,
      directoryRoles: [],
      formulaRoles: [],
      formatUserLabel: (u: { id: string }) => u.id,
      formatRoleLabel: (r: { id: string }) => r.id,
    }
  }

  function mountDirectInspector(opts: {
    node: ApprovalNode
    registry: ApprovalCapabilityRegistry
    api: ApprovalNodeConfigEditorApi
  }) {
    const localContainer = document.createElement('div')
    document.body.appendChild(localContainer)
    const Harness = defineComponent({
      name: 'DirectInspectorHarness',
      setup() {
        provide(APPROVAL_NODE_CONFIG_EDITOR_KEY, opts.api)
        return () =>
          h(
            ApprovalCanvasNodeInspectorDirect as any,
            {
              node: opts.node,
              readOnly: false,
              movingCanvasNode: null,
              graphNodeLabel: (key: string) => key,
              nodeTypeLabel: (type: string) => type,
              canMoveCanvasNode: () => false,
              canvasStepMoveTarget: () => undefined,
              canInsertAfter: () => false,
              canInsertParallelAfter: () => false,
              canRemoveNode: () => false,
              registry: opts.registry,
            },
            {
              default: () => h(ApprovalGraphNodeConfigEditorDirect as any, { node: opts.node, registry: opts.registry }),
            },
          )
      },
    })
    const localApp = createApp(Harness)
    installStubs(localApp)
    localApp.mount(localContainer)
    return {
      container: localContainer,
      unmount: () => {
        localApp.unmount()
        localContainer.remove()
      },
    }
  }

  // Gate P2-3 fix (a): the 辅助编辑模式 (structured-list) surface mounts `ApprovalGraphNodeConfigEditor`
  // standalone, WITHOUT `ApprovalCanvasNodeInspector`'s tab-strip wrapper — so no
  // `APPROVAL_CANVAS_INSPECTOR_TABS_KEY` is ever provided there. This reproduces that exact shape
  // (only `APPROVAL_NODE_CONFIG_EDITOR_KEY` provided) rather than reusing `mountDirectInspector`,
  // whose harness always wraps the editor in the tabbed shell.
  function mountDirectConfigEditorFlat(opts: {
    node: ApprovalNode
    registry: ApprovalCapabilityRegistry
    api: ApprovalNodeConfigEditorApi
  }) {
    const localContainer = document.createElement('div')
    document.body.appendChild(localContainer)
    const Harness = defineComponent({
      name: 'DirectFlatConfigEditorHarness',
      setup() {
        provide(APPROVAL_NODE_CONFIG_EDITOR_KEY, opts.api)
        return () => h(ApprovalGraphNodeConfigEditorDirect as any, { node: opts.node, registry: opts.registry })
      },
    })
    const localApp = createApp(Harness)
    installStubs(localApp)
    localApp.mount(localContainer)
    return {
      container: localContainer,
      unmount: () => {
        localApp.unmount()
        localContainer.remove()
      },
    }
  }

  it('P2-3: 辅助编辑模式 (no tabs context) keeps BOTH sections visible; tabbed mode content stays inside its own L0-1 section wrapper', () => {
    const node = makeApprovalNode('approval_x')
    const api = createStubConfigApi({ approval_x: { assigneeSources: [{ kind: 'direct_manager' }] } })

    // (a) Flat-mode visibility-aware assertion — direct-mount WITHOUT the tabs context. Gate probe
    // 10 (narrowing `showFieldPermissionsSection` to tabbed-only, i.e. dropping its
    // `activeTabId.value === null` branch) hides the field-permission editor in exactly this
    // surface while every existing suite stayed 121/121 green, because the only prior assertions
    // were `querySelector` DOM-presence checks (visibility-blind — `v-show` only toggles
    // `style.display`, never removes the element). `style.display !== 'none'` is the load-bearing
    // check here, not mere presence.
    const flat = mountDirectConfigEditorFlat({ node, registry: DEFAULT_APPROVAL_CAPABILITY_REGISTRY, api })
    const flatAssignee = flat.container.querySelector('[data-testid="approval-node-section-assignee"]') as HTMLElement
    const flatFieldPerms = flat.container.querySelector(
      '[data-testid="approval-node-section-field-permissions"]',
    ) as HTMLElement
    expect(flatAssignee).not.toBeNull()
    expect(flatFieldPerms).not.toBeNull()
    expect(flatAssignee.style.display).not.toBe('none')
    expect(flatFieldPerms.style.display).not.toBe('none')
    flat.unmount()

    // Contrasting control, same api: TABBED mode DOES toggle display — proves the flat-mode
    // assertion above is not vacuously true because `v-show` never sets `display:none` anywhere in
    // this component (a positive control per feedback_positive_control_not_failclosed.md).
    const tabbed = mountDirectInspector({ node, registry: DEFAULT_APPROVAL_CAPABILITY_REGISTRY, api })
    const tabbedAssignee = tabbed.container.querySelector('[data-testid="approval-node-section-assignee"]') as HTMLElement
    const tabbedFieldPerms = tabbed.container.querySelector(
      '[data-testid="approval-node-section-field-permissions"]',
    ) as HTMLElement
    expect(tabbedAssignee.style.display).not.toBe('none')
    expect(tabbedFieldPerms.style.display).toBe('none')

    // (b) Per-tab CONTENT-MEMBERSHIP pin (A-1's content clause; gate probe 13). A representative
    // control from each tab's L0-1 content list must resolve INSIDE that tab's section wrapper —
    // `section.contains(control)` — not merely exist somewhere in the inspector's DOM (which
    // `querySelector` at the inspector root cannot distinguish from "moved to the wrong tab").
    const modeControl = tabbed.container.querySelector('[data-testid="approval-node-mode"]')
    const emptyPolicyControl = tabbed.container.querySelector('[data-testid="approval-node-empty-policy"]')
    const mergeControl = tabbed.container.querySelector('[data-testid="approval-node-merge-with-requester"]')
    expect(modeControl).not.toBeNull()
    expect(emptyPolicyControl).not.toBeNull()
    expect(mergeControl).not.toBeNull()
    expect(tabbedAssignee.contains(modeControl)).toBe(true)
    expect(tabbedAssignee.contains(emptyPolicyControl)).toBe(true)
    expect(tabbedAssignee.contains(mergeControl)).toBe(true)
    // Negative half of the same pin: none of the three sit inside the field-permissions wrapper —
    // this is exactly what gate probe 13 (moving 审批模式/空审批人策略/自审策略 into that section)
    // would flip.
    expect(tabbedFieldPerms.contains(modeControl)).toBe(false)
    expect(tabbedFieldPerms.contains(emptyPolicyControl)).toBe(false)
    expect(tabbedFieldPerms.contains(mergeControl)).toBe(false)

    const fieldPermRow = tabbed.container.querySelector('[data-testid="approval-node-field-permissions"]')
    expect(fieldPermRow).not.toBeNull()
    expect(tabbedFieldPerms.contains(fieldPermRow)).toBe(true)
    expect(tabbedAssignee.contains(fieldPermRow)).toBe(false)

    tabbed.unmount()
  })

  it('A-1 positive control: a registry WITH a ratified operation policy renders a third 操作权限 tab', () => {
    const node = makeApprovalNode('approval_x')
    const registry: ApprovalCapabilityRegistry = {
      assigneeSourcesByNodeType: { approval: assigneeSourceRoster(DEFAULT_APPROVAL_CAPABILITY_REGISTRY, 'approval') },
      operationPoliciesByNodeType: { approval: [{ id: 'transfer', label: '转交' }] },
    }
    const { container: c, unmount } = mountDirectInspector({
      node,
      registry,
      api: createStubConfigApi({ approval_x: { assigneeSources: [{ kind: 'direct_manager' }] } }),
    })
    const tabs = Array.from(c.querySelectorAll('[role="tab"]')).map((el) => el.textContent)
    expect(tabs).toEqual(['审批人设置', '表单权限', '操作权限'])
    unmount()
  })

  it('A-2: with the shipped (Lock-5-absent) registry, no 操作权限 element exists — the A-1 fixture proves the tab is not a dead path', () => {
    const node = makeApprovalNode('approval_x')
    const { container: c, unmount } = mountDirectInspector({
      node,
      registry: DEFAULT_APPROVAL_CAPABILITY_REGISTRY,
      api: createStubConfigApi({ approval_x: { assigneeSources: [{ kind: 'direct_manager' }] } }),
    })
    expect(c.querySelector('[data-testid="approval-canvas-inspector-tab-operations"]')).toBeNull()
    expect(c.textContent).not.toContain('操作权限')
    unmount()
  })

  it('A-3: roster equals the nine-member ApprovalAssigneeSourceKind union by exact set equality, not count or subset', () => {
    // Lock-1 §2.3: the exact-set gate grows from eight to eight-plus-ratified-K-kinds in the
    // SAME commit that lands each kind — K2 `requester_choice` is the first admitted row.
    const CANONICAL_NINE = [
      'continuous_managers',
      'dept_head',
      'direct_manager',
      'form_field_user',
      'manager_at_level',
      'requester',
      'requester_choice',
      'static_role',
      'static_user',
    ]
    const roster = [...assigneeSourceRoster(DEFAULT_APPROVAL_CAPABILITY_REGISTRY, 'approval')]
      .map((opt) => opt.kind)
      .sort()
    expect(roster).toEqual(CANONICAL_NINE)

    const node = makeApprovalNode('approval_x')
    const { container: c, unmount } = mountDirectInspector({
      node,
      registry: DEFAULT_APPROVAL_CAPABILITY_REGISTRY,
      api: createStubConfigApi({ approval_x: { assigneeSources: [{ kind: 'direct_manager' }] } }),
    })
    const rendered = Array.from(
      c.querySelectorAll('[data-testid="approval-node-source-roster"] input[type="radio"]'),
    )
      .map((el) => el.getAttribute('data-testid')?.replace('approval-node-source-kind-', ''))
      .sort()
    expect(rendered).toEqual(CANONICAL_NINE)
    unmount()
  })

  // A-4 SCOPE NOTE: this proves the ROSTER COMPONENT's own branching mechanism — given an
  // editable context, an unknown kind renders read-only + never mutates its source object, while a
  // known kind in the SAME api renders editable. It does NOT prove this is reachable end-to-end
  // through a real save in the shipped app: `unsupportedTemplateAuthoringReason` (templateAuthoring.ts
  // :718, via `complexApprovalConfigHasBackendDrop` :642-660) ALREADY fails an entire COMPLEX
  // template closed to a global `readOnly` (TemplateAuthoringView.vue:1245) the moment ANY node's
  // assigneeSources[0].kind is outside `BACKEND_ASSIGNEE_SOURCE_KEYS_BY_KIND` — not scoped to that
  // one node. The next test proves that gate empirically through the full view. See the PR
  // description for why P1-A does not (and should not) touch that pre-existing G-1 anti-flatten
  // guard to make A-4's literal "known kind in the same fixture renders editable" reachable
  // end-to-end.
  it('A-4: an unknown persisted source kind renders read-only and round-trips unchanged; a known kind in the same fixture is editable', () => {
    const unknownSource = { kind: 'department_field_routing', legacyField: 'z' }
    const api = createStubConfigApi({
      approval_unknown: { assigneeSources: [unknownSource] },
      approval_known: { assigneeSources: [{ kind: 'direct_manager' }] },
    })

    const unknownMount = mountDirectInspector({
      node: makeApprovalNode('approval_unknown'),
      registry: DEFAULT_APPROVAL_CAPABILITY_REGISTRY,
      api,
    })
    const checkedRadios = Array.from(unknownMount.container.querySelectorAll('input[type="radio"]')).filter(
      (el) => (el as HTMLInputElement).checked,
    )
    expect(checkedRadios).toHaveLength(0)
    expect(unknownMount.container.querySelector('[data-testid="approval-node-source-kind-unknown"]')).not.toBeNull()
    unknownMount.unmount()

    // Round-trip: the underlying source object is never mutated when left untouched — same
    // reference-equal shape, not flattened to a registry default.
    expect(api.approvalNodeEditFor('approval_unknown')?.assigneeSources[0]).toEqual(unknownSource)

    // A known kind in the SAME fixture (a different node) stays editable — proving the read-only
    // branch is value-selected, not a blanket regression.
    const knownMount = mountDirectInspector({
      node: makeApprovalNode('approval_known'),
      registry: DEFAULT_APPROVAL_CAPABILITY_REGISTRY,
      api,
    })
    const knownRadio = knownMount.container.querySelector(
      '[data-testid="approval-node-source-kind-direct_manager"]',
    ) as HTMLInputElement
    expect(knownRadio.checked).toBe(true)
    expect(knownRadio.disabled).toBe(false)
    knownMount.unmount()
  })

  it('A-4 reachability (empirical): a complex graph with an unknown assignee-source kind on ONE node opens the WHOLE template read-only via the pre-existing G-1 guard, not scoped to that node', async () => {
    routeParams = { id: 'tpl_a4_reachability' }
    getTemplateSpy.mockResolvedValue(
      buildTemplate({
        approvalGraph: {
          nodes: [
            { key: 'start', type: 'start', name: '发起', config: {} },
            {
              key: 'approval_unknown',
              type: 'approval',
              name: '未知来源',
              config: { assigneeSources: [{ kind: 'department_field_routing' }], approvalMode: 'single', emptyAssigneePolicy: 'error' },
            },
            { key: 'cc_1', type: 'cc', name: '抄送', config: { targetType: 'user', targetIds: ['u1'] } },
            {
              key: 'approval_known',
              type: 'approval',
              name: '已知来源',
              config: { assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error' },
            },
            { key: 'end', type: 'end', name: '结束', config: {} },
          ],
          edges: [
            { key: 'e1', source: 'start', target: 'approval_unknown' },
            { key: 'e2', source: 'approval_unknown', target: 'cc_1' },
            { key: 'e3', source: 'cc_1', target: 'approval_known' },
            { key: 'e4', source: 'approval_known', target: 'end' },
          ],
        } as any,
      }),
    )
    await mountView()
    await flushUi()

    // Confirms the A-4 SCOPE NOTE above with a real mount: the template opens with the
    // unsupported-alert banner, and the whole editor (including the KNOWN node) is read-only —
    // this is `unsupportedTemplateAuthoringReason` (templateAuthoring.ts:718), a pre-existing G-1
    // anti-flatten guard this slice does not touch.
    expect(container!.querySelector('[data-testid="approval-template-unsupported-alert"]')).not.toBeNull()
    const saveButton = container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement | null
    if (saveButton) expect(saveButton.disabled).toBe(true)
  })

  // ── Lock-1 §K2 — requester_choice authoring sub-form + G-16 positive arm ─────────────────────
  it('K2 (G-16 positive arm): requester_choice renders EDITABLE with its typed summary — mode radio + scope select, no unknown-kind hint', () => {
    const api = createStubConfigApi({
      approval_rc: { assigneeSources: [{ kind: 'requester_choice', mode: 'single', scope: { type: 'company' } }] },
    })
    const { container: c, unmount } = mountDirectInspector({
      node: makeApprovalNode('approval_rc'),
      registry: DEFAULT_APPROVAL_CAPABILITY_REGISTRY,
      api,
    })
    // Registry-known (the row landed in the SAME slice): roster radio checked + enabled, no A-4 hint.
    const rosterRadio = c.querySelector('[data-testid="approval-node-source-kind-requester_choice"]') as HTMLInputElement
    expect(rosterRadio).not.toBeNull()
    expect(rosterRadio.checked).toBe(true)
    expect(rosterRadio.disabled).toBe(false)
    expect(c.querySelector('[data-testid="approval-node-source-kind-unknown"]')).toBeNull()
    // D2 typed summary echo — mode + scope, count-only wording (no raw ids anywhere).
    expect(
      c.querySelector('[data-testid="approval-node-source-configured-summary"]')?.textContent,
    ).toBe('已配置：提交人自选（单选 · 全公司）')
    // Sub-form: mode radios reflect the model; company scope renders NO id picker at all.
    const single = c.querySelector('[data-testid="approval-node-requester-choice-mode-single"]') as HTMLInputElement
    const multi = c.querySelector('[data-testid="approval-node-requester-choice-mode-multi"]') as HTMLInputElement
    expect(single.checked).toBe(true)
    expect(multi.checked).toBe(false)
    expect(c.querySelector('[data-testid="approval-node-requester-choice-scope"]')).not.toBeNull()
    expect(c.querySelector('[data-testid="approval-node-requester-choice-user-picker"]')).toBeNull()
    expect(c.querySelector('[data-testid="approval-node-requester-choice-role-picker"]')).toBeNull()
    unmount()
  })

  it('K2: mode radio + scope select write the SHARED edit model; members/role scopes swap in their typed pickers (no raw-ID input)', async () => {
    const api = createStubConfigApi({
      approval_rc: { assigneeSources: [{ kind: 'requester_choice', mode: 'single', scope: { type: 'company' } }] },
    })
    // The typed pickers list directory options only — no free-text id entry exists anywhere in
    // the sub-form (D0 §10.2).
    ;(api as { directoryUsers: Array<{ id: string; name?: string; email?: string }> }).directoryUsers = [
      { id: 'u_alpha', name: 'Alpha', email: 'a@x.test' },
    ]
    ;(api as { directoryRoles: Array<{ id: string; name?: string }> }).directoryRoles = [
      { id: 'role_fin', name: '财务' },
    ]
    const { container: c, unmount } = mountDirectInspector({
      node: makeApprovalNode('approval_rc'),
      registry: DEFAULT_APPROVAL_CAPABILITY_REGISTRY,
      api,
    })

    // mode single → multi via the native radio.
    const multi = c.querySelector('[data-testid="approval-node-requester-choice-mode-multi"]') as HTMLInputElement
    multi.checked = true
    multi.dispatchEvent(new Event('change'))
    expect(api.approvalNodeEditFor('approval_rc')?.assigneeSources[0]).toEqual({
      kind: 'requester_choice',
      mode: 'multi',
      scope: { type: 'company' },
    })

    // scope company → members: the typed USER picker appears, and the switch starts from an
    // EMPTY id list (userIds/roleIds are different id domains — never carried across).
    const scopeSelect = c.querySelector('[data-testid="approval-node-requester-choice-scope"]') as HTMLSelectElement
    scopeSelect.value = 'members'
    scopeSelect.dispatchEvent(new Event('change'))
    await flushUi()
    expect(api.approvalNodeEditFor('approval_rc')?.assigneeSources[0]).toEqual({
      kind: 'requester_choice',
      mode: 'multi',
      scope: { type: 'members', userIds: [] },
    })
    const userPicker = c.querySelector('[data-testid="approval-node-requester-choice-user-picker"]') as HTMLSelectElement
    expect(userPicker).not.toBeNull()
    expect(c.querySelector('[data-testid="approval-node-requester-choice-role-picker"]')).toBeNull()

    // Picking a member writes scope.userIds into the SAME shared edit model.
    userPicker.value = 'u_alpha'
    userPicker.dispatchEvent(new Event('change'))
    expect(api.approvalNodeEditFor('approval_rc')?.assigneeSources[0]).toEqual({
      kind: 'requester_choice',
      mode: 'multi',
      scope: { type: 'members', userIds: ['u_alpha'] },
    })

    // scope members → role: ROLE picker replaces the user picker, id list resets again.
    scopeSelect.value = 'role'
    scopeSelect.dispatchEvent(new Event('change'))
    await flushUi()
    expect(api.approvalNodeEditFor('approval_rc')?.assigneeSources[0]).toEqual({
      kind: 'requester_choice',
      mode: 'multi',
      scope: { type: 'role', roleIds: [] },
    })
    expect(c.querySelector('[data-testid="approval-node-requester-choice-user-picker"]')).toBeNull()
    const rolePicker = c.querySelector('[data-testid="approval-node-requester-choice-role-picker"]') as HTMLSelectElement
    expect(rolePicker).not.toBeNull()
    rolePicker.value = 'role_fin'
    rolePicker.dispatchEvent(new Event('change'))
    expect(api.approvalNodeEditFor('approval_rc')?.assigneeSources[0]).toEqual({
      kind: 'requester_choice',
      mode: 'multi',
      scope: { type: 'role', roleIds: ['role_fin'] },
    })
    unmount()
  })
})
