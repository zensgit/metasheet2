import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`ALTER TABLE data_sources ADD COLUMN plm_bom_listener_authority_version uuid NOT NULL DEFAULT gen_random_uuid();
    CREATE FUNCTION meta_plm_bom_listener_authority_changed() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
    BEGIN
      NEW.plm_bom_listener_authority_version=gen_random_uuid();
      RETURN NEW;
    END $$;
    CREATE TRIGGER meta_plm_bom_listener_authority_changed
      BEFORE UPDATE OF id,type,owner_id,config,is_active,deleted_at,workspace_id,tenant_id,scope_kind,plm_bom_listener_authority_version ON data_sources
      FOR EACH ROW WHEN (OLD.owner_id IS DISTINCT FROM NEW.owner_id OR OLD.config IS DISTINCT FROM NEW.config
        OR OLD.is_active IS DISTINCT FROM NEW.is_active OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
        OR OLD.id IS DISTINCT FROM NEW.id OR OLD.type IS DISTINCT FROM NEW.type
        OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
        OR OLD.scope_kind IS DISTINCT FROM NEW.scope_kind
        OR OLD.plm_bom_listener_authority_version IS DISTINCT FROM NEW.plm_bom_listener_authority_version)
      EXECUTE FUNCTION meta_plm_bom_listener_authority_changed();
    ALTER TABLE users ADD COLUMN plm_bom_listener_authority_version uuid NOT NULL DEFAULT gen_random_uuid();
    CREATE FUNCTION meta_plm_bom_listener_account_changed() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
    BEGIN
      NEW.plm_bom_listener_authority_version=gen_random_uuid();
      RETURN NEW;
    END $$;
    CREATE TRIGGER meta_plm_bom_listener_account_changed
      BEFORE UPDATE OF id,is_active,plm_bom_listener_authority_version ON users
      FOR EACH ROW WHEN (OLD.id IS DISTINCT FROM NEW.id OR OLD.is_active IS DISTINCT FROM NEW.is_active
        OR OLD.plm_bom_listener_authority_version IS DISTINCT FROM NEW.plm_bom_listener_authority_version)
      EXECUTE FUNCTION meta_plm_bom_listener_account_changed();
    CREATE FUNCTION meta_plm_bom_listener_account_revoked() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
    BEGIN
      UPDATE meta_plm_bom_change_listeners SET status='stopped',stop_reason='AUTHORITY_CHANGED',updated_at=clock_timestamp()
        WHERE owner_id=OLD.id AND status='active';
      RETURN NEW;
    END $$;
    CREATE TRIGGER meta_plm_bom_listener_account_revoked AFTER UPDATE OF id,is_active ON users
      FOR EACH ROW WHEN (OLD.id IS DISTINCT FROM NEW.id OR (OLD.is_active IS DISTINCT FROM NEW.is_active AND NEW.is_active IS FALSE))
      EXECUTE FUNCTION meta_plm_bom_listener_account_revoked();`).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`LOCK TABLE users,data_sources,meta_plm_bom_change_listeners IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM meta_plm_bom_change_listeners) THEN
      RAISE EXCEPTION 'plm_change_listener_evidence_present'; END IF; END $$;
    DROP TRIGGER meta_plm_bom_listener_account_revoked ON users;
    DROP FUNCTION meta_plm_bom_listener_account_revoked();
    DROP TRIGGER meta_plm_bom_listener_account_changed ON users;
    DROP FUNCTION meta_plm_bom_listener_account_changed();
    ALTER TABLE users DROP COLUMN plm_bom_listener_authority_version;
    DROP TRIGGER meta_plm_bom_listener_authority_changed ON data_sources;
    DROP FUNCTION meta_plm_bom_listener_authority_changed();
    ALTER TABLE data_sources DROP COLUMN plm_bom_listener_authority_version;`).execute(db)
}
