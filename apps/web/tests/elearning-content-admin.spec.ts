import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { useLocale } from '../src/composables/useLocale'

const h = vi.hoisted(() => ({
  createRevision: vi.fn(),
  publishCourse: vi.fn(),
  assign: vi.fn(),
}))

vi.mock('../src/services/elearningContent', async () => {
  const actual = await vi.importActual<typeof import('../src/services/elearningContent')>(
    '../src/services/elearningContent',
  )
  return {
    ...actual,
    createElearningContentRevision: h.createRevision,
    publishElearningContentCourse: h.publishCourse,
  }
})

vi.mock('../src/services/elearning', async () => {
  const actual = await vi.importActual<typeof import('../src/services/elearning')>('../src/services/elearning')
  return { ...actual, assignElearningDirect: h.assign }
})

import { ElearningApiError } from '../src/services/elearning'
import ElearningContentAdminSection from '../src/views/ElearningContentAdminSection.vue'

const COURSE = '11111111-1111-4111-8111-111111111111'
const VERSION = '22222222-2222-4222-8222-222222222222'
const SECOND_VERSION = '22222222-2222-4222-8222-222222222223'
const ARTICLE_REVISION = '33333333-3333-4333-8333-333333333333'
const LINK_REVISION = '44444444-4444-4444-8444-444444444444'
const ARTICLE_ITEM = '55555555-5555-4555-8555-555555555555'
const LINK_ITEM = '66666666-6666-4666-8666-666666666666'

async function flushUi(cycles = 10): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function fill(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function revisionResult(input: Record<string, unknown>) {
  return {
    itemType: input.itemType,
    title: input.title,
    articleHtml: input.itemType === 'article' ? '<p>Safe</p>' : null,
    externalUrl: input.itemType === 'external_link' ? input.externalUrl : null,
    contentRevisionId: input.itemType === 'article' ? ARTICLE_REVISION : LINK_REVISION,
    contentDigest: 'ab'.repeat(32),
  }
}

describe('ElearningContentAdminSection', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let uuidSpy: ReturnType<typeof vi.spyOn> | null = null

  function mountView(assignmentEnabled = true): HTMLDivElement {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(ElearningContentAdminSection, { assignmentEnabled })
    app.mount(container)
    return container
  }

  beforeEach(() => {
    useLocale().setLocale('zh-CN')
    h.createRevision.mockReset()
    h.publishCourse.mockReset()
    h.assign.mockReset()
    let serial = 0
    uuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
      serial += 1
      const head = serial.toString(16).padStart(8, '0')
      const tail = serial.toString(16).padStart(12, '0')
      return `${head}-0000-4000-8000-${tail}`
    })
    h.createRevision.mockImplementation(async (input: Record<string, unknown>) => revisionResult(input))
    h.publishCourse.mockResolvedValue({
      courseId: COURSE,
      courseVersionId: VERSION,
      status: 'published',
      itemCount: 2,
      items: [
        { itemId: ARTICLE_ITEM, itemType: 'article', contentRevisionId: ARTICLE_REVISION, position: 1 },
        { itemId: LINK_ITEM, itemType: 'external_link', contentRevisionId: LINK_REVISION, position: 2 },
      ],
    })
    h.assign.mockResolvedValue({ assignmentId: COURSE, memberId: VERSION, duplicate: false })
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

  async function fillArticleAndLink(root: HTMLDivElement): Promise<void> {
    fill(root.querySelector('[data-testid="elearning-content-course-title"]') as HTMLInputElement, '入职课程')
    fill(root.querySelector('[data-testid="elearning-content-item-title-0"]') as HTMLInputElement, '第一篇')
    fill(root.querySelector('[data-testid="elearning-content-article-0"]') as HTMLTextAreaElement, '<h2>欢迎</h2>')
    ;(root.querySelector('[data-testid="elearning-content-add-link"]') as HTMLButtonElement).click()
    await flushUi()
    fill(root.querySelector('[data-testid="elearning-content-item-title-1"]') as HTMLInputElement, '外部资料')
    fill(root.querySelector('[data-testid="elearning-content-link-1"]') as HTMLInputElement, 'https://example.test/guide')
  }

  it('publishes ordered article/link revisions and optionally reuses direct assignment', async () => {
    const root = mountView()
    await fillArticleAndLink(root)
    fill(root.querySelector('[data-testid="elearning-content-target-user"]') as HTMLInputElement, 'user-1')
    ;(root.querySelector('[data-testid="elearning-content-publish"]') as HTMLButtonElement).click()
    await flushUi(20)

    expect(h.createRevision.mock.calls.map((call) => call[0].itemType)).toEqual([
      'article',
      'external_link',
    ])
    expect(h.publishCourse).toHaveBeenCalledWith(expect.objectContaining({
      title: '入职课程',
      items: [
        { itemType: 'article', contentRevisionId: ARTICLE_REVISION },
        { itemType: 'external_link', contentRevisionId: LINK_REVISION },
      ],
    }))
    expect(h.assign).toHaveBeenCalledWith(expect.objectContaining({
      targetUserId: 'user-1',
      courseVersionId: VERSION,
    }))
    expect(root.querySelector('[data-testid="elearning-content-admin-status"]')?.textContent).toContain('完成指派')
  })

  it('preserves the request id for retry and rotates it after body or order changes', async () => {
    const root = mountView(false)
    await fillArticleAndLink(root)
    h.createRevision.mockRejectedValueOnce(new ElearningApiError('network_error', 0))

    const publish = root.querySelector('[data-testid="elearning-content-publish"]') as HTMLButtonElement
    publish.click()
    await flushUi(12)
    const firstId = h.createRevision.mock.calls[0][0].requestId

    publish.click()
    await flushUi(20)
    expect(h.createRevision.mock.calls[1][0].requestId).toBe(firstId)
    const firstPublishId = h.publishCourse.mock.calls[0][0].requestId

    fill(root.querySelector('[data-testid="elearning-content-article-0"]') as HTMLTextAreaElement, '<h2>更新</h2>')
    ;(root.querySelector('[data-testid="elearning-content-move-up-1"]') as HTMLButtonElement).click()
    await flushUi()
    publish.click()
    await flushUi(20)

    const latestArticleCall = h.createRevision.mock.calls.findLast(
      (call) => call[0].itemType === 'article',
    )
    expect(latestArticleCall?.[0].requestId).not.toBe(firstId)
    expect(h.publishCourse.mock.calls[1][0].requestId).not.toBe(firstPublishId)
    expect(h.publishCourse.mock.calls[1][0].items.map((item: { itemType: string }) => item.itemType)).toEqual([
      'external_link',
      'article',
    ])
  })

  it('keys direct-assignment retries by the exact course version and target user', async () => {
    const root = mountView()
    await fillArticleAndLink(root)
    const target = root.querySelector('[data-testid="elearning-content-target-user"]') as HTMLInputElement
    const publish = root.querySelector('[data-testid="elearning-content-publish"]') as HTMLButtonElement

    fill(target, 'user-1')
    publish.click()
    await flushUi(20)
    const firstSourceKey = h.assign.mock.calls[0][0].sourceKey

    publish.click()
    await flushUi(20)
    expect(h.assign.mock.calls[1][0].sourceKey).toBe(firstSourceKey)

    fill(target, 'user-2')
    publish.click()
    await flushUi(20)
    const secondTargetSourceKey = h.assign.mock.calls[2][0].sourceKey
    expect(secondTargetSourceKey).not.toBe(firstSourceKey)

    h.publishCourse.mockResolvedValueOnce({
      courseId: COURSE,
      courseVersionId: SECOND_VERSION,
      status: 'published',
      itemCount: 2,
      items: [
        { itemId: ARTICLE_ITEM, itemType: 'article', contentRevisionId: ARTICLE_REVISION, position: 1 },
        { itemId: LINK_ITEM, itemType: 'external_link', contentRevisionId: LINK_REVISION, position: 2 },
      ],
    })
    publish.click()
    await flushUi(20)
    expect(h.assign.mock.calls[3][0]).toEqual(expect.objectContaining({
      targetUserId: 'user-2',
      courseVersionId: SECOND_VERSION,
    }))
    expect(h.assign.mock.calls[3][0].sourceKey).not.toBe(secondTargetSourceKey)
  })

  it('keeps draft HTML out of rendering and validates empty ordered content locally', async () => {
    const root = mountView(false)
    expect(root.innerHTML).not.toContain('<h2>unsafe</h2>')
    ;(root.querySelector('[data-testid="elearning-content-remove-0"]') as HTMLButtonElement).click()
    fill(root.querySelector('[data-testid="elearning-content-course-title"]') as HTMLInputElement, '空课程')
    ;(root.querySelector('[data-testid="elearning-content-publish"]') as HTMLButtonElement).click()
    await flushUi()
    expect(h.createRevision).not.toHaveBeenCalled()
    expect(h.publishCourse).not.toHaveBeenCalled()
    expect(root.querySelector('[data-testid="elearning-content-admin-status"]')?.textContent).toContain('至少添加')
  })
})
