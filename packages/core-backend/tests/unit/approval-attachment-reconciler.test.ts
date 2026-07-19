/**
 * Attachment slice ⑥ — bucket-reconciler GRACE-WINDOW goldens (G15, §7). Pure unit lane (fake db) so
 * the load-bearing "an in-flight upload's blob is NEVER purged" invariant runs in the always-on
 * required lane and is mutation-provable without a real DB.
 */
import { describe, expect, test } from 'vitest'

import {
  bindAttachmentsOnSubmit,
  reconcileBucket,
  RECONCILER_ORPHAN_GRACE_MS,
  type ReconcilerBlob,
} from '../../src/services/approval-attachment-reconciler'

/** Minimal Queryable stub: serves the row snapshot on SELECT, records enqueued keys on INSERT. */
function fakeDb(rows: Array<{ storage_key: string; status: string }>) {
  const enqueued: string[] = []
  const db = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('SELECT storage_key, status')) return { rows, rowCount: rows.length }
      if (sql.includes('INSERT INTO approval_attachment_purge_intents')) {
        enqueued.push(String(params?.[0]))
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
  }
  return { db, enqueued }
}

const OLD = RECONCILER_ORPHAN_GRACE_MS + 60_000 // comfortably past the grace window
const YOUNG = RECONCILER_ORPHAN_GRACE_MS - 60_000 // still inside the grace window (mid-upload/commit)

describe('reconciler grace window (G15)', () => {
  test('an orphan blob OLDER than the grace window is enqueued for purge', async () => {
    const { db, enqueued } = fakeDb([]) // no rows at all
    const blobs: ReconcilerBlob[] = [{ key: 'approval/2026-07/orphan', ageMs: OLD }]
    const r = await reconcileBucket(db, async () => blobs)
    expect(r.orphanBlobsQueued).toBe(1)
    expect(enqueued).toContain('approval/2026-07/orphan')
  })

  test('POSITIVE CONTROL: an in-flight upload YOUNGER than the grace window is NEVER purged', async () => {
    // The upload path is store.put(blob) THEN INSERT row: a blob with no row that is younger than the
    // grace window is a normal upload mid-commit, not an orphan. Purging it would be silent data loss.
    const { db, enqueued } = fakeDb([]) // row not yet committed
    const blobs: ReconcilerBlob[] = [{ key: 'approval/2026-07/inflight', ageMs: YOUNG }]
    const r = await reconcileBucket(db, async () => blobs)
    expect(r.orphanBlobsQueued).toBe(0)
    expect(enqueued).toEqual([]) // the just-uploaded blob is left alone
  })

  test('POSITIVE CONTROL: a committed row’s blob is never enqueued, regardless of age', async () => {
    const { db, enqueued } = fakeDb([{ storage_key: 'approval/2026-07/committed', status: 'unbound' }])
    const blobs: ReconcilerBlob[] = [{ key: 'approval/2026-07/committed', ageMs: OLD }]
    const r = await reconcileBucket(db, async () => blobs)
    expect(r.orphanBlobsQueued).toBe(0)
    expect(enqueued).toEqual([])
  })

  test('a live row whose blob vanished is SURFACED (missingBlobs), never deleted', async () => {
    const { db, enqueued } = fakeDb([{ storage_key: 'approval/2026-07/lost', status: 'bound' }])
    const r = await reconcileBucket(db, async () => []) // bucket empty
    expect(r.missingBlobs).toContain('approval/2026-07/lost')
    expect(enqueued).toEqual([]) // never enqueues a missing-blob's key
  })

  test('a custom graceMs is honored; a negative graceMs is rejected', async () => {
    const { db, enqueued } = fakeDb([])
    const blobs: ReconcilerBlob[] = [{ key: 'k', ageMs: 5_000 }]
    // with a 1s grace, a 5s-old orphan IS past grace
    expect((await reconcileBucket(db, async () => blobs, { graceMs: 1_000 })).orphanBlobsQueued).toBe(1)
    expect(enqueued).toContain('k')
    await expect(reconcileBucket(db, async () => blobs, { graceMs: -1 })).rejects.toThrow(/non-negative/)
  })
})

describe('bindAttachmentsOnSubmit — infected never binds (G4 / §6)', () => {
  test('infected row is excluded from bind UPDATE; whole submit fails; clean positive control binds', async () => {
    let lastSql = ''
    let lastParams: unknown[] = []
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        lastSql = sql
        lastParams = params ?? []
        if (sql.includes('UPDATE approval_attachments')) {
          // Simulate infected exclusion: 0 rows when the SQL carries the infected guard
          expect(sql).toMatch(/scan_state/)
          expect(sql).toMatch(/infected/)
          return { rows: [], rowCount: 0 }
        }
        if (sql.includes('sum(size_bytes)')) return { rows: [{ t: '0' }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      },
    }
    await expect(bindAttachmentsOnSubmit(db, 'u1', 'inst_1', { fld: ['att_infected'] })).rejects.toThrow(
      /0\/1.*rejected/,
    )
    expect(lastSql).toMatch(/scan_state/)

    // Positive control: when UPDATE returns 1, bind succeeds
    const okDb = {
      query: async (sql: string) => {
        if (sql.includes('UPDATE approval_attachments')) return { rows: [], rowCount: 1 }
        if (sql.includes('sum(size_bytes)')) return { rows: [{ t: '100' }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      },
    }
    expect(await bindAttachmentsOnSubmit(okDb, 'u1', 'inst_1', { fld: ['att_clean'] })).toEqual({ bound: 1 })
  })

  test('per-field cap 10 and submission 50MB are enforced at bind', async () => {
    const db = { query: async () => ({ rows: [{ t: '0' }], rowCount: 0 }) }
    const eleven = Array.from({ length: 11 }, (_, i) => `att_${i}`)
    await expect(bindAttachmentsOnSubmit(db, 'u1', 'inst', { fld: eleven })).rejects.toThrow(/per-field cap/)

    const overBytes = {
      query: async (sql: string) => {
        if (sql.includes('UPDATE')) return { rows: [], rowCount: 1 }
        if (sql.includes('sum(size_bytes)')) return { rows: [{ t: String(50 * 1024 * 1024 + 1) }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      },
    }
    await expect(bindAttachmentsOnSubmit(overBytes, 'u1', 'inst', { fld: ['att_1'] })).rejects.toThrow(
      /total-bytes cap/,
    )
  })
})

