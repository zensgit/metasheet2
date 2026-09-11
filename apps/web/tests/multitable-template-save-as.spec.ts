/**
 * 模板中心「把 Base 存为模板」入口(09-10 测试反馈第 8 条:模板中心只能用、不能建)。
 *
 * 覆盖:
 *  - 入口按权限显隐(镜像服务端 canManageFields = 管理员角色或 multitable:manage-schema);
 *  - 表单校验(没选 Base / 没填名字 → 提交禁用);
 *  - 提交调 client.createTemplateFromBase 并把服务端的降级 warnings 原样展示,列表强制刷新;
 *  - 自定义模板卡片带「自定义」角标与删除入口,内置模板两者都没有;
 *  - 删除走 client.deleteTemplate 并刷新列表;
 *  - 可见性:「共享给本租户」默认不勾,提交的 visibility 是 'private';勾了才是 'tenant';
 *  - 服务端的 customTemplatesUnavailable 降级标志位必须在页面上明说(而不是表现成「你没建过模板」)。
 *
 * F7(09-11 反馈第 7 条:「在表里调好字段后一键存为模板」)追加的第二个 describe:
 * 工作台工具栏的「存为模板」入口 —— 按 caps.canManageFields 与 activeSheetId 显隐、
 * 对话框默认值(模板名 = 当前**数据表**名、字段默认全选、「共享给本租户」默认不勾)、
 * 以及提交出去的 payload 形状 { baseId, sheetIds:[当前表], fieldIds:[勾选的] }。
 *
 * 隐藏只是 UX,服务端才是门 —— 路由级证明在
 * packages/core-backend/tests/unit/multitable-custom-template-routes.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Component } from 'vue'
import MultitableTemplateCenterView from '../src/views/MultitableTemplateCenterView.vue'
import { useLocale } from '../src/composables/useLocale'

const USER_PERMISSIONS_KEY = 'user_permissions'

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  listTemplates: vi.fn(),
  installTemplate: vi.fn(),
  listBases: vi.fn(),
  createTemplateFromBase: vi.fn(),
  deleteTemplate: vi.fn(),
}))

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return { ...actual, useRouter: () => ({ push: mocks.push }) }
})

// 只换掉 `multitableClient` 这一个单例,模块里别的导出(MultitableApiClient 类、
// normalizeMultitableComment 等)保留真身 —— 工作台一路拉起来的 composable 里有好几个
// 在模块作用域就引用它们,整模块替换会在 import 期就炸。
vi.mock('../src/multitable/api/client', async () => {
  const actual = await vi.importActual<typeof import('../src/multitable/api/client')>('../src/multitable/api/client')
  return {
    ...actual,
    multitableClient: {
      listTemplates: mocks.listTemplates,
      installTemplate: mocks.installTemplate,
      listBases: mocks.listBases,
      createTemplateFromBase: mocks.createTemplateFromBase,
      deleteTemplate: mocks.deleteTemplate,
    },
  }
})

// ── 工作台入口用的替身(第二个 describe)。模板中心那张视图一个都不用,所以这些
// file 级 mock 不会影响上面的用例。
function stubComponent(name: string) {
  return defineComponent({ name, render() { return h('div', { [`data-stub-${name}`]: 'true' }) } })
}

let workbenchMock: any
let gridMock: any
let capsMock: any

vi.mock('../src/multitable/composables/useMultitableWorkbench', () => ({
  useMultitableWorkbench: () => workbenchMock,
}))
vi.mock('../src/multitable/composables/useMultitableGrid', () => ({
  useMultitableGrid: () => gridMock,
}))
vi.mock('../src/multitable/composables/useMultitableCapabilities', () => ({
  useMultitableCapabilities: () => capsMock,
}))
vi.mock('../src/multitable/composables/useMultitableComments', () => ({
  useMultitableComments: () => ({
    comments: ref([]), loading: ref(false), submitting: ref(false), resolvingIds: ref<string[]>([]),
    updatingIds: ref<string[]>([]), deletingIds: ref<string[]>([]), error: ref<string | null>(null),
    reactingKeys: ref<string[]>([]),
    loadComments: vi.fn(), addComment: vi.fn(), updateComment: vi.fn(), deleteComment: vi.fn(),
    resolveComment: vi.fn(), clearComments: vi.fn(), addReaction: vi.fn(), removeReaction: vi.fn(),
  }),
}))
vi.mock('../src/multitable/composables/useMultitableCommentInbox', () => ({
  useMultitableCommentInbox: () => ({ unreadCount: ref(0), refreshUnreadCount: vi.fn().mockResolvedValue(0) }),
}))
vi.mock('../src/multitable/composables/useMultitableCommentRealtime', () => ({ useMultitableCommentRealtime: vi.fn() }))
vi.mock('../src/multitable/composables/useMultitableSheetRealtime', () => ({ useMultitableSheetRealtime: vi.fn() }))
vi.mock('../src/multitable/import/bulk-import', () => ({ bulkImportRecords: vi.fn() }))
vi.mock('../src/multitable/components/MetaSheetViewRail.vue', () => ({ default: stubComponent('MetaSheetViewRail') }))
vi.mock('../src/multitable/components/MetaToolbar.vue', () => ({ default: stubComponent('MetaToolbar') }))
vi.mock('../src/multitable/components/MetaGridTable.vue', () => ({ default: stubComponent('MetaGridTable') }))
vi.mock('../src/multitable/components/MetaFormView.vue', () => ({ default: stubComponent('MetaFormView') }))
vi.mock('../src/multitable/components/MetaRecordInspector.vue', () => ({ default: stubComponent('MetaRecordInspector') }))
vi.mock('../src/multitable/components/RestorePreviewDialog.vue', () => ({ default: stubComponent('RestorePreviewDialog') }))
vi.mock('../src/multitable/components/RestoreBatchDialog.vue', () => ({ default: stubComponent('RestoreBatchDialog') }))
vi.mock('../src/multitable/components/MetaCommentsDrawer.vue', () => ({ default: stubComponent('MetaCommentsDrawer') }))
vi.mock('../src/multitable/components/MetaLinkPicker.vue', () => ({ default: stubComponent('MetaLinkPicker') }))
vi.mock('../src/multitable/components/MetaFieldManager.vue', () => ({ default: stubComponent('MetaFieldManager') }))
vi.mock('../src/multitable/components/MetaKanbanView.vue', () => ({ default: stubComponent('MetaKanbanView') }))
vi.mock('../src/multitable/components/MetaGalleryView.vue', () => ({ default: stubComponent('MetaGalleryView') }))
vi.mock('../src/multitable/components/MetaCalendarView.vue', () => ({ default: stubComponent('MetaCalendarView') }))
vi.mock('../src/multitable/components/MetaTimelineView.vue', () => ({ default: stubComponent('MetaTimelineView') }))
vi.mock('../src/multitable/components/MetaImportModal.vue', () => ({ default: stubComponent('MetaImportModal') }))
vi.mock('../src/multitable/components/MetaBasePicker.vue', () => ({ default: stubComponent('MetaBasePicker') }))
vi.mock('../src/multitable/components/MetaToast.vue', () => ({ default: stubComponent('MetaToast') }))

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function makeTemplate(overrides: {
  id: string
  name: string
  custom?: boolean
  category?: string
  visibility?: 'private' | 'tenant'
}) {
  return {
    id: overrides.id,
    name: overrides.name,
    description: '',
    category: overrides.category ?? 'Operations',
    icon: 'T',
    color: '#2563eb',
    sheets: [{ id: 's1', name: 'Sheet', fields: [{ id: 'f1' }], views: [{ id: 'v1', name: 'Grid', type: 'grid' }] }],
    ...(overrides.custom ? { custom: true, visibility: overrides.visibility ?? 'private' } : {}),
  }
}

function setValue(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input'))
  input.dispatchEvent(new Event('change'))
}

describe('模板中心 —— 把 Base 存为模板', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    useLocale().setLocale('zh-CN')
    localStorage.removeItem(USER_PERMISSIONS_KEY)
    mocks.listTemplates.mockResolvedValue({ templates: [] })
    mocks.listBases.mockResolvedValue({ bases: [{ id: 'base_ops', name: '运营库' }] })
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    localStorage.removeItem(USER_PERMISSIONS_KEY)
    useLocale().setLocale('en')
    vi.clearAllMocks()
  })

  function mountView(): HTMLElement {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(MultitableTemplateCenterView as Component)
    app.component('router-link', {
      props: ['to'],
      render() {
        const href = typeof this.$props.to === 'string' ? this.$props.to : JSON.stringify(this.$props.to)
        return h('a', { href, 'data-router-link-to': href }, this.$slots.default ? this.$slots.default() : [])
      },
    })
    app.mount(container)
    return container
  }

  it('没有 multitable:manage-schema 时不给「存为模板」入口', async () => {
    const root = mountView()
    await flushUi()
    expect(root.querySelector('[data-testid="template-create-open"]')).toBeNull()
    expect(root.querySelector('[data-testid="template-create-form"]')).toBeNull()
  })

  it('有 multitable:manage-schema:打开表单会拉 Base 列表,选 Base 自动带出名字', async () => {
    localStorage.setItem(USER_PERMISSIONS_KEY, JSON.stringify(['multitable:manage-schema']))
    const root = mountView()
    await flushUi()

    const open = root.querySelector<HTMLButtonElement>('[data-testid="template-create-open"]')
    expect(open).not.toBeNull()
    open!.click()
    await flushUi()

    expect(mocks.listBases).toHaveBeenCalledTimes(1)
    const form = root.querySelector('[data-testid="template-create-form"]')
    expect(form).not.toBeNull()
    // 未选 Base / 未填名字 → 提交禁用
    const submit = root.querySelector<HTMLButtonElement>('[data-testid="template-create-submit"]')
    expect(submit!.disabled).toBe(true)

    const select = root.querySelector<HTMLSelectElement>('[data-testid="template-create-base"]')!
    setValue(select, 'base_ops')
    await flushUi()
    const name = root.querySelector<HTMLInputElement>('[data-testid="template-create-name"]')!
    expect(name.value).toBe('运营库')
    expect(root.querySelector<HTMLButtonElement>('[data-testid="template-create-submit"]')!.disabled).toBe(false)

    // 名字清空 → 又不可提交(只有 Base 不够)
    setValue(name, '   ')
    await flushUi()
    expect(root.querySelector<HTMLButtonElement>('[data-testid="template-create-submit"]')!.disabled).toBe(true)
  })

  it('提交后调用 createTemplateFromBase、展示降级 warnings、并强制刷新模板列表', async () => {
    localStorage.setItem(USER_PERMISSIONS_KEY, JSON.stringify(['multitable:manage-schema']))
    mocks.createTemplateFromBase.mockResolvedValue({
      template: makeTemplate({ id: 'mtpl_abc', name: '订单模板', custom: true }),
      warnings: ['字段「关联客户」是 link 类型,依赖当前 Base 的其它表/字段,模板里已转为文本列。'],
    })
    const root = mountView()
    await flushUi()
    root.querySelector<HTMLButtonElement>('[data-testid="template-create-open"]')!.click()
    await flushUi()

    setValue(root.querySelector<HTMLSelectElement>('[data-testid="template-create-base"]')!, 'base_ops')
    await flushUi()
    setValue(root.querySelector<HTMLInputElement>('[data-testid="template-create-name"]')!, '订单模板')
    setValue(root.querySelector<HTMLInputElement>('[data-testid="template-create-description"]')!, '订单跟进')
    setValue(root.querySelector<HTMLInputElement>('[data-testid="template-create-category"]')!, '运营')
    await flushUi()

    mocks.listTemplates.mockResolvedValue({
      templates: [makeTemplate({ id: 'mtpl_abc', name: '订单模板', custom: true })],
    })
    root.querySelector<HTMLButtonElement>('[data-testid="template-create-submit"]')!.click()
    await flushUi(10)

    // 精确 deep-equal:多一个键、少一个键、或 visibility 变成 'tenant' 都要红 ——
    // 默认必须是 private(模板携带表名与全部字段名,发布给整租户得是显式动作)。
    expect(mocks.createTemplateFromBase).toHaveBeenCalledWith({
      baseId: 'base_ops',
      name: '订单模板',
      description: '订单跟进',
      category: '运营',
      visibility: 'private',
    })
    // 列表强制刷新(否则客户端缓存会让刚建的模板不出现)
    expect(mocks.listTemplates).toHaveBeenLastCalledWith({ force: true })
    const warnings = root.querySelector('[data-testid="template-create-warnings"]')
    expect(warnings?.textContent).toContain('关联客户')
    expect(root.querySelector('[data-testid="template-create-notice"]')?.textContent).toContain('订单模板')
  })

  it('创建失败时把服务端错误显示出来,且不刷新列表', async () => {
    localStorage.setItem(USER_PERMISSIONS_KEY, JSON.stringify(['multitable:manage-schema']))
    mocks.createTemplateFromBase.mockRejectedValue(new Error('Saving a base as a template requires schema authority'))
    const root = mountView()
    await flushUi()
    root.querySelector<HTMLButtonElement>('[data-testid="template-create-open"]')!.click()
    await flushUi()
    setValue(root.querySelector<HTMLSelectElement>('[data-testid="template-create-base"]')!, 'base_ops')
    await flushUi()

    const callsBefore = mocks.listTemplates.mock.calls.length
    root.querySelector<HTMLButtonElement>('[data-testid="template-create-submit"]')!.click()
    await flushUi(10)

    expect(root.querySelector('[data-testid="template-create-error"]')?.textContent).toContain('schema authority')
    expect(mocks.listTemplates.mock.calls.length).toBe(callsBefore)
  })

  it('自定义模板卡片带「自定义」角标与删除入口;内置模板没有', async () => {
    localStorage.setItem(USER_PERMISSIONS_KEY, JSON.stringify(['multitable:manage-schema']))
    mocks.listTemplates.mockResolvedValue({
      templates: [
        makeTemplate({ id: 'mtpl_abc', name: '订单模板', custom: true }),
        makeTemplate({ id: 'project-tracker', name: 'Project Tracker' }),
      ],
    })
    mocks.deleteTemplate.mockResolvedValue({ templateId: 'mtpl_abc' })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    const root = mountView()
    await flushUi()

    const customCard = root.querySelector<HTMLElement>('[data-template-id="mtpl_abc"]')!
    const builtinCard = root.querySelector<HTMLElement>('[data-template-id="project-tracker"]')!
    expect(customCard.querySelector('[data-testid="template-card-custom-badge"]')?.textContent?.trim()).toBe('自定义')
    expect(builtinCard.querySelector('[data-testid="template-card-custom-badge"]')).toBeNull()
    expect(customCard.querySelector('[data-testid="template-card-delete"]')).not.toBeNull()
    expect(builtinCard.querySelector('[data-testid="template-card-delete"]')).toBeNull()

    customCard.querySelector<HTMLButtonElement>('[data-testid="template-card-delete"]')!.click()
    await flushUi(10)

    expect(confirmSpy).toHaveBeenCalled()
    expect(mocks.deleteTemplate).toHaveBeenCalledWith('mtpl_abc')
    expect(mocks.listTemplates).toHaveBeenLastCalledWith({ force: true })
    confirmSpy.mockRestore()
  })

  it('没有 manage-schema 时自定义模板也不给删除入口', async () => {
    mocks.listTemplates.mockResolvedValue({
      templates: [makeTemplate({ id: 'mtpl_abc', name: '订单模板', custom: true })],
    })
    const root = mountView()
    await flushUi()
    expect(root.querySelector('[data-testid="template-card-custom-badge"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="template-card-delete"]')).toBeNull()
  })

  it('勾了「共享给本租户」才提交 visibility:tenant,提示按服务端返回的可见性说话', async () => {
    localStorage.setItem(USER_PERMISSIONS_KEY, JSON.stringify(['multitable:manage-schema']))
    mocks.createTemplateFromBase.mockResolvedValue({
      template: makeTemplate({ id: 'mtpl_shared', name: '共享模板', custom: true, visibility: 'tenant' }),
      warnings: [],
    })
    const root = mountView()
    await flushUi()
    root.querySelector<HTMLButtonElement>('[data-testid="template-create-open"]')!.click()
    await flushUi()
    setValue(root.querySelector<HTMLSelectElement>('[data-testid="template-create-base"]')!, 'base_ops')
    await flushUi()

    const share = root.querySelector<HTMLInputElement>('[data-testid="template-create-shared"]')!
    // 默认不勾:发布给整租户必须是一次显式动作
    expect(share.checked).toBe(false)
    share.checked = true
    share.dispatchEvent(new Event('change'))
    await flushUi()

    root.querySelector<HTMLButtonElement>('[data-testid="template-create-submit"]')!.click()
    await flushUi(10)

    expect(mocks.createTemplateFromBase.mock.calls[0]?.[0]?.visibility).toBe('tenant')
    expect(root.querySelector('[data-testid="template-create-notice"]')?.textContent).toContain('已共享给本租户')
  })

  it('服务端说自定义模板暂不可用时页面必须明说(不能表现成「你没建过模板」)', async () => {
    mocks.listTemplates.mockResolvedValue({
      templates: [makeTemplate({ id: 'project-tracker', name: 'Project Tracker' })],
      customTemplatesUnavailable: true,
    })
    const root = mountView()
    await flushUi()

    const banner = root.querySelector('[data-testid="template-custom-unavailable"]')
    expect(banner).not.toBeNull()
    expect(banner!.textContent).toContain('自定义模板暂不可用')
    // 内置模板照常列出来
    expect(root.querySelector('[data-template-id="project-tracker"]')).not.toBeNull()
  })

  it('服务端没有降级标志位时不显示那条提示', async () => {
    mocks.listTemplates.mockResolvedValue({
      templates: [makeTemplate({ id: 'project-tracker', name: 'Project Tracker' })],
    })
    const root = mountView()
    await flushUi()
    expect(root.querySelector('[data-testid="template-custom-unavailable"]')).toBeNull()
  })

  it('私有模板卡片带「仅自己可见」角标;共享给租户的没有', async () => {
    mocks.listTemplates.mockResolvedValue({
      templates: [
        makeTemplate({ id: 'mtpl_priv', name: '私有模板', custom: true }),
        makeTemplate({ id: 'mtpl_shared', name: '共享模板', custom: true, visibility: 'tenant' }),
        makeTemplate({ id: 'project-tracker', name: 'Project Tracker' }),
      ],
    })
    const root = mountView()
    await flushUi()

    expect(root.querySelector('[data-template-id="mtpl_priv"] [data-testid="template-card-private-badge"]')).not.toBeNull()
    expect(root.querySelector('[data-template-id="mtpl_shared"] [data-testid="template-card-private-badge"]')).toBeNull()
    expect(root.querySelector('[data-template-id="project-tracker"] [data-testid="template-card-private-badge"]')).toBeNull()
  })
})

// ── F7:工作台工具栏「把当前数据表存为模板」 ──────────────────────────────────
//
// 这一段证明的是**入口与 payload 形状**:按钮按 caps.canManageFields / activeSheetId 显隐、
// 对话框默认值、以及提交出去的 { baseId, sheetIds, fieldIds } 逐字形状。收窄参数到底有没有
// 被服务端下推进 SQL,是路由级 spec(F7-1/F7-1b/F7-3)的事,这里不冒充。

const SHEET_FIELDS = [
  { id: 'fld_title', name: '订单号', type: 'string', property: {}, order: 0, options: [] },
  { id: 'fld_status', name: '状态', type: 'select', property: {}, order: 1, options: [] },
  { id: 'fld_owner', name: '负责人', type: 'person', property: {}, order: 2, options: [] },
]

function createWorkbenchMock() {
  const activeBaseId = ref('base_ops')
  const activeSheetId = ref<string | null>('sheet_orders')
  const activeViewId = ref('view_grid')
  const views = ref([{ id: 'view_grid', sheetId: 'sheet_orders', name: 'Grid', type: 'grid', filterInfo: null, sortInfo: null, groupInfo: null, hiddenFieldIds: [], config: {} }])
  return {
    client: {
      listBases: vi.fn().mockResolvedValue({ bases: [{ id: 'base_ops', name: '运营库' }] }),
      loadContext: vi.fn().mockResolvedValue({ base: { id: 'base_ops' }, sheet: null, sheets: [], views: [], capabilities: {} }),
      listTemplates: mocks.listTemplates,
      installTemplate: mocks.installTemplate,
      createTemplateFromBase: mocks.createTemplateFromBase,
      loadFormContext: vi.fn(), getRecord: vi.fn(), createSheet: vi.fn(), createBase: vi.fn(),
      renameSheet: vi.fn(), createField: vi.fn(), preparePersonField: vi.fn(), updateField: vi.fn(),
      deleteField: vi.fn(), createView: vi.fn(), deleteView: vi.fn(), patchRecords: vi.fn(),
      submitForm: vi.fn(), updateView: vi.fn(), deleteSheet: vi.fn(),
    },
    sheets: ref([
      { id: 'sheet_orders', baseId: 'base_ops', name: '订单', description: null },
      { id: 'sheet_archive', baseId: 'base_ops', name: '归档', description: null },
    ]),
    fields: ref(SHEET_FIELDS),
    views, activeBaseId, activeSheetId, activeViewId,
    bases: ref([]),
    capabilities: ref({
      canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true, canManageFields: true,
      canManageSheetAccess: true, canManageViews: true, canComment: true, canManageAutomation: false,
      canExport: true, canSendNotification: true, canDeleteSheet: true,
    }),
    capabilityOrigin: ref(null), fieldPermissions: ref({}), viewPermissions: ref({}),
    activeView: computed(() => views.value.find((v) => v.id === activeViewId.value) ?? null),
    loading: ref(false), error: ref<string | null>(null),
    loadSheets: vi.fn().mockResolvedValue(true), loadBaseContext: vi.fn().mockResolvedValue(true),
    loadSheetMeta: vi.fn().mockResolvedValue(true), switchBase: vi.fn().mockResolvedValue(true),
    syncExternalContext: vi.fn().mockResolvedValue(true),
    selectBase: vi.fn(), selectSheet: vi.fn(), selectView: vi.fn(),
  }
}

function createGridMock() {
  return {
    fields: ref(SHEET_FIELDS), rows: ref([]), loading: ref(false), currentPage: ref(1), totalPages: ref(1),
    page: ref({ offset: 0, limit: 50, total: 0, hasMore: false }), visibleFields: ref(SHEET_FIELDS),
    sortRules: ref([]), filterRules: ref([]), filterConjunction: ref('and'), filterGroups: ref([]),
    canLoadMore: ref(false), canUndo: ref(false), canRedo: ref(false),
    groupFieldId: ref<string | null>(null), groupFieldIds: ref([]), groupField: ref(null), groupFields: ref([]),
    hiddenFieldIds: ref<string[]>([]), columnWidths: ref<Record<string, number>>({}),
    linkSummaries: ref({}), personSummaries: ref({}), attachmentSummaries: ref({}),
    fieldPermissions: ref({}), viewPermission: ref(null), rowActions: ref(null), rowActionOverrides: ref({}),
    capabilityOrigin: ref(null), conflict: ref(null), error: ref<string | null>(null), sortFilterDirty: ref(false),
    toggleFieldVisibility: vi.fn(), addSortRule: vi.fn(), removeSortRule: vi.fn(), addFilterRule: vi.fn(),
    updateFilterRule: vi.fn(), removeFilterRule: vi.fn(), clearFilters: vi.fn(), applySortFilter: vi.fn(),
    undo: vi.fn(), redo: vi.fn(), setGroupField: vi.fn(), setGroupFields: vi.fn(), goToPage: vi.fn(),
    patchCell: vi.fn(), createRecord: vi.fn(), deleteRecord: vi.fn(), resolveRowActions: vi.fn(() => null),
    loadViewData: vi.fn().mockResolvedValue(true), reloadCurrentPage: vi.fn(), dismissConflict: vi.fn(),
    retryConflict: vi.fn(), setColumnWidth: vi.fn(), setSearchQuery: vi.fn(),
  }
}

function createCapsMock(overrides: Record<string, boolean> = {}) {
  const base: Record<string, boolean> = {
    canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true,
    canManageFields: true, canManageSheetAccess: true, canManageViews: true, canComment: true,
    canManageAutomation: false, canExport: true, canSendNotification: true, canDeleteSheet: true,
    ...overrides,
  }
  return Object.fromEntries(Object.entries(base).map(([key, value]) => [key, ref(value)]))
}

describe('工作台 —— 把当前数据表存为模板(F7)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    useLocale().setLocale('zh-CN')
    workbenchMock = createWorkbenchMock()
    gridMock = createGridMock()
    capsMock = createCapsMock()
    mocks.listTemplates.mockResolvedValue({ templates: [] })
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    useLocale().setLocale('en')
    vi.clearAllMocks()
  })

  async function mountWorkbench(): Promise<HTMLElement> {
    const MultitableWorkbench = (await import('../src/multitable/views/MultitableWorkbench.vue')).default
    app = createApp(defineComponent({ setup() { return () => h(MultitableWorkbench as Component) } }))
    app.component('router-link', {
      props: ['to'],
      render() {
        const href = typeof this.$props.to === 'string' ? this.$props.to : JSON.stringify(this.$props.to)
        return h('a', { href, 'data-router-link-to': href }, this.$slots.default ? this.$slots.default() : [])
      },
    })
    app.mount(container!)
    await flushUi()
    return container!
  }

  function entry(root: HTMLElement): HTMLButtonElement | null {
    return root.querySelector('[data-action="save-sheet-as-template"]')
  }

  async function openDialog(root: HTMLElement): Promise<HTMLElement> {
    entry(root)!.click()
    await flushUi()
    const dialog = root.querySelector('[data-testid="save-sheet-as-template-dialog"]') as HTMLElement
    expect(dialog).toBeTruthy()
    return dialog
  }

  it('入口按 canManageFields 显隐;没有激活数据表时不渲染', async () => {
    const root = await mountWorkbench()
    expect(entry(root)).toBeTruthy()

    capsMock.canManageFields.value = false
    await flushUi()
    expect(entry(root)).toBeNull()

    capsMock.canManageFields.value = true
    workbenchMock.activeSheetId.value = null
    await flushUi()
    expect(entry(root)).toBeNull()
  })

  it('对话框默认值:模板名 = 当前数据表名、字段默认全选、「共享给本租户」默认不勾', async () => {
    const root = await mountWorkbench()
    const dialog = await openDialog(root)

    const name = dialog.querySelector('[data-testid="save-sheet-as-template-name"]') as HTMLInputElement
    // 取的是**数据表**名(订单),不是工作区名(运营库)
    expect(name.value).toBe('订单')

    const boxes = Array.from(dialog.querySelectorAll('[data-save-template-field]')) as HTMLInputElement[]
    expect(boxes.map((box) => box.getAttribute('data-save-template-field'))).toEqual(['fld_title', 'fld_status', 'fld_owner'])
    expect(boxes.every((box) => box.checked)).toBe(true)
    expect(dialog.querySelector('[data-testid="save-sheet-as-template-count"]')?.textContent?.trim()).toBe('3 / 3')

    const share = dialog.querySelector('[data-testid="save-sheet-as-template-share"]') as HTMLInputElement
    expect(share.checked).toBe(false)
  })

  it('勾掉两列后提交的 payload 逐字等于 { baseId, name, sheetIds:[当前表], fieldIds:[勾选的], visibility:private }', async () => {
    mocks.createTemplateFromBase.mockResolvedValue({
      template: makeTemplate({ id: 'mtpl_new', name: '订单', custom: true }),
      warnings: [],
    })
    const root = await mountWorkbench()
    const dialog = await openDialog(root)

    for (const fieldId of ['fld_status', 'fld_owner']) {
      const box = dialog.querySelector(`[data-save-template-field="${fieldId}"]`) as HTMLInputElement
      box.click()
      await flushUi()
    }
    expect(dialog.querySelector('[data-testid="save-sheet-as-template-count"]')?.textContent?.trim()).toBe('1 / 3')

    ;(dialog.querySelector('[data-action="save-sheet-as-template-submit"]') as HTMLButtonElement).click()
    await flushUi()

    expect(mocks.createTemplateFromBase).toHaveBeenCalledTimes(1)
    expect(mocks.createTemplateFromBase.mock.calls[0][0]).toEqual({
      baseId: 'base_ops',
      name: '订单',
      sheetIds: ['sheet_orders'],
      fieldIds: ['fld_title'],
      visibility: 'private',
    })
  })

  it('勾了「共享给本租户」才发 visibility: tenant', async () => {
    mocks.createTemplateFromBase.mockResolvedValue({
      template: makeTemplate({ id: 'mtpl_shared', name: '订单', custom: true, visibility: 'tenant' }),
      warnings: [],
    })
    const root = await mountWorkbench()
    const dialog = await openDialog(root)
    const share = dialog.querySelector('[data-testid="save-sheet-as-template-share"]') as HTMLInputElement
    share.click()
    await flushUi()

    ;(dialog.querySelector('[data-action="save-sheet-as-template-submit"]') as HTMLButtonElement).click()
    await flushUi()
    expect(mocks.createTemplateFromBase.mock.calls[0][0].visibility).toBe('tenant')
  })

  it('一个字段都不勾时不发请求,并给出可读的错误', async () => {
    const root = await mountWorkbench()
    const dialog = await openDialog(root)
    ;(dialog.querySelector('[data-action="save-sheet-as-template-select-none"]') as HTMLButtonElement).click()
    await flushUi()
    ;(dialog.querySelector('[data-action="save-sheet-as-template-submit"]') as HTMLButtonElement).click()
    await flushUi()

    expect(mocks.createTemplateFromBase).not.toHaveBeenCalled()
    expect(dialog.querySelector('[data-testid="save-sheet-as-template-error"]')?.textContent).toContain('字段')
  })

  it('成功后原样列出服务端 warnings,并给一条「去模板中心查看」的链接', async () => {
    mocks.createTemplateFromBase.mockResolvedValue({
      template: makeTemplate({ id: 'mtpl_new', name: '订单', custom: true }),
      warnings: ['字段「通知」是 button 类型,模板里已转为文本列。'],
    })
    const root = await mountWorkbench()
    const dialog = await openDialog(root)
    ;(dialog.querySelector('[data-action="save-sheet-as-template-submit"]') as HTMLButtonElement).click()
    await flushUi()

    const result = dialog.querySelector('[data-testid="save-sheet-as-template-result"]')
    expect(result).toBeTruthy()
    const warnings = Array.from(dialog.querySelectorAll('[data-testid="save-sheet-as-template-warnings"] li'))
    expect(warnings.map((li) => li.textContent)).toEqual(['字段「通知」是 button 类型,模板里已转为文本列。'])
    expect(dialog.querySelector('[data-testid="save-sheet-as-template-center-link"]')).toBeTruthy()
  })

  it('失败时把服务端的话原样显示,对话框不切到成功态', async () => {
    mocks.createTemplateFromBase.mockRejectedValue(new Error('This base has no readable table with fields to save as a template'))
    const root = await mountWorkbench()
    const dialog = await openDialog(root)
    ;(dialog.querySelector('[data-action="save-sheet-as-template-submit"]') as HTMLButtonElement).click()
    await flushUi()

    expect(dialog.querySelector('[data-testid="save-sheet-as-template-result"]')).toBeNull()
    expect(dialog.querySelector('[data-testid="save-sheet-as-template-error"]')?.textContent)
      .toContain('no readable table')
  })
})
