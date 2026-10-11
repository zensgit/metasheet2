/**
 * G2-core (design task-g2-core-design-20261011.md §4, §6): the /tasks list page's status switch
 * 未完成 / 已完成 / 全部 — default 未完成 (`open`), every list read carries the status, the choice is
 * remembered per browser in localStorage, and a storage that throws or holds garbage falls back to
 * the default without breaking the page. The mocks and helpers are the ones tasks-list-view.spec.ts
 * uses; storage is cleared before and after every cell so a remembered choice cannot leak.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'

const h = vi.hoisted(() => ({
  loadTasksContext: vi.fn(),
  listTasks: vi.fn(),
  getTask: vi.fn(),
  // M3: a detail-route mount (the boundary test near the bottom of this file) now also reads
  // comments and resolves the viewer's own id. Neither is exercised by this file's own
  // assertions (see tasks-detail-m3.spec.ts) — stubbed to harmless defaults so that mount does
  // not throw.
  listComments: vi.fn(),
  getCurrentUserId: vi.fn(),
  createTask: vi.fn(),
  completeTask: vi.fn(),
  reopenTask: vi.fn(),
  notifyTasksChanged: vi.fn(),
  // M4 FE-4: a detail-route mount also reads the viewer's lists, and the editor / lists section can
  // send their writes. None is exercised here (tasks-detail-m4.spec.ts covers them) — stubbed so
  // that mount does not throw.
  listAllTaskLists: vi.fn(),
  patchTask: vi.fn(),
  addTaskToList: vi.fn(),
  removeTaskFromList: vi.fn(),
  resolveViewerTimeZone: vi.fn(),
  // M4 FE-5: a list-route mount also mounts the lists sidebar, which reads one page of the viewer's
  // lists and can create one. Neither is exercised here (tasks-lists-sidebar.spec.ts covers them)
  // — stubbed so that mount does not throw.
  listTaskLists: vi.fn(),
  createTaskList: vi.fn(),
  // M4 FE-7: the assigned view's rows render through the personal grouping board, which reads the
  // viewer's groups and placements. Neither is exercised here (tasks-groups.spec.ts covers them) —
  // stubbed with the answer for a viewer without groups (the synthetic default group, no
  // placements), under which the board shows the rows in the plain list's order.
  listUserGroups: vi.fn(),
  listUserGroupItems: vi.fn(),
  route: { params: {} as Record<string, string> },
  router: { push: vi.fn() },
}))

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
  createTask: h.createTask,
  completeTask: h.completeTask,
  reopenTask: h.reopenTask,
  listAllTaskLists: h.listAllTaskLists,
  patchTask: h.patchTask,
  addTaskToList: h.addTaskToList,
  removeTaskFromList: h.removeTaskFromList,
  resolveViewerTimeZone: h.resolveViewerTimeZone,
  listTaskLists: h.listTaskLists,
  createTaskList: h.createTaskList,
  listUserGroups: h.listUserGroups,
  listUserGroupItems: h.listUserGroupItems,
}))

vi.mock('../src/tasks/tasksBadgeBus', () => ({
  notifyTasksChanged: h.notifyTasksChanged,
}))

// M3: `useAuth().getCurrentUserId()` is called once a detail route is entered (own-comment /
// leave-button gating, covered in tasks-detail-m3.spec.ts). Defaults to an unresolved id here.
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({ getCurrentUserId: h.getCurrentUserId }),
}))

// M4 FE-0: TasksView reads `useLocale()` for every string it renders (`tasks/labels.ts`). jsdom
// reports `navigator.language` as en-US, so pin the Chinese table here — the same mock shape
// tasks-badge.spec.ts uses — and every copy assertion in this file stays exactly as written.
vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref('zh-CN'),
    isZh: ref(true),
    setLocale: vi.fn(),
  }),
}))

import TasksView from '../src/views/tasks/TasksView.vue'
import { formatViewerInstant } from '../src/tasks/tasksDateDisplay'

let app: App | null = null
let host: HTMLElement | null = null

async function flush(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function mountReady(): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(TasksView)
  app.mount(host)
  await flush()
  return host
}

function shown(el: HTMLElement, testid: string): HTMLElement | null {
  return el.querySelector(`[data-testid="${testid}"]`)
}

/** A manually-resolvable promise, for tests that need to hold one action "in flight" while a
 *  SECOND, independent action resolves first (P3-iii below). */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolveFn = res
  })
  return { promise, resolve: resolveFn }
}

function taskItem(over: Partial<{
  id: string
  title: string
  status: 'open' | 'done'
  completion_mode: 'all' | 'any'
  created_by: string
  due_at: string | null
}> = {}) {
  return {
    id: 't1',
    title: 'Task One',
    status: 'open' as const,
    completion_mode: 'all' as const,
    created_by: 'u1',
    due_at: null,
    ...over,
  }
}

beforeEach(() => {
  h.route.params = {}
  h.loadTasksContext.mockReset().mockResolvedValue({ state: 'ready', orgId: 'org1' })
  h.listTasks.mockReset()
  h.getTask.mockReset().mockResolvedValue({ kind: 'not_found' })
  h.createTask.mockReset()
  h.completeTask.mockReset()
  h.reopenTask.mockReset()
  h.notifyTasksChanged.mockReset()
  h.listComments.mockReset().mockResolvedValue({ kind: 'ok', items: [] })
  h.getCurrentUserId.mockReset().mockResolvedValue(null)
  h.router.push.mockReset()
  h.listAllTaskLists.mockReset().mockResolvedValue({ kind: 'ok', items: [], total: 0 })
  h.patchTask.mockReset()
  h.addTaskToList.mockReset()
  h.removeTaskFromList.mockReset()
  h.resolveViewerTimeZone.mockReset().mockReturnValue('UTC')
  h.listTaskLists.mockReset().mockResolvedValue({ kind: 'ok', items: [], total: 0 })
  h.createTaskList.mockReset()
  h.listUserGroups.mockReset().mockResolvedValue({
    kind: 'ok',
    items: [{ id: null, scope: 'user', name: '默认分组', position: 0, isDefault: true }],
    total: 1,
  })
  h.listUserGroupItems.mockReset().mockResolvedValue({ kind: 'ok', items: [], total: 0 })
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})


const KEY = 'metasheet.tasks.statusFilter'

function clearStorage(): void {
  try {
    window.localStorage.clear()
  } catch {
    // jsdom always has it; nothing to clear otherwise.
  }
}

beforeEach(() => {
  clearStorage()
  h.listTasks.mockResolvedValue({ kind: 'ok', items: [] })
})

afterEach(() => {
  vi.restoreAllMocks()
  clearStorage()
})

function statusButton(el: HTMLElement, value: 'open' | 'done' | 'all'): HTMLButtonElement {
  const button = shown(el, `tasks-status-switch-${value}`) as HTMLButtonElement | null
  if (!button) throw new Error(`no status button ${value}`)
  return button
}

function pressed(el: HTMLElement): string[] {
  return (['open', 'done', 'all'] as const).filter((value) => statusButton(el, value).getAttribute('aria-pressed') === 'true')
}

describe('G2-core status switch — default and labels', () => {
  it('g2core|fe|default: with nothing remembered the first read is `open` and 未完成 is pressed', async () => {
    const el = await mountReady()
    expect(h.listTasks).toHaveBeenCalledTimes(1)
    expect(h.listTasks).toHaveBeenLastCalledWith('assigned', undefined, 'open')
    expect(pressed(el)).toEqual(['open'])
    expect(statusButton(el, 'open').disabled).toBe(true)
    expect(statusButton(el, 'done').disabled).toBe(false)
  })

  it('g2core|fe|labels: the three buttons read 未完成 / 已完成 / 全部 in a nav named 任务状态', async () => {
    const el = await mountReady()
    expect(statusButton(el, 'open').textContent?.trim()).toBe('未完成')
    expect(statusButton(el, 'done').textContent?.trim()).toBe('已完成')
    expect(statusButton(el, 'all').textContent?.trim()).toBe('全部')
    expect(shown(el, 'tasks-status-switcher')?.getAttribute('aria-label')).toBe('任务状态')
  })
})

describe('G2-core status switch — switching', () => {
  it('g2core|fe|switch: each status re-reads the current view with that status, `all` sent explicitly', async () => {
    const el = await mountReady()
    statusButton(el, 'done').click()
    await flush()
    expect(h.listTasks).toHaveBeenLastCalledWith('assigned', undefined, 'done')
    expect(pressed(el)).toEqual(['done'])
    statusButton(el, 'all').click()
    await flush()
    expect(h.listTasks).toHaveBeenLastCalledWith('assigned', undefined, 'all')
    expect(pressed(el)).toEqual(['all'])
    expect(h.listTasks).toHaveBeenCalledTimes(3)
  })

  it('g2core|fe|orthogonal: switching the view keeps the status, switching the status keeps the view', async () => {
    const el = await mountReady()
    statusButton(el, 'done').click()
    await flush()
    ;(shown(el, 'tasks-view-switch-created') as HTMLButtonElement).click()
    await flush()
    expect(h.listTasks).toHaveBeenLastCalledWith('created', undefined, 'done')
    statusButton(el, 'open').click()
    await flush()
    expect(h.listTasks).toHaveBeenLastCalledWith('created', undefined, 'open')
  })

  it('g2core|fe|same: pressing the current status does not read again', async () => {
    const el = await mountReady()
    statusButton(el, 'open').click()
    await flush()
    expect(h.listTasks).toHaveBeenCalledTimes(1)
  })

  it('g2core|fe|late: a slow answer for the previous status cannot paint over the new one', async () => {
    const slow = deferred<{ kind: 'ok'; items: ReturnType<typeof taskItem>[] }>()
    h.listTasks.mockReset()
      .mockResolvedValueOnce({ kind: 'ok', items: [] })
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce({ kind: 'ok', items: [taskItem({ id: 'all1', title: 'Fresh All' })] })
    const el = await mountReady()
    statusButton(el, 'done').click()
    await flush()
    statusButton(el, 'all').click()
    await flush()
    slow.resolve({ kind: 'ok', items: [taskItem({ id: 'done1', title: 'Stale Done', status: 'done' })] })
    await flush()
    expect(el.textContent).toContain('Fresh All')
    expect(el.textContent).not.toContain('Stale Done')
  })

  it('g2core|fe|reload after complete keeps the status', async () => {
    h.listTasks.mockResolvedValue({ kind: 'ok', items: [taskItem({ id: 't1' })] })
    h.completeTask.mockResolvedValue({ kind: 'ok' })
    const el = await mountReady()
    statusButton(el, 'all').click()
    await flush()
    ;(shown(el, 'tasks-complete-button') as HTMLButtonElement).click()
    await flush()
    expect(h.completeTask).toHaveBeenCalledWith('t1')
    expect(h.listTasks).toHaveBeenLastCalledWith('assigned', undefined, 'all')
  })
})

describe('G2-core status switch — remembered per browser', () => {
  it('g2core|fe|persist: a switch is written to storage and a new mount starts from it', async () => {
    const el = await mountReady()
    statusButton(el, 'done').click()
    await flush()
    expect(window.localStorage.getItem(KEY)).toBe('done')
    app?.unmount()
    host?.remove()
    h.listTasks.mockClear()
    const again = await mountReady()
    expect(h.listTasks).toHaveBeenLastCalledWith('assigned', undefined, 'done')
    expect(pressed(again)).toEqual(['done'])
  })

  it.each(['all', 'done', 'open'] as const)('g2core|fe|stored %s: the first read uses it', async (value) => {
    window.localStorage.setItem(KEY, value)
    const el = await mountReady()
    expect(h.listTasks).toHaveBeenCalledTimes(1)
    expect(h.listTasks).toHaveBeenLastCalledWith('assigned', undefined, value)
    expect(pressed(el)).toEqual([value])
  })

  it.each(['', 'DONE', 'closed', 'null', '"done"', ' all'])('g2core|fe|stored garbage %j: falls back to open', async (value) => {
    window.localStorage.setItem(KEY, value)
    const el = await mountReady()
    expect(h.listTasks).toHaveBeenLastCalledWith('assigned', undefined, 'open')
    expect(pressed(el)).toEqual(['open'])
  })

  it('g2core|fe|getItem throws: the page mounts with open and still switches', async () => {
    // A stored `done` that cannot be read: the throw, not an empty store, is what yields `open`.
    window.localStorage.setItem(KEY, 'done')
    const getItem = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    const el = await mountReady()
    expect(getItem).toHaveBeenCalledWith(KEY)
    expect(h.listTasks).toHaveBeenLastCalledWith('assigned', undefined, 'open')
    statusButton(el, 'done').click()
    await flush()
    expect(h.listTasks).toHaveBeenLastCalledWith('assigned', undefined, 'done')
    expect(pressed(el)).toEqual(['done'])
  })

  it('g2core|fe|setItem throws: the switch still applies for this page and nothing escapes', async () => {
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const el = await mountReady()
    statusButton(el, 'all').click()
    await flush()
    expect(setItem).toHaveBeenCalledWith(KEY, 'all')
    expect(h.listTasks).toHaveBeenLastCalledWith('assigned', undefined, 'all')
    expect(pressed(el)).toEqual(['all'])
    expect(shown(el, 'tasks-list-error')).toBeNull()
  })

  it('g2core|fe|localStorage accessor throws: open, and switching still works', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError')
      },
    })
    try {
      const el = await mountReady()
      expect(h.listTasks).toHaveBeenLastCalledWith('assigned', undefined, 'open')
      statusButton(el, 'done').click()
      await flush()
      expect(h.listTasks).toHaveBeenLastCalledWith('assigned', undefined, 'done')
    } finally {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor)
    }
  })
})
