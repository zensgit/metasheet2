import { sql, type Kysely } from 'kysely'

/** Optional schema-at-write evidence on the existing private raw snapshot. No backfill and no new
 * condition authorization. Install after 130/138 and before the capturing producer code.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`DO $migration$
    DECLARE capture_schema TEXT; consistent BOOLEAN;
    BEGIN
      SELECT n.nspname INTO STRICT capture_schema FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid='meta_automation_record_after_images'::pg_catalog.regclass;
      SELECT count(c.oid)=5 AND count(DISTINCT c.relnamespace)=1
        AND bool_and(c.relkind='r' AND NOT c.relrowsecurity) INTO consistent
        FROM unnest(ARRAY['meta_sheets','meta_fields','plugin_multitable_object_registry',
          'automation_read_material_epochs','meta_automation_record_after_images']) AS expected(name)
        LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(expected.name);
      IF consistent IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='AUTOMATION_RECORD_SCHEMA_UNAVAILABLE';
      END IF;
      EXECUTE pg_catalog.replace($ddl$
        ALTER TABLE __SCHEMA__.meta_automation_record_after_images ADD COLUMN schema_revision UUID;
        CREATE FUNCTION __SCHEMA__.automation_record_schema_insert() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
          DECLARE current_revision UUID; sheet_live BOOLEAN; consistent BOOLEAN;
          BEGIN
            -- Legacy / unavailable evidence stays NULL. Never fill it from a later schema.
            IF NEW.schema_revision IS NULL THEN RETURN NEW; END IF;
            IF pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
              RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='AUTOMATION_RECORD_SCHEMA_REVISION_INVALID';
            END IF;
            EXECUTE pg_catalog.format('LOCK TABLE %1$I.meta_sheets, %1$I.meta_fields, '
              || '%1$I.plugin_multitable_object_registry IN SHARE MODE NOWAIT',TG_TABLE_SCHEMA);
            SELECT count(c.oid)=4 AND bool_and(c.relkind='r' AND NOT c.relrowsecurity)
              INTO consistent FROM unnest(ARRAY['meta_sheets','meta_fields',
                'plugin_multitable_object_registry','automation_read_material_epochs']) AS expected(name)
              LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(
                pg_catalog.format('%I.%I',TG_TABLE_SCHEMA,expected.name));
            IF consistent IS DISTINCT FROM TRUE THEN
              RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='AUTOMATION_RECORD_SCHEMA_REVISION_INVALID';
            END IF;
            EXECUTE pg_catalog.format('SELECT deleted_at IS NULL FROM %I.meta_sheets WHERE id=$1',TG_TABLE_SCHEMA)
              INTO sheet_live USING NEW.sheet_id;
            EXECUTE pg_catalog.format('SELECT revision FROM %I.automation_read_material_epochs '
              || 'WHERE kind=''sheet'' AND scope=pg_catalog.jsonb_build_object(''id'',$1::text) FOR SHARE NOWAIT',TG_TABLE_SCHEMA)
              INTO current_revision USING NEW.sheet_id;
            IF sheet_live IS DISTINCT FROM TRUE OR current_revision IS DISTINCT FROM NEW.schema_revision THEN
              RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='AUTOMATION_RECORD_SCHEMA_REVISION_INVALID';
            END IF;
            RETURN NEW;
          END $function$;
        CREATE TRIGGER automation_record_schema_insert BEFORE INSERT
          ON __SCHEMA__.meta_automation_record_after_images FOR EACH ROW
          EXECUTE FUNCTION __SCHEMA__.automation_record_schema_insert();
      $ddl$,'__SCHEMA__',pg_catalog.quote_ident(capture_schema));
    END $migration$;`).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`DO $migration$
    DECLARE capture_schema TEXT; has_history BOOLEAN;
    BEGIN
      SELECT n.nspname INTO STRICT capture_schema FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid='meta_automation_record_after_images'::pg_catalog.regclass;
      EXECUTE pg_catalog.format('LOCK TABLE %I.meta_automation_record_after_images IN ACCESS EXCLUSIVE MODE NOWAIT',capture_schema);
      EXECUTE pg_catalog.format('SELECT EXISTS(SELECT 1 FROM %I.meta_automation_record_after_images '
        || 'WHERE schema_revision IS NOT NULL)',capture_schema) INTO has_history;
      IF has_history THEN
        RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='AUTOMATION_RECORD_SCHEMA_HAS_HISTORY';
      END IF;
      EXECUTE pg_catalog.format('DROP TRIGGER automation_record_schema_insert ON %I.meta_automation_record_after_images',capture_schema);
      EXECUTE pg_catalog.format('DROP FUNCTION %I.automation_record_schema_insert()',capture_schema);
      EXECUTE pg_catalog.format('ALTER TABLE %I.meta_automation_record_after_images DROP COLUMN schema_revision',capture_schema);
    END $migration$;`).execute(db)
}
