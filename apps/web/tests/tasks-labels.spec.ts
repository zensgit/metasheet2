import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'

/**
 * M4 FE-0 — labels / i18n base for the task surfaces
 * (docs/development/task-m4-frontend-design-20261007.md §9, `R20` option (a)). Five groups (§9.3):
 *
 *   1. key parity between the ZH and EN tables, at runtime (on top of vue-tsc's `Record<keyof …>`);
 *   2. every ZH value contains CJK, no EN value does, and the two never coincide — format
 *      functions checked with fixed arguments;
 *   3. a sweep of the rendered text plus `aria-label` / `placeholder` / `title` attributes of
 *      TasksView (list and detail, fixtures with dates, every render state reachable today) and
 *      TasksTodoBadge (three states, and the switched-off scope since FE-2) under the EN locale
 *      finds no CJK; the same sweep under ZH finds CJK (positive control);
 *   4. a locale flip AFTER mount re-renders the copy — pins the `computed` table pick, not a
 *      one-shot evaluation at setup;
 *   5. `codeMessage` — every listed code resolves to non-fallback copy in both languages, an
 *      unlisted code to the fallback.
 *
 * This slice sweeps the two surfaces that exist today; each later slice adds its own view. FE-3
 * adds TasksSettingsView (every read state, the form, each inline error, the banner, "saved", the
 * time-zone notice) and the settings entry on the list header. FE-4 adds the detail page's editor
 * and lists section (the read-only rows, the conflict and server-updated notices, every inline
 * error, the banner copy for INVALID_VERSION, the lists section's states and errors). FE-5 adds the
 * lists sidebar on the list page (rows, roles, the archived mark, each read state, create errors,
 * load more) and the list page /task-lists/:id (every page state, the controls, inline errors, the
 * banner, the items section's states, the activity panel and its event words). FE-6 adds the
 * list page's members dialog (the rows, every control and its accessible name, both confirmations,
 * the cap notice, each read state, every error spot and the banner).
 *
 * Mock face: `tasksContext`, `tasksApi` (every call; `checkCommentBody` stays the real function so
 * the comment precheck's own code reaches the inline error), `useAuth`, and `useLocale` — the
 * latter with a MUTABLE `isZh` so a test can flip it after mount. The router is real (the
 * tasks-detail-view.spec.ts idiom). No backend is involved.
 */

const h_ = vi.hoisted(() => ({
  loadTasksContext: vi.fn(),
  listTasks: vi.fn(),
  getTask: vi.fn(),
  createTask: vi.fn(),
  completeTask: vi.fn(),
  reopenTask: vi.fn(),
  listComments: vi.fn(),
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
  fetchPendingCount: vi.fn(),
  getCurrentUserId: vi.fn(),
  // FE-3: the settings page's reads and writes.
  getTaskSettings: vi.fn(),
  patchTaskSettings: vi.fn(),
  resolveViewerTimeZone: vi.fn(),
  // FE-4: the detail page's "my lists" read and the editor / lists section writes.
  listAllTaskLists: vi.fn(),
  patchTask: vi.fn(),
  addTaskToList: vi.fn(),
  removeTaskFromList: vi.fn(),
  // FE-5: the lists sidebar on /tasks, and the list page /task-lists/:id.
  listTaskLists: vi.fn(),
  createTaskList: vi.fn(),
  getTaskList: vi.fn(),
  renameTaskList: vi.fn(),
  archiveTaskList: vi.fn(),
  unarchiveTaskList: vi.fn(),
  listTaskListItems: vi.fn(),
  listTaskListEvents: vi.fn(),
  // FE-6: the members dialog on the list page.
  listTaskListMembers: vi.fn(),
  addTaskListMember: vi.fn(),
  changeTaskListMemberRole: vi.fn(),
  removeTaskListMember: vi.fn(),
  transferTaskListOwner: vi.fn(),
  // FE-7: the grouping board's reads — the list page's groups and placements, and the assigned
  // view's personal groups and placements.
  listTaskListGroups: vi.fn(),
  listTaskListGroupItems: vi.fn(),
  listUserGroups: vi.fn(),
  listUserGroupItems: vi.fn(),
  // FE-7: the grouping board's writes, both scopes.
  placeTaskInUserGroup: vi.fn(),
  createUserGroup: vi.fn(),
  renameUserGroup: vi.fn(),
  deleteUserGroup: vi.fn(),
  placeTaskInListGroup: vi.fn(),
  createTaskListGroup: vi.fn(),
  renameTaskListGroup: vi.fn(),
  deleteTaskListGroup: vi.fn(),
}))

vi.mock('../src/tasks/tasksContext', () => ({
  loadTasksContext: h_.loadTasksContext,
}))

vi.mock('../src/tasks/tasksApi', async () => {
  const actual = await vi.importActual<typeof import('../src/tasks/tasksApi')>('../src/tasks/tasksApi')
  return {
    checkCommentBody: actual.checkCommentBody,
    listTasks: h_.listTasks,
    getTask: h_.getTask,
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
    fetchPendingCount: h_.fetchPendingCount,
    // FE-3: TasksSettingsView's calls, and the two closed sets tasksDraft.ts reads from this module.
    getTaskSettings: h_.getTaskSettings,
    patchTaskSettings: h_.patchTaskSettings,
    resolveViewerTimeZone: h_.resolveViewerTimeZone,
    TASK_BADGE_SCOPES: actual.TASK_BADGE_SCOPES,
    TASK_REMIND_MODES: actual.TASK_REMIND_MODES,
    // FE-4: the detail page's "my lists" read and the editor / lists section writes.
    listAllTaskLists: h_.listAllTaskLists,
    patchTask: h_.patchTask,
    addTaskToList: h_.addTaskToList,
    removeTaskFromList: h_.removeTaskFromList,
    // FE-5: the lists sidebar on /tasks, and the list page /task-lists/:id.
    listTaskLists: h_.listTaskLists,
    createTaskList: h_.createTaskList,
    getTaskList: h_.getTaskList,
    renameTaskList: h_.renameTaskList,
    archiveTaskList: h_.archiveTaskList,
    unarchiveTaskList: h_.unarchiveTaskList,
    listTaskListItems: h_.listTaskListItems,
    listTaskListEvents: h_.listTaskListEvents,
    // FE-6: the members dialog on the list page.
    listTaskListMembers: h_.listTaskListMembers,
    addTaskListMember: h_.addTaskListMember,
    changeTaskListMemberRole: h_.changeTaskListMemberRole,
    removeTaskListMember: h_.removeTaskListMember,
    transferTaskListOwner: h_.transferTaskListOwner,
    // FE-7: the grouping board's reads.
    listTaskListGroups: h_.listTaskListGroups,
    listTaskListGroupItems: h_.listTaskListGroupItems,
    listUserGroups: h_.listUserGroups,
    listUserGroupItems: h_.listUserGroupItems,
    // FE-7: the grouping board's writes.
    placeTaskInUserGroup: h_.placeTaskInUserGroup,
    createUserGroup: h_.createUserGroup,
    renameUserGroup: h_.renameUserGroup,
    deleteUserGroup: h_.deleteUserGroup,
    placeTaskInListGroup: h_.placeTaskInListGroup,
    createTaskListGroup: h_.createTaskListGroup,
    renameTaskListGroup: h_.renameTaskListGroup,
    deleteTaskListGroup: h_.deleteTaskListGroup,
  }
})

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({ getCurrentUserId: h_.getCurrentUserId }),
}))

// A mutable `isZh`: `setLocale` flips it, every consumer shares the one ref (the real composable
// is a module-scope singleton too). Starts in ZH; `afterEach` puts it back.
vi.mock('../src/composables/useLocale', () => {
  const isZh = ref(true)
  return {
    useLocale: () => ({
      locale: computed(() => (isZh.value ? 'zh-CN' : 'en')),
      isZh,
      setLocale: (next: unknown) => {
        isZh.value = next === 'zh-CN'
      },
      normalizeLocale: (value: unknown) => (value === 'zh-CN' ? 'zh-CN' : 'en'),
      supportedLocales: ['en', 'zh-CN'] as const,
    }),
  }
})

import TasksView from '../src/views/tasks/TasksView.vue'
import TasksSettingsView from '../src/views/tasks/TasksSettingsView.vue'
import TasksTodoBadge from '../src/tasks/TasksTodoBadge.vue'
import TaskListView from '../src/views/tasks/TaskListView.vue'
import { useLocale } from '../src/composables/useLocale'
import {
  TASKS_CODE_KEYS,
  TASKS_EN,
  TASKS_LIST_EVENT_KEYS,
  TASKS_FMT_EN,
  TASKS_FMT_ZH,
  TASKS_ZH,
  codeMessage,
  listEventLabel,
} from '../src/tasks/labels'
import { formatDueDisplay, formatViewerInstant } from '../src/tasks/tasksDateDisplay'

const { setLocale } = useLocale()

// Same widened CJK class as templateDetailI18n.spec.ts (CJK Unified Ideographs + CJK Symbols /
// Punctuation + Halfwidth-and-Fullwidth Forms): the fullwidth brackets count, so the EN due
// display must use ASCII ones.
const CJK = /[　-〿一-鿿＀-￯]/

// Same sweep as templateDetailI18n.spec.ts: the whole rendered text, plus every aria-label /
// placeholder / title attribute a plain textContent check would miss.
function renderedTextAndAttributes(root: HTMLElement): string {
  const parts = [root.textContent ?? '']
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const attr of ['aria-label', 'placeholder', 'title']) {
      const value = el.getAttribute(attr)
      if (value) parts.push(value)
    }
  }
  return parts.join(' | ')
}

// ---------------------------------------------------------------------------------------------
// Fixtures — ASCII-only so a CJK hit in the sweep can only come from the view's own copy.
// ---------------------------------------------------------------------------------------------

function listItem(over: Partial<{ id: string; title: string; status: 'open' | 'done'; due_at: string | null }> = {}) {
  return {
    id: 't1',
    title: 'Task One',
    status: 'open' as const,
    completion_mode: 'all' as const,
    created_by: 'u1',
    due_at: null as string | null,
    ...over,
  }
}

function taskDetail(over: Record<string, unknown> = {}) {
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
    assignees: [
      { userId: 'u2', completedAt: '2026-09-20T10:00:00Z' },
      { userId: 'u3', completedAt: null },
    ],
    canComplete: true,
    canReopen: true,
    canEdit: true,
    canDelete: true,
    canComment: true,
    canLeave: true,
    parentId: 'p1',
    depth: 1,
    children: [{ id: 'c1', title: 'Child One', status: 'done' }],
    followers: ['u9'],
    ...over,
  }
}

function comment(over: Partial<{ id: string; authorId: string; body: string | null; deleted: boolean }> = {}) {
  return {
    id: 'c1',
    taskId: 't1',
    authorId: 'u1',
    body: 'A comment',
    deleted: false,
    createdAt: '2026-09-21T10:00:00Z',
    ...over,
  }
}

function settingsFixture(over: Record<string, unknown> = {}) {
  return {
    badgeScope: 'overdue',
    dailyReminderEnabled: false,
    defaultRemindPolicy: { mode: 'default' },
    timeZone: null as string | null,
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

// ---------------------------------------------------------------------------------------------
// Mount helpers
// ---------------------------------------------------------------------------------------------

let app: VueApp<Element> | null = null
let container: HTMLDivElement | null = null
let router: Router | null = null

async function flush(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function mountViewAt(path: string): Promise<HTMLElement> {
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

/** FE-3: `/tasks/settings` on a real router laid out like appRoutes.ts. */
async function mountSettingsPage(): Promise<HTMLElement> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/tasks', component: TasksView },
      { path: '/tasks/settings', component: TasksSettingsView },
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
  await router.push('/tasks/settings')
  await router.isReady()
  await flush()
  return container
}

async function mountBadge(label: string): Promise<HTMLElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(TasksTodoBadge, { label })
  app.mount(container)
  await flush()
  return container.querySelector('[data-testid="tasks-todo-badge"]') as HTMLElement
}

function shown(el: HTMLElement, testid: string): HTMLElement | null {
  return el.querySelector(`[data-testid="${testid}"]`)
}

function must(el: HTMLElement, testid: string): HTMLElement {
  const found = shown(el, testid)
  expect(found, `expected [data-testid="${testid}"]`).toBeTruthy()
  return found as HTMLElement
}

function typeInto(el: HTMLElement, testid: string, value: string): void {
  const input = must(el, testid) as HTMLInputElement | HTMLTextAreaElement
  input.value = value
  input.dispatchEvent(new Event('input'))
}

async function submitForm(el: HTMLElement, testid: string): Promise<void> {
  must(el, testid).dispatchEvent(new Event('submit', { cancelable: true }))
  await flush()
}

async function click(el: HTMLElement, testid: string): Promise<void> {
  ;(must(el, testid) as HTMLButtonElement).click()
  await flush()
}

beforeEach(() => {
  setLocale('zh-CN')
  h_.loadTasksContext.mockReset().mockResolvedValue({ state: 'ready', orgId: 'org1' })
  h_.listTasks.mockReset().mockResolvedValue({ kind: 'ok', items: [listItem()] })
  h_.getTask.mockReset().mockResolvedValue({ kind: 'ok', task: taskDetail() })
  h_.createTask.mockReset().mockResolvedValue({ kind: 'ok', id: 't2' })
  h_.completeTask.mockReset().mockResolvedValue({ kind: 'ok' })
  h_.reopenTask.mockReset().mockResolvedValue({ kind: 'ok' })
  h_.listComments.mockReset().mockResolvedValue({ kind: 'ok', items: [], total: 0 })
  h_.setParent.mockReset().mockResolvedValue({ kind: 'ok' })
  h_.addAssignee.mockReset().mockResolvedValue({ kind: 'ok' })
  h_.removeAssignee.mockReset().mockResolvedValue({ kind: 'ok' })
  h_.setCompletionMode.mockReset().mockResolvedValue({ kind: 'ok' })
  h_.addFollower.mockReset().mockResolvedValue({ kind: 'ok' })
  h_.removeFollower.mockReset().mockResolvedValue({ kind: 'ok' })
  h_.leaveTask.mockReset().mockResolvedValue({ kind: 'ok' })
  h_.createComment.mockReset().mockResolvedValue({ kind: 'ok' })
  h_.editComment.mockReset().mockResolvedValue({ kind: 'ok' })
  h_.deleteComment.mockReset().mockResolvedValue({ kind: 'ok' })
  h_.deleteTask.mockReset().mockResolvedValue({ kind: 'ok' })
  h_.fetchPendingCount.mockReset().mockResolvedValue({ kind: 'ok', count: 3 })
  h_.getCurrentUserId.mockReset().mockResolvedValue('u1')
  h_.getTaskSettings.mockReset().mockResolvedValue({ kind: 'ok', settings: settingsFixture() })
  h_.patchTaskSettings.mockReset().mockResolvedValue({ kind: 'ok', settings: settingsFixture({ badgeScope: 'off' }) })
  h_.resolveViewerTimeZone.mockReset().mockReturnValue('Pacific/Chatham')
  h_.listAllTaskLists.mockReset().mockResolvedValue({ kind: 'ok', items: [], total: 0 })
  h_.patchTask.mockReset().mockResolvedValue({ kind: 'ok', id: 't1', version: 4 })
  h_.addTaskToList.mockReset().mockResolvedValue({ kind: 'ok', listId: 'tl_1', taskId: 't1' })
  h_.removeTaskFromList.mockReset().mockResolvedValue({ kind: 'ok', listId: 'tl_1', taskId: 't1' })
  h_.listTaskLists.mockReset().mockResolvedValue({ kind: 'ok', items: [], total: 0 })
  h_.createTaskList.mockReset()
  h_.getTaskList.mockReset().mockResolvedValue({ kind: 'ok', list: listFixture('tl_1', 'List One', 'owner') })
  h_.renameTaskList.mockReset().mockResolvedValue({ kind: 'ok', list: listFixture('tl_1', 'List One', 'owner') })
  h_.archiveTaskList.mockReset().mockResolvedValue({ kind: 'ok', list: listFixture('tl_1', 'List One', 'owner') })
  h_.unarchiveTaskList.mockReset().mockResolvedValue({ kind: 'ok', list: listFixture('tl_1', 'List One', 'owner') })
  h_.listTaskListItems.mockReset().mockResolvedValue({ kind: 'ok', items: [], total: 0 })
  h_.listTaskListEvents.mockReset().mockResolvedValue({ kind: 'ok', items: [], total: 0 })
  h_.listTaskListMembers.mockReset().mockResolvedValue({ kind: 'ok', items: [], total: 0 })
  h_.addTaskListMember.mockReset().mockResolvedValue({ kind: 'ok', id: 'tl_1', members: [] })
  h_.changeTaskListMemberRole.mockReset().mockResolvedValue({ kind: 'ok', id: 'tl_1', members: [] })
  h_.removeTaskListMember.mockReset().mockResolvedValue({ kind: 'ok', id: 'tl_1', members: [] })
  h_.transferTaskListOwner.mockReset().mockResolvedValue({ kind: 'ok', id: 'tl_1', members: [] })
  // FE-7: no custom groups and no placements — the board shows every row in its default group's
  // unsorted tail. The default group's name is server data; ASCII here like every other fixture.
  h_.listTaskListGroups.mockReset().mockResolvedValue({
    kind: 'ok',
    items: [{ id: 'tg_default', scope: 'list', name: 'Default', position: 0, isDefault: true }],
    total: 1,
  })
  h_.listTaskListGroupItems.mockReset().mockResolvedValue({ kind: 'ok', items: [], total: 0 })
  h_.listUserGroups.mockReset().mockResolvedValue({
    kind: 'ok',
    items: [{ id: null, scope: 'user', name: 'Default', position: 0, isDefault: true }],
    total: 1,
  })
  h_.listUserGroupItems.mockReset().mockResolvedValue({ kind: 'ok', items: [], total: 0 })
  h_.placeTaskInUserGroup.mockReset().mockResolvedValue({ kind: 'ok', taskId: 't1', groupId: 'tg_def', position: 0 })
  h_.createUserGroup.mockReset()
  h_.renameUserGroup.mockReset()
  h_.deleteUserGroup.mockReset()
  h_.placeTaskInListGroup.mockReset().mockResolvedValue({ kind: 'ok', taskId: 't1', groupId: 'tg_default', position: 0 })
  h_.createTaskListGroup.mockReset()
  h_.renameTaskListGroup.mockReset()
  h_.deleteTaskListGroup.mockReset()
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
  router = null
  setLocale('zh-CN')
})

// ---------------------------------------------------------------------------------------------
// Group 1 — key parity
// ---------------------------------------------------------------------------------------------

describe('labels — key parity between the ZH and EN tables', () => {
  it('TASKS_EN has exactly the keys of TASKS_ZH', () => {
    expect(Object.keys(TASKS_EN).sort()).toEqual(Object.keys(TASKS_ZH).sort())
  })

  it('TASKS_FMT_EN has exactly the keys of TASKS_FMT_ZH', () => {
    expect(Object.keys(TASKS_FMT_EN).sort()).toEqual(Object.keys(TASKS_FMT_ZH).sort())
  })

  it('every TASKS_CODE_KEYS value names a key of TASKS_ZH', () => {
    const missing = Object.entries(TASKS_CODE_KEYS).filter(([, key]) => !(key in TASKS_ZH))
    expect(missing).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// Group 2 — each value is in its own language
// ---------------------------------------------------------------------------------------------

// One fixed argument list per format function. The runtime check that this table covers every
// FMT key keeps a new function from slipping past the three checks below.
const FMT_ARGS: Record<keyof typeof TASKS_FMT_ZH, unknown[]> = {
  completedAt: ['2026-10-01 17:30'],
  badgeUnavailable: ['X'],
  badgeLoading: ['X'],
  badgeOff: ['X'],
  versionConflict: [7],
  descriptionCount: [12, 20000],
  listsRemoveFrom: ['List One'],
  listRemoveTaskNamed: ['Task One'],
  membersRoleFor: ['u2'],
  membersRemoveNamed: ['u2'],
  membersTransferNamed: ['u2'],
  membersTransferPrompt: ['u2'],
  groupsItemCount: [3],
  groupsMoveUpNamed: ['Task One'],
  groupsMoveDownNamed: ['Task One'],
  groupsAddToOrderNamed: ['Task One'],
  groupsMoveToNamed: ['Task One'],
  groupsMovedTo: [2],
  groupsMovedToGroup: ['Group A', 2],
  groupsRenameNamed: ['Group A'],
  groupsDeleteNamed: ['Group A'],
  groupsDeletePrompt: ['Group A'],
}

describe('labels — every value is in its own language', () => {
  it('every ZH string contains CJK', () => {
    const offenders = Object.entries(TASKS_ZH).filter(([, value]) => !CJK.test(value)).map(([key]) => key)
    expect(offenders).toEqual([])
  })

  it('no EN string contains CJK', () => {
    const offenders = Object.entries(TASKS_EN).filter(([, value]) => CJK.test(value)).map(([key]) => key)
    expect(offenders).toEqual([])
  })

  it('no string is empty in either table', () => {
    const empty = [
      ...Object.entries(TASKS_ZH).filter(([, v]) => v.length === 0).map(([k]) => `zh:${k}`),
      ...Object.entries(TASKS_EN).filter(([, v]) => v.length === 0).map(([k]) => `en:${k}`),
    ]
    expect(empty).toEqual([])
  })

  it('no key has identical ZH and EN copy', () => {
    const same = (Object.keys(TASKS_ZH) as Array<keyof typeof TASKS_ZH>).filter((key) => TASKS_ZH[key] === TASKS_EN[key])
    expect(same).toEqual([])
  })

  it('the fixed-argument table covers every format function', () => {
    expect(Object.keys(FMT_ARGS).sort()).toEqual(Object.keys(TASKS_FMT_ZH).sort())
  })

  it('format functions with fixed arguments: ZH contains CJK, EN does not, and they differ', () => {
    const offenders: string[] = []
    for (const key of Object.keys(FMT_ARGS) as Array<keyof typeof TASKS_FMT_ZH>) {
      const args = FMT_ARGS[key]
      const zh = (TASKS_FMT_ZH[key] as (...a: unknown[]) => string)(...args)
      const en = (TASKS_FMT_EN[key] as (...a: unknown[]) => string)(...args)
      if (!CJK.test(zh)) offenders.push(`${key}: zh has no CJK (${zh})`)
      if (CJK.test(en)) offenders.push(`${key}: en has CJK (${en})`)
      if (zh === en) offenders.push(`${key}: zh === en (${zh})`)
      if (!zh || !en) offenders.push(`${key}: empty output`)
    }
    expect(offenders).toEqual([])
  })

  it('format functions embed their argument in both languages', () => {
    expect(TASKS_FMT_ZH.completedAt('2026-10-01 17:30')).toContain('2026-10-01 17:30')
    expect(TASKS_FMT_EN.completedAt('2026-10-01 17:30')).toContain('2026-10-01 17:30')
    expect(TASKS_FMT_ZH.badgeUnavailable('X')).toMatch(/^X/)
    expect(TASKS_FMT_EN.badgeUnavailable('X')).toMatch(/^X/)
    expect(TASKS_FMT_ZH.badgeLoading('X')).toMatch(/^X/)
    expect(TASKS_FMT_EN.badgeLoading('X')).toMatch(/^X/)
    expect(TASKS_FMT_ZH.badgeOff('X')).toMatch(/^X/)
    expect(TASKS_FMT_EN.badgeOff('X')).toMatch(/^X/)
    expect(TASKS_FMT_ZH.versionConflict(7)).toContain('7')
    expect(TASKS_FMT_EN.versionConflict(7)).toContain('7')
  })
})

// ---------------------------------------------------------------------------------------------
// Group 5 — codeMessage
// ---------------------------------------------------------------------------------------------

describe('codeMessage', () => {
  it('every listed code resolves to non-empty copy that is not the fallback, in both languages', () => {
    const offenders: string[] = []
    for (const code of Object.keys(TASKS_CODE_KEYS)) {
      for (const [lang, t] of [['zh', TASKS_ZH], ['en', TASKS_EN]] as const) {
        const message = codeMessage(code, t)
        if (!message) offenders.push(`${lang}:${code} empty`)
        if (message === t.actionFailed) offenders.push(`${lang}:${code} is the fallback`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('an unlisted code resolves to the fallback of the given table', () => {
    for (const code of ['NOPE', '', 'VERSION_CONFLICT', 'constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(codeMessage(code, TASKS_ZH), code).toBe(TASKS_ZH.actionFailed)
      expect(codeMessage(code, TASKS_EN), code).toBe(TASKS_EN.actionFailed)
    }
  })

  it('the ten M3 codes and the fallback render their M3 Chinese copy byte-for-byte', () => {
    expect(
      Object.fromEntries(
        [
          'INVALID_PARENT', 'DEPTH_EXCEEDED', 'INVALID_ASSIGNEES', 'LIMIT', 'INVALID_MODE', 'COMMENT_BLANK',
          'COMMENT_TOO_LONG', 'COMMENT_INVALID_CHAR', 'HAS_CHILDREN', 'TASK_BUSY', 'UNKNOWN_CODE',
        ].map((code) => [code, codeMessage(code, TASKS_ZH)]),
      ),
    ).toEqual({
      INVALID_PARENT: '无效的父任务',
      DEPTH_EXCEEDED: '任务层级已达上限',
      INVALID_ASSIGNEES: '无效的用户',
      LIMIT: '人数已达上限',
      INVALID_MODE: '无效的完成模式',
      COMMENT_BLANK: '评论内容不能为空',
      COMMENT_TOO_LONG: '评论内容过长',
      COMMENT_INVALID_CHAR: '评论包含无法保存的字符',
      HAS_CHILDREN: '请先删除子任务',
      TASK_BUSY: '任务正在被修改，请稍后重试',
      UNKNOWN_CODE: '操作失败，请稍后重试',
    })
  })
})

// ---------------------------------------------------------------------------------------------
// tasksDateDisplay — the locale parameters (design §9.1)
// ---------------------------------------------------------------------------------------------

describe('tasksDateDisplay — locale parameters', () => {
  const allDay = { dueAt: null, dueDate: '2026-10-05', dueTime: '08:30:00', timeZone: 'Asia/Shanghai' }
  const timed = { dueAt: '2026-10-01T09:30:00Z', dueDate: null, dueTime: null, timeZone: null }
  const none = { dueAt: null, dueDate: null, dueTime: null, timeZone: null }

  it('with no locale arguments both formatters render the zh-CN forms (the M2 / M3 output)', () => {
    expect(formatViewerInstant('2026-10-01T09:30:00Z', 'Asia/Shanghai')).toBe('2026年10月1日 17:30')
    expect(formatDueDisplay(allDay)).toBe('2026-10-05 08:30（Asia/Shanghai）')
    expect(formatDueDisplay(none)).toBe('无截止日期')
  })

  it('with the EN table and en-US the all-day form uses ASCII brackets and the EN placeholder', () => {
    expect(formatDueDisplay(allDay, TASKS_EN, 'en-US')).toBe('2026-10-05 08:30 (Asia/Shanghai)')
    expect(formatDueDisplay({ ...allDay, dueTime: null }, TASKS_EN, 'en-US')).toBe('2026-10-05 (Asia/Shanghai)')
    expect(formatDueDisplay(none, TASKS_EN, 'en-US')).toBe('No due date')
  })

  it('with en-US the TIMED form and formatViewerInstant render through Intl in English', () => {
    const instant = formatViewerInstant('2026-10-01T09:30:00Z', 'Asia/Shanghai', 'en-US')
    expect(instant).not.toMatch(CJK)
    expect(instant).toContain('2026')
    expect(instant).toContain('17:30')
    expect(formatDueDisplay(timed, TASKS_EN, 'en-US')).not.toMatch(CJK)
    // The TIMED branch takes the locale from the `locale` argument, not from the table: the EN
    // table alone must not be enough to switch it.
    expect(formatDueDisplay(timed, TASKS_EN, 'en-US')).toBe(formatViewerInstant('2026-10-01T09:30:00Z', undefined, 'en-US'))
  })
})

// ---------------------------------------------------------------------------------------------
// Group 3 — EN locale: TasksView renders no CJK
// ---------------------------------------------------------------------------------------------

describe('EN locale — TasksView list page renders no CJK', () => {
  beforeEach(() => {
    setLocale('en')
  })

  it('rows with and without due_at, a done row, every view button, the create form', async () => {
    h_.listTasks.mockResolvedValue({
      kind: 'ok',
      items: [
        listItem({ id: 't1', due_at: '2026-10-01T09:00:00Z' }),
        listItem({ id: 't2', due_at: null }),
        listItem({ id: 't3', status: 'done' }),
      ],
    })
    const el = await mountViewAt('/tasks')

    expect(el.querySelector('h1')?.textContent).toBe('Tasks')
    expect(must(el, 'tasks-list-item-due').textContent).not.toMatch(CJK)
    expect(must(el, 'tasks-list-item-due').textContent).toContain('2026')
    expect(el.querySelectorAll('[data-testid="tasks-list-item"]').length).toBe(3)
    expect(must(el, 'tasks-view-switch-assigned').textContent).toBe('Assigned to me')
    expect(must(el, 'tasks-create-title').getAttribute('placeholder')).toBe('New task title')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('empty state', async () => {
    h_.listTasks.mockResolvedValue({ kind: 'ok', items: [] })
    const el = await mountViewAt('/tasks')
    expect(must(el, 'tasks-list-empty').textContent?.trim()).toBe('No tasks yet')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('error state', async () => {
    h_.listTasks.mockResolvedValue({ kind: 'error', status: 500 })
    const el = await mountViewAt('/tasks')
    expect(must(el, 'tasks-list-error').textContent?.trim()).toBe('Could not load tasks. Please try again later.')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('loading state', async () => {
    const pending = deferred<unknown>()
    h_.listTasks.mockReturnValue(pending.promise)
    const el = await mountViewAt('/tasks')
    expect(must(el, 'tasks-list-loading').textContent?.trim()).toBe('Loading…')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
    pending.resolve({ kind: 'ok', items: [] })
    await flush()
  })

  it('create errors — invalid title and the generic failure', async () => {
    h_.listTasks.mockResolvedValue({ kind: 'ok', items: [] })
    h_.createTask.mockResolvedValue({ kind: 'invalid_title' })
    const el = await mountViewAt('/tasks')

    typeInto(el, 'tasks-create-title', 'New one')
    await submitForm(el, 'tasks-create-form')
    expect(must(el, 'tasks-create-error').textContent?.trim()).toBe('The title is empty or contains characters that cannot be saved')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)

    h_.createTask.mockResolvedValue({ kind: 'error', status: 500 })
    await submitForm(el, 'tasks-create-form')
    expect(must(el, 'tasks-create-error').textContent?.trim()).toBe('Could not create the task. Please try again later.')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('create error — a contract code shows that code\'s copy (FE-8: 422 INACTIVE_ORG_MEMBER)', async () => {
    h_.listTasks.mockResolvedValue({ kind: 'ok', items: [] })
    h_.createTask.mockResolvedValue({ kind: 'validation', code: 'INACTIVE_ORG_MEMBER' })
    const el = await mountViewAt('/tasks')

    typeInto(el, 'tasks-create-title', 'New one')
    await submitForm(el, 'tasks-create-form')
    expect(must(el, 'tasks-create-error').textContent?.trim()).toBe('This user is not in the current organization or has been deactivated')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('action banner — forbidden and the generic failure', async () => {
    h_.completeTask.mockResolvedValue({ kind: 'forbidden' })
    const el = await mountViewAt('/tasks')

    await click(el, 'tasks-complete-button')
    expect(must(el, 'tasks-action-error').textContent?.trim()).toBe('You do not have permission to change this task')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)

    h_.completeTask.mockResolvedValue({ kind: 'error', status: 500 })
    await click(el, 'tasks-complete-button')
    expect(must(el, 'tasks-action-error').textContent?.trim()).toBe('The action failed. Please try again later.')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('context states — org_missing, unavailable, forbidden, error', async () => {
    for (const [state, testid] of [
      ['org_missing', 'tasks-view-org-missing'],
      ['unavailable', 'tasks-view-unavailable'],
      ['forbidden', 'tasks-view-forbidden'],
      ['error', 'tasks-view-error'],
    ] as const) {
      h_.loadTasksContext.mockResolvedValue({ state })
      const el = await mountViewAt('/tasks')
      expect(must(el, testid).textContent?.trim().length).toBeGreaterThan(0)
      expect(renderedTextAndAttributes(el), state).not.toMatch(CJK)
      app?.unmount()
      container?.remove()
      app = null
      container = null
    }
  })

  it('org guidance after a list read that reports org_missing', async () => {
    h_.listTasks.mockResolvedValue({ kind: 'org_missing' })
    const el = await mountViewAt('/tasks')
    expect(must(el, 'tasks-view-org-missing').textContent?.trim()).toBe('Select an organization to view tasks')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })
})

describe('EN locale — TasksView detail page renders no CJK', () => {
  beforeEach(() => {
    setLocale('en')
  })

  it('TIMED due date, completed and open assignees, parent, children, followers, comments with a tombstone and the truncation notice', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ dueAt: '2026-10-01T09:30:00Z' }) })
    h_.listComments.mockResolvedValue({
      kind: 'ok',
      items: [comment({ id: 'c1' }), comment({ id: 'c2', body: null, deleted: true })],
      total: 5,
    })
    const el = await mountViewAt('/tasks/t1')

    expect(el.querySelector('h1')?.textContent).toBe('Task details')
    expect(must(el, 'tasks-detail-due').textContent).not.toMatch(CJK)
    expect(must(el, 'tasks-detail-due').textContent).toContain('2026')
    const assigneeRows = el.querySelectorAll('[data-testid="tasks-detail-assignee-status"]')
    expect(assigneeRows[0].textContent).toMatch(/^Completed at /)
    expect(assigneeRows[0].textContent).toContain('2026')
    expect(assigneeRows[1].textContent).toBe('Not completed')
    expect(must(el, 'tasks-detail-completion-mode').textContent?.trim()).toBe('All assignees complete')
    expect(must(el, 'tasks-detail-status').textContent?.trim()).toBe('In progress')
    expect(must(el, 'tasks-detail-parent')).toBeTruthy()
    expect(must(el, 'tasks-detail-child').textContent).toContain('Completed')
    expect(must(el, 'tasks-detail-follower')).toBeTruthy()
    expect(must(el, 'tasks-detail-comments-truncated')).toBeTruthy()
    const bodies = el.querySelectorAll('[data-testid="tasks-detail-comment-body"]')
    expect(bodies[1].textContent).toBe('Deleted')
    expect(must(el, 'tasks-detail-leave')).toBeTruthy()
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('the depth row: a space after the label, as after every other label', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail() })
    const el = await mountViewAt('/tasks/t1')
    expect(must(el, 'tasks-detail-depth').textContent).toBe('Depth: 1')
  })

  it('ALL-DAY due date with a time zone, and a task with no due date', async () => {
    h_.getTask.mockResolvedValue({
      kind: 'ok',
      task: taskDetail({ dueDate: '2026-10-05', dueTime: '08:30:00', timeZone: 'Asia/Shanghai' }),
    })
    let el = await mountViewAt('/tasks/t1')
    expect(must(el, 'tasks-detail-due').textContent?.trim()).toBe('2026-10-05 08:30 (Asia/Shanghai)')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
    app?.unmount()
    container?.remove()
    app = null
    container = null

    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail() })
    el = await mountViewAt('/tasks/t1')
    expect(must(el, 'tasks-detail-due').textContent?.trim()).toBe('No due date')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('done status with reopen, followers unknown, no children, comment editing controls, delete confirm block', async () => {
    h_.getTask.mockResolvedValue({
      kind: 'ok',
      task: taskDetail({ status: 'done', parentId: null, depth: 0, children: [], followers: undefined, canLeave: undefined }),
    })
    h_.listComments.mockResolvedValue({ kind: 'ok', items: [comment({ id: 'c1', authorId: 'u1' })], total: 1 })
    const el = await mountViewAt('/tasks/t1')

    expect(must(el, 'tasks-detail-status').textContent?.trim()).toBe('Completed')
    expect(must(el, 'tasks-detail-reopen-button').textContent).toBe('Reopen')
    expect(must(el, 'tasks-detail-followers-unknown')).toBeTruthy()
    expect(must(el, 'tasks-detail-children-empty').textContent).toBe('No subtasks yet')

    await click(el, 'tasks-detail-comment-edit')
    expect(must(el, 'tasks-detail-comment-edit-save').textContent).toBe('Save')
    expect(must(el, 'tasks-detail-comment-edit-cancel').textContent).toBe('Cancel')

    await click(el, 'tasks-detail-delete')
    expect(must(el, 'tasks-detail-delete-confirm').textContent).toContain('Delete this task? This cannot be undone.')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('inline errors from every section, the precheck, and the action banner', async () => {
    h_.setParent.mockResolvedValue({ kind: 'validation', code: 'INVALID_PARENT' })
    h_.addAssignee.mockResolvedValue({ kind: 'validation', code: 'LIMIT' })
    h_.addFollower.mockResolvedValue({ kind: 'validation', code: 'INVALID_ASSIGNEES' })
    h_.deleteTask.mockResolvedValue({ kind: 'conflict', code: 'HAS_CHILDREN' })
    h_.completeTask.mockResolvedValue({ kind: 'forbidden' })
    h_.listComments.mockResolvedValue({ kind: 'ok', items: [comment({ id: 'c1', authorId: 'u1' })], total: 1 })
    const el = await mountViewAt('/tasks/t1')

    typeInto(el, 'tasks-detail-set-parent-input', 'p2')
    await submitForm(el, 'tasks-detail-set-parent-form')
    expect(must(el, 'tasks-detail-parent-error').textContent?.trim()).toBe('Invalid parent task')

    typeInto(el, 'tasks-detail-add-assignee-input', 'u4')
    await submitForm(el, 'tasks-detail-add-assignee-form')
    expect(must(el, 'tasks-detail-membership-error').textContent?.trim()).toBe('The people limit has been reached')

    typeInto(el, 'tasks-detail-add-follower-input', 'u5')
    await submitForm(el, 'tasks-detail-add-follower-form')
    expect(must(el, 'tasks-detail-follower-error').textContent?.trim()).toBe('Invalid user')

    // The comment precheck is the REAL `checkCommentBody`: a blank body reaches the inline error
    // through the same code -> copy mapping as a server-reported code.
    typeInto(el, 'tasks-detail-comment-input', '   ')
    await submitForm(el, 'tasks-detail-comment-form')
    expect(must(el, 'tasks-detail-comment-error').textContent?.trim()).toBe('The comment cannot be empty')

    await click(el, 'tasks-detail-comment-edit')
    typeInto(el, 'tasks-detail-comment-edit-input', '')
    await click(el, 'tasks-detail-comment-edit-save')
    expect(must(el, 'tasks-detail-comment-edit-error').textContent?.trim()).toBe('The comment cannot be empty')

    await click(el, 'tasks-detail-delete')
    await click(el, 'tasks-detail-delete-confirm-yes')
    expect(must(el, 'tasks-detail-delete-error').textContent?.trim()).toBe('Delete the subtasks first')

    await click(el, 'tasks-detail-complete-button')
    expect(must(el, 'tasks-action-error').textContent?.trim()).toBe('You do not have permission to change this task')

    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('FE-8: 422 INACTIVE_ORG_MEMBER next to the assignee form and next to the follower form', async () => {
    h_.addAssignee.mockResolvedValue({ kind: 'validation', code: 'INACTIVE_ORG_MEMBER' })
    h_.addFollower.mockResolvedValue({ kind: 'validation', code: 'INACTIVE_ORG_MEMBER' })
    const el = await mountViewAt('/tasks/t1')

    typeInto(el, 'tasks-detail-add-assignee-input', 'u9')
    await submitForm(el, 'tasks-detail-add-assignee-form')
    expect(must(el, 'tasks-detail-membership-error').textContent?.trim()).toBe('This user is not in the current organization or has been deactivated')

    typeInto(el, 'tasks-detail-add-follower-input', 'u9')
    await submitForm(el, 'tasks-detail-add-follower-form')
    expect(must(el, 'tasks-detail-follower-error').textContent?.trim()).toBe('This user is not in the current organization or has been deactivated')

    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('not_found, forbidden, error and loading states; comments loading and error', async () => {
    for (const [result, testid] of [
      [{ kind: 'not_found' }, 'tasks-detail-not-found'],
      [{ kind: 'forbidden' }, 'tasks-detail-forbidden'],
      [{ kind: 'error', status: 500 }, 'tasks-detail-error'],
    ] as const) {
      h_.getTask.mockResolvedValue(result)
      const el = await mountViewAt('/tasks/t1')
      expect(must(el, testid).textContent?.trim().length).toBeGreaterThan(0)
      expect(renderedTextAndAttributes(el), testid).not.toMatch(CJK)
      app?.unmount()
      container?.remove()
      app = null
      container = null
    }

    const pendingTask = deferred<unknown>()
    const pendingComments = deferred<unknown>()
    h_.getTask.mockReturnValue(pendingTask.promise)
    h_.listComments.mockReturnValue(pendingComments.promise)
    const el = await mountViewAt('/tasks/t1')
    expect(must(el, 'tasks-detail-loading').textContent?.trim()).toBe('Loading…')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)

    pendingTask.resolve({ kind: 'ok', task: taskDetail() })
    await flush()
    expect(must(el, 'tasks-detail-comments-loading').textContent?.trim()).toBe('Loading…')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)

    pendingComments.resolve({ kind: 'error' })
    await flush()
    expect(must(el, 'tasks-detail-comments-error').textContent?.trim()).toBe('Could not load comments. Please try again later.')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })
})

// ---------------------------------------------------------------------------------------------
// Group 3 (positive control) — ZH locale: the same surfaces render CJK
// ---------------------------------------------------------------------------------------------

describe('ZH locale — the same surfaces render CJK (positive control)', () => {
  it('list page', async () => {
    h_.listTasks.mockResolvedValue({ kind: 'ok', items: [listItem({ due_at: '2026-10-01T09:00:00Z' })] })
    const el = await mountViewAt('/tasks')
    expect(el.querySelector('h1')?.textContent).toBe('任务')
    expect(must(el, 'tasks-view-switch-assigned').textContent).toBe('分配给我')
    expect(renderedTextAndAttributes(el)).toMatch(CJK)
  })

  it('detail page', async () => {
    h_.getTask.mockResolvedValue({
      kind: 'ok',
      task: taskDetail({ dueDate: '2026-10-05', dueTime: '08:30:00', timeZone: 'Asia/Shanghai' }),
    })
    const el = await mountViewAt('/tasks/t1')
    expect(el.querySelector('h1')?.textContent).toBe('任务详情')
    expect(must(el, 'tasks-detail-due').textContent?.trim()).toBe('2026-10-05 08:30（Asia/Shanghai）')
    expect(renderedTextAndAttributes(el)).toMatch(CJK)
  })
})

// ---------------------------------------------------------------------------------------------
// TasksTodoBadge — three states, both languages, and the flip
// ---------------------------------------------------------------------------------------------

describe('TasksTodoBadge', () => {
  it('EN: ready, loading and unavailable render no CJK in text, aria-label or title', async () => {
    setLocale('en')

    let badge = await mountBadge('Tasks')
    expect(badge.getAttribute('data-state')).toBe('ready')
    expect(badge.getAttribute('aria-label')).toBe('Tasks3')
    expect(renderedTextAndAttributes(container as HTMLElement)).not.toMatch(CJK)
    app?.unmount()
    container?.remove()

    const pending = deferred<unknown>()
    h_.fetchPendingCount.mockReturnValue(pending.promise)
    badge = await mountBadge('Tasks')
    expect(badge.getAttribute('data-state')).toBe('loading')
    expect(badge.getAttribute('aria-label')).toBe('Tasks loading')
    expect(badge.getAttribute('title')).toBe('Tasks loading')
    expect(renderedTextAndAttributes(container as HTMLElement)).not.toMatch(CJK)
    pending.resolve({ kind: 'error', status: 0 })
    await flush()
    app?.unmount()
    container?.remove()

    h_.fetchPendingCount.mockResolvedValue({ kind: 'error', status: 0 })
    badge = await mountBadge('Tasks')
    expect(badge.getAttribute('data-state')).toBe('unavailable')
    expect(badge.getAttribute('aria-label')).toBe('Tasks (data unavailable)')
    expect(renderedTextAndAttributes(container as HTMLElement)).not.toMatch(CJK)
  })

  // FE-2 (design §8.1): the switched-off scope is a 'ready' answer with its own aria-label.
  it('EN: switched off renders no CJK in text, aria-label or title', async () => {
    setLocale('en')
    h_.fetchPendingCount.mockResolvedValue({ kind: 'ok', count: 0, badgeScope: 'off' })
    const badge = await mountBadge('Tasks')
    expect(badge.getAttribute('data-state')).toBe('ready')
    expect(badge.getAttribute('data-scope')).toBe('off')
    expect(badge.getAttribute('aria-label')).toBe('Tasks badge off')
    expect(badge.getAttribute('title')).toBe('Tasks badge off')
    expect(renderedTextAndAttributes(container as HTMLElement)).not.toMatch(CJK)
  })

  it('ZH: switched off renders the §8.1 form byte-for-byte for the nav label', async () => {
    h_.fetchPendingCount.mockResolvedValue({ kind: 'ok', count: 0, badgeScope: 'off' })
    const badge = await mountBadge('待办任务')
    expect(badge.getAttribute('aria-label')).toBe('待办任务红点已关闭')
    expect(badge.getAttribute('title')).toBe('待办任务红点已关闭')
    expect(renderedTextAndAttributes(container as HTMLElement)).toMatch(CJK)
  })

  it('flips the switched-off aria-label after mount when the locale changes', async () => {
    h_.fetchPendingCount.mockResolvedValue({ kind: 'ok', count: 0, badgeScope: 'off' })
    const badge = await mountBadge('X')
    expect(badge.getAttribute('aria-label')).toBe('X红点已关闭')

    setLocale('en')
    await flush()
    expect(badge.getAttribute('aria-label')).toBe('X badge off')

    setLocale('zh-CN')
    await flush()
    expect(badge.getAttribute('aria-label')).toBe('X红点已关闭')
  })

  it('ZH: loading and unavailable render the M2 forms byte-for-byte', async () => {
    const pending = deferred<unknown>()
    h_.fetchPendingCount.mockReturnValue(pending.promise)
    let badge = await mountBadge('X')
    expect(badge.getAttribute('aria-label')).toBe('X加载中')
    pending.resolve({ kind: 'error', status: 0 })
    await flush()
    app?.unmount()
    container?.remove()

    h_.fetchPendingCount.mockResolvedValue({ kind: 'error', status: 0 })
    badge = await mountBadge('X')
    expect(badge.getAttribute('aria-label')).toBe('X(数据不可用)')
    expect(badge.getAttribute('title')).toBe('X(数据不可用)')
  })

  it('flips its aria-label after mount when the locale changes', async () => {
    h_.fetchPendingCount.mockResolvedValue({ kind: 'error', status: 0 })
    const badge = await mountBadge('X')
    expect(badge.getAttribute('aria-label')).toBe('X(数据不可用)')

    setLocale('en')
    await flush()
    expect(badge.getAttribute('aria-label')).toBe('X (data unavailable)')
    expect(badge.getAttribute('title')).toBe('X (data unavailable)')

    setLocale('zh-CN')
    await flush()
    expect(badge.getAttribute('aria-label')).toBe('X(数据不可用)')
  })
})

// ---------------------------------------------------------------------------------------------
// Group 4 — a locale flip after mount re-renders TasksView
// ---------------------------------------------------------------------------------------------

describe('locale flip after mount — TasksView', () => {
  it('detail: chrome, the due display, and a stored inline error code all re-render', async () => {
    h_.setParent.mockResolvedValue({ kind: 'validation', code: 'INVALID_PARENT' })
    const el = await mountViewAt('/tasks/t1')
    typeInto(el, 'tasks-detail-set-parent-input', 'p2')
    await submitForm(el, 'tasks-detail-set-parent-form')

    expect(el.querySelector('h1')?.textContent).toBe('任务详情')
    expect(must(el, 'tasks-detail-back-link').textContent).toContain('返回任务列表')
    expect(must(el, 'tasks-detail-due').textContent?.trim()).toBe('无截止日期')
    expect(must(el, 'tasks-detail-parent-error').textContent?.trim()).toBe('无效的父任务')
    expect(must(el, 'tasks-detail-set-parent-input').getAttribute('placeholder')).toBe('设为子任务（填写父任务ID）')

    setLocale('en')
    await flush()
    expect(el.querySelector('h1')?.textContent).toBe('Task details')
    expect(must(el, 'tasks-detail-back-link').textContent).toContain('Back to task list')
    expect(must(el, 'tasks-detail-due').textContent?.trim()).toBe('No due date')
    expect(must(el, 'tasks-detail-parent-error').textContent?.trim()).toBe('Invalid parent task')
    expect(must(el, 'tasks-detail-set-parent-input').getAttribute('placeholder')).toBe('Make this a subtask (parent task ID)')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)

    setLocale('zh-CN')
    await flush()
    expect(el.querySelector('h1')?.textContent).toBe('任务详情')
    expect(must(el, 'tasks-detail-parent-error').textContent?.trim()).toBe('无效的父任务')
  })

  it('detail: the viewer-local instants follow the locale too', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: taskDetail({ dueAt: '2026-10-01T09:30:00Z' }) })
    const el = await mountViewAt('/tasks/t1')
    expect(must(el, 'tasks-detail-due').textContent?.trim()).toBe(formatViewerInstant('2026-10-01T09:30:00Z'))
    expect(must(el, 'tasks-detail-due').textContent).toMatch(CJK)

    setLocale('en')
    await flush()
    expect(must(el, 'tasks-detail-due').textContent?.trim()).toBe(formatViewerInstant('2026-10-01T09:30:00Z', undefined, 'en-US'))
    expect(must(el, 'tasks-detail-due').textContent).not.toMatch(CJK)
    const completed = el.querySelector('[data-testid="tasks-detail-assignee-status"]')
    expect(completed?.textContent).toBe(`Completed at ${formatViewerInstant('2026-09-20T10:00:00Z', undefined, 'en-US')}`)
  })

  it('list: the view buttons, the empty state and the action banner re-render', async () => {
    h_.listTasks.mockResolvedValue({ kind: 'ok', items: [] })
    const el = await mountViewAt('/tasks')
    expect(must(el, 'tasks-list-empty').textContent?.trim()).toBe('暂无任务')
    expect(must(el, 'tasks-view-switch-following').textContent).toBe('关注中')
    expect(must(el, 'tasks-create-submit').textContent).toBe('创建')

    setLocale('en')
    await flush()
    expect(must(el, 'tasks-list-empty').textContent?.trim()).toBe('No tasks yet')
    expect(must(el, 'tasks-view-switch-following').textContent).toBe('Following')
    expect(must(el, 'tasks-create-submit').textContent).toBe('Create')
    expect(must(el, 'tasks-create-title').getAttribute('placeholder')).toBe('New task title')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })
})

// ---------------------------------------------------------------------------------------------
// FE-3 — TasksSettingsView and the settings entry on the list header (design §2.2, §4.5, §7.1)
// ---------------------------------------------------------------------------------------------

async function pickSettingsBadgeScope(el: HTMLElement, value: string): Promise<void> {
  ;(must(el, `tasks-settings-badge-scope-${value}`) as HTMLInputElement).click()
  await flush()
}

describe('EN locale — TasksSettingsView renders no CJK', () => {
  beforeEach(() => {
    setLocale('en')
  })

  it('the form with an empty zone (the browser-zone suggestion shows)', async () => {
    const el = await mountSettingsPage()
    expect(el.querySelector('h1')?.textContent).toBe('Task settings')
    expect(must(el, 'tasks-settings-badge-scope').querySelector('legend')?.textContent?.trim()).toBe('Badge count scope')
    expect(must(el, 'tasks-settings-use-browser-zone').textContent?.trim()).toBe('Use browser time zone')
    expect(must(el, 'tasks-settings-time-zone').getAttribute('placeholder')).toBe('IANA time zone name, for example Asia/Shanghai')
    expect(must(el, 'tasks-settings-back-link').textContent).toContain('Back to task list')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('the time-zone notice, every inline error, the banner and "saved"', async () => {
    const el = await mountSettingsPage()

    ;(must(el, 'tasks-settings-daily-reminder') as HTMLInputElement).click()
    await flush()
    expect(must(el, 'tasks-settings-time-zone-autofilled').textContent?.trim()).toBe('Filled in from your browser time zone; you can change it')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)

    typeInto(el, 'tasks-settings-time-zone', '')
    await flush()
    await submitForm(el, 'tasks-settings-form')
    expect(must(el, 'tasks-settings-time-zone-error').textContent?.trim()).toBe('Set a time zone before turning on the daily reminder')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)

    typeInto(el, 'tasks-settings-time-zone', 'Pacific/Chatham')
    await flush()
    for (const [code, testid] of [
      ['INVALID_SETTINGS', 'tasks-settings-save-error'],
      ['INVALID_BADGE_SCOPE', 'tasks-settings-badge-scope-error'],
      ['INVALID_DAILY_REMINDER_ENABLED', 'tasks-settings-daily-reminder-error'],
      ['INVALID_POLICY', 'tasks-settings-remind-policy-error'],
      ['INVALID_TIME_ZONE', 'tasks-settings-time-zone-error'],
      ['DAILY_REMINDER_REQUIRES_TIME_ZONE', 'tasks-settings-time-zone-error'],
      ['SOMETHING_NEW', 'tasks-settings-save-error'],
    ] as const) {
      h_.patchTaskSettings.mockResolvedValue({ kind: 'validation', code })
      await submitForm(el, 'tasks-settings-form')
      expect(must(el, testid).textContent?.trim().length, code).toBeGreaterThan(0)
      expect(renderedTextAndAttributes(el), code).not.toMatch(CJK)
    }

    for (const kind of ['forbidden', 'not_found', 'error'] as const) {
      h_.patchTaskSettings.mockResolvedValue(kind === 'error' ? { kind, status: 500 } : { kind })
      await submitForm(el, 'tasks-settings-form')
      expect(must(el, 'tasks-settings-save-banner').textContent?.trim().length, kind).toBeGreaterThan(0)
      expect(renderedTextAndAttributes(el), kind).not.toMatch(CJK)
    }

    h_.patchTaskSettings.mockResolvedValue({ kind: 'ok', settings: settingsFixture({ dailyReminderEnabled: true, timeZone: 'Pacific/Chatham' }) })
    await submitForm(el, 'tasks-settings-form')
    expect(must(el, 'tasks-settings-saved').textContent?.trim()).toBe('Saved')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('org guidance after a save that reports org_missing', async () => {
    h_.patchTaskSettings.mockResolvedValue({ kind: 'org_missing' })
    const el = await mountSettingsPage()
    await pickSettingsBadgeScope(el, 'off')
    await submitForm(el, 'tasks-settings-form')
    expect(must(el, 'tasks-view-org-missing').textContent?.trim()).toBe('Select an organization to view tasks')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('read states — loading, not_found, forbidden, error', async () => {
    const pending = deferred<unknown>()
    h_.getTaskSettings.mockReturnValue(pending.promise)
    let el = await mountSettingsPage()
    expect(must(el, 'tasks-settings-loading').textContent?.trim()).toBe('Loading…')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
    pending.resolve({ kind: 'error', status: 0 })
    await flush()
    app?.unmount()
    container?.remove()

    for (const [result, testid] of [
      [{ kind: 'not_found' }, 'tasks-settings-not-found'],
      [{ kind: 'forbidden' }, 'tasks-settings-forbidden'],
      [{ kind: 'error', status: 500 }, 'tasks-settings-error'],
    ] as const) {
      h_.getTaskSettings.mockResolvedValue(result)
      el = await mountSettingsPage()
      expect(must(el, testid).textContent?.trim().length).toBeGreaterThan(0)
      expect(renderedTextAndAttributes(el), testid).not.toMatch(CJK)
      app?.unmount()
      container?.remove()
      app = null
      container = null
    }
  })

  it('context states — org_missing, unavailable, forbidden, error', async () => {
    for (const [state, testid] of [
      ['org_missing', 'tasks-view-org-missing'],
      ['unavailable', 'tasks-view-unavailable'],
      ['forbidden', 'tasks-view-forbidden'],
      ['error', 'tasks-view-error'],
    ] as const) {
      h_.loadTasksContext.mockResolvedValue({ state })
      const el = await mountSettingsPage()
      expect(must(el, testid).textContent?.trim().length).toBeGreaterThan(0)
      expect(renderedTextAndAttributes(el), state).not.toMatch(CJK)
      app?.unmount()
      container?.remove()
      app = null
      container = null
    }
  })

  it('the list header entry reads "Settings"', async () => {
    const el = await mountViewAt('/tasks')
    expect(must(el, 'tasks-settings-link').textContent?.trim()).toBe('Settings')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })
})

describe('ZH locale — TasksSettingsView renders CJK (positive control)', () => {
  it('the form and the list header entry', async () => {
    const el = await mountSettingsPage()
    expect(el.querySelector('h1')?.textContent).toBe('任务设置')
    expect(must(el, 'tasks-settings-badge-scope').querySelector('legend')?.textContent?.trim()).toBe('红点统计范围')
    expect(renderedTextAndAttributes(el)).toMatch(CJK)
    app?.unmount()
    container?.remove()

    const list = await mountViewAt('/tasks')
    expect(must(list, 'tasks-settings-link').textContent?.trim()).toBe('设置')
  })
})

describe('locale flip after mount — TasksSettingsView', () => {
  it('the chrome, an inline error, the banner and "saved" all re-render', async () => {
    h_.patchTaskSettings.mockResolvedValue({ kind: 'validation', code: 'INVALID_POLICY' })
    const el = await mountSettingsPage()
    await pickSettingsBadgeScope(el, 'off')
    await submitForm(el, 'tasks-settings-form')
    expect(el.querySelector('h1')?.textContent).toBe('任务设置')
    expect(must(el, 'tasks-settings-remind-policy-error').textContent?.trim()).toBe('无效的提醒策略')
    expect(must(el, 'tasks-settings-save').textContent).toBe('保存')

    setLocale('en')
    await flush()
    expect(el.querySelector('h1')?.textContent).toBe('Task settings')
    expect(must(el, 'tasks-settings-remind-policy-error').textContent?.trim()).toBe('Invalid reminder policy')
    expect(must(el, 'tasks-settings-save').textContent).toBe('Save')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)

    setLocale('zh-CN')
    h_.patchTaskSettings.mockResolvedValue({ kind: 'forbidden' })
    await submitForm(el, 'tasks-settings-form')
    expect(must(el, 'tasks-settings-save-banner').textContent?.trim()).toBe('您没有权限修改任务设置')
    setLocale('en')
    await flush()
    expect(must(el, 'tasks-settings-save-banner').textContent?.trim()).toBe('You do not have permission to change task settings')

    setLocale('zh-CN')
    h_.patchTaskSettings.mockResolvedValue({ kind: 'ok', settings: settingsFixture({ badgeScope: 'off' }) })
    await submitForm(el, 'tasks-settings-form')
    expect(must(el, 'tasks-settings-saved').textContent?.trim()).toBe('已保存')
    setLocale('en')
    await flush()
    expect(must(el, 'tasks-settings-saved').textContent?.trim()).toBe('Saved')
  })

  it('the list header entry re-renders', async () => {
    const el = await mountViewAt('/tasks')
    expect(must(el, 'tasks-settings-link').textContent?.trim()).toBe('设置')
    setLocale('en')
    await flush()
    expect(must(el, 'tasks-settings-link').textContent?.trim()).toBe('Settings')
  })
})

// ---------------------------------------------------------------------------------------------
// FE-4 — the detail page's editor and lists section, both languages and the flip
// ---------------------------------------------------------------------------------------------

/** A detail carrying the S4 group, `version` and `listIds`: the editor, the read-only rows and the
 *  lists section all render. ASCII-only, like every fixture here. */
function editableDetail(over: Record<string, unknown> = {}) {
  return taskDetail({
    dueDate: '2026-10-05',
    dueTime: '08:30:00',
    timeZone: 'Asia/Shanghai',
    version: 3,
    description: 'Notes',
    startDate: '2026-10-01',
    startTime: '09:00:00',
    remindAt: '2026-10-05T00:00:00Z',
    listIds: ['tl_a', 'tl_x'],
    ...over,
  })
}

function listFixture(id: string, name: string, myRole: 'read' | 'edit' | 'owner') {
  return {
    id,
    name,
    createdBy: 'u1',
    ownerId: 'u1',
    archivedAt: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    myRole,
  }
}

const FE4_LISTS = [listFixture('tl_a', 'Alpha', 'owner'), listFixture('tl_b', 'Beta', 'edit')]

function changeInto(el: HTMLElement, testid: string, value: string): void {
  const input = must(el, testid) as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('change'))
}

async function pickList(el: HTMLElement, listId: string): Promise<void> {
  changeInto(el, 'tasks-detail-lists-add-select', listId)
  await flush()
}

describe('EN locale — the detail editor and lists section render no CJK', () => {
  beforeEach(() => {
    setLocale('en')
    h_.listAllTaskLists.mockResolvedValue({ kind: 'ok', items: FE4_LISTS, total: FE4_LISTS.length })
  })

  it('the editor, the read-only rows, the lists with a not-a-member id, the picker, the reminder note and a remove confirmation', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: editableDetail() })
    const el = await mountViewAt('/tasks/t1')
    must(el, 'tasks-detail-editor')
    expect(must(el, 'tasks-detail-start').textContent?.trim()).toBe('Start: 2026-10-01 09:00 (Asia/Shanghai)')
    expect(must(el, 'tasks-detail-description').textContent).toBe('Description: Notes')
    expect(must(el, 'tasks-detail-remind').textContent?.trim()).toMatch(/^Reminder: .*2026/)
    expect(must(el, 'tasks-detail-editor-description-count').textContent?.trim()).toBe('5 / 20000 characters')
    expect(must(el, 'tasks-detail-lists-not-member').textContent).toBe(' (you are not a member)')
    must(el, 'tasks-detail-lists-add-form')
    changeInto(el, 'tasks-detail-editor-due-date', '2026-10-06')
    await flush()
    must(el, 'tasks-detail-editor-remind-hint')
    must(el, 'tasks-detail-editor-discard')
    await click(el, 'tasks-detail-lists-remove')
    must(el, 'tasks-detail-lists-remove-confirm')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('the empty values: no start date, description or reminder, a task in no list, nothing to offer', async () => {
    h_.listAllTaskLists.mockResolvedValue({ kind: 'ok', items: [listFixture('tl_r', 'Read only', 'read')], total: 1 })
    h_.getTask.mockResolvedValue({
      kind: 'ok',
      task: editableDetail({ dueDate: null, dueTime: null, timeZone: null, description: null, startDate: null, startTime: null, remindAt: null, listIds: [] }),
    })
    const el = await mountViewAt('/tasks/t1')
    expect(must(el, 'tasks-detail-start').textContent?.trim()).toBe('Start: No start date')
    expect(must(el, 'tasks-detail-description').textContent).toBe('Description: No description')
    expect(must(el, 'tasks-detail-remind').textContent?.trim()).toBe('Reminder: No reminder')
    expect(must(el, 'tasks-detail-lists-empty').textContent?.trim()).toBe('Not in any list yet')
    expect(must(el, 'tasks-detail-lists-no-candidates').textContent?.trim()).toBe('No list to add this task to')
    await click(el, 'tasks-detail-editor-remind-at')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('the conflict notice with a version and without one, and the server-updated notice', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: editableDetail() })
    h_.patchTask.mockResolvedValueOnce({ kind: 'conflict', code: 'VERSION_CONFLICT', currentVersion: 4 })
    const el = await mountViewAt('/tasks/t1')
    typeInto(el, 'tasks-detail-editor-title', 'Mine')
    await flush()
    await click(el, 'tasks-detail-editor-submit')
    expect(must(el, 'tasks-detail-editor-conflict').textContent?.trim()).toBe(TASKS_FMT_EN.versionConflict(4))
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)

    h_.patchTask.mockResolvedValueOnce({ kind: 'conflict', code: 'VERSION_CONFLICT' })
    await click(el, 'tasks-detail-editor-submit')
    expect(must(el, 'tasks-detail-editor-conflict').textContent?.trim()).toBe(TASKS_EN.versionConflictUnknown)
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)

    await click(el, 'tasks-detail-editor-discard')
    typeInto(el, 'tasks-detail-editor-title', 'Mine')
    await flush()
    typeInto(el, 'tasks-detail-add-assignee-input', 'u4')
    await submitForm(el, 'tasks-detail-add-assignee-form')
    expect(must(el, 'tasks-detail-editor-server-updated').textContent?.trim()).toBe(
      'The task was updated on the server; your unsaved changes are kept',
    )
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('every editor inline error, the INVALID_VERSION banner and the lists section errors', async () => {
    h_.getTask.mockResolvedValue({ kind: 'ok', task: editableDetail() })
    const el = await mountViewAt('/tasks/t1')
    typeInto(el, 'tasks-detail-editor-title', '   ')
    await flush()
    await click(el, 'tasks-detail-editor-submit')
    expect(must(el, 'tasks-detail-editor-title-error').textContent?.trim()).toBe('The title cannot be empty')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)

    typeInto(el, 'tasks-detail-editor-title', 'Mine')
    await flush()
    for (const [code, testid] of [
      ['INVALID_TITLE', 'tasks-detail-editor-title-error'],
      ['INVALID_DESCRIPTION', 'tasks-detail-editor-description-error'],
      ['INVALID_DATE', 'tasks-detail-editor-due-date-error'],
      ['INVALID_TIME_ZONE', 'tasks-detail-editor-time-zone-error'],
      ['TIME_ZONE_REQUIRED', 'tasks-detail-editor-time-zone-error'],
      ['INVALID_REMIND_AT', 'tasks-detail-editor-remind-at-error'],
      ['NOT_IN_THE_CONTRACT', 'tasks-detail-editor-error'],
    ] as const) {
      h_.patchTask.mockResolvedValueOnce({ kind: 'validation', code })
      await click(el, 'tasks-detail-editor-submit')
      expect(must(el, testid).textContent?.trim().length, code).toBeGreaterThan(0)
      expect(renderedTextAndAttributes(el), code).not.toMatch(CJK)
    }

    h_.patchTask.mockResolvedValueOnce({ kind: 'validation', code: 'INVALID_VERSION' })
    await click(el, 'tasks-detail-editor-submit')
    expect(must(el, 'tasks-action-error').textContent?.trim()).toBe('Version information is missing. Please refresh the page.')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)

    for (const [result, copy] of [
      [{ kind: 'not_found' }, "Cannot add: you need to be this task's creator or an assignee"],
      [{ kind: 'validation', code: 'LIMIT' }, 'A task can belong to at most 10 lists'],
      [{ kind: 'validation', code: 'INVALID_TASK' }, 'Invalid task'],
    ] as const) {
      h_.addTaskToList.mockResolvedValueOnce(result)
      await pickList(el, 'tl_b')
      await click(el, 'tasks-detail-lists-add-submit')
      expect(must(el, 'tasks-detail-lists-error').textContent?.trim()).toBe(copy)
      expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
    }
  })

  it('the lists section while my lists load, and when they cannot be read', async () => {
    const pendingLists = deferred<unknown>()
    h_.listAllTaskLists.mockReturnValue(pendingLists.promise)
    h_.getTask.mockResolvedValue({ kind: 'ok', task: editableDetail() })
    const el = await mountViewAt('/tasks/t1')
    expect(must(el, 'tasks-detail-lists-mine-loading').textContent?.trim()).toBe('Loading…')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
    pendingLists.resolve({ kind: 'error', status: 500 })
    await flush()
    expect(must(el, 'tasks-detail-lists-mine-unavailable').textContent?.trim()).toBe('Your lists could not be loaded; lists are shown by ID')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })
})

describe('ZH locale — the detail editor and lists section render CJK (positive control)', () => {
  it('the editor, the read-only rows and the lists section', async () => {
    h_.listAllTaskLists.mockResolvedValue({ kind: 'ok', items: FE4_LISTS, total: FE4_LISTS.length })
    h_.getTask.mockResolvedValue({ kind: 'ok', task: editableDetail() })
    const el = await mountViewAt('/tasks/t1')
    expect(must(el, 'tasks-detail-editor').querySelector('h3')?.textContent).toBe('编辑任务')
    expect(must(el, 'tasks-detail-start').textContent?.trim()).toBe('开始：2026-10-01 09:00（Asia/Shanghai）')
    expect(must(el, 'tasks-detail-editor-description-count').textContent?.trim()).toBe('5 / 20000 字')
    expect(must(el, 'tasks-detail-lists').querySelector('h3')?.textContent).toBe('所属清单')
    expect(must(el, 'tasks-detail-lists-not-member').textContent).toBe('（你不是成员）')
    expect(renderedTextAndAttributes(must(el, 'tasks-detail-editor'))).toMatch(CJK)
    expect(renderedTextAndAttributes(must(el, 'tasks-detail-lists'))).toMatch(CJK)
  })
})

describe('locale flip after mount — the detail editor and lists section', () => {
  it('the chrome, an inline error, the conflict notice, the counter and the lists copy re-render', async () => {
    h_.listAllTaskLists.mockResolvedValue({ kind: 'ok', items: FE4_LISTS, total: FE4_LISTS.length })
    h_.getTask.mockResolvedValue({ kind: 'ok', task: editableDetail() })
    const el = await mountViewAt('/tasks/t1')
    typeInto(el, 'tasks-detail-editor-title', '')
    await flush()
    await click(el, 'tasks-detail-editor-submit')
    expect(must(el, 'tasks-detail-editor-title-error').textContent?.trim()).toBe('标题不能为空')
    expect(must(el, 'tasks-detail-editor-submit').textContent).toBe('保存')

    setLocale('en')
    await flush()
    expect(must(el, 'tasks-detail-editor').querySelector('h3')?.textContent).toBe('Edit task')
    expect(must(el, 'tasks-detail-editor-title-error').textContent?.trim()).toBe('The title cannot be empty')
    expect(must(el, 'tasks-detail-editor-submit').textContent).toBe('Save')
    expect(must(el, 'tasks-detail-editor-description-count').textContent?.trim()).toBe('5 / 20000 characters')
    expect(must(el, 'tasks-detail-lists').querySelector('h3')?.textContent).toBe('Lists')
    expect(must(el, 'tasks-detail-lists-not-member').textContent).toBe(' (you are not a member)')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)

    setLocale('zh-CN')
    typeInto(el, 'tasks-detail-editor-title', 'Mine')
    await flush()
    h_.patchTask.mockResolvedValueOnce({ kind: 'conflict', code: 'VERSION_CONFLICT', currentVersion: 4 })
    await click(el, 'tasks-detail-editor-submit')
    expect(must(el, 'tasks-detail-editor-conflict').textContent?.trim()).toBe(TASKS_FMT_ZH.versionConflict(4))
    setLocale('en')
    await flush()
    expect(must(el, 'tasks-detail-editor-conflict').textContent?.trim()).toBe(TASKS_FMT_EN.versionConflict(4))
  })
})

// ---------------------------------------------------------------------------------------------
// FE-5 — the lists sidebar on /tasks and the list page /task-lists/:id (design §2.4, §4.1, §4.2)
// ---------------------------------------------------------------------------------------------

/** `/task-lists/:id` on a real router laid out like appRoutes.ts. */
async function mountListPage(path = '/task-lists/tl_1'): Promise<HTMLElement> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/tasks', component: TasksView },
      { path: '/tasks/:id', component: TasksView },
      { path: '/task-lists/:id', component: TaskListView },
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

const FE5_SIDEBAR_LISTS = [
  listFixture('tl_a', 'Alpha', 'owner'),
  listFixture('tl_b', 'Beta', 'edit'),
  listFixture('tl_c', 'Gamma', 'read'),
  { ...listFixture('tl_d', 'Delta', 'owner'), archivedAt: '2026-09-02T00:00:00Z' },
]

function listEvent(id: string, eventType: string) {
  return { id, listId: 'tl_1', actorId: 'u2', eventType, payload: {}, occurredAt: '2026-09-03T08:00:00Z' }
}

/** Every event word of the closed set, plus one the client does not know (ASCII, shown as sent). */
const FE5_EVENTS = [...Object.keys(TASKS_LIST_EVENT_KEYS), 'something_new'].map((type, i) => listEvent(`ev${i}`, type))

function unmountCurrent(): void {
  app?.unmount()
  container?.remove()
  app = null
  container = null
}

describe('labels — the activity event words', () => {
  it('every word of the closed set resolves to its own copy in both languages; an unknown type is shown as sent', () => {
    const offenders: string[] = []
    for (const type of Object.keys(TASKS_LIST_EVENT_KEYS)) {
      for (const [lang, t] of [['zh', TASKS_ZH], ['en', TASKS_EN]] as const) {
        const word = listEventLabel(type, t)
        if (!word || word === type) offenders.push(`${lang}:${type}`)
      }
    }
    expect(offenders).toEqual([])
    expect(Object.keys(TASKS_LIST_EVENT_KEYS)).toHaveLength(15)
    for (const type of ['something_new', '', 'constructor', '__proto__', 'toString']) {
      expect(listEventLabel(type, TASKS_ZH), type).toBe(type)
      expect(listEventLabel(type, TASKS_EN), type).toBe(type)
    }
  })
})

describe('EN locale — the lists sidebar renders no CJK', () => {
  beforeEach(() => {
    setLocale('en')
  })

  it('rows with each role and the archived mark, the box, the create form and load more', async () => {
    h_.listTaskLists.mockResolvedValue({ kind: 'ok', items: FE5_SIDEBAR_LISTS, total: 150 })
    const el = await mountViewAt('/tasks')
    expect(must(el, 'tasks-lists-sidebar').querySelector('h2')?.textContent?.trim()).toBe('My lists')
    expect(Array.from(el.querySelectorAll('[data-testid="tasks-lists-item-role"]')).map((node) => node.textContent?.trim())).toEqual([
      'Owner',
      'Can edit',
      'Read only',
      'Owner',
    ])
    expect(must(el, 'tasks-lists-item-archived').textContent?.trim()).toBe('Archived')
    expect(must(el, 'tasks-lists-archived-toggle').closest('label')?.textContent?.trim()).toBe('Show archived')
    expect(must(el, 'tasks-lists-create-input').getAttribute('placeholder')).toBe('List name')
    expect(must(el, 'tasks-lists-create-submit').textContent?.trim()).toBe('Create list')
    expect(must(el, 'tasks-lists-more').textContent?.trim()).toBe('Load more')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('read states — loading, empty, error, forbidden, unavailable', async () => {
    const pending = deferred<unknown>()
    h_.listTaskLists.mockReturnValue(pending.promise)
    let el = await mountViewAt('/tasks')
    expect(must(el, 'tasks-lists-loading').textContent?.trim()).toBe('Loading…')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
    pending.resolve({ kind: 'ok', items: [], total: 0 })
    await flush()
    expect(must(el, 'tasks-lists-empty').textContent?.trim()).toBe('No lists yet')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
    unmountCurrent()

    for (const [kind, testid, copy] of [
      ['error', 'tasks-lists-error', 'Could not load your lists. Please try again later.'],
      ['forbidden', 'tasks-lists-forbidden', 'You do not have permission to view task lists'],
      ['not_found', 'tasks-lists-unavailable', 'Task lists are not available on this service'],
    ] as const) {
      h_.listTaskLists.mockResolvedValue({ kind })
      el = await mountViewAt('/tasks')
      expect(must(el, testid).textContent?.trim(), kind).toBe(copy)
      expect(renderedTextAndAttributes(el), kind).not.toMatch(CJK)
      unmountCurrent()
    }
  })

  it('create errors — each name code, forbidden, unavailable and the generic failure; the load-more failure', async () => {
    h_.listTaskLists.mockResolvedValueOnce({ kind: 'ok', items: FE5_SIDEBAR_LISTS, total: 150 }).mockResolvedValue({ kind: 'error', status: 500 })
    const el = await mountViewAt('/tasks')
    await click(el, 'tasks-lists-more')
    expect(must(el, 'tasks-lists-more-error').textContent?.trim()).toBe('Could not load more lists. Please try again later.')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)

    typeInto(el, 'tasks-lists-create-input', '​')
    await submitForm(el, 'tasks-lists-create-form')
    expect(must(el, 'tasks-lists-create-error').textContent?.trim()).toBe('The name cannot be empty')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)

    for (const [result, copy] of [
      [{ kind: 'validation', code: 'NAME_TOO_LONG' }, 'The name is too long'],
      [{ kind: 'forbidden' }, 'You do not have permission to create a list'],
      [{ kind: 'not_found' }, 'Task lists are not available on this service'],
      [{ kind: 'error', status: 500 }, 'Could not create the list. Please try again later.'],
    ] as const) {
      h_.createTaskList.mockResolvedValue(result)
      typeInto(el, 'tasks-lists-create-input', 'Groceries')
      await submitForm(el, 'tasks-lists-create-form')
      expect(must(el, 'tasks-lists-create-error').textContent?.trim(), result.kind).toBe(copy)
      expect(renderedTextAndAttributes(el), result.kind).not.toMatch(CJK)
    }
  })
})

describe('ZH locale — the lists sidebar renders CJK (positive control)', () => {
  it('the heading, the roles, the archived mark and the box', async () => {
    h_.listTaskLists.mockResolvedValue({ kind: 'ok', items: FE5_SIDEBAR_LISTS, total: 4 })
    const el = await mountViewAt('/tasks')
    expect(must(el, 'tasks-lists-sidebar').querySelector('h2')?.textContent?.trim()).toBe('我的清单')
    expect(must(el, 'tasks-lists-item-archived').textContent?.trim()).toBe('已归档')
    expect(renderedTextAndAttributes(must(el, 'tasks-lists-sidebar'))).toMatch(CJK)
  })
})

describe('locale flip after mount — the lists sidebar', () => {
  it('the heading, a role, the box, an inline error and the empty state re-render', async () => {
    h_.listTaskLists.mockResolvedValue({ kind: 'ok', items: FE5_SIDEBAR_LISTS.slice(0, 1), total: 1 })
    const el = await mountViewAt('/tasks')
    typeInto(el, 'tasks-lists-create-input', '​')
    await submitForm(el, 'tasks-lists-create-form')
    expect(must(el, 'tasks-lists-item-role').textContent?.trim()).toBe('所有者')
    expect(must(el, 'tasks-lists-create-error').textContent?.trim()).toBe('名称不能为空')

    setLocale('en')
    await flush()
    expect(must(el, 'tasks-lists-sidebar').querySelector('h2')?.textContent?.trim()).toBe('My lists')
    expect(must(el, 'tasks-lists-item-role').textContent?.trim()).toBe('Owner')
    expect(must(el, 'tasks-lists-archived-toggle').closest('label')?.textContent?.trim()).toBe('Show archived')
    expect(must(el, 'tasks-lists-create-error').textContent?.trim()).toBe('The name cannot be empty')
    expect(renderedTextAndAttributes(must(el, 'tasks-lists-sidebar'))).not.toMatch(CJK)
  })
})

describe('EN locale — the list page renders no CJK', () => {
  beforeEach(() => {
    setLocale('en')
  })

  it('the page with rows, the role, the archived mark, the rename form, the add form, a remove confirmation and the activity', async () => {
    h_.getTaskList.mockResolvedValue({ kind: 'ok', list: { ...listFixture('tl_1', 'List One', 'owner'), archivedAt: '2026-09-02T00:00:00Z' } })
    h_.listTaskListItems.mockResolvedValue({
      kind: 'ok',
      items: [listItem({ id: 't1', due_at: '2026-10-01T09:00:00Z' }), listItem({ id: 't2', status: 'done' })],
      total: 2,
    })
    h_.listTaskListEvents.mockResolvedValue({ kind: 'ok', items: FE5_EVENTS, total: 100 })
    const el = await mountListPage()
    expect(el.querySelector('h1')?.textContent).toBe('List One')
    expect(must(el, 'tasks-list-detail-role').textContent?.trim()).toBe('My role: Owner')
    expect(must(el, 'tasks-list-detail-archived').textContent?.trim()).toBe('Archived')
    expect(must(el, 'tasks-list-detail-unarchive').textContent?.trim()).toBe('Unarchive')
    expect(must(el, 'tasks-list-detail-back-link').textContent).toContain('Back to task list')
    expect(must(el, 'tasks-list-detail-item-remove').getAttribute('aria-label')).toBe('Remove "Task One" from this list')
    expect(must(el, 'tasks-list-detail-item-due').textContent).toContain('2026')
    await click(el, 'tasks-list-detail-rename')
    await click(el, 'tasks-list-detail-item-remove')
    await click(el, 'tasks-list-detail-events-toggle')
    expect(Array.from(el.querySelectorAll('[data-testid="tasks-list-detail-event-type"]')).map((node) => node.textContent?.trim())).toEqual([
      ...Object.keys(TASKS_LIST_EVENT_KEYS).map((type) => listEventLabel(type, TASKS_EN)),
      'something_new',
    ])
    expect(must(el, 'tasks-list-detail-events-more').textContent?.trim()).toBe('Load more')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('page states — not_found, forbidden, error, loading; the items section — loading, empty, unavailable, cut short; the activity — loading, empty, error', async () => {
    for (const [kind, testid, copy] of [
      ['not_found', 'tasks-list-detail-not-found', 'This list does not exist, or you are not a member'],
      ['forbidden', 'tasks-list-detail-forbidden', 'You do not have permission to view this list'],
      ['error', 'tasks-list-detail-error', 'Could not load the list. Please try again later.'],
    ] as const) {
      h_.getTaskList.mockResolvedValue({ kind })
      const el = await mountListPage()
      expect(must(el, testid).textContent?.trim(), kind).toBe(copy)
      expect(el.querySelector('h1')?.textContent).toBe('Task list')
      expect(renderedTextAndAttributes(el), kind).not.toMatch(CJK)
      unmountCurrent()
    }

    const list = deferred<unknown>()
    h_.getTaskList.mockReturnValue(list.promise)
    const itemsRead = deferred<unknown>()
    h_.listTaskListItems.mockReturnValue(itemsRead.promise)
    const el = await mountListPage()
    expect(must(el, 'tasks-list-detail-loading').textContent?.trim()).toBe('Loading…')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
    list.resolve({ kind: 'ok', list: listFixture('tl_1', 'List One', 'owner') })
    await flush()
    expect(must(el, 'tasks-list-detail-items-loading').textContent?.trim()).toBe('Loading…')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
    itemsRead.resolve({ kind: 'ok', items: [], total: 0 })
    await flush()
    expect(must(el, 'tasks-list-detail-items-empty').textContent?.trim()).toBe('No tasks in this list yet')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)

    const events = deferred<unknown>()
    h_.listTaskListEvents.mockReturnValueOnce(events.promise).mockResolvedValueOnce({ kind: 'error', status: 500 })
    await click(el, 'tasks-list-detail-events-toggle')
    expect(must(el, 'tasks-list-detail-events-loading').textContent?.trim()).toBe('Loading…')
    events.resolve({ kind: 'ok', items: [], total: 0 })
    await flush()
    expect(must(el, 'tasks-list-detail-events-empty').textContent?.trim()).toBe('No activity yet')
    expect(must(el, 'tasks-list-detail-events-toggle').textContent?.trim()).toBe('Activity')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
    await click(el, 'tasks-list-detail-events-toggle')
    await click(el, 'tasks-list-detail-events-toggle')
    expect(must(el, 'tasks-list-detail-events-error').textContent?.trim()).toBe('Could not load the activity. Please try again later.')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
    unmountCurrent()

    h_.getTaskList.mockResolvedValue({ kind: 'ok', list: listFixture('tl_1', 'List One', 'owner') })
    h_.listTaskListItems.mockResolvedValue({ kind: 'not_found' })
    const unavailable = await mountListPage()
    expect(must(unavailable, 'tasks-list-detail-items-unavailable').textContent?.trim()).toBe('The tasks in this list could not be loaded')
    expect(renderedTextAndAttributes(unavailable)).not.toMatch(CJK)
    unmountCurrent()

    h_.listTaskListItems.mockResolvedValue({ kind: 'ok', items: [listItem()], total: 3000 })
    const cut = await mountListPage()
    expect(must(cut, 'tasks-list-detail-items-truncated').textContent?.trim()).toBe('This list holds many tasks; not all of them are shown')
    expect(renderedTextAndAttributes(cut)).not.toMatch(CJK)
  })

  it('errors — rename inline (both codes), the banner (three kinds), the add form inline (four kinds), the activity load-more failure', async () => {
    h_.listTaskListItems.mockResolvedValue({ kind: 'ok', items: [listItem()], total: 1 })
    h_.listTaskListEvents.mockResolvedValueOnce({ kind: 'ok', items: FE5_EVENTS.slice(0, 2), total: 50 }).mockResolvedValue({ kind: 'error', status: 500 })
    const el = await mountListPage()

    await click(el, 'tasks-list-detail-rename')
    for (const [result, copy] of [
      [{ kind: 'validation', code: 'INVALID_NAME' }, 'The name cannot be empty'],
      [{ kind: 'validation', code: 'NAME_TOO_LONG' }, 'The name is too long'],
    ] as const) {
      h_.renameTaskList.mockResolvedValue(result)
      await submitForm(el, 'tasks-list-detail-rename-form')
      expect(must(el, 'tasks-list-detail-rename-error').textContent?.trim()).toBe(copy)
      expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
    }
    for (const [result, copy] of [
      [{ kind: 'not_found' }, 'The list is not available, or you are no longer a member'],
      [{ kind: 'forbidden' }, 'You do not have permission to change this list'],
      [{ kind: 'error', status: 500 }, 'The action failed. Please try again later.'],
    ] as const) {
      h_.renameTaskList.mockResolvedValue(result)
      await submitForm(el, 'tasks-list-detail-rename-form')
      expect(must(el, 'tasks-list-detail-banner').textContent?.trim()).toBe(copy)
      expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
    }

    for (const [result, copy] of [
      [{ kind: 'validation', code: 'INVALID_TASK' }, 'Invalid task'],
      [{ kind: 'validation', code: 'LIMIT' }, 'A task can belong to at most 10 lists'],
      [{ kind: 'validation', code: 'SOMETHING_NEW' }, 'The action failed. Please try again later.'],
      [{ kind: 'not_found' }, 'The task does not exist, you are not its creator or an assignee, or the list is not available'],
    ] as const) {
      h_.addTaskToList.mockResolvedValue(result)
      typeInto(el, 'tasks-list-detail-add-task-input', 't9')
      await submitForm(el, 'tasks-list-detail-add-task-form')
      expect(must(el, 'tasks-list-detail-add-task-error').textContent?.trim()).toBe(copy)
      expect(must(el, 'tasks-list-detail-add-task-input').getAttribute('placeholder')).toBe('Task ID')
      expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
    }

    await click(el, 'tasks-list-detail-events-toggle')
    await click(el, 'tasks-list-detail-events-more')
    expect(must(el, 'tasks-list-detail-events-more-error').textContent?.trim()).toBe('Could not load the activity. Please try again later.')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('context states — loading, org_missing, unavailable, forbidden, error', async () => {
    const context = deferred<unknown>()
    h_.loadTasksContext.mockReturnValueOnce(context.promise)
    const loading = await mountListPage()
    expect(must(loading, 'tasks-list-detail-loading').textContent?.trim()).toBe('Loading…')
    expect(renderedTextAndAttributes(loading)).not.toMatch(CJK)
    context.resolve({ state: 'error' })
    await flush()
    unmountCurrent()

    for (const [state, testid] of [
      ['org_missing', 'tasks-view-org-missing'],
      ['unavailable', 'tasks-view-unavailable'],
      ['forbidden', 'tasks-view-forbidden'],
      ['error', 'tasks-view-error'],
    ] as const) {
      h_.loadTasksContext.mockResolvedValue({ state })
      const el = await mountListPage()
      expect(must(el, testid).textContent?.trim().length).toBeGreaterThan(0)
      expect(renderedTextAndAttributes(el), state).not.toMatch(CJK)
      unmountCurrent()
    }
  })
})

describe('ZH locale — the list page renders CJK (positive control)', () => {
  it('the page, the controls and the activity', async () => {
    h_.listTaskListEvents.mockResolvedValue({ kind: 'ok', items: FE5_EVENTS.slice(0, 1), total: 1 })
    const el = await mountListPage()
    expect(must(el, 'tasks-list-detail-role').textContent?.trim()).toBe('我的角色：所有者')
    expect(must(el, 'tasks-list-detail-archive').textContent?.trim()).toBe('归档')
    await click(el, 'tasks-list-detail-events-toggle')
    expect(must(el, 'tasks-list-detail-event-type').textContent?.trim()).toBe('创建了清单')
    expect(renderedTextAndAttributes(el)).toMatch(CJK)
  })
})

describe('locale flip after mount — the list page', () => {
  it('the role, the controls, the items copy, the banner and an event word re-render', async () => {
    h_.listTaskListItems.mockResolvedValue({ kind: 'ok', items: [listItem()], total: 1 })
    h_.listTaskListEvents.mockResolvedValue({ kind: 'ok', items: FE5_EVENTS.slice(0, 1), total: 1 })
    h_.archiveTaskList.mockResolvedValue({ kind: 'forbidden' })
    const el = await mountListPage()
    await click(el, 'tasks-list-detail-archive')
    await click(el, 'tasks-list-detail-events-toggle')
    expect(must(el, 'tasks-list-detail-banner').textContent?.trim()).toBe('您没有权限修改此清单')
    expect(must(el, 'tasks-list-detail-item-remove').textContent?.trim()).toBe('移出清单')

    setLocale('en')
    await flush()
    expect(must(el, 'tasks-list-detail-role').textContent?.trim()).toBe('My role: Owner')
    expect(must(el, 'tasks-list-detail-archive').textContent?.trim()).toBe('Archive')
    expect(must(el, 'tasks-list-detail-item-remove').textContent?.trim()).toBe('Remove from list')
    expect(must(el, 'tasks-list-detail-item-remove').getAttribute('aria-label')).toBe('Remove "Task One" from this list')
    expect(must(el, 'tasks-list-detail-banner').textContent?.trim()).toBe('You do not have permission to change this list')
    expect(must(el, 'tasks-list-detail-event-type').textContent?.trim()).toBe('created the list')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })
})

// ---------------------------------------------------------------------------------------------
// FE-6 — the members dialog of the list page (design §5)
// ---------------------------------------------------------------------------------------------

function memberRow(userId: string, role: 'read' | 'edit' | 'owner') {
  return { userId, role, createdAt: '2026-09-01T00:00:00Z' }
}

const FE6_ROSTER = [memberRow('u1', 'owner'), memberRow('u2', 'edit'), memberRow('u3', 'read')]

/** The list page with the members dialog open. */
async function openMembersDialog(): Promise<HTMLElement> {
  const el = await mountListPage()
  await click(el, 'tasks-list-detail-members')
  await flush(12)
  return el
}

function rowNode(el: HTMLElement, userId: string): HTMLElement {
  return el.querySelector(`[data-testid="tasks-list-member"][data-user-id="${userId}"]`) as HTMLElement
}

async function pickIn(select: HTMLSelectElement, value: string): Promise<void> {
  select.value = value
  select.dispatchEvent(new Event('change'))
  await flush(12)
}

describe('labels — the members dialog format functions', () => {
  it('each embeds the member id in both languages', () => {
    for (const key of ['membersRoleFor', 'membersRemoveNamed', 'membersTransferNamed', 'membersTransferPrompt'] as const) {
      expect(TASKS_FMT_ZH[key]('u_42'), key).toContain('u_42')
      expect(TASKS_FMT_EN[key]('u_42'), key).toContain('u_42')
    }
  })
})

describe('EN locale — the members dialog renders no CJK', () => {
  beforeEach(() => {
    setLocale('en')
    h_.listTaskListMembers.mockResolvedValue({ kind: 'ok', items: FE6_ROSTER, total: 3 })
  })

  it("the owner's view: the rows with their role copy and the creator mark, each row control and its name, the add form, a transfer confirmation", async () => {
    const el = await openMembersDialog()
    expect(must(el, 'tasks-list-detail-members').textContent?.trim()).toBe('Members')
    expect(must(el, 'tasks-list-members-title').textContent?.trim()).toBe('List members')
    expect(Array.from(el.querySelectorAll('[data-testid="tasks-list-member-role"]')).map((node) => node.textContent?.trim())).toEqual([
      'Owner',
      'Can edit',
      'Read only',
    ])
    expect(must(el, 'tasks-list-member-creator').textContent?.trim()).toBe('Creator')
    const u2 = rowNode(el, 'u2')
    expect(must(u2, 'tasks-list-member-role-select').getAttribute('aria-label')).toBe('Role of "u2"')
    expect(Array.from((must(u2, 'tasks-list-member-role-select') as HTMLSelectElement).options).map((option) => option.textContent?.trim())).toEqual([
      'Read only',
      'Can edit',
    ])
    expect(must(u2, 'tasks-list-member-remove').getAttribute('aria-label')).toBe('Remove member "u2"')
    expect(must(u2, 'tasks-list-member-remove').textContent?.trim()).toBe('Remove')
    expect(must(u2, 'tasks-list-member-transfer').getAttribute('aria-label')).toBe('Transfer ownership to "u2"')
    expect(must(u2, 'tasks-list-member-transfer').textContent?.trim()).toBe('Make owner')
    expect(must(el, 'tasks-list-add-member-input').getAttribute('placeholder')).toBe('User ID')
    expect(must(el, 'tasks-list-add-member-submit').textContent?.trim()).toBe('Add member')
    expect(must(el, 'tasks-list-members-close').textContent?.trim()).toBe('Close')
    await click(u2, 'tasks-list-member-transfer')
    expect(must(el, 'tasks-list-member-transfer-confirm').textContent).toContain(
      'Transfer ownership to "u2"? You will stay on the list with the edit role.',
    )
    expect(must(el, 'tasks-list-member-transfer-confirm-yes').textContent?.trim()).toBe('Confirm transfer')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it("an edit member's view with the leave confirmation, at the member cap", async () => {
    h_.getCurrentUserId.mockResolvedValue('u2')
    h_.getTaskList.mockResolvedValue({ kind: 'ok', list: listFixture('tl_1', 'List One', 'edit') })
    h_.listTaskListMembers.mockResolvedValue({
      kind: 'ok',
      items: [...FE6_ROSTER, ...Array.from({ length: 97 }, (_, i) => memberRow(`m${String(i).padStart(3, '0')}`, 'read'))],
      total: 100,
    })
    const el = await openMembersDialog()
    expect(must(el, 'tasks-list-add-member-cap').textContent?.trim()).toBe('The member limit has been reached')
    expect(must(el, 'tasks-list-leave').textContent?.trim()).toBe('Leave list')
    await click(el, 'tasks-list-leave')
    expect(must(el, 'tasks-list-leave-confirm').textContent).toContain('Leave this list?')
    expect(must(el, 'tasks-list-leave-confirm-yes').textContent?.trim()).toBe('Confirm leaving')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('read states — loading, empty, failed, forbidden, not available', async () => {
    const roster = deferred<unknown>()
    h_.listTaskListMembers.mockReturnValueOnce(roster.promise)
    const loading = await openMembersDialog()
    expect(must(loading, 'tasks-list-members-loading').textContent?.trim()).toBe('Loading…')
    expect(renderedTextAndAttributes(loading)).not.toMatch(CJK)
    roster.resolve({ kind: 'ok', items: [], total: 0 })
    await flush(12)
    expect(must(loading, 'tasks-list-members-empty').textContent?.trim()).toBe('No members yet')
    expect(renderedTextAndAttributes(loading)).not.toMatch(CJK)
    unmountCurrent()

    for (const [result, testid, copy] of [
      [{ kind: 'error', status: 500 }, 'tasks-list-members-load-error', 'Could not load the members. Please try again later.'],
      [{ kind: 'forbidden' }, 'tasks-list-members-forbidden', 'You do not have permission to view this list'],
      [{ kind: 'not_found' }, 'tasks-list-members-not-found', 'The list is not available, or you are no longer a member'],
    ] as const) {
      h_.listTaskListMembers.mockResolvedValue(result)
      const el = await openMembersDialog()
      expect(must(el, testid).textContent?.trim(), result.kind).toBe(copy)
      expect(renderedTextAndAttributes(el), result.kind).not.toMatch(CJK)
      unmountCurrent()
    }
  })

  it('errors — the add form (five kinds), a row, the leave button and the banner (404, 403, failure)', async () => {
    const el = await openMembersDialog()
    for (const [result, copy] of [
      [{ kind: 'validation', code: 'INVALID_MEMBER' }, 'Invalid user'],
      [{ kind: 'validation', code: 'INVALID_ROLE' }, 'Invalid role'],
      [{ kind: 'validation', code: 'INACTIVE_ORG_MEMBER' }, 'This user is not in the current organization or has been deactivated'],
      [{ kind: 'validation', code: 'LIMIT' }, 'The member limit has been reached'],
      [{ kind: 'validation', code: 'SOMETHING_NEW' }, 'The action failed. Please try again later.'],
    ] as const) {
      h_.addTaskListMember.mockResolvedValue(result)
      typeInto(el, 'tasks-list-add-member-input', 'u7')
      await submitForm(el, 'tasks-list-add-member-form')
      await flush(12)
      expect(must(el, 'tasks-list-add-member-error').textContent?.trim()).toBe(copy)
      expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
    }

    for (const [code, copy] of [
      ['OWNER_MUST_TRANSFER', 'Transfer ownership first'],
      ['CREATED_BY_IMMUTABLE', 'The list creator cannot be removed'],
      ['TARGET_NOT_MEMBER', 'That user is not a member of the list'],
    ] as const) {
      h_.removeTaskListMember.mockResolvedValue({ kind: 'validation', code })
      await click(rowNode(el, 'u3'), 'tasks-list-member-remove')
      await flush(12)
      expect(must(rowNode(el, 'u3'), 'tasks-list-member-error').textContent?.trim()).toBe(copy)
      expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
    }

    h_.changeTaskListMemberRole.mockResolvedValue({ kind: 'validation', code: 'INVALID_ROLE' })
    await pickIn(must(rowNode(el, 'u3'), 'tasks-list-member-role-select') as HTMLSelectElement, 'edit')
    expect(must(rowNode(el, 'u3'), 'tasks-list-member-error').textContent?.trim()).toBe('Invalid role')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)

    for (const [result, copy] of [
      [{ kind: 'not_found' }, 'The list is not available, or you are no longer a member'],
      [{ kind: 'forbidden' }, 'You do not have permission to change this list'],
      [{ kind: 'error', status: 500 }, 'The action failed. Please try again later.'],
    ] as const) {
      h_.removeTaskListMember.mockResolvedValue(result)
      await click(rowNode(el, 'u3'), 'tasks-list-member-remove')
      await flush(12)
      expect(must(el, 'tasks-list-members-error').textContent?.trim()).toBe(copy)
      expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
    }
    unmountCurrent()

    h_.getCurrentUserId.mockResolvedValue('u2')
    h_.getTaskList.mockResolvedValue({ kind: 'ok', list: listFixture('tl_1', 'List One', 'edit') })
    h_.removeTaskListMember.mockResolvedValue({ kind: 'validation', code: 'CREATED_BY_IMMUTABLE' })
    const member = await openMembersDialog()
    await click(member, 'tasks-list-leave')
    await click(member, 'tasks-list-leave-confirm-yes')
    await flush(12)
    expect(must(member, 'tasks-list-leave-error').textContent?.trim()).toBe('The list creator cannot be removed')
    expect(renderedTextAndAttributes(member)).not.toMatch(CJK)
  })
})

describe('ZH locale — the members dialog renders CJK (positive control)', () => {
  it('the title, the rows and the controls', async () => {
    h_.listTaskListMembers.mockResolvedValue({ kind: 'ok', items: FE6_ROSTER, total: 3 })
    const el = await openMembersDialog()
    expect(must(el, 'tasks-list-members-title').textContent?.trim()).toBe('清单成员')
    expect(must(rowNode(el, 'u2'), 'tasks-list-member-transfer').textContent?.trim()).toBe('设为所有者')
    expect(renderedTextAndAttributes(must(el, 'tasks-list-members-dialog'))).toMatch(CJK)
  })
})

describe('locale flip after mount — the members dialog', () => {
  it('the title, the row copy, the accessible names, the add form and a row error re-render', async () => {
    h_.listTaskListMembers.mockResolvedValue({ kind: 'ok', items: FE6_ROSTER, total: 3 })
    h_.removeTaskListMember.mockResolvedValue({ kind: 'validation', code: 'CREATED_BY_IMMUTABLE' })
    const el = await openMembersDialog()
    await click(rowNode(el, 'u3'), 'tasks-list-member-remove')
    await flush(12)
    expect(must(rowNode(el, 'u3'), 'tasks-list-member-error').textContent?.trim()).toBe('清单创建人不能被移除')

    setLocale('en')
    await flush()
    expect(must(el, 'tasks-list-detail-members').textContent?.trim()).toBe('Members')
    expect(must(el, 'tasks-list-members-title').textContent?.trim()).toBe('List members')
    expect(must(rowNode(el, 'u2'), 'tasks-list-member-role').textContent?.trim()).toBe('Can edit')
    expect(must(rowNode(el, 'u2'), 'tasks-list-member-role-select').getAttribute('aria-label')).toBe('Role of "u2"')
    expect(must(el, 'tasks-list-add-member-input').getAttribute('placeholder')).toBe('User ID')
    expect(must(rowNode(el, 'u3'), 'tasks-list-member-error').textContent?.trim()).toBe('The list creator cannot be removed')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })
})

// ---------------------------------------------------------------------------------------------
// FE-7 — the grouping board (design §4.4, §6), in the assigned view and on the list page
// ---------------------------------------------------------------------------------------------

const FE7_ROWS = [listItem({ id: 't1', title: 'Task One' }), listItem({ id: 't2', title: 'Task Two' }), listItem({ id: 't3', title: 'Task Three' })]

const FE7_USER_GROUPS = [
  { id: 'tg_def', scope: 'user', name: 'Default', position: 0, isDefault: true },
  { id: 'tg_a', scope: 'user', name: 'Alpha', position: 1, isDefault: false },
]

/** t1 and t2 placed in the default group, t3 in its unsorted tail, Alpha empty. */
const FE7_USER_PLACEMENTS = [
  { groupId: 'tg_def', taskId: 't1', position: 0 },
  { groupId: 'tg_def', taskId: 't2', position: 1 },
]

/** The assigned view with its personal grouping board. */
async function mountPersonalBoard(): Promise<HTMLElement> {
  h_.listTasks.mockResolvedValue({ kind: 'ok', items: FE7_ROWS })
  h_.listUserGroups.mockResolvedValue({ kind: 'ok', items: FE7_USER_GROUPS, total: 2 })
  h_.listUserGroupItems.mockResolvedValue({ kind: 'ok', items: FE7_USER_PLACEMENTS, total: 2 })
  const el = await mountViewAt('/tasks')
  await flush(12)
  must(el, 'tasks-group')
  return el
}

function groupSection(el: HTMLElement, groupId: string): HTMLElement {
  const found = Array.from(el.querySelectorAll<HTMLElement>('[data-testid="tasks-group"]')).find(
    (item) => item.getAttribute('data-group-id') === groupId,
  )
  expect(found, groupId).toBeTruthy()
  return found as HTMLElement
}

function boardRow(el: HTMLElement, taskId: string): HTMLElement {
  const found = Array.from(el.querySelectorAll<HTMLElement>('[data-task-id]')).find((item) => item.getAttribute('data-task-id') === taskId)
  expect(found, taskId).toBeTruthy()
  return found as HTMLElement
}

describe('labels — the grouping board format functions', () => {
  it('the count reads in each language; the place and the group name are embedded', () => {
    expect(TASKS_FMT_ZH.groupsItemCount(2)).toBe('2 项')
    expect(TASKS_FMT_EN.groupsItemCount(1)).toBe('1 task')
    expect(TASKS_FMT_EN.groupsItemCount(2)).toBe('2 tasks')
    expect(TASKS_FMT_ZH.groupsMovedToGroup('Alpha', 3)).toBe('已移到「Alpha」第 3 位')
    expect(TASKS_FMT_EN.groupsMovedToGroup('Alpha', 3)).toBe('Moved to place 3 in "Alpha"')
    for (const key of ['groupsMoveUpNamed', 'groupsMoveDownNamed', 'groupsAddToOrderNamed', 'groupsMoveToNamed', 'groupsRenameNamed', 'groupsDeleteNamed', 'groupsDeletePrompt'] as const) {
      expect(TASKS_FMT_ZH[key]('X_42'), key).toContain('X_42')
      expect(TASKS_FMT_EN[key]('X_42'), key).toContain('X_42')
    }
  })
})

describe('EN locale — the grouping board renders no CJK', () => {
  beforeEach(() => {
    setLocale('en')
  })

  it('the assigned view\'s board: groups, placed rows, the unsorted tail, every control and its name', async () => {
    const el = await mountPersonalBoard()
    expect(must(el, 'tasks-group-unsorted-heading').textContent?.trim()).toBe('Unsorted')
    expect(must(el, 'tasks-groups-refresh').textContent?.trim()).toBe('Refresh')
    expect(must(groupSection(el, 'tg_def'), 'tasks-group-count').textContent?.trim()).toBe('3 tasks')
    expect(must(groupSection(el, 'tg_a'), 'tasks-group-empty').textContent?.trim()).toBe('No tasks in this group')
    expect(must(boardRow(el, 't3'), 'tasks-group-add-to-order').textContent?.trim()).toBe('Add to order')
    expect(must(boardRow(el, 't3'), 'tasks-group-add-to-order').getAttribute('aria-label')).toBe('Add "Task Three" to the sorted order')
    expect(must(boardRow(el, 't2'), 'tasks-group-move-up').textContent?.trim()).toBe('Move up')
    expect(must(boardRow(el, 't2'), 'tasks-group-move-up').getAttribute('aria-label')).toBe('Move "Task Two" up one place')
    expect(must(boardRow(el, 't1'), 'tasks-group-move-down').getAttribute('aria-label')).toBe('Move "Task One" down one place')
    expect(must(boardRow(el, 't1'), 'tasks-group-move-to').getAttribute('aria-label')).toBe('Move "Task One" to a group')
    expect(must(boardRow(el, 't1'), 'tasks-group-drag-handle').getAttribute('aria-label')).toBe('Drag to reorder')
    expect(must(groupSection(el, 'tg_a'), 'tasks-group-rename').getAttribute('aria-label')).toBe('Rename group "Alpha"')
    expect(must(groupSection(el, 'tg_a'), 'tasks-group-delete').textContent?.trim()).toBe('Delete group')
    expect(must(el, 'tasks-groups-create-submit').textContent?.trim()).toBe('New group')
    expect(must(el, 'tasks-groups-create-input').getAttribute('placeholder')).toBe('Group name')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('the default group before its row exists: the rename hint', async () => {
    h_.listTasks.mockResolvedValue({ kind: 'ok', items: FE7_ROWS })
    const el = await mountViewAt('/tasks')
    await flush(12)
    expect(must(el, 'tasks-group-rename-hint').textContent?.trim()).toBe('This group can be renamed after the first move or after a group is created')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('the live region while a move saves, after it, and after a move to another group', async () => {
    const answer = deferred<unknown>()
    h_.placeTaskInUserGroup.mockReturnValueOnce(answer.promise)
    const el = await mountPersonalBoard()
    await click(boardRow(el, 't1'), 'tasks-group-move-down')
    expect(must(el, 'tasks-groups-live').textContent?.trim()).toBe('Saving the order')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
    answer.resolve({ kind: 'ok', taskId: 't1', groupId: 'tg_def', position: 1 })
    await flush(12)
    expect(must(el, 'tasks-groups-live').textContent?.trim()).toBe('Moved to place 2')
    const select = must(boardRow(el, 't1'), 'tasks-group-move-to') as HTMLSelectElement
    select.value = 'tg_a'
    select.dispatchEvent(new Event('change'))
    await flush(12)
    expect(must(el, 'tasks-groups-live').textContent?.trim()).toBe('Moved to place 1 in "Alpha"')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('the banner for every failed move', async () => {
    const el = await mountPersonalBoard()
    for (const [result, copy] of [
      [{ kind: 'validation', code: 'INVALID_POSITION' }, 'The position has changed. Please refresh and try again.'],
      [{ kind: 'validation', code: 'INVALID_GROUP' }, 'The group does not exist'],
      [{ kind: 'not_found' }, 'The task or group is no longer available'],
      [{ kind: 'forbidden' }, 'You do not have permission to change groups'],
      [{ kind: 'error', status: 500 }, 'The action failed. Please try again later.'],
    ] as const) {
      h_.placeTaskInUserGroup.mockResolvedValueOnce(result)
      await click(boardRow(el, 't2'), 'tasks-group-move-up')
      await flush(12)
      expect(must(el, 'tasks-groups-banner').textContent?.trim(), result.kind).toBe(copy)
      expect(renderedTextAndAttributes(el), result.kind).not.toMatch(CJK)
    }
  })

  it('the group forms: the create errors, rename with its error, delete with its prompt and its error', async () => {
    const el = await mountPersonalBoard()
    for (const [code, copy] of [
      ['INVALID_NAME', 'The name cannot be empty'],
      ['NAME_TOO_LONG', 'The name is too long'],
      ['LIMIT', 'The group limit has been reached'],
    ] as const) {
      h_.createUserGroup.mockResolvedValueOnce({ kind: 'validation', code })
      typeInto(el, 'tasks-groups-create-input', 'Sprint')
      await submitForm(el, 'tasks-groups-create-form')
      expect(must(el, 'tasks-groups-create-error').textContent?.trim(), code).toBe(copy)
      expect(renderedTextAndAttributes(el), code).not.toMatch(CJK)
    }

    h_.renameUserGroup.mockResolvedValueOnce({ kind: 'validation', code: 'NAME_TOO_LONG' })
    await click(groupSection(el, 'tg_a'), 'tasks-group-rename')
    await submitForm(el, 'tasks-group-rename-form')
    expect(must(el, 'tasks-group-rename-error').textContent?.trim()).toBe('The name is too long')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
    await click(el, 'tasks-group-rename-cancel')

    h_.deleteUserGroup.mockResolvedValueOnce({ kind: 'validation', code: 'IS_DEFAULT' })
    await click(groupSection(el, 'tg_a'), 'tasks-group-delete')
    expect(must(el, 'tasks-group-delete-confirm').textContent).toContain('Delete group "Alpha"? Its tasks go back to the default group.')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
    await click(el, 'tasks-group-delete-confirm-yes')
    expect(must(el, 'tasks-group-delete-error').textContent?.trim()).toBe('The default group cannot be deleted')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('the notices: the group cap, reordering off, groups unavailable', async () => {
    h_.listUserGroups.mockResolvedValue({
      kind: 'ok',
      items: [
        FE7_USER_GROUPS[0],
        ...Array.from({ length: 49 }, (_v, index) => ({ id: `tg_${index}`, scope: 'user', name: `G${index}`, position: index + 1, isDefault: false })),
      ],
      total: 50,
    })
    h_.listUserGroupItems.mockResolvedValue({ kind: 'ok', items: FE7_USER_PLACEMENTS, total: 9 })
    h_.listTasks.mockResolvedValue({ kind: 'ok', items: FE7_ROWS })
    let el = await mountViewAt('/tasks')
    await flush(12)
    expect(must(el, 'tasks-groups-create-limit').textContent?.trim()).toBe('The group limit has been reached')
    expect(must(el, 'tasks-groups-reorder-off').textContent?.trim()).toBe('Some tasks are not shown here, so reordering is turned off')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
    unmountCurrent()

    h_.listUserGroups.mockResolvedValue({ kind: 'error', status: 500 })
    el = await mountViewAt('/tasks')
    await flush(12)
    expect(must(el, 'tasks-groups-unavailable').textContent?.trim()).toBe('Groups are unavailable')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })

  it('the list page\'s board', async () => {
    h_.listTaskListItems.mockResolvedValue({ kind: 'ok', items: FE7_ROWS, total: 3 })
    h_.listTaskListGroups.mockResolvedValue({
      kind: 'ok',
      items: [
        { id: 'tg_default', scope: 'list', name: 'Default', position: 0, isDefault: true },
        { id: 'tg_doing', scope: 'list', name: 'Doing', position: 1, isDefault: false },
      ],
      total: 2,
    })
    h_.listTaskListGroupItems.mockResolvedValue({ kind: 'ok', items: [{ groupId: 'tg_doing', taskId: 't2', position: 0 }], total: 1 })
    const el = await mountListPage()
    await flush(12)
    expect(must(groupSection(el, 'tg_doing'), 'tasks-group-count').textContent?.trim()).toBe('1 task')
    expect(must(el, 'tasks-group-unsorted-heading').textContent?.trim()).toBe('Unsorted')
    expect(must(boardRow(el, 't2'), 'tasks-list-detail-item-remove').textContent?.trim()).toBe('Remove from list')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })
})

describe('ZH locale — the grouping board renders CJK (positive control)', () => {
  it('the headings, the counts and the controls', async () => {
    const el = await mountPersonalBoard()
    expect(must(el, 'tasks-group-unsorted-heading').textContent?.trim()).toBe('未排序')
    expect(must(groupSection(el, 'tg_def'), 'tasks-group-count').textContent?.trim()).toBe('3 项')
    expect(must(boardRow(el, 't3'), 'tasks-group-add-to-order').textContent?.trim()).toBe('加入排序')
    expect(renderedTextAndAttributes(must(el, 'tasks-group'))).toMatch(CJK)
  })
})

describe('locale flip after mount — the grouping board', () => {
  it('the headings, the counts, the control names, the live region and the banner re-render', async () => {
    h_.placeTaskInUserGroup.mockResolvedValueOnce({ kind: 'forbidden' })
    const el = await mountPersonalBoard()
    await click(boardRow(el, 't2'), 'tasks-group-move-up')
    await flush(12)
    expect(must(el, 'tasks-groups-banner').textContent?.trim()).toBe('您没有权限调整分组')
    expect(must(el, 'tasks-group-unsorted-heading').textContent?.trim()).toBe('未排序')

    setLocale('en')
    await flush()
    expect(must(el, 'tasks-groups-banner').textContent?.trim()).toBe('You do not have permission to change groups')
    expect(must(el, 'tasks-group-unsorted-heading').textContent?.trim()).toBe('Unsorted')
    expect(must(groupSection(el, 'tg_def'), 'tasks-group-count').textContent?.trim()).toBe('3 tasks')
    expect(must(boardRow(el, 't2'), 'tasks-group-move-up').getAttribute('aria-label')).toBe('Move "Task Two" up one place')
    expect(must(el, 'tasks-groups-refresh').textContent?.trim()).toBe('Refresh')
    expect(renderedTextAndAttributes(el)).not.toMatch(CJK)
  })
})
