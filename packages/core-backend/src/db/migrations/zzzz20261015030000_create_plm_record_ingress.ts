import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
    CREATE TABLE meta_plm_record_bindings (
      id uuid PRIMARY KEY, version bigint NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
      token_id text NOT NULL, creator_id text NOT NULL, source jsonb NOT NULL,
      sheet_id text NOT NULL UNIQUE, base_id text NOT NULL, fields jsonb NOT NULL,
      enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE meta_plm_record_rows (
      binding_id uuid NOT NULL REFERENCES meta_plm_record_bindings(id), bom_line_id text NOT NULL,
      record_id text NOT NULL UNIQUE, last_sequence bigint NOT NULL CHECK(last_sequence BETWEEN 1 AND 9007199254740991),
      PRIMARY KEY(binding_id,bom_line_id)
    );
    CREATE TABLE meta_plm_record_inbox (
      binding_id uuid NOT NULL REFERENCES meta_plm_record_bindings(id), event_id uuid NOT NULL,
      payload_hash text NOT NULL, payload jsonb NOT NULL, receipt jsonb NOT NULL,
      accepted_txid text NOT NULL DEFAULT pg_current_xact_id()::text,
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(binding_id,event_id)
    );
    CREATE FUNCTION meta_plm_protect_binding() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' OR (to_jsonb(NEW) - 'enabled') IS DISTINCT FROM (to_jsonb(OLD) - 'enabled')
         OR (NOT OLD.enabled AND NEW.enabled) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='plm_source_protected';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER meta_plm_binding_guard BEFORE UPDATE OR DELETE ON meta_plm_record_bindings
      FOR EACH ROW EXECUTE FUNCTION meta_plm_protect_binding();

    CREATE FUNCTION meta_plm_protect_record() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE b record; keys text[]; expected jsonb; receipt_id text; trusted boolean := false;
    BEGIN
      IF TG_OP='DELETE' THEN
        IF EXISTS(SELECT 1 FROM meta_plm_record_rows WHERE record_id=OLD.id) THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='plm_source_protected';
        END IF;
        RETURN OLD;
      END IF;
      IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM meta_plm_record_rows WHERE record_id=OLD.id)
         AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.sheet_id IS DISTINCT FROM OLD.sheet_id) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='plm_source_protected';
      END IF;
      SELECT * INTO b FROM meta_plm_record_bindings WHERE sheet_id=NEW.sheet_id;
      IF NOT FOUND THEN RETURN NEW; END IF;
      SELECT array_agg(value) INTO keys FROM jsonb_each_text(b.fields);
      IF TG_OP='UPDATE' AND (SELECT jsonb_object_agg(key,value) FROM jsonb_each(NEW.data) WHERE key=ANY(keys))
        IS NOT DISTINCT FROM (SELECT jsonb_object_agg(key,value) FROM jsonb_each(OLD.data) WHERE key=ANY(keys)) THEN RETURN NEW; END IF;
      IF TG_OP='INSERT' AND NOT (NEW.data ?| keys) THEN RETURN NEW; END IF;
      SELECT (SELECT jsonb_object_agg(f.value,i.payload->'cells'->f.key) FROM jsonb_each_text(b.fields) f),
             i.receipt->>'record_id' INTO expected,receipt_id
        FROM meta_plm_record_inbox i WHERE i.binding_id=b.id
          AND i.event_id::text=current_setting('metasheet.plm_ingress_event',true)
          AND i.accepted_txid=pg_current_xact_id()::text;
      trusted := receipt_id=NEW.id AND b.enabled AND NEW.data @> expected
        AND EXISTS(SELECT 1 FROM meta_plm_record_rows WHERE binding_id=b.id AND record_id=NEW.id);
      IF trusted THEN
        IF TG_OP='INSERT' AND (NEW.data-keys)='{}'::jsonb THEN RETURN NEW; END IF;
        IF TG_OP='UPDATE' AND (NEW.data-keys) IS NOT DISTINCT FROM (OLD.data-keys)
          AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by THEN RETURN NEW; END IF;
      END IF;
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='plm_source_protected';
    END $$;
    CREATE TRIGGER meta_plm_record_guard BEFORE INSERT OR UPDATE OR DELETE ON meta_records
      FOR EACH ROW EXECUTE FUNCTION meta_plm_protect_record();

    CREATE FUNCTION meta_plm_protect_field() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS(SELECT 1 FROM meta_plm_record_bindings b, jsonb_each_text(b.fields) f WHERE f.value=OLD.id) THEN
        IF TG_OP='DELETE' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.sheet_id IS DISTINCT FROM OLD.sheet_id
          OR NEW.type IS DISTINCT FROM OLD.type
          OR NOT (COALESCE(NEW.property->'readOnly','false')='true'::jsonb OR COALESCE(NEW.property->'readonly','false')='true'::jsonb) THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='plm_source_protected';
        END IF;
      END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER meta_plm_field_guard BEFORE UPDATE OR DELETE ON meta_fields
      FOR EACH ROW EXECUTE FUNCTION meta_plm_protect_field();
    CREATE FUNCTION meta_plm_protect_sheet() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS(SELECT 1 FROM meta_plm_record_bindings WHERE sheet_id=OLD.id) THEN
        IF TG_OP='DELETE' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.base_id IS DISTINCT FROM OLD.base_id
          OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='plm_source_protected';
        END IF;
      END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER meta_plm_sheet_guard BEFORE UPDATE OR DELETE ON meta_sheets
      FOR EACH ROW EXECUTE FUNCTION meta_plm_protect_sheet();
    CREATE FUNCTION meta_plm_protect_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS(SELECT 1 FROM meta_plm_record_bindings) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='plm_source_protected';
      END IF;
      RETURN NULL;
    END $$;
    CREATE TRIGGER meta_plm_records_truncate BEFORE TRUNCATE ON meta_records
      EXECUTE FUNCTION meta_plm_protect_truncate();
    CREATE TRIGGER meta_plm_fields_truncate BEFORE TRUNCATE ON meta_fields
      EXECUTE FUNCTION meta_plm_protect_truncate();
    CREATE TRIGGER meta_plm_sheets_truncate BEFORE TRUNCATE ON meta_sheets
      EXECUTE FUNCTION meta_plm_protect_truncate();
  `,
    )
    .execute(db)
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `LOCK TABLE meta_sheets,meta_fields,meta_records,meta_plm_record_bindings,meta_plm_record_rows,meta_plm_record_inbox IN ACCESS EXCLUSIVE MODE NOWAIT;
  DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM meta_plm_record_bindings) THEN
      RAISE EXCEPTION 'plm_source_evidence_present';
    END IF;
  END $$;
  DROP TRIGGER meta_plm_records_truncate ON meta_records;
  DROP TRIGGER meta_plm_fields_truncate ON meta_fields;
  DROP TRIGGER meta_plm_sheets_truncate ON meta_sheets;
  DROP TRIGGER meta_plm_record_guard ON meta_records;
  DROP TRIGGER meta_plm_field_guard ON meta_fields;
  DROP TRIGGER meta_plm_sheet_guard ON meta_sheets;
  DROP TABLE meta_plm_record_inbox,meta_plm_record_rows,meta_plm_record_bindings;
  DROP FUNCTION meta_plm_protect_binding(),meta_plm_protect_record(),meta_plm_protect_field(),meta_plm_protect_sheet(),meta_plm_protect_truncate();`,
    )
    .execute(db)
}
