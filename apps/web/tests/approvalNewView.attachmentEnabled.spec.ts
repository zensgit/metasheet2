/**
 * ApprovalNewView attachment uploader — flag-ON path (upload/remove/required).
 * Flag-OFF honest-disable remains covered by approvalNewView.spec.ts (B2-28).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'

vi.mock('../src/approvals/attachmentUpload', async () => {
  const actual = await vi.importActual<typeof import('../src/approvals/attachmentUpload')>('../src/approvals/attachmentUpload')
  return {
    ...actual,
    isApprovalAttachmentsEnabled: () => true,
    uploadApprovalAttachment: vi.fn(async (file: File) => ({
      id: 'att_uploaded_1',
      sizeBytes: file.size,
      fileName: file.name,
    })),
    deleteApprovalAttachment: vi.fn(async () => undefined),
  }
})

const submitApprovalSpy = vi.fn()
const loadTemplateSpy = vi.fn()
const mockActiveTemplate = ref<unknown>(null)

vi.mock('../src/approvals/store', () => ({
  useApprovalStore: () => ({
    get loading() { return false },
    get error() { return null },
    set error(_v: unknown) { /* noop */ },
    submitApproval: submitApprovalSpy,
  }),
}))

vi.mock('../src/approvals/templateStore', () => ({
  useApprovalTemplateStore: () => ({
    get activeTemplate() { return mockActiveTemplate.value },
    get loading() { return false },
    get error() { return null },
    set error(_v: unknown) { /* noop */ },
    loadTemplate: loadTemplateSpy,
  }),
}))

vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({ canWrite: { value: true } }),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { templateId: 'tpl_att' }, query: {}, path: '/approvals/new/tpl_att', meta: {} }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getCurrentUser: () => ({ id: 'u1' }),
    getCurrentUserId: vi.fn().mockResolvedValue('u1'),
  }),
}))

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))

// Minimal element stubs
const stub = (name: string, props: string[] = []) =>
  defineComponent({
    name,
    props,
    setup(_, { slots }) {
      return () => h('div', { [`data-el-${name.replace(/^El/, '').toLowerCase()}`]: true }, slots.default?.())
    },
  })

const ElForm = defineComponent({
  name: 'ElForm',
  setup(_, { slots, expose }) {
    expose({ validate: async () => true })
    return () => h('form', slots.default?.())
  },
})
const ElFormItem = defineComponent({
  name: 'ElFormItem',
  props: ['label', 'prop', 'required'],
  setup(props, { slots }) {
    return () =>
      h('div', { 'data-el-form-item': props.prop, 'data-required': String(!!props.required) }, [
        h('label', props.label),
        slots.default?.(),
      ])
  },
})
const ElButton = defineComponent({
  name: 'ElButton',
  props: ['disabled', 'type', 'loading'],
  emits: ['click'],
  setup(props, { slots, emit }) {
    return () =>
      h(
        'button',
        {
          disabled: props.disabled || props.loading,
          onClick: () => emit('click'),
        },
        slots.default?.(),
      )
  },
})
const ElInput = defineComponent({
  name: 'ElInput',
  props: ['modelValue'],
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () =>
      h('input', {
        value: props.modelValue,
        onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value),
      })
  },
})
const stubDirective = { mounted() {}, updated() {} }

async function flushUi() {
  await nextTick()
  await nextTick()
}

describe('ApprovalNewView — attachment uploader (flag ON)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mockActiveTemplate.value = {
      id: 'tpl_att',
      name: 'With attachment',
      status: 'published',
      formSchema: {
        fields: [
          { id: 'reason', type: 'text', label: '事由', required: true },
          { id: 'proof', type: 'attachment', label: '证明材料', required: true },
        ],
      },
      approvalGraph: { nodes: [{ key: 'start', type: 'start' }, { key: 'end', type: 'end' }], edges: [] },
    }
    submitApprovalSpy.mockReset()
    submitApprovalSpy.mockResolvedValue({ id: 'apv_1', status: 'pending' })
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
    const Host = defineComponent({ setup: () => () => h(ApprovalNewView as never) })
    app = createApp(Host)
    app.component('ElAlert', stub('ElAlert'))
    app.component('ElButton', ElButton)
    app.component('ElCard', stub('ElCard'))
    app.component('ElDatePicker', stub('ElDatePicker'))
    app.component('ElDivider', stub('ElDivider'))
    app.component('ElEmpty', stub('ElEmpty'))
    app.component('ElForm', ElForm)
    app.component('ElFormItem', ElFormItem)
    app.component('ElIcon', stub('ElIcon'))
    app.component('ElInput', ElInput)
    app.component('ElInputNumber', stub('ElInputNumber'))
    app.component('ElOption', stub('ElOption'))
    app.component('ElSelect', stub('ElSelect'))
    app.component('ElTable', stub('ElTable'))
    app.component('ElTableColumn', stub('ElTableColumn'))
    app.component('ElTag', stub('ElTag'))
    app.component('ElUpload', stub('ElUpload'))
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
  }

  it('renders the real uploader (not the disabled stopgap) when the flag is ON', async () => {
    await mountView()
    expect(container!.querySelector('[data-testid="approval-attachment-disabled"]')).toBeNull()
    expect(container!.querySelector('[data-testid="approval-attachment-uploader"]')).toBeTruthy()
    expect(container!.querySelector('[data-testid="approval-attachment-input"]')).toBeTruthy()
  })

  async function uploadOne(name = 'invoice.pdf') {
    const input = container!.querySelector('[data-testid="approval-attachment-input"]') as HTMLInputElement
    expect(input).toBeTruthy()
    const file = new File([new Uint8Array([37, 80, 68, 70])], name, { type: 'application/pdf' }) // %PDF
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    // async handler: upload + reactive assign
    for (let i = 0; i < 5; i++) {
      await flushUi()
      await new Promise((r) => setTimeout(r, 0))
      if (container!.querySelector('[data-testid="approval-attachment-item"]')) break
    }
  }

  it('upload stores only the server attachment id in form data on submit', async () => {
    const { uploadApprovalAttachment } = await import('../src/approvals/attachmentUpload')
    await mountView()
    await uploadOne('invoice.pdf')
    expect(uploadApprovalAttachment).toHaveBeenCalled()
    const item = container!.querySelector('[data-testid="approval-attachment-item"]')
    expect(item).toBeTruthy()
    expect(item!.textContent).toContain('invoice.pdf')

    // Fill required text and submit — find the reason text input (not the file input)
    const reasonInput = Array.from(container!.querySelectorAll('input')).find(
      (el) => el.getAttribute('type') !== 'file',
    ) as HTMLInputElement
    reasonInput.value = '出差'
    reasonInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    const btn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('提交审批'))
    btn?.click()
    await flushUi()
    await new Promise((r) => setTimeout(r, 0))
    await flushUi()
    expect(submitApprovalSpy).toHaveBeenCalled()
    const payload = submitApprovalSpy.mock.calls[0][0]
    expect(payload.formData.proof).toEqual(['att_uploaded_1'])
    // Never a File / storage key
    expect(JSON.stringify(payload.formData)).not.toMatch(/invoice\.pdf|storage_key|amazonaws/)
  })

  it('remove drops the id and calls unbound delete', async () => {
    const { deleteApprovalAttachment } = await import('../src/approvals/attachmentUpload')
    await mountView()
    await uploadOne('a.pdf')
    const removeBtn = container!.querySelector('[data-testid="approval-attachment-remove"]') as HTMLButtonElement
    expect(removeBtn).toBeTruthy()
    removeBtn.click()
    await flushUi()
    await new Promise((r) => setTimeout(r, 0))
    await flushUi()
    expect(deleteApprovalAttachment).toHaveBeenCalledWith('att_uploaded_1')
    expect(container!.querySelector('[data-testid="approval-attachment-item"]')).toBeNull()
  })

  it('static: flag-OFF disabled path still present in source for byte-equivalent stopgap', () => {
    const src = readFileSync(join(__dirname, '../src/views/approval/ApprovalNewView.vue'), 'utf8')
    expect(src).toContain('approval-attachment-disabled')
    expect(src).toContain('附件上传功能即将支持')
    expect(src).toContain('isApprovalAttachmentsEnabled')
  })
})
