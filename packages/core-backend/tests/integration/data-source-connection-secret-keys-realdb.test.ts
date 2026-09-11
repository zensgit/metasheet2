/**
 * #5621 real-Postgres lane: the `connection.password` refusal and the legacy-row strip, against the
 * actual `data_sources` table.
 *
 * The unit spec (tests/unit/data-source-connection-secret-keys.test.ts) proves the behaviour with a
 * fake Kysely. This one proves the two claims the fake CANNOT:
 *   1. ZERO LANDING is a property of the TABLE, not of a mock — a refused create leaves no row.
 *   2. The legacy row it reads is a REAL row of the shipped schema, and the STORED value stays put
 *      (this cut changes the echo only; removing stored plaintext is the migration ticket) — the
 *      inventory query in
 *      docs/development/data-source-connection-secret-keys-design-20260912.md is executed here so
 *      the doc's SQL cannot rot, and it counts rows WITHOUT ever selecting a secret value.
 *
 * Real-DB gate: runs only where DATABASE_URL is configured (CI plugin-tests.yml enumerates it, and
 * that runner asserts DATABASE_URL is present, so it cannot silently skip in CI).
 */
import express from 'express'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DATA_SOURCE_CONNECTION_SECRET_REJECTED_CODE,
} from '../../src/data-adapters/data-source-secret-keys'
import { dataSourcesRouter, initializeDataSourceManager } from '../../src/routes/data-sources'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const SUFFIX = `${process.pid}_${Date.now()}`
const OWNER_ID = `dscs-realdb-owner-${SUFFIX}`
const TENANT_ID = `dscs-realdb-tenant-${SUFFIX}`
const LEGACY_ID = `dscs_realdb_legacy_${SUFFIX}`
const REFUSED_ID = `dscs_realdb_refused_${SUFFIX}`
const ACCEPTED_ID = `dscs_realdb_accepted_${SUFFIX}`
const LEGACY_SECRET = `POISON-realdb-legacy-${SUFFIX}`
const SUBMITTED_SECRET = `POISON-realdb-submitted-${SUFFIX}`

function appAsOwner() {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    // Same actor shape as data-source-test-ephemeral-realdb.test.ts:18. `rbacGuard('data_sources', …)`
    // short-circuits a global admin; a non-admin goes to the DB fallback, which ignores
    // `req.user.permissions` and finds no `data_sources:*` codes on this branch (they are seeded by
    // #5611, not merged). Everything under test here sits AFTER that guard (the refusal runs after
    // rbacGuard and before Zod; the strip is on the read side), so admin keeps the intent intact.
    // OWNER_ID is kept so `assertAccess`'s owner-equality still holds for the seeded legacy row.
    req.user = { id: OWNER_ID, role: 'admin' } as never
    // The create route trusts ONLY the verified-JWT tenant claim.
    req.authenticatedTenantId = TENANT_ID
    next()
  })
  a.use(dataSourcesRouter())
  return a
}

describeIfDatabase('#5621 connection secrets — real Postgres', () => {
  let pool: Pool
  let db: Kysely<unknown>

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
    // A row exactly as a pre-fix API call left it: the password sits in plaintext under
    // config->connection, because configToRecord only ever encrypted config->credentials.
    await pool.query(
      `INSERT INTO data_sources (id, name, type, config, status, owner_id, workspace_id, tenant_id,
                                 scope_kind, is_active, auto_connect)
       VALUES ($1, $2, 'postgres', $3::jsonb, 'disconnected', $4, NULL, $5, 'private', true, false)`,
      [
        LEGACY_ID,
        LEGACY_ID,
        JSON.stringify({
          connection: { host: '127.0.0.1', port: 5432, database: 'plm', password: LEGACY_SECRET },
          credentials: { username: 'legacy-user' },
          options: { autoConnect: false },
        }),
        OWNER_ID,
        TENANT_ID,
      ],
    )
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    // Binds the route singleton to the real table AND loads the seeded legacy row. Nothing dials:
    // auto_connect is false and none of the assertions below hit a connect path.
    await initializeDataSourceManager(db)
  })

  afterAll(async () => {
    await pool.query('DELETE FROM data_sources WHERE id = ANY($1::text[])', [
      [LEGACY_ID, REFUSED_ID, ACCEPTED_ID],
    ])
    await db.destroy() // closes the shared pool
  })

  it('POST /api/data-sources with connection.password => coded 400 and NO row lands in data_sources', async () => {
    const res = await request(appAsOwner()).post('/api/data-sources').send({
      id: REFUSED_ID,
      name: REFUSED_ID,
      type: 'postgres',
      connection: { host: '127.0.0.1', port: 5432, database: 'plm', password: SUBMITTED_SECRET },
      options: { autoConnect: false },
    })
    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body.error.code).toBe(DATA_SOURCE_CONNECTION_SECRET_REJECTED_CODE)
    expect(JSON.stringify(res.body)).not.toContain(SUBMITTED_SECRET)

    const landed = await pool.query('SELECT count(*)::int AS n FROM data_sources WHERE id = $1', [REFUSED_ID])
    expect(landed.rows[0].n).toBe(0)
  })

  it('the supported shape still lands, with the secret encrypted under credentials and absent from connection', async () => {
    const res = await request(appAsOwner()).post('/api/data-sources').send({
      id: ACCEPTED_ID,
      name: ACCEPTED_ID,
      type: 'postgres',
      connection: { host: '127.0.0.1', port: 5432, database: 'plm' },
      credentials: { username: 'svc_reader', password: SUBMITTED_SECRET },
      options: { autoConnect: false },
    })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data.hasCredentials).toBe(true)
    expect(JSON.stringify(res.body)).not.toContain(SUBMITTED_SECRET)

    const stored = await pool.query(
      `SELECT (config->'connection' ? 'password') AS conn_has_password,
              left(config->'credentials'->>'password', 4) AS cred_prefix
         FROM data_sources WHERE id = $1`,
      [ACCEPTED_ID],
    )
    expect(stored.rows[0].conn_has_password).toBe(false)
    expect(stored.rows[0].cred_prefix).toBe('enc:')
  })

  it('GET /api/data-sources/:id on the LEGACY row strips the stored secret while the row keeps it', async () => {
    const res = await request(appAsOwner()).get(`/api/data-sources/${LEGACY_ID}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.connection.host).toBe('127.0.0.1') // non-secret keys survive
    expect(res.body.data.connection.password).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain(LEGACY_SECRET)

    // SCOPE PIN: storage is deliberately untouched by this cut.
    const stillStored = await pool.query(
      `SELECT (config->'connection' ? 'password') AS conn_has_password FROM data_sources WHERE id = $1`,
      [LEGACY_ID],
    )
    expect(stillStored.rows[0].conn_has_password).toBe(true)
  })

  it('the design docs inventory query runs on the shipped schema and counts WITHOUT selecting a value', async () => {
    // Verbatim from docs/development/data-source-connection-secret-keys-design-20260912.md.
    const inventory = await pool.query(`
      SELECT count(*)::int AS affected_rows
        FROM data_sources ds
       WHERE EXISTS (
               SELECT 1
                 FROM jsonb_object_keys(COALESCE(ds.config->'connection', '{}'::jsonb)) AS k
                WHERE lower(regexp_replace(k, '[^A-Za-z0-9]', '', 'g'))
                      ~ '(password|passwd|pwd|passphrase|secret|token|credential|apikey|accesskey|privatekey|authorization)'
             )
    `)
    expect(inventory.rows[0].affected_rows).toBeGreaterThanOrEqual(1) // the legacy row seeded above
  })
})
