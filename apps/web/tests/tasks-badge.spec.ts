import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'

const h = vi.hoisted(() => ({
  fetchPendingCount: vi.fn(),
}))

vi.mock('../src/tasks/tasksApi', () => ({
  fetchPendingCount: h.fetchPendingCount,
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref('zh-CN'),
    isZh: ref(true),
    setLocale: vi.fn(),
  }),
}))

import TasksTodoBadge from '../src/tasks/TasksTodoBadge.vue'
// Real module (not mocked) — proves the badge actually wires up to the SAME shared bus TasksView
// publishes on, not a private per-test double of it.
import { notifyTasksChanged } from '../src/tasks/tasksBadgeBus'

let app: App | null = null
let host: HTMLElement | null = null
let exposed: { count?: number | null } | null = null
let originalVisibilityState: PropertyDescriptor | undefined

function badgeEl(): HTMLElement {
  const el = host?.querySelector('[data-testid="tasks-todo-badge"]')
  expect(el).toBeTruthy()
  return el as HTMLElement
}

/** Reads the composable's OWN `count` ref through `defineExpose`, not the rendered
 *  `data-count` attribute — `TasksTodoBadge`'s `displayCount` computed already blanks the
 *  attribute for any non-'ready' state, so a DOM-only assertion could stay green even if
 *  `useTasksBadge`'s own `count.value = null` reset (the actual P2-5 guard) were removed. This
 *  reads the source of truth the template renders FROM. */
function exposedCount(): number | null | undefined {
  return exposed?.count
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
}

function mount(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(TasksTodoBadge, { label: '待办任务' })
  exposed = app.mount(host) as unknown as { count?: number | null }
}

beforeEach(() => {
  h.fetchPendingCount.mockReset()
  originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  setVisibility('visible')
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  exposed = null
  if (originalVisibilityState) {
    Object.defineProperty(document, 'visibilityState', originalVisibilityState)
  }
  vi.useRealTimers()
})

describe('TasksTodoBadge three states', () => {
  it('renders loading with an empty (not "0") data-count before the first read settles', async () => {
    h.fetchPendingCount.mockReturnValue(new Promise(() => {})) // never resolves
    mount()
    await flush()
    const el = badgeEl()
    expect(el.getAttribute('data-state')).toBe('loading')
    expect(el.getAttribute('data-count')).toBe('')
  })

  it('renders ready with the numeric count, including a real zero', async () => {
    h.fetchPendingCount.mockResolvedValue({ kind: 'ok', count: 0 })
    mount()
    await flush()
    const el = badgeEl()
    expect(el.getAttribute('data-state')).toBe('ready')
    expect(el.getAttribute('data-count')).toBe('0')
  })

  it('renders ready with a positive count', async () => {
    h.fetchPendingCount.mockResolvedValue({ kind: 'ok', count: 7 })
    mount()
    await flush()
    const el = badgeEl()
    expect(el.getAttribute('data-state')).toBe('ready')
    expect(el.getAttribute('data-count')).toBe('7')
  })

  it.each([
    ['org_missing degraded read', { kind: 'org_missing' }],
    ['forbidden (403)', { kind: 'forbidden' }],
    ['not_found (404)', { kind: 'not_found' }],
    ['generic error (500)', { kind: 'error', status: 500 }],
  ])('renders unavailable with an EMPTY data-count (never "0") for %s', async (_label, result) => {
    h.fetchPendingCount.mockResolvedValue(result)
    mount()
    await flush()
    const el = badgeEl()
    expect(el.getAttribute('data-state')).toBe('unavailable')
    expect(el.getAttribute('data-count')).toBe('')
    expect(el.getAttribute('data-count')).not.toBe('0')
  })

  it('renders unavailable when the read rejects outright', async () => {
    h.fetchPendingCount.mockRejectedValue(new Error('boom'))
    mount()
    await flush()
    const el = badgeEl()
    expect(el.getAttribute('data-state')).toBe('unavailable')
    expect(el.getAttribute('data-count')).toBe('')
  })

  // P2-5: a later poll failing after an earlier one succeeded must NEVER leave the stale number on
  // screen — the count is unknown again, not "probably still 3".
  it('drops to unavailable with an EMPTY data-count when a LATER poll fails after an earlier success', async () => {
    vi.useFakeTimers()
    h.fetchPendingCount.mockResolvedValueOnce({ kind: 'ok', count: 3 })
    mount()
    await vi.advanceTimersByTimeAsync(0)
    let el = badgeEl()
    expect(el.getAttribute('data-state')).toBe('ready')
    expect(el.getAttribute('data-count')).toBe('3')
    expect(exposedCount()).toBe(3)

    h.fetchPendingCount.mockResolvedValueOnce({ kind: 'error', status: 500 })
    await vi.advanceTimersByTimeAsync(60_000)
    el = badgeEl()
    expect(el.getAttribute('data-state')).toBe('unavailable')
    expect(el.getAttribute('data-count')).toBe('')
    expect(el.getAttribute('data-count')).not.toBe('3')
    // Composable-level assertion: `useTasksBadge`'s own `count` ref must be reset to null, not
    // merely masked by the template's `state === 'ready'` guard on the DOM attribute above.
    expect(exposedCount()).toBeNull()
  })
})

describe('TasksTodoBadge polling', () => {
  it('polls every 60s while the tab is visible', async () => {
    vi.useFakeTimers()
    h.fetchPendingCount.mockResolvedValue({ kind: 'ok', count: 1 })
    mount()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.fetchPendingCount).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.fetchPendingCount).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.fetchPendingCount).toHaveBeenCalledTimes(3)
  })

  it('skips the poll while the tab is hidden, without stopping the underlying clock', async () => {
    vi.useFakeTimers()
    h.fetchPendingCount.mockResolvedValue({ kind: 'ok', count: 1 })
    mount()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.fetchPendingCount).toHaveBeenCalledTimes(1)

    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.fetchPendingCount).toHaveBeenCalledTimes(1)

    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.fetchPendingCount).toHaveBeenCalledTimes(2)
  })

  it('clears the polling timer on unmount and issues no further reads', async () => {
    vi.useFakeTimers()
    h.fetchPendingCount.mockResolvedValue({ kind: 'ok', count: 1 })
    mount()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.fetchPendingCount).toHaveBeenCalledTimes(1)

    app?.unmount()
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.fetchPendingCount).toHaveBeenCalledTimes(1)

    // Prevent the shared afterEach from unmounting an already-unmounted app.
    app = null
    host?.remove()
    host = null
  })

  // P3: a 404 means the feature is off — the route does not exist — so continuing to poll every
  // 60s can never succeed again this session. Distinct from every OTHER failure kind (network
  // error, 403, org_missing, …), which keep polling (see the three-states describe above).
  it('stops polling after a 404 and issues no further requests', async () => {
    vi.useFakeTimers()
    h.fetchPendingCount.mockResolvedValue({ kind: 'not_found' })
    mount()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.fetchPendingCount).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.fetchPendingCount).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.fetchPendingCount).toHaveBeenCalledTimes(1)
  })

  it('keeps polling (does NOT stop) after a non-404 failure', async () => {
    vi.useFakeTimers()
    h.fetchPendingCount.mockResolvedValue({ kind: 'error', status: 500 })
    mount()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.fetchPendingCount).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.fetchPendingCount).toHaveBeenCalledTimes(2)
  })
})

describe('TasksTodoBadge cross-component refresh (tasksBadgeBus)', () => {
  it('refreshes immediately when notifyTasksChanged() fires, without waiting for the next poll', async () => {
    h.fetchPendingCount.mockResolvedValueOnce({ kind: 'ok', count: 1 })
    mount()
    await flush()
    expect(badgeEl().getAttribute('data-count')).toBe('1')
    expect(h.fetchPendingCount).toHaveBeenCalledTimes(1)

    h.fetchPendingCount.mockResolvedValueOnce({ kind: 'ok', count: 4 })
    notifyTasksChanged()
    await flush()

    expect(h.fetchPendingCount).toHaveBeenCalledTimes(2)
    expect(badgeEl().getAttribute('data-count')).toBe('4')
  })

  it('a disposed (unmounted) badge does not react to a later notifyTasksChanged()', async () => {
    h.fetchPendingCount.mockResolvedValue({ kind: 'ok', count: 1 })
    mount()
    await flush()
    const callsBeforeUnmount = h.fetchPendingCount.mock.calls.length

    app?.unmount()
    app = null
    host?.remove()
    host = null

    notifyTasksChanged()
    await flush()
    expect(h.fetchPendingCount).toHaveBeenCalledTimes(callsBeforeUnmount)
  })
})
