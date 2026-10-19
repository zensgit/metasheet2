import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
ALTER TABLE meta_plm_bom_review_completion_intents
 ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 10),
 ADD COLUMN lease_id uuid, ADD COLUMN lease_until timestamptz,
 ADD COLUMN next_retry_at timestamptz,
 ADD COLUMN last_http_status integer CHECK(last_http_status BETWEEN 100 AND 599),
 ADD CONSTRAINT meta_bom_completion_lease_pair CHECK((lease_id IS NULL)=(lease_until IS NULL));
CREATE OR REPLACE FUNCTION meta_bom_review_completion_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') OR OLD.state<>'prepared' OR NEW.state NOT IN ('prepared','cancelled','delivered')
  OR NEW.attempt_count NOT IN (OLD.attempt_count,OLD.attempt_count+1)
  OR (NEW.attempt_count=OLD.attempt_count+1 AND (NEW.state<>'prepared' OR NEW.lease_id IS NULL OR NEW.lease_id IS NOT DISTINCT FROM OLD.lease_id))
  OR (NEW.state<>'prepared' AND (NEW.lease_id IS NOT NULL OR NEW.next_retry_at IS NOT NULL))
  OR (NEW.state='delivered' AND NEW.delivered_at IS NULL)
  OR (to_jsonb(NEW)-ARRAY['state','cancellation_reason','delivered_at','attempt_count','lease_id','lease_until','next_retry_at','last_http_status'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','cancellation_reason','delivered_at','attempt_count','lease_id','lease_until','next_retry_at','last_http_status']) THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_completion_intent_protected';
 END IF;
 RETURN NEW;
END $$;
`).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
LOCK TABLE meta_plm_bom_review_completion_intents IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM meta_plm_bom_review_completion_intents WHERE attempt_count>0 OR lease_id IS NOT NULL) THEN
 RAISE EXCEPTION 'bom_review_completion_attempt_evidence_present'; END IF; END $$;
ALTER TABLE meta_plm_bom_review_completion_intents DROP COLUMN attempt_count,DROP COLUMN lease_id,
 DROP COLUMN lease_until,DROP COLUMN next_retry_at,DROP COLUMN last_http_status;
CREATE OR REPLACE FUNCTION meta_bom_review_completion_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') OR OLD.state<>'prepared' OR NEW.state NOT IN ('cancelled','delivered')
  OR (to_jsonb(NEW)-ARRAY['state','cancellation_reason','delivered_at'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','cancellation_reason','delivered_at']) THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_completion_intent_protected';
 END IF;
 RETURN NEW;
END $$;
`).execute(db)
}
