import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'

/**
 * M4 FE-7 — the grouping board in both scopes: the list page's groups on `/task-lists/:id`
 * (TaskListView) and the assigned view's personal groups on `/tasks` (TaskPersonalGroups in
 * TasksView), both through TaskGroupBoard.vue; and the board's pure rules
 * (src/tasks/tasksGroupBoard.ts). docs/development/task-m4-frontend-design-20261007.md §2.4, §4.4,
 * §4.6, §6, §10.1.
 *
 * Backend: the twelve group routes are PR-3a S8 (built on the PR-3a branch, not on main). These
 * cells are coded to that contract (PR-3a verification §S8.10) and mock the transport.
 *
 * Mock face: `apiFetch` plays the backend by path over a small in-memory state that applies a
 * placement the way the contract does — the position counts the target group's visible tasks
 * without the moved one, the group is renumbered densely, the personal default group's row lands on
 * the first write that needs it, a placements read renumbers each group densely — so the REAL
 * tasksApi client builds every request and parses every answer, and request bodies are asserted as
 * serialized. Also mocked: `loadTasksContext`, the badge bus, `useAuth` (the viewer's own id) and
 * `useLocale` (ZH). The router is real: `/tasks` and `/tasks/:id` on TasksView, `/task-lists/:id` on
 * TaskListView.
 */

const h_ = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  loadTasksContext: vi.fn(),
  notifyTasksChanged: vi.fn(),
  getCurrentUserId: vi.fn(),
  /** `GET /api/tasks?view=…` (the view). */
  tasksReply: vi.fn(),
  /** `POST /api/tasks/:id/complete` (task id). */
  completeReply: vi.fn(),
  /** `GET /api/task-groups?…` (query). */
  userGroupsReply: vi.fn(),
  /** `GET /api/task-groups/items?…` (query). */
  userPlacementsReply: vi.fn(),
  /** `PUT /api/task-groups/items/:taskId` (task id, serialized body). */
  userPlaceReply: vi.fn(),
  /** `POST /api/task-groups` (serialized body). */
  userCreateReply: vi.fn(),
  /** `PATCH /api/task-groups/:groupId` (group id, serialized body). */
  userRenameReply: vi.fn(),
  /** `DELETE /api/task-groups/:groupId` (group id). */
  userDeleteReply: vi.fn(),
  /** `GET /api/task-lists/:id` (list id). */
  listReply: vi.fn(),
  /** `PATCH /api/task-lists/:id` (list id, serialized body). */
  listRenameReply: vi.fn(),
  /** `GET /api/task-lists/:id/items?…` (list id, query). */
  itemsReply: vi.fn(),
  /** `POST /api/task-lists/:id/items` (list id, serialized body). */
  addItemReply: vi.fn(),
  /** `DELETE /api/task-lists/:id/items/:taskId` (list id, task id). */
  removeItemReply: vi.fn(),
  /** `GET /api/task-lists/:id/groups?…` (list id, query). */
  listGroupsReply: vi.fn(),
  /** `GET /api/task-lists/:id/group-items?…` (list id, query). */
  listPlacementsReply: vi.fn(),
  /** `PUT /api/task-lists/:id/group-items/:taskId` (list id, task id, serialized body). */
  listPlaceReply: vi.fn(),
  /** `POST /api/task-lists/:id/groups` (list id, serialized body). */
  listCreateReply: vi.fn(),
  /** `PATCH /api/task-lists/:id/groups/:groupId` (list id, group id, serialized body). */
  listGroupRenameReply: vi.fn(),
  /** `DELETE /api/task-lists/:id/groups/:groupId` (list id, group id). */
  listGroupDeleteReply: vi.fn(),
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

import TasksView from '../src/views/tasks/TasksView.vue'
import TaskListView from '../src/views/tasks/TaskListView.vue'
import {
  DEFAULT_GROUP_KEY,
  applyMove,
  buildBoardModel,
  planDrop,
  planJoinOrder,
  planMove,
  planStep,
  planToGroup,
} from '../src/tasks/tasksGroupBoard'
import type { TaskGroup, TaskListItem, TaskPlacement } from '../src/tasks/tasksApi'

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

type Row = TaskListItem
type Group = TaskGroup
type Placement = TaskPlacement

function row(id: string, over: Partial<Row> = {}): Row {
  return { id, title: `Title-${id}`, status: 'open', completion_mode: 'all', created_by: 'u1', due_at: null, ...over }
}

function userGroup(id: string | null, name: string, position: number, isDefault = false): Group {
  return { id, scope: 'user', name, position, isDefault }
}

function listGroup(id: string, name: string, position: number, isDefault = false): Group {
  return { id, scope: 'list', name, position, isDefault }
}

function at(groupId: string, taskId: string, position: number): Placement {
  return { groupId, taskId, position }
}

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

/** The id the personal default group's row gets on the first write that needs it. */
const LANDED = 'tg_landed'

// ---------------------------------------------------------------------------------------------
// The fake backend
// ---------------------------------------------------------------------------------------------

/** The assigned view's rows (every view answers with them). */
let assigned: Row[] = []
let userGroups: Group[] = []
let userPlacements: Placement[] = []
let lists: Record<string, Record<string, unknown>> = {}
let listRows: Record<string, Row[]> = {}
let listGroups: Record<string, Group[]> = {}
let listPlacements: Record<string, Placement[]> = {}
let createdSeq = 0

function jsonResponse(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response
}

function codeResponse(code: string, status = 422): Response {
  return jsonResponse(status, { error: { code } })
}

const NOT_FOUND = (): Response => jsonResponse(404, { error: { code: 'NOT_FOUND' } })

function page(all: unknown[], query: string): Response {
  const offset = Number(new URLSearchParams(query).get('offset'))
  return jsonResponse(200, { items: all.slice(offset, offset + 100), total: all.length })
}

function compareText(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function byPlacement(a: Placement, b: Placement): number {
  return a.position - b.position || compareText(a.taskId, b.taskId)
}

/** A placements read as the server answers it: only the visible rows' placements, renumbered
 *  densely inside each group, by group id, then position. */
function placementsPage(all: Placement[], visible: Row[], query: string): Response {
  const ids = new Set(visible.map((item) => item.id))
  const byGroup = new Map<string, Placement[]>()
  for (const placement of all) {
    if (!ids.has(placement.taskId)) continue
    byGroup.set(placement.groupId, [...(byGroup.get(placement.groupId) ?? []), placement])
  }
  const out: Placement[] = []
  for (const groupId of [...byGroup.keys()].sort(compareText)) {
    ;[...(byGroup.get(groupId) as Placement[])].sort(byPlacement).forEach((placement, index) => {
      out.push({ groupId, taskId: placement.taskId, position: index })
    })
  }
  return page(out, query)
}

/** `PUT …/:taskId` `{ groupId, position }` as the contract applies it. */
function applyPlace(groups: Group[], placements: Placement[], visible: Row[], taskId: string, rawBody: string | undefined): Response {
  const { groupId, position } = JSON.parse(rawBody ?? '{}') as { groupId: string | null; position: number }
  const target = groupId === null ? groups.find((group) => group.isDefault) : groups.find((group) => group.id === groupId)
  if (!target) return codeResponse('INVALID_GROUP')
  const ids = new Set(visible.map((item) => item.id))
  const targetId = target.id ?? LANDED
  const others = placements
    .filter((placement) => placement.groupId === targetId && placement.taskId !== taskId && ids.has(placement.taskId))
    .sort(byPlacement)
  if (!Number.isInteger(position) || position < 0 || position > others.length) return codeResponse('INVALID_POSITION')
  target.id = targetId
  others.splice(position, 0, { groupId: targetId, taskId, position })
  const rest = placements.filter((placement) => placement.taskId !== taskId && placement.groupId !== targetId)
  placements.splice(0, placements.length, ...rest, ...others.map((placement, index) => ({ groupId: targetId, taskId: placement.taskId, position: index })))
  return jsonResponse(200, { taskId, groupId: targetId, position })
}

function applyCreate(groups: Group[], scope: 'list' | 'user', rawBody: string | undefined): Response {
  const { name } = JSON.parse(rawBody ?? '{}') as { name: string }
  if (groups.length >= 50) return codeResponse('LIMIT')
  const fallback = groups.find((group) => group.isDefault)
  if (fallback && fallback.id === null) fallback.id = LANDED
  createdSeq += 1
  const group: Group = { id: `tg_new${createdSeq}`, scope, name, position: groups.length, isDefault: false }
  groups.push(group)
  return jsonResponse(200, group)
}

function applyRename(groups: Group[], groupId: string, rawBody: string | undefined): Response {
  const group = groups.find((item) => item.id === groupId)
  if (!group) return NOT_FOUND()
  group.name = (JSON.parse(rawBody ?? '{}') as { name: string }).name
  return jsonResponse(200, group)
}

function applyDelete(groups: Group[], placements: Placement[], groupId: string): Response {
  const index = groups.findIndex((group) => group.id === groupId)
  if (index < 0) return NOT_FOUND()
  if (groups[index].isDefault) return codeResponse('IS_DEFAULT')
  groups.splice(index, 1)
  placements.splice(0, placements.length, ...placements.filter((placement) => placement.groupId !== groupId))
  ;[...groups].sort((a, b) => a.position - b.position || compareText(a.id ?? '', b.id ?? '')).forEach((group, place) => {
    group.position = place
  })
  return jsonResponse(200, { id: groupId, deleted: true, reassignedTo: groups.find((group) => group.isDefault)?.id })
}

type FetchInit = { method?: string; body?: string } | undefined

/** Requests the fake backend has no route for. Checked empty after every cell. */
let unexpected: string[] = []

async function fakeFetch(path: string, init?: FetchInit): Promise<Response> {
  const method = init?.method ?? 'GET'
  const [pathname, query = ''] = path.split('?')
  let match: RegExpExecArray | null
  if (method === 'GET' && pathname === '/api/tasks') return h_.tasksReply(new URLSearchParams(query).get('view'))
  if (method === 'GET' && (match = /^\/api\/tasks\/([^/]+)$/.exec(pathname))) return jsonResponse(200, detailBody(decodeURIComponent(match[1])))
  if (method === 'GET' && /^\/api\/tasks\/[^/]+\/comments$/.test(pathname)) return jsonResponse(200, { items: [], total: 0 })
  if (method === 'POST' && (match = /^\/api\/tasks\/([^/]+)\/complete$/.exec(pathname))) return h_.completeReply(decodeURIComponent(match[1]))
  // The lists sidebar on /tasks and the detail page's "my lists".
  if (method === 'GET' && pathname === '/api/task-lists') return page([], query)
  if (method === 'GET' && pathname === '/api/task-groups') return h_.userGroupsReply(query)
  if (method === 'GET' && pathname === '/api/task-groups/items') return h_.userPlacementsReply(query)
  if (method === 'PUT' && (match = /^\/api\/task-groups\/items\/([^/]+)$/.exec(pathname))) {
    return h_.userPlaceReply(decodeURIComponent(match[1]), init?.body)
  }
  if (method === 'POST' && pathname === '/api/task-groups') return h_.userCreateReply(init?.body)
  if ((match = /^\/api\/task-groups\/([^/]+)$/.exec(pathname))) {
    const groupId = decodeURIComponent(match[1])
    if (method === 'PATCH') return h_.userRenameReply(groupId, init?.body)
    if (method === 'DELETE') return h_.userDeleteReply(groupId)
  }
  if ((match = /^\/api\/task-lists\/([^/]+)$/.exec(pathname))) {
    const id = decodeURIComponent(match[1])
    if (method === 'GET') return h_.listReply(id)
    if (method === 'PATCH') return h_.listRenameReply(id, init?.body)
  }
  if ((match = /^\/api\/task-lists\/([^/]+)\/items$/.exec(pathname))) {
    const id = decodeURIComponent(match[1])
    if (method === 'GET') return h_.itemsReply(id, query)
    if (method === 'POST') return h_.addItemReply(id, init?.body)
  }
  if (method === 'DELETE' && (match = /^\/api\/task-lists\/([^/]+)\/items\/([^/]+)$/.exec(pathname))) {
    return h_.removeItemReply(decodeURIComponent(match[1]), decodeURIComponent(match[2]))
  }
  if ((match = /^\/api\/task-lists\/([^/]+)\/groups$/.exec(pathname))) {
    const id = decodeURIComponent(match[1])
    if (method === 'GET') return h_.listGroupsReply(id, query)
    if (method === 'POST') return h_.listCreateReply(id, init?.body)
  }
  if ((match = /^\/api\/task-lists\/([^/]+)\/groups\/([^/]+)$/.exec(pathname))) {
    const id = decodeURIComponent(match[1])
    const groupId = decodeURIComponent(match[2])
    if (method === 'PATCH') return h_.listGroupRenameReply(id, groupId, init?.body)
    if (method === 'DELETE') return h_.listGroupDeleteReply(id, groupId)
  }
  if (method === 'GET' && (match = /^\/api\/task-lists\/([^/]+)\/group-items$/.exec(pathname))) {
    return h_.listPlacementsReply(decodeURIComponent(match[1]), query)
  }
  if (method === 'PUT' && (match = /^\/api\/task-lists\/([^/]+)\/group-items\/([^/]+)$/.exec(pathname))) {
    return h_.listPlaceReply(decodeURIComponent(match[1]), decodeURIComponent(match[2]), init?.body)
  }
  unexpected.push(`${method} ${path}`)
  return jsonResponse(599, {})
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolveFn = res
  })
  return { promise, resolve: resolveFn }
}

// ---------------------------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------------------------

const ASSIGNED = '/api/tasks?view=assigned'
const USER_GROUPS = '/api/task-groups?limit=100&offset=0'
const USER_PLACEMENTS = '/api/task-groups/items?limit=100&offset=0'

function listPath(id: string, suffix: string): string {
  return `/api/task-lists/${id}${suffix}`
}

function listGroupsRead(id = 'tl_1'): string {
  return listPath(id, '/groups?limit=100&offset=0')
}

function listPlacementsRead(id = 'tl_1'): string {
  return listPath(id, '/group-items?limit=100&offset=0')
}

function listItemsRead(id = 'tl_1'): string {
  return listPath(id, '/items?limit=100&offset=0')
}

function calls(): Array<[string, FetchInit]> {
  return h_.apiFetch.mock.calls as Array<[string, FetchInit]>
}

/** GET requests to exactly `path`. */
function reads(path: string): number {
  return calls().filter(([p, init]) => p === path && (init?.method ?? 'GET') === 'GET').length
}

/** Every write as `METHOD path body`. */
function writes(): string[] {
  return calls()
    .filter(([, init]) => (init?.method ?? 'GET') !== 'GET')
    .map(([p, init]) => `${init?.method} ${p}${init?.body === undefined ? '' : ` ${init.body}`}`)
}

// ---------------------------------------------------------------------------------------------
// Mount and DOM helpers
// ---------------------------------------------------------------------------------------------

let app: VueApp<Element> | null = null
let container: HTMLDivElement | null = null
let router: Router | null = null

async function flush(cycles = 40): Promise<void> {
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

function shown(el: ParentNode, testid: string): HTMLElement | null {
  return el.querySelector(`[data-testid="${testid}"]`)
}

function shownAll(el: ParentNode, testid: string): HTMLElement[] {
  return Array.from(el.querySelectorAll(`[data-testid="${testid}"]`))
}

function must(el: ParentNode, testid: string): HTMLElement {
  const found = shown(el, testid)
  expect(found, `expected [data-testid="${testid}"]`).toBeTruthy()
  return found as HTMLElement
}

function text(el: ParentNode, testid: string): string {
  return must(el, testid).textContent?.trim() ?? ''
}

/** The board's root, or `null` while the rows render flat. */
function board(el: HTMLElement): HTMLElement | null {
  return el.querySelector('[data-testid="tasks-list"][data-scope]')
}

function ids(list: Element | null): string[] {
  return list ? Array.from(list.children).map((child) => child.getAttribute('data-task-id') ?? '') : []
}

interface SectionView {
  id: string
  isDefault: boolean
  name: string
  count: string
  ordered: string[]
  tail: string[]
}

function sections(el: HTMLElement): SectionView[] {
  const root = board(el)
  if (!root) return []
  return shownAll(root, 'tasks-group').map((section) => ({
    id: section.getAttribute('data-group-id') ?? '',
    isDefault: section.getAttribute('data-default') === 'true',
    name: shown(section, 'tasks-group-name')?.textContent?.trim() ?? '',
    count: shown(section, 'tasks-group-count')?.textContent?.trim() ?? '',
    ordered: ids(shown(section, 'tasks-group-items')),
    tail: ids(shown(section, 'tasks-group-unsorted')),
  }))
}

/** `[group id, placed rows, tail rows]` per section, in board order. */
function layout(el: HTMLElement): Array<[string, string[], string[]]> {
  return sections(el).map((section) => [section.id, section.ordered, section.tail])
}

function section(el: HTMLElement, groupId: string): HTMLElement {
  const found = shownAll(el, 'tasks-group').find((item) => item.getAttribute('data-group-id') === groupId)
  expect(found, `expected the section of group "${groupId}"`).toBeTruthy()
  return found as HTMLElement
}

/** The row of `taskId` (board or flat). */
function rowOf(el: HTMLElement, taskId: string): HTMLElement {
  const found = Array.from(el.querySelectorAll<HTMLElement>('[data-task-id]')).find((item) => item.getAttribute('data-task-id') === taskId)
  expect(found, `expected the row of "${taskId}"`).toBeTruthy()
  return found as HTMLElement
}

function inRow(el: HTMLElement, taskId: string, testid: string): HTMLElement {
  return must(rowOf(el, taskId), testid)
}

/** Every row's task id in document order, by the rows' test id. */
function rowOrder(el: HTMLElement, testid: string): string[] {
  return shownAll(el, testid).map((item) => item.getAttribute('data-task-id') ?? '')
}

async function clickIn(el: HTMLElement, taskId: string, testid: string): Promise<void> {
  inRow(el, taskId, testid).click()
  await flush()
}

async function click(el: HTMLElement, testid: string): Promise<void> {
  must(el, testid).click()
  await flush()
}

async function pick(el: HTMLElement, taskId: string, value: string): Promise<void> {
  const select = inRow(el, taskId, 'tasks-group-move-to') as HTMLSelectElement
  select.value = value
  select.dispatchEvent(new Event('change'))
  await flush()
}

async function typeInto(input: HTMLElement, value: string): Promise<void> {
  ;(input as HTMLInputElement).value = value
  input.dispatchEvent(new Event('input'))
  await flush()
}

async function submit(form: HTMLElement): Promise<void> {
  form.dispatchEvent(new Event('submit', { cancelable: true }))
  await flush()
}

async function createGroup(el: HTMLElement, name: string): Promise<void> {
  await typeInto(must(el, 'tasks-groups-create-input'), name)
  await submit(must(el, 'tasks-groups-create-form'))
}

function dragEvent(type: string, clientY = 0): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, clientY })
}

/** Drags `taskId` by its handle and drops it on a row (its lower half when `after`; jsdom's boxes
 *  are all zero, so `clientY: 1` is past the middle) or on a group's free space. */
async function drag(el: HTMLElement, taskId: string, target: { row?: string; after?: boolean; group?: string }): Promise<void> {
  const handle = inRow(el, taskId, 'tasks-group-drag-handle')
  handle.dispatchEvent(dragEvent('dragstart'))
  const dropOn = target.row !== undefined ? rowOf(el, target.row) : section(el, target.group as string)
  dropOn.dispatchEvent(dragEvent('dragover'))
  dropOn.dispatchEvent(dragEvent('drop', target.after ? 1 : 0))
  handle.dispatchEvent(dragEvent('dragend'))
  await flush()
}

function disabled(element: HTMLElement): boolean {
  return (element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement).disabled
}

/** Which move controls of the row are usable. */
function moveState(el: HTMLElement, taskId: string): Record<string, boolean | null> {
  const rowElement = rowOf(el, taskId)
  const state = (testid: string): boolean | null => {
    const found = shown(rowElement, testid)
    return found === null ? null : !disabled(found)
  }
  return {
    up: state('tasks-group-move-up'),
    down: state('tasks-group-move-down'),
    join: state('tasks-group-add-to-order'),
    select: state('tasks-group-move-to'),
  }
}

/** Whether each of the board's own controls is usable (the host's row content left out). */
function boardControlsEnabled(el: HTMLElement): boolean[] {
  const root = board(el) as HTMLElement
  return Array.from(root.querySelectorAll<HTMLElement>('[data-testid^="tasks-group"]'))
    .filter((element) => ['BUTTON', 'INPUT', 'SELECT'].includes(element.tagName))
    .map((element) => !disabled(element))
}

function handles(el: HTMLElement): string[] {
  return shownAll(el, 'tasks-group-drag-handle').map((handle) => handle.getAttribute('draggable') ?? '')
}

// ---------------------------------------------------------------------------------------------
// Personal fixtures
// ---------------------------------------------------------------------------------------------

/** A viewer without groups: the synthetic default group (no id), no placements. */
function seedPlain(): void {
  assigned = [row('t1', { title: 'Task One', due_at: '2031-03-15T02:00:00.000Z' }), row('t2', { title: 'Task Two', status: 'done' }), row('t3'), row('t4')]
  userGroups = [userGroup(null, '默认分组', 0, true)]
  userPlacements = []
}

/** The default group (landed) holds t5, t2, t6; Alpha holds t4, t1; Beta is empty; t3 is
 *  unsorted. The server keeps the groups and the placements out of board order. */
function seedGrouped(): void {
  assigned = ['t1', 't2', 't3', 't4', 't5', 't6'].map((id) => row(id))
  userGroups = [userGroup('tg_b', 'Beta', 2), userGroup('tg_def', '默认分组', 0, true), userGroup('tg_a', 'Alpha', 1)]
  userPlacements = [at('tg_a', 't1', 1), at('tg_def', 't2', 1), at('tg_a', 't4', 0), at('tg_def', 't5', 0), at('tg_def', 't6', 2)]
}

const GROUPED_LAYOUT: Array<[string, string[], string[]]> = [
  ['tg_def', ['t5', 't2', 't6'], ['t3']],
  ['tg_a', ['t4', 't1'], []],
  ['tg_b', [], []],
]

beforeEach(() => {
  unexpected = []
  createdSeq = 0
  seedPlain()
  lists = {
    tl_1: listBody('tl_1', { name: 'Groceries' }),
    tl_2: listBody('tl_2', { name: 'Chores' }),
  }
  listRows = {
    tl_1: [row('t1', { title: 'Task One', due_at: '2031-03-15T02:00:00.000Z' }), row('t2', { title: 'Task Two', status: 'done' }), row('t3', { title: 'Task Three' })],
    tl_2: [row('t7', { title: 'Task Seven' })],
  }
  listGroups = {
    tl_1: [listGroup('tg_l1', '默认分组', 0, true), listGroup('tg_x', 'Doing', 1)],
    tl_2: [listGroup('tg_l2', '默认分组', 0, true)],
  }
  listPlacements = { tl_1: [at('tg_x', 't3', 0)], tl_2: [] }

  h_.apiFetch.mockReset().mockImplementation(fakeFetch)
  h_.loadTasksContext.mockReset().mockResolvedValue({ state: 'ready', orgId: 'org1' })
  h_.notifyTasksChanged.mockReset()
  h_.getCurrentUserId.mockReset().mockResolvedValue('u1')
  h_.tasksReply.mockReset().mockImplementation(() => jsonResponse(200, { items: assigned, total: assigned.length }))
  h_.completeReply.mockReset().mockImplementation(() => jsonResponse(200, { done: true }))
  h_.userGroupsReply.mockReset().mockImplementation((query: string) => page(userGroups, query))
  h_.userPlacementsReply.mockReset().mockImplementation((query: string) => placementsPage(userPlacements, assigned, query))
  h_.userPlaceReply.mockReset().mockImplementation((taskId: string, body: string) => applyPlace(userGroups, userPlacements, assigned, taskId, body))
  h_.userCreateReply.mockReset().mockImplementation((body: string) => applyCreate(userGroups, 'user', body))
  h_.userRenameReply.mockReset().mockImplementation((groupId: string, body: string) => applyRename(userGroups, groupId, body))
  h_.userDeleteReply.mockReset().mockImplementation((groupId: string) => applyDelete(userGroups, userPlacements, groupId))
  h_.listReply.mockReset().mockImplementation((id: string) => (lists[id] ? jsonResponse(200, lists[id]) : NOT_FOUND()))
  h_.listRenameReply.mockReset().mockImplementation((id: string, body: string) => {
    lists[id] = { ...lists[id], name: JSON.parse(body).name }
    return jsonResponse(200, lists[id])
  })
  h_.itemsReply.mockReset().mockImplementation((id: string, query: string) => page(listRows[id] ?? [], query))
  h_.addItemReply.mockReset().mockImplementation((id: string, body: string) => {
    const taskId = JSON.parse(body).taskId as string
    listRows[id] = [...(listRows[id] ?? []), row(taskId)]
    return jsonResponse(200, { listId: id, taskId })
  })
  h_.removeItemReply.mockReset().mockImplementation((id: string, taskId: string) => {
    listRows[id] = (listRows[id] ?? []).filter((item) => item.id !== taskId)
    return jsonResponse(200, { listId: id, taskId })
  })
  h_.listGroupsReply.mockReset().mockImplementation((id: string, query: string) => page(listGroups[id] ?? [], query))
  h_.listPlacementsReply.mockReset().mockImplementation((id: string, query: string) =>
    placementsPage(listPlacements[id] ?? [], listRows[id] ?? [], query),
  )
  h_.listPlaceReply.mockReset().mockImplementation((id: string, taskId: string, body: string) =>
    applyPlace(listGroups[id], listPlacements[id], listRows[id], taskId, body),
  )
  h_.listCreateReply.mockReset().mockImplementation((id: string, body: string) => applyCreate(listGroups[id], 'list', body))
  h_.listGroupRenameReply.mockReset().mockImplementation((id: string, groupId: string, body: string) =>
    applyRename(listGroups[id], groupId, body),
  )
  h_.listGroupDeleteReply.mockReset().mockImplementation((id: string, groupId: string) =>
    applyDelete(listGroups[id], listPlacements[id], groupId),
  )
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
  router = null
  expect(unexpected).toEqual([])
})

// ---------------------------------------------------------------------------------------------
// The board's rules (pure)
// ---------------------------------------------------------------------------------------------

describe('board rules — the order (tasksGroupBoard.ts)', () => {
  it('groups by position, then id in code-unit order: an upper-case id sorts before a lower-case one', () => {
    const model = buildBoardModel(
      [listGroup('tg_a', 'a', 1), listGroup('tg_B', 'B', 1), listGroup('tg_d', 'D', 0, true), listGroup('tg_c', 'c', 0)],
      [],
      [],
    )
    expect(model?.groups.map((group) => group.id)).toEqual(['tg_c', 'tg_d', 'tg_B', 'tg_a'])
  })

  it('placed rows by placement position, then task id in code-unit order; the tail keeps the rows\' own order', () => {
    const items = [row('t9'), row('tb'), row('tB'), row('t1'), row('t0')]
    const model = buildBoardModel([listGroup('tg_d', 'D', 0, true)], [at('tg_d', 'tb', 3), at('tg_d', 'tB', 3), at('tg_d', 't1', 1)], items)
    expect(model?.ordered[DEFAULT_GROUP_KEY]).toEqual(['t1', 'tB', 'tb'])
    expect(model?.tail).toEqual(['t9', 't0'])
    expect(model?.consistent).toBe(true)
  })

  it('every group has a list, the default group under its own key; the others under their ids', () => {
    const model = buildBoardModel([listGroup('tg_d', 'D', 0, true), listGroup('tg_x', 'X', 1)], [at('tg_x', 't1', 0)], [row('t1'), row('t2')])
    expect(model?.ordered).toEqual({ [DEFAULT_GROUP_KEY]: [], tg_x: ['t1'] })
    expect(model?.tail).toEqual(['t2'])
  })

  it('a placement in the default group\'s own id lands in the default group', () => {
    const model = buildBoardModel([listGroup('tg_d', 'D', 0, true)], [at('tg_d', 't2', 0)], [row('t1'), row('t2')])
    expect(model?.ordered[DEFAULT_GROUP_KEY]).toEqual(['t2'])
    expect(model?.consistent).toBe(true)
  })

  it('a placement in a group the board does not have shows in the default group\'s order, merged by position — the board is not consistent', () => {
    const model = buildBoardModel(
      [listGroup('tg_d', 'D', 0, true)],
      [at('tg_d', 't1', 0), at('tg_d', 't3', 1), at('tg_gone', 't2', 0)],
      [row('t1'), row('t2'), row('t3'), row('t4')],
    )
    expect(model?.ordered[DEFAULT_GROUP_KEY]).toEqual(['t1', 't2', 't3'])
    expect(model?.tail).toEqual(['t4'])
    expect(model?.consistent).toBe(false)
  })

  it('a placement of a task that is not a row is not shown — the board is not consistent', () => {
    const model = buildBoardModel([listGroup('tg_d', 'D', 0, true)], [at('tg_d', 't9', 0), at('tg_d', 't1', 1)], [row('t1'), row('t2')])
    expect(model?.ordered[DEFAULT_GROUP_KEY]).toEqual(['t1'])
    expect(model?.tail).toEqual(['t2'])
    expect(model?.consistent).toBe(false)
  })

  it('the personal default group without an id holds the tail; the board is consistent', () => {
    const model = buildBoardModel([userGroup(null, 'D', 0, true)], [], [row('t1'), row('t2')])
    expect(model?.ordered).toEqual({ [DEFAULT_GROUP_KEY]: [] })
    expect(model?.tail).toEqual(['t1', 't2'])
    expect(model?.consistent).toBe(true)
  })

  it.each([
    ['no default group', [listGroup('tg_a', 'A', 0)]],
    ['two default groups', [listGroup('tg_a', 'A', 0, true), listGroup('tg_b', 'B', 1, true)]],
    ['two groups with one id', [listGroup('tg_d', 'D', 0, true), listGroup('tg_a', 'A', 1), listGroup('tg_a', 'A2', 2)]],
    ['a group with an empty id', [listGroup('tg_d', 'D', 0, true), listGroup('', 'A', 1)]],
    ['a group other than the default without an id', [listGroup('tg_d', 'D', 0, true), userGroup(null, 'A', 1)]],
  ] as const)('groups that cannot hold a board: %s', (_label, groups) => {
    expect(buildBoardModel([...groups], [], [row('t1')])).toBeNull()
  })
})

describe('board rules — moves (tasksGroupBoard.ts)', () => {
  // Default: A, B, C placed, T unsorted. Group X: X placed.
  const items = ['A', 'B', 'C', 'T', 'X'].map((id) => row(id))
  const groups = [listGroup('tg_d', 'D', 0, true), listGroup('tg_x', 'X', 1)]
  const placements = [at('tg_d', 'A', 0), at('tg_d', 'B', 1), at('tg_d', 'C', 2), at('tg_x', 'X', 0)]
  const model = () => buildBoardModel(groups, placements, items)!

  it('up and down step inside the group; the default group is null', () => {
    expect(planStep(model(), 'B', -1)).toEqual({ taskId: 'B', key: DEFAULT_GROUP_KEY, groupId: null, position: 0 })
    expect(planStep(model(), 'B', 1)).toEqual({ taskId: 'B', key: DEFAULT_GROUP_KEY, groupId: null, position: 2 })
    expect(planStep(model(), 'A', 1)).toEqual({ taskId: 'A', key: DEFAULT_GROUP_KEY, groupId: null, position: 1 })
  })

  it('no step past either end, and none for a tail row', () => {
    expect(planStep(model(), 'A', -1)).toBeNull()
    expect(planStep(model(), 'C', 1)).toBeNull()
    expect(planStep(model(), 'X', 1)).toBeNull()
    expect(planStep(model(), 'T', -1)).toBeNull()
    expect(planStep(model(), 'T', 1)).toBeNull()
  })

  it('a tail row joins the default group\'s order at its end; a placed row does not join', () => {
    expect(planJoinOrder(model(), 'T')).toEqual({ taskId: 'T', key: DEFAULT_GROUP_KEY, groupId: null, position: 3 })
    expect(planJoinOrder(model(), 'A')).toBeNull()
    // A row placed in another group: its position in that group is inside the default group's range.
    expect(planJoinOrder(model(), 'X')).toBeNull()
  })

  it('to another group: the end of its order, under its id; to the default group: null', () => {
    expect(planToGroup(model(), 'A', 'tg_x')).toEqual({ taskId: 'A', key: 'tg_x', groupId: 'tg_x', position: 1 })
    expect(planToGroup(model(), 'X', DEFAULT_GROUP_KEY)).toEqual({ taskId: 'X', key: DEFAULT_GROUP_KEY, groupId: null, position: 3 })
    expect(planToGroup(model(), 'T', 'tg_x')).toEqual({ taskId: 'T', key: 'tg_x', groupId: 'tg_x', position: 1 })
  })

  it('to the task\'s own group, or to a group the board does not have: no move', () => {
    expect(planToGroup(model(), 'A', DEFAULT_GROUP_KEY)).toBeNull()
    expect(planToGroup(model(), 'T', DEFAULT_GROUP_KEY)).toBeNull()
    expect(planToGroup(model(), 'X', 'tg_x')).toBeNull()
    expect(planToGroup(model(), 'A', 'tg_nope')).toBeNull()
  })

  it('a drop before a row counts that row\'s index without the moved task; after it, one more', () => {
    expect(planDrop(model(), 'A', DEFAULT_GROUP_KEY, 'C', false)).toEqual({ taskId: 'A', key: DEFAULT_GROUP_KEY, groupId: null, position: 1 })
    expect(planDrop(model(), 'A', DEFAULT_GROUP_KEY, 'C', true)).toEqual({ taskId: 'A', key: DEFAULT_GROUP_KEY, groupId: null, position: 2 })
    expect(planDrop(model(), 'C', DEFAULT_GROUP_KEY, 'A', false)).toEqual({ taskId: 'C', key: DEFAULT_GROUP_KEY, groupId: null, position: 0 })
    expect(planDrop(model(), 'X', DEFAULT_GROUP_KEY, 'B', true)).toEqual({ taskId: 'X', key: DEFAULT_GROUP_KEY, groupId: null, position: 2 })
  })

  it('a drop on the task\'s own place, or on the task itself: no move', () => {
    expect(planDrop(model(), 'B', DEFAULT_GROUP_KEY, 'C', false)).toBeNull()
    expect(planDrop(model(), 'B', DEFAULT_GROUP_KEY, 'A', true)).toBeNull()
    expect(planDrop(model(), 'B', DEFAULT_GROUP_KEY, 'B', false)).toBeNull()
  })

  it('a drop on a group\'s free space or on the unsorted tail goes to the end of that group\'s order', () => {
    expect(planDrop(model(), 'A', 'tg_x', null, false)).toEqual({ taskId: 'A', key: 'tg_x', groupId: 'tg_x', position: 1 })
    expect(planDrop(model(), 'X', DEFAULT_GROUP_KEY, 'T', false)).toEqual({ taskId: 'X', key: DEFAULT_GROUP_KEY, groupId: null, position: 3 })
    expect(planDrop(model(), 'A', DEFAULT_GROUP_KEY, 'T', false)).toEqual({ taskId: 'A', key: DEFAULT_GROUP_KEY, groupId: null, position: 2 })
  })

  it('positions outside the visible set without the task are refused', () => {
    expect(planMove(model(), 'A', DEFAULT_GROUP_KEY, 3)).toBeNull()
    expect(planMove(model(), 'A', DEFAULT_GROUP_KEY, -1)).toBeNull()
    expect(planMove(model(), 'A', DEFAULT_GROUP_KEY, 0.5)).toBeNull()
    expect(planMove(model(), 'A', DEFAULT_GROUP_KEY, 2)).toEqual({ taskId: 'A', key: DEFAULT_GROUP_KEY, groupId: null, position: 2 })
    expect(planMove(model(), 'T', 'tg_x', 2)).toBeNull()
    expect(planMove(model(), 'nope', 'tg_x', 0)).toBeNull()
  })

  it('applying a move takes the task out of its place (the tail included) and puts it at the position', () => {
    const joined = applyMove(model(), planJoinOrder(model(), 'T')!)
    expect(joined.ordered[DEFAULT_GROUP_KEY]).toEqual(['A', 'B', 'C', 'T'])
    expect(joined.tail).toEqual([])
    const crossed = applyMove(model(), planToGroup(model(), 'A', 'tg_x')!)
    expect(crossed.ordered).toEqual({ [DEFAULT_GROUP_KEY]: ['B', 'C'], tg_x: ['X', 'A'] })
    const front = applyMove(model(), planMove(model(), 'X', DEFAULT_GROUP_KEY, 0)!)
    expect(front.ordered[DEFAULT_GROUP_KEY]).toEqual(['X', 'A', 'B', 'C'])
    expect(front.ordered.tg_x).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// /tasks — the assigned view
// ---------------------------------------------------------------------------------------------

const VIEW_STATE_IDS = [
  'tasks-detail',
  'tasks-detail-not-found',
  'tasks-detail-forbidden',
  'tasks-detail-error',
  'tasks-detail-loading',
  'tasks-view-org-missing',
  'tasks-view-unavailable',
  'tasks-view-forbidden',
  'tasks-view-error',
  'tasks-list-empty',
  'tasks-list-error',
  'tasks-list-loading',
]

describe('/tasks — the assigned view\'s states (design §2.4)', () => {
  it('while the task list loads: no board and no group read', async () => {
    const pending = deferred<Response>()
    h_.tasksReply.mockImplementation(() => pending.promise)
    const el = await mountAt('/tasks')
    must(el, 'tasks-list-loading')
    expect(reads(USER_GROUPS) + reads(USER_PLACEMENTS)).toBe(0)
    pending.resolve(jsonResponse(200, { items: [], total: 0 }))
    await flush()
  })

  it.each([
    ['empty', () => jsonResponse(200, { items: [], total: 0 }), 'tasks-list-empty'],
    ['a failure', () => jsonResponse(500, {}), 'tasks-list-error'],
  ] as const)('a task list that is %s: the list\'s own state, no board, no group read', async (_label, reply, stateId) => {
    h_.tasksReply.mockImplementation(reply)
    const el = await mountAt('/tasks')
    must(el, stateId)
    expect(shown(el, 'tasks-list')).toBeNull()
    expect(reads(USER_GROUPS) + reads(USER_PLACEMENTS)).toBe(0)
  })

  it('another view: the plain list, and no group read for it', async () => {
    const el = await mountAt('/tasks')
    expect(reads(USER_GROUPS)).toBe(1)
    await click(el, 'tasks-view-switch-following')
    const list = must(el, 'tasks-list')
    expect(list.tagName).toBe('UL')
    expect(board(el)).toBeNull()
    expect(shownAll(el, 'tasks-list-item').map((item) => item.querySelector('a')?.textContent)).toEqual(['Task One', 'Task Two', 'Title-t3', 'Title-t4'])
    expect(reads(USER_GROUPS)).toBe(1)
    expect(reads(USER_PLACEMENTS)).toBe(1)
  })

  it('both group reads in flight: the plain list in the list\'s order, no notice, no board; both read once, together', async () => {
    const groups = deferred<Response>()
    const placements = deferred<Response>()
    h_.userGroupsReply.mockImplementation(() => groups.promise)
    h_.userPlacementsReply.mockImplementation(() => placements.promise)
    const el = await mountAt('/tasks')
    expect(reads(USER_GROUPS)).toBe(1)
    expect(reads(USER_PLACEMENTS)).toBe(1)
    expect(must(el, 'tasks-list').tagName).toBe('UL')
    expect(board(el)).toBeNull()
    expect(rowOrder(el, 'tasks-list-item')).toEqual(['t1', 't2', 't3', 't4'])
    expect(shown(el, 'tasks-groups-unavailable')).toBeNull()
    groups.resolve(page(userGroups, 'offset=0'))
    await flush()
    expect(board(el)).toBeNull()
    placements.resolve(page([], 'offset=0'))
    await flush()
    expect(board(el)).not.toBeNull()
  })

  it.each([
    ['the groups read fails', () => h_.userGroupsReply.mockImplementation(() => jsonResponse(500, {}))],
    ['the groups read is a 404', () => h_.userGroupsReply.mockImplementation(NOT_FOUND)],
    ['the groups read is a 403', () => h_.userGroupsReply.mockImplementation(() => jsonResponse(403, { error: 'Insufficient permissions' }))],
    ['the groups read reports no org', () => h_.userGroupsReply.mockImplementation(() => jsonResponse(200, { items: [], degraded: true, reason: 'org_missing' }))],
    ['the groups read is malformed', () => h_.userGroupsReply.mockImplementation(() => jsonResponse(200, { items: [userGroup(null, 'D', 0, false)], total: 1 }))],
    ['the placements read fails', () => h_.userPlacementsReply.mockImplementation(() => jsonResponse(500, {}))],
    ['the placements read is malformed', () => h_.userPlacementsReply.mockImplementation(() => jsonResponse(200, { items: [{ groupId: 1 }], total: 1 }))],
    ['the groups cannot hold a board', () => {
      userGroups = [userGroup('tg_a', 'A', 0, true), userGroup('tg_b', 'B', 1, true)]
    }],
  ] as const)('%s: the plain list with the "groups unavailable" notice; the rows stay', async (_label, arrange) => {
    arrange()
    const el = await mountAt('/tasks')
    expect(text(el, 'tasks-groups-unavailable')).toBe('分组不可用')
    expect(must(el, 'tasks-groups-unavailable').getAttribute('role')).toBe('status')
    expect(must(el, 'tasks-list').tagName).toBe('UL')
    expect(rowOrder(el, 'tasks-list-item')).toEqual(['t1', 't2', 't3', 't4'])
    expect(board(el)).toBeNull()
    expect(shown(el, 'tasks-view-org-missing')).toBeNull()
  })

  it('both in: the board carries the tasks-list id, and no other list-state id is inside it or anywhere', async () => {
    const el = await mountAt('/tasks')
    const root = board(el) as HTMLElement
    expect(root).not.toBeNull()
    expect(root.getAttribute('data-scope')).toBe('user')
    expect(shownAll(el, 'tasks-list')).toEqual([root])
    for (const id of VIEW_STATE_IDS) expect(shown(el, id), id).toBeNull()
  })

  it('no groups and no placements: every row in the default group\'s unsorted tail, in the list\'s order', async () => {
    const el = await mountAt('/tasks')
    expect(layout(el)).toEqual([['', [], ['t1', 't2', 't3', 't4']]])
    const hrefs = (): Array<string | null> => shownAll(el, 'tasks-list-item-link').map((link) => link.getAttribute('href'))
    const onBoard = hrefs()
    expect(onBoard).toEqual(['/tasks/t1', '/tasks/t2', '/tasks/t3', '/tasks/t4'])
    await click(el, 'tasks-view-switch-following')
    expect(board(el)).toBeNull()
    expect(hrefs()).toEqual(onBoard)
  })

  it('each board row\'s content is the plain list\'s row markup, element for element', async () => {
    const el = await mountAt('/tasks')
    const fromBoard = shownAll(el, 'tasks-list-item').map((item) =>
      Array.from(item.children)
        .filter((child) => !child.matches('.tasks-group-board__handle, .tasks-group-board__moves'))
        .map((child) => child.outerHTML),
    )
    await click(el, 'tasks-view-switch-following')
    const fromPlain = shownAll(el, 'tasks-list-item').map((item) => Array.from(item.children).map((child) => child.outerHTML))
    expect(fromBoard).toEqual(fromPlain)
    expect(fromBoard[0].length).toBe(4)
  })

  it('a group read answered after the view changed is dropped', async () => {
    const groups = deferred<Response>()
    h_.userGroupsReply.mockImplementation(() => groups.promise)
    const el = await mountAt('/tasks')
    await click(el, 'tasks-view-switch-following')
    groups.resolve(page(userGroups, 'offset=0'))
    await flush()
    expect(board(el)).toBeNull()
    expect(shown(el, 'tasks-groups-unavailable')).toBeNull()
    expect(must(el, 'tasks-list').tagName).toBe('UL')
  })
})

describe('/tasks — the board\'s order and default group', () => {
  it('groups by position then id, placed rows by position, the unsorted tail last in the default group', async () => {
    seedGrouped()
    const el = await mountAt('/tasks')
    expect(layout(el)).toEqual(GROUPED_LAYOUT)
    expect(sections(el).map((item) => [item.name, item.count, item.isDefault])).toEqual([
      ['默认分组', '4 项', true],
      ['Alpha', '2 项', false],
      ['Beta', '0 项', false],
    ])
    expect(text(section(el, 'tg_def'), 'tasks-group-unsorted-heading')).toBe('未排序')
    expect(text(section(el, 'tg_b'), 'tasks-group-empty')).toBe('此分组暂无任务')
    expect(shown(section(el, 'tg_a'), 'tasks-group-empty')).toBeNull()
    expect(shown(section(el, 'tg_a'), 'tasks-group-unsorted')).toBeNull()
    expect(rowOrder(el, 'tasks-list-item')).toEqual(['t5', 't2', 't6', 't3', 't4', 't1'])
  })

  it('ties in the server\'s positions are broken by task id in code-unit order', async () => {
    assigned = ['ta', 'tB', 't1'].map((id) => row(id))
    userGroups = [userGroup('tg_def', '默认分组', 0, true)]
    h_.userPlacementsReply.mockImplementation((query: string) => page([at('tg_def', 'ta', 3), at('tg_def', 'tB', 3)], query))
    const el = await mountAt('/tasks')
    expect(layout(el)).toEqual([['tg_def', ['tB', 'ta'], ['t1']]])
  })

  it('the default group without an id: no delete, rename disabled with the hint; the other groups have both', async () => {
    const el = await mountAt('/tasks')
    const fallback = section(el, '')
    expect(fallback.getAttribute('data-default')).toBe('true')
    const rename = must(fallback, 'tasks-group-rename') as HTMLButtonElement
    expect(rename.disabled).toBe(true)
    expect(text(fallback, 'tasks-group-rename-hint')).toBe('首次排序或新建分组后可改名')
    expect(rename.getAttribute('aria-describedby')).toBe(must(fallback, 'tasks-group-rename-hint').id)
    expect(shown(fallback, 'tasks-group-delete')).toBeNull()
    rename.disabled = false
    rename.click()
    await flush()
    expect(shown(el, 'tasks-group-rename-form')).toBeNull()
  })

  it('a landed default group can be renamed and still has no delete', async () => {
    seedGrouped()
    const el = await mountAt('/tasks')
    const fallback = section(el, 'tg_def')
    expect(disabled(must(fallback, 'tasks-group-rename'))).toBe(false)
    expect(shown(fallback, 'tasks-group-rename-hint')).toBeNull()
    expect(shown(fallback, 'tasks-group-delete')).toBeNull()
    must(section(el, 'tg_a'), 'tasks-group-delete')
  })

  it('a placement in a group the board does not have: shown in the default group\'s order, moves off with a notice', async () => {
    seedGrouped()
    userPlacements = [...userPlacements, at('tg_gone', 't3', 0)]
    const el = await mountAt('/tasks')
    // t3 and t5 share position 0: the task id breaks the tie.
    expect(layout(el)[0]).toEqual(['tg_def', ['t3', 't5', 't2', 't6'], []])
    expect(text(el, 'tasks-groups-reorder-off')).toBe('部分任务未显示，排序已停用')
    expect(moveState(el, 't2')).toEqual({ up: false, down: false, join: null, select: false })
    expect(handles(el).every((value) => value === 'false')).toBe(true)
    // Group writes stay usable.
    expect(disabled(must(el, 'tasks-groups-create-input'))).toBe(false)
    // A move control forced back on still sends nothing while the board is not consistent.
    const up = inRow(el, 't2', 'tasks-group-move-up') as HTMLButtonElement
    up.disabled = false
    up.click()
    await flush()
    await pick(el, 't2', 'tg_b')
    expect(writes()).toEqual([])
  })

  it('the notice stays away while a write is out, and comes back after it', async () => {
    seedGrouped()
    userPlacements = [...userPlacements, at('tg_gone', 't3', 0)]
    const answer = deferred<Response>()
    h_.userCreateReply.mockImplementationOnce(() => answer.promise)
    const el = await mountAt('/tasks')
    must(el, 'tasks-groups-reorder-off')
    await createGroup(el, 'Sprint')
    expect(shown(el, 'tasks-groups-reorder-off')).toBeNull()
    answer.resolve(applyCreate(userGroups, 'user', '{"name":"Sprint"}'))
    await flush()
    must(el, 'tasks-groups-reorder-off')
  })

  it('a placement of a task that is not a row (the task list stops at its page): not shown, moves off with a notice', async () => {
    seedGrouped()
    h_.tasksReply.mockImplementation(() => jsonResponse(200, { items: assigned.filter((item) => item.id !== 't1'), total: 6 }))
    const el = await mountAt('/tasks')
    expect(layout(el)[1]).toEqual(['tg_a', ['t4'], []])
    must(el, 'tasks-groups-reorder-off')
    expect(moveState(el, 't4')).toEqual({ up: false, down: false, join: null, select: false })
  })

  it('a placements read cut short: moves off with a notice', async () => {
    seedGrouped()
    h_.userPlacementsReply.mockImplementation((query: string) => {
      const offset = Number(new URLSearchParams(query).get('offset'))
      return jsonResponse(200, { items: offset === 0 ? [at('tg_def', 't5', 0)] : [], total: 9 })
    })
    const el = await mountAt('/tasks')
    must(el, 'tasks-groups-reorder-off')
    expect(moveState(el, 't5').select).toBe(false)
  })

  it('a groups read cut short: moves off with a notice', async () => {
    seedGrouped()
    h_.userGroupsReply.mockImplementation(() => jsonResponse(200, { items: userGroups, total: 4 }))
    const el = await mountAt('/tasks')
    must(el, 'tasks-groups-reorder-off')
    expect(moveState(el, 't2').up).toBe(false)
  })

  it('a consistent board: no notice, moves on', async () => {
    seedGrouped()
    const el = await mountAt('/tasks')
    expect(shown(el, 'tasks-groups-reorder-off')).toBeNull()
    expect(handles(el).every((value) => value === 'true')).toBe(true)
  })
})

describe('/tasks — keyboard moves (design §6.3)', () => {
  beforeEach(() => {
    seedGrouped()
  })

  it('the first placed row has no up, the last no down; the tail rows have "join the order" and no step', async () => {
    const el = await mountAt('/tasks')
    expect(moveState(el, 't5')).toEqual({ up: false, down: true, join: null, select: true })
    expect(moveState(el, 't2')).toEqual({ up: true, down: true, join: null, select: true })
    expect(moveState(el, 't6')).toEqual({ up: true, down: false, join: null, select: true })
    expect(moveState(el, 't3')).toEqual({ up: null, down: null, join: true, select: true })
    expect(moveState(el, 't4')).toEqual({ up: false, down: true, join: null, select: true })
    expect(moveState(el, 't1')).toEqual({ up: true, down: false, join: null, select: true })
    expect(text(rowOf(el, 't3'), 'tasks-group-add-to-order')).toBe('加入排序')
  })

  it('the controls name their task', async () => {
    const el = await mountAt('/tasks')
    expect(inRow(el, 't2', 'tasks-group-move-up').getAttribute('aria-label')).toBe('将「Title-t2」上移一位')
    expect(inRow(el, 't2', 'tasks-group-move-down').getAttribute('aria-label')).toBe('将「Title-t2」下移一位')
    expect(inRow(el, 't2', 'tasks-group-move-to').getAttribute('aria-label')).toBe('将「Title-t2」移到分组')
    expect(inRow(el, 't3', 'tasks-group-add-to-order').getAttribute('aria-label')).toBe('将「Title-t3」加入排序')
    expect(inRow(el, 't2', 'tasks-group-drag-handle').getAttribute('aria-label')).toBe('拖动以排序')
  })

  it('up: one PUT naming the default group null and the index one less; the board shows the server\'s order after', async () => {
    const el = await mountAt('/tasks')
    await clickIn(el, 't2', 'tasks-group-move-up')
    expect(writes()).toEqual(['PUT /api/task-groups/items/t2 {"groupId":null,"position":0}'])
    expect(layout(el)[0]).toEqual(['tg_def', ['t2', 't5', 't6'], ['t3']])
  })

  it('down inside a custom group names that group', async () => {
    const el = await mountAt('/tasks')
    await clickIn(el, 't4', 'tasks-group-move-down')
    expect(writes()).toEqual(['PUT /api/task-groups/items/t4 {"groupId":"tg_a","position":1}'])
    expect(layout(el)[1]).toEqual(['tg_a', ['t1', 't4'], []])
  })

  it('a tail row joins the order at its end', async () => {
    const el = await mountAt('/tasks')
    await clickIn(el, 't3', 'tasks-group-add-to-order')
    expect(writes()).toEqual(['PUT /api/task-groups/items/t3 {"groupId":null,"position":3}'])
    expect(layout(el)[0]).toEqual(['tg_def', ['t5', 't2', 't6', 't3'], []])
  })

  it.each([
    ['t5', 'tg_b', '{"groupId":"tg_b","position":0}', [['tg_def', ['t2', 't6'], ['t3']], ['tg_a', ['t4', 't1'], []], ['tg_b', ['t5'], []]]],
    ['t4', '', '{"groupId":null,"position":3}', [['tg_def', ['t5', 't2', 't6', 't4'], ['t3']], ['tg_a', ['t1'], []], ['tg_b', [], []]]],
    ['t3', 'tg_a', '{"groupId":"tg_a","position":2}', [['tg_def', ['t5', 't2', 't6'], []], ['tg_a', ['t4', 't1', 't3'], []], ['tg_b', [], []]]],
  ] as const)('the group select moves %s to the end of the picked group (%s)', async (taskId, value, body, after) => {
    const el = await mountAt('/tasks')
    expect((inRow(el, taskId, 'tasks-group-move-to') as HTMLSelectElement).value).toBe(taskId === 't3' ? '' : taskId === 't5' ? '' : 'tg_a')
    await pick(el, taskId, value)
    expect(writes()).toEqual([`PUT /api/task-groups/items/${taskId} ${body}`])
    expect(layout(el)).toEqual(after)
  })

  it('the select offers every group by name, in board order', async () => {
    const el = await mountAt('/tasks')
    const options = Array.from((inRow(el, 't2', 'tasks-group-move-to') as HTMLSelectElement).options).map((option) => [option.value, option.textContent])
    expect(options).toEqual([['', '默认分组'], ['tg_a', 'Alpha'], ['tg_b', 'Beta']])
  })

  it.each([
    ['a placed row picking its own group', 't1', 'tg_a'],
    ['a tail row picking the default group', 't3', ''],
  ])('%s sends nothing', async (_label, taskId, value) => {
    const el = await mountAt('/tasks')
    await pick(el, taskId, value)
    expect(writes()).toEqual([])
  })

  it('after a move, focus is on the same control of the same task', async () => {
    const el = await mountAt('/tasks')
    await clickIn(el, 't6', 'tasks-group-move-up')
    expect(document.activeElement).toBe(inRow(el, 't6', 'tasks-group-move-up'))
  })

  it.each([
    ['down to the last place', 't2', 'tasks-group-move-down'],
    ['up to the first place', 't2', 'tasks-group-move-up'],
    ['joining the order', 't3', 'tasks-group-add-to-order'],
  ])('after %s the control is disabled or gone: focus is on the task\'s group select', async (_label, taskId, testid) => {
    const el = await mountAt('/tasks')
    await clickIn(el, taskId, testid)
    expect(document.activeElement).toBe(inRow(el, taskId, 'tasks-group-move-to'))
  })

  it('after a pick, focus is on the task\'s group select in its new group', async () => {
    const el = await mountAt('/tasks')
    await pick(el, 't5', 'tg_b')
    const select = inRow(el, 't5', 'tasks-group-move-to') as HTMLSelectElement
    expect(document.activeElement).toBe(select)
    expect(select.value).toBe('tg_b')
  })

  it('the live region says "saving" while the PUT is out, then the new place; a move to another group names it', async () => {
    const answer = deferred<Response>()
    h_.userPlaceReply.mockImplementationOnce(() => answer.promise)
    const el = await mountAt('/tasks')
    const live = must(el, 'tasks-groups-live')
    expect(live.getAttribute('aria-live')).toBe('polite')
    await clickIn(el, 't6', 'tasks-group-move-up')
    expect(text(el, 'tasks-groups-live')).toBe('正在保存顺序')
    answer.resolve(applyPlace(userGroups, userPlacements, assigned, 't6', '{"groupId":null,"position":1}'))
    await flush()
    expect(text(el, 'tasks-groups-live')).toBe('已移到第 2 位')
    await pick(el, 't5', 'tg_b')
    expect(text(el, 'tasks-groups-live')).toBe('已移到「Beta」第 1 位')
  })

  it('the move shows at once; while its PUT is out every board control is disabled, every handle undraggable, the board busy', async () => {
    const answer = deferred<Response>()
    h_.userPlaceReply.mockImplementationOnce(() => answer.promise)
    const el = await mountAt('/tasks')
    await clickIn(el, 't2', 'tasks-group-move-up')
    expect(layout(el)[0]).toEqual(['tg_def', ['t2', 't5', 't6'], ['t3']])
    expect(boardControlsEnabled(el).every((enabled) => !enabled)).toBe(true)
    expect(handles(el).every((value) => value === 'false')).toBe(true)
    expect(board(el)?.getAttribute('aria-busy')).toBe('true')
    // The reorder notice is not shown just because a write is in flight.
    expect(shown(el, 'tasks-groups-reorder-off')).toBeNull()
    answer.resolve(applyPlace(userGroups, userPlacements, assigned, 't2', '{"groupId":null,"position":0}'))
    await flush()
    expect(board(el)?.getAttribute('aria-busy')).toBe('false')
    expect(moveState(el, 't6')).toEqual({ up: true, down: false, join: null, select: true })
  })

  it('one move at a time: a second move while the first is out sends nothing', async () => {
    const answer = deferred<Response>()
    h_.userPlaceReply.mockImplementationOnce(() => answer.promise)
    const el = await mountAt('/tasks')
    await clickIn(el, 't2', 'tasks-group-move-up')
    const down = inRow(el, 't4', 'tasks-group-move-down') as HTMLButtonElement
    down.disabled = false
    down.click()
    await flush()
    await pick(el, 't1', 'tg_b')
    expect(writes()).toEqual(['PUT /api/task-groups/items/t2 {"groupId":null,"position":0}'])
    // The refused pick does not stay in the select: it still shows the task's group.
    expect((inRow(el, 't1', 'tasks-group-move-to') as HTMLSelectElement).value).toBe('tg_a')
    answer.resolve(applyPlace(userGroups, userPlacements, assigned, 't2', '{"groupId":null,"position":0}'))
    await flush()
  })

  it('two moves in the same tick send one request', async () => {
    const el = await mountAt('/tasks')
    inRow(el, 't2', 'tasks-group-move-up').click()
    inRow(el, 't4', 'tasks-group-move-down').click()
    await flush()
    expect(writes()).toEqual(['PUT /api/task-groups/items/t2 {"groupId":null,"position":0}'])
  })

  it('an ok re-reads the groups and the placements once each, and not the rows', async () => {
    const el = await mountAt('/tasks')
    await clickIn(el, 't2', 'tasks-group-move-up')
    expect(reads(USER_GROUPS)).toBe(2)
    expect(reads(USER_PLACEMENTS)).toBe(2)
    expect(reads(ASSIGNED)).toBe(1)
  })

  it('after an ok the board shows the server\'s order, not its own guess', async () => {
    h_.userPlaceReply.mockImplementationOnce((taskId: string) => jsonResponse(200, { taskId, groupId: 'tg_def', position: 0 }))
    const el = await mountAt('/tasks')
    await clickIn(el, 't2', 'tasks-group-move-up')
    expect(layout(el)).toEqual(GROUPED_LAYOUT)
  })

  it('positions come from the board\'s own order, not from the numbers the server sent', async () => {
    h_.userPlacementsReply.mockImplementation((query: string) =>
      page([at('tg_def', 't5', 0), at('tg_def', 't2', 4), at('tg_def', 't6', 9), at('tg_a', 't4', 2), at('tg_a', 't1', 7)], query),
    )
    const el = await mountAt('/tasks')
    expect(layout(el)[0]).toEqual(['tg_def', ['t5', 't2', 't6'], ['t3']])
    await clickIn(el, 't6', 'tasks-group-move-up')
    expect(writes()).toEqual(['PUT /api/task-groups/items/t6 {"groupId":null,"position":1}'])
  })
})

describe('/tasks — a failed move', () => {
  beforeEach(() => {
    seedGrouped()
  })

  it.each([
    ['INVALID_POSITION', '位置已变化，请刷新后重试'],
    ['INVALID_GROUP', '分组不存在'],
  ])('%s: the order goes back, the banner says why, the groups and the placements are read again', async (code, copy) => {
    h_.userPlaceReply.mockImplementationOnce(() => codeResponse(code))
    const el = await mountAt('/tasks')
    await clickIn(el, 't2', 'tasks-group-move-up')
    expect(layout(el)).toEqual(GROUPED_LAYOUT)
    expect(text(el, 'tasks-groups-banner')).toBe(copy)
    expect(must(el, 'tasks-groups-banner').getAttribute('role')).toBe('alert')
    expect(reads(USER_GROUPS)).toBe(2)
    expect(reads(USER_PLACEMENTS)).toBe(2)
    expect(reads(ASSIGNED)).toBe(1)
    expect(text(el, 'tasks-groups-live')).toBe('')
  })

  it('a 404: the order goes back, the banner says so, and the rows, the groups and the placements are read again — in place', async () => {
    h_.userPlaceReply.mockImplementationOnce(NOT_FOUND)
    const el = await mountAt('/tasks')
    await clickIn(el, 't2', 'tasks-group-move-up')
    expect(layout(el)).toEqual(GROUPED_LAYOUT)
    expect(text(el, 'tasks-groups-banner')).toBe('任务或分组已不可用')
    expect(reads(ASSIGNED)).toBe(2)
    expect(reads(USER_GROUPS)).toBe(2)
    expect(reads(USER_PLACEMENTS)).toBe(2)
    // The rows were read again without the list leaving the screen: the board and its banner stay.
    expect(board(el)).not.toBeNull()
  })

  it.each([
    ['a 403', () => jsonResponse(403, { error: 'Insufficient permissions' }), '您没有权限调整分组'],
    ['a 500', () => jsonResponse(500, {}), '操作失败，请稍后重试'],
    ['a malformed 200', () => jsonResponse(200, { taskId: 't2' }), '操作失败，请稍后重试'],
    ['a code outside the contract', () => codeResponse('SOMETHING_ELSE'), '操作失败，请稍后重试'],
  ] as const)('%s: the order goes back, the banner says why, nothing is read again', async (_label, reply, copy) => {
    h_.userPlaceReply.mockImplementationOnce(reply)
    const el = await mountAt('/tasks')
    await clickIn(el, 't2', 'tasks-group-move-up')
    expect(layout(el)).toEqual(GROUPED_LAYOUT)
    expect(text(el, 'tasks-groups-banner')).toBe(copy)
    expect(reads(USER_GROUPS)).toBe(1)
    expect(reads(USER_PLACEMENTS)).toBe(1)
    expect(reads(ASSIGNED)).toBe(1)
  })

  it('a transport failure reads as a failure', async () => {
    h_.userPlaceReply.mockImplementationOnce(() => Promise.reject(new Error('offline')))
    const el = await mountAt('/tasks')
    await clickIn(el, 't2', 'tasks-group-move-up')
    expect(layout(el)).toEqual(GROUPED_LAYOUT)
    expect(text(el, 'tasks-groups-banner')).toBe('操作失败，请稍后重试')
  })

  it('ORG_MISSING: the page shows the org guidance block', async () => {
    h_.userPlaceReply.mockImplementationOnce(() => codeResponse('ORG_MISSING'))
    const el = await mountAt('/tasks')
    await clickIn(el, 't2', 'tasks-group-move-up')
    must(el, 'tasks-view-org-missing')
    expect(board(el)).toBeNull()
  })

  it('the next write clears the banner', async () => {
    h_.userPlaceReply.mockImplementationOnce(() => codeResponse('INVALID_GROUP'))
    const el = await mountAt('/tasks')
    await clickIn(el, 't2', 'tasks-group-move-up')
    must(el, 'tasks-groups-banner')
    await clickIn(el, 't2', 'tasks-group-move-up')
    expect(shown(el, 'tasks-groups-banner')).toBeNull()
  })
})

describe('/tasks — the personal default group\'s first write', () => {
  it('the first move names the default group null; after it the task is in the default group\'s order and the group can be renamed', async () => {
    const el = await mountAt('/tasks')
    expect(section(el, '').getAttribute('data-default')).toBe('true')
    await clickIn(el, 't2', 'tasks-group-add-to-order')
    expect(writes()).toEqual(['PUT /api/task-groups/items/t2 {"groupId":null,"position":0}'])
    expect(reads(USER_GROUPS)).toBe(2)
    expect(layout(el)).toEqual([[LANDED, ['t2'], ['t1', 't3', 't4']]])
    expect(disabled(must(section(el, LANDED), 'tasks-group-rename'))).toBe(false)
    expect(shown(el, 'tasks-group-rename-hint')).toBeNull()
    expect(shown(el, 'tasks-groups-reorder-off')).toBeNull()
  })

  it('a later move into the landed default group still names it null', async () => {
    const el = await mountAt('/tasks')
    await clickIn(el, 't2', 'tasks-group-add-to-order')
    await clickIn(el, 't3', 'tasks-group-add-to-order')
    expect(writes()).toEqual([
      'PUT /api/task-groups/items/t2 {"groupId":null,"position":0}',
      'PUT /api/task-groups/items/t3 {"groupId":null,"position":1}',
    ])
  })

  it('creating the first group: the default group lands and both show', async () => {
    const el = await mountAt('/tasks')
    await createGroup(el, 'Today')
    expect(sections(el).map((item) => [item.id, item.name])).toEqual([
      [LANDED, '默认分组'],
      ['tg_new1', 'Today'],
    ])
  })
})

describe('/tasks — drag and drop (design §6.2)', () => {
  beforeEach(() => {
    seedGrouped()
  })

  it('before a row: that row\'s index', async () => {
    const el = await mountAt('/tasks')
    await drag(el, 't1', { row: 't4' })
    expect(writes()).toEqual(['PUT /api/task-groups/items/t1 {"groupId":"tg_a","position":0}'])
    expect(layout(el)[1]).toEqual(['tg_a', ['t1', 't4'], []])
  })

  it('on a row\'s lower half: after it', async () => {
    const el = await mountAt('/tasks')
    await drag(el, 't5', { row: 't6', after: true })
    expect(writes()).toEqual(['PUT /api/task-groups/items/t5 {"groupId":null,"position":2}'])
    expect(layout(el)[0]).toEqual(['tg_def', ['t2', 't6', 't5'], ['t3']])
  })

  it('past the task\'s own place, the index counts the rows without the task', async () => {
    const el = await mountAt('/tasks')
    await drag(el, 't5', { row: 't6' })
    expect(writes()).toEqual(['PUT /api/task-groups/items/t5 {"groupId":null,"position":1}'])
    expect(layout(el)[0]).toEqual(['tg_def', ['t2', 't5', 't6'], ['t3']])
  })

  it('across groups, before a row', async () => {
    const el = await mountAt('/tasks')
    await drag(el, 't4', { row: 't2' })
    expect(writes()).toEqual(['PUT /api/task-groups/items/t4 {"groupId":null,"position":1}'])
    expect(layout(el)[0]).toEqual(['tg_def', ['t5', 't4', 't2', 't6'], ['t3']])
  })

  it.each([
    ['an empty group', 't4', 'tg_b', '{"groupId":"tg_b","position":0}'],
    ['a group with rows', 't5', 'tg_a', '{"groupId":"tg_a","position":2}'],
  ])('on %s\'s free space: the end of its order', async (_label, taskId, groupId, body) => {
    const el = await mountAt('/tasks')
    await drag(el, taskId, { group: groupId })
    expect(writes()).toEqual([`PUT /api/task-groups/items/${taskId} ${body}`])
  })

  it('on the unsorted tail: the end of the default group\'s order', async () => {
    const el = await mountAt('/tasks')
    await drag(el, 't4', { row: 't3' })
    expect(writes()).toEqual(['PUT /api/task-groups/items/t4 {"groupId":null,"position":3}'])
    expect(layout(el)[0]).toEqual(['tg_def', ['t5', 't2', 't6', 't4'], ['t3']])
  })

  it.each([
    ['back on its own place', { row: 't6' }],
    ['on itself', { row: 't2' }],
    ['on its own place from below', { row: 't5', after: true }],
  ])('a drop %s sends nothing', async (_label, target) => {
    const el = await mountAt('/tasks')
    await drag(el, 't2', target)
    expect(writes()).toEqual([])
  })

  it('the unsorted tail\'s rows have no handle and nothing in them is draggable', async () => {
    const el = await mountAt('/tasks')
    const tail = must(section(el, 'tg_def'), 'tasks-group-unsorted')
    expect(shown(tail, 'tasks-group-drag-handle')).toBeNull()
    expect(tail.querySelector('[draggable="true"]')).toBeNull()
    expect(handles(el)).toEqual(['true', 'true', 'true', 'true', 'true'])
  })

  it('while a write is out no handle is draggable, a drag does not start, and a drop sends nothing', async () => {
    const answer = deferred<Response>()
    h_.userPlaceReply.mockImplementationOnce(() => answer.promise)
    const el = await mountAt('/tasks')
    await clickIn(el, 't2', 'tasks-group-move-up')
    expect(handles(el).every((value) => value === 'false')).toBe(true)
    const start = dragEvent('dragstart')
    inRow(el, 't4', 'tasks-group-drag-handle').dispatchEvent(start)
    expect(start.defaultPrevented).toBe(true)
    rowOf(el, 't1').dispatchEvent(dragEvent('drop'))
    await flush()
    expect(writes()).toEqual(['PUT /api/task-groups/items/t2 {"groupId":null,"position":0}'])
    answer.resolve(applyPlace(userGroups, userPlacements, assigned, 't2', '{"groupId":null,"position":0}'))
    await flush()
  })

  it('a drop with nothing dragged from the board sends nothing and is left to the browser', async () => {
    const el = await mountAt('/tasks')
    const drop = dragEvent('drop')
    rowOf(el, 't1').dispatchEvent(drop)
    section(el, 'tg_b').dispatchEvent(dragEvent('drop'))
    await flush()
    expect(drop.defaultPrevented).toBe(false)
    expect(writes()).toEqual([])
  })

  it('a dragover while dragging allows the drop; without a drag it does not', async () => {
    const el = await mountAt('/tasks')
    const idle = dragEvent('dragover')
    rowOf(el, 't1').dispatchEvent(idle)
    expect(idle.defaultPrevented).toBe(false)
    inRow(el, 't2', 'tasks-group-drag-handle').dispatchEvent(dragEvent('dragstart'))
    const over = dragEvent('dragover')
    rowOf(el, 't1').dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
    inRow(el, 't2', 'tasks-group-drag-handle').dispatchEvent(dragEvent('dragend'))
    const after = dragEvent('dragover')
    rowOf(el, 't1').dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
  })
})

describe('/tasks — group writes', () => {
  beforeEach(() => {
    seedGrouped()
  })

  it('create: the normalized name; an ok clears the input and re-reads the groups and the placements', async () => {
    const el = await mountAt('/tasks')
    expect(must(el, 'tasks-groups-create-input').getAttribute('placeholder')).toBe('分组名称')
    await createGroup(el, '  Sprint  ')
    expect(writes()).toEqual(['POST /api/task-groups {"name":"Sprint"}'])
    expect((must(el, 'tasks-groups-create-input') as HTMLInputElement).value).toBe('')
    expect(reads(USER_GROUPS)).toBe(2)
    expect(reads(USER_PLACEMENTS)).toBe(2)
    expect(sections(el).map((item) => item.name)).toEqual(['默认分组', 'Alpha', 'Beta', 'Sprint'])
  })

  it.each([
    ['only zero-width characters', '​​', '名称不能为空'],
    ['a U+0000', 'a\u0000b', '名称不能为空'],
    ['101 code points', 'x'.repeat(101), '名称过长'],
  ])('create pre-check, %s: the code next to the form and no request', async (_label, name, copy) => {
    const el = await mountAt('/tasks')
    await createGroup(el, name)
    expect(writes()).toEqual([])
    expect(text(el, 'tasks-groups-create-error')).toBe(copy)
    const input = must(el, 'tasks-groups-create-input')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe('tasks-groups-create-error')
  })

  it('create with 100 code points is sent', async () => {
    const el = await mountAt('/tasks')
    await createGroup(el, 'y'.repeat(100))
    expect(writes()).toEqual([`POST /api/task-groups {"name":"${'y'.repeat(100)}"}`])
  })

  it.each([
    ['INVALID_NAME', '名称不能为空'],
    ['NAME_TOO_LONG', '名称过长'],
    ['LIMIT', '分组数已达上限'],
    ['SOMETHING_ELSE', '操作失败，请稍后重试'],
  ])('create answered %s: the copy next to the form, the input kept, nothing read again', async (code, copy) => {
    h_.userCreateReply.mockImplementationOnce(() => codeResponse(code))
    const el = await mountAt('/tasks')
    await createGroup(el, 'Sprint')
    expect(text(el, 'tasks-groups-create-error')).toBe(copy)
    expect(text(el, 'tasks-groups-create-error')).not.toBe('人数已达上限')
    expect((must(el, 'tasks-groups-create-input') as HTMLInputElement).value).toBe('Sprint')
    expect(shown(el, 'tasks-groups-banner')).toBeNull()
    expect(reads(USER_GROUPS)).toBe(1)
  })

  it('typing again clears the create error', async () => {
    h_.userCreateReply.mockImplementationOnce(() => codeResponse('INVALID_NAME'))
    const el = await mountAt('/tasks')
    await createGroup(el, 'Sprint')
    must(el, 'tasks-groups-create-error')
    await typeInto(must(el, 'tasks-groups-create-input'), 'Sprint 2')
    expect(shown(el, 'tasks-groups-create-error')).toBeNull()
  })

  it.each([
    ['a 403', () => jsonResponse(403, { error: 'Insufficient permissions' }), '您没有权限调整分组', 1],
    ['a 404', NOT_FOUND, '任务或分组已不可用', 2],
    ['a 500', () => jsonResponse(500, {}), '操作失败，请稍后重试', 1],
  ] as const)('create answered %s: the banner; a 404 also reads everything again', async (_label, reply, copy, groupReads) => {
    h_.userCreateReply.mockImplementationOnce(reply)
    const el = await mountAt('/tasks')
    await createGroup(el, 'Sprint')
    expect(text(el, 'tasks-groups-banner')).toBe(copy)
    expect(shown(el, 'tasks-groups-create-error')).toBeNull()
    expect(reads(USER_GROUPS)).toBe(groupReads)
    expect(reads(ASSIGNED)).toBe(groupReads)
  })

  it('create answered ORG_MISSING: the org guidance block', async () => {
    h_.userCreateReply.mockImplementationOnce(() => codeResponse('ORG_MISSING'))
    const el = await mountAt('/tasks')
    await createGroup(el, 'Sprint')
    must(el, 'tasks-view-org-missing')
  })

  it('at 50 groups, the default included: create is disabled with the cap\'s copy, and a dispatched submit sends nothing', async () => {
    userGroups = [userGroup('tg_def', '默认分组', 0, true), ...Array.from({ length: 49 }, (_v, index) => userGroup(`tg_${String(index).padStart(2, '0')}`, `G${index}`, index + 1))]
    userPlacements = []
    const el = await mountAt('/tasks')
    expect(disabled(must(el, 'tasks-groups-create-input'))).toBe(true)
    expect(disabled(must(el, 'tasks-groups-create-submit'))).toBe(true)
    expect(text(el, 'tasks-groups-create-limit')).toBe('分组数已达上限')
    await typeInto(must(el, 'tasks-groups-create-input'), 'One more')
    await submit(must(el, 'tasks-groups-create-form'))
    expect(writes()).toEqual([])
    expect(shown(el, 'tasks-groups-create-error')).toBeNull()
  })

  it('at 49 groups create is open', async () => {
    userGroups = [userGroup('tg_def', '默认分组', 0, true), ...Array.from({ length: 48 }, (_v, index) => userGroup(`tg_${String(index).padStart(2, '0')}`, `G${index}`, index + 1))]
    userPlacements = []
    const el = await mountAt('/tasks')
    expect(disabled(must(el, 'tasks-groups-create-input'))).toBe(false)
    expect(shown(el, 'tasks-groups-create-limit')).toBeNull()
    await createGroup(el, 'Fiftieth')
    expect(writes()).toEqual(['POST /api/task-groups {"name":"Fiftieth"}'])
  })

  it('rename: opens prefilled, cancel sends nothing; save sends the normalized name and re-reads', async () => {
    const el = await mountAt('/tasks')
    const alpha = section(el, 'tg_a')
    expect(must(alpha, 'tasks-group-rename').getAttribute('aria-label')).toBe('重命名分组「Alpha」')
    await click(alpha, 'tasks-group-rename')
    expect((must(el, 'tasks-group-rename-input') as HTMLInputElement).value).toBe('Alpha')
    await click(el, 'tasks-group-rename-cancel')
    expect(shown(el, 'tasks-group-rename-form')).toBeNull()
    expect(writes()).toEqual([])
    await click(section(el, 'tg_a'), 'tasks-group-rename')
    await typeInto(must(el, 'tasks-group-rename-input'), ' Alpha 2 ')
    await submit(must(el, 'tasks-group-rename-form'))
    expect(writes()).toEqual(['PATCH /api/task-groups/tg_a {"name":"Alpha 2"}'])
    expect(shown(el, 'tasks-group-rename-form')).toBeNull()
    expect(sections(el)[1].name).toBe('Alpha 2')
    expect(reads(USER_GROUPS)).toBe(2)
  })

  it('rename to the same name still sends it', async () => {
    const el = await mountAt('/tasks')
    await click(section(el, 'tg_a'), 'tasks-group-rename')
    await submit(must(el, 'tasks-group-rename-form'))
    expect(writes()).toEqual(['PATCH /api/task-groups/tg_a {"name":"Alpha"}'])
  })

  it.each([
    ['the pre-check', () => undefined, '​', '名称不能为空', 0],
    ['INVALID_NAME', () => h_.userRenameReply.mockImplementationOnce(() => codeResponse('INVALID_NAME')), 'Alpha 2', '名称不能为空', 1],
    ['NAME_TOO_LONG', () => h_.userRenameReply.mockImplementationOnce(() => codeResponse('NAME_TOO_LONG')), 'Alpha 2', '名称过长', 1],
  ] as const)('rename refused by %s: the code next to the input, the form stays', async (_label, arrange, name, copy, sent) => {
    arrange()
    const el = await mountAt('/tasks')
    await click(section(el, 'tg_a'), 'tasks-group-rename')
    await typeInto(must(el, 'tasks-group-rename-input'), name)
    await submit(must(el, 'tasks-group-rename-form'))
    expect(writes()).toHaveLength(sent)
    expect(text(el, 'tasks-group-rename-error')).toBe(copy)
    const input = must(el, 'tasks-group-rename-input')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe(must(el, 'tasks-group-rename-error').id)
    expect(shown(el, 'tasks-groups-banner')).toBeNull()
  })

  it('rename answered 404: the banner and everything read again', async () => {
    h_.userRenameReply.mockImplementationOnce(NOT_FOUND)
    const el = await mountAt('/tasks')
    await click(section(el, 'tg_a'), 'tasks-group-rename')
    await submit(must(el, 'tasks-group-rename-form'))
    expect(text(el, 'tasks-groups-banner')).toBe('任务或分组已不可用')
    expect(reads(ASSIGNED)).toBe(2)
    expect(reads(USER_GROUPS)).toBe(2)
  })

  it('delete asks first; cancel sends nothing', async () => {
    const el = await mountAt('/tasks')
    const alpha = section(el, 'tg_a')
    expect(must(alpha, 'tasks-group-delete').getAttribute('aria-label')).toBe('删除分组「Alpha」')
    await click(alpha, 'tasks-group-delete')
    expect(text(alpha, 'tasks-group-delete-confirm')).toContain('确认删除分组「Alpha」？其中的任务将回到默认分组')
    expect(shownAll(el, 'tasks-group-delete-confirm')).toHaveLength(1)
    must(section(el, 'tg_b'), 'tasks-group-delete')
    await click(alpha, 'tasks-group-delete-confirm-cancel')
    expect(shown(el, 'tasks-group-delete-confirm')).toBeNull()
    expect(writes()).toEqual([])
  })

  it('delete: DELETE, then the groups and the placements read again; the group\'s tasks are back in the default group', async () => {
    const el = await mountAt('/tasks')
    await click(section(el, 'tg_a'), 'tasks-group-delete')
    await click(section(el, 'tg_a'), 'tasks-group-delete-confirm-yes')
    expect(writes()).toEqual(['DELETE /api/task-groups/tg_a'])
    expect(reads(USER_GROUPS)).toBe(2)
    expect(reads(USER_PLACEMENTS)).toBe(2)
    expect(layout(el)).toEqual([
      ['tg_def', ['t5', 't2', 't6'], ['t1', 't3', 't4']],
      ['tg_b', [], []],
    ])
  })

  it('delete answered IS_DEFAULT: the copy next to that group\'s controls, not the banner', async () => {
    h_.userDeleteReply.mockImplementationOnce(() => codeResponse('IS_DEFAULT'))
    const el = await mountAt('/tasks')
    await click(section(el, 'tg_a'), 'tasks-group-delete')
    await click(section(el, 'tg_a'), 'tasks-group-delete-confirm-yes')
    expect(text(section(el, 'tg_a'), 'tasks-group-delete-error')).toBe('默认分组不能删除')
    expect(shownAll(el, 'tasks-group-delete-error')).toHaveLength(1)
    expect(shown(el, 'tasks-groups-banner')).toBeNull()
    expect(shown(el, 'tasks-group-delete-confirm')).toBeNull()
  })

  it('the next board write clears a delete error', async () => {
    h_.userDeleteReply.mockImplementationOnce(() => codeResponse('IS_DEFAULT'))
    const el = await mountAt('/tasks')
    await click(section(el, 'tg_a'), 'tasks-group-delete')
    await click(section(el, 'tg_a'), 'tasks-group-delete-confirm-yes')
    must(section(el, 'tg_a'), 'tasks-group-delete-error')
    await clickIn(el, 't2', 'tasks-group-move-up')
    expect(writes()).toEqual(['DELETE /api/task-groups/tg_a', 'PUT /api/task-groups/items/t2 {"groupId":null,"position":0}'])
    expect(shown(el, 'tasks-group-delete-error')).toBeNull()
  })

  it('delete answered 404: the banner and everything read again', async () => {
    h_.userDeleteReply.mockImplementationOnce(NOT_FOUND)
    const el = await mountAt('/tasks')
    await click(section(el, 'tg_a'), 'tasks-group-delete')
    await click(section(el, 'tg_a'), 'tasks-group-delete-confirm-yes')
    expect(text(el, 'tasks-groups-banner')).toBe('任务或分组已不可用')
    expect(reads(ASSIGNED)).toBe(2)
  })

  it('while a group write is out, the moves are disabled too', async () => {
    const answer = deferred<Response>()
    h_.userCreateReply.mockImplementationOnce(() => answer.promise)
    const el = await mountAt('/tasks')
    await createGroup(el, 'Sprint')
    expect(boardControlsEnabled(el).every((enabled) => !enabled)).toBe(true)
    answer.resolve(applyCreate(userGroups, 'user', '{"name":"Sprint"}'))
    await flush()
    expect(moveState(el, 't2').up).toBe(true)
  })
})

// [fe-50]: a group's rename form and its delete confirmation replace the button that opened them,
// and cancel brings it back. Each cell focuses the control it activates (a keyboard user's Enter)
// and checks the exact control focus moved to — on Beta, the last group, so the first group's
// controls of the same kind are never the right answer by accident.
describe('/tasks — focus when a group\'s rename or delete confirmation opens and closes ([fe-50])', () => {
  beforeEach(() => {
    seedGrouped()
  })

  async function press(control: HTMLElement): Promise<void> {
    control.focus()
    control.click()
    await flush()
  }

  it("opening a group's delete confirmation focuses its confirm button, which the prompt describes", async () => {
    const el = await mountAt('/tasks')
    await press(must(section(el, 'tg_b'), 'tasks-group-delete'))
    const yes = must(section(el, 'tg_b'), 'tasks-group-delete-confirm-yes')
    expect(document.activeElement).toBe(yes)
    const prompt = must(section(el, 'tg_b'), 'tasks-group-delete-prompt')
    expect(prompt.textContent?.trim()).toBe('确认删除分组「Beta」？其中的任务将回到默认分组')
    expect(yes.getAttribute('aria-describedby')).toBe(prompt.id)
    expect(document.getElementById(prompt.id)).toBe(prompt)
  })

  it("cancelling it focuses that group's delete button again", async () => {
    const el = await mountAt('/tasks')
    await press(must(section(el, 'tg_b'), 'tasks-group-delete'))
    await press(must(section(el, 'tg_b'), 'tasks-group-delete-confirm-cancel'))
    expect(shown(el, 'tasks-group-delete-confirm')).toBeNull()
    expect(document.activeElement).toBe(must(section(el, 'tg_b'), 'tasks-group-delete'))
    expect(writes()).toEqual([])
  })

  it("opening a group's rename focuses the name input", async () => {
    const el = await mountAt('/tasks')
    await press(must(section(el, 'tg_b'), 'tasks-group-rename'))
    expect(document.activeElement).toBe(must(section(el, 'tg_b'), 'tasks-group-rename-input'))
  })

  it("cancelling a group's rename focuses that group's rename button again", async () => {
    const el = await mountAt('/tasks')
    await press(must(section(el, 'tg_b'), 'tasks-group-rename'))
    await press(must(section(el, 'tg_b'), 'tasks-group-rename-cancel'))
    expect(shown(el, 'tasks-group-rename-form')).toBeNull()
    expect(document.activeElement).toBe(must(section(el, 'tg_b'), 'tasks-group-rename'))
    expect(writes()).toEqual([])
  })
})

describe('/tasks — refresh', () => {
  beforeEach(() => {
    seedGrouped()
  })

  it('reads the rows, the groups and the placements again, holding the controls until they are back', async () => {
    const el = await mountAt('/tasks')
    const placements = deferred<Response>()
    h_.userPlacementsReply.mockImplementationOnce(() => placements.promise)
    userPlacements.splice(0, userPlacements.length, at('tg_def', 't2', 0))
    await click(el, 'tasks-groups-refresh')
    expect(reads(ASSIGNED)).toBe(2)
    expect(reads(USER_GROUPS)).toBe(2)
    expect(reads(USER_PLACEMENTS)).toBe(2)
    expect(boardControlsEnabled(el).every((enabled) => !enabled)).toBe(true)
    placements.resolve(placementsPage(userPlacements, assigned, 'offset=0'))
    await flush()
    expect(layout(el)[0]).toEqual(['tg_def', ['t2'], ['t1', 't3', 't4', 't5', 't6']])
    expect(disabled(must(el, 'tasks-groups-refresh'))).toBe(false)
    expect(writes()).toEqual([])
  })
})

describe('/tasks — a refresh whose row read reports no org', () => {
  it('shows the org guidance block', async () => {
    seedGrouped()
    let assignedReads = 0
    h_.tasksReply.mockImplementation(() => {
      assignedReads += 1
      return assignedReads === 2
        ? jsonResponse(200, { items: [], degraded: true, reason: 'org_missing' })
        : jsonResponse(200, { items: assigned, total: assigned.length })
    })
    const el = await mountAt('/tasks')
    await click(el, 'tasks-groups-refresh')
    expect(assignedReads).toBe(2)
    expect(text(el, 'tasks-view-org-missing')).toBe('请先选择一个组织后再查看任务')
    expect(shown(el, 'tasks-list-error')).toBeNull()
  })
})

describe('/tasks — the row actions stay the page\'s', () => {
  it('complete on a board row: the page\'s complete, then the list and its groups are read again', async () => {
    seedGrouped()
    const el = await mountAt('/tasks')
    await clickIn(el, 't2', 'tasks-complete-button')
    expect(writes()).toEqual(['POST /api/tasks/t2/complete'])
    expect(h_.notifyTasksChanged).toHaveBeenCalledTimes(1)
    expect(reads(ASSIGNED)).toBe(2)
    expect(reads(USER_GROUPS)).toBe(2)
    expect(layout(el)).toEqual(GROUPED_LAYOUT)
  })
})

describe('/tasks — answers that land after the board left', () => {
  beforeEach(() => {
    seedGrouped()
  })

  it('a move answered after the view changed reads nothing; back on the assigned view a fresh board is usable', async () => {
    const answer = deferred<Response>()
    h_.userPlaceReply.mockImplementationOnce(() => answer.promise)
    const el = await mountAt('/tasks')
    await clickIn(el, 't2', 'tasks-group-move-up')
    await click(el, 'tasks-view-switch-following')
    const before = calls().length
    answer.resolve(applyPlace(userGroups, userPlacements, assigned, 't2', '{"groupId":null,"position":0}'))
    await flush()
    expect(calls().slice(before)).toEqual([])
    await click(el, 'tasks-view-switch-assigned')
    expect(reads(USER_GROUPS)).toBe(2)
    expect(moveState(el, 't6').up).toBe(true)
    expect(shown(el, 'tasks-groups-banner')).toBeNull()
  })

  it('a move answered after leaving to a task page reads nothing at all', async () => {
    const answer = deferred<Response>()
    h_.userPlaceReply.mockImplementationOnce(() => answer.promise)
    const el = await mountAt('/tasks')
    await clickIn(el, 't2', 'tasks-group-move-up')
    await go('/tasks/t1')
    const before = calls().length
    answer.resolve(NOT_FOUND())
    await flush()
    expect(calls().slice(before)).toEqual([])
  })

  it('a create answered after the view changed reads nothing', async () => {
    const answer = deferred<Response>()
    h_.userCreateReply.mockImplementationOnce(() => answer.promise)
    const el = await mountAt('/tasks')
    await createGroup(el, 'Sprint')
    await click(el, 'tasks-view-switch-following')
    const before = calls().length
    answer.resolve(applyCreate(userGroups, 'user', '{"name":"Sprint"}'))
    await flush()
    expect(calls().slice(before)).toEqual([])
  })

  it('a rename answered after the view changed reads nothing', async () => {
    const answer = deferred<Response>()
    h_.userRenameReply.mockImplementationOnce(() => answer.promise)
    const el = await mountAt('/tasks')
    await click(section(el, 'tg_a'), 'tasks-group-rename')
    await typeInto(must(el, 'tasks-group-rename-input'), 'Alpha 2')
    await submit(must(el, 'tasks-group-rename-form'))
    await click(el, 'tasks-view-switch-following')
    const before = calls().length
    answer.resolve(applyRename(userGroups, 'tg_a', '{"name":"Alpha 2"}'))
    await flush()
    expect(calls().slice(before)).toEqual([])
  })

  it('a delete answered after the view changed reads nothing', async () => {
    const answer = deferred<Response>()
    h_.userDeleteReply.mockImplementationOnce(() => answer.promise)
    const el = await mountAt('/tasks')
    await click(section(el, 'tg_a'), 'tasks-group-delete')
    await click(section(el, 'tg_a'), 'tasks-group-delete-confirm-yes')
    await click(el, 'tasks-view-switch-following')
    const before = calls().length
    answer.resolve(applyDelete(userGroups, userPlacements, 'tg_a'))
    await flush()
    expect(calls().slice(before)).toEqual([])
  })

  it("a refresh whose row read lands after the view changed does not paint the assigned rows under the new view", async () => {
    const late = deferred<Response>()
    let assignedReads = 0
    h_.tasksReply.mockImplementation((view: string) => {
      if (view === 'assigned') {
        assignedReads += 1
        return assignedReads === 2 ? late.promise : jsonResponse(200, { items: assigned, total: assigned.length })
      }
      return jsonResponse(200, { items: [row('t9', { title: 'Following Nine' })], total: 1 })
    })
    const el = await mountAt('/tasks')
    await click(el, 'tasks-groups-refresh')
    expect(assignedReads).toBe(2)
    await click(el, 'tasks-view-switch-following')
    const titles = (): Array<string | undefined> => shownAll(el, 'tasks-list-item-link').map((link) => link.textContent?.trim())
    expect(titles()).toEqual(['Following Nine'])
    late.resolve(jsonResponse(200, { items: assigned, total: assigned.length }))
    await flush()
    expect(titles()).toEqual(['Following Nine'])
  })
})

// ---------------------------------------------------------------------------------------------
// /task-lists/:id — the list scope
// ---------------------------------------------------------------------------------------------

/** Which of the page's own write controls are usable. */
function pageControls(el: HTMLElement): Record<string, boolean> {
  const usable = (testid: string): boolean => !disabled(must(el, testid))
  return {
    rename: usable('tasks-list-detail-rename'),
    archive: usable('tasks-list-detail-archive'),
    addTask: usable('tasks-list-detail-add-task-input'),
    removeTask: shownAll(el, 'tasks-list-detail-item-remove').every((button) => !disabled(button)),
    members: usable('tasks-list-detail-members'),
  }
}

describe('/task-lists/:id — the reads', () => {
  it('the list, its items, its groups and its placements are all out before any answers', async () => {
    const list = deferred<Response>()
    const rows = deferred<Response>()
    const groups = deferred<Response>()
    const placements = deferred<Response>()
    h_.listReply.mockImplementation(() => list.promise)
    h_.itemsReply.mockImplementation(() => rows.promise)
    h_.listGroupsReply.mockImplementation(() => groups.promise)
    h_.listPlacementsReply.mockImplementation(() => placements.promise)
    const el = await mountAt('/task-lists/tl_1')
    expect(reads(listPath('tl_1', ''))).toBe(1)
    expect(reads(listItemsRead())).toBe(1)
    expect(reads(listGroupsRead())).toBe(1)
    expect(reads(listPlacementsRead())).toBe(1)
    list.resolve(jsonResponse(200, lists.tl_1))
    rows.resolve(page(listRows.tl_1, 'offset=0'))
    await flush()
    // The items show flat until the group reads are in.
    expect(rowOrder(el, 'tasks-list-detail-item')).toEqual(['t1', 't2', 't3'])
    must(el, 'tasks-list-detail-items')
    expect(board(el)).toBeNull()
    groups.resolve(page(listGroups.tl_1, 'offset=0'))
    placements.resolve(placementsPage(listPlacements.tl_1, listRows.tl_1, 'offset=0'))
    await flush()
    expect(board(el)?.getAttribute('data-scope')).toBe('list')
  })

  it('the board: the list\'s rows under their own ids, each row\'s content the page\'s', async () => {
    const el = await mountAt('/task-lists/tl_1')
    expect(layout(el)).toEqual([
      ['tg_l1', [], ['t1', 't2']],
      ['tg_x', ['t3'], []],
    ])
    expect(shown(el, 'tasks-list-detail-items')).toBeNull()
    expect(rowOrder(el, 'tasks-list-detail-item')).toEqual(['t1', 't2', 't3'])
    expect(shownAll(el, 'tasks-list-item')).toEqual([])
    expect(shownAll(el, 'tasks-list-detail-item-link').map((link) => link.getAttribute('href'))).toEqual(['/tasks/t1', '/tasks/t2', '/tasks/t3'])
    expect(shownAll(el, 'tasks-list-detail-item-status').map((node) => node.textContent?.trim())).toEqual(['进行中', '已完成', '进行中'])
    expect(shownAll(el, 'tasks-list-detail-item-due')).toHaveLength(1)
    expect(shownAll(el, 'tasks-list-detail-item-remove')).toHaveLength(3)
  })

  it.each([
    ['the groups read fails', () => h_.listGroupsReply.mockImplementation(() => jsonResponse(500, {}))],
    ['the groups read is a 404', () => h_.listGroupsReply.mockImplementation(NOT_FOUND)],
    ['the placements read fails', () => h_.listPlacementsReply.mockImplementation(() => jsonResponse(500, {}))],
    ['the groups have no default group', () => {
      listGroups.tl_1 = [listGroup('tg_x', 'Doing', 1)]
    }],
  ] as const)('%s: the items flat with the notice; the page and its controls stay', async (_label, arrange) => {
    arrange()
    const el = await mountAt('/task-lists/tl_1')
    expect(text(el, 'tasks-groups-unavailable')).toBe('分组不可用')
    must(el, 'tasks-list-detail-items')
    expect(rowOrder(el, 'tasks-list-detail-item')).toEqual(['t1', 't2', 't3'])
    expect(board(el)).toBeNull()
    expect(pageControls(el)).toEqual({ rename: true, archive: true, addTask: true, removeTask: true, members: true })
  })

  it('a groups read that reports no org: the org guidance block', async () => {
    h_.listGroupsReply.mockImplementation(() => jsonResponse(200, { items: [], degraded: true, reason: 'org_missing' }))
    const el = await mountAt('/task-lists/tl_1')
    must(el, 'tasks-view-org-missing')
  })

  it('a placements read that reports no org: the org guidance block', async () => {
    h_.listPlacementsReply.mockImplementation(() => jsonResponse(200, { items: [], degraded: true, reason: 'org_missing' }))
    const el = await mountAt('/task-lists/tl_1')
    must(el, 'tasks-view-org-missing')
  })

  it('an empty list still shows its groups, under the empty-state copy', async () => {
    listRows.tl_1 = []
    listPlacements.tl_1 = []
    const el = await mountAt('/task-lists/tl_1')
    expect(text(el, 'tasks-list-detail-items-empty')).toBe('清单中还没有任务')
    expect(layout(el)).toEqual([
      ['tg_l1', [], []],
      ['tg_x', [], []],
    ])
    must(el, 'tasks-groups-create-form')
  })

  it.each([
    ['the items read', () => h_.itemsReply.mockImplementation((_id: string, query: string) => {
      const offset = Number(new URLSearchParams(query).get('offset'))
      return jsonResponse(200, { items: offset === 0 ? listRows.tl_1 : [], total: 9 })
    })],
    ['the placements read', () => h_.listPlacementsReply.mockImplementation((_id: string, query: string) => {
      const offset = Number(new URLSearchParams(query).get('offset'))
      return jsonResponse(200, { items: offset === 0 ? [at('tg_x', 't3', 0)] : [], total: 9 })
    })],
    ['the groups read', () => h_.listGroupsReply.mockImplementation(() => jsonResponse(200, { items: listGroups.tl_1, total: 3 }))],
  ] as const)('%s cut short: the board shows, the moves are off with the notice, the group forms stay', async (_label, arrange) => {
    arrange()
    const el = await mountAt('/task-lists/tl_1')
    expect(text(el, 'tasks-groups-reorder-off')).toBe('部分任务未显示，排序已停用')
    expect(moveState(el, 't3')).toEqual({ up: false, down: false, join: null, select: false })
    expect(moveState(el, 't1').join).toBe(false)
    expect(handles(el).every((value) => value === 'false')).toBe(true)
    expect(disabled(must(el, 'tasks-groups-create-input'))).toBe(false)
  })
})

describe('/task-lists/:id — who may change the groups', () => {
  it.each(['owner', 'edit'] as const)('%s: moves, handles and the group forms', async (role) => {
    lists.tl_1 = listBody('tl_1', { myRole: role, ownerId: role === 'owner' ? 'u1' : 'u9' })
    const el = await mountAt('/task-lists/tl_1')
    expect(moveState(el, 't3')).toEqual({ up: false, down: false, join: null, select: true })
    expect(moveState(el, 't1').join).toBe(true)
    expect(handles(el)).toEqual(['true'])
    must(el, 'tasks-groups-create-form')
    must(section(el, 'tg_x'), 'tasks-group-rename')
    must(section(el, 'tg_x'), 'tasks-group-delete')
  })

  it('read: the order only — no move control, no handle, no group form, no notice; refresh stays', async () => {
    lists.tl_1 = listBody('tl_1', { myRole: 'read', createdBy: 'u9', ownerId: 'u9' })
    const el = await mountAt('/task-lists/tl_1')
    expect(layout(el)).toEqual([
      ['tg_l1', [], ['t1', 't2']],
      ['tg_x', ['t3'], []],
    ])
    for (const testid of [
      'tasks-group-move-up',
      'tasks-group-move-down',
      'tasks-group-add-to-order',
      'tasks-group-move-to',
      'tasks-group-drag-handle',
      'tasks-groups-create-form',
      'tasks-group-rename',
      'tasks-group-delete',
      'tasks-groups-reorder-off',
    ]) {
      expect(shown(el, testid), testid).toBeNull()
    }
    must(el, 'tasks-groups-refresh')
  })
})

describe('/task-lists/:id — moves and group writes', () => {
  it('the list\'s default group has an id and is still sent as null', async () => {
    const el = await mountAt('/task-lists/tl_1')
    await clickIn(el, 't2', 'tasks-group-add-to-order')
    expect(writes()).toEqual(['PUT /api/task-lists/tl_1/group-items/t2 {"groupId":null,"position":0}'])
    expect(layout(el)[0]).toEqual(['tg_l1', ['t2'], ['t1']])
    expect(reads(listGroupsRead())).toBe(2)
    expect(reads(listPlacementsRead())).toBe(2)
    expect(reads(listItemsRead())).toBe(1)
    expect(reads(listPath('tl_1', ''))).toBe(1)
  })

  it('to a custom group by the select, and by a drag', async () => {
    const el = await mountAt('/task-lists/tl_1')
    await pick(el, 't1', 'tg_x')
    await clickIn(el, 't2', 'tasks-group-add-to-order')
    await drag(el, 't2', { row: 't3' })
    expect(writes()).toEqual([
      'PUT /api/task-lists/tl_1/group-items/t1 {"groupId":"tg_x","position":1}',
      'PUT /api/task-lists/tl_1/group-items/t2 {"groupId":null,"position":0}',
      'PUT /api/task-lists/tl_1/group-items/t2 {"groupId":"tg_x","position":0}',
    ])
    expect(layout(el)).toEqual([
      ['tg_l1', [], []],
      ['tg_x', ['t2', 't3', 't1'], []],
    ])
  })

  it('create, rename and delete go to the list\'s group paths', async () => {
    const el = await mountAt('/task-lists/tl_1')
    await createGroup(el, 'Done')
    await click(section(el, 'tg_x'), 'tasks-group-rename')
    await typeInto(must(el, 'tasks-group-rename-input'), 'Doing now')
    await submit(must(el, 'tasks-group-rename-form'))
    await click(section(el, 'tg_new1'), 'tasks-group-delete')
    await click(section(el, 'tg_new1'), 'tasks-group-delete-confirm-yes')
    expect(writes()).toEqual([
      'POST /api/task-lists/tl_1/groups {"name":"Done"}',
      'PATCH /api/task-lists/tl_1/groups/tg_x {"name":"Doing now"}',
      'DELETE /api/task-lists/tl_1/groups/tg_new1',
    ])
    expect(sections(el).map((item) => item.name)).toEqual(['默认分组', 'Doing now'])
  })

  it('a 404 on a move: the board\'s banner; the list, the items, the groups and the placements read again; the page stays', async () => {
    h_.listPlaceReply.mockImplementationOnce(NOT_FOUND)
    const el = await mountAt('/task-lists/tl_1')
    await clickIn(el, 't2', 'tasks-group-add-to-order')
    expect(text(el, 'tasks-groups-banner')).toBe('任务或分组已不可用')
    expect(reads(listPath('tl_1', ''))).toBe(2)
    expect(reads(listItemsRead())).toBe(2)
    expect(reads(listGroupsRead())).toBe(2)
    expect(reads(listPlacementsRead())).toBe(2)
    expect(shown(el, 'tasks-list-detail-banner')).toBeNull()
    must(el, 'tasks-list-detail')
  })

  it('a 404 on a move after the viewer lost the list: the page turns to not_found', async () => {
    h_.listPlaceReply.mockImplementationOnce(() => {
      delete lists.tl_1
      return NOT_FOUND()
    })
    const el = await mountAt('/task-lists/tl_1')
    await clickIn(el, 't2', 'tasks-group-add-to-order')
    expect(text(el, 'tasks-list-detail-not-found')).toBe('清单不存在或你不是成员')
    expect(board(el)).toBeNull()
  })

  it('a 404 on a move that finds the viewer now only reads the list: the move controls go away', async () => {
    h_.listPlaceReply.mockImplementationOnce(() => {
      lists.tl_1 = listBody('tl_1', { name: 'Groceries', myRole: 'read', createdBy: 'u9', ownerId: 'u9' })
      return NOT_FOUND()
    })
    const el = await mountAt('/task-lists/tl_1')
    await clickIn(el, 't2', 'tasks-group-add-to-order')
    expect(text(el, 'tasks-groups-banner')).toBe('任务或分组已不可用')
    expect(shown(el, 'tasks-group-move-to')).toBeNull()
    expect(shown(el, 'tasks-groups-create-form')).toBeNull()
    expect(text(el, 'tasks-list-detail-role')).toBe('我的角色：只读')
  })

  it('refresh reads the list, the items, the groups and the placements again', async () => {
    const el = await mountAt('/task-lists/tl_1')
    lists.tl_1 = { ...lists.tl_1, name: 'Groceries 2' }
    await click(el, 'tasks-groups-refresh')
    expect(reads(listPath('tl_1', ''))).toBe(2)
    expect(reads(listItemsRead())).toBe(2)
    expect(reads(listGroupsRead())).toBe(2)
    expect(reads(listPlacementsRead())).toBe(2)
    expect(text(el, 'tasks-list-detail-title')).toBe('Groceries 2')
  })

  it('a refresh whose items read fails takes the board away and hands the page its controls back', async () => {
    const el = await mountAt('/task-lists/tl_1')
    const rows = deferred<Response>()
    h_.itemsReply.mockImplementationOnce(() => rows.promise)
    await click(el, 'tasks-groups-refresh')
    expect(disabled(must(el, 'tasks-list-detail-rename'))).toBe(true)
    rows.resolve(jsonResponse(500, {}))
    await flush()
    must(el, 'tasks-list-detail-items-unavailable')
    expect(board(el)).toBeNull()
    expect(disabled(must(el, 'tasks-list-detail-rename'))).toBe(false)
    expect(must(el, 'tasks-list-detail').getAttribute('aria-busy')).toBe('false')
  })
})

describe('/task-lists/:id — one write at a time with the page', () => {
  it('a board write disables the page\'s write controls; the members button stays', async () => {
    const answer = deferred<Response>()
    h_.listPlaceReply.mockImplementationOnce(() => answer.promise)
    const el = await mountAt('/task-lists/tl_1')
    await clickIn(el, 't2', 'tasks-group-add-to-order')
    expect(pageControls(el)).toEqual({ rename: false, archive: false, addTask: false, removeTask: false, members: true })
    expect(must(el, 'tasks-list-detail').getAttribute('aria-busy')).toBe('true')
    answer.resolve(applyPlace(listGroups.tl_1, listPlacements.tl_1, listRows.tl_1, 't2', '{"groupId":null,"position":0}'))
    await flush()
    expect(pageControls(el)).toEqual({ rename: true, archive: true, addTask: true, removeTask: true, members: true })
  })

  it('a page write disables the board: no move, no handle, no group form; a dispatched move sends nothing', async () => {
    const answer = deferred<Response>()
    h_.listRenameReply.mockImplementationOnce(() => answer.promise)
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-rename')
    await submit(must(el, 'tasks-list-detail-rename-form'))
    expect(boardControlsEnabled(el).every((enabled) => !enabled)).toBe(true)
    expect(handles(el).every((value) => value === 'false')).toBe(true)
    const join = inRow(el, 't2', 'tasks-group-add-to-order') as HTMLButtonElement
    join.disabled = false
    join.click()
    await flush()
    expect(writes()).toEqual(['PATCH /api/task-lists/tl_1 {"name":"Groceries"}'])
    answer.resolve(jsonResponse(200, lists.tl_1))
    await flush()
    expect(moveState(el, 't2').join).toBe(true)
  })

  it('adding a task re-reads the items and the placements, not the groups', async () => {
    const el = await mountAt('/task-lists/tl_1')
    await typeInto(must(el, 'tasks-list-detail-add-task-input'), 't9')
    await submit(must(el, 'tasks-list-detail-add-task-form'))
    expect(reads(listItemsRead())).toBe(2)
    expect(reads(listPlacementsRead())).toBe(2)
    expect(reads(listGroupsRead())).toBe(1)
    expect(layout(el)[0]).toEqual(['tg_l1', [], ['t1', 't2', 't9']])
  })

  it('removing a task re-reads the items and the placements, not the groups; its placement goes with it', async () => {
    const el = await mountAt('/task-lists/tl_1')
    await clickIn(el, 't3', 'tasks-list-detail-item-remove')
    await clickIn(el, 't3', 'tasks-list-detail-item-remove-confirm-yes')
    expect(writes()).toEqual(['DELETE /api/task-lists/tl_1/items/t3'])
    expect(reads(listItemsRead())).toBe(2)
    expect(reads(listPlacementsRead())).toBe(2)
    expect(reads(listGroupsRead())).toBe(1)
    expect(layout(el)).toEqual([
      ['tg_l1', [], ['t1', 't2']],
      ['tg_x', [], []],
    ])
    expect(shown(el, 'tasks-groups-reorder-off')).toBeNull()
  })

  it('a board write that reports no org: the page\'s guidance block', async () => {
    h_.listPlaceReply.mockImplementationOnce(() => codeResponse('ORG_MISSING'))
    const el = await mountAt('/task-lists/tl_1')
    await clickIn(el, 't2', 'tasks-group-add-to-order')
    must(el, 'tasks-view-org-missing')
  })
})

describe('/task-lists/:id — answers that land after the page moved on', () => {
  it('a move answered after switching lists reads nothing for either list; the new list\'s board is usable', async () => {
    const answer = deferred<Response>()
    h_.listPlaceReply.mockImplementationOnce(() => answer.promise)
    const el = await mountAt('/task-lists/tl_1')
    await clickIn(el, 't2', 'tasks-group-add-to-order')
    await go('/task-lists/tl_2')
    expect(reads(listGroupsRead('tl_2'))).toBe(1)
    const before = calls().length
    answer.resolve(applyPlace(listGroups.tl_1, listPlacements.tl_1, listRows.tl_1, 't2', '{"groupId":null,"position":0}'))
    await flush()
    expect(calls().slice(before)).toEqual([])
    expect(reads(listGroupsRead('tl_2'))).toBe(1)
    expect(reads(listGroupsRead('tl_1'))).toBe(1)
    expect(layout(el)).toEqual([['tg_l2', [], ['t7']]])
    expect(moveState(el, 't7').join).toBe(true)
    expect(disabled(must(el, 'tasks-list-detail-rename'))).toBe(false)
  })

  it('a move answered after leaving to a task page reads nothing at all — not under that page\'s id either', async () => {
    const answer = deferred<Response>()
    h_.listPlaceReply.mockImplementationOnce(() => answer.promise)
    const el = await mountAt('/task-lists/tl_1')
    await clickIn(el, 't2', 'tasks-group-add-to-order')
    await go('/tasks/t1')
    const before = calls().length
    answer.resolve(NOT_FOUND())
    await flush()
    expect(calls().slice(before)).toEqual([])
    expect(reads(listGroupsRead('t1'))).toBe(0)
    expect(reads(listItemsRead('t1'))).toBe(0)
  })

  it('a group rename answered after leaving to a task page reads nothing at all — not under that page\'s id either', async () => {
    const answer = deferred<Response>()
    h_.listGroupRenameReply.mockImplementationOnce(() => answer.promise)
    const el = await mountAt('/task-lists/tl_1')
    await click(section(el, 'tg_x'), 'tasks-group-rename')
    await typeInto(must(el, 'tasks-group-rename-input'), 'Doing now')
    await submit(must(el, 'tasks-group-rename-form'))
    await go('/tasks/t1')
    const before = calls().length
    answer.resolve(applyRename(listGroups.tl_1, 'tg_x', '{"name":"Doing now"}'))
    await flush()
    expect(calls().slice(before)).toEqual([])
  })

  it('a group delete answered after leaving to a task page reads nothing at all — not under that page\'s id either', async () => {
    const answer = deferred<Response>()
    h_.listGroupDeleteReply.mockImplementationOnce(() => answer.promise)
    const el = await mountAt('/task-lists/tl_1')
    await click(section(el, 'tg_x'), 'tasks-group-delete')
    await click(section(el, 'tg_x'), 'tasks-group-delete-confirm-yes')
    await go('/tasks/t1')
    const before = calls().length
    answer.resolve(applyDelete(listGroups.tl_1, listPlacements.tl_1, 'tg_x'))
    await flush()
    expect(calls().slice(before)).toEqual([])
  })

  it('a group read of the old list answered after switching lists does not paint the new one', async () => {
    const oldGroups = deferred<Response>()
    h_.listGroupsReply.mockImplementationOnce(() => oldGroups.promise)
    const el = await mountAt('/task-lists/tl_1')
    await go('/task-lists/tl_2')
    oldGroups.resolve(page([listGroup('tg_old', 'Stale', 0, true)], 'offset=0'))
    await flush()
    expect(layout(el)).toEqual([['tg_l2', [], ['t7']]])
  })

  it('a placements read of the old list answered after switching lists does not paint the new one', async () => {
    const oldPlacements = deferred<Response>()
    h_.listPlacementsReply.mockImplementationOnce(() => oldPlacements.promise)
    const el = await mountAt('/task-lists/tl_1')
    await go('/task-lists/tl_2')
    oldPlacements.resolve(page([at('tg_l2', 't7', 0)], 'offset=0'))
    await flush()
    expect(layout(el)).toEqual([['tg_l2', [], ['t7']]])
  })
})
