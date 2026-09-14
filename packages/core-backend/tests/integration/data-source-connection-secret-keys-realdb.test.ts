/**
 * #5621 real-Postgres lane: the `connection.password` refusal and the legacy-row strip, against the
 * actual `data_sources` table.
 *
 * The unit spec (tests/unit/data-source-connection-secret-keys.test.ts) proves the behaviour with a
 * fake Kysely. This one proves the claims the fake CANNOT:
 *   1. ZERO LANDING is a property of the TABLE, not of a mock — a refused create leaves no row.
 *   2. The legacy row it reads is a REAL row of the shipped schema, and the STORED value stays put
 *      (this cut changes the echo only; removing stored plaintext is the migration ticket) — the
 *      inventory query in
 *      docs/development/data-source-connection-secret-keys-design-20260912.md is executed here so
 *      the doc's SQL cannot rot, and it counts rows WITHOUT ever selecting a secret value.
 *   3. (F11) That inventory SQL now uses the SAME vocabulary the write entry refuses by. It used to
 *      be the #5648 word list against TOP-LEVEL `config->'connection'` only, so the application
 *      refused strictly MORE keys than the inventory could find and the inventory UNDER-REPORTED —
 *      an under-report is the one error mode a migration ticket must not have (rows nobody counted
 *      are rows nobody cleans). INVENTORY_SQL below carries the F03 word list (`pswd`, `passcode`,
 *      and the glued `(qualifier)?(pass|pw)` rule) and also walks `{connection,headers}`; the
 *      #5648 text is kept as INVENTORY_SQL_5648 purely as the CONTRAST both are run against.
 *
 * Real-DB gate: runs only where DATABASE_URL is configured. In CI that is the standalone lane
 * .github/workflows/data-source-connection-secret-keys-realdb.yml (NOT plugin-tests.yml, which is
 * an s6a-pinned file this PR leaves byte-identical); the lane sets EXPECT_DB=1, which arms the
 * sentinel below so a lane run with a missing/broken DATABASE_URL goes RED instead of reporting the
 * whole file as skipped-green.
 */
import * as fs from 'fs'
import * as path from 'path'

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

// Anti-skip-green sentinel, same shape as tests/integration/approval-can-decide-current-node.db.test.ts:50-53.
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const SUFFIX = `${process.pid}_${Date.now()}`
const OWNER_ID = `dscs-realdb-owner-${SUFFIX}`
const TENANT_ID = `dscs-realdb-tenant-${SUFFIX}`
const LEGACY_ID = `dscs_realdb_legacy_${SUFFIX}`
const REFUSED_ID = `dscs_realdb_refused_${SUFFIX}`
const ACCEPTED_ID = `dscs_realdb_accepted_${SUFFIX}`
const GLUED_ID = `dscs_realdb_glued_${SUFFIX}`
const NESTED_ID = `dscs_realdb_nested_${SUFFIX}`
const BENIGN_ID = `dscs_realdb_benign_${SUFFIX}`
const LEGACY_SECRET = `POISON-realdb-legacy-${SUFFIX}`
const SUBMITTED_SECRET = `POISON-realdb-submitted-${SUFFIX}`
const GLUED_SECRET = `POISON-realdb-glued-${SUFFIX}`
const NESTED_SECRET = `POISON-realdb-nested-${SUFFIX}`

/**
 * THE inventory SQL of the migration ticket, executed here VERBATIM so it cannot rot (F11).
 *
 * Shared-source rule: this string is byte-identical to the `B` block of
 * docs/development/data-source-connection-secret-keys-design-20260912.md §5 — the doc block adds the
 * statement-terminating `;` and nothing else, which `the design doc §5 B block …` below pins by
 * asserting the doc contains `INVENTORY_SQL + ';'`. Edit one and that test goes red until the other
 * follows. The `;` lives in the doc (a block a human pastes into psql) and not in the constant
 * because the constant is ALSO run through `scopeToIds`, which splices a row filter into it.
 *
 * Alignment with the application predicate (src/data-adapters/data-source-secret-keys.ts):
 *   - first branch = the SUBSTRING words of DATA_SOURCE_SECRET_KEY_WORDS, F03 included
 *     (`pswd`, `passcode`) — the #5648 text had neither;
 *   - second branch = `<SECRET_GLUED>`, the SQL-side approximation of the `wholeTokenOnly` words
 *     `pass`/`pw` plus GLUED_KEY_QUALIFIERS, anchored `^…$` so `dbpass`/`rootpw` count while
 *     `bypass`/`compass`/`passive` do not (pinned by the BENIGN row below);
 *   - the VALUES path table adds `{connection,headers}`, where a STORED row can hold a live
 *     credential (PLMAdapter injects its Bearer there at runtime); the #5648 text saw top level only.
 * Only the SHIPPED column shape is covered here — `config jsonb`, which is what this file seeds and
 * what every application read/write uses. The second DDL in the repo (`migrations/040_data_sources.sql`,
 * a standalone `connection JSONB` column) is not exercised by any test; its variant of this query
 * stays in the doc under B2, unexecuted and labelled as such.
 * KNOWN UNDER-REPORTS (unchanged by F11, listed in design §5): SQL does not split camel tokens
 * (`passThroughMode`/`passHash` hit the application predicate, not this query), does not descend
 * into arrays, and does not NFKC-fold (fullwidth `ｐａｓｓｗｏｒｄ` is invisible to it).
 */
const INVENTORY_SQL = `SELECT count(*)::int AS affected_rows
  FROM data_sources ds
 WHERE EXISTS (
         SELECT 1
           FROM (VALUES ('{connection}'::text[]),
                        ('{connection,headers}'::text[])
                ) AS p(path)
           CROSS JOIN LATERAL jsonb_object_keys(
                 CASE WHEN jsonb_typeof(ds.config #> p.path) = 'object'
                      THEN ds.config #> p.path
                      ELSE '{}'::jsonb END
               ) AS keys(k)
          WHERE lower(regexp_replace(keys.k, '[^A-Za-z0-9]', '', 'g'))
                ~ '(password|passwd|pwd|pswd|passphrase|passcode|secret|token|credential|apikey|accesskey|privatekey|authorization)'
             OR lower(regexp_replace(keys.k, '[^A-Za-z0-9]', '', 'g'))
                ~ '^(db|pg|pgsql|my|sql|mysql|mssql|ora|oracle|redis|mongo|user|usr|admin|root|login|account|acct|svc|service|app|client|api|auth|conn|connection|ftp|sftp|ssh|smtp|imap|mail|proxy)?(pass|pw)$'
       )`

/**
 * The #5648 inventory text, kept ONLY as the contrast that shows why INVENTORY_SQL had to change:
 * run against the two rows seeded for F11 it returns 0. Also byte-identical to the doc block that
 * carries it (design §5, "旧 B"), same `+ ';'` rule as above. Do not use it to plan a migration.
 */
const INVENTORY_SQL_5648 = `SELECT count(*)::int AS affected_rows
  FROM data_sources ds
 WHERE EXISTS (
         SELECT 1
           FROM jsonb_object_keys(COALESCE(ds.config->'connection', '{}'::jsonb)) AS k
          WHERE lower(regexp_replace(k, '[^A-Za-z0-9]', '', 'g'))
                ~ '(password|passwd|pwd|passphrase|secret|token|credential|apikey|accesskey|privatekey|authorization)'
       )`

/**
 * Splice a row filter into an inventory query WITHOUT touching its predicate: both queries above
 * open with the same three lines, so the anchor below is the only edit and every byte of the
 * key-matching EXISTS(...) stays as the doc has it. Throws rather than returning the unfiltered
 * query if the anchor ever moves — an unfiltered count would quietly "pass" the 0-hit assertions.
 */
const SCOPE_ANCHOR = '\n WHERE EXISTS ('
function scopeToIds(sql: string): string {
  if (!sql.includes(SCOPE_ANCHOR)) {
    throw new Error('inventory SQL no longer opens with the expected `WHERE EXISTS (` anchor')
  }
  return sql.replace(SCOPE_ANCHOR, '\n WHERE ds.id = ANY($1::text[])\n   AND EXISTS (')
}

const DESIGN_DOC_PATH = path.resolve(
  __dirname,
  '../../../../docs/development/data-source-connection-secret-keys-design-20260912.md',
)

// Needs no database: it compares two files. Kept at top level (like the sentinel) so any collection
// of this spec runs it — the whole point is that the doc and this spec cannot drift apart.
it('the design doc §5 B block is byte-identical to the SQL this spec executes', () => {
  const doc = fs.readFileSync(DESIGN_DOC_PATH, 'utf8').replace(/\r\n/g, '\n')
  expect(doc).toContain(`${INVENTORY_SQL};`)
  expect(doc).toContain(`${INVENTORY_SQL_5648};`)
})

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

  async function seedRow(id: string, type: string, config: Record<string, unknown>): Promise<void> {
    await pool.query(
      `INSERT INTO data_sources (id, name, type, config, status, owner_id, workspace_id, tenant_id,
                                 scope_kind, is_active, auto_connect)
       VALUES ($1, $2, $3, $4::jsonb, 'disconnected', $5, NULL, $6, 'private', true, false)`,
      [id, id, type, JSON.stringify(config), OWNER_ID, TENANT_ID],
    )
  }

  /** Row count for one inventory query restricted to the given ids (see `scopeToIds`). */
  async function countScoped(sql: string, ids: readonly string[]): Promise<number> {
    const res = await pool.query(scopeToIds(sql), [ids])
    return res.rows[0].affected_rows
  }

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

    // F11 inventory fixtures. Seeded AFTER initialize ON PURPOSE: they are TABLE-level evidence for
    // the inventory SQL, and no HTTP assertion reads them, so keeping them out of the manager's load
    // phase keeps this evidence independent of adapter construction.
    await seedRow(GLUED_ID, 'postgres', {
      // A glued qualifier key. The API refuses this shape since F03, so a row can only carry it from
      // BEFORE the refusal (or from an in-process writer, which this cut does not gate) — exactly
      // the population an inventory exists to find. The #5648 query cannot see it: normalised
      // `dbpass` contains none of its substring words.
      connection: { host: '127.0.0.1', port: 5432, database: 'plm', dbpass: GLUED_SECRET },
      credentials: { username: 'legacy-user' },
      options: { autoConnect: false },
    })
    await seedRow(NESTED_ID, 'http', {
      // A NESTED live credential: the API cannot send it (the Zod record takes scalars only), but
      // PLMAdapter writes its Bearer into connection.headers at runtime and HTTPAdapter spreads
      // those headers into the axios defaults. The #5648 query cannot see it either — it reads the
      // TOP LEVEL of config->'connection' and never descends.
      connection: {
        baseURL: 'https://plm.invalid/api',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${NESTED_SECRET}` },
      },
      options: { autoConnect: false },
    })
    await seedRow(BENIGN_ID, 'postgres', {
      // NEGATIVE CONTROL for the widened `<SECRET_GLUED>` branch. The migration UPDATE built from
      // this same regex DELETES keys, so a false positive here is data loss: `passive` (the FTP
      // lever), `bypass` and `compass` must stay uncounted, and `headers` must be walked without
      // its ordinary keys matching.
      connection: {
        host: '127.0.0.1',
        passive: true,
        bypass: 'no',
        compass: 'north',
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'benign' },
      },
      options: { autoConnect: false },
    })
  })

  afterAll(async () => {
    await pool.query('DELETE FROM data_sources WHERE id = ANY($1::text[])', [
      [LEGACY_ID, REFUSED_ID, ACCEPTED_ID, GLUED_ID, NESTED_ID, BENIGN_ID],
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
    // Verbatim from docs/development/data-source-connection-secret-keys-design-20260912.md §5 (B).
    // Unscoped, i.e. exactly what an operator would run before the migration ticket: it must parse
    // and execute against the SHIPPED `data_sources`, and it returns a COUNT — no value column.
    const inventory = await pool.query(INVENTORY_SQL)
    // The three rows seeded above (legacy `password`, glued `dbpass`, nested `headers.Authorization`).
    expect(inventory.rows[0].affected_rows).toBeGreaterThanOrEqual(3)
    expect(Object.keys(inventory.rows[0])).toEqual(['affected_rows'])
  })

  it('F11: the inventory SQL counts what the write entry refuses — glued and nested rows the #5648 text missed', async () => {
    // WHY THE UPGRADE. Same two rows, both queries, only the vocabulary/paths differ.
    expect(await countScoped(INVENTORY_SQL, [GLUED_ID, NESTED_ID])).toBe(2)
    expect(await countScoped(INVENTORY_SQL_5648, [GLUED_ID, NESTED_ID])).toBe(0)

    // Each one on its own, so a future failure says WHICH shape broke.
    expect(await countScoped(INVENTORY_SQL, [GLUED_ID])).toBe(1) // <SECRET_GLUED>: dbpass
    expect(await countScoped(INVENTORY_SQL, [NESTED_ID])).toBe(1) // {connection,headers}: Authorization

    // SUPERSET, not a swap: everything #5648 could count is still counted.
    expect(await countScoped(INVENTORY_SQL_5648, [LEGACY_ID])).toBe(1)
    expect(await countScoped(INVENTORY_SQL, [LEGACY_ID])).toBe(1)

    // NO FALSE POSITIVE from the widened branch — the migration UPDATE built from this regex deletes
    // keys, so `passive` / `bypass` / `compass` / ordinary headers must stay uncounted.
    expect(await countScoped(INVENTORY_SQL, [BENIGN_ID])).toBe(0)
  })
})
