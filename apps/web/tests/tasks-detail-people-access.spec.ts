import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  loadTasksContext: vi.fn(),
  getTask: vi.fn(),
  getTaskPeople: vi.fn(),
  listComments: vi.fn(),
  listAllTaskLists: vi.fn(),
  completeTask: vi.fn(),
  addFollower: vi.fn(),
  identity: 'viewer-a',
}))

vi.mock('../src/utils/api', () => ({ apiFetch: mocks.apiFetch, authHeaders: () => ({}) }))
vi.mock('../src/tasks/tasksContext', () => ({ loadTasksContext: mocks.loadTasksContext }))
vi.mock('../src/composables/useAuth', () => ({ useAuth: () => ({ getCurrentUserId: async () => 'viewer' }) }))
vi.mock('../src/tasks/recordTaskDispatchIdentity', () => ({ readDispatchIdentity: () => mocks.identity }))
vi.mock('../src/tasks/tasksBadgeBus', () => ({ notifyTasksChanged: vi.fn() }))
vi.mock('../src/tasks/tasksApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/tasks/tasksApi')>()),
  getTask: mocks.getTask,
  getTaskPeople: mocks.getTaskPeople,
  listComments: mocks.listComments,
  listAllTaskLists: mocks.listAllTaskLists,
  completeTask: mocks.completeTask,
  addFollower: mocks.addFollower,
}))
vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({ isZh, locale: ref('zh-CN'), setLocale: vi.fn() }),
}))

import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
import { TASKS_EN, TASKS_ZH } from '../src/tasks/labels'
import type { GetTaskResult, PersonOption, TaskDetail } from '../src/tasks/tasksApi'
import TasksView from '../src/views/tasks/TasksView.vue'

const isZh = ref(true)
let app: App | null = null
let host: HTMLElement | null = null
let router: Router

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: 'task-a', title: 'Review drawings', status: 'open', completionMode: 'any',
    createdBy: 'creator', dueAt: null, dueDate: null, dueTime: null, timeZone: null,
    assignees: ['blocked', 'allowed', 'unknown', 'unnamed'].map((userId) => ({ userId, completedAt: null })),
    followers: ['blocked', 'watcher', 'unknown'],
    canComplete: true, canReopen: false, canEdit: true, canManageMembers: false,
    parentId: null, depth: 0, children: [],
    ...overrides,
  }
}

function person(id: string, canUseTasks: boolean, name = ''): PersonOption {
  return { id, name, detail: '', canUseTasks }
}

const options = [person('blocked', false, '林青'), person('allowed', true, '陈晨'), person('unnamed', false), person('watcher', false, '周晓')]

function response(status = 200, items: unknown[] = options): Response {
  return { status, json: async () => ({ items, truncated: false }) } as Response
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function rows(role: 'assignee' | 'follower'): HTMLElement[] {
  return [...host!.querySelectorAll<HTMLElement>(`[data-testid="tasks-detail-${role}"]`)]
}

function marks(root: ParentNode = host!): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-testid="tasks-detail-person-no-access"]')]
}

async function mount(): Promise<void> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/tasks', component: { render: () => null } },
      { path: '/tasks/:id', component: TasksView },
    ],
  })
  await router.push('/tasks/task-a')
  await router.isReady()
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(RouterView)
  app.use(router)
  app.mount(host)
  await flush()
}

async function refreshDetail(): Promise<void> {
  const button = host!.querySelector<HTMLButtonElement>('[data-testid="tasks-detail-complete-button"]')!
  expect(button.disabled).toBe(false)
  button.click()
  await flush()
}

async function refreshWithNewFollower(): Promise<void> {
  mocks.getTask.mockResolvedValue({ kind: 'ok', task: task({ followers: ['blocked', 'watcher', 'unknown', 'new-follower'] }) })
  await refreshDetail()
}

beforeEach(() => {
  vi.resetAllMocks()
  window.localStorage.clear()
  window.localStorage.setItem('auth_token', 'test-session-a')
  isZh.value = true
  mocks.identity = 'viewer-a'
  mocks.loadTasksContext.mockResolvedValue({ state: 'ready', orgId: 'org-a' })
  mocks.getTask.mockResolvedValue({ kind: 'ok', task: task() })
  mocks.getTaskPeople.mockResolvedValue({
    kind: 'ok',
    people: new Map([
      ['blocked', { name: '林青', status: 'active' }],
      ['allowed', { name: '陈晨', status: 'active' }],
      ['watcher', { name: '周晓', status: 'active' }],
      ['unknown', { name: '', status: 'inactive' }],
    ]),
  })
  mocks.listComments.mockResolvedValue({ kind: 'ok', items: [], total: 0 })
  mocks.listAllTaskLists.mockResolvedValue({ kind: 'ok', items: [], total: 0 })
  mocks.completeTask.mockResolvedValue({ kind: 'ok', done: false })
  mocks.apiFetch.mockResolvedValue(response())
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  window.localStorage.clear()
})

describe('Task member access marks', () => {
  it('marks answered assignees and followers for an editor, including an editor who cannot manage members', async () => {
    await mount()
    expect(rows('assignee').map((row) => marks(row).length)).toEqual([1, 0, 0, 1])
    expect(rows('follower').map((row) => marks(row).length)).toEqual([1, 1, 0])
    expect(marks().map((mark) => mark.textContent)).toEqual(Array(4).fill(TASKS_ZH.peopleCannotUseTasks))
    expect(rows('assignee')[0].textContent).toContain('林青')
    expect(rows('assignee')[3].textContent).toContain('unnamed')
    expect(rows('assignee')[2].querySelector('[data-testid="tasks-detail-person-inactive"]')).not.toBeNull()
    expect(mocks.apiFetch.mock.calls.map(([url]) => url)).toEqual(['/api/tasks/people?ids=blocked,allowed,unknown,unnamed,watcher'])
    isZh.value = false
    await flush()
    expect(marks().map((mark) => mark.textContent)).toEqual(Array(4).fill(TASKS_EN.peopleCannotUseTasks))
  })

  it.each([false, undefined])('does not look up access without an explicit edit permission (%s)', async (canEdit) => {
    mocks.getTask.mockResolvedValue({ kind: 'ok', task: task({ canEdit, canManageMembers: true }) })
    await mount()
    expect(mocks.apiFetch).not.toHaveBeenCalled()
    expect(marks()).toHaveLength(0)
    expect(rows('assignee')[0].textContent).toContain('林青')
  })

  it.each<[string, unknown[]]>([
    ['missing', []],
    ['malformed', [{ id: 'blocked', name: '林青', detail: '', canUseTasks: 'false' }]],
  ])('does not mark a %s answer, and looks up again after editing is restored', async (_kind, items) => {
    mocks.apiFetch.mockResolvedValueOnce(response(200, items))
    await mount()
    expect(marks()).toHaveLength(0)
    mocks.getTask.mockResolvedValueOnce({ kind: 'ok', task: task({ canEdit: false }) })
    await refreshDetail()
    expect(marks()).toHaveLength(0)
    await refreshDetail()
    expect(marks()).toHaveLength(4)
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2)
  })

  it.each([403, 429, 500])('does not retain the previous task marks when the next lookup fails with %s', async (status) => {
    await mount()
    expect(marks()).toHaveLength(4)
    mocks.getTask.mockResolvedValue({ kind: 'ok', task: task({ id: 'task-b' }) })
    mocks.apiFetch.mockResolvedValueOnce(response(status))
    await router.push('/tasks/task-b')
    await flush()
    expect(marks()).toHaveLength(0)
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2)
    expect(rows('assignee')[0].textContent).toContain('林青')
  })

  it('does not retain the previous task marks after a transport failure', async () => {
    await mount()
    expect(marks()).toHaveLength(4)
    mocks.getTask.mockResolvedValue({ kind: 'ok', task: task({ id: 'task-b' }) })
    mocks.apiFetch.mockRejectedValueOnce(new TypeError('Connection unavailable'))
    await router.push('/tasks/task-b')
    await flush()
    expect(marks()).toHaveLength(0)
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2)
  })

  it('keeps answered marks after refreshing the same task without repeating the lookup', async () => {
    await mount()
    expect(marks()).toHaveLength(4)
    const pending = deferred<GetTaskResult>()
    mocks.getTask.mockReturnValueOnce(pending.promise)
    await refreshDetail()
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
    pending.resolve({ kind: 'ok', task: task({ title: 'Updated drawings' }) })
    await flush()
    expect(marks()).toHaveLength(4)
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
  })

  it('keeps existing marks while looking up only a newly added follower', async () => {
    mocks.getTask.mockResolvedValue({ kind: 'ok', task: task({ canManageMembers: true }) })
    await mount()
    expect(marks()).toHaveLength(4)
    const pending = deferred<Response>()
    mocks.apiFetch.mockReturnValueOnce(pending.promise)
    mocks.addFollower.mockResolvedValue({ kind: 'ok', task: { id: 'task-a', followers: ['blocked', 'watcher', 'unknown', 'new-follower'] } })
    mocks.getTask.mockResolvedValue({ kind: 'ok', task: task({ canManageMembers: true, followers: undefined }) })
    host!.querySelector<HTMLButtonElement>('[data-testid="tasks-detail-add-follower-by-id-toggle"]')!.click()
    await flush()
    const input = host!.querySelector<HTMLInputElement>('[data-testid="tasks-detail-add-follower-input"]')!
    input.value = 'new-follower'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    host!.querySelector<HTMLFormElement>('[data-testid="tasks-detail-add-follower-form"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    expect(mocks.addFollower).toHaveBeenCalledWith('task-a', 'new-follower')
    expect(rows('follower')).toHaveLength(4)
    expect(marks()).toHaveLength(4)
    expect(mocks.apiFetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/tasks/people?ids=blocked,allowed,unknown,unnamed,watcher',
      '/api/tasks/people?ids=new-follower',
    ])
    await refreshDetail()
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2)
    expect(marks()).toHaveLength(4)
    pending.resolve(response(200, [person('new-follower', false)]))
    await flush()
    expect(marks()).toHaveLength(5)
    expect(rows('follower').map((row) => marks(row).length)).toEqual([1, 1, 0, 1])
  })

  it('clears marks when edit permission changes and ignores the previous pending lookup', async () => {
    await mount()
    expect(marks()).toHaveLength(4)
    const pending = deferred<Response>()
    mocks.apiFetch.mockReturnValueOnce(pending.promise)
    await refreshWithNewFollower()
    expect(marks()).toHaveLength(4)
    mocks.getTask.mockResolvedValue({ kind: 'ok', task: task({ canEdit: false }) })
    await refreshDetail()
    expect(marks()).toHaveLength(0)
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2)
    mocks.apiFetch.mockResolvedValue(response(200, []))
    await refreshWithNewFollower()
    expect(marks()).toHaveLength(0)
    expect(mocks.apiFetch).toHaveBeenCalledTimes(3)
    pending.resolve(response(200, [person('new-follower', false)]))
    await flush()
    expect(marks()).toHaveLength(0)
    expect(mocks.apiFetch).toHaveBeenCalledTimes(3)
  })

  it('refreshes marks for changed members without adding the creator to the lookup', async () => {
    await mount()
    expect(marks()).toHaveLength(4)
    mocks.getTask.mockResolvedValue({ kind: 'ok', task: task({ assignees: [], followers: ['new-follower'] }) })
    mocks.apiFetch.mockResolvedValueOnce(response(200, [person('new-follower', false)]))
    await refreshDetail()
    expect(rows('assignee')).toHaveLength(0)
    expect(rows('follower')).toHaveLength(1)
    expect(marks()).toHaveLength(1)
    expect(mocks.apiFetch).toHaveBeenLastCalledWith('/api/tasks/people?ids=new-follower')
  })

  it('resolves more than fifty members in parts without losing follower marks', async () => {
    const ids = Array.from({ length: 56 }, (_, index) => `person-${index}`)
    mocks.getTask.mockResolvedValue({ kind: 'ok', task: task({
      assignees: ids.slice(0, 50).map((userId) => ({ userId, completedAt: null })),
      followers: [ids[0], ...ids.slice(50)],
    }) })
    mocks.apiFetch.mockImplementation(async (url: string) => {
      const requested = new URLSearchParams(url.split('?')[1]).get('ids')!.split(',')
      return response(200, requested.map((id) => person(id, false)))
    })
    await mount()
    expect(mocks.apiFetch.mock.calls.map(([url]) => new URLSearchParams(String(url).split('?')[1]).get('ids')!.split(','))).toEqual([ids.slice(0, 50), ids.slice(50)])
    expect(rows('assignee').every((row) => marks(row).length === 1)).toBe(true)
    expect(rows('follower').every((row) => marks(row).length === 1)).toBe(true)
  })

  it('discards a pending lookup after navigating to another task', async () => {
    await mount()
    expect(marks()).toHaveLength(4)
    const pending = deferred<Response>()
    mocks.apiFetch.mockReturnValueOnce(pending.promise)
    await refreshWithNewFollower()
    mocks.getTask.mockResolvedValue({ kind: 'ok', task: task({ id: 'task-b', followers: ['blocked', 'watcher', 'unknown', 'new-follower'] }) })
    mocks.apiFetch.mockResolvedValue(response(200, []))
    await router.push('/tasks/task-b')
    await flush()
    pending.resolve(response(200, [person('new-follower', false)]))
    await flush()
    expect(marks()).toHaveLength(0)
    expect(rows('assignee')).toHaveLength(4)
    expect(rows('follower')).toHaveLength(4)
    expect(mocks.apiFetch).toHaveBeenCalledTimes(3)
  })

  it.each(['session', 'storage', 'unobserved'])('discards access after a %s identity change', async (signal) => {
    await mount()
    expect(marks()).toHaveLength(4)
    const pending = deferred<Response>()
    if (signal === 'unobserved') {
      mocks.apiFetch.mockReturnValueOnce(pending.promise)
      await refreshWithNewFollower()
    }
    mocks.identity = 'viewer-b'
    window.localStorage.setItem('auth_token', 'test-session-b')
    if (signal === 'session') notifyAuthPrincipalChange()
    if (signal === 'storage') window.dispatchEvent(new Event('storage'))
    pending.resolve(response())
    await flush()
    expect(marks()).toHaveLength(0)
  })

  it('does not send remaining lookup parts after unmount', async () => {
    const pending = deferred<Response>()
    mocks.getTask.mockResolvedValue({ kind: 'ok', task: task({
      followers: Array.from({ length: 56 }, (_, index) => `follower-${index}`),
    }) })
    mocks.apiFetch.mockReturnValue(pending.promise)
    await mount()
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
    app!.unmount()
    app = null
    pending.resolve(response())
    await flush()
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
  })
})
