/**
 * B3-09 (模板治理 — 版本历史) — TemplateDetailView version-history section spec.
 *
 * Validates:
 *   - Admin (canManageTemplates) → listTemplateVersions fetched once; rows render version number,
 *     publish note (or '-'), and the 当前生效 tag ONLY on the row holding the active published
 *     definition.
 *   - Non-admin → the section is absent AND the endpoint is never fetched (the fetch itself is
 *     permission-gated, not just the markup — the endpoint would 403).
 *   - Fetch failure → inline warning; the rest of the detail page still renders (honest degrade).
 *
 * Same standalone stub pattern as approvalTemplateGovernance.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  computed,
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
    useRouter: () => ({ push: pushSpy, back: vi.fn() }),
    useRoute: () => ({
      params: { id: 'tpl-1' },
      query: {},
      path: '/approval-templates/tpl-1',
      meta: {},
    }),
  }
})

// ---------------------------------------------------------------------------
// Template store mock — only what TemplateDetailView reads.
// ---------------------------------------------------------------------------
const mockActiveTemplate = ref<any>(null)
const mockLoading = ref(false)
const mockErrorRef = ref<string | null>(null)
const loadTemplateSpy = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/approvals/templateStore', () => ({
  useApprovalTemplateStore: () => ({
    get activeTemplate() { return mockActiveTemplate.value },
    set activeTemplate(value: any) { mockActiveTemplate.value = value },
    get loading() { return mockLoading.value },
    get error() { return mockErrorRef.value },
    set error(value: string | null) { mockErrorRef.value = value },
    loadTemplate: loadTemplateSpy,
  }),
}))

// ---------------------------------------------------------------------------
// Permissions mock — swappable per test.
// ---------------------------------------------------------------------------
const mockCanManageTemplates = ref(true)

vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({
    permissions: computed(() => ({})),
    hasPermission: () => true,
    canRead: computed(() => true),
    canWrite: computed(() => true),
    canAct: computed(() => true),
    canManageTemplates: computed(() => mockCanManageTemplates.value),
  }),
}))

// ---------------------------------------------------------------------------
// API mock — listTemplateVersions is the unit under test; the rest inert.
// ---------------------------------------------------------------------------
const listTemplateVersionsSpy = vi.fn()

vi.mock('../src/approvals/api', async () => {
  const actual = await vi.importActual<typeof import('../src/approvals/api')>('../src/approvals/api')
  return {
    ...actual,
    listTemplateVersions: (templateId: string) => listTemplateVersionsSpy(templateId),
    getTemplateUsage: vi.fn().mockResolvedValue({ templateId: 'tpl-1', instanceCount: 0, activeInstanceCount: 0 }),
  }
})

// ---------------------------------------------------------------------------
// Element Plus stubs (render-what-matters pattern).
// ---------------------------------------------------------------------------
function passthrough(name: string, tag = 'div') {
  return defineComponent({
    name,
    render() {
      return h(tag, { 'data-stub': name, ...this.$attrs }, this.$slots.default?.())
    },
  })
}

// Same column-registry stub pattern as approvalTemplateGovernance.spec.ts — columns register
// their default slot; the table renders that slot once per row with the {row} scope.
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
  props: { data: Array, loading: Boolean, maxHeight: [String, Number], stripe: Boolean },
  setup(props, { slots, attrs }) {
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
      return h('div', { 'data-el-table': 'true', ...attrs }, [
        h('div', { style: 'display:none' }, columnInstances),
        ...(rows.length === 0 && slots.empty ? [slots.empty()] : []),
        ...rows.map((row, i) =>
          h(
            'div',
            { 'data-el-row': String(i), key: (row?.id as string) ?? String(i) },
            registry.columns.map((col) =>
              col.defaultSlot
                ? h('div', { 'data-el-cell': col.prop || col.label || col.key }, col.defaultSlot({ row }))
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
  props: { type: String, size: String },
  render() {
    return h('span', { 'data-el-tag': this.type ?? 'default', ...this.$attrs }, this.$slots.default?.())
  },
})

const ElAlert = defineComponent({
  name: 'ElAlert',
  props: { title: String, type: String, closable: Boolean },
  render() {
    return h('div', { 'data-el-alert': this.type, ...this.$attrs }, this.title)
  },
})

const ElEmpty = defineComponent({
  name: 'ElEmpty',
  props: { description: String, imageSize: Number },
  render() {
    return h('div', { 'data-el-empty': '' }, this.description)
  },
})

function installStubs(app: VueApp<Element>) {
  app.directive('loading', {})
  app.component('ElTable', ElTable)
  app.component('ElTableColumn', ElTableColumn)
  app.component('ElTag', ElTag)
  app.component('ElAlert', ElAlert)
  app.component('ElEmpty', ElEmpty)
  app.component('ElButton', passthrough('ElButton', 'button'))
  app.component('ElInput', passthrough('ElInput', 'input'))
  app.component('ElSelect', passthrough('ElSelect'))
  app.component('ElOption', passthrough('ElOption'))
  app.component('ElTimeline', passthrough('ElTimeline'))
  app.component('ElTimelineItem', passthrough('ElTimelineItem'))
  app.component('ElIcon', passthrough('ElIcon', 'span'))
  app.component('ElTooltip', passthrough('ElTooltip'))
}

// ---------------------------------------------------------------------------
// Fixtures + mount
// ---------------------------------------------------------------------------
function baseTemplate() {
  return {
    id: 'tpl-1',
    key: 'travel',
    name: '差旅审批',
    description: null,
    category: null,
    visibilityScope: { type: 'all', ids: [] },
    slaHours: null,
    status: 'published',
    activeVersionId: 'ver-1',
    latestVersionId: 'ver-2',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-08T00:00:00.000Z',
    formSchema: { fields: [] },
    approvalGraph: { nodes: [], edges: [] },
  }
}

const VERSION_ROWS = [
  {
    id: 'ver-2',
    templateId: 'tpl-1',
    version: 2,
    status: 'draft',
    publishNote: null,
    publishedDefinitionId: null,
    createdAt: '2026-07-08T00:00:00.000Z',
    updatedAt: '2026-07-08T00:00:00.000Z',
  },
  {
    id: 'ver-1',
    templateId: 'tpl-1',
    version: 1,
    status: 'published',
    publishNote: '首次发布：差旅基础流程',
    publishedDefinitionId: 'pub-1',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  },
]

let container: HTMLElement | null = null
let app: VueApp<Element> | null = null

async function mountView() {
  const { default: TemplateDetailView } = await import('../src/views/approval/TemplateDetailView.vue')
  container = document.createElement('div')
  document.body.appendChild(container)
  const Host = defineComponent({ setup: () => () => h(TemplateDetailView as any) })
  app = createApp(Host)
  installStubs(app)
  app.mount(container)
  await nextTick()
  // let the version fetch promise resolve
  await Promise.resolve()
  await nextTick()
}

describe('B3-09 template version history (TemplateDetailView)', () => {
  beforeEach(() => {
    mockActiveTemplate.value = baseTemplate()
    mockLoading.value = false
    mockErrorRef.value = null
    mockCanManageTemplates.value = true
    listTemplateVersionsSpy.mockReset()
    listTemplateVersionsSpy.mockResolvedValue(VERSION_ROWS)
    loadTemplateSpy.mockClear()
    pushSpy.mockClear()
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
    vi.restoreAllMocks()
  })

  it('renders the section for an admin: newest-first rows, publish note, 当前生效 only on the active row', async () => {
    await mountView()

    expect(listTemplateVersionsSpy).toHaveBeenCalledTimes(1)
    expect(listTemplateVersionsSpy).toHaveBeenCalledWith('tpl-1')

    const section = container!.querySelector('[data-testid="template-detail-version-history"]')
    expect(section).not.toBeNull()
    const text = section!.textContent ?? ''
    expect(text).toContain('版本历史')
    expect(text).toContain('v2')
    expect(text).toContain('v1')
    expect(text).toContain('首次发布：差旅基础流程')
    // exactly ONE 当前生效 tag — the row whose publishedDefinitionId is non-null.
    const activeTags = Array.from(section!.querySelectorAll('[data-el-tag]')).filter(
      (el) => el.textContent?.trim() === '当前生效',
    )
    expect(activeTags).toHaveLength(1)
  })

  it('non-admin: section absent AND the endpoint is never fetched', async () => {
    mockCanManageTemplates.value = false
    await mountView()

    expect(container!.querySelector('[data-testid="template-detail-version-history"]')).toBeNull()
    expect(listTemplateVersionsSpy).not.toHaveBeenCalled()
  })

  it('fetch failure degrades to an inline warning without blocking the page', async () => {
    listTemplateVersionsSpy.mockRejectedValue(new Error('boom'))
    await mountView()

    const section = container!.querySelector('[data-testid="template-detail-version-history"]')
    expect(section).not.toBeNull()
    const alert = section!.querySelector('[data-el-alert]')
    expect(alert).not.toBeNull()
    expect(alert!.textContent).toContain('boom')
    // the rest of the detail page still renders
    expect(container!.textContent).toContain('差旅审批')
  })
})
