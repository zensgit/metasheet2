import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'

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
}))

vi.mock('../src/tasks/tasksBadgeBus', () => ({
  notifyTasksChanged: h.notifyTasksChanged,
}))

// M3: `useAuth().getCurrentUserId()` is called once a detail route is entered (own-comment /
// leave-button gating, covered in tasks-detail-m3.spec.ts). Defaults to an unresolved id here.
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({ getCurrentUserId: h.getCurrentUserId }),
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

  // `due_at` used to render as the raw ISO instant. It now goes through the SAME viewer-local
  // formatter the detail page already uses (`tasksDateDisplay.ts`) — mirrored here for the list
  // row, comparing against a live call to the same function (not a hardcoded string) so this
  // stays correct regardless of the host machine's own time zone.
  it('formats a row due_at viewer-local (not the raw ISO instant)', async () => {
    h.listTasks.mockResolvedValue({ kind: 'ok', items: [taskItem({ id: 't1', due_at: '2026-10-01T09:00:00Z' })] })
    const el = await mountReady()

    const due = shown(el, 'tasks-list-item-due')
    expect(due?.textContent).toBe(formatViewerInstant('2026-10-01T09:00:00Z'))
    expect(due?.textContent).not.toBe('2026-10-01T09:00:00Z')
  })

  it('renders no due element for a row with due_at: null', async () => {
    h.listTasks.mockResolvedValue({ kind: 'ok', items: [taskItem({ id: 't1', due_at: null })] })
    const el = await mountReady()

    expect(shown(el, 'tasks-list-item-due')).toBeNull()
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

// Mirrors the detail page's own navigate-away guard (`taskId.value !== id`, see
// `tasks-detail-view.spec.ts`'s "navigate-away while a complete/reopen request is pending" block)
// for the LIST side: a row action (or the create form) started on one list VIEW must not paint its
// banner/guidance over a DIFFERENT view the viewer switched to before the response landed. The
// navigate-to-`/tasks/:id` half of this guard needs a REAL router (a mocked, non-reactive `route`
// object here can't simulate that transition) and lives in `tasks-view-transitions.spec.ts`
// instead.
describe('TasksView list — late action result after switching list view (M2 list-page-token guard)', () => {
  it('a PENDING error from complete that settles AFTER switching list view shows no banner, and does not reload the new view', async () => {
    h.listTasks
      .mockResolvedValueOnce({ kind: 'ok', items: [taskItem({ id: 't1', status: 'open' })] })
      .mockResolvedValueOnce({ kind: 'ok', items: [taskItem({ id: 't9', title: 'Following Item', status: 'open' })] })
    const pendingComplete = deferred<{ kind: 'error'; status: number }>()
    h.completeTask.mockReturnValue(pendingComplete.promise)
    const el = await mountReady()

    const completeButton = shown(el, 'tasks-complete-button') as HTMLButtonElement
    completeButton.click()
    await flush()

    const followingButton = shown(el, 'tasks-view-switch-following') as HTMLButtonElement
    followingButton.click()
    await flush()
    expect(el.textContent).toContain('Following Item')
    expect(h.listTasks).toHaveBeenCalledTimes(2)

    pendingComplete.resolve({ kind: 'error', status: 500 })
    await flush()

    // A mutant that drops the page-token check would set `actionErrorKind` here (the ONLY thing
    // that could produce this banner) and leave the abandoned "Following Item" view undisturbed
    // either way — the banner is what proves the guard fired, not the list content.
    expect(shown(el, 'tasks-action-error')).toBeNull()
    expect(el.textContent).toContain('Following Item')
    expect(h.notifyTasksChanged).not.toHaveBeenCalled()
  })

  it('a PENDING org_missing from complete that settles AFTER switching list view shows no guidance banner', async () => {
    h.listTasks
      .mockResolvedValueOnce({ kind: 'ok', items: [taskItem({ id: 't1', status: 'open' })] })
      .mockResolvedValueOnce({ kind: 'ok', items: [taskItem({ id: 't9', title: 'Following Item', status: 'open' })] })
    const pendingComplete = deferred<{ kind: 'org_missing' }>()
    h.completeTask.mockReturnValue(pendingComplete.promise)
    const el = await mountReady()

    const completeButton = shown(el, 'tasks-complete-button') as HTMLButtonElement
    completeButton.click()
    await flush()

    const followingButton = shown(el, 'tasks-view-switch-following') as HTMLButtonElement
    followingButton.click()
    await flush()

    pendingComplete.resolve({ kind: 'org_missing' })
    await flush()

    // Without the guard, `applyActionOutcome('org_missing')` sets `orgMissingFromAction`, which
    // replaces the ENTIRE ready UI (including the "Following Item" view the viewer switched to).
    expect(shown(el, 'tasks-view-org-missing')).toBeNull()
    expect(el.textContent).toContain('Following Item')
  })

  it('a PENDING ok from reopen that settles AFTER switching list view still notifies the badge bus but does not issue a needless extra reload', async () => {
    h.listTasks
      .mockResolvedValueOnce({ kind: 'ok', items: [taskItem({ id: 't2', status: 'done' })] })
      .mockResolvedValueOnce({ kind: 'ok', items: [taskItem({ id: 't9', title: 'Following Item', status: 'open' })] })
    const pendingReopen = deferred<{ kind: 'ok' }>()
    h.reopenTask.mockReturnValue(pendingReopen.promise)
    const el = await mountReady()

    const reopenButton = shown(el, 'tasks-reopen-button') as HTMLButtonElement
    reopenButton.click()
    await flush()

    const followingButton = shown(el, 'tasks-view-switch-following') as HTMLButtonElement
    followingButton.click()
    await flush()
    expect(h.listTasks).toHaveBeenCalledTimes(2)

    pendingReopen.resolve({ kind: 'ok' })
    await flush()

    // Still exactly 2 list reads — "following" is now the CURRENT view (the viewer switched TO
    // it), so a mutant that drops the guard wouldn't show wrong data here; it would just let this
    // stale 'ok' call `loadList()` a needless THIRD time, re-fetching the same current view. The
    // badge bus still hears about it: the mutation really happened server-side.
    expect(h.listTasks).toHaveBeenCalledTimes(2)
    expect(h.notifyTasksChanged).toHaveBeenCalledTimes(1)
    expect(el.textContent).toContain('Following Item')
  })

  it('a PENDING org_missing from create that settles AFTER switching list view shows no guidance banner', async () => {
    h.listTasks
      .mockResolvedValueOnce({ kind: 'ok', items: [] })
      .mockResolvedValueOnce({ kind: 'ok', items: [taskItem({ id: 't9', title: 'Following Item', status: 'open' })] })
    const pendingCreate = deferred<{ kind: 'org_missing' }>()
    h.createTask.mockReturnValue(pendingCreate.promise)
    const el = await mountReady()

    const titleInput = shown(el, 'tasks-create-title') as HTMLInputElement
    titleInput.value = 'New task'
    titleInput.dispatchEvent(new Event('input'))
    await flush()
    const form = shown(el, 'tasks-create-form') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()

    const followingButton = shown(el, 'tasks-view-switch-following') as HTMLButtonElement
    followingButton.click()
    await flush()

    pendingCreate.resolve({ kind: 'org_missing' })
    await flush()

    expect(shown(el, 'tasks-view-org-missing')).toBeNull()
    expect(el.textContent).toContain('Following Item')
  })

  // The task really was created server-side even though the viewer switched away before hearing
  // back — leaving the typed title sitting in the input would invite a duplicate submit the next
  // time they're back on the list, even though nothing failed.
  it('a PENDING ok from create that settles AFTER switching list view still clears the title and notifies, without a needless extra reload', async () => {
    h.listTasks
      .mockResolvedValueOnce({ kind: 'ok', items: [] })
      .mockResolvedValueOnce({ kind: 'ok', items: [taskItem({ id: 't9', title: 'Following Item', status: 'open' })] })
    const pendingCreate = deferred<{ kind: 'ok'; id: string }>()
    h.createTask.mockReturnValue(pendingCreate.promise)
    const el = await mountReady()

    const titleInput = shown(el, 'tasks-create-title') as HTMLInputElement
    titleInput.value = 'New task'
    titleInput.dispatchEvent(new Event('input'))
    await flush()
    const form = shown(el, 'tasks-create-form') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()

    const followingButton = shown(el, 'tasks-view-switch-following') as HTMLButtonElement
    followingButton.click()
    await flush()
    expect(h.listTasks).toHaveBeenCalledTimes(2)

    pendingCreate.resolve({ kind: 'ok', id: 't10' })
    await flush()

    expect(titleInput.value).toBe('')
    expect(h.notifyTasksChanged).toHaveBeenCalledTimes(1)
    // Still exactly 2 list reads — a mutant that drops the guard would let this stale 'ok' call
    // `loadList()` a needless THIRD time.
    expect(h.listTasks).toHaveBeenCalledTimes(2)
    expect(el.textContent).toContain('Following Item')
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
