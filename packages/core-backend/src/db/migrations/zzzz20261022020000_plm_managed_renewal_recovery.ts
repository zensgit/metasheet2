import { sql, type Kysely } from 'kysely'

/**
 * Slice B only: one durable renewal operation per predecessor.
 * Does not replace the slice A guards or drop completion columns.
 * intent_id is nullable only for a successor whose credential_generation is 1..7
 * and whose committed renewal operation is inserted in the same transaction.
 * Ordinary rows and generation 0 keep a real intent. No fake PKCE intent is added.
 * Nullable shape checks are IS TRUE, because a bare CHECK accepts SQL UNKNOWN.
 * The successor foreign key and consistency triggers are deferred to COMMIT.
 * down locks link, binding, session, then operation before it reads evidence.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE plm_managed_sessions ALTER COLUMN intent_id DROP NOT NULL
  `.execute(db)
  await sql`
    ALTER TABLE plm_managed_sessions
      ADD CONSTRAINT plm_managed_sessions_successor_intent_check
      CHECK ((
        (credential_generation IS NULL AND intent_id IS NOT NULL)
        OR (credential_generation IS NOT NULL AND credential_generation = 0 AND intent_id IS NOT NULL)
        OR (credential_generation IS NOT NULL AND credential_generation BETWEEN 1 AND 7 AND intent_id IS NULL)
      ) IS TRUE)
  `.execute(db)
  await sql`
    CREATE TABLE plm_managed_renewal_operations (
      id text PRIMARY KEY,
      predecessor_session_id text NOT NULL UNIQUE REFERENCES plm_managed_sessions(id),
      predecessor_delegation_id text NOT NULL UNIQUE,
      idempotency_key text NOT NULL UNIQUE,
      predecessor_jti text NOT NULL,
      predecessor_exp bigint NOT NULL,
      link_id text NOT NULL REFERENCES plm_managed_identity_links(id),
      link_generation integer NOT NULL,
      binding_generation integer NOT NULL,
      source_fingerprint text NOT NULL,
      meta_user_id text NOT NULL,
      meta_tenant_id text NOT NULL,
      meta_org_id text NOT NULL,
      native_subject text NOT NULL,
      native_tenant_id text NOT NULL,
      native_org_id text NOT NULL,
      root_part_id text NOT NULL,
      client_origin text NOT NULL,
      client_id text NOT NULL,
      installation_issuer text NOT NULL,
      scope text NOT NULL,
      expected_successor_index integer NOT NULL,
      status text NOT NULL,
      successor_session_id text,
      successor_delegation_id text,
      successor_jti text,
      successor_exp bigint,
      successor_credential_generation integer,
      credential_ciphertext text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{36,64}$'),
      CHECK (char_length(predecessor_jti) BETWEEN 1 AND 128),
      CHECK (char_length(predecessor_delegation_id) BETWEEN 1 AND 128),
      CHECK (predecessor_exp > 0),
      CHECK (link_generation >= 1),
      CHECK (binding_generation >= 1),
      CHECK (char_length(source_fingerprint) = 64),
      CHECK (scope = 'bom_review_read'),
      CHECK (expected_successor_index BETWEEN 1 AND 7),
      CHECK (status IN ('pending', 'committed', 'refused')),
      CONSTRAINT plm_managed_renewal_successor_session_uid UNIQUE (successor_session_id),
      CONSTRAINT plm_managed_renewal_successor_delegation_uid UNIQUE (successor_delegation_id),
      CONSTRAINT plm_managed_renewal_successor_session_fk
        FOREIGN KEY (successor_session_id) REFERENCES plm_managed_sessions(id)
        DEFERRABLE INITIALLY DEFERRED,
      CONSTRAINT plm_managed_renewal_operations_shape_check CHECK ((
        (
          status IN ('pending', 'refused')
          AND successor_session_id IS NULL
          AND successor_delegation_id IS NULL
          AND successor_jti IS NULL
          AND successor_exp IS NULL
          AND successor_credential_generation IS NULL
          AND credential_ciphertext IS NULL
        )
        OR (
          status = 'committed'
          AND successor_session_id IS NOT NULL
          AND successor_delegation_id IS NOT NULL
          AND successor_jti IS NOT NULL
          AND successor_exp IS NOT NULL
          AND successor_exp > 0
          AND successor_credential_generation IS NOT NULL
          AND successor_credential_generation = expected_successor_index
          AND credential_ciphertext IS NOT NULL
          AND left(credential_ciphertext, 4) = 'enc:'
        )
      ) IS TRUE)
    )
  `.execute(db)
  await sql`
    CREATE FUNCTION plm_managed_renewal_operations_guard() RETURNS trigger AS $$
    BEGIN
      IF OLD.status <> 'pending' AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'plm_managed_renewal_status_terminal';
      END IF;
      IF OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'committed', 'refused') THEN
        RAISE EXCEPTION 'plm_managed_renewal_status_terminal';
      END IF;
      IF (OLD.successor_session_id IS NOT NULL AND NEW.successor_session_id IS DISTINCT FROM OLD.successor_session_id)
         OR (OLD.successor_delegation_id IS NOT NULL AND NEW.successor_delegation_id IS DISTINCT FROM OLD.successor_delegation_id)
         OR (OLD.successor_jti IS NOT NULL AND NEW.successor_jti IS DISTINCT FROM OLD.successor_jti)
         OR (OLD.successor_exp IS NOT NULL AND NEW.successor_exp IS DISTINCT FROM OLD.successor_exp)
         OR (OLD.successor_credential_generation IS NOT NULL AND NEW.successor_credential_generation IS DISTINCT FROM OLD.successor_credential_generation)
         OR (OLD.credential_ciphertext IS NOT NULL AND NEW.credential_ciphertext IS DISTINCT FROM OLD.credential_ciphertext) THEN
        RAISE EXCEPTION 'plm_managed_renewal_successor_immutable';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.predecessor_session_id IS DISTINCT FROM OLD.predecessor_session_id
         OR NEW.predecessor_delegation_id IS DISTINCT FROM OLD.predecessor_delegation_id
         OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
         OR NEW.predecessor_jti IS DISTINCT FROM OLD.predecessor_jti
         OR NEW.predecessor_exp IS DISTINCT FROM OLD.predecessor_exp
         OR NEW.link_id IS DISTINCT FROM OLD.link_id
         OR NEW.link_generation IS DISTINCT FROM OLD.link_generation
         OR NEW.binding_generation IS DISTINCT FROM OLD.binding_generation
         OR NEW.source_fingerprint IS DISTINCT FROM OLD.source_fingerprint
         OR NEW.meta_user_id IS DISTINCT FROM OLD.meta_user_id
         OR NEW.meta_tenant_id IS DISTINCT FROM OLD.meta_tenant_id
         OR NEW.meta_org_id IS DISTINCT FROM OLD.meta_org_id
         OR NEW.native_subject IS DISTINCT FROM OLD.native_subject
         OR NEW.native_tenant_id IS DISTINCT FROM OLD.native_tenant_id
         OR NEW.native_org_id IS DISTINCT FROM OLD.native_org_id
         OR NEW.root_part_id IS DISTINCT FROM OLD.root_part_id
         OR NEW.client_origin IS DISTINCT FROM OLD.client_origin
         OR NEW.client_id IS DISTINCT FROM OLD.client_id
         OR NEW.installation_issuer IS DISTINCT FROM OLD.installation_issuer
         OR NEW.scope IS DISTINCT FROM OLD.scope
         OR NEW.expected_successor_index IS DISTINCT FROM OLD.expected_successor_index
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'plm_managed_renewal_immutable';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `.execute(db)
  await sql`
    CREATE TRIGGER plm_managed_renewal_operations_guard
      BEFORE UPDATE ON plm_managed_renewal_operations
      FOR EACH ROW EXECUTE FUNCTION plm_managed_renewal_operations_guard()
  `.execute(db)
  await sql`
    CREATE FUNCTION plm_managed_renewal_commit_guard() RETURNS trigger AS $$
    DECLARE
      sess plm_managed_sessions%ROWTYPE;
      op plm_managed_renewal_operations%ROWTYPE;
      pred plm_managed_sessions%ROWTYPE;
      linked bigint;
    BEGIN
      IF TG_TABLE_NAME = 'plm_managed_sessions' THEN
        IF TG_OP = 'DELETE' THEN
          RETURN NULL;
        END IF;
        SELECT * INTO sess FROM plm_managed_sessions WHERE id = NEW.id;
        IF NOT FOUND THEN
          RETURN NULL;
        END IF;
        IF sess.credential_generation IS NULL OR sess.credential_generation = 0 THEN
          IF sess.intent_id IS NULL THEN
            RAISE EXCEPTION 'plm_managed_successor_intent_required';
          END IF;
          RETURN NULL;
        END IF;
        SELECT count(*) INTO linked
        FROM plm_managed_renewal_operations operation
        JOIN plm_managed_sessions predecessor ON predecessor.id = operation.predecessor_session_id
        WHERE operation.status = 'committed'
          AND operation.successor_session_id = sess.id
          AND operation.successor_session_id <> operation.predecessor_session_id
          AND operation.successor_delegation_id = sess.delegation_id
          AND operation.successor_credential_generation = sess.credential_generation
          AND operation.expected_successor_index = sess.credential_generation
          AND operation.link_id = sess.link_id
          AND operation.link_generation = sess.generation
          AND operation.credential_ciphertext = sess.credential_ciphertext
          AND operation.meta_user_id = sess.meta_user_id
          AND operation.meta_tenant_id = sess.meta_tenant_id
          AND operation.meta_org_id = sess.meta_org_id
          AND operation.native_subject = sess.native_subject
          AND operation.native_tenant_id = sess.native_tenant_id
          AND operation.native_org_id = sess.native_org_id
          AND operation.root_part_id = sess.root_part_id
          AND operation.client_origin = sess.client_origin
          AND operation.client_id = sess.client_id
          AND operation.installation_issuer = sess.installation_issuer
          AND operation.scope = sess.scope
          AND floor(extract(epoch FROM sess.expires_at))::bigint = operation.successor_exp
          AND predecessor.credential_generation = operation.expected_successor_index - 1
          AND predecessor.delegation_id = operation.predecessor_delegation_id
          AND predecessor.link_id = operation.link_id
          AND predecessor.generation = operation.link_generation;
        IF linked IS DISTINCT FROM 1 THEN
          RAISE EXCEPTION 'plm_managed_successor_unlinked';
        END IF;
        RETURN NULL;
      END IF;
      IF TG_OP = 'DELETE' THEN
        IF OLD.successor_session_id IS NOT NULL THEN
          SELECT * INTO sess FROM plm_managed_sessions WHERE id = OLD.successor_session_id;
          IF FOUND AND sess.credential_generation IS NOT NULL AND sess.credential_generation > 0 AND sess.intent_id IS NULL THEN
            SELECT count(*) INTO linked
            FROM plm_managed_renewal_operations operation
            WHERE operation.status = 'committed' AND operation.successor_session_id = sess.id;
            IF linked IS DISTINCT FROM 1 THEN
              RAISE EXCEPTION 'plm_managed_successor_unlinked';
            END IF;
          END IF;
        END IF;
        RETURN NULL;
      END IF;
      SELECT * INTO op FROM plm_managed_renewal_operations WHERE id = NEW.id;
      IF NOT FOUND OR op.status <> 'committed' THEN
        RETURN NULL;
      END IF;
      IF op.successor_session_id IS NULL
         OR op.successor_credential_generation IS NULL
         OR op.successor_credential_generation IS DISTINCT FROM op.expected_successor_index
         OR op.successor_session_id = op.predecessor_session_id THEN
        RAISE EXCEPTION 'plm_managed_renewal_successor_inconsistent';
      END IF;
      SELECT * INTO sess FROM plm_managed_sessions WHERE id = op.successor_session_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'plm_managed_renewal_successor_inconsistent';
      END IF;
      SELECT * INTO pred FROM plm_managed_sessions WHERE id = op.predecessor_session_id;
      IF NOT FOUND
         OR sess.intent_id IS NOT NULL
         OR sess.credential_generation IS DISTINCT FROM op.successor_credential_generation
         OR sess.delegation_id IS DISTINCT FROM op.successor_delegation_id
         OR sess.link_id IS DISTINCT FROM op.link_id
         OR sess.generation IS DISTINCT FROM op.link_generation
         OR sess.credential_ciphertext IS DISTINCT FROM op.credential_ciphertext
         OR sess.meta_user_id IS DISTINCT FROM op.meta_user_id
         OR sess.meta_tenant_id IS DISTINCT FROM op.meta_tenant_id
         OR sess.meta_org_id IS DISTINCT FROM op.meta_org_id
         OR sess.native_subject IS DISTINCT FROM op.native_subject
         OR sess.native_tenant_id IS DISTINCT FROM op.native_tenant_id
         OR sess.native_org_id IS DISTINCT FROM op.native_org_id
         OR sess.root_part_id IS DISTINCT FROM op.root_part_id
         OR sess.client_origin IS DISTINCT FROM op.client_origin
         OR sess.client_id IS DISTINCT FROM op.client_id
         OR sess.installation_issuer IS DISTINCT FROM op.installation_issuer
         OR sess.scope IS DISTINCT FROM op.scope
         OR floor(extract(epoch FROM sess.expires_at))::bigint IS DISTINCT FROM op.successor_exp
         OR pred.id IS NULL
         OR pred.credential_generation IS DISTINCT FROM op.expected_successor_index - 1
         OR pred.delegation_id IS DISTINCT FROM op.predecessor_delegation_id
         OR pred.link_id IS DISTINCT FROM op.link_id
         OR pred.generation IS DISTINCT FROM op.link_generation THEN
        RAISE EXCEPTION 'plm_managed_renewal_successor_inconsistent';
      END IF;
      RETURN NULL;
    END $$ LANGUAGE plpgsql
  `.execute(db)
  await sql`
    CREATE CONSTRAINT TRIGGER plm_managed_sessions_successor_commit
      AFTER INSERT OR UPDATE OR DELETE ON plm_managed_sessions
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION plm_managed_renewal_commit_guard()
  `.execute(db)
  await sql`
    CREATE CONSTRAINT TRIGGER plm_managed_renewal_operations_successor_commit
      AFTER INSERT OR UPDATE OR DELETE ON plm_managed_renewal_operations
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION plm_managed_renewal_commit_guard()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    // Link, binding, session, then operation. The evidence read waits until
    // all four are held, so a successor insert cannot land between the read
    // and the drop. No NOWAIT: a writer must be able to commit and be seen.
    await sql`LOCK TABLE plm_managed_identity_links IN ACCESS EXCLUSIVE MODE`.execute(trx)
    await sql`LOCK TABLE plm_managed_source_bindings IN ACCESS EXCLUSIVE MODE`.execute(trx)
    await sql`LOCK TABLE plm_managed_sessions IN ACCESS EXCLUSIVE MODE`.execute(trx)
    await sql`LOCK TABLE plm_managed_renewal_operations IN ACCESS EXCLUSIVE MODE`.execute(trx)
    await sql`
      DO $$
      DECLARE
        has_operation boolean;
        has_successor_check boolean;
      BEGIN
        SELECT EXISTS (
          SELECT 1
          FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = current_schema()
            AND relation.relname = 'plm_managed_renewal_operations'
            AND relation.relkind = 'r'
        ) INTO has_operation;
        SELECT EXISTS (
          SELECT 1
          FROM pg_constraint con
          JOIN pg_class relation ON relation.oid = con.conrelid
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = current_schema()
            AND relation.relname = 'plm_managed_sessions'
            AND con.conname = 'plm_managed_sessions_successor_intent_check'
        ) INTO has_successor_check;
        IF NOT has_operation OR NOT has_successor_check THEN
          RAISE EXCEPTION 'plm_managed_renewal_recovery_absent';
        END IF;
        IF EXISTS (SELECT 1 FROM plm_managed_renewal_operations)
           OR EXISTS (
             SELECT 1 FROM plm_managed_sessions
             WHERE intent_id IS NULL OR credential_generation > 0
           ) THEN
          RAISE EXCEPTION 'plm_managed_renewal_evidence_present';
        END IF;
      END $$
    `.execute(trx)
    await sql`DROP TRIGGER plm_managed_sessions_successor_commit ON plm_managed_sessions`.execute(trx)
    await sql`DROP TRIGGER plm_managed_renewal_operations_successor_commit ON plm_managed_renewal_operations`.execute(trx)
    await sql`
      DROP TRIGGER plm_managed_renewal_operations_guard ON plm_managed_renewal_operations
    `.execute(trx)
    await sql`DROP TABLE plm_managed_renewal_operations`.execute(trx)
    await sql`DROP FUNCTION plm_managed_renewal_operations_guard()`.execute(trx)
    await sql`DROP FUNCTION plm_managed_renewal_commit_guard()`.execute(trx)
    await sql`
      ALTER TABLE plm_managed_sessions DROP CONSTRAINT plm_managed_sessions_successor_intent_check
    `.execute(trx)
    await sql`
      ALTER TABLE plm_managed_sessions ALTER COLUMN intent_id SET NOT NULL
    `.execute(trx)
  })
}
