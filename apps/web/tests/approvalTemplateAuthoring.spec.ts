/* eslint-disable vue/one-component-per-file, vue/require-default-prop */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import TemplateAuthoringView from '../src/views/approval/TemplateAuthoringView.vue'
import type { ApprovalNodeConfig, ApprovalTemplateDetailDTO, AutoApprovalPolicy } from '../src/types/approval'
import { APPROVAL_ROLE_CONFIGURE_SENTINEL } from '../src/types/approval'
import {
  buildApprovalGraph,
  buildCreateTemplatePayload,
  buildFormSchema,
  createEmptyTemplateDraft,
  draftFromTemplate,
  graphReadOnlyReason,
  unsupportedTemplateAuthoringReason,
  validateTemplateDraft,
} from '../src/approvals/templateAuthoring'

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

vi.mock('../src/approvals/api', () => ({
  createTemplate: (payload: unknown) => createTemplateSpy(payload),
  updateTemplate: (id: string, payload: unknown) => updateTemplateSpy(id, payload),
  publishTemplate: (id: string, payload: unknown) => publishTemplateSpy(id, payload),
  getTemplate: (id: string) => getTemplateSpy(id),
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
  props: { modelValue: [String, Number], disabled: Boolean, type: String, rows: Number, placeholder: String },
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

const ElTable = defineComponent({
  name: 'ElTable',
  props: { data: Array },
  render() {
    return h('div', {
      'data-testid': (this.$attrs as any)?.['data-testid'],
    }, this.$slots.default?.())
  },
})

const ElTableColumn = defineComponent({
  name: 'ElTableColumn',
  props: { label: String },
  render() {
    return h('div')
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

function installStubs(app: VueApp<Element>) {
  app.directive('loading', {})
  app.component('ElButton', ElButton)
  app.component('ElInput', ElInput)
  app.component('ElInputNumber', ElInputNumber)
  app.component('ElSelect', ElSelect)
  app.component('ElOption', ElOption)
  app.component('ElCheckbox', ElCheckbox)
  app.component('ElAlert', ElAlert)
  app.component('ElTable', ElTable)
  app.component('ElTableColumn', ElTableColumn)
  app.component('ElCard', passthrough('ElCard', 'section'))
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
      fields: [
        { id: 'amount', type: 'number', label: '金额', required: true },
        {
          id: 'reviewer',
          type: 'user',
          label: '审批人',
          visibilityRule: { fieldId: 'amount', operator: 'notEmpty' },
        },
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
            assigneeSources: [{ kind: 'form_field_user', fieldId: 'reviewer' }],
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

describe('approval template authoring helpers', () => {
  it('preserves visibilityRule metadata while rebuilding supported fields', () => {
    const template = buildTemplate()
    const draft = draftFromTemplate(template)
    draft.fields[0].label = '报销金额'

    const schema = buildFormSchema(draft)

    expect(schema.fields[1]?.visibilityRule).toEqual({ fieldId: 'amount', operator: 'notEmpty' })
    expect(schema.fields[0]?.label).toBe('报销金额')
  })

  it('G-1: load-PRESERVES a complex (parallel) graph instead of flattening — graph read-only, save-able, byte-identical round-trip', () => {
    // Behaviour CHANGED at G-1: cc/condition/parallel are no longer "unsupported" (which blocked
    // save). They are load-preserved verbatim — the graph renders read-only, the form stays
    // editable, and save re-emits the SAME graph (no flatten). See the dedicated round-trip suite
    // in approval-template-authoring-graph-preserve.test.ts.
    const template = buildTemplate({
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: '发起', config: {} },
          { key: 'fork', type: 'parallel', name: '并行', config: { branches: ['a', 'b'], joinMode: 'all', joinNodeKey: 'join' } },
          { key: 'end', type: 'end', name: '结束', config: {} },
        ],
        edges: [
          { key: 'edge-start-fork', source: 'start', target: 'fork' },
          { key: 'edge-fork-end', source: 'fork', target: 'end' },
        ],
      },
    })

    // no longer unsupported (save NOT blocked) — but the graph is flagged read-only.
    expect(unsupportedTemplateAuthoringReason(template)).toBeNull()
    expect(graphReadOnlyReason(template)).not.toBeNull()
    // anti-flatten: save re-emits the parallel graph byte-identical, never the linear projection.
    const rebuilt = buildApprovalGraph(draftFromTemplate(template))
    expect(rebuilt).toEqual(template.approvalGraph)
    expect(rebuilt.nodes.some((node) => node.type === 'parallel')).toBe(true)
  })

  it('fails closed on a node carrying fieldPermissions (no node-field editor yet)', () => {
    // P1-C: fieldPermissions is NOT in the FE allowlist until a node-field
    // permission editor ships. A template carrying it must render read-only in
    // the MVP editor (never silently flattened) so the hidden-field config is
    // preserved on the round-trip.
    const reason = unsupportedTemplateAuthoringReason(buildTemplate({
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: '发起', config: {} },
          {
            key: 'approval_1',
            type: 'approval',
            name: '审批人 1',
            config: {
              assigneeSources: [{ kind: 'form_field_user', fieldId: 'reviewer' }],
              approvalMode: 'single',
              emptyAssigneePolicy: 'error',
              fieldPermissions: [{ fieldId: 'amount', access: 'hidden' }],
            } as never,
          },
          { key: 'end', type: 'end', name: '结束', config: {} },
        ],
        edges: [
          { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
          { key: 'edge-approval_1-end', source: 'approval_1', target: 'end' },
        ],
      },
    }))

    expect(reason).toContain('暂不支持的配置')
  })

  it('blocks existing attachment fields because the MVP has no upload runtime', () => {
    const reason = unsupportedTemplateAuthoringReason(buildTemplate({
      formSchema: {
        fields: [
          { id: 'file', type: 'attachment', label: '附件' },
        ],
      },
    }))

    expect(reason).toContain('暂不支持编辑的字段类型')
  })

  it('validates duplicate field ids, select options, and form-field-user sources', () => {
    const draft = createEmptyTemplateDraft()
    draft.key = 'bad'
    draft.name = '坏模板'
    draft.fields = [
      { ...draft.fields[0], id: 'dup', label: '字段 A', type: 'select', optionsText: '' },
      { ...draft.fields[0], localId: 'field_2', id: 'dup', label: '字段 B', type: 'text' },
    ]
    draft.steps[0].sourceKind = 'form_field_user'
    draft.steps[0].fieldId = 'missing_user_field'

    const errors = validateTemplateDraft(draft)

    expect(errors).toContain('字段 id 不能重复')
    expect(errors.some((error) => error.includes('需要至少一个选项'))).toBe(true)
    expect(errors.some((error) => error.includes('表单用户字段无效'))).toBe(true)
  })

  it('emits an editable visibility rule (eq / in / isEmpty) from the draft', () => {
    const draft = createEmptyTemplateDraft()
    draft.fields = [
      { ...draft.fields[0], id: 'kind', label: '类型', type: 'select', optionsText: 'A:a\nB:b' },
      { ...draft.fields[0], localId: 'field_2', id: 'reason', label: '原因', type: 'text',
        visibility: { dependsOnFieldId: 'kind', operator: 'eq', valueText: 'a' } },
    ]
    expect(buildFormSchema(draft).fields[1]?.visibilityRule).toEqual({ fieldId: 'kind', operator: 'eq', value: 'a' })

    draft.fields[1].visibility = { dependsOnFieldId: 'kind', operator: 'in', valueText: 'a\nb\n' }
    expect(buildFormSchema(draft).fields[1]?.visibilityRule).toEqual({ fieldId: 'kind', operator: 'in', values: ['a', 'b'] })

    draft.fields[1].visibility = { dependsOnFieldId: 'kind', operator: 'isEmpty', valueText: 'ignored' }
    expect(buildFormSchema(draft).fields[1]?.visibilityRule).toEqual({ fieldId: 'kind', operator: 'isEmpty' })
  })

  it('is authoritative: clearing the rule removes it instead of leaking the original', () => {
    // buildTemplate's `reviewer` field carries visibilityRule { amount, notEmpty }.
    const draft = draftFromTemplate(buildTemplate())
    expect(draft.fields[1].visibility.dependsOnFieldId).toBe('amount')
    draft.fields[1].visibility = { dependsOnFieldId: '', operator: 'eq', valueText: '' }
    expect(buildFormSchema(draft).fields[1]?.visibilityRule).toBeUndefined()
  })

  it('mirrors the server visibility reject-set (existing / self / in-empty / cycle)', () => {
    const base = () => {
      const draft = createEmptyTemplateDraft()
      draft.key = 'k'
      draft.name = 'n'
      draft.fields = [
        { ...draft.fields[0], id: 'a', label: 'A', type: 'text' },
        { ...draft.fields[0], localId: 'field_2', id: 'b', label: 'B', type: 'text' },
      ]
      return draft
    }

    const missing = base()
    missing.fields[1].visibility = { dependsOnFieldId: 'nope', operator: 'eq', valueText: 'x' }
    expect(validateTemplateDraft(missing).some((e) => e.includes('显隐依赖字段不存在'))).toBe(true)

    const self = base()
    self.fields[1].visibility = { dependsOnFieldId: 'b', operator: 'eq', valueText: 'x' }
    expect(validateTemplateDraft(self).some((e) => e.includes('不能依赖自身'))).toBe(true)

    const inEmpty = base()
    inEmpty.fields[1].visibility = { dependsOnFieldId: 'a', operator: 'in', valueText: '  \n ' }
    expect(validateTemplateDraft(inEmpty).some((e) => e.includes('需要至少一个值'))).toBe(true)

    const cycle = base()
    cycle.fields[0].visibility = { dependsOnFieldId: 'b', operator: 'eq', valueText: 'x' }
    cycle.fields[1].visibility = { dependsOnFieldId: 'a', operator: 'eq', valueText: 'y' }
    expect(validateTemplateDraft(cycle).some((e) => e.includes('循环依赖'))).toBe(true)

    const valid = base()
    valid.fields[1].visibility = { dependsOnFieldId: 'a', operator: 'eq', valueText: 'x' }
    expect(validateTemplateDraft(valid).some((e) => e.includes('显隐'))).toBe(false)
  })

  it('builds a create payload with C1 assigneeSources and a deterministic linear graph', () => {
    const draft = createEmptyTemplateDraft()
    draft.key = 'leave'
    draft.name = '请假审批'
    draft.fields[0].id = 'reviewer'
    draft.fields[0].label = '审批人'
    draft.fields[0].type = 'user'
    draft.steps[0].sourceKind = 'form_field_user'
    draft.steps[0].fieldId = 'reviewer'

    const payload = buildCreateTemplatePayload(draft)

    expect(payload.approvalGraph.nodes.map((node) => node.key)).toEqual(['start', 'approval_1', 'end'])
    expect((payload.approvalGraph.nodes[1]?.config as any).assigneeSources).toEqual([
      { kind: 'form_field_user', fieldId: 'reviewer' },
    ])
  })

  it('round-trips a direct_manager assignee source (save emits {kind} + hydrate restores sourceKind)', () => {
    const draft = createEmptyTemplateDraft()
    draft.key = 'mgr'
    draft.name = '经理审批'
    draft.steps[0].sourceKind = 'direct_manager'

    const payload = buildCreateTemplatePayload(draft)
    expect((payload.approvalGraph.nodes[1]?.config as any).assigneeSources).toEqual([{ kind: 'direct_manager' }])

    const rehydrated = draftFromTemplate(buildTemplate({ approvalGraph: payload.approvalGraph }))
    expect(rehydrated.steps[0].sourceKind).toBe('direct_manager')
  })

  it('round-trips a dept_head assignee source (save emits {kind} + hydrate restores sourceKind)', () => {
    const draft = createEmptyTemplateDraft()
    draft.key = 'dh'
    draft.name = '部门主管审批'
    draft.steps[0].sourceKind = 'dept_head'

    const payload = buildCreateTemplatePayload(draft)
    expect((payload.approvalGraph.nodes[1]?.config as any).assigneeSources).toEqual([{ kind: 'dept_head' }])

    const rehydrated = draftFromTemplate(buildTemplate({ approvalGraph: payload.approvalGraph }))
    expect(rehydrated.steps[0].sourceKind).toBe('dept_head')
  })

  it('round-trips a continuous_managers source incl. levels (save emits {kind, levels}; levels survives the real wire)', () => {
    const draft = createEmptyTemplateDraft()
    draft.key = 'cm'
    draft.name = '多级上级审批'
    draft.steps[0].sourceKind = 'continuous_managers'
    draft.steps[0].levels = 3

    const payload = buildCreateTemplatePayload(draft)
    expect((payload.approvalGraph.nodes[1]?.config as any).assigneeSources).toEqual([{ kind: 'continuous_managers', levels: 3 }])

    // wire-vs-fixture trap: assert `levels` survives the real serialize→parse, not a hand-built chip.
    const rehydrated = draftFromTemplate(buildTemplate({ approvalGraph: payload.approvalGraph }))
    expect(rehydrated.steps[0].sourceKind).toBe('continuous_managers')
    expect(rehydrated.steps[0].levels).toBe(3)
  })

  it('round-trips a manager_at_level source incl. level (save emits {kind, level}; level survives the real wire)', () => {
    const draft = createEmptyTemplateDraft()
    draft.key = 'mal'
    draft.name = '逐级上级审批'
    draft.steps[0].sourceKind = 'manager_at_level'
    draft.steps[0].level = 2

    const payload = buildCreateTemplatePayload(draft)
    expect((payload.approvalGraph.nodes[1]?.config as any).assigneeSources).toEqual([{ kind: 'manager_at_level', level: 2 }])

    // wire-vs-fixture trap: assert `level` survives the real serialize→parse, not a hand-built chip.
    const rehydrated = draftFromTemplate(buildTemplate({ approvalGraph: payload.approvalGraph }))
    expect(rehydrated.steps[0].sourceKind).toBe('manager_at_level')
    expect(rehydrated.steps[0].level).toBe(2)
  })

  // Lane E — self-approver authoring (autoApprovalPolicy.mergeWithRequester).
  function buildAutoApprovalTemplate(
    policy: AutoApprovalPolicy,
    extraConfig: Record<string, unknown> = {},
  ): ApprovalTemplateDetailDTO {
    return buildTemplate({
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: '发起', config: {} },
          {
            key: 'approval_1',
            type: 'approval',
            name: '审批人 1',
            config: {
              assigneeSources: [{ kind: 'requester' }],
              approvalMode: 'single',
              emptyAssigneePolicy: 'error',
              autoApprovalPolicy: policy,
              ...extraConfig,
            },
          },
          { key: 'end', type: 'end', name: '结束', config: {} },
        ],
        edges: [
          { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
          { key: 'edge-approval_1-end', source: 'approval_1', target: 'end' },
        ],
      },
    })
  }

  it('T1: hydrates mergeWithRequester and captures the full policy carrier', () => {
    const draft = draftFromTemplate(buildAutoApprovalTemplate({ mergeWithRequester: true }))
    expect(draft.steps[0].mergeWithRequester).toBe(true)
    expect(draft.steps[0].originalAutoApprovalPolicy).toEqual({ mergeWithRequester: true })
  })

  it('T2: round-trips merge-on through buildApprovalGraph', () => {
    const draft = draftFromTemplate(buildAutoApprovalTemplate({ mergeWithRequester: true }))
    const graph = buildApprovalGraph(draft)
    const config = graph.nodes[1]?.config as ApprovalNodeConfig
    expect(config.autoApprovalPolicy).toEqual({ mergeWithRequester: true })
  })

  it('T3: a node carrying only allowed keys + autoApprovalPolicy is editable (not read-only)', () => {
    const reason = unsupportedTemplateAuthoringReason(buildAutoApprovalTemplate({ mergeWithRequester: true }))
    expect(reason).toBeNull()
  })

  it('T4: omits autoApprovalPolicy entirely when off with no preserved policy (not {})', () => {
    const draft = createEmptyTemplateDraft()
    draft.steps[0].mergeWithRequester = false
    const config = buildApprovalGraph(draft).nodes[1]?.config as ApprovalNodeConfig
    expect('autoApprovalPolicy' in config).toBe(false)
  })

  it('T5: preserves non-merge policy siblings across a toggle off-then-on', () => {
    const draft = draftFromTemplate(buildAutoApprovalTemplate({
      mergeWithRequester: true,
      mergeAdjacentApprover: true,
      actorMode: 'system',
    }))
    // toggle off: siblings survive, merge flag dropped
    draft.steps[0].mergeWithRequester = false
    const offConfig = buildApprovalGraph(draft).nodes[1]?.config as ApprovalNodeConfig
    expect(offConfig.autoApprovalPolicy).toEqual({ mergeAdjacentApprover: true, actorMode: 'system' })
    // toggle back on: merge flag returns, siblings still present
    draft.steps[0].mergeWithRequester = true
    const onConfig = buildApprovalGraph(draft).nodes[1]?.config as ApprovalNodeConfig
    expect(onConfig.autoApprovalPolicy).toEqual({
      mergeWithRequester: true,
      mergeAdjacentApprover: true,
      actorMode: 'system',
    })
  })

  it('T6: keeps fail-closed read-only for any OTHER unsupported config key', () => {
    const reason = unsupportedTemplateAuthoringReason(
      buildAutoApprovalTemplate({ mergeWithRequester: true }, { bogusKey: 'x' }),
    )
    expect(reason).not.toBeNull()
    expect(reason).toContain('暂不支持')
  })
})

describe('TemplateAuthoringView', () => {
  beforeEach(() => {
    routeParams = {}
    canManageTemplates.value = true
    createTemplateSpy.mockReset()
    updateTemplateSpy.mockReset()
    publishTemplateSpy.mockReset()
    getTemplateSpy.mockReset()
    pushSpy.mockClear()
    replaceSpy.mockClear()
    createTemplateSpy.mockImplementation(async (payload) => ({
      ...buildTemplate({ id: 'tpl_created' }),
      key: payload.key,
      name: payload.name,
      formSchema: payload.formSchema,
      approvalGraph: payload.approvalGraph,
    }))
    updateTemplateSpy.mockImplementation(async (id, payload) => ({
      ...buildTemplate({ id }),
      ...payload,
    }))
    publishTemplateSpy.mockResolvedValue({})
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
  })

  it('creates a draft through the existing backend endpoint wrapper path', async () => {
    await mountView()

    setInput('approval-template-key', 'travel')
    setInput('approval-template-name', '出差审批')
    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()

    expect(createTemplateSpy).toHaveBeenCalledTimes(1)
    const payload = createTemplateSpy.mock.calls[0]?.[0] as any
    expect(payload.key).toBe('travel')
    expect(payload.name).toBe('出差审批')
    expect(payload.approvalGraph.nodes.map((node: any) => node.key)).toEqual(['start', 'approval_1', 'end'])
    expect(replaceSpy).toHaveBeenCalledWith({ path: '/approval-templates/tpl_created/edit' })
  })

  it('creates a common purchase template as a draft without publishing', async () => {
    await mountView()

    const button = container!.querySelector('[data-testid="approval-template-preset-purchase"]') as HTMLButtonElement
    expect(button).not.toBeNull()
    button.click()
    await flushUi()

    expect(createTemplateSpy).toHaveBeenCalledTimes(1)
    expect(publishTemplateSpy).not.toHaveBeenCalled()
    const payload = createTemplateSpy.mock.calls[0]?.[0] as any
    expect(payload.key).toMatch(/^purchase-approval-/)
    expect(payload.name).toBe('采购审批')
    expect(payload.category).toBe('采购')
    expect(payload.formSchema.fields.some((field: any) => field.id === 'purchase_items' && field.type === 'detail')).toBe(true)
    expect(payload.approvalGraph.nodes.filter((node: any) => node.type === 'approval')).toHaveLength(3)
    expect(replaceSpy).toHaveBeenCalledWith({ path: '/approval-templates/tpl_created/edit' })
  })

  // POST-GATE combined-view acceptance (runbook Stage A1/A2): A picker + E self-approver
  // coexist editable on one template; the same shape carrying B fieldPermissions is fail-closed.
  function buildComboGraph(node1Config: Record<string, unknown>) {
    return {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        { key: 'approval_1', type: 'approval', name: '审批人 1', config: node1Config },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'approval_1' },
        { key: 'e2', source: 'approval_1', target: 'end' },
      ],
    }
  }

  it('combined view A1: a static_user + self-approver step renders the directory picker (A) and the self-approver toggle (E) together, editable', async () => {
    routeParams = { id: 'tpl_combo' }
    getTemplateSpy.mockResolvedValue(buildTemplate({
      approvalGraph: buildComboGraph({ assigneeSources: [{ kind: 'static_user', userIds: ['u1'] }], approvalMode: 'single', emptyAssigneePolicy: 'error', autoApprovalPolicy: { mergeWithRequester: true } }),
    }))
    await mountView()
    await flushUi()

    expect(container!.querySelector('[data-testid="approval-step-user-picker"]')).not.toBeNull() // A renders
    expect(container!.querySelector('[data-testid="approval-step-merge-with-requester"]')).not.toBeNull() // E renders, same step
    expect(container!.querySelector('[data-testid="approval-template-unsupported-alert"]')).toBeNull() // editable, not fail-closed
    expect((container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('combined view A2: the same template carrying fieldPermissions opens fail-closed (B) — unsupported alert + save disabled', async () => {
    routeParams = { id: 'tpl_combo_fp' }
    getTemplateSpy.mockResolvedValue(buildTemplate({
      approvalGraph: buildComboGraph({ assigneeSources: [{ kind: 'static_user', userIds: ['u1'] }], approvalMode: 'single', emptyAssigneePolicy: 'error', autoApprovalPolicy: { mergeWithRequester: true }, fieldPermissions: [{ fieldId: 'secret', access: 'hidden' }] }),
    }))
    await mountView()
    await flushUi()

    expect(container!.querySelector('[data-testid="approval-template-unsupported-alert"]')).not.toBeNull() // B fail-closed
    expect((container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).disabled).toBe(true) // save disabled
  })

  it('direct_manager reads back editable: a saved direct_manager template is NOT fail-closed (no unsupported alert, save enabled, sourceKind hydrated)', async () => {
    routeParams = { id: 'tpl_dm' }
    getTemplateSpy.mockResolvedValue(buildTemplate({
      approvalGraph: buildComboGraph({ assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error' }),
    }))
    await mountView()
    await flushUi()

    expect(container!.querySelector('[data-testid="approval-template-unsupported-alert"]')).toBeNull() // in the allowlist → not fail-closed
    expect((container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).disabled).toBe(false) // editable
    expect((container!.querySelector('[data-testid="approval-step-source-kind"]') as HTMLSelectElement).value).toBe('direct_manager') // hydrated back
  })

  // G-5 wiring (mounted SFC): helper tests prove the edit logic; these prove the COMPLEX-graph
  // approval-node SOURCE control actually writes the changed source through @update:model-value →
  // edit model → save payload (the wire a pure-helper test can't see), and that a legacy node shows
  // no editor. cc node forces the preserved-graph (complex) path so the structured editor renders.
  function buildG5ComplexGraph(approval1Config: Record<string, unknown>) {
    return {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        { key: 'approval_1', type: 'approval', name: '主管', config: approval1Config },
        { key: 'cc_1', type: 'cc', name: '抄送', config: { targetType: 'role', targetIds: ['finance'] } },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'approval_1' },
        { key: 'e2', source: 'approval_1', target: 'cc_1' },
        { key: 'e3', source: 'cc_1', target: 'end' },
      ],
    }
  }

  it('G-5 wiring: changing an approval-node source via the SFC control writes it to the save payload; mode/policy/autoApprovalPolicy + cc + edges preserved', async () => {
    routeParams = { id: 'tpl_g5' }
    const graph = buildG5ComplexGraph({ assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error', autoApprovalPolicy: { mergeWithRequester: true } })
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: graph }))
    await mountView()
    await flushUi()

    // editor renders for the seeded approval node, hydrated to its current source
    expect(container!.querySelector('[data-approval-node="approval_1"]')).not.toBeNull()
    const kindSelect = container!.querySelector('[data-testid="approval-node-source-kind"]') as HTMLSelectElement
    expect(kindSelect).not.toBeNull()
    expect(kindSelect.value).toBe('direct_manager')

    // change the source kind through the REAL control (direct_manager → dept_head — both valid
    // no-ID kinds; a static_* target would need IDs the multi-select stub can't drive, and that ID
    // logic is helper-covered. Note: switching to an EMPTY static_role correctly BLOCKS save via the
    // validation preview — proving validation is wired too), then save.
    kindSelect.value = 'dept_head'
    kindSelect.dispatchEvent(new Event('change'))
    await flushUi()
    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()

    expect(updateTemplateSpy).toHaveBeenCalledTimes(1)
    const payload = updateTemplateSpy.mock.calls[0]?.[1] as any
    const approval1 = payload.approvalGraph.nodes.find((n: any) => n.key === 'approval_1')
    expect(approval1.config.assigneeSources).toEqual([{ kind: 'dept_head' }]) // CHANGED via the control
    expect(approval1.config.approvalMode).toBe('single') // preserved on the edited node
    expect(approval1.config.emptyAssigneePolicy).toBe('error') // preserved
    expect(approval1.config.autoApprovalPolicy).toEqual({ mergeWithRequester: true }) // preserved
    // cc node + ALL edges byte-identical
    expect(payload.approvalGraph.nodes.find((n: any) => n.key === 'cc_1').config).toEqual({ targetType: 'role', targetIds: ['finance'] })
    expect(payload.approvalGraph.edges).toEqual(graph.edges)
  })

  it('G-5 wiring: a LEGACY approval node (assigneeType/assigneeIds, no assigneeSources) shows NO source editor but still renders read-only', async () => {
    routeParams = { id: 'tpl_g5_legacy' }
    getTemplateSpy.mockResolvedValue(buildTemplate({
      approvalGraph: buildG5ComplexGraph({ assigneeType: 'role', assigneeIds: ['legacy_role'], approvalMode: 'single' }),
    }))
    await mountView()
    await flushUi()

    expect(container!.querySelector('[data-approval-node="approval_1"]')).toBeNull() // no editor for a legacy node
    expect(container!.querySelector('[data-testid="approval-graph-readonly-list"]')).not.toBeNull() // graph still renders (legacy keys are allowlisted)
    expect(container!.querySelector('[data-testid="approval-template-unsupported-alert"]')).toBeNull() // not fail-closed
  })

  it('G-5 sentinel hint: an approval node whose static_role carries the placeholder sentinel shows the in-editor hint', async () => {
    routeParams = { id: 'tpl_sentinel' }
    getTemplateSpy.mockResolvedValue(buildTemplate({
      approvalGraph: buildG5ComplexGraph({ assigneeSources: [{ kind: 'static_role', roleIds: [APPROVAL_ROLE_CONFIGURE_SENTINEL] }], approvalMode: 'single', emptyAssigneePolicy: 'error' }),
    }))
    await mountView()
    await flushUi()
    expect(container!.querySelector('[data-testid="approval-node-placeholder-hint"]')).not.toBeNull() // surfaced in the editor, before publish
  })

  it('G-5 sentinel hint: a normal static_role (real role id) shows NO placeholder hint', async () => {
    routeParams = { id: 'tpl_realrole' }
    getTemplateSpy.mockResolvedValue(buildTemplate({
      approvalGraph: buildG5ComplexGraph({ assigneeSources: [{ kind: 'static_role', roleIds: ['finance-approvers'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' }),
    }))
    await mountView()
    await flushUi()
    expect(container!.querySelector('[data-testid="approval-node-placeholder-hint"]')).toBeNull()
  })

  it('dept_head reads back editable: a saved dept_head template is NOT fail-closed (no unsupported alert, save enabled, sourceKind hydrated)', async () => {
    routeParams = { id: 'tpl_dh' }
    getTemplateSpy.mockResolvedValue(buildTemplate({
      approvalGraph: buildComboGraph({ assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' }),
    }))
    await mountView()
    await flushUi()

    expect(container!.querySelector('[data-testid="approval-template-unsupported-alert"]')).toBeNull() // in the allowlist → not fail-closed
    expect((container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).disabled).toBe(false) // editable
    expect((container!.querySelector('[data-testid="approval-step-source-kind"]') as HTMLSelectElement).value).toBe('dept_head') // hydrated back
  })

  it('continuous_managers reads back editable: a saved continuous_managers template is NOT fail-closed (sourceKind + levels input hydrated)', async () => {
    routeParams = { id: 'tpl_cm' }
    getTemplateSpy.mockResolvedValue(buildTemplate({
      approvalGraph: buildComboGraph({ assigneeSources: [{ kind: 'continuous_managers', levels: 3 }], approvalMode: 'all', emptyAssigneePolicy: 'error' }),
    }))
    await mountView()
    await flushUi()

    expect(container!.querySelector('[data-testid="approval-template-unsupported-alert"]')).toBeNull() // in the allowlist → not fail-closed
    expect((container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).disabled).toBe(false) // editable
    expect((container!.querySelector('[data-testid="approval-step-source-kind"]') as HTMLSelectElement).value).toBe('continuous_managers') // hydrated back
    expect(container!.querySelector('[data-testid="approval-step-levels"]')).not.toBeNull() // the levels input renders for this kind
  })

  it('updates an existing supported template without replacing it through create', async () => {
    routeParams = { id: 'tpl_1' }
    getTemplateSpy.mockResolvedValue(buildTemplate())
    await mountView()

    setInput('approval-template-name', '费用审批 v2')
    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()

    expect(createTemplateSpy).not.toHaveBeenCalled()
    expect(updateTemplateSpy).toHaveBeenCalledTimes(1)
    expect(updateTemplateSpy.mock.calls[0]?.[0]).toBe('tpl_1')
    expect((updateTemplateSpy.mock.calls[0]?.[1] as any).name).toBe('费用审批 v2')
  })

  it('wires the visibility subform through the mounted view into the saved payload', async () => {
    routeParams = { id: 'tpl_1' }
    getTemplateSpy.mockResolvedValue(buildTemplate()) // fields[1] reviewer depends on `amount` (notEmpty)
    await mountView()
    await flushUi()

    const reviewerRow = () => container!.querySelectorAll('[data-testid="approval-template-field-row"]')[1] as HTMLElement
    const inRow = (testId: string) => reviewerRow().querySelector(`[data-testid="${testId}"]`)

    // hydrated wiring: the depends-on select reflects the stored rule.
    expect((inRow('approval-field-visibility-depends') as HTMLSelectElement).value).toBe('amount')
    // there is no value input yet because the stored operator is notEmpty.
    expect(inRow('approval-field-visibility-value')).toBeNull()

    // switch operator notEmpty -> eq (reveals the value input), then enter a value.
    const operatorSelect = inRow('approval-field-visibility-operator') as HTMLSelectElement
    operatorSelect.value = 'eq'
    operatorSelect.dispatchEvent(new Event('change'))
    await flushUi()
    const valueInput = inRow('approval-field-visibility-value') as HTMLInputElement
    valueInput.value = '1000'
    valueInput.dispatchEvent(new Event('input'))
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()

    expect(updateTemplateSpy).toHaveBeenCalledTimes(1)
    const payload = updateTemplateSpy.mock.calls[0]?.[1] as any
    expect(payload.formSchema.fields[1].visibilityRule).toEqual({ fieldId: 'amount', operator: 'eq', value: '1000' })
  })

  it('clearing the dependency in the mounted view drops the rule from the saved payload', async () => {
    routeParams = { id: 'tpl_1' }
    getTemplateSpy.mockResolvedValue(buildTemplate())
    await mountView()
    await flushUi()

    const reviewerRow = container!.querySelectorAll('[data-testid="approval-template-field-row"]')[1] as HTMLElement
    const dependsSelect = reviewerRow.querySelector('[data-testid="approval-field-visibility-depends"]') as HTMLSelectElement
    dependsSelect.value = ''
    dependsSelect.dispatchEvent(new Event('change'))
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()

    expect(updateTemplateSpy).toHaveBeenCalledTimes(1)
    const payload = updateTemplateSpy.mock.calls[0]?.[1] as any
    expect(payload.formSchema.fields[1].visibilityRule).toBeUndefined()
  })

  it('publishes with an explicit allowRevoke policy after saving', async () => {
    await mountView()

    setInput('approval-template-key', 'purchase')
    setInput('approval-template-name', '采购审批')
    ;(container!.querySelector('[data-testid="approval-template-publish-button"]') as HTMLButtonElement).click()
    await flushUi()

    expect(createTemplateSpy).toHaveBeenCalledTimes(1)
    expect(publishTemplateSpy).toHaveBeenCalledWith('tpl_created', { policy: { allowRevoke: true } })
    expect(pushSpy).toHaveBeenCalledWith({ path: '/approval-templates/tpl_created' })
  })

  it('T7: wires the self-approver toggle through the mounted view into the saved payload', async () => {
    await mountView()

    setInput('approval-template-key', 'leave')
    setInput('approval-template-name', '请假审批')
    const mergeToggle = container!.querySelector('[data-testid="approval-step-merge-with-requester"]') as HTMLInputElement
    mergeToggle.checked = true
    mergeToggle.dispatchEvent(new Event('change'))
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()

    expect(createTemplateSpy).toHaveBeenCalledTimes(1)
    const payload = createTemplateSpy.mock.calls[0]?.[0] as any
    expect(payload.approvalGraph.nodes[1].config.autoApprovalPolicy).toEqual({ mergeWithRequester: true })
  })

  it('G-1: opens a complex (parallel) graph READ-ONLY but save-able — preserves the graph on save, never flattens', async () => {
    // Behaviour CHANGED at G-1: a complex graph is no longer fail-closed (save disabled). It opens
    // with the form editable + the graph rendered read-only (structured node list), and SAVE is
    // enabled — the save re-emits the SAME graph (anti-flatten), it does not project to a linear
    // start→approval→end chain.
    routeParams = { id: 'tpl_parallel' }
    const parallelGraph = {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        { key: 'parallel_1', type: 'parallel', name: '并行审批', config: { branches: ['a', 'b'], joinMode: 'all', joinNodeKey: 'join_1' } },
        { key: 'approval_a', type: 'approval', name: '财务', config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'approval_b', type: 'approval', name: '法务', config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'join_1', type: 'approval', name: '汇聚', config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'edge-start-parallel_1', source: 'start', target: 'parallel_1' },
        { key: 'edge-parallel_1-a', source: 'parallel_1', target: 'approval_a' },
        { key: 'edge-parallel_1-b', source: 'parallel_1', target: 'approval_b' },
        { key: 'edge-approval_a-join', source: 'approval_a', target: 'join_1' },
        { key: 'edge-approval_b-join', source: 'approval_b', target: 'join_1' },
        { key: 'edge-join_1-end', source: 'join_1', target: 'end' },
      ],
    }
    getTemplateSpy.mockResolvedValue(buildTemplate({ id: 'tpl_parallel', approvalGraph: parallelGraph }))

    await mountView()
    await flushUi()

    // NOT fail-closed: no unsupported alert; the informational graph-read-only alert shows instead.
    expect(container!.querySelector('[data-testid="approval-template-unsupported-alert"]')).toBeNull()
    expect(container!.querySelector('[data-testid="approval-template-graph-readonly-alert"]')).not.toBeNull()
    // the linear steps editor is hidden; the read-only structured node list renders the parallel node.
    expect(container!.querySelector('[data-testid="approval-template-add-step"]')).toBeNull()
    const nodeRows = container!.querySelectorAll('[data-testid="approval-graph-node-row"]')
    expect(nodeRows.length).toBe(parallelGraph.nodes.length)
    expect(container!.querySelector('[data-node-type="parallel"]')).not.toBeNull()

    // save is ENABLED and preserves the graph byte-identical (anti-flatten through the real wire).
    const saveButton = container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement
    expect(saveButton.disabled).toBe(false)
    saveButton.click()
    await flushUi()

    expect(updateTemplateSpy).toHaveBeenCalledTimes(1)
    const payload = updateTemplateSpy.mock.calls[0]?.[1] as any
    expect(payload.approvalGraph).toEqual(parallelGraph)
    expect(payload.approvalGraph.nodes.some((node: any) => node.type === 'parallel')).toBe(true)
  })

  it('T8: disables the self-approver toggle when the template opens read-only', async () => {
    routeParams = { id: 'tpl_locked' }
    // A bogus config key forces fail-closed read-only while the approval step row
    // (and its merge checkbox) still renders.
    getTemplateSpy.mockResolvedValue(buildTemplate({
      id: 'tpl_locked',
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: '发起', config: {} },
          {
            key: 'approval_1',
            type: 'approval',
            name: '审批人 1',
            config: {
              assigneeSources: [{ kind: 'requester' }],
              approvalMode: 'single',
              emptyAssigneePolicy: 'error',
              bogusKey: 'x',
            },
          },
          { key: 'end', type: 'end', name: '结束', config: {} },
        ],
        edges: [
          { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
          { key: 'edge-approval_1-end', source: 'approval_1', target: 'end' },
        ],
      },
    }))

    await mountView()

    const mergeToggle = container!.querySelector('[data-testid="approval-step-merge-with-requester"]') as HTMLInputElement
    expect(mergeToggle).not.toBeNull()
    expect(mergeToggle.disabled).toBe(true)
  })
})
