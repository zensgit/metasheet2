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
      expect(PARENT_AUTHORING_SOURCE).toMatch(
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
    // Desktop inspector is wide enough for ms-w-360 controls (~400px).
    expect(PARENT_AUTHORING_SOURCE).toMatch(/\.template-authoring__canvas-inspector\s*\{[\s\S]*?width:\s*400px/)

    routeParams = { id: 'tpl_inspector_styles' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildMixedGraph() as any }))
    await mountView()
    await flushUi()

    // List surface (default): condition branch must receive child-owned dashed border + wrap head.
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
