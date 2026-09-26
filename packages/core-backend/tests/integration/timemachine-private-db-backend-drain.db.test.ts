/**
 * Behavioral proof for the private-database backend drain.
 *
 * CI: plugin-tests.yml job `test` (names `test (18.x)` and `test (20.x)`),
 * step `Run private-db backend drain proof`. The no-DB unit job excludes this
 * file so a missing DATABASE_URL cannot skip it.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import {
  assertPrivateDatabaseBackendsExited,
  type PrivateDbAdminQueryable,
} from '../../scripts/private-db-backend-drain.ts'

const dbUrl = process.env.DATABASE_URL
if (!dbUrl) {
  throw new Error('PRIVATE_DB_DRAIN_PROOF_REQUIRES_DATABASE_URL')
}

const SAFE_NAME = /^tm_drain_[a-f0-9]{12}$/

function scratchName(): string {
  const name = `tm_drain_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  if (!SAFE_NAME.test(name)) throw new Error(`PRIVATE_DB_DRAIN_NAME_UNSAFE: ${name}`)
  return name
}

function urlFor(database: string): string {
  const url = new URL(dbUrl!)
  url.pathname = `/${database}`
  return url.toString()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('private-database backend drain', () => {
  const admin = new Client({ connectionString: dbUrl })
  const created: string[] = []
  let connected = false

  async function ensureAdmin(): Promise<void> {
    if (connected) return
    await admin.connect()
    connected = true
  }

  afterAll(async () => {
    if (!connected) return
    for (const name of created) {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined)
    }
    await admin.end().catch(() => undefined)
  })

  async function createScratch(): Promise<string> {
    await ensureAdmin()
    const name = scratchName()
    await admin.query(`CREATE DATABASE "${name}"`)
    created.push(name)
    return name
  }

  it('positive: waits for a backend that exits after a short delay and returns clean', async () => {
    const name = await createScratch()
    const holder = new Client({
      connectionString: urlFor(name),
      application_name: 'tm-drain-release',
    })
    holder.on('error', () => undefined)
    await holder.connect()
    const holdMs = 1_500
    const limitMs = 8_000
    const started = Date.now()
    const released = new Promise<void>((resolve) => {
      setTimeout(() => {
        void holder.end().then(() => resolve(), () => resolve())
      }, holdMs)
    })
    await assertPrivateDatabaseBackendsExited(admin, name, {
      drainTimeoutMs: limitMs,
      pollIntervalMs: 100,
    })
    const elapsed = Date.now() - started
    await released
    expect(elapsed).toBeGreaterThanOrEqual(holdMs - 250)
    expect(elapsed).toBeLessThan(limitMs)
  })

  it('negative: fails when a backend is still held, with values-free identifiers and no query text', async () => {
    const name = await createScratch()
    const marker = `LEAKMARKER${randomUUID().replace(/-/g, '')}`
    const holder = new Client({
      connectionString: urlFor(name),
      application_name: 'tm-drain-hold',
    })
    holder.on('error', () => undefined)
    await holder.connect()
    const inflight = holder.query(`SELECT pg_sleep(30) /* ${marker} */`).catch(() => undefined)
    try {
      const readyDeadline = Date.now() + 2_000
      let ready = false
      while (Date.now() < readyDeadline) {
        const seen = await admin.query(
          'SELECT state FROM pg_stat_activity WHERE datname = $1 AND application_name = $2',
          [name, 'tm-drain-hold'],
        )
        if (seen.rows.some((row: { state?: string }) => row.state === 'active')) {
          ready = true
          break
        }
        await sleep(50)
      }
      expect(ready).toBe(true)

      const issued: string[] = []
      const proxy: PrivateDbAdminQueryable = {
        async query(text: string, values?: unknown[]) {
          issued.push(text)
          return admin.query(text, values)
        },
      }
      let caught: unknown = null
      try {
        await assertPrivateDatabaseBackendsExited(proxy, name, {
          drainTimeoutMs: 400,
          pollIntervalMs: 50,
        })
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(Error)
      const message = (caught as Error).message
      expect(message).toContain('private database backends remain after 400ms:')
      expect(message).toMatch(/pid=\d+/)
      expect(message).toMatch(/backend_type=client backend/)
      expect(message).toMatch(/state=active/)
      expect(message).toMatch(/application_name=tm-drain-hold/)
      expect(message).toMatch(/backend_start=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
      expect(message).not.toContain(marker)
      expect(message).not.toContain('pg_sleep')
      expect(message).not.toContain('SELECT')
      expect(message).not.toContain('usename')
      expect(message).not.toMatch(/\bquery=/)
      expect(issued.length).toBeGreaterThan(0)
      for (const sql of issued) {
        expect(sql.toLowerCase()).not.toContain('usename')
        expect(sql.toLowerCase()).not.toContain('query')
      }
    } finally {
      await holder.end().catch(() => undefined)
      await inflight
    }
  })
})
