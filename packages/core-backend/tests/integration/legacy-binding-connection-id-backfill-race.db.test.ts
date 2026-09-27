/**
 * zzzz20260920150000 (legacy sql-readonly binding connection_id backfill) — real-PostgreSQL
 * two-connection race regression for F1 of the window-8 review.
 *
 * THE DEFECT (b591dd957): every eligibility predicate lived only in the `hit` candidate CTE and the
 * UPDATE wrote by `b.id = hit.binding_id` alone. Under READ COMMITTED the candidates come from the
 * statement snapshot; when the UPDATE waits on a concurrent writer's row lock it proceeds on the
 * committed NEW row version. A legitimate rebind (legacy -> canonical source_b) committed in that
 * window was overwritten back to source_a, and the ledger recorded source_a.
 *
 * THE FIX, pinned here by behaviour (not by source regex):
 *   * the UPDATE re-checks the binding-side predicates against the row it actually writes, so any
 *     concurrent change to kind / connection_id / pointer / owner stamp / tenant / rollback marker
 *     makes the backfill SKIP the row;
 *   * the candidate CTE takes `FOR SHARE OF ds`, so a concurrent source soft-delete / owner change /
 *     tenant change (to another tenant or to NULL) / deactivation / type change either lands first
 *     (candidate drops out) or waits for the backfill (predicates 7 `is_active` and 8 SQL read-only
 *     type, added after the CONNECTION_CANONICAL_UNAVAILABLE diagnosis, are re-checked there like the
 *     others);
 *   * predicate 6 (source tenant == binding tenant) is pinned by behaviour too: a NULL-tenant
 *     ("tenant unproven") source and a foreign-tenant source are never promoted, statically or
 *     when the source's tenant changes while the migration waits on its lock;
 *   * the ledger is fed by the UPDATE's RETURNING, so a skipped row is never recorded;
 *   * down() re-checks the same binding-side axes on the row it restores (kind, recorded connection
 *     id, tenant, owner stamp, no regained pointer, rollback marker not TRUE), so a binding changed
 *     after the backfill — including one whose marker was set TRUE — keeps its ledger row as evidence.
 *
 * Each race: connection W opens a transaction and changes the row (or its source) without
 * committing; the migration runs in its own transaction on a pool connection; a third connection
 * confirms through pg_stat_activity that the migration is BLOCKED on a lock (the interleaving
 * really happened); W commits; the migration must commit and leave W's committed state intact.
 *
 * Isolated schema + search_path per test (house rule for shared-DB integration). Excluded from the
 * no-DB default vitest config so it cannot collect-and-skip-green there; EXPECT_DB=1 arms the
 * anti-skip-green sentinel in the real-DB lane.
 *
 * The first block builds a MINIMAL two-table shape per test. The second block builds a scratch
 * database with the repository's FULL migration chain (`src/db/migrate.ts`, the entry point
 * `db:migrate` runs, no MIGRATION_EXCLUDE) and re-proves predicate 6 and down()'s marker re-check on
 * the real table shape (real NOT NULLs and defaults, the 057 `updated_at` trigger, the NOT VALID
 * live_id FK): a weakened tenant comparison was green on the minimal shape and on the structural
 * pins before these cases existed, and promoted a tenant-unproven binding on the full chain.
 */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'

import { Client, Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { down, up } from '../../src/db/migrations/zzzz20260920150000_backfill_sql_readonly_legacy_connection_id'

const dbUrl = process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const LEDGER = 'integration_external_system_connection_backfills'
const READONLY = 'data-source:sql-readonly'

type BindingRow = {
  id: string
  tenant_id: string
  kind: string
  connection_id: string | null
  config: Record<string, unknown>
  legacy_connection_fallback_eligible: boolean
}

type RaceResult = { blocked: boolean; outcome: string }

/**
 * W runs `writerSql` in an open transaction; the migration's up() (or down()) starts on
 * `migrationDb` (whose pool connects as `app`); the observer must see the migration blocked on a
 * lock; W commits; the migration must commit.
 */
async function raceMigrationAgainst(
  ctx: { writer: Client; observer: Client; migrationDb: Kysely<unknown>; app: string },
  writerSql: string,
  direction: 'up' | 'down',
): Promise<RaceResult> {
  const { writer, observer, migrationDb, app } = ctx
  await writer.query('BEGIN')
  await writer.query(writerSql)
  let outcome = 'pending'
  const inflight = migrationDb
    .transaction()
    .execute((tx) => (direction === 'up' ? up(tx) : down(tx)))
    .then(
      () => { outcome = 'committed' },
      (err: { code?: string; message?: string }) => { outcome = err.code || err.message || 'error' },
    )
  let blocked = false
  for (let n = 0; n < 400 && outcome === 'pending'; n++) {
    const r = await observer.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE application_name = $1 AND wait_event_type = 'Lock' AND query LIKE $2`,
      [app, direction === 'up' ? '%WITH hit AS%' : '%WITH restored AS%'],
    )
    if (r.rowCount) { blocked = true; break }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  await writer.query('COMMIT')
  await inflight
  return { blocked, outcome }
}

/**
 * Asserted AFTER the row/ledger checks so a regression reports the wrong data first: the
 * interleaving must really have happened (the migration waited on W's lock) and the migration
 * must have committed, not aborted.
 */
function expectInterleavedAndCommitted(race: RaceResult): void {
  expect(race).toEqual({ blocked: true, outcome: 'committed' })
}

describeDb('zzzz20260920150000 backfill vs concurrent writers (real DB, two connections)', () => {
  let schema: string
  let adminPool: Pool
  let migrationPool: Pool
  let migrationDb: Kysely<unknown>
  let writer: Client
  let observer: Client
  let migrationApp: string

  beforeEach(async () => {
    schema = `f1race_${randomUUID().replace(/-/g, '')}`
    migrationApp = `f1-backfill-${schema.slice(-12)}`
    const options = `-c search_path=${schema}`
    adminPool = new Pool({ connectionString: dbUrl })
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    migrationPool = new Pool({ connectionString: dbUrl, options, application_name: migrationApp })
    migrationDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: migrationPool }) })
    writer = new Client({ connectionString: dbUrl, options })
    observer = new Client({ connectionString: dbUrl, options })
    await writer.connect()
    await observer.connect()
    // Minimal shape of the two tables as they stand after the cutover (zzzz20260902120000) and
    // the live_id FK (#5896): the FK targets data_sources(live_id), NULL once soft-deleted.
    await observer.query(`
      CREATE TABLE data_sources (
        id text PRIMARY KEY,
        type text NOT NULL DEFAULT 'postgresql',
        owner_id text NOT NULL,
        tenant_id text,
        is_active boolean NOT NULL DEFAULT true,
        deleted_at timestamptz,
        live_id text GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN id ELSE NULL END) STORED UNIQUE
      );
      CREATE TABLE integration_external_systems (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        kind text NOT NULL,
        config jsonb NOT NULL,
        connection_id text,
        legacy_connection_fallback_eligible boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_integration_external_systems_live_connection_id
          FOREIGN KEY (connection_id) REFERENCES data_sources(live_id)
      );
      INSERT INTO data_sources (id, owner_id, tenant_id) VALUES
        ('source_a', 'owner_a', 'tenant_a'),
        ('source_b', 'owner_a', 'tenant_a');
      INSERT INTO integration_external_systems (id, tenant_id, kind, config) VALUES
        ('binding_a', 'tenant_a', '${READONLY}', '{"dataSourceId":"source_a","dataSourceOwnerId":"owner_a"}');
    `)
  })

  afterEach(async () => {
    await writer.query('ROLLBACK').catch(() => {})
    await writer.end().catch(() => {})
    await observer.end().catch(() => {})
    await migrationDb.destroy().catch(() => {})
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await adminPool.end()
  })

  async function binding(): Promise<BindingRow> {
    const r = await observer.query<BindingRow>(
      `SELECT id, tenant_id, kind, connection_id, config, legacy_connection_fallback_eligible
         FROM integration_external_systems WHERE id = 'binding_a'`,
    )
    return r.rows[0]
  }

  async function ledger(): Promise<Array<{ binding_id: string; connection_id: string }>> {
    const r = await observer.query(`SELECT binding_id, connection_id FROM ${LEDGER} ORDER BY binding_id`)
    return r.rows
  }

  async function raceUpAgainst(writerSql: string): Promise<RaceResult> {
    return raceAgainst(writerSql, 'up')
  }

  async function raceAgainst(writerSql: string, direction: 'up' | 'down'): Promise<RaceResult> {
    return raceMigrationAgainst({ writer, observer, migrationDb, app: migrationApp }, writerSql, direction)
  }

  it('baseline: up() backfills the eligible row and records it; replay is a no-op; down() restores it', async () => {
    await migrationDb.transaction().execute((tx) => up(tx))
    expect(await binding()).toMatchObject({ connection_id: 'source_a', config: { dataSourceOwnerId: 'owner_a' } })
    expect(await ledger()).toEqual([{ binding_id: 'binding_a', connection_id: 'source_a' }])
    await migrationDb.transaction().execute((tx) => up(tx))
    expect(await ledger()).toEqual([{ binding_id: 'binding_a', connection_id: 'source_a' }])
    await migrationDb.transaction().execute((tx) => down(tx))
    expect(await binding()).toMatchObject({
      connection_id: null,
      config: { dataSourceId: 'source_a', dataSourceOwnerId: 'owner_a' },
    })
  })

  it('F1 counterexample: a concurrent legacy -> canonical rebind (source_b) survives and is not recorded', async () => {
    const race = await raceUpAgainst(
      `UPDATE integration_external_systems
          SET connection_id = 'source_b', config = config - 'dataSourceId', updated_at = NOW()
        WHERE id = 'binding_a'`,
    )
    expect(await binding()).toMatchObject({ connection_id: 'source_b', config: { dataSourceOwnerId: 'owner_a' } })
    expect((await binding()).config).not.toHaveProperty('dataSourceId')
    expect(await ledger()).toEqual([])
    expectInterleavedAndCommitted(race)
  })

  it('a concurrent connection_id write that keeps the legacy pointer (mixed shape) is not overwritten', async () => {
    // Isolates the `connection_id IS NULL` re-check: the pointer, stamp, kind, tenant and marker all
    // still match the candidate, so only that predicate can make the backfill skip this row.
    const race = await raceUpAgainst(
      `UPDATE integration_external_systems
          SET connection_id = 'source_b', updated_at = NOW()
        WHERE id = 'binding_a'`,
    )
    expect(await binding()).toMatchObject({
      connection_id: 'source_b',
      config: { dataSourceId: 'source_a', dataSourceOwnerId: 'owner_a' },
    })
    expect(await ledger()).toEqual([])
    expectInterleavedAndCommitted(race)
  })

  it('a concurrent re-point of the legacy pointer (source_a -> source_b, still legacy) is not overwritten', async () => {
    const race = await raceUpAgainst(
      `UPDATE integration_external_systems
          SET config = jsonb_set(config, '{dataSourceId}', '"source_b"'), updated_at = NOW()
        WHERE id = 'binding_a'`,
    )
    expect(await binding()).toMatchObject({
      connection_id: null,
      config: { dataSourceId: 'source_b', dataSourceOwnerId: 'owner_a' },
    })
    expect(await ledger()).toEqual([])
    expectInterleavedAndCommitted(race)
  })

  it('a concurrent owner re-stamp on the binding makes the backfill skip it', async () => {
    const race = await raceUpAgainst(
      `UPDATE integration_external_systems
          SET config = jsonb_set(config, '{dataSourceOwnerId}', '"owner_x"'), updated_at = NOW()
        WHERE id = 'binding_a'`,
    )
    expect(await binding()).toMatchObject({
      connection_id: null,
      config: { dataSourceId: 'source_a', dataSourceOwnerId: 'owner_x' },
    })
    expect(await ledger()).toEqual([])
    expectInterleavedAndCommitted(race)
  })

  it('a concurrent rollback-marker flip (cutover rollback shape) is left alone', async () => {
    const race = await raceUpAgainst(
      `UPDATE integration_external_systems
          SET legacy_connection_fallback_eligible = TRUE, updated_at = NOW()
        WHERE id = 'binding_a'`,
    )
    expect(await binding()).toMatchObject({
      connection_id: null,
      legacy_connection_fallback_eligible: true,
      config: { dataSourceId: 'source_a' },
    })
    expect(await ledger()).toEqual([])
    expectInterleavedAndCommitted(race)
  })

  it('a concurrent kind change away from sql-readonly is left alone', async () => {
    const race = await raceUpAgainst(
      `UPDATE integration_external_systems
          SET kind = 'data-source:sql-write-gated', updated_at = NOW()
        WHERE id = 'binding_a'`,
    )
    expect(await binding()).toMatchObject({
      kind: 'data-source:sql-write-gated',
      connection_id: null,
      config: { dataSourceId: 'source_a' },
    })
    expect(await ledger()).toEqual([])
    expectInterleavedAndCommitted(race)
  })

  it('a concurrent tenant move of the binding never gets a foreign-tenant source written in', async () => {
    const race = await raceUpAgainst(
      `UPDATE integration_external_systems
          SET tenant_id = 'tenant_b', updated_at = NOW()
        WHERE id = 'binding_a'`,
    )
    expect(await binding()).toMatchObject({
      tenant_id: 'tenant_b',
      connection_id: null,
      config: { dataSourceId: 'source_a' },
    })
    expect(await ledger()).toEqual([])
    expectInterleavedAndCommitted(race)
  })

  it('a concurrent owner change of the SOURCE drops the candidate (source row is locked and re-checked)', async () => {
    const race = await raceUpAgainst(`UPDATE data_sources SET owner_id = 'owner_x' WHERE id = 'source_a'`)
    expect(await binding()).toMatchObject({
      connection_id: null,
      config: { dataSourceId: 'source_a', dataSourceOwnerId: 'owner_a' },
    })
    expect(await ledger()).toEqual([])
    expectInterleavedAndCommitted(race)
  })

  // ── Predicate 6 (source tenant == binding tenant; a NULL-tenant source is "tenant unproven") ───
  // The resolver refuses a registration whose tenant differs from the binding's, and the migration
  // does not guess an unproven (NULL) tenant. `ds.tenant_id = b.tenant_id` is NULL, not TRUE, for a
  // NULL-tenant source, so a weakened comparison (`IS NOT FALSE`, or the predicate dropped) would
  // promote exactly these rows. Before these cases a mutant `IS NOT FALSE` passed both the unit pin
  // (then unanchored) and this whole suite; only behaviour on such rows tells the two apart.

  it('predicate 6: NULL-tenant and foreign-tenant sources are NOT promoted; only the same-tenant row is recorded', async () => {
    await observer.query(`
      INSERT INTO data_sources (id, owner_id, tenant_id) VALUES
        ('source_nullt', 'owner_a', NULL),
        ('source_t2',    'owner_a', 'tenant_b');
      INSERT INTO integration_external_systems (id, tenant_id, kind, config) VALUES
        ('binding_nullt', 'tenant_a', '${READONLY}', '{"dataSourceId":"source_nullt","dataSourceOwnerId":"owner_a"}'),
        ('binding_t2',    'tenant_a', '${READONLY}', '{"dataSourceId":"source_t2","dataSourceOwnerId":"owner_a"}');
    `)
    await migrationDb.transaction().execute((tx) => up(tx))
    const rows = await observer.query<{ id: string; connection_id: string | null; pointer: string | null }>(
      `SELECT id, connection_id, config->>'dataSourceId' AS pointer
         FROM integration_external_systems ORDER BY id`,
    )
    expect(rows.rows).toEqual([
      { id: 'binding_a', connection_id: 'source_a', pointer: null },
      // tenant unproven: the source's tenant is NULL -> left alone (census class tenant-unproven)
      { id: 'binding_nullt', connection_id: null, pointer: 'source_nullt' },
      // cross-tenant: a tenant_a binding pointing at a tenant_b source -> left alone (tenant-mismatch)
      { id: 'binding_t2', connection_id: null, pointer: 'source_t2' },
    ])
    expect(await ledger()).toEqual([{ binding_id: 'binding_a', connection_id: 'source_a' }])
  })

  it('predicate 6 under the lock: a concurrent tenant change of the SOURCE to NULL (unproven) drops the candidate', async () => {
    const race = await raceUpAgainst(`UPDATE data_sources SET tenant_id = NULL WHERE id = 'source_a'`)
    expect(await binding()).toMatchObject({
      connection_id: null,
      config: { dataSourceId: 'source_a', dataSourceOwnerId: 'owner_a' },
    })
    expect(await ledger()).toEqual([])
    expectInterleavedAndCommitted(race)
  })

  it('predicate 6 under the lock: a concurrent tenant change of the SOURCE to another tenant drops the candidate', async () => {
    const race = await raceUpAgainst(`UPDATE data_sources SET tenant_id = 'tenant_b' WHERE id = 'source_a'`)
    expect(await binding()).toMatchObject({
      tenant_id: 'tenant_a',
      connection_id: null,
      config: { dataSourceId: 'source_a', dataSourceOwnerId: 'owner_a' },
    })
    expect(await ledger()).toEqual([])
    expectInterleavedAndCommitted(race)
  })

  it('a concurrent soft-delete of the SOURCE drops the candidate instead of aborting on the live_id FK', async () => {
    const race = await raceUpAgainst(`UPDATE data_sources SET deleted_at = NOW() WHERE id = 'source_a'`)
    expect(await binding()).toMatchObject({ connection_id: null, config: { dataSourceId: 'source_a' } })
    expect(await ledger()).toEqual([])
    expectInterleavedAndCommitted(race)
  })

  // ── Predicates 7 / 8 (source active, source type in the SQL read-only set) ─────────────────────
  // Diagnosis doc stock-prep-connection-canonical-unavailable-diagnosis-20260925.md §3 conclusion 2:
  // without them the backfill promoted S2b (inactive source) and S2c (unloadable type) rows into
  // canonical rows that fail with CONNECTION_CANONICAL_UNAVAILABLE.

  it('predicates 7/8: inactive-source and unsupported-type rows are NOT promoted; the eligible rows are, and only they are recorded', async () => {
    await observer.query(`
      INSERT INTO data_sources (id, type, owner_id, tenant_id, is_active) VALUES
        ('source_off',   'postgresql', 'owner_a', 'tenant_a', false),
        ('source_mongo', 'mongodb',    'owner_a', 'tenant_a', true),
        ('source_http',  'http',       'owner_a', 'tenant_a', true),
        ('source_pad',   ' mysql',     'owner_a', 'tenant_a', true),
        ('source_upper', 'SQLServer',  'owner_a', 'tenant_a', true);
      INSERT INTO integration_external_systems (id, tenant_id, kind, config) VALUES
        ('binding_off',   'tenant_a', '${READONLY}', '{"dataSourceId":"source_off","dataSourceOwnerId":"owner_a"}'),
        ('binding_mongo', 'tenant_a', '${READONLY}', '{"dataSourceId":"source_mongo","dataSourceOwnerId":"owner_a"}'),
        ('binding_http',  'tenant_a', '${READONLY}', '{"dataSourceId":"source_http","dataSourceOwnerId":"owner_a"}'),
        ('binding_pad',   'tenant_a', '${READONLY}', '{"dataSourceId":"source_pad","dataSourceOwnerId":"owner_a"}'),
        ('binding_upper', 'tenant_a', '${READONLY}', '{"dataSourceId":"source_upper","dataSourceOwnerId":"owner_a"}');
    `)
    await migrationDb.transaction().execute((tx) => up(tx))
    const rows = await observer.query<{ id: string; connection_id: string | null; pointer: string | null }>(
      `SELECT id, connection_id, config->>'dataSourceId' AS pointer
         FROM integration_external_systems ORDER BY id`,
    )
    expect(rows.rows).toEqual([
      // eligible: postgresql (default type) and a mixed-case SQL type (runtime lowercases both sides)
      { id: 'binding_a', connection_id: 'source_a', pointer: null },
      // S2c: loadable but not a SQL type -> would be CONNECTION_TYPE_UNSUPPORTED
      { id: 'binding_http', connection_id: null, pointer: 'source_http' },
      // S2c: not in the adapter registry -> never loaded
      { id: 'binding_mongo', connection_id: null, pointer: 'source_mongo' },
      // S2b: inactive -> never loaded
      { id: 'binding_off', connection_id: null, pointer: 'source_off' },
      // the loader lowercases but does NOT trim, so a padded type is never loaded either
      { id: 'binding_pad', connection_id: null, pointer: 'source_pad' },
      { id: 'binding_upper', connection_id: 'source_upper', pointer: null },
    ])
    expect(await ledger()).toEqual([
      { binding_id: 'binding_a', connection_id: 'source_a' },
      { binding_id: 'binding_upper', connection_id: 'source_upper' },
    ])
  })

  it('predicate 7 under the lock: a concurrent deactivation of the SOURCE drops the candidate', async () => {
    const race = await raceUpAgainst(`UPDATE data_sources SET is_active = FALSE WHERE id = 'source_a'`)
    expect(await binding()).toMatchObject({
      connection_id: null,
      config: { dataSourceId: 'source_a', dataSourceOwnerId: 'owner_a' },
    })
    expect(await ledger()).toEqual([])
    expectInterleavedAndCommitted(race)
  })

  it('predicate 8 under the lock: a concurrent type change of the SOURCE to a non-SQL type drops the candidate', async () => {
    const race = await raceUpAgainst(`UPDATE data_sources SET type = 'http' WHERE id = 'source_a'`)
    expect(await binding()).toMatchObject({
      connection_id: null,
      config: { dataSourceId: 'source_a', dataSourceOwnerId: 'owner_a' },
    })
    expect(await ledger()).toEqual([])
    expectInterleavedAndCommitted(race)
  })

  it('positive control (source side): a concurrent source write that keeps predicates 7/8 true (type re-cased) still backfills', async () => {
    const race = await raceUpAgainst(`UPDATE data_sources SET type = 'PostgreSQL', is_active = TRUE WHERE id = 'source_a'`)
    expect(await binding()).toMatchObject({ connection_id: 'source_a', config: { dataSourceOwnerId: 'owner_a' } })
    expect((await binding()).config).not.toHaveProperty('dataSourceId')
    expect(await ledger()).toEqual([{ binding_id: 'binding_a', connection_id: 'source_a' }])
    expectInterleavedAndCommitted(race)
  })

  it('a concurrent write that keeps every predicate true (name-only touch) is still backfilled and recorded', async () => {
    const race = await raceUpAgainst(
      `UPDATE integration_external_systems
          SET config = config || '{"note":"touched"}'::jsonb, updated_at = NOW()
        WHERE id = 'binding_a'`,
    )
    expect(await binding()).toMatchObject({
      connection_id: 'source_a',
      config: { dataSourceOwnerId: 'owner_a', note: 'touched' },
    })
    expect((await binding()).config).not.toHaveProperty('dataSourceId')
    expect(await ledger()).toEqual([{ binding_id: 'binding_a', connection_id: 'source_a' }])
    expectInterleavedAndCommitted(race)
  })

  it('down(): a binding moved to another tenant after the backfill is NOT turned back into a legacy pointer (Sf4)', async () => {
    await migrationDb.transaction().execute((tx) => up(tx))
    const race = await raceAgainst(
      `UPDATE integration_external_systems SET tenant_id = 'tenant_b', updated_at = NOW() WHERE id = 'binding_a'`,
      'down',
    )
    expect(await binding()).toMatchObject({ tenant_id: 'tenant_b', connection_id: 'source_a' })
    expect((await binding()).config).not.toHaveProperty('dataSourceId')
    // its ledger row is kept as evidence (and keeps the ledger table from being dropped)
    expect(await ledger()).toEqual([{ binding_id: 'binding_a', connection_id: 'source_a' }])
    expectInterleavedAndCommitted(race)
  })

  it('down(): a binding re-stamped to another owner after the backfill is NOT turned back into a legacy pointer (Sf5)', async () => {
    await migrationDb.transaction().execute((tx) => up(tx))
    const race = await raceAgainst(
      `UPDATE integration_external_systems
          SET config = jsonb_set(config, '{dataSourceOwnerId}', '"owner_z"'), updated_at = NOW()
        WHERE id = 'binding_a'`,
      'down',
    )
    expect(await binding()).toMatchObject({ connection_id: 'source_a', config: { dataSourceOwnerId: 'owner_z' } })
    expect((await binding()).config).not.toHaveProperty('dataSourceId')
    expect(await ledger()).toEqual([{ binding_id: 'binding_a', connection_id: 'source_a' }])
    expectInterleavedAndCommitted(race)
  })

  it('down(): a binding whose rollback marker was set TRUE after the backfill is NOT turned back into a legacy pointer', async () => {
    // Restoring it would produce marker TRUE + connection_id NULL + pointer = the cutover's rollback
    // shape, which passes resolveLegacy's marker gate — while the same row (marker FALSE) was denied
    // there before the backfill. down() treats the flip like any other hand change: leave the row,
    // keep the ledger row.
    await migrationDb.transaction().execute((tx) => up(tx))
    expect(await binding()).toMatchObject({ connection_id: 'source_a', legacy_connection_fallback_eligible: false })
    const race = await raceAgainst(
      `UPDATE integration_external_systems
          SET legacy_connection_fallback_eligible = TRUE, updated_at = NOW()
        WHERE id = 'binding_a'`,
      'down',
    )
    expect(await binding()).toMatchObject({
      connection_id: 'source_a',
      legacy_connection_fallback_eligible: true,
      config: { dataSourceOwnerId: 'owner_a' },
    })
    expect((await binding()).config).not.toHaveProperty('dataSourceId')
    // its ledger row is kept as evidence (and keeps the ledger table from being dropped)
    expect(await ledger()).toEqual([{ binding_id: 'binding_a', connection_id: 'source_a' }])
    expectInterleavedAndCommitted(race)
  })
})

// ── The same guarantees on the REAL table shape: a scratch database built by the full chain ──────
// One database per file run (the chain takes seconds in CI, minutes on a slow laptop), dropped in
// afterAll. Every case resets the two tables to the same two rows, so the cases stay independent.

describeDb('zzzz20260920150000 on the full migration chain (real table shape): predicate 6 and down()\'s marker re-check', () => {
  const PKG_ROOT = path.resolve(__dirname, '../..')
  // tsx's CLI under the current node binary (node_modules/.bin/tsx is a shell shim on Windows)
  const TSX_CLI = path.join(PKG_ROOT, 'node_modules/tsx/dist/cli.mjs')
  const MIGRATION = 'zzzz20260920150000_backfill_sql_readonly_legacy_connection_id'
  const chainDb = `f1chain_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  const chainApp = `f1-chain-${chainDb.slice(-12)}`
  // Seeded updated_at: the 057 BEFORE UPDATE trigger moves it on every row an UPDATE writes, so
  // `written` tells rows the statement wrote from rows it only looked at.
  const SEEDED_AT = '2026-01-02T00:00:00Z'
  let adminPool: Pool
  let chainPool: Pool
  let chainKysely: Kysely<unknown>
  let writer: Client
  let observer: Client

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: dbUrl, max: 1 })
    await adminPool.query(`CREATE DATABASE ${chainDb}`)
    const url = new URL(dbUrl as string)
    url.pathname = `/${chainDb}`
    const chainUrl = url.toString()
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: chainUrl }
    // the WHOLE chain: no lane-level exclusion list leaks into this build
    delete env.MIGRATION_EXCLUDE
    const proc = spawnSync(process.execPath, [TSX_CLI, 'src/db/migrate.ts'], {
      cwd: PKG_ROOT,
      env,
      encoding: 'utf8',
      timeout: 900_000,
      maxBuffer: 64 * 1024 * 1024,
    })
    if (proc.error || proc.status !== 0) {
      throw new Error(
        `full-chain db:migrate failed (status ${proc.status}, ${String(proc.error ?? '')}):\n${String(proc.stderr).slice(-4000)}`,
      )
    }
    // The migration under test is part of the chain; it ran here on empty tables (nothing to backfill).
    expect(proc.stdout).toContain(`migration "${MIGRATION}" was executed successfully`)
    chainPool = new Pool({ connectionString: chainUrl, application_name: chainApp })
    chainKysely = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: chainPool }) })
    writer = new Client({ connectionString: chainUrl })
    observer = new Client({ connectionString: chainUrl })
    await writer.connect()
    await observer.connect()
  }, 1_200_000)

  afterAll(async () => {
    await writer?.query('ROLLBACK').catch(() => {})
    await writer?.end().catch(() => {})
    await observer?.end().catch(() => {})
    await chainKysely?.destroy().catch(() => {})
    await adminPool.query(`DROP DATABASE IF EXISTS ${chainDb} WITH (FORCE)`)
    await adminPool.end()
  }, 120_000)

  beforeEach(async () => {
    await writer.query('ROLLBACK').catch(() => {})
    await observer.query(`
      DO $$ BEGIN
        IF to_regclass('${LEDGER}') IS NOT NULL THEN DELETE FROM ${LEDGER}; END IF;
      END $$;
      DELETE FROM integration_external_systems;
      DELETE FROM data_sources;
      INSERT INTO data_sources (id, name, type, config, owner_id, tenant_id) VALUES
        ('source_a', 'source_a', 'postgresql', '{}', 'owner_a', 'tenant_a');
      INSERT INTO integration_external_systems (id, tenant_id, name, kind, role, config, updated_at) VALUES
        ('binding_a', 'tenant_a', 'binding_a', '${READONLY}', 'source',
         '{"dataSourceId":"source_a","dataSourceOwnerId":"owner_a"}', '${SEEDED_AT}');
    `)
  })

  type ChainRow = { id: string; connection_id: string | null; pointer: string | null; marker: boolean; written: boolean }

  async function rows(): Promise<ChainRow[]> {
    const r = await observer.query<ChainRow>(
      `SELECT id, connection_id, config->>'dataSourceId' AS pointer,
              legacy_connection_fallback_eligible AS marker,
              updated_at <> $1::timestamptz AS written
         FROM integration_external_systems ORDER BY id`,
      [SEEDED_AT],
    )
    return r.rows
  }

  async function ledger(): Promise<Array<{ binding_id: string; connection_id: string }> | 'dropped'> {
    const present = await observer.query<{ present: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS present`, [LEDGER])
    if (!present.rows[0].present) return 'dropped'
    const r = await observer.query(`SELECT binding_id, connection_id FROM ${LEDGER} ORDER BY binding_id`)
    return r.rows
  }

  function raceUp(writerSql: string): Promise<RaceResult> {
    return raceMigrationAgainst({ writer, observer, migrationDb: chainKysely, app: chainApp }, writerSql, 'up')
  }

  it('schema premise: data_sources.tenant_id is nullable; the 057 updated_at trigger and the NOT VALID live_id FK are there', async () => {
    const col = await observer.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'data_sources' AND column_name = 'tenant_id'`,
    )
    expect(col.rows).toEqual([{ is_nullable: 'YES' }])
    const trigger = await observer.query(
      `SELECT 1 FROM pg_trigger WHERE tgname = 'trg_integration_external_systems_updated_at' AND NOT tgisinternal`,
    )
    expect(trigger.rowCount).toBe(1)
    const fk = await observer.query(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'fk_integration_external_systems_live_connection_id'`,
    )
    expect(fk.rows).toEqual([{ convalidated: false }])
  })

  it('predicate 6: a NULL-tenant (unproven) and a foreign-tenant source are NOT promoted, not even written; only the same-tenant row is recorded', async () => {
    await observer.query(`
      INSERT INTO data_sources (id, name, type, config, owner_id, tenant_id) VALUES
        ('source_nullt', 'source_nullt', 'postgresql', '{}', 'owner_a', NULL),
        ('source_t2',    'source_t2',    'postgresql', '{}', 'owner_a', 'tenant_b');
      INSERT INTO integration_external_systems (id, tenant_id, name, kind, role, config, updated_at) VALUES
        ('binding_nullt', 'tenant_a', 'binding_nullt', '${READONLY}', 'source',
         '{"dataSourceId":"source_nullt","dataSourceOwnerId":"owner_a"}', '${SEEDED_AT}'),
        ('binding_t2',    'tenant_a', 'binding_t2',    '${READONLY}', 'source',
         '{"dataSourceId":"source_t2","dataSourceOwnerId":"owner_a"}', '${SEEDED_AT}');
    `)
    await chainKysely.transaction().execute((tx) => up(tx))
    expect(await rows()).toEqual([
      { id: 'binding_a', connection_id: 'source_a', pointer: null, marker: false, written: true },
      // tenant unproven (census class tenant-unproven): left as it was
      { id: 'binding_nullt', connection_id: null, pointer: 'source_nullt', marker: false, written: false },
      // a tenant_a binding pointing at a tenant_b source (census class tenant-mismatch): left as it was
      { id: 'binding_t2', connection_id: null, pointer: 'source_t2', marker: false, written: false },
    ])
    expect(await ledger()).toEqual([{ binding_id: 'binding_a', connection_id: 'source_a' }])
  })

  it('predicate 6 under the lock: the SOURCE\'s tenant set to NULL while up() waits on it drops the candidate', async () => {
    const race = await raceUp(`UPDATE data_sources SET tenant_id = NULL WHERE id = 'source_a'`)
    expect(await rows()).toEqual([
      { id: 'binding_a', connection_id: null, pointer: 'source_a', marker: false, written: false },
    ])
    expect(await ledger()).toEqual([])
    expectInterleavedAndCommitted(race)
  })

  it('predicate 6 under the lock: the SOURCE moved to another tenant while up() waits on it drops the candidate', async () => {
    const race = await raceUp(`UPDATE data_sources SET tenant_id = 'tenant_b' WHERE id = 'source_a'`)
    expect(await rows()).toEqual([
      { id: 'binding_a', connection_id: null, pointer: 'source_a', marker: false, written: false },
    ])
    expect(await ledger()).toEqual([])
    expectInterleavedAndCommitted(race)
  })

  it('down(): a backfilled row whose rollback marker was later set TRUE is left alone and keeps its ledger row; an untouched one is restored', async () => {
    await observer.query(`
      INSERT INTO data_sources (id, name, type, config, owner_id, tenant_id) VALUES
        ('source_c', 'source_c', 'mysql', '{}', 'owner_a', 'tenant_a');
      INSERT INTO integration_external_systems (id, tenant_id, name, kind, role, config, updated_at) VALUES
        ('binding_c', 'tenant_a', 'binding_c', '${READONLY}', 'source',
         '{"dataSourceId":"source_c","dataSourceOwnerId":"owner_a"}', '${SEEDED_AT}');
    `)
    await chainKysely.transaction().execute((tx) => up(tx))
    expect(await ledger()).toEqual([
      { binding_id: 'binding_a', connection_id: 'source_a' },
      { binding_id: 'binding_c', connection_id: 'source_c' },
    ])
    // an operator flips the marker on one backfilled row (committed before down() starts)
    await observer.query(
      `UPDATE integration_external_systems SET legacy_connection_fallback_eligible = TRUE WHERE id = 'binding_a'`,
    )
    await chainKysely.transaction().execute((tx) => down(tx))
    expect(await rows()).toEqual([
      // NOT turned into marker TRUE + connection_id NULL + pointer (the cutover's rollback shape,
      // which resolveLegacy's marker gate lets through; before the backfill this row was denied)
      { id: 'binding_a', connection_id: 'source_a', pointer: null, marker: true, written: true },
      // positive control: the untouched backfilled row is restored (pointer back, marker untouched)
      { id: 'binding_c', connection_id: null, pointer: 'source_c', marker: false, written: true },
    ])
    // binding_a's ledger row stays as evidence, so the ledger table is not dropped
    expect(await ledger()).toEqual([{ binding_id: 'binding_a', connection_id: 'source_a' }])
  })
})
