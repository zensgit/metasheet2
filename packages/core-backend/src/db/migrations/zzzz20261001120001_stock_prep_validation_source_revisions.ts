import { sql, type Kysely } from 'kysely'

/**
 * Migration first: opaque nonces fence validation without exposing config/credentials.
 * Sorts after the actual data_sources create and canonical live-id FK migrations.
 * Source writes lock DS -> mirror; validation gates must lock binding -> mirror -> version.
 * No mirror FK: hard deletion retains a tombstone and recreation cannot reuse an old nonce.
 * connection_incarnation identifies one live Connection lifetime, independently of
 * the config/credential validation_revision. Ordinary rotations retain history;
 * insert and revival from soft deletion always mint a DB-owned new incarnation.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Intentionally fail if prerequisites are missing, rather than recording a silent no-op.
  await sql`
    ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS validation_revision UUID;
    ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS connection_incarnation UUID;
    UPDATE data_sources SET validation_revision = gen_random_uuid() WHERE validation_revision IS NULL;
    UPDATE data_sources SET connection_incarnation = gen_random_uuid() WHERE connection_incarnation IS NULL;
    ALTER TABLE data_sources ALTER COLUMN validation_revision SET DEFAULT gen_random_uuid(),
      ALTER COLUMN validation_revision SET NOT NULL,
      ALTER COLUMN connection_incarnation SET DEFAULT gen_random_uuid(),
      ALTER COLUMN connection_incarnation SET NOT NULL;
    ALTER TABLE integration_external_systems ADD COLUMN IF NOT EXISTS validation_revision UUID;
    UPDATE integration_external_systems SET validation_revision = gen_random_uuid() WHERE validation_revision IS NULL;
    ALTER TABLE integration_external_systems ALTER COLUMN validation_revision SET DEFAULT gen_random_uuid(),
      ALTER COLUMN validation_revision SET NOT NULL;
    CREATE TABLE IF NOT EXISTS integration_data_source_validation_revisions (
      data_source_id TEXT PRIMARY KEY,
      validation_revision UUID NOT NULL,
      connection_incarnation UUID NOT NULL,
      tenant_id TEXT,
      owner_id TEXT NOT NULL,
      workspace_id TEXT,
      scope_kind TEXT NOT NULL,
      type TEXT NOT NULL,
      is_active BOOLEAN NOT NULL,
      deleted_at TIMESTAMPTZ
    );
    ALTER TABLE integration_data_source_validation_revisions ADD COLUMN IF NOT EXISTS connection_incarnation UUID;
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION stock_prep_source_validation_revision() RETURNS TRIGGER
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        NEW.validation_revision := gen_random_uuid();
        NEW.connection_incarnation := gen_random_uuid();
      ELSIF ROW(NEW.config, NEW.type, NEW.owner_id, NEW.tenant_id, NEW.workspace_id,
                NEW.scope_kind, NEW.is_active, NEW.deleted_at)
        IS DISTINCT FROM ROW(OLD.config, OLD.type, OLD.owner_id, OLD.tenant_id, OLD.workspace_id,
                             OLD.scope_kind, OLD.is_active, OLD.deleted_at) THEN
        NEW.validation_revision := gen_random_uuid();
      ELSE
        NEW.validation_revision := OLD.validation_revision;
      END IF;
      IF TG_OP = 'UPDATE' THEN
        IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
          NEW.connection_incarnation := gen_random_uuid();
        ELSE
          NEW.connection_incarnation := OLD.connection_incarnation;
        END IF;
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS stock_prep_source_validation_revision ON data_sources;
    CREATE TRIGGER stock_prep_source_validation_revision BEFORE INSERT OR UPDATE ON data_sources
      FOR EACH ROW EXECUTE FUNCTION stock_prep_source_validation_revision();

    CREATE OR REPLACE FUNCTION stock_prep_source_validation_mirror() RETURNS TRIGGER
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        INSERT INTO integration_data_source_validation_revisions
          (data_source_id, validation_revision, connection_incarnation, tenant_id, owner_id, workspace_id, scope_kind, type, is_active, deleted_at)
        VALUES (OLD.id, gen_random_uuid(), OLD.connection_incarnation, OLD.tenant_id, OLD.owner_id, OLD.workspace_id, OLD.scope_kind, OLD.type, FALSE, CURRENT_TIMESTAMP)
        ON CONFLICT (data_source_id) DO UPDATE SET
          validation_revision = EXCLUDED.validation_revision, connection_incarnation = EXCLUDED.connection_incarnation,
          tenant_id = EXCLUDED.tenant_id,
          owner_id = EXCLUDED.owner_id, workspace_id = EXCLUDED.workspace_id, scope_kind = EXCLUDED.scope_kind,
          type = EXCLUDED.type, is_active = EXCLUDED.is_active, deleted_at = EXCLUDED.deleted_at;
        RETURN OLD;
      END IF;
      INSERT INTO integration_data_source_validation_revisions
        (data_source_id, validation_revision, connection_incarnation, tenant_id, owner_id, workspace_id, scope_kind, type, is_active, deleted_at)
      VALUES (NEW.id, NEW.validation_revision, NEW.connection_incarnation, NEW.tenant_id, NEW.owner_id, NEW.workspace_id, NEW.scope_kind, NEW.type, NEW.is_active, NEW.deleted_at)
      ON CONFLICT (data_source_id) DO UPDATE SET
        validation_revision = EXCLUDED.validation_revision, connection_incarnation = EXCLUDED.connection_incarnation,
        tenant_id = EXCLUDED.tenant_id,
        owner_id = EXCLUDED.owner_id, workspace_id = EXCLUDED.workspace_id, scope_kind = EXCLUDED.scope_kind,
        type = EXCLUDED.type, is_active = EXCLUDED.is_active, deleted_at = EXCLUDED.deleted_at;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS stock_prep_source_validation_mirror ON data_sources;
    CREATE TRIGGER stock_prep_source_validation_mirror AFTER INSERT OR UPDATE OR DELETE ON data_sources
      FOR EACH ROW EXECUTE FUNCTION stock_prep_source_validation_mirror();

    CREATE OR REPLACE FUNCTION stock_prep_binding_validation_revision() RETURNS TRIGGER
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        NEW.validation_revision := gen_random_uuid();
      ELSIF ROW(NEW.kind, NEW.role, NEW.status, NEW.connection_id, NEW.config,
                NEW.credentials_encrypted, NEW.tenant_id, NEW.workspace_id)
        IS DISTINCT FROM ROW(OLD.kind, OLD.role, OLD.status, OLD.connection_id, OLD.config,
                             OLD.credentials_encrypted, OLD.tenant_id, OLD.workspace_id) THEN
        NEW.validation_revision := gen_random_uuid();
      ELSE
        NEW.validation_revision := OLD.validation_revision;
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS stock_prep_binding_validation_revision ON integration_external_systems;
    CREATE TRIGGER stock_prep_binding_validation_revision BEFORE INSERT OR UPDATE ON integration_external_systems
      FOR EACH ROW EXECUTE FUNCTION stock_prep_binding_validation_revision();

    INSERT INTO integration_data_source_validation_revisions
      (data_source_id, validation_revision, connection_incarnation, tenant_id, owner_id, workspace_id, scope_kind, type, is_active, deleted_at)
    SELECT id, validation_revision, connection_incarnation, tenant_id, owner_id, workspace_id, scope_kind, type, is_active, deleted_at FROM data_sources
    ON CONFLICT (data_source_id) DO UPDATE SET
      validation_revision = EXCLUDED.validation_revision, connection_incarnation = EXCLUDED.connection_incarnation,
      tenant_id = EXCLUDED.tenant_id,
      owner_id = EXCLUDED.owner_id, workspace_id = EXCLUDED.workspace_id, scope_kind = EXCLUDED.scope_kind,
      type = EXCLUDED.type, is_active = EXCLUDED.is_active, deleted_at = EXCLUDED.deleted_at;
    -- An old candidate's tombstone has no surviving Connection to identify. Give
    -- it a fresh unusable lifetime, never adopt any historical caller reference.
    UPDATE integration_data_source_validation_revisions
      SET connection_incarnation = gen_random_uuid() WHERE connection_incarnation IS NULL;
    ALTER TABLE integration_data_source_validation_revisions ALTER COLUMN connection_incarnation SET NOT NULL;
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- Maintenance-only, in the caller's migration transaction. Acquire every
    -- relation lock NOWAIT before DDL: a source/ledger transaction must never be
    -- held in a reverse-order wait cycle by this rollback. The grants table lock
    -- also closes the empty-check -> concurrent first grant insertion window.
    DO $$
    DECLARE
      source_schema TEXT;
      source_table REGCLASS := 'data_sources'::pg_catalog.regclass;
      binding_table REGCLASS;
      mirror_table REGCLASS;
      grant_table REGCLASS;
      has_grants BOOLEAN;
    BEGIN
      -- A same-named empty table earlier in search_path must not hide history
      -- or receive our DDL. Anchor every dependent relation/function to DS.
      SELECT n.nspname INTO STRICT source_schema
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE c.oid = source_table;
      binding_table := pg_catalog.format('%I.integration_external_systems', source_schema)::pg_catalog.regclass;
      mirror_table := pg_catalog.to_regclass(pg_catalog.format('%I.integration_data_source_validation_revisions', source_schema));
      grant_table := pg_catalog.to_regclass(pg_catalog.format('%I.integration_automation_read_grants', source_schema));
      EXECUTE pg_catalog.format('LOCK TABLE %s, %s IN ACCESS EXCLUSIVE MODE NOWAIT', source_table, binding_table);
      IF mirror_table IS NOT NULL THEN
        EXECUTE pg_catalog.format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE NOWAIT', mirror_table);
      END IF;
      IF grant_table IS NOT NULL THEN
        EXECUTE pg_catalog.format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE NOWAIT', grant_table);
        EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM %s)', grant_table) INTO has_grants;
        IF has_grants THEN
          RAISE EXCEPTION 'AUTOMATION_READ_HISTORY_ROLLBACK_FORBIDDEN' USING ERRCODE = '55000';
        END IF;
      END IF;
      EXECUTE pg_catalog.format('DROP TRIGGER IF EXISTS stock_prep_source_validation_mirror ON %s', source_table);
      EXECUTE pg_catalog.format('DROP TRIGGER IF EXISTS stock_prep_source_validation_revision ON %s', source_table);
      EXECUTE pg_catalog.format('DROP TRIGGER IF EXISTS stock_prep_binding_validation_revision ON %s', binding_table);
      EXECUTE pg_catalog.format('DROP FUNCTION IF EXISTS %I.stock_prep_source_validation_mirror()', source_schema);
      EXECUTE pg_catalog.format('DROP FUNCTION IF EXISTS %I.stock_prep_source_validation_revision()', source_schema);
      EXECUTE pg_catalog.format('DROP FUNCTION IF EXISTS %I.stock_prep_binding_validation_revision()', source_schema);
      IF mirror_table IS NOT NULL THEN
        EXECUTE pg_catalog.format('DROP TABLE %s', mirror_table);
      END IF;
      EXECUTE pg_catalog.format('ALTER TABLE %s DROP COLUMN IF EXISTS validation_revision, DROP COLUMN IF EXISTS connection_incarnation', source_table);
      EXECUTE pg_catalog.format('ALTER TABLE %s DROP COLUMN IF EXISTS validation_revision', binding_table);
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION 'AUTOMATION_READ_MIGRATION_ROLLBACK_BUSY' USING ERRCODE = '55P03';
    END $$;
  `.execute(db)
}
