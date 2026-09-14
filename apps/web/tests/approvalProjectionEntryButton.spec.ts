import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'

// ---------------------------------------------------------------------------
// P3-2(a) design-lock 2026-09-12 — ApprovalDetailView's navigation entry to the viewer's OWN
// approval-projection sheet in the multitable product.
//
//   - shown ONLY when the server hands back a `projectionEntry` handle on the detail DTO —
//     `null` (non-participant / no template / server-side resolution failure, fail-closed) and
//     `undefined` (an older server that does not compute the field yet) both hide the button.
//     There is NO client-side fallback derivation from `templateId`.
//   - clicking navigates to `AppRouteNames.MULTITABLE` with EXACTLY the `sheetId`/`viewId` the
//     server provided — never a client-recomputed id.
//
// Same mount scaffold as approvalResubmitButton.spec.ts (store/router mocked directly; the real
// `ApprovalDetailView.vue` + a broad Element Plus stub set).
// ---------------------------------------------------------------------------

const pushSpy = vi.fn().mockResolvedValue(undefined)

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: pushSpy, back: vi.fn() }),
    useRoute: () => ({ params: { id: 'apv_1' }, query: {}, path: '/approvals/apv_1', meta: {} }),
  }
})

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({ hasFeature: () => false }),
}))

vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({ canAct: { value: false } }),
}))

vi.mock('../src/approvals/api', () => ({
  markApprovalRead: vi.fn().mockResolvedValue({ ok: true }),
  remindApproval: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  searchApprovalDirectoryUsers: vi.fn().mockResolvedValue([]),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getCurrentUser: () => ({ id: 'user_99' }),
    getCurrentUserId: vi.fn().mockImplementation(async () => 'user_99'),
  }),
}))

vi.mock('../src/approvals/templateStore', () => ({
  useApprovalTemplateStore: () => ({
    activeTemplate: null,
    activeVersion: null,
    loadTemplate: vi.fn().mockResolvedValue(undefined),
    loadVersion: vi.fn().mockResolvedValue(undefined),
  }),
}))

const mockActiveApproval = ref<any>(null)
const mockHistory = ref<any[]>([])
const mockLoading = ref(false)
const executeActionSpy = vi.fn()
const loadDetailSpy = vi.fn().mockResolvedValue(undefined)
const loadHistorySpy = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/approvals/store', () => ({
  useApprovalStore: () => ({
    get activeApproval() { return mockActiveApproval.value },
    get history() { return mockHistory.value },
    get loading() { return mockLoading.value },
    get error() { return null },
    set error(_v: unknown) { /* noop */ },
    loadDetail: loadDetailSpy,
    loadHistory: loadHistorySpy,
    executeAction: executeActionSpy,
  }),
}))

function stub(name: string, tag = 'div') {
  return defineComponent({
    name,
    props: { modelValue: {}, type: String, label: String, title: String },
    emits: ['update:modelValue', 'click', 'confirm', 'change'],
    render() {
      return h(tag, { 'data-stub': name }, this.$slots.default?.())
    },
  })
}

const ElButton = defineComponent({
  name: 'ElButton',
  props: { type: String, loading: Boolean, disabled: Boolean, text: Boolean, plain: Boolean },
  emits: ['click'],
  render() {
    const isDisabled = this.disabled || this.loading
    return h('button', {
      'data-el-button': this.type || 'default',
      disabled: isDisabled,
      onClick: (e: Event) => {
        if (isDisabled) return
        this.$emit('click', e)
      },
    }, this.$slots.default?.())
  },
})
const ElAlert = defineComponent({
  name: 'ElAlert',
  props: { title: String, type: String, closable: Boolean, showIcon: Boolean },
  render() { return h('div', { 'data-el-alert': this.type || 'default' }, this.title) },
})
const ElPopconfirm = defineComponent({
  name: 'ElPopconfirm',
  props: { title: String },
  render() { return h('div', { 'data-el-popconfirm': this.title }, this.$slots.reference?.()) },
})
const ElTableColumn = defineComponent({
  name: 'ElTableColumn',
  props: { prop: String, label: String },
  render() { return h('div', { 'data-column': this.prop || this.label }) },
})

const stubDirective = { mounted() {}, updated() {} }

async function flushUi(cycles = 5): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function baseInstance(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'apv_1',
    title: '出差报销',
    status: 'pending',
    templateId: 'tpl_1',
    requester: { id: 'user_99', name: '张三' },
    requestNo: 'AP-100001',
    currentStep: 1,
    totalSteps: 2,
    currentNodeKey: 'approval_1',
    formSnapshot: { fld_reason: '出差报销' },
    assignments: [],
    ...overrides,
  }
}

function projectionButton(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="approval-open-projection-button"]')
}

describe('ApprovalDetailView — P3-2(a) 在多维表中查看 (projection entry)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mockActiveApproval.value = baseInstance()
    mockHistory.value = []
    mockLoading.value = false
    executeActionSpy.mockReset()
    executeActionSpy.mockResolvedValue({})
    loadDetailSpy.mockClear()
    loadHistorySpy.mockClear()
    pushSpy.mockClear()
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
    const { default: ApprovalDetailView } = await import('../src/views/approval/ApprovalDetailView.vue')
    const Host = defineComponent({ setup() { return () => h(ApprovalDetailView as any) } })
    app = createApp(Host)
    for (const name of ['ElDivider', 'ElEmpty', 'ElTable', 'ElTimeline', 'ElTimelineItem', 'ElForm', 'ElFormItem', 'ElSelect', 'ElOption', 'ElRadioGroup', 'ElRadio', 'ElIcon', 'ElInput', 'ElTag', 'ElDialog']) {
      app.component(name, stub(name))
    }
    app.component('ElTableColumn', ElTableColumn)
    app.component('ElButton', ElButton)
    app.component('ElAlert', ElAlert)
    app.component('ElPopconfirm', ElPopconfirm)
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
  }

  it('shows the entry when the server provides a projectionEntry handle', async () => {
    mockActiveApproval.value = baseInstance({ projectionEntry: { sheetId: 'sht_apr_proj_tpl_1', viewId: 'view_1' } })
    await mountView()

    expect(projectionButton(container!)).toBeTruthy()
  })

  it('hides the entry when projectionEntry is null (non-participant / fail-closed)', async () => {
    mockActiveApproval.value = baseInstance({ projectionEntry: null })
    await mountView()

    expect(projectionButton(container!)).toBeNull()
    // the OTHER always-present actions still render — only THIS button is gated off.
    expect(container!.querySelector('[data-testid="approval-copy-summary-button"]')).toBeTruthy()
  })

  it('hides the entry when projectionEntry is absent (older server that does not compute it)', async () => {
    mockActiveApproval.value = baseInstance()
    expect('projectionEntry' in mockActiveApproval.value).toBe(false)
    await mountView()

    expect(projectionButton(container!)).toBeNull()
  })

  it('clicking the entry navigates to AppRouteNames.MULTITABLE with EXACTLY the server-given sheetId/viewId', async () => {
    mockActiveApproval.value = baseInstance({
      projectionEntry: { sheetId: 'sht_apr_proj_tpl_42', viewId: 'view_abc' },
    })
    await mountView()

    const btn = projectionButton(container!)
    expect(btn).toBeTruthy()
    btn!.click()
    await flushUi()

    expect(pushSpy).toHaveBeenCalledWith({
      name: 'multitable',
      params: { sheetId: 'sht_apr_proj_tpl_42', viewId: 'view_abc' },
    })
  })

  it('never re-derives a sheetId from templateId — navigates with the handle verbatim even when it disagrees with the naming convention', async () => {
    // The handle's shape is the server's business; the client must not recompute or validate it
    // against `sht_apr_proj_${templateId}` — that recomputation is exactly what design-lock §2
    // forbids (a client-side derivation is "a NEW fourth predicate").
    mockActiveApproval.value = baseInstance({
      templateId: 'tpl_1',
      projectionEntry: { sheetId: 'totally-unrelated-sheet-id', viewId: 'totally-unrelated-view-id' },
    })
    await mountView()

    projectionButton(container!)!.click()
    await flushUi()

    expect(pushSpy).toHaveBeenCalledWith({
      name: 'multitable',
      params: { sheetId: 'totally-unrelated-sheet-id', viewId: 'totally-unrelated-view-id' },
    })
  })
})
