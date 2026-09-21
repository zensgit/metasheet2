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
import { useLocale } from '../src/composables/useLocale'

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
// Approval form grouping lock v2.13 §4 row D / §6 phase 3 (A-4) — NOT imported by
// TemplateCenterView.vue's own script (only TemplateGroupSections.vue calls it). Present here
// solely as a discriminating spy for 'renders a category tag per row' below: I6 confines the
// org-scoped group join to the additive section/reorder endpoints, so the flat table's category
// tag must never reach this function. If it ever did, this mock still supplies a value (rather
// than leaving the import undefined and throwing) so the failure surfaces as a red assertion on
// the spy, not an unrelated TypeError.
const listApprovalTemplateGroupsSpy = vi.fn<[], Promise<unknown[]>>().mockResolvedValue([])
// A-2 x A-4 convergence (2026-09-20) — the grouped-view tests below mount TemplateGroupSections
// through the view, and it fetches one page per section. Needed on this replacement mock or the
// sections view's `loadAll` throws "listTemplatesBySection is not a function" into its own catch
// and renders the error state instead of the sections, which would make those tests assert
// nothing about the manager/sections relation.
const listTemplatesBySectionSpy = vi
  .fn<[unknown], Promise<{ data: unknown[]; total: number }>>()
  .mockResolvedValue({ data: [], total: 0 })

vi.mock('../src/approvals/api', () => ({
  listTemplateCategories: () => listTemplateCategoriesSpy(),
  cloneTemplate: (id: string) => cloneTemplateSpy(id),
  // A-2 scope item 2 (design lock v2.13 §6 phase 1) — ApprovalTemplateGroupsPanel.vue calls
  // `listApprovalTemplateGroups`/`createApprovalTemplateGroup` on mount/submit plus an
  // `instanceof ApprovalApiError` check in its catch branch, so all three keys must exist on this
  // replacement mock whenever a test in this file mounts it.
  //
  // A-2 × A-4 merge resolution (this branch): the two lanes each added a
  // `listApprovalTemplateGroups` key to THIS object literal. Duplicate keys here are invisible to
  // every static gate (`apps/web/tsconfig.app.json`'s `include` is `src/**` only, so `tests/**` is
  // never type-checked and TS1117 can never fire), and the later key silently wins — which would
  // have made A-4's discriminating spy dead. Single key kept, bound to A-4's spy: it is strictly
  // stronger than A-2's `() => Promise.resolve([])` (same empty-array value, plus call counting).
  ApprovalApiError: class ApprovalApiError extends Error {},
  listApprovalTemplateGroups: () => listApprovalTemplateGroupsSpy(),
  listTemplatesBySection: (params: unknown) => listTemplatesBySectionSpy(params),
  createApprovalTemplateGroup: (name: string) => Promise.resolve({
    id: 'atg_test', orgId: 'org_test', name, sortOrder: 1,
    createdBy: 'test', createdAt: '', updatedAt: '', archivedAt: null,
  }),
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

// G-B2-17 — this spec always mocks canManageTemplates=true (admin table path), so the
// !canManageTemplates gallery branch (which uses <el-card>) never actually renders here. The
// stub is registered anyway so Vue doesn't warn about an unresolved component while resolving
// the template's compiled component list.
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
    // Report item O-8 — TemplateCenterView is now locale-aware (useLocale()/isZh) instead of a
    // hardcoded-Chinese-always template, including `visibilityScopeLabel()`'s "全员可见"/"角色 N"
    // output this spec's "renders visibility scope summary per row" test asserts on. Pin the
    // locale explicitly rather than relying on jsdom's default `navigator.language` (same fix as
    // approval-e2e-permissions.spec.ts's and approval-e2e-lifecycle.spec.ts's UF-3 pins) — this
    // spec's fixtures/assertions are Chinese, and templateCenterI18n.spec.ts is what actually
    // covers the "en" locale for this view.
    useLocale().setLocale('zh-CN')

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
    listApprovalTemplateGroupsSpy.mockClear()
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockClear()
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
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
    app.component('ElCard', ElCard)
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

  // Approval form grouping lock v2.13 §4 row D pins this test BY NAME for phase 3 re-pinning
  // ("按测试名钉,不按行号" — the earlier draft's "语义保留" claim conflicted with §6 and was
  // withdrawn). What actually changed with grouping's arrival is NOT this tag's rendering — I6
  // confines the org-scoped group join to the additive `section=`/reorder endpoints and
  // explicitly forbids it from reaching `listTemplates`/`applyTemplateVisibilityFilter` (the flat
  // path this view reads) — it is what the test asserts. Re-pinned to (a) also cover row D's
  // `category <> ''` exclusion at the display layer (previously only implicit in `v-if`'s JS
  // truthiness, never asserted) and (b) make the flat/grouped split a tested invariant rather
  // than an implicit one: this view's category tag must never consult group linkage.
  it('renders a category tag per row', async () => {
    mockTemplates.value = [
      buildTemplate({ id: 'tpl_a', name: '出差申请', category: '请假' }),
      buildTemplate({ id: 'tpl_b', name: '采购申请', category: '采购' }),
      buildTemplate({ id: 'tpl_c', name: '其他申请', category: null }),
      // §4 row D: the empty-string legacy edge case ("空串是只能直连 DB 写出的遗留形态") is
      // explicitly excluded from the category fallback, same footing as null — pinned here at
      // the display layer, not just the section-listing read path (already covered by row D's
      // own real-DB case, approval-template-groups-sections.db.test.ts:218).
      buildTemplate({ id: 'tpl_d', name: '遗留申请', category: '' }),
    ]
    mockTotal.value = mockTemplates.value.length
    await mountView()
    const tags = container!.querySelectorAll('[data-testid="template-center-row-category"]')
    // Still 2 — null AND '' both fall through to the empty state (`未分类`), neither renders a tag.
    expect(tags.length).toBe(2)
    const tagTexts = Array.from(tags).map((el) => (el.textContent ?? '').trim())
    expect(tagTexts).toContain('请假')
    expect(tagTexts).toContain('采购')

    // I6 guard: the flat table's tag is the raw `category` column alone — it must never trigger
    // a group-linkage lookup. Mutation target: make this branch consult group state (eg call
    // listApprovalTemplateGroups() to decide tag visibility) → this assertion goes red.
    expect(listApprovalTemplateGroupsSpy).not.toHaveBeenCalled()

    // Gate impl-gate-A4-round1-20260918.md P3-3: the assertion above is "asserts not called" with
    // no SAME-FILE positive control proving the spy would register a call if one were made — i.e.
    // nothing here rules out the assertion passing vacuously because the mock wiring itself is
    // broken (wrong module path, a hoisting break, a stale import), independent of what
    // `TemplateCenterView.vue` actually does.
    //
    // A call-SITE positive control (proving THIS component calls the function on some other path)
    // cannot be built in this file: `TemplateCenterView.vue`'s own script never imports
    // `listApprovalTemplateGroups` at all (only `TemplateGroupSections.vue` does, for the phase-3
    // grouped view) — see that real call-site positive control at
    // `approvalTemplateCenterSections.spec.ts`'s `expect(listApprovalTemplateGroupsSpy)
    // .toHaveBeenCalledTimes(1)` assertion, same spy function, different component.
    //
    // What CAN be checked here, in this file, is that the mock wiring is the live binding rather
    // than a dead one: call the mocked module's own export directly and confirm it reaches this
    // exact spy instance. This does not prove the component calls it — it proves that if the
    // component ever did, `not.toHaveBeenCalled()` above would not pass vacuously.
    const { listApprovalTemplateGroups } = await import('../src/approvals/api')
    await listApprovalTemplateGroups()
    expect(listApprovalTemplateGroupsSpy).toHaveBeenCalledTimes(1)
  })

  // A-2 x A-4 merge convergence (2026-09-20) — the two lanes each added a grouping surface to
  // this page (A-2's ApprovalTemplateGroupsPanel, A-4's TemplateGroupSections). The convergence
  // makes the sections view PRIMARY and the panel a disclosure-gated MANAGEMENT entry inside the
  // grouped view. These two tests pin that relation; the I6 assertion above pins the other half
  // (the panel is not mounted in the flat view at all, which is what keeps I6 literally true).
  it('grouped view: the group manager is collapsed, so entering the grouped view reads the group list exactly once', async () => {
    await mountView()
    // Flat view (default) — no grouping surface at all, hence no group read. Same fact the I6
    // assertion above pins, restated here as this test's own precondition.
    expect(listApprovalTemplateGroupsSpy).not.toHaveBeenCalled()

    const groupedButton = container!.querySelector(
      '[data-testid="template-center-view-mode-grouped"]',
    ) as HTMLButtonElement | null
    expect(groupedButton).not.toBeNull()
    groupedButton!.click()
    await flushUi()

    // The sections view (primary) loaded; the manager panel is NOT mounted, so the group list was
    // read once, not twice. Before the convergence both surfaces mounted together and each fired
    // its own `listApprovalTemplateGroups()`.
    expect(container!.querySelector('[data-testid="template-group-sections"]')).not.toBeNull()
    expect(container!.querySelector('[data-testid="approval-template-groups-panel"]')).toBeNull()
    expect(listApprovalTemplateGroupsSpy).toHaveBeenCalledTimes(1)

    const toggle = container!.querySelector(
      '[data-testid="template-center-group-manager-toggle"]',
    ) as HTMLButtonElement | null
    expect(toggle).not.toBeNull()
    toggle!.click()
    await flushUi()

    // Opening the manager is the ONLY path that adds a second read, and it is an explicit admin
    // action — the manager reads the authoritative list it is about to edit.
    expect(container!.querySelector('[data-testid="approval-template-groups-panel"]')).not.toBeNull()
    expect(listApprovalTemplateGroupsSpy).toHaveBeenCalledTimes(2)
  })

  it('grouped view: creating a group in the manager re-reads the sections view (no state desync)', async () => {
    await mountView()
    ;(container!.querySelector(
      '[data-testid="template-center-view-mode-grouped"]',
    ) as HTMLButtonElement).click()
    await flushUi()
    ;(container!.querySelector(
      '[data-testid="template-center-group-manager-toggle"]',
    ) as HTMLButtonElement).click()
    await flushUi()
    const readsBeforeCreate = listApprovalTemplateGroupsSpy.mock.calls.length
    expect(readsBeforeCreate).toBe(2)

    const input = container!.querySelector(
      '[data-testid="approval-template-groups-create-input"]',
    ) as HTMLInputElement
    input.value = 'Finance'
    input.dispatchEvent(new Event('input'))
    await flushUi()
    const form = container!.querySelector('.approval-template-groups-panel__create') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await flushUi()

    // The panel emits `changed`; TemplateCenterView re-runs the sections view's own `loadAll()`.
    // Mutation target: drop `emit('changed')` in the panel, or `handleGroupsChanged` in the view,
    // and this count stays at 2 — the exact desync the merge report flagged (a group created in
    // the panel left the section list stale).
    expect(listApprovalTemplateGroupsSpy.mock.calls.length).toBeGreaterThan(readsBeforeCreate)
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

  it('routes template managers to the new authoring view', async () => {
    await mountView()
    const newButton = container!.querySelector('[data-testid="template-center-new-button"]') as HTMLButtonElement
    expect(newButton).toBeTruthy()

    newButton.click()
    await flushUi()

    expect(pushSpy).toHaveBeenCalledWith({ path: '/approval-templates/new' })
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
