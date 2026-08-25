import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { useLocale } from '../src/composables/useLocale'

const h = vi.hoisted(() => ({
  capabilities: vi.fn(),
  list: vi.fn(),
  startWatch: vi.fn(),
  ticket: vi.fn(),
  heartbeat: vi.fn(),
  startExam: vi.fn(),
  saveExam: vi.fn(),
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
    saveElearningExamAnswers: h.saveExam,
    submitElearningExam: h.submitExam,
  }
})

import {
  ELEARNING_WATCH_HEARTBEAT_INTERVAL_MS,
  ElearningApiError,
  elearningPlaybackSourceUrl,
  type ElearningLearnerVideoStatus,
} from '../src/services/elearning'
import ElearningLearnerView from '../src/views/ElearningLearnerView.vue'
import {
  elearningExamAnswerProgress,
  elearningLabel,
  elearningLearnerVideoProgressLabel,
  elearningVideoStatusLabel,
  elearningWatchProgressPercent,
} from '../src/views/elearningLabels'

const COURSE = '11111111-1111-4111-8111-111111111111'
const COURSE_PROGRESS = '12121212-1212-4121-8121-121212121212'
const COURSE_DONE = '13131313-1313-4131-8131-131313131313'
const VERSION = '22222222-2222-4222-8222-222222222222'
const VIDEO = '33333333-3333-4333-8333-333333333333'
const VIDEO_B = '35353535-3535-4353-8353-353535353535'
const EXAM_ITEM = '44444444-4444-4444-8444-444444444444'
const TICKET_RENEWAL_LEAD_MS = 30_000
const TICKET_RENEWAL_MIN_DELAY_MS = 5_000
const SESSION = '77777777-7777-4777-8777-777777777777'
const SESSION_B = '99999999-9999-4999-8999-999999999999'
const ATTEMPT = '88888888-8888-4888-8888-888888888888'
const ATTEMPT_B = '86868686-8686-4868-8868-868686868686'
const Q1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const Q2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
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

async function drainHeartbeats(cycles = 80): Promise<void> {
  let last = -1
  let idle = 0
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
    const next = h.heartbeat.mock.calls.length
    if (next === last) {
      idle += 1
      if (idle >= 8) return
    } else {
      idle = 0
      last = next
    }
  }
}

function heartbeatBodies(): Array<{ sequence: number; positionMs: number; playing: boolean }> {
  return h.heartbeat.mock.calls.map((call) => call[1] as { sequence: number; positionMs: number; playing: boolean })
}

function courseEl(root: HTMLElement, courseId: string): HTMLElement {
  return root.querySelector(`[data-testid="elearning-course-${courseId}"]`) as HTMLElement
}

function courseQuery<T extends Element>(root: HTMLElement, courseId: string, testId: string): T {
  return courseEl(root, courseId).querySelector(`[data-testid="${testId}"]`) as T
}

function progressText(root: HTMLElement, courseId: string): string {
  return courseQuery(root, courseId, 'elearning-video-progress').textContent ?? ''
}

function completedVideoCourse(over: Record<string, unknown> = {}) {
  return course({
    video: vid({
      status: 'completed',
      effectiveMs: 4500,
      maxPositionMs: 5000,
      completedAt: '2026-01-03T04:05:06.000Z',
    }),
    ...over,
  })
}

function selectOption(root: HTMLElement, value: string, checked = true): void {
  const option = root.querySelector(`input[value="${value}"]`) as HTMLInputElement
  option.checked = checked
  option.dispatchEvent(new Event('change', { bubbles: true }))
}

function prepareVideo(video: HTMLVideoElement, durationSec: number, currentTime = 0): HTMLVideoElement {
  Object.defineProperty(video, 'duration', { configurable: true, writable: true, value: durationSec })
  Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: currentTime })
  return video
}

function dispatchSeekCycle(video: HTMLVideoElement, startEvent: 'loadedmetadata' | 'durationchange'): void {
  video.dispatchEvent(new Event(startEvent))
  video.dispatchEvent(new Event('seeking'))
  video.dispatchEvent(new Event('seeked'))
}

function playbackTicket(over: Record<string, unknown> = {}) {
  const ttlSeconds = typeof over.ttlSeconds === 'number' ? over.ttlSeconds : 600
  return {
    token: 'play.token',
    itemId: VIDEO,
    mediaId: MEDIA,
    ttlSeconds,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    ...over,
  }
}

function videoSrc(video: HTMLVideoElement): string {
  return video.getAttribute('src') || video.src
}

function simulateTicketSrcReload(video: HTMLVideoElement, durationSec = 5): void {
  Object.defineProperty(video, 'paused', { configurable: true, writable: true, value: true })
  Object.defineProperty(video, 'ended', { configurable: true, writable: true, value: false })
  if (!Number.isFinite(video.duration) || video.duration <= 0) {
    Object.defineProperty(video, 'duration', { configurable: true, writable: true, value: durationSec })
  }
  video.dispatchEvent(new Event('pause'))
  video.currentTime = 0
  dispatchSeekCycle(video, 'loadedmetadata')
}

function vid(over: Record<string, unknown> = {}) {
  return {
    itemId: VIDEO,
    durationMs: 5000,
    status: 'not_started',
    effectiveMs: 0,
    maxPositionMs: 0,
    completedAt: null,
    ...over,
  }
}

function course(over: Record<string, unknown> = {}) {
  return {
    courseId: COURSE,
    courseVersionId: VERSION,
    title: '示范课',
    assignment: { deadline: null, assignedAt: '2026-01-02T03:04:05.000Z' },
    video: vid(),
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
    useLocale().setLocale('zh-CN')
    h.capabilities.mockReset()
    h.list.mockReset()
    h.startWatch.mockReset()
    h.ticket.mockReset()
    h.heartbeat.mockReset()
    h.startExam.mockReset()
    h.saveExam.mockReset()
    h.submitExam.mockReset()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
    h.capabilities.mockResolvedValue(v01Capabilities())
    h.list.mockResolvedValue({ courses: [course()] })
    h.startWatch.mockResolvedValue(watchState())
    h.ticket.mockResolvedValue(playbackTicket())
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
      answers: { [Q1]: [] },
    })
    h.saveExam.mockImplementation(async (_attemptId: string, answers: Record<string, string[]>) => ({
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
      answers,
    }))
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
    useLocale().setLocale('en')
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

  it('renders English learner chrome when locale is en and keeps course titles as data', async () => {
    useLocale().setLocale('en')
    const root = mountView()
    await flushUi()
    const text = root.textContent ?? ''
    expect(text).toContain('Learning Center')
    expect(text).toContain('Start learning')
    expect(text).toContain('Start exam')
    expect(text).toContain('Deadline')
    expect(text).toContain('None')
    expect(text).toContain('Not started')
    expect(text).toContain('Incomplete')
    expect(text).toContain('示范课')
    expect(text).not.toContain('学习中心')
    expect(text).not.toContain('开始学习')
    expect(text).not.toContain('未开始')
  })

  it('renders Chinese learner chrome when locale is zh-CN', async () => {
    useLocale().setLocale('zh-CN')
    const root = mountView()
    await flushUi()
    const text = root.textContent ?? ''
    expect(text).toContain('学习中心')
    expect(text).toContain('开始学习')
    expect(text).toContain('开始考试')
    expect(text).toContain('截止日期')
    expect(text).toContain('未开始')
    expect(text).toContain('未完成')
    expect(text).toContain('示范课')
    expect(text).not.toContain('Learning Center')
    expect(text).not.toContain('Start learning')
    expect(text).not.toContain('Not started')
  })

  it('switches learner chrome live when locale changes', async () => {
    useLocale().setLocale('en')
    const root = mountView()
    await flushUi()
    expect(root.textContent).toContain('Learning Center')
    expect(root.textContent).toContain('Start learning')
    expect(root.textContent).toContain('Not started')
    expect(root.textContent).toContain('示范课')

    useLocale().setLocale('zh-CN')
    await nextTick()
    expect(root.textContent).toContain('学习中心')
    expect(root.textContent).toContain('开始学习')
    expect(root.textContent).toContain('未开始')
    expect(root.textContent).toContain('示范课')
    expect(root.textContent).not.toContain('Learning Center')
    expect(root.textContent).not.toContain('Start learning')
    expect(root.textContent).not.toContain('Not started')
  })

  it('renders each closed video status without a silent unknown fallback', async () => {
    const statuses: ElearningLearnerVideoStatus[] = ['not_started', 'in_progress', 'completed']
    expect(statuses.map((status) => elearningVideoStatusLabel(status, false))).toEqual([
      'Not started',
      'In progress',
      'Completed',
    ])
    expect(statuses.map((status) => elearningVideoStatusLabel(status, true))).toEqual([
      '未开始',
      '学习中',
      '已完成',
    ])

    h.list.mockResolvedValue({
      courses: [
        course({
          video: {
            itemId: VIDEO,
            durationMs: 5000,
            status: 'not_started',
            effectiveMs: 0,
            maxPositionMs: 0,
            completedAt: null,
          },
        }),
        course({
          courseId: COURSE_PROGRESS,
          video: {
            itemId: VIDEO,
            durationMs: 5000,
            status: 'in_progress',
            effectiveMs: 1000,
            maxPositionMs: 1000,
            completedAt: null,
          },
        }),
        course({
          courseId: COURSE_DONE,
          video: {
            itemId: VIDEO,
            durationMs: 5000,
            status: 'completed',
            effectiveMs: 4500,
            maxPositionMs: 5000,
            completedAt: '2026-01-03T04:05:06.000Z',
          },
        }),
      ],
    })
    useLocale().setLocale('en')
    const root = mountView()
    await flushUi()
    expect(root.querySelector(`[data-testid="elearning-course-${COURSE}"]`)?.textContent).toContain('Not started')
    expect(root.querySelector(`[data-testid="elearning-course-${COURSE_PROGRESS}"]`)?.textContent).toContain('In progress')
    expect(root.querySelector(`[data-testid="elearning-course-${COURSE_DONE}"]`)?.textContent).toContain('Completed')

    useLocale().setLocale('zh-CN')
    await nextTick()
    expect(root.querySelector(`[data-testid="elearning-course-${COURSE}"]`)?.textContent).toContain('未开始')
    expect(root.querySelector(`[data-testid="elearning-course-${COURSE_PROGRESS}"]`)?.textContent).toContain('学习中')
    expect(root.querySelector(`[data-testid="elearning-course-${COURSE_DONE}"]`)?.textContent).toContain('已完成')
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
    h.list.mockResolvedValue({ courses: [completedVideoCourse()] })
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
      answers: { [Q1]: [] },
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
    const progress = root.querySelector('[data-testid="elearning-exam-answer-progress"]') as HTMLElement
    expect(progress.getAttribute('aria-live')).toBe('polite')
    expect(progress.textContent).toBe('已答 0 / 1')
    expect((root.querySelector('[data-testid="elearning-submit-exam"]') as HTMLButtonElement).disabled).toBe(true)
    selectOption(root, 'a')
    await flushUi()
    expect(progress.textContent).toBe('已答 1 / 1')
    ;(root.querySelector('[data-testid="elearning-submit-exam"]') as HTMLButtonElement).click()
    await flushUi()
    expect(h.submitExam).toHaveBeenCalledWith(ATTEMPT, { [Q1]: ['a'] })
    expect(root.querySelector('[data-testid="elearning-exam-form"]')).toBeNull()
    expect(root.querySelector('[data-testid="elearning-exam-answer-progress"]')).toBeNull()
    expect(root.querySelector('[data-testid="elearning-exam-result"]')?.textContent).toContain('得分 10 / 10')
    expect(root.querySelector('[data-testid="elearning-exam-result"]')?.textContent).toContain('通过')
  })

  it('tracks answered progress, blocks incomplete submit, and never double-counts radio changes', async () => {
    expect(elearningExamAnswerProgress(0, 2, false)).toBe('Answered 0 of 2')
    expect(elearningExamAnswerProgress(1, 2, true)).toBe('已答 1 / 2')

    h.list.mockResolvedValue({ courses: [completedVideoCourse()] })
    h.startExam.mockResolvedValue({
      attemptId: ATTEMPT,
      attemptNo: 1,
      status: 'started',
      duplicate: false,
      paper: {
        domain: 'elearning.exam.paper.v1',
        version: 1,
        questions: [
          {
            position: 1,
            questionRevisionId: Q1,
            questionType: 'single_choice',
            prompt: 'Pick one',
            options: [
              { id: 'a', text: 'alpha' },
              { id: 'b', text: 'beta' },
            ],
            points: 5,
          },
          {
            position: 2,
            questionRevisionId: Q2,
            questionType: 'multiple_choice',
            prompt: 'Pick any',
            options: [
              { id: 'c', text: 'gamma' },
              { id: 'd', text: 'delta' },
            ],
            points: 5,
          },
        ],
      },
      answers: { [Q1]: [], [Q2]: [] },
    })

    useLocale().setLocale('en')
    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-start-exam"]') as HTMLButtonElement).click()
    await flushUi()

    const progress = root.querySelector('[data-testid="elearning-exam-answer-progress"]') as HTMLElement
    const submit = root.querySelector('[data-testid="elearning-submit-exam"]') as HTMLButtonElement
    const form = root.querySelector('[data-testid="elearning-exam-form"]') as HTMLFormElement
    expect(progress.getAttribute('aria-live')).toBe('polite')
    expect(progress.textContent).toBe('Answered 0 of 2')
    expect(submit.disabled).toBe(true)

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushUi()
    expect(h.submitExam).not.toHaveBeenCalled()

    selectOption(root, 'a')
    await flushUi()
    expect(progress.textContent).toBe('Answered 1 of 2')
    expect(submit.disabled).toBe(true)
    selectOption(root, 'b')
    await flushUi()
    expect(progress.textContent).toBe('Answered 1 of 2')

    selectOption(root, 'c')
    await flushUi()
    expect(progress.textContent).toBe('Answered 2 of 2')
    expect(submit.disabled).toBe(false)
    selectOption(root, 'd')
    await flushUi()
    expect(progress.textContent).toBe('Answered 2 of 2')
    selectOption(root, 'c', false)
    await flushUi()
    expect(progress.textContent).toBe('Answered 2 of 2')
    selectOption(root, 'd', false)
    await flushUi()
    expect(progress.textContent).toBe('Answered 1 of 2')
    expect(submit.disabled).toBe(true)

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushUi()
    expect(h.submitExam).not.toHaveBeenCalled()

    useLocale().setLocale('zh-CN')
    await nextTick()
    expect(progress.textContent).toBe('已答 1 / 2')

    selectOption(root, 'c')
    await flushUi()
    expect(progress.textContent).toBe('已答 2 / 2')
    submit.click()
    await flushUi()
    expect(h.submitExam).toHaveBeenCalledTimes(1)
    expect(h.submitExam).toHaveBeenCalledWith(ATTEMPT, { [Q1]: ['b'], [Q2]: ['c'] })
    expect(root.querySelector('[data-testid="elearning-exam-form"]')).toBeNull()
    expect(root.querySelector('[data-testid="elearning-exam-answer-progress"]')).toBeNull()
    expect(root.querySelector('[data-testid="elearning-exam-result"]')?.textContent).toContain('得分 10 / 10')
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

  it('renders server-grounded 0..99 progress and keeps explicit not_started/completed labels', async () => {
    expect(elearningWatchProgressPercent(0, 5000)).toBe(0)
    expect(elearningWatchProgressPercent(1000, 5000)).toBe(20)
    expect(elearningWatchProgressPercent(5000, 5000)).toBe(99)
    expect(elearningLearnerVideoProgressLabel('not_started', 0, 5000, false)).toBe('Not started')
    expect(elearningLearnerVideoProgressLabel('in_progress', 0, 5000, true)).toBe('学习中 0%')
    expect(elearningLearnerVideoProgressLabel('in_progress', 5000, 5000, false)).toBe('In progress 99%')
    expect(elearningLearnerVideoProgressLabel('completed', 4500, 5000, false)).toBe('Completed')

    useLocale().setLocale('en')
    h.list.mockResolvedValue({
      courses: [
        course(),
        course({ courseId: COURSE_PROGRESS, video: vid({ status: 'in_progress', effectiveMs: 0 }) }),
        course({
          courseId: COURSE_DONE,
          video: vid({ status: 'completed', effectiveMs: 4500, maxPositionMs: 5000, completedAt: '2026-01-03T04:05:06.000Z' }),
        }),
      ],
    })
    const root = mountView()
    await flushUi()
    expect(progressText(root, COURSE)).toBe('Not started')
    expect(progressText(root, COURSE_PROGRESS)).toBe('In progress 0%')
    expect(progressText(root, COURSE_DONE)).toBe('Completed')
    expect(courseQuery<HTMLButtonElement>(root, COURSE_PROGRESS, 'elearning-start-exam').disabled).toBe(true)
    expect(courseQuery<HTMLButtonElement>(root, COURSE_DONE, 'elearning-start-exam').disabled).toBe(false)
    useLocale().setLocale('zh-CN')
    await nextTick()
    expect(progressText(root, COURSE_PROGRESS)).toBe('学习中 0%')
  })

  it('resumes from maxPositionMs without heartbeats, then updates only the active course from server state', async () => {
    h.list.mockResolvedValue({
      courses: [
        course(),
        course({ courseId: COURSE_PROGRESS, video: vid({ status: 'in_progress', effectiveMs: 1000, maxPositionMs: 1000 }) }),
      ],
    })
    h.startWatch.mockResolvedValue(watchState({
      lastClientPositionMs: 4000,
      effectiveMs: 1500,
      maxPositionMs: 1500,
    }))
    h.heartbeat.mockImplementation(async (_session: string, body: { sequence: number; positionMs: number; playing: boolean }) => watchState({
      lastSequence: body.sequence,
      lastClientPositionMs: body.positionMs,
      status: 'in_progress',
      effectiveMs: body.positionMs >= 5000 ? 5000 : 2000,
      maxPositionMs: body.positionMs >= 5000 ? 5000 : 2500,
    }))
    const root = mountView()
    await flushUi()
    expect(progressText(root, COURSE)).toBe('未开始')
    expect(progressText(root, COURSE_PROGRESS)).toBe('学习中 20%')
    courseQuery<HTMLButtonElement>(root, COURSE, 'elearning-start-watch').click()
    await flushUi()

    const video = prepareVideo(courseQuery<HTMLVideoElement>(root, COURSE, 'elearning-learner-video'), Number.NaN, 0)
    video.dispatchEvent(new Event('loadedmetadata'))
    await flushUi()
    expect(video.currentTime).toBe(0)
    expect(h.heartbeat).not.toHaveBeenCalled()
    video.duration = 5
    dispatchSeekCycle(video, 'durationchange')
    await flushUi()
    expect(video.currentTime).toBe(1.5)
    expect(h.heartbeat).not.toHaveBeenCalled()
    expect(courseQuery<HTMLButtonElement>(root, COURSE, 'elearning-start-exam').disabled).toBe(true)

    video.dispatchEvent(new Event('play'))
    await flushUi()
    expect(progressText(root, COURSE)).toBe('学习中 40%')
    expect(progressText(root, COURSE_PROGRESS)).toBe('学习中 20%')
    h.heartbeat.mockClear()
    video.currentTime = 2
    video.dispatchEvent(new Event('seeking'))
    await flushUi()
    expect(heartbeatBodies()).toEqual([{ sequence: 3, positionMs: 2000, playing: false }])

    h.heartbeat.mockClear()
    h.startWatch.mockResolvedValue(watchState({
      sessionId: SESSION_B,
      lastSequence: 7,
      lastClientPositionMs: 12000,
      effectiveMs: 2000,
      maxPositionMs: 9000,
    }))
    courseQuery<HTMLButtonElement>(root, COURSE, 'elearning-start-watch').click()
    await flushUi()
    const clamped = prepareVideo(courseQuery<HTMLVideoElement>(root, COURSE, 'elearning-learner-video'), 5, 0)
    dispatchSeekCycle(clamped, 'loadedmetadata')
    await flushUi()
    expect(clamped.currentTime).toBe(5)
    expect(h.heartbeat).not.toHaveBeenCalled()
    expect(courseQuery<HTMLButtonElement>(root, COURSE, 'elearning-start-exam').disabled).toBe(true)

    clamped.currentTime = 5
    clamped.dispatchEvent(new Event('ended'))
    await flushUi()
    expect(progressText(root, COURSE)).toBe('学习中 99%')
    expect(progressText(root, COURSE_PROGRESS)).toBe('学习中 20%')
    expect(progressText(root, COURSE)).not.toContain('已完成')
    expect(courseQuery<HTMLButtonElement>(root, COURSE, 'elearning-start-exam').disabled).toBe(true)
    expect(h.list).toHaveBeenCalledTimes(1)
  })

  it('shows Continue exam for a latest started attempt, hydrates server answers, and restores controls', async () => {
    expect(elearningLabel('learner.continueExam', false)).toBe('Continue exam')
    expect(elearningLabel('learner.continueExam', true)).toBe('继续考试')
    h.list.mockResolvedValue({
      courses: [completedVideoCourse({
        exam: {
          itemId: EXAM_ITEM,
          latestAttempt: {
            attemptId: ATTEMPT,
            attemptNo: 1,
            status: 'started',
            autoScore: null,
            totalScore: null,
            passed: null,
            startedAt: '2026-01-04T05:06:07.000Z',
            submittedAt: null,
            gradedAt: null,
          },
        },
      })],
    })
    h.startExam.mockResolvedValue({
      attemptId: ATTEMPT,
      attemptNo: 1,
      status: 'started',
      duplicate: true,
      paper: {
        domain: 'elearning.exam.paper.v1',
        version: 1,
        questions: [
          {
            position: 1,
            questionRevisionId: Q1,
            questionType: 'single_choice',
            prompt: 'Pick one',
            options: [
              { id: 'a', text: 'alpha' },
              { id: 'b', text: 'beta' },
            ],
            points: 5,
          },
          {
            position: 2,
            questionRevisionId: Q2,
            questionType: 'multiple_choice',
            prompt: 'Pick any',
            options: [
              { id: 'c', text: 'gamma' },
              { id: 'd', text: 'delta' },
            ],
            points: 5,
          },
        ],
      },
      answers: { [Q1]: ['a'], [Q2]: ['c'] },
    })
    useLocale().setLocale('en')
    const root = mountView()
    await flushUi()
    const examBtn = root.querySelector('[data-testid="elearning-start-exam"]') as HTMLButtonElement
    expect(examBtn.textContent).toContain('Continue exam')
    expect(examBtn.textContent).not.toContain('Start exam')
    examBtn.click()
    await flushUi()
    expect(h.startExam).toHaveBeenCalledWith(EXAM_ITEM)
    expect(root.querySelector('[data-testid="elearning-exam-answer-progress"]')?.textContent).toBe('Answered 2 of 2')
    expect((root.querySelector('input[value="a"]') as HTMLInputElement).checked).toBe(true)
    expect((root.querySelector('input[value="c"]') as HTMLInputElement).checked).toBe(true)
    expect((root.querySelector('[data-testid="elearning-submit-exam"]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('serializes slow draft saves so an older request cannot overwrite a newer change', async () => {
    const releases: Array<() => void> = []
    h.saveExam.mockImplementation(async (_attemptId: string, answers: Record<string, string[]>) => {
      await new Promise<void>((resolve) => {
        releases.push(resolve)
      })
      return {
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
        answers,
      }
    })
    h.list.mockResolvedValue({ courses: [completedVideoCourse()] })
    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-start-exam"]') as HTMLButtonElement).click()
    await flushUi()
    selectOption(root, 'a')
    await flushUntil(() => h.saveExam.mock.calls.length === 1)
    selectOption(root, 'b')
    await flushUi()
    expect(h.saveExam).toHaveBeenCalledTimes(1)
    expect(h.saveExam.mock.calls[0]?.[1]).toEqual({ [Q1]: ['a'] })
    releases[0]?.()
    await flushUntil(() => h.saveExam.mock.calls.length === 2)
    expect(h.saveExam.mock.calls[1]?.[1]).toEqual({ [Q1]: ['b'] })
    releases[1]?.()
    await flushUi()
    expect(h.saveExam.mock.calls.map((call) => call[1])).toEqual([{ [Q1]: ['a'] }, { [Q1]: ['b'] }])
  })

  it('waits for queued draft saves before submit and still posts the current answer map', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.saveExam.mockImplementation(async (_attemptId: string, answers: Record<string, string[]>) => {
      if (h.saveExam.mock.calls.length === 1) await gate
      return {
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
        answers,
      }
    })
    h.list.mockResolvedValue({ courses: [completedVideoCourse()] })
    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-start-exam"]') as HTMLButtonElement).click()
    await flushUi()
    selectOption(root, 'a')
    await flushUntil(() => h.saveExam.mock.calls.length === 1)
    ;(root.querySelector('[data-testid="elearning-submit-exam"]') as HTMLButtonElement).click()
    await flushUi()
    expect(h.submitExam).not.toHaveBeenCalled()
    expect((root.querySelector('input[value="a"]') as HTMLInputElement).disabled).toBe(true)
    release()
    await flushUntil(() => h.submitExam.mock.calls.length === 1)
    expect(h.saveExam).toHaveBeenCalledWith(ATTEMPT, { [Q1]: ['a'] })
    expect(h.submitExam).toHaveBeenCalledWith(ATTEMPT, { [Q1]: ['a'] })
  })

  it('keeps local selections after a save failure, shows a values-free error, and retries later', async () => {
    h.saveExam
      .mockRejectedValueOnce(new ElearningApiError('unavailable', 503))
      .mockResolvedValue({
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
        answers: { [Q1]: ['b'] },
      })
    h.list.mockResolvedValue({ courses: [completedVideoCourse()] })
    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-start-exam"]') as HTMLButtonElement).click()
    await flushUi()
    selectOption(root, 'a')
    await flushUntil(() => (root.querySelector('[data-testid="elearning-learner-status"]')?.textContent ?? '').includes('unavailable'))
    expect((root.querySelector('input[value="a"]') as HTMLInputElement).checked).toBe(true)
    expect(root.querySelector('[data-testid="elearning-learner-status"]')?.textContent).toBe('失败：unavailable（503）')
    expect(root.querySelector('[data-testid="elearning-exam-form"]')).not.toBeNull()
    selectOption(root, 'b')
    await flushUntil(() => h.saveExam.mock.calls.length === 2)
    await flushUi()
    expect(h.saveExam.mock.calls[1]?.[1]).toEqual({ [Q1]: ['b'] })
    expect((root.querySelector('input[value="b"]') as HTMLInputElement).checked).toBe(true)
    expect(root.querySelector('[data-testid="elearning-learner-status"]')).toBeNull()
  })

  it('does not surface a delayed save failure from a previous attempt', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.saveExam.mockImplementation(async (attempt: string, answers: Record<string, string[]>) => {
      if (h.saveExam.mock.calls.length === 1) await gate
      return {
        attemptId: attempt,
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
        answers,
      }
    })
    h.startExam
      .mockResolvedValueOnce({
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
        answers: { [Q1]: [] },
      })
      .mockResolvedValueOnce({
        attemptId: ATTEMPT_B,
        attemptNo: 2,
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
        answers: { [Q1]: [] },
      })
    h.list.mockResolvedValue({ courses: [completedVideoCourse()] })
    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-start-exam"]') as HTMLButtonElement).click()
    await flushUi()
    selectOption(root, 'a')
    await flushUntil(() => h.saveExam.mock.calls.length === 1)
    ;(root.querySelector('[data-testid="elearning-start-exam"]') as HTMLButtonElement).click()
    await flushUi()
    expect(h.startExam).toHaveBeenCalledTimes(1)
    expect((root.querySelector('input[value="a"]') as HTMLInputElement).checked).toBe(true)
    release()
    await flushUntil(() => h.startExam.mock.calls.length === 2)
    await flushUi()
    expect(h.startExam.mock.calls[1]?.[0]).toBe(EXAM_ITEM)
    expect(h.saveExam.mock.calls[0]?.[0]).toBe(ATTEMPT)
    expect(root.querySelector('[data-testid="elearning-learner-status"]')).toBeNull()
    expect(root.querySelector('[data-testid="elearning-exam-form"]')).not.toBeNull()
    expect((root.querySelector('input[value="a"]') as HTMLInputElement).checked).toBe(false)
  })

  it('clears a stale autosave error after a successful submit of the current local answers', async () => {
    h.saveExam.mockRejectedValue(new ElearningApiError('unavailable', 503))
    h.list.mockResolvedValue({ courses: [completedVideoCourse()] })
    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-start-exam"]') as HTMLButtonElement).click()
    await flushUi()
    selectOption(root, 'a')
    await flushUntil(() => (root.querySelector('[data-testid="elearning-learner-status"]')?.textContent ?? '').includes('unavailable'))
    expect((root.querySelector('input[value="a"]') as HTMLInputElement).checked).toBe(true)
    expect(root.querySelector('[data-testid="elearning-learner-status"]')?.textContent).toBe('失败：unavailable（503）')
    expect((root.querySelector('[data-testid="elearning-submit-exam"]') as HTMLButtonElement).disabled).toBe(false)
    ;(root.querySelector('[data-testid="elearning-submit-exam"]') as HTMLButtonElement).click()
    await flushUntil(() => h.submitExam.mock.calls.length === 1)
    await flushUi()
    expect(h.saveExam).toHaveBeenCalledWith(ATTEMPT, { [Q1]: ['a'] })
    expect(h.submitExam).toHaveBeenCalledWith(ATTEMPT, { [Q1]: ['a'] })
    expect(root.querySelector('[data-testid="elearning-exam-form"]')).toBeNull()
    expect(root.querySelector('[data-testid="elearning-exam-result"]')?.textContent).toContain('得分 10 / 10')
    expect(root.querySelector('[data-testid="elearning-learner-status"]')).toBeNull()
  })

  it('flushes a coalesced newer draft before starting another exam', async () => {
    const EXAM_ITEM_B = '45454545-4545-4454-8454-454545454545'
    const releases: Array<() => void> = []
    h.saveExam.mockImplementation(async (_attemptId: string, answers: Record<string, string[]>) => {
      await new Promise<void>((resolve) => {
        releases.push(resolve)
      })
      return {
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
        answers,
      }
    })
    h.startExam
      .mockResolvedValueOnce({
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
        answers: { [Q1]: [] },
      })
      .mockResolvedValueOnce({
        attemptId: ATTEMPT_B,
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
        answers: { [Q1]: [] },
      })
    h.list.mockResolvedValue({
      courses: [
        completedVideoCourse(),
        completedVideoCourse({
          courseId: COURSE_DONE,
          exam: { itemId: EXAM_ITEM_B, latestAttempt: null },
        }),
      ],
    })
    const root = mountView()
    await flushUi()
    courseQuery<HTMLButtonElement>(root, COURSE, 'elearning-start-exam').click()
    await flushUi()
    selectOption(root, 'a')
    await flushUntil(() => h.saveExam.mock.calls.length === 1)
    selectOption(root, 'b')
    await flushUi()
    expect(h.saveExam).toHaveBeenCalledTimes(1)
    expect(h.startExam).toHaveBeenCalledTimes(1)
    courseQuery<HTMLButtonElement>(root, COURSE_DONE, 'elearning-start-exam').click()
    await flushUi()
    expect(h.startExam).toHaveBeenCalledTimes(1)
    expect(courseQuery<HTMLButtonElement>(root, COURSE, 'elearning-start-exam').disabled).toBe(true)
    expect(courseQuery<HTMLButtonElement>(root, COURSE_DONE, 'elearning-start-exam').disabled).toBe(true)
    expect((root.querySelector('input[value="b"]') as HTMLInputElement).disabled).toBe(true)
    expect((root.querySelector('input[value="b"]') as HTMLInputElement).checked).toBe(true)
    expect(courseEl(root, COURSE).querySelector('[data-testid="elearning-exam-form"]')).not.toBeNull()
    releases[0]?.()
    await flushUntil(() => h.saveExam.mock.calls.length === 2)
    expect(h.startExam).toHaveBeenCalledTimes(1)
    expect(h.saveExam.mock.calls[1]?.[0]).toBe(ATTEMPT)
    expect(h.saveExam.mock.calls[1]?.[1]).toEqual({ [Q1]: ['b'] })
    releases[1]?.()
    await flushUntil(() => h.startExam.mock.calls.length === 2)
    await flushUi()
    expect(h.saveExam.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      [ATTEMPT, { [Q1]: ['a'] }],
      [ATTEMPT, { [Q1]: ['b'] }],
    ])
    expect(h.startExam.mock.calls[1]?.[0]).toBe(EXAM_ITEM_B)
    expect(h.saveExam.mock.invocationCallOrder[1]).toBeLessThan(h.startExam.mock.invocationCallOrder[1])
    expect(courseEl(root, COURSE).querySelector('[data-testid="elearning-exam-form"]')).toBeNull()
    expect(courseEl(root, COURSE_DONE).querySelector('[data-testid="elearning-exam-form"]')).not.toBeNull()
    expect((root.querySelector('input[value="a"]') as HTMLInputElement).checked).toBe(false)
    expect((root.querySelector('input[value="b"]') as HTMLInputElement).checked).toBe(false)
    expect(root.querySelector('[data-testid="elearning-learner-status"]')).toBeNull()
  })

  it('aborts starting another exam when the queued draft save fails', async () => {
    const EXAM_ITEM_B = '45454545-4545-4454-8454-454545454545'
    let release!: (error: unknown) => void
    const gate = new Promise<void>((_resolve, reject) => {
      release = reject
    })
    h.saveExam.mockImplementation(async (_attemptId: string, answers: Record<string, string[]>) => {
      await gate
      return {
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
        answers,
      }
    })
    h.list.mockResolvedValue({
      courses: [
        completedVideoCourse(),
        completedVideoCourse({
          courseId: COURSE_DONE,
          exam: { itemId: EXAM_ITEM_B, latestAttempt: null },
        }),
      ],
    })
    const root = mountView()
    await flushUi()
    courseQuery<HTMLButtonElement>(root, COURSE, 'elearning-start-exam').click()
    await flushUi()
    selectOption(root, 'a')
    await flushUntil(() => h.saveExam.mock.calls.length === 1)
    courseQuery<HTMLButtonElement>(root, COURSE_DONE, 'elearning-start-exam').click()
    await flushUi()
    expect(h.startExam).toHaveBeenCalledTimes(1)
    expect(courseQuery<HTMLButtonElement>(root, COURSE_DONE, 'elearning-start-exam').disabled).toBe(true)
    expect((root.querySelector('input[value="a"]') as HTMLInputElement).disabled).toBe(true)
    expect((root.querySelector('input[value="a"]') as HTMLInputElement).checked).toBe(true)
    release(new ElearningApiError('unavailable', 503))
    await flushUntil(() => (root.querySelector('[data-testid="elearning-learner-status"]')?.textContent ?? '').includes('unavailable'))
    await flushUi()
    expect(h.startExam).toHaveBeenCalledTimes(1)
    expect(h.startExam.mock.calls[0]?.[0]).toBe(EXAM_ITEM)
    expect(root.querySelector('[data-testid="elearning-learner-status"]')?.textContent).toBe('失败：unavailable（503）')
    expect(courseEl(root, COURSE).querySelector('[data-testid="elearning-exam-form"]')).not.toBeNull()
    expect(courseEl(root, COURSE_DONE).querySelector('[data-testid="elearning-exam-form"]')).toBeNull()
    expect((root.querySelector('input[value="a"]') as HTMLInputElement).checked).toBe(true)
    expect((root.querySelector('input[value="a"]') as HTMLInputElement).disabled).toBe(false)
    courseQuery<HTMLButtonElement>(root, COURSE_DONE, 'elearning-start-exam').click()
    await flushUi()
    expect(h.startExam).toHaveBeenCalledTimes(1)
    expect(root.querySelector('[data-testid="elearning-learner-status"]')?.textContent).toBe('失败：unavailable（503）')
    expect((root.querySelector('input[value="a"]') as HTMLInputElement).checked).toBe(true)
  })

  it('renews the playback ticket before expiry and does not tight-loop on a stale expiresAt', async () => {
    h.ticket
      .mockResolvedValueOnce(playbackTicket({ token: 'play.token', ttlSeconds: 60 }))
      .mockResolvedValueOnce(playbackTicket({ token: 'play.token.renewed', ttlSeconds: 60 }))
      .mockResolvedValueOnce(playbackTicket({
        token: 'play.token.expired',
        ttlSeconds: 1,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }))
      .mockResolvedValue(playbackTicket({
        token: 'play.token.min-delay',
        ttlSeconds: 1,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }))
    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-start-watch"]') as HTMLButtonElement).click()
    await flushUi()
    const video = root.querySelector('[data-testid="elearning-learner-video"]') as HTMLVideoElement
    expect(videoSrc(video)).toContain(elearningPlaybackSourceUrl('play.token'))
    expect(h.ticket).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(TICKET_RENEWAL_LEAD_MS - 1000)
    await flushUi()
    expect(h.ticket).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2000)
    await flushUntil(() => videoSrc(video).includes(elearningPlaybackSourceUrl('play.token.renewed')))
    expect(h.ticket).toHaveBeenCalledTimes(2)
    expect(h.ticket.mock.calls[1]?.[0]).toBe(VIDEO)

    vi.advanceTimersByTime(TICKET_RENEWAL_LEAD_MS)
    await flushUntil(() => h.ticket.mock.calls.length === 3)
    expect(h.ticket).toHaveBeenCalledTimes(3)

    vi.advanceTimersByTime(TICKET_RENEWAL_MIN_DELAY_MS - 1000)
    await flushUi()
    expect(h.ticket).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(2000)
    await flushUntil(() => h.ticket.mock.calls.length === 4)
    expect(h.ticket).toHaveBeenCalledTimes(4)
  })

  it('preserves playing position across ticket renewal without synthetic heartbeat credit', async () => {
    h.ticket
      .mockResolvedValueOnce(playbackTicket({ token: 'play.token', ttlSeconds: 60 }))
      .mockResolvedValueOnce(playbackTicket({ token: 'play.token.renewed', ttlSeconds: 60 }))
    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-start-watch"]') as HTMLButtonElement).click()
    await flushUi()
    const video = prepareVideo(
      root.querySelector('[data-testid="elearning-learner-video"]') as HTMLVideoElement,
      5,
      0,
    )
    Object.defineProperty(video, 'paused', { configurable: true, writable: true, value: false })
    Object.defineProperty(video, 'ended', { configurable: true, writable: true, value: false })
    vi.spyOn(video, 'play').mockResolvedValue(undefined as void)
    video.dispatchEvent(new Event('play'))
    await flushUi()
    expect(heartbeatBodies()).toEqual([{ sequence: 2, positionMs: 0, playing: true }])

    video.currentTime = 2
    vi.advanceTimersByTime(TICKET_RENEWAL_LEAD_MS)
    await flushUntil(() => videoSrc(video).includes(elearningPlaybackSourceUrl('play.token.renewed')))
    expect(h.ticket).toHaveBeenCalledTimes(2)
    await drainHeartbeats()
    await flushUi(20)

    h.heartbeat.mockClear()
    simulateTicketSrcReload(video)
    await flushUi(20)
    expect(h.heartbeat).not.toHaveBeenCalled()
    expect(video.currentTime).toBe(2)

    vi.advanceTimersByTime(ELEARNING_WATCH_HEARTBEAT_INTERVAL_MS)
    await flushUi()
    expect(heartbeatBodies()).toEqual([expect.objectContaining({ positionMs: 2000, playing: true })])
  })

  it('preserves paused intent across ticket renewal without a pause beat', async () => {
    h.ticket
      .mockResolvedValueOnce(playbackTicket({ token: 'play.token', ttlSeconds: 60 }))
      .mockResolvedValueOnce(playbackTicket({ token: 'play.token.renewed', ttlSeconds: 60 }))
    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-start-watch"]') as HTMLButtonElement).click()
    await flushUi()
    const video = prepareVideo(
      root.querySelector('[data-testid="elearning-learner-video"]') as HTMLVideoElement,
      5,
      0,
    )
    Object.defineProperty(video, 'paused', { configurable: true, writable: true, value: false })
    Object.defineProperty(video, 'ended', { configurable: true, writable: true, value: false })
    video.dispatchEvent(new Event('play'))
    await flushUi()
    video.currentTime = 2
    Object.defineProperty(video, 'paused', { configurable: true, writable: true, value: true })
    video.dispatchEvent(new Event('pause'))
    await flushUi()
    expect(heartbeatBodies().at(-1)).toEqual({ sequence: 3, positionMs: 2000, playing: false })

    vi.advanceTimersByTime(TICKET_RENEWAL_LEAD_MS)
    await flushUntil(() => videoSrc(video).includes(elearningPlaybackSourceUrl('play.token.renewed')))
    h.heartbeat.mockClear()
    simulateTicketSrcReload(video)
    await flushUi()
    expect(h.heartbeat).not.toHaveBeenCalled()
    expect(video.currentTime).toBe(2)

    vi.advanceTimersByTime(ELEARNING_WATCH_HEARTBEAT_INTERVAL_MS * 3)
    await flushUi()
    expect(h.heartbeat).not.toHaveBeenCalled()
  })

  it('discards a stale in-flight renewal after switching courses and clears the prior timer', async () => {
    let releaseRenewal!: () => void
    const renewalGate = new Promise<void>((resolve) => {
      releaseRenewal = resolve
    })
    h.list.mockResolvedValue({
      courses: [
        course(),
        course({ courseId: COURSE_PROGRESS, video: vid({ itemId: VIDEO_B }) }),
      ],
    })
    h.startWatch.mockImplementation(async (itemId: string) => {
      if (itemId === VIDEO_B) return watchState({ sessionId: SESSION_B, lastSequence: 7 })
      return watchState()
    })
    h.ticket.mockImplementation(async (itemId: string) => {
      if (itemId === VIDEO_B) return playbackTicket({ token: 'play.token.b', itemId: VIDEO_B, ttlSeconds: 60 })
      if (h.ticket.mock.calls.filter((call) => call[0] === VIDEO).length === 1) {
        return playbackTicket({ token: 'play.token.a', ttlSeconds: 60 })
      }
      await renewalGate
      return playbackTicket({ token: 'play.token.a-stale', ttlSeconds: 60 })
    })

    const root = mountView()
    await flushUi()
    courseQuery<HTMLButtonElement>(root, COURSE, 'elearning-start-watch').click()
    await flushUi()
    const firstVideo = courseQuery<HTMLVideoElement>(root, COURSE, 'elearning-learner-video')
    expect(videoSrc(firstVideo)).toContain(elearningPlaybackSourceUrl('play.token.a'))

    vi.advanceTimersByTime(TICKET_RENEWAL_LEAD_MS)
    await flushUntil(() => h.ticket.mock.calls.length === 2)

    courseQuery<HTMLButtonElement>(root, COURSE_PROGRESS, 'elearning-start-watch').click()
    await flushUi()
    const secondVideo = courseQuery<HTMLVideoElement>(root, COURSE_PROGRESS, 'elearning-learner-video')
    expect(videoSrc(secondVideo)).toContain(elearningPlaybackSourceUrl('play.token.b'))
    expect(courseEl(root, COURSE).querySelector('[data-testid="elearning-learner-video"]')).toBeNull()

    releaseRenewal()
    await flushUi(20)
    expect(videoSrc(secondVideo)).toContain(elearningPlaybackSourceUrl('play.token.b'))
    expect(videoSrc(secondVideo)).not.toContain('play.token.a-stale')
    expect(h.ticket.mock.calls.map((call) => call[0])).toEqual([VIDEO, VIDEO, VIDEO_B])

    vi.advanceTimersByTime(TICKET_RENEWAL_LEAD_MS)
    await flushUntil(() => h.ticket.mock.calls.length === 4)
    expect(h.ticket.mock.calls[3]?.[0]).toBe(VIDEO_B)
    expect(videoSrc(secondVideo)).toContain(elearningPlaybackSourceUrl('play.token.b'))
  })

  it('invalidates in-flight ticket renewal and clears timers on unmount', async () => {
    let releaseRenewal!: () => void
    const renewalGate = new Promise<void>((resolve) => {
      releaseRenewal = resolve
    })
    h.ticket.mockImplementation(async () => {
      if (h.ticket.mock.calls.length === 1) return playbackTicket({ token: 'play.token', ttlSeconds: 60 })
      await renewalGate
      return playbackTicket({ token: 'play.token.unmounted', ttlSeconds: 60 })
    })
    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-start-watch"]') as HTMLButtonElement).click()
    await flushUi()
    const video = root.querySelector('[data-testid="elearning-learner-video"]') as HTMLVideoElement
    video.dispatchEvent(new Event('play'))
    await flushUi()

    vi.advanceTimersByTime(TICKET_RENEWAL_LEAD_MS)
    await flushUntil(() => h.ticket.mock.calls.length === 2)
    h.heartbeat.mockClear()
    app?.unmount()
    app = null
    releaseRenewal()
    await flushUi(20)
    vi.advanceTimersByTime(TICKET_RENEWAL_LEAD_MS * 2)
    await flushUi()
    expect(h.ticket).toHaveBeenCalledTimes(2)
    expect(h.heartbeat).not.toHaveBeenCalled()
  })

  it('stops renewal and background heartbeats after a values-free ticket failure', async () => {
    h.ticket
      .mockResolvedValueOnce(playbackTicket({ token: 'play.token', ttlSeconds: 60 }))
      .mockRejectedValueOnce(new ElearningApiError('unavailable', 503))
    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-start-watch"]') as HTMLButtonElement).click()
    await flushUi()
    const video = prepareVideo(
      root.querySelector('[data-testid="elearning-learner-video"]') as HTMLVideoElement,
      5,
      0,
    )
    Object.defineProperty(video, 'paused', { configurable: true, writable: true, value: false })
    video.dispatchEvent(new Event('play'))
    await flushUi()

    vi.advanceTimersByTime(TICKET_RENEWAL_LEAD_MS)
    await flushUntil(() => (root.querySelector('[data-testid="elearning-learner-status"]')?.textContent ?? '').includes('unavailable'))
    expect(root.querySelector('[data-testid="elearning-learner-status"]')?.textContent).toBe('失败：unavailable（503）')
    expect(root.querySelector('[data-testid="elearning-learner-status"]')?.textContent).not.toMatch(/\d{1,3}(?:\.\d{1,3}){3}/)

    h.heartbeat.mockClear()
    vi.advanceTimersByTime(TICKET_RENEWAL_LEAD_MS + ELEARNING_WATCH_HEARTBEAT_INTERVAL_MS * 3)
    await flushUi()
    expect(h.ticket).toHaveBeenCalledTimes(2)
    expect(h.heartbeat).not.toHaveBeenCalled()
  })

  it('fails closed when a current-context renewal returns a mismatched itemId and stops heartbeats', async () => {
    h.ticket
      .mockResolvedValueOnce(playbackTicket({ token: 'play.token', ttlSeconds: 60 }))
      .mockResolvedValueOnce(playbackTicket({
        token: 'play.token.mismatch',
        ttlSeconds: 60,
        itemId: VIDEO_B,
      }))
    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-start-watch"]') as HTMLButtonElement).click()
    await flushUi()
    const video = prepareVideo(
      root.querySelector('[data-testid="elearning-learner-video"]') as HTMLVideoElement,
      5,
      0,
    )
    Object.defineProperty(video, 'paused', { configurable: true, writable: true, value: false })
    video.dispatchEvent(new Event('play'))
    await flushUi()

    vi.advanceTimersByTime(TICKET_RENEWAL_LEAD_MS)
    await flushUntil(() => (root.querySelector('[data-testid="elearning-learner-status"]')?.textContent ?? '').includes('request_failed'))
    const statusText = root.querySelector('[data-testid="elearning-learner-status"]')?.textContent ?? ''
    expect(statusText).toBe('失败：request_failed（0）')
    expect(statusText).not.toContain(VIDEO)
    expect(statusText).not.toContain(VIDEO_B)
    expect(videoSrc(video)).toContain(elearningPlaybackSourceUrl('play.token'))
    expect(videoSrc(video)).not.toContain('play.token.mismatch')

    h.heartbeat.mockClear()
    vi.advanceTimersByTime(TICKET_RENEWAL_LEAD_MS + ELEARNING_WATCH_HEARTBEAT_INTERVAL_MS * 3)
    await flushUi()
    expect(h.ticket).toHaveBeenCalledTimes(2)
    expect(h.heartbeat).not.toHaveBeenCalled()
  })
})
