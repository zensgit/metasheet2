import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { useLocale } from '../src/composables/useLocale'

const h = vi.hoisted(() => ({ open: vi.fn(), completed: vi.fn() }))

vi.mock('../src/services/elearningContent', async () => {
  const actual = await vi.importActual<typeof import('../src/services/elearningContent')>(
    '../src/services/elearningContent',
  )
  return { ...actual, openElearningContentItem: h.open }
})

import { ElearningApiError, type ElearningLearnerContentCourse } from '../src/services/elearning'
import ElearningContentLearnerCourse from '../src/views/ElearningContentLearnerCourse.vue'

const COURSE = '11111111-1111-4111-8111-111111111111'
const VERSION = '22222222-2222-4222-8222-222222222222'
const ARTICLE_ITEM = '33333333-3333-4333-8333-333333333333'
const LINK_ITEM = '44444444-4444-4444-8444-444444444444'
const COMPLETED = '2026-08-29T01:02:03.000Z'

const course: ElearningLearnerContentCourse = {
  courseId: COURSE,
  courseVersionId: VERSION,
  title: 'Content course',
  access: { kind: 'visibility', required: false },
  assignment: null,
  items: [
    {
      itemId: ARTICLE_ITEM,
      itemType: 'article',
      title: 'First article',
      status: 'not_started',
      completedAt: null,
    },
    {
      itemId: LINK_ITEM,
      itemType: 'external_link',
      title: 'Second link',
      status: 'not_started',
      completedAt: null,
    },
  ],
  completed: false,
}

async function flushUi(cycles = 10): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function openResult(itemType: 'article' | 'external_link') {
  return itemType === 'article'
    ? {
        itemId: ARTICLE_ITEM,
        itemType,
        title: 'First article',
        articleHtml: '<h4>Sanitized</h4><p>Body</p>',
        externalUrl: null,
        status: 'completed',
        completedAt: COMPLETED,
        assurance: 'weak_server_recorded_open',
      }
    : {
        itemId: LINK_ITEM,
        itemType,
        title: 'Second link',
        articleHtml: null,
        externalUrl: 'https://example.test/guide',
        status: 'completed',
        completedAt: COMPLETED,
        assurance: 'weak_server_recorded_launch',
      }
}

describe('ElearningContentLearnerCourse', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let uuidSpy: ReturnType<typeof vi.spyOn> | null = null

  function mountView(): HTMLDivElement {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(ElearningContentLearnerCourse, {
      course,
      onCompleted: h.completed,
    })
    app.mount(container)
    return container
  }

  beforeEach(() => {
    useLocale().setLocale('zh-CN')
    h.open.mockReset()
    h.completed.mockReset()
    let serial = 0
    uuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
      serial += 1
      const head = serial.toString(16).padStart(8, '0')
      const tail = serial.toString(16).padStart(12, '0')
      return `${head}-0000-4000-8000-${tail}`
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

  it('renders ordered content and only binds server-returned article HTML', async () => {
    h.open.mockResolvedValueOnce(openResult('article'))
    const root = mountView()
    expect([...root.querySelectorAll('.elearning-content-course__item strong')].map((node) => node.textContent)).toEqual([
      'First article',
      'Second link',
    ])
    expect(root.querySelector('[data-testid="elearning-content-article-rendered-0"]')).toBeNull()

    ;(root.querySelector('[data-testid="elearning-content-open-0"]') as HTMLButtonElement).click()
    await flushUi()
    const article = root.querySelector('[data-testid="elearning-content-article-rendered-0"]') as HTMLIFrameElement
    expect(article.getAttribute('srcdoc')).toBe('<h4>Sanitized</h4><p>Body</p>')
    expect(article.getAttribute('sandbox')).toBe('')
    expect(article.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(h.completed).toHaveBeenCalledTimes(1)
  })

  it('exposes external URLs only after a successful open with protected new-tab attributes', async () => {
    h.open.mockResolvedValueOnce(openResult('external_link'))
    const root = mountView()
    expect(root.querySelector('[data-testid="elearning-content-external-link-1"]')).toBeNull()
    ;(root.querySelector('[data-testid="elearning-content-open-1"]') as HTMLButtonElement).click()
    await flushUi()
    const link = root.querySelector('[data-testid="elearning-content-external-link-1"]') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://example.test/guide')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(h.completed).toHaveBeenCalledTimes(1)
  })

  it('reuses the same open request id after retryable failure and fails closed on type mismatch', async () => {
    h.open
      .mockRejectedValueOnce(new ElearningApiError('network_error', 0))
      .mockResolvedValueOnce(openResult('article'))
      .mockResolvedValueOnce({ ...openResult('external_link'), itemId: ARTICLE_ITEM })
    const root = mountView()
    const open = root.querySelector('[data-testid="elearning-content-open-0"]') as HTMLButtonElement
    open.click()
    await flushUi()
    const firstRequestId = h.open.mock.calls[0][1]
    open.click()
    await flushUi()
    expect(h.open.mock.calls[1][1]).toBe(firstRequestId)
    expect(h.completed).toHaveBeenCalledTimes(1)

    open.click()
    await flushUi()
    expect(h.completed).toHaveBeenCalledTimes(1)
    expect(root.querySelector('[data-testid="elearning-content-learner-status"]')?.textContent).toContain('invalid_response')
  })
})
