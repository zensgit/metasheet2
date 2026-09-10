import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'

import { useLocale } from '../src/composables/useLocale'

const h = vi.hoisted(() => ({ getProfile: vi.fn() }))
vi.mock('../src/services/elearningProfile', async () => {
  const actual = await vi.importActual<typeof import('../src/services/elearningProfile')>(
    '../src/services/elearningProfile',
  )
  return { ...actual, getMyElearningLearningProfile: h.getProfile }
})

import ElearningLearningProfileSection from '../src/views/ElearningLearningProfileSection.vue'

const COURSE_1 = '11111111-1111-4111-8111-111111111111'
const VERSION_1 = '22222222-2222-4222-8222-222222222222'
const COURSE_2 = '33333333-3333-4333-8333-333333333333'
const VERSION_2 = '44444444-4444-4444-8444-444444444444'
const ITEM = '55555555-5555-4555-8555-555555555555'

async function flushUi(cycles = 8): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('ElearningLearningProfileSection', () => {
  let app: VueApp<Element> | null = null
  let root: HTMLDivElement | null = null

  function mount(): HTMLDivElement {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(ElearningLearningProfileSection)
    app.mount(root)
    return root
  }

  beforeEach(() => {
    useLocale().setLocale('en')
    h.getProfile.mockReset()
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    app = null
    root = null
    vi.clearAllMocks()
  })

  it('renders the archive summary and appends stable pages', async () => {
    h.getProfile
      .mockResolvedValueOnce({
        userId: 'learner-1',
        summary: { completedCourses: 2, assessmentCourses: 1, contentCourses: 1 },
        courses: [{
          courseId: COURSE_1,
          courseVersionId: VERSION_1,
          title: 'Assessment course',
          kind: 'assessment',
          completedAt: '2026-08-30T01:30:00.000Z',
          exams: [{ itemId: ITEM, earnedScore: 9, totalScore: 10, passedAt: '2026-08-30T01:30:00.000Z' }],
        }],
        nextCursor: 'cursor_2',
      })
      .mockResolvedValueOnce({
        userId: 'learner-1',
        summary: { completedCourses: 2, assessmentCourses: 1, contentCourses: 1 },
        courses: [{
          courseId: COURSE_2,
          courseVersionId: VERSION_2,
          title: 'Article course',
          kind: 'content',
          completedAt: '2026-08-29T01:30:00.000Z',
        }],
        nextCursor: null,
      })
    const view = mount()
    await flushUi()
    expect(h.getProfile).toHaveBeenCalledWith(null)
    expect(view.querySelector('[data-testid="elearning-profile-summary"]')?.textContent)
      .toContain('2')
    expect(view.textContent).toContain('9 / 10')
    ;(view.querySelector('[data-testid="elearning-profile-more"]') as HTMLButtonElement).click()
    await flushUi()
    expect(h.getProfile).toHaveBeenLastCalledWith('cursor_2')
    expect(view.textContent).toContain('Assessment course')
    expect(view.textContent).toContain('Article course')
    expect(view.querySelector('[data-testid="elearning-profile-more"]')).toBeNull()
  })

  it('keeps failed loading distinct from an empty archive', async () => {
    h.getProfile.mockRejectedValue(new Error('network'))
    const view = mount()
    await flushUi()
    expect(view.querySelector('[data-testid="elearning-profile-error"]')).not.toBeNull()
    expect(view.querySelector('[data-testid="elearning-profile-empty"]')).toBeNull()
  })
})
