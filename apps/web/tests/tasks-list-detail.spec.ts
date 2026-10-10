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
  // M4 FE-7: the grouping board's two reads — a list with no custom groups and no placements yet
  // (tasks-groups.spec.ts covers the board itself).
  if (method === 'GET' && (match = /^\/api\/task-lists\/([^/]+)\/groups$/.exec(pathname))) {
    return page([{ id: `tg_${decodeURIComponent(match[1])}`, scope: 'list', name: '默认分组', position: 0, isDefault: true }], query)
  }
  if (method === 'GET' && /^\/api\/task-lists\/[^/]+\/group-items$/.test(pathname)) return page([], query)
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
      'tasks-list-detail-item-remove',
    ]) {
      expect(disabled(el, id), id).toBe(true)
    }
    await submit(el, 'tasks-list-detail-rename-form')
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
