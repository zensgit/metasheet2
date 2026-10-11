import { sql, type Kysely } from 'kysely'

/** Private raw DML evidence. No old-event backfill and no activation/condition gate changes.
 * Deploy before the producer code. Parent deletion cascades; this adds no automatic retention job.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`DO $migration$
    DECLARE outbox_schema TEXT;
    BEGIN
      SELECT n.nspname INTO STRICT outbox_schema FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid='meta_automation_outbox'::pg_catalog.regclass;
      EXECUTE pg_catalog.replace($ddl$
        CREATE TABLE __SCHEMA__.meta_automation_record_after_images (
          outbox_id TEXT PRIMARY KEY REFERENCES __SCHEMA__.meta_automation_outbox(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL CHECK(event_type IN ('multitable.record.created','multitable.record.updated')),
          event_id TEXT NOT NULL,
          sheet_id TEXT NOT NULL CHECK(length(sheet_id) BETWEEN 1 AND 256),
          record_id TEXT NOT NULL CHECK(length(record_id) BETWEEN 1 AND 256),
          record_version BIGINT NOT NULL CHECK(record_version BETWEEN 1 AND 9007199254740991),
          format_version SMALLINT NOT NULL DEFAULT 1 CHECK(format_version=1),
          status TEXT NOT NULL CHECK(status IN ('captured','unavailable')),
          reason TEXT,
          after_image JSONB,
          captured_bytes INTEGER NOT NULL,
          capture_xid XID8 NOT NULL DEFAULT pg_catalog.pg_current_xact_id(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
          CONSTRAINT automation_record_after_image_shape CHECK (
            (status='captured' AND reason IS NULL AND after_image IS NOT NULL
              AND pg_catalog.jsonb_typeof(after_image)='object'
              AND captured_bytes=octet_length(after_image::text) AND captured_bytes BETWEEN 2 AND 262144)
            OR (status='unavailable' AND reason IN ('invalid_data','value_limits','batch_limits')
              AND reason IS NOT NULL AND after_image IS NULL AND captured_bytes=0)
          )
        );
        CREATE INDEX automation_record_after_images_xid ON __SCHEMA__.meta_automation_record_after_images(capture_xid);
        REVOKE ALL ON __SCHEMA__.meta_automation_record_after_images FROM PUBLIC;
        CREATE FUNCTION __SCHEMA__.automation_record_after_image_insert() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
          DECLARE event_row JSONB;
          BEGIN
            EXECUTE pg_catalog.format('SELECT pg_catalog.to_jsonb(o) FROM %I.meta_automation_outbox o WHERE id=$1 FOR SHARE',TG_TABLE_SCHEMA)
              INTO event_row USING NEW.outbox_id;
            IF event_row IS NULL OR event_row->>'event_type' IS DISTINCT FROM NEW.event_type
              OR event_row->>'event_id' IS DISTINCT FROM NEW.event_id
              OR pg_catalog.jsonb_typeof(event_row->'payload'->'sheetId') IS DISTINCT FROM 'string'
              OR pg_catalog.jsonb_typeof(event_row->'payload'->'recordId') IS DISTINCT FROM 'string'
              OR event_row->'payload'->>'sheetId' IS DISTINCT FROM NEW.sheet_id
              OR event_row->'payload'->>'recordId' IS DISTINCT FROM NEW.record_id THEN
              RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='AUTOMATION_RECORD_AFTER_IMAGE_IDENTITY_INVALID';
            END IF;
            NEW.capture_xid:=pg_catalog.pg_current_xact_id();
            NEW.created_at:=pg_catalog.clock_timestamp();
            RETURN NEW;
          END $function$;
        CREATE FUNCTION __SCHEMA__.automation_record_after_image_immutable() RETURNS TRIGGER
          LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
          BEGIN
            RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='AUTOMATION_RECORD_AFTER_IMAGE_IMMUTABLE';
          END $function$;
        CREATE TRIGGER automation_record_after_image_insert BEFORE INSERT
          ON __SCHEMA__.meta_automation_record_after_images FOR EACH ROW
          EXECUTE FUNCTION __SCHEMA__.automation_record_after_image_insert();
        CREATE TRIGGER automation_record_after_image_immutable BEFORE UPDATE
          ON __SCHEMA__.meta_automation_record_after_images FOR EACH ROW
          EXECUTE FUNCTION __SCHEMA__.automation_record_after_image_immutable();
      $ddl$,'__SCHEMA__',pg_catalog.quote_ident(outbox_schema));
    END $migration$;`).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`DO $migration$
    DECLARE capture_schema TEXT; has_history BOOLEAN;
    BEGIN
      SELECT n.nspname INTO STRICT capture_schema FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid='meta_automation_record_after_images'::pg_catalog.regclass;
      EXECUTE pg_catalog.format('LOCK TABLE %I.meta_automation_record_after_images IN ACCESS EXCLUSIVE MODE',capture_schema);
      EXECUTE pg_catalog.format('SELECT EXISTS(SELECT 1 FROM %I.meta_automation_record_after_images)',capture_schema) INTO has_history;
      IF has_history THEN
        RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='AUTOMATION_RECORD_AFTER_IMAGE_HAS_HISTORY';
      END IF;
      EXECUTE pg_catalog.format('DROP TABLE %I.meta_automation_record_after_images',capture_schema);
      EXECUTE pg_catalog.format('DROP FUNCTION %I.automation_record_after_image_insert()',capture_schema);
      EXECUTE pg_catalog.format('DROP FUNCTION %I.automation_record_after_image_immutable()',capture_schema);
    END $migration$;`).execute(db)
}
