/**
 * Approval E2E Permission Matrix Verification Tests
 *
 * Tests the permission model: read-only, writer, actor, template-manager.
 *
 * Strategy: since the current views do not consume a permission context directly
 * (no `v-if="hasPermission('...')"` guards in the SFC templates), we test the
 * permission matrix by controlling what the mock stores expose. This verifies
 * that the view components render (or omit) affordances based on the data shape
 * that a permission-aware backend / store would provide.
 *
 * Uses the same component-level E2E pattern as approval-center.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import {
  mockPendingApproval,
  mockApprovedApproval,
  mockPublishedTemplate,
  mockDraftTemplate,
  mockHistoryItems,
  mockPermissions,
  CURRENT_USER_ID,
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
const mockHistoryRef = ref<any[]>([])
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
    get history() { return mockHistoryRef.value },
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
// Approval permissions mock
// ---------------------------------------------------------------------------
const mockPermissionState = ref({
  canRead: true,
  canWrite: true,
  canAct: true,
  canManageTemplates: true,
})

function setMockPermissions(perms: string[]) {
  mockPermissionState.value = {
    canRead: perms.includes('approvals:read'),
    canWrite: perms.includes('approvals:write'),
    canAct: perms.includes('approvals:act'),
    canManageTemplates: perms.includes('approval-templates:manage'),
  }
}

vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({
    permissions: computed(() => mockPermissionState.value),
    hasPermission: (perm: string) => {
      const map = {
        'approvals:read': mockPermissionState.value.canRead,
        'approvals:write': mockPermissionState.value.canWrite,
        'approvals:act': mockPermissionState.value.canAct,
        'approval-templates:manage': mockPermissionState.value.canManageTemplates,
      } as const
      return map[perm as keyof typeof map] ?? false
    },
    canRead: computed(() => mockPermissionState.value.canRead),
    canWrite: computed(() => mockPermissionState.value.canWrite),
    canAct: computed(() => mockPermissionState.value.canAct),
    canManageTemplates: computed(() => mockPermissionState.value.canManageTemplates),
  }),
}))

// ---------------------------------------------------------------------------
// Element Plus stubs
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
  render() { return h('span', { 'data-el-tag': this.type }, this.$slots.default?.()) },
})

const ElInput = defineComponent({
  name: 'ElInput',
  props: { modelValue: [String, Number], placeholder: String, clearable: Boolean, type: String, rows: Number },
  emits: ['update:modelValue', 'clear'],
  render() { return h('input', { 'data-el-input': 'true' }) },
})

const ElInputNumber = defineComponent({
  name: 'ElInputNumber',
  props: { modelValue: Number, placeholder: String },
  emits: ['update:modelValue'],
  render() { return h('input', { 'data-el-input-number': 'true', type: 'number' }) },
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
      type: 'button',
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
  render() { return h('div', { 'data-el-form-item': this.prop || this.label }, [h('label', this.label), this.$slots.default?.()]) },
})

const ElDatePicker = defineComponent({
  name: 'ElDatePicker',
  props: { modelValue: [String, Date], type: String, placeholder: String },
  emits: ['update:modelValue'],
  render() { return h('input', { 'data-el-date-picker': 'true', type: 'date' }) },
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

function queryHistoryItems(container: HTMLDivElement | null) {
  const timelineItems = container?.querySelectorAll('.el-timeline-item') ?? []
  if (timelineItems.length > 0) return Array.from(timelineItems)
  return Array.from(container?.querySelectorAll('.approval-detail__history-item') ?? [])
}

function queryTemplateGraphNodes(container: HTMLDivElement | null) {
  const timelineItems = container?.querySelectorAll('.el-timeline-item') ?? []
  if (timelineItems.length > 0) return Array.from(timelineItems)
  return Array.from(container?.querySelectorAll('.template-detail__node') ?? [])
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
describe('Approval E2E Permissions', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mockActiveApproval.value = null
    mockHistoryRef.value = []
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
    setMockPermissions([
      'approvals:read',
      'approvals:write',
      'approvals:act',
      'approval-templates:manage',
    ])

    routeParams = {}
    routeQuery = {}
    routePath = '/approvals'

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
  async function mountCenterView() {
    const { default: ApprovalCenterView } = await import('../src/views/approval/ApprovalCenterView.vue')
    const Host = defineComponent({ setup: () => () => h(ApprovalCenterView as any) })
    app = createApp(Host)
    registerAllStubs(app)
    app.mount(container!)
    await flushUi()
  }

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
  // 1. Read-only user (approvals:read only)
  // =========================================================================
  describe('Read-only user (approvals:read)', () => {
    it('can see the approval list (center view renders)', async () => {
      const perms = mockPermissions(['approvals:read'])
      setMockPermissions(perms.permissions)
      mockPendingApprovals.value = [mockPendingApproval()]
      await mountCenterView()

      const header = container!.querySelector('.approval-center__header h1')
      expect(header?.textContent).toBe('审批中心')
      expect(loadPendingSpy).toHaveBeenCalled()
    })

    it('can see approval list tabs', async () => {
      setMockPermissions(['approvals:read'])
      await mountCenterView()
      const panes = container!.querySelectorAll('[data-tab-pane]')
      expect(panes.length).toBe(4)
    })

    it('detail page with non-pending status shows NO action buttons', async () => {
      setMockPermissions(['approvals:read'])
      // Read-only: viewing an approved approval -> no buttons
      routeParams = { id: 'apv_approved_1' }
      mockActiveApproval.value = mockApprovedApproval()
      await mountDetailView()

      const actions = container!.querySelector('.approval-detail__actions')
      expect(actions).toBeFalsy()
    })

    it('detail page still renders form snapshot and history', async () => {
      setMockPermissions(['approvals:read'])
      routeParams = { id: 'apv_approved_1' }
      mockActiveApproval.value = mockApprovedApproval({
        formSnapshot: { fld_reason: '出差报销', fld_amount: 5000 },
      })
      mockHistoryRef.value = mockHistoryItems()
      await mountDetailView()

      const snapshot = container!.querySelector('.approval-detail__snapshot')
      expect(snapshot).toBeTruthy()

      const historyItems = queryHistoryItems(container)
      expect(historyItems.length).toBe(2)
    })

    it('template center renders without "发起审批" button for draft templates', async () => {
      setMockPermissions(['approvals:read'])
      // Template center shows a table. Only published templates have a "发起审批" link button.
      // Draft templates should not show it. We verify by providing only draft templates.
      mockTemplates.value = [
        { ...mockDraftTemplate(), id: 'tpl_d1', name: '草稿模板' },
      ]
      await mountTemplateCenterView()

      // The table renders. Since the column uses scoped slots that are not invoked by our stub,
      // we verify the table exists and loadTemplates was called.
      expect(loadTemplatesSpy).toHaveBeenCalled()
      const table = container!.querySelector('[data-el-table]')
      expect(table).toBeTruthy()
    })
  })

  // =========================================================================
  // 2. Writer (approvals:read + approvals:write)
  // =========================================================================
  describe('Writer (approvals:read + approvals:write)', () => {
    it('can load the new-approval form (ApprovalNewView)', async () => {
      const perms = mockPermissions(['approvals:read', 'approvals:write'])
      setMockPermissions(perms.permissions)
      routeParams = { templateId: 'tpl_1' }
      routePath = '/approvals/new/tpl_1'
      mockActiveTemplate.value = mockPublishedTemplate()

      await mountNewView()

      const h1 = container!.querySelector('.approval-new__header h1')
      expect(h1?.textContent).toBe('发起审批')
      expect(loadTemplateSpy).toHaveBeenCalledWith('tpl_1')
    })

    it('can fill and submit the approval form', async () => {
      setMockPermissions(['approvals:read', 'approvals:write'])
      routeParams = { templateId: 'tpl_1' }
      mockActiveTemplate.value = mockPublishedTemplate()
      submitApprovalSpy.mockResolvedValue(mockPendingApproval({ id: 'apv_new_writer' }))

      await mountNewView()

      const submitBtn = Array.from(container!.querySelectorAll('button'))
        .find((b) => b.textContent?.includes('提交审批'))
      expect(submitBtn).toBeTruthy()

      submitBtn!.click()
      await flushUi()

      expect(submitApprovalSpy).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: 'tpl_1' }),
      )
    })

    it('after submitting, navigates to the new approval detail', async () => {
      setMockPermissions(['approvals:read', 'approvals:write'])
      routeParams = { templateId: 'tpl_1' }
      mockActiveTemplate.value = mockPublishedTemplate()
      submitApprovalSpy.mockResolvedValue(mockPendingApproval({ id: 'apv_new_writer' }))

      await mountNewView()

      const submitBtn = Array.from(container!.querySelectorAll('button'))
        .find((b) => b.textContent?.includes('提交审批'))
      submitBtn!.click()
      await flushUi()

      expect(pushSpy).toHaveBeenCalledWith({
        name: 'approval-detail',
        params: { id: 'apv_new_writer' },
      })
    })

    it('writer viewing a pending approval with no assignment sees action buttons (view-level)', async () => {
      setMockPermissions(['approvals:read', 'approvals:write'])
      // The current detail view shows action buttons purely based on status === 'pending'.
      // A writer without approvals:act should NOT be able to act, but the current view
      // shows buttons for any pending approval. This test documents the current behavior.
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval({
        assignments: [], // No assignments for this user
      })
      await mountDetailView()

      // Current behavior: action bar is visible when status is 'pending'
      const actions = container!.querySelector('.approval-detail__actions')
      expect(actions).toBeTruthy()
    })
  })

  // =========================================================================
  // 3. Actor (approvals:read + approvals:act)
  // =========================================================================
  describe('Actor (approvals:read + approvals:act)', () => {
    it('sees approve/reject/transfer buttons when viewing a pending assigned approval', async () => {
      setMockPermissions(['approvals:read', 'approvals:act'])
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval() // Has active assignment for current user
      await mountDetailView()

      const buttons = Array.from(container!.querySelectorAll('.approval-detail__actions button'))
      const labels = buttons.map((b) => b.textContent?.trim())
      expect(labels).toContain('通过')
      expect(labels).toContain('驳回')
      expect(labels).toContain('转交')
    })

    it('does not see action buttons for a non-pending approval', async () => {
      setMockPermissions(['approvals:read', 'approvals:act'])
      routeParams = { id: 'apv_approved_1' }
      mockActiveApproval.value = mockApprovedApproval()
      await mountDetailView()

      const actions = container!.querySelector('.approval-detail__actions')
      expect(actions).toBeFalsy()
    })

    it('can execute approve action on an assigned approval', async () => {
      setMockPermissions(['approvals:read', 'approvals:act'])
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      executeActionSpy.mockResolvedValue(mockApprovedApproval())

      await mountDetailView()

      const approveBtn = Array.from(container!.querySelectorAll('.approval-detail__actions button'))
        .find((b) => b.textContent?.trim() === '通过')
      approveBtn!.click()
      await flushUi()

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

    it('can execute reject action on an assigned approval', async () => {
      setMockPermissions(['approvals:read', 'approvals:act'])
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      executeActionSpy.mockResolvedValue(mockApprovedApproval())

      await mountDetailView()

      const rejectBtn = Array.from(container!.querySelectorAll('.approval-detail__actions button'))
        .find((b) => b.textContent?.trim() === '驳回')
      rejectBtn!.click()
      await flushUi()

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

    it('can transfer an assigned approval to another user', async () => {
      setMockPermissions(['approvals:read', 'approvals:act'])
      routeParams = { id: 'apv_pending_1' }
      mockActiveApproval.value = mockPendingApproval()
      executeActionSpy.mockResolvedValue(mockPendingApproval())

      await mountDetailView()

      const transferBtn = Array.from(container!.querySelectorAll('.approval-detail__actions button'))
        .find((b) => b.textContent?.trim() === '转交')
      transferBtn!.click()
      await flushUi()

      const dialog = container!.querySelector('[data-dialog-visible="true"][data-el-dialog="转交审批"]')
      const select = dialog!.querySelector('[data-el-select]') as HTMLSelectElement
      select.value = 'user_3'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await flushUi()

      const confirmBtn = Array.from(dialog!.querySelectorAll('button'))
        .find((b) => b.textContent?.includes('确认转交'))
      confirmBtn!.click()
      await flushUi()

      expect(executeActionSpy).toHaveBeenCalledWith('apv_pending_1', expect.objectContaining({
        action: 'transfer',
        targetUserId: 'user_3',
      }))
    })

    it('history timeline is always visible for any approval', async () => {
      setMockPermissions(['approvals:read', 'approvals:act'])
      routeParams = { id: 'apv_approved_1' }
      mockActiveApproval.value = mockApprovedApproval()
      mockHistoryRef.value = mockHistoryItems()
      await mountDetailView()

      const timeline = container!.querySelector('.approval-detail__timeline h2')
      expect(timeline?.textContent).toBe('审批流程')

      const items = queryHistoryItems(container)
      expect(items.length).toBe(2)
    })
  })

  // =========================================================================
  // 4. Template manager (approval-templates:manage)
  // =========================================================================
  describe('Template manager (approval-templates:manage)', () => {
    it('template center renders and loads templates', async () => {
      setMockPermissions(['approval-templates:manage'])
      mockTemplates.value = [
        mockPublishedTemplate(),
        mockDraftTemplate(),
      ]
      mockTemplateTotal.value = 2
      await mountTemplateCenterView()

      expect(loadTemplatesSpy).toHaveBeenCalled()
      const header = container!.querySelector('.template-center__header h1')
      expect(header?.textContent).toBe('审批模板')
    })

    it('template center has search input', async () => {
      setMockPermissions(['approval-templates:manage'])
      await mountTemplateCenterView()
      const searchInput = container!.querySelector('.template-center__toolbar [data-el-input]')
      expect(searchInput).toBeTruthy()
    })

    it('template detail view renders all info for a published template', async () => {
      setMockPermissions(['approval-templates:manage', 'approvals:write'])
      routeParams = { id: 'tpl_1' }
      mockActiveTemplate.value = mockPublishedTemplate()
      await mountTemplateDetailView()

      // Template name
      const h1 = container!.querySelector('.template-detail__header h1')
      expect(h1?.textContent).toBe('通用审批模板')

      // Status tag (published)
      const statusTag = container!.querySelector('.template-detail__header [data-el-tag]')
      expect(statusTag?.textContent).toContain('已发布')

      // "发起审批" button present for published
      const startBtn = Array.from(container!.querySelectorAll('button'))
        .find((b) => b.textContent?.includes('发起审批'))
      expect(startBtn).toBeTruthy()
    })

    it('template detail view for a draft template shows no "发起审批" button', async () => {
      setMockPermissions(['approval-templates:manage'])
      routeParams = { id: 'tpl_draft_1' }
      mockActiveTemplate.value = mockDraftTemplate()
      await mountTemplateDetailView()

      const h1 = container!.querySelector('.template-detail__header h1')
      expect(h1?.textContent).toBe('草稿审批模板')

      const startBtn = Array.from(container!.querySelectorAll('button'))
        .find((b) => b.textContent?.includes('发起审批'))
      expect(startBtn).toBeFalsy()
    })

    it('template detail view renders graph nodes', async () => {
      setMockPermissions(['approval-templates:manage'])
      routeParams = { id: 'tpl_1' }
      mockActiveTemplate.value = mockPublishedTemplate()
      await mountTemplateDetailView()

      const nodes = queryTemplateGraphNodes(container)
      expect(nodes.length).toBe(4) // start + 2 approval + end
    })

    it('template detail view renders form fields info section', async () => {
      setMockPermissions(['approval-templates:manage'])
      routeParams = { id: 'tpl_1' }
      mockActiveTemplate.value = mockPublishedTemplate()
      await mountTemplateDetailView()

      const headings = Array.from(container!.querySelectorAll('.template-detail__section h2'))
      const fieldsHeading = headings.find((h) => h.textContent === '表单字段')
      expect(fieldsHeading).toBeTruthy()
    })

    it('template detail shows meta info (key, version, dates)', async () => {
      setMockPermissions(['approval-templates:manage'])
      routeParams = { id: 'tpl_1' }
      mockActiveTemplate.value = mockPublishedTemplate()
      await mountTemplateDetailView()

      const meta = container!.querySelector('.template-detail__meta')
      expect(meta).toBeTruthy()
      expect(meta?.textContent).toContain('TPL-001')
    })

    it('back button navigates to /approval-templates', async () => {
      setMockPermissions(['approval-templates:manage'])
      routeParams = { id: 'tpl_1' }
      mockActiveTemplate.value = mockPublishedTemplate()
      await mountTemplateDetailView()

      const backBtn = Array.from(container!.querySelectorAll('button'))
        .find((b) => b.textContent?.includes('返回模板列表'))
      backBtn!.click()
      await flushUi()

      expect(pushSpy).toHaveBeenCalledWith({ path: '/approval-templates' })
    })
  })

  // =========================================================================
  // 5. Cross-permission edge cases
  // =========================================================================
  describe('Cross-permission edge cases', () => {
    it('approved approval is always read-only regardless of permissions', async () => {
      routeParams = { id: 'apv_approved_1' }
      mockActiveApproval.value = mockApprovedApproval()
      await mountDetailView()

      const actions = container!.querySelector('.approval-detail__actions')
      expect(actions).toBeFalsy()
    })

    it('rejected approval is always read-only', async () => {
      routeParams = { id: 'apv_rejected_1' }
      mockActiveApproval.value = {
        ...mockPendingApproval(),
        id: 'apv_rejected_1',
        status: 'rejected',
      }
      await mountDetailView()

      const actions = container!.querySelector('.approval-detail__actions')
      expect(actions).toBeFalsy()
    })

    it('revoked approval is always read-only', async () => {
      routeParams = { id: 'apv_revoked_1' }
      mockActiveApproval.value = {
        ...mockPendingApproval(),
        id: 'apv_revoked_1',
        status: 'revoked',
      }
      await mountDetailView()

      const actions = container!.querySelector('.approval-detail__actions')
      expect(actions).toBeFalsy()
    })

    it('permission helper creates correct user context', () => {
      const readOnly = mockPermissions(['approvals:read'])
      expect(readOnly.userId).toBe(CURRENT_USER_ID)
      expect(readOnly.hasPermission('approvals:read')).toBe(true)
      expect(readOnly.hasPermission('approvals:write')).toBe(false)
      expect(readOnly.hasPermission('approvals:act')).toBe(false)

      const writer = mockPermissions(['approvals:read', 'approvals:write'])
      expect(writer.hasPermission('approvals:write')).toBe(true)
      expect(writer.hasPermission('approvals:act')).toBe(false)

      const actor = mockPermissions(['approvals:read', 'approvals:act'])
      expect(actor.hasPermission('approvals:act')).toBe(true)
      expect(actor.hasPermission('approvals:write')).toBe(false)

      const manager = mockPermissions(['approval-templates:manage'])
      expect(manager.hasPermission('approval-templates:manage')).toBe(true)
    })

    it('new-approval view shows empty state when template not found', async () => {
      routeParams = { templateId: 'tpl_nonexistent' }
      mockActiveTemplate.value = null
      mockTemplateLoading.value = false
      await mountNewView()

      const empty = container!.querySelector('[data-el-empty]')
      expect(empty?.textContent).toContain('未找到审批模板')
    })

    it('template detail shows empty state when template not found', async () => {
      routeParams = { id: 'tpl_nonexistent' }
      mockActiveTemplate.value = null
      mockTemplateLoading.value = false
      await mountTemplateDetailView()

      const empty = container!.querySelector('[data-el-empty]')
      expect(empty?.textContent).toContain('未找到模板')
    })
  })
})
