import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import TemplateAuthoringView from '../src/views/approval/TemplateAuthoringView.vue'
import type { ApprovalTemplateDetailDTO } from '../src/types/approval'
import {
  buildApprovalGraph,
  buildCreateTemplatePayload,
  draftFromTemplate,
} from '../src/approvals/templateAuthoring'

// --- router / permissions / api / element-plus mocks (mirror approvalTemplateAuthoring.spec.ts) ---
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

// Mock the directory composable so the picker renders without any network.
const searchUsersSpy = vi.fn().mockResolvedValue(undefined)
const loadRolesSpy = vi.fn().mockResolvedValue(undefined)
const ensureUserOptionVisibleSpy = vi.fn()
const ensureRoleOptionVisibleSpy = vi.fn()
const directoryUsers = ref<{ id: string; name: string; email: string }[]>([])
const directoryRoles = ref<{ id: string; name: string }[]>([])
vi.mock('../src/approvals/useApprovalDirectory', () => ({
  useApprovalDirectory: () => ({
    users: directoryUsers,
    roles: directoryRoles,
    usersLoading: ref(false),
    rolesLoading: ref(false),
    statusMessage: ref(''),
    searchUsers: searchUsersSpy,
    loadRoles: loadRolesSpy,
    ensureUserOptionVisible: ensureUserOptionVisibleSpy,
    ensureRoleOptionVisible: ensureRoleOptionVisibleSpy,
    formatUserLabel: (u: { id: string; name: string }) => u.name || u.id,
    formatRoleLabel: (r: { id: string; name: string }) => r.name || r.id,
  }),
}))

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  ElMessageBox: { confirm: vi.fn().mockResolvedValue(undefined) },
}))

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

// Single-value select (sourceKind, approvalMode, ...) and multi-value picker share one stub.
// For `multiple`, render <select multiple>; on change collect selected option values into an
// array and emit update:modelValue. For single, behave like the base spec's stub.
const ElSelect = defineComponent({
  name: 'ElSelect',
  props: {
    modelValue: { type: [String, Array], default: '' },
    disabled: Boolean,
    multiple: Boolean,
    filterable: Boolean,
    remote: Boolean,
    loading: Boolean,
    remoteMethod: { type: Function, default: undefined },
    placeholder: String,
  },
  emits: ['update:modelValue', 'change', 'visible-change'],
  render() {
    const selected = this.modelValue
    return h('select', {
      multiple: this.multiple,
      disabled: this.disabled,
      'data-testid': (this.$attrs as any)?.['data-testid'],
      onChange: (event: Event) => {
        const el = event.target as HTMLSelectElement
        if (this.multiple) {
          const values = Array.from(el.selectedOptions).map((o) => o.value)
          this.$emit('update:modelValue', values)
        } else {
          this.$emit('update:modelValue', el.value)
          this.$emit('change', el.value)
        }
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

const passthrough = (name: string, tag = 'div') => defineComponent({
  name,
  render() {
    return h(tag, { 'data-testid': (this.$attrs as any)?.['data-testid'] }, this.$slots.default?.())
  },
})

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

function installStubs(app: VueApp<Element>) {
  app.directive('loading', {})
  app.component('ElButton', ElButton)
  app.component('ElInput', ElInput)
  app.component('ElSelect', ElSelect)
  app.component('ElOption', ElOption)
  app.component('ElAlert', ElAlert)
  app.component('ElCheckbox', passthrough('ElCheckbox', 'label'))
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
    formSchema: { fields: [{ id: 'amount', type: 'number', label: '金额', required: true }] },
    approvalGraph: {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          name: '审批人 1',
          config: {
            assigneeSources: [{ kind: 'static_user', userIds: ['legacy-user-1'] }],
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

function stepRow() {
  return container!.querySelector('[data-testid="approval-template-step-row"]') as HTMLElement
}

function pick(testId: string): HTMLElement | null {
  return stepRow().querySelector(`[data-testid="${testId}"]`)
}

describe('TemplateAuthoringView static assignee picker', () => {
  beforeEach(() => {
    routeParams = {}
    canManageTemplates.value = true
    createTemplateSpy.mockReset()
    updateTemplateSpy.mockReset()
    getTemplateSpy.mockReset()
    pushSpy.mockClear()
    replaceSpy.mockClear()
    searchUsersSpy.mockClear()
    loadRolesSpy.mockClear()
    ensureUserOptionVisibleSpy.mockClear()
    ensureRoleOptionVisibleSpy.mockClear()
    directoryUsers.value = []
    directoryRoles.value = []
    createTemplateSpy.mockImplementation(async (payload) => ({
      ...buildTemplate({ id: 'tpl_created' }),
      key: payload.key,
      name: payload.name,
      formSchema: payload.formSchema,
      approvalGraph: payload.approvalGraph,
    }))
    updateTemplateSpy.mockImplementation(async (id, payload) => ({ ...buildTemplate({ id }), ...payload }))
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
  })

  it('loads roles on mount', async () => {
    await mountView()
    expect(loadRolesSpy).toHaveBeenCalledTimes(1)
  })

  it('renders the user picker for static_user, hides it for requester / form_field_user', async () => {
    await mountView()
    // default new-template step sourceKind is `requester` -> no picker.
    expect(pick('approval-step-user-picker')).toBeNull()
    expect(pick('approval-step-role-picker')).toBeNull()

    // switch to static_user.
    const sourceSelect = stepRow().querySelector('select') as HTMLSelectElement
    sourceSelect.value = 'static_user'
    sourceSelect.dispatchEvent(new Event('change'))
    await flushUi()

    expect(pick('approval-step-user-picker')).not.toBeNull()
    expect(pick('approval-step-role-picker')).toBeNull()
    // free-text fallback stays available.
    expect(pick('approval-step-ids-text')).not.toBeNull()
  })

  it('renders the role picker for static_role', async () => {
    await mountView()
    const sourceSelect = stepRow().querySelector('select') as HTMLSelectElement
    sourceSelect.value = 'static_role'
    sourceSelect.dispatchEvent(new Event('change'))
    await flushUi()

    expect(pick('approval-step-role-picker')).not.toBeNull()
    expect(pick('approval-step-user-picker')).toBeNull()
    expect(pick('approval-step-ids-text')).not.toBeNull()
  })

  it('selecting users writes a comma-joined string into the SAME idsText carrier and flows through sourceFromStep', async () => {
    directoryUsers.value = [
      { id: 'u1', name: 'Alice', email: 'a@x.io' },
      { id: 'u2', name: 'Bob', email: 'b@x.io' },
    ]
    await mountView()
    setTopInput('approval-template-key', 'leave')
    setTopInput('approval-template-name', '请假审批')

    setInputValueOnSelect('static_user') // switch sourceKind
    await flushUi()

    const picker = pick('approval-step-user-picker') as HTMLSelectElement
    // select both options (multiple).
    for (const opt of Array.from(picker.options)) {
      if (opt.value === 'u1' || opt.value === 'u2') opt.selected = true
    }
    picker.dispatchEvent(new Event('change'))
    await flushUi()

    // the free-text carrier now shows the comma-joined ids.
    const idsText = pick('approval-step-ids-text') as HTMLInputElement
    expect(idsText.value).toBe('u1, u2')

    // save -> create payload built through the UNCHANGED serialization path.
    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()

    expect(createTemplateSpy).toHaveBeenCalledTimes(1)
    const payload = createTemplateSpy.mock.calls[0]?.[0] as any
    expect(payload.approvalGraph.nodes[1].config.assigneeSources).toEqual([
      { kind: 'static_user', userIds: ['u1', 'u2'] },
    ])
  })

  it('free-text input remains editable as a fallback and feeds the same carrier', async () => {
    await mountView()
    setTopInput('approval-template-key', 'leave')
    setTopInput('approval-template-name', '请假审批')
    setInputValueOnSelect('static_user')
    await flushUi()

    const idsText = pick('approval-step-ids-text') as HTMLInputElement
    idsText.value = 'manual-a, manual-b'
    idsText.dispatchEvent(new Event('input'))
    await flushUi()

    ;(container!.querySelector('[data-testid="approval-template-save-button"]') as HTMLButtonElement).click()
    await flushUi()

    const payload = createTemplateSpy.mock.calls[0]?.[0] as any
    expect(payload.approvalGraph.nodes[1].config.assigneeSources).toEqual([
      { kind: 'static_user', userIds: ['manual-a', 'manual-b'] },
    ])
  })

  it('hydrating an existing static_user template calls ensureUserOptionVisible for each stored id', async () => {
    routeParams = { id: 'tpl_1' }
    getTemplateSpy.mockResolvedValue(buildTemplate()) // step assignee = static_user ['legacy-user-1']
    await mountView()
    await flushUi()

    expect(ensureUserOptionVisibleSpy).toHaveBeenCalledWith('legacy-user-1')
    // the free-text carrier hydrated with the stored id.
    expect((pick('approval-step-ids-text') as HTMLInputElement).value).toBe('legacy-user-1')
  })

  // KEYSTONE: no silent drop of an unknown / pre-existing id, exercised through the REAL
  // templateAuthoring serialization (not a hand-built array, not the mocked composable).
  it('keystone: an unknown id absent from the directory survives the real parse->source->payload wire', () => {
    const template = buildTemplate({
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: '发起', config: {} },
          {
            key: 'approval_1',
            type: 'approval',
            name: '审批人 1',
            config: {
              assigneeSources: [{ kind: 'static_user', userIds: ['known-u1', 'ghost-id-not-in-directory'] }],
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
    })
    const draft = draftFromTemplate(template)
    // real wire: idsText -> parseIdsText -> sourceFromStep -> buildApprovalGraph
    const graph = buildApprovalGraph(draft)
    expect((graph.nodes[1].config as any).assigneeSources).toEqual([
      { kind: 'static_user', userIds: ['known-u1', 'ghost-id-not-in-directory'] },
    ])
    // and through the full create payload builder.
    const payload = buildCreateTemplatePayload(draft)
    expect((payload.approvalGraph.nodes[1].config as any).assigneeSources[0].userIds).toContain('ghost-id-not-in-directory')
  })
})

// Helper: switch the step sourceKind select (first <select> in the step row) to a value.
function setInputValueOnSelect(value: string) {
  const sourceSelect = stepRow().querySelector('select') as HTMLSelectElement
  sourceSelect.value = value
  sourceSelect.dispatchEvent(new Event('change'))
}

// Helper: set a top-level text input (key / name) by testid.
function setTopInput(testId: string, value: string) {
  const input = container!.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input'))
}
