import express from 'express'
import { Pool } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { dataSourcesRouter, getDataSourceManager } from '../../src/routes/data-sources'

// Real-DB gate: runs only where DATABASE_URL is configured (CI plugin-tests.yml). The enumerated
// runner asserts DATABASE_URL is present, so this suite cannot silently skip in CI.
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const OWNER = 'eph-realdb-owner'
const BAD_SECRET = 'definitely-not-the-real-password-2026'

function appAs(userId: string) {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => { req.user = { id: userId, role: 'admin' } as never; next() })
  a.use(dataSourcesRouter())
  return a
}

function liveConnection(databaseUrl: string): { connection: Record<string, unknown>; credentials: Record<string, string> } {
  const parsed = new URL(databaseUrl)
  const credentials: Record<string, string> = {}
  if (parsed.username) credentials.username = decodeURIComponent(parsed.username)
  if (parsed.password) credentials.password = decodeURIComponent(parsed.password)
  return {
    connection: {
      host: parsed.hostname || 'localhost',
      port: parsed.port ? Number(parsed.port) : 5432,
      database: parsed.pathname.replace(/^\//, ''),
    },
    credentials,
  }
}

describeIfDatabase('POST /api/data-sources/test — ephemeral connection test (real Postgres)', () => {
  let pool: Pool

  beforeAll(() => { pool = new Pool({ connectionString: process.env.DATABASE_URL }) })
  afterAll(async () => { if (pool) await pool.end() })

  it('returns success + latency against the live database', async () => {
    const live = liveConnection(process.env.DATABASE_URL!)
    const res = await request(appAs(OWNER)).post('/api/data-sources/test').send({
      id: 'eph_live_ok', name: 'Live OK', type: 'postgresql', ...live,
      options: { readOnly: true },
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.success).toBe(true)
    expect(res.body.data.latency).toMatch(/ms$/)
    expect(res.body.data.error).toBeUndefined()
  })

  it('returns success:false with a cause for an unreachable target, leaking no secret', async () => {
    const res = await request(appAs(OWNER)).post('/api/data-sources/test').send({
      id: 'eph_live_fail', name: 'Live Fail', type: 'postgresql',
      connection: { host: '127.0.0.1', port: 1, database: 'nope' }, // ECONNREFUSED, deterministic
      credentials: { username: 'u', password: BAD_SECRET },
    })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)            // request completed
    expect(res.body.data.success).toBe(false) // connection failed
    expect(res.body.data.error?.message).toBeTruthy()
    expect(JSON.stringify(res.body)).not.toContain(BAD_SECRET) // no credential echo / leak
  })

  it('persists nothing — data_sources row count unchanged, source never registered (404)', async () => {
    const before = (await pool.query('SELECT count(*)::int AS n FROM data_sources')).rows[0].n as number

    const live = liveConnection(process.env.DATABASE_URL!)
    await request(appAs(OWNER)).post('/api/data-sources/test').send({
      id: 'eph_nopersist_live', name: 'No Persist', type: 'postgresql', ...live,
      options: { readOnly: true },
    }).expect(200)

    const after = (await pool.query('SELECT count(*)::int AS n FROM data_sources')).rows[0].n as number
    expect(after).toBe(before) // zero persistence: no row written

    // Definitive no-persist proof: addDataSource is the ONLY path that writes data_sources and it
    // ALWAYS registers the adapter/scope in memory first — so an absent in-memory registration proves
    // the route never persisted.
    const manager = getDataSourceManager()
    expect(manager.listDataSources({ ownerId: OWNER }).some(s => s.id === 'eph_nopersist_live')).toBe(false)
    const got = await request(appAs(OWNER)).get('/api/data-sources/eph_nopersist_live')
    expect(got.status).toBe(404)
  })
})
