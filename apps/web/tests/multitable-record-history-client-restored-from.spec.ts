// OD-W2-5a client golden: the two history read-path fetchers must pass the R11 restore
// back-reference (restoredFromVersion) through their normalizers.
//
// This is the CLIENT tier of the owner-mandated API/client/component golden triple, and it
// specifically pins the half-wire that component tests could not catch: MetaRecordHistoryPanel /
// HistoryCenterModal specs inject already-shaped objects, so a normalizer that DROPPED the field
// still rendered a badge in-component while the real wire went blank. Here we feed a RAW server
// payload through the public fetcher and assert the normalized value survives.
//
// Positive: a numeric restoredFromVersion on the wire → preserved.
// Negative: absent / non-number restoredFromVersion → coerced to null (badge keys on non-null).
import { describe, expect, it, vi } from 'vitest'
import { MultitableApiClient } from '../src/multitable/api/client'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('OD-W2-5a — record-history read fetchers pass restoredFromVersion through the client normalizers', () => {
  describe('listRecordHistory → normalizeRecordHistoryEntry (inspector history tab)', () => {
    it('preserves a numeric restoredFromVersion from the raw wire payload', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        json({
          ok: true,
          data: {
            items: [
              { id: 'rev_2', sheetId: 's1', recordId: 'r1', version: 2, action: 'update', restoredFromVersion: 1 },
              { id: 'rev_1', sheetId: 's1', recordId: 'r1', version: 1, action: 'create' },
            ],
          },
        }),
      )
      const client = new MultitableApiClient({ fetchFn })
      const rows = await client.listRecordHistory('s1', 'r1')
      expect(rows.find((r) => r.version === 2)?.restoredFromVersion).toBe(1)
      // NEG in the same wire: an entry with no restoredFromVersion → null, not undefined.
      expect(rows.find((r) => r.version === 1)?.restoredFromVersion).toBeNull()
    })

    it('coerces a non-number restoredFromVersion (e.g. a stringified value) to null', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        json({
          ok: true,
          data: {
            items: [
              { id: 'rev_9', sheetId: 's1', recordId: 'r1', version: 9, action: 'update', restoredFromVersion: '3' },
            ],
          },
        }),
      )
      const client = new MultitableApiClient({ fetchFn })
      const rows = await client.listRecordHistory('s1', 'r1')
      expect(rows[0]?.restoredFromVersion).toBeNull()
    })
  })

  describe('getHistoryBatch → normalizeHistoryChange (base History Center)', () => {
    it('preserves a numeric restoredFromVersion on a change, and nulls an absent one', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        json({
          ok: true,
          data: {
            batchId: 'bat_1',
            source: 'rest',
            createdAt: '2026-07-16T00:00:00.000Z',
            changes: [
              { sheetId: 's1', recordId: 'r1', action: 'update', version: 5, restoredFromVersion: 2 },
              { sheetId: 's1', recordId: 'r1', action: 'update', version: 4 },
            ],
          },
        }),
      )
      const client = new MultitableApiClient({ fetchFn })
      const detail = await client.getHistoryBatch('b1', 'bat_1')
      expect(detail?.changes.find((c) => c.version === 5)?.restoredFromVersion).toBe(2)
      expect(detail?.changes.find((c) => c.version === 4)?.restoredFromVersion).toBeNull()
    })
  })
})
