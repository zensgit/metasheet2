import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import { createMemoryHistory, createRouter, RouterView, useRoute, type Router } from 'vue-router'

/**
 * M4 FE-5 — the `/tasks` lists sidebar (TaskListsSidebar.vue, mounted by TasksView) and the lists
 * bus (`tasks/tasksListsBus.ts`) as TasksView hears it (docs/development/task-m4-frontend-design-
 * 20261007.md §2.4, §4.1, §4.3, §10.1).
 *
 * Backend: `GET` / `POST /api/task-lists` are built on the PR-3a branch (S5), not on main. The
 * no-org degraded body, the 404 of a backend without the routes and every failure are played by
 * the fake backend below.
 *
 * Mock face: `apiFetch` plays the backend by path, so the REAL tasksApi client builds every request
 * and parses every answer — request bodies are asserted as the client serialized them. Also mocked:
 * `loadTasksContext`, `notifyTasksChanged` (the badge bus, to prove the sidebar never touches it),
 * `useAuth`, `useLocale` (ZH) and `resolveViewerTimeZone`. The lists bus is the real module; a cell
 * that watches it subscribes its own listener. The router is real: `/tasks` and `/tasks/:id` on the
 * one TasksView (the instance is reused across them), `/task-lists/:id` on a stand-in page that
 * shows which id it was opened with.
 */

const h_ = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  loadTasksContext: vi.fn(),
  notifyTasksChanged: vi.fn(),
  resolveViewerTimeZone: vi.fn(),
  getCurrentUserId: vi.fn(),
  /** `GET /api/tasks?…` (the query) -> the response. */
  tasksReply: vi.fn(),
  /** `GET /api/task-lists?…` (the query) -> the response, or a promise of it. */
  listsReply: vi.fn(),
  /** `POST /api/task-lists` (the serialized body) -> the response, or a promise of it. */
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
import { notifyListsChanged, onListsChanged } from '../src/tasks/tasksListsBus'

// ---------------------------------------------------------------------------------------------
// Fixtures and the fake backend
// ---------------------------------------------------------------------------------------------

type Role = 'read' | 'edit' | 'owner'

function taskList(id: string, name: string, myRole: Role, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name,
    createdBy: 'u1',
    ownerId: 'u1',
    archivedAt: null,
    createdAt: '2031-01-01T00:00:00.000Z',
    updatedAt: '2031-01-01T00:00:00.000Z',
    myRole,
    ...over,
  }
}

/** The viewer's lists that are not archived, in the server's order. */
const ACTIVE = [taskList('tl_a', 'Alpha', 'owner'), taskList('tl_b', 'Beta', 'edit'), taskList('tl_c', 'Gamma', 'read')]
/** One archived list, shown only with `includeArchived=true`. */
const ARCHIVED = taskList('tl_d', 'Delta', 'owner', { archivedAt: '2031-01-02T00:00:00.000Z' })

/** A page of `GET /api/task-lists` over `all`, as the server pages it (limit 100). */
function pageOf(all: Array<Record<string, unknown>>, query: string): Response {
  const offset = Number(new URLSearchParams(query).get('offset'))
  return jsonResponse(200, { items: all.slice(offset, offset + 100), total: all.length })
}

function manyLists(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => taskList(`tl_${String(i).padStart(3, '0')}`, `List ${i}`, 'owner'))
}

function detailBody(id: string): Record<string, unknown> {
  return {
    id,
    title: `Title-${id}`,
    status: 'open',
    completionMode: 'all',
    createdBy: 'u1',
    dueAt: null,
    dueDate: null,
    dueTime: null,
    timeZone: null,
    assignees: [],
    canComplete: true,
    canReopen: false,
    parentId: null,
    depth: 0,
    children: [],
  }
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

type FetchInit = { method?: string; body?: string } | undefined

/** Requests the fake backend has no route for. Checked empty after every cell. */
let unexpected: string[] = []

async function fakeFetch(path: string, init?: FetchInit): Promise<Response> {
  const method = init?.method ?? 'GET'
  const [pathname, query = ''] = path.split('?')
  let match: RegExpExecArray | null
  if (method === 'GET' && pathname === '/api/tasks') return h_.tasksReply(query)
  if (method === 'GET' && pathname === '/api/task-lists') return h_.listsReply(query)
  if (method === 'POST' && pathname === '/api/task-lists') return h_.createReply(init?.body)
  if (method === 'GET' && (match = /^\/api\/tasks\/([^/]+)$/.exec(pathname))) return jsonResponse(200, detailBody(decodeURIComponent(match[1])))
  if (method === 'GET' && /^\/api\/tasks\/[^/]+\/comments$/.test(pathname)) return jsonResponse(200, { items: [], total: 0 })
  // M4 FE-7: the assigned view's rows render through the personal grouping board, which reads the
  // viewer's groups and placements — here a viewer without groups (tasks-groups.spec.ts covers it).
  if (method === 'GET' && pathname === '/api/task-groups') {
    return pageOf([{ id: null, scope: 'user', name: '默认分组', position: 0, isDefault: true }], query)
  }
  if (method === 'GET' && pathname === '/api/task-groups/items') return pageOf([], query)
  unexpected.push(`${method} ${path}`)
  return jsonResponse(599, {})
}

function fetchCalls(): Array<[string, FetchInit]> {
  return h_.apiFetch.mock.calls as Array<[string, FetchInit]>
}

/** Every `GET /api/task-lists?…` the client sent, as the path string. */
function listReads(): string[] {
  return fetchCalls()
    .filter(([path, init]) => path.startsWith('/api/task-lists?') && (init?.method ?? 'GET') === 'GET')
    .map(([path]) => path)
}

const SIDEBAR_FIRST_PAGE = '/api/task-lists?includeArchived=false&limit=100&offset=0'
const SIDEBAR_FIRST_PAGE_ARCHIVED = '/api/task-lists?includeArchived=true&limit=100&offset=0'

/** The bodies of every `POST /api/task-lists`, exactly as the client serialized them. */
function createBodies(): string[] {
  return fetchCalls()
    .filter(([path, init]) => path === '/api/task-lists' && init?.method === 'POST')
    .map(([, init]) => init?.body as string)
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

/** Stands in for the list page: shows the id it was opened with. */
const ListPageStandIn = defineComponent({
  name: 'ListPageStandIn',
  setup() {
    const route = useRoute()
    return () => h('p', { 'data-testid': 'list-page-stand-in' }, String(route.params.id))
  },
})

async function mountAt(path: string): Promise<HTMLElement> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/tasks', component: TasksView },
      { path: '/tasks/:id', component: TasksView },
      { path: '/task-lists/:id', component: ListPageStandIn },
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

/** Subscribes a spy to the real lists bus for the length of the cell. */
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

function sidebar(el: HTMLElement): HTMLElement {
  return must(el, 'tasks-lists-sidebar')
}

/** The sidebar's rows as `[id, name, role copy, archived]`. */
function rows(el: HTMLElement): Array<[string, string, string, boolean]> {
  return shownAll(el, 'tasks-lists-item').map((row) => [
    row.getAttribute('data-list-id') ?? '',
    row.querySelector('[data-testid="tasks-lists-item-link"]')?.textContent?.trim() ?? '',
    row.querySelector('[data-testid="tasks-lists-item-role"]')?.textContent?.trim() ?? '',
    row.querySelector('[data-testid="tasks-lists-item-archived"]') !== null,
  ])
}

async function typeName(el: HTMLElement, value: string): Promise<void> {
  const input = must(el, 'tasks-lists-create-input') as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input'))
  await flush()
}

/** Submits the create form the way Enter does. Dispatching the event also reaches the handler
 *  while the button is disabled, so the handler's own guards are what a cell sees. */
async function submitCreate(el: HTMLElement): Promise<void> {
  must(el, 'tasks-lists-create-form').dispatchEvent(new Event('submit', { cancelable: true }))
  await flush()
}

async function toggleArchived(el: HTMLElement): Promise<void> {
  ;(must(el, 'tasks-lists-archived-toggle') as HTMLInputElement).click()
  await flush()
}

async function click(el: HTMLElement, testid: string): Promise<void> {
  ;(must(el, testid) as HTMLButtonElement).click()
  await flush()
}

function disabled(el: HTMLElement, testid: string): boolean {
  return (must(el, testid) as HTMLButtonElement | HTMLInputElement).disabled
}

/** The ids `tasks-view.spec.ts` counts as the list page's exact state set (its TESTIDS). */
const LIST_PAGE_STATE_IDS = [
  'tasks-detail',
  'tasks-detail-not-found',
  'tasks-detail-forbidden',
  'tasks-detail-error',
  'tasks-detail-loading',
  'tasks-view-org-missing',
  'tasks-view-unavailable',
  'tasks-view-forbidden',
  'tasks-view-error',
  'tasks-list',
  'tasks-list-empty',
  'tasks-list-error',
]

beforeEach(() => {
  unexpected = []
  h_.apiFetch.mockReset().mockImplementation(fakeFetch)
  h_.loadTasksContext.mockReset().mockResolvedValue({ state: 'ready', orgId: 'org1' })
  h_.notifyTasksChanged.mockReset()
  h_.resolveViewerTimeZone.mockReset().mockReturnValue('Pacific/Chatham')
  h_.getCurrentUserId.mockReset().mockResolvedValue('u1')
  h_.tasksReply.mockReset().mockImplementation(() => jsonResponse(200, { items: [], total: 0 }))
  h_.listsReply.mockReset().mockImplementation((query: string) =>
    pageOf(new URLSearchParams(query).get('includeArchived') === 'true' ? [...ACTIVE, ARCHIVED] : ACTIVE, query),
  )
  h_.createReply.mockReset().mockImplementation((body: string) =>
    jsonResponse(200, taskList('tl_new', JSON.parse(body).name, 'owner')),
  )
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
// Where the sidebar renders, and its test ids
// ---------------------------------------------------------------------------------------------

describe('lists sidebar — placement on the /tasks list page', () => {
  it('renders beside the task list with its heading; the page heading is still the first h1', async () => {
    const el = await mountAt('/tasks')
    expect(sidebar(el).querySelector('h2')?.textContent?.trim()).toBe('我的清单')
    expect(el.querySelector('h1')?.textContent).toBe('任务')
    expect(rows(el).map((row) => row[0])).toEqual(['tl_a', 'tl_b', 'tl_c'])
  })

  it('every test id inside the sidebar starts with tasks-lists- and none is one of the list page state ids', async () => {
    h_.listsReply.mockImplementation((query: string) => pageOf([...manyLists(150)], query))
    h_.createReply.mockImplementation(() => jsonResponse(422, { error: { code: 'INVALID_NAME' } }))
    const el = await mountAt('/tasks')
    await typeName(el, 'x')
    await submitCreate(el)
    const ids = [sidebar(el), ...Array.from(sidebar(el).querySelectorAll('[data-testid]'))].map((node) => node.getAttribute('data-testid') ?? '')
    expect(ids).toContain('tasks-lists-more')
    expect(ids).toContain('tasks-lists-create-error')
    expect(ids.filter((id) => !id.startsWith('tasks-lists-'))).toEqual([])
    expect(ids.filter((id) => LIST_PAGE_STATE_IDS.includes(id))).toEqual([])
  })

  it('in every read state the sidebar\'s test ids keep the prefix and stay apart from the list page state ids', async () => {
    const pending = deferred<Response>()
    const states: Array<[string, () => Response | Promise<Response>]> = [
      ['loading', () => pending.promise],
      ['empty', () => jsonResponse(200, { items: [], total: 0 })],
      ['error', () => jsonResponse(500, {})],
      ['forbidden', () => jsonResponse(403, { error: 'Insufficient permissions' })],
      ['unavailable', () => jsonResponse(404, { error: { code: 'NOT_FOUND' } })],
    ]
    for (const [state, reply] of states) {
      h_.listsReply.mockImplementation(reply)
      const el = await mountAt('/tasks')
      must(el, `tasks-lists-${state}`)
      const ids = [sidebar(el), ...Array.from(sidebar(el).querySelectorAll('[data-testid]'))].map((node) => node.getAttribute('data-testid') ?? '')
      expect(ids.filter((id) => !id.startsWith('tasks-lists-')), state).toEqual([])
      expect(ids.filter((id) => LIST_PAGE_STATE_IDS.includes(id)), state).toEqual([])
      app!.unmount()
      container!.remove()
      app = null
      container = null
    }
    pending.resolve(jsonResponse(200, { items: [], total: 0 }))
    await flush()
  })

  it.each([
    ['empty', () => jsonResponse(200, { items: [], total: 0 }), 'tasks-list-empty'],
    ['error', () => jsonResponse(500, {}), 'tasks-list-error'],
    ['with rows', () => jsonResponse(200, { items: [{ id: 't1', title: 'One', status: 'open', completion_mode: 'all', created_by: 'u1', due_at: null }], total: 1 }), 'tasks-list'],
  ] as const)('stays on the page while the task list is %s', async (_label, reply, stateId) => {
    h_.tasksReply.mockImplementation(reply)
    const el = await mountAt('/tasks')
    must(el, stateId)
    must(el, 'tasks-lists-sidebar')
    expect(rows(el)).toHaveLength(3)
  })

  it('stays on the page while the task list is still loading', async () => {
    const pending = deferred<Response>()
    h_.tasksReply.mockImplementation(() => pending.promise)
    const el = await mountAt('/tasks')
    must(el, 'tasks-list-loading')
    must(el, 'tasks-lists-sidebar')
    pending.resolve(jsonResponse(200, { items: [], total: 0 }))
    await flush()
  })

  it('is not on the detail page, and a detail-page mount sends no sidebar read', async () => {
    const el = await mountAt('/tasks/t1')
    must(el, 'tasks-detail')
    expect(shown(el, 'tasks-lists-sidebar')).toBeNull()
    expect(listReads()).not.toContain(SIDEBAR_FIRST_PAGE)
  })

  it.each(['org_missing', 'unavailable', 'forbidden', 'error'] as const)('is not rendered and reads nothing when the context is %s', async (state) => {
    h_.loadTasksContext.mockResolvedValue({ state })
    const el = await mountAt('/tasks')
    expect(shown(el, 'tasks-lists-sidebar')).toBeNull()
    expect(listReads()).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// The read and its states
// ---------------------------------------------------------------------------------------------

describe('lists sidebar — the read', () => {
  it('reads one page without archived lists: exactly one request, includeArchived=false, limit 100, offset 0', async () => {
    await mountAt('/tasks')
    expect(listReads()).toEqual([SIDEBAR_FIRST_PAGE])
  })

  it('loading shows while the read is in flight', async () => {
    const pending = deferred<Response>()
    h_.listsReply.mockImplementation(() => pending.promise)
    const el = await mountAt('/tasks')
    expect(text(el, 'tasks-lists-loading')).toBe('加载中…')
    expect(shownAll(el, 'tasks-lists-item')).toEqual([])
    pending.resolve(pageOf(ACTIVE, 'offset=0'))
    await flush()
    expect(shown(el, 'tasks-lists-loading')).toBeNull()
    expect(rows(el)).toHaveLength(3)
  })

  it('rows keep the server order and show the name, the role and a link to the list page', async () => {
    const el = await mountAt('/tasks')
    expect(rows(el)).toEqual([
      ['tl_a', 'Alpha', '所有者', false],
      ['tl_b', 'Beta', '可编辑', false],
      ['tl_c', 'Gamma', '只读', false],
    ])
    expect(shownAll(el, 'tasks-lists-item').map((row) => row.getAttribute('data-role'))).toEqual(['owner', 'edit', 'read'])
    expect(shownAll(el, 'tasks-lists-item-link').map((link) => link.getAttribute('href'))).toEqual([
      '/task-lists/tl_a',
      '/task-lists/tl_b',
      '/task-lists/tl_c',
    ])
  })

  it('a row link opens the list page with that id', async () => {
    const el = await mountAt('/tasks')
    await router!.push(must(el, 'tasks-lists-item-link').getAttribute('href') as string)
    await flush()
    expect(router!.currentRoute.value.path).toBe('/task-lists/tl_a')
    expect(text(el, 'list-page-stand-in')).toBe('tl_a')
  })

  it('opening a list sends no task read for the list id (the task page does not take it as a task id)', async () => {
    const el = await mountAt('/tasks')
    await go('/task-lists/tl_a')
    await flush()
    expect(text(el, 'list-page-stand-in')).toBe('tl_a')
    expect(fetchCalls().filter(([path]) => path.startsWith('/api/tasks/'))).toEqual([])
  })

  it('opening a list from a task page sends no task read for the list id either', async () => {
    const el = await mountAt('/tasks/t1')
    const before = fetchCalls().length
    await go('/task-lists/tl_a')
    await flush()
    expect(text(el, 'list-page-stand-in')).toBe('tl_a')
    expect(fetchCalls().slice(before)).toEqual([])
  })

  it('an id with reserved characters is encoded in the link and arrives decoded', async () => {
    h_.listsReply.mockImplementation(() => jsonResponse(200, { items: [taskList('a/b c', 'Odd', 'owner')], total: 1 }))
    const el = await mountAt('/tasks')
    const href = must(el, 'tasks-lists-item-link').getAttribute('href') as string
    expect(href).toBe('/task-lists/a%2Fb%20c')
    await go(href)
    expect(text(el, 'list-page-stand-in')).toBe('a/b c')
  })

  it('empty: no lists yet, told apart from a failed read', async () => {
    h_.listsReply.mockImplementation(() => jsonResponse(200, { items: [], total: 0 }))
    const el = await mountAt('/tasks')
    expect(text(el, 'tasks-lists-empty')).toBe('还没有清单')
    expect(shown(el, 'tasks-lists-error')).toBeNull()
    expect(shown(el, 'tasks-lists-items')).toBeNull()
  })

  it.each([
    ['a 500', () => jsonResponse(500, {})],
    ['a malformed 200', () => jsonResponse(200, { items: [{ id: 'tl_a' }], total: 1 })],
    ['a 200 without total', () => jsonResponse(200, { items: [] })],
    ['a transport failure', () => Promise.reject(new Error('offline'))],
  ] as const)('error on %s: the failure copy, not the empty one', async (_label, reply) => {
    h_.listsReply.mockImplementation(reply)
    const el = await mountAt('/tasks')
    expect(text(el, 'tasks-lists-error')).toBe('加载清单失败，请稍后重试')
    expect(must(el, 'tasks-lists-error').getAttribute('role')).toBe('alert')
    expect(shown(el, 'tasks-lists-empty')).toBeNull()
  })

  it('forbidden on a 403', async () => {
    h_.listsReply.mockImplementation(() => jsonResponse(403, { error: 'Insufficient permissions' }))
    const el = await mountAt('/tasks')
    expect(text(el, 'tasks-lists-forbidden')).toBe('您没有权限查看任务清单')
    expect(shown(el, 'tasks-lists-error')).toBeNull()
    expect(shown(el, 'tasks-lists-unavailable')).toBeNull()
  })

  it('unavailable on a 404 (a backend without the list routes); the rest of the page is untouched', async () => {
    h_.listsReply.mockImplementation(() => jsonResponse(404, { error: { code: 'NOT_FOUND' } }))
    const el = await mountAt('/tasks')
    expect(text(el, 'tasks-lists-unavailable')).toBe('清单功能暂不可用')
    expect(shown(el, 'tasks-lists-forbidden')).toBeNull()
    must(el, 'tasks-list-empty')
    must(el, 'tasks-lists-create-form')
  })

  it('the degraded no-org body switches the page to the org guidance block', async () => {
    h_.listsReply.mockImplementation(() => jsonResponse(200, { items: [], degraded: true, reason: 'org_missing' }))
    const el = await mountAt('/tasks')
    expect(text(el, 'tasks-view-org-missing')).toBe('请先选择一个组织后再查看任务')
    expect(shown(el, 'tasks-lists-sidebar')).toBeNull()
    expect(shown(el, 'tasks-list-empty')).toBeNull()
    expect(shown(el, 'tasks-create-form')).toBeNull()
  })

  it('a degraded body with any other reason is an error, not the guidance block', async () => {
    h_.listsReply.mockImplementation(() => jsonResponse(200, { items: [], degraded: true, reason: 'other' }))
    const el = await mountAt('/tasks')
    must(el, 'tasks-lists-error')
    expect(shown(el, 'tasks-view-org-missing')).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------------------------

describe('lists sidebar — load more', () => {
  it('pages by 100 until the rows read reach total', async () => {
    const all = manyLists(150)
    h_.listsReply.mockImplementation((query: string) => pageOf(all, query))
    const el = await mountAt('/tasks')
    expect(shownAll(el, 'tasks-lists-item')).toHaveLength(100)
    expect(text(el, 'tasks-lists-more')).toBe('加载更多')
    await click(el, 'tasks-lists-more')
    expect(listReads()).toEqual([SIDEBAR_FIRST_PAGE, '/api/task-lists?includeArchived=false&limit=100&offset=100'])
    expect(shownAll(el, 'tasks-lists-item')).toHaveLength(150)
    expect(rows(el)[149][0]).toBe('tl_149')
    expect(shown(el, 'tasks-lists-more')).toBeNull()
  })

  it('no load more when the first page holds every list', async () => {
    const el = await mountAt('/tasks')
    expect(shown(el, 'tasks-lists-more')).toBeNull()
  })

  it('a row seen twice across pages is kept once; the next offset counts rows read', async () => {
    const all = manyLists(150)
    h_.listsReply.mockImplementation((query: string) => {
      const offset = Number(new URLSearchParams(query).get('offset'))
      if (offset === 0) return pageOf(all, query)
      // The second page repeats the last row of the first one (an update moved it).
      return jsonResponse(200, { items: [all[99], ...all.slice(100, 149)], total: 150 })
    })
    const el = await mountAt('/tasks')
    await click(el, 'tasks-lists-more')
    const ids = rows(el).map((row) => row[0])
    expect(ids).toHaveLength(149)
    expect(new Set(ids).size).toBe(149)
    expect(shown(el, 'tasks-lists-more')).toBeNull()
  })

  it('an empty next page ends the paging even when total says more', async () => {
    const all = manyLists(120)
    h_.listsReply.mockImplementation((query: string) => {
      const offset = Number(new URLSearchParams(query).get('offset'))
      return offset === 0 ? pageOf(all, query) : jsonResponse(200, { items: [], total: 120 })
    })
    const el = await mountAt('/tasks')
    await click(el, 'tasks-lists-more')
    expect(shownAll(el, 'tasks-lists-item')).toHaveLength(100)
    expect(shown(el, 'tasks-lists-more')).toBeNull()
  })

  it('a failed next page keeps the rows, says so, and a retry continues from the same offset', async () => {
    const all = manyLists(150)
    let failNext = true
    h_.listsReply.mockImplementation((query: string) => {
      const offset = Number(new URLSearchParams(query).get('offset'))
      if (offset === 100 && failNext) {
        failNext = false
        return jsonResponse(500, {})
      }
      return pageOf(all, query)
    })
    const el = await mountAt('/tasks')
    await click(el, 'tasks-lists-more')
    expect(shownAll(el, 'tasks-lists-item')).toHaveLength(100)
    expect(text(el, 'tasks-lists-more-error')).toBe('加载更多清单失败，请稍后重试')
    await click(el, 'tasks-lists-more')
    expect(shownAll(el, 'tasks-lists-item')).toHaveLength(150)
    expect(shown(el, 'tasks-lists-more-error')).toBeNull()
    expect(listReads().filter((path) => path.endsWith('offset=100'))).toHaveLength(2)
  })

  it('a next page that reports no org switches the page to the org guidance block, not the load-more failure', async () => {
    const all = manyLists(150)
    h_.listsReply.mockImplementation((query: string) =>
      Number(new URLSearchParams(query).get('offset')) === 0
        ? pageOf(all, query)
        : jsonResponse(200, { items: [], degraded: true, reason: 'org_missing' }),
    )
    const el = await mountAt('/tasks')
    await click(el, 'tasks-lists-more')
    expect(text(el, 'tasks-view-org-missing')).toBe('请先选择一个组织后再查看任务')
    expect(shown(el, 'tasks-lists-more-error')).toBeNull()
  })

  it('the button is disabled while the next page is in flight, and a second click sends nothing', async () => {
    const all = manyLists(150)
    const second = deferred<Response>()
    h_.listsReply.mockImplementation((query: string) =>
      Number(new URLSearchParams(query).get('offset')) === 0 ? pageOf(all, query) : second.promise,
    )
    const el = await mountAt('/tasks')
    await click(el, 'tasks-lists-more')
    expect(disabled(el, 'tasks-lists-more')).toBe(true)
    ;(must(el, 'tasks-lists-more') as HTMLButtonElement).disabled = false
    await click(el, 'tasks-lists-more')
    expect(listReads().filter((path) => path.endsWith('offset=100'))).toHaveLength(1)
    second.resolve(pageOf(all, 'offset=100'))
    await flush()
    expect(shownAll(el, 'tasks-lists-item')).toHaveLength(150)
  })
})

// ---------------------------------------------------------------------------------------------
// Archived lists
// ---------------------------------------------------------------------------------------------

describe('lists sidebar — archived lists', () => {
  it('are hidden by default: the box is unticked and the read excludes them', async () => {
    const el = await mountAt('/tasks')
    expect((must(el, 'tasks-lists-archived-toggle') as HTMLInputElement).checked).toBe(false)
    expect(must(el, 'tasks-lists-archived-toggle').closest('label')?.textContent?.trim()).toBe('显示已归档')
    expect(rows(el).map((row) => row[0])).toEqual(['tl_a', 'tl_b', 'tl_c'])
    expect(listReads()).toEqual([SIDEBAR_FIRST_PAGE])
  })

  it('ticking the box re-reads from offset 0 with includeArchived=true and marks the archived row', async () => {
    const el = await mountAt('/tasks')
    await toggleArchived(el)
    expect(listReads()).toEqual([SIDEBAR_FIRST_PAGE, SIDEBAR_FIRST_PAGE_ARCHIVED])
    expect(rows(el)).toEqual([
      ['tl_a', 'Alpha', '所有者', false],
      ['tl_b', 'Beta', '可编辑', false],
      ['tl_c', 'Gamma', '只读', false],
      ['tl_d', 'Delta', '所有者', true],
    ])
    expect(text(el, 'tasks-lists-item-archived')).toBe('已归档')
    expect(shownAll(el, 'tasks-lists-item').map((row) => row.getAttribute('data-archived'))).toEqual(['false', 'false', 'false', 'true'])
  })

  it('unticking re-reads without them', async () => {
    const el = await mountAt('/tasks')
    await toggleArchived(el)
    await toggleArchived(el)
    expect(listReads()).toEqual([SIDEBAR_FIRST_PAGE, SIDEBAR_FIRST_PAGE_ARCHIVED, SIDEBAR_FIRST_PAGE])
    expect(rows(el).map((row) => row[0])).toEqual(['tl_a', 'tl_b', 'tl_c'])
  })

  it('a toggle starts over at offset 0 after more pages were read', async () => {
    const all = manyLists(150)
    h_.listsReply.mockImplementation((query: string) => pageOf(all, query))
    const el = await mountAt('/tasks')
    await click(el, 'tasks-lists-more')
    await toggleArchived(el)
    expect(listReads().at(-1)).toBe('/api/task-lists?includeArchived=true&limit=100&offset=0')
    expect(shownAll(el, 'tasks-lists-item')).toHaveLength(100)
  })

  it('a re-read from the first page after a failed next page drops the load-more failure note', async () => {
    const all = manyLists(150)
    h_.listsReply.mockImplementation((query: string) =>
      Number(new URLSearchParams(query).get('offset')) === 100 ? jsonResponse(500, {}) : pageOf(all, query),
    )
    const el = await mountAt('/tasks')
    await click(el, 'tasks-lists-more')
    must(el, 'tasks-lists-more-error')
    await toggleArchived(el)
    expect(shownAll(el, 'tasks-lists-item')).toHaveLength(100)
    expect(shown(el, 'tasks-lists-more-error')).toBeNull()
  })

  it('a read that lands after the box was ticked is dropped (the newer read wins)', async () => {
    const first = deferred<Response>()
    h_.listsReply.mockImplementationOnce(() => first.promise)
    const el = await mountAt('/tasks')
    await toggleArchived(el)
    expect(rows(el).map((row) => row[0])).toEqual(['tl_a', 'tl_b', 'tl_c', 'tl_d'])
    first.resolve(jsonResponse(200, { items: [taskList('tl_old', 'Old read', 'owner')], total: 1 }))
    await flush()
    expect(rows(el).map((row) => row[0])).toEqual(['tl_a', 'tl_b', 'tl_c', 'tl_d'])
  })

  it('a next page that lands after the box was ticked is not appended', async () => {
    const all = manyLists(150)
    const second = deferred<Response>()
    h_.listsReply.mockImplementation((query: string) => {
      const params = new URLSearchParams(query)
      if (params.get('includeArchived') === 'true') return jsonResponse(200, { items: [ARCHIVED], total: 1 })
      return Number(params.get('offset')) === 0 ? pageOf(all, query) : second.promise
    })
    const el = await mountAt('/tasks')
    await click(el, 'tasks-lists-more')
    await toggleArchived(el)
    second.resolve(pageOf(all, 'offset=100'))
    await flush()
    expect(rows(el).map((row) => row[0])).toEqual(['tl_d'])
  })
})

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

describe('lists sidebar — create', () => {
  it('the submit button is disabled while the name is blank', async () => {
    const el = await mountAt('/tasks')
    expect(disabled(el, 'tasks-lists-create-submit')).toBe(true)
    await typeName(el, '   ')
    expect(disabled(el, 'tasks-lists-create-submit')).toBe(true)
    await typeName(el, 'Groceries')
    expect(disabled(el, 'tasks-lists-create-submit')).toBe(false)
  })

  it('sends the normalized name — edges trimmed, NFC', async () => {
    const el = await mountAt('/tasks')
    await typeName(el, '  Café list  ')
    await submitCreate(el)
    expect(createBodies()).toEqual([JSON.stringify({ name: 'Café list' })])
  })

  it('pre-check: a name of zero-width marks only is INVALID_NAME, inline, and nothing is sent', async () => {
    const el = await mountAt('/tasks')
    await typeName(el, '​​')
    await submitCreate(el)
    expect(text(el, 'tasks-lists-create-error')).toBe('名称不能为空')
    expect(must(el, 'tasks-lists-create-error').getAttribute('role')).toBe('alert')
    expect(must(el, 'tasks-lists-create-input').getAttribute('aria-invalid')).toBe('true')
    expect(must(el, 'tasks-lists-create-input').getAttribute('aria-describedby')).toBe('tasks-lists-create-error')
    expect(createBodies()).toEqual([])
  })

  it('pre-check: 101 code points is NAME_TOO_LONG and nothing is sent; 100 code points is sent', async () => {
    const el = await mountAt('/tasks')
    await typeName(el, '\u{1F600}'.repeat(101))
    await submitCreate(el)
    expect(text(el, 'tasks-lists-create-error')).toBe('名称过长')
    expect(createBodies()).toEqual([])
    await typeName(el, '\u{1F600}'.repeat(100))
    await submitCreate(el)
    expect(createBodies()).toEqual([JSON.stringify({ name: '\u{1F600}'.repeat(100) })])
  })

  it('pre-check: a name holding U+0000 is INVALID_NAME', async () => {
    const el = await mountAt('/tasks')
    await typeName(el, 'a\u0000b')
    await submitCreate(el)
    expect(text(el, 'tasks-lists-create-error')).toBe('名称不能为空')
    expect(createBodies()).toEqual([])
  })

  it.each([
    ['INVALID_NAME', '名称不能为空'],
    ['NAME_TOO_LONG', '名称过长'],
    ['SOMETHING_NEW', '操作失败，请稍后重试'],
  ] as const)('the server answering 422 %s renders inline and keeps the typed name', async (code, copy) => {
    h_.createReply.mockImplementation(() => jsonResponse(422, { error: { code } }))
    const el = await mountAt('/tasks')
    await typeName(el, 'Groceries')
    await submitCreate(el)
    expect(text(el, 'tasks-lists-create-error')).toBe(copy)
    expect((must(el, 'tasks-lists-create-input') as HTMLInputElement).value).toBe('Groceries')
    expect(router!.currentRoute.value.path).toBe('/tasks')
  })

  it.each([
    ['403', () => jsonResponse(403, { error: 'Insufficient permissions' }), '您没有权限创建清单'],
    ['404', () => jsonResponse(404, { error: { code: 'NOT_FOUND' } }), '清单功能暂不可用'],
    ['500', () => jsonResponse(500, {}), '创建清单失败，请稍后重试'],
    ['a malformed 200', () => jsonResponse(200, { id: 'tl_new' }), '创建清单失败，请稍后重试'],
    ['a transport failure', () => Promise.reject(new Error('offline')), '创建清单失败，请稍后重试'],
  ] as const)('a %s renders its own copy next to the form', async (_label, reply, copy) => {
    h_.createReply.mockImplementation(reply)
    const el = await mountAt('/tasks')
    await typeName(el, 'Groceries')
    await submitCreate(el)
    expect(text(el, 'tasks-lists-create-error')).toBe(copy)
    expect(router!.currentRoute.value.path).toBe('/tasks')
  })

  it('422 ORG_MISSING switches the page to the org guidance block', async () => {
    h_.createReply.mockImplementation(() => jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    const el = await mountAt('/tasks')
    await typeName(el, 'Groceries')
    await submitCreate(el)
    must(el, 'tasks-view-org-missing')
    expect(shown(el, 'tasks-lists-sidebar')).toBeNull()
  })

  it('ok: the input clears, the lists bus hears it once, the first page is read again and the new list opens', async () => {
    const bus = watchBus()
    const el = await mountAt('/tasks')
    await typeName(el, 'Groceries')
    await submitCreate(el)
    await flush()
    expect(createBodies()).toEqual([JSON.stringify({ name: 'Groceries' })])
    expect(bus).toHaveBeenCalledTimes(1)
    expect(listReads()).toEqual([SIDEBAR_FIRST_PAGE, SIDEBAR_FIRST_PAGE])
    expect(router!.currentRoute.value.path).toBe('/task-lists/tl_new')
    expect(text(el, 'list-page-stand-in')).toBe('tl_new')
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
  })

  it('ok re-reads the first page under the box as it stands, and clears the input (navigation held back)', async () => {
    const el = await mountAt('/tasks')
    await toggleArchived(el)
    // Hold the navigation back so the sidebar stays on screen and its re-read can be watched.
    const push = vi.spyOn(router!, 'push').mockResolvedValue(undefined)
    await typeName(el, 'Groceries')
    await submitCreate(el)
    expect(push).toHaveBeenCalledWith('/task-lists/tl_new')
    expect(listReads()).toEqual([SIDEBAR_FIRST_PAGE, SIDEBAR_FIRST_PAGE_ARCHIVED, SIDEBAR_FIRST_PAGE_ARCHIVED])
    expect((must(el, 'tasks-lists-create-input') as HTMLInputElement).value).toBe('')
    expect(rows(el).map((row) => row[0])).toEqual(['tl_a', 'tl_b', 'tl_c', 'tl_d'])
    push.mockRestore()
  })

  it('one create at a time: the input and button are disabled while it is in flight, and a second submit sends nothing', async () => {
    const pending = deferred<Response>()
    h_.createReply.mockImplementation(() => pending.promise)
    const el = await mountAt('/tasks')
    await typeName(el, 'Groceries')
    await submitCreate(el)
    expect(disabled(el, 'tasks-lists-create-submit')).toBe(true)
    expect(disabled(el, 'tasks-lists-create-input')).toBe(true)
    await submitCreate(el)
    expect(createBodies()).toHaveLength(1)
    pending.resolve(jsonResponse(422, { error: { code: 'INVALID_NAME' } }))
    await flush()
    expect(disabled(el, 'tasks-lists-create-input')).toBe(false)
    expect(disabled(el, 'tasks-lists-create-submit')).toBe(false)
  })

  it('typing again clears the inline error', async () => {
    const el = await mountAt('/tasks')
    await typeName(el, '​')
    await submitCreate(el)
    must(el, 'tasks-lists-create-error')
    await typeName(el, 'Groceries')
    expect(shown(el, 'tasks-lists-create-error')).toBeNull()
  })

  it('a create answered after the viewer opened a task does not navigate; the lists bus still hears it once', async () => {
    const pending = deferred<Response>()
    h_.createReply.mockImplementation(() => pending.promise)
    const bus = watchBus()
    const el = await mountAt('/tasks')
    await typeName(el, 'Groceries')
    await submitCreate(el)
    await go('/tasks/t1')
    must(el, 'tasks-detail')
    pending.resolve(jsonResponse(200, taskList('tl_new', 'Groceries', 'owner')))
    // As many cycles as the in-time navigation above needs, twice over.
    await flush()
    await flush()
    await flush()
    expect(router!.currentRoute.value.path).toBe('/tasks/t1')
    must(el, 'tasks-detail')
    expect(bus).toHaveBeenCalledTimes(1)
  })

  it('a create answered with ORG_MISSING after the viewer opened a task leaves the detail page alone', async () => {
    const pending = deferred<Response>()
    h_.createReply.mockImplementation(() => pending.promise)
    const el = await mountAt('/tasks')
    await typeName(el, 'Groceries')
    await submitCreate(el)
    await go('/tasks/t1')
    pending.resolve(jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    await flush()
    must(el, 'tasks-detail')
    expect(shown(el, 'tasks-view-org-missing')).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// The lists bus (TasksView and the sidebar both listen)
// ---------------------------------------------------------------------------------------------

describe('lists bus — who re-reads', () => {
  it('on /tasks: the sidebar reads its first page again; nothing reads "my lists"', async () => {
    const el = await mountAt('/tasks')
    notifyListsChanged()
    await flush()
    expect(listReads()).toEqual([SIDEBAR_FIRST_PAGE, SIDEBAR_FIRST_PAGE])
    expect(rows(el)).toHaveLength(3)
  })

  it('on /tasks with the box ticked: the re-read keeps includeArchived=true', async () => {
    const el = await mountAt('/tasks')
    await toggleArchived(el)
    notifyListsChanged()
    await flush()
    expect(listReads()).toEqual([SIDEBAR_FIRST_PAGE, SIDEBAR_FIRST_PAGE_ARCHIVED, SIDEBAR_FIRST_PAGE_ARCHIVED])
  })

  it('on a task page: "my lists" is read again (every page, archived included); no sidebar read', async () => {
    const el = await mountAt('/tasks/t1')
    const before = listReads()
    expect(before).toEqual([SIDEBAR_FIRST_PAGE_ARCHIVED])
    notifyListsChanged()
    await flush()
    expect(listReads()).toEqual([SIDEBAR_FIRST_PAGE_ARCHIVED, SIDEBAR_FIRST_PAGE_ARCHIVED])
    must(el, 'tasks-detail')
  })

  it('on a task page whose context is not ready: nothing is read', async () => {
    h_.loadTasksContext.mockResolvedValue({ state: 'forbidden' })
    await mountAt('/tasks/t1')
    notifyListsChanged()
    await flush()
    expect(listReads()).toEqual([])
  })

  it('after leaving /tasks for a task: only the task page listens (the sidebar unsubscribed)', async () => {
    await mountAt('/tasks')
    await go('/tasks/t1')
    const reads = listReads().length
    notifyListsChanged()
    await flush()
    expect(listReads().slice(reads)).toEqual([SIDEBAR_FIRST_PAGE_ARCHIVED])
  })

  it('after the page is gone: nobody reads', async () => {
    await mountAt('/tasks')
    app!.unmount()
    app = null
    const reads = listReads().length
    notifyListsChanged()
    await flush()
    expect(listReads()).toHaveLength(reads)
  })

  it('the sidebar subscribes before anything awaits: an unmount while the context is still loading leaves no listener', async () => {
    const context = deferred<unknown>()
    h_.loadTasksContext.mockReturnValue(context.promise)
    await mountAt('/tasks')
    app!.unmount()
    app = null
    context.resolve({ state: 'ready', orgId: 'org1' })
    await flush()
    notifyListsChanged()
    await flush()
    expect(listReads()).toEqual([])
  })
})
