import { sql, type Kysely } from 'kysely'

/** Credentials belong to the existing listener. Historical authority remains after unbind. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`ALTER TABLE meta_plm_bom_change_listeners
    ADD COLUMN personal_read_authority jsonb,
    ADD COLUMN personal_read_grant_id text,
    ADD COLUMN personal_read_expires_at timestamptz,
    ADD COLUMN encrypted_personal_read_grant text,
    ADD COLUMN personal_read_revision uuid NOT NULL DEFAULT gen_random_uuid(),
    ADD CONSTRAINT plm_listener_personal_read_scope CHECK (
      (personal_read_authority IS NULL AND personal_read_grant_id IS NULL AND personal_read_expires_at IS NULL
        AND encrypted_personal_read_grant IS NULL) OR
      (personal_read_authority IS NOT NULL AND jsonb_typeof(personal_read_authority)='object'
        AND personal_read_grant_id IS NOT NULL AND personal_read_grant_id ~ '^[0-9a-f]{32}$'
        AND personal_read_expires_at IS NOT NULL)),
    ADD CONSTRAINT plm_listener_personal_read_encrypted CHECK
      (encrypted_personal_read_grant IS NULL OR left(encrypted_personal_read_grant,4)='enc:');
  CREATE TABLE meta_plm_bom_change_read_retired_grants (
    id uuid PRIMARY KEY,
    binding_id uuid NOT NULL REFERENCES meta_plm_bom_change_listeners(binding_id),
    owner_id text NOT NULL,
    grant_id text NOT NULL CHECK (grant_id ~ '^[0-9a-f]{32}$'),
    authority jsonb NOT NULL CHECK (jsonb_typeof(authority)='object'),
    encrypted_grant text,
    state text NOT NULL CHECK (state IN ('pending','unknown','revoked','rejected')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((state IN ('pending','unknown') AND encrypted_grant IS NOT NULL AND left(encrypted_grant,4)='enc:')
      OR (state IN ('revoked','rejected') AND encrypted_grant IS NULL))
  );
  CREATE FUNCTION meta_plm_change_read_retired_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.binding_id IS DISTINCT FROM OLD.binding_id
      OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
      OR NEW.authority IS DISTINCT FROM OLD.authority OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR (NEW.encrypted_grant IS DISTINCT FROM OLD.encrypted_grant AND NEW.encrypted_grant IS NOT NULL)
      OR (OLD.state IN ('revoked','rejected') AND NEW.state IS DISTINCT FROM OLD.state) THEN
      RAISE EXCEPTION 'plm_change_read_retired_identity_immutable';
    END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER meta_plm_change_read_retired_guard BEFORE UPDATE ON meta_plm_bom_change_read_retired_grants
    FOR EACH ROW EXECUTE FUNCTION meta_plm_change_read_retired_guard();
  CREATE INDEX plm_change_read_retired_owner ON meta_plm_bom_change_read_retired_grants(owner_id,binding_id,state);
  `).execute(db)
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`LOCK TABLE meta_plm_bom_change_listeners IN ACCESS EXCLUSIVE MODE NOWAIT;
    LOCK TABLE meta_plm_bom_change_read_retired_grants IN ACCESS EXCLUSIVE MODE NOWAIT;
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM meta_plm_bom_change_listeners WHERE personal_read_authority IS NOT NULL)
        OR EXISTS(SELECT 1 FROM meta_plm_bom_change_read_retired_grants) THEN
        RAISE EXCEPTION 'plm_change_read_authority_evidence_present';
      END IF;
    END $$;
    DROP TABLE meta_plm_bom_change_read_retired_grants;
    DROP FUNCTION meta_plm_change_read_retired_guard();
    ALTER TABLE meta_plm_bom_change_listeners DROP CONSTRAINT plm_listener_personal_read_scope,
      DROP CONSTRAINT plm_listener_personal_read_encrypted,
      DROP COLUMN personal_read_authority, DROP COLUMN personal_read_grant_id,
      DROP COLUMN personal_read_expires_at, DROP COLUMN encrypted_personal_read_grant,
      DROP COLUMN personal_read_revision;`).execute(db)
}
