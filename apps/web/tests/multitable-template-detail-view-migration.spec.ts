// UI-P2-1c batch5: MultitableTemplateDetailView's "检查可安装性" (check-installable / dry-run) and
// "使用模板" (install) footer actions were migrated from bespoke <button> elements to the shared MtButton
// primitive: check = ghost (was a plain #cbd5e1-bordered neutral action), install = variant="primary" (the
// bespoke #2563eb fill is an exact token match). Behavior-preservation proof: both stay a native <button>,
// keep their exact :disabled bindings (checking / installDisabled), and clicking either still runs the SAME
// handler (runDryRun / onInstall) as before.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App as VueApp, type Component } from 'vue'
import MultitableTemplateDetailView from '../src/views/MultitableTemplateDetailView.vue'
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
  sheets: [{
    id: 'tasks',
    name: 'Tasks',
    fields: [{ id: 'task', name: 'Task', type: 'string', order: 0 }],
    views: [{ id: 'grid', name: 'All Tasks', type: 'grid' }],
  }],
}

function dryRunResult(overrides: Partial<{ installable: boolean; conflicts: unknown[] }> = {}) {
  return {
    templateId: 'project-tracker',
    wouldCreate: { base: { name: 'Project Tracker Base' }, sheets: [{}], fields: [{}], views: [{}] },
    conflicts: overrides.conflicts ?? [],
    installable: overrides.installable ?? true,
  }
}

const mounted: VueApp<Element>[] = []
const containers: HTMLDivElement[] = []

function mountView() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  containers.push(container)
  const app = createApp(MultitableTemplateDetailView as Component)
  app.component('router-link', {
    props: ['to'],
    render() { return h('a', {}, this.$slots.default ? this.$slots.default() : []) },
  })
  app.mount(container)
  mounted.push(app)
  return container
}

beforeEach(() => {
  useLocale().setLocale('zh-CN')
  mocks.routeParams.templateId = 'project-tracker'
  mocks.listTemplates.mockResolvedValue({ templates: [PROJECT_TRACKER] })
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  while (containers.length) containers.pop()!.remove()
  document.body.innerHTML = ''
  useLocale().setLocale('en')
  vi.clearAllMocks()
})

describe('MultitableTemplateDetailView — MtButton migration (UI-P2-1c batch5)', () => {
  it('check-installable: renders as a native <button> (MtButton, ghost) and clicking it runs runDryRun → dryRunTemplate', async () => {
    mocks.dryRunTemplate.mockResolvedValue(dryRunResult())
    const root = mountView()
    await flushUi()

    const btn = root.querySelector<HTMLButtonElement>('[data-testid="template-detail-dryrun"]')!
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('mt-button--ghost')).toBe(true)
    expect(btn.disabled).toBe(false)

    btn.click()
    await flushUi()

    expect(mocks.dryRunTemplate).toHaveBeenCalledWith('project-tracker', { baseName: 'Project Tracker Base' })
    expect(root.querySelector('[data-testid="template-detail-dryrun-result"]')).not.toBeNull()
  })

  it('install: renders as a native <button> (MtButton, variant="primary") and clicking it runs onInstall → installTemplate + router.push', async () => {
    mocks.installTemplate.mockResolvedValue({
      base: { id: 'base_1' },
      sheets: [{ id: 'sheet_1' }],
      views: [{ id: 'view_1', sheetId: 'sheet_1' }],
    })
    const root = mountView()
    await flushUi()

    const btn = root.querySelector<HTMLButtonElement>('[data-testid="template-detail-install"]')!
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('mt-button--primary')).toBe(true)
    expect(btn.disabled).toBe(false)

    btn.click()
    await flushUi()

    expect(mocks.installTemplate).toHaveBeenCalledWith('project-tracker', { baseName: 'Project Tracker Base' })
    expect(mocks.push).toHaveBeenCalledWith(expect.objectContaining({
      params: { sheetId: 'sheet_1', viewId: 'view_1' },
      query: { baseId: 'base_1' },
    }))
  })

  it('install: :disabled tracks installDisabled — once a dry-run reports conflicts, a disabled MtButton blocks re-clicks', async () => {
    mocks.dryRunTemplate.mockResolvedValue(dryRunResult({ installable: false, conflicts: [{ kind: 'sheet', id: 's1', message: 'exists' }] }))
    const root = mountView()
    await flushUi()

    root.querySelector<HTMLButtonElement>('[data-testid="template-detail-dryrun"]')!.click()
    await flushUi()

    const installBtn = root.querySelector<HTMLButtonElement>('[data-testid="template-detail-install"]')!
    expect(installBtn.disabled).toBe(true) // installDisabled === true (conflicts present)
  })
})
