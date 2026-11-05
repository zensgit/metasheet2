/**
 * 派发任务 from a multitable record (owner ruling R-45 step 1).
 *
 * The record drawer's kebab gains 派发任务, which creates a real task through the task create wrapper
 * (`POST /api/tasks`) with the record as its `source` and the record's retry key (`dispatchKey`); the
 * description is not written (package 2). This file mounts the REAL inspector, dialog, tasks API module
 * and retry key store; only `apiFetch` (the transport), the drawer's multitable client, the
 * feature-flag probe and the permission probe are replaced.
 *
 * What it pins:
 *  1. Gating: the entry is hidden with the tasks feature off, without tasks:write, inside either
 *     focused shell, and without the view id the source link needs; shown otherwise.
 *  2. Prefill: the title is the primary field's display text (empty when the value is empty);
 *     assignees come from the first native person field holding an active person (deactivated people
 *     are left out, but can be typed), the dispatcher can switch to another person field or none,
 *     and typed ids are validated, deduplicated and capped at 50.
 *  3. A due date is required: no request is sent without one.
 *  4. Request bodies: the create body carries exactly title / completionMode / due keys / assignees,
 *     `source` ({ sheetId, viewId, recordId }) and `dispatchKey`, with no other record value; with no
 *     assignee the key is omitted. Nothing else is written (no PATCH, no version read).
 *  5. In-flight guard: a second click, a close/reopen and a move to another record and back during
 *     the create send no second create; a result that lands while the dialog is closed is shown on
 *     the next open; a create sent before a move names the record it was sent from.
 *  6. Error mapping: each known failure reads as its own plain message, and the inactive-member one
 *     names nobody. A request with no readable answer is an unknown outcome, never a failure.
 *  7. Success: a link to /tasks/:id and a nudge to the top-bar badge; an answer that does not confirm
 *     the source link still reports the task as created, with a note.
 *  8. Identity: a dispatch is sent only under the page's binding, the signed-in user and org the
 *     page was set up under, where the org is both the one the requests carry and the one the task
 *     service uses (the token's org claim, read the way the server reads it; a token without one keeps
 *     the user-plus-header identity). The binding is changed for good the first time another identity is
 *     seen: before any multitable request of the page (the client's before-send hook), on a storage
 *     change from another tab, on a session switch in this tab, or by the dialog's own checks. A
 *     sign-in as someone else in another tab, a sign-out, an org change (stored hint or an explicit
 *     session org) or a sign-in in this tab makes the dialog send nothing more (no create, no
 *     description read or write), clear the draft and refuse until the page is reloaded. A reopen, a
 *     move to another record, or the bound identity coming back (A, then B, then A) does not offer a
 *     fresh form. Without a binding the drawer does not offer 派发任务. No await separates a check
 *     from its send. Dispatch state is kept per identity: another identity sees neither a pending
 *     note nor a created task, a session change in this tab drops the state of every other
 *     identity, and a run is settled only by the create that started it.
 *  9. Retry key and answers (package 2; cells W1–W13, A1, K2): the key is written per
 *     record when the first create is sent and counted before the request leaves; a 4xx settles one
 *     request; no answer / 5xx locks the form and 重试 resends the same bytes under the same key; a
 *     matched resend shows the earlier task (one read of it; not found → no link, 再派一项 under a
 *     fresh key); the key goes once a result is on screen, on 再派一项, and when the service refuses
 *     it; after a reload the open-time read under the key tells created / none / unknown; on open the
     caller's own tasks from the record are listed before the form (再派一项 shows it), and a list
     that cannot be read is said.
 * 10. Late answers and the retry key (cells R1–R6): an answer that lands after a session change
 *     changes neither the key nor the count of the entry the record holds then, nor the read under
 *     that key on the next open; the same account's own late 4xx still counts off its request, and a
 *     late 5xx or no answer still leaves the entry unresolved.
 * 11. A sent form keeps what was sent (packages 1b and 2 together; cells S1–S4): a dialog mounted
 *     while the create is out shows the sent form, with the names the picker gave, once the outcome
 *     is unknown; neither a picker
 *     confirm nor a people lookup that lands after the send changes the chips of the locked form,
 *     and 重试 resends the same bytes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import MetaRecordInspector from '../src/multitable/components/MetaRecordInspector.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'
import { onTasksChanged } from '../src/tasks/tasksBadgeBus'
import {
  beginDispatchRun,
  dispatchRunKey,
  readDispatchRun,
  resetDispatchRunsForTests,
  settleDispatchRun,
  type DispatchCreated,
} from '../src/tasks/recordTaskDispatchRuns'
import {
  DISPATCH_KEY_STORAGE_PREFIX,
  dispatchKeyStorageKey,
  dispatchKeys,
  resetDispatchKeysForTests,
} from '../src/tasks/recordTaskDispatchKey'
import { UuidUnavailableError } from '../src/utils/uuid'
import {
  NO_DISPATCH_IDENTITY,
  createDispatchBinding,
  isSameDispatchIdentity,
  readDispatchIdentity,
  type DispatchBinding,
} from '../src/tasks/recordTaskDispatchIdentity'
import { MultitableApiClient } from '../src/multitable/api/client'
import { onMultitableBeforeSend } from '../src/multitable/api/beforeSend'
import { useAuth } from '../src/composables/useAuth'
import { EXPLICIT_SESSION_ORG_KEY } from '../src/utils/explicitSessionOrg'
import { authHeaders } from '../src/utils/api'
import { canDispatchTasks, canSeeTasksEntry } from '../src/tasks/tasksAccess'
import {
  DISPATCH_ASSIGNEE_LIMIT,
  addAssignees,
  buildDispatchCreateInput,
  classifyDispatchFailure,
  isValidAssigneeId,
  personValueAssigneeIds,
  splitTypedAssigneeIds,
} from '../src/tasks/recordTaskDispatch'

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  features: { tasks: true } as Record<string, boolean>,
  permissions: new Set<string>(['tasks:read', 'tasks:write']),
  attendanceFocused: false,
  plmFocused: false,
}))

vi.mock('../src/utils/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}))

vi.mock('../src/stores/featureFlags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/stores/featureFlags')>()
  return {
    ...actual,
    useFeatureFlags: () => ({
      ...actual.useFeatureFlags(),
      hasFeature: (feature: string) => mocks.features[feature] === true,
      isAttendanceFocused: () => mocks.attendanceFocused,
      isPlmWorkbenchFocused: () => mocks.plmFocused,
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

// ---- fixtures ---------------------------------------------------------------------------------

const FIELDS = [
  { id: 'fld_title', name: 'Title', type: 'string' },
  { id: 'fld_owner', name: 'Owner', type: 'person' },
  { id: 'fld_notes', name: 'Notes', type: 'string' },
  { id: 'fld_reviewer', name: 'Reviewer', type: 'person' },
  { id: 'fld_legacy', name: 'Legacy person', type: 'link', property: { refKind: 'user' } },
] as unknown as MetaField[]

const RECORD = {
  id: 'rec_1',
  version: 3,
  data: {
    fld_title: 'Alpha',
    fld_owner: ['usr_a', 'usr_b', 'usr_a'],
    fld_notes: 'internal note that must stay in the record',
    fld_reviewer: ['usr_c'],
    fld_legacy: ['rec_person_1'],
  },
} as unknown as MetaRecord

function jsonResponse(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response
}

function taskBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tsk_9',
    title: 'Alpha',
    status: 'open',
    completionMode: 'all',
    createdBy: 'usr_me',
    dueAt: null,
    dueDate: '2031-05-06',
    dueTime: null,
    timeZone: 'UTC',
    assignees: [],
    canComplete: true,
    canReopen: false,
    ...over,
  }
}

type Route = (url: string, init: { method?: string; body?: string } | undefined) => Response | Promise<Response>

// Copy pinned by equality (meta-record-labels.ts). Each says only what the browser knows.
const ACCESS_NOTE_ZH = '是否通知负责人取决于系统的通知设置；负责人需要已开通任务功能，未开通的负责人无法被派发。'
const OUTCOME_UNKNOWN_ZH = '没有收到这次派发的结果：任务可能已创建，也可能没有。点「重试」会按原内容再提交一次；也可以先到任务页查看。'
const KEY_NOT_SAVED_ZH = '本页无法记住这次派发。如果刷新页面后再派发，可能会重复创建，请先到任务页确认。'
const REJECTED_ZH = '这次派发未被接受，没有创建任务。请检查填写内容后再试；如果仍然不行，请刷新页面。'
const SOURCE_NOT_READABLE_ZH = '这次没有派发：无法确认这条记录可以作为任务来源。请确认你仍能打开这条记录，再试一次。'
const NOT_SENT_ZH = '这次没有派发：浏览器无法生成派发标识。请刷新页面重试，或到任务页创建。'
const EARLIER_UNRESOLVED_ZH = '此前有一次派发没有收到结果，无法确认它是否已创建任务。请到任务页查看后再决定是否重新派发。'
const EARLIER_NO_TASK_ZH = '此前有一次派发没有收到结果，它没有留下你可以打开的任务，可以重新派发。'
const EARLIER_CREATED_ZH = '此前那次派发已创建了这个任务。'
const REUSED_HEADING_ZH = '任务此前已创建。'
const REUSED_NOTE_ZH = '这是此前那次派发创建的任务；这次提交没有另建任务，也没有改动它。如需按新内容另建一项，请点「再派一项」。'
const REUSED_NOT_OPENABLE_ZH = '此前那次派发创建的任务现在无法打开（可能已被删除）。如需重新派发，请点「再派一项」。'
const EXISTING_READ_FAILED_ZH = '无法读取这条记录已派发的任务。如果你之前从这条记录派发过，现在派发可能会再建一项。'
const SOURCE_NOT_LINKED_ZH = '任务已创建，但未能关联来源记录，可在任务描述里手动写明来源记录。'
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
/** The source every create from the default harness carries: ids only, never the base id. */
const SOURCE = { sheetId: 'sht_1', viewId: 'viw_1', recordId: 'rec_1' }

/** The people lookup's answer when a cell names none: every id asked for is an active member who
 *  can use tasks, so the prefill stays as it was. */
function everyoneUsable(url: string): Response {
  const raw = new URL(url, 'http://localhost').searchParams.get('ids') ?? ''
  const ids = raw.split(',').filter((id) => id.length > 0)
  return jsonResponse(200, { items: ids.map((id) => ({ id, name: '', detail: '', canUseTasks: true })), truncated: false })
}

/** Route the transport: the people lookup GET /api/tasks/people (package 1b), POST /api/tasks,
 *  PATCH /api/tasks/:id, GET /api/tasks/:id (the exact paths first, then the id patterns). The default
 *  create answer is the current service's: the source link is confirmed. */
function serveTasks(options: { create?: Route; patch?: Route; get?: Route; people?: Route } = {}) {
  mocks.apiFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET'
    if (url.startsWith('/api/tasks/people?') && method === 'GET') {
      return options.people ? options.people(url, init) : everyoneUsable(url)
    }
    if (url === '/api/tasks' && method === 'POST') {
      return options.create ? options.create(url, init) : jsonResponse(200, { id: 'tsk_9', version: 1, sourceLinked: true })
    }
    if (url.startsWith('/api/tasks/') && method === 'PATCH') {
      return options.patch ? options.patch(url, init) : jsonResponse(200, { id: 'tsk_9', version: 2 })
    }
    if (url.startsWith('/api/tasks/') && method === 'GET') {
      return options.get ? options.get(url, init) : jsonResponse(200, taskBody({ version: 1 }))
    }
    return jsonResponse(404, {})
  })
}

/** Every task request except the people lookup (package 1b), which the dialog sends on open. */
function taskSends(): unknown[][] {
  return mocks.apiFetch.mock.calls.filter(([url]) => String(url).startsWith('/api/tasks') && !String(url).startsWith('/api/tasks/people?'))
}

function peopleLookups(): string[] {
  return mocks.apiFetch.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('/api/tasks/people?'))
}

/** Every read of a task (GET /api/tasks/:id), without the people lookup (package 1b). */
function taskReads(): Array<[string, Record<string, unknown>]> {
  return tasksCalls('GET', '/api/tasks/').filter(([url]) => !url.startsWith('/api/tasks/people?'))
}

function tasksCalls(method: string, prefix: string): Array<[string, Record<string, unknown>]> {
  return mocks.apiFetch.mock.calls
    .filter(([url, init]) => (init?.method ?? 'GET') === method && String(url).startsWith(prefix))
    .map(([url, init]) => [String(url), init?.body ? JSON.parse(init.body) : {}])
}

function fakeApiClient() {
  return {
    getRecordSubscriptionStatus: vi.fn().mockResolvedValue({ subscribed: false, subscription: null }),
    subscribeRecord: vi.fn().mockResolvedValue({ subscribed: true, subscription: null }),
    unsubscribeRecord: vi.fn().mockResolvedValue({ subscribed: false, subscription: null }),
    listRecordHistory: vi.fn().mockResolvedValue([]),
    listRecordApprovals: vi.fn().mockResolvedValue({ submissions: [], hasMore: false }),
    // The record's tasks (the dialog's open-time read under a retry key, and the 关联任务 panel).
    listRecordTasks: vi.fn().mockResolvedValue({ items: [], hasMore: false, degraded: false }),
  }
}

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const mountedApps: App[] = []

interface HarnessOptions {
  record?: MetaRecord
  fields?: MetaField[]
  viewId?: string | undefined
  baseId?: string | undefined
  withRouter?: boolean
  /** The router history base (the app served under a sub-path). */
  routerBase?: string
  fieldPermissions?: Record<string, { visible: boolean; readOnly: boolean }>
  /** The page's dispatch binding, as the workbench passes it. By default one is made when the drawer
   *  is mounted (the page being set up); `null` passes none. */
  binding?: DispatchBinding | null
  /** The drawer's multitable client; a fresh fake by default. */
  client?: ReturnType<typeof fakeApiClient>
}

const bindings: DispatchBinding[] = []

/** A page set up now: its binding, disposed after the test. */
function pageBinding(): DispatchBinding {
  const binding = createDispatchBinding()
  bindings.push(binding)
  return binding
}

function mountInspector(options: HarnessOptions = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = { record: options.record ?? RECORD }
  const binding = options.binding === undefined ? pageBinding() : options.binding
  const client = options.client ?? fakeApiClient()
  const app = createApp({
    data: () => state,
    render() {
      return h(MetaRecordInspector as never, {
        visible: true,
        record: (this as unknown as typeof state).record,
        fields: options.fields ?? FIELDS,
        canEdit: true,
        canComment: false,
        canDelete: false,
        sheetId: 'sht_1',
        ...('viewId' in options ? (options.viewId === undefined ? {} : { viewId: options.viewId }) : { viewId: 'viw_1' }),
        ...('baseId' in options ? (options.baseId === undefined ? {} : { baseId: options.baseId }) : { baseId: 'bse_1' }),
        apiClient: client,
        personSummariesByField: {
          fld_owner: [
            { id: 'usr_a', display: 'Person A' },
            { id: 'usr_b', display: 'Person B', inactive: true },
          ],
          fld_reviewer: [{ id: 'usr_c', display: 'Person C' }],
        },
        ...(options.fieldPermissions ? { fieldPermissions: options.fieldPermissions } : {}),
        ...(binding ? { dispatchBinding: binding } : {}),
      })
    },
  })
  if (options.withRouter) {
    const router = createRouter({
      history: createMemoryHistory(options.routerBase),
      routes: [
        { path: '/', name: 'home', component: { template: '<div />' } },
        { path: '/multitable/:sheetId/:viewId', name: 'multitable', component: { template: '<div />' } },
        { path: '/tasks/:id', name: 'task-detail', component: { template: '<div />' } },
      ],
    })
    app.use(router)
  }
  const vm = app.mount(container) as unknown as typeof state
  mountedApps.push(app)
  return { container, app, vm, binding, client }
}

async function openKebab(root: HTMLElement) {
  const trigger = root.querySelector<HTMLButtonElement>('[data-testid="record-inspector-menu"]')
  expect(trigger).not.toBeNull()
  trigger!.focus()
  // The millisecond-stamp race the sibling drawer specs document: let ≥1ms of real time elapse.
  const start = Date.now()
  for (let i = 0; i < 50 && Date.now() <= start; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 1))
  trigger!.click()
  await flushUi()
  for (let i = 0; i < 10 && !document.querySelector('.mt-menu'); i += 1) await flushUi()
  expect(document.querySelector('.mt-menu')).not.toBeNull()
}

const dispatchItem = () => document.querySelector<HTMLButtonElement>('[data-testid="record-inspector-dispatch-task"]')
const dialog = () => document.querySelector<HTMLElement>('[data-testid="record-task-dispatch-dialog"]')
const q = <T extends Element = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="record-task-dispatch-${id}"]`)

async function openDialog(container: HTMLElement) {
  await openKebab(container)
  const item = dispatchItem()
  expect(item).not.toBeNull()
  item!.click()
  await flushUi(6)
  expect(dialog()).not.toBeNull()
}

function setInput(id: string, value: string) {
  const control = q<HTMLInputElement>(id)
  expect(control).not.toBeNull()
  control!.value = value
  control!.dispatchEvent(new Event('input'))
}

function setSelect(id: string, value: string) {
  const control = q<HTMLSelectElement>(id)
  expect(control).not.toBeNull()
  control!.value = value
  control!.dispatchEvent(new Event('change'))
}

function assigneeIds(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid="record-task-dispatch-assignees"] [data-assignee-id]'))
    .map((el) => el.dataset.assigneeId ?? '')
}

async function submit() {
  q<HTMLButtonElement>('submit')!.click()
  await flushUi(10)
}

/** A JWT-shaped token the app's own payload reader understands (header and signature are not read). */
function fakeToken(payload: Record<string, unknown>): string {
  return `h.${btoa(JSON.stringify(payload)).replace(/=+$/, '')}.s`
}
const TOKEN_A = fakeToken({ sub: 'usr_me' })

function signIn(token: string | null) {
  if (token === null) localStorage.removeItem('auth_token')
  else localStorage.setItem('auth_token', token)
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  signIn(TOKEN_A)
  resetDispatchKeysForTests()
  mocks.apiFetch.mockReset()
  mocks.features = { tasks: true }
  mocks.permissions = new Set(['tasks:read', 'tasks:write'])
  mocks.attendanceFocused = false
  mocks.plmFocused = false
  useLocale().setLocale('zh-CN')
})

function unmountAll() {
  while (mountedApps.length > 0) {
    try { mountedApps.pop()!.unmount() } catch { /* already unmounted */ }
  }
  document.body.innerHTML = ''
}

afterEach(() => {
  unmountAll()
  while (bindings.length > 0) bindings.pop()!.dispose()
  resetDispatchRunsForTests()
  resetDispatchKeysForTests()
  localStorage.clear()
  sessionStorage.clear()
  useLocale().setLocale('en')
})

// ---- the shared predicate ---------------------------------------------------------------------

describe('tasks entry predicate (tasks/tasksAccess.ts)', () => {
  const probe = (over: Partial<{ feature: boolean; perms: string[]; att: boolean; plm: boolean }> = {}) => ({
    hasFeature: () => over.feature ?? true,
    hasPermission: (code: string) => (over.perms ?? ['tasks:read', 'tasks:write']).includes(code),
    isAttendanceFocused: () => over.att ?? false,
    isPlmWorkbenchFocused: () => over.plm ?? false,
  })

  it('dispatch needs the feature, tasks:write and a non-focused shell; each one alone turns it off', () => {
    expect(canDispatchTasks(probe())).toBe(true)
    expect(canDispatchTasks(probe({ feature: false }))).toBe(false)
    expect(canDispatchTasks(probe({ perms: ['tasks:read'] }))).toBe(false)
    expect(canDispatchTasks(probe({ att: true }))).toBe(false)
    expect(canDispatchTasks(probe({ plm: true }))).toBe(false)
  })

  it('dispatch builds on the top-bar rule: a probe without tasks:read keeps it hidden as well', () => {
    // In the app tasks:write implies tasks:read; this synthetic probe only shows that the dispatch
    // rule reads the top-bar rule instead of restating part of it.
    expect(canDispatchTasks(probe({ perms: ['tasks:write'] }))).toBe(false)
  })

  it('the top-bar entry keeps its rule: the feature and tasks:read', () => {
    expect(canSeeTasksEntry(probe({ perms: ['tasks:read'] }))).toBe(true)
    expect(canSeeTasksEntry(probe({ feature: false }))).toBe(false)
    expect(canSeeTasksEntry(probe({ perms: [] }))).toBe(false)
  })
})

// ---- pure helpers -----------------------------------------------------------------------------

describe('dispatch helpers (tasks/recordTaskDispatch.ts)', () => {
  it('assignee ids follow the server member-id rule', () => {
    expect(isValidAssigneeId('usr_1')).toBe(true)
    expect(isValidAssigneeId('')).toBe(false)
    expect(isValidAssigneeId('.')).toBe(false)
    expect(isValidAssigneeId('..')).toBe(false)
    expect(isValidAssigneeId('has space')).toBe(false)
    expect(isValidAssigneeId('中文')).toBe(false)
    expect(isValidAssigneeId('x'.repeat(255))).toBe(true)
    expect(isValidAssigneeId('x'.repeat(256))).toBe(false)
  })

  it('a person value yields its valid ids once each, in order; dirt is dropped', () => {
    expect(personValueAssigneeIds(['usr_a', 'usr_b', 'usr_a'])).toEqual(['usr_a', 'usr_b'])
    expect(personValueAssigneeIds(['usr_a', 42, { id: 'x' }, '', null])).toEqual(['usr_a'])
    expect(personValueAssigneeIds('usr_solo')).toEqual(['usr_solo'])
    expect(personValueAssigneeIds(null)).toEqual([])
  })

  it('typed ids split on commas, the enumeration comma, semicolons and whitespace', () => {
    expect(splitTypedAssigneeIds(' usr_1, usr_2，usr_3、usr_4;usr_5 usr_6 ')).toEqual(['usr_1', 'usr_2', 'usr_3', 'usr_4', 'usr_5', 'usr_6'])
  })

  it('adding assignees dedupes and refuses invalid ids or more than 50', () => {
    expect(addAssignees(['a'], ['b', 'a', 'b'])).toEqual({ ok: true, ids: ['a', 'b'] })
    expect(addAssignees(['a'], ['bad id'])).toEqual({ ok: false, code: 'INVALID' })
    const fifty = Array.from({ length: DISPATCH_ASSIGNEE_LIMIT }, (_, i) => `u${i}`)
    expect(addAssignees(fifty, ['u0'])).toEqual({ ok: true, ids: fifty })
    expect(addAssignees(fifty, ['u_new'])).toEqual({ ok: false, code: 'LIMIT' })
  })

  it('the create body: required title and due date, assignees omitted when nobody is named', () => {
    const draft = { title: '  Alpha  ', assignees: [] as string[], completionMode: 'any' as const, dueDate: '2031-05-06', dueTime: '' }
    expect(buildDispatchCreateInput({ ...draft, title: '   ' }, 'UTC')).toEqual({ ok: false, code: 'TITLE_REQUIRED' })
    expect(buildDispatchCreateInput({ ...draft, title: 'a\u0000b' }, 'UTC')).toEqual({ ok: false, code: 'INVALID_TITLE' })
    expect(buildDispatchCreateInput({ ...draft, dueDate: '' }, 'UTC')).toEqual({ ok: false, code: 'DUE_DATE_REQUIRED' })
    expect(buildDispatchCreateInput(draft, '')).toEqual({ ok: false, code: 'ZONE_UNAVAILABLE' })
    expect(buildDispatchCreateInput({ ...draft, dueDate: '2031-02-30' }, 'UTC')).toEqual({ ok: false, code: 'INVALID_DATE' })
    expect(buildDispatchCreateInput(draft, 'UTC')).toEqual({
      ok: true,
      input: { title: 'Alpha', completionMode: 'any', dueDate: '2031-05-06', timeZone: 'UTC' },
    })
    expect(buildDispatchCreateInput({ ...draft, assignees: ['u1', 'u1', 'u2'], dueTime: '09:30' }, 'UTC')).toEqual({
      ok: true,
      input: { title: 'Alpha', completionMode: 'any', dueDate: '2031-05-06', dueTime: '09:30', timeZone: 'UTC', assignees: ['u1', 'u2'] },
    })
    const tooMany = Array.from({ length: DISPATCH_ASSIGNEE_LIMIT + 1 }, (_, i) => `u${i}`)
    expect(buildDispatchCreateInput({ ...draft, assignees: tooMany }, 'UTC')).toEqual({ ok: false, code: 'LIMIT' })
    expect(buildDispatchCreateInput({ ...draft, assignees: ['bad id'] }, 'UTC')).toEqual({ ok: false, code: 'INVALID_ASSIGNEES' })
  })

  it('a failed create reads as one message kind per known failure', () => {
    expect(classifyDispatchFailure({ kind: 'validation', code: 'INACTIVE_ORG_MEMBER' })).toBe('INACTIVE_ORG_MEMBER')
    expect(classifyDispatchFailure({ kind: 'validation', code: 'ASSIGNEE_TASK_ACCESS_REQUIRED' })).toBe('ASSIGNEE_TASK_ACCESS_REQUIRED')
    expect(classifyDispatchFailure({ kind: 'validation', code: 'INVALID_ASSIGNEES' })).toBe('INVALID_ASSIGNEES')
    expect(classifyDispatchFailure({ kind: 'validation', code: 'LIMIT' })).toBe('LIMIT')
    expect(classifyDispatchFailure({ kind: 'validation', code: 'TIME_ZONE_REQUIRED' })).toBe('INVALID_DATE')
    expect(classifyDispatchFailure({ kind: 'validation', code: 'INVALID_MODE' })).toBe('REJECTED')
    expect(classifyDispatchFailure({ kind: 'validation', code: 'INVALID_REMIND_AT' })).toBe('REJECTED')
    expect(classifyDispatchFailure({ kind: 'validation', code: 'INVALID_SOURCE' })).toBe('REJECTED')
    expect(classifyDispatchFailure({ kind: 'validation', code: 'INVALID_DISPATCH_KEY' })).toBe('INVALID_DISPATCH_KEY')
    expect(classifyDispatchFailure({ kind: 'validation', code: 'SOURCE_NOT_READABLE' })).toBe('SOURCE_NOT_READABLE')
    expect(classifyDispatchFailure({ kind: 'org_missing' })).toBe('ORG_MISSING')
    expect(classifyDispatchFailure({ kind: 'forbidden' })).toBe('FORBIDDEN')
    expect(classifyDispatchFailure({ kind: 'not_found' })).toBe('TASKS_UNAVAILABLE')
    expect(classifyDispatchFailure({ kind: 'invalid_title' })).toBe('INVALID_TITLE')
    // A 4xx says this request created nothing; anything without a readable answer is unknown.
    expect(classifyDispatchFailure({ kind: 'error', status: 422 })).toBe('REJECTED')
    expect(classifyDispatchFailure({ kind: 'error', status: 401 })).toBe('REJECTED')
    expect(classifyDispatchFailure({ kind: 'error', status: 409 })).toBe('REJECTED')
    expect(classifyDispatchFailure({ kind: 'error', status: 500 })).toBe('OUTCOME_UNKNOWN')
    expect(classifyDispatchFailure({ kind: 'error', status: 502 })).toBe('OUTCOME_UNKNOWN')
    expect(classifyDispatchFailure({ kind: 'error', status: 0 })).toBe('OUTCOME_UNKNOWN')
    expect(classifyDispatchFailure({ kind: 'error' })).toBe('OUTCOME_UNKNOWN')
    // A 200 whose body could not be read: the task may exist.
    expect(classifyDispatchFailure({ kind: 'error', status: 200 })).toBe('OUTCOME_UNKNOWN')
  })
})

// ---- the kebab entry --------------------------------------------------------------------------

describe('record drawer 派发任务 entry (gating)', () => {
  it('is shown with the tasks feature on, tasks:write and a platform shell', async () => {
    const { container } = mountInspector()
    await flushUi()
    await openKebab(container)
    expect(dispatchItem()?.textContent?.trim()).toBe('派发任务')
  })

  it('is hidden while the tasks feature is off, even with tasks:write', async () => {
    mocks.features = { tasks: false }
    const { container } = mountInspector()
    await flushUi()
    await openKebab(container)
    expect(dispatchItem()).toBeNull()
  })

  it('is hidden without tasks:write (tasks:read alone is not enough)', async () => {
    mocks.permissions = new Set(['tasks:read'])
    const { container } = mountInspector()
    await flushUi()
    await openKebab(container)
    expect(dispatchItem()).toBeNull()
  })

  it('is hidden inside the attendance-focused shell', async () => {
    mocks.attendanceFocused = true
    const { container } = mountInspector()
    await flushUi()
    await openKebab(container)
    expect(dispatchItem()).toBeNull()
  })

  it('is hidden inside the plm-workbench-focused shell', async () => {
    mocks.plmFocused = true
    const { container } = mountInspector()
    await flushUi()
    await openKebab(container)
    expect(dispatchItem()).toBeNull()
  })

  it('is hidden without a view id to build the source link', async () => {
    const { container } = mountInspector({ viewId: undefined })
    await flushUi()
    await openKebab(container)
    expect(dispatchItem()).toBeNull()
  })

  it('is hidden when an id is not one the task service takes as a source: none goes into a create body', async () => {
    const { container } = mountInspector({ record: { ...RECORD, id: 'rec/1' } as unknown as MetaRecord })
    await flushUi()
    await openKebab(container)
    expect(dispatchItem()).toBeNull()
    unmountAll()
    const again = mountInspector({ viewId: 'viw?1' })
    await flushUi()
    await openKebab(again.container)
    expect(dispatchItem()).toBeNull()
  })

  it('the workbench hands the inspector the view and base ids the source link is built from', async () => {
    const source = (await import('../src/multitable/views/MultitableWorkbench.vue?raw')).default as string
    const binding = source.slice(source.indexOf('<MetaRecordInspector'), source.indexOf('/>', source.indexOf('<MetaRecordInspector')))
    expect(binding).toContain(':view-id="workbench.activeViewId.value ?? undefined"')
    expect(binding).toContain(':base-id="activeBaseId || undefined"')
  })

  it('the workbench makes one binding before its first request, checks it before every multitable request, and hands it to the drawer', async () => {
    const source = (await import('../src/multitable/views/MultitableWorkbench.vue?raw')).default as string
    const binding = source.slice(source.indexOf('<MetaRecordInspector'), source.indexOf('/>', source.indexOf('<MetaRecordInspector')))
    expect(binding).toContain(':dispatch-binding="dispatchBinding"')
    // Top-level statements of the setup script, before the workbench (and so before any request).
    const made = source.search(/^const dispatchBinding = createDispatchBinding\(\)$/m)
    const hooked = source.search(/^const stopDispatchSendChecks = onMultitableBeforeSend\(\(\) => \{ dispatchBinding\.check\(\) \}\)$/m)
    expect(made).toBeGreaterThan(-1)
    expect(hooked).toBeGreaterThan(made)
    expect(hooked).toBeLessThan(source.indexOf('useMultitableWorkbench({'))
  })

  it('without a dispatch binding from the page, the drawer does not offer 派发任务', async () => {
    const { container } = mountInspector({ binding: null })
    await flushUi()
    await openKebab(container)
    expect(dispatchItem()).toBeNull()
  })
})

// ---- the dialog -------------------------------------------------------------------------------

describe('派发任务 dialog: prefill', () => {
  it('prefills the title from the primary field and assignees from the first person field holding anyone', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    expect(q<HTMLInputElement>('title')!.value).toBe('Alpha')
    expect(q<HTMLSelectElement>('person-field')!.value).toBe('fld_owner')
    // Display names come from the drawer's own person summaries.
    expect(assigneeIds()).toEqual(['usr_a'])
    const chips = document.querySelector('[data-testid="record-task-dispatch-assignees"]')!.textContent ?? ''
    expect(chips).toContain('Person A')
    // Only native person fields are offered (the legacy link-backed one stores record ids).
    const options = Array.from(q<HTMLSelectElement>('person-field')!.options).map((o) => o.value)
    expect(options).toEqual(['', 'fld_owner', 'fld_reviewer'])
    // The hint promises neither that assignees are notified nor that they are not: whether they are
    // depends on switches this page cannot read.
    expect(q('access-note')!.textContent!.trim()).toBe(ACCESS_NOTE_ZH)
    expect(q('access-note')!.textContent).not.toContain('不会通知')
    expect(q('access-note')!.textContent).not.toContain('会收到通知')
  })

  it('leaves a deactivated person out of the prefill, says so, and still lets the dispatcher type them', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    expect(assigneeIds()).toEqual(['usr_a'])
    expect(q('inactive-skipped')!.textContent).toContain('已停用的人员未带入')
    setInput('assignee-input', 'usr_b')
    q<HTMLButtonElement>('assignee-add')!.click()
    await flushUi()
    expect(assigneeIds()).toEqual(['usr_a', 'usr_b'])
    // A typed deactivated person is marked on their chip.
    const chip = document.querySelector('[data-assignee-id="usr_b"]')!.textContent ?? ''
    expect(chip).toContain('Person B')
    expect(chip).toContain('已停用')
    // A field with nobody deactivated says nothing.
    setSelect('person-field', 'fld_reviewer')
    await flushUi()
    expect(q('inactive-skipped')).toBeNull()
  })

  it('skips a first person field that holds nobody and prefills from the next one', async () => {
    serveTasks()
    const record = { ...RECORD, data: { ...RECORD.data, fld_owner: [] } } as unknown as MetaRecord
    const { container } = mountInspector({ record })
    await flushUi()
    await openDialog(container)
    expect(q<HTMLSelectElement>('person-field')!.value).toBe('fld_reviewer')
    expect(assigneeIds()).toEqual(['usr_c'])
  })

  it('caps a person field of more than 50 people at 50 and says so', async () => {
    serveTasks()
    const many = Array.from({ length: 60 }, (_, i) => `usr_m${i}`)
    const record = { ...RECORD, data: { ...RECORD.data, fld_owner: many } } as unknown as MetaRecord
    const { container } = mountInspector({ record })
    await flushUi()
    await openDialog(container)
    expect(assigneeIds()).toEqual(many.slice(0, DISPATCH_ASSIGNEE_LIMIT))
    expect(q('assignee-error')!.textContent).toContain('负责人最多 50 人')
  })

  it('lets the dispatcher switch to another person field or none', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setSelect('person-field', 'fld_reviewer')
    await flushUi()
    expect(assigneeIds()).toEqual(['usr_c'])
    setSelect('person-field', '')
    await flushUi()
    expect(assigneeIds()).toEqual([])
    expect(q('assignees-empty')).not.toBeNull()
  })

  it('does not offer a person field the viewer cannot see', async () => {
    serveTasks()
    const { container } = mountInspector({ fieldPermissions: { fld_owner: { visible: false, readOnly: true } } })
    await flushUi()
    await openDialog(container)
    const options = Array.from(q<HTMLSelectElement>('person-field')!.options).map((o) => o.value)
    expect(options).toEqual(['', 'fld_reviewer'])
    expect(assigneeIds()).toEqual(['usr_c'])
  })

  it('does not offer a person field hidden by its own property (the details tab hides it too)', async () => {
    serveTasks()
    const fields = FIELDS.map((field) => (field.id === 'fld_owner' ? { ...field, property: { hidden: true } } : field)) as MetaField[]
    const { container } = mountInspector({ fields })
    await flushUi()
    await openDialog(container)
    const options = Array.from(q<HTMLSelectElement>('person-field')!.options).map((o) => o.value)
    expect(options).toEqual(['', 'fld_reviewer'])
    expect(assigneeIds()).toEqual(['usr_c'])
  })

  it('starts with an empty title when the primary value is empty (no placeholder dash)', async () => {
    serveTasks()
    const record = { ...RECORD, data: { ...RECORD.data, fld_title: '' } } as unknown as MetaRecord
    const { container } = mountInspector({ record })
    await flushUi()
    await openDialog(container)
    expect(q<HTMLInputElement>('title')!.value).toBe('')
    await submit()
    expect(q('error')!.textContent).toContain('请填写标题')
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(0)
  })

  it('adds typed ids, deduplicated, and refuses an invalid id or a 51st assignee', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('assignee-input', 'usr_x, usr_a usr_b')
    q<HTMLButtonElement>('assignee-add')!.click()
    await flushUi()
    expect(assigneeIds()).toEqual(['usr_a', 'usr_x', 'usr_b'])
    setInput('assignee-input', 'usr_y, 用户')
    q<HTMLButtonElement>('assignee-add')!.click()
    await flushUi()
    expect(q('assignee-error')!.textContent).toContain('用户 ID 格式不正确')
    expect(assigneeIds()).toEqual(['usr_a', 'usr_x', 'usr_b'])
    setInput('assignee-input', Array.from({ length: 48 }, (_, i) => `u${i}`).join(','))
    q<HTMLButtonElement>('assignee-add')!.click()
    await flushUi()
    expect(q('assignee-error')!.textContent).toContain('负责人最多 50 人')
    expect(assigneeIds()).toHaveLength(3)
  })
})

describe('派发任务 dialog: due date and request bodies', () => {
  it('requires a due date: nothing is sent without one', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    await submit()
    expect(q('error')!.textContent).toContain('请选择截止日期')
    // Only the people lookup of the prefill (package 1b) has gone out; no create.
    expect(mocks.apiFetch.mock.calls.map(([url]) => String(url))).toEqual(peopleLookups())
  })

  it('sends exactly the confirmed title, assignees, mode, due keys, the source and a retry key; nothing else is written', async () => {
    serveTasks()
    // The viewer's zone is stubbed to a non-UTC name, so the cell tells the create form's zone helper
    // apart from a hard-coded 'UTC' on a UTC machine (CI) as well.
    const realResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions
    const zoneSpy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...realResolvedOptions.call(this), timeZone: 'Asia/Shanghai' }
    })
    try {
      const { container } = mountInspector()
      await flushUi()
      await openDialog(container)
      setInput('title', '  Alpha follow-up  ')
      setSelect('mode', 'any')
      setInput('assignee-input', 'usr_x')
      q<HTMLButtonElement>('assignee-add')!.click()
      setInput('due-date', '2031-05-06')
      await flushUi()
      setInput('due-time', '09:30')
      await submit()
    } finally {
      zoneSpy.mockRestore()
    }

    const creates = tasksCalls('POST', '/api/tasks')
    expect(creates).toHaveLength(1)
    expect(creates[0][1]).toEqual({
      title: 'Alpha follow-up',
      assignees: ['usr_a', 'usr_x'],
      completionMode: 'any',
      dueDate: '2031-05-06',
      dueTime: '09:30',
      timeZone: 'Asia/Shanghai',
      source: SOURCE,
      dispatchKey: expect.stringMatching(UUID),
    })
    // No other record value reaches the wire, nor the base id.
    expect(JSON.stringify(mocks.apiFetch.mock.calls)).not.toContain('internal note')
    expect(JSON.stringify(mocks.apiFetch.mock.calls)).not.toContain('bse_1')
    // The description is not written any more (2-D2), and nothing is read back.
    expect(tasksCalls('PATCH', '/api/tasks/')).toHaveLength(0)
    expect(taskReads()).toHaveLength(0)
  })

  it('omits assignees when nobody is named (the dispatcher becomes the assignee)', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setSelect('person-field', '')
    setInput('due-date', '2031-05-06')
    await submit()
    const creates = tasksCalls('POST', '/api/tasks')
    expect(creates).toHaveLength(1)
    expect(Object.keys(creates[0][1]).sort()).toEqual(['completionMode', 'dispatchKey', 'dueDate', 'source', 'timeZone', 'title'])
  })

  it('the source is the same with a router under a sub-path or without a known base: ids only, no null, no description', async () => {
    serveTasks()
    const { container } = mountInspector({ withRouter: true, routerBase: '/app/', baseId: undefined })
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await submit()
    const body = tasksCalls('POST', '/api/tasks')[0][1]
    expect(body.source).toEqual(SOURCE)
    // An explicit null is refused by the service, so a key is either sent or left out.
    expect(Object.values(body).includes(null)).toBe(false)
    expect('description' in body).toBe(false)
    expect(tasksCalls('PATCH', '/api/tasks/')).toHaveLength(0)
  })

  it('a create answer without a version sends nothing further: no version read, no description write', async () => {
    serveTasks({ create: () => jsonResponse(200, { id: 'tsk_9', sourceLinked: true }) })
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await submit()
    expect(q('success')).not.toBeNull()
    expect(taskReads()).toHaveLength(0)
    expect(tasksCalls('PATCH', '/api/tasks/')).toHaveLength(0)
  })
})

describe('派发任务 dialog: in-flight guard', () => {
  it('a second click and a close/reopen while the create is out send no second create', async () => {
    let release: (value: Response) => void = () => {}
    serveTasks({ create: () => new Promise<Response>((resolve) => { release = resolve }) })
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await flushUi()
    q<HTMLButtonElement>('submit')!.click()
    await flushUi()
    expect(q<HTMLButtonElement>('submit')!.disabled).toBe(true)
    q<HTMLButtonElement>('submit')!.click()
    await flushUi()
    // With the DOM attribute forced off, a click while the create is out still sends nothing. This
    // step exercises MtButton's own check of its `disabled` prop; it does not reach onSubmit.
    const forced = q<HTMLButtonElement>('submit')!
    forced.disabled = false
    forced.click()
    await flushUi()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(1)
    // Close and reopen while the request is still out.
    q<HTMLButtonElement>('cancel')!.click()
    await flushUi()
    expect(dialog()).toBeNull()
    await openDialog(container)
    expect(q<HTMLButtonElement>('submit')!.disabled).toBe(true)
    // The dialog that sent the create keeps the dispatcher's form across the reopen.
    expect(q<HTMLInputElement>('due-date')!.value).toBe('2031-05-06')
    q<HTMLButtonElement>('submit')!.click()
    await flushUi()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(1)
    release(jsonResponse(200, { id: 'tsk_9', version: 1 }))
    await flushUi(10)
    expect(q('success')).not.toBeNull()
    expect(q('submit')).toBeNull()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(1)
  })

  it('a create that lands after the dialog was closed is shown on the next open, not a blank form', async () => {
    let release: (value: Response) => void = () => {}
    serveTasks({ create: () => new Promise<Response>((resolve) => { release = resolve }) })
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await submit()
    q<HTMLButtonElement>('cancel')!.click()
    await flushUi()
    expect(dialog()).toBeNull()
    release(jsonResponse(200, { id: 'tsk_9', version: 1 }))
    await flushUi(10)
    await openDialog(container)
    expect(q<HTMLAnchorElement>('open-task')!.getAttribute('href')).toBe('/tasks/tsk_9')
    expect(q('submit')).toBeNull()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(1)
    // Once that result has been on screen, the next open starts a fresh form.
    q<HTMLButtonElement>('cancel')!.click()
    await flushUi()
    await openDialog(container)
    expect(q('success')).toBeNull()
    expect(q<HTMLButtonElement>('submit')!.disabled).toBe(false)
    expect(q<HTMLInputElement>('due-date')!.value).toBe('')
  })

  it('a create that fails after the dialog was closed shows its message on the next open, with the form kept', async () => {
    let release: (value: Response) => void = () => {}
    serveTasks({ create: () => new Promise<Response>((resolve) => { release = resolve }) })
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await submit()
    q<HTMLButtonElement>('cancel')!.click()
    await flushUi()
    release(jsonResponse(422, { error: { code: 'INACTIVE_ORG_MEMBER' } }))
    await flushUi(10)
    await openDialog(container)
    expect(q('error')!.textContent).toContain('有负责人不是当前组织的有效成员')
    expect(q<HTMLInputElement>('due-date')!.value).toBe('2031-05-06')
    expect(q<HTMLButtonElement>('submit')!.disabled).toBe(false)
    expect(q('success')).toBeNull()
  })

  it('moving to another record and back while the create is out sends no second create', async () => {
    let release: (value: Response) => void = () => {}
    serveTasks({ create: () => new Promise<Response>((resolve) => { release = resolve }) })
    const { container, vm } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await submit()
    q<HTMLButtonElement>('cancel')!.click()
    await flushUi()
    vm.record = { ...RECORD, id: 'rec_2' } as unknown as MetaRecord
    await flushUi(6)
    vm.record = RECORD
    await flushUi(6)
    await openDialog(container)
    // A dialog mounted since shows that the create is still out, with submit disabled.
    expect(q('pending')!.textContent).toContain('此记录的任务仍在派发中')
    expect(q<HTMLButtonElement>('submit')!.disabled).toBe(true)
    q<HTMLButtonElement>('submit')!.click()
    await flushUi()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(1)
    release(jsonResponse(200, { id: 'tsk_9', version: 1 }))
    await flushUi(10)
    expect(q<HTMLAnchorElement>('open-task')!.getAttribute('href')).toBe('/tasks/tsk_9')
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(1)
  })

  it('a create sent before a move to another record names the record it was sent from, and nothing is written after it lands', async () => {
    let release: (value: Response) => void = () => {}
    serveTasks({ create: () => new Promise<Response>((resolve) => { release = resolve }) })
    const { container, vm } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await submit()
    vm.record = { ...RECORD, id: 'rec_2' } as unknown as MetaRecord
    await flushUi(6)
    release(jsonResponse(200, { id: 'tsk_9', version: 1, sourceLinked: true }))
    await flushUi(10)
    expect(tasksCalls('POST', '/api/tasks')[0][1].source).toEqual(SOURCE)
    expect(tasksCalls('PATCH', '/api/tasks/')).toHaveLength(0)
    expect(readDispatchRun(dispatchRunKey(readDispatchIdentity(), 'sht_1', 'rec_1'))?.created?.id).toBe('tsk_9')
  })
})

describe('派发任务 dialog: error mapping', () => {
  const cases: Array<[string, () => Response, string]> = [
    ['INACTIVE_ORG_MEMBER', () => jsonResponse(422, { error: { code: 'INACTIVE_ORG_MEMBER' } }), '有负责人不是当前组织的有效成员'],
    ['ASSIGNEE_TASK_ACCESS_REQUIRED', () => jsonResponse(422, { error: { code: 'ASSIGNEE_TASK_ACCESS_REQUIRED' } }), '有负责人还不能使用任务功能，请管理员先为其开通任务权限。'],
    ['INVALID_ASSIGNEES', () => jsonResponse(422, { error: { code: 'INVALID_ASSIGNEES' } }), '用户 ID 格式不正确'],
    ['LIMIT', () => jsonResponse(422, { error: { code: 'LIMIT' } }), '负责人最多 50 人'],
    ['ORG_MISSING', () => jsonResponse(422, { error: { code: 'ORG_MISSING' } }), '请先选择组织'],
    ['403', () => jsonResponse(403, {}), '你没有创建任务的权限'],
    ['404 (tasks disabled)', () => jsonResponse(404, {}), '任务功能未开启'],
    ['SOURCE_NOT_READABLE', () => jsonResponse(422, { error: { code: 'SOURCE_NOT_READABLE' } }), SOURCE_NOT_READABLE_ZH],
    ['INVALID_SOURCE', () => jsonResponse(422, { error: { code: 'INVALID_SOURCE' } }), REJECTED_ZH],
    ['INVALID_DISPATCH_KEY', () => jsonResponse(422, { error: { code: 'INVALID_DISPATCH_KEY' } }), REJECTED_ZH],
    ['INVALID_MODE', () => jsonResponse(422, { error: { code: 'INVALID_MODE' } }), REJECTED_ZH],
    ['401', () => jsonResponse(401, {}), REJECTED_ZH],
    // No readable answer: never "failed" (the task may exist); the same button now reads 重试.
    ['500', () => jsonResponse(500, {}), OUTCOME_UNKNOWN_ZH],
  ]
  for (const [name, response, message] of cases) {
    it(`${name} reads as its own plain message and sends nothing further`, async () => {
      serveTasks({ create: response })
      const { container } = mountInspector()
      await flushUi()
      await openDialog(container)
      setInput('due-date', '2031-05-06')
      await submit()
      const text = q('error')!.textContent ?? ''
      expect(text).toContain(message)
      // The message names nobody: no assignee id or display name appears in it.
      for (const leak of ['usr_a', 'usr_b', 'Person A', 'Person B']) expect(text).not.toContain(leak)
      expect(tasksCalls('PATCH', '/api/tasks/')).toHaveLength(0)
      expect(q('success')).toBeNull()
      // The submit button is usable again for a corrected retry.
      expect(q<HTMLButtonElement>('submit')!.disabled).toBe(false)
    })
  }
})

describe('派发任务 dialog: success', () => {
  it('shows a link to the new task', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await submit()
    const link = q<HTMLAnchorElement>('open-task')
    expect(link).not.toBeNull()
    expect(link!.getAttribute('href')).toBe('/tasks/tsk_9')
    // The answer confirmed the link, and there was no earlier attempt: no note.
    expect(q('source-not-linked')).toBeNull()
    expect(q('earlier-unresolved')).toBeNull()
    expect(q('success')!.textContent).toContain('任务已创建。')
  })

  it('nudges the top-bar task badge after a create, and not after a failed one', async () => {
    let nudges = 0
    const stop = onTasksChanged(() => { nudges += 1 })
    try {
      serveTasks({ create: () => jsonResponse(500, {}) })
      const { container } = mountInspector()
      await flushUi()
      await openDialog(container)
      setInput('due-date', '2031-05-06')
      await submit()
      expect(q('error')).not.toBeNull()
      expect(nudges).toBe(0)
      serveTasks()
      await submit()
      expect(q('success')).not.toBeNull()
      expect(nudges).toBe(1)
    } finally {
      stop()
    }
  })

  it('A1: an answer that does not confirm the source link still reports the task as created, with a note, and writes nothing else', async () => {
    serveTasks({ create: () => jsonResponse(200, { id: 't1', version: 1 }) })
    const { container } = mountInspector({ withRouter: true })
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await submit()
    expect(q('success')).not.toBeNull()
    expect(q<HTMLAnchorElement>('open-task')!.getAttribute('href')).toBe('/tasks/t1')
    expect(q('source-not-linked')!.textContent!.trim()).toBe(SOURCE_NOT_LINKED_ZH)
    // A first attempt: nothing to say about an earlier one.
    expect(q('earlier-unresolved')).toBeNull()
    expect(q('error')).toBeNull()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(1)
    expect(tasksCalls('PATCH', '/api/tasks/')).toHaveLength(0)
  })

  it('moving to another record closes the dialog instead of carrying it over', async () => {
    serveTasks()
    const { container, vm } = mountInspector()
    await flushUi()
    await openDialog(container)
    vm.record = { ...RECORD, id: 'rec_2' } as unknown as MetaRecord
    await flushUi(6)
    expect(dialog()).toBeNull()
  })
})

// ---- package 2: the retry key and what each answer says ------------------------------------------

const SCOPE = { sheetId: 'sht_1', recordId: 'rec_1' }

/** One row of the record's task list, as the client returns it. */
function recordTask(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'tsk_7', title: 'Alpha follow-up', status: 'open', completionMode: 'all', dueAt: null, dueDate: null, createdAt: null, isMine: true, ...over }
}

const NO_ROWS = { items: [], hasMore: false, degraded: false }

/** A drawer client whose record-task reads answer by kind: `list` for the open-time list read, `keyed`
 *  for the read under a retry key (an Error rejects). The keyed request is matched first. */
function listingClient(list: unknown, keyed: unknown = NO_ROWS) {
  const client = fakeApiClient()
  client.listRecordTasks.mockImplementation(async (_sheetId: string, _recordId: string, options?: { dispatchKey?: string }) => {
    const answer = options?.dispatchKey ? keyed : list
    if (answer instanceof Error) throw answer
    return answer
  })
  return client
}

function existingTaskLinks(): HTMLAnchorElement[] {
  return Array.from(document.querySelectorAll<HTMLAnchorElement>('[data-testid="record-task-dispatch-existing-task"]'))
}

/** The stored entry of a record's retry key, parsed; `null` when there is none. */
function storedEntry(scope = SCOPE): Record<string, unknown> | null {
  const raw = sessionStorage.getItem(dispatchKeyStorageKey(scope))
  return raw === null ? null : JSON.parse(raw) as Record<string, unknown>
}

function storedEntryCount(): number {
  let count = 0
  for (let index = 0; index < sessionStorage.length; index += 1) {
    if (sessionStorage.key(index)?.startsWith(DISPATCH_KEY_STORAGE_PREFIX)) count += 1
  }
  return count
}

/** The create bodies as sent, byte for byte. */
function rawCreateBodies(): string[] {
  return mocks.apiFetch.mock.calls
    .filter(([url, init]) => String(url) === '/api/tasks' && init?.method === 'POST')
    .map(([, init]) => String(init.body))
}

function createKeys(): string[] {
  return tasksCalls('POST', '/api/tasks').map(([, body]) => String(body.dispatchKey))
}

/** A reload of the page: page memory goes (runs, held keys, bindings), the tab's sessionStorage stays. */
function reloadPage() {
  unmountAll()
  while (bindings.length > 0) bindings.pop()!.dispose()
  resetDispatchRunsForTests()
  resetDispatchKeysForTests()
}

async function openAndSubmit(container: HTMLElement) {
  await openDialog(container)
  setInput('due-date', '2031-05-06')
  await flushUi()
  await submit()
}

// The form's controls, the people-picking block's included (package 1b reads the same lock).
const LOCKED_CONTROLS = ['title', 'pick-people', 'person-field', 'assignee-input', 'assignee-add', 'mode', 'due-date']

describe('派发任务 dialog: the retry key (K2)', () => {
  it('(a) an open and a cancel write nothing; the first submit writes the entry before the request leaves and sends its key', async () => {
    const sent: { entry: Record<string, unknown> | null } = { entry: null }
    serveTasks({
      create: () => {
        sent.entry = storedEntry()
        return jsonResponse(200, { id: 'tsk_9', version: 1, sourceLinked: true })
      },
    })
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    q<HTMLButtonElement>('cancel')!.click()
    await flushUi()
    expect(storedEntryCount()).toBe(0)
    await openAndSubmit(container)
    expect(sent.entry).not.toBeNull()
    expect(sent.entry!.unsettled).toBe(1)
    expect(sent.entry!.key).toMatch(UUID)
    expect(createKeys()).toEqual([sent.entry!.key])
    // The stored value holds the key, its time and the count; no session data.
    expect(Object.keys(sent.entry!).sort()).toEqual(['at', 'key', 'unsettled', 'v'])
  })

  it('(c) once the result is on screen the entry goes, and the next dispatch from the record carries another key', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openAndSubmit(container)
    expect(q('success')).not.toBeNull()
    expect(storedEntry()).toBeNull()
    q<HTMLButtonElement>('cancel')!.click()
    await flushUi()
    await openAndSubmit(container)
    const keys = createKeys()
    expect(keys).toHaveLength(2)
    expect(keys[1]).toMatch(UUID)
    expect(keys[1]).not.toBe(keys[0])
  })

  it('(e) when no key can be made nothing is sent, no run is left and the form says so', async () => {
    serveTasks()
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => { throw new UuidUnavailableError() })
    try {
      const { container } = mountInspector()
      await flushUi()
      await openAndSubmit(container)
      expect(q('error')!.textContent!.trim()).toBe(NOT_SENT_ZH)
      expect(tasksCalls('POST', '/api/tasks')).toHaveLength(0)
      expect(readDispatchRun(dispatchRunKey(readDispatchIdentity(), 'sht_1', 'rec_1'))).toBeUndefined()
      expect(storedEntryCount()).toBe(0)
      // The button is not stuck: the run never started.
      expect(q<HTMLButtonElement>('submit')!.disabled).toBe(false)
    } finally {
      uuid.mockRestore()
    }
  })

  it('K5: a key the service refuses for this record is discarded; the next submit carries a fresh one', async () => {
    let answer: () => Response = () => jsonResponse(422, { error: { code: 'INVALID_DISPATCH_KEY' } })
    serveTasks({ create: () => answer() })
    const { container } = mountInspector()
    await flushUi()
    await openAndSubmit(container)
    expect(q('error')!.textContent!.trim()).toBe(REJECTED_ZH)
    expect(storedEntry()).toBeNull()
    answer = () => jsonResponse(200, { id: 'tsk_9', version: 1, sourceLinked: true })
    await submit()
    const keys = createKeys()
    expect(keys).toHaveLength(2)
    expect(keys[1]).not.toBe(keys[0])
  })
})

describe('派发任务 dialog: what each answer says', () => {
  it('W1: a 502 is an unknown outcome, never a failure; the form is locked and 重试 resends the same bytes under the same key', async () => {
    let answer: () => Response = () => jsonResponse(502, {})
    serveTasks({ create: () => answer() })
    const { container } = mountInspector()
    await flushUi()
    await openAndSubmit(container)
    const text = q('error')!.textContent!.trim()
    expect(text).toBe(OUTCOME_UNKNOWN_ZH)
    expect(text).not.toContain('失败')
    expect(text).not.toContain('没有创建任务')
    // Storage works: no line about it.
    expect(q('key-not-saved')).toBeNull()
    for (const id of LOCKED_CONTROLS) expect(q<HTMLInputElement>(id)!.disabled).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('[data-assignee-id="usr_a"] .meta-dispatch__chip-remove')!.disabled).toBe(true)
    expect(q('submit')!.textContent!.trim()).toBe('重试')
    expect(q<HTMLButtonElement>('submit')!.disabled).toBe(false)
    expect(storedEntry()!.unsettled).toBe(1)
    // Even an edit dispatched at a locked control cannot reach the retry.
    setInput('title', 'Changed meanwhile')
    answer = () => jsonResponse(200, { id: 'tsk_9', version: 1, sourceLinked: true })
    await submit()
    const bodies = rawCreateBodies()
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toBe(bodies[0])
    expect(JSON.parse(bodies[0]).dispatchKey).toMatch(UUID)
    expect(q('success')).not.toBeNull()
    expect(q('earlier-unresolved')).toBeNull()
    expect(storedEntry()).toBeNull()
  })

  it('W1: no answer at all (the transport throws) reads the same way, and the retry carries the same key', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await flushUi()
    mocks.apiFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await submit()
    expect(q('error')!.textContent!.trim()).toBe(OUTCOME_UNKNOWN_ZH)
    expect(q('submit')!.textContent!.trim()).toBe('重试')
    await submit()
    const bodies = rawCreateBodies()
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toBe(bodies[0])
    expect(q('success')).not.toBeNull()
  })

  it('W11: the primary button is the same element before and after an unknown outcome', async () => {
    serveTasks({ create: () => jsonResponse(502, {}) })
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await flushUi()
    const button = q<HTMLButtonElement>('submit')!
    button.focus()
    await submit()
    expect(q<HTMLButtonElement>('submit')).toBe(button)
    expect(button.textContent!.trim()).toBe('重试')
  })

  it('W2: a 4xx on the first send says only that this request created nothing; no line about an earlier attempt', async () => {
    serveTasks({ create: () => jsonResponse(422, { error: { code: 'INVALID_TITLE' } }) })
    const { container } = mountInspector()
    await flushUi()
    await openAndSubmit(container)
    expect(q('error')!.textContent!.trim()).toBe('标题包含无法保存的字符')
    expect(q('earlier-unresolved')).toBeNull()
    // The entry stays, settled: the next send reuses a key the service never stored.
    expect(storedEntry()!.unsettled).toBe(0)
    await submit()
    const keys = createKeys()
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(keys[0])
  })

  it('W12: after a first-send 4xx and a reload, the open is a plain form: nothing to resolve', async () => {
    serveTasks({ create: () => jsonResponse(422, { error: { code: 'INVALID_TITLE' } }) })
    const first = mountInspector()
    await flushUi()
    await openAndSubmit(first.container)
    reloadPage()
    const { container, client } = mountInspector()
    await flushUi()
    await openDialog(container)
    // No read under the key: only the record's list (the tasks already dispatched from it).
    expect(client.listRecordTasks).toHaveBeenCalledTimes(1)
    expect(client.listRecordTasks).toHaveBeenCalledWith('sht_1', 'rec_1', { limit: 100 })
    expect(q('earlier-unresolved')).toBeNull()
    expect(q('earlier-no-task')).toBeNull()
    expect(q('title')).not.toBeNull()
  })

  it('W3: a 4xx after a reload that follows an unknown outcome adds the line about the earlier attempt', async () => {
    serveTasks({ create: () => jsonResponse(502, {}) })
    const first = mountInspector()
    await flushUi()
    await openAndSubmit(first.container)
    const key = String(storedEntry()!.key)
    reloadPage()
    serveTasks({ create: () => jsonResponse(422, { error: { code: 'INVALID_TITLE' } }) })
    const { container, client } = mountInspector()
    await flushUi()
    await openDialog(container)
    // The open-time read under the key found nothing (G2): the form, with the line saying so.
    expect(client.listRecordTasks).toHaveBeenCalledWith('sht_1', 'rec_1', { dispatchKey: key })
    expect(q('earlier-no-task')!.textContent!.trim()).toBe(EARLIER_NO_TASK_ZH)
    setInput('due-date', '2031-05-06')
    await flushUi()
    await submit()
    expect(q('error')!.textContent!.trim()).toBe('标题包含无法保存的字符')
    expect(q('earlier-unresolved')!.textContent!.trim()).toBe(EARLIER_UNRESOLVED_ZH)
    // Two requests under the key, one answered with a 4xx.
    expect(storedEntry()!.unsettled).toBe(1)
    expect(createKeys()).toEqual([key, key])
  })

  it('W4: SOURCE_NOT_READABLE says nothing was dispatched this time, and adds the earlier-attempt line only on a resend', async () => {
    let answer: () => Response = () => jsonResponse(422, { error: { code: 'SOURCE_NOT_READABLE' } })
    serveTasks({ create: () => answer() })
    const { container } = mountInspector()
    await flushUi()
    await openAndSubmit(container)
    expect(q('error')!.textContent!.trim()).toBe(SOURCE_NOT_READABLE_ZH)
    expect(q('earlier-unresolved')).toBeNull()
    answer = () => jsonResponse(502, {})
    await submit()
    answer = () => jsonResponse(422, { error: { code: 'SOURCE_NOT_READABLE' } })
    await submit()
    expect(q('error')!.textContent!.trim()).toBe(SOURCE_NOT_READABLE_ZH)
    expect(q('earlier-unresolved')!.textContent!.trim()).toBe(EARLIER_UNRESOLVED_ZH)
  })

  it('W5: when the key cannot be written to storage, the unknown outcome says the page cannot remember the dispatch', async () => {
    serveTasks({ create: () => jsonResponse(502, {}) })
    // On the prototype: a Storage object takes an assigned property as an item, so the method cannot
    // be replaced on the instance itself. Only the tab's sessionStorage refuses.
    const realSetItem = Storage.prototype.setItem
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name: string, value: string) {
      if (this === sessionStorage) throw new Error('quota')
      return realSetItem.call(this, name, value)
    })
    try {
      const { container } = mountInspector()
      await flushUi()
      await openAndSubmit(container)
      expect(q('error')!.textContent!.trim()).toBe(OUTCOME_UNKNOWN_ZH)
      expect(q('key-not-saved')!.textContent!.trim()).toBe(KEY_NOT_SAVED_ZH)
      // The send still went out with the key held in memory.
      expect(createKeys()[0]).toMatch(UUID)
    } finally {
      write.mockRestore()
    }
  })

  it('W5: after an unknown outcome, another record and back: the same locked form, and 重试 sends the same bytes', async () => {
    let answer: () => Response = () => jsonResponse(502, {})
    serveTasks({ create: () => answer() })
    const { container, vm, client } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await flushUi()
    setSelect('mode', 'any')
    setInput('due-time', '09:30')
    await flushUi()
    await submit()
    q<HTMLButtonElement>('cancel')!.click()
    await flushUi()
    vm.record = { ...RECORD, id: 'rec_2' } as unknown as MetaRecord
    await flushUi(6)
    vm.record = RECORD
    await flushUi(6)
    await openDialog(container)
    expect(q('error')!.textContent!.trim()).toBe(OUTCOME_UNKNOWN_ZH)
    expect(q<HTMLInputElement>('title')!.value).toBe('Alpha')
    expect(q<HTMLInputElement>('due-date')!.value).toBe('2031-05-06')
    // The rest of what was sent, from the kept body (the remounted form starts from defaults).
    expect(q<HTMLInputElement>('due-time')!.value).toBe('09:30')
    expect(q<HTMLSelectElement>('mode')!.value).toBe('any')
    expect(assigneeIds()).toEqual(['usr_a'])
    for (const id of LOCKED_CONTROLS) expect(q<HTMLInputElement>(id)!.disabled).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('[data-assignee-id="usr_a"] .meta-dispatch__chip-remove')!.disabled).toBe(true)
    expect(q('submit')!.textContent!.trim()).toBe('重试')
    // No read on the second open: this page holds the body (the one call is the first open's list).
    expect(client.listRecordTasks).toHaveBeenCalledTimes(1)
    answer = () => jsonResponse(200, { id: 'tsk_9', version: 1, sourceLinked: true })
    await submit()
    const bodies = rawCreateBodies()
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toBe(bodies[0])
  })

  it('W13: a retry answered by a service that does not store the link says the earlier attempt is still unknown', async () => {
    let answer: () => Response = () => jsonResponse(502, {})
    serveTasks({ create: () => answer() })
    const { container } = mountInspector()
    await flushUi()
    await openAndSubmit(container)
    answer = () => jsonResponse(200, { id: 't1', version: 1 })
    await submit()
    expect(q('success')).not.toBeNull()
    expect(q('source-not-linked')!.textContent!.trim()).toBe(SOURCE_NOT_LINKED_ZH)
    expect(q('earlier-unresolved')!.textContent!.trim()).toBe(EARLIER_UNRESOLVED_ZH)
    expect(storedEntry()).toBeNull()
  })

  it('W6: a matched resend shows the earlier task under its own heading, after one read of it, also on a later open', async () => {
    let release: (value: Response) => void = () => {}
    serveTasks({ create: () => new Promise<Response>((resolve) => { release = resolve }) })
    let nudges = 0
    const stop = onTasksChanged(() => { nudges += 1 })
    try {
      const { container } = mountInspector()
      await flushUi()
      await openAndSubmit(container)
      q<HTMLButtonElement>('cancel')!.click()
      await flushUi()
      release(jsonResponse(200, { id: 'tsk_9', version: 1, reused: true, sourceLinked: true }))
      await flushUi(10)
      await openDialog(container)
      expect(q('success')).toBeNull()
      const panel = q('reused')!
      expect(panel.querySelector('[role="status"]')!.textContent).toContain(REUSED_HEADING_ZH)
      expect(q('reused-note')!.textContent!.trim()).toBe(REUSED_NOTE_ZH)
      expect(q<HTMLAnchorElement>('open-task')!.getAttribute('href')).toBe('/tasks/tsk_9')
      expect(q('another')!.textContent!.trim()).toBe('再派一项')
      expect(q('submit')).toBeNull()
      expect(tasksCalls('GET', '/api/tasks/tsk_9')).toHaveLength(1)
      // Nothing new was made.
      expect(nudges).toBe(0)
      expect(storedEntry()).toBeNull()
    } finally {
      stop()
    }
  })

  it('W7: a matched task that reads as not found gets no link; 再派一项 shows the form and the next create carries a fresh key', async () => {
    serveTasks({
      create: () => jsonResponse(200, { id: 'tsk_9', version: 1, reused: true, sourceLinked: true }),
      get: () => jsonResponse(404, {}),
    })
    const { container } = mountInspector()
    await flushUi()
    await openAndSubmit(container)
    expect(q('reused')!.textContent).toContain(REUSED_NOT_OPENABLE_ZH)
    expect(q('open-task')).toBeNull()
    // Kept until 再派一项.
    expect(storedEntry()).not.toBeNull()
    q<HTMLButtonElement>('another')!.click()
    await flushUi()
    expect(storedEntry()).toBeNull()
    expect(q('reused')).toBeNull()
    expect(q('title')).not.toBeNull()
    serveTasks()
    setInput('due-date', '2031-05-06')
    await flushUi()
    await submit()
    const keys = createKeys()
    expect(keys).toHaveLength(2)
    expect(keys[1]).not.toBe(keys[0])
    expect(q('success')).not.toBeNull()
  })

  it('W7: a refusal or an error on that read is not taken to mean the task is gone: it is linked', async () => {
    for (const status of [403, 500]) {
      serveTasks({
        create: () => jsonResponse(200, { id: 'tsk_9', version: 1, reused: true, sourceLinked: true }),
        get: () => jsonResponse(status, {}),
      })
      const { container } = mountInspector()
      await flushUi()
      await openAndSubmit(container)
      expect(tasksCalls('GET', '/api/tasks/tsk_9')).toHaveLength(1)
      expect(q('reused-note')).not.toBeNull()
      expect(q<HTMLAnchorElement>('open-task')!.getAttribute('href')).toBe('/tasks/tsk_9')
      reloadPage()
      sessionStorage.clear()
      mocks.apiFetch.mockReset()
    }
  })
})

describe('派发任务 dialog: the open after a reload, with an unresolved key', () => {
  async function unknownThenReload(): Promise<string> {
    serveTasks({ create: () => jsonResponse(502, {}) })
    const first = mountInspector()
    await flushUi()
    await openAndSubmit(first.container)
    const key = String(storedEntry()!.key)
    reloadPage()
    return key
  }

  it('W9 (G1): the caller\'s task under the key is shown as created by the earlier dispatch; the key goes', async () => {
    const key = await unknownThenReload()
    const client = fakeApiClient()
    client.listRecordTasks.mockResolvedValue({
      items: [{ id: 'tsk_7', title: 'Alpha', status: 'open', completionMode: 'all', dueAt: null, dueDate: null, createdAt: null, isMine: true }],
      hasMore: false,
      degraded: false,
    })
    serveTasks()
    const { container } = mountInspector({ client })
    await flushUi()
    await openDialog(container)
    expect(client.listRecordTasks).toHaveBeenCalledWith('sht_1', 'rec_1', { dispatchKey: key })
    expect(q('earlier-created')!.querySelector('[role="status"]')!.textContent).toContain(REUSED_HEADING_ZH)
    expect(q('earlier-created')!.textContent).toContain(EARLIER_CREATED_ZH)
    // Nothing was submitted on this page, so the resend note is not shown.
    expect(q('reused-note')).toBeNull()
    expect(q<HTMLAnchorElement>('open-task')!.getAttribute('href')).toBe('/tasks/tsk_7')
    expect(q('submit')).toBeNull()
    expect(storedEntry()).toBeNull()
    // Only the first page's create was sent.
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(1)
    q<HTMLButtonElement>('another')!.click()
    await flushUi()
    setInput('due-date', '2031-05-06')
    await flushUi()
    await submit()
    const keys = createKeys()
    expect(keys).toHaveLength(2)
    expect(keys[1]).not.toBe(key)
  })

  it('W9 (G2): none found: the form with a line saying so; the key is kept, so the next create resends it', async () => {
    const key = await unknownThenReload()
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    expect(q('earlier-no-task')!.textContent!.trim()).toBe(EARLIER_NO_TASK_ZH)
    expect(q('existing-read-failed')).toBeNull()
    setInput('due-date', '2031-05-06')
    await flushUi()
    await submit()
    // The first page's create and this one, under the same key.
    expect(createKeys()).toEqual([key, key])
    expect(q('success')).not.toBeNull()
  })

  it('W9 (G3): the read fails, or the service cannot tell the org: the form with both lines; the key is kept', async () => {
    for (const answer of [new Error('offline'), { items: [], hasMore: false, degraded: true }]) {
      const key = await unknownThenReload()
      const client = fakeApiClient()
      if (answer instanceof Error) client.listRecordTasks.mockRejectedValue(answer)
      else client.listRecordTasks.mockResolvedValue(answer)
      serveTasks()
      const { container } = mountInspector({ client })
      await flushUi()
      await openDialog(container)
      expect(q('earlier-unresolved')!.textContent!.trim()).toBe(EARLIER_UNRESOLVED_ZH)
      expect(q('existing-read-failed')!.textContent!.trim()).toBe(EXISTING_READ_FAILED_ZH)
      expect(q('earlier-no-task')).toBeNull()
      expect(q<HTMLButtonElement>('submit')!.disabled).toBe(false)
      expect(String(storedEntry()!.key)).toBe(key)
      reloadPage()
      sessionStorage.clear()
      mocks.apiFetch.mockReset()
    }
  })

  it('W9 (G2) with the caller\'s tasks listed: the line, the list instead of the form, and 再派一项 drops the kept key', async () => {
    const key = await unknownThenReload()
    const client = listingClient({ items: [recordTask()], hasMore: false, degraded: false })
    serveTasks()
    const { container } = mountInspector({ client })
    await flushUi()
    await openDialog(container)
    expect(client.listRecordTasks).toHaveBeenCalledWith('sht_1', 'rec_1', { dispatchKey: key })
    expect(client.listRecordTasks).toHaveBeenCalledWith('sht_1', 'rec_1', { limit: 100 })
    expect(q('existing')).not.toBeNull()
    expect(q('earlier-no-task')!.textContent!.trim()).toBe(EARLIER_NO_TASK_ZH)
    expect(existingTaskLinks().map((link) => link.getAttribute('href'))).toEqual(['/tasks/tsk_7'])
    expect(q('title')).toBeNull()
    expect(q('submit')).toBeNull()
    expect(String(storedEntry()!.key)).toBe(key)
    q<HTMLButtonElement>('another')!.click()
    await flushUi()
    expect(storedEntry()).toBeNull()
    expect(q('existing')).toBeNull()
    expect(q('earlier-no-task')).toBeNull()
    setInput('due-date', '2031-05-06')
    await flushUi()
    await submit()
    const keys = createKeys()
    expect(keys).toHaveLength(2)
    expect(keys[1]).not.toBe(key)
  })

  it('G1 needs no list read; G3 sends none either (its two lines already say the tasks cannot be read)', async () => {
    const key = await unknownThenReload()
    const found = listingClient(new Error('not used'), { items: [recordTask()], hasMore: false, degraded: false })
    serveTasks()
    const first = mountInspector({ client: found })
    await flushUi()
    await openDialog(first.container)
    expect(q('earlier-created')).not.toBeNull()
    expect(found.listRecordTasks).toHaveBeenCalledTimes(1)
    expect(found.listRecordTasks).toHaveBeenCalledWith('sht_1', 'rec_1', { dispatchKey: key })
    reloadPage()
    sessionStorage.clear()
    await unknownThenReload()
    const failing = listingClient(NO_ROWS, new Error('offline'))
    serveTasks()
    const second = mountInspector({ client: failing })
    await flushUi()
    await openDialog(second.container)
    expect(q('existing-read-failed')).not.toBeNull()
    expect(failing.listRecordTasks).toHaveBeenCalledTimes(1)
  })

  it('a reload after the stored key is gone (signed out and in, or another tab): the list still shows the task the attempt made', async () => {
    await unknownThenReload()
    // What the session sweep, or a tab that never held the key, leaves.
    sessionStorage.clear()
    const client = listingClient({ items: [recordTask({ id: 'tsk_5' })], hasMore: false, degraded: false })
    serveTasks()
    const { container } = mountInspector({ client })
    await flushUi()
    await openDialog(container)
    expect(q('existing')).not.toBeNull()
    expect(existingTaskLinks().map((link) => link.getAttribute('href'))).toEqual(['/tasks/tsk_5'])
    expect(q('title')).toBeNull()
    expect(q('submit')).toBeNull()
    // Only the first page's create: nothing more is sent from the list.
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(1)
  })

  it('W10: a sign-in that ends during the create: the entry was written before the send, and the dialog refuses', async () => {
    const sent: { entry: Record<string, unknown> | null } = { entry: null }
    serveTasks({
      create: () => {
        sent.entry = storedEntry()
        // What the transport's unauthorized handling does before the answer is read.
        localStorage.removeItem('auth_token')
        localStorage.removeItem('jwt')
        return jsonResponse(401, {})
      },
    })
    const { container } = mountInspector()
    await flushUi()
    await openAndSubmit(container)
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(1)
    expect(sent.entry!.unsettled).toBe(1)
    expect(q('identity-refused')!.textContent).toContain(REFUSAL_ZH)
    // The 4xx landed after the sign-out: the identity the request was sent under no longer holds, so
    // the entry is left as it was (still counted), and a later open reads under its key first.
    expect(storedEntry()!.unsettled).toBe(1)
  })
})

describe('派发任务 dialog: the tasks already dispatched from the record', () => {
  it('lists the caller\'s own tasks from the record instead of the form; 再派一项 shows the form, under a fresh key', async () => {
    const client = listingClient({
      items: [recordTask(), recordTask({ id: 'tsk_8', title: 'Assigned to me by someone else', isMine: false })],
      hasMore: false,
      degraded: false,
    })
    serveTasks()
    const { container } = mountInspector({ client })
    await flushUi()
    await openDialog(container)
    expect(client.listRecordTasks).toHaveBeenCalledTimes(1)
    expect(client.listRecordTasks).toHaveBeenCalledWith('sht_1', 'rec_1', { limit: 100 })
    expect(q('existing')!.textContent).toContain('已从此记录派发')
    const links = existingTaskLinks()
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/tasks/tsk_7'])
    expect(links[0].textContent!.trim()).toBe('Alpha follow-up')
    expect(q('title')).toBeNull()
    expect(q('submit')).toBeNull()
    expect(q('existing-read-failed')).toBeNull()
    expect(q('another')!.textContent!.trim()).toBe('再派一项')
    // Nothing is written by an open.
    expect(storedEntryCount()).toBe(0)
    q<HTMLButtonElement>('another')!.click()
    await flushUi()
    expect(q('existing')).toBeNull()
    expect(q<HTMLInputElement>('title')!.value).toBe('Alpha')
    setInput('due-date', '2031-05-06')
    await flushUi()
    await submit()
    const keys = createKeys()
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatch(UUID)
    expect(q('success')).not.toBeNull()
    // 再派一项 does not read the list again.
    expect(client.listRecordTasks).toHaveBeenCalledTimes(1)
  })

  it('W8: a list that cannot be read is said, before the form, and submit stays usable; a readable list without the caller\'s tasks adds nothing', async () => {
    const cases: Array<[unknown, boolean]> = [
      [new Error('offline'), true],
      [Object.assign(new Error('Insufficient permissions'), { status: 403 }), true],
      [{ items: [], hasMore: false, degraded: true }, true],
      [NO_ROWS, false],
      [{ items: [recordTask({ isMine: false })], hasMore: false, degraded: false }, false],
    ]
    for (const [answer, said] of cases) {
      const client = listingClient(answer)
      serveTasks()
      const { container } = mountInspector({ client })
      await flushUi()
      await openDialog(container)
      if (said) expect(q('existing-read-failed')!.textContent!.trim()).toBe(EXISTING_READ_FAILED_ZH)
      else expect(q('existing-read-failed')).toBeNull()
      // No retry key held: nothing about an earlier attempt.
      expect(q('earlier-unresolved')).toBeNull()
      expect(q('existing')).toBeNull()
      expect(q('title')).not.toBeNull()
      expect(q<HTMLButtonElement>('submit')!.disabled).toBe(false)
      reloadPage()
    }
  })

  it('submit stays disabled while the list read is out; the form is usable once it is answered', async () => {
    let answer: (value: unknown) => void = () => {}
    const client = fakeApiClient()
    client.listRecordTasks.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    serveTasks()
    const { container } = mountInspector({ client })
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await flushUi()
    expect(q<HTMLButtonElement>('submit')!.disabled).toBe(true)
    q<HTMLButtonElement>('submit')!.click()
    await flushUi()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(0)
    answer(NO_ROWS)
    await flushUi()
    expect(q<HTMLButtonElement>('submit')!.disabled).toBe(false)
    await submit()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(1)
  })

  it('a list answer that lands after the dialog closed is not shown on the next open; that open reads again', async () => {
    const answers: Array<(value: unknown) => void> = []
    const client = fakeApiClient()
    client.listRecordTasks.mockImplementation(() => new Promise((resolve) => { answers.push(resolve) }))
    serveTasks()
    const { container } = mountInspector({ client })
    await flushUi()
    await openDialog(container)
    q<HTMLButtonElement>('cancel')!.click()
    await flushUi()
    answers[0]({ items: [recordTask()], hasMore: false, degraded: false })
    await flushUi()
    await openDialog(container)
    expect(answers).toHaveLength(2)
    expect(q('existing')).toBeNull()
    answers[1](NO_ROWS)
    await flushUi()
    expect(q('existing')).toBeNull()
    expect(q<HTMLButtonElement>('submit')!.disabled).toBe(false)
  })
})

// ---- identity binding (R-45 step 1; owner review, 2026-10-15) -----------------------------------

const TOKEN_A_REFRESHED = fakeToken({ sub: 'usr_me', iat: 2 })
const TOKEN_B = fakeToken({ sub: 'usr_other' })
const REFUSAL_ZH = '本页已停用派发任务'
// The refusal is shown in every latch case, so it must be true in all of them: it may not say the
// account changed (the same user may have signed in again), that a dispatch was stopped (it may already
// have been created) or that one was created (that would tell whoever is signed in now).
// These lists ban the short fragments such claims are usually made of; they cannot rule out every
// possible false sentence, which is why one cell per language also pins the whole text.
const REFUSAL_FALSE_CLAIMS_ZH = ['账号已', '账号或组织已', '本次派发', '派发已', '已停止', '已中止', '已取消', '已创建']
const REFUSAL_FALSE_CLAIMS_EN = [
  'account changed', 'account has changed', 'account or organization has', 'this dispatch', 'dispatch was',
  'stopped', 'aborted', 'cancel', 'created',
]
const REFUSAL_FULL_ZH = '本页打开后，登录状态或所在组织有过变化（例如在其他标签页退出、重新登录或切换了账号，登录已过期，或在本页或其他标签页切换了组织）。为安全起见，本页已停用派发任务，表单内容已清空。请刷新页面后再派发。'
const REFUSAL_FULL_EN = 'Your sign-in or organization changed after this page was opened (for example, you signed out, signed in again or switched account in another tab, your session expired, or you switched organization here or in another tab). For safety, dispatching is turned off on this page and anything entered in the form was cleared. Reload the page to dispatch again.'

// The same user with an org claim (the org the task service uses). The stored org hint set next to
// them keeps the org header the same, so only the claim differs between these tokens.
const TOKEN_A_ORG1 = fakeToken({ sub: 'usr_me', tenantId: 'org_1' })
const TOKEN_A_ORG1_REFRESHED = fakeToken({ sub: 'usr_me', tenantId: 'org_1', iat: 2, sid: 'ses_2' })
const TOKEN_A_ORG2 = fakeToken({ sub: 'usr_me', tenantId: 'org_2' })
const ORG_HINT = 'org_1'

function setOrgHint(org: string) {
  localStorage.setItem('tenantId', org)
}

/** Another tab signs in: the shared storage changes and this tab is told nothing. */
function signInElsewhere(token: string | null) {
  signIn(token)
}

/** The same, plus the `storage` event a browser delivers to the other tabs. */
function signInElsewhereWithEvent(token: string | null) {
  signIn(token)
  window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token', newValue: token }))
}

function expectRefused() {
  const text = q('identity-refused')!.textContent ?? ''
  expect(text).toContain(REFUSAL_ZH)
  for (const claim of REFUSAL_FALSE_CLAIMS_ZH) expect(text).not.toContain(claim)
  // No form, nothing of the record left on screen, nothing to click.
  expect(q('title')).toBeNull()
  expect(q('assignees')).toBeNull()
  expect(q('submit')).toBeNull()
  expect(q('open-task')).toBeNull()
  expect(q('pending')).toBeNull()
  expect(dialog()!.textContent).not.toContain('Alpha')
}

describe('派发任务 identity (tasks/recordTaskDispatchIdentity.ts)', () => {
  it('is the user plus the org the requests carry; a token refresh for the same user and org keeps it', () => {
    const a = readDispatchIdentity()
    expect(a).not.toBe(NO_DISPATCH_IDENTITY)
    signIn(TOKEN_A_REFRESHED)
    expect(readDispatchIdentity()).toBe(a)
    signIn(TOKEN_B)
    expect(readDispatchIdentity()).not.toBe(a)
    signIn(TOKEN_A)
    localStorage.setItem('tenantId', 'org_2')
    expect(readDispatchIdentity()).not.toBe(a)
  })

  it('without a session there is no identity, and no identity matches anything, itself included', () => {
    signIn(null)
    expect(readDispatchIdentity()).toBe(NO_DISPATCH_IDENTITY)
    expect(isSameDispatchIdentity(NO_DISPATCH_IDENTITY, NO_DISPATCH_IDENTITY)).toBe(false)
    signIn(TOKEN_A)
    const a = readDispatchIdentity()
    expect(isSameDispatchIdentity(a, a)).toBe(true)
    expect(isSameDispatchIdentity(NO_DISPATCH_IDENTITY, a)).toBe(false)
  })

  it('also compares the org the task service uses: same user and org header with another org claim is another identity', () => {
    setOrgHint(ORG_HINT)
    signIn(TOKEN_A_ORG1)
    const a = readDispatchIdentity()
    const header = authHeaders()['x-tenant-id']
    expect(header).toBe(ORG_HINT)
    signIn(TOKEN_A_ORG2)
    expect(authHeaders()['x-tenant-id']).toBe(header)
    expect(readDispatchIdentity()).not.toBe(a)
    expect(isSameDispatchIdentity(a, readDispatchIdentity())).toBe(false)
  })

  it('the same org claim on a refreshed token is the same identity', () => {
    setOrgHint(ORG_HINT)
    signIn(TOKEN_A_ORG1)
    const a = readDispatchIdentity()
    signIn(TOKEN_A_ORG1_REFRESHED)
    expect(readDispatchIdentity()).toBe(a)
  })

  it('a token without an org claim keeps the identity it had: the user plus the org header', () => {
    setOrgHint(ORG_HINT)
    signIn(TOKEN_A)
    expect(readDispatchIdentity()).toBe(JSON.stringify(['sub:usr_me', ORG_HINT]))
    signIn(TOKEN_A_REFRESHED)
    expect(readDispatchIdentity()).toBe(JSON.stringify(['sub:usr_me', ORG_HINT]))
    // A claim that is not a non-empty string is no claim, as on the server.
    signIn(fakeToken({ sub: 'usr_me', tenantId: 7 }))
    expect(readDispatchIdentity()).toBe(JSON.stringify(['sub:usr_me', ORG_HINT]))
    signIn(fakeToken({ sub: 'usr_me', tenantId: '   ' }))
    expect(readDispatchIdentity()).toBe(JSON.stringify(['sub:usr_me', ORG_HINT]))
  })

  it('an org claim that appears or disappears is a change', () => {
    setOrgHint(ORG_HINT)
    signIn(TOKEN_A)
    const none = readDispatchIdentity()
    signIn(TOKEN_A_ORG1)
    const org1 = readDispatchIdentity()
    expect(org1).not.toBe(none)
    signIn(TOKEN_A)
    expect(readDispatchIdentity()).not.toBe(org1)
  })

  it('the org claim is read the way the server reads it: trimmed, and only tenantId (workspaceId is not read)', () => {
    setOrgHint(ORG_HINT)
    signIn(TOKEN_A_ORG1)
    const a = readDispatchIdentity()
    signIn(fakeToken({ sub: 'usr_me', tenantId: ' org_1 ' }))
    expect(readDispatchIdentity()).toBe(a)
    signIn(fakeToken({ sub: 'usr_me', tenantId: 'org_1', workspaceId: 'org_9' }))
    expect(readDispatchIdentity()).toBe(a)
  })

  it('a token that carries workspaceId and no tenantId has no org claim', () => {
    setOrgHint(ORG_HINT)
    signIn(TOKEN_A)
    const none = readDispatchIdentity()
    expect(none).toBe(JSON.stringify(['sub:usr_me', ORG_HINT]))
    signIn(fakeToken({ sub: 'usr_me', workspaceId: 'org_9' }))
    expect(readDispatchIdentity()).toBe(none)
    signIn(TOKEN_A_ORG1)
    const org1 = readDispatchIdentity()
    signIn(fakeToken({ sub: 'usr_me', workspaceId: 'org_1' }))
    expect(readDispatchIdentity()).toBe(none)
    expect(readDispatchIdentity()).not.toBe(org1)
  })

  it('the org claim of a token that cannot be read is no claim, and reading it never throws', () => {
    setOrgHint(ORG_HINT)
    signIn('not-a-jwt')
    expect(() => readDispatchIdentity()).not.toThrow()
    expect(readDispatchIdentity()).toBe(JSON.stringify(['token:not-a-jwt', ORG_HINT]))
    signIn('h.%%%.s')
    expect(readDispatchIdentity()).toBe(JSON.stringify(['token:h.%%%.s', ORG_HINT]))
  })
})

/** A new task as the dialog records it (package 2's run shape). */
function createdTask(id: string): DispatchCreated {
  return { id, reused: false, openable: true, sourceLinked: true, earlierUnresolved: false }
}

describe('派发任务 dialog: bound to the signed-in identity', () => {
  it('a sign-in as someone else in another tab: the submit sends nothing and the dialog refuses', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    // No assignee is named, so only the identity check can stop the create.
    setSelect('person-field', '')
    setInput('due-date', '2031-05-06')
    await flushUi()
    signInElsewhere(TOKEN_B)
    await submit()
    expect(taskSends()).toHaveLength(0)
    expectRefused()
  })

  it('a reopen after the change still refuses: no fresh form prefilled from the record on screen', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    // The drawer bound the record under A; B signs in elsewhere before the dialog is ever opened.
    signInElsewhere(TOKEN_B)
    await openDialog(container)
    expectRefused()
    q<HTMLButtonElement>('cancel')!.click()
    await flushUi()
    await openDialog(container)
    expectRefused()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(0)
  })

  it('an open form flips to the refusal as soon as another tab signs in (storage event), before any click', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    expect(q('title')).not.toBeNull()
    signInElsewhereWithEvent(TOKEN_B)
    await flushUi()
    expectRefused()
  })

  it('a sign-out (no token left) refuses with the sign-in-changed message and sends nothing', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    signInElsewhere(null)
    await submit()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(0)
    expectRefused()
  })

  it('a record bound with no session refuses with the sign-in message', async () => {
    signIn(null)
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    expect(q('identity-refused')!.textContent).toContain('无法确认当前登录账号')
    expect(q('submit')).toBeNull()
  })

  it('an org change through the stored org hint refuses, and sends nothing', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    localStorage.setItem('tenantId', 'org_2')
    await submit()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(0)
    expectRefused()
  })

  it('an explicitly selected session org (same user) refuses, and sends nothing', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    const exp = Math.floor(Date.now() / 1000) + 3600
    const switched = fakeToken({ sub: 'usr_me', userId: 'usr_me', tenantId: 'org_2', exp })
    localStorage.setItem('auth_token', switched)
    localStorage.setItem('jwt', switched)
    localStorage.setItem(EXPLICIT_SESSION_ORG_KEY, JSON.stringify({
      state: 'ready', token: switched, actor: 'usr_me', tenantId: 'org_2', exp, epoch: 'epoch_1',
    }))
    await submit()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(0)
    expectRefused()
  })

  it('a sign-in in this tab (useAuth) flips an open form to the refusal before any click', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    expect(q('title')).not.toBeNull()
    useAuth().setToken(TOKEN_B)
    await flushUi()
    expectRefused()
  })

  it('a change while the create is out: no description write under the new identity, and no task link shown to it', async () => {
    let release: (value: Response) => void = () => {}
    serveTasks({ create: () => new Promise<Response>((resolve) => { release = resolve }) })
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await submit()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(1)
    signInElsewhere(TOKEN_B)
    release(jsonResponse(200, { id: 'tsk_9', version: 1 }))
    await flushUi(10)
    expect(tasksCalls('PATCH', '/api/tasks/')).toHaveLength(0)
    expectRefused()
  })

  it('a change while the create is out, with no version in its answer: not even the version read is sent', async () => {
    let release: (value: Response) => void = () => {}
    serveTasks({ create: () => new Promise<Response>((resolve) => { release = resolve }) })
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await submit()
    signInElsewhere(TOKEN_B)
    release(jsonResponse(200, { id: 'tsk_9' }))
    await flushUi(10)
    expect(tasksCalls('GET', '/api/tasks/tsk_9')).toHaveLength(0)
    expect(tasksCalls('PATCH', '/api/tasks/')).toHaveLength(0)
    expectRefused()
  })

  it('a change while the create is out, answered as a matched resend: the read of that task is not sent', async () => {
    let release: (value: Response) => void = () => {}
    serveTasks({ create: () => new Promise<Response>((resolve) => { release = resolve }) })
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await submit()
    signInElsewhere(TOKEN_B)
    release(jsonResponse(200, { id: 'tsk_9', version: 1, reused: true, sourceLinked: true }))
    await flushUi(10)
    expect(taskReads()).toHaveLength(0)
    expectRefused()
  })

  it('after a change elsewhere, moving to another record and back still refuses: the page binding is changed for good', async () => {
    serveTasks()
    const { container, vm } = mountInspector()
    await flushUi()
    signInElsewhere(TOKEN_B)
    vm.record = { ...RECORD, id: 'rec_2' } as unknown as MetaRecord
    await flushUi(6)
    vm.record = RECORD
    await flushUi(6)
    await openDialog(container)
    expectRefused()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(0)
  })

  it('the drawer uses the binding the page made, not its own later read', async () => {
    serveTasks()
    const page = pageBinding()
    signInElsewhere(TOKEN_B)
    // The drawer is set up after the change, but the page was set up under A.
    const { container } = mountInspector({ binding: page })
    await flushUi()
    await openDialog(container)
    expectRefused()
  })

  it('dispatch state is per identity: a page loaded under another identity sees a fresh form, not the pending note; the first sees its task', async () => {
    let release: (value: Response) => void = () => {}
    serveTasks({ create: () => new Promise<Response>((resolve) => { release = resolve }) })
    const first = mountInspector()
    await flushUi()
    await openDialog(first.container)
    setInput('due-date', '2031-05-06')
    await submit()
    q<HTMLButtonElement>('cancel')!.click()
    await flushUi()
    unmountAll()
    // B signs in elsewhere and the page is loaded again under B.
    signInElsewhere(TOKEN_B)
    const second = mountInspector()
    await flushUi()
    await openDialog(second.container)
    expect(q('pending')).toBeNull()
    expect(q('identity-refused')).toBeNull()
    expect(q<HTMLButtonElement>('submit')!.disabled).toBe(false)
    q<HTMLButtonElement>('cancel')!.click()
    await flushUi()
    // A's create lands; B still sees nothing of it.
    release(jsonResponse(200, { id: 'tsk_9', version: 1 }))
    await flushUi(10)
    await openDialog(second.container)
    expect(q('open-task')).toBeNull()
    expect(q('success')).toBeNull()
    q<HTMLButtonElement>('cancel')!.click()
    await flushUi()
    unmountAll()
    // Back to A (another tab again), page loaded under A: A's task is shown.
    signInElsewhere(TOKEN_A)
    const third = mountInspector()
    await flushUi()
    await openDialog(third.container)
    expect(q<HTMLAnchorElement>('open-task')!.getAttribute('href')).toBe('/tasks/tsk_9')
  })

  it('a session change in this tab drops the dispatch state of every other identity, in flight or settled', async () => {
    const a = readDispatchIdentity()
    const settledKey = dispatchRunKey(a, 'sht_1', 'rec_1')
    const outKey = dispatchRunKey(a, 'sht_1', 'rec_2')
    const settledTicket = beginDispatchRun(settledKey, a)
    expect(settledTicket).not.toBeNull()
    settleDispatchRun(settledKey, settledTicket!, { created: createdTask('tsk_9') })
    const outTicket = beginDispatchRun(outKey, a)
    expect(outTicket).not.toBeNull()
    useAuth().setToken(TOKEN_B)
    await flushUi()
    expect(readDispatchRun(settledKey)).toBeUndefined()
    expect(readDispatchRun(outKey)).toBeUndefined()
    // The create that was out settles into nothing.
    settleDispatchRun(outKey, outTicket!, { created: createdTask('tsk_10') })
    expect(readDispatchRun(outKey)).toBeUndefined()
  })

  it('a run is settled only by the create that started it: an older answer cannot overwrite a newer run', async () => {
    const a = readDispatchIdentity()
    const key = dispatchRunKey(a, 'sht_1', 'rec_1')
    const first = beginDispatchRun(key, a)
    expect(first).not.toBeNull()
    // The session is cleared and the same user signs in again in this tab: the first run is dropped.
    useAuth().clearToken()
    await flushUi()
    useAuth().setToken(TOKEN_A)
    await flushUi()
    expect(readDispatchRun(key)).toBeUndefined()
    const second = beginDispatchRun(key, a)
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
    // The first create answers: nothing changes; the second run is still out.
    settleDispatchRun(key, first!, { created: createdTask('tsk_old') })
    expect(readDispatchRun(key)?.inFlight).toBe(true)
    expect(readDispatchRun(key)?.created).toBeNull()
    settleDispatchRun(key, second!, { created: createdTask('tsk_new') })
    expect(readDispatchRun(key)?.created?.id).toBe('tsk_new')
  })

  it('a same-user token refresh keeps the binding and the form', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    signInElsewhereWithEvent(TOKEN_A_REFRESHED)
    await flushUi()
    expect(q('identity-refused')).toBeNull()
    await submit()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(1)
    expect(q('success')).not.toBeNull()
  })

  it('a change after the task was created: the refusal replaces the created panel and does not say the dispatch was stopped', async () => {
    serveTasks()
    const { container } = mountInspector({ withRouter: true })
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await submit()
    expect(q('success')).not.toBeNull()
    expect(q('open-task')).not.toBeNull()
    signInElsewhereWithEvent(TOKEN_B)
    await flushUi()
    // expectRefused also checks the text claims no stop and no creation, and that there is no link.
    expectRefused()
    expect(q('identity-refused')!.textContent!.trim()).toBe(REFUSAL_FULL_ZH)
    expect(q('success')).toBeNull()
    expect(dialog()!.textContent).not.toContain('任务已创建')
  })

  it('a sign-out and sign-in again as the same user: the refusal does not say the account changed', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    signInElsewhereWithEvent(null)
    await flushUi()
    signInElsewhereWithEvent(TOKEN_A)
    await flushUi()
    expectRefused()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(0)
  })

  it('the English refusal is shown in English and makes none of the false claims', async () => {
    useLocale().setLocale('en')
    serveTasks()
    const { container } = mountInspector({ withRouter: true })
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await submit()
    expect(q('success')).not.toBeNull()
    signInElsewhereWithEvent(TOKEN_B)
    await flushUi()
    const text = q('identity-refused')!.textContent ?? ''
    expect(text).toContain('dispatching is turned off on this page')
    expect(text).toContain('form was cleared')
    expect(text).toContain('Reload the page')
    for (const claim of REFUSAL_FALSE_CLAIMS_EN) expect(text).not.toContain(claim)
    expect(text.trim()).toBe(REFUSAL_FULL_EN)
    expect(q('open-task')).toBeNull()
  })

  it('an explicitly selected session org that expires while the page is open refuses, and sends nothing', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60
    const explicit = fakeToken({ sub: 'usr_me', userId: 'usr_me', tenantId: 'org_2', exp })
    localStorage.setItem('auth_token', explicit)
    localStorage.setItem('jwt', explicit)
    localStorage.setItem(EXPLICIT_SESSION_ORG_KEY, JSON.stringify({
      state: 'ready', token: explicit, actor: 'usr_me', tenantId: 'org_2', exp, epoch: 'epoch_1',
    }))
    serveTasks()
    const { container, binding } = mountInspector()
    await flushUi()
    expect(binding!.identity).not.toBe(NO_DISPATCH_IDENTITY)
    const now = vi.spyOn(Date, 'now').mockReturnValue((exp + 60) * 1000)
    try {
      await openDialog(container)
      expectRefused()
      expect(tasksCalls('POST', '/api/tasks')).toHaveLength(0)
    } finally {
      now.mockRestore()
    }
  })
})

describe('派发任务 dialog: bound to the org the task service uses as well', () => {
  /** A page set up under the user with org claim `token`, the org header held by the stored hint. */
  async function openUnder(token: string) {
    setOrgHint(ORG_HINT)
    signIn(token)
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setSelect('person-field', '')
    setInput('due-date', '2031-05-06')
    await flushUi()
    return container
  }

  it('same user and org header, another org claim read at submit: nothing is sent and the dialog refuses', async () => {
    await openUnder(TOKEN_A_ORG1)
    const header = authHeaders()['x-tenant-id']
    signInElsewhere(TOKEN_A_ORG2)
    expect(authHeaders()['x-tenant-id']).toBe(header)
    await submit()
    expect(taskSends()).toHaveLength(0)
    expectRefused()
  })

  it('same user and org header, another org claim from another tab (storage event): the form flips to the refusal before any click', async () => {
    await openUnder(TOKEN_A_ORG1)
    expect(q('title')).not.toBeNull()
    signInElsewhereWithEvent(TOKEN_A_ORG2)
    await flushUi()
    expectRefused()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(0)
  })

  it('another org claim seen by a multitable read changes the binding for good, even after the claim comes back', async () => {
    setOrgHint(ORG_HINT)
    signIn(TOKEN_A_ORG1)
    serveTasks()
    const page = pageBinding()
    const stop = onMultitableBeforeSend(() => { page.check() })
    const client = new MultitableApiClient({
      fetchFn: async () => jsonResponse(200, { fields: [], rows: [], view: null }) as unknown as Response,
    })
    signInElsewhere(TOKEN_A_ORG2)
    await client.loadView({ sheetId: 'sht_1', viewId: 'viw_1' }).catch(() => undefined)
    signInElsewhere(TOKEN_A_ORG1)
    stop()
    expect(page.changed.value).toBe(true)
    const { container } = mountInspector({ binding: page })
    await flushUi()
    await openDialog(container)
    expectRefused()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(0)
  })

  it('the same org claim on a refreshed token keeps the binding: the create is sent', async () => {
    await openUnder(TOKEN_A_ORG1)
    signInElsewhereWithEvent(TOKEN_A_ORG1_REFRESHED)
    await flushUi()
    expect(q('identity-refused')).toBeNull()
    await submit()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(1)
    expect(q('success')).not.toBeNull()
  })

  it('the same org claim with surrounding spaces, or a token differing only in workspaceId, keeps the binding', async () => {
    await openUnder(TOKEN_A_ORG1)
    signInElsewhereWithEvent(fakeToken({ sub: 'usr_me', tenantId: ' org_1 ', workspaceId: 'org_9', iat: 3 }))
    await flushUi()
    expect(q('identity-refused')).toBeNull()
    await submit()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(1)
    expect(q('success')).not.toBeNull()
  })

  it('a page bound with an org claim refuses once the token carries only workspaceId', async () => {
    await openUnder(TOKEN_A_ORG1)
    const header = authHeaders()['x-tenant-id']
    signInElsewhereWithEvent(fakeToken({ sub: 'usr_me', workspaceId: 'org_1', iat: 3 }))
    await flushUi()
    expect(authHeaders()['x-tenant-id']).toBe(header)
    expectRefused()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(0)
  })

  it('a page set up under an explicitly selected session org dispatches', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const session = fakeToken({ sub: 'usr_me', userId: 'usr_me', tenantId: 'org_2', exp })
    localStorage.setItem('auth_token', session)
    localStorage.setItem('jwt', session)
    localStorage.setItem(EXPLICIT_SESSION_ORG_KEY, JSON.stringify({
      state: 'ready', token: session, actor: 'usr_me', tenantId: 'org_2', exp, epoch: 'epoch_1',
    }))
    expect(readDispatchIdentity()).toBe(JSON.stringify([
      JSON.stringify(['explicit', 'usr_me', 'org_2', 'epoch_1']), 'org_2', 'org_2',
    ]))
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setSelect('person-field', '')
    setInput('due-date', '2031-05-06')
    await flushUi()
    expect(q('identity-refused')).toBeNull()
    await submit()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(1)
    expect(q('success')).not.toBeNull()
  })

  it('a token without an org claim behaves as before: a refresh for the same user and org header keeps the binding', async () => {
    await openUnder(TOKEN_A)
    signInElsewhereWithEvent(TOKEN_A_REFRESHED)
    await flushUi()
    expect(q('identity-refused')).toBeNull()
    await submit()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(1)
    expect(q('success')).not.toBeNull()
  })

  it('a page bound without an org claim refuses once the token carries one, until the page is set up again', async () => {
    await openUnder(TOKEN_A)
    const header = authHeaders()['x-tenant-id']
    signInElsewhere(TOKEN_A_ORG1)
    expect(authHeaders()['x-tenant-id']).toBe(header)
    await submit()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(0)
    expectRefused()
    // A page set up again under the new token dispatches normally.
    unmountAll()
    while (bindings.length > 0) bindings.pop()!.dispose()
    resetDispatchRunsForTests()
    mocks.apiFetch.mockReset()
    await openUnder(TOKEN_A_ORG1)
    await submit()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(1)
    expect(q('success')).not.toBeNull()
  })

  it('a page bound with an org claim refuses once the token carries none', async () => {
    await openUnder(TOKEN_A_ORG1)
    const header = authHeaders()['x-tenant-id']
    signInElsewhere(TOKEN_A)
    expect(authHeaders()['x-tenant-id']).toBe(header)
    await submit()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(0)
    expectRefused()
  })
})

describe('派发任务 page binding: another identity seen once refuses for good', () => {
  it('A, then B, then A (storage events), and a move to another record: still refused, nothing sent', async () => {
    serveTasks()
    const { container, vm } = mountInspector()
    await flushUi()
    signInElsewhereWithEvent(TOKEN_B)
    await flushUi()
    signInElsewhereWithEvent(TOKEN_A)
    await flushUi()
    // A record that may have been read while B was signed in; its dialog is a fresh one.
    vm.record = { ...RECORD, id: 'rec_2' } as unknown as MetaRecord
    await flushUi(6)
    await openDialog(container)
    expectRefused()
    expect(taskSends()).toHaveLength(0)
  })

  it('A, then B, then A with no event at all: a record read while B was signed in is caught by the read itself', async () => {
    serveTasks()
    const page = pageBinding()
    // Wired the way the workbench wires it.
    const stop = onMultitableBeforeSend(() => { page.check() })
    const reads: string[] = []
    const client = new MultitableApiClient({
      fetchFn: async () => {
        reads.push(readDispatchIdentity())
        return jsonResponse(200, { fields: [], rows: [], view: null }) as unknown as Response
      },
    })
    signInElsewhere(TOKEN_B)
    await client.loadView({ sheetId: 'sht_1', viewId: 'viw_1' }).catch(() => undefined)
    signInElsewhere(TOKEN_A)
    stop()
    expect(reads).toHaveLength(1)
    expect(page.changed.value).toBe(true)
    const { container } = mountInspector({ binding: page, record: { ...RECORD, id: 'rec_2' } as unknown as MetaRecord })
    await flushUi()
    await openDialog(container)
    expectRefused()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(0)
  })

  it('a refusal outlives a close and the bound identity coming back: the reopen still refuses', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    signInElsewhereWithEvent(TOKEN_B)
    await flushUi()
    expectRefused()
    q<HTMLButtonElement>('cancel')!.click()
    await flushUi()
    signInElsewhereWithEvent(TOKEN_A)
    await flushUi()
    await openDialog(container)
    expectRefused()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(0)
  })

  it('no await separates the check from the create: a switch queued for the next microtask finds the create already sent under the bound identity', async () => {
    const sentUnder: string[] = []
    serveTasks({
      create: () => jsonResponse(200, { id: 'tsk_9', version: 1 }),
    })
    const serve = mocks.apiFetch.getMockImplementation()!
    mocks.apiFetch.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
      // Read when the transport is called, which is when apiFetch reads the session headers.
      if (String(url).startsWith('/api/tasks')) sentUnder.push(readDispatchIdentity())
      return serve(url, init)
    })
    const { container, binding } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await flushUi()
    // Queued BEFORE the click, so it runs before anything the click handler would put behind an await.
    queueMicrotask(() => signIn(TOKEN_B))
    q<HTMLButtonElement>('submit')!.click()
    await flushUi(10)
    // Whatever was sent went out under the bound identity; nothing after the switch was sent.
    expect(sentUnder.length).toBeGreaterThan(0)
    for (const identity of sentUnder) expect(identity).toBe(binding!.identity)
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(1)
    expect(tasksCalls('PATCH', '/api/tasks/')).toHaveLength(0)
  })

  it('a refused dialog does not consume a result: the task created before the change is shown on a page set up again under that identity', async () => {
    let release: (value: Response) => void = () => {}
    serveTasks({ create: () => new Promise<Response>((resolve) => { release = resolve }) })
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await submit()
    signInElsewhere(TOKEN_B)
    release(jsonResponse(200, { id: 'tsk_9', version: 1 }))
    await flushUi(10)
    // The refused dialog stays on screen while the result lands.
    expectRefused()
    unmountAll()
    signInElsewhere(TOKEN_A)
    const again = mountInspector()
    await flushUi()
    await openDialog(again.container)
    expect(q<HTMLAnchorElement>('open-task')!.getAttribute('href')).toBe('/tasks/tsk_9')
  })
})

// ---- late answers and the retry key (final review, 2026-11-04) ----------------------------------

describe('派发任务 dialog: a late answer changes the retry key only while it is the entry it was sent under', () => {
  /** Creates that wait to be answered, in the order they were sent. */
  function deferredCreates(): Array<{ resolve: (value: Response) => void; reject: (error: unknown) => void }> {
    const pending: Array<{ resolve: (value: Response) => void; reject: (error: unknown) => void }> = []
    serveTasks({ create: () => new Promise<Response>((resolve, reject) => { pending.push({ resolve, reject }) }) })
    return pending
  }

  async function unresolvedThenReload(): Promise<string> {
    serveTasks({ create: () => jsonResponse(502, {}) })
    const first = mountInspector()
    await flushUi()
    await openAndSubmit(first.container)
    const key = String(storedEntry()!.key)
    reloadPage()
    return key
  }

  /** A drawer client whose read under a retry key waits to be answered; the list read answers at once. */
  function waitingKeyedClient() {
    const answers: Array<(value: unknown) => void> = []
    const client = fakeApiClient()
    client.listRecordTasks.mockImplementation((_sheetId: string, _recordId: string, options?: { dispatchKey?: string }) =>
      options?.dispatchKey ? new Promise((resolve) => { answers.push(resolve) }) : Promise.resolve(NO_ROWS))
    return { client, answers }
  }

  const lateRefusals: Array<[string, () => Response]> = [
    ['403', () => jsonResponse(403, {})],
    ['422', () => jsonResponse(422, { error: { code: 'INVALID_TITLE' } })],
    ['422 INVALID_DISPATCH_KEY', () => jsonResponse(422, { error: { code: 'INVALID_DISPATCH_KEY' } })],
  ]

  for (const [name, late] of lateRefusals) {
    it(`R1 (${name}): the previous account's late answer changes neither the new account's key, its count nor the read on the next open`, async () => {
      const creates = deferredCreates()
      const first = mountInspector()
      await flushUi()
      await openAndSubmit(first.container)
      const keyA = String(storedEntry()!.key)
      expect(storedEntry()!.unsettled).toBe(1)
      // B signs in in this tab while A's create is out: A's run and every entry go.
      useAuth().setToken(TOKEN_B)
      await flushUi()
      expect(storedEntry()).toBeNull()
      unmountAll()
      // The page is set up again under B, and B dispatches from the same record.
      const second = mountInspector()
      await flushUi()
      await openAndSubmit(second.container)
      const keyB = String(storedEntry()!.key)
      expect(keyB).not.toBe(keyA)
      expect(createKeys()).toEqual([keyA, keyB])
      expect(storedEntry()).toMatchObject({ key: keyB, unsettled: 1 })
      // A's create is answered now, with a 4xx; B's is still out.
      creates[0].resolve(late())
      await flushUi(10)
      expect(storedEntry()).toMatchObject({ key: keyB, unsettled: 1 })
      expect(q('error')).toBeNull()
      // B's create gets no readable answer.
      creates[1].resolve(jsonResponse(502, {}))
      await flushUi(10)
      expect(q('error')!.textContent!.trim()).toBe(OUTCOME_UNKNOWN_ZH)
      expect(storedEntry()).toMatchObject({ key: keyB, unsettled: 1 })
      // After a reload the open reads under B's key before anything else.
      reloadPage()
      const third = mountInspector()
      await flushUi()
      await openDialog(third.container)
      expect(third.client.listRecordTasks).toHaveBeenCalledWith('sht_1', 'rec_1', { dispatchKey: keyB })
      expect(q('earlier-no-task')!.textContent!.trim()).toBe(EARLIER_NO_TASK_ZH)
      expect(tasksCalls('POST', '/api/tasks')).toHaveLength(2)
      expect(tasksCalls('PATCH', '/api/tasks/')).toHaveLength(0)
    })
  }

  it('R2: another account signed in from another tab sends under the record\'s same key; the previous account\'s late 4xx leaves its count as it is', async () => {
    const creates = deferredCreates()
    const first = mountInspector()
    await flushUi()
    await openAndSubmit(first.container)
    const key = String(storedEntry()!.key)
    unmountAll()
    // B signs in in another tab: this tab is told nothing, so no entry is cleared.
    signInElsewhere(TOKEN_B)
    const second = mountInspector()
    await flushUi()
    await openAndSubmit(second.container)
    expect(createKeys()).toEqual([key, key])
    expect(storedEntry()).toMatchObject({ key, unsettled: 2 })
    creates[0].resolve(jsonResponse(422, { error: { code: 'INVALID_TITLE' } }))
    await flushUi(10)
    expect(storedEntry()).toMatchObject({ key, unsettled: 2 })
    expect(q('error')).toBeNull()
    creates[1].resolve(jsonResponse(502, {}))
    await flushUi(10)
    expect(storedEntry()).toMatchObject({ key, unsettled: 2 })
    reloadPage()
    const third = mountInspector()
    await flushUi()
    await openDialog(third.container)
    expect(third.client.listRecordTasks).toHaveBeenCalledWith('sht_1', 'rec_1', { dispatchKey: key })
  })

  it('R3: a late 4xx for a key the record no longer holds leaves the newer entry alone (the store is driven directly to stand for a newer key)', async () => {
    const creates = deferredCreates()
    const { container } = mountInspector()
    await flushUi()
    await openAndSubmit(container)
    const sentKey = String(storedEntry()!.key)
    // While the create is out the record's entry is replaced by a newer one, counted once.
    dispatchKeys.release(SCOPE)
    const newer = dispatchKeys.obtain(SCOPE).key
    dispatchKeys.markSent(SCOPE)
    expect(newer).not.toBe(sentKey)
    creates[0].resolve(jsonResponse(422, { error: { code: 'INVALID_TITLE' } }))
    await flushUi(10)
    // The answer is still shown to the account that sent it; only the entry is left alone.
    expect(q('error')!.textContent!.trim()).toBe('标题包含无法保存的字符')
    expect(storedEntry()).toMatchObject({ key: newer, unsettled: 1 })
  })

  for (const [name, late] of lateRefusals.slice(0, 2)) {
    it(`R4 (${name}): the same account's own late 4xx still counts off its request; the next open has nothing to resolve`, async () => {
      const creates = deferredCreates()
      const first = mountInspector()
      await flushUi()
      await openAndSubmit(first.container)
      const key = String(storedEntry()!.key)
      // The dialog is closed while the create is out; the answer lands later.
      q<HTMLButtonElement>('cancel')!.click()
      await flushUi()
      creates[0].resolve(late())
      await flushUi(10)
      expect(storedEntry()).toMatchObject({ key, unsettled: 0 })
      reloadPage()
      const second = mountInspector()
      await flushUi()
      await openDialog(second.container)
      expect(second.client.listRecordTasks).toHaveBeenCalledTimes(1)
      expect(second.client.listRecordTasks).toHaveBeenCalledWith('sht_1', 'rec_1', { limit: 100 })
      expect(q('earlier-unresolved')).toBeNull()
    })
  }

  it('R5: a late 5xx or no answer at all still leaves the entry unresolved, and the next open reads under its key', async () => {
    for (const answer of ['503', 'no answer'] as const) {
      const creates = deferredCreates()
      const first = mountInspector()
      await flushUi()
      await openAndSubmit(first.container)
      const key = String(storedEntry()!.key)
      q<HTMLButtonElement>('cancel')!.click()
      await flushUi()
      if (answer === '503') creates[0].resolve(jsonResponse(503, {}))
      else creates[0].reject(new TypeError('Failed to fetch'))
      await flushUi(10)
      expect(storedEntry()).toMatchObject({ key, unsettled: 1 })
      reloadPage()
      const second = mountInspector()
      await flushUi()
      await openDialog(second.container)
      expect(second.client.listRecordTasks).toHaveBeenCalledWith('sht_1', 'rec_1', { dispatchKey: key })
      reloadPage()
      sessionStorage.clear()
    }
  })

  it('R6: the open-time read under the key answers after another account signed in elsewhere: nothing is shown and the entry is kept', async () => {
    const key = await unresolvedThenReload()
    const { client, answers } = waitingKeyedClient()
    const { container } = mountInspector({ client })
    await flushUi()
    await openDialog(container)
    expect(answers).toHaveLength(1)
    signInElsewhere(TOKEN_B)
    answers[0]({ items: [recordTask()], hasMore: false, degraded: false })
    await flushUi(10)
    expectRefused()
    expect(storedEntry()).toMatchObject({ key, unsettled: 1 })
  })

  it('R6: the open-time read under the key answers after the record took a newer key: the task is shown and the newer entry kept (the store is driven directly)', async () => {
    await unresolvedThenReload()
    const { client, answers } = waitingKeyedClient()
    const { container } = mountInspector({ client })
    await flushUi()
    await openDialog(container)
    expect(answers).toHaveLength(1)
    dispatchKeys.release(SCOPE)
    const newer = dispatchKeys.obtain(SCOPE).key
    answers[0]({ items: [recordTask()], hasMore: false, degraded: false })
    await flushUi(10)
    expect(q<HTMLAnchorElement>('open-task')!.getAttribute('href')).toBe('/tasks/tsk_7')
    expect(storedEntry()).toMatchObject({ key: newer, unsettled: 0 })
  })
})

describe('multitable client: the before-send signal (api/beforeSend.ts)', () => {
  it('tells its listeners synchronously, before the transport is called, and stops after unsubscribe', async () => {
    const order: string[] = []
    const client = new MultitableApiClient({
      fetchFn: async () => {
        order.push('send')
        return jsonResponse(200, {}) as unknown as Response
      },
    })
    const stop = onMultitableBeforeSend(() => { order.push('listener') })
    const stopThrowing = onMultitableBeforeSend(() => { throw new Error('a listener must never break a request') })
    await client.aiAvailability().catch(() => undefined)
    expect(order).toEqual(['listener', 'send'])
    stop()
    stopThrowing()
    await client.aiAvailability().catch(() => undefined)
    expect(order).toEqual(['listener', 'send', 'send'])
  })

  it('the public-form path tells its listeners as well', async () => {
    mocks.apiFetch.mockResolvedValue(jsonResponse(200, {}))
    const client = new MultitableApiClient()
    const seen = vi.fn()
    const stop = onMultitableBeforeSend(seen)
    await client.loadFormContext({ viewId: 'viw_1', publicToken: 'pub_1' }).catch(() => undefined)
    stop()
    expect(seen).toHaveBeenCalledTimes(1)
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
    expect(mocks.apiFetch.mock.calls[0][1]).toMatchObject({ suppressUnauthorizedRedirect: true })
  })

  it('every transport call in the client is right after the listeners are told', async () => {
    const source = (await import('../src/multitable/api/client.ts?raw')).default as string
    const lines = source.split('\n')
    // The population: every line of the client that calls a transport (the app's apiFetch, the stored
    // transport, or the global fetch), found by search rather than listed.
    const transportLines = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => !/^\s*(\/\/|\*|\/\*\*)/.test(line))
      .filter(({ line }) => /(^|[^.\w])(apiFetch|fetch)\(|\.rawFetch\(/.test(line))
    expect(transportLines.length).toBeGreaterThanOrEqual(2)
    for (const { index } of transportLines) expect(lines[index - 1].trim()).toBe('notifyMultitableBeforeSend()')
    // And the stored transport is called only through the hooked `fetch`.
    expect(source.match(/this\.fetch\s*=/g)).toHaveLength(1)
  })
})

// ---- package 1b: the people lookup after a prefill, and the people picker ---------------------

/** Waits out the picker's search debounce (300ms) in real time. */
async function afterDebounce() {
  await new Promise<void>((resolve) => setTimeout(resolve, 350))
  await flushUi(6)
}

const pickerQ = <T extends Element = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="task-people-picker-${id}"]`)

/** Waits in real time until the clock has moved to a later millisecond. */
async function laterMillisecond() {
  const start = Date.now()
  for (let i = 0; i < 50 && Date.now() <= start; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 1))
  // A clock held by a spy left in place would end the wait unmoved; fail loudly rather than go on.
  expect(Date.now()).toBeGreaterThan(start)
}

function typeSearch(value: string) {
  const input = pickerQ<HTMLInputElement>('search')
  expect(input).not.toBeNull()
  input!.value = value
  input!.dispatchEvent(new Event('input'))
}

function chipText(id: string): string {
  return document.querySelector(`[data-assignee-id="${id}"]`)?.textContent ?? ''
}

describe('派发任务 dialog: the people lookup after a person-field prefill (package 1b)', () => {
  it('looks the prefilled ids up once, and keeps them when every one is an active member who can use tasks', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    await flushUi()
    expect(peopleLookups()).toEqual(['/api/tasks/people?ids=usr_a'])
    expect(assigneeIds()).toEqual(['usr_a'])
    expect(q('access-skipped')).toBeNull()
  })

  it('a person the lookup leaves out (not an active member) is not filled in, and the deactivated note says so', async () => {
    serveTasks({ people: () => jsonResponse(200, { items: [], truncated: false }) })
    const record = { ...RECORD, data: { ...RECORD.data, fld_owner: ['usr_a'] } } as unknown as MetaRecord
    const { container } = mountInspector({ record })
    await flushUi()
    await openDialog(container)
    await flushUi()
    expect(assigneeIds()).toEqual([])
    expect(q('inactive-skipped')!.textContent).toContain('已停用的人员未带入')
    // Typed back, the chip carries the deactivated mark.
    setInput('assignee-input', 'usr_a')
    q<HTMLButtonElement>('assignee-add')!.click()
    await flushUi()
    expect(chipText('usr_a')).toContain('已停用')
  })

  it('a person who cannot use tasks yet is not filled in; the note gives the count; typed back, the chip is marked', async () => {
    serveTasks({
      people: () => jsonResponse(200, { items: [{ id: 'usr_a', name: 'Person A', detail: 'pa***@example.test', canUseTasks: false }], truncated: false }),
    })
    const record = { ...RECORD, data: { ...RECORD.data, fld_owner: ['usr_a'] } } as unknown as MetaRecord
    const { container } = mountInspector({ record })
    await flushUi()
    await openDialog(container)
    await flushUi()
    expect(assigneeIds()).toEqual([])
    expect(q('access-skipped')!.textContent).toBe('人员字段中有 1 人还不能使用任务，未带入。')
    expect(q('inactive-skipped')).toBeNull()
    setInput('assignee-input', 'usr_a')
    q<HTMLButtonElement>('assignee-add')!.click()
    await flushUi()
    expect(chipText('usr_a')).toContain('还不能使用任务')
    // Picking another field starts afresh.
    setSelect('person-field', 'fld_reviewer')
    await flushUi()
    expect(q('access-skipped')).toBeNull()
  })

  const unusable: Array<[string, () => Response]> = [
    ['a 404 (an older server)', () => jsonResponse(404, {})],
    ['a 200 of another shape', () => jsonResponse(200, taskBody({ version: 1 }))],
    ['a 200 with a malformed row', () => jsonResponse(200, { items: [{ id: 'usr_a', name: 'Person A' }], truncated: false })],
    ['a 429', () => jsonResponse(429, { error: { code: 'RATE_LIMITED' } })],
    ['a 500', () => jsonResponse(500, {})],
  ]
  for (const [name, reply] of unusable) {
    it(`${name} leaves the prefilled ids and their chips as they were`, async () => {
      serveTasks({ people: reply })
      const { container } = mountInspector()
      await flushUi()
      await openDialog(container)
      await flushUi()
      expect(peopleLookups()).toHaveLength(1)
      expect(assigneeIds()).toEqual(['usr_a'])
      expect(chipText('usr_a')).toContain('Person A')
      expect(chipText('usr_a')).not.toContain('已停用')
      expect(chipText('usr_a')).not.toContain('还不能使用任务')
      expect(q('access-skipped')).toBeNull()
      expect(q('inactive-skipped')).not.toBeNull() // usr_b, deactivated in the drawer's own summaries
      setInput('due-date', '2031-05-06')
      await submit()
      expect(tasksCalls('POST', '/api/tasks')[0][1].assignees).toEqual(['usr_a'])
    })
  }

  it('a refused dialog sends no people lookup', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    signInElsewhereWithEvent(TOKEN_B)
    await flushUi()
    await openDialog(container)
    expectRefused()
    expect(peopleLookups()).toEqual([])
  })

  it('the user-id entry is folded until asked for', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    const toggle = q<HTMLButtonElement>('add-by-id-toggle')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(q<HTMLElement>('add-by-id')!.style.display).toBe('none')
    toggle.click()
    await flushUi()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(q<HTMLElement>('add-by-id')!.style.display).toBe('')
  })

  /** Opens the dialog with the clock held at the millisecond it opened, so a listener on the user-id
   *  box (attached in that same millisecond) would take the stamp and the dialog's own be skipped. */
  async function openDialogInOneMillisecond(container: HTMLElement): Promise<() => void> {
    await openKebab(container)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    try {
      dispatchItem()!.click()
      await flushUi(6)
      expect(dialog()).not.toBeNull()
      q<HTMLButtonElement>('add-by-id-toggle')!.click()
      await flushUi()
    } catch (error) {
      now.mockRestore()
      throw error
    }
    return () => now.mockRestore()
  }

  it('Esc in the user-id box closes the dialog, also when it arrives in the millisecond the dialog opened', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    const restore = await openDialogInOneMillisecond(container)
    try {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      q<HTMLInputElement>('assignee-input')!.dispatchEvent(event)
      await flushUi()
      expect(event.defaultPrevented).toBe(true)
    } finally {
      restore()
    }
    expect(dialog()).toBeNull()
  })

  // Pins Enter after its listener moved from the box to the dialog's handler; the Esc cell above is
  // the one that turns red when a listener on the box takes the stamp.
  it('Enter in the user-id box adds the typed id, also in the millisecond the dialog opened', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    const restore = await openDialogInOneMillisecond(container)
    try {
      setInput('assignee-input', 'usr_b')
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      q<HTMLInputElement>('assignee-input')!.dispatchEvent(event)
      await flushUi()
      expect(event.defaultPrevented).toBe(true)
    } finally {
      restore()
    }
    expect(assigneeIds()).toEqual(['usr_a', 'usr_b'])
    expect(q<HTMLInputElement>('assignee-input')!.value).toBe('')
    expect(dialog()).not.toBeNull()
  })

  it('another key in the user-id box is left to the box: not held back, no chip added, the typed text kept', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    q<HTMLButtonElement>('add-by-id-toggle')!.click()
    await flushUi()
    setInput('assignee-input', 'usr_b')
    const before = assigneeIds()
    for (const key of ['a', ' ']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      q<HTMLInputElement>('assignee-input')!.dispatchEvent(event)
      await flushUi()
      expect(event.defaultPrevented, JSON.stringify(key)).toBe(false)
    }
    expect(assigneeIds()).toEqual(before)
    expect(q<HTMLInputElement>('assignee-input')!.value).toBe('usr_b')
    expect(dialog()).not.toBeNull()
  })
})

describe('派发任务 dialog: the people picker (package 1b)', () => {
  function peopleWithSearch(): Route {
    return (url) => {
      if (url.includes('?ids=')) return everyoneUsable(url)
      return jsonResponse(200, {
        items: [
          { id: 'usr_x', name: 'Person X', detail: 'px***@example.test', canUseTasks: true },
          { id: 'usr_y', name: 'Person Y', detail: 'py***@example.test', canUseTasks: false },
        ],
        hasMore: false,
        requiresQuery: false,
        limit: 20,
      })
    }
  }

  it('picked people join the chips with their names; someone who cannot use tasks yet cannot be ticked', async () => {
    serveTasks({ people: peopleWithSearch() })
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    q<HTMLButtonElement>('pick-people')!.click()
    await flushUi()
    expect(pickerQ('type-hint')).not.toBeNull()
    typeSearch('P')
    await afterDebounce()
    expect(peopleLookups().filter((url) => url.includes('?q='))).toEqual(['/api/tasks/people?q=P'])
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="task-people-picker-row"]'))
    expect(rows.map((row) => row.dataset.personId)).toEqual(['usr_x', 'usr_y'])
    const blocked = rows[1].querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(blocked.disabled).toBe(true)
    expect(rows[1].textContent).toContain('还不能使用任务')
    rows[0].querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
    await flushUi()
    pickerQ<HTMLButtonElement>('confirm')!.click()
    await flushUi()
    expect(pickerQ('search')).toBeNull()
    expect(assigneeIds()).toEqual(['usr_a', 'usr_x'])
    expect(chipText('usr_x')).toContain('Person X')
    setInput('due-date', '2031-05-06')
    await submit()
    expect(tasksCalls('POST', '/api/tasks')[0][1].assignees).toEqual(['usr_a', 'usr_x'])
  })

  it('a pick that would pass 50 assignees is refused with the limit message, and the chips stay', async () => {
    serveTasks({ people: peopleWithSearch() })
    const many = Array.from({ length: 50 }, (_, i) => `usr_m${i}`)
    const record = { ...RECORD, data: { ...RECORD.data, fld_owner: many } } as unknown as MetaRecord
    const { container } = mountInspector({ record })
    await flushUi()
    await openDialog(container)
    await flushUi()
    expect(assigneeIds()).toHaveLength(50)
    q<HTMLButtonElement>('pick-people')!.click()
    await flushUi()
    typeSearch('P')
    await afterDebounce()
    document.querySelector<HTMLInputElement>('[data-person-id="usr_x"] input[type="checkbox"]')!.click()
    await flushUi()
    pickerQ<HTMLButtonElement>('confirm')!.click()
    await flushUi()
    expect(q('assignee-error')!.textContent).toContain('负责人最多 50 人')
    expect(assigneeIds()).toEqual(many)
  })

  it('Esc closes the picker only, not the dialog', async () => {
    serveTasks({ people: peopleWithSearch() })
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    q<HTMLButtonElement>('pick-people')!.click()
    await flushUi()
    pickerQ<HTMLInputElement>('search')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushUi()
    expect(pickerQ('search')).toBeNull()
    expect(dialog()).not.toBeNull()
  })

  it('Esc closes the picker only, also when it arrives in the millisecond the picker opened', async () => {
    serveTasks({ people: peopleWithSearch() })
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    // The dialog's own listener is attached in an earlier millisecond; then the clock is held at the
    // picker's (see the picker's onPanelKeydown).
    await new Promise((resolve) => setTimeout(resolve, 5))
    const opened = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(opened)
    try {
      await flushUi()
      q<HTMLButtonElement>('pick-people')!.click()
      await flushUi()
      pickerQ<HTMLInputElement>('search')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await flushUi()
    } finally {
      now.mockRestore()
    }
    expect(pickerQ('search')).toBeNull()
    expect(dialog()).not.toBeNull()
  })

  it('Tab from the last control of the picker wraps to its first, never to a dialog control behind it', async () => {
    serveTasks({ people: peopleWithSearch() })
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    q<HTMLButtonElement>('pick-people')!.click()
    await flushUi()
    // Nothing is ticked yet, so the picker's confirm is disabled and cancel is its last control.
    const cancel = pickerQ<HTMLButtonElement>('cancel')!
    cancel.focus()
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    cancel.dispatchEvent(event)
    await flushUi()
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(pickerQ('search'))
    expect(dialog()).not.toBeNull()
  })

  it('Enter on another control, in the dialog or in the picker, adds nothing from the user-id box', async () => {
    serveTasks({ people: peopleWithSearch() })
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    q<HTMLButtonElement>('add-by-id-toggle')!.click()
    await flushUi()
    setInput('assignee-input', 'usr_b')
    const before = assigneeIds()
    const enter = (on: HTMLElement) => {
      on.focus()
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      on.dispatchEvent(event)
      return event
    }
    expect(enter(q<HTMLInputElement>('title')!).defaultPrevented).toBe(false)
    await flushUi()
    q<HTMLButtonElement>('pick-people')!.click()
    await flushUi()
    // The Enter from the picker reaches the dialog's handler only when it is stamped in a later
    // millisecond than the one the dialog's listener was attached in (see the picker's onPanelKeydown).
    await laterMillisecond()
    expect(enter(pickerQ<HTMLButtonElement>('cancel')!).defaultPrevented).toBe(false)
    await flushUi()
    expect(assigneeIds()).toEqual(before)
    expect(q<HTMLInputElement>('assignee-input')!.value).toBe('usr_b')
    expect(dialog()).not.toBeNull()
  })

  it('closing the picker by Esc, cancel or confirm puts focus back on 选择人员; the dialog then keeps Shift+Tab inside and an Esc closes it', async () => {
    serveTasks({ people: peopleWithSearch() })
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    const pick = () => q<HTMLButtonElement>('pick-people')!
    const openPicker = async () => {
      pick().focus()
      pick().click()
      await flushUi()
      expect(document.activeElement).toBe(pickerQ('search'))
    }
    await openPicker()
    pickerQ<HTMLInputElement>('search')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushUi()
    expect(pickerQ('search')).toBeNull()
    expect(document.activeElement).toBe(pick())
    await openPicker()
    pickerQ<HTMLButtonElement>('cancel')!.click()
    await flushUi()
    expect(pickerQ('search')).toBeNull()
    expect(document.activeElement).toBe(pick())
    await openPicker()
    typeSearch('P')
    await afterDebounce()
    document.querySelector<HTMLInputElement>('[data-person-id="usr_x"] input[type="checkbox"]')!.click()
    await flushUi()
    pickerQ<HTMLButtonElement>('confirm')!.click()
    await flushUi()
    expect(assigneeIds()).toEqual(['usr_a', 'usr_x'])
    expect(document.activeElement).toBe(pick())
    // With the picker gone, the dialog's keys work again: Shift+Tab from its first control (×) is
    // held back and wraps inside the dialog (only the dialog's handler prevents a Tab here), and an
    // Esc closes it.
    const close = dialog()!.querySelector<HTMLElement>('.meta-dispatch__close')!
    close.focus()
    expect(document.activeElement).toBe(close)
    const shiftTab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    close.dispatchEvent(shiftTab)
    await flushUi()
    expect(shiftTab.defaultPrevented).toBe(true)
    expect(dialog()!.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(close)
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushUi()
    expect(dialog()).toBeNull()
  })

  it('closing the whole dialog with the picker open leaves focus where the dialog put it back', async () => {
    serveTasks({ people: peopleWithSearch() })
    const { container } = mountInspector()
    await flushUi()
    await openKebab(container)
    // Opened with focus on the drawer's menu button, which stays in the page: the dialog puts focus
    // back there when it closes.
    const menu = container.querySelector<HTMLElement>('[data-testid="record-inspector-menu"]')!
    menu.focus()
    dispatchItem()!.click()
    await flushUi(6)
    expect(dialog()).not.toBeNull()
    q<HTMLButtonElement>('pick-people')!.focus()
    q<HTMLButtonElement>('pick-people')!.click()
    await flushUi()
    expect(document.activeElement).toBe(pickerQ('search'))
    dialog()!.querySelector<HTMLElement>('.meta-dispatch__close')!.click()
    await flushUi()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(menu)
  })

  it('opened by a click that does not focus the button (macOS Safari), the picker still hands focus back to 选择人员', async () => {
    serveTasks({ people: peopleWithSearch() })
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    // Focus is on another control; the click itself moves none (a click in jsdom never does).
    q<HTMLInputElement>('title')!.focus()
    q<HTMLButtonElement>('pick-people')!.click()
    await flushUi()
    expect(document.activeElement).toBe(pickerQ('search'))
    pickerQ<HTMLButtonElement>('cancel')!.click()
    await flushUi()
    expect(pickerQ('search')).toBeNull()
    expect(document.activeElement).toBe(q('pick-people'))
  })

  it('a sign-in change with the picker open: the dialog refuses, focus lands on the dialog, and an Esc then closes it', async () => {
    serveTasks({ people: peopleWithSearch() })
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    q<HTMLButtonElement>('pick-people')!.focus()
    q<HTMLButtonElement>('pick-people')!.click()
    await flushUi()
    expect(document.activeElement).toBe(pickerQ('search'))
    signInElsewhereWithEvent(TOKEN_B)
    await flushUi()
    expectRefused()
    expect(pickerQ('search')).toBeNull()
    // 选择人员 went with the form; focus goes to the dialog it was in, not to the page.
    expect(q('pick-people')).toBeNull()
    expect(document.activeElement).toBe(dialog())
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.activeElement!.dispatchEvent(esc)
    await flushUi()
    expect(esc.defaultPrevented).toBe(true)
    expect(dialog()).toBeNull()
  })

  it('a picker left open when the open-time list replaced the form does not come back with 再派一项', async () => {
    let answer: (value: unknown) => void = () => {}
    const client = fakeApiClient()
    client.listRecordTasks.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    serveTasks({ people: peopleWithSearch() })
    const { container } = mountInspector({ client })
    await flushUi()
    await openDialog(container)
    // The list read is still out: submit waits for it, 选择人员 does not.
    expect(q<HTMLButtonElement>('submit')!.disabled).toBe(true)
    q<HTMLButtonElement>('pick-people')!.click()
    await flushUi()
    expect(pickerQ('search')).not.toBeNull()
    answer({ items: [recordTask()], hasMore: false, degraded: false })
    await flushUi()
    expect(q('existing')).not.toBeNull()
    expect(pickerQ('search')).toBeNull()
    q<HTMLButtonElement>('another')!.click()
    await flushUi()
    expect(q('title')).not.toBeNull()
    expect(pickerQ('search')).toBeNull()
    expect(document.querySelector('[data-testid="task-people-picker"]')).toBeNull()
  })

  it('after another sign-in, a search is not sent and the dialog refuses', async () => {
    serveTasks({ people: peopleWithSearch() })
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    q<HTMLButtonElement>('pick-people')!.click()
    await flushUi()
    signInElsewhere(TOKEN_B)
    typeSearch('P')
    await afterDebounce()
    expect(peopleLookups().filter((url) => url.includes('?q='))).toEqual([])
    expectRefused()
  })
})

describe('派发任务 dialog: its own Tab trap', () => {
  /** Sends a Tab (Shift+Tab with `shiftKey`) from `from`, focused first; returns the event. */
  function tab(from: HTMLElement, shiftKey = false): KeyboardEvent {
    from.focus()
    expect(document.activeElement).toBe(from)
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
    from.dispatchEvent(event)
    return event
  }

  const closeButton = () => dialog()!.querySelector<HTMLElement>('.meta-dispatch__close')!
  const chipRemove = (id: string) => document.querySelector<HTMLButtonElement>(`[data-assignee-id="${id}"] .meta-dispatch__chip-remove`)!

  it('moves every Tab and Shift+Tab one step, wraps at both ends, and starts from the ends when the dialog itself has focus', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await flushUi()
    const submitButton = q<HTMLButtonElement>('submit')!
    expect(submitButton.disabled).toBe(false)
    // One step forward and back between two middle controls (each moved by the dialog, not the browser).
    expect(tab(q('title')!).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(q('person-field'))
    expect(tab(q('person-field')!, true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(q('title'))
    // Both ends wrap.
    expect(tab(submitButton).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(closeButton())
    expect(tab(closeButton(), true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(submitButton)
    // From the dialog itself (where focus goes on open): Tab to the first control, Shift+Tab to the last.
    expect(tab(dialog()!).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(closeButton())
    expect(tab(dialog()!, true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(submitButton)
    expect(dialog()).not.toBeNull()
  })

  it('leaves a Tab in the date and time inputs to the browser (their own parts), and brings a move out of the dialog back to the next control', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await flushUi()
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    const turn = () => new Promise((resolve) => setTimeout(resolve, 0))
    try {
      // A Tab between the input's parts: not held back, focus stays on the input.
      expect(tab(q('due-date')!).defaultPrevented).toBe(false)
      expect(document.activeElement).toBe(q('due-date'))
      // Wherever the browser moves it inside the dialog is left as it is.
      q('submit')!.focus()
      await turn()
      expect(document.activeElement).toBe(q('submit'))
      // A move out of the dialog (Tab, then Shift+Tab) comes back to the control after (before) the input.
      expect(tab(q('due-time')!).defaultPrevented).toBe(false)
      outside.focus()
      await turn()
      expect(document.activeElement).toBe(q('cancel'))
      expect(tab(q('due-date')!, true).defaultPrevented).toBe(false)
      outside.focus()
      await turn()
      expect(document.activeElement).toBe(q('mode'))
      // Only the move in the same turn as the Tab: focus leaving later (a click) is left as it is.
      expect(tab(q('due-date')!).defaultPrevented).toBe(false)
      await turn()
      outside.focus()
      await turn()
      expect(document.activeElement).toBe(outside)
    } finally {
      outside.remove()
    }
  })

  it('steps over the folded user-id entry, and onto it once it is unfolded', async () => {
    serveTasks()
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    expect(assigneeIds()).toEqual(['usr_a'])
    expect(tab(chipRemove('usr_a')).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(q('mode'))
    expect(tab(q('mode')!, true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(chipRemove('usr_a'))
    q<HTMLButtonElement>('add-by-id-toggle')!.click()
    await flushUi()
    expect(tab(chipRemove('usr_a')).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(q('assignee-input'))
  })

  it('skips the controls disabled while a create is out', async () => {
    serveTasks({ create: () => new Promise<Response>(() => {}) })
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await flushUi()
    await submit()
    expect(q<HTMLButtonElement>('submit')!.disabled).toBe(true)
    expect(q<HTMLInputElement>('title')!.disabled).toBe(true)
    // Left enabled: ×, the user-id toggle and 取消.
    const toggle = q<HTMLButtonElement>('add-by-id-toggle')!
    const cancel = q<HTMLButtonElement>('cancel')!
    expect(tab(closeButton()).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(toggle)
    expect(tab(toggle).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(cancel)
    expect(tab(cancel).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(closeButton())
    expect(tab(cancel, true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(toggle)
    expect(tab(closeButton(), true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(cancel)
  })
})

describe('派发任务 dialog: a sent form keeps what was sent (packages 1b and 2 together)', () => {
  /** The people route: the prefill lookup answered by `lookup` (at once by default), a search by
   *  one person who can use tasks. */
  function peopleRoute(lookup: Route = everyoneUsable): Route {
    return (url, init) => {
      if (url.includes('?ids=')) return lookup(url, init)
      return jsonResponse(200, {
        items: [{ id: 'usr_x', name: 'Person X', detail: 'px***@example.test', canUseTasks: true }],
        hasMore: false,
        requiresQuery: false,
        limit: 20,
      })
    }
  }

  const NO_TASKS_FOR_A = () => jsonResponse(200, {
    items: [{ id: 'usr_a', name: 'Person A', detail: '', canUseTasks: false }],
    truncated: false,
  })

  async function pickPersonX() {
    q<HTMLButtonElement>('pick-people')!.click()
    await flushUi()
    typeSearch('P')
    await afterDebounce()
    document.querySelector<HTMLInputElement>('[data-person-id="usr_x"] input[type="checkbox"]')!.click()
    await flushUi()
  }

  it('S1: a dialog mounted while the create is out shows the sent form once the outcome is unknown; 重试 resends it', async () => {
    let release: (value: Response) => void = () => {}
    let creates = 0
    serveTasks({
      people: peopleRoute(),
      create: () => (creates++ === 0
        ? new Promise<Response>((resolve) => { release = resolve })
        : jsonResponse(200, { id: 'tsk_9', version: 1, sourceLinked: true })),
    })
    const { container, vm } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('title', 'Changed')
    setSelect('mode', 'any')
    setInput('due-date', '2031-05-06')
    await pickPersonX()
    pickerQ<HTMLButtonElement>('confirm')!.click()
    await flushUi()
    expect(assigneeIds()).toEqual(['usr_a', 'usr_x'])
    await submit()
    q<HTMLButtonElement>('cancel')!.click()
    await flushUi()
    vm.record = { ...RECORD, id: 'rec_2' } as unknown as MetaRecord
    await flushUi(6)
    vm.record = RECORD
    await flushUi(6)
    await openDialog(container)
    expect(q('pending')).not.toBeNull()
    release(jsonResponse(502, {}))
    await flushUi(10)
    expect(q('pending')).toBeNull()
    expect(q('error')!.textContent!.trim()).toBe(OUTCOME_UNKNOWN_ZH)
    expect(q<HTMLInputElement>('title')!.value).toBe('Changed')
    expect(q<HTMLSelectElement>('mode')!.value).toBe('any')
    expect(q<HTMLInputElement>('due-date')!.value).toBe('2031-05-06')
    // The name the picker gave is kept with the sent form, so this dialog shows it too.
    expect(assigneeIds()).toEqual(['usr_a', 'usr_x'])
    expect(chipText('usr_x')).toContain('Person X')
    expect(q('inactive-skipped')).toBeNull()
    for (const id of LOCKED_CONTROLS) expect(q<HTMLInputElement>(id)!.disabled).toBe(true)
    expect(q('submit')!.textContent!.trim()).toBe('重试')
    await submit()
    const bodies = rawCreateBodies()
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toBe(bodies[0])
    expect(JSON.parse(bodies[0])).toMatchObject({ title: 'Changed', assignees: ['usr_a', 'usr_x'], dueDate: '2031-05-06' })
    expect(q('success')).not.toBeNull()
  })

  it('S1b: the names kept with a sent form stay with the identity that sent it', async () => {
    serveTasks({ people: peopleRoute(), create: () => jsonResponse(502, {}) })
    const first = mountInspector()
    await flushUi()
    await openDialog(first.container)
    setInput('due-date', '2031-05-06')
    await pickPersonX()
    pickerQ<HTMLButtonElement>('confirm')!.click()
    await flushUi()
    await submit()
    expect(q('error')!.textContent!.trim()).toBe(OUTCOME_UNKNOWN_ZH)
    expect(chipText('usr_x')).toContain('Person X')
    q<HTMLButtonElement>('cancel')!.click()
    await flushUi()
    unmountAll()
    // B signs in elsewhere and the page is loaded again under B: a fresh form, no name of A's.
    signInElsewhere(TOKEN_B)
    const second = mountInspector()
    await flushUi()
    await openDialog(second.container)
    expect(dialog()!.textContent).not.toContain('Person X')
    expect(q('identity-refused')).toBeNull()
    expect(q('submit')!.textContent!.trim()).toBe('派发')
    expect(assigneeIds()).toEqual(['usr_a'])
    q<HTMLButtonElement>('cancel')!.click()
    await flushUi()
    unmountAll()
    // Back under A, the sent form comes back with the name.
    signInElsewhere(TOKEN_A)
    const third = mountInspector()
    await flushUi()
    await openDialog(third.container)
    expect(q('submit')!.textContent!.trim()).toBe('重试')
    expect(chipText('usr_x')).toContain('Person X')
  })

  it('S2: a picker confirm on the locked form adds no chip, and 重试 resends the same bytes', async () => {
    let answer: () => Response = () => jsonResponse(502, {})
    serveTasks({ people: peopleRoute(), create: () => answer() })
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    // The picker is open with usr_x ticked, not confirmed, when the create is sent.
    await pickPersonX()
    await submit()
    expect(q('submit')!.textContent!.trim()).toBe('重试')
    expect(q<HTMLButtonElement>('pick-people')!.disabled).toBe(true)
    pickerQ<HTMLButtonElement>('confirm')!.click()
    await flushUi()
    expect(pickerQ('search')).toBeNull()
    expect(assigneeIds()).toEqual(['usr_a'])
    expect(document.querySelector('[data-assignee-id="usr_x"]')).toBeNull()
    answer = () => jsonResponse(200, { id: 'tsk_9', version: 1, sourceLinked: true })
    await submit()
    const bodies = rawCreateBodies()
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toBe(bodies[0])
    expect(JSON.parse(bodies[0]).assignees).toEqual(['usr_a'])
  })

  // The unlocked form acts on the same answer (the "cannot use tasks yet" prefill cell above).
  for (const when of ['after the 502', 'while the create is out'] as const) {
    it(`S3: a people lookup answered ${when} leaves the locked chips as sent, and 重试 resends the same bytes`, async () => {
      let releasePeople: (value: Response) => void = () => {}
      let releaseCreate: (value: Response) => void = () => {}
      let creates = 0
      serveTasks({
        people: peopleRoute(() => new Promise<Response>((resolve) => { releasePeople = resolve })),
        create: () => (creates++ === 0
          ? new Promise<Response>((resolve) => { releaseCreate = resolve })
          : jsonResponse(200, { id: 'tsk_9', version: 1, sourceLinked: true })),
      })
      const { container } = mountInspector()
      await flushUi()
      await openDialog(container)
      expect(peopleLookups()).toEqual(['/api/tasks/people?ids=usr_a'])
      setInput('due-date', '2031-05-06')
      await submit()
      if (when === 'while the create is out') {
        releasePeople(NO_TASKS_FOR_A())
        await flushUi(10)
        releaseCreate(jsonResponse(502, {}))
      } else {
        releaseCreate(jsonResponse(502, {}))
        await flushUi(10)
        releasePeople(NO_TASKS_FOR_A())
      }
      await flushUi(10)
      expect(q('submit')!.textContent!.trim()).toBe('重试')
      expect(assigneeIds()).toEqual(['usr_a'])
      expect(chipText('usr_a')).not.toContain('还不能使用任务')
      expect(q('access-skipped')).toBeNull()
      await submit()
      const bodies = rawCreateBodies()
      expect(bodies).toHaveLength(2)
      expect(bodies[1]).toBe(bodies[0])
      expect(JSON.parse(bodies[0]).assignees).toEqual(['usr_a'])
    })
  }

  it('S4: a people lookup answered while the create is out, then a 200: only the created panel', async () => {
    let releasePeople: (value: Response) => void = () => {}
    let releaseCreate: (value: Response) => void = () => {}
    serveTasks({
      people: peopleRoute(() => new Promise<Response>((resolve) => { releasePeople = resolve })),
      create: () => new Promise<Response>((resolve) => { releaseCreate = resolve }),
    })
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await submit()
    releasePeople(NO_TASKS_FOR_A())
    await flushUi(10)
    releaseCreate(jsonResponse(200, { id: 'tsk_9', version: 1, sourceLinked: true }))
    await flushUi(10)
    expect(q('success')).not.toBeNull()
    expect(q('access-skipped')).toBeNull()
    expect(q('assignees')).toBeNull()
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(1)
    expect(tasksCalls('POST', '/api/tasks')[0][1].assignees).toEqual(['usr_a'])
  })

  it('S5: a resend with a person from the picker answered as a matched resend writes nothing: no PATCH, one read of the task, no nudge', async () => {
    let answer: () => Response = () => jsonResponse(502, {})
    serveTasks({ people: peopleRoute(), create: () => answer() })
    let nudges = 0
    const stop = onTasksChanged(() => { nudges += 1 })
    try {
      const { container } = mountInspector()
      await flushUi()
      await openDialog(container)
      setInput('due-date', '2031-05-06')
      await pickPersonX()
      pickerQ<HTMLButtonElement>('confirm')!.click()
      await flushUi()
      expect(assigneeIds()).toEqual(['usr_a', 'usr_x'])
      await submit()
      expect(q('submit')!.textContent!.trim()).toBe('重试')
      answer = () => jsonResponse(200, { id: 'tsk_9', version: 1, reused: true, sourceLinked: true })
      await submit()
      await flushUi(10)
      const bodies = rawCreateBodies()
      expect(bodies).toHaveLength(2)
      expect(bodies[1]).toBe(bodies[0])
      expect(JSON.parse(bodies[0]).assignees).toEqual(['usr_a', 'usr_x'])
      expect(q('reused')!.querySelector('[role="status"]')!.textContent).toContain(REUSED_HEADING_ZH)
      expect(q('reused-note')!.textContent!.trim()).toBe(REUSED_NOTE_ZH)
      expect(q<HTMLAnchorElement>('open-task')!.getAttribute('href')).toBe('/tasks/tsk_9')
      // The two creates are the only writes; the one read is the check that the task can be opened.
      const writes = mocks.apiFetch.mock.calls.filter(([, init]) => (init?.method ?? 'GET') !== 'GET')
      expect(writes.map(([url, init]) => `${init.method} ${String(url)}`)).toEqual(['POST /api/tasks', 'POST /api/tasks'])
      expect(tasksCalls('PATCH', '/api/tasks/')).toHaveLength(0)
      expect(taskReads().map(([url]) => url)).toEqual(['/api/tasks/tsk_9'])
      expect(nudges).toBe(0)
    } finally {
      stop()
    }
  })
})
