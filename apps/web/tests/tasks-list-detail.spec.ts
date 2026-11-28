import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'

/**
 * M4 FE-5 — the list page `/task-lists/:id` (TaskListView.vue; docs/development/task-m4-frontend-
 * design-20261007.md §2.1, §2.4, §4.0, §4.2, §5.1, §10.1).
 *
 * Backend: the list routes (`GET` / `PATCH /api/task-lists/:id`, `…/archive`, `…/unarchive`,
 * `…/events`, PR-3a S5) and the item routes (`GET` / `POST …/items`, `DELETE …/items/:taskId`,
 * PR-3a S7) are built on the PR-3a branch, not on main; the page is shown to survive a backend
 * without the item routes (one that answers them 404).
 *
 * Mock face: `apiFetch` plays the backend by path over a small in-memory state (writes change what
 * the next read returns), so the REAL tasksApi client builds every request and parses every answer —
 * request bodies are asserted as the client serialized them. Also mocked: `loadTasksContext`,
 * `notifyTasksChanged` (the badge bus, which no list write may touch), `useAuth` (the viewer's own
 * id) and `useLocale` (ZH). The lists bus is the real module; cells subscribe a spy to it. The
 * router is real: `/task-lists/:id` on TaskListView (the instance is reused across ids), `/tasks` and
 * `/tasks/:id` on a stand-in page.
 */

const h_ = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  loadTasksContext: vi.fn(),
  notifyTasksChanged: vi.fn(),
  getCurrentUserId: vi.fn(),
  /** `GET /api/task-lists/:id` (decoded id) -> the response, or a promise of it. */
  listReply: vi.fn(),
  /** `PATCH /api/task-lists/:id` (id, serialized body). */
  renameReply: vi.fn(),
  /** `POST /api/task-lists/:id/archive` (id). */
  archiveReply: vi.fn(),
  /** `POST /api/task-lists/:id/unarchive` (id). */
  unarchiveReply: vi.fn(),
  /** `GET /api/task-lists/:id/items?…` (id, query). */
  itemsReply: vi.fn(),
  /** `POST /api/task-lists/:id/items` (id, serialized body). */
  addItemReply: vi.fn(),
  /** `DELETE /api/task-lists/:id/items/:taskId` (id, task id). */
  removeItemReply: vi.fn(),
  /** `GET /api/task-lists/:id/events?…` (id, query). */
  eventsReply: vi.fn(),
  /** `GET /api/tasks?view=&status=&q=` (view, status, q) -> the response; an empty page by default. */
  tasksReply: vi.fn(),
  createReply: vi.fn(),
  /** `GET /api/tasks/people?…` (query): the people lookup that names the activity's actors. */
  peopleReply: vi.fn(),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: h_.apiFetch,
  // No org header: the account-switch cells compare the token's subject.
  authHeaders: () => ({}),
}))

vi.mock('../src/tasks/tasksContext', () => ({
  loadTasksContext: h_.loadTasksContext,
}))

vi.mock('../src/tasks/tasksBadgeBus', () => ({
  notifyTasksChanged: h_.notifyTasksChanged,
  onTasksChanged: () => () => undefined,
}))

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

import TaskListView from '../src/views/tasks/TaskListView.vue'
import { onListsChanged } from '../src/tasks/tasksListsBus'
import { formatViewerInstant } from '../src/tasks/tasksDateDisplay'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'

// ---------------------------------------------------------------------------------------------
// Fixtures and the fake backend
// ---------------------------------------------------------------------------------------------

type Role = 'read' | 'edit' | 'owner'

function listBody(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `Name-${id}`,
    createdBy: 'u1',
    ownerId: 'u1',
    archivedAt: null,
    createdAt: '2031-01-01T00:00:00.000Z',
    updatedAt: '2031-01-01T00:00:00.000Z',
    myRole: 'owner',
    ...over,
  }
}

function item(id: string, title: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, title, status: 'open', completion_mode: 'all', created_by: 'u1', due_at: null, ...over }
}

function event(id: string, eventType: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, listId: 'tl_1', actorId: 'u1', eventType, payload: {}, occurredAt: '2031-03-01T08:00:00.000Z', ...over }
}

/** What the fake backend holds; writes change it, so a re-read shows the write. */
let lists: Record<string, Record<string, unknown>> = {}
let items: Record<string, Array<Record<string, unknown>>> = {}
let events: Record<string, Array<Record<string, unknown>>> = {}

function page(all: Array<Record<string, unknown>>, query: string): Response {
  const offset = Number(new URLSearchParams(query).get('offset'))
  return jsonResponse(200, { items: all.slice(offset, offset + 100), total: all.length })
}

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

const NOT_FOUND = () => jsonResponse(404, { error: { code: 'NOT_FOUND' } })

type FetchInit = { method?: string; body?: string } | undefined

/** Requests the fake backend has no route for. Checked empty after every cell. */
let unexpected: string[] = []

async function fakeFetch(path: string, init?: FetchInit): Promise<Response> {
  const method = init?.method ?? 'GET'
  const [pathname, query = ''] = path.split('?')
  let match: RegExpExecArray | null
  if ((match = /^\/api\/task-lists\/([^/]+)$/.exec(pathname))) {
    const id = decodeURIComponent(match[1])
    if (method === 'GET') return h_.listReply(id)
    if (method === 'PATCH') return h_.renameReply(id, init?.body)
  }
  if (method === 'POST' && (match = /^\/api\/task-lists\/([^/]+)\/archive$/.exec(pathname))) return h_.archiveReply(decodeURIComponent(match[1]))
  if (method === 'POST' && (match = /^\/api\/task-lists\/([^/]+)\/unarchive$/.exec(pathname))) return h_.unarchiveReply(decodeURIComponent(match[1]))
  if ((match = /^\/api\/task-lists\/([^/]+)\/items$/.exec(pathname))) {
    const id = decodeURIComponent(match[1])
    if (method === 'GET') return h_.itemsReply(id, query)
    if (method === 'POST') return h_.addItemReply(id, init?.body)
  }
  if (method === 'DELETE' && (match = /^\/api\/task-lists\/([^/]+)\/items\/([^/]+)$/.exec(pathname))) {
    return h_.removeItemReply(decodeURIComponent(match[1]), decodeURIComponent(match[2]))
  }
  if (method === 'GET' && (match = /^\/api\/task-lists\/([^/]+)\/events$/.exec(pathname))) return h_.eventsReply(decodeURIComponent(match[1]), query)
  // The people lookup that names the activity's actors (`h_.peopleReply`; names nobody by default).
  if (method === 'GET' && pathname === '/api/tasks/people') return h_.peopleReply(query)
  // M4 FE-7: the grouping board's two reads — a list with no custom groups and no placements yet
  // (tasks-groups.spec.ts covers the board itself).
  if (method === 'GET' && (match = /^\/api\/task-lists\/([^/]+)\/groups$/.exec(pathname))) {
    return page([{ id: `tg_${decodeURIComponent(match[1])}`, scope: 'list', name: '默认分组', position: 0, isDefault: true }], query)
  }
  if (method === 'GET' && /^\/api\/task-lists\/[^/]+\/group-items$/.test(pathname)) return page([], query)
  // The task picker's search.
  if (method === 'POST' && pathname === '/api/tasks') return h_.createReply(init?.body)
  if (method === 'GET' && pathname === '/api/tasks') {
    const params = new URLSearchParams(query)
    return h_.tasksReply(params.get('view'), params.get('status'), params.get('q'))
  }
  unexpected.push(`${method} ${path}`)
  return jsonResponse(599, {})
}

function fetchCalls(): Array<[string, FetchInit]> {
  return h_.apiFetch.mock.calls as Array<[string, FetchInit]>
}

function requests(method: string, path: string): Array<[string, FetchInit]> {
  return fetchCalls().filter(([p, init]) => p === path && (init?.method ?? 'GET') === method)
}

function listReads(id = 'tl_1'): number {
  return requests('GET', `/api/task-lists/${id}`).length
}

function itemReads(id = 'tl_1'): number {
  return fetchCalls().filter(([p, init]) => p.startsWith(`/api/task-lists/${id}/items?`) && (init?.method ?? 'GET') === 'GET').length
}

/** Every write request the client sent. */
function writes(): Array<[string, FetchInit]> {
  return fetchCalls().filter(([, init]) => (init?.method ?? 'GET') !== 'GET')
}

// ---------------------------------------------------------------------------------------------
// Mount helpers
// ---------------------------------------------------------------------------------------------

let app: VueApp<Element> | null = null
let container: HTMLDivElement | null = null
let router: Router | null = null
const busListeners: Array<() => void> = []

async function flush(cycles = 12): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const OtherPage = defineComponent({
  name: 'OtherPage',
  render: () => h('p', { 'data-testid': 'other-page' }, 'other page'),
})

async function mountAt(path: string): Promise<HTMLElement> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/tasks', component: OtherPage },
      { path: '/tasks/:id', component: OtherPage },
      { path: '/task-lists/:id', component: TaskListView },
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

function watchBus(): ReturnType<typeof vi.fn> {
  const spy = vi.fn()
  busListeners.push(onListsChanged(spy))
  return spy
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

function disabled(el: HTMLElement, testid: string): boolean {
  return (must(el, testid) as HTMLButtonElement | HTMLInputElement).disabled
}

async function click(el: HTMLElement, testid: string): Promise<void> {
  ;(must(el, testid) as HTMLButtonElement).click()
  await flush()
}

async function typeInto(el: HTMLElement, testid: string, value: string): Promise<void> {
  const input = must(el, testid) as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input'))
  await flush()
}

/** Submits a form the way Enter does; also reaches the handler while its button is disabled. */
async function submit(el: HTMLElement, testid: string): Promise<void> {
  must(el, testid).dispatchEvent(new Event('submit', { cancelable: true }))
  await flush()
}

async function rename(el: HTMLElement, value: string): Promise<void> {
  await click(el, 'tasks-list-detail-rename')
  await typeInto(el, 'tasks-list-detail-rename-input', value)
  await submit(el, 'tasks-list-detail-rename-form')
}

async function addTask(el: HTMLElement, value: string): Promise<void> {
  await typeInto(el, 'tasks-list-detail-add-task-input', value)
  await submit(el, 'tasks-list-detail-add-task-form')
}

/** The rows of the items section as `[task id, title]`. */
function itemRows(el: HTMLElement): Array<[string, string]> {
  return shownAll(el, 'tasks-list-detail-item').map((row) => [
    row.getAttribute('data-task-id') ?? '',
    row.querySelector('[data-testid="tasks-list-detail-item-link"]')?.textContent?.trim() ?? '',
  ])
}

/** Which write controls the page shows. */
function controls(el: HTMLElement): Record<string, boolean> {
  return {
    rename: shown(el, 'tasks-list-detail-rename') !== null,
    archive: shown(el, 'tasks-list-detail-archive') !== null,
    unarchive: shown(el, 'tasks-list-detail-unarchive') !== null,
    addTask: shown(el, 'tasks-list-detail-add-task-form') !== null,
    removeTask: shown(el, 'tasks-list-detail-item-remove') !== null,
  }
}

beforeEach(() => {
  unexpected = []
  lists = {
    tl_1: listBody('tl_1', { name: 'Groceries' }),
    tl_2: listBody('tl_2', { name: 'Chores' }),
  }
  items = {
    tl_1: [item('t1', 'Task One', { due_at: '2031-03-15T02:00:00.000Z' }), item('t2', 'Task Two', { status: 'done' })],
    tl_2: [item('t3', 'Task Three')],
  }
  events = { tl_1: [], tl_2: [] }
  h_.apiFetch.mockReset().mockImplementation(fakeFetch)
  h_.loadTasksContext.mockReset().mockResolvedValue({ state: 'ready', orgId: 'org1' })
  h_.notifyTasksChanged.mockReset()
  h_.createReply.mockReset().mockImplementation(() => jsonResponse(200, { id: 'fresh-task' }))
  h_.getCurrentUserId.mockReset().mockResolvedValue('u1')
  h_.listReply.mockReset().mockImplementation((id: string) => (lists[id] ? jsonResponse(200, lists[id]) : NOT_FOUND()))
  h_.renameReply.mockReset().mockImplementation((id: string, body: string) => {
    lists[id] = { ...lists[id], name: JSON.parse(body).name, updatedAt: '2031-02-01T00:00:00.000Z' }
    return jsonResponse(200, lists[id])
  })
  h_.archiveReply.mockReset().mockImplementation((id: string) => {
    lists[id] = { ...lists[id], archivedAt: '2031-02-01T00:00:00.000Z' }
    return jsonResponse(200, lists[id])
  })
  h_.unarchiveReply.mockReset().mockImplementation((id: string) => {
    lists[id] = { ...lists[id], archivedAt: null }
    return jsonResponse(200, lists[id])
  })
  h_.itemsReply.mockReset().mockImplementation((id: string, query: string) => page(items[id] ?? [], query))
  h_.addItemReply.mockReset().mockImplementation((id: string, body: string) => {
    const taskId = JSON.parse(body).taskId as string
    items[id] = [...(items[id] ?? []), item(taskId, `Title-${taskId}`)]
    return jsonResponse(200, { listId: id, taskId })
  })
  h_.removeItemReply.mockReset().mockImplementation((id: string, taskId: string) => {
    items[id] = (items[id] ?? []).filter((row) => row.id !== taskId)
    return jsonResponse(200, { listId: id, taskId })
  })
  h_.eventsReply.mockReset().mockImplementation((id: string, query: string) => page(events[id] ?? [], query))
  h_.tasksReply.mockReset().mockImplementation(() => jsonResponse(200, { items: [], total: 0 }))
  h_.peopleReply.mockReset().mockImplementation(() => jsonResponse(200, { items: [], truncated: false }))
})

afterEach(() => {
  while (busListeners.length > 0) busListeners.pop()!()
  app?.unmount()
  container?.remove()
  app = null
  container = null
  router = null
  expect(unexpected).toEqual([])
})

// ---------------------------------------------------------------------------------------------
// Context and page states
// ---------------------------------------------------------------------------------------------

describe('list page — context and page states', () => {
  it('shows loading while the context read is in flight, and reads nothing else yet', async () => {
    const context = deferred<unknown>()
    h_.loadTasksContext.mockReturnValue(context.promise)
    const el = await mountAt('/task-lists/tl_1')
    expect(text(el, 'tasks-list-detail-loading')).toBe('加载中…')
    expect(fetchCalls()).toEqual([])
    context.resolve({ state: 'ready', orgId: 'org1' })
    await flush()
    expect(text(el, 'tasks-list-detail-title')).toBe('Groceries')
  })

  it.each([
    ['org_missing', 'tasks-view-org-missing', '请先选择一个组织后再查看任务'],
    ['unavailable', 'tasks-view-unavailable', '任务功能未启用或当前服务不支持'],
    ['forbidden', 'tasks-view-forbidden', '您没有权限查看任务'],
    ['error', 'tasks-view-error', '加载任务时出现错误，请稍后重试'],
  ] as const)('context %s renders the TasksView block and sends no list request', async (state, testid, copy) => {
    h_.loadTasksContext.mockResolvedValue({ state })
    const el = await mountAt('/task-lists/tl_1')
    expect(text(el, testid)).toBe(copy)
    expect(shown(el, 'tasks-list-detail')).toBeNull()
    expect(fetchCalls()).toEqual([])
  })

  it('ok: the name heads the page, with my role; the list and its items were read once each, in parallel', async () => {
    const list = deferred<Response>()
    const rows = deferred<Response>()
    h_.listReply.mockImplementation(() => list.promise)
    h_.itemsReply.mockImplementation(() => rows.promise)
    const el = await mountAt('/task-lists/tl_1')
    expect(text(el, 'tasks-list-detail-loading')).toBe('加载中…')
    expect(text(el, 'tasks-list-detail-title')).toBe('任务清单')
    // Both requests are out before either answers.
    expect(listReads()).toBe(1)
    expect(itemReads()).toBe(1)
    list.resolve(jsonResponse(200, lists.tl_1))
    rows.resolve(page(items.tl_1, 'offset=0'))
    await flush()
    expect(text(el, 'tasks-list-detail-title')).toBe('Groceries')
    expect(text(el, 'tasks-list-detail-role')).toBe('我的角色：所有者')
    expect(shown(el, 'tasks-list-detail-archived')).toBeNull()
    expect(requests('GET', '/api/task-lists/tl_1/items?limit=100&offset=0')).toHaveLength(1)
  })

  it('not_found on a 404: its own copy and test id, no controls, no items section', async () => {
    h_.listReply.mockImplementation(NOT_FOUND)
    const el = await mountAt('/task-lists/tl_1')
    expect(text(el, 'tasks-list-detail-not-found')).toBe('清单不存在或你不是成员')
    expect(shown(el, 'tasks-list-detail-forbidden')).toBeNull()
    expect(shown(el, 'tasks-list-detail')).toBeNull()
    expect(text(el, 'tasks-list-detail-title')).toBe('任务清单')
  })

  it('forbidden on a 403: its own copy and test id, told apart from not_found', async () => {
    h_.listReply.mockImplementation(() => jsonResponse(403, { error: 'Insufficient permissions' }))
    const el = await mountAt('/task-lists/tl_1')
    expect(text(el, 'tasks-list-detail-forbidden')).toBe('您没有权限查看此清单')
    expect(shown(el, 'tasks-list-detail-not-found')).toBeNull()
    expect(shown(el, 'tasks-list-detail')).toBeNull()
  })

  it.each([
    ['a 500', () => jsonResponse(500, {})],
    ['a malformed 200', () => jsonResponse(200, { id: 'tl_1', name: 'x' })],
    ['a closed-set role the client does not know', () => jsonResponse(200, listBody('tl_1', { myRole: 'admin' }))],
    ['a transport failure', () => Promise.reject(new Error('offline'))],
  ] as const)('error on %s', async (_label, reply) => {
    h_.listReply.mockImplementation(reply)
    const el = await mountAt('/task-lists/tl_1')
    expect(text(el, 'tasks-list-detail-error')).toBe('加载清单失败，请稍后重试')
    expect(must(el, 'tasks-list-detail-error').getAttribute('role')).toBe('alert')
    expect(shown(el, 'tasks-list-detail-not-found')).toBeNull()
  })

  it.each(['..', '%2E%2E', '.', '%2E'])('an id that is not a safe path segment (%s) is not_found and never reaches the transport', async (segment) => {
    const el = await mountAt(`/task-lists/${segment}`)
    must(el, 'tasks-list-detail-not-found')
    expect(fetchCalls().filter(([path]) => path.startsWith('/api/task-lists'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// Items (PR-3a S7)
// ---------------------------------------------------------------------------------------------

describe('list page — items', () => {
  it('rows link to the task page and show status and the due instant', async () => {
    const el = await mountAt('/task-lists/tl_1')
    expect(itemRows(el)).toEqual([
      ['t1', 'Task One'],
      ['t2', 'Task Two'],
    ])
    expect(shownAll(el, 'tasks-list-detail-item-link').map((link) => link.getAttribute('href'))).toEqual(['/tasks/t1', '/tasks/t2'])
    expect(shownAll(el, 'tasks-list-detail-item-status').map((node) => node.textContent?.trim())).toEqual(['进行中', '已完成'])
    expect(text(el, 'tasks-list-detail-item-due')).toBe(formatViewerInstant('2031-03-15T02:00:00.000Z', undefined, 'zh-CN'))
    expect(shownAll(el, 'tasks-list-detail-item-due')).toHaveLength(1)
  })

  it('opening a task from a row sends no list read for the task id (the list page does not take it as a list id)', async () => {
    const el = await mountAt('/task-lists/tl_1')
    const before = fetchCalls().length
    await go(must(el, 'tasks-list-detail-item-link').getAttribute('href') as string)
    await flush()
    must(el, 'other-page')
    expect(fetchCalls().slice(before)).toEqual([])
  })

  it('empty: its own copy, and the add form still shows', async () => {
    items.tl_1 = []
    const el = await mountAt('/task-lists/tl_1')
    expect(text(el, 'tasks-list-detail-items-empty')).toBe('清单中还没有任务')
    must(el, 'tasks-list-detail-add-task-form')
  })

  it('a 404 on the items read (no item routes yet) keeps the page: header and controls stay, the items are unavailable', async () => {
    h_.itemsReply.mockImplementation(NOT_FOUND)
    const el = await mountAt('/task-lists/tl_1')
    must(el, 'tasks-list-detail')
    expect(shown(el, 'tasks-list-detail-not-found')).toBeNull()
    expect(text(el, 'tasks-list-detail-title')).toBe('Groceries')
    expect(text(el, 'tasks-list-detail-items-unavailable')).toBe('暂时无法读取清单中的任务')
    must(el, 'tasks-list-detail-rename')
    must(el, 'tasks-list-detail-archive')
    expect(shown(el, 'tasks-list-detail-add-task-form')).toBeNull()
  })

  it.each([
    ['a 500', () => jsonResponse(500, {})],
    ['a 403', () => jsonResponse(403, { error: 'Insufficient permissions' })],
    ['a malformed row', () => jsonResponse(200, { items: [{ id: 't1' }], total: 1 })],
  ] as const)('%s on the items read: the items are unavailable, the page stays', async (_label, reply) => {
    h_.itemsReply.mockImplementation(reply)
    const el = await mountAt('/task-lists/tl_1')
    must(el, 'tasks-list-detail-items-unavailable')
    must(el, 'tasks-list-detail-rename')
  })

  it('the degraded no-org body on the items read switches to the org guidance block', async () => {
    h_.itemsReply.mockImplementation(() => jsonResponse(200, { items: [], degraded: true, reason: 'org_missing' }))
    const el = await mountAt('/task-lists/tl_1')
    expect(text(el, 'tasks-view-org-missing')).toBe('请先选择一个组织后再查看任务')
    expect(shown(el, 'tasks-list-detail')).toBeNull()
  })

  it('a read cut short at the page bound says not every task is shown', async () => {
    items.tl_1 = Array.from({ length: 2100 }, (_, i) => item(`t${i}`, `Task ${i}`))
    const el = await mountAt('/task-lists/tl_1')
    // Twenty pages are read one after another.
    await flush(200)
    expect(itemReads()).toBe(20)
    expect(shownAll(el, 'tasks-list-detail-item')).toHaveLength(2000)
    expect(text(el, 'tasks-list-detail-items-truncated')).toBe('清单中的任务较多，未全部显示')
  })

  it('a complete read shows no truncation notice', async () => {
    const el = await mountAt('/task-lists/tl_1')
    expect(shown(el, 'tasks-list-detail-items-truncated')).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// Controls by role (design §5.1)
// ---------------------------------------------------------------------------------------------

describe('list page — controls by role', () => {
  it('owner: rename, archive, add a task, remove a task', async () => {
    const el = await mountAt('/task-lists/tl_1')
    expect(controls(el)).toEqual({ rename: true, archive: true, unarchive: false, addTask: true, removeTask: true })
    expect(must(el, 'tasks-list-detail-role').getAttribute('data-role')).toBe('owner')
  })

  it('edit: the same controls as the owner', async () => {
    lists.tl_1 = listBody('tl_1', { myRole: 'edit', createdBy: 'u9', ownerId: 'u9' })
    const el = await mountAt('/task-lists/tl_1')
    expect(controls(el)).toEqual({ rename: true, archive: true, unarchive: false, addTask: true, removeTask: true })
    expect(text(el, 'tasks-list-detail-role')).toBe('我的角色：可编辑')
  })

  it('read, not the creator: no write control at all', async () => {
    lists.tl_1 = listBody('tl_1', { myRole: 'read', createdBy: 'u9', ownerId: 'u9' })
    const el = await mountAt('/task-lists/tl_1')
    expect(controls(el)).toEqual({ rename: false, archive: false, unarchive: false, addTask: false, removeTask: false })
    expect(text(el, 'tasks-list-detail-role')).toBe('我的角色：只读')
    expect(itemRows(el)).toHaveLength(2)
  })

  it('read and the creator: archive only', async () => {
    lists.tl_1 = listBody('tl_1', { myRole: 'read', createdBy: 'u1', ownerId: 'u9' })
    const el = await mountAt('/task-lists/tl_1')
    expect(controls(el)).toEqual({ rename: false, archive: true, unarchive: false, addTask: false, removeTask: false })
  })

  it('read and the creator of an archived list: unarchive only', async () => {
    lists.tl_1 = listBody('tl_1', { myRole: 'read', createdBy: 'u1', ownerId: 'u9', archivedAt: '2031-02-01T00:00:00.000Z' })
    const el = await mountAt('/task-lists/tl_1')
    expect(controls(el)).toEqual({ rename: false, archive: false, unarchive: true, addTask: false, removeTask: false })
  })

  it('read, the creator, but the viewer id could not be resolved: the creator half stays hidden', async () => {
    lists.tl_1 = listBody('tl_1', { myRole: 'read', createdBy: 'u1', ownerId: 'u9' })
    h_.getCurrentUserId.mockResolvedValue(null)
    const el = await mountAt('/task-lists/tl_1')
    expect(controls(el).archive).toBe(false)
  })

  it('read, the creator, while the viewer id is still resolving: hidden until it is known', async () => {
    lists.tl_1 = listBody('tl_1', { myRole: 'read', createdBy: 'u1', ownerId: 'u9' })
    const viewer = deferred<string | null>()
    h_.getCurrentUserId.mockReturnValue(viewer.promise)
    const el = await mountAt('/task-lists/tl_1')
    expect(controls(el).archive).toBe(false)
    viewer.resolve('u1')
    await flush()
    expect(controls(el).archive).toBe(true)
  })

  it('read, the creator, when resolving the viewer id throws: hidden', async () => {
    lists.tl_1 = listBody('tl_1', { myRole: 'read', createdBy: 'u1', ownerId: 'u9' })
    h_.getCurrentUserId.mockRejectedValue(new Error('no session'))
    const el = await mountAt('/task-lists/tl_1')
    expect(controls(el).archive).toBe(false)
  })

  it('an archived list owned by me: the archived mark and unarchive instead of archive', async () => {
    lists.tl_1 = listBody('tl_1', { archivedAt: '2031-02-01T00:00:00.000Z' })
    const el = await mountAt('/task-lists/tl_1')
    expect(text(el, 'tasks-list-detail-archived')).toBe('已归档')
    expect(controls(el)).toEqual({ rename: true, archive: false, unarchive: true, addTask: true, removeTask: true })
  })

  it('there is no delete control for the list', async () => {
    const el = await mountAt('/task-lists/tl_1')
    const texts = Array.from(el.querySelectorAll('button')).map((button) => button.textContent?.trim())
    expect(texts).not.toContain('删除')
    expect(texts).not.toContain('删除清单')
  })
})

// ---------------------------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------------------------

describe('list page — rename', () => {
  it('opens prefilled with the current name; cancel closes it and sends nothing', async () => {
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-rename')
    expect((must(el, 'tasks-list-detail-rename-input') as HTMLInputElement).value).toBe('Groceries')
    await click(el, 'tasks-list-detail-rename-cancel')
    expect(shown(el, 'tasks-list-detail-rename-form')).toBeNull()
    must(el, 'tasks-list-detail-rename')
    expect(writes()).toEqual([])
  })

  it('ok: the body carries the normalized name, the form closes, the list is read again and the lists bus hears it once', async () => {
    const bus = watchBus()
    const el = await mountAt('/task-lists/tl_1')
    await rename(el, '  Weekly shop  ')
    expect(requests('PATCH', '/api/task-lists/tl_1').map(([, init]) => init?.body)).toEqual([JSON.stringify({ name: 'Weekly shop' })])
    expect(shown(el, 'tasks-list-detail-rename-form')).toBeNull()
    expect(listReads()).toBe(2)
    expect(text(el, 'tasks-list-detail-title')).toBe('Weekly shop')
    expect(bus).toHaveBeenCalledTimes(1)
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
  })

  it('the same name is still sent (the server answers a no-op 200) and the list is read again', async () => {
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-rename')
    await submit(el, 'tasks-list-detail-rename-form')
    expect(requests('PATCH', '/api/task-lists/tl_1')).toHaveLength(1)
    expect(listReads()).toBe(2)
  })

  it('the save button is disabled while the name is blank', async () => {
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-rename')
    await typeInto(el, 'tasks-list-detail-rename-input', '   ')
    expect(disabled(el, 'tasks-list-detail-rename-submit')).toBe(true)
  })

  it.each([
    ['zero-width marks only', '​‌', '名称不能为空'],
    ['101 code points', '\u{1F600}'.repeat(101), '名称过长'],
    ['U+0000', 'a\u0000b', '名称不能为空'],
  ] as const)('pre-check (%s) renders inline and sends nothing', async (_label, value, copy) => {
    const el = await mountAt('/task-lists/tl_1')
    await rename(el, value)
    expect(text(el, 'tasks-list-detail-rename-error')).toBe(copy)
    expect(must(el, 'tasks-list-detail-rename-input').getAttribute('aria-invalid')).toBe('true')
    expect(must(el, 'tasks-list-detail-rename-input').getAttribute('aria-describedby')).toBe('tasks-list-detail-rename-error')
    expect(writes()).toEqual([])
  })

  it('100 code points pass the pre-check', async () => {
    const el = await mountAt('/task-lists/tl_1')
    await rename(el, '\u{1F600}'.repeat(100))
    expect(requests('PATCH', '/api/task-lists/tl_1')).toHaveLength(1)
  })

  it.each([
    ['INVALID_NAME', '名称不能为空'],
    ['NAME_TOO_LONG', '名称过长'],
    ['SOMETHING_NEW', '操作失败，请稍后重试'],
  ] as const)('the server answering 422 %s renders inline; the form stays open and the list is not read again', async (code, copy) => {
    h_.renameReply.mockImplementation(() => jsonResponse(422, { error: { code } }))
    const bus = watchBus()
    const el = await mountAt('/task-lists/tl_1')
    await rename(el, 'Weekly shop')
    expect(text(el, 'tasks-list-detail-rename-error')).toBe(copy)
    expect((must(el, 'tasks-list-detail-rename-input') as HTMLInputElement).value).toBe('Weekly shop')
    expect(shown(el, 'tasks-list-detail-banner')).toBeNull()
    expect(listReads()).toBe(1)
    expect(bus).not.toHaveBeenCalled()
  })

  it.each([
    ['404', NOT_FOUND, '清单不可用或你已不是成员'],
    ['403', () => jsonResponse(403, { error: 'Insufficient permissions' }), '您没有权限修改此清单'],
    ['500', () => jsonResponse(500, {}), '操作失败，请稍后重试'],
    ['a malformed 200', () => jsonResponse(200, { id: 'tl_1' }), '操作失败，请稍后重试'],
    ['a transport failure', () => Promise.reject(new Error('offline')), '操作失败，请稍后重试'],
  ] as const)('a %s takes the page banner', async (_label, reply, copy) => {
    h_.renameReply.mockImplementation(reply)
    const el = await mountAt('/task-lists/tl_1')
    await rename(el, 'Weekly shop')
    expect(text(el, 'tasks-list-detail-banner')).toBe(copy)
    expect(must(el, 'tasks-list-detail-banner').getAttribute('role')).toBe('alert')
    expect(shown(el, 'tasks-list-detail-rename-error')).toBeNull()
  })

  it('422 ORG_MISSING switches to the org guidance block', async () => {
    h_.renameReply.mockImplementation(() => jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    const el = await mountAt('/task-lists/tl_1')
    await rename(el, 'Weekly shop')
    must(el, 'tasks-view-org-missing')
    expect(shown(el, 'tasks-list-detail')).toBeNull()
  })

  it('typing again clears the inline error', async () => {
    const el = await mountAt('/task-lists/tl_1')
    await rename(el, '​')
    must(el, 'tasks-list-detail-rename-error')
    await typeInto(el, 'tasks-list-detail-rename-input', 'Weekly shop')
    expect(shown(el, 'tasks-list-detail-rename-error')).toBeNull()
  })

  it('the next write clears the banner of the last one', async () => {
    h_.renameReply.mockImplementationOnce(() => jsonResponse(500, {}))
    const el = await mountAt('/task-lists/tl_1')
    await rename(el, 'Weekly shop')
    must(el, 'tasks-list-detail-banner')
    await submit(el, 'tasks-list-detail-rename-form')
    expect(shown(el, 'tasks-list-detail-banner')).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// Archive / unarchive
// ---------------------------------------------------------------------------------------------

describe('list page — archive and unarchive', () => {
  it('archive: POST …/archive with no body, the list is read again, the mark and unarchive appear, the lists bus hears it', async () => {
    const bus = watchBus()
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-archive')
    expect(requests('POST', '/api/task-lists/tl_1/archive')).toEqual([['/api/task-lists/tl_1/archive', { method: 'POST' }]])
    expect(listReads()).toBe(2)
    expect(text(el, 'tasks-list-detail-archived')).toBe('已归档')
    expect(shown(el, 'tasks-list-detail-archive')).toBeNull()
    expect(text(el, 'tasks-list-detail-unarchive')).toBe('取消归档')
    expect(bus).toHaveBeenCalledTimes(1)
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
  })

  it('unarchive: POST …/unarchive, the list is read again, the mark goes, the lists bus hears it', async () => {
    lists.tl_1 = listBody('tl_1', { archivedAt: '2031-02-01T00:00:00.000Z' })
    const bus = watchBus()
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-unarchive')
    expect(requests('POST', '/api/task-lists/tl_1/unarchive')).toHaveLength(1)
    expect(requests('POST', '/api/task-lists/tl_1/archive')).toHaveLength(0)
    expect(listReads()).toBe(2)
    expect(shown(el, 'tasks-list-detail-archived')).toBeNull()
    must(el, 'tasks-list-detail-archive')
    expect(bus).toHaveBeenCalledTimes(1)
  })

  it('the page shows what the re-read says, not the write response', async () => {
    h_.archiveReply.mockImplementation((id: string) => jsonResponse(200, { ...lists[id], archivedAt: '2031-02-01T00:00:00.000Z' }))
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-archive')
    // The fake server state was not changed by that reply, so the re-read still says not archived.
    expect(shown(el, 'tasks-list-detail-archived')).toBeNull()
    expect(listReads()).toBe(2)
  })

  it.each([
    ['404', NOT_FOUND, '清单不可用或你已不是成员'],
    ['403', () => jsonResponse(403, { error: 'Insufficient permissions' }), '您没有权限修改此清单'],
    ['500', () => jsonResponse(500, {}), '操作失败，请稍后重试'],
    ['an unexpected 422 code', () => jsonResponse(422, { error: { code: 'SOMETHING_NEW' } }), '操作失败，请稍后重试'],
  ] as const)('archive answered with a %s: the page banner, nothing re-read, the bus silent', async (_label, reply, copy) => {
    h_.archiveReply.mockImplementation(reply)
    const bus = watchBus()
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-archive')
    expect(text(el, 'tasks-list-detail-banner')).toBe(copy)
    expect(listReads()).toBe(1)
    expect(bus).not.toHaveBeenCalled()
  })

  it('archive answered 422 ORG_MISSING switches to the org guidance block', async () => {
    h_.archiveReply.mockImplementation(() => jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-archive')
    must(el, 'tasks-view-org-missing')
  })
})

// ---------------------------------------------------------------------------------------------
// Add a task / remove a task (PR-3a S7)
// ---------------------------------------------------------------------------------------------

describe('list page — add a task', () => {
  it('the submit button is disabled for a blank id, and a submitted blank id sends nothing', async () => {
    const el = await mountAt('/task-lists/tl_1')
    expect(disabled(el, 'tasks-list-detail-add-task-submit')).toBe(true)
    await addTask(el, '   ')
    expect(writes()).toEqual([])
  })

  it('ok: the trimmed id is sent, the input clears and the items are read again; no bus hears it', async () => {
    const bus = watchBus()
    const el = await mountAt('/task-lists/tl_1')
    await addTask(el, '  t9  ')
    expect(requests('POST', '/api/task-lists/tl_1/items').map(([, init]) => init?.body)).toEqual([JSON.stringify({ taskId: 't9' })])
    expect((must(el, 'tasks-list-detail-add-task-input') as HTMLInputElement).value).toBe('')
    expect(itemReads()).toBe(2)
    expect(itemRows(el).map((row) => row[0])).toEqual(['t1', 't2', 't9'])
    expect(listReads()).toBe(1)
    expect(bus).not.toHaveBeenCalled()
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
  })

  it.each([
    ['422 INVALID_TASK', () => jsonResponse(422, { error: { code: 'INVALID_TASK' } }), '无效的任务'],
    ['422 LIMIT', () => jsonResponse(422, { error: { code: 'LIMIT' } }), '一个任务最多属于 10 个清单'],
    ['422 with a code outside the contract', () => jsonResponse(422, { error: { code: 'SOMETHING_NEW' } }), '操作失败，请稍后重试'],
    ['404', NOT_FOUND, '任务不存在、你不是它的创建人或负责人，或清单不可用'],
  ] as const)('%s renders next to the form and keeps the typed id', async (_label, reply, copy) => {
    h_.addItemReply.mockImplementation(reply)
    const el = await mountAt('/task-lists/tl_1')
    await addTask(el, 't9')
    expect(text(el, 'tasks-list-detail-add-task-error')).toBe(copy)
    expect(must(el, 'tasks-list-detail-add-task-input').getAttribute('aria-invalid')).toBe('true')
    expect((must(el, 'tasks-list-detail-add-task-input') as HTMLInputElement).value).toBe('t9')
    expect(shown(el, 'tasks-list-detail-banner')).toBeNull()
    expect(itemReads()).toBe(1)
  })

  it.each([
    ['403', () => jsonResponse(403, { error: 'Insufficient permissions' }), '您没有权限修改此清单'],
    ['500', () => jsonResponse(500, {}), '操作失败，请稍后重试'],
  ] as const)('a %s takes the page banner', async (_label, reply, copy) => {
    h_.addItemReply.mockImplementation(reply)
    const el = await mountAt('/task-lists/tl_1')
    await addTask(el, 't9')
    expect(text(el, 'tasks-list-detail-banner')).toBe(copy)
    expect(shown(el, 'tasks-list-detail-add-task-error')).toBeNull()
  })

  it('422 ORG_MISSING switches to the org guidance block', async () => {
    h_.addItemReply.mockImplementation(() => jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    const el = await mountAt('/task-lists/tl_1')
    await addTask(el, 't9')
    must(el, 'tasks-view-org-missing')
  })

  it('typing again clears the inline error', async () => {
    h_.addItemReply.mockImplementation(NOT_FOUND)
    const el = await mountAt('/task-lists/tl_1')
    await addTask(el, 't9')
    must(el, 'tasks-list-detail-add-task-error')
    await typeInto(el, 'tasks-list-detail-add-task-input', 't8')
    expect(shown(el, 'tasks-list-detail-add-task-error')).toBeNull()
  })
})

describe('list page — remove a task', () => {
  it('asks first, inline: the remove button opens a confirmation, cancel sends nothing', async () => {
    const el = await mountAt('/task-lists/tl_1')
    expect(must(el, 'tasks-list-detail-item-remove').getAttribute('aria-label')).toBe('将「Task One」移出清单')
    await click(el, 'tasks-list-detail-item-remove')
    expect(text(el, 'tasks-list-detail-item-remove-confirm')).toContain('确认将此任务移出清单？')
    await click(el, 'tasks-list-detail-item-remove-confirm-cancel')
    expect(shown(el, 'tasks-list-detail-item-remove-confirm')).toBeNull()
    expect(writes()).toEqual([])
  })

  it('confirmed: DELETE …/items/:taskId, then the items are read again; no bus hears it', async () => {
    const bus = watchBus()
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-item-remove')
    await click(el, 'tasks-list-detail-item-remove-confirm-yes')
    expect(requests('DELETE', '/api/task-lists/tl_1/items/t1')).toEqual([['/api/task-lists/tl_1/items/t1', { method: 'DELETE' }]])
    expect(itemReads()).toBe(2)
    expect(itemRows(el).map((row) => row[0])).toEqual(['t2'])
    expect(bus).not.toHaveBeenCalled()
  })

  it('a task id that is not a safe path segment never reaches the transport', async () => {
    items.tl_1 = [item('..', 'Dots')]
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-item-remove')
    await click(el, 'tasks-list-detail-item-remove-confirm-yes')
    expect(writes()).toEqual([])
    expect(text(el, 'tasks-list-detail-banner')).toBe('清单不可用或你已不是成员')
  })

  it.each([
    ['404', NOT_FOUND, '清单不可用或你已不是成员'],
    ['403', () => jsonResponse(403, { error: 'Insufficient permissions' }), '您没有权限修改此清单'],
    ['500', () => jsonResponse(500, {}), '操作失败，请稍后重试'],
  ] as const)('a %s takes the page banner; the confirmation closes; nothing is re-read', async (_label, reply, copy) => {
    h_.removeItemReply.mockImplementation(reply)
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-item-remove')
    await click(el, 'tasks-list-detail-item-remove-confirm-yes')
    expect(text(el, 'tasks-list-detail-banner')).toBe(copy)
    expect(shown(el, 'tasks-list-detail-item-remove-confirm')).toBeNull()
    expect(itemReads()).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------
// One write at a time
// ---------------------------------------------------------------------------------------------

// [fe-50]: the remove confirmation and the rename form each replace the button that opened them, and
// cancel brings it back; the control the viewer used is gone either way. Each cell focuses the
// control it activates (a keyboard user's Enter) and checks the exact control focus moved to.
describe('list page — focus when the remove confirmation or the rename form opens and closes ([fe-50])', () => {
  async function press(control: HTMLElement): Promise<void> {
    control.focus()
    control.click()
    await flush()
  }

  function rowOf(el: HTMLElement, taskId: string): HTMLElement {
    const found = shownAll(el, 'tasks-list-detail-item').find((row) => row.getAttribute('data-task-id') === taskId)
    expect(found, `expected the row of ${taskId}`).toBeTruthy()
    return found as HTMLElement
  }

  it("opening a task's remove confirmation focuses its confirm button, which the prompt describes", async () => {
    const el = await mountAt('/task-lists/tl_1')
    await press(must(rowOf(el, 't2'), 'tasks-list-detail-item-remove'))
    const yes = must(rowOf(el, 't2'), 'tasks-list-detail-item-remove-confirm-yes')
    expect(document.activeElement).toBe(yes)
    const prompt = must(rowOf(el, 't2'), 'tasks-list-detail-item-remove-prompt')
    expect(prompt.textContent?.trim()).toBe('确认将此任务移出清单？')
    expect(yes.getAttribute('aria-describedby')).toBe(prompt.id)
    expect(document.getElementById(prompt.id)).toBe(prompt)
  })

  it("cancelling it focuses that task's remove button again", async () => {
    const el = await mountAt('/task-lists/tl_1')
    await press(must(rowOf(el, 't2'), 'tasks-list-detail-item-remove'))
    await press(must(rowOf(el, 't2'), 'tasks-list-detail-item-remove-confirm-cancel'))
    expect(shown(el, 'tasks-list-detail-item-remove-confirm')).toBeNull()
    expect(document.activeElement).toBe(must(rowOf(el, 't2'), 'tasks-list-detail-item-remove'))
    expect(writes()).toEqual([])
  })

  it('opening rename focuses the name input', async () => {
    const el = await mountAt('/task-lists/tl_1')
    await press(must(el, 'tasks-list-detail-rename'))
    expect(document.activeElement).toBe(must(el, 'tasks-list-detail-rename-input'))
  })

  it('cancelling rename focuses the rename button again', async () => {
    const el = await mountAt('/task-lists/tl_1')
    await press(must(el, 'tasks-list-detail-rename'))
    await press(must(el, 'tasks-list-detail-rename-cancel'))
    expect(shown(el, 'tasks-list-detail-rename-form')).toBeNull()
    expect(document.activeElement).toBe(must(el, 'tasks-list-detail-rename'))
    expect(writes()).toEqual([])
  })
})

describe('list page — one write at a time', () => {
  it('while a rename is in flight every write control is disabled, and other submits send nothing', async () => {
    const pending = deferred<Response>()
    h_.renameReply.mockImplementation(() => pending.promise)
    const el = await mountAt('/task-lists/tl_1')
    await rename(el, 'Weekly shop')
    expect(must(el, 'tasks-list-detail').getAttribute('aria-busy')).toBe('true')
    for (const id of [
      'tasks-list-detail-rename-input',
      'tasks-list-detail-rename-submit',
      'tasks-list-detail-rename-cancel',
      'tasks-list-detail-archive',
      'tasks-list-detail-add-task-input',
      'tasks-list-detail-add-task-submit',
      'tasks-list-detail-pick-task',
      'list-create-title',
      'list-create-submit',
      'tasks-list-detail-item-remove',
    ]) {
      expect(disabled(el, id), id).toBe(true)
    }
    await submit(el, 'tasks-list-detail-rename-form')
    await typeInto(el, 'list-create-title', 'Second write')
    await submit(el, 'list-create-form')
    await typeInto(el, 'tasks-list-detail-add-task-input', 't9')
    await submit(el, 'tasks-list-detail-add-task-form')
    expect(writes()).toHaveLength(1)
    pending.resolve(jsonResponse(200, { ...lists.tl_1, name: 'Weekly shop' }))
    await flush()
    expect(disabled(el, 'tasks-list-detail-archive')).toBe(false)
  })

  it('while archive is in flight a second click and a rename send nothing', async () => {
    const pending = deferred<Response>()
    h_.archiveReply.mockImplementation(() => pending.promise)
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-archive')
    expect(disabled(el, 'tasks-list-detail-archive')).toBe(true)
    expect(disabled(el, 'tasks-list-detail-rename')).toBe(true)
    ;(must(el, 'tasks-list-detail-archive') as HTMLButtonElement).disabled = false
    await click(el, 'tasks-list-detail-archive')
    expect(writes()).toHaveLength(1)
    pending.resolve(jsonResponse(200, lists.tl_1))
    await flush()
  })

  it('while an add is in flight the remove and archive controls are disabled; a remove confirmation sends nothing', async () => {
    const pending = deferred<Response>()
    h_.addItemReply.mockImplementation(() => pending.promise)
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-item-remove')
    await addTask(el, 't9')
    expect(disabled(el, 'tasks-list-detail-item-remove-confirm-yes')).toBe(true)
    expect(disabled(el, 'tasks-list-detail-archive')).toBe(true)
    ;(must(el, 'tasks-list-detail-item-remove-confirm-yes') as HTMLButtonElement).disabled = false
    await click(el, 'tasks-list-detail-item-remove-confirm-yes')
    expect(writes()).toHaveLength(1)
    pending.resolve(jsonResponse(200, { listId: 'tl_1', taskId: 't9' }))
    await flush()
  })

  it('the controls come back after the re-read that follows an ok, not before', async () => {
    const reread = deferred<Response>()
    let reads = 0
    h_.listReply.mockImplementation((id: string) => {
      reads += 1
      return reads === 2 ? reread.promise : jsonResponse(200, lists[id])
    })
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-archive')
    // The archive answered; the re-read is still out: the page keeps its content, writes stay off.
    must(el, 'tasks-list-detail')
    expect(disabled(el, 'tasks-list-detail-rename')).toBe(true)
    reread.resolve(jsonResponse(200, lists.tl_1))
    await flush()
    expect(disabled(el, 'tasks-list-detail-rename')).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// Route edges and late results
// ---------------------------------------------------------------------------------------------

describe('list page — another list, and results that land late', () => {
  it('a route edge resets drafts, errors, the confirmation, the banner and the activity panel, then reads the new list', async () => {
    h_.addItemReply.mockImplementation(NOT_FOUND)
    h_.archiveReply.mockImplementation(() => jsonResponse(500, {}))
    // t1 is in both lists, so a confirmation left open on it would show on the new list too.
    items.tl_2 = [item('t3', 'Task Three'), item('t1', 'Task One')]
    const el = await mountAt('/task-lists/tl_1')
    await addTask(el, 't9')
    must(el, 'tasks-list-detail-add-task-error')
    await click(el, 'tasks-list-detail-item-remove')
    await click(el, 'tasks-list-detail-rename')
    await typeInto(el, 'tasks-list-detail-rename-input', '​')
    await submit(el, 'tasks-list-detail-rename-form')
    must(el, 'tasks-list-detail-rename-error')
    await click(el, 'tasks-list-detail-events-toggle')
    must(el, 'tasks-list-detail-events')
    // Last before the edge: every other write here clears the banner when it starts.
    await click(el, 'tasks-list-detail-archive')
    must(el, 'tasks-list-detail-banner')
    must(el, 'tasks-list-detail-add-task-error')
    must(el, 'tasks-list-detail-item-remove-confirm')
    must(el, 'tasks-list-detail-rename-error')

    await go('/task-lists/tl_2')
    expect(text(el, 'tasks-list-detail-title')).toBe('Chores')
    expect(listReads('tl_2')).toBe(1)
    expect(itemReads('tl_2')).toBe(1)
    expect(itemRows(el)).toEqual([['t3', 'Task Three'], ['t1', 'Task One']])
    expect(shown(el, 'tasks-list-detail-banner')).toBeNull()
    expect(shown(el, 'tasks-list-detail-add-task-error')).toBeNull()
    expect((must(el, 'tasks-list-detail-add-task-input') as HTMLInputElement).value).toBe('')
    expect(shown(el, 'tasks-list-detail-item-remove-confirm')).toBeNull()
    expect(shown(el, 'tasks-list-detail-rename-form')).toBeNull()
    expect(shown(el, 'tasks-list-detail-events')).toBeNull()
    expect(must(el, 'tasks-list-detail-events-toggle').getAttribute('aria-expanded')).toBe('false')
  })

  it('a list read that lands after the route moved on does not paint over the new list', async () => {
    const first = deferred<Response>()
    h_.listReply.mockImplementation((id: string) => (id === 'tl_1' ? first.promise : jsonResponse(200, lists[id])))
    const el = await mountAt('/task-lists/tl_1')
    await go('/task-lists/tl_2')
    expect(text(el, 'tasks-list-detail-title')).toBe('Chores')
    first.resolve(jsonResponse(200, lists.tl_1))
    await flush()
    expect(text(el, 'tasks-list-detail-title')).toBe('Chores')
  })

  it('an items read that lands after the route moved on does not paint over the new list', async () => {
    const first = deferred<Response>()
    h_.itemsReply.mockImplementation((id: string, query: string) => (id === 'tl_1' ? first.promise : page(items[id], query)))
    const el = await mountAt('/task-lists/tl_1')
    await go('/task-lists/tl_2')
    expect(itemRows(el)).toEqual([['t3', 'Task Three']])
    first.resolve(page(items.tl_1, 'offset=0'))
    await flush()
    expect(itemRows(el)).toEqual([['t3', 'Task Three']])
  })

  it('an archive answered after the route moved on: no re-read, nothing painted on the new list, the bus still hears it once', async () => {
    const pending = deferred<Response>()
    h_.archiveReply.mockImplementation(() => pending.promise)
    const bus = watchBus()
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-archive')
    await go('/task-lists/tl_2')
    expect(disabled(el, 'tasks-list-detail-archive')).toBe(false)
    pending.resolve(jsonResponse(200, { ...lists.tl_1, archivedAt: '2031-02-01T00:00:00.000Z' }))
    await flush()
    expect(listReads('tl_1')).toBe(1)
    // Not re-read under the list now showing either.
    expect(listReads('tl_2')).toBe(1)
    expect(text(el, 'tasks-list-detail-title')).toBe('Chores')
    expect(shown(el, 'tasks-list-detail-archived')).toBeNull()
    expect(bus).toHaveBeenCalledTimes(1)
  })

  it('a rename answered with a 403 after the route moved on paints no banner', async () => {
    const pending = deferred<Response>()
    h_.renameReply.mockImplementation(() => pending.promise)
    const el = await mountAt('/task-lists/tl_1')
    await rename(el, 'Weekly shop')
    await go('/task-lists/tl_2')
    pending.resolve(jsonResponse(403, { error: 'Insufficient permissions' }))
    await flush()
    expect(shown(el, 'tasks-list-detail-banner')).toBeNull()
  })

  it('an add answered with a 404 after the route moved on paints no inline error', async () => {
    const pending = deferred<Response>()
    h_.addItemReply.mockImplementation(() => pending.promise)
    const el = await mountAt('/task-lists/tl_1')
    await addTask(el, 't9')
    await go('/task-lists/tl_2')
    pending.resolve(NOT_FOUND())
    await flush()
    expect(shown(el, 'tasks-list-detail-add-task-error')).toBeNull()
  })

  it('a remove answered after the route moved on reads nothing — not the old list\'s items, nothing for the new list either', async () => {
    const pending = deferred<Response>()
    h_.removeItemReply.mockImplementation(() => pending.promise)
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-item-remove')
    await click(el, 'tasks-list-detail-item-remove-confirm-yes')
    await go('/task-lists/tl_2')
    const before = fetchCalls().length
    pending.resolve(jsonResponse(200, { listId: 'tl_1', taskId: 't1' }))
    await flush()
    expect(fetchCalls().slice(before)).toEqual([])
    expect(itemReads('tl_1')).toBe(1)
    expect(itemRows(el)).toEqual([['t3', 'Task Three']])
  })

  it('a remove answered with a 404 after the route moved on paints no banner', async () => {
    const pending = deferred<Response>()
    h_.removeItemReply.mockImplementation(() => pending.promise)
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-item-remove')
    await click(el, 'tasks-list-detail-item-remove-confirm-yes')
    await go('/task-lists/tl_2')
    pending.resolve(NOT_FOUND())
    await flush()
    expect(text(el, 'tasks-list-detail-title')).toBe('Chores')
    expect(shown(el, 'tasks-list-detail-banner')).toBeNull()
  })

  // Left for a task page: that route has an `:id` too, so a result acted on after leaving would
  // read under the task's id.
  it('a rename answered after the page was left for a task: no list read at all, the bus still hears it once', async () => {
    const pending = deferred<Response>()
    h_.renameReply.mockImplementation(() => pending.promise)
    const bus = watchBus()
    const el = await mountAt('/task-lists/tl_1')
    await rename(el, 'Weekly shop')
    await go('/tasks/t1')
    must(el, 'other-page')
    const before = fetchCalls().length
    pending.resolve(jsonResponse(200, { ...lists.tl_1, name: 'Weekly shop' }))
    await flush()
    expect(fetchCalls().slice(before)).toEqual([])
    expect(listReads()).toBe(1)
    expect(bus).toHaveBeenCalledTimes(1)
  })

  it('an add answered after the page was left for a task: no items read at all', async () => {
    const pending = deferred<Response>()
    h_.addItemReply.mockImplementation(() => pending.promise)
    const el = await mountAt('/task-lists/tl_1')
    await addTask(el, 't9')
    await go('/tasks/t1')
    const before = fetchCalls().length
    pending.resolve(jsonResponse(200, { listId: 'tl_1', taskId: 't9' }))
    await flush()
    expect(fetchCalls().slice(before)).toEqual([])
    expect(itemReads()).toBe(1)
  })

  it('a remove answered after the page was left for a task: no request at all, none under the task id', async () => {
    const pending = deferred<Response>()
    h_.removeItemReply.mockImplementation(() => pending.promise)
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-item-remove')
    await click(el, 'tasks-list-detail-item-remove-confirm-yes')
    await go('/tasks/t1')
    must(el, 'other-page')
    const before = fetchCalls().length
    pending.resolve(jsonResponse(200, { listId: 'tl_1', taskId: 't1' }))
    await flush()
    expect(fetchCalls().slice(before)).toEqual([])
  })

  it('a context read that lands after the page was left sends no list request', async () => {
    const context = deferred<{ state: string; orgId: string }>()
    h_.loadTasksContext.mockImplementation(() => context.promise)
    const el = await mountAt('/task-lists/tl_1')
    must(el, 'tasks-list-detail-loading')
    await go('/tasks/t1')
    must(el, 'other-page')
    const before = fetchCalls().length
    context.resolve({ state: 'ready', orgId: 'org1' })
    await flush()
    expect(fetchCalls().slice(before)).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// The activity panel (`…/events`, PR-3a S5)
// ---------------------------------------------------------------------------------------------

describe('list page — activity', () => {
  it('is closed until asked for, and nothing is read before', async () => {
    const el = await mountAt('/task-lists/tl_1')
    expect(must(el, 'tasks-list-detail-events-toggle').getAttribute('aria-expanded')).toBe('false')
    expect(text(el, 'tasks-list-detail-events-toggle')).toBe('动态')
    expect(shown(el, 'tasks-list-detail-events')).toBeNull()
    expect(fetchCalls().filter(([path]) => path.includes('/events'))).toEqual([])
  })

  it('opening reads the first page; each event shows who, the word for its type and when; an unknown type shows as sent', async () => {
    events.tl_1 = [
      event('ev3', 'archived', { actorId: 'u2' }),
      event('ev2', 'renamed'),
      event('ev1', 'something_new'),
    ]
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-events-toggle')
    expect(must(el, 'tasks-list-detail-events-toggle').getAttribute('aria-expanded')).toBe('true')
    expect(requests('GET', '/api/task-lists/tl_1/events?limit=100&offset=0')).toHaveLength(1)
    const rows = shownAll(el, 'tasks-list-detail-event').map((row) => [
      row.getAttribute('data-event-type'),
      row.querySelector('[data-testid="tasks-list-detail-event-actor"]')?.textContent?.trim(),
      row.querySelector('[data-testid="tasks-list-detail-event-type"]')?.textContent?.trim(),
    ])
    expect(rows).toEqual([
      ['archived', 'u2', '归档了清单'],
      ['renamed', 'u1', '重命名了清单'],
      ['something_new', 'u1', 'something_new'],
    ])
    expect(text(el, 'tasks-list-detail-event-time')).toBe(formatViewerInstant('2031-03-01T08:00:00.000Z', undefined, 'zh-CN'))
  })

  it('every word of the closed set renders its copy', async () => {
    const words: Array<[string, string]> = [
      ['created', '创建了清单'],
      ['renamed', '重命名了清单'],
      ['archived', '归档了清单'],
      ['unarchived', '取消归档了清单'],
      ['owner_transferred', '转让了所有权'],
      ['member_added', '添加了成员'],
      ['member_removed', '移除了成员'],
      ['member_role_changed', '更改了成员角色'],
      ['item_added', '加入了任务'],
      ['item_removed', '移出了任务'],
      ['group_created', '新建了分组'],
      ['group_renamed', '重命名了分组'],
      ['group_deleted', '删除了分组'],
      ['field_bound', '绑定了字段'],
      ['field_unbound', '解绑了字段'],
    ]
    events.tl_1 = words.map(([type], i) => event(`ev${i}`, type))
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-events-toggle')
    expect(shownAll(el, 'tasks-list-detail-event-type').map((node) => node.textContent?.trim())).toEqual(words.map(([, copy]) => copy))
  })

  it('empty and failed reads are told apart', async () => {
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-events-toggle')
    expect(text(el, 'tasks-list-detail-events-empty')).toBe('暂无动态')
    await click(el, 'tasks-list-detail-events-toggle')
    h_.eventsReply.mockImplementation(NOT_FOUND)
    await click(el, 'tasks-list-detail-events-toggle')
    expect(text(el, 'tasks-list-detail-events-error')).toBe('加载动态失败，请稍后重试')
    expect(shown(el, 'tasks-list-detail-events-empty')).toBeNull()
  })

  it('load more pages by 100 until total; a row seen twice is kept once', async () => {
    events.tl_1 = Array.from({ length: 150 }, (_, i) => event(`ev${String(i).padStart(3, '0')}`, 'renamed'))
    h_.eventsReply.mockImplementation((id: string, query: string) => {
      const offset = Number(new URLSearchParams(query).get('offset'))
      if (offset === 0) return page(events[id], query)
      return jsonResponse(200, { items: [events[id][99], ...events[id].slice(100)], total: 150 })
    })
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-events-toggle')
    expect(shownAll(el, 'tasks-list-detail-event')).toHaveLength(100)
    expect(text(el, 'tasks-list-detail-events-more')).toBe('加载更多')
    await click(el, 'tasks-list-detail-events-more')
    expect(requests('GET', '/api/task-lists/tl_1/events?limit=100&offset=100')).toHaveLength(1)
    expect(shownAll(el, 'tasks-list-detail-event')).toHaveLength(150)
    expect(shown(el, 'tasks-list-detail-events-more')).toBeNull()
  })

  it('a failed next page keeps the rows and says so', async () => {
    events.tl_1 = Array.from({ length: 150 }, (_, i) => event(`ev${i}`, 'renamed'))
    h_.eventsReply.mockImplementation((id: string, query: string) =>
      Number(new URLSearchParams(query).get('offset')) === 0 ? page(events[id], query) : jsonResponse(500, {}),
    )
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-events-toggle')
    await click(el, 'tasks-list-detail-events-more')
    expect(shownAll(el, 'tasks-list-detail-event')).toHaveLength(100)
    expect(text(el, 'tasks-list-detail-events-more-error')).toBe('加载动态失败，请稍后重试')
  })

  it("a next page of the old list that lands after the route moved on stays out of the new list's activity", async () => {
    events.tl_1 = Array.from({ length: 150 }, (_, i) => event(`ev${String(i).padStart(3, '0')}`, 'renamed'))
    events.tl_2 = [event('ev_b', 'created', { listId: 'tl_2' })]
    const more = deferred<Response>()
    h_.eventsReply.mockImplementation((id: string, query: string) =>
      id === 'tl_1' && Number(new URLSearchParams(query).get('offset')) === 100 ? more.promise : page(events[id], query),
    )
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-events-toggle')
    await click(el, 'tasks-list-detail-events-more')
    await go('/task-lists/tl_2')
    await click(el, 'tasks-list-detail-events-toggle')
    expect(shownAll(el, 'tasks-list-detail-event')).toHaveLength(1)
    more.resolve(page(events.tl_1, 'offset=100'))
    await flush()
    expect(shownAll(el, 'tasks-list-detail-event')).toHaveLength(1)
    expect(shown(el, 'tasks-list-detail-events-more')).toBeNull()
  })

  it('a read that lands after the panel was closed is dropped; reopening reads again', async () => {
    const first = deferred<Response>()
    h_.eventsReply.mockImplementationOnce(() => first.promise)
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-events-toggle')
    must(el, 'tasks-list-detail-events-loading')
    await click(el, 'tasks-list-detail-events-toggle')
    await click(el, 'tasks-list-detail-events-toggle')
    expect(text(el, 'tasks-list-detail-events-empty')).toBe('暂无动态')
    first.resolve(jsonResponse(200, { items: [event('ev_old', 'created')], total: 1 }))
    await flush()
    expect(shown(el, 'tasks-list-detail-event')).toBeNull()
    expect(requests('GET', '/api/task-lists/tl_1/events?limit=100&offset=0')).toHaveLength(2)
  })

  it('an activity read that lands after the route moved on does not open on the new list', async () => {
    const first = deferred<Response>()
    h_.eventsReply.mockImplementationOnce(() => first.promise)
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-events-toggle')
    await go('/task-lists/tl_2')
    first.resolve(jsonResponse(200, { items: [event('ev_old', 'created')], total: 1 }))
    await flush()
    expect(shown(el, 'tasks-list-detail-events')).toBeNull()
    await click(el, 'tasks-list-detail-events-toggle')
    expect(requests('GET', '/api/task-lists/tl_2/events?limit=100&offset=0')).toHaveLength(1)
    expect(shown(el, 'tasks-list-detail-event')).toBeNull()
  })

  it('the degraded no-org body on the activity read switches to the org guidance block', async () => {
    h_.eventsReply.mockImplementation(() => jsonResponse(200, { items: [], degraded: true, reason: 'org_missing' }))
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-events-toggle')
    must(el, 'tasks-view-org-missing')
  })
})

describe('list page — activity — names', () => {
  /** The ids of each people lookup, in the order they were sent. */
  const lookups = () => h_.peopleReply.mock.calls.map(([query]) => (new URLSearchParams(query as string).get('ids') ?? '').split(','))
  const actorTexts = (el: HTMLElement) => shownAll(el, 'tasks-list-detail-event-actor').map((node) => node.textContent?.trim())
  /** A lookup answer naming each `[id, name]`. */
  const named = (people: Array<[string, string]>) =>
    jsonResponse(200, { items: people.map(([id, name]) => ({ id, name, detail: '', canUseTasks: true })), truncated: false })
  /** 150 events: the first page by u1 only, the second by u1 and u2. */
  const twoPages = () =>
    Array.from({ length: 150 }, (_, i) => event(`ev${String(i).padStart(3, '0')}`, 'renamed', { actorId: i < 100 || i % 2 === 0 ? 'u1' : 'u2' }))
  /** `count` events, each by its own actor u0, u1, …, in that order. */
  const ownActors = (count: number) =>
    Array.from({ length: count }, (_, i) => event(`ev${String(i).padStart(2, '0')}`, 'renamed', { actorId: `u${i}` }))

  it('names replace the actor ids, one lookup for the distinct actors of the page; an actor it leaves out, or whose id holds a comma, stays an id', async () => {
    events.tl_1 = [
      event('ev5', 'archived', { actorId: 'u2' }),
      event('ev4', 'renamed'),
      event('ev3', 'renamed'),
      event('ev2', 'created', { actorId: 'u3' }),
      event('ev1', 'created', { actorId: 'u,9' }),
    ]
    h_.peopleReply.mockImplementation(() => named([['u1', 'Ann'], ['u2', 'Bo'], ['u,9', 'Cy']]))
    const el = await mountAt('/task-lists/tl_1')
    expect(lookups()).toEqual([])
    await click(el, 'tasks-list-detail-events-toggle')
    await flush()
    expect(lookups()).toEqual([['u2', 'u1', 'u3']])
    expect(actorTexts(el)).toEqual(['Bo', 'Ann', 'Ann', 'u3', 'u,9'])
  })

  it('a page that lands after the panel closed is not looked up; reopening looks up the page it reads', async () => {
    events.tl_1 = [event('ev1', 'renamed', { actorId: 'u2' })]
    const first = deferred<Response>()
    h_.eventsReply.mockImplementationOnce(() => first.promise)
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-events-toggle')
    await click(el, 'tasks-list-detail-events-toggle')
    first.resolve(jsonResponse(200, { items: [event('ev_old', 'created', { actorId: 'u9' })], total: 1 }))
    await flush()
    expect(lookups()).toEqual([])
    await click(el, 'tasks-list-detail-events-toggle')
    await flush()
    expect(lookups()).toEqual([['u2']])
  })

  it('load more looks up only the actors not asked yet', async () => {
    events.tl_1 = twoPages()
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-events-toggle')
    await flush()
    expect(lookups()).toEqual([['u1']])
    await click(el, 'tasks-list-detail-events-more')
    await flush()
    expect(lookups()).toEqual([['u1'], ['u2']])
  })

  it('sixty actors are looked up as fifty, then ten once the first answer is in', async () => {
    events.tl_1 = ownActors(60)
    const firstLookup = deferred<Response>()
    h_.peopleReply.mockImplementationOnce(() => firstLookup.promise)
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-events-toggle')
    await flush()
    expect(lookups().map((ids) => ids.length)).toEqual([50])
    expect(lookups()[0]).toEqual(Array.from({ length: 50 }, (_, i) => `u${i}`))
    firstLookup.resolve(named([['u0', 'Ann']]))
    await flush()
    expect(lookups().map((ids) => ids.length)).toEqual([50, 10])
    expect(lookups()[1]).toEqual(Array.from({ length: 10 }, (_, i) => `u${50 + i}`))
    expect(actorTexts(el).slice(0, 2)).toEqual(['Ann', 'u1'])
  })

  it('twenty actors with 255-character ids are looked up as sixteen and four, each part at most 4096 characters', async () => {
    const longId = (i: number) => `${'a'.repeat(253)}${String(i).padStart(2, '0')}`
    events.tl_1 = Array.from({ length: 20 }, (_, i) => event(`ev${String(i).padStart(2, '0')}`, 'renamed', { actorId: longId(i) }))
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-events-toggle')
    await flush()
    expect(lookups().map((ids) => ids.length)).toEqual([16, 4])
    expect(lookups().map((ids) => ids.join(',').length)).toEqual([4095, 1023])
    expect(actorTexts(el)[0]).toBe(longId(0))
  })

  it('a 403 lookup leaves the ids, and nothing is looked up again: not on reopening, not for the new actor of the next page', async () => {
    events.tl_1 = twoPages()
    h_.peopleReply.mockImplementation(() => jsonResponse(403, { error: 'Insufficient permissions' }))
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-events-toggle')
    await flush()
    expect(lookups()).toEqual([['u1']])
    expect(actorTexts(el)[0]).toBe('u1')
    await click(el, 'tasks-list-detail-events-toggle')
    await click(el, 'tasks-list-detail-events-toggle')
    await click(el, 'tasks-list-detail-events-more')
    await flush()
    expect(lookups()).toEqual([['u1']])
    expect(actorTexts(el)).toContain('u2')
  })

  it.each([
    ['a 429', () => jsonResponse(429, { error: { code: 'RATE_LIMITED' } })],
    ['a 500', () => jsonResponse(500, {})],
    ['a malformed 200', () => jsonResponse(200, { items: [{ id: 'u1' }], truncated: false })],
    ['a transport failure', () => Promise.reject(new TypeError('network down'))],
  ] as const)("%s leaves the IDs visible until reopening retries the lookup", async (_label, reply) => {
    events.tl_1 = twoPages()
    h_.peopleReply.mockImplementationOnce(reply).mockImplementation(() => named([['u1', 'Ann'], ['u2', 'Bo']]))
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-events-toggle')
    await flush()
    expect(actorTexts(el)[0]).toBe('u1')
    await click(el, 'tasks-list-detail-events-toggle')
    await click(el, 'tasks-list-detail-events-toggle')
    await click(el, 'tasks-list-detail-events-more')
    await flush()
    expect(lookups()).toEqual([['u1'], ['u1'], ['u2']])
    expect(new Set(actorTexts(el))).toEqual(new Set(['Ann', 'Bo']))
  })

  it('reopening retries the failed and unsent batches while keeping successful names', async () => {
    const ids = Array.from({ length: 34 }, (_, i) => 'a'.repeat(253) + String(i).padStart(2, '0'))
    events.tl_1 = ids.map((id, i) => event(String(i), 'renamed', { actorId: id }))
    h_.peopleReply.mockImplementationOnce(() => named([[ids[0], 'Ann']]))
      .mockImplementationOnce(() => jsonResponse(500, {}))
      .mockImplementationOnce(() => named([[ids[16], 'Bo']]))
      .mockImplementationOnce(() => named([[ids[32], 'Cy']]))
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-events-toggle')
    await flush()
    expect(lookups()).toEqual([ids.slice(0, 16), ids.slice(16, 32)])
    expect(actorTexts(el)[16]).toBe(ids[16])
    await click(el, 'tasks-list-detail-events-toggle')
    await click(el, 'tasks-list-detail-events-toggle')
    await flush()
    expect(lookups()).toEqual([ids.slice(0, 16), ids.slice(16, 32), ids.slice(16, 32), ids.slice(32)])
    expect([0, 16, 32].map((index) => actorTexts(el)[index])).toEqual(['Ann', 'Bo', 'Cy'])
  })

  it("a route edge drops the old list's names: the new list's actor is asked again, and shows its id until the answer", async () => {
    events.tl_1 = [event('ev1', 'renamed', { actorId: 'u2' })]
    events.tl_2 = [event('ev_b', 'created', { listId: 'tl_2', actorId: 'u2' })]
    h_.peopleReply.mockImplementationOnce(() => named([['u2', 'Bo']]))
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-events-toggle')
    await flush()
    expect(actorTexts(el)).toEqual(['Bo'])
    const second = deferred<Response>()
    h_.peopleReply.mockImplementationOnce(() => second.promise)
    await go('/task-lists/tl_2')
    await click(el, 'tasks-list-detail-events-toggle')
    expect(lookups()).toEqual([['u2'], ['u2']])
    expect(actorTexts(el)).toEqual(['u2'])
    second.resolve(named([['u2', 'Bo']]))
    await flush()
    expect(actorTexts(el)).toEqual(['Bo'])
  })

  it('a lookup answered after the route moved on names nothing on the new list', async () => {
    events.tl_1 = [event('ev1', 'renamed', { actorId: 'u2' })]
    events.tl_2 = [event('ev_b', 'created', { listId: 'tl_2', actorId: 'u2' })]
    const late = deferred<Response>()
    h_.peopleReply.mockImplementationOnce(() => late.promise)
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-events-toggle')
    await go('/task-lists/tl_2')
    await click(el, 'tasks-list-detail-events-toggle')
    await flush()
    late.resolve(named([['u2', 'Bo']]))
    await flush()
    expect(lookups()).toEqual([['u2'], ['u2']])
    expect(actorTexts(el)).toEqual(['u2'])
  })

  it('nothing is looked up once the page is left: the rest of a split lookup is not sent', async () => {
    events.tl_1 = ownActors(60)
    const firstLookup = deferred<Response>()
    h_.peopleReply.mockImplementationOnce(() => firstLookup.promise)
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-events-toggle')
    await go('/tasks')
    must(el, 'other-page')
    firstLookup.resolve(named([['u0', 'Ann']]))
    await flush()
    expect(lookups().map((ids) => ids.length)).toEqual([50])
  })

  describe('account switches', () => {
    const fakeToken = (payload: Record<string, unknown>) => `h.${btoa(JSON.stringify(payload)).replace(/=+$/, '')}.s`
    const TOKEN_A = fakeToken({ sub: 'u1', exp: 4102444800 })
    const TOKEN_A_REFRESHED = fakeToken({ sub: 'u1', exp: 4102448400 })
    const TOKEN_B = fakeToken({ sub: 'u9', exp: 4102444800 })
    /** Another tab signs in: the shared storage changes and this tab is told nothing. */
    const signIn = (token: string) => localStorage.setItem('auth_token', token)
    /** The same, plus the `storage` event a browser delivers to the other tabs. */
    const signInElsewhereWithEvent = (token: string) => {
      signIn(token)
      window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token', newValue: token }))
    }
    /** A sign-in in this tab: the session switch `useAuth` announces. */
    const signInHere = (token: string) => {
      signIn(token)
      notifyAuthPrincipalChange()
    }

    beforeEach(() => {
      localStorage.removeItem('auth_token')
      signIn(TOKEN_A)
      events.tl_1 = [event('ev1', 'renamed', { actorId: 'u2' })]
      h_.peopleReply.mockImplementation(() => named([['u2', 'Bo']]))
    })

    afterEach(() => {
      localStorage.removeItem('auth_token')
    })

    for (const [how, switchTo] of [
      ['another tab (a storage change)', signInElsewhereWithEvent],
      ['this tab (a session switch)', signInHere],
    ] as Array<[string, (token: string) => void]>) {
      it(`a switch to another account from ${how} drops the names`, async () => {
        const el = await mountAt('/task-lists/tl_1')
        await click(el, 'tasks-list-detail-events-toggle')
        await flush()
        expect(actorTexts(el)).toEqual(['Bo'])
        switchTo(TOKEN_B)
        await flush()
        expect(actorTexts(el)).toEqual(['u2'])
      })

      it(`a lookup asked before a switch seen from ${how} that lands after it is dropped`, async () => {
        const late = deferred<Response>()
        h_.peopleReply.mockImplementationOnce(() => late.promise)
        const el = await mountAt('/task-lists/tl_1')
        await click(el, 'tasks-list-detail-events-toggle')
        expect(lookups()).toEqual([['u2']])
        switchTo(TOKEN_B)
        await flush()
        late.resolve(named([['u2', 'Bo']]))
        await flush()
        expect(actorTexts(el)).toEqual(['u2'])
      })
    }

    it('a lookup that lands after a silent switch to another account is dropped', async () => {
      const late = deferred<Response>()
      h_.peopleReply.mockImplementationOnce(() => late.promise)
      const el = await mountAt('/task-lists/tl_1')
      await click(el, 'tasks-list-detail-events-toggle')
      expect(lookups()).toEqual([['u2']])
      signIn(TOKEN_B)
      late.resolve(named([['u2', 'Bo']]))
      await flush()
      expect(actorTexts(el)).toEqual(['u2'])
    })

    it('negative control: a token refresh for the same person keeps the names', async () => {
      const el = await mountAt('/task-lists/tl_1')
      await click(el, 'tasks-list-detail-events-toggle')
      await flush()
      expect(actorTexts(el)).toEqual(['Bo'])
      signInElsewhereWithEvent(TOKEN_A_REFRESHED)
      notifyAuthPrincipalChange()
      await flush()
      expect(actorTexts(el)).toEqual(['Bo'])
    })
  })
})

// ---------------------------------------------------------------------------------------------
// A task picked by title: the picker searches the viewer's created and assigned tasks after a
// pause; the task-id form stays, folded under a toggle.
// ---------------------------------------------------------------------------------------------

describe('list page — a task picked by title', () => {
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 350))

  const found = (rows: Array<Record<string, unknown>>, total = rows.length) => jsonResponse(200, { items: rows, total })

  function taskSearches(): Array<{ view: string | null; status: string | null; q: string | null }> {
    return fetchCalls()
      .filter(([path, init]) => path.startsWith('/api/tasks?') && (init?.method ?? 'GET') === 'GET')
      .map(([path]) => {
        const params = new URLSearchParams(path.split('?')[1])
        return { view: params.get('view'), status: params.get('status'), q: params.get('q') }
      })
  }

  function placementReads(id = 'tl_1'): number {
    return fetchCalls().filter(([path]) => path.startsWith(`/api/task-lists/${id}/group-items?`)).length
  }

  async function openTaskPicker(el: HTMLElement): Promise<void> {
    await click(el, 'tasks-list-detail-pick-task')
  }

  async function searchTasks(el: HTMLElement, value: string): Promise<void> {
    await typeInto(el, 'task-picker-search', value)
    await pause()
    await flush()
  }

  function pickerRowIds(el: HTMLElement): string[] {
    return shownAll(el, 'task-picker-row').map((row) => row.getAttribute('data-task-id') ?? '')
  }

  function choose(el: HTMLElement, id: string): void {
    el.querySelector<HTMLInputElement>(`[data-testid="task-picker-row"][data-task-id="${id}"] input[type="radio"]`)!.click()
  }

  it('the pick button sits next to a task-id form folded under its toggle; nothing is read on mount or for a blank term', async () => {
    const el = await mountAt('/task-lists/tl_1')
    expect(text(el, 'tasks-list-detail-pick-task')).toBe('选择任务')
    const form = must(el, 'tasks-list-detail-add-task-form')
    const toggle = must(el, 'tasks-list-detail-add-task-by-id-toggle')
    expect(toggle.textContent?.trim()).toBe('按任务 ID 加入')
    expect(form.style.display).toBe('none')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await click(el, 'tasks-list-detail-add-task-by-id-toggle')
    expect(form.style.display).toBe('')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    await openTaskPicker(el)
    expect(text(el, 'task-picker-type-hint')).toBe('输入标题开始搜索')
    await searchTasks(el, '   ')
    expect(text(el, 'task-picker-type-hint')).toBe('输入标题开始搜索')
    expect(taskSearches()).toEqual([])
  })

  it('a term is searched once after the pause, in the created and the assigned views, any status, as normalized', async () => {
    const el = await mountAt('/task-lists/tl_1')
    await openTaskPicker(el)
    await typeInto(el, 'task-picker-search', '  Plan  ')
    expect(taskSearches()).toEqual([])
    await pause()
    await flush()
    expect(taskSearches()).toEqual([
      { view: 'created', status: 'all', q: 'Plan' },
      { view: 'assigned', status: 'all', q: 'Plan' },
    ])
  })

  it('answers to an older term are dropped', async () => {
    const late = deferred<Response>()
    h_.tasksReply.mockImplementation((_view: string, _status: string, q: string) => (q === 'Pl' ? late.promise : found([item('t7', 'Plan A')])))
    const el = await mountAt('/task-lists/tl_1')
    await openTaskPicker(el)
    await searchTasks(el, 'Pl')
    expect(shown(el, 'task-picker-loading')).toBeTruthy()
    await searchTasks(el, 'Plan')
    expect(pickerRowIds(el)).toEqual(['t7'])
    late.resolve(found([item('t6', 'Pl old')]))
    await flush()
    expect(pickerRowIds(el)).toEqual(['t7'])
  })

  it('an older answer arriving during the pause before the next search never supplies a choice', async () => {
    const late = deferred<Response>()
    h_.tasksReply.mockImplementation((view: string, _status: string, q: string) => {
      if (view === 'assigned') return found([])
      return q === 'Pl' ? late.promise : found([item('t7', 'Plan A')])
    })
    const el = await mountAt('/task-lists/tl_1')
    await openTaskPicker(el)
    await searchTasks(el, 'Pl')
    await typeInto(el, 'task-picker-search', 'Plan')
    late.resolve(found([item('t6', 'Pl old')]))
    await flush()
    expect(taskSearches().map((read) => read.q)).toEqual(['Pl', 'Pl'])
    expect(pickerRowIds(el)).toEqual([])
    expect(disabled(el, 'task-picker-confirm')).toBe(true)
    await pause()
    await flush()
    expect(pickerRowIds(el)).toEqual(['t7'])
  })

  it('rows are merged by id, created first; tasks already in the list are left out; a done task is marked; a blank title shows the id', async () => {
    h_.tasksReply.mockImplementation((view: string) => (view === 'created'
      ? found([item('t5', 'Plan E'), item('t1', 'Task One'), item('t6', 'Plan F', { status: 'done' })])
      : found([item('t6', 'Plan F', { status: 'done' }), item('t8', '  ')])))
    const el = await mountAt('/task-lists/tl_1')
    await openTaskPicker(el)
    await searchTasks(el, 'Plan')
    expect(pickerRowIds(el)).toEqual(['t5', 't6', 't8'])
    const rows = shownAll(el, 'task-picker-row').map((row) => [
      row.querySelector('[data-testid="task-picker-title"]')?.textContent,
      row.querySelector('[data-testid="task-picker-done"]')?.textContent ?? null,
    ])
    expect(rows).toEqual([['Plan E', null], ['Plan F', '已完成'], ['t8', null]])
  })

  it("when the list's items were read only in part, no task is left out", async () => {
    h_.itemsReply.mockImplementation((id: string, query: string) => {
      const offset = Number(new URLSearchParams(query).get('offset'))
      return jsonResponse(200, { items: offset === 0 ? items[id] : [], total: 5 })
    })
    h_.tasksReply.mockImplementation(() => found([item('t1', 'Task One'), item('t5', 'Task Five')]))
    const el = await mountAt('/task-lists/tl_1')
    must(el, 'tasks-list-detail-items-truncated')
    await openTaskPicker(el)
    await searchTasks(el, 'Task')
    expect(pickerRowIds(el)).toEqual(['t1', 't5'])
  })

  it.each([
    ['a row whose id cannot be placed in a path', () => found([item('t5', 'Plan E'), item('..', 'Plan Up')]), '加载任务失败，请稍后重试'],
    ['a row with a status outside open and done', () => found([item('t5', 'Plan E', { status: 'archived' })]), '加载任务失败，请稍后重试'],
    ['a 500', () => jsonResponse(500, {}), '加载任务失败，请稍后重试'],
    ['a 403', () => jsonResponse(403, { error: 'Insufficient permissions' }), '您没有权限修改此任务'],
    ['the degraded no-org body', () => jsonResponse(200, { degraded: true, reason: 'org_missing', items: [] }), '请先选择一个组织后再查看任务'],
  ] as const)('%s in the assigned view shows its copy and no rows', async (_label, reply, copy) => {
    h_.tasksReply.mockImplementation((view: string) => (view === 'assigned' ? reply() : found([item('t5', 'Plan E')])))
    const el = await mountAt('/task-lists/tl_1')
    await openTaskPicker(el)
    await searchTasks(el, 'Plan')
    expect(text(el, 'task-picker-error')).toBe(copy)
    expect(pickerRowIds(el)).toEqual([])
    expect(shown(el, 'tasks-view-org-missing')).toBeNull()
  })

  it('confirm adds the chosen task, then the items and the placements are read again; the task-id form keeps its text', async () => {
    h_.tasksReply.mockImplementation((view: string) => (view === 'created' ? found([item('t9', 'Plan Nine')]) : found([])))
    const el = await mountAt('/task-lists/tl_1')
    await typeInto(el, 'tasks-list-detail-add-task-input', 'typed')
    await openTaskPicker(el)
    await searchTasks(el, 'Plan')
    expect(disabled(el, 'task-picker-confirm')).toBe(true)
    choose(el, 't9')
    await flush()
    await click(el, 'task-picker-confirm')
    expect(requests('POST', '/api/task-lists/tl_1/items').map(([, init]) => init?.body)).toEqual([JSON.stringify({ taskId: 't9' })])
    expect(shown(el, 'task-picker')).toBeNull()
    expect(itemReads()).toBe(2)
    expect(placementReads()).toBe(2)
    expect(itemRows(el).map((row) => row[0])).toEqual(['t1', 't2', 't9'])
    expect((must(el, 'tasks-list-detail-add-task-input') as HTMLInputElement).value).toBe('typed')
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
  })

  it.each([
    ['404', NOT_FOUND, '任务不存在、你不是它的创建人或负责人，或清单不可用'],
    ['422 LIMIT', () => jsonResponse(422, { error: { code: 'LIMIT' } }), '一个任务最多属于 10 个清单'],
  ] as const)('a pick answered %s shows its copy at the add error, outside the folded form', async (_label, reply, copy) => {
    h_.addItemReply.mockImplementation(reply)
    h_.tasksReply.mockImplementation(() => found([item('t9', 'Plan Nine')]))
    const el = await mountAt('/task-lists/tl_1')
    await openTaskPicker(el)
    await searchTasks(el, 'Plan')
    choose(el, 't9')
    await flush()
    await click(el, 'task-picker-confirm')
    const error = must(el, 'tasks-list-detail-add-task-error')
    expect(error.textContent?.trim()).toBe(copy)
    expect(error.closest('form')).toBeNull()
    expect(must(el, 'tasks-list-detail-add-task-form').style.display).toBe('none')
    expect(shown(el, 'tasks-list-detail-banner')).toBeNull()
    expect(itemReads()).toBe(1)
  })

  it('more than 50 rows, or a view read only in part, ask for more of the title', async () => {
    h_.tasksReply.mockImplementation((view: string, _status: string, q: string) => {
      if (q === 'Many') return view === 'created' ? found(Array.from({ length: 51 }, (_, i) => item(`m${i}`, `Many ${i}`))) : found([])
      return view === 'assigned' ? found([item('t5', 'Cut five')], 120) : found([])
    })
    const el = await mountAt('/task-lists/tl_1')
    await openTaskPicker(el)
    await searchTasks(el, 'Many')
    expect(shownAll(el, 'task-picker-row')).toHaveLength(50)
    expect(text(el, 'task-picker-more')).toBe('匹配的任务较多，请输入更完整的标题')
    await searchTasks(el, 'Cut')
    expect(pickerRowIds(el)).toEqual(['t5'])
    expect(text(el, 'task-picker-more')).toBe('匹配的任务较多，请输入更完整的标题')
  })

  it('a route edge closes the picker, folds the form, and an answer for the old list is not shown', async () => {
    const late = deferred<Response>()
    h_.tasksReply.mockImplementation(() => late.promise)
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-add-task-by-id-toggle')
    await openTaskPicker(el)
    await searchTasks(el, 'Plan')
    expect(shown(el, 'task-picker-loading')).toBeTruthy()
    await go('/task-lists/tl_2')
    expect(text(el, 'tasks-list-detail-title')).toBe('Chores')
    expect(shown(el, 'task-picker')).toBeNull()
    expect(must(el, 'tasks-list-detail-add-task-form').style.display).toBe('none')
    expect(must(el, 'tasks-list-detail-add-task-by-id-toggle').getAttribute('aria-expanded')).toBe('false')
    late.resolve(found([item('t7', 'Plan A')]))
    await flush()
    await openTaskPicker(el)
    expect(pickerRowIds(el)).toEqual([])
    expect(text(el, 'task-picker-type-hint')).toBe('输入标题开始搜索')
  })

  it('Tab and Shift+Tab stay inside the picker', async () => {
    h_.tasksReply.mockImplementation((view: string) => (view === 'created' ? found([item('t9', 'Plan Nine')]) : found([])))
    const el = await mountAt('/task-lists/tl_1')
    await openTaskPicker(el)
    await searchTasks(el, 'Plan')
    choose(el, 't9')
    await flush()
    const reached: string[] = []
    el.addEventListener('keydown', (event) => { reached.push(event.key) })
    const press = (from: HTMLElement, shiftKey: boolean) => {
      from.focus()
      expect(document.activeElement).toBe(from)
      const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
      from.dispatchEvent(event)
      return event
    }
    expect(press(must(el, 'task-picker-confirm'), false).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(must(el, 'task-picker-search'))
    expect(press(must(el, 'task-picker-search'), true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(must(el, 'task-picker-confirm'))
    expect(reached).toEqual([])
  })

  describe('with a signed-in account', () => {
    /** A JWT-shaped token the app's own payload reader understands (header and signature are not read). */
    const fakeToken = (payload: Record<string, unknown>) => `h.${btoa(JSON.stringify(payload)).replace(/=+$/, '')}.s`

    afterEach(() => {
      localStorage.removeItem('auth_token')
    })

    it('a search answer received after a silent account switch leaves the list picker empty', async () => {
      localStorage.setItem('auth_token', fakeToken({ sub: 'u1' }))
      const late = deferred<Response>()
      h_.tasksReply.mockImplementation((view: string) => view === 'created' ? late.promise : found([]))
      const el = await mountAt('/task-lists/tl_1')
      await openTaskPicker(el)
      await searchTasks(el, 'Plan')
      must(el, 'task-picker-loading')
      localStorage.setItem('auth_token', fakeToken({ sub: 'u9' }))
      late.resolve(found([item('t9', 'Plan Nine')]))
      await flush()
      expect(pickerRowIds(el)).toEqual([])
      must(el, 'task-picker-type-hint')
      expect((must(el, 'task-picker-search') as HTMLInputElement).value).toBe('')
    })

    it('a silent account switch after choosing a task prevents the add on confirm', async () => {
      localStorage.setItem('auth_token', fakeToken({ sub: 'u1' }))
      h_.tasksReply.mockImplementation((view: string) => view === 'created' ? found([item('t9', 'Plan Nine')]) : found([]))
      const el = await mountAt('/task-lists/tl_1')
      await openTaskPicker(el)
      await searchTasks(el, 'Plan')
      choose(el, 't9')
      await flush()
      expect(disabled(el, 'task-picker-confirm')).toBe(false)
      localStorage.setItem('auth_token', fakeToken({ sub: 'u9' }))
      await click(el, 'task-picker-confirm')
      expect(requests('POST', '/api/task-lists/tl_1/items')).toEqual([])
      expect(pickerRowIds(el)).toEqual([])
      expect(disabled(el, 'task-picker-confirm')).toBe(true)
    })

    it('another account signing in elsewhere clears the rows and the choice; confirm then sends nothing', async () => {
      localStorage.setItem('auth_token', fakeToken({ sub: 'u1', exp: 4102444800 }))
      h_.tasksReply.mockImplementation((view: string) => (view === 'created' ? found([item('t9', 'Plan Nine')]) : found([])))
      const el = await mountAt('/task-lists/tl_1')
      await openTaskPicker(el)
      await searchTasks(el, 'Plan')
      choose(el, 't9')
      await flush()
      expect(disabled(el, 'task-picker-confirm')).toBe(false)
      const other = fakeToken({ sub: 'u9', exp: 4102444800 })
      localStorage.setItem('auth_token', other)
      window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token', newValue: other }))
      await flush()
      expect(pickerRowIds(el)).toEqual([])
      expect(text(el, 'task-picker-type-hint')).toBe('输入标题开始搜索')
      expect((must(el, 'task-picker-search') as HTMLInputElement).value).toBe('')
      expect(disabled(el, 'task-picker-confirm')).toBe(true)
      ;(must(el, 'task-picker-confirm') as HTMLButtonElement).disabled = false
      await click(el, 'task-picker-confirm')
      expect(requests('POST', '/api/task-lists/tl_1/items')).toEqual([])
    })
  })
})

describe('creating a task in the current list', () => {
  const titleInput = (el: HTMLElement) => must(el, 'list-create-title') as HTMLInputElement
  const writeBodies = () => writes().map(([path, init]) => [path, JSON.parse(init?.body ?? '{}')])
  const createWrite = ['/api/tasks', { title: 'Plan' }]
  const addWrite = ['/api/task-lists/tl_1/items', { taskId: 'fresh-task' }]

  async function start(el: HTMLElement): Promise<void> {
    await typeInto(el, 'list-create-title', '  Plan  ')
    await submit(el, 'list-create-form')
  }

  it('waits for creation, adds the returned task once, and keeps write controls busy until the refreshed rows arrive', async () => {
    lists.tl_1.myRole = 'edit'
    const create = deferred<Response>()
    const add = deferred<Response>()
    const rows = deferred<Response>()
    h_.createReply.mockReturnValueOnce(create.promise)
    h_.addItemReply.mockReturnValueOnce(add.promise)
    const el = await mountAt('/task-lists/tl_1')
    h_.itemsReply.mockReturnValueOnce(rows.promise)
    await typeInto(el, 'list-create-title', '  ')
    expect(disabled(el, 'list-create-submit')).toBe(true)
    await submit(el, 'list-create-form')
    expect(writeBodies()).toEqual([])
    await start(el)
    await submit(el, 'list-create-form')
    expect(writeBodies()).toEqual([createWrite])
    expect(titleInput(el).disabled).toBe(true)
    expect(disabled(el, 'tasks-list-detail-pick-task')).toBe(true)
    create.resolve(jsonResponse(200, { id: 'fresh-task' }))
    await flush()
    expect(writeBodies()).toEqual([createWrite, addWrite])
    expect(h_.notifyTasksChanged).toHaveBeenCalledTimes(1)
    await submit(el, 'list-create-form')
    expect(writeBodies()).toEqual([createWrite, addWrite])
    add.resolve(jsonResponse(200, { listId: 'tl_1', taskId: 'fresh-task' }))
    await flush()
    expect(itemReads()).toBe(2)
    expect(fetchCalls().filter(([path]) => path.startsWith('/api/task-lists/tl_1/group-items?'))).toHaveLength(2)
    expect(must(el, 'tasks-list-detail').getAttribute('aria-busy')).toBe('true')
    rows.resolve(page([...items.tl_1, item('fresh-task', 'Plan')], 'offset=0'))
    await flush()
    expect(itemRows(el)).toEqual([['t1', 'Task One'], ['t2', 'Task Two'], ['fresh-task', 'Plan']])
    expect(titleInput(el).value).toBe('')
    expect(titleInput(el).disabled).toBe(false)
    expect(shown(el, 'list-create-message')).toBeNull()
  })

  it('keeps the created task after repeated add failures and retries the same ID until the add succeeds', async () => {
    h_.addItemReply.mockResolvedValueOnce(jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
      .mockResolvedValueOnce(jsonResponse(500, {}))
    const el = await mountAt('/task-lists/tl_1')
    await start(el)
    expect(writeBodies()).toEqual([createWrite, addWrite])
    expect(text(el, 'list-create-message')).toBe('任务已创建，加入清单失败。')
    expect(text(el, 'list-create-submit')).toBe('重试加入')
    expect(titleInput(el).readOnly).toBe(true)
    expect(text(el, 'tasks-list-detail-banner')).toBe('请先选择一个组织后再查看任务')
    expect(itemRows(el).map(([id]) => id)).toEqual(['t1', 't2'])
    expect(itemReads()).toBe(1)
    await click(el, 'list-create-submit')
    expect(writeBodies()).toEqual([createWrite, addWrite, addWrite])
    expect(shown(el, 'tasks-list-detail-banner')).toBeNull()
    expect(text(el, 'list-create-message')).toBe('任务已创建，加入清单失败。')
    await click(el, 'list-create-submit')
    expect(writeBodies()).toEqual([createWrite, addWrite, addWrite, addWrite])
    expect(h_.notifyTasksChanged).toHaveBeenCalledTimes(1)
    expect(itemReads()).toBe(2)
    expect(itemRows(el).map(([id]) => id)).toEqual(['t1', 't2', 'fresh-task'])
    expect(shown(el, 'list-create-message')).toBeNull()
    expect(titleInput(el).readOnly).toBe(false)
    expect(text(el, 'list-create-submit')).toBe('创建并加入清单')
  })

  it.each([
    [422, { error: { code: 'INVALID_TITLE' } }, '标题为空或包含无法保存的字符'],
    [503, {}, '创建任务失败，请稍后重试'],
  ] as const)('keeps the editable title after an unsuccessful creation (%s) and sends no add', async (status, body, copy) => {
    h_.createReply.mockResolvedValueOnce(jsonResponse(status, body))
    const el = await mountAt('/task-lists/tl_1')
    await start(el)
    expect(writeBodies()).toEqual([createWrite])
    expect(text(el, 'list-create-message')).toBe(copy)
    expect(titleInput(el).value).toBe('  Plan  ')
    expect(titleInput(el).readOnly).toBe(false)
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
    await typeInto(el, 'list-create-title', 'Revised')
    expect(shown(el, 'list-create-message')).toBeNull()
    await click(el, 'list-create-submit')
    expect(writeBodies()).toEqual([createWrite, ['/api/tasks', { title: 'Revised' }], addWrite])
  })

  it.each([
    [403, '您没有权限修改此清单'],
    [404, '清单不可用或你已不是成员'],
  ] as const)('clears old errors when creation starts and shows the list message with the retry after add returns %s', async (status, copy) => {
    const create = deferred<Response>()
    h_.addItemReply.mockImplementationOnce(NOT_FOUND)
    h_.renameReply.mockResolvedValueOnce(jsonResponse(403, {}))
    h_.createReply.mockReturnValueOnce(create.promise)
    const el = await mountAt('/task-lists/tl_1')
    await addTask(el, 'missing')
    await rename(el, 'Renamed')
    must(el, 'tasks-list-detail-add-task-error')
    must(el, 'tasks-list-detail-banner')
    h_.addItemReply.mockResolvedValueOnce(jsonResponse(status, {}))
    await start(el)
    expect(shown(el, 'tasks-list-detail-add-task-error')).toBeNull()
    expect(shown(el, 'tasks-list-detail-banner')).toBeNull()
    create.resolve(jsonResponse(200, { id: 'fresh-task' }))
    await flush()
    expect(text(el, 'tasks-list-detail-banner')).toBe(copy)
    expect(text(el, 'list-create-message')).toBe('任务已创建，加入清单失败。')
    expect(text(el, 'list-create-submit')).toBe('重试加入')
    await click(el, 'list-create-submit')
    expect(requests('POST', '/api/tasks')).toHaveLength(1)
    expect(h_.addItemReply.mock.calls.slice(1)).toEqual([
      ['tl_1', JSON.stringify({ taskId: 'fresh-task' })],
      ['tl_1', JSON.stringify({ taskId: 'fresh-task' })],
    ])
    expect(shown(el, 'tasks-list-detail-banner')).toBeNull()
    expect(shown(el, 'list-create-message')).toBeNull()
  })

  it('shows organization guidance when task creation needs an organization', async () => {
    h_.createReply.mockResolvedValueOnce(jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    const el = await mountAt('/task-lists/tl_1')
    await start(el)
    expect(writeBodies()).toEqual([createWrite])
    expect(text(el, 'tasks-view-org-missing')).toBe('请先选择一个组织后再查看任务')
  })

  it('hides creation alongside the other add controls for a reader or when items are unavailable', async () => {
    lists.tl_1.myRole = 'read'
    const el = await mountAt('/task-lists/tl_1')
    expect(shown(el, 'list-create-form')).toBeNull()
    h_.itemsReply.mockImplementation(NOT_FOUND)
    await go('/task-lists/tl_2')
    must(el, 'tasks-list-detail-items-unavailable')
    expect(shown(el, 'list-create-form')).toBeNull()
    expect(writeBodies()).toEqual([])
  })

  it('a creation that finishes after moving to another list sends no add and preserves the new draft', async () => {
    const create = deferred<Response>()
    h_.createReply.mockReturnValueOnce(create.promise)
    const el = await mountAt('/task-lists/tl_1')
    await start(el)
    await go('/task-lists/tl_2')
    await typeInto(el, 'list-create-title', 'Other draft')
    create.resolve(jsonResponse(200, { id: 'fresh-task' }))
    await flush()
    expect(writeBodies()).toEqual([createWrite])
    expect(h_.notifyTasksChanged).toHaveBeenCalledTimes(1)
    expect(titleInput(el).value).toBe('Other draft')
    expect(text(el, 'list-create-submit')).toBe('创建并加入清单')
  })

  it('a retry finishing on another list cannot offer another retry there', async () => {
    const add = deferred<Response>()
    h_.addItemReply.mockImplementationOnce(NOT_FOUND).mockReturnValueOnce(add.promise)
    const el = await mountAt('/task-lists/tl_1')
    await start(el)
    await click(el, 'list-create-submit')
    await go('/task-lists/tl_2')
    add.resolve(jsonResponse(503, {}))
    await flush()
    expect(writeBodies()).toEqual([createWrite, addWrite, addWrite])
    expect(shown(el, 'list-create-message')).toBeNull()
    expect(titleInput(el).value).toBe('')
    expect(text(el, 'list-create-submit')).toBe('创建并加入清单')
  })

  describe('account changes', () => {
    const signIn = (sub: string) => localStorage.setItem('auth_token', 'h.' + btoa(JSON.stringify({ sub, exp: 4102444800 })) + '.s')

    beforeEach(() => { signIn('viewer') })
    afterEach(() => { localStorage.removeItem('auth_token') })

    it('drops an in-flight creation after switching away and back before the answer', async () => {
      const create = deferred<Response>()
      h_.createReply.mockReturnValueOnce(create.promise)
      const el = await mountAt('/task-lists/tl_1')
      await start(el)
      signIn('other')
      notifyAuthPrincipalChange()
      await flush()
      signIn('viewer')
      notifyAuthPrincipalChange()
      await flush()
      create.resolve(jsonResponse(200, { id: 'fresh-task' }))
      await flush()
      expect(writeBodies()).toEqual([createWrite])
      expect(titleInput(el).value).toBe('')
      expect(shown(el, 'list-create-message')).toBeNull()
    })

    it('a silent account change before retry clears the previous title and sends nothing', async () => {
      h_.addItemReply.mockImplementationOnce(NOT_FOUND)
      const el = await mountAt('/task-lists/tl_1')
      await start(el)
      expect(text(el, 'list-create-submit')).toBe('重试加入')
      signIn('other')
      await click(el, 'list-create-submit')
      expect(writeBodies()).toEqual([createWrite, addWrite])
      expect(titleInput(el).value).toBe('')
      expect(shown(el, 'list-create-message')).toBeNull()
    })
  })
})
