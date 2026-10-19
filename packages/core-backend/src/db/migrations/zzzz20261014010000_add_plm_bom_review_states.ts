import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
CREATE TABLE meta_plm_bom_review_state_fields (
 binding_id uuid PRIMARY KEY REFERENCES meta_plm_bom_review_bindings(id),
 field_id text NOT NULL UNIQUE REFERENCES meta_fields(id),
 owner_field_id text NOT NULL UNIQUE REFERENCES meta_fields(id),
 due_field_id text NOT NULL UNIQUE REFERENCES meta_fields(id)
);
CREATE FUNCTION meta_bom_review_state_mapping_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  IF EXISTS(SELECT 1 FROM meta_plm_bom_review_bindings b JOIN meta_fields f ON f.sheet_id=b.sheet_id
   WHERE b.id=NEW.binding_id AND f.id=NEW.field_id AND f.type='select'
    AND f.property->'options'='[{"value":"待评审"},{"value":"评审中"},{"value":"有问题"},{"value":"已完成"}]'::jsonb
    AND EXISTS(SELECT 1 FROM meta_fields owner WHERE owner.id=NEW.owner_field_id AND owner.sheet_id=b.sheet_id AND owner.type='person')
    AND EXISTS(SELECT 1 FROM meta_fields due WHERE due.id=NEW.due_field_id AND due.sheet_id=b.sheet_id AND due.type IN ('datetime','dateTime'))
    AND NOT EXISTS(SELECT 1 FROM jsonb_each_text(b.fields) source WHERE source.value IN (NEW.field_id,NEW.owner_field_id,NEW.due_field_id))) THEN
   RETURN NEW;
  END IF;
 END IF;
 RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_state_mapping_protected';
END $$;
CREATE TRIGGER meta_bom_review_state_mapping_guard BEFORE INSERT OR UPDATE OR DELETE ON meta_plm_bom_review_state_fields
 FOR EACH ROW EXECUTE FUNCTION meta_bom_review_state_mapping_guard();
CREATE TRIGGER meta_bom_review_state_mapping_truncate_guard BEFORE TRUNCATE ON meta_plm_bom_review_state_fields
 FOR EACH STATEMENT EXECUTE FUNCTION meta_bom_review_state_mapping_guard();
CREATE FUNCTION meta_bom_review_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE field text; previous text; next text;
BEGIN
 IF TG_OP='UPDATE' AND NEW.sheet_id IS DISTINCT FROM OLD.sheet_id AND EXISTS(
  SELECT 1 FROM meta_plm_bom_review_state_fields m JOIN meta_plm_bom_review_bindings b ON b.id=m.binding_id
   WHERE b.sheet_id IN (OLD.sheet_id,NEW.sheet_id)
 ) THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_state_transition_invalid';
 END IF;
 SELECT m.field_id INTO field FROM meta_plm_bom_review_state_fields m
 JOIN meta_plm_bom_review_bindings b ON b.id=m.binding_id
 WHERE b.sheet_id=NEW.sheet_id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.data->field IS NULL OR NEW.data->field='null'::jsonb OR NEW.data->>field='' THEN
   NEW.data=jsonb_set(NEW.data,ARRAY[field],to_jsonb('待评审'::text));
  END IF;
  IF NEW.data->field IS DISTINCT FROM to_jsonb('待评审'::text) THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_state_transition_invalid';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.data->field IS NOT DISTINCT FROM OLD.data->field THEN RETURN NEW; END IF;
 previous=OLD.data->>field; next=NEW.data->>field;
 IF jsonb_typeof(NEW.data->field)='string' AND (
   (previous='待评审' AND next='评审中') OR
   (previous='评审中' AND next IN ('有问题','已完成')) OR
   (previous='有问题' AND next IN ('评审中','已完成')) OR
   (previous='已完成' AND next='评审中')
 ) THEN RETURN NEW; END IF;
 RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_state_transition_invalid';
END $$;
-- Runs after the existing source guard, which validates the exact source-only initial sync.
CREATE TRIGGER meta_bom_review_state_guard BEFORE INSERT OR UPDATE ON meta_records
 FOR EACH ROW EXECUTE FUNCTION meta_bom_review_state_guard();
CREATE FUNCTION meta_bom_review_state_field_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM meta_plm_bom_review_state_fields WHERE OLD.id IN (field_id,owner_field_id,due_field_id)) THEN
  IF TG_OP='DELETE' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.sheet_id IS DISTINCT FROM OLD.sheet_id
   OR NEW.type IS DISTINCT FROM OLD.type OR (EXISTS(SELECT 1 FROM meta_plm_bom_review_state_fields WHERE field_id=OLD.id)
    AND NEW.property->'options' IS DISTINCT FROM OLD.property->'options') THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_state_mapping_protected';
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER meta_bom_review_state_field_guard BEFORE UPDATE OR DELETE ON meta_fields
 FOR EACH ROW EXECUTE FUNCTION meta_bom_review_state_field_guard();
CREATE TABLE meta_plm_bom_review_rounds (
 record_id text NOT NULL REFERENCES meta_records(id), binding_id uuid NOT NULL REFERENCES meta_plm_bom_review_bindings(id),
 round bigint NOT NULL CHECK(round BETWEEN 1 AND 9007199254740991),
 opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 issue_started_at timestamptz, issue_owner_ids jsonb, issue_record_version bigint, completed_at timestamptz,
 PRIMARY KEY(record_id,round),
 CHECK((issue_started_at IS NULL AND issue_owner_ids IS NULL AND issue_record_version IS NULL)
  OR (issue_started_at IS NOT NULL AND jsonb_typeof(issue_owner_ids)='array' AND issue_record_version IS NOT NULL))
);
CREATE TABLE meta_plm_bom_review_notification_config (
 binding_id uuid PRIMARY KEY REFERENCES meta_plm_bom_review_bindings(id),
 version bigint NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
 notifications jsonb NOT NULL CHECK(jsonb_typeof(notifications)='object'),
 updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 revision_id uuid NOT NULL REFERENCES meta_config_revisions(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE meta_plm_bom_review_notification_events (
 id uuid PRIMARY KEY, binding_id uuid NOT NULL REFERENCES meta_plm_bom_review_bindings(id),
 record_id text NOT NULL REFERENCES meta_records(id), round bigint NOT NULL,
 kind text NOT NULL CHECK(kind IN ('issue','reminder','escalation')),
 occurrence_key text NOT NULL, configuration_version bigint NOT NULL,
 configuration_revision_id uuid NOT NULL REFERENCES meta_config_revisions(id), creator_id text NOT NULL,
 owner_ids jsonb NOT NULL CHECK(jsonb_typeof(owner_ids)='array'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(record_id,round,kind,occurrence_key),
 FOREIGN KEY(record_id,round) REFERENCES meta_plm_bom_review_rounds(record_id,round)
);
CREATE TABLE meta_plm_bom_review_notification_intents (
 event_id uuid PRIMARY KEY REFERENCES meta_plm_bom_review_notification_events(id),
 recipient_ids jsonb NOT NULL CHECK(jsonb_typeof(recipient_ids)='array'),
 state text NOT NULL CHECK(state IN ('prepared','delivered','cancelled')),
 cancellation_reason text, prepared_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz
);
CREATE FUNCTION meta_bom_review_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_intent_protected';
 END IF;
 IF OLD.state<>'prepared' OR NEW.state NOT IN ('delivered','cancelled')
  OR (to_jsonb(NEW)-ARRAY['state','cancellation_reason','delivered_at'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','cancellation_reason','delivered_at']) THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_intent_protected';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER meta_bom_review_intent_guard BEFORE UPDATE OR DELETE ON meta_plm_bom_review_notification_intents
 FOR EACH ROW EXECUTE FUNCTION meta_bom_review_intent_guard();
CREATE TRIGGER meta_bom_review_intent_truncate_guard BEFORE TRUNCATE ON meta_plm_bom_review_notification_intents
 FOR EACH STATEMENT EXECUTE FUNCTION meta_bom_review_intent_guard();
ALTER TABLE meta_record_subscription_notifications ADD COLUMN source_event_id text;
CREATE UNIQUE INDEX idx_record_notifications_source ON meta_record_subscription_notifications(source_event_id,user_id) WHERE source_event_id IS NOT NULL;
CREATE FUNCTION meta_bom_review_round_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') OR pg_trigger_depth()<>2 THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_round_protected';
 END IF;
 IF TG_OP='UPDATE' AND (
  (to_jsonb(NEW)-ARRAY['issue_started_at','issue_owner_ids','issue_record_version','completed_at'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['issue_started_at','issue_owner_ids','issue_record_version','completed_at'])
  OR (OLD.issue_started_at IS NOT NULL AND
   (NEW.issue_started_at,NEW.issue_owner_ids,NEW.issue_record_version) IS DISTINCT FROM
   (OLD.issue_started_at,OLD.issue_owner_ids,OLD.issue_record_version))
  OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
 ) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_round_protected'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER meta_bom_review_round_guard BEFORE INSERT OR UPDATE OR DELETE ON meta_plm_bom_review_rounds
 FOR EACH ROW EXECUTE FUNCTION meta_bom_review_round_guard();
CREATE TRIGGER meta_bom_review_round_truncate_guard BEFORE TRUNCATE ON meta_plm_bom_review_rounds
 FOR EACH STATEMENT EXECUTE FUNCTION meta_bom_review_round_guard();
CREATE FUNCTION meta_bom_review_track_round() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mapping record; current_round bigint; previous text; next text;
BEGIN
 SELECT m.* INTO mapping FROM meta_plm_bom_review_state_fields m
  JOIN meta_plm_bom_review_bindings b ON b.id=m.binding_id WHERE b.sheet_id=NEW.sheet_id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  INSERT INTO meta_plm_bom_review_rounds(record_id,binding_id,round) VALUES(NEW.id,mapping.binding_id,1);
  RETURN NEW;
 END IF;
 IF NEW.data->mapping.field_id IS NOT DISTINCT FROM OLD.data->mapping.field_id THEN RETURN NEW; END IF;
 SELECT round INTO current_round FROM meta_plm_bom_review_rounds WHERE record_id=NEW.id ORDER BY round DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_round_missing'; END IF;
 previous=OLD.data->>mapping.field_id; next=NEW.data->>mapping.field_id;
 IF previous='已完成' AND next='评审中' THEN
  INSERT INTO meta_plm_bom_review_rounds(record_id,binding_id,round) VALUES(NEW.id,mapping.binding_id,current_round+1);
 ELSIF next='有问题' THEN
  UPDATE meta_plm_bom_review_rounds SET issue_started_at=clock_timestamp(),
   issue_owner_ids=COALESCE(NULLIF(NEW.data->mapping.owner_field_id,'null'::jsonb),'[]'::jsonb),
   issue_record_version=NEW.version
  WHERE record_id=NEW.id AND round=current_round AND issue_started_at IS NULL;
 ELSIF next='已完成' THEN
  UPDATE meta_plm_bom_review_rounds SET completed_at=clock_timestamp()
   WHERE record_id=NEW.id AND round=current_round AND completed_at IS NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER meta_bom_review_track_round AFTER INSERT OR UPDATE ON meta_records
 FOR EACH ROW EXECUTE FUNCTION meta_bom_review_track_round();
DO $$ DECLARE target_schema name:=current_schema(); BEGIN
 EXECUTE format('ALTER FUNCTION %I.meta_bom_review_state_mapping_guard() SET search_path = pg_catalog, %I, pg_temp',target_schema,target_schema);
 EXECUTE format('ALTER FUNCTION %I.meta_bom_review_state_guard() SET search_path = pg_catalog, %I, pg_temp',target_schema,target_schema);
 EXECUTE format('ALTER FUNCTION %I.meta_bom_review_state_field_guard() SET search_path = pg_catalog, %I, pg_temp',target_schema,target_schema);
 EXECUTE format('ALTER FUNCTION %I.meta_bom_review_track_round() SET search_path = pg_catalog, %I, pg_temp',target_schema,target_schema);
 EXECUTE format('ALTER FUNCTION %I.meta_bom_review_round_guard() SET search_path = pg_catalog, %I, pg_temp',target_schema,target_schema);
END $$;
`).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
LOCK TABLE meta_plm_bom_review_state_fields IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM meta_plm_bom_review_state_fields)
 OR EXISTS(SELECT 1 FROM meta_record_subscription_notifications WHERE source_event_id IS NOT NULL) THEN
 RAISE EXCEPTION 'bom_review_state_mapping_present'; END IF; END $$;
DROP TRIGGER meta_bom_review_state_guard ON meta_records;
DROP TRIGGER meta_bom_review_state_field_guard ON meta_fields;
DROP TRIGGER meta_bom_review_track_round ON meta_records;
DROP TABLE meta_plm_bom_review_notification_intents;
DROP FUNCTION meta_bom_review_intent_guard();
DROP INDEX idx_record_notifications_source;
ALTER TABLE meta_record_subscription_notifications DROP COLUMN source_event_id;
DROP TABLE meta_plm_bom_review_notification_events;
DROP TABLE meta_plm_bom_review_rounds;
DROP TABLE meta_plm_bom_review_notification_config;
DROP TABLE meta_plm_bom_review_state_fields;
DROP FUNCTION meta_bom_review_state_mapping_guard(),meta_bom_review_state_guard(),meta_bom_review_state_field_guard(),meta_bom_review_track_round(),meta_bom_review_round_guard();
`).execute(db)
}
