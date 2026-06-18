import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import TemplateAuthoringView from '../src/views/approval/TemplateAuthoringView.vue'
import type { ApprovalNodeConfig, ApprovalTemplateDetailDTO, AutoApprovalPolicy } from '../src/types/approval'
import {
  buildApprovalGraph,
  buildCreateTemplatePayload,
  buildFormSchema,
  createEmptyTemplateDraft,
  draftFromTemplate,
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

function installStubs(app: VueApp<Element>) {
  app.directive('loading', {})
  app.component('ElButton', ElButton)
  app.component('ElInput', ElInput)
  app.component('ElSelect', ElSelect)
  app.component('ElOption', ElOption)
  app.component('ElCheckbox', ElCheckbox)
  app.component('ElAlert', ElAlert)
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

  it('blocks unsupported graph constructs instead of flattening them', () => {
    const reason = unsupportedTemplateAuthoringReason(buildTemplate({
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
    }))

    expect(reason).toContain('暂不支持编辑的审批节点')
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

  it('opens unsupported existing graphs read-only and refuses to save them', async () => {
    routeParams = { id: 'tpl_parallel' }
    getTemplateSpy.mockResolvedValue(buildTemplate({
      id: 'tpl_parallel',
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: '发起', config: {} },
          { key: 'parallel_1', type: 'parallel', name: '并行审批', config: { branches: ['a', 'b'], joinMode: 'all', joinNodeKey: 'end' } },
          { key: 'end', type: 'end', name: '结束', config: {} },
        ],
        edges: [
          { key: 'edge-start-parallel_1', source: 'start', target: 'parallel_1' },
          { key: 'edge-parallel_1-end', source: 'parallel_1', target: 'end' },
        ],
      },
    }))

    await mountView()

    expect(container!.querySelector('[data-testid="approval-template-unsupported-alert"]')?.textContent)
      .toContain('暂不支持编辑')
    const saveButton = container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement
    expect(saveButton.disabled).toBe(true)
    saveButton.click()
    await flushUi()

    expect(updateTemplateSpy).not.toHaveBeenCalled()
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
