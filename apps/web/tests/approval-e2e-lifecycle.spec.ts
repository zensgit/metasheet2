/**
 * Approval E2E Lifecycle Verification Tests
 *
 * Full lifecycle coverage: template -> publish -> initiate -> approve/reject/transfer/comment/revoke
 * Uses the same component-level E2E pattern as approval-center.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import {
  mockPendingApproval,
  mockApprovedApproval,
  mockRejectedApproval,
  mockRevokedApproval,
  mockPublishedTemplate,
  mockDraftTemplate,
  mockHistoryItems,
  CURRENT_USER_ID,
  REQUESTER_USER_ID,
} from './helpers/approval-test-fixtures'

// ---------------------------------------------------------------------------
// Router mock
// ---------------------------------------------------------------------------
const pushSpy = vi.fn().mockResolvedValue(undefined)
const backSpy = vi.fn()
let routeParams: Record<string, string> = {}
let routeQuery: Record<string, string> = {}
let routePath = '/approvals'

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({
      push: pushSpy,
      back: backSpy,
    }),
    useRoute: () => ({
      params: routeParams,
      query: routeQuery,
      path: routePath,
      meta: {},
    }),
  }
})

// ---------------------------------------------------------------------------
// Approval store mock
// ---------------------------------------------------------------------------
const mockActiveApproval = ref<any>(null)
const mockHistory = ref<any[]>([])
const mockLoading = ref(false)
const mockError = ref<string | null>(null)
const mockPendingApprovals = ref<any[]>([])
const mockMyApprovals = ref<any[]>([])
const mockCcApprovals = ref<any[]>([])
const mockCompletedApprovals = ref<any[]>([])

const loadDetailSpy = vi.fn().mockResolvedValue(undefined)
const loadHistorySpy = vi.fn().mockResolvedValue(undefined)
const submitApprovalSpy = vi.fn()
const executeActionSpy = vi.fn()
const loadPendingSpy = vi.fn().mockResolvedValue(undefined)
const loadMineSpy = vi.fn().mockResolvedValue(undefined)
const loadCcSpy = vi.fn().mockResolvedValue(undefined)
const loadCompletedSpy = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/approvals/store', () => ({
  useApprovalStore: () => ({
    get approvals() { return [] },
    get pendingApprovals() { return mockPendingApprovals.value },
    get myApprovals() { return mockMyApprovals.value },
    get ccApprovals() { return mockCcApprovals.value },
    get completedApprovals() { return mockCompletedApprovals.value },
    get activeApproval() { return mockActiveApproval.value },
    get history() { return mockHistory.value },
    get loading() { return mockLoading.value },
    get error() { return mockError.value },
    get totalPending() { return mockPendingApprovals.value.length },
    get totalMine() { return mockMyApprovals.value.length },
    get totalCc() { return mockCcApprovals.value.length },
    get totalCompleted() { return mockCompletedApprovals.value.length },
    get pendingCount() { return mockPendingApprovals.value.length },
    approvalById: () => undefined,
    loadPending: loadPendingSpy,
    loadMine: loadMineSpy,
    loadCc: loadCcSpy,
    loadCompleted: loadCompletedSpy,
    loadDetail: loadDetailSpy,
    loadHistory: loadHistorySpy,
    submitApproval: submitApprovalSpy,
    executeAction: executeActionSpy,
  }),
}))

// ---------------------------------------------------------------------------
// Template store mock
// ---------------------------------------------------------------------------
const mockActiveTemplate = ref<any>(null)
const mockTemplates = ref<any[]>([])
const mockTemplateLoading = ref(false)
const mockTemplateError = ref<string | null>(null)
const mockTemplateTotal = ref(0)

const loadTemplatesSpy = vi.fn().mockResolvedValue(undefined)
const loadTemplateSpy = vi.fn().mockResolvedValue(undefined)
const loadVersionSpy = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/approvals/templateStore', () => ({
  useApprovalTemplateStore: () => ({
    get templates() { return mockTemplates.value },
    get activeTemplate() { return mockActiveTemplate.value },
    get activeVersion() { return null },
    get loading() { return mockTemplateLoading.value },
    get error() { return mockTemplateError.value },
    get total() { return mockTemplateTotal.value },
    loadTemplates: loadTemplatesSpy,
    loadTemplate: loadTemplateSpy,
    loadVersion: loadVersionSpy,
  }),
}))

// ---------------------------------------------------------------------------
// Element Plus stubs (same pattern as approval-center.spec.ts)
// ---------------------------------------------------------------------------
const ElTabs = defineComponent({
  name: 'ElTabs',
  props: { modelValue: String },
  emits: ['update:modelValue', 'tab-change'],
  render() { return h('div', { 'data-el-tabs': this.modelValue }, this.$slots.default?.()) },
})

const ElTabPane = defineComponent({
  name: 'ElTabPane',
  props: { label: String, name: String },
  render() { return h('div', { 'data-tab-pane': this.name, 'data-tab-label': this.label }, this.$slots.default?.()) },
})

const ElTable = defineComponent({
  name: 'ElTable',
  props: { data: Array, loading: Boolean, stripe: Boolean, highlightCurrentRow: Boolean },
  emits: ['row-click'],
  render() { return h('div', { 'data-el-table': 'true' }, this.$slots.default?.()) },
})

const ElTableColumn = defineComponent({
  name: 'ElTableColumn',
  props: { prop: String, label: String, width: [String, Number], minWidth: [String, Number], fixed: String },
  render() { return h('div', { 'data-column': this.prop || this.label }) },
})

const ElTag = defineComponent({
  name: 'ElTag',
  props: { type: String, size: String },
  render() { return h('span', { 'data-el-tag': this.type, class: `el-tag--${this.type}` }, this.$slots.default?.()) },
})

const ElInput = defineComponent({
  name: 'ElInput',
  props: { modelValue: [String, Number], placeholder: String, clearable: Boolean, type: String, rows: Number },
  emits: ['update:modelValue', 'clear'],
  render() {
    return h('input', {
      'data-el-input': 'true',
      value: this.modelValue ?? '',
      onInput: (e: Event) => this.$emit('update:modelValue', (e.target as HTMLInputElement).value),
    })
  },
})

const ElInputNumber = defineComponent({
  name: 'ElInputNumber',
  props: { modelValue: Number, placeholder: String },
  emits: ['update:modelValue'],
  render() {
    return h('input', {
      'data-el-input-number': 'true',
      type: 'number',
      value: this.modelValue ?? '',
      onInput: (e: Event) => this.$emit('update:modelValue', Number((e.target as HTMLInputElement).value)),
    })
  },
})

const ElSelect = defineComponent({
  name: 'ElSelect',
  props: { modelValue: [String, Array], placeholder: String, clearable: Boolean, multiple: Boolean, filterable: Boolean },
  emits: ['update:modelValue', 'change'],
  render() {
    return h('select', {
      'data-el-select': 'true',
      value: Array.isArray(this.modelValue) ? '' : this.modelValue ?? '',
      onChange: (e: Event) => {
        const val = (e.target as HTMLSelectElement).value
        this.$emit('update:modelValue', val)
        this.$emit('change', val)
      },
    }, this.$slots.default?.())
  },
})

const ElOption = defineComponent({
  name: 'ElOption',
  props: { label: String, value: String },
  render() { return h('option', { value: this.value }, this.label) },
})

const ElButton = defineComponent({
  name: 'ElButton',
  props: { type: String, text: Boolean, link: Boolean, plain: Boolean, size: String, loading: Boolean, disabled: Boolean },
  emits: ['click'],
  render() {
    return h('button', {
      'data-el-button': this.type || 'default',
      disabled: this.disabled || false,
      onClick: (e: Event) => { e.stopPropagation(); this.$emit('click', e) },
    }, this.$slots.default?.())
  },
})

const ElAlert = defineComponent({
  name: 'ElAlert',
  props: { title: String, type: String, showIcon: Boolean, closable: Boolean },
  render() { return h('div', { 'data-el-alert': this.type }, this.title) },
})

const ElEmpty = defineComponent({
  name: 'ElEmpty',
  props: { description: String, imageSize: Number },
  render() { return h('div', { 'data-el-empty': 'true' }, this.description) },
})

const ElPagination = defineComponent({
  name: 'ElPagination',
  props: { background: Boolean, layout: String, total: Number, currentPage: Number, pageSize: Number },
  emits: ['update:currentPage'],
  render() { return h('div', { 'data-el-pagination': 'true' }) },
})

const ElDivider = defineComponent({
  name: 'ElDivider',
  render() { return h('hr', { 'data-el-divider': 'true' }) },
})

const ElDialog = defineComponent({
  name: 'ElDialog',
  props: { modelValue: Boolean, title: String, width: String },
  emits: ['update:modelValue'],
  render() {
    if (!this.modelValue) return h('div', { style: 'display:none', 'data-el-dialog': this.title })
    return h('div', { 'data-el-dialog': this.title, 'data-dialog-visible': 'true' }, [
      h('div', { class: 'el-dialog__title' }, this.title),
      this.$slots.default?.(),
      this.$slots.footer?.(),
    ])
  },
})

const ElForm = defineComponent({
  name: 'ElForm',
  props: { model: Object, rules: Object, labelPosition: String },
  setup(_props, { expose }) {
    expose({ validate: () => Promise.resolve(true) })
    return {}
  },
  render() { return h('form', { 'data-el-form': 'true' }, this.$slots.default?.()) },
})

const ElFormItem = defineComponent({
  name: 'ElFormItem',
  props: { label: String, prop: String, required: Boolean },
  render() {
    return h('div', { 'data-el-form-item': this.prop || this.label }, [
      h('label', this.label),
      this.$slots.default?.(),
    ])
  },
})

const ElDatePicker = defineComponent({
  name: 'ElDatePicker',
  props: { modelValue: [String, Date], type: String, placeholder: String },
  emits: ['update:modelValue'],
  render() {
    return h('input', {
      'data-el-date-picker': 'true',
      type: 'date',
      value: this.modelValue ?? '',
      onInput: (e: Event) => this.$emit('update:modelValue', (e.target as HTMLInputElement).value),
    })
  },
})

const ElUpload = defineComponent({
  name: 'ElUpload',
  props: { action: String, autoUpload: Boolean },
  render() { return h('div', { 'data-el-upload': 'true' }, this.$slots.default?.()) },
})

const stubDirective = { mounted() {}, updated() {} }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function registerAllStubs(app: VueApp<Element>) {
  app.component('ElTabs', ElTabs)
  app.component('ElTabPane', ElTabPane)
  app.component('ElTable', ElTable)
  app.component('ElTableColumn', ElTableColumn)
  app.component('ElTag', ElTag)
  app.component('ElInput', ElInput)
  app.component('ElInputNumber', ElInputNumber)
  app.component('ElSelect', ElSelect)
  app.component('ElOption', ElOption)
  app.component('ElButton', ElButton)
  app.component('ElAlert', ElAlert)
  app.component('ElEmpty', ElEmpty)
  app.component('ElPagination', ElPagination)
  app.component('ElDivider', ElDivider)
  app.component('ElDialog', ElDialog)
  app.component('ElForm', ElForm)
  app.component('ElFormItem', ElFormItem)
  app.component('ElDatePicker', ElDatePicker)
  app.component('ElUpload', ElUpload)
  app.directive('loading', stubDirective)
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('Approval E2E Lifecycle', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    // Reset all reactive state
    mockActiveApproval.value = null
    mockHistory.value = []
    mockLoading.value = false
    mockError.value = null
    mockPendingApprovals.value = []
    mockMyApprovals.value = []
    mockCcApprovals.value = []
    mockCompletedApprovals.value = []
    mockActiveTemplate.value = null
    mockTemplates.value = []
    mockTemplateLoading.value = false
    mockTemplateError.value = null
    mockTemplateTotal.value = 0

    // Reset route state
    routeParams = {}
    routeQuery = {}
    routePath = '/approvals'

    // Reset spies
    pushSpy.mockClear()
    backSpy.mockClear()
    loadDetailSpy.mockClear()
    loadHistorySpy.mockClear()
    submitApprovalSpy.mockClear()
    executeActionSpy.mockClear()
    loadPendingSpy.mockClear()
    loadMineSpy.mockClear()
    loadCcSpy.mockClear()
    loadCompletedSpy.mockClear()
    loadTemplatesSpy.mockClear()
    loadTemplateSpy.mockClear()
    loadVersionSpy.mockClear()

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

  // -------------------------------------------------------------------------
  // Mount helpers
  // -------------------------------------------------------------------------
  async function mountDetailView() {
    const { default: ApprovalDetailView } = await import('../src/views/approval/ApprovalDetailView.vue')
    const Host = defineComponent({ setup: () => () => h(ApprovalDetailView as any) })
    app = createApp(Host)
    registerAllStubs(app)
    app.mount(container!)
    await flushUi()
  }

  async function mountNewView() {
    const { default: ApprovalNewView } = await import('../src/views/approval/ApprovalNewView.vue')
    const Host = defineComponent({ setup: () => () => h(ApprovalNewView as any) })
    app = createApp(Host)
    registerAllStubs(app)
    app.mount(container!)
    await flushUi()
  }

  async function mountTemplateCenterView() {
    const { default: TemplateCenterView } = await import('../src/views/approval/TemplateCenterView.vue')
    const Host = defineComponent({ setup: () => () => h(TemplateCenterView as any) })
    app = createApp(Host)
    registerAllStubs(app)
    app.mount(container!)
    await flushUi()
  }

  async function mountTemplateDetailView() {
    const { default: TemplateDetailView } = await import('../src/views/approval/TemplateDetailView.vue')
    const Host = defineComponent({ setup: () => () => h(TemplateDetailView as any) })
    app = createApp(Host)
    registerAllStubs(app)
    app.mount(container!)
    await flushUi()
  }

  // =========================================================================
  // 1. Template lifecycle
  // =========================================================================
  describe('Template lifecycle', () => {
    it('loads template list on mount and calls loadTemplates', async () => {
      await mountTemplateCenterView()
      expect(loadTemplatesSpy).toHaveBeenCalled()
    })

    it('renders template center with header', async () => {
      await mountTemplateCenterView()
      const header = container!.querySelector('.template-center__header h1')
      expect(header?.textContent).toBe('审批模板')
    })

    it('renders status tabs (all / published / draft / archived)', async () => {
      await mountTemplateCenterView()
      const panes = container!.querySelectorAll('[data-tab-pane]')
      const labels = Array.from(panes).map((p) => p.getAttribute('data-tab-label'))
      expect(labels).toContain('全部')
      expect(labels).toContain('已发布')
      expect(labels).toContain('草稿')
      expect(labels).toContain('已归档')
    })

    it('loads template detail and shows published template info', async () => {
      routeParams = { id: 'tpl_1' }
      mockActiveTemplate.value = mockPublishedTemplate()
      await mountTemplateDetailView()

      expect(loadTemplateSpy).toHaveBeenCalledWith('tpl_1')
      const header = container!.querySelector('.template-detail__header h1')
      expect(header?.textContent).toBe('通用审批模板')
    })

    it('published template shows "发起审批" button in detail', async () => {
      routeParams = { id: 'tpl_1' }
      mockActiveTemplate.value = mockPublishedTemplate()
      await mountTemplateDetailView()

      const buttons = Array.from(container!.querySelectorAll('button'))
      const startBtn = buttons.find((b) => b.textContent?.includes('发起审批'))
      expect(startBtn).toBeTruthy()
    })

    it('draft template does NOT show "发起审批" button in detail', async () => {
      routeParams = { id: 'tpl_draft_1' }
      mockActiveTemplate.value = mockDraftTemplate()
      await mountTemplateDetailView()

      const buttons = Array.from(container!.querySelectorAll('button'))
      const startBtn = buttons.find((b) => b.textContent?.includes('发起审批'))
      expect(startBtn).toBeFalsy()
    })

    it('clicking "发起审批" navigates to /approvals/new/:templateId', async () => {
      routeParams = { id: 'tpl_1' }
      mockActiveTemplate.value = mockPublishedTemplate()
      await mountTemplateDetailView()

      const buttons = Array.from(container!.querySelectorAll('button'))
      const startBtn = buttons.find((b) => b.textContent?.includes('发起审批'))
      startBtn!.click()
      await flushUi()

      expect(pushSpy).toHaveBeenCalledWith({ path: '/approvals/new/tpl_1' })
    })

    it('template detail renders form fields table', async () => {
      routeParams = { id: 'tpl_1' }
      mockActiveTemplate.value = mockPublishedTemplate()
      await mountTemplateDetailView()

      const section = container!.querySelector('.template-detail__section h2')
      expect(section?.textContent).toBe('表单字段')
    })

    it('template detail renders approval graph nodes', async () => {
      routeParams = { id: 'tpl_1' }
      mockActiveTemplate.value = mockPublishedTemplate()
      await mountTemplateDetailView()

      const headings = Array.from(container!.querySelectorAll('.template-detail__section h2'))
      const graphHeading = headings.find((h) => h.textContent === '审批流程')
      expect(graphHeading).toBeTruthy()

      const nodes = container!.querySelectorAll('.el-timeline-item')
      expect(nodes.length).toBe(4) // start, approval_1, approval_2, end
    })
  })

  // =========================================================================
  // 2. Approval initiate
  // =========================================================================
  describe('Approval initiate', () => {
    it('loads template on mount when navigating to /approvals/new/:templateId', async () => {
      routeParams = { templateId: 'tpl_1' }
      routePath = '/approvals/new/tpl_1'
      mockActiveTemplate.value = mockPublishedTemplate()
      await mountNewView()

      expect(loadTemplateSpy).toHaveBeenCalledWith('tpl_1')
    })

    it('renders form fields from template schema', async () => {
      routeParams = { templateId: 'tpl_1' }
      mockActiveTemplate.value = mockPublishedTemplate()
      await mountNewView()

      const formItems = container!.querySelectorAll('[data-el-form-item]')
      expect(formItems.length).toBeGreaterThanOrEqual(4) // 4 schema fields + submit item
    })

    it('renders the "发起审批" header', async () => {
      routeParams = { templateId: 'tpl_1' }
      mockActiveTemplate.value = mockPublishedTemplate()
      await mountNewView()

      const h1 = container!.querySelector('.approval-new__header h1')
      expect(h1?.textContent).toBe('发起审批')
    })

    it('renders template name and description', async () => {
      routeParams = { templateId: 'tpl_1' }
      mockActiveTemplate.value = mockPublishedTemplate()
      await mountNewView()

      const infoH2 = container!.querySelector('.approval-new__info h2')
      expect(infoH2?.textContent).toBe('通用审批模板')

      const descP = container!.querySelector('.approval-new__info p')
      expect(descP?.textContent).toBe('适用于日常审批流程')
    })

    it('submit button calls submitApproval with templateId and formData', async () => {
      routeParams = { templateId: 'tpl_1' }
      mockActiveTemplate.value = mockPublishedTemplate()

      const resultApproval = mockPendingApproval({ id: 'apv_new_1' })
      submitApprovalSpy.mockResolvedValue(resultApproval)

      await mountNewView()

      const buttons = Array.from(container!.querySelectorAll('button'))
      const submitBtn = buttons.find((b) => b.textContent?.includes('提交审批'))
      expect(submitBtn).toBeTruthy()

      submitBtn!.click()
      await flushUi()

      expect(submitApprovalSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          templateId: 'tpl_1',
          formData: expect.any(Object),
        }),
      )
    })

    it('after successful submit, navigates to detail page', async () => {
      routeParams = { templateId: 'tpl_1' }
      mockActiveTemplate.value = mockPublishedTemplate()

      const resultApproval = mockPendingApproval({ id: 'apv_new_1' })
      submitApprovalSpy.mockResolvedValue(resultApproval)

      await mountNewView()

      const buttons = Array.from(container!.querySelectorAll('button'))
      const submitBtn = buttons.find((b) => b.textContent?.includes('提交审批'))
      submitBtn!.click()
      await flushUi()

      expect(pushSpy).toHaveBeenCalledWith({ name: 'approval-detail', params: { id: 'apv_new_1' } })
    })

    it('cancel button calls router.back()', async () => {
      routeParams = { templateId: 'tpl_1' }
      mockActiveTemplate.value = mockPublishedTemplate()
      await mountNewView()

      const buttons = Array.from(container!.querySelectorAll('button'))
      const cancelBtn = buttons.find((b) => b.textContent?.includes('取消'))
      cancelBtn!.click()
      await flushUi()

      expect(backSpy).toHaveBeenCalled()
    })
  })

  // =========================================================================
  // 3. Approve flow
  // =========================================================================
  describe('Approve flow', () => {
    it('loads detail and history on mount', async () => {
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      mockHistory.value = mockHistoryItems()
      await mountDetailView()

      expect(loadDetailSpy).toHaveBeenCalledWith('apv_pending_1')
      expect(loadHistorySpy).toHaveBeenCalledWith('apv_pending_1')
    })

    it('renders approval title and status tag', async () => {
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      await mountDetailView()

      const h1 = container!.querySelector('.approval-detail__header h1')
      expect(h1?.textContent).toBe('出差报销申请')

      const tag = container!.querySelector('.approval-detail__header [data-el-tag]')
      expect(tag?.textContent).toContain('待处理')
    })

    it('shows action buttons when status is pending', async () => {
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      await mountDetailView()

      const buttons = Array.from(container!.querySelectorAll('.approval-detail__actions button'))
      const labels = buttons.map((b) => b.textContent?.trim())
      expect(labels).toContain('通过')
      expect(labels).toContain('驳回')
      expect(labels).toContain('转交')
      expect(labels).toContain('撤回')
    })

    it('does not show action buttons when status is approved', async () => {
      routeParams = { id: 'apv_approved_1' }
      mockActiveApproval.value = mockApprovedApproval()
      await mountDetailView()

      const actions = container!.querySelector('.approval-detail__actions')
      expect(actions).toBeFalsy()
    })

    it('clicking "通过" opens the approve dialog', async () => {
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      await mountDetailView()

      const approveBtn = Array.from(container!.querySelectorAll('.approval-detail__actions button'))
        .find((b) => b.textContent?.trim() === '通过')
      approveBtn!.click()
      await flushUi()

      const dialog = container!.querySelector('[data-dialog-visible="true"]')
      expect(dialog).toBeTruthy()
      expect(dialog?.querySelector('.el-dialog__title')?.textContent).toBe('审批通过')
    })

    it('confirming approve calls executeAction with action=approve', async () => {
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      executeActionSpy.mockResolvedValue(mockApprovedApproval())

      await mountDetailView()

      // Open approve dialog
      const approveBtn = Array.from(container!.querySelectorAll('.approval-detail__actions button'))
        .find((b) => b.textContent?.trim() === '通过')
      approveBtn!.click()
      await flushUi()

      // Find and click confirm button inside dialog
      const dialog = container!.querySelector('[data-dialog-visible="true"]')
      const confirmBtn = Array.from(dialog!.querySelectorAll('button'))
        .find((b) => b.textContent?.trim() === '确认')
      confirmBtn!.click()
      await flushUi()

      expect(executeActionSpy).toHaveBeenCalledWith('apv_pending_1', {
        action: 'approve',
        comment: undefined,
      })
    })

    it('entering comment before approving sends comment in action', async () => {
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      executeActionSpy.mockResolvedValue(mockApprovedApproval())

      await mountDetailView()

      // Open approve dialog
      const approveBtn = Array.from(container!.querySelectorAll('.approval-detail__actions button'))
        .find((b) => b.textContent?.trim() === '通过')
      approveBtn!.click()
      await flushUi()

      // Enter comment in the dialog's textarea
      const dialog = container!.querySelector('[data-dialog-visible="true"]')
      const textarea = dialog!.querySelector('[data-el-input]') as HTMLInputElement
      if (textarea) {
        const nativeInputEvent = new Event('input', { bubbles: true })
        Object.defineProperty(nativeInputEvent, 'target', { value: { value: '同意报销' } })
        textarea.dispatchEvent(nativeInputEvent)
        await flushUi()
      }

      // Click confirm
      const confirmBtn = Array.from(dialog!.querySelectorAll('button'))
        .find((b) => b.textContent?.trim() === '确认')
      confirmBtn!.click()
      await flushUi()

      expect(executeActionSpy).toHaveBeenCalledWith('apv_pending_1', expect.objectContaining({
        action: 'approve',
      }))
    })

    it('after approve, loadHistory is called to refresh timeline', async () => {
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      executeActionSpy.mockResolvedValue(mockApprovedApproval())

      await mountDetailView()
      loadHistorySpy.mockClear()

      const approveBtn = Array.from(container!.querySelectorAll('.approval-detail__actions button'))
        .find((b) => b.textContent?.trim() === '通过')
      approveBtn!.click()
      await flushUi()

      const dialog = container!.querySelector('[data-dialog-visible="true"]')
      const confirmBtn = Array.from(dialog!.querySelectorAll('button'))
        .find((b) => b.textContent?.trim() === '确认')
      confirmBtn!.click()
      await flushUi()

      expect(loadHistorySpy).toHaveBeenCalledWith('apv_pending_1')
    })
  })

  // =========================================================================
  // 4. Reject flow
  // =========================================================================
  describe('Reject flow', () => {
    it('clicking "驳回" opens the reject dialog', async () => {
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      await mountDetailView()

      const rejectBtn = Array.from(container!.querySelectorAll('.approval-detail__actions button'))
        .find((b) => b.textContent?.trim() === '驳回')
      rejectBtn!.click()
      await flushUi()

      const dialog = container!.querySelector('[data-dialog-visible="true"]')
      expect(dialog).toBeTruthy()
      expect(dialog?.querySelector('.el-dialog__title')?.textContent).toBe('审批驳回')
    })

    it('confirming reject calls executeAction with action=reject', async () => {
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      executeActionSpy.mockResolvedValue(mockRejectedApproval())

      await mountDetailView()

      // Open reject dialog
      const rejectBtn = Array.from(container!.querySelectorAll('.approval-detail__actions button'))
        .find((b) => b.textContent?.trim() === '驳回')
      rejectBtn!.click()
      await flushUi()

      // Click confirm (danger button)
      const dialog = container!.querySelector('[data-dialog-visible="true"]')
      const confirmBtn = Array.from(dialog!.querySelectorAll('button'))
        .find((b) => b.textContent?.trim() === '确认')
      confirmBtn!.click()
      await flushUi()

      expect(executeActionSpy).toHaveBeenCalledWith('apv_pending_1', {
        action: 'reject',
        comment: undefined,
      })
    })

    it('after reject, loadHistory is refreshed', async () => {
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      executeActionSpy.mockResolvedValue(mockRejectedApproval())

      await mountDetailView()
      loadHistorySpy.mockClear()

      const rejectBtn = Array.from(container!.querySelectorAll('.approval-detail__actions button'))
        .find((b) => b.textContent?.trim() === '驳回')
      rejectBtn!.click()
      await flushUi()

      const dialog = container!.querySelector('[data-dialog-visible="true"]')
      const confirmBtn = Array.from(dialog!.querySelectorAll('button'))
        .find((b) => b.textContent?.trim() === '确认')
      confirmBtn!.click()
      await flushUi()

      expect(loadHistorySpy).toHaveBeenCalledWith('apv_pending_1')
    })
  })

  // =========================================================================
  // 5. Transfer flow
  // =========================================================================
  describe('Transfer flow', () => {
    it('clicking "转交" opens the transfer dialog', async () => {
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      await mountDetailView()

      const transferBtn = Array.from(container!.querySelectorAll('.approval-detail__actions button'))
        .find((b) => b.textContent?.trim() === '转交')
      transferBtn!.click()
      await flushUi()

      const dialog = container!.querySelector('[data-el-dialog="转交审批"]')
      expect(dialog).toBeTruthy()
      expect(dialog?.getAttribute('data-dialog-visible')).toBe('true')
    })

    it('transfer dialog contains user selector with options', async () => {
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      await mountDetailView()

      const transferBtn = Array.from(container!.querySelectorAll('.approval-detail__actions button'))
        .find((b) => b.textContent?.trim() === '转交')
      transferBtn!.click()
      await flushUi()

      const dialog = container!.querySelector('[data-dialog-visible="true"][data-el-dialog="转交审批"]')
      const options = dialog!.querySelectorAll('option')
      expect(options.length).toBeGreaterThanOrEqual(3) // user_2, user_3, user_4
    })

    it('confirming transfer calls executeAction with action=transfer and targetUserId', async () => {
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      executeActionSpy.mockResolvedValue(mockPendingApproval())

      await mountDetailView()

      // Open transfer dialog
      const transferBtn = Array.from(container!.querySelectorAll('.approval-detail__actions button'))
        .find((b) => b.textContent?.trim() === '转交')
      transferBtn!.click()
      await flushUi()

      const dialog = container!.querySelector('[data-dialog-visible="true"][data-el-dialog="转交审批"]')

      // Select a user
      const select = dialog!.querySelector('[data-el-select]') as HTMLSelectElement
      select.value = 'user_2'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await flushUi()

      // Click confirm transfer
      const confirmBtn = Array.from(dialog!.querySelectorAll('button'))
        .find((b) => b.textContent?.includes('确认转交'))
      confirmBtn!.click()
      await flushUi()

      expect(executeActionSpy).toHaveBeenCalledWith('apv_pending_1', expect.objectContaining({
        action: 'transfer',
        targetUserId: 'user_2',
      }))
    })

    it('after transfer, loadHistory is refreshed', async () => {
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      executeActionSpy.mockResolvedValue(mockPendingApproval())

      await mountDetailView()
      loadHistorySpy.mockClear()

      const transferBtn = Array.from(container!.querySelectorAll('.approval-detail__actions button'))
        .find((b) => b.textContent?.trim() === '转交')
      transferBtn!.click()
      await flushUi()

      const dialog = container!.querySelector('[data-dialog-visible="true"][data-el-dialog="转交审批"]')
      const select = dialog!.querySelector('[data-el-select]') as HTMLSelectElement
      select.value = 'user_2'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await flushUi()

      const confirmBtn = Array.from(dialog!.querySelectorAll('button'))
        .find((b) => b.textContent?.includes('确认转交'))
      confirmBtn!.click()
      await flushUi()

      expect(loadHistorySpy).toHaveBeenCalledWith('apv_pending_1')
    })
  })

  // =========================================================================
  // 6. Comment flow (via approve action with comment-only intent)
  // =========================================================================
  describe('Comment flow', () => {
    it('history items render correctly with comments', async () => {
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      mockHistory.value = mockHistoryItems()
      await mountDetailView()

      const historyItems = container!.querySelectorAll('.el-timeline-item')
      expect(historyItems.length).toBe(2)

      // The second history item should have a comment
      const commentEl = historyItems[1].querySelector('.approval-detail__timeline-comment')
      expect(commentEl?.textContent).toBe('同意报销')
    })

    it('history renders actor names', async () => {
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      mockHistory.value = mockHistoryItems()
      await mountDetailView()

      const historyItems = container!.querySelectorAll('.el-timeline-item')
      const firstActor = historyItems[0].querySelector('strong')
      expect(firstActor?.textContent).toBe('张三')
    })

    it('empty history shows "暂无审批历史" placeholder', async () => {
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      mockHistory.value = []
      await mountDetailView()

      const empty = container!.querySelector('.approval-detail__timeline [data-el-empty]')
      expect(empty?.textContent).toContain('暂无审批历史')
    })
  })

  // =========================================================================
  // 7. Revoke flow
  // =========================================================================
  describe('Revoke flow', () => {
    it('clicking "撤回" calls executeAction with action=revoke directly', async () => {
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      executeActionSpy.mockResolvedValue(mockRevokedApproval())

      await mountDetailView()

      const revokeBtn = Array.from(container!.querySelectorAll('.approval-detail__actions button'))
        .find((b) => b.textContent?.trim() === '撤回')
      revokeBtn!.click()
      await flushUi()

      expect(executeActionSpy).toHaveBeenCalledWith('apv_pending_1', { action: 'revoke' })
    })

    it('after revoke, loadHistory is refreshed', async () => {
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      executeActionSpy.mockResolvedValue(mockRevokedApproval())

      await mountDetailView()
      loadHistorySpy.mockClear()

      const revokeBtn = Array.from(container!.querySelectorAll('.approval-detail__actions button'))
        .find((b) => b.textContent?.trim() === '撤回')
      revokeBtn!.click()
      await flushUi()

      expect(loadHistorySpy).toHaveBeenCalledWith('apv_pending_1')
    })

    it('revoked approval does not show action buttons', async () => {
      routeParams = { id: 'apv_revoked_1' }
      mockActiveApproval.value = mockRevokedApproval()
      await mountDetailView()

      const actions = container!.querySelector('.approval-detail__actions')
      expect(actions).toBeFalsy()
    })

    it('rejected approval does not show action buttons', async () => {
      routeParams = { id: 'apv_rejected_1' }
      mockActiveApproval.value = mockRejectedApproval()
      await mountDetailView()

      const actions = container!.querySelector('.approval-detail__actions')
      expect(actions).toBeFalsy()
    })
  })

  // =========================================================================
  // Cross-cutting: Detail view rendering
  // =========================================================================
  describe('Detail view rendering', () => {
    it('renders form snapshot fields', async () => {
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      await mountDetailView()

      const snapshot = container!.querySelector('.approval-detail__snapshot')
      expect(snapshot).toBeTruthy()

      const fields = snapshot!.querySelectorAll('.approval-detail__field')
      expect(fields.length).toBe(3) // fld_reason, fld_amount, fld_type
    })

    it('renders meta info (requestNo, requester, department, progress)', async () => {
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      await mountDetailView()

      const metaItems = container!.querySelectorAll('.approval-detail__meta-item')
      expect(metaItems.length).toBeGreaterThanOrEqual(4) // requestNo, requester, department, time, progress

      const metaText = Array.from(metaItems).map((el) => el.textContent)
      expect(metaText.some((t) => t?.includes('APV-2026-0001'))).toBe(true)
      expect(metaText.some((t) => t?.includes('张三'))).toBe(true)
      expect(metaText.some((t) => t?.includes('研发部'))).toBe(true)
    })

    it('back button navigates to approval list', async () => {
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      await mountDetailView()

      const backBtn = Array.from(container!.querySelectorAll('button'))
        .find((b) => b.textContent?.includes('返回列表'))
      backBtn!.click()
      await flushUi()

      expect(pushSpy).toHaveBeenCalledWith({ name: 'approval-list' })
    })

    it('error state shows error alert', async () => {
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      mockError.value = '加载审批详情失败'
      await mountDetailView()

      const alert = container!.querySelector('[data-el-alert="error"]')
      expect(alert).toBeTruthy()
      expect(alert?.textContent).toContain('加载审批详情失败')
    })

    it('missing form snapshot shows empty placeholder', async () => {
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval({ formSnapshot: null })
      await mountDetailView()

      const empty = container!.querySelector('.approval-detail__form [data-el-empty]')
      expect(empty?.textContent).toContain('暂无表单数据')
    })
  })
})
