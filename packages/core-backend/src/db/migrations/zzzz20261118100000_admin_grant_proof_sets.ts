/**
 * admin_login_grant_enable proof sets. Extends the published challenge checks with one purpose and
 * kind, then adds immutable target children and one seal. Failed rows stay childless and keep the
 * original NULL assurance, proof, browser and expiry shape. There is no target-count cap, no
 * canonical-text cap, no authority digest and no extension install.
 *
 * Seal digest is pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(domain || canonical,'UTF8')),'hex').
 * sha256(bytea) is the PostgreSQL 15 built-in binary-string function, not pgcrypto.
 * Deferred checks re-read the stored parent, children and seal at COMMIT.
 * Bearer continuity is token_issued_at. Child and seal TRUNCATE always refuse, so a parent CASCADE
 * truncate is refused as well; that is a retention effect of the new foreign keys.
 *
 * down() proves the caller's read-committed transaction before it locks. It refuses retained
 * new-purpose history and drops only this migration's objects. It does not cascade and it does not
 * delete browser, credential or challenge history.
 */
import { sql, type Kysely } from 'kysely'
import { applyMigrationTimeouts, readMigrationTimeouts, restoreMigrationTimeouts } from '../migration-timeouts'

export const ADMIN_GRANT_PROOF_SETS_DOWN_BLOCKED_CODE = 'ADMIN_GRANT_PROOF_SETS_DOWN_BLOCKED'
export const ADMIN_GRANT_PROOF_SETS_SCHEMA_BLOCKED_CODE = 'ADMIN_GRANT_PROOF_SETS_SCHEMA_BLOCKED'

const IDENT = /^[a-z_][a-z0-9_]*$/
const PARENT = 'security_action_challenges'
const TARGETS = 'admin_grant_proof_targets'
const SEALS = 'admin_grant_proof_seals'
const PAIR = 'security_action_challenges_admin_grant_pair_chk'
const SHAPE = 'security_action_challenges_admin_grant_shape_chk'
const PURPOSE = 'security_action_challenges_purpose_chk'
const KIND = 'security_action_challenges_target_kind_chk'
const PARENT_GUARD = 'admin_grant_proof_parent_guard'
const TARGET_GUARD = 'admin_grant_proof_target_guard'
const SEAL_GUARD = 'admin_grant_proof_seal_guard'
const FINAL = 'admin_grant_proof_set_final'
const COMMIT = 'admin_grant_proof_set_commit'
const FUNCTIONS = [PARENT_GUARD, TARGET_GUARD, SEAL_GUARD, FINAL, COMMIT] as const
const NEW_CONSTRAINTS = [PAIR, SHAPE] as const

function withCode(code: string): Error {
  const error = new Error(`${code}: admin grant proof set migration refused. Nothing was changed.`)
  ;(error as Error & { code?: string }).code = code
  return error
}

function quoteIdent(ident: string): string {
  if (!IDENT.test(ident)) throw withCode(ADMIN_GRANT_PROOF_SETS_SCHEMA_BLOCKED_CODE)
  return `"${ident}"`
}

function isApplicationSchema(name: unknown): name is string {
  return typeof name === 'string' && IDENT.test(name) && !name.startsWith('pg_') && name !== 'information_schema'
}

async function currentSchema(db: Kysely<unknown>): Promise<string> {
  const found = await sql<{ schema_name: string | null }>`
    SELECT candidate.nspname AS schema_name
      FROM unnest(pg_catalog.current_schemas(false)) WITH ORDINALITY AS candidate(nspname, ord)
     ORDER BY candidate.ord
  `.execute(db)
  for (const row of found.rows) {
    const name = row?.schema_name
    if (name === 'information_schema' || (typeof name === 'string' && name.startsWith('pg_'))) continue
    if (!isApplicationSchema(name)) throw withCode(ADMIN_GRANT_PROOF_SETS_SCHEMA_BLOCKED_CODE)
    return name
  }
  throw withCode(ADMIN_GRANT_PROOF_SETS_SCHEMA_BLOCKED_CODE)
}

function finalFunction(schema: string): string {
  const parent = `${schema}.${PARENT}`
  const targets = `${schema}.${TARGETS}`
  const seals = `${schema}.${SEALS}`
  const browser = `${schema}.security_action_browser_bindings`
  const establishment = `${schema}.user_local_credential_establishments`
  return `
    CREATE FUNCTION ${schema}.${FINAL}(p_challenge uuid)
    RETURNS void
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog
    AS $fn$
    DECLARE
      parent_row record;
      seal_row record;
      doc jsonb;
      child_count bigint;
      browser_expires timestamptz;
      browser_revoked timestamptz;
      browser_user text;
      browser_org text;
      browser_session text;
      establishment_user text;
      establishment_version uuid;
    BEGIN
      IF p_challenge IS NULL THEN
        RAISE EXCEPTION 'admin grant proof set refused' USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM ${parent} WHERE id = p_challenge) THEN
        IF EXISTS (SELECT 1 FROM ${targets} WHERE challenge_id = p_challenge)
           OR EXISTS (SELECT 1 FROM ${seals} WHERE challenge_id = p_challenge) THEN
          RAISE EXCEPTION 'admin grant proof set refused' USING ERRCODE = '23514';
        END IF;
        RETURN;
      END IF;
      SELECT * INTO parent_row FROM ${parent} WHERE id = p_challenge;
      IF parent_row.purpose IS DISTINCT FROM 'admin_login_grant_enable' THEN
        IF EXISTS (SELECT 1 FROM ${targets} WHERE challenge_id = p_challenge)
           OR EXISTS (SELECT 1 FROM ${seals} WHERE challenge_id = p_challenge) THEN
          RAISE EXCEPTION 'admin grant proof set refused' USING ERRCODE = '23514';
        END IF;
        RETURN;
      END IF;
      IF parent_row.status IS NOT DISTINCT FROM 'failed' THEN
        IF parent_row.proof_hash IS NOT NULL
           OR parent_row.expires_at IS NOT NULL
           OR parent_row.assurance IS NOT NULL
           OR parent_row.client_binding_digest IS NOT NULL
           OR parent_row.consumed_at IS NOT NULL
           OR parent_row.superseded_at IS NOT NULL
           OR parent_row.failure_code IS DISTINCT FROM 'credential_rejected'
           OR EXISTS (SELECT 1 FROM ${targets} WHERE challenge_id = p_challenge)
           OR EXISTS (SELECT 1 FROM ${seals} WHERE challenge_id = p_challenge) THEN
          RAISE EXCEPTION 'admin grant proof set refused' USING ERRCODE = '23514';
        END IF;
        RETURN;
      END IF;
      IF (SELECT count(*) FROM ${seals} WHERE challenge_id = p_challenge) IS DISTINCT FROM 1 THEN
        RAISE EXCEPTION 'admin grant proof set refused' USING ERRCODE = '23514';
      END IF;
      SELECT * INTO seal_row FROM ${seals} WHERE challenge_id = p_challenge;
      SELECT count(*) INTO child_count FROM ${targets} WHERE challenge_id = p_challenge;
      IF child_count IS DISTINCT FROM seal_row.target_count::bigint
         OR child_count < 1
         OR (SELECT count(DISTINCT ordinal) FROM ${targets} WHERE challenge_id = p_challenge) IS DISTINCT FROM child_count
         OR (SELECT count(DISTINCT user_id) FROM ${targets} WHERE challenge_id = p_challenge) IS DISTINCT FROM child_count
         OR (SELECT min(ordinal) FROM ${targets} WHERE challenge_id = p_challenge) IS DISTINCT FROM 1
         OR (SELECT max(ordinal) FROM ${targets} WHERE challenge_id = p_challenge) IS DISTINCT FROM seal_row.target_count
         OR EXISTS (
           SELECT 1 FROM ${targets}
            WHERE challenge_id = p_challenge AND user_id IS NOT DISTINCT FROM parent_row.user_id
         ) THEN
        RAISE EXCEPTION 'admin grant proof set refused' USING ERRCODE = '23514';
      END IF;
      IF parent_row.expires_at IS NULL
         OR parent_row.created_at IS NULL
         OR parent_row.expires_at <= parent_row.created_at
         OR parent_row.expires_at > parent_row.created_at + interval '300 seconds'
         OR parent_row.expires_at > seal_row.session_expires_at
         OR seal_row.token_issued_at IS NULL
         OR seal_row.token_issued_at <= 0 THEN
        RAISE EXCEPTION 'admin grant proof set refused' USING ERRCODE = '23514';
      END IF;
      SELECT b.expires_at, b.revoked_at, b.user_id, b.org_id, b.session_id
        INTO browser_expires, browser_revoked, browser_user, browser_org, browser_session
        FROM ${browser} b
       WHERE b.id = seal_row.browser_binding_id;
      IF NOT FOUND
         OR browser_revoked IS NOT NULL
         OR browser_expires IS NULL
         OR parent_row.expires_at > browser_expires
         OR browser_user IS DISTINCT FROM parent_row.user_id
         OR browser_org IS DISTINCT FROM parent_row.org_id
         OR browser_session IS DISTINCT FROM parent_row.session_id THEN
        RAISE EXCEPTION 'admin grant proof set refused' USING ERRCODE = '23514';
      END IF;
      SELECT e.user_id, e.credential_version
        INTO establishment_user, establishment_version
        FROM ${establishment} e
       WHERE e.id = seal_row.credential_establishment_id;
      IF NOT FOUND
         OR establishment_user IS DISTINCT FROM parent_row.user_id
         OR establishment_version IS DISTINCT FROM seal_row.credential_version THEN
        RAISE EXCEPTION 'admin grant proof set refused' USING ERRCODE = '23514';
      END IF;
      IF pg_catalog.encode(
           pg_catalog.sha256(
             pg_catalog.convert_to(
               'metasheet:admin-login-grant-intent:v1|' || seal_row.canonical_intent,
               'UTF8'
             )
           ),
           'hex'
         ) IS DISTINCT FROM parent_row.target_witness THEN
        RAISE EXCEPTION 'admin grant proof set refused' USING ERRCODE = '23514';
      END IF;
      BEGIN
        doc := seal_row.canonical_intent::jsonb;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE EXCEPTION 'admin grant proof set refused' USING ERRCODE = '23514';
      END;
      IF pg_catalog.jsonb_typeof(doc) IS DISTINCT FROM 'object'
         OR (
           SELECT pg_catalog.array_agg(keys.key ORDER BY keys.key)
             FROM pg_catalog.jsonb_object_keys(doc) AS keys(key)
         ) IS DISTINCT FROM ARRAY[
           'actorId', 'applicationRevision', 'commandId', 'connectionId', 'orgId',
           'provider', 'purpose', 'targetCount', 'targets'
         ]::text[]
         OR pg_catalog.jsonb_typeof(doc -> 'purpose') IS DISTINCT FROM 'string'
         OR (doc ->> 'purpose') IS DISTINCT FROM parent_row.purpose
         OR pg_catalog.jsonb_typeof(doc -> 'commandId') IS DISTINCT FROM 'string'
         OR (doc ->> 'commandId') IS DISTINCT FROM seal_row.command_id
         OR pg_catalog.jsonb_typeof(doc -> 'actorId') IS DISTINCT FROM 'string'
         OR (doc ->> 'actorId') IS DISTINCT FROM parent_row.user_id
         OR pg_catalog.jsonb_typeof(doc -> 'orgId') IS DISTINCT FROM 'string'
         OR (doc ->> 'orgId') IS DISTINCT FROM parent_row.org_id
         OR pg_catalog.jsonb_typeof(doc -> 'provider') IS DISTINCT FROM 'string'
         OR (doc ->> 'provider') IS DISTINCT FROM 'dingtalk'
         OR pg_catalog.jsonb_typeof(doc -> 'connectionId') IS DISTINCT FROM 'string'
         OR (doc ->> 'connectionId') IS DISTINCT FROM parent_row.connection_id::text
         OR pg_catalog.jsonb_typeof(doc -> 'applicationRevision') IS DISTINCT FROM 'string'
         OR (doc ->> 'applicationRevision') IS DISTINCT FROM seal_row.application_revision
         OR pg_catalog.jsonb_typeof(doc -> 'targetCount') IS DISTINCT FROM 'number'
         OR (doc ->> 'targetCount') !~ '^(0|[1-9][0-9]*)$'
         OR (doc -> 'targetCount') IS DISTINCT FROM pg_catalog.to_jsonb(seal_row.target_count)
         OR pg_catalog.jsonb_typeof(doc -> 'targets') IS DISTINCT FROM 'array'
         OR pg_catalog.jsonb_array_length(doc -> 'targets') IS DISTINCT FROM child_count::integer
         OR (
           SELECT count(DISTINCT elem.value ->> 'userId')
             FROM pg_catalog.jsonb_array_elements(doc -> 'targets') AS elem(value)
         ) IS DISTINCT FROM child_count THEN
        RAISE EXCEPTION 'admin grant proof set refused' USING ERRCODE = '23514';
      END IF;
      IF EXISTS (
        SELECT 1
          FROM pg_catalog.jsonb_array_elements(doc -> 'targets') AS elem(value)
         WHERE pg_catalog.jsonb_typeof(elem.value) IS DISTINCT FROM 'object'
            OR (
              SELECT pg_catalog.array_agg(keys.key ORDER BY keys.key)
                FROM pg_catalog.jsonb_object_keys(elem.value) AS keys(key)
            ) IS DISTINCT FROM ARRAY[
              'accessGeneration', 'bindingRevision', 'evidenceId', 'evidenceWitness',
              'identityId', 'privilegeWitness', 'userId'
            ]::text[]
            OR pg_catalog.jsonb_typeof(elem.value -> 'userId') IS DISTINCT FROM 'string'
            OR pg_catalog.jsonb_typeof(elem.value -> 'identityId') IS DISTINCT FROM 'string'
            OR pg_catalog.jsonb_typeof(elem.value -> 'bindingRevision') IS DISTINCT FROM 'string'
            OR pg_catalog.jsonb_typeof(elem.value -> 'evidenceId') IS DISTINCT FROM 'string'
            OR pg_catalog.jsonb_typeof(elem.value -> 'evidenceWitness') IS DISTINCT FROM 'string'
            OR pg_catalog.jsonb_typeof(elem.value -> 'accessGeneration') IS DISTINCT FROM 'string'
            OR pg_catalog.jsonb_typeof(elem.value -> 'privilegeWitness') IS DISTINCT FROM 'string'
      ) THEN
        RAISE EXCEPTION 'admin grant proof set refused' USING ERRCODE = '23514';
      END IF;
      IF EXISTS (
        WITH children AS (
          SELECT user_id, identity_id, binding_revision, evidence_id, evidence_witness,
                 access_generation, privilege_witness
            FROM ${targets}
           WHERE challenge_id = p_challenge
        ),
        elems AS (
          SELECT value
            FROM pg_catalog.jsonb_array_elements(doc -> 'targets') AS elem(value)
        )
        SELECT 1
          FROM children AS child
          FULL JOIN elems AS elem ON child.user_id = (elem.value ->> 'userId')
         WHERE child.user_id IS NULL
            OR elem.value IS NULL
            OR child.identity_id::text IS DISTINCT FROM (elem.value ->> 'identityId')
            OR child.binding_revision::text IS DISTINCT FROM (elem.value ->> 'bindingRevision')
            OR child.evidence_id IS DISTINCT FROM (elem.value ->> 'evidenceId')
            OR child.evidence_witness IS DISTINCT FROM (elem.value ->> 'evidenceWitness')
            OR child.access_generation::text IS DISTINCT FROM (elem.value ->> 'accessGeneration')
            OR child.privilege_witness IS DISTINCT FROM (elem.value ->> 'privilegeWitness')
      ) THEN
        RAISE EXCEPTION 'admin grant proof set refused' USING ERRCODE = '23514';
      END IF;
    END;
    $fn$
  `
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const previous = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  const schema = quoteIdent(await currentSchema(db))
  const parent = `${schema}.${PARENT}`
  const targets = `${schema}.${TARGETS}`
  const seals = `${schema}.${SEALS}`
  await sql.raw(`
    ALTER TABLE ${parent} DROP CONSTRAINT ${PURPOSE}
  `).execute(db)
  await sql.raw(`
    ALTER TABLE ${parent} ADD CONSTRAINT ${PURPOSE} CHECK (
      purpose IS NOT NULL AND purpose IN (
        'external_identity_bind',
        'external_identity_unbind',
        'login_grant_enable',
        'login_grant_disable',
        'admin_login_grant_enable'
      )
    )
  `).execute(db)
  await sql.raw(`
    ALTER TABLE ${parent} DROP CONSTRAINT ${KIND}
  `).execute(db)
  await sql.raw(`
    ALTER TABLE ${parent} ADD CONSTRAINT ${KIND} CHECK (
      target_kind IS NOT NULL AND target_kind IN ('empty_slot', 'identity_revision', 'confirmed_identity_set')
    )
  `).execute(db)
  await sql.raw(`
    ALTER TABLE ${parent} ADD CONSTRAINT ${PAIR} CHECK (
      CASE
        WHEN purpose IS NOT DISTINCT FROM 'admin_login_grant_enable'
          THEN target_kind IS NOT DISTINCT FROM 'confirmed_identity_set'
        WHEN target_kind IS NOT DISTINCT FROM 'confirmed_identity_set' THEN FALSE
        ELSE TRUE
      END
    )
  `).execute(db)
  await sql.raw(`
    ALTER TABLE ${parent} ADD CONSTRAINT ${SHAPE} CHECK (
      CASE
        WHEN purpose IS DISTINCT FROM 'admin_login_grant_enable' THEN TRUE
        WHEN org_id IS NULL
          OR connection_id IS NULL
          OR method IS DISTINCT FROM 'local_password'
          OR method_connection_id IS NOT NULL
          OR target_identity_id IS NOT NULL
          OR expected_binding_revision IS NOT NULL
          OR policy_revision IS DISTINCT FROM 1 THEN FALSE
        WHEN status IS NOT DISTINCT FROM 'failed' THEN
          assurance IS NULL
          AND proof_hash IS NULL
          AND client_binding_digest IS NULL
          AND expires_at IS NULL
          AND failure_code IS NOT DISTINCT FROM 'credential_rejected'
        WHEN status IN ('issued', 'consumed', 'superseded') THEN
          assurance IS NOT DISTINCT FROM 'local_password'
          AND proof_hash IS NOT NULL
          AND client_binding_digest IS NOT NULL
          AND expires_at IS NOT NULL
          AND failure_code IS NULL
        ELSE FALSE
      END
    )
  `).execute(db)
  await sql.raw(`
    CREATE TABLE ${targets} (
      challenge_id uuid NOT NULL,
      ordinal integer NOT NULL,
      user_id text NOT NULL,
      identity_id uuid NOT NULL,
      binding_revision bigint NOT NULL,
      evidence_id text NOT NULL,
      evidence_witness text NOT NULL,
      access_generation bigint NOT NULL,
      privilege_witness text NOT NULL,
      CONSTRAINT ${TARGETS}_pkey PRIMARY KEY (challenge_id, ordinal),
      CONSTRAINT ${TARGETS}_user_uq UNIQUE (challenge_id, user_id),
      CONSTRAINT ${TARGETS}_ordinal_chk CHECK (ordinal IS NOT NULL AND ordinal >= 1),
      CONSTRAINT ${TARGETS}_binding_chk CHECK (binding_revision IS NOT NULL AND binding_revision >= 0),
      CONSTRAINT ${TARGETS}_generation_chk CHECK (access_generation IS NOT NULL AND access_generation >= 0),
      CONSTRAINT ${TARGETS}_privilege_chk CHECK (privilege_witness ~ '^[0-9a-f]{64}$'),
      CONSTRAINT ${TARGETS}_user_chk CHECK (
        user_id IS NOT NULL AND pg_catalog.length(user_id) > 0 AND user_id = pg_catalog.btrim(user_id)
      ),
      CONSTRAINT ${TARGETS}_evidence_chk CHECK (
        evidence_id IS NOT NULL AND pg_catalog.length(evidence_id) > 0 AND evidence_id = pg_catalog.btrim(evidence_id)
        AND evidence_witness IS NOT NULL AND pg_catalog.length(evidence_witness) > 0
        AND evidence_witness = pg_catalog.btrim(evidence_witness)
      ),
      CONSTRAINT ${TARGETS}_challenge_fk FOREIGN KEY (challenge_id)
        REFERENCES ${parent} (id) ON DELETE RESTRICT
    )
  `).execute(db)
  await sql.raw(`
    CREATE TABLE ${seals} (
      challenge_id uuid NOT NULL,
      canonical_intent text NOT NULL,
      command_id text NOT NULL,
      application_revision text NOT NULL,
      target_count integer NOT NULL,
      browser_binding_id uuid NOT NULL,
      credential_establishment_id uuid NOT NULL,
      credential_version uuid NOT NULL,
      watermark_us text NOT NULL,
      token_issued_at bigint NOT NULL,
      session_expires_at timestamptz NOT NULL,
      CONSTRAINT ${SEALS}_pkey PRIMARY KEY (challenge_id),
      CONSTRAINT ${SEALS}_count_chk CHECK (target_count IS NOT NULL AND target_count >= 1),
      CONSTRAINT ${SEALS}_intent_chk CHECK (canonical_intent IS NOT NULL AND pg_catalog.length(canonical_intent) > 0),
      CONSTRAINT ${SEALS}_command_chk CHECK (
        command_id IS NOT NULL AND pg_catalog.length(command_id) > 0 AND command_id = pg_catalog.btrim(command_id)
      ),
      CONSTRAINT ${SEALS}_revision_chk CHECK (application_revision ~ '^(0|[1-9][0-9]*)$'),
      CONSTRAINT ${SEALS}_watermark_chk CHECK (watermark_us ~ '^-?(0|[1-9][0-9]*)$'),
      CONSTRAINT ${SEALS}_iat_chk CHECK (token_issued_at IS NOT NULL AND token_issued_at > 0),
      CONSTRAINT ${SEALS}_challenge_fk FOREIGN KEY (challenge_id)
        REFERENCES ${parent} (id) ON DELETE RESTRICT,
      CONSTRAINT ${SEALS}_browser_fk FOREIGN KEY (browser_binding_id)
        REFERENCES ${schema}.security_action_browser_bindings (id) ON DELETE RESTRICT,
      CONSTRAINT ${SEALS}_credential_fk FOREIGN KEY (credential_establishment_id)
        REFERENCES ${schema}.user_local_credential_establishments (id) ON DELETE RESTRICT
    )
  `).execute(db)
  await sql.raw(finalFunction(schema)).execute(db)
  await sql.raw(`
    CREATE FUNCTION ${schema}.${COMMIT}()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog
    AS $fn$
    DECLARE
      challenge_id uuid;
    BEGIN
      IF TG_TABLE_NAME = '${PARENT}' THEN
        challenge_id := COALESCE(NEW.id, OLD.id);
      ELSE
        challenge_id := COALESCE(NEW.challenge_id, OLD.challenge_id);
      END IF;
      PERFORM ${schema}.${FINAL}(challenge_id);
      RETURN NULL;
    END;
    $fn$
  `).execute(db)
  await sql.raw(`
    CREATE FUNCTION ${schema}.${TARGET_GUARD}()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog
    AS $fn$
    DECLARE
      v_actor text;
      v_purpose text;
      v_status text;
      v_found boolean;
    BEGIN
      IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'admin grant proof set refused' USING ERRCODE = '55000';
      END IF;
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'admin grant proof set refused' USING ERRCODE = '55000';
      END IF;
      SELECT c.user_id, c.purpose, c.status
        INTO v_actor, v_purpose, v_status
        FROM ${parent} c
       WHERE c.id = NEW.challenge_id
       FOR UPDATE;
      v_found := FOUND;
      IF v_found IS NOT TRUE
         OR v_purpose IS DISTINCT FROM 'admin_login_grant_enable'
         OR v_status IS DISTINCT FROM 'issued'
         OR NEW.user_id IS NOT DISTINCT FROM v_actor
         OR EXISTS (SELECT 1 FROM ${seals} s WHERE s.challenge_id = NEW.challenge_id) THEN
        RAISE EXCEPTION 'admin grant proof set refused' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $fn$
  `).execute(db)
  await sql.raw(`
    CREATE FUNCTION ${schema}.${SEAL_GUARD}()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog
    AS $fn$
    DECLARE
      v_actor text;
      v_purpose text;
      v_status text;
      v_found boolean;
      child_count bigint;
    BEGIN
      IF TG_OP = 'TRUNCATE' OR TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'admin grant proof set refused' USING ERRCODE = '55000';
      END IF;
      SELECT c.user_id, c.purpose, c.status
        INTO v_actor, v_purpose, v_status
        FROM ${parent} c
       WHERE c.id = NEW.challenge_id
       FOR UPDATE;
      v_found := FOUND;
      SELECT count(*) INTO child_count FROM ${targets} WHERE challenge_id = NEW.challenge_id;
      IF v_found IS NOT TRUE
         OR v_purpose IS DISTINCT FROM 'admin_login_grant_enable'
         OR v_status IS DISTINCT FROM 'issued'
         OR child_count IS DISTINCT FROM NEW.target_count::bigint
         OR (SELECT count(DISTINCT ordinal) FROM ${targets} WHERE challenge_id = NEW.challenge_id) IS DISTINCT FROM child_count
         OR (SELECT min(ordinal) FROM ${targets} WHERE challenge_id = NEW.challenge_id) IS DISTINCT FROM 1
         OR (SELECT max(ordinal) FROM ${targets} WHERE challenge_id = NEW.challenge_id) IS DISTINCT FROM NEW.target_count
         OR EXISTS (
           SELECT 1 FROM ${targets}
            WHERE challenge_id = NEW.challenge_id AND user_id IS NOT DISTINCT FROM v_actor
         )
         OR EXISTS (SELECT 1 FROM ${seals} s WHERE s.challenge_id = NEW.challenge_id) THEN
        RAISE EXCEPTION 'admin grant proof set refused' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $fn$
  `).execute(db)
  await sql.raw(`
    CREATE FUNCTION ${schema}.${PARENT_GUARD}()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog
    AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.purpose IS NOT DISTINCT FROM 'admin_login_grant_enable' THEN
          RAISE EXCEPTION 'admin grant proof set refused' USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
      END IF;
      IF TG_OP = 'TRUNCATE' THEN
        IF EXISTS (SELECT 1 FROM ${parent} WHERE purpose = 'admin_login_grant_enable') THEN
          RAISE EXCEPTION 'admin grant proof set refused' USING ERRCODE = '55000';
        END IF;
        RETURN NULL;
      END IF;
      RAISE EXCEPTION 'admin grant proof set refused' USING ERRCODE = '55000';
    END;
    $fn$
  `).execute(db)
  await sql.raw(`
    CREATE TRIGGER ${TARGET_GUARD}
    BEFORE INSERT OR UPDATE OR DELETE ON ${targets}
    FOR EACH ROW EXECUTE FUNCTION ${schema}.${TARGET_GUARD}()
  `).execute(db)
  await sql.raw(`
    CREATE TRIGGER ${TARGETS}_truncate
    BEFORE TRUNCATE ON ${targets}
    FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.${TARGET_GUARD}()
  `).execute(db)
  await sql.raw(`
    CREATE TRIGGER ${SEAL_GUARD}
    BEFORE INSERT OR UPDATE OR DELETE ON ${seals}
    FOR EACH ROW EXECUTE FUNCTION ${schema}.${SEAL_GUARD}()
  `).execute(db)
  await sql.raw(`
    CREATE TRIGGER ${SEALS}_truncate
    BEFORE TRUNCATE ON ${seals}
    FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.${SEAL_GUARD}()
  `).execute(db)
  await sql.raw(`
    CREATE TRIGGER ${PARENT_GUARD}
    BEFORE DELETE ON ${parent}
    FOR EACH ROW EXECUTE FUNCTION ${schema}.${PARENT_GUARD}()
  `).execute(db)
  await sql.raw(`
    CREATE TRIGGER ${PARENT}_admin_grant_truncate
    BEFORE TRUNCATE ON ${parent}
    FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.${PARENT_GUARD}()
  `).execute(db)
  for (const table of [parent, targets, seals]) {
    await sql.raw(`
      CREATE CONSTRAINT TRIGGER ${COMMIT}
      AFTER INSERT OR UPDATE OR DELETE ON ${table}
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION ${schema}.${COMMIT}()
    `).execute(db)
  }
  await restoreMigrationTimeouts(db, previous)
}

async function assertCallerTransaction(db: Kysely<unknown>): Promise<void> {
  await sql`SELECT pg_catalog.set_config('admin_grant.proof_down_marker', 'open', true)`.execute(db)
  const marker = await sql<{ marker: string | null }>`
    SELECT pg_catalog.current_setting('admin_grant.proof_down_marker', true) AS marker
  `.execute(db)
  if (marker.rows[0]?.marker !== 'open') throw withCode(ADMIN_GRANT_PROOF_SETS_DOWN_BLOCKED_CODE)
  const isolation = await sql<{ isolation: string }>`
    SELECT pg_catalog.current_setting('transaction_isolation') AS isolation
  `.execute(db)
  if (String(isolation.rows[0]?.isolation ?? '').toLowerCase() !== 'read committed') {
    throw withCode(ADMIN_GRANT_PROOF_SETS_DOWN_BLOCKED_CODE)
  }
}

async function installedState(db: Kysely<unknown>, schemaName: string): Promise<'absent' | 'installed'> {
  const tables = await sql<{ relname: string; relkind: string; relpersistence: string }>`
    SELECT c.relname, c.relkind, c.relpersistence
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schemaName}
       AND c.relname IN (${TARGETS}, ${SEALS})
  `.execute(db)
  const constraints = await sql<{ conname: string }>`
    SELECT con.conname
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schemaName}
       AND c.relname = ${PARENT}
       AND con.conname IN (${PAIR}, ${SHAPE})
  `.execute(db)
  const functions = await sql<{ proname: string }>`
    SELECT p.proname
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = ${schemaName}
       AND p.proname IN (${FUNCTIONS[0]}, ${FUNCTIONS[1]}, ${FUNCTIONS[2]}, ${FUNCTIONS[3]}, ${FUNCTIONS[4]})
  `.execute(db)
  const tableNames = new Set(tables.rows.map((row) => row.relname))
  const constraintNames = new Set(constraints.rows.map((row) => row.conname))
  const functionNames = new Set(functions.rows.map((row) => row.proname))
  const tableCount = tableNames.size
  const constraintCount = constraintNames.size
  const functionCount = functionNames.size
  if (tableCount === 0 && constraintCount === 0 && functionCount === 0) return 'absent'
  if (tableCount !== 2 || constraintCount !== NEW_CONSTRAINTS.length || functionCount !== FUNCTIONS.length) {
    throw withCode(ADMIN_GRANT_PROOF_SETS_SCHEMA_BLOCKED_CODE)
  }
  if (tables.rows.some((row) => row.relkind !== 'r' || row.relpersistence !== 'p')) {
    throw withCode(ADMIN_GRANT_PROOF_SETS_SCHEMA_BLOCKED_CODE)
  }
  const parentRelation = await sql<{ relkind: string; relpersistence: string }>`
    SELECT c.relkind, c.relpersistence
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schemaName}
       AND c.relname = ${PARENT}
  `.execute(db)
  const parentRow = parentRelation.rows[0]
  if (parentRelation.rows.length !== 1 || !parentRow || parentRow.relkind !== 'r' || parentRow.relpersistence !== 'p') {
    throw withCode(ADMIN_GRANT_PROOF_SETS_SCHEMA_BLOCKED_CODE)
  }
  return 'installed'
}

async function rollbackInstalled(db: Kysely<unknown>, schema: string): Promise<void> {
  const parent = `${schema}.${PARENT}`
  const targets = `${schema}.${TARGETS}`
  const seals = `${schema}.${SEALS}`
  await sql.raw(`LOCK TABLE ${parent} IN ACCESS EXCLUSIVE MODE`).execute(db)
  await sql.raw(`LOCK TABLE ${targets} IN ACCESS EXCLUSIVE MODE`).execute(db)
  await sql.raw(`LOCK TABLE ${seals} IN ACCESS EXCLUSIVE MODE`).execute(db)
  const present = await sql<{ present: boolean }>`
    SELECT (
      EXISTS (SELECT 1 FROM ${sql.raw(targets)})
      OR EXISTS (SELECT 1 FROM ${sql.raw(seals)})
      OR EXISTS (SELECT 1 FROM ${sql.raw(parent)} WHERE purpose = 'admin_login_grant_enable')
    ) AS present
  `.execute(db)
  if (present.rows[0]?.present === true) throw withCode(ADMIN_GRANT_PROOF_SETS_DOWN_BLOCKED_CODE)
  for (const table of [targets, seals, parent]) {
    await sql.raw(`DROP TRIGGER ${COMMIT} ON ${table}`).execute(db)
  }
  await sql.raw(`DROP TRIGGER ${TARGETS}_truncate ON ${targets}`).execute(db)
  await sql.raw(`DROP TRIGGER ${TARGET_GUARD} ON ${targets}`).execute(db)
  await sql.raw(`DROP TRIGGER ${SEALS}_truncate ON ${seals}`).execute(db)
  await sql.raw(`DROP TRIGGER ${SEAL_GUARD} ON ${seals}`).execute(db)
  await sql.raw(`DROP TRIGGER ${PARENT}_admin_grant_truncate ON ${parent}`).execute(db)
  await sql.raw(`DROP TRIGGER ${PARENT_GUARD} ON ${parent}`).execute(db)
  await sql.raw(`DROP FUNCTION ${schema}.${COMMIT}()`).execute(db)
  await sql.raw(`DROP FUNCTION ${schema}.${FINAL}(uuid)`).execute(db)
  await sql.raw(`DROP FUNCTION ${schema}.${SEAL_GUARD}()`).execute(db)
  await sql.raw(`DROP FUNCTION ${schema}.${TARGET_GUARD}()`).execute(db)
  await sql.raw(`DROP FUNCTION ${schema}.${PARENT_GUARD}()`).execute(db)
  await sql.raw(`DROP TABLE ${seals}`).execute(db)
  await sql.raw(`DROP TABLE ${targets}`).execute(db)
  await sql.raw(`ALTER TABLE ${parent} DROP CONSTRAINT ${PAIR}`).execute(db)
  await sql.raw(`ALTER TABLE ${parent} DROP CONSTRAINT ${SHAPE}`).execute(db)
  await sql.raw(`ALTER TABLE ${parent} DROP CONSTRAINT ${PURPOSE}`).execute(db)
  await sql.raw(`
    ALTER TABLE ${parent} ADD CONSTRAINT ${PURPOSE} CHECK (
      purpose IN ('external_identity_bind', 'external_identity_unbind', 'login_grant_enable', 'login_grant_disable')
    )
  `).execute(db)
  await sql.raw(`ALTER TABLE ${parent} DROP CONSTRAINT ${KIND}`).execute(db)
  await sql.raw(`
    ALTER TABLE ${parent} ADD CONSTRAINT ${KIND} CHECK (
      target_kind IN ('empty_slot', 'identity_revision')
    )
  `).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await assertCallerTransaction(db)
  const previous = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  try {
    const schemaName = await currentSchema(db)
    const state = await installedState(db, schemaName)
    if (state === 'installed') await rollbackInstalled(db, quoteIdent(schemaName))
  } catch (error) {
    await restoreMigrationTimeouts(db, previous)
    throw error
  }
  await restoreMigrationTimeouts(db, previous)
}
