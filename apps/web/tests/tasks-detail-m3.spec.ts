import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'

/**
 * M3 frontend — `/tasks/:id` detail surface additions (backend contract
 * `docs/development/task-m3-backend-design-20260928.md`): subtasks/parent, assignee/follower
 * membership, completion-mode switch, comments, delete. The backend is NOT implemented yet —
 * every call below is mocked; see tasks-api-m3.spec.ts for the wire-level contract coverage.
 *
 * Mounted through a REAL router (same idiom as tasks-detail-view.spec.ts): the delete action's
 * navigation to `/tasks` needs a real `useRouter()`, and the late-result guard below needs Vue to
 * reuse the SAME component instance across a route change.
 */

const h_ = vi.hoisted(() => ({
  loadTasksContext: vi.fn(),
  getTask: vi.fn(),
  listTasks: vi.fn(),
  createTask: vi.fn(),
  completeTask: vi.fn(),
  reopenTask: vi.fn(),
  notifyTasksChanged: vi.fn(),
  listComments: vi.fn(),
  getCurrentUserId: vi.fn(),
  setParent: vi.fn(),
  addAssignee: vi.fn(),
  removeAssignee: vi.fn(),
  setCompletionMode: vi.fn(),
  addFollower: vi.fn(),
  removeFollower: vi.fn(),
  leaveTask: vi.fn(),
  createComment: vi.fn(),
  editComment: vi.fn(),
  deleteComment: vi.fn(),
  deleteTask: vi.fn(),
}))

vi.mock('../src/tasks/tasksContext', () => ({
  loadTasksContext: h_.loadTasksContext,
}))

vi.mock('../src/tasks/tasksApi', async () => {
  const actual = await vi.importActual<typeof import('../src/tasks/tasksApi')>('../src/tasks/tasksApi')
  return {
    // `checkCommentBody` is the REAL implementation — it is a pure function this file wants to
    // exercise through the UI exactly as production does, not re-stub.
    checkCommentBody: actual.checkCommentBody,
    getTask: h_.getTask,
    listTasks: h_.listTasks,
    createTask: h_.createTask,
    completeTask: h_.completeTask,
    reopenTask: h_.reopenTask,
    listComments: h_.listComments,
    setParent: h_.setParent,
    addAssignee: h_.addAssignee,
    removeAssignee: h_.removeAssignee,
    setCompletionMode: h_.setCompletionMode,
    addFollower: h_.addFollower,
    removeFollower: h_.removeFollower,
    leaveTask: h_.leaveTask,
    createComment: h_.createComment,
    editComment: h_.editComment,
    deleteComment: h_.deleteComment,
    deleteTask: h_.deleteTask,
  }
})

vi.mock('../src/tasks/tasksBadgeBus', () => ({
  notifyTasksChanged: h_.notifyTasksChanged,
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({ getCurrentUserId: h_.getCurrentUserId }),
}))

import TasksView from '../src/views/tasks/TasksView.vue'

interface TaskChildFixture {
  id: string
  title: string
  status: 'open' | 'done'
  completionMode: 'all' | 'any'
  depth: number
}

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
  parentId: string | null
  depth: number
  children: TaskChildFixture[]
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
    parentId: null,
    depth: 0,
    children: [],
    ...over,
  }
}

function comment(over: Partial<{
  id: string
  taskId: string
  authorId: string
  body: string | null
  deleted: boolean
  createdAt: string
}> = {}) {
  return {
    id: 'c1',
    taskId: 't1',
    authorId: 'u1',
    body: 'hello',
    deleted: false,
    createdAt: '2026-09-28T00:00:00.000Z',
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

async function flush(cycles = 8): Promise<void> {
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

function shownAll(el: HTMLElement, testid: string): HTMLElement[] {
  return Array.from(el.querySelectorAll(`[data-testid="${testid}"]`))
}

beforeEach(() => {
  h_.loadTasksContext.mockReset().mockResolvedValue({ state: 'ready', orgId: 'org1' })
  h_.getTask.mockReset().mockResolvedValue({ kind: 'ok', task: taskDetail() })
  h_.listTasks.mockReset().mockResolvedValue({ kind: 'ok', items: [] })
  h_.createTask.mockReset()
  h_.completeTask.mockReset()
  h_.reopenTask.mockReset()
  h_.notifyTasksChanged.mockReset()
  h_.listComments.mockReset().mockResolvedValue({ kind: 'ok', items: [], total: 0 })
  h_.getCurrentUserId.mockReset().mockResolvedValue(null)
  h_.setParent.mockReset()
  h_.addAssignee.mockReset()
  h_.removeAssignee.mockReset()
  h_.setCompletionMode.mockReset()
  h_.addFollower.mockReset()
  h_.removeFollower.mockReset()
  h_.leaveTask.mockReset()
  h_.createComment.mockReset()
  h_.editComment.mockReset()
  h_.deleteComment.mockReset()
  h_.deleteTask.mockReset()
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
  router = null
})

// ---------------------------------------------------------------------------------------------
// Subtasks / parent (§3.1, §3.2)
// ---------------------------------------------------------------------------------------------

describe('TasksView detail — subtasks section', () => {
  it('renders depth, the parent link, and each child as a link, and 暂无子任务 when there are none', async () => {
    h_.getTask.mockResolvedValue({
      kind: 'ok',
      task: taskDetail({
        parentId: 'p1',
        depth: 2,
        children: [
          { id: 'c1', title: 'Child One', status: 'open', completionMode: 'all', depth: 3 },
          { id: 'c2', title: 'Child Two', status: 'done', completionMode: 'any', depth: 3 },
        ],
      }),
    })
    const el = await mountAt('/tasks/t1')

    expect(shown(el, 'tasks-detail-depth')?.textContent).toContain('2')
    const parentLink = shown(el, 'tasks-detail-parent')?.querySelector('a')
    expect(parentLink?.getAttribute('href')).toBe('/tasks/p1')
    expect(parentLink?.textContent).toBe('p1')

    const children = shownAll(el, 'tasks-detail-child')
    expect(children).toHaveLength(2)
    expect(children[0].querySelector('a')?.getAttribute('href')).toBe('/tasks/c1')
    expect(children[0].textContent).toContain('Child One')
    expect(children[1].textContent).toContain('Child Two')
    expect(children[1].textContent).toContain('已完成')
    expect(shown(el, 'tasks-detail-children-empty')).toBeNull()
  })

  it('shows 暂无子任务 and no parent link for a root task with no children', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ parentId: null, children: [] }) })
    const el = await mountAt('/tasks/t1')

    expect(shown(el, 'tasks-detail-children-empty')).toBeTruthy()
    expect(shown(el, 'tasks-detail-parent')).toBeNull()
    expect(shown(el, 'tasks-detail-make-independent')).toBeNull()
  })

  it('shows the "make independent" button only when the task has a parent', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ parentId: 'p1' }) })
    const el = await mountAt('/tasks/t1')
    expect(shown(el, 'tasks-detail-make-independent')).toBeTruthy()
  })

  it('submitting the set-parent form calls setParent with the trimmed input, then reloads and notifies on success', async () => {
    h_.setParent.mockResolvedValue({ kind: 'ok', id: 't1', parentId: 'p9', depth: 1 })
    const el = await mountAt('/tasks/t1')

    const input = shown(el, 'tasks-detail-set-parent-input') as HTMLInputElement
    input.value = '  p9  '
    input.dispatchEvent(new Event('input'))
    await flush()
    ;(shown(el, 'tasks-detail-set-parent-submit') as HTMLButtonElement).click()
    await flush()

    expect(h_.setParent).toHaveBeenCalledWith('t1', 'p9')
    expect(h_.notifyTasksChanged).toHaveBeenCalledTimes(1)
    expect(h_.getTask).toHaveBeenCalledTimes(2)
    expect((shown(el, 'tasks-detail-set-parent-input') as HTMLInputElement).value).toBe('')
  })

  it('clicking "make independent" calls setParent with null', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ parentId: 'p1' }) })
    h_.setParent.mockResolvedValue({ kind: 'ok', id: 't1', parentId: null, depth: 0 })
    const el = await mountAt('/tasks/t1')

    ;(shown(el, 'tasks-detail-make-independent') as HTMLButtonElement).click()
    await flush()

    expect(h_.setParent).toHaveBeenCalledWith('t1', null)
  })

  it('shows the exact 无效的父任务 message for INVALID_PARENT, not the DEPTH_EXCEEDED message', async () => {
    h_.setParent.mockResolvedValue({ kind: 'validation', code: 'INVALID_PARENT' })
    const el = await mountAt('/tasks/t1')

    const input = shown(el, 'tasks-detail-set-parent-input') as HTMLInputElement
    input.value = 'bad'
    input.dispatchEvent(new Event('input'))
    await flush()
    ;(shown(el, 'tasks-detail-set-parent-submit') as HTMLButtonElement).click()
    await flush()

    expect(shown(el, 'tasks-detail-parent-error')?.textContent).toBe('无效的父任务')
  })

  it('shows the exact 任务层级已达上限 message for DEPTH_EXCEEDED, not the INVALID_PARENT message', async () => {
    h_.setParent.mockResolvedValue({ kind: 'validation', code: 'DEPTH_EXCEEDED' })
    const el = await mountAt('/tasks/t1')

    const input = shown(el, 'tasks-detail-set-parent-input') as HTMLInputElement
    input.value = 'deep'
    input.dispatchEvent(new Event('input'))
    await flush()
    ;(shown(el, 'tasks-detail-set-parent-submit') as HTMLButtonElement).click()
    await flush()

    expect(shown(el, 'tasks-detail-parent-error')?.textContent).toBe('任务层级已达上限')
  })

  it('an org_missing (422) setParent result replaces the detail with the org-guidance block', async () => {
    h_.setParent.mockResolvedValue({ kind: 'org_missing' })
    const el = await mountAt('/tasks/t1')

    const input = shown(el, 'tasks-detail-set-parent-input') as HTMLInputElement
    input.value = 'p1'
    input.dispatchEvent(new Event('input'))
    await flush()
    ;(shown(el, 'tasks-detail-set-parent-submit') as HTMLButtonElement).click()
    await flush()

    expect(shown(el, 'tasks-view-org-missing')).toBeTruthy()
    expect(shown(el, 'tasks-detail')).toBeNull()
  })

  it('a forbidden setParent result shows the generic tasks-action-error banner', async () => {
    h_.setParent.mockResolvedValue({ kind: 'forbidden' })
    const el = await mountAt('/tasks/t1')

    const input = shown(el, 'tasks-detail-set-parent-input') as HTMLInputElement
    input.value = 'p1'
    input.dispatchEvent(new Event('input'))
    await flush()
    ;(shown(el, 'tasks-detail-set-parent-submit') as HTMLButtonElement).click()
    await flush()

    expect(shown(el, 'tasks-action-error')?.textContent).toBe('您没有权限修改此任务')
  })

  it('disables every detail action button while setParent is pending (shared detailActionPending)', async () => {
    const pending = deferred<{ kind: 'ok'; id: string; parentId: string | null; depth: number }>()
    h_.setParent.mockReturnValue(pending.promise)
    const el = await mountAt('/tasks/t1')

    const input = shown(el, 'tasks-detail-set-parent-input') as HTMLInputElement
    input.value = 'p1'
    input.dispatchEvent(new Event('input'))
    await flush()
    ;(shown(el, 'tasks-detail-set-parent-submit') as HTMLButtonElement).click()
    await flush()

    expect((shown(el, 'tasks-detail-set-parent-submit') as HTMLButtonElement).disabled).toBe(true)
    // `tasks-detail-add-assignee-submit` is ALSO conditioned on its own input being non-empty —
    // it stays disabled here regardless of `detailActionPending`, so it is not a useful re-enable
    // probe. `tasks-detail-comment-submit` has no such second condition (only `detailActionPending`
    // gates it), so it isolates the ONE thing this test is about.
    expect((shown(el, 'tasks-detail-add-assignee-submit') as HTMLButtonElement).disabled).toBe(true)
    expect((shown(el, 'tasks-detail-delete') as HTMLButtonElement).disabled).toBe(true)
    expect((shown(el, 'tasks-detail-comment-submit') as HTMLButtonElement).disabled).toBe(true)

    pending.resolve({ kind: 'ok', id: 't1', parentId: 'p1', depth: 1 })
    await flush()

    expect((shown(el, 'tasks-detail-comment-submit') as HTMLButtonElement).disabled).toBe(false)
    expect((shown(el, 'tasks-detail-delete') as HTMLButtonElement).disabled).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// Assignees / completion mode (§3.3, §3.4)
// ---------------------------------------------------------------------------------------------

describe('TasksView detail — assignees and completion mode', () => {
  it('adding an assignee calls addAssignee, reloads, notifies, and clears the input', async () => {
    h_.addAssignee.mockResolvedValue({ kind: 'ok', task: { id: 't1', status: 'open', completionMode: 'all', assignees: [{ userId: 'u9', completedAt: null }] } })
    h_.getTask.mockResolvedValueOnce({ kind: 'ok', task: taskDetail() })
      .mockResolvedValue({ kind: 'ok', task: taskDetail({ assignees: [{ userId: 'u9', completedAt: null }] }) })
    const el = await mountAt('/tasks/t1')

    const input = shown(el, 'tasks-detail-add-assignee-input') as HTMLInputElement
    input.value = 'u9'
    input.dispatchEvent(new Event('input'))
    await flush()
    ;(shown(el, 'tasks-detail-add-assignee-submit') as HTMLButtonElement).click()
    await flush()

    expect(h_.addAssignee).toHaveBeenCalledWith('t1', 'u9')
    expect(h_.notifyTasksChanged).toHaveBeenCalledTimes(1)
    expect(el.textContent).toContain('u9')
    expect((shown(el, 'tasks-detail-add-assignee-input') as HTMLInputElement).value).toBe('')
  })

  it('clicking remove on an assignee row calls removeAssignee with that row\'s userId', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ assignees: [{ userId: 'u1', completedAt: null }, { userId: 'u2', completedAt: null }] }) })
    h_.removeAssignee.mockResolvedValue({ kind: 'ok', task: { id: 't1', status: 'open', completionMode: 'all', assignees: [{ userId: 'u1', completedAt: null }] } })
    const el = await mountAt('/tasks/t1')

    const rows = shownAll(el, 'tasks-detail-assignee')
    ;(rows[1].querySelector('[data-testid="tasks-detail-assignee-remove"]') as HTMLButtonElement).click()
    await flush()

    expect(h_.removeAssignee).toHaveBeenCalledWith('t1', 'u2')
  })

  it('changing the completion-mode select calls setCompletionMode with the new mode', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ completionMode: 'all' }) })
    h_.setCompletionMode.mockResolvedValue({ kind: 'ok', task: { id: 't1', status: 'open', completionMode: 'any', assignees: [] } })
    const el = await mountAt('/tasks/t1')

    const select = shown(el, 'tasks-detail-completion-mode-select') as HTMLSelectElement
    select.value = 'any'
    select.dispatchEvent(new Event('change'))
    await flush()

    expect(h_.setCompletionMode).toHaveBeenCalledWith('t1', 'any')
  })

  it('selecting the SAME completion mode as current does not call setCompletionMode', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ completionMode: 'all' }) })
    const el = await mountAt('/tasks/t1')

    const select = shown(el, 'tasks-detail-completion-mode-select') as HTMLSelectElement
    select.value = 'all'
    select.dispatchEvent(new Event('change'))
    await flush()

    expect(h_.setCompletionMode).not.toHaveBeenCalled()
  })

  it('shows the exact 人数已达上限 message for a LIMIT validation on addAssignee', async () => {
    h_.addAssignee.mockResolvedValue({ kind: 'validation', code: 'LIMIT' })
    const el = await mountAt('/tasks/t1')

    const input = shown(el, 'tasks-detail-add-assignee-input') as HTMLInputElement
    input.value = 'u9'
    input.dispatchEvent(new Event('input'))
    await flush()
    ;(shown(el, 'tasks-detail-add-assignee-submit') as HTMLButtonElement).click()
    await flush()

    expect(shown(el, 'tasks-detail-membership-error')?.textContent).toBe('人数已达上限')
  })

  it('shows the exact 无效的用户 message for an INVALID_ASSIGNEES validation on addAssignee', async () => {
    h_.addAssignee.mockResolvedValue({ kind: 'validation', code: 'INVALID_ASSIGNEES' })
    const el = await mountAt('/tasks/t1')

    const input = shown(el, 'tasks-detail-add-assignee-input') as HTMLInputElement
    input.value = 'bad id'
    input.dispatchEvent(new Event('input'))
    await flush()
    ;(shown(el, 'tasks-detail-add-assignee-submit') as HTMLButtonElement).click()
    await flush()

    expect(shown(el, 'tasks-detail-membership-error')?.textContent).toBe('无效的用户')
  })

  it('shows the exact 无效的完成模式 message for an INVALID_MODE validation', async () => {
    h_.setCompletionMode.mockResolvedValue({ kind: 'validation', code: 'INVALID_MODE' })
    const el = await mountAt('/tasks/t1')

    const select = shown(el, 'tasks-detail-completion-mode-select') as HTMLSelectElement
    select.value = 'any'
    select.dispatchEvent(new Event('change'))
    await flush()

    expect(shown(el, 'tasks-detail-membership-error')?.textContent).toBe('无效的完成模式')
  })
})

// ---------------------------------------------------------------------------------------------
// Followers / leave (§3.5)
// ---------------------------------------------------------------------------------------------

describe('TasksView detail — followers and leave', () => {
  it('shows "关注人列表在有变更后才会显示" (not a list) until a follower response has been seen', async () => {
    const el = await mountAt('/tasks/t1')
    expect(shown(el, 'tasks-detail-followers-unknown')).toBeTruthy()
    expect(shown(el, 'tasks-detail-followers')).toBeNull()
    expect(shown(el, 'tasks-detail-leave')).toBeNull()
  })

  it('adding a follower calls addFollower and then renders the returned followers list', async () => {
    h_.addFollower.mockResolvedValue({ kind: 'ok', task: { id: 't1', followers: ['u5'] } })
    const el = await mountAt('/tasks/t1')

    const input = shown(el, 'tasks-detail-add-follower-input') as HTMLInputElement
    input.value = 'u5'
    input.dispatchEvent(new Event('input'))
    await flush()
    ;(shown(el, 'tasks-detail-add-follower-submit') as HTMLButtonElement).click()
    await flush()

    expect(h_.addFollower).toHaveBeenCalledWith('t1', 'u5')
    expect(shown(el, 'tasks-detail-followers-unknown')).toBeNull()
    expect(shownAll(el, 'tasks-detail-follower')).toHaveLength(1)
    expect(shown(el, 'tasks-detail-followers')?.textContent).toContain('u5')
    // A membership mutation reuses the SAME shared refresh path as parent/assignee actions —
    // notifyTasksChanged still fires even though followers has no `loadDetail` refresh.
    expect(h_.notifyTasksChanged).toHaveBeenCalledTimes(1)
  })

  it('shows the Leave button once the viewer\'s own id is confirmed IN the followers response', async () => {
    h_.getCurrentUserId.mockResolvedValue('viewer1')
    h_.addFollower.mockResolvedValue({ kind: 'ok', task: { id: 't1', followers: ['viewer1'] } })
    const el = await mountAt('/tasks/t1')

    const input = shown(el, 'tasks-detail-add-follower-input') as HTMLInputElement
    input.value = 'viewer1'
    input.dispatchEvent(new Event('input'))
    await flush()
    ;(shown(el, 'tasks-detail-add-follower-submit') as HTMLButtonElement).click()
    await flush()

    expect(shown(el, 'tasks-detail-leave')).toBeTruthy()
  })

  it('does NOT show Leave when a followers response exists but the viewer\'s id is not in it', async () => {
    h_.getCurrentUserId.mockResolvedValue('viewer1')
    h_.addFollower.mockResolvedValue({ kind: 'ok', task: { id: 't1', followers: ['someoneElse'] } })
    const el = await mountAt('/tasks/t1')

    const input = shown(el, 'tasks-detail-add-follower-input') as HTMLInputElement
    input.value = 'someoneElse'
    input.dispatchEvent(new Event('input'))
    await flush()
    ;(shown(el, 'tasks-detail-add-follower-submit') as HTMLButtonElement).click()
    await flush()

    expect(shown(el, 'tasks-detail-leave')).toBeNull()
  })

  it('does NOT show Leave when the viewer\'s own id could not be resolved, even with a followers response', async () => {
    h_.getCurrentUserId.mockResolvedValue(null)
    h_.addFollower.mockResolvedValue({ kind: 'ok', task: { id: 't1', followers: ['u1'] } })
    const el = await mountAt('/tasks/t1')

    const input = shown(el, 'tasks-detail-add-follower-input') as HTMLInputElement
    input.value = 'u1'
    input.dispatchEvent(new Event('input'))
    await flush()
    ;(shown(el, 'tasks-detail-add-follower-submit') as HTMLButtonElement).click()
    await flush()

    expect(shown(el, 'tasks-detail-leave')).toBeNull()
  })

  it('clicking remove on a follower row calls removeFollower with that row\'s userId', async () => {
    h_.getCurrentUserId.mockResolvedValue('viewer1')
    h_.addFollower.mockResolvedValue({ kind: 'ok', task: { id: 't1', followers: ['viewer1', 'u2'] } })
    h_.removeFollower.mockResolvedValue({ kind: 'ok', task: { id: 't1', followers: ['viewer1'] } })
    const el = await mountAt('/tasks/t1')

    const input = shown(el, 'tasks-detail-add-follower-input') as HTMLInputElement
    input.value = 'x'
    input.dispatchEvent(new Event('input'))
    await flush()
    ;(shown(el, 'tasks-detail-add-follower-submit') as HTMLButtonElement).click()
    await flush()

    const rows = shownAll(el, 'tasks-detail-follower')
    const u2Row = rows.find((row) => row.textContent?.includes('u2'))!
    ;(u2Row.querySelector('[data-testid="tasks-detail-follower-remove"]') as HTMLButtonElement).click()
    await flush()

    expect(h_.removeFollower).toHaveBeenCalledWith('t1', 'u2')
  })

  it('clicking Leave calls leaveTask and updates the followers list from the response', async () => {
    h_.getCurrentUserId.mockResolvedValue('viewer1')
    h_.addFollower.mockResolvedValue({ kind: 'ok', task: { id: 't1', followers: ['viewer1'] } })
    h_.leaveTask.mockResolvedValue({ kind: 'ok', task: { id: 't1', followers: [] } })
    const el = await mountAt('/tasks/t1')

    const input = shown(el, 'tasks-detail-add-follower-input') as HTMLInputElement
    input.value = 'viewer1'
    input.dispatchEvent(new Event('input'))
    await flush()
    ;(shown(el, 'tasks-detail-add-follower-submit') as HTMLButtonElement).click()
    await flush()
    expect(shown(el, 'tasks-detail-leave')).toBeTruthy()

    ;(shown(el, 'tasks-detail-leave') as HTMLButtonElement).click()
    await flush()

    expect(h_.leaveTask).toHaveBeenCalledWith('t1')
    expect(shown(el, 'tasks-detail-leave')).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// Comments (§3.6)
// ---------------------------------------------------------------------------------------------

describe('TasksView detail — comments', () => {
  it('renders a live comment\'s body and a tombstone as 已删除', async () => {
    h_.listComments.mockResolvedValue({
      kind: 'ok',
      items: [comment({ id: 'c1', body: 'hello there' }), comment({ id: 'c2', deleted: true, body: null })],
    })
    const el = await mountAt('/tasks/t1')

    const rows = shownAll(el, 'tasks-detail-comment')
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('[data-testid="tasks-detail-comment-body"]')?.textContent).toBe('hello there')
    expect(rows[1].querySelector('[data-testid="tasks-detail-comment-body"]')?.textContent).toBe('已删除')
  })

  it('a listComments error shows tasks-detail-comments-error WITHOUT blanking the rendered task', async () => {
    h_.listComments.mockResolvedValue({ kind: 'error', status: 500 })
    const el = await mountAt('/tasks/t1')

    expect(shown(el, 'tasks-detail-comments-error')).toBeTruthy()
    expect(shown(el, 'tasks-detail')).toBeTruthy()
    expect(shown(el, 'tasks-detail-title')).toBeTruthy()
  })

  it('submitting a non-blank comment calls createComment and appends it to the list on success', async () => {
    h_.createComment.mockResolvedValue({ kind: 'ok', comment: comment({ id: 'c9', body: 'new one' }) })
    const el = await mountAt('/tasks/t1')

    const textarea = shown(el, 'tasks-detail-comment-input') as HTMLTextAreaElement
    textarea.value = 'new one'
    textarea.dispatchEvent(new Event('input'))
    await flush()
    ;(shown(el, 'tasks-detail-comment-submit') as HTMLButtonElement).click()
    await flush()

    expect(h_.createComment).toHaveBeenCalledWith('t1', 'new one')
    expect(shownAll(el, 'tasks-detail-comment')).toHaveLength(1)
    expect((shown(el, 'tasks-detail-comment-input') as HTMLTextAreaElement).value).toBe('')
  })

  it('a blank comment is rejected CLIENT-SIDE — createComment is never called', async () => {
    const el = await mountAt('/tasks/t1')

    const textarea = shown(el, 'tasks-detail-comment-input') as HTMLTextAreaElement
    textarea.value = '   '
    textarea.dispatchEvent(new Event('input'))
    await flush()
    ;(shown(el, 'tasks-detail-comment-submit') as HTMLButtonElement).click()
    await flush()

    expect(h_.createComment).not.toHaveBeenCalled()
    expect(shown(el, 'tasks-detail-comment-error')?.textContent).toBe('评论内容不能为空')
  })

  it('a >5000-code-point comment is rejected CLIENT-SIDE — createComment is never called', async () => {
    const el = await mountAt('/tasks/t1')

    const textarea = shown(el, 'tasks-detail-comment-input') as HTMLTextAreaElement
    textarea.value = 'x'.repeat(5001)
    textarea.dispatchEvent(new Event('input'))
    await flush()
    ;(shown(el, 'tasks-detail-comment-submit') as HTMLButtonElement).click()
    await flush()

    expect(h_.createComment).not.toHaveBeenCalled()
    expect(shown(el, 'tasks-detail-comment-error')?.textContent).toBe('评论内容过长')
  })

  it('a SERVER-side COMMENT_TOO_LONG validation (defense in depth) shows the same exact message', async () => {
    h_.createComment.mockResolvedValue({ kind: 'validation', code: 'COMMENT_TOO_LONG' })
    const el = await mountAt('/tasks/t1')

    const textarea = shown(el, 'tasks-detail-comment-input') as HTMLTextAreaElement
    textarea.value = 'looks fine client-side'
    textarea.dispatchEvent(new Event('input'))
    await flush()
    ;(shown(el, 'tasks-detail-comment-submit') as HTMLButtonElement).click()
    await flush()

    expect(h_.createComment).toHaveBeenCalled()
    expect(shown(el, 'tasks-detail-comment-error')?.textContent).toBe('评论内容过长')
  })

  describe('own-comment gating (edit/delete)', () => {
    it('shows edit/delete ONLY on the viewer\'s own comment when the current-user id resolves', async () => {
      h_.getCurrentUserId.mockResolvedValue('viewer1')
      h_.listComments.mockResolvedValue({
        kind: 'ok',
        items: [comment({ id: 'mine', authorId: 'viewer1' }), comment({ id: 'theirs', authorId: 'someoneElse' })],
      })
      const el = await mountAt('/tasks/t1')

      const rows = shownAll(el, 'tasks-detail-comment')
      const mineRow = rows.find((r) => r.textContent?.includes('viewer1'))!
      const theirsRow = rows.find((r) => r.textContent?.includes('someoneElse'))!
      expect(mineRow.querySelector('[data-testid="tasks-detail-comment-edit"]')).toBeTruthy()
      expect(mineRow.querySelector('[data-testid="tasks-detail-comment-delete"]')).toBeTruthy()
      expect(theirsRow.querySelector('[data-testid="tasks-detail-comment-edit"]')).toBeNull()
      expect(theirsRow.querySelector('[data-testid="tasks-detail-comment-delete"]')).toBeNull()
    })

    it('falls back to showing edit/delete on EVERY comment when the viewer id cannot be resolved', async () => {
      h_.getCurrentUserId.mockResolvedValue(null)
      h_.listComments.mockResolvedValue({
        kind: 'ok',
        items: [comment({ id: 'a', authorId: 'someone' }), comment({ id: 'b', authorId: 'someoneElse' })],
      })
      const el = await mountAt('/tasks/t1')

      expect(shownAll(el, 'tasks-detail-comment-edit')).toHaveLength(2)
      expect(shownAll(el, 'tasks-detail-comment-delete')).toHaveLength(2)
    })

    it('never shows edit/delete on a tombstone, even for the viewer\'s own (fallback) comments', async () => {
      h_.getCurrentUserId.mockResolvedValue(null)
      h_.listComments.mockResolvedValue({ kind: 'ok', items: [comment({ id: 'a', deleted: true, body: null })] })
      const el = await mountAt('/tasks/t1')

      expect(shown(el, 'tasks-detail-comment-edit')).toBeNull()
      expect(shown(el, 'tasks-detail-comment-delete')).toBeNull()
    })

    it('while the viewer id is still resolving (pending), edit/delete are hidden on every comment', async () => {
      const pendingId = deferred<string | null>()
      h_.getCurrentUserId.mockReturnValue(pendingId.promise)
      h_.listComments.mockResolvedValue({ kind: 'ok', items: [comment({ id: 'a', authorId: 'u1' })] })
      const el = await mountAt('/tasks/t1')

      expect(shown(el, 'tasks-detail-comment-edit')).toBeNull()

      pendingId.resolve('u1')
      await flush()
      expect(shown(el, 'tasks-detail-comment-edit')).toBeTruthy()
    })
  })

  it('editing a comment: start edit, save calls editComment, and updates the row in place', async () => {
    h_.getCurrentUserId.mockResolvedValue('viewer1')
    h_.listComments.mockResolvedValue({ kind: 'ok', items: [comment({ id: 'c1', authorId: 'viewer1', body: 'old' })] })
    h_.editComment.mockResolvedValue({ kind: 'ok', comment: comment({ id: 'c1', authorId: 'viewer1', body: 'new' }) })
    const el = await mountAt('/tasks/t1')

    ;(shown(el, 'tasks-detail-comment-edit') as HTMLButtonElement).click()
    await flush()
    const editInput = shown(el, 'tasks-detail-comment-edit-input') as HTMLTextAreaElement
    expect(editInput.value).toBe('old')
    editInput.value = 'new'
    editInput.dispatchEvent(new Event('input'))
    await flush()
    ;(shown(el, 'tasks-detail-comment-edit-save') as HTMLButtonElement).click()
    await flush()

    expect(h_.editComment).toHaveBeenCalledWith('t1', 'c1', 'new')
    expect(shown(el, 'tasks-detail-comment-edit-input')).toBeNull()
    expect(shown(el, 'tasks-detail-comment-body')?.textContent).toBe('new')
  })

  it('cancel-editing discards the draft without calling editComment', async () => {
    h_.getCurrentUserId.mockResolvedValue('viewer1')
    h_.listComments.mockResolvedValue({ kind: 'ok', items: [comment({ id: 'c1', authorId: 'viewer1', body: 'old' })] })
    const el = await mountAt('/tasks/t1')

    ;(shown(el, 'tasks-detail-comment-edit') as HTMLButtonElement).click()
    await flush()
    ;(shown(el, 'tasks-detail-comment-edit-cancel') as HTMLButtonElement).click()
    await flush()

    expect(h_.editComment).not.toHaveBeenCalled()
    expect(shown(el, 'tasks-detail-comment-body')?.textContent).toBe('old')
  })

  it('deleting a comment calls deleteComment and replaces the row with the returned tombstone', async () => {
    h_.getCurrentUserId.mockResolvedValue('viewer1')
    h_.listComments.mockResolvedValue({ kind: 'ok', items: [comment({ id: 'c1', authorId: 'viewer1', body: 'bye' })] })
    h_.deleteComment.mockResolvedValue({ kind: 'ok', comment: comment({ id: 'c1', authorId: 'viewer1', deleted: true, body: null }) })
    const el = await mountAt('/tasks/t1')

    ;(shown(el, 'tasks-detail-comment-delete') as HTMLButtonElement).click()
    await flush()

    expect(h_.deleteComment).toHaveBeenCalledWith('t1', 'c1')
    expect(shown(el, 'tasks-detail-comment-body')?.textContent).toBe('已删除')
    expect(shown(el, 'tasks-detail-comment-edit')).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// Delete task (§3.7)
// ---------------------------------------------------------------------------------------------

describe('TasksView detail — delete task', () => {
  it('clicking delete shows an inline confirm step, NOT window.confirm, and deleteTask is not yet called', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')
    const el = await mountAt('/tasks/t1')

    ;(shown(el, 'tasks-detail-delete') as HTMLButtonElement).click()
    await flush()

    expect(shown(el, 'tasks-detail-delete-confirm')).toBeTruthy()
    expect(shown(el, 'tasks-detail-delete')).toBeNull()
    expect(h_.deleteTask).not.toHaveBeenCalled()
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('cancelling the confirm step hides it again without calling deleteTask', async () => {
    const el = await mountAt('/tasks/t1')

    ;(shown(el, 'tasks-detail-delete') as HTMLButtonElement).click()
    await flush()
    ;(shown(el, 'tasks-detail-delete-confirm-cancel') as HTMLButtonElement).click()
    await flush()

    expect(shown(el, 'tasks-detail-delete-confirm')).toBeNull()
    expect(shown(el, 'tasks-detail-delete')).toBeTruthy()
    expect(h_.deleteTask).not.toHaveBeenCalled()
  })

  it('confirming delete calls deleteTask, notifies the badge, and navigates to /tasks on success', async () => {
    h_.deleteTask.mockResolvedValue({ kind: 'ok', id: 't1', deleted: true })
    const el = await mountAt('/tasks/t1')

    ;(shown(el, 'tasks-detail-delete') as HTMLButtonElement).click()
    await flush()
    ;(shown(el, 'tasks-detail-delete-confirm-yes') as HTMLButtonElement).click()
    // More cycles than the default: this chain is deleteTask's own await PLUS router.push's
    // internal navigation-guard resolution, which takes more microtask hops than a plain state
    // update.
    await flush(20)

    expect(h_.deleteTask).toHaveBeenCalledWith('t1')
    expect(h_.notifyTasksChanged).toHaveBeenCalledTimes(1)
    expect(router!.currentRoute.value.path).toBe('/tasks')
  })

  it('a 409 HAS_CHILDREN shows 请先删除子任务 inline, stays on the confirm step\'s page, and does not navigate', async () => {
    h_.deleteTask.mockResolvedValue({ kind: 'conflict', code: 'HAS_CHILDREN' })
    const el = await mountAt('/tasks/t1')

    ;(shown(el, 'tasks-detail-delete') as HTMLButtonElement).click()
    await flush()
    ;(shown(el, 'tasks-detail-delete-confirm-yes') as HTMLButtonElement).click()
    await flush()

    expect(shown(el, 'tasks-detail-delete-error')?.textContent).toBe('请先删除子任务')
    expect(router!.currentRoute.value.path).toBe('/tasks/t1')
    expect(shown(el, 'tasks-detail')).toBeTruthy()
  })

  it('a forbidden delete result shows the generic tasks-action-error banner and does not navigate', async () => {
    h_.deleteTask.mockResolvedValue({ kind: 'forbidden' })
    const el = await mountAt('/tasks/t1')

    ;(shown(el, 'tasks-detail-delete') as HTMLButtonElement).click()
    await flush()
    ;(shown(el, 'tasks-detail-delete-confirm-yes') as HTMLButtonElement).click()
    await flush()

    expect(shown(el, 'tasks-action-error')?.textContent).toBe('您没有权限修改此任务')
    expect(router!.currentRoute.value.path).toBe('/tasks/t1')
  })

  it('an org_missing (422) delete result replaces the detail with the org-guidance block', async () => {
    h_.deleteTask.mockResolvedValue({ kind: 'org_missing' })
    const el = await mountAt('/tasks/t1')

    ;(shown(el, 'tasks-detail-delete') as HTMLButtonElement).click()
    await flush()
    ;(shown(el, 'tasks-detail-delete-confirm-yes') as HTMLButtonElement).click()
    await flush()

    expect(shown(el, 'tasks-view-org-missing')).toBeTruthy()
  })

  it('disables the confirm/cancel buttons while deleteTask is pending', async () => {
    const pending = deferred<{ kind: 'ok'; id: string; deleted: true }>()
    h_.deleteTask.mockReturnValue(pending.promise)
    const el = await mountAt('/tasks/t1')

    ;(shown(el, 'tasks-detail-delete') as HTMLButtonElement).click()
    await flush()
    ;(shown(el, 'tasks-detail-delete-confirm-yes') as HTMLButtonElement).click()
    await flush()

    expect((shown(el, 'tasks-detail-delete-confirm-yes') as HTMLButtonElement).disabled).toBe(true)
    expect((shown(el, 'tasks-detail-delete-confirm-cancel') as HTMLButtonElement).disabled).toBe(true)

    pending.resolve({ kind: 'ok', id: 't1', deleted: true })
    await flush()
  })
})

// ---------------------------------------------------------------------------------------------
// Late-result guard for M3 actions (token-based, not `taskId.value !== id` — see the "UNLIKE
// onDetailComplete/onDetailReopen" comment above the M3 handlers in TasksView.vue).
// ---------------------------------------------------------------------------------------------

describe('TasksView detail — M3 action late-result guard', () => {
  it('setParent on t1 while navigating to t2: a late ok does not reload t1 over t2, but still notifies the badge', async () => {
    const pendingSetParent = deferred<{ kind: 'ok'; id: string; parentId: string | null; depth: number }>()
    h_.getTask.mockImplementation(async (id: string) => ({ kind: 'ok', task: taskDetail({ id, title: `Title-${id}` }) }))
    h_.setParent.mockReturnValue(pendingSetParent.promise)
    const el = await mountAt('/tasks/t1')

    const input = shown(el, 'tasks-detail-set-parent-input') as HTMLInputElement
    input.value = 'p1'
    input.dispatchEvent(new Event('input'))
    await flush()
    ;(shown(el, 'tasks-detail-set-parent-submit') as HTMLButtonElement).click()
    await flush()

    await router!.push('/tasks/t2')
    await flush()
    expect(shown(el, 'tasks-detail-title')?.textContent).toBe('Title-t2')

    pendingSetParent.resolve({ kind: 'ok', id: 't1', parentId: 'p1', depth: 1 })
    await flush()

    // Still t2 — a mutant that drops the token check (or restores the weaker `taskId.value !== id`
    // check, which cannot distinguish "still t1" from "left and came back to t1") would call
    // `loadDetail('t1')` here and clobber this.
    expect(shown(el, 'tasks-detail-title')?.textContent).toBe('Title-t2')
    expect(el.textContent).not.toContain('Title-t1')
    expect(h_.notifyTasksChanged).toHaveBeenCalledTimes(1)
  })

  it('the token guard also catches "left t1 for the list, then came back to t1" — taskId.value alone would not', async () => {
    const pendingSetParent = deferred<{ kind: 'ok'; id: string; parentId: string | null; depth: number }>()
    h_.getTask.mockImplementation(async (id: string) => ({ kind: 'ok', task: taskDetail({ id, title: `Title-${id}` }) }))
    h_.setParent.mockReturnValue(pendingSetParent.promise)
    const el = await mountAt('/tasks/t1')

    const input = shown(el, 'tasks-detail-set-parent-input') as HTMLInputElement
    input.value = 'p1'
    input.dispatchEvent(new Event('input'))
    await flush()
    ;(shown(el, 'tasks-detail-set-parent-submit') as HTMLButtonElement).click()
    await flush()

    // Leave t1 for the list, then come straight back to t1 — `taskId.value` ends up 't1' again,
    // identical to where the pending action started, but TWO navigation edges happened.
    await router!.push('/tasks')
    await flush()
    await router!.push('/tasks/t1')
    await flush()
    const getTaskCallsBeforeResolve = h_.getTask.mock.calls.length

    pendingSetParent.resolve({ kind: 'ok', id: 't1', parentId: 'p1', depth: 1 })
    await flush()

    // No EXTRA getTask call beyond whatever the two navigations themselves already triggered.
    expect(h_.getTask.mock.calls.length).toBe(getTaskCallsBeforeResolve)
  })
})

// ---------------------------------------------------------------------------------------------
// Review round 1 (M3 frontend): Leave gating from the detail body, per-handler late-result and
// pending guards, navigation resets, the edit pre-check, the generic-banner fallback, and error
// text mappings. Every block here was added because a mutant of the guard it pins survived the
// earlier suite.
// ---------------------------------------------------------------------------------------------

function typeInto(el: HTMLElement, testid: string, value: string): void {
  const input = shown(el, testid) as HTMLInputElement | HTMLTextAreaElement
  input.value = value
  input.dispatchEvent(new Event('input'))
}

function clickOn(el: HTMLElement, testid: string): void {
  ;(shown(el, testid) as HTMLButtonElement).click()
}

function submitForm(el: HTMLElement, testid: string): void {
  ;(shown(el, testid) as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }))
}

describe('TasksView detail — row abilities from the detail body (contract §3.2)', () => {
  const EDIT_CONTROLS = [
    'tasks-detail-assignee-remove',
    'tasks-detail-add-assignee-form',
    'tasks-detail-completion-mode-select',
    'tasks-detail-set-parent-form',
    'tasks-detail-make-independent',
    'tasks-detail-follower-remove',
    'tasks-detail-add-follower-form',
  ]
  const COMMENT_CONTROLS = ['tasks-detail-comment-form', 'tasks-detail-comment-edit', 'tasks-detail-comment-delete']
  const DELETE_CONTROLS = ['tasks-detail-delete-section', 'tasks-detail-delete']

  async function mountWith(flags: Record<string, boolean>): Promise<HTMLElement> {
    h_.getCurrentUserId.mockResolvedValue('viewer1')
    h_.getTask.mockResolvedValue({
      kind: 'ok',
      task: {
        ...taskDetail({ parentId: 'p1', depth: 1, assignees: [{ userId: 'u2', completedAt: null }] }),
        followers: ['u5'],
        ...flags,
      },
    })
    h_.listComments.mockResolvedValue({ kind: 'ok', items: [comment({ id: 'c1', authorId: 'viewer1' })], total: 1 })
    return mountAt('/tasks/t1')
  }

  it('control: with no ability flags in the body every control renders (older body)', async () => {
    const el = await mountWith({})
    for (const testid of [...EDIT_CONTROLS, ...COMMENT_CONTROLS, ...DELETE_CONTROLS]) {
      expect(shown(el, testid), testid).toBeTruthy()
    }
  })

  it('control: all three flags true renders every control', async () => {
    const el = await mountWith({ canEdit: true, canDelete: true, canComment: true })
    for (const testid of [...EDIT_CONTROLS, ...COMMENT_CONTROLS, ...DELETE_CONTROLS]) {
      expect(shown(el, testid), testid).toBeTruthy()
    }
  })

  it('canEdit: false hides membership, completion-mode and parent controls only', async () => {
    const el = await mountWith({ canEdit: false, canDelete: true, canComment: true })
    for (const testid of EDIT_CONTROLS) expect(shown(el, testid), testid).toBeNull()
    for (const testid of [...COMMENT_CONTROLS, ...DELETE_CONTROLS]) expect(shown(el, testid), testid).toBeTruthy()
    // The read-only content stays: the assignee row, the follower row and the parent link.
    expect(shownAll(el, 'tasks-detail-assignee').length).toBeGreaterThan(0)
    expect(shownAll(el, 'tasks-detail-follower')).toHaveLength(1)
    expect(shown(el, 'tasks-detail-parent')).toBeTruthy()
  })

  it('canDelete: false hides the delete section only', async () => {
    const el = await mountWith({ canEdit: true, canDelete: false, canComment: true })
    for (const testid of DELETE_CONTROLS) expect(shown(el, testid), testid).toBeNull()
    for (const testid of [...EDIT_CONTROLS, ...COMMENT_CONTROLS]) expect(shown(el, testid), testid).toBeTruthy()
  })

  it('canComment: false hides the composer and own-comment edit/delete, and keeps the thread readable', async () => {
    const el = await mountWith({ canEdit: true, canDelete: true, canComment: false })
    for (const testid of COMMENT_CONTROLS) expect(shown(el, testid), testid).toBeNull()
    for (const testid of [...EDIT_CONTROLS, ...DELETE_CONTROLS]) expect(shown(el, testid), testid).toBeTruthy()
    expect(shownAll(el, 'tasks-detail-comment')).toHaveLength(1)
  })
})

describe('TasksView detail — a comment thread longer than the client reads', () => {
  it('says so when the loaded items are fewer than total', async () => {
    h_.listComments.mockResolvedValue({
      kind: 'ok',
      items: [comment({ id: 'c1' }), comment({ id: 'c2' })],
      total: 5,
    })
    const el = await mountAt('/tasks/t1')
    expect(shownAll(el, 'tasks-detail-comment')).toHaveLength(2)
    expect(shown(el, 'tasks-detail-comments-truncated')?.textContent).toContain('2')
  })

  it('shows no hint when the whole thread was loaded', async () => {
    h_.listComments.mockResolvedValue({ kind: 'ok', items: [comment({ id: 'c1' })], total: 1 })
    const el = await mountAt('/tasks/t1')
    expect(shown(el, 'tasks-detail-comments-truncated')).toBeNull()
  })
})

describe('TasksView detail — Leave and followers from the detail body', () => {
  it('shows Leave when the detail body says canLeave: true, with no follower write first', async () => {
    h_.getCurrentUserId.mockResolvedValue('viewer1')
    h_.getTask.mockResolvedValue({ kind: 'ok', task: { ...taskDetail(), canLeave: true } })
    const el = await mountAt('/tasks/t1')
    expect(shown(el, 'tasks-detail-leave')).toBeTruthy()
  })

  it('hides Leave when the detail body says canLeave: false, even if the viewer is in its followers', async () => {
    h_.getCurrentUserId.mockResolvedValue('viewer1')
    h_.getTask.mockResolvedValue({ kind: 'ok', task: { ...taskDetail(), followers: ['viewer1'], canLeave: false } })
    const el = await mountAt('/tasks/t1')
    expect(shownAll(el, 'tasks-detail-follower')).toHaveLength(1)
    expect(shown(el, 'tasks-detail-leave')).toBeNull()
  })

  it('renders the follower list straight from the detail body when it carries one', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: { ...taskDetail(), followers: ['u5', 'u6'] } })
    const el = await mountAt('/tasks/t1')
    expect(shown(el, 'tasks-detail-followers-unknown')).toBeNull()
    expect(shownAll(el, 'tasks-detail-follower')).toHaveLength(2)
  })
})

describe('TasksView detail — late results on the other M3 handlers', () => {
  beforeEach(() => {
    h_.getTask.mockImplementation(async (id: string) => ({ kind: 'ok', task: taskDetail({ id, title: `Title-${id}` }) }))
  })

  it('addAssignee: a late ok for t1 leaves t2 and the draft typed on t2 alone, and still notifies', async () => {
    const pending = deferred<unknown>()
    h_.addAssignee.mockReturnValue(pending.promise)
    const el = await mountAt('/tasks/t1')
    typeInto(el, 'tasks-detail-add-assignee-input', 'u9')
    await flush()
    clickOn(el, 'tasks-detail-add-assignee-submit')
    await flush()

    await router!.push('/tasks/t2')
    await flush()
    typeInto(el, 'tasks-detail-add-assignee-input', 'draft-on-t2')
    await flush()
    const getTaskCalls = h_.getTask.mock.calls.length

    pending.resolve({ kind: 'ok', task: { id: 't1', status: 'open', completionMode: 'all', assignees: [] } })
    await flush()

    expect(shown(el, 'tasks-detail-title')?.textContent).toBe('Title-t2')
    expect((shown(el, 'tasks-detail-add-assignee-input') as HTMLInputElement).value).toBe('draft-on-t2')
    expect(h_.getTask.mock.calls.length).toBe(getTaskCalls)
    expect(h_.notifyTasksChanged).toHaveBeenCalledTimes(1)
  })

  it('deleteComment: a late 403 for t1 shows no banner on t2', async () => {
    h_.getCurrentUserId.mockResolvedValue('viewer1')
    h_.listComments.mockResolvedValue({ kind: 'ok', items: [comment({ id: 'c1', authorId: 'viewer1' })] })
    const pending = deferred<unknown>()
    h_.deleteComment.mockReturnValue(pending.promise)
    const el = await mountAt('/tasks/t1')
    clickOn(el, 'tasks-detail-comment-delete')
    await flush()

    await router!.push('/tasks/t2')
    await flush()
    pending.resolve({ kind: 'forbidden' })
    await flush()

    expect(shown(el, 'tasks-detail-title')?.textContent).toBe('Title-t2')
    expect(shown(el, 'tasks-action-error')).toBeNull()
  })

  it('deleteComment: a late 403 after t1 -> list -> t1 shows no banner either (token, not id)', async () => {
    h_.getCurrentUserId.mockResolvedValue('viewer1')
    h_.listComments.mockResolvedValue({ kind: 'ok', items: [comment({ id: 'c1', authorId: 'viewer1' })] })
    const pending = deferred<unknown>()
    h_.deleteComment.mockReturnValue(pending.promise)
    const el = await mountAt('/tasks/t1')
    clickOn(el, 'tasks-detail-comment-delete')
    await flush()

    await router!.push('/tasks')
    await flush()
    await router!.push('/tasks/t1')
    await flush()
    pending.resolve({ kind: 'forbidden' })
    await flush()

    expect(shown(el, 'tasks-action-error')).toBeNull()
  })

  it('deleteTask: a late ok for t1 does not pull the viewer off t2, but still notifies', async () => {
    const pending = deferred<unknown>()
    h_.deleteTask.mockReturnValue(pending.promise)
    const el = await mountAt('/tasks/t1')
    clickOn(el, 'tasks-detail-delete')
    await flush()
    clickOn(el, 'tasks-detail-delete-confirm-yes')
    await flush()

    await router!.push('/tasks/t2')
    await flush()
    pending.resolve({ kind: 'ok', id: 't1', deleted: true })
    await flush()
    // Let any navigation the late result might start run to completion before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await flush()

    expect(router!.currentRoute.value.fullPath).toBe('/tasks/t2')
    expect(shown(el, 'tasks-detail-title')?.textContent).toBe('Title-t2')
    expect(h_.notifyTasksChanged).toHaveBeenCalledTimes(1)
  })

  it('addFollower: a late ok for t1 leaves t2\'s followers unknown, and still notifies', async () => {
    const pending = deferred<unknown>()
    h_.addFollower.mockReturnValue(pending.promise)
    const el = await mountAt('/tasks/t1')
    typeInto(el, 'tasks-detail-add-follower-input', 'u5')
    await flush()
    clickOn(el, 'tasks-detail-add-follower-submit')
    await flush()

    await router!.push('/tasks/t2')
    await flush()
    pending.resolve({ kind: 'ok', task: { id: 't1', followers: ['u5'] } })
    await flush()

    expect(shown(el, 'tasks-detail-followers-unknown')).toBeTruthy()
    expect(shown(el, 'tasks-detail-followers')).toBeNull()
    expect(h_.notifyTasksChanged).toHaveBeenCalledTimes(1)
  })

  it('a late result for t1 does not clear the pending flag of an action already running on t2', async () => {
    const onT1 = deferred<unknown>()
    const onT2 = deferred<unknown>()
    h_.setParent.mockReturnValue(onT1.promise)
    h_.addAssignee.mockReturnValue(onT2.promise)
    const el = await mountAt('/tasks/t1')
    typeInto(el, 'tasks-detail-set-parent-input', 'p1')
    await flush()
    clickOn(el, 'tasks-detail-set-parent-submit')
    await flush()

    await router!.push('/tasks/t2')
    await flush()
    typeInto(el, 'tasks-detail-add-assignee-input', 'u9')
    await flush()
    clickOn(el, 'tasks-detail-add-assignee-submit')
    await flush()
    expect((shown(el, 'tasks-detail-comment-submit') as HTMLButtonElement).disabled).toBe(true)

    onT1.resolve({ kind: 'ok', id: 't1', parentId: 'p1', depth: 1 })
    await flush()
    expect((shown(el, 'tasks-detail-comment-submit') as HTMLButtonElement).disabled).toBe(true)

    onT2.resolve({ kind: 'ok', task: { id: 't2', status: 'open', completionMode: 'all', assignees: [] } })
    await flush()
    expect((shown(el, 'tasks-detail-comment-submit') as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('TasksView detail — per-task state resets on navigation', () => {
  beforeEach(() => {
    h_.getTask.mockImplementation(async (id: string) => ({ kind: 'ok', task: taskDetail({ id, title: `Title-${id}` }) }))
  })

  it('a follower list and Leave learned on t1 do not carry over to t2', async () => {
    h_.getCurrentUserId.mockResolvedValue('viewer1')
    h_.addFollower.mockResolvedValue({ kind: 'ok', task: { id: 't1', followers: ['viewer1'] } })
    const el = await mountAt('/tasks/t1')
    typeInto(el, 'tasks-detail-add-follower-input', 'viewer1')
    await flush()
    clickOn(el, 'tasks-detail-add-follower-submit')
    await flush()
    expect(shown(el, 'tasks-detail-leave')).toBeTruthy()

    await router!.push('/tasks/t2')
    await flush()

    expect(shown(el, 'tasks-detail-followers-unknown')).toBeTruthy()
    expect(shown(el, 'tasks-detail-followers')).toBeNull()
    expect(shown(el, 'tasks-detail-leave')).toBeNull()
  })

  it('a delete confirm opened on t1 is not armed on t2', async () => {
    const el = await mountAt('/tasks/t1')
    clickOn(el, 'tasks-detail-delete')
    await flush()
    expect(shown(el, 'tasks-detail-delete-confirm')).toBeTruthy()

    await router!.push('/tasks/t2')
    await flush()

    expect(shown(el, 'tasks-detail-delete-confirm')).toBeNull()
    expect(h_.deleteTask).not.toHaveBeenCalled()
  })

  it('comments for t1 that arrive after t2\'s never replace t2\'s comments', async () => {
    const forT1 = deferred<unknown>()
    const forT2 = deferred<unknown>()
    h_.listComments.mockImplementation((id: string) => (id === 't1' ? forT1.promise : forT2.promise))
    const el = await mountAt('/tasks/t1')
    await router!.push('/tasks/t2')
    await flush()

    forT2.resolve({ kind: 'ok', items: [comment({ id: 'c2', taskId: 't2', body: 'from-t2' })] })
    await flush()
    forT1.resolve({ kind: 'ok', items: [comment({ id: 'c1', taskId: 't1', body: 'from-t1' })] })
    await flush()

    const bodies = shownAll(el, 'tasks-detail-comment-body').map((node) => node.textContent)
    expect(bodies).toEqual(['from-t2'])
  })
})

describe('TasksView detail — one action at a time', () => {
  it('setCompletionMode: a second change while the first is pending is ignored', async () => {
    const pending = deferred<unknown>()
    h_.setCompletionMode.mockReturnValue(pending.promise)
    const el = await mountAt('/tasks/t1')
    const select = shown(el, 'tasks-detail-completion-mode-select') as HTMLSelectElement
    select.value = 'any'
    select.dispatchEvent(new Event('change'))
    await flush()
    select.value = 'any'
    select.dispatchEvent(new Event('change'))
    await flush()

    expect(h_.setCompletionMode).toHaveBeenCalledTimes(1)
    expect((shown(el, 'tasks-detail-comment-submit') as HTMLButtonElement).disabled).toBe(true)
    pending.resolve({ kind: 'ok', task: { id: 't1', status: 'open', completionMode: 'any', assignees: [] } })
    await flush()
    expect((shown(el, 'tasks-detail-comment-submit') as HTMLButtonElement).disabled).toBe(false)
  })

  it('addAssignee: a second submit while the first is pending is ignored', async () => {
    const pending = deferred<unknown>()
    h_.addAssignee.mockReturnValue(pending.promise)
    const el = await mountAt('/tasks/t1')
    typeInto(el, 'tasks-detail-add-assignee-input', 'u9')
    await flush()
    submitForm(el, 'tasks-detail-add-assignee-form')
    await flush()
    submitForm(el, 'tasks-detail-add-assignee-form')
    await flush()

    expect(h_.addAssignee).toHaveBeenCalledTimes(1)
    expect((shown(el, 'tasks-detail-add-assignee-submit') as HTMLButtonElement).disabled).toBe(true)
    pending.resolve({ kind: 'ok', task: { id: 't1', status: 'open', completionMode: 'all', assignees: [] } })
    await flush()
    expect((shown(el, 'tasks-detail-comment-submit') as HTMLButtonElement).disabled).toBe(false)
  })

  it('addFollower: a second submit while the first is pending is ignored', async () => {
    const pending = deferred<unknown>()
    h_.addFollower.mockReturnValue(pending.promise)
    const el = await mountAt('/tasks/t1')
    typeInto(el, 'tasks-detail-add-follower-input', 'u5')
    await flush()
    submitForm(el, 'tasks-detail-add-follower-form')
    await flush()
    submitForm(el, 'tasks-detail-add-follower-form')
    await flush()

    expect(h_.addFollower).toHaveBeenCalledTimes(1)
    expect((shown(el, 'tasks-detail-add-follower-submit') as HTMLButtonElement).disabled).toBe(true)
    pending.resolve({ kind: 'ok', task: { id: 't1', followers: ['u5'] } })
    await flush()
    expect((shown(el, 'tasks-detail-comment-submit') as HTMLButtonElement).disabled).toBe(false)
  })

  it('createComment: a second submit while the first is pending is ignored', async () => {
    const pending = deferred<unknown>()
    h_.createComment.mockReturnValue(pending.promise)
    const el = await mountAt('/tasks/t1')
    typeInto(el, 'tasks-detail-comment-input', 'hello')
    await flush()
    submitForm(el, 'tasks-detail-comment-form')
    await flush()
    submitForm(el, 'tasks-detail-comment-form')
    await flush()

    expect(h_.createComment).toHaveBeenCalledTimes(1)
    expect((shown(el, 'tasks-detail-comment-submit') as HTMLButtonElement).disabled).toBe(true)
    pending.resolve({ kind: 'ok', comment: comment({ id: 'c9', body: 'hello' }) })
    await flush()
    expect((shown(el, 'tasks-detail-comment-submit') as HTMLButtonElement).disabled).toBe(false)
  })

  it('deleteComment: a second click while the first is pending is ignored', async () => {
    h_.getCurrentUserId.mockResolvedValue('viewer1')
    h_.listComments.mockResolvedValue({ kind: 'ok', items: [comment({ id: 'c1', authorId: 'viewer1' })] })
    const pending = deferred<unknown>()
    h_.deleteComment.mockReturnValue(pending.promise)
    const el = await mountAt('/tasks/t1')
    clickOn(el, 'tasks-detail-comment-delete')
    await flush()
    clickOn(el, 'tasks-detail-comment-delete')
    await flush()

    expect(h_.deleteComment).toHaveBeenCalledTimes(1)
    pending.resolve({ kind: 'ok', comment: comment({ id: 'c1', authorId: 'viewer1', deleted: true, body: null }) })
    await flush()
    expect((shown(el, 'tasks-detail-comment-submit') as HTMLButtonElement).disabled).toBe(false)
  })

  it('saving an edited comment: a second click while the first is pending is ignored', async () => {
    h_.getCurrentUserId.mockResolvedValue('viewer1')
    h_.listComments.mockResolvedValue({ kind: 'ok', items: [comment({ id: 'c1', authorId: 'viewer1', body: 'old' })] })
    const pending = deferred<unknown>()
    h_.editComment.mockReturnValue(pending.promise)
    const el = await mountAt('/tasks/t1')
    clickOn(el, 'tasks-detail-comment-edit')
    await flush()
    typeInto(el, 'tasks-detail-comment-edit-input', 'new')
    await flush()
    clickOn(el, 'tasks-detail-comment-edit-save')
    await flush()
    clickOn(el, 'tasks-detail-comment-edit-save')
    await flush()

    expect(h_.editComment).toHaveBeenCalledTimes(1)
    pending.resolve({ kind: 'ok', comment: comment({ id: 'c1', authorId: 'viewer1', body: 'new' }) })
    await flush()
    expect((shown(el, 'tasks-detail-comment-submit') as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('TasksView detail — edit pre-check, generic fallback, error text', () => {
  async function startEditingOwnComment(): Promise<HTMLElement> {
    h_.getCurrentUserId.mockResolvedValue('viewer1')
    h_.listComments.mockResolvedValue({ kind: 'ok', items: [comment({ id: 'c1', authorId: 'viewer1', body: 'old' })] })
    const el = await mountAt('/tasks/t1')
    clickOn(el, 'tasks-detail-comment-edit')
    await flush()
    return el
  }

  it('an edit to a blank body is rejected client-side with 评论内容不能为空', async () => {
    const el = await startEditingOwnComment()
    typeInto(el, 'tasks-detail-comment-edit-input', '   ')
    await flush()
    clickOn(el, 'tasks-detail-comment-edit-save')
    await flush()
    expect(h_.editComment).not.toHaveBeenCalled()
    expect(shown(el, 'tasks-detail-comment-edit-error')?.textContent).toBe('评论内容不能为空')
  })

  it('an edit over 5000 code points is rejected client-side with 评论内容过长', async () => {
    const el = await startEditingOwnComment()
    typeInto(el, 'tasks-detail-comment-edit-input', 'x'.repeat(5001))
    await flush()
    clickOn(el, 'tasks-detail-comment-edit-save')
    await flush()
    expect(h_.editComment).not.toHaveBeenCalled()
    expect(shown(el, 'tasks-detail-comment-edit-error')?.textContent).toBe('评论内容过长')
  })

  it('a server-side COMMENT_TOO_LONG on edit shows 评论内容过长 next to the editor', async () => {
    h_.editComment.mockResolvedValue({ kind: 'validation', code: 'COMMENT_TOO_LONG' })
    const el = await startEditingOwnComment()
    typeInto(el, 'tasks-detail-comment-edit-input', 'new')
    await flush()
    clickOn(el, 'tasks-detail-comment-edit-save')
    await flush()
    expect(shown(el, 'tasks-detail-comment-edit-error')?.textContent).toBe('评论内容过长')
  })

  it('a validation result on delete (no per-call handler) falls back to the generic banner and stays on the task', async () => {
    h_.deleteTask.mockResolvedValue({ kind: 'validation', code: 'SOMETHING' })
    const el = await mountAt('/tasks/t1')
    clickOn(el, 'tasks-detail-delete')
    await flush()
    clickOn(el, 'tasks-detail-delete-confirm-yes')
    await flush()
    expect(shown(el, 'tasks-action-error')?.textContent?.trim()).toBe('操作失败，请稍后重试')
    expect(router!.currentRoute.value.fullPath).toBe('/tasks/t1')
  })

  it('a conflict result on setParent (no per-call handler) falls back to the generic banner', async () => {
    h_.setParent.mockResolvedValue({ kind: 'conflict', code: 'SOMETHING' })
    const el = await mountAt('/tasks/t1')
    typeInto(el, 'tasks-detail-set-parent-input', 'p1')
    await flush()
    clickOn(el, 'tasks-detail-set-parent-submit')
    await flush()
    expect(shown(el, 'tasks-action-error')?.textContent?.trim()).toBe('操作失败，请稍后重试')
    expect(shown(el, 'tasks-detail-parent-error')).toBeNull()
  })

  it('a LIMIT validation on addFollower shows 人数已达上限 next to the follower form', async () => {
    h_.addFollower.mockResolvedValue({ kind: 'validation', code: 'LIMIT' })
    const el = await mountAt('/tasks/t1')
    typeInto(el, 'tasks-detail-add-follower-input', 'u5')
    await flush()
    clickOn(el, 'tasks-detail-add-follower-submit')
    await flush()
    expect(shown(el, 'tasks-detail-follower-error')?.textContent?.trim()).toBe('人数已达上限')
  })

  it('shows the comments loading state while listComments is pending', async () => {
    const pending = deferred<unknown>()
    h_.listComments.mockReturnValue(pending.promise)
    const el = await mountAt('/tasks/t1')
    expect(shown(el, 'tasks-detail-comments-loading')).toBeTruthy()
    pending.resolve({ kind: 'ok', items: [] })
    await flush()
    expect(shown(el, 'tasks-detail-comments-loading')).toBeNull()
  })

  it('when resolving the viewer id throws, comments fall back to the id-unavailable mode without an unhandled rejection', async () => {
    h_.getCurrentUserId.mockRejectedValue(new Error('auth unavailable'))
    h_.listComments.mockResolvedValue({ kind: 'ok', items: [comment({ id: 'a', authorId: 'someone' })] })
    const el = await mountAt('/tasks/t1')
    expect(shown(el, 'tasks-detail-comment-edit')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------------------------
// Review round 1, re-verified items: each M3 handler clears a stale banner at its start and
// notifies the badge once on success; draft inputs, inline errors and an open comment editor do
// not survive a navigation; a comment posted while the list is not loaded still shows up.
// ---------------------------------------------------------------------------------------------

type ActionRow = {
  name: string
  mock: keyof typeof h_
  task?: Partial<TaskDetailFixture> & { followers?: string[]; canLeave?: boolean }
  ownComment?: boolean
  act: (el: HTMLElement) => Promise<void>
  ok: unknown
}

const membershipOk = { kind: 'ok', task: { id: 't1', status: 'open', completionMode: 'all', assignees: [] } }
const followersOk = { kind: 'ok', task: { id: 't1', followers: [] } }

const ACTION_ROWS: ActionRow[] = [
  {
    name: 'setParent', mock: 'setParent', ok: { kind: 'ok', id: 't1', parentId: 'p1', depth: 1 },
    act: async (el) => { typeInto(el, 'tasks-detail-set-parent-input', 'p1'); await flush(); clickOn(el, 'tasks-detail-set-parent-submit') },
  },
  {
    name: 'makeIndependent', mock: 'setParent', task: { parentId: 'p0', depth: 1 }, ok: { kind: 'ok', id: 't1', parentId: null, depth: 0 },
    act: async (el) => { clickOn(el, 'tasks-detail-make-independent') },
  },
  {
    name: 'addAssignee', mock: 'addAssignee', ok: membershipOk,
    act: async (el) => { typeInto(el, 'tasks-detail-add-assignee-input', 'u9'); await flush(); clickOn(el, 'tasks-detail-add-assignee-submit') },
  },
  {
    name: 'removeAssignee', mock: 'removeAssignee', task: { assignees: [{ userId: 'u2', completedAt: null }] }, ok: membershipOk,
    act: async (el) => { clickOn(el, 'tasks-detail-assignee-remove') },
  },
  {
    name: 'setCompletionMode', mock: 'setCompletionMode', ok: membershipOk,
    act: async (el) => {
      const select = shown(el, 'tasks-detail-completion-mode-select') as HTMLSelectElement
      select.value = 'any'
      select.dispatchEvent(new Event('change'))
    },
  },
  {
    name: 'addFollower', mock: 'addFollower', ok: followersOk,
    act: async (el) => { typeInto(el, 'tasks-detail-add-follower-input', 'u5'); await flush(); clickOn(el, 'tasks-detail-add-follower-submit') },
  },
  {
    name: 'removeFollower', mock: 'removeFollower', task: { followers: ['u5'] }, ok: followersOk,
    act: async (el) => { clickOn(el, 'tasks-detail-follower-remove') },
  },
  {
    name: 'leave', mock: 'leaveTask', task: { canLeave: true }, ok: followersOk,
    act: async (el) => { clickOn(el, 'tasks-detail-leave') },
  },
  {
    name: 'createComment', mock: 'createComment', ok: { kind: 'ok', comment: comment({ id: 'c9', body: 'hi' }) },
    act: async (el) => { typeInto(el, 'tasks-detail-comment-input', 'hi'); await flush(); clickOn(el, 'tasks-detail-comment-submit') },
  },
  {
    name: 'saveEditComment', mock: 'editComment', ownComment: true, ok: { kind: 'ok', comment: comment({ id: 'c1', authorId: 'viewer1', body: 'new' }) },
    act: async (el) => {
      clickOn(el, 'tasks-detail-comment-edit')
      await flush()
      typeInto(el, 'tasks-detail-comment-edit-input', 'new')
      await flush()
      clickOn(el, 'tasks-detail-comment-edit-save')
    },
  },
  {
    name: 'deleteComment', mock: 'deleteComment', ownComment: true, ok: { kind: 'ok', comment: comment({ id: 'c1', authorId: 'viewer1', deleted: true, body: null }) },
    act: async (el) => { clickOn(el, 'tasks-detail-comment-delete') },
  },
  {
    name: 'deleteTask', mock: 'deleteTask', ok: { kind: 'ok', id: 't1', deleted: true },
    act: async (el) => { clickOn(el, 'tasks-detail-delete'); await flush(); clickOn(el, 'tasks-detail-delete-confirm-yes') },
  },
]

describe('TasksView detail — every M3 action clears a stale banner at its start and notifies once on success', () => {
  it.each(ACTION_ROWS.map((row) => [row.name, row] as const))('%s', async (_name, row) => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: { ...taskDetail(row.task), ...(row.task ?? {}) } })
    if (row.ownComment) {
      h_.getCurrentUserId.mockResolvedValue('viewer1')
      h_.listComments.mockResolvedValue({ kind: 'ok', items: [comment({ id: 'c1', authorId: 'viewer1', body: 'old' })] })
    }
    h_.completeTask.mockResolvedValue({ kind: 'forbidden' })
    const pending = deferred<unknown>()
    ;(h_[row.mock] as ReturnType<typeof vi.fn>).mockReturnValue(pending.promise)
    const el = await mountAt('/tasks/t1')

    // A different action leaves a banner behind first.
    clickOn(el, 'tasks-detail-complete-button')
    await flush()
    expect(shown(el, 'tasks-action-error')?.textContent?.trim()).toBe('您没有权限修改此任务')

    await row.act(el)
    await flush()
    // Cleared at the START of the action, while its request is still in flight.
    expect(h_[row.mock]).toHaveBeenCalledTimes(1)
    expect(shown(el, 'tasks-action-error')).toBeNull()

    pending.resolve(row.ok)
    await flush()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await flush()
    expect(h_.notifyTasksChanged).toHaveBeenCalledTimes(1)
  })
})

describe('TasksView detail — drafts, inline errors and the comment editor do not survive a navigation', () => {
  beforeEach(() => {
    h_.getTask.mockImplementation(async (id: string) => ({ kind: 'ok', task: taskDetail({ id, title: `Title-${id}` }) }))
  })

  it('draft inputs typed on t1 are empty on t2', async () => {
    const el = await mountAt('/tasks/t1')
    typeInto(el, 'tasks-detail-set-parent-input', 'p1')
    typeInto(el, 'tasks-detail-add-assignee-input', 'u9')
    typeInto(el, 'tasks-detail-add-follower-input', 'u5')
    typeInto(el, 'tasks-detail-comment-input', 'draft')
    await flush()

    await router!.push('/tasks/t2')
    await flush()

    for (const testid of ['tasks-detail-set-parent-input', 'tasks-detail-add-assignee-input', 'tasks-detail-add-follower-input', 'tasks-detail-comment-input']) {
      expect((shown(el, testid) as HTMLInputElement).value, testid).toBe('')
    }
  })

  it('inline errors raised on t1 are gone on t2', async () => {
    h_.setParent.mockResolvedValue({ kind: 'validation', code: 'INVALID_PARENT' })
    h_.addAssignee.mockResolvedValue({ kind: 'validation', code: 'LIMIT' })
    h_.addFollower.mockResolvedValue({ kind: 'validation', code: 'LIMIT' })
    h_.deleteTask.mockResolvedValue({ kind: 'conflict', code: 'HAS_CHILDREN' })
    const el = await mountAt('/tasks/t1')
    typeInto(el, 'tasks-detail-set-parent-input', 'p1')
    await flush()
    clickOn(el, 'tasks-detail-set-parent-submit')
    await flush()
    typeInto(el, 'tasks-detail-add-assignee-input', 'u9')
    await flush()
    clickOn(el, 'tasks-detail-add-assignee-submit')
    await flush()
    typeInto(el, 'tasks-detail-add-follower-input', 'u5')
    await flush()
    clickOn(el, 'tasks-detail-add-follower-submit')
    await flush()
    typeInto(el, 'tasks-detail-comment-input', '   ')
    await flush()
    clickOn(el, 'tasks-detail-comment-submit')
    await flush()
    clickOn(el, 'tasks-detail-delete')
    await flush()
    clickOn(el, 'tasks-detail-delete-confirm-yes')
    await flush()
    const errorIds = ['tasks-detail-parent-error', 'tasks-detail-membership-error', 'tasks-detail-follower-error', 'tasks-detail-comment-error', 'tasks-detail-delete-error']
    for (const testid of errorIds) expect(shown(el, testid), `${testid} raised on t1`).toBeTruthy()

    await router!.push('/tasks/t2')
    await flush()

    for (const testid of errorIds) expect(shown(el, testid), `${testid} on t2`).toBeNull()
  })

  it('an open comment editor does not survive leaving the task and coming back', async () => {
    h_.getCurrentUserId.mockResolvedValue('viewer1')
    h_.listComments.mockResolvedValue({ kind: 'ok', items: [comment({ id: 'c1', authorId: 'viewer1', body: 'old' })] })
    const el = await mountAt('/tasks/t1')
    clickOn(el, 'tasks-detail-comment-edit')
    await flush()
    typeInto(el, 'tasks-detail-comment-edit-input', 'half-typed')
    await flush()

    await router!.push('/tasks')
    await flush()
    await router!.push('/tasks/t1')
    await flush()

    expect(shown(el, 'tasks-detail-comment-edit-input')).toBeNull()
    expect(shown(el, 'tasks-detail-comment-body')?.textContent).toBe('old')
  })
})

describe('TasksView detail — a comment posted while the list is not loaded still appears', () => {
  it('after a failed list read, a successful post re-reads the list and shows the new comment', async () => {
    h_.listComments
      .mockResolvedValueOnce({ kind: 'error' })
      .mockResolvedValue({ kind: 'ok', items: [comment({ id: 'c9', body: 'posted' })] })
    h_.createComment.mockResolvedValue({ kind: 'ok', comment: comment({ id: 'c9', body: 'posted' }) })
    const el = await mountAt('/tasks/t1')
    expect(shown(el, 'tasks-detail-comments-error')).toBeTruthy()

    typeInto(el, 'tasks-detail-comment-input', 'posted')
    await flush()
    clickOn(el, 'tasks-detail-comment-submit')
    await flush()

    expect(h_.listComments).toHaveBeenCalledTimes(2)
    expect(shown(el, 'tasks-detail-comments-error')).toBeNull()
    expect(shownAll(el, 'tasks-detail-comment-body').map((node) => node.textContent)).toEqual(['posted'])
  })

  it('while the first list read is still in flight, the post re-reads and the older in-flight result is discarded', async () => {
    const first = deferred<unknown>()
    h_.listComments
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ kind: 'ok', items: [comment({ id: 'c0', body: 'older' }), comment({ id: 'c9', body: 'posted' })] })
    h_.createComment.mockResolvedValue({ kind: 'ok', comment: comment({ id: 'c9', body: 'posted' }) })
    const el = await mountAt('/tasks/t1')
    expect(shown(el, 'tasks-detail-comments-loading')).toBeTruthy()

    typeInto(el, 'tasks-detail-comment-input', 'posted')
    await flush()
    clickOn(el, 'tasks-detail-comment-submit')
    await flush()
    first.resolve({ kind: 'ok', items: [comment({ id: 'c0', body: 'older' })] })
    await flush()

    expect(shownAll(el, 'tasks-detail-comment-body').map((node) => node.textContent)).toEqual(['older', 'posted'])
  })
})
