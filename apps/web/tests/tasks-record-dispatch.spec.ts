/**
 * 派发任务 from a multitable record (owner ruling R-45 step 1).
 *
 * The record drawer's kebab gains 派发任务, which creates a real task through the task create wrapper
 * (`POST /api/tasks`) and then writes one source line into its description (`PATCH /api/tasks/:id`
 * with `expectedVersion`). This file mounts the REAL inspector, dialog and tasks API module; only
 * `apiFetch` (the transport), the feature-flag probe and the permission probe are replaced.
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
 *     with no other record value; with no assignee the key is omitted. The second write is a PATCH
 *     carrying exactly `expectedVersion` and a description of one source line with the record link.
 *  5. In-flight guard: a second click, a close/reopen and a move to another record and back during
 *     the create send no second create; a result that lands while the dialog is closed is shown on
 *     the next open; a late source-line write names the record the task was created from.
 *  6. Error mapping: each known failure reads as its own plain message, and the inactive-member one
 *     names nobody.
 *  7. Success: a link to /tasks/:id and a nudge to the top-bar badge; a failed description write
 *     still reports the task as created, with a note.
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
} from '../src/tasks/recordTaskDispatchRuns'
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

/** Route the transport: POST /api/tasks, PATCH /api/tasks/:id, GET /api/tasks/:id. */
function serveTasks(options: { create?: Route; patch?: Route; get?: Route } = {}) {
  mocks.apiFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET'
    if (url === '/api/tasks' && method === 'POST') {
      return options.create ? options.create(url, init) : jsonResponse(200, { id: 'tsk_9', version: 1 })
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
        apiClient: fakeApiClient(),
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
  return { container, app, vm, binding }
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
  signIn(TOKEN_A)
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
  localStorage.clear()
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
    expect(classifyDispatchFailure({ kind: 'validation', code: 'INVALID_MODE' })).toBe('FAILED')
    expect(classifyDispatchFailure({ kind: 'org_missing' })).toBe('ORG_MISSING')
    expect(classifyDispatchFailure({ kind: 'forbidden' })).toBe('FORBIDDEN')
    expect(classifyDispatchFailure({ kind: 'not_found' })).toBe('TASKS_UNAVAILABLE')
    expect(classifyDispatchFailure({ kind: 'invalid_title' })).toBe('INVALID_TITLE')
    expect(classifyDispatchFailure({ kind: 'error', status: 500 })).toBe('FAILED')
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
    // The hint is scoped to the dispatch itself: a later due reminder is outside what it promises.
    expect(q('access-note')!.textContent).toContain('派发时不会通知负责人')
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
    expect(mocks.apiFetch).not.toHaveBeenCalled()
  })

  it('sends exactly the confirmed title, assignees, mode and due keys; then the source line under expectedVersion', async () => {
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
    })
    // No other record value reaches the wire.
    expect(JSON.stringify(mocks.apiFetch.mock.calls)).not.toContain('internal note')

    const patches = tasksCalls('PATCH', '/api/tasks/')
    expect(patches).toHaveLength(1)
    expect(patches[0][0]).toBe('/api/tasks/tsk_9')
    expect(patches[0][1]).toEqual({
      expectedVersion: 1,
      description: '来源：多维表记录 /multitable/sht_1/viw_1?baseId=bse_1&recordId=rec_1',
    })
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
    expect(Object.keys(creates[0][1]).sort()).toEqual(['completionMode', 'dueDate', 'timeZone', 'title'])
  })

  it('builds the source link through the router, so a sub-path deploy keeps its base path', async () => {
    serveTasks()
    const { container } = mountInspector({ withRouter: true, routerBase: '/app/' })
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await submit()
    expect(tasksCalls('PATCH', '/api/tasks/')[0][1].description).toBe('来源：多维表记录 /app/multitable/sht_1/viw_1?baseId=bse_1&recordId=rec_1')
  })

  it('leaves baseId out of the link when the base is not known', async () => {
    serveTasks()
    const { container } = mountInspector({ baseId: undefined })
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await submit()
    expect(tasksCalls('PATCH', '/api/tasks/')[0][1].description).toBe('来源：多维表记录 /multitable/sht_1/viw_1?recordId=rec_1')
  })

  it('reads the version once when the create answer carries none', async () => {
    serveTasks({ create: () => jsonResponse(200, { id: 'tsk_9' }), get: () => jsonResponse(200, taskBody({ version: 4 })) })
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await submit()
    expect(tasksCalls('GET', '/api/tasks/tsk_9')).toHaveLength(1)
    expect(tasksCalls('PATCH', '/api/tasks/')[0][1].expectedVersion).toBe(4)
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

  it('a create that lands after a move to another record writes the link of the record it came from', async () => {
    let release: (value: Response) => void = () => {}
    serveTasks({ create: () => new Promise<Response>((resolve) => { release = resolve }) })
    const { container, vm } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await submit()
    vm.record = { ...RECORD, id: 'rec_2' } as unknown as MetaRecord
    await flushUi(6)
    release(jsonResponse(200, { id: 'tsk_9', version: 1 }))
    await flushUi(10)
    const patches = tasksCalls('PATCH', '/api/tasks/')
    expect(patches).toHaveLength(1)
    expect(patches[0][1].description).toBe('来源：多维表记录 /multitable/sht_1/viw_1?baseId=bse_1&recordId=rec_1')
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
    ['500', () => jsonResponse(500, {}), '派发任务失败'],
  ]
  for (const [name, response, message] of cases) {
    it(`${name} reads as its own plain message and creates nothing further`, async () => {
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
    expect(q('source-note-failed')).toBeNull()
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

  it('a failed description write still reports the task as created, with a note', async () => {
    serveTasks({ patch: () => jsonResponse(409, { error: { code: 'VERSION_CONFLICT' }, currentVersion: 2 }) })
    const { container } = mountInspector({ withRouter: true })
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await submit()
    expect(q('success')).not.toBeNull()
    expect(q<HTMLAnchorElement>('open-task')!.getAttribute('href')).toBe('/tasks/tsk_9')
    expect(q('source-note-failed')!.textContent).toContain('来源记录链接未能写入任务描述')
    expect(q('error')).toBeNull()
    // One create, one PATCH attempt, no retry loop on the conflict.
    expect(tasksCalls('POST', '/api/tasks')).toHaveLength(1)
    expect(tasksCalls('PATCH', '/api/tasks/')).toHaveLength(1)
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
    expect(mocks.apiFetch.mock.calls.filter(([url]) => String(url).startsWith('/api/tasks'))).toHaveLength(0)
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
    expect(tasksCalls('GET', '/api/tasks/')).toHaveLength(0)
    expect(tasksCalls('PATCH', '/api/tasks/')).toHaveLength(0)
    expectRefused()
  })

  it('a change between the version read and the description write: the write is not sent', async () => {
    let releaseRead: (value: Response) => void = () => {}
    serveTasks({
      create: () => jsonResponse(200, { id: 'tsk_9' }),
      get: () => new Promise<Response>((resolve) => { releaseRead = resolve }),
    })
    const { container } = mountInspector()
    await flushUi()
    await openDialog(container)
    setInput('due-date', '2031-05-06')
    await submit()
    expect(tasksCalls('GET', '/api/tasks/')).toHaveLength(1)
    signInElsewhere(TOKEN_B)
    releaseRead(jsonResponse(200, taskBody({ version: 1 })))
    await flushUi(10)
    expect(tasksCalls('PATCH', '/api/tasks/')).toHaveLength(0)
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
    settleDispatchRun(settledKey, settledTicket!, { created: { id: 'tsk_9', sourceNoteFailed: false } })
    const outTicket = beginDispatchRun(outKey, a)
    expect(outTicket).not.toBeNull()
    useAuth().setToken(TOKEN_B)
    await flushUi()
    expect(readDispatchRun(settledKey)).toBeUndefined()
    expect(readDispatchRun(outKey)).toBeUndefined()
    // The create that was out settles into nothing.
    settleDispatchRun(outKey, outTicket!, { created: { id: 'tsk_10', sourceNoteFailed: false } })
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
    settleDispatchRun(key, first!, { created: { id: 'tsk_old', sourceNoteFailed: false } })
    expect(readDispatchRun(key)?.inFlight).toBe(true)
    expect(readDispatchRun(key)?.created).toBeNull()
    settleDispatchRun(key, second!, { created: { id: 'tsk_new', sourceNoteFailed: false } })
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
    expect(mocks.apiFetch.mock.calls.filter(([url]) => String(url).startsWith('/api/tasks'))).toHaveLength(0)
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
    expect(mocks.apiFetch.mock.calls.filter(([url]) => String(url).startsWith('/api/tasks'))).toHaveLength(0)
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
