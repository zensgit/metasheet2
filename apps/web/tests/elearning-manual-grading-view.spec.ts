import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { useLocale } from '../src/composables/useLocale'

const h = vi.hoisted(() => ({
  listQueue: vi.fn(),
  getDetail: vi.fn(),
  submitGrade: vi.fn(),
}))

vi.mock('../src/services/elearningManualGrading', async () => {
  const actual = await vi.importActual<typeof import('../src/services/elearningManualGrading')>(
    '../src/services/elearningManualGrading',
  )
  return {
    ...actual,
    listElearningManualGradingQueue: h.listQueue,
    getElearningManualGradingDetail: h.getDetail,
    submitElearningManualGrade: h.submitGrade,
  }
})

import { ElearningApiError } from '../src/services/elearning'
import ElearningManualGradingView from '../src/views/ElearningManualGradingView.vue'

const ATTEMPT = '88888888-8888-4888-8888-888888888888'
const ATTEMPT_2 = '99999999-9999-4999-9999-999999999999'
const EXAM = '55555555-5555-4555-8555-555555555555'
const COURSE = '11111111-1111-4111-8111-111111111111'
const Q1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const Q2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const REQUEST_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const REQUEST_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const REQUEST_C = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const SUBMITTED_AT = '2026-08-26T00:00:00.000Z'

async function flushUi(cycles = 8): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function fillInput(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function queueItem(over: Record<string, unknown> = {}) {
  return {
    attemptId: ATTEMPT,
    userId: 'user-1',
    examId: EXAM,
    examTitle: 'Safety exam',
    courseId: COURSE,
    courseTitle: 'Safety course',
    attemptNo: 1,
    submittedAt: SUBMITTED_AT,
    autoScore: 6,
    manualScore: 0,
    paperMaxScore: 20,
    gradedQuestions: 0,
    manualQuestions: 2,
    ...over,
  }
}

function questionDetail(over: Record<string, unknown> = {}) {
  return {
    questionRevisionId: Q1,
    position: 1,
    prompt: 'Explain briefly',
    points: 10,
    learnerAnswer: 'my answer',
    grade: null,
    ...over,
  }
}

function detail(over: Record<string, unknown> = {}) {
  return {
    attemptId: ATTEMPT,
    userId: 'user-1',
    examId: EXAM,
    examTitle: 'Safety exam',
    courseId: COURSE,
    courseTitle: 'Safety course',
    attemptNo: 1,
    status: 'awaiting_manual' as const,
    submittedAt: SUBMITTED_AT,
    autoScore: 6,
    manualScore: 0,
    paperMaxScore: 20,
    passScore: 12,
    gradedQuestions: 0,
    manualQuestions: 2,
    questions: [
      questionDetail(),
      questionDetail({ questionRevisionId: Q2, position: 2, learnerAnswer: 'second answer' }),
    ],
    ...over,
  }
}

function submitResult(over: Record<string, unknown> = {}) {
  return {
    attemptId: ATTEMPT,
    questionRevisionId: Q1,
    score: 8,
    maxScore: 10,
    status: 'awaiting_manual' as const,
    gradedQuestions: 1,
    manualQuestions: 2,
    autoScore: 6,
    manualScore: 8,
    totalScore: 20,
    passed: null,
    duplicate: false,
    ...over,
  }
}

describe('ElearningManualGradingView + ElearningManualGradingAttempt', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let uuidSpy: ReturnType<typeof vi.spyOn> | null = null

  function mountView() {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(ElearningManualGradingView)
    app.mount(container)
    return container
  }

  function q(testid: string, root: HTMLElement = container as HTMLElement) {
    return root.querySelector(`[data-testid="${testid}"]`)
  }

  beforeEach(() => {
    useLocale().setLocale('en')
    h.listQueue.mockReset()
    h.getDetail.mockReset()
    h.submitGrade.mockReset()
    let n = 0
    const ids = [REQUEST_A, REQUEST_B, REQUEST_C]
    uuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => (ids[n++] ?? REQUEST_C) as `${string}-${string}-${string}-${string}-${string}`)
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
    uuidSpy?.mockRestore()
    vi.clearAllMocks()
  })

  it('renders the queue, paginates, and opens an attempt', async () => {
    h.listQueue.mockResolvedValueOnce({ items: [queueItem()], page: 1, pageSize: 20, hasMore: true })
    const root = mountView()
    await flushUi()

    expect(q('elearning-grading-loading')).toBeFalsy()
    expect(q('elearning-grading-empty')).toBeFalsy()
    expect(q(`elearning-grading-row-${ATTEMPT}`)).toBeTruthy()
    expect((q('elearning-grading-previous') as HTMLButtonElement).disabled).toBe(true)
    expect((q('elearning-grading-next') as HTMLButtonElement).disabled).toBe(false)

    h.listQueue.mockResolvedValueOnce({ items: [queueItem({ attemptId: ATTEMPT_2 })], page: 2, pageSize: 20, hasMore: false })
    ;(q('elearning-grading-next') as HTMLButtonElement).click()
    await flushUi()
    expect(h.listQueue.mock.calls.at(-1)?.[0]).toBe(2)
    expect((q('elearning-grading-next') as HTMLButtonElement).disabled).toBe(true)
    expect((q('elearning-grading-previous') as HTMLButtonElement).disabled).toBe(false)

    h.getDetail.mockResolvedValueOnce(detail({ attemptId: ATTEMPT_2 }))
    ;(q(`elearning-grading-open-${ATTEMPT_2}`) as HTMLButtonElement).click()
    await flushUi()
    expect(h.getDetail).toHaveBeenCalledWith(ATTEMPT_2)
    expect(q('elearning-grading-attempt-learner')).toBeTruthy()
    void root
  })

  it('renders an empty queue distinctly from a closed (404) or error (403/503) queue', async () => {
    h.listQueue.mockResolvedValueOnce({ items: [], page: 1, pageSize: 20, hasMore: false })
    mountView()
    await flushUi()
    expect(q('elearning-grading-empty')).toBeTruthy()
    expect(q('elearning-grading-closed')).toBeFalsy()
    expect(q('elearning-grading-error')).toBeFalsy()

    h.listQueue.mockRejectedValueOnce(new ElearningApiError('not_found', 404))
    ;(q('elearning-grading-refresh') as HTMLButtonElement).click()
    await flushUi()
    expect(q('elearning-grading-closed')).toBeTruthy()
    expect(q('elearning-grading-empty')).toBeFalsy()
    expect(q('elearning-grading-error')).toBeFalsy()

    h.listQueue.mockRejectedValueOnce(new ElearningApiError('scope_required', 403))
    ;(q('elearning-grading-refresh') as HTMLButtonElement).click()
    await flushUi()
    expect(q('elearning-grading-error')).toBeTruthy()
    expect(q('elearning-grading-error')?.textContent).toMatch(/do not have access/)
    expect(q('elearning-grading-closed')).toBeFalsy()
    expect(q('elearning-grading-empty')).toBeFalsy()

    h.listQueue.mockRejectedValueOnce(new ElearningApiError('unavailable', 503))
    ;(q('elearning-grading-refresh') as HTMLButtonElement).click()
    await flushUi()
    expect(q('elearning-grading-error')?.textContent).toMatch(/temporarily unavailable/)
  })

  it('steps back a page when a post-grade refresh finds the current page emptied', async () => {
    h.listQueue.mockResolvedValueOnce({ items: [queueItem()], page: 2, pageSize: 20, hasMore: false })
    mountView()
    await flushUi()

    h.getDetail.mockResolvedValueOnce(detail({ manualQuestions: 1, gradedQuestions: 0, questions: [questionDetail()] }))
    ;(q(`elearning-grading-open-${ATTEMPT}`) as HTMLButtonElement).click()
    await flushUi()

    h.submitGrade.mockResolvedValueOnce(submitResult({ status: 'graded', gradedQuestions: 1, manualQuestions: 1, passed: true }))
    fillInput(q(`elearning-grading-score-${Q1}`) as HTMLInputElement, '8')
    ;(q(`elearning-grading-submit-${Q1}`) as HTMLButtonElement).click()
    await flushUi()
    expect(q('elearning-grading-complete')).toBeTruthy()

    // Page 2 is now empty (its only attempt just finalized) — the queue refresh
    // triggered by "done" must step back to page 1 rather than showing empty.
    h.listQueue.mockResolvedValueOnce({ items: [], page: 2, pageSize: 20, hasMore: false })
    h.listQueue.mockResolvedValueOnce({ items: [queueItem({ attemptId: ATTEMPT_2 })], page: 1, pageSize: 20, hasMore: false })
    ;(q('elearning-grading-done') as HTMLButtonElement).click()
    await flushUi()
    expect(h.listQueue.mock.calls.map((call) => call[0])).toContain(1)
    expect(q('elearning-grading-empty')).toBeFalsy()
    expect(q(`elearning-grading-row-${ATTEMPT_2}`)).toBeTruthy()
  })

  describe('attempt detail: grading form', () => {
    async function openAttempt(detailOverrides: Record<string, unknown> = {}) {
      h.listQueue.mockResolvedValueOnce({ items: [queueItem()], page: 1, pageSize: 20, hasMore: false })
      mountView()
      await flushUi()
      h.getDetail.mockResolvedValueOnce(detail(detailOverrides))
      ;(q(`elearning-grading-open-${ATTEMPT}`) as HTMLButtonElement).click()
      await flushUi()
    }

    it('shows a read-only graded question and a form for an ungraded one', async () => {
      await openAttempt({
        gradedQuestions: 1,
        questions: [
          questionDetail({ grade: { score: 7, maxScore: 10, comment: 'ok', graderId: 'g1', gradedAt: SUBMITTED_AT } }),
          questionDetail({ questionRevisionId: Q2, position: 2 }),
        ],
      })
      expect(q(`elearning-grading-graded-${Q1}`)?.textContent).toMatch(/7 \/ 10/)
      expect(q(`elearning-grading-score-${Q1}`)).toBeFalsy()
      expect(q(`elearning-grading-score-${Q2}`)).toBeTruthy()
    })

    it('rejects out-of-bounds and non-integer scores without calling the submit client, accepts boundary values', async () => {
      await openAttempt({ manualQuestions: 1, gradedQuestions: 0, questions: [questionDetail()] })

      for (const bad of ['-1', '11', '1.5']) {
        fillInput(q(`elearning-grading-score-${Q1}`) as HTMLInputElement, bad)
        ;(q(`elearning-grading-submit-${Q1}`) as HTMLButtonElement).click()
        await flushUi()
        expect(h.submitGrade).not.toHaveBeenCalled()
        expect(q(`elearning-grading-question-error-${Q1}`)).toBeTruthy()
      }

      h.submitGrade.mockResolvedValueOnce(submitResult({ score: 0, maxScore: 10, gradedQuestions: 1, manualQuestions: 1, status: 'graded', passed: true }))
      fillInput(q(`elearning-grading-score-${Q1}`) as HTMLInputElement, '0')
      ;(q(`elearning-grading-submit-${Q1}`) as HTMLButtonElement).click()
      await flushUi()
      expect(h.submitGrade).toHaveBeenCalledTimes(1)
      expect(h.submitGrade.mock.calls[0]?.[1]).toMatchObject({ score: 0 })
    })

    it('accepts the max-points boundary value', async () => {
      await openAttempt({ manualQuestions: 1, gradedQuestions: 0, questions: [questionDetail({ points: 10 })] })
      h.submitGrade.mockResolvedValueOnce(submitResult({ score: 10, maxScore: 10, gradedQuestions: 1, manualQuestions: 1, status: 'graded', passed: true }))
      fillInput(q(`elearning-grading-score-${Q1}`) as HTMLInputElement, '10')
      ;(q(`elearning-grading-submit-${Q1}`) as HTMLButtonElement).click()
      await flushUi()
      expect(h.submitGrade).toHaveBeenCalledTimes(1)
      expect(h.submitGrade.mock.calls[0]?.[1]).toMatchObject({ score: 10 })
    })

    it('disables submit while a request is in flight and ignores a second click', async () => {
      await openAttempt({ manualQuestions: 1, gradedQuestions: 0, questions: [questionDetail()] })
      const pending = deferred<ReturnType<typeof submitResult>>()
      h.submitGrade.mockReturnValueOnce(pending.promise)

      fillInput(q(`elearning-grading-score-${Q1}`) as HTMLInputElement, '5')
      const button = q(`elearning-grading-submit-${Q1}`) as HTMLButtonElement
      button.click()
      await flushUi()
      expect(button.disabled).toBe(true)
      expect(button.textContent).toMatch(/Submitting/)

      // A second click while the promise is still pending must not fire a
      // second network call — both the :disabled attribute and the
      // handler-level guard must hold.
      button.click()
      await flushUi()
      expect(h.submitGrade).toHaveBeenCalledTimes(1)

      pending.resolve(submitResult({ status: 'graded', gradedQuestions: 1, manualQuestions: 1, passed: true }))
      await flushUi()
      expect(h.submitGrade).toHaveBeenCalledTimes(1)
      expect(q('elearning-grading-complete')).toBeTruthy()
    })

    it('mints a fresh requestId per submission (two different questions)', async () => {
      await openAttempt()
      // Queued BEFORE the click: a non-final submit refetches detail internally
      // (see the "finalizes on status=graded" test below) — the mock must be in
      // place before that refetch fires, or it falls through to the default
      // `vi.fn()` undefined return and the component lands in its error state.
      h.getDetail.mockResolvedValueOnce(detail({
        gradedQuestions: 1,
        questions: [
          questionDetail({ grade: { score: 5, maxScore: 10, comment: null, graderId: 'g1', gradedAt: SUBMITTED_AT } }),
          questionDetail({ questionRevisionId: Q2, position: 2 }),
        ],
      }))
      h.submitGrade.mockResolvedValueOnce(submitResult({ questionRevisionId: Q1, gradedQuestions: 1 }))
      fillInput(q(`elearning-grading-score-${Q1}`) as HTMLInputElement, '5')
      ;(q(`elearning-grading-submit-${Q1}`) as HTMLButtonElement).click()
      await flushUi()
      expect(q(`elearning-grading-score-${Q2}`)).toBeTruthy()

      h.submitGrade.mockResolvedValueOnce(submitResult({ questionRevisionId: Q2, gradedQuestions: 2, manualQuestions: 2, status: 'graded', passed: true }))
      fillInput(q(`elearning-grading-score-${Q2}`) as HTMLInputElement, '9')
      ;(q(`elearning-grading-submit-${Q2}`) as HTMLButtonElement).click()
      await flushUi()

      expect(h.submitGrade).toHaveBeenCalledTimes(2)
      const firstRequestId = h.submitGrade.mock.calls[0]?.[1]?.requestId
      const secondRequestId = h.submitGrade.mock.calls[1]?.[1]?.requestId
      expect(firstRequestId).toBe(REQUEST_A)
      expect(secondRequestId).toBe(REQUEST_B)
      expect(firstRequestId).not.toBe(secondRequestId)
    })

    it('reuses requestId for an unchanged failed payload and rotates it after score or comment edits', async () => {
      await openAttempt({ manualQuestions: 1, gradedQuestions: 0, questions: [questionDetail()] })
      h.submitGrade
        .mockRejectedValueOnce(new ElearningApiError('network_error', 0))
        .mockRejectedValueOnce(new ElearningApiError('unavailable', 503))
        .mockRejectedValueOnce(new ElearningApiError('network_error', 0))
        .mockResolvedValueOnce(submitResult({
          score: 6,
          status: 'graded',
          gradedQuestions: 1,
          manualQuestions: 1,
          passed: true,
        }))

      const score = q(`elearning-grading-score-${Q1}`) as HTMLInputElement
      const comment = q(`elearning-grading-comment-${Q1}`) as HTMLTextAreaElement
      const submit = q(`elearning-grading-submit-${Q1}`) as HTMLButtonElement

      fillInput(score, '5')
      submit.click()
      await flushUi()
      submit.click()
      await flushUi()

      fillInput(score, '6')
      submit.click()
      await flushUi()

      fillInput(comment, 'updated comment')
      submit.click()
      await flushUi()

      expect(h.submitGrade).toHaveBeenCalledTimes(4)
      expect(h.submitGrade.mock.calls.map((call) => call[1]?.requestId)).toEqual([
        REQUEST_A,
        REQUEST_A,
        REQUEST_B,
        REQUEST_C,
      ])
      expect(h.submitGrade.mock.calls[3]?.[1]).toMatchObject({
        score: 6,
        comment: 'updated comment',
      })
      expect(q('elearning-grading-complete')).toBeTruthy()
    })

    it('blocks submit without a network call when crypto.randomUUID is unavailable, instead of minting a fallback id', async () => {
      await openAttempt({ manualQuestions: 1, gradedQuestions: 0, questions: [questionDetail()] })
      uuidSpy?.mockRestore()
      uuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
        throw new Error('unsupported')
      })
      fillInput(q(`elearning-grading-score-${Q1}`) as HTMLInputElement, '5')
      ;(q(`elearning-grading-submit-${Q1}`) as HTMLButtonElement).click()
      await flushUi()
      expect(h.submitGrade).not.toHaveBeenCalled()
      expect(q(`elearning-grading-question-error-${Q1}`)?.textContent).toMatch(/secure identifier/)
    })

    it('treats a duplicate=true submit response as success, not an error', async () => {
      await openAttempt({ manualQuestions: 1, gradedQuestions: 0, questions: [questionDetail()] })
      h.submitGrade.mockResolvedValueOnce(submitResult({
        status: 'graded',
        gradedQuestions: 1,
        manualQuestions: 1,
        passed: true,
        duplicate: true,
      }))
      fillInput(q(`elearning-grading-score-${Q1}`) as HTMLInputElement, '5')
      ;(q(`elearning-grading-submit-${Q1}`) as HTMLButtonElement).click()
      await flushUi()
      expect(q(`elearning-grading-question-error-${Q1}`)).toBeFalsy()
      expect(q(`elearning-grading-duplicate-${Q1}`)).toBeTruthy()
      expect(q('elearning-grading-complete')).toBeTruthy()
    })

    it('finalizes on status=graded without refetching detail (which would 404), and refetches when still awaiting_manual', async () => {
      await openAttempt()
      // Queued BEFORE the click so the internal post-submit refetch (triggered
      // because this first submit reports status: 'awaiting_manual') resolves
      // to real data instead of the default vi.fn() undefined.
      h.getDetail.mockResolvedValueOnce(detail({
        gradedQuestions: 1,
        questions: [
          questionDetail({ grade: { score: 5, maxScore: 10, comment: null, graderId: 'g1', gradedAt: SUBMITTED_AT } }),
          questionDetail({ questionRevisionId: Q2, position: 2 }),
        ],
      }))
      h.submitGrade.mockResolvedValueOnce(submitResult({ questionRevisionId: Q1, status: 'awaiting_manual', gradedQuestions: 1 }))
      fillInput(q(`elearning-grading-score-${Q1}`) as HTMLInputElement, '5')
      ;(q(`elearning-grading-submit-${Q1}`) as HTMLButtonElement).click()
      await flushUi()
      // getDetail: 1 call on mount + 1 refetch from the non-final submit above.
      expect(h.getDetail).toHaveBeenCalledTimes(2)
      expect(q('elearning-grading-complete')).toBeFalsy()

      h.submitGrade.mockResolvedValueOnce(submitResult({
        questionRevisionId: Q2,
        status: 'graded',
        gradedQuestions: 2,
        manualQuestions: 2,
        passed: true,
      }))
      fillInput(q(`elearning-grading-score-${Q2}`) as HTMLInputElement, '9')
      ;(q(`elearning-grading-submit-${Q2}`) as HTMLButtonElement).click()
      await flushUi()
      // The finalizing submit must NOT trigger a third getDetail call — DETAIL_SQL
      // only returns awaiting_manual rows, so refetching the now-graded attempt
      // would 404.
      expect(h.getDetail).toHaveBeenCalledTimes(2)
      expect(q('elearning-grading-complete')).toBeTruthy()
    })

    it('surfaces attempt-level 403/404/503 distinctly', async () => {
      h.listQueue.mockResolvedValueOnce({ items: [queueItem()], page: 1, pageSize: 20, hasMore: false })
      mountView()
      await flushUi()

      h.getDetail.mockRejectedValueOnce(new ElearningApiError('not_found', 404))
      ;(q(`elearning-grading-open-${ATTEMPT}`) as HTMLButtonElement).click()
      await flushUi()
      expect(q('elearning-grading-attempt-closed')).toBeTruthy()
      expect(q('elearning-grading-attempt-error')).toBeFalsy()

      h.getDetail.mockRejectedValueOnce(new ElearningApiError('scope_required', 403))
      ;(q('elearning-grading-back') as HTMLButtonElement).click()
      await flushUi()
      ;(q(`elearning-grading-open-${ATTEMPT}`) as HTMLButtonElement).click()
      await flushUi()
      expect(q('elearning-grading-attempt-error')?.textContent).toMatch(/do not have access/)

      h.getDetail.mockRejectedValueOnce(new ElearningApiError('unavailable', 503))
      ;(q('elearning-grading-back') as HTMLButtonElement).click()
      await flushUi()
      ;(q(`elearning-grading-open-${ATTEMPT}`) as HTMLButtonElement).click()
      await flushUi()
      expect(q('elearning-grading-attempt-error')?.textContent).toMatch(/temporarily unavailable/)
    })

    it('reconciles a 409 by reading detail first, then refreshing page 1 of the queue', async () => {
      h.listQueue
        .mockResolvedValueOnce({ items: [queueItem({ attemptId: ATTEMPT_2 })], page: 1, pageSize: 20, hasMore: true })
        .mockResolvedValueOnce({ items: [queueItem()], page: 2, pageSize: 20, hasMore: false })
      mountView()
      await flushUi()
      ;(q('elearning-grading-next') as HTMLButtonElement).click()
      await flushUi()

      h.getDetail.mockResolvedValueOnce(detail({ manualQuestions: 1, gradedQuestions: 0, questions: [questionDetail()] }))
      ;(q(`elearning-grading-open-${ATTEMPT}`) as HTMLButtonElement).click()
      await flushUi()

      h.submitGrade.mockRejectedValueOnce(new ElearningApiError('conflict', 409))
      h.getDetail.mockResolvedValueOnce(detail({
        gradedQuestions: 1,
        manualQuestions: 1,
        questions: [questionDetail({
          grade: { score: 5, maxScore: 10, comment: null, graderId: 'other-grader', gradedAt: SUBMITTED_AT },
        })],
      }))
      h.listQueue.mockResolvedValueOnce({
        items: [queueItem({ attemptId: ATTEMPT_2 })],
        page: 1,
        pageSize: 20,
        hasMore: false,
      })

      fillInput(q(`elearning-grading-score-${Q1}`) as HTMLInputElement, '5')
      ;(q(`elearning-grading-submit-${Q1}`) as HTMLButtonElement).click()
      await flushUi()

      expect(h.getDetail).toHaveBeenCalledTimes(2)
      expect(h.listQueue.mock.calls.map((call) => call[0])).toEqual([1, 2, 1])
      expect(h.getDetail.mock.invocationCallOrder[1]).toBeLessThan(h.listQueue.mock.invocationCallOrder[2] as number)
      expect(q('elearning-grading-page')?.textContent).toMatch(/Page 1/)
      expect(q(`elearning-grading-row-${ATTEMPT_2}`)).toBeTruthy()
      expect(q('elearning-grading-reconciled')).toBeTruthy()
    })

    it('keeps an explicit error when authoritative 409 reconciliation cannot refresh', async () => {
      await openAttempt({ manualQuestions: 1, gradedQuestions: 0, questions: [questionDetail()] })
      h.submitGrade.mockRejectedValueOnce(new ElearningApiError('conflict', 409))
      h.getDetail.mockRejectedValueOnce(new ElearningApiError('unavailable', 503))
      h.listQueue.mockRejectedValueOnce(new ElearningApiError('unavailable', 503))

      fillInput(q(`elearning-grading-score-${Q1}`) as HTMLInputElement, '5')
      ;(q(`elearning-grading-submit-${Q1}`) as HTMLButtonElement).click()
      await flushUi()

      expect(h.getDetail).toHaveBeenCalledTimes(2)
      expect(h.listQueue).toHaveBeenCalledTimes(2)
      expect(q('elearning-grading-reconciled')).toBeFalsy()
      expect(q('elearning-grading-error')?.textContent).toMatch(/temporarily unavailable/)
      expect(q('elearning-grading-complete')).toBeFalsy()
    })
  })
})
