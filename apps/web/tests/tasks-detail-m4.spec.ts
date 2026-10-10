import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'

/**
 * M4 FE-4 — the `/tasks/:id` editor (TaskDetailEditor.vue) and lists section (TaskDetailLists.vue),
 * both stateless children of TasksView, whose state and writes live in TasksView
 * (docs/development/task-m4-frontend-design-20261007.md §4.3, §7.2, §7.3, §10.1).
 *
 * Backend: `PATCH /api/tasks/:id` and the detail's S4 fields (PR-3a S4), the detail's `listIds`
 * and the list-item routes (S7), and the detail's `canManageMembers` are built on the PR-3a
 * branch, not on main. A detail body without `listIds` or `canManageMembers` (an older backend) is
 * covered too, and so is main's M3 body, which carries `version` but none of the S4 keys. FE-8 adds
 * the member-control cells (`canManageMembers`) and the 422 `INACTIVE_ORG_MEMBER` cells of the
 * assignee, follower and create forms at the end.
 *
 * Mock face: `apiFetch` plays the backend by path, so the REAL tasksApi client builds every request
 * and parses every answer — request bodies are asserted as the client serialized them. Also mocked:
 * `loadTasksContext`, `notifyTasksChanged`, `useAuth`, `useLocale` (ZH), and
 * `resolveViewerTimeZone`, which answers a fixed zone that is neither UTC nor the zone of the
 * machine running the cells. The router (both `/tasks` and `/tasks/:id` on the one TasksView, so
 * the instance is reused across route changes) and the components are real.
 */

const h_ = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  loadTasksContext: vi.fn(),
  notifyTasksChanged: vi.fn(),
  resolveViewerTimeZone: vi.fn(),
  getCurrentUserId: vi.fn(),
  /** `GET /api/tasks/:id` (the decoded id) -> the response, or a promise of it. */
  detailReply: vi.fn(),
  /** `GET /api/task-lists?…` (the query) -> the response, or a promise of it. */
  myListsReply: vi.fn(),
  /** `PATCH /api/tasks/:id` (id, serialized body) -> the response, or a promise of it. */
  patchReply: vi.fn(),
  /** `POST /api/task-lists/:id/items` (list id, serialized body) -> the response. */
  addItemReply: vi.fn(),
  /** `DELETE /api/task-lists/:id/items/:taskId` (list id, task id) -> the response. */
  removeItemReply: vi.fn(),
  /** `POST /api/tasks/:id/assignees` (id, serialized body) -> the response. */
  assigneeReply: vi.fn(),
  /** `POST /api/tasks/:id/complete` (id) -> the response. */
  completeReply: vi.fn(),
  /** FE-8: `POST /api/tasks/:id/followers` (id, serialized body) -> the response. */
  followerReply: vi.fn(),
  /** FE-8: `POST /api/tasks` (serialized body) -> the response. */
  createReply: vi.fn(),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: h_.apiFetch,
}))

vi.mock('../src/tasks/tasksContext', () => ({
  loadTasksContext: h_.loadTasksContext,
}))

vi.mock('../src/tasks/tasksBadgeBus', () => ({
  notifyTasksChanged: h_.notifyTasksChanged,
  onTasksChanged: () => () => undefined,
}))

vi.mock('../src/tasks/tasksApi', async () => {
  const actual = await vi.importActual<typeof import('../src/tasks/tasksApi')>('../src/tasks/tasksApi')
  return { ...actual, resolveViewerTimeZone: h_.resolveViewerTimeZone }
})

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({ getCurrentUserId: h_.getCurrentUserId }),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref('zh-CN'),
    isZh: ref(true),
    setLocale: vi.fn(),
  }),
}))

import TasksView from '../src/views/tasks/TasksView.vue'
import { formatViewerInstant } from '../src/tasks/tasksDateDisplay'

// ---------------------------------------------------------------------------------------------
// Fixtures and the fake backend
// ---------------------------------------------------------------------------------------------

/** The browser zone every cell sees unless it says otherwise. */
const BROWSER_ZONE = 'Pacific/Chatham'

/** A detail body in the server's shape: a timed due date whose time carries seconds, a `null`
 *  description, a canonical zone, a reminder, `version`, the abilities and `listIds`. */
function detailBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 't1',
    title: 'Plan',
    status: 'open',
    completionMode: 'all',
    createdBy: 'u1',
    dueAt: '2031-03-15T02:00:00.000Z',
    dueDate: '2031-03-15',
    dueTime: '10:00:00',
    timeZone: 'Asia/Shanghai',
    assignees: [{ userId: 'u1', completedAt: null }],
    canComplete: true,
    canReopen: true,
    parentId: null,
    depth: 0,
    children: [],
    canEdit: true,
    canDelete: true,
    canComment: true,
    version: 3,
    description: null,
    startDate: null,
    startTime: null,
    remindAt: '2031-03-15T01:30:00.000Z',
    listIds: ['tl_a'],
    ...over,
  }
}

/** No dates, no zone, no reminder. */
const BARE = Object.freeze({ dueAt: null, dueDate: null, dueTime: null, timeZone: null, remindAt: null })

/** The body main's M3 backend answers (`getTask` on main, #6229), key for key: `version` is there;
 *  none of the S4 keys, no `listIds`, no `canManageMembers`; a second assignee so the member
 *  controls have a row to act on. */
function mainM3Body(): Record<string, unknown> {
  return {
    id: 't1',
    title: 'Plan',
    status: 'open',
    completionMode: 'all',
    createdBy: 'u1',
    dueAt: '2031-03-15T02:00:00.000Z',
    dueDate: '2031-03-15',
    dueTime: '10:00:00',
    timeZone: 'Asia/Shanghai',
    assignees: [{ userId: 'u1', completedAt: null }, { userId: 'u2', completedAt: null }],
    canComplete: true,
    canReopen: true,
    followers: [],
    canEdit: true,
    canDelete: true,
    canComment: true,
    canLeave: false,
    version: 3,
    parentId: null,
    depth: 0,
    children: [],
  }
}

function taskList(id: string, name: string, myRole: 'read' | 'edit' | 'owner'): Record<string, unknown> {
  return {
    id,
    name,
    createdBy: 'u1',
    ownerId: 'u1',
    archivedAt: null,
    createdAt: '2031-01-01T00:00:00.000Z',
    updatedAt: '2031-01-01T00:00:00.000Z',
    myRole,
  }
}

/** The viewer's lists: an owner list holding the task, an edit list and a read list that do not. */
const MY_LISTS = [taskList('tl_a', 'Alpha', 'owner'), taskList('tl_b', 'Beta', 'edit'), taskList('tl_c', 'Gamma', 'read')]

function jsonResponse(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolveFn = res
  })
  return { promise, resolve: resolveFn }
}

type FetchInit = { method?: string; body?: string } | undefined

/** Requests the fake backend has no route for. Checked empty after every cell. */
let unexpected: string[] = []

async function fakeFetch(path: string, init?: FetchInit): Promise<Response> {
  const method = init?.method ?? 'GET'
  const [pathname, query = ''] = path.split('?')
  let match: RegExpExecArray | null
  if (method === 'GET' && pathname === '/api/tasks') return jsonResponse(200, { items: [], total: 0 })
  if ((match = /^\/api\/tasks\/([^/]+)$/.exec(pathname))) {
    const id = decodeURIComponent(match[1])
    if (method === 'GET') return h_.detailReply(id)
    if (method === 'PATCH') return h_.patchReply(id, init?.body)
  }
  if (method === 'GET' && /^\/api\/tasks\/[^/]+\/comments$/.test(pathname)) return jsonResponse(200, { items: [], total: 0 })
  if (method === 'GET' && pathname === '/api/task-lists') return h_.myListsReply(query)
  if (method === 'POST' && (match = /^\/api\/task-lists\/([^/]+)\/items$/.exec(pathname))) {
    return h_.addItemReply(decodeURIComponent(match[1]), init?.body)
  }
  if (method === 'DELETE' && (match = /^\/api\/task-lists\/([^/]+)\/items\/([^/]+)$/.exec(pathname))) {
    return h_.removeItemReply(decodeURIComponent(match[1]), decodeURIComponent(match[2]))
  }
  if (method === 'POST' && (match = /^\/api\/tasks\/([^/]+)\/assignees$/.exec(pathname))) {
    return h_.assigneeReply(decodeURIComponent(match[1]), init?.body)
  }
  if (method === 'POST' && (match = /^\/api\/tasks\/([^/]+)\/complete$/.exec(pathname))) {
    return h_.completeReply(decodeURIComponent(match[1]))
  }
  if (method === 'POST' && (match = /^\/api\/tasks\/([^/]+)\/followers$/.exec(pathname))) {
    return h_.followerReply(decodeURIComponent(match[1]), init?.body)
  }
  if (method === 'POST' && pathname === '/api/tasks') return h_.createReply(init?.body)
  unexpected.push(`${method} ${path}`)
  return jsonResponse(599, {})
}

function fetchCalls(): Array<[string, FetchInit]> {
  return h_.apiFetch.mock.calls as Array<[string, FetchInit]>
}

function requests(method: string, path: string): Array<[string, FetchInit]> {
  return fetchCalls().filter(([p, init]) => p === path && (init?.method ?? 'GET') === method)
}

/** The bodies of every `PATCH /api/tasks/:id`, exactly as the client serialized them. */
function patchBodies(id = 't1'): string[] {
  return requests('PATCH', `/api/tasks/${id}`).map(([, init]) => init?.body as string)
}

function detailReads(id = 't1'): number {
  return requests('GET', `/api/tasks/${id}`).length
}

/** `datetime-local` value of an instant in the local time of the machine running the cell. */
function localInput(iso: string): string {
  const date = new Date(iso)
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// ---------------------------------------------------------------------------------------------
// Mount helpers
// ---------------------------------------------------------------------------------------------

let app: VueApp<Element> | null = null
let container: HTMLDivElement | null = null
let router: Router | null = null

async function flush(cycles = 12): Promise<void> {
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
  const RootShell = defineComponent({ name: 'RootShell', render: () => h(RouterView) })
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

async function go(path: string): Promise<void> {
  await router!.push(path)
  await flush()
}

function shown(el: HTMLElement, testid: string): HTMLElement | null {
  return el.querySelector(`[data-testid="${testid}"]`)
}

function shownAll(el: HTMLElement, testid: string): HTMLElement[] {
  return Array.from(el.querySelectorAll(`[data-testid="${testid}"]`))
}

function must(el: HTMLElement, testid: string): HTMLElement {
  const found = shown(el, testid)
  expect(found, `expected [data-testid="${testid}"]`).toBeTruthy()
  return found as HTMLElement
}

function text(el: HTMLElement, testid: string): string {
  return must(el, testid).textContent?.trim() ?? ''
}

/** An editor control by its testid suffix. */
function control(el: HTMLElement, name: string): HTMLInputElement {
  return must(el, `tasks-detail-editor-${name}`) as HTMLInputElement
}

async function typeInto(el: HTMLElement, name: string, value: string): Promise<void> {
  const input = control(el, name)
  input.value = value
  input.dispatchEvent(new Event('input'))
  await flush()
}

async function changeTo(el: HTMLElement, name: string, value: string): Promise<void> {
  const input = control(el, name)
  input.value = value
  input.dispatchEvent(new Event('change'))
  await flush()
}

async function click(el: HTMLElement, testid: string): Promise<void> {
  ;(must(el, testid) as HTMLButtonElement).click()
  await flush()
}

async function save(el: HTMLElement): Promise<void> {
  await click(el, 'tasks-detail-editor-submit')
}

/** Every inline error node of the editor, so a cell can assert there is exactly one. */
function editorErrors(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll('[data-testid^="tasks-detail-editor-"][data-testid$="error"]'))
}

function disabled(el: HTMLElement, testid: string): boolean {
  return (must(el, testid) as HTMLButtonElement).disabled
}

beforeEach(() => {
  unexpected = []
  h_.apiFetch.mockReset().mockImplementation(fakeFetch)
  h_.loadTasksContext.mockReset().mockResolvedValue({ state: 'ready', orgId: 'org1' })
  h_.notifyTasksChanged.mockReset()
  h_.resolveViewerTimeZone.mockReset().mockReturnValue(BROWSER_ZONE)
  h_.getCurrentUserId.mockReset().mockResolvedValue('u1')
  h_.detailReply.mockReset().mockImplementation((id: string) => jsonResponse(200, detailBody({ id, title: id === 't1' ? 'Plan' : `Title-${id}` })))
  h_.myListsReply.mockReset().mockImplementation((query: string) => {
    const offset = Number(new URLSearchParams(query).get('offset'))
    return jsonResponse(200, { items: offset === 0 ? MY_LISTS : [], total: MY_LISTS.length })
  })
  h_.patchReply.mockReset().mockImplementation((id: string) => jsonResponse(200, { id, version: 4 }))
  h_.addItemReply.mockReset().mockImplementation((listId: string) => jsonResponse(200, { listId, taskId: 't1' }))
  h_.removeItemReply.mockReset().mockImplementation((listId: string, taskId: string) => jsonResponse(200, { listId, taskId }))
  h_.assigneeReply.mockReset().mockImplementation((id: string) =>
    jsonResponse(200, { id, status: 'open', completionMode: 'all', assignees: [{ userId: 'u1', completedAt: null }, { userId: 'u2', completedAt: null }] }),
  )
  h_.completeReply.mockReset().mockImplementation(() => jsonResponse(200, { done: true }))
  h_.followerReply.mockReset().mockImplementation((id: string) => jsonResponse(200, { id, followers: ['u5', 'u9'] }))
  h_.createReply.mockReset().mockImplementation(() => jsonResponse(200, { id: 't9', version: 1 }))
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
  router = null
  expect(unexpected, 'requests the fake backend has no route for').toEqual([])
})

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

describe('FE-4 editor — when it renders', () => {
  it('renders for an editable task with a version, its controls holding the task in the canonical form', async () => {
    const el = await mountAt('/tasks/t1')
    must(el, 'tasks-detail-editor')
    expect(control(el, 'title').value).toBe('Plan')
    expect((must(el, 'tasks-detail-editor-description') as HTMLTextAreaElement).value).toBe('')
    expect(control(el, 'due-date').value).toBe('2031-03-15')
    expect(control(el, 'due-time').value).toBe('10:00')
    expect(control(el, 'start-date').value).toBe('')
    expect(control(el, 'start-time').value).toBe('')
    expect(control(el, 'time-zone').value).toBe('Asia/Shanghai')
    expect(control(el, 'remind-at').checked).toBe(true)
    expect(control(el, 'remind-none').checked).toBe(false)
    expect(control(el, 'remind-at-input').value).toBe(localInput('2031-03-15T01:30:00.000Z'))
    expect(must(el, 'tasks-detail-editor').getAttribute('data-phase')).toBe('idle')
    expect(text(el, 'tasks-detail-editor-description-count')).toBe('0 / 20000 字')
  })

  it('does not render without a version, and the read-only rows still show the S4 fields', async () => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, (() => {
      const body = detailBody({ description: 'Notes' })
      delete body.version
      return body
    })()))
    const el = await mountAt('/tasks/t1')
    must(el, 'tasks-detail')
    expect(shown(el, 'tasks-detail-editor')).toBeNull()
    expect(text(el, 'tasks-detail-description')).toBe('描述：Notes')
  })

  it('does not render when the abilities say the viewer cannot edit', async () => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, detailBody({ canEdit: false })))
    const el = await mountAt('/tasks/t1')
    must(el, 'tasks-detail')
    expect(shown(el, 'tasks-detail-editor')).toBeNull()
  })

  it('renders when the body carries no abilities at all (an absent flag hides nothing)', async () => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, (() => {
      const body = detailBody()
      delete body.canEdit
      delete body.canDelete
      delete body.canComment
      return body
    })()))
    const el = await mountAt('/tasks/t1')
    must(el, 'tasks-detail-editor')
  })

  it("main's M3 body (version present, no S4 keys): no editor, no read-only rows, no lists section, no PATCH; the M3 sections and member controls render as on main", async () => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, mainM3Body()))
    const el = await mountAt('/tasks/t1')
    must(el, 'tasks-detail')
    expect(shown(el, 'tasks-detail-editor')).toBeNull()
    expect(shown(el, 'tasks-detail-start')).toBeNull()
    expect(shown(el, 'tasks-detail-description')).toBeNull()
    expect(shown(el, 'tasks-detail-remind')).toBeNull()
    expect(shown(el, 'tasks-detail-lists')).toBeNull()
    must(el, 'tasks-detail-subtasks-section')
    must(el, 'tasks-detail-comments')
    must(el, 'tasks-detail-delete-section')
    expect(shownAll(el, 'tasks-detail-assignee-remove')).toHaveLength(2)
    must(el, 'tasks-detail-add-assignee-form')
    must(el, 'tasks-detail-completion-mode-select')
    must(el, 'tasks-detail-add-follower-form')
    must(el, 'tasks-detail-complete-button')
    expect(patchBodies()).toEqual([])
  })
})

describe('FE-4 — the read-only rows', () => {
  it('start date with its time in the minutes form and the zone, the description as given, the reminder viewer-local', async () => {
    h_.detailReply.mockImplementation(() =>
      jsonResponse(200, detailBody({ startDate: '2031-03-10', startTime: '09:30:00', description: 'Line one\nLine two' })),
    )
    const el = await mountAt('/tasks/t1')
    expect(text(el, 'tasks-detail-start')).toBe('开始：2031-03-10 09:30（Asia/Shanghai）')
    expect(must(el, 'tasks-detail-description').textContent).toBe('描述：Line one\nLine two')
    expect(text(el, 'tasks-detail-remind')).toBe(`提醒：${formatViewerInstant('2031-03-15T01:30:00.000Z')}`)
  })

  it('the empty values: no start date, no description, no reminder', async () => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, detailBody({ ...BARE })))
    const el = await mountAt('/tasks/t1')
    expect(text(el, 'tasks-detail-start')).toBe('开始：无开始日期')
    expect(text(el, 'tasks-detail-description')).toBe('描述：无描述')
    expect(text(el, 'tasks-detail-remind')).toBe('提醒：不提醒')
  })
})

// ---------------------------------------------------------------------------------------------
// The canonical form (`HH:MM`, `null` description) and the request bodies
// ---------------------------------------------------------------------------------------------

describe('FE-4 editor — an untouched draft sends nothing', () => {
  it('a server-shaped task (time with seconds, null description) leaves the submit button disabled, and a submit sends no PATCH and notifies nothing', async () => {
    const el = await mountAt('/tasks/t1')
    expect(disabled(el, 'tasks-detail-editor-submit')).toBe(true)
    must(el, 'tasks-detail-editor-form').dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    expect(patchBodies()).toEqual([])
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
    expect(shown(el, 'tasks-detail-editor-discard')).toBeNull()
  })

  it('typing a value and then the original value back disables the submit button again', async () => {
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'New')
    expect(disabled(el, 'tasks-detail-editor-submit')).toBe(false)
    await typeInto(el, 'title', 'Plan')
    expect(disabled(el, 'tasks-detail-editor-submit')).toBe(true)
  })
})

describe('FE-4 editor — request bodies', () => {
  it('only the title changed: the body is exactly { expectedVersion, title }, with the version of the detail on screen', async () => {
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'New')
    await save(el)
    expect(patchBodies()).toEqual(['{"expectedVersion":3,"title":"New"}'])
  })

  it('the title is sent trimmed', async () => {
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', '  New  ')
    await save(el)
    expect(patchBodies()).toEqual(['{"expectedVersion":3,"title":"New"}'])
  })

  it('a changed due date carries the zone in the same body and no reminder', async () => {
    const el = await mountAt('/tasks/t1')
    await changeTo(el, 'due-date', '2031-03-16')
    await save(el)
    expect(patchBodies()).toEqual(['{"expectedVersion":3,"dueDate":"2031-03-16","timeZone":"Asia/Shanghai"}'])
  })

  it('a time control reporting seconds is sent in the minutes form', async () => {
    const el = await mountAt('/tasks/t1')
    await changeTo(el, 'due-time', '10:30:15')
    expect(control(el, 'due-time').value).toBe('10:30')
    await save(el)
    expect(patchBodies()).toEqual(['{"expectedVersion":3,"dueTime":"10:30","timeZone":"Asia/Shanghai"}'])
  })

  it('clearing the due date clears its time control and sends both as null', async () => {
    const el = await mountAt('/tasks/t1')
    await changeTo(el, 'due-date', '')
    expect(control(el, 'due-time').value).toBe('')
    await save(el)
    expect(patchBodies()).toEqual(['{"expectedVersion":3,"dueDate":null,"dueTime":null}'])
  })

  it("the first date on a task without a zone takes the browser's zone, which the body carries", async () => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, detailBody({ ...BARE })))
    const el = await mountAt('/tasks/t1')
    expect(control(el, 'time-zone').value).toBe('')
    await changeTo(el, 'start-date', '2031-03-10')
    expect(control(el, 'time-zone').value).toBe(BROWSER_ZONE)
    await save(el)
    expect(patchBodies()).toEqual([`{"expectedVersion":3,"startDate":"2031-03-10","timeZone":"${BROWSER_ZONE}"}`])
  })

  it('a date added to a task that already has a zone keeps that zone', async () => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, detailBody({ ...BARE, timeZone: 'Asia/Tokyo' })))
    const el = await mountAt('/tasks/t1')
    await changeTo(el, 'due-date', '2031-03-20')
    expect(control(el, 'time-zone').value).toBe('Asia/Tokyo')
    await save(el)
    expect(patchBodies()).toEqual(['{"expectedVersion":3,"dueDate":"2031-03-20","timeZone":"Asia/Tokyo"}'])
  })

  it('a zone change alone carries only the zone', async () => {
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'time-zone', 'Asia/Tokyo')
    await save(el)
    expect(patchBodies()).toEqual(['{"expectedVersion":3,"timeZone":"Asia/Tokyo"}'])
  })

  it('clearing the zone of a task without dates sends timeZone null', async () => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, detailBody({ ...BARE, timeZone: 'Asia/Tokyo' })))
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'time-zone', '')
    await save(el)
    expect(patchBodies()).toEqual(['{"expectedVersion":3,"timeZone":null}'])
  })

  it("the browser-zone button fills the zone without submitting", async () => {
    const el = await mountAt('/tasks/t1')
    expect(must(el, 'tasks-detail-editor-use-browser-zone').getAttribute('type')).toBe('button')
    await click(el, 'tasks-detail-editor-use-browser-zone')
    expect(control(el, 'time-zone').value).toBe(BROWSER_ZONE)
    expect(patchBodies()).toEqual([])
    await save(el)
    expect(patchBodies()).toEqual([`{"expectedVersion":3,"timeZone":"${BROWSER_ZONE}"}`])
  })

  it("clearing the description sends ''", async () => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, detailBody({ description: 'Notes' })))
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'description', '')
    await save(el)
    expect(patchBodies()).toEqual(['{"expectedVersion":3,"description":""}'])
  })

  it('choosing "no reminder" sends remindAt null', async () => {
    const el = await mountAt('/tasks/t1')
    await click(el, 'tasks-detail-editor-remind-none')
    expect(shown(el, 'tasks-detail-editor-remind-at-input')).toBeNull()
    await save(el)
    expect(patchBodies()).toEqual(['{"expectedVersion":3,"remindAt":null}'])
  })

  it('a reminder time entered in local time is sent as the ISO instant', async () => {
    const el = await mountAt('/tasks/t1')
    await changeTo(el, 'remind-at-input', '2031-03-16T09:30')
    await save(el)
    const sent = new Date(2031, 2, 16, 9, 30).toISOString()
    expect(patchBodies()).toEqual([`{"expectedVersion":3,"remindAt":"${sent}"}`])
  })

  it('a reminder added to a task without one: choose "at a set time", then the time', async () => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, detailBody({ remindAt: null })))
    const el = await mountAt('/tasks/t1')
    expect(control(el, 'remind-none').checked).toBe(true)
    await click(el, 'tasks-detail-editor-remind-at')
    expect(control(el, 'remind-at-input').value).toBe('')
    await changeTo(el, 'remind-at-input', '2031-03-14T18:00')
    await save(el)
    const sent = new Date(2031, 2, 14, 18, 0).toISOString()
    expect(patchBodies()).toEqual([`{"expectedVersion":3,"remindAt":"${sent}"}`])
  })

  it('the reminder enters a body only when touched; a changed due date shows that it does not follow', async () => {
    const el = await mountAt('/tasks/t1')
    expect(shown(el, 'tasks-detail-editor-remind-hint')).toBeNull()
    await changeTo(el, 'due-date', '2031-03-20')
    expect(text(el, 'tasks-detail-editor-remind-hint')).toBe('提醒时刻不会自动跟随截止日期')
    await save(el)
    expect(patchBodies()).toEqual(['{"expectedVersion":3,"dueDate":"2031-03-20","timeZone":"Asia/Shanghai"}'])
  })

  it('a change of the due time alone shows that note too', async () => {
    const el = await mountAt('/tasks/t1')
    await changeTo(el, 'due-time', '11:00')
    expect(text(el, 'tasks-detail-editor-remind-hint')).toBe('提醒时刻不会自动跟随截止日期')
  })

  it('touching the reminder hides that note', async () => {
    const el = await mountAt('/tasks/t1')
    await changeTo(el, 'due-date', '2031-03-20')
    await changeTo(el, 'remind-at-input', '2031-03-20T08:00')
    expect(shown(el, 'tasks-detail-editor-remind-hint')).toBeNull()
  })

  it('several fields at once, each in the canonical form', async () => {
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'New')
    await typeInto(el, 'description', 'd')
    await changeTo(el, 'start-date', '2031-03-10')
    await changeTo(el, 'start-time', '09:00')
    await save(el)
    expect(patchBodies()).toEqual([
      '{"expectedVersion":3,"title":"New","description":"d","startDate":"2031-03-10","startTime":"09:00","timeZone":"Asia/Shanghai"}',
    ])
  })

  it('the description counter counts code points', async () => {
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'description', '😀😀a')
    expect(text(el, 'tasks-detail-editor-description-count')).toBe('3 / 20000 字')
  })
})

// ---------------------------------------------------------------------------------------------
// Pre-checks: no request, the code next to its field, focus on that field
// ---------------------------------------------------------------------------------------------

describe('FE-4 editor — pre-checks', () => {
  it('a blank title: INVALID_TITLE next to the title, focus there, nothing sent', async () => {
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', '   ')
    await save(el)
    expect(patchBodies()).toEqual([])
    expect(text(el, 'tasks-detail-editor-title-error')).toBe('标题不能为空')
    expect(editorErrors(el)).toHaveLength(1)
    expect(control(el, 'title').getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(control(el, 'title'))
  })

  it('a description of 20001 code points: INVALID_DESCRIPTION, nothing sent; 20000 code points are sent', async () => {
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'description', '😀'.repeat(20001))
    expect(text(el, 'tasks-detail-editor-description-count')).toBe('20001 / 20000 字')
    await save(el)
    expect(patchBodies()).toEqual([])
    expect(text(el, 'tasks-detail-editor-description-error')).toBe('描述过长或包含无法保存的字符')
    expect(editorErrors(el)).toHaveLength(1)

    await typeInto(el, 'description', '😀'.repeat(20000))
    await save(el)
    expect(patchBodies()).toHaveLength(1)
  })

  it('a description holding U+0000: INVALID_DESCRIPTION, nothing sent', async () => {
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'description', 'a\u0000b')
    await save(el)
    expect(patchBodies()).toEqual([])
    expect(text(el, 'tasks-detail-editor-description-error')).toBe('描述过长或包含无法保存的字符')
  })

  it('a due time without a due date: INVALID_DATE next to the due time, nothing sent', async () => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, detailBody({ ...BARE, timeZone: 'Asia/Tokyo' })))
    const el = await mountAt('/tasks/t1')
    await changeTo(el, 'due-time', '10:00')
    await save(el)
    expect(patchBodies()).toEqual([])
    expect(text(el, 'tasks-detail-editor-due-time-error')).toBe('日期或时间格式不正确')
    expect(editorErrors(el)).toHaveLength(1)
    expect(document.activeElement).toBe(control(el, 'due-time'))
  })

  it('a start time without a start date: INVALID_DATE next to the start time, nothing sent', async () => {
    const el = await mountAt('/tasks/t1')
    await changeTo(el, 'start-time', '08:00')
    await save(el)
    expect(patchBodies()).toEqual([])
    expect(text(el, 'tasks-detail-editor-start-time-error')).toBe('日期或时间格式不正确')
    expect(editorErrors(el)).toHaveLength(1)
  })

  it('a dated task with its zone cleared: TIME_ZONE_REQUIRED next to the zone, focus moves to the zone input, nothing sent', async () => {
    const el = await mountAt('/tasks/t1')
    control(el, 'title').focus()
    await typeInto(el, 'time-zone', '')
    await save(el)
    expect(patchBodies()).toEqual([])
    expect(text(el, 'tasks-detail-editor-time-zone-error')).toBe('设置日期时必须指定时区')
    expect(editorErrors(el)).toHaveLength(1)
    expect(document.activeElement).toBe(control(el, 'time-zone'))
  })

  it('an unknown zone name: INVALID_TIME_ZONE next to the zone, nothing sent', async () => {
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'time-zone', 'Not/AZone')
    await save(el)
    expect(patchBodies()).toEqual([])
    expect(text(el, 'tasks-detail-editor-time-zone-error')).toBe('无效的时区')
    expect(editorErrors(el)).toHaveLength(1)
  })

  it('an offset form is not a zone name either', async () => {
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'time-zone', '+08:00')
    await save(el)
    expect(patchBodies()).toEqual([])
    expect(text(el, 'tasks-detail-editor-time-zone-error')).toBe('无效的时区')
  })

  it('a case variant of a zone name passes the pre-check', async () => {
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'time-zone', 'asia/tokyo')
    await save(el)
    expect(patchBodies()).toEqual(['{"expectedVersion":3,"timeZone":"asia/tokyo"}'])
  })

  it('"at a set time" without a time: INVALID_REMIND_AT next to the reminder, nothing sent', async () => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, detailBody({ remindAt: null })))
    const el = await mountAt('/tasks/t1')
    await click(el, 'tasks-detail-editor-remind-at')
    await save(el)
    expect(patchBodies()).toEqual([])
    expect(text(el, 'tasks-detail-editor-remind-at-error')).toBe('提醒时刻格式不正确')
    expect(editorErrors(el)).toHaveLength(1)
    expect(document.activeElement).toBe(control(el, 'remind-at-input'))
  })

  it('the title is checked first when several fields fail', async () => {
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', '')
    await typeInto(el, 'time-zone', 'Not/AZone')
    await save(el)
    expect(editorErrors(el).map((node) => node.getAttribute('data-testid'))).toEqual(['tasks-detail-editor-title-error'])
  })

  it('the next edit clears the inline error', async () => {
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', '')
    await save(el)
    must(el, 'tasks-detail-editor-title-error')
    await typeInto(el, 'title', 'N')
    expect(editorErrors(el)).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// The server's answers
// ---------------------------------------------------------------------------------------------

describe('FE-4 editor — a 422 code renders next to its field', () => {
  it.each([
    ['INVALID_TITLE', 'title', 'tasks-detail-editor-title-error', '标题不能为空'],
    ['INVALID_DESCRIPTION', 'title', 'tasks-detail-editor-description-error', '描述过长或包含无法保存的字符'],
    ['INVALID_TIME_ZONE', 'title', 'tasks-detail-editor-time-zone-error', '无效的时区'],
    ['TIME_ZONE_REQUIRED', 'title', 'tasks-detail-editor-time-zone-error', '设置日期时必须指定时区'],
    ['INVALID_REMIND_AT', 'title', 'tasks-detail-editor-remind-at-error', '提醒时刻格式不正确'],
    ['INVALID_DATE', 'due date', 'tasks-detail-editor-due-date-error', '日期或时间格式不正确'],
    ['INVALID_DATE', 'due time', 'tasks-detail-editor-due-time-error', '日期或时间格式不正确'],
    ['INVALID_DATE', 'start date', 'tasks-detail-editor-start-date-error', '日期或时间格式不正确'],
    ['INVALID_DATE', 'zone', 'tasks-detail-editor-due-date-error', '日期或时间格式不正确'],
    ['NOT_IN_THE_CONTRACT', 'title', 'tasks-detail-editor-error', '操作失败，请稍后重试'],
  ])('%s (the request changed the %s) -> %s', async (code, changed, testid, copy) => {
    h_.patchReply.mockImplementation(() => jsonResponse(422, { error: { code } }))
    const el = await mountAt('/tasks/t1')
    if (changed === 'title') await typeInto(el, 'title', 'New')
    if (changed === 'due date') await changeTo(el, 'due-date', '2031-03-16')
    if (changed === 'due time') await changeTo(el, 'due-time', '11:00')
    if (changed === 'start date') await changeTo(el, 'start-date', '2031-03-10')
    if (changed === 'zone') await typeInto(el, 'time-zone', 'America/New_York')
    await save(el)
    expect(patchBodies()).toHaveLength(1)
    expect(text(el, testid)).toBe(copy)
    expect(editorErrors(el)).toHaveLength(1)
    expect(must(el, testid).getAttribute('role')).toBe('alert')
    expect(shown(el, 'tasks-action-error')).toBeNull()
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
    expect(detailReads()).toBe(1)
    expect(must(el, 'tasks-detail-editor').getAttribute('data-phase')).toBe('idle')
    // The draft is kept: the submit button is still enabled for another try.
    expect(disabled(el, 'tasks-detail-editor-submit')).toBe(false)
  })

  it('INVALID_VERSION takes the page banner with its own copy, not a field', async () => {
    h_.patchReply.mockImplementation(() => jsonResponse(422, { error: { code: 'INVALID_VERSION' } }))
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'New')
    await save(el)
    expect(text(el, 'tasks-action-error')).toBe('版本信息缺失，请刷新页面')
    expect(editorErrors(el)).toEqual([])
  })

  it('a 409 code other than VERSION_CONFLICT renders next to the submit button and does not reload', async () => {
    h_.patchReply.mockImplementation(() => jsonResponse(409, { error: { code: 'TASK_BUSY' } }))
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'New')
    await save(el)
    expect(text(el, 'tasks-detail-editor-error')).toBe('任务正在被修改，请稍后重试')
    expect(detailReads()).toBe(1)
    expect(shown(el, 'tasks-detail-editor-conflict')).toBeNull()
  })
})

describe('FE-4 editor — other failures use the shared detail handling', () => {
  it.each([
    [403, { error: { code: 'FORBIDDEN' } }, '您没有权限修改此任务'],
    [404, { error: { code: 'NOT_FOUND' } }, '操作失败，请稍后重试'],
    [500, { error: { code: 'INTERNAL' } }, '操作失败，请稍后重试'],
  ])('HTTP %s -> the page banner, the draft kept', async (status, body, copy) => {
    h_.patchReply.mockImplementation(() => jsonResponse(status, body))
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'New')
    await save(el)
    expect(text(el, 'tasks-action-error')).toBe(copy)
    expect(control(el, 'title').value).toBe('New')
    expect(editorErrors(el)).toEqual([])
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
  })

  it('a transport failure -> the page banner', async () => {
    h_.patchReply.mockImplementation(() => Promise.reject(new Error('offline')))
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'New')
    await save(el)
    expect(text(el, 'tasks-action-error')).toBe('操作失败，请稍后重试')
  })

  it('422 ORG_MISSING -> the org guidance block', async () => {
    h_.patchReply.mockImplementation(() => jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'New')
    await save(el)
    must(el, 'tasks-view-org-missing')
    expect(shown(el, 'tasks-detail')).toBeNull()
  })
})

describe('FE-4 editor — a saved edit', () => {
  it('reloads the task, starts a fresh draft from the reloaded values, and does not notify the badge for a title change', async () => {
    let reads = 0
    h_.detailReply.mockImplementation(() => {
      reads += 1
      return jsonResponse(200, detailBody(reads === 1 ? {} : { title: 'New', version: 4 }))
    })
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'New')
    await save(el)
    expect(detailReads()).toBe(2)
    expect(control(el, 'title').value).toBe('New')
    expect(disabled(el, 'tasks-detail-editor-submit')).toBe(true)
    expect(must(el, 'tasks-detail-editor').getAttribute('data-phase')).toBe('idle')
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
    expect(shown(el, 'tasks-detail-editor-server-updated')).toBeNull()
  })

  it.each([
    ['the due date', async (el: HTMLElement) => changeTo(el, 'due-date', '2031-03-16'), 1],
    ['the due time', async (el: HTMLElement) => changeTo(el, 'due-time', '11:00'), 1],
    ['the zone', async (el: HTMLElement) => typeInto(el, 'time-zone', 'Asia/Tokyo'), 1],
    ['the start date (the body carries the zone with it)', async (el: HTMLElement) => changeTo(el, 'start-date', '2031-03-10'), 1],
    ['the description', async (el: HTMLElement) => typeInto(el, 'description', 'd'), 0],
    ['the reminder', async (el: HTMLElement) => click(el, 'tasks-detail-editor-remind-none'), 0],
  ])('notifies the badge when the patch carries the due date, its time or the zone — %s', async (_label, edit, times) => {
    const el = await mountAt('/tasks/t1')
    await edit(el)
    await save(el)
    expect(patchBodies()).toHaveLength(1)
    expect(h_.notifyTasksChanged).toHaveBeenCalledTimes(times)
  })

  it('the next save uses the reloaded version', async () => {
    let reads = 0
    h_.detailReply.mockImplementation(() => {
      reads += 1
      return jsonResponse(200, detailBody(reads === 1 ? {} : { title: 'New', version: 4 }))
    })
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'New')
    await save(el)
    await typeInto(el, 'title', 'Newer')
    await save(el)
    expect(patchBodies()).toEqual(['{"expectedVersion":3,"title":"New"}', '{"expectedVersion":4,"title":"Newer"}'])
  })
})

// ---------------------------------------------------------------------------------------------
// 409 VERSION_CONFLICT (design §7.3)
// ---------------------------------------------------------------------------------------------

describe('FE-4 editor — 409 VERSION_CONFLICT', () => {
  function conflictOnce(currentVersion?: unknown): void {
    h_.patchReply.mockImplementationOnce(() =>
      jsonResponse(409, currentVersion === undefined ? { error: { code: 'VERSION_CONFLICT' } } : { error: { code: 'VERSION_CONFLICT' }, currentVersion }),
    )
  }

  it('reloads the task, keeps the draft and shows the version from the 409 body', async () => {
    conflictOnce(4)
    let reads = 0
    h_.detailReply.mockImplementation(() => {
      reads += 1
      return jsonResponse(200, detailBody(reads === 1 ? {} : { version: 4 }))
    })
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'Mine')
    await save(el)
    expect(detailReads()).toBe(2)
    expect(text(el, 'tasks-detail-editor-conflict')).toBe('任务已被他人修改（当前版本 4），已载入最新内容，请核对后再保存')
    expect(must(el, 'tasks-detail-editor-conflict').getAttribute('role')).toBe('alert')
    expect(must(el, 'tasks-detail-editor').getAttribute('data-phase')).toBe('conflict')
    expect(control(el, 'title').value).toBe('Mine')
    expect(shown(el, 'tasks-detail-editor-server-updated')).toBeNull()
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
    must(el, 'tasks-detail-editor-discard')
  })

  it('the next save uses the RELOADED version, not the 409 body\'s currentVersion', async () => {
    conflictOnce(4)
    let reads = 0
    h_.detailReply.mockImplementation(() => {
      reads += 1
      // Someone saved once more between the 409 and the reload.
      return jsonResponse(200, detailBody(reads === 1 ? {} : { version: 5 }))
    })
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'Mine')
    await save(el)
    expect(text(el, 'tasks-detail-editor-conflict')).toContain('当前版本 4')
    await save(el)
    expect(patchBodies()).toEqual(['{"expectedVersion":3,"title":"Mine"}', '{"expectedVersion":5,"title":"Mine"}'])
    expect(shown(el, 'tasks-detail-editor-conflict')).toBeNull()
  })

  it("keeps the fields the viewer changed and takes the reloaded values for the others ([fe-19]), so the next save does not write back over someone else's change", async () => {
    conflictOnce(4)
    let reads = 0
    h_.detailReply.mockImplementation(() => {
      reads += 1
      return jsonResponse(200, detailBody(reads === 1 ? {} : { version: 4, description: 'Theirs', timeZone: 'Asia/Tokyo' }))
    })
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'Mine')
    await save(el)
    expect(control(el, 'title').value).toBe('Mine')
    expect((must(el, 'tasks-detail-editor-description') as HTMLTextAreaElement).value).toBe('Theirs')
    expect(control(el, 'time-zone').value).toBe('Asia/Tokyo')
    await save(el)
    expect(patchBodies()[1]).toBe('{"expectedVersion":4,"title":"Mine"}')
  })

  it("[fe-19] a reminder touched and left at its value takes the reloaded one; the next save does not send the old reminder over it", async () => {
    conflictOnce(4)
    let reads = 0
    h_.detailReply.mockImplementation(() => {
      reads += 1
      return jsonResponse(200, detailBody(reads === 1 ? {} : { version: 4, remindAt: '2031-03-16T01:30:00.000Z' }))
    })
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'Mine')
    // Touched: the same time entered again.
    await changeTo(el, 'remind-at-input', localInput('2031-03-15T01:30:00.000Z'))
    await save(el)
    expect(patchBodies()).toEqual(['{"expectedVersion":3,"title":"Mine"}'])
    must(el, 'tasks-detail-editor-conflict')
    expect(control(el, 'remind-at-input').value).toBe(localInput('2031-03-16T01:30:00.000Z'))
    await save(el)
    expect(patchBodies()).toEqual(['{"expectedVersion":3,"title":"Mine"}', '{"expectedVersion":4,"title":"Mine"}'])
  })

  it('[fe-19] after that reload the reminder counts as untouched again: a due-date change shows that it does not follow', async () => {
    conflictOnce(4)
    let reads = 0
    h_.detailReply.mockImplementation(() => {
      reads += 1
      return jsonResponse(200, detailBody(reads === 1 ? {} : { version: 4, remindAt: '2031-03-16T01:30:00.000Z' }))
    })
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'Mine')
    await changeTo(el, 'remind-at-input', localInput('2031-03-15T01:30:00.000Z'))
    await save(el)
    must(el, 'tasks-detail-editor-conflict')
    await changeTo(el, 'due-date', '2031-03-20')
    expect(text(el, 'tasks-detail-editor-remind-hint')).toBe('提醒时刻不会自动跟随截止日期')
  })

  it("[fe-19] across two reloads: a reload after the 409 rebases on the 409 reload, so the first reload's values never count as the viewer's", async () => {
    let reads = 0
    h_.detailReply.mockImplementation(() => {
      reads += 1
      if (reads === 1) return jsonResponse(200, detailBody())
      if (reads === 2) return jsonResponse(200, detailBody({ version: 4, title: 'Theirs1' }))
      return jsonResponse(200, detailBody({ version: 5, title: 'Theirs2' }))
    })
    let patches = 0
    h_.patchReply.mockImplementation((id: string) => {
      patches += 1
      return patches === 1 ? jsonResponse(409, { error: { code: 'VERSION_CONFLICT' }, currentVersion: 4 }) : jsonResponse(200, { id, version: 6 })
    })
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'description', 'Mine')
    await save(el)
    expect(must(el, 'tasks-detail-editor').getAttribute('data-phase')).toBe('conflict')
    expect(control(el, 'title').value).toBe('Theirs1')
    // Any other detail action reloads the task again; someone renamed it in between.
    await click(el, 'tasks-detail-complete-button')
    expect(control(el, 'title').value).toBe('Theirs2')
    await save(el)
    expect(patchBodies()).toEqual(['{"expectedVersion":3,"description":"Mine"}', '{"expectedVersion":5,"description":"Mine"}'])
  })

  it('a 409 body without a usable currentVersion shows the message without a version', async () => {
    conflictOnce('4')
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'Mine')
    await save(el)
    expect(text(el, 'tasks-detail-editor-conflict')).toBe('任务已被他人修改，已载入最新内容，请核对后再保存')
    expect(detailReads()).toBe(2)
  })

  it('a failed reload after the 409 shows the detail error state; nothing is sent again', async () => {
    conflictOnce(4)
    let reads = 0
    h_.detailReply.mockImplementation(() => {
      reads += 1
      return reads === 1 ? jsonResponse(200, detailBody()) : jsonResponse(500, {})
    })
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'Mine')
    await save(el)
    expect(text(el, 'tasks-detail-error')).toBe('加载任务详情失败，请稍后重试')
    expect(shown(el, 'tasks-detail-editor')).toBeNull()
    expect(detailReads()).toBe(2)
    expect(patchBodies()).toHaveLength(1)
  })

  it('"discard my changes" puts the task\'s current values back and leaves the conflict state', async () => {
    conflictOnce(4)
    let reads = 0
    h_.detailReply.mockImplementation(() => {
      reads += 1
      return jsonResponse(200, detailBody(reads === 1 ? {} : { version: 4, title: 'Theirs' }))
    })
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'Mine')
    await save(el)
    expect(must(el, 'tasks-detail-editor-discard').getAttribute('type')).toBe('button')
    await click(el, 'tasks-detail-editor-discard')
    expect(control(el, 'title').value).toBe('Theirs')
    expect(shown(el, 'tasks-detail-editor-conflict')).toBeNull()
    expect(must(el, 'tasks-detail-editor').getAttribute('data-phase')).toBe('idle')
    expect(disabled(el, 'tasks-detail-editor-submit')).toBe(true)
    expect(shown(el, 'tasks-detail-editor-discard')).toBeNull()
    expect(patchBodies()).toHaveLength(1)
  })

  it('[fe-50] "discard my changes" takes its own button away, so focus moves to the editor heading', async () => {
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'Mine')
    const discard = must(el, 'tasks-detail-editor-discard')
    discard.focus()
    discard.click()
    await flush()
    expect(shown(el, 'tasks-detail-editor-discard')).toBeNull()
    const heading = must(el, 'tasks-detail-editor-heading')
    expect(heading.textContent?.trim()).toBe('编辑任务')
    expect(document.activeElement).toBe(heading)
  })

  it('a 422 on the save after the conflict leaves the conflict state for the field error', async () => {
    conflictOnce(4)
    h_.patchReply.mockImplementationOnce(() => jsonResponse(422, { error: { code: 'INVALID_TITLE' } }))
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'Mine')
    await save(el)
    await save(el)
    expect(shown(el, 'tasks-detail-editor-conflict')).toBeNull()
    expect(text(el, 'tasks-detail-editor-title-error')).toBe('标题不能为空')
    expect(must(el, 'tasks-detail-editor').getAttribute('data-phase')).toBe('idle')
  })
})

// ---------------------------------------------------------------------------------------------
// The draft across reloads and route edges
// ---------------------------------------------------------------------------------------------

describe('FE-4 editor — the draft across reloads and route edges', () => {
  async function addAssignee(el: HTMLElement): Promise<void> {
    const input = must(el, 'tasks-detail-add-assignee-input') as HTMLInputElement
    input.value = 'u2'
    input.dispatchEvent(new Event('input'))
    await flush()
    await click(el, 'tasks-detail-add-assignee-submit')
  }

  it('an unsaved draft survives an M3 action\'s reload, and the viewer is told the server changed', async () => {
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'Mine')
    await addAssignee(el)
    expect(requests('POST', '/api/tasks/t1/assignees')).toHaveLength(1)
    expect(detailReads()).toBe(2)
    expect(control(el, 'title').value).toBe('Mine')
    expect(text(el, 'tasks-detail-editor-server-updated')).toBe('服务端已更新；你未保存的修改仍保留')
    expect(must(el, 'tasks-detail-editor-server-updated').getAttribute('role')).toBe('status')
    await save(el)
    expect(patchBodies()).toEqual(['{"expectedVersion":3,"title":"Mine"}'])
  })

  it('across that reload, a field the viewer did not change takes the reloaded value', async () => {
    let reads = 0
    h_.detailReply.mockImplementation(() => {
      reads += 1
      return jsonResponse(200, detailBody(reads === 1 ? {} : { version: 4, startDate: '2031-03-01' }))
    })
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'Mine')
    await addAssignee(el)
    expect(control(el, 'start-date').value).toBe('2031-03-01')
    await save(el)
    expect(patchBodies()).toEqual(['{"expectedVersion":4,"title":"Mine"}'])
  })

  it("[fe-19] across two such reloads the second rebases on the first, so the first reload's values never count as the viewer's", async () => {
    let reads = 0
    h_.detailReply.mockImplementation(() => {
      reads += 1
      if (reads === 1) return jsonResponse(200, detailBody())
      if (reads === 2) return jsonResponse(200, detailBody({ version: 4, title: 'Theirs1' }))
      return jsonResponse(200, detailBody({ version: 5, title: 'Theirs2' }))
    })
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'description', 'Mine')
    await addAssignee(el)
    expect(control(el, 'title').value).toBe('Theirs1')
    await click(el, 'tasks-detail-complete-button')
    expect(control(el, 'title').value).toBe('Theirs2')
    await save(el)
    expect(patchBodies()).toEqual(['{"expectedVersion":5,"description":"Mine"}'])
  })

  it('a reload that brings the server to the draft leaves nothing unsaved: no notice, nothing to save', async () => {
    let reads = 0
    h_.detailReply.mockImplementation(() => {
      reads += 1
      return jsonResponse(200, detailBody(reads === 1 ? {} : { version: 4, title: 'Mine' }))
    })
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'Mine')
    await addAssignee(el)
    expect(detailReads()).toBe(2)
    expect(control(el, 'title').value).toBe('Mine')
    expect(shown(el, 'tasks-detail-editor-server-updated')).toBeNull()
    expect(disabled(el, 'tasks-detail-editor-submit')).toBe(true)
  })

  it('a clean draft takes the reloaded values with no notice', async () => {
    let reads = 0
    h_.detailReply.mockImplementation(() => {
      reads += 1
      return jsonResponse(200, detailBody(reads === 1 ? {} : { version: 4, title: 'Renamed' }))
    })
    const el = await mountAt('/tasks/t1')
    await addAssignee(el)
    expect(control(el, 'title').value).toBe('Renamed')
    expect(shown(el, 'tasks-detail-editor-server-updated')).toBeNull()
    expect(disabled(el, 'tasks-detail-editor-submit')).toBe(true)
  })

  it('a route edge drops the draft: another task shows its own values, and coming back shows the server values', async () => {
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'Mine')
    await go('/tasks/t2')
    expect(control(el, 'title').value).toBe('Title-t2')
    expect(shown(el, 'tasks-detail-editor-server-updated')).toBeNull()
    await go('/tasks/t1')
    expect(control(el, 'title').value).toBe('Plan')
    expect(disabled(el, 'tasks-detail-editor-submit')).toBe(true)
  })

  it('a route edge drops a conflict state and an inline error', async () => {
    h_.patchReply.mockImplementationOnce(() => jsonResponse(409, { error: { code: 'VERSION_CONFLICT' }, currentVersion: 4 }))
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'Mine')
    await save(el)
    must(el, 'tasks-detail-editor-conflict')
    await go('/tasks/t2')
    expect(shown(el, 'tasks-detail-editor-conflict')).toBeNull()
    expect(must(el, 'tasks-detail-editor').getAttribute('data-phase')).toBe('idle')
    await typeInto(el, 'title', '')
    await save(el)
    must(el, 'tasks-detail-editor-title-error')
    await go('/tasks/t1')
    expect(editorErrors(el)).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// One action at a time across the whole detail page
// ---------------------------------------------------------------------------------------------

describe('FE-4 — one detail action at a time', () => {
  it('while the editor saves, the M3 actions and the lists section are disabled, and a second submit sends nothing', async () => {
    const pending = deferred<Response>()
    h_.patchReply.mockImplementationOnce(() => pending.promise)
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'Mine')
    await save(el)
    expect(must(el, 'tasks-detail-editor').getAttribute('data-phase')).toBe('pending')
    expect(disabled(el, 'tasks-detail-complete-button')).toBe(true)
    expect(disabled(el, 'tasks-detail-delete')).toBe(true)
    expect(disabled(el, 'tasks-detail-lists-remove')).toBe(true)
    expect(disabled(el, 'tasks-detail-lists-add-submit')).toBe(true)
    expect(disabled(el, 'tasks-detail-editor-submit')).toBe(true)
    expect(control(el, 'title').disabled).toBe(true)
    must(el, 'tasks-detail-editor-form').dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    expect(patchBodies()).toHaveLength(1)

    pending.resolve(jsonResponse(200, { id: 't1', version: 4 }))
    await flush()
    expect(disabled(el, 'tasks-detail-complete-button')).toBe(false)
  })

  it('while an M3 action is in flight, the editor and the lists section are disabled, and their submits send nothing', async () => {
    const pending = deferred<Response>()
    h_.completeReply.mockImplementationOnce(() => pending.promise)
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'Mine')
    const select = must(el, 'tasks-detail-lists-add-select') as HTMLSelectElement
    select.value = 'tl_b'
    select.dispatchEvent(new Event('change'))
    await flush()
    await click(el, 'tasks-detail-complete-button')
    expect(disabled(el, 'tasks-detail-editor-submit')).toBe(true)
    expect(control(el, 'title').disabled).toBe(true)
    expect(control(el, 'time-zone').disabled).toBe(true)
    expect(disabled(el, 'tasks-detail-editor-use-browser-zone')).toBe(true)
    expect(disabled(el, 'tasks-detail-lists-remove')).toBe(true)
    expect(disabled(el, 'tasks-detail-lists-add-submit')).toBe(true)
    must(el, 'tasks-detail-editor-form').dispatchEvent(new Event('submit', { cancelable: true }))
    must(el, 'tasks-detail-lists-add-form').dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    expect(patchBodies()).toEqual([])
    expect(requests('POST', '/api/task-lists/tl_b/items')).toEqual([])

    pending.resolve(jsonResponse(200, { done: true }))
    await flush()
    expect(disabled(el, 'tasks-detail-editor-submit')).toBe(false)
  })

  it('while a task is being added to a list, the M3 actions and the editor are disabled', async () => {
    const pending = deferred<Response>()
    h_.addItemReply.mockImplementationOnce(() => pending.promise)
    const el = await mountAt('/tasks/t1')
    const select = must(el, 'tasks-detail-lists-add-select') as HTMLSelectElement
    select.value = 'tl_b'
    select.dispatchEvent(new Event('change'))
    await flush()
    await click(el, 'tasks-detail-lists-add-submit')
    expect(requests('POST', '/api/task-lists/tl_b/items')).toHaveLength(1)
    expect(disabled(el, 'tasks-detail-complete-button')).toBe(true)
    expect(disabled(el, 'tasks-detail-delete')).toBe(true)
    expect(control(el, 'title').disabled).toBe(true)
    expect(disabled(el, 'tasks-detail-lists-remove')).toBe(true)

    pending.resolve(jsonResponse(200, { listId: 'tl_b', taskId: 't1' }))
    await flush()
    expect(disabled(el, 'tasks-detail-complete-button')).toBe(false)
  })

  it('while a task is being removed from a list, the M3 actions, the editor and the picker are disabled', async () => {
    const pending = deferred<Response>()
    h_.removeItemReply.mockImplementationOnce(() => pending.promise)
    const el = await mountAt('/tasks/t1')
    await click(el, 'tasks-detail-lists-remove')
    await click(el, 'tasks-detail-lists-remove-confirm-yes')
    expect(requests('DELETE', '/api/task-lists/tl_a/items/t1')).toHaveLength(1)
    expect(disabled(el, 'tasks-detail-complete-button')).toBe(true)
    expect(disabled(el, 'tasks-detail-delete')).toBe(true)
    expect(disabled(el, 'tasks-detail-editor-submit')).toBe(true)
    expect(control(el, 'title').disabled).toBe(true)
    expect(disabled(el, 'tasks-detail-lists-add-submit')).toBe(true)
    expect(disabled(el, 'tasks-detail-lists-remove-confirm-yes')).toBe(true)

    pending.resolve(jsonResponse(200, { listId: 'tl_a', taskId: 't1' }))
    await flush()
    expect(disabled(el, 'tasks-detail-complete-button')).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// Results that land after a route edge
// ---------------------------------------------------------------------------------------------

describe('FE-4 — late results', () => {
  it('a save answered after moving to another task touches nothing there; a due-date change still notifies the badge', async () => {
    const pending = deferred<Response>()
    h_.patchReply.mockImplementationOnce(() => pending.promise)
    const el = await mountAt('/tasks/t1')
    await changeTo(el, 'due-date', '2031-03-16')
    await save(el)
    await go('/tasks/t2')
    pending.resolve(jsonResponse(200, { id: 't1', version: 4 }))
    await flush()
    expect(h_.notifyTasksChanged).toHaveBeenCalledTimes(1)
    expect(detailReads('t1')).toBe(1)
    expect(control(el, 'title').value).toBe('Title-t2')
    expect(control(el, 'due-date').value).toBe('2031-03-15')
    expect(disabled(el, 'tasks-detail-complete-button')).toBe(false)
  })

  it('a title-only save answered late does not notify', async () => {
    const pending = deferred<Response>()
    h_.patchReply.mockImplementationOnce(() => pending.promise)
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'Mine')
    await save(el)
    await go('/tasks/t2')
    pending.resolve(jsonResponse(200, { id: 't1', version: 4 }))
    await flush()
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
  })

  it('leave and come back to the same task: a late 409 neither reloads nor shows a conflict', async () => {
    const pending = deferred<Response>()
    h_.patchReply.mockImplementationOnce(() => pending.promise)
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'Mine')
    await save(el)
    await go('/tasks')
    await go('/tasks/t1')
    expect(detailReads()).toBe(2)
    pending.resolve(jsonResponse(409, { error: { code: 'VERSION_CONFLICT' }, currentVersion: 4 }))
    await flush()
    expect(detailReads()).toBe(2)
    expect(shown(el, 'tasks-detail-editor-conflict')).toBeNull()
    expect(control(el, 'title').value).toBe('Plan')
  })

  it('leave and come back to the same task: a late 422 paints no field error', async () => {
    const pending = deferred<Response>()
    h_.patchReply.mockImplementationOnce(() => pending.promise)
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'Mine')
    await save(el)
    await go('/tasks')
    await go('/tasks/t1')
    pending.resolve(jsonResponse(422, { error: { code: 'INVALID_TITLE' } }))
    await flush()
    expect(editorErrors(el)).toEqual([])
    expect(shown(el, 'tasks-action-error')).toBeNull()
  })

  it('leave and come back while the reload after a 409 is in flight: the page shown afterwards is not in conflict', async () => {
    h_.patchReply.mockImplementationOnce(() => jsonResponse(409, { error: { code: 'VERSION_CONFLICT' }, currentVersion: 4 }))
    const slowReload = deferred<Response>()
    let reads = 0
    h_.detailReply.mockImplementation(() => {
      reads += 1
      return reads === 2 ? slowReload.promise : jsonResponse(200, detailBody())
    })
    const el = await mountAt('/tasks/t1')
    await typeInto(el, 'title', 'Mine')
    await save(el)
    await go('/tasks')
    await go('/tasks/t1')
    expect(must(el, 'tasks-detail-editor').getAttribute('data-phase')).toBe('idle')
    slowReload.resolve(jsonResponse(200, detailBody({ version: 4 })))
    await flush()
    expect(must(el, 'tasks-detail-editor').getAttribute('data-phase')).toBe('idle')
    expect(shown(el, 'tasks-detail-editor-conflict')).toBeNull()
    expect(control(el, 'title').value).toBe('Plan')
  })

  it('an add answered after moving to another task reloads nothing and paints no error', async () => {
    const pending = deferred<Response>()
    h_.addItemReply.mockImplementationOnce(() => pending.promise)
    const el = await mountAt('/tasks/t1')
    const select = must(el, 'tasks-detail-lists-add-select') as HTMLSelectElement
    select.value = 'tl_b'
    select.dispatchEvent(new Event('change'))
    await flush()
    await click(el, 'tasks-detail-lists-add-submit')
    await go('/tasks/t2')
    pending.resolve(jsonResponse(404, { error: { code: 'NOT_FOUND' } }))
    await flush()
    expect(detailReads('t1')).toBe(1)
    expect(shown(el, 'tasks-detail-lists-error')).toBeNull()
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
  })

  async function removeFromAlphaThenMoveToT2(el: HTMLElement): Promise<void> {
    await click(el, 'tasks-detail-lists-remove')
    await click(el, 'tasks-detail-lists-remove-confirm-yes')
    expect(requests('DELETE', '/api/task-lists/tl_a/items/t1')).toHaveLength(1)
    await go('/tasks/t2')
  }

  it('a remove answered 404 after moving to another task paints no banner there', async () => {
    const pending = deferred<Response>()
    h_.removeItemReply.mockImplementationOnce(() => pending.promise)
    const el = await mountAt('/tasks/t1')
    await removeFromAlphaThenMoveToT2(el)
    pending.resolve(jsonResponse(404, { error: { code: 'NOT_FOUND' } }))
    await flush()
    expect(shown(el, 'tasks-action-error')).toBeNull()
    expect(control(el, 'title').value).toBe('Title-t2')
  })

  it('a remove answered ok after moving to another task does not reload the task it came from', async () => {
    const pending = deferred<Response>()
    h_.removeItemReply.mockImplementationOnce(() => pending.promise)
    const el = await mountAt('/tasks/t1')
    await removeFromAlphaThenMoveToT2(el)
    pending.resolve(jsonResponse(200, { listId: 'tl_a', taskId: 't1' }))
    await flush()
    expect(detailReads('t1')).toBe(1)
    expect(control(el, 'title').value).toBe('Title-t2')
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------------------------
// The lists section
// ---------------------------------------------------------------------------------------------

describe('FE-4 lists section', () => {
  function listRows(el: HTMLElement): Array<{ id: string | null; name: string; notMember: boolean }> {
    return shownAll(el, 'tasks-detail-lists-item').map((row) => ({
      id: row.getAttribute('data-list-id'),
      name: row.querySelector('[data-testid="tasks-detail-lists-item-name"]')?.textContent ?? '',
      notMember: row.querySelector('[data-testid="tasks-detail-lists-not-member"]') !== null,
    }))
  }

  function pickerOptions(el: HTMLElement): string[] {
    return Array.from((must(el, 'tasks-detail-lists-add-select') as HTMLSelectElement).options).map((option) => option.value)
  }

  async function pick(el: HTMLElement, listId: string): Promise<void> {
    const select = must(el, 'tasks-detail-lists-add-select') as HTMLSelectElement
    select.value = listId
    select.dispatchEvent(new Event('change'))
    await flush()
  }

  it('is absent when the detail carries no listIds, and the viewer\'s lists are still read once on entry', async () => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, (() => {
      const body = detailBody()
      delete body.listIds
      return body
    })()))
    const el = await mountAt('/tasks/t1')
    must(el, 'tasks-detail-editor')
    expect(shown(el, 'tasks-detail-lists')).toBeNull()
    expect(requests('GET', '/api/task-lists?includeArchived=true&limit=100&offset=0')).toHaveLength(1)
  })

  it('names the lists that are mine and marks an id that is not one of them', async () => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, detailBody({ listIds: ['tl_a', 'tl_x'] })))
    const el = await mountAt('/tasks/t1')
    expect(listRows(el)).toEqual([
      { id: 'tl_a', name: 'Alpha', notMember: false },
      { id: 'tl_x', name: 'tl_x', notMember: true },
    ])
    expect(text(el, 'tasks-detail-lists-not-member')).toBe('（你不是成员）')
  })

  it('an empty listIds says the task is in no list', async () => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, detailBody({ listIds: [] })))
    const el = await mountAt('/tasks/t1')
    expect(text(el, 'tasks-detail-lists-empty')).toBe('尚未加入任何清单')
    expect(shownAll(el, 'tasks-detail-lists-item')).toEqual([])
  })

  it('while my lists are loading, ids show as they are and the picker waits', async () => {
    const pending = deferred<Response>()
    h_.myListsReply.mockImplementation(() => pending.promise)
    h_.detailReply.mockImplementation(() => jsonResponse(200, detailBody({ listIds: ['tl_a', 'tl_x'] })))
    const el = await mountAt('/tasks/t1')
    expect(listRows(el)).toEqual([
      { id: 'tl_a', name: 'tl_a', notMember: false },
      { id: 'tl_x', name: 'tl_x', notMember: false },
    ])
    must(el, 'tasks-detail-lists-mine-loading')
    expect(shown(el, 'tasks-detail-lists-add-form')).toBeNull()
    pending.resolve(jsonResponse(200, { items: MY_LISTS, total: MY_LISTS.length }))
    await flush()
    expect(listRows(el)[0]).toEqual({ id: 'tl_a', name: 'Alpha', notMember: false })
    must(el, 'tasks-detail-lists-add-form')
  })

  it('when my lists cannot be read, ids show as they are, a note says why, and there is no picker', async () => {
    h_.myListsReply.mockImplementation(() => jsonResponse(500, {}))
    h_.detailReply.mockImplementation(() => jsonResponse(200, detailBody({ listIds: ['tl_a', 'tl_x'] })))
    const el = await mountAt('/tasks/t1')
    expect(listRows(el).map((row) => [row.name, row.notMember])).toEqual([['tl_a', false], ['tl_x', false]])
    expect(text(el, 'tasks-detail-lists-mine-unavailable')).toBe('暂时无法读取你的清单，清单以 ID 显示')
    expect(shown(el, 'tasks-detail-lists-add-form')).toBeNull()
    must(el, 'tasks-detail')
  })

  it('when my lists are cut short at the page bound, an unknown id is not marked as not mine', async () => {
    h_.myListsReply.mockImplementation((query: string) => {
      const offset = Number(new URLSearchParams(query).get('offset'))
      return jsonResponse(200, { items: offset === 0 ? MY_LISTS : [], total: 3000 })
    })
    h_.detailReply.mockImplementation(() => jsonResponse(200, detailBody({ listIds: ['tl_a', 'tl_x'] })))
    const el = await mountAt('/tasks/t1')
    expect(listRows(el)).toEqual([
      { id: 'tl_a', name: 'Alpha', notMember: false },
      { id: 'tl_x', name: 'tl_x', notMember: false },
    ])
  })

  it('reads every page of my lists, archived ones included', async () => {
    const second = taskList('tl_z', 'Zeta', 'edit')
    h_.myListsReply.mockImplementation((query: string) => {
      const offset = Number(new URLSearchParams(query).get('offset'))
      return jsonResponse(200, { items: offset === 0 ? MY_LISTS : offset === 3 ? [second] : [], total: 4 })
    })
    const el = await mountAt('/tasks/t1')
    expect(requests('GET', '/api/task-lists?includeArchived=true&limit=100&offset=0')).toHaveLength(1)
    expect(requests('GET', '/api/task-lists?includeArchived=true&limit=100&offset=3')).toHaveLength(1)
    expect(pickerOptions(el)).toEqual(['', 'tl_b', 'tl_z'])
  })

  it('the picker offers only my edit / owner lists that do not hold the task yet', async () => {
    const el = await mountAt('/tasks/t1')
    expect(pickerOptions(el)).toEqual(['', 'tl_b'])
    expect(disabled(el, 'tasks-detail-lists-add-submit')).toBe(true)
  })

  it('with nothing to offer, the picker is replaced by a note', async () => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, detailBody({ listIds: ['tl_a', 'tl_b'] })))
    const el = await mountAt('/tasks/t1')
    expect(text(el, 'tasks-detail-lists-no-candidates')).toBe('没有可加入的清单')
    expect(shown(el, 'tasks-detail-lists-add-form')).toBeNull()
  })

  it('adding sends the task id to the chosen list, reloads the task, and does not notify the badge', async () => {
    let reads = 0
    h_.detailReply.mockImplementation(() => {
      reads += 1
      return jsonResponse(200, detailBody(reads === 1 ? {} : { listIds: ['tl_a', 'tl_b'] }))
    })
    const el = await mountAt('/tasks/t1')
    await pick(el, 'tl_b')
    expect(disabled(el, 'tasks-detail-lists-add-submit')).toBe(false)
    await click(el, 'tasks-detail-lists-add-submit')
    expect(requests('POST', '/api/task-lists/tl_b/items').map(([, init]) => init?.body)).toEqual(['{"taskId":"t1"}'])
    expect(detailReads()).toBe(2)
    expect(listRows(el).map((row) => row.name)).toEqual(['Alpha', 'Beta'])
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
  })

  it.each([
    [404, { error: { code: 'NOT_FOUND' } }, '无法加入：你需要是该任务的创建人或负责人'],
    [422, { error: { code: 'LIMIT' } }, '一个任务最多属于 10 个清单'],
    [422, { error: { code: 'INVALID_TASK' } }, '无效的任务'],
    [422, { error: { code: 'NOT_IN_THE_CONTRACT' } }, '操作失败，请稍后重试'],
  ])('an add answered %s %j renders inline: %s', async (status, body, copy) => {
    h_.addItemReply.mockImplementation(() => jsonResponse(status, body))
    const el = await mountAt('/tasks/t1')
    await pick(el, 'tl_b')
    await click(el, 'tasks-detail-lists-add-submit')
    expect(text(el, 'tasks-detail-lists-error')).toBe(copy)
    expect(must(el, 'tasks-detail-lists-error').getAttribute('role')).toBe('alert')
    expect(shown(el, 'tasks-action-error')).toBeNull()
    expect(detailReads()).toBe(1)
  })

  it('an add answered 403 takes the page banner', async () => {
    h_.addItemReply.mockImplementation(() => jsonResponse(403, { error: { code: 'FORBIDDEN' } }))
    const el = await mountAt('/tasks/t1')
    await pick(el, 'tl_b')
    await click(el, 'tasks-detail-lists-add-submit')
    expect(text(el, 'tasks-action-error')).toBe('您没有权限修改此任务')
    expect(shown(el, 'tasks-detail-lists-error')).toBeNull()
  })

  it('removing asks first; cancelling sends nothing', async () => {
    const el = await mountAt('/tasks/t1')
    expect(must(el, 'tasks-detail-lists-remove').getAttribute('aria-label')).toBe('将此任务移出「Alpha」')
    await click(el, 'tasks-detail-lists-remove')
    must(el, 'tasks-detail-lists-remove-confirm')
    expect(fetchCalls().filter(([, init]) => init?.method === 'DELETE')).toEqual([])
    await click(el, 'tasks-detail-lists-remove-confirm-cancel')
    expect(shown(el, 'tasks-detail-lists-remove-confirm')).toBeNull()
    must(el, 'tasks-detail-lists-remove')
    expect(fetchCalls().filter(([, init]) => init?.method === 'DELETE')).toEqual([])
  })

  // [fe-50]: the confirmation replaces the row's remove button and cancel brings it back. The cells
  // focus the control they activate (a keyboard user's Enter) and act on the second row, so the
  // first row's controls are never the right answer by accident.
  it("[fe-50] opening a row's remove confirmation focuses its confirm button, which the prompt describes", async () => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, detailBody({ listIds: ['tl_a', 'tl_b'] })))
    const el = await mountAt('/tasks/t1')
    const row = shownAll(el, 'tasks-detail-lists-item')[1]
    expect(row.getAttribute('data-list-id')).toBe('tl_b')
    const trigger = must(row, 'tasks-detail-lists-remove')
    trigger.focus()
    trigger.click()
    await flush()
    const yes = must(row, 'tasks-detail-lists-remove-confirm-yes')
    expect(document.activeElement).toBe(yes)
    const prompt = must(row, 'tasks-detail-lists-remove-prompt')
    expect(prompt.textContent?.trim()).toBe('确认将此任务移出该清单？')
    expect(yes.getAttribute('aria-describedby')).toBe(prompt.id)
    expect(document.getElementById(prompt.id)).toBe(prompt)
  })

  it("[fe-50] cancelling it focuses that row's remove button again", async () => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, detailBody({ listIds: ['tl_a', 'tl_b'] })))
    const el = await mountAt('/tasks/t1')
    const row = shownAll(el, 'tasks-detail-lists-item')[1]
    const trigger = must(row, 'tasks-detail-lists-remove')
    trigger.focus()
    trigger.click()
    await flush()
    const cancel = must(row, 'tasks-detail-lists-remove-confirm-cancel')
    cancel.focus()
    cancel.click()
    await flush()
    expect(shown(el, 'tasks-detail-lists-remove-confirm')).toBeNull()
    expect(document.activeElement).toBe(must(row, 'tasks-detail-lists-remove'))
    expect(fetchCalls().filter(([, init]) => init?.method === 'DELETE')).toEqual([])
  })

  it('confirming sends DELETE for the task in that list, reloads the task, and does not notify the badge', async () => {
    let reads = 0
    h_.detailReply.mockImplementation(() => {
      reads += 1
      return jsonResponse(200, detailBody(reads === 1 ? {} : { listIds: [] }))
    })
    const el = await mountAt('/tasks/t1')
    await click(el, 'tasks-detail-lists-remove')
    await click(el, 'tasks-detail-lists-remove-confirm-yes')
    expect(requests('DELETE', '/api/task-lists/tl_a/items/t1')).toHaveLength(1)
    expect(detailReads()).toBe(2)
    must(el, 'tasks-detail-lists-empty')
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
  })

  it('every row offers removal, the rows of lists that are not mine included', async () => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, detailBody({ listIds: ['tl_a', 'tl_x'] })))
    const el = await mountAt('/tasks/t1')
    expect(shownAll(el, 'tasks-detail-lists-remove')).toHaveLength(2)
  })

  it('a remove answered 404 takes the page banner', async () => {
    h_.removeItemReply.mockImplementation(() => jsonResponse(404, { error: { code: 'NOT_FOUND' } }))
    const el = await mountAt('/tasks/t1')
    await click(el, 'tasks-detail-lists-remove')
    await click(el, 'tasks-detail-lists-remove-confirm-yes')
    expect(text(el, 'tasks-action-error')).toBe('操作失败，请稍后重试')
    expect(detailReads()).toBe(1)
  })

  it('a list id that is not a safe path segment never reaches the transport: remove ends in the banner, add in the inline copy', async () => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, detailBody({ listIds: ['..'] })))
    h_.myListsReply.mockImplementation(() => jsonResponse(200, { items: [taskList('.', 'Dot', 'edit')], total: 1 }))
    const el = await mountAt('/tasks/t1')
    await click(el, 'tasks-detail-lists-remove')
    await click(el, 'tasks-detail-lists-remove-confirm-yes')
    expect(text(el, 'tasks-action-error')).toBe('操作失败，请稍后重试')
    await pick(el, '.')
    await click(el, 'tasks-detail-lists-add-submit')
    expect(text(el, 'tasks-detail-lists-error')).toBe('无法加入：你需要是该任务的创建人或负责人')
    const writes = fetchCalls().filter(([, init]) => init?.method === 'POST' || init?.method === 'DELETE')
    expect(writes).toEqual([])
  })

  it('a viewer who cannot edit the task sees the lists without add or remove controls', async () => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, detailBody({ canEdit: false })))
    const el = await mountAt('/tasks/t1')
    expect(listRows(el).map((row) => row.name)).toEqual(['Alpha'])
    expect(shown(el, 'tasks-detail-lists-remove')).toBeNull()
    expect(shown(el, 'tasks-detail-lists-add-form')).toBeNull()
  })

  it('a my-lists read that lands after moving to another task does not name that task\'s lists', async () => {
    const t1Lists = deferred<Response>()
    let listReads = 0
    h_.myListsReply.mockImplementation(() => {
      listReads += 1
      return listReads === 1 ? t1Lists.promise : jsonResponse(200, { items: [taskList('tl_a', 'Second read', 'owner')], total: 1 })
    })
    const el = await mountAt('/tasks/t1')
    await go('/tasks/t2')
    expect(listRows(el)[0].name).toBe('Second read')
    t1Lists.resolve(jsonResponse(200, { items: MY_LISTS, total: MY_LISTS.length }))
    await flush()
    expect(listRows(el)[0].name).toBe('Second read')
  })

  it('a route edge clears the inline error of the lists section', async () => {
    h_.addItemReply.mockImplementation(() => jsonResponse(422, { error: { code: 'LIMIT' } }))
    const el = await mountAt('/tasks/t1')
    await pick(el, 'tl_b')
    await click(el, 'tasks-detail-lists-add-submit')
    must(el, 'tasks-detail-lists-error')
    await go('/tasks/t2')
    expect(shown(el, 'tasks-detail-lists-error')).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// FE-8 — the member controls follow `canManageMembers` (PR-3a)
//
// `[fe-45]` ruled 2026-10-07: adding or removing an assignee or a follower takes a
// direct role on the task (creator or assignee); the detail's `canManageMembers` reports it, and
// the four member controls follow it rather than `canEdit`, which a viewer who edits the task only
// through a list also has. `[fe-46]` (this frontend's own fallback): a body without the key falls
// back to `canEdit`. `[fe-47]`: the lists section's add picker follows the same ability; removal
// stays on `canEdit`.
// ---------------------------------------------------------------------------------------------

/** The four controls `canManageMembers` gates. */
const MEMBER_CONTROLS = [
  'tasks-detail-assignee-remove',
  'tasks-detail-add-assignee-form',
  'tasks-detail-follower-remove',
  'tasks-detail-add-follower-form',
] as const

/** Controls that stay on `canEdit`. */
const EDIT_CONTROLS = [
  'tasks-detail-completion-mode-select',
  'tasks-detail-set-parent-form',
  'tasks-detail-make-independent',
  'tasks-detail-editor',
] as const

type MemberFlags = { canEdit?: boolean; canManageMembers?: boolean }

/** A detail body with an assignee besides the viewer, a follower and a parent, so every member and
 *  edit control has something to render on; each of the two abilities is set, or deleted when the
 *  flag is not given (an older body). */
function memberBody(flags: MemberFlags, over: Record<string, unknown> = {}): Record<string, unknown> {
  const body = detailBody({
    assignees: [{ userId: 'u1', completedAt: null }, { userId: 'u2', completedAt: null }],
    followers: ['u5'],
    canLeave: false,
    parentId: 'p1',
    depth: 1,
    ...over,
  })
  for (const key of ['canEdit', 'canManageMembers'] as const) {
    if (flags[key] === undefined) delete body[key]
    else body[key] = flags[key]
  }
  return body
}

const MEMBER_COMBOS: Array<[string, MemberFlags, boolean]> = [
  ['canManageMembers true with canEdit true (the creator or an assignee) shows it', { canEdit: true, canManageMembers: true }, true],
  ['canManageMembers false with canEdit true (edits only through a list) hides it', { canEdit: true, canManageMembers: false }, false],
  ['canManageMembers true with canEdit false shows it (the flag alone decides)', { canEdit: false, canManageMembers: true }, true],
  ['canManageMembers false with canEdit false hides it', { canEdit: false, canManageMembers: false }, false],
  ['no canManageMembers with canEdit true (an older body) falls back to canEdit and shows it', { canEdit: true }, true],
  ['no canManageMembers with canEdit false (an older body) falls back to canEdit and hides it', { canEdit: false }, false],
  ['neither flag (an older body) shows it: an absent flag hides nothing', {}, true],
]

describe.each(MEMBER_CONTROLS)('FE-8 member control %s follows canManageMembers ([fe-45] [fe-46])', (testid) => {
  it.each(MEMBER_COMBOS)('%s', async (_label, flags, visible) => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, memberBody(flags)))
    const el = await mountAt('/tasks/t1')
    must(el, 'tasks-detail')
    if (visible) must(el, testid)
    else expect(shown(el, testid)).toBeNull()
  })
})

describe('FE-8 — completion mode, the parent, the editor and Leave do not follow canManageMembers', () => {
  it.each(EDIT_CONTROLS)('%s shows for canEdit: true with canManageMembers: false', async (testid) => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, memberBody({ canEdit: true, canManageMembers: false })))
    const el = await mountAt('/tasks/t1')
    must(el, testid)
  })

  it.each(EDIT_CONTROLS)('%s stays hidden for canEdit: false with canManageMembers: true', async (testid) => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, memberBody({ canEdit: false, canManageMembers: true })))
    const el = await mountAt('/tasks/t1')
    must(el, 'tasks-detail')
    expect(shown(el, testid)).toBeNull()
  })

  it('Leave follows canLeave: shown for a follower without member management, hidden for a manager who may not leave', async () => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, memberBody({ canEdit: true, canManageMembers: false }, { canLeave: true })))
    const el = await mountAt('/tasks/t1')
    must(el, 'tasks-detail-leave')
    for (const testid of MEMBER_CONTROLS) expect(shown(el, testid), testid).toBeNull()
    app?.unmount()
    container?.remove()
    h_.detailReply.mockImplementation(() => jsonResponse(200, memberBody({ canEdit: true, canManageMembers: true }, { canLeave: false })))
    const el2 = await mountAt('/tasks/t1')
    expect(shown(el2, 'tasks-detail-leave')).toBeNull()
    must(el2, 'tasks-detail-add-assignee-form')
  })

  it('a viewer who edits the task only through a list: field edits save, member controls are gone, rows stay readable, removal from a list stays and the add picker is gone', async () => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, memberBody({ canEdit: true, canManageMembers: false })))
    const el = await mountAt('/tasks/t1')
    for (const testid of MEMBER_CONTROLS) expect(shown(el, testid), testid).toBeNull()
    for (const testid of EDIT_CONTROLS) must(el, testid)
    expect(shown(el, 'tasks-detail-leave')).toBeNull()
    expect(shownAll(el, 'tasks-detail-assignee')).toHaveLength(2)
    expect(shownAll(el, 'tasks-detail-follower')).toHaveLength(1)
    must(el, 'tasks-detail-lists-remove')
    expect(shown(el, 'tasks-detail-lists-add-form')).toBeNull()
    expect(shown(el, 'tasks-detail-lists-no-candidates')).toBeNull()
    expect(shown(el, 'tasks-detail-lists-mine-loading')).toBeNull()

    await typeInto(el, 'title', 'Renamed')
    await save(el)
    expect(patchBodies()).toEqual(['{"expectedVersion":3,"title":"Renamed"}'])
    expect(detailReads()).toBe(2)
    for (const testid of MEMBER_CONTROLS) expect(shown(el, testid), testid).toBeNull()
  })
})

describe('FE-8 — the lists section: the add picker follows the member-management ability, removal follows canEdit ([fe-47])', () => {
  it.each([
    ['canManageMembers true', { canEdit: true, canManageMembers: true }, true, true],
    ['canManageMembers false (edits only through a list)', { canEdit: true, canManageMembers: false }, false, true],
    ['no canManageMembers, canEdit true (falls back)', { canEdit: true }, true, true],
    ['no canManageMembers, canEdit false (falls back)', { canEdit: false }, false, false],
  ] as Array<[string, MemberFlags, boolean, boolean]>)('%s', async (_label, flags, picker, removal) => {
    h_.detailReply.mockImplementation(() => jsonResponse(200, memberBody(flags)))
    const el = await mountAt('/tasks/t1')
    must(el, 'tasks-detail-lists')
    if (picker) must(el, 'tasks-detail-lists-add-form')
    else expect(shown(el, 'tasks-detail-lists-add-form')).toBeNull()
    if (removal) must(el, 'tasks-detail-lists-remove')
    else expect(shown(el, 'tasks-detail-lists-remove')).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// FE-8 — 422 INACTIVE_ORG_MEMBER (PR-3a S9; R17 / N2, ruled 2026-10-07) at the task's member adds
// and on the create form: one code, one copy (`labels.ts` `codeInactiveOrgMember`)
// ---------------------------------------------------------------------------------------------

describe('FE-8 — 422 INACTIVE_ORG_MEMBER at the task member adds and the create form', () => {
  const INACTIVE = '该用户不在当前组织或已停用'
  const inactive = () => jsonResponse(422, { error: { code: 'INACTIVE_ORG_MEMBER' } })

  async function submitInto(el: HTMLElement, input: string, form: string, value: string): Promise<void> {
    const field = must(el, input) as HTMLInputElement
    field.value = value
    field.dispatchEvent(new Event('input'))
    await flush()
    ;(must(el, form) as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
  }

  it('an assignee add answered INACTIVE_ORG_MEMBER says so next to the assignee form, and nothing else moves', async () => {
    h_.assigneeReply.mockImplementation(() => inactive())
    h_.detailReply.mockImplementation(() => jsonResponse(200, memberBody({ canEdit: true, canManageMembers: true })))
    const el = await mountAt('/tasks/t1')
    await submitInto(el, 'tasks-detail-add-assignee-input', 'tasks-detail-add-assignee-form', 'u9')
    expect(requests('POST', '/api/tasks/t1/assignees').map(([, init]) => init?.body)).toEqual(['{"userId":"u9"}'])
    expect(text(el, 'tasks-detail-membership-error')).toBe(INACTIVE)
    expect(must(el, 'tasks-detail-membership-error').getAttribute('role')).toBe('alert')
    expect(shown(el, 'tasks-detail-follower-error')).toBeNull()
    expect(shown(el, 'tasks-action-error')).toBeNull()
    expect((must(el, 'tasks-detail-add-assignee-input') as HTMLInputElement).value).toBe('u9')
    expect(detailReads()).toBe(1)
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
  })

  it('a follower add answered INACTIVE_ORG_MEMBER says so next to the follower form, and nothing else moves', async () => {
    h_.followerReply.mockImplementation(() => inactive())
    h_.detailReply.mockImplementation(() => jsonResponse(200, memberBody({ canEdit: true, canManageMembers: true })))
    const el = await mountAt('/tasks/t1')
    await submitInto(el, 'tasks-detail-add-follower-input', 'tasks-detail-add-follower-form', 'u9')
    expect(requests('POST', '/api/tasks/t1/followers').map(([, init]) => init?.body)).toEqual(['{"userId":"u9"}'])
    expect(text(el, 'tasks-detail-follower-error')).toBe(INACTIVE)
    expect(must(el, 'tasks-detail-follower-error').getAttribute('role')).toBe('alert')
    expect(shown(el, 'tasks-detail-membership-error')).toBeNull()
    expect(shown(el, 'tasks-action-error')).toBeNull()
    expect(shownAll(el, 'tasks-detail-follower').map((row) => row.textContent?.trim())).toEqual([expect.stringContaining('u5')])
    expect(detailReads()).toBe(1)
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
  })

  it('a create answered INACTIVE_ORG_MEMBER shows that code\'s copy under the create form; the form itself names no assignee', async () => {
    h_.createReply.mockImplementation(() => inactive())
    const el = await mountAt('/tasks')
    await submitInto(el, 'tasks-create-title', 'tasks-create-form', 'New task')
    const bodies = requests('POST', '/api/tasks').map(([, init]) => init?.body as string)
    expect(bodies).toEqual(['{"title":"New task","completionMode":"all"}'])
    expect(text(el, 'tasks-create-error')).toBe(INACTIVE)
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
  })

  it('a create answered with a 422 code outside the createTask allowlist keeps the generic copy', async () => {
    h_.createReply.mockImplementation(() => jsonResponse(422, { error: { code: 'INVALID_DESCRIPTION' } }))
    const el = await mountAt('/tasks')
    await submitInto(el, 'tasks-create-title', 'tasks-create-form', 'New task')
    expect(text(el, 'tasks-create-error')).toBe('创建任务失败，请稍后重试')
  })

  it('a later create failure without a code drops the previous code: a 500 after INACTIVE_ORG_MEMBER shows the generic copy', async () => {
    h_.createReply.mockImplementationOnce(() => inactive()).mockImplementationOnce(() => jsonResponse(500, {}))
    const el = await mountAt('/tasks')
    await submitInto(el, 'tasks-create-title', 'tasks-create-form', 'New task')
    expect(text(el, 'tasks-create-error')).toBe(INACTIVE)
    await submitInto(el, 'tasks-create-title', 'tasks-create-form', 'New task')
    expect(requests('POST', '/api/tasks')).toHaveLength(2)
    expect(text(el, 'tasks-create-error')).toBe('创建任务失败，请稍后重试')
  })
})
