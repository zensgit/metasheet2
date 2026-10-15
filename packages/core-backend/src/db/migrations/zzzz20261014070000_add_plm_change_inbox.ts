import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
CREATE TABLE meta_plm_bom_change_inbox (
 binding_id uuid NOT NULL REFERENCES meta_plm_bom_review_bindings(id), event_id uuid NOT NULL,
 payload_hash text NOT NULL, payload jsonb NOT NULL, receipt jsonb NOT NULL,
 source_fingerprint text NOT NULL, verified_by text NOT NULL,
 configuration_revision_id uuid NOT NULL REFERENCES meta_config_revisions(id),
 creator_id text NOT NULL, webhook_id text NOT NULL,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(binding_id,event_id)
);
CREATE FUNCTION meta_plm_bom_change_inbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='plm_change_inbox_protected'; END $$;
CREATE TRIGGER meta_plm_bom_change_inbox_guard BEFORE UPDATE OR DELETE ON meta_plm_bom_change_inbox
 FOR EACH ROW EXECUTE FUNCTION meta_plm_bom_change_inbox_guard();
CREATE TRIGGER meta_plm_bom_change_inbox_truncate_guard BEFORE TRUNCATE ON meta_plm_bom_change_inbox
 FOR EACH STATEMENT EXECUTE FUNCTION meta_plm_bom_change_inbox_guard();
`).execute(db)
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
LOCK TABLE meta_plm_bom_change_inbox IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM meta_plm_bom_change_inbox) THEN
 RAISE EXCEPTION 'plm_change_inbox_evidence_present'; END IF; END $$;
DROP TABLE meta_plm_bom_change_inbox;
DROP FUNCTION meta_plm_bom_change_inbox_guard();
`).execute(db)
}
