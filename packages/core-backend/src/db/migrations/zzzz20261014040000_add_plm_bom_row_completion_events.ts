import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
CREATE TABLE meta_plm_bom_review_completion_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 occurrence_id uuid NOT NULL UNIQUE REFERENCES meta_plm_bom_review_completion_occurrences(id),
 binding_id uuid NOT NULL REFERENCES meta_plm_bom_review_bindings(id),
 event_type text NOT NULL CHECK(event_type='bom.review.completed'),
 granularity text NOT NULL CHECK(granularity='row'),
 webhook_id text NOT NULL, creator_id text NOT NULL,
 configuration_revision_id uuid NOT NULL REFERENCES meta_config_revisions(id),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION meta_bom_review_completion_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' OR pg_trigger_depth()<>4 THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_completion_event_protected';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER meta_bom_review_completion_event_guard BEFORE INSERT OR UPDATE OR DELETE ON meta_plm_bom_review_completion_events
 FOR EACH ROW EXECUTE FUNCTION meta_bom_review_completion_event_guard();
CREATE TRIGGER meta_bom_review_completion_event_truncate_guard BEFORE TRUNCATE ON meta_plm_bom_review_completion_events
 FOR EACH STATEMENT EXECUTE FUNCTION meta_bom_review_completion_event_guard();
CREATE FUNCTION meta_bom_review_capture_row_completion_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy record; binding record; line record;
BEGIN
 SELECT * INTO binding FROM meta_plm_bom_review_bindings WHERE id=NEW.binding_id AND status='active';
 IF NOT FOUND THEN RETURN NEW; END IF;
 SELECT c.* INTO policy FROM meta_plm_bom_review_completion_config c
  JOIN meta_config_revisions a ON a.id=c.revision_id
  WHERE c.binding_id=NEW.binding_id AND c.revision_id=NEW.configuration_revision_id
   AND c.version=NEW.configuration_version AND a.actor_id=c.updated_by AND a.sheet_id=binding.sheet_id
   AND a.entity_type='sheet_config' AND lower(a.entity_id)='plm-bom-review:'||c.binding_id::text||':completion-webhooks'
   AND a.after->'webhooks'=c.webhooks;
 IF NOT FOUND OR policy.webhooks->'reviewCompleted'->>'granularity' IS DISTINCT FROM 'row'
  OR policy.webhooks->'reviewCompleted'->'enabled' IS DISTINCT FROM 'true'::jsonb
  OR NULLIF(policy.webhooks->'reviewCompleted'->>'webhookId','') IS NULL THEN RETURN NEW; END IF;
 SELECT l.bom_line_id INTO line FROM meta_plm_bom_review_rows l JOIN meta_records r ON r.id=l.record_id
  WHERE l.binding_id=NEW.binding_id AND l.record_id=NEW.record_id AND r.sheet_id=binding.sheet_id
   AND r.data->>(binding.fields->>'sync_status')='snapshot';
 IF NOT FOUND THEN RETURN NEW; END IF;
 INSERT INTO meta_plm_bom_review_completion_events(occurrence_id,binding_id,event_type,granularity,
  webhook_id,creator_id,configuration_revision_id,payload)
 VALUES(NEW.id,NEW.binding_id,'bom.review.completed','row',policy.webhooks->'reviewCompleted'->>'webhookId',
  policy.updated_by,NEW.configuration_revision_id,jsonb_build_object(
   'event_type','bom.review.completed','granularity','row','occurrence_id',NEW.id,
   'binding_id',NEW.binding_id,'record_id',NEW.record_id,'bom_line_id',line.bom_line_id,
   'round',NEW.round,'record_version',NEW.record_version,'occurred_at',NEW.occurred_at,
   'snapshot_hash',binding.snapshot_hash,'configuration_version',NEW.configuration_version));
 RETURN NEW;
END $$;
CREATE TRIGGER meta_bom_review_capture_row_completion_event AFTER INSERT ON meta_plm_bom_review_completion_occurrences
 FOR EACH ROW EXECUTE FUNCTION meta_bom_review_capture_row_completion_event();
DO $$ DECLARE target_schema name:=current_schema(); BEGIN
 EXECUTE format('ALTER FUNCTION %I.meta_bom_review_capture_row_completion_event() SET search_path = pg_catalog, %I, pg_temp',target_schema,target_schema);
END $$;
`).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
LOCK TABLE meta_plm_bom_review_completion_events IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM meta_plm_bom_review_completion_events) THEN
 RAISE EXCEPTION 'bom_review_completion_event_evidence_present'; END IF; END $$;
DROP TRIGGER meta_bom_review_capture_row_completion_event ON meta_plm_bom_review_completion_occurrences;
DROP TABLE meta_plm_bom_review_completion_events;
DROP FUNCTION meta_bom_review_capture_row_completion_event();
DROP FUNCTION meta_bom_review_completion_event_guard();
`).execute(db)
}
