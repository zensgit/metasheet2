/* eslint-disable vue/one-component-per-file, vue/require-default-prop */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, inject, nextTick, provide, ref, type App as VueApp, type InjectionKey } from 'vue'
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
  validateTemplateFormFields,
  validateTemplateBasicInfo,
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

const approvalCanvasV2 = ref(false)
vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    features: computed(() => ({ approvalCanvasV2: approvalCanvasV2.value })),
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

// P3-B (docs/development/approval-lock6-requester-global-policy-20260817.md §1 L6-A) — the
// dedup-tier control uses <el-radio-group>/<el-radio>, previously unused (and unstubbed) anywhere
// in this authoring view. Mirrors real Element Plus's provide/inject wiring closely enough for
// tests: the group provides its modelValue + updater, each radio reads/writes through it.
const RADIO_GROUP_KEY: InjectionKey<{
  modelValue: () => unknown
  update: (value: unknown) => void
  disabled: () => boolean
}> = Symbol('RadioGroup')

const ElRadioGroup = defineComponent({
  name: 'ElRadioGroup',
  inheritAttrs: false,
  props: { modelValue: [String, Number, Boolean], disabled: Boolean },
  emits: ['update:modelValue'],
  setup(props, { emit, attrs, slots }) {
    provide(RADIO_GROUP_KEY, {
      modelValue: () => props.modelValue,
      update: (value: unknown) => emit('update:modelValue', value),
      disabled: () => Boolean(props.disabled),
    })
    return () => h('div', {
      'data-testid': (attrs as any)?.['data-testid'],
      role: 'radiogroup',
    }, slots.default?.())
  },
})

const ElRadio = defineComponent({
  name: 'ElRadio',
  inheritAttrs: false,
  props: { value: [String, Number, Boolean], disabled: Boolean },
  setup(props, { attrs, slots }) {
    const group = inject(RADIO_GROUP_KEY, null)
    return () => h('label', [
      h('input', {
        type: 'radio',
        checked: group ? group.modelValue() === props.value : false,
        disabled: Boolean(props.disabled) || Boolean(group?.disabled()),
        'data-testid': (attrs as any)?.['data-testid'],
        onChange: () => group?.update(props.value),
      }),
      slots.default?.(),
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

// B2-03: publish pre-flight checklist dialog. Mirrors the real component's v-model visibility gate
// (only rendered while `modelValue` is true) so tests can assert the dialog opens/closes.
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
  app.component('ElRadioGroup', ElRadioGroup)
  app.component('ElRadio', ElRadio)
  app.component('ElAlert', ElAlert)
  app.component('ElDialog', ElDialog)
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
let scrollIntoViewSpy: ReturnType<typeof vi.fn>
let scrolledElements: HTMLElement[] = []
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')

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

// P1-A0 — typed basic-info issue model (master §4 UI-0; Lock-0 L0-3 typed-issue-record delta,
// basic-info-step scope only). `validateTemplateBasicInfo` is a NEW typed extraction of the SAME
// five checks `validateTemplateFormFields` has always run first; these pin (a) the typed shape and
// derivable count, and (b) that the extraction did not change the combined string-validator output
// — order, text, and set all byte-identical to before this slice.
describe('validateTemplateBasicInfo (P1-A0 typed issue model)', () => {
  it('positive control: a fully valid basic-info draft yields zero typed issues', () => {
    const draft = createEmptyTemplateDraft()
    draft.key = 'travel'
    draft.name = '出差审批'

    const issues = validateTemplateBasicInfo(draft, null)

    expect(issues).toEqual([])
  })

  it('returns one typed {code, message, severity, target} issue per missing required field, in the SAME order as the string validator', () => {
    const draft = createEmptyTemplateDraft()
    // key/name left blank on purpose; visibilityType defaults to 'all' (no id requirement);
    // slaHoursText defaults to '' (unset, not invalid) — only key/name should fire here.

    const issues = validateTemplateBasicInfo(draft, null)

    expect(issues).toEqual([
      { code: 'key', message: '模板 Key 必填', severity: 'error', target: { kind: 'field', key: 'key' } },
      { code: 'name', message: '模板名称必填', severity: 'error', target: { kind: 'field', key: 'name' } },
    ])
  })

  // Documentation pin, not a discriminating mutation guard: `severity` is a declared-but-currently-
  // single-valued field (see the `AuthoringValidationSeverity` doc comment in templateAuthoring.ts)
  // — every existing basic-info rule is a hard "must fix", so this can only ever observe 'error'
  // today. It exists so a future PR that adds a real 'warning' rule updates this assertion
  // deliberately instead of silently drifting past it; it does NOT prove a severity taxonomy is
  // exercised yet, and a hardcoded `severity: 'error'` in the implementation would still pass it.
  it('every basic-info issue is severity "error" today (declared-but-single-valued field; see comment)', () => {
    const draft = createEmptyTemplateDraft()
    draft.slaHoursText = 'abc'

    const issues = validateTemplateBasicInfo(draft, 'unsupported-x')

    expect(issues.length).toBeGreaterThan(0)
    expect(issues.every((issue) => issue.severity === 'error')).toBe(true)
  })

  it('attributes unsupportedReason to the basic-info section (mirrors the existing firstInvalidAuthoringSection routing, not a new classification)', () => {
    const draft = createEmptyTemplateDraft()
    draft.key = 'travel'
    draft.name = '出差审批'

    const issues = validateTemplateBasicInfo(draft, '该模板包含当前 MVP 不支持编辑的结构')

    expect(issues).toEqual([{
      code: 'unsupported',
      message: '该模板包含当前 MVP 不支持编辑的结构',
      severity: 'error',
      target: { kind: 'section', key: 'basic' },
    }])
  })

  it('typed issue count derivation: N basic-info problems → N-length array, for 0/1/several — never a hand-maintained number', () => {
    const zero = createEmptyTemplateDraft()
    zero.key = 'travel'
    zero.name = '出差审批'
    expect(validateTemplateBasicInfo(zero, null)).toHaveLength(0)

    const one = createEmptyTemplateDraft()
    one.key = 'travel'
    one.name = '出差审批'
    one.slaHoursText = 'abc'
    expect(validateTemplateBasicInfo(one, null)).toHaveLength(1)

    const several = createEmptyTemplateDraft()
    several.slaHoursText = 'abc'
    several.visibilityType = 'dept'
    // key/name left blank + bad SLA + unresolved visibility scope = 4 issues.
    expect(validateTemplateBasicInfo(several, null)).toHaveLength(4)
  })

  it('does NOT change the combined string-validator output: same messages, same order, for a multi-failure draft (regression pin for the extraction)', () => {
    const draft = createEmptyTemplateDraft()
    draft.visibilityType = 'dept'
    draft.slaHoursText = 'abc'
    // key/name left blank.
    draft.fields = [] // avoid unrelated form-field errors interleaving with the basic-info block

    const errors = validateTemplateFormFields(draft, '结构不受支持', null)

    expect(errors).toEqual([
      '结构不受支持',
      '模板 Key 必填',
      '模板名称必填',
      '非全员可见范围至少需要一个 id',
      'SLA 必须是正整数小时或留空',
    ])
  })

  it('does NOT change the combined string-validator output when a REAL field error interleaves with basic-info issues (the extraction boundary the fields=[] fixture above cannot exercise)', () => {
    const draft = createEmptyTemplateDraft()
    draft.name = '出差审批' // key still blank; name filled — asserts partial basic-info failure too
    draft.fields[0].label = '' // triggers a genuine per-field error from the untouched downstream loop

    const errors = validateTemplateFormFields(draft, null, null)

    // Basic-info issues (from validateTemplateBasicInfo) must still precede the field-loop error,
    // in the same relative order as before this extraction — this is the boundary a reordering bug
    // in the split would live at, which the all-blank/fields=[] fixture above cannot see.
    expect(errors).toEqual([
      '模板 Key 必填',
      '第 1 个字段的名称必填',
    ])
  })
})

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

  it('authors + round-trips fieldPermissions on a linear node (T1-4 — no longer fail-closed)', () => {
    // T1-4: the linear editor now AUTHORS node-level field permissions, so a linear approval node
    // carrying `fieldPermissions` is supported (not read-only) and its hidden/readonly config
    // round-trips through hydrate→build unchanged (never flattened).
    const template = buildTemplate({
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
    })

    expect(unsupportedTemplateAuthoringReason(template)).toBeNull()
    const rebuilt = buildApprovalGraph(draftFromTemplate(template))
    const node = rebuilt.nodes.find((candidate) => candidate.key === 'approval_1')!
    expect((node.config as ApprovalNodeConfig).fieldPermissions).toEqual([{ fieldId: 'amount', access: 'hidden' }])
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

  it('keeps raw field and node identifiers out of author-facing refusal and validation messages', () => {
    const fieldReason = unsupportedTemplateAuthoringReason(buildTemplate({
      formSchema: { fields: [{ id: 'secret_field_identifier', type: 'signature' as any, label: '' }] },
    }))
    expect(fieldReason).toContain('未命名字段')
    expect(fieldReason).not.toContain('secret_field_identifier')

    const nodeReason = unsupportedTemplateAuthoringReason(buildTemplate({
      approvalGraph: {
        nodes: [
          { key: 'secret_node_identifier', type: 'unsupported' as any, name: '', config: {} },
        ],
        edges: [],
      },
    }))
    expect(nodeReason).toContain('未命名节点')
    expect(nodeReason).not.toContain('secret_node_identifier')

    const draft = createEmptyTemplateDraft()
    draft.key = 'identifier-hygiene'
    draft.name = '标识卫生'
    draft.fields[0].id = 'secret_validation_identifier'
    draft.fields[0].label = ''
    const validationText = validateTemplateDraft(draft).join(' ')
    expect(validationText).toContain('第 1 个字段的名称必填')
    expect(validationText).not.toContain('secret_validation_identifier')
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

  // P1-A0 publish-payload-shape pin — basic-info fields never travel through `publishTemplate`
  // (which sends only `{ policy }`, see `approval-template-authoring-policy-carrier.test.ts`); they
  // serialize through `buildCreateTemplatePayload`/`buildUpdateTemplatePayload` (identical function,
  // `templateAuthoring.ts`) at save time. This slice touches no basic-info persistence code — this
  // pin exists to prove that stays true. A mutation renaming/dropping/reshaping a basic-info payload
  // key reds either assertion below. NOTE for future authors: the `Object.keys(...).sort()`
  // assertion is a full shape pin, so it also reds on a legitimate ADDITIVE key from an unrelated
  // later slice (e.g. a new top-level payload field) — that is expected; update the expected key
  // list rather than assume this test caught a regression.
  it('P1-A0: pins the exact basic-info shape of the create/update payload (no key renamed, dropped, or reshaped)', () => {
    const draft = createEmptyTemplateDraft()
    draft.key = 'travel'
    draft.name = '出差审批'
    draft.category = '差旅'
    draft.description = '跨部门出差需要审批'
    draft.slaHoursText = '24'
    draft.visibilityType = 'dept'
    draft.visibilityIdsText = 'dept_a, dept_b'

    const payload = buildCreateTemplatePayload(draft)

    expect(Object.keys(payload).sort()).toEqual([
      'approvalGraph',
      'category',
      'description',
      'formSchema',
      'key',
      'name',
      'slaHours',
      'visibilityScope',
    ])
    expect({
      key: payload.key,
      name: payload.name,
      category: payload.category,
      description: payload.description,
      slaHours: payload.slaHours,
      visibilityScope: payload.visibilityScope,
    }).toEqual({
      key: 'travel',
      name: '出差审批',
      category: '差旅',
      description: '跨部门出差需要审批',
      slaHours: 24,
      visibilityScope: { type: 'dept', ids: ['dept_a', 'dept_b'] },
    })
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

  it('Lock-1 §K4: round-trips a continuous_dept_heads source incl. levels (save emits {kind, levels}; levels survives the real wire) — the linear editor accepted-kind list mirror site', () => {
    const draft = createEmptyTemplateDraft()
    draft.key = 'dh'
    draft.name = '连续多级部门负责人审批'
    draft.steps[0].sourceKind = 'continuous_dept_heads'
    draft.steps[0].levels = 2

    const payload = buildCreateTemplatePayload(draft)
    expect((payload.approvalGraph.nodes[1]?.config as any).assigneeSources).toEqual([{ kind: 'continuous_dept_heads', levels: 2 }])

    // wire-vs-fixture trap: assert `levels` survives the real serialize→parse, not a hand-built chip.
    const rehydrated = draftFromTemplate(buildTemplate({ approvalGraph: payload.approvalGraph }))
    expect(rehydrated.steps[0].sourceKind).toBe('continuous_dept_heads')
    expect(rehydrated.steps[0].levels).toBe(2)
    // And the rebuilt graph is byte-identical to the first emit (no hydrate flatten).
    expect(buildCreateTemplatePayload(rehydrated).approvalGraph.nodes[1]?.config).toEqual(
      payload.approvalGraph.nodes[1]?.config,
    )
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

  it('Lock-1 §K5-b: round-trips a dept_head_at_level source incl. level (save emits {kind, level}; level survives the real wire) — the linear editor accepted-kind list mirror site', () => {
    const draft = createEmptyTemplateDraft()
    draft.key = 'dhal'
    draft.name = '指定层级部门负责人审批'
    draft.steps[0].sourceKind = 'dept_head_at_level'
    draft.steps[0].level = 2

    const payload = buildCreateTemplatePayload(draft)
    expect((payload.approvalGraph.nodes[1]?.config as any).assigneeSources).toEqual([{ kind: 'dept_head_at_level', level: 2 }])

    // wire-vs-fixture trap: assert `level` survives the real serialize→parse, not a hand-built chip.
    const rehydrated = draftFromTemplate(buildTemplate({ approvalGraph: payload.approvalGraph }))
    expect(rehydrated.steps[0].sourceKind).toBe('dept_head_at_level')
    expect(rehydrated.steps[0].level).toBe(2)
    // And the rebuilt graph is byte-identical to the first emit (no hydrate flatten).
    expect(buildCreateTemplatePayload(rehydrated).approvalGraph.nodes[1]?.config).toEqual(
      payload.approvalGraph.nodes[1]?.config,
    )
  })

  it('Lock-1 §K2: round-trips a requester_choice source incl. mode + role scope (idsText is the scope-id carrier)', () => {
    const draft = createEmptyTemplateDraft()
    draft.key = 'rc'
    draft.name = '提交人自选审批'
    draft.steps[0].sourceKind = 'requester_choice'
    draft.steps[0].requesterChoiceMode = 'multi'
    draft.steps[0].requesterChoiceScopeType = 'role'
    draft.steps[0].idsText = 'role_fin, role_legal'

    const payload = buildCreateTemplatePayload(draft)
    expect((payload.approvalGraph.nodes[1]?.config as any).assigneeSources).toEqual([
      { kind: 'requester_choice', mode: 'multi', scope: { type: 'role', roleIds: ['role_fin', 'role_legal'] } },
    ])

    // wire-vs-fixture trap: mode/scope survive the real serialize→parse, not a hand-built chip.
    const rehydrated = draftFromTemplate(buildTemplate({ approvalGraph: payload.approvalGraph }))
    expect(rehydrated.steps[0].sourceKind).toBe('requester_choice')
    expect(rehydrated.steps[0].requesterChoiceMode).toBe('multi')
    expect(rehydrated.steps[0].requesterChoiceScopeType).toBe('role')
    expect(rehydrated.steps[0].idsText).toBe('role_fin, role_legal')
    // And the rebuilt graph is byte-identical to the first emit (no hydrate flatten).
    expect(buildCreateTemplatePayload(rehydrated).approvalGraph.nodes[1]?.config).toEqual(
      payload.approvalGraph.nodes[1]?.config,
    )
  })

  it('Lock-1 §K2: round-trips a members-scope requester_choice (single mode, userIds carrier)', () => {
    const draft = createEmptyTemplateDraft()
    draft.key = 'rc2'
    draft.name = '提交人自选成员'
    draft.steps[0].sourceKind = 'requester_choice'
    draft.steps[0].requesterChoiceMode = 'single'
    draft.steps[0].requesterChoiceScopeType = 'members'
    draft.steps[0].idsText = 'u_alpha'

    const payload = buildCreateTemplatePayload(draft)
    expect((payload.approvalGraph.nodes[1]?.config as any).assigneeSources).toEqual([
      { kind: 'requester_choice', mode: 'single', scope: { type: 'members', userIds: ['u_alpha'] } },
    ])
    const rehydrated = draftFromTemplate(buildTemplate({ approvalGraph: payload.approvalGraph }))
    expect(rehydrated.steps[0].requesterChoiceScopeType).toBe('members')
    expect(rehydrated.steps[0].idsText).toBe('u_alpha')
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
    approvalCanvasV2.value = false
    createTemplateSpy.mockReset()
    updateTemplateSpy.mockReset()
    publishTemplateSpy.mockReset()
    getTemplateSpy.mockReset()
    dryRunApprovalConditionFormulaSpy.mockReset()
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
    dryRunApprovalConditionFormulaSpy.mockResolvedValue({ success: true, result: true })
    scrolledElements = []
    scrollIntoViewSpy = vi.fn(function (this: HTMLElement) {
      scrolledElements.push(this)
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewSpy,
    })
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView)
    } else {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  it('scrolls every section navigation path to the workspace start and exposes the active step', async () => {
    await mountView()

    const content = container!.querySelector('[data-testid="approval-template-workspace-content"]')
    const basic = container!.querySelector('[data-testid="approval-template-section-basic"]')
    const fields = container!.querySelector('[data-testid="approval-template-section-fields"]')
    const review = container!.querySelector('[data-testid="approval-template-section-review"]')
    expect(basic?.getAttribute('aria-current')).toBe('step')

    ;(container!.querySelector('[data-testid="approval-template-section-next"]') as HTMLButtonElement).click()
    await flushUi()
    expect(fields?.getAttribute('aria-current')).toBe('step')
    expect(scrolledElements.at(-1)).toBe(content)

    ;(container!.querySelector('[data-testid="approval-template-section-previous"]') as HTMLButtonElement).click()
    await flushUi()
    expect(basic?.getAttribute('aria-current')).toBe('step')
    expect(scrolledElements.at(-1)).toBe(content)

    ;(review as HTMLButtonElement).click()
    await flushUi()
    expect(review?.getAttribute('aria-current')).toBe('step')
    expect(scrolledElements.at(-1)).toBe(content)
    expect(scrollIntoViewSpy).toHaveBeenLastCalledWith({ behavior: 'smooth', block: 'start' })
  })

  it('reveals and focuses field validation errors when saving from another section', async () => {
    await mountView()

    setInput('approval-template-key', 'travel')
    setInput('approval-template-name', '出差审批')
    ;(container!.querySelector('[data-testid="approval-template-section-fields"]') as HTMLButtonElement).click()
    await flushUi()

    // D1: field-id input is gone; the first field control is 字段名称 — clear it to surface validation.
    const fieldName = container!.querySelector('[data-testid="approval-template-field-row"] input') as HTMLInputElement
    fieldName.value = ''
    fieldName.dispatchEvent(new Event('input'))
    ;(container!.querySelector('[data-testid="approval-template-section-review"]') as HTMLButtonElement).click()
    await flushUi()
    scrollIntoViewSpy.mockClear()
    scrolledElements = []

    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()

    const fieldsStep = container!.querySelector('[data-testid="approval-template-section-fields"]')
    const summary = container!.querySelector('[data-testid="approval-template-validation-summary"]')
    expect(createTemplateSpy).not.toHaveBeenCalled()
    expect(fieldsStep?.getAttribute('aria-current')).toBe('step')
    expect(summary?.textContent).toContain('名称必填')
    expect(document.activeElement).toBe(summary)
    expect(scrolledElements.at(-1)).toBe(summary)
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

  // P1-A0 typed-control test — each basic-info control commits its typed value onto the draft and
  // survives to the save payload. `key`/`name` are already covered by the test above; this covers
  // the remaining controls (category/SLA/description/visibility type+ids), which previously had no
  // stable `data-testid` to target. Positive control: every field's value round-trips unaltered.
  it('P1-A0: every basic-info control commits its typed value through to the save payload (positive control)', async () => {
    await mountView()

    setInput('approval-template-key', 'travel')
    setInput('approval-template-name', '出差审批')
    setInput('approval-template-category', '差旅')
    setInput('approval-template-sla-hours', '24')
    setInput('approval-template-description', '跨部门出差需要审批')
    const visibilityType = container!.querySelector('[data-testid="approval-template-visibility-type"]') as HTMLSelectElement
    visibilityType.value = 'dept'
    visibilityType.dispatchEvent(new Event('change'))
    await flushUi()
    setInput('approval-template-visibility-ids', 'dept_a, dept_b')

    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()

    expect(createTemplateSpy).toHaveBeenCalledTimes(1)
    const payload = createTemplateSpy.mock.calls[0]?.[0] as any
    expect(payload.key).toBe('travel')
    expect(payload.name).toBe('出差审批')
    expect(payload.category).toBe('差旅')
    expect(payload.slaHours).toBe(24)
    expect(payload.description).toBe('跨部门出差需要审批')
    expect(payload.visibilityScope).toEqual({ type: 'dept', ids: ['dept_a', 'dept_b'] })
  })

  // P1-A0 validation-count derivation — the 基础信息 step-nav badge reads `.length` off
  // `validateTemplateBasicInfo(draft, unsupportedReason)` (`TemplateAuthoringView.vue`
  // `basicInfoIssueCount`). This exercises the LIVE component derivation (not the pure helper in
  // isolation — a helper-only test would pass even if the view's binding were broken/hardcoded), at
  // three states: 2 known issues, 0 issues, 1 different known issue. A mutation that hardcodes the
  // badge number or drops `.length` fails at least one of these three assertions.
  it('P1-A0: the 基础信息 step-nav issue count is DERIVED from typed issues, not hand-counted', async () => {
    await mountView()

    // State 1: brand-new draft — key + name both empty → exactly 2 typed issues.
    let badge = container!.querySelector('[data-testid="approval-template-section-basic-issue-count"]')
    expect(badge?.textContent?.trim()).toBe('2 项不完善')
    // The count also folds into the step button's aria-label (it OVERRIDES inner text for
    // assistive tech, so a visual-only badge would be silently unannounced — see P1-A0 view diff).
    const basicStepButton = container!.querySelector('[data-testid="approval-template-section-basic"]')
    expect(basicStepButton?.getAttribute('aria-label')).toContain('2 项不完善')

    // State 2: fill both required fields → count derives to 0, badge disappears entirely (not "0
    // 项不完善" theater — matches the D0/M7 "no inert/empty control" grammar for a zero state).
    setInput('approval-template-key', 'travel')
    setInput('approval-template-name', '出差审批')
    await flushUi()
    badge = container!.querySelector('[data-testid="approval-template-section-basic-issue-count"]')
    expect(badge).toBeNull()
    expect(basicStepButton?.getAttribute('aria-label')).not.toContain('项不完善')

    // State 3: introduce exactly ONE different issue (bad SLA text) → count derives to 1, proving
    // the badge tracks the CURRENT typed array rather than being stuck at its first-seen value.
    setInput('approval-template-sla-hours', 'abc')
    await flushUi()
    badge = container!.querySelector('[data-testid="approval-template-section-basic-issue-count"]')
    expect(badge?.textContent?.trim()).toBe('1 项不完善')
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
  // coexist editable on one template; the same shape carrying B fieldPermissions is now ALSO
  // editable (T1-4 ships the node field-permissions editor) and renders the per-field access selector.
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

  it('combined view A2: the same template carrying fieldPermissions is editable (T1-4) — no unsupported alert, save enabled, per-field access selector renders the hidden value', async () => {
    routeParams = { id: 'tpl_combo_fp' }
    getTemplateSpy.mockResolvedValue(buildTemplate({
      approvalGraph: buildComboGraph({ assigneeSources: [{ kind: 'static_user', userIds: ['u1'] }], approvalMode: 'single', emptyAssigneePolicy: 'error', autoApprovalPolicy: { mergeWithRequester: true }, fieldPermissions: [{ fieldId: 'amount', access: 'hidden' }] }),
    }))
    await mountView()
    await flushUi()

    expect(container!.querySelector('[data-testid="approval-template-unsupported-alert"]')).toBeNull() // B now editable, not fail-closed
    expect((container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).disabled).toBe(false) // save enabled
    expect(container!.querySelector('[data-testid="approval-step-field-permissions"]')).not.toBeNull() // the per-field access editor renders
    const amountAccess = container!.querySelector('[data-testid="approval-step-field-access-amount"]') as HTMLSelectElement
    expect(amountAccess).not.toBeNull()
    expect(amountAccess.value).toBe('hidden') // hydrated from the stored fieldPermission
  })

  it('T1-4 write wire (Lock-7 G-13): selecting readonly through the SFC control writes {fieldId,access:readonly} to the save payload; the retired readonly hint never renders', async () => {
    // The default template is LINEAR (fields amount + reviewer) so the field-permissions editor is
    // live. This drives the @update:model-value → onStepFieldAccessChange → setStepFieldPermission →
    // save-payload wire that a pure-helper test can't see (wire-vs-fixture discipline).
    routeParams = { id: 'tpl_t14_write' }
    getTemplateSpy.mockResolvedValue(buildTemplate())
    await mountView()
    await flushUi()

    expect(container!.querySelector('[data-testid="approval-step-field-readonly-hint"]')).toBeNull() // retired (G-13)

    const amountAccess = container!.querySelector('[data-testid="approval-step-field-access-amount"]') as HTMLSelectElement
    expect(amountAccess).not.toBeNull()
    amountAccess.value = 'readonly'
    amountAccess.dispatchEvent(new Event('change'))
    await flushUi()

    // Lock-7 G-13: readonly is now enforced server-side, so the "not-yet-enforced" hint is retired —
    // selecting readonly renders NO hint (still persists to the payload below, so the control is live).
    expect(container!.querySelector('[data-testid="approval-step-field-readonly-hint"]')).toBeNull()

    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()

    expect(updateTemplateSpy).toHaveBeenCalledTimes(1)
    const payload = updateTemplateSpy.mock.calls[0]?.[1] as any
    const node = payload.approvalGraph.nodes.find((candidate: any) => candidate.key === 'approval_1')
    expect(node.config.fieldPermissions).toEqual([{ fieldId: 'amount', access: 'readonly' }]) // WRITTEN via the control
  })

  it('T1-4 routing hint: hiding a form_field_user routing-driver field renders the routing hint and does NOT block save (non-blocking)', async () => {
    // The default template's approval step resolves its approver from the `reviewer` form field
    // (form_field_user), so `reviewer` is a routing driver.
    routeParams = { id: 'tpl_t14_routing' }
    getTemplateSpy.mockResolvedValue(buildTemplate())
    await mountView()
    await flushUi()

    expect(container!.querySelector('[data-testid="approval-step-field-routing-hint"]')).toBeNull() // reviewer editable → no hint

    const reviewerAccess = container!.querySelector('[data-testid="approval-step-field-access-reviewer"]') as HTMLSelectElement
    expect(reviewerAccess).not.toBeNull()
    reviewerAccess.value = 'hidden'
    reviewerAccess.dispatchEvent(new Event('change'))
    await flushUi()

    expect(container!.querySelector('[data-testid="approval-step-field-routing-hint"]')).not.toBeNull() // driver hidden → hint
    expect((container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).disabled).toBe(false) // non-blocking
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
    const currentKindRadio = container!.querySelector(
      '[data-testid="approval-node-source-kind-direct_manager"]',
    ) as HTMLInputElement
    expect(currentKindRadio).not.toBeNull()
    expect(currentKindRadio.checked).toBe(true)

    // change the source kind through the REAL control (direct_manager → dept_head — both valid
    // no-ID kinds; a static_* target would need IDs the multi-select stub can't drive, and that ID
    // logic is helper-covered. Note: switching to an EMPTY static_role correctly BLOCKS save via the
    // validation preview — proving validation is wired too), then save.
    ;(container!.querySelector('[data-testid="approval-node-source-kind-dept_head"]') as HTMLInputElement).click()
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

  // P1-B — master §P1-B / approval-parity-master-design-lock-20260817.md: multi-source assignee
  // cards, full SFC mount (not the direct-component stub harness). Proves the REAL production
  // TemplateAuthoringView wiring — the ＋添加审批人 button through to draft.approvalNodeEdits
  // through to the save payload — for the exact scenario the task names: add a 2nd source card →
  // model has 2 sources → publish payload has 2; remove one → back to 1. The FE-only claim (engine
  // unchanged) is proven by ApprovalAssigneeResolver.ts's unmodified `sources.forEach` + dedup
  // (verified by source read, not re-tested here — this file only covers the FE authoring surface).
  it('P1-B: add a 2nd source card via the REAL "＋添加审批人" control → save payload carries 2 sources; remove one → save payload carries 1 (both survive the SAME node, edges/cc byte-identical)', async () => {
    routeParams = { id: 'tpl_p1b_multicard' }
    const graph = buildG5ComplexGraph({ assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error' })
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: graph }))
    await mountView()
    await flushUi()

    // starts with exactly 1 card; add appends a 2nd.
    expect(container!.querySelectorAll('[data-testid="approval-node-source-card"]')).toHaveLength(1)
    ;(container!.querySelector('[data-testid="approval-node-source-add"]') as HTMLButtonElement).click()
    await flushUi()
    let cards = container!.querySelectorAll('[data-testid="approval-node-source-card"]')
    expect(cards).toHaveLength(2)
    // card 0 stays direct_manager (untouched by the add); configure card 1 to a distinguishable
    // kind (dept_head) so a later removal can prove WHICH card survived, not just the count.
    expect((cards[0].querySelector('[data-testid="approval-node-source-kind-direct_manager"]') as HTMLInputElement).checked).toBe(true)
    ;(cards[1].querySelector('[data-testid="approval-node-source-kind-dept_head"]') as HTMLInputElement).click()
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()
    expect(updateTemplateSpy).toHaveBeenCalledTimes(1)
    let approval1 = (updateTemplateSpy.mock.calls[0]?.[1] as any).approvalGraph.nodes.find((n: any) => n.key === 'approval_1')
    expect(approval1.config.assigneeSources).toEqual([{ kind: 'direct_manager' }, { kind: 'dept_head' }]) // BOTH sources serialize
    expect(approval1.config.approvalMode).toBe('single') // node-level fields untouched by the card add/edit
    expect(approval1.config.emptyAssigneePolicy).toBe('error')

    // remove card 0 (direct_manager) — the SURVIVOR is dept_head, not a stale re-render.
    cards = container!.querySelectorAll('[data-testid="approval-node-source-card"]')
    ;(cards[0].querySelector('[data-testid="approval-node-source-remove"]') as HTMLButtonElement).click()
    await flushUi()
    cards = container!.querySelectorAll('[data-testid="approval-node-source-card"]')
    expect(cards).toHaveLength(1)
    expect((cards[0].querySelector('[data-testid="approval-node-source-kind-dept_head"]') as HTMLInputElement).checked).toBe(true)
    // remove is disabled again at exactly 1 card — the "keep ≥1" invariant's UX signal.
    expect((cards[0].querySelector('[data-testid="approval-node-source-remove"]') as HTMLButtonElement).disabled).toBe(true)

    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()
    expect(updateTemplateSpy).toHaveBeenCalledTimes(2)
    approval1 = (updateTemplateSpy.mock.calls[1]?.[1] as any).approvalGraph.nodes.find((n: any) => n.key === 'approval_1')
    expect(approval1.config.assigneeSources).toEqual([{ kind: 'dept_head' }]) // exactly the survivor
    // topology + the untouched cc node stay byte-identical across both saves.
    expect((updateTemplateSpy.mock.calls[1]?.[1] as any).approvalGraph.edges).toEqual(graph.edges)
    expect((updateTemplateSpy.mock.calls[1]?.[1] as any).approvalGraph.nodes.find((n: any) => n.key === 'cc_1').config)
      .toEqual({ targetType: 'role', targetIds: ['finance'] })
  })

  // P1-B regression: the new-card default kind must be VALID with zero further configuration.
  // The registry roster's raw first entry for `approval` is `static_user`, whose zero-config shape
  // (`{ kind: 'static_user', userIds: [] }`) FAILS `isAssigneeSourceValid`/`validateApprovalNodeEdits`
  // (empty `userIds`) — defaulting to it would mean clicking "＋添加审批人" on a perfectly valid
  // template, without touching the new card at all, immediately creates an unconfigured/invalid
  // source. This proves the default is `requester` (valid unconditionally) by driving the FULL save
  // path with the new card COMPLETELY untouched — not just inspecting the model.
  it('P1-B: clicking "＋添加审批人" alone (no further configuration) keeps the template save-able — the new card defaults to a VALID zero-config kind, not the roster\'s raw first entry', async () => {
    routeParams = { id: 'tpl_p1b_add_default_valid' }
    const graph = buildG5ComplexGraph({ assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error' })
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: graph }))
    await mountView()
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-node-source-add"]') as HTMLButtonElement).click()
    await flushUi()
    // save button itself is not gated on assignee validity (that gate is the publish checklist), but
    // the SAVE must actually go through cleanly with the new card AS-IS — that's the real proof.
    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()

    expect(updateTemplateSpy).toHaveBeenCalledTimes(1)
    const approval1 = (updateTemplateSpy.mock.calls[0]?.[1] as any).approvalGraph.nodes.find((n: any) => n.key === 'approval_1')
    expect(approval1.config.assigneeSources).toEqual([{ kind: 'direct_manager' }, { kind: 'requester' }])
    // and the PUBLISH checklist's flow item stays green too — a `requester` source is unconditionally
    // valid, unlike the roster's raw first entry would have been.
    expect(container!.querySelector('[data-testid="approval-node-source-kind-unknown"]')).toBeNull()
  })

  // G-B2-18 + D1: complex-graph static_user/static_role uses typed directory pickers only
  // (manual-ID ordinary path removed). cc forces the preserved-graph (complex) path.
  describe('G-B2-18: complex-node assignee picker', () => {
    it('renders the user picker (not the role picker) for static_user; no ordinary manual-ID control', async () => {
      routeParams = { id: 'tpl_g5_static_user' }
      getTemplateSpy.mockResolvedValue(buildTemplate({
        approvalGraph: buildG5ComplexGraph({ assigneeSources: [{ kind: 'static_user', userIds: ['legacy-user-1'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' }),
      }))
      await mountView()
      await flushUi()

      expect(container!.querySelector('[data-testid="approval-node-source-user-picker"]')).not.toBeNull()
      expect(container!.querySelector('[data-testid="approval-node-source-role-picker"]')).toBeNull()
      expect(container!.querySelector('[data-testid="approval-node-source-ids-text"]')).toBeNull()
      expect(container!.querySelector('[data-testid="approval-step-ids-text"]')).toBeNull()
      // Stored legacy id still round-trips on an untouched save (picker preserves selection).
      ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
      await flushUi()
      const payload = updateTemplateSpy.mock.calls[0]?.[1] as any
      const approval1 = payload.approvalGraph.nodes.find((n: any) => n.key === 'approval_1')
      expect(approval1.config.assigneeSources).toEqual([{ kind: 'static_user', userIds: ['legacy-user-1'] }])
    })

    it('renders the role picker for static_role; no ordinary manual-ID control', async () => {
      routeParams = { id: 'tpl_g5_static_role' }
      getTemplateSpy.mockResolvedValue(buildTemplate({
        approvalGraph: buildG5ComplexGraph({ assigneeSources: [{ kind: 'static_role', roleIds: ['mgr'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' }),
      }))
      await mountView()
      await flushUi()

      expect(container!.querySelector('[data-testid="approval-node-source-role-picker"]')).not.toBeNull()
      expect(container!.querySelector('[data-testid="approval-node-source-user-picker"]')).toBeNull()
      expect(container!.querySelector('[data-testid="approval-node-source-ids-text"]')).toBeNull()
      ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
      await flushUi()
      const payload = updateTemplateSpy.mock.calls[0]?.[1] as any
      const approval1 = payload.approvalGraph.nodes.find((n: any) => n.key === 'approval_1')
      expect(approval1.config.assigneeSources).toEqual([{ kind: 'static_role', roleIds: ['mgr'] }])
    })

    it('multi-id static_user selection preserved through save without a manual-ID control', async () => {
      routeParams = { id: 'tpl_g5_multi_user' }
      getTemplateSpy.mockResolvedValue(buildTemplate({
        approvalGraph: buildG5ComplexGraph({ assigneeSources: [{ kind: 'static_user', userIds: ['u1', 'u2'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' }),
      }))
      await mountView()
      await flushUi()

      expect(container!.querySelector('[data-testid="approval-node-source-user-picker"]')).not.toBeNull()
      expect(container!.querySelector('[data-testid="approval-node-source-ids-text"]')).toBeNull()
      ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
      await flushUi()
      const payload = updateTemplateSpy.mock.calls[0]?.[1] as any
      const approval1 = payload.approvalGraph.nodes.find((n: any) => n.key === 'approval_1')
      expect(approval1.config.assigneeSources).toEqual([{ kind: 'static_user', userIds: ['u1', 'u2'] }])
    })

    it('switching source kind swaps typed pickers (no manual-ID surface)', async () => {
      routeParams = { id: 'tpl_g5_kind_switch' }
      getTemplateSpy.mockResolvedValue(buildTemplate({
        approvalGraph: buildG5ComplexGraph({ assigneeSources: [{ kind: 'static_role', roleIds: ['mgr'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' }),
      }))
      await mountView()
      await flushUi()
      expect(container!.querySelector('[data-testid="approval-node-source-role-picker"]')).not.toBeNull()
      expect(container!.querySelector('[data-testid="approval-node-source-ids-text"]')).toBeNull()

      ;(container!.querySelector('[data-testid="approval-node-source-kind-static_user"]') as HTMLInputElement).click()
      await flushUi()

      expect(container!.querySelector('[data-testid="approval-node-source-user-picker"]')).not.toBeNull()
      expect(container!.querySelector('[data-testid="approval-node-source-role-picker"]')).toBeNull()
      expect(container!.querySelector('[data-testid="approval-node-source-ids-text"]')).toBeNull()
    })
  })

  // #3161 §1 — FE authoring preserve. The editor does not author amountConsistencyCheck, so the
  // load→rebuild it runs on every save must carry it through verbatim or a preset-shipped control
  // (#3183) is silently dropped on the first authoring-page save.
  const amtFields = [
    { id: 'amount', type: 'number', label: '总额', required: true },
    { id: 'expense_items', type: 'detail', label: '明细', required: false, columns: [{ id: 'amount', type: 'number', label: '金额', required: true }] },
  ]
  const amtMapping = { totalFieldId: 'amount', detailFieldId: 'expense_items', amountColumnId: 'amount' }
  // A graph consistent with amtFields (direct_manager — references no form field), so the mounted
  // template is valid + editable + saveable (the default buildTemplate graph references a `reviewer`
  // field amtFields omits).
  const amtGraph = {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      { key: 'approval_1', type: 'approval', name: '审批', config: { assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
      { key: 'edge-approval_1-end', source: 'approval_1', target: 'end' },
    ],
  }

  it('§1 round-trip (unit): draftFromTemplate→buildFormSchema preserves amountConsistencyCheck; absent stays absent', () => {
    const mapped = buildTemplate({ formSchema: { fields: amtFields, amountConsistencyCheck: amtMapping } as any })
    expect(buildFormSchema(draftFromTemplate(mapped)).amountConsistencyCheck).toEqual(amtMapping)
    const plain = buildTemplate({ formSchema: { fields: amtFields } as any })
    expect(buildFormSchema(draftFromTemplate(plain)).amountConsistencyCheck).toBeUndefined()
  })

  it('§1 active-exposure guard (mounted): opening a mapped (preset-shipped) template and saving keeps amountConsistencyCheck in the payload', async () => {
    routeParams = { id: 'tpl_amt' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ formSchema: { fields: amtFields, amountConsistencyCheck: amtMapping } as any, approvalGraph: amtGraph as any }))
    await mountView()
    await flushUi()
    // No edits — just the load→save an admin does. Before the fix, buildFormSchema dropped the mapping.
    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()
    expect(updateTemplateSpy).toHaveBeenCalledTimes(1)
    const payload = updateTemplateSpy.mock.calls[0]?.[1] as any
    expect(payload.formSchema.amountConsistencyCheck).toEqual(amtMapping)
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

  it('D-3 topology: clicking "add condition branch" grows the condition graph and saves the new structure', async () => {
    routeParams = { id: 'tpl_topo' }
    getTemplateSpy.mockResolvedValue(buildTemplate({
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: '发起', config: {} },
          { key: 'cond_1', type: 'condition', name: '判断', config: { branches: [{ edgeKey: 'e-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }] }], defaultEdgeKey: 'e-low' } },
          { key: 'app_high', type: 'approval', name: '高', config: { assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
          { key: 'end', type: 'end', name: '结束', config: {} },
        ],
        edges: [
          { key: 'e-start-c', source: 'start', target: 'cond_1' },
          { key: 'e-high', source: 'cond_1', target: 'app_high' },
          { key: 'e-low', source: 'cond_1', target: 'end' },
          { key: 'e-high-end', source: 'app_high', target: 'end' },
        ],
      },
    }))
    await mountView()
    await flushUi()
    const rowsBefore = container!.querySelectorAll('[data-testid="approval-graph-node-row"]').length
    ;(container!.querySelector('[data-testid="approval-topology-add-condition-branch-cond_1"]') as HTMLButtonElement).click()
    await flushUi()
    expect(container!.querySelectorAll('[data-testid="approval-graph-node-row"]').length).toBe(rowsBefore + 1) // a new approval node appeared

    // P1 fix (review #4433 F1): the added branch seeds an INCOMPLETE starter rule — saving as-is
    // is BLOCKED (an empty/unconfigured branch must never publish and capture all traffic).
    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()
    expect(updateTemplateSpy).not.toHaveBeenCalled()

    // Configure the new branch's rule field, then save persists the new structure.
    const ruleFields = container!.querySelectorAll('[data-testid="approval-condition-rule-field"]')
    const newRuleField = ruleFields[ruleFields.length - 1] as HTMLSelectElement
    newRuleField.value = 'amount'
    newRuleField.dispatchEvent(new Event('change'))
    await flushUi()
    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()
    const payload = updateTemplateSpy.mock.calls[0]?.[1] as any
    const branches = payload.approvalGraph.nodes.find((n: any) => n.key === 'cond_1').config.branches
    expect(branches).toHaveLength(2) // the added branch is saved
    expect(branches[1].rules[0].fieldId).toBe('amount') // …with its configured rule, never rules: []
  })

  // P1-D (docs/development/approval-parity-master-design-lock-20260817.md §4 P1-D; D0 §4.1):
  // condition branch cards get a "优先级 N" priority chip (branch ARRAY ORDER — never the edge key),
  // and the default (fall-through) branch gets an explanatory copy card. No branch delete/duplicate
  // affordance is mounted in this slice (out of scope per master §P1-D; a future slice may add
  // delete with its own authorization — see docs/development ledger P1-D row).
  function buildThreeBranchConditionGraph() {
    return {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        {
          key: 'cond_1',
          type: 'condition',
          name: '判断',
          config: {
            branches: [
              { edgeKey: 'e-a', rules: [{ fieldId: 'amount', operator: 'gte', value: 3000 }] },
              { edgeKey: 'e-b', rules: [{ fieldId: 'reviewer', operator: 'isEmpty' }] },
              { edgeKey: 'e-c', rules: [{ fieldId: 'amount', operator: 'lt', value: 100 }] },
            ],
            defaultEdgeKey: 'e-low',
          },
        },
        { key: 'app_a', type: 'approval', name: 'A', config: { assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'app_b', type: 'approval', name: 'B', config: { assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'app_c', type: 'approval', name: 'C', config: { assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'e-start-c', source: 'start', target: 'cond_1' },
        { key: 'e-a', source: 'cond_1', target: 'app_a' },
        { key: 'e-b', source: 'cond_1', target: 'app_b' },
        { key: 'e-c', source: 'cond_1', target: 'app_c' },
        { key: 'e-low', source: 'cond_1', target: 'end' },
        { key: 'e-a-end', source: 'app_a', target: 'end' },
        { key: 'e-b-end', source: 'app_b', target: 'end' },
        { key: 'e-c-end', source: 'app_c', target: 'end' },
      ],
    }
  }

  it('P1-D: condition branch cards show 优先级 N chips matching configured branch order (3-branch fixture)', async () => {
    routeParams = { id: 'tpl_priority' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildThreeBranchConditionGraph() }))
    await mountView()
    await flushUi()

    const branchCards = Array.from(container!.querySelectorAll('[data-testid="approval-condition-branch"]'))
    expect(branchCards).toHaveLength(3)
    const chipTexts = branchCards.map(
      (card) => card.querySelector('[data-testid="approval-condition-branch-priority"]')?.textContent?.trim(),
    )
    expect(chipTexts).toEqual(['优先级 1 最高', '优先级 2', '优先级 3']) // reversing the fixture's branch order must flip this

    // Ties chip 2 to ITS OWN branch — branch 2 is the only one whose rule field is 'reviewer', so
    // this fails if the chip renders against the wrong card (not just "the string set exists").
    const branch2FieldSelect = branchCards[1].querySelector('[data-testid="approval-condition-rule-field"]') as HTMLSelectElement
    expect(branch2FieldSelect.value).toBe('reviewer')
    expect(branchCards[1].textContent).toContain('优先级 2')

    // Branches 1 and 3 BOTH use fieldId 'amount' (only their operator/value differ) — a naive
    // "chip text is index+1" implementation would still look right after swapping cards 1↔3 (a
    // 3-element reversal leaves the middle element in place), so the operator is the assertion that
    // actually catches a reversed branch order.
    const branch1Operator = (branchCards[0].querySelector('[data-testid="approval-condition-rule-operator"]') as HTMLSelectElement).value
    const branch3Operator = (branchCards[2].querySelector('[data-testid="approval-condition-rule-operator"]') as HTMLSelectElement).value
    expect(branch1Operator).toBe('gte')
    expect(branch3Operator).toBe('lt')
  })

  // P1-1 (adversarial gate, 20260817): the branch-delete affordance previously mounted here
  // (`removeConditionBranch` / `canRemoveConditionBranch`) is OUT OF SCOPE for §P1-D — no lock
  // row authorizes deleting a topology node from a copy-and-priority slice. It has been dropped
  // entirely (template button, view-layer handlers, `ApprovalNodeConfigEditorApi` members); the
  // command layer itself (`graphTopologyEdit.ts`) is untouched and stays covered by its own suite.
  // There is therefore no delete-affordance test here anymore — asserting its absence would be a
  // vacuous "this component doesn't render a button it never imports" check.

  // P1-2 (adversarial gate, M8 honesty): the default-card copy must never assert a default flow
  // that doesn't exist. `conditionEdit.ts` maps an absent `config.defaultEdgeKey` to `''`, and
  // `ApprovalGraphExecutor.resolveConditionTarget` falls through to the FIRST outgoing edge when
  // no default is designated — never an undefined "default flow". Positive control: a real
  // `defaultEdgeKey` renders the default-flow copy.
  // Same predicate also gates the condition-inspector header hint (advisor-caught follow-on: the
  // header's verbatim "...全部不满足时走默认分支。" is the SAME false claim when no default is
  // configured, so it must be gated identically — visibility, not the verbatim string, is gated).
  it('P1-D/P1-2: default branch card AND header hint render the default-flow claim when defaultEdgeKey is set (positive control)', async () => {
    routeParams = { id: 'tpl_default_copy' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildThreeBranchConditionGraph() }))
    await mountView()
    await flushUi()

    const defaultCard = container!.querySelector('[data-testid="approval-condition-default-branch"]') as HTMLElement
    expect(defaultCard).not.toBeNull()
    const copy = defaultCard.querySelector('[data-testid="approval-condition-default-copy"]')
    expect(copy?.textContent?.trim()).toBe('未满足其他条件时进入默认流程')
    expect(defaultCard.querySelector('[data-testid="approval-condition-default-copy-empty"]')).toBeNull()

    const hints = container!.querySelectorAll('[data-testid="approval-condition-order-hint"]')
    expect(hints).toHaveLength(1) // "lives once" — D0 §4.1
    expect(hints[0].textContent?.trim()).toBe('分支按优先级从上到下依次判断，全部不满足时走默认分支。')
  })

  // Negative test: no `defaultEdgeKey` configured must NOT claim a default flow exists ANYWHERE in
  // this panel — neither the default card nor the header hint — it must render the honest
  // empty-state line instead, matching real executor routing (first outgoing edge, i.e. 优先级 1's
  // branch, not an undefined "default").
  it('P1-D/P1-2: default branch card renders the honest empty-state line AND the header hint is absent when no defaultEdgeKey is set (negative test)', async () => {
    routeParams = { id: 'tpl_no_default' }
    const graph = buildThreeBranchConditionGraph()
    const cond = graph.nodes.find((n: any) => n.key === 'cond_1') as any
    delete cond.config.defaultEdgeKey
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: graph }))
    await mountView()
    await flushUi()

    const defaultCard = container!.querySelector('[data-testid="approval-condition-default-branch"]') as HTMLElement
    expect(defaultCard).not.toBeNull()
    expect(defaultCard.querySelector('[data-testid="approval-condition-default-copy"]')).toBeNull() // NOT the default-flow claim
    const emptyCopy = defaultCard.querySelector('[data-testid="approval-condition-default-copy-empty"]')
    expect(emptyCopy?.textContent?.trim()).toBe(
      '未指定默认分支：所有条件都不满足时，流程走向不确定，请指定默认分支。',
    )
    // The header hint asserts the SAME "...走默认分支" fact — must not render it either.
    expect(container!.querySelectorAll('[data-testid="approval-condition-order-hint"]')).toHaveLength(0)
  })

  // P2-6 (D0 §4.1, verbatim): priority chips must convey evaluation direction, and the condition
  // inspector header carries the mandated evaluation-order hint exactly once.
  it('P1-D/P2-6: priority-1 chip carries the "最高" direction cue and the header hint is the verbatim D0 §4.1 string', async () => {
    routeParams = { id: 'tpl_priority_direction' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildThreeBranchConditionGraph() }))
    await mountView()
    await flushUi()

    const branchCards = Array.from(container!.querySelectorAll('[data-testid="approval-condition-branch"]'))
    const chipTexts = branchCards.map(
      (card) => card.querySelector('[data-testid="approval-condition-branch-priority"]')?.textContent?.trim(),
    )
    expect(chipTexts).toEqual(['优先级 1 最高', '优先级 2', '优先级 3'])

    const hints = container!.querySelectorAll('[data-testid="approval-condition-order-hint"]')
    expect(hints).toHaveLength(1) // "lives once" — D0 §4.1
    expect(hints[0].textContent?.trim()).toBe('分支按优先级从上到下依次判断，全部不满足时走默认分支。')
  })

  // P1-D (master §4 UI-3/UI-9, parent-lock §9/:276 gap): a compact 版本历史 navigation entry in the
  // authoring header, linking to the existing TemplateDetailView.vue version-history section. No new
  // version storage — pure navigation, gated on "saved template WITH at least one recorded version".
  it('P1-D: header 版本历史 link renders for a saved template with recorded history and navigates to the detail view', async () => {
    routeParams = { id: 'tpl_version_link' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ id: 'tpl_version_link', latestVersionId: 'ver_9' }))
    await mountView()
    await flushUi()

    const link = container!.querySelector('[data-testid="approval-template-version-history-link"]') as HTMLButtonElement
    expect(link).not.toBeNull()
    link.click()
    expect(pushSpy).toHaveBeenCalledWith({ path: '/approval-templates/tpl_version_link' })
  })

  it('P1-D: header 版本历史 link is absent for a brand-new (unsaved) template', async () => {
    routeParams = {}
    await mountView()
    await flushUi()
    expect(container!.querySelector('[data-testid="approval-template-version-history-link"]')).toBeNull()
  })

  it('P1-D: header 版本历史 link is absent for a saved template with no recorded version yet', async () => {
    routeParams = { id: 'tpl_no_history' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ id: 'tpl_no_history', latestVersionId: null }))
    await mountView()
    await flushUi()
    expect(container!.querySelector('[data-testid="approval-template-version-history-link"]')).toBeNull()
  })

  it('promotes a blank linear template into graph authoring when a condition gateway is inserted', async () => {
    approvalCanvasV2.value = true
    await mountView()
    const insert = container!.querySelector('[data-testid^="approval-step-insert-condition-after-"]') as HTMLButtonElement
    insert.click()
    await flushUi()
    expect(container!.querySelector('[data-testid="approval-graph-view-toggle"]')).not.toBeNull()
    expect(container!.querySelectorAll('[data-testid="approval-canvas-node"]')).toHaveLength(6)
    expect(container!.querySelector('[data-node-type="condition"]')).not.toBeNull()
    ;(container!.querySelector('[data-testid="approval-view-list"]') as HTMLButtonElement).click()
    await flushUi()
    const field = container!.querySelector('[data-testid="approval-condition-rule-field"]') as HTMLSelectElement
    field.value = 'field_1'
    field.dispatchEvent(new Event('change'))
    setInput('approval-template-key', 'conditional')
    setInput('approval-template-name', '条件审批')
    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()
    expect(createTemplateSpy).toHaveBeenCalledTimes(1)
    const graph = (createTemplateSpy.mock.calls[0]?.[0] as any).approvalGraph
    const condition = graph.nodes.find((candidate: any) => candidate.type === 'condition')
    expect(condition.config.branches[0].rules[0].fieldId).toBe('field_1')
    expect(graph.edges.some((edge: any) => edge.key === condition.config.defaultEdgeKey)).toBe(true)
  })

  it('promotes a blank linear template into a two-branch parallel graph and edits its join mode', async () => {
    approvalCanvasV2.value = true
    await mountView()
    const insert = container!.querySelector('[data-testid^="approval-step-insert-parallel-after-"]') as HTMLButtonElement
    insert.click()
    await flushUi()
    expect(container!.querySelectorAll('[data-testid="approval-canvas-node"]')).toHaveLength(6)
    ;(container!.querySelector('[data-testid="approval-view-list"]') as HTMLButtonElement).click()
    await flushUi()
    const joinMode = container!.querySelector('[data-testid="approval-parallel-join-mode"]') as HTMLSelectElement
    joinMode.value = 'any'
    joinMode.dispatchEvent(new Event('change'))
    setInput('approval-template-key', 'parallel')
    setInput('approval-template-name', '并行审批')
    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()
    const graph = (createTemplateSpy.mock.calls[0]?.[0] as any).approvalGraph
    const parallel = graph.nodes.find((candidate: any) => candidate.type === 'parallel')
    expect(parallel.config.joinMode).toBe('any')
    expect(parallel.config.branches).toHaveLength(2)
    expect(graph.edges.filter((edge: any) => edge.source === parallel.key)).toHaveLength(2)
  })

  it('keeps approval mode, self-approval, and field permissions editable in graph authoring', async () => {
    routeParams = { id: 'tpl_graph_policy' }
    getTemplateSpy.mockResolvedValue(
      buildTemplate({
        approvalGraph: buildG5ComplexGraph({
          assigneeSources: [{ kind: 'direct_manager' }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
        }),
      }),
    )
    await mountView()
    await flushUi()
    const mode = container!.querySelector('[data-testid="approval-node-mode"]') as HTMLSelectElement
    mode.value = 'all'
    mode.dispatchEvent(new Event('change'))
    const merge = container!.querySelector('[data-testid="approval-node-merge-with-requester"]') as HTMLInputElement
    merge.checked = true
    merge.dispatchEvent(new Event('change'))
    const fieldAccess = container!.querySelector('[data-testid="approval-node-field-access-amount"]') as HTMLSelectElement
    fieldAccess.value = 'hidden'
    fieldAccess.dispatchEvent(new Event('change'))
    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()
    const graph = (updateTemplateSpy.mock.calls[0]?.[1] as any).approvalGraph
    const approval = graph.nodes.find((candidate: any) => candidate.key === 'approval_1')
    expect(approval.config.approvalMode).toBe('all')
    expect(approval.config.autoApprovalPolicy).toEqual({ mergeWithRequester: true })
    expect(approval.config.fieldPermissions).toEqual([{ fieldId: 'amount', access: 'hidden' }])
  })

  it('FC-2 wiring: switching a condition branch to formula writes formula to the save payload while topology stays byte-identical', async () => {
    routeParams = { id: 'tpl_formula_condition' }
    const graph = {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        { key: 'cond_1', type: 'condition', name: '金额判断', config: { branches: [{ edgeKey: 'e-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }] }], defaultEdgeKey: 'e-low' } },
        { key: 'approval_high', type: 'approval', name: '高额审批', config: { assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'e-start-c', source: 'start', target: 'cond_1' },
        { key: 'e-high', source: 'cond_1', target: 'approval_high' },
        { key: 'e-low', source: 'cond_1', target: 'end' },
        { key: 'e-high-end', source: 'approval_high', target: 'end' },
      ],
    }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: graph }))
    await mountView()
    await flushUi()

    const modeSelect = container!.querySelector('[data-testid="approval-condition-predicate-mode"]') as HTMLSelectElement
    expect(modeSelect.value).toBe('rules')
    modeSelect.value = 'formula'
    modeSelect.dispatchEvent(new Event('change'))
    await flushUi()

    expect(container!.querySelector('[data-testid="approval-condition-formula-insert-sum"]')).not.toBeNull()
    const expression = container!.querySelector('[data-testid="approval-condition-formula-expression"]') as HTMLInputElement
    expression.value = '{amount} >= 5000'
    expression.dispatchEvent(new Event('input'))
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()

    expect(updateTemplateSpy).toHaveBeenCalledTimes(1)
    const payload = updateTemplateSpy.mock.calls[0]?.[1] as any
    const conditionNode = payload.approvalGraph.nodes.find((node: any) => node.key === 'cond_1')
    expect(conditionNode.config).toEqual({
      branches: [{ edgeKey: 'e-high', rules: [], formula: { expression: '{amount} >= 5000' } }],
      defaultEdgeKey: 'e-low',
    })
    expect(payload.approvalGraph.nodes.find((node: any) => node.key === 'approval_high')).toEqual(graph.nodes[2])
    expect(payload.approvalGraph.edges).toEqual(graph.edges)
  })

  it('FC-5 wiring: formula dry-run calls the dry-run endpoint with typed 试运行 sample values and does not change the saved graph payload', async () => {
    routeParams = { id: 'tpl_formula_dry_run' }
    const graph = {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        { key: 'cond_1', type: 'condition', name: '金额判断', config: { branches: [{ edgeKey: 'e-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }] }], defaultEdgeKey: 'e-low' } },
        { key: 'approval_high', type: 'approval', name: '高额审批', config: { assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'e-start-c', source: 'start', target: 'cond_1' },
        { key: 'e-high', source: 'cond_1', target: 'approval_high' },
        { key: 'e-low', source: 'cond_1', target: 'end' },
        { key: 'e-high-end', source: 'approval_high', target: 'end' },
      ],
    }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: graph }))
    await mountView()
    await flushUi()

    const modeSelect = container!.querySelector('[data-testid="approval-condition-predicate-mode"]') as HTMLSelectElement
    modeSelect.value = 'formula'
    modeSelect.dispatchEvent(new Event('change'))
    await flushUi()

    const expression = container!.querySelector('[data-testid="approval-condition-formula-expression"]') as HTMLInputElement
    expression.value = '{amount} >= 5000'
    expression.dispatchEvent(new Event('input'))
    await flushUi()

    // D1 values-first: no JSON sample textarea — typed 试运行 sampleFormData drives dry-run.
    expect(container!.querySelector('[data-testid="approval-condition-formula-dry-run-sample"]')).toBeNull()
    expect(container!.querySelector('[data-testid="approval-condition-formula-dry-run-sample-hint"]')?.textContent).toContain('试运行样例值')
    expect(container!.textContent || '').not.toMatch(/JSON/i)

    // Fill the shared 试运行 sample amount via the review panel, then return to flow to dry-run.
    ;(container!.querySelector('[data-testid="approval-template-section-review"]') as HTMLButtonElement).click()
    await flushUi()
    const amountSample = container!.querySelector(
      '[data-testid="approval-template-tryrun-panel"] input[type="number"]',
    ) as HTMLInputElement
    expect(amountSample).not.toBeNull()
    amountSample.value = '6000'
    amountSample.dispatchEvent(new Event('input'))
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-template-section-flow"]') as HTMLButtonElement).click()
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-condition-formula-dry-run-button"]') as HTMLButtonElement).click()
    await flushUi()

    expect(dryRunApprovalConditionFormulaSpy).toHaveBeenCalledTimes(1)
    expect(dryRunApprovalConditionFormulaSpy).toHaveBeenCalledWith({
      formSchema: expect.objectContaining({
        fields: expect.arrayContaining([expect.objectContaining({ id: 'amount', type: 'number' })]),
      }),
      expression: '{amount} >= 5000',
      formData: { amount: 6000 },
    })
    expect(container!.querySelector('[data-testid="approval-condition-formula-dry-run-result"]')?.textContent).toContain('true')

    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()

    const payload = updateTemplateSpy.mock.calls[0]?.[1] as any
    const conditionNode = payload.approvalGraph.nodes.find((node: any) => node.key === 'cond_1')
    expect(conditionNode.config).toEqual({
      branches: [{ edgeKey: 'e-high', rules: [], formula: { expression: '{amount} >= 5000' } }],
      defaultEdgeKey: 'e-low',
    })
    expect(JSON.stringify(payload)).not.toContain('6000')
    expect(payload.approvalGraph.edges).toEqual(graph.edges)
  })

  function buildCanvasConditionGraph() {
    return {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        { key: 'cond_1', type: 'condition', name: '判断', config: { branches: [{ edgeKey: 'e-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }] }], defaultEdgeKey: 'e-low' } },
        { key: 'app_high', type: 'approval', name: '高', config: { assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'e-start-c', source: 'start', target: 'cond_1' },
        { key: 'e-high', source: 'cond_1', target: 'app_high' },
        { key: 'e-low', source: 'cond_1', target: 'end' },
        { key: 'e-high-end', source: 'app_high', target: 'end' },
      ],
    }
  }

  it('keeps the experimental Canvas V2 surface absent while its explicit feature flag is off', async () => {
    routeParams = { id: 'tpl_canvas_off' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildCanvasConditionGraph() }))
    await mountView()
    await flushUi()

    expect(container!.querySelector('[data-testid="approval-graph-view-toggle"]')).toBeNull()
    expect(container!.querySelector('[data-testid="approval-graph-canvas"]')).toBeNull()
    expect(container!.querySelector('[data-testid="approval-graph-readonly-list"]')).not.toBeNull()
  })

  it('D-1 canvas: toggling to 画布视图 renders the graph visually (nodes + SVG edges), no false validity warning', async () => {
    approvalCanvasV2.value = true
    routeParams = { id: 'tpl_canvas' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildCanvasConditionGraph() }))
    await mountView()
    await flushUi()
    ;(container!.querySelector('[data-testid="approval-view-canvas"]') as HTMLButtonElement).click()
    await flushUi()
    expect(container!.querySelectorAll('[data-testid="approval-canvas-node"]').length).toBe(4) // 4 nodes rendered
    expect(container!.querySelectorAll('[data-testid="approval-canvas-edge"]').length).toBe(4) // 4 edges rendered
    expect(container!.querySelector('[data-testid="approval-canvas-validity"]')).toBeNull() // a valid graph → no warning
  })

  it('D-1/D-3 canvas: adding a condition branch ON THE CANVAS grows it and saves the new structure', async () => {
    approvalCanvasV2.value = true
    routeParams = { id: 'tpl_canvas2' }
    getTemplateSpy.mockResolvedValue(buildTemplate({ approvalGraph: buildCanvasConditionGraph() }))
    await mountView()
    await flushUi()
    ;(container!.querySelector('[data-testid="approval-view-canvas"]') as HTMLButtonElement).click()
    await flushUi()
    const before = container!.querySelectorAll('[data-testid="approval-canvas-node"]').length
    // D0: topology actions live on the selected-node inspector (no node button clusters).
    const condNode = container!.querySelector('[data-canvas-node="cond_1"] [data-testid="approval-canvas-node-select"]') as HTMLElement
    expect(condNode).not.toBeNull()
    condNode.click()
    await flushUi()
    const addBranch = container!.querySelector('[data-testid="approval-canvas-add-condition-cond_1"]') as HTMLButtonElement
    expect(addBranch).not.toBeNull()
    addBranch.click()
    await flushUi()
    expect(container!.querySelectorAll('[data-testid="approval-canvas-node"]').length).toBe(before + 1) // new node on canvas
    // P1 fix (review #4433 F1): the canvas-added branch seeds an INCOMPLETE starter rule too —
    // configure it in the list view before the save can go through (empty branch never saves clean).
    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()
    expect(updateTemplateSpy).not.toHaveBeenCalled()
    ;(container!.querySelector('[data-testid="approval-view-list"]') as HTMLButtonElement).click()
    await flushUi()
    const ruleFields = container!.querySelectorAll('[data-testid="approval-condition-rule-field"]')
    const newRuleField = ruleFields[ruleFields.length - 1] as HTMLSelectElement
    newRuleField.value = 'amount'
    newRuleField.dispatchEvent(new Event('change'))
    await flushUi()
    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()
    const payload = updateTemplateSpy.mock.calls[0]?.[1] as any
    expect(payload.approvalGraph.nodes.find((n: any) => n.key === 'cond_1').config.branches).toHaveLength(2) // saved
  })

  it('F4: no +并行 affordance INSIDE a parallel branch (backend rejects nested parallel), while +条件 stays offered', async () => {
    routeParams = { id: 'tpl_nested_guard' }
    getTemplateSpy.mockResolvedValue(buildTemplate({
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: '发起', config: {} },
          { key: 'fork_1', type: 'parallel', name: '并行', config: { branches: ['e-fork-a', 'e-fork-b'], joinMode: 'all', joinNodeKey: 'join_1' } },
          { key: 'app_a', type: 'approval', name: 'A', config: { assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
          { key: 'app_b', type: 'approval', name: 'B', config: { assigneeSources: [{ kind: 'static_role', roleIds: ['legal'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
          { key: 'join_1', type: 'approval', name: '汇聚', config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
          { key: 'end', type: 'end', name: '结束', config: {} },
        ],
        edges: [
          { key: 'e-start-fork', source: 'start', target: 'fork_1' },
          { key: 'e-fork-a', source: 'fork_1', target: 'app_a' },
          { key: 'e-fork-b', source: 'fork_1', target: 'app_b' },
          { key: 'e-a-join', source: 'app_a', target: 'join_1' },
          { key: 'e-b-join', source: 'app_b', target: 'join_1' },
          { key: 'e-join-end', source: 'join_1', target: 'end' },
        ],
      },
    }))
    await mountView()
    await flushUi()
    // In-region branch node: parallel insert HIDDEN, condition insert still offered.
    expect(container!.querySelector('[data-testid="approval-topology-insert-parallel-after-app_a"]')).toBeNull()
    expect(container!.querySelector('[data-testid="approval-topology-insert-condition-after-app_a"]')).not.toBeNull()
    // Out-of-region single-out nodes (start / the join) keep the parallel insert.
    expect(container!.querySelector('[data-testid="approval-topology-insert-parallel-after-start"]')).not.toBeNull()
    expect(container!.querySelector('[data-testid="approval-topology-insert-parallel-after-join_1"]')).not.toBeNull()
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

  it('Lock-1 §K4: continuous_dept_heads reads back editable: a saved continuous_dept_heads template is NOT fail-closed (sourceKind + levels input hydrated, registry-admitted)', async () => {
    routeParams = { id: 'tpl_dh' }
    getTemplateSpy.mockResolvedValue(buildTemplate({
      approvalGraph: buildComboGraph({ assigneeSources: [{ kind: 'continuous_dept_heads', levels: 2 }], approvalMode: 'all', emptyAssigneePolicy: 'error' }),
    }))
    await mountView()
    await flushUi()

    expect(container!.querySelector('[data-testid="approval-template-unsupported-alert"]')).toBeNull() // in the allowlist → not fail-closed
    expect((container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).disabled).toBe(false) // editable
    expect((container!.querySelector('[data-testid="approval-step-source-kind"]') as HTMLSelectElement).value).toBe('continuous_dept_heads') // hydrated back
    expect((container!.querySelector('[data-testid="approval-step-dept-head-levels"]') as HTMLInputElement)).not.toBeNull() // the levels input renders for this kind
  })

  it('Lock-1 §K5-b: dept_head_at_level reads back editable: a saved dept_head_at_level template is NOT fail-closed (sourceKind + level input hydrated, registry-admitted)', async () => {
    routeParams = { id: 'tpl_dhal' }
    getTemplateSpy.mockResolvedValue(buildTemplate({
      approvalGraph: buildComboGraph({ assigneeSources: [{ kind: 'dept_head_at_level', level: 2 }], approvalMode: 'single', emptyAssigneePolicy: 'error' }),
    }))
    await mountView()
    await flushUi()

    expect(container!.querySelector('[data-testid="approval-template-unsupported-alert"]')).toBeNull() // in the allowlist → not fail-closed
    expect((container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).disabled).toBe(false) // editable
    expect((container!.querySelector('[data-testid="approval-step-source-kind"]') as HTMLSelectElement).value).toBe('dept_head_at_level') // hydrated back
    expect((container!.querySelector('[data-testid="approval-step-dept-head-level"]') as HTMLInputElement)).not.toBeNull() // the level input renders for this kind
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
    // B2-03: publish now opens the pre-flight checklist FIRST; the real persist/publish sequence
    // only runs once the dialog's own confirm button is clicked (a fresh linear draft with just
    // key+name filled is all-green, so the confirm button is enabled).
    ;(container!.querySelector('[data-testid="approval-template-publish-button"]') as HTMLButtonElement).click()
    await flushUi()
    expect(createTemplateSpy).not.toHaveBeenCalled()
    const dialog = container!.querySelector('[data-testid="approval-publish-checklist"]')
    expect(dialog).not.toBeNull()
    // all-green: every checklist item ✓, confirm enabled.
    for (const key of ['fields', 'flow', 'placeholder']) {
      const item = dialog!.querySelector(`[data-testid="approval-publish-checklist-item-${key}"]`)
      expect(item).not.toBeNull()
      expect(item!.getAttribute('data-ok')).toBe('true')
      expect(item!.textContent).toContain('✓')
    }
    const confirmButton = dialog!.querySelector('[data-testid="approval-publish-checklist-confirm"]') as HTMLButtonElement
    expect(confirmButton.disabled).toBe(false)

    confirmButton.click()
    await flushUi()

    expect(createTemplateSpy).toHaveBeenCalledTimes(1)
    expect(publishTemplateSpy).toHaveBeenCalledWith('tpl_created', { policy: { allowRevoke: true } })
    expect(pushSpy).toHaveBeenCalledWith({ path: '/approval-templates/tpl_created' })
  })

  // Publish-sequencing fix (Lock-6 L6-P1 gate F3 finding). `confirmPublish()` used to read
  // `draft.value` for the publish payload AFTER `persistDraft()` had already REPLACED it via
  // `draftFromTemplate(saved)` — and since `policy` is publish-only (never part of the create/
  // update payload or response), that rebuild always re-derives `allowRevoke` from whatever was
  // LAST published (or the default, for a template that never has), discarding any in-progress
  // edit the admin just made. The checkbox was fully interactive and its DOM state was correct;
  // the edit simply never reached the server. These two tests reproduce the discriminating case
  // BOTH prior tests in this file miss: they interact with the checkbox and immediately publish in
  // the SAME sitting (every prior test either never touches the control, or asserts against a pure
  // `draftFromTemplate`/`buildPublishPolicy` call outside the component, never through the full
  // click -> persistDraft -> publish sequence).
  it('CREATE mode: unchecking allowRevoke and publishing in the SAME sitting reaches the server (was silently discarded)', async () => {
    await mountView()
    setInput('approval-template-key', 'purchase')
    setInput('approval-template-name', '采购审批')

    const checkbox = container!.querySelector('[data-testid="approval-template-allow-revoke"]') as HTMLInputElement
    expect(checkbox.checked).toBe(true) // create-time default
    checkbox.checked = false
    checkbox.dispatchEvent(new Event('change'))
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-template-publish-button"]') as HTMLButtonElement).click()
    await flushUi()
    const confirmButton = container!.querySelector('[data-testid="approval-publish-checklist-confirm"]') as HTMLButtonElement
    confirmButton.click()
    await flushUi()

    expect(publishTemplateSpy).toHaveBeenCalledWith('tpl_created', { policy: { allowRevoke: false } })
  })

  it('UPDATE mode: unchecking allowRevoke on an EXISTING published template and publishing in the SAME sitting reaches the server (was silently discarded)', async () => {
    routeParams = { id: 'tpl_seq' }
    // The REAL backend's PATCH response carries the active published policy forward unchanged
    // (Lock-6 L6-P1) — this override matches that contract; the shared beforeEach default omits
    // `policy` entirely, which would mask this exact bug behind an unrealistic mock.
    updateTemplateSpy.mockImplementation(async (id: string, payload: Record<string, unknown>) => ({
      ...buildTemplate({ id, status: 'published', activeVersionId: 'ver_1', policy: { allowRevoke: true } }),
      ...payload,
    }))
    getTemplateSpy.mockResolvedValue(buildTemplate({ id: 'tpl_seq', status: 'published', activeVersionId: 'ver_1', policy: { allowRevoke: true } }))
    await mountView()
    await flushUi()

    const checkbox = container!.querySelector('[data-testid="approval-template-allow-revoke"]') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    checkbox.checked = false
    checkbox.dispatchEvent(new Event('change'))
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-template-publish-button"]') as HTMLButtonElement).click()
    await flushUi()
    const confirmButton = container!.querySelector('[data-testid="approval-publish-checklist-confirm"]') as HTMLButtonElement
    confirmButton.click()
    await flushUi()

    expect(publishTemplateSpy).toHaveBeenCalledWith('tpl_seq', { policy: { allowRevoke: false } })
  })

  it('positive control: republishing WITHOUT touching allowRevoke still carries the persisted value unchanged (the fix does not disturb the untouched round trip, gate P-1)', async () => {
    routeParams = { id: 'tpl_seq_untouched' }
    updateTemplateSpy.mockImplementation(async (id: string, payload: Record<string, unknown>) => ({
      ...buildTemplate({ id, status: 'published', activeVersionId: 'ver_1', policy: { allowRevoke: false } }),
      ...payload,
    }))
    getTemplateSpy.mockResolvedValue(buildTemplate({ id: 'tpl_seq_untouched', status: 'published', activeVersionId: 'ver_1', policy: { allowRevoke: false } }))
    await mountView()
    await flushUi()

    const checkbox = container!.querySelector('[data-testid="approval-template-allow-revoke"]') as HTMLInputElement
    expect(checkbox.checked).toBe(false) // hydrated, untouched

    ;(container!.querySelector('[data-testid="approval-template-publish-button"]') as HTMLButtonElement).click()
    await flushUi()
    const confirmButton = container!.querySelector('[data-testid="approval-publish-checklist-confirm"]') as HTMLButtonElement
    confirmButton.click()
    await flushUi()

    expect(publishTemplateSpy).toHaveBeenCalledWith('tpl_seq_untouched', { policy: { allowRevoke: false } })
  })

  // B3-09 (模板治理 — 发布说明): the checklist dialog carries an OPTIONAL note; typed → trimmed and
  // sent, untyped/whitespace-only → the payload has NO note key (byte-identical to pre-B3-09 wire).
  it('B3-09: publishes with a trimmed note when one is typed in the checklist dialog', async () => {
    await mountView()

    setInput('approval-template-key', 'purchase')
    setInput('approval-template-name', '采购审批')
    ;(container!.querySelector('[data-testid="approval-template-publish-button"]') as HTMLButtonElement).click()
    await flushUi()

    setInput('approval-publish-note-input', '  上调金额上限至 5000  ')
    const confirmButton = container!.querySelector('[data-testid="approval-publish-checklist-confirm"]') as HTMLButtonElement
    confirmButton.click()
    await flushUi()

    expect(publishTemplateSpy).toHaveBeenCalledWith('tpl_created', {
      policy: { allowRevoke: true },
      note: '上调金额上限至 5000',
    })
  })

  it('B3-09: reopening the publish dialog clears the previous note; whitespace-only sends no note key', async () => {
    await mountView()

    setInput('approval-template-key', 'purchase')
    setInput('approval-template-name', '采购审批')

    // First open: type a note, then close WITHOUT publishing.
    ;(container!.querySelector('[data-testid="approval-template-publish-button"]') as HTMLButtonElement).click()
    await flushUi()
    setInput('approval-publish-note-input', '第一次的说明')
    const dialog = container!.querySelector('[data-testid="approval-publish-checklist"]')!
    const cancelButton = Array.from(dialog.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('取消'),
    ) as HTMLButtonElement
    cancelButton.click()
    await flushUi()
    expect(publishTemplateSpy).not.toHaveBeenCalled()

    // Reopen: the previous note must NOT carry over (a note describes ONE publish action).
    ;(container!.querySelector('[data-testid="approval-template-publish-button"]') as HTMLButtonElement).click()
    await flushUi()
    const noteInput = container!.querySelector('[data-testid="approval-publish-note-input"]') as HTMLInputElement
    expect(noteInput.value).toBe('')

    // Whitespace-only note → payload carries no note key at all.
    setInput('approval-publish-note-input', '   ')
    ;(container!.querySelector('[data-testid="approval-publish-checklist-confirm"]') as HTMLButtonElement).click()
    await flushUi()

    expect(publishTemplateSpy).toHaveBeenCalledWith('tpl_created', { policy: { allowRevoke: true } })
  })

  it('B2-03: an invalid draft (blank key/name) opens the publish checklist with a failing "表单字段" item and disables the confirm button', async () => {
    await mountView()
    // leave key/name blank — validateTemplateFormFields fails ('模板 Key 必填' / '模板名称必填').

    ;(container!.querySelector('[data-testid="approval-template-publish-button"]') as HTMLButtonElement).click()
    await flushUi()

    const dialog = container!.querySelector('[data-testid="approval-publish-checklist"]')
    expect(dialog).not.toBeNull()
    const fieldsItem = dialog!.querySelector('[data-testid="approval-publish-checklist-item-fields"]')
    expect(fieldsItem).not.toBeNull()
    expect(fieldsItem!.getAttribute('data-ok')).toBe('false')
    expect(fieldsItem!.textContent).toContain('✗')
    expect(fieldsItem!.textContent).toContain('模板 Key 必填')

    const confirmButton = dialog!.querySelector('[data-testid="approval-publish-checklist-confirm"]') as HTMLButtonElement
    expect(confirmButton.disabled).toBe(true)

    confirmButton.click()
    await flushUi()
    expect(createTemplateSpy).not.toHaveBeenCalled()
    expect(publishTemplateSpy).not.toHaveBeenCalled()
  })

  it('B2-03: a starter-preset placeholder role fails ONLY the "审批人占位" checklist item (fields/flow stay ✓) and disables the confirm button', async () => {
    routeParams = { id: 'tpl_sentinel_publish' }
    getTemplateSpy.mockResolvedValue(buildTemplate({
      approvalGraph: buildG5ComplexGraph({
        assigneeSources: [{ kind: 'static_role', roleIds: [APPROVAL_ROLE_CONFIGURE_SENTINEL] }],
        approvalMode: 'single',
        emptyAssigneePolicy: 'error',
      }),
    }))
    await mountView()
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-template-publish-button"]') as HTMLButtonElement).click()
    await flushUi()

    const dialog = container!.querySelector('[data-testid="approval-publish-checklist"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.querySelector('[data-testid="approval-publish-checklist-item-fields"]')!.getAttribute('data-ok')).toBe('true')
    expect(dialog!.querySelector('[data-testid="approval-publish-checklist-item-flow"]')!.getAttribute('data-ok')).toBe('true')
    const placeholderItem = dialog!.querySelector('[data-testid="approval-publish-checklist-item-placeholder"]')
    expect(placeholderItem).not.toBeNull()
    expect(placeholderItem!.getAttribute('data-ok')).toBe('false')
    expect(placeholderItem!.textContent).toContain('✗')
    expect(placeholderItem!.textContent).toContain('主管') // the placeholder node's name, so the admin can find it
    expect(placeholderItem!.textContent).toContain('占位')

    const confirmButton = dialog!.querySelector('[data-testid="approval-publish-checklist-confirm"]') as HTMLButtonElement
    expect(confirmButton.disabled).toBe(true)

    confirmButton.click()
    await flushUi()
    expect(publishTemplateSpy).not.toHaveBeenCalled()
  })

  // P3-B / Lock-6 L6-A (docs/development/approval-lock6-requester-global-policy-20260817.md §1,
  // §2.7). Master M7 (§4 P3-B exit): the fifth wizard step is authorized ONLY because it carries a
  // REAL, server-enforced control (Lock-4 §2.6's dedup arms — already enforced by the backend; this
  // PR adds only the authoring surface). These tests assert the census (M-2: no inert control), the
  // structural activation (Lock-0 L0-4 / Lock-6 §2.7: 5 steps, 测试发布 last), and the round-trip
  // through hydrate -> edit -> publish (including the locked both-true state, gate X-1).
  describe('P3-B More-settings step — L6-A dedup tier (master M7, Lock-6 §1/§2.7/X-1)', () => {
    it('activates exactly 5 steps: 更多设置 as step 4, 测试发布 last', async () => {
      await mountView()
      const stepIds = Array.from(container!.querySelectorAll('[data-testid^="approval-template-section-"]'))
        .map((el) => el.getAttribute('data-testid'))
        .filter((id): id is string => /^approval-template-section-(basic|fields|flow|more-settings|review)$/.test(id ?? ''))
      expect(stepIds).toEqual([
        'approval-template-section-basic',
        'approval-template-section-fields',
        'approval-template-section-flow',
        'approval-template-section-more-settings',
        'approval-template-section-review',
      ])
    })

    it('M7/M-2 census: 更多设置 is NOT an empty shell — it renders the dedup-tier radio group with 3 real, distinct, ENABLED options', async () => {
      await mountView()
      ;(container!.querySelector('[data-testid="approval-template-section-more-settings"]') as HTMLButtonElement).click()
      await flushUi()

      const group = container!.querySelector('[data-testid="approval-template-dedup-tier"]')
      expect(group).not.toBeNull()
      const radios = Array.from(group!.querySelectorAll('input[type="radio"]')) as HTMLInputElement[]
      expect(radios.length).toBe(3)
      expect(container!.querySelector('[data-testid="approval-template-dedup-tier-none"]')).not.toBeNull()
      expect(container!.querySelector('[data-testid="approval-template-dedup-tier-dedupe-historical"]')).not.toBeNull()
      expect(container!.querySelector('[data-testid="approval-template-dedup-tier-merge-adjacent"]')).not.toBeNull()
      // Adversarial-gate P2 (PR #4967): renders-but-inert is a different failure than absent — a
      // brand-new/non-locked template's control must actually be ENABLED, not permanently disabled
      // theater that happens to still fire jsdom's change handler. This is the ONLY assertion that
      // distinguishes "editable" from "renders disabled".
      radios.forEach((radio) => expect(radio.disabled).toBe(false))
    })

    it('defaults to 不去重 (none) for a brand-new template — §2.2 no shipped default may change', async () => {
      await mountView()
      ;(container!.querySelector('[data-testid="approval-template-section-more-settings"]') as HTMLButtonElement).click()
      await flushUi()
      const noneInput = container!.querySelector('[data-testid="approval-template-dedup-tier-none"]') as HTMLInputElement
      expect(noneInput.checked).toBe(true)
    })

    // M8 honesty (adversarial-gate P3-1, PR #4967): mergeAdjacentApprover also exempts a parallel
    // gateway from two publish-time duplicate-assignee checks (ApprovalProductService.ts:4595,
    // :4623-4625) — a real side effect that must be disclosed, and disclosed ONLY while that tier
    // is actually selected (it does not apply to 不去重 / 仅一次全自动同意).
    it('M8: selecting 仅连续节点自动同意 discloses the parallel-branch publish-check relaxation; other tiers do not', async () => {
      await mountView()
      ;(container!.querySelector('[data-testid="approval-template-section-more-settings"]') as HTMLButtonElement).click()
      await flushUi()

      expect(container!.querySelector('[data-testid="approval-template-dedup-tier-merge-adjacent-hint"]')).toBeNull()

      const dedupeInput = container!.querySelector('[data-testid="approval-template-dedup-tier-dedupe-historical"]') as HTMLInputElement
      dedupeInput.checked = true
      dedupeInput.dispatchEvent(new Event('change'))
      await flushUi()
      expect(container!.querySelector('[data-testid="approval-template-dedup-tier-merge-adjacent-hint"]')).toBeNull()

      const mergeAdjacentInput = container!.querySelector('[data-testid="approval-template-dedup-tier-merge-adjacent"]') as HTMLInputElement
      mergeAdjacentInput.checked = true
      mergeAdjacentInput.dispatchEvent(new Event('change'))
      await flushUi()
      const hint = container!.querySelector('[data-testid="approval-template-dedup-tier-merge-adjacent-hint"]')
      expect(hint).not.toBeNull()
      expect(hint!.textContent).toContain('并行')
    })

    it('selecting a tier (immediate-apply, no separate save transaction) and publishing carries autoApproval alongside allowRevoke', async () => {
      await mountView()
      setInput('approval-template-key', 'purchase')
      setInput('approval-template-name', '采购审批')
      ;(container!.querySelector('[data-testid="approval-template-section-more-settings"]') as HTMLButtonElement).click()
      await flushUi()

      const dedupeInput = container!.querySelector('[data-testid="approval-template-dedup-tier-dedupe-historical"]') as HTMLInputElement
      dedupeInput.checked = true
      dedupeInput.dispatchEvent(new Event('change'))
      await flushUi()

      ;(container!.querySelector('[data-testid="approval-template-publish-button"]') as HTMLButtonElement).click()
      await flushUi()
      const confirmButton = container!.querySelector('[data-testid="approval-publish-checklist-confirm"]') as HTMLButtonElement
      confirmButton.click()
      await flushUi()

      expect(publishTemplateSpy).toHaveBeenCalledWith('tpl_created', {
        policy: { allowRevoke: true, autoApproval: { dedupeHistoricalApprover: true } },
      })
    })

    it('hydrating a template with a persisted tier pre-selects the matching radio, and republishing WITHOUT touching it round-trips unchanged', async () => {
      routeParams = { id: 'tpl_dedup_hydrate' }
      const persistedPolicy = { allowRevoke: true, autoApproval: { mergeAdjacentApprover: true } }
      getTemplateSpy.mockResolvedValue(buildTemplate({ id: 'tpl_dedup_hydrate', status: 'published', activeVersionId: 'ver_1', policy: persistedPolicy }))
      // L6-P1 (docs/development/approval-lock6-requester-global-policy-20260817.md §1): the REAL
      // backend's PATCH response carries the active published definition's policy forward
      // unchanged (persistDraft() rebuilds `draft.value` from this response before publish reads
      // it). The shared default mock in this file's beforeEach omits `policy` entirely — faithful
      // for a template that has never been published, but NOT for this hydrate-from-published
      // scenario, so this test overrides it to match the real, already-fixed contract.
      updateTemplateSpy.mockImplementation(async (id: string, payload: Record<string, unknown>) => ({
        ...buildTemplate({ id, status: 'published', activeVersionId: 'ver_1', policy: persistedPolicy }),
        ...payload,
      }))
      await mountView()
      await flushUi()
      ;(container!.querySelector('[data-testid="approval-template-section-more-settings"]') as HTMLButtonElement).click()
      await flushUi()

      const mergeInput = container!.querySelector('[data-testid="approval-template-dedup-tier-merge-adjacent"]') as HTMLInputElement
      expect(mergeInput.checked).toBe(true)

      ;(container!.querySelector('[data-testid="approval-template-publish-button"]') as HTMLButtonElement).click()
      await flushUi()
      const confirmButton = container!.querySelector('[data-testid="approval-publish-checklist-confirm"]') as HTMLButtonElement
      confirmButton.click()
      await flushUi()

      expect(publishTemplateSpy).toHaveBeenCalledWith('tpl_dedup_hydrate', {
        policy: { allowRevoke: true, autoApproval: { mergeAdjacentApprover: true } },
      })
    })

    it('gate X-1: a locked (both-true) persisted combination disables the radio group and republishing preserves it byte-unchanged', async () => {
      routeParams = { id: 'tpl_dedup_locked' }
      const persistedPolicy = { allowRevoke: true, autoApproval: { dedupeHistoricalApprover: true, mergeAdjacentApprover: true } }
      getTemplateSpy.mockResolvedValue(buildTemplate({ id: 'tpl_dedup_locked', status: 'published', activeVersionId: 'ver_1', policy: persistedPolicy }))
      // See the sibling hydrate test above for why this override is needed (L6-P1 §1 PATCH-response
      // contract; the shared beforeEach default omits policy).
      updateTemplateSpy.mockImplementation(async (id: string, payload: Record<string, unknown>) => ({
        ...buildTemplate({ id, status: 'published', activeVersionId: 'ver_1', policy: persistedPolicy }),
        ...payload,
      }))
      await mountView()
      await flushUi()
      ;(container!.querySelector('[data-testid="approval-template-section-more-settings"]') as HTMLButtonElement).click()
      await flushUi()

      const group = container!.querySelector('[data-testid="approval-template-dedup-tier"]')!
      const radios = Array.from(group.querySelectorAll('input[type="radio"]')) as HTMLInputElement[]
      expect(radios.length).toBe(3)
      radios.forEach((radio) => expect(radio.disabled).toBe(true))
      expect(container!.querySelector('[data-testid="approval-template-dedup-tier-locked-hint"]')).not.toBeNull()

      ;(container!.querySelector('[data-testid="approval-template-publish-button"]') as HTMLButtonElement).click()
      await flushUi()
      const confirmButton = container!.querySelector('[data-testid="approval-publish-checklist-confirm"]') as HTMLButtonElement
      confirmButton.click()
      await flushUi()

      expect(publishTemplateSpy).toHaveBeenCalledWith('tpl_dedup_locked', {
        policy: { allowRevoke: true, autoApproval: { dedupeHistoricalApprover: true, mergeAdjacentApprover: true } },
      })
    })

    it('M8 honesty: the control never touches a node-level policy field — switching tiers never clears mergeWithRequester on any step (gate A-4 spirit at the FE boundary)', async () => {
      routeParams = { id: 'tpl_dedup_a4' }
      const a4Graph = {
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
              autoApprovalPolicy: { mergeWithRequester: true },
            },
          },
          { key: 'end', type: 'end', name: '结束', config: {} },
        ],
        edges: [
          { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
          { key: 'edge-approval_1-end', source: 'approval_1', target: 'end' },
        ],
      }
      getTemplateSpy.mockResolvedValue(buildTemplate({
        id: 'tpl_dedup_a4',
        status: 'published',
        activeVersionId: 'ver_1',
        policy: { allowRevoke: true },
        approvalGraph: a4Graph,
      }))
      // See the hydrate test above for why this override is needed.
      updateTemplateSpy.mockImplementation(async (id: string, payload: Record<string, unknown>) => ({
        ...buildTemplate({ id, status: 'published', activeVersionId: 'ver_1', policy: { allowRevoke: true }, approvalGraph: a4Graph }),
        ...payload,
      }))
      await mountView()
      await flushUi()
      ;(container!.querySelector('[data-testid="approval-template-section-more-settings"]') as HTMLButtonElement).click()
      await flushUi()

      const mergeAdjacentInput = container!.querySelector('[data-testid="approval-template-dedup-tier-merge-adjacent"]') as HTMLInputElement
      mergeAdjacentInput.checked = true
      mergeAdjacentInput.dispatchEvent(new Event('change'))
      await flushUi()

      ;(container!.querySelector('[data-testid="approval-template-section-flow"]') as HTMLButtonElement).click()
      await flushUi()
      const nodeSelfApproverCheckbox = container!.querySelector('[data-testid="approval-step-merge-with-requester"]') as HTMLInputElement
      expect(nodeSelfApproverCheckbox).not.toBeNull()
      expect(nodeSelfApproverCheckbox.checked).toBe(true)

      ;(container!.querySelector('[data-testid="approval-template-publish-button"]') as HTMLButtonElement).click()
      await flushUi()
      const confirmButton = container!.querySelector('[data-testid="approval-publish-checklist-confirm"]') as HTMLButtonElement
      confirmButton.click()
      await flushUi()

      const payload = publishTemplateSpy.mock.calls.at(-1)?.[1] as { policy: { autoApproval?: Record<string, unknown> } }
      expect(payload.policy.autoApproval).toEqual({ mergeAdjacentApprover: true })
      // The template-level tier switch must never have written into the node's own config.
    })
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

  it('B1-07: dirty-draft tracking arms the browser leave protection, and only when dirty', async () => {
    window.onbeforeunload = null
    await mountView()
    await flushUi()

    // pristine draft → no protection
    expect(window.onbeforeunload).toBeNull()

    setInput('approval-template-name', '出差审批')
    await flushUi()
    // dirty → beforeunload armed (route-leaves confirm through the same isDraftDirty source)
    expect(window.onbeforeunload).not.toBeNull()
    window.onbeforeunload = null
  })

  // ── Approval Canvas V2 D1: ordinary-user authoring hygiene ─────────────────
  // Populated complex graph + multi-field form (incl. blank-label + legacy stored IDs).
  // Negatives: no fixture raw IDs / 字段 ID / 子字段 ID / 手动输入 ID / any "JSON" in ordinary
  // visible text (incl. formula dry-run). Positives: typed user, role, field, CC pickers + save.
  function buildD1HygieneComplexGraph() {
    return {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        {
          key: 'cond_1',
          type: 'condition',
          name: '金额判断',
          config: {
            branches: [{ edgeKey: 'edge-cond_1-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 5000 }], conjunction: 'and' }],
            defaultEdgeKey: 'edge-cond_1-low',
          },
        },
        {
          key: 'approval_high',
          type: 'approval',
          name: '高额审批',
          config: {
            assigneeSources: [{ kind: 'static_user', userIds: ['legacy-user-1'] }],
            approvalMode: 'single',
            emptyAssigneePolicy: 'error',
          },
        },
        {
          key: 'parallel_1',
          type: 'parallel',
          name: '并行会签',
          config: {
            branches: ['edge-parallel_1-a', 'edge-parallel_1-b'],
            joinMode: 'all',
            joinNodeKey: 'join_1',
          },
        },
        {
          key: 'approval_a',
          type: 'approval',
          name: '财务审批',
          config: {
            assigneeSources: [{ kind: 'static_role', roleIds: ['legacy-role-finance'] }],
            approvalMode: 'single',
            emptyAssigneePolicy: 'error',
          },
        },
        {
          key: 'approval_b',
          type: 'approval',
          name: '法务审批',
          config: {
            assigneeSources: [{ kind: 'form_field_user', fieldId: 'reviewer' }],
            approvalMode: 'single',
            emptyAssigneePolicy: 'error',
          },
        },
        {
          key: 'join_1',
          type: 'approval',
          name: '汇聚审批',
          config: {
            assigneeSources: [{ kind: 'direct_manager' }],
            approvalMode: 'single',
            emptyAssigneePolicy: 'error',
          },
        },
        {
          key: 'cc_1',
          type: 'cc',
          name: '抄送归档',
          config: { targetType: 'role', targetIds: ['finance-role-id'] },
        },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'edge-start-cond', source: 'start', target: 'cond_1' },
        { key: 'edge-cond_1-high', source: 'cond_1', target: 'approval_high' },
        { key: 'edge-cond_1-low', source: 'cond_1', target: 'parallel_1' },
        { key: 'edge-high-end', source: 'approval_high', target: 'end' },
        { key: 'edge-parallel_1-a', source: 'parallel_1', target: 'approval_a' },
        { key: 'edge-parallel_1-b', source: 'parallel_1', target: 'approval_b' },
        { key: 'edge-a-join', source: 'approval_a', target: 'join_1' },
        { key: 'edge-b-join', source: 'approval_b', target: 'join_1' },
        { key: 'edge-join-cc', source: 'join_1', target: 'cc_1' },
        { key: 'edge-cc-end', source: 'cc_1', target: 'end' },
      ],
    }
  }

  // Blank-label user field forces 未命名字段 in ordinary labels (negatives). Positives use a
  // labeled variant so validateTemplateDraft allows save (name required for publish/save).
  const d1HygieneFormSchemaBlank = {
    fields: [
      { id: 'amount', type: 'number', label: '报销金额', required: true },
      { id: 'reviewer', type: 'user', label: '', required: false },
      { id: 'reason', type: 'textarea', label: '事由', required: true },
      {
        id: 'expense_items',
        type: 'detail',
        label: '费用明细',
        required: false,
        columns: [
          { id: 'line_amount', type: 'number', label: '', required: true },
          { id: 'line_note', type: 'text', label: '备注', required: false },
        ],
      },
    ],
  }
  const d1HygieneFormSchemaLabeled = {
    fields: [
      { id: 'amount', type: 'number', label: '报销金额', required: true },
      { id: 'reviewer', type: 'user', label: '指定审批人', required: false },
      { id: 'reason', type: 'textarea', label: '事由', required: true },
      {
        id: 'expense_items',
        type: 'detail',
        label: '费用明细',
        required: false,
        columns: [
          { id: 'line_amount', type: 'number', label: '行金额', required: true },
          { id: 'line_note', type: 'text', label: '备注', required: false },
        ],
      },
    ],
  }

  const d1FixtureRawIds = [
    'amount',
    'reviewer',
    'reason',
    'expense_items',
    'line_amount',
    'line_note',
    'legacy-user-1',
    'legacy-role-finance',
    'finance-role-id',
    'edge-cond_1-high',
    'edge-cond_1-low',
    'edge-parallel_1-a',
    'edge-parallel_1-b',
    'join_1',
    'cond_1',
    'approval_high',
    'approval_a',
    'approval_b',
    'cc_1',
  ]

  function ordinaryVisibleText(): string {
    return container!.textContent || ''
  }

  it('D1 hygiene negatives: ordinary visible text has no fixture raw IDs, field-id editors, manual-ID, or JSON', async () => {
    routeParams = { id: 'tpl_d1_hygiene' }
    getTemplateSpy.mockResolvedValue(buildTemplate({
      formSchema: d1HygieneFormSchemaBlank as any,
      approvalGraph: buildD1HygieneComplexGraph() as any,
    }))
    await mountView()
    await flushUi()

    expect(container!.querySelector('[data-testid="approval-graph-readonly-list"]')).not.toBeNull()
    let visible = ordinaryVisibleText()
    for (const raw of d1FixtureRawIds) {
      expect(visible, `flow list must not show raw id ${raw}`).not.toContain(raw)
    }
    expect(visible).not.toContain('字段 ID')
    expect(visible).not.toContain('子字段 ID')
    expect(visible).not.toContain('手动输入 ID')
    expect(visible).not.toMatch(/JSON/i)
    expect(visible).toContain('报销金额')
    expect(visible).toContain('未命名字段')
    expect(visible).toContain('财务审批')
    expect(visible).toContain('法务审批')

    // Formula dry-run: no JSON textarea/wording; values-first hint only.
    const formulaMode = container!.querySelector('[data-testid="approval-condition-predicate-mode"]') as HTMLSelectElement
    expect(formulaMode).not.toBeNull()
    formulaMode.value = 'formula'
    formulaMode.dispatchEvent(new Event('change'))
    await flushUi()
    expect(container!.querySelector('[data-testid="approval-condition-formula-dry-run-sample"]')).toBeNull()
    const dryRunHint = container!.querySelector('[data-testid="approval-condition-formula-dry-run-sample-hint"]') as HTMLElement
    expect(dryRunHint).not.toBeNull()
    expect(dryRunHint.textContent || '').toContain('试运行样例值')
    expect(dryRunHint.textContent || '').not.toMatch(/JSON/i)
    const formulaPanel = container!.querySelector('[data-testid="approval-condition-formula"]') as HTMLElement
    expect(formulaPanel).not.toBeNull()
    // Ordinary dry-run surface itself must not mention JSON (expression tokens may use field paths).
    expect((formulaPanel.querySelector('[data-testid="approval-condition-formula-dry-run-sample-hint"]')?.textContent || '')
      + (formulaPanel.querySelector('.template-authoring__condition-formula-dryrun')?.textContent || '')).not.toMatch(/JSON/i)

    // Return to rules so formula insert tokens do not pollute later full-DOM scans.
    formulaMode.value = 'rules'
    formulaMode.dispatchEvent(new Event('change'))
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-template-section-fields"]') as HTMLButtonElement).click()
    await flushUi()
    visible = ordinaryVisibleText()
    expect(visible).not.toContain('字段 ID')
    expect(visible).not.toContain('子字段 ID')
    expect(visible).not.toMatch(/JSON/i)
    for (const raw of ['amount', 'reviewer', 'reason', 'expense_items', 'line_amount', 'line_note']) {
      expect(visible, `fields section must not show raw id ${raw}`).not.toContain(raw)
    }
    expect(container!.querySelector('[data-testid="approval-detail-config"]')).not.toBeNull()

    ;(container!.querySelector('[data-testid="approval-template-section-review"]') as HTMLButtonElement).click()
    await flushUi()
    expect(container!.querySelector('[data-testid="approval-template-form-preview"]')).toBeNull()
    expect(container!.querySelector('[data-testid="approval-template-graph-preview"]')).toBeNull()
    visible = ordinaryVisibleText()
    expect(visible).not.toMatch(/JSON/i)
    expect(visible).not.toContain('手动输入 ID')
    for (const raw of d1FixtureRawIds) {
      expect(visible, `review must not show raw id ${raw}`).not.toContain(raw)
    }
    expect(container!.querySelector('[data-testid="approval-template-tryrun-panel"]')).not.toBeNull()
  })

  it('D1 hygiene positives: typed user/role/field/CC pickers mounted; untouched save payload unchanged', async () => {
    routeParams = { id: 'tpl_d1_hygiene_save' }
    const graph = buildD1HygieneComplexGraph()
    getTemplateSpy.mockResolvedValue(buildTemplate({
      formSchema: d1HygieneFormSchemaLabeled as any,
      approvalGraph: graph as any,
    }))
    await mountView()
    await flushUi()

    expect(container!.querySelector('[data-testid="approval-node-source-user-picker"]')).not.toBeNull()
    expect(container!.querySelector('[data-testid="approval-node-source-role-picker"]')).not.toBeNull()
    expect(container!.querySelector('[data-testid="approval-node-source-field"]')).not.toBeNull()
    expect(container!.querySelector('[data-testid="approval-cc-target-ids"]')).not.toBeNull()
    expect(container!.querySelector('[data-testid="approval-cc-editor"]')).not.toBeNull()
    expect(container!.querySelector('[data-testid="approval-node-source-ids-text"]')).toBeNull()
    expect(container!.querySelector('[data-testid="approval-step-ids-text"]')).toBeNull()

    const formFieldPicker = container!.querySelector('[data-testid="approval-node-source-field"]') as HTMLSelectElement
    expect(formFieldPicker.value).toBe('reviewer')
    const fieldLabels = Array.from(formFieldPicker.querySelectorAll('option')).map((opt) => opt.textContent || '')
    expect(fieldLabels).toContain('指定审批人')
    expect(fieldLabels.every((label) => !label.includes('reviewer'))).toBe(true)

    const ccPicker = container!.querySelector('[data-testid="approval-cc-target-ids"]') as HTMLSelectElement
    expect(ccPicker.tagName.toLowerCase()).toBe('select')
    const ccOptionLabels = Array.from(ccPicker.querySelectorAll('option')).map((opt) => opt.textContent || '')
    expect(ccOptionLabels.every((label) => !label.includes('finance-role-id'))).toBe(true)

    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()
    expect(updateTemplateSpy).toHaveBeenCalledTimes(1)
    const payload = updateTemplateSpy.mock.calls[0]?.[1] as any
    expect(payload.approvalGraph.edges).toEqual(graph.edges)
    expect(payload.approvalGraph.nodes).toEqual(graph.nodes)
    expect(payload.formSchema.fields.map((f: any) => f.id)).toEqual([
      'amount',
      'reviewer',
      'reason',
      'expense_items',
    ])
    const detail = payload.formSchema.fields.find((f: any) => f.id === 'expense_items')
    expect(detail.columns.map((c: any) => c.id)).toEqual(['line_amount', 'line_note'])
    expect(detail.columns[0].label).toBe('行金额')
    const high = payload.approvalGraph.nodes.find((n: any) => n.key === 'approval_high')
    expect(high.config.assigneeSources).toEqual([{ kind: 'static_user', userIds: ['legacy-user-1'] }])
    const finance = payload.approvalGraph.nodes.find((n: any) => n.key === 'approval_a')
    expect(finance.config.assigneeSources).toEqual([{ kind: 'static_role', roleIds: ['legacy-role-finance'] }])
    const legal = payload.approvalGraph.nodes.find((n: any) => n.key === 'approval_b')
    expect(legal.config.assigneeSources).toEqual([{ kind: 'form_field_user', fieldId: 'reviewer' }])
    const cc = payload.approvalGraph.nodes.find((n: any) => n.key === 'cc_1')
    expect(cc.config).toEqual({ targetType: 'role', targetIds: ['finance-role-id'] })
  })

  // Lock-8 L8-B (docs/development/approval-lock8-field-vocabulary-20260817.md §1.2, OD-L8-5(a)):
  // date_range is never offered as a single bare visibility dependency (its `{start,end}` value is
  // non-scalar — server rejects it, matching record-link/detail) but its two ENDPOINTS are
  // separately selectable via `visibilityFieldOptions` in TemplateAuthoringView.vue, each producing
  // the dotted `${fieldId}.start`/`.end` address the resolver (fieldVisibility.ts /
  // ApprovalGraphExecutor.ts) and `validateFormFieldVisibilityRules` (publish) both understand. This
  // is the M7 affordance that makes the endpoint predicate REACHABLE from the mounted authoring UI —
  // without it, selecting a date_range field here would either be impossible (silently narrowing to
  // OD-L8-5(c)) or offer a bare option that always fails publish (an inert control).
  it('OD-L8-5(a): the visibility depends-on picker offers a date_range field ONLY as two endpoint options, and the chosen endpoint reaches the saved payload', async () => {
    routeParams = { id: 'tpl_1' }
    getTemplateSpy.mockResolvedValue(buildTemplate({
      formSchema: {
        fields: [
          { id: 'trip', type: 'date_range', label: '行程日期', props: { dateType: 'date', startLabel: '开始', endLabel: '结束' } },
          { id: 'reason', type: 'text', label: '事由' },
        ],
      } as any,
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: '发起', config: {} },
          { key: 'approval_1', type: 'approval', name: '审批人 1', config: { assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
          { key: 'end', type: 'end', name: '结束', config: {} },
        ],
        edges: [
          { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
          { key: 'edge-approval_1-end', source: 'approval_1', target: 'end' },
        ],
      },
    }))
    await mountView()
    await flushUi()

    const reasonRow = () => container!.querySelectorAll('[data-testid="approval-template-field-row"]')[1] as HTMLElement
    const dependsSelect = reasonRow().querySelector('[data-testid="approval-field-visibility-depends"]') as HTMLSelectElement
    const optionEntries = Array.from(dependsSelect.options).map((o) => ({ value: o.value, label: o.textContent }))
    expect(optionEntries.some((o) => o.value === 'trip')).toBe(false)
    expect(optionEntries).toContainEqual({ value: 'trip.start', label: '行程日期(起始)' })
    expect(optionEntries).toContainEqual({ value: 'trip.end', label: '行程日期(结束)' })

    dependsSelect.value = 'trip.start'
    dependsSelect.dispatchEvent(new Event('change'))
    await flushUi()
    // Ground-truth: a <select> silently coerces `.value` to '' if no matching <option> exists (the
    // same false-positive trap the "(j) invalidate-record-link-deps" test above documents) —
    // reading it back confirms the option genuinely exists, not merely that assignment threw no error.
    expect(dependsSelect.value).toBe('trip.start')

    const operatorSelect = reasonRow().querySelector('[data-testid="approval-field-visibility-operator"]') as HTMLSelectElement
    operatorSelect.value = 'notEmpty'
    operatorSelect.dispatchEvent(new Event('change'))
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()
    expect(updateTemplateSpy).toHaveBeenCalledTimes(1)
    const payload = updateTemplateSpy.mock.calls[0]?.[1] as any
    // Load-bearing: the dotted address the option construction produced survived selection AND
    // buildFormSchema's serialization into the real update payload — proof across the whole chain,
    // not just that two <option> elements rendered (source-text/markup assertions are not behavior).
    expect(payload.formSchema.fields[1].visibilityRule).toEqual({ fieldId: 'trip.start', operator: 'notEmpty' })
  })

  // OD-L8-5(c) [accepted residual]: unlike visibility rules (MS-8, endpoints admitted above), graph
  // condition rules (MS-9) exclude date_range ENTIRELY in this slice — `validateConditionEdits`
  // (conditionEdit.ts) rejects any condition rule referencing one, so offering it in the picker
  // would be an M7 inert control (always selectable, never publishable). The number-field leg is a
  // mandatory positive control: without it, an accidentally-emptied options list would also pass.
  it('OD-L8-5(c): the condition rule field picker excludes date_range entirely while a sibling number field remains selectable', async () => {
    routeParams = { id: 'tpl_1' }
    getTemplateSpy.mockResolvedValue(buildTemplate({
      formSchema: {
        fields: [
          { id: 'amount', type: 'number', label: '金额' },
          { id: 'trip', type: 'date_range', label: '行程日期', props: { dateType: 'date', startLabel: '开始', endLabel: '结束' } },
        ],
      } as any,
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: '发起', config: {} },
          { key: 'cond_1', type: 'condition', name: '判断', config: { branches: [{ edgeKey: 'e-a', rules: [{ fieldId: 'amount', operator: 'gte', value: 100 }] }], defaultEdgeKey: 'e-b' } },
          { key: 'app_a', type: 'approval', name: 'A', config: { assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
          { key: 'end', type: 'end', name: '结束', config: {} },
        ],
        edges: [
          { key: 'e-start-c', source: 'start', target: 'cond_1' },
          { key: 'e-a', source: 'cond_1', target: 'app_a' },
          { key: 'e-b', source: 'cond_1', target: 'end' },
          { key: 'e-a-end', source: 'app_a', target: 'end' },
        ],
      },
    }))
    await mountView()
    await flushUi()

    const fieldSelect = container!.querySelector('[data-testid="approval-condition-rule-field"]') as HTMLSelectElement
    expect(fieldSelect).not.toBeNull()
    const optionValues = Array.from(fieldSelect.options).map((o) => o.value)
    // Positive control FIRST — proves the options list is non-trivial, not accidentally emptied.
    expect(optionValues).toContain('amount')
    expect(optionValues).not.toContain('trip')
  })

  // Lock-8 L8-B: date_range needs a REVERSE-direction stale-dependency sweep record-link/detail
  // never needed — nothing could validly have depended on a record-link/detail field (the picker
  // always excluded them), but a date_range field's endpoints ARE validly selectable while it IS
  // date_range, so retyping AWAY can orphan a dotted `${id}.start`/`.end` dependency mid-session.
  it('retyping a date_range field AWAY clears a dependent visibility rule pointing at its dotted endpoint (reverse-direction stale sweep)', async () => {
    routeParams = { id: 'tpl_1' }
    getTemplateSpy.mockResolvedValue(buildTemplate({
      formSchema: {
        fields: [
          { id: 'trip', type: 'date_range', label: '行程日期', props: { dateType: 'date', startLabel: '开始', endLabel: '结束' } },
          { id: 'reason', type: 'text', label: '事由', visibilityRule: { fieldId: 'trip.start', operator: 'notEmpty' } },
        ],
      } as any,
    }))
    await mountView()
    await flushUi()

    const rows = () => container!.querySelectorAll('[data-testid="approval-template-field-row"]')
    const tripRow = rows()[0] as HTMLElement
    const reasonRow = () => rows()[1] as HTMLElement
    // Sanity: the dotted dependency hydrated correctly before the retype (the operator select only
    // renders when `field.visibility.dependsOnFieldId` is truthy).
    const operatorSelect = () => reasonRow().querySelector('[data-testid="approval-field-visibility-operator"]')
    expect(operatorSelect()).not.toBeNull()

    const typeSelect = tripRow.querySelector('[data-testid="approval-field-type"]') as HTMLSelectElement
    typeSelect.value = 'text'
    typeSelect.dispatchEvent(new Event('change'))
    await flushUi()

    // Ground-truth signal (same trap as the "(j)" test documents): the operator select's v-if is
    // the proof, not the depends <select>'s own `.value` getter, which silently coerces to '' once
    // the matching <option> disappears regardless of whether the reactive string was actually cleared.
    expect(operatorSelect()).toBeNull()
  })
  })

describe('L8-C: formatted-number authoring (docs/development/approval-lock8-field-vocabulary-20260817.md §1.3, OD-L8-6)', () => {
  it('fieldDraftFromField hydrates the three display keys from props, typed and default-safe', () => {
    const withProps = buildTemplate({
      formSchema: {
        fields: [
          {
            id: 'amount', type: 'number', label: '金额',
            props: { min: 0, currencySymbol: '¥', thousandsSeparator: true, uppercaseCny: true },
          },
        ],
      } as any,
    })
    const draft = draftFromTemplate(withProps).fields[0]
    expect(draft.numberCurrencySymbol).toBe('¥')
    expect(draft.numberThousandsSeparator).toBe(true)
    expect(draft.numberUppercaseCny).toBe(true)

    // Absent props -> unset defaults, not thrown.
    const plain = buildTemplate({
      formSchema: { fields: [{ id: 'amount', type: 'number', label: '金额' }] } as any,
    })
    const plainDraft = draftFromTemplate(plain).fields[0]
    expect(plainDraft.numberCurrencySymbol).toBe('')
    expect(plainDraft.numberThousandsSeparator).toBe(false)
    expect(plainDraft.numberUppercaseCny).toBe(false)

    // Malformed stored value (wrong type — pre-publish-gate legacy data) hydrates to the unset
    // default rather than being coerced to truthy.
    const malformed = buildTemplate({
      formSchema: {
        fields: [{ id: 'amount', type: 'number', label: '金额', props: { uppercaseCny: 'true' } }],
      } as any,
    })
    expect(draftFromTemplate(malformed).fields[0].numberUppercaseCny).toBe(false)
  })

  it('buildFormSchema emits the three display keys alongside preserved min/precision (unauthorable keys pass through unchanged, §0.4)', () => {
    const template = buildTemplate({
      formSchema: {
        fields: [{ id: 'amount', type: 'number', label: '金额', props: { min: 0, precision: 2 } }],
      } as any,
    })
    const draft = draftFromTemplate(template)
    draft.fields[0].numberCurrencySymbol = '¥'
    draft.fields[0].numberThousandsSeparator = true
    draft.fields[0].numberUppercaseCny = true
    const schema = buildFormSchema(draft)
    expect(schema.fields[0].props).toEqual({
      min: 0, precision: 2, currencySymbol: '¥', thousandsSeparator: true, uppercaseCny: true,
    })
  })

  it('buildFormSchema is editor-authoritative for the three display keys: clearing them drops the keys, never resurrected from `original`', () => {
    const template = buildTemplate({
      formSchema: {
        fields: [{
          id: 'amount', type: 'number', label: '金额',
          props: { currencySymbol: '¥', thousandsSeparator: true, uppercaseCny: true },
        }],
      } as any,
    })
    const draft = draftFromTemplate(template)
    draft.fields[0].numberCurrencySymbol = ''
    draft.fields[0].numberThousandsSeparator = false
    draft.fields[0].numberUppercaseCny = false
    const schema = buildFormSchema(draft)
    expect(schema.fields[0].props).toBeUndefined()
  })

  it('retyping a number field AWAY drops the three L8-C display keys (no stale currencySymbol resurrected on a text field)', () => {
    const template = buildTemplate({
      formSchema: {
        fields: [{ id: 'amount', type: 'number', label: '金额', props: { currencySymbol: '¥', uppercaseCny: true } }],
      } as any,
    })
    const draft = draftFromTemplate(template)
    draft.fields[0].type = 'text'
    const schema = buildFormSchema(draft)
    expect(schema.fields[0].props).toBeUndefined()
  })

  it('a detail column carrying the shipped derivedFrom shape (commonTemplatePresets subtotal) survives buildFormSchema untouched — L8-C authoring is top-level only', () => {
    const template = buildTemplate({
      formSchema: {
        fields: [{
          id: 'items', type: 'detail', label: '明细',
          columns: [
            { id: 'qty', type: 'number', label: '数量', props: { min: 1 } },
            { id: 'price', type: 'number', label: '单价', props: { min: 0 } },
            {
              id: 'subtotal', type: 'number', label: '小计',
              props: { min: 0, derivedFrom: { operandColumnIds: ['qty', 'price'], operation: 'product' } },
            },
          ],
        }],
      } as any,
    })
    const schema = buildFormSchema(draftFromTemplate(template))
    const detail = schema.fields.find((f: any) => f.id === 'items') as any
    expect(detail.columns.find((c: any) => c.id === 'subtotal').props).toEqual({
      min: 0, derivedFrom: { operandColumnIds: ['qty', 'price'], operation: 'product' },
    })
  })

  it('gate C-1: a template carrying all L8-C display props stays EDITABLE — paired with the positive control (an unauthorable field type still locks the template read-only, §2.2)', () => {
    // `unsupportedTemplateAuthoringReason` is the single production gate that decides whole-
    // template read-only (§2.2, :718-722) — TemplateAuthoringView.vue's `readOnly`/`!canSave`
    // both derive from it, and it is the only live authoring surface (ApprovalFormFieldInspector.vue
    // / Designer 2.0 is unmounted in production — see this PR's description).
    const propped = unsupportedTemplateAuthoringReason(buildTemplate({
      formSchema: {
        fields: [{
          id: 'amount', type: 'number', label: '金额',
          props: { min: 0, precision: 2, currencySymbol: '¥', thousandsSeparator: true, uppercaseCny: true },
        }],
      } as any,
    }))
    expect(propped).toBeNull()

    // Positive control (Lock-5 A-3's shape, reused per this file's own precedent at :398-408):
    // an UNAUTHORABLE field type on the SAME kind of template DOES lock it read-only — proving
    // "stays editable" above is guard-selected, not vacuous because no guard exists on this path.
    const unauthorable = unsupportedTemplateAuthoringReason(buildTemplate({
      formSchema: {
        fields: [
          {
            id: 'amount', type: 'number', label: '金额',
            props: { min: 0, precision: 2, currencySymbol: '¥', thousandsSeparator: true, uppercaseCny: true },
          },
          { id: 'file', type: 'attachment', label: '附件' },
        ],
      } as any,
    }))
    expect(unauthorable).not.toBeNull()
  })
})
