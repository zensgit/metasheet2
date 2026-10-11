import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Component } from 'vue'

/**
 * M4 FE-2 — the tasks badge's switched-off scope and its realtime invalidation
 * (docs/development/task-m4-frontend-design-20261007.md §8, §10.1 row `tasks-badge-m4`).
 *
 * Four groups:
 *
 *   A. `badgeScope: 'off'` rendering (§8.1): the node stays, `data-state` is still one of the three
 *      M2 values, `data-scope` carries the scope, no numeral is rendered, `data-count` is the
 *      server's `0`, the aria-label is the §8.1 copy; "off", "zero pending" and "unavailable" are
 *      told apart by attribute string alone; the scope follows every later answer.
 *   B. the `tasks:counts-updated` subscription THROUGH the badge (§8.2): an event is one re-read of
 *      `fetchPendingCount` once its signal window closes (FE-c, `[fe-51]`), nothing in the payload is
 *      read, a bus nudge while a window is open answers the signal (`[fe-52]`), the generation guard
 *      keeps only the newest answer, an event after a 404 still re-reads (and `ok` restarts the
 *      clock), an event after unmount reads nothing, and the 60 s poll keeps running beside the
 *      socket (`[fe-08]`). FE-c's burst, in-flight, header, payload, no-join, census, settings and
 *      sign-out cells are in tasks-counts-realtime.spec.ts.
 *   C. the composable's own contract (`useTasksCountsRealtime`): connection arguments, the
 *      no-argument callback, explicit `reconnect()` (`[fe-11]`), de-duplication, no token (and a
 *      token that arrives after attempts without one), teardown, the base-URL suffix strip,
 *      `isCountsInvalidation`, and the real policy module's value under the test build and a
 *      stubbed non-test build.
 *   D. the gate (§8.2): the REAL `App.vue`, in the shape of `tasks-nav-badge.spec.ts`, with the
 *      policy module forced to `true` so the socket mount is observable — feature on means exactly
 *      one `io()` call (positive control, not a no-op); feature off / no `tasks:read` / a public
 *      route / a focused shell mean zero. With the policy left at its test-build value both sides
 *      would be zero and the cells would prove nothing.
 *
 * Mock face: `socket.io-client` (a fake `io` that records handlers), `tasksRealtimePolicy`
 * (flippable per case), `tasksApi.fetchPendingCount`, and for the shell: `vue-router`'s `useRoute`,
 * `usePlugins`, `featureFlags`, `useLocale`, `useAuth`, `utils/api#getApiBase`. The backend emitter
 * is PR-3c (a Draft branch); FE-c re-checked the event name, the payload rule and the rest of
 * design §8.3 against it. No real socket server is involved anywhere in this file.
 */

const h_ = vi.hoisted(() => ({
  fetchPendingCount: vi.fn(),
  shouldAutoConnectRealtime: vi.fn(() => true),
  socketHandlers: new Map<string, (payload?: unknown) => void>(),
  disconnect: vi.fn(),
  io: vi.fn(),
  token: 'session-token' as string | null,
  // Shell mocks (tasks-nav-badge.spec.ts shape).
  permissions: ['tasks:read'] as string[],
  isAdmin: false,
  features: ['tasks'] as string[],
  routePath: '/multitable',
  routeMeta: { requiresAuth: true } as Record<string, unknown>,
  focus: { attendance: false, plm: false },
}))

function fakeSocket() {
  return {
    on: (event: string, handler: (payload?: unknown) => void) => {
      h_.socketHandlers.set(event, handler)
    },
    disconnect: h_.disconnect,
  }
}

vi.mock('socket.io-client', () => ({ io: h_.io }))

vi.mock('../src/tasks/tasksRealtimePolicy', () => ({
  shouldAutoConnectRealtime: h_.shouldAutoConnectRealtime,
}))

vi.mock('../src/tasks/tasksApi', () => ({
  fetchPendingCount: (...args: unknown[]) => h_.fetchPendingCount(...args),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ path: h_.routePath, fullPath: h_.routePath, meta: h_.routeMeta }),
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

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({ locale: ref('zh-CN'), isZh: ref(true), setLocale: vi.fn() }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    clearToken: vi.fn(),
    getAccessSnapshot: () => ({
      email: 'tasks-viewer@test.local',
      roles: [],
      permissions: h_.permissions,
      isAdmin: h_.isAdmin,
    }),
    getToken: () => h_.token,
    hasPermission: (permission: string) => h_.isAdmin || h_.permissions.includes(permission),
  }),
}))

vi.mock('../src/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/api')>()
  return { ...actual, getApiBase: () => 'http://example.test' }
})

import TasksTodoBadge from '../src/tasks/TasksTodoBadge.vue'
import { notifyTasksChanged } from '../src/tasks/tasksBadgeBus'
import { TASKS_SIGNAL_WINDOW_MS } from '../src/tasks/useTasksBadge'
import {
  TASKS_COUNTS_UPDATED_EVENT,
  isCountsInvalidation,
  resolveTasksCountsRealtimeBaseUrl,
  useTasksCountsRealtime,
} from '../src/tasks/useTasksCountsRealtime'

const EVENT = 'tasks:counts-updated'
/** FE-c: a signal is read when its window closes (`[fe-51]`). */
const WINDOW = TASKS_SIGNAL_WINDOW_MS

let app: VueApp<Element> | null = null
let host: HTMLElement | null = null
let exposed: { state?: string; count?: number | null; scope?: string | null } | null = null

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolveFn = res
  })
  return { promise, resolve: resolveFn }
}

async function flush(cycles = 3): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function badgeEl(): HTMLElement {
  const el = host?.querySelector('[data-testid="tasks-todo-badge"]')
  expect(el).toBeTruthy()
  return el as HTMLElement
}

/** `data-state|data-scope|data-count` — the attribute triple §8.1 says tells the renderings apart. */
function triple(el: HTMLElement): string {
  return `${el.getAttribute('data-state')}|${el.getAttribute('data-scope')}|${el.getAttribute('data-count')}`
}

function fireEvent(payload?: unknown): void {
  const handler = h_.socketHandlers.get(EVENT)
  expect(handler, `no handler registered for ${EVENT}`).toBeTruthy()
  handler?.(payload)
}

function mountBadge(label = '待办任务'): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(TasksTodoBadge, { label })
  exposed = app.mount(host) as unknown as typeof exposed
}

function unmountAll(): void {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  exposed = null
}

beforeEach(() => {
  h_.fetchPendingCount.mockReset()
  h_.fetchPendingCount.mockResolvedValue({ kind: 'ok', count: 0 })
  h_.shouldAutoConnectRealtime.mockReset()
  h_.shouldAutoConnectRealtime.mockReturnValue(true)
  h_.io.mockReset()
  h_.io.mockImplementation(fakeSocket)
  h_.disconnect.mockReset()
  h_.socketHandlers.clear()
  h_.token = 'session-token'
  h_.permissions = ['tasks:read']
  h_.isAdmin = false
  h_.features = ['tasks']
  h_.routePath = '/multitable'
  h_.routeMeta = { requiresAuth: true }
  h_.focus = { attendance: false, plm: false }
})

afterEach(() => {
  unmountAll()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

// ---------------------------------------------------------------------------------------------
// A. `badgeScope: 'off'` — the rendering (§8.1)
// ---------------------------------------------------------------------------------------------

describe('A. TasksTodoBadge switched off (badgeScope: off)', () => {
  it('renders a persistent ready node with data-scope="off", data-count="0", no numeral, the off class and the §8.1 aria-label', async () => {
    h_.fetchPendingCount.mockResolvedValue({ kind: 'ok', count: 0, badgeScope: 'off' })
    mountBadge('待办任务')
    await flush()
    const el = badgeEl()
    expect(el.getAttribute('data-state')).toBe('ready')
    expect(el.getAttribute('data-scope')).toBe('off')
    expect(el.getAttribute('data-count')).toBe('0')
    expect(el.textContent).toBe('')
    expect(el.classList.contains('tasks-todo-badge--off')).toBe(true)
    expect(el.classList.contains('tasks-todo-badge--unavailable')).toBe(false)
    expect(el.getAttribute('aria-label')).toBe('待办任务红点已关闭')
    expect(el.getAttribute('title')).toBe('待办任务红点已关闭')
    expect(exposed?.scope).toBe('off')
    expect(exposed?.count).toBe(0)
  })

  it('zero pending with the scope on renders the numeral "0", data-scope="on" and the count aria-label', async () => {
    h_.fetchPendingCount.mockResolvedValue({ kind: 'ok', count: 0 })
    mountBadge('待办任务')
    await flush()
    const el = badgeEl()
    expect(el.getAttribute('data-state')).toBe('ready')
    expect(el.getAttribute('data-scope')).toBe('on')
    expect(el.getAttribute('data-count')).toBe('0')
    expect(el.textContent).toBe('0')
    expect(el.classList.contains('tasks-todo-badge--off')).toBe(false)
    expect(el.getAttribute('aria-label')).toBe('待办任务0')
    expect(exposed?.scope).toBe('on')
  })

  it('a positive count with the scope on renders the numeral and data-scope="on"', async () => {
    h_.fetchPendingCount.mockResolvedValue({ kind: 'ok', count: 7 })
    mountBadge()
    await flush()
    const el = badgeEl()
    expect(el.getAttribute('data-scope')).toBe('on')
    expect(el.getAttribute('data-count')).toBe('7')
    expect(el.textContent).toBe('7')
  })

  // The client folds every non-'off' value before it reaches the composable ([fe-14]); this pins
  // the composable's own rule for a value that would slip past that fold.
  it('any badgeScope value other than the literal "off" reads as on', async () => {
    h_.fetchPendingCount.mockResolvedValue({ kind: 'ok', count: 2, badgeScope: 'overdue' })
    mountBadge()
    await flush()
    const el = badgeEl()
    expect(el.getAttribute('data-scope')).toBe('on')
    expect(el.getAttribute('data-count')).toBe('2')
    expect(el.textContent).toBe('2')
  })

  it('the loading state has an empty data-scope (present, not missing)', async () => {
    h_.fetchPendingCount.mockReturnValue(new Promise(() => {}))
    mountBadge()
    await flush()
    const el = badgeEl()
    expect(el.getAttribute('data-state')).toBe('loading')
    expect(el.hasAttribute('data-scope')).toBe(true)
    expect(el.getAttribute('data-scope')).toBe('')
    expect(el.getAttribute('data-count')).toBe('')
    expect(exposed?.scope).toBeNull()
  })

  it.each([
    ['org_missing', { kind: 'org_missing' }],
    ['forbidden', { kind: 'forbidden' }],
    ['not_found', { kind: 'not_found' }],
    ['error 500', { kind: 'error', status: 500 }],
  ])('the unavailable state (%s) has an empty data-scope and an empty data-count', async (_label, result) => {
    h_.fetchPendingCount.mockResolvedValue(result)
    mountBadge()
    await flush()
    const el = badgeEl()
    expect(el.getAttribute('data-state')).toBe('unavailable')
    expect(el.hasAttribute('data-scope')).toBe(true)
    expect(el.getAttribute('data-scope')).toBe('')
    expect(el.getAttribute('data-count')).toBe('')
    expect(el.textContent).toBe('!')
    expect(el.classList.contains('tasks-todo-badge--off')).toBe(false)
  })

  it('switched off, zero pending and unavailable are three distinct attribute triples', async () => {
    h_.fetchPendingCount.mockResolvedValue({ kind: 'ok', count: 0, badgeScope: 'off' })
    mountBadge()
    await flush()
    const off = triple(badgeEl())
    unmountAll()

    h_.fetchPendingCount.mockResolvedValue({ kind: 'ok', count: 0 })
    mountBadge()
    await flush()
    const zero = triple(badgeEl())
    unmountAll()

    h_.fetchPendingCount.mockResolvedValue({ kind: 'error', status: 500 })
    mountBadge()
    await flush()
    const unavailable = triple(badgeEl())

    expect(off).toBe('ready|off|0')
    expect(zero).toBe('ready|on|0')
    expect(unavailable).toBe('unavailable||')
    expect(new Set([off, zero, unavailable]).size).toBe(3)
  })

  it('the scope follows every later answer: off -> unavailable clears it, -> on shows the numeral, -> off hides it again', async () => {
    vi.useFakeTimers()
    h_.fetchPendingCount.mockResolvedValueOnce({ kind: 'ok', count: 0, badgeScope: 'off' })
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)
    expect(triple(badgeEl())).toBe('ready|off|0')

    h_.fetchPendingCount.mockResolvedValueOnce({ kind: 'error', status: 500 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(triple(badgeEl())).toBe('unavailable||')
    expect(exposed?.scope).toBeNull()

    h_.fetchPendingCount.mockResolvedValueOnce({ kind: 'ok', count: 3 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(triple(badgeEl())).toBe('ready|on|3')
    expect(badgeEl().textContent).toBe('3')

    h_.fetchPendingCount.mockResolvedValueOnce({ kind: 'ok', count: 0, badgeScope: 'off' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(triple(badgeEl())).toBe('ready|off|0')
    expect(badgeEl().textContent).toBe('')
    expect(badgeEl().classList.contains('tasks-todo-badge--off')).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
// B. the subscription through the badge (§8.2)
// ---------------------------------------------------------------------------------------------

describe('B. tasks:counts-updated through TasksTodoBadge', () => {
  it('mounting the badge opens the socket once, with the token, the socket.io path, both transports, and registers the event', async () => {
    mountBadge()
    await flush()
    expect(h_.io).toHaveBeenCalledTimes(1)
    expect(h_.io).toHaveBeenCalledWith('http://example.test', expect.objectContaining({
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      auth: { token: 'session-token' },
    }))
    expect(h_.socketHandlers.has(EVENT)).toBe(true)
    expect(TASKS_COUNTS_UPDATED_EVENT).toBe(EVENT)
  })

  // FE-c changed this cell: the read waits for the signal window (`[fe-51]`) instead of starting at
  // once; the window's length is pinned by the two advances.
  it('an event is exactly one re-read when its signal window closes, and the re-read answer is what renders', async () => {
    vi.useFakeTimers()
    h_.fetchPendingCount.mockResolvedValueOnce({ kind: 'ok', count: 1 })
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)
    expect(badgeEl().getAttribute('data-count')).toBe('1')
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(1)

    h_.fetchPendingCount.mockResolvedValueOnce({ kind: 'ok', count: 4 })
    fireEvent()
    await vi.advanceTimersByTimeAsync(WINDOW - 1)
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(2)
    expect(badgeEl().getAttribute('data-count')).toBe('4')
    expect(badgeEl().getAttribute('data-scope')).toBe('on')
  })

  it('an event answered with badgeScope off switches the badge off without a reload', async () => {
    vi.useFakeTimers()
    h_.fetchPendingCount.mockResolvedValueOnce({ kind: 'ok', count: 5 })
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)
    expect(triple(badgeEl())).toBe('ready|on|5')

    h_.fetchPendingCount.mockResolvedValueOnce({ kind: 'ok', count: 0, badgeScope: 'off' })
    fireEvent()
    await vi.advanceTimersByTimeAsync(WINDOW)
    await flush()
    expect(triple(badgeEl())).toBe('ready|off|0')
    expect(badgeEl().textContent).toBe('')
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty object', {}],
    ['an object with a count', { count: 99 }],
    ['a string', 'tasks'],
  ])('a payload of %s triggers one re-read', async (_label, payload) => {
    vi.useFakeTimers()
    h_.fetchPendingCount.mockResolvedValueOnce({ kind: 'ok', count: 1 })
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)
    h_.fetchPendingCount.mockResolvedValueOnce({ kind: 'ok', count: 4 })
    fireEvent(payload)
    await vi.advanceTimersByTimeAsync(WINDOW)
    await flush()
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(2)
    expect(badgeEl().getAttribute('data-count')).toBe('4')
  })

  it('a count carried in the payload is never rendered — the server re-read is the only source', async () => {
    vi.useFakeTimers()
    h_.fetchPendingCount.mockResolvedValueOnce({ kind: 'ok', count: 1 })
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)

    // The re-read is left in flight: if anything read the payload, 99 would show now.
    const pending = deferred<unknown>()
    h_.fetchPendingCount.mockReturnValueOnce(pending.promise)
    fireEvent({ count: 99, badgeScope: 'off' })
    await flush()
    expect(badgeEl().getAttribute('data-count')).toBe('1')
    await vi.advanceTimersByTimeAsync(WINDOW)
    await flush()
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(2)
    expect(badgeEl().getAttribute('data-count')).toBe('1')
    expect(badgeEl().getAttribute('data-scope')).toBe('on')
    expect(exposed?.count).toBe(1)

    pending.resolve({ kind: 'ok', count: 4 })
    await flush()
    expect(badgeEl().getAttribute('data-count')).toBe('4')
    expect(badgeEl().getAttribute('data-scope')).toBe('on')
    expect(exposed?.count).not.toBe(99)
  })

  // FE-c changed this cell: three events inside one window are now ONE read (`[fe-51]`, pinned in
  // tasks-counts-realtime.spec.ts). The property this cell kept — the generation guard that every
  // read, the window's included, goes through — is driven here by three bus nudges, which still
  // read at once.
  it('three consecutive bus nudges issue three reads and only the LAST answer lands, whatever the resolution order', async () => {
    h_.fetchPendingCount.mockResolvedValueOnce({ kind: 'ok', count: 1 })
    mountBadge()
    await flush()

    const first = deferred<unknown>()
    const second = deferred<unknown>()
    const third = deferred<unknown>()
    h_.fetchPendingCount
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise)
    notifyTasksChanged()
    notifyTasksChanged()
    notifyTasksChanged()
    await flush()
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(4)

    // The newest read resolves first; the two older ones resolve after it and must be discarded.
    third.resolve({ kind: 'ok', count: 30 })
    await flush()
    expect(badgeEl().getAttribute('data-count')).toBe('30')
    first.resolve({ kind: 'ok', count: 10 })
    second.resolve({ kind: 'ok', count: 20 })
    await flush()
    expect(badgeEl().getAttribute('data-count')).toBe('30')
    expect(exposed?.count).toBe(30)
  })

  it('an event after a 404 tore the poll down still re-reads once, and an ok answer restarts the 60 s clock', async () => {
    vi.useFakeTimers()
    h_.fetchPendingCount.mockResolvedValue({ kind: 'not_found' })
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(1)
    expect(badgeEl().getAttribute('data-state')).toBe('unavailable')

    // The clock really stopped.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(1)

    h_.fetchPendingCount.mockResolvedValueOnce({ kind: 'ok', count: 2 })
    fireEvent()
    await vi.advanceTimersByTimeAsync(WINDOW)
    await flush()
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(2)
    expect(triple(badgeEl())).toBe('ready|on|2')

    h_.fetchPendingCount.mockResolvedValue({ kind: 'ok', count: 3 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(4)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('the 60 s poll keeps running while the socket is open, before and after an event ([fe-08])', async () => {
    vi.useFakeTimers()
    h_.fetchPendingCount.mockResolvedValue({ kind: 'ok', count: 1 })
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)
    expect(h_.io).toHaveBeenCalledTimes(1)
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(2)

    fireEvent()
    await vi.advanceTimersByTimeAsync(WINDOW)
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(60_000 - WINDOW)
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(5)
    expect(vi.getTimerCount()).toBe(1)
  })

  // FE-c changed this cell: a nudge that reads while a window is open answers the signal, so the
  // pair is one read, not two (`[fe-52]`); a nudge after the window has read is a read of its own.
  it('the socket signal ends in the bus nudge\'s refresh: a nudge while the window is open answers the signal ([fe-52]); after the window has read, a nudge reads again', async () => {
    vi.useFakeTimers()
    h_.fetchPendingCount.mockResolvedValue({ kind: 'ok', count: 1 })
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(1)

    fireEvent()
    await vi.advanceTimersByTimeAsync(10)
    notifyTasksChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(WINDOW)
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)

    fireEvent()
    await vi.advanceTimersByTimeAsync(WINDOW)
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(3)
    notifyTasksChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(4)
  })

  it('unmounting the badge disconnects the socket once', async () => {
    mountBadge()
    await flush()
    expect(h_.disconnect).not.toHaveBeenCalled()
    unmountAll()
    expect(h_.disconnect).toHaveBeenCalledTimes(1)
  })

  it('an event after unmount reads nothing', async () => {
    h_.fetchPendingCount.mockResolvedValue({ kind: 'ok', count: 1 })
    mountBadge()
    await flush()
    const handler = h_.socketHandlers.get(EVENT)
    expect(handler).toBeTruthy()
    const callsBeforeUnmount = h_.fetchPendingCount.mock.calls.length
    unmountAll()

    handler?.({})
    handler?.()
    await flush()
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(callsBeforeUnmount)
  })

  it('with the policy saying no, mounting the badge opens no socket and the poll still runs', async () => {
    vi.useFakeTimers()
    h_.shouldAutoConnectRealtime.mockReturnValue(false)
    h_.fetchPendingCount.mockResolvedValue({ kind: 'ok', count: 1 })
    mountBadge()
    await vi.advanceTimersByTimeAsync(0)
    expect(h_.io).not.toHaveBeenCalled()
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(2)
    expect(badgeEl().getAttribute('data-count')).toBe('1')
  })
})

// ---------------------------------------------------------------------------------------------
// C. the composable's own contract
// ---------------------------------------------------------------------------------------------

describe('C. useTasksCountsRealtime', () => {
  type Handle = ReturnType<typeof useTasksCountsRealtime>

  function mountComposable(onCountsUpdated: () => void): Handle {
    let handle: Handle | null = null
    const Probe = defineComponent({
      setup() {
        handle = useTasksCountsRealtime({ onCountsUpdated })
        return () => h('div')
      },
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(Probe)
    app.mount(host)
    return handle as unknown as Handle
  }

  it('with the policy saying no, mount opens nothing; an explicit reconnect() opens the socket with the contract arguments and the callback is called with no arguments', async () => {
    h_.shouldAutoConnectRealtime.mockReturnValue(false)
    const received = vi.fn()
    const handle = mountComposable(received)
    await nextTick()
    expect(h_.io).not.toHaveBeenCalled()

    const socket = await handle.reconnect()
    expect(socket).not.toBeNull()
    expect(h_.io).toHaveBeenCalledTimes(1)
    expect(h_.io).toHaveBeenCalledWith('http://example.test', {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      auth: { token: 'session-token' },
    })

    fireEvent({ count: 12, anything: true })
    expect(received).toHaveBeenCalledTimes(1)
    expect(received.mock.calls[0]).toEqual([])
  })

  it('with the policy saying yes, mount opens the socket once without an explicit reconnect()', async () => {
    const received = vi.fn()
    mountComposable(received)
    await nextTick()
    expect(h_.shouldAutoConnectRealtime).toHaveBeenCalled()
    expect(h_.io).toHaveBeenCalledTimes(1)
    expect(h_.socketHandlers.has(EVENT)).toBe(true)
  })

  it('reconnect() twice (and once more after the socket exists) opens one socket', async () => {
    h_.shouldAutoConnectRealtime.mockReturnValue(false)
    const handle = mountComposable(vi.fn())
    await nextTick()
    const [a, b] = await Promise.all([handle.reconnect(), handle.reconnect()])
    const c = await handle.reconnect()
    expect(h_.io).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('without a session token no socket is opened and reconnect() resolves null', async () => {
    h_.token = null
    const handle = mountComposable(vi.fn())
    await nextTick()
    expect(h_.io).not.toHaveBeenCalled()
    expect(await handle.reconnect()).toBeNull()
    expect(h_.io).not.toHaveBeenCalled()
  })

  it('attempts without a token keep nothing: once the session has a token, reconnect() opens the socket with it', async () => {
    // The mount attempt (policy yes) and one explicit reconnect() both run without a token.
    h_.token = null
    const received = vi.fn()
    const handle = mountComposable(received)
    await nextTick()
    expect(await handle.reconnect()).toBeNull()
    expect(h_.io).not.toHaveBeenCalled()

    h_.token = 'later-session-token'
    const socket = await handle.reconnect()
    expect(socket).not.toBeNull()
    expect(h_.io).toHaveBeenCalledTimes(1)
    expect(h_.io).toHaveBeenCalledWith('http://example.test', {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      auth: { token: 'later-session-token' },
    })
    fireEvent({})
    expect(received).toHaveBeenCalledTimes(1)
  })

  it('unmount disconnects once; afterwards reconnect() opens nothing and a late event calls nothing', async () => {
    const received = vi.fn()
    const handle = mountComposable(received)
    await nextTick()
    expect(h_.io).toHaveBeenCalledTimes(1)
    const handler = h_.socketHandlers.get(EVENT)

    unmountAll()
    expect(h_.disconnect).toHaveBeenCalledTimes(1)

    expect(await handle.reconnect()).toBeNull()
    expect(h_.io).toHaveBeenCalledTimes(1)
    handler?.({})
    expect(received).not.toHaveBeenCalled()
  })

  it('disconnect() on the handle tears the socket down and a later reconnect() opens a new one', async () => {
    const handle = mountComposable(vi.fn())
    await nextTick()
    expect(h_.io).toHaveBeenCalledTimes(1)
    handle.disconnect()
    expect(h_.disconnect).toHaveBeenCalledTimes(1)
    await handle.reconnect()
    expect(h_.io).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty object', {}],
    ['an object with a count', { count: 5 }],
    ['a string', 'x'],
    ['zero', 0],
  ])('isCountsInvalidation: %s is one invalidation signal', (_label, payload) => {
    expect(isCountsInvalidation(payload)).toBe(true)
  })

  // Copied rule (same as the todo / approval composables): exactly a trailing `/api` segment is
  // stripped; `/api/` with a slash after it is left as it is, as is any other path.
  it.each([
    ['http://example.test/api', 'http://example.test'],
    ['http://example.test/api/', 'http://example.test/api'],
    ['http://example.test/base/api', 'http://example.test/base'],
    ['http://example.test', 'http://example.test'],
    ['http://example.test/other', 'http://example.test/other'],
  ])('resolveTasksCountsRealtimeBaseUrl(%s) strips exactly a trailing /api segment', (apiBase, expected) => {
    expect(resolveTasksCountsRealtimeBaseUrl(apiBase)).toBe(expected)
  })

  it('resolveTasksCountsRealtimeBaseUrl resolves a relative /api against the page origin', () => {
    expect(resolveTasksCountsRealtimeBaseUrl('/api')).toBe(window.location.origin)
  })

  it('the real policy module says no under the test build and yes under any other build', async () => {
    const real = await vi.importActual<typeof import('../src/tasks/tasksRealtimePolicy')>('../src/tasks/tasksRealtimePolicy')
    expect(import.meta.env.MODE).toBe('test')
    expect(real.shouldAutoConnectRealtime()).toBe(false)
    vi.stubEnv('MODE', 'production')
    expect(real.shouldAutoConnectRealtime()).toBe(true)
    vi.stubEnv('MODE', 'development')
    expect(real.shouldAutoConnectRealtime()).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
// D. the gate — real App.vue, policy forced on (§8.2)
// ---------------------------------------------------------------------------------------------

describe('D. no socket outside the badge gate (real App.vue, policy forced on)', () => {
  async function flushUi(cycles = 4): Promise<void> {
    for (let i = 0; i < cycles; i += 1) {
      await Promise.resolve()
      await nextTick()
    }
  }

  async function mountApp(): Promise<HTMLElement> {
    const { default: App } = await import('../src/App.vue')
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(App as Component)
    app.component('router-view', { render: () => h('div') })
    app.component('router-link', {
      props: ['to'],
      render() {
        return h('a', { href: this.$props.to }, this.$slots.default ? this.$slots.default() : [])
      },
    })
    app.mount(host)
    await flushUi()
    return host
  }

  function badgeOf(root: HTMLElement): HTMLElement | null {
    return root.querySelector('[data-testid="tasks-todo-badge"]')
  }

  it('positive control: feature on + tasks:read on an ordinary route mounts the badge and opens exactly one socket; an event re-reads', async () => {
    vi.useFakeTimers()
    h_.fetchPendingCount.mockResolvedValue({ kind: 'ok', count: 5 })
    const root = await mountApp()
    expect(badgeOf(root)).toBeTruthy()
    expect(badgeOf(root)?.getAttribute('data-count')).toBe('5')
    expect(badgeOf(root)?.getAttribute('data-scope')).toBe('on')
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(1)
    expect(h_.io).toHaveBeenCalledTimes(1)
    expect(h_.io).toHaveBeenCalledWith('http://example.test', expect.objectContaining({
      path: '/socket.io',
      auth: { token: 'session-token' },
    }))
    expect(h_.socketHandlers.has(EVENT)).toBe(true)

    h_.fetchPendingCount.mockResolvedValue({ kind: 'ok', count: 6 })
    fireEvent()
    await flushUi()
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(WINDOW)
    await flushUi()
    expect(h_.fetchPendingCount).toHaveBeenCalledTimes(2)
    expect(badgeOf(root)?.getAttribute('data-count')).toBe('6')
  })

  it('unmounting the shell disconnects the socket once', async () => {
    await mountApp()
    expect(h_.io).toHaveBeenCalledTimes(1)
    unmountAll()
    expect(h_.disconnect).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a tasks:read holder', false],
    ['an administrator', true],
  ] as const)('feature off: %s gets no badge, no read and no socket', async (_label, isAdmin) => {
    h_.features = []
    h_.isAdmin = isAdmin
    const root = await mountApp()
    expect(root.querySelector('.app-nav')).toBeTruthy()
    expect(badgeOf(root)).toBeNull()
    expect(h_.fetchPendingCount).not.toHaveBeenCalled()
    expect(h_.io).not.toHaveBeenCalled()
    expect(h_.socketHandlers.size).toBe(0)
  })

  it('no tasks:read: no badge, no read and no socket', async () => {
    h_.permissions = []
    const root = await mountApp()
    expect(root.querySelector('.app-nav')).toBeTruthy()
    expect(badgeOf(root)).toBeNull()
    expect(h_.fetchPendingCount).not.toHaveBeenCalled()
    expect(h_.io).not.toHaveBeenCalled()
  })

  it('a public route: the nav entry renders but no badge, no read and no socket', async () => {
    h_.routePath = '/public-thing'
    h_.routeMeta = { requiresAuth: false }
    const root = await mountApp()
    expect(root.querySelector('[data-testid="nav-tasks"]')).toBeTruthy()
    expect(badgeOf(root)).toBeNull()
    expect(h_.fetchPendingCount).not.toHaveBeenCalled()
    expect(h_.io).not.toHaveBeenCalled()
  })

  it('/login: no badge, no read and no socket', async () => {
    h_.routePath = '/login'
    h_.routeMeta = {}
    const root = await mountApp()
    expect(badgeOf(root)).toBeNull()
    expect(h_.fetchPendingCount).not.toHaveBeenCalled()
    expect(h_.io).not.toHaveBeenCalled()
  })

  it.each([
    ['attendance', { attendance: true, plm: false }],
    ['plmWorkbench', { attendance: false, plm: true }],
  ])('a %s-focused shell: no badge, no read and no socket', async (_label, focus) => {
    h_.focus = focus
    const root = await mountApp()
    expect(root.querySelector('.app-nav')).toBeTruthy()
    expect(badgeOf(root)).toBeNull()
    expect(h_.fetchPendingCount).not.toHaveBeenCalled()
    expect(h_.io).not.toHaveBeenCalled()
  })
})
