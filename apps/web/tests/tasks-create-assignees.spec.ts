import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'

const mocks = vi.hoisted(() => ({
  loadTasksContext: vi.fn(),
  listTasks: vi.fn(),
  getTask: vi.fn(),
  listComments: vi.fn(),
  listAllTaskLists: vi.fn(),
  getCurrentUserId: vi.fn(),
  createTask: vi.fn(),
  addAssignee: vi.fn(),
  searchPeople: vi.fn(),
  notifyTasksChanged: vi.fn(),
  identity: 'viewer-a',
}))

vi.mock('../src/tasks/tasksContext', () => ({ loadTasksContext: mocks.loadTasksContext }))
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({ getCurrentUserId: mocks.getCurrentUserId }),
}))
vi.mock('../src/tasks/recordTaskDispatchIdentity', () => ({
  readDispatchIdentity: () => mocks.identity,
}))
vi.mock('../src/tasks/tasksApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/tasks/tasksApi')>()),
  listTasks: mocks.listTasks,
  getTask: mocks.getTask,
  listComments: mocks.listComments,
  listAllTaskLists: mocks.listAllTaskLists,
  createTask: mocks.createTask,
  addAssignee: mocks.addAssignee,
  searchPeople: mocks.searchPeople,
}))
vi.mock('../src/tasks/tasksBadgeBus', () => ({ notifyTasksChanged: mocks.notifyTasksChanged }))
vi.mock('../src/views/tasks/TaskListsSidebar.vue', () => ({ default: { render: () => null } }))
vi.mock('../src/views/tasks/TaskPersonalGroups.vue', () => ({ default: { render: () => null } }))
vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({ isZh, locale: ref('zh-CN'), setLocale: vi.fn() }),
}))

import { TASKS_EN, TASKS_ZH } from '../src/tasks/labels'
import { viewListsNewTask } from '../src/tasks/tasksStatusFilter'
import TasksView from '../src/views/tasks/TasksView.vue'

const isZh = ref(true)
let app: App | null = null
let host: HTMLElement | null = null
let router: Router

const people = [
  { id: 'creator', name: '林青', detail: '', canUseTasks: true },
  { id: 'person-a', name: '张三', detail: '', canUseTasks: true },
  { id: 'person-b', name: '李四', detail: '', canUseTasks: true },
  { id: 'person-blocked', name: '王五', detail: '', canUseTasks: false },
]

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
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

async function type(id: string, value: string): Promise<void> {
  const input = control<HTMLInputElement>(id)
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flush()
}

async function openPicker(): Promise<void> {
  control<HTMLButtonElement>('tasks-create-pick-assignees').click()
  await flush()
  await type('task-people-picker-search', '人')
  await vi.advanceTimersByTimeAsync(300)
  await flush()
}

function personCheck(id: string): HTMLInputElement {
  const input = host!.querySelector<HTMLInputElement>(`[data-testid="task-people-picker-row"][data-person-id="${id}"] input`)
  expect(input).not.toBeNull()
  return input!
}

async function pick(...ids: string[]): Promise<void> {
  await openPicker()
  for (const id of ids) personCheck(id).click()
  await flush()
  control<HTMLButtonElement>('task-people-picker-confirm').click()
  await flush()
}

async function toggleSelf(): Promise<void> {
  control<HTMLInputElement>('tasks-create-assign-self').click()
  await flush()
}

async function submit(): Promise<void> {
  await type('tasks-create-title', 'Review drawings')
  control<HTMLFormElement>('tasks-create-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  window.localStorage.clear()
  isZh.value = true
  mocks.identity = 'viewer-a'
  mocks.loadTasksContext.mockResolvedValue({ state: 'ready', orgId: 'org-a' })
  mocks.listTasks.mockResolvedValue({ kind: 'ok', items: [], total: 0 })
  mocks.getTask.mockResolvedValue({ kind: 'not_found' })
  mocks.listComments.mockResolvedValue({ kind: 'ok', items: [], total: 0 })
  mocks.listAllTaskLists.mockResolvedValue({ kind: 'ok', items: [], total: 0 })
  mocks.getCurrentUserId.mockResolvedValue('creator')
  mocks.createTask.mockResolvedValue({ kind: 'ok', id: 'new-task' })
  mocks.searchPeople.mockResolvedValue({ kind: 'ok', items: people, hasMore: false, requiresQuery: false })
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.useRealTimers()
  window.localStorage.clear()
})

describe('Choosing assignees when creating a task', () => {
  it('starts with Me checked and keeps the default create request until people are added', async () => {
    await mount()
    expect(control<HTMLInputElement>('tasks-create-assign-self').checked).toBe(true)
    expect(mocks.searchPeople).not.toHaveBeenCalled()
    await submit()
    expect(mocks.createTask).toHaveBeenCalledTimes(1)
    expect(mocks.createTask).toHaveBeenCalledWith({ title: 'Review drawings', completionMode: 'all' })
  })

  it('can remove the creator and create with nobody assigned', async () => {
    await mount()
    await toggleSelf()
    await submit()
    expect(mocks.createTask).toHaveBeenCalledTimes(1)
    expect(mocks.createTask).toHaveBeenCalledWith({ title: 'Review drawings', completionMode: 'all', assignees: [] })
    expect(query('tasks-create-hidden-notice')).not.toBeNull()
    expect(control('tasks-create-hidden-text').textContent).toBe(TASKS_ZH.createdHiddenByView)
    expect(query('tasks-create-hidden-show-open')).toBeNull()
    expect(control<HTMLAnchorElement>('tasks-create-hidden-open-task').getAttribute('href')).toBe('/tasks/new-task')
  })

  it('submits the creator and all chosen people together, displaying their names', async () => {
    await mount()
    await pick('person-a', 'person-b')
    expect(host!.querySelectorAll('[data-testid="tasks-create-assignee"]')).toHaveLength(2)
    expect(control('tasks-create-form').textContent).toContain('张三')
    expect(control('tasks-create-form').textContent).toContain('李四')
    expect(mocks.createTask).not.toHaveBeenCalled()
    expect(mocks.addAssignee).not.toHaveBeenCalled()
    await submit()
    expect(mocks.createTask).toHaveBeenCalledTimes(1)
    expect(mocks.createTask).toHaveBeenCalledWith({ title: 'Review drawings', completionMode: 'all', assignees: ['creator', 'person-a', 'person-b'] })
    expect(mocks.addAssignee).not.toHaveBeenCalled()
    expect(mocks.notifyTasksChanged).toHaveBeenCalledTimes(1)
  })

  it('keeps only the chosen people when Me is unchecked', async () => {
    await mount()
    await pick('person-a')
    await toggleSelf()
    await submit()
    expect(mocks.createTask.mock.calls[0][0].assignees).toEqual(['person-a'])
  })

  it('merges repeated picks and treats choosing the creator as selecting Me', async () => {
    await mount()
    await toggleSelf()
    await pick('person-a')
    await pick('creator', 'person-a', 'person-b')
    expect(control<HTMLInputElement>('tasks-create-assign-self').checked).toBe(true)
    expect(host!.querySelectorAll('[data-testid="tasks-create-assignee"]')).toHaveLength(2)
    await submit()
    expect(mocks.createTask.mock.calls[0][0].assignees).toEqual(['creator', 'person-a', 'person-b'])
  })

  it('removes a chosen person without changing the remaining selection', async () => {
    await mount()
    await pick('person-a', 'person-b')
    const remove = host!.querySelector<HTMLButtonElement>('[data-testid="tasks-create-assignee"][data-person-id="person-a"] button')!
    remove.click()
    await flush()
    await submit()
    expect(mocks.createTask.mock.calls[0][0].assignees).toEqual(['creator', 'person-b'])
  })

  it('marks people without task access and never adds them to the draft', async () => {
    await mount()
    await openPicker()
    expect(personCheck('person-blocked').disabled).toBe(true)
    expect(control('task-people-picker-no-access').textContent).toBe(TASKS_ZH.peopleCannotUseTasks)
    personCheck('person-blocked').click()
    personCheck('person-a').click()
    await flush()
    control<HTMLButtonElement>('task-people-picker-confirm').click()
    await flush()
    await submit()
    expect(mocks.createTask.mock.calls[0][0].assignees).toEqual(['creator', 'person-a'])
  })

  it('cancels unconfirmed picks and returns focus to the picker button', async () => {
    await mount()
    await pick('person-a')
    await openPicker()
    personCheck('person-b').click()
    await flush()
    control<HTMLButtonElement>('task-people-picker-cancel').click()
    await flush()
    expect(document.activeElement).toBe(control('tasks-create-pick-assignees'))
    await submit()
    expect(mocks.createTask.mock.calls[0][0].assignees).toEqual(['creator', 'person-a'])
  })

  it('keeps the selected people after a failed create and retries the same draft', async () => {
    mocks.createTask.mockResolvedValueOnce({ kind: 'validation', code: 'INACTIVE_ORG_MEMBER' })
    await mount()
    await pick('person-a')
    await toggleSelf()
    await submit()
    expect(query('tasks-create-error')).not.toBeNull()
    expect(control<HTMLInputElement>('tasks-create-title').value).toBe('Review drawings')
    expect(control<HTMLInputElement>('tasks-create-assign-self').checked).toBe(false)
    expect(control('tasks-create-assignee').textContent).toContain('张三')
    await submit()
    expect(mocks.createTask.mock.calls.map(([input]) => input.assignees)).toEqual([['person-a'], ['person-a']])
  })

  it('resets the next task to Me after a successful create', async () => {
    await mount()
    await pick('person-a')
    await toggleSelf()
    await submit()
    expect(control<HTMLInputElement>('tasks-create-assign-self').checked).toBe(true)
    expect(query('tasks-create-assignee')).toBeNull()
    expect(control<HTMLInputElement>('tasks-create-title').value).toBe('')
    await submit()
    expect(mocks.createTask.mock.calls[1][0]).toEqual({ title: 'Review drawings', completionMode: 'all' })
  })

  it('disables selection during creation and submits only once', async () => {
    const pending = deferred<{ kind: 'ok'; id: string }>()
    mocks.createTask.mockReturnValue(pending.promise)
    await mount()
    await pick('person-a')
    await submit()
    for (const id of ['tasks-create-assign-self', 'tasks-create-assignee-remove', 'tasks-create-pick-assignees']) {
      expect(control(id).matches(':disabled')).toBe(true)
    }
    await submit()
    expect(mocks.createTask).toHaveBeenCalledTimes(1)
    pending.resolve({ kind: 'ok', id: 'new-task' })
    await flush()
    expect(control('tasks-create-pick-assignees').matches(':disabled')).toBe(false)
  })

  it('keeps default and empty selection usable when the current user cannot be identified', async () => {
    mocks.getCurrentUserId.mockResolvedValue(null)
    await mount()
    expect(control<HTMLButtonElement>('tasks-create-pick-assignees').disabled).toBe(true)
    expect(host!.textContent).toContain(TASKS_ZH.createPeopleUnavailable)
    await submit()
    expect(mocks.createTask.mock.calls[0][0]).not.toHaveProperty('assignees')
    await toggleSelf()
    await submit()
    expect(mocks.createTask.mock.calls[1][0].assignees).toEqual([])
  })

  it('clears chosen names on an account change and uses the new creator for later picks', async () => {
    await mount()
    await pick('person-a')
    await openPicker()
    mocks.identity = 'viewer-b'
    mocks.getCurrentUserId.mockResolvedValue('creator-b')
    window.dispatchEvent(new Event('storage'))
    await flush()
    expect(query('task-people-picker')).toBeNull()
    expect(query('tasks-create-assignee')).toBeNull()
    await pick('person-b')
    await submit()
    expect(mocks.createTask.mock.calls[0][0].assignees).toEqual(['creator-b', 'person-b'])
  })

  it('re-reads Me after an account change when the cached user still belongs to the previous account', async () => {
    await mount()
    mocks.identity = 'viewer-b'
    mocks.getCurrentUserId.mockImplementation((force = false) => Promise.resolve(force ? 'creator-b' : 'creator'))
    window.dispatchEvent(new Event('storage'))
    await flush()
    await pick('person-a')
    await submit()
    expect(mocks.getCurrentUserId).toHaveBeenLastCalledWith(true)
    expect(mocks.createTask).toHaveBeenCalledTimes(1)
    expect(mocks.createTask.mock.calls[0][0].assignees).toEqual(['creator-b', 'person-a'])
  })

  it.each([
    { kind: 'invalid_title' },
    { kind: 'validation', code: 'INACTIVE_ORG_MEMBER' },
  ])('shows the create error after a silent account change following $kind', async (failure) => {
    mocks.createTask.mockResolvedValueOnce(failure)
    await mount()
    await pick('person-a')
    await submit()
    expect(query('tasks-create-error')).not.toBeNull()
    mocks.identity = 'viewer-b'
    mocks.getCurrentUserId.mockResolvedValue('creator-b')
    await submit()
    expect(mocks.createTask).toHaveBeenCalledTimes(1)
    expect(control('tasks-create-error').textContent).toBe(TASKS_ZH.createFailed)
    expect(control<HTMLInputElement>('tasks-create-title').value).toBe('Review drawings')
    expect(query('tasks-create-assignee')).toBeNull()
    await pick('person-b')
    await submit()
    expect(mocks.createTask).toHaveBeenCalledTimes(2)
    expect(mocks.createTask.mock.calls[1][0].assignees).toEqual(['creator-b', 'person-b'])
    expect(query('tasks-create-error')).toBeNull()
  })

  it('ignores a previous account lookup that finishes after the account changes', async () => {
    const pending = deferred<string | null>()
    mocks.getCurrentUserId.mockReturnValueOnce(pending.promise)
    await mount()
    expect(control<HTMLButtonElement>('tasks-create-pick-assignees').disabled).toBe(true)
    mocks.identity = 'viewer-b'
    mocks.getCurrentUserId.mockResolvedValue('creator-b')
    window.dispatchEvent(new Event('storage'))
    await flush()
    pending.resolve('creator')
    await flush()
    await pick('person-a')
    await submit()
    expect(mocks.createTask.mock.calls[0][0].assignees).toEqual(['creator-b', 'person-a'])
  })

  it('closes the picker on navigation and keeps the confirmed draft on return', async () => {
    await mount()
    await pick('person-a')
    await openPicker()
    await router.push('/tasks/existing-task')
    await flush()
    expect(query('task-people-picker')).toBeNull()
    await router.push('/tasks')
    await flush()
    expect(query('task-people-picker')).toBeNull()
    expect(control('tasks-create-assignee').textContent).toContain('张三')
  })

  it('updates the assignee labels when the language changes', async () => {
    await mount()
    expect(control('tasks-create-form').textContent).toContain(TASKS_ZH.createAssigneesLabel)
    isZh.value = false
    await flush()
    expect(control('tasks-create-form').textContent).toContain(TASKS_EN.createAssigneesLabel)
    expect(control('tasks-create-assign-self').parentElement!.textContent?.trim()).toBe(TASKS_EN.createAssignSelf)
    expect(control('tasks-create-pick-assignees').textContent).toBe(TASKS_EN.pickAssignee)
  })

  it.each([
    ['following', true],
    ['delegated', true],
    ['following', false],
    ['delegated', false],
  ] as const)('names only the view for a default create in %s with Chinese enabled %s', async (view, chinese) => {
    isZh.value = chinese
    await mount()
    control<HTMLButtonElement>(`tasks-view-switch-${view}`).click()
    await flush()
    await submit()
    expect(mocks.createTask).toHaveBeenCalledWith({ title: 'Review drawings', completionMode: 'all' })
    expect(control('tasks-create-hidden-text').textContent).toBe((chinese ? TASKS_ZH : TASKS_EN).createdHiddenByView)
    expect(query('tasks-create-hidden-show-open')).toBeNull()
    expect(control<HTMLAnchorElement>('tasks-create-hidden-open-task').getAttribute('href')).toBe('/tasks/new-task')
  })

  it('offers the incomplete filter for a task delegated to another person', async () => {
    window.localStorage.setItem('metasheet.tasks.statusFilter', 'done')
    await mount()
    control<HTMLButtonElement>('tasks-view-switch-delegated').click()
    await flush()
    await pick('person-a')
    await submit()
    expect(query('tasks-create-hidden-show-open')).not.toBeNull()
    expect(control('tasks-create-hidden-text').textContent).toBe(TASKS_ZH.createdHiddenByFilter)
  })

  it('does not offer the incomplete filter when the creator was removed from Assigned to me', async () => {
    window.localStorage.setItem('metasheet.tasks.statusFilter', 'done')
    await mount()
    await pick('person-a')
    await toggleSelf()
    await submit()
    expect(query('tasks-create-hidden-show-open')).toBeNull()
    expect(control('tasks-create-hidden-text').textContent).toBe(TASKS_ZH.createdHiddenByViewAndFilter)
  })
})

describe('New task visibility for the chosen assignees', () => {
  it.each([
    [true, false, true, false],
    [false, false, false, false],
    [true, true, true, true],
    [false, true, false, true],
  ])('handles creator selected %s and others selected %s', (creator, others, assigned, delegated) => {
    expect(viewListsNewTask('assigned', creator, others)).toBe(assigned)
    expect(viewListsNewTask('delegated', creator, others)).toBe(delegated)
    expect(viewListsNewTask('following', creator, others)).toBe(false)
    expect(viewListsNewTask('created', creator, others)).toBe(true)
    expect(viewListsNewTask('any_role', creator, others)).toBe(true)
  })
})
