import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { useLocale } from '../src/composables/useLocale'

const h = vi.hoisted(() => ({
  list: vi.fn(),
  start: vi.fn(),
  answer: vi.fn(),
  wrong: vi.fn(),
}))

vi.mock('../src/services/elearningPractice', async () => {
  const actual = await vi.importActual<typeof import('../src/services/elearningPractice')>(
    '../src/services/elearningPractice',
  )
  return {
    ...actual,
    listElearningPracticeSets: h.list,
    startElearningPracticeSession: h.start,
    submitElearningPracticeAnswer: h.answer,
    listElearningWrongQuestions: h.wrong,
  }
})

import { ElearningApiError } from '../src/services/elearning'
import ElearningPracticeLearnerSection from '../src/views/ElearningPracticeLearnerSection.vue'

const SET = '11111111-1111-4111-8111-111111111111'
const PAPER = '22222222-2222-4222-8222-222222222222'
const SESSION = '33333333-3333-4333-8333-333333333333'
const QUESTION = '44444444-4444-4444-8444-444444444444'
const REVISION = '55555555-5555-4555-8555-555555555555'
const ANSWER = '66666666-6666-4666-8666-666666666666'
const REQUEST_A = '77777777-7777-4777-8777-777777777777'
const REQUEST_B = '88888888-8888-4888-8888-888888888888'
const CREATED = '2026-08-30T01:02:03.456Z'

function question() {
  return {
    questionId: QUESTION,
    questionRevisionId: REVISION,
    questionType: 'single_choice' as const,
    prompt: 'Choose one',
    options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }],
    points: 1,
    position: 1,
  }
}

async function flush(cycles = 10): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function select(root: HTMLElement, testId: string, value: string): void {
  const node = root.querySelector(`[data-testid="${testId}"]`) as HTMLSelectElement
  node.value = value
  node.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('ElearningPracticeLearnerSection', () => {
  let app: App<Element> | null = null
  let root: HTMLDivElement | null = null
  let uuid: ReturnType<typeof vi.spyOn> | null = null

  beforeEach(() => {
    useLocale().setLocale('en')
    for (const mock of Object.values(h)) mock.mockReset()
    h.list.mockResolvedValue({
      practiceSets: [{
        practiceSetId: SET,
        paperId: PAPER,
        title: 'Safety practice',
        status: 'active',
        createdAt: CREATED,
      }],
    })
    h.start.mockResolvedValue({
      sessionId: SESSION,
      practiceSetId: SET,
      mode: 'sequential',
      questions: [question()],
      createdAt: CREATED,
      duplicate: false,
    })
    h.wrong.mockResolvedValue({ practiceSetId: SET, questions: [question()] })
    h.answer.mockResolvedValue({
      answerId: ANSWER,
      sessionId: SESSION,
      questionRevisionId: REVISION,
      correct: true,
      wrongState: 'resolved',
      createdAt: CREATED,
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
    app = createApp(ElearningPracticeLearnerSection)
    app.mount(root)
    await flush()
    return root
  }

  it('starts assessment-only practice, submits an answer, and refreshes resolved wrong questions', async () => {
    const view = await mount()
    select(view, 'elearning-practice-set-select', SET)
    await flush()
    ;(view.querySelector('[data-testid="elearning-practice-start"]') as HTMLButtonElement).click()
    await flush()
    const choice = view.querySelector('input[value="a"]') as HTMLInputElement
    choice.checked = true
    choice.dispatchEvent(new Event('change', { bubbles: true }))
    h.wrong.mockResolvedValueOnce({ practiceSetId: SET, questions: [] })
    ;(view.querySelector('[data-testid="elearning-practice-submit"]') as HTMLButtonElement).click()
    await flush()
    expect(h.answer).toHaveBeenCalledWith(SESSION, {
      requestId: REQUEST_B,
      questionRevisionId: REVISION,
      selectedOptionIds: ['a'],
    })
    expect(h.wrong).toHaveBeenCalledTimes(3)
    expect(view.querySelector('[data-testid="elearning-practice-learner-status"]')?.textContent)
      .toContain('Practice complete')
    expect(view.querySelector('[data-testid="elearning-practice-wrong-list"]')).toBeNull()
  })

  it('reuses start identity after a retry and rotates it when mode changes', async () => {
    const view = await mount()
    h.start.mockRejectedValueOnce(new ElearningApiError('network_error', 0))
    select(view, 'elearning-practice-set-select', SET)
    await flush()
    const button = view.querySelector('[data-testid="elearning-practice-start"]') as HTMLButtonElement
    button.click()
    await flush()
    button.click()
    await flush()
    expect(h.start.mock.calls[0]?.[0].requestId).toBe(REQUEST_A)
    expect(h.start.mock.calls[1]?.[0].requestId).toBe(REQUEST_A)

    select(view, 'elearning-practice-mode', 'random')
    button.click()
    await flush()
    expect(h.start.mock.calls[2]?.[0].requestId).toBe(REQUEST_B)
  })

  it('requires an answer before submitting', async () => {
    const view = await mount()
    select(view, 'elearning-practice-set-select', SET)
    await flush()
    ;(view.querySelector('[data-testid="elearning-practice-start"]') as HTMLButtonElement).click()
    await flush()
    ;(view.querySelector('[data-testid="elearning-practice-submit"]') as HTMLButtonElement).click()
    await flush()
    expect(h.answer).not.toHaveBeenCalled()
    expect(view.querySelector('[data-testid="elearning-practice-learner-status"]')?.textContent)
      .toContain('Select at least one answer')
  })
})
