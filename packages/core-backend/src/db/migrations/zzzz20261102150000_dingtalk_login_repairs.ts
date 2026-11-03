import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE dingtalk_login_repairs (
    id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), proof_nonce uuid NOT NULL UNIQUE,
    state text NOT NULL CHECK(state IN ('applied','rolled_back','released')), before_identity text NOT NULL,
    expected_identity jsonb NOT NULL, after_digest text NOT NULL, actor_id text NOT NULL,
    source_account_ids uuid[] NOT NULL, source_integration_ids uuid[] NOT NULL,
    canonical_account_id uuid NOT NULL, CHECK (canonical_account_id = ANY(source_account_ids)),
    login_client_id text NOT NULL, after_segments jsonb,
    released_account_ids uuid[],
    CHECK (state <> 'released' OR (released_account_ids IS NOT NULL AND released_account_ids = ARRAY[canonical_account_id])),
    CHECK (state = 'released' OR released_account_ids IS NULL),
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
      -- Plain read: directory_accounts.provider is never updated, and the RI check already holds KEY SHARE on the row.
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
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DO $$ BEGIN IF EXISTS(SELECT 1 FROM dingtalk_login_repairs) THEN
    RAISE EXCEPTION 'login repair history must be retained'; END IF; END $$`.execute(
    db,
  )
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
