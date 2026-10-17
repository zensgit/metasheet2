import { sql, type Kysely } from 'kysely'

/**
 * Automation-only deployment bindings and one durable producer slot.
 * These are host-private automation_read_* relations, NOT the integration_ CRUD
 * namespace. They do not grant a user access to a Connection, rule or sheet.
 * Binding a target never creates a new owner role or rewrites an existing tenant.
 * No FK to meta_sheets: deleting/recreating a sheet must not erase its permanent
 * tenant anchor, profile revision or old authorization evidence.
 *
 * Journal-owned migration: a preexisting incompatible table is an error, not an
 * implicit migration/backfill. The caller owns the migration transaction.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE automation_read_producer_slot (
      slot_id SMALLINT PRIMARY KEY CHECK (slot_id = 1),
      generation BIGINT NOT NULL CHECK (generation >= 0),
      nonce UUID,
      expires_at TIMESTAMPTZ,
      CONSTRAINT automation_read_producer_shape CHECK (
        (generation = 0 AND nonce IS NULL AND expires_at IS NULL)
        OR (generation > 0 AND nonce IS NOT NULL)
      )
    );
    INSERT INTO automation_read_producer_slot (slot_id, generation, nonce, expires_at)
      VALUES (1, 0, NULL, NULL);

    CREATE TABLE automation_read_target_bindings (
      sheet_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      CONSTRAINT automation_read_target_binding_tenant UNIQUE (sheet_id, tenant_id)
    );
    CREATE TABLE automation_read_target_profiles (
      target_id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
      sheet_id TEXT NOT NULL REFERENCES automation_read_target_bindings(sheet_id),
      tenant_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      object_id TEXT NOT NULL,
      material JSONB NOT NULL CHECK (pg_catalog.jsonb_typeof(material) = 'object'),
      revision UUID NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
      producer_generation BIGINT NOT NULL CHECK (producer_generation > 0),
      producer_nonce UUID NOT NULL,
      enabled BOOLEAN NOT NULL,
      CONSTRAINT automation_read_target_profile_action UNIQUE (sheet_id, action_id),
      CONSTRAINT automation_read_target_profile_tenant FOREIGN KEY (sheet_id, tenant_id)
        REFERENCES automation_read_target_bindings(sheet_id, tenant_id)
    );

    CREATE FUNCTION automation_read_producer_guard() RETURNS TRIGGER
    LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
    DECLARE
      checked_at TIMESTAMPTZ := pg_catalog.clock_timestamp();
    BEGIN
      IF TG_OP <> 'UPDATE' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_READ_PRODUCER_HISTORY_IMMUTABLE';
      END IF;
      IF NEW.slot_id IS DISTINCT FROM OLD.slot_id THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_READ_PRODUCER_ID_IMMUTABLE';
      END IF;
      IF NEW.expires_at IS NOT NULL AND
        (NEW.expires_at <= checked_at OR NEW.expires_at > checked_at + INTERVAL '120 seconds') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_READ_PRODUCER_LEASE_INVALID';
      END IF;
      IF NEW.expires_at IS NOT NULL AND OLD.nonce IS NOT NULL AND NEW.nonce IS NOT DISTINCT FROM OLD.nonce THEN
        IF OLD.expires_at IS NULL OR OLD.expires_at <= checked_at THEN
          -- An old producer cannot revive its expired/stopped generation merely
          -- because nobody has claimed the slot yet. A fresh claim changes the
          -- requested nonce; the database replaces it with its own new nonce.
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_READ_PRODUCER_LEASE_LOST';
        END IF;
        -- Continuous, unexpired renewal does not invalidate every grant on each
        -- heartbeat. The caller cannot rewind/advance the generation itself.
        NEW.generation := OLD.generation;
        NEW.nonce := OLD.nonce;
        RETURN NEW;
      END IF;
      IF OLD.generation >= 9223372036854775807 THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_READ_PRODUCER_GENERATION_EXHAUSTED';
      END IF;
      -- First claim, explicit new producer, or stop all fence the old lifetime.
      -- Stopped rows retain this new nonce but have expires_at NULL; only the
      -- migration seed has generation=0/nonce=NULL. There is no reset surface.
      NEW.generation := OLD.generation + 1;
      NEW.nonce := pg_catalog.gen_random_uuid();
      RETURN NEW;
    END;
    $guard$;
    CREATE TRIGGER automation_read_producer_guard BEFORE INSERT OR UPDATE OR DELETE ON automation_read_producer_slot
      FOR EACH ROW EXECUTE FUNCTION automation_read_producer_guard();
    CREATE TRIGGER automation_read_producer_truncate_guard BEFORE TRUNCATE ON automation_read_producer_slot
      FOR EACH STATEMENT EXECUTE FUNCTION automation_read_producer_guard();

    CREATE FUNCTION automation_read_target_binding_guard() RETURNS TRIGGER
    LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
    BEGIN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_READ_TARGET_BINDING_IMMUTABLE';
    END;
    $guard$;
    CREATE TRIGGER automation_read_target_binding_guard BEFORE UPDATE OR DELETE ON automation_read_target_bindings
      FOR EACH ROW EXECUTE FUNCTION automation_read_target_binding_guard();
    CREATE TRIGGER automation_read_target_binding_truncate_guard BEFORE TRUNCATE ON automation_read_target_bindings
      FOR EACH STATEMENT EXECUTE FUNCTION automation_read_target_binding_guard();

    CREATE FUNCTION automation_read_target_profile_guard() RETURNS TRIGGER
    LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
    BEGIN
      IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_READ_PROFILE_HISTORY_IMMUTABLE';
      END IF;
      IF TG_OP = 'INSERT' THEN
        NEW.revision := pg_catalog.gen_random_uuid();
        RETURN NEW;
      END IF;
      IF ROW(NEW.target_id, NEW.sheet_id, NEW.tenant_id, NEW.action_id)
        IS DISTINCT FROM ROW(OLD.target_id, OLD.sheet_id, OLD.tenant_id, OLD.action_id) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_READ_PROFILE_IDENTITY_IMMUTABLE';
      END IF;
      IF ROW(NEW.project_id, NEW.object_id, NEW.material, NEW.producer_generation, NEW.producer_nonce, NEW.enabled)
        IS DISTINCT FROM ROW(OLD.project_id, OLD.object_id, OLD.material, OLD.producer_generation, OLD.producer_nonce, OLD.enabled) THEN
        NEW.revision := pg_catalog.gen_random_uuid();
      ELSE
        NEW.revision := OLD.revision;
      END IF;
      RETURN NEW;
    END;
    $guard$;
    CREATE TRIGGER automation_read_target_profile_guard BEFORE INSERT OR UPDATE OR DELETE ON automation_read_target_profiles
      FOR EACH ROW EXECUTE FUNCTION automation_read_target_profile_guard();
    CREATE TRIGGER automation_read_target_profile_truncate_guard BEFORE TRUNCATE ON automation_read_target_profiles
      FOR EACH STATEMENT EXECUTE FUNCTION automation_read_target_profile_guard();
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $migration$
    DECLARE
      slot_table REGCLASS := 'automation_read_producer_slot'::pg_catalog.regclass;
      slot_schema TEXT;
      binding_table REGCLASS;
      profile_table REGCLASS;
      grant_table REGCLASS;
      has_history BOOLEAN;
    BEGIN
      SELECT n.nspname INTO STRICT slot_schema
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE c.oid = slot_table AND c.relkind = 'r';
      binding_table := pg_catalog.format('%I.automation_read_target_bindings', slot_schema)::pg_catalog.regclass;
      profile_table := pg_catalog.format('%I.automation_read_target_profiles', slot_schema)::pg_catalog.regclass;
      grant_table := pg_catalog.to_regclass(pg_catalog.format('%I.integration_automation_read_grants', slot_schema));
      -- Maintenance-only. NOWAIT avoids a reverse-order wait cycle, and these
      -- relation locks close the empty-history check -> concurrent insert gap.
      EXECUTE pg_catalog.format('LOCK TABLE %s, %s, %s IN ACCESS EXCLUSIVE MODE NOWAIT', slot_table, binding_table, profile_table);
      IF grant_table IS NOT NULL THEN
        EXECUTE pg_catalog.format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE NOWAIT', grant_table);
        EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM %s)', grant_table) INTO has_history;
        IF has_history THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_READ_PROFILE_HISTORY_ROLLBACK_FORBIDDEN';
        END IF;
      END IF;
      EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM %s) OR EXISTS (SELECT 1 FROM %s)', binding_table, profile_table)
        INTO has_history;
      IF has_history THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_READ_PROFILE_HISTORY_ROLLBACK_FORBIDDEN';
      END IF;
      EXECUTE pg_catalog.format('DROP TABLE %s', profile_table);
      EXECUTE pg_catalog.format('DROP TABLE %s', binding_table);
      EXECUTE pg_catalog.format('DROP TABLE %s', slot_table);
      EXECUTE pg_catalog.format('DROP FUNCTION %I.automation_read_target_profile_guard()', slot_schema);
      EXECUTE pg_catalog.format('DROP FUNCTION %I.automation_read_target_binding_guard()', slot_schema);
      EXECUTE pg_catalog.format('DROP FUNCTION %I.automation_read_producer_guard()', slot_schema);
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'AUTOMATION_READ_PROFILE_MIGRATION_BUSY';
    END;
    $migration$;
  `.execute(db)
}
