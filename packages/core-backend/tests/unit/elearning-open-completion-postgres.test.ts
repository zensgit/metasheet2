import { describe, expect, it } from 'vitest'

import { createElearningContentRevision } from '../../src/services/elearning-content-revision-policy'
import {
  ElearningOpenCompletionStoreError,
  recordElearningOpenCompletion,
  type ElearningOpenCompletionDb,
  type ElearningOpenCompletionQueryable,
} from '../../src/services/elearning-open-completion-postgres'

const ORG = 'org-open-content'
const USER = 'user-open-content'
const REQUEST = '10000000-0000-4000-8000-000000000001'
const COURSE = '20000000-0000-4000-8000-000000000001'
const VERSION = '30000000-0000-4000-8000-000000000001'
const ITEM = '40000000-0000-4000-8000-000000000001'
const OTHER_ITEM = '40000000-0000-4000-8000-000000000002'
const REVISION = '50000000-0000-4000-8000-000000000001'
const MEMBER = '60000000-0000-4000-8000-000000000001'
const COMPLETED_AT = '2026-08-29T04:00:00.000Z'

function tagOf(sql: string): string | null {
  return /\/\* (elearning-(?:open-completion|access):[a-z-]+) \*\//.exec(sql)?.[1] ?? null
}

function createDb(over: { courseStatus?: string; versionStatus?: string } = {}): {
  db: ElearningOpenCompletionDb
  tags: string[]
  counts(): { events: number; evidence: number; requests: number }
} {
  const tags: string[] = []
  const revision = createElearningContentRevision({
    articleHtml: '<p>Server article</p>',
    contentRevisionId: REVISION,
    externalUrl: null,
    itemType: 'article',
    title: 'Server article',
  })
  let event: Record<string, unknown> | null = null
  let evidence: Record<string, unknown> | null = null
  let request: Record<string, unknown> | null = null
  const query: ElearningOpenCompletionQueryable['query'] = async (sql, params = []) => {
    const tag = tagOf(sql)
    if (!tag) throw new Error('unexpected query')
    tags.push(tag)
    if (tag === 'elearning-open-completion:lock-request') return { rows: [], rowCount: 1 }
    if (tag === 'elearning-open-completion:load-request') {
      return request ? { rows: [request], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (tag === 'elearning-open-completion:load-item') {
      return params[1] === ITEM
        ? {
            rows: [{
              course_version_id: VERSION,
              item_type: 'article',
              article_revision_id: REVISION,
              external_link_revision_id: null,
              completion_policy_version: 'article-open-v1',
            }],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 }
    }
    if (tag === 'elearning-access:lock-course') {
      return {
        rows: [{
          course_id: COURSE,
          course_status: over.courseStatus ?? 'active',
          active_version_id: VERSION,
          scope_id: null,
          version_status: over.versionStatus ?? 'published',
        }],
        rowCount: 1,
      }
    }
    if (tag === 'elearning-access:lock-assignment') {
      return { rows: [{ id: MEMBER }], rowCount: 1 }
    }
    if (tag === 'elearning-open-completion:load-revision') {
      return {
        rows: [{
          id: revision.contentRevisionId,
          item_type: revision.itemType,
          title: revision.title,
          article_html: revision.articleHtml,
          external_url: revision.externalUrl,
          content_digest: revision.contentDigest,
        }],
        rowCount: 1,
      }
    }
    if (tag === 'elearning-open-completion:server-time') {
      return { rows: [{ server_received_at: COMPLETED_AT }], rowCount: 1 }
    }
    if (tag === 'elearning-open-completion:claim-effect') {
      if (event) return { rows: [], rowCount: 0 }
      event = {
        id: params[0],
        user_id: params[2],
        course_version_id: params[3],
        course_version_item_id: params[4],
        item_type: params[5],
        content_revision_id: params[6],
        event_kind: params[7],
        event_digest: params[8],
        server_received_at: params[9],
      }
      return { rows: [{ id: params[0] }], rowCount: 1 }
    }
    if (tag === 'elearning-open-completion:load-event') {
      return event ? { rows: [event], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (tag === 'elearning-open-completion:load-effect') {
      return event ? { rows: [{ id: event.id }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (tag === 'elearning-open-completion:insert-evidence') {
      if (evidence) return { rows: [], rowCount: 0 }
      evidence = {
        id: params[0],
        open_event_id: params[10],
      }
      return { rows: [{ id: params[0] }], rowCount: 1 }
    }
    if (tag === 'elearning-open-completion:load-evidence') {
      return evidence ? { rows: [evidence], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (tag === 'elearning-open-completion:insert-request') {
      request = {
        request_hash: params[5],
        request_hash_version: params[6],
        course_version_item_id: params[4],
        event_id: params[7],
        completion_evidence_id: params[8],
      }
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-open-completion:verify-request-evidence') {
      return evidence && params[1] === evidence.id && params[4] === evidence.open_event_id
        ? { rows: [{ id: evidence.id }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    throw new Error(`unexpected query ${tag}`)
  }
  return {
    tags,
    counts: () => ({
      events: event ? 1 : 0,
      evidence: evidence ? 1 : 0,
      requests: request ? 1 : 0,
    }),
    db: { transaction: async (handler) => handler({ query }) },
  }
}

function input(over: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    userId: USER,
    requestId: REQUEST,
    itemId: ITEM,
    ...over,
  }
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ElearningOpenCompletionStoreError)
  expect((error as ElearningOpenCompletionStoreError).code).toBe(code)
  const rendered = `${String(error)}\n${error instanceof Error ? error.stack ?? '' : ''}`
  for (const value of [ORG, USER, REQUEST, ITEM]) expect(rendered).not.toContain(value)
}

async function expectAsyncCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise
    throw new Error(`expected ${code}`)
  } catch (error) {
    expectCode(error, code)
  }
}

describe('elearning open completion PostgreSQL authority', () => {
  it('records one server event and one canonical completion evidence then replays', async () => {
    const { db, counts, tags } = createDb()
    const first = await recordElearningOpenCompletion(db, input() as never)
    const replay = await recordElearningOpenCompletion(db, input() as never)
    expect(first).toEqual(replay)
    expect(first).toEqual({
      itemId: ITEM,
      itemType: 'article',
      title: 'Server article',
      articleHtml: '<p>Server article</p>',
      externalUrl: null,
      status: 'completed',
      completedAt: COMPLETED_AT,
      assurance: 'weak_server_recorded_open',
    })
    expect(counts()).toEqual({ events: 1, evidence: 1, requests: 1 })
    expect(tags.indexOf('elearning-access:lock-course')).toBeLessThan(
      tags.indexOf('elearning-open-completion:claim-effect'),
    )
    expect(tags).toContain('elearning-open-completion:verify-request-evidence')
  })

  it('does not accept one request key for another item', async () => {
    const { db } = createDb()
    await recordElearningOpenCompletion(db, input() as never)
    await expectAsyncCode(
      recordElearningOpenCompletion(db, input({ itemId: OTHER_ITEM }) as never),
      'conflict',
    )
  })

  it('rechecks withdrawn and invalid access before returning persisted content', async () => {
    const withdrawn = createDb({ courseStatus: 'withdrawn' })
    await expectAsyncCode(
      recordElearningOpenCompletion(withdrawn.db, input() as never),
      'course_withdrawn',
    )
    const invalid = createDb()
    await expectAsyncCode(
      recordElearningOpenCompletion(invalid.db, { ...input(), completedAt: COMPLETED_AT } as never),
      'invalid_input',
    )
  })
})
