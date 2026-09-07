/**
 * Report item O-8 (approval UI locale consistency) — TemplateCenterView i18n retrofit.
 *
 * Root cause (see the O-8 report): TemplateCenterView.vue never called `useLocale()` at all —
 * every visible string (header, filters, tabs, table/gallery chrome, toasts, dialog titles) was
 * an unconditional Chinese literal, and the two `<StatusTag ... force-locale="zh">` usages pinned
 * the status badge to Chinese regardless of the app shell's locale. This is the SAME `useLocale()`
 * module-scope singleton App.vue and the rest of the locale-aware surface already read (see
 * apps/web/src/composables/useLocale.ts) — the fix wires this page into that existing source,
 * mirroring the `ZH`/`EN` + `t = computed(...)` convention ApprovalBatchTransferView.vue
 * established in this same directory (apps/web/tests/approvalBatchTransferView.spec.ts is the
 * "neighbouring spec" this file's mount/guard pattern is copied from, including
 * `renderedTextAndAttributes()` and pinning ElMessageBox.confirm's call args, not just the DOM).
 *
 * RED-before: reverting TemplateCenterView.vue to the pre-retrofit hardcoded strings makes the
 * "en" tests below fail (the page would render Chinese regardless of locale) and the "zh" tests
 * pass by coincidence (same literal). Reverting a single EN table entry to Chinese reddens only
 * the matching "en" assertion + the CJK guard sweep; reverting a single ZH table entry to English
 * reddens only the matching "zh" assertion.
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
import { useLocale } from '../src/composables/useLocale'

const pushSpy = vi.fn().mockResolvedValue(undefined)

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: pushSpy, back: vi.fn() }),
    useRoute: () => ({ params: {}, query: {}, path: '/approval-templates', meta: {} }),
  }
})

// ---------------------------------------------------------------------------
// Store / permissions / api mocks — only the bits TemplateCenterView reads or writes. Mirrors
// approvalTemplateGovernance.spec.ts's mock shape (this view's established spec convention).
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

const mockCanWrite = ref(true)
const mockCanManageTemplates = ref(true)

vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({
    canWrite: mockCanWrite,
    canManageTemplates: mockCanManageTemplates,
    canRead: ref(true),
    canAct: ref(true),
  }),
}))

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

const elSuccessSpy = vi.fn()
const elErrorSpy = vi.fn()
const confirmSpy = vi.fn().mockResolvedValue(undefined)

vi.mock('element-plus', () => ({
  ElMessage: { success: elSuccessSpy, error: elErrorSpy },
  ElMessageBox: { confirm: (...a: unknown[]) => confirmSpy(...a) },
}))

// ---------------------------------------------------------------------------
// Element Plus stubs — same shape as approvalTemplateGovernance.spec.ts.
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

type ColumnRegistryEntry = { key: string; prop?: string; label?: string; defaultSlot?: Slot }
type ColumnRegistry = { columns: ColumnRegistryEntry[]; register: (entry: ColumnRegistryEntry) => void }
const COLUMN_REGISTRY_KEY = Symbol('el-table-columns')

const ElTable = defineComponent({
  name: 'ElTable',
  props: { data: Array, loading: Boolean },
  setup(props, { slots }) {
    const registry = reactive<ColumnRegistry>({ columns: [], register(entry) { registry.columns.push(entry) } })
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
                ? h('div', { 'data-el-cell': col.prop || col.label || col.key }, col.defaultSlot({ row }))
                : h('div', { 'data-el-cell-header': col.prop || col.label }, ''),
            ),
          ),
        ),
        // The real el-table renders <template #empty> when `data` is empty.
        rows.length === 0 ? h('div', { 'data-el-table-empty': 'true' }, slots.empty?.()) : null,
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
      registry.register({ key: `col-${columnSeq++}`, prop: props.prop, label: props.label, defaultSlot: slots.default })
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
  props: { modelValue: String, placeholder: String, clearable: Boolean, size: String },
  emits: ['update:modelValue', 'clear'],
  render() {
    return h('input', { 'data-el-input': 'true', value: this.modelValue, placeholder: this.placeholder }, this.$slots.prefix?.())
  },
})

const ElSelect = defineComponent({
  name: 'ElSelect',
  props: { modelValue: [String, Array], placeholder: String, clearable: Boolean },
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
      [h('option', { value: '', key: '__empty__' }, this.placeholder ?? ''), ...(this.$slots.default?.() ?? [])],
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
    return h('div', { 'data-el-alert': this.type }, [this.title, this.$slots.default?.()])
  },
})

const ElEmpty = defineComponent({
  name: 'ElEmpty',
  props: { description: String, imageSize: Number },
  render() {
    return h('div', { 'data-el-empty': 'true' }, this.description)
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
    return h('div', { class: 'el-card' }, [this.$slots.default?.()])
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
    name: 'Business trip request',
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

// Whole rendered page, including every aria-label/placeholder/title attribute — the same sweep
// approvalBatchTransferView.spec.ts uses so a Chinese literal can't hide in an attribute the
// plain-textContent check would miss.
function renderedTextAndAttributes(root: HTMLElement): string {
  const parts = [root.textContent ?? '']
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const attr of ['aria-label', 'placeholder', 'title']) {
      const value = el.getAttribute(attr)
      if (value) parts.push(value)
    }
  }
  return parts.join(' | ')
}

const CJK = /[一-鿿]/

describe('TemplateCenterView — i18n retrofit (report item O-8)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mockTemplates.value = [buildTemplate({})]
    mockLoading.value = false
    mockError.value = null
    mockTotal.value = mockTemplates.value.length
    mockCanWrite.value = true
    mockCanManageTemplates.value = true

    loadTemplatesSpy.mockClear()
    listTemplateCategoriesSpy.mockClear().mockResolvedValue([])
    cloneTemplateSpy.mockClear()
    getTemplateUsageSpy.mockClear().mockResolvedValue({ templateId: 'tpl_a', instanceCount: 4, activeInstanceCount: 1 })
    archiveTemplateSpy.mockClear().mockResolvedValue({ id: 'tpl_a', status: 'archived' })
    unarchiveTemplateSpy.mockClear().mockResolvedValue({ id: 'tpl_a', status: 'published' })
    confirmSpy.mockClear().mockResolvedValue(undefined)
    elSuccessSpy.mockClear()
    elErrorSpy.mockClear()
    pushSpy.mockClear()

    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  async function mountView() {
    const { default: TemplateCenterView } = await import('../src/views/approval/TemplateCenterView.vue')
    const Host = defineComponent({ setup: () => () => h(TemplateCenterView as any) })
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
    app.component('ElIcon', ElIcon)
    app.component('ElCard', ElCard)
    app.directive('loading', stubDirective)
    app.mount(container!)
    await flushUi()
    return container!
  }

  function setLocale(locale: 'en' | 'zh-CN') {
    window.localStorage.setItem('metasheet_locale', locale)
    useLocale().setLocale(locale)
  }

  it('renders every admin-table chrome string in English when the locale is "en"', async () => {
    setLocale('en')
    mockTemplates.value = [
      buildTemplate({ id: 'tpl_pub', status: 'published', category: 'Travel', visibilityScope: { type: 'role', ids: ['manager', 'finance'] } }),
      buildTemplate({ id: 'tpl_draft', status: 'draft', category: null }),
      buildTemplate({ id: 'tpl_arch', status: 'archived' }),
    ]
    const root = await mountView()

    expect(root.querySelector('.template-center__header')?.textContent).toContain('Approval Templates')
    expect(root.querySelector('[data-el-select] option')?.textContent).toBe('All categories')
    expect(root.querySelector('[data-el-input]')?.getAttribute('placeholder')).toBe('Search template name')
    expect(root.querySelector('[data-testid="template-center-new-button"]')?.textContent).toBe('New template')
    expect(root.querySelector('[data-testid="template-center-delegations-link"]')?.textContent).toBe('Delegations')

    const tabLabels = Array.from(root.querySelectorAll('[data-tab-pane]')).map((p) => p.getAttribute('data-tab-label'))
    expect(tabLabels).toEqual(['All', 'Published', 'Draft', 'Archived'])

    // Column HEADER text is not observable through this file's ElTable/ElTableColumn stub — it
    // only renders per-row cell content (mirroring approvalTemplateGovernance.spec.ts's own
    // stub), so a column's `:label` binding is not asserted on directly by name. It IS exercised
    // indirectly: the two `[data-el-cell="<label>"]` selectors just below key on the RESOLVED
    // `t.colCategory`/`t.colVisibility` string, so they only match (rather than returning null)
    // when that binding resolved to the expected locale's text — a wrong/missing label would
    // fail those two lookups, not silently pass.
    //
    // Row chrome: category empty state, visibility summary, status badge, action buttons. The
    // visibility/category cells carry no data-testid of their own (ElTag's stub drops unknown
    // attrs), so they're read via the `[data-el-cell="<resolved column label>"]` the stub keys
    // slot-bearing columns on.
    expect(root.querySelector('[data-el-row="1"] [data-el-cell="Category"]')?.textContent?.trim()).toBe('Uncategorized')
    expect(root.querySelector('[data-el-row="0"] [data-el-cell="Visibility"]')?.textContent?.trim()).toBe('Role 2')
    expect(root.querySelector('[data-el-row="0"] [data-domain="approvalTemplate"]')?.textContent).toBe('Published')
    expect(root.querySelector('[data-el-row="1"] [data-domain="approvalTemplate"]')?.textContent).toBe('Draft')
    expect(root.querySelector('[data-el-row="2"] [data-domain="approvalTemplate"]')?.textContent).toBe('Archived')
    expect(root.querySelector('[data-el-row="0"] button')?.textContent).toBe('Start request')
    expect(root.querySelector('[data-testid="template-center-clone-button"]')?.textContent).toBe('Clone')
    expect(root.querySelector('[data-testid="template-center-archive-button"]')?.textContent).toBe('Disable')
    expect(root.querySelector('[data-testid="template-center-unarchive-button"]')?.textContent).toBe('Enable')

    expect(renderedTextAndAttributes(root)).not.toMatch(CJK)
  })

  it('renders every admin-table chrome string in Chinese when the locale is "zh-CN"', async () => {
    setLocale('zh-CN')
    mockTemplates.value = [
      buildTemplate({ id: 'tpl_pub', status: 'published', category: '差旅', visibilityScope: { type: 'dept', ids: ['sales'] } }),
    ]
    const root = await mountView()

    expect(root.querySelector('.template-center__header')?.textContent).toContain('审批模板')
    expect(root.querySelector('[data-el-select] option')?.textContent).toBe('全部分类')
    expect(root.querySelector('[data-el-input]')?.getAttribute('placeholder')).toBe('搜索模板名称')
    expect(root.querySelector('[data-testid="template-center-new-button"]')?.textContent).toBe('新建模板')
    expect(root.querySelector('[data-testid="template-center-delegations-link"]')?.textContent).toBe('委托管理')

    const tabLabels = Array.from(root.querySelectorAll('[data-tab-pane]')).map((p) => p.getAttribute('data-tab-label'))
    expect(tabLabels).toEqual(['全部', '已发布', '草稿', '已归档'])

    expect(root.querySelector('[data-el-cell="可见范围"]')?.textContent?.trim()).toBe('部门 1')
    expect(root.querySelector('[data-domain="approvalTemplate"]')?.textContent).toBe('已发布')
    expect(root.querySelector('[data-el-row="0"] button')?.textContent).toBe('发起审批')
    expect(root.querySelector('[data-testid="template-center-clone-button"]')?.textContent).toBe('克隆')
    expect(root.querySelector('[data-testid="template-center-archive-button"]')?.textContent).toBe('停用')
  })

  it('admin-table empty state follows locale (search vs default copy) in English', async () => {
    setLocale('en')
    mockTemplates.value = []
    const root = await mountView()
    expect(root.querySelector('[data-el-empty]')?.textContent).toBe('No approval templates yet — click New template to start')
    expect(renderedTextAndAttributes(root)).not.toMatch(CJK)
  })

  it('admin-table empty state follows locale (search vs default copy) in Chinese', async () => {
    setLocale('zh-CN')
    mockTemplates.value = []
    const root = await mountView()
    expect(root.querySelector('[data-el-empty]')?.textContent).toBe('暂无审批模板，点击新建模板开始')
  })

  it('requester gallery (non-manager) renders English chrome, including the start button and empty state', async () => {
    setLocale('en')
    mockCanManageTemplates.value = false
    mockTemplates.value = [buildTemplate({ id: 'tpl_pub', status: 'published', category: null })]
    const root = await mountView()

    expect(root.querySelector('[data-el-table]')).toBeFalsy()
    expect(root.querySelector('[data-testid="template-center-gallery"]')).toBeTruthy()
    const startBtn = root.querySelector('[data-testid="template-center-gallery-start-button"]')
    expect(startBtn?.textContent).toBe('Start request')
    expect(root.querySelector('.template-center__category-empty')?.textContent).toBe('Uncategorized')

    if (app) app.unmount()
    mockTemplates.value = []
    const root2 = await mountView()
    // EmptyState.vue renders `title` as TEXT (a <p>), not an HTML title= attribute.
    expect(root2.querySelector('[data-testid="template-center-gallery-empty"]')?.textContent?.trim()).toBe('No approval templates available')
    expect(renderedTextAndAttributes(root2)).not.toMatch(CJK)
  })

  it('requester gallery (non-manager) renders Chinese chrome, including the start button and empty state', async () => {
    setLocale('zh-CN')
    mockCanManageTemplates.value = false
    mockTemplates.value = [buildTemplate({ id: 'tpl_pub', status: 'published' })]
    const root = await mountView()
    expect(root.querySelector('[data-testid="template-center-gallery-start-button"]')?.textContent).toBe('发起申请')

    if (app) app.unmount()
    mockTemplates.value = []
    const root2 = await mountView()
    expect(root2.querySelector('[data-testid="template-center-gallery-empty"]')?.textContent?.trim()).toBe('暂无可用的审批模板')
  })

  it('archive dialog title/buttons and the success toast are English under "en"', async () => {
    setLocale('en')
    mockTemplates.value = [buildTemplate({ id: 'tpl_pub', status: 'published' })]
    const root = await mountView()

    root.querySelector<HTMLButtonElement>('[data-testid="template-center-archive-button"]')!.click()
    await flushUi()

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(String(confirmSpy.mock.calls[0][1])).toBe('Disable template')
    expect((confirmSpy.mock.calls[0][2] as any).confirmButtonText).toBe('Disable')
    expect((confirmSpy.mock.calls[0][2] as any).cancelButtonText).toBe('Cancel')
    // NOT asserted CJK-free: the confirm BODY comes from templateArchiveConfirmMessage(), which
    // this slice deliberately left untouched (shared with the out-of-scope TemplateDetailView.vue
    // — see the O-8 report's couldNotDo). Only the dialog's title/buttons are this file's scope.

    await flushUi()
    expect(elSuccessSpy).toHaveBeenCalledWith('Template disabled')
  })

  it('archive dialog title/buttons and the success toast are Chinese under "zh-CN"', async () => {
    setLocale('zh-CN')
    mockTemplates.value = [buildTemplate({ id: 'tpl_pub', status: 'published' })]
    const root = await mountView()

    root.querySelector<HTMLButtonElement>('[data-testid="template-center-archive-button"]')!.click()
    await flushUi()

    expect(String(confirmSpy.mock.calls[0][1])).toBe('停用模板')
    expect((confirmSpy.mock.calls[0][2] as any).confirmButtonText).toBe('停用')
    expect((confirmSpy.mock.calls[0][2] as any).cancelButtonText).toBe('取消')

    await flushUi()
    expect(elSuccessSpy).toHaveBeenCalledWith('已停用模板')
  })

  it('unarchive dialog title/buttons and the success toast are English under "en"', async () => {
    setLocale('en')
    mockTemplates.value = [buildTemplate({ id: 'tpl_arch', status: 'archived' })]
    const root = await mountView()

    root.querySelector<HTMLButtonElement>('[data-testid="template-center-unarchive-button"]')!.click()
    await flushUi()

    expect(String(confirmSpy.mock.calls[0][1])).toBe('Enable template')
    expect((confirmSpy.mock.calls[0][2] as any).confirmButtonText).toBe('Enable')

    await flushUi()
    expect(elSuccessSpy).toHaveBeenCalledWith('Template enabled')
  })

  it('clone success toast is locale-correct in both directions', async () => {
    setLocale('en')
    mockTemplates.value = [buildTemplate({ id: 'tpl_pub', status: 'published', name: 'Business trip request' })]
    cloneTemplateSpy.mockResolvedValueOnce({ id: 'tpl_clone_1', name: 'Business trip request (copy)', visibilityScope: { type: 'all', ids: [] } })
    const root = await mountView()
    root.querySelector<HTMLButtonElement>('[data-testid="template-center-clone-button"]')!.click()
    await flushUi()
    expect(elSuccessSpy).toHaveBeenCalledWith('Template cloned: Business trip request (copy)')

    if (app) app.unmount()
    setLocale('zh-CN')
    cloneTemplateSpy.mockResolvedValueOnce({ id: 'tpl_clone_2', name: '出差申请 (副本)', visibilityScope: { type: 'all', ids: [] } })
    const root2 = await mountView()
    root2.querySelector<HTMLButtonElement>('[data-testid="template-center-clone-button"]')!.click()
    await flushUi()
    expect(elSuccessSpy).toHaveBeenCalledWith('已克隆模板：出差申请 (副本)')
  })

  // -------------------------------------------------------------------------
  // Guard: no CJK literal survives outside templateCenterLabels.ts's ZH table. Mechanical scan
  // of the one file this slice converted — a closed list scoped to this slice (report item O-8),
  // not a discovery scan over the whole approval module. Comments and other approval views are
  // out of scope and untouched; see couldNotDo in the O-8 report for what else remains hardcoded.
  // -------------------------------------------------------------------------
  it('guard: TemplateCenterView.vue has no CJK literal in its template or script outside templateCenterLabels.ts', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const CONVERTED_FILES = ['../src/views/approval/TemplateCenterView.vue']
    for (const rel of CONVERTED_FILES) {
      const abs = path.resolve(__dirname, rel)
      const source = fs.readFileSync(abs, 'utf-8')
      const noStyle = source.replace(/<style[\s\S]*?<\/style>/g, '')
      // Strip HTML comments (which may span multiple lines — a naive per-line
      // `.startsWith('<!--')` check misses a continuation line of a multi-line block) and
      // block/line JS comments, THEN scan what remains for CJK. Line comments are stripped with
      // a regex rather than a full JS/TS tokenizer, so a CJK character inside a STRING literal
      // that happens to follow `//` on the same line would be missed — not a risk here since
      // every string this file's script section holds is either ASCII (ids/keys) or already
      // routed through templateCenterLabels.ts, which this guard does not scan.
      const noHtmlComments = noStyle.replace(/<!--[\s\S]*?-->/g, '')
      const noBlockComments = noHtmlComments.replace(/\/\*[\s\S]*?\*\//g, '')
      const codeLines = noBlockComments
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, ''))
      const offenders = codeLines.filter((line) => CJK.test(line))
      expect(offenders).toEqual([])
    }
  })
  // -------------------------------------------------------------------------
  // Verification round (2026-09-08): the tests above all set the locale BEFORE mountView(), so
  // they pass identically whether `t` is a reactive `computed` or a one-shot snapshot taken at
  // setup time. These two pin the property the slice actually claims — the surface FOLLOWS the
  // shared shell locale on a MOUNTED page, through both of useLocale's write paths:
  //   1. setLocale() — what App.vue's own switcher calls (App.vue:283).
  //   2. the 'storage' event — useLocale.ts:41-49's cross-tab listener, i.e. the shell locale
  //      changing in another tab.
  // Discriminating probe: replacing `const t = computed(() => (isZh.value ? ZH : EN))` with
  // `const t = ref(isZh.value ? ZH : EN)` leaves every other test in this file GREEN and turns
  // exactly these two RED.
  // -------------------------------------------------------------------------
  it('follows a post-mount shell locale change via setLocale() without remounting', async () => {
    setLocale('zh-CN')
    mockTemplates.value = [buildTemplate({ id: 'tpl_pub', status: 'published', category: null })]
    const root = await mountView()
    expect(root.querySelector('.template-center__header')?.textContent).toContain('审批模板')
    expect(root.querySelector('[data-testid="template-center-new-button"]')?.textContent).toBe('新建模板')

    // No remount, no re-import: flip the SAME singleton the app shell writes to.
    useLocale().setLocale('en')
    await flushUi()

    expect(root.querySelector('.template-center__header')?.textContent).toContain('Approval Templates')
    expect(root.querySelector('[data-testid="template-center-new-button"]')?.textContent).toBe('New template')
    expect(root.querySelector('[data-el-input]')?.getAttribute('placeholder')).toBe('Search template name')
    const tabLabels = Array.from(root.querySelectorAll('[data-tab-pane]')).map((p) => p.getAttribute('data-tab-label'))
    expect(tabLabels).toEqual(['All', 'Published', 'Draft', 'Archived'])
    // The status badge (StatusTag with no force-locale) must follow too, not stay pinned.
    expect(root.querySelector('[data-domain="approvalTemplate"]')?.textContent).toBe('Published')
    expect(renderedTextAndAttributes(root)).not.toMatch(CJK)
  })

  it('follows a post-mount shell locale change delivered as a cross-tab storage event', async () => {
    setLocale('en')
    mockTemplates.value = [buildTemplate({ id: 'tpl_pub', status: 'published', category: null })]
    const root = await mountView()
    expect(root.querySelector('.template-center__header')?.textContent).toContain('Approval Templates')

    window.localStorage.setItem('metasheet_locale', 'zh-CN')
    window.dispatchEvent(new StorageEvent('storage', { key: 'metasheet_locale', newValue: 'zh-CN' }))
    await flushUi()

    expect(root.querySelector('.template-center__header')?.textContent).toContain('审批模板')
    expect(root.querySelector('[data-testid="template-center-new-button"]')?.textContent).toBe('新建模板')
    expect(root.querySelector('[data-domain="approvalTemplate"]')?.textContent).toBe('已发布')
  })
})
