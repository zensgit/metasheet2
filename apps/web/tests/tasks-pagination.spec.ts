import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'

const mocks = vi.hoisted(() => ({
  identity: 'viewer-a',
  loadTasksContext: vi.fn(),
  listTasks: vi.fn(),
  getTask: vi.fn(),
  listComments: vi.fn(),
  listAllTaskLists: vi.fn(),
  listUserGroups: vi.fn(),
  listUserGroupItems: vi.fn(),
  placeTaskInUserGroup: vi.fn(),
  getCurrentUserId: vi.fn(),
  createTask: vi.fn(),
  completeTask: vi.fn(),
  reopenTask: vi.fn(),
}))

vi.mock('../src/tasks/recordTaskDispatchIdentity', () => ({ readDispatchIdentity: () => mocks.identity }))
vi.mock('../src/tasks/tasksContext', () => ({ loadTasksContext: mocks.loadTasksContext }))
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({ getCurrentUserId: mocks.getCurrentUserId }),
}))
vi.mock('../src/tasks/tasksApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/tasks/tasksApi')>()),
  listTasks: mocks.listTasks,
  getTask: mocks.getTask,
  listComments: mocks.listComments,
  listAllTaskLists: mocks.listAllTaskLists,
  listUserGroups: mocks.listUserGroups,
  listUserGroupItems: mocks.listUserGroupItems,
  placeTaskInUserGroup: mocks.placeTaskInUserGroup,
  createTask: mocks.createTask,
  completeTask: mocks.completeTask,
  reopenTask: mocks.reopenTask,
}))
vi.mock('../src/tasks/tasksBadgeBus', () => ({ notifyTasksChanged: vi.fn() }))
vi.mock('../src/views/tasks/TaskListsSidebar.vue', () => ({ default: { render: () => null } }))
vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({ isZh, locale: ref('zh-CN'), setLocale: vi.fn() }),
}))

import type { ListTasksResult, TaskListItem } from '../src/tasks/tasksApi'
import { TASKS_EN, TASKS_FMT_EN, TASKS_FMT_ZH, TASKS_ZH } from '../src/tasks/labels'
import { TASK_SEARCH_DEBOUNCE_MS } from '../src/tasks/tasksSearch'
import TasksView from '../src/views/tasks/TasksView.vue'

const isZh = ref(true)
let app: App | null = null
let host: HTMLElement | null = null
let router: Router

function row(id: string, title = `Task ${id}`): TaskListItem {
  return { id, title, status: 'open', completion_mode: 'any', created_by: 'viewer', due_at: null }
}

function rows(count: number, prefix = 'task'): TaskListItem[] {
  return Array.from({ length: count }, (_, index) => row(`${prefix}-${index}`))
}

function ok(items: TaskListItem[], total = items.length): ListTasksResult {
  return { kind: 'ok', items, total }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function query<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return host!.querySelector<T>(`[data-testid="${id}"]`)
}

function control<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = query<T>(id)
  expect(found, id).not.toBeNull()
  return found!
}

function titles(): string[] {
  return Array.from(host!.querySelectorAll('[data-testid="tasks-list-item-link"]')).map((link) => link.textContent ?? '')
}

async function click(id: string): Promise<void> {
  control<HTMLButtonElement>(id).click()
  await flush()
}

async function search(value: string): Promise<void> {
  const input = control<HTMLInputElement>('tasks-search-input')
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flush()
  await vi.advanceTimersByTimeAsync(TASK_SEARCH_DEBOUNCE_MS)
  await flush()
}

async function mount(): Promise<void> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/tasks', component: TasksView },
      { path: '/tasks/:id', component: TasksView },
    ],
  })
  await router.push('/tasks')
  await router.isReady()
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(RouterView)
  app.use(router)
  app.mount(host)
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  window.localStorage.clear()
  isZh.value = true
  mocks.identity = 'viewer-a'
  mocks.loadTasksContext.mockResolvedValue({ state: 'ready', orgId: 'org-a' })
  mocks.listTasks.mockResolvedValue(ok([]))
  mocks.getTask.mockResolvedValue({ kind: 'not_found' })
  mocks.listComments.mockResolvedValue({ kind: 'ok', items: [], total: 0 })
  mocks.listAllTaskLists.mockResolvedValue({ kind: 'ok', items: [], total: 0 })
  mocks.listUserGroups.mockResolvedValue({
    kind: 'ok', items: [{ id: 'group-default', scope: 'user', name: '默认分组', position: 0, isDefault: true }], total: 1,
  })
  mocks.listUserGroupItems.mockResolvedValue({ kind: 'ok', items: [], total: 0 })
  mocks.getCurrentUserId.mockResolvedValue('viewer')
  mocks.createTask.mockResolvedValue({ kind: 'ok', id: 'created-task' })
  mocks.completeTask.mockResolvedValue({ kind: 'ok', done: true })
  mocks.reopenTask.mockResolvedValue({ kind: 'ok', done: false })
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  window.localStorage.clear()
  vi.useRealTimers()
})

describe('task list pagination', () => {
  it('loads 205 tasks in three pages and enables sorting only after the last page', async () => {
    const all = rows(205)
    const second = deferred<ListTasksResult>()
    mocks.listTasks.mockResolvedValueOnce(ok(all.slice(0, 100), 205))
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce(ok(all.slice(200), 205))
    mocks.listUserGroupItems.mockResolvedValue({
      kind: 'ok',
      items: all.slice(0, 2).map((item, position) => ({ taskId: item.id, groupId: 'group-default', position })),
      total: 2,
    })
    await mount()
    expect(titles()).toEqual(all.slice(0, 100).map((item) => item.title))
    expect(control('tasks-list-load-more').textContent).toBe(TASKS_ZH.loadMore)
    expect(control('tasks-list-truncated').textContent).toBe(TASKS_FMT_ZH.listTruncated(100, 205))
    expect(control('tasks-groups-reorder-off').textContent?.trim()).toBe(TASKS_ZH.groupsReorderOff)
    expect(host!.querySelectorAll('[data-testid="tasks-groups-reorder-off"], [data-testid="tasks-list-load-more-reorder-off"]')).toHaveLength(1)
    const handle = control('tasks-group-drag-handle')
    expect(handle.getAttribute('draggable')).toBe('false')
    expect(control<HTMLButtonElement>('tasks-group-move-down').disabled).toBe(true)
    expect(control<HTMLButtonElement>('tasks-group-add-to-order').disabled).toBe(true)
    handle.dispatchEvent(new MouseEvent('dragstart', { bubbles: true, cancelable: true }))
    control('tasks-list-item').dispatchEvent(new MouseEvent('drop', { bubbles: true, cancelable: true }))
    control('tasks-group-move-down').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(mocks.placeTaskInUserGroup).not.toHaveBeenCalled()

    await click('tasks-list-load-more')
    control('tasks-list-load-more').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(control<HTMLButtonElement>('tasks-list-load-more').disabled).toBe(true)
    expect(control('tasks-list-load-more').textContent).toBe(TASKS_ZH.loading)
    expect(titles()).toHaveLength(100)
    expect(mocks.listTasks).toHaveBeenCalledTimes(2)
    expect(mocks.listTasks).toHaveBeenLastCalledWith('assigned', { offset: 100 }, 'open')
    second.resolve(ok(all.slice(100, 200), 205))
    await flush()
    expect(titles()).toEqual(all.slice(0, 200).map((item) => item.title))
    expect(handle.getAttribute('draggable')).toBe('false')
    await click('tasks-list-load-more')
    expect(mocks.listTasks).toHaveBeenLastCalledWith('assigned', { offset: 200 }, 'open')
    expect(titles()).toEqual(all.map((item) => item.title))
    expect(query('tasks-list-load-more')).toBeNull()
    expect(query('tasks-list-truncated')).toBeNull()
    expect(query('tasks-groups-reorder-off')).toBeNull()
    expect(handle.getAttribute('draggable')).toBe('true')
    expect(control<HTMLButtonElement>('tasks-group-move-down').disabled).toBe(false)
    expect(mocks.listUserGroups).toHaveBeenCalledTimes(1)
    expect(mocks.listUserGroupItems).toHaveBeenCalledTimes(1)
  })

  it.each(['following', 'created', 'delegated', 'any_role'] as const)('keeps view, status and title search on more pages in %s', async (view) => {
    const all = rows(101)
    mocks.listTasks.mockImplementation((_view: string, page?: { offset: number }) => Promise.resolve(ok(all.slice(page?.offset ?? 0, (page?.offset ?? 0) + 100), 101)))
    await mount()
    await click(`tasks-view-switch-${view}`)
    await click('tasks-status-switch-done')
    await search('  drawings  ')
    expect(control('tasks-list').tagName).toBe('UL')
    expect(query('tasks-groups-reorder-off')).toBeNull()
    await click('tasks-list-load-more')
    expect(mocks.listTasks).toHaveBeenLastCalledWith(view, { offset: 100 }, 'done', 'drawings')
    expect(titles()).toHaveLength(101)
    expect(query('tasks-list-load-more')).toBeNull()
  })

  it('keeps one row per task and advances by the number of rows read when pages overlap', async () => {
    mocks.listTasks.mockResolvedValueOnce(ok([row('a'), row('b')], 4))
      .mockResolvedValueOnce(ok([row('b', 'Updated title'), row('c')], 4))
      .mockResolvedValueOnce(ok([row('d')], 4))
    await mount()
    await click('tasks-list-load-more')
    expect(titles()).toEqual(['Task a', 'Updated title', 'Task c'])
    expect(control('tasks-list-truncated').textContent).toBe(TASKS_FMT_ZH.listTruncated(3, 4))
    await click('tasks-list-load-more')
    expect(mocks.listTasks).toHaveBeenLastCalledWith('assigned', { offset: 4 }, 'open')
    expect(titles()).toEqual(['Task a', 'Updated title', 'Task c', 'Task d'])
    expect(query('tasks-list-load-more')).toBeNull()
  })

  it.each(['error', 'forbidden', 'not_found', 'predicate_error'] as const)('preserves loaded rows and retries the same page after %s', async (kind) => {
    mocks.listTasks.mockResolvedValueOnce(ok([row('a')], 2))
      .mockResolvedValueOnce({ kind })
      .mockResolvedValueOnce(ok([row('b')], 2))
    await mount()
    await click('tasks-list-load-more')
    expect(titles()).toEqual(['Task a'])
    expect(control('tasks-list-load-more-error').textContent).toBe(TASKS_ZH.listLoadMoreFailed)
    expect(query('tasks-view-org-missing')).toBeNull()
    expect(control<HTMLButtonElement>('tasks-list-load-more').disabled).toBe(false)
    expect(control<HTMLButtonElement>('tasks-group-add-to-order').disabled).toBe(true)
    await click('tasks-list-load-more')
    expect(mocks.listTasks.mock.calls.slice(1)).toEqual([
      ['assigned', { offset: 1 }, 'open'], ['assigned', { offset: 1 }, 'open'],
    ])
    expect(titles()).toEqual(['Task a', 'Task b'])
    expect(query('tasks-list-load-more-error')).toBeNull()
  })

  it('keeps retry available if loading another page rejects', async () => {
    mocks.listTasks.mockResolvedValueOnce(ok([row('a')], 2)).mockRejectedValueOnce(new Error('Unavailable'))
    await mount()
    await click('tasks-list-load-more')
    expect(titles()).toEqual(['Task a'])
    expect(control('tasks-list-load-more-error').getAttribute('role')).toBe('alert')
    expect(control<HTMLButtonElement>('tasks-list-load-more').disabled).toBe(false)
  })

  it('restarts from the first page after shifted rows leave an empty page with tasks still missing', async () => {
    const restart = deferred<ListTasksResult>()
    mocks.listTasks.mockResolvedValueOnce(ok([row('a'), row('b')], 4))
      .mockResolvedValueOnce(ok([row('b'), row('c')], 4))
      .mockResolvedValueOnce(ok([], 4))
      .mockReturnValueOnce(restart.promise)
      .mockResolvedValueOnce(ok([row('b'), row('c')], 4))
    await mount()
    await click('tasks-list-load-more')
    expect(titles()).toEqual(['Task a', 'Task b', 'Task c'])
    expect(control<HTMLButtonElement>('tasks-group-add-to-order').disabled).toBe(true)
    await click('tasks-list-load-more')
    expect(mocks.listTasks.mock.calls).toEqual([
      ['assigned', undefined, 'open'],
      ['assigned', { offset: 2 }, 'open'],
      ['assigned', { offset: 4 }, 'open'],
      ['assigned', undefined, 'open'],
    ])
    control('tasks-list-loading')
    expect(query('tasks-list-load-more')).toBeNull()
    restart.resolve(ok([row('d'), row('a')], 4))
    await flush()
    expect(titles()).toEqual(['Task d', 'Task a'])
    expect(control<HTMLButtonElement>('tasks-group-add-to-order').disabled).toBe(true)
    expect(query('tasks-list-load-more-error')).toBeNull()
    await click('tasks-list-load-more')
    expect(mocks.listTasks).toHaveBeenLastCalledWith('assigned', { offset: 2 }, 'open')
    expect(titles()).toEqual(['Task d', 'Task a', 'Task b', 'Task c'])
    expect(query('tasks-list-load-more')).toBeNull()
    expect(control<HTMLButtonElement>('tasks-group-add-to-order').disabled).toBe(false)
  })

  it('shows a list error if restarting after an empty page fails', async () => {
    mocks.listTasks.mockResolvedValueOnce(ok([row('a')], 2))
      .mockResolvedValueOnce(ok([], 2)).mockResolvedValueOnce({ kind: 'error' })
    await mount()
    await click('tasks-list-load-more')
    expect(mocks.listTasks).toHaveBeenLastCalledWith('assigned', undefined, 'open')
    expect(control('tasks-list-error').textContent?.trim()).toBe(TASKS_ZH.listLoadFailed)
    expect(query('tasks-list-load-more')).toBeNull()
    expect(titles()).toEqual([])
  })

  it.each(['silent', 'announced', 'away and back'] as const)('restarts before reading another page after an account change that is %s', async (change) => {
    mocks.listTasks.mockResolvedValueOnce(ok([row('old')], 2))
      .mockResolvedValueOnce(ok([row('new-a')], 2))
      .mockResolvedValueOnce(ok([row('new-b')], 2))
    await mount()
    mocks.identity = 'viewer-b'
    if (change !== 'silent') window.dispatchEvent(new Event('storage'))
    if (change === 'away and back') {
      mocks.identity = 'viewer-a'
      window.dispatchEvent(new Event('storage'))
    }
    await click('tasks-list-load-more')
    expect(mocks.listTasks.mock.calls).toEqual([
      ['assigned', undefined, 'open'], ['assigned', undefined, 'open'],
    ])
    expect(titles()).toEqual(['Task new-a'])
    expect(query('tasks-list-load-more-error')).toBeNull()
    await click('tasks-list-load-more')
    expect(mocks.listTasks).toHaveBeenLastCalledWith('assigned', { offset: 1 }, 'open')
    expect(titles()).toEqual(['Task new-a', 'Task new-b'])
  })

  it.each(['ok', 'org_missing', 'error', 'reject'] as const)('restarts after a silent account change during a page read ending with %s', async (outcome) => {
    const pending = deferred<ListTasksResult>()
    const restart = deferred<ListTasksResult>()
    mocks.listTasks.mockResolvedValueOnce(ok([row('old')], 2))
      .mockReturnValueOnce(pending.promise).mockReturnValueOnce(restart.promise)
      .mockResolvedValueOnce(ok([row('new-b')], 2))
    await mount()
    await click('tasks-list-load-more')
    mocks.identity = 'viewer-b'
    if (outcome === 'reject') pending.reject(new Error('Unavailable'))
    else pending.resolve(outcome === 'ok' ? ok([row('old-more')], 2) : { kind: outcome })
    await flush()
    expect(mocks.listTasks).toHaveBeenCalledTimes(3)
    expect(mocks.listTasks).toHaveBeenLastCalledWith('assigned', undefined, 'open')
    control('tasks-list-loading')
    expect(query('tasks-view-org-missing')).toBeNull()
    expect(query('tasks-list-load-more-error')).toBeNull()
    expect(titles()).toEqual([])
    restart.resolve(ok([row('new-a')], 2))
    await flush()
    expect(titles()).toEqual(['Task new-a'])
    await click('tasks-list-load-more')
    expect(titles()).toEqual(['Task new-a', 'Task new-b'])
    expect(query('tasks-list-load-more')).toBeNull()
  })

  it.each(['announced', 'away and back'] as const)('restarts after an observed account change during a page read that is %s', async (change) => {
    const pending = deferred<ListTasksResult>()
    mocks.listTasks.mockResolvedValueOnce(ok([row('old')], 2))
      .mockReturnValueOnce(pending.promise).mockResolvedValueOnce(ok([row('new')]))
    await mount()
    await click('tasks-list-load-more')
    mocks.identity = 'viewer-b'
    window.dispatchEvent(new Event('storage'))
    if (change === 'away and back') {
      mocks.identity = 'viewer-a'
      window.dispatchEvent(new Event('storage'))
    }
    await flush()
    pending.resolve(ok([row('old-more')], 2))
    await flush()
    expect(mocks.listTasks).toHaveBeenLastCalledWith('assigned', undefined, 'open')
    expect(titles()).toEqual(['Task new'])
    expect(query('tasks-list-load-more')).toBeNull()
    expect(query('tasks-list-load-more-error')).toBeNull()
  })

  it('finishes if the total falls to the number of tasks already loaded', async () => {
    mocks.listTasks.mockResolvedValueOnce(ok([row('a')], 2)).mockResolvedValueOnce(ok([], 1))
    await mount()
    await click('tasks-list-load-more')
    expect(titles()).toEqual(['Task a'])
    expect(query('tasks-list-load-more')).toBeNull()
    expect(query('tasks-list-load-more-error')).toBeNull()
    expect(control<HTMLButtonElement>('tasks-group-add-to-order').disabled).toBe(false)
  })

  it.each([ok([]), ok(rows(100)), { kind: 'ok', items: [row('a')] }])('does not offer another page for a complete or uncounted list', async (result) => {
    mocks.listTasks.mockResolvedValue(result)
    await mount()
    expect(query('tasks-list-load-more')).toBeNull()
    expect(query('tasks-list-truncated')).toBeNull()
    expect(mocks.listTasks).toHaveBeenCalledTimes(1)
  })

  it('shows the organization prompt if another page needs an organization', async () => {
    mocks.listTasks.mockResolvedValueOnce(ok([row('a')], 2)).mockResolvedValueOnce({ kind: 'org_missing' })
    await mount()
    await click('tasks-list-load-more')
    control('tasks-view-org-missing')
    expect(query('tasks-list')).toBeNull()
    expect(query('tasks-list-load-more')).toBeNull()
  })

  it.each(['view', 'status', 'search', 'route'] as const)('resets pagination on a %s change and ignores an old page while the new page is pending', async (change) => {
    const oldPage = deferred<ListTasksResult>()
    const newPage = deferred<ListTasksResult>()
    mocks.listTasks.mockResolvedValueOnce(ok([row('old')], 2))
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce(ok([row('new-a'), row('new-b')], 3))
      .mockReturnValueOnce(newPage.promise)
    await mount()
    await click('tasks-list-load-more')
    if (change === 'view') await click('tasks-view-switch-following')
    if (change === 'status') await click('tasks-status-switch-all')
    if (change === 'search') await search('new')
    if (change === 'route') {
      await router.push('/tasks/detail')
      await flush()
      await router.push('/tasks')
      await flush()
    }
    expect(mocks.listTasks.mock.calls[2]?.[1]).toBeUndefined()
    expect(titles()).toEqual(['Task new-a', 'Task new-b'])
    await click('tasks-list-load-more')
    expect(mocks.listTasks.mock.calls[3]?.[1]).toEqual({ offset: 2 })
    oldPage.resolve(ok([row('old-more')], 2))
    await flush()
    expect(titles()).toEqual(['Task new-a', 'Task new-b'])
    expect(control<HTMLButtonElement>('tasks-list-load-more').disabled).toBe(true)
    newPage.resolve(ok([row('new-c')], 3))
    await flush()
    expect(titles()).toEqual(['Task new-a', 'Task new-b', 'Task new-c'])
    expect(query('tasks-list-load-more')).toBeNull()
  })

  it('ignores a late organization response after navigation to a task', async () => {
    const oldPage = deferred<ListTasksResult>()
    mocks.listTasks.mockResolvedValueOnce(ok([row('a')], 2)).mockReturnValueOnce(oldPage.promise)
    await mount()
    await click('tasks-list-load-more')
    await router.push('/tasks/detail')
    await flush()
    oldPage.resolve({ kind: 'org_missing' })
    await flush()
    expect(query('tasks-view-org-missing')).toBeNull()
    control('tasks-detail-not-found')
  })

  it('refreshes from the first page and disables load more until the refresh finishes', async () => {
    const oldPage = deferred<ListTasksResult>()
    const refresh = deferred<ListTasksResult>()
    mocks.listTasks.mockResolvedValueOnce(ok([row('old')], 2))
      .mockReturnValueOnce(oldPage.promise).mockReturnValueOnce(refresh.promise)
      .mockResolvedValueOnce(ok([row('new-c')], 3))
    await mount()
    await click('tasks-list-load-more')
    await click('tasks-groups-refresh')
    expect(mocks.listTasks).toHaveBeenLastCalledWith('assigned', undefined, 'open')
    control('tasks-list-load-more').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(mocks.listTasks).toHaveBeenCalledTimes(3)
    expect(control<HTMLButtonElement>('tasks-list-load-more').disabled).toBe(true)
    oldPage.resolve(ok([row('old-more')], 2))
    await flush()
    expect(titles()).toEqual(['Task old'])
    refresh.resolve(ok([row('new-a'), row('new-b')], 3))
    await flush()
    expect(titles()).toEqual(['Task new-a', 'Task new-b'])
    await click('tasks-list-load-more')
    expect(mocks.listTasks).toHaveBeenLastCalledWith('assigned', { offset: 2 }, 'open')
    expect(titles()).toEqual(['Task new-a', 'Task new-b', 'Task new-c'])
  })

  it.each(['create', 'complete', 'reopen'] as const)('starts pagination again after %s reloads the list', async (action) => {
    mocks.listTasks.mockResolvedValueOnce(ok([{ ...row('a'), status: action === 'reopen' ? 'done' : 'open' }], 3))
      .mockResolvedValueOnce(ok([row('b')], 3))
      .mockResolvedValueOnce(ok([row('fresh')], 2))
      .mockResolvedValueOnce(ok([row('last')], 2))
    await mount()
    await click('tasks-list-load-more')
    if (action === 'create') {
      const input = control<HTMLInputElement>('tasks-create-title')
      input.value = 'New task'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await flush()
      control('tasks-create-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await flush()
    } else {
      await click(action === 'reopen' ? 'tasks-reopen-button' : 'tasks-complete-button')
    }
    expect(titles()).toEqual(['Task fresh'])
    expect(mocks.listTasks).toHaveBeenLastCalledWith('assigned', undefined, 'open')
    await click('tasks-list-load-more')
    expect(mocks.listTasks).toHaveBeenLastCalledWith('assigned', { offset: 1 }, 'open')
    expect(titles()).toEqual(['Task fresh', 'Task last'])
  })

  it('updates the paging controls, explanation and retry text when the language changes', async () => {
    mocks.listTasks.mockResolvedValueOnce(ok([row('a')], 2)).mockResolvedValueOnce({ kind: 'error' })
    await mount()
    await click('tasks-list-load-more')
    isZh.value = false
    await flush()
    expect(control('tasks-list-load-more').textContent).toBe(TASKS_EN.loadMore)
    expect(control('tasks-list-load-more-error').textContent).toBe(TASKS_EN.listLoadMoreFailed)
    expect(control('tasks-groups-reorder-off').textContent?.trim()).toBe(TASKS_EN.groupsReorderOff)
    expect(host!.querySelectorAll('[data-testid="tasks-groups-reorder-off"], [data-testid="tasks-list-load-more-reorder-off"]')).toHaveLength(1)
    expect(control('tasks-list-truncated').textContent).toBe(TASKS_FMT_EN.listTruncated(1, 2))
  })
})
