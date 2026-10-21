import { sql, type Kysely } from 'kysely'

/**
 * Host-private material history, not tenant ownership or installer completeness.
 * Epochs survive deletion and empty scopes; neither equal content nor a reused
 * source id can revive an earlier authorization. Application DML may invalidate
 * an epoch, never restore its old nonce or erase it. Schema-owner DDL/disabled
 * triggers are outside this application boundary.
 *
 * Journal-owned migration: install once, in the caller's maintenance transaction.
 * Source TRUNCATE remains usable, but rotates ALL existing epochs of its kind,
 * including tombstones. This is conservative for unrelated sheets/pack scopes.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $migration$
    DECLARE
      source_names TEXT[] := ARRAY['meta_bases','meta_sheets','meta_fields',
        'plugin_multitable_object_registry','integration_stock_prep_pack_installs'];
      source_name TEXT;
      source_table REGCLASS;
      source_schema TEXT;
      owning_schema TEXT;
    BEGIN
      FOREACH source_name IN ARRAY source_names LOOP
        source_table := pg_catalog.to_regclass(source_name);
        IF source_table IS NULL THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_MATERIAL_PREREQUISITE_REQUIRED';
        END IF;
        SELECT n.nspname INTO source_schema FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE c.oid = source_table AND c.relkind = 'r' AND NOT c.relrowsecurity;
        IF source_schema IS NULL OR (owning_schema IS NOT NULL AND owning_schema <> source_schema) THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_MATERIAL_SCHEMA_INVALID';
        END IF;
        owning_schema := source_schema;
        EXECUTE pg_catalog.format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE NOWAIT', source_table);
      END LOOP;

      EXECUTE pg_catalog.format($ddl$
        CREATE TABLE %I.automation_read_material_epochs (
          kind TEXT NOT NULL,
          scope JSONB NOT NULL,
          revision UUID NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
          PRIMARY KEY (kind, scope),
          CONSTRAINT automation_read_material_scope CHECK (
            pg_catalog.jsonb_typeof(scope) = 'object' AND (
              (kind IN ('sheet','base') AND scope ? 'id'
                AND scope - 'id' = '{}'::jsonb AND pg_catalog.jsonb_typeof(scope -> 'id') = 'string')
              OR (kind = 'pack' AND scope ?& ARRAY['tenantId','projectId','objectId']
                AND scope - ARRAY['tenantId','projectId','objectId'] = '{}'::jsonb
                AND pg_catalog.jsonb_typeof(scope -> 'tenantId') = 'string'
                AND pg_catalog.jsonb_typeof(scope -> 'projectId') = 'string'
                AND pg_catalog.jsonb_typeof(scope -> 'objectId') = 'string')
            )
          )
        )
      $ddl$, owning_schema);

      -- Capture the already-present scope once while all source tables are
      -- fenced. No foreign keys: deleted identities remain permanent history.
      EXECUTE pg_catalog.format($backfill$
        INSERT INTO %1$I.automation_read_material_epochs (kind, scope)
          SELECT 'base', pg_catalog.jsonb_build_object('id', id) FROM %1$I.meta_bases
          UNION SELECT 'sheet', pg_catalog.jsonb_build_object('id', id) FROM %1$I.meta_sheets
          UNION SELECT 'sheet', pg_catalog.jsonb_build_object('id', sheet_id) FROM %1$I.meta_fields
          UNION SELECT 'sheet', pg_catalog.jsonb_build_object('id', sheet_id) FROM %1$I.plugin_multitable_object_registry
          UNION SELECT 'pack', pg_catalog.jsonb_build_object('tenantId', tenant_id,
            'projectId', project_id, 'objectId', object_id) FROM %1$I.integration_stock_prep_pack_installs
      $backfill$, owning_schema);

      EXECUTE 'CREATE FUNCTION ' || pg_catalog.quote_ident(owning_schema)
        || '.automation_read_material_epoch_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS '
        || pg_catalog.quote_literal($function$
        BEGIN
          IF TG_OP IN ('DELETE','TRUNCATE') THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_MATERIAL_HISTORY_DELETE_FORBIDDEN';
          END IF;
          IF TG_OP = 'UPDATE' AND ROW(NEW.kind, NEW.scope) IS DISTINCT FROM ROW(OLD.kind, OLD.scope) THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_MATERIAL_SCOPE_UPDATE_FORBIDDEN';
          END IF;
          -- Even direct epoch INSERT must cross the negative-lookup fence. Do
          -- not trust trigger depth/GUCs as a bypass credential. NOWAIT avoids
          -- reverse epoch -> source waits against source -> epoch readers.
          IF NEW.kind = 'sheet' THEN
            EXECUTE pg_catalog.format('LOCK TABLE %1$I.meta_sheets, %1$I.meta_fields, '
              || '%1$I.plugin_multitable_object_registry IN ROW EXCLUSIVE MODE NOWAIT', TG_TABLE_SCHEMA);
          ELSIF NEW.kind = 'base' THEN
            EXECUTE pg_catalog.format('LOCK TABLE %I.meta_bases IN ROW EXCLUSIVE MODE NOWAIT', TG_TABLE_SCHEMA);
          ELSIF NEW.kind = 'pack' THEN
            EXECUTE pg_catalog.format('LOCK TABLE %I.integration_stock_prep_pack_installs IN ROW EXCLUSIVE MODE NOWAIT', TG_TABLE_SCHEMA);
          ELSE
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_MATERIAL_SCOPE_INVALID';
          END IF;
          NEW.revision := pg_catalog.gen_random_uuid();
          RETURN NEW;
        EXCEPTION WHEN lock_not_available THEN
          RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'AUTOMATION_MATERIAL_EPOCH_WRITE_BUSY';
        END;
        $function$);
      EXECUTE pg_catalog.format('CREATE TRIGGER automation_read_material_epoch_guard '
        || 'BEFORE INSERT OR UPDATE OR DELETE ON %I.automation_read_material_epochs '
        || 'FOR EACH ROW EXECUTE FUNCTION %I.automation_read_material_epoch_guard()', owning_schema, owning_schema);
      EXECUTE pg_catalog.format('CREATE TRIGGER automation_read_material_epoch_truncate_guard '
        || 'BEFORE TRUNCATE ON %I.automation_read_material_epochs '
        || 'FOR EACH STATEMENT EXECUTE FUNCTION %I.automation_read_material_epoch_guard()', owning_schema, owning_schema);

      EXECUTE 'CREATE FUNCTION ' || pg_catalog.quote_ident(owning_schema)
        || '.automation_read_material_source_epoch() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS '
        || pg_catalog.quote_literal($function$
        DECLARE
          epoch_kind TEXT;
          old_scope JSONB;
          new_scope JSONB;
          changed_scope JSONB;
          old_row JSONB;
          new_row JSONB;
        BEGIN
          epoch_kind := CASE TG_TABLE_NAME WHEN 'meta_bases' THEN 'base'
            WHEN 'integration_stock_prep_pack_installs' THEN 'pack' ELSE 'sheet' END;
          IF TG_OP = 'TRUNCATE' THEN
            -- Empty tombstones are deliberately included. Rotating by kind
            -- also handles multi-table/cascading TRUNCATE without clearing any
            -- history or manufacturing a default scope on a read.
            FOR changed_scope IN EXECUTE pg_catalog.format(
              'SELECT scope FROM %I.automation_read_material_epochs WHERE kind = $1 ORDER BY scope', TG_TABLE_SCHEMA)
              USING epoch_kind
            LOOP
              EXECUTE pg_catalog.format('UPDATE %I.automation_read_material_epochs '
                || 'SET revision = pg_catalog.gen_random_uuid() WHERE kind = $1 AND scope = $2', TG_TABLE_SCHEMA)
                USING epoch_kind, changed_scope;
            END LOOP;
            RETURN NULL;
          END IF;
          IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
          IF TG_OP <> 'INSERT' THEN old_row := pg_catalog.to_jsonb(OLD); END IF;
          IF TG_OP <> 'DELETE' THEN new_row := pg_catalog.to_jsonb(NEW); END IF;
          IF epoch_kind = 'pack' THEN
            IF old_row IS NOT NULL THEN old_scope := pg_catalog.jsonb_build_object(
              'tenantId', old_row ->> 'tenant_id', 'projectId', old_row ->> 'project_id', 'objectId', old_row ->> 'object_id'); END IF;
            IF new_row IS NOT NULL THEN new_scope := pg_catalog.jsonb_build_object(
              'tenantId', new_row ->> 'tenant_id', 'projectId', new_row ->> 'project_id', 'objectId', new_row ->> 'object_id'); END IF;
          ELSE
            IF old_row IS NOT NULL THEN old_scope := pg_catalog.jsonb_build_object('id',
              old_row ->> CASE WHEN TG_TABLE_NAME IN ('meta_fields','plugin_multitable_object_registry') THEN 'sheet_id' ELSE 'id' END); END IF;
            IF new_row IS NOT NULL THEN new_scope := pg_catalog.jsonb_build_object('id',
              new_row ->> CASE WHEN TG_TABLE_NAME IN ('meta_fields','plugin_multitable_object_registry') THEN 'sheet_id' ELSE 'id' END); END IF;
          END IF;
          FOR changed_scope IN SELECT s.scope FROM (SELECT old_scope AS scope UNION SELECT new_scope) s
            WHERE s.scope IS NOT NULL ORDER BY s.scope
          LOOP
            EXECUTE pg_catalog.format('INSERT INTO %I.automation_read_material_epochs (kind, scope) VALUES ($1, $2) '
              || 'ON CONFLICT (kind, scope) DO UPDATE SET revision = EXCLUDED.revision', TG_TABLE_SCHEMA)
              USING epoch_kind, changed_scope;
          END LOOP;
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END;
        $function$);
      FOREACH source_name IN ARRAY source_names LOOP
        EXECUTE pg_catalog.format('CREATE TRIGGER automation_read_material_source_epoch AFTER INSERT OR UPDATE OR DELETE ON %I.%I '
          || 'FOR EACH ROW EXECUTE FUNCTION %I.automation_read_material_source_epoch()', owning_schema, source_name, owning_schema);
        EXECUTE pg_catalog.format('CREATE TRIGGER automation_read_material_source_truncate AFTER TRUNCATE ON %I.%I '
          || 'FOR EACH STATEMENT EXECUTE FUNCTION %I.automation_read_material_source_epoch()', owning_schema, source_name, owning_schema);
      END LOOP;
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'AUTOMATION_MATERIAL_MIGRATION_BUSY';
    END;
    $migration$;
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $migration$
    DECLARE
      epochs REGCLASS := pg_catalog.to_regclass('automation_read_material_epochs');
      owning_schema TEXT;
      table_name TEXT;
      history_table REGCLASS;
      has_history BOOLEAN;
    BEGIN
      IF epochs IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_MATERIAL_PREREQUISITE_REQUIRED';
      END IF;
      SELECT n.nspname INTO STRICT owning_schema FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = epochs AND c.relkind = 'r';
      -- All locks are NOWAIT: rollback is maintenance-only, not a reverse-order
      -- wait against live profile/authorization transactions. Lock history
      -- evidence before checking emptiness to prevent concurrent grant inserts.
      FOREACH table_name IN ARRAY ARRAY['meta_bases','meta_sheets','meta_fields',
        'plugin_multitable_object_registry','integration_stock_prep_pack_installs','automation_read_material_epochs'] LOOP
        EXECUTE pg_catalog.format('LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE NOWAIT', owning_schema, table_name);
      END LOOP;
      FOREACH table_name IN ARRAY ARRAY['automation_read_target_bindings','automation_read_target_profiles',
        'integration_automation_read_grants'] LOOP
        history_table := pg_catalog.to_regclass(pg_catalog.format('%I.%I', owning_schema, table_name));
        IF history_table IS NOT NULL THEN
          EXECUTE pg_catalog.format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE NOWAIT', history_table);
          EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM %s)', history_table) INTO has_history;
          IF has_history THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_MATERIAL_HISTORY_ROLLBACK_FORBIDDEN';
          END IF;
        END IF;
      END LOOP;
      FOREACH table_name IN ARRAY ARRAY['meta_bases','meta_sheets','meta_fields',
        'plugin_multitable_object_registry','integration_stock_prep_pack_installs'] LOOP
        EXECUTE pg_catalog.format('DROP TRIGGER automation_read_material_source_epoch ON %I.%I', owning_schema, table_name);
        EXECUTE pg_catalog.format('DROP TRIGGER automation_read_material_source_truncate ON %I.%I', owning_schema, table_name);
      END LOOP;
      EXECUTE pg_catalog.format('DROP FUNCTION %I.automation_read_material_source_epoch()', owning_schema);
      EXECUTE pg_catalog.format('DROP TABLE %I.automation_read_material_epochs', owning_schema);
      EXECUTE pg_catalog.format('DROP FUNCTION %I.automation_read_material_epoch_guard()', owning_schema);
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'AUTOMATION_MATERIAL_MIGRATION_BUSY';
    END;
    $migration$;
  `.execute(db)
}
