import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { formSchemaSignature } from '../src/approvals/formDraft'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import type { ApprovalGraph, FormField, FormSchema } from '../src/types/approval'
import { mockPendingApproval, mockPublishedTemplate } from './helpers/approval-test-fixtures'

// ---------------------------------------------------------------------------
// ApprovalNewView — focused coverage for UX-audit fixes:
//
//   - B2-02: `el-input-number` actually receives the schema field's declared `props`
//     (min/max/step/precision) instead of silently ignoring them.
//   - B2-28: an `attachment` field renders an honest disabled placeholder (stopgap until
//     the real upload pipeline lands) instead of a fake `el-upload` that silently drops the
//     File on submit; a `required` attachment must never block submission, and its key must
//     never reach the create-approval payload.
//   - B2-07: a read-only submit-time flow preview ("审批流程") derived from the loaded
//     template's approvalGraph.
//   - B2-15: validation depth — required rules trigger on blur+change, and a `detail` row
//     missing a required cell aborts submit with a readable message instead of an unreadable
//     backend 400.
//   - B2-13: 再次提交 prefill — a `?fromInstance=<id>` query param loads that (rejected/revoked/
//     cancelled) source instance and prefills `formData` via `prefillFromSnapshot`, showing a
//     subtle notice; absent the query, behavior is unchanged.
//
// General render/submit/visibility-rule coverage for this view already lives in
// approval-e2e-permissions.spec.ts / approval-e2e-lifecycle.spec.ts — this file only exercises
// the behaviors above, mounted with the same real-view + stubbed-Element-Plus pattern used
// by approvalMobileDetailActions.spec.ts.
// ---------------------------------------------------------------------------

const pushSpy = vi.fn().mockResolvedValue(undefined)
const backSpy = vi.fn()

// B2-15 — `ApprovalNewView.vue`'s only 'element-plus' VALUE import is `ElMessage` (the sibling
// `FormInstance`/`FormRules` import is `import type`, erased at compile time, so mocking the
// module doesn't touch it). Spied so the validation-depth tests can assert on the shown message
// instead of depending on real Element Plus DOM/timer behavior under jsdom (mirrors the existing
// `vi.mock('element-plus', ...)` pattern already used by approvalTemplateAuthoring.spec.ts /
// approvalDelegationView.spec.ts).
const messageWarningSpy = vi.fn()
const messageSuccessSpy = vi.fn()
const messageErrorSpy = vi.fn()
vi.mock('element-plus', () => ({
  ElMessage: {
    success: (...args: unknown[]) => messageSuccessSpy(...args),
    warning: (...args: unknown[]) => messageWarningSpy(...args),
    error: (...args: unknown[]) => messageErrorSpy(...args),
  },
}))

// B2-13 — mutable so the resubmit-prefill suite can set `fromInstance` per-test; every
// PRE-EXISTING test in this file never touches `routeQuery`, so it stays `{}` for them exactly as
// the previous hardcoded literal was.
let routeQuery: Record<string, string> = {}

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: pushSpy, back: backSpy }),
    useRoute: () => ({
      params: { templateId: 'tpl_numfields' },
      query: routeQuery,
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

// B3-04 D-2 — ApprovalUserPicker (the fill-form `user` field renderer, see the describe block
// further below) fetches its options through `searchApprovalDirectoryUsers`. `vi.importActual`
// keeps every other export (dispatchAction, createApproval, ...) real; this suite's OTHER tests
// never render a `user`-type field so this mock is inert for them.
const searchApprovalDirectoryUsersSpy = vi.fn().mockResolvedValue([])
// B2-13 — the resubmit-prefill suite mocks the source-instance fetch; every other describe block
// in this file never sets `?fromInstance=`, so `applyResubmitPrefill` short-circuits before ever
// calling this, leaving it unused (and unconfigured) for them.
const getApprovalSpy = vi.fn()
vi.mock('../src/approvals/api', async () => {
  const actual = await vi.importActual<typeof import('../src/approvals/api')>('../src/approvals/api')
  return {
    ...actual,
    searchApprovalDirectoryUsers: (...args: unknown[]) => searchApprovalDirectoryUsersSpy(...args),
    getApproval: (...args: unknown[]) => getApprovalSpy(...args),
  }
})

// B3-07 — mutable so the flag-ON attachment-uploader suite can enable the feature per-test; every
// PRE-EXISTING test never touches it, so the default `false` keeps the B2-28 placeholder path
// byte-identical for them (they double as the flag-OFF control).
let approvalAttachmentsFlag = false
vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    features: {
      get value() {
        return {
          attendance: false,
          workflow: false,
          attendanceAdmin: false,
          attendanceImport: false,
          plm: false,
          approvalMobile: false,
          approvalAttachments: approvalAttachmentsFlag,
          mode: 'platform',
        }
      },
    },
  }),
}))

// B3-07 — the upload client is spied (network-free); preValidateAttachments stays REAL so the
// client-mirror reject path is the actual predicate, not a stub.
const uploadApprovalAttachmentSpy = vi.fn()
// §4.3: removal now goes through the SERVER delete, so the spec drives that transport too — a
// client-only removal would leave the staged row + blob live, which is the whole point of the call.
const deleteApprovalAttachmentSpy = vi.fn().mockResolvedValue(undefined)
const fetchApprovalAttachmentRefsSpy = vi.fn().mockResolvedValue([])
// Atomic multi-file helper: reimplemented against the spies so a later failure compensates
// earlier successes (mirrors the real uploadApprovalAttachmentsAtomic contract).
const uploadApprovalAttachmentsAtomicSpy = vi.fn(async (files: File[], templateId: string, fieldId: string) => {
  const uploaded: Array<{ id: string; sizeBytes: number }> = []
  try {
    for (const file of files) {
      uploaded.push(await uploadApprovalAttachmentSpy(file, templateId, fieldId))
    }
    return uploaded
  } catch (error) {
    for (const item of [...uploaded].reverse()) {
      await deleteApprovalAttachmentSpy(item.id).catch(() => {})
    }
    throw error
  }
})
vi.mock('../src/approvals/attachmentUpload', async () => {
  const actual = await vi.importActual<typeof import('../src/approvals/attachmentUpload')>('../src/approvals/attachmentUpload')
  return {
    ...actual,
    uploadApprovalAttachment: (...args: unknown[]) => uploadApprovalAttachmentSpy(...args),
    deleteApprovalAttachment: (...args: unknown[]) => deleteApprovalAttachmentSpy(...args),
    fetchApprovalAttachmentRefs: (...args: unknown[]) => fetchApprovalAttachmentRefsSpy(...args),
    uploadApprovalAttachmentsAtomic: (...args: unknown[]) => uploadApprovalAttachmentsAtomicSpy(...(args as [File[], string, string])),
  }
})

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

// B2-15 — captured on every render so the validation-depth tests can inspect the ACTUAL `rules`
// object the view computed (in particular each rule's `trigger`), without the view exposing
// `formRules` itself (it's local to `<script setup>`). Reset in each suite's `beforeEach`.
type CapturedFormRule = { required?: boolean; message?: string; trigger?: string | string[] }
let capturedFormRules: Record<string, CapturedFormRule[]> | undefined

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
    return () => {
      capturedFormRules = props.rules as Record<string, CapturedFormRule[]> | undefined
      return h('form', { 'data-el-form': 'true' }, slots.default?.())
    }
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
  // NOTE: renders the `title` SLOT as well as the `title` prop — real ElAlert does, and the
  // draft-restore alert puts its 恢复/丢弃 buttons in `<template #title>`. A stub that dropped the
  // slot silently hid those affordances from every test that tried to click them.
  render() { return h('div', { 'data-el-alert': this.type }, [this.$slots.title?.(), this.title, this.$slots.default?.()]) },
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

  // -------------------------------------------------------------------------
  // B3-04 D-2 — the fill-form `user` field now uses the real ApprovalUserPicker (participant
  // directory), replacing the hardcoded 张三/李四/王五 fake option list — a production correctness
  // defect, since those ids were never real users.
  // -------------------------------------------------------------------------
  it('static tripwire: the view source no longer contains the hardcoded fake-people literals', () => {
    const src = readFileSync(join(__dirname, '../src/views/approval/ApprovalNewView.vue'), 'utf8')
    for (const fakeName of ['张三', '李四', '王五', '赵六']) {
      expect(src, `should not contain fake fixture name "${fakeName}"`).not.toContain(fakeName)
    }
  })

  it('renders the real ApprovalUserPicker for a `user`-type form field', async () => {
    mockActiveTemplate.value = mockPublishedTemplate({
      id: 'tpl_userfield',
      formSchema: {
        fields: [{ id: 'fld_assignee', type: 'user', label: '经办人', required: false } as FormField],
      },
    })
    searchApprovalDirectoryUsersSpy.mockResolvedValue([{ id: 'u1', name: 'Alice', email: '' }])

    await mountView()

    expect(container!.querySelector('[data-testid="approval-user-picker"]')).toBeTruthy()
  })

  // -------------------------------------------------------------------------
  // B3-07 (#4195/#4342) — flag ON: the real uploader replaces the B2-28 placeholder; the submit
  // payload carries the uploaded id ARRAY (the §4.4 bind contract). Flag OFF stays proven by every
  // pre-existing test above (approvalAttachmentsFlag defaults false).
  // -------------------------------------------------------------------------
  describe('B3-07 flag-ON attachment uploader', () => {
    beforeEach(() => {
      approvalAttachmentsFlag = true
      uploadApprovalAttachmentSpy.mockReset()
      deleteApprovalAttachmentSpy.mockReset()
      deleteApprovalAttachmentSpy.mockResolvedValue(undefined)
      uploadApprovalAttachmentsAtomicSpy.mockClear()
      fetchApprovalAttachmentRefsSpy.mockReset()
      fetchApprovalAttachmentRefsSpy.mockResolvedValue([])
      messageWarningSpy.mockReset()
      messageErrorSpy.mockReset()
      window.localStorage.clear() // no draft residue between restore tests
    })

    afterEach(() => {
      approvalAttachmentsFlag = false
      window.localStorage.clear()
    })

    function attachmentInput(): HTMLInputElement {
      const input = container!.querySelector('[data-testid="approval-attachment-input-proof"]') as HTMLInputElement
      expect(input).toBeTruthy()
      return input
    }

    async function pickFile(file: File): Promise<void> {
      const input = attachmentInput()
      Object.defineProperty(input, 'files', { value: [file], configurable: true })
      input.dispatchEvent(new Event('change'))
      await flushUi()
    }

    it('replaces the disabled placeholder with the uploader control', async () => {
      await mountView()
      expect(container!.querySelector('[data-testid="approval-attachment-upload"]')).toBeTruthy()
      expect(container!.querySelector('[data-testid="approval-attachment-disabled"]')).toBeNull()
    })

    it('a picked file uploads through the client and the submit payload carries the id array', async () => {
      uploadApprovalAttachmentSpy.mockResolvedValue({ id: 'att_up_1', sizeBytes: 8 })
      await mountView()
      await pickFile(new File(['%PDF-1.4'], 'evidence.pdf', { type: 'application/pdf' }))

      expect(uploadApprovalAttachmentSpy).toHaveBeenCalledTimes(1)
      const [file, templateId, fieldId] = uploadApprovalAttachmentSpy.mock.calls[0]
      expect((file as File).name).toBe('evidence.pdf')
      expect(templateId).toBe('tpl_numfields')
      expect(fieldId).toBe('proof')
      expect(container!.textContent).toContain('evidence.pdf') // rendered in the uploaded list

      submitButton().click()
      await flushUi()
      expect(submitApprovalSpy).toHaveBeenCalledTimes(1)
      const payload = submitApprovalSpy.mock.calls[0][0]
      expect(payload.formData.proof).toEqual(['att_up_1']) // the id ARRAY — never a raw File
    })

    it('multi-file atomic refuse: later server failure compensates the selection — zero live/bindable refs from the failed pick', async () => {
      uploadApprovalAttachmentSpy
        .mockResolvedValueOnce({ id: 'att_ok_1', sizeBytes: 4 })
        .mockRejectedValueOnce(new Error('attachment rejected: infected'))
      deleteApprovalAttachmentSpy.mockResolvedValue(undefined)
      await mountView()
      const input = attachmentInput()
      Object.defineProperty(input, 'files', {
        value: [
          new File(['%PDF-1.4'], 'ok.pdf', { type: 'application/pdf' }),
          new File(['%PDF-1.4'], 'bad.pdf', { type: 'application/pdf' }),
        ],
        configurable: true,
      })
      input.dispatchEvent(new Event('change'))
      await flushUi()
      await flushUi()

      expect(uploadApprovalAttachmentSpy).toHaveBeenCalledTimes(2)
      // Compensated via DELETE (row soft-delete + durable purge intent; blob reclamation eventual).
      expect(deleteApprovalAttachmentSpy).toHaveBeenCalledWith('att_ok_1')
      expect(container!.textContent).not.toContain('ok.pdf')
      expect(messageErrorSpy.mock.calls.length + messageWarningSpy.mock.calls.length).toBeGreaterThan(0)
      submitButton().click()
      await flushUi()
      expect(submitApprovalSpy).toHaveBeenCalledTimes(1)
      const payload = submitApprovalSpy.mock.calls[0][0]
      // zero live/bindable refs from the failed pick — not a claim about physical blob deletion
      expect(payload.formData.proof ?? []).toEqual([])
    })

    it('client mirror rejects a disallowed type BEFORE any upload — values-free code surfaced', async () => {
      await mountView()
      await pickFile(new File(['MZ'], 'x.exe', { type: 'application/x-msdownload' }))

      expect(uploadApprovalAttachmentSpy).not.toHaveBeenCalled()
      expect(messageErrorSpy).toHaveBeenCalledWith(expect.stringContaining('mime_not_allowed'))
      submitButton().click()
      await flushUi()
      const payload = submitApprovalSpy.mock.calls[0][0]
      expect(payload.formData).not.toHaveProperty('proof') // nothing staged, nothing submitted
    })

    it('removing an uploaded file drops its id from the submit payload', async () => {
      uploadApprovalAttachmentSpy.mockResolvedValue({ id: 'att_up_2', sizeBytes: 8 })
      await mountView()
      await pickFile(new File(['%PDF-1.4'], 'toremove.pdf', { type: 'application/pdf' }))
      const removeBtn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('移除'))
      expect(removeBtn).toBeTruthy()
      removeBtn!.click()
      await flushUi()

      // the SERVER delete is what reclaims the staged row + blob; a client-only drop is not a removal
      expect(deleteApprovalAttachmentSpy).toHaveBeenCalledWith('att_up_2')

      submitButton().click()
      await flushUi()
      const payload = submitApprovalSpy.mock.calls[0][0]
      expect(payload.formData.proof ?? []).toEqual([]) // removed before submit
    })

    // -----------------------------------------------------------------------
    // G13 / O2 — stale attachment-reference detection on DRAFT RESTORE. A draft can outlive the
    // 7-day unbound-retention GC, so a restore must check its staged ids and drop the swept ones
    // rather than carry a dangling id into a create the §4.4 bind would reject whole.
    // -----------------------------------------------------------------------
    function seedDraft(proofIds: string[]) {
      // the signature EXCLUDES attachment fields (formSchemaSignature) — derived from the REAL helper
      // so this stays correct if the fixture schema changes, instead of a hand-copied literal.
      const signature = formSchemaSignature(mockActiveTemplate.value.formSchema)
      window.localStorage.setItem(
        'approval-form-draft:user_1:tpl_numfields',
        JSON.stringify({ signature, savedAt: new Date().toISOString(), data: { proof: proofIds } }),
      )
    }

    it('restore drops GC-swept attachment refs, warns, and keeps the live ones (positive control)', async () => {
      seedDraft(['att_live', 'att_swept'])
      fetchApprovalAttachmentRefsSpy.mockResolvedValue([
        { id: 'att_live', stale: false, fileName: 'still-here.pdf' },
        { id: 'att_swept', stale: true },
      ])
      await mountView()
      const applyBtn = container!.querySelector('[data-testid="approval-draft-restore-apply"]') as HTMLElement | null
      expect(applyBtn).toBeTruthy() // the restore offer fired
      applyBtn!.click()
      await flushUi()

      // the stale-check was uploader-scoped (NO instanceId — a draft has no instance yet)
      expect(fetchApprovalAttachmentRefsSpy).toHaveBeenCalledWith(['att_live', 'att_swept'])
      expect(messageWarningSpy).toHaveBeenCalledWith(expect.stringContaining('过期'))
      // the live ref is restored (and rendered with the SERVER's filename, not the draft's memory)
      expect(container!.textContent).toContain('still-here.pdf')
      submitButton().click()
      await flushUi()
      const payload = submitApprovalSpy.mock.calls[0][0]
      expect(payload.formData.proof).toEqual(['att_live']) // the swept id is GONE, never submitted
    })

    it('restore FAILS CLOSED: when the stale-check errors, no unverified ref is carried forward', async () => {
      seedDraft(['att_unverifiable'])
      fetchApprovalAttachmentRefsSpy.mockRejectedValue(new Error('network down'))
      await mountView()
      const applyBtn = container!.querySelector('[data-testid="approval-draft-restore-apply"]') as HTMLElement
      applyBtn.click()
      await flushUi()

      submitButton().click()
      await flushUi()
      const payload = submitApprovalSpy.mock.calls[0][0]
      expect(payload.formData.proof ?? []).toEqual([]) // unverified ⇒ dropped, not submitted
    })

    it('a draft whose refs are ALL live restores them untouched and raises no stale warning', async () => {
      seedDraft(['att_a', 'att_b'])
      fetchApprovalAttachmentRefsSpy.mockResolvedValue([
        { id: 'att_a', stale: false, fileName: 'a.pdf' },
        { id: 'att_b', stale: false, fileName: 'b.pdf' },
      ])
      await mountView()
      ;(container!.querySelector('[data-testid="approval-draft-restore-apply"]') as HTMLElement).click()
      await flushUi()

      expect(messageWarningSpy).not.toHaveBeenCalled()
      submitButton().click()
      await flushUi()
      expect(submitApprovalSpy.mock.calls[0][0].formData.proof).toEqual(['att_a', 'att_b'])
    })

    it('a FAILED server delete keeps the file staged (never a UI-only removal the server disagrees with)', async () => {
      uploadApprovalAttachmentSpy.mockResolvedValue({ id: 'att_up_3', sizeBytes: 8 })
      deleteApprovalAttachmentSpy.mockRejectedValue(new Error('attachment delete failed: 503'))
      await mountView()
      await pickFile(new File(['%PDF-1.4'], 'keepme.pdf', { type: 'application/pdf' }))
      const removeBtn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('移除'))
      removeBtn!.click()
      await flushUi()

      expect(messageErrorSpy).toHaveBeenCalledWith(expect.stringContaining('移除失败'))
      expect(container!.textContent).toContain('keepme.pdf') // still listed — the user can retry
      submitButton().click()
      await flushUi()
      const payload = submitApprovalSpy.mock.calls[0][0]
      expect(payload.formData.proof).toEqual(['att_up_3']) // still staged, honestly
    })
  })
})

// ---------------------------------------------------------------------------
// UX B2-07 — submit-time flow preview ("审批流程"). Own describe block (own mount lifecycle) so
// it doesn't disturb the B2-02/B2-28/D-2 suite above; reuses the SAME module-scoped stub
// components (ElCard, ElForm, ...) and mocks already declared for this file.
// ---------------------------------------------------------------------------
describe('ApprovalNewView — B2-07 submit-time flow preview', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    submitApprovalSpy.mockReset()
    submitApprovalSpy.mockResolvedValue(mockPendingApproval({ id: 'apv_flowpreview_1' }))
    loadTemplateSpy.mockClear()
    pushSpy.mockClear()
    backSpy.mockClear()
    messageWarningSpy.mockClear()
    messageSuccessSpy.mockClear()
    messageErrorSpy.mockClear()
    capturedFormRules = undefined
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

  function flowPreview(): HTMLElement | null {
    return container!.querySelector('[data-testid="approval-flow-preview"]')
  }

  function flowPreviewSteps(): HTMLElement[] {
    return Array.from(container!.querySelectorAll('[data-testid="approval-flow-preview-step"]'))
  }

  it('renders 发起人 followed by each graph node in order, with its assignee summary', async () => {
    // mockPublishedTemplate()'s default approvalGraph: start -> approval_1 (指定角色 role_manager)
    // -> approval_2 (指定成员 user_finance) -> end — see approval-test-fixtures.ts.
    mockActiveTemplate.value = mockPublishedTemplate({ id: 'tpl_flow_linear' })
    await mountView()

    const preview = flowPreview()
    expect(preview).toBeTruthy()
    expect(preview?.textContent).toContain('审批流程')
    expect(preview?.textContent).toContain('发起人')

    const steps = flowPreviewSteps()
    expect(steps).toHaveLength(3)
    expect(steps[0].textContent).toContain('部门主管审批')
    expect(steps[0].textContent).toContain('指定角色：role_manager')
    expect(steps[1].textContent).toContain('财务审批')
    expect(steps[1].textContent).toContain('指定成员：user_finance')
    expect(steps[2].textContent).toContain('结束')
    expect(steps[2].textContent).toContain('流程结束')
  })

  it('a condition node ahead renders ONE honest "按条件进入后续分支" step — never a fabricated branch', async () => {
    const conditionalGraph: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'cond',
          type: 'condition',
          name: '金额分支',
          config: { branches: [{ edgeKey: 'e-high', rules: [] }], defaultEdgeKey: 'e-low' },
        },
        { key: 'high', type: 'approval', name: '高额审批', config: { assigneeSources: [{ kind: 'dept_head' }] } },
        { key: 'low', type: 'approval', name: '低额审批', config: { assigneeSources: [{ kind: 'requester' }] } },
      ],
      edges: [
        { key: 'e-s', source: 'start', target: 'cond' },
        { key: 'e-high', source: 'cond', target: 'high' },
        { key: 'e-low', source: 'cond', target: 'low' },
      ],
    }
    mockActiveTemplate.value = mockPublishedTemplate({ id: 'tpl_flow_cond', approvalGraph: conditionalGraph })
    await mountView()

    const steps = flowPreviewSteps()
    expect(steps).toHaveLength(1)
    expect(steps[0].textContent).toContain('金额分支')
    expect(steps[0].textContent).toContain('按条件进入后续分支')
    expect(steps[0].classList.toString()).toContain('approval-new__flow-preview-chip--conditional')

    // Neither branch is fabricated into the preview — only the condition node itself is shown.
    expect(flowPreview()?.textContent).not.toContain('高额审批')
    expect(flowPreview()?.textContent).not.toContain('低额审批')
  })

  it('a template without a usable graph (empty approvalGraph) renders nothing, no crash', async () => {
    const empty: ApprovalGraph = { nodes: [], edges: [] }
    mockActiveTemplate.value = mockPublishedTemplate({ id: 'tpl_flow_empty', approvalGraph: empty })
    await mountView()

    expect(flowPreview()).toBeNull()
    // Smoke check: the rest of the view still rendered fine (no crash from the empty-graph walk).
    expect(container!.querySelector('.approval-new__header h1')?.textContent).toBe('发起审批')
  })
})

// ---------------------------------------------------------------------------
// UX B2-15 — validation depth: required rules trigger on blur+change, a failed submit scrolls the
// first error into view (jsdom-guarded no-op), and a `detail` row missing a required cell aborts
// submit with a readable message instead of an unreadable backend 400. Own describe block (own
// mount lifecycle), same reasoning as the B2-07 block above.
// ---------------------------------------------------------------------------
describe('ApprovalNewView — B2-15 validation depth', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    submitApprovalSpy.mockReset()
    submitApprovalSpy.mockResolvedValue(mockPendingApproval({ id: 'apv_validation_1' }))
    loadTemplateSpy.mockClear()
    pushSpy.mockClear()
    backSpy.mockClear()
    messageWarningSpy.mockClear()
    messageSuccessSpy.mockClear()
    messageErrorSpy.mockClear()
    capturedFormRules = undefined
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

  function addRowButton(): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('添加一行'))
    expect(btn).toBeTruthy()
    return btn as HTMLButtonElement
  }

  // `items.defaultValue`, when present, seeds `formData.items` directly on mount (bypasses the
  // add-row button) — used to get a FULLY FILLED detail row without depending on the detail
  // table's per-row scoped-slot cell inputs, which this file's ElTableColumn stub does not render
  // (it only renders a placeholder per column definition — see ElTableColumn above). The
  // add-row button itself is a plain sibling `<el-button>`, NOT inside that scoped slot, so it
  // stays real/clickable regardless.
  function formSchemaWithRequiredDetailColumns(itemsDefaultValue?: unknown): FormSchema {
    return {
      fields: [
        { id: 'reason', type: 'text', label: '事由', required: true, defaultValue: '出差申请' } as FormField,
        {
          id: 'items',
          type: 'detail',
          label: '报销明细',
          columns: [
            { id: 'item_name', type: 'text', label: '项目', required: true },
            { id: 'amount_text', type: 'text', label: '金额说明', required: true },
          ],
          ...(itemsDefaultValue !== undefined ? { defaultValue: itemsDefaultValue } : {}),
        } as FormField,
      ],
    }
  }

  // -------------------------------------------------------------------------
  // item 1 — required rules trigger on blur AND change
  // -------------------------------------------------------------------------
  it('required rules carry trigger: ["blur", "change"] (B2-28 still excludes attachment entirely)', async () => {
    mockActiveTemplate.value = mockPublishedTemplate({
      id: 'tpl_trigger',
      formSchema: {
        fields: [
          { id: 'reason', type: 'text', label: '事由', required: true, defaultValue: '出差申请' } as FormField,
          { id: 'leave_days', type: 'number', label: '请假天数', required: true, defaultValue: 1 } as FormField,
          { id: 'proof', type: 'attachment', label: '证明材料', required: true } as FormField,
        ],
      },
    })
    await mountView()

    expect(capturedFormRules?.reason?.[0]?.trigger).toEqual(['blur', 'change'])
    expect(capturedFormRules?.leave_days?.[0]?.trigger).toEqual(['blur', 'change'])
    // B2-28: attachment stays excluded from `rules` entirely — never gets a trigger at all.
    expect(capturedFormRules?.proof).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // item 2 — failed submit does not crash under jsdom (scrollIntoView guarded no-op)
  // -------------------------------------------------------------------------
  it('a failed top-level validation shows the warning, does not submit, and does not throw (jsdom scrollIntoView guard)', async () => {
    mockActiveTemplate.value = mockPublishedTemplate({
      id: 'tpl_missing_reason',
      formSchema: {
        fields: [{ id: 'reason', type: 'text', label: '事由', required: true } as FormField], // no defaultValue -> empty
      },
    })
    await mountView()

    // No `.el-form-item.is-error` exists under this file's stubs (ElFormItem sets a
    // `data-el-form-item` attribute, not a real `.el-form-item` class), so `scrollFirstErrorIntoView`
    // exercises its "no element found" no-op branch here; jsdom's separate "element found but
    // `scrollIntoView` is not a function" gap is guarded by the same optional-chained call. Either
    // way, a throw inside the `catch` block would surface as a rejected/errored `handleSubmit` —
    // this test's real assertion is that neither happens: the flow completes, warns, and never calls
    // `submitApproval`.
    submitButton().click()
    await flushUi()

    expect(submitApprovalSpy).not.toHaveBeenCalled()
    expect(messageWarningSpy).toHaveBeenCalledWith('请检查表单中的必填项')
  })

  // -------------------------------------------------------------------------
  // item 3 — detail-row required-cell check
  // -------------------------------------------------------------------------
  it('a submit with a missing required detail cell aborts: warns, does not call store.submitApproval', async () => {
    mockActiveTemplate.value = mockPublishedTemplate({
      id: 'tpl_detail_missing',
      formSchema: formSchemaWithRequiredDetailColumns(),
    })
    await mountView()

    addRowButton().click()
    await flushUi()

    submitButton().click()
    await flushUi()

    expect(submitApprovalSpy).not.toHaveBeenCalled()
    expect(messageWarningSpy).toHaveBeenCalledWith('"报销明细" 第 1 行缺少 "项目"')
  })

  it('a valid submit (detail row fully filled) proceeds — does not clobber D-2/B2-28 submit path', async () => {
    mockActiveTemplate.value = mockPublishedTemplate({
      id: 'tpl_detail_filled',
      formSchema: formSchemaWithRequiredDetailColumns([{ item_name: '机票', amount_text: '合计 1000 元' }]),
    })
    await mountView()

    submitButton().click()
    await flushUi()

    expect(messageWarningSpy).not.toHaveBeenCalled()
    expect(submitApprovalSpy).toHaveBeenCalledTimes(1)
    const payload = submitApprovalSpy.mock.calls[0][0]
    expect(payload.formData.items).toEqual([{ item_name: '机票', amount_text: '合计 1000 元' }])
  })
})

// ---------------------------------------------------------------------------
// UX B2-13 — 再次提交 prefill. `?fromInstance=<id>` loads that source instance and prefills
// `formData` via `prefillFromSnapshot` (unit-tested in isolation in
// approval-prefill-from-snapshot.test.ts — this block only exercises the VIEW's wiring: does it
// call `getApproval` with the right id, does the merged value actually reach `formData`, does the
// notice show, and does an absent query / a failed fetch leave the fresh-form behavior unchanged).
// Own describe block (own mount lifecycle), same reasoning as the B2-07/B2-15 blocks above.
// ---------------------------------------------------------------------------
describe('ApprovalNewView — B2-13 再次提交 prefill', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    routeQuery = {}
    submitApprovalSpy.mockReset()
    submitApprovalSpy.mockResolvedValue(mockPendingApproval({ id: 'apv_resubmit_1' }))
    getApprovalSpy.mockReset()
    loadTemplateSpy.mockClear()
    pushSpy.mockClear()
    backSpy.mockClear()
    messageWarningSpy.mockClear()
    messageSuccessSpy.mockClear()
    messageErrorSpy.mockClear()
    capturedFormRules = undefined
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    routeQuery = {}
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

  function prefillNotice(): HTMLElement | null {
    return container!.querySelector('[data-testid="approval-prefill-notice"]')
  }

  function formSchemaRequiredReasonAndAmount(): FormSchema {
    return {
      fields: [
        { id: 'reason', type: 'text', label: '事由', required: true } as FormField,
        { id: 'amount', type: 'number', label: '金额', required: true } as FormField,
      ],
    }
  }

  it('loads the source instance, prefills formData, and shows the notice', async () => {
    routeQuery = { fromInstance: 'apv_source_1' }
    mockActiveTemplate.value = mockPublishedTemplate({
      id: 'tpl_resubmit',
      formSchema: formSchemaRequiredReasonAndAmount(),
    })
    getApprovalSpy.mockResolvedValue(
      mockPendingApproval({
        id: 'apv_source_1',
        status: 'rejected',
        formSnapshot: { reason: '出差报销（第一次）', amount: 3000 },
      }),
    )

    await mountView()

    expect(getApprovalSpy).toHaveBeenCalledWith('apv_source_1')
    expect(prefillNotice()).toBeTruthy()
    expect(prefillNotice()?.textContent).toContain('已从上一次申请预填')

    // Neither 'reason' nor 'amount' has a `defaultValue` in this schema — a successful submit
    // (required-field validation passing) is only possible if the prefill actually reached
    // `formData`, not just fetched-and-discarded.
    submitButton().click()
    await flushUi()

    expect(submitApprovalSpy).toHaveBeenCalledTimes(1)
    const payload = submitApprovalSpy.mock.calls[0][0]
    expect(payload.formData).toMatchObject({ reason: '出差报销（第一次）', amount: 3000 })
  })

  it('does not prefill when there is no `fromInstance` query — unchanged behavior', async () => {
    routeQuery = {}
    mockActiveTemplate.value = mockPublishedTemplate({
      id: 'tpl_resubmit_none',
      formSchema: formSchemaRequiredReasonAndAmount(),
    })

    await mountView()

    expect(getApprovalSpy).not.toHaveBeenCalled()
    expect(prefillNotice()).toBeNull()

    // Both required fields are still unset (no defaultValue, no prefill) — submit fails
    // client-side validation exactly as it did before this feature existed.
    submitButton().click()
    await flushUi()

    expect(submitApprovalSpy).not.toHaveBeenCalled()
    expect(messageWarningSpy).toHaveBeenCalledWith('请检查表单中的必填项')
  })

  it('a failed source-instance fetch silently skips prefill — the fresh form still works', async () => {
    routeQuery = { fromInstance: 'apv_missing' }
    mockActiveTemplate.value = mockPublishedTemplate({
      id: 'tpl_resubmit_fail',
      formSchema: { fields: [{ id: 'reason', type: 'text', label: '事由', required: false } as FormField] },
    })
    getApprovalSpy.mockRejectedValue(new Error('not found'))

    await mountView()

    expect(prefillNotice()).toBeNull()

    submitButton().click()
    await flushUi()

    expect(submitApprovalSpy).toHaveBeenCalledTimes(1)
  })

  it('a field dropped from the current template is skipped (view-level drift guard) — no crash', async () => {
    routeQuery = { fromInstance: 'apv_source_drift' }
    mockActiveTemplate.value = mockPublishedTemplate({
      id: 'tpl_resubmit_drift',
      formSchema: { fields: [{ id: 'reason', type: 'text', label: '事由', required: true } as FormField] },
    })
    getApprovalSpy.mockResolvedValue(
      mockPendingApproval({
        id: 'apv_source_drift',
        status: 'rejected',
        // 'legacy_field_removed' no longer exists on the current template.
        formSnapshot: { reason: '出差报销', legacy_field_removed: 'old value' },
      }),
    )

    await mountView()

    submitButton().click()
    await flushUi()

    expect(submitApprovalSpy).toHaveBeenCalledTimes(1)
    const payload = submitApprovalSpy.mock.calls[0][0]
    expect(payload.formData).toMatchObject({ reason: '出差报销' })
    expect(payload.formData).not.toHaveProperty('legacy_field_removed')
  })
})

// ---------------------------------------------------------------------------
// FWB-0 Layer 2 — record-link display labels keyed by field id (not recordId alone).
// Two fields can share a recordId across different pinned sheets with different labels.
// ---------------------------------------------------------------------------
const SHARED_RECORD_ID = 'rec_shared_001'
const RECORD_LINK_LABEL_A = '客户甲（A表）'
const RECORD_LINK_LABEL_B = '合同乙（B表）'

// Module mock so the SFC import is replaced (global app.component cannot override local import).
vi.mock('../src/approvals/components/ApprovalRecordLinkPicker.vue', () => ({
  default: defineComponent({
    name: 'ApprovalRecordLinkPicker',
    props: {
      visible: { type: Boolean, default: false },
      baseId: { type: String, default: '' },
      sheetId: { type: String, default: '' },
      currentRecordId: { type: [String, null], default: null },
    },
    emits: ['confirm', 'close'],
    setup(props, { emit }) {
      return () => (props.visible
        ? h('button', {
            type: 'button',
            'data-testid': 'stub-record-link-confirm',
            onClick: () => {
              const display = props.baseId === 'base_a' ? RECORD_LINK_LABEL_A : RECORD_LINK_LABEL_B
              emit('confirm', { recordId: SHARED_RECORD_ID, display })
            },
          }, 'stub-confirm')
        : null)
    },
  }),
}))

describe('ApprovalNewView — record-link labels are per-field (same recordId, distinct labels)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mockActiveTemplate.value = mockPublishedTemplate({
      id: 'tpl_numfields',
      formSchema: {
        fields: [
          {
            id: 'link_a',
            type: 'record-link',
            label: '关联客户',
            required: false,
            props: { baseId: 'base_a', sheetId: 'sheet_a' },
          } as FormField,
          {
            id: 'link_b',
            type: 'record-link',
            label: '关联合同',
            required: false,
            props: { baseId: 'base_b', sheetId: 'sheet_b' },
          } as FormField,
        ],
      },
    })
    submitApprovalSpy.mockReset()
    submitApprovalSpy.mockResolvedValue(mockPendingApproval({ id: 'apv_rl_1' }))
    loadTemplateSpy.mockClear()
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

  async function flushUi() {
    await nextTick()
    await nextTick()
  }

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

  it('keeps distinct human labels for two fields that share the same recordId', async () => {
    await mountView()

    const fields = Array.from(container!.querySelectorAll('[data-testid="approval-record-link-field"]'))
    expect(fields.length).toBe(2)
    expect(container!.querySelector('input[placeholder="请输入关联客户"]')).toBeNull()
    expect(container!.querySelector('input[placeholder="请输入关联合同"]')).toBeNull()

    // Pick for field A (first pick button).
    const pickButtons = Array.from(
      container!.querySelectorAll('[data-testid="approval-record-link-pick"]'),
    ) as HTMLButtonElement[]
    expect(pickButtons.length).toBe(2)

    pickButtons[0]!.click()
    await flushUi()
    const confirmA = container!.querySelector('[data-testid="stub-record-link-confirm"]') as HTMLButtonElement
    expect(confirmA).toBeTruthy()
    confirmA.click()
    await flushUi()

    // Pick for field B with the SAME recordId but a different human label.
    pickButtons[1]!.click()
    await flushUi()
    const confirmB = container!.querySelector('[data-testid="stub-record-link-confirm"]') as HTMLButtonElement
    expect(confirmB).toBeTruthy()
    confirmB.click()
    await flushUi()

    const displays = Array.from(
      container!.querySelectorAll('[data-testid="approval-record-link-display"]'),
    ) as HTMLInputElement[]
    expect(displays.length).toBe(2)

    // Each field keeps its own label — second pick must NOT overwrite the first.
    expect(displays[0]!.value).toBe(RECORD_LINK_LABEL_A)
    expect(displays[1]!.value).toBe(RECORD_LINK_LABEL_B)

    // No raw shared record id on either display (oracle surface).
    expect(displays[0]!.value).not.toContain(SHARED_RECORD_ID)
    expect(displays[1]!.value).not.toContain(SHARED_RECORD_ID)
    expect(container!.textContent ?? '').not.toContain(SHARED_RECORD_ID)
  })

  it('clears the per-field label when the selection is cleared', async () => {
    await mountView()
    const pickButtons = Array.from(
      container!.querySelectorAll('[data-testid="approval-record-link-pick"]'),
    ) as HTMLButtonElement[]
    pickButtons[0]!.click()
    await flushUi()
    ;(container!.querySelector('[data-testid="stub-record-link-confirm"]') as HTMLButtonElement).click()
    await flushUi()

    const displaysBefore = Array.from(
      container!.querySelectorAll('[data-testid="approval-record-link-display"]'),
    ) as HTMLInputElement[]
    expect(displaysBefore[0]!.value).toBe(RECORD_LINK_LABEL_A)

    const clearBtn = container!.querySelector('[data-testid="approval-record-link-clear"]') as HTMLButtonElement
    expect(clearBtn).toBeTruthy()
    clearBtn.click()
    await flushUi()

    const displaysAfter = Array.from(
      container!.querySelectorAll('[data-testid="approval-record-link-display"]'),
    ) as HTMLInputElement[]
    expect(displaysAfter[0]!.value).toBe('')
    expect(displaysAfter[0]!.value).not.toContain(SHARED_RECORD_ID)
    expect(displaysAfter[0]!.value).not.toContain(RECORD_LINK_LABEL_A)
  })
})
