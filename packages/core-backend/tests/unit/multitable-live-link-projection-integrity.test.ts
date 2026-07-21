import { describe, expect, test } from 'vitest'

import { isLiveLinkProjectionConsistent } from '../../src/multitable/live-link-projection-integrity'
import type { QueryFn } from '../../src/multitable/permission-service'

const live = (value: unknown) => new Map([
  ['rec-1', { data: { 'field-link': value } }],
])

const queryWithEdges = (
  rows: Array<{ record_id: string; field_id: string; foreign_record_id: string }>,
): QueryFn => async () => ({ rows, rowCount: rows.length })

describe('live link projection integrity', () => {
  test('accepts the same canonical target set regardless of order', async () => {
    const query = queryWithEdges([
      { record_id: 'rec-1', field_id: 'field-link', foreign_record_id: 'target-2' },
      { record_id: 'rec-1', field_id: 'field-link', foreign_record_id: 'target-1' },
    ])
    await expect(
      isLiveLinkProjectionConsistent(query, live(['target-1', 'target-2']), new Set(['field-link'])),
    ).resolves.toBe(true)
  })

  test('rejects a missing or stale authoritative edge in either direction', async () => {
    const missing = queryWithEdges([
      { record_id: 'rec-1', field_id: 'field-link', foreign_record_id: 'target-1' },
    ])
    await expect(
      isLiveLinkProjectionConsistent(missing, live(['target-1', 'target-2']), new Set(['field-link'])),
    ).resolves.toBe(false)

    const stale = queryWithEdges([
      { record_id: 'rec-1', field_id: 'field-link', foreign_record_id: 'target-1' },
      { record_id: 'rec-1', field_id: 'field-link', foreign_record_id: 'target-2' },
    ])
    await expect(
      isLiveLinkProjectionConsistent(stale, live(['target-1']), new Set(['field-link'])),
    ).resolves.toBe(false)
  })

  test('rejects duplicate edges and malformed or duplicate JSON projections', async () => {
    const duplicateEdge = queryWithEdges([
      { record_id: 'rec-1', field_id: 'field-link', foreign_record_id: 'target-1' },
      { record_id: 'rec-1', field_id: 'field-link', foreign_record_id: 'target-1' },
    ])
    await expect(
      isLiveLinkProjectionConsistent(duplicateEdge, live(['target-1']), new Set(['field-link'])),
    ).resolves.toBe(false)

    const oneEdge = queryWithEdges([
      { record_id: 'rec-1', field_id: 'field-link', foreign_record_id: 'target-1' },
    ])
    await expect(
      isLiveLinkProjectionConsistent(oneEdge, live(['target-1', 'target-1']), new Set(['field-link'])),
    ).resolves.toBe(false)
    await expect(
      isLiveLinkProjectionConsistent(oneEdge, live(['target-1', 7]), new Set(['field-link'])),
    ).resolves.toBe(false)
  })
})
