import { sql, type Kysely } from 'kysely'

/**
 * Slice A only: frozen continuity mode and the initial continuous completion.
 * Does not create a renewal operation table. Historical guard predicates stay
 * in the replaced functions. Binding and outbox guards are not rewritten.
 * completion_code_hash is not in the always-immutable column list: the guard
 * allows one pending null-to-value write, then rejects change, clear, and any
 * write once the intent is terminal.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE plm_managed_identity_links
      ADD COLUMN continuity_mode text NOT NULL DEFAULT 'ordinary'
  `.execute(db)
  await sql`
    ALTER TABLE plm_managed_identity_links
      ADD CONSTRAINT plm_managed_links_continuity_mode_check
      CHECK (continuity_mode IN ('ordinary', 'continuous'))
  `.execute(db)
  await sql`
    ALTER TABLE plm_managed_browser_intents
      ADD COLUMN request_mode text NOT NULL DEFAULT 'ordinary'
  `.execute(db)
  await sql`
    ALTER TABLE plm_managed_browser_intents
      ADD CONSTRAINT plm_managed_intents_request_mode_check
      CHECK (request_mode IN ('ordinary', 'continuous'))
  `.execute(db)
  await sql`
    ALTER TABLE plm_managed_browser_intents
      ADD COLUMN completion_code_hash text
  `.execute(db)
  await sql`
    ALTER TABLE plm_managed_browser_intents
      ADD CONSTRAINT plm_managed_intents_completion_hash_check
      CHECK (completion_code_hash IS NULL OR completion_code_hash ~ '^[0-9a-f]{64}$')
  `.execute(db)
  await sql`
    ALTER TABLE plm_managed_sessions
      ADD COLUMN credential_generation integer
  `.execute(db)
  await sql`
    ALTER TABLE plm_managed_sessions
      ADD CONSTRAINT plm_managed_sessions_credential_generation_check
      CHECK (credential_generation IS NULL OR credential_generation BETWEEN 0 AND 7)
  `.execute(db)
  await sql`
    DO $$
    DECLARE
      status_check text;
      status_count integer;
    BEGIN
      SELECT count(*) INTO status_count
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      WHERE nsp.nspname = current_schema()
        AND rel.relname = 'plm_managed_browser_intents'
        AND con.contype = 'c'
        AND pg_get_constraintdef(con.oid) ILIKE '%pending%'
        AND pg_get_constraintdef(con.oid) ILIKE '%consumed%'
        AND pg_get_constraintdef(con.oid) ILIKE '%revoked%'
        AND pg_get_constraintdef(con.oid) NOT ILIKE '%refused%'
        AND pg_get_constraintdef(con.oid) NOT ILIKE '%consumed_at%'
        AND pg_get_constraintdef(con.oid) NOT ILIKE '%expires_at%'
        AND pg_get_constraintdef(con.oid) NOT ILIKE '%delegation%';
      IF status_count IS DISTINCT FROM 1 THEN
        RAISE EXCEPTION 'plm_managed_intent_status_check_missing';
      END IF;
      SELECT con.conname INTO status_check
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      WHERE nsp.nspname = current_schema()
        AND rel.relname = 'plm_managed_browser_intents'
        AND con.contype = 'c'
        AND pg_get_constraintdef(con.oid) ILIKE '%pending%'
        AND pg_get_constraintdef(con.oid) ILIKE '%consumed%'
        AND pg_get_constraintdef(con.oid) ILIKE '%revoked%'
        AND pg_get_constraintdef(con.oid) NOT ILIKE '%refused%'
        AND pg_get_constraintdef(con.oid) NOT ILIKE '%consumed_at%'
        AND pg_get_constraintdef(con.oid) NOT ILIKE '%expires_at%'
        AND pg_get_constraintdef(con.oid) NOT ILIKE '%delegation%';
      EXECUTE format('ALTER TABLE plm_managed_browser_intents DROP CONSTRAINT %I', status_check);
    END $$
  `.execute(db)
  await sql`
    ALTER TABLE plm_managed_browser_intents
      ADD CONSTRAINT plm_managed_intents_status_check
      CHECK (status IN ('pending', 'consumed', 'revoked', 'refused'))
  `.execute(db)
  await sql`
    ALTER TABLE plm_managed_browser_intents
      ADD CONSTRAINT plm_managed_intents_refused_shape_check
      CHECK (
        status <> 'refused'
        OR (delegation_id IS NULL AND credential_ciphertext IS NULL AND consumed_at IS NULL)
      )
  `.execute(db)
  await sql`
    CREATE OR REPLACE FUNCTION plm_managed_identity_links_guard() RETURNS trigger AS $$
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
         OR NEW.created_at IS DISTINCT FROM OLD.created_at
         OR NEW.continuity_mode IS DISTINCT FROM OLD.continuity_mode THEN
        RAISE EXCEPTION 'plm_managed_link_immutable';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `.execute(db)
  await sql`
    CREATE OR REPLACE FUNCTION plm_managed_browser_intents_guard() RETURNS trigger AS $$
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
      IF OLD.completion_code_hash IS NOT NULL AND NEW.completion_code_hash IS DISTINCT FROM OLD.completion_code_hash THEN
        RAISE EXCEPTION 'plm_managed_intent_completion_hash_immutable';
      END IF;
      IF OLD.status <> 'pending' AND NEW.completion_code_hash IS DISTINCT FROM OLD.completion_code_hash THEN
        RAISE EXCEPTION 'plm_managed_intent_completion_hash_terminal';
      END IF;
      IF OLD.completion_code_hash IS NULL AND NEW.completion_code_hash IS NOT NULL
         AND NOT (OLD.status = 'pending' AND NEW.status = 'pending') THEN
        RAISE EXCEPTION 'plm_managed_intent_completion_hash_pending';
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
         OR NEW.client_id IS DISTINCT FROM OLD.client_id
         OR NEW.request_mode IS DISTINCT FROM OLD.request_mode THEN
        RAISE EXCEPTION 'plm_managed_intent_immutable';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `.execute(db)
  await sql`
    CREATE OR REPLACE FUNCTION plm_managed_sessions_guard() RETURNS trigger AS $$
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
         OR NEW.client_origin IS DISTINCT FROM OLD.client_origin
         OR NEW.credential_generation IS DISTINCT FROM OLD.credential_generation THEN
        RAISE EXCEPTION 'plm_managed_session_immutable';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    // Link, then intent, then session. These conflict with an open INSERT.
    // The evidence read must not start until all three are held, or a
    // continuous row can commit after the read and before DROP COLUMN.
    await sql`LOCK TABLE plm_managed_identity_links IN ACCESS EXCLUSIVE MODE`.execute(trx)
    await sql`LOCK TABLE plm_managed_browser_intents IN ACCESS EXCLUSIVE MODE`.execute(trx)
    await sql`LOCK TABLE plm_managed_sessions IN ACCESS EXCLUSIVE MODE`.execute(trx)
    await sql`
      DO $$
      DECLARE
        has_mode boolean;
        has_request boolean;
        has_hash boolean;
        has_generation boolean;
        guard_def text;
      BEGIN
        SELECT EXISTS (
          SELECT 1
          FROM pg_attribute attribute
          JOIN pg_class relation ON relation.oid = attribute.attrelid
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = current_schema()
            AND relation.relname = 'plm_managed_identity_links'
            AND attribute.attname = 'continuity_mode'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        ) INTO has_mode;
        SELECT EXISTS (
          SELECT 1
          FROM pg_attribute attribute
          JOIN pg_class relation ON relation.oid = attribute.attrelid
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = current_schema()
            AND relation.relname = 'plm_managed_browser_intents'
            AND attribute.attname = 'request_mode'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        ) INTO has_request;
        SELECT EXISTS (
          SELECT 1
          FROM pg_attribute attribute
          JOIN pg_class relation ON relation.oid = attribute.attrelid
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = current_schema()
            AND relation.relname = 'plm_managed_browser_intents'
            AND attribute.attname = 'completion_code_hash'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        ) INTO has_hash;
        SELECT EXISTS (
          SELECT 1
          FROM pg_attribute attribute
          JOIN pg_class relation ON relation.oid = attribute.attrelid
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = current_schema()
            AND relation.relname = 'plm_managed_sessions'
            AND attribute.attname = 'credential_generation'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        ) INTO has_generation;
        IF NOT has_mode OR NOT has_request OR NOT has_hash OR NOT has_generation THEN
          RAISE EXCEPTION 'plm_managed_continuous_completion_absent';
        END IF;
        SELECT pg_get_functiondef('plm_managed_browser_intents_guard()'::regprocedure) INTO guard_def;
        IF guard_def IS NULL OR position('plm_managed_intent_status_terminal' in guard_def) = 0 THEN
          RAISE EXCEPTION 'plm_managed_continuous_guard_absent';
        END IF;
        IF EXISTS (SELECT 1 FROM plm_managed_identity_links WHERE continuity_mode IS DISTINCT FROM 'ordinary')
           OR EXISTS (
             SELECT 1 FROM plm_managed_browser_intents
             WHERE request_mode IS DISTINCT FROM 'ordinary'
                OR completion_code_hash IS NOT NULL
                OR status = 'refused'
           )
           OR EXISTS (SELECT 1 FROM plm_managed_sessions WHERE credential_generation IS NOT NULL) THEN
          RAISE EXCEPTION 'plm_managed_continuous_evidence_present';
        END IF;
      END $$
    `.execute(trx)
    await sql`
      CREATE OR REPLACE FUNCTION plm_managed_identity_links_guard() RETURNS trigger AS $$
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
    `.execute(trx)
    await sql`
      CREATE OR REPLACE FUNCTION plm_managed_browser_intents_guard() RETURNS trigger AS $$
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
    `.execute(trx)
    await sql`
      CREATE OR REPLACE FUNCTION plm_managed_sessions_guard() RETURNS trigger AS $$
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
    `.execute(trx)
    await sql`
      ALTER TABLE plm_managed_browser_intents DROP CONSTRAINT plm_managed_intents_refused_shape_check;
      ALTER TABLE plm_managed_browser_intents DROP CONSTRAINT plm_managed_intents_status_check;
      ALTER TABLE plm_managed_browser_intents
        ADD CHECK (status IN ('pending', 'consumed', 'revoked'));
      ALTER TABLE plm_managed_browser_intents DROP CONSTRAINT plm_managed_intents_completion_hash_check;
      ALTER TABLE plm_managed_browser_intents DROP CONSTRAINT plm_managed_intents_request_mode_check;
      ALTER TABLE plm_managed_identity_links DROP CONSTRAINT plm_managed_links_continuity_mode_check;
      ALTER TABLE plm_managed_sessions DROP CONSTRAINT plm_managed_sessions_credential_generation_check;
      ALTER TABLE plm_managed_browser_intents DROP COLUMN completion_code_hash;
      ALTER TABLE plm_managed_browser_intents DROP COLUMN request_mode;
      ALTER TABLE plm_managed_identity_links DROP COLUMN continuity_mode;
      ALTER TABLE plm_managed_sessions DROP COLUMN credential_generation
    `.execute(trx)
  })
}
