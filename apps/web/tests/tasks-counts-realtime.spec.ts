import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive, ref, type App as VueApp, type Component } from 'vue'

/**
 * M4 FE-c — the tasks badge's realtime invalidation, re-checked against the PR-3c emitter
 * (docs/development/task-m4-frontend-design-20261007.md §8.2, §8.3; the backend design is
 * docs/development/task-m4-pr3c-backend-design-20261008.md on the PR-3c branch, its §12 lists what
 * the frontend had to check).
 *
 * What the emitter does, as this file relies on it: after a committed write that changed an input
 * of the pending count it sends `tasks:counts-updated` with a new `{}` to the user room of every
 * assignee before or after the write, the writer included; the server joins each authenticated
 * socket to its user room itself; a settings write sends nothing; the send happens before the HTTP
 * answer; and only sockets on the backend process that handled the write receive it.
 *
 * Groups:
 *   A. gate 26, frontend half, the request: an event is followed by exactly one `/pending-count`
 *      request when its signal window closes, with the viewer's zone header and the background-read
 *      redirect suppression, and by nothing more before the 60 s tick (`gate26|重拉格`); the zone is
 *      the one the browser reports when the read is made (`gate26|时区格`).
 *   B. the window (`[fe-51]` `[fe-52]` `[fe-53]`): a burst of signals over separate macrotasks is one
 *      read; a steady stream is read once per window; a later signal opens a new window; a signal
 *      while a read is in flight is answered by a read that starts after it, and the older answer
 *      cannot overwrite it; a read that starts while a window is open (a bus nudge, a poll tick)
 *      answers it; the opposite order is two reads; a hidden tab still reads; unmount closes the
 *      window.
 *   C. the payload: never touched (a payload that records and throws on every access), any value is
 *      one signal, and no value shapes the count.
 *   D. the socket and the name: the client listens to the one event and never emits (no join); the
 *      event name is spelled once in apps/web/src (a census, with a positive control for the
 *      scanner).
 *   E. the poll is required (`[fe-08]`): a write handled by another backend process sends this tab
 *      no signal, and the next 60 s tick shows it while the socket stays connected.
 *   F. settings (`[fe-54]`): a save re-reads the badge through the bus, with no socket at all.
 *   G. the real shell: an in-app sign-out (the route moves to `/login`) unmounts the badge and
 *      closes its socket; signing in again opens a new socket with the new token; a window open at
 *      sign-out never reads; the feature switched off mid-session closes the socket at the next
 *      route change. A hard sign-out (`window.location.assign`) unloads the page, which jsdom cannot
 *      do; it is not a cell here.
 *   H. gate 26, frontend half, the window rule (`[fe-51]` `[fe-52]`, ruled 2026-10-09), one cell per
 *      clause, timed in literal milliseconds: the window is a fixed 500 ms from its first signal
 *      (`gate26|到点格`); a read that starts while it is open answers it and cancels the read the
 *      window had scheduled, a visible poll tick (`gate26|提前格|轮询`) and a bus nudge
 *      (`gate26|提前格|总线`) alike, while a hidden tick that skips its read does not (an unprefixed
 *      cell, the tab visible again before the window closes so that it does not rest on `[fe-53]`);
 *      a signal after a read has started opens a full window of its own (`gate26|另开窗口格`); a read
 *      already out when a signal arrives does not answer it: it lands inside the window, the window
 *      stays open, and a request still follows 500 ms after the signal (`gate26|在途格`).
 *
 *   The seven `gate26|` cells are the ones the design lock names for gate 26 (a cell's name is its
 *   title up to the first space, the rest is description). They are candidates, not scored until
 *   the lock PR that names them merges.
 *
 * Mock face: `socket.io-client` (a fake `io`: one recorded socket per call, its handlers, `emit` and
 * `disconnect`), `tasksRealtimePolicy` (flippable), `utils/api` (`apiFetch` plays the backend by
 * path, so the REAL `fetchPendingCount`, settings client and context loader build every request;
 * `getApiBase` is fixed), `useAuth`, `useLocale` (ZH), and for the shell `vue-router#useRoute` (a
 * reactive route), `usePlugins` and `featureFlags`. The browser zone comes from a spy on
 * `Intl.DateTimeFormat.prototype.resolvedOptions` that changes only formatters resolving to the
 * machine's own zone (the client reads the zone through a call inside its own module, which a
 * mocked export would not reach). The badge bus is real. No socket server runs here: the server
 * half of gate 26 is PR-3c's real-DB file.
 */

interface FakeSocket {
  options: unknown
  handlers: Map<string, (payload?: unknown) => void>
  emit: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  on: (event: string, handler: (payload?: unknown) => void) => FakeSocket
}

type Route = { path: string; fullPath: string; meta: Record<string, unknown> }

const h_ = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  pendingCountReply: vi.fn(),
  shouldAutoConnectRealtime: vi.fn(() => true),
  io: vi.fn(),
  sockets: [] as FakeSocket[],
  token: 'token-a' as string | null,
  zone: '',
  server: { count: 1, settings: {} as Record<string, unknown>, settingsStatus: 200 },
  // The shell (tasks-badge-m4.spec.ts group D shape, with a reactive route).
  permissions: ['tasks:read'] as string[],
  isAdmin: false,
  features: ['tasks'] as string[],
  route: null as Route | null,
  focus: { attendance: false, plm: false },
}))

vi.mock('socket.io-client', () => ({ io: h_.io }))

vi.mock('../src/tasks/tasksRealtimePolicy', () => ({
  shouldAutoConnectRealtime: h_.shouldAutoConnectRealtime,
}))

vi.mock('../src/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/api')>()
  return { ...actual, apiFetch: h_.apiFetch, getApiBase: () => 'http://example.test' }
})

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    clearToken: vi.fn(),
    getAccessSnapshot: () => ({
      email: 'viewer-a@example.test',
      roles: [],
      permissions: h_.permissions,
      isAdmin: h_.isAdmin,
    }),
    getToken: () => h_.token,
    getCurrentUserId: async () => null,
    hasPermission: (permission: string) => h_.isAdmin || h_.permissions.includes(permission),
  }),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({ locale: ref('zh-CN'), isZh: ref(true), setLocale: vi.fn() }),
}))

vi.mock('vue-router', () => ({
  useRoute: () => h_.route,
}))

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({ navItems: ref([]), fetchPlugins: vi.fn().mockResolvedValue(undefined) }),
}))

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    resolveHomePath: () => '/home',
    loadProductFeatures: vi.fn().mockResolvedValue(undefined),
    isAttendanceFocused: () => h_.focus.attendance,
    isPlmWorkbenchFocused: () => h_.focus.plm,
    hasFeature: (feature: string) => h_.features.includes(feature),
  }),
}))

import TasksTodoBadge from '../src/tasks/TasksTodoBadge.vue'
import TasksSettingsView from '../src/views/tasks/TasksSettingsView.vue'
import { notifyTasksChanged } from '../src/tasks/tasksBadgeBus'
import { TASKS_SIGNAL_WINDOW_MS } from '../src/tasks/useTasksBadge'
import { TASKS_COUNTS_UPDATED_EVENT } from '../src/tasks/useTasksCountsRealtime'

const EVENT = 'tasks:counts-updated'
const WINDOW = TASKS_SIGNAL_WINDOW_MS
/** Two zones that are neither UTC nor the zone of a machine likely to run these cells. */
const ZONE_A = 'Pacific/Chatham'
const ZONE_B = 'America/St_Johns'

const SETTINGS = Object.freeze({
  badgeScope: 'overdue',
  dailyReminderEnabled: false,
  defaultRemindPolicy: Object.freeze({ mode: 'default' }),
  timeZone: null as string | null,
})

// ---------------------------------------------------------------------------------------------
// The fake backend, the fake socket and helpers
// ---------------------------------------------------------------------------------------------

type FetchInit =
  | { method?: string; body?: string; headers?: Record<string, string>; suppressUnauthorizedRedirect?: boolean }
  | undefined

function jsonResponse(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response
}

/** What `GET /api/tasks/pending-count` answers for the server's state right now. */
function pendingBody(): Response {
  return h_.server.settings.badgeScope === 'off'
    ? jsonResponse(200, { count: 0, badgeScope: 'off' })
    : jsonResponse(200, { count: h_.server.count })
}

async function fakeBackend(path: string, init?: FetchInit): Promise<Response> {
  const method = init?.method ?? 'GET'
  if (path === '/api/tasks/pending-count') return h_.pendingCountReply()
  if (path === '/api/tasks/context') return jsonResponse(200, { orgId: 'org1' })
  if (path === '/api/task-settings' && method === 'GET') return jsonResponse(200, h_.server.settings)
  if (path === '/api/task-settings' && method === 'PATCH') {
    if (h_.server.settingsStatus !== 200) {
      return jsonResponse(h_.server.settingsStatus, { error: { code: 'INVALID_SETTINGS' } })
    }
    h_.server.settings = { ...h_.server.settings, ...JSON.parse(init?.body ?? '{}') }
    return jsonResponse(200, h_.server.settings)
  }
  return jsonResponse(404, { error: { code: 'NOT_FOUND' } })
}

function fakeSocket(_url: string, options: unknown): FakeSocket {
  const socket: FakeSocket = {
    options,
    handlers: new Map(),
    emit: vi.fn(),
    disconnect: vi.fn(),
    on(event, handler) {
      socket.handlers.set(event, handler)
      return socket
    },
  }
  h_.sockets.push(socket)
  return socket
}

function lastSocket(): FakeSocket {
  const socket = h_.sockets[h_.sockets.length - 1]
  expect(socket, 'a socket was opened').toBeTruthy()
  return socket
}

function fireEvent(payload?: unknown, socket: FakeSocket = lastSocket()): void {
  const handler = socket.handlers.get(EVENT)
  expect(handler, `no handler registered for ${EVENT}`).toBeTruthy()
  handler?.(payload)
}

function pendingCalls(): Array<[string, FetchInit]> {
  return (h_.apiFetch.mock.calls as Array<[string, FetchInit]>).filter(([path]) => path === '/api/tasks/pending-count')
}

/** How many `/pending-count` requests the client has made. */
function reads(): number {
  return pendingCalls().length
}

function patchBodies(): string[] {
  return (h_.apiFetch.mock.calls as Array<[string, FetchInit]>)
    .filter(([path, init]) => path === '/api/task-settings' && init?.method === 'PATCH')
    .map(([, init]) => init?.body as string)
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolveFn = res
  })
  return { promise, resolve: resolveFn }
}

async function flush(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

let zoneSpy: MockInstance | null = null

function installZoneSpy(): void {
  const original = Intl.DateTimeFormat.prototype.resolvedOptions
  const machineZone = original.call(new Intl.DateTimeFormat()).timeZone
  zoneSpy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
    this: Intl.DateTimeFormat,
  ) {
    const real = original.call(this)
    return real.timeZone === machineZone ? { ...real, timeZone: h_.zone } : real
  })
}

let originalVisibility: PropertyDescriptor | undefined

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
}

function restoreVisibility(): void {
  if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility)
  else delete (document as unknown as Record<string, unknown>).visibilityState
}

// ---------------------------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------------------------

let app: VueApp<Element> | null = null
let host: HTMLElement | null = null

const RouterLinkStub = defineComponent({
  props: { to: { type: [String, Object], required: true } },
  setup(props, { slots }) {
    return () => h('a', { href: String(props.to) }, slots.default ? slots.default() : [])
  },
})

function attach(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  return host
}

function mountBadge(): void {
  const el = attach()
  app = createApp(TasksTodoBadge, { label: '待办任务' })
  app.mount(el)
}

/** The badge and the settings page side by side, as the shell shows them. */
async function mountSettingsWithBadge(): Promise<HTMLElement> {
  const el = attach()
  const Host = defineComponent({
    setup: () => () => h('div', [h(TasksTodoBadge, { label: '待办任务' }), h(TasksSettingsView)]),
  })
  app = createApp(Host)
  app.component('router-link', RouterLinkStub)
  app.mount(el)
  await vi.waitFor(() => expect(el.querySelector('[data-testid="tasks-settings-form"]')).toBeTruthy())
  await flush()
  return el
}

/** The real App.vue on the reactive route (`h_.route`). */
async function mountShell(): Promise<HTMLElement> {
  const { default: App } = await import('../src/App.vue')
  const el = attach()
  app = createApp(App as Component)
  app.component('router-view', { render: () => h('div') })
  app.component('router-link', RouterLinkStub)
  app.mount(el)
  await flush()
  return el
}

async function goTo(path: string, meta: Record<string, unknown>): Promise<void> {
  const route = h_.route as Route
  route.path = path
  route.fullPath = path
  route.meta = meta
  await flush()
}

function unmountAll(): void {
  app?.unmount()
  host?.remove()
  app = null
  host = null
}

function badgeOf(root: ParentNode = document): HTMLElement | null {
  return root.querySelector('[data-testid="tasks-todo-badge"]')
}

function badgeEl(root: ParentNode = document): HTMLElement {
  const el = badgeOf(root)
  expect(el, 'the badge is mounted').toBeTruthy()
  return el as HTMLElement
}

/** `data-state|data-scope|data-count`, the attribute triple design §8.1 tells renderings apart by. */
function triple(el: HTMLElement): string {
  return `${el.getAttribute('data-state')}|${el.getAttribute('data-scope')}|${el.getAttribute('data-count')}`
}

function control(root: HTMLElement, testid: string): HTMLElement {
  const el = root.querySelector(`[data-testid="${testid}"]`)
  expect(el, `expected [data-testid="${testid}"]`).toBeTruthy()
  return el as HTMLElement
}

async function submitSettings(root: HTMLElement): Promise<void> {
  control(root, 'tasks-settings-form').dispatchEvent(new Event('submit', { cancelable: true }))
  await flush()
}

beforeEach(() => {
  h_.shouldAutoConnectRealtime.mockReset()
  h_.shouldAutoConnectRealtime.mockReturnValue(true)
  h_.io.mockReset()
  h_.io.mockImplementation(fakeSocket)
  h_.sockets.length = 0
  h_.token = 'token-a'
  h_.zone = ZONE_A
  h_.server = { count: 1, settings: { ...SETTINGS, defaultRemindPolicy: { ...SETTINGS.defaultRemindPolicy } }, settingsStatus: 200 }
  h_.pendingCountReply.mockReset()
  h_.pendingCountReply.mockImplementation(() => pendingBody())
  h_.apiFetch.mockReset()
  h_.apiFetch.mockImplementation(fakeBackend)
  h_.permissions = ['tasks:read']
  h_.isAdmin = false
  h_.features = ['tasks']
  h_.focus = { attendance: false, plm: false }
  h_.route = reactive({ path: '/multitable', fullPath: '/multitable', meta: { requiresAuth: true } as Record<string, unknown> })
  installZoneSpy()
  originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  setVisibility('visible')
})

afterEach(() => {
  unmountAll()
  vi.useRealTimers()
  zoneSpy?.mockRestore()
  zoneSpy = null
  restoreVisibility()
})

// ---------------------------------------------------------------------------------------------
// A. gate 26, frontend half: the request
//
// Like group H, timed in literal milliseconds (`t` counts from mount), not `WINDOW`.
// ---------------------------------------------------------------------------------------------

describe('A. gate 26 (frontend half): an event is one /pending-count request', () => {
  it('gate26|重拉格 an event is followed by exactly one /pending-count request, when its window closes, with the viewer zone and the redirect suppression of a background read, and by nothing more before the 60 s tick', async () => {
    vi.useFakeTimers()
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    expect(reads()).toBe(1)
    expect(badgeEl().getAttribute('data-count')).toBe('1')

    h_.server.count = 4
    fireEvent({}) // t = 0
    await vi.advanceTimersByTimeAsync(499) // t = 499
    expect(reads()).toBe(1)
    await vi.advanceTimersByTimeAsync(1) // t = 500
    await flush()
    expect(reads()).toBe(2)
    const [path, init] = pendingCalls()[1]
    expect(path).toBe('/api/tasks/pending-count')
    expect(init).toEqual({ headers: { 'x-viewer-time-zone': ZONE_A }, suppressUnauthorizedRedirect: true })
    expect(badgeEl().getAttribute('data-count')).toBe('4')

    // Exactly one: nothing else asks before the next poll tick at 60 s.
    await vi.advanceTimersByTimeAsync(59_499) // t = 59 999
    expect(reads()).toBe(2)
  })

  it('gate26|时区格 the re-read carries the zone the browser reports when the read is made, not the zone it reported at mount or when the signal arrived', async () => {
    vi.useFakeTimers()
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)
    expect(pendingCalls()[0][1]?.headers).toEqual({ 'x-viewer-time-zone': ZONE_A })

    fireEvent({}) // t = 0: the browser still reports ZONE_A
    await vi.advanceTimersByTimeAsync(250)
    h_.zone = ZONE_B // t = 250: the zone changes while the window is open
    await vi.advanceTimersByTimeAsync(249) // t = 499
    expect(reads()).toBe(1)
    await vi.advanceTimersByTimeAsync(1) // t = 500
    expect(reads()).toBe(2)
    expect(pendingCalls()[1][1]?.headers).toEqual({ 'x-viewer-time-zone': ZONE_B })
  })
})

// ---------------------------------------------------------------------------------------------
// B. the window
// ---------------------------------------------------------------------------------------------

describe('B. signals inside one window are one read ([fe-51] [fe-52] [fe-53])', () => {
  it('a burst of eight signals over separate macrotasks inside one window is one read, and its answer is what renders', async () => {
    vi.useFakeTimers()
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)
    expect(reads()).toBe(1)

    h_.server.count = 8
    for (let i = 0; i < 8; i += 1) {
      fireEvent({})
      if (i < 7) await vi.advanceTimersByTimeAsync(50)
    }
    // 350 ms after the first signal: still only the mount read.
    expect(reads()).toBe(1)
    await vi.advanceTimersByTimeAsync(WINDOW - 350)
    await flush()
    expect(reads()).toBe(2)
    expect(badgeEl().getAttribute('data-count')).toBe('8')

    await vi.advanceTimersByTimeAsync(5_000)
    expect(reads()).toBe(2)
  })

  it('a steady stream of signals is still read once per window: the window is fixed from its first signal, never pushed back', async () => {
    vi.useFakeTimers()
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)

    // One signal every 100 ms from t = 0 to t = 900; the windows close at 500 and 1000.
    for (let t = 0; t < 1_000; t += 100) {
      fireEvent({})
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(reads()).toBe(1 + 2)
  })

  it('a signal after the window has read opens a new window: one more read', async () => {
    vi.useFakeTimers()
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)

    fireEvent({})
    fireEvent({})
    await vi.advanceTimersByTimeAsync(WINDOW)
    expect(reads()).toBe(2)

    fireEvent({})
    fireEvent({})
    await vi.advanceTimersByTimeAsync(WINDOW)
    expect(reads()).toBe(3)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('a signal while a read is in flight is not answered by that read: the window still reads after it, even when the older read lands first', async () => {
    vi.useFakeTimers()
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)
    expect(reads()).toBe(1)

    // A bus nudge starts a read that the server answers from before the write.
    const stale = deferred<Response>()
    h_.pendingCountReply.mockReturnValueOnce(stale.promise)
    notifyTasksChanged()
    expect(reads()).toBe(2)

    // The write commits; its signal lands while that read is still out.
    fireEvent({})
    await vi.advanceTimersByTimeAsync(100)
    stale.resolve(jsonResponse(200, { count: 1 }))
    await flush()
    expect(badgeEl().getAttribute('data-count')).toBe('1')

    h_.server.count = 2
    await vi.advanceTimersByTimeAsync(WINDOW - 100)
    await flush()
    expect(reads()).toBe(3)
    expect(badgeEl().getAttribute('data-count')).toBe('2')
  })

  it('the older in-flight answer landing after the window\'s read cannot overwrite it', async () => {
    vi.useFakeTimers()
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)

    const stale = deferred<Response>()
    h_.pendingCountReply.mockReturnValueOnce(stale.promise)
    notifyTasksChanged()
    fireEvent({})
    h_.server.count = 2
    await vi.advanceTimersByTimeAsync(WINDOW)
    await flush()
    expect(reads()).toBe(3)
    expect(badgeEl().getAttribute('data-count')).toBe('2')

    stale.resolve(jsonResponse(200, { count: 1 }))
    await flush()
    expect(badgeEl().getAttribute('data-count')).toBe('2')
  })

  it('[fe-52] the viewer\'s own write, signal first and the bus nudge after it: one read', async () => {
    vi.useFakeTimers()
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)

    // The server signals the writer before it answers the write; the page nudges after the answer.
    fireEvent({})
    await vi.advanceTimersByTimeAsync(20)
    notifyTasksChanged()
    expect(reads()).toBe(2)
    await vi.advanceTimersByTimeAsync(WINDOW)
    expect(reads()).toBe(2)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('[fe-52] a poll tick inside an open window answers it: no second read when the window would have closed', async () => {
    vi.useFakeTimers()
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(60_000 - 200)
    fireEvent({})
    // t = 60 000: the poll tick reads.
    await vi.advanceTimersByTimeAsync(200)
    expect(reads()).toBe(2)
    // t = 60 500: the window had nothing left to do.
    await vi.advanceTimersByTimeAsync(WINDOW)
    expect(reads()).toBe(2)
  })

  it('the opposite order, the bus nudge first and the signal after it, is two reads: a signal cannot be matched to a read that started before it', async () => {
    vi.useFakeTimers()
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)

    notifyTasksChanged()
    expect(reads()).toBe(2)
    fireEvent({})
    await vi.advanceTimersByTimeAsync(WINDOW)
    expect(reads()).toBe(3)
  })

  it('[fe-53] a hidden tab still reads when the window closes, while its poll tick is skipped', async () => {
    vi.useFakeTimers()
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)

    setVisibility('hidden')
    fireEvent({})
    await vi.advanceTimersByTimeAsync(WINDOW)
    expect(reads()).toBe(2)
    // t = 60 000: the poll tick skips the hidden tab.
    await vi.advanceTimersByTimeAsync(60_000 - WINDOW)
    expect(reads()).toBe(2)
  })

  it('unmount with a window open: the window never reads and no timer is left', async () => {
    vi.useFakeTimers()
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)

    fireEvent({})
    await vi.advanceTimersByTimeAsync(WINDOW / 2)
    unmountAll()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(reads()).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------
// C. the payload
// ---------------------------------------------------------------------------------------------

describe('C. the payload is not read', () => {
  it('a payload that records and throws on every access is one signal, and nothing touched it', async () => {
    vi.useFakeTimers()
    const touched: string[] = []
    const trap = (name: string) => (...args: unknown[]): never => {
      touched.push(`${name}:${String(args[1] ?? '')}`)
      throw new Error(`the payload was touched (${name})`)
    }
    const payload = new Proxy(
      { count: 99, badgeScope: 'off' },
      {
        get: trap('get'),
        has: trap('has'),
        ownKeys: trap('ownKeys'),
        getOwnPropertyDescriptor: trap('getOwnPropertyDescriptor'),
        getPrototypeOf: trap('getPrototypeOf'),
        set: trap('set'),
        defineProperty: trap('defineProperty'),
        deleteProperty: trap('deleteProperty'),
        isExtensible: trap('isExtensible'),
        preventExtensions: trap('preventExtensions'),
        setPrototypeOf: trap('setPrototypeOf'),
      },
    )
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)

    h_.server.count = 3
    expect(() => fireEvent(payload)).not.toThrow()
    await vi.advanceTimersByTimeAsync(WINDOW)
    await flush()
    expect(touched).toEqual([])
    expect(reads()).toBe(2)
    expect(triple(badgeEl())).toBe('ready|on|3')
  })

  it.each([
    [
      'an object with fields the contract does not have',
      { count: 99, badgeScope: 'off', taskId: 'tsk_x', orgId: 'org2', reason: 'assignee-added', updatedAt: '2026-10-08T00:00:00.000Z' },
    ],
    ['an array', [1, 2, 3]],
    ['a number', 42],
    ['false', false],
    ['a frozen nested object', Object.freeze({ counts: Object.freeze({ pending: 5 }) })],
    ['the empty object the server sends', {}],
  ])('a payload of %s is one signal and never shapes the count', async (_label, payload) => {
    vi.useFakeTimers()
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)

    h_.server.count = 6
    fireEvent(payload)
    await vi.advanceTimersByTimeAsync(WINDOW)
    await flush()
    expect(reads()).toBe(2)
    expect(triple(badgeEl())).toBe('ready|on|6')
  })
})

// ---------------------------------------------------------------------------------------------
// D. the socket and the event name
// ---------------------------------------------------------------------------------------------

describe('D. the client listens and never speaks; the event name has one spelling', () => {
  it('the client never emits on its socket (no join, no subscribe message), listens to the one event, and carries the token in auth only', async () => {
    vi.useFakeTimers()
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)
    expect(h_.io).toHaveBeenCalledTimes(1)
    expect(h_.io).toHaveBeenCalledWith('http://example.test', {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      auth: { token: 'token-a' },
    })
    const socket = lastSocket()
    expect([...socket.handlers.keys()]).toEqual([EVENT])

    fireEvent({})
    fireEvent({})
    await vi.advanceTimersByTimeAsync(WINDOW)
    unmountAll()
    expect(socket.emit).not.toHaveBeenCalled()
    expect(socket.disconnect).toHaveBeenCalledTimes(1)
  })

  const SRC = join(__dirname, '../src')
  const COMMENT_LINE = /^\s*(\*|\/\/|\/\*|<!--)/
  const EVENT_LITERAL = /(['"`])tasks:counts-updated\1/g

  function sourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...sourceFiles(full))
      else if (/\.(ts|vue|js|mjs)$/.test(entry.name)) out.push(full)
    }
    return out
  }

  /** Quoted spellings of the event name on lines that are not comment lines. */
  function eventLiterals(source: string): number {
    let found = 0
    for (const line of source.split('\n')) {
      if (COMMENT_LINE.test(line)) continue
      found += (line.match(EVENT_LITERAL) ?? []).length
    }
    return found
  }

  it('the census scanner finds the name in every quote style on code lines and nothing on comment lines (its positive control)', () => {
    const sample = [
      "export const A = 'tasks:counts-updated'",
      'const B = "tasks:counts-updated"',
      'const C = `tasks:counts-updated`',
      "socket.on('tasks:counts-updated', handler) // a trailing note",
      ' * `tasks:counts-updated` on a docblock line',
      "// 'tasks:counts-updated' in a line comment",
      "/** 'tasks:counts-updated' on the first line of a docblock */",
      "<!-- 'tasks:counts-updated' in a template comment -->",
      "const D = 'tasks:counts-updated-later' // a longer name is another name",
    ].join('\n')
    expect(eventLiterals(sample)).toBe(4)
  })

  it('apps/web/src spells the event name once, as the exported constant, and the subscription passes that constant', () => {
    const files = sourceFiles(SRC)
    // A path typo that scans nothing must not pass.
    expect(files.length).toBeGreaterThan(200)
    expect(files.map((file) => relative(SRC, file))).toContain('tasks/useTasksCountsRealtime.ts')

    const hits = files.flatMap((file) => {
      const found = eventLiterals(readFileSync(file, 'utf8'))
      return found > 0 ? [[relative(SRC, file), found] as const] : []
    })
    expect(hits).toEqual([['tasks/useTasksCountsRealtime.ts', 1]])

    const composable = readFileSync(join(SRC, 'tasks/useTasksCountsRealtime.ts'), 'utf8')
    expect(composable).toContain("export const TASKS_COUNTS_UPDATED_EVENT = 'tasks:counts-updated'")
    expect(composable.split('.on(TASKS_COUNTS_UPDATED_EVENT,').length - 1).toBe(1)
    expect(TASKS_COUNTS_UPDATED_EVENT).toBe(EVENT)
  })
})

// ---------------------------------------------------------------------------------------------
// E. the poll is required
// ---------------------------------------------------------------------------------------------

describe('E. the 60 s poll is the other half ([fe-08])', () => {
  it('a write handled by another backend process sends this tab no signal: with the socket connected throughout, the next 60 s tick is what shows it', async () => {
    vi.useFakeTimers()
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    expect(badgeEl().getAttribute('data-count')).toBe('1')

    // Written through another process: nothing arrives on this socket.
    h_.server.count = 2
    await vi.advanceTimersByTimeAsync(60_000 - 1)
    await flush()
    expect(badgeEl().getAttribute('data-count')).toBe('1')
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(badgeEl().getAttribute('data-count')).toBe('2')
    expect(h_.io).toHaveBeenCalledTimes(1)
    expect(lastSocket().disconnect).not.toHaveBeenCalled()
  })

  it('with the socket connected and the first read failing, the 60 s poll keeps asking and the badge recovers without any signal', async () => {
    vi.useFakeTimers()
    h_.pendingCountReply.mockReturnValueOnce(jsonResponse(500, { error: { code: 'INTERNAL' } }))
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    expect(triple(badgeEl())).toBe('unavailable||')
    expect(h_.io).toHaveBeenCalledTimes(1)

    h_.server.count = 3
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()
    expect(reads()).toBe(2)
    expect(triple(badgeEl())).toBe('ready|on|3')
  })
})

// ---------------------------------------------------------------------------------------------
// F. settings
// ---------------------------------------------------------------------------------------------

describe('F. a settings save re-reads the badge without any signal ([fe-54])', () => {
  it('saving the badge scope off re-reads /pending-count once through the bus, with no socket at all, and the badge switches off', async () => {
    h_.shouldAutoConnectRealtime.mockReturnValue(false)
    const el = await mountSettingsWithBadge()
    expect(reads()).toBe(1)
    expect(triple(badgeEl(el))).toBe('ready|on|1')

    control(el, 'tasks-settings-badge-scope-off').click()
    await flush()
    await submitSettings(el)
    await vi.waitFor(() => expect(triple(badgeEl(el))).toBe('ready|off|0'))
    expect(patchBodies()).toEqual(['{"badgeScope":"off"}'])
    expect(reads()).toBe(2)
    expect(h_.io).not.toHaveBeenCalled()
  })

  it('saving it back on re-reads once more and the numeral returns', async () => {
    h_.shouldAutoConnectRealtime.mockReturnValue(false)
    h_.server.settings = { ...h_.server.settings, badgeScope: 'off' }
    h_.server.count = 5
    const el = await mountSettingsWithBadge()
    expect(triple(badgeEl(el))).toBe('ready|off|0')

    control(el, 'tasks-settings-badge-scope-overdue_or_today').click()
    await flush()
    await submitSettings(el)
    await vi.waitFor(() => expect(triple(badgeEl(el))).toBe('ready|on|5'))
    expect(patchBodies()).toEqual(['{"badgeScope":"overdue_or_today"}'])
    expect(reads()).toBe(2)
    expect(badgeEl(el).textContent).toBe('5')
  })

  it('a save that leaves the badge scope alone (the daily reminder) re-reads the badge once as well', async () => {
    h_.shouldAutoConnectRealtime.mockReturnValue(false)
    const el = await mountSettingsWithBadge()
    expect(reads()).toBe(1)

    control(el, 'tasks-settings-daily-reminder').click()
    await flush()
    await submitSettings(el)
    await vi.waitFor(() => expect(control(el, 'tasks-settings-saved')).toBeTruthy())
    expect(patchBodies()).toEqual([JSON.stringify({ dailyReminderEnabled: true, timeZone: ZONE_A })])
    expect(reads()).toBe(2)
  })

  it('a save the server refuses re-reads nothing', async () => {
    h_.shouldAutoConnectRealtime.mockReturnValue(false)
    h_.server.settingsStatus = 422
    const el = await mountSettingsWithBadge()

    control(el, 'tasks-settings-badge-scope-off').click()
    await flush()
    await submitSettings(el)
    await vi.waitFor(() => expect(control(el, 'tasks-settings-save-error')).toBeTruthy())
    expect(patchBodies()).toHaveLength(1)
    expect(reads()).toBe(1)
    expect(triple(badgeEl(el))).toBe('ready|on|1')
  })
})

// ---------------------------------------------------------------------------------------------
// G. sign-out, sign-in and the feature gate on the real shell
// ---------------------------------------------------------------------------------------------

describe('G. the socket follows the badge on the real shell (policy forced on)', () => {
  it('an in-app sign-out moves the route to /login: the badge unmounts, its socket disconnects once, and a late event on that socket reads nothing', async () => {
    vi.useFakeTimers()
    const root = await mountShell()
    await vi.advanceTimersByTimeAsync(0)
    expect(badgeOf(root)).toBeTruthy()
    expect(h_.io).toHaveBeenCalledTimes(1)
    const first = lastSocket()
    const handler = first.handlers.get(EVENT)
    expect(handler).toBeTruthy()
    const before = reads()

    h_.token = null
    await goTo('/login', {})
    expect(badgeOf(root)).toBeNull()
    expect(first.disconnect).toHaveBeenCalledTimes(1)

    handler?.({})
    await vi.advanceTimersByTimeAsync(WINDOW * 4)
    expect(reads()).toBe(before)
    expect(h_.io).toHaveBeenCalledTimes(1)
  })

  it('signing in again: back on an ordinary route the badge opens a NEW socket with the new token, and only that socket is heard', async () => {
    vi.useFakeTimers()
    const root = await mountShell()
    await vi.advanceTimersByTimeAsync(0)
    const first = lastSocket()

    h_.token = null
    await goTo('/login', {})
    h_.token = 'token-b'
    await goTo('/multitable', { requiresAuth: true })
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    expect(badgeOf(root)).toBeTruthy()
    expect(h_.io).toHaveBeenCalledTimes(2)
    const second = lastSocket()
    expect(second).not.toBe(first)
    expect(second.options).toEqual({ path: '/socket.io', transports: ['websocket', 'polling'], auth: { token: 'token-b' } })
    expect(first.disconnect).toHaveBeenCalledTimes(1)
    expect(second.disconnect).not.toHaveBeenCalled()

    const before = reads()
    fireEvent({}, first)
    await vi.advanceTimersByTimeAsync(WINDOW)
    expect(reads()).toBe(before)
    fireEvent({}, second)
    await vi.advanceTimersByTimeAsync(WINDOW)
    expect(reads()).toBe(before + 1)
  })

  it('a signal window open at sign-out never reads', async () => {
    vi.useFakeTimers()
    await mountShell()
    await vi.advanceTimersByTimeAsync(0)
    const before = reads()

    fireEvent({})
    await vi.advanceTimersByTimeAsync(WINDOW / 2)
    h_.token = null
    await goTo('/login', {})
    await vi.advanceTimersByTimeAsync(WINDOW * 4)
    expect(reads()).toBe(before)
  })

  it('the tasks feature switched off mid-session: at the next route change the entry and the badge go, the socket disconnects, and nothing reads after', async () => {
    vi.useFakeTimers()
    const root = await mountShell()
    await vi.advanceTimersByTimeAsync(0)
    expect(root.querySelector('[data-testid="nav-tasks"]')).toBeTruthy()
    const socket = lastSocket()

    h_.features = []
    await goTo('/multitable/next', { requiresAuth: true })
    expect(root.querySelector('[data-testid="nav-tasks"]')).toBeNull()
    expect(badgeOf(root)).toBeNull()
    expect(socket.disconnect).toHaveBeenCalledTimes(1)

    const before = reads()
    socket.handlers.get(EVENT)?.({})
    await vi.advanceTimersByTimeAsync(60_000 + WINDOW)
    expect(reads()).toBe(before)
    expect(h_.io).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------------------------
// H. gate 26, frontend half: the window rule, one cell per clause (`[fe-51]` `[fe-52]`, ruled
// 2026-10-09)
//
// Times are literal milliseconds (`t` counts from mount, where the 60 s clock starts), not
// `WINDOW`, so the ruled length is pinned as a number: a window of any other length turns these
// cells red, where the cells of groups B to G, timed off the exported constant, would follow it.
// ---------------------------------------------------------------------------------------------

describe('H. gate 26 (frontend half): the window rule, one cell per clause ([fe-51] [fe-52], ruled 2026-10-09)', () => {
  it('gate26|到点格 a fixed 500 ms window: the first signal is read exactly 500 ms later, and a signal inside the window neither reads nor pushes that read back', async () => {
    expect(TASKS_SIGNAL_WINDOW_MS).toBe(500)
    vi.useFakeTimers()
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)
    expect(reads()).toBe(1)

    h_.server.count = 3
    fireEvent({}) // t = 0: opens the window
    await vi.advanceTimersByTimeAsync(450)
    fireEvent({}) // t = 450: absorbed
    await vi.advanceTimersByTimeAsync(49) // t = 499
    expect(reads()).toBe(1)
    await vi.advanceTimersByTimeAsync(1) // t = 500
    expect(reads()).toBe(2)
    await flush()
    expect(badgeEl().getAttribute('data-count')).toBe('3')

    // The signal at 450 was answered by that read: nothing more before the 60 s tick.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(reads()).toBe(2)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('gate26|提前格|轮询 a visible poll tick that starts while the window is open answers its signal: the read the window had scheduled is cancelled, and the tick is the only read of that window', async () => {
    vi.useFakeTimers()
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)
    expect(reads()).toBe(1)
    expect(vi.getTimerCount()).toBe(1) // the 60 s clock

    await vi.advanceTimersByTimeAsync(59_550)
    fireEvent({}) // t = 59 550: opens the window, its read scheduled for 60 050
    expect(vi.getTimerCount()).toBe(2)
    h_.server.count = 5
    await vi.advanceTimersByTimeAsync(450) // t = 60 000: the tick reads, 450 ms into the window
    expect(reads()).toBe(2)
    expect(vi.getTimerCount()).toBe(1)
    await flush()
    expect(badgeEl().getAttribute('data-count')).toBe('5')
    await vi.advanceTimersByTimeAsync(1_000) // t = 61 000: past the time the window would have read
    expect(reads()).toBe(2)
  })

  it('gate26|提前格|总线 a bus nudge that starts while the window is open answers its signal: the read the window had scheduled is cancelled, and the nudge is the only read of that window', async () => {
    vi.useFakeTimers()
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)
    expect(reads()).toBe(1)
    expect(vi.getTimerCount()).toBe(1) // the 60 s clock

    await vi.advanceTimersByTimeAsync(1_000)
    fireEvent({}) // t = 1 000: opens the window, its read scheduled for 1 500
    expect(vi.getTimerCount()).toBe(2)
    await vi.advanceTimersByTimeAsync(450)
    h_.server.count = 5
    notifyTasksChanged() // t = 1 450: a read starts, 450 ms into the window
    expect(reads()).toBe(2)
    expect(vi.getTimerCount()).toBe(1)
    await flush()
    expect(badgeEl().getAttribute('data-count')).toBe('5')
    await vi.advanceTimersByTimeAsync(1_000) // t = 2 450: past the time the window would have read
    expect(reads()).toBe(2)
  })

  it('a poll tick skipped in a hidden tab is not a read that starts and answers nothing: the window stays open and reads 500 ms after its signal (the tab is visible again by then, so this cell does not rest on [fe-53])', async () => {
    vi.useFakeTimers()
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)
    expect(reads()).toBe(1)

    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(59_800)
    fireEvent({}) // t = 59 800: the window reads at 60 300
    await vi.advanceTimersByTimeAsync(200) // t = 60 000: the hidden tab skips the tick's read
    expect(reads()).toBe(1)
    expect(vi.getTimerCount()).toBe(2)
    // Visible again before the window closes, so the read below does not depend on whether a
    // hidden tab reads when a window closes ([fe-53], still this PR's own choice).
    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(299) // t = 60 299
    expect(reads()).toBe(1)
    await vi.advanceTimersByTimeAsync(1) // t = 60 300
    expect(reads()).toBe(2)
  })

  it('gate26|另开窗口格 a signal that arrives after a read has started opens a window of its own, a full 500 ms from that signal, while that read is still out', async () => {
    vi.useFakeTimers()
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)
    expect(reads()).toBe(1)

    // The first window's own read is held out.
    const held = deferred<Response>()
    h_.pendingCountReply.mockReturnValueOnce(held.promise)
    fireEvent({}) // t = 0
    await vi.advanceTimersByTimeAsync(500) // t = 500: the window reads, its answer held
    expect(reads()).toBe(2)

    // 100 ms after that read started, before it lands.
    await vi.advanceTimersByTimeAsync(100)
    h_.server.count = 6
    fireEvent({}) // t = 600: a new window, reading at 1 100
    await vi.advanceTimersByTimeAsync(499) // t = 1 099
    expect(reads()).toBe(2)
    await vi.advanceTimersByTimeAsync(1) // t = 1 100
    expect(reads()).toBe(3)
    await flush()
    expect(badgeEl().getAttribute('data-count')).toBe('6')

    // The held read lands last; it started before the newer one, so its answer is dropped.
    held.resolve(jsonResponse(200, { count: 1 }))
    await flush(8)
    expect(badgeEl().getAttribute('data-count')).toBe('6')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(reads()).toBe(3)
  })

  it('gate26|在途格 a read already out when a signal arrives does not answer it: that read lands inside the window, the window stays open, a request still follows 500 ms after the signal, and its answer is what renders', async () => {
    vi.useFakeTimers()
    // The mount read is held out; the server answers it from before the write.
    const held = deferred<Response>()
    h_.pendingCountReply.mockReturnValueOnce(held.promise)
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)
    expect(reads()).toBe(1)

    // The write commits and its signal arrives while the mount read is still out.
    await vi.advanceTimersByTimeAsync(50)
    h_.server.count = 2
    fireEvent({}) // t = 50: the window reads at 550
    await vi.advanceTimersByTimeAsync(50)
    held.resolve(jsonResponse(200, { count: 1 })) // t = 100: the older answer lands inside the window
    await flush(8)
    expect(badgeEl().getAttribute('data-count')).toBe('1')
    expect(vi.getTimerCount()).toBe(2)

    await vi.advanceTimersByTimeAsync(449) // t = 549
    expect(reads()).toBe(1)
    await vi.advanceTimersByTimeAsync(1) // t = 550
    expect(reads()).toBe(2)
    await flush()
    expect(badgeEl().getAttribute('data-count')).toBe('2')
  })
})
