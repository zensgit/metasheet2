/**
 * PR-1 Connection / Binding schema.
 *
 * MUST be a zzzz-timestamped Kysely migration, not a numeric 0xx SQL file.
 * data_sources is created by 20251206000001_create_data_sources_table, which sorts AFTER every
 * 0xx SQL name. A numeric 082_*.sql would run first on a fresh database and fail (or, if guarded
 * with to_regclass, silently no-op and never add the columns). This file sorts after that create
 * and after 057_create_integration_core_tables.
 *
 * Contract:
 *   * data_sources.tenant_id is explicit and nullable. Old rows stay NULL until tenant membership
 *     is proven; this column is NOT derived from workspace_id.
 *   * data_sources.scope_kind is a closed set: legacy_private | private | workspace.
 *     Pre-existing rows backfill to legacy_private. Future inserts default to private.
 *   * integration_external_systems.connection_id is nullable TEXT referencing data_sources(id)
 *     ON DELETE RESTRICT. Two Bindings may share one Connection, so the lookup index is not UNIQUE.
 *   * integration_external_systems.legacy_connection_fallback_eligible is server-owned BOOLEAN
 *     NOT NULL DEFAULT FALSE. TRUE is set only on data-source:sql-readonly rows that this
 *     migration actually backfills to connection_id by joining a live config.dataSourceId to an
 *     existing data_sources.id whose owner_id equals the server-stamped
 *     config.dataSourceOwnerId. Unstamped or foreign pointers stay unbound and FALSE; they
 *     cannot pin another owner's Connection. Future rows stay FALSE. This is cutover evidence,
 *     not a created_at wall-clock constant.
 *
 * Idempotent: ADD COLUMN IF NOT EXISTS, relation-scoped constraint guards, NULL-only scope
 * backfill, and connection backfill only where connection_id IS NULL and the flag is not already
 * TRUE (so a later rollback that nulls connection_id is not undone by replaying this migration).
 */
import { sql, type Kysely } from 'kysely'
import { checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  if (await checkTableExists(db, 'data_sources')) {
    await sql`
      ALTER TABLE data_sources
        ADD COLUMN IF NOT EXISTS tenant_id TEXT,
        ADD COLUMN IF NOT EXISTS scope_kind TEXT
    `.execute(db)

    await sql`
      UPDATE data_sources
      SET scope_kind = 'legacy_private'
      WHERE scope_kind IS NULL
    `.execute(db)

    await sql`
      ALTER TABLE data_sources
        ALTER COLUMN scope_kind SET DEFAULT 'private'
    `.execute(db)

    await sql`
      ALTER TABLE data_sources
        ALTER COLUMN scope_kind SET NOT NULL
    `.execute(db)

    await sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'chk_data_sources_scope_kind'
            AND conrelid = 'data_sources'::regclass
        ) THEN
          ALTER TABLE data_sources
            ADD CONSTRAINT chk_data_sources_scope_kind
            CHECK (scope_kind IN ('legacy_private', 'private', 'workspace'));
        END IF;
      END $$
    `.execute(db)
  }

  if (await checkTableExists(db, 'integration_external_systems')) {
    await sql`
      ALTER TABLE integration_external_systems
        ADD COLUMN IF NOT EXISTS connection_id TEXT,
        ADD COLUMN IF NOT EXISTS legacy_connection_fallback_eligible BOOLEAN NOT NULL DEFAULT FALSE
    `.execute(db)

    // Finish the invariant even if a previous partial attempt added the marker
    // without its default/NOT NULL clauses. This also makes the idempotence
    // claim true for interrupted deployments, not only for clean installs.
    await sql`
      UPDATE integration_external_systems
      SET legacy_connection_fallback_eligible = FALSE
      WHERE legacy_connection_fallback_eligible IS NULL
    `.execute(db)

    await sql`
      ALTER TABLE integration_external_systems
        ALTER COLUMN legacy_connection_fallback_eligible SET DEFAULT FALSE,
        ALTER COLUMN legacy_connection_fallback_eligible SET NOT NULL
    `.execute(db)

    if (await checkTableExists(db, 'data_sources')) {
      await sql`
        UPDATE integration_external_systems AS binding
        SET
          connection_id = ds.id,
          legacy_connection_fallback_eligible = TRUE
        FROM data_sources AS ds
        WHERE binding.kind = 'data-source:sql-readonly'
          AND binding.connection_id IS NULL
          AND binding.legacy_connection_fallback_eligible IS NOT TRUE
          AND ds.id = NULLIF(BTRIM(binding.config->>'dataSourceId'), '')
          AND NULLIF(BTRIM(binding.config->>'dataSourceOwnerId'), '') = ds.owner_id
      `.execute(db)

      await sql`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'fk_integration_external_systems_connection_id'
              AND conrelid = 'integration_external_systems'::regclass
          ) THEN
            ALTER TABLE integration_external_systems
              ADD CONSTRAINT fk_integration_external_systems_connection_id
              FOREIGN KEY (connection_id) REFERENCES data_sources(id) ON DELETE RESTRICT;
          END IF;
        END $$
      `.execute(db)
    }

    await sql`
      CREATE INDEX IF NOT EXISTS idx_integration_external_systems_connection_id
        ON integration_external_systems (connection_id)
    `.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (await checkTableExists(db, 'integration_external_systems')) {
    await sql`
      DROP INDEX IF EXISTS idx_integration_external_systems_connection_id
    `.execute(db)
    await sql`
      ALTER TABLE integration_external_systems
        DROP CONSTRAINT IF EXISTS fk_integration_external_systems_connection_id
    `.execute(db)
    await sql`
      ALTER TABLE integration_external_systems
        DROP COLUMN IF EXISTS legacy_connection_fallback_eligible,
        DROP COLUMN IF EXISTS connection_id
    `.execute(db)
  }

  if (await checkTableExists(db, 'data_sources')) {
    await sql`
      ALTER TABLE data_sources
        DROP CONSTRAINT IF EXISTS chk_data_sources_scope_kind
    `.execute(db)
    await sql`
      ALTER TABLE data_sources
        DROP COLUMN IF EXISTS scope_kind,
        DROP COLUMN IF EXISTS tenant_id
    `.execute(db)
  }
}
