import { sql, type Kysely } from 'kysely'
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`ALTER TABLE meta_plm_bom_change_inbox ADD COLUMN listener_generation uuid;
  CREATE TABLE meta_plm_bom_change_listeners (
    binding_id uuid PRIMARY KEY REFERENCES meta_plm_bom_review_bindings(id),
    generation uuid NOT NULL, owner_id text NOT NULL, source_fingerprint text NOT NULL,
    binding_version bigint NOT NULL, configuration_revision_id uuid NOT NULL REFERENCES meta_config_revisions(id),
    cursor bigint NOT NULL CHECK(cursor BETWEEN 0 AND 9007199254740991),
    status text NOT NULL CHECK(status IN ('active','stopped')),
    stop_reason text, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
  );
  CREATE FUNCTION meta_plm_bom_listener_source_changed() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
  BEGIN
    UPDATE meta_plm_bom_change_listeners l SET status='stopped',stop_reason='SOURCE_CHANGED',updated_at=clock_timestamp()
      FROM meta_plm_bom_review_bindings b WHERE b.id=l.binding_id AND b.data_source_id=OLD.id AND l.status='active';
    RETURN NEW;
  END $$;
  CREATE TRIGGER meta_plm_bom_listener_source_changed AFTER UPDATE OF id,type,owner_id,config,is_active,deleted_at,workspace_id,tenant_id,scope_kind ON data_sources
    FOR EACH ROW WHEN (OLD.owner_id IS DISTINCT FROM NEW.owner_id OR OLD.config IS DISTINCT FROM NEW.config
      OR OLD.is_active IS DISTINCT FROM NEW.is_active OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
      OR OLD.id IS DISTINCT FROM NEW.id OR OLD.type IS DISTINCT FROM NEW.type
      OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
      OR OLD.scope_kind IS DISTINCT FROM NEW.scope_kind)
    EXECUTE FUNCTION meta_plm_bom_listener_source_changed();
  CREATE TRIGGER meta_plm_bom_listener_source_deleted AFTER DELETE ON data_sources
    FOR EACH ROW EXECUTE FUNCTION meta_plm_bom_listener_source_changed();
  `).execute(db)
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`LOCK TABLE meta_plm_bom_change_listeners IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM meta_plm_bom_change_listeners) THEN
      RAISE EXCEPTION 'plm_change_listener_evidence_present'; END IF; END $$;
    DROP TRIGGER meta_plm_bom_listener_source_changed ON data_sources;
    DROP TRIGGER meta_plm_bom_listener_source_deleted ON data_sources;
    DROP FUNCTION meta_plm_bom_listener_source_changed();
    DROP TABLE meta_plm_bom_change_listeners;
    ALTER TABLE meta_plm_bom_change_inbox DROP COLUMN listener_generation;`).execute(db)
}
