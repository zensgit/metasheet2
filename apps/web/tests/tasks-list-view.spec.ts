import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'

const h = vi.hoisted(() => ({
  loadTasksContext: vi.fn(),
  listTasks: vi.fn(),
  getTask: vi.fn(),
  createTask: vi.fn(),
  completeTask: vi.fn(),
  reopenTask: vi.fn(),
  notifyTasksChanged: vi.fn(),
  route: { params: {} as Record<string, string> },
}))

vi.mock('vue-router', () => ({
  useRoute: () => h.route,
}))

vi.mock('../src/tasks/tasksContext', () => ({
  loadTasksContext: h.loadTasksContext,
}))

vi.mock('../src/tasks/tasksApi', () => ({
  listTasks: h.listTasks,
  getTask: h.getTask,
  createTask: h.createTask,
  completeTask: h.completeTask,
  reopenTask: h.reopenTask,
}))

vi.mock('../src/tasks/tasksBadgeBus', () => ({
  notifyTasksChanged: h.notifyTasksChanged,
}))

import TasksView from '../src/views/tasks/TasksView.vue'

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
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('TasksView ready-state list rendering (gate: empty vs error must never look the same)', () => {
  it('renders tasks-list for a non-empty ok response', async () => {
    h.listTasks.mockResolvedValue({ kind: 'ok', items: [taskItem()] })
    const el = await mountReady()

    expect(shown(el, 'tasks-list')).toBeTruthy()
    expect(shown(el, 'tasks-list-empty')).toBeNull()
    expect(shown(el, 'tasks-list-error')).toBeNull()
    expect(el.textContent).toContain('Task One')
  })

  it('renders tasks-list-empty for a 200 with zero items', async () => {
    h.listTasks.mockResolvedValue({ kind: 'ok', items: [] })
    const el = await mountReady()

    expect(shown(el, 'tasks-list-empty')).toBeTruthy()
    expect(shown(el, 'tasks-list')).toBeNull()
    expect(shown(el, 'tasks-list-error')).toBeNull()
  })

  it('renders tasks-list-error (NOT tasks-list-empty) for predicate_error, and shows no org-missing guidance', async () => {
    h.listTasks.mockResolvedValue({ kind: 'predicate_error' })
    const el = await mountReady()

    const errorEl = shown(el, 'tasks-list-error')
    expect(errorEl).toBeTruthy()
    expect(shown(el, 'tasks-list-empty')).toBeNull()
    expect(shown(el, 'tasks-view-org-missing')).toBeNull()
  })

  it('renders tasks-list-error for a generic error, distinct from the empty-state text', async () => {
    h.listTasks.mockResolvedValue({ kind: 'error', status: 500 })
    const el = await mountReady()

    const errorEl = shown(el, 'tasks-list-error')
    expect(errorEl).toBeTruthy()
    expect(errorEl?.textContent).not.toBe('暂无任务')
  })

  it('shows the org-missing guidance (reusing tasks-view-org-missing) when the list read reports org_missing', async () => {
    h.listTasks.mockResolvedValue({ kind: 'org_missing' })
    const el = await mountReady()

    expect(shown(el, 'tasks-view-org-missing')).toBeTruthy()
    expect(shown(el, 'tasks-list')).toBeNull()
    expect(shown(el, 'tasks-list-empty')).toBeNull()
    expect(shown(el, 'tasks-list-error')).toBeNull()
  })
})

describe('TasksView view switcher', () => {
  it('defaults to the assigned view and re-fetches the newly selected view on switch', async () => {
    h.listTasks.mockResolvedValue({ kind: 'ok', items: [] })
    const el = await mountReady()

    expect(h.listTasks).toHaveBeenCalledWith('assigned')

    const followingButton = shown(el, 'tasks-view-switch-following') as HTMLButtonElement
    followingButton.click()
    await flush()

    expect(h.listTasks).toHaveBeenLastCalledWith('following')
  })
})

describe('TasksView create / complete / reopen mutations', () => {
  it('submitting the create form calls createTask (no assignees key) then refreshes the list', async () => {
    h.listTasks.mockResolvedValue({ kind: 'ok', items: [] })
    h.createTask.mockResolvedValue({ kind: 'ok', id: 't9' })
    const el = await mountReady()
    expect(h.listTasks).toHaveBeenCalledTimes(1)

    const titleInput = shown(el, 'tasks-create-title') as HTMLInputElement
    titleInput.value = 'New task'
    titleInput.dispatchEvent(new Event('input'))
    await flush()

    const form = shown(el, 'tasks-create-form') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()

    expect(h.createTask).toHaveBeenCalledWith({ title: 'New task', completionMode: 'all' })
    expect(h.listTasks).toHaveBeenCalledTimes(2)
    // P3: a successful mutation nudges the nav badge instead of waiting out its poll window.
    expect(h.notifyTasksChanged).toHaveBeenCalledTimes(1)
  })

  it('create returning a generic error renders the create-error message and issues no badge refresh', async () => {
    h.listTasks.mockResolvedValue({ kind: 'ok', items: [] })
    h.createTask.mockResolvedValue({ kind: 'error', status: 500 })
    const el = await mountReady()

    const titleInput = shown(el, 'tasks-create-title') as HTMLInputElement
    titleInput.value = 'New task'
    titleInput.dispatchEvent(new Event('input'))
    await flush()
    const form = shown(el, 'tasks-create-form') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()

    expect(shown(el, 'tasks-create-error')).toBeTruthy()
    expect(shown(el, 'tasks-view-org-missing')).toBeNull()
    // Only ONE list read (the initial mount) — a failed create must not refresh the list either.
    expect(h.listTasks).toHaveBeenCalledTimes(1)
    expect(h.notifyTasksChanged).not.toHaveBeenCalled()
  })

  it('create returning org_missing (422 ORG_MISSING) shows the org-missing guidance', async () => {
    h.listTasks.mockResolvedValue({ kind: 'ok', items: [] })
    h.createTask.mockResolvedValue({ kind: 'org_missing' })
    const el = await mountReady()

    const titleInput = shown(el, 'tasks-create-title') as HTMLInputElement
    titleInput.value = 'New task'
    titleInput.dispatchEvent(new Event('input'))
    await flush()
    const form = shown(el, 'tasks-create-form') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()

    expect(shown(el, 'tasks-view-org-missing')).toBeTruthy()
  })

  it('clicking complete calls completeTask for that row id and refreshes the list', async () => {
    h.listTasks
      .mockResolvedValueOnce({ kind: 'ok', items: [taskItem({ id: 't1', status: 'open' })] })
      .mockResolvedValueOnce({ kind: 'ok', items: [] })
    h.completeTask.mockResolvedValue({ kind: 'ok', done: true })
    const el = await mountReady()

    const completeButton = shown(el, 'tasks-complete-button') as HTMLButtonElement
    completeButton.click()
    await flush()

    expect(h.completeTask).toHaveBeenCalledWith('t1')
    expect(h.listTasks).toHaveBeenCalledTimes(2)
    expect(h.notifyTasksChanged).toHaveBeenCalledTimes(1)
    expect(shown(el, 'tasks-action-error')).toBeNull()
  })

  it('clicking reopen sends scope self and refreshes the list', async () => {
    h.listTasks
      .mockResolvedValueOnce({ kind: 'ok', items: [taskItem({ id: 't2', status: 'done' })] })
      .mockResolvedValueOnce({ kind: 'ok', items: [] })
    h.reopenTask.mockResolvedValue({ kind: 'ok' })
    const el = await mountReady()

    const reopenButton = shown(el, 'tasks-reopen-button') as HTMLButtonElement
    reopenButton.click()
    await flush()

    expect(h.reopenTask).toHaveBeenCalledWith('t2', 'self')
    expect(h.listTasks).toHaveBeenCalledTimes(2)
    expect(h.notifyTasksChanged).toHaveBeenCalledTimes(1)
    expect(shown(el, 'tasks-action-error')).toBeNull()
  })

  // P2-a: `completeTask`/`reopenTask` reporting `org_missing` (the same 422 ORG_MISSING trigger
  // `createTask` already covers above) must show the SAME org-guidance block, not a silently
  // dropped click or the generic action-error message.
  it('completing a task that reports org_missing shows the org-missing guidance (not the generic action error)', async () => {
    h.listTasks.mockResolvedValue({ kind: 'ok', items: [taskItem({ id: 't1', status: 'open' })] })
    h.completeTask.mockResolvedValue({ kind: 'org_missing' })
    const el = await mountReady()

    const completeButton = shown(el, 'tasks-complete-button') as HTMLButtonElement
    completeButton.click()
    await flush()

    expect(shown(el, 'tasks-view-org-missing')).toBeTruthy()
    expect(shown(el, 'tasks-list')).toBeNull()
    expect(shown(el, 'tasks-action-error')).toBeNull()
    // No refresh on org_missing — same discipline as every other non-ok action result.
    expect(h.listTasks).toHaveBeenCalledTimes(1)
    expect(h.notifyTasksChanged).not.toHaveBeenCalled()
  })

  it('reopening a task that reports org_missing shows the org-missing guidance (not the generic action error)', async () => {
    h.listTasks.mockResolvedValue({ kind: 'ok', items: [taskItem({ id: 't2', status: 'done' })] })
    h.reopenTask.mockResolvedValue({ kind: 'org_missing' })
    const el = await mountReady()

    const reopenButton = shown(el, 'tasks-reopen-button') as HTMLButtonElement
    reopenButton.click()
    await flush()

    expect(shown(el, 'tasks-view-org-missing')).toBeTruthy()
    expect(shown(el, 'tasks-list')).toBeNull()
    expect(shown(el, 'tasks-action-error')).toBeNull()
    expect(h.listTasks).toHaveBeenCalledTimes(1)
    expect(h.notifyTasksChanged).not.toHaveBeenCalled()
  })

  // P2-4: complete/reopen results other than ok/org_missing used to be silently dropped — the
  // click just did nothing. Each must now render a visible, per-result error AND leave the list
  // (the row the action failed on) exactly as it was, so a retry is still possible.
  describe('complete/reopen non-ok results surface a visible action error (P2-4)', () => {
    it.each([
      ['forbidden', { kind: 'forbidden' }, '您没有权限修改此任务'],
      ['not_found', { kind: 'not_found' }, '操作失败，请稍后重试'],
      ['error', { kind: 'error', status: 500 }, '操作失败，请稍后重试'],
    ] as const)('complete -> %s shows the action error and keeps the list', async (_label, result, expectedText) => {
      h.listTasks.mockResolvedValue({ kind: 'ok', items: [taskItem({ id: 't1', status: 'open' })] })
      h.completeTask.mockResolvedValue(result)
      const el = await mountReady()

      const completeButton = shown(el, 'tasks-complete-button') as HTMLButtonElement
      completeButton.click()
      await flush()

      const errorEl = shown(el, 'tasks-action-error')
      expect(errorEl).toBeTruthy()
      expect(errorEl?.textContent?.trim()).toBe(expectedText)
      // No second list read — the failed action does not refresh, but the ORIGINAL list stays.
      expect(h.listTasks).toHaveBeenCalledTimes(1)
      expect(shown(el, 'tasks-list')).toBeTruthy()
      expect(el.textContent).toContain('Task One')
      expect(h.notifyTasksChanged).not.toHaveBeenCalled()
      expect(shown(el, 'tasks-view-org-missing')).toBeNull()
    })

    it.each([
      ['forbidden', { kind: 'forbidden' }, '您没有权限修改此任务'],
      ['not_found', { kind: 'not_found' }, '操作失败，请稍后重试'],
      ['error', { kind: 'error', status: 500 }, '操作失败，请稍后重试'],
    ] as const)('reopen -> %s shows the action error and keeps the list', async (_label, result, expectedText) => {
      h.listTasks.mockResolvedValue({ kind: 'ok', items: [taskItem({ id: 't2', status: 'done' })] })
      h.reopenTask.mockResolvedValue(result)
      const el = await mountReady()

      const reopenButton = shown(el, 'tasks-reopen-button') as HTMLButtonElement
      reopenButton.click()
      await flush()

      const errorEl = shown(el, 'tasks-action-error')
      expect(errorEl).toBeTruthy()
      expect(errorEl?.textContent?.trim()).toBe(expectedText)
      expect(h.listTasks).toHaveBeenCalledTimes(1)
      expect(shown(el, 'tasks-list')).toBeTruthy()
      expect(h.notifyTasksChanged).not.toHaveBeenCalled()
    })

    it('a fresh action clears a stale error from the PREVIOUS action', async () => {
      h.listTasks.mockResolvedValue({ kind: 'ok', items: [taskItem({ id: 't1', status: 'open' })] })
      h.completeTask
        .mockResolvedValueOnce({ kind: 'forbidden' })
        .mockResolvedValueOnce({ kind: 'ok', done: true })
      const el = await mountReady()

      const completeButton = shown(el, 'tasks-complete-button') as HTMLButtonElement
      completeButton.click()
      await flush()
      expect(shown(el, 'tasks-action-error')).toBeTruthy()

      completeButton.click()
      await flush()
      expect(shown(el, 'tasks-action-error')).toBeNull()
    })

    // P3(iv): the mirror of the test above, for `onReopen`'s OWN `actionErrorKind.value = null`
    // reset (~:263) — the complete-only test above cannot exercise this: it never calls
    // `reopenTask` at all, so it would stay green even if reopen's own reset were deleted.
    it('a fresh reopen clears a stale action error from a PREVIOUS reopen', async () => {
      h.listTasks.mockResolvedValue({ kind: 'ok', items: [taskItem({ id: 't2', status: 'done' })] })
      h.reopenTask
        .mockResolvedValueOnce({ kind: 'forbidden' })
        .mockResolvedValueOnce({ kind: 'ok' })
      const el = await mountReady()

      const reopenButton = shown(el, 'tasks-reopen-button') as HTMLButtonElement
      reopenButton.click()
      await flush()
      expect(shown(el, 'tasks-action-error')).toBeTruthy()

      reopenButton.click()
      await flush()
      expect(shown(el, 'tasks-action-error')).toBeNull()
    })
  })
})

// P3(iii): once EITHER action sets `orgMissingFromAction`, the guidance block replaces the entire
// ready UI — including the complete/reopen buttons themselves — so the only way to reach "a LATER
// action succeeds while the flag is stuck true" is for a SECOND, independent action to already be
// in flight when the first one flips the flag. Each test below holds one action pending with a
// `deferred()`, triggers the OTHER action to set the guidance flag, then resolves the pending one
// with 'ok' and checks the guidance clears.
describe('TasksView resets a stale orgMissingFromAction when a later action succeeds (P3-iii)', () => {
  it('a pending complete resolving ok AFTER a reopen set org_missing clears the guidance block', async () => {
    h.listTasks.mockResolvedValue({
      kind: 'ok',
      items: [taskItem({ id: 't1', status: 'open' }), taskItem({ id: 't2', status: 'done' })],
    })
    const completeDeferred = deferred<{ kind: 'ok'; done: boolean }>()
    h.completeTask.mockReturnValue(completeDeferred.promise)
    h.reopenTask.mockResolvedValue({ kind: 'org_missing' })
    const el = await mountReady()

    const completeButton = shown(el, 'tasks-complete-button') as HTMLButtonElement
    completeButton.click()
    await flush()
    expect(h.completeTask).toHaveBeenCalledWith('t1')

    const reopenButton = shown(el, 'tasks-reopen-button') as HTMLButtonElement
    reopenButton.click()
    await flush()
    expect(shown(el, 'tasks-view-org-missing')).toBeTruthy()

    // The list read the guidance-clearing `loadList()` below triggers.
    h.listTasks.mockResolvedValueOnce({ kind: 'ok', items: [] })
    completeDeferred.resolve({ kind: 'ok', done: true })
    await flush()

    expect(shown(el, 'tasks-view-org-missing')).toBeNull()
    expect(shown(el, 'tasks-list-empty')).toBeTruthy()
  })

  it('a pending reopen resolving ok AFTER a complete set org_missing clears the guidance block', async () => {
    h.listTasks.mockResolvedValue({
      kind: 'ok',
      items: [taskItem({ id: 't1', status: 'open' }), taskItem({ id: 't2', status: 'done' })],
    })
    const reopenDeferred = deferred<{ kind: 'ok' }>()
    h.reopenTask.mockReturnValue(reopenDeferred.promise)
    h.completeTask.mockResolvedValue({ kind: 'org_missing' })
    const el = await mountReady()

    const reopenButton = shown(el, 'tasks-reopen-button') as HTMLButtonElement
    reopenButton.click()
    await flush()
    expect(h.reopenTask).toHaveBeenCalledWith('t2', 'self')

    const completeButton = shown(el, 'tasks-complete-button') as HTMLButtonElement
    completeButton.click()
    await flush()
    expect(shown(el, 'tasks-view-org-missing')).toBeTruthy()

    h.listTasks.mockResolvedValueOnce({ kind: 'ok', items: [] })
    reopenDeferred.resolve({ kind: 'ok' })
    await flush()

    expect(shown(el, 'tasks-view-org-missing')).toBeNull()
    expect(shown(el, 'tasks-list-empty')).toBeTruthy()
  })
})

// The full `/tasks/:id` render/action/guard surface (backend PR #6062, `GET /api/tasks/:id`) lives
// in `tasks-detail-view.spec.ts`. This file keeps only the boundary check that matters HERE: a
// detail-route mount must never trigger the LIST read this file otherwise exercises exhaustively.
describe('TasksView /tasks/:id boundary', () => {
  it('issues no list read for a /tasks/:id route (it loads the detail instead)', async () => {
    h.route.params = { id: 'tsk_1' }
    const el = await mountReady()

    expect(h.getTask).toHaveBeenCalledWith('tsk_1')
    expect(h.listTasks).not.toHaveBeenCalled()
    expect(shown(el, 'tasks-list')).toBeNull()
    expect(shown(el, 'tasks-list-empty')).toBeNull()
  })
})
