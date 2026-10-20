import { sql, type Kysely } from 'kysely'

/** Unlink is an authority transaction; no worker tick is needed to stop local reads. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`CREATE FUNCTION meta_plm_change_read_link_stopped() RETURNS trigger
    LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
    DECLARE r record;
    BEGIN
      FOR r IN SELECT * FROM meta_plm_bom_change_listeners
        WHERE encrypted_personal_read_grant IS NOT NULL
          AND personal_read_authority->'authority'->'target'->>'binding_id'=OLD.id::text
          AND personal_read_authority->'authority'->'target'->>'binding_generation'=OLD.generation::text
        ORDER BY binding_id FOR UPDATE LOOP
        INSERT INTO meta_plm_bom_change_read_retired_grants(id,binding_id,owner_id,grant_id,authority,encrypted_grant,state)
          VALUES(gen_random_uuid(),r.binding_id,r.owner_id,r.personal_read_grant_id,r.personal_read_authority,r.encrypted_personal_read_grant,'pending');
        UPDATE meta_plm_bom_change_listeners SET encrypted_personal_read_grant=NULL,
          personal_read_revision=gen_random_uuid(),generation=gen_random_uuid(),status='stopped',
          stop_reason='LINK_REVOKED',updated_at=clock_timestamp() WHERE binding_id=r.binding_id;
      END LOOP;
      RETURN NEW;
    END $$;
    CREATE TRIGGER meta_plm_change_read_link_stopped AFTER UPDATE OF status ON plm_managed_identity_links
      FOR EACH ROW WHEN (OLD.status='active' AND NEW.status<>'active')
      EXECUTE FUNCTION meta_plm_change_read_link_stopped();`).execute(db)
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`LOCK TABLE plm_managed_identity_links,meta_plm_bom_change_listeners,
    meta_plm_bom_change_read_retired_grants IN ACCESS EXCLUSIVE MODE NOWAIT;
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM meta_plm_bom_change_listeners WHERE personal_read_authority IS NOT NULL)
        OR EXISTS(SELECT 1 FROM meta_plm_bom_change_read_retired_grants) THEN
        RAISE EXCEPTION 'plm_change_read_authority_evidence_present';
      END IF;
    END $$;
    DROP TRIGGER meta_plm_change_read_link_stopped ON plm_managed_identity_links;
    DROP FUNCTION meta_plm_change_read_link_stopped();`).execute(db)
}
