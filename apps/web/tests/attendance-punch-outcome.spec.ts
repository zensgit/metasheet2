// Punch outcome clarity (frontend-only, 2026-07-05 design-lock):
// docs/development/attendance-punch-outcome-clarity-design-lock-20260705.md
//
// Covers the three dead-ends fixed in AttendanceView.vue's punch():
//   G1 - a 202 `{ pendingApproval: true }` response must never read as
//        "recorded" and must refresh the requests list.
//   G2 - `OUTDOOR_NOTE_REQUIRED` (422) must surface an inline note input +
//        one-click retry that resends the original payload plus the
//        backend-accepted `meta.note` field (confirmed by reading
//        plugins/plugin-attendance/index.cjs ~L24203-24211 — the note is
//        read from `punchMeta.note`, i.e. a string inside the existing
//        `meta` record, not a new top-level field).
//   G3 - `LOCATION_RESTRICTED` (403) must show a calibrated dead-end message
//        with NO retry action (a retry would fail identically every time).
// Plus enum-strict negatives: unrelated/unknown codes must fall through to
// the existing generic status-error path unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { useLocale } from '../src/composables/useLocale'
import { apiFetch } from '../src/utils/api'
import {
  buildPunchRetryWithNotePayload,
  classifyPunchErrorOutcome,
  classifyPunchSuccessOutcome,
  type TranslateFn,
} from '../src/views/attendance/punchOutcome'

const authMockState = vi.hoisted(() => ({
  currentUserId: 'punch-outcome-user',
}))

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({
    plugins: ref([
      {
        name: 'plugin-attendance',
        status: 'active',
      },
    ]),
    views: ref([]),
    navItems: ref([]),
    loading: ref(false),
    error: ref(null),
    fetchPlugins: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getCurrentUserId: vi.fn(async () => authMockState.currentUserId),
  }),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: vi.fn(),
}))

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    blob: async () => new Blob([JSON.stringify(payload)], { type: 'application/json' }),
  } as unknown as Response
}

async function flushUi(cycles = 8): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

/** Punch button release (fix/attendance-punch-button-release, 2026-08-21): a promise this test
 * controls the settlement of, for simulating an in-flight HTTP call (punch POST or a post-punch
 * refresh task) that has not yet resolved. */
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    candidate => candidate.textContent?.trim() === label
  )
  expect(button, `expected button "${label}"`).toBeTruthy()
  return button as HTMLButtonElement
}

/** Minimal default mock: every non-punch endpoint returns an empty-but-ok payload so mount + refreshAll() never throw. */
function installBaselineMock(): void {
  vi.mocked(apiFetch).mockImplementation(async () => jsonResponse(200, { ok: true, data: { items: [], total: 0 } }))
}

describe('Punch outcome clarity (pure)', () => {
  const tr: TranslateFn = (en) => en
  const trZh: TranslateFn = (_en, zh) => zh

  it('classifies a normal 2xx punch as recorded with unchanged copy', () => {
    const checkIn = classifyPunchSuccessOutcome('check_in', { pendingApproval: false }, tr)
    expect(checkIn.kind).toBe('recorded')
    expect(checkIn.message).toBe('Check in recorded.')
    expect(checkIn.shouldRefreshRequests).toBe(false)

    const checkOut = classifyPunchSuccessOutcome('check_out', null, tr)
    expect(checkOut.kind).toBe('recorded')
    expect(checkOut.message).toBe('Check out recorded.')
    expect(checkOut.shouldRefreshRequests).toBe(false)
  })

  it('classifies pendingApproval:true as pendingApproval and never says "recorded"', () => {
    const outcome = classifyPunchSuccessOutcome('check_in', { pendingApproval: true }, tr)
    expect(outcome.kind).toBe('pendingApproval')
    expect(outcome.message).toBe('Outdoor punch submitted for approval; it will count once approved.')
    expect(outcome.message.toLowerCase()).not.toContain('recorded')
    expect(outcome.shouldRefreshRequests).toBe(true)
  })

  it('renders the exact zh copy for pendingApproval via the injected tr (design-lock literal string)', () => {
    const outcome = classifyPunchSuccessOutcome('check_in', { pendingApproval: true }, trZh)
    expect(outcome.message).toBe('外勤打卡已提交审批，通过后计入考勤')
    expect(outcome.message).not.toContain('已记录')
  })

  it('classifies OUTDOOR_NOTE_REQUIRED with the note-retry affordance', () => {
    const outcome = classifyPunchErrorOutcome({ status: 422, code: 'OUTDOOR_NOTE_REQUIRED' }, tr)
    expect(outcome?.kind).toBe('noteRequired')
    expect(outcome?.code).toBe('OUTDOOR_NOTE_REQUIRED')
    expect(outcome?.showNoteRetry).toBe(true)
  })

  it('classifies LOCATION_RESTRICTED as a calibrated dead-end with no retry affordance', () => {
    const outcome = classifyPunchErrorOutcome({ status: 403, code: 'LOCATION_RESTRICTED' }, tr)
    expect(outcome?.kind).toBe('locationRestricted')
    expect(outcome?.code).toBe('LOCATION_RESTRICTED')
    expect(outcome?.showNoteRetry).toBe(false)
    expect(outcome?.message).toContain('Contact an administrator')
  })

  it('renders the exact zh copy for LOCATION_RESTRICTED (design-lock literal string)', () => {
    const outcome = classifyPunchErrorOutcome({ status: 403, code: 'LOCATION_RESTRICTED' }, trZh)
    expect(outcome?.message).toBe('当前位置在允许打卡范围外，且本组织未启用外勤审批；如需外勤打卡请联系管理员')
  })

  it('is tolerant of code casing/whitespace from the server', () => {
    expect(classifyPunchErrorOutcome({ status: 422, code: ' outdoor_note_required ' }, tr)?.kind).toBe('noteRequired')
    expect(classifyPunchErrorOutcome({ status: 403, code: 'location_restricted' }, tr)?.kind).toBe('locationRestricted')
  })

  it('returns null (enum-strict fallthrough) for unrelated/unknown codes', () => {
    expect(classifyPunchErrorOutcome({ status: 429, code: 'PUNCH_TOO_SOON' }, tr)).toBeNull()
    expect(classifyPunchErrorOutcome({ status: 403, code: 'FORBIDDEN' }, tr)).toBeNull()
    expect(classifyPunchErrorOutcome({ status: 500, code: '' }, tr)).toBeNull()
    // Distinct shape from `code: ''` above: a 5xx error object that omits the
    // `code` key entirely (e.g. a network/proxy failure with no structured
    // body). Must still fall through to null, not throw on the missing key.
    expect(classifyPunchErrorOutcome({ status: 500 }, tr)).toBeNull()
    expect(classifyPunchErrorOutcome(null, tr)).toBeNull()
    expect(classifyPunchErrorOutcome(undefined, tr)).toBeNull()
  })

  it('builds the exact OUTDOOR_NOTE_REQUIRED retry payload: original fields + meta.note only', () => {
    const payload = buildPunchRetryWithNotePayload(
      { eventType: 'check_in', timezone: 'Asia/Shanghai' },
      '  Client site visit  ',
    )
    expect(payload).toEqual({
      eventType: 'check_in',
      timezone: 'Asia/Shanghai',
      meta: { note: 'Client site visit' },
    })
    expect(payload).not.toHaveProperty('location')
    expect(payload.meta).not.toHaveProperty('outdoor')
  })

  it('carries orgId through the retry payload when present, and trims the note', () => {
    const payload = buildPunchRetryWithNotePayload(
      { eventType: 'check_out', timezone: 'UTC', orgId: 'org-9' },
      '  note text  ',
    )
    expect(payload).toEqual({
      eventType: 'check_out',
      timezone: 'UTC',
      orgId: 'org-9',
      meta: { note: 'note text' },
    })
  })
})

describe('Attendance punch outcome clarity (mount)', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-05T08:00:00Z'))
    authMockState.currentUserId = 'punch-outcome-user'
    HTMLElement.prototype.scrollIntoView = vi.fn()
    window.localStorage.clear()
    window.localStorage.setItem('metasheet_locale', 'en')
    window.history.replaceState({}, '', '/attendance')
    installBaselineMock()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView
    useLocale().setLocale('en')
    vi.useRealTimers()
    app = null
    container = null
  })

  it('G1: 202 pendingApproval shows the submitted-for-approval status, never "recorded", and refreshes the requests list', async () => {
    const defaultImpl = vi.mocked(apiFetch).getMockImplementation()
    let punchPosted = false
    let requestsCallsAfterPunch = 0
    // Refresh identity (P3-5 gate hardening, 2026-08-21): a G1 pendingApproval
    // punch writes no attendance fact — refreshAll()'s full overview data set
    // (summary/records) must NOT be touched, only the requests list. Pins
    // WHICH refresh function ran, not just "some refresh happened".
    let summaryOrRecordsCallsAfterPunch = 0
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/punch') && !url.includes('/events')) {
        expect((init as RequestInit | undefined)?.method).toBe('POST')
        const body = JSON.parse(String((init as RequestInit).body))
        expect(Object.keys(body).sort()).toEqual(['eventType', 'timezone'])
        expect(body).not.toHaveProperty('location')
        expect(body).not.toHaveProperty('meta')
        punchPosted = true
        return jsonResponse(202, {
          ok: true,
          data: { pendingApproval: true, request: { id: 'req-outdoor-1', status: 'pending' } },
        })
      }
      if (url.includes('/api/attendance/requests?') && punchPosted) {
        requestsCallsAfterPunch += 1
      }
      if (punchPosted && (url.includes('/api/attendance/summary?') || url.includes('/api/attendance/records?'))) {
        summaryOrRecordsCallsAfterPunch += 1
      }
      if (!defaultImpl) return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
      return defaultImpl(input, init)
    })

    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    findButton(container!, 'Check In').click()
    await flushUi(6)

    const pageText = container!.textContent ?? ''
    expect(pageText).toContain('Outdoor punch submitted for approval; it will count once approved.')
    expect(pageText.toLowerCase()).not.toContain('check in recorded')
    expect(requestsCallsAfterPunch).toBeGreaterThan(0)
    // The G1 branch calls loadRequests() only — refreshAll()'s full overview
    // set must stay untouched (a silent identity swap would light this up).
    expect(summaryOrRecordsCallsAfterPunch).toBe(0)
  })

  it('G2: OUTDOOR_NOTE_REQUIRED shows an inline note input; retry POSTs the exact payload then succeeds', async () => {
    const defaultImpl = vi.mocked(apiFetch).getMockImplementation()
    const punchCalls: Array<Record<string, unknown>> = []
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/punch') && !url.includes('/events')) {
        expect((init as RequestInit | undefined)?.method).toBe('POST')
        const body = JSON.parse(String((init as RequestInit).body))
        punchCalls.push(body)
        if (punchCalls.length === 1) {
          return jsonResponse(422, { ok: false, error: { code: 'OUTDOOR_NOTE_REQUIRED', message: '外勤打卡需填写备注' } })
        }
        return jsonResponse(200, { ok: true, data: {} })
      }
      if (!defaultImpl) return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
      return defaultImpl(input, init)
    })

    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    findButton(container!, 'Check In').click()
    await flushUi(6)

    expect(container!.textContent).toContain(
      'Outdoor punch needs a note before it can be submitted. Add one below and retry.',
    )
    const noteInput = container!.querySelector<HTMLInputElement>('#attendance-punch-outdoor-note')
    expect(noteInput).toBeTruthy()
    const retryButtonBeforeNote = container!.querySelector<HTMLButtonElement>('[data-attendance-punch-note-retry]')
    expect(retryButtonBeforeNote).toBeTruthy()
    expect(retryButtonBeforeNote!.disabled).toBe(true)

    noteInput!.value = 'Client site visit'
    noteInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)

    const retryButton = container!.querySelector<HTMLButtonElement>('[data-attendance-punch-note-retry]')
    expect(retryButton!.disabled).toBe(false)
    retryButton!.click()
    await flushUi(6)

    expect(punchCalls).toHaveLength(2)
    expect(Object.keys(punchCalls[0]).sort()).toEqual(['eventType', 'timezone'])
    expect(punchCalls[0].eventType).toBe('check_in')
    expect(punchCalls[1]).toEqual({
      eventType: 'check_in',
      timezone: punchCalls[0].timezone,
      meta: { note: 'Client site visit' },
    })
    // Success clears the inline form (no stale note UI lingering).
    expect(container!.querySelector('#attendance-punch-outdoor-note')).toBeNull()
  })

  it('G2: retry is user-initiated only — no automatic re-POST while the note form is open', async () => {
    const defaultImpl = vi.mocked(apiFetch).getMockImplementation()
    let punchCallCount = 0
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/punch') && !url.includes('/events')) {
        punchCallCount += 1
        return jsonResponse(422, { ok: false, error: { code: 'OUTDOOR_NOTE_REQUIRED', message: '外勤打卡需填写备注' } })
      }
      if (!defaultImpl) return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
      return defaultImpl(input, init)
    })

    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    findButton(container!, 'Check In').click()
    await flushUi(6)
    expect(punchCallCount).toBe(1)

    const noteInput = container!.querySelector<HTMLInputElement>('#attendance-punch-outdoor-note')
    noteInput!.value = 'Waiting to submit'
    noteInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(4)

    // Typing alone must never trigger a re-POST.
    expect(punchCallCount).toBe(1)
  })

  it('G2: a retry that 422s again keeps the note form open, preserves the draft, and never auto-repeats', async () => {
    const defaultImpl = vi.mocked(apiFetch).getMockImplementation()
    const punchCalls: Array<Record<string, unknown>> = []
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/punch') && !url.includes('/events')) {
        const body = JSON.parse(String((init as RequestInit).body))
        punchCalls.push(body)
        // Every attempt — including the retry — still needs a note (e.g. the
        // org's requireNote check keeps rejecting it). This is the "note was
        // filled in but still 422s again" path traced in the PR #3580 review
        // (NIT-1a): no code path resets/clears the form on a repeat
        // noteRequired, so it must stay open with the draft intact.
        return jsonResponse(422, { ok: false, error: { code: 'OUTDOOR_NOTE_REQUIRED', message: '外勤打卡需填写备注' } })
      }
      if (!defaultImpl) return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
      return defaultImpl(input, init)
    })

    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    findButton(container!, 'Check In').click()
    await flushUi(6)
    expect(punchCalls).toHaveLength(1)
    expect(container!.querySelector('[data-attendance-punch-note-form]')).toBeTruthy()

    const noteInput = container!.querySelector<HTMLInputElement>('#attendance-punch-outdoor-note')
    noteInput!.value = 'Still onsite, forgot to note earlier'
    noteInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)

    const retryButton = container!.querySelector<HTMLButtonElement>('[data-attendance-punch-note-retry]')
    expect(retryButton!.disabled).toBe(false)
    retryButton!.click()
    await flushUi(6)

    // Exactly one retry POST fired from the one click — no automatic repeat.
    expect(punchCalls).toHaveLength(2)
    expect(punchCalls[1]).toEqual({
      eventType: 'check_in',
      timezone: punchCalls[0].timezone,
      meta: { note: 'Still onsite, forgot to note earlier' },
    })

    // The form must still be open — a second 422 must not silently drop it —
    // and the draft the user already typed must not be wiped out.
    expect(container!.querySelector('[data-attendance-punch-note-form]')).toBeTruthy()
    expect(container!.querySelector<HTMLInputElement>('#attendance-punch-outdoor-note')?.value).toBe(
      'Still onsite, forgot to note earlier',
    )
    expect(container!.textContent).toContain(
      'Outdoor punch needs a note before it can be submitted. Add one below and retry.',
    )

    // Settling further must not fire a third, automatic POST.
    await flushUi(4)
    expect(punchCalls).toHaveLength(2)
  })

  it('G2 anti-crosstalk: switching straight to Check Out after a Check In note-prompt clears the stale state, and the retry always targets the most recent eventType', async () => {
    const defaultImpl = vi.mocked(apiFetch).getMockImplementation()
    const punchCalls: Array<Record<string, unknown>> = []
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/punch') && !url.includes('/events')) {
        const body = JSON.parse(String((init as RequestInit).body))
        punchCalls.push(body)
        if (punchCalls.length <= 2) {
          // Both the initial Check In attempt and the fresh (non-retry)
          // Check Out attempt land on the same outdoor-note requirement.
          return jsonResponse(422, { ok: false, error: { code: 'OUTDOOR_NOTE_REQUIRED', message: '外勤打卡需填写备注' } })
        }
        return jsonResponse(200, { ok: true, data: {} })
      }
      if (!defaultImpl) return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
      return defaultImpl(input, init)
    })

    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    // 1) Check In needs a note; the inline form opens for it.
    findButton(container!, 'Check In').click()
    await flushUi(6)
    expect(punchCalls).toHaveLength(1)
    expect(punchCalls[0].eventType).toBe('check_in')
    expect(container!.querySelector('[data-attendance-punch-note-form]')).toBeTruthy()

    // The user starts a note for the Check In attempt, then changes their
    // mind and clicks Check Out directly — WITHOUT clicking retry.
    const noteInputBeforeSwitch = container!.querySelector<HTMLInputElement>('#attendance-punch-outdoor-note')
    noteInputBeforeSwitch!.value = 'note meant for check-in, must not leak'
    noteInputBeforeSwitch!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)

    findButton(container!, 'Check Out').click()
    await flushUi(6)

    // 2) `punch('check_out')` is a fresh (non-retry) call, so it resets the
    // stale Check In note-form state before sending — its own POST is a
    // plain base payload, not a continuation of Check In's retry (no
    // leftover meta.note, no crossed eventType).
    expect(punchCalls).toHaveLength(2)
    expect(Object.keys(punchCalls[1]).sort()).toEqual(['eventType', 'timezone'])
    expect(punchCalls[1].eventType).toBe('check_out')

    // 3) The note form re-opened (Check Out also needs a note this org), but
    // with a CLEARED draft — the abandoned Check In text must not survive
    // the switch (proves the reset ran before Check Out's own attempt, not
    // only after some later success).
    expect(container!.querySelector('[data-attendance-punch-note-form]')).toBeTruthy()
    const noteInputAfterSwitch = container!.querySelector<HTMLInputElement>('#attendance-punch-outdoor-note')
    expect(noteInputAfterSwitch!.value).toBe('')

    // 4) Anti-crosstalk lock on `punchOutdoorNoteEventType`: it must now be
    // latched to 'check_out' (the most recent attempt), never stuck on the
    // original 'check_in'. The only externally observable proof is which
    // eventType the retry actually sends.
    noteInputAfterSwitch!.value = 'note for check-out'
    noteInputAfterSwitch!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)
    const retryButton = container!.querySelector<HTMLButtonElement>('[data-attendance-punch-note-retry]')
    expect(retryButton!.disabled).toBe(false)
    retryButton!.click()
    await flushUi(6)

    expect(punchCalls).toHaveLength(3)
    expect(punchCalls[2]).toEqual({
      eventType: 'check_out',
      timezone: punchCalls[0].timezone,
      meta: { note: 'note for check-out' },
    })
    expect(container!.querySelector('[data-attendance-punch-note-form]')).toBeNull()
  })

  it('G2: pressing Enter with an empty or whitespace-only note draft is a no-op, matching the disabled retry button', async () => {
    const defaultImpl = vi.mocked(apiFetch).getMockImplementation()
    let punchCallCount = 0
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/punch') && !url.includes('/events')) {
        punchCallCount += 1
        return jsonResponse(422, { ok: false, error: { code: 'OUTDOOR_NOTE_REQUIRED', message: '外勤打卡需填写备注' } })
      }
      if (!defaultImpl) return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
      return defaultImpl(input, init)
    })

    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    findButton(container!, 'Check In').click()
    await flushUi(6)
    expect(punchCallCount).toBe(1)

    const noteInput = container!.querySelector<HTMLInputElement>('#attendance-punch-outdoor-note')
    expect(noteInput).toBeTruthy()

    // Whitespace-only draft: the retry button is disabled (existing
    // coverage); Enter in the same input must be an equally inert no-op,
    // not a bypass of that guard.
    noteInput!.value = '   '
    noteInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)
    expect(container!.querySelector<HTMLButtonElement>('[data-attendance-punch-note-retry]')!.disabled).toBe(true)
    noteInput!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushUi(4)
    expect(punchCallCount).toBe(1)
    expect(container!.querySelector('[data-attendance-punch-note-form]')).toBeTruthy()

    // Fully empty draft: same guard holds.
    noteInput!.value = ''
    noteInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)
    noteInput!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushUi(4)
    expect(punchCallCount).toBe(1)
  })

  it('G3: LOCATION_RESTRICTED shows the calibrated dead-end copy with no retry action', async () => {
    const defaultImpl = vi.mocked(apiFetch).getMockImplementation()
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/punch') && !url.includes('/events')) {
        return jsonResponse(403, {
          ok: false,
          error: { code: 'LOCATION_RESTRICTED', message: 'Punch location outside allowed area' },
        })
      }
      if (!defaultImpl) return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
      return defaultImpl(input, init)
    })

    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    findButton(container!, 'Check Out').click()
    await flushUi(6)

    const pageText = container!.textContent ?? ''
    expect(pageText).toContain(
      'Your current location is outside the allowed punch range, and outdoor-punch approval is not enabled for this organization. Contact an administrator if you need to punch outdoors.',
    )
    expect(pageText).toContain('Code: LOCATION_RESTRICTED')
    expect(container!.querySelector('[data-attendance-punch-note-retry]')).toBeNull()
    const buttonLabels = Array.from(container!.querySelectorAll('button')).map(b => b.textContent?.trim())
    expect(buttonLabels).not.toContain('Retry refresh')
    expect(buttonLabels).not.toContain('Reload admin')
  })

  it('enum-strict negative: an unmapped punch error code still falls through to the existing generic retry path', async () => {
    const defaultImpl = vi.mocked(apiFetch).getMockImplementation()
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/punch') && !url.includes('/events')) {
        return jsonResponse(422, {
          ok: false,
          error: { code: 'SOME_UNMAPPED_PUNCH_CODE', message: 'Some unmapped punch code' },
        })
      }
      if (!defaultImpl) return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
      return defaultImpl(input, init)
    })

    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    findButton(container!, 'Check In').click()
    await flushUi(6)

    const pageText = container!.textContent ?? ''
    expect(pageText).toContain('Some unmapped punch code')
    expect(pageText).toContain('Code: SOME_UNMAPPED_PUNCH_CODE')
    expect(pageText).toContain('Retry refresh')
    expect(container!.querySelector('[data-attendance-punch-note-retry]')).toBeNull()
  })

  it('enum-strict negative: PUNCH_TOO_SOON keeps its existing dedicated copy/action untouched', async () => {
    const defaultImpl = vi.mocked(apiFetch).getMockImplementation()
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/punch') && !url.includes('/events')) {
        return jsonResponse(400, { ok: false, error: { code: 'PUNCH_TOO_SOON', message: 'PUNCH_TOO_SOON' } })
      }
      if (!defaultImpl) return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
      return defaultImpl(input, init)
    })

    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    findButton(container!, 'Check Out').click()
    await flushUi(6)

    const pageText = container!.textContent ?? ''
    expect(pageText).toContain('Punch interval is too short. Try again shortly.')
    expect(pageText).toContain('Code: PUNCH_TOO_SOON')
    expect(pageText).toContain('Retry refresh')
  })

  it('regression: a normal successful punch (no pendingApproval) still shows "recorded" with no note form', async () => {
    const defaultImpl = vi.mocked(apiFetch).getMockImplementation()
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/punch') && !url.includes('/events')) {
        return jsonResponse(200, { ok: true, data: { id: 'event-1', eventType: 'check_in' } })
      }
      if (!defaultImpl) return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
      return defaultImpl(input, init)
    })

    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    findButton(container!, 'Check In').click()
    await flushUi(6)

    expect(container!.textContent).toContain('Check in recorded.')
    expect(container!.querySelector('[data-attendance-punch-note-form]')).toBeNull()
  })

  // Punch button release (fix/attendance-punch-button-release, 2026-08-21): `punching` used to
  // stay true until AFTER the post-punch refreshAll() settled (10 overview tasks + the 2-step
  // loadSelfAttendanceRules — up to 11 requests, no apiFetch timeout), so the button showed
  // "Working..." for as long as that refresh took even though the POST itself had long returned.
  // `punching` now covers only the punch POST; a separate `refreshingAfterPunch` counter drives a
  // non-blocking "Updating..." indicator for the refresh instead.
  it('button release: punching clears and the button re-enables once the punch POST settles, even while the post-punch refreshAll() is still pending', async () => {
    const defaultImpl = vi.mocked(apiFetch).getMockImplementation()
    let punchPosted = false
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/punch') && !url.includes('/events')) {
        punchPosted = true
        return jsonResponse(200, { ok: true, data: { id: 'event-1', eventType: 'check_in' } })
      }
      if (punchPosted) {
        // Every call refreshAll() makes after the punch POST resolved never settles — proves
        // `punching` does not wait on any of them.
        return new Promise<Response>(() => {})
      }
      if (!defaultImpl) return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
      return defaultImpl(input, init)
    })

    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    const checkIn = findButton(container!, 'Check In')
    checkIn.click()
    await flushUi(10)

    // (a) — the discriminating assertion: the outcome is shown, the button is enabled and back
    // to its idle label, while the refresh (deliberately never-resolving here) is still pending.
    expect(container!.textContent).toContain('Check in recorded.')
    expect(checkIn.disabled).toBe(false)
    expect(checkIn.textContent?.trim()).toBe('Check In')
    const indicator = container!.querySelector('[data-testid="attendance-refreshing-indicator"]')
    expect(indicator).toBeTruthy()
    expect(indicator!.textContent?.trim()).toBe('Updating...')
  })

  it('positive control: the button is disabled (and shows "Working...") while the punch POST itself is in flight, and a second click in that window issues no second POST', async () => {
    const defaultImpl = vi.mocked(apiFetch).getMockImplementation()
    const deferredPunch = createDeferred<Response>()
    let punchCallCount = 0
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/punch') && !url.includes('/events')) {
        punchCallCount += 1
        return deferredPunch.promise
      }
      if (!defaultImpl) return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
      return defaultImpl(input, init)
    })

    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    // Capture the element reference before clicking: Vue patches the existing button node in
    // place when its disabled/label state changes, so this reference stays valid across
    // re-renders — looking it up again by label would fail once the label flips to "Working...".
    const checkIn = findButton(container!, 'Check In')
    checkIn.click()
    await flushUi(2)

    expect(punchCallCount).toBe(1)
    expect(checkIn.disabled).toBe(true)
    expect(checkIn.textContent?.trim()).toBe('Working...')

    // (d) — a second click while the POST is still pending must not fire a second POST: the
    // button is disabled in the actual DOM, and (like real browsers) jsdom does not dispatch a
    // click event from `.click()` on a disabled button, so the handler never re-runs.
    checkIn.click()
    await flushUi(2)
    expect(punchCallCount).toBe(1)

    deferredPunch.resolve(jsonResponse(200, { ok: true, data: { id: 'event-1', eventType: 'check_in' } }))
    await flushUi(10)

    expect(checkIn.disabled).toBe(false)
    expect(punchCallCount).toBe(1)
  })

  it('the refresh indicator clears once the post-punch refresh actually completes', async () => {
    const defaultImpl = vi.mocked(apiFetch).getMockImplementation()
    let punchPosted = false
    const deferredRefresh = createDeferred<Response>()
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/punch') && !url.includes('/events')) {
        punchPosted = true
        return jsonResponse(200, { ok: true, data: { id: 'event-1', eventType: 'check_in' } })
      }
      if (punchPosted) {
        return deferredRefresh.promise
      }
      if (!defaultImpl) return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
      return defaultImpl(input, init)
    })

    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    findButton(container!, 'Check In').click()
    await flushUi(10)

    expect(container!.querySelector('[data-testid="attendance-refreshing-indicator"]')).toBeTruthy()

    // (c) — resolving every pending refresh call clears the indicator.
    deferredRefresh.resolve(jsonResponse(200, { ok: true, data: { items: [], total: 0 } }))
    await flushUi(10)

    expect(container!.querySelector('[data-testid="attendance-refreshing-indicator"]')).toBeNull()
  })

  // Refresh identity (P3-5 gate hardening, 2026-08-21): every other spec here proves "some
  // refresh happened" via the indicator or a never-resolving mock, but none of them pin WHICH
  // refresh function ran. A silent swap of refreshAll() -> loadRequests() in the non-G1 branch
  // (e.g. an accidental copy/paste) would still show the "Updating..." indicator and still keep
  // this whole file green. This test pins the actual URL set instead.
  it('refresh identity: a normal (non-G1) punch refresh hits the full overview data set (summary + records + requests), not just the requests list', async () => {
    const defaultImpl = vi.mocked(apiFetch).getMockImplementation()
    let punchPosted = false
    const callsAfterPunch: string[] = []
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/punch') && !url.includes('/events')) {
        punchPosted = true
        return jsonResponse(200, { ok: true, data: { id: 'event-1', eventType: 'check_in' } })
      }
      if (punchPosted) {
        // Record the URL, then never resolve — every task refreshAll() kicks off has already
        // fired (and been recorded) by the time flushUi() below returns, without racing which
        // task happens to settle first.
        callsAfterPunch.push(url)
        return new Promise<Response>(() => {})
      }
      if (!defaultImpl) return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
      return defaultImpl(input, init)
    })

    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    findButton(container!, 'Check In').click()
    await flushUi(10)

    expect(callsAfterPunch.some(url => url.includes('/api/attendance/summary?'))).toBe(true)
    expect(callsAfterPunch.some(url => url.includes('/api/attendance/records?'))).toBe(true)
    expect(callsAfterPunch.some(url => url.includes('/api/attendance/requests?'))).toBe(true)
  })

  // P3-4 (optional gate hardening, 2026-08-21): refreshingAfterPunchCount is a counter, not a
  // boolean, specifically so two overlapping post-punch refreshes don't let the earlier one's
  // completion clear the indicator while the later one is still running. This constructs that
  // overlap directly instead of asserting on the counter's internal value.
  it('counter semantics: two overlapping post-punch refreshes keep the indicator visible until BOTH settle', async () => {
    const defaultImpl = vi.mocked(apiFetch).getMockImplementation()
    let phase: 'before' | 'afterFirstPunch' | 'afterSecondPunch' = 'before'
    const deferredA = createDeferred<Response>()
    const deferredB = createDeferred<Response>()
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/punch') && !url.includes('/events')) {
        const nextEventType = phase === 'before' ? 'check_in' : 'check_out'
        if (phase === 'before') phase = 'afterFirstPunch'
        else if (phase === 'afterFirstPunch') phase = 'afterSecondPunch'
        return jsonResponse(200, { ok: true, data: { id: `event-${nextEventType}`, eventType: nextEventType } })
      }
      if (phase === 'afterFirstPunch') return deferredA.promise
      if (phase === 'afterSecondPunch') return deferredB.promise
      if (!defaultImpl) return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
      return defaultImpl(input, init)
    })

    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    // Punch #1 (Check In): its POST resolves immediately; its refreshAll() tasks all hang on
    // deferredA. Indicator now on (count 0 -> 1).
    findButton(container!, 'Check In').click()
    await flushUi(6)
    expect(container!.querySelector('[data-testid="attendance-refreshing-indicator"]')).toBeTruthy()

    // Punch #2 (Check Out), fired while punch #1's refresh is still pending — reachable because
    // `punching` only covered punch #1's own POST, which already settled. Its own POST resolves
    // immediately (matched by the punch-endpoint branch before the phase check); its refreshAll()
    // tasks all hang on deferredB. Indicator stays on (count 1 -> 2).
    findButton(container!, 'Check Out').click()
    await flushUi(6)
    expect(container!.querySelector('[data-testid="attendance-refreshing-indicator"]')).toBeTruthy()

    // Settle ONLY punch #1's refresh (count 2 -> 1). A plain boolean would clear here, since
    // punch #1's own `runPostPunchRefresh` call would set it false in its own `finally`
    // regardless of punch #2's refresh still running — the discriminating assertion.
    deferredA.resolve(jsonResponse(200, { ok: true, data: { items: [], total: 0 } }))
    await flushUi(8)
    expect(container!.querySelector('[data-testid="attendance-refreshing-indicator"]')).toBeTruthy()

    // Settle punch #2's refresh too (count 1 -> 0) — only now does the indicator clear.
    deferredB.resolve(jsonResponse(200, { ok: true, data: { items: [], total: 0 } }))
    await flushUi(8)
    expect(container!.querySelector('[data-testid="attendance-refreshing-indicator"]')).toBeNull()
  })
})
