import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
ALTER TABLE meta_plm_bom_review_completion_events
 ALTER COLUMN occurrence_id DROP NOT NULL,
 ADD COLUMN plm_event_id uuid,
 DROP CONSTRAINT meta_plm_bom_review_completion_events_event_type_check,
 DROP CONSTRAINT meta_plm_bom_review_completion_events_granularity_check,
 ADD CONSTRAINT plm_completion_origin CHECK (
  (event_type='bom.review.completed' AND granularity='row' AND occurrence_id IS NOT NULL AND plm_event_id IS NULL)
  OR (event_type='bom.plm_change.applied' AND granularity IN ('bom_line','eco_batch') AND occurrence_id IS NULL AND plm_event_id IS NOT NULL)),
 ADD CONSTRAINT plm_completion_fact FOREIGN KEY(binding_id,plm_event_id) REFERENCES meta_plm_bom_change_inbox(binding_id,event_id),
 ADD CONSTRAINT plm_completion_fact_unique UNIQUE(binding_id,plm_event_id);
CREATE OR REPLACE FUNCTION meta_bom_review_completion_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_completion_event_protected'; END IF;
 IF (NEW.event_type='bom.review.completed' AND pg_trigger_depth()=4)
 OR (NEW.event_type='bom.plm_change.applied' AND pg_trigger_depth()=2) THEN RETURN NEW; END IF;
 RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_completion_event_protected';
END $$;
CREATE FUNCTION meta_plm_change_capture_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO meta_plm_bom_review_completion_events(binding_id,plm_event_id,event_type,granularity,
  webhook_id,creator_id,configuration_revision_id,payload)
 VALUES(NEW.binding_id,NEW.event_id,'bom.plm_change.applied',
  CASE WHEN NEW.payload->'change'->>'kind'='bom_line_writeback' THEN 'bom_line' ELSE 'eco_batch' END,
  NEW.webhook_id,NEW.creator_id,NEW.configuration_revision_id,NEW.payload);
 RETURN NEW;
END $$;
CREATE TRIGGER meta_plm_change_capture_event AFTER INSERT ON meta_plm_bom_change_inbox
 FOR EACH ROW EXECUTE FUNCTION meta_plm_change_capture_event();
DO $$ DECLARE target_schema name:=current_schema(); BEGIN
 EXECUTE format('ALTER FUNCTION %I.meta_plm_change_capture_event() SET search_path = pg_catalog, %I, pg_temp',target_schema,target_schema);
END $$;
`).execute(db)
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
LOCK TABLE meta_plm_bom_review_completion_events,meta_plm_bom_change_inbox IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM meta_plm_bom_review_completion_events WHERE plm_event_id IS NOT NULL) THEN
 RAISE EXCEPTION 'plm_change_dispatch_evidence_present'; END IF; END $$;
DROP TRIGGER meta_plm_change_capture_event ON meta_plm_bom_change_inbox;
DROP FUNCTION meta_plm_change_capture_event();
ALTER TABLE meta_plm_bom_review_completion_events DROP CONSTRAINT plm_completion_origin,
 DROP CONSTRAINT plm_completion_fact, DROP CONSTRAINT plm_completion_fact_unique,
 DROP COLUMN plm_event_id, ALTER COLUMN occurrence_id SET NOT NULL,
 ADD CONSTRAINT meta_plm_bom_review_completion_events_event_type_check CHECK(event_type='bom.review.completed'),
 ADD CONSTRAINT meta_plm_bom_review_completion_events_granularity_check CHECK(granularity='row');
CREATE OR REPLACE FUNCTION meta_bom_review_completion_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' OR pg_trigger_depth()<>4 THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_completion_event_protected';
 END IF;
 RETURN NEW;
END $$;
`).execute(db)
}
