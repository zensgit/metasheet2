import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App as VueApp } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import type {
  WorkflowDesignerPagination,
  WorkflowDesignerTemplateListItem,
  WorkflowDesignerWorkflowListItem,
  WorkflowHubTeamView,
} from '../src/views/workflowDesignerPersistence'
import type { WorkflowHubSavedView } from '../src/views/workflowHubSavedViews'
import { DEFAULT_WORKFLOW_HUB_ROUTE_STATE } from '../src/views/workflowHubQueryState'

// UF-7 (ui-foundation-design-lock-20260706.md §6) — WorkflowHubView.vue was the worst zh/en
// mixing surface in the repo: English headers/buttons/chip text ("Workflow Hub", "Save view",
// "Saved Views", raw workflow.status / workflow.role / template.source enum values) rendered
// unconditionally over Chinese descriptions and dialog copy, REGARDLESS of locale. This is the
// first mounted harness for this view. It asserts both directions — zh locale renders Chinese
// everywhere, en locale renders English everywhere — because the original bug was exactly
// one-direction-only (always mixed, never flipped).

const routeQuery: Record<string, unknown> = {}
const routerReplaceSpy = vi.fn().mockResolvedValue(undefined)
const routerPushSpy = vi.fn().mockResolvedValue(undefined)
vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRoute: () => ({ query: routeQuery }),
    useRouter: () => ({ replace: routerReplaceSpy, push: routerPushSpy }),
  }
})

const listWorkflowDraftsCachedSpy = vi.fn()
const listWorkflowTemplatesCachedSpy = vi.fn()
const invalidateWorkflowDraftCatalogCacheSpy = vi.fn()
vi.mock('../src/views/workflowDesignerCatalogCache', () => ({
  listWorkflowDraftsCached: (...args: unknown[]) => listWorkflowDraftsCachedSpy(...args),
  listWorkflowTemplatesCached: (...args: unknown[]) => listWorkflowTemplatesCachedSpy(...args),
  invalidateWorkflowDraftCatalogCache: () => invalidateWorkflowDraftCatalogCacheSpy(),
}))

const archiveWorkflowDraftSpy = vi.fn()
const restoreWorkflowDraftSpy = vi.fn()
const duplicateWorkflowDraftSpy = vi.fn()
const listWorkflowHubTeamViewsSpy = vi.fn()
const saveWorkflowHubTeamViewSpy = vi.fn()
const deleteWorkflowHubTeamViewSpy = vi.fn()
vi.mock('../src/views/workflowDesignerPersistence', () => ({
  archiveWorkflowDraft: (...args: unknown[]) => archiveWorkflowDraftSpy(...args),
  restoreWorkflowDraft: (...args: unknown[]) => restoreWorkflowDraftSpy(...args),
  duplicateWorkflowDraft: (...args: unknown[]) => duplicateWorkflowDraftSpy(...args),
  listWorkflowHubTeamViews: (...args: unknown[]) => listWorkflowHubTeamViewsSpy(...args),
  saveWorkflowHubTeamView: (...args: unknown[]) => saveWorkflowHubTeamViewSpy(...args),
  deleteWorkflowHubTeamView: (...args: unknown[]) => deleteWorkflowHubTeamViewSpy(...args),
}))

const readRecentWorkflowTemplatesSpy = vi.fn().mockReturnValue([])
vi.mock('../src/views/workflowDesignerRecentTemplates', () => ({
  readRecentWorkflowTemplates: () => readRecentWorkflowTemplatesSpy(),
}))

const readWorkflowHubSavedViewsSpy = vi.fn()
const saveWorkflowHubSavedViewSpy = vi.fn()
const deleteWorkflowHubSavedViewSpy = vi.fn()
vi.mock('../src/views/workflowHubSavedViews', () => ({
  readWorkflowHubSavedViews: () => readWorkflowHubSavedViewsSpy(),
  saveWorkflowHubSavedView: (...args: unknown[]) => saveWorkflowHubSavedViewSpy(...args),
  deleteWorkflowHubSavedView: (...args: unknown[]) => deleteWorkflowHubSavedViewSpy(...args),
}))

vi.mock('../src/views/workflowHubSessionState', () => ({
  readWorkflowHubSessionState: () => null,
  shouldRestoreWorkflowHubSessionState: () => false,
  writeWorkflowHubSessionState: () => undefined,
}))

const messageSuccessSpy = vi.fn()
vi.mock('element-plus', () => ({
  ElMessage: { success: (...a: unknown[]) => messageSuccessSpy(...a), error: vi.fn(), warning: vi.fn() },
  ElMessageBox: { prompt: vi.fn(), confirm: vi.fn() },
}))
// The view side-effect-imports EP's CSS directly (`element-plus/es/components/.../style/css`).
// Vitest's jsdom pool doesn't run these through vite's css transform for node_modules imports,
// so mount without stubbing these throws `ERR_UNKNOWN_FILE_EXTENSION` on the raw .css file —
// stub them to no-ops (this test only asserts rendered text/DOM, never visual styling).
vi.mock('element-plus/es/components/message/style/css', () => ({}))
vi.mock('element-plus/es/components/message-box/style/css', () => ({}))

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function pagination(overrides: Partial<WorkflowDesignerPagination> = {}): WorkflowDesignerPagination {
  return { total: 1, limit: 8, offset: 0, returned: 1, ...overrides }
}

function workflowItem(overrides: Partial<WorkflowDesignerWorkflowListItem> = {}): WorkflowDesignerWorkflowListItem {
  return {
    id: 'wf-1',
    name: 'Onboarding Flow',
    description: 'Handles new hires',
    category: 'HR',
    status: 'draft',
    role: 'editor',
    updatedAt: '2026-07-01T00:00:00.000Z',
    raw: {},
    ...overrides,
  }
}

function templateItem(overrides: Partial<WorkflowDesignerTemplateListItem> = {}): WorkflowDesignerTemplateListItem {
  return {
    id: 'tpl-1',
    name: 'Standard Approval',
    description: 'A generic approval template',
    category: 'General',
    requiredVariables: ['amount'],
    optionalVariables: [],
    tags: [],
    featured: false,
    source: 'builtin',
    usageCount: 3,
    updatedAt: '2026-07-01T00:00:00.000Z',
    raw: {},
    ...overrides,
  }
}

function savedView(overrides: Partial<WorkflowHubSavedView> = {}): WorkflowHubSavedView {
  return {
    id: 'view-1',
    name: 'My View',
    state: { ...DEFAULT_WORKFLOW_HUB_ROUTE_STATE },
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('WorkflowHubView — UF-7 i18n convergence (zh locale → Chinese everywhere, en locale → English everywhere)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    listWorkflowDraftsCachedSpy.mockReset().mockResolvedValue({ items: [workflowItem()], pagination: pagination() })
    listWorkflowTemplatesCachedSpy.mockReset().mockResolvedValue({ items: [templateItem()], pagination: pagination() })
    invalidateWorkflowDraftCatalogCacheSpy.mockReset()
    archiveWorkflowDraftSpy.mockReset()
    restoreWorkflowDraftSpy.mockReset()
    duplicateWorkflowDraftSpy.mockReset()
    listWorkflowHubTeamViewsSpy.mockReset().mockResolvedValue({ items: [] as WorkflowHubTeamView[] })
    saveWorkflowHubTeamViewSpy.mockReset()
    deleteWorkflowHubTeamViewSpy.mockReset()
    readRecentWorkflowTemplatesSpy.mockReset().mockReturnValue([])
    readWorkflowHubSavedViewsSpy.mockReset().mockReturnValue([savedView()])
    saveWorkflowHubSavedViewSpy.mockReset()
    deleteWorkflowHubSavedViewSpy.mockReset()
    messageSuccessSpy.mockReset()
    routerReplaceSpy.mockReset().mockResolvedValue(undefined)
    routerPushSpy.mockReset().mockResolvedValue(undefined)
    for (const key of Object.keys(routeQuery)) delete routeQuery[key]
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
  })

  async function mountView() {
    const { default: WorkflowHubView } = await import('../src/views/WorkflowHubView.vue')
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(WorkflowHubView)
    // The view's `<router-link>` usages carry :to objects only used for real navigation —
    // stub it to a plain anchor (avoids requiring a full router plugin + silences the
    // "Failed to resolve component" console noise; purely cosmetic passthrough).
    app.component('router-link', {
      props: ['to'],
      render() {
        return h('a', { 'data-router-link': 'true' }, this.$slots.default ? this.$slots.default() : [])
      },
    })
    app.mount(container)
    await flushUi()
  }

  it('renders every locale-owned string in Chinese under zh locale (no English leaks)', async () => {
    useLocale().setLocale('zh-CN')
    await mountView()
    const text = container!.textContent || ''

    expect(text).toContain('工作流中心')
    expect(text).toContain('保存视图')
    expect(text).toContain('保存团队视图')
    expect(text).toContain('刷新')
    expect(text).toContain('新建工作流')
    expect(text).toContain('已保存视图')
    expect(text).toContain('工作流草稿')
    expect(text).toContain('模板目录')
    expect(text).toContain('全部状态')
    expect(text).toContain('草稿') // status chip for the draft fixture row
    expect(text).toContain('编辑者') // role chip for the editor fixture row
    expect(text).toContain('内置') // template source chip for the builtin fixture row
    expect(text).toContain('打开')
    expect(text).toContain('复制')
    expect(text).toContain('归档')
    expect(text).toContain('上一页')
    expect(text).toContain('下一页')
    expect(text).toContain('默认工作流中心视图') // describeSavedView with no filters set

    // No leaked English chrome from the pre-fix version.
    expect(text).not.toContain('Workflow Hub')
    expect(text).not.toContain('Save view')
    expect(text).not.toContain('Saved Views')
    expect(text).not.toContain('New workflow')
  })

  it('renders every locale-owned string in English under en locale (no Chinese leaks)', async () => {
    useLocale().setLocale('en')
    await mountView()
    const text = container!.textContent || ''

    expect(text).toContain('Workflow Hub')
    expect(text).toContain('Save view')
    expect(text).toContain('Save team view')
    expect(text).toContain('Refresh')
    expect(text).toContain('New workflow')
    expect(text).toContain('Saved Views')
    expect(text).toContain('Workflow Drafts')
    expect(text).toContain('Template Catalog')
    expect(text).toContain('All status')
    expect(text).toContain('Draft') // status chip
    expect(text).toContain('Editor') // role chip
    expect(text).toContain('Builtin') // template source chip
    expect(text).toContain('Open')
    expect(text).toContain('Duplicate')
    expect(text).toContain('Archive')
    expect(text).toContain('Previous')
    expect(text).toContain('Next')
    expect(text).toContain('Default workflow hub view')

    // No leaked Chinese chrome from the pre-fix version.
    expect(text).not.toContain('工作流中心')
    expect(text).not.toContain('保存视图')
    expect(text).not.toContain('已保存视图')
    expect(text).not.toContain('新建工作流')
  })

  it('pager range label is locale-aware (not a hardcoded format)', async () => {
    listWorkflowDraftsCachedSpy.mockResolvedValue({
      items: [workflowItem()],
      pagination: pagination({ total: 12, offset: 0, returned: 8 }),
    })

    useLocale().setLocale('zh-CN')
    await mountView()
    expect(container!.textContent).toContain('1-8 / 共 12 项')
  })

  it('static tripwire: the view source contains no bare English UI-chrome literals (all copy resolves via workflowHubLabel/the chip-label helpers)', () => {
    const src = readFileSync(join(__dirname, '../src/views/WorkflowHubView.vue'), 'utf8')
    for (const leaked of ['<h1>Workflow Hub</h1>', '>Save view<', '>Saved Views<', '>New workflow<', "return '0 items'"]) {
      expect(src, `should not contain leaked literal "${leaked}"`).not.toContain(leaked)
    }
  })
})
