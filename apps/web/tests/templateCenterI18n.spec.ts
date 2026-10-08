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
 * pass by coincidence (same literal).
 *
 * Round-3 correction (verifier): this header previously claimed "reverting a single EN table
 * entry to Chinese reddens only the matching 'en' assertion + the CJK guard sweep". That was
 * FALSE for most keys. The mount tests below only assert the STRINGS THEY RENDER, and 13 of the
 * 42 EN values (and 16 of the 42 ZH values) are never rendered by any test here — e.g. setting
 * `EN.colName` to '表单名称' or `EN.visibilityAll` to '' reddened nothing across this spec,
 * approvalCenterDesktopEmptyTextI18n, approvalTemplateCenterCategory, templateGalleryFilter and
 * statusTag (verified by mutation). The CJK guard does NOT cover it either: it scans
 * TemplateCenterView.vue, not templateCenterLabels.ts. `EN: Record<keyof typeof ZH, string>`
 * makes vue-tsc enforce KEY PRESENCE only — never that a value is non-empty, translated, or not
 * a copy-pasted Chinese literal. The "locale label tables are complete and actually translated"
 * test below closes that: it asserts over the tables themselves, so it covers all 42 keys
 * whether or not a mount test happens to render them.
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
import { ZH, EN } from '../src/views/approval/templateCenterLabels'

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
// Resolves 'applied' because that is what the real `templateStore.loadTemplates` resolves when
// the read it issued is still the current one and succeeded (`ApprovalTemplateListOutcome`).
// TemplateCenterView lowers its flat-list stale bit only for that value, so a mock that
// resolved `undefined` would be a mock of a contract this store does not have.
const loadTemplatesSpy = vi.fn().mockResolvedValue('applied')

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
  // A-2 scope item 2 (design lock v2.13 §6 phase 1) — TemplateCenterView.vue mounts
  // ApprovalTemplateGroupsPanel.vue when canManageTemplates is true (the default in this file),
  // and that panel calls these two on mount/submit plus does an `instanceof ApprovalApiError`
  // check in its catch branch — all three must exist on this replacement mock or the panel's
  // onMounted throws unhandled (this spec makes no assertions about groups, so an empty resolved
  // list is enough).
  //
  // A-2 x A-4 convergence (2026-09-20): that mount is now GROUPED-view-only and behind the
  // group-manager disclosure toggle, so the rendered-page CJK sweeps below (all flat view) no
  // longer cover the panel's own markup. The panel keeps its dedicated file-level guard at the
  // bottom of this file ("guard: ApprovalTemplateGroupsPanel.vue has no CJK literal outside a
  // paired tr(en, zh) call"), which reads the file from disk and is unaffected by mounting.
  ApprovalApiError: class ApprovalApiError extends Error {},
  listApprovalTemplateGroups: () => Promise.resolve([]),
  createApprovalTemplateGroup: (name: string) => Promise.resolve({
    id: 'atg_test', orgId: 'org_test', name, sortOrder: 1,
    createdBy: 'test', createdAt: '', updatedAt: '', archivedAt: null,
  }),
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

// Round-2 fix (C6, NIT): widened from `[一-鿿]` (U+4E00–U+9FFF only) to also include the
// Halfwidth-and-Fullwidth-Forms block (U+FF00–U+FFEF) — fullwidth punctuation like `，`(U+FF0C)
// and `：`(U+FF1A), both present in templateCenterLabels.ts's ZH table, previously fell outside
// the class entirely, so a punctuation-only stray literal (no U+4E00–U+9FFF characters at all)
// would have passed every sweep and the guard below undetected.
//
// Round-3 fix (verifier): that widening still left the CJK Symbols and Punctuation block
// (U+3000–U+303F) out, so the round-2 claim that "a punctuation-only stray literal cannot pass
// undetected" was over-stated: the ideographic comma U+3001 and full stop U+3002 are the two most
// common Chinese punctuation marks of all and both sat outside the class. Verified by mutation —
// before this line, appending U+3002 to an EN label value AND inserting a bare U+3001/U+3002 pair
// into TemplateCenterView.vue's template together left all 16 tests green. Widening only ADDS
// detection, so every existing probe still reddens; and no value in either locale table, and no
// scanned line of either converted file, contains a U+3000–U+303F character today (the only two
// occurrences in TemplateCenterView.vue sit inside an HTML comment, which is stripped before the
// scan), so this is byte-equivalent in effect at this head — the unmutated 16/16 green run below
// is the positive control for that.
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/

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

    expect(root.querySelector('.template-center__header')?.textContent).toContain('审批表单')
    expect(root.querySelector('[data-el-select] option')?.textContent).toBe('全部分类')
    expect(root.querySelector('[data-el-input]')?.getAttribute('placeholder')).toBe('搜索表单名称')
    expect(root.querySelector('[data-testid="template-center-new-button"]')?.textContent).toBe('新建表单')
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
    expect(root.querySelector('[data-el-empty]')?.textContent).toBe('暂无审批表单，点击新建表单开始')
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
    expect(root2.querySelector('[data-testid="template-center-gallery-empty"]')?.textContent?.trim()).toBe('暂无可用的审批表单')
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

    expect(String(confirmSpy.mock.calls[0][1])).toBe('停用表单')
    expect((confirmSpy.mock.calls[0][2] as any).confirmButtonText).toBe('停用')
    expect((confirmSpy.mock.calls[0][2] as any).cancelButtonText).toBe('取消')

    await flushUi()
    expect(elSuccessSpy).toHaveBeenCalledWith('已停用表单')
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
    expect(elSuccessSpy).toHaveBeenCalledWith('已克隆表单：出差申请 (副本)')
  })

  // Round-2 fix (C1): every test above seeds the locale BEFORE mounting, so none of them can
  // distinguish a reactive read from a snapshot taken once at setup. This mounts in zh-CN, flips
  // the SAME shell locale source (`useLocale().setLocale`, exactly what App.vue's switcher calls)
  // AFTER mount, and asserts the already-mounted DOM re-renders in the new locale — then flips
  // back. Asserted on `t`-derived text specifically (header title, new-template button), not the
  // StatusTag badge: StatusTag reads `useLocale()` itself, so a badge-only assertion would stay
  // green even if THIS page's own `t` stopped following the locale — it would not discriminate
  // the mutation this test exists to catch.
  it('re-renders admin-table chrome when the shell locale flips AFTER mount, not just a mount-time snapshot', async () => {
    setLocale('zh-CN')
    mockTemplates.value = [buildTemplate({ id: 'tpl_pub', status: 'published' })]
    const root = await mountView()
    expect(root.querySelector('.template-center__header')?.textContent).toContain('审批表单')
    expect(root.querySelector('[data-testid="template-center-new-button"]')?.textContent).toBe('新建表单')
    expect(root.querySelector('[data-tab-pane="all"]')?.getAttribute('data-tab-label')).toBe('全部')

    setLocale('en')
    await flushUi()
    expect(root.querySelector('.template-center__header')?.textContent).toContain('Approval Templates')
    expect(root.querySelector('[data-testid="template-center-new-button"]')?.textContent).toBe('New template')
    expect(root.querySelector('[data-tab-pane="all"]')?.getAttribute('data-tab-label')).toBe('All')

    setLocale('zh-CN')
    await flushUi()
    expect(root.querySelector('.template-center__header')?.textContent).toContain('审批表单')
    expect(root.querySelector('[data-testid="template-center-new-button"]')?.textContent).toBe('新建表单')
    expect(root.querySelector('[data-tab-pane="all"]')?.getAttribute('data-tab-label')).toBe('全部')
  })

  // Round-2 fix (C2): `formatDate` (TemplateCenterView.vue) branches on `isZh.value` with zero
  // prior coverage. Pins BOTH locales' output: the repo convention (approval-detail-field.test.ts)
  // of comparing against `new Date(x).toLocaleString(locale)` computed inline (timezone-
  // independent, since both sides run in the same process), PLUS a structural shape regex so the
  // two locales are pinned as actually DIFFERENT shapes (comma + AM/PM for en-US vs a bare 24h
  // clock for zh-CN), not just "whatever toLocaleString happens to return today". Seeded before
  // mount in each locale (unmount/remount), not flip-based, so this stays independent of the C1
  // flip-mutation above.
  it('table date columns (Last updated / Created) follow the locale format, not a hardcoded zh-CN one', async () => {
    const template = buildTemplate({
      id: 'tpl_pub',
      status: 'published',
      updatedAt: '2026-04-10T10:00:00Z',
      createdAt: '2026-01-02T03:04:05Z',
    })

    setLocale('en')
    mockTemplates.value = [template]
    const root = await mountView()
    const updatedEn = root.querySelector('[data-el-row="0"] [data-el-cell="Last updated"]')?.textContent?.trim()
    const createdEn = root.querySelector('[data-el-row="0"] [data-el-cell="Created"]')?.textContent?.trim()
    expect(updatedEn).toBe(new Date(template.updatedAt).toLocaleString('en-US'))
    expect(createdEn).toBe(new Date(template.createdAt).toLocaleString('en-US'))
    expect(updatedEn).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4},\s\d{1,2}:\d{2}:\d{2}\s?(AM|PM)$/)

    if (app) app.unmount()
    setLocale('zh-CN')
    const root2 = await mountView()
    const updatedZh = root2.querySelector('[data-el-row="0"] [data-el-cell="最近更新"]')?.textContent?.trim()
    const createdZh = root2.querySelector('[data-el-row="0"] [data-el-cell="创建时间"]')?.textContent?.trim()
    expect(updatedZh).toBe(new Date(template.updatedAt).toLocaleString('zh-CN'))
    expect(createdZh).toBe(new Date(template.createdAt).toLocaleString('zh-CN'))
    expect(updatedZh).toMatch(/^\d{4}\/\d{1,2}\/\d{1,2}\s\d{1,2}:\d{2}:\d{2}$/)
  })

  // Round-2 fix (C3): removing `force-locale="zh"` from the GALLERY-CARD StatusTag had zero
  // coverage (the admin-table StatusTag's twin IS covered, via the [data-domain] assertions in
  // the "renders every admin-table chrome string" tests above). Mounts the requester gallery
  // (the only path that renders `template-center-gallery-card`) in both locales and reads the
  // badge specifically inside that card.
  it("requester gallery card's status badge follows the locale (not pinned via force-locale)", async () => {
    setLocale('en')
    mockCanManageTemplates.value = false
    mockTemplates.value = [buildTemplate({ id: 'tpl_pub', status: 'published' })]
    const root = await mountView()
    const cardEn = root.querySelector('[data-testid="template-center-gallery-card"]')
    expect(cardEn).toBeTruthy()
    expect(cardEn?.querySelector('[data-domain="approvalTemplate"]')?.textContent).toBe('Published')

    if (app) app.unmount()
    setLocale('zh-CN')
    const root2 = await mountView()
    const cardZh = root2.querySelector('[data-testid="template-center-gallery-card"]')
    expect(cardZh).toBeTruthy()
    expect(cardZh?.querySelector('[data-domain="approvalTemplate"]')?.textContent).toBe('已发布')
  })

  // Round-3 fix (verifier): the ZH/EN label tables had ZERO runtime coverage — every other test
  // in this file asserts rendered DOM, so it only reaches the subset of keys some test happens to
  // render (29 of 42 for EN, 26 of 42 for ZH). `EN: Record<keyof typeof ZH, string>` is a TYPE
  // constraint: it enforces that every ZH key exists in EN and nothing more. A Chinese string
  // sitting in the EN table, or an empty EN value, type-checks and renders — and the CJK guard
  // below scans TemplateCenterView.vue, never templateCenterLabels.ts, so it does not catch it
  // either. This asserts over the tables directly, so it holds for every key.
  it('locale label tables are complete and actually translated (all keys, both directions)', () => {
    const zhKeys = Object.keys(ZH).sort()
    const enKeys = Object.keys(EN).sort()

    // Vacuity control: if the tables were ever emptied or the import resolved to `{}`, every
    // per-key loop below would pass over zero entries. Pin the count is non-trivial first.
    expect(zhKeys.length).toBeGreaterThan(30)
    expect(enKeys).toEqual(zhKeys)

    const emptyZh: string[] = []
    const emptyEn: string[] = []
    const chineseInEn: string[] = []
    const untranslated: string[] = []
    const asciiOnlyZh: string[] = []

    for (const key of zhKeys) {
      const zhValue = ZH[key as keyof typeof ZH]
      const enValue = EN[key as keyof typeof ZH]
      if (zhValue.trim() === '') emptyZh.push(key)
      if (enValue.trim() === '') emptyEn.push(key)
      // The EN table must never carry a CJK character — that is an untranslated string shipped
      // to English users, exactly the class of defect this whole slice exists to remove.
      if (CJK.test(enValue)) chineseInEn.push(`${key}=${enValue}`)
      // A value copy-pasted across both tables is not a translation.
      if (zhValue === enValue) untranslated.push(key)
      // Positive control for the CJK class itself: every ZH value must MATCH it. If this list is
      // ever non-empty the `chineseInEn` check above may be silently vacuous (a CJK regex that
      // matches nothing would report zero offenders for a fully-Chinese EN table too).
      if (!CJK.test(zhValue)) asciiOnlyZh.push(`${key}=${zhValue}`)
    }

    expect(emptyZh).toEqual([])
    expect(emptyEn).toEqual([])
    expect(chineseInEn).toEqual([])
    expect(untranslated).toEqual([])
    expect(asciiOnlyZh).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Guard: no CJK literal survives outside a locale table, for every converted surface in this
  // slice (report item O-8). Round-2 fixes (C4/C5):
  //
  //  - C4: the previous `line.replace(/\/\/.*$/, '')` stripped from the FIRST `//` on a line
  //    unconditionally, which defeats the guard entirely when a CJK literal shares a line with a
  //    URL (`<a href="https://x/docs">最近使用</a>` — the `//` inside `https://` truncated
  //    everything after it, including the literal). Fixed by only treating `//` as a comment
  //    starter when nothing before it on the line contains a quote character — a genuine
  //    commented-out line has nothing but whitespace before `//`; a URL inside an attribute or a
  //    string literal always has an unclosed quote before it. See `stripLineCommentsConservatively`.
  //  - C5: the guard previously covered only TemplateCenterView.vue (converted in full).
  //    ApprovalCenterView.vue — this slice's OTHER converted file — is now covered too, but NOT
  //    via a whole-file sweep: that file is only PARTIALLY converted (just the `tabEmptyText`
  //    empty-text wiring), and the rest of its ~1800 lines are deliberately untouched, still-
  //    Chinese chrome, out of scope for this slice (tabs/filters/batch-toolbar/dialogs/etc. — see
  //    this slice's commit body). A whole-file scan would fire on hundreds of pre-existing,
  //    intentional literals unrelated to this change. So ApprovalCenterView.vue's guard is scoped
  //    to the converted CONSTRUCT: it allowlists the `tabEmptyText` computed's `isZh` branch BY
  //    NAME, with this reason (it is real Chinese-language DATA, not a stray untranslated
  //    string) — the file is not dropped from coverage, only the guard shape differs per file.
  // -------------------------------------------------------------------------
  const CONVERTED_FILES = [
    '../src/views/approval/TemplateCenterView.vue',
    '../src/views/approval/ApprovalCenterView.vue',
  ]

  // Strips a line's trailing `// ...` ONLY when nothing before the FIRST `//` on that line
  // contains a quote character (`'`, `"`, `` ` ``). A truly commented-out line has nothing but
  // whitespace before `//`, so it strips exactly as before. A `//` that is part of a URL inside a
  // quoted attribute or string (`<a href="https://…">`, `const u = 'https://…/中文'`) always has
  // an opening quote earlier on the same line, so this leaves the WHOLE line untouched instead of
  // truncating everything after the URL's `//` — the defeat this guard had. Tradeoff (intentional,
  // fail-closed): a genuine trailing comment after a quoted expression (`foo('bar') // 说明`)
  // would also be left unstripped and could false-positive the CJK check below — verified this
  // pattern occurs nowhere in either converted file (`grep -n "['"\`].*//"` over both: zero
  // matches), and the guard runs green on the unmodified files below, which is itself a positive
  // control that stripping still works for every REAL comment in both files.
  function stripLineCommentsConservatively(source: string): string {
    return source
      .split('\n')
      .map((line) => {
        const slashIdx = line.indexOf('//')
        if (slashIdx === -1) return line
        const before = line.slice(0, slashIdx)
        // Round-3 tightening (verifier): the round-2 rule was "strip unless something before the
        // `//` is a quote", which still stripped an UNQUOTED attribute — `<img src=//cdn/x.png
        // alt=\"\u6700\u8fd1\u4f7f\u7528\">` has no quote before `//`, so the whole line
        // including the CJK literal was deleted and the guard stayed green (verified by
        // mutation). Only a FULL-LINE comment is stripped now: nothing but whitespace may precede
        // the `//`. Verified byte-equivalent on both converted files at this head — neither has a
        // single line with any non-whitespace before a `//` (`grep -n '[^[:space:]/].*//'` over
        // both: zero matches) — and the guard's green run on the unmodified files is the positive
        // control that every REAL comment in them still strips.
        if (before.trim() !== '') return line
        return before
      })
      .join('\n')
  }

  // Extracts the source span of a balanced `{...}` starting at `openBraceIndex` (the character AT
  // that index must be `{`). Used to pull ApprovalCenterView.vue's `tabEmptyText` computed body,
  // and its nested `if (isZh.value) { ... }` block, out of the file without a full parser — both
  // are plain object-literal returns with no template strings or nested functions, so a bare
  // brace counter is sufficient.
  function extractBalanced(source: string, openBraceIndex: number): { text: string; endIndex: number } {
    let depth = 0
    for (let i = openBraceIndex; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) return { text: source.slice(openBraceIndex, i + 1), endIndex: i }
      }
    }
    throw new Error(`unbalanced braces starting at index ${openBraceIndex}`)
  }

  it('guard: TemplateCenterView.vue has no CJK literal in its template or script outside templateCenterLabels.ts', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const abs = path.resolve(__dirname, CONVERTED_FILES[0]!)
    const source = fs.readFileSync(abs, 'utf-8')
    // Strip HTML comments (which may span multiple lines — a naive per-line
    // `.startsWith('<!--')` check misses a continuation line of a multi-line block), block
    // comments, then line comments (conservatively — see stripLineCommentsConservatively above),
    // THEN scan what remains for CJK. Every string this file's script section holds is either
    // ASCII (ids/keys) or already routed through templateCenterLabels.ts, which this guard does
    // not scan.
    const noStyle = source.replace(/<style[\s\S]*?<\/style>/g, '')
    const noHtmlComments = noStyle.replace(/<!--[\s\S]*?-->/g, '')
    const noBlockComments = noHtmlComments.replace(/\/\*[\s\S]*?\*\//g, '')
    const stripped = stripLineCommentsConservatively(noBlockComments)
    const offenders = stripped.split('\n').filter((line) => CJK.test(line))
    expect(offenders).toEqual([])
  })

  it("guard: ApprovalCenterView.vue's converted tabEmptyText construct has no CJK literal outside its by-design ZH branch", async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const abs = path.resolve(__dirname, CONVERTED_FILES[1]!)
    const source = fs.readFileSync(abs, 'utf-8')

    // 1) Every `:empty-text="..."` binding (desktop ApprovalCenterTable + mobile
    //    ApprovalMobileList, 5 tabs × 2 layouts = 10) must read a `tabEmptyText.<key>` property
    //    path, never a hardcoded literal — this is exactly where the pre-fix bug lived (report
    //    item O-8). The length assertion guards against this silently becoming a vacuous 0-match
    //    check if the attribute is ever renamed.
    const emptyTextBindings = Array.from(source.matchAll(/:empty-text="([^"]*)"/g)).map((m) => m[1])
    expect(emptyTextBindings.length).toBe(10)
    for (const binding of emptyTextBindings) {
      expect(binding).toMatch(/^tabEmptyText\.[a-zA-Z]+$/)
    }

    // 2) tabEmptyText's own body: the `if (isZh.value) { ... }` branch is real Chinese-language
    //    DATA by design (the construct report item C5 names) and is allowlisted here, BY NAME,
    //    with this reason — not by excluding the rest of the file. Everything else in the
    //    computed (the English `return` branch) must be CJK-free like any other converted surface.
    const computedMarker = 'const tabEmptyText = computed(() => {'
    const computedStart = source.indexOf(computedMarker)
    expect(computedStart).toBeGreaterThan(-1)
    const { text: computedBody } = extractBalanced(source, computedStart + computedMarker.length - 1)

    const ifMarker = 'if (isZh.value) {'
    const ifStart = computedBody.indexOf(ifMarker)
    expect(ifStart).toBeGreaterThan(-1)
    const { text: allowedZhBranch, endIndex: ifEnd } = extractBalanced(
      computedBody,
      ifStart + ifMarker.length - 1,
    )
    // Sanity: the allowlisted span really is the ZH data, not an extraction bug that silently
    // allowlists nothing (which would make this whole check vacuous).
    expect(CJK.test(allowedZhBranch)).toBe(true)

    const englishBranch = computedBody.slice(0, ifStart) + computedBody.slice(ifEnd + 1)
    const offenders = englishBranch.split('\n').filter((line) => CJK.test(line))
    expect(offenders).toEqual([])
  })

  // P3 hygiene wave (2026-09-19), closing gate impl-gate-A2-round1-20260918.md's P3-8: the A-2
  // template-groups slice added two new user-facing approval surfaces
  // (SessionOrgSwitcher.vue, ApprovalTemplateGroupsPanel.vue) that sit outside every existing
  // closed-world file list in this guard (CONVERTED_FILES above only ever names the two files the
  // ORIGINAL i18n slice converted; it is read by index in the two tests above, not iterated, so a
  // new file never gets swept just by being added to that array — it needs its own assertion,
  // which is what these two tests are). Neither file routes through an external labels file the
  // way TemplateCenterView.vue does, so a bare whole-file sweep (first attempt, reverted) false-
  // positived on their OWN legitimate bilingual copy — each gets its own allowlisted-construct
  // guard instead, same shape as the ApprovalCenterView.vue guard above.

  function stripNonCode(source: string): string {
    const noStyle = source.replace(/<style[\s\S]*?<\/style>/g, '')
    const noHtmlComments = noStyle.replace(/<!--[\s\S]*?-->/g, '')
    const noBlockComments = noHtmlComments.replace(/\/\*[\s\S]*?\*\//g, '')
    return stripLineCommentsConservatively(noBlockComments)
  }

  it("guard: SessionOrgSwitcher.vue has no CJK literal outside its DEFAULT_COPY bilingual table", async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const abs = path.resolve(__dirname, '../src/components/SessionOrgSwitcher.vue')
    const source = fs.readFileSync(abs, 'utf-8')
    const stripped = stripNonCode(source)

    const marker = 'const DEFAULT_COPY: SessionOrgSwitcherCopy = {'
    const markerStart = stripped.indexOf(marker)
    expect(markerStart).toBeGreaterThan(-1)
    const { text: defaultCopySpan, endIndex } = extractBalanced(stripped, markerStart + marker.length - 1)
    // Sanity: the allowlisted span really is the bilingual table (every `[en, zh]` tuple), not an
    // extraction bug that silently allowlists nothing.
    expect(CJK.test(defaultCopySpan)).toBe(true)

    const rest = stripped.slice(0, markerStart) + stripped.slice(endIndex + 1)
    const offenders = rest.split('\n').filter((line) => CJK.test(line))
    expect(offenders).toEqual([])
  })

  it('guard: ApprovalTemplateGroupsPanel.vue has no CJK literal outside a paired tr(en, zh) call', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const abs = path.resolve(__dirname, '../src/views/approval/ApprovalTemplateGroupsPanel.vue')
    const source = fs.readFileSync(abs, 'utf-8')
    const stripped = stripNonCode(source)

    // Every user-visible string in this panel is a direct `tr('English', '中文')` call (no labels
    // table, unlike TemplateCenterView.vue / SessionOrgSwitcher.vue) — a line is allowlisted only
    // when the CJK literal is paired with an English literal in the SAME `tr(...)` call, which is
    // exactly what "translated" means here; anything else with CJK on it is a stray, untranslated
    // string this guard exists to catch.
    const pairedTrCall = /tr\('[^']*',\s*'[^']*'\)/
    const lines = stripped.split('\n')
    const pairedLines = lines.filter((line) => pairedTrCall.test(line))
    // Sanity: this file really does have paired tr(en, zh) calls — otherwise the allowlist below
    // is vacuous and this test degrades to a (still-valid, but weaker) whole-file CJK sweep.
    expect(pairedLines.length).toBeGreaterThan(0)
    for (const line of pairedLines) expect(CJK.test(line)).toBe(true)

    const offenders = lines.filter((line) => CJK.test(line) && !pairedTrCall.test(line))
    expect(offenders).toEqual([])
  })
})

// -------------------------------------------------------------------------------------------------
// O-8 / slice F8-1 (approval member surface) — per-file source guard over EVERY non-test file the
// slice changed: the member views (center / table / detail pane / mobile list / detail / comments /
// new / my-delegation / card decision), their label tables, the three shared pickers, and the
// approval helpers whose copy those views render. Same shape as templateDetailI18n.spec.ts's guard
// (#5545): strip `<style>`, HTML comments, block comments and full-line `//` comments; take out each
// recognised locale construct, checking its English side has no CJK; presence-check the named
// exceptions by exact line text and occurrence count; any other line with CJK left in the file is
// red. Every construct count is pinned per file (vacuity guard): a construct regex that stopped
// matching changes a count, and whatever it stopped covering falls through to the blanket scan.
//
// Recognised constructs (and nothing broader):
//   ternary        `isZh ? '<zh>' : '<en>'` (also `isZh.value` / `isZh()`), string/template literals
//   objectTernary  `isZh.value ? { <zh> } : { <en> }`
//   ifZhBlock      `if (isZh.value) { return { <zh> } } return { <en> }`
//   zhTable        `const X_ZH = { … }`, only with a CJK-free `const X_EN = { … }` in the same file
//   constPair      `const X = '<zh>'`, only with a CJK-free `const X_EN = '<en>'` in the same file
//
// This is a tripwire, not a proof. Known ways past it: CJK written as `\u` escapes or built with
// String.fromCharCode; CJK kept in a module that is not in RULES (e.g. quickPhrases.ts,
// amountInWords.ts) or passed in as a prop from a host outside this list; an English side that is
// an identifier bound to Chinese text elsewhere; a `/*` inside a string literal, which the comment
// strip reads as a comment opener. The mounted English render scans (same slice) are the other
// half of the gate.
//
// Named exceptions carry the slice or decision that owns them. `api.ts` is the one file scanned by
// construct rather than whole: only its request-error fallback is converted here, the rest of the
// file is development mock data and the admin group-error table (the same scoping #5545 used for
// ApprovalCenterView.vue's tabEmptyText, above).
// -------------------------------------------------------------------------------------------------
describe('O-8 / F8-1 — approval member-surface source guard (per changed file)', () => {
  type NamedException = { line: string; count: number }
  type FileRule = {
    file: string
    ternary?: number
    objectTernary?: number
    ifZhBlock?: number
    zhTable?: number
    constPair?: number
    /** Scan only from this marker to the first following line that is exactly `}`. */
    scopeFrom?: string
    exceptions?: NamedException[]
  }

  // Exception comments below use two tags:
  //   AUTHORING_ONLY — an authoring-only path inside a shared helper; slice F8-3 owns it (zh-CN until then).
  //   ZH_ARM         — the zh-CN arm of an early return; its English arm is the `if (!isZh)` return
  //                    directly above it in the source.
  const RULES: FileRule[] = [
    // constPair = ADD_SIGN_MODE_HINT and the F4-S1 round-incomplete message; zhTable = the F4-S1
    // add-sign placement copy (ADD_SIGN_PLACEMENT_COPY_ZH / _EN).
    { file: 'src/approvals/addSignHonestyCopy.ts', zhTable: 1, constPair: 2 },
    {
      file: 'src/approvals/api.ts',
      scopeFrom: 'export async function approvalRequestError(response: Response): Promise<never> {',
      ternary: 1,
    },
    { file: 'src/approvals/approvalCenterDetailPaneController.ts', ternary: 1 },
    {
      file: 'src/approvals/assigneeSource.ts',
      ternary: 5,
      exceptions: [
        // AUTHORING_ONLY: `assigneeSourceSummary`'s zh-CN arm. Its `isZh` defaults to zh-CN for the
        // authoring callers (TemplateAuthoringView.vue, linearStepSpine.ts); the member path passes
        // the shell locale and gets `assigneeSourceSummaryEn`.
        { line: "case 'static_user': return `指定用户：${source.userIds.join('、') || '（无）'}`", count: 1 },
        { line: "case 'static_role': return `指定角色：${source.roleIds.join('、') || '（无）'}`", count: 1 },
        { line: "case 'requester': return '发起人'", count: 1 },
        { line: "case 'form_field_user': return `表单用户字段：${source.fieldId}`", count: 1 },
        { line: "case 'direct_manager': return '直属上级'", count: 1 },
        { line: "case 'dept_head': return '部门主管'", count: 1 },
        { line: "case 'continuous_managers': return `连续多级上级（${source.levels} 级）`", count: 1 },
        { line: "case 'manager_at_level': return `指定层级上级（第 ${source.level} 级）`", count: 1 },
        { line: "case 'continuous_dept_heads': return `连续多级部门负责人（${source.levels} 级）`", count: 1 },
        { line: "case 'dept_head_at_level': return `指定层级部门负责人（第 ${source.level} 级）`", count: 1 },
        { line: "case 'form_field_user_manager': return `表单内联系人上级：${source.fieldId}（第 ${source.level} 级）`", count: 1 },
        { line: "case 'form_field_user_dept_head': return `表单内联系人部门负责人：${source.fieldId}（第 ${source.level} 级）`", count: 1 },
        { line: "case 'requester_choice': return '提交人自选（提交时选择）'", count: 1 },
        { line: "case 'prior_node_approver': return `节点审批人（引用节点 ${source.nodeKey}）`", count: 1 },
        { line: "case 'user_group': return `用户组：${source.groupIds.join('、') || '（无）'}`", count: 1 },
        { line: "default: return '（未知审批人来源）'", count: 1 },
        // ZH_ARM: requester-facing node summaries (upcoming nodes / new-approval flow preview).
        { line: "return `指定用户${count ? `（${count} 人）` : '（无）'}`", count: 1 },
        { line: "return `指定角色${count ? `（${count} 个）` : '（无）'}`", count: 1 },
        { line: "return cfg.assigneeType === 'role' ? `指定角色（${count} 个）` : `指定成员（${count} 人）`", count: 1 },
        { line: "return `抄送${cfg.targetType === 'role' ? '角色' : '成员'}`", count: 1 },
        { line: "const suffix = branches.length > 2 ? '；…' : ''", count: 1 },
        { line: "return `按条件进入后续分支：${shown.join('；')}${suffix}`", count: 1 },
      ],
    },
    { file: 'src/approvals/cardDecision.ts', ternary: 4 },
    { file: 'src/approvals/components/ApprovalDepartmentPicker.vue', ternary: 3 },
    { file: 'src/approvals/components/ApprovalRecordLinkPicker.vue' },
    { file: 'src/approvals/components/ApprovalUserPicker.vue', ternary: 1 },
    { file: 'src/approvals/components/approvalPickerLabels.ts', zhTable: 3 },
    { file: 'src/approvals/conditionSummary.ts', ternary: 11, zhTable: 1 },
    { file: 'src/approvals/dateRangeField.ts', ternary: 4 },
    {
      file: 'src/approvals/delegations.ts',
      ternary: 4,
      exceptions: [
        // `validateDelegationForm` serves only the admin DelegationSettingsView.vue — slice F8-2.
        { line: "if (!form.delegatorUserId.trim()) return '请填写委托人'", count: 1 },
        { line: "if (!form.delegateeUserId.trim()) return '请填写被委托人'", count: 1 },
        { line: "if (form.delegatorUserId.trim() === form.delegateeUserId.trim()) return '委托人与被委托人不能相同'", count: 1 },
        { line: "if (form.scope === 'template' && !form.scopeTemplateId.trim()) return '指定表单范围需要选择表单'", count: 1 },
        { line: "if (!form.startAt || !form.endAt) return '请填写时间窗'", count: 1 },
        { line: "if (new Date(form.endAt).getTime() <= new Date(form.startAt).getTime()) return '结束时间必须晚于开始时间'", count: 1 },
      ],
    },
    {
      file: 'src/approvals/detailField.ts',
      ternary: 5,
      exceptions: [
        // AUTHORING_ONLY: new sub-field default label and `validateDetailColumnsDraft` (authoring).
        { line: 'label: `子字段 ${index}`,', count: 1 },
        { line: "const label = fieldLabel || '(未命名明细)'", count: 1 },
        { line: 'errors.push(`明细字段 ${label} 至少需要一个子字段`)', count: 1 },
        { line: 'errors.push(`明细字段 ${label} 的子字段 id 必填`)', count: 1 },
        { line: 'errors.push(`明细字段 ${label} 的子字段 id 不能重复`)', count: 1 },
        { line: "const columnLabel = column.label.trim() || column.id.trim() || '(未命名)'", count: 1 },
        { line: "errors.push(`明细字段 ${label} 的子字段 ${column.id.trim() || '(未命名)'} 名称必填`)", count: 1 },
        { line: 'errors.push(`明细字段 ${label} 的子字段 ${columnLabel} 类型不支持`)', count: 1 },
        { line: 'errors.push(`明细字段 ${label} 的子字段 ${columnLabel} 需要至少一个选项`)', count: 1 },
        { line: 'errors.push(`明细字段 ${label} 的子字段 ${columnLabel} 的选项 label/value 不能为空`)', count: 1 },
        { line: "if (minRows === 'invalid') errors.push(`明细字段 ${label} 的最小行数必须是非负整数`)", count: 1 },
        { line: "if (maxRows === 'invalid') errors.push(`明细字段 ${label} 的最大行数必须是非负整数`)", count: 1 },
        { line: 'errors.push(`明细字段 ${label} 的最小行数不能大于最大行数`)', count: 1 },
        // ZH_ARM: the new-approval required detail-row message.
        { line: 'violations.push(`"${fieldLabel}" 第 ${index + 1} 行缺少 "${column.label || column.id}"`)', count: 1 },
      ],
    },
    { file: 'src/approvals/graphSummary.ts' },
    { file: 'src/approvals/memberActionDialogGrammar.ts', zhTable: 1 },
    { file: 'src/approvals/memberActionErrorCopy.ts', constPair: 1 },
    {
      file: 'src/approvals/recordLinkField.ts',
      constPair: 1,
      exceptions: [
        // AUTHORING_ONLY: target option labels, date-range visibility endpoints and the pin check
        // are used by TemplateAuthoringView.vue / templateAuthoring.ts only.
        { line: "export const RECORD_LINK_TARGET_UNAVAILABLE = '目标不可用'", count: 1 },
        { line: "{ endpoint: 'start', label: '起始' },", count: 1 },
        { line: "{ endpoint: 'end', label: '结束' },", count: 1 },
        { line: "const label = humanLabel || '该字段'", count: 1 },
        { line: 'return `字段 ${label}（关联记录）目标不可用，请重新选择目标空间与目标表`', count: 2 },
        // RECORD_LINK_VALUE_HINT has no importer in apps/web/src.
        { line: "'请选择一条关联记录（仅支持单条；提交时服务端按读权限校验）'", count: 1 },
      ],
    },
    { file: 'src/approvals/relativeWait.ts', ternary: 4 },
    { file: 'src/approvals/routePreviewController.ts', ternary: 1 },
    { file: 'src/approvals/routePreviewSummary.ts', ternary: 4 },
    { file: 'src/approvals/store.ts', ternary: 9 },
    { file: 'src/approvals/templateStore.ts', ternary: 3 },
    { file: 'src/approvals/upcomingNodes.ts' },
    { file: 'src/approvals/urgeButtonState.ts', ternary: 3 },
    { file: 'src/approvals/useApprovalListFieldSummary.ts' },
    { file: 'src/views/approval/ApprovalCardDecisionView.vue', ternary: 1 },
    { file: 'src/views/approval/ApprovalCenterDetailPane.vue', ternary: 4 },
    { file: 'src/views/approval/ApprovalCenterTable.vue', ternary: 2 },
    // ifZhBlock = `tabEmptyText` (pinned separately above) and the CSV-export `exportCopy`.
    // ternary 14 -> 15 (T1): the export asks the server for its header language with
    // `isZh.value ? 'zh' : 'en'` — a language CODE sent in the request, not UI copy (no CJK on either side).
    { file: 'src/views/approval/ApprovalCenterView.vue', ternary: 15, ifZhBlock: 2 },
    { file: 'src/views/approval/ApprovalCommentsPanel.vue', ternary: 3 },
    {
      file: 'src/views/approval/ApprovalDetailView.vue',
      ternary: 10,
      exceptions: [
        // Quick-phrase insertion joins with a full-width comma. The phrases themselves (and so the
        // text written into the comment) stay zh-CN in this slice — an owner decision, not made here.
        { line: 'actionComment.value = actionComment.value ? `${actionComment.value}，${phrase}` : phrase', count: 1 },
      ],
    },
    { file: 'src/views/approval/ApprovalMobileList.vue', objectTernary: 1 },
    {
      file: 'src/views/approval/ApprovalNewView.vue',
      ternary: 12,
      exceptions: [
        // Flag-OFF attachment placeholder (B2-28), pinned byte-identical by approvalNewView.spec.ts
        // until the attachment rung that retires it.
        { line: '附件上传功能即将支持，请先在其他字段中注明附件信息。', count: 1 },
      ],
    },
    { file: 'src/views/approval/MyDelegationView.vue', ternary: 2 },
    { file: 'src/views/approval/approvalCardDecisionLabels.ts', zhTable: 1 },
    { file: 'src/views/approval/approvalCenterLabels.ts', zhTable: 3 },
    { file: 'src/views/approval/approvalDetailLabels.ts', zhTable: 3 },
    { file: 'src/views/approval/approvalNewLabels.ts', zhTable: 1 },
    { file: 'src/views/approval/myDelegationLabels.ts', zhTable: 1 },
  ]

  const LIT = String.raw`(\`(?:[^\`\\]|\\.)*\`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`
  const blank = (text: string) => text.replace(/[^\n]/g, '')

  function stripComments(src: string): string {
    let s = src.replace(/<style[\s\S]*?<\/style>/g, blank)
    s = s.replace(/<!--[\s\S]*?-->/g, blank)
    s = s.replace(/\/\*[\s\S]*?\*\//g, blank)
    // Full-line `//` comments only (same conservative rule as the guards above).
    return s
      .split('\n')
      .map((line) => {
        const slashIdx = line.indexOf('//')
        if (slashIdx === -1) return line
        return line.slice(0, slashIdx).trim() === '' ? '' : line
      })
      .join('\n')
  }

  // Index just past the `}` that closes the `{` at `open`, or -1.
  function closeBrace(s: string, open: number): number {
    let depth = 0
    for (let k = open; k < s.length; k += 1) {
      if (s[k] === '{') depth += 1
      else if (s[k] === '}') {
        depth -= 1
        if (depth === 0) return k + 1
      }
    }
    return -1
  }

  function scanFile(source: string) {
    const counts = { ternary: 0, objectTernary: 0, ifZhBlock: 0, zhTable: 0, constPair: 0 }
    const englishSideCjk: string[] = []
    let s = stripComments(source)

    const TERNARY = new RegExp(String.raw`\bisZh(?:\.value|\(\))?\s*\?\s*` + LIT + String.raw`\s*:\s*` + LIT, 'g')
    s = s.replace(TERNARY, (m: string, _zh: string, en: string) => {
      counts.ternary += 1
      if (CJK.test(en)) englishSideCjk.push(en)
      return blank(m)
    })

    // A `{ zh } … { en }` pair: `head` ends at the zh block's `{`, `between` must reach the en `{`.
    const takePairs = (head: RegExp, between: RegExp, key: 'objectTernary' | 'ifZhBlock') => {
      for (;;) {
        const m = head.exec(s)
        if (!m) return
        const zhEnd = closeBrace(s, m.index + m[0].length - 1)
        const rest = zhEnd < 0 ? null : between.exec(s.slice(zhEnd))
        if (!rest) throw new Error(`${key}: unpaired construct at offset ${m.index}`)
        const enOpen = zhEnd + rest[0].length - 1
        const enEnd = closeBrace(s, enOpen)
        if (CJK.test(s.slice(enOpen, enEnd))) englishSideCjk.push(s.slice(enOpen, enEnd))
        counts[key] += 1
        s = s.slice(0, m.index) + blank(s.slice(m.index, enEnd)) + s.slice(enEnd)
      }
    }
    takePairs(/\bisZh(?:\.value|\(\))?\s*\?\s*\{/, /^\s*:\s*\{/, 'objectTernary')
    takePairs(/\bif\s*\(\s*isZh(?:\.value)?\s*\)\s*\{\s*return\s*\{/, /^\s*\}\s*return\s*\{/, 'ifZhBlock')

    for (;;) {
      const m = /\bconst\s+([A-Z][A-Z0-9_]*)_ZH\b[^=\n]*=\s*\{/.exec(s)
      if (!m) break
      const end = closeBrace(s, m.index + m[0].length - 1)
      const en = new RegExp(String.raw`\bconst\s+` + m[1] + String.raw`_EN\b[^=\n]*=\s*\{`).exec(source)
      if (!en) throw new Error(`zhTable: ${m[1]}_ZH has no ${m[1]}_EN sibling`)
      const enOpen = en.index + en[0].length - 1
      const enBody = stripComments(source.slice(enOpen, closeBrace(source, enOpen)))
      if (CJK.test(enBody)) englishSideCjk.push(`${m[1]}_EN`)
      counts.zhTable += 1
      s = s.slice(0, m.index) + blank(s.slice(m.index, end)) + s.slice(end)
    }

    const PAIR = new RegExp(String.raw`\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*` + LIT, 'g')
    s = s.replace(PAIR, (m: string, name: string, lit: string) => {
      if (!CJK.test(lit) || name.endsWith('_EN')) return m
      const en = new RegExp(String.raw`\bconst\s+` + name + String.raw`_EN\s*=\s*` + LIT).exec(source)
      if (!en) return m
      if (CJK.test(en[1]!)) englishSideCjk.push(`${name}_EN`)
      counts.constPair += 1
      return blank(m)
    })

    return { counts, englishSideCjk, rest: s }
  }

  it.each(RULES.map((rule) => [rule.file, rule] as const))('guard: %s', async (_file, rule) => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    let source = fs.readFileSync(path.resolve(__dirname, '..', rule.file), 'utf-8')
    if (rule.scopeFrom) {
      const at = source.indexOf(rule.scopeFrom)
      expect(at, `scope marker missing in ${rule.file}`).toBeGreaterThanOrEqual(0)
      expect(source.indexOf(rule.scopeFrom, at + 1), 'scope marker must be unique').toBe(-1)
      const close = source.indexOf('\n}\n', at)
      expect(close, 'scope end missing').toBeGreaterThan(at)
      source = source.slice(at, close + 3)
    }

    const { counts, englishSideCjk, rest } = scanFile(source)
    expect(counts, `construct counts changed in ${rule.file}`).toEqual({
      ternary: rule.ternary ?? 0,
      objectTernary: rule.objectTernary ?? 0,
      ifZhBlock: rule.ifZhBlock ?? 0,
      zhTable: rule.zhTable ?? 0,
      constPair: rule.constPair ?? 0,
    })
    expect(englishSideCjk, `an English side contains CJK in ${rule.file}`).toEqual([])

    let remaining = rest
    for (const { line, count } of rule.exceptions ?? []) {
      expect(CJK.test(line), `named exception without CJK: ${line}`).toBe(true)
      expect(remaining.split(line).length - 1, `named exception occurrence count changed: ${line}`).toBe(count)
      remaining = remaining.split(line).join('')
    }
    const offenders = remaining.split('\n').filter((line) => CJK.test(line)).map((line) => line.trim())
    expect(offenders, `CJK outside the locale constructs in ${rule.file}`).toEqual([])
  })

  it('the guard itself reds on a stray literal, an English-side CJK and a missing EN table (positive controls)', () => {
    expect(scanFile("const a = '审批'").rest).toMatch(CJK)
    expect(scanFile("const a = isZh.value ? '审批' : '审批'").englishSideCjk).toHaveLength(1)
    expect(scanFile("const a = isZh.value ? '审批' : 'Approval'").rest).not.toMatch(CJK)
    expect(() => scanFile("export const X_ZH = { a: '审批' }")).toThrow(/no X_EN sibling/)
    expect(scanFile("const X_ZH = { a: '审批' }\nconst X_EN = { a: '审批' }").englishSideCjk).toEqual(['X_EN'])
    expect(scanFile("const M = '审批'").rest).toMatch(CJK)
    expect(scanFile("const M = '审批'\nconst M_EN = 'Approval'").counts.constPair).toBe(1)
    expect(scanFile('const t = isZh.value ? { a: 1 } : { a: \'审批\' }').englishSideCjk).toHaveLength(1)
    expect(scanFile('function f() { if (isZh.value) { return { a: \'审批\' } } return { a: \'x\' } }').counts.ifZhBlock).toBe(1)
  })
})
