import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE plm_snapshot_share_intents (
      id uuid PRIMARY KEY,
      operation_id uuid NOT NULL,
      actor_id text NOT NULL REFERENCES users(id),
      link_id text NOT NULL REFERENCES plm_managed_identity_links(id),
      session_id text NOT NULL REFERENCES plm_managed_sessions(id),
      data_source_id text NOT NULL REFERENCES data_sources(id),
      generation integer NOT NULL CHECK (generation > 0),
      meta_tenant_id text NOT NULL,
      meta_org_id text NOT NULL,
      base_id text NOT NULL REFERENCES meta_bases(id),
      name text NOT NULL,
      source_fingerprint text NOT NULL,
      source_identity jsonb NOT NULL,
      target jsonb NOT NULL,
      registration_hash text NOT NULL,
      state text NOT NULL,
      nonce_hash text NOT NULL,
      verifier_ciphertext text NOT NULL,
      native_intent_id uuid,
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','prepared','published','cancel_pending','cancelled')),
      binding_id uuid REFERENCES meta_plm_bom_review_bindings(id),
      native_snapshot_hash text,
      confirmed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      cancelled_at timestamptz,
      UNIQUE(actor_id,operation_id),
      CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes'),
      CHECK ((status = 'published') = (binding_id IS NOT NULL)),
      CHECK (status <> 'published' OR (native_intent_id IS NOT NULL AND native_snapshot_hash IS NOT NULL AND confirmed_at IS NOT NULL)),
      CHECK (status <> 'prepared' OR native_intent_id IS NOT NULL)
    );
    CREATE INDEX plm_snapshot_share_pending_cancel ON plm_snapshot_share_intents(link_id,generation)
      WHERE status IN ('pending','prepared','cancel_pending');
    CREATE FUNCTION plm_snapshot_share_intent_guard() RETURNS trigger AS $$
    BEGIN
      IF ROW(NEW.id,NEW.operation_id,NEW.actor_id,NEW.link_id,NEW.session_id,NEW.data_source_id,
             NEW.generation,NEW.meta_tenant_id,NEW.meta_org_id,NEW.base_id,NEW.name,
             NEW.source_fingerprint,NEW.source_identity,NEW.target,NEW.registration_hash,
             NEW.state,NEW.nonce_hash,NEW.verifier_ciphertext,NEW.created_at,NEW.expires_at)
         IS DISTINCT FROM
         ROW(OLD.id,OLD.operation_id,OLD.actor_id,OLD.link_id,OLD.session_id,OLD.data_source_id,
             OLD.generation,OLD.meta_tenant_id,OLD.meta_org_id,OLD.base_id,OLD.name,
             OLD.source_fingerprint,OLD.source_identity,OLD.target,OLD.registration_hash,
             OLD.state,OLD.nonce_hash,OLD.verifier_ciphertext,OLD.created_at,OLD.expires_at)
      THEN RAISE EXCEPTION 'snapshot share identity is immutable'; END IF;
      IF (OLD.native_intent_id IS NOT NULL AND NEW.native_intent_id IS DISTINCT FROM OLD.native_intent_id)
         OR (OLD.status IN ('published','cancelled') AND NEW IS DISTINCT FROM OLD)
         OR (OLD.status = 'cancel_pending' AND NEW.status NOT IN ('cancel_pending','cancelled'))
         OR (OLD.status = 'prepared' AND NEW.status = 'pending')
      THEN RAISE EXCEPTION 'snapshot share transition refused'; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    CREATE TRIGGER plm_snapshot_share_intent_guard BEFORE UPDATE ON plm_snapshot_share_intents
      FOR EACH ROW EXECUTE FUNCTION plm_snapshot_share_intent_guard();
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM plm_snapshot_share_intents) THEN
        RAISE EXCEPTION 'Cannot discard snapshot sharing evidence';
      END IF;
    END $$;
    DROP TABLE plm_snapshot_share_intents;
    DROP FUNCTION plm_snapshot_share_intent_guard();
  `.execute(db)
}
