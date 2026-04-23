/**
 * Wave 2 WP4 slice 1 — TemplateCenterView category filter + clone action spec.
 *
 * Validates:
 *   - The category dropdown is populated from `listTemplateCategories()`.
 *   - Selecting a category triggers `store.loadTemplates({ category })`.
 *   - Clicking 克隆 calls `cloneTemplate(id)` and routes to the new detail page.
 *
 * Uses the same Element Plus stub pattern as `approval-center.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createApp,
  defineComponent,
  h,
  inject,
  nextTick,
  provide,
  reactive,
  ref,
  type App as VueApp,
  type Slot,
} from 'vue'

const pushSpy = vi.fn().mockResolvedValue(undefined)

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({
      push: pushSpy,
      back: vi.fn(),
    }),
    useRoute: () => ({
      params: {},
      query: {},
      path: '/approval-templates',
      meta: {},
    }),
  }
})

// ---------------------------------------------------------------------------
// Store mock — only the bits TemplateCenterView reads / writes.
// ---------------------------------------------------------------------------
const mockTemplates = ref<any[]>([])
const mockLoading = ref(false)
const mockError = ref<string | null>(null)
const mockTotal = ref(0)
const loadTemplatesSpy = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/approvals/templateStore', () => ({
  useApprovalTemplateStore: () => ({
    get templates() { return mockTemplates.value },
    get loading() { return mockLoading.value },
    get error() { return mockError.value },
    set error(v: string | null) { mockError.value = v },
    get total() { return mockTotal.value },
    loadTemplates: loadTemplatesSpy,
    loadTemplate: vi.fn(),
    loadVersion: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// Permissions mock — admin so that canManageTemplates is true.
// ---------------------------------------------------------------------------
vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({
    canWrite: ref(true),
    canManageTemplates: ref(true),
    canRead: ref(true),
    canAct: ref(true),
  }),
}))

// ---------------------------------------------------------------------------
// API mock — listTemplateCategories + cloneTemplate.
// ---------------------------------------------------------------------------
const listTemplateCategoriesSpy = vi.fn<[], Promise<string[]>>().mockResolvedValue([])
const cloneTemplateSpy = vi.fn<[string], Promise<any>>().mockResolvedValue({
  id: 'tpl_clone_1',
  name: 'Clone',
  visibilityScope: { type: 'all', ids: [] },
})

vi.mock('../src/approvals/api', () => ({
  listTemplateCategories: () => listTemplateCategoriesSpy(),
  cloneTemplate: (id: string) => cloneTemplateSpy(id),
}))

// ---------------------------------------------------------------------------
// ElMessage mock — we only care that calls do not throw.
// ---------------------------------------------------------------------------
vi.mock('element-plus', async () => {
  return {
    ElMessage: {
      success: vi.fn(),
      error: vi.fn(),
    },
  }
})

// ---------------------------------------------------------------------------
// Element Plus stubs — rich enough to exercise the filter/clone paths.
// ---------------------------------------------------------------------------
const ElTabs = defineComponent({
  name: 'ElTabs',
  props: { modelValue: String },
  emits: ['update:modelValue', 'tab-change'],
  render() {
    return h('div', { 'data-el-tabs': this.modelValue }, this.$slots.default?.())
  },
})

const ElTabPane = defineComponent({
  name: 'ElTabPane',
  props: { label: String, name: String },
  render() {
    return h('div', { 'data-tab-pane': this.name, 'data-tab-label': this.label })
  },
})

// Scoped-slot-capable ElTable stub. ElTableColumn children register their
// `#default="{ row }"` slot into a shared registry via provide/inject; then
// ElTable walks `data` × registry to emit real per-row markup. This lets the
// spec inspect text rendered inside `<template #default="{ row }">` blocks
// (eg the category tag, the 克隆 button).
type ColumnRegistryEntry = {
  key: string
  prop?: string
  label?: string
  defaultSlot?: Slot
}
type ColumnRegistry = {
  columns: ColumnRegistryEntry[]
  register: (entry: ColumnRegistryEntry) => void
}
const COLUMN_REGISTRY_KEY = Symbol('el-table-columns')

const ElTable = defineComponent({
  name: 'ElTable',
  props: { data: Array, loading: Boolean },
  setup(props, { slots }) {
    const registry = reactive<ColumnRegistry>({
      columns: [],
      register(entry) {
        registry.columns.push(entry)
      },
    })
    provide(COLUMN_REGISTRY_KEY, registry)
    return () => {
      // First: instantiate the default slot once so each ElTableColumn child
      // gets its setup call and registers itself. We render them off-screen
      // (display:none) because the real per-row output is emitted below.
      const columnInstances = slots.default?.() ?? []
      const rows = (props.data as any[] | undefined) ?? []
      return h('div', { 'data-el-table': 'true' }, [
        h('div', { style: 'display:none' }, columnInstances),
        ...rows.map((row, i) =>
          h(
            'div',
            { 'data-el-row': String(i), key: (row?.id as string) ?? String(i) },
            registry.columns.map((col) =>
              col.defaultSlot
                ? h(
                  'div',
                  { 'data-el-cell': col.prop || col.label || col.key },
                  col.defaultSlot({ row }),
                )
                : h('div', { 'data-el-cell-header': col.prop || col.label }, ''),
            ),
          ),
        ),
      ])
    }
  },
})

let columnSeq = 0
const ElTableColumn = defineComponent({
  name: 'ElTableColumn',
  props: { prop: String, label: String, width: [String, Number], minWidth: [String, Number], fixed: String },
  setup(props, { slots }) {
    const registry = inject<ColumnRegistry | null>(COLUMN_REGISTRY_KEY, null)
    if (registry) {
      registry.register({
        key: `col-${columnSeq++}`,
        prop: props.prop,
        label: props.label,
        defaultSlot: slots.default,
      })
    }
    return () => null
  },
})

const ElTag = defineComponent({
  name: 'ElTag',
  props: { type: String, size: String, effect: String },
  inheritAttrs: false,
  render() {
    return h('span', {
      'data-el-tag': this.type || 'default',
      'data-testid': (this.$attrs as any)?.['data-testid'],
      class: `el-tag--${this.type || 'default'}`,
    }, this.$slots.default?.())
  },
})

const ElInput = defineComponent({
  name: 'ElInput',
  props: { modelValue: String, placeholder: String, clearable: Boolean, size: String, maxlength: [String, Number] },
  emits: ['update:modelValue', 'clear'],
  render() {
    return h('input', {
      'data-el-input': 'true',
      'data-testid': (this.$attrs as any)?.['data-testid'],
      value: this.modelValue,
      placeholder: this.placeholder,
    })
  },
})

// Rich ElSelect stub — renders a native <select> so the test can actually
// fire a change event with a new value.
const ElSelect = defineComponent({
  name: 'ElSelect',
  props: { modelValue: [String, Array], placeholder: String, clearable: Boolean, size: String },
  emits: ['update:modelValue', 'change', 'clear'],
  inheritAttrs: false,
  render() {
    return h(
      'select',
      {
        'data-el-select': 'true',
        'data-testid': (this.$attrs as any)?.['data-testid'],
        value: (this.modelValue as string | undefined) ?? '',
        onChange: (e: Event) => {
          const value = (e.target as HTMLSelectElement).value
          this.$emit('update:modelValue', value)
          this.$emit('change', value)
        },
      },
      [
        h('option', { value: '', key: '__empty__' }, this.placeholder ?? ''),
        ...(this.$slots.default?.() ?? []),
      ],
    )
  },
})

const ElOption = defineComponent({
  name: 'ElOption',
  props: { label: String, value: String },
  render() {
    return h('option', { value: this.value }, this.label ?? this.value)
  },
})

const ElPagination = defineComponent({
  name: 'ElPagination',
  props: { background: Boolean, layout: String, total: Number, currentPage: Number, pageSize: Number },
  emits: ['update:currentPage'],
  render() {
    return h('div', { 'data-el-pagination': 'true' })
  },
})

const ElButton = defineComponent({
  name: 'ElButton',
  props: { type: String, text: Boolean, link: Boolean, size: String, loading: Boolean, disabled: Boolean },
  emits: ['click'],
  inheritAttrs: false,
  render() {
    return h(
      'button',
      {
        'data-el-button': this.type || 'default',
        'data-testid': (this.$attrs as any)?.['data-testid'],
        disabled: this.disabled || this.loading,
        onClick: (e: Event) => this.$emit('click', e),
      },
      this.$slots.default?.(),
    )
  },
})

const ElAlert = defineComponent({
  name: 'ElAlert',
  props: { title: String, type: String, showIcon: Boolean, closable: Boolean },
  render() {
    return h('div', { 'data-el-alert': this.type }, this.title)
  },
})

const ElEmpty = defineComponent({
  name: 'ElEmpty',
  props: { description: String, imageSize: Number },
  render() {
    return h('div', { 'data-el-empty': 'true' }, this.description)
  },
})

const ElTooltip = defineComponent({
  name: 'ElTooltip',
  render() {
    return h('div', { 'data-el-tooltip': 'true' }, this.$slots.default?.())
  },
})

const ElIcon = defineComponent({
  name: 'ElIcon',
  render() {
    return h('span', { 'data-el-icon': 'true' }, this.$slots.default?.())
  },
})

const stubDirective = { mounted() {}, updated() {} }

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function buildTemplate(overrides: Record<string, unknown>) {
  return {
    id: 'tpl_1',
    key: 'TPL-001',
    name: '审批模板 1',
    description: null,
    category: null,
    visibilityScope: { type: 'all', ids: [] },
    status: 'published',
    activeVersionId: 'ver_1',
    latestVersionId: 'ver_1',
    createdAt: '2026-04-10T08:00:00Z',
    updatedAt: '2026-04-10T10:00:00Z',
    ...overrides,
  }
}

describe('TemplateCenterView — WP4 slice 1 category filter + clone', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mockTemplates.value = [
      buildTemplate({ id: 'tpl_a', name: '出差申请', category: '请假' }),
      buildTemplate({ id: 'tpl_b', name: '采购申请', category: '采购' }),
      buildTemplate({ id: 'tpl_c', name: '其他申请', category: null }),
    ]
    mockLoading.value = false
    mockError.value = null
    mockTotal.value = mockTemplates.value.length

    loadTemplatesSpy.mockClear()
    loadTemplatesSpy.mockResolvedValue(undefined)
    listTemplateCategoriesSpy.mockClear()
    listTemplateCategoriesSpy.mockResolvedValue(['请假', '采购'])
    cloneTemplateSpy.mockClear()
    cloneTemplateSpy.mockResolvedValue({
      id: 'tpl_clone_new',
      key: 'TPL-001_copy_abc123',
      name: '审批模板 1 (副本)',
      status: 'draft',
      activeVersionId: null,
      latestVersionId: 'ver_clone_1',
      category: '请假',
      visibilityScope: { type: 'all', ids: [] },
    })
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
    const { default: TemplateCenterView } = await import('../src/views/approval/TemplateCenterView.vue')
    const Host = defineComponent({
      setup() {
        return () => h(TemplateCenterView as any)
      },
    })
    app = createApp(Host)
    app.component('ElTabs', ElTabs)
    app.component('ElTabPane', ElTabPane)
    app.component('ElTable', ElTable)
    app.component('ElTableColumn', ElTableColumn)
    app.component('ElTag', ElTag)
    app.component('ElInput', ElInput)
    app.component('ElSelect', ElSelect)
    app.component('ElOption', ElOption)
    app.component('ElPagination', ElPagination)
    app.component('ElButton', ElButton)
    app.component('ElAlert', ElAlert)
    app.component('ElEmpty', ElEmpty)
    app.component('ElTooltip', ElTooltip)
    app.component('ElIcon', ElIcon)
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
  }

  it('populates the category dropdown from listTemplateCategories()', async () => {
    await mountView()
    expect(listTemplateCategoriesSpy).toHaveBeenCalledTimes(1)

    const filter = container!.querySelector('[data-testid="template-center-category-filter"]') as HTMLSelectElement | null
    expect(filter).toBeTruthy()
    const optionLabels = Array.from(filter!.querySelectorAll('option'))
      .map((opt) => (opt.textContent ?? '').trim())
    // Dropdown contains the placeholder + each category fetched from the API.
    expect(optionLabels).toContain('请假')
    expect(optionLabels).toContain('采购')
  })

  it('passes `category` to loadTemplates when the filter changes', async () => {
    await mountView()
    // Initial mount loads without a category filter — clear this baseline call
    // so the assertion below only inspects the selection-driven reload.
    loadTemplatesSpy.mockClear()

    const filter = container!.querySelector('[data-testid="template-center-category-filter"]') as HTMLSelectElement
    filter.value = '请假'
    filter.dispatchEvent(new Event('change'))
    await flushUi()

    expect(loadTemplatesSpy).toHaveBeenCalledTimes(1)
    const arg = loadTemplatesSpy.mock.calls[0]?.[0] as { category?: string } | undefined
    expect(arg?.category).toBe('请假')
  })

  it('clears the category filter when the selection goes back to empty', async () => {
    await mountView()
    const filter = container!.querySelector('[data-testid="template-center-category-filter"]') as HTMLSelectElement
    filter.value = '请假'
    filter.dispatchEvent(new Event('change'))
    await flushUi()
    loadTemplatesSpy.mockClear()

    filter.value = ''
    filter.dispatchEvent(new Event('change'))
    await flushUi()

    expect(loadTemplatesSpy).toHaveBeenCalledTimes(1)
    const arg = loadTemplatesSpy.mock.calls[0]?.[0] as { category?: string | undefined }
    // Empty string → undefined → no ?category param on the wire.
    expect(arg?.category).toBeUndefined()
  })

  it('renders a category tag per row', async () => {
    await mountView()
    const tags = container!.querySelectorAll('[data-testid="template-center-row-category"]')
    // 2 rows have a non-null category; the uncategorized one shows `未分组`.
    expect(tags.length).toBe(2)
    const tagTexts = Array.from(tags).map((el) => (el.textContent ?? '').trim())
    expect(tagTexts).toContain('请假')
    expect(tagTexts).toContain('采购')
  })

  it('renders visibility scope summary per row', async () => {
    mockTemplates.value = [
      buildTemplate({ id: 'tpl_a', visibilityScope: { type: 'all', ids: [] } }),
      buildTemplate({ id: 'tpl_b', visibilityScope: { type: 'role', ids: ['manager', 'finance'] } }),
    ]
    await mountView()
    const tags = container!.querySelectorAll('[data-testid="template-center-row-visibility"]')
    const texts = Array.from(tags).map((el) => (el.textContent ?? '').trim())
    expect(texts).toContain('全员可见')
    expect(texts).toContain('角色 2')
  })

  it('clicking 克隆 calls cloneTemplate + routes to the new detail page', async () => {
    await mountView()
    const cloneButtons = container!.querySelectorAll('[data-testid="template-center-clone-button"]')
    // One button per row, guarded on canManageTemplates=true (which we mocked).
    expect(cloneButtons.length).toBe(3)

    ;(cloneButtons[0] as HTMLButtonElement).click()
    await flushUi()

    expect(cloneTemplateSpy).toHaveBeenCalledTimes(1)
    expect(cloneTemplateSpy).toHaveBeenCalledWith('tpl_a')
    // The view also navigates to the clone's detail page after a successful call.
    expect(pushSpy).toHaveBeenCalledWith({ path: '/approval-templates/tpl_clone_new' })
  })

  it('does not route when cloneTemplate rejects', async () => {
    cloneTemplateSpy.mockRejectedValueOnce(new Error('boom'))
    await mountView()
    const cloneButtons = container!.querySelectorAll('[data-testid="template-center-clone-button"]')
    ;(cloneButtons[0] as HTMLButtonElement).click()
    await flushUi()

    expect(cloneTemplateSpy).toHaveBeenCalledTimes(1)
    expect(pushSpy).not.toHaveBeenCalled()
  })
})
