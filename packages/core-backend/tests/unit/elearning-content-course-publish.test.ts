import { describe, expect, it } from 'vitest'

import { createElearningContentRevision } from '../../src/services/elearning-content-revision-policy'
import {
  ELEARNING_CONTENT_COURSE_REQUEST_HASH_VERSION,
  ElearningContentCoursePublishError,
  publishElearningContentCourse,
  type ElearningContentCoursePublishDb,
  type ElearningContentCoursePublishQueryable,
} from '../../src/services/elearning-content-course-publish'

const ORG = 'org-content-course'
const ACTOR = 'actor-content-course'
const REQUEST = '10000000-0000-4000-8000-000000000001'
const ARTICLE = '20000000-0000-4000-8000-000000000001'
const LINK = '20000000-0000-4000-8000-000000000002'
const SENTINEL = 'secret-course-value'

function tagOf(sql: string): string | null {
  return /\/\* (elearning-content-course:[a-z-]+) \*\//.exec(sql)?.[1] ?? null
}

function storedRevision(
  contentRevisionId: string,
  itemType: 'article' | 'external_link',
): Record<string, unknown> {
  const revision = createElearningContentRevision({
    articleHtml: itemType === 'article' ? '<p>Article</p>' : null,
    contentRevisionId,
    externalUrl: itemType === 'external_link' ? 'https://example.com/course' : null,
    itemType,
    title: itemType === 'article' ? 'Article' : 'Link',
  })
  return {
    id: revision.contentRevisionId,
    item_type: revision.itemType,
    title: revision.title,
    article_html: revision.articleHtml,
    external_url: revision.externalUrl,
    content_digest: revision.contentDigest,
  }
}

function createDb(over: { missingRevision?: string } = {}): {
  db: ElearningContentCoursePublishDb
  tags: string[]
  requestCount(): number
} {
  const tags: string[] = []
  const revisionRows = new Map([
    [ARTICLE, storedRevision(ARTICLE, 'article')],
    [LINK, storedRevision(LINK, 'external_link')],
  ])
  const items: Array<Record<string, unknown>> = []
  let request: Record<string, unknown> | null = null
  const query: ElearningContentCoursePublishQueryable['query'] = async (sql, params = []) => {
    const tag = tagOf(sql)
    if (!tag) throw new Error('unexpected query')
    tags.push(tag)
    if (tag === 'elearning-content-course:lock') return { rows: [], rowCount: 1 }
    if (tag === 'elearning-content-course:load-request') {
      return request ? { rows: [request], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (tag === 'elearning-content-course:load-result-items') {
      return { rows: items, rowCount: items.length }
    }
    if (tag === 'elearning-content-course:load-revisions') {
      const ids = params[1] as string[]
      const rows = ids.flatMap((id) => {
        if (id === over.missingRevision) return []
        const row = revisionRows.get(id)
        return row ? [row] : []
      })
      return { rows, rowCount: rows.length }
    }
    if (tag === 'elearning-content-course:set-draft-pointer'
      || tag === 'elearning-content-course:publish-version'
      || tag === 'elearning-content-course:set-pointers') {
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-content-course:insert-item') {
      items.push({
        item_id: params[0],
        item_type: params[3],
        position: params[4],
        article_revision_id: params[5],
        external_link_revision_id: params[6],
      })
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-content-course:insert-request') {
      request = {
        org_id: params[1],
        request_hash: params[3],
        request_hash_version: params[4],
        course_id: params[5],
        course_version_id: params[6],
        item_count: params[7],
      }
      return { rows: [], rowCount: 1 }
    }
    if (
      tag === 'elearning-content-course:insert-course'
      || tag === 'elearning-content-course:insert-version'
    ) return { rows: [], rowCount: 1 }
    throw new Error(`unexpected query ${tag}`)
  }
  return {
    tags,
    requestCount: () => request ? 1 : 0,
    db: { transaction: async (handler) => handler({ query }) },
  }
}

function input(over: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    actorId: ACTOR,
    requestId: REQUEST,
    title: 'Mixed content course',
    items: [
      { itemType: 'article', contentRevisionId: ARTICLE },
      { itemType: 'external_link', contentRevisionId: LINK },
    ],
    ...over,
  }
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ElearningContentCoursePublishError)
  expect((error as ElearningContentCoursePublishError).code).toBe(code)
  const rendered = `${String(error)}\n${error instanceof Error ? error.stack ?? '' : ''}`
  for (const value of [ORG, ACTOR, REQUEST, SENTINEL]) {
    expect(rendered).not.toContain(value)
  }
}

async function expectAsyncCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise
    throw new Error(`expected ${code}`)
  } catch (error) {
    expectCode(error, code)
  }
}

describe('elearning content course publish authority', () => {
  it('publishes an ordered article-link course and replays the same result', async () => {
    const { db, tags, requestCount } = createDb()
    const first = await publishElearningContentCourse(db, input() as never)
    const replay = await publishElearningContentCourse(db, input() as never)
    expect(first).toEqual(replay)
    expect(first).toMatchObject({
      status: 'published',
      itemCount: 2,
      items: [
        { itemType: 'article', contentRevisionId: ARTICLE, position: 1 },
        { itemType: 'external_link', contentRevisionId: LINK, position: 2 },
      ],
    })
    expect(Object.keys(first)).toEqual([
      'courseId',
      'courseVersionId',
      'status',
      'itemCount',
      'items',
    ])
    expect(requestCount()).toBe(1)
    expect(tags).toContain('elearning-content-course:publish-version')
    expect(tags).toContain('elearning-content-course:load-result-items')
  })

  it('binds request replay to the exact ordered payload', async () => {
    const { db } = createDb()
    await publishElearningContentCourse(db, input() as never)
    await expectAsyncCode(publishElearningContentCourse(db, input({
      items: [
        { itemType: 'external_link', contentRevisionId: LINK },
        { itemType: 'article', contentRevisionId: ARTICLE },
      ],
    }) as never), 'conflict')
  })

  it('fails closed for empty, duplicate, cross-type, and missing revisions', async () => {
    const valid = createDb()
    for (const value of [
      input({ items: [] }),
      input({ items: [
        { itemType: 'article', contentRevisionId: ARTICLE },
        { itemType: 'article', contentRevisionId: ARTICLE },
      ] }),
      { ...input(), completed: true },
    ]) await expectAsyncCode(publishElearningContentCourse(valid.db, value as never), 'invalid_input')

    const missing = createDb({ missingRevision: LINK })
    await expectAsyncCode(
      publishElearningContentCourse(missing.db, input() as never),
      'reference_unavailable',
    )
  })

  it('pins the request hash version in the immutable request ledger', async () => {
    const { db } = createDb()
    const result = await publishElearningContentCourse(db, input() as never)
    expect(result.items).toHaveLength(2)
    expect(ELEARNING_CONTENT_COURSE_REQUEST_HASH_VERSION).toBe(1)
  })
})
