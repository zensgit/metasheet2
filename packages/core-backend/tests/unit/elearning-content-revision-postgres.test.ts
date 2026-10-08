import { describe, expect, it } from 'vitest'

import {
  ELEARNING_CONTENT_REVISION_REQUEST_HASH_VERSION,
  ElearningContentRevisionStoreError,
  storeElearningContentRevision,
  type ElearningContentRevisionDb,
  type ElearningContentRevisionQueryable,
} from '../../src/services/elearning-content-revision-postgres'

const ORG = 'org-content-revision'
const ACTOR = 'actor-content-revision'
const REQUEST = '10000000-0000-4000-8000-000000000001'
const SENTINEL = 'secret-content-request'

type RequestRow = {
  orgId: string
  sourceKey: string
  hash: string
  version: number
  revisionId: string
}

function tagOf(sql: string): string | null {
  return /\/\* (elearning-content-revision:[a-z-]+) \*\//.exec(sql)?.[1] ?? null
}

function createDb(): {
  db: ElearningContentRevisionDb
  tags: string[]
  requests: RequestRow[]
} {
  const tags: string[] = []
  const revisions = new Map<string, Record<string, unknown>>()
  const requests: RequestRow[] = []
  const query: ElearningContentRevisionQueryable['query'] = async (sql, params = []) => {
    const tag = tagOf(sql)
    if (!tag) throw new Error('unexpected query')
    tags.push(tag)
    if (tag === 'elearning-content-revision:lock') {
      expect(sql).toContain('pg_advisory_xact_lock')
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-content-revision:load-request') {
      expect(sql).toContain('FOR UPDATE OF request, revision')
      const request = requests.find(
        (row) => row.orgId === params[0] && row.sourceKey === params[1],
      )
      const revision = request ? revisions.get(request.revisionId) : null
      return request && revision
        ? {
            rows: [{
              ...revision,
              content_revision_id: request.revisionId,
              request_hash: request.hash,
              request_hash_version: request.version,
            }],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 }
    }
    if (tag === 'elearning-content-revision:insert-revision') {
      revisions.set(String(params[0]), {
        item_type: params[2],
        title: params[3],
        article_html: params[4],
        external_url: params[5],
        content_digest: params[6],
      })
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-content-revision:insert-request') {
      requests.push({
        orgId: String(params[1]),
        sourceKey: String(params[2]),
        hash: String(params[3]),
        version: Number(params[4]),
        revisionId: String(params[5]),
      })
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected query ${tag}`)
  }
  return {
    tags,
    requests,
    db: { transaction: async (handler) => handler({ query }) },
  }
}

function article(over: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    actorId: ACTOR,
    requestId: REQUEST,
    itemType: 'article',
    title: 'Article title',
    articleHtml: `<p>Hello</p><script>${SENTINEL}</script>`,
    externalUrl: null,
    ...over,
  }
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ElearningContentRevisionStoreError)
  expect((error as ElearningContentRevisionStoreError).code).toBe(code)
  const rendered = `${String(error)}\n${error instanceof Error ? error.stack ?? '' : ''}`
  expect(rendered).not.toContain(ORG)
  expect(rendered).not.toContain(ACTOR)
  expect(rendered).not.toContain(SENTINEL)
}

async function expectAsyncCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise
    throw new Error(`expected ${code}`)
  } catch (error) {
    expectCode(error, code)
  }
}

describe('elearning content revision PostgreSQL authority', () => {
  it('stores sanitized immutable content and replays the same request result', async () => {
    const { db, requests, tags } = createDb()
    const first = await storeElearningContentRevision(db, article() as never)
    const replay = await storeElearningContentRevision(db, article() as never)
    expect(first).toEqual(replay)
    expect(first).toMatchObject({
      itemType: 'article',
      title: 'Article title',
      articleHtml: '<p>Hello</p>',
      externalUrl: null,
    })
    expect(first.contentDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(first.articleHtml).not.toContain(SENTINEL)
    expect(requests).toHaveLength(1)
    expect(requests[0].version).toBe(ELEARNING_CONTENT_REVISION_REQUEST_HASH_VERSION)
    expect(tags).toEqual([
      'elearning-content-revision:lock',
      'elearning-content-revision:load-request',
      'elearning-content-revision:insert-revision',
      'elearning-content-revision:insert-request',
      'elearning-content-revision:lock',
      'elearning-content-revision:load-request',
    ])
  })

  it('returns a values-free conflict for a reused key with changed canonical content', async () => {
    const { db } = createDb()
    await storeElearningContentRevision(db, article() as never)
    await expectAsyncCode(storeElearningContentRevision(db, article({
      title: 'Changed title',
    }) as never), 'conflict')
  })

  it('fails closed for open bodies, unsafe external URLs, and client identities', async () => {
    const { db } = createDb()
    for (const input of [
      { ...article(), completed: true },
      article({ requestId: 'not-a-uuid' }),
      article({ orgId: '' }),
      {
        ...article(),
        itemType: 'external_link',
        articleHtml: null,
        externalUrl: 'http://example.com',
      },
    ]) {
      await expectAsyncCode(storeElearningContentRevision(db, input as never), 'invalid_input')
    }
  })
})
