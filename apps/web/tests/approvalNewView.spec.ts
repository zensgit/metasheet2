import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import type { FormField, FormSchema } from '../src/types/approval'
import { mockPendingApproval, mockPublishedTemplate } from './helpers/approval-test-fixtures'

// ---------------------------------------------------------------------------
// ApprovalNewView — focused coverage for two UX-audit fixes:
//
//   - B2-02: `el-input-number` actually receives the schema field's declared `props`
//     (min/max/step/precision) instead of silently ignoring them.
//   - B2-28: an `attachment` field renders an honest disabled placeholder (stopgap until
//     the real upload pipeline lands) instead of a fake `el-upload` that silently drops the
//     File on submit; a `required` attachment must never block submission, and its key must
//     never reach the create-approval payload.
//
// General render/submit/visibility-rule coverage for this view already lives in
// approval-e2e-permissions.spec.ts / approval-e2e-lifecycle.spec.ts — this file only exercises
// the two behaviors above, mounted with the same real-view + stubbed-Element-Plus pattern used
// by approvalMobileDetailActions.spec.ts.
// ---------------------------------------------------------------------------

const pushSpy = vi.fn().mockResolvedValue(undefined)
const backSpy = vi.fn()

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: pushSpy, back: backSpy }),
    useRoute: () => ({
      params: { templateId: 'tpl_numfields' },
      query: {},
      path: '/approvals/new/tpl_numfields',
      meta: {},
    }),
  }
})

vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({ canWrite: { value: true } }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getCurrentUser: () => ({ id: 'user_1' }),
    getCurrentUserId: vi.fn().mockResolvedValue('user_1'),
  }),
}))

const mockActiveTemplate = ref<any>(null)
const loadTemplateSpy = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/approvals/templateStore', () => ({
  useApprovalTemplateStore: () => ({
    get activeTemplate() { return mockActiveTemplate.value },
    get loading() { return false },
    get error() { return null },
    set error(_v: unknown) { /* noop */ },
    loadTemplate: loadTemplateSpy,
  }),
}))

const submitApprovalSpy = vi.fn()

vi.mock('../src/approvals/store', () => ({
  useApprovalStore: () => ({
    get loading() { return false },
    get error() { return null },
    set error(_v: unknown) { /* noop */ },
    submitApproval: submitApprovalSpy,
  }),
}))

// ---------------------------------------------------------------------------
// Element Plus stubs
// ---------------------------------------------------------------------------
function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === ''
    || (Array.isArray(value) && value.length === 0)
}

// A minimal but REAL rule-checking ElForm stub. `validate()` actually inspects the `:model`/`:rules`
// props the view computed, instead of always resolving — a stub that always resolves would make "a
// required attachment does not block submit" true for free, which would prove nothing about whether
// `formRules` actually excludes attachment fields. Only understands `{ required: true }` entries,
// which is all this view's `formRules` ever emits.
const ElForm = defineComponent({
  name: 'ElForm',
  props: { model: Object, rules: Object, labelPosition: String },
  setup(props, { expose, slots }) {
    function validate(): Promise<boolean> {
      const rules = (props.rules ?? {}) as Record<string, Array<{ required?: boolean }>>
      const model = (props.model ?? {}) as Record<string, unknown>
      const hasFailure = Object.entries(rules).some(([fieldId, ruleList]) =>
        ruleList.some((rule) => rule.required && isEmptyValue(model[fieldId])),
      )
      return hasFailure ? Promise.reject(new Error('validation failed')) : Promise.resolve(true)
    }
    expose({ validate })
    return () => h('form', { 'data-el-form': 'true' }, slots.default?.())
  },
})

const ElFormItem = defineComponent({
  name: 'ElFormItem',
  props: { label: String, prop: String, required: Boolean },
  render() {
    return h(
      'div',
      { 'data-el-form-item': this.prop || this.label, 'data-required': String(!!this.required) },
      [h('label', this.label), this.$slots.default?.()],
    )
  },
})

const ElInput = defineComponent({
  name: 'ElInput',
  props: { modelValue: [String, Number], placeholder: String, type: String, rows: Number },
  emits: ['update:modelValue'],
  render() {
    return h('input', {
      'data-el-input': 'true',
      value: this.modelValue ?? '',
      onInput: (e: Event) => this.$emit('update:modelValue', (e.target as HTMLInputElement).value),
    })
  },
})

// Deliberately declares ONLY the props the real component's callers here rely on (mirrors the
// existing e2e-suite stub) — min/max/step/precision are therefore NOT declared props, so they fall
// through as plain HTML attrs onto the rendered <input>. That fallthrough IS the B2-02 assertion.
const ElInputNumber = defineComponent({
  name: 'ElInputNumber',
  props: { modelValue: Number, placeholder: String, disabled: Boolean, controls: Boolean },
  emits: ['update:modelValue'],
  render() { return h('input', { 'data-el-input-number': 'true', type: 'number' }) },
})

const ElSelect = defineComponent({
  name: 'ElSelect',
  props: { modelValue: [String, Array], placeholder: String, multiple: Boolean, filterable: Boolean },
  emits: ['update:modelValue', 'change'],
  render() { return h('select', { 'data-el-select': 'true' }, this.$slots.default?.()) },
})
const ElOption = defineComponent({
  name: 'ElOption',
  props: { label: String, value: String },
  render() { return h('option', { value: this.value }, this.label) },
})
const ElDatePicker = defineComponent({
  name: 'ElDatePicker',
  props: { modelValue: [String, Date], type: String, placeholder: String },
  emits: ['update:modelValue'],
  render() { return h('input', { 'data-el-date-picker': 'true', type: 'date' }) },
})
const ElButton = defineComponent({
  name: 'ElButton',
  props: { type: String, text: Boolean, link: Boolean, plain: Boolean, loading: Boolean, disabled: Boolean },
  emits: ['click'],
  render() {
    return h('button', {
      type: 'button',
      disabled: this.disabled || false,
      onClick: (e: Event) => this.$emit('click', e),
    }, this.$slots.default?.())
  },
})
const ElIcon = defineComponent({
  name: 'ElIcon',
  render() { return h('span', { class: 'el-icon' }, this.$slots.default?.()) },
})
const ElAlert = defineComponent({
  name: 'ElAlert',
  props: { title: String, type: String, showIcon: Boolean, closable: Boolean },
  render() { return h('div', { 'data-el-alert': this.type }, [this.title, this.$slots.default?.()]) },
})
const ElEmpty = defineComponent({
  name: 'ElEmpty',
  props: { description: String },
  render() { return h('div', { 'data-el-empty': 'true' }, this.description) },
})
const ElDivider = defineComponent({
  name: 'ElDivider',
  render() { return h('hr', { 'data-el-divider': 'true' }) },
})
const ElCard = defineComponent({
  name: 'ElCard',
  props: { shadow: String },
  render() {
    return h('div', { class: 'el-card' }, [
      this.$slots.header ? h('div', { class: 'el-card__header' }, this.$slots.header()) : null,
      h('div', { class: 'el-card__body' }, this.$slots.default?.()),
    ])
  },
})
const ElTag = defineComponent({
  name: 'ElTag',
  props: { type: String, size: String },
  render() { return h('span', { 'data-el-tag': this.type }, this.$slots.default?.()) },
})
const ElTable = defineComponent({
  name: 'ElTable',
  props: { data: Array },
  render() { return h('div', { 'data-el-table': 'true' }, this.$slots.default?.()) },
})
const ElTableColumn = defineComponent({
  name: 'ElTableColumn',
  props: { prop: String, label: String, width: [String, Number], align: String },
  render() { return h('div', { 'data-column': this.prop || this.label }) },
})
// Regression tripwire: if a future edit reintroduces el-upload, it renders through THIS stub, so
// the "no el-upload" assertion below can actually catch it (rather than vacuously passing because
// the tag is unresolved).
const ElUpload = defineComponent({
  name: 'ElUpload',
  props: { action: String, autoUpload: Boolean, drag: Boolean },
  render() { return h('div', { 'data-el-upload': 'true' }, this.$slots.default?.()) },
})

const stubDirective = { mounted() {}, updated() {} }

async function flushUi(cycles = 5): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function formSchemaWithNumberPropsAndAttachment(): FormSchema {
  return {
    fields: [
      { id: 'reason', type: 'text', label: '事由', required: true, defaultValue: '出差申请' } as FormField,
      {
        id: 'leave_days',
        type: 'number',
        label: '请假天数',
        required: true,
        defaultValue: 1,
        props: { min: 0.5, step: 0.5 },
      } as FormField,
      { id: 'proof', type: 'attachment', label: '证明材料', required: true } as FormField,
    ],
  }
}

describe('ApprovalNewView — B2-02 number field props + B2-28 honest attachment disable', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mockActiveTemplate.value = mockPublishedTemplate({
      id: 'tpl_numfields',
      formSchema: formSchemaWithNumberPropsAndAttachment(),
    })
    submitApprovalSpy.mockReset()
    submitApprovalSpy.mockResolvedValue(mockPendingApproval({ id: 'apv_numfields_1' }))
    loadTemplateSpy.mockClear()
    pushSpy.mockClear()
    backSpy.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  async function mountView() {
    const { default: ApprovalNewView } = await import('../src/views/approval/ApprovalNewView.vue')
    const Host = defineComponent({ setup: () => () => h(ApprovalNewView as any) })
    app = createApp(Host)
    app.component('ElAlert', ElAlert)
    app.component('ElButton', ElButton)
    app.component('ElCard', ElCard)
    app.component('ElDatePicker', ElDatePicker)
    app.component('ElDivider', ElDivider)
    app.component('ElEmpty', ElEmpty)
    app.component('ElForm', ElForm)
    app.component('ElFormItem', ElFormItem)
    app.component('ElIcon', ElIcon)
    app.component('ElInput', ElInput)
    app.component('ElInputNumber', ElInputNumber)
    app.component('ElOption', ElOption)
    app.component('ElSelect', ElSelect)
    app.component('ElTable', ElTable)
    app.component('ElTableColumn', ElTableColumn)
    app.component('ElTag', ElTag)
    app.component('ElUpload', ElUpload)
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
  }

  function submitButton(): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('提交审批'))
    expect(btn).toBeTruthy()
    return btn as HTMLButtonElement
  }

  // -------------------------------------------------------------------------
  // B2-02
  // -------------------------------------------------------------------------
  it('spreads field.props (min/step) onto the top-level el-input-number', async () => {
    await mountView()
    const input = container!.querySelector('[data-el-input-number]') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.getAttribute('min')).toBe('0.5')
    expect(input.getAttribute('step')).toBe('0.5')
  })

  // -------------------------------------------------------------------------
  // B2-28
  // -------------------------------------------------------------------------
  it('renders the disabled placeholder for an attachment field — no el-upload', async () => {
    await mountView()

    const disabled = container!.querySelector('[data-testid="approval-attachment-disabled"]')
    expect(disabled).toBeTruthy()
    expect(disabled?.textContent).toContain('附件上传功能即将支持')

    expect(container!.querySelector('[data-el-upload]')).toBeNull()

    // Label + required marker stay visible even though validation is excluded (next test).
    const formItem = container!.querySelector('[data-el-form-item="proof"]')
    expect(formItem?.querySelector('label')?.textContent).toBe('证明材料')
    expect(formItem?.getAttribute('data-required')).toBe('true')
  })

  it('a required attachment does not block submit when other required fields are satisfied', async () => {
    await mountView()
    submitButton().click()
    await flushUi()

    expect(submitApprovalSpy).toHaveBeenCalledTimes(1)
  })

  it('submitting posts formData WITHOUT the attachment key', async () => {
    await mountView()
    submitButton().click()
    await flushUi()

    expect(submitApprovalSpy).toHaveBeenCalledTimes(1)
    const payload = submitApprovalSpy.mock.calls[0][0]
    expect(payload.formData).not.toHaveProperty('proof')
    // Positive control — the non-attachment fields DID make it through, so the missing key isn't
    // just an artifact of an empty/failed payload.
    expect(payload.formData).toMatchObject({ reason: '出差申请', leave_days: 1 })
  })
})
