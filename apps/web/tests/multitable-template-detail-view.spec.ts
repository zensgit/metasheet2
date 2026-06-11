// S2-T5 — template detail view (design 20260611 §2.2): descriptor structure
// rendering, dry-run trigger + result rendering, and the conflicts→install-
// button-disable flow. NO sample-data rendering (PM-gated, G-4).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App as VueApp, type Component } from 'vue'
import MultitableTemplateDetailView from '../src/views/MultitableTemplateDetailView.vue'
import { AppRouteNames } from '../src/router/types'
import { useLocale } from '../src/composables/useLocale'

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  listTemplates: vi.fn(),
  installTemplate: vi.fn(),
  dryRunTemplate: vi.fn(),
  routeParams: { templateId: 'project-tracker' } as Record<string, string>,
}))

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: mocks.push }),
    useRoute: () => ({ params: mocks.routeParams }),
  }
})

vi.mock('../src/multitable/api/client', () => ({
  multitableClient: {
    listTemplates: mocks.listTemplates,
    installTemplate: mocks.installTemplate,
    dryRunTemplate: mocks.dryRunTemplate,
  },
}))

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const PROJECT_TRACKER = {
  id: 'project-tracker',
  name: 'Project Tracker',
  description: 'Track owners, priorities, due dates, status, and execution notes.',
  category: 'Project management',
  icon: 'kanban',
  color: '#2563eb',
  sheets: [
    {
      id: 'tasks',
      name: 'Tasks',
      description: 'Project task pipeline',
      fields: [
        { id: 'task', name: 'Task', type: 'string', order: 0 },
        { id: 'status', name: 'Status', type: 'select', order: 1, options: ['Not started', 'Done'] },
        { id: 'dueDate', name: 'Due Date', type: 'date', order: 2 },
      ],
      views: [
        { id: 'grid', name: 'All Tasks', type: 'grid' },
        { id: 'kanban', name: 'By Status', type: 'kanban', groupByFieldId: 'status' },
      ],
    },
  ],
}

function cleanDryRunResult() {
  return {
    templateId: 'project-tracker',
    wouldCreate: {
      base: { id: 'base_abc', name: 'Project Tracker Base' },
      sheets: [{ id: 'sheet_abc', name: 'Tasks', fieldCount: 3, viewCount: 2 }],
      fields: [
        { id: 'fld_1', sheetId: 'sheet_abc', name: 'Task', type: 'string' },
        { id: 'fld_2', sheetId: 'sheet_abc', name: 'Status', type: 'select' },
        { id: 'fld_3', sheetId: 'sheet_abc', name: 'Due Date', type: 'date' },
      ],
      views: [
        { id: 'view_1', sheetId: 'sheet_abc', name: 'All Tasks', type: 'grid' },
        { id: 'view_2', sheetId: 'sheet_abc', name: 'By Status', type: 'kanban' },
      ],
    },
    conflicts: [],
    installable: true,
  }
}

function conflictedDryRunResult() {
  const result = cleanDryRunResult()
  return {
    ...result,
    conflicts: [
      {
        severity: 'error',
        kind: 'sheet_exists',
        id: 'sheet_abc',
        name: 'Tasks',
        message: 'Sheet already exists: sheet_abc',
      },
    ],
    installable: false,
  }
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((node) =>
    (node.textContent?.trim() ?? '').includes(text),
  )
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`)
  }
  return button
}

describe('MultitableTemplateDetailView', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    useLocale().setLocale('zh-CN')
    mocks.routeParams.templateId = 'project-tracker'
    mocks.listTemplates.mockResolvedValue({ templates: [PROJECT_TRACKER] })
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    useLocale().setLocale('en')
    vi.clearAllMocks()
  })

  function mountView() {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(MultitableTemplateDetailView as Component)
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

  it('renders the descriptor structure: sheet, field table (name/type), views with group-by field', async () => {
    const root = mountView()
    await flushUi()

    expect(mocks.listTemplates).toHaveBeenCalledTimes(1)
    expect(root.textContent).toContain('Project Tracker')
    expect(root.textContent).toContain('Tasks')

    const fieldRows = Array.from(root.querySelectorAll('[data-testid="template-detail-fields"] tbody tr'))
    expect(fieldRows.map((row) =>
      Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent?.trim()).join(' | '),
    )).toEqual([
      'Task | string',
      'Status | select',
      'Due Date | date',
    ])

    const viewItems = Array.from(root.querySelectorAll('[data-testid="template-detail-views"] li'))
    expect(viewItems).toHaveLength(2)
    expect(viewItems[0].textContent).toContain('All Tasks')
    expect(viewItems[0].textContent).toContain('grid')
    expect(viewItems[1].textContent).toContain('By Status')
    // groupByFieldId resolved to the field NAME, not the raw id.
    expect(viewItems[1].textContent).toContain('Status')

    // No dry-run result before the user asks for one.
    expect(root.querySelector('[data-testid="template-detail-dryrun-result"]')).toBeNull()
    // Install stays enabled until a dry-run reports conflicts.
    expect(findButton(root, '使用模板').disabled).toBe(false)
  })

  it('shows a not-found state for an unknown templateId', async () => {
    mocks.routeParams.templateId = 'no-such-template'
    const root = mountView()
    await flushUi()

    expect(root.textContent).toContain('未找到该模板')
  })

  it('检查可安装性 runs the dry-run and renders the wouldCreate summary (installable)', async () => {
    mocks.dryRunTemplate.mockResolvedValue(cleanDryRunResult())
    const root = mountView()
    await flushUi()

    findButton(root, '检查可安装性').click()
    await flushUi()

    expect(mocks.dryRunTemplate).toHaveBeenCalledWith('project-tracker', { baseName: 'Project Tracker Base' })
    const result = root.querySelector('[data-testid="template-detail-dryrun-result"]')
    expect(result).not.toBeNull()
    expect(result?.textContent).toContain('可以安装')
    expect(result?.textContent).toContain('Project Tracker Base')
    expect(result?.textContent).toContain('1 个 Sheet')
    expect(result?.textContent).toContain('3 个字段')
    expect(result?.textContent).toContain('2 个视图')
    expect(root.querySelector('[data-testid="template-detail-conflicts"]')).toBeNull()
    expect(findButton(root, '使用模板').disabled).toBe(false)
  })

  it('conflicts disable the install button and show the re-check hint', async () => {
    mocks.dryRunTemplate.mockResolvedValue(conflictedDryRunResult())
    const root = mountView()
    await flushUi()

    findButton(root, '检查可安装性').click()
    await flushUi()

    expect(root.textContent).toContain('检测到冲突')
    const conflictItems = Array.from(root.querySelectorAll('[data-testid="template-detail-conflicts"] li'))
    expect(conflictItems).toHaveLength(1)
    expect(conflictItems[0].textContent).toContain('Sheet 已存在')
    expect(conflictItems[0].textContent).toContain('Sheet already exists: sheet_abc')
    // Review 2026-06-11 F4: truthful copy — must NOT suggest changing the
    // base name (baseName never enters id derivation; no such input exists).
    const hint = root.querySelector('[data-testid="template-detail-conflict-hint"]')?.textContent ?? ''
    expect(hint).toContain('安装前请重新检查')
    expect(hint).not.toContain('Base 名称')
    expect(findButton(root, '使用模板').disabled).toBe(true)
  })

  it('dry-run failure surfaces an error and leaves install enabled', async () => {
    mocks.dryRunTemplate.mockRejectedValue(new Error('boom-dry-run'))
    const root = mountView()
    await flushUi()

    findButton(root, '检查可安装性').click()
    await flushUi()

    expect(root.textContent).toContain('boom-dry-run')
    expect(root.querySelector('[data-testid="template-detail-dryrun-result"]')).toBeNull()
    expect(findButton(root, '使用模板').disabled).toBe(false)
  })

  it('install reuses useTemplateInstall: installs and navigates to the new base', async () => {
    mocks.installTemplate.mockResolvedValue({
      template: { id: 'project-tracker', name: 'Project Tracker' },
      base: { id: 'base_new', name: 'Project Tracker Base' },
      sheets: [{ id: 'sheet_new', baseId: 'base_new', name: 'Tasks' }],
      fields: [],
      views: [{ id: 'view_new', sheetId: 'sheet_new', name: 'Grid', type: 'grid' }],
    })
    const root = mountView()
    await flushUi()

    findButton(root, '使用模板').click()
    await flushUi()

    expect(mocks.installTemplate).toHaveBeenCalledWith('project-tracker', { baseName: 'Project Tracker Base' })
    expect(mocks.push).toHaveBeenCalledWith({
      name: AppRouteNames.MULTITABLE,
      params: { sheetId: 'sheet_new', viewId: 'view_new' },
      query: { baseId: 'base_new' },
    })
  })

  it('load failure shows the error message', async () => {
    mocks.listTemplates.mockRejectedValue(new Error('网络断了'))
    const root = mountView()
    await flushUi()

    expect(root.textContent).toContain('网络断了')
  })

  it('hero shows a link back to the template center', async () => {
    const root = mountView()
    await flushUi()

    const backLink = root.querySelector<HTMLElement>('.multitable-template-detail__back')
    expect(backLink).not.toBeNull()
    expect(backLink?.getAttribute('data-router-link-to')).toContain(AppRouteNames.MULTITABLE_TEMPLATES)
  })
})
