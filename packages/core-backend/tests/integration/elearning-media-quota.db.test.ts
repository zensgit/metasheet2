/**
 * Real-Postgres race for reserveElearningMediaQuotaAndInsert.
 * DATABASE_URL is required. A missing URL throws (refuses skip-shaped green).
 *
 * Shared after-SUM-read barrier: each txn runs the real SUM, then afterRead().
 * arrivals==2 releases waiters; otherwise a ~150ms timeout lets the locked
 * first txn commit while the second is still parked on pg_advisory_xact_lock.
 * Removing the lock makes both SUM 60 before either INSERT.
 */
import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { expect, it } from 'vitest'
import {
  ElearningMediaQuotaError,
  reserveElearningMediaQuotaAndInsert,
  type ElearningMediaDb,
  type ElearningMediaInsertRow,
  type ElearningMediaQueryable,
} from '../../src/services/elearning-media-quota'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'elearning media quota reservation requires DATABASE_URL; refusing skip-shaped green',
  )
}

const AFTER_SUM_BARRIER_TIMEOUT_MS = 150

function createAfterSumReadBarrier() {
  let arrivals = 0
  let releaseArrivals!: () => void
  const releasePromise = new Promise<void>((resolve) => {
    releaseArrivals = resolve
  })
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>()

  return {
    get arrivals() {
      return arrivals
    },
    async afterRead() {
      arrivals += 1
      if (arrivals === 2) {
        releaseArrivals()
        return
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          releasePromise,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, AFTER_SUM_BARRIER_TIMEOUT_MS)
            pendingTimers.add(timer)
          }),
        ])
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer)
          pendingTimers.delete(timer)
        }
      }
    },
    cleanup() {
      for (const timer of pendingTimers) clearTimeout(timer)
      pendingTimers.clear()
      releaseArrivals()
    },
  }
}

async function exec(target: Pool | PoolClient, sql: string, params?: unknown[]) {
  const result = await target.query(sql, params as never)
  return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
}

class PgElearningMediaDb implements ElearningMediaDb {
  constructor(
    private readonly pool: Pool,
    private readonly barrier: { afterRead(): Promise<void> },
  ) {}

  query(sql: string, params?: unknown[]) {
    return exec(this.pool, sql, params)
  }

  async transaction<T>(handler: (tx: ElearningMediaQueryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      try {
        const value = await handler({
          query: async (sql, params) => {
            const result = await exec(client, sql, params)
            if (sql.includes('SUM(size_bytes)')) {
              await this.barrier.afterRead()
            }
            return result
          },
        })
        await client.query('COMMIT')
        return value
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      }
    } finally {
      client.release()
    }
  }
}

function mediaRow(orgId: string, id: string, sizeBytes: number): ElearningMediaInsertRow {
  return {
    id,
    orgId,
    storageKey: `elearning-media/2026-08/${id}.mp4`,
    mimeType: 'video/mp4',
    magicMimeType: 'video/mp4',
    sizeBytes,
    sha256: 'sha256-placeholder',
    createdBy: 'quota-db-test',
  }
}

it('serializes concurrent quota reservations so one insert wins and active sum is 90', async () => {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 })
  const barrier = createAfterSumReadBarrier()
  const db = new PgElearningMediaDb(pool, barrier)
  const orgId = randomUUID()
  try {
    const seed = mediaRow(orgId, randomUUID(), 60)
    await pool.query(
      `INSERT INTO elearning_media (
         id, org_id, storage_key, mime_type, magic_mime_type, size_bytes, sha256, duration_ms, status, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 'uploading', $8)`,
      [
        seed.id,
        seed.orgId,
        seed.storageKey,
        seed.mimeType,
        seed.magicMimeType,
        seed.sizeBytes,
        seed.sha256,
        seed.createdBy,
      ],
    )

    const results = await Promise.allSettled([
      reserveElearningMediaQuotaAndInsert(db, mediaRow(orgId, randomUUID(), 30), 100),
      reserveElearningMediaQuotaAndInsert(db, mediaRow(orgId, randomUUID(), 30), 100),
    ])
    expect(barrier.arrivals).toBe(2)
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ElearningMediaQuotaError)

    const used = await pool.query(
      `SELECT COALESCE(SUM(size_bytes), 0)::text AS used
         FROM elearning_media
        WHERE org_id = $1
          AND status IN ('uploading', 'probing', 'ready')`,
      [orgId],
    )
    expect(Number(used.rows[0]?.used)).toBe(90)
  } finally {
    barrier.cleanup()
    try {
      await pool.query('DELETE FROM elearning_media WHERE org_id = $1', [orgId])
    } finally {
      await pool.end()
    }
  }
})
