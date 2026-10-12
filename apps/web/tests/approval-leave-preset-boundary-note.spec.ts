/* eslint-disable vue/one-component-per-file, vue/require-default-prop */
import { reactive } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, inject, nextTick, provide, ref, type App as VueApp, type InjectionKey } from 'vue'
import { ElMessage } from 'element-plus'
import TemplateAuthoringView from '../src/views/approval/TemplateAuthoringView.vue'
import type { ApprovalTemplateDetailDTO } from '../src/types/approval'
import {
  buildCommonApprovalTemplatePresetPayload,
  COMMON_APPROVAL_TEMPLATE_PRESETS,
  LEAVE_PRESET_BOUNDARY_NOTE,
  LEAVE_PRESET_BOUNDARY_NOTE_EN,
  PRESET_CREATED_MESSAGE,
  PRESET_CREATED_MESSAGE_EN,
  presetBoundaryNote,
  presetCreatedMessage,
} from '../src/approvals/commonTemplatePresets'

// A1 「提示与实际状态」 (Codex review reply 20261008 §二.6) - the central 请假审批 preset is an approval RECORD
// only: it does not write attendance and does not deduct leave balances. The note must appear where an admin picks
// the preset and when the draft is created, while the payload the preset creates stays byte-identical.
//
// "hint" tests are RED on the base commit (no note exists there); "pin" tests are GREEN on base and prove the
// payload did not move.

const CJK = /[㐀-鿿]/
const TASK_ZH_NOTE = '仅审批记录,不写入考勤、不扣假期余额'

// ---------------------------------------------------------------------------------------------------------
// harness (the same seams approvalTemplateAuthoring.spec.ts uses for this view)
// ---------------------------------------------------------------------------------------------------------

const pushSpy = vi.fn().mockResolvedValue(undefined)
const replaceSpy = vi.fn().mockResolvedValue(undefined)
const routeMock = reactive({ params: {} as Record<string, string>, query: {}, path: '/approval-templates/new' })

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: pushSpy, replace: replaceSpy, back: vi.fn() }),
    useRoute: () => routeMock,
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
    features: { value: { approvalCanvasV2: false } },
  }),
}))

const createTemplateSpy = vi.fn()
vi.mock('../src/approvals/api', () => ({
  ApprovalApiError: class ApprovalApiError extends Error {
    status: number
    code?: string
    details?: Record<string, unknown>
    constructor(message: string, status = 0, code?: string, details?: Record<string, unknown>) {
      super(message)
      this.name = 'ApprovalApiError'
      this.status = status
      this.code = code
      this.details = details
    }
  },
  createTemplate: (payload: unknown) => createTemplateSpy(payload),
  updateTemplate: vi.fn(),
  publishTemplate: vi.fn(),
  getTemplate: vi.fn(),
  dryRunApprovalConditionFormula: vi.fn().mockResolvedValue({ success: true, result: true }),
  listTemplateCategories: vi.fn().mockResolvedValue([]),
}))

vi.mock('../src/multitable/api/client', () => ({
  multitableClient: {
    listBases: vi.fn().mockResolvedValue([]),
    listSheets: vi.fn().mockResolvedValue([]),
  },
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
    return () => h('div', { 'data-testid': (attrs as any)?.['data-testid'], role: 'radiogroup' }, slots.default?.())
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

// The table stubs matter: an unregistered <el-table-column> would call its `#default="{ row }"` slot with
// undefined props the moment a draft with a detail field is rendered. These render no slot content.
const ElTable = defineComponent({
  name: 'ElTable',
  props: { data: Array },
  render() {
    return h('div', { 'data-testid': (this.$attrs as any)?.['data-testid'] }, this.$slots.default?.())
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

function installStubs(target: VueApp<Element>) {
  target.directive('loading', {})
  target.component('ElButton', ElButton)
  target.component('ElInput', ElInput)
  target.component('ElInputNumber', ElInputNumber)
  target.component('ElSelect', ElSelect)
  target.component('ElOption', ElOption)
  target.component('ElCheckbox', ElCheckbox)
  target.component('ElRadioGroup', ElRadioGroup)
  target.component('ElRadio', ElRadio)
  target.component('ElAlert', ElAlert)
  target.component('ElDialog', ElDialog)
  target.component('ElTable', ElTable)
  target.component('ElTableColumn', ElTableColumn)
  target.component('ElCard', passthrough('ElCard', 'section'))
  target.component('ElForm', passthrough('ElForm', 'form'))
  target.component('ElFormItem', passthrough('ElFormItem', 'label'))
  target.component('ElIcon', passthrough('ElIcon', 'span'))
  target.component('ElCollapse', passthrough('ElCollapse'))
  target.component('ElCollapseItem', passthrough('ElCollapseItem'))
}

function buildTemplate(overrides: Partial<ApprovalTemplateDetailDTO> = {}): ApprovalTemplateDetailDTO {
  return {
    id: 'tpl_created',
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
          config: { assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error' },
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
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')

async function flushUi() {
  for (let i = 0; i < 8; i += 1) {
    await nextTick()
    await Promise.resolve()
  }
}

async function mountView() {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(TemplateAuthoringView)
  installStubs(app)
  app.mount(container)
  await flushUi()
}

const testId = (id: string) => `[data-testid="${id}"]`

// ---------------------------------------------------------------------------------------------------------
// pure: the copy module + the "payload did not move" pins
// ---------------------------------------------------------------------------------------------------------

describe('请假审批 preset boundary note (pure)', () => {
  it('the zh note is exactly the wording requested for this slice', () => {
    expect(LEAVE_PRESET_BOUNDARY_NOTE).toBe(TASK_ZH_NOTE)
    expect(presetBoundaryNote('leave')).toBe(TASK_ZH_NOTE)
    expect(presetBoundaryNote('leave', true)).toBe(TASK_ZH_NOTE)
  })

  it('has an English counterpart with no CJK, reachable through isZh = false', () => {
    expect(presetBoundaryNote('leave', false)).toBe(LEAVE_PRESET_BOUNDARY_NOTE_EN)
    expect(CJK.test(LEAVE_PRESET_BOUNDARY_NOTE_EN)).toBe(false)
    expect(LEAVE_PRESET_BOUNDARY_NOTE_EN).toContain('does not write attendance records')
    expect(LEAVE_PRESET_BOUNDARY_NOTE_EN).toContain('deduct leave balances')
    expect(CJK.test(LEAVE_PRESET_BOUNDARY_NOTE)).toBe(true)
  })

  it('only the leave preset carries a note', () => {
    for (const preset of COMMON_APPROVAL_TEMPLATE_PRESETS) {
      if (preset.id === 'leave') continue
      expect(presetBoundaryNote(preset.id)).toBeNull()
      expect(presetBoundaryNote(preset.id, false)).toBeNull()
    }
  })

  it('the creation message: every non-leave preset keeps the exact text it always had; leave appends the note', () => {
    expect(PRESET_CREATED_MESSAGE).toBe('表单草稿已创建')
    for (const preset of COMMON_APPROVAL_TEMPLATE_PRESETS) {
      if (preset.id === 'leave') continue
      expect(presetCreatedMessage(preset.id)).toBe('表单草稿已创建')
      expect(presetCreatedMessage(preset.id, false)).toBe(PRESET_CREATED_MESSAGE_EN)
    }
    expect(presetCreatedMessage('leave')).toBe(`表单草稿已创建。${TASK_ZH_NOTE}。`)
    expect(presetCreatedMessage('leave', false)).toBe(`Form draft created. ${LEAVE_PRESET_BOUNDARY_NOTE_EN}.`)
  })

  it('PIN: the payload the leave preset creates did not move - no note is written into the customer template', () => {
    const payload = buildCommonApprovalTemplatePresetPayload('leave', { keySuffix: 'pin' })
    expect(payload.key).toBe('leave-approval-pin')
    expect(payload.name).toBe('请假审批')
    expect(payload.description).toBe('常用请假审批草稿。发布前请按组织规则调整审批人。')
    expect(payload.category).toBe('请假')
    expect(payload.visibilityScope).toEqual({ type: 'all', ids: [] })
    expect(payload.slaHours).toBeNull()
    expect(payload.formSchema.fields.map((field) => `${field.id}:${field.type}`)).toEqual([
      'leave_type:select',
      'start_date:date',
      'end_date:date',
      'leave_days:number',
      'reason:textarea',
      'handover_user:user',
    ])
    expect(payload.approvalGraph.nodes.map((node) => `${node.key}:${node.name}`)).toEqual([
      'start:发起',
      'approval_1:直属上级审批',
      'approval_2:部门主管审批',
      'end:结束',
    ])
    const json = JSON.stringify(payload)
    expect(json).not.toContain('不写入考勤')
    expect(json).not.toContain('仅审批记录')
    expect(json).not.toContain('attendance')
  })

  it('PIN: the picker card text (title/description) of the leave preset did not move either', () => {
    const leave = COMMON_APPROVAL_TEMPLATE_PRESETS.find((preset) => preset.id === 'leave')!
    expect(leave.title).toBe('请假审批')
    expect(leave.description).toBe('请假类型、起止日期、天数、事由与工作交接人。')
    expect(Object.keys(leave).sort()).toEqual(['category', 'description', 'id', 'title'])
  })
})

// ---------------------------------------------------------------------------------------------------------
// mounted: TemplateAuthoringView
// ---------------------------------------------------------------------------------------------------------

describe('TemplateAuthoringView preset library (mounted)', () => {
  beforeEach(() => {
    routeMock.params = {}
    routeMock.path = '/approval-templates/new'
    canManageTemplates.value = true
    createTemplateSpy.mockReset()
    createTemplateSpy.mockImplementation(async (payload: any) => ({
      ...buildTemplate(),
      key: payload.key,
      name: payload.name,
      description: payload.description,
      formSchema: payload.formSchema,
      approvalGraph: payload.approvalGraph,
    }))
    replaceSpy.mockClear()
    vi.mocked(ElMessage.success).mockClear()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
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

  it('selection: the 请假审批 card shows the boundary note, and no other card does', async () => {
    await mountView()
    const library = container!.querySelector(testId('approval-template-preset-library'))!
    expect(library).toBeTruthy()
    const note = library.querySelector(testId('approval-template-preset-leave-boundary-note'))
    expect(note?.textContent?.trim()).toBe(TASK_ZH_NOTE)
    // the note sits on the leave card itself, next to its own title and button
    const card = note!.closest('.template-authoring__preset')!
    expect(card.textContent).toContain('请假审批')
    expect(card.querySelector(testId('approval-template-preset-leave'))).toBeTruthy()
    // exactly one note on the whole library
    expect(library.querySelectorAll('[data-testid$="-boundary-note"]').length).toBe(1)
    for (const preset of COMMON_APPROVAL_TEMPLATE_PRESETS) {
      if (preset.id === 'leave') continue
      expect(library.querySelector(testId(`approval-template-preset-${preset.id}-boundary-note`))).toBeNull()
    }
  })

  it('selection: the preset buttons themselves are unchanged (same ids, same label, enabled)', async () => {
    await mountView()
    for (const preset of COMMON_APPROVAL_TEMPLATE_PRESETS) {
      const button = container!.querySelector<HTMLButtonElement>(testId(`approval-template-preset-${preset.id}`))!
      expect(button, preset.id).toBeTruthy()
      expect(button.textContent?.trim()).toBe('使用表单')
      expect(button.disabled).toBe(false)
    }
  })

  it('creation: creating from 请假审批 sends the unchanged payload and says the boundary note in the success message', async () => {
    await mountView()
    container!.querySelector<HTMLButtonElement>(testId('approval-template-preset-leave'))!.click()
    await flushUi()

    expect(createTemplateSpy).toHaveBeenCalledTimes(1)
    const sent = createTemplateSpy.mock.calls[0][0]
    const expected = buildCommonApprovalTemplatePresetPayload('leave', { keySuffix: 'x' })
    expect(sent.key).toMatch(/^leave-approval-/)
    expect({ ...sent, key: 'k' }).toEqual({ ...expected, key: 'k' })
    expect(JSON.stringify(sent)).not.toContain('不写入考勤')

    expect(ElMessage.success).toHaveBeenCalledTimes(1)
    const arg = vi.mocked(ElMessage.success).mock.calls[0][0] as unknown as { message: string; duration: number; showClose: boolean }
    expect(arg.message).toBe(`表单草稿已创建。${TASK_ZH_NOTE}。`)
    expect(arg.duration).toBeGreaterThanOrEqual(8000) // long enough to be read
    expect(arg.showClose).toBe(true)
  })

  it('creation: creating from any other preset still shows exactly the original success text', async () => {
    await mountView()
    container!.querySelector<HTMLButtonElement>(testId('approval-template-preset-reimbursement'))!.click()
    await flushUi()
    expect(createTemplateSpy).toHaveBeenCalledTimes(1)
    expect(ElMessage.success).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ElMessage.success).mock.calls[0]).toEqual(['表单草稿已创建'])
  })

  it('the library is not offered (so no note either) to someone who cannot manage templates', async () => {
    canManageTemplates.value = false
    await mountView()
    expect(container!.querySelector(testId('approval-template-preset-library'))).toBeNull()
    expect(container!.textContent).not.toContain('不写入考勤')
  })
})
