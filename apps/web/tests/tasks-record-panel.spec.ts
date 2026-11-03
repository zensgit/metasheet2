/**
 * 关联任务 / MetaRecordTasksPanel — the record drawer's list of the tasks dispatched from the record
 * (package 2), and the client method it reads through (`listRecordTasks`).
 *
 * What this file pins:
 *  1. Gating: nothing renders and nothing is requested with the tasks feature off, without tasks:read,
 *     or without a record, a sheet id or a client; the inspector mounts the section in its 详情 tab.
 *  2. Lazy: no request on record open; the list is read on first expand, with an explicit page size;
 *     collapse and expand again reuse it.
 *  3. Read states, each pinned by equality: loading, a list, empty, a 403 (its own sentence, no retry),
 *     a 404 or a degraded answer (not available), any other failure (a generic sentence and 重试).
 *  4. Rows: the title links to /tasks/:id (router or not), a status label and the due date; no person,
 *     no count of anything, and the 「还有更多」 notice counts the rows on screen.
 *  5. Refresh: a task change on this page (the 派发任务 dialog's signal after a create) re-reads an open
 *     panel and invalidates a collapsed one; a signal during a read is queued; a record switch resets;
 *     after unmount the signal reaches nothing.
 *  6. The client: the path, no retry key in the query, rows without an id dropped, `hasMore` strictly
 *     true, and a refusal's status kept on the thrown error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import MetaRecordTasksPanel from '../src/multitable/components/MetaRecordTasksPanel.vue'
import MetaRecordInspector from '../src/multitable/components/MetaRecordInspector.vue'
import { MultitableApiClient, type MetaRecordTaskItem, type MetaRecordTaskListPage } from '../src/multitable/api/client'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'
import { notifyTasksChanged } from '../src/tasks/tasksBadgeBus'
import { recordLabel, recordTasksHasMoreNotice } from '../src/multitable/utils/meta-record-labels'

const mocks = vi.hoisted(() => ({
  features: { tasks: true } as Record<string, boolean>,
  permissions: new Set<string>(['tasks:read']),
  focused: null as null | 'attendance' | 'plm',
}))

vi.mock('../src/stores/featureFlags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/stores/featureFlags')>()
  return {
    ...actual,
    useFeatureFlags: () => ({
      ...actual.useFeatureFlags(),
      hasFeature: (feature: string) => mocks.features[feature] === true,
      isAttendanceFocused: () => mocks.focused === 'attendance',
      isPlmWorkbenchFocused: () => mocks.focused === 'plm',
    }),
  }
})

vi.mock('../src/composables/useAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/composables/useAuth')>()
  return {
    ...actual,
    useAuth: () => ({
      ...actual.useAuth(),
      hasPermission: (code: string) => mocks.permissions.has(code),
    }),
  }
})

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const FIELDS = [{ id: 'fld_title', name: 'Title', type: 'string' }] as unknown as MetaField[]
const RECORD = { id: 'rec_1', version: 3, data: { fld_title: 'Alpha' } } as unknown as MetaRecord
const RECORD_2 = { id: 'rec_2', version: 1, data: { fld_title: 'Beta' } } as unknown as MetaRecord

function item(over: Partial<MetaRecordTaskItem> = {}): MetaRecordTaskItem {
  return {
    id: 'tsk_1',
    title: '备料复核',
    status: 'open',
    completionMode: 'any',
    dueAt: '2031-05-06T09:00:00.000Z',
    dueDate: '2031-05-06',
    createdAt: '2031-05-01T08:00:00.000Z',
    isMine: true,
    ...over,
  }
}

const ITEMS = [item(), item({ id: 'tsk_2', title: '复核二', status: 'done', dueDate: null, dueAt: null, isMine: false })]

function page(items: MetaRecordTaskItem[] = ITEMS, hasMore = false, degraded = false): MetaRecordTaskListPage {
  return { items, hasMore, degraded }
}

function refusal(status: number): Error {
  return Object.assign(new Error('server text that must not be shown'), { status, code: 'SOME_CODE' })
}

function fakeClient(answer: MetaRecordTaskListPage | Error = page()) {
  return {
    listRecordTasks: answer instanceof Error ? vi.fn().mockRejectedValue(answer) : vi.fn().mockResolvedValue(answer),
  }
}

const mountedApps: App[] = []

interface PanelOptions {
  client?: ReturnType<typeof fakeClient> | null
  sheetId?: string | undefined
  record?: MetaRecord | null
  withRouter?: boolean
}

function mountPanel(options: PanelOptions = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const client = options.client === undefined ? fakeClient() : options.client
  const state = reactive({ record: 'record' in options ? options.record : RECORD, refreshToken: 0 })
  const app = createApp({
    render() {
      return h(MetaRecordTasksPanel, {
        record: state.record as MetaRecord | null,
        sheetId: 'sheetId' in options ? options.sheetId : 'sheet_1',
        ...(client ? { apiClient: client as never } : {}),
        refreshToken: state.refreshToken,
      })
    },
  })
  if (options.withRouter) {
    app.use(createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'home', component: { template: '<div />' } },
        { path: '/tasks/:id', name: 'task-detail', component: { template: '<div />' } },
      ],
    }))
  }
  app.mount(container)
  mountedApps.push(app)
  return { container, app, client, state }
}

const section = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-test="record-tasks"]')
const toggle = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('[data-test="record-tasks-toggle"]')
const entries = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>('[data-test="record-tasks-entry"]'))
const text = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`[data-test="record-tasks-${id}"]`)?.textContent?.trim() ?? null

async function expand(root: HTMLElement) {
  toggle(root)!.click()
  await flushUi(6)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  mocks.features = { tasks: true }
  mocks.permissions = new Set(['tasks:read'])
  mocks.focused = null
  useLocale().setLocale('zh-CN')
})

afterEach(() => {
  while (mountedApps.length > 0) {
    try { mountedApps.pop()!.unmount() } catch { /* already unmounted */ }
  }
  document.body.innerHTML = ''
  useLocale().setLocale('en')
  vi.restoreAllMocks()
})

describe('MetaRecordTasksPanel — gating', () => {
  it('tasks off: nothing renders and nothing is requested, even when expanded state would be possible', async () => {
    mocks.features = { tasks: false }
    const { container, client } = mountPanel()
    await flushUi()
    expect(section(container)).toBeNull()
    notifyTasksChanged()
    await flushUi()
    expect(client!.listRecordTasks).not.toHaveBeenCalled()
  })

  it.each(['attendance', 'plm'] as const)('inside the %s-focused shell nothing renders and nothing is requested', async (focus) => {
    mocks.focused = focus
    const { container, client } = mountPanel()
    await flushUi()
    expect(section(container)).toBeNull()
    notifyTasksChanged()
    await flushUi()
    expect(client!.listRecordTasks).not.toHaveBeenCalled()
  })

  it('without tasks:read nothing renders', async () => {
    mocks.permissions = new Set(['tasks:write'])
    const { container, client } = mountPanel()
    await flushUi()
    expect(section(container)).toBeNull()
    expect(client!.listRecordTasks).not.toHaveBeenCalled()
  })

  it.each([
    ['no client', { client: null }],
    ['no sheet id', { sheetId: undefined }],
    ['no record', { record: null }],
  ] as const)('%s: nothing renders', async (_label, options) => {
    const { container } = mountPanel(options as PanelOptions)
    await flushUi()
    expect(section(container)).toBeNull()
  })
})

describe('MetaRecordTasksPanel — lazy read and states', () => {
  it('collapsed with no request on open; first expand reads one page with an explicit size; re-expand reuses it', async () => {
    const { container, client } = mountPanel()
    await flushUi()
    expect(section(container)).not.toBeNull()
    expect(toggle(container)!.getAttribute('aria-expanded')).toBe('false')
    // The title carries no count.
    expect(toggle(container)!.textContent!.replace(/[▸▾]/g, '').trim()).toBe('关联任务')
    expect(client!.listRecordTasks).not.toHaveBeenCalled()

    await expand(container)
    expect(client!.listRecordTasks).toHaveBeenCalledTimes(1)
    expect(client!.listRecordTasks).toHaveBeenCalledWith('sheet_1', 'rec_1', { limit: 20 })
    expect(entries(container)).toHaveLength(2)

    await expand(container)
    expect(toggle(container)!.getAttribute('aria-expanded')).toBe('false')
    await expand(container)
    expect(client!.listRecordTasks).toHaveBeenCalledTimes(1)
    expect(entries(container)).toHaveLength(2)
  })

  it('loading, then the list', async () => {
    const pending = deferred<MetaRecordTaskListPage>()
    const client = { listRecordTasks: vi.fn().mockReturnValue(pending.promise) }
    const { container } = mountPanel({ client })
    await flushUi()
    await expand(container)
    expect(text(container, 'loading')).toBe('正在加载关联任务…')
    expect(text(container, 'empty')).toBeNull()
    expect(text(container, 'has-more')).toBeNull()
    pending.resolve(page())
    await flushUi()
    expect(text(container, 'loading')).toBeNull()
    expect(entries(container)).toHaveLength(2)
  })

  it('empty: the sentence says only that there is nothing the viewer can open', async () => {
    const { container } = mountPanel({ client: fakeClient(page([])) })
    await flushUi()
    await expand(container)
    expect(text(container, 'empty')).toBe('没有你可以打开的关联任务。')
    expect(entries(container)).toHaveLength(0)
    expect(text(container, 'has-more')).toBeNull()
  })

  it('a generic failure: one sentence without the server text, and 重试 reads again', async () => {
    const client = { listRecordTasks: vi.fn().mockRejectedValueOnce(refusal(500)).mockResolvedValueOnce(page()) }
    const { container } = mountPanel({ client })
    await flushUi()
    await expand(container)
    expect(text(container, 'error')).toBe('加载关联任务失败。')
    expect(container.textContent).not.toContain('server text')
    expect(container.textContent).not.toContain('500')
    expect(text(container, 'retry')).toBe('重试')
    container.querySelector<HTMLButtonElement>('[data-test="record-tasks-retry"]')!.click()
    await flushUi(6)
    expect(client.listRecordTasks).toHaveBeenCalledTimes(2)
    expect(text(container, 'error')).toBeNull()
    expect(entries(container)).toHaveLength(2)
  })

  it('a network failure (no status) is the generic failure', async () => {
    const { container } = mountPanel({ client: fakeClient(new TypeError('Failed to fetch')) })
    await flushUi()
    await expand(container)
    expect(text(container, 'error')).toBe('加载关联任务失败。')
    expect(text(container, 'retry')).toBe('重试')
  })

  it('forbidden (403): its own sentence, no retry, and expanding again does not ask again', async () => {
    const { container, client } = mountPanel({ client: fakeClient(refusal(403)) })
    await flushUi()
    await expand(container)
    expect(text(container, 'error')).toBe('你没有查看此记录关联任务的权限。')
    expect(text(container, 'retry')).toBeNull()
    expect(container.textContent).not.toContain('server text')
    await expand(container)
    await expand(container)
    expect(client!.listRecordTasks).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a 404 (the route is not mounted, or the record is gone)', refusal(404)],
    ['a degraded answer (no org on the session)', page([], false, true)],
  ] as const)('%s: not available right now, no retry', async (_label, answer) => {
    const { container } = mountPanel({ client: fakeClient(answer) })
    await flushUi()
    await expand(container)
    expect(text(container, 'error')).toBe('关联任务暂不可用。')
    expect(text(container, 'retry')).toBeNull()
    expect(text(container, 'empty')).toBeNull()
  })

  it('English copy', async () => {
    useLocale().setLocale('en')
    const { container } = mountPanel({ client: fakeClient(page([])) })
    await flushUi()
    expect(toggle(container)!.textContent!.replace(/[▸▾]/g, '').trim()).toBe('Linked tasks')
    await expand(container)
    expect(text(container, 'empty')).toBe('No linked tasks that you can open.')
  })
})

describe('MetaRecordTasksPanel — rows', () => {
  it('without a router: the title is a plain link to /tasks/:id; status and due date; no person', async () => {
    const { container } = mountPanel()
    await flushUi()
    await expand(container)
    const [first, second] = entries(container)
    const link = first!.querySelector<HTMLAnchorElement>('[data-test="record-tasks-link"]')!
    expect(link.textContent!.trim()).toBe('备料复核')
    expect(link.getAttribute('href')).toBe('/tasks/tsk_1')
    expect(first!.querySelector('[data-test="record-tasks-status"]')!.textContent!.trim()).toBe('进行中')
    expect(first!.querySelector('[data-test="record-tasks-due"]')!.textContent!.trim()).toBe('截止 2031-05-06')
    expect(second!.querySelector('[data-test="record-tasks-status"]')!.textContent!.trim()).toBe('已完成')
    expect(second!.querySelector('[data-test="record-tasks-due"]')).toBeNull()
    expect(second!.querySelector<HTMLAnchorElement>('[data-test="record-tasks-link"]')!.getAttribute('href')).toBe('/tasks/tsk_2')
  })

  it('with a router: a RouterLink to /tasks/:id, the id encoded', async () => {
    const { container } = mountPanel({ withRouter: true, client: fakeClient(page([item({ id: 'tsk 9' })])) })
    await flushUi()
    await expand(container)
    const link = entries(container)[0]!.querySelector<HTMLAnchorElement>('[data-test="record-tasks-link"]')!
    expect(link.getAttribute('href')).toBe('/tasks/tsk%209')
  })

  it('a blank title reads as an untitled task, never as an empty link', async () => {
    const { container } = mountPanel({ client: fakeClient(page([item({ title: '' })])) })
    await flushUi()
    await expand(container)
    expect(entries(container)[0]!.querySelector('[data-test="record-tasks-link"]')!.textContent!.trim()).toBe('未命名任务')
  })

  it('hasMore: the notice counts the rows on screen, never a total', async () => {
    const { container } = mountPanel({ client: fakeClient(page(ITEMS, true)) })
    await flushUi()
    await expand(container)
    expect(text(container, 'has-more')).toBe(recordTasksHasMoreNotice(2, true))
    expect(text(container, 'has-more')).toBe('还有更多（仅显示最近 2 条）')
  })

  it('no count of tasks anywhere: the body holds the rows and nothing else', async () => {
    const { container } = mountPanel()
    await flushUi()
    await expand(container)
    const body = container.querySelector<HTMLElement>('[data-test="record-tasks-body"]')!
    const rest = Array.from(body.children).filter((child) => child.getAttribute('data-test') !== 'record-tasks-list')
    expect(rest).toEqual([])
  })
})

describe('MetaRecordTasksPanel — refresh', () => {
  it('a task change on this page (a dispatch) re-reads an open panel', async () => {
    const client = { listRecordTasks: vi.fn().mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([item()])) }
    const { container } = mountPanel({ client })
    await flushUi()
    await expand(container)
    expect(text(container, 'empty')).not.toBeNull()
    notifyTasksChanged()
    await flushUi(6)
    expect(client.listRecordTasks).toHaveBeenCalledTimes(2)
    expect(entries(container)).toHaveLength(1)
  })

  it('a task change while collapsed sends nothing, and the next expand reads again', async () => {
    const { container, client } = mountPanel()
    await flushUi()
    await expand(container)
    await expand(container)
    notifyTasksChanged()
    await flushUi()
    expect(client!.listRecordTasks).toHaveBeenCalledTimes(1)
    await expand(container)
    expect(client!.listRecordTasks).toHaveBeenCalledTimes(2)
  })

  it('a task change during a read is queued: the read that was in flight is replaced', async () => {
    const first = deferred<MetaRecordTaskListPage>()
    const client = {
      listRecordTasks: vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(page([item({ id: 'tsk_new' })])),
    }
    const { container } = mountPanel({ client })
    await flushUi()
    await expand(container)
    notifyTasksChanged()
    first.resolve(page([]))
    await flushUi(8)
    expect(client.listRecordTasks).toHaveBeenCalledTimes(2)
    expect(entries(container).map((entry) => entry.querySelector('[data-test="record-tasks-link"]')!.getAttribute('href'))).toEqual(['/tasks/tsk_new'])
  })

  it('refreshToken re-reads an open panel', async () => {
    const { container, client, state } = mountPanel()
    await flushUi()
    await expand(container)
    state.refreshToken += 1
    await flushUi(6)
    expect(client!.listRecordTasks).toHaveBeenCalledTimes(2)
  })

  it('a record switch collapses and drops the previous record’s rows', async () => {
    const { container, client, state } = mountPanel()
    await flushUi()
    await expand(container)
    expect(entries(container)).toHaveLength(2)
    state.record = RECORD_2
    await flushUi()
    expect(toggle(container)!.getAttribute('aria-expanded')).toBe('false')
    expect(entries(container)).toHaveLength(0)
    await expand(container)
    expect(client!.listRecordTasks).toHaveBeenLastCalledWith('sheet_1', 'rec_2', { limit: 20 })
  })

  it('after unmount a task change reaches nothing', async () => {
    const { container, client, app } = mountPanel()
    await flushUi()
    await expand(container)
    app.unmount()
    mountedApps.splice(mountedApps.indexOf(app), 1)
    notifyTasksChanged()
    await flushUi()
    expect(client!.listRecordTasks).toHaveBeenCalledTimes(1)
  })
})

describe('MetaRecordTasksPanel — in the inspector', () => {
  function mountInspector(client: Record<string, unknown>) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      render() {
        return h(MetaRecordInspector, {
          visible: true,
          record: RECORD,
          fields: FIELDS,
          canEdit: true,
          canComment: false,
          canDelete: false,
          sheetId: 'sheet_1',
          apiClient: client as never,
        })
      },
    })
    app.mount(container)
    mountedApps.push(app)
    return container
  }

  function inspectorClient() {
    return {
      ...fakeClient(),
      listRecordApprovals: vi.fn().mockResolvedValue({ submissions: [], hasMore: false }),
      getRecordSubscriptionStatus: vi.fn().mockResolvedValue({ subscribed: false, subscription: null }),
      listRecordHistory: vi.fn().mockResolvedValue([]),
    }
  }

  it('the 详情 tab holds the section after 审批; no request until it is expanded', async () => {
    const client = inspectorClient()
    const container = mountInspector(client)
    await flushUi()
    const tasks = section(container)
    expect(tasks).not.toBeNull()
    const approvals = container.querySelector('[data-test="record-approval"]')
    expect(approvals).not.toBeNull()
    expect(approvals!.compareDocumentPosition(tasks!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(client.listRecordTasks).not.toHaveBeenCalled()
    await expand(container)
    expect(client.listRecordTasks).toHaveBeenCalledWith('sheet_1', 'rec_1', { limit: 20 })
  })

  it('tasks off: the inspector shows no section', async () => {
    mocks.features = { tasks: false }
    const client = inspectorClient()
    const container = mountInspector(client)
    await flushUi()
    expect(section(container)).toBeNull()
    expect(client.listRecordTasks).not.toHaveBeenCalled()
  })
})

describe('MultitableApiClient.listRecordTasks', () => {
  // A fresh Response per call: a body can be read once.
  function respond(status: number, body: unknown) {
    return vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
  }

  it('reads the record route with the page size and no retry key; unwraps data; drops rows without an id', async () => {
    const fetchFn = respond(200, {
      ok: true,
      data: {
        items: [
          { id: 'tsk_1', title: 'T', status: 'open', completionMode: 'any', dueAt: null, dueDate: '2031-05-06', createdBy: 'usr_1', createdAt: '2031-05-01T08:00:00.000Z', isMine: true },
          { title: 'no id' },
          'junk',
          { id: 'tsk_2', title: 7, status: 'done', isMine: 'yes' },
        ],
        hasMore: true,
      },
    })
    const client = new MultitableApiClient({ fetchFn })
    const result = await client.listRecordTasks('sheet 1', 'rec/1', { limit: 20 })
    expect(fetchFn.mock.calls[0][0]).toBe('/api/multitable/sheets/sheet%201/records/rec%2F1/tasks?limit=20')
    expect(String(fetchFn.mock.calls[0][0])).not.toContain('dispatchKey')
    expect(result).toEqual({
      items: [
        { id: 'tsk_1', title: 'T', status: 'open', completionMode: 'any', dueAt: null, dueDate: '2031-05-06', createdAt: '2031-05-01T08:00:00.000Z', isMine: true },
        { id: 'tsk_2', title: '', status: 'done', completionMode: null, dueAt: null, dueDate: null, createdAt: null, isMine: false },
      ],
      hasMore: true,
      degraded: false,
    })
  })

  it('with a retry key, reads the same route with the key as a query parameter (the dispatch dialog\'s open-time read)', async () => {
    const fetchFn = respond(200, { ok: true, data: { items: [], hasMore: false } })
    const client = new MultitableApiClient({ fetchFn })
    const key = '0f8fad5b-d9cb-469f-a165-70867728950e'
    expect(await client.listRecordTasks('sheet 1', 'rec/1', { dispatchKey: key })).toEqual({ items: [], hasMore: false, degraded: false })
    expect(fetchFn.mock.calls[0][0]).toBe(`/api/multitable/sheets/sheet%201/records/rec%2F1/tasks?dispatchKey=${key}`)
    // An empty key is not sent.
    await client.listRecordTasks('s', 'r', { dispatchKey: '' })
    expect(String(fetchFn.mock.calls[1][0])).not.toContain('dispatchKey')
  })

  it('hasMore and degraded are strictly true', async () => {
    const client = new MultitableApiClient({ fetchFn: respond(200, { ok: true, data: { items: [], hasMore: 'true', degraded: true, reason: 'org_missing' } }) })
    expect(await client.listRecordTasks('s', 'r')).toEqual({ items: [], hasMore: false, degraded: true })
  })

  it('a 2xx whose body holds no items list throws instead of reading as an empty list', async () => {
    for (const body of ['<html>sign in</html>', { ok: true, data: { rows: [] } }, { ok: true, data: { items: 'none' } }, []]) {
      const fetchFn = vi.fn().mockResolvedValue(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 }))
      const client = new MultitableApiClient({ fetchFn })
      await expect(client.listRecordTasks('s', 'r')).rejects.toMatchObject({ status: 200 })
    }
  })

  it('a refusal throws with its status', async () => {
    const client = new MultitableApiClient({ fetchFn: respond(403, { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Insufficient permissions' } }) })
    await expect(client.listRecordTasks('s', 'r')).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' })
  })

  it('the panel labels exist in both languages', () => {
    for (const key of ['recordTasks.panelTitle', 'recordTasks.panelEmpty', 'recordTasks.panelForbidden', 'recordTasks.panelUnavailable', 'recordTasks.panelError'] as const) {
      expect(recordLabel(key, true)).not.toBe(recordLabel(key, false))
      expect(recordLabel(key, true)).toMatch(/[一-鿿]/)
      expect(recordLabel(key, false)).not.toMatch(/[一-鿿]/)
    }
  })
})
