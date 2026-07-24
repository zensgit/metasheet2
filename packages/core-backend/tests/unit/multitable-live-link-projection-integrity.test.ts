import { describe, expect, test } from 'vitest'

import {
  hydrateLiveLinkProjection,
  isLiveLinkTargetForeignKeyViolation,
  isRetryableLiveLinkDatabaseConflict,
  LiveLinkProjectionDataError,
} from '../../src/multitable/live-link-projection-integrity'
import type { QueryFn } from '../../src/multitable/permission-service'

const live = (value: unknown) => new Map([
  ['rec-1', { data: { 'field-link': value } }],
])

const queryWithEdges = (
  rows: Array<{ record_id: string; field_id: string; foreign_record_id: string }>,
): QueryFn => async () => ({ rows, rowCount: rows.length })

describe('live link projection integrity', () => {
  test('classifies only the owned FK and retryable transaction conflicts', () => {
    expect(isLiveLinkTargetForeignKeyViolation({ code: '23503', constraint: 'meta_links_foreign_record_id_fkey' })).toBe(true)
    expect(isLiveLinkTargetForeignKeyViolation({ code: '23503', constraint: 'some_other_fkey' })).toBe(false)
    expect(isRetryableLiveLinkDatabaseConflict({ code: '40P01' })).toBe(true)
    expect(isRetryableLiveLinkDatabaseConflict({ code: '40001' })).toBe(true)
    expect(isRetryableLiveLinkDatabaseConflict({ code: '23503' })).toBe(false)
  })

  test('hydrates the canonical authoritative target set regardless of stale JSON order/content', async () => {
    const query = queryWithEdges([
      { record_id: 'rec-1', field_id: 'field-link', foreign_record_id: 'target-2' },
      { record_id: 'rec-1', field_id: 'field-link', foreign_record_id: 'target-1' },
    ])
    const input = live(['stale-json-target', 7])
    const hydrated = await hydrateLiveLinkProjection(query, input, new Set(['field-link']))
    expect(hydrated.get('rec-1')?.data['field-link']).toEqual(['target-1', 'target-2'])
    expect(input.get('rec-1')?.data['field-link']).toEqual(['stale-json-target', 7])
  })

  test('hydrates an empty authoritative relation over stale JSON', async () => {
    const hydrated = await hydrateLiveLinkProjection(
      queryWithEdges([]),
      live(['stale-json-target']),
      new Set(['field-link']),
    )
    expect(hydrated.get('rec-1')?.data).not.toHaveProperty('field-link')
  })

  test('rejects duplicate authoritative edges instead of silently collapsing them', async () => {
    const duplicateEdge = queryWithEdges([
      { record_id: 'rec-1', field_id: 'field-link', foreign_record_id: 'target-1' },
      { record_id: 'rec-1', field_id: 'field-link', foreign_record_id: 'target-1' },
    ])
    await expect(
      hydrateLiveLinkProjection(duplicateEdge, live(['stale']), new Set(['field-link'])),
    ).rejects.toBeInstanceOf(LiveLinkProjectionDataError)
  })
})
