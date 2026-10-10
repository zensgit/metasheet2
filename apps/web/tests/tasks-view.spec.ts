import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'

const h = vi.hoisted(() => ({
  loadTasksContext: vi.fn(),
  listTasks: vi.fn(),
  getTask: vi.fn(),
  // M3: a detail-route mount now also reads comments and resolves the viewer's own id — neither
  // is exercised by this file's own assertions (they live in tasks-detail-m3.spec.ts), so both
  // are stubbed to harmless defaults purely so a detail-route mount does not throw.
  listComments: vi.fn(),
  getCurrentUserId: vi.fn(),
  route: { params: {} as Record<string, string> },
  router: { push: vi.fn() },
}))

// M2: TasksView now also reads the route (to tell `/tasks` apart from `/tasks/:id`, both of which
// load this same component per tasks-routes.spec.ts) and, for the ready + list route case, the
// tasksApi list read; the ready + detail route case reads `getTask` instead. All are mocked here
// the same way tasksContext already is.
// M3: `useRouter` added — TasksView's delete-task action pushes `/tasks` on success (its own
// coverage is in tasks-detail-m3.spec.ts); this file never triggers it, but the composable is
// called unconditionally at setup, so it must resolve to SOMETHING or every mount here throws.
vi.mock('vue-router', () => ({
  useRoute: () => h.route,
  useRouter: () => h.router,
}))

vi.mock('../src/tasks/tasksContext', () => ({
  loadTasksContext: h.loadTasksContext,
}))

vi.mock('../src/tasks/tasksApi', () => ({
  listTasks: h.listTasks,
  getTask: h.getTask,
  listComments: h.listComments,
  createTask: vi.fn(),
  completeTask: vi.fn(),
  reopenTask: vi.fn(),
}))

// M3: `useAuth().getCurrentUserId()` is called once a detail route is entered (own-comment /
// leave-button gating, covered in tasks-detail-m3.spec.ts). Defaults to an unresolved id here.
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({ getCurrentUserId: h.getCurrentUserId }),
}))

import TasksView from '../src/views/tasks/TasksView.vue'

let app: App | null = null
let host: HTMLElement | null = null

async function mountWith(result: unknown): Promise<HTMLElement> {
  h.loadTasksContext.mockResolvedValue(result)
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(TasksView)
  app.mount(host)
  // Two async hops now chain on mount for the ready + list-route case (context, then the list
  // read) — more cycles than the single-hop context-only states need, but harmless for those.
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
  return host
}

beforeEach(() => {
  h.route.params = {}
  h.listTasks.mockReset().mockResolvedValue({ kind: 'ok', items: [] })
  h.getTask.mockReset().mockResolvedValue({ kind: 'not_found' })
  h.listComments.mockReset().mockResolvedValue({ kind: 'ok', items: [] })
  h.getCurrentUserId.mockReset().mockResolvedValue(null)
  h.router.push.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  h.loadTasksContext.mockReset()
})

const TESTIDS = [
  'tasks-detail',
  'tasks-detail-not-found',
  'tasks-detail-forbidden',
  'tasks-detail-error',
  'tasks-detail-loading',
  'tasks-view-org-missing',
  'tasks-view-unavailable',
  'tasks-view-forbidden',
  'tasks-view-error',
  'tasks-list',
  'tasks-list-empty',
  'tasks-list-error',
] as const

function shown(el: HTMLElement): string[] {
  return TESTIDS.filter((id) => el.querySelector(`[data-testid="${id}"]`) !== null)
}

describe('TasksView renders exactly one block per context state (gates 11/12)', () => {
  it('ready with no route id shows the heading and the list state (empty here), not the detail placeholder', async () => {
    const el = await mountWith({ state: 'ready', orgId: 'org1' })
    expect(shown(el)).toEqual(['tasks-list-empty'])
    expect(el.querySelector('h1')?.textContent).toBe('任务')
  })

  it('ready with a /tasks/:id route param loads and shows the task detail, and issues no list read', async () => {
    h.route.params = { id: 'tsk_1' }
    h.getTask.mockResolvedValue({
      kind: 'ok',
      task: {
        id: 'tsk_1',
        title: 'x',
        status: 'open',
        completionMode: 'all',
        createdBy: 'u1',
        dueAt: null,
        dueDate: null,
        dueTime: null,
        timeZone: null,
        assignees: [],
        canComplete: true,
        canReopen: false,
      },
    })
    const el = await mountWith({ state: 'ready', orgId: 'org1' })
    expect(shown(el)).toEqual(['tasks-detail'])
    expect(h.getTask).toHaveBeenCalledWith('tsk_1')
    expect(h.listTasks).not.toHaveBeenCalled()
  })

  it('ready with a /tasks/:id route param shows the not-found state distinctly on a 404', async () => {
    h.route.params = { id: 'tsk_missing' }
    h.getTask.mockResolvedValue({ kind: 'not_found' })
    const el = await mountWith({ state: 'ready', orgId: 'org1' })
    expect(shown(el)).toEqual(['tasks-detail-not-found'])
    expect(h.listTasks).not.toHaveBeenCalled()
  })

  it('org_missing shows the organization prompt only', async () => {
    const el = await mountWith({ state: 'org_missing' })
    expect(shown(el)).toEqual(['tasks-view-org-missing'])
  })

  it('unavailable shows the not-enabled message, which differs from the ready render', async () => {
    const el = await mountWith({ state: 'unavailable' })
    expect(shown(el)).toEqual(['tasks-view-unavailable'])
    expect(el.textContent).toContain('任务功能未启用或当前服务不支持')
    const ready = await (async () => {
      app?.unmount()
      host?.remove()
      return mountWith({ state: 'ready', orgId: 'org1' })
    })()
    expect(ready.textContent).not.toContain('任务功能未启用或当前服务不支持')
  })

  it('forbidden shows the permission message only', async () => {
    const el = await mountWith({ state: 'forbidden' })
    expect(shown(el)).toEqual(['tasks-view-forbidden'])
  })

  it('error shows the error message only', async () => {
    const el = await mountWith({ state: 'error' })
    expect(shown(el)).toEqual(['tasks-view-error'])
  })
})
