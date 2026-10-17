import { sql, type Kysely } from 'kysely'
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
CREATE TABLE meta_plm_bom_review_previews (
 id uuid PRIMARY KEY, actor_id text NOT NULL, data_source_id text NOT NULL, part_id text NOT NULL,
 base_id text NOT NULL, name text NOT NULL, source_fingerprint text NOT NULL, snapshot_hash text NOT NULL,
 source jsonb NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 request_id uuid UNIQUE, binding_id uuid
);
CREATE TABLE meta_plm_bom_review_bindings (
 id uuid PRIMARY KEY, data_source_id text NOT NULL, part_id text NOT NULL, creator_id text NOT NULL,
 source_fingerprint text NOT NULL, source jsonb NOT NULL, base_id text NOT NULL, sheet_id text NOT NULL UNIQUE,
 view_id text NOT NULL, name text NOT NULL, fields jsonb NOT NULL,
 version bigint NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740991),
 status text NOT NULL CHECK(status IN ('active','stale','disabled')),
 snapshot_hash text NOT NULL, last_synced_at timestamptz NOT NULL,
 last_failure_code text, last_failure_at timestamptz,
 line_count integer NOT NULL, occurrence_count integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE meta_plm_bom_review_rows (
 binding_id uuid NOT NULL REFERENCES meta_plm_bom_review_bindings(id), bom_line_id text NOT NULL,
 record_id text NOT NULL UNIQUE, PRIMARY KEY(binding_id,bom_line_id)
);
CREATE TABLE meta_plm_bom_review_syncs (
 id uuid PRIMARY KEY, binding_id uuid NOT NULL REFERENCES meta_plm_bom_review_bindings(id),
 patches jsonb NOT NULL, actor_id text NOT NULL, accepted_txid text NOT NULL DEFAULT pg_current_xact_id()::text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meta_plm_bom_review_source ON meta_plm_bom_review_bindings(data_source_id,part_id);
CREATE FUNCTION meta_bom_review_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['status','version','snapshot_hash','last_synced_at','last_failure_code','last_failure_at','line_count','occurrence_count'])
 IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','version','snapshot_hash','last_synced_at','last_failure_code','last_failure_at','line_count','occurrence_count'])
 OR (OLD.status='disabled' AND NEW.status<>'disabled') THEN
 RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_source_protected'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER meta_bom_review_binding_guard BEFORE UPDATE OR DELETE ON meta_plm_bom_review_bindings
 FOR EACH ROW EXECUTE FUNCTION meta_bom_review_binding_guard();
CREATE FUNCTION meta_bom_review_record_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b record; keys text[]; expected jsonb; new_source jsonb; old_source jsonb;
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM meta_plm_bom_review_rows WHERE record_id=OLD.id) THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_source_protected'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM meta_plm_bom_review_rows WHERE record_id=OLD.id)
  AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.sheet_id IS DISTINCT FROM OLD.sheet_id) THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_source_protected'; END IF;
 SELECT * INTO b FROM meta_plm_bom_review_bindings WHERE sheet_id=NEW.sheet_id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 SELECT array_agg(value) INTO keys FROM jsonb_each_text(b.fields);
 SELECT jsonb_object_agg(key,value) INTO new_source FROM jsonb_each(NEW.data) WHERE key=ANY(keys);
 IF TG_OP='UPDATE' THEN
  SELECT jsonb_object_agg(key,value) INTO old_source FROM jsonb_each(OLD.data) WHERE key=ANY(keys);
  IF new_source IS NOT DISTINCT FROM old_source THEN RETURN NEW; END IF;
 ELSE
  IF NOT (NEW.data ?| keys) THEN RETURN NEW; END IF;
 END IF;
 SELECT s.patches->NEW.id INTO expected FROM meta_plm_bom_review_syncs s
  WHERE s.binding_id=b.id AND s.id::text=current_setting('metasheet.bom_review_sync',true)
   AND s.accepted_txid=pg_current_xact_id()::text;
 IF expected IS NOT NULL AND new_source=expected AND b.status<>'disabled'
  AND EXISTS(SELECT 1 FROM meta_plm_bom_review_rows WHERE binding_id=b.id AND record_id=NEW.id) THEN
  IF TG_OP='INSERT' AND NEW.data-keys='{}'::jsonb THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.data-keys IS NOT DISTINCT FROM OLD.data-keys AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_source_protected';
END $$;
CREATE TRIGGER meta_bom_review_record_guard BEFORE INSERT OR UPDATE OR DELETE ON meta_records
 FOR EACH ROW EXECUTE FUNCTION meta_bom_review_record_guard();
CREATE FUNCTION meta_bom_review_field_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM meta_plm_bom_review_bindings b, jsonb_each_text(b.fields) f WHERE f.value=OLD.id) THEN
  IF TG_OP='DELETE' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.sheet_id IS DISTINCT FROM OLD.sheet_id OR NEW.type IS DISTINCT FROM OLD.type
   OR NOT(COALESCE(NEW.property->'readOnly','false')='true'::jsonb OR COALESCE(NEW.property->'readonly','false')='true'::jsonb) THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_source_protected'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$;
CREATE TRIGGER meta_bom_review_field_guard BEFORE UPDATE OR DELETE ON meta_fields
 FOR EACH ROW EXECUTE FUNCTION meta_bom_review_field_guard();
CREATE FUNCTION meta_bom_review_sheet_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM meta_plm_bom_review_bindings WHERE sheet_id=OLD.id) THEN
  IF TG_OP='DELETE' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.base_id IS DISTINCT FROM OLD.base_id OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_source_protected'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$;
CREATE TRIGGER meta_bom_review_sheet_guard BEFORE UPDATE OR DELETE ON meta_sheets
 FOR EACH ROW EXECUTE FUNCTION meta_bom_review_sheet_guard();
CREATE FUNCTION meta_bom_review_base_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM meta_plm_bom_review_bindings WHERE base_id=OLD.id) THEN
  IF TG_OP='DELETE' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_source_protected'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$;
CREATE TRIGGER meta_bom_review_base_guard BEFORE UPDATE OR DELETE ON meta_bases
 FOR EACH ROW EXECUTE FUNCTION meta_bom_review_base_guard();
CREATE FUNCTION meta_bom_review_truncate_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM meta_plm_bom_review_bindings) THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_source_protected'; END IF; RETURN NULL; END $$;
CREATE TRIGGER meta_bom_review_records_truncate BEFORE TRUNCATE ON meta_records EXECUTE FUNCTION meta_bom_review_truncate_guard();
CREATE TRIGGER meta_bom_review_fields_truncate BEFORE TRUNCATE ON meta_fields EXECUTE FUNCTION meta_bom_review_truncate_guard();
CREATE TRIGGER meta_bom_review_sheets_truncate BEFORE TRUNCATE ON meta_sheets EXECUTE FUNCTION meta_bom_review_truncate_guard();
CREATE TRIGGER meta_bom_review_bases_truncate BEFORE TRUNCATE ON meta_bases EXECUTE FUNCTION meta_bom_review_truncate_guard();
`,
    )
    .execute(db)
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `DO $$ BEGIN IF EXISTS(SELECT 1 FROM meta_plm_bom_review_bindings) THEN RAISE EXCEPTION 'bom_review_source_evidence_present'; END IF; END $$;
DROP TRIGGER meta_bom_review_records_truncate ON meta_records;
DROP TRIGGER meta_bom_review_fields_truncate ON meta_fields;
DROP TRIGGER meta_bom_review_sheets_truncate ON meta_sheets;
DROP TRIGGER meta_bom_review_bases_truncate ON meta_bases;
DROP TRIGGER meta_bom_review_record_guard ON meta_records;
DROP TRIGGER meta_bom_review_field_guard ON meta_fields;
DROP TRIGGER meta_bom_review_sheet_guard ON meta_sheets;
DROP TRIGGER meta_bom_review_base_guard ON meta_bases;
DROP TABLE meta_plm_bom_review_syncs,meta_plm_bom_review_rows,meta_plm_bom_review_bindings,meta_plm_bom_review_previews;
DROP FUNCTION meta_bom_review_binding_guard(),meta_bom_review_record_guard(),meta_bom_review_field_guard(),meta_bom_review_sheet_guard(),meta_bom_review_base_guard(),meta_bom_review_truncate_guard();`,
    )
    .execute(db)
}
