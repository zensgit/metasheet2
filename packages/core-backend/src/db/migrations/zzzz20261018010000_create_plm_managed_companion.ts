import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE plm_managed_identity_links (
      id text PRIMARY KEY,
      installation_issuer text NOT NULL,
      native_auth_user_id text NOT NULL,
      native_tenant_id text NOT NULL,
      native_org_id text NOT NULL,
      client_id text NOT NULL,
      callback text NOT NULL,
      meta_user_id text NOT NULL REFERENCES users(id),
      meta_tenant_id text NOT NULL,
      meta_org_id text NOT NULL,
      data_source_id text NOT NULL REFERENCES data_sources(id),
      root_part_id text NOT NULL,
      client_origin text NOT NULL,
      generation integer NOT NULL,
      status text NOT NULL,
      owner_user_id text NOT NULL REFERENCES users(id),
      created_by text NOT NULL REFERENCES users(id),
      stopped_at timestamptz,
      stop_reason text,
      source_fingerprint text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (status IN ('active', 'revoked', 'transferred')),
      CHECK (generation >= 1),
      CHECK (char_length(installation_issuer) BETWEEN 8 AND 500),
      CHECK (char_length(native_auth_user_id) BETWEEN 1 AND 128),
      CHECK (char_length(native_tenant_id) BETWEEN 1 AND 128),
      CHECK (char_length(native_org_id) BETWEEN 1 AND 128),
      CHECK (char_length(client_id) BETWEEN 1 AND 128),
      CHECK (char_length(callback) BETWEEN 8 AND 500),
      CHECK (char_length(meta_tenant_id) BETWEEN 1 AND 128),
      CHECK (char_length(meta_org_id) BETWEEN 1 AND 128),
      CHECK (char_length(root_part_id) BETWEEN 1 AND 128),
      CHECK (char_length(client_origin) BETWEEN 8 AND 300),
      CHECK (char_length(source_fingerprint) = 64),
      CHECK (stop_reason IS NULL OR stop_reason IN ('revoked', 'transferred')),
      CHECK ((status = 'active' AND stopped_at IS NULL) OR (status <> 'active' AND stopped_at IS NOT NULL))
    )
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX plm_managed_identity_links_one_active
      ON plm_managed_identity_links (installation_issuer, native_auth_user_id, native_tenant_id, native_org_id, data_source_id)
      WHERE status = 'active'
  `.execute(db)
  await sql`
    CREATE TABLE plm_managed_browser_intents (
      id text PRIMARY KEY,
      link_id text NOT NULL REFERENCES plm_managed_identity_links(id),
      generation integer NOT NULL,
      meta_user_id text NOT NULL REFERENCES users(id),
      meta_tenant_id text NOT NULL,
      meta_org_id text NOT NULL,
      data_source_id text NOT NULL REFERENCES data_sources(id),
      root_part_id text NOT NULL,
      client_origin text NOT NULL,
      installation_issuer text NOT NULL,
      native_tenant_id text NOT NULL,
      native_org_id text NOT NULL,
      callback text NOT NULL,
      client_id text NOT NULL,
      state_hash text NOT NULL,
      nonce_hash text NOT NULL,
      code_challenge text NOT NULL,
      code_verifier_ciphertext text NOT NULL,
      return_path text NOT NULL,
      status text NOT NULL,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      delegation_id text,
      credential_ciphertext text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (status IN ('pending', 'consumed', 'revoked')),
      CHECK (generation >= 1),
      CHECK (return_path = '/plm/bom-review'),
      CHECK (char_length(state_hash) = 64),
      CHECK (char_length(nonce_hash) = 64),
      CHECK (char_length(code_challenge) = 43),
      CHECK (left(code_verifier_ciphertext, 4) = 'enc:'),
      CHECK (credential_ciphertext IS NULL OR left(credential_ciphertext, 4) = 'enc:'),
      CHECK (expires_at <= created_at + interval '300 seconds'),
      CHECK ((status = 'pending' AND consumed_at IS NULL) OR (status <> 'pending'))
    )
  `.execute(db)
  await sql`
    CREATE TABLE plm_managed_sessions (
      id text PRIMARY KEY,
      intent_id text NOT NULL UNIQUE REFERENCES plm_managed_browser_intents(id),
      link_id text NOT NULL REFERENCES plm_managed_identity_links(id),
      data_source_id text NOT NULL REFERENCES data_sources(id),
      generation integer NOT NULL,
      delegation_id text NOT NULL UNIQUE,
      credential_ciphertext text NOT NULL,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      scope text NOT NULL,
      native_subject text NOT NULL,
      native_tenant_id text NOT NULL,
      native_org_id text NOT NULL,
      meta_user_id text NOT NULL REFERENCES users(id),
      meta_tenant_id text NOT NULL,
      meta_org_id text NOT NULL,
      root_part_id text NOT NULL,
      client_origin text NOT NULL,
      installation_issuer text NOT NULL,
      client_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (scope = 'bom_review_read'),
      CHECK (generation >= 1),
      CHECK (left(credential_ciphertext, 4) = 'enc:'),
      CHECK (char_length(delegation_id) BETWEEN 1 AND 128),
      CHECK (expires_at > created_at),
      CHECK (expires_at <= created_at + interval '600 seconds')
    )
  `.execute(db)
  await sql`
    CREATE TABLE plm_managed_source_bindings (
      data_source_id text PRIMARY KEY REFERENCES data_sources(id),
      link_id text NOT NULL REFERENCES plm_managed_identity_links(id),
      generation integer NOT NULL,
      source_fingerprint text NOT NULL,
      status text NOT NULL,
      frozen_origin text NOT NULL,
      frozen_root_part_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (status IN ('active', 'blocked')),
      CHECK (generation >= 1),
      CHECK (char_length(source_fingerprint) = 64)
    )
  `.execute(db)
  await sql`
    CREATE TABLE plm_managed_revoke_outbox (
      id text PRIMARY KEY,
      link_id text NOT NULL REFERENCES plm_managed_identity_links(id),
      generation integer NOT NULL,
      delegation_id text NOT NULL,
      client_id text NOT NULL,
      installation_issuer text NOT NULL,
      native_tenant_id text NOT NULL,
      native_org_id text NOT NULL,
      callback text NOT NULL,
      intent_id text REFERENCES plm_managed_browser_intents(id),
      retry_identity text NOT NULL,
      status text NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      last_error text,
      acked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (generation, delegation_id),
      CHECK (status IN ('pending', 'acked')),
      CHECK (generation >= 1),
      CHECK (attempts >= 0),
      CHECK (char_length(retry_identity) = 64),
      CHECK ((status = 'pending' AND acked_at IS NULL) OR (status = 'acked' AND acked_at IS NOT NULL))
    )
  `.execute(db)
  await sql`
    CREATE FUNCTION plm_managed_identity_links_guard() RETURNS trigger AS $$
    BEGIN
      IF OLD.status <> 'active' AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'plm_managed_link_status_terminal';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.installation_issuer IS DISTINCT FROM OLD.installation_issuer
         OR NEW.native_auth_user_id IS DISTINCT FROM OLD.native_auth_user_id
         OR NEW.native_tenant_id IS DISTINCT FROM OLD.native_tenant_id
         OR NEW.native_org_id IS DISTINCT FROM OLD.native_org_id
         OR NEW.client_id IS DISTINCT FROM OLD.client_id
         OR NEW.callback IS DISTINCT FROM OLD.callback
         OR NEW.meta_user_id IS DISTINCT FROM OLD.meta_user_id
         OR NEW.meta_tenant_id IS DISTINCT FROM OLD.meta_tenant_id
         OR NEW.meta_org_id IS DISTINCT FROM OLD.meta_org_id
         OR NEW.data_source_id IS DISTINCT FROM OLD.data_source_id
         OR NEW.root_part_id IS DISTINCT FROM OLD.root_part_id
         OR NEW.client_origin IS DISTINCT FROM OLD.client_origin
         OR NEW.generation IS DISTINCT FROM OLD.generation
         OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
         OR NEW.source_fingerprint IS DISTINCT FROM OLD.source_fingerprint
         OR NEW.created_by IS DISTINCT FROM OLD.created_by
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'plm_managed_link_immutable';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `.execute(db)
  await sql`
    CREATE TRIGGER plm_managed_identity_links_guard
      BEFORE UPDATE ON plm_managed_identity_links
      FOR EACH ROW EXECUTE FUNCTION plm_managed_identity_links_guard()
  `.execute(db)
  await sql`
    CREATE FUNCTION plm_managed_browser_intents_guard() RETURNS trigger AS $$
    BEGIN
      IF OLD.status <> 'pending' AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'plm_managed_intent_status_terminal';
      END IF;
      IF OLD.delegation_id IS NOT NULL AND NEW.delegation_id IS DISTINCT FROM OLD.delegation_id THEN
        RAISE EXCEPTION 'plm_managed_intent_delegation_immutable';
      END IF;
      IF OLD.credential_ciphertext IS NOT NULL AND NEW.credential_ciphertext IS DISTINCT FROM OLD.credential_ciphertext THEN
        RAISE EXCEPTION 'plm_managed_intent_credential_immutable';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.link_id IS DISTINCT FROM OLD.link_id
         OR NEW.generation IS DISTINCT FROM OLD.generation
         OR NEW.meta_user_id IS DISTINCT FROM OLD.meta_user_id
         OR NEW.state_hash IS DISTINCT FROM OLD.state_hash
         OR NEW.nonce_hash IS DISTINCT FROM OLD.nonce_hash
         OR NEW.code_challenge IS DISTINCT FROM OLD.code_challenge
         OR NEW.code_verifier_ciphertext IS DISTINCT FROM OLD.code_verifier_ciphertext
         OR NEW.root_part_id IS DISTINCT FROM OLD.root_part_id
         OR NEW.client_origin IS DISTINCT FROM OLD.client_origin
         OR NEW.callback IS DISTINCT FROM OLD.callback
         OR NEW.client_id IS DISTINCT FROM OLD.client_id THEN
        RAISE EXCEPTION 'plm_managed_intent_immutable';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `.execute(db)
  await sql`
    CREATE TRIGGER plm_managed_browser_intents_guard
      BEFORE UPDATE ON plm_managed_browser_intents
      FOR EACH ROW EXECUTE FUNCTION plm_managed_browser_intents_guard()
  `.execute(db)
  await sql`
    CREATE FUNCTION plm_managed_sessions_guard() RETURNS trigger AS $$
    BEGIN
      IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
        RAISE EXCEPTION 'plm_managed_session_revocation_monotonic';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.intent_id IS DISTINCT FROM OLD.intent_id
         OR NEW.delegation_id IS DISTINCT FROM OLD.delegation_id
         OR NEW.generation IS DISTINCT FROM OLD.generation
         OR NEW.credential_ciphertext IS DISTINCT FROM OLD.credential_ciphertext
         OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
         OR NEW.meta_user_id IS DISTINCT FROM OLD.meta_user_id
         OR NEW.link_id IS DISTINCT FROM OLD.link_id
         OR NEW.data_source_id IS DISTINCT FROM OLD.data_source_id
         OR NEW.scope IS DISTINCT FROM OLD.scope
         OR NEW.native_subject IS DISTINCT FROM OLD.native_subject
         OR NEW.root_part_id IS DISTINCT FROM OLD.root_part_id
         OR NEW.client_origin IS DISTINCT FROM OLD.client_origin THEN
        RAISE EXCEPTION 'plm_managed_session_immutable';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `.execute(db)
  await sql`
    CREATE TRIGGER plm_managed_sessions_guard
      BEFORE UPDATE ON plm_managed_sessions
      FOR EACH ROW EXECUTE FUNCTION plm_managed_sessions_guard()
  `.execute(db)
  await sql`
    CREATE FUNCTION plm_managed_source_bindings_guard() RETURNS trigger AS $$
    BEGIN
      IF NEW.generation < OLD.generation THEN
        RAISE EXCEPTION 'plm_managed_binding_generation_regression';
      END IF;
      IF NEW.generation = OLD.generation AND NEW.link_id IS DISTINCT FROM OLD.link_id THEN
        RAISE EXCEPTION 'plm_managed_binding_link_immutable';
      END IF;
      IF NEW.generation = OLD.generation AND OLD.status = 'blocked' AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'plm_managed_binding_blocked';
      END IF;
      IF NEW.generation > OLD.generation AND NEW.link_id = OLD.link_id THEN
        RAISE EXCEPTION 'plm_managed_binding_generation_link';
      END IF;
      IF NEW.data_source_id IS DISTINCT FROM OLD.data_source_id THEN
        RAISE EXCEPTION 'plm_managed_binding_immutable';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `.execute(db)
  await sql`
    CREATE TRIGGER plm_managed_source_bindings_guard
      BEFORE UPDATE ON plm_managed_source_bindings
      FOR EACH ROW EXECUTE FUNCTION plm_managed_source_bindings_guard()
  `.execute(db)
  await sql`
    CREATE FUNCTION plm_managed_revoke_outbox_guard() RETURNS trigger AS $$
    BEGIN
      IF OLD.status = 'acked' THEN
        RAISE EXCEPTION 'plm_managed_outbox_acked';
      END IF;
      IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'pending' AND NEW.status = 'acked') THEN
        RAISE EXCEPTION 'plm_managed_outbox_status';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.link_id IS DISTINCT FROM OLD.link_id
         OR NEW.generation IS DISTINCT FROM OLD.generation
         OR NEW.delegation_id IS DISTINCT FROM OLD.delegation_id
         OR NEW.client_id IS DISTINCT FROM OLD.client_id
         OR NEW.installation_issuer IS DISTINCT FROM OLD.installation_issuer
         OR NEW.native_tenant_id IS DISTINCT FROM OLD.native_tenant_id
         OR NEW.native_org_id IS DISTINCT FROM OLD.native_org_id
         OR NEW.callback IS DISTINCT FROM OLD.callback
         OR NEW.intent_id IS DISTINCT FROM OLD.intent_id
         OR NEW.retry_identity IS DISTINCT FROM OLD.retry_identity
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'plm_managed_outbox_immutable';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `.execute(db)
  await sql`
    CREATE TRIGGER plm_managed_revoke_outbox_guard
      BEFORE UPDATE ON plm_managed_revoke_outbox
      FOR EACH ROW EXECUTE FUNCTION plm_managed_revoke_outbox_guard()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    LOCK TABLE plm_managed_revoke_outbox IN ACCESS EXCLUSIVE MODE NOWAIT;
    LOCK TABLE plm_managed_sessions IN ACCESS EXCLUSIVE MODE NOWAIT;
    LOCK TABLE plm_managed_browser_intents IN ACCESS EXCLUSIVE MODE NOWAIT;
    LOCK TABLE plm_managed_source_bindings IN ACCESS EXCLUSIVE MODE NOWAIT;
    LOCK TABLE plm_managed_identity_links IN ACCESS EXCLUSIVE MODE NOWAIT;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM plm_managed_revoke_outbox)
         OR EXISTS (SELECT 1 FROM plm_managed_sessions)
         OR EXISTS (SELECT 1 FROM plm_managed_browser_intents)
         OR EXISTS (SELECT 1 FROM plm_managed_source_bindings)
         OR EXISTS (SELECT 1 FROM plm_managed_identity_links) THEN
        RAISE EXCEPTION 'plm_managed_companion_evidence_present';
      END IF;
    END $$;
    DROP TRIGGER plm_managed_revoke_outbox_guard ON plm_managed_revoke_outbox;
    DROP TRIGGER plm_managed_source_bindings_guard ON plm_managed_source_bindings;
    DROP TRIGGER plm_managed_sessions_guard ON plm_managed_sessions;
    DROP TRIGGER plm_managed_browser_intents_guard ON plm_managed_browser_intents;
    DROP TRIGGER plm_managed_identity_links_guard ON plm_managed_identity_links;
    DROP TABLE plm_managed_revoke_outbox;
    DROP TABLE plm_managed_sessions;
    DROP TABLE plm_managed_browser_intents;
    DROP TABLE plm_managed_source_bindings;
    DROP TABLE plm_managed_identity_links;
    DROP FUNCTION plm_managed_revoke_outbox_guard();
    DROP FUNCTION plm_managed_source_bindings_guard();
    DROP FUNCTION plm_managed_sessions_guard();
    DROP FUNCTION plm_managed_browser_intents_guard();
    DROP FUNCTION plm_managed_identity_links_guard()
  `.execute(db)
}
