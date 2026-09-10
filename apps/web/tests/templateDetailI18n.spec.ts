/**
 * Report item O-8 continuation (PR #5545) — TemplateDetailView.vue i18n retrofit.
 *
 * Root cause (browser repro on this branch's head, before this slice): under the English locale,
 * clicking from the (already-localized, per the earlier O-8 slice) TemplateCenterView.vue admin
 * table into a template's DETAIL view rendered an entirely Chinese page — status tag "已发布",
 * headings "审批模板"/"表单字段"/"字段显隐规则" — because TemplateDetailView.vue never called
 * `useLocale()` at all, same defect class as TemplateCenterView.vue before ITS retrofit. Owner
 * decision: convert the detail view (option A), not revert the list. This mirrors
 * templateCenterI18n.spec.ts's own mount/guard pattern (same `ZH`/`EN` + `t = computed(...)`
 * convention, same `renderedTextAndAttributes()` sweep, same CJK regex), applied to the sibling
 * `templateDetailLabels.ts` table this slice adds.
 *
 * Two structural differences from that spec, both load-bearing:
 *
 *   1. Several dynamic sentences (a parenthetical count next to a threshold/timeout tag, an
 *      "N form fields changed — switch back to the list" note, a restore-confirm dialog embedding
 *      a version number, a resolved-id COUNT tied to a Chinese substring pinned verbatim by
 *      apps/web/tests/approval-member-identity-coverage-enumeration.spec.ts) are expressed as
 *      `isZh.value ? \`zh...\` : \`en...\`` INLINE ternaries in TemplateDetailView.vue's own
 *      script, not as templateDetailLabels.ts table entries — a table key for bare punctuation/
 *      brackets would itself be ASCII-only in zh-CN and identical to its own English counterpart,
 *      tripping the completeness test's own guards below. The CJK guard test extracts and vets
 *      each such construct individually (mirroring how templateCenterI18n.spec.ts's own guard
 *      allowlists ApprovalCenterView.vue's `tabEmptyText` by-design ZH branch, generalized from
 *      "one named construct" to "every occurrence of this shape").
 *
 *   2. A POST-MOUNT locale-flip test is included from the start (round-2 of the O-8 slice had to
 *      add this to TemplateCenterView.vue's spec after the fact) — it is the only test here that
 *      would catch a `const t = isZh.value ? ZH : EN` (evaluated once at setup) instead of the
 *      required `computed(...)`.
 *
 * RED-before: reverting TemplateDetailView.vue to hardcoded-Chinese strings (git stash this file's
 * source changes) makes the "en" tests below fail; the "zh" tests pass by coincidence.
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
import { ZH, EN, MAP_PAIRS } from '../src/views/approval/templateDetailLabels'

const pushSpy = vi.fn().mockResolvedValue(undefined)

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: pushSpy, back: vi.fn() }),
    useRoute: () => ({ params: { id: 'tpl-1' }, query: {}, path: '/approval-templates/tpl-1', meta: {} }),
  }
})

// ---------------------------------------------------------------------------
// Store / permissions / api mocks — same shape as approvalTemplateVersionHistory.spec.ts and
// templateCenterI18n.spec.ts (this view's established spec convention), fully replacing
// '../src/approvals/api' (not spreading `actual`) so category/SLA/visibility/archive/unarchive
// success paths are all exercisable without a real HTTP layer.
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

const updateTemplateCategorySpy = vi.fn()
const updateTemplateSlaHoursSpy = vi.fn()
const updateTemplateVisibilityScopeSpy = vi.fn()
const getTemplateUsageSpy = vi.fn().mockResolvedValue(undefined)
const archiveTemplateSpy = vi.fn()
const unarchiveTemplateSpy = vi.fn()
const listTemplateVersionsSpy = vi.fn().mockResolvedValue([])
const getTemplateVersionSpy = vi.fn()
const restoreTemplateVersionSpy = vi.fn()

vi.mock('../src/approvals/api', () => ({
  updateTemplateCategory: (id: string, category: string | null) => updateTemplateCategorySpy(id, category),
  updateTemplateSlaHours: (id: string, hours: number | null) => updateTemplateSlaHoursSpy(id, hours),
  updateTemplateVisibilityScope: (id: string, scope: unknown) => updateTemplateVisibilityScopeSpy(id, scope),
  getTemplateUsage: (id: string) => getTemplateUsageSpy(id),
  archiveTemplate: (id: string) => archiveTemplateSpy(id),
  unarchiveTemplate: (id: string) => unarchiveTemplateSpy(id),
  listTemplateVersions: (id: string) => listTemplateVersionsSpy(id),
  getTemplateVersion: (id: string, versionId: string) => getTemplateVersionSpy(id, versionId),
  restoreTemplateVersion: (id: string, versionId: string, req: unknown) => restoreTemplateVersionSpy(id, versionId, req),
}))

const elSuccessSpy = vi.fn()
const elErrorSpy = vi.fn()
const confirmSpy = vi.fn().mockResolvedValue(undefined)

vi.mock('element-plus', () => ({
  ElMessage: { success: elSuccessSpy, error: elErrorSpy },
  ElMessageBox: { confirm: (...a: unknown[]) => confirmSpy(...a) },
}))

// ---------------------------------------------------------------------------
// Element Plus stubs. Table/tag/alert/empty/segmented/timeline lifted verbatim from
// approvalTemplateVersionHistory.spec.ts (this view's existing spec); input/select/option made
// genuinely interactive (native element + v-model wiring) like templateCenterI18n.spec.ts's own,
// since the category/SLA/visibility save-toast tests below need to actually change a draft value
// before saving.
// ---------------------------------------------------------------------------
type ColumnRegistryEntry = { key: string; prop?: string; label?: string; defaultSlot?: Slot }
type ColumnRegistry = { columns: ColumnRegistryEntry[]; register: (entry: ColumnRegistryEntry) => void }
const COLUMN_REGISTRY_KEY = Symbol('el-table-columns')

const ElTable = defineComponent({
  name: 'ElTable',
  props: { data: Array, loading: Boolean, maxHeight: [String, Number], stripe: Boolean },
  setup(props, { slots, attrs }) {
    const registry = reactive<ColumnRegistry>({ columns: [], register(entry) { registry.columns.push(entry) } })
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
    return h('span', { 'data-el-tag': this.type || 'default', ...this.$attrs }, this.$slots.default?.())
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

const ElSegmented = defineComponent({
  name: 'ElSegmented',
  props: { modelValue: String, options: Array },
  emits: ['update:modelValue'],
  render() {
    return h(
      'div',
      { 'data-el-segmented': 'true', ...this.$attrs },
      (this.options as Array<{ label: string; value: string }> | undefined)?.map((option) =>
        h(
          'button',
          {
            type: 'button',
            'data-selected': this.modelValue === option.value ? 'true' : 'false',
            onClick: () => this.$emit('update:modelValue', option.value),
          },
          option.label,
        ),
      ),
    )
  },
})

function passthrough(name: string, tag = 'div') {
  return defineComponent({
    name,
    inheritAttrs: false,
    render() {
      return h(tag, { 'data-stub': name, ...this.$attrs }, this.$slots.default?.())
    },
  })
}

const ElInput = defineComponent({
  name: 'ElInput',
  props: { modelValue: String, placeholder: String, size: String, maxlength: [String, Number] },
  emits: ['update:modelValue'],
  inheritAttrs: false,
  render() {
    return h('input', {
      'data-el-input': 'true',
      ...this.$attrs,
      value: this.modelValue,
      placeholder: this.placeholder,
      onInput: (e: Event) => this.$emit('update:modelValue', (e.target as HTMLInputElement).value),
    })
  },
})

const ElInputNumber = defineComponent({
  name: 'ElInputNumber',
  props: { modelValue: { type: [Number, null] as any, default: null }, min: Number, max: Number, placeholder: String, size: String, controls: Boolean },
  emits: ['update:modelValue'],
  inheritAttrs: false,
  render() {
    return h('input', {
      type: 'number',
      'data-el-input-number': 'true',
      ...this.$attrs,
      value: this.modelValue ?? '',
      placeholder: this.placeholder,
      onInput: (e: Event) => {
        const raw = (e.target as HTMLInputElement).value
        this.$emit('update:modelValue', raw === '' ? null : Number(raw))
      },
    })
  },
})

const ElSelect = defineComponent({
  name: 'ElSelect',
  props: { modelValue: String },
  emits: ['update:modelValue'],
  inheritAttrs: false,
  render() {
    return h(
      'select',
      {
        'data-el-select': 'true',
        ...this.$attrs,
        value: this.modelValue ?? '',
        onChange: (e: Event) => this.$emit('update:modelValue', (e.target as HTMLSelectElement).value),
      },
      this.$slots.default?.(),
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

function installStubs(app: VueApp<Element>) {
  app.directive('loading', {})
  app.component('ElTable', ElTable)
  app.component('ElTableColumn', ElTableColumn)
  app.component('ElTag', ElTag)
  app.component('ElAlert', ElAlert)
  app.component('ElEmpty', ElEmpty)
  app.component('ElSegmented', ElSegmented)
  app.component('ElButton', passthrough('ElButton', 'button'))
  app.component('ElInput', ElInput)
  app.component('ElInputNumber', ElInputNumber)
  app.component('ElSelect', ElSelect)
  app.component('ElOption', ElOption)
  app.component('ElTimeline', passthrough('ElTimeline'))
  app.component('ElTimelineItem', passthrough('ElTimelineItem'))
  app.component('ElIcon', passthrough('ElIcon', 'span'))
  app.component('ElTooltip', passthrough('ElTooltip'))
}

// ---------------------------------------------------------------------------
// Fixtures + mount
// ---------------------------------------------------------------------------
function buildTemplate(overrides: Record<string, unknown>) {
  return {
    id: 'tpl-1',
    key: 'TPL-001',
    name: 'Business trip request',
    description: null,
    category: null,
    visibilityScope: { type: 'all', ids: [] },
    slaHours: null,
    status: 'published',
    activeVersionId: 'ver-1',
    latestVersionId: 'ver-2',
    createdAt: '2026-01-02T03:04:05Z',
    updatedAt: '2026-04-10T10:00:00Z',
    formSchema: { fields: [] },
    approvalGraph: { nodes: [], edges: [] },
    ...overrides,
  }
}

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
  await flushUi()
  return container
}

function setLocale(locale: 'en' | 'zh-CN') {
  window.localStorage.setItem('metasheet_locale', locale)
  useLocale().setLocale(locale)
}

// Several interactions here chain more than one await point (e.g. handleArchive: await
// getTemplateUsage -> await ElMessageBox.confirm -> await archiveTemplate -> ElMessage.success) —
// a single `await Promise.resolve(); await nextTick()` only advances one microtask hop and left
// later assertions reading stale state during development of this spec. Loops several cycles,
// matching templateCenterI18n.spec.ts's own `flushUi()` convention.
async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

// Same sweep as templateCenterI18n.spec.ts: whole rendered page, plus every
// aria-label/placeholder/title attribute a plain textContent check would miss.
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

// Same widened CJK class as templateCenterI18n.spec.ts (CJK Unified Ideographs + CJK Symbols/
// Punctuation + Halfwidth-and-Fullwidth Forms) — see that file's round-2/round-3 history for why
// the narrower `[一-鿿]` alone is insufficient.
const CJK = /[　-〿一-鿿＀-￯]/

describe('TemplateDetailView — i18n retrofit (report item O-8 continuation, PR #5545)', () => {
  beforeEach(() => {
    mockActiveTemplate.value = null
    mockLoading.value = false
    mockErrorRef.value = null
    mockCanWrite.value = true
    mockCanManageTemplates.value = true

    loadTemplateSpy.mockClear()
    updateTemplateCategorySpy.mockReset()
    updateTemplateSlaHoursSpy.mockReset()
    updateTemplateVisibilityScopeSpy.mockReset()
    getTemplateUsageSpy.mockReset().mockResolvedValue(undefined)
    archiveTemplateSpy.mockReset()
    unarchiveTemplateSpy.mockReset()
    listTemplateVersionsSpy.mockReset().mockResolvedValue([])
    getTemplateVersionSpy.mockReset()
    restoreTemplateVersionSpy.mockReset()
    confirmSpy.mockClear().mockResolvedValue(undefined)
    elSuccessSpy.mockClear()
    elErrorSpy.mockClear()
    pushSpy.mockClear()
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
  })

  // -------------------------------------------------------------------------
  // Full-page chrome sweep, both locales. Deliberately keeps the field-visibility-rule summary
  // EMPTY (describeFieldVisibilityRule is a separate, unconverted shared module — see the
  // couldNotDo note this slice ships with) and does not open the version-diff panel (its change
  // labels/summary lines come from other unconverted shared modules too) — both would inject
  // real Chinese text into an "en" mount regardless of this view's own conversion, poisoning the
  // sweep with a defect this slice does not own. Every string the sweep DOES cover is this view's
  // own chrome.
  // -------------------------------------------------------------------------
  it('renders every chrome string in English when the locale is "en"', async () => {
    setLocale('en')
    mockActiveTemplate.value = buildTemplate({
      category: 'Travel',
      slaHours: 48,
      visibilityScope: { type: 'role', ids: ['manager', 'finance'] },
      formSchema: {
        fields: [
          { id: 'reason', type: 'text', label: 'Reason', required: true },
          { id: 'amount', type: 'number', label: 'Amount', required: false, placeholder: 'Enter amount' },
        ],
      },
      approvalGraph: {
        nodes: [
          {
            key: 'n1',
            type: 'approval',
            name: 'Finance approval',
            config: {
              assigneeType: 'role',
              assigneeIds: ['finance'],
              approvalMode: 'threshold',
              approvalThreshold: 3,
              emptyAssigneePolicy: 'auto-approve',
              timeout: { effect: 'remind', afterMinutes: 30 },
            },
          },
        ],
        edges: [],
      },
    })
    listTemplateVersionsSpy.mockResolvedValue([
      { id: 'v2', templateId: 'tpl-1', version: 2, status: 'draft', publishNote: null, publishedDefinitionId: null, restoredFromVersionId: null, createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' },
      { id: 'v1', templateId: 'tpl-1', version: 1, status: 'published', publishNote: 'Initial rollout', publishedDefinitionId: 'pub-1', restoredFromVersionId: 'gone', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ])
    const root = await mountView()

    expect(root.querySelector('.ms-page-header__title')?.textContent).toBe('Business trip request')
    expect(root.querySelector('.ms-page-header__back')?.textContent).toContain('Back to template list')
    expect(root.querySelector('[data-domain="approvalTemplate"]')?.textContent).toBe('Published')
    expect(root.querySelector('[data-testid="template-detail-edit-button"]')?.textContent).toBe('Edit template')
    expect(root.querySelector('[data-testid="template-detail-archive-button"]')?.textContent).toBe('Disable')

    expect(root.querySelector('.template-detail__category-label')?.textContent).toBe('Category:')
    expect(root.querySelector('[data-testid="template-detail-category-tag"]')?.textContent).toBe('Travel')
    expect(root.querySelector('.template-detail__visibility')?.textContent).toContain('By role')
    expect(root.querySelector('[data-testid="template-detail-visibility-ids"]')?.textContent).toBe('Designated role (2)')
    expect(root.querySelector('[data-testid="template-detail-sla-tag"]')?.textContent).toBe('48')

    expect(root.querySelector('.template-detail__meta')?.textContent).toBe(
      'Template key: TPL-001Current version: ver-1Created: ' + new Date('2026-01-02T03:04:05Z').toLocaleString('en-US')
      + 'Updated: ' + new Date('2026-04-10T10:00:00Z').toLocaleString('en-US'),
    )

    const headings = Array.from(root.querySelectorAll('.template-detail__section h2')).map((h2) => h2.textContent)
    expect(headings).toEqual(['Form fields', 'Field visibility rules', 'Approval flow', 'Version history'])
    expect(root.querySelector('[data-el-empty]')?.textContent).toBe('No field visibility rules yet')

    const fieldRow0 = root.querySelector('[data-el-row="0"]')
    expect(fieldRow0?.querySelector('[data-el-cell="type"]')?.textContent).toBe('Text')
    expect(fieldRow0?.querySelector('[data-el-cell="required"]')?.textContent).toBe('Required')

    expect(root.querySelector('.template-detail__node-assignee')?.textContent).toContain('Role:')
    expect(root.querySelector('.template-detail__node-assignee')?.textContent).toContain('Designated role (1)')
    expect(root.querySelector('.template-detail__node-mode')?.textContent).toBe('Threshold approval (3 approvals required)')
    expect(root.querySelector('.template-detail__node-policy')?.textContent).toBe('Auto-approve when empty')
    expect(root.querySelector('.template-detail__node-timeout')?.textContent).toBe('Timeout reminder (30 min)')

    const versionRows = root.querySelectorAll('[data-el-row]')
    const versionRow1 = Array.from(versionRows).find((r) => r.textContent?.includes('Restored from'))
    expect(versionRow1?.textContent).toContain('Restored from a prior version')
    expect(versionRow1?.textContent).toContain('Active')
    expect(root.querySelector('[data-testid^="template-version-compare-"]')?.textContent).toBe('View changes')

    expect(renderedTextAndAttributes(root)).not.toMatch(CJK)
  })

  it('renders every chrome string in Chinese when the locale is "zh-CN"', async () => {
    setLocale('zh-CN')
    mockActiveTemplate.value = buildTemplate({
      name: '出差申请',
      category: '差旅',
      slaHours: 48,
      visibilityScope: { type: 'dept', ids: ['sales'] },
      formSchema: {
        fields: [{ id: 'reason', type: 'text', label: '事由', required: true }],
      },
      approvalGraph: {
        nodes: [
          {
            key: 'n1',
            type: 'approval',
            name: '财务审批',
            config: { assigneeType: 'user', assigneeIds: [], approvalMode: 'all' },
          },
        ],
        edges: [],
      },
    })
    const root = await mountView()

    expect(root.querySelector('.ms-page-header__title')?.textContent).toBe('出差申请')
    expect(root.querySelector('.ms-page-header__back')?.textContent).toContain('返回模板列表')
    expect(root.querySelector('[data-domain="approvalTemplate"]')?.textContent).toBe('已发布')
    expect(root.querySelector('[data-testid="template-detail-archive-button"]')?.textContent).toBe('停用')
    expect(root.querySelector('.template-detail__category-label')?.textContent).toBe('模板分类:')
    expect(root.querySelector('.template-detail__visibility')?.textContent).toContain('按部门')
    expect(root.querySelector('[data-testid="template-detail-visibility-ids"]')?.textContent).toBe('部门 1')
    expect(root.querySelector('.template-detail__node-assignee')?.textContent).toContain('用户:')
    expect(root.querySelector('.template-detail__node-mode')?.textContent).toBe('会签')

    const headings = Array.from(root.querySelectorAll('.template-detail__section h2')).map((h2) => h2.textContent)
    expect(headings).toEqual(['表单字段', '字段显隐规则', '审批流程', '版本历史'])
    expect(root.querySelector('[data-el-empty]')?.textContent).toBe('暂无字段显隐规则')
  })

  // Round-2-precedent fix, applied from the start here (per this file's header note 2):
  // StatusTag reads `useLocale()` itself, so this must be asserted independent of this view's own
  // `t` — otherwise a stray `force-locale="zh"` regression would pass unnoticed by the chrome
  // sweeps above (which also happen to assert the badge, but not as their sole focus).
  it("status badge follows the shell locale in both directions (force-locale removed)", async () => {
    setLocale('en')
    mockActiveTemplate.value = buildTemplate({ status: 'archived' })
    const rootEn = await mountView()
    expect(rootEn.querySelector('[data-domain="approvalTemplate"]')?.textContent).toBe('Archived')

    app?.unmount()
    setLocale('zh-CN')
    const rootZh = await mountView()
    expect(rootZh.querySelector('[data-domain="approvalTemplate"]')?.textContent).toBe('已归档')
  })

  // The property the earlier (list-view) O-8 spec could not prove without a round-2 fix: mount in
  // one locale, flip the SAME shell singleton `App.vue`'s switcher calls, and assert the
  // ALREADY-MOUNTED DOM re-renders — not just that a fresh mount picks up the new locale. Also
  // covers StatusTag (a SEPARATE useLocale() consumer) in the same flip, so a regression in either
  // this view's own `t` or a reintroduced `force-locale` shows up here.
  it('re-renders chrome AND the status badge when the shell locale flips after mount', async () => {
    setLocale('zh-CN')
    mockActiveTemplate.value = buildTemplate({})
    const root = await mountView()
    expect(root.querySelector('.ms-page-header__back')?.textContent).toContain('返回模板列表')
    expect(root.querySelector('[data-domain="approvalTemplate"]')?.textContent).toBe('已发布')
    expect(root.querySelector('.template-detail__section h2')?.textContent).toBe('表单字段')

    setLocale('en')
    await nextTick()
    expect(root.querySelector('.ms-page-header__back')?.textContent).toContain('Back to template list')
    expect(root.querySelector('[data-domain="approvalTemplate"]')?.textContent).toBe('Published')
    expect(root.querySelector('.template-detail__section h2')?.textContent).toBe('Form fields')

    setLocale('zh-CN')
    await nextTick()
    expect(root.querySelector('.ms-page-header__back')?.textContent).toContain('返回模板列表')
    expect(root.querySelector('[data-domain="approvalTemplate"]')?.textContent).toBe('已发布')
    expect(root.querySelector('.template-detail__section h2')?.textContent).toBe('表单字段')
  })

  it('category edit: save toast and validation-free empty-clear toast follow the locale', async () => {
    setLocale('en')
    mockActiveTemplate.value = buildTemplate({ category: 'Travel' })
    updateTemplateCategorySpy.mockResolvedValueOnce(buildTemplate({ category: 'Expenses' }))
    const root = await mountView()

    root.querySelector<HTMLButtonElement>('[data-testid="template-detail-category-edit-button"]')!.click()
    await nextTick()
    const input = root.querySelector<HTMLInputElement>('[data-testid="template-detail-category-input"]')!
    input.value = 'Expenses'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    root.querySelector<HTMLButtonElement>('[data-testid="template-detail-category-save-button"]')!.click()
    await flushUi()

    expect(elSuccessSpy).toHaveBeenCalledWith('Category updated to Expenses')

    app?.unmount()
    setLocale('zh-CN')
    mockActiveTemplate.value = buildTemplate({ category: '差旅' })
    updateTemplateCategorySpy.mockResolvedValueOnce(buildTemplate({ category: '报销' }))
    const root2 = await mountView()
    root2.querySelector<HTMLButtonElement>('[data-testid="template-detail-category-edit-button"]')!.click()
    await nextTick()
    const input2 = root2.querySelector<HTMLInputElement>('[data-testid="template-detail-category-input"]')!
    input2.value = '报销'
    input2.dispatchEvent(new Event('input'))
    await nextTick()
    root2.querySelector<HTMLButtonElement>('[data-testid="template-detail-category-save-button"]')!.click()
    await flushUi()
    expect(elSuccessSpy).toHaveBeenCalledWith('已更新分类为 报销')
  })

  it('SLA edit: invalid-value error and update-success toast follow the locale', async () => {
    setLocale('en')
    mockActiveTemplate.value = buildTemplate({ slaHours: null })
    updateTemplateSlaHoursSpy.mockResolvedValueOnce(buildTemplate({ slaHours: 24 }))
    const root = await mountView()

    root.querySelector<HTMLButtonElement>('[data-testid="template-detail-sla-edit-button"]')!.click()
    await nextTick()
    const slaInput = root.querySelector<HTMLInputElement>('[data-testid="template-detail-sla-input"]')!
    slaInput.value = '-1'
    slaInput.dispatchEvent(new Event('input'))
    await nextTick()
    root.querySelector<HTMLButtonElement>('[data-testid="template-detail-sla-save-button"]')!.click()
    await nextTick()
    expect(elErrorSpy).toHaveBeenCalledWith('SLA must be a positive whole number of hours')

    slaInput.value = '24'
    slaInput.dispatchEvent(new Event('input'))
    await nextTick()
    root.querySelector<HTMLButtonElement>('[data-testid="template-detail-sla-save-button"]')!.click()
    await flushUi()
    expect(elSuccessSpy).toHaveBeenCalledWith('SLA updated to 24 hours')
  })

  it('visibility edit: missing-id validation error follows the locale', async () => {
    setLocale('zh-CN')
    mockActiveTemplate.value = buildTemplate({ visibilityScope: { type: 'all', ids: [] } })
    const root = await mountView()
    root.querySelector<HTMLButtonElement>('[data-testid="template-detail-visibility-edit-button"]')!.click()
    await nextTick()
    const select = root.querySelector<HTMLSelectElement>('[data-testid="template-detail-visibility-type"]')!
    select.value = 'dept'
    select.dispatchEvent(new Event('change'))
    await nextTick()
    root.querySelector<HTMLButtonElement>('[data-testid="template-detail-visibility-save-button"]')!.click()
    await nextTick()
    expect(elErrorSpy).toHaveBeenCalledWith('可见范围至少需要一个 id')
  })

  it('archive dialog title/buttons and success toast are English under "en", Chinese under "zh-CN"', async () => {
    setLocale('en')
    mockActiveTemplate.value = buildTemplate({ status: 'published' })
    archiveTemplateSpy.mockResolvedValueOnce(buildTemplate({ status: 'archived' }))
    const root = await mountView()
    root.querySelector<HTMLButtonElement>('[data-testid="template-detail-archive-button"]')!.click()
    await flushUi()
    expect(String(confirmSpy.mock.calls[0][1])).toBe('Disable template')
    expect((confirmSpy.mock.calls[0][2] as any).confirmButtonText).toBe('Disable')
    expect((confirmSpy.mock.calls[0][2] as any).cancelButtonText).toBe('Cancel')
    await flushUi()
    expect(elSuccessSpy).toHaveBeenCalledWith('Template disabled')

    app?.unmount()
    setLocale('zh-CN')
    confirmSpy.mockClear()
    elSuccessSpy.mockClear()
    mockActiveTemplate.value = buildTemplate({ status: 'published' })
    archiveTemplateSpy.mockResolvedValueOnce(buildTemplate({ status: 'archived' }))
    const root2 = await mountView()
    root2.querySelector<HTMLButtonElement>('[data-testid="template-detail-archive-button"]')!.click()
    await flushUi()
    expect(String(confirmSpy.mock.calls[0][1])).toBe('停用模板')
    await flushUi()
    expect(elSuccessSpy).toHaveBeenCalledWith('已停用模板')
  })

  it('unarchive dialog title/buttons and success toast follow the locale', async () => {
    setLocale('en')
    mockActiveTemplate.value = buildTemplate({ status: 'archived' })
    unarchiveTemplateSpy.mockResolvedValueOnce(buildTemplate({ status: 'published' }))
    const root = await mountView()
    root.querySelector<HTMLButtonElement>('[data-testid="template-detail-unarchive-button"]')!.click()
    await flushUi()
    expect(String(confirmSpy.mock.calls[0][1])).toBe('Enable template')
    expect((confirmSpy.mock.calls[0][2] as any).confirmButtonText).toBe('Enable')
    await flushUi()
    expect(elSuccessSpy).toHaveBeenCalledWith('Template enabled')
  })

  // Admin-only restore flow: dialog message/title embed the version number, matching
  // restoreConfirmMessage/restoreConfirmTitle's isZh-branched functions.
  it('restore-version confirm dialog and success toast follow the locale', async () => {
    setLocale('en')
    mockActiveTemplate.value = buildTemplate({})
    listTemplateVersionsSpy.mockResolvedValue([
      { id: 'v1', templateId: 'tpl-1', version: 1, status: 'published', publishNote: null, publishedDefinitionId: 'pub-1', restoredFromVersionId: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ])
    restoreTemplateVersionSpy.mockResolvedValueOnce({ id: 'v3', templateId: 'tpl-1', version: 3, status: 'draft' })
    const root = await mountView()

    const restoreBtn = root.querySelector<HTMLButtonElement>('[data-testid^="template-version-restore-"]')
    expect(restoreBtn).toBeTruthy()
    restoreBtn!.click()
    await flushUi()
    expect(confirmSpy.mock.calls[0][0]).toContain('copy v1 into a new draft version')
    expect(confirmSpy.mock.calls[0][1]).toBe('Restore v1')
    expect((confirmSpy.mock.calls[0][2] as any).confirmButtonText).toBe('Restore as new draft')

    await vi.waitFor(() => {
      expect(elSuccessSpy).toHaveBeenCalledWith('Restored as draft v3')
    })
  })

  // Opens the diff panel to cover the dynamic diff-summary/mode-option chrome. The change
  // ENTITY/KIND labels this pins live directly in TemplateDetailView.vue (versionChangeKindLabel/
  // versionChangeEntityLabel); `change.label` itself (field/node NAMES) is user-authored DATA from
  // templateVersionDiff.ts and is asserted only for presence, never translated.
  it('view-changes panel: diff summary labels and mode options follow the locale', async () => {
    setLocale('en')
    mockActiveTemplate.value = buildTemplate({ latestVersionId: 'v2' })
    listTemplateVersionsSpy.mockResolvedValue([
      { id: 'v2', templateId: 'tpl-1', version: 2, status: 'draft', publishNote: null, publishedDefinitionId: null, restoredFromVersionId: null, createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' },
      { id: 'v1', templateId: 'tpl-1', version: 1, status: 'published', publishNote: null, publishedDefinitionId: 'pub-1', restoredFromVersionId: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ])
    getTemplateVersionSpy.mockImplementation((_id: string, versionId: string) => Promise.resolve({
      id: versionId,
      templateId: 'tpl-1',
      version: versionId === 'v2' ? 2 : 1,
      status: versionId === 'v2' ? 'draft' : 'published',
      formSchema: { fields: versionId === 'v2' ? [{ id: 'f1', type: 'text', label: 'Reimbursement amount' }] : [] },
      approvalGraph: { nodes: [], edges: [] },
      runtimeGraph: null,
      publishedDefinitionId: versionId === 'v2' ? null : 'pub-1',
      publishNote: null,
      restoredFromVersionId: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }))
    const root = await mountView()
    root.querySelector<HTMLButtonElement>('[data-testid^="template-version-compare-"]')!.click()
    await flushUi()

    const summary = root.querySelector('[data-testid="template-version-read-summary"]')
    expect(summary?.textContent).toContain('Form fields 1')
    expect(summary?.textContent).toContain('Process nodes 0')
    expect(summary?.textContent).toContain('Edges 0')

    const modeButtons = Array.from(root.querySelectorAll('[data-el-segmented] button')).map((b) => b.textContent)
    expect(modeButtons).toEqual(['Change list', 'Flow canvas', 'Side-by-side canvas'])

    const closeBtn = root.querySelector('[data-stub="ElButton"][aria-label]')
    expect(closeBtn?.getAttribute('aria-label')).toBe('Close version comparison')
  })

  // `versionDiffModeOptions` is a `computed()`, not a plain array literal evaluated once at
  // setup (see the comment on its declaration, TemplateDetailView.vue ~1273-1279). The mount
  // test above opens the panel fresh under a fixed locale, so it cannot tell a `computed()` from
  // a setup-time snapshot — both would show the right labels on first render. This test opens
  // the panel, THEN flips the shell locale (same `setLocale()` + `nextTick()` pattern as
  // "re-renders chrome AND the status badge when the shell locale flips after mount" above), and
  // reads the already-mounted `[data-el-segmented] button` labels again: a setup-time array
  // literal would keep showing the mount-time language.
  it('version-diff mode options re-render when the shell locale flips after the panel is already open', async () => {
    setLocale('zh-CN')
    mockActiveTemplate.value = buildTemplate({ latestVersionId: 'v2' })
    listTemplateVersionsSpy.mockResolvedValue([
      { id: 'v2', templateId: 'tpl-1', version: 2, status: 'draft', publishNote: null, publishedDefinitionId: null, restoredFromVersionId: null, createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' },
      { id: 'v1', templateId: 'tpl-1', version: 1, status: 'published', publishNote: null, publishedDefinitionId: 'pub-1', restoredFromVersionId: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ])
    getTemplateVersionSpy.mockImplementation((_id: string, versionId: string) => Promise.resolve({
      id: versionId,
      templateId: 'tpl-1',
      version: versionId === 'v2' ? 2 : 1,
      status: versionId === 'v2' ? 'draft' : 'published',
      formSchema: { fields: versionId === 'v2' ? [{ id: 'f1', type: 'text', label: '报销金额' }] : [] },
      approvalGraph: { nodes: [], edges: [] },
      runtimeGraph: null,
      publishedDefinitionId: versionId === 'v2' ? null : 'pub-1',
      publishNote: null,
      restoredFromVersionId: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }))
    const root = await mountView()
    root.querySelector<HTMLButtonElement>('[data-testid^="template-version-compare-"]')!.click()
    await flushUi()

    const modeButtonLabels = () =>
      Array.from(root.querySelectorAll('[data-el-segmented] button')).map((b) => b.textContent)

    expect(modeButtonLabels()).toEqual(['变化列表', '流程画布', '双画布'])

    setLocale('en')
    await nextTick()
    expect(modeButtonLabels()).toEqual(['Change list', 'Flow canvas', 'Side-by-side canvas'])

    setLocale('zh-CN')
    await nextTick()
    expect(modeButtonLabels()).toEqual(['变化列表', '流程画布', '双画布'])
  })

  // -------------------------------------------------------------------------
  // Label-table completeness. Loops the flat ZH/EN pair AND every MAP_PAIRS entry
  // (FIELD_TYPE/NODE_TYPE/APPROVAL_MODE/EMPTY_ASSIGNEE_POLICY/NODE_TIMEOUT_EFFECT/VERSION_STATUS/
  // VERSION_CHANGE_KIND/VERSION_CHANGE_ENTITY) — mount tests above only reach the KEYS some
  // fixture happens to render; `EN: Record<keyof typeof ZH, string>` only enforces key presence,
  // never that a value is non-empty, translated, or CJK-free. This closes both gaps for every key
  // in every table, not just the ones a mount test exercises.
  // -------------------------------------------------------------------------
  it('locale label tables (flat + every per-value map) are complete and actually translated', () => {
    function assertPair(name: string, zh: Record<string, string>, en: Record<string, string>) {
      const zhKeys = Object.keys(zh).sort()
      const enKeys = Object.keys(en).sort()
      expect(zhKeys.length, `${name}: vacuity guard`).toBeGreaterThan(0)
      expect(enKeys, `${name}: key sets differ`).toEqual(zhKeys)

      const emptyZh: string[] = []
      const emptyEn: string[] = []
      const chineseInEn: string[] = []
      const untranslated: string[] = []
      const asciiOnlyZh: string[] = []

      for (const key of zhKeys) {
        const zhValue = zh[key]!
        const enValue = en[key]!
        if (zhValue.trim() === '') emptyZh.push(key)
        if (enValue.trim() === '') emptyEn.push(key)
        if (CJK.test(enValue)) chineseInEn.push(`${key}=${enValue}`)
        if (zhValue === enValue) untranslated.push(key)
        if (!CJK.test(zhValue)) asciiOnlyZh.push(`${key}=${zhValue}`)
      }

      expect(emptyZh, `${name}: empty zh values`).toEqual([])
      expect(emptyEn, `${name}: empty en values`).toEqual([])
      expect(chineseInEn, `${name}: CJK found in en values`).toEqual([])
      expect(untranslated, `${name}: zh === en (not translated)`).toEqual([])
      expect(asciiOnlyZh, `${name}: zh value has no CJK at all`).toEqual([])
    }

    assertPair('ZH/EN', ZH, EN)
    expect(MAP_PAIRS.length).toBe(8)
    for (const pair of MAP_PAIRS) {
      assertPair(pair.name, pair.zh, pair.en)
    }
  })

  // -------------------------------------------------------------------------
  // CJK guard: no stray Chinese literal survives in TemplateDetailView.vue outside (a) comments,
  // (b) templateDetailLabels.ts (a separate file, not scanned here), and (c) two explicitly named,
  // by-design exceptions:
  //   - every `isZh.value ? <zh-literal> : <en-literal>` inline ternary this slice added (see this
  //     file's header note 1) — extracted and vetted individually (en-side must be CJK-free),
  //     mirroring how templateCenterI18n.spec.ts's own guard allowlists ApprovalCenterView.vue's
  //     `tabEmptyText` by-design ZH branch;
  //   - the `NON_ALL_SCOPE_UNIT_LABEL` zh-only constant and the two `流程节点`/version-diff-overlay
  //     node-label fallbacks, which are PRE-EXISTING, unconverted, out-of-scope surfaces (the
  //     first is pinned byte-for-byte by approval-member-identity-coverage-enumeration.spec.ts;
  //     the other two belong to the version-diff-overlay chrome family this slice does not touch —
  //     see this slice's own couldNotDo/left-list). Named here, not silently excluded by a loose
  //     regex, so a NEW stray literal elsewhere in the file still reds.
  // -------------------------------------------------------------------------
  it('guard: TemplateDetailView.vue has no CJK literal outside comments, the isZh-branched constructs, and the two named pre-existing exceptions', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const abs = path.resolve(__dirname, '../src/views/approval/TemplateDetailView.vue')
    const source = fs.readFileSync(abs, 'utf-8')

    // Comment stripping — same conservative rule as templateCenterI18n.spec.ts (only a
    // whitespace-only-prefixed `//` is treated as a full-line comment, so a `//` inside a quoted
    // string/attribute is never mistaken for one).
    function stripLineCommentsConservatively(src: string): string {
      return src
        .split('\n')
        .map((line) => {
          const slashIdx = line.indexOf('//')
          if (slashIdx === -1) return line
          const before = line.slice(0, slashIdx)
          if (before.trim() !== '') return line
          return before
        })
        .join('\n')
    }

    const noStyle = source.replace(/<style[\s\S]*?<\/style>/g, '')
    const noHtmlComments = noStyle.replace(/<!--[\s\S]*?-->/g, '')
    const noBlockComments = noHtmlComments.replace(/\/\*[\s\S]*?\*\//g, '')
    let stripped = stripLineCommentsConservatively(noBlockComments)

    // (a) Every `isZh.value ? <str> : <str>` construct, single- or multi-line (this view's actual
    // layout uses both shapes — see e.g. `resolvedIdsOrCount`'s single-line role branch vs.
    // `restoreConfirmMessage`'s three-line form). Verified en-side CJK-free per occurrence;
    // vacuity-guarded (a regex that silently stopped matching would leave its zh-side literals in
    // the blanket scan below, which would then legitimately fail — this guard cannot go quietly
    // green by matching nothing).
    const TERNARY = /isZh\.value\s*\?\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*:\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g
    const ternaryMatches = Array.from(stripped.matchAll(TERNARY))
    // 12 today: SLA-updated toast, category-updated toast, resolvedIdsOrCount's role branch, its
    // user-name-join separator ('、' vs ', '), its dept/user branch, the threshold-approval
    // suffix, the timeout-minutes suffix, formatDate's Intl locale id, restoreConfirmTitle,
    // restoreConfirmMessage, the restore-success toast, and fieldChangesNoteText. A count that
    // silently drops keeps whatever it stops covering out of the exclusion and into the blanket
    // scan below, where it would legitimately fail — this can go quietly WRONG (miscounted) but
    // not quietly GREEN (a dropped construct still reds the blanket scan).
    expect(ternaryMatches.length, 'vacuity guard: expected isZh ternary constructs not found').toBe(12)
    const enSideOffenders: string[] = []
    for (const m of ternaryMatches) {
      const enSide = m[2]!
      if (CJK.test(enSide)) enSideOffenders.push(enSide)
    }
    expect(enSideOffenders, 'a ternary en-branch contains CJK').toEqual([])
    stripped = stripped.replace(TERNARY, '')

    // (b) The two named, pre-existing, out-of-scope exceptions. Presence-checked (not just
    // blindly stripped) so a future rename/removal is caught here rather than silently widening
    // what this guard tolerates.
    const NAMED_EXCEPTIONS: Array<{ line: string; count: number }> = [
      // Pinned verbatim by approval-member-identity-coverage-enumeration.spec.ts's OUT-OF-SCOPE
      // "a COUNT, never the raw ids" group — real zh-CN vocabulary this slice's English branch
      // (NON_ALL_SCOPE_UNIT_LABEL_EN, immediately below it in source) never needs to match.
      { line: `const NON_ALL_SCOPE_UNIT_LABEL: Record<'dept' | 'user', string> = { dept: '部门', user: '用户' }`, count: 1 },
      // Version-diff-overlay node-label fallbacks (versionOverlayNodeLabel AND versionDualNodeLabel
      // both share this exact line — TWO occurrences, not one) — shared with the unconverted
      // templateVersionDiff.ts/versionGraphOverlay.ts/approvalVersionDualCanvas.ts family (this
      // slice's couldNotDo), pinned by the SAME census above under "a graph NODE key/name" — not
      // touched by this slice's i18n conversion.
      { line: `return node?.name?.trim() || (node ? nodeTypeLabel(node.type) : '流程节点')`, count: 2 },
      { line: `if (!dual) return '流程节点'`, count: 1 },
    ]
    for (const { line, count } of NAMED_EXCEPTIONS) {
      const actualCount = stripped.split(line).length - 1
      expect(actualCount, `named exception occurrence count changed: ${line}`).toBe(count)
      stripped = stripped.split(line).join('')
    }

    const offenders = stripped.split('\n').filter((line) => CJK.test(line))
    expect(offenders).toEqual([])
  })
})
