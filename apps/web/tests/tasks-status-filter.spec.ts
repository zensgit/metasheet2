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
    // The pressed option stays enabled: keyboard focus stays on it after activation and
    // screen-reader focus mode can reach it. Only `aria-pressed` marks it.
    expect((['open', 'done', 'all'] as const).map((value) => statusButton(el, value).disabled)).toEqual([false, false, false])
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

  it('g2core|fe|same: pressing the current status (an enabled button) does not read again', async () => {
    const el = await mountReady()
    const current = statusButton(el, 'open')
    expect(current.disabled).toBe(false)
    current.focus()
    current.click()
    await flush()
    expect(h.listTasks).toHaveBeenCalledTimes(1)
    expect(pressed(el)).toEqual(['open'])
    expect(document.activeElement).toBe(current)
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

  // An "any" mode row: an "all" mode row has no inline complete and links to the task detail.
  it('g2core|fe|reload after complete keeps the status', async () => {
    h.listTasks.mockResolvedValue({ kind: 'ok', items: [taskItem({ id: 't1', completion_mode: 'any' })] })
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

// The status analogues of the view switch's page-token cells (tasks-list-view.spec.ts, "late action
// result after switching list view"): `switchStatus` moves the page on like `switchView`, so a row
// action or create started under the previous status must not act on the new status's rows.
// The row complete / reopen cells use "any" mode rows: an "all" mode row has no inline buttons and
// links to the task detail instead.
describe('G2-core status switch — late action result after switching status (list-page-token guard)', () => {
  function submitCreate(el: HTMLElement): void {
    const titleInput = shown(el, 'tasks-create-title') as HTMLInputElement
    titleInput.value = 'New task'
    titleInput.dispatchEvent(new Event('input'))
  }

  it('g2core|fe|token|a pending error from complete settling after a status switch shows no banner and does not reload', async () => {
    h.listTasks
      .mockResolvedValueOnce({ kind: 'ok', items: [taskItem({ id: 't1', status: 'open', completion_mode: 'any' })] })
      .mockResolvedValueOnce({ kind: 'ok', items: [taskItem({ id: 't9', title: 'Done Item', status: 'done' })] })
    const pendingComplete = deferred<{ kind: 'error'; status: number }>()
    h.completeTask.mockReturnValue(pendingComplete.promise)
    const el = await mountReady()
    ;(shown(el, 'tasks-complete-button') as HTMLButtonElement).click()
    await flush()
    statusButton(el, 'done').click()
    await flush()
    expect(el.textContent).toContain('Done Item')
    expect(h.listTasks).toHaveBeenCalledTimes(2)

    pendingComplete.resolve({ kind: 'error', status: 500 })
    await flush()
    expect(shown(el, 'tasks-action-error')).toBeNull()
    expect(h.listTasks).toHaveBeenCalledTimes(2)
    expect(el.textContent).toContain('Done Item')
    expect(h.notifyTasksChanged).not.toHaveBeenCalled()
  })

  it('g2core|fe|token|a pending org_missing from complete settling after a status switch shows no guidance block', async () => {
    h.listTasks
      .mockResolvedValueOnce({ kind: 'ok', items: [taskItem({ id: 't1', status: 'open', completion_mode: 'any' })] })
      .mockResolvedValueOnce({ kind: 'ok', items: [taskItem({ id: 't9', title: 'Done Item', status: 'done' })] })
    const pendingComplete = deferred<{ kind: 'org_missing' }>()
    h.completeTask.mockReturnValue(pendingComplete.promise)
    const el = await mountReady()
    ;(shown(el, 'tasks-complete-button') as HTMLButtonElement).click()
    await flush()
    statusButton(el, 'done').click()
    await flush()

    pendingComplete.resolve({ kind: 'org_missing' })
    await flush()
    expect(shown(el, 'tasks-view-org-missing')).toBeNull()
    expect(el.textContent).toContain('Done Item')
  })

  it('g2core|fe|token|a pending ok from reopen settling after a status switch notifies the badge bus without a needless reload', async () => {
    h.listTasks
      .mockResolvedValueOnce({ kind: 'ok', items: [taskItem({ id: 't2', status: 'done', completion_mode: 'any' })] })
      .mockResolvedValueOnce({ kind: 'ok', items: [taskItem({ id: 't9', title: 'All Item', status: 'open' })] })
    const pendingReopen = deferred<{ kind: 'ok' }>()
    h.reopenTask.mockReturnValue(pendingReopen.promise)
    const el = await mountReady()
    ;(shown(el, 'tasks-reopen-button') as HTMLButtonElement).click()
    await flush()
    statusButton(el, 'all').click()
    await flush()
    expect(h.listTasks).toHaveBeenCalledTimes(2)

    pendingReopen.resolve({ kind: 'ok' })
    await flush()
    expect(h.listTasks).toHaveBeenCalledTimes(2)
    expect(h.notifyTasksChanged).toHaveBeenCalledTimes(1)
    expect(el.textContent).toContain('All Item')
  })

  it('g2core|fe|token|a pending org_missing from create settling after a status switch shows no guidance block', async () => {
    h.listTasks
      .mockResolvedValueOnce({ kind: 'ok', items: [] })
      .mockResolvedValueOnce({ kind: 'ok', items: [taskItem({ id: 't9', title: 'Done Item', status: 'done' })] })
    const pendingCreate = deferred<{ kind: 'org_missing' }>()
    h.createTask.mockReturnValue(pendingCreate.promise)
    const el = await mountReady()
    submitCreate(el)
    await flush()
    ;(shown(el, 'tasks-create-form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    statusButton(el, 'done').click()
    await flush()

    pendingCreate.resolve({ kind: 'org_missing' })
    await flush()
    expect(shown(el, 'tasks-view-org-missing')).toBeNull()
    expect(el.textContent).toContain('Done Item')
  })

  it('g2core|fe|token|a pending ok from create settling after a status switch clears the title and notifies, without a needless reload', async () => {
    h.listTasks
      .mockResolvedValueOnce({ kind: 'ok', items: [] })
      .mockResolvedValueOnce({ kind: 'ok', items: [taskItem({ id: 't9', title: 'Done Item', status: 'done' })] })
    const pendingCreate = deferred<{ kind: 'ok'; id: string }>()
    h.createTask.mockReturnValue(pendingCreate.promise)
    const el = await mountReady()
    submitCreate(el)
    await flush()
    ;(shown(el, 'tasks-create-form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    statusButton(el, 'done').click()
    await flush()
    expect(h.listTasks).toHaveBeenCalledTimes(2)

    pendingCreate.resolve({ kind: 'ok', id: 't10' })
    await flush()
    expect((shown(el, 'tasks-create-title') as HTMLInputElement).value).toBe('')
    expect(h.notifyTasksChanged).toHaveBeenCalledTimes(1)
    expect(h.listTasks).toHaveBeenCalledTimes(2)
    expect(el.textContent).toContain('Done Item')
    // The create belongs to the page it started on: no hidden-by-filter notice on the page now showing.
    expect(shown(el, 'tasks-create-hidden-notice')).toBeNull()
  })
})

// The empty line names the status it was read under (NIT from the G2-core gate).
describe('G2-core status switch — the empty line', () => {
  it('g2core|fe|empty: 未完成 / 已完成 / 全部 each name their own empty set', async () => {
    const el = await mountReady()
    expect(shown(el, 'tasks-list-empty')?.textContent?.trim()).toBe('暂无未完成任务')
    statusButton(el, 'done').click()
    await flush()
    expect(shown(el, 'tasks-list-empty')?.textContent?.trim()).toBe('暂无已完成任务')
    statusButton(el, 'all').click()
    await flush()
    expect(shown(el, 'tasks-list-empty')?.textContent?.trim()).toBe('暂无任务')
  })
})

// The status filter together with #6390 (merged from main): an "all" mode row offers its complete
// / reopen on the task detail instead of inline, and the create form carries an optional due date.
// The fake backend below filters by `status` as the server does (`tasks.status`), so each cell
// sees the rows the real list read would return under the switch.
describe('G2-core status switch — with the all-mode row link and the create due date', () => {
  type Row = ReturnType<typeof taskItem>
  let rows: Row[] = []

  function serveRows(): void {
    h.listTasks.mockImplementation(async (_view: string, _page: unknown, status?: 'open' | 'done' | 'all') => {
      const items = rows.filter((row) => status === undefined || status === 'all' || row.status === status)
      return { kind: 'ok', items, total: items.length }
    })
  }

  /** title -> the row's own action: the detail link's text, or the inline button. */
  function rowActions(el: HTMLElement): Record<string, string> {
    const out: Record<string, string> = {}
    for (const link of Array.from(el.querySelectorAll('[data-testid="tasks-list-item-link"]'))) {
      const row = link.parentElement as HTMLElement
      const detail = row.querySelector('[data-testid="tasks-row-detail-action"]')
      out[link.textContent?.trim() ?? ''] = detail
        ? `detail:${detail.textContent?.trim()}`
        : row.querySelector('[data-testid="tasks-complete-button"]')
          ? 'complete'
          : row.querySelector('[data-testid="tasks-reopen-button"]')
            ? 'reopen'
            : 'none'
    }
    return out
  }

  function onBoard(el: HTMLElement): boolean {
    return el.querySelector('[data-testid="tasks-group"]') !== null
  }

  async function setControl(el: HTMLElement, testid: string, value: string): Promise<void> {
    const input = shown(el, testid) as HTMLInputElement
    input.value = value
    input.dispatchEvent(new Event('input'))
    await flush()
  }

  beforeEach(() => {
    rows = [
      taskItem({ id: 'a1', title: 'All Open', status: 'open', completion_mode: 'all' }),
      taskItem({ id: 'a2', title: 'All Done', status: 'done', completion_mode: 'all' }),
      taskItem({ id: 'y1', title: 'Any Open', status: 'open', completion_mode: 'any' }),
      taskItem({ id: 'y2', title: 'Any Done', status: 'done', completion_mode: 'any' }),
    ]
    serveRows()
  })

  const EXPECTED = {
    open: { 'All Open': 'detail:在任务详情中完成', 'Any Open': 'complete' },
    done: { 'All Done': 'detail:在任务详情中重启', 'Any Done': 'reopen' },
    all: {
      'All Open': 'detail:在任务详情中完成',
      'All Done': 'detail:在任务详情中重启',
      'Any Open': 'complete',
      'Any Done': 'reopen',
    },
  } as const

  it('g2core|fe|6390|on the assigned view board, every status shows all-mode rows as a detail link and any-mode rows with their inline action', async () => {
    // The board mounts with the rows and then reads the groups and the placements: two more flushes.
    const el = await mountReady()
    await flush(8)
    expect(onBoard(el)).toBe(true)
    expect(rowActions(el)).toEqual(EXPECTED.open)
    for (const status of ['done', 'all', 'open'] as const) {
      statusButton(el, status).click()
      await flush(12)
      expect(onBoard(el)).toBe(true)
      expect(h.listTasks).toHaveBeenLastCalledWith('assigned', undefined, status)
      expect(rowActions(el)).toEqual(EXPECTED[status])
    }
    expect(h.completeTask).not.toHaveBeenCalled()
    expect(h.reopenTask).not.toHaveBeenCalled()
  })

  it('g2core|fe|6390|on a flat list view, every status shows all-mode rows as a detail link and any-mode rows with their inline action', async () => {
    const el = await mountReady()
    ;(shown(el, 'tasks-view-switch-created') as HTMLButtonElement).click()
    await flush()
    expect(onBoard(el)).toBe(false)
    expect(rowActions(el)).toEqual(EXPECTED.open)
    for (const status of ['done', 'all', 'open'] as const) {
      statusButton(el, status).click()
      await flush()
      expect(onBoard(el)).toBe(false)
      expect(h.listTasks).toHaveBeenLastCalledWith('created', undefined, status)
      expect(rowActions(el)).toEqual(EXPECTED[status])
    }
    expect(h.completeTask).not.toHaveBeenCalled()
    expect(h.reopenTask).not.toHaveBeenCalled()
  })

  it('g2core|fe|6390|an inline complete under 未完成 reloads under 未完成, and the completed row leaves the list', async () => {
    h.completeTask.mockImplementation(async (id: string) => {
      rows = rows.map((row) => (row.id === id ? { ...row, status: 'done' as const } : row))
      return { kind: 'ok', done: true }
    })
    const el = await mountReady()
    ;(Array.from(el.querySelectorAll('[data-testid="tasks-complete-button"]'))[0] as HTMLButtonElement).click()
    await flush()
    expect(h.completeTask).toHaveBeenCalledWith('y1')
    expect(h.listTasks).toHaveBeenLastCalledWith('assigned', undefined, 'open')
    expect(rowActions(el)).toEqual({ 'All Open': 'detail:在任务详情中完成' })
  })

  // A create while 已完成 is on is sent with its due date, the form is cleared, and the reload
  // stays under 已完成 (the remembered choice is not switched for the viewer), so the new (open)
  // task is not in the list: an inline notice says so, and its action moves the switch to 未完成.
  it('g2core|fe|6390|a create with a due date while 已完成 is on: sent with the due keys, form cleared, reload stays under 已完成, the notice leads to it', async () => {
    h.createTask.mockImplementation(async (body: { title: string; completionMode: 'all' | 'any' }) => {
      rows = [...rows, taskItem({ id: 'n1', title: body.title, status: 'open', completion_mode: body.completionMode })]
      return { kind: 'ok', id: 'n1' }
    })
    const el = await mountReady()
    statusButton(el, 'done').click()
    await flush()

    await setControl(el, 'tasks-create-title', 'Fresh Task')
    await setControl(el, 'tasks-create-due-date', '2031-03-04')
    await setControl(el, 'tasks-create-due-time', '09:30')
    ;(shown(el, 'tasks-create-form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()

    expect(h.createTask).toHaveBeenCalledTimes(1)
    expect(h.createTask.mock.calls[0][0]).toEqual({
      title: 'Fresh Task',
      completionMode: 'all',
      dueDate: '2031-03-04',
      dueTime: '09:30',
      timeZone: 'UTC',
    })
    expect(h.notifyTasksChanged).toHaveBeenCalledTimes(1)
    expect(h.listTasks).toHaveBeenLastCalledWith('assigned', undefined, 'done')
    expect(pressed(el)).toEqual(['done'])
    expect((shown(el, 'tasks-create-title') as HTMLInputElement).value).toBe('')
    expect((shown(el, 'tasks-create-due-date') as HTMLInputElement).value).toBe('')
    expect((shown(el, 'tasks-create-due-time') as HTMLInputElement).value).toBe('')
    expect(rowActions(el)).toEqual(EXPECTED.done)
    expect(shown(el, 'tasks-create-hidden-notice')).not.toBeNull()
    expect(window.localStorage.getItem(KEY)).toBe('done')

    ;(shown(el, 'tasks-create-hidden-show-open') as HTMLButtonElement).click()
    await flush()
    expect(h.listTasks).toHaveBeenLastCalledWith('assigned', undefined, 'open')
    expect(pressed(el)).toEqual(['open'])
    expect(window.localStorage.getItem(KEY)).toBe('open')
    expect(shown(el, 'tasks-create-hidden-notice')).toBeNull()
    expect(rowActions(el)).toEqual({ ...EXPECTED.open, 'Fresh Task': 'detail:在任务详情中完成' })
  })
})

// A create while 已完成 is on makes a task the reloaded list leaves out (a new task is never
// completed). The page says so inline, without a dialog and without switching the remembered
// filter, and always offers the new task's page. In a view that lists the creator's new task
// (分配给我 / 我创建的 / 任一角色) it also offers the 未完成 switch; in 关注中 / 我委派的, which leave the
// new task out under any status, it offers only the task's page and does not put the hiding down
// to the filter alone. Under 未完成 and 全部 nothing is said. The notice goes with the next create
// (whatever its outcome) and with a status or view switch.
describe('G2-core status switch — a new task the filter leaves out', () => {
  type Row = ReturnType<typeof taskItem>
  let rows: Row[] = []
  let nextId = 0
  // Tasks the create form made: the creator is their only assignee and nobody follows them, so the
  // server leaves them out of 关注中 and 我委派的 under any status. The fake list read does the same.
  let created = new Set<string>()

  beforeEach(() => {
    rows = [taskItem({ id: 'd1', title: 'Old Done', status: 'done', completion_mode: 'any' })]
    nextId = 0
    created = new Set()
    h.listTasks.mockImplementation(async (view: string, _page: unknown, status?: 'open' | 'done' | 'all') => {
      const items = rows.filter((row) =>
        (status === undefined || status === 'all' || row.status === status)
        && !((view === 'following' || view === 'delegated') && created.has(row.id)))
      return { kind: 'ok', items, total: items.length }
    })
    h.createTask.mockImplementation(async (body: { title: string; completionMode: 'all' | 'any' }) => {
      nextId += 1
      const id = `n${nextId}`
      created.add(id)
      rows = [...rows, taskItem({ id, title: body.title, status: 'open', completion_mode: body.completionMode })]
      return { kind: 'ok', id }
    })
  })

  async function create(el: HTMLElement, title: string): Promise<void> {
    const input = shown(el, 'tasks-create-title') as HTMLInputElement
    input.value = title
    input.dispatchEvent(new Event('input'))
    await flush()
    ;(shown(el, 'tasks-create-form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
  }

  function titles(el: HTMLElement): string[] {
    return Array.from(el.querySelectorAll('[data-testid="tasks-list-item-link"]')).map((link) => link.textContent?.trim() ?? '')
  }

  function notice(el: HTMLElement): HTMLElement | null {
    return shown(el, 'tasks-create-hidden-notice')
  }

  it('g2core|fe|hidden|under 已完成 a create shows the inline notice with its two ways to the task, and the list stays under 已完成', async () => {
    window.localStorage.setItem(KEY, 'done')
    const el = await mountReady()
    expect(notice(el)).toBeNull()
    // The live region is on the page before anything is said in it (empty, no text), so the
    // notice is a change inside an existing polite region rather than a region that appears.
    const live = shown(el, 'tasks-create-hidden-live')
    expect(live?.getAttribute('role')).toBe('status')
    expect(live?.textContent?.trim()).toBe('')
    await create(el, 'Fresh Task')

    expect(h.createTask).toHaveBeenCalledTimes(1)
    expect(h.listTasks).toHaveBeenLastCalledWith('assigned', undefined, 'done')
    expect(pressed(el)).toEqual(['done'])
    expect(titles(el)).toEqual(['Old Done'])
    const box = notice(el)
    expect(box).not.toBeNull()
    // The same region element now carries the notice.
    expect(shown(el, 'tasks-create-hidden-live')).toBe(live)
    expect(box?.closest('[role="status"]')).toBe(live)
    expect(shown(el, 'tasks-create-hidden-text')?.textContent?.trim()).toBe(
      '任务已创建。新任务尚未完成，当前筛选为「已完成」，所以列表中不显示它。',
    )
    expect(shown(el, 'tasks-create-hidden-show-open')?.textContent?.trim()).toBe('查看未完成任务')
    const link = shown(el, 'tasks-create-hidden-open-task')
    expect(link?.textContent?.trim()).toBe('打开新任务')
    expect(link?.getAttribute('to')).toBe('/tasks/n1')
    // Not a list row: the row walkers above do not see the notice's link.
    expect(el.querySelectorAll('[data-testid="tasks-list-item-link"]').length).toBe(1)
  })

  it('g2core|fe|hidden|the notice action switches to 未完成 (remembered), shows the new task and clears the notice', async () => {
    window.localStorage.setItem(KEY, 'done')
    const el = await mountReady()
    await create(el, 'Fresh Task')
    expect(notice(el)).not.toBeNull()

    ;(shown(el, 'tasks-create-hidden-show-open') as HTMLButtonElement).click()
    await flush()
    expect(h.listTasks).toHaveBeenLastCalledWith('assigned', undefined, 'open')
    expect(pressed(el)).toEqual(['open'])
    expect(window.localStorage.getItem(KEY)).toBe('open')
    expect(titles(el)).toEqual(['Fresh Task'])
    expect(notice(el)).toBeNull()
    // The pressed button went away with the notice: focus is on the 未完成 switch, not the page body.
    expect(document.activeElement).toBe(statusButton(el, 'open'))
  })

  it('g2core|fe|hidden|the new task id in the link is encoded as a path segment', async () => {
    h.createTask.mockResolvedValueOnce({ kind: 'ok', id: 'a/b c' })
    window.localStorage.setItem(KEY, 'done')
    const el = await mountReady()
    await create(el, 'Odd Id')
    expect(shown(el, 'tasks-create-hidden-open-task')?.getAttribute('to')).toBe('/tasks/a%2Fb%20c')
  })

  it.each(['created', 'any_role'] as const)('g2core|fe|hidden|in the %s view under 已完成 the notice offers the 未完成 switch, which shows the new task', async (view) => {
    window.localStorage.setItem(KEY, 'done')
    const el = await mountReady()
    ;(shown(el, `tasks-view-switch-${view}`) as HTMLButtonElement).click()
    await flush()
    await create(el, 'Fresh Task')
    expect(h.listTasks).toHaveBeenLastCalledWith(view, undefined, 'done')
    expect(shown(el, 'tasks-create-hidden-text')?.textContent?.trim()).toBe(
      '任务已创建。新任务尚未完成，当前筛选为「已完成」，所以列表中不显示它。',
    )
    expect(shown(el, 'tasks-create-hidden-open-task')?.getAttribute('to')).toBe('/tasks/n1')

    ;(shown(el, 'tasks-create-hidden-show-open') as HTMLButtonElement).click()
    await flush()
    expect(h.listTasks).toHaveBeenLastCalledWith(view, undefined, 'open')
    expect(titles(el)).toContain('Fresh Task')
    expect(notice(el)).toBeNull()
  })

  it.each(['following', 'delegated'] as const)('g2core|fe|hidden|in the %s view under 已完成 the notice offers only the new task\'s page, not the 未完成 switch', async (view) => {
    window.localStorage.setItem(KEY, 'done')
    const el = await mountReady()
    ;(shown(el, `tasks-view-switch-${view}`) as HTMLButtonElement).click()
    await flush()
    await create(el, 'Fresh Task')
    expect(h.createTask).toHaveBeenCalledTimes(1)
    expect(h.listTasks).toHaveBeenLastCalledWith(view, undefined, 'done')
    expect(titles(el)).toEqual(['Old Done'])
    expect(notice(el)?.closest('[role="status"]')?.getAttribute('data-testid')).toBe('tasks-create-hidden-live')
    expect(shown(el, 'tasks-create-hidden-text')?.textContent?.trim()).toBe('任务已创建。当前视图和筛选下，列表中不显示它。')
    expect(shown(el, 'tasks-create-hidden-show-open')).toBeNull()
    const link = shown(el, 'tasks-create-hidden-open-task')
    expect(link?.textContent?.trim()).toBe('打开新任务')
    expect(link?.getAttribute('to')).toBe('/tasks/n1')
    expect(pressed(el)).toEqual(['done'])
    expect(window.localStorage.getItem(KEY)).toBe('done')
  })

  it.each(['open', 'all'] as const)('g2core|fe|hidden|under %s a create shows the new task in the list and no notice', async (status) => {
    window.localStorage.setItem(KEY, status)
    const el = await mountReady()
    await create(el, 'Fresh Task')
    expect(h.createTask).toHaveBeenCalledTimes(1)
    expect(h.listTasks).toHaveBeenLastCalledWith('assigned', undefined, status)
    expect(titles(el)).toContain('Fresh Task')
    expect(notice(el)).toBeNull()
  })

  it.each(['open', 'all'] as const)('g2core|fe|hidden|switching from 已完成 to %s clears the notice', async (status) => {
    window.localStorage.setItem(KEY, 'done')
    const el = await mountReady()
    await create(el, 'Fresh Task')
    expect(notice(el)).not.toBeNull()
    statusButton(el, status).click()
    await flush()
    expect(notice(el)).toBeNull()
    expect(titles(el)).toContain('Fresh Task')
  })

  it('g2core|fe|hidden|switching the view clears the notice (the status stays 已完成)', async () => {
    window.localStorage.setItem(KEY, 'done')
    const el = await mountReady()
    await create(el, 'Fresh Task')
    expect(notice(el)).not.toBeNull()
    ;(shown(el, 'tasks-view-switch-created') as HTMLButtonElement).click()
    await flush()
    expect(h.listTasks).toHaveBeenLastCalledWith('created', undefined, 'done')
    expect(notice(el)).toBeNull()
  })

  it('g2core|fe|hidden|the next create clears the notice: a failed one shows only its error', async () => {
    window.localStorage.setItem(KEY, 'done')
    const el = await mountReady()
    await create(el, 'Fresh Task')
    expect(notice(el)).not.toBeNull()

    h.createTask.mockResolvedValueOnce({ kind: 'error', status: 500 })
    await create(el, 'Second Task')
    expect(h.createTask).toHaveBeenCalledTimes(2)
    expect(notice(el)).toBeNull()
    expect(shown(el, 'tasks-create-error')?.textContent?.trim()).toBe('创建任务失败，请稍后重试')
  })

  it('g2core|fe|hidden|the next create clears the notice: one stopped by the due-date pre-check shows only that message', async () => {
    window.localStorage.setItem(KEY, 'done')
    const el = await mountReady()
    await create(el, 'Fresh Task')
    expect(notice(el)).not.toBeNull()

    h.resolveViewerTimeZone.mockReturnValue('')
    const due = shown(el, 'tasks-create-due-date') as HTMLInputElement
    due.value = '2031-03-04'
    due.dispatchEvent(new Event('input'))
    await create(el, 'Second Task')
    expect(h.createTask).toHaveBeenCalledTimes(1)
    expect(shown(el, 'tasks-create-due-error')).not.toBeNull()
    expect(notice(el)).toBeNull()
  })

  it('g2core|fe|hidden|a second create under 已完成 points the notice at the newest task', async () => {
    window.localStorage.setItem(KEY, 'done')
    const el = await mountReady()
    await create(el, 'First Task')
    expect(shown(el, 'tasks-create-hidden-open-task')?.getAttribute('to')).toBe('/tasks/n1')
    await create(el, 'Second Task')
    expect(h.createTask).toHaveBeenCalledTimes(2)
    expect(shown(el, 'tasks-create-hidden-open-task')?.getAttribute('to')).toBe('/tasks/n2')
    expect(el.querySelectorAll('[data-testid="tasks-create-hidden-notice"]').length).toBe(1)
  })
})
