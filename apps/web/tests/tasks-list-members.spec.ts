import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'

/**
 * M4 FE-6 — the members dialog of the list page (TaskListMembersDialog.vue mounted by
 * TaskListView.vue; docs/development/task-m4-frontend-design-20261007.md §4.0, §5.1–§5.3, §10.1).
 *
 * Backend: the member routes (`GET` / `POST /api/task-lists/:id/members`, `PATCH` / `DELETE
 * …/members/:userId`, `POST …/transfer-owner`) are PR-3a S6 — built on the PR-3a branch, not on
 * main. These cells are coded to that contract and mock the transport.
 *
 * Mock face: `apiFetch` plays the backend by path over a small in-memory state (a member write
 * changes the roster the next read returns; a transfer also changes the list's `ownerId` and the
 * viewer's `myRole`), so the REAL tasksApi client builds every request and parses every answer —
 * request bodies are asserted as the client serialized them. Also mocked: `loadTasksContext`,
 * `notifyTasksChanged` (the badge bus, which no member write may touch), `useAuth` (the viewer's
 * own id) and `useLocale` (ZH). The lists bus is the real module; cells subscribe a spy to it. The
 * router is real: `/task-lists/:id` on TaskListView (the instance is reused across ids), `/tasks`
 * and `/tasks/:id` on a stand-in page.
 */

const h_ = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  loadTasksContext: vi.fn(),
  notifyTasksChanged: vi.fn(),
  getCurrentUserId: vi.fn(),
  /** `GET /api/task-lists/:id` (decoded id). */
  listReply: vi.fn(),
  /** `POST /api/task-lists/:id/archive` (id). */
  archiveReply: vi.fn(),
  /** `GET /api/task-lists/:id/members?…` (id, query). */
  membersReply: vi.fn(),
  /** `POST /api/task-lists/:id/members` (id, serialized body). */
  addMemberReply: vi.fn(),
  /** `PATCH /api/task-lists/:id/members/:userId` (id, user id, serialized body). */
  roleReply: vi.fn(),
  /** `DELETE /api/task-lists/:id/members/:userId` (id, user id). */
  removeMemberReply: vi.fn(),
  /** `POST /api/task-lists/:id/transfer-owner` (id, serialized body). */
  transferReply: vi.fn(),
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

// ---------------------------------------------------------------------------------------------
// Fixtures and the fake backend
// ---------------------------------------------------------------------------------------------

type Role = 'read' | 'edit' | 'owner'
type Member = { userId: string; role: Role; createdAt: string }

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

function member(userId: string, role: Role): Member {
  return { userId, role, createdAt: '2031-01-01T00:00:00.000Z' }
}

/** What the fake backend holds; writes change it, so a re-read shows the write. */
let lists: Record<string, Record<string, unknown>> = {}
let rosters: Record<string, Member[]> = {}

function jsonResponse(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response
}

const NOT_FOUND = () => jsonResponse(404, { error: { code: 'NOT_FOUND' } })
const code422 = (code: string) => jsonResponse(422, { error: { code } })

function page(all: unknown[], query: string): Response {
  const offset = Number(new URLSearchParams(query).get('offset'))
  return jsonResponse(200, { items: all.slice(offset, offset + 100), total: all.length })
}

/** A member write's 200 body: the list id and the whole roster, `userId` byte order. */
function rosterBody(id: string): Record<string, unknown> {
  const members = [...(rosters[id] ?? [])].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
  rosters[id] = members
  return { id, members: members.map(({ userId, role }) => ({ userId, role })) }
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
  if (method === 'GET' && (match = /^\/api\/task-lists\/([^/]+)$/.exec(pathname))) return h_.listReply(decodeURIComponent(match[1]))
  if (method === 'POST' && (match = /^\/api\/task-lists\/([^/]+)\/archive$/.exec(pathname))) return h_.archiveReply(decodeURIComponent(match[1]))
  if (method === 'GET' && /^\/api\/task-lists\/[^/]+\/items$/.test(pathname)) {
    return page([{ id: 't1', title: 'Task One', status: 'open', completion_mode: 'all', created_by: 'u1', due_at: null }], query)
  }
  if (method === 'GET' && /^\/api\/task-lists\/[^/]+\/events$/.test(pathname)) return page([], query)
  // M4 FE-7: the grouping board's two reads — no custom groups, no placements (tasks-groups.spec.ts
  // covers the board).
  if (method === 'GET' && (match = /^\/api\/task-lists\/([^/]+)\/groups$/.exec(pathname))) {
    return page([{ id: `tg_${decodeURIComponent(match[1])}`, scope: 'list', name: '默认分组', position: 0, isDefault: true }], query)
  }
  if (method === 'GET' && /^\/api\/task-lists\/[^/]+\/group-items$/.test(pathname)) return page([], query)
  if ((match = /^\/api\/task-lists\/([^/]+)\/members$/.exec(pathname))) {
    const id = decodeURIComponent(match[1])
    if (method === 'GET') return h_.membersReply(id, query)
    if (method === 'POST') return h_.addMemberReply(id, init?.body)
  }
  if ((match = /^\/api\/task-lists\/([^/]+)\/members\/([^/]+)$/.exec(pathname))) {
    const id = decodeURIComponent(match[1])
    const userId = decodeURIComponent(match[2])
    if (method === 'PATCH') return h_.roleReply(id, userId, init?.body)
    if (method === 'DELETE') return h_.removeMemberReply(id, userId)
  }
  if (method === 'POST' && (match = /^\/api\/task-lists\/([^/]+)\/transfer-owner$/.exec(pathname))) {
    return h_.transferReply(decodeURIComponent(match[1]), init?.body)
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

function memberReads(id = 'tl_1'): number {
  return fetchCalls().filter(([p, init]) => p.startsWith(`/api/task-lists/${id}/members?`) && (init?.method ?? 'GET') === 'GET').length
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

// Enough turns for the longest chain here — a leave's answer, the bus, the page's navigation —
// so a cell that asserts nothing happened has waited as long as one that asserts it did.
async function flush(cycles = 40): Promise<void> {
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

/** The list page with the members dialog open on its roster. */
async function openDialog(path = '/task-lists/tl_1'): Promise<HTMLElement> {
  const el = await mountAt(path)
  await click(el, 'tasks-list-detail-members')
  return el
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

function disabled(el: ParentNode, testid: string): boolean {
  return (must(el, testid) as HTMLButtonElement | HTMLInputElement | HTMLSelectElement).disabled
}

async function click(el: ParentNode, testid: string): Promise<void> {
  ;(must(el, testid) as HTMLButtonElement).click()
  await flush()
}

async function typeInto(el: ParentNode, testid: string, value: string): Promise<void> {
  const input = must(el, testid) as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input'))
  await flush()
}

/** Submits a form the way Enter does; also reaches the handler while its button is disabled. */
async function submit(el: ParentNode, testid: string): Promise<void> {
  must(el, testid).dispatchEvent(new Event('submit', { cancelable: true }))
  await flush()
}

/** Picks a value in a select the way a user does: the DOM value changes, then `change` fires. */
async function pick(select: HTMLSelectElement, value: string): Promise<void> {
  select.value = value
  select.dispatchEvent(new Event('change'))
  await flush()
}

function keydown(target: Element, key: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

function rowOf(el: ParentNode, userId: string): HTMLElement {
  const row = el.querySelector(`[data-testid="tasks-list-member"][data-user-id="${userId}"]`)
  expect(row, `expected the row of ${userId}`).toBeTruthy()
  return row as HTMLElement
}

function inRow(el: ParentNode, userId: string, testid: string): HTMLElement {
  return must(rowOf(el, userId), testid)
}

function roleSelect(el: ParentNode, userId: string): HTMLSelectElement {
  return inRow(el, userId, 'tasks-list-member-role-select') as HTMLSelectElement
}

/** The roster as `[userId, role]`, in rendered order. */
function rows(el: ParentNode): Array<[string, string]> {
  return shownAll(el, 'tasks-list-member').map((row) => [row.getAttribute('data-user-id') ?? '', row.getAttribute('data-role') ?? ''])
}

/** Which row controls each row shows. */
function rowControls(el: ParentNode): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const row of shownAll(el, 'tasks-list-member')) {
    out[row.getAttribute('data-user-id') ?? ''] = (['role-select', 'transfer', 'remove'] as const).filter(
      (control) => row.querySelector(`[data-testid="tasks-list-member-${control}"]`) !== null,
    )
  }
  return out
}

/** The dialog-level controls besides the rows. */
function dialogControls(el: ParentNode): { add: boolean; leave: boolean } {
  return { add: shown(el, 'tasks-list-add-member-form') !== null, leave: shown(el, 'tasks-list-leave') !== null }
}

/** The page's own write controls (FE-5), each `[present, disabled]`. */
function pageControlsDisabled(el: HTMLElement): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const id of [
    'tasks-list-detail-rename',
    'tasks-list-detail-archive',
    'tasks-list-detail-add-task-input',
    'tasks-list-detail-item-remove',
  ]) {
    out[id] = disabled(el, id)
  }
  return out
}

/** Makes `userId` the viewer of `tl_1` with the given list fields and roster. */
function viewAs(userId: string, list: Record<string, unknown>, roster?: Array<[string, Role]>): void {
  h_.getCurrentUserId.mockResolvedValue(userId)
  lists.tl_1 = listBody('tl_1', { name: 'Groceries', ...list })
  if (roster) rosters.tl_1 = roster.map(([id, role]) => member(id, role))
}

beforeEach(() => {
  unexpected = []
  lists = {
    tl_1: listBody('tl_1', { name: 'Groceries' }),
    tl_2: listBody('tl_2', { name: 'Chores' }),
  }
  rosters = {
    tl_1: [member('u1', 'owner'), member('u2', 'edit'), member('u3', 'read')],
    tl_2: [member('u1', 'owner'), member('u4', 'read')],
  }
  h_.apiFetch.mockReset().mockImplementation(fakeFetch)
  h_.loadTasksContext.mockReset().mockResolvedValue({ state: 'ready', orgId: 'org1' })
  h_.notifyTasksChanged.mockReset()
  h_.getCurrentUserId.mockReset().mockResolvedValue('u1')
  h_.listReply.mockReset().mockImplementation((id: string) => (lists[id] ? jsonResponse(200, lists[id]) : NOT_FOUND()))
  h_.archiveReply.mockReset().mockImplementation((id: string) => {
    lists[id] = { ...lists[id], archivedAt: '2031-02-01T00:00:00.000Z' }
    return jsonResponse(200, lists[id])
  })
  h_.membersReply.mockReset().mockImplementation((id: string, query: string) => (rosters[id] ? page(rosters[id], query) : NOT_FOUND()))
  h_.addMemberReply.mockReset().mockImplementation((id: string, body: string) => {
    const { userId, role } = JSON.parse(body) as { userId: string; role: Role }
    if (!rosters[id].some((row) => row.userId === userId)) rosters[id].push(member(userId, role))
    return jsonResponse(200, rosterBody(id))
  })
  h_.roleReply.mockReset().mockImplementation((id: string, userId: string, body: string) => {
    const { role } = JSON.parse(body) as { role: Role }
    rosters[id] = rosters[id].map((row) => (row.userId === userId ? { ...row, role } : row))
    return jsonResponse(200, rosterBody(id))
  })
  h_.removeMemberReply.mockReset().mockImplementation((id: string, userId: string) => {
    rosters[id] = rosters[id].filter((row) => row.userId !== userId)
    return jsonResponse(200, rosterBody(id))
  })
  h_.transferReply.mockReset().mockImplementation((id: string, body: string) => {
    const { userId } = JSON.parse(body) as { userId: string }
    rosters[id] = rosters[id].map((row) => {
      if (row.userId === userId) return { ...row, role: 'owner' as Role }
      if (row.role === 'owner') return { ...row, role: 'edit' as Role }
      return row
    })
    // Only the owner transfers, so the viewer was the owner and is now `edit`.
    lists[id] = { ...lists[id], ownerId: userId, myRole: 'edit' }
    return jsonResponse(200, rosterBody(id))
  })
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
// Opening the dialog and the roster read
// ---------------------------------------------------------------------------------------------

describe('members dialog — opening and the roster read', () => {
  it.each(['owner', 'edit', 'read'] as const)('a %s member sees the members button; nothing is read until it is clicked', async (role) => {
    viewAs('u2', { myRole: role, ownerId: role === 'owner' ? 'u2' : 'u1' })
    const el = await mountAt('/task-lists/tl_1')
    expect(text(el, 'tasks-list-detail-members')).toBe('成员')
    expect(must(el, 'tasks-list-detail-members').getAttribute('aria-haspopup')).toBe('dialog')
    expect(disabled(el, 'tasks-list-detail-members')).toBe(false)
    expect(shown(el, 'tasks-list-members-dialog')).toBeNull()
    expect(memberReads()).toBe(0)
  })

  it('opening reads the roster once; rows keep the server order with the role copy, and only the creator row is marked', async () => {
    const el = await openDialog()
    expect(requests('GET', '/api/task-lists/tl_1/members?limit=100&offset=0')).toHaveLength(1)
    expect(rows(el)).toEqual([
      ['u1', 'owner'],
      ['u2', 'edit'],
      ['u3', 'read'],
    ])
    expect(shownAll(el, 'tasks-list-member-id').map((node) => node.textContent?.trim())).toEqual(['u1', 'u2', 'u3'])
    expect(shownAll(el, 'tasks-list-member-role').map((node) => node.textContent?.trim())).toEqual(['所有者', '可编辑', '只读'])
    expect(shownAll(el, 'tasks-list-member-creator')).toHaveLength(1)
    expect(inRow(el, 'u1', 'tasks-list-member-creator').textContent?.trim()).toBe('创建人')
    expect(listReads()).toBe(1)
  })

  it('the dialog: role="dialog", aria-modal, labelled by its title; the title takes focus on open', async () => {
    const el = await openDialog()
    const dialog = must(el, 'tasks-list-members-dialog')
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe('tasks-list-members-title')
    const title = must(el, 'tasks-list-members-title')
    expect(title.id).toBe('tasks-list-members-title')
    expect(title.tagName).toBe('H2')
    expect(title.getAttribute('tabindex')).toBe('-1')
    expect(title.textContent?.trim()).toBe('清单成员')
    expect(document.activeElement).toBe(title)
  })

  it('while the roster read is in flight: the loading copy and no write control', async () => {
    const roster = deferred<Response>()
    h_.membersReply.mockImplementation(() => roster.promise)
    const el = await openDialog()
    expect(text(el, 'tasks-list-members-loading')).toBe('加载中…')
    expect(dialogControls(el)).toEqual({ add: false, leave: false })
    expect(shown(el, 'tasks-list-member')).toBeNull()
    roster.resolve(page(rosters.tl_1, 'offset=0'))
    await flush()
    expect(shown(el, 'tasks-list-members-loading')).toBeNull()
    expect(rows(el)).toHaveLength(3)
  })

  it('an empty roster has its own copy, told apart from a failed read', async () => {
    rosters.tl_1 = []
    const el = await openDialog()
    expect(text(el, 'tasks-list-members-empty')).toBe('暂无成员')
    expect(shown(el, 'tasks-list-members-load-error')).toBeNull()
  })

  it.each([
    ['a 500', () => jsonResponse(500, {})],
    ['a malformed row', () => jsonResponse(200, { items: [{ userId: 'u1', role: 'admin', createdAt: 'x' }], total: 1 })],
    ['a transport failure', () => Promise.reject(new Error('offline'))],
  ] as const)('%s on the roster read: the failure copy in the dialog, which stays open without write controls', async (_label, reply) => {
    h_.membersReply.mockImplementation(reply)
    const el = await openDialog()
    expect(text(el, 'tasks-list-members-load-error')).toBe('加载成员失败，请稍后重试')
    expect(must(el, 'tasks-list-members-load-error').getAttribute('role')).toBe('alert')
    expect(shown(el, 'tasks-list-members-empty')).toBeNull()
    expect(dialogControls(el)).toEqual({ add: false, leave: false })
    expect(listReads()).toBe(1)
    await click(el, 'tasks-list-members-close')
    expect(shown(el, 'tasks-list-members-dialog')).toBeNull()
  })

  it('a 403 on the roster read: its own copy; the list is not read again', async () => {
    h_.membersReply.mockImplementation(() => jsonResponse(403, { error: 'Insufficient permissions' }))
    const el = await openDialog()
    expect(text(el, 'tasks-list-members-forbidden')).toBe('您没有权限查看此清单')
    expect(shown(el, 'tasks-list-members-not-found')).toBeNull()
    expect(listReads()).toBe(1)
  })

  it('a 404 on the roster read: the not-available copy, and the page reads the list again once', async () => {
    h_.membersReply.mockImplementation(NOT_FOUND)
    const el = await openDialog()
    expect(text(el, 'tasks-list-members-not-found')).toBe('清单不可用或你已不是成员')
    expect(shown(el, 'tasks-list-members-forbidden')).toBeNull()
    expect(listReads()).toBe(2)
    must(el, 'tasks-list-members-dialog')
  })

  it('a 404 on the roster read whose list re-read is a 404 too: the page turns not_found and the dialog is gone', async () => {
    h_.membersReply.mockImplementation(() => {
      delete lists.tl_1
      return NOT_FOUND()
    })
    const el = await openDialog()
    expect(text(el, 'tasks-list-detail-not-found')).toBe('清单不存在或你不是成员')
    expect(shown(el, 'tasks-list-members-dialog')).toBeNull()
  })

  it('the degraded no-org body on the roster read switches the page to the guidance block', async () => {
    h_.membersReply.mockImplementation(() => jsonResponse(200, { items: [], degraded: true, reason: 'org_missing' }))
    const el = await openDialog()
    expect(text(el, 'tasks-view-org-missing')).toBe('请先选择一个组织后再查看任务')
    expect(shown(el, 'tasks-list-members-dialog')).toBeNull()
  })

  it('closing and opening again reads the roster again', async () => {
    const el = await openDialog()
    await click(el, 'tasks-list-members-close')
    rosters.tl_1.push(member('u5', 'read'))
    await click(el, 'tasks-list-detail-members')
    expect(memberReads()).toBe(2)
    expect(rows(el).map(([id]) => id)).toEqual(['u1', 'u2', 'u3', 'u5'])
  })
})

// ---------------------------------------------------------------------------------------------
// The §5.1 inference: which controls each viewer sees
// ---------------------------------------------------------------------------------------------

describe('members dialog — controls by role (design §5.1)', () => {
  it('the owner (also the creator): add; role, transfer and remove on every other row; nothing on their own row; no leave', async () => {
    const el = await openDialog()
    expect(rowControls(el)).toEqual({
      u1: [],
      u2: ['role-select', 'transfer', 'remove'],
      u3: ['role-select', 'transfer', 'remove'],
    })
    expect(dialogControls(el)).toEqual({ add: true, leave: false })
  })

  it('an edit member: add; role and remove on others but never on the owner row or their own; no transfer; leave', async () => {
    viewAs('u2', { myRole: 'edit' })
    const el = await openDialog()
    expect(rowControls(el)).toEqual({ u1: [], u2: [], u3: ['role-select', 'remove'] })
    expect(dialogControls(el)).toEqual({ add: true, leave: true })
  })

  it('a read member: no add, no row control at all; leave', async () => {
    viewAs('u3', { myRole: 'read' })
    const el = await openDialog()
    expect(rowControls(el)).toEqual({ u1: [], u2: [], u3: [] })
    expect(dialogControls(el)).toEqual({ add: false, leave: true })
  })

  it("an owner who is not the creator: the creator's row can change role and take ownership but is never removable; no leave", async () => {
    viewAs('u2', { createdBy: 'u1', ownerId: 'u2', myRole: 'owner' }, [['u1', 'edit'], ['u2', 'owner'], ['u3', 'read']])
    const el = await openDialog()
    expect(rowControls(el)).toEqual({
      u1: ['role-select', 'transfer'],
      u2: [],
      u3: ['role-select', 'transfer', 'remove'],
    })
    expect(dialogControls(el)).toEqual({ add: true, leave: false })
  })

  it('the creator who is no longer the owner: no leave, no control on their own row, none on the owner row', async () => {
    viewAs('u1', { createdBy: 'u1', ownerId: 'u2', myRole: 'edit' }, [['u1', 'edit'], ['u2', 'owner'], ['u3', 'read']])
    const el = await openDialog()
    expect(rowControls(el)).toEqual({ u1: [], u2: [], u3: ['role-select', 'remove'] })
    expect(dialogControls(el)).toEqual({ add: true, leave: false })
  })

  it('transfer targets every row but the one named by ownerId', async () => {
    viewAs('u1', { ownerId: 'u1', myRole: 'owner' }, [['u1', 'owner'], ['u2', 'edit'], ['u3', 'read'], ['u4', 'edit']])
    const el = await openDialog()
    expect(shownAll(el, 'tasks-list-member-transfer').map((button) => button.closest('[data-user-id]')?.getAttribute('data-user-id'))).toEqual([
      'u2',
      'u3',
      'u4',
    ])
  })

  it('while the viewer id resolves: no leave, no role select and no remove on any row; all appear once it is known', async () => {
    viewAs('u2', { myRole: 'edit' })
    const viewer = deferred<string | null>()
    h_.getCurrentUserId.mockReturnValue(viewer.promise)
    const el = await openDialog()
    expect(rowControls(el)).toEqual({ u1: [], u2: [], u3: [] })
    expect(dialogControls(el)).toEqual({ add: true, leave: false })
    viewer.resolve('u2')
    await flush()
    expect(rowControls(el)).toEqual({ u1: [], u2: [], u3: ['role-select', 'remove'] })
    expect(dialogControls(el)).toEqual({ add: true, leave: true })
  })

  it.each([
    ['resolves to null', () => Promise.resolve(null)],
    ['throws', () => Promise.reject(new Error('no session'))],
  ] as const)('when the viewer id %s: no leave, no role select, no remove; transfer and add stay', async (_label, resolveViewer) => {
    h_.getCurrentUserId.mockImplementation(resolveViewer)
    const el = await openDialog()
    expect(rowControls(el)).toEqual({ u1: [], u2: ['transfer'], u3: ['transfer'] })
    expect(dialogControls(el)).toEqual({ add: true, leave: false })
  })

  it('the role select offers read and edit only (owner is never given directly) and shows the row role', async () => {
    const el = await openDialog()
    const select = roleSelect(el, 'u3')
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['read', 'edit'])
    expect(Array.from(select.options).map((option) => option.textContent?.trim())).toEqual(['只读', '可编辑'])
    expect(select.value).toBe('read')
    expect(roleSelect(el, 'u2').value).toBe('edit')
    expect(select.getAttribute('aria-label')).toBe('「u3」的角色')
    expect(inRow(el, 'u3', 'tasks-list-member-remove').getAttribute('aria-label')).toBe('移除成员「u3」')
    expect(inRow(el, 'u3', 'tasks-list-member-transfer').getAttribute('aria-label')).toBe('将所有权转让给「u3」')
    expect(text(rowOf(el, 'u3'), 'tasks-list-member-remove')).toBe('移除')
    expect(text(rowOf(el, 'u3'), 'tasks-list-member-transfer')).toBe('设为所有者')
  })

  it('the add form: its labels, the role picker (read / edit, read first) and the leave button copy', async () => {
    viewAs('u2', { myRole: 'edit' })
    const el = await openDialog()
    const form = must(el, 'tasks-list-add-member-form')
    expect(Array.from(form.querySelectorAll('label')).map((label) => label.textContent?.trim())).toEqual(['添加成员（用户 ID）', '角色'])
    expect(must(el, 'tasks-list-add-member-input').getAttribute('placeholder')).toBe('用户 ID')
    const role = must(el, 'tasks-list-add-member-role') as HTMLSelectElement
    expect(Array.from(role.options).map((option) => option.value)).toEqual(['read', 'edit'])
    expect(role.value).toBe('read')
    expect(text(el, 'tasks-list-add-member-submit')).toBe('添加成员')
    expect(text(el, 'tasks-list-leave')).toBe('退出清单')
    expect(text(el, 'tasks-list-members-close')).toBe('关闭')
  })
})

// ---------------------------------------------------------------------------------------------
// Request bodies and success (the response replaces the roster)
// ---------------------------------------------------------------------------------------------

describe('members dialog — requests and their ok', () => {
  it('add: the trimmed id with the default role read; the input clears and the rows are the response', async () => {
    const bus = watchBus()
    const el = await openDialog()
    expect(disabled(el, 'tasks-list-add-member-submit')).toBe(true)
    await typeInto(el, 'tasks-list-add-member-input', '  u7  ')
    expect(disabled(el, 'tasks-list-add-member-submit')).toBe(false)
    await submit(el, 'tasks-list-add-member-form')
    expect(requests('POST', '/api/task-lists/tl_1/members').map(([, init]) => init?.body)).toEqual([JSON.stringify({ userId: 'u7', role: 'read' })])
    expect((must(el, 'tasks-list-add-member-input') as HTMLInputElement).value).toBe('')
    expect(rows(el)).toEqual([
      ['u1', 'owner'],
      ['u2', 'edit'],
      ['u3', 'read'],
      ['u7', 'read'],
    ])
    expect(memberReads()).toBe(1)
    expect(listReads()).toBe(1)
    expect(bus).not.toHaveBeenCalled()
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
  })

  it('add with the edit role picked sends it', async () => {
    const el = await openDialog()
    await typeInto(el, 'tasks-list-add-member-input', 'u8')
    await pick(must(el, 'tasks-list-add-member-role') as HTMLSelectElement, 'edit')
    await submit(el, 'tasks-list-add-member-form')
    expect(requests('POST', '/api/task-lists/tl_1/members').map(([, init]) => init?.body)).toEqual([JSON.stringify({ userId: 'u8', role: 'edit' })])
    expect(rows(el)).toContainEqual(['u8', 'edit'])
  })

  it('a blank id sends nothing, even through the form submit', async () => {
    const el = await openDialog()
    await typeInto(el, 'tasks-list-add-member-input', '   ')
    expect(disabled(el, 'tasks-list-add-member-submit')).toBe(true)
    await submit(el, 'tasks-list-add-member-form')
    expect(writes()).toEqual([])
  })

  it('the roster shown after an ok is exactly the response, including rows the client could not infer', async () => {
    h_.addMemberReply.mockImplementation(() =>
      jsonResponse(200, {
        id: 'tl_1',
        members: [
          { userId: 'u1', role: 'owner' },
          { userId: 'u7', role: 'read' },
          { userId: 'u9', role: 'edit' },
        ],
      }),
    )
    const el = await openDialog()
    await typeInto(el, 'tasks-list-add-member-input', 'u7')
    await submit(el, 'tasks-list-add-member-form')
    expect(rows(el)).toEqual([
      ['u1', 'owner'],
      ['u7', 'read'],
      ['u9', 'edit'],
    ])
    expect(memberReads()).toBe(1)
  })

  it('change role: PATCH {role} on the member path; the row shows the answer; nothing is read again', async () => {
    const bus = watchBus()
    const el = await openDialog()
    await pick(roleSelect(el, 'u3'), 'edit')
    expect(requests('PATCH', '/api/task-lists/tl_1/members/u3').map(([, init]) => init?.body)).toEqual([JSON.stringify({ role: 'edit' })])
    expect(rows(el)).toContainEqual(['u3', 'edit'])
    expect(roleSelect(el, 'u3').value).toBe('edit')
    expect(text(rowOf(el, 'u3'), 'tasks-list-member-role')).toBe('可编辑')
    expect(memberReads()).toBe(1)
    expect(listReads()).toBe(1)
    expect(bus).not.toHaveBeenCalled()
  })

  it('picking the role the row already has sends nothing', async () => {
    const el = await openDialog()
    await pick(roleSelect(el, 'u3'), 'read')
    expect(writes()).toEqual([])
  })

  it('remove: DELETE with no body on the member path; the row is gone; nothing is read again', async () => {
    const bus = watchBus()
    const el = await openDialog()
    await click(rowOf(el, 'u3'), 'tasks-list-member-remove')
    const sent = requests('DELETE', '/api/task-lists/tl_1/members/u3')
    expect(sent).toHaveLength(1)
    expect(sent[0][1]?.body).toBeUndefined()
    expect(rows(el)).toEqual([
      ['u1', 'owner'],
      ['u2', 'edit'],
    ])
    expect(memberReads()).toBe(1)
    expect(listReads()).toBe(1)
    expect(bus).not.toHaveBeenCalled()
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------------------------

describe('members dialog — transfer', () => {
  it('asks first, in the row: the prompt names the member; cancel sends nothing', async () => {
    const el = await openDialog()
    await click(rowOf(el, 'u2'), 'tasks-list-member-transfer')
    const confirm = inRow(el, 'u2', 'tasks-list-member-transfer-confirm')
    expect(confirm.textContent).toContain('确认将所有权转让给「u2」？转让后你将成为可编辑成员')
    expect(text(confirm, 'tasks-list-member-transfer-confirm-yes')).toBe('确认转让')
    expect(shown(rowOf(el, 'u2'), 'tasks-list-member-transfer')).toBeNull()
    // Only the row asked about confirms; the other rows keep their own transfer button.
    expect(shownAll(el, 'tasks-list-member-transfer-confirm')).toHaveLength(1)
    must(rowOf(el, 'u3'), 'tasks-list-member-transfer')
    await click(confirm, 'tasks-list-member-transfer-confirm-cancel')
    expect(shown(el, 'tasks-list-member-transfer-confirm')).toBeNull()
    must(rowOf(el, 'u2'), 'tasks-list-member-transfer')
    expect(writes()).toEqual([])
  })

  it('ok: POST {userId}; the roster from the response; the list read once more; the header and the controls follow the new role; the lists bus hears it once', async () => {
    const bus = watchBus()
    const el = await openDialog()
    await click(rowOf(el, 'u2'), 'tasks-list-member-transfer')
    await click(el, 'tasks-list-member-transfer-confirm-yes')
    expect(requests('POST', '/api/task-lists/tl_1/transfer-owner').map(([, init]) => init?.body)).toEqual([JSON.stringify({ userId: 'u2' })])
    expect(rows(el)).toEqual([
      ['u1', 'edit'],
      ['u2', 'owner'],
      ['u3', 'read'],
    ])
    expect(listReads()).toBe(2)
    expect(text(el, 'tasks-list-detail-role')).toBe('我的角色：可编辑')
    expect(shown(el, 'tasks-list-member-transfer')).toBeNull()
    expect(rowControls(el)).toEqual({ u1: [], u2: [], u3: ['role-select', 'remove'] })
    // u1 created the list: still no leave.
    expect(dialogControls(el)).toEqual({ add: true, leave: false })
    expect(memberReads()).toBe(1)
    expect(bus).toHaveBeenCalledTimes(1)
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
  })

  it('an owner who did not create the list can leave once the transfer has landed', async () => {
    viewAs('u2', { createdBy: 'u1', ownerId: 'u2', myRole: 'owner' }, [['u1', 'edit'], ['u2', 'owner'], ['u3', 'read']])
    const el = await openDialog()
    expect(dialogControls(el).leave).toBe(false)
    await click(rowOf(el, 'u3'), 'tasks-list-member-transfer')
    await click(el, 'tasks-list-member-transfer-confirm-yes')
    expect(dialogControls(el).leave).toBe(true)
  })

  it('the controls stay disabled until the list re-read lands', async () => {
    const reread = deferred<Response>()
    let reads = 0
    h_.listReply.mockImplementation((id: string) => {
      reads += 1
      return reads === 2 ? reread.promise : jsonResponse(200, lists[id])
    })
    const el = await openDialog()
    await click(rowOf(el, 'u2'), 'tasks-list-member-transfer')
    await click(el, 'tasks-list-member-transfer-confirm-yes')
    // The transfer answered; the list re-read is still out.
    expect(rows(el)).toContainEqual(['u2', 'owner'])
    expect(disabled(el, 'tasks-list-add-member-input')).toBe(true)
    expect(disabled(el, 'tasks-list-members-close')).toBe(true)
    expect(disabled(el, 'tasks-list-detail-rename')).toBe(true)
    reread.resolve(jsonResponse(200, lists.tl_1))
    await flush()
    expect(disabled(el, 'tasks-list-add-member-input')).toBe(false)
    expect(disabled(el, 'tasks-list-members-close')).toBe(false)
    expect(disabled(el, 'tasks-list-detail-rename')).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------------------------

describe('members dialog — leave', () => {
  beforeEach(() => {
    viewAs('u2', { myRole: 'edit' })
  })

  it('asks first; cancel sends nothing', async () => {
    const el = await openDialog()
    await click(el, 'tasks-list-leave')
    expect(text(el, 'tasks-list-leave-confirm')).toContain('确认退出此清单？')
    expect(text(el, 'tasks-list-leave-confirm-yes')).toBe('确认退出')
    await click(el, 'tasks-list-leave-confirm-cancel')
    expect(shown(el, 'tasks-list-leave-confirm')).toBeNull()
    must(el, 'tasks-list-leave')
    expect(writes()).toEqual([])
  })

  it("ok: DELETE on the viewer's own member path; the dialog closes, the page goes to /tasks, the lists bus hears it once", async () => {
    const bus = watchBus()
    const el = await openDialog()
    await click(el, 'tasks-list-leave')
    await click(el, 'tasks-list-leave-confirm-yes')
    const sent = requests('DELETE', '/api/task-lists/tl_1/members/u2')
    expect(sent).toHaveLength(1)
    expect(sent[0][1]?.body).toBeUndefined()
    expect(router!.currentRoute.value.path).toBe('/tasks')
    must(el, 'other-page')
    expect(shown(el, 'tasks-list-members-dialog')).toBeNull()
    expect(bus).toHaveBeenCalledTimes(1)
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
    expect(listReads()).toBe(1)
  })

  it('a read member leaves the same way', async () => {
    viewAs('u3', { myRole: 'read' })
    const el = await openDialog()
    await click(el, 'tasks-list-leave')
    await click(el, 'tasks-list-leave-confirm-yes')
    expect(requests('DELETE', '/api/task-lists/tl_1/members/u3')).toHaveLength(1)
    expect(router!.currentRoute.value.path).toBe('/tasks')
  })
})

// ---------------------------------------------------------------------------------------------
// Error codes and where they land (design §5.3)
// ---------------------------------------------------------------------------------------------

type Action = 'add' | 'role' | 'remove' | 'transfer' | 'leave'

/** Sets the reply of `action` to `reply`, opens the dialog as the viewer the action needs, and
 *  performs it. The add and the row actions act on u3 (transfer on u2) as the owner u1; leave is
 *  done by the edit member u2. */
async function perform(action: Action, reply: () => Response | Promise<Response>): Promise<HTMLElement> {
  if (action === 'leave') viewAs('u2', { myRole: 'edit' })
  const replyMock = {
    add: h_.addMemberReply,
    role: h_.roleReply,
    remove: h_.removeMemberReply,
    transfer: h_.transferReply,
    leave: h_.removeMemberReply,
  }[action]
  replyMock.mockImplementation(reply)
  const el = await openDialog()
  if (action === 'add') {
    await typeInto(el, 'tasks-list-add-member-input', 'u7')
    await submit(el, 'tasks-list-add-member-form')
  } else if (action === 'role') {
    await pick(roleSelect(el, 'u3'), 'edit')
  } else if (action === 'remove') {
    await click(rowOf(el, 'u3'), 'tasks-list-member-remove')
  } else if (action === 'transfer') {
    await click(rowOf(el, 'u2'), 'tasks-list-member-transfer')
    await click(el, 'tasks-list-member-transfer-confirm-yes')
  } else {
    await click(el, 'tasks-list-leave')
    await click(el, 'tasks-list-leave-confirm-yes')
  }
  return el
}

/** Every error spot of the dialog with its text, empty spots left out. */
function errorSpots(el: ParentNode): Record<string, string> {
  const out: Record<string, string> = {}
  for (const id of ['tasks-list-add-member-error', 'tasks-list-leave-error', 'tasks-list-members-error']) {
    const node = shown(el, id)
    if (node) out[id] = node.textContent?.trim() ?? ''
  }
  for (const node of shownAll(el, 'tasks-list-member-error')) {
    out[`row:${node.closest('[data-user-id]')?.getAttribute('data-user-id')}`] = node.textContent?.trim() ?? ''
  }
  return out
}

describe('members dialog — each code lands next to what caused it (design §5.3)', () => {
  it.each([
    ['add', 'INVALID_MEMBER', 'tasks-list-add-member-error', '无效的用户'],
    ['add', 'INVALID_ROLE', 'tasks-list-add-member-error', '无效的角色'],
    ['add', 'INACTIVE_ORG_MEMBER', 'tasks-list-add-member-error', '该用户不在当前组织或已停用'],
    ['add', 'LIMIT', 'tasks-list-add-member-error', '成员数已达上限'],
    ['add', 'SOMETHING_NEW', 'tasks-list-add-member-error', '操作失败，请稍后重试'],
    ['role', 'INVALID_MEMBER', 'row:u3', '无效的用户'],
    ['role', 'INVALID_ROLE', 'row:u3', '无效的角色'],
    ['role', 'OWNER_MUST_TRANSFER', 'row:u3', '请先转让所有权'],
    ['remove', 'INVALID_MEMBER', 'row:u3', '无效的用户'],
    ['remove', 'CREATED_BY_IMMUTABLE', 'row:u3', '清单创建人不能被移除'],
    ['remove', 'OWNER_MUST_TRANSFER', 'row:u3', '请先转让所有权'],
    ['transfer', 'INVALID_MEMBER', 'row:u2', '无效的用户'],
    ['transfer', 'TARGET_NOT_MEMBER', 'row:u2', '对方不是清单成员'],
    ['transfer', 'INACTIVE_ORG_MEMBER', 'row:u2', '该用户不在当前组织或已停用'],
    ['leave', 'CREATED_BY_IMMUTABLE', 'tasks-list-leave-error', '清单创建人不能被移除'],
    ['leave', 'OWNER_MUST_TRANSFER', 'tasks-list-leave-error', '请先转让所有权'],
    ['leave', 'INVALID_MEMBER', 'tasks-list-leave-error', '无效的用户'],
  ] as const)('%s × %s ⇒ %s: %s', async (action, code, spot, copy) => {
    const bus = watchBus()
    const el = await perform(action, () => code422(code))
    expect(errorSpots(el)).toEqual({ [spot]: copy })
    expect(rows(el)).toEqual([
      ['u1', 'owner'],
      ['u2', 'edit'],
      ['u3', 'read'],
    ])
    expect(memberReads()).toBe(1)
    expect(listReads()).toBe(1)
    expect(bus).not.toHaveBeenCalled()
    expect(router!.currentRoute.value.path).toBe('/task-lists/tl_1')
    // The confirmation blocks fold after an answer.
    expect(shown(el, 'tasks-list-member-transfer-confirm')).toBeNull()
    expect(shown(el, 'tasks-list-leave-confirm')).toBeNull()
  })

  it('add keeps the typed id after a code, and typing again clears the error', async () => {
    const el = await perform('add', () => code422('INVALID_MEMBER'))
    expect((must(el, 'tasks-list-add-member-input') as HTMLInputElement).value).toBe('u7')
    expect(must(el, 'tasks-list-add-member-input').getAttribute('aria-invalid')).toBe('true')
    expect(must(el, 'tasks-list-add-member-input').getAttribute('aria-describedby')).toBe('tasks-list-add-member-error')
    await typeInto(el, 'tasks-list-add-member-input', 'u77')
    expect(shown(el, 'tasks-list-add-member-error')).toBeNull()
  })

  it.each(['add', 'role', 'remove', 'transfer', 'leave'] as const)(
    '%s answered 404: the banner, the list read again once, the roster read again once; no spot error',
    async (action) => {
      const el = await perform(action, NOT_FOUND)
      expect(errorSpots(el)).toEqual({ 'tasks-list-members-error': '清单不可用或你已不是成员' })
      expect(must(el, 'tasks-list-members-error').getAttribute('role')).toBe('alert')
      expect(listReads()).toBe(2)
      expect(memberReads()).toBe(2)
      expect(router!.currentRoute.value.path).toBe('/task-lists/tl_1')
    },
  )

  it('a 404 whose list re-read is a 404 too: the page turns not_found, and the roster is not read again', async () => {
    const el = await perform('role', () => {
      delete lists.tl_1
      return NOT_FOUND()
    })
    expect(text(el, 'tasks-list-detail-not-found')).toBe('清单不存在或你不是成员')
    expect(shown(el, 'tasks-list-members-dialog')).toBeNull()
    expect(memberReads()).toBe(1)
  })

  it('a 404 that leaves the dialog showing: the roster re-read drops a row the server no longer has', async () => {
    const el = await perform('role', () => {
      rosters.tl_1 = rosters.tl_1.filter((row) => row.userId !== 'u3')
      return NOT_FOUND()
    })
    expect(rows(el)).toEqual([
      ['u1', 'owner'],
      ['u2', 'edit'],
    ])
    expect(text(el, 'tasks-list-members-error')).toBe('清单不可用或你已不是成员')
  })

  it.each(['add', 'role', 'remove', 'transfer', 'leave'] as const)('%s answered 403: the banner, nothing read again', async (action) => {
    const el = await perform(action, () => jsonResponse(403, { error: 'Insufficient permissions' }))
    expect(errorSpots(el)).toEqual({ 'tasks-list-members-error': '您没有权限修改此清单' })
    expect(listReads()).toBe(1)
    expect(memberReads()).toBe(1)
  })

  it.each([
    ['add', 'a 500', () => jsonResponse(500, {})],
    ['role', 'a malformed 200', () => jsonResponse(200, { id: 'tl_1', members: [{ userId: 'u1' }] })],
    ['remove', 'a transport failure', () => Promise.reject(new Error('offline'))],
    ['transfer', 'a 500', () => jsonResponse(500, {})],
    ['leave', 'a malformed 200', () => jsonResponse(200, { id: 'tl_1' })],
  ] as const)('%s answered with %s: the banner with the failure copy', async (action, _label, reply) => {
    const bus = watchBus()
    const el = await perform(action, reply)
    expect(errorSpots(el)).toEqual({ 'tasks-list-members-error': '操作失败，请稍后重试' })
    expect(listReads()).toBe(1)
    expect(bus).not.toHaveBeenCalled()
    expect(router!.currentRoute.value.path).toBe('/task-lists/tl_1')
  })

  it.each(['add', 'role', 'remove', 'transfer', 'leave'] as const)('%s answered ORG_MISSING: the page guidance block', async (action) => {
    const el = await perform(action, () => code422('ORG_MISSING'))
    expect(text(el, 'tasks-view-org-missing')).toBe('请先选择一个组织后再查看任务')
    expect(shown(el, 'tasks-list-members-dialog')).toBeNull()
  })

  it('the next write clears the previous banner and spot error', async () => {
    h_.removeMemberReply.mockImplementationOnce(() => jsonResponse(500, {}))
    h_.roleReply.mockImplementationOnce(() => code422('INVALID_ROLE'))
    const el = await openDialog()
    await click(rowOf(el, 'u3'), 'tasks-list-member-remove')
    must(el, 'tasks-list-members-error')
    await pick(roleSelect(el, 'u3'), 'edit')
    expect(errorSpots(el)).toEqual({ 'row:u3': '无效的角色' })
    await typeInto(el, 'tasks-list-add-member-input', 'u7')
    await submit(el, 'tasks-list-add-member-form')
    expect(errorSpots(el)).toEqual({})
  })

  it('the next write clears the leave error', async () => {
    const el = await perform('leave', () => code422('OWNER_MUST_TRANSFER'))
    must(el, 'tasks-list-leave-error')
    await typeInto(el, 'tasks-list-add-member-input', 'u7')
    await submit(el, 'tasks-list-add-member-form')
    expect(errorSpots(el)).toEqual({})
  })

  it('at the member cap the add form is disabled with the cap notice, and a submit sends nothing', async () => {
    rosters.tl_1 = [member('u1', 'owner'), ...Array.from({ length: 99 }, (_, i) => member(`m${String(i).padStart(3, '0')}`, 'read'))]
    const el = await openDialog()
    expect(rows(el)).toHaveLength(100)
    expect(text(el, 'tasks-list-add-member-cap')).toBe('成员数已达上限')
    expect(disabled(el, 'tasks-list-add-member-input')).toBe(true)
    expect(disabled(el, 'tasks-list-add-member-role')).toBe(true)
    expect(disabled(el, 'tasks-list-add-member-submit')).toBe(true)
    const input = must(el, 'tasks-list-add-member-input') as HTMLInputElement
    input.value = 'u7'
    input.dispatchEvent(new Event('input'))
    await submit(el, 'tasks-list-add-member-form')
    expect(writes()).toEqual([])
  })

  it('one under the cap the add form is open and there is no notice', async () => {
    rosters.tl_1 = [member('u1', 'owner'), ...Array.from({ length: 98 }, (_, i) => member(`m${String(i).padStart(3, '0')}`, 'read'))]
    const el = await openDialog()
    expect(shown(el, 'tasks-list-add-member-cap')).toBeNull()
    expect(disabled(el, 'tasks-list-add-member-input')).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// The role select shows the server's role
// ---------------------------------------------------------------------------------------------

describe('members dialog — the role select follows the server', () => {
  it('while the change is in flight the select still shows the server role; the answer replaces it', async () => {
    const pending = deferred<Response>()
    h_.roleReply.mockImplementation(() => pending.promise)
    const el = await openDialog()
    await pick(roleSelect(el, 'u3'), 'edit')
    expect(roleSelect(el, 'u3').value).toBe('read')
    expect(rows(el)).toContainEqual(['u3', 'read'])
    rosters.tl_1 = rosters.tl_1.map((row) => (row.userId === 'u3' ? { ...row, role: 'edit' } : row))
    pending.resolve(jsonResponse(200, rosterBody('tl_1')))
    await flush()
    expect(roleSelect(el, 'u3').value).toBe('edit')
  })

  it('a code keeps the server role in the select', async () => {
    h_.roleReply.mockImplementation(() => code422('INVALID_ROLE'))
    const el = await openDialog()
    await pick(roleSelect(el, 'u3'), 'edit')
    expect(roleSelect(el, 'u3').value).toBe('read')
  })

  it('a pick that arrives while another write is in flight sends nothing and leaves the server role showing', async () => {
    const pending = deferred<Response>()
    h_.addMemberReply.mockImplementation(() => pending.promise)
    const el = await openDialog()
    await typeInto(el, 'tasks-list-add-member-input', 'u7')
    await submit(el, 'tasks-list-add-member-form')
    expect(disabled(rowOf(el, 'u3'), 'tasks-list-member-role-select')).toBe(true)
    await pick(roleSelect(el, 'u3'), 'edit')
    expect(writes()).toHaveLength(1)
    expect(roleSelect(el, 'u3').value).toBe('read')
    pending.resolve(jsonResponse(200, rosterBody('tl_1')))
    await flush()
  })
})

// ---------------------------------------------------------------------------------------------
// One write at a time across the page and the dialog (`v-model:pending`)
// ---------------------------------------------------------------------------------------------

describe('members dialog — one write at a time with the page', () => {
  it("a member write in flight disables the page's write controls and the dialog's; both come back after the answer", async () => {
    const pending = deferred<Response>()
    h_.removeMemberReply.mockImplementation(() => pending.promise)
    const el = await openDialog()
    await click(rowOf(el, 'u3'), 'tasks-list-member-remove')
    expect(pageControlsDisabled(el)).toEqual({
      'tasks-list-detail-rename': true,
      'tasks-list-detail-archive': true,
      'tasks-list-detail-add-task-input': true,
      'tasks-list-detail-item-remove': true,
    })
    expect(must(el, 'tasks-list-detail').getAttribute('aria-busy')).toBe('true')
    for (const node of [
      roleSelect(el, 'u2'),
      inRow(el, 'u2', 'tasks-list-member-transfer'),
      inRow(el, 'u2', 'tasks-list-member-remove'),
      must(el, 'tasks-list-add-member-input'),
      must(el, 'tasks-list-members-close'),
    ]) {
      expect((node as HTMLButtonElement).disabled, node.getAttribute('data-testid') ?? '').toBe(true)
    }
    ;(inRow(el, 'u2', 'tasks-list-member-remove') as HTMLButtonElement).disabled = false
    await click(rowOf(el, 'u2'), 'tasks-list-member-remove')
    expect(writes()).toHaveLength(1)
    pending.resolve(jsonResponse(200, { id: 'tl_1', members: [{ userId: 'u1', role: 'owner' }, { userId: 'u2', role: 'edit' }] }))
    await flush()
    expect(pageControlsDisabled(el)).toEqual({
      'tasks-list-detail-rename': false,
      'tasks-list-detail-archive': false,
      'tasks-list-detail-add-task-input': false,
      'tasks-list-detail-item-remove': false,
    })
    expect(must(el, 'tasks-list-detail').getAttribute('aria-busy')).toBe('false')
    expect(disabled(el, 'tasks-list-members-close')).toBe(false)
  })

  it("a page write in flight disables the dialog's controls; the members button stays usable", async () => {
    const pending = deferred<Response>()
    h_.archiveReply.mockImplementation(() => pending.promise)
    const el = await mountAt('/task-lists/tl_1')
    await click(el, 'tasks-list-detail-archive')
    expect(disabled(el, 'tasks-list-detail-members')).toBe(false)
    await click(el, 'tasks-list-detail-members')
    expect(rows(el)).toHaveLength(3)
    expect(roleSelect(el, 'u3').disabled).toBe(true)
    expect(disabled(rowOf(el, 'u3'), 'tasks-list-member-remove')).toBe(true)
    expect(disabled(rowOf(el, 'u3'), 'tasks-list-member-transfer')).toBe(true)
    await typeInto(el, 'tasks-list-add-member-input', 'u7')
    await submit(el, 'tasks-list-add-member-form')
    expect(writes()).toHaveLength(1)
    pending.resolve(jsonResponse(200, { ...lists.tl_1, archivedAt: '2031-02-01T00:00:00.000Z' }))
    await flush()
    expect(roleSelect(el, 'u3').disabled).toBe(false)
  })

  it('two clicks in the same tick send one request', async () => {
    const el = await openDialog()
    const first = inRow(el, 'u3', 'tasks-list-member-remove') as HTMLButtonElement
    const second = inRow(el, 'u2', 'tasks-list-member-remove') as HTMLButtonElement
    first.click()
    second.click()
    await flush()
    expect(writes()).toHaveLength(1)
    expect(requests('DELETE', '/api/task-lists/tl_1/members/u3')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------------------------
// Closing, focus and the keyboard
// ---------------------------------------------------------------------------------------------

describe('members dialog — closing and focus', () => {
  it('Escape closes it and focus goes back to the members button', async () => {
    const el = await openDialog()
    keydown(must(el, 'tasks-list-members-title'), 'Escape')
    await flush()
    expect(shown(el, 'tasks-list-members-dialog')).toBeNull()
    expect(document.activeElement).toBe(must(el, 'tasks-list-detail-members'))
  })

  it('the close button closes it and focus goes back to the members button', async () => {
    const el = await openDialog()
    await click(el, 'tasks-list-members-close')
    expect(shown(el, 'tasks-list-members-dialog')).toBeNull()
    expect(document.activeElement).toBe(must(el, 'tasks-list-detail-members'))
  })

  it('Escape and the close button do nothing while a write is in flight', async () => {
    const pending = deferred<Response>()
    h_.removeMemberReply.mockImplementation(() => pending.promise)
    const el = await openDialog()
    await click(rowOf(el, 'u3'), 'tasks-list-member-remove')
    keydown(must(el, 'tasks-list-members-dialog'), 'Escape')
    await flush()
    must(el, 'tasks-list-members-dialog')
    ;(must(el, 'tasks-list-members-close') as HTMLButtonElement).disabled = false
    await click(el, 'tasks-list-members-close')
    must(el, 'tasks-list-members-dialog')
    pending.resolve(jsonResponse(200, rosterBody('tl_1')))
    await flush()
    keydown(must(el, 'tasks-list-members-dialog'), 'Escape')
    await flush()
    expect(shown(el, 'tasks-list-members-dialog')).toBeNull()
  })

  it('Tab past the last control wraps to the first, Shift+Tab before the first wraps to the last; the title counts as outside', async () => {
    const el = await openDialog()
    const first = roleSelect(el, 'u2')
    const last = must(el, 'tasks-list-members-close')
    last.focus()
    const forward = keydown(last, 'Tab')
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
    const backward = keydown(first, 'Tab', true)
    expect(backward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(last)
    const title = must(el, 'tasks-list-members-title')
    title.focus()
    keydown(title, 'Tab', true)
    expect(document.activeElement).toBe(last)
    title.focus()
    keydown(title, 'Tab')
    expect(document.activeElement).toBe(first)
  })

  it('Tab between two controls inside is left to the browser', async () => {
    const el = await openDialog()
    const middle = inRow(el, 'u3', 'tasks-list-member-remove')
    middle.focus()
    expect(keydown(middle, 'Tab').defaultPrevented).toBe(false)
    expect(keydown(middle, 'Tab', true).defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(middle)
  })

  it('disabled controls are left out of the cycle: with only the close button usable, Shift+Tab stays on it', async () => {
    // An edit member whose own id is still resolving (no row control, no leave) at the member cap
    // (the add form is disabled): the close button is the one usable control.
    viewAs('u2', { myRole: 'edit' }, [['u1', 'owner'], ...Array.from({ length: 99 }, (_, i): [string, Role] => [`m${String(i).padStart(3, '0')}`, 'read'])])
    h_.getCurrentUserId.mockReturnValue(new Promise(() => undefined))
    const el = await openDialog()
    const close = must(el, 'tasks-list-members-close')
    close.focus()
    expect(keydown(close, 'Tab', true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
  })

  // [fe-48] (FE-8): a browser moves focus off a control it disables to the page body (the focus
  // fixup rule; jsdom keeps it there and its blur() is a no-op on a disabled control, so these cells
  // drop it by hand where a browser would), and a write can take its control away; once the write
  // lands, focus comes back into the dialog, where Escape and the Tab wrap work.
  function dropFocusToBody(): void {
    const stand = document.createElement('button')
    document.body.appendChild(stand)
    stand.focus()
    stand.remove()
  }

  it('[fe-48] after a write lands, focus the browser dropped to the page goes back to the control the write started from, and Escape works again', async () => {
    const pending = deferred<Response>()
    h_.addMemberReply.mockImplementation(() => pending.promise)
    const el = await openDialog()
    await typeInto(el, 'tasks-list-add-member-input', 'u7')
    const input = must(el, 'tasks-list-add-member-input') as HTMLInputElement
    input.focus()
    await submit(el, 'tasks-list-add-member-form')
    dropFocusToBody()
    expect(document.activeElement).toBe(document.body)
    rosters.tl_1.push(member('u7', 'read'))
    pending.resolve(jsonResponse(200, rosterBody('tl_1')))
    await flush()
    expect(rows(el).map(([id]) => id)).toContain('u7')
    expect(document.activeElement).toBe(must(el, 'tasks-list-add-member-input'))
    keydown(document.activeElement as HTMLElement, 'Escape')
    await flush()
    expect(shown(el, 'tasks-list-members-dialog')).toBeNull()
  })

  it('[fe-48] a write that takes its control away puts focus on the title (a transfer: the confirm button is gone)', async () => {
    const el = await openDialog()
    await click(rowOf(el, 'u2'), 'tasks-list-member-transfer')
    const yes = must(el, 'tasks-list-member-transfer-confirm-yes')
    yes.focus()
    yes.click()
    await flush()
    expect(rows(el)).toContainEqual(['u2', 'owner'])
    expect(shown(el, 'tasks-list-member-transfer-confirm-yes')).toBeNull()
    expect(document.activeElement).toBe(must(el, 'tasks-list-members-title'))
  })

  it('[fe-48] the control the write started from is disabled after it (the member cap reached): focus goes to the title', async () => {
    viewAs('u1', {}, [['u1', 'owner'], ...Array.from({ length: 98 }, (_, i): [string, Role] => [`m${String(i).padStart(3, '0')}`, 'read'])])
    const pending = deferred<Response>()
    h_.addMemberReply.mockImplementation(() => pending.promise)
    const el = await openDialog()
    await typeInto(el, 'tasks-list-add-member-input', 'u7')
    ;(must(el, 'tasks-list-add-member-input') as HTMLInputElement).focus()
    await submit(el, 'tasks-list-add-member-form')
    dropFocusToBody()
    rosters.tl_1.push(member('u7', 'read'))
    pending.resolve(jsonResponse(200, rosterBody('tl_1')))
    await flush()
    expect(rows(el)).toHaveLength(100)
    expect(disabled(el, 'tasks-list-add-member-input')).toBe(true)
    expect(document.activeElement).toBe(must(el, 'tasks-list-members-title'))
  })

  it('[fe-48] focus that is inside the dialog when a write lands stays where it is', async () => {
    const pending = deferred<Response>()
    h_.addMemberReply.mockImplementation(() => pending.promise)
    const el = await openDialog()
    await typeInto(el, 'tasks-list-add-member-input', 'u7')
    ;(must(el, 'tasks-list-add-member-input') as HTMLInputElement).focus()
    await submit(el, 'tasks-list-add-member-form')
    const title = must(el, 'tasks-list-members-title')
    title.focus()
    rosters.tl_1.push(member('u7', 'read'))
    pending.resolve(jsonResponse(200, rosterBody('tl_1')))
    await flush()
    expect(document.activeElement).toBe(title)
  })

  it('with every control disabled by a write in flight, Tab is held inside the dialog', async () => {
    const pending = deferred<Response>()
    h_.removeMemberReply.mockImplementation(() => pending.promise)
    const el = await openDialog()
    const remove = inRow(el, 'u3', 'tasks-list-member-remove')
    remove.focus()
    remove.click()
    await flush()
    // The handler raises nothing on an empty set (a listener exception reaches window as `error`).
    const errors: unknown[] = []
    const onError = (event: ErrorEvent) => errors.push(event.error)
    window.addEventListener('error', onError)
    try {
      expect(keydown(remove, 'Tab').defaultPrevented).toBe(true)
      expect(keydown(remove, 'Tab', true).defaultPrevented).toBe(true)
    } finally {
      window.removeEventListener('error', onError)
    }
    expect(errors).toEqual([])
    expect(document.activeElement).toBe(remove)
    pending.resolve(jsonResponse(200, rosterBody('tl_1')))
    await flush()
  })
})

// [fe-49]: a confirmation swaps out the button that opened it, and cancel swaps it back; the control
// the viewer used is gone either way, which in a browser leaves focus on the page body, outside the
// dialog, where Escape and the Tab wrap are not heard. Each cell focuses the control it activates
// (a keyboard user's Enter), then checks the exact control focus moved to and that Escape, sent
// from there, still closes the dialog.
describe('members dialog — the transfer and leave confirmations keep focus inside ([fe-49])', () => {
  async function press(control: HTMLElement): Promise<void> {
    control.focus()
    control.click()
    await flush()
  }

  async function escapeClosesTheDialog(el: HTMLElement): Promise<void> {
    keydown(document.activeElement as HTMLElement, 'Escape')
    await flush()
    expect(shown(el, 'tasks-list-members-dialog')).toBeNull()
    expect(document.activeElement).toBe(must(el, 'tasks-list-detail-members'))
  }

  it("opening a row's transfer confirmation focuses its confirm button, which the prompt describes; Escape from there closes the dialog", async () => {
    const el = await openDialog()
    await press(inRow(el, 'u3', 'tasks-list-member-transfer'))
    const yes = inRow(el, 'u3', 'tasks-list-member-transfer-confirm-yes')
    expect(document.activeElement).toBe(yes)
    const prompt = inRow(el, 'u3', 'tasks-list-member-transfer-prompt')
    expect(prompt.textContent?.trim()).toBe('确认将所有权转让给「u3」？转让后你将成为可编辑成员')
    expect(prompt.getAttribute('role')).toBe('status')
    expect(yes.getAttribute('aria-describedby')).toBe(prompt.id)
    expect(document.getElementById(prompt.id)).toBe(prompt)
    await escapeClosesTheDialog(el)
  })

  it("cancelling it focuses that row's transfer button again; Escape from there closes the dialog", async () => {
    const el = await openDialog()
    await press(inRow(el, 'u3', 'tasks-list-member-transfer'))
    await press(inRow(el, 'u3', 'tasks-list-member-transfer-confirm-cancel'))
    expect(shown(el, 'tasks-list-member-transfer-confirm')).toBeNull()
    expect(document.activeElement).toBe(inRow(el, 'u3', 'tasks-list-member-transfer'))
    await escapeClosesTheDialog(el)
  })

  it('opening the leave confirmation focuses its confirm button, which the prompt describes; Escape from there closes the dialog', async () => {
    viewAs('u2', { myRole: 'edit' })
    const el = await openDialog()
    await press(must(el, 'tasks-list-leave'))
    const yes = must(el, 'tasks-list-leave-confirm-yes')
    expect(document.activeElement).toBe(yes)
    const prompt = must(el, 'tasks-list-leave-prompt')
    expect(prompt.textContent?.trim()).toBe('确认退出此清单？')
    expect(prompt.getAttribute('role')).toBe('status')
    expect(yes.getAttribute('aria-describedby')).toBe(prompt.id)
    expect(document.getElementById(prompt.id)).toBe(prompt)
    await escapeClosesTheDialog(el)
  })

  it('cancelling it focuses the leave button again; Escape from there closes the dialog', async () => {
    viewAs('u2', { myRole: 'edit' })
    const el = await openDialog()
    await press(must(el, 'tasks-list-leave'))
    await press(must(el, 'tasks-list-leave-confirm-cancel'))
    expect(shown(el, 'tasks-list-leave-confirm')).toBeNull()
    expect(document.activeElement).toBe(must(el, 'tasks-list-leave'))
    await escapeClosesTheDialog(el)
  })
})

// ---------------------------------------------------------------------------------------------
// Route edges and results that land late
// ---------------------------------------------------------------------------------------------

describe('members dialog — another list, and results that land late', () => {
  it('a route edge closes the dialog and gives the page its controls back', async () => {
    const pending = deferred<Response>()
    h_.addMemberReply.mockImplementation(() => pending.promise)
    const el = await openDialog()
    await typeInto(el, 'tasks-list-add-member-input', 'u7')
    await submit(el, 'tasks-list-add-member-form')
    await go('/task-lists/tl_2')
    expect(text(el, 'tasks-list-detail-title')).toBe('Chores')
    expect(shown(el, 'tasks-list-members-dialog')).toBeNull()
    expect(disabled(el, 'tasks-list-detail-archive')).toBe(false)
    expect(memberReads('tl_2')).toBe(0)
    const before = fetchCalls().length
    pending.resolve(jsonResponse(200, rosterBody('tl_1')))
    await flush()
    expect(fetchCalls().slice(before)).toEqual([])
    await click(el, 'tasks-list-detail-members')
    expect(rows(el)).toEqual([
      ['u1', 'owner'],
      ['u4', 'read'],
    ])
  })

  it('a roster read answered 404 after the dialog closed: no list read', async () => {
    const roster = deferred<Response>()
    h_.membersReply.mockImplementationOnce(() => roster.promise)
    const el = await openDialog()
    await click(el, 'tasks-list-members-close')
    roster.resolve(NOT_FOUND())
    await flush()
    expect(listReads()).toBe(1)
  })

  it('a roster read that lands after the dialog closed and opened again does not paint over the new read', async () => {
    const first = deferred<Response>()
    h_.membersReply.mockImplementationOnce(() => first.promise)
    const el = await openDialog()
    await click(el, 'tasks-list-members-close')
    await click(el, 'tasks-list-detail-members')
    expect(rows(el)).toHaveLength(3)
    first.resolve(jsonResponse(200, { items: [member('u_old', 'read')], total: 1 }))
    await flush()
    expect(rows(el)).toHaveLength(3)
  })

  it('a roster read answered 404 after the route moved on: no list read under either id', async () => {
    const roster = deferred<Response>()
    h_.membersReply.mockImplementationOnce(() => roster.promise)
    const el = await openDialog()
    await go('/task-lists/tl_2')
    roster.resolve(NOT_FOUND())
    await flush()
    expect(listReads('tl_1')).toBe(1)
    expect(listReads('tl_2')).toBe(1)
    expect(shown(el, 'tasks-list-members-dialog')).toBeNull()
  })

  it('a transfer answered after the route moved on: no list read under either id, the lists bus still hears it once', async () => {
    const pending = deferred<Response>()
    h_.transferReply.mockImplementation(() => pending.promise)
    const bus = watchBus()
    const el = await openDialog()
    await click(rowOf(el, 'u2'), 'tasks-list-member-transfer')
    await click(el, 'tasks-list-member-transfer-confirm-yes')
    await go('/task-lists/tl_2')
    pending.resolve(jsonResponse(200, { id: 'tl_1', members: [{ userId: 'u1', role: 'edit' }, { userId: 'u2', role: 'owner' }] }))
    await flush()
    expect(listReads('tl_1')).toBe(1)
    expect(listReads('tl_2')).toBe(1)
    expect(text(el, 'tasks-list-detail-role')).toBe('我的角色：所有者')
    expect(bus).toHaveBeenCalledTimes(1)
  })

  // Left for a task page: that route has an `:id` too, so a result acted on after leaving would
  // read under the task's id.
  it('a transfer answered after the page was left for a task: no request at all, the lists bus still hears it once', async () => {
    const pending = deferred<Response>()
    h_.transferReply.mockImplementation(() => pending.promise)
    const bus = watchBus()
    const el = await openDialog()
    await click(rowOf(el, 'u2'), 'tasks-list-member-transfer')
    await click(el, 'tasks-list-member-transfer-confirm-yes')
    await go('/tasks/t1')
    must(el, 'other-page')
    const before = fetchCalls().length
    pending.resolve(jsonResponse(200, { id: 'tl_1', members: [{ userId: 'u1', role: 'edit' }, { userId: 'u2', role: 'owner' }] }))
    await flush()
    expect(fetchCalls().slice(before)).toEqual([])
    expect(bus).toHaveBeenCalledTimes(1)
  })

  it('a leave answered after the page was left for a task: no navigation, no request, the lists bus still hears it once', async () => {
    viewAs('u2', { myRole: 'edit' })
    const pending = deferred<Response>()
    h_.removeMemberReply.mockImplementation(() => pending.promise)
    const bus = watchBus()
    const el = await openDialog()
    await click(el, 'tasks-list-leave')
    await click(el, 'tasks-list-leave-confirm-yes')
    await go('/tasks/t1')
    const before = fetchCalls().length
    pending.resolve(jsonResponse(200, { id: 'tl_1', members: [{ userId: 'u1', role: 'owner' }] }))
    await flush()
    expect(router!.currentRoute.value.path).toBe('/tasks/t1')
    expect(fetchCalls().slice(before)).toEqual([])
    expect(bus).toHaveBeenCalledTimes(1)
  })

  it('a leave answered after the route moved on to another list: the page stays on it, the lists bus hears it once', async () => {
    viewAs('u2', { myRole: 'edit' })
    const pending = deferred<Response>()
    h_.removeMemberReply.mockImplementation(() => pending.promise)
    const bus = watchBus()
    const el = await openDialog()
    await click(el, 'tasks-list-leave')
    await click(el, 'tasks-list-leave-confirm-yes')
    await go('/task-lists/tl_2')
    pending.resolve(jsonResponse(200, { id: 'tl_1', members: [{ userId: 'u1', role: 'owner' }] }))
    await flush()
    expect(router!.currentRoute.value.path).toBe('/task-lists/tl_2')
    expect(text(el, 'tasks-list-detail-title')).toBe('Chores')
    expect(bus).toHaveBeenCalledTimes(1)
  })

  it.each(['add', 'role', 'remove', 'transfer', 'leave'] as const)('%s answered 404 after the route moved on: no banner, no list read, no roster read', async (action) => {
    const pending = deferred<Response>()
    const el = await perform(action, () => pending.promise)
    await go('/task-lists/tl_2')
    pending.resolve(NOT_FOUND())
    await flush()
    expect(listReads('tl_1')).toBe(1)
    expect(listReads('tl_2')).toBe(1)
    expect(memberReads('tl_1')).toBe(1)
    expect(memberReads('tl_2')).toBe(0)
    await click(el, 'tasks-list-detail-members')
    expect(shown(el, 'tasks-list-members-error')).toBeNull()
  })

  it('a code answered after the route moved on paints nothing on the next dialog', async () => {
    const pending = deferred<Response>()
    h_.removeMemberReply.mockImplementation(() => pending.promise)
    const el = await openDialog()
    await click(rowOf(el, 'u3'), 'tasks-list-member-remove')
    await go('/task-lists/tl_2')
    pending.resolve(code422('CREATED_BY_IMMUTABLE'))
    await flush()
    await click(el, 'tasks-list-detail-members')
    expect(errorSpots(el)).toEqual({})
  })
})
