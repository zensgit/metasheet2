/**
 * Real-Postgres proof that reconcileStaleElearningMediaRows' CTE uses
 * FOR UPDATE SKIP LOCKED. DATABASE_URL is required. A missing URL throws
 * (refuses skip-shaped green).
 *
 * Connection A row-locks one namespaced stale uploading/probing row.
 * Pool B must return promptly with claimed=0; after A releases, the next
 * claim returns exactly that row once; a subsequent claim returns 0.
 */
import { randomUUID } from 'node:crypto'
import { Client, Pool } from 'pg'
import { expect, it } from 'vitest'
import type { ElearningMediaQueryable } from '../../src/services/elearning-media-quota'
import {
  ELEARNING_MEDIA_STALE_MS,
  reconcileStaleElearningMediaRows,
} from '../../src/services/elearning-media-reconciler'
import type { ElearningMediaStore } from '../../src/services/elearning-media-storage'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'elearning media reconciler requires DATABASE_URL; refusing skip-shaped green',
  )
}

const FILE_NS = 'elrn-media-reconciler-db'
const CREATED_BY = `${FILE_NS}-created-by`
const SHARED_UNIT_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
]
const VALUES_FREE_LEAK = /postgresql:\/\/|postgres:\/\/|\b(?:\d{1,3}\.){3}\d{1,3}\b|authorityCode|appKey|AKIA[A-Z0-9]{8,}/i
const LOCK_TIMEOUT_MS = 400
const SKIP_LOCKED_BUDGET_MS = 1000

function asQueryable(target: Pool): ElearningMediaQueryable {
  return {
    query: async (sql, params) => {
      const result = await target.query(sql, params as never)
      return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
    },
  }
}

function memoryStore(): ElearningMediaStore & { deleted: string[] } {
  const deleted: string[] = []
  return {
    deleted,
    put: async () => undefined,
    get: async () => Buffer.from('x'),
    delete: async (storageKey) => {
      deleted.push(storageKey)
      return true
    },
  }
}

it('SKIP LOCKED skips a held stale row then claims it exactly once after release', async () => {
  const locker = new Client({ connectionString: DATABASE_URL })
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1 })
  const orgId = `${FILE_NS}/${randomUUID()}`
  const id = randomUUID()
  const storageKey = `elearning-media/2026-08/${id}.mp4`
  const store = memoryStore()
  const now = new Date()
  const cutoff = new Date(now.getTime() - ELEARNING_MEDIA_STALE_MS)
  let lockerConnected = false
  try {
    expect(SHARED_UNIT_IDS.includes(id)).toBe(false)
    expect(orgId.startsWith(`${FILE_NS}/`)).toBe(true)
    expect(CREATED_BY).not.toBe('quota-db-test')

    await locker.connect()
    lockerConnected = true

    const others = await pool.query(
      `SELECT id
         FROM elearning_media
        WHERE status IN ('uploading', 'probing')
          AND updated_at <= $1::timestamptz
          AND org_id <> $2
        LIMIT 1`,
      [cutoff.toISOString(), orgId],
    )
    if (others.rows.length > 0) {
      throw new Error(
        'elearning media reconciler db test found non-namespaced stale rows; refusing contaminated proof',
      )
    }

    await pool.query(
      `INSERT INTO elearning_media (
         id, org_id, storage_key, mime_type, magic_mime_type, size_bytes, sha256, duration_ms, status, created_by, updated_at
       ) VALUES ($1, $2, $3, 'video/mp4', 'video/mp4', 1024, 'sha256-placeholder', NULL, 'uploading', $4, $5::timestamptz)`,
      [id, orgId, storageKey, CREATED_BY, new Date(now.getTime() - ELEARNING_MEDIA_STALE_MS - 60_000).toISOString()],
    )

    await locker.query('BEGIN')
    const locked = await locker.query(
      'SELECT id FROM elearning_media WHERE id = $1::uuid FOR UPDATE',
      [id],
    )
    expect(locked.rowCount).toBe(1)
    expect(locked.rows).toHaveLength(1)

    await pool.query(`SET lock_timeout = '${LOCK_TIMEOUT_MS}ms'`)
    const db = asQueryable(pool)
    const started = Date.now()
    const skipped = await reconcileStaleElearningMediaRows(db, store, { now: () => now, batchSize: 1 })
    const elapsedMs = Date.now() - started
    expect(elapsedMs).toBeLessThan(SKIP_LOCKED_BUDGET_MS)
    expect(skipped).toEqual({ claimed: 0, deleted: 0, deleteFailed: 0 })
    expect(store.deleted).toEqual([])
    expect(JSON.stringify(skipped)).not.toMatch(VALUES_FREE_LEAK)
    expect(JSON.stringify(skipped)).not.toContain(storageKey)
    expect(JSON.stringify(skipped)).not.toContain(orgId)

    const stillUploading = await pool.query(
      'SELECT status FROM elearning_media WHERE id = $1::uuid AND org_id = $2',
      [id, orgId],
    )
    expect(stillUploading.rows[0]?.status).toBe('uploading')

    await locker.query('COMMIT')

    const claimed = await reconcileStaleElearningMediaRows(db, store, { now: () => now, batchSize: 1 })
    expect(claimed).toEqual({ claimed: 1, deleted: 1, deleteFailed: 0 })
    expect(store.deleted).toEqual([storageKey])
    expect(JSON.stringify(claimed)).not.toMatch(VALUES_FREE_LEAK)
    expect(JSON.stringify(claimed)).not.toContain(storageKey)
    expect(Object.keys(claimed).sort()).toEqual(['claimed', 'deleteFailed', 'deleted'])

    const rejected = await pool.query(
      'SELECT status FROM elearning_media WHERE id = $1::uuid AND org_id = $2',
      [id, orgId],
    )
    expect(rejected.rows[0]?.status).toBe('rejected')

    const again = await reconcileStaleElearningMediaRows(db, store, { now: () => now, batchSize: 1 })
    expect(again).toEqual({ claimed: 0, deleted: 0, deleteFailed: 0 })
    expect(store.deleted).toEqual([storageKey])
  } finally {
    if (lockerConnected) {
      try {
        await locker.query('ROLLBACK')
      } catch {
        /* already committed or closed */
      }
    }
    try {
      await locker.end()
    } finally {
      try {
        await pool.query('DELETE FROM elearning_media WHERE org_id = $1', [orgId])
      } finally {
        await pool.end()
      }
    }
  }
})
