import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { useLocale } from '../src/composables/useLocale'

const h = vi.hoisted(() => ({
  publish: vi.fn(),
  issue: vi.fn(),
  setStatus: vi.fn(),
  listRegistrations: vi.fn(),
}))

vi.mock('../src/services/elearningOfflineTraining', async () => {
  const actual = await vi.importActual<typeof import('../src/services/elearningOfflineTraining')>(
    '../src/services/elearningOfflineTraining',
  )
  return {
    ...actual,
    publishElearningOfflineTraining: h.publish,
    issueElearningOfflineQr: h.issue,
    listElearningOfflineRegistrations: h.listRegistrations,
    setElearningOfflineTrainingStatus: h.setStatus,
  }
})

import { ElearningApiError } from '../src/services/elearning'
import ElearningOfflineTrainingAdminSection from '../src/views/ElearningOfflineTrainingAdminSection.vue'

const TRAINING = '11111111-1111-4111-8111-111111111111'
const REVISION = '22222222-2222-4222-8222-222222222222'
const TARGET = '33333333-3333-4333-8333-333333333333'
const MEMBER = '44444444-4444-4444-8444-444444444444'
const REQUEST_A = '55555555-5555-4555-8555-555555555555'
const REQUEST_B = '66666666-6666-4666-8666-666666666666'
const REQUEST_C = '77777777-7777-4777-8777-777777777777'
const TOKEN_A = 'A'.repeat(43)
const TOKEN_B = 'B'.repeat(43)

async function flush(cycles = 10): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function input(root: HTMLElement, testId: string, value: string): void {
  const node = root.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement | HTMLTextAreaElement
  node.value = value
  node.dispatchEvent(new Event('input', { bubbles: true }))
}

function result(over: Record<string, unknown> = {}) {
  return {
    trainingId: TRAINING,
    revisionId: REVISION,
    title: 'Safety training',
    location: 'Room A',
    attendanceMode: 'training',
    targets: [{
      targetId: TARGET,
      position: 1,
      title: 'Morning session',
      startsAt: '2026-09-01T02:00:00.000Z',
      endsAt: '2026-09-01T04:00:00.000Z',
      checkInOpensAt: '2026-09-01T01:30:00.000Z',
      checkInClosesAt: '2026-09-01T02:30:00.000Z',
      checkOutOpensAt: '2026-09-01T03:30:00.000Z',
      checkOutClosesAt: '2026-09-01T04:30:00.000Z',
    }],
    memberCount: 1,
    registrationEnabled: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    duplicate: false,
    ...over,
  }
}

function fill(root: HTMLElement, location = 'Room A'): void {
  input(root, 'elearning-offline-title', ' Safety training ')
  input(root, 'elearning-offline-location', location)
  input(root, 'elearning-offline-members', MEMBER)
  input(root, 'elearning-offline-target-title', 'Morning session')
  input(root, 'elearning-offline-startsAt', '2026-09-01T10:00:00')
  input(root, 'elearning-offline-endsAt', '2026-09-01T12:00:00')
  input(root, 'elearning-offline-checkInOpensAt', '2026-09-01T09:30:00')
  input(root, 'elearning-offline-checkInClosesAt', '2026-09-01T10:30:00')
  input(root, 'elearning-offline-checkOutOpensAt', '2026-09-01T11:30:00')
  input(root, 'elearning-offline-checkOutClosesAt', '2026-09-01T12:30:00')
}

describe('ElearningOfflineTrainingAdminSection', () => {
  let app: App<Element> | null = null
  let root: HTMLDivElement | null = null
  let uuid: ReturnType<typeof vi.spyOn> | null = null

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'))
    useLocale().setLocale('en')
    h.publish.mockReset()
    h.issue.mockReset()
    h.setStatus.mockReset()
    h.listRegistrations.mockReset()
    h.publish.mockResolvedValue(result())
    h.issue.mockResolvedValue({
      trainingId: TRAINING,
      revisionId: REVISION,
      targetId: TARGET,
      action: 'check_in',
      token: TOKEN_A,
      issuedAt: '2026-09-01T00:00:00.000Z',
      expiresAt: '2026-09-01T00:01:00.000Z',
      duplicate: false,
    })
    h.setStatus.mockResolvedValue({
      trainingId: TRAINING,
      status: 'archived',
      reason: 'Completed cycle',
      changedAt: '2026-09-01T00:02:00.000Z',
      duplicate: false,
    })
    h.listRegistrations.mockResolvedValue({
      items: [{ userId: MEMBER, status: 'registered', changedAt: '2026-09-01T00:03:00.000Z' }],
      nextCursor: null,
    })
    uuid = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(REQUEST_A)
      .mockReturnValueOnce(REQUEST_B)
      .mockReturnValue(REQUEST_C)
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    uuid?.mockRestore()
    vi.useRealTimers()
  })

  function mount(): HTMLElement {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(ElearningOfflineTrainingAdminSection)
    app.mount(root)
    return root
  }

  it('publishes one training and issues a short-lived attendance token', async () => {
    const view = mount()
    fill(view)
    ;(view.querySelector('[data-testid="elearning-offline-publish"]') as HTMLButtonElement).click()
    await flush()

    expect(h.publish).toHaveBeenCalledWith(expect.objectContaining({
      requestId: REQUEST_A,
      title: 'Safety training',
      location: 'Room A',
      attendanceMode: 'training',
      registrationEnabled: false,
      memberUserIds: [MEMBER],
      targets: [expect.objectContaining({ title: 'Morning session' })],
    }))
    expect(view.querySelector('[data-testid="elearning-offline-published"]')).not.toBeNull()

    ;(view.querySelector('[data-testid="elearning-offline-issue-check-in"]') as HTMLButtonElement).click()
    await flush()
    expect(h.issue).toHaveBeenCalledWith({
      requestId: REQUEST_B,
      trainingId: TRAINING,
      targetId: TARGET,
      action: 'check_in',
    })
    expect((view.querySelector('[data-testid="elearning-offline-qr-token"]') as HTMLTextAreaElement).value)
      .toBe(TOKEN_A)
    expect((view.querySelector('[data-testid="elearning-offline-qr-symbol"]') as HTMLImageElement).src)
      .toContain('data:image/svg+xml')
  })

  it('freezes registration availability at publish and loads a closed read-only roster', async () => {
    h.publish.mockResolvedValueOnce(result({ registrationEnabled: true }))
    h.listRegistrations
      .mockResolvedValueOnce({
        items: [{ userId: MEMBER, status: 'registered', changedAt: '2026-09-01T00:03:00.000Z' }],
        nextCursor: MEMBER,
      })
      .mockResolvedValueOnce({
        items: [{ userId: REQUEST_A, status: 'not_registered', changedAt: null }],
        nextCursor: null,
      })
    const view = mount()
    fill(view)
    ;(view.querySelector('[data-testid="elearning-offline-registration-enabled"]') as HTMLInputElement).click()
    ;(view.querySelector('[data-testid="elearning-offline-publish"]') as HTMLButtonElement).click()
    await flush()

    expect(h.publish).toHaveBeenCalledWith(expect.objectContaining({ registrationEnabled: true }))
    ;(view.querySelector('[data-testid="elearning-offline-load-registrations"]') as HTMLButtonElement).click()
    await flush()
    expect(h.listRegistrations).toHaveBeenCalledWith({
      trainingId: TRAINING,
      after: undefined,
    })
    expect(view.querySelector('[data-testid="elearning-offline-registration-list"]')?.textContent)
      .toContain(MEMBER)
    expect(view.textContent).toContain('Registered')

    ;(view.querySelector(
      '[data-testid="elearning-offline-load-more-registrations"]',
    ) as HTMLButtonElement).click()
    await flush()
    expect(h.listRegistrations).toHaveBeenLastCalledWith({
      trainingId: TRAINING,
      after: MEMBER,
    })
    expect(view.querySelector('[data-testid="elearning-offline-registration-list"]')?.textContent)
      .toContain(REQUEST_A)
    expect(view.textContent).toContain('Not registered')
    expect(view.querySelector('[data-testid="elearning-offline-load-more-registrations"]')).toBeNull()
  })

  it('automatically rotates the rendered QR at the half-open expiry boundary', async () => {
    h.issue
      .mockResolvedValueOnce({
        trainingId: TRAINING,
        revisionId: REVISION,
        targetId: TARGET,
        action: 'check_in',
        token: TOKEN_A,
        issuedAt: '2026-09-01T00:00:00.000Z',
        expiresAt: '2026-09-01T00:01:00.000Z',
        duplicate: false,
      })
      .mockResolvedValueOnce({
        trainingId: TRAINING,
        revisionId: REVISION,
        targetId: TARGET,
        action: 'check_in',
        token: TOKEN_B,
        issuedAt: '2026-09-01T00:01:00.000Z',
        expiresAt: '2026-09-01T00:02:00.000Z',
        duplicate: false,
      })
    const view = mount()
    fill(view)
    ;(view.querySelector('[data-testid="elearning-offline-publish"]') as HTMLButtonElement).click()
    await flush()
    ;(view.querySelector('[data-testid="elearning-offline-issue-check-in"]') as HTMLButtonElement).click()
    await flush()

    await vi.advanceTimersByTimeAsync(60_000)
    await flush()

    expect(h.issue).toHaveBeenCalledTimes(2)
    expect(h.issue.mock.calls[1]?.[0]).toEqual({
      requestId: REQUEST_C,
      trainingId: TRAINING,
      targetId: TARGET,
      action: 'check_in',
    })
    expect((view.querySelector('[data-testid="elearning-offline-qr-token"]') as HTMLTextAreaElement).value)
      .toBe(TOKEN_B)
  })

  it('archives with a retry-stable request id and clears active QR material', async () => {
    const view = mount()
    fill(view)
    ;(view.querySelector('[data-testid="elearning-offline-publish"]') as HTMLButtonElement).click()
    await flush()
    ;(view.querySelector('[data-testid="elearning-offline-issue-check-in"]') as HTMLButtonElement).click()
    await flush()
    expect(view.querySelector('[data-testid="elearning-offline-qr-symbol"]')).not.toBeNull()

    h.setStatus.mockRejectedValueOnce(new ElearningApiError('network_error', 0))
    input(view, 'elearning-offline-lifecycle-reason', 'Completed cycle')
    const archive = view.querySelector('[data-testid="elearning-offline-archive"]') as HTMLButtonElement
    archive.click()
    await flush()
    archive.click()
    await flush()
    expect(h.setStatus).toHaveBeenCalledTimes(2)
    expect(h.setStatus.mock.calls[0]?.[0]).toEqual({
      requestId: REQUEST_C,
      trainingId: TRAINING,
      status: 'archived',
      reason: 'Completed cycle',
    })
    expect(h.setStatus.mock.calls[1]?.[0].requestId).toBe(REQUEST_C)
    expect(view.querySelector('[data-testid="elearning-offline-training-status"]')?.textContent)
      .toContain('archived')
    expect(view.querySelector('[data-testid="elearning-offline-qr-symbol"]')).toBeNull()
    expect((view.querySelector('[data-testid="elearning-offline-issue-check-in"]') as HTMLButtonElement).disabled)
      .toBe(true)
  })

  it('reuses an id after failure, rotates for changed payload, and rotates after success', async () => {
    const view = mount()
    fill(view)
    h.publish.mockRejectedValueOnce(new ElearningApiError('network_error', 0))
    const button = view.querySelector('[data-testid="elearning-offline-publish"]') as HTMLButtonElement
    button.click()
    await flush()
    button.click()
    await flush()
    expect(h.publish.mock.calls[0]?.[0].requestId).toBe(REQUEST_A)
    expect(h.publish.mock.calls[1]?.[0].requestId).toBe(REQUEST_A)

    fill(view, 'Room B')
    button.click()
    await flush()
    expect(h.publish.mock.calls[2]?.[0].requestId).toBe(REQUEST_B)

    button.click()
    await flush()
    expect(h.publish.mock.calls[3]?.[0].requestId).toBe(REQUEST_C)
  })

  it('rejects incomplete input without calling the backend', async () => {
    const view = mount()
    ;(view.querySelector('[data-testid="elearning-offline-publish"]') as HTMLButtonElement).click()
    await flush()
    expect(h.publish).not.toHaveBeenCalled()
    expect(view.querySelector('[data-testid="elearning-offline-admin-status"]')?.textContent)
      .toContain('Complete every field')
  })
})
