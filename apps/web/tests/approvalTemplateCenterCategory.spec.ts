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
import { createPinia, setActivePinia } from 'pinia'
import { useAuth } from '../src/composables/useAuth'
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
// Resolves 'applied' because that is what the real `templateStore.loadTemplates` resolves when
// the read it issued is still the current one and it succeeded (`ApprovalTemplateListOutcome`
// — the other two values are 'failed' and 'superseded'). TemplateCenterView lowers its
// flat-list stale bit ONLY for 'applied', so a mock resolving `undefined` would be a mock of
// a contract this store does not have, and every case below that raises the stale bit would
// be asserting against a store protocol that exists nowhere in production.
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
// Round 4 — the REAL `approvals/templateStore` is exercised by the request-algebra describe at the
// bottom of this file (through `vi.importActual`, which un-mocks the store but leaves ITS `./api`
// import resolved to this factory). `listTemplates` therefore has to exist here or that import
// throws before a single assertion runs. It is NOT used by any component test in this file: those
// keep the replacement store mock above.
const listTemplatesSpy = vi
  .fn<[unknown], Promise<{ data: unknown[]; total: number }>>()
  .mockResolvedValue({ data: [], total: 0 })
// A-2 x A-4 convergence (2026-09-20) — the grouped-view tests below mount TemplateGroupSections
// through the view, and it fetches one page per section. Needed on this replacement mock or the
// sections view's `loadAll` throws "listTemplatesBySection is not a function" into its own catch
// and renders the error state instead of the sections, which would make those tests assert
// nothing about the manager/sections relation.
const listTemplatesBySectionSpy = vi
  .fn<[unknown], Promise<{ data: unknown[]; total: number }>>()
  .mockResolvedValue({ data: [], total: 0 })
// Round 5 — the OTHER two writers of the store's shared `loading`/`error` slots (gate round-4 C-7).
// Same standing as `listTemplatesSpy`: only the request-algebra describe at the bottom of this file
// drives them, through the real store; every component test here keeps the replacement store mock.
const getTemplateSpy = vi
  .fn<[string], Promise<unknown>>()
  .mockImplementation(async (id: string) => ({ id }))
const getTemplateVersionSpy = vi
  .fn<[string, string], Promise<unknown>>()
  .mockImplementation(async (templateId: string, versionId: string) => ({ templateId, versionId }))

vi.mock('../src/approvals/api', () => ({
  listTemplateCategories: () => listTemplateCategoriesSpy(),
  cloneTemplate: (id: string) => cloneTemplateSpy(id),
  // A-2 scope item 2 (design lock v2.13 §6 phase 1) — ApprovalTemplateGroupsPanel.vue calls
  // `listApprovalTemplateGroups`/`createApprovalTemplateGroup` on mount/submit plus an
  // `instanceof ApprovalApiError` check in its catch branch, so all three keys must exist on this
  // replacement mock whenever a test in this file mounts it. After the A-2 x A-4 convergence it is
  // NOT mounted by the tests below: TemplateCenterView.vue mounts the panel only in the GROUPED
  // view and only after an admin opens the disclosure toggle, and every test here stays in the
  // default flat view. The keys stay so that a future grouped-view test in this file does not
  // rediscover the unhandled-onMounted failure; they are not why the I6 assertion below passes.
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
  // The three the REAL templateStore imports (see `listTemplatesSpy` above). Round 5 promoted
  // `getTemplate` / `getTemplateVersion` from fixed resolvers to spies so the shared-slot cases at
  // the bottom of this file can hold one read in flight while another settles.
  listTemplates: (query: unknown) => listTemplatesSpy(query),
  getTemplate: (id: string) => getTemplateSpy(id),
  getTemplateVersion: (templateId: string, versionId: string) => getTemplateVersionSpy(templateId, versionId),
  createApprovalTemplateGroup: (name: string) => Promise.resolve({
    id: 'atg_test', orgId: 'org_test', name, sortOrder: 1,
    createdBy: 'test', createdAt: '', updatedAt: '', archivedAt: null,
  }),
  // P1-A (impl-gate-A5-daily-ops-round1-20260920.md) — the page-level case below DOES mount the
  // panel (it opens 管理分组), which imports these four as well. Same standing as the three keys
  // above: present so mounting cannot fail on an undefined import, NOT the thing under test here.
  // The panel's own error-copy / rename / archive / unarchive contracts are pinned, against the
  // real module, in `ApprovalTemplateGroupsPanel.spec.ts`.
  describeApprovalTemplateGroupError: (err: { message?: string } | null) => err?.message ?? '',
  renameApprovalTemplateGroup: (id: string, name: string) => Promise.resolve({
    id, orgId: 'org_test', name, sortOrder: 1,
    createdBy: 'test', createdAt: '', updatedAt: '', archivedAt: null,
  }),
  archiveApprovalTemplateGroup: (id: string) => Promise.resolve({
    id, orgId: 'org_test', name: 'archived', sortOrder: null,
    createdBy: 'test', createdAt: '', updatedAt: '', archivedAt: '2026-09-20T00:00:00.000Z',
  }),
  unarchiveApprovalTemplateGroup: (id: string) => Promise.resolve({
    id, orgId: 'org_test', name: 'unarchived', sortOrder: 1,
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
    // `data-closable` is mirrored out because round-4 makes the error banner NON-dismissible in
    // exactly one state (the flat surfaces blanked by a context change whose re-read has not
    // succeeded), where it carries the only Reload control. The default slot is deliberately still
    // not rendered: its button label would join every `container.textContent` assertion in this file.
    return h('div', {
      'data-el-alert': this.type,
      'data-closable': String(Boolean(this.closable)),
    }, this.title)
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
    loadTemplatesSpy.mockResolvedValue('applied')
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

/**
 * P2-5 (groups-daily-ops-real-browser-acceptance-20260920.md) — once a multi-org admin has
 * SELECTED a session organization, the reactive `SessionOrgSwitcher` instances inside
 * `ApprovalTemplateGroupsPanel.vue`/`TemplateGroupSections.vue` disappear for good (they only
 * ever show themselves on a 403 `SESSION_ORG_REQUIRED`, and a bound `authenticatedTenantId` means
 * that code never comes back) — the acceptance report's finding: to switch to a DIFFERENT org, a
 * multi-org admin had to leave the approvals module entirely and use the attendance page's
 * always-visible switcher. This adds a THIRD, independent, persistent switcher — same shared
 * `SessionOrgSwitcher` component, own `useSessionOrg()` instance — that stays up in the grouped
 * view once a session org is bound, satisfying lock §2's "首期必须……提供 session-org 选择入口"
 * more completely without touching either reactive instance's own contract.
 *
 * Advisor-flagged gate on scope: lock §4 acceptance J's positive control is "a single-org member
 * never sees the selector" — a persistent switcher visible unconditionally (attendance's own
 * literal behaviour) would make that FALSE at the page level for this new surface. Gated on
 * `useSessionOrg().hasMultipleOrgs` instead: for a single-org member `GET /api/auth/session-orgs`
 * returns exactly one org, so the switcher never renders — J's control stays true for this surface
 * too. This is a documented, deliberate ONE-CONJUNCT divergence from "same shape as the attendance
 * page" (see the design MD's lock-coverage matrix), not a silent narrowing.
 */
describe('TemplateCenterView — P2-5: persistent session-org entry in the grouped view', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  const jwt = (org: string) =>
    `header.${btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`

  function jsonResponse(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }

  beforeEach(() => {
    useLocale().setLocale('zh-CN')
    mockTemplates.value = []
    mockLoading.value = false
    mockError.value = null
    mockTotal.value = 0
    loadTemplatesSpy.mockClear()
    loadTemplatesSpy.mockResolvedValue('applied')
    listTemplateCategoriesSpy.mockClear()
    listTemplateCategoriesSpy.mockResolvedValue([])
    listApprovalTemplateGroupsSpy.mockClear()
    listTemplatesBySectionSpy.mockClear()
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.unstubAllGlobals()
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
    app.mount(container!)
    await flushUi()
  }

  async function enterGroupedView() {
    ;(container!.querySelector('[data-testid="template-center-view-mode-grouped"]') as HTMLButtonElement).click()
    await flushUi()
  }

  it('a multi-org admin with an ALREADY-BOUND session org sees a persistent switcher in the grouped view', async () => {
    useAuth().setToken(jwt('org-a'))
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        return jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
      }
      throw new Error(`unexpected fetch: ${path}`)
    }))

    await mountView()
    await enterGroupedView()
    await flushUi(8)

    // Neither reactive instance is up (no 403 ever happened — the org is already bound).
    expect(container!.querySelector('[data-testid="template-group-sections-error"]')).toBeNull()
    const switcher = container!.querySelector('[data-testid="session-org-switcher"]')
    expect(switcher).not.toBeNull()
  })

  it('a SINGLE-org member never sees the persistent switcher, in flat OR grouped view (acceptance J\'s positive control, restated for this new surface)', async () => {
    useAuth().setToken(jwt('org-solo'))
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        return jsonResponse(200, { success: true, data: { orgs: ['org-solo'], currentOrgId: 'org-solo' } })
      }
      throw new Error(`unexpected fetch: ${path}`)
    }))

    await mountView()
    expect(container!.querySelector('[data-testid="session-org-switcher"]')).toBeNull()

    await enterGroupedView()
    await flushUi(8)
    expect(container!.querySelector('[data-testid="session-org-switcher"]')).toBeNull()
  })

  it('switching org through the persistent switcher re-reads the grouped view', async () => {
    useAuth().setToken(jwt('org-a'))
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: { method?: string }) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        return jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
      }
      if (String(path).endsWith('/api/auth/session-org') && init?.method === 'POST') {
        return jsonResponse(200, { success: true, data: { currentOrgId: 'org-b', token: jwt('org-b') } })
      }
      throw new Error(`unexpected fetch: ${path} ${init?.method}`)
    }))

    await mountView()
    await enterGroupedView()
    await flushUi(8)

    const readsBeforeSwitch = listApprovalTemplateGroupsSpy.mock.calls.length
    const select = container!.querySelector(
      '[data-testid="session-org-switcher"] select[name="sessionOrgId"]',
    ) as HTMLSelectElement
    expect(select).not.toBeNull()
    select.value = 'org-b'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(8)

    expect(listApprovalTemplateGroupsSpy.mock.calls.length).toBeGreaterThan(readsBeforeSwitch)
  })

  // ── P1-A (impl-gate-A5-daily-ops-round1-20260920.md) ────────────────────────────────────────
  // The three cases above cover (a) an ALREADY-BOUND multi-org admin and (b) a single-org member.
  // The population lock §2/§4 J actually names — a multi-org member with NO bound
  // `authenticatedTenantId`, i.e. the default state for anyone in more than one org — was the
  // missing (c), and it is the one hop where round 1 rendered TWO indistinguishable switchers
  // (page-level + the sections view's reactive one, same testid, same markup, same options, and —
  // before this round — the same hardcoded `<select>` DOM id). Which one the admin happened to
  // click decided whether this slice's headline fix held: switching through the sections view's
  // copy left the page with ZERO switchers, because `useSessionOrg`'s `onAuthPrincipalChange`
  // empties `orgs` on every instance that did not perform the switch and only the switching one
  // restores itself.
  //
  // Both cases below count with `querySelectorAll`, never `querySelector` — the round-1 specs used
  // `querySelector`, which silently always took the page-level instance, i.e. the one side that
  // worked, and therefore had zero discriminating power over the duplicate.
  function sessionOrgRequiredError(ApiError: new (message: string) => Error): Error {
    const err = new ApiError('An authenticated session organization is required') as Error & { code?: string }
    err.code = 'SESSION_ORG_REQUIRED'
    return err
  }

  /**
   * Models the real server for an unbound multi-org admin: EVERY group endpoint fail-closes 403
   * `SESSION_ORG_REQUIRED` until an org is chosen, and succeeds afterwards. `bound` is flipped by
   * the `POST /api/auth/session-org` stub, not by the test, so the "after" state is reached the
   * same way a real admin reaches it. Remounts from scratch so each instance can be exercised
   * from the same starting state.
   */
  async function mountUnboundMultiOrgGroupedView(
    state: { bound: boolean },
    options: { openManager?: boolean } = {},
  ) {
    if (app) app.unmount()
    if (container) container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    state.bound = false
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })

    const api = await import('../src/approvals/api')
    listApprovalTemplateGroupsSpy.mockImplementation(async () => {
      if (!state.bound) throw sessionOrgRequiredError(api.ApprovalApiError as unknown as new (m: string) => Error)
      return []
    })
    // The token's own payload is irrelevant here — "unbound" is a SERVER-side property, which is
    // why it is modelled by the 403 above; the client just needs a stored token for
    // `useSessionOrg` to consider itself usable. Same `userId: 'actor'` helper the cases above use
    // (a longer id makes `btoa` emit `=` padding, which `useAuth.setExplicitSessionOrg`'s JWT
    // shape check rejects).
    useAuth().setToken(jwt('org-a'))
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: { method?: string }) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        return jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: null } })
      }
      if (String(path).endsWith('/api/auth/session-org') && init?.method === 'POST') {
        state.bound = true
        return jsonResponse(200, { success: true, data: { currentOrgId: 'org-b', token: jwt('org-b') } })
      }
      throw new Error(`unexpected fetch: ${path} ${init?.method}`)
    }))

    await mountView()
    await enterGroupedView()
    await flushUi(10)
    if (options.openManager) {
      ;(container!.querySelector(
        '[data-testid="template-center-group-manager-toggle"]',
      ) as HTMLButtonElement).click()
      await flushUi(10)
    }
  }

  it('P1-A: an UNBOUND multi-org admin on the first grouped hop gets exactly ONE switcher, with a unique select id', async () => {
    const state = { bound: false }
    await mountUnboundMultiOrgGroupedView(state)

    const switchers = container!.querySelectorAll('[data-testid="session-org-switcher"]')
    expect(switchers.length).toBe(1)

    const selects = Array.from(
      container!.querySelectorAll('[data-testid="session-org-switcher"] select[name="sessionOrgId"]'),
    ) as HTMLSelectElement[]
    expect(selects.length).toBe(1)
    // Every rendered select carries a non-empty id, and no id is shared — the `<label for=...>`
    // pairing is then per instance instead of silently binding to whichever one rendered first.
    const ids = selects.map((select) => select.id)
    expect(ids.every((id) => id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(container!.querySelectorAll(`[id="${id}"]`).length).toBe(1)
      expect(container!.querySelector(`label[for="${id}"]`)).not.toBeNull()
    }
  })

  it('P1-A: switching from EVERY rendered switcher instance leaves the page entry in place and re-reads the grouped view', async () => {
    const state = { bound: false }
    await mountUnboundMultiOrgGroupedView(state)

    // Discovered, not hardcoded: on the round-1 head this is 2 and the second iteration ends with
    // zero switchers on the page (the regression this case exists for).
    const instanceCount = container!.querySelectorAll('[data-testid="session-org-switcher"]').length
    expect(instanceCount).toBeGreaterThan(0)

    for (let index = 0; index < instanceCount; index += 1) {
      if (index > 0) await mountUnboundMultiOrgGroupedView(state)

      const selects = Array.from(
        container!.querySelectorAll('[data-testid="session-org-switcher"] select[name="sessionOrgId"]'),
      ) as HTMLSelectElement[]
      expect(selects.length).toBe(instanceCount)
      const readsBeforeSwitch = listApprovalTemplateGroupsSpy.mock.calls.length

      const select = selects[index]
      select.value = 'org-b'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await flushUi(10)

      // The entry survives the switch no matter which instance performed it.
      expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(1)
      // …and the blocked grouped view was actually replayed.
      expect(listApprovalTemplateGroupsSpy.mock.calls.length).toBeGreaterThan(readsBeforeSwitch)
      expect(container!.querySelector('[data-testid="template-group-sections-error"]')).toBeNull()
    }
  })

  // The round-1 gate wrote this configuration down as an UNMEASURED inference: "(推论,本轮未实测)
  // 面板自己也持有一个反应式实例,同一机制下管理员若已展开「管理分组」面板,应当出现第三个 ——
  // 相位 E 两次运行均未展开面板,实测值恒为 2". Both cases above leave `showGroupManager` false,
  // so the panel is not even mounted in them — which would repeat, in round 2, exactly the miss
  // round 1 was failed for: exercising only the configuration where the code wins. This case
  // opens the manager, i.e. it measures the gate's inference instead of inheriting it.
  it('P1-A: with the 管理分组 panel EXPANDED it is still exactly one switcher, and switching from any instance keeps it', async () => {
    const state = { bound: false }
    await mountUnboundMultiOrgGroupedView(state, { openManager: true })
    // Sanity: the panel really is mounted (otherwise this case degrades into the first one).
    expect(container!.querySelector('[data-testid="approval-template-groups-panel"]')).not.toBeNull()

    const instanceCount = container!.querySelectorAll('[data-testid="session-org-switcher"]').length
    expect(instanceCount).toBe(1)
    const ids = Array.from(
      container!.querySelectorAll('[data-testid="session-org-switcher"] select[name="sessionOrgId"]'),
    ).map((select) => (select as HTMLSelectElement).id)
    expect(new Set(ids).size).toBe(ids.length)

    for (let index = 0; index < instanceCount; index += 1) {
      if (index > 0) await mountUnboundMultiOrgGroupedView(state, { openManager: true })

      const selects = Array.from(
        container!.querySelectorAll('[data-testid="session-org-switcher"] select[name="sessionOrgId"]'),
      ) as HTMLSelectElement[]
      expect(selects.length).toBe(instanceCount)

      const select = selects[index]
      select.value = 'org-b'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await flushUi(10)

      expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(1)
      // Both hosted surfaces came back: the sections view renders and the panel's list is no
      // longer suppressed behind its "blocked on a session org" state.
      expect(container!.querySelector('[data-testid="template-group-sections-error"]')).toBeNull()
      expect(container!.querySelector('[data-testid="approval-template-groups-list"]')).not.toBeNull()
    }
  })

  // ── P2-C (impl-gate-A5-daily-ops-round2-20260920.md) ────────────────────────────────────────
  // `showPageSessionOrgSwitcher` is `hasMultipleOrgs || sessionOrgRequiredSeen` (TemplateCenterView
  // .vue:555-557). Every case above reaches the entry through the FIRST disjunct — a successful
  // `GET /api/auth/session-orgs` returning >1 org. The SECOND disjunct is only exercised when that
  // lookup itself fails (network error / 500 / malformed payload): `orgs` then never grows past
  // zero, so `hasMultipleOrgs` can NEVER become true, and the entry can only exist because a hosted
  // child (here, TemplateGroupSections) took its own 403 SESSION_ORG_REQUIRED and reported it up
  // via `notifySessionOrgRequired()`. The round-2 gate found this branch completely unexercised:
  // dropping the second disjunct (M-e) and turning `notifySessionOrgRequired` into a no-op (M-f)
  // each left every one of the five specs' 76 tests green. Both scenarios are reachable together —
  // a member's session-orgs call and a hosted child's group call can fail independently — so an
  // admin in that state must still get an entry (in its own error state, since there is nothing to
  // pick from) instead of a page with no switcher and no explanation at all.
  it('P2-C: an unbound multi-org admin whose session-orgs lookup ALSO fails still gets exactly one switcher, in its error state', async () => {
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })

    const api = await import('../src/approvals/api')
    // Every group endpoint 403s SESSION_ORG_REQUIRED — same unbound-admin population as
    // `mountUnboundMultiOrgGroupedView`, just without a `POST /api/auth/session-org` recovery path
    // (there is nothing to switch to: the org list itself never loads).
    listApprovalTemplateGroupsSpy.mockImplementation(async () => {
      throw sessionOrgRequiredError(api.ApprovalApiError as unknown as new (m: string) => Error)
    })
    useAuth().setToken(jwt('org-a'))
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        // The lookup itself fails — `orgs` stays `[]` forever, so `hasMultipleOrgs` never fires.
        return jsonResponse(500, { success: false })
      }
      throw new Error(`unexpected fetch: ${path}`)
    }))

    await mountView()
    await enterGroupedView()
    await flushUi(10)

    const switchers = container!.querySelectorAll('[data-testid="session-org-switcher"]')
    expect(switchers.length).toBe(1)
    // Genuinely the FAILURE state, not a working dropdown that merely has no options loaded yet:
    // zero organizations offered, the select disabled, and the switcher's own error hint visible.
    const switcher = switchers[0]
    const select = switcher.querySelector('select[name="sessionOrgId"]') as HTMLSelectElement
    expect(select.disabled).toBe(true)
    expect(switcher.querySelectorAll('option[value]:not([value=""])').length).toBe(0)
    expect(switcher.querySelector('.session-org-switcher__hint--error')).not.toBeNull()
  })

  // ── (i) session context on logout / account switch (round-2 gate, additional load-bearing case)
  // `useSessionOrg`'s `onAuthPrincipalChange` handler (untouchable — design lock §2, `useSessionOrg
  // .ts` "不动") already clears `orgs`/`currentOrgId`/`errorMessage` on every transition `useAuth`'s
  // single reset funnel fires through (`setToken`/`clearToken` → `notifyAuthPrincipalChange()`).
  // This pins that behaviour AT THE HOST — the actual page-level org list/selection a real admin
  // would see — for both directions named by the review: signing out entirely, and switching to a
  // DIFFERENT account without an intervening reload.
  it('(i) signing out clears the host\'s session-org list — nothing from the previous account is left rendered', async () => {
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    useAuth().setToken(jwt('org-a'))
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        return jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
      }
      throw new Error(`unexpected fetch: ${path}`)
    }))

    await mountView()
    await enterGroupedView()
    await flushUi(8)

    // The previous account's org list is up and bound.
    const switcherBefore = container!.querySelector('[data-testid="session-org-switcher"] select[name="sessionOrgId"]') as HTMLSelectElement
    expect(switcherBefore).not.toBeNull()
    expect(switcherBefore.options.length).toBeGreaterThan(0)
    expect(Array.from(switcherBefore.options).some((o) => o.value === 'org-a')).toBe(true)

    useAuth().clearToken()
    await flushUi(8)

    // `hasMultipleOrgs` reads off `orgs`, which the reset funnel clears to `[]` — with no bound
    // org and `sessionOrgRequiredSeen` never having been set in this scenario, the entry must
    // disappear ENTIRELY rather than keep rendering the signed-out-from account's two orgs.
    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(0)
  })

  it('(i) switching accounts clears the host\'s session-org list before the new account\'s own load lands', async () => {
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    useAuth().setToken(jwt('org-a'))
    let sessionOrgsCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        sessionOrgsCalls += 1
        return jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
      }
      throw new Error(`unexpected fetch: ${path}`)
    }))

    await mountView()
    await enterGroupedView()
    await flushUi(8)
    expect(sessionOrgsCalls).toBe(1)

    // A DIFFERENT account signs in — `setToken` again, the same reset funnel `clearToken` uses —
    // before this page has re-run its own session-orgs fetch for the new principal.
    useAuth().setToken(jwt('org-z'))
    await nextTick()

    // The stale account's two-org entry must not still be sitting in the DOM the instant the
    // principal changes, before anything has re-fetched for the new one — same hard assertion as
    // the sign-out case: `orgs` was cleared synchronously by the reset funnel, so `hasMultipleOrgs`
    // is false and (with `sessionOrgRequiredSeen` never having fired) the entry is gone.
    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(0)

    // ROUND 3 — the half this case was missing. Round 2b flagged that asserting only the clearing
    // pinned the round-2 defect (P2-D) as though it were the specification: the entry went and
    // never came back for anyone. The CLEAR is only the first state of the lifecycle; the new
    // account is still a multi-org admin, so the page must re-ask for ITS organizations and the
    // entry must return without a reload.
    await flushUi(8)
    expect(sessionOrgsCalls).toBe(2)
    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(1)
  })

  // ═══ ROUND 3 — organization context lifecycle ═════════════════════════════════════════════
  //
  // Round 2b (impl-gate-A5-daily-ops-round2b-20260921.md) found that rounds 1-2 shipped only the
  // FIRST state of this lifecycle. The entry was fetched once per mounted component and the
  // clearing on a principal change was pinned as if it were the whole story, so the page ended up
  // with a one-way latch: any principal change this page did not perform, and any failed lookup,
  // removed the entry until a full reload (P2-D); the flat gallery kept rendering an organization
  // the admin had already left (P3-E); and only one of the request guard's three exits was ever
  // driven (P3-F).
  //
  // The four boundaries below are the round-3 acceptance, one describe-block section each:
  //   ① external identity change — sign-out, a DIFFERENT account, and the SAME account's rights
  //      changing — clears the old organization and its data first, then re-determines
  //      eligibility. "Always reachable" is scoped to identities that are still ELIGIBLE;
  //      disappearing after sign-out or a loss of eligibility is the CORRECT rendering.
  //   ② every data view stays in step — after an organization switch the flat gallery re-reads
  //      too, and the previous organization's rows are never shown as this one's answer.
  //   ③ (in the two component specs) the request guard's three exits.
  //   ④ a failed lookup is recoverable, and a superseded request takes no recovery action.

  // The `name` column is a bare `prop` column, and the ElTable stub at the top of this file only
  // renders columns that have a default SLOT — so a row's identity is asserted through its
  // category tag (`template-center-row-category`), which does have one, plus the row count.
  const lifecycleTemplate = (id: string, marker: string) => ({
    id,
    name: marker,
    description: null,
    category: marker,
    status: 'published' as const,
    visibilityScope: { type: 'all' as const, ids: [] },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  })

  const lifecycleGroup = (id: string, orgId: string, name: string) => ({
    id,
    orgId,
    name,
    sortOrder: 1,
    createdBy: 'actor',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    archivedAt: null,
  })

  /** Same shape as `jwt` above, with the USER id under the caller's control. */
  const jwtFor = (userId: string, org: string, serial = 1) =>
    `header.${btoa(JSON.stringify({ userId, tenantId: org, exp: Math.floor(Date.now() / 1000) + 60 + serial }))}.signature`

  async function enterFlatView() {
    ;(container!.querySelector('[data-testid="template-center-view-mode-flat"]') as HTMLButtonElement).click()
    await flushUi(4)
  }

  // ── ① external identity change ──────────────────────────────────────────────────────────────

  it('(① sign-out) clears the previous account\'s organization list AND its grouped/flat data, leaves no error behind, and re-asks nothing', async () => {
    listTemplateCategoriesSpy.mockResolvedValue(['请假'])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    listApprovalTemplateGroupsSpy.mockResolvedValue([lifecycleGroup('atg_a', 'org-a', 'Org A Group')])
    mockTemplates.value = [lifecycleTemplate('tpl_a', 'Org A Template')]
    mockTotal.value = 1
    useAuth().setToken(jwt('org-a'))
    let sessionOrgsCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        sessionOrgsCalls += 1
        return jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
      }
      throw new Error(`unexpected fetch: ${path}`)
    }))

    await mountView()
    // Positive control for the flat assertion at the end: the previous account's row IS rendered
    // here, through the one column the table stub actually paints.
    expect(container!.querySelectorAll('[data-el-row]').length).toBe(1)
    expect(container!.textContent).toContain('Org A Template')
    await enterGroupedView()
    await flushUi(8)
    expect(sessionOrgsCalls).toBe(1)
    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(1)
    expect(container!.textContent).toContain('Org A Group')

    useAuth().clearToken()
    await flushUi(10)

    // Entry gone — the CORRECT rendering for an identity that is no longer eligible, not a bug.
    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(0)
    // ...and gone WITHOUT an error residue: no switcher error hint, no retry control, no group
    // error banner. A signed-out page that shows "could not load organizations" is answering a
    // question nobody asked.
    expect(container!.querySelector('[data-testid="template-center-session-orgs-retry"]')).toBeNull()
    expect(container!.querySelector('[data-testid="template-group-sections-error"]')).toBeNull()
    expect(container!.querySelector('[data-testid="approval-template-groups-load-error"]')).toBeNull()
    // The previous account's DATA is gone too, in both view modes — not just its org list.
    expect(container!.textContent).not.toContain('Org A Group')
    await enterFlatView()
    expect(container!.querySelectorAll('[data-el-row]').length).toBe(0)
    expect(container!.textContent).not.toContain('Org A Template')
    // The store itself still physically holds the signed-out account's row — nothing else in the
    // app re-reads it — so this is the page refusing to RENDER it, not the store emptying.
    expect(mockTemplates.value.map((t: { id: string }) => t.id)).toEqual(['tpl_a'])
    // Nothing was re-asked for a principal that no longer exists.
    expect(sessionOrgsCalls).toBe(1)
  })

  it('(① different account) re-asks for the NEW account\'s organizations; the entry comes back for it and carries none of the previous account\'s options', async () => {
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    useAuth().setToken(jwtFor('actorA', 'org-a'))
    let sessionOrgsCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        sessionOrgsCalls += 1
        return sessionOrgsCalls === 1
          ? jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
          : jsonResponse(200, { success: true, data: { orgs: ['org-c', 'org-d'], currentOrgId: 'org-c' } })
      }
      throw new Error(`unexpected fetch: ${path}`)
    }))

    await mountView()
    await enterGroupedView()
    await flushUi(8)
    const before = container!.querySelector('select[name="sessionOrgId"]') as HTMLSelectElement
    expect(Array.from(before.options).some((o) => o.value === 'org-a')).toBe(true)

    useAuth().setToken(jwtFor('actorB', 'org-c'))
    await flushUi(10)

    expect(sessionOrgsCalls).toBe(2)
    const after = container!.querySelectorAll('select[name="sessionOrgId"]')
    expect(after.length).toBe(1)
    const options = Array.from((after[0] as HTMLSelectElement).options).map((o) => o.value)
    expect(options).toContain('org-c')
    // Not a merge and not a leftover: the previous account's memberships are not offered to this
    // one even though the list looks structurally identical.
    expect(options).not.toContain('org-a')
    expect(options).not.toContain('org-b')
  })

  it('(① same account, rights change) losing the second organization re-asks and takes the entry away — no stale list, no error', async () => {
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    useAuth().setToken(jwtFor('actor', 'org-a', 1))
    let sessionOrgsCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        sessionOrgsCalls += 1
        // The SAME person, re-issued a token after their membership was revoked server-side.
        return sessionOrgsCalls === 1
          ? jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
          : jsonResponse(200, { success: true, data: { orgs: ['org-a'], currentOrgId: 'org-a' } })
      }
      throw new Error(`unexpected fetch: ${path}`)
    }))

    await mountView()
    await enterGroupedView()
    await flushUi(8)
    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(1)

    // A refresh for the SAME subject: `getAuthPrincipalKey()` is deliberately stable across this
    // (it is subject-keyed), which is exactly why the re-ask cannot be conditioned on the key
    // alone — the reset funnel's notification is the half that sees this one.
    useAuth().setToken(jwtFor('actor', 'org-a', 2))
    await flushUi(10)

    expect(sessionOrgsCalls).toBe(2)
    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(0)
    expect(container!.querySelector('[data-testid="template-center-session-orgs-retry"]')).toBeNull()
  })

  it('(① same account, rights change) GAINING a second organization brings the entry back without a reload', async () => {
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    useAuth().setToken(jwtFor('actor', 'org-a', 1))
    let sessionOrgsCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        sessionOrgsCalls += 1
        return sessionOrgsCalls === 1
          ? jsonResponse(200, { success: true, data: { orgs: ['org-a'], currentOrgId: 'org-a' } })
          : jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
      }
      throw new Error(`unexpected fetch: ${path}`)
    }))

    await mountView()
    await enterGroupedView()
    await flushUi(8)
    // Single-org member: acceptance J's positive control holds on entry.
    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(0)

    useAuth().setToken(jwtFor('actor', 'org-a', 2))
    await flushUi(10)

    expect(sessionOrgsCalls).toBe(2)
    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(1)
  })

  it('(① another tab) a token swapped with NO notification at all is caught by the principal-keyed claim on the next entry into the grouped view', async () => {
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    useAuth().setToken(jwtFor('actorA', 'org-a'))
    let sessionOrgsCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        sessionOrgsCalls += 1
        return jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
      }
      throw new Error(`unexpected fetch: ${path}`)
    }))

    await mountView()
    await enterGroupedView()
    await flushUi(8)
    expect(sessionOrgsCalls).toBe(1)

    // Written STRAIGHT to storage, bypassing `useAuth`'s setters entirely — the shape another
    // browsing context produces, and the one `authPrincipal.ts` says the notification cannot see
    // ("A principal swap that bypasses `useAuth`'s setters ... produces no notification at all,
    // so a per-principal cache must ALSO key on `getAuthPrincipalKey()`"). Nothing fires here.
    localStorage.setItem('auth_token', jwtFor('actorB', 'org-c'))
    localStorage.setItem('jwt', jwtFor('actorB', 'org-c'))
    await flushUi(4)
    expect(sessionOrgsCalls).toBe(1)

    // Re-entering the grouped view re-evaluates the claim against the CURRENT principal key,
    // which is now a different subject — so the answer held for the previous one is not reused.
    await enterFlatView()
    await enterGroupedView()
    await flushUi(8)
    expect(sessionOrgsCalls).toBe(2)
  })

  it('(①) a "blocked on a session-org choice" state does not carry over to the next identity — acceptance J\'s control holds for a single-org successor', async () => {
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    const api = await import('../src/approvals/api')
    // Account A is UNBOUND: every group endpoint fail-closes 403 SESSION_ORG_REQUIRED, which is
    // what makes the hosted child report up and the page open the entry reactively.
    let unbound = true
    listApprovalTemplateGroupsSpy.mockImplementation(async () => {
      if (unbound) throw sessionOrgRequiredError(api.ApprovalApiError as unknown as new (m: string) => Error)
      return []
    })
    useAuth().setToken(jwtFor('actorA', 'org-a'))
    let sessionOrgsCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        sessionOrgsCalls += 1
        return sessionOrgsCalls === 1
          ? jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: null } })
          // Account B belongs to exactly ONE organization.
          : jsonResponse(200, { success: true, data: { orgs: ['org-solo'], currentOrgId: 'org-solo' } })
      }
      throw new Error(`unexpected fetch: ${path}`)
    }))

    await mountView()
    await enterGroupedView()
    await flushUi(10)
    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(1)

    unbound = false
    useAuth().setToken(jwtFor('actorB', 'org-solo'))
    await flushUi(10)

    expect(sessionOrgsCalls).toBe(2)
    // B is a single-org member. The page-level visibility rule has TWO disjuncts and only the
    // first is about eligibility; the second ("a child reported a 403") belonged to A's session
    // and must not survive it, or J's positive control is false for B through no fault of B's.
    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(0)
  })

  // ── ② every data view stays in step ─────────────────────────────────────────────────────────

  it('(②) switching organization re-reads the FLAT gallery and the category list, not only the grouped surfaces', async () => {
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    useAuth().setToken(jwt('org-a'))
    let sessionOrgsCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: { method?: string }) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        sessionOrgsCalls += 1
        return jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
      }
      if (String(path).endsWith('/api/auth/session-org') && init?.method === 'POST') {
        return jsonResponse(200, { success: true, data: { currentOrgId: 'org-b', token: jwt('org-b') } })
      }
      throw new Error(`unexpected fetch: ${path} ${init?.method}`)
    }))

    await mountView()
    await enterGroupedView()
    await flushUi(8)
    const templatesBefore = loadTemplatesSpy.mock.calls.length
    const categoriesBefore = listTemplateCategoriesSpy.mock.calls.length
    const groupsBefore = listApprovalTemplateGroupsSpy.mock.calls.length

    const select = container!.querySelector('select[name="sessionOrgId"]') as HTMLSelectElement
    select.value = 'org-b'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(10)

    // The grouped surfaces were already re-read before this round; the flat ones are the fix.
    expect(listApprovalTemplateGroupsSpy.mock.calls.length).toBeGreaterThan(groupsBefore)
    expect(loadTemplatesSpy.mock.calls.length).toBeGreaterThan(templatesBefore)
    expect(listTemplateCategoriesSpy.mock.calls.length).toBeGreaterThan(categoriesBefore)
    // The page's OWN switch must not also re-ask for the organization list: the composable
    // restores the membership list itself across its own switch — so the claim is re-KEYED to the
    // post-switch principal rather than dropped, and a later re-entry still finds it satisfied.
    expect(sessionOrgsCalls).toBe(1)
    await enterFlatView()
    await enterGroupedView()
    await flushUi(8)
    expect(sessionOrgsCalls).toBe(1)
    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(1)
  })

  it('(②) while the new organization\'s template list is in flight the flat surfaces show their empty state, never the previous organization\'s rows', async () => {
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    mockTemplates.value = [lifecycleTemplate('tpl_a', 'Org A Template')]
    mockTotal.value = 1
    useAuth().setToken(jwt('org-a'))
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: { method?: string }) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        return jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
      }
      if (String(path).endsWith('/api/auth/session-org') && init?.method === 'POST') {
        return jsonResponse(200, { success: true, data: { currentOrgId: 'org-b', token: jwt('org-b') } })
      }
      throw new Error(`unexpected fetch: ${path} ${init?.method}`)
    }))

    await mountView()
    expect(container!.querySelectorAll('[data-el-row]').length).toBe(1)
    expect(container!.textContent).toContain('Org A Template')
    await enterGroupedView()
    await flushUi(8)

    // The new organization's list read hangs — the real window this boundary is about.
    let releaseNewOrgList: (() => void) | null = null
    loadTemplatesSpy.mockImplementation(
      () => new Promise<string>((resolve) => {
        releaseNewOrgList = () => {
          mockTemplates.value = [lifecycleTemplate('tpl_b', 'Org B Template')]
          resolve('applied')
        }
      }),
    )

    const select = container!.querySelector('select[name="sessionOrgId"]') as HTMLSelectElement
    select.value = 'org-b'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(10)
    await enterFlatView()

    // The store still physically holds org A's row (nothing else re-reads it), so this is exactly
    // the "old organization's data presented as the new organization's answer" case.
    expect(mockTemplates.value.map((t: { id: string }) => t.id)).toEqual(['tpl_a'])
    expect(container!.querySelectorAll('[data-el-row]').length).toBe(0)
    expect(container!.textContent).not.toContain('Org A Template')

    releaseNewOrgList!()
    await flushUi(8)
    expect(container!.querySelectorAll('[data-el-row]').length).toBe(1)
    expect(container!.textContent).toContain('Org B Template')
  })

  // ── ④ a failed lookup is recoverable ────────────────────────────────────────────────────────

  it('(④) a FAILED organization-list lookup offers a retry, and the retry re-asks and brings the entry up', async () => {
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    useAuth().setToken(jwt('org-a'))
    let sessionOrgsCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        sessionOrgsCalls += 1
        return sessionOrgsCalls === 1
          ? jsonResponse(500, { success: false })
          : jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
      }
      throw new Error(`unexpected fetch: ${path}`)
    }))

    await mountView()
    await enterGroupedView()
    await flushUi(8)

    expect(sessionOrgsCalls).toBe(1)
    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(0)
    const retry = container!.querySelector('[data-testid="template-center-session-orgs-retry"]') as HTMLButtonElement
    expect(retry).not.toBeNull()

    retry.click()
    await flushUi(10)

    expect(sessionOrgsCalls).toBe(2)
    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(1)
    expect(container!.querySelector('[data-testid="template-center-session-orgs-retry"]')).toBeNull()
  })

  it('(④) after a failed lookup, simply re-entering the grouped view re-asks — the entry is not latched off for the lifetime of the view', async () => {
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    useAuth().setToken(jwt('org-a'))
    let sessionOrgsCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        sessionOrgsCalls += 1
        return sessionOrgsCalls === 1
          ? jsonResponse(500, { success: false })
          : jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
      }
      throw new Error(`unexpected fetch: ${path}`)
    }))

    await mountView()
    await enterGroupedView()
    await flushUi(8)
    expect(sessionOrgsCalls).toBe(1)

    await enterFlatView()
    await enterGroupedView()
    await flushUi(8)

    expect(sessionOrgsCalls).toBe(2)
    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(1)
  })

  it('(④) a request issued for the PREVIOUS identity that lands with a 403 afterwards triggers no recovery action for the new one', async () => {
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    const api = await import('../src/approvals/api')
    // The sections view's mount-time `loadAll()` for account A never settles until we say so.
    let rejectStaleGroups: ((err: Error) => void) | null = null
    listApprovalTemplateGroupsSpy.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectStaleGroups = reject }),
    )
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    useAuth().setToken(jwtFor('actorA', 'org-a'))
    let sessionOrgsCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        sessionOrgsCalls += 1
        return sessionOrgsCalls === 1
          // Account A is a multi-org admin...
          ? jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
          // ...account B is NOT: exactly one organization, so B is not eligible for the entry.
          : jsonResponse(200, { success: true, data: { orgs: ['org-solo'], currentOrgId: 'org-solo' } })
      }
      throw new Error(`unexpected fetch: ${path}`)
    }))

    await mountView()
    await enterGroupedView()
    await flushUi(8)
    expect(sessionOrgsCalls).toBe(1)

    useAuth().setToken(jwtFor('actorB', 'org-solo'))
    await flushUi(10)
    expect(sessionOrgsCalls).toBe(2)
    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(0)

    // NOW account A's abandoned request fails the way an unbound session fails. Its catch branch
    // is the recovery path: it reports SESSION_ORG_REQUIRED to the host, which opens the entry
    // and asks for organizations. Doing that on behalf of a session that is gone would put a
    // switcher in front of an identity that is not eligible for one — and account B's own
    // (single-org) list is loaded, so the component-level gate would NOT hide it.
    const staleError = sessionOrgRequiredError(api.ApprovalApiError as unknown as new (m: string) => Error)
    rejectStaleGroups!(staleError)
    await flushUi(10)

    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(0)
    expect(container!.querySelector('[data-testid="template-group-sections-error"]')).toBeNull()
  })

  // ── ③ the three async exits, on the FLAT surfaces ───────────────────────────────────────────
  //
  // Round-3 gate C-1 (impl-gate-A5-daily-ops-round3-20260921.md) found the flat settle asking the
  // SHARED `store.error` slot "did my read succeed?". That slot has no request algebra, so a read
  // that had already been superseded could answer for the read that was actually current: the
  // admin switched organization, the abandoned read failed, the new read succeeded — and the table,
  // the gallery and the pager all rendered EMPTY with the abandoned read's banner on top of them.
  //
  // The algebra now lives in the store, at the slots (`templateStore.ts`), and its three exits are
  // pinned against the REAL store by the "request algebra" describe at the bottom of this file.
  // What the four cases below pin is the ONE decision this page still owns: the rendered rows are
  // declared current again only for an answer the store APPLIED. They are deliberately written so
  // that the old `if (!store.error)` line is red against T1, and so that dropping the
  // `outcome === 'applied'` condition is red against T2 and T3.

  it('(③ FLAT) an error left in the SHARED store slot by somebody else no longer blanks the organization whose own read succeeded', async () => {
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    mockTemplates.value = [lifecycleTemplate('tpl_a', 'Org A Template')]
    mockTotal.value = 1
    useAuth().setToken(jwt('org-a'))
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: { method?: string }) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        return jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
      }
      if (String(path).endsWith('/api/auth/session-org') && init?.method === 'POST') {
        return jsonResponse(200, { success: true, data: { currentOrgId: 'org-b', token: jwt('org-b') } })
      }
      throw new Error(`unexpected fetch: ${path} ${init?.method}`)
    }))

    await mountView()
    await enterGroupedView()
    await flushUi(8)

    // The new organization's read succeeds — and the shared error slot is dirty when it lands,
    // exactly as it is when an abandoned read failed a moment earlier. `store.error` is app-wide:
    // this page is not the only thing that can write it, and it carries no request identity at all.
    loadTemplatesSpy.mockImplementation(async () => {
      mockError.value = 'API error: 500 Internal Server Error'
      mockTemplates.value = [lifecycleTemplate('tpl_b', 'Org B Template')]
      mockTotal.value = 1
      return 'applied'
    })

    const select = container!.querySelector('select[name="sessionOrgId"]') as HTMLSelectElement
    select.value = 'org-b'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(12)
    await enterFlatView()

    // THE regression: rows present, not an empty table sitting on top of rows the store holds.
    expect(container!.querySelectorAll('[data-el-row]').length).toBe(1)
    expect(container!.textContent).toContain('Org B Template')
    expect(container!.textContent).not.toContain('Org A Template')
  })

  it('(③ FLAT, failure exit) when the re-read for the NEW context fails, the flat surfaces stay empty and the banner keeps its Reload control', async () => {
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    mockTemplates.value = [lifecycleTemplate('tpl_a', 'Org A Template')]
    mockTotal.value = 1
    useAuth().setToken(jwt('org-a'))
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: { method?: string }) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        return jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
      }
      if (String(path).endsWith('/api/auth/session-org') && init?.method === 'POST') {
        return jsonResponse(200, { success: true, data: { currentOrgId: 'org-b', token: jwt('org-b') } })
      }
      throw new Error(`unexpected fetch: ${path} ${init?.method}`)
    }))

    await mountView()
    expect(container!.querySelectorAll('[data-el-row]').length).toBe(1)
    await enterGroupedView()
    await flushUi(8)

    // The store's failure exit: `error` written, rows left exactly as they were (org A's).
    loadTemplatesSpy.mockImplementation(async () => {
      mockError.value = 'API error: 500 Internal Server Error'
      return 'failed'
    })

    const select = container!.querySelector('select[name="sessionOrgId"]') as HTMLSelectElement
    select.value = 'org-b'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(12)
    await enterFlatView()

    // org A's rows are STILL what the store physically holds — and they are not org B's answer,
    // so the page must not re-expose them. Blank plus an error, never "here is org B: 1 row".
    expect(mockTemplates.value.map((t: { id: string }) => t.id)).toEqual(['tpl_a'])
    expect(container!.querySelectorAll('[data-el-row]').length).toBe(0)
    expect(container!.textContent).not.toContain('Org A Template')
    // ...and the ONE control that can get the admin out of that blank state cannot be dismissed
    // away, because an empty table with no banner cannot answer "zero templates, or a failed read?".
    const alert = container!.querySelector('[data-el-alert]')
    expect(alert).not.toBeNull()
    expect(alert!.getAttribute('data-closable')).toBe('false')

    // Recoverable: the next successful read declares the rows current and takes the banner with it.
    loadTemplatesSpy.mockImplementation(async () => {
      mockError.value = null
      mockTemplates.value = [lifecycleTemplate('tpl_b', 'Org B Template')]
      mockTotal.value = 1
      return 'applied'
    })
    ;(container!.querySelector('[data-testid="template-center-category-filter"]') as HTMLSelectElement).value = ''
    ;(container!.querySelector('[data-testid="template-center-category-filter"]') as HTMLSelectElement)
      .dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(8)
    expect(container!.querySelectorAll('[data-el-row]').length).toBe(1)
    expect(container!.textContent).toContain('Org B Template')
    expect(container!.querySelector('[data-el-alert]')).toBeNull()
  })

  it('(③ FLAT, superseded exit) an abandoned read that settles while the new one is still in flight does not declare the rows current', async () => {
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    mockTemplates.value = [lifecycleTemplate('tpl_a', 'Org A Template')]
    mockTotal.value = 1
    useAuth().setToken(jwt('org-a'))
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: { method?: string }) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        return jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
      }
      if (String(path).endsWith('/api/auth/session-org') && init?.method === 'POST') {
        return jsonResponse(200, { success: true, data: { currentOrgId: 'org-b', token: jwt('org-b') } })
      }
      throw new Error(`unexpected fetch: ${path} ${init?.method}`)
    }))

    await mountView()
    await enterGroupedView()
    await flushUi(8)

    // The abandoned read (issued for org A) settles LAST, and the store tells it so: 'superseded'.
    // The new read never answers at all in this window.
    let settleAbandoned: ((outcome: string) => void) | null = null
    const abandoned = new Promise<string>((resolve) => { settleAbandoned = resolve })
    loadTemplatesSpy.mockImplementationOnce(() => abandoned)
    loadTemplatesSpy.mockImplementation(() => new Promise<string>(() => {}))
    // Issue it through a real production entry point (the category filter's own handler), so the
    // read really is one of this page's own overlapping `loadData()` calls.
    const filterEl = container!.querySelector('[data-testid="template-center-category-filter"]') as HTMLSelectElement
    filterEl.value = ''
    filterEl.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)

    const select = container!.querySelector('select[name="sessionOrgId"]') as HTMLSelectElement
    select.value = 'org-b'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(12)
    await enterFlatView()
    expect(container!.querySelectorAll('[data-el-row]').length).toBe(0)

    settleAbandoned!('superseded')
    await flushUi(8)

    // Still blank: 'superseded' means this read learned nothing about the context the page is in.
    expect(mockTemplates.value.map((t: { id: string }) => t.id)).toEqual(['tpl_a'])
    expect(container!.querySelectorAll('[data-el-row]').length).toBe(0)
    expect(container!.textContent).not.toContain('Org A Template')

    // ROUND 5 (gate round-4 C-1, 修法 item 4) — the half this case was missing. Its sibling
    // `(③ FLAT, failure exit)` pins the recovery affordance; this one asserted only that the rows
    // are not declared current, so "blank table, no banner, no Reload, and no organization entry
    // to leave by" — the exact rendered終态 C-1 produces — would have passed it unchanged. An
    // empty state is only acceptable while a way OUT of it is still on screen.
    await enterGroupedView()
    await flushUi(8)
    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(1)

    // ...and the blank state is not absorbing: the next answer that IS current re-exposes rows.
    loadTemplatesSpy.mockReset()
    loadTemplatesSpy.mockImplementation(async () => {
      mockTemplates.value = [lifecycleTemplate('tpl_b', 'Org B Template')]
      mockTotal.value = 1
      return 'applied'
    })
    await enterFlatView()
    ;(container!.querySelector('[data-testid="template-center-category-filter"]') as HTMLSelectElement).value = ''
    ;(container!.querySelector('[data-testid="template-center-category-filter"]') as HTMLSelectElement)
      .dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(8)
    expect(container!.querySelectorAll('[data-el-row]').length).toBe(1)
    expect(container!.textContent).toContain('Org B Template')
  })

  // ═══ ROUND 5 — who may CLAIM a transition (gate `impl-gate-A5-daily-ops-round4-20260921.md` C-1) ═
  //
  // Round 3 taught `pageSessionOrgsClaim` that a bare boolean is not an identity (M-C). Round 4's
  // gate found the same shape one door along: `pageOwnedSwitchInFlight` answered only "is one of my
  // switches in flight?", so ANY external transition that arrived inside the
  // `POST /api/auth/session-org` round trip was labelled "mine" — claim kept, listener re-read
  // skipped, and the page's own replay skipped too because its POST then returned `false`. The
  // rendered終态 is C-1's: blank flat table, no banner, no Reload, no organization switcher.
  //
  // The three cases below drive the three ways a transition can arrive in that window. All three
  // keep the page's own POST IN FLIGHT at the moment of the external transition wherever the
  // listener is the thing under test, so nothing downstream of the `await` can mask a listener that
  // mis-credits it.

  it('(① C-1) an EXTERNAL identity change landing inside this page\'s own switch window is NOT credited to this page: one re-read, the organization list is re-asked, the entry stays, the flat table comes back', async () => {
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    mockTemplates.value = [lifecycleTemplate('tpl_a', 'Org A Template')]
    mockTotal.value = 1
    useAuth().setToken(jwt('org-a'))

    let sessionOrgsCalls = 0
    let releaseSwitchPost: (() => void) | null = null
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: { method?: string }) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        sessionOrgsCalls += 1
        return jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
      }
      if (String(path).endsWith('/api/auth/session-org') && init?.method === 'POST') {
        await new Promise<void>((resolve) => { releaseSwitchPost = resolve })
        return jsonResponse(200, { success: true, data: { currentOrgId: 'org-b', token: jwt('org-b') } })
      }
      throw new Error(`unexpected fetch: ${path} ${init?.method}`)
    }))

    await mountView()
    await enterGroupedView()
    await flushUi(8)
    expect(sessionOrgsCalls).toBe(1)

    const readsBefore = loadTemplatesSpy.mock.calls.length
    const select = container!.querySelector('select[name="sessionOrgId"]') as HTMLSelectElement
    select.value = 'org-b'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(4)
    // The window really is open — otherwise this case would be testing nothing.
    expect(releaseSwitchPost).not.toBeNull()

    // A transition this page did NOT perform, through the real `useAuth` funnel: the same producer
    // as an invite acceptance, a DingTalk callback, a forced password change or a dev-token
    // refresh. `setToken` does NOT preserve the explicit-session marker, so the session this page
    // now holds carries no organization at all — it cannot be the switch this page asked for.
    mockTemplates.value = [lifecycleTemplate('tpl_x', 'External Template')]
    mockTotal.value = 1
    useAuth().setToken(jwtFor('actor', 'org-x', 7))
    await flushUi(14)

    // Boundary ① in full: cleared → eligibility re-determined → re-read, exactly once.
    expect(loadTemplatesSpy.mock.calls.length - readsBefore).toBe(1)
    expect(sessionOrgsCalls).toBe(2)
    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(1)

    await enterFlatView()
    expect(container!.querySelectorAll('[data-el-row]').length).toBe(1)
    expect(container!.textContent).toContain('External Template')
  })

  it('(① C-1, second transition) a LATER external change that happens to land on this page\'s target organization is still external — the claim was already invalidated by the first one', async () => {
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    mockTemplates.value = [lifecycleTemplate('tpl_a', 'Org A Template')]
    mockTotal.value = 1
    useAuth().setToken(jwt('org-a'))

    let sessionOrgsCalls = 0
    let releaseSwitchPost: (() => void) | null = null
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: { method?: string }) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        sessionOrgsCalls += 1
        return jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
      }
      if (String(path).endsWith('/api/auth/session-org') && init?.method === 'POST') {
        await new Promise<void>((resolve) => { releaseSwitchPost = resolve })
        return jsonResponse(200, { success: true, data: { currentOrgId: 'org-b', token: jwt('org-b') } })
      }
      throw new Error(`unexpected fetch: ${path} ${init?.method}`)
    }))

    await mountView()
    await enterGroupedView()
    await flushUi(8)
    const readsBefore = loadTemplatesSpy.mock.calls.length

    const select = container!.querySelector('select[name="sessionOrgId"]') as HTMLSelectElement
    select.value = 'org-b'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(4)
    expect(releaseSwitchPost).not.toBeNull()

    // First external transition: a bare token swap, no organization marker ⇒ plainly external.
    useAuth().setToken(jwtFor('actor', 'org-x', 5))
    await flushUi(14)
    expect(loadTemplatesSpy.mock.calls.length - readsBefore).toBe(1)
    expect(sessionOrgsCalls).toBe(2)

    // Second external transition, and this one DOES land on `org-b` — the organization this page
    // asked for — with the explicit marker preserved, exactly as another tab's switch arrives here
    // (`useAuth.ts:74-79` republishes it with `preserveExplicitSession`). Matching the target is
    // therefore not sufficient on its own: this page's claim was invalidated by the FIRST
    // transition, and only the signature half can see that.
    const carrier = localStorage.getItem('auth_token')!
    expect(useAuth().setExplicitSessionOrg(jwtFor('actor', 'org-b', 9), 'org-b', carrier)).toBe(true)
    await flushUi(14)

    expect(loadTemplatesSpy.mock.calls.length - readsBefore).toBe(2)
    expect(sessionOrgsCalls).toBe(3)
    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(1)
  })

  it('(① C-1, indistinguishable case) a foreign switch to this page\'s OWN target organization is credited to the page at the listener — and the superseded switch is what recovers from it', async () => {
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    mockTemplates.value = [lifecycleTemplate('tpl_a', 'Org A Template')]
    mockTotal.value = 1
    useAuth().setToken(jwt('org-a'))

    let sessionOrgsCalls = 0
    let releaseSwitchPost: (() => void) | null = null
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: { method?: string }) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        sessionOrgsCalls += 1
        return jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
      }
      if (String(path).endsWith('/api/auth/session-org') && init?.method === 'POST') {
        await new Promise<void>((resolve) => { releaseSwitchPost = resolve })
        return jsonResponse(200, { success: true, data: { currentOrgId: 'org-b', token: jwt('org-b') } })
      }
      throw new Error(`unexpected fetch: ${path} ${init?.method}`)
    }))

    await mountView()
    await enterGroupedView()
    await flushUi(8)
    const readsBefore = loadTemplatesSpy.mock.calls.length

    const select = container!.querySelector('select[name="sessionOrgId"]') as HTMLSelectElement
    select.value = 'org-b'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(4)
    expect(releaseSwitchPost).not.toBeNull()

    // Somebody else switches THIS session to the very organization this page is asking for, marker
    // preserved. At the listener the two are genuinely the same event, and the page credits it to
    // itself — that is recorded here rather than papered over.
    const carrier = localStorage.getItem('auth_token')!
    mockTemplates.value = [lifecycleTemplate('tpl_b', 'Org B Template')]
    mockTotal.value = 1
    expect(useAuth().setExplicitSessionOrg(jwtFor('actor', 'org-b', 9), 'org-b', carrier)).toBe(true)
    await flushUi(14)
    expect(loadTemplatesSpy.mock.calls.length - readsBefore).toBe(0)
    expect(sessionOrgsCalls).toBe(1)

    // The page's own POST now lands and is refused by `useSessionOrg`'s own guard (the token it was
    // issued under is gone). THIS is where the page learns the transition it credited to itself was
    // not its own — and it must recover rather than return into a blank table.
    releaseSwitchPost!()
    await flushUi(16)

    expect(loadTemplatesSpy.mock.calls.length - readsBefore).toBe(1)
    expect(sessionOrgsCalls).toBe(2)
    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(1)
    await enterFlatView()
    expect(container!.querySelectorAll('[data-el-row]').length).toBe(1)
    expect(container!.textContent).toContain('Org B Template')
  })

  // ═══ ROUND 6 — gate round-5 C-1 (P2) and C-3 (P3) ════════════════════════════════════════
  //
  // C-1: the round-5 gate drove a real cross-tab organization switch in a real browser and caught
  // an UNCAUGHT exception on this very path — `getAuthPrincipalKey()` throws when the explicit
  // metadata is self-inconsistent, and the lifecycle listener's deferred re-read reached it while
  // another tab was mid-switch. The re-read was skipped entirely. Round 5 had also written a
  // comment asserting that state was unreachable here; it is not. Covered below.
  //
  // C-3: the three round-5 C-1 cases all satisfy criterion (b) by having NOTHING to read — a
  // `setToken` leaves no marker, and the one case with a marker is the case where the marker was
  // installed by the very transition being credited. None of them can tell "(b) rejected a valid
  // competing marker" apart from "there was no marker". The three cases after the C-1 one below
  // put a VALID, READY marker in place first, so (b) and (a) are each exercised on an input where
  // the other half is satisfied.

  /**
   * Another tab, mid-switch. `setExplicitSessionOrg` is four separate `localStorage` writes — the
   * `'changing'` barrier, `auth_token`, `jwt`, then the `'ready'` marker — and in a browser each
   * one dispatches its own `storage` event into this tab. This helper reproduces the state after
   * the token aliases have been swapped but before the final marker is published: every reader of
   * the explicit metadata throws until `completeForeignSwitch` lands.
   */
  function beginForeignSwitchWithoutPublishing(incomingToken: string): void {
    localStorage.setItem('metasheet.explicitSessionOrg.v1', JSON.stringify({ state: 'changing', epoch: 'foreign-epoch-1' }))
    localStorage.setItem('auth_token', incomingToken)
    localStorage.setItem('jwt', incomingToken)
    window.dispatchEvent(new StorageEvent('storage', { key: 'jwt', newValue: incomingToken }))
  }

  function completeForeignSwitch(incomingToken: string, orgId: string): void {
    const payload = JSON.parse(atob(incomingToken.split('.')[1])) as Record<string, unknown>
    const marker = JSON.stringify({
      state: 'ready', token: incomingToken, actor: payload.userId, tenantId: orgId,
      exp: payload.exp, epoch: 'foreign-epoch-1',
    })
    localStorage.setItem('metasheet.explicitSessionOrg.v1', marker)
    window.dispatchEvent(new StorageEvent('storage', { key: 'metasheet.explicitSessionOrg.v1', newValue: marker }))
  }

  it('(① C-1, partial transition) a cross-tab switch whose marker and token still disagree does NOT throw through the listener: the re-read happens, the failure is rendered as recoverable, and the entry comes back when the switch completes', async () => {
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    mockTemplates.value = [lifecycleTemplate('tpl_a', 'Org A Template')]
    mockTotal.value = 1
    useAuth().setToken(jwt('org-a'))

    let sessionOrgsCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        sessionOrgsCalls += 1
        return jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
      }
      throw new Error(`unexpected fetch: ${path}`)
    }))

    await mountView()
    await enterGroupedView()
    await flushUi(8)
    expect(sessionOrgsCalls).toBe(1)
    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(1)

    const readsBefore = loadTemplatesSpy.mock.calls.length
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // The window the gate measured: token aliases already swapped, marker still `'changing'`.
      const incoming = jwtFor('actor', 'org-b', 11)
      mockTemplates.value = [lifecycleTemplate('tpl_b', 'Org B Template')]
      mockTotal.value = 1
      beginForeignSwitchWithoutPublishing(incoming)
      await flushUi(16)

      // The catch was ENTERED — this is what makes the case below a statement about the unreadable
      // path and not about an ordinary session change.
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('session principal is unreadable'))).toBe(true)

      // The whole point of C-1: the re-read is NOT skipped. On the round-5 head this is 0, because
      // the throw aborted `redetermineEligibilityAndReload()` before `reloadOrgScopedSurfaces()`.
      expect(loadTemplatesSpy.mock.calls.length - readsBefore).toBe(1)

      // WHAT IS DELIBERATELY NOT PINNED HERE, and why. `authHeaders()` (`utils/api.ts:167`) reads
      // the same explicit metadata with no guard of its own, so TODAY every request out of this app
      // throws until the switch lands and the organization-list re-ask cannot get out. That is an
      // out-of-population sibling of C-1, disclosed and left OPEN for the owner (design MD §9.1) —
      // so asserting "the lookup did not go out" would pin a defect as though it were the
      // specification, which is exactly what round 2b's P2-D caught in this same file.
      //
      // What this page owes the admin either way is a WAY OUT: whichever way the lookup went, the
      // grouped view must offer something to act on rather than silently show nothing. That holds
      // today (lookup fails ⇒ the retry control) and it still holds if `api.ts` is ever guarded
      // (lookup succeeds ⇒ the switcher). On the round-5 head, and under M-U, it is NEITHER,
      // because the re-read never happened at all.
      const waysOut = container!.querySelectorAll('[data-testid="session-org-switcher"]').length
        + container!.querySelectorAll('[data-testid="template-center-session-orgs-retry"]').length
      expect(waysOut).toBeGreaterThanOrEqual(1)

      // The other tab publishes the final marker. Everything is readable again, and the entry
      // comes back with no reload — the page was never in a dead state.
      completeForeignSwitch(incoming, 'org-b')
      await flushUi(16)
      // `>= 2` for the same reason as above: how many lookups got out DURING the unreadable window
      // depends on `utils/api.ts:167`, which is not this round's to decide. The re-read count and
      // the rendered entry do not — the store is mocked here, so neither goes through `apiFetch`.
      expect(sessionOrgsCalls).toBeGreaterThanOrEqual(2)
      expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(1)
      expect(loadTemplatesSpy.mock.calls.length - readsBefore).toBe(2)
    } finally {
      warnSpy.mockRestore()
    }

    await enterFlatView()
    expect(container!.querySelectorAll('[data-el-row]').length).toBe(1)
    expect(container!.textContent).toContain('Org B Template')
  })

  it("(① C-1, criterion (b) discriminating) a foreign switch to a DIFFERENT organization is rejected while a VALID ready marker is standing — (b) works by reading a target, not by finding nothing to read", async () => {
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    mockTemplates.value = [lifecycleTemplate('tpl_a', 'Org A Template')]
    mockTotal.value = 1
    useAuth().setToken(jwt('org-a'))
    // A REAL explicit session is standing before anything else happens, so `currentExplicitSessionOrg()`
    // has something to read at every point below. The three round-5 cases never had one.
    expect(useAuth().setExplicitSessionOrg(jwtFor('actor', 'org-a', 2), 'org-a', localStorage.getItem('auth_token')!)).toBe(true)

    let sessionOrgsCalls = 0
    let releaseSwitchPost: (() => void) | null = null
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: { method?: string }) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        sessionOrgsCalls += 1
        return jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
      }
      if (String(path).endsWith('/api/auth/session-org') && init?.method === 'POST') {
        await new Promise<void>((resolve) => { releaseSwitchPost = resolve })
        return jsonResponse(200, { success: true, data: { currentOrgId: 'org-b', token: jwtFor('actor', 'org-b', 3) } })
      }
      throw new Error(`unexpected fetch: ${path} ${init?.method}`)
    }))

    await mountView()
    await enterGroupedView()
    await flushUi(8)
    expect(sessionOrgsCalls).toBe(1)
    const readsBefore = loadTemplatesSpy.mock.calls.length

    const select = container!.querySelector('select[name="sessionOrgId"]') as HTMLSelectElement
    select.value = 'org-b'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(4)
    expect(releaseSwitchPost).not.toBeNull()

    // Somebody else moves this session to org-z, with a fully valid `state:'ready'` marker. The
    // signature half (a) is SATISFIED — nothing has moved the session since this page issued its
    // switch — so (b) is the only thing that can reject it, and it must: org-z is not org-b.
    mockTemplates.value = [lifecycleTemplate('tpl_z', 'Org Z Template')]
    mockTotal.value = 1
    expect(useAuth().setExplicitSessionOrg(jwtFor('actor', 'org-z', 9), 'org-z', localStorage.getItem('auth_token')!)).toBe(true)
    await flushUi(16)

    expect(loadTemplatesSpy.mock.calls.length - readsBefore).toBe(1)
    expect(sessionOrgsCalls).toBe(2)
    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(1)

    // The page's own POST now lands and is refused by `useSessionOrg`'s own guard. The listener
    // never credited anything to this page, so the `!ok` fallback must NOT fire a second re-read.
    releaseSwitchPost!()
    await flushUi(16)
    expect(loadTemplatesSpy.mock.calls.length - readsBefore).toBe(1)
    expect(sessionOrgsCalls).toBe(2)

    await enterFlatView()
    expect(container!.textContent).toContain('Org Z Template')
  })

  it("(① C-1, criterion (a) with a valid marker standing) a SECOND foreign switch that lands on this page's own target is still external — (a) rejects it even though (b) matches", async () => {
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    mockTemplates.value = [lifecycleTemplate('tpl_a', 'Org A Template')]
    mockTotal.value = 1
    useAuth().setToken(jwt('org-a'))
    expect(useAuth().setExplicitSessionOrg(jwtFor('actor', 'org-a', 2), 'org-a', localStorage.getItem('auth_token')!)).toBe(true)

    let sessionOrgsCalls = 0
    let releaseSwitchPost: (() => void) | null = null
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: { method?: string }) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        sessionOrgsCalls += 1
        return jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
      }
      if (String(path).endsWith('/api/auth/session-org') && init?.method === 'POST') {
        await new Promise<void>((resolve) => { releaseSwitchPost = resolve })
        return jsonResponse(200, { success: true, data: { currentOrgId: 'org-b', token: jwtFor('actor', 'org-b', 3) } })
      }
      throw new Error(`unexpected fetch: ${path} ${init?.method}`)
    }))

    await mountView()
    await enterGroupedView()
    await flushUi(8)
    const readsBefore = loadTemplatesSpy.mock.calls.length

    const select = container!.querySelector('select[name="sessionOrgId"]') as HTMLSelectElement
    select.value = 'org-b'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(4)
    expect(releaseSwitchPost).not.toBeNull()

    // First foreign switch: valid marker, WRONG organization ⇒ (b) rejects, claim NOT consumed.
    expect(useAuth().setExplicitSessionOrg(jwtFor('actor', 'org-z', 9), 'org-z', localStorage.getItem('auth_token')!)).toBe(true)
    await flushUi(16)
    expect(loadTemplatesSpy.mock.calls.length - readsBefore).toBe(1)
    expect(sessionOrgsCalls).toBe(2)

    // Second foreign switch: valid marker, and it lands on org-b — the organization this page is
    // asking for, so (b) MATCHES. Only the signature half can see that this page's claim was
    // invalidated by the first transition. Same shape as `(① C-1, second transition)`, but with a
    // readable marker standing throughout rather than a bare token swap.
    mockTemplates.value = [lifecycleTemplate('tpl_b', 'Org B Template')]
    mockTotal.value = 1
    expect(useAuth().setExplicitSessionOrg(jwtFor('actor', 'org-b', 13), 'org-b', localStorage.getItem('auth_token')!)).toBe(true)
    await flushUi(16)

    expect(loadTemplatesSpy.mock.calls.length - readsBefore).toBe(2)
    expect(sessionOrgsCalls).toBe(3)
    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(1)
    await enterFlatView()
    expect(container!.textContent).toContain('Org B Template')
  })

  it("(① C-1, external transition AFTER this page's switch answered) a REFUSED switch leaves no claim behind for a later foreign transition to satisfy", async () => {
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    mockTemplates.value = [lifecycleTemplate('tpl_a', 'Org A Template')]
    mockTotal.value = 1
    useAuth().setToken(jwt('org-a'))
    expect(useAuth().setExplicitSessionOrg(jwtFor('actor', 'org-a', 2), 'org-a', localStorage.getItem('auth_token')!)).toBe(true)

    let sessionOrgsCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: { method?: string }) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        sessionOrgsCalls += 1
        return jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
      }
      if (String(path).endsWith('/api/auth/session-org') && init?.method === 'POST') {
        return jsonResponse(403, { success: false, error: { code: 'SESSION_ORG_FORBIDDEN' } })
      }
      throw new Error(`unexpected fetch: ${path} ${init?.method}`)
    }))

    await mountView()
    await enterGroupedView()
    await flushUi(8)
    const readsBefore = loadTemplatesSpy.mock.calls.length

    // The page asks and is REFUSED: no principal change, nothing to clear, nothing to re-read.
    const select = container!.querySelector('select[name="sessionOrgId"]') as HTMLSelectElement
    select.value = 'org-b'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(16)
    expect(loadTemplatesSpy.mock.calls.length - readsBefore).toBe(0)
    expect(sessionOrgsCalls).toBe(1)

    // LATER — strictly after this page's own request has answered — another tab really does move
    // this session to org-b, the organization this page had asked for. Both criteria would say
    // "mine" if the claim were still standing: nothing has moved the session since it was issued,
    // and the target matches exactly. What makes this external is that the claim is GONE, dropped
    // in `onPageSessionOrgChange`'s `finally` when the request answered.
    mockTemplates.value = [lifecycleTemplate('tpl_b', 'Org B Template')]
    mockTotal.value = 1
    expect(useAuth().setExplicitSessionOrg(jwtFor('actor', 'org-b', 9), 'org-b', localStorage.getItem('auth_token')!)).toBe(true)
    await flushUi(16)

    expect(loadTemplatesSpy.mock.calls.length - readsBefore).toBe(1)
    expect(sessionOrgsCalls).toBe(2)
    expect(container!.querySelectorAll('[data-testid="session-org-switcher"]').length).toBe(1)
    await enterFlatView()
    expect(container!.textContent).toContain('Org B Template')
  })

  it("(② M-F) the page's OWN organization switch re-reads every org-scoped surface exactly ONCE", async () => {
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    useAuth().setToken(jwt('org-a'))
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: { method?: string }) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        return jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
      }
      if (String(path).endsWith('/api/auth/session-org') && init?.method === 'POST') {
        return jsonResponse(200, { success: true, data: { currentOrgId: 'org-b', token: jwt('org-b') } })
      }
      throw new Error(`unexpected fetch: ${path} ${init?.method}`)
    }))

    await mountView()
    await enterGroupedView()
    await flushUi(8)
    const templatesBefore = loadTemplatesSpy.mock.calls.length
    const categoriesBefore = listTemplateCategoriesSpy.mock.calls.length
    const groupsBefore = listApprovalTemplateGroupsSpy.mock.calls.length

    const select = container!.querySelector('select[name="sessionOrgId"]') as HTMLSelectElement
    select.value = 'org-b'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(14)

    // A page-owned switch has TWO things that both want to re-read: the principal-change listener
    // (which fires for it, because the switch remints the token) and `onPageSessionOrgChange`'s own
    // replay (which is the one that knows whether the switch was ACCEPTED). Exactly one of them may
    // act, or every surface on this page issues its request twice per switch. `>= 1` would pass
    // against both; the counts are therefore exact.
    expect(loadTemplatesSpy.mock.calls.length - templatesBefore).toBe(1)
    expect(listApprovalTemplateGroupsSpy.mock.calls.length - groupsBefore).toBe(1)
    // TWO for categories, and the number is written out rather than rounded to ">= 1" because the
    // two are different surfaces, not a double-dispatch: the host's own `loadCategories()` plus the
    // section view's `loadAll()`, which reads the same (global, org-agnostic) endpoint for its
    // section names. Double-dispatching would make this 4.
    expect(listTemplateCategoriesSpy.mock.calls.length - categoriesBefore).toBe(2)
  })

  it('(① M-J) a category answer issued for the PREVIOUS identity does not repopulate the dropdown behind the new one', async () => {
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    // The first identity's category read never answers until we say so.
    let settleStaleCategories: ((v: string[]) => void) | null = null
    listTemplateCategoriesSpy.mockImplementationOnce(
      () => new Promise<string[]>((resolve) => { settleStaleCategories = resolve }),
    )
    listTemplateCategoriesSpy.mockResolvedValue(['NEW-IDENTITY-CATEGORY'])
    useAuth().setToken(jwtFor('actorA', 'org-a'))
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (String(path).endsWith('/api/auth/session-orgs')) {
        return jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
      }
      throw new Error(`unexpected fetch: ${path}`)
    }))

    await mountView()
    await flushUi(4)

    useAuth().setToken(jwtFor('actorB', 'org-c'))
    await flushUi(10)
    const filter = () => container!.querySelector('[data-testid="template-center-category-filter"]') as HTMLSelectElement
    expect(Array.from(filter().options).map((o) => o.textContent?.trim())).toContain('NEW-IDENTITY-CATEGORY')

    settleStaleCategories!(['PREVIOUS-IDENTITY-CATEGORY'])
    await flushUi(8)

    const labels = Array.from(filter().options).map((o) => (o.textContent ?? '').trim())
    expect(labels).not.toContain('PREVIOUS-IDENTITY-CATEGORY')
    expect(labels).toContain('NEW-IDENTITY-CATEGORY')
  })

  it('(① M-K) a recent-templates answer resolved for the PREVIOUS account does not appear under the new one', async () => {
    listTemplateCategoriesSpy.mockResolvedValue([])
    listTemplatesBySectionSpy.mockResolvedValue({ data: [], total: 0 })
    listApprovalTemplateGroupsSpy.mockResolvedValue([])
    localStorage.removeItem('user')
    localStorage.setItem('approval-recent-templates:actorA', JSON.stringify([
      { templateId: 'tpl_stale', name: 'PREVIOUS-ACCOUNT-SHORTCUT', category: null, at: 1 },
    ]))
    localStorage.setItem('approval-recent-templates:actorB', JSON.stringify([
      { templateId: 'tpl_fresh', name: 'NEW-ACCOUNT-SHORTCUT', category: null, at: 2 },
    ]))
    useAuth().setToken(jwtFor('actorA', 'org-a'))

    // `loadRecentTemplates` resolves the USER through `useAuth().getCurrentUserId()`, which goes to
    // `/api/auth/me` when no snapshot is cached. Account A's lookup hangs; account B's answers.
    let meCalls = 0
    let settleStaleMe: ((v: unknown) => void) | null = null
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (String(path).endsWith('/api/auth/me')) {
        meCalls += 1
        // Call 1 is account A's and hangs; every later call is account B's and answers at once.
        if (meCalls === 1) {
          return await new Promise((resolve) => { settleStaleMe = resolve as (v: unknown) => void })
        }
        return jsonResponse(200, { success: true, data: { user: { id: 'actorB' } } })
      }
      if (String(path).endsWith('/api/auth/session-orgs')) {
        return jsonResponse(200, { success: true, data: { orgs: ['org-a', 'org-b'], currentOrgId: 'org-a' } })
      }
      throw new Error(`unexpected fetch: ${path}`)
    }))

    await mountView()
    await flushUi(4)
    expect(container!.textContent).not.toContain('PREVIOUS-ACCOUNT-SHORTCUT')

    useAuth().setToken(jwtFor('actorB', 'org-c'))
    await flushUi(12)
    expect(container!.textContent).toContain('NEW-ACCOUNT-SHORTCUT')

    settleStaleMe!(jsonResponse(200, { success: true, data: { user: { id: 'actorA' } } }))
    await flushUi(12)

    expect(container!.textContent).not.toContain('PREVIOUS-ACCOUNT-SHORTCUT')
    expect(container!.textContent).toContain('NEW-ACCOUNT-SHORTCUT')
  })

})

/**
 * Round 4 — REQUEST ALGEBRA AT THE SHARED SLOT (`approvals/templateStore.loadTemplates`).
 *
 * Round-3 gate C-1: the flat surfaces' "is what I am rendering current?" decision was wired to the
 * app-wide `templateStore.error` / `templateStore.loading` refs, which had no request algebra of
 * any kind — `error` was written by whichever read failed LAST, `templates` by whichever read
 * returned LAST, and `loading` was cleared unconditionally in a `finally` shared by every
 * concurrent read. A page-local generation cannot fix that, because the page does not own those
 * slots; the algebra has to sit where the writes happen. That is what these cases pin, against the
 * REAL store (`vi.importActual` un-mocks it; its own `./api` import still resolves to this file's
 * replacement mock, which is why `listTemplates` is a key there).
 *
 * The gate's own machinery note applies here and is why this describe exists at all: the five
 * component specs replace `templateStore` wholesale with a `vi.fn().mockResolvedValue(...)`, so the
 * store's catch and finally exits were not merely untested — they were UNREACHABLE from any spec.
 *
 * Every case is a two-read interleaving with the older read settling LAST, plus a positive control
 * proving the same fixture with no interleaving does write. Mutating any one of the three exits'
 * guards (or the identity signature) reddens a named case below; see the round-4 verification MD's
 * probe table for the mapping.
 */
describe('approvals/templateStore — list request algebra (three exits + identity signature)', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }

  const row = (id: string) => ({
    id,
    name: id,
    description: null,
    category: null,
    status: 'published' as const,
    visibilityScope: { type: 'all' as const, ids: [] },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  })

  const tokenFor = (userId: string, serial = 1) =>
    `header.${btoa(JSON.stringify({ userId, tenantId: 'org-a', exp: Math.floor(Date.now() / 1000) + 60 + serial }))}.signature`

  async function freshStore() {
    setActivePinia(createPinia())
    const actual = await vi.importActual<typeof import('../src/approvals/templateStore')>(
      '../src/approvals/templateStore',
    )
    return actual.useApprovalTemplateStore()
  }

  beforeEach(() => {
    listTemplatesSpy.mockReset()
    getTemplateSpy.mockReset()
    getTemplateSpy.mockImplementation(async (id: string) => ({ id }))
    getTemplateVersionSpy.mockReset()
    getTemplateVersionSpy.mockImplementation(async (templateId: string, versionId: string) => ({ templateId, versionId }))
    localStorage.clear()
    useAuth().setToken(tokenFor('actorA'))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('(positive control) a read with nothing racing it applies its rows, reports "applied", and clears loading', async () => {
    const store = await freshStore()
    listTemplatesSpy.mockResolvedValue({ data: [row('only')], total: 1 })
    const outcome = await store.loadTemplates({ page: 1 })
    expect(outcome).toBe('applied')
    expect(store.templates.map((t: { id: string }) => t.id)).toEqual(['only'])
    expect(store.total).toBe(1)
    expect(store.error).toBeNull()
    expect(store.loading).toBe(false)
  })

  it('(positive control) a lone FAILING read reports "failed", posts its message and clears loading', async () => {
    const store = await freshStore()
    listTemplatesSpy.mockRejectedValue(new Error('API error: 500 Internal Server Error'))
    const outcome = await store.loadTemplates({ page: 1 })
    expect(outcome).toBe('failed')
    expect(store.error).toBe('API error: 500 Internal Server Error')
    expect(store.loading).toBe(false)
  })

  it('(③ success exit) an older read that succeeds LAST does not overwrite the newer read\'s rows', async () => {
    const store = await freshStore()
    const older = deferred<{ data: unknown[]; total: number }>()
    const newer = deferred<{ data: unknown[]; total: number }>()
    listTemplatesSpy.mockImplementationOnce(() => older.promise)
    listTemplatesSpy.mockImplementationOnce(() => newer.promise)

    const olderCall = store.loadTemplates({ page: 1 })
    const newerCall = store.loadTemplates({ page: 2 })

    newer.resolve({ data: [row('NEWER')], total: 1 })
    expect(await newerCall).toBe('applied')
    older.resolve({ data: [row('OLDER')], total: 99 })
    expect(await olderCall).toBe('superseded')

    expect(store.templates.map((t: { id: string }) => t.id)).toEqual(['NEWER'])
    expect(store.total).toBe(1)
  })

  it('(③ catch exit) an older read that FAILS last does not post its error over the newer read\'s success', async () => {
    const store = await freshStore()
    const older = deferred<{ data: unknown[]; total: number }>()
    const newer = deferred<{ data: unknown[]; total: number }>()
    listTemplatesSpy.mockImplementationOnce(() => older.promise)
    listTemplatesSpy.mockImplementationOnce(() => newer.promise)

    const olderCall = store.loadTemplates({ page: 1 })
    const newerCall = store.loadTemplates({ page: 2 })

    newer.resolve({ data: [row('NEWER')], total: 1 })
    expect(await newerCall).toBe('applied')
    older.reject(new Error('API error: 500 Internal Server Error'))
    expect(await olderCall).toBe('superseded')

    // This is round-3 C-1's (b) and (c) at the source: no banner for a question nobody is asking,
    // and the rows the current read actually fetched are still there.
    expect(store.error).toBeNull()
    expect(store.templates.map((t: { id: string }) => t.id)).toEqual(['NEWER'])
  })

  it('(③ finally exit) an older read settling does not clear the loading flag the newer read is still holding', async () => {
    const store = await freshStore()
    const older = deferred<{ data: unknown[]; total: number }>()
    const newer = deferred<{ data: unknown[]; total: number }>()
    listTemplatesSpy.mockImplementationOnce(() => older.promise)
    listTemplatesSpy.mockImplementationOnce(() => newer.promise)

    const olderCall = store.loadTemplates({ page: 1 })
    const newerCall = store.loadTemplates({ page: 2 })
    expect(store.loading).toBe(true)

    older.resolve({ data: [row('OLDER')], total: 99 })
    expect(await olderCall).toBe('superseded')
    // The newer read has not answered yet: the spinner belongs to it, and only it may take it down.
    expect(store.loading).toBe(true)

    newer.resolve({ data: [row('NEWER')], total: 1 })
    expect(await newerCall).toBe('applied')
    expect(store.loading).toBe(false)
  })

  it('(① identity) a read issued for the PREVIOUS session applies nothing when it succeeds after a sign-out', async () => {
    const store = await freshStore()
    const inflight = deferred<{ data: unknown[]; total: number }>()
    listTemplatesSpy.mockImplementationOnce(() => inflight.promise)

    const call = store.loadTemplates({ page: 1 })
    useAuth().clearToken()
    inflight.resolve({ data: [row('SIGNED-OUT-ACCOUNTS-ROW')], total: 7 })

    expect(await call).toBe('superseded')
    expect(store.templates).toEqual([])
    expect(store.total).toBe(0)
  })

  it('(① identity) a read issued for the PREVIOUS session posts no error when it fails after a sign-out', async () => {
    const store = await freshStore()
    const inflight = deferred<{ data: unknown[]; total: number }>()
    listTemplatesSpy.mockImplementationOnce(() => inflight.promise)

    const call = store.loadTemplates({ page: 1 })
    useAuth().clearToken()
    inflight.reject(new Error('API error: 401 Unauthorized'))

    // Boundary ①: a signed-out page that shows "could not load templates" is answering a question
    // nobody asked — the identity that asked no longer holds this session.
    expect(await call).toBe('superseded')
    expect(store.error).toBeNull()
  })

  it('(① identity) ...but that read still RELEASES loading, because no successor exists to release it', async () => {
    const store = await freshStore()
    const inflight = deferred<{ data: unknown[]; total: number }>()
    listTemplatesSpy.mockImplementationOnce(() => inflight.promise)

    const call = store.loadTemplates({ page: 1 })
    expect(store.loading).toBe(true)
    useAuth().clearToken()
    inflight.reject(new Error('API error: 401 Unauthorized'))
    await call

    // `loading` is a one-bit slot owned by the NEWEST read. Gating its release on the identity as
    // well as on the generation would strand the spinner forever here: nothing else is coming.
    expect(store.loading).toBe(false)
  })

  it('(① identity) a read issued before a token re-issue for the SAME subject is still superseded', async () => {
    const store = await freshStore()
    const inflight = deferred<{ data: unknown[]; total: number }>()
    listTemplatesSpy.mockImplementationOnce(() => inflight.promise)

    const call = store.loadTemplates({ page: 1 })
    // Same `sub`, different token text — `getAuthPrincipalKey()` is deliberately STABLE across
    // this, so only the signature's token half can see it. That is the half this pins.
    useAuth().setToken(tokenFor('actorA', 2))
    inflight.resolve({ data: [row('PRE-REISSUE-ROW')], total: 3 })

    expect(await call).toBe('superseded')
    expect(store.templates).toEqual([])
  })

  // ── ROUND 5 (gate round-4 C-7 / P3-3): the shared slots have THREE writers ───────────────────
  //
  // `loading` and `error` are one slot each for the whole app, and `loadTemplate` / `loadVersion`
  // wrote them with no algebra at all. Round 4's comment nevertheless called `loading` "a one-bit
  // slot owned by the newest read", which a per-kind counter cannot make true. One case per writer
  // below, plus the positive control that separates "fixed" from "never broken".

  it('(C-7 positive control) a lone DETAIL read owns the shared loading slot and releases it', async () => {
    const store = await freshStore()
    const inflight = deferred<{ id: string }>()
    getTemplateSpy.mockImplementationOnce(() => inflight.promise)

    const call = store.loadTemplate('tpl_1')
    expect(store.loading).toBe(true)
    inflight.resolve({ id: 'tpl_1' })
    await call
    expect(store.loading).toBe(false)
    expect(store.activeTemplate).toEqual({ id: 'tpl_1' })
  })

  it('(C-7, loadTemplates writer) a LIST read settling while a detail read is in flight does not take down the detail read\'s spinner', async () => {
    const store = await freshStore()
    const list = deferred<{ data: unknown[]; total: number }>()
    const detail = deferred<{ id: string }>()
    listTemplatesSpy.mockImplementationOnce(() => list.promise)
    getTemplateSpy.mockImplementationOnce(() => detail.promise)

    // The production shape: the template centre's list read is still in flight when the admin
    // navigates to a detail route, which starts its own read into the same one-bit slot.
    const listCall = store.loadTemplates({ page: 1 })
    const detailCall = store.loadTemplate('tpl_1')
    expect(store.loading).toBe(true)

    list.resolve({ data: [row('LIST')], total: 1 })
    await listCall
    // The detail page is still waiting for ITS answer. A generation counter that only counts list
    // reads says "I am the latest" here and clears the slot out from under it.
    expect(store.loading).toBe(true)

    detail.resolve({ id: 'tpl_1' })
    await detailCall
    expect(store.loading).toBe(false)
  })

  it('(C-7, loadTemplate writer) a detail read settling while a VERSION read is in flight leaves the shared loading slot alone, and a detail answer for the PREVIOUS session applies nothing', async () => {
    const store = await freshStore()
    const detail = deferred<{ id: string }>()
    const version = deferred<{ templateId: string; versionId: string }>()
    getTemplateSpy.mockImplementationOnce(() => detail.promise)
    getTemplateVersionSpy.mockImplementationOnce(() => version.promise)

    // `ApprovalDetailView.vue:2957,2964` issues exactly this pair, concurrently.
    const detailCall = store.loadTemplate('tpl_1')
    const versionCall = store.loadVersion('tpl_1', 'ver_1')
    detail.resolve({ id: 'tpl_1' })
    await detailCall
    expect(store.loading).toBe(true)
    // Both CONTENT slots are still filled: the two reads fill different slots, so arbitrating them
    // against each other would throw one of the two answers away.
    expect(store.activeTemplate).toEqual({ id: 'tpl_1' })
    version.resolve({ templateId: 'tpl_1', versionId: 'ver_1' })
    await versionCall
    expect(store.activeVersion).toEqual({ templateId: 'tpl_1', versionId: 'ver_1' })
    expect(store.loading).toBe(false)

    // Identity half: a detail read issued for the session that has since been signed out of is an
    // answer about a context this app has left.
    const stale = deferred<{ id: string }>()
    getTemplateSpy.mockImplementationOnce(() => stale.promise)
    const staleCall = store.loadTemplate('tpl_previous')
    useAuth().clearToken()
    stale.resolve({ id: 'tpl_previous' })
    await staleCall
    expect(store.activeTemplate).toEqual({ id: 'tpl_1' })
  })

  it('(C-7, loadVersion writer) a version read settling while a detail read is in flight leaves the shared loading slot alone, and a version answer for the PREVIOUS session applies nothing', async () => {
    const store = await freshStore()
    const version = deferred<{ templateId: string; versionId: string }>()
    const detail = deferred<{ id: string }>()
    getTemplateVersionSpy.mockImplementationOnce(() => version.promise)
    getTemplateSpy.mockImplementationOnce(() => detail.promise)

    const versionCall = store.loadVersion('tpl_1', 'ver_1')
    const detailCall = store.loadTemplate('tpl_1')
    version.resolve({ templateId: 'tpl_1', versionId: 'ver_1' })
    await versionCall
    expect(store.loading).toBe(true)
    detail.resolve({ id: 'tpl_1' })
    await detailCall
    expect(store.loading).toBe(false)

    const stale = deferred<{ templateId: string; versionId: string }>()
    getTemplateVersionSpy.mockImplementationOnce(() => stale.promise)
    const staleCall = store.loadVersion('tpl_previous', 'ver_previous')
    useAuth().clearToken()
    stale.resolve({ templateId: 'tpl_previous', versionId: 'ver_previous' })
    await staleCall
    expect(store.activeVersion).toEqual({ templateId: 'tpl_1', versionId: 'ver_1' })
  })
})

/**
 * Round 4 — `onAuthSessionSwitch`'s deferred-unsubscribe window.
 *
 * The round-3 gate's M-D: deleting the `disposed` flag left all 99 tests green, and
 * `grep -rln onAuthSessionSwitch apps/web/tests/` returned ZERO files — a guard that a repair
 * commit added specifically because its author had found a real window, with nothing anywhere in
 * the repository able to tell whether it still worked.
 *
 * The window: the signature comparison is deliberately deferred by one microtask (the reset funnel
 * notifies BEFORE `localStorage` is written, so reading at notification time would report "nothing
 * changed" for every sign-in and sign-out). Unsubscribing from the base signal cannot cancel a
 * microtask that is already queued, so without the flag a torn-down subscriber still runs — and in
 * this page's case, issues a re-fetch for a component that no longer exists.
 */
describe('composables/authPrincipal — onAuthSessionSwitch closes its deferred window on unsubscribe', () => {
  const tokenFor = (userId: string) =>
    `header.${btoa(JSON.stringify({ userId, tenantId: 'org-a', exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`

  beforeEach(() => { localStorage.clear() })
  afterEach(() => { localStorage.clear() })

  it('(positive control) a real session change notified while subscribed DOES reach the listener', async () => {
    const { onAuthSessionSwitch, notifyAuthPrincipalChange } = await import('../src/composables/authPrincipal')
    const calls: number[] = []
    const stop = onAuthSessionSwitch(() => { calls.push(1) })
    try {
      localStorage.setItem('auth_token', tokenFor('actorA'))
      notifyAuthPrincipalChange()
      await Promise.resolve()
      await Promise.resolve()
      expect(calls.length).toBe(1)
    } finally {
      stop()
    }
  })

  it('a subscriber torn down between the notification and the deferred read is NOT called', async () => {
    const { onAuthSessionSwitch, notifyAuthPrincipalChange } = await import('../src/composables/authPrincipal')
    const calls: number[] = []
    const stop = onAuthSessionSwitch(() => { calls.push(1) })

    localStorage.setItem('auth_token', tokenFor('actorA'))
    // The transition is announced...
    notifyAuthPrincipalChange()
    // ...and the component unmounts before the queued microtask runs. This is the whole window:
    // synchronous with respect to the notification, earlier than the deferred signature read.
    stop()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(calls.length).toBe(0)
  })

  it('a subscriber torn down by ANOTHER listener during the same notification is not called either', async () => {
    const { onAuthSessionSwitch, onAuthPrincipalChange, notifyAuthPrincipalChange } =
      await import('../src/composables/authPrincipal')
    const calls: number[] = []
    // Subscription order matters: the switch subscriber is registered FIRST so that the disposing
    // listener below runs while the funnel is already iterating its copy of the listener set.
    const stopSwitch = onAuthSessionSwitch(() => { calls.push(1) })
    const stopDisposer = onAuthPrincipalChange(() => { stopSwitch() })
    try {
      localStorage.setItem('auth_token', tokenFor('actorA'))
      notifyAuthPrincipalChange()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(calls.length).toBe(0)
    } finally {
      stopDisposer()
      stopSwitch()
    }
  })
})
