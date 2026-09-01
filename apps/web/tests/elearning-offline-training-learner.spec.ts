import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { useLocale } from '../src/composables/useLocale'

const h = vi.hoisted(() => ({
  list: vi.fn(),
  record: vi.fn(),
}))

vi.mock('../src/services/elearningOfflineTraining', async () => {
  const actual = await vi.importActual<typeof import('../src/services/elearningOfflineTraining')>(
    '../src/services/elearningOfflineTraining',
  )
  return {
    ...actual,
    listMyElearningOfflineTrainings: h.list,
    recordElearningOfflineAttendance: h.record,
  }
})

import { ElearningApiError } from '../src/services/elearning'
import ElearningOfflineTrainingLearnerSection from '../src/views/ElearningOfflineTrainingLearnerSection.vue'

const TRAINING = '11111111-1111-4111-8111-111111111111'
const REVISION = '22222222-2222-4222-8222-222222222222'
const TARGET = '33333333-3333-4333-8333-333333333333'
const EVENT = '44444444-4444-4444-8444-444444444444'
const REQUEST_A = '55555555-5555-4555-8555-555555555555'
const REQUEST_B = '66666666-6666-4666-8666-666666666666'

async function flush(cycles = 10): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function input(root: HTMLElement, value: string): void {
  const node = root.querySelector('[data-testid="elearning-offline-attendance-token"]') as HTMLTextAreaElement
  node.value = value
  node.dispatchEvent(new Event('input', { bubbles: true }))
}

function training(attendanceStatus: 'not_checked_in' | 'checked_in' | 'checked_out' = 'not_checked_in') {
  const checkedInAt = attendanceStatus === 'not_checked_in' ? null : '2026-09-01T02:00:00.000Z'
  const checkedOutAt = attendanceStatus === 'checked_out' ? '2026-09-01T04:00:00.000Z' : null
  return {
    trainingId: TRAINING,
    revisionId: REVISION,
    title: 'Safety training',
    location: 'Room A',
    attendanceMode: 'training',
    status: 'active',
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
      attendanceStatus,
      checkedInAt,
      checkedOutAt,
    }],
    completionStatus: attendanceStatus === 'checked_out' ? 'completed' : 'in_progress',
  }
}

describe('ElearningOfflineTrainingLearnerSection', () => {
  let app: App<Element> | null = null
  let root: HTMLDivElement | null = null
  let uuid: ReturnType<typeof vi.spyOn> | null = null

  beforeEach(() => {
    useLocale().setLocale('en')
    h.list.mockReset()
    h.record.mockReset()
    h.list.mockResolvedValue({ trainings: [training()] })
    h.record.mockResolvedValue({
      eventId: EVENT,
      trainingId: TRAINING,
      revisionId: REVISION,
      targetId: TARGET,
      action: 'check_in',
      occurredAt: '2026-09-01T02:00:00.000Z',
      targetStatus: 'checked_in',
      completionStatus: 'in_progress',
      completedTargetCount: 0,
      totalTargetCount: 1,
      duplicate: false,
    })
    uuid = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(REQUEST_A)
      .mockReturnValue(REQUEST_B)
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    uuid?.mockRestore()
  })

  async function mount(): Promise<HTMLElement> {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(ElearningOfflineTrainingLearnerSection)
    app.mount(root)
    await flush()
    return root
  }

  it('renders assigned sessions and refreshes authoritative attendance after success', async () => {
    const view = await mount()
    expect(view.textContent).toContain('Safety training')
    expect(view.textContent).toContain('Not checked in')
    h.list.mockResolvedValueOnce({ trainings: [training('checked_in')] })
    input(view, 'signed-token')
    ;(view.querySelector('[data-testid="elearning-offline-attend"]') as HTMLButtonElement).click()
    await flush()

    expect(h.record).toHaveBeenCalledWith({ requestId: REQUEST_A, token: 'signed-token' })
    expect(h.list).toHaveBeenCalledTimes(2)
    expect(view.textContent).toContain('Checked in')
    expect((view.querySelector('[data-testid="elearning-offline-attendance-token"]') as HTMLTextAreaElement).value)
      .toBe('')
  })

  it('reuses an id after failure and rotates only after a successful attendance record', async () => {
    const view = await mount()
    h.record.mockRejectedValueOnce(new ElearningApiError('network_error', 0))
    input(view, 'signed-token')
    const button = view.querySelector('[data-testid="elearning-offline-attend"]') as HTMLButtonElement
    button.click()
    await flush()
    button.click()
    await flush()
    expect(h.record.mock.calls[0]?.[0].requestId).toBe(REQUEST_A)
    expect(h.record.mock.calls[1]?.[0].requestId).toBe(REQUEST_A)

    input(view, 'signed-token')
    button.click()
    await flush()
    expect(h.record.mock.calls[2]?.[0].requestId).toBe(REQUEST_B)
  })

  it('fails locally when the token is empty', async () => {
    const view = await mount()
    ;(view.querySelector('[data-testid="elearning-offline-attend"]') as HTMLButtonElement).click()
    await flush()
    expect(h.record).not.toHaveBeenCalled()
    expect(view.querySelector('[data-testid="elearning-offline-learner-status"]')?.textContent)
      .toContain('Enter an attendance token')
  })
})
