import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

import { listMyElearningCourses } from '../src/services/elearning'
import {
  createElearningContentRequestIdTracker,
  createElearningContentRevision,
  openElearningContentItem,
  publishElearningContentCourse,
} from '../src/services/elearningContent'

const COURSE = '11111111-1111-4111-8111-111111111111'
const VERSION = '22222222-2222-4222-8222-222222222222'
const VIDEO = '33333333-3333-4333-8333-333333333333'
const EXAM = '44444444-4444-4444-8444-444444444444'
const ARTICLE_ITEM = '55555555-5555-4555-8555-555555555555'
const LINK_ITEM = '66666666-6666-4666-8666-666666666666'
const ARTICLE_REVISION = '77777777-7777-4777-8777-777777777777'
const LINK_REVISION = '88888888-8888-4888-8888-888888888888'
const REQUEST = '99999999-9999-4999-8999-999999999999'
const CREATED = '2026-08-29T01:02:03.000Z'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function assessmentCourse(over: Record<string, unknown> = {}) {
  return {
    courseId: COURSE,
    courseVersionId: VERSION,
    title: 'Assessment course',
    access: { kind: 'assignment', required: true },
    assignment: { deadline: null, assignedAt: CREATED },
    video: {
      itemId: VIDEO,
      durationMs: 5000,
      status: 'not_started',
      effectiveMs: 0,
      maxPositionMs: 0,
      completedAt: null,
    },
    exam: { itemId: EXAM, latestAttempt: null },
    completed: false,
    ...over,
  }
}

function contentCourse(over: Record<string, unknown> = {}) {
  return {
    courseId: LINK_ITEM,
    courseVersionId: LINK_REVISION,
    title: 'Content course',
    access: { kind: 'visibility', required: false },
    assignment: null,
    items: [
      {
        itemId: ARTICLE_ITEM,
        itemType: 'article',
        title: 'First article',
        status: 'completed',
        completedAt: CREATED,
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
    ...over,
  }
}

function publishedCourse(over: Record<string, unknown> = {}) {
  return {
    courseId: COURSE,
    courseVersionId: VERSION,
    status: 'published',
    itemCount: 2,
    items: [
      {
        itemId: ARTICLE_ITEM,
        itemType: 'article',
        contentRevisionId: ARTICLE_REVISION,
        position: 1,
      },
      {
        itemId: LINK_ITEM,
        itemType: 'external_link',
        contentRevisionId: LINK_REVISION,
        position: 2,
      },
    ],
    ...over,
  }
}

function openedArticle(over: Record<string, unknown> = {}) {
  return {
    itemId: ARTICLE_ITEM,
    itemType: 'article',
    title: 'Article',
    articleHtml: '<p>Safe</p>',
    externalUrl: null,
    status: 'completed',
    completedAt: CREATED,
    assurance: 'weak_server_recorded_open',
    ...over,
  }
}

function lastCall(): { path: string; options: RequestInit } {
  const [path, options] = apiFetchMock.mock.calls.at(-1) ?? []
  return { path: String(path), options: (options ?? {}) as RequestInit }
}

beforeEach(() => {
  apiFetchMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('e-learning content client', () => {
  it('parses an exact mixed course union without changing course or item order', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, {
      courses: [assessmentCourse(), contentCourse()],
    }))
    const result = await listMyElearningCourses()
    expect(result.courses.map((course) => course.title)).toEqual([
      'Assessment course',
      'Content course',
    ])
    expect(result.courses[1]).toMatchObject({
      items: [
        { itemType: 'article', title: 'First article' },
        { itemType: 'external_link', title: 'Second link' },
      ],
    })
  })

  it.each([
    assessmentCourse({ items: contentCourse().items }),
    contentCourse({ video: assessmentCourse().video, exam: assessmentCourse().exam }),
    contentCourse({ extra: true }),
    contentCourse({ items: [{ ...contentCourse().items[0], itemType: 'file' }] }),
    contentCourse({
      items: [
        { ...contentCourse().items[0], status: 'completed', completedAt: null },
        contentCourse().items[1],
      ],
    }),
    contentCourse({
      items: [
        { ...contentCourse().items[0], completedAt: '2026-02-31T00:00:00.000Z' },
        contentCourse().items[1],
      ],
    }),
    contentCourse({
      items: [
        { ...contentCourse().items[0], completedAt: '2026-08-29T01:02:03Z' },
        contentCourse().items[1],
      ],
    }),
    assessmentCourse({ video: { ...assessmentCourse().video, status: 'completed', completedAt: null } }),
  ])('rejects mixed, extra, unknown, or invalid status shapes', async (course) => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, { courses: [course] }))
    await expect(listMyElearningCourses()).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })
  })

  it('sends closed revision, publish, and open commands and parses closed results', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(201, {
      articleHtml: '<p>Safe</p>',
      contentDigest: 'ab'.repeat(32),
      contentRevisionId: ARTICLE_REVISION,
      externalUrl: null,
      itemType: 'article',
      title: 'Article',
    }))
    await expect(createElearningContentRevision({
      requestId: REQUEST,
      itemType: 'article',
      title: 'Article',
      articleHtml: '<script>draft</script><p>Safe</p>',
      externalUrl: null,
    })).resolves.toMatchObject({ articleHtml: '<p>Safe</p>', itemType: 'article' })
    expect(JSON.parse(String(lastCall().options.body))).toEqual({
      requestId: REQUEST,
      itemType: 'article',
      title: 'Article',
      articleHtml: '<script>draft</script><p>Safe</p>',
      externalUrl: null,
    })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(201, {
      courseId: COURSE,
      courseVersionId: VERSION,
      status: 'published',
      itemCount: 1,
      items: [{
        itemId: ARTICLE_ITEM,
        itemType: 'article',
        contentRevisionId: ARTICLE_REVISION,
        position: 1,
      }],
    }))
    await publishElearningContentCourse({
      requestId: REQUEST,
      title: 'Course',
      items: [{ itemType: 'article', contentRevisionId: ARTICLE_REVISION }],
    })
    expect(lastCall().path).toBe('/api/elearning/admin/courses/content/publish')

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, {
      itemId: ARTICLE_ITEM,
      itemType: 'article',
      title: 'Article',
      articleHtml: '<p>Safe</p>',
      externalUrl: null,
      status: 'completed',
      completedAt: CREATED,
      assurance: 'weak_server_recorded_open',
    }))
    await openElearningContentItem(ARTICLE_ITEM, REQUEST)
    expect(lastCall().path).toBe(`/api/elearning/me/course-items/${ARTICLE_ITEM}/open`)
    expect(JSON.parse(String(lastCall().options.body))).toEqual({ requestId: REQUEST })
  })

  it('rejects response leaks and article/link mutual-exclusion violations', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(201, {
      articleHtml: '<p>Safe</p>',
      contentDigest: 'ab'.repeat(32),
      contentRevisionId: ARTICLE_REVISION,
      externalUrl: 'https://example.test/',
      itemType: 'article',
      title: 'Article',
    }))
    await expect(createElearningContentRevision({
      requestId: REQUEST,
      itemType: 'article',
      title: 'Article',
      articleHtml: '<p>Safe</p>',
      externalUrl: null,
    })).rejects.toMatchObject({ code: 'invalid_response', status: 201 })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, {
      itemId: LINK_ITEM,
      itemType: 'external_link',
      title: 'Link',
      articleHtml: null,
      externalUrl: 'https://example.test/',
      status: 'completed',
      completedAt: CREATED,
      assurance: 'weak_server_recorded_launch',
      requestHash: 'leak',
    }))
    await expect(openElearningContentItem(LINK_ITEM, REQUEST)).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })
  })

  it.each([
    publishedCourse({ extra: true }),
    publishedCourse({
      items: [
        publishedCourse().items[0],
        { ...publishedCourse().items[1], itemId: ARTICLE_ITEM },
      ],
    }),
    publishedCourse({
      items: [
        publishedCourse().items[0],
        { ...publishedCourse().items[1], contentRevisionId: ARTICLE_REVISION },
      ],
    }),
    publishedCourse({
      itemCount: 1,
      items: [{ ...publishedCourse().items[0], position: 2 }],
    }),
    publishedCourse({
      items: [
        { ...publishedCourse().items[0], position: 2 },
        { ...publishedCourse().items[1], position: 1 },
      ],
    }),
  ])('rejects malformed publish results', async (body) => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(201, body))
    await expect(publishElearningContentCourse({
      requestId: REQUEST,
      title: 'Course',
      items: [{ itemType: 'article', contentRevisionId: ARTICLE_REVISION }],
    })).rejects.toMatchObject({ code: 'invalid_response', status: 201 })
  })

  it.each([
    openedArticle({ status: 'opened' }),
    openedArticle({ completedAt: 'not-a-date' }),
    openedArticle({ completedAt: '2026-02-31T00:00:00.000Z' }),
    openedArticle({ assurance: 'weak_server_recorded_launch' }),
    openedArticle({ itemType: 'external_link' }),
  ])('rejects malformed open results', async (body) => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, body))
    await expect(openElearningContentItem(ARTICLE_ITEM, REQUEST)).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })
  })

  it('reuses ids for same logical retries and rotates on content, URL, or order changes', () => {
    const generated = [
      '10101010-1010-4010-8010-101010101010',
      '20202020-2020-4020-8020-202020202020',
      '30303030-3030-4030-8030-303030303030',
      '40404040-4040-4040-8040-404040404040',
      '50505050-5050-4050-8050-505050505050',
      '60606060-6060-4060-8060-606060606060',
      '70707070-7070-4070-8070-707070707070',
    ]
    const tracker = createElearningContentRequestIdTracker(() => generated.shift() ?? REQUEST)
    const article = {
      itemType: 'article' as const,
      title: 'Article',
      articleHtml: '<p>One</p>',
      externalUrl: null,
    }
    const first = tracker.forRevision('slot-a', article)
    expect(tracker.forRevision('slot-a', { ...article })).toBe(first)
    expect(tracker.forRevision('slot-a', { ...article, title: 'Changed' })).not.toBe(first)
    const changedBody = tracker.forRevision('slot-a', { ...article, articleHtml: '<p>Two</p>' })
    expect(changedBody).not.toBe(first)

    const link = {
      itemType: 'external_link' as const,
      title: 'Link',
      articleHtml: null,
      externalUrl: 'https://example.test/one',
    }
    const linkId = tracker.forRevision('slot-b', link)
    expect(tracker.forRevision('slot-b', { ...link, externalUrl: 'https://example.test/two' })).not.toBe(linkId)

    const publish = {
      title: 'Course',
      items: [
        { itemType: 'article' as const, contentRevisionId: ARTICLE_REVISION },
        { itemType: 'external_link' as const, contentRevisionId: LINK_REVISION },
      ],
    }
    const publishId = tracker.forPublish(publish)
    expect(tracker.forPublish({ ...publish, items: [...publish.items] })).toBe(publishId)
    expect(tracker.forPublish({ ...publish, items: [...publish.items].reverse() })).not.toBe(publishId)
  })
})
