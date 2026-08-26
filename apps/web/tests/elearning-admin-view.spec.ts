import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { useLocale } from '../src/composables/useLocale'

const h = vi.hoisted(() => ({
  capabilities: vi.fn(),
  upload: vi.fn(),
  publish: vi.fn(),
  assign: vi.fn(),
  createBank: vi.fn(),
  listBanks: vi.fn(),
  listQuestions: vi.fn(),
  importQuestions: vi.fn(),
  publishPaper: vi.fn(),
  publishExam: vi.fn(),
}))

vi.mock('../src/services/elearning', async () => {
  const actual = await vi.importActual<typeof import('../src/services/elearning')>('../src/services/elearning')
  return {
    ...actual,
    getElearningCapabilities: h.capabilities,
    uploadElearningMedia: h.upload,
    publishElearningCourse: h.publish,
    assignElearningDirect: h.assign,
  }
})

vi.mock('../src/services/elearningAssessmentAdmin', async () => {
  const actual = await vi.importActual<typeof import('../src/services/elearningAssessmentAdmin')>(
    '../src/services/elearningAssessmentAdmin',
  )
  return {
    ...actual,
    createElearningQuestionBank: h.createBank,
    listElearningQuestionBanks: h.listBanks,
    listElearningBankQuestions: h.listQuestions,
    importElearningQuestionBankXlsx: h.importQuestions,
    publishElearningFixedPaper: h.publishPaper,
    publishElearningPaperExam: h.publishExam,
  }
})

import { ElearningApiError } from '../src/services/elearning'
import ElearningAdminView from '../src/views/ElearningAdminView.vue'

const REQUEST = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const SOURCE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const LOCAL = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const LOCAL_SECOND = '14141414-1414-4141-8141-141414141414'
const VERSION = '22222222-2222-4222-8222-222222222222'
const VIDEO = '33333333-3333-4333-8333-333333333333'
const EXAM_ITEM = '44444444-4444-4444-8444-444444444444'
const EXAM = '55555555-5555-4555-8555-555555555555'
const MEDIA = '66666666-6666-4666-8666-666666666666'
const COURSE = '11111111-1111-4111-8111-111111111111'
const ASSIGNMENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const MEMBER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SHA256 = 'ab'.repeat(32)
const BANK = '71717171-7171-4171-8171-717171717171'
const SECOND_BANK = '72727272-7272-4272-8272-727272727272'
const QUESTION_REVISION = '81818181-8181-4181-8181-818181818181'
const SECOND_QUESTION_REVISION = '82828282-8282-4282-8282-828282828282'
const PAPER = '91919191-9191-4191-8191-919191919191'

async function flushUi(cycles = 8): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function fillInput(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
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

function operationStageText(root: HTMLElement): string | null {
  return root.querySelector('[data-testid="elearning-admin-operation-stage"]')?.textContent?.trim() ?? null
}

function selectedFileText(root: HTMLElement): string | null {
  return root.querySelector('[data-testid="elearning-admin-selected-file"]')?.textContent?.trim() ?? null
}

describe('ElearningAdminView', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let uuidSpy: ReturnType<typeof vi.spyOn> | null = null

  function mountView() {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(ElearningAdminView)
    app.mount(container)
    return container
  }

  beforeEach(() => {
    useLocale().setLocale('zh-CN')
    h.capabilities.mockReset()
    h.upload.mockReset()
    h.publish.mockReset()
    h.assign.mockReset()
    h.createBank.mockReset()
    h.listBanks.mockReset()
    h.listQuestions.mockReset()
    h.importQuestions.mockReset()
    h.publishPaper.mockReset()
    h.publishExam.mockReset()
    h.capabilities.mockResolvedValue({
      enabled: true,
      capabilities: {
        content: true,
        assignment: true,
        assessment: true,
        incentive: false,
        analytics: false,
        media: true,
      },
    })
    let n = 0
    const ids = [LOCAL, REQUEST, SOURCE, LOCAL_SECOND]
    uuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => ids[n++] ?? LOCAL_SECOND)
    h.upload.mockResolvedValue({
      id: MEDIA,
      status: 'ready',
      durationMs: 4500,
      sizeBytes: 12,
      sha256: SHA256,
    })
    h.publish.mockResolvedValue({
      courseId: COURSE,
      courseVersionId: VERSION,
      videoItemId: VIDEO,
      examItemId: EXAM_ITEM,
      examId: EXAM,
      status: 'published',
      questionCount: 1,
      totalScore: 1,
    })
    h.assign.mockResolvedValue({
      assignmentId: ASSIGNMENT,
      memberId: MEMBER,
      duplicate: false,
    })
    h.createBank.mockResolvedValue({ bankId: SECOND_BANK })
    h.listBanks.mockResolvedValue({
      items: [{
        bankId: BANK,
        title: '安全题库',
        questionCount: 1,
        createdAt: '2026-08-26T00:00:00.000Z',
        updatedAt: '2026-08-26T00:00:00.000Z',
      }],
      page: 1,
      pageSize: 50,
      total: 1,
    })
    h.listQuestions.mockResolvedValue({
      bank: { bankId: BANK, title: '安全题库' },
      items: [{
        questionId: COURSE,
        questionRevisionId: QUESTION_REVISION,
        revision: 2,
        questionType: 'single_choice',
        prompt: '请选择安全做法',
        options: [
          { id: 'a', text: '佩戴护具' },
          { id: 'b', text: '忽略警示' },
        ],
        correctOptionIds: ['a'],
        points: 5,
        explanation: '按作业规范佩戴护具。',
        createdAt: '2026-08-26T00:00:00.000Z',
      }],
      page: 1,
      pageSize: 100,
      total: 1,
    })
    h.importQuestions.mockResolvedValue({ importedCount: 1 })
    h.publishPaper.mockResolvedValue({
      paperId: PAPER,
      status: 'published',
      itemCount: 1,
      totalPoints: 5,
    })
    h.publishExam.mockResolvedValue({
      examId: EXAM,
      paperId: PAPER,
      status: 'published',
      totalPoints: 5,
    })
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
    uuidSpy?.mockRestore()
    useLocale().setLocale('en')
    vi.clearAllMocks()
  })

  async function fillMinimum(root: HTMLDivElement): Promise<void> {
    await flushUi()
    const fileInput = root.querySelector('[data-testid="elearning-admin-file"]') as HTMLInputElement
    const file = new File([new Uint8Array([1, 2, 3])], 'demo.mp4', { type: 'video/mp4' })
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] })
    fileInput.dispatchEvent(new Event('change'))
    fillInput(root.querySelector('[data-testid="elearning-admin-title-input"]') as HTMLInputElement, '示范课')
    fillInput(root.querySelector('[data-testid="elearning-admin-prompt-0"]') as HTMLTextAreaElement, '选择正确项')
    const optionTexts = root.querySelectorAll('.elearning-option input[type="text"]')
    fillInput(optionTexts[0] as HTMLInputElement, '是')
    fillInput(optionTexts[1] as HTMLInputElement, '否')
    const correct = root.querySelector('.elearning-option input[type="radio"]') as HTMLInputElement
    correct.checked = true
    correct.dispatchEvent(new Event('change', { bubbles: true }))
    fillInput(root.querySelector('[data-testid="elearning-admin-pass-score"]') as HTMLInputElement, '1')
    fillInput(root.querySelector('[data-testid="elearning-admin-max-attempts"]') as HTMLInputElement, '2')
    fillInput(root.querySelector('[data-testid="elearning-admin-target"]') as HTMLInputElement, 'user-1')
    await flushUi()
  }

  function expectParkedSurfacesAbsent(text: string): void {
    expect(text).not.toContain('班级')
    expect(text).not.toContain('排课')
    expect(text).not.toContain('教室')
    expect(text).not.toContain('Class schedule')
  }

  it('renders English admin chrome when locale is en and excludes parked surfaces', async () => {
    useLocale().setLocale('en')
    const root = mountView()
    await flushUi()
    const text = root.textContent ?? ''
    expect(text).toContain('Cloud Classroom Admin')
    expect(text).toContain('Course title')
    expect(text).toContain('Objective questions')
    expect(text).toContain('Passing score')
    expect(text).toContain('Maximum attempts')
    expect(text).toContain('Assignee')
    expect(text).toContain('Publish and assign')
    expect(text).not.toContain('云课堂管理')
    expect(text).not.toContain('课程标题')
    expect(text).not.toContain('发布并指派')
    expect(root.querySelector('.elearning-option input[type="radio"]')?.getAttribute('aria-label')).toBe('Correct answer a')
    expect(root.querySelector('.elearning-option input[type="text"]')?.getAttribute('aria-label')).toBe('Option 1')
    expectParkedSurfacesAbsent(text)
  })

  it('renders Chinese admin chrome when locale is zh-CN and excludes parked surfaces', async () => {
    useLocale().setLocale('zh-CN')
    const root = mountView()
    await flushUi()
    const text = root.textContent ?? ''
    expect(text).toContain('云课堂管理')
    expect(text).toContain('课程标题')
    expect(text).toContain('客观题')
    expect(text).toContain('及格分')
    expect(text).toContain('最大尝试次数')
    expect(text).toContain('指派对象')
    expect(text).toContain('发布并指派')
    expect(text).not.toContain('Cloud Classroom Admin')
    expect(text).not.toContain('Course title')
    expect(text).not.toContain('Publish and assign')
    expect(root.querySelector('.elearning-option input[type="radio"]')?.getAttribute('aria-label')).toBe('正确答案 a')
    expect(root.querySelector('.elearning-option input[type="text"]')?.getAttribute('aria-label')).toBe('选项 1')
    expectParkedSurfacesAbsent(text)
  })

  it('switches admin chrome live when locale changes', async () => {
    useLocale().setLocale('en')
    const root = mountView()
    await flushUi()
    expect(root.textContent).toContain('Cloud Classroom Admin')
    expect(root.textContent).toContain('Publish and assign')
    expect(root.querySelector('.elearning-option input[type="radio"]')?.getAttribute('aria-label')).toBe('Correct answer a')

    useLocale().setLocale('zh-CN')
    await nextTick()
    expect(root.textContent).toContain('云课堂管理')
    expect(root.textContent).toContain('发布并指派')
    expect(root.textContent).not.toContain('Cloud Classroom Admin')
    expect(root.textContent).not.toContain('Publish and assign')
    expect(root.querySelector('.elearning-option input[type="radio"]')?.getAttribute('aria-label')).toBe('正确答案 a')
    expect(root.querySelector('.elearning-option input[type="text"]')?.getAttribute('aria-label')).toBe('选项 1')
  })

  it('surfaces English validation when the MP4 is missing', async () => {
    useLocale().setLocale('en')
    const root = mountView()
    await flushUi()
    fillInput(root.querySelector('[data-testid="elearning-admin-title-input"]') as HTMLInputElement, 'Demo')
    fillInput(root.querySelector('[data-testid="elearning-admin-prompt-0"]') as HTMLTextAreaElement, 'Pick')
    const optionTexts = root.querySelectorAll('.elearning-option input[type="text"]')
    fillInput(optionTexts[0] as HTMLInputElement, 'Yes')
    fillInput(optionTexts[1] as HTMLInputElement, 'No')
    const correct = root.querySelector('.elearning-option input[type="radio"]') as HTMLInputElement
    correct.checked = true
    correct.dispatchEvent(new Event('change', { bubbles: true }))
    fillInput(root.querySelector('[data-testid="elearning-admin-target"]') as HTMLInputElement, 'user-1')
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-admin-publish"]') as HTMLButtonElement).click()
    await flushUi()
    expect(root.querySelector('[data-testid="elearning-admin-status"]')?.textContent).toBe('Please select an MP4 file.')
    expect(h.upload).not.toHaveBeenCalled()
    expect(h.publish).not.toHaveBeenCalled()
  })

  function questionOptionTexts(root: HTMLElement, qIndex: number): string[] {
    return [...root.querySelectorAll(`[data-testid="elearning-admin-question-${qIndex}"] .elearning-option input[type="text"]`)]
      .map((el) => (el as HTMLInputElement).value)
  }

  function switchQuestionType(root: HTMLElement, qIndex: number, value: string): void {
    fillInput(root.querySelector(`[data-testid="elearning-admin-question-${qIndex}"] select`) as HTMLSelectElement, value)
  }

  it('uses English True/False defaults on true_false switch, publishes them, and preserves other option text', async () => {
    useLocale().setLocale('en')
    const root = mountView()
    await fillMinimum(root)
    ;(root.querySelector('[data-testid="elearning-admin-add-question"]') as HTMLButtonElement).click()
    await flushUi()
    expect(root.querySelector('[data-testid="elearning-admin-question-1"]')).toBeTruthy()
    fillInput(root.querySelector('[data-testid="elearning-admin-prompt-1"]') as HTMLTextAreaElement, 'Second prompt')
    const secondOptions = root.querySelectorAll('[data-testid="elearning-admin-question-1"] .elearning-option input[type="text"]')
    fillInput(secondOptions[0] as HTMLInputElement, 'Alpha')
    fillInput(secondOptions[1] as HTMLInputElement, 'Beta')
    const secondCorrect = root.querySelector('[data-testid="elearning-admin-question-1"] input[type="radio"]') as HTMLInputElement
    secondCorrect.checked = true
    secondCorrect.dispatchEvent(new Event('change', { bubbles: true }))

    switchQuestionType(root, 0, 'true_false')
    await flushUi()
    expect(questionOptionTexts(root, 0)).toEqual(['True', 'False'])
    expect(questionOptionTexts(root, 1)).toEqual(['Alpha', 'Beta'])

    const trueCorrect = root.querySelector('[data-testid="elearning-admin-question-0"] input[value="true"]') as HTMLInputElement
    trueCorrect.checked = true
    trueCorrect.dispatchEvent(new Event('change', { bubbles: true }))
    ;(root.querySelector('[data-testid="elearning-admin-publish"]') as HTMLButtonElement).click()
    await flushUi(12)

    const publishBody = h.publish.mock.calls[0]?.[0] as {
      questions: Array<{ questionType: string; options: Array<{ id: string; text: string }> }>
    }
    expect(publishBody.questions[0]).toMatchObject({
      questionType: 'true_false',
      options: [
        { id: 'true', text: 'True' },
        { id: 'false', text: 'False' },
      ],
    })
    expect(publishBody.questions[1]).toMatchObject({
      options: [
        { id: 'a', text: 'Alpha' },
        { id: 'b', text: 'Beta' },
      ],
    })
  })

  it('uses Chinese 正确/错误 defaults on true_false switch and publishes them', async () => {
    useLocale().setLocale('zh-CN')
    const root = mountView()
    await fillMinimum(root)
    switchQuestionType(root, 0, 'true_false')
    await flushUi()
    expect(questionOptionTexts(root, 0)).toEqual(['正确', '错误'])
    expect(questionOptionTexts(root, 0)).not.toEqual(['True', 'False'])

    const trueCorrect = root.querySelector('[data-testid="elearning-admin-question-0"] input[value="true"]') as HTMLInputElement
    trueCorrect.checked = true
    trueCorrect.dispatchEvent(new Event('change', { bubbles: true }))
    ;(root.querySelector('[data-testid="elearning-admin-publish"]') as HTMLButtonElement).click()
    await flushUi(12)

    const publishBody = h.publish.mock.calls[0]?.[0] as {
      questions: Array<{ questionType: string; options: Array<{ id: string; text: string }> }>
    }
    expect(publishBody.questions[0]).toMatchObject({
      questionType: 'true_false',
      options: [
        { id: 'true', text: '正确' },
        { id: 'false', text: '错误' },
      ],
    })
  })

  it('shows selected-file summary from File.name and clears it when the input is cleared', async () => {
    useLocale().setLocale('en')
    const root = mountView()
    await flushUi()
    expect(selectedFileText(root)).toBeNull()

    const fileInput = root.querySelector('[data-testid="elearning-admin-file"]') as HTMLInputElement
    const file = new File([new Uint8Array([1, 2, 3])], 'lesson-one.mp4', { type: 'video/mp4' })
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] })
    fileInput.dispatchEvent(new Event('change'))
    await flushUi()
    expect(selectedFileText(root)).toBe('Selected: lesson-one.mp4')

    useLocale().setLocale('zh-CN')
    await nextTick()
    expect(selectedFileText(root)).toBe('已选择：lesson-one.mp4')

    Object.defineProperty(fileInput, 'files', { configurable: true, value: [] })
    fileInput.dispatchEvent(new Event('change'))
    await flushUi()
    expect(selectedFileText(root)).toBeNull()
  })

  it('advances aria-live operation stage only after each pipeline promise resolves', async () => {
    useLocale().setLocale('en')
    const uploadGate = deferred<{
      id: string
      status: string
      durationMs: number
      sizeBytes: number
      sha256: string
    }>()
    const publishGate = deferred<{
      courseId: string
      courseVersionId: string
      videoItemId: string
      examItemId: string
      examId: string
      status: string
      questionCount: number
      totalScore: number
    }>()
    const assignGate = deferred<{
      assignmentId: string
      memberId: string
      duplicate: boolean
    }>()
    h.upload.mockReturnValueOnce(uploadGate.promise)
    h.publish.mockReturnValueOnce(publishGate.promise)
    h.assign.mockReturnValueOnce(assignGate.promise)

    const root = mountView()
    await fillMinimum(root)
    expect(operationStageText(root)).toBeNull()
    ;(root.querySelector('[data-testid="elearning-admin-publish"]') as HTMLButtonElement).click()
    await flushUi(12)

    expect(operationStageText(root)).toBe('Uploading video...')
    expect(root.querySelector('[data-testid="elearning-admin-publish"]')?.textContent?.trim()).toBe('Uploading video...')
    expect(h.upload).toHaveBeenCalledTimes(1)
    expect(h.publish).not.toHaveBeenCalled()
    expect(h.assign).not.toHaveBeenCalled()
    expect(root.textContent).not.toMatch(/\d+%/)

    uploadGate.resolve({
      id: MEDIA,
      status: 'ready',
      durationMs: 4500,
      sizeBytes: 12,
      sha256: SHA256,
    })
    await flushUi(12)
    expect(operationStageText(root)).toBe('Publishing course...')
    expect(root.querySelector('[data-testid="elearning-admin-publish"]')?.textContent?.trim()).toBe('Publishing course...')
    expect(h.publish).toHaveBeenCalledTimes(1)
    expect(h.assign).not.toHaveBeenCalled()

    publishGate.resolve({
      courseId: COURSE,
      courseVersionId: VERSION,
      videoItemId: VIDEO,
      examItemId: EXAM_ITEM,
      examId: EXAM,
      status: 'published',
      questionCount: 1,
      totalScore: 1,
    })
    await flushUi(12)
    expect(operationStageText(root)).toBe('Assigning learner...')
    expect(h.assign).toHaveBeenCalledTimes(1)
    expect(root.querySelector('[data-testid="elearning-admin-status"]')).toBeNull()

    assignGate.resolve({
      assignmentId: ASSIGNMENT,
      memberId: MEMBER,
      duplicate: false,
    })
    await flushUi(12)
    expect(operationStageText(root)).toBeNull()
    expect(root.querySelector('[data-testid="elearning-admin-status"]')?.textContent).toContain(
      'The course was published and assigned.',
    )
    expect(root.querySelector('[data-testid="elearning-admin-publish"]')?.textContent?.trim()).toBe('Publish and assign')
    expect((root.querySelector('[data-testid="elearning-admin-publish"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('resets operation stage after upload error and keeps controls governed by busy/ready rules', async () => {
    useLocale().setLocale('en')
    const uploadGate = deferred<never>()
    h.upload.mockReturnValueOnce(uploadGate.promise)
    const root = mountView()
    await fillMinimum(root)
    ;(root.querySelector('[data-testid="elearning-admin-publish"]') as HTMLButtonElement).click()
    await flushUi(12)
    expect(operationStageText(root)).toBe('Uploading video...')
    expect((root.querySelector('[data-testid="elearning-admin-publish"]') as HTMLButtonElement).disabled).toBe(true)

    uploadGate.reject(new ElearningApiError('upload_failed', 500))
    await flushUi(12)
    expect(operationStageText(root)).toBeNull()
    expect(root.querySelector('[data-testid="elearning-admin-status"]')?.textContent).toBe('Failed: upload_failed (500)')
    expect((root.querySelector('[data-testid="elearning-admin-publish"]') as HTMLButtonElement).disabled).toBe(false)
    expect(h.publish).not.toHaveBeenCalled()
    expect(h.assign).not.toHaveBeenCalled()
  })

  it('publishes then direct-assigns with retained UUID request and source keys', async () => {
    const root = mountView()
    await fillMinimum(root)
    ;(root.querySelector('[data-testid="elearning-admin-publish"]') as HTMLButtonElement).click()
    await flushUi(12)

    expect(h.upload).toHaveBeenCalledTimes(1)
    expect(h.publish).toHaveBeenCalledTimes(1)
    expect(h.assign).toHaveBeenCalledTimes(1)
    const publishBody = h.publish.mock.calls[0]?.[0] as Record<string, unknown>
    expect(publishBody.requestId).toBe(REQUEST)
    expect(publishBody).toMatchObject({
      title: '示范课',
      mediaId: MEDIA,
      passScore: 1,
      maxAttempts: 2,
    })
    expect(publishBody).not.toHaveProperty('orgId')
    expect(publishBody).not.toHaveProperty('actorId')
    expect(publishBody).not.toHaveProperty('userId')
    const assignBody = h.assign.mock.calls[0]?.[0] as Record<string, unknown>
    expect(assignBody).toEqual({
      targetUserId: 'user-1',
      courseVersionId: VERSION,
      sourceKey: SOURCE,
    })
    expect(root.querySelector('[data-testid="elearning-admin-status"]')?.textContent).toContain('课程已发布并完成指派')
    expect(operationStageText(root)).toBeNull()
  })

  it('shows partial success and retries assignment without republishing', async () => {
    const retryAssignGate = deferred<{
      assignmentId: string
      memberId: string
      duplicate: boolean
    }>()
    h.assign
      .mockRejectedValueOnce(new ElearningApiError('target_unavailable', 409))
      .mockReturnValueOnce(retryAssignGate.promise)
    const root = mountView()
    await fillMinimum(root)
    ;(root.querySelector('[data-testid="elearning-admin-publish"]') as HTMLButtonElement).click()
    await flushUi(12)

    expect(h.publish).toHaveBeenCalledTimes(1)
    expect(h.assign).toHaveBeenCalledTimes(1)
    const status = root.querySelector('[data-testid="elearning-admin-status"]')
    expect(status?.textContent).toContain('课程已发布，指派未完成')
    expect(status?.textContent).toContain('target_unavailable')
    expect(status?.textContent).toContain('409')
    expect(operationStageText(root)).toBeNull()
    const retry = root.querySelector('[data-testid="elearning-admin-retry"]') as HTMLButtonElement
    expect(retry).toBeTruthy()
    retry.click()
    await flushUi(12)
    expect(operationStageText(root)).toBe('正在指派学员…')
    expect(root.textContent).not.toContain('正在上传视频')
    expect(root.textContent).not.toContain('正在发布课程')
    expect(h.publish).toHaveBeenCalledTimes(1)
    expect(h.upload).toHaveBeenCalledTimes(1)
    expect(h.assign).toHaveBeenCalledTimes(2)
    expect(h.assign.mock.calls[1]?.[0]).toEqual({
      targetUserId: 'user-1',
      courseVersionId: VERSION,
      sourceKey: SOURCE,
    })

    retryAssignGate.resolve({
      assignmentId: ASSIGNMENT,
      memberId: MEMBER,
      duplicate: false,
    })
    await flushUi(12)
    expect(operationStageText(root)).toBeNull()
    expect(root.querySelector('[data-testid="elearning-admin-status"]')?.textContent).toContain('完成指派')
  })

  it('freezes target/deadline after publish and retries only the original assignment payload', async () => {
    h.assign
      .mockRejectedValueOnce(new ElearningApiError('target_unavailable', 409))
      .mockResolvedValueOnce({
        assignmentId: ASSIGNMENT,
        memberId: MEMBER,
        duplicate: false,
      })
    const root = mountView()
    await fillMinimum(root)
    fillInput(root.querySelector('[data-testid="elearning-admin-deadline"]') as HTMLInputElement, '2026-08-25T12:00')
    ;(root.querySelector('[data-testid="elearning-admin-publish"]') as HTMLButtonElement).click()
    await flushUi(12)

    expect(h.assign).toHaveBeenCalledTimes(1)
    const original = h.assign.mock.calls[0]?.[0] as Record<string, unknown>
    expect(original).toEqual({
      targetUserId: 'user-1',
      courseVersionId: VERSION,
      sourceKey: SOURCE,
      deadline: new Date('2026-08-25T12:00').toISOString(),
    })

    const target = root.querySelector('[data-testid="elearning-admin-target"]') as HTMLInputElement
    const deadline = root.querySelector('[data-testid="elearning-admin-deadline"]') as HTMLInputElement
    expect(target.disabled).toBe(true)
    expect(deadline.disabled).toBe(true)
    fillInput(target, 'user-2')
    fillInput(deadline, '2026-09-01T08:00')
    await flushUi()

    ;(root.querySelector('[data-testid="elearning-admin-retry"]') as HTMLButtonElement).click()
    await flushUi(12)
    expect(h.publish).toHaveBeenCalledTimes(1)
    expect(h.upload).toHaveBeenCalledTimes(1)
    expect(h.assign).toHaveBeenCalledTimes(2)
    expect(h.assign.mock.calls[1]?.[0]).toEqual(original)
    expect(h.assign.mock.calls[1]?.[0]).not.toEqual(expect.objectContaining({ targetUserId: 'user-2' }))
  })

  it('fetches capabilities before upload/publish/assign and does not require parked incentive/analytics', async () => {
    const root = mountView()
    await fillMinimum(root)
    ;(root.querySelector('[data-testid="elearning-admin-publish"]') as HTMLButtonElement).click()
    await flushUi(12)
    expect(h.capabilities).toHaveBeenCalledTimes(1)
    expect(h.upload).toHaveBeenCalledTimes(1)
    expect(h.publish).toHaveBeenCalledTimes(1)
    expect(h.assign).toHaveBeenCalledTimes(1)
    expect(h.capabilities.mock.invocationCallOrder[0]).toBeLessThan(h.upload.mock.invocationCallOrder[0])
  })

  it('fails closed without upload/publish/assign when enabled or a V0.1 capability is false', async () => {
    h.capabilities.mockResolvedValue({
      enabled: true,
      capabilities: {
        content: true,
        assignment: true,
        assessment: false,
        incentive: true,
        analytics: true,
        media: true,
      },
    })
    const root = mountView()
    await fillMinimum(root)
    expect(root.querySelector('[data-testid="elearning-admin-status"]')?.textContent).toContain('feature_disabled')
    const publish = root.querySelector('[data-testid="elearning-admin-publish"]') as HTMLButtonElement
    expect(publish.disabled).toBe(true)
    publish.click()
    await flushUi(12)
    expect(h.upload).not.toHaveBeenCalled()
    expect(h.publish).not.toHaveBeenCalled()
    expect(h.assign).not.toHaveBeenCalled()

    app?.unmount()
    container?.remove()
    h.capabilities.mockResolvedValue({
      enabled: false,
      capabilities: {
        content: true,
        assignment: true,
        assessment: true,
        incentive: false,
        analytics: false,
        media: true,
      },
    })
    const disabled = mountView()
    await fillMinimum(disabled)
    expect(disabled.querySelector('[data-testid="elearning-admin-status"]')?.textContent).toContain('feature_disabled')
    ;(disabled.querySelector('[data-testid="elearning-admin-publish"]') as HTMLButtonElement).click()
    await flushUi(12)
    expect(h.upload).not.toHaveBeenCalled()
    expect(h.publish).not.toHaveBeenCalled()
    expect(h.assign).not.toHaveBeenCalled()
  })

  it('keeps option ids unique after delete then add and offers only MP4', async () => {
    const root = mountView()
    await fillMinimum(root)
    const fileInput = root.querySelector('[data-testid="elearning-admin-file"]') as HTMLInputElement
    expect(fileInput.accept).toBe('video/mp4,.mp4')
    expect(fileInput.accept).not.toContain('quicktime')

    const addOption = [...root.querySelectorAll('button')].find((button) => button.textContent?.trim() === '添加选项') as HTMLButtonElement
    addOption.click()
    addOption.click()
    await flushUi()
    const optionIds = () => [...root.querySelectorAll('.elearning-option input[type="radio"]')].map((el) => (el as HTMLInputElement).value)
    expect(optionIds()).toEqual(['a', 'b', 'o3', 'o4'])

    const deleteButtons = [...root.querySelectorAll('button')].filter((button) => button.textContent?.trim() === '删除选项')
    deleteButtons[2].click()
    await flushUi()
    expect(optionIds()).toEqual(['a', 'b', 'o4'])

    addOption.click()
    await flushUi()
    expect(optionIds()).toEqual(['a', 'b', 'o4', 'o5'])
    expect(new Set(optionIds()).size).toBe(optionIds().length)

    const optionTexts = root.querySelectorAll('.elearning-option input[type="text"]')
    fillInput(optionTexts[2] as HTMLInputElement, '丙')
    fillInput(optionTexts[3] as HTMLInputElement, '丁')
    ;(root.querySelector('[data-testid="elearning-admin-publish"]') as HTMLButtonElement).click()
    await flushUi(12)
    const publishBody = h.publish.mock.calls[0]?.[0] as {
      questions: Array<{ options: Array<{ id: string }> }>
    }
    const publishedIds = publishBody.questions[0]?.options.map((option) => option.id) ?? []
    expect(publishedIds).toEqual(['a', 'b', 'o4', 'o5'])
    expect(new Set(publishedIds).size).toBe(4)
  })

  it('lazily opens the assessment resource section and creates a bank', async () => {
    const root = mountView()
    await flushUi()
    expect(h.listBanks).not.toHaveBeenCalled()
    expect(root.querySelector('[data-testid="elearning-assessment-bank-title"]')).toBeNull()

    ;(root.querySelector('[data-testid="elearning-assessment-toggle"]') as HTMLButtonElement).click()
    await flushUi(12)

    expect(h.capabilities).toHaveBeenCalledTimes(2)
    expect(h.listBanks).toHaveBeenCalledWith(1, 50)
    expect(h.listQuestions).toHaveBeenCalledWith(BANK, 1, 100)
    expect(root.textContent).toContain('题库与考试资源')
    expect(root.textContent).toContain('请选择安全做法')
    expect(root.textContent).toContain('正确答案: a')
    expect(root.textContent).toContain('a. 佩戴护具')
    expect(root.textContent).toContain('b. 忽略警示')
    expect(root.textContent).toContain('按作业规范佩戴护具。')

    fillInput(
      root.querySelector('[data-testid="elearning-assessment-bank-title"]') as HTMLInputElement,
      '新员工题库',
    )
    ;(root.querySelector('[data-testid="elearning-assessment-create-bank"]') as HTMLButtonElement).click()
    await flushUi(12)
    expect(h.createBank).toHaveBeenCalledWith('新员工题库')
    expect(h.listBanks).toHaveBeenCalledTimes(2)
  })

  it('imports XLSX, publishes a fixed paper, then publishes an explicitly unbound exam', async () => {
    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-assessment-toggle"]') as HTMLButtonElement).click()
    await flushUi(12)

    const input = root.querySelector('[data-testid="elearning-assessment-xlsx"]') as HTMLInputElement
    const workbook = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'questions.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    Object.defineProperty(input, 'files', { configurable: true, value: [workbook] })
    input.dispatchEvent(new Event('change'))
    ;(root.querySelector('[data-testid="elearning-assessment-import"]') as HTMLButtonElement).click()
    await flushUi(12)

    expect(h.importQuestions).toHaveBeenCalledWith(BANK, workbook)
    expect(root.querySelector('[data-testid="elearning-assessment-status"]')?.textContent).toContain('已导入 1 道题')

    const selected = root.querySelector(
      `[data-testid="elearning-assessment-question-${QUESTION_REVISION}"] input[type="checkbox"]`,
    ) as HTMLInputElement
    selected.checked = true
    selected.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect(selected.checked).toBe(true)
    fillInput(
      root.querySelector('[data-testid="elearning-assessment-paper-title"]') as HTMLInputElement,
      '安全固定卷',
    )
    const publishPaperButton = root.querySelector(
      '[data-testid="elearning-assessment-publish-paper"]',
    ) as HTMLButtonElement
    expect(publishPaperButton.disabled).toBe(false)
    publishPaperButton.click()
    await flushUi(12)

    expect(h.publishPaper).toHaveBeenCalledWith({
      title: '安全固定卷',
      items: [{ questionRevisionId: QUESTION_REVISION, points: 5 }],
    })
    expect(root.querySelector('[data-testid="elearning-assessment-status"]')?.textContent).toContain('固定试卷已发布')

    fillInput(
      root.querySelector('[data-testid="elearning-assessment-exam-title"]') as HTMLInputElement,
      '安全独立考试',
    )
    fillInput(
      root.querySelector('[data-testid="elearning-assessment-pass-score"]') as HTMLInputElement,
      '4',
    )
    fillInput(
      root.querySelector('[data-testid="elearning-assessment-max-attempts"]') as HTMLInputElement,
      '2',
    )
    fillInput(
      root.querySelector('[data-testid="elearning-assessment-duration"]') as HTMLInputElement,
      '15',
    )
    fillInput(
      root.querySelector('[data-testid="elearning-assessment-disclosure"]') as HTMLSelectElement,
      'wrong_items_after_submit',
    )
    const toggles = root.querySelectorAll('.assessment-check input[type="checkbox"]')
    for (const toggle of toggles) {
      ;(toggle as HTMLInputElement).checked = true
      toggle.dispatchEvent(new Event('change', { bubbles: true }))
    }
    ;(root.querySelector('[data-testid="elearning-assessment-publish-exam"]') as HTMLButtonElement).click()
    await flushUi(12)

    expect(h.publishExam).toHaveBeenCalledWith({
      paperId: PAPER,
      title: '安全独立考试',
      passScore: 4,
      maxAttempts: 2,
      windowStartsAt: null,
      windowEndsAt: null,
      durationSeconds: 900,
      shuffleQuestions: true,
      shuffleOptions: true,
      disclosurePolicy: 'wrong_items_after_submit',
    })
    expect(root.querySelector('[data-testid="elearning-assessment-unbound"]')?.textContent).toContain(
      '尚未指派给学员，也尚未绑定课程',
    )
  })

  it('fails the lazy assessment section closed before any catalog request', async () => {
    h.capabilities.mockResolvedValue({
      enabled: true,
      capabilities: {
        content: true,
        assignment: true,
        assessment: false,
        incentive: false,
        analytics: false,
        media: true,
      },
    })
    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-assessment-toggle"]') as HTMLButtonElement).click()
    await flushUi(12)

    expect(root.querySelector('[data-testid="elearning-assessment-status"]')?.textContent).toContain('feature_disabled')
    expect(h.listBanks).not.toHaveBeenCalled()
    expect(h.listQuestions).not.toHaveBeenCalled()
    expect(h.createBank).not.toHaveBeenCalled()
    expect(h.importQuestions).not.toHaveBeenCalled()
    expect(h.publishPaper).not.toHaveBeenCalled()
    expect(h.publishExam).not.toHaveBeenCalled()
  })

  it('requests later bank and question pages instead of silently truncating catalogs', async () => {
    h.listBanks.mockImplementation(async (page: number, pageSize: number) => ({
      items: [{
        bankId: BANK,
        title: `安全题库 ${page}`,
        questionCount: 101,
        createdAt: '2026-08-26T00:00:00.000Z',
        updatedAt: '2026-08-26T00:00:00.000Z',
      }],
      page,
      pageSize,
      total: 51,
    }))
    h.listQuestions.mockImplementation(async (_bankId: string, page: number, pageSize: number) => {
      const questionRevisionId = page === 1 ? QUESTION_REVISION : SECOND_QUESTION_REVISION
      return {
        bank: { bankId: BANK, title: '安全题库' },
        items: [{
          questionId: page === 1 ? COURSE : VERSION,
          questionRevisionId,
          revision: 1,
          questionType: 'single_choice',
          prompt: `第 ${page} 页题目`,
          options: [
            { id: 'a', text: '正确项' },
            { id: 'b', text: '错误项' },
          ],
          correctOptionIds: ['a'],
          points: page,
          explanation: null,
          createdAt: '2026-08-26T00:00:00.000Z',
        }],
        page,
        pageSize,
        total: 101,
      }
    })

    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-assessment-toggle"]') as HTMLButtonElement).click()
    await flushUi(12)

    const bankPrevious = root.querySelector(
      '[data-testid="elearning-assessment-bank-previous"]',
    ) as HTMLButtonElement
    const bankNext = root.querySelector(
      '[data-testid="elearning-assessment-bank-next"]',
    ) as HTMLButtonElement
    expect(bankPrevious.disabled).toBe(true)
    expect(bankNext.disabled).toBe(false)
    expect(root.textContent).toContain('第 1 / 2 页')

    const firstQuestion = root.querySelector(
      `[data-testid="elearning-assessment-question-${QUESTION_REVISION}"] input[type="checkbox"]`,
    ) as HTMLInputElement
    firstQuestion.click()
    await flushUi()

    ;(root.querySelector('[data-testid="elearning-assessment-question-next"]') as HTMLButtonElement).click()
    await flushUi(12)
    expect(h.listQuestions).toHaveBeenLastCalledWith(BANK, 2, 100)

    const questionPrevious = root.querySelector(
      '[data-testid="elearning-assessment-question-previous"]',
    ) as HTMLButtonElement
    const questionNext = root.querySelector(
      '[data-testid="elearning-assessment-question-next"]',
    ) as HTMLButtonElement
    expect(questionPrevious.disabled).toBe(false)
    expect(questionNext.disabled).toBe(true)
    const secondQuestion = root.querySelector(
      `[data-testid="elearning-assessment-question-${SECOND_QUESTION_REVISION}"] input[type="checkbox"]`,
    ) as HTMLInputElement
    secondQuestion.click()
    questionPrevious.click()
    await flushUi(12)
    expect(h.listQuestions).toHaveBeenLastCalledWith(BANK, 1, 100)
    expect((root.querySelector(
      `[data-testid="elearning-assessment-question-${QUESTION_REVISION}"] input[type="checkbox"]`,
    ) as HTMLInputElement).checked).toBe(true)

    bankNext.click()
    await flushUi(12)
    expect(h.listBanks).toHaveBeenLastCalledWith(2, 50)
    expect((root.querySelector(
      '[data-testid="elearning-assessment-bank-previous"]',
    ) as HTMLButtonElement).disabled).toBe(false)
    ;(root.querySelector('[data-testid="elearning-assessment-bank-previous"]') as HTMLButtonElement).click()
    await flushUi(12)
    expect(h.listBanks).toHaveBeenLastCalledWith(1, 50)

    fillInput(
      root.querySelector('[data-testid="elearning-assessment-paper-title"]') as HTMLInputElement,
      '跨页固定卷',
    )
    ;(root.querySelector('[data-testid="elearning-assessment-publish-paper"]') as HTMLButtonElement).click()
    await flushUi(12)
    expect(h.publishPaper).toHaveBeenCalledWith({
      title: '跨页固定卷',
      items: [
        { questionRevisionId: QUESTION_REVISION, points: 1 },
        { questionRevisionId: SECOND_QUESTION_REVISION, points: 2 },
      ],
    })
  })

  it('clears hidden question selections when the selected bank changes', async () => {
    h.listBanks.mockImplementation(async (page: number, pageSize: number) => ({
      items: [{
        bankId: page === 1 ? BANK : SECOND_BANK,
        title: page === 1 ? '安全题库' : '质量题库',
        questionCount: 1,
        createdAt: '2026-08-26T00:00:00.000Z',
        updatedAt: '2026-08-26T00:00:00.000Z',
      }],
      page,
      pageSize,
      total: 51,
    }))
    h.listQuestions.mockImplementation(async (bankId: string, page: number, pageSize: number) => ({
      bank: { bankId, title: bankId === BANK ? '安全题库' : '质量题库' },
      items: [{
        questionId: bankId === BANK ? COURSE : VERSION,
        questionRevisionId: bankId === BANK ? QUESTION_REVISION : SECOND_QUESTION_REVISION,
        revision: 1,
        questionType: 'single_choice',
        prompt: bankId === BANK ? '安全题目' : '质量题目',
        options: [
          { id: 'a', text: '正确项' },
          { id: 'b', text: '错误项' },
        ],
        correctOptionIds: ['a'],
        points: 1,
        explanation: null,
        createdAt: '2026-08-26T00:00:00.000Z',
      }],
      page,
      pageSize,
      total: 1,
    }))

    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-assessment-toggle"]') as HTMLButtonElement).click()
    await flushUi(12)
    ;(root.querySelector(
      `[data-testid="elearning-assessment-question-${QUESTION_REVISION}"] input[type="checkbox"]`,
    ) as HTMLInputElement).click()
    await flushUi()
    expect((root.querySelector(
      '[data-testid="elearning-assessment-publish-paper"]',
    ) as HTMLButtonElement).disabled).toBe(false)

    ;(root.querySelector('[data-testid="elearning-assessment-bank-next"]') as HTMLButtonElement).click()
    await flushUi(12)
    expect(h.listQuestions).toHaveBeenLastCalledWith(SECOND_BANK, 1, 100)
    expect(root.textContent).toContain('质量题目')
    expect((root.querySelector(
      '[data-testid="elearning-assessment-publish-paper"]',
    ) as HTMLButtonElement).disabled).toBe(true)

    ;(root.querySelector('[data-testid="elearning-assessment-bank-previous"]') as HTMLButtonElement).click()
    await flushUi(12)
    expect((root.querySelector(
      `[data-testid="elearning-assessment-question-${QUESTION_REVISION}"] input[type="checkbox"]`,
    ) as HTMLInputElement).checked).toBe(false)
  })

  it('falls back from an empty trailing catalog page after totals shrink', async () => {
    h.listBanks
      .mockResolvedValueOnce({
        items: [{
          bankId: BANK,
          title: '安全题库',
          questionCount: 101,
          createdAt: '2026-08-26T00:00:00.000Z',
          updatedAt: '2026-08-26T00:00:00.000Z',
        }],
        page: 1,
        pageSize: 50,
        total: 51,
      })
      .mockResolvedValueOnce({ items: [], page: 2, pageSize: 50, total: 1 })
      .mockResolvedValueOnce({
        items: [{
          bankId: BANK,
          title: '安全题库',
          questionCount: 1,
          createdAt: '2026-08-26T00:00:00.000Z',
          updatedAt: '2026-08-26T00:00:00.000Z',
        }],
        page: 1,
        pageSize: 50,
        total: 1,
      })
    const oneQuestion = [{
      questionId: COURSE,
      questionRevisionId: QUESTION_REVISION,
      revision: 1,
      questionType: 'single_choice',
      prompt: '安全题目',
      options: [
        { id: 'a', text: '正确项' },
        { id: 'b', text: '错误项' },
      ],
      correctOptionIds: ['a'],
      points: 1,
      explanation: null,
      createdAt: '2026-08-26T00:00:00.000Z',
    }]
    h.listQuestions
      .mockResolvedValueOnce({
        bank: { bankId: BANK, title: '安全题库' },
        items: oneQuestion,
        page: 1,
        pageSize: 100,
        total: 101,
      })
      .mockResolvedValueOnce({
        bank: { bankId: BANK, title: '安全题库' },
        items: [],
        page: 2,
        pageSize: 100,
        total: 1,
      })
      .mockResolvedValue({
        bank: { bankId: BANK, title: '安全题库' },
        items: oneQuestion,
        page: 1,
        pageSize: 100,
        total: 1,
      })

    const root = mountView()
    await flushUi()
    ;(root.querySelector('[data-testid="elearning-assessment-toggle"]') as HTMLButtonElement).click()
    await flushUi(12)
    ;(root.querySelector('[data-testid="elearning-assessment-question-next"]') as HTMLButtonElement).click()
    await flushUi(12)
    expect(h.listQuestions.mock.calls.slice(-2)).toEqual([[BANK, 2, 100], [BANK, 1, 100]])
    expect(root.textContent).toContain('安全题目')
    expect(root.querySelector('[data-testid="elearning-assessment-question-next"]')).toBeNull()

    ;(root.querySelector('[data-testid="elearning-assessment-bank-next"]') as HTMLButtonElement).click()
    await flushUi(12)

    expect(h.listBanks.mock.calls.slice(-2)).toEqual([[2, 50], [1, 50]])
    expect(root.textContent).toContain('安全题库 (1)')
    expect(root.querySelector('[data-testid="elearning-assessment-bank-next"]')).toBeNull()
  })
})
