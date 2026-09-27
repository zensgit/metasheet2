import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'

/**
 * P2-2 — two TasksView.vue guards that `tasks-view.spec.ts` / `tasks-list-view.spec.ts` cannot
 * exercise because both mock `vue-router` with a plain, non-reactive `{ params }` object:
 *
 *   1. The `watch(taskId, ...)` — navigating between `/tasks` and `/tasks/:id` (either direction,
 *      including detail -> a DIFFERENT detail id) on the SAME component instance must (re)load the
 *      right data source (list vs. detail). This needs a REAL router: Vue only reuses one component
 *      instance across a route change when the matched record's `component` is the same reference,
 *      which a static params object can never simulate. M2's own detail-generation guard (the
 *      analogous stale-response race, scoped to `getTask`) is covered in `tasks-detail-view.spec.ts`
 *      instead, alongside the rest of the detail surface.
 *   2. The list-generation guard (`listGeneration`) — switching views while a previous view's
 *      request is still pending, then resolving the OLDER (superseded) request LAST, must not
 *      overwrite the newer view's already-rendered data.
 *
 * Mount pattern follows this repo's established real-router idiom (see
 * `approval-form-builder-route-leak.spec.ts` / `dataSourcesRouteRedirect.spec.ts`): a real
 * `createRouter`/`createMemoryHistory` with both `/tasks` and `/tasks/:id` pointed at the real
 * `TasksView.vue`, rendered through an actual `<router-view>` inside a tiny root shell.
 */

const h_ = vi.hoisted(() => ({
  loadTasksContext: vi.fn(),
  listTasks: vi.fn(),
  getTask: vi.fn(),
}))

vi.mock('../src/tasks/tasksContext', () => ({
  loadTasksContext: h_.loadTasksContext,
}))

vi.mock('../src/tasks/tasksApi', () => ({
  listTasks: h_.listTasks,
  getTask: h_.getTask,
  createTask: vi.fn(),
  completeTask: vi.fn(),
  reopenTask: vi.fn(),
}))

import TasksView from '../src/views/tasks/TasksView.vue'

function taskItem(over: Partial<{ id: string; title: string; status: 'open' | 'done' }> = {}) {
  return {
    id: 't1',
    title: 'Task',
    status: 'open' as const,
    completion_mode: 'all' as const,
    created_by: 'u1',
    due_at: null,
    ...over,
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolveFn = res
  })
  return { promise, resolve: resolveFn }
}

let app: VueApp<Element> | null = null
let container: HTMLDivElement | null = null
let router: Router | null = null

async function flush(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function mountAt(path: string): Promise<HTMLElement> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/tasks', component: TasksView },
      { path: '/tasks/:id', component: TasksView },
    ],
  })
  const RootShell = defineComponent({
    name: 'RootShell',
    render: () => h(RouterView),
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(RootShell)
  app.use(router)
  app.mount(container)
  await router.push(path)
  await router.isReady()
  await flush()
  return container
}

beforeEach(() => {
  h_.loadTasksContext.mockReset().mockResolvedValue({ state: 'ready', orgId: 'org1' })
  h_.listTasks.mockReset().mockResolvedValue({ kind: 'ok', items: [] })
  h_.getTask.mockReset().mockResolvedValue({ kind: 'not_found' })
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
  router = null
})

describe('TasksView route-id watch — real router, SAME component instance (P2-2)', () => {
  it('loads the list when navigating from /tasks/:id back to /tasks without remounting', async () => {
    const el = await mountAt('/tasks/tsk_1')
    expect(el.querySelector('[data-testid="tasks-detail-not-found"]')).toBeTruthy()
    expect(h_.getTask).toHaveBeenCalledTimes(1)
    expect(h_.getTask).toHaveBeenCalledWith('tsk_1')
    expect(h_.listTasks).not.toHaveBeenCalled()

    h_.listTasks.mockResolvedValue({ kind: 'ok', items: [taskItem({ id: 't9', title: 'Reloaded' })] })
    await router!.push('/tasks')
    await flush()

    expect(h_.listTasks).toHaveBeenCalledTimes(1)
    expect(el.textContent).toContain('Reloaded')
    expect(el.querySelector('[data-testid="tasks-detail-not-found"]')).toBeNull()
  })

  it('reloads the detail (does NOT reload the list) when navigating between two DIFFERENT /tasks/:id detail routes', async () => {
    const el = await mountAt('/tasks/tsk_1')
    await router!.push('/tasks/tsk_2')
    await flush()

    expect(h_.listTasks).not.toHaveBeenCalled()
    expect(h_.getTask).toHaveBeenCalledTimes(2)
    expect(h_.getTask).toHaveBeenNthCalledWith(1, 'tsk_1')
    expect(h_.getTask).toHaveBeenNthCalledWith(2, 'tsk_2')
    expect(el.querySelector('[data-testid="tasks-detail-not-found"]')).toBeTruthy()
  })

  it('does NOT reload the list a second time when navigating /tasks -> /tasks/:id -> /tasks (only the id->none edge reloads)', async () => {
    const el = await mountAt('/tasks')
    expect(h_.listTasks).toHaveBeenCalledTimes(1) // initial onMounted load

    await router!.push('/tasks/tsk_1')
    await flush()
    expect(h_.listTasks).toHaveBeenCalledTimes(1) // list -> detail: no new read
    expect(h_.getTask).toHaveBeenCalledTimes(1) // list -> detail: exactly one detail read
    expect(el.querySelector('[data-testid="tasks-detail-not-found"]')).toBeTruthy()

    await router!.push('/tasks')
    await flush()
    expect(h_.listTasks).toHaveBeenCalledTimes(2) // detail -> list: exactly one more read
  })
})

describe('TasksView list-generation guard — out-of-order resolution (P2-2)', () => {
  it("keeps the NEWER view's data when an OLDER, superseded request resolves LAST", async () => {
    const first = deferred<{ kind: 'ok'; items: ReturnType<typeof taskItem>[] }>()
    const second = deferred<{ kind: 'ok'; items: ReturnType<typeof taskItem>[] }>()
    h_.listTasks.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    const el = await mountAt('/tasks')
    // The initial (assigned-view) load is still pending.
    expect(el.querySelector('[data-testid="tasks-list-loading"]')).toBeTruthy()

    const followingButton = el.querySelector('[data-testid="tasks-view-switch-following"]') as HTMLButtonElement
    followingButton.click()
    await flush()
    expect(h_.listTasks).toHaveBeenCalledTimes(2)

    // Resolve the NEWER (following) request first…
    second.resolve({ kind: 'ok', items: [taskItem({ id: 'new', title: 'Following Item' })] })
    await flush()
    expect(el.textContent).toContain('Following Item')

    // …then the OLDER (assigned), superseded request resolves LAST. The generation guard must
    // discard it — without the guard, this would stomp the already-rendered newer data.
    first.resolve({ kind: 'ok', items: [taskItem({ id: 'old', title: 'Assigned Item' })] })
    await flush()

    expect(el.textContent).toContain('Following Item')
    expect(el.textContent).not.toContain('Assigned Item')
  })

  it('an older request resolving with an ERROR after a newer OK does not clobber the shown data', async () => {
    const first = deferred<{ kind: 'error'; status: number }>()
    const second = deferred<{ kind: 'ok'; items: ReturnType<typeof taskItem>[] }>()
    h_.listTasks.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    const el = await mountAt('/tasks')
    const followingButton = el.querySelector('[data-testid="tasks-view-switch-following"]') as HTMLButtonElement
    followingButton.click()
    await flush()

    second.resolve({ kind: 'ok', items: [taskItem({ id: 'new', title: 'Following Item' })] })
    await flush()
    first.resolve({ kind: 'error', status: 500 })
    await flush()

    expect(el.querySelector('[data-testid="tasks-list-error"]')).toBeNull()
    expect(el.textContent).toContain('Following Item')
  })
})
