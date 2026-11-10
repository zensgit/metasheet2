import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE plm_personal_bom_write_bindings (
      id uuid PRIMARY KEY,
      owner_id text NOT NULL REFERENCES users(id),
      data_source_id text NOT NULL REFERENCES data_sources(id),
      connection_id text NOT NULL,
      subject_id text NOT NULL,
      meta_tenant_id text,
      yuantus_tenant_id text NOT NULL,
      yuantus_org_id text NOT NULL,
      target_origin text NOT NULL,
      workspace_id text,
      scope_kind text NOT NULL,
      grant_id text NOT NULL,
      expires_at timestamptz NOT NULL,
      encrypted_grant text,
      generation integer NOT NULL DEFAULT 1,
      purpose text NOT NULL DEFAULT 'bom_write',
      remote_revoke_state text,
      previous_grant_revoke_state text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (owner_id, data_source_id),
      CHECK (purpose = 'bom_write'),
      CHECK (scope_kind IN ('legacy_private', 'private', 'workspace')),
      CHECK (generation >= 1),
      CHECK (subject_id ~ '^[1-9][0-9]{0,17}$'),
      CHECK (char_length(connection_id) BETWEEN 1 AND 128),
      CHECK (char_length(yuantus_tenant_id) BETWEEN 1 AND 128),
      CHECK (char_length(yuantus_org_id) BETWEEN 1 AND 128),
      CHECK (char_length(target_origin) BETWEEN 8 AND 300),
      CHECK (target_origin ~ '^https://'),
      CHECK (char_length(grant_id) = 32),
      CHECK (meta_tenant_id IS NULL OR char_length(meta_tenant_id) BETWEEN 1 AND 128),
      CHECK (encrypted_grant IS NULL OR left(encrypted_grant, 4) = 'enc:'),
      CHECK (remote_revoke_state IS NULL OR remote_revoke_state IN ('pending', 'revoked', 'unknown', 'rejected')),
      CHECK (previous_grant_revoke_state IS NULL OR previous_grant_revoke_state IN ('pending', 'revoked', 'unknown', 'rejected'))
    )
  `.execute(db)
  await sql`
    CREATE TABLE plm_personal_bom_write_retired_grants (
      id uuid PRIMARY KEY,
      binding_id uuid NOT NULL REFERENCES plm_personal_bom_write_bindings(id),
      owner_id text NOT NULL REFERENCES users(id),
      connection_id text NOT NULL,
      yuantus_tenant_id text NOT NULL,
      yuantus_org_id text NOT NULL,
      target_origin text NOT NULL,
      grant_id text NOT NULL,
      encrypted_grant text,
      state text NOT NULL,
      slot text NOT NULL,
      binding_generation integer NOT NULL,
      successor_grant_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (state IN ('pending', 'revoked', 'unknown', 'rejected')),
      CHECK (slot IN ('current', 'previous')),
      CHECK (binding_generation >= 1),
      CHECK (char_length(connection_id) BETWEEN 1 AND 128),
      CHECK (char_length(yuantus_tenant_id) BETWEEN 1 AND 128),
      CHECK (char_length(yuantus_org_id) BETWEEN 1 AND 128),
      CHECK (char_length(target_origin) BETWEEN 8 AND 300),
      CHECK (target_origin ~ '^https://'),
      CHECK (char_length(grant_id) = 32),
      CHECK (char_length(successor_grant_id) = 32),
      CHECK (encrypted_grant IS NULL OR left(encrypted_grant, 4) = 'enc:'),
      CHECK (
        (state IN ('pending', 'unknown') AND encrypted_grant IS NOT NULL)
        OR (state IN ('revoked', 'rejected') AND encrypted_grant IS NULL)
      )
    )
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    LOCK TABLE plm_personal_bom_write_retired_grants IN ACCESS EXCLUSIVE MODE NOWAIT;
    LOCK TABLE plm_personal_bom_write_bindings IN ACCESS EXCLUSIVE MODE NOWAIT;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM plm_personal_bom_write_retired_grants)
         OR EXISTS (SELECT 1 FROM plm_personal_bom_write_bindings) THEN
        RAISE EXCEPTION 'plm_personal_bom_write_evidence_present';
      END IF;
    END $$;
    DROP TABLE plm_personal_bom_write_retired_grants;
    DROP TABLE plm_personal_bom_write_bindings
  `.execute(db)
}
