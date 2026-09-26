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
 *     deactivation / type change either lands first (candidate drops out) or waits for the backfill
 *     (predicates 7 `is_active` and 8 SQL read-only type, added after the CONNECTION_CANONICAL_
 *     UNAVAILABLE diagnosis, are re-checked there like the others);
 *   * the ledger is fed by the UPDATE's RETURNING, so a skipped row is never recorded.
 *
 * Each race: connection W opens a transaction and changes the row (or its source) without
 * committing; the migration runs in its own transaction on a pool connection; a third connection
 * confirms through pg_stat_activity that the migration is BLOCKED on a lock (the interleaving
 * really happened); W commits; the migration must commit and leave W's committed state intact.
 *
 * Isolated schema + search_path per test (house rule for shared-DB integration). Excluded from the
 * no-DB default vitest config so it cannot collect-and-skip-green there; EXPECT_DB=1 arms the
 * anti-skip-green sentinel in the real-DB lane.
 */
import { randomUUID } from 'node:crypto'

import { Client, Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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

  /**
   * W runs `writerSql` in an open transaction; the migration's up() (or down()) starts; the observer
   * must see the migration blocked on a lock; W commits; the migration must commit.
   */
  async function raceUpAgainst(writerSql: string): Promise<{ blocked: boolean; outcome: string }> {
    return raceAgainst(writerSql, 'up')
  }

  async function raceAgainst(writerSql: string, direction: 'up' | 'down'): Promise<{ blocked: boolean; outcome: string }> {
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
        [migrationApp, direction === 'up' ? '%WITH hit AS%' : '%WITH restored AS%'],
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
  function expectInterleavedAndCommitted(race: { blocked: boolean; outcome: string }): void {
    expect(race).toEqual({ blocked: true, outcome: 'committed' })
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
})
