import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE dingtalk_login_repairs (
    id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), proof_nonce uuid NOT NULL UNIQUE,
    state text NOT NULL CHECK(state IN ('applied','rolled_back','released','superseded')), before_identity text NOT NULL,
    expected_identity jsonb NOT NULL, after_digest text NOT NULL, actor_id text NOT NULL,
    source_account_ids uuid[] NOT NULL, source_integration_ids uuid[] NOT NULL,
    canonical_account_id uuid NOT NULL, CHECK (canonical_account_id = ANY(source_account_ids)),
    login_client_id text NOT NULL, after_segments jsonb,
    released_account_ids uuid[],
    CHECK (state <> 'released' OR (released_account_ids IS NOT NULL AND released_account_ids = ARRAY[canonical_account_id])),
    CHECK (state = 'released' OR released_account_ids IS NULL),
    -- Controlled re-anchoring: a successor names the row it supersedes and a second administrator, and no
    -- administrator is the target. A superseded row records who ended it and when (as rollback and release do).
    supersedes_id uuid UNIQUE REFERENCES dingtalk_login_repairs(id), approver_id text,
    CHECK ((supersedes_id IS NULL) = (approver_id IS NULL)),
    CHECK (supersedes_id IS NULL OR (approver_id <> actor_id AND approver_id <> user_id AND actor_id <> user_id)),
    CHECK (state <> 'superseded' OR (rollback_actor_id IS NOT NULL AND rolled_back_at IS NOT NULL)),
    created_at timestamptz NOT NULL DEFAULT now(), rollback_actor_id text, rolled_back_at timestamptz
  )`.execute(db)
  await sql`CREATE UNIQUE INDEX dingtalk_login_repairs_active ON dingtalk_login_repairs(user_id) WHERE state='applied'`.execute(
    db,
  )
  await sql`CREATE FUNCTION guard_dingtalk_repaired_identity() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE target text; pinned jsonb;
  BEGIN
    IF TG_OP='INSERT' THEN target := NEW.local_user_id; ELSE target := OLD.local_user_id; END IF;
    -- Same tuple fence as controlled handover: a stale RR snapshot must fail, not miss the journal.
    IF TG_OP='UPDATE' THEN
      PERFORM id FROM users WHERE id IN (OLD.local_user_id,NEW.local_user_id) ORDER BY id FOR SHARE;
      IF (OLD.local_user_id IS DISTINCT FROM NEW.local_user_id OR OLD.provider IS DISTINCT FROM NEW.provider)
        AND EXISTS(SELECT 1 FROM dingtalk_login_repairs WHERE user_id IN (OLD.local_user_id,NEW.local_user_id) AND state='applied') THEN
        RAISE EXCEPTION 'repaired login identity ownership is pinned' USING ERRCODE='55000';
      END IF;
    ELSE PERFORM id FROM users WHERE id=target FOR SHARE; END IF;
    SELECT expected_identity INTO pinned FROM dingtalk_login_repairs WHERE user_id=target AND state='applied';
    IF pinned IS NOT NULL THEN
      IF (TG_OP='UPDATE' AND (NEW.provider IS DISTINCT FROM OLD.provider OR NEW.local_user_id IS DISTINCT FROM OLD.local_user_id))
        OR NEW.external_key IS DISTINCT FROM pinned->>'external_key'
        OR NEW.provider_open_id IS DISTINCT FROM pinned->>'provider_open_id'
        OR NEW.corp_id IS DISTINCT FROM pinned->>'corp_id'
        OR NEW.provider_union_id IS DISTINCT FROM pinned->>'provider_union_id' THEN
        RAISE EXCEPTION 'repaired login identity is pinned' USING ERRCODE='55000';
      END IF;
    END IF;
    RETURN NEW;
  END $$`.execute(db)
  await sql`CREATE TRIGGER dingtalk_repaired_identity BEFORE UPDATE ON user_external_identities
    FOR EACH ROW WHEN (OLD.provider='dingtalk' OR NEW.provider='dingtalk') EXECUTE FUNCTION guard_dingtalk_repaired_identity()`.execute(
    db,
  )
  await sql`CREATE TRIGGER dingtalk_repaired_identity_insert BEFORE INSERT ON user_external_identities FOR EACH ROW WHEN (NEW.provider='dingtalk') EXECUTE FUNCTION guard_dingtalk_repaired_identity()`.execute(
    db,
  )
  await sql`CREATE FUNCTION guard_repaired_directory_link() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE allowed uuid[]; account_provider text;
  BEGIN
    IF NEW.link_status='linked' AND NEW.local_user_id IS NOT NULL THEN
      -- The real account row decides, never a request field (the link row carries no provider). A missing row
      -- (NULL) is constrained: fail closed; the FK on directory_account_id refuses the insert afterwards anyway.
      -- Plain read, no row lock: it rests on writer discipline, not on a lock. No product writer updates
      -- directory_accounts.provider (the sync upsert's DO UPDATE SET omits it; local-directory edits touch
      -- name/email/mobile/title/is_active; handover moves integration_id; the OAuth backfill writes open_id), and the
      -- bind path refuses an account whose provider differs from its integration's. The database does not enforce
      -- this: a raw-SQL provider change on a linked row is outside the product threat model and is not caught here.
      SELECT provider INTO account_provider FROM directory_accounts WHERE id=NEW.directory_account_id;
      IF account_provider IS NULL OR account_provider='dingtalk' THEN
        PERFORM id FROM users WHERE id=NEW.local_user_id FOR SHARE;
        SELECT CASE WHEN state='released' THEN released_account_ids ELSE source_account_ids END INTO allowed
        FROM dingtalk_login_repairs WHERE user_id=NEW.local_user_id AND state IN ('applied','released')
        ORDER BY CASE WHEN state='applied' THEN 0 ELSE 1 END,created_at DESC,id DESC LIMIT 1;
        IF allowed IS NOT NULL AND NOT (NEW.directory_account_id=ANY(allowed)) THEN
          RAISE EXCEPTION 'repair blocks a second directory source' USING ERRCODE='55000';
        END IF;
      END IF;
    END IF;
    RETURN NEW;
  END $$`.execute(db)
  await sql`CREATE TRIGGER repaired_directory_link BEFORE INSERT OR UPDATE ON directory_account_links FOR EACH ROW EXECUTE FUNCTION guard_repaired_directory_link()`.execute(
    db,
  )
  await sql`CREATE FUNCTION guard_dingtalk_login_repair_chain() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP = 'INSERT' THEN
      -- A successor continues a row superseded in its own transaction; it never overrides a released or rolled-back row.
      IF NOT EXISTS (SELECT 1 FROM dingtalk_login_repairs p WHERE p.id = NEW.supersedes_id AND p.state = 'superseded') THEN
        RAISE EXCEPTION 'a login repair successor must continue a superseded repair' USING ERRCODE = '55000';
      END IF;
      RETURN NULL;
    END IF;
    -- Only an applied row is superseded. At commit exactly one applied successor continues it: same user, same pinned
    -- identity, same undo target, and sources that add at most the successor's own canonical row.
    IF OLD.state <> 'applied' OR NOT EXISTS (
      SELECT 1 FROM dingtalk_login_repairs s
      WHERE s.supersedes_id = NEW.id AND s.state = 'applied' AND s.user_id = NEW.user_id
        AND s.expected_identity = NEW.expected_identity
        AND s.before_identity = NEW.before_identity
        AND s.source_account_ids <@ (NEW.source_account_ids || s.canonical_account_id)
    ) THEN
      RAISE EXCEPTION 'a superseded login repair needs its same-person successor' USING ERRCODE = '55000';
    END IF;
    RETURN NULL;
  END $$`.execute(db)
  await sql`CREATE CONSTRAINT TRIGGER dingtalk_login_repair_superseded AFTER UPDATE ON dingtalk_login_repairs
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    WHEN (NEW.state = 'superseded' AND OLD.state IS DISTINCT FROM 'superseded')
    EXECUTE FUNCTION guard_dingtalk_login_repair_chain()`.execute(db)
  await sql`CREATE CONSTRAINT TRIGGER dingtalk_login_repair_successor AFTER INSERT ON dingtalk_login_repairs
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    WHEN (NEW.supersedes_id IS NOT NULL)
    EXECUTE FUNCTION guard_dingtalk_login_repair_chain()`.execute(db)
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DO $$ BEGIN IF EXISTS(SELECT 1 FROM dingtalk_login_repairs) THEN
    RAISE EXCEPTION 'login repair history must be retained'; END IF; END $$`.execute(
    db,
  )
  await sql`DROP TRIGGER dingtalk_login_repair_successor ON dingtalk_login_repairs`.execute(db)
  await sql`DROP TRIGGER dingtalk_login_repair_superseded ON dingtalk_login_repairs`.execute(db)
  await sql`DROP FUNCTION guard_dingtalk_login_repair_chain()`.execute(db)
  await sql`DROP TRIGGER repaired_directory_link ON directory_account_links`.execute(
    db,
  )
  await sql`DROP FUNCTION guard_repaired_directory_link()`.execute(db)
  await sql`DROP TRIGGER dingtalk_repaired_identity_insert ON user_external_identities`.execute(
    db,
  )
  await sql`DROP TRIGGER dingtalk_repaired_identity ON user_external_identities`.execute(
    db,
  )
  await sql`DROP FUNCTION guard_dingtalk_repaired_identity()`.execute(db)
  await sql`DROP TABLE dingtalk_login_repairs`.execute(db)
}
