import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
CREATE TABLE meta_plm_bom_review_completion_config (
 binding_id uuid PRIMARY KEY REFERENCES meta_plm_bom_review_bindings(id),
 version bigint NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
 webhooks jsonb NOT NULL CHECK(jsonb_typeof(webhooks)='object'),
 updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 revision_id uuid NOT NULL REFERENCES meta_config_revisions(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE meta_plm_bom_review_completion_occurrences (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 binding_id uuid NOT NULL REFERENCES meta_plm_bom_review_bindings(id),
 record_id text NOT NULL, round bigint NOT NULL,
 event_type text NOT NULL CHECK(event_type='bom.review.row_completed'),
 occurred_at timestamptz NOT NULL, record_version bigint NOT NULL,
 actor_id text, configuration_version bigint NOT NULL,
 configuration_revision_id uuid NOT NULL REFERENCES meta_config_revisions(id),
 UNIQUE(record_id,round,event_type),
 FOREIGN KEY(record_id,round) REFERENCES meta_plm_bom_review_rounds(record_id,round)
);
CREATE FUNCTION meta_bom_review_completion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' OR pg_trigger_depth()<>3 THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_completion_protected';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER meta_bom_review_completion_guard BEFORE INSERT OR UPDATE OR DELETE ON meta_plm_bom_review_completion_occurrences
 FOR EACH ROW EXECUTE FUNCTION meta_bom_review_completion_guard();
CREATE TRIGGER meta_bom_review_completion_truncate_guard BEFORE TRUNCATE ON meta_plm_bom_review_completion_occurrences
 FOR EACH STATEMENT EXECUTE FUNCTION meta_bom_review_completion_guard();
CREATE FUNCTION meta_bom_review_track_completion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy record; item record;
BEGIN
 IF OLD.completed_at IS NOT NULL OR NEW.completed_at IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO policy FROM meta_plm_bom_review_completion_config WHERE binding_id=NEW.binding_id;
 IF NOT FOUND OR policy.webhooks->'reviewCompleted'->'enabled' IS DISTINCT FROM 'true'::jsonb THEN RETURN NEW; END IF;
 SELECT version,modified_by INTO item FROM meta_records WHERE id=NEW.record_id;
 INSERT INTO meta_plm_bom_review_completion_occurrences(binding_id,record_id,round,event_type,
  occurred_at,record_version,actor_id,configuration_version,configuration_revision_id)
 VALUES(NEW.binding_id,NEW.record_id,NEW.round,'bom.review.row_completed',NEW.completed_at,
  item.version,item.modified_by,policy.version,policy.revision_id);
 RETURN NEW;
END $$;
CREATE TRIGGER meta_bom_review_track_completion AFTER UPDATE ON meta_plm_bom_review_rounds
 FOR EACH ROW EXECUTE FUNCTION meta_bom_review_track_completion();
DO $$ DECLARE target_schema name:=current_schema(); BEGIN
 EXECUTE format('ALTER FUNCTION %I.meta_bom_review_track_completion() SET search_path = pg_catalog, %I, pg_temp',target_schema,target_schema);
END $$;
`).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
LOCK TABLE meta_plm_bom_review_completion_config,meta_plm_bom_review_completion_occurrences IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM meta_plm_bom_review_completion_config)
 OR EXISTS(SELECT 1 FROM meta_plm_bom_review_completion_occurrences) THEN
 RAISE EXCEPTION 'bom_review_completion_evidence_present'; END IF; END $$;
DROP TRIGGER meta_bom_review_track_completion ON meta_plm_bom_review_rounds;
DROP TABLE meta_plm_bom_review_completion_occurrences;
DROP TABLE meta_plm_bom_review_completion_config;
DROP FUNCTION meta_bom_review_track_completion();
DROP FUNCTION meta_bom_review_completion_guard();
`).execute(db)
}
