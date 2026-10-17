import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
ALTER TABLE meta_plm_bom_review_bindings ADD COLUMN status_views_initialized boolean NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION meta_bom_review_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['status','version','snapshot_hash','last_synced_at','last_failure_code','last_failure_at','line_count','occurrence_count','owner_view_initialized','status_views_initialized'])
 IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','version','snapshot_hash','last_synced_at','last_failure_code','last_failure_at','line_count','occurrence_count','owner_view_initialized','status_views_initialized'])
 OR (OLD.owner_view_initialized AND NOT NEW.owner_view_initialized)
 OR (OLD.status_views_initialized AND NOT NEW.status_views_initialized)
 OR (OLD.status='disabled' AND (NEW.status<>'disabled' OR NEW.owner_view_initialized IS DISTINCT FROM OLD.owner_view_initialized
  OR NEW.status_views_initialized IS DISTINCT FROM OLD.status_views_initialized)) THEN
 RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_source_protected'; END IF;
 RETURN NEW; END $$;
`).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
LOCK TABLE meta_plm_bom_review_bindings IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM meta_plm_bom_review_bindings WHERE status_views_initialized) THEN
 RAISE EXCEPTION 'bom_review_status_view_initialization_evidence_present'; END IF; END $$;
CREATE OR REPLACE FUNCTION meta_bom_review_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['status','version','snapshot_hash','last_synced_at','last_failure_code','last_failure_at','line_count','occurrence_count','owner_view_initialized'])
 IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','version','snapshot_hash','last_synced_at','last_failure_code','last_failure_at','line_count','occurrence_count','owner_view_initialized'])
 OR (OLD.owner_view_initialized AND NOT NEW.owner_view_initialized)
 OR (OLD.status='disabled' AND (NEW.status<>'disabled' OR NEW.owner_view_initialized IS DISTINCT FROM OLD.owner_view_initialized)) THEN
 RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='bom_review_source_protected'; END IF;
 RETURN NEW; END $$;
ALTER TABLE meta_plm_bom_review_bindings DROP COLUMN status_views_initialized;
`).execute(db)
}
