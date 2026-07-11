/**
 * B3-08 (模板治理 — 停用/启用 + 用量) — TemplateCenterView admin table archive/unarchive spec.
 *
 * Validates:
 *   - A published row shows "停用"; clicking it fetches usage, confirms via ElMessageBox, then
 *     calls archiveTemplate and flips the row's status in place.
 *   - An archived row shows "启用" instead of "停用"; clicking it confirms then calls
 *     unarchiveTemplate.
 *   - Declining the confirm dialog calls neither archiveTemplate nor unarchiveTemplate.
 *   - A draft row shows neither button (only published <-> archived is exposed here).
 *
 * Reuses the same Element Plus stub pattern as approvalTemplateCenterCategory.spec.ts (this view's
 * established spec convention) rather than mounting real Element Plus components.
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

vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({
    canWrite: ref(true),
    canManageTemplates: ref(true),
    canRead: ref(true),
    canAct: ref(true),
  }),
}))

// ---------------------------------------------------------------------------
// API mock — listTemplateCategories + cloneTemplate + B3-08 archive surface.
// ---------------------------------------------------------------------------
const listTemplateCategoriesSpy = vi.fn<[], Promise<string[]>>().mockResolvedValue([])
const cloneTemplateSpy = vi.fn().mockResolvedValue({ id: 'tpl_clone_1', name: 'Clone', visibilityScope: { type: 'all', ids: [] } })
const getTemplateUsageSpy = vi.fn<[string], Promise<any>>().mockResolvedValue({
  templateId: 'tpl_a',
  instanceCount: 4,
  activeInstanceCount: 1,
})
const archiveTemplateSpy = vi.fn<[string], Promise<any>>().mockResolvedValue({ id: 'tpl_a', status: 'archived' })
const unarchiveTemplateSpy = vi.fn<[string], Promise<any>>().mockResolvedValue({ id: 'tpl_a', status: 'published' })

vi.mock('../src/approvals/api', () => ({
  listTemplateCategories: () => listTemplateCategoriesSpy(),
  cloneTemplate: (id: string) => cloneTemplateSpy(id),
  getTemplateUsage: (id: string) => getTemplateUsageSpy(id),
  archiveTemplate: (id: string) => archiveTemplateSpy(id),
  unarchiveTemplate: (id: string) => unarchiveTemplateSpy(id),
}))

// ---------------------------------------------------------------------------
// ElMessage / ElMessageBox mock.
// ---------------------------------------------------------------------------
const confirmSpy = vi.fn().mockResolvedValue(undefined)
vi.mock('element-plus', async () => {
  return {
    ElMessage: {
      success: vi.fn(),
      error: vi.fn(),
    },
    ElMessageBox: {
      confirm: (...args: unknown[]) => confirmSpy(...args),
    },
  }
})

// ---------------------------------------------------------------------------
// Element Plus stubs — same shape as approvalTemplateCenterCategory.spec.ts.
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
    return h('span', { 'data-el-tag': this.type || 'default' }, this.$slots.default?.())
  },
})

const ElInput = defineComponent({
  name: 'ElInput',
  props: { modelValue: String, placeholder: String, clearable: Boolean, size: String, maxlength: [String, Number] },
  emits: ['update:modelValue', 'clear'],
  render() {
    return h('input', { 'data-el-input': 'true', value: this.modelValue, placeholder: this.placeholder })
  },
})

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

const stubDirective = { mounted() {}, updated() {} }

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function buildTemplate(overrides: Record<string, unknown>) {
  return {
    id: 'tpl_a',
    key: 'TPL-001',
    name: '出差申请',
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

describe('TemplateCenterView — B3-08 archive/unarchive', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mockTemplates.value = [buildTemplate({})]
    mockLoading.value = false
    mockError.value = null
    mockTotal.value = mockTemplates.value.length

    loadTemplatesSpy.mockClear()
    listTemplateCategoriesSpy.mockClear()
    listTemplateCategoriesSpy.mockResolvedValue([])
    cloneTemplateSpy.mockClear()
    getTemplateUsageSpy.mockClear()
    getTemplateUsageSpy.mockResolvedValue({ templateId: 'tpl_a', instanceCount: 4, activeInstanceCount: 1 })
    archiveTemplateSpy.mockClear()
    archiveTemplateSpy.mockResolvedValue({ id: 'tpl_a', status: 'archived' })
    unarchiveTemplateSpy.mockClear()
    unarchiveTemplateSpy.mockResolvedValue({ id: 'tpl_a', status: 'published' })
    confirmSpy.mockClear()
    confirmSpy.mockResolvedValue(undefined)
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
    app.component('ElCard', ElCard)
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
  }

  it('shows 停用 for a published row and archives it after confirm', async () => {
    await mountView()
    const archiveButton = container!.querySelector('[data-testid="template-center-archive-button"]') as HTMLButtonElement
    expect(archiveButton).toBeTruthy()
    expect(container!.querySelector('[data-testid="template-center-unarchive-button"]')).toBeNull()

    archiveButton.click()
    await flushUi()

    expect(getTemplateUsageSpy).toHaveBeenCalledWith('tpl_a')
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    // The confirm message states the blast radius from the usage fetch.
    expect(String(confirmSpy.mock.calls[0][0])).toContain('1')
    expect(archiveTemplateSpy).toHaveBeenCalledWith('tpl_a')
    expect(mockTemplates.value[0].status).toBe('archived')
  })

  it('shows 启用 for an archived row and unarchives it after confirm', async () => {
    mockTemplates.value = [buildTemplate({ status: 'archived' })]
    await mountView()
    const unarchiveButton = container!.querySelector('[data-testid="template-center-unarchive-button"]') as HTMLButtonElement
    expect(unarchiveButton).toBeTruthy()
    expect(container!.querySelector('[data-testid="template-center-archive-button"]')).toBeNull()

    unarchiveButton.click()
    await flushUi()

    // Unarchive is not a blast-radius action — it should not need the usage fetch.
    expect(getTemplateUsageSpy).not.toHaveBeenCalled()
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(unarchiveTemplateSpy).toHaveBeenCalledWith('tpl_a')
    expect(mockTemplates.value[0].status).toBe('published')
  })

  it('does not archive when the confirm dialog is declined', async () => {
    confirmSpy.mockRejectedValueOnce(new Error('cancel'))
    await mountView()
    const archiveButton = container!.querySelector('[data-testid="template-center-archive-button"]') as HTMLButtonElement

    archiveButton.click()
    await flushUi()

    expect(archiveTemplateSpy).not.toHaveBeenCalled()
    expect(mockTemplates.value[0].status).toBe('published')
  })

  it('shows neither archive nor unarchive button for a draft row', async () => {
    mockTemplates.value = [buildTemplate({ status: 'draft' })]
    await mountView()

    expect(container!.querySelector('[data-testid="template-center-archive-button"]')).toBeNull()
    expect(container!.querySelector('[data-testid="template-center-unarchive-button"]')).toBeNull()
  })
})
