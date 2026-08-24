import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'

const h = vi.hoisted(() => ({
  capabilities: vi.fn(),
  list: vi.fn(),
  startWatch: vi.fn(),
  ticket: vi.fn(),
  heartbeat: vi.fn(),
  startExam: vi.fn(),
  submitExam: vi.fn(),
}))

vi.mock('../src/services/elearning', async () => {
  const actual = await vi.importActual<typeof import('../src/services/elearning')>('../src/services/elearning')
  return {
    ...actual,
    getElearningCapabilities: h.capabilities,
    listMyElearningCourses: h.list,
    startElearningWatch: h.startWatch,
    issueElearningPlaybackTicket: h.ticket,
    sendElearningHeartbeat: h.heartbeat,
    startElearningExam: h.startExam,
    submitElearningExam: h.submitExam,
  }
})

import {
  ELEARNING_WATCH_HEARTBEAT_INTERVAL_MS,
  elearningPlaybackSourceUrl,
} from '../src/services/elearning'
import ElearningLearnerView from '../src/views/ElearningLearnerView.vue'

const COURSE = '11111111-1111-4111-8111-111111111111'
const VERSION = '22222222-2222-4222-8222-222222222222'
const VIDEO = '33333333-3333-4333-8333-333333333333'
const EXAM_ITEM = '44444444-4444-4444-8444-444444444444'
const SESSION = '77777777-7777-4777-8777-777777777777'
const SESSION_B = '99999999-9999-4999-8999-999999999999'
const ATTEMPT = '88888888-8888-4888-8888-888888888888'
const Q1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MEDIA = '66666666-6666-4666-8666-666666666666'

async function flushUi(cycles = 10): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function flushUntil(predicate: () => boolean, cycles = 40): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
    if (predicate()) return
  }
  throw new Error('flushUntil timeout')
}

function heartbeatBodies(): Array<{ sequence: number; positionMs: number; playing: boolean }> {
  return h.heartbeat.mock.calls.map((call) => call[1] as { sequence: number; positionMs: number; playing: boolean })
}

function course(over: Record<string, unknown> = {}) {
  return {
    courseId: COURSE,
    courseVersionId: VERSION,
    title: '示范课',
    assignment: { deadline: null, assignedAt: '2026-01-02T03:04:05.000Z' },
    video: {
      itemId: VIDEO,
      durationMs: 5000,
      status: 'not_started',
      effectiveMs: 0,
      maxPositionMs: 0,
      completedAt: null,
    },
    exam: { itemId: EXAM_ITEM, latestAttempt: null },
    completed: false,
    ...over,
  }
}

function watchState(over: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION,
    status: 'in_progress',
    lastSequence: 1,
    lastClientPositionMs: 0,
    effectiveMs: 0,
    maxPositionMs: 0,
    durationMs: 5000,
    creditedMs: 0,
    duplicate: false,
    ...over,
  }
}

function v01Capabilities(over: Record<string, unknown> = {}, flags: Record<string, unknown> = {}) {
  return {
    enabled: true,
    capabilities: {
      content: true,
      assignment: true,
      assessment: true,
      incentive: false,
      analytics: false,
      media: true,
      ...flags,
    },
    ...over,
  }
}

describe('ElearningLearnerView', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  function mountView() {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(ElearningLearnerView)
    app.mount(container)
    return container
  }

  beforeEach(() => {
    h.capabilities.mockReset()
    h.list.mockReset()
    h.startWatch.mockReset()
    h.ticket.mockReset()
    h.heartbeat.mockReset()
    h.startExam.mockReset()
    h.submitExam.mockReset()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    h.capabilities.mockResolvedValue(v01Capabilities())
    h.list.mockResolvedValue({ courses: [course()] })
    h.startWatch.mockResolvedValue(watchState())
    h.ticket.mockResolvedValue({
      token: 'play.token',
      expiresAt: '2026-08-25T12:10:00.000Z',
      ttlSeconds: 600,
      itemId: VIDEO,
      mediaId: MEDIA,
    })
    h.heartbeat.mockImplementation(async (_session: string, body: { sequence: number; positionMs: number; playing: boolean }) => watchState({
      lastSequence: body.sequence,
      lastClientPositionMs: body.positionMs,
      status: 'in_progress',
    }))
    h.startExam.mockResolvedValue({
      attemptId: ATTEMPT,
      attemptNo: 1,
      status: 'started',
      duplicate: false,
      paper: {
        domain: 'elearning.exam.paper.v1',
        version: 1,
        questions: [{
          position: 1,
          questionRevisionId: Q1,
          questionType: 'single_choice',
          prompt: 'Pick one',
          options: [
            { id: 'a', text: 'alpha' },
            { id: 'b', text: 'beta' },
          ],
          points: 10,
        }],
      },
    })
    h.submitExam.mockResolvedValue({
      attemptId: ATTEMPT,
      attemptNo: 1,
      status: 'graded',
      autoScore: 10,
      totalScore: 10,
      passed: true,
      duplicate: false,
    })
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('lists assigned courses and keeps exam disabled until the server reports video completed', async () => {
    const root = mountView()
    await flushUi()
    expect(root.textContent).toContain('学习中心')
    expect(root.textContent).toContain('示范课')
    const examBtn = root.querySelector('[data-testid="elearning-start-exam"]') as HTMLButtonElement
    expect(examBtn.disabled).toBe(true)
  })

  it('starts authorized watch+ticket, sends monotonic playing heartbeats, and a final playing beat on ended', async () => {
    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-start-watch"]') as HTMLButtonElement).click()
    await flushUi()
    expect(h.startWatch).toHaveBeenCalledWith(VIDEO)
    expect(h.ticket).toHaveBeenCalledWith(VIDEO)
    const video = root.querySelector('[data-testid="elearning-learner-video"]') as HTMLVideoElement
    expect(video.getAttribute('src') || video.src).toContain(elearningPlaybackSourceUrl('play.token'))
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 0 })
    video.dispatchEvent(new Event('play'))
    await flushUi()
    expect(h.heartbeat).toHaveBeenCalledTimes(1)
    expect(h.heartbeat.mock.calls[0]?.[0]).toBe(SESSION)
    expect(h.heartbeat.mock.calls[0]?.[1]).toEqual({ sequence: 2, positionMs: 0, playing: true })

    video.currentTime = 1
    vi.advanceTimersByTime(ELEARNING_WATCH_HEARTBEAT_INTERVAL_MS)
    await flushUi()
    expect(h.heartbeat).toHaveBeenCalledTimes(2)
    expect(h.heartbeat.mock.calls[1]?.[1]).toMatchObject({ sequence: 3, positionMs: 1000, playing: true })

    video.currentTime = 5
    video.dispatchEvent(new Event('ended'))
    await flushUi()
    const last = h.heartbeat.mock.calls.at(-1)?.[1] as { sequence: number; playing: boolean; positionMs: number }
    expect(last.playing).toBe(true)
    expect(last.sequence).toBe(4)
    expect(last.positionMs).toBe(5000)
    const sequences = h.heartbeat.mock.calls.map((call) => (call[1] as { sequence: number }).sequence)
    expect(sequences).toEqual([2, 3, 4])
  })

  it('does not enable exam from client ended; enables only after server list says video completed', async () => {
    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-start-watch"]') as HTMLButtonElement).click()
    await flushUi()
    const video = root.querySelector('[data-testid="elearning-learner-video"]') as HTMLVideoElement
    video.dispatchEvent(new Event('play'))
    await flushUi()
    video.dispatchEvent(new Event('ended'))
    await flushUi()
    expect((root.querySelector('[data-testid="elearning-start-exam"]') as HTMLButtonElement).disabled).toBe(true)

    h.heartbeat.mockImplementation(async (_session: string, body: { sequence: number }) => watchState({
      lastSequence: body.sequence,
      status: 'completed',
    }))
    h.list.mockResolvedValue({
      courses: [course({
        video: {
          itemId: VIDEO,
          durationMs: 5000,
          status: 'completed',
          effectiveMs: 4500,
          maxPositionMs: 5000,
          completedAt: '2026-01-03T04:05:06.000Z',
        },
      })],
    })
    video.dispatchEvent(new Event('play'))
    await flushUi()
    expect((root.querySelector('[data-testid="elearning-start-exam"]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('renders only the public paper, submits answers, and shows server autoScore/totalScore/pass', async () => {
    h.list.mockResolvedValue({
      courses: [course({
        video: {
          itemId: VIDEO,
          durationMs: 5000,
          status: 'completed',
          effectiveMs: 4500,
          maxPositionMs: 5000,
          completedAt: '2026-01-03T04:05:06.000Z',
        },
      })],
    })
    h.startExam.mockResolvedValue({
      attemptId: ATTEMPT,
      attemptNo: 1,
      status: 'started',
      duplicate: false,
      paper: {
        domain: 'elearning.exam.paper.v1',
        version: 1,
        questions: [{
          position: 1,
          questionRevisionId: Q1,
          questionType: 'single_choice',
          prompt: 'Pick one',
          options: [
            { id: 'a', text: 'alpha' },
            { id: 'b', text: 'beta' },
          ],
          points: 10,
          answerKey: { correct: ['a'] },
          explanation: 'secret-explanation',
          storageKey: 'elearning-media/secret.mp4',
        }],
      },
    })
    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-start-exam"]') as HTMLButtonElement).click()
    await flushUi()
    const text = root.textContent ?? ''
    expect(text).toContain('Pick one')
    expect(text).toContain('alpha')
    expect(text).not.toContain('secret-explanation')
    expect(text).not.toContain('answerKey')
    expect(text).not.toContain('elearning-media/secret.mp4')
    expect(text).not.toContain('storageKey')
    const option = root.querySelector('input[value="a"]') as HTMLInputElement
    option.checked = true
    option.dispatchEvent(new Event('change', { bubbles: true }))
    ;(root.querySelector('[data-testid="elearning-submit-exam"]') as HTMLButtonElement).click()
    await flushUi()
    expect(h.submitExam).toHaveBeenCalledWith(ATTEMPT, { [Q1]: ['a'] })
    expect(root.querySelector('[data-testid="elearning-exam-result"]')?.textContent).toContain('得分 10 / 10')
    expect(root.querySelector('[data-testid="elearning-exam-result"]')?.textContent).toContain('通过')
  })

  it('cleans heartbeat timers on unmount', async () => {
    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-start-watch"]') as HTMLButtonElement).click()
    await flushUi()
    const video = root.querySelector('[data-testid="elearning-learner-video"]') as HTMLVideoElement
    video.dispatchEvent(new Event('play'))
    await flushUi()
    h.heartbeat.mockClear()
    app?.unmount()
    app = null
    vi.advanceTimersByTime(ELEARNING_WATCH_HEARTBEAT_INTERVAL_MS * 3)
    await flushUi()
    expect(h.heartbeat).not.toHaveBeenCalled()
  })

  it('serializes an ended playing=true beat behind an in-flight heartbeat with unique sequences', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let inFlight = 0
    let maxInFlight = 0
    h.heartbeat.mockImplementation(async (_session: string, body: { sequence: number; positionMs: number; playing: boolean }) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        if (h.heartbeat.mock.calls.length === 1) await gate
        return watchState({
          lastSequence: body.sequence,
          lastClientPositionMs: body.positionMs,
          status: 'in_progress',
        })
      } finally {
        inFlight -= 1
      }
    })

    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-start-watch"]') as HTMLButtonElement).click()
    await flushUi()
    const video = root.querySelector('[data-testid="elearning-learner-video"]') as HTMLVideoElement
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 0 })
    video.dispatchEvent(new Event('play'))
    await flushUntil(() => h.heartbeat.mock.calls.length === 1)
    expect(h.heartbeat).toHaveBeenCalledTimes(1)

    video.currentTime = 5
    video.dispatchEvent(new Event('ended'))
    await flushUi()
    expect(h.heartbeat).toHaveBeenCalledTimes(1)
    expect(maxInFlight).toBe(1)

    release()
    await flushUntil(() => h.heartbeat.mock.calls.length === 2)
    expect(maxInFlight).toBe(1)
    const bodies = heartbeatBodies()
    expect(bodies.map((body) => body.sequence)).toEqual([2, 3])
    expect(new Set(bodies.map((body) => body.sequence)).size).toBe(2)
    expect(bodies[1]).toEqual({ sequence: 3, positionMs: 5000, playing: true })
  })

  it('enqueues pause and seeking as zero-credit beats and resumes the timer after seeked while playing', async () => {
    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-start-watch"]') as HTMLButtonElement).click()
    await flushUi()
    const video = root.querySelector('[data-testid="elearning-learner-video"]') as HTMLVideoElement
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 0 })
    Object.defineProperty(video, 'paused', { configurable: true, value: false })
    Object.defineProperty(video, 'ended', { configurable: true, value: false })
    video.dispatchEvent(new Event('play'))
    await flushUi()
    expect(heartbeatBodies()).toEqual([{ sequence: 2, positionMs: 0, playing: true }])

    video.currentTime = 2
    video.dispatchEvent(new Event('pause'))
    await flushUi()
    expect(heartbeatBodies().at(-1)).toEqual({ sequence: 3, positionMs: 2000, playing: false })
    h.heartbeat.mockClear()
    vi.advanceTimersByTime(ELEARNING_WATCH_HEARTBEAT_INTERVAL_MS * 3)
    await flushUi()
    expect(h.heartbeat).not.toHaveBeenCalled()

    video.currentTime = 4
    video.dispatchEvent(new Event('seeking'))
    await flushUi()
    expect(heartbeatBodies().at(-1)).toEqual({ sequence: 4, positionMs: 4000, playing: false })

    Object.defineProperty(video, 'paused', { configurable: true, value: false })
    video.dispatchEvent(new Event('seeked'))
    await flushUi()
    h.heartbeat.mockClear()
    vi.advanceTimersByTime(ELEARNING_WATCH_HEARTBEAT_INTERVAL_MS)
    await flushUi()
    expect(heartbeatBodies()).toEqual([{ sequence: 5, positionMs: 4000, playing: true }])
  })

  it('does not let an ended pause preempt the final playing=true beat', async () => {
    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-start-watch"]') as HTMLButtonElement).click()
    await flushUi()
    const video = root.querySelector('[data-testid="elearning-learner-video"]') as HTMLVideoElement
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 0 })
    Object.defineProperty(video, 'ended', { configurable: true, value: false })
    video.dispatchEvent(new Event('play'))
    await flushUi()

    video.currentTime = 5
    Object.defineProperty(video, 'ended', { configurable: true, value: true })
    video.dispatchEvent(new Event('pause'))
    video.dispatchEvent(new Event('ended'))
    await flushUi()
    const bodies = heartbeatBodies()
    expect(bodies.some((body) => body.playing === false)).toBe(false)
    expect(bodies.at(-1)).toEqual({ sequence: 3, positionMs: 5000, playing: true })
  })

  it('invalidates queued heartbeats on unmount and does not leak them after the in-flight beat resolves', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.heartbeat.mockImplementation(async (_session: string, body: { sequence: number; positionMs: number; playing: boolean }) => {
      if (h.heartbeat.mock.calls.length === 1) await gate
      return watchState({
        lastSequence: body.sequence,
        lastClientPositionMs: body.positionMs,
        status: 'in_progress',
      })
    })

    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-start-watch"]') as HTMLButtonElement).click()
    await flushUi()
    const video = root.querySelector('[data-testid="elearning-learner-video"]') as HTMLVideoElement
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 0 })
    video.dispatchEvent(new Event('play'))
    await flushUntil(() => h.heartbeat.mock.calls.length === 1)
    video.currentTime = 5
    video.dispatchEvent(new Event('ended'))
    await flushUi()
    expect(h.heartbeat).toHaveBeenCalledTimes(1)

    app?.unmount()
    app = null
    release()
    await flushUi(20)
    expect(h.heartbeat).toHaveBeenCalledTimes(1)
  })

  it('does not enqueue pause=false when currentTime has reached duration before ended', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let inFlight = 0
    let maxInFlight = 0
    h.heartbeat.mockImplementation(async (_session: string, body: { sequence: number; positionMs: number; playing: boolean }) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        if (h.heartbeat.mock.calls.length === 1) await gate
        return watchState({
          lastSequence: body.sequence,
          lastClientPositionMs: body.positionMs,
          status: 'in_progress',
        })
      } finally {
        inFlight -= 1
      }
    })

    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-start-watch"]') as HTMLButtonElement).click()
    await flushUi()
    const video = root.querySelector('[data-testid="elearning-learner-video"]') as HTMLVideoElement
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 0 })
    Object.defineProperty(video, 'ended', { configurable: true, writable: true, value: false })
    Object.defineProperty(video, 'duration', { configurable: true, value: 5 })
    video.dispatchEvent(new Event('play'))
    await flushUntil(() => h.heartbeat.mock.calls.length === 1)
    expect(h.heartbeat).toHaveBeenCalledTimes(1)

    video.currentTime = 5
    video.dispatchEvent(new Event('pause'))
    video.dispatchEvent(new Event('ended'))
    await flushUi()
    expect(h.heartbeat).toHaveBeenCalledTimes(1)
    expect(maxInFlight).toBe(1)

    release()
    await flushUntil(() => h.heartbeat.mock.calls.length === 2)
    expect(maxInFlight).toBe(1)
    const bodies = heartbeatBodies()
    expect(bodies.some((body) => body.playing === false)).toBe(false)
    expect(bodies.map((body) => body.sequence)).toEqual([2, 3])
    expect(bodies[1]).toEqual({ sequence: 3, positionMs: 5000, playing: true })
  })

  it('fetches capabilities before listing and does not require parked incentive/analytics', async () => {
    const root = mountView()
    await flushUi()
    expect(h.capabilities).toHaveBeenCalledTimes(1)
    expect(h.list).toHaveBeenCalledTimes(1)
    expect(h.capabilities.mock.invocationCallOrder[0]).toBeLessThan(h.list.mock.invocationCallOrder[0])
    expect(root.textContent).toContain('示范课')
    expect(h.startWatch).not.toHaveBeenCalled()
    expect(h.startExam).not.toHaveBeenCalled()
  })

  it('fails closed without list/watch/exam when enabled or a V0.1 capability is false', async () => {
    h.capabilities.mockResolvedValue(v01Capabilities({}, { media: false, incentive: true, analytics: true }))
    const root = mountView()
    await flushUi()
    expect(h.list).not.toHaveBeenCalled()
    expect(h.startWatch).not.toHaveBeenCalled()
    expect(h.startExam).not.toHaveBeenCalled()
    expect(root.querySelector('[data-testid="elearning-learner-status"]')?.textContent).toContain('feature_disabled')
    expect(root.textContent).not.toContain('暂无已指派课程')

    app?.unmount()
    container?.remove()
    h.capabilities.mockResolvedValue(v01Capabilities({ enabled: false }))
    const disabled = mountView()
    await flushUi()
    expect(h.list).not.toHaveBeenCalled()
    expect(h.startWatch).not.toHaveBeenCalled()
    expect(h.startExam).not.toHaveBeenCalled()
    expect(disabled.querySelector('[data-testid="elearning-learner-status"]')?.textContent).toContain('feature_disabled')
  })

  it('does not leak stale queued beats from a stopped session into a new session', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.startWatch.mockImplementation(async () => {
      if (h.startWatch.mock.calls.length === 1) return watchState()
      return watchState({ sessionId: SESSION_B, lastSequence: 7 })
    })
    h.heartbeat.mockImplementation(async (_session: string, body: { sequence: number; positionMs: number; playing: boolean }) => {
      if (h.heartbeat.mock.calls.length === 1) await gate
      return watchState({
        lastSequence: body.sequence,
        lastClientPositionMs: body.positionMs,
        status: 'in_progress',
      })
    })

    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-start-watch"]') as HTMLButtonElement).click()
    await flushUi()
    const firstVideo = root.querySelector('[data-testid="elearning-learner-video"]') as HTMLVideoElement
    Object.defineProperty(firstVideo, 'currentTime', { configurable: true, writable: true, value: 1 })
    firstVideo.dispatchEvent(new Event('play'))
    await flushUntil(() => h.heartbeat.mock.calls.length === 1)
    firstVideo.currentTime = 5
    firstVideo.dispatchEvent(new Event('ended'))
    await flushUi()
    expect(h.heartbeat).toHaveBeenCalledTimes(1)

    ;(root.querySelector('[data-testid="elearning-start-watch"]') as HTMLButtonElement).click()
    await flushUi()
    release()
    await flushUi(20)
    expect(h.heartbeat).toHaveBeenCalledTimes(1)
    expect(h.heartbeat.mock.calls[0]?.[0]).toBe(SESSION)

    const secondVideo = root.querySelector('[data-testid="elearning-learner-video"]') as HTMLVideoElement
    Object.defineProperty(secondVideo, 'currentTime', { configurable: true, writable: true, value: 0 })
    secondVideo.dispatchEvent(new Event('play'))
    await flushUntil(() => h.heartbeat.mock.calls.length === 2)
    expect(h.heartbeat.mock.calls[1]?.[0]).toBe(SESSION_B)
    expect(h.heartbeat.mock.calls[1]?.[1]).toEqual({ sequence: 8, positionMs: 0, playing: true })
    expect(h.heartbeat).toHaveBeenCalledTimes(2)
  })
})
