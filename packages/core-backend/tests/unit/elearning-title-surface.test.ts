import { describe, expect, it } from 'vitest'

import {
  ELEARNING_TITLE_REQUEST_HASH_VERSION,
  ElearningTitleSurfaceError,
  getActiveElearningTitleSnapshot,
  hashElearningTitleSnapshotRequest,
  publishElearningTitleSnapshot,
  resolveActiveElearningTitle,
  type ElearningTitleDb,
} from '../../src/services/elearning-title-surface'

const ORG = 'org-title-surface'
const ACTOR = 'admin-title-surface'
const HEAD_ID = '11111111-1111-4111-8111-111111111111'
const REVISION_ID = '22222222-2222-4222-8222-222222222222'

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number | null }

function dbWith(
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>,
): ElearningTitleDb {
  return {
    query,
    transaction: async (run) => run({ query }),
  }
}

function publishInput(titles: unknown = [
  { id: 'starter', name: 'Starter', threshold: 0 },
  { id: 'expert', name: 'Expert', threshold: 100 },
]) {
  return {
    orgId: ORG,
    actorId: ACTOR,
    requestId: 'title-snapshot-v1',
    titles,
  }
}

function storedRevisionRows() {
  return [
    {
      revision_id: REVISION_ID,
      version: 3,
      created_at: '2026-08-30T01:00:00.000Z',
      title_key: 'starter',
      name: 'Starter',
      threshold: 0,
      position: 1,
    },
    {
      revision_id: REVISION_ID,
      version: 3,
      created_at: '2026-08-30T01:00:00.000Z',
      title_key: 'expert',
      name: 'Expert',
      threshold: 100,
      position: 2,
    },
  ]
}

describe('e-learning title surface', () => {
  it('hashes a canonical threshold-sorted snapshot without request or actor identity', () => {
    const titles = [
      { id: 'starter', name: 'Starter', threshold: 0 },
      { id: 'expert', name: 'Expert', threshold: 100 },
    ]
    expect(hashElearningTitleSnapshotRequest(titles))
      .toBe(hashElearningTitleSnapshotRequest(titles.map((row) => ({ ...row }))))
    expect(hashElearningTitleSnapshotRequest(titles)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns an explicit empty snapshot when no title head exists', async () => {
    const db = dbWith(async (sql, params) => {
      expect(sql).toContain('elearning-title:load-head')
      expect(params).toEqual([ORG])
      return { rows: [], rowCount: 0 }
    })
    await expect(getActiveElearningTitleSnapshot(db, ORG)).resolves.toEqual({
      revisionId: null,
      version: 0,
      titles: [],
      createdAt: null,
    })
  })

  it('loads a closed ordered snapshot and resolves the current title dynamically', async () => {
    const db = dbWith(async (sql) => {
      if (sql.includes(':load-head')) {
        return { rows: [{ active_revision_id: REVISION_ID }], rowCount: 1 }
      }
      if (sql.includes(':load-revision')) {
        return { rows: storedRevisionRows(), rowCount: 2 }
      }
      throw new Error('unexpected query')
    })
    await expect(getActiveElearningTitleSnapshot(db, ORG)).resolves.toEqual({
      revisionId: REVISION_ID,
      version: 3,
      titles: [
        { id: 'starter', name: 'Starter', threshold: 0 },
        { id: 'expert', name: 'Expert', threshold: 100 },
      ],
      createdAt: '2026-08-30T01:00:00.000Z',
    })
    await expect(resolveActiveElearningTitle(db, ORG, 99)).resolves.toEqual({
      id: 'starter',
      name: 'Starter',
      threshold: 0,
    })
    await expect(resolveActiveElearningTitle(db, ORG, 100)).resolves.toEqual({
      id: 'expert',
      name: 'Expert',
      threshold: 100,
    })
  })

  it('publishes a complete immutable revision and backfills milestone awards', async () => {
    const calls: string[] = []
    const db = dbWith(async (sql, params) => {
      calls.push(sql)
      if (sql.includes(':load-request')) return { rows: [], rowCount: 0 }
      if (sql.includes(':lock-head')) {
        return { rows: [{ id: HEAD_ID, latest_version: 2 }], rowCount: 1 }
      }
      if (sql.includes(':insert-revision')) {
        expect(params?.slice(1)).toEqual([ORG, HEAD_ID, 3, ACTOR])
        return {
          rows: [{ created_at: new Date('2026-08-30T02:00:00.000Z') }],
          rowCount: 1,
        }
      }
      if (sql.includes(':backfill-awards')) {
        expect(sql).toContain('title_row_id, threshold, balance_points')
        expect(sql).toContain('row.id, row.threshold, balance.balance_points')
      }
      return { rows: [], rowCount: 1 }
    })

    await expect(publishElearningTitleSnapshot(db, publishInput())).resolves.toEqual({
      revisionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      version: 3,
      titles: [
        { id: 'starter', name: 'Starter', threshold: 0 },
        { id: 'expert', name: 'Expert', threshold: 100 },
      ],
      createdAt: '2026-08-30T02:00:00.000Z',
      duplicate: false,
    })
    expect(calls.map((sql) => /elearning-title:([^*]+)/.exec(sql)?.[1]?.trim()))
      .toEqual([
        'request-lock',
        'load-request',
        'head-lock',
        'ensure-head',
        'lock-head',
        'insert-revision',
        'insert-row',
        'insert-row',
        'lock-balances',
        'activate-revision',
        'record-request',
        'backfill-awards',
      ])
  })

  it('replays an exact request and rejects a changed snapshot values-free', async () => {
    const hash = hashElearningTitleSnapshotRequest([
      { id: 'starter', name: 'Starter', threshold: 0 },
      { id: 'expert', name: 'Expert', threshold: 100 },
    ])
    const queries: string[] = []
    const db = dbWith(async (sql) => {
      queries.push(sql)
      if (sql.includes(':load-request')) {
        return {
          rows: [{
            request_hash: hash,
            request_hash_version: ELEARNING_TITLE_REQUEST_HASH_VERSION,
            revision_id: REVISION_ID,
          }],
          rowCount: 1,
        }
      }
      if (sql.includes(':load-revision')) {
        return { rows: storedRevisionRows(), rowCount: 2 }
      }
      return { rows: [], rowCount: 1 }
    })

    await expect(publishElearningTitleSnapshot(db, publishInput())).resolves.toEqual({
      revisionId: REVISION_ID,
      version: 3,
      titles: [
        { id: 'starter', name: 'Starter', threshold: 0 },
        { id: 'expert', name: 'Expert', threshold: 100 },
      ],
      createdAt: '2026-08-30T01:00:00.000Z',
      duplicate: true,
    })
    expect(queries.some((sql) => sql.includes(':head-lock'))).toBe(false)

    await expect(publishElearningTitleSnapshot(db, publishInput([
      { id: 'starter', name: 'Starter', threshold: 0 },
      { id: 'expert', name: 'Expert', threshold: 101 },
    ]))).rejects.toEqual(expect.objectContaining({
      code: 'conflict',
      message: 'conflict',
    }))
  })

  it.each([
    null,
    {},
    Array.from({ length: 101 }, (_, index) => ({
      id: `title-${index}`,
      name: `Title ${index}`,
      threshold: index,
    })),
    [{ id: 'overflow', name: 'Overflow', threshold: 2_147_483_648 }],
  ])('fails closed on invalid snapshot input %#', async (titles) => {
    const db = dbWith(async () => ({ rows: [], rowCount: 0 }))
    await expect(publishElearningTitleSnapshot(db, publishInput(titles)))
      .rejects.toBeInstanceOf(ElearningTitleSurfaceError)
  })

  it.each([
    { position: 2 },
    { threshold: -1 },
    { threshold: 2_147_483_648 },
    { revision_id: 'not-a-uuid' },
    { created_at: 'invalid-date' },
  ])('fails closed on malformed stored revision rows %#', async (over) => {
    const db = dbWith(async (sql) => {
      if (sql.includes(':load-head')) {
        return { rows: [{ active_revision_id: REVISION_ID }], rowCount: 1 }
      }
      return { rows: [{ ...storedRevisionRows()[0], ...over }], rowCount: 1 }
    })
    await expect(getActiveElearningTitleSnapshot(db, ORG))
      .rejects.toMatchObject({ code: 'unavailable' })
  })
})
