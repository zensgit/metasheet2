import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
CREATE TABLE meta_plm_bom_review_completion_intents (
 event_id uuid PRIMARY KEY REFERENCES meta_plm_bom_review_completion_events(id),
 destination_fingerprint text,
 state text NOT NULL CHECK(state IN ('prepared','cancelled','delivered')),
 cancellation_reason text, prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(), delivered_at timestamptz,
 CHECK(state<>'prepared' OR destination_fingerprint IS NOT NULL)
);
CREATE FUNCTION meta_bom_review_completion_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') OR OLD.state<>'prepared' OR NEW.state NOT IN ('cancelled','delivered')
  OR (to_jsonb(NEW)-ARRAY['state','cancellation_reason','delivered_at'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','cancellation_reason','delivered_at']) THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_completion_intent_protected';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER meta_bom_review_completion_intent_guard BEFORE UPDATE OR DELETE ON meta_plm_bom_review_completion_intents
 FOR EACH ROW EXECUTE FUNCTION meta_bom_review_completion_intent_guard();
CREATE TRIGGER meta_bom_review_completion_intent_truncate_guard BEFORE TRUNCATE ON meta_plm_bom_review_completion_intents
 FOR EACH STATEMENT EXECUTE FUNCTION meta_bom_review_completion_intent_guard();
`).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
LOCK TABLE meta_plm_bom_review_completion_intents IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM meta_plm_bom_review_completion_intents) THEN
 RAISE EXCEPTION 'bom_review_completion_intent_evidence_present'; END IF; END $$;
DROP TABLE meta_plm_bom_review_completion_intents;
DROP FUNCTION meta_bom_review_completion_intent_guard();
`).execute(db)
}
