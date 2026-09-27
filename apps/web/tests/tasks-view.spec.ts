import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'

const h = vi.hoisted(() => ({
  loadTasksContext: vi.fn(),
  listTasks: vi.fn(),
  route: { params: {} as Record<string, string> },
}))

// M2: TasksView now also reads the route (to tell `/tasks` apart from `/tasks/:id`, both of which
// load this same component per tasks-routes.spec.ts) and, for the ready + list route case, the
// tasksApi list read. Both are mocked here the same way tasksContext already is.
vi.mock('vue-router', () => ({
  useRoute: () => h.route,
}))

vi.mock('../src/tasks/tasksContext', () => ({
  loadTasksContext: h.loadTasksContext,
}))

vi.mock('../src/tasks/tasksApi', () => ({
  listTasks: h.listTasks,
  createTask: vi.fn(),
  completeTask: vi.fn(),
  reopenTask: vi.fn(),
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
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  h.loadTasksContext.mockReset()
})

const TESTIDS = [
  'tasks-view-placeholder',
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

  it('ready with a /tasks/:id route param shows the detail-not-available placeholder only, and issues no list read', async () => {
    h.route.params = { id: 'tsk_1' }
    const el = await mountWith({ state: 'ready', orgId: 'org1' })
    expect(shown(el)).toEqual(['tasks-view-placeholder'])
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
