import { sql, type Kysely } from 'kysely'

/**
 * Private Automation source identity. Ordinary read-plan APIs retain their
 * existing DTOs; the private source locker alone requires these DB revisions.
 * Equal-content restore and same-id recreation cannot revive an old grant.
 * Schema-owner DDL/disabled triggers are outside the application-DML boundary.
 * Journal-owned, caller-transaction maintenance migration; no replay backfill.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $migration$
    DECLARE
      source_names TEXT[] := ARRAY['integration_stock_prep_read_plan_versions',
        'integration_stock_prep_read_plan_validations','integration_stock_prep_read_plan_activation'];
      source_name TEXT;
      source_table REGCLASS;
      source_schema TEXT;
      owning_schema TEXT;
    BEGIN
      FOREACH source_name IN ARRAY source_names LOOP
        source_table := pg_catalog.to_regclass(source_name);
        IF source_table IS NULL THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_SOURCE_EPOCH_PREREQUISITE_REQUIRED';
        END IF;
        SELECT n.nspname INTO source_schema FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE c.oid = source_table AND c.relkind = 'r' AND NOT c.relrowsecurity;
        IF source_schema IS NULL OR (owning_schema IS NOT NULL AND source_schema <> owning_schema) THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_SOURCE_EPOCH_SCHEMA_INVALID';
        END IF;
        owning_schema := source_schema;
        EXECUTE pg_catalog.format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE NOWAIT', source_table);
      END LOOP;
      EXECUTE 'CREATE FUNCTION ' || pg_catalog.quote_ident(owning_schema)
        || '.stock_prep_automation_source_epoch() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS '
        || pg_catalog.quote_literal($function$
        BEGIN
          IF TG_OP = 'INSERT' THEN
            NEW.automation_authority_revision := pg_catalog.gen_random_uuid();
          ELSIF (pg_catalog.to_jsonb(NEW) - 'automation_authority_revision')
            IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'automation_authority_revision') THEN
            NEW.automation_authority_revision := pg_catalog.gen_random_uuid();
          ELSE
            -- A caller cannot restore an old nonce by writing only this column;
            -- genuine no-ops preserve current identity, not the supplied value.
            NEW.automation_authority_revision := OLD.automation_authority_revision;
          END IF;
          RETURN NEW;
        END;
        $function$);
      FOREACH source_name IN ARRAY source_names LOOP
        -- Volatile default gives each existing row a distinct initial nonce.
        -- There are no existing legitimate Automation grants carrying this
        -- previously absent identity; this is not an authorization backfill.
        EXECUTE pg_catalog.format('ALTER TABLE %I.%I ADD COLUMN automation_authority_revision UUID NOT NULL '
          || 'DEFAULT pg_catalog.gen_random_uuid()', owning_schema, source_name);
        EXECUTE pg_catalog.format('CREATE TRIGGER stock_prep_automation_source_epoch BEFORE INSERT OR UPDATE ON %I.%I '
          || 'FOR EACH ROW EXECUTE FUNCTION %I.stock_prep_automation_source_epoch()', owning_schema, source_name, owning_schema);
      END LOOP;
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'AUTOMATION_SOURCE_EPOCH_MIGRATION_BUSY';
    END;
    $migration$;
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $migration$
    DECLARE
      versions REGCLASS := pg_catalog.to_regclass('integration_stock_prep_read_plan_versions');
      owning_schema TEXT;
      table_name TEXT;
      grants REGCLASS;
      has_history BOOLEAN;
    BEGIN
      IF versions IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_SOURCE_EPOCH_PREREQUISITE_REQUIRED';
      END IF;
      SELECT n.nspname INTO STRICT owning_schema FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = versions AND c.relkind = 'r';
      -- NOWAIT avoids reverse-order waits against source -> grant consumers.
      -- Lock the real same-schema grant table before its empty-history check;
      -- a search_path shadow cannot conceal retained source authorization.
      FOREACH table_name IN ARRAY ARRAY['integration_stock_prep_read_plan_versions',
        'integration_stock_prep_read_plan_validations','integration_stock_prep_read_plan_activation'] LOOP
        EXECUTE pg_catalog.format('LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE NOWAIT', owning_schema, table_name);
      END LOOP;
      grants := pg_catalog.to_regclass(pg_catalog.format('%I.integration_automation_read_grants', owning_schema));
      IF grants IS NOT NULL THEN
        EXECUTE pg_catalog.format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE NOWAIT', grants);
        EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM %s)', grants) INTO has_history;
        IF has_history THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_SOURCE_EPOCH_HISTORY_ROLLBACK_FORBIDDEN';
        END IF;
      END IF;
      FOREACH table_name IN ARRAY ARRAY['integration_stock_prep_read_plan_versions',
        'integration_stock_prep_read_plan_validations','integration_stock_prep_read_plan_activation'] LOOP
        EXECUTE pg_catalog.format('DROP TRIGGER stock_prep_automation_source_epoch ON %I.%I', owning_schema, table_name);
        EXECUTE pg_catalog.format('ALTER TABLE %I.%I DROP COLUMN automation_authority_revision', owning_schema, table_name);
      END LOOP;
      EXECUTE pg_catalog.format('DROP FUNCTION %I.stock_prep_automation_source_epoch()', owning_schema);
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'AUTOMATION_SOURCE_EPOCH_MIGRATION_BUSY';
    END;
    $migration$;
  `.execute(db)
}
