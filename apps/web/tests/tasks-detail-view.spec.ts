import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'

/**
 * M2 frontend — `/tasks/:id` detail surface (backend PR #6062, `GET /api/tasks/:id`).
 *
 * Mounted through a REAL router (same idiom as `tasks-view-transitions.spec.ts`), not a mocked
 * `useRoute()` stub: the id-change / stale-response guards below need Vue to reuse the SAME
 * `TasksView.vue` instance across a route change, which a static params object cannot simulate.
 * `getTask`/`completeTask`/`reopenTask`/`listTasks`/`createTask` and `notifyTasksChanged` are the
 * only things mocked — everything else (router, component) is real.
 */

const h_ = vi.hoisted(() => ({
  loadTasksContext: vi.fn(),
  getTask: vi.fn(),
  listTasks: vi.fn(),
  createTask: vi.fn(),
  completeTask: vi.fn(),
  reopenTask: vi.fn(),
  notifyTasksChanged: vi.fn(),
  // M3: every detail mount now also reads comments and resolves the viewer's own id. This file's
  // own M2 assertions do not exercise either — that surface lives in tasks-detail-m3.spec.ts —
  // so both are stubbed to harmless defaults purely so a detail mount does not throw.
  listComments: vi.fn(),
  getCurrentUserId: vi.fn(),
}))

vi.mock('../src/tasks/tasksContext', () => ({
  loadTasksContext: h_.loadTasksContext,
}))

vi.mock('../src/tasks/tasksApi', () => ({
  getTask: h_.getTask,
  listTasks: h_.listTasks,
  createTask: h_.createTask,
  completeTask: h_.completeTask,
  reopenTask: h_.reopenTask,
  listComments: h_.listComments,
}))

vi.mock('../src/tasks/tasksBadgeBus', () => ({
  notifyTasksChanged: h_.notifyTasksChanged,
}))

// M3: `useAuth().getCurrentUserId()` is called once a detail route is entered (own-comment /
// leave-button gating, covered in tasks-detail-m3.spec.ts). Defaults to an unresolved id here —
// this file mounts a REAL router, so `useRouter` needs no mock (unlike tasks-view.spec.ts /
// tasks-list-view.spec.ts, which stub `vue-router` entirely).
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({ getCurrentUserId: h_.getCurrentUserId }),
}))

import TasksView from '../src/views/tasks/TasksView.vue'
import { formatDueDisplay, formatViewerInstant } from '../src/tasks/tasksDateDisplay'

interface TaskDetailFixture {
  id: string
  title: string
  status: 'open' | 'done'
  completionMode: 'all' | 'any'
  createdBy: string
  dueAt: string | null
  dueDate: string | null
  dueTime: string | null
  timeZone: string | null
  assignees: { userId: string; completedAt: string | null }[]
  canComplete: boolean
  canReopen: boolean
}

function taskDetail(over: Partial<TaskDetailFixture> = {}): TaskDetailFixture {
  return {
    id: 't1',
    title: 'Task One',
    status: 'open',
    completionMode: 'all',
    createdBy: 'u1',
    dueAt: null,
    dueDate: null,
    dueTime: null,
    timeZone: null,
    assignees: [],
    canComplete: true,
    canReopen: true,
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

function shown(el: HTMLElement, testid: string): HTMLElement | null {
  return el.querySelector(`[data-testid="${testid}"]`)
}

beforeEach(() => {
  h_.loadTasksContext.mockReset().mockResolvedValue({ state: 'ready', orgId: 'org1' })
  h_.getTask.mockReset().mockResolvedValue({ kind: 'ok', task: taskDetail() })
  h_.listTasks.mockReset().mockResolvedValue({ kind: 'ok', items: [] })
  h_.createTask.mockReset()
  h_.completeTask.mockReset()
  h_.reopenTask.mockReset()
  h_.notifyTasksChanged.mockReset()
  h_.listComments.mockReset().mockResolvedValue({ kind: 'ok', items: [] })
  h_.getCurrentUserId.mockReset().mockResolvedValue(null)
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
  router = null
})

describe('TasksView detail — render states', () => {
  it('shows the loading state before getTask resolves, then the detail on resolution', async () => {
    const pending = deferred<{ kind: 'ok'; task: TaskDetailFixture }>()
    h_.getTask.mockReturnValue(pending.promise)

    const el = await mountAt('/tasks/t1')
    expect(shown(el, 'tasks-detail-loading')).toBeTruthy()
    expect(shown(el, 'tasks-detail')).toBeNull()

    pending.resolve({ kind: 'ok', task: taskDetail() })
    await flush()

    expect(shown(el, 'tasks-detail-loading')).toBeNull()
    expect(shown(el, 'tasks-detail')).toBeTruthy()
  })

  it('renders title, status, completion mode and each assignee completedAt state for the ok result', async () => {
    h_.getTask.mockResolvedValue({
      kind: 'ok',
      task: taskDetail({
        title: 'Ship the release',
        status: 'done',
        completionMode: 'any',
        assignees: [
          { userId: 'u1', completedAt: '2026-09-20T10:00:00Z' },
          { userId: 'u2', completedAt: null },
        ],
      }),
    })
    const el = await mountAt('/tasks/t1')

    expect(shown(el, 'tasks-detail-title')?.textContent).toBe('Ship the release')
    expect(shown(el, 'tasks-detail-status')?.textContent).toBe('已完成')
    expect(shown(el, 'tasks-detail-completion-mode')?.textContent).toBe('任一负责人完成')

    const assigneeRows = el.querySelectorAll('[data-testid="tasks-detail-assignee"]')
    expect(assigneeRows).toHaveLength(2)
    expect(assigneeRows[0].textContent).toContain('u1')
    // P3-3: viewer-local, not the raw ISO instant the wire sends.
    expect(assigneeRows[0].textContent).toContain(`已完成于 ${formatViewerInstant('2026-09-20T10:00:00Z')}`)
    expect(assigneeRows[0].textContent).not.toContain('2026-09-20T10:00:00Z')
    expect(assigneeRows[1].textContent).toContain('u2')
    expect(assigneeRows[1].textContent).toContain('未完成')
  })

  it('renders not-found and error as DISTINCT states (different testid, different text)', async () => {
    h_.getTask.mockResolvedValue({ kind: 'not_found' })
    const notFoundEl = await mountAt('/tasks/missing')
    const notFoundNode = shown(notFoundEl, 'tasks-detail-not-found')
    expect(notFoundNode).toBeTruthy()
    expect(shown(notFoundEl, 'tasks-detail-error')).toBeNull()

    app?.unmount()
    container?.remove()

    h_.getTask.mockResolvedValue({ kind: 'error', status: 500 })
    const errorEl = await mountAt('/tasks/broken')
    const errorNode = shown(errorEl, 'tasks-detail-error')
    expect(errorNode).toBeTruthy()
    expect(shown(errorEl, 'tasks-detail-not-found')).toBeNull()

    expect(errorNode?.textContent).not.toBe(notFoundNode?.textContent)
  })

  it('renders forbidden distinctly from both not-found and error', async () => {
    h_.getTask.mockResolvedValue({ kind: 'forbidden' })
    const el = await mountAt('/tasks/t1')
    expect(shown(el, 'tasks-detail-forbidden')).toBeTruthy()
    expect(shown(el, 'tasks-detail-not-found')).toBeNull()
    expect(shown(el, 'tasks-detail-error')).toBeNull()
  })

  it('has a back link to /tasks (real router-rendered <a href>, not just a truthy attribute)', async () => {
    const el = await mountAt('/tasks/t1')
    const link = shown(el, 'tasks-detail-back-link')
    expect(link?.tagName).toBe('A')
    expect(link?.getAttribute('href')).toBe('/tasks')
  })
})

describe('TasksView detail — complete/reopen buttons are STATUS-gated, not just role-gated', () => {
  it('shows complete only when status is open AND canComplete is true', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ status: 'open', canComplete: true }) })
    const el = await mountAt('/tasks/t1')
    expect(shown(el, 'tasks-detail-complete-button')).toBeTruthy()
  })

  it('hides complete when status is DONE even though canComplete is true (role alone is not enough)', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ status: 'done', canComplete: true, canReopen: false }) })
    const el = await mountAt('/tasks/t1')
    expect(shown(el, 'tasks-detail-complete-button')).toBeNull()
  })

  it('hides complete when canComplete is false even though status is open', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ status: 'open', canComplete: false }) })
    const el = await mountAt('/tasks/t1')
    expect(shown(el, 'tasks-detail-complete-button')).toBeNull()
  })

  it('shows reopen only when status is done AND canReopen is true', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ status: 'done', canReopen: true }) })
    const el = await mountAt('/tasks/t1')
    expect(shown(el, 'tasks-detail-reopen-button')).toBeTruthy()
  })

  it('hides reopen when status is OPEN even though canReopen is true', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ status: 'open', canReopen: true, canComplete: false }) })
    const el = await mountAt('/tasks/t1')
    expect(shown(el, 'tasks-detail-reopen-button')).toBeNull()
  })

  it('hides reopen when canReopen is false even though status is done', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ status: 'done', canReopen: false }) })
    const el = await mountAt('/tasks/t1')
    expect(shown(el, 'tasks-detail-reopen-button')).toBeNull()
  })
})

describe('TasksView detail — due display (all-day vs timed)', () => {
  it('shows dueAt viewer-local (not the raw ISO instant) for a TIMED task, even when dueDate/dueTime are also present (P3-3)', async () => {
    h_.getTask.mockResolvedValue({
      kind: 'ok',
      task: taskDetail({
        dueAt: '2026-10-01T09:00:00Z',
        dueDate: '2026-09-30',
        dueTime: '08:00:00',
        timeZone: 'Asia/Shanghai',
      }),
    })
    const el = await mountAt('/tasks/t1')
    const due = shown(el, 'tasks-detail-due')
    expect(due?.textContent).toBe(formatViewerInstant('2026-10-01T09:00:00Z'))
    expect(due?.textContent).not.toBe('2026-10-01T09:00:00Z')
    expect(due?.textContent).not.toContain('2026-09-30')
  })

  it('shows dueDate + timeZone for an ALL-DAY task with no dueTime (dueAt null)', async () => {
    h_.getTask.mockResolvedValue({
      kind: 'ok',
      task: taskDetail({ dueAt: null, dueDate: '2026-10-05', dueTime: null, timeZone: 'Asia/Shanghai' }),
    })
    const el = await mountAt('/tasks/t1')
    const due = shown(el, 'tasks-detail-due')
    expect(due?.textContent).toBe('2026-10-05（Asia/Shanghai）')
  })

  // P3-3: `dueTime` used to be silently dropped whenever `dueAt` was null, even though the backend
  // sent it alongside `dueDate` — the viewer had no way to see WHEN on the due date the task was
  // actually due, only which day.
  it('shows dueDate + dueTime + timeZone for an ALL-DAY task that also carries a dueTime (dueAt null)', async () => {
    h_.getTask.mockResolvedValue({
      kind: 'ok',
      task: taskDetail({ dueAt: null, dueDate: '2026-10-05', dueTime: '08:30:00', timeZone: 'Asia/Shanghai' }),
    })
    const el = await mountAt('/tasks/t1')
    const due = shown(el, 'tasks-detail-due')
    expect(due?.textContent).toBe('2026-10-05 08:30（Asia/Shanghai）')
  })

  it('shows a "no due date" placeholder when both dueAt and dueDate are null', async () => {
    h_.getTask.mockResolvedValue({
      kind: 'ok',
      task: taskDetail({ dueAt: null, dueDate: null, dueTime: null, timeZone: null }),
    })
    const el = await mountAt('/tasks/t1')
    expect(shown(el, 'tasks-detail-due')?.textContent).toBe('无截止日期')
  })
})

// P3-3: `formatViewerInstant`/`formatDueDisplay` unit-tested directly against a FIXED instant
// under a FIXED, explicitly-passed `timeZone` — deterministic regardless of the host machine's own
// zone (production call sites never pass `timeZone`; it exists on the function only for this).
describe('tasksDateDisplay — viewer-local formatting for a fixed instant under a fixed TZ (P3-3)', () => {
  it('formats an absolute instant zh-CN medium/short, 24h, for an explicit timeZone', () => {
    expect(formatViewerInstant('2026-10-01T09:30:00Z', 'Asia/Shanghai')).toBe('2026年10月1日 17:30')
    expect(formatViewerInstant('2026-10-01T09:30:00Z', 'America/New_York')).toBe('2026年10月1日 05:30')
  })

  it('formatDueDisplay uses the viewer-local instant for a TIMED task (dueAt present), ignoring dueDate/dueTime', () => {
    expect(
      formatDueDisplay({ dueAt: '2026-10-01T09:30:00Z', dueDate: '2026-09-30', dueTime: '08:00:00', timeZone: null }),
    ).toBe(formatViewerInstant('2026-10-01T09:30:00Z'))
  })

  it('formatDueDisplay joins dueDate + dueTime (HH:MM) + timeZone for an ALL-DAY task with a time (dueAt null)', () => {
    expect(
      formatDueDisplay({ dueAt: null, dueDate: '2026-10-05', dueTime: '08:30:00', timeZone: 'Asia/Shanghai' }),
    ).toBe('2026-10-05 08:30（Asia/Shanghai）')
  })

  it('formatDueDisplay shows just dueDate + timeZone when dueTime is absent', () => {
    expect(
      formatDueDisplay({ dueAt: null, dueDate: '2026-10-05', dueTime: null, timeZone: 'Asia/Shanghai' }),
    ).toBe('2026-10-05（Asia/Shanghai）')
  })

  it('formatDueDisplay falls back to the placeholder when nothing is set', () => {
    expect(formatDueDisplay({ dueAt: null, dueDate: null, dueTime: null, timeZone: null })).toBe('无截止日期')
  })
})

describe('TasksView detail — complete/reopen actions', () => {
  it('a successful complete reloads the detail (getTask called again) and notifies the badge bus', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ status: 'open', canComplete: true }) })
    h_.completeTask.mockResolvedValue({ kind: 'ok', done: true })
    const el = await mountAt('/tasks/t1')
    expect(h_.getTask).toHaveBeenCalledTimes(1)

    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ status: 'done', canReopen: true }) })
    ;(shown(el, 'tasks-detail-complete-button') as HTMLButtonElement).click()
    await flush()

    expect(h_.completeTask).toHaveBeenCalledWith('t1')
    expect(h_.getTask).toHaveBeenCalledTimes(2)
    expect(h_.notifyTasksChanged).toHaveBeenCalledTimes(1)
    expect(shown(el, 'tasks-detail-status')?.textContent).toBe('已完成')
  })

  it('a successful reopen sends scope "self", reloads the detail, and notifies the badge bus', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ status: 'done', canReopen: true }) })
    h_.reopenTask.mockResolvedValue({ kind: 'ok' })
    const el = await mountAt('/tasks/t1')

    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ status: 'open', canComplete: true }) })
    ;(shown(el, 'tasks-detail-reopen-button') as HTMLButtonElement).click()
    await flush()

    expect(h_.reopenTask).toHaveBeenCalledWith('t1', 'self')
    expect(h_.getTask).toHaveBeenCalledTimes(2)
    expect(h_.notifyTasksChanged).toHaveBeenCalledTimes(1)
  })

  it('a forbidden action result shows tasks-action-error with the permission message and does NOT reload', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ status: 'open', canComplete: true }) })
    h_.completeTask.mockResolvedValue({ kind: 'forbidden' })
    const el = await mountAt('/tasks/t1')

    ;(shown(el, 'tasks-detail-complete-button') as HTMLButtonElement).click()
    await flush()

    expect(shown(el, 'tasks-action-error')?.textContent).toBe('您没有权限修改此任务')
    expect(h_.getTask).toHaveBeenCalledTimes(1)
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
  })

  it('a generic-error action result shows tasks-action-error with the generic message', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ status: 'open', canComplete: true }) })
    h_.completeTask.mockResolvedValue({ kind: 'error', status: 500 })
    const el = await mountAt('/tasks/t1')

    ;(shown(el, 'tasks-detail-complete-button') as HTMLButtonElement).click()
    await flush()

    expect(shown(el, 'tasks-action-error')?.textContent).toBe('操作失败，请稍后重试')
  })

  it('an org_missing (422) action result replaces the detail with the org-guidance block', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ status: 'open', canComplete: true }) })
    h_.completeTask.mockResolvedValue({ kind: 'org_missing' })
    const el = await mountAt('/tasks/t1')

    ;(shown(el, 'tasks-detail-complete-button') as HTMLButtonElement).click()
    await flush()

    expect(shown(el, 'tasks-view-org-missing')).toBeTruthy()
    expect(shown(el, 'tasks-detail')).toBeNull()
  })

  // P3-1: the complete-side negative paths above (forbidden / error / org_missing) were tested;
  // the reopen side of the SAME `applyActionOutcome` call sites (~:415/onDetailReopen) was not.
  it('a forbidden REOPEN result shows tasks-action-error with the permission message and does NOT reload', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ status: 'done', canReopen: true }) })
    h_.reopenTask.mockResolvedValue({ kind: 'forbidden' })
    const el = await mountAt('/tasks/t1')

    ;(shown(el, 'tasks-detail-reopen-button') as HTMLButtonElement).click()
    await flush()

    expect(shown(el, 'tasks-action-error')?.textContent).toBe('您没有权限修改此任务')
    expect(h_.getTask).toHaveBeenCalledTimes(1)
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
  })

  it('a generic-error REOPEN result shows tasks-action-error with the generic message', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ status: 'done', canReopen: true }) })
    h_.reopenTask.mockResolvedValue({ kind: 'error', status: 500 })
    const el = await mountAt('/tasks/t1')

    ;(shown(el, 'tasks-detail-reopen-button') as HTMLButtonElement).click()
    await flush()

    expect(shown(el, 'tasks-action-error')?.textContent).toBe('操作失败，请稍后重试')
  })

  it('an org_missing (422) REOPEN result replaces the detail with the org-guidance block', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ status: 'done', canReopen: true }) })
    h_.reopenTask.mockResolvedValue({ kind: 'org_missing' })
    const el = await mountAt('/tasks/t1')

    ;(shown(el, 'tasks-detail-reopen-button') as HTMLButtonElement).click()
    await flush()

    expect(shown(el, 'tasks-view-org-missing')).toBeTruthy()
    expect(shown(el, 'tasks-detail')).toBeNull()
  })
})

// P2-2: `actionErrorKind` is reset at the START of each detail action (complete, reopen) and in
// the id watch; a successful `applyActionOutcome('ok')` does NOT touch it. Each is its own guard;
// each gets its own test below. The M3 detail actions clear it at their own start as well — those
// clears are pinned in tasks-detail-m3.spec.ts.
describe('TasksView detail — actionError resets (P2-2)', () => {
  it('a failed complete, then a successful retry, clears the "操作失败" banner', async () => {
    h_.getTask.mockImplementation(async (id: string) =>
      ({ kind: 'ok', task: taskDetail({ id, status: 'open', canComplete: true }) }))
    h_.completeTask
      .mockResolvedValueOnce({ kind: 'error', status: 500 })
      .mockResolvedValueOnce({ kind: 'ok', done: true })
    const el = await mountAt('/tasks/t1')

    ;(shown(el, 'tasks-detail-complete-button') as HTMLButtonElement).click()
    await flush()
    expect(shown(el, 'tasks-action-error')?.textContent).toBe('操作失败，请稍后重试')

    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ id: 't1', status: 'done', canReopen: true }) })
    ;(shown(el, 'tasks-detail-complete-button') as HTMLButtonElement).click()
    await flush()

    expect(shown(el, 'tasks-action-error')).toBeNull()
  })

  it('a failed reopen, then a successful retry, clears the "操作失败" banner', async () => {
    h_.getTask.mockImplementation(async (id: string) =>
      ({ kind: 'ok', task: taskDetail({ id, status: 'done', canReopen: true }) }))
    h_.reopenTask
      .mockResolvedValueOnce({ kind: 'error', status: 500 })
      .mockResolvedValueOnce({ kind: 'ok' })
    const el = await mountAt('/tasks/t1')

    ;(shown(el, 'tasks-detail-reopen-button') as HTMLButtonElement).click()
    await flush()
    expect(shown(el, 'tasks-action-error')?.textContent).toBe('操作失败，请稍后重试')

    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ id: 't1', status: 'open', canComplete: true }) })
    ;(shown(el, 'tasks-detail-reopen-button') as HTMLButtonElement).click()
    await flush()

    expect(shown(el, 'tasks-action-error')).toBeNull()
  })

  it('a SETTLED 403 on t1, then navigating to t2, clears the permission banner (id-watch reset)', async () => {
    h_.getTask.mockImplementation(async (id: string) =>
      ({ kind: 'ok', task: taskDetail({ id, title: `Title-${id}`, status: 'open', canComplete: true }) }))
    h_.completeTask.mockResolvedValue({ kind: 'forbidden' })
    const el = await mountAt('/tasks/t1')

    ;(shown(el, 'tasks-detail-complete-button') as HTMLButtonElement).click()
    await flush()
    expect(shown(el, 'tasks-action-error')?.textContent).toBe('您没有权限修改此任务')

    await router!.push('/tasks/t2')
    await flush()

    expect(shown(el, 'tasks-action-error')).toBeNull()
  })
})

// P2-1 / P3-2: `onDetailComplete`/`onDetailReopen` check `taskId.value !== id` AFTER the await —
// BEFORE applying the result via `applyActionOutcome` (P3-2's fix: that check used to run only
// around the reload, so a stale result's banner/guidance still leaked onto wherever the viewer had
// since navigated). Each scenario below is a distinct way for that single guard to matter.
describe('TasksView detail — navigate-away while a complete/reopen request is pending (P2-1 / P3-2)', () => {
  it('completing t1 while navigating to t2: a late ok keeps t2 shown, notifies the badge, and the next click targets t2', async () => {
    const pendingComplete = deferred<{ kind: 'ok'; done: boolean }>()
    h_.getTask.mockImplementation(async (id: string) =>
      ({ kind: 'ok', task: taskDetail({ id, title: `Title-${id}`, status: 'open', canComplete: true }) }))
    h_.completeTask.mockReturnValueOnce(pendingComplete.promise).mockResolvedValue({ kind: 'ok', done: true })
    const el = await mountAt('/tasks/t1')

    ;(shown(el, 'tasks-detail-complete-button') as HTMLButtonElement).click()
    await flush()
    await router!.push('/tasks/t2')
    await flush()
    expect(shown(el, 'tasks-detail-title')?.textContent).toBe('Title-t2')

    pendingComplete.resolve({ kind: 'ok', done: true })
    await flush()

    // Still t2 — a mutant that drops the pre-`applyActionOutcome` id check would reload id 't1'
    // here (the ONLY thing that could paint 'Title-t1' back over the screen) and clobber this.
    expect(shown(el, 'tasks-detail-title')?.textContent).toBe('Title-t2')
    expect(el.textContent).not.toContain('Title-t1')
    // A late 'ok' still happened server-side — the shared badge bus must still hear about it once
    // (P3-2's fix keeps this call; it just skips the banner/reload).
    expect(h_.notifyTasksChanged).toHaveBeenCalledTimes(1)

    ;(shown(el, 'tasks-detail-complete-button') as HTMLButtonElement | null)?.click()
    await flush()
    expect(h_.completeTask).toHaveBeenLastCalledWith('t2')
  })

  it('reopening t1 while navigating to t2: a late ok keeps t2 shown, and the next click targets t2', async () => {
    const pendingReopen = deferred<{ kind: 'ok' }>()
    h_.getTask.mockImplementation(async (id: string) =>
      ({ kind: 'ok', task: taskDetail({ id, title: `Title-${id}`, status: 'done', canReopen: true }) }))
    h_.reopenTask.mockReturnValueOnce(pendingReopen.promise).mockResolvedValue({ kind: 'ok' })
    const el = await mountAt('/tasks/t1')

    ;(shown(el, 'tasks-detail-reopen-button') as HTMLButtonElement).click()
    await flush()
    await router!.push('/tasks/t2')
    await flush()
    expect(shown(el, 'tasks-detail-title')?.textContent).toBe('Title-t2')

    pendingReopen.resolve({ kind: 'ok' })
    await flush()

    expect(shown(el, 'tasks-detail-title')?.textContent).toBe('Title-t2')
    expect(el.textContent).not.toContain('Title-t1')

    // Same as the complete case above: the mutation happened server-side, so the badge still
    // needs to hear about it even though nothing else about this outcome is applied.
    expect(h_.notifyTasksChanged).toHaveBeenCalledTimes(1)

    ;(shown(el, 'tasks-detail-reopen-button') as HTMLButtonElement | null)?.click()
    await flush()
    expect(h_.reopenTask).toHaveBeenLastCalledWith('t2', 'self')
  })

  it.each([
    ['forbidden', { kind: 'forbidden' as const }],
    ['error', { kind: 'error' as const, status: 500 }],
    ['org_missing', { kind: 'org_missing' as const }],
  ])('a PENDING %s from t1 that settles AFTER navigating to t2 shows NO banner/guidance on t2', async (_label, result) => {
    const pendingComplete = deferred<typeof result>()
    h_.getTask.mockImplementation(async (id: string) =>
      ({ kind: 'ok', task: taskDetail({ id, title: `Title-${id}`, status: 'open', canComplete: true }) }))
    h_.completeTask.mockReturnValueOnce(pendingComplete.promise)
    const el = await mountAt('/tasks/t1')

    ;(shown(el, 'tasks-detail-complete-button') as HTMLButtonElement).click()
    await flush()
    await router!.push('/tasks/t2')
    await flush()

    pendingComplete.resolve(result)
    await flush()

    expect(shown(el, 'tasks-action-error')).toBeNull()
    expect(shown(el, 'tasks-view-org-missing')).toBeNull()
    expect(shown(el, 'tasks-detail-title')?.textContent).toBe('Title-t2')
  })

  it('a PENDING error from a detail action that settles AFTER navigating BACK to the list shows NO banner on the list', async () => {
    const pendingComplete = deferred<{ kind: 'error'; status: number }>()
    h_.completeTask.mockReturnValueOnce(pendingComplete.promise)
    h_.listTasks.mockResolvedValue({
      kind: 'ok',
      items: [{ id: 't9', title: 'Row', status: 'open', completion_mode: 'all', created_by: 'u1', due_at: null }],
    })
    const el = await mountAt('/tasks/t1')

    ;(shown(el, 'tasks-detail-complete-button') as HTMLButtonElement).click()
    await flush()
    await router!.push('/tasks')
    await flush()

    pendingComplete.resolve({ kind: 'error', status: 500 })
    await flush()

    expect(shown(el, 'tasks-action-error')).toBeNull()
    expect(shown(el, 'tasks-list')).toBeTruthy()
  })
})

// NIT: a request in flight disables the SAME action's own button so a second click can't fire a
// second overlapping request.
describe('TasksView detail — action buttons disabled while a request is in flight (NIT)', () => {
  it('disables the complete button while completeTask is pending, and re-enables once it settles', async () => {
    const pendingComplete = deferred<{ kind: 'ok'; done: boolean }>()
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ status: 'open', canComplete: true }) })
    h_.completeTask.mockReturnValue(pendingComplete.promise)
    const el = await mountAt('/tasks/t1')

    const button = shown(el, 'tasks-detail-complete-button') as HTMLButtonElement
    expect(button.disabled).toBe(false)

    button.click()
    await flush()
    expect(button.disabled).toBe(true)

    // A second click while disabled must not fire a second request — asserted via call count
    // rather than relying on jsdom to suppress a programmatic `.click()` on a disabled control.
    button.click()
    await flush()
    expect(h_.completeTask).toHaveBeenCalledTimes(1)

    pendingComplete.resolve({ kind: 'ok', done: true })
    await flush()
    expect((shown(el, 'tasks-detail-complete-button') as HTMLButtonElement | null)?.disabled).toBe(false)
  })

  it('disables the reopen button while reopenTask is pending, and re-enables once it settles', async () => {
    const pendingReopen = deferred<{ kind: 'ok' }>()
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ status: 'done', canReopen: true }) })
    h_.reopenTask.mockReturnValue(pendingReopen.promise)
    const el = await mountAt('/tasks/t1')

    const button = shown(el, 'tasks-detail-reopen-button') as HTMLButtonElement
    expect(button.disabled).toBe(false)

    button.click()
    await flush()
    expect(button.disabled).toBe(true)

    button.click()
    await flush()
    expect(h_.reopenTask).toHaveBeenCalledTimes(1)

    pendingReopen.resolve({ kind: 'ok' })
    await flush()
    expect((shown(el, 'tasks-detail-reopen-button') as HTMLButtonElement | null)?.disabled).toBe(false)
  })
})

describe('TasksView detail — id change on the SAME component instance (real router)', () => {
  it('calls getTask again with the new id when navigating between two different /tasks/:id routes', async () => {
    h_.getTask.mockImplementation(async (id: string) => ({ kind: 'ok', task: taskDetail({ id, title: `Task ${id}` }) }))

    const el = await mountAt('/tasks/tsk_a')
    expect(el.textContent).toContain('Task tsk_a')
    expect(h_.getTask).toHaveBeenCalledTimes(1)

    await router!.push('/tasks/tsk_b')
    await flush()

    expect(h_.getTask).toHaveBeenCalledTimes(2)
    expect(h_.getTask).toHaveBeenNthCalledWith(2, 'tsk_b')
    expect(el.textContent).toContain('Task tsk_b')
    expect(el.textContent).not.toContain('Task tsk_a')
  })

  it("keeps the NEWER id's detail when an OLDER id's getTask resolves LAST (stale-response guard)", async () => {
    const first = deferred<{ kind: 'ok'; task: TaskDetailFixture }>()
    const second = deferred<{ kind: 'ok'; task: TaskDetailFixture }>()
    h_.getTask.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    const el = await mountAt('/tasks/tsk_a')
    expect(shown(el, 'tasks-detail-loading')).toBeTruthy()

    await router!.push('/tasks/tsk_b')
    await flush()
    expect(h_.getTask).toHaveBeenCalledTimes(2)

    // The NEWER (tsk_b) request resolves FIRST.
    second.resolve({ kind: 'ok', task: taskDetail({ id: 'tsk_b', title: 'B Task' }) })
    await flush()
    expect(el.textContent).toContain('B Task')

    // …then the OLDER (tsk_a), superseded request resolves LAST. The generation guard must
    // discard it — without the guard, this would stomp the already-rendered newer task.
    first.resolve({ kind: 'ok', task: taskDetail({ id: 'tsk_a', title: 'A Task' }) })
    await flush()

    expect(el.textContent).toContain('B Task')
    expect(el.textContent).not.toContain('A Task')
  })

  it("an older id's NOT_FOUND resolving after a newer id's OK does not clobber the shown task", async () => {
    const first = deferred<{ kind: 'not_found' }>()
    const second = deferred<{ kind: 'ok'; task: TaskDetailFixture }>()
    h_.getTask.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    const el = await mountAt('/tasks/tsk_a')
    await router!.push('/tasks/tsk_b')
    await flush()

    second.resolve({ kind: 'ok', task: taskDetail({ id: 'tsk_b', title: 'B Task' }) })
    await flush()
    first.resolve({ kind: 'not_found' })
    await flush()

    expect(shown(el, 'tasks-detail-not-found')).toBeNull()
    expect(el.textContent).toContain('B Task')
  })
})

describe('TasksView list — row links to /tasks/:id (real router)', () => {
  it('renders each row title as a real <a href="/tasks/:id">, and following that href loads the detail', async () => {
    h_.listTasks.mockResolvedValue({
      kind: 'ok',
      items: [
        { id: 't1', title: 'Row One', status: 'open', completion_mode: 'all', created_by: 'u1', due_at: null },
      ],
    })
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ id: 't1', title: 'Row One' }) })

    const el = await mountAt('/tasks')
    const link = shown(el, 'tasks-list-item-link') as HTMLAnchorElement
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('/tasks/t1')
    expect(link.textContent).toBe('Row One')
    expect(h_.getTask).not.toHaveBeenCalled()

    // Drives the navigation through `router.push` (the same robust pattern the id-change tests
    // above use) rather than a synthetic DOM `click()`: a RouterLink's click handler kicks off a
    // navigation whose guard/resolve chain resolves across more microtask ticks than jsdom's
    // synthetic click + a bounded flush reliably observes, which is a jsdom/timing property, not
    // something this component controls. The `href` assertion above already proves the link's
    // TARGET is correct; following that exact target path here proves it actually loads the
    // right task, i.e. the same "click a row -> see its detail" behavior end to end.
    await router!.push(link.getAttribute('href') as string)
    await flush()

    expect(h_.getTask).toHaveBeenCalledWith('t1')
    expect(shown(el, 'tasks-detail')).toBeTruthy()
    expect(shown(el, 'tasks-list')).toBeNull()
  })

  // NIT: the row link interpolates the raw id into `:to`. An unencoded id containing "/" would
  // split across TWO path segments, which `/tasks/:id` (a single-segment param) does not match.
  it('encodeURIComponent-encodes the id in the row link, so an id containing "/" still round-trips', async () => {
    h_.listTasks.mockResolvedValue({
      kind: 'ok',
      items: [
        { id: 'a/b', title: 'Slash Row', status: 'open', completion_mode: 'all', created_by: 'u1', due_at: null },
      ],
    })
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ id: 'a/b', title: 'Slash Row' }) })

    const el = await mountAt('/tasks')
    const link = shown(el, 'tasks-list-item-link') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/tasks/a%2Fb')

    await router!.push(link.getAttribute('href') as string)
    await flush()

    expect(h_.getTask).toHaveBeenCalledWith('a/b')
    expect(shown(el, 'tasks-detail')).toBeTruthy()
  })
})
